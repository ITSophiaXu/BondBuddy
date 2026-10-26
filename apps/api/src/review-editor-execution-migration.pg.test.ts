// Synthetic registrations and editor bodies; real PostgreSQL 16, migration,
// constraints and transactions. Destructive DDL stays in disposable clones.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import type { ReviewEditorSnapshot } from '@bondbuddy/contracts';
import { digest, uid } from './data.js';
import { canonicalInputManifest, inputManifestHash } from './production-rule-pin.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'review-editor-execution-migration');
const migration = await readFile(new URL('../../../db/migrations/0127_review_execution_editors.sql', import.meta.url), 'utf8');
const skip = !connection && 'BB_TEST_DATABASE_URL not set; PG16 migration integration not run';
const word = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const editorTime = '2026-10-20T01:02:05.123456Z';
type Db = Pool | PoolClient;
const rejectedWrite = (error: unknown) => ['23502', '23503', '23514', 'P0002'].includes((error as { code: string }).code);

async function removeScaffold(db: Db) {
  await db.query(`DROP TABLE IF EXISTS bb_review_execution_reports CASCADE;
    DROP FUNCTION IF EXISTS bb_bridge_review_execution_report(),bb_check_review_execution_report(),bb_review_report_storage_shape(jsonb) CASCADE;
    DROP TABLE IF EXISTS bb_review_execution_editors CASCADE;
    DROP FUNCTION IF EXISTS bb_bridge_review_execution_editor(),bb_check_review_execution_editor() CASCADE;
    DROP FUNCTION IF EXISTS bb_review_editor_snapshot_shape(jsonb),bb_review_editor_canonical_json(jsonb) CASCADE;
    ALTER TABLE bb_review_execution_snapshots DROP CONSTRAINT IF EXISTS bb_review_execution_snapshot_editor_key;`);
}

async function inTransaction(pool: Pool, work: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); await work(db); }
  finally { await db.query('ROLLBACK'); db.release(); }
}

async function rejectStatement(db: PoolClient, sql: string, values: unknown[] = [], predicate = rejectedWrite) {
  await db.query('SAVEPOINT expected_rejection');
  try { await assert.rejects(db.query(sql, values), predicate); }
  finally { await db.query('ROLLBACK TO SAVEPOINT expected_rejection'); await db.query('RELEASE SAVEPOINT expected_rejection'); }
}

type FixtureOptions = { sourceFormat?: 'docx' | 'pdf'; omitReview?: boolean; missingSource?: boolean; foreignSource?: 'owner' | 'project' };
async function fixture(db: Db, options: FixtureOptions = {}) {
  const owner = uid(), projectId = uid(), runId = uid(), materialId = uid(), uploadId = uid();
  const sourceFormat = options.sourceFormat ?? 'docx', sourceHash = digest(`synthetic editor source ${materialId}`);
  await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `em_${uid().replaceAll('-', '').slice(0, 20)}`]);
  await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic execution editor migration','review')", [projectId, owner]);
  let materialOwner = owner, materialProject = projectId;
  if (options.foreignSource) {
    materialProject = uid();
    if (options.foreignSource === 'owner') {
      materialOwner = uid();
      await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [materialOwner, `em_${uid().replaceAll('-', '').slice(0, 20)}`]);
    }
    await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic foreign source','review')", [materialProject, materialOwner]);
  }
  if (!options.missingSource) {
    const key = `synthetic/editor-migration/${materialId}`, mediaType = sourceFormat === 'pdf' ? 'application/pdf' : word;
    await db.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,$5,64,$6,'other',$7,now()+interval '1 day','completed')`,
    [uploadId, materialOwner, materialProject, `合成募集书😀.${sourceFormat}`, mediaType, sourceHash, key]);
    await db.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'other',$5,$6,64,$7,$8,'persisted')`,
    [materialId, materialOwner, materialProject, uploadId, `合成募集书😀.${sourceFormat}`, mediaType, sourceHash, key]);
  }
  const pin = { material_id: materialId, material_version: 1, sha256: sourceHash };
  const input = { source_material_ref: pin, material_versions: [pin], requirements: ['Synthetic immutable editor source'], as_of: null };
  const origin = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null };
  const reviewBody = { input, input_version: 1, finding_ids: [], plan: null, origin, context_messages: [] };
  const manifest = { materials: [{ ...pin, role: 'other' }], review: { version: 'review_v1',
    operation: 'full_review', version_number: 1, report_id: uid(), source_report_id: null, source_report_sha256: null,
    finding_ids: [], input, origin, file_delivery: { version: 'review-correction-v2', knowledge: [] } } };
  const inputHash = inputManifestHash(manifest);
  await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [projectId, owner, inputHash, manifest, JSON.stringify(manifest.materials)]);
  await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,created_at)
    VALUES($1,$2,$3,1,$4,$5,'review',$6,'paused','user_paused','2026-10-20T01:02:03.123000Z')`,
  [runId, owner, projectId, inputHash, uid(), digest(uid())]);
  if (!options.omitReview) await db.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot,created_at)
    VALUES($1,$2,$3,1,'full_review',$4,'2026-10-20T01:02:04.123000Z')`, [runId, owner, projectId, reviewBody]);
  const body: ReviewEditorSnapshot = { version: 'review-editor-v1', source_filename: `合成募集书😀.${sourceFormat}`,
    source_sha256: sourceHash, source_format: sourceFormat, warnings: ['合成未核信息'],
    paragraphs: [{ id: '段落😀', text: '中文、é、😀；quote " slash \\ controls \b\f\n\r\t\u0001；\u2028\u2029' }],
    issues: [{ id: 'synthetic-issue', decision: 'suggested', manual_text: '', category: '合成事项', title: '保留来源',
      original: '原文😀', replacement: '修订后', reason: '合成理由', evidence: '合成依据', missing: '',
      uncertain: false, paragraph_id: null, applied: true, limitation: '未进行行业审核' }] };
  return { owner, projectId, runId, inputHash, body, hash: inputManifestHash(body), createdAt: editorTime };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Changes = { owner?: string; projectId?: string; body?: unknown; hash?: string; createdAt?: string };
