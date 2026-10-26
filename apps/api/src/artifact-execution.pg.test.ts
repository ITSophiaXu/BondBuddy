// Synthetic bytes and inputs; real PostgreSQL bridges, migration and promoters.
// Schema removal/corruption below is confined to disposable private clones.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { digest, transaction, uid, type PrivateBlobs } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { completeM4Qa } from './m4-workspace.js';
import { inputManifestHash } from './production-rule-pin.js';
import { promoteReviewPdfArtifact, promoteWordArtifact, type Lease } from './queue.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'artifact-execution');
const migration = await readFile(new URL('../../../db/migrations/0125_artifact_execution_bindings.sql', import.meta.url), 'utf8');
const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const createdAt = '2026-10-20T01:02:03.000Z';
const rejectedWrite = (error: unknown) => ['23502', '23503', '23514', 'P0002'].includes((error as { code: string }).code);
type Db = Pool | PoolClient;

async function fixture(db: Db, kind: 'word' | 'review' | 'qa' = 'word') {
  const owner = uid(), projectId = uid(), runId = uid(), jobId = uid(), topicId = uid(), messageId = uid(), token = uid();
  await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `ae_${uid().replaceAll('-', '').slice(0, 20)}`]);
  await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic artifact origin',$3)",
    [projectId, owner, kind === 'qa' ? 'generation' : kind === 'review' ? 'review' : 'update']);
  const pin = { material_id: uid(), material_version: 1, sha256: 'a'.repeat(64) };
  const reviewInput = { source_material_ref: pin, material_versions: [pin], requirements: [], as_of: null };
  const origin = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null };
  const context = { document_type: null, draft_version: 0, source_material: null, citations: [], reading_artifact: null };
  let manifest: Record<string, any> = { synthetic: true, revision: 2 };
  if (kind === 'review') manifest = { materials: [{ ...pin, role: 'other' }], review: { version: 'review_v1',
    operation: 'full_review', version_number: 1, report_id: uid(), source_report_id: null, source_report_sha256: null,
    finding_ids: [], input: reviewInput, origin } };
  if (kind === 'qa') {
    await db.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash)
      VALUES($1,$2,$3,'Synthetic topic',$4,$5)`, [topicId, owner, projectId, uid(), digest(uid())]);
    manifest = { version: 'm4-qa-input-v1', kind: 'qa', topic_id: topicId, message_id: messageId, content: 'Synthetic question',
      context, context_snapshot: { draft: null, messages: [] }, materials: [], billing_task: 'm4_Q01' };
  }
  const hash = inputManifestHash(manifest);
  for (const revision of [1, 2, 3]) {
    const input = revision === 2 ? manifest : { synthetic: true, revision };
    await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,$3,1,$4,$5,'[]','[]')`, [projectId, revision, owner, inputManifestHash(input), input]);
  }
  await db.query('UPDATE bb_projects SET latest_input_revision=3 WHERE id=$1', [projectId]);
  const taskKind = kind === 'review' ? 'review' : kind === 'qa' ? 'qa' : 'update';
  await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,2,$4,$5,$6,$7,'running','word_delivery')`, [runId, owner, projectId, hash, uid(), taskKind, digest(uid())]);
  await db.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
    VALUES($1,$2,$3,$4,$5,'running','word_delivery',$6,now()+interval '10 minutes',1)`,
  [jobId, owner, runId, taskKind, kind === 'qa' ? 'm4_qa_v1' : 'default', token]);
  if (kind === 'review') await db.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
    VALUES($1,$2,$3,1,'full_review',$4)`, [runId, owner, projectId,
    { input: reviewInput, input_version: 1, finding_ids: [], plan: null, origin, context_messages: [] }]);
  if (kind === 'qa') {
    await db.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',
      [runId, owner, topicId, manifest, hash]);
    await db.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,run_id,reply_status)
      VALUES($1,$2,$3,'user','Synthetic question',$4,$5,'running')`, [messageId, owner, topicId, context, runId]);
  }
  const lease: Lease = { owner, runId, jobId, token, checkpoint: {}, attempts: 1, executionVersion: 1, inputRevision: 2, inputHash: hash };
  return { owner, projectId, runId, jobId, topicId, hash, lease };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function rawArtifact(db: Db, f: Fixture, options: { version?: number; mediaType?: string; rejected?: boolean } = {}) {
  const artifactId = uid(), version = options.version ?? 1;
  await db.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [artifactId, version, f.owner, f.runId, options.mediaType ?? wordType,
    digest(artifactId), `users/${f.owner}/runs/${f.runId}/artifacts/${artifactId}/v${version}`, options.rejected ? 'failed' : 'pending',
    options.rejected ? 'revoked' : 'pending', createdAt]);
  return { artifactId, version };
}
async function assertBinding(db: Db, f: Fixture, artifactId: string, version = 1) {
  const artifact = (await db.query('SELECT * FROM bb_artifact_versions WHERE id=$1 AND version=$2', [artifactId, version])).rows[0];
  const rows = (await db.query('SELECT * FROM bb_artifact_execution_bindings WHERE artifact_id=$1 AND artifact_version=$2', [artifactId, version])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { artifact_id: artifactId, artifact_version: version, owner_user_id: f.owner,
    project_id: f.projectId, run_id: f.runId, execution_version: 1, input_revision: 2, input_hash: f.hash, created_at: artifact.created_at });
  assert.deepEqual((await db.query('SELECT * FROM bb_execution_artifact_versions WHERE id=$1 AND version=$2', [artifactId, version])).rows, [artifact]);
  return rows[0];
}
function memoryBlobs(): PrivateBlobs {
  const values = new Map<string, Buffer>();
  return { put: async (key, bytes) => { values.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes = values.get(key); assert.ok(bytes); return bytes; },
    getIfExists: async key => values.get(key) ?? null,
    getIfExistsBounded: async (key, max) => { const bytes = values.get(key); if (bytes && bytes.length > max) throw Error('bounded synthetic read'); return bytes ?? null; },
    exists: async key => values.has(key), delete: async key => { values.delete(key); } };
}
async function removeScaffold(db: Db) {
  // Recreate 0125 on its real predecessor schema, only inside private clones.
  // Later delivery FKs and triggers must leave together, not as a half-schema.
  await db.query(`DROP VIEW IF EXISTS bb_run_execution_delivery_artifact_details CASCADE;
    DROP TABLE IF EXISTS bb_run_execution_delivery_artifacts,bb_run_execution_deliveries,bb_run_execution_delivery_gaps CASCADE;
    DROP FUNCTION IF EXISTS bb_capture_terminal_execution_delivery() CASCADE;
    DROP FUNCTION IF EXISTS bb_capture_run_execution_delivery(text,text,text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_capture_m4_durable_delivery(text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_check_run_execution_delivery() CASCADE;
    DROP FUNCTION IF EXISTS bb_check_run_execution_delivery_artifact() CASCADE;
    DROP FUNCTION IF EXISTS bb_run_execution_delivery_plan(text,text,text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_execution_delivery_artifact_ready(bb_artifact_versions,text,timestamptz) CASCADE;
    DROP TABLE bb_artifact_execution_bindings CASCADE;
    DROP FUNCTION bb_bind_artifact_execution() CASCADE;
    DROP FUNCTION bb_check_artifact_execution_binding() CASCADE;
    DROP FUNCTION bb_guard_artifact_execution_identity() CASCADE;
    ALTER TABLE bb_artifact_versions DROP CONSTRAINT bb_artifact_owned_run_version_key;`);
}

