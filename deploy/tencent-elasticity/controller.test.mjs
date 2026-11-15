import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, chmod, symlink, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ExecutionPoolController} from './controller.mjs';
import {TencentTransport, TencentCvm, runParameters} from './tencent-cvm.mjs';
import {planCapacity, validateConfig, sha256, canonical} from './policy.mjs';
import {bootstrapNode, bootstrapUserData, readRoleCredentials, writePrivateEnvelope} from './bootstrap.mjs';
import {costAdmission, produceExpenseSnapshot, expensePeriod} from './costcap.mjs';
import {readPrivateJson} from './private-files.mjs';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';

const h = 'a'.repeat(64), identity = {account_id: '123456', region: 'ap-beijing', instance_id: 'ins-a1', epoch: 'e3432123-84b5-4f11-8b51-94a29eac1234'};
const services = [{service_id: 'authoring', capabilities: ['authoring']}, {service_id: 'review', capabilities: ['review', 'assistant']}];
const config = {version: 'tencent-execution-pool-v1', enabled: true, phase: 'automatic', account_id: '123456', pool_tag: 'bondbuddy-execution', region: 'ap-beijing', zone: 'ap-beijing-7', instance_type: 'SA9.LARGE16', min_running: 1, max_owned: 2, resident_instance_id: 'ins-a1', global_model_limit: 4, node_model_limit: 4, compute_cny_per_hour: .8, compute_cap_cny_per_hour: 1.6, scale_up_wait_seconds: 60, idle_seconds: 300, failure_cooldown_seconds: 300, image_id: 'img-a1', vpc_id: 'vpc-a1', subnet_id: 'subnet-a1', security_group_id: 'sg-a1', source_sha256: h, image_sha256: h, network_review_sha256: h, quote_sha256: h, role_names: ['node-a', 'node-b'], noncompute_cap_cny_per_hour: .8, total_cap_cny_per_hour: 2.4, stop_charging_verified: true, stop_charging_evidence_sha256: h, private_pg_verified: true, service_credentials_verified: true, services, expense_policy_revision: 1, expense_policy_sha256:h, time_zone:'Asia/Shanghai', period_cap_cny:48, reservation_hours:1, drain_reserve_hours:1};
const snapshot = () => ({policy: {revision: 1, managed_nodes: true, budget_available: true, node_model_limit: 4, global_model_limit: 4, max_nodes: 2}, nodes: [], pending_cloud_reservations: 0, active_model_calls: 0, groups: [], effective_queued_work: 0});
const quote = {version:'execution-cloud-price-bounds-v1',currency:'CNY',account_id:config.account_id,region:config.region,policy_revision:1,valid_from:'2026-01-01T00:00:00Z',valid_until:'2030-01-01T00:00:00Z',components:['compute','disk','ip','egress','network','secret'].map(kind=>({kind,running_cny_per_node_hour:kind==='compute'?.8:.08,stopped_cny_per_node_hour:kind==='compute'?0:.08,evidence_ref:'synthetic/pricing',evidence_sha256:h,enforced_bound_sha256:h}))};
config.quote_sha256=sha256(canonical(quote));
const safeInventory = () => [{account_id:config.account_id,region:config.region,instance_id:'ins-a1',role_name:'node-a',instance_state:'RUNNING',observed_at:new Date().toISOString(),evidence_ref:'synthetic/cloud',evidence_sha256:h}];
const ledgerFor = inventory => ({captured_at:new Date().toISOString(),operations:inventory.map(i=>({operation_id:'create-'+i.instance_id,identity:{...identity,instance_id:i.instance_id},action:'run',state:'completed',created_at:new Date(Date.now()-3600000).toISOString(),dispatched_at:new Date(Date.now()-3600000).toISOString(),completed_at:new Date(Date.now()-3500000).toISOString()})),nodes:inventory.map(i=>({identity:{...identity,instance_id:i.instance_id},state:'ready',created_at:new Date(Date.now()-3600000).toISOString(),destroyed_at:null,cloud_start_operation_id:'create-'+i.instance_id,stop_operation_id:null,launch_manifest_sha256:h}))});
const expense = (inventory=[]) => produceExpenseSnapshot({ledger:ledgerFor(inventory),inventory,quote,config});
const request = () => ({...identity, instance_id: null, instance_count: 1, source_sha256: h, image_sha256: h, launch_manifest_sha256: h, capabilities: ['authoring', 'review', 'assistant'], services});
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
  assert.equal(costAdmission({version:'execution-cloud-expense-v1',spent_upper_bound_cny:0,unknown_operations_fully_reserved:true,bill_delay_conservatively_bounded:true}, [], config).allowed, false);
});
test('Start direct call cannot bypass fresh demand or cost gate', async () => {
  let reserves = 0;
  const c = new ExecutionPoolController({config, control: {snapshot: async () => snapshot(), reserveStart: async () => {reserves++;}}, cloud: {inventory: async () => safeInventory()}, costSnapshot: async i => expense(i)});
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
  const disabled = createExecutionPoolOpsHandler({control: {listPendingOperations: async () => []}, configPath: 'synthetic', dependencies: {readConfig: async () => ({...config, enabled: false}), cloud: {describe: async () => {describes++;}}}});
  await disabled.tick(); assert.equal(describes, 2);
});

