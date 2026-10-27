import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { M4_BILLING_TASKS, type M4MaterialPin } from '@bondbuddy/contracts';
import { digest, Problem, transaction, type PrivateBlobs } from './data.js';
import { createServer } from './server.js';
import { grantCredits } from './billing.js';
import { emptyM4Draft } from './m4-workspace.js';
import { publishM4BillingConfig, type M4BillingConfig } from './m4-billing.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { inputManifestHash } from './production-rule-pin.js';
import { action, claim, finish, requeueGeneratedWordDelivery } from './queue.js';
import { createRunSupplementPreparationTestContext } from './run-supplement-preparation-test-fixture.js';
import { runStorageLifecycle } from './storage-lifecycle.js';
import { isolatedTestDatabase } from './test-database.js';

const m4Connection = await isolatedTestDatabase(undefined, 'material-purge-m4-race');
const recoveryConnection = await isolatedTestDatabase(undefined, 'material-purge-recovery-race');
const stagedConnection = await isolatedTestDatabase(undefined, 'material-purge-staged');
const origin = 'http://bondbuddy.test';
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(message);
}

function memoryBlobs() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [], deletes: string[] = [];
  const blobs: PrivateBlobs = {
    put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes = objects.get(key); assert.ok(bytes); return Buffer.from(bytes); },
    getIfExists: async key => { reads.push(key); return objects.get(key) ?? null; },
    getIfExistsBounded: async (key, limit) => {
      const bytes = objects.get(key);
      if (bytes && bytes.length > limit) throw new Error('Synthetic bounded read refused');
      return bytes ?? null;
    },
    exists: async key => objects.has(key),
    delete: async key => { deletes.push(key); objects.delete(key); },
  };
  return { objects, reads, deletes, blobs };
}

