// SYNTHETIC PostgreSQL/Azurite test for the #79/#16 operator-only platform probe. It claims jobs
// globally, so it runs in its own clone of the migrated template (see test-database.ts). The fake
// codex replays synthetic JSONL; no provider is called and no credential is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type AnySchema } from 'ajv';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { platformProbeSchemas, schemas, billingDtoSchema, Int64Schema, BILLING_WIRE_HEADER, BILLING_WIRE_VERSION, LEGACY_BILLING_WIRE_VERSION } from '@bondbuddy/contracts';
import { azureBlobs, uid } from '@bondbuddy/api/data';
import { grantOperator, purgeLogContent } from '@bondbuddy/api/log-ops';
import { claim } from '@bondbuddy/api/queue';
import { setKillSwitch, trialConfigFromEnv } from '@bondbuddy/api/trial-guard';
import { assertCodexConfig, codexProxyEnv, DEFAULT_DISABLED_FEATURES, runCodexProcess, type CodexAdapterConfig } from './codex-adapter.js';
import { assertProbeConfig, PLATFORM_PROBE_TEMPLATES, runPlatformProbeOnce } from './platform-probe-job.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_CODEX_DATABASE_URL');
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const fake = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));
const baseConfig = (root: string, scenario: string): CodexAdapterConfig => ({ command: [process.execPath, fake, `--fake-scenario=${scenario}`], model_id: 'deepseek-flash', model_provider: 'deepseek', base_url: 'https://api.deepseek.com', wire_api: 'responses', model_config_version: 'codex-deepseek-flash-test', reasoning_effort: null, credential: { kind: 'env', name: 'BB_SYNTHETIC_DEEPSEEK_KEY' }, work_root: join(root, 'work'), timeout_ms: 2000, kill_grace_ms: 100, max_output_bytes: 1 << 20, max_schema_reasks: 1, disabled_features: DEFAULT_DISABLED_FEATURES, path_env: '/usr/bin:/bin', proxy_env: { HTTPS_PROXY: 'http://egress:3128', NO_PROXY: 'postgres,azurite' } });

