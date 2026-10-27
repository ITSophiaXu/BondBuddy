// Synthetic CLI, real PostgreSQL/private Blob and durable worker stage. No supplier call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, uid, transaction } from '@bondbuddy/api/data';
import { claim, pauseRun } from '@bondbuddy/api/queue';
import { resolveRunExecution } from '@bondbuddy/api/run-execution';
import { INITIAL_FIXED_PRICES } from '@bondbuddy/contracts';
import { grantCredits, publishPrices, reserveCredits } from '../../api/dist/billing.js';
import { isolatedTestDatabase } from './test-database.js';
import { DEFAULT_DISABLED_FEATURES, type CodexAdapterConfig } from './codex-adapter.js';
import { codexModelStage, type StageContext } from './run-pipeline.js';

const database = await isolatedTestDatabase(undefined, 'm2-worker');
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('fixed-price worker completes and reuses a durable result with unknown usage; free M1 retains reconciliation',
  { skip: !database || !blobConnection, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString: database });
  const owner = `synthetic-m2-${uid()}`, blobs = azureBlobs(blobConnection!, 'bondbuddy-m2-worker');
  const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test', principal: async () => ({ userId: owner, csrfVerified: true }), enableSyntheticQueue: true });
  const root = await mkdtemp(join(tmpdir(), 'bb-m2-worker-'));
  const config: CodexAdapterConfig = { command: [process.execPath, fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url))],
    model_id: 'synthetic-model', model_provider: 'deepseek', base_url: 'https://api.deepseek.com', wire_api: 'responses', model_config_version: 'synthetic-m2',
    reasoning_effort: null, credential: { kind: 'env', name: 'BB_SYNTHETIC_DEEPSEEK_KEY' }, work_root: join(root, 'work'), timeout_ms: 5000,
    kill_grace_ms: 100, max_output_bytes: 1 << 20, max_schema_reasks: 0, disabled_features: DEFAULT_DISABLED_FEATURES, path_env: '/usr/bin:/bin' };
  const send = (method: string, url: string, payload: any) => app.inject({ method: method as any, url, payload, headers: { origin: 'http://bondbuddy.test' } });
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, 'synthetic_m2_worker']);
    await publishPrices(pool, { id: 'synthetic-v1', prices: INITIAL_FIXED_PRICES, effectiveAt: '2026-01-01T00:00:00Z', actor: 'synthetic', reason: 'test only' });
    for (const paid of [true, false]) {
      const p = await send('POST', '/api/v1/projects', { name: 'Synthetic worker billing', kind: 'update', issuer_name: null, market: null, offering: null });
      assert.equal(p.statusCode, 201, p.body);
      const projectId = p.json().project_id;
      const input = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: 1, material_versions: [], requirement_message_ids: [] });
      assert.equal(input.statusCode, 201, input.body);
      const submitted = await send('POST', '/api/v1/runs/execute', { execution_request_id: uid(), project_id: projectId, input_revision: 1,
        input_hash: input.json().input_hash, task_kind: 'update', input_manifest_ref: 'synthetic', storage_origin: 'cloud', workspace_id: 'synthetic' });
      assert.equal(submitted.statusCode, 202, submitted.body);
      const runId = submitted.json().run_id;
      if (paid) await transaction(pool, async c => {
        await grantCredits(c, { owner, source: 'purchase', key: uid(), points: 17900, expiresAt: null, actor: 'synthetic', reason: 'test only' });
        const quoteId = uid();
        await c.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
          VALUES($1,$2,$3,1,$4,'synthetic-v1','interim',17900,'synthetic worker fixture')`, [quoteId, owner, projectId, input.json().input_hash]);
        const run = (await c.query('SELECT * FROM bb_runs WHERE id=$1', [runId])).rows[0];
        const locked = (await c.query('SELECT * FROM bb_input_revisions WHERE project_id=$1', [projectId])).rows[0];
        const project = (await c.query('SELECT * FROM bb_projects WHERE id=$1', [projectId])).rows[0];
        await reserveCredits(c, owner, run, quoteId, locked, project);
      });
      const lease = await claim(pool); assert.ok(lease); assert.equal(lease.runId, runId);
      const run = await resolveRunExecution(pool, owner, runId, lease);
      const ctx: StageContext = { pool, blobs, lease, run, signal: new AbortController().signal, checkpoint: {}, values: new Map() };
      const stage = codexModelStage({ name: 'synthetic_m2_model', logicalCallId: 'synthetic-m2-call', config,
        buildPrompt: async () => 'SCENARIO:missing_usage', schema: { type: 'object' }, validate: v => (v as any)?.answer === 'OK', resultSchemaVersion: 'synthetic-v1' });
      const result = await stage.run(ctx);
      if (paid) {
        assert.equal(result.kind, 'done');
        assert.equal((await stage.run(ctx)).kind, 'done');
        const rows = (await pool.query('SELECT status,usage_status FROM bb_model_call_attempts WHERE job_id=$1', [lease.jobId])).rows;
        assert.deepEqual(rows, [{ status: 'completed', usage_status: 'unknown' }]);
        await pauseRun(pool, lease, 'awaiting_materials', 'synthetic_fixture_complete');
      } else {
        assert.equal(result.kind, 'stopped');
        assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [runId])).rows[0].state, 'paused');
      }
    }
  } finally { await app.close(); await pool.end(); await rm(root, { recursive: true, force: true }); }
});