test('natural-day producer rejects sliding intervals and carries old unknown Run across midnight', () => {
  const before=expensePeriod('2026-11-14T15:59:59Z','Asia/Shanghai'), after=expensePeriod('2026-11-14T16:00:00Z','Asia/Shanghai');
  assert.equal(before.period_key,'Asia/Shanghai:2026-11-14');assert.equal(after.period_key,'Asia/Shanghai:2026-11-15');
  assert.equal(before.period_end,after.period_start);
  const old={...operation(),action:'run',identity:null,state:'unknown',request:request(),created_at:'2026-11-13T16:00:00Z',dispatched_at:'2026-11-13T16:00:00Z',completed_at:null};
  const make=captured_at=>produceExpenseSnapshot({ledger:{captured_at,nodes:[],operations:[old]},inventory:[],quote,config});
  const a=make('2026-11-14T15:59:59Z'),b=make('2026-11-14T16:00:00Z');
  assert.ok(b.unknown_liability_cny>=28.8);assert.ok(b.unknown_liability_cny+a.unknown_liability_cny>0);
  assert.ok(b.reserved_upper_bound_cny>0&&b.resident_remaining_period_cny>0&&b.drain_reserve_cny>0);
  assert.equal(costAdmission({...expense(),period_start:new Date(Date.now()-10000).toISOString(),period_end:new Date(Date.now()+3600000).toISOString()},[],config).allowed,false);
});

test('producer requires every noncompute bound and exact historical inventory; stale booleans cannot clear unknowns', () => {
  const omitted={...quote,components:quote.components.filter(c=>c.kind!=='egress')};
  assert.throws(()=>produceExpenseSnapshot({ledger:ledgerFor([]),inventory:[],quote:omitted,config:{...config,quote_sha256:sha256(canonical(omitted))}}),/FEE_COMPONENTS/);
  const i=safeInventory();assert.throws(()=>produceExpenseSnapshot({ledger:ledgerFor([]),inventory:i,quote,config}),/INVENTORY_INCOMPLETE/);
  const bad={...quote,components:quote.components.map(c=>({...c,enforced_bound_sha256:null}))};
  assert.throws(()=>produceExpenseSnapshot({ledger:ledgerFor([]),inventory:[],quote:bad,config:{...config,quote_sha256:sha256(canonical(bad))}}),/RATE_EVIDENCE/);
});

test('budget exhaustion drains spare with an existing lease despite queued work, without stopping resident', () => {
  const node={identity,state:'ready',revision:1,ready_slots:0,active_leases:1,active_model_calls:1,capabilities:['authoring','review'],idle_since:null};
  const spare={...node,identity:{...identity,instance_id:'ins-b2'}};
  const s={...snapshot(),policy:{...snapshot().policy,budget_available:false},nodes:[node,spare],effective_queued_work:7};
  const plan=planCapacity(s,[{instance_state:'RUNNING'},{instance_state:'RUNNING'}],{...config,phase:'two_node_validation'});
  assert.equal(plan.kind,'drain');assert.equal(plan.identity.instance_id,'ins-b2');
});

test('warm Start uses original node manifest and services, not a global or regenerated Run hash', async () => {
  const i=safeInventory();i.push({...i[0],instance_id:'ins-b2',role_name:'node-b',instance_state:'STOPPED'});
  const stored='b'.repeat(64),s={...snapshot(),nodes:[{identity,state:'ready',ready_slots:0,capabilities:['authoring','review','assistant']},
    {identity:{...identity,instance_id:'ins-b2'},state:'stopped',source_sha256:h,image_sha256:h,launch_manifest_sha256:stored,expected_services:services,capabilities:['authoring','review','assistant']}],
    groups:[{capability:'review',effective_queued_work:1,oldest_wait_seconds:600,available_run_slots:0}]};
  let seen,calls=0;
  const control={snapshot:async()=>s,listPendingOperations:async()=>[],reserveStart:async(r,id)=>{seen=r;return {...operation(),operation_id:id,action:'start',request:r,identity:{...identity,instance_id:r.instance_id,epoch:r.epoch}};},
    claimCloudDispatch:async()=>({...operation(),action:'start',identity:{...identity,instance_id:'ins-b2'},state:'unknown'}),recordCloudResult:async(_,__,r)=>r};
  const handler=createExecutionPoolOpsHandler({control,configPath:'synthetic',dependencies:{readConfig:async()=>config,costSnapshot:async inv=>expense(inv),cloud:{inventory:async()=>i,execute:async()=>{calls++;return {RequestId:'cloud1'};}}}});
  await handler.tick();assert.equal(seen.launch_manifest_sha256,stored);assert.deepEqual(seen.services,services);assert.equal(seen.instance_count,1);assert.ok(!seen.capabilities.includes('probe'));assert.equal(calls,1);
});