const legacySql = `INSERT INTO bb_review_editors(owner_user_id,project_id,run_id,snapshot,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6)`;
const canonicalSql = `INSERT INTO bb_review_execution_editors(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,snapshot,sha256,created_at)
  VALUES($1,$2,$3,1,1,$4,$5,$6,$7)`;
function legacyValues(f: Fixture, changes: Changes = {}) {
  return [changes.owner ?? f.owner, changes.projectId ?? f.projectId, f.runId, changes.body ?? f.body, changes.hash ?? f.hash, changes.createdAt ?? f.createdAt];
}
async function insertLegacy(db: Db, f: Fixture, changes: Changes = {}) { await db.query(legacySql, legacyValues(f, changes)); }
async function insertCanonical(db: Db, f: Fixture) { await db.query(canonicalSql, [f.owner, f.projectId, f.runId, f.inputHash, f.body, f.hash, f.createdAt]); }

async function assertMirror(db: Db, f: Fixture) {
  const result = (await db.query(`SELECT e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash,e.snapshot,e.sha256,
    e.created_at=legacy.created_at AS exact_time,e.snapshot=legacy.snapshot AS exact_body,e.sha256=legacy.sha256 AS exact_hash,
    to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact
    FROM bb_review_execution_editors e JOIN bb_review_editors legacy ON legacy.run_id=e.run_id WHERE e.run_id=$1`, [f.runId])).rows;
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { owner_user_id: f.owner, project_id: f.projectId, run_id: f.runId,
    execution_version: 1, input_revision: 1, input_hash: f.inputHash, snapshot: f.body, sha256: f.hash,
    exact_time: true, exact_body: true, exact_hash: true, created_at_exact: editorTime });
}

