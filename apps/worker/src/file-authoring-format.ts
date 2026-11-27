import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digest } from '@bondbuddy/api/data';
import { resolvePythonExecutable } from './python-executable.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
export const FORMAT_JSON_MAX = 32 * 1024 * 1024;
export const WORD_FILE_MAX = 100 * 1024 * 1024;
export type FormatFileRef = { key: string; sha256: string; byte_size: number };
export type FormatDiagnostic = {
  version: 'word-format-diagnostic-v1';
  status: 'pending' | 'passed' | 'warning' | 'failed' | 'not_run' | 'unsupported';
  input_hash: string;
  revision_author: string;
  revision_date?: string;
  files: { baseline: FormatFileRef; tracked: FormatFileRef; operations: FormatFileRef; plan?: FormatFileRef };
  report?: FormatFileRef;
  /** Persisted before upload; retained until report registration or confirmed cleanup. */
  pending_report?: FormatFileRef;
  error_code?: string;
  attempts?: number;
};

export async function readFormatFile(root: string, name: string, max = WORD_FILE_MAX) {
  const path = join(root, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max || await realpath(path) !== resolve(path))
    throw Error('WORD_OUTPUT_UNSAFE');
  return readFile(path);
}

/** Always import the installed host package, never Python from a model workspace. */
export async function runFormatPython(args: string[], signal?: AbortSignal) {
  return promisify(execFile)(resolvePythonExecutable(),
    ['-B', '-s', '-m', 'bondbuddy_file_authoring.fixed_edit', ...args],
    { cwd: repo, env: { ...process.env, PYTHONPATH: join(repo, 'python'), PYTHONIOENCODING: 'utf-8' },
      timeout: 300000, maxBuffer: FORMAT_JSON_MAX, signal });
}

export class AuthoringSourceUnreadable extends Error {
  constructor() { super('MATERIAL_UNREADABLE'); this.name = 'AuthoringSourceUnreadable'; }
}

/** Only the trusted prepare command can establish an unreadable editing source. */
export async function prepareFormatSource(input: string, manifest: string, signal?: AbortSignal) {
  try {
    return await runFormatPython(['prepare', '--input', input, '--manifest', manifest], signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = error as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown };
    if (failure?.code === 1 && failure.signal == null && failure.killed !== true && typeof failure.stderr === 'string') {
      let report: unknown;
      try { report = JSON.parse(failure.stderr.trim()); } catch { /* Non-protocol failures keep the infrastructure retry path. */ }
      if (report && typeof report === 'object' && !Array.isArray(report) &&
          Object.keys(report).length === 1 && (report as { error?: unknown }).error === 'WORD_EDIT_SOURCE_UNREADABLE')
        throw new AuthoringSourceUnreadable();
    }
    throw error;
  }
}

/** Reconstruct deliverables from the pinned source and data-only operations after the CLI exits. */
export async function finalizeFormat(input: {
  lockedInput: Buffer; baselineBytes: Buffer; operations: Buffer; signal?: AbortSignal;
}): Promise<Map<string, Buffer>> {
  const data = JSON.parse(input.lockedInput.toString('utf8'));
  if (digest(input.baselineBytes) !== data.baseline_sha256) throw Error('INPUT_REVISION_CONFLICT');
  const root = await mkdtemp(join(tmpdir(), 'bb-format-finalize-'));
  try {
    await mkdir(join(root, 'materials'), { mode: 0o700 });
    await mkdir(join(root, 'output'), { mode: 0o700 });
    // The model cannot choose host paths or the output directory.
    const trusted = { ...data, baseline_path: 'materials/baseline.docx',
      materials: [{ path: 'materials/baseline.docx', sha256: data.baseline_sha256 }],
      output: { baseline: 'output/baseline.docx', tracked: 'output/tracked.docx', clean: 'output/clean.docx' } };
    await writeFile(join(root, 'input.json'), JSON.stringify(trusted));
    await writeFile(join(root, 'materials/baseline.docx'), input.baselineBytes);
    await writeFile(join(root, 'operations.json'), input.operations);
    await runFormatPython(['finalize', '--input', join(root, 'input.json'), '--operations', join(root, 'operations.json'),
      '--output-dir', join(root, 'output'), '--skip-report'], input.signal);
    const files = new Map<string, Buffer>();
    for (const name of ['tracked.docx', 'clean.docx', 'baseline.docx', 'operations.json', 'format-plan.json'])
      files.set(name, await readFormatFile(join(root, 'output'), name, name.endsWith('.json') ? FORMAT_JSON_MAX : WORD_FILE_MAX));
    return files;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
