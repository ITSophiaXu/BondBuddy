import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, chmod, symlink, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ExecutionPoolController} from './controller.mjs';
import {TencentTransport, TencentCvm, runParameters} from './tencent-cvm.mjs';
import {planCapacity, validateConfig, sha256, canonical} from './policy.mjs';
import {bootstrapNode, bootstrapUserData, readRoleCredentials, writePrivateEnvelope} from './bootstrap.mjs';
import {costAdmission} from './costcap.mjs';
import {readPrivateJson} from './private-files.mjs';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';

const h = 'a'.repeat(64), identity = {account_id: '123456', region: 'ap-beijing', instance_id: 'ins-a1', epoch: 'e3432123-84b5-4f11-8b51-94a29eac1234'};
const services = [{service_id: 'authoring', capabilities: ['authoring', 'assistant', 'probe']}, {service_id: 'review', capabilities: ['review', 'assistant']}];
const config = {version: 'tencent-execution-pool-v1', enabled: true, phase: 'automatic', account_id: '123456', pool_tag: 'bondbuddy-execution', region: 'ap-beijing', zone: 'ap-beijing-7', instance_type: 'SA9.LARGE16', min_running: 1, max_owned: 2, resident_instance_id: 'ins-a1', global_model_limit: 4, node_model_limit: 4, compute_cny_per_hour: .8, compute_cap_cny_per_hour: 1.6, scale_up_wait_seconds: 60, idle_seconds: 300, failure_cooldown_seconds: 300, image_id: 'img-a1', vpc_id: 'vpc-a1', subnet_id: 'subnet-a1', security_group_id: 'sg-a1', source_sha256: h, image_sha256: h, network_review_sha256: h, quote_sha256: h, role_names: ['node-a', 'node-b'], noncompute_cap_cny_per_hour: .8, total_cap_cny_per_hour: 2.4, stop_charging_verified: true, stop_charging_evidence_sha256: h, private_pg_verified: true, service_credentials_verified: true, services, expense_policy_revision: 1};
const snapshot = () => ({policy: {revision: 1, managed_nodes: true, budget_available: true, node_model_limit: 4, global_model_limit: 4, max_nodes: 2}, nodes: [], pending_cloud_reservations: 0, active_model_calls: 0, groups: [], effective_queued_work: 0});
const expense = () => ({version: 'execution-cloud-expense-v1', currency: 'CNY', account_id: config.account_id, region: config.region, quote_sha256: h, policy_revision: 1, observed_at: new Date().toISOString(), period_start: new Date(Date.now() - 10000).toISOString(), period_end: new Date(Date.now() + 3600000).toISOString(), period_cap_cny: 48, total_hourly_cap_cny: 2.4, resource_ids: [], unknown_operations_fully_reserved: true, bill_delay_conservatively_bounded: true, spent_upper_bound_cny: 0, reserved_upper_bound_cny: 0, unknown_liability_cny: 0, drain_reserve_cny: 2.4});
const request = () => ({...identity, instance_id: null, source_sha256: h, image_sha256: h, launch_manifest_sha256: h, capabilities: ['authoring', 'review', 'assistant', 'probe'], services});
const operation = () => ({operation_id: 'op1', identity, action: 'stop', state: 'intent', revision: 1, provider_request_id: null, proof_sha256: h, request: null, client_token: sha256('op1')});
const observation = () => ({...identity, instance_state: 'STOPPED', latest_operation: 'StopInstances', latest_operation_state: 'SUCCESS', latest_operation_request_id: 'cloud1', stop_charging_mode: 'STOP_CHARGING', observed_at: new Date().toISOString(), evidence_ref: 'sealed/cloud.json', evidence_sha256: h});

