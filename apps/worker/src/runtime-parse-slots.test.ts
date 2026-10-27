// Synthetic PostgreSQL/Azurite scheduling regression: a long run must not starve uploads.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { DEFAULT_DOCUMENT_PARSER_VERSION } from '@bondbuddy/api/material-jobs';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { WorkerRuntime, workerRuntimeOptionsFromEnv } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';
import type { RunStage } from './run-pipeline.js';

const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL', 'parse-slots');
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const waitFor = async <T>(read: () => Promise<T | false | undefined>, ms = 10000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for job');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

function syntheticParse(request: DocumentParseRequest): DocumentParseResponse {
  const m = request.material;
  return { schema_version: 'document-parse-response-v1', request_id: request.request_id, parser_version: DEFAULT_DOCUMENT_PARSER_VERSION,
    status: 'parsed', material: { material_id: m.material_id, material_version: m.material_version, media_type: m.media_type, sha256: m.sha256 },
    records: [{ record_id: 'line-1', material_id: m.material_id, material_version: m.material_version, content_hash: m.sha256,
      locator_type: 'text_line', locator: { line: 1, stable_ref: 'text:l000001' }, literal_quote: 'Synthetic audit text',
      context: 'synthetic', extraction_method: 'native_text', extractor_version: DEFAULT_DOCUMENT_PARSER_VERSION,
      confidence: 1, uncertainty: [], formatting: {} }], warnings: [], document: { page_count: null, encoding: 'utf-8' }, error: null } as DocumentParseResponse;
}

test('dedicated parse slot finishes an upload before a blocked run, and zero restores serial scheduling', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection, max: 8 });
  const blobs = azureBlobs(blobConnection!, `bb-slots-${randomUUID()}`);
  const owner = `slots-owner-${randomUUID()}`;
  const app = createServer({ pool, blobs, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }), enableRunRuntime: true });
  const send = (method: string, url: string, payload?: unknown, contentType?: string) => app.inject({ method: method as any, url,
    headers: { origin, ...(contentType ? { 'content-type': contentType } : {}) }, payload: payload as any });
  const upload = async (projectId: string) => {
    const bytes = Buffer.from(`synthetic audit ${randomUUID()}`);
    const started = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`,
      { filename: 'audit.txt', media_type: 'text/plain', byte_size: bytes.length, sha256: sha(bytes), role: 'audit' });
    assert.equal(started.statusCode, 201, started.body);
    assert.equal((await send('PUT', started.json().upload_url, bytes, 'application/octet-stream')).statusCode, 204);
    const completed = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${started.json().upload_id}/complete`,
      { byte_size: bytes.length, sha256: sha(bytes) });
    assert.equal(completed.statusCode, 200, completed.body);
    return completed.json() as { material_id: string; material_version: number };
  };
  const jobState = async (materialId: string) => (await pool.query("SELECT state FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [materialId])).rows[0]?.state as string | undefined;
  try {
    for (const parseSlots of [1, 0]) {
      const project = await send('POST', '/api/v1/projects', { name: `Synthetic slots ${parseSlots}`, kind: 'update', issuer_name: null, market: null, offering: null });
      assert.equal(project.statusCode, 201, project.body);
      const projectId = project.json().project_id as string;
      const first = await upload(projectId);
      const current = (await send('GET', `/api/v1/projects/${projectId}`)).json();
      const input = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: current.draft_revision,
        material_versions: [{ material_id: first.material_id, material_version: first.material_version }], requirement_message_ids: [] });
      assert.equal(input.statusCode, 201, input.body);
      const submitted = await send('POST', '/api/v1/runs/execute', { execution_request_id: `slots-${randomUUID()}`,
        project_id: projectId, input_revision: input.json().input_revision, input_hash: input.json().input_hash,
        task_kind: 'update', input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-test' });
      assert.equal(submitted.statusCode, 202, submitted.body);
      const runId = submitted.json().run_id as string;
      if (parseSlots === 1) {
        const parseOnly = new WorkerRuntime({ pool, blobs, concurrency: 1, parseSlots: 1, kinds: ['parse'], pollMs: 100,
          sweepMs: 60000, workerId: `synthetic-parse-only-${randomUUID()}`,
          parse: { material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key) }, parser: async request => syntheticParse(request) } } }).start();
        try {
          await waitFor(async () => (await jobState(first.material_id)) === 'succeeded');
          assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [runId])).rows[0].state, 'queued', 'parse-only worker must not claim a run');
          assert.equal(parseOnly.counters.run, 0);
        } finally { await parseOnly.stop(); }
      }
      let enter!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const blockingStage: RunStage = { name: 'input_lock', run: async () => {
        enter();
        await blocked;
        return { kind: 'pause', stage: 'capability_not_ready', reason: 'synthetic_test_complete' };
      } };
      const workerId = `synthetic-slots-${randomUUID()}`;
      const runtime = new WorkerRuntime({ pool, blobs, concurrency: 1, parseSlots, kinds: ['run', 'parse'], pollMs: 100,
        sweepMs: 60000, heartbeatMs: 1000, workerId,
        runStages: [blockingStage], parse: { material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key) }, parser: async request => syntheticParse(request) } } }).start();
      try {
        await entered;
        const next = await upload(projectId);
        if (parseSlots === 1) {
          await waitFor(async () => (await jobState(next.material_id)) === 'succeeded');
          assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [runId])).rows[0].state, 'running');
        } else {
          await new Promise(resolve => setTimeout(resolve, 500));
          assert.equal(await jobState(next.material_id), 'queued', 'without a parse slot, the blocked run owns the only parse-capable loop');
        }
        const heartbeat = await waitFor(async () => (await pool.query('SELECT concurrency FROM bb_worker_heartbeats WHERE worker_id=$1', [workerId])).rows[0]);
        assert.equal(heartbeat.concurrency, 2 + parseSlots, 'heartbeat includes the default interactive reservation');
        release();
        await waitFor(async () => (await jobState(next.material_id)) === 'succeeded');
      } finally { release(); await runtime.stop(); }
    }
  } finally { await app.close(); await pool.end(); }
});

test('parse-only workers keep their configured capacity and never claim runs; invalid slot values fail', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const blobs = azureBlobs(blobConnection!);
  try {
    for (const raw of ['-1', '5', '1.5', 'abc'])
      assert.throws(() => workerRuntimeOptionsFromEnv(pool, blobs, { BB_WORKER_PARSE_SLOTS: raw,
        BB_PARSE_CACHE_OCR_VERSION: 'synthetic-ocr-1', BB_PARSE_CACHE_BASIS_VERSION: 'synthetic-basis-1' }), /BB_WORKER_PARSE_SLOTS/);
    for (const kind of ['parse', 'run'] as const) {
      const workerId = `synthetic-${kind}-only-${randomUUID()}`;
      const runtime = new WorkerRuntime({ pool, blobs, concurrency: 1, parseSlots: 1, kinds: [kind], workerId,
        pollMs: 100, sweepMs: 60000, parse: { material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key) }, parser: async request => syntheticParse(request) } } }).start();
      try {
        const beat = await waitFor(async () => (await pool.query('SELECT concurrency,kinds FROM bb_worker_heartbeats WHERE worker_id=$1', [workerId])).rows[0]);
        assert.equal(beat.concurrency, kind === 'run' ? 2 : 1, 'parse-only workers receive no extra interactive slot');
        assert.deepEqual(beat.kinds, [kind]);
        if (kind === 'parse') assert.equal(runtime.counters.run, 0);
      } finally { await runtime.stop(); }
    }
  } finally { await pool.end(); }
});