test('artifact inserts bind all statuses, media and artifact versions to the original V1 input rather than the newest draft',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), original = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows[0];
    for (const options of [{ version: 3 }, { version: 7, rejected: true }, { mediaType: 'application/pdf' }, { mediaType: 'text/plain' }]) {
      const a = await rawArtifact(pool, f, options); await assertBinding(pool, f, a.artifactId, a.version);
    }
    assert.deepEqual((await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows[0], original);
    assert.equal((await pool.query('SELECT latest_input_revision FROM bb_projects WHERE id=$1', [f.projectId])).rows[0].latest_input_revision, 3);
  });

test('real Word rejection/pending/readback transitions, review PDF and M4 text writers retain their first exact binding',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), pendingBindings: unknown[] = [];
    const observingBlobs: PrivateBlobs = { ...blobs, put: async (key, bytes, mediaType) => {
      const a = (await pool.query('SELECT * FROM bb_artifact_versions WHERE object_key=$1', [key])).rows[0];
      assert.equal(a.delivery_status, 'pending'); pendingBindings.push(await assertBinding(pool, f, a.id, a.version));
      await blobs.put(key, bytes, mediaType);
    } };
    const bytes = makeSyntheticDocxFixture({ text: 'Synthetic provenance Word' });
    const available = await promoteWordArtifact(pool, f.lease, bytes, observingBlobs, 'generated_pair_v1');
    assert.equal(available.status, 'available'); assert.equal(pendingBindings.length, 1);
    const binding = await assertBinding(pool, f, available.artifactId);
    assert.deepEqual(await assertBinding(pool, f, available.artifactId), pendingBindings[0]);
    assert.equal((await promoteWordArtifact(pool, f.lease, bytes, blobs, 'generated_pair_v1')).artifactId, available.artifactId);
    assert.deepEqual(await assertBinding(pool, f, available.artifactId), binding);
    const rejected = await promoteWordArtifact(pool, f.lease, Buffer.from('Synthetic invalid Word'), blobs);
    assert.equal(rejected.status, 'rejected'); await assertBinding(pool, f, rejected.artifactId);
    const unavailable = await promoteWordArtifact(pool, f.lease, makeSyntheticDocxFixture({ text: 'Synthetic missing readback' }),
      { ...blobs, getIfExistsBounded: async () => null }, 'generated_pair_v1');
    assert.equal(unavailable.status, 'unavailable'); await assertBinding(pool, f, unavailable.artifactId);
    await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1", [available.artifactId]);
    assert.deepEqual(await assertBinding(pool, f, available.artifactId), binding);
    const review = await fixture(pool, 'review');
    const pdf = await promoteReviewPdfArtifact(pool, review.lease, Buffer.from('%PDF-1.7\nSynthetic provenance overlay'), blobs);
    assert.equal(pdf.status, 'available'); if (pdf.status !== 'available') return;
    await assertBinding(pool, review, pdf.artifactId, pdf.artifactVersion);
    const qa = await fixture(pool, 'qa');
    const answer = await transaction(pool, c => completeM4Qa(c, qa.owner, qa.runId, { content: 'Synthetic retained answer',
      citations: [], requirements: [], fields: {}, intent: 'answer', document_type: null, target_business: null, retrieval: 'not_performed' }));
    await assertBinding(pool, qa, answer.artifactId, answer.artifactVersion);
    assert.equal((await pool.query('SELECT 1 FROM bb_m4_artifacts WHERE run_id=$1 AND artifact_id=$2', [qa.runId, answer.artifactId])).rowCount, 1);
  });

