import {removeReviewArtifactExecutionScaffold} from './review-artifact-migration-test-fixture.js';
// Synthetic inputs/bytes; real PostgreSQL receipts, leases, promoters and finish.
// Deliberate schema corruption is confined to rolled-back private clone transactions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { digest, transaction, uid, type PrivateBlobs } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { completeM4Qa, registerM4Artifacts } from './m4-workspace.js';
import { inputManifestHash } from './production-rule-pin.js';
import { checkpointStage, finish, finishM4Qa, promoteWordArtifact, type Lease } from './queue.js';
import { isolatedTestDatabase } from './test-database.js';
import { createServer } from './server.js';

const connection = await isolatedTestDatabase(undefined, 'run-execution-delivery');
const migration = await readFile(new URL('../../../db/migrations/0126_run_execution_deliveries.sql', import.meta.url), 'utf8');
const rejectedWrite = (error: unknown) => ['23502', '23503', '23514', 'P0002', 'P0003'].includes((error as { code?: string }).code ?? '');
type Db = Pool | PoolClient;

function memoryBlobs(): PrivateBlobs {
  const values = new Map<string, Buffer>();
  return { put: async (key, bytes) => { values.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes = values.get(key); assert.ok(bytes); return bytes; },
    getIfExists: async key => values.get(key) ?? null,
    getIfExistsBounded: async (key, max) => { const bytes = values.get(key); assert.ok(!bytes || bytes.length <= max); return bytes ?? null; },
    exists: async key => values.has(key), delete: async key => { values.delete(key); } };
}

