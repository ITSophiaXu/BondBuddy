import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  OcrBatchResponseV2Schema, OcrDocumentIdentityV2Schema, OcrPageCheckpointV2Schema,
  validateOcrBatchRequestV2, type OcrBatchRequestV2, type OcrDocumentIdentityV2,
  type OcrPageCheckpointV2, type OcrBatchResponseV2
} from '@bondbuddy/contracts';
import { authorizeOcrMaterial } from '@bondbuddy/api/ocr';
import {
  authorizeOcrV2, beginOcrV2Batch, finishOcrV2Batch, persistOcrV2Page,
  readOcrV2Aggregate, readOcrV2Pages, settleInterruptedOcrV2, type OcrV2Scope
} from '@bondbuddy/api/ocr-v2';
import { azureBlobs, digest, uid, type PrivateBlobs } from '@bondbuddy/api/data';

type Probe = { schema_version: 'ocr-identity-probe-v2'; material_path: string; owner_user_id: string;
  project_id: string; material: OcrDocumentIdentityV2['material']; language: 'chi_sim+eng' | 'eng' };
type Invocation = { schema_version: 'ocr-invocation-v2'; request: OcrBatchRequestV2; material_path: string;
  reuse_checkpoints: [] };
type InvocationResult = { schema_version: 'ocr-invocation-response-v2'; response: unknown;
  checkpoints: Array<{ checkpoint: unknown; image_base64: string }> };
export type OcrV2RunnerOptions = {
  pythonExecutable?: string; repoRoot?: string; language?: 'chi_sim+eng' | 'eng';
  /** Synthetic test seams; production always uses the bounded Python subprocess. */
  probe?: (request: Probe) => Promise<unknown>;
  invoke?: (request: Invocation) => Promise<unknown>;
  afterPage?: (page: number) => Promise<void>;
};

