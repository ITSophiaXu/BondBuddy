import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

// Standalone acceptance only: no application process, build, Blob or supplier call.
const local = dirname(fileURLToPath(import.meta.url));
const root = resolve(local, '../..');
const maintenanceUrl = 'postgresql://bb_g03_test@127.0.0.1:15526/postgres';
const templateName = 'bb_g03_template_20261026';
const expectedOwner = 'bb_g03_test';
const cloneName = `bb_g03_upgrade_20261026_${process.pid}_${randomBytes(5).toString('hex')}`;
assert.match(cloneName, /^bb_g03_upgrade_20261026_[0-9]+_[a-f0-9]{10}$/);
assert.ok(cloneName.length <= 63 && cloneName !== templateName && cloneName !== 'postgres');
const quote = value => `"${value.replaceAll('"', '""')}"`;
const sha = value => createHash('sha256').update(value).digest('hex');
mkdirSync(local, { recursive: true });
let sequence = 1;
while (existsSync(join(local, `migration-upgrade-${sequence}.json`)) || existsSync(join(local, `migration-upgrade-${sequence}.log`))) sequence++;
const jsonPath = join(local, `migration-upgrade-${sequence}.json`);
const logPath = join(local, `migration-upgrade-${sequence}.log`);
const jsonFd = openSync(jsonPath, 'wx');
const logFd = openSync(logPath, 'wx');
const report = { started: new Date().toISOString(), status: 'running', cloneName, templateName, endpoint: '127.0.0.1:15526',
  output: { jsonPath, logPath }, checks: [], migrations: [], cleanup: { created: false, dropped: false }, templateConnectionOpened: false };
const log = message => { const line = `${new Date().toISOString()} ${message}\n`; writeFileSync(logFd, line); process.stdout.write(line); };
const passed = (name, detail = {}) => { report.checks.push({ name, ...detail }); log(`PASS ${name}`); };
const maintenance = new Client({ connectionString: maintenanceUrl, application_name: 'bb_private_upgrade_acceptance_maintenance' });
let clone;
let created = false;
let cloneOid;
let templateBefore;
let failure;
let phase = 'maintenance connection';

