import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { LibraryErrorCode } from '@bondbuddy/contracts';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import {
  checkpointLibraryJob, claimLibraryJob, classifyLibraryVersion, failLibraryJob, ingestLibraryVersion, markLibraryVersionFailed, markLibraryVersionParsed,
  readLibraryVersionBytes, recordSyncItem, renewLibraryJob, startSyncRun, succeedLibraryJob,
  type Classification, type LibraryLease, type ProfileDraft,
} from '@bondbuddy/api/library';
import { Problem } from '@bondbuddy/api/data';
import { DEFAULT_DOCUMENT_PARSER_VERSION } from '@bondbuddy/api/material-jobs';
import { DOCUMENT_PARSE_REQUEST_VERSION, runDocumentParser, type DocumentParseRecord, type DocumentParseRequest, type DocumentParseResponse } from './document-parser.js';
import { SourceError, type DiscoveredItem, type LibrarySourceAdapter } from './library-sources.js';

// #78 pipeline: discover -> fetch -> dedupe by hash -> parse (existing Python parser bridge) -> classify/profile
// -> review queue. Runs on the bb_jobs lease model; per-item progress is checkpointed so a crashed run resumes
// after the last finished item, and publishing only ever happens through an operator review action.

export type LibraryClassifier = (input: { title: string; records: DocumentParseRecord[]; market: 'sse' | 'szse' | 'nafmii' | null }) => { classification: Classification; profile: ProfileDraft };
export type LibraryParser = (request: DocumentParseRequest) => Promise<DocumentParseResponse>;

export interface LibraryPipelineDependencies {
  pool: Pool;
  blobs: PrivateBlobs;
  adapters: Record<string, LibrarySourceAdapter>;
  parser?: LibraryParser;
  classifier?: LibraryClassifier;
  leaseSeconds?: number;
  fetchAttempts?: number;
  retryDelayMs?: number;
  /** Test seam: runs after each item is durably checkpointed (e.g. to simulate a crash). */
  afterItem?: (index: number, item: DiscoveredItem, lease: LibraryLease) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
}
export type LibraryRunOutcome = { outcome: 'idle' | 'succeeded' | 'retry_scheduled' | 'failed' | 'lost'; jobId?: string; syncRunId?: string; partial?: boolean };

export const LIBRARY_TAXONOMY_VERSION = 'bb-business-taxonomy-draft-0';

/**
 * Conservative default classifier. It derives market/offering/instrument/stage from the prospectus title and
 * NEVER guesses the top-three businesses: without an evidenced consolidated revenue table it returns an
 * incomplete profile, which keeps the version in review until an operator correction supplies evidence.
 */
export const conservativeClassifier: LibraryClassifier = ({ title, market }) => {
  const offering = market === 'sse' || market === 'szse'
    ? (/非公开发行/.test(title) ? 'private' : /面向(?:普通|公众)投资者|面向公众/.test(title) ? 'public_all' : /面向专业投资者公开发行|公开发行/.test(title) ? 'public' : null)
    : null;
  const instrument = market === 'sse' || market === 'szse'
    ? (/可交换/.test(title) ? 'exchangeable_bond' : /可续期/.test(title) ? 'renewable_corporate_bond' : /公司债券/.test(title) ? 'corporate_bond' : null)
    : null;
  return {
    classification: { market, offering, instrument, documentStage: market === 'sse' ? 'registration' : null },
    profile: { fiscalYear: null, taxonomyVersion: LIBRARY_TAXONOMY_VERSION, accountingScope: 'unknown', top3: null },
  };
};

const defaultParser: LibraryParser = request => runDocumentParser(request, { pythonExecutable: process.env.BB_PYTHON ?? 'python3', repoRoot: process.env.BB_REPO_ROOT ?? process.cwd() });

class StageError extends Error { constructor(public code: LibraryErrorCode, public retryable: boolean) { super(code); } }

class RetriesExhausted extends SourceError { constructor(cause: SourceError, public tries: number) { super(cause.code, false, cause.detail); } }
async function withRetries<T>(attempts: number, delayMs: number, work: () => Promise<T>): Promise<{ value: T; tries: number }> {
  let last: unknown, tries = 0;
  while (tries < attempts) {
    tries++;
    try { return { value: await work(), tries }; } catch (error) {
      last = error;
      if (error instanceof SourceError && !error.retryable) break;
      if (tries < attempts) await new Promise(r => setTimeout(r, delayMs * tries));
    }
  }
  throw last instanceof SourceError ? new RetriesExhausted(last, tries) : last;
}