test('bindings reject foreign ownership, run, input, artifact identity, timestamp and V2; both source and file identity are immutable',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), foreign = await fixture(pool), a = await rawArtifact(pool, f), before = await assertBinding(pool, f, a.artifactId);
    const insert = `INSERT INTO bb_artifact_execution_bindings(artifact_id,artifact_version,owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    const values = [a.artifactId, 1, f.owner, f.projectId, f.runId, 1, 2, f.hash, createdAt];
    for (const [index, value] of [[0, uid()], [1, 2], [2, foreign.owner], [3, foreign.projectId], [4, foreign.runId],
      [5, 2], [6, 3], [7, 'f'.repeat(64)], [8, '2026-10-20T01:02:04.000Z']] as const) {
      const changed = [...values]; changed[index] = value;
      await assert.rejects(pool.query(insert, changed), { code: '23514', constraint: 'bb_artifact_execution_exact' });
    }
    for (const sql of ['UPDATE bb_artifact_execution_bindings SET input_hash=input_hash WHERE artifact_id=$1',
      'DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1']) await assert.rejects(pool.query(sql, [a.artifactId]), rejectedWrite);
    const assignments = ["id=id||'-moved'", 'version=2', `owner_user_id='${foreign.owner}'`, `run_id='${foreign.runId}'`,
      "media_type='application/json'", "sha256=repeat('f',64)", "object_key=object_key||'-moved'", "created_at=created_at+interval '1 second'"];
    for (const assignment of assignments) await assert.rejects(pool.query(`UPDATE bb_artifact_versions SET ${assignment} WHERE id=$1`, [a.artifactId]), rejectedWrite);
    await assert.rejects(pool.query('DELETE FROM bb_artifact_versions WHERE id=$1', [a.artifactId]), { code: '23503' });
    await pool.query("UPDATE bb_artifact_versions SET quality_status='passed',delivery_status='pending' WHERE id=$1", [a.artifactId]);
    await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1", [a.artifactId]);
    assert.deepEqual(await assertBinding(pool, f, a.artifactId), before);
    await assert.rejects(pool.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
      VALUES($1,$2,$3,2,2,$4)`, [f.owner, f.projectId, f.runId, f.hash]), rejectedWrite);
  });