test('proxy variables reach codex; proxy userinfo and auth.json mode are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-probe-proxy-'));
  try {
    const config = baseConfig(root, 'probe_echo');
    const seen: Record<string, unknown>[] = [];
    await rm(config.work_root, { recursive: true, force: true });
    const home = await mkdtemp(join(root, 'home-')), cwd = await mkdtemp(join(root, 'cwd-'));
    const r = await runCodexProcess(config, { prompt: 'synthetic', cwd, codexHome: home, home, schemaFile: null, ephemeral: true, resumeThreadId: null, onEvent: e => seen.push(e) });
    assert.equal(r.turn_completed, true);
    const trace = seen.find(e => e.type === 'fake.trace') as { env_keys: string[] } | undefined;
    assert.ok(trace, 'fake trace event');
    assert.ok(trace.env_keys.includes('HTTPS_PROXY') && trace.env_keys.includes('NO_PROXY'));
    assert.deepEqual(codexProxyEnv({ HTTPS_PROXY: 'http://egress:3128', https_proxy: 'http://egress:3128', HTTP_PROXY: 'x', DEEPSEEK_API_KEY: 'never' }), { HTTPS_PROXY: 'http://egress:3128', https_proxy: 'http://egress:3128' });
    assert.throws(() => assertCodexConfig({ ...config, proxy_env: { HTTPS_PROXY: 'http://user:pw@egress:3128' } }));
    assert.throws(() => assertCodexConfig({ ...config, proxy_env: { DEEPSEEK_API_KEY: 'x' } }));
    assert.throws(() => assertProbeConfig({ ...config, credential: { kind: 'auth_file', path: '/tmp/auth.json' } }, {}), /auth.json/);
    assert.doesNotThrow(() => assertProbeConfig({ ...config, credential: { kind: 'command', path: '/usr/local/bin/bb-copilot-token', oauth_file: '/run/secrets/bb-copilot-oauth' } }, {}));
    assert.throws(() => assertProbeConfig(config, {}), /is not set/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('synthetic platform probe: operator-only enqueue, separate claim, durable #79 rows, timeline, kill switch', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const blobs = azureBlobs(blobConnection!, 'bondbuddy-m1-34-probe');
  const root = await mkdtemp(join(tmpdir(), 'bb-probe-durable-'));
  let principal = '';
  const trial = { ...trialConfigFromEnv({}), enabled: true };
  const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test', principal: async request => ({ userId: String(request.headers['x-synthetic-user']), csrfVerified: true }), trial });
  const send = (user: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin: 'http://bondbuddy.test', 'x-synthetic-user': user }, payload: payload as any });
  const user = async (prefix: string) => { const id = `${prefix}-${uid().slice(0, 8)}`; await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `u${id.replace(/-/g, '_').toLowerCase()}`.slice(0, 32)]); return id; };
  const ajv = new Ajv({ strict: false });
  const validResponse = ajv.compile(platformProbeSchemas.PlatformProbeResponse);
  process.env.BB_SYNTHETIC_DEEPSEEK_KEY = 'synthetic-not-a-key';
  try {
    assert.equal((await pool.query("SELECT count(*)::int c FROM bb_jobs WHERE state IN ('queued','running')")).rows[0].c, 0, 'requires a dedicated database');
    principal = (await pool.query("SELECT user_id FROM bb_platform_principals WHERE purpose='platform_probe'")).rows[0].user_id;
    assert.equal((await pool.query('SELECT status FROM bb_users WHERE id=$1', [principal])).rows[0].status, 'disabled', 'the platform principal cannot sign in');
    const nobody = await user('probe-none'), reader = await user('probe-reader'), operator = await user('probe-op');
    await grantOperator(pool, { userId: reader, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    await grantOperator(pool, { userId: operator, role: 'log_operator', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    await grantOperator(pool, { userId: operator, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    const body = (requestId: string) => ({ template_id: 'bb_probe_json_echo_v1', request_id: requestId, reason_code: 'live_probe_evidence' });

    // Deny by default: no grant and log_reader both get the owner-safe 404; bad input is 422.
    assert.equal((await send(nobody, 'POST', '/api/v1/admin/probes/model', body('synthetic-probe-0001'))).statusCode, 404);
    assert.equal((await send(reader, 'POST', '/api/v1/admin/probes/model', body('synthetic-probe-0001'))).statusCode, 404);
    assert.equal((await send(operator, 'POST', '/api/v1/admin/probes/model', { ...body('synthetic-probe-0001'), template_id: 'free_text' })).statusCode, 422);
    assert.equal((await send(operator, 'POST', '/api/v1/admin/probes/model', { ...body('synthetic-probe-0001'), user_id: nobody })).statusCode, 422);

    const created = await send(operator, 'POST', '/api/v1/admin/probes/model', body('synthetic-probe-0001'));
    assert.equal(created.statusCode, 202, created.body);
    const probe = created.json();
    assert.ok(validResponse(probe), JSON.stringify(validResponse.errors));
    assert.equal(probe.state, 'queued'); assert.equal(probe.replayed, false);
    const replay = await send(operator, 'POST', '/api/v1/admin/probes/model', body('synthetic-probe-0001'));
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().job_id, probe.job_id); assert.equal(replay.json().replayed, true);
    const job = (await pool.query('SELECT owner_user_id,job_type,subtype FROM bb_jobs WHERE id=$1', [probe.job_id])).rows[0];
    assert.deepEqual([job.owner_user_id, job.job_type, job.subtype], [principal, 'platform_probe', 'model_probe']);
    const audit = (await pool.query("SELECT actor_id,actor_role,reason_code FROM bb_log_access_audit WHERE purpose='platform_probe_enqueue' AND target_ref=$1", [probe.job_id])).rows;
    assert.deepEqual(audit, [{ actor_id: operator, actor_role: 'log_operator', reason_code: 'live_probe_evidence' }]);

    // The run pipeline's claim never picks up a probe.
    assert.equal(await claim(pool, 30), null);

    // Worker: fixed template through the contained adapter and durable journal.
    assert.equal(await runPlatformProbeOnce({ pool, blobs, config: baseConfig(root, 'probe_echo') }), 'succeeded');
    assert.equal(await runPlatformProbeOnce({ pool, blobs, config: baseConfig(root, 'probe_echo') }), 'idle');
    const rows = (await pool.query(`SELECT a.status,a.usage_status,a.model_id,a.prompt_snapshot_id,o.outcome,o.input_tokens,o.cached_input_tokens,o.output_tokens,o.reasoning_tokens,t.pricing_status,t.provider_request_id_status,t.adapter
      FROM bb_model_call_attempts a JOIN bb_provider_call_observations o ON o.attempt_id=a.id JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id WHERE a.job_id=$1`, [probe.job_id])).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].status, rows[0].usage_status, rows[0].outcome, rows[0].model_id, rows[0].pricing_status, rows[0].provider_request_id_status, rows[0].adapter], ['completed', 'measured', 'completed', 'deepseek-flash', 'unknown', 'unknown', 'codex_exec']);
    assert.deepEqual([rows[0].input_tokens, rows[0].cached_input_tokens, rows[0].output_tokens, rows[0].reasoning_tokens], [8418, 6784, 46, 33]);
    const snapshot = (await pool.query('SELECT snapshot_kind,template_version,redaction_version,input_revision,input_hash,object_key FROM bb_snapshot_refs WHERE id=$1', [rows[0].prompt_snapshot_id])).rows[0];
    const probeRun = (await pool.query('SELECT input_revision,input_hash FROM bb_runs WHERE id=$1', [probe.run_id])).rows[0];
    assert.deepEqual([snapshot.snapshot_kind, snapshot.template_version, snapshot.redaction_version, snapshot.input_revision, snapshot.input_hash.trim()],
      ['model_request', 'bb_probe_json_echo_v1', 'synthetic_probe_v1', probeRun.input_revision, probeRun.input_hash.trim()]);
    assert.equal((await blobs.get(snapshot.object_key)).toString('utf8'), PLATFORM_PROBE_TEMPLATES.bb_probe_json_echo_v1.prompt);
    assert.equal((await pool.query('SELECT registered_at IS NOT NULL AS registered FROM bb_prompt_blob_intents WHERE object_key=$1', [snapshot.object_key])).rows[0].registered, true);
    const ledger = (await pool.query('SELECT owner_user_id,usage_status,input_tokens,pricing_status FROM bb_platform_cost_ledger WHERE job_id=$1', [probe.job_id])).rows;
    assert.deepEqual(ledger, [{ owner_user_id: principal, usage_status: 'measured', input_tokens: 8418, pricing_status: 'rate_missing' }]);
    const run = (await pool.query('SELECT state,artifact_id FROM bb_runs WHERE id=$1', [probe.run_id])).rows[0];
    assert.deepEqual(run, { state: 'succeeded', artifact_id: null });

    // Admin job timeline (log_reader) shows the probe with its attempt, usage and outcome.
    const timeline = await send(reader, 'GET', probe.timeline_path);
    assert.equal(timeline.statusCode, 200, timeline.body);
    const t = timeline.json();
    assert.deepEqual([t.job.job_type, t.job.user_id, t.job.state, t.outcome.state, t.outcome.artifact_available], ['platform_probe', principal, 'succeeded', 'succeeded', false]);
    assert.equal(timeline.headers[BILLING_WIRE_HEADER], BILLING_WIRE_VERSION);
    assert.ok(ajv.validate(billingDtoSchema(schemas.AdminJobTimelineResponse, 'adminJobTimeline', Int64Schema) as AnySchema, t), JSON.stringify(ajv.errors));
    assert.deepEqual(t.attempts.map((a: any) => [a.status, a.usage_status, a.usage.input_tokens]), [['completed', 'measured', '8418']]);
    assert.deepEqual(t.attempts[0].usage, { input_tokens: '8418', cached_input_tokens: '6784', output_tokens: '46', reasoning_tokens: '33' });
    assert.equal(t.attempts[0].attempt_no, 1);
    assert.equal(typeof t.attempts[0].duration_ms, 'number');
    const measuredUsage = { attempts: '1', measured_attempts: '1', unresolved_attempts: '0', ...t.attempts[0].usage };
    assert.deepEqual(t.consumption, { all_attempts: measuredUsage, completed_attempts: measuredUsage });
    const legacy = await app.inject({ url: probe.timeline_path, headers: { 'x-synthetic-user': reader, [BILLING_WIRE_HEADER]: LEGACY_BILLING_WIRE_VERSION } });
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.headers[BILLING_WIRE_HEADER], LEGACY_BILLING_WIRE_VERSION);
    assert.ok(ajv.validate(schemas.AdminJobTimelineResponse, legacy.json()), JSON.stringify(ajv.errors));
    assert.deepEqual(legacy.json().attempts[0].usage, { input_tokens: 8418, cached_input_tokens: 6784, output_tokens: 46, reasoning_tokens: 33 });
    assert.equal(legacy.json().consumption.all_attempts.attempts, 1);
    assert.equal(t.prompts.length, 1);

    // Kill switch: rejects a new probe up front, and fails an already queued probe before any intent.
    const queued = await send(operator, 'POST', '/api/v1/admin/probes/model', body('synthetic-probe-0002'));
    assert.equal(queued.statusCode, 202);
    await setKillSwitch(pool, trial, operator, 'engaged', 'synthetic_drill');
    assert.equal((await send(operator, 'POST', '/api/v1/admin/probes/model', body('synthetic-probe-0003'))).statusCode, 503);
    assert.equal(await runPlatformProbeOnce({ pool, blobs, config: baseConfig(root, 'probe_echo') }), 'failed');
    const killed = (await pool.query('SELECT j.state,j.error_code,(SELECT count(*)::int FROM bb_model_call_attempts a WHERE a.job_id=j.id) attempts FROM bb_jobs j WHERE j.id=$1', [queued.json().job_id])).rows[0];
    assert.deepEqual(killed, { state: 'failed', error_code: 'MODEL_CALLS_SUSPENDED', attempts: 0 });
    await setKillSwitch(pool, trial, operator, 'released', 'synthetic_drill');

    // The production worker path must leave a replayable address if Blob upload
    // succeeds but snapshot registration and compensating deletion both fail.
    const broken = (await send(operator, 'POST', '/api/v1/admin/probes/model', body('synthetic-probe-orphan-0001'))).json();
    assert.match(broken.run_id, /^[a-f0-9-]{36}$/);
    await pool.query(`CREATE FUNCTION bb_test_reject_probe_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.run_id='${broken.run_id}' THEN RAISE EXCEPTION 'synthetic reference failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER bb_test_reject_probe_snapshot BEFORE INSERT ON bb_snapshot_refs FOR EACH ROW EXECUTE FUNCTION bb_test_reject_probe_snapshot()');
    const failedDeleteBlobs = { ...blobs, async delete(_key: string) { throw new Error('synthetic Blob delete outage'); } };
    try {
      assert.equal(await runPlatformProbeOnce({ pool, blobs: failedDeleteBlobs, config: baseConfig(root, 'probe_echo') }), 'failed');
    } finally {
      await pool.query('DROP TRIGGER bb_test_reject_probe_snapshot ON bb_snapshot_refs');
      await pool.query('DROP FUNCTION bb_test_reject_probe_snapshot()');
    }
    const orphan = (await pool.query('SELECT object_key FROM bb_prompt_blob_intents WHERE owner_user_id=$1 AND registered_at IS NULL AND cleared_at IS NULL', [principal])).rows[0];
    assert.ok(orphan);
    assert.equal(await blobs.exists(orphan.object_key), true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE run_id=$1', [broken.run_id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1', [broken.job_id])).rows[0].n, 0);
    assert.equal((await purgeLogContent(pool, failedDeleteBlobs, { contentRetentionDays: 180, ownerScope: [principal] })).orphanFailed, 1);
    const restarted = new Pool({ connectionString: connection });
    try {
      assert.equal((await purgeLogContent(restarted, blobs, { contentRetentionDays: 180, ownerScope: [principal] })).orphanPurged, 1);
      assert.equal((await purgeLogContent(restarted, blobs, { contentRetentionDays: 180, ownerScope: [principal] })).orphanDue, 0);
    } finally { await restarted.end(); }
    assert.equal(await blobs.exists(orphan.object_key), false);
    assert.equal(await blobs.exists(snapshot.object_key), true, 'the successful probe remains authorized and intact');

    // User data is out of reach: the principal cannot own user work and users cannot own probes.
    const own = await user('probe-owner');
    await assert.rejects(pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'x','update')", [uid(), principal]).then(() => pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) SELECT $1,$2,'bb-platform-probe-project',1,input_hash,$3,'update',input_hash,'preparing' FROM bb_input_revisions WHERE owner_user_id=$2", [uid(), principal, uid()])), /only owns platform probes/);
    await assert.rejects(pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,'p',1,repeat('a',64),$3,'platform_probe',repeat('a',64),'preparing')", [uid(), own, uid()]), /owned by the platform principal/);
  } finally {
    delete process.env.BB_SYNTHETIC_DEEPSEEK_KEY;
    await app.close(); await pool.end(); await rm(root, { recursive: true, force: true });
  }
});
