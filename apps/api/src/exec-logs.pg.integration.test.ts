// SYNTHETIC PostgreSQL integration for private per-attempt Codex execution logs.
// Uses an in-memory private Blob double and a private database clone; no provider is called.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { digest, type PrivateBlobs } from './data.js';
import { codexExecLogObjectKey, recordCodexExecLog } from './exec-logs.js';
import type { ProviderCallIntent } from './provider-results.js';
import type { Lease } from './queue.js';

const connection = await isolatedTestDatabase('BB_TEST_EXEC_LOG_DATABASE_URL');

function memoryBlobs(): PrivateBlobs & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    async get(key) { const value = objects.get(key); if (!value) throw new Error('missing'); return Buffer.from(value); },
    async getIfExists(key) { const value = objects.get(key); return value ? Buffer.from(value) : null; },
    async getIfExistsBounded(key, max) { const value = objects.get(key); return value && value.length <= max ? Buffer.from(value) : null; },
    async exists(key) { return objects.has(key); },
    async delete(key) { objects.delete(key); }
  } as PrivateBlobs & { objects: Map<string, Buffer> };
}

test('execution logs persist as immutable owner-scoped evidence under the active lease', { skip: !connection }, async t => {
  const pool = new Pool({ connectionString: connection });
  const observer = new Pool({ connectionString: connection });
  async function fixture(): Promise<{ lease: Lease; intent: ProviderCallIntent }> {
    const owner = `synthetic-exec-owner-${randomUUID()}`, projectId = randomUUID(), runId = randomUUID(), jobId = randomUUID(), callId = randomUUID();
    const inputHash = 'a'.repeat(64), token = randomUUID(), logicalCallId = 'synthetic-exec-log';
    await observer.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic exec log project','update')", [projectId, owner]);
    await observer.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`, [projectId, owner, inputHash]);
    await observer.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$1,'update',$4,'running')`, [runId, owner, projectId, inputHash]);
    await observer.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'update','synthetic','running',$4,now()+interval '60 seconds',1)`, [jobId, owner, runId, token]);
    await observer.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id)
      VALUES($1,$2,$3,$4,1,'pending_reconcile','synthetic-model')`, [callId, owner, jobId, logicalCallId]);
    return {
      lease: { jobId, runId, owner, token, checkpoint: {}, attempts: 1 },
      intent: { owner_user_id: owner, project_id: projectId, job_id: jobId, run_id: runId, trace_id: runId,
        logical_call_id: logicalCallId, call_id: callId, attempt_no: 1, model_id: 'synthetic-model',
        model_config_version: 'synthetic-model-1', prompt_snapshot_ref: 'synthetic-prompt' }
    };
  }
  try {
    await t.test('writes the Blob, its hash and an immutable row; replays are idempotent', async () => {
      const f = await fixture();
      const blobs = memoryBlobs();
      const bytes = Buffer.from('[stdout]\n{"type":"thread.started"}\n[stderr]\nsynthetic stderr\n', 'utf8');
      const first = await recordCodexExecLog(pool, blobs, f.lease, f.intent, bytes, { truncated: false });
      assert.equal(first.idempotent, false);
      assert.equal(first.object_key, codexExecLogObjectKey(f.intent));
      assert.equal(first.sha256, digest(bytes));
      assert.deepEqual(blobs.objects.get(first.object_key), bytes);
      const row = (await observer.query('SELECT attempt_id,owner_user_id,project_id,run_id,job_id,object_key,sha256,byte_size,truncated FROM bb_codex_exec_logs WHERE attempt_id=$1', [f.intent.call_id])).rows[0];
      assert.deepEqual({ ...row, sha256: row.sha256.trim(), byte_size: Number(row.byte_size) }, {
        attempt_id: f.intent.call_id, owner_user_id: f.lease.owner, project_id: f.intent.project_id, run_id: f.lease.runId,
        job_id: f.lease.jobId, object_key: first.object_key, sha256: digest(bytes), byte_size: bytes.length, truncated: false
      });
      assert.deepEqual(await recordCodexExecLog(pool, blobs, f.lease, f.intent, bytes, { truncated: false }), { ...first, idempotent: true });
      await assert.rejects(recordCodexExecLog(pool, blobs, f.lease, f.intent, Buffer.from('different'), { truncated: false }), { code: 'IDEMPOTENCY_CONFLICT' });
      await assert.rejects(observer.query('UPDATE bb_codex_exec_logs SET byte_size=0 WHERE attempt_id=$1', [f.intent.call_id]));
    });

    await t.test('lease, owner, project and expiry are enforced before any row is written', async () => {
      const f = await fixture();
      const blobs = memoryBlobs();
      const bytes = Buffer.from('synthetic evidence');
      await assert.rejects(recordCodexExecLog(pool, blobs, { ...f.lease, owner: 'synthetic-foreign-owner' }, f.intent, bytes, { truncated: false }), { code: 'NOT_FOUND' });
      await assert.rejects(recordCodexExecLog(pool, blobs, f.lease, { ...f.intent, project_id: 'synthetic-foreign-project' }, bytes, { truncated: false }), { code: 'NOT_FOUND' });
      await assert.rejects(recordCodexExecLog(pool, blobs, { ...f.lease, token: 'synthetic-stale-token' }, f.intent, bytes, { truncated: false }), { code: 'CAPABILITY_NOT_READY' });
      await observer.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [f.lease.jobId]);
      await assert.rejects(recordCodexExecLog(pool, blobs, f.lease, f.intent, bytes, { truncated: false }), { code: 'CAPABILITY_NOT_READY' });
      assert.equal((await observer.query('SELECT count(*)::int n FROM bb_codex_exec_logs WHERE attempt_id=$1', [f.intent.call_id])).rows[0].n, 0);
    });

    await t.test('a terminal run rejects late log writes', async () => {
      const f = await fixture();
      await observer.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [f.lease.runId]);
      const blobs = memoryBlobs();
      await assert.rejects(recordCodexExecLog(pool, blobs, f.lease, f.intent, Buffer.from('late'), { truncated: false }), { code: 'CAPABILITY_NOT_READY' });
    });
  } finally { await pool.end(); await observer.end(); }
});