test('budget / pending / shared waiters never trigger expansion; first-node validation is bounded', () => {
  assert.equal(planCapacity({...snapshot(), policy: {...snapshot().policy, budget_available: false}}, [], config).reason, 'budget');
  assert.equal(planCapacity({...snapshot(), pending_cloud_reservations: 1}, [], config).reason, 'pending_cloud_operation');
  assert.equal(planCapacity({...snapshot(), excluded: {shared_plan_waiter: 250}}, [{instance_state: 'RUNNING'}], config).kind, 'hold');
  assert.equal(planCapacity(snapshot(), [], {...config, phase: 'single_node_validation'}).kind, 'run');
});
test('cannot drain sole ready node, resident, or sole capability when another node is starting', () => {
  const node = {identity, state: 'ready', active_leases: 0, active_model_calls: 0, ready_slots: 4, capabilities: ['review'], idle_since: new Date(Date.now() - 600000).toISOString()};
  assert.equal(planCapacity({...snapshot(), nodes: [node]}, [{instance_state: 'RUNNING'}, {instance_state: 'STARTING'}], config).kind, 'hold');
  const other = {...node, identity: {...identity, instance_id: 'ins-b2'}, capabilities: ['authoring']};
  assert.equal(planCapacity({...snapshot(), nodes: [node, other]}, [{instance_state: 'RUNNING'}, {instance_state: 'RUNNING'}], config).kind, 'hold');
  other.capabilities = ['review'];
  assert.equal(planCapacity({...snapshot(), nodes: [node, other]}, [{instance_state: 'RUNNING'}, {instance_state: 'RUNNING'}], config).identity.instance_id, 'ins-b2');
});
test('stop charging validation has no bootstrap cycle; global8 still needs provider approval', () => {
  assert.doesNotThrow(() => validateConfig({...config, phase: 'single_node_validation', stop_charging_verified: false}, {apply: true}));
  assert.throws(() => validateConfig({...config, stop_charging_verified: false}, {apply: true}), /STOP_CHARGING/);
  assert.throws(() => validateConfig({...config, global_model_limit: 8}, {apply: true}), /PROVIDER_BUDGET/);
});
test('daily engineering costcap includes delayed bills, unknowns, drift and safe drain; no empty bill=zero', () => {
  assert.equal(costAdmission(expense(), [], config).allowed, true);
  assert.equal(costAdmission({...expense(), unknown_liability_cny: 45}, [], config).allowed, false);
  assert.equal(costAdmission({...expense(), observed_at: new Date(Date.now() - 301000).toISOString()}, [], config).allowed, false);
  assert.equal(costAdmission(expense(), [{instance_id: 'ins-unbilled'}], config).allowed, false);
  assert.equal(costAdmission({...expense(), bill_delay_conservatively_bounded: false}, [], config).allowed, false);
});
test('Start direct call cannot bypass fresh demand or cost gate', async () => {
  let reserves = 0;
  const c = new ExecutionPoolController({config, control: {snapshot: async () => snapshot(), reserveStart: async () => {reserves++;}}, cloud: {inventory: async () => [{instance_state: 'RUNNING', instance_id: 'ins-a1'}]}, costSnapshot: async () => ({...expense(), resource_ids: ['ins-a1']})});
  await assert.rejects(c.start({...request(), instance_id: 'ins-b2'}, 'new'), /FRESH_EXPANSION/);
  assert.equal(reserves, 0);
});
test('duplicate concurrent Stop dispatch has one CAS winner and one cloud call', async () => {
  let op = operation(), calls = 0;
  const control = {claimCloudDispatch: async (_, rev) => {assert.equal(rev, op.revision); if (op.state !== 'intent') throw Error('CAS'); op = {...op, state: 'unknown', revision: rev + 1}; return op;}, recordCloudResult: async (_, rev, result) => {assert.equal(rev, op.revision); op = {...op, ...result, revision: rev + 1}; return op;}};
  const c = new ExecutionPoolController({config, control, cloud: {execute: async () => {calls++; return {RequestId: 'cloud1'};}}});
  const r = await Promise.allSettled([c.dispatch(operation()), c.dispatch(operation())]);
  assert.equal(calls, 1); assert.equal(r.filter(x => x.status === 'fulfilled').length, 1); assert.equal(op.state, 'submitted');
});
test('timeout AFTER cloud accepted is unknown; restart does not resend Stop or open epoch', async () => {
  let op = operation(), calls = 0;
  const control = {claimCloudDispatch: async () => (op = {...op, state: 'unknown', revision: 2}), recordCloudResult: async (_, rev, result) => (op = {...op, ...result, revision: rev + 1}), loadOperation: async () => op};
  const c = new ExecutionPoolController({config, control, cloud: {execute: async () => {calls++; throw Error('accepted but connection lost');}, describe: async () => observation()}});
  await c.dispatch(op); await c.recover('op1'); await c.dispatch(op);
  assert.equal(op.state, 'unknown'); assert.equal(calls, 1);
});
test('exact Stop ACK/result/charging fields reach PG; wrong request/mode stays fenced', async () => {
  const op = {...operation(), state: 'submitted', provider_request_id: 'cloud1'};
  let commits = 0, seen;
  const control = {loadOperation: async () => op, recordCloudResult: async (_, __, r) => {commits++; seen = r; return r;}};
  const cloud = {describe: async () => ({...observation(), latest_operation_request_id: 'old-cloud'})};
  const c = new ExecutionPoolController({config, control, cloud});
  await c.recover('op1'); assert.equal(commits, 0);
  cloud.describe = async () => ({...observation(), stop_charging_mode: 'KEEP_CHARGING'});
  await c.recover('op1'); assert.equal(commits, 0);
  cloud.describe = async () => observation(); await c.recover('op1');
  assert.equal(commits, 1); assert.equal(seen.observation.latest_operation_request_id, 'cloud1');
});
test('unbound Run timeout retains null identity and same client token', async () => {
  let result;
  const op = {...operation(), action: 'run', identity: null, request: request()};
  const c = new ExecutionPoolController({config, control: {claimCloudDispatch: async () => ({...op, state: 'unknown', revision: 2}), recordCloudResult: async (_, __, r) => {result = r; return r;}}, cloud: {execute: async () => {throw Error('lost ACK');}}});
  await c.dispatch(op, {slot: 0}); assert.equal(result.identity, null); assert.equal(result.state, 'unknown');
});
test('Run request fixed token/role/disks/no public IP; material drift rejected before cloud mutation', async () => {
  const r = request(), userData = bootstrapUserData(config, r);
  const params = runParameters(config, r, sha256('op1'), userData, 0, 'op1');
  assert.equal(params.InstanceCount, 1); assert.equal(params.ClientToken, sha256('op1')); assert.equal(params.CamRoleName, 'node-a');
  assert.equal(params.InternetAccessible.PublicIpAssigned, false); assert.ok(!params.LoginSettings);
  let writes = 0;
  const cvm = new TencentCvm({config, transport: {call: async (_, action) => {if (action === 'GetCallerIdentity') return {AccountId: config.account_id}; writes++;}}, archive: async () => {}});
  await assert.rejects(cvm.execute({...operation(), action: 'run', request: r}, {slot: 0, userData}), /LAUNCH_MANIFEST/);
  assert.equal(writes, 0);
});
test('TC3 role transport fixed endpoint/signature, refuses redirects and short/stale credentials', async () => {
  let captured;
  const transport = new TencentTransport({region: 'ap-beijing', credentials: async () => ({secretId: 'test', secretKey: 'synthetic', token: 'test-token', expiresAt: Date.now() + 300000}), fetchImpl: async (url, options) => {captured = {url, options}; return new Response(JSON.stringify({Response: {RequestId: 'request'}}));}});
  await transport.call('cvm', 'StartInstances', {InstanceIds: ['ins-a1']});
  assert.equal(captured.url, 'https://cvm.tencentcloudapi.com/'); assert.equal(captured.options.redirect, 'error');
  assert.match(captured.options.headers.Authorization, /^TC3-HMAC-SHA256/);
  await assert.rejects(transport.call('cvm', 'TerminateInstances', {}), /ACTION_NOT_ALLOWED/);
  transport.credentials = async () => ({secretId: 'test', secretKey: 'synthetic', token: 'test-token', expiresAt: 1});
  await assert.rejects(transport.call('cvm', 'DescribeInstances', {}), /SHORT_CREDENTIAL/);
});
test('IMDS role credentials bounded and temporary; they are not an instance admission proof', async () => {
  const c = await readRoleCredentials('node-a', {fetchImpl: async () => new Response(JSON.stringify({TmpSecretId: 'synthetic', TmpSecretKey: 'synthetic', Token: 'synthetic', ExpiredTime: Math.floor(Date.now()/1000) + 300}))});
  assert.ok(c.expiresAt > Date.now());
  await assert.rejects(readRoleCredentials('../other'), /ROLE_NAME/);
});
test('bootstrap rejects metadata-only/wrong-account/partial-manifest; starts nothing', async () => {
  let starts = 0;
  const enrollment = {...request(), identity, verified: true, expires_at: Date.now() + 300000, registration_token: 'synthetic', operation_completed: true};
  const opts = {publicManifest: {version: 'execution-bootstrap-v1', ...request()}, metadata: identity, broker: {enroll: async () => enrollment}, runtime: {verifyArtifacts: async () => {}, startService: async () => {starts++;}}, writeEnvelope: async () => 'synthetic'};
  await assert.rejects(bootstrapNode({...opts, broker: {enroll: async () => ({...enrollment, verified: false})}}), /ENROLLMENT_BINDING/);
  await assert.rejects(bootstrapNode({...opts, metadata: {...identity, account_id: 'foreign'}}), /ENROLLMENT_BINDING/);
  assert.equal(starts, 0);
});
test('private envelope refuses symlinks and mode drift; source token never in public UserData', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-elastic-'));
  try {
    const path = await writePrivateEnvelope(dir, 'authoring', {registration_token: 'synthetic'});
    assert.equal((await readPrivateJson(path)).registration_token, 'synthetic');
    await symlink(path, join(dir, 'link')); await assert.rejects(readPrivateJson(join(dir, 'link')));
    await chmod(path, 0o644); await assert.rejects(readPrivateJson(path), /PERMISSIONS/);
    assert.ok(!bootstrapUserData(config, request()).includes('registration_token'));
  } finally {await rm(dir, {recursive: true});}
});
test('existing ops tick with no business events advances pending recovery and disabled makes zero calls', async () => {
  let describes = 0;
  const op = {...operation(), state: 'unknown', provider_request_id: null};
  const control = {listPendingOperations: async () => [op], loadOperation: async () => op};
  const handler = createExecutionPoolOpsHandler({control, configPath: 'synthetic', dependencies: {readConfig: async () => config, cloud: {describe: async () => {describes++; return observation();}}}});
  await handler.tick(); await handler.tick(); assert.equal(describes, 2);
  const disabled = createExecutionPoolOpsHandler({control, configPath: 'synthetic', dependencies: {readConfig: async () => ({...config, enabled: false}), cloud: {describe: async () => {describes++;}}}});
  await disabled.tick(); assert.equal(describes, 2);
});