async function assertMaintenance() {
  const { rows: [row] } = await maintenance.query('SELECT current_database() db,current_user usr,inet_server_port() port');
  assert.deepEqual(row, { db: 'postgres', usr: expectedOwner, port: 15526 });
}
async function databaseIdentity(name) {
  return (await maintenance.query(`SELECT oid::text,datname,pg_get_userbyid(datdba) owner,datistemplate,datallowconn,encoding,datcollate,datctype
    FROM pg_database WHERE datname=$1`, [name])).rows[0];
}
async function assertCreatedClone() {
  assert.ok(created, 'Destructive operations require this process to have successfully created the clone');
  assert.match(cloneName, /^bb_g03_upgrade_20261026_[0-9]+_[a-f0-9]{10}$/);
  assert.notEqual(cloneName, templateName);
  const identity = await databaseIdentity(cloneName);
  assert.ok(identity);
  assert.equal(identity.datname, cloneName);
  assert.equal(identity.owner, expectedOwner);
  assert.equal(identity.oid, cloneOid);
  assert.equal(identity.datistemplate, false);
  return identity;
}
async function assertCloneConnection() {
  await assertCreatedClone();
  const { rows: [row] } = await clone.query('SELECT current_database() db,current_user usr,inet_server_port() port');
  assert.deepEqual(row, { db: cloneName, usr: expectedOwner, port: 15526 });
}
async function snapshot(tables) {
  const rows = {};
  const hashes = {};
  for (const table of tables) {
    assert.match(table, /^bb_[a-z0-9_]+$/);
    const result = await clone.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) data FROM public.${quote(table)} t`);
    rows[table] = result.rows[0].data;
    hashes[table] = { count: rows[table].length, sha256: sha(JSON.stringify(rows[table])) };
  }
  return { rows, hashes };
}
async function expectRejected(name, sql, params, constraint) {
  let error;
  try { await clone.query(sql, params); } catch (caught) { error = caught; }
  assert.ok(error, `${name} must reject`);
  assert.equal(error.code, '23514');
  if (constraint) assert.equal(error.constraint, constraint);
  passed(name, { sqlstate: error.code, constraint: error.constraint });
}

try {
  await maintenance.connect();
  await assertMaintenance();
  templateBefore = await databaseIdentity(templateName);
  assert.ok(templateBefore);
  assert.equal(templateBefore.owner, expectedOwner);
  assert.equal(await databaseIdentity(cloneName), undefined);
  phase = 'create private clone';
  for (let attempt = 0; ; attempt++) {
    try { await maintenance.query(`CREATE DATABASE ${quote(cloneName)} WITH TEMPLATE ${quote(templateName)} OWNER ${quote(expectedOwner)}`); break; }
    catch (error) {
      if (error.code !== '55006' || attempt >= 50) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    }
  }
  created = true;
  report.cleanup.created = true;
  cloneOid = (await databaseIdentity(cloneName)).oid;
  report.cloneOid = cloneOid;
  await assertCreatedClone();
  const cloneUrl = new URL(maintenanceUrl);
  cloneUrl.pathname = `/${cloneName}`;
  clone = new Client({ connectionString: cloneUrl.toString(), application_name: 'bb_private_upgrade_acceptance_clone' });
  await clone.connect();
  await assertCloneConnection();
  await clone.query("SET statement_timeout='15s'");
  const initialSchema = (await clone.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 2')).rows.map(row => row.filename);
  assert.deepEqual(initialSchema, ['0121_run_supplement_saved_work.sql', '0120_model_call_execution_bindings.sql']);
  assert.equal((await clone.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n, 0);
  for (const table of ['bb_run_supplement_saved_results', 'bb_run_supplement_saved_work', 'bb_model_call_execution_bindings']) {
    assert.equal((await clone.query(`SELECT count(*)::int n FROM ${quote(table)}`)).rows[0].n, 0);
  }
  passed('private clone has expected owner, schema0121 and zero runs');

  phase = 'restore private clone to schema0119';
  await assertCloneConnection();
  await clone.query('BEGIN');
  try {
    // Every DROP below runs through the already-verified connection to our own new clone.
    await clone.query(`
      DROP TABLE bb_run_supplement_saved_results;
      DROP TABLE bb_run_supplement_saved_work;
      DROP FUNCTION bb_check_supplement_saved_result();
      DROP FUNCTION bb_check_supplement_saved_work();
      DROP TRIGGER bb_model_call_execution_insert ON bb_model_call_attempts;
      DROP TRIGGER bb_model_call_execution_identity_immutable ON bb_model_call_attempts;
      DROP TABLE bb_model_call_execution_bindings;
      DROP FUNCTION bb_bind_model_call_execution();
      DROP FUNCTION bb_guard_bound_model_call_identity();
      DROP FUNCTION bb_check_model_call_execution_binding();
      ALTER TABLE bb_run_execution_versions DROP CONSTRAINT bb_execution_exact_input_key;
    `);
    await clone.query('DELETE FROM bb_schema_migrations WHERE filename=ANY($1::text[])', [initialSchema]);
    await clone.query('COMMIT');
  } catch (error) { await clone.query('ROLLBACK'); throw error; }
  assert.equal((await clone.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0].filename, '0119_initial_run_execution_identity.sql');
  assert.equal((await clone.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])",
    [['bb_model_call_execution_bindings', 'bb_run_supplement_saved_work', 'bb_run_supplement_saved_results']])).rows[0].n, 0);
  passed('only the verified private clone was restored to schema0119');

  phase = 'seed historical schema0119 data';
  const f = { owner: `upgrade-${randomUUID()}`, project: randomUUID(), run: randomUUID(), job: randomUUID(), result: randomUUID(),
    prompts: { exact: randomUUID(), sameHashWrongRevision: randomUUID(), missingInputMetadata: randomUUID() },
    attempts: { exact: randomUUID(), sameHashWrongRevision: randomUUID(), missingInputMetadata: randomUUID(), unprompted: randomUUID() } };
  const manifest = { synthetic_upgrade: true, project_id: f.project };
  const inputHash = sha(JSON.stringify(manifest));
  const checkpoint = { synthetic_original: true, stages: { existing_stage: { saved: 'original immutable-input work' } } };
  await clone.query('BEGIN');
  try {
    await clone.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [f.owner, `up_${randomBytes(8).toString('hex')}`]);
    await clone.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic private migration acceptance','update')", [f.project, f.owner]);
    for (const revision of [1, 2]) await clone.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,$3,1,$4,$5,'[]','[]')`, [f.project, revision, f.owner, inputHash, manifest]);
    await clone.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1', [f.project]);
    await clone.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,created_at)
      VALUES($1,$2,$3,1,$4,$1,'update',$4,'paused','user_paused','2026-10-25T00:00:00Z')`, [f.run, f.owner, f.project, inputHash]);
    await clone.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts,user_pause_requested,checkpoint)
      VALUES($1,$2,$3,'update','synthetic','paused','user_paused',NULL,NULL,1,true,$4)`, [f.job, f.owner, f.run, checkpoint]);
    let version = 0;
    for (const [kind, id] of Object.entries(f.prompts)) {
      const revision = kind === 'missingInputMetadata' ? null : kind === 'sameHashWrongRevision' ? 2 : 1;
      await clone.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash)
        VALUES($1,$2,$3,$4,'model_request',$5,$6,$7,'synthetic-v1',$8,$9)`,
      [id, f.owner, f.project, f.run, ++version, `users/${f.owner}/projects/${f.project}/snapshots/${id}`, sha(`Synthetic prompt ${id}`), revision, revision === null ? null : inputHash]);
    }
    for (const [kind, id] of Object.entries(f.attempts)) await clone.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,prompt_snapshot_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-model',$6,'2026-10-25T01:00:00Z','2026-10-25T01:00:00Z')`,
      [id, f.owner, f.job, `historical-${kind}`, kind === 'unprompted' ? 'confirmed_not_sent' : 'completed', f.prompts[kind] ?? null]);
    const bytes = Buffer.from('{"synthetic_upgrade":true}');
    const resultHash = sha(bytes);
    await clone.query(`INSERT INTO bb_provider_result_refs(id,owner_user_id,project_id,job_id,run_id,attempt_id,logical_call_id,attempt_no,call_id,trace_id,model_id,model_config_version,prompt_snapshot_ref,result_ref,result_sha256,result_schema_version,byte_size,media_type)
      VALUES($1,$2,$3,$4,$5,$6,'historical-exact',1,$6,$5,'synthetic-model','synthetic-v1',$7,$8,$9,'synthetic-v1',$10,'application/json')`,
      [f.result, f.owner, f.project, f.job, f.run, f.attempts.exact, f.prompts.exact,
        `users/${f.owner}/projects/${f.project}/provider-results/${f.attempts.exact}-${resultHash}.json`, resultHash, bytes.length]);
    await clone.query(`INSERT INTO bb_run_supplement_drafts(owner_user_id,project_id,run_id,revision,request_id,request_hash,base_input_revision,base_input_hash,changes,saved_at)
      VALUES($1,$2,$3,1,'old-schema0119-receipt',$4,1,$4,'[]','2026-10-25T02:00:00Z')`, [f.owner, f.project, f.run, inputHash]);
    const lot = randomUUID(), source = randomUUID();
    await clone.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1)', [f.owner]);
    await clone.query(`INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining)
      VALUES($1,$2,'existing_grant',$3,1234,1234)`, [lot, f.owner, source]);
    await clone.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason)
      VALUES($1,$2,$3,'grant',1234,$4,'synthetic-upgrade','Nonempty immutable migration baseline')`, [randomUUID(), f.owner, `grant:${source}`, lot]);
    await clone.query('COMMIT');
  } catch (error) { await clone.query('ROLLBACK'); throw error; }
  report.fixture = { ...f, inputHash, inputRevisions: [1, 2], nonemptyLedgerPoints: 1234 };
  const oldTables = (await clone.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'bb\\_%' ESCAPE '\\'
    AND tablename<>'bb_schema_migrations' ORDER BY tablename`)).rows.map(row => row.tablename);
  const before = await snapshot(oldTables);
  report.beforeUpgrade = before.hashes;
  assert.equal(before.rows.bb_model_call_attempts.length, 4);
  assert.equal(before.rows.bb_credit_events.length, 1);
  assert.equal(before.rows.bb_provider_result_refs.length, 1);
  passed('schema0119 contains four historical call cases, an old receipt and a nonempty ledger');

  phase = 'apply unchanged migration SQL';
  for (const filename of ['0120_model_call_execution_bindings.sql', '0121_run_supplement_saved_work.sql']) {
    await assertCloneConnection();
    const sql = readFileSync(join(root, 'db/migrations', filename), 'utf8');
    await clone.query('BEGIN');
    try {
      await clone.query(sql);
      await clone.query('INSERT INTO bb_schema_migrations(filename) VALUES($1)', [filename]);
      await clone.query('COMMIT');
    } catch (error) { await clone.query('ROLLBACK'); throw error; }
    report.migrations.push({ filename, sha256: sha(sql), appliedOriginalSql: true });
    passed(`applied original ${filename}`);
  }
  const bindings = (await clone.query('SELECT * FROM bb_model_call_execution_bindings ORDER BY attempt_id')).rows;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].attempt_id, f.attempts.exact);
  assert.equal(bindings[0].prompt_snapshot_ref, f.prompts.exact);
  assert.equal(bindings[0].input_revision, 1);
  assert.equal(bindings[0].execution_version, 1);
  assert.equal(bindings[0].input_hash, inputHash);
  assert.equal(bindings[0].created_at.toISOString(), '2026-10-25T01:00:00.000Z');
  report.bindings = bindings;
  passed('only the exact historical prompt call is backfilled with its original timestamp');
  for (const table of ['bb_run_supplement_saved_work', 'bb_run_supplement_saved_results']) {
    assert.equal((await clone.query(`SELECT count(*)::int n FROM ${quote(table)}`)).rows[0].n, 0);
  }
  passed('old supplement receipt gains no fabricated saved work or result');
  const after = await snapshot(oldTables);
  report.afterUpgrade = after.hashes;
  assert.deepEqual(after.rows, before.rows);
  passed('every row in every preexisting public business table is unchanged', { tablesCompared: oldTables.length });

  phase = 'negative boundary checks';
  for (const kind of ['sameHashWrongRevision', 'missingInputMetadata']) {
    await expectRejected(`new intent rejects ${kind}`, `INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,prompt_snapshot_id)
      VALUES($1,$2,$3,$4,1,'pending_reconcile','synthetic-model',$5)`,
    [randomUUID(), f.owner, f.job, `new-${kind}`, f.prompts[kind]], 'bb_model_call_execution_exact');
  }
  await expectRejected('successor execution V2 is still rejected', `INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    VALUES($1,$2,$3,2,1,$4)`, [f.owner, f.project, f.run, inputHash], 'bb_run_execution_versions_execution_version_check');
  await expectRejected('bound attempt cannot switch prompt', 'UPDATE bb_model_call_attempts SET prompt_snapshot_id=$2 WHERE id=$1',
    [f.attempts.exact, f.prompts.sameHashWrongRevision], 'bb_model_call_execution_identity_immutable');
  assert.deepEqual((await snapshot(oldTables)).rows, before.rows);
  assert.deepEqual((await clone.query('SELECT * FROM bb_model_call_execution_bindings ORDER BY attempt_id')).rows, bindings);
  passed('rejected intents, V2 and identity update leave all historical rows and bindings unchanged');
  const finalSchema = (await clone.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 2')).rows.map(row => row.filename);
  assert.deepEqual(finalSchema, initialSchema);
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.failure = { phase, name: error.name, message: error.message, code: error.code, constraint: error.constraint, stack: error.stack };
  log(`FAIL ${phase}: ${error.stack ?? error}`);
} finally {
  try { if (clone) await clone.end(); }
  catch (error) { failure ??= error; report.connectionCloseFailure = error.message; }
  if (created) {
    try {
      await assertMaintenance();
      await assertCreatedClone();
      await maintenance.query(`DROP DATABASE ${quote(cloneName)} WITH (FORCE)`);
      assert.equal(await databaseIdentity(cloneName), undefined);
      report.cleanup.dropped = true;
      passed('only this process-created clone was dropped after connection close');
    } catch (error) { failure ??= error; report.cleanup.failure = error.stack ?? String(error); log(`FAIL clone cleanup: ${error.message}`); }
  }
  if (templateBefore) {
    try {
      assert.deepEqual(await databaseIdentity(templateName), templateBefore);
      report.templateIdentityUnchanged = true;
      passed('template identity is unchanged and no template data connection was opened');
    } catch (error) { failure ??= error; report.templateIdentityFailure = error.stack ?? String(error); }
  }
  try { await maintenance.end(); } catch (error) { failure ??= error; report.maintenanceCloseFailure = error.message; }
  if (failure) report.status = 'failed';
  report.finished = new Date().toISOString();
  writeFileSync(jsonFd, JSON.stringify(report, null, 2) + '\n');
  closeSync(jsonFd);
  closeSync(logFd);
}
process.exitCode = failure ? 1 : 0;
