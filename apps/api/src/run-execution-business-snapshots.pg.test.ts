import {removeReviewArtifactExecutionScaffold} from './review-artifact-migration-test-fixture.js';
// Synthetic inputs; real PostgreSQL transactions, migration and exact readers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { readRunExecutionInput } from './run-execution-input.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'execution-business-snapshots');
const migration = await readFile(new URL('../../../db/migrations/0124_run_execution_business_snapshots.sql', import.meta.url), 'utf8');
type Kind = 'review' | 'review_result' | 'm4' | 'm4_qa';
async function fixture(db: Pool | PoolClient, kind: Kind, fractionalEncoding = false) {
  const owner = uid(), projectId = uid(), runId = uid(), topicId = uid(), createdAt = '2026-10-20T01:02:03.000Z';
  await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `bs_${uid().replaceAll('-', '').slice(0, 20)}`]);
  await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic immutable business snapshots',$3)",
    [projectId, owner, kind.startsWith('m4') ? 'generation' : 'review']);
  const pin = { material_id: uid(), material_version: 1, sha256: 'a'.repeat(64) };
  const input = { source_material_ref: pin, material_versions: [pin], requirements: ['Frozen requirement'], as_of: null };
  const origin = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null };
  const snapshot: Record<string, any> = { input, input_version: 4, finding_ids: [], plan: null, origin, context_messages: [] };
  let manifest: Record<string, any> = { materials: [{ ...pin, role: 'other' }], review: { version: 'review_v1',
    operation: 'full_review', version_number: 7, report_id: uid(), source_report_id: null, source_report_sha256: null,
    finding_ids: [], input, origin } };
  if (kind === 'review_result') {
    const sourceRunId = uid(); snapshot.source_run_id = sourceRunId;
    manifest = { materials: [{ ...pin, role: 'other' }], authoring: { version: 'unified_v1', review_result: {
      version: 'review-result-v1', run_id: sourceRunId, input_revision: 1, input_hash: 'b'.repeat(64),
      artifact_id: uid(), artifact_version: 1, sha256: 'c'.repeat(64), source_material: pin, requirements: 'Frozen requirement',
    } } };
  }
  if (kind.startsWith('m4')) {
    await db.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash)
      VALUES($1,$2,$3,'Synthetic topic',$4,$5)`, [topicId, owner, projectId, uid(), 'd'.repeat(64)]);
    manifest = kind === 'm4' ? { version: 'm4-document-input-v1', kind: 'document', topic_id: topicId,
      execution_scope_project_id: projectId, draft_version: 1, market: 'sse', offering: 'private', billing_task: 'm4_G05',
      template_material: null, input: { document_type: 'private_summary', source_material: { ...pin, source_project_id: projectId },
        materials: [], template: null, edit_base: null, scope: 'whole', fields: {}, requirements: [] } }
      : { version: 'm4-qa-input-v1', kind: 'qa', topic_id: topicId, message_id: uid(), content: 'Synthetic frozen question',
        context: { document_type: null, draft_version: 0, source_material: null, citations: [], reading_artifact: null },
        context_snapshot: { draft: null, messages: [] }, materials: [], billing_task: 'm4_Q01' };
  }
  const hash = inputManifestHash(manifest), taskKind = kind === 'm4' ? 'generation' : kind === 'm4_qa' ? 'qa' : kind === 'review' ? 'review' : 'update';
  // PostgreSQL retains JSONB numeric scale although JavaScript parses 1.0 as 1.
  const storedJson = (value: unknown) => fractionalEncoding
    ? JSON.stringify(value).replace(/"material_version":1(?=[,}])/g, '"material_version":1.0') : value;
  await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [projectId, owner, hash, storedJson(manifest), JSON.stringify(manifest.materials ?? [])]);
  await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,'paused','user_paused')`, [runId, owner, projectId, hash, uid(), taskKind, 'e'.repeat(64)]);
  const insert = async (change: Record<string, any> = {}) => {
    if (kind.startsWith('m4')) return db.query(`INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [runId, change.owner ?? owner, change.topicId ?? topicId,
      storedJson(change.manifest ?? manifest), change.inputHash ?? hash, createdAt]);
    return db.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot,created_at)
      VALUES($1,$2,$3,$4,$5,NULL,$6,$7)`, [runId, change.owner ?? owner, change.projectId ?? projectId,
      change.version ?? 7, change.operation ?? (kind === 'review' ? 'full_review' : 'revision'), storedJson(change.snapshot ?? snapshot), createdAt]);
  };
  return { owner, projectId, runId, topicId, manifest, snapshot, hash, createdAt, insert,
    identity: { executionVersion: 1, inputRevision: 1, inputHash: hash } };
}
const conflict = (error: unknown) => (error as { code?: string }).code === 'INPUT_REVISION_CONFLICT';
const rejectedWrite = (error: unknown) => ['23502', '23503', '23514', 'P0002'].includes((error as { code: string }).code);