async function fixture(db: Db, kind: 'word' | 'qa' | 'document' = 'word') {
  const owner = uid(), projectId = uid(), runId = uid(), jobId = uid(), topicId = uid(), messageId = uid(), token = uid();
  await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `delivery_${uid().replaceAll('-', '').slice(0, 16)}`]);
  await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic frozen delivery',$3)",
    [projectId, owner, kind !== 'word' ? 'generation' : 'update']);
  const context = { document_type: null, draft_version: 0, source_material: null, citations: [], reading_artifact: null };
  let manifest: Record<string, unknown> = { name: 'Synthetic frozen delivery', synthetic: true };
  if (kind !== 'word') {
    await db.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash)
      VALUES($1,$2,$3,'Synthetic delivery topic',$4,$5)`, [topicId, owner, projectId, uid(), digest(uid())]);
    if (kind === 'qa') manifest = { version: 'm4-qa-input-v1', kind: 'qa', topic_id: topicId, message_id: messageId, content: 'Synthetic question',
      context, context_snapshot: { draft: null, messages: [] }, materials: [], billing_task: 'm4_Q01' };
    else {
      const pin = { source_project_id: projectId, material_id: uid(), material_version: 1, sha256: digest(uid()) };
      manifest = { version: 'm4-document-input-v1', kind: 'document', topic_id: topicId, execution_scope_project_id: projectId,
        draft_version: 1, market: 'sse', offering: 'private', billing_task: 'm4_G01', template_material: null,
        input: { document_type: 'init', source_material: pin, materials: [pin], template: null, edit_base: null,
          scope: 'whole', fields: { issuer_name: 'Synthetic issuer' }, requirements: [] } };
    }
  }
  const hash = inputManifestHash(manifest);
  await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,'[]','[]')`, [projectId, owner, hash, manifest]);
  await db.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
  await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,'running','word_delivery')`, [runId, owner, projectId, hash, uid(), kind === 'qa' ? 'qa' : kind === 'document' ? 'generation' : 'update', digest(uid())]);
  await db.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
    VALUES($1,$2,$3,$4,$5,'running','word_delivery',$6,now()+interval '10 minutes',1)`,
  [jobId, owner, runId, kind === 'qa' ? 'qa' : kind === 'document' ? 'generation' : 'update', kind === 'qa' ? 'm4_qa_v1' : kind === 'document' ? 'm4_document_v1' : 'default', token]);
  if (kind !== 'word') {
    await db.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',
      [runId, owner, topicId, manifest, hash]);
    if (kind === 'qa') await db.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,run_id,reply_status)
      VALUES($1,$2,$3,'user','Synthetic question',$4,$5,'running')`, [messageId, owner, topicId, context, runId]);
  }
  const lease: Lease = { owner, runId, jobId, token, checkpoint: {}, attempts: 1, executionVersion: 1, inputRevision: 1, inputHash: hash };
  return { owner, projectId, runId, jobId, topicId, hash, manifest, lease };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function word(pool: Pool, f: Fixture, blobs: PrivateBlobs, label: string) {
  const result = await promoteWordArtifact(pool, f.lease, makeSyntheticDocxFixture({ text: label }), blobs, 'generated_pair_v1');
  assert.equal(result.status, 'available');
  if (result.status !== 'available') throw Error('synthetic Word unavailable');
  return result;
}
async function pair(pool: Pool, f: Fixture, blobs: PrivateBlobs) {
  const revision = await word(pool, f, blobs, `Synthetic revision ${uid()}`);
  const clean = await word(pool, f, blobs, `Synthetic clean ${uid()}`);
  await checkpointStage(pool, f.lease, 'word_delivery_pair', { revision_artifact_id: revision.artifactId, clean_artifact_id: clean.artifactId });
  return { revision, clean };
}
const reply = { content: 'Synthetic retained answer', citations: [], requirements: [], fields: {}, intent: 'answer' as const,
  document_type: null, target_business: null, retrieval: 'not_performed' as const };

async function receipts(db: Db, runId: string, phase = 'final') {
  return (await db.query('SELECT * FROM bb_run_execution_deliveries WHERE run_id=$1 AND delivery_phase=$2', [runId, phase])).rows;
}
async function published(db: Db, runId: string) {
  return (await db.query('SELECT id,version FROM bb_delivered_artifact_versions WHERE run_id=$1 ORDER BY id,version', [runId])).rows;
}
async function attachDynamicReservation(db: Db, f: Fixture) {
  const price = uid(), quote = uid(), reservation = uid();
  await db.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1) ON CONFLICT DO NOTHING', [f.owner]);
  await db.query(`INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason)
    VALUES($1,'{}',clock_timestamp(),'synthetic','delivery transaction test')`, [price]);
  await db.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
    VALUES($1,$2,$3,1,$4,$5,'new_authoring',100,'synthetic')`, [quote, f.owner, f.projectId, f.hash, price]);
  await db.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points)
    VALUES($1,$2,$3,$4,100,'authoring_balance_v2',0)`, [reservation, f.owner, f.runId, quote]);
  await db.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1", [f.runId, reservation]);
  return reservation;
}

test('real finish publishes only its exact selected files and freezes pair, input and completion metadata',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
    const abandoned = await word(pool, f, blobs, `Synthetic abandoned candidate ${uid()}`);
    assert.equal((await pool.query("SELECT delivery_status FROM bb_artifact_versions WHERE id=$1", [abandoned.artifactId])).rows[0].delivery_status, 'available');
    assert.deepEqual(await published(pool, f.runId), []);
    const result = await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    assert.equal(result.state, 'succeeded');
    const [receipt] = await receipts(pool, f.runId);
    assert.ok(receipt); assert.equal(receipt.execution_version, 1); assert.equal(receipt.input_revision, 1); assert.equal(receipt.input_hash, f.hash);
    assert.equal(receipt.terminal_state, 'succeeded'); assert.equal(receipt.source, 'terminal_transition');
    assert.equal(receipt.primary_artifact_id, selected.revision.artifactId); assert.equal(receipt.primary_artifact_version, 1);
    assert.equal(receipt.word_delivery_pair.clean_artifact_version, 1); assert.equal(receipt.word_delivery_pair.revision_artifact_version, 1);
    assert.deepEqual(receipt.naming_manifest, f.manifest);
    assert.deepEqual(await published(pool, f.runId), [selected.revision, selected.clean]
      .map(a => ({ id: a.artifactId, version: a.artifactVersion })).sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal((await pool.query('SELECT 1 FROM bb_delivered_artifact_versions WHERE id=$1', [abandoned.artifactId])).rowCount, 0);
    const terminal = (await pool.query("SELECT seq FROM bb_run_events WHERE run_id=$1 AND state='succeeded' AND type='run.state_changed'", [f.runId])).rows[0];
    assert.equal(receipt.event_cursor, terminal.seq);
    await pool.query('SELECT bb_capture_run_execution_delivery($1,$2)', [f.owner, f.runId]);
    assert.deepEqual(await receipts(pool, f.runId), [receipt]);
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair,clean_artifact_id}',to_jsonb($2::text)) WHERE id=$1", [f.jobId, abandoned.artifactId]);
    const details = (await pool.query('SELECT * FROM bb_run_execution_delivery_artifact_details WHERE artifact_id=$1', [selected.clean.artifactId])).rows[0];
    assert.equal(details.naming_pair.clean_artifact_id, selected.clean.artifactId);
    assert.equal(details.naming_manifest.name, 'Synthetic frozen delivery');
    assert.deepEqual(await receipts(pool, f.runId), [receipt]);
    await assert.rejects(pool.query('SELECT bb_capture_run_execution_delivery($1,$2)', [f.owner, f.runId]), rejectedWrite);
    await pool.query("UPDATE bb_runs SET state='paused',artifact_id=NULL,artifact_version=NULL,updated_at=now() WHERE id=$1", [f.runId]);
    assert.equal((await published(pool, f.runId)).length, 2, 'past delivery membership is independent of the run current state and primary projection');
    assert.deepEqual(await receipts(pool, f.runId), [receipt]);
  });

test('real no-baseline delivery appears in HTTP history with exact files and live access checks',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
    let owner = f.owner;
    const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test',
      principal: async () => ({ userId: owner, csrfVerified: true }) });
    t.after(() => app.close());
    const history = () => app.inject({ method: 'GET', url: `/api/v1/projects/${f.projectId}/artifacts` });
    assert.deepEqual((await history()).json().items, [], 'saved candidates alone are not a delivery');
    await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    const delivered = await history();
    assert.equal(delivered.statusCode, 200, delivered.body);
    assert.deepEqual(delivered.json().items.map((item: { run_id: string }) => item.run_id), [f.runId]);
    const expected = { revision: { artifact_id: selected.revision.artifactId, version: 1 },
      clean: { artifact_id: selected.clean.artifactId, version: 1 } };
    assert.deepEqual(delivered.json().items[0].word_delivery, expected, 'no invented baseline or null pair');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_download_grants')).rows[0].n, 0);
    const [receipt] = await receipts(pool, f.runId);
    assert.equal(Object.hasOwn(receipt.word_delivery_pair, 'baseline_artifact_id'), false);
    await pool.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair,baseline_artifact_id}',
      to_jsonb($2::text)) WHERE id=$1`, [f.jobId, uid()]);
    assert.deepEqual((await history()).json().items[0].word_delivery, expected,
      'a later mutable checkpoint cannot invent a delivered baseline');
    const clean = (await pool.query('SELECT object_key FROM bb_artifact_versions WHERE id=$1 AND version=1', [selected.clean.artifactId])).rows[0];
    const cleanBytes = await blobs.get(clean.object_key);
    await blobs.delete(clean.object_key);
    const missing = await history();
    assert.equal(missing.statusCode, 503, missing.body); assert.equal(missing.json().code, 'DATA_UNAVAILABLE');
    await blobs.put(clean.object_key, Buffer.from('Synthetic damaged clean Word'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal((await history()).statusCode, 503, 'both delivered files must pass actual byte/hash verification');
    await blobs.put(clean.object_key, cleanBytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.deepEqual((await history()).json().items[0].word_delivery, expected);
    owner = uid(); assert.equal((await history()).statusCode, 404); owner = f.owner;
    await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1", [selected.clean.artifactId]);
    assert.deepEqual((await history()).json().items, [], 'a revoked clean member excludes the pair');
  });

test('manual pause and an exhausted dynamic reservation save candidate work without publishing a final delivery',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const mode of ['pause', 'balance'] as const) {
      const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
      if (mode === 'pause') await pool.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1', [f.jobId]);
      else await attachDynamicReservation(pool, f);
      assert.equal((await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs })).state, 'paused');
      assert.deepEqual(await receipts(pool, f.runId), []); assert.deepEqual(await published(pool, f.runId), []);
      const checkpoint = (await pool.query('SELECT checkpoint,state,stage FROM bb_jobs WHERE id=$1', [f.jobId])).rows[0];
      assert.equal(checkpoint.checkpoint.stages.word_delivery_pair.clean_artifact_id, selected.clean.artifactId);
      assert.equal(checkpoint.stage, mode === 'pause' ? 'user_paused' : 'credits_exhausted');
    }
  });

