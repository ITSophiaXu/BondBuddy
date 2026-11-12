import type {TSchema} from '@sinclair/typebox';
import {billingDtoSchema,Int64Schema} from '@bondbuddy/contracts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { schemas } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, uid } from './data.js';
import { observeUsage } from './observability.js';
import { recordPotentialCall, type Lease } from './queue.js';
import { resetProcessGateForTests, tripEvidenceGate } from './evidence-gate.js';
import { grantOperator } from './log-ops.js';
import { checkTrialHealth, configureTrialGuard, recordWorkerHeartbeat, trialConfigFromEnv, type TrialConfig } from './trial-guard.js';
import { lockSyntheticAuthoringInput, quoteSyntheticAuthoringRun, syntheticAuthoringBlobs } from './test-authoring-source.js';
import { creditBalanceExact } from './billing.js';

// #35 trial guard. Synthetic data only: no real provider, credential or customer material.
import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const skip = !connection || !blobConnection;
const ORIGIN = 'http://bondbuddy.test';

const base = (overrides: Partial<TrialConfig> = {}): TrialConfig => ({ ...trialConfigFromEnv({ BB_TRIAL_GUARD: 'on' }), global_active_runs: 100000, ...overrides });

async function user(pool: Pool, prefix: string) {
  const id = `${prefix}-${uid().slice(0, 8)}`;
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `u${id.replace(/-/g, '_').toLowerCase()}`.slice(0, 32)]);
  return id;
}

async function openGate(pool: Pool) {
  await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) SELECT $1,'open','synthetic_test_reset','system' WHERE (SELECT state FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1)='paused'", [uid()]);
  resetProcessGateForTests();
}

function harness(pool: Pool, trial: TrialConfig, options: { blobs?: boolean } = {}) {
  let current = '';
  // These original trial/model-usage contracts reuse uncharged inputs across attempts.
  const app = createServer({ pool, blobs: options.blobs === false ? undefined : azureBlobs(blobConnection!), allowedOrigin: ORIGIN, principal: async () => ({ userId: current, csrfVerified: true }), enableSyntheticQueue: true, trial,
    historicalBillingFixture: true, enablePaidAuthoring: false });
  const as = (userId: string, remoteAddress = '198.51.100.7') => (method: string, url: string, payload?: unknown) => { current = userId; return app.inject({ method: method as never, url, remoteAddress, headers: { origin: ORIGIN }, payload: payload as never }); };
  async function project(owner: string, remoteAddress?: string) {
    const created = await as(owner, remoteAddress)('POST', '/api/v1/projects', { name: 'synthetic trial', kind: 'update', issuer_name: null, market: null, offering: null });
    return created;
  }
  async function submit(owner: string, projectId: string, inputHash: string, executionId = `exec-${uid()}`) {
    return as(owner)('POST', '/api/v1/runs/execute', { execution_request_id: executionId, project_id: projectId, input_revision: 1, input_hash: inputHash, task_kind: 'update', input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-workspace' });
  }
  async function ready(owner: string) {
    const p = (await project(owner)).json().project_id as string;
    const input = (await as(owner)('POST', `/api/v1/projects/${p}/input-revisions`, { draft_revision: 1, material_versions: [], requirement_message_ids: [] })).json();
    return { projectId: p, inputHash: input.input_hash as string };
  }
  async function leaseFor(owner: string, runId: string): Promise<Lease> {
    const token = uid();
    const job = (await pool.query("UPDATE bb_jobs SET state='running',stage='claimed',lease_token=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE run_id=$1 RETURNING id,checkpoint", [runId, token])).rows[0];
    await pool.query("UPDATE bb_runs SET state='running' WHERE id=$1", [runId]);
    return { jobId: job.id, runId, owner, token, checkpoint: job.checkpoint, attempts: 1 };
  }
  return { app, as, project, submit, ready, leaseFor };
}

const rejected = async (pool: Pool, owner: string, kind: string) =>
  (await pool.query("SELECT error_code FROM bb_operations WHERE owner_user_id=$1 AND operation_kind=$2 AND status='rejected' ORDER BY created_at", [owner, kind])).rows.map(r => r.error_code);
const alertFor = async (pool: Pool, limit: string, scope: string) =>
  (await pool.query("SELECT detail FROM bb_ops_alerts WHERE kind='trial_quota_exhausted' AND dedupe_key LIKE $1", [`trial_quota_exhausted:${limit}:${scope}:%`])).rows.length;

test('config: guard is off outside production unless enabled, and bad values fail closed', () => {
  assert.equal(trialConfigFromEnv({}).enabled, false);
  assert.equal(trialConfigFromEnv({ NODE_ENV: 'production' }).enabled, true);
  assert.equal(trialConfigFromEnv({ NODE_ENV: 'production', BB_TRIAL_GUARD: 'off' }).enabled, false);
  assert.equal(trialConfigFromEnv({ BB_TRIAL_KILL_SWITCH: '1' }).kill_switch_config, true);
  assert.throws(() => trialConfigFromEnv({ BB_TRIAL_ACTIVE_RUNS_PER_USER: '-1' }));
  assert.throws(() => trialConfigFromEnv({ BB_TRIAL_GUARD: 'maybe' }));
  assert.throws(() => trialConfigFromEnv({ BB_TRIAL_DAY_TIME_ZONE: 'Not/AZone' }));
});

test('daily limits stay retired even when legacy production environment values remain', () => {
  for (const value of ['1', '2000000', '-1', 'obsolete']) {
    const config = trialConfigFromEnv({ NODE_ENV: 'production', BB_TRIAL_GUARD: 'on',
      BB_TRIAL_RUNS_PER_USER_PER_DAY: value, BB_TRIAL_MODEL_TOKENS_PER_USER_PER_DAY: value,
      BB_TRIAL_PROJECTS_PER_USER_PER_DAY: value, BB_TRIAL_UPLOAD_BYTES_PER_USER_PER_DAY: value });
    for (const key of ['runs_per_user_per_day', 'model_tokens_per_user_per_day', 'projects_per_user_per_day', 'upload_bytes_per_user_per_day'] as const)
      assert.equal(config[key], 0, `${key} must report unlimited`);
    assert.equal(config.enabled, true);
    assert.equal(config.active_runs_per_user, 2);
  }
});

test('health and readiness probes', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    await openGate(pool);
    const { app } = harness(pool, base());
    const live = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: 'ok', service: 'bondbuddy-m1-api' });
    const workerId = `synthetic-worker-${uid().slice(0, 8)}`;
    await pool.query('UPDATE bb_worker_heartbeats SET stopped_at=now() WHERE stopped_at IS NULL');
    let ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().checks.worker_heartbeat, 'missing');
    await recordWorkerHeartbeat(pool, { workerId, startedAt: new Date(), kinds: ['run', 'parse'], concurrency: 2 });
    ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.ok(Value.Check(schemas.ReadinessResponse, ready.json()));
    assert.deepEqual(ready.json().checks, { database: 'ok', blob_storage: 'ok', evidence_gate: 'ok', worker_heartbeat: 'ok' });
    await pool.query("UPDATE bb_worker_heartbeats SET last_seen_at=now()-interval '10 minutes' WHERE worker_id=$1", [workerId]);
    ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().checks.worker_heartbeat, 'stale');
    assert.ok(ready.json().worker_heartbeat_age_seconds >= 590);
    await recordWorkerHeartbeat(pool, { workerId, startedAt: new Date(), kinds: ['run'], concurrency: 1 });
    await tripEvidenceGate(pool, 'synthetic_trial_drill');
    ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().checks.evidence_gate, 'paused');
    await openGate(pool);
    const noBlob = harness(pool, base(), { blobs: false }).app;
    assert.equal((await noBlob.inject({ method: 'GET', url: '/api/v1/ready' })).json().checks.blob_storage, 'failed');
    // A broken database yields check states only: no error text, host or port leaks.
    const broken = createServer({ pool: new Pool({ connectionString: 'postgres://synthetic:synthetic@127.0.0.1:1/none', connectionTimeoutMillis: 500 }), trial: base() });
    const down = await broken.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().checks.database, 'failed');
    assert.equal(/127\.0\.0\.1|ECONN|synthetic@/.test(down.body), false);
    await recordWorkerHeartbeat(pool, { workerId, startedAt: new Date(), kinds: ['run'], concurrency: 1, stopped: true });
  } finally { await pool.end(); }
});

