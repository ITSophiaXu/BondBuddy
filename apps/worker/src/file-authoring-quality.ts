import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digest } from '@bondbuddy/api/data';
import { FORMAT_JSON_MAX } from './file-authoring-format.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
export type WordQualityReport = {
  version: 'word-quality-v1'; status: 'passed' | 'failed';
  issues: unknown[]; metrics: Record<string, unknown>; limitations: unknown[];
};
export type WordQualityInput = {
  data: Record<string, unknown>; tracked: Buffer; clean: Buffer;
  baseline?: Buffer; originalPdf?: Buffer; operations?: Buffer; signal?: AbortSignal;
};

export function parseWordQualityReport(stdout:string,rejected:boolean):WordQualityReport{
  let report:WordQualityReport;
  try{report=JSON.parse(stdout);}catch{throw Error('WORD_QUALITY_REPORT_INVALID');}
  if(!report || typeof report!=='object' || report.version!=='word-quality-v1' || !['passed','failed'].includes(report.status)
    || rejected!==(report.status==='failed') || !Array.isArray(report.issues)
    || (report.status==='passed' && report.issues.length!==0)
    || !report.metrics || typeof report.metrics!=='object' || Array.isArray(report.metrics) || !Array.isArray(report.limitations))
    throw Error('WORD_QUALITY_REPORT_INVALID');
  return report;
}

/** Execute only the installed checker on host-selected files after the model exits. */
export async function verifyWordQuality(input: WordQualityInput): Promise<WordQualityReport> {
  const root = await mkdtemp(join(tmpdir(), 'bb-word-quality-'));
  try {
    await writeFile(join(root, 'tracked.docx'), input.tracked);
    await writeFile(join(root, 'clean.docx'), input.clean);
    if (input.baseline) await writeFile(join(root, 'baseline.docx'), input.baseline);
    if (input.originalPdf) await writeFile(join(root, 'original-source.pdf'), input.originalPdf);
    if (input.operations) await writeFile(join(root, 'operations.json'), input.operations);
    // No model-supplied path survives onto the host filesystem.
    const data = { ...input.data,
      baseline_path: input.baseline ? 'baseline.docx' : null,
      baseline_sha256: input.baseline ? digest(input.baseline) : null,
      original_pdf_path: input.originalPdf ? 'original-source.pdf' : null,
      original_pdf_sha256: input.originalPdf ? digest(input.originalPdf) : null,
      materials: input.baseline ? [{ path: 'baseline.docx', sha256: digest(input.baseline) }] : [],
      operations_path: input.operations ? 'operations.json' : null,
      output: { tracked: 'tracked.docx', clean: 'clean.docx', ...(input.baseline ? { baseline: 'baseline.docx' } : {}) } };
    await writeFile(join(root, 'input.json'), JSON.stringify(data));
    let stdout: string;
    let rejected = false;
    try {
      ({ stdout } = await promisify(execFile)(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
        ['-B', '-s', '-m', 'bondbuddy_file_authoring.quality', '--input', join(root, 'input.json')],
        { cwd: repo, env: { ...process.env, PYTHONPATH: join(repo, 'python'), PYTHONIOENCODING: 'utf-8' },
          timeout: 300000, maxBuffer: FORMAT_JSON_MAX, signal: input.signal }));
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const e = error as { code?: number | string; stdout?: string; stderr?: string };
      if (e.code !== 1 || !/"error"\s*:\s*"WORD_QUALITY_REJECTED"/.test(e.stderr ?? '')) throw error;
      stdout = e.stdout ?? ''; rejected = true;
    }
    return parseWordQualityReport(stdout,rejected);
  } finally { await rm(root, { recursive: true, force: true }); }
}