/** Parse then classify one version. Idempotent: each step checks the stored state first. */
export async function processLibraryVersion(deps: LibraryPipelineDependencies, versionId: string, meta: { title: string; market: 'sse' | 'szse' | 'nafmii' | null }) {
  const { pool, blobs } = deps;
  const parser = deps.parser ?? defaultParser, classifier = deps.classifier ?? conservativeClassifier;
  const state = async () => (await pool.query('SELECT state, version, sha256, media_type FROM bb_library_document_versions WHERE id=$1', [versionId])).rows[0];
  let v = await state();
  if (!['pending_parse', 'pending_classify'].includes(v.state)) return v.state as string;
  const body = await readLibraryVersionBytes(pool, blobs, versionId);
  const dir = await mkdtemp(join(tmpdir(), 'bb-library-'));
  let parsed: DocumentParseResponse;
  try {
    const path = join(dir, 'document');
    await writeFile(path, body.bytes, { mode: 0o600 });
    try {
      parsed = await parser({ schema_version: DOCUMENT_PARSE_REQUEST_VERSION, request_id: `library-${versionId}`,
        material: { material_id: `library-${versionId}`, material_version: v.version, media_type: body.mediaType as any, sha256: body.sha256, authorized_local_path: path }, options: {} });
    } catch { parsed = { status: 'failed', records: [] } as unknown as DocumentParseResponse; }
  } finally { await rm(dir, { recursive: true, force: true }); }
  if (parsed.status === 'failed' || !parsed.records?.length) { await markLibraryVersionFailed(pool, versionId, 'LIBRARY_PARSE_FAILED'); return 'failed'; }
  // Parser output (records with page locators) is evidence for review; kept private next to the bytes.
  const evidenceKey = `library/parse/${versionId}/${parsed.parser_version ?? DEFAULT_DOCUMENT_PARSER_VERSION}.json`;
  if (!(await blobs.exists(evidenceKey))) await blobs.put(evidenceKey, Buffer.from(JSON.stringify(parsed)), 'application/json');
  await markLibraryVersionParsed(pool, versionId, { parser_version: parsed.parser_version, status: parsed.status, record_count: parsed.records.length,
    page_count: parsed.document?.page_count ?? null, warnings: (parsed.warnings ?? []).map(w => w.code), evidence_key: evidenceKey });
  v = await state();
  if (v.state !== 'pending_classify') return v.state as string;
  let result;
  try { result = classifier({ title: meta.title, records: parsed.records, market: meta.market }); }
  catch { await markLibraryVersionFailed(pool, versionId, 'LIBRARY_CLASSIFY_FAILED'); return 'failed'; }
  await classifyLibraryVersion(pool, versionId, result.classification, result.profile);
  return (await state()).state as string;
}