test('a missing initial execution aborts artifact insertion; a missing binding is invisible to provenance readers',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); const f = await fixture(client);
      await client.query('ALTER TABLE bb_run_execution_versions DISABLE TRIGGER bb_run_execution_immutable');
      await client.query('DELETE FROM bb_run_execution_versions WHERE run_id=$1', [f.runId]);
      await client.query('ALTER TABLE bb_run_execution_versions ENABLE TRIGGER bb_run_execution_immutable');
      await client.query('SAVEPOINT failed_insert');
      await assert.rejects(rawArtifact(client, f), { code: '23514', constraint: 'bb_artifact_execution_exact' });
      await client.query('ROLLBACK TO SAVEPOINT failed_insert');
      assert.equal((await client.query('SELECT 1 FROM bb_artifact_versions WHERE run_id=$1', [f.runId])).rowCount, 0);
      assert.equal((await client.query('SELECT 1 FROM bb_artifact_execution_bindings WHERE run_id=$1', [f.runId])).rowCount, 0);
    } finally { await client.query('ROLLBACK'); client.release(); }
    const corrupt = await pool.connect();
    try {
      await corrupt.query('BEGIN'); const f = await fixture(corrupt), a = await rawArtifact(corrupt, f);
      await corrupt.query('ALTER TABLE bb_artifact_execution_bindings DISABLE TRIGGER bb_artifact_execution_immutable');
      await corrupt.query('DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1', [a.artifactId]);
      await corrupt.query('ALTER TABLE bb_artifact_execution_bindings ENABLE TRIGGER bb_artifact_execution_immutable');
      assert.equal((await corrupt.query('SELECT 1 FROM bb_artifact_versions WHERE id=$1', [a.artifactId])).rowCount, 1);
      assert.equal((await corrupt.query('SELECT 1 FROM bb_execution_artifact_versions WHERE id=$1', [a.artifactId])).rowCount, 0);
    } finally { await corrupt.query('ROLLBACK'); corrupt.release(); }
  });