// Only the disposable clone is altered, so replay tests can exercise the actual
// migration against pre-0124 legacy records without changing migration history.
async function removeScaffold(db: Pool | PoolClient) {
  await removeReviewArtifactExecutionScaffold(db);
  await db.query(`DROP TABLE IF EXISTS bb_review_execution_reports CASCADE;
    DROP FUNCTION IF EXISTS bb_bridge_review_execution_report(),bb_check_review_execution_report(),bb_review_report_storage_shape(jsonb) CASCADE;
    DROP TABLE IF EXISTS bb_review_execution_editors CASCADE;
    DROP FUNCTION IF EXISTS bb_bridge_review_execution_editor(),bb_check_review_execution_editor() CASCADE;
    DROP FUNCTION IF EXISTS bb_review_editor_snapshot_shape(jsonb),bb_review_editor_canonical_json(jsonb) CASCADE;
    ALTER TABLE bb_review_execution_snapshots DROP CONSTRAINT IF EXISTS bb_review_execution_snapshot_editor_key;
    DROP TABLE bb_review_execution_snapshots,bb_m4_execution_snapshots CASCADE;
    DROP FUNCTION bb_bridge_review_execution_snapshot(),bb_bridge_m4_execution_snapshot() CASCADE;
    DROP FUNCTION bb_check_review_execution_snapshot(),bb_check_m4_execution_snapshot() CASCADE;
    DROP FUNCTION bb_execution_review_input_shape(jsonb),bb_execution_id_array_shape(jsonb),
      bb_execution_material_array_shape(jsonb,boolean),bb_execution_material_pin_shape(jsonb,boolean) CASCADE;`);
}

test('all legacy business inserts bridge complete exact snapshots; actual reader preserves fields and original timestamps',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const kind of ['review', 'review_result', 'm4', 'm4_qa'] as const) {
      const f = await fixture(pool, kind);
      const before = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows[0];
      await f.insert();
      const result = await readRunExecutionInput(pool, f.owner, f.runId, f.identity);
      const saved = kind.startsWith('m4') ? result.m4Execution! : result.reviewExecution!;
      assert.equal(saved.owner_user_id, f.owner); assert.equal(saved.project_id, f.projectId); assert.equal(saved.run_id, f.runId);
      assert.equal(saved.execution_version, 1); assert.equal(saved.input_revision, 1); assert.equal(saved.input_hash.trim(), f.hash);
      assert.equal(new Date(saved.created_at).toISOString(), f.createdAt);
      if (kind.startsWith('m4')) assert.deepEqual(result.m4Execution!.manifest, f.manifest);
      else { assert.equal(result.reviewExecution!.version, 7); assert.deepEqual(result.reviewExecution!.snapshot, f.snapshot); }
      assert.deepEqual((await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows[0], before);
    }
  });

test('a bad bridge aborts the legacy insert instead of dropping or fabricating a snapshot',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const changes = [
      ['review', { version: 8 }], ['review', { operation: 'revision' }], ['review', { snapshot: [] }],
      ['review', { snapshot: { input: {}, finding_ids: [] } }],
      ['m4', { inputHash: '0'.repeat(64) }], ['m4', { manifest: [] }],
    ] as const;
    for (const [kind, change] of changes) {
      const f = await fixture(pool, kind);
      await assert.rejects(f.insert(change), rejectedWrite);
      const tables = kind === 'm4' ? ['bb_m4_executions', 'bb_m4_execution_snapshots'] : ['bb_review_executions', 'bb_review_execution_snapshots'];
      for (const table of tables) assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE run_id=$1`, [f.runId])).rowCount, 0);
    }
    for (const kind of ['review', 'm4'] as const) {
      const f = await fixture(pool, kind), other = await fixture(pool, kind);
      await assert.rejects(f.insert(kind === 'm4' ? { topicId: other.topicId } : { projectId: other.projectId }), rejectedWrite);
    }
  });

test('versioned snapshots are immutable and cannot borrow another owner, input, timestamp or executable V2',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const kind of ['review', 'm4'] as const) {
      const f = await fixture(pool, kind); await f.insert();
      const table = kind === 'm4' ? 'bb_m4_execution_snapshots' : 'bb_review_execution_snapshots';
      await assert.rejects(pool.query(`UPDATE ${table} SET input_hash=input_hash WHERE run_id=$1`, [f.runId]), rejectedWrite);
      await assert.rejects(pool.query(`DELETE FROM ${table} WHERE run_id=$1`, [f.runId]), rejectedWrite);
      if (kind === 'review') await assert.rejects(pool.query(`INSERT INTO bb_review_execution_snapshots
        SELECT owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,version,operation,source_report_id,snapshot,created_at+interval '1 second'
        FROM bb_review_execution_snapshots WHERE run_id=$1`, [f.runId]), rejectedWrite);
      else await assert.rejects(pool.query(`INSERT INTO bb_m4_execution_snapshots
        SELECT owner_user_id,project_id,run_id,execution_version,input_revision,$2,topic_id,manifest,created_at
        FROM bb_m4_execution_snapshots WHERE run_id=$1`, [f.runId, '0'.repeat(64)]), rejectedWrite);
      await assert.rejects(pool.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
        VALUES($1,$2,$3,2,1,$4)`, [f.owner, f.projectId, f.runId, f.hash]), rejectedWrite);
    }
  });