test('an outbox failure after the terminal UPDATE rolls back its receipt, members, run and job together',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
    const beforeRun = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows[0];
    const beforeJob = (await pool.query('SELECT * FROM bb_jobs WHERE id=$1', [f.jobId])).rows[0];
    const guard = `synthetic_delivery_${uid().replaceAll('-', '')}`;
    await pool.query(`CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='run.state_changed' AND NEW.payload->>'run_id'='${f.runId}' AND NEW.payload->>'state'='succeeded'
      THEN RAISE EXCEPTION 'synthetic delivery outbox failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${guard} BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION ${guard}()`);
    try {
      await assert.rejects(finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs }), /synthetic delivery outbox failure/);
      assert.deepEqual((await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows, [beforeRun]);
      assert.deepEqual((await pool.query('SELECT * FROM bb_jobs WHERE id=$1', [f.jobId])).rows, [beforeJob]);
      assert.deepEqual(await receipts(pool, f.runId), []); assert.deepEqual(await published(pool, f.runId), []);
      assert.equal((await pool.query('SELECT 1 FROM bb_run_execution_delivery_artifacts WHERE run_id=$1', [f.runId])).rowCount, 0);
    } finally { await pool.query(`DROP FUNCTION ${guard}() CASCADE`); }
    await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    assert.equal((await receipts(pool, f.runId)).length, 1);
  });

