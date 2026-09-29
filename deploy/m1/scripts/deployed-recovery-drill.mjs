#!/usr/bin/env node
// Controlled #79 rehearsal against the named, already running Compose services.
// No application or database connection string is accepted by this program.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const mode = process.argv[2];
if (!['run', 'recover', 'preflight'].includes(mode)) throw new Error('usage: deployed-recovery-drill.mjs preflight|run|recover');
const required = (key) => { const value = process.env[key]; if (!value) throw new Error(`${key} required`); return value; };
const uuid = (value) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '')) throw new Error('Invalid scoped UUID'); return value; };
const expectedSha = required('BB_DRILL_EXPECTED_SHA');
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('Expected full commit SHA');
const envFile = resolve(required('BB_DRILL_ENV_FILE'));
const stateFile = resolve(required('BB_DRILL_STATE_FILE'));
const evidenceFile = resolve(required('BB_DRILL_EVIDENCE_FILE'));
if (!existsSync(envFile)) throw new Error('Compose env file missing');
const envStat = statSync(envFile);
if ((envStat.mode & 0o077) !== 0) throw new Error('Compose env file must be private');
const compose = (...args) => execFileSync('docker', ['compose', '--project-directory', resolve('deploy/m1'), '-f', resolve('deploy/m1/compose.yaml'), '--env-file', envFile, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const services = ['api', 'worker', 'ops', 'postgres'];
const ids = Object.fromEntries(services.map(service => [service, required(`BB_DRILL_${service.toUpperCase()}_ID`)]));
const snapshot = (id) => JSON.parse(docker('inspect', id))[0];
const short = (error) => error instanceof Error ? error.message.split('\n')[0].slice(0, 180) : 'unknown failure';
const emit = (phase, value = {}) => { const record = { phase, at: new Date().toISOString(), ...value }; console.log(JSON.stringify(record)); return record; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sql = query => docker('exec', ids.postgres, 'psql', '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-U', 'bondbuddy', '-d', 'bondbuddy', '-c', query);
const rows = query => { const output = sql(query); return output ? output.split('\n').map(line => line.split('\t')) : []; };
const qid = value => `'${uuid(value)}'`;
const save = state => { const temp = `${stateFile}.new`; writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, stateFile); };
const load = () => { const stat = statSync(stateFile); if ((stat.mode & 0o077) !== 0) throw new Error('State file is not private'); return JSON.parse(readFileSync(stateFile, 'utf8')); };
const persistEvidence = records => { writeFileSync(evidenceFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 }); chmodSync(evidenceFile, 0o600); };

function checkServices() {
  for (const service of services) {
    const actual = compose('ps', '-q', service);
    if (actual !== ids[service]) throw new Error(`${service} ID does not match the specified running service`);
    const container = snapshot(actual);
    if (container.State.Status !== 'running' || container.State.Paused) throw new Error(`${service} is not ready`);
    if (container.Config.Labels?.['com.docker.compose.service'] !== service) throw new Error(`${service} Compose label mismatch`);
    if (service !== 'postgres') {
      const expected = `bondbuddy-m1-${service === 'ops' ? 'worker' : service}:${expectedSha.slice(0, 12)}`;
      if (container.Config.Image !== expected || !container.Config.Env.includes(`BB_RELEASE_SHA=${expectedSha}`)) throw new Error(`${service} image commit mismatch`);
    } else if (!container.Config.Image.startsWith('postgres:16')) throw new Error('PostgreSQL is not version 16');
  }
  const api = snapshot(ids.api), ops = snapshot(ids.ops), worker = snapshot(ids.worker);
  const value = (container, key) => container.Config.Env.find(item => item.startsWith(`${key}=`))?.slice(key.length + 1);
  if (!value(ops, 'BB_LOG_SINK_FILE') || value(ops, 'BB_OPS_LOG_FORWARD') === 'off') throw new Error('Deployed log forwarder is disabled');
  if (!value(api, 'AZURE_STORAGE_CONNECTION_STRING') || !value(worker, 'AZURE_STORAGE_CONNECTION_STRING')) throw new Error('Blob configuration missing');
  if (value(api, 'BB_ALLOWED_ORIGIN') !== required('BB_DRILL_ORIGIN')) throw new Error('API origin mismatch');
  const migrations = rows('SELECT filename FROM bb_schema_migrations ORDER BY filename').map(row => row[0]);
  const requiredMigrations = ['0021_m1_log_operations.sql', '0028_m1_ops_scheduler.sql', '0074_m1_storage_inventory.sql'];
  for (const filename of requiredMigrations) if (!migrations.includes(filename)) throw new Error(`Migration missing: ${filename}`);
  const gate = rows('SELECT state,seq FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')[0] ?? ['open', '0'];
  return { image_sha: expectedSha, migrations: migrations.length, latest_migration: migrations.at(-1), gate_state: gate[0], gate_seq: Number(gate[1]), service_ids: ids };
}

function guard(state, phase) {
  const allowed = (state?.job_ids ?? []).map(qid).join(',') || "''";
  const activeJobs = rows(`SELECT id,state FROM bb_jobs WHERE state IN ('queued','running') AND id NOT IN (${allowed}) ORDER BY id LIMIT 20`);
  // A historical failed observation or paused reconciliation has no in-flight supplier process.
  const activeCalls = rows(`SELECT a.id,j.id FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id
    WHERE j.state='running' AND a.status='pending_reconcile' AND j.id NOT IN (${allowed}) ORDER BY a.id LIMIT 20`);
  emit(phase, { active_job_ids: activeJobs.map(row => row[0]), active_call_ids: activeCalls.map(row => row[0]) });
  if (activeJobs.length || activeCalls.length) throw new Error('Other active work appeared; injection refused');
}

function jobSnapshot(jobId) {
  const id = qid(jobId);
  const job = rows(`SELECT state,attempts,COALESCE(stage,''),COALESCE(error_code,'') FROM bb_jobs WHERE id=${id}`)[0];
  const events = rows(`SELECT id,type,state FROM bb_job_events WHERE job_id=${id} ORDER BY seq`);
  const terminal = rows(`SELECT count(*) FROM bb_job_events WHERE job_id=${id} AND state IN ('succeeded','failed','cancelled')`)[0]?.[0];
  const outbox = rows(`SELECT id,COALESCE(delivered_at::text,'') FROM bb_outbox WHERE aggregate_type='material_parse_job' AND aggregate_id=${id} ORDER BY id`);
  const logs = rows(`SELECT o.id,COALESCE(d.delivery_key,'') FROM bb_outbox o JOIN bb_observability_events e ON e.id=o.aggregate_id
    LEFT JOIN bb_log_deliveries d ON d.outbox_id=o.id AND d.sink='ndjson_file' WHERE o.aggregate_type='observability' AND e.job_id=${id} ORDER BY o.id`);
  return { job_id: jobId, state: job?.[0], attempts: Number(job?.[1] ?? 0), stage: job?.[2], error_code: job?.[3],
    job_event_ids: events.map(row => row[0]), job_event_types: events.map(row => row[1]), terminal_count: Number(terminal ?? 0), outbox_ids: outbox.map(row => row[0]),
    log_outbox_ids: logs.map(row => row[0]), delivery_keys: logs.map(row => row[1]).filter(Boolean) };
}
function ownerSnapshot(owner) {
  const id = qid(owner);
  const outbox = rows(`SELECT id,COALESCE(delivered_at::text,'') FROM bb_outbox WHERE owner_user_id=${id} AND aggregate_type='observability' ORDER BY id`);
  const deliveries = rows(`SELECT d.outbox_id,d.delivery_key FROM bb_log_deliveries d JOIN bb_outbox o ON o.id=d.outbox_id WHERE o.owner_user_id=${id} AND o.aggregate_type='observability' AND d.sink='ndjson_file' ORDER BY d.outbox_id`);
  return { user_id: owner, outbox_ids: outbox.map(row => row[0]), pending: outbox.filter(row => !row[1]).length,
    receipt_ids: deliveries.map(row => row[0]), delivery_keys: deliveries.map(row => row[1]) };
}
function sinkKeyCounts(keys) {
  const script = `const fs=require('node:fs'); const keys=new Set(JSON.parse(process.argv[1]));
    const path=process.env.BB_LOG_SINK_FILE; const counts=Object.fromEntries([...keys].map(key=>[key,0]));
    for(const file of [path,path+'.1']) if(fs.existsSync(file)) for(const line of fs.readFileSync(file,'utf8').split('\\n')) {
      if(!line) continue; const key=JSON.parse(line).delivery_key; if(keys.has(key)) counts[key]++; }
    console.log(JSON.stringify(counts));`;
  return JSON.parse(docker('exec', ids.ops, 'node', '-e', script, JSON.stringify(keys)));
}
async function waitJobLogs(jobId) {
  return until(() => { const current = jobSnapshot(jobId); return current.log_outbox_ids.length > 0 &&
    current.delivery_keys.length === current.log_outbox_ids.length ? current : null; }, 90000, 'job log delivery');
}

const base = required('BB_DRILL_BASE_URL').replace(/\/$/, '');
const origin = required('BB_DRILL_ORIGIN');
let jar = new Map();
async function request(method, path, body) {
  const headers = { Origin: origin, Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') };
  if (method !== 'GET' && jar.get('bb_csrf')) headers['X-BB-CSRF'] = jar.get('bb_csrf');
  if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const index = pair.indexOf('='); jar.set(pair.slice(0, index), pair.slice(index + 1)); }
  let value = null; const text = await response.text(); try { value = JSON.parse(text); } catch { /* discard body */ }
  if (response.status < 200 || response.status >= 300) throw new Error(`API ${method} ${path.split('/').slice(0, 5).join('/')} status ${response.status}`);
  return value;
}
async function login(state) { jar = new Map(); await request('POST', '/api/v1/auth/login', { username: state.username, password: state.password }); }
async function upload(state, label, size) {
  const bytes = Buffer.from(('SYNTHETIC RECOVERY DRILL ONLY ' + label + '\n').repeat(Math.ceil(size / 38)).slice(0, size));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = `/api/v1/projects/${uuid(state.project_id)}/materials/uploads`;
  const created = await request('POST', path, { filename: `${label}.txt`, media_type: 'text/plain', byte_size: bytes.length, sha256: digest, role: 'audit' });
  state.upload_ids.push(uuid(created.upload_id)); save(state);
  await request('PUT', created.upload_url, bytes);
  const complete = await request('POST', `${path}/${uuid(created.upload_id)}/complete`, { byte_size: bytes.length, sha256: digest });
  const materialId = uuid(complete.material_id);
  state.material_ids.push(materialId);
  const jobId = rows(`SELECT id FROM bb_jobs WHERE owner_user_id=${qid(state.user_id)} AND material_id=${qid(materialId)} AND job_type='parse'`)[0]?.[0];
  if (!jobId) throw new Error('Uploaded material has no parse job');
  state.job_ids.push(uuid(jobId)); save(state);
  return jobId;
}
async function until(check, timeoutMs, label) { const start = Date.now(); while (Date.now() - start < timeoutMs) { const result = check(); if (result) return result; await sleep(250); } throw new Error(`${label} timed out`); }
function pause(service, state) { state[`${service}_paused`] = true; save(state); docker('pause', ids[service]); }
function unpause(service, state) { if (state[`${service}_paused`]) { if (snapshot(ids[service]).State.Paused) docker('unpause', ids[service]); state[`${service}_paused`] = false; save(state); } }
function removeTrigger(state) {
  if (!state.trigger_name) return;
  const name = state.trigger_name;
  if (!/^bb_drill79_[a-f0-9]{12}$/.test(name)) throw new Error('Invalid trigger name in state');
  const table = state.trigger_table;
  if (!['bb_outbox', 'bb_parse_snapshots'].includes(table)) throw new Error('Invalid trigger table in state');
  sql(`DROP TRIGGER IF EXISTS ${name} ON ${table}; DROP FUNCTION IF EXISTS ${name}()`);
  state.trigger_name = null; state.trigger_table = null; save(state);
}
function restore(state) {
  const errors = [];
  try { removeTrigger(state); } catch (error) { errors.push(`trigger: ${short(error)}`); }
  for (const service of ['ops', 'worker']) {
    try { unpause(service, state); } catch (error) { errors.push(`${service}: ${short(error)}`); }
  }
  if (state.worker_killed) {
    try { if (snapshot(ids.worker).State.Status !== 'running') docker('start', ids.worker); state.worker_killed = false; save(state); }
    catch (error) { errors.push(`worker restart: ${short(error)}`); }
  }
  return errors;
}

let activeState = null, activeRecords = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (activeState) {
    const errors = restore(activeState);
    const record = emit('signal_restore', { signal, errors, user_id: activeState.user_id, project_id: activeState.project_id,
      material_ids: activeState.material_ids, job_ids: activeState.job_ids });
    if (activeRecords) { activeRecords.push(record); persistEvidence(activeRecords); }
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
});