export async function runLibraryOnce(deps: LibraryPipelineDependencies): Promise<LibraryRunOutcome> {
  const { pool } = deps;
  const leaseSeconds = deps.leaseSeconds ?? 120;
  const lease = await claimLibraryJob(pool, leaseSeconds);
  if (!lease) return { outcome: 'idle' };
  const heartbeat = setInterval(() => { void renewLibraryJob(pool, lease, leaseSeconds).catch(() => clearInterval(heartbeat)); }, Math.max(1000, leaseSeconds * 400));
  const log = deps.log ?? (() => {});
  try {
    if (lease.subtype === 'library_record') {
      const meta = (await pool.query(`SELECT d.title, v.market FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id WHERE v.id=$1`, [lease.versionId])).rows[0];
      const sync = await startSyncRun(pool, lease, 'record_rerun');
      const finalState = await processLibraryVersion(deps, lease.versionId!, meta);
      await recordSyncItem(pool, sync.syncRunId, `rerun:${lease.versionId}`, finalState === 'failed' ? 'failed' : 'unchanged', { versionId: lease.versionId, errorCode: finalState === 'failed' ? 'LIBRARY_PARSE_FAILED' : undefined });
      await succeedLibraryJob(pool, lease, { final_state: finalState });
      return { outcome: 'succeeded', jobId: lease.jobId, syncRunId: sync.syncRunId };
    }
    const adapter = deps.adapters[lease.sourceId];
    if (!adapter) throw new StageError('LIBRARY_SOURCE_DISABLED', false);
    const sync = await startSyncRun(pool, lease, adapter.mode);
    let discovered: DiscoveredItem[] = lease.checkpoint.discovered;
    let cursorAfter: Record<string, unknown> = lease.checkpoint.cursor_after;
    if (!Array.isArray(discovered)) {
      let discovery;
      try { discovery = await adapter.discover(sync.cursorBefore, lease.checkpoint); }
      catch (error) { throw error instanceof SourceError ? new StageError(error.code, error.retryable) : new StageError('LIBRARY_SOURCE_UNREACHABLE', true); }
      // Items that failed in an earlier run ride along in the cursor until they succeed, so advancing the
      // high-water mark never drops them.
      const carried: DiscoveredItem[] = Array.isArray(sync.cursorBefore.retry_items) ? sync.cursorBefore.retry_items as DiscoveredItem[] : [];
      const seen = new Set(discovery.items.map(i => i.itemKey));
      discovered = [...carried.filter(i => !seen.has(i.itemKey)), ...discovery.items];
      cursorAfter = { ...discovery.cursorAfter };
      await checkpointLibraryJob(pool, lease, 'discovered', { discovered, cursor_after: cursorAfter, next_index: 0 });
      log({ event: 'discovered', source: lease.sourceId, items: discovered.length });
    }
    let failed = Number(lease.checkpoint.failed ?? 0);
    for (let index = Number(lease.checkpoint.next_index ?? 0); index < discovered.length; index++) {
      const item = discovered[index]!;
      let outcome: string, versionId: string | null = null, errorCode: LibraryErrorCode | undefined, detail: string | null = null, tries = 1, step: 'fetch' | 'ingest' | 'process' = 'fetch';
      try {
        const fetched = await withRetries(deps.fetchAttempts ?? 3, deps.retryDelayMs ?? 1000, () => adapter.fetch(item));
        const bytes = fetched.value; tries = fetched.tries; step = 'ingest';
        const ingested = await ingestLibraryVersion(pool, deps.blobs, { sourceId: lease.sourceId, externalKey: item.externalKey, issuerKey: item.issuerKey, issuerName: item.issuerName,
          title: item.title, sourceRevision: item.sourceRevision, sourceRevisionRank: item.sourceRevisionRank, bytes, mediaType: item.mediaType, sourceUrl: item.sourceUrl,
          disclosedAt: item.disclosedAt, market: item.market, jobId: lease.jobId });
        outcome = ingested.outcome; versionId = ingested.versionId; step = 'process';
        if (outcome === 'new_document' || outcome === 'new_version' || outcome === 'unchanged') {
          const state = await processLibraryVersion(deps, ingested.versionId, { title: item.title, market: item.market });
          if (state === 'failed' && outcome !== 'unchanged') { errorCode = 'LIBRARY_PARSE_FAILED'; }
        }
      } catch (error) {
        if (error instanceof Problem && error.code === 'ALREADY_TERMINAL') throw error;
        if (process.env.BB_LIBRARY_DEBUG) process.stderr.write(`item error: ${error instanceof Error ? error.message : String(error)}\n`);
        outcome = 'failed';
        errorCode = error instanceof SourceError ? error.code : (error instanceof Error && error.message === 'LIBRARY_BYTES_INVALID') ? 'LIBRARY_BYTES_INVALID'
          : step === 'process' ? 'LIBRARY_PARSE_FAILED' : 'LIBRARY_FETCH_FAILED';
        tries = error instanceof RetriesExhausted ? error.tries : tries;
        detail = error instanceof SourceError ? error.detail : `${step}_error`;
        failed++;
        await checkpointLibraryJob(pool, lease, 'items', { retry_items: [...(lease.checkpoint.retry_items ?? []), item].slice(-200) });
      }
      await recordSyncItem(pool, sync.syncRunId, item.itemKey, outcome, { versionId, errorCode, attempts: tries });
      await checkpointLibraryJob(pool, lease, 'items', { next_index: index + 1, failed });
      log({ event: 'item', source: lease.sourceId, item: item.itemKey, outcome, error: errorCode ?? null, detail, tries });
      await deps.afterItem?.(index, item, lease);
    }
    const retryItems: DiscoveredItem[] = lease.checkpoint.retry_items ?? [];
    await succeedLibraryJob(pool, lease, { discovered: discovered.length, failed }, { syncRunId: sync.syncRunId,
      cursorAfter: { ...(cursorAfter ?? {}), ...(retryItems.length ? { retry_items: retryItems } : {}) }, partial: failed > 0 });
    return { outcome: 'succeeded', jobId: lease.jobId, syncRunId: sync.syncRunId, partial: failed > 0 };
  } catch (error) {
    if (error instanceof Problem && error.code === 'ALREADY_TERMINAL') return { outcome: 'lost', jobId: lease.jobId };
    const failure = error instanceof StageError ? error : new StageError('LIBRARY_FETCH_FAILED', true);
    try { return { outcome: await failLibraryJob(pool, lease, failure.code, failure.retryable), jobId: lease.jobId }; }
    catch (inner) { if (inner instanceof Problem && inner.code === 'ALREADY_TERMINAL') return { outcome: 'lost', jobId: lease.jobId }; throw inner; }
  } finally { clearInterval(heartbeat); }
}