function server(pool: Pool, owner: string, blobs: PrivateBlobs) {
  const app = createServer({ pool, blobs, allowedOrigin: origin,
    principal: async () => ({ userId: owner, csrfVerified: true }), enableSyntheticQueue: true });
  const send = (method: string, url: string, payload?: unknown) => app.inject({
    method: method as any, url, payload: payload as any, headers: { origin },
  });
  const ok = async (method: string, url: string, payload?: unknown) => {
    const response = await send(method, url, payload);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  return { app, send, ok };
}

async function seedProject(pool: Pool, owner: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering)
    VALUES($1,$2,'Synthetic purge barrier source','update','Synthetic issuer','sse','private')`, [id, owner]);
  return id;
}

async function seedMaterial(pool: Pool, blobs: PrivateBlobs, owner: string, projectId: string, id = randomUUID()) {
  const upload = randomUUID();
  const bytes = makeSyntheticDocxFixture({ text: `Synthetic purge barrier ${id}` });
  const key = `users/${owner}/projects/${projectId}/uploads/${upload}`, sha256 = digest(bytes);
  await blobs.put(key, bytes, docx);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic.docx',$4,$5,$6,'other',$7,now()+interval '1 hour','completed')`,
  [upload, owner, projectId, docx, bytes.length, sha256, key]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'other','synthetic.docx',$5,$6,$7,$8,'parsed')`,
  [id, owner, projectId, upload, docx, bytes.length, sha256, key]);
  const pin: M4MaterialPin = { source_project_id: projectId, material_id: id, material_version: 1, sha256 };
  return { pin, key };
}

const policy = (owner: string) => ({ materialRetentionDays: 0, orphanUploadGraceHours: 1,
  ownerScope: owner, now: () => new Date(Date.now() + 60_000) });
const pinArgs = (owner: string, pin: M4MaterialPin) =>
  [owner, pin.source_project_id, pin.material_id, pin.material_version];
async function pinned(pool: Pool, owner: string, pin: M4MaterialPin) {
  return (await pool.query('SELECT bb_material_bytes_pinned($1,$2,$3,$4) AS pinned', pinArgs(owner, pin))).rows[0].pinned;
}
const constraint = (name: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === '23514'
    && 'constraint' in error && error.constraint === name;

async function rejectsRepeatableRead(pool: Pool, operation: (client: PoolClient) => Promise<unknown>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(operation(client), constraint('bb_material_lifecycle_isolation'));
  } finally { await client.query('ROLLBACK'); client.release(); }
}

test('material purge: real cross-project M4 execution wins before its billing wait and retains support/template bytes',
  { skip: !m4Connection, timeout: 90_000 }, async () => {
    const pool = new Pool({ connectionString: m4Connection, max: 12 });
    const owner = `purge-m4-${randomUUID()}`, memory = memoryBlobs();
    const { app, send, ok } = server(pool, owner, memory.blobs);
    const account = await pool.connect();
    let execution: Promise<any> | undefined, purge: ReturnType<typeof runStorageLifecycle> | undefined;
    let accountHeld = false;
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, 'synthetic_purge_m4']);
      const source = await seedProject(pool, owner), supportProject = await seedProject(pool, owner), templateProject = await seedProject(pool, owner);
      const main = await seedMaterial(pool, memory.blobs, owner, source);
      const support = await seedMaterial(pool, memory.blobs, owner, supportProject);
      const templateMaterial = await seedMaterial(pool, memory.blobs, owner, templateProject);
      const topic = (await ok('POST', '/api/v1/m4/topics', {
        creation_request_id: randomUUID(), name: 'Synthetic purge race', source_project_id: source,
      })).topic;
      const path = `/api/v1/m4/topics/${topic.topic_id}`;
      const template = (await ok('POST', '/api/v1/m4/templates', {
        creation_request_id: randomUUID(), name: 'Synthetic template', broker: 'Synthetic broker',
        document_type: 'private_summary', material: templateMaterial.pin,
      })).template;
      await ok('PUT', `${path}/drafts/private_summary`, { expected_version: 0,
        input: { ...emptyM4Draft('private_summary'), source_material: main.pin, materials: [support.pin],
          template: { template_id: template.template_id, template_version: template.template_version, sha256: template.sha256 },
          fields: { issuer_name: 'Synthetic issuer', market: 'sse', broker: 'Synthetic broker' } } });
      const config: M4BillingConfig = { model_id: 'synthetic-codex', rates: { 'synthetic-codex': {
        input_microyuan_per_million: 1_000_000, cached_microyuan_per_million: 1_000_000, output_microyuan_per_million: 2_000_000,
      } }, budgets: Object.fromEntries(Object.keys(M4_BILLING_TASKS).map(key => [key,
        { input_tokens: 1_000_000, output_tokens: 1_000_000, reserve_factor: 1.2 }])) as M4BillingConfig['budgets'] };
      await publishM4BillingConfig(pool, { id: `purge-m4-${randomUUID()}`, config,
        effective_at: '2026-01-01T00:00:00Z', actor: 'synthetic-test', reason: 'synthetic purge race only' });
      await transaction(pool, client => grantCredits(client, { owner, points: 10_000,
        key: randomUUID(), source: 'purchase', expiresAt: null, actor: 'synthetic-test', reason: 'synthetic only' }));
      const quote = (await ok('POST', `${path}/quote`, {
        kind: 'document', document_type: 'private_summary', expected_draft_version: 1,
      })).quote;
      await account.query('BEGIN'); accountHeld = true;
      const accountPid = (await account.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await account.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE', [owner]);
      execution = Promise.resolve(send('POST', `${path}/execute`, { execution_request_id: randomUUID(),
        document_type: 'private_summary', expected_draft_version: 1, quote_id: quote.quote_id, entrypoint: 'workspace' }));
      void execution.catch(() => {});
      const producerPid = await until(async () => (await pool.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`, [accountPid])).rows[0]?.pid,
      'the real M4 execution did not reach its account-row blocker');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1', [owner])).rows[0].n, 0,
        'the blocked producer must still be uncommitted');
      for (const material of [support, templateMaterial]) {
        assert.equal((await pool.query(`SELECT pg_try_advisory_xact_lock(bb_material_lifecycle_lock_key($1,$2,$3,$4)) AS acquired`,
          pinArgs(owner, material.pin))).rows[0].acquired, false, 'M4 must hold every cross-project material lock before billing');
        const deleted = await send('DELETE', `/api/v1/projects/${material.pin.source_project_id}/materials/${material.pin.material_id}`);
        assert.equal(deleted.statusCode, 204, deleted.body);
      }
      const readsBeforePurge = memory.reads.length;
      purge = runStorageLifecycle(pool, memory.blobs, policy(owner));
      void purge.catch(() => {});
      await until(async () => (await pool.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'
          AND $1::integer=ANY(pg_blocking_pids(pid))`, [producerPid])).rows[0]?.pid,
      'the purger did not wait on the uncommitted material producer');
      assert.equal(memory.reads.length, readsBeforePurge, 'the waiting purger must not reach Blob I/O');
      assert.equal(memory.deletes.length, 0);
      assert.equal((await pool.query(`SELECT count(*)::int n FROM bb_storage_purge_starts s
        JOIN bb_storage_tombstones t ON t.id=s.tombstone_id WHERE t.owner_user_id=$1`, [owner])).rows[0].n, 0);
      await account.query('COMMIT'); accountHeld = false;
      const accepted = await execution;
      assert.equal(accepted.statusCode, 200, accepted.body);
      const result = await purge;
      assert.equal(result.failed, 0); assert.equal(result.purged, 0); assert.equal(result.pinned, 2);
      for (const material of [support, templateMaterial]) {
        assert.equal(await pinned(pool, owner, material.pin), true);
        assert.equal(memory.objects.has(material.key), true);
      }
      assert.equal(memory.reads.length, readsBeforePurge); assert.equal(memory.deletes.length, 0);
      assert.equal((await pool.query(`SELECT count(*)::int n FROM bb_outbox
        WHERE owner_user_id=$1 AND event_type='storage.object_purged'`, [owner])).rows[0].n, 0);
    } finally {
      if (accountHeld) await account.query('ROLLBACK');
      account.release();
      await Promise.allSettled([execution, purge].filter(Boolean));
      await app.close(); await pool.end();
    }
  });

test('material purge: durable start wins against legal generated-Word failed-run recovery with complete rollback',
  { skip: !recoveryConnection, timeout: 90_000 }, async () => {
    const context = await createRunSupplementPreparationTestContext(recoveryConnection!);
    const { pool, owner } = context;
    const { app, send } = server(pool, owner, context.blobs);
    const entered = deferred(), release = deferred();
    let purge: ReturnType<typeof runStorageLifecycle> | undefined;
    try {
      const failedFixture = async () => {
        const fixture = await context.fixture();
        await action(pool, owner, fixture.runId, 'resume');
        const lease = await claim(pool, 300, { runKinds: ['update'] });
        assert.ok(lease); assert.equal(lease.runId, fixture.runId);
        await finish(pool, lease, 'failed', { errorCode: 'WORD_DELIVERY_UNAVAILABLE', failedStage: 'word_delivery' });
        return fixture;
      };
      // Establish that this is a service-approved failed -> active path, with
      // completed selected provider evidence and measured usage, before racing it.
      const control = await failedFixture();
      assert.equal((await requeueGeneratedWordDelivery(pool, { runId: control.runId, actor: 'synthetic-purge-control' })).idempotent, false);
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [control.runId])).rows[0].state, 'queued');
      await action(pool, owner, control.runId, 'cancel');
      const target = await failedFixture(), material = target.first;
      assert.equal(await pinned(pool, owner, material), false);
      const deleted = await send('DELETE', `/api/v1/projects/${target.projectId}/materials/${material.material_id}`);
      assert.equal(deleted.statusCode, 204, deleted.body);
      const gated: PrivateBlobs = { ...context.blobs, getIfExists: async key => {
        if (key === material.objectKey) { entered.resolve(); await release.promise; }
        return context.blobs.getIfExists(key);
      } };
      purge = runStorageLifecycle(pool, gated, { ...policy(owner), retryDelayMs: 1,
        afterBlobDelete: async () => { throw new Error('Synthetic crash after deleting original bytes'); } });
      void purge.catch(() => {});
      await Promise.race([entered.promise, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('purger did not reach the target Blob barrier')), 10_000);
        timer.unref();
      })]);
      const start = (await pool.query(`SELECT s.*,t.state,t.object_key,t.attempts,t.claim_token AS current_token
        FROM bb_storage_purge_starts s JOIN bb_storage_tombstones t ON t.id=s.tombstone_id
        WHERE t.owner_user_id=$1 AND t.project_id=$2 AND t.material_id=$3 AND t.material_version=1`,
      [owner, target.projectId, material.material_id])).rows[0];
      assert.ok(start, 'Blob I/O must follow a committed durable start');
      assert.equal(start.origin, 'verified_delete'); assert.equal(start.state, 'claimed');
      assert.equal(start.claim_token, start.current_token); assert.equal(start.claim_attempt, start.attempts);
      assert.equal(start.object_key, material.objectKey); assert.equal(context.objects.has(material.objectKey), true);
      const before = await context.evidence();
      await assert.rejects(requeueGeneratedWordDelivery(pool, { runId: target.runId, actor: 'synthetic-purge-race' }),
        (error: unknown) => error instanceof Problem && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT');
      assert.deepEqual(await context.evidence(), before, 'job/checkpoint, run/events, provider history, billing and outbox must all roll back');
      assert.equal(await pinned(pool, owner, material), false);
      release.resolve();
      const result = await purge;
      assert.equal(result.failed, 1); assert.equal(result.purged, 0);
      assert.equal(context.objects.has(material.objectKey), false);
      assert.equal((await pool.query('SELECT state FROM bb_storage_tombstones WHERE id=$1', [start.tombstone_id])).rows[0].state, 'pending');
      const durableStart = (await pool.query('SELECT * FROM bb_storage_purge_starts WHERE tombstone_id=$1', [start.tombstone_id])).rows[0];
      const afterUncertainDelete = await context.evidence();
      await assert.rejects(requeueGeneratedWordDelivery(pool, { runId: target.runId, actor: 'synthetic-purge-after-crash' }),
        (error: unknown) => error instanceof Problem && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT');
      assert.deepEqual(await context.evidence(), afterUncertainDelete, 'a failed finalize must not reopen execution admission');
      const replay = await runStorageLifecycle(pool, context.blobs, { ...policy(owner),
        now: () => new Date(Date.now() + 120_000), retryDelayMs: 1 });
      assert.equal(replay.failed, 0); assert.equal(replay.purged, 1);
      assert.deepEqual((await pool.query('SELECT * FROM bb_storage_purge_starts WHERE tombstone_id=$1', [start.tombstone_id])).rows, [durableStart],
        'retrying a missing Blob must preserve the first irreversible boundary');
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [target.runId])).rows[0].state, 'failed');
      // A definite Blob delete failure is also conservative: retained bytes do
      // not erase the committed start or permit a later recovery to revive pins.
      const deleteTarget = await failedFixture(), deleteMaterial = deleteTarget.first;
      const deleteRequest = await send('DELETE', `/api/v1/projects/${deleteTarget.projectId}/materials/${deleteMaterial.material_id}`);
      assert.equal(deleteRequest.statusCode, 204, deleteRequest.body);
      let deleteAttempted = false;
      const deleteFailure: PrivateBlobs = { ...context.blobs, delete: async key => {
        if (key === deleteMaterial.objectKey) { deleteAttempted = true; throw new Error('Synthetic Blob delete failure'); }
        await context.blobs.delete(key);
      } };
      const deleteResult = await runStorageLifecycle(pool, deleteFailure, { ...policy(owner), retryDelayMs: 1 });
      assert.equal(deleteResult.failed, 1); assert.equal(deleteResult.purged, 0); assert.equal(deleteAttempted, true);
      assert.equal(context.objects.has(deleteMaterial.objectKey), true);
      const deleteStart = (await pool.query(`SELECT s.* FROM bb_storage_purge_starts s
        JOIN bb_storage_tombstones tomb ON tomb.id=s.tombstone_id
        WHERE tomb.owner_user_id=$1 AND tomb.project_id=$2 AND tomb.material_id=$3`,
      [owner, deleteTarget.projectId, deleteMaterial.material_id])).rows[0];
      assert.ok(deleteStart);
      assert.equal((await pool.query('SELECT state,last_error_code FROM bb_storage_tombstones WHERE id=$1', [deleteStart.tombstone_id])).rows[0].state, 'pending');
      const beforeDeleteRecovery = await context.evidence();
      await assert.rejects(requeueGeneratedWordDelivery(pool, { runId: deleteTarget.runId, actor: 'synthetic-purge-delete-failed' }),
        (error: unknown) => error instanceof Problem && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT');
      assert.deepEqual(await context.evidence(), beforeDeleteRecovery);
      const deleteReplay = await runStorageLifecycle(pool, context.blobs, { ...policy(owner),
        now: () => new Date(Date.now() + 120_000), retryDelayMs: 1 });
      assert.equal(deleteReplay.failed, 0); assert.equal(deleteReplay.purged, 1);
      assert.equal(context.objects.has(deleteMaterial.objectKey), false);
      assert.deepEqual((await pool.query('SELECT * FROM bb_storage_purge_starts WHERE tombstone_id=$1', [deleteStart.tombstone_id])).rows, [deleteStart]);
    } finally {
      release.resolve();
      if (purge) await Promise.allSettled([purge]);
      await app.close(); await context.close();
    }
  });

test('material purge: staged SQL M4 producers, immutable starts and terminal resurrection fail closed',
  { skip: !stagedConnection, timeout: 90_000 }, async t => {
    const pool = new Pool({ connectionString: stagedConnection });
    try {
      for (const stage of ['legacy', 'canonical', 'job', 'subtype'] as const) await t.test(stage, async () => {
        const owner = `purge-stage-${randomUUID()}`, memory = memoryBlobs();
        const { app, send, ok } = server(pool, owner, memory.blobs);
        try {
          await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `purge_stage_${randomUUID().replaceAll('-', '').slice(0,12)}`]);
          const source = await seedProject(pool, owner), material = await seedMaterial(pool, memory.blobs, owner, source);
          const topic = (await ok('POST', '/api/v1/m4/topics', { creation_request_id: randomUUID(), name: 'Synthetic staged producer' })).topic;
          const runId = randomUUID(), jobId = randomUUID();
          // These are deliberately staged SQL writes, not a public API flow.
          // Every installed identity, bridge and lifecycle trigger stays enabled.
          const manifest = { version: 'm4-document-input-v1', kind: 'document', topic_id: topic.topic_id,
            billing_task: 'm4_D01', input: { ...emptyM4Draft('private_summary'), materials: [material.pin] } };
          const hash = inputManifestHash(manifest);
          await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
            VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [topic.project_id, owner, hash, manifest, JSON.stringify([material.pin])]);
          await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
            VALUES($1,$2,$3,1,$4,$5,'generation',$4,'queued')`, [runId, owner, topic.project_id, hash, randomUUID()]);
          const insertLegacy = () => pool.query(`INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash)
            VALUES($1,$2,$3,$4,$5)`, [runId, owner, topic.topic_id, manifest, hash]);
          const insertJob = (subtype: string) => pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
            VALUES($1,$2,$3,'generation',$4,'queued','queued')`, [jobId, owner, runId, subtype]);
          if (stage !== 'legacy') await insertLegacy();
          if (stage === 'legacy' || stage === 'subtype') await insertJob(stage === 'subtype' ? 'default' : 'm4_document_v1');
          assert.equal(await pinned(pool, owner, material.pin), false, `incomplete ${stage} fixture must not already retain the source`);
          const deleted = await send('DELETE', `/api/v1/projects/${source}/materials/${material.pin.material_id}`);
          assert.equal(deleted.statusCode, 204, deleted.body);
          const result = await runStorageLifecycle(pool, memory.blobs, policy(owner));
          assert.equal(result.failed, 0); assert.equal(result.purged, 1);
          assert.equal(memory.objects.has(material.key), false);
          const lateProducer = stage === 'legacy' ? insertLegacy
            : stage === 'canonical' ? () => pool.query(`INSERT INTO bb_m4_execution_snapshots
                (owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,topic_id,manifest,created_at)
                SELECT owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,topic_id,manifest,created_at
                FROM bb_m4_execution_snapshots WHERE run_id=$1 ON CONFLICT DO NOTHING`, [runId])
              : stage === 'job' ? () => insertJob('m4_document_v1')
                : () => pool.query("UPDATE bb_jobs SET subtype='m4_document_v1' WHERE id=$1", [jobId]);
          const businessState = async () => {
            const state: Record<string, unknown> = {};
            for (const table of ['bb_runs', 'bb_jobs', 'bb_m4_executions', 'bb_m4_execution_snapshots',
              'bb_run_execution_versions', 'bb_run_execution_heads', 'bb_run_events', 'bb_credit_events', 'bb_outbox'])
              state[table] = (await pool.query(`SELECT x.* FROM ${table} x WHERE owner_user_id=$1 ORDER BY to_jsonb(x)::text`, [owner])).rows;
            return state;
          };
          const before = await businessState();
          await assert.rejects(lateProducer(), constraint('bb_material_purge_barrier'));
          assert.deepEqual(await businessState(), before);
          assert.equal(await pinned(pool, owner, material.pin), false);
          const start = (await pool.query(`SELECT s.* FROM bb_storage_purge_starts s
            JOIN bb_storage_tombstones tomb ON tomb.id=s.tombstone_id WHERE tomb.owner_user_id=$1`, [owner])).rows[0];
          assert.ok(start); assert.equal(start.origin, 'verified_delete');
          await assert.rejects(pool.query('DELETE FROM bb_storage_purge_starts WHERE tombstone_id=$1', [start.tombstone_id]),
            constraint('bb_storage_purge_start_immutable'));
          await assert.rejects(pool.query('UPDATE bb_storage_purge_starts SET claim_attempt=claim_attempt+1 WHERE tombstone_id=$1', [start.tombstone_id]),
            constraint('bb_storage_purge_start_immutable'));
          await assert.rejects(pool.query(`INSERT INTO bb_storage_purge_starts(tombstone_id,claim_token,claim_attempt,origin,created_at)
            VALUES($1,NULL,1,'legacy_attempt',clock_timestamp()) ON CONFLICT DO NOTHING`, [start.tombstone_id]),
          constraint('bb_storage_purge_start_exact'));
          await assert.rejects(pool.query(`UPDATE bb_material_versions SET sha256=$2,object_key=object_key||'/rewritten'
            WHERE owner_user_id=$1 AND id=$3 AND version=1`, [owner, digest('synthetic rewritten bytes'), material.pin.material_id]),
          constraint('bb_material_byte_identity_immutable'));
          await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1", [runId]);
          const terminal = await businessState();
          await assert.rejects(pool.query("UPDATE bb_runs SET state='queued' WHERE id=$1", [runId]), constraint('bb_material_purge_barrier'));
          assert.deepEqual(await businessState(), terminal);
          assert.deepEqual((await pool.query('SELECT * FROM bb_storage_purge_starts WHERE tombstone_id=$1', [start.tombstone_id])).rows, [start]);
        } finally { await app.close(); }
      });
    } finally { await pool.end(); }
  });

test('material purge: verified starts reject wrong claims, wall-clock-expired leases, active pins and unsupported isolation',
  { skip: !stagedConnection, timeout: 60_000 }, async () => {
    const pool = new Pool({ connectionString: stagedConnection }), memory = memoryBlobs();
    const owner = `purge-claim-${randomUUID()}`, { app, send } = server(pool, owner, memory.blobs);
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, 'synthetic_purge_claim']);
      const project = await seedProject(pool, owner), material = await seedMaterial(pool, memory.blobs, owner, project);
      const runId = randomUUID(), manifest = { materials: [{ material_id: material.pin.material_id, material_version: 1 }] };
      const hash = inputManifestHash(manifest);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [project, owner, hash, manifest, JSON.stringify(manifest.materials)]);
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,1,$4,$5,'qa',$4,'queued')`, [runId, owner, project, hash, randomUUID()]);
      assert.equal(await pinned(pool, owner, material.pin), true);
      const deleted = await send('DELETE', `/api/v1/projects/${project}/materials/${material.pin.material_id}`);
      assert.equal(deleted.statusCode, 204, deleted.body);
      await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1", [runId]);
      await pool.query(`UPDATE bb_storage_tombstones SET eligible_at=clock_timestamp()
        WHERE owner_user_id=$1 AND object_kind='material'`, [owner]);
      let tombstone = (await pool.query(`UPDATE bb_storage_tombstones
        SET state='claimed',claim_token=$2,attempts=attempts+1,lease_until=clock_timestamp()+interval '1 minute'
        WHERE owner_user_id=$1 AND object_kind='material' RETURNING *`, [owner, randomUUID()])).rows[0];
      assert.ok(tombstone); assert.equal(await pinned(pool, owner, material.pin), false);
      const startSql = `INSERT INTO bb_storage_purge_starts(tombstone_id,claim_token,claim_attempt,origin,created_at)
        VALUES($1,$2,$3,'verified_delete',clock_timestamp())`;
      const startArgs = () => [tombstone.id, tombstone.claim_token, tombstone.attempts];
      const rejectStart = async (args: unknown[]) => {
        const before = (await pool.query('SELECT * FROM bb_storage_tombstones WHERE id=$1', [tombstone.id])).rows;
        await assert.rejects(pool.query(startSql, args), constraint('bb_storage_purge_start_exact'));
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_storage_purge_starts WHERE tombstone_id=$1', [tombstone.id])).rows[0].n, 0);
        assert.deepEqual((await pool.query('SELECT * FROM bb_storage_tombstones WHERE id=$1', [tombstone.id])).rows, before);
      };
      await rejectStart([tombstone.id, randomUUID(), tombstone.attempts]);
      await rejectStart([tombstone.id, tombstone.claim_token, tombstone.attempts + 1]);
      await pool.query("UPDATE bb_storage_tombstones SET state='pending',claim_token=NULL,lease_until=NULL WHERE id=$1", [tombstone.id]);
      tombstone = (await pool.query(`UPDATE bb_storage_tombstones
        SET state='claimed',claim_token=$2,attempts=attempts+1,lease_until=clock_timestamp()+interval '20 milliseconds'
        WHERE id=$1 RETURNING *`, [tombstone.id, randomUUID()])).rows[0];
      await until(async () => (await pool.query(`SELECT lease_until<=clock_timestamp() AS expired
        FROM bb_storage_tombstones WHERE id=$1`, [tombstone.id])).rows[0].expired ? true : undefined,
      'the deliberately short claim did not expire on the database wall clock');
      await rejectStart(startArgs());
      await pool.query("UPDATE bb_storage_tombstones SET state='pending',claim_token=NULL,lease_until=NULL WHERE id=$1", [tombstone.id]);
      tombstone = (await pool.query(`UPDATE bb_storage_tombstones
        SET state='claimed',claim_token=$2,attempts=attempts+1,lease_until=clock_timestamp()+interval '1 minute'
        WHERE id=$1 RETURNING *`, [tombstone.id, randomUUID()])).rows[0];
      await pool.query("UPDATE bb_runs SET state='queued' WHERE id=$1", [runId]);
      assert.equal(await pinned(pool, owner, material.pin), true);
      await rejectStart(startArgs());
      await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1", [runId]);
      await rejectsRepeatableRead(pool, client => client.query('SELECT bb_assert_material_lifecycle_available($1,$2,1)', [owner, project]));
      await rejectsRepeatableRead(pool, client => client.query("UPDATE bb_runs SET state='queued' WHERE id=$1", [runId]));
      await rejectsRepeatableRead(pool, client => client.query(startSql, startArgs()));
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [runId])).rows[0].state, 'failed');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_storage_purge_starts WHERE tombstone_id=$1', [tombstone.id])).rows[0].n, 0);
      await pool.query(startSql, startArgs());
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_storage_purge_starts WHERE tombstone_id=$1', [tombstone.id])).rows[0].n, 1);
      assert.equal(memory.objects.has(material.key), true, 'direct SQL starts must not perform Blob I/O');
    } finally { await app.close(); await pool.end(); }
  });