async function cleanupSynthetic(state, record) {
  if (!state.user_id && /^[a-z][a-z0-9_]{2,31}$/.test(state.username)) {
    const found = rows(`SELECT id FROM bb_users WHERE username='${state.username}'`);
    if (found[0]) { state.user_id = uuid(found[0][0]); save(state); }
  }
  if (state.user_id && !state.project_id) {
    const found = rows(`SELECT id FROM bb_projects WHERE owner_user_id=${qid(state.user_id)} AND name='SYNTHETIC recovery drill' ORDER BY created_at DESC LIMIT 1`);
    if (found[0]) { state.project_id = uuid(found[0][0]); save(state); }
  }
  if (!state.user_id || !state.project_id) return true;
  try {
    const existing = rows(`SELECT status FROM bb_users WHERE id=${qid(state.user_id)}`)[0];
    if (existing?.[0] === 'closed') { record('cleanup', { user_id: state.user_id, project_id: state.project_id, status: 'already_closed' }); return true; }
    await login(state);
    await request('DELETE', `/api/v1/projects/${uuid(state.project_id)}`);
    await request('POST', '/api/v1/account/closure', { password: state.password, confirm_username: state.username });
    record('cleanup', { user_id: state.user_id, project_id: state.project_id, status: 'closed' });
    return true;
  } catch (error) {
    record('cleanup', { user_id: state.user_id, project_id: state.project_id, status: 'manual_recovery_required', reason: short(error) });
    return false;
  }
}