test('run admission retains concurrency and idempotency but ignores daily counts', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    await openGate(pool);
    const h = harness(pool, base({ active_runs_per_user: 1, runs_per_user_per_day: 2 }));
    const owner = await user(pool, 'trial-runs');
    const { projectId, inputHash } = await h.ready(owner);
    const first = await h.submit(owner, projectId, inputHash, 'exec-trial-first');
    assert.equal(first.statusCode, 202, first.body);
    const second = await h.submit(owner, projectId, inputHash);
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().code, 'TRIAL_QUOTA_EXCEEDED');
    assert.match(second.json().message, /active_runs_per_user/);
    // Replaying the same execution_request_id returns the same run, even at the limit.
    const replay = await h.submit(owner, projectId, inputHash, 'exec-trial-first');
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().run_id, first.json().run_id);
    assert.deepEqual(await rejected(pool, owner, 'execute'), ['TRIAL_QUOTA_EXCEEDED']);
    assert.equal(await alertFor(pool, 'active_runs_per_user', owner), 1);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [first.json().run_id]);
    assert.equal((await h.submit(owner, projectId, inputHash)).statusCode, 202);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE owner_user_id=$1", [owner]);
    const daily = await h.submit(owner, projectId, inputHash);
    assert.equal(daily.statusCode, 202, daily.body);
    assert.equal(await alertFor(pool, 'runs_per_user_per_day', owner), 0);
    // A global cap is shared by every account and cannot be bypassed by an allow override.
    const active = (await pool.query("SELECT count(*)::int n FROM bb_runs WHERE state IN ('preparing','queued','running','validating','delivering')")).rows[0].n;
    const g = harness(pool, base({ global_active_runs: active + 1 }));
    const a = await user(pool, 'trial-global-a'), b = await user(pool, 'trial-global-b');
    const pa = await g.ready(a), pb = await g.ready(b);
    assert.equal((await g.submit(a, pa.projectId, pa.inputHash)).statusCode, 202);
    const operatorUser = await user(pool, 'trial-op');
    await grantOperator(pool, { userId: operatorUser, role: 'log_operator', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    assert.equal((await g.as(operatorUser)('POST', '/api/v1/admin/trial/overrides', { user_id: b, effect: 'allow', reason_code: 'company_pilot' })).statusCode, 201);
    const blocked = await g.submit(b, pb.projectId, pb.inputHash);
    assert.equal(blocked.statusCode, 429);
    assert.match(blocked.json().message, /global_active_runs/);
    assert.equal(await alertFor(pool, 'global_active_runs', 'global'), 1);
  } finally { await pool.end(); }
});

