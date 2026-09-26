/**
 * Guarded worker bridge to the deterministic #33 structural DOCX renderer.
 * This module is intentionally not installed in the run pipeline: rendered bytes are
 * returned with metadata for a later quality-gated stage and are never promoted here.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StageContext } from './run-pipeline.js';
import type { TargetFactsSnapshot } from './no-history-model-stage.js';

const REQUEST_SCHEMA = 'no-history-manuscript-draft-render-request-v1';
const RESPONSE_SCHEMA = 'no-history-manuscript-draft-render-response-v1';
const DRAFT_SCHEMA = 'no-history-manuscript-draft-v1';
const WRITER_VERSION = 'bondbuddy-no-history-draft-writer-1.1.0';
const OUTPUT_NAME = 'no-history-manuscript-draft.docx';
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 60_000;
const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const trustedTargetFactIdsBrand: unique symbol = Symbol('trustedTargetFactIds');

/**
 * This set can only be produced from a target-facts adapter snapshot matching the claimed run.
 * It means IDs were supplied outside model JSON; it does not prove those facts are accurate.
 */
export type TrustedTargetFactIds = ReadonlySet<string> & { readonly [trustedTargetFactIdsBrand]: true };

interface TrustedTargetFactIdsProof {
  readonly binding: Readonly<NoHistoryWordRunBinding>;
  readonly ids: ReadonlySet<string>;
}

// The module-private proof prevents structural casts/plain Sets from manufacturing authority.
// The backing ID set is kept out of the public wrapper and can never be mutated by its caller.
const trustedTargetFactIdsProofs = new WeakMap<object, TrustedTargetFactIdsProof>();

export interface NoHistoryWordRunBinding {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly inputRevision: number;
  readonly inputHash: string;
}

export interface VerifiedNoHistoryWordMetadata {
  readonly schemaVersion: typeof RESPONSE_SCHEMA;
  readonly writerVersion: typeof WRITER_VERSION;
  readonly contentType: typeof DOCX_MIME;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sectionCount: number;
  readonly factClaimCount: number;
  readonly pendingQuestionCount: number;
  /** Correlation pins copied from the active worker run; they are not evidence of factual truth. */
  readonly runBinding: NoHistoryWordRunBinding;
  readonly factIdsAllowlisted: true;
  readonly factsVerified: false;
  readonly deliveryChecked: false;
}

export interface NoHistoryWordBytes {
  readonly bytes: Buffer;
  readonly metadata: VerifiedNoHistoryWordMetadata;
}

interface RenderResponse {
  schema_version: string;
  status: string;
  writer_version: string;
  output_sha256: string;
  output_size_bytes: number;
  section_count: number;
  fact_claim_count: number;
  pending_question_count: number;
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validHash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }

/** Validate the trusted adapter boundary and bind its fact IDs to this exact run input. */
export function trustedTargetFactIdsFromSnapshot(snapshot: TargetFactsSnapshot, binding: NoHistoryWordRunBinding): TrustedTargetFactIds {
  if (!snapshot || snapshot.ownerUserId !== binding.ownerUserId || snapshot.projectId !== binding.projectId ||
      snapshot.runId !== binding.runId || snapshot.inputRevision !== binding.inputRevision ||
      snapshot.inputHash.trim() !== binding.inputHash || !Array.isArray(snapshot.facts) || snapshot.facts.length === 0) {
    throw new Error('NO_HISTORY_WORD_TARGET_FACTS_SCOPE_MISMATCH');
  }
  const ids = new Set<string>();
  for (const fact of snapshot.facts) {
    if (!fact || fact.status !== 'verified' || typeof fact.factId !== 'string' || !fact.factId.trim() || fact.factId.length > 128 ||
        !Array.isArray(fact.evidenceRefs) || fact.evidenceRefs.length === 0 || fact.evidenceRefs.some((ref: unknown) => typeof ref !== 'string' || !ref.trim()) ||
        ids.has(fact.factId)) {
      throw new Error('NO_HISTORY_WORD_TARGET_FACTS_INVALID');
    }
    ids.add(fact.factId);
  }
  const frozenBinding = Object.freeze({ ...binding });
  let readonlyIds: TrustedTargetFactIds;
  readonlyIds = Object.freeze({
    [trustedTargetFactIdsBrand]: true as const,
    get size() { return ids.size; },
    has: (value: string) => ids.has(value),
    entries: () => ids.entries(),
    keys: () => ids.keys(),
    values: () => ids.values(),
    forEach: (callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown) =>
      ids.forEach(value => callback.call(thisArg, value, value, readonlyIds)),
    [Symbol.iterator]: () => ids[Symbol.iterator](),
  });
  trustedTargetFactIdsProofs.set(readonlyIds, { binding: frozenBinding, ids });
  return readonlyIds;
}