test('material purge: staged SQL producers lock valid missing-row tuples before later material creation and deletion',
  { skip: !stagedConnection, timeout: 90_000 }, async t => {
    const pool = new Pool({ connectionString: stagedConnection, max: 12 });
    try {
      for (const surface of ['material_versions', 'manifest.materials', 'm4-document-input-v1', 'm4-qa-input-v1'] as const)
        await t.test(surface, async () => {
          const owner = `purge-absent-${randomUUID()}`, memory = memoryBlobs();
          const { app, ok } = server(pool, owner, memory.blobs), producer = await pool.connect();
          let held = false, purge: ReturnType<typeof runStorageLifecycle> | undefined;
          try {
            await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',
              [owner, `purge_absent_${randomUUID().replaceAll('-', '').slice(0,12)}`]);
            const isM4 = surface.startsWith('m4-');
            const topic = isM4 ? (await ok('POST', '/api/v1/m4/topics', {
              creation_request_id: randomUUID(), name: 'Synthetic absent-material producer',
            })).topic : null;
            const project = topic?.project_id ?? await seedProject(pool, owner);
            const source = isM4 ? await seedProject(pool, owner) : project, materialId = randomUUID();
            const sha256 = digest(makeSyntheticDocxFixture({ text: `Synthetic purge barrier ${materialId}` }));
            const pin: M4MaterialPin = { source_project_id: source, material_id: materialId, material_version: 1, sha256 };
            const neverCreated = { ...pin, material_id: randomUUID(), sha256: digest('synthetic material never created') };
            const invalidHashId = randomUUID(), invalidSourceId = randomUUID();
            const invalidRefs: unknown[] = [null, true, 'not-a-pin', [], {},
              { material_id: 7, material_version: 1 }, { material_id: randomUUID() },
              ...['1', null, false, 0, -1, 1.5, 2_147_483_648, 1e100].map(material_version =>
                ({ material_id: randomUUID(), material_version }))];
            // Empty IDs remain speculative string tuples at this SQL layer. The
            // lifecycle lock must not introduce a new public input-shape gate.
            const refs = [pin, pin, neverCreated, { material_id: '', material_version: 1 }, ...invalidRefs,
              ...(isM4 ? [
                { ...pin, material_id: invalidHashId, sha256: 'not-a-hash' },
                { ...pin, material_id: invalidSourceId, source_project_id: 7 },
              ] : [])];
            const manifest: any = surface === 'm4-document-input-v1'
              ? { version: surface, kind: 'document', topic_id: topic.topic_id, billing_task: 'm4_D01',
                input: { ...emptyM4Draft('private_summary'), materials: [pin, neverCreated] } }
              : surface === 'm4-qa-input-v1'
                ? { version: surface, kind: 'qa', topic_id: topic.topic_id, billing_task: 'm4_Q01',
                  content: 'Synthetic absent-material question', context: {}, context_snapshot: {}, materials: [pin, neverCreated] }
                : { materials: surface === 'manifest.materials' ? refs : [] };
            const materialRefs = surface === 'manifest.materials' ? [] : refs;
            const hash = inputManifestHash(manifest), runId = randomUUID();
            await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
              VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [project, owner, hash, manifest, JSON.stringify(materialRefs)]);
            assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
            const keys = (await pool.query(`SELECT DISTINCT source_project_id,material_id,material_version,lifecycle_key
              FROM bb_material_lifecycle_input_keys($1,$2,1)`, [owner, project])).rows;
            const tuple = (value: { source_project_id: string; material_id: string; material_version: number }) =>
              JSON.stringify([value.source_project_id, value.material_id, value.material_version]);
            const expected = [tuple({ ...pin, source_project_id: project }),
              tuple({ ...neverCreated, source_project_id: project }),
              tuple({ source_project_id: project, material_id: '', material_version: 1 }),
              ...(isM4 ? [tuple(pin), tuple(neverCreated), tuple({ ...pin, source_project_id: project, material_id: invalidHashId }),
                tuple({ ...pin, source_project_id: project, material_id: invalidSourceId })] : [])];
            assert.deepEqual(keys.map(tuple).sort(), expected.sort(),
              'only well-formed version tuples lock; malformed M4 hash/source must not create cross-project candidates');
            await producer.query('BEGIN'); held = true;
            const producerPid = (await producer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const insertProducer = async (db: PoolClient, revision: number, inputHash: string, inputManifest: any, id: string) => {
              await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
                VALUES($1,$2,$3,$4,$5,$6,$7,$5,'queued')`,
              [id, owner, project, revision, inputHash, randomUUID(), surface === 'm4-document-input-v1' ? 'generation' : 'qa']);
              if (isM4) {
                await db.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',
                  [id, owner, topic.topic_id, inputManifest, inputHash]);
                await db.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
                  VALUES($1,$2,$3,$4,$5,'queued','queued')`, [randomUUID(), owner, id,
                  surface === 'm4-document-input-v1' ? 'generation' : 'qa',
                  surface === 'm4-document-input-v1' ? 'm4_document_v1' : 'm4_qa_v1']);
              }
            };
            await insertProducer(producer, 1, hash, manifest, runId);
            for (const key of keys) {
              const lock = (await pool.query(`SELECT bb_material_lifecycle_lock_key($1,$2,$3,$4) AS lifecycle_key,
                pg_try_advisory_xact_lock(bb_material_lifecycle_lock_key($1,$2,$3,$4)) AS acquired`,
              [owner, key.source_project_id, key.material_id, key.material_version])).rows[0];
              assert.equal(lock.lifecycle_key, key.lifecycle_key); assert.equal(lock.acquired, false,
                'the producer must hold each exact tuple even before any material row exists');
            }
            assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
            const created = await seedMaterial(pool, memory.blobs, owner, source, materialId);
            assert.deepEqual(created.pin, pin);
            // This race is a staged SQL fixture: the late material writer uses
            // the real immutable row/deletion triggers, without pretending API
            // validation accepted an absent material or disabling any guard.
            await pool.query('UPDATE bb_material_versions SET deleted_at=clock_timestamp() WHERE owner_user_id=$1 AND id=$2 AND version=1', [owner, materialId]);
            purge = runStorageLifecycle(pool, memory.blobs, policy(owner)); void purge.catch(() => {});
            await until(async () => (await pool.query(`SELECT pid FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'
                AND $1::integer=ANY(pg_blocking_pids(pid))`, [producerPid])).rows[0]?.pid,
            'the purger did not wait for the producer that locked the absent tuple');
            assert.equal(memory.reads.length, 0); assert.equal(memory.deletes.length, 0);
            assert.equal((await pool.query(`SELECT count(*)::int n FROM bb_storage_purge_starts s
              JOIN bb_storage_tombstones tomb ON tomb.id=s.tombstone_id WHERE tomb.owner_user_id=$1`, [owner])).rows[0].n, 0);
            await producer.query('COMMIT'); held = false;
            const result = await purge;
            assert.equal(result.failed, 0); assert.equal(result.purged, 0); assert.equal(result.pinned, 1);
            assert.equal(await pinned(pool, owner, pin), true); assert.equal(memory.objects.has(created.key), true);
            assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND id=$2',
              [owner, neverCreated.material_id])).rows[0].n, 0);
            assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [runId])).rows[0].state, 'queued',
              'well-formed missing references must remain admissible through producer commit');
            assert.equal(memory.reads.length, 0); assert.equal(memory.deletes.length, 0);
            if (isM4) {
              await pool.query("UPDATE bb_jobs SET state='failed' WHERE run_id=$1", [runId]);
              await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1", [runId]);
              const deleted = await runStorageLifecycle(pool, memory.blobs, policy(owner));
              assert.equal(deleted.failed, 0); assert.equal(deleted.purged, 1);
              const wrongPin = { ...pin, sha256: digest('synthetic wrong but well-formed hash') };
              assert.notEqual(wrongPin.sha256, pin.sha256);
              const wrongManifest = surface === 'm4-document-input-v1'
                ? { ...manifest, input: { ...manifest.input, materials: [wrongPin] } }
                : { ...manifest, materials: [wrongPin] };
              const wrongHash = inputManifestHash(wrongManifest), wrongRun = randomUUID();
              await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
                VALUES($1,2,$2,1,$3,$4,$5,'[]')`, [project, owner, wrongHash, wrongManifest, JSON.stringify([wrongPin])]);
              await transaction(pool, db => insertProducer(db, 2, wrongHash, wrongManifest, wrongRun));
              assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [wrongRun])).rows[0].state, 'queued',
                'a speculative cross-project lock must not turn a nonmatching hash into a new admission gate');
              assert.equal(await pinned(pool, owner, pin), false); assert.equal(memory.objects.has(created.key), false);
            }
          } finally {
            if (held) await producer.query('ROLLBACK');
            producer.release();
            if (purge) await Promise.allSettled([purge]);
            await app.close();
          }
        });
    } finally { await pool.end(); }
  });