test('missing canonical snapshots fail closed even when valid legacy records still exist',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const kind of ['review', 'review_result', 'm4'] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); const f = await fixture(client, kind);
        const table = kind === 'm4' ? 'bb_m4_executions' : 'bb_review_executions';
        const trigger = kind === 'm4' ? 'bb_m4_execution_snapshot_bridge' : 'bb_review_execution_snapshot_bridge';
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`); await f.insert();
        await assert.rejects(readRunExecutionInput(client, f.owner, f.runId, f.identity), conflict);
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
  });

test('a legacy insert without its exact initial execution fails rather than silently skipping the bridge',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const kind of ['review', 'm4'] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); const f = await fixture(client, kind);
        // Clear valid newly inserted head events before disabling the guard.
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query('ALTER TABLE bb_run_execution_versions DISABLE TRIGGER bb_run_execution_immutable');
        await client.query('DELETE FROM bb_run_execution_versions WHERE run_id=$1', [f.runId]);
        // The outer rollback restores both origin and guard without DDL over
        // intentionally invalid deferred head FK events.
        await assert.rejects(f.insert(), rejectedWrite);
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
  });

test('actual migration backfills exact legacy V1 content and rejects mismatched or missing historical identity',
  { skip: !connection, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'execution-business-backfill');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    for (const mode of ['valid', 'numeric_representation', 'mismatched', 'missing'] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await removeScaffold(client);
        const review = await fixture(client, 'review', mode === 'numeric_representation'), m4 = await fixture(client, 'm4', mode === 'numeric_representation');
        await review.insert(mode === 'mismatched' ? { version: 8 } : {}); await m4.insert();
        if (mode === 'missing') {
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
          await client.query('SET CONSTRAINTS ALL DEFERRED');
          await client.query('ALTER TABLE bb_run_execution_versions DISABLE TRIGGER bb_run_execution_immutable');
          await client.query('DELETE FROM bb_run_execution_versions WHERE run_id=$1', [review.runId]);
          // The outer rollback restores the disabled guard with the origin.
        }
        if (mode === 'mismatched' || mode === 'missing') await assert.rejects(client.query(migration), rejectedWrite);
        else {
          await client.query(migration);
          assert.deepEqual((await readRunExecutionInput(client, review.owner, review.runId, review.identity)).reviewExecution!.snapshot, review.snapshot);
          const saved = (await readRunExecutionInput(client, m4.owner, m4.runId, m4.identity)).m4Execution!;
          assert.deepEqual(saved.manifest, m4.manifest); assert.equal(new Date(saved.created_at).toISOString(), m4.createdAt);
        }
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
  });

test('storage pin checks accept integral JSONB numbers regardless of scale and reject nonpositive or fractional values',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const [value, valid] of [['1', true], ['1.0', true], ['1e2', true], ['0', false], ['-1', false],
      ['1.5', false], ['"1"', false], ['null', false], ['[]', false]] as const) {
      const pin = `{"material_id":"synthetic","material_version":${value},"sha256":"${'a'.repeat(64)}"}`;
      assert.equal((await pool.query('SELECT bb_execution_material_pin_shape($1::jsonb) AS valid', [pin])).rows[0].valid, valid, value);
    }
  });

test('migration drains topic row lockers before locking inputs, so an in-flight M4 creator can finish',
  { skip: !connection, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'execution-business-lock-order');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    await removeScaffold(pool); const f = await fixture(pool, 'm4'); await f.insert();
    const writer = await pool.connect(), migrator = await pool.connect();
    let pending: Promise<{ error?: unknown }> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout='1500ms'");
      await writer.query('SELECT id FROM bb_m4_topics WHERE id=$1 FOR UPDATE', [f.topicId]);
      await migrator.query('BEGIN'); await migrator.query("SET LOCAL statement_timeout='10000ms'");
      const pid = Number((await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      pending = migrator.query(migration).then(() => ({}), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='bb_m4_topics'::regclass
          AND mode='ExclusiveLock' AND NOT granted`, [pid])).rowCount === 1;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, 'migration must first wait for the owned topic row locker');
      assert.equal((await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='bb_input_revisions'::regclass AND granted`, [pid])).rowCount, 0);
      await writer.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,1,$3,$4,'[]','[]')`, [f.projectId, f.owner, f.hash, f.manifest]);
      await writer.query('COMMIT'); const result = await pending; assert.equal(result.error, undefined);
      await migrator.query('COMMIT');
      assert.deepEqual((await readRunExecutionInput(pool, f.owner, f.runId, f.identity)).m4Execution!.manifest, f.manifest);
    } finally {
      await writer.query('ROLLBACK'); await migrator.query('ROLLBACK');
      if (pending) await pending; writer.release(); migrator.release();
    }
  });