function validateDraftVersion(draft: unknown): asserts draft is Record<string, unknown> {
  if (!isObject(draft) || draft.schema_version !== DRAFT_SCHEMA) throw new Error('NO_HISTORY_WORD_DRAFT_VERSION_UNSUPPORTED');
}

function sameRunBinding(left: NoHistoryWordRunBinding, right: NoHistoryWordRunBinding): boolean {
  return left.ownerUserId === right.ownerUserId && left.projectId === right.projectId && left.runId === right.runId &&
    left.inputRevision === right.inputRevision && left.inputHash === right.inputHash;
}

function exactResponse(value: unknown): value is RenderResponse {
  if (!isObject(value)) return false;
  const keys = ['schema_version', 'status', 'writer_version', 'output_sha256', 'output_size_bytes', 'section_count', 'fact_claim_count', 'pending_question_count'];
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) &&
    value.schema_version === RESPONSE_SCHEMA && value.status === 'rendered' && value.writer_version === WRITER_VERSION &&
    typeof value.output_sha256 === 'string' && validHash(value.output_sha256) &&
    Number.isSafeInteger(value.output_size_bytes) && Number(value.output_size_bytes) > 0 && Number(value.output_size_bytes) <= MAX_OUTPUT_BYTES &&
    Number.isSafeInteger(value.section_count) && Number(value.section_count) > 0 && Number(value.section_count) <= 100 &&
    Number.isSafeInteger(value.fact_claim_count) && Number(value.fact_claim_count) > 0 && Number(value.fact_claim_count) <= 500 &&
    Number.isSafeInteger(value.pending_question_count) && Number(value.pending_question_count) >= 0 && Number(value.pending_question_count) <= 100;
}

function parseSummary(stdout: Buffer): RenderResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.toString('utf8')); }
  catch { throw new Error('NO_HISTORY_WORD_SUMMARY_INVALID'); }
  if (!exactResponse(parsed)) throw new Error('NO_HISTORY_WORD_SUMMARY_INVALID');
  return parsed;
}

async function runRenderer(python: string, directory: string, input: Buffer, signal: AbortSignal, timeoutMs: number): Promise<Buffer> {
  if (signal.aborted) throw new Error('NO_HISTORY_WORD_INTERRUPTED');
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(python, ['-m', 'bondbuddy_no_history_word'], {
      cwd: REPO,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        PYTHONPATH: resolve(REPO, 'python'),
        BONDBUDDY_WORD_OUTPUT_DIR: directory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    let timedOut = false;
    let bufferExceeded = false;
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(result!);
    };
    const stop = (error: Error) => {
      if (settled) return;
      child.kill('SIGKILL');
      finish(error);
    };
    const abort = () => stop(new Error('NO_HISTORY_WORD_INTERRUPTED'));
    const timer = setTimeout(() => {
      timedOut = true;
      stop(new Error('NO_HISTORY_WORD_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_STDOUT_BYTES) {
        bufferExceeded = true;
        stop(new Error('NO_HISTORY_WORD_OUTPUT_LIMIT_EXCEEDED'));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > MAX_STDERR_BYTES) {
        bufferExceeded = true;
        stop(new Error('NO_HISTORY_WORD_OUTPUT_LIMIT_EXCEEDED'));
      } else stderr.push(chunk);
    });
    child.on('error', () => finish(new Error('NO_HISTORY_WORD_PROCESS_FAILED')));
    child.on('close', (code, exitSignal) => {
      if (settled) return;
      if (signal.aborted) return finish(new Error('NO_HISTORY_WORD_INTERRUPTED'));
      if (timedOut) return finish(new Error('NO_HISTORY_WORD_TIMEOUT'));
      if (bufferExceeded) return finish(new Error('NO_HISTORY_WORD_OUTPUT_LIMIT_EXCEEDED'));
      if (code !== 0 || exitSignal) return finish(new Error('NO_HISTORY_WORD_RENDER_FAILED'));
      finish(undefined, Buffer.concat(stdout, stdoutSize));
    });
    child.stdin.on('error', () => { /* close/error is handled by the child process */ });
    child.stdin.end(input);
  });
}

/**
 * Render an untrusted model draft using only a separately supplied allowlist from the trusted
 * target-facts adapter. It returns inspected bytes and correlation metadata only; callers must
 * run later quality checks before any artifact promotion or succeeded transition.
 */