test('actual migration backfills every legacy artifact without changing files and fails on missing or mismatched execution evidence',
  { skip: !connection, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'artifact-execution-backfill');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    for (const mode of ['valid', 'missing', 'mismatched'] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await removeScaffold(client);
        const f = await fixture(client), artifacts = [await rawArtifact(client, f, { version: 3 }),
          await rawArtifact(client, f, { version: 7, rejected: true }), await rawArtifact(client, f, { mediaType: 'text/plain' })];
        const before = (await client.query('SELECT * FROM bb_artifact_versions ORDER BY id,version')).rows;
        if (mode !== 'valid') {
          await client.query('ALTER TABLE bb_run_execution_versions DISABLE TRIGGER bb_run_execution_immutable');
          if (mode === 'missing') await client.query('DELETE FROM bb_run_execution_versions WHERE run_id=$1', [f.runId]);
          else await client.query('UPDATE bb_run_execution_versions SET input_hash=$2 WHERE run_id=$1', [f.runId, '0'.repeat(64)]);
          await client.query('ALTER TABLE bb_run_execution_versions ENABLE TRIGGER bb_run_execution_immutable');
        }
        if (mode === 'valid') {
          await client.query(migration);
          for (const a of artifacts) await assertBinding(client, f, a.artifactId, a.version);
          assert.deepEqual((await client.query('SELECT * FROM bb_artifact_versions ORDER BY id,version')).rows, before);
          assert.equal((await client.query('SELECT count(*)::int AS n FROM bb_artifact_execution_bindings')).rows[0].n, before.length);
        } else await assert.rejects(client.query(migration), rejectedWrite);
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
  });

test('migration drains run/job promoters before artifact locks and does not invert a topic/input creator',
  { skip: !connection, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'artifact-execution-lock-order');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    await removeScaffold(pool); const f = await fixture(pool);
    const writer = await pool.connect(), migrator = await pool.connect();
    let pending: Promise<{ error?: unknown }> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout='1500ms'");
      await writer.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE', [f.runId]);
      await writer.query('SELECT id FROM bb_jobs WHERE id=$1 FOR UPDATE', [f.jobId]);
      await migrator.query('BEGIN'); await migrator.query("SET LOCAL statement_timeout='10000ms'");
      const pid = Number((await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      pending = migrator.query(migration).then(() => ({}), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='bb_runs'::regclass
          AND mode='ExclusiveLock' AND NOT granted`, [pid])).rowCount === 1;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, 'migration must first wait for the run row locker');
      assert.equal((await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND granted
        AND relation IN ('bb_artifact_versions'::regclass,'bb_run_execution_versions'::regclass)`, [pid])).rowCount, 0);
      const a = await rawArtifact(writer, f); await writer.query('COMMIT');
      assert.equal((await pending).error, undefined); await migrator.query('COMMIT');
      await assertBinding(pool, f, a.artifactId, a.version);
    } finally {
      await writer.query('ROLLBACK'); await migrator.query('ROLLBACK'); if (pending) await pending;
      writer.release(); migrator.release();
    }
    await removeScaffold(pool); const qa = await fixture(pool, 'qa');
    const creator = await pool.connect(), secondMigrator = await pool.connect();
    try {
      await creator.query('BEGIN');
      await creator.query('SELECT id FROM bb_m4_topics WHERE id=$1 FOR UPDATE', [qa.topicId]);
      const manifest = { synthetic: true, revision: 4 }, hash = inputManifestHash(manifest);
      await creator.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,4,$2,1,$3,$4,'[]','[]')`, [qa.projectId, qa.owner, hash, manifest]);
      await secondMigrator.query('BEGIN'); await secondMigrator.query("SET LOCAL lock_timeout='1500ms'");
      await secondMigrator.query(migration); await secondMigrator.query('COMMIT');
      const runId = uid();
      await creator.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,4,$4,$5,'generation',$6,'queued')`, [runId, qa.owner, qa.projectId, hash, uid(), digest(uid())]);
      await creator.query('COMMIT');
      assert.equal((await pool.query('SELECT input_revision FROM bb_run_execution_versions WHERE run_id=$1', [runId])).rows[0].input_revision, 4);
    } finally {
      await creator.query('ROLLBACK'); await secondMigrator.query('ROLLBACK'); creator.release(); secondMigrator.release();
    }
  });