test('0127 fresh replay installs six-field editor FKs and a versioned key while preserving the legacy key and V1 gate',
  { skip, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    await inTransaction(pool, async db => {
      const version = Number((await db.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
      assert(version >= 160000 && version < 170000, 'requires real PostgreSQL 16');
      const legacyKey = (await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='bb_review_editors'::regclass AND contype='p'")).rows;
      await removeScaffold(db); await db.query(migration);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM bb_review_execution_editors')).rows[0].n, 0);
      const constraints = (await db.query("SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='bb_review_execution_editors'::regclass")).rows;
      assert.deepEqual(constraints.filter(row => row.contype === 'p').map(row => row.definition), ['PRIMARY KEY (run_id, execution_version)']);
      assert.equal(constraints.filter(row => row.contype === 'u').length, 0, 'no UNIQUE(run_id) may collapse execution storage');
      const fks = constraints.filter(row => row.contype === 'f').map(row => String(row.definition));
      assert.equal(fks.length, 2); assert(fks.every(definition => definition.startsWith('FOREIGN KEY (owner_user_id, project_id, run_id, execution_version, input_revision, input_hash)')));
      assert(fks.some(definition => definition.includes('REFERENCES bb_run_execution_versions')));
      assert(fks.some(definition => definition.includes('REFERENCES bb_review_execution_snapshots')));
      assert.deepEqual((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='bb_review_editors'::regclass AND contype='p'")).rows, legacyKey);
      const f = await fixture(db);
      await rejectStatement(db, `INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
        VALUES($1,$2,$3,2,1,$4)`, [f.owner, f.projectId, f.runId, f.inputHash]);
    });
  });

test('0127 actual replay backfills exact legacy bodies, hashes and PostgreSQL microsecond creation time',
  { skip, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    await inTransaction(pool, async db => {
      await removeScaffold(db);
      const fixtures = [await fixture(db), await fixture(db, { sourceFormat: 'pdf' })];
      for (const f of fixtures) await insertLegacy(db, f);
      const before = (await db.query('SELECT to_jsonb(e) AS row FROM bb_review_editors e ORDER BY run_id')).rows;
      await db.query(migration);
      for (const f of fixtures) await assertMirror(db, f);
      assert.deepEqual((await db.query('SELECT to_jsonb(e) AS row FROM bb_review_editors e ORDER BY run_id')).rows, before);
    });
  });

test('0127 legacy-first bridge matches JavaScript canonical Unicode/control hashes and rejects all immutable editor writes',
  { skip, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    await inTransaction(pool, async db => {
      await db.query("SET LOCAL TimeZone='Asia/Shanghai'");
      const f = await fixture(db);
      const parity = (await db.query(`SELECT bb_review_editor_canonical_json($1::jsonb) AS canonical,
        encode(sha256(convert_to(bb_review_editor_canonical_json($1::jsonb),'UTF8')),'hex') AS hash`, [f.body])).rows[0];
      assert.equal(parity.canonical, canonicalInputManifest(f.body)); assert.equal(parity.hash, f.hash);
      await insertLegacy(db, f); await assertMirror(db, f);
      for (const field of ['owner_user_id','project_id','run_id','execution_version','input_revision','input_hash','snapshot','sha256','created_at']) {
        await rejectStatement(db, `UPDATE bb_review_execution_editors SET ${field}=${field} WHERE run_id=$1`, [f.runId]);
      }
      await rejectStatement(db, 'DELETE FROM bb_review_execution_editors WHERE run_id=$1', [f.runId]);
      await rejectStatement(db, 'UPDATE bb_review_editors SET sha256=sha256 WHERE run_id=$1', [f.runId]);
      await rejectStatement(db, 'DELETE FROM bb_review_editors WHERE run_id=$1', [f.runId]);
      await assertMirror(db, f);
    });
  });

test('0127 canonical-first V1 mirror accepts exact SQL timestamp copying and rejects changed body, hash or microsecond time atomically',
  { skip, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    await inTransaction(pool, async db => {
      const f = await fixture(db); await insertCanonical(db, f);
      const changed = { ...f.body, warnings: ['Different synthetic body'] };
      for (const changes of [{ body: changed, hash: inputManifestHash(changed) }, { hash: '0'.repeat(64) }, { createdAt: '2026-10-20T01:02:05.123457Z' }]) {
        await rejectStatement(db, legacySql, legacyValues(f, changes));
        assert.equal((await db.query('SELECT 1 FROM bb_review_editors WHERE run_id=$1', [f.runId])).rowCount, 0);
        assert.deepEqual((await db.query('SELECT snapshot,sha256 FROM bb_review_execution_editors WHERE run_id=$1', [f.runId])).rows, [{ snapshot: f.body, sha256: f.hash }]);
      }
      await db.query(`INSERT INTO bb_review_editors(owner_user_id,project_id,run_id,snapshot,sha256,created_at)
        SELECT owner_user_id,project_id,run_id,snapshot,sha256,created_at FROM bb_review_execution_editors WHERE run_id=$1 AND execution_version=1`, [f.runId]);
      await assertMirror(db, f);
    });
  });

test('0127 invalid legacy inserts roll back both tables instead of skipping missing or foreign exact source evidence',
  { skip, timeout: 60000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const options of [{ omitReview: true }, { missingSource: true }, { foreignSource: 'owner' }, { foreignSource: 'project' }] as FixtureOptions[]) {
      await inTransaction(pool, async db => {
        const f = await fixture(db, options);
        await rejectStatement(db, legacySql, legacyValues(f));
        for (const table of ['bb_review_editors','bb_review_execution_editors']) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE run_id=$1`, [f.runId])).rowCount, 0);
      });
    }
    await inTransaction(pool, async db => {
      const f = await fixture(db);
      const badBodies: unknown[] = [{ ...f.body, version: null }, { ...f.body, source_format: null },
        { ...f.body, source_format: 'pdf' }, { ...f.body, source_sha256: '0'.repeat(64) },
        { ...f.body, unexpected: 1 }, { ...f.body, paragraphs: [{ id: 'p', text: 7 }] }];
      for (const body of badBodies) await rejectStatement(db, legacySql, legacyValues(f, { body, hash: inputManifestHash(body) }));
      await rejectStatement(db, legacySql, legacyValues(f, { hash: '0'.repeat(64) }));
      await rejectStatement(db, legacySql, legacyValues(f, { createdAt: '2026-10-20T01:02:02.123456Z' }));
      for (const table of ['bb_review_editors','bb_review_execution_editors']) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE run_id=$1`, [f.runId])).rowCount, 0);
    });
  });

test('0127 actual legacy backfill fails the whole transaction for wrong project, missing snapshot/source, bad hash, source hash or format',
  { skip, timeout: 60000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    for (const mode of ['project','snapshot','source','hash','source_hash','format'] as const) {
      await inTransaction(pool, async db => {
        await removeScaffold(db);
        const f = await fixture(db, { omitReview: mode === 'snapshot', missingSource: mode === 'source' });
        const changes: Changes = {};
        if (mode === 'project') {
          changes.projectId = uid();
          await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic wrong editor project','review')", [changes.projectId, f.owner]);
        }
        if (mode === 'hash') changes.hash = '0'.repeat(64);
        if (mode === 'source_hash' || mode === 'format') {
          changes.body = mode === 'source_hash' ? { ...f.body, source_sha256: '0'.repeat(64) } : { ...f.body, source_format: 'pdf' };
          changes.hash = inputManifestHash(changes.body);
        }
        await insertLegacy(db, f, changes);
        const before = (await db.query('SELECT to_jsonb(e) AS row FROM bb_review_editors e WHERE run_id=$1', [f.runId])).rows;
        await rejectStatement(db, migration);
        assert.equal((await db.query("SELECT to_regclass('bb_review_execution_editors') AS relation")).rows[0].relation, null, mode);
        assert.deepEqual((await db.query('SELECT to_jsonb(e) AS row FROM bb_review_editors e WHERE run_id=$1', [f.runId])).rows, before, mode);
        assert.equal((await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid='bb_review_editors'::regclass AND tgname='bb_review_execution_editor_bridge'")).rowCount, 0, mode);
      });
    }
  });

test('0127 NOWAIT conflicts release parent locks on rollback and retry succeeds after a real legacy writer commits',
  { skip, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'review-editor-execution-migration-lock-order');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    await removeScaffold(pool); const f = await fixture(pool);
    const writer = await pool.connect(), migrator = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE', [f.projectId]);
      await writer.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE', [f.runId]);
      await migrator.query('BEGIN'); await migrator.query("SET LOCAL statement_timeout='2500ms'");
      const pid = Number((await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await assert.rejects(migrator.query(migration), error => (error as { code: string }).code === '55P03');
      await migrator.query('ROLLBACK');
      assert.equal((await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND relation IN
        ('bb_projects'::regclass,'bb_runs'::regclass,'bb_review_editors'::regclass) AND granted`, [pid])).rowCount, 0);
      await insertLegacy(writer, f); await writer.query('COMMIT');
      await migrator.query('BEGIN'); await migrator.query("SET LOCAL statement_timeout='10000ms'");
      await migrator.query(migration); await migrator.query('COMMIT');
      await assertMirror(pool, f);
    } finally {
      await writer.query('ROLLBACK'); await migrator.query('ROLLBACK'); writer.release(); migrator.release();
    }
  });

test('0127 a late legacy-table lock fails NOWAIT after parent locks without trapping the writer behind those parents',
  { skip, timeout: 30000 }, async t => {
    const url = await isolatedTestDatabase(undefined, 'review-editor-execution-migration-late-writer');
    const pool = new Pool({ connectionString: url }); t.after(() => pool.end());
    await removeScaffold(pool); const f = await fixture(pool);
    const writer = await pool.connect(), migrator = await pool.connect();
    try {
      await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout='1500ms'");
      // Reproduce an INSERT's table lock just before its project/run FK checks.
      await writer.query('LOCK TABLE bb_review_editors IN ROW EXCLUSIVE MODE');
      await migrator.query('BEGIN'); await migrator.query("SET LOCAL statement_timeout='2500ms'");
      const pid = Number((await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await assert.rejects(migrator.query(migration), error => (error as { code: string }).code === '55P03');
      await migrator.query('ROLLBACK');
      assert.equal((await pool.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND relation IN
        ('bb_projects'::regclass,'bb_runs'::regclass,'bb_run_execution_versions'::regclass,'bb_review_execution_snapshots'::regclass) AND granted`, [pid])).rowCount, 0);
      await insertLegacy(writer, f); await writer.query('COMMIT');
      await migrator.query('BEGIN'); await migrator.query(migration); await migrator.query('COMMIT');
      await assertMirror(pool, f);
    } finally {
      await writer.query('ROLLBACK'); await migrator.query('ROLLBACK'); writer.release(); migrator.release();
    }
  });