export async function renderNoHistoryDraft(
  ctx: Pick<StageContext, 'run' | 'signal'>,
  draft: unknown,
  trustedFactIds: TrustedTargetFactIds,
  options: { readonly timeoutMs?: number } = {},
): Promise<NoHistoryWordBytes> {
  if (ctx.run.task_kind !== 'generation') throw new Error('NO_HISTORY_WORD_TASK_KIND_REQUIRED');
  validateDraftVersion(draft);
  const binding: NoHistoryWordRunBinding = {
    ownerUserId: ctx.run.owner_user_id,
    projectId: ctx.run.project_id,
    runId: ctx.run.id,
    inputRevision: ctx.run.input_revision,
    inputHash: ctx.run.input_hash.trim(),
  };
  if (!binding.ownerUserId || !binding.projectId || !binding.runId || !Number.isSafeInteger(binding.inputRevision) ||
      binding.inputRevision < 1 || !validHash(binding.inputHash) || !trustedFactIds ||
      typeof trustedFactIds.has !== 'function' || typeof trustedFactIds[Symbol.iterator] !== 'function' || trustedFactIds.size === 0) {
    throw new Error('NO_HISTORY_WORD_RUN_BINDING_INVALID');
  }
  const trustedFactIdsProof = trustedTargetFactIdsProofs.get(trustedFactIds as object);
  if (!trustedFactIdsProof || trustedFactIds[trustedTargetFactIdsBrand] !== true || !sameRunBinding(trustedFactIdsProof.binding, binding))
    throw new Error('NO_HISTORY_WORD_TARGET_FACTS_SCOPE_MISMATCH');
  const request = Buffer.from(JSON.stringify({
    schema_version: REQUEST_SCHEMA,
    draft,
    allowed_target_fact_ids: [...trustedFactIdsProof.ids],
  }), 'utf8');
  if (request.length > MAX_INPUT_BYTES) throw new Error('NO_HISTORY_WORD_INPUT_LIMIT_EXCEEDED');
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new Error('NO_HISTORY_WORD_TIMEOUT_INVALID');
  if (ctx.signal.aborted) throw new Error('NO_HISTORY_WORD_INTERRUPTED');

  const directory = await mkdtemp(resolve(tmpdir(), 'bondbuddy-no-history-word-'));
  try {
    await chmod(directory, 0o700);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        (process.platform !== 'win32' && ((directoryStat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())))) {
      throw new Error('NO_HISTORY_WORD_STAGE_DIRECTORY_UNSAFE');
    }
    const python = process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3';
    const stdout = await runRenderer(python, directory, request, ctx.signal, timeoutMs);
    const summary = parseSummary(stdout);
    const claimCount = Array.isArray(draft.fact_claims) ? draft.fact_claims.length : -1;
    const sectionCount = Array.isArray(draft.sections) ? draft.sections.length : -1;
    const questionCount = Array.isArray(draft.open_questions) ? draft.open_questions.length : -1;
    if (summary.fact_claim_count !== claimCount || summary.section_count !== sectionCount || summary.pending_question_count !== questionCount)
      throw new Error('NO_HISTORY_WORD_OUTPUT_MISMATCH');
    const outputPath = resolve(directory, OUTPUT_NAME);
    const outputStat = await lstat(outputPath).catch(() => null);
    if (!outputStat?.isFile() || outputStat.isSymbolicLink() || outputStat.size !== summary.output_size_bytes ||
        outputStat.size < 1 || outputStat.size > MAX_OUTPUT_BYTES ||
        (process.platform !== 'win32' && ((outputStat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && outputStat.uid !== process.getuid())))) {
      throw new Error('NO_HISTORY_WORD_OUTPUT_MISMATCH');
    }
    const bytes = await readFile(outputPath);
    if (bytes.length !== outputStat.size || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error('NO_HISTORY_WORD_OUTPUT_MISMATCH');
    }
    if (sha256(bytes) !== summary.output_sha256) throw new Error('NO_HISTORY_WORD_OUTPUT_HASH_MISMATCH');
    return {
      bytes,
      metadata: {
        schemaVersion: RESPONSE_SCHEMA,
        writerVersion: WRITER_VERSION,
        contentType: DOCX_MIME,
        sha256: summary.output_sha256,
        sizeBytes: summary.output_size_bytes,
        sectionCount: summary.section_count,
        factClaimCount: summary.fact_claim_count,
        pendingQuestionCount: summary.pending_question_count,
        runBinding: binding,
        factIdsAllowlisted: true,
        factsVerified: false,
        deliveryChecked: false,
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