if (mode === 'recover') {
  if (!existsSync(stateFile)) throw new Error('No saved drill state');
  const state = load();
  if (state.expected_sha !== expectedSha || JSON.stringify(state.ids) !== JSON.stringify(ids)) throw new Error('State service IDs or commit differ');
  const errors = restore(state);
  emit('recover', { service_ids: ids, trigger_removed: !state.trigger_name, errors });
  if (!errors.length && !await cleanupSynthetic(state, emit)) process.exitCode = 1;
  if (errors.length) process.exitCode = 1;
} else {
  const records = [];
  const record = (phase, values) => records.push(emit(phase, values));
  const preflight = checkServices();
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
  if (health.status !== 200) throw new Error('API health check failed');
  guard(null, 'preflight_guard');
  record('preflight', preflight);
  if (mode === 'preflight') persistEvidence(records);
  else {
    if (existsSync(stateFile)) throw new Error('Existing state requires recover before a new run');
    const state = { expected_sha: expectedSha, ids, username: `synthetic79_${randomBytes(6).toString('hex')}`,
      password: randomBytes(24).toString('base64url'), user_id: null, project_id: null, upload_ids: [], material_ids: [], job_ids: [],
      ops_paused: false, worker_paused: false, worker_killed: false, trigger_name: null, trigger_table: null,
      original_gate: preflight.gate_state, original_gate_seq: preflight.gate_seq };
    save(state);
    activeState = state; activeRecords = records;
    let succeeded = false;
    try {
      // D1: stop only the deployed scheduler, then use the deployed API to create scoped events.
      guard(state, 'd1_guard'); pause('ops', state);
      const agreement = await request('GET', '/api/v1/auth/agreement');
      const account = await request('POST', '/api/v1/auth/register', { username: state.username, password: state.password, accepted_terms_version: agreement.terms_version });
      state.user_id = uuid(account.user_id); save(state);
      const project = await request('POST', '/api/v1/projects', { name: 'SYNTHETIC recovery drill', kind: 'update', issuer_name: null, market: null, offering: null });
      state.project_id = uuid(project.project_id); save(state);
      record('d1_during', ownerSnapshot(state.user_id));
      if (ownerSnapshot(state.user_id).pending < 2) throw new Error('D1 did not create a visible backlog');
      guard(state, 'd1_recovery_guard'); unpause('ops', state);
      await until(() => { const current = ownerSnapshot(state.user_id); return current.pending === 0 && current.receipt_ids.length === current.outbox_ids.length ? current : null; }, 90000, 'D1 replay');
      const d1 = ownerSnapshot(state.user_id);
      if (new Set(d1.delivery_keys).size !== d1.delivery_keys.length) throw new Error('D1 duplicate delivery key');
      const physical = sinkKeyCounts(d1.delivery_keys);
      if (Object.values(physical).some(count => count !== 1)) throw new Error('D1 sink key reconciliation failed');
      record('d1_after', { ...d1, sink_key_counts: physical });
      await sleep(35000);
      const replay = ownerSnapshot(state.user_id);
      if (replay.receipt_ids.length !== d1.receipt_ids.length) throw new Error('D1 replay changed receipt count');
      record('d1_replay', { user_id: state.user_id, receipts: replay.receipt_ids.length, unique_delivery_keys: new Set(replay.delivery_keys).size });

      // D2: queue via real upload while the named deployed worker is briefly paused.
      guard(state, 'd2_guard'); pause('worker', state);
      const d2Id = await upload(state, 'synthetic79_crash', 4096);
      record('d2_before', jobSnapshot(d2Id));
      const d2Trigger = `bb_drill79_${randomBytes(6).toString('hex')}`;
      state.trigger_name = d2Trigger; state.trigger_table = 'bb_parse_snapshots'; save(state);
      sql(`CREATE FUNCTION ${d2Trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.material_id=${qid(state.material_ids.at(-1))} THEN PERFORM pg_sleep(8); END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER ${d2Trigger} BEFORE INSERT ON bb_parse_snapshots FOR EACH ROW EXECUTE FUNCTION ${d2Trigger}()`);
      record('d2_trigger_armed', { trigger_name: d2Trigger, material_id: state.material_ids.at(-1) });
      guard(state, 'd2_fault_guard'); unpause('worker', state);
      await until(() => jobSnapshot(d2Id).state === 'running', 30000, 'D2 claim');
      guard(state, 'd2_kill_guard');
      if (compose('ps', '-q', 'worker') !== ids.worker) throw new Error('Worker changed before fault');
      state.worker_killed = true; save(state); docker('kill', '-s', 'KILL', ids.worker);
      record('d2_during', jobSnapshot(d2Id));
      removeTrigger(state); record('d2_trigger_removed', { trigger_name: d2Trigger, job_id: d2Id });
      restore(state);
      const d2Done = await until(() => { const current = jobSnapshot(d2Id); return ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null; }, 180000, 'D2 lease recovery');
      record('d2_after', d2Done);
      if (d2Done.state !== 'succeeded' || d2Done.attempts < 2 || d2Done.terminal_count !== 1) throw new Error('D2 recovery invariant failed');
      const d2Logs = await waitJobLogs(d2Id);
      if (Object.values(sinkKeyCounts(d2Logs.delivery_keys)).some(count => count !== 1)) throw new Error('D2 sink key reconciliation failed');
      record('d2_logs_after', { ...d2Logs, sink_key_counts: sinkKeyCounts(d2Logs.delivery_keys) });

      // D3: one scoped first-attempt terminal transaction abort; the normal worker retries.
      guard(state, 'd3_guard'); pause('worker', state);
      const d3Id = await upload(state, 'synthetic79_transaction', 4096);
      record('d3_before', jobSnapshot(d3Id));
      const name = `bb_drill79_${randomBytes(6).toString('hex')}`;
      state.trigger_name = name; state.trigger_table = 'bb_outbox'; save(state); // recover can remove a trigger after SIGKILL.
      sql(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.aggregate_type='material_parse_job' AND NEW.aggregate_id=${qid(d3Id)} AND NEW.event_type='material_parse.succeeded'
          AND (SELECT attempts FROM bb_jobs WHERE id=${qid(d3Id)})=1 THEN
          RAISE EXCEPTION 'synthetic transaction fault' USING ERRCODE='P0001'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER ${name} BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      record('d3_trigger_armed', { trigger_name: name, job_id: d3Id });
      guard(state, 'd3_fault_guard'); unpause('worker', state);
      const d3During = await until(() => { const current = jobSnapshot(d3Id); return current.attempts >= 2 || current.state === 'failed' ? current : null; }, 60000, 'D3 fault');
      record('d3_during', d3During);
      removeTrigger(state); record('d3_trigger_removed', { trigger_name: name, job_id: d3Id });
      const d3Done = await until(() => { const current = jobSnapshot(d3Id); return ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null; }, 120000, 'D3 recovery');
      record('d3_after', d3Done);
      if (d3Done.state !== 'succeeded' || d3Done.attempts < 2 || d3Done.terminal_count !== 1 ||
          !d3Done.job_event_types.includes('material_parse.retry_scheduled')) throw new Error('D3 recovery invariant failed');
      const d3Logs = await waitJobLogs(d3Id);
      if (Object.values(sinkKeyCounts(d3Logs.delivery_keys)).some(count => count !== 1)) throw new Error('D3 sink key reconciliation failed');
      record('d3_logs_after', { ...d3Logs, sink_key_counts: sinkKeyCounts(d3Logs.delivery_keys) });
      const gate = rows('SELECT state,seq FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')[0] ?? ['open', '0'];
      if (preflight.gate_state === 'paused' && gate[0] !== 'paused') throw new Error('Original paused gate changed');
      record('gate_after', { before: preflight.gate_state, after: gate[0], before_seq: preflight.gate_seq, after_seq: Number(gate[1]) });
      succeeded = true;
    } catch (error) { record('failure', { reason: short(error), ids: { user_id: state.user_id, project_id: state.project_id, material_ids: state.material_ids, job_ids: state.job_ids } }); process.exitCode = 1; }
    finally {
      const errors = restore(state);
      record('restore', { errors, service_ids: ids });
      if (errors.length) process.exitCode = 1;
      if (!await cleanupSynthetic(state, record)) process.exitCode = 1;
      persistEvidence(records);
      if (succeeded && !process.exitCode) unlinkSync(stateFile);
      activeState = null; activeRecords = null;
    }
  }
}