test('a quota-rejected start can retry the same request after capacity returns without changing its input', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const h = harness(pool, base({ active_runs_per_user: 1, runs_per_user_per_day: 100 }));
  try {
    await openGate(pool);
    const owner = await user(pool, 'trial-retry');
    const occupied = await h.ready(owner), target = await h.ready(owner);
    const first = await h.submit(owner, occupied.projectId, occupied.inputHash, 'occupied-request');
    assert.equal(first.statusCode, 202, first.body);
    const retry = () => h.submit(owner, target.projectId, target.inputHash, 'same-retry-request');
    const rejected = await retry();
    assert.equal(rejected.statusCode, 429, rejected.body);
    assert.equal(rejected.json().code, 'TRIAL_QUOTA_EXCEEDED');
    assert.deepEqual(rejected.json().field_errors, [{field:'trial_limit',code:'active_runs_per_user',message:'Current processing limit reached'}]);
    const audit = (await pool.query("SELECT id,request_hash,error_code FROM bb_jobs WHERE project_id=$1 AND subtype='execute_rejected'", [target.projectId])).rows;
    assert.equal(audit.length, 1);
    assert.equal((await retry()).statusCode, 429, 'the current capacity limit is still enforced');
    const changed = await h.as(owner)('POST', '/api/v1/runs/execute', { execution_request_id:'same-retry-request', project_id:target.projectId,
      input_revision:1,input_hash:target.inputHash,task_kind:'update',input_manifest_ref:'changed-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace' });
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().code, 'IDEMPOTENCY_CONFLICT', 'a rejected key cannot be rebound to another request');
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [first.json().run_id]);
    const suspended = harness(pool, base({ kill_switch_config:true }));
    try {
      const blocked = await suspended.submit(owner, target.projectId, target.inputHash, 'same-retry-request');
      assert.equal(blocked.statusCode, 503, blocked.body);
      assert.equal(blocked.json().code, 'MODEL_CALLS_SUSPENDED', 'a retry reports the current admission failure instead of the previous quota');
    } finally { await suspended.app.close(); }
    const concurrent = await Promise.all([retry(), retry(), retry()]);
    const resumed = concurrent[0]!;
    assert.equal(resumed.statusCode, 202, resumed.body);
    assert.ok(concurrent.every(response => response.statusCode===202 && response.json().run_id===resumed.json().run_id));
    assert.equal((await retry()).json().run_id, resumed.json().run_id, 'accepted retries return exactly one run');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [target.projectId])).rows[0].n, 1);
    assert.deepEqual((await pool.query("SELECT id,request_hash,error_code FROM bb_jobs WHERE project_id=$1 AND subtype='execute_rejected'", [target.projectId])).rows, audit, 'the original rejection evidence is immutable');
  } finally { await h.app.close(); await pool.end(); }
});