test('cost producer failure closes authoritative admission, yet progresses already draining node', async () => {
  let budget=true,closed=0,drains=0;
  const node={identity,state:'draining',revision:1,drain_operation_id:'drain1'};
  const control={snapshot:async()=>({...snapshot(),policy:{...snapshot().policy,budget_available:budget,expense_policy_sha256:h},nodes:[node]}),listPendingOperations:async()=>[],setAdmissionBudget:async(_,available)=>{budget=available;closed++;},beginDrain:async()=>{drains++;return node;},drainProof:async()=>null};
  const handler=createExecutionPoolOpsHandler({control,configPath:'synthetic',dependencies:{readConfig:async()=>config,costSnapshot:async()=>{throw Error('missing bound');},cloud:{inventory:async()=>safeInventory()}}});
  await handler.tick();assert.equal(budget,false);assert.equal(closed,1);assert.equal(drains,1);
});

test('unknown Run recovery first describes scoped inventory and binds ownership without manufacturing ACK', async () => {
  const r=request();r.launch_manifest_sha256=sha256(canonical(runParameters(config,r,sha256('op1'),bootstrapUserData(config,r),0,'op1')));
  const op={...operation(),action:'run',state:'unknown',identity:null,request:r},i={...safeInventory()[0],create_operation_id:'op1'};
  let reads=0,result;
  const c=new ExecutionPoolController({config,control:{loadOperation:async()=>op,recordCloudResult:async(_,__,v)=>{result=v;return v;}},cloud:{inventory:async()=>{reads++;return [i];}}});
  await c.recover('op1');assert.equal(reads,1);assert.equal(result.state,'unknown');assert.equal(result.provider_request_id,null);assert.equal(result.identity.instance_id,'ins-a1');
});

test('only archived definitive single-Run inventory rejection enters persistent cooldown', async () => {
  const op={...operation(),action:'run',identity:null,request:request()};let result;
  const evidence={code:'ResourceInsufficient.AvailabilityZoneSoldOut',request_id:'real-synthetic-request',evidence_ref:'synthetic/rejection',evidence_sha256:h};
  const c=new ExecutionPoolController({config,control:{claimCloudDispatch:async()=>({...op,state:'unknown'}),recordCloudResult:async(_,__,r)=>{result=r;return r;}},cloud:{execute:async()=>{throw Error('inventory');},capacityRejection:async()=>evidence}});
  await c.dispatch(op,{slot:0});assert.equal(result.state,'rejected');assert.equal(result.rejection_evidence.code,evidence.code);assert.ok(Date.parse(result.rejection_evidence.retry_after)>Date.now());
  c.cloud.capacityRejection=async()=>null;await c.dispatch(op,{slot:0});assert.equal(result.state,'unknown');
  assert.equal(planCapacity({...snapshot(),policy:{...snapshot().policy,cooldown_until:new Date(Date.now()+300000).toISOString()}},[],config).reason,'policy_cooldown');
});

test('unneeded never-dispatched intent is cancelled rather than blocking drain or inventing a rejection',async()=>{
 const op={...operation(),action:'run',identity:null,request:request()};let cancels=0,calls=0;
 const c=new ExecutionPoolController({config,control:{snapshot:async()=>({...snapshot(),pending_cloud_reservations:1,policy:{...snapshot().policy,budget_available:false}}),cancelUndispatchedCloudIntent:async(id,rev,policy)=>{assert.equal(id,op.operation_id);assert.equal(rev,op.revision);assert.equal(policy,1);cancels++;return {...op,state:'cancelled'};}},costSnapshot:async()=>{throw Error('budget exhausted');},cloud:{inventory:async()=>[],execute:async()=>{calls++;}}});
 assert.equal((await c.resumeIntent(op)).state,'cancelled');assert.equal(cancels,1);assert.equal(calls,0);
});

test('completed Run boot time before PG node insertion remains charged from original dispatch',()=>{
 const inventory=safeInventory(),ledger=ledgerFor(inventory);const captured=Date.parse(ledger.captured_at);
 ledger.nodes[0].created_at=new Date(captured-1000).toISOString();ledger.operations[0].dispatched_at=new Date(captured-1800000).toISOString();
 const bound=produceExpenseSnapshot({ledger,inventory,quote,config});const today=Date.parse(bound.period_start);
 assert.ok(bound.spent_upper_bound_cny>=Math.max(0,captured-Math.max(today,captured-1800000))/3600000*1.2-0.000001);
});