async function python(request: Probe | Invocation, options: OcrV2RunnerOptions): Promise<unknown> {
  const outputLimit = request.schema_version === 'ocr-invocation-v2' ? 192 * 1024 * 1024 : 65536;
  const timeout = request.schema_version === 'ocr-invocation-v2'
    ? Math.min(30 * 60_000, request.request.pages.length * 60_000) : 30_000;
  return new Promise((resolveResult, reject) => {
    const detached = process.platform !== 'win32';
    const root = options.repoRoot ?? process.cwd();
    const child = spawn(options.pythonExecutable ?? process.env.BB_PYTHON ?? 'python3', ['-m', 'bondbuddy_ocr'], {
      cwd: root, env: { ...process.env, PYTHONPATH: resolve(root, 'python') },
      detached, stdio: ['pipe', 'pipe', 'pipe']
    });
    const chunks: Buffer[] = [];
    let size = 0, stderrSize = 0, settled = false;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (detached && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { /* already exited */ }
      reject(new Error(code));
    };
    const timer = setTimeout(() => fail('OCR_PROCESS_TIMEOUT'), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) return fail('OCR_OUTPUT_LIMIT');
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 65536) fail('OCR_PROCESS_FAILED');
    });
    child.on('error', () => fail('OCR_PROCESS_UNAVAILABLE'));
    child.stdin.on('error', () => fail('OCR_PROCESS_FAILED'));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('OCR_PROCESS_FAILED'));
      try { resolveResult(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('OCR_INVALID_RESPONSE')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function checkedProbe(raw: unknown, expected: Probe): OcrDocumentIdentityV2 {
  if (!raw || typeof raw !== 'object' || !('schema_version' in raw) ||
      raw.schema_version !== 'ocr-identity-probe-response-v2' || !('document' in raw) ||
      !Value.Check(OcrDocumentIdentityV2Schema, raw.document)) throw new Error('OCR_INVALID_IDENTITY');
  const document = raw.document;
  if (document.owner_user_id !== expected.owner_user_id || document.project_id !== expected.project_id ||
      !Value.Equal(document.material, expected.material) || document.engine.language !== expected.language ||
      document.processor_version !== 'bondbuddy-ocr-2.0.0' || document.engine.name !== 'tesseract') throw new Error('OCR_INVALID_IDENTITY');
  return document;
}

function checkedInvocation(raw: unknown, request: OcrBatchRequestV2) {
  if (!raw || typeof raw !== 'object' || !('schema_version' in raw) ||
      raw.schema_version !== 'ocr-invocation-response-v2' || !('response' in raw) ||
      !Value.Check(OcrBatchResponseV2Schema, raw.response) || !('checkpoints' in raw) ||
      !Array.isArray(raw.checkpoints)) throw new Error('OCR_INVALID_RESPONSE');
  const result = raw as InvocationResult;
  const response = result.response as OcrBatchResponseV2;
  if (response.request_id !== request.request_id || !Value.Equal(response.document, request.document) ||
      !Value.Equal(response.context, request.context) ||
      !Value.Equal(response.page_results.map(page => page.page), request.pages)) throw new Error('OCR_INVALID_RESPONSE');
  const succeeded = response.page_results.filter(page => page.status === 'succeeded' && !page.reused);
  if (response.page_results.some(page => page.status === 'succeeded' && page.reused) ||
      succeeded.length !== result.checkpoints.length) throw new Error('OCR_INVALID_RESPONSE');
  return { response, checkpoints: result.checkpoints };
}

/** Opt-in internal worker: one pass over missing physical pages, at most 50 per Python call.
 * Failed pages are left missing for a separate invocation, not promoted to success. */
export async function processOcrV2(pool: Pool, blobs: PrivateBlobs, scope: OcrV2Scope,
  options: OcrV2RunnerOptions = {}) {
  if (scope.purpose === 'source_preflight'
    ? scope.runId !== undefined || scope.leaseToken !== undefined
    : !scope.runId || !scope.leaseToken) throw new Error('INVALID_OCR_CONTEXT');
  const lock = await pool.connect();
  let acquired = false;
  const key = `${scope.owner}:${scope.projectId}:${scope.materialId}:${scope.version}`;
  try {
    const q = await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key]);
    if (!q.rows[0]?.locked) throw new Error('OCR_V2_ALREADY_RUNNING');
    acquired = true;
    const source = await authorizeOcrMaterial(pool, {
      owner: scope.owner, projectId: scope.projectId, materialId: scope.materialId, version: scope.version,
      requestId: 'ocr-v2-source', purpose: scope.purpose, runId: scope.runId
    });
    const size = Number(source.byte_size);
    if (!Number.isSafeInteger(size) || size < 1 || size > 100 * 1024 * 1024) throw new Error('OCR_INPUT_LIMIT');
    const bytes = await blobs.getIfExistsBounded(source.object_key, size);
    if (!bytes || bytes.length !== size || digest(bytes) !== source.sha256.trim()) throw new Error('OCR_SOURCE_INTEGRITY_FAILED');
    const directory = await mkdtemp(join(tmpdir(), 'bb-ocr-v2-source-'));
    try {
      const path = join(directory, 'source');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      const probe: Probe = {
        schema_version: 'ocr-identity-probe-v2', material_path: path,
        owner_user_id: scope.owner, project_id: scope.projectId,
        material: { material_id: scope.materialId, material_version: scope.version,
          sha256: source.sha256.trim(), media_type: source.media_type },
        language: options.language ?? 'chi_sim+eng'
      };
      const document = checkedProbe(await (options.probe ?? (input => python(input, options)))(probe), probe);
      const { context } = await authorizeOcrV2(pool, scope, document);
      await settleInterruptedOcrV2(pool, scope);
      const prior = await readOcrV2Pages(pool, blobs, scope, document);
      const target = scope.purpose === 'source_preflight' ? Math.min(document.page_count, 3) : document.page_count;
      const missing: number[] = [];
      for (let page = 1; page <= target; page++) if (!prior.has(page)) missing.push(page);
      const responses = [];
      for (let offset = 0; offset < missing.length; offset += 50) {
        const request: OcrBatchRequestV2 = {
          schema_version: 'ocr-request-v2', request_id: uid(), document, context,
          pages: missing.slice(offset, offset + 50), reuse: []
        };
        await validateOcrBatchRequestV2(request);
        await beginOcrV2Batch(pool, scope, request);
        try {
          const invocation: Invocation = { schema_version: 'ocr-invocation-v2', request, material_path: path, reuse_checkpoints: [] };
          const raw = await (options.invoke ?? (input => python(input, options)))(invocation);
          const { response, checkpoints } = checkedInvocation(raw, request);
          const outputs = new Map<number, { checkpoint: OcrPageCheckpointV2; image: Buffer }>();
          for (const entry of checkpoints) {
            if (!Value.Check(OcrPageCheckpointV2Schema, entry.checkpoint) ||
                typeof entry.image_base64 !== 'string') throw new Error('OCR_INVALID_RESPONSE');
            const checkpoint = entry.checkpoint;
            const image = Buffer.from(entry.image_base64, 'base64');
            if (image.toString('base64') !== entry.image_base64 || outputs.has(checkpoint.identity.page) ||
                !request.pages.includes(checkpoint.identity.page)) throw new Error('OCR_INVALID_RESPONSE');
            outputs.set(checkpoint.identity.page, { checkpoint, image });
          }
          for (const outcome of response.page_results) {
            if (outcome.status !== 'succeeded') continue;
            const entry = outputs.get(outcome.page);
            if (!entry || !Value.Equal(outcome.checkpoint, {
              page: outcome.page, identity_sha256: entry.checkpoint.identity_sha256,
              result_sha256: entry.checkpoint.result_sha256, source_request_id: entry.checkpoint.source_request_id
            })) throw new Error('OCR_INVALID_RESPONSE');
            await persistOcrV2Page(pool, blobs, scope, request, entry.checkpoint, entry.image);
            await options.afterPage?.(outcome.page);
          }
          await finishOcrV2Batch(pool, blobs, scope, request, response);
          responses.push(response);
        } catch (error) {
          await settleInterruptedOcrV2(pool, scope);
          throw error;
        }
      }
      const aggregate = await readOcrV2Aggregate(pool, blobs, scope, document, context);
      return { aggregate, responses };
    } finally { await rm(directory, { recursive: true, force: true }); }
  } finally {
    if (acquired) await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
    lock.release();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [purpose, owner, projectId, materialId, version, runId, leaseToken] = process.argv.slice(2);
  if (!['source_preflight', 'full_ocr'].includes(purpose ?? '') || !owner || !projectId || !materialId ||
      !/^[1-9]\d*$/.test(version ?? '') || (purpose === 'full_ocr') !== !!runId ||
      (purpose === 'full_ocr') !== !!leaseToken ||
      !process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING)
    throw new Error('OCR_V2_WORKER_CONFIGURATION_REQUIRED');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await processOcrV2(pool, azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING), {
      owner, projectId, materialId, version: Number(version), purpose: purpose as OcrV2Scope['purpose'],
      ...(runId ? { runId, leaseToken } : {})
    });
    process.stdout.write(JSON.stringify({ coverage: result.aggregate.coverage,
      successful_pages: result.aggregate.successful_pages.length, page_count: result.aggregate.document.page_count,
      attempted_pages: result.responses.map(response => response.attempted_pages) }) + '\n');
  } catch (error) {
    process.stderr.write('OCR_V2_FAILED\n');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