test('receipts and members are immutable; missing or altered members hide the whole delivery',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
    await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    for (const sql of [
      'UPDATE bb_run_execution_deliveries SET delivered_at=delivered_at WHERE run_id=$1',
      'DELETE FROM bb_run_execution_deliveries WHERE run_id=$1',
      'UPDATE bb_run_execution_delivery_artifacts SET role=role WHERE run_id=$1',
      'DELETE FROM bb_run_execution_delivery_artifacts WHERE run_id=$1',
    ]) await assert.rejects(pool.query(sql, [f.runId]), rejectedWrite);
    for (const mode of ['missing', 'hash', 'role'] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE bb_run_execution_delivery_artifacts DISABLE TRIGGER bb_execution_delivery_member_immutable');
        if (mode === 'missing') await client.query('DELETE FROM bb_run_execution_delivery_artifacts WHERE artifact_id=$1', [selected.clean.artifactId]);
        else if (mode === 'hash') await client.query("UPDATE bb_run_execution_delivery_artifacts SET artifact_sha256=repeat('0',64) WHERE artifact_id=$1", [selected.clean.artifactId]);
        else await client.query("UPDATE bb_run_execution_delivery_artifacts SET role='comments' WHERE artifact_id=$1", [selected.clean.artifactId]);
        await client.query('ALTER TABLE bb_run_execution_delivery_artifacts ENABLE TRIGGER bb_execution_delivery_member_immutable');
        assert.deepEqual(await published(client, f.runId), []);
        assert.equal((await client.query('SELECT 1 FROM bb_run_execution_delivery_artifact_details WHERE run_id=$1', [f.runId])).rowCount, 0);
        await client.query('SAVEPOINT replay');
        await assert.rejects(client.query('SELECT bb_capture_run_execution_delivery($1,$2)', [f.owner, f.runId]), rejectedWrite);
        await client.query('ROLLBACK TO SAVEPOINT replay');
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
    await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1", [selected.clean.artifactId]);
    assert.equal((await pool.query('SELECT delivery_status FROM bb_delivered_artifact_versions WHERE id=$1', [selected.clean.artifactId])).rows[0].delivery_status, 'revoked',
      'the delivery view preserves live status so authorization still checks revocation');
  });