test('daily token usage never blocks submit or model calls and remains fully accounted', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const config = base({ model_tokens_per_user_per_day: 1000, unknown_usage_tokens_per_attempt: 600, active_runs_per_user: 10, runs_per_user_per_day: 10 });
  configureTrialGuard(config);
  try {
    await openGate(pool);
    const h = harness(pool, config);
    const owner = await user(pool, 'trial-tokens');
    const { projectId, inputHash } = await h.ready(owner);
    const run = (await h.submit(owner, projectId, inputHash)).json().run_id as string;
    const lease = await h.leaseFor(owner, run);
    const measured = await recordPotentialCall(pool, lease, 'synthetic-call-a', 1);
    await observeUsage(pool, { owner, attemptId: measured, source: 'provider', sourceEventId: `usage-${uid()}`, status: 'measured', inputTokens: 250, outputTokens: 100 });
    await recordPotentialCall(pool, lease, 'synthetic-call-b', 1); // usage never reported: counts 600
    // 350 measured + 600 conservative = 950 < 1000: one more intent is still allowed.
    await recordPotentialCall(pool, lease, 'synthetic-call-c', 1);
    await recordPotentialCall(pool, lease, 'synthetic-call-d', 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1', [lease.jobId])).rows[0].n, 4);
    const accepted = await h.submit(owner, projectId, inputHash);
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(await alertFor(pool, 'model_tokens_per_user_per_day', owner), 0);

    // Cost ledger and daily aggregates (log_reader).
    const reader = await user(pool, 'trial-reader'), nobody = await user(pool, 'trial-none');
    await grantOperator(pool, { userId: reader, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    const status = await h.as(reader)('GET', '/api/v1/admin/trial/status');
    assert.equal(status.statusCode, 200, status.body);
    assert.ok(Value.Check(schemas.AdminTrialStatusResponse, status.json()));
    for (const key of ['runs_per_user_per_day', 'model_tokens_per_user_per_day', 'projects_per_user_per_day', 'upload_bytes_per_user_per_day'])
      assert.equal(status.json().limits[key], 0, 'admin status reports effective unlimited daily usage');
    assert.equal((await h.as(nobody)('GET', `/api/v1/admin/trial/cost-ledger?user_id=${owner}`)).statusCode, 404);
    const ledger = await h.as(reader)('GET', `/api/v1/admin/trial/cost-ledger?user_id=${owner}&limit=2`);
    assert.equal(ledger.statusCode, 200, ledger.body);
    assert.ok(Value.Check(billingDtoSchema(schemas.AdminCostLedgerResponse,"adminCostLedger",Int64Schema) as TSchema, ledger.json()));
    assert.equal(ledger.json().items.length, 2);
    assert.ok(ledger.json().next_cursor);
    const rest = await h.as(reader)('GET', `/api/v1/admin/trial/cost-ledger?user_id=${owner}&cursor=${ledger.json().next_cursor}`);
    const items = [...ledger.json().items, ...rest.json().items];
    assert.equal(items.length, 4);
    assert.ok(items.every((item: any) => item.pricing_status === 'unknown' && item.cost_amount === null));
    assert.deepEqual(items.map((item: any) => [item.usage_status, item.input_tokens, item.conservative_tokens]), [['measured', '250', '350'], ['unknown', null, '600'], ['unknown', null, '600'], ['unknown', null, '600']]);
    assert.equal((await h.as(reader)('GET', '/api/v1/admin/trial/cost-ledger?price=1')).statusCode, 422);
    const usage = await h.as(reader)('GET', `/api/v1/admin/trial/usage?user_id=${owner}`);
    assert.equal(usage.statusCode, 200, usage.body);
    assert.ok(Value.Check(billingDtoSchema(schemas.AdminTrialUsageResponse,"adminTrialUsage",Int64Schema) as TSchema, usage.json()));
    const [mine] = usage.json().per_user;
    assert.equal(mine.user_id, owner);
    assert.equal(mine.runs_created, '2');
    assert.equal(mine.attempts, '4');
    assert.equal(mine.measured_attempts, '1');
    assert.equal(mine.unresolved_attempts, '3');
    assert.deepEqual(mine.measured_tokens, { input_tokens: '250', output_tokens: '100', cached_input_tokens: '0', reasoning_tokens: '0' });
    assert.equal(mine.conservative_tokens, '2150');
    assert.equal(usage.json().totals[0].user_id, null);
    assert.equal(usage.json().totals[0].attempts, '4');
    const all = await h.as(reader)('GET', '/api/v1/admin/trial/usage');
    assert.ok(BigInt(all.json().totals[0].attempts) >= 3n);
    assert.equal((await h.as(reader)('GET', '/api/v1/admin/trial/usage?from=2026-01-01&to=2026-09-01')).statusCode, 422, 'range is bounded');
    const audits = (await pool.query("SELECT purpose FROM bb_log_access_audit WHERE actor_id=$1", [reader])).rows.map(r => r.purpose);
    assert.ok(audits.includes('trial_cost_ledger') && audits.includes('trial_usage'));
  } finally { configureTrialGuard(null); await pool.end(); }
});

test('unlimited daily usage retains concurrent task admission controls', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const config = base({ active_runs_per_user: 1, runs_per_user_per_day: 10, model_tokens_per_user_per_day: 0 });
  configureTrialGuard(config);
  try {
    await openGate(pool);
    const h = harness(pool, config);
    const owner = await user(pool, 'trial-unlimited-tokens');
    const { projectId, inputHash } = await h.ready(owner);
    const accepted = await h.submit(owner, projectId, inputHash);
    assert.equal(accepted.statusCode, 202);
    const lease = await h.leaseFor(owner, accepted.json().run_id);
    const first = await recordPotentialCall(pool, lease, 'synthetic-unlimited-first', 1);
    await observeUsage(pool, { owner, attemptId: first, source: 'provider', sourceEventId: `usage-${uid()}`, status: 'measured', inputTokens: 2_000_001, outputTokens: 1 });
    await recordPotentialCall(pool, lease, 'synthetic-unlimited-second', 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1', [lease.jobId])).rows[0].n, 2);
    const blockedByOtherLimit = await h.submit(owner, projectId, inputHash);
    assert.equal(blockedByOtherLimit.statusCode, 429);
    assert.match(blockedByOtherLimit.json().message, /active_runs_per_user/);
  } finally { configureTrialGuard(null); await pool.end(); }
});

test('platform cost is attributed once per supplier attempt using exact verified rates', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const config = base({ active_runs_per_user: 10, runs_per_user_per_day: 10, model_tokens_per_user_per_day: 10_000_000 });
  configureTrialGuard(config);
  try {
    await openGate(pool);
    const h = harness(pool, config);
    const owner = await user(pool, 'cost-owner'), reader = await user(pool, 'cost-reader');
    await grantOperator(pool, { userId: reader, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    const { projectId, inputHash } = await h.ready(owner);
    const runId = (await h.submit(owner, projectId, inputHash)).json().run_id as string;
    const lease = await h.leaseFor(owner, runId);
    const rateRef = `synthetic-${uid()}`, pricedModel = `priced-${uid()}`;
    await pool.query(`INSERT INTO bb_model_cost_rates(rate_ref,provider,model_id,effective_from,currency,input_per_million,cached_input_per_million,output_per_million,reasoning_output_per_million,verified_source_ref,recorded_by,recorded_reason)
      VALUES($1,'synthetic',$2,now()-interval '1 day','USD',1.5,0.5,2,3,'synthetic_source', 'synthetic_test','test_only')`, [rateRef, pricedModel]);
    await pool.query(`INSERT INTO bb_model_cost_rates(rate_ref,provider,model_id,effective_from,currency,input_per_million,cached_input_per_million,output_per_million,reasoning_output_per_million,verified_source_ref,recorded_by,recorded_reason)
      VALUES($1,'synthetic',$2,now()+interval '1 day','USD',2,1,3,4,'synthetic_future_source','synthetic_test','test_only')`, [`future-${uid()}`, pricedModel]);
    const add = async (logicalCallId: string, attemptNo: number, modelId: string, status: 'failed' | 'completed' | 'pending_reconcile') => {
      const attemptId = await recordPotentialCall(pool, lease, logicalCallId, attemptNo, { modelId });
      await pool.query('UPDATE bb_model_call_attempts SET status=$2 WHERE id=$1', [attemptId, status]);
      await pool.query(`INSERT INTO bb_model_call_attempt_runtime(id,owner_user_id,project_id,job_id,run_id,trace_id,attempt_id,logical_call_id,attempt_no,adapter,adapter_version,model_provider,model_config_version,provider_request_id_status,started_at,duration_ms,tool_attempts,pricing_status)
        VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,'codex_exec','synthetic_v1','synthetic','synthetic_v1','unknown',now(),1,0,'unknown')`,
      [uid(), owner, projectId, lease.jobId, runId, attemptId, logicalCallId, attemptNo]);
      return attemptId;
    };
    const failed = await add('supplier-retry', 1, pricedModel, 'failed');
    const succeeded = await add('supplier-retry', 2, pricedModel, 'completed');
    for (const [attemptId, source] of [[failed, 'provider'], [succeeded, 'gateway'], [succeeded, 'framework']] as const) {
      await observeUsage(pool, { owner, attemptId, source, sourceEventId: `usage-${uid()}`, status: 'measured', inputTokens: 1000000, cachedInputTokens: 200000, outputTokens: 500000, reasoningTokens: 100000 });
    }
    const missing = await add('unrated', 1, 'other-model', 'completed');
    await observeUsage(pool, { owner, attemptId: missing, source: 'provider', sourceEventId: `usage-${uid()}`, status: 'measured', inputTokens: 10, outputTokens: 20 });
    const pending = await add('pending-usage', 1, pricedModel, 'pending_reconcile');
    await observeUsage(pool, { owner, attemptId: pending, source: 'provider', sourceEventId: `usage-${uid()}`, status: 'pending' });
    const unknown = await add('unknown-usage', 1, pricedModel, 'pending_reconcile');
    const response = await h.as(reader)('GET', `/api/v1/admin/trial/cost-ledger?user_id=${owner}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Value.Check(billingDtoSchema(schemas.AdminCostLedgerResponse,"adminCostLedger",Int64Schema) as TSchema, response.json()));
    const items = response.json().items as any[];
    assert.equal(items.length, 5, 'retry rows remain separate');
    for (const id of [failed, succeeded]) {
      const row = items.find(item => item.attempt_id === id);
      assert.equal(row.pricing_status, 'priced');
      assert.equal(row.cost_amount, '2.4000000000');
      assert.equal(row.currency, 'USD');
      assert.equal(row.rate_ref, rateRef);
      assert.equal(row.billable, true);
      assert.equal(row.cost_bearer, 'platform');
    }
    assert.equal(items.find(item => item.attempt_id === missing).pricing_status, 'rate_missing');
    for (const id of [pending, unknown]) {
      const row = items.find(item => item.attempt_id === id);
      assert.equal(row.pricing_status, 'unknown');
      assert.equal(row.cost_amount, null);
    }
    assert.equal(response.json().pricing_status, 'unknown', 'legacy top-level field remains compatible');
    const total = items.reduce((sum, item) => sum + Number(item.cost_amount ?? 0), 0);
    assert.equal(total, 4.8, 'the duplicate gateway/framework observation is counted once');
    await assert.rejects(pool.query('DELETE FROM bb_model_cost_rates WHERE rate_ref=$1', [rateRef]));
  } finally { configureTrialGuard(null); await pool.end(); }
});

test('kill switch stops new runs and new model calls; operator-only and append-only', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const config = base({ active_runs_per_user: 10 });
  configureTrialGuard(config);
  try {
    await openGate(pool);
    const h = harness(pool, config);
    const owner = await user(pool, 'trial-kill'), reader = await user(pool, 'trial-kill-reader'), operatorUser = await user(pool, 'trial-kill-op');
    await grantOperator(pool, { userId: reader, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    await grantOperator(pool, { userId: operatorUser, role: 'log_operator', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    const { projectId, inputHash } = await h.ready(owner);
    const run = (await h.submit(owner, projectId, inputHash)).json().run_id as string;
    const lease = await h.leaseFor(owner, run);
    const retryTarget=await h.ready(owner),retryKey=`suspended-${uid()}`;
    assert.equal((await h.as(reader)('POST', '/api/v1/admin/trial/kill-switch', { state: 'engaged', reason_code: 'provider_incident' })).statusCode, 404, 'log_reader cannot write');
    const engaged = await h.as(operatorUser)('POST', '/api/v1/admin/trial/kill-switch', { state: 'engaged', reason_code: 'provider_incident' });
    assert.equal(engaged.statusCode, 200, engaged.body);
    assert.equal(engaged.json().engaged, true);
    try {
      const stopped = await h.submit(owner, retryTarget.projectId, retryTarget.inputHash,retryKey);
      assert.equal(stopped.statusCode, 503);
      assert.equal(stopped.json().code, 'MODEL_CALLS_SUSPENDED');
      assert.equal((await h.submit(owner,retryTarget.projectId,retryTarget.inputHash,retryKey)).statusCode,503);
      assert.ok((await rejected(pool, owner, 'execute')).includes('MODEL_CALLS_SUSPENDED'));
      await assert.rejects(recordPotentialCall(pool, lease, 'synthetic-kill', 1), (error: any) => error.code === 'MODEL_CALLS_SUSPENDED');
      assert.equal((await h.as(operatorUser)('POST', '/api/v1/admin/trial/kill-switch', { state: 'engaged', reason_code: 'again' })).statusCode, 409);
      const status = await h.as(reader)('GET', '/api/v1/admin/trial/status');
      assert.equal(status.statusCode, 200, status.body);
      assert.ok(Value.Check(schemas.AdminTrialStatusResponse, status.json()));
      assert.equal(status.json().kill_switch.operator_state, 'engaged');
    } finally {
      assert.equal((await h.as(operatorUser)('POST', '/api/v1/admin/trial/kill-switch', { state: 'released', reason_code: 'provider_recovered' })).statusCode, 200);
    }
    const resumed=await h.submit(owner,retryTarget.projectId,retryTarget.inputHash,retryKey);
    assert.equal(resumed.statusCode,202,resumed.body);
    assert.equal((await h.submit(owner,retryTarget.projectId,retryTarget.inputHash,retryKey)).json().run_id,resumed.json().run_id);
    await recordPotentialCall(pool, lease, 'synthetic-kill', 1);
    await assert.rejects(pool.query('DELETE FROM bb_trial_kill_switch_events'));
    // BB_TRIAL_KILL_SWITCH=1 engages independently of the operator rows.
    configureTrialGuard({ ...config, kill_switch_config: true });
    await assert.rejects(recordPotentialCall(pool, lease, 'synthetic-kill-config', 1), (error: any) => error.code === 'MODEL_CALLS_SUSPENDED');
    const configured = harness(pool, { ...config, kill_switch_config: true });
    assert.equal((await configured.submit(owner, projectId, inputHash)).json().code, 'MODEL_CALLS_SUSPENDED');
  } finally { configureTrialGuard(null); await pool.end(); }
});

test('an account admission denial is enforced until revoked, then the same start request can run',{skip},async()=>{
  const pool=new Pool({connectionString:connection}),h=harness(pool,base());
  try{
    await openGate(pool);
    const owner=await user(pool,'retry-denied'),operatorUser=await user(pool,'retry-denied-op');
    await grantOperator(pool,{userId:operatorUser,role:'log_operator',grantedBy:'synthetic-setup',reasonCode:'synthetic_test'});
    const target=await h.ready(owner),key=`denied-${uid()}`;
    const denied=await h.as(operatorUser)('POST','/api/v1/admin/trial/overrides',{user_id:owner,effect:'deny',reason_code:'synthetic_review'});
    assert.equal(denied.statusCode,201,denied.body);
    for(let attempt=0;attempt<2;attempt++){
      const blocked=await h.submit(owner,target.projectId,target.inputHash,key);
      assert.equal(blocked.statusCode,403,blocked.body);assert.equal(blocked.json().code,'TRIAL_ACCESS_DENIED');
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[target.projectId])).rows[0].n,0);
    assert.equal((await h.as(operatorUser)('POST',`/api/v1/admin/trial/overrides/${denied.json().override_id}/revoke`,{reason_code:'synthetic_reviewed'})).statusCode,200);
    const resumed=await h.submit(owner,target.projectId,target.inputHash,key);
    assert.equal(resumed.statusCode,202,resumed.body);
    assert.equal((await h.submit(owner,target.projectId,target.inputHash,key)).json().run_id,resumed.json().run_id);
  }finally{await h.app.close();await pool.end();}
});

test('abuse limits: per-account and per-source, shared source not blanket-banned, allow/deny overrides', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    const office = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const h = harness(pool, base({ projects_per_user_per_day: 2, projects_per_source_per_hour: 4, uploads_per_user_per_hour: 2, upload_bytes_per_user_per_day: 1500 }));
    const operatorUser = await user(pool, 'abuse-op');
    await grantOperator(pool, { userId: operatorUser, role: 'log_operator', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    const [a, b, c, d] = [await user(pool, 'abuse-a'), await user(pool, 'abuse-b'), await user(pool, 'abuse-c'), await user(pool, 'abuse-d')];
    assert.equal((await h.project(a, office)).statusCode, 201);
    assert.equal((await h.project(a, office)).statusCode, 201);
    const perAccount = await h.project(a, office);
    assert.equal(perAccount.statusCode, 201, 'project creation has no daily account cap');
    assert.equal((await h.project(b, office)).statusCode, 201, 'a colleague on the same office IP is not blocked by one account');
    const perSource = await h.project(c, office);
    assert.equal(perSource.statusCode, 429);
    assert.match(perSource.json().message, /projects_per_source_per_hour/);
    assert.equal((await h.project(c, '192.0.2.44')).statusCode, 201, 'other sources are unaffected');
    // Operator allow exempts a company account from per-source and per-account limits.
    const allow = await h.as(operatorUser)('POST', '/api/v1/admin/trial/overrides', { user_id: d, effect: 'allow', reason_code: 'company_pilot' });
    assert.equal(allow.statusCode, 201, allow.body);
    assert.ok(Value.Check(schemas.TrialOverrideResponse, allow.json()));
    assert.equal((await h.project(d, office)).statusCode, 201);
    // Deny blocks the account everywhere, and the rejection is logged.
    const deny = (await h.as(operatorUser)('POST', '/api/v1/admin/trial/overrides', { user_id: b, effect: 'deny', reason_code: 'abuse_suspected' })).json();
    const denied = await h.project(b, '192.0.2.45');
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().code, 'TRIAL_ACCESS_DENIED');
    assert.deepEqual(await rejected(pool, b, 'project_create'), ['TRIAL_ACCESS_DENIED']);
    assert.deepEqual(await rejected(pool, a, 'project_create'), []);
    assert.equal((await h.as(operatorUser)('POST', `/api/v1/admin/trial/overrides/${deny.override_id}/revoke`, { reason_code: 'reviewed' })).statusCode, 200);
    assert.equal((await h.as(operatorUser)('POST', `/api/v1/admin/trial/overrides/${deny.override_id}/revoke`, { reason_code: 'reviewed' })).statusCode, 409);
    assert.equal((await h.project(b, '192.0.2.45')).statusCode, 201);
    assert.equal((await h.as(operatorUser)('POST', '/api/v1/admin/trial/overrides', { user_id: 'no-such-user', effect: 'deny', reason_code: 'x' })).statusCode, 404);
    assert.equal((await h.as(a)('GET', '/api/v1/admin/trial/overrides')).statusCode, 404);
    await assert.rejects(pool.query('DELETE FROM bb_trial_overrides WHERE id=$1', [deny.override_id]));
    // Upload sessions retain hourly count checks, with no daily byte cap.
    const up = await user(pool, 'abuse-upload');
    const projectId = (await h.project(up, '192.0.2.46')).json().project_id;
    const upload = (bytes: number) => h.as(up, '192.0.2.46')('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename: 'synthetic.pdf', media_type: 'application/pdf', byte_size: bytes, sha256: 'a'.repeat(64), role: 'audit' });
    assert.equal((await upload(1000)).statusCode, 201);
    const bytes = await upload(1000);
    assert.equal(bytes.statusCode, 201, 'uploads can exceed the old daily byte cap');
    const count = await upload(10);
    assert.equal(count.statusCode, 429);
    assert.match(count.json().message, /uploads_per_user_per_hour/);
    assert.deepEqual(await rejected(pool, up, 'upload_create'), ['TRIAL_QUOTA_EXCEEDED']);
    // Only a keyed hash of the source is stored.
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_trial_admissions WHERE source_hash LIKE $1', [`%${office}%`])).rows[0].n, 0);
  } finally { await pool.end(); }
});

test('trial health pass raises stale heartbeat, backlog, error-rate and global-quota alerts', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    await openGate(pool);
    await pool.query('UPDATE bb_worker_heartbeats SET stopped_at=now() WHERE stopped_at IS NULL');
    const workerId = `synthetic-stale-${uid().slice(0, 8)}`;
    await recordWorkerHeartbeat(pool, { workerId, startedAt: new Date(), kinds: ['run'], concurrency: 1 });
    await pool.query("UPDATE bb_worker_heartbeats SET last_seen_at=now()-interval '1 hour' WHERE worker_id=$1", [workerId]);
    const h = harness(pool, base({ active_runs_per_user: 10 }));
    const owner = await user(pool, 'trial-health');
    const { projectId, inputHash } = await h.ready(owner);
    const queued = (await h.submit(owner, projectId, inputHash)).json().run_id;
    const failed = (await h.submit(owner, projectId, inputHash)).json().run_id;
    await pool.query("UPDATE bb_jobs SET updated_at=now()-interval '2 hours' WHERE run_id=$1", [queued]);
    await pool.query("UPDATE bb_jobs SET state='failed',updated_at=now() WHERE run_id=$1", [failed]);
    const active = (await pool.query("SELECT count(*)::int n FROM bb_runs WHERE state IN ('preparing','queued','running','validating','delivering')")).rows[0].n;
    const fired = await checkTrialHealth(pool, base({ global_active_runs: active }), { heartbeatMaxAgeSeconds: 90, queueBacklogMaxAgeSeconds: 600, errorWindowSeconds: 900, errorRateThreshold: 0.000001, errorMinSample: 1 });
    assert.deepEqual(fired, ['worker_heartbeat_stale', 'queue_backlog_stale', 'error_rate_spike', 'trial_quota_exhausted']);
    // Deduplicated per window: a second pass appends nothing new.
    const before = (await pool.query('SELECT count(*)::int n FROM bb_ops_alerts')).rows[0].n;
    await checkTrialHealth(pool, base({ global_active_runs: active }), { heartbeatMaxAgeSeconds: 90, queueBacklogMaxAgeSeconds: 600, errorWindowSeconds: 900, errorRateThreshold: 0.000001, errorMinSample: 1 });
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_ops_alerts')).rows[0].n, before);
    const reader = await user(pool, 'trial-alert-reader');
    await grantOperator(pool, { userId: reader, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    const alerts = await h.as(reader)('GET', '/api/v1/admin/alerts');
    assert.equal(alerts.statusCode, 200, alerts.body);
    const kinds = new Set(alerts.json().items.map((a: any) => a.kind));
    for (const kind of ['worker_heartbeat_stale', 'queue_backlog_stale', 'error_rate_spike', 'trial_quota_exhausted']) assert.ok(kinds.has(kind), kind);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE owner_user_id=$1", [owner]);
    await pool.query("UPDATE bb_jobs SET state='cancelled' WHERE owner_user_id=$1", [owner]);
    await recordWorkerHeartbeat(pool, { workerId, startedAt: new Date(), kinds: ['run'], concurrency: 1, stopped: true });
  } finally { await pool.end(); }
});

test('current paid admission serializes quota and retries the exact rejected key, input and unconsumed quote', { skip: !connection }, async () => {
  const database = await isolatedTestDatabase(undefined, 'current-trial-admission');
  const pool = new Pool({ connectionString: database });
  const owner = await user(pool, 'trial-current');
  const app = createServer({ pool, blobs: syntheticAuthoringBlobs(), allowedOrigin: ORIGIN,
    principal: async () => ({ userId: owner, csrfVerified: true }), enableSyntheticQueue: true, paymentProviders: [],
    trial: base({ active_runs_per_user: 1 }) });
  const send = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { origin: ORIGIN }, payload: payload as any });
  const prepare = async () => {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic current quota', kind: 'update',
      issuer_name: 'Synthetic trial issuer', market: 'sse', offering: 'private' });
    assert.equal(created.statusCode, 201, created.body);
    const project = created.json().project_id, input = (await lockSyntheticAuthoringInput(app, project)).json();
    const quoteId = await quoteSyntheticAuthoringRun(app, pool, owner, project, input);
    return { execution_request_id: `current-trial-${uid()}`, project_id: project, input_revision: input.input_revision,
      input_hash: input.input_hash, task_kind: 'update', input_manifest_ref: 'synthetic-manifest',
      storage_origin: 'cloud', workspace_id: 'synthetic-workspace', quote_id: quoteId };
  };
  try {
    await openGate(pool);
    const requests = [await prepare(), await prepare()];
    const fundedBalance = await creditBalanceExact(pool, owner);
    const raced = await Promise.all(requests.map(request => send('POST', '/api/v1/runs/execute', request)));
    assert.equal(raced.filter(response => response.statusCode === 202).length, 1, raced.map(response => response.body).join('\n'));
    assert.equal(raced.filter(response => response.statusCode === 429 && response.json().code === 'TRIAL_QUOTA_EXCEEDED').length, 1);
    const winnerIndex = raced.findIndex(response => response.statusCode === 202), rejectedIndex = 1 - winnerIndex;
    const winner = raced[winnerIndex].json(), request = requests[rejectedIndex];
    assert.equal(winner.billing_mode, 'fixed_credits');
    assert.deepEqual(raced[rejectedIndex].json().field_errors, [{ field: 'trial_limit', code: 'active_runs_per_user', message: 'Current processing limit reached' }]);
    const winningReplay = await send('POST', '/api/v1/runs/execute', requests[winnerIndex]);
    assert.equal(winningReplay.statusCode, 202, winningReplay.body);assert.equal(winningReplay.json().run_id, winner.run_id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1', [owner])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1', [owner])).rows[0].n, 1);
    const auditSql = "SELECT id,request_hash,error_code FROM bb_jobs WHERE project_id=$1 AND subtype='execute_rejected'";
    const audit = (await pool.query(auditSql, [request.project_id])).rows;
    assert.equal(audit.length, 1);assert.equal(audit[0].error_code, 'TRIAL_QUOTA_EXCEEDED');
    const retry = () => send('POST', '/api/v1/runs/execute', request);
    const stillFull = await retry();assert.equal(stillFull.statusCode, 429, stillFull.body);
    assert.equal(stillFull.json().code, 'TRIAL_QUOTA_EXCEEDED');
    assert.equal(await alertFor(pool, 'active_runs_per_user', owner), 1);
    const changed = await send('POST', '/api/v1/runs/execute', { ...request, input_manifest_ref: 'changed-manifest' });
    assert.equal(changed.statusCode, 409, changed.body);assert.equal(changed.json().code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [request.project_id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE quote_id=$1', [request.quote_id])).rows[0].n, 0);

    const cancelled = await send('POST', `/api/v1/runs/${winner.run_id}/cancel`, { reason: 'synthetic quota release' });
    assert.equal(cancelled.statusCode, 200, cancelled.body);assert.equal(cancelled.json().state, 'cancelled');
    assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE run_id=$1', [winner.run_id])).rows[0].state, 'released');
    assert.deepEqual(await creditBalanceExact(pool, owner), fundedBalance, 'cancellation releases the actual reserved funds');
    // Quota rejection never consumed this quote: retry the identical request without re-locking or re-quoting.
    const concurrent = await Promise.all([retry(), retry(), retry()]), resumed = concurrent[0];
    assert.equal(resumed.statusCode, 202, resumed.body);
    assert.ok(concurrent.every(response => response.statusCode === 202 && response.json().run_id === resumed.json().run_id));
    assert.equal((await retry()).json().run_id, resumed.json().run_id);
    assert.equal(resumed.json().execution_request_id, request.execution_request_id);
    assert.equal(resumed.json().input_revision, request.input_revision);assert.equal(resumed.json().input_hash, request.input_hash);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [request.project_id])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1', [request.project_id])).rows[0].n, 1);
    assert.deepEqual((await pool.query('SELECT quote_id,state FROM bb_credit_reservations WHERE run_id=$1', [resumed.json().run_id])).rows,
      [{ quote_id: request.quote_id, state: 'held' }]);
    assert.deepEqual((await pool.query(auditSql, [request.project_id])).rows, audit, 'the original quota rejection remains immutable after successful retry');
    assert.equal(await alertFor(pool, 'active_runs_per_user', owner), 1, 'replays do not duplicate the quota alert');
    const cleaned = await send('POST', `/api/v1/runs/${resumed.json().run_id}/cancel`, { reason: 'synthetic fixture complete' });
    assert.equal(cleaned.statusCode, 200, cleaned.body);
  } finally { await app.close(); await pool.end(); }
});