test('pair members without versions must resolve uniquely; a second verified version cannot be guessed away',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs), evidence = uid();
    await pool.query(`INSERT INTO bb_word_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,
      validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
      SELECT $2,owner_user_id,run_id,artifact_id,2,candidate_sha256,byte_size,validator_version,quality_status,delivery_status,
        delivery_code,readback_sha256,readback_byte_size,quality_evidence FROM bb_word_delivery_evidence WHERE artifact_id=$1 AND artifact_version=1`, [selected.clean.artifactId, evidence]);
    await pool.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
      SELECT id,2,owner_user_id,run_id,media_type,sha256,object_key||'/synthetic-v2',quality_status,delivery_status,$2
      FROM bb_artifact_versions WHERE id=$1 AND version=1`, [selected.clean.artifactId, evidence]);
    await assert.rejects(finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs }), rejectedWrite);
    assert.deepEqual(await receipts(pool, f.runId), []); assert.deepEqual(await published(pool, f.runId), []);
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair,clean_artifact_version}','1'::jsonb) WHERE id=$1", [f.jobId]);
    await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    assert.equal((await pool.query('SELECT 1 FROM bb_delivered_artifact_versions WHERE id=$1 AND version=2', [selected.clean.artifactId])).rowCount, 0);
  });

test('M4 QA durable publication preserves a nonterminal readable result, while real finish adds a distinct final receipt without duplicate public rows',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool, 'qa');
    const answer = await transaction(pool, client => completeM4Qa(client, f.owner, f.runId, reply));
    const [durable] = await receipts(pool, f.runId, 'm4_durable');
    assert.ok(durable); assert.equal(durable.terminal_state, null); assert.equal(durable.event_cursor, null);
    assert.equal(durable.primary_artifact_id, answer.artifactId); assert.equal(durable.primary_artifact_version, 1);
    assert.equal((await pool.query('SELECT state,artifact_id FROM bb_runs WHERE id=$1', [f.runId])).rows[0].state, 'running');
    assert.deepEqual(await receipts(pool, f.runId), []);
    assert.deepEqual(await published(pool, f.runId), [{ id: answer.artifactId, version: 1 }]);
    await pool.query('SELECT bb_capture_m4_durable_delivery($1,$2)', [f.owner, f.runId]);
    assert.deepEqual(await receipts(pool, f.runId, 'm4_durable'), [durable]);
    assert.equal((await finishM4Qa(pool, f.lease, reply)).state, 'succeeded');
    assert.equal((await receipts(pool, f.runId)).length, 1); assert.equal((await receipts(pool, f.runId, 'm4_durable')).length, 1);
    assert.deepEqual(await published(pool, f.runId), [{ id: answer.artifactId, version: 1 }]);
    assert.equal((await pool.query('SELECT delivery_phase FROM bb_run_execution_delivery_artifact_details WHERE artifact_id=$1', [answer.artifactId])).rows[0].delivery_phase, 'final');
    const dynamic = await fixture(pool, 'qa'); await attachDynamicReservation(pool, dynamic);
    await transaction(pool, client => completeM4Qa(client, dynamic.owner, dynamic.runId, reply));
    assert.deepEqual(await receipts(pool, dynamic.runId, 'm4_durable'), []); assert.deepEqual(await published(pool, dynamic.runId), []);
  });

test('an invalid final QA phase falls back only to its independently valid durable receipt',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool, 'qa');
    assert.equal((await finishM4Qa(pool, f.lease, reply)).state, 'succeeded');
    const [final] = await receipts(pool, f.runId), [durable] = await receipts(pool, f.runId, 'm4_durable');
    assert.ok(final); assert.ok(durable); assert.equal(final.primary_artifact_id, durable.primary_artifact_id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE bb_run_execution_delivery_artifacts DISABLE TRIGGER bb_execution_delivery_member_immutable');
      await client.query("UPDATE bb_run_execution_delivery_artifacts SET role='comments' WHERE run_id=$1 AND delivery_phase='final'", [f.runId]);
      await client.query('ALTER TABLE bb_run_execution_delivery_artifacts ENABLE TRIGGER bb_execution_delivery_member_immutable');
      assert.deepEqual((await client.query(`SELECT d.delivery_phase,bb_execution_delivery_phase_valid(d) AS valid
        FROM bb_run_execution_deliveries d WHERE d.run_id=$1 ORDER BY d.delivery_phase`, [f.runId])).rows,
      [{ delivery_phase: 'final', valid: false }, { delivery_phase: 'm4_durable', valid: true }]);
      assert.deepEqual((await client.query(`SELECT delivery_phase FROM bb_run_execution_delivery_artifact_details
        WHERE artifact_id=$1 AND artifact_version=1`, [final.primary_artifact_id])).rows, [{ delivery_phase: 'm4_durable' }]);
      assert.deepEqual(await published(client, f.runId), [{ id: final.primary_artifact_id, version: 1 }]);
      assert.deepEqual(await receipts(client, f.runId), [final]);
      assert.deepEqual(await receipts(client, f.runId, 'm4_durable'), [durable]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.deepEqual((await pool.query(`SELECT delivery_phase FROM bb_run_execution_delivery_artifact_details
      WHERE artifact_id=$1 AND artifact_version=1`, [final.primary_artifact_id])).rows, [{ delivery_phase: 'final' }]);
  });

test('M4 document durable publication waits for the registered document and note and never publishes a dynamic unpaid pair',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const policy of ['legacy', 'dynamic'] as const) {
      const f = await fixture(pool, 'document'), blobs = memoryBlobs();
      if (policy === 'dynamic') await attachDynamicReservation(pool, f);
      const documentBytes = makeSyntheticDocxFixture({ text: `Synthetic registered document ${uid()}` });
      const noteBytes = makeSyntheticDocxFixture({ text: `Synthetic registered note ${uid()}` });
      const document = await promoteWordArtifact(pool, f.lease, documentBytes, blobs, 'generated_pair_v1');
      const note = await promoteWordArtifact(pool, f.lease, noteBytes, blobs, 'generated_pair_v1');
      assert.equal(document.status, 'available'); assert.equal(note.status, 'available');
      if (document.status !== 'available' || note.status !== 'available') throw Error('synthetic M4 files unavailable');
      const candidate = await word(pool, f, blobs, `Synthetic unregistered M4 candidate ${uid()}`);
      await transaction(pool, client => registerM4Artifacts(client, f.owner, f.runId, [{ kind: 'document', artifact_id: document.artifactId,
        artifact_version: document.artifactVersion, filename: 'synthetic.docx', byte_size: documentBytes.length }]));
      assert.deepEqual(await receipts(pool, f.runId, 'm4_durable'), []); assert.deepEqual(await published(pool, f.runId), []);
      await transaction(pool, client => registerM4Artifacts(client, f.owner, f.runId, [{ kind: 'preparation_note', artifact_id: note.artifactId,
        artifact_version: note.artifactVersion, filename: 'synthetic-note.docx', byte_size: noteBytes.length }]));
      assert.deepEqual(await receipts(pool, f.runId), []);
      if (policy === 'dynamic') {
        assert.deepEqual(await receipts(pool, f.runId, 'm4_durable'), []); assert.deepEqual(await published(pool, f.runId), []);
      } else {
        const [durable] = await receipts(pool, f.runId, 'm4_durable');
        assert.equal(durable.primary_artifact_id, document.artifactId); assert.equal(durable.terminal_state, null);
        assert.equal((await published(pool, f.runId)).length, 2);
        assert.equal((await pool.query('SELECT 1 FROM bb_delivered_artifact_versions WHERE id=$1', [candidate.artifactId])).rowCount, 0);
      }
    }
  });

test('concurrent exact replay serializes on the run and cannot add another receipt or member set',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
    await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    const before = await receipts(pool, f.runId);
    await Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT bb_capture_run_execution_delivery($1,$2)', [f.owner, f.runId])));
    assert.deepEqual(await receipts(pool, f.runId), before);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_execution_delivery_artifacts WHERE run_id=$1 AND delivery_phase='final'", [f.runId])).rows[0].n, 2);
  });

test('UTC publication stays readable and exactly replayable from an Asia/Shanghai session',
  { skip: !connection, timeout: 30000 }, async t => {
    const writer = new Pool({ connectionString: connection, options: '-c timezone=UTC' });
    const reader = new Pool({ connectionString: connection, options: '-c timezone=Asia/Shanghai' });
    t.after(async () => { await writer.end(); await reader.end(); });
    assert.equal((await writer.query('SHOW TimeZone')).rows[0].TimeZone, 'UTC');
    assert.equal((await reader.query('SHOW TimeZone')).rows[0].TimeZone, 'Asia/Shanghai');
    const f = await fixture(writer), blobs = memoryBlobs(), selected = await pair(writer, f, blobs);
    await finish(writer, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    const before = await receipts(writer, f.runId), expected = await published(writer, f.runId);
    assert.equal(expected.length, 2);
    assert.deepEqual(await published(reader, f.runId), expected);
    await reader.query('SELECT bb_capture_run_execution_delivery($1,$2)', [f.owner, f.runId]);
    assert.deepEqual(await receipts(reader, f.runId), before);
    assert.deepEqual(await published(reader, f.runId), expected);
    for (const member of before[0].artifact_manifest) assert.match(member.naming_created_at, /\.\d{6}Z$/);
  });

test('a missing nonprimary provenance binding hides the complete phase even while its immutable member list is unchanged',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
    await finish(pool, f.lease, 'succeeded', { artifactId: selected.revision.artifactId, artifactVersion: 1, blobs });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query('SELECT * FROM bb_run_execution_delivery_artifacts WHERE run_id=$1 ORDER BY artifact_id', [f.runId])).rows;
      // Removing the exact FK is confined to this rolled-back private clone.
      // Normal database clients cannot delete a selected artifact's binding.
      await client.query('ALTER TABLE bb_run_execution_delivery_artifacts DROP CONSTRAINT bb_execution_delivery_member_origin');
      await client.query('ALTER TABLE bb_artifact_execution_bindings DISABLE TRIGGER bb_artifact_execution_immutable');
      await client.query('DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1 AND artifact_version=1', [selected.clean.artifactId]);
      await client.query('ALTER TABLE bb_artifact_execution_bindings ENABLE TRIGGER bb_artifact_execution_immutable');
      assert.deepEqual((await client.query('SELECT * FROM bb_run_execution_delivery_artifacts WHERE run_id=$1 ORDER BY artifact_id', [f.runId])).rows, before);
      assert.equal((await client.query('SELECT 1 FROM bb_artifact_versions WHERE id=$1', [selected.clean.artifactId])).rowCount, 1);
      assert.deepEqual(await published(client, f.runId), []);
      assert.equal((await client.query('SELECT 1 FROM bb_run_execution_delivery_artifact_details WHERE run_id=$1', [f.runId])).rowCount, 0);
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal((await published(pool, f.runId)).length, 2);
  });

async function removeDeliverySchema(db: Db) {
  await removeReviewArtifactExecutionScaffold(db);
  // CASCADE drops helpers whose arguments use either table's composite type,
  // including bb_execution_delivery_member_json and bb_execution_delivery_phase_valid.
  // Do not reference those now-removed row types in a later DROP FUNCTION.
  await db.query(`DROP TABLE IF EXISTS bb_review_execution_reports CASCADE;
    DROP FUNCTION IF EXISTS bb_bridge_review_execution_report(),bb_check_review_execution_report(),bb_review_report_storage_shape(jsonb) CASCADE;
    DROP TABLE IF EXISTS bb_review_execution_editors CASCADE;
    DROP FUNCTION IF EXISTS bb_bridge_review_execution_editor(),bb_check_review_execution_editor() CASCADE;
    DROP FUNCTION IF EXISTS bb_review_editor_snapshot_shape(jsonb),bb_review_editor_canonical_json(jsonb) CASCADE;
    ALTER TABLE bb_review_execution_snapshots DROP CONSTRAINT IF EXISTS bb_review_execution_snapshot_editor_key;
    DROP VIEW IF EXISTS bb_delivered_artifact_versions CASCADE;
    DROP VIEW IF EXISTS bb_run_execution_delivery_artifact_details CASCADE;
    DROP TABLE bb_run_execution_delivery_artifacts,bb_run_execution_deliveries,bb_run_execution_delivery_gaps CASCADE;
    DROP FUNCTION IF EXISTS bb_capture_terminal_execution_delivery() CASCADE;
    DROP FUNCTION IF EXISTS bb_capture_run_execution_delivery(text,text,text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_capture_run_execution_delivery(text,text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_capture_m4_durable_delivery(text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_check_run_execution_delivery() CASCADE;
    DROP FUNCTION IF EXISTS bb_check_run_execution_delivery_artifact() CASCADE;
    DROP FUNCTION IF EXISTS bb_run_execution_delivery_plan(text,text,text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_run_execution_delivery_plan(text,text,text) CASCADE;
    DROP FUNCTION IF EXISTS bb_execution_delivery_artifact_ready(bb_artifact_versions,text,timestamptz) CASCADE;
    DROP FUNCTION IF EXISTS bb_execution_delivery_artifact_ready(bb_artifact_versions,text) CASCADE;
    ALTER TABLE bb_artifact_execution_bindings DROP CONSTRAINT bb_artifact_execution_delivery_key;`);
}

test('actual migration uses the exact terminal event time and records unreconstructable history without a public fallback',
  { skip: !connection, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'run-execution-delivery-backfill');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    const blobs = memoryBlobs(), valid = await fixture(pool), missing = await fixture(pool), qa = await fixture(pool, 'qa');
    const validPair = await pair(pool, valid, blobs), missingPair = await pair(pool, missing, blobs);
    const qaAnswer = await transaction(pool, c => completeM4Qa(c, qa.owner, qa.runId, reply));
    const terminalAt = (await pool.query(`SELECT max(created_at)+interval '1 second' AS at FROM bb_word_delivery_evidence
      WHERE run_id=ANY($1::text[])`, [[valid.runId, missing.runId]])).rows[0].at.toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await removeDeliverySchema(client);
      for (const [f, selected] of [[valid, validPair], [missing, missingPair]] as const) {
        await client.query("UPDATE bb_jobs SET state='succeeded',lease_token=NULL,lease_until=NULL WHERE id=$1", [f.jobId]);
        await client.query("UPDATE bb_runs SET state='succeeded',artifact_id=$2,artifact_version=1,event_cursor=20,updated_at=$3::timestamptz+interval '1 day' WHERE id=$1", [f.runId, selected.revision.artifactId, terminalAt]);
      }
      await client.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload,occurred_at)
        VALUES($1,$2,$3,20,$3,'run.state_changed','succeeded','succeeded','{"reason":"word_delivered"}',$4)`, [uid(), valid.owner, valid.runId, terminalAt]);
      await client.query(migration);
      const [saved] = await receipts(client, valid.runId);
      assert.equal(saved.source, 'legacy_backfill'); assert.equal(saved.event_cursor, 20);
      assert.equal(saved.delivered_at.toISOString(), terminalAt);
      assert.equal((await published(client, valid.runId)).length, 2);
      assert.deepEqual(await receipts(client, missing.runId), []); assert.deepEqual(await published(client, missing.runId), []);
      const gap = (await client.query("SELECT diagnostic FROM bb_run_execution_delivery_gaps WHERE run_id=$1 AND delivery_phase='final'", [missing.runId])).rows[0];
      assert.equal(gap.diagnostic.code, 'legacy_delivery_not_reconstructable');
      assert.equal((await client.query("SELECT state,artifact_id FROM bb_runs WHERE id=$1", [missing.runId])).rows[0].state, 'succeeded');
      const [durable] = await receipts(client, qa.runId, 'm4_durable');
      assert.equal(durable.source, 'legacy_backfill'); assert.equal(durable.terminal_state, null); assert.equal(durable.event_cursor, null);
      assert.deepEqual(await receipts(client, qa.runId), []);
      assert.deepEqual(await published(client, qa.runId), [{ id: qaAnswer.artifactId, version: 1 }]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

test('migration drains run writers before job/file/execution locks and does not invert a topic/input creator',
  { skip: !connection, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'run-execution-delivery-lock-order');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    const f = await fixture(pool), blobs = memoryBlobs(), selected = await pair(pool, f, blobs);
    await removeDeliverySchema(pool);
    const writer = await pool.connect(), migrator = await pool.connect();
    let pending: Promise<{ error?: unknown }> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout='1500ms'");
      // Own the same table/row locks as a real terminal writer before the
      // migrator queues its ExclusiveLock; no later lock upgrade is needed.
      await writer.query("UPDATE bb_runs SET stage='synthetic_inflight' WHERE id=$1", [f.runId]);
      await writer.query("UPDATE bb_jobs SET stage='synthetic_inflight' WHERE id=$1", [f.jobId]);
      await migrator.query('BEGIN'); await migrator.query("SET LOCAL statement_timeout='10000ms'");
      const pid = Number((await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      pending = migrator.query(migration).then(() => ({}), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='bb_runs'::regclass
          AND mode='ExclusiveLock' AND NOT granted`, [pid])).rowCount === 1;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, 'the migration must drain the current run writer first');
      assert.equal((await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND granted
        AND relation IN ('bb_jobs'::regclass,'bb_artifact_versions'::regclass,'bb_run_execution_versions'::regclass,'bb_artifact_execution_bindings'::regclass)`, [pid])).rowCount, 0);
      await writer.query('UPDATE bb_artifact_versions SET quality_status=quality_status WHERE id=$1', [selected.clean.artifactId]);
      await writer.query("UPDATE bb_jobs SET state='succeeded',stage='succeeded',lease_token=NULL,lease_until=NULL WHERE id=$1", [f.jobId]);
      const terminal = (await writer.query(`UPDATE bb_runs SET state='succeeded',stage='succeeded',artifact_id=$2,artifact_version=1,
        event_cursor=event_cursor+1,updated_at=now() WHERE id=$1 RETURNING event_cursor,updated_at`, [f.runId, selected.revision.artifactId])).rows[0];
      await writer.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload,occurred_at)
        VALUES($1,$2,$3,$4,$3,'run.state_changed','succeeded','succeeded','{"reason":"word_delivered"}',$5)`, [uid(), f.owner, f.runId, terminal.event_cursor, terminal.updated_at]);
      await writer.query('COMMIT');
      assert.equal((await pending).error, undefined); await migrator.query('COMMIT');
      const [backfilled] = await receipts(pool, f.runId);
      assert.equal(backfilled.source, 'legacy_backfill'); assert.equal(backfilled.event_cursor, terminal.event_cursor);
      assert.equal((await published(pool, f.runId)).length, 2);
    } finally {
      await writer.query('ROLLBACK'); await migrator.query('ROLLBACK'); if (pending) await pending;
      writer.release(); migrator.release();
    }
    const qa = await fixture(pool, 'qa'); await removeDeliverySchema(pool);
    const creator = await pool.connect(), secondMigrator = await pool.connect();
    try {
      await creator.query('BEGIN');
      await creator.query('SELECT id FROM bb_m4_topics WHERE id=$1 FOR UPDATE', [qa.topicId]);
      const nextManifest = { synthetic: true, revision: 2 }, nextHash = inputManifestHash(nextManifest);
      await creator.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,1,$3,$4,'[]','[]')`, [qa.projectId, qa.owner, nextHash, nextManifest]);
      await secondMigrator.query('BEGIN'); await secondMigrator.query("SET LOCAL lock_timeout='1500ms'");
      await secondMigrator.query(migration); await secondMigrator.query('COMMIT');
      const runId = uid();
      await creator.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,2,$4,$5,'generation',$6,'queued')`, [runId, qa.owner, qa.projectId, nextHash, uid(), digest(uid())]);
      await creator.query('COMMIT');
      assert.equal((await pool.query('SELECT input_revision FROM bb_run_execution_versions WHERE run_id=$1', [runId])).rows[0].input_revision, 2);
    } finally {
      await creator.query('ROLLBACK'); await secondMigrator.query('ROLLBACK'); creator.release(); secondMigrator.release();
    }
  });
