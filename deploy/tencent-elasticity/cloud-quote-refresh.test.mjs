import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {refreshCloudQuote,observeLighthouseQuote,quoteSsmRequestBound} from './cloud-quote-refresh.mjs';
import {canonical,sha256} from './policy.mjs';
import {produceExpenseSnapshot,costAdmission} from './costcap.mjs';
import {acquireControlTick} from './control-tick-bound.mjs';
import {TencentTransport} from './tencent-cvm.mjs';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';

// Synthetic cloud/tariff data only. These fixtures never authorize a live node.
const h='a'.repeat(64), total=536870912000;
export async function quoteFixture(t,{at=Date.parse('2026-11-15T04:00:00Z')}={}) {
  const directory=await mkdtemp(join(tmpdir(),'bb-quote-refresh-'));
  t.after(()=>rm(directory,{recursive:true}));
  const state={at,calls:0},configPath=join(directory,'config.json');
  const quote={version:'execution-cloud-price-bounds-v1',currency:'CNY',account_id:'100006372392',region:'ap-beijing',policy_revision:1,
    valid_from:'2026-10-24T00:00:00Z',valid_until:'2026-11-15T16:00:00Z',
    fixed_commitments:[{kind:'secret',upper_bound_cny:8.4},{kind:'snapshot',upper_bound_cny:12}].map(c=>({...c,evidence_ref:'synthetic/tariff',evidence_sha256:h,enforced_bound_sha256:h})),
    components:['compute','disk','ip','egress','network','secret'].map((kind,index)=>({kind,running_cny_per_node_hour:[.8,.11,.02,.1,.1,.4][index],
      stopped_cny_per_node_hour:kind==='compute'?0:.01,evidence_ref:'synthetic/tariff',evidence_sha256:h,enforced_bound_sha256:h}))};
  const config={version:'tencent-execution-pool-v1',enabled:true,phase:'automatic',account_id:'100006372392',pool_tag:'bondbuddy-execution',region:'ap-beijing',zone:'ap-beijing-7',
    instance_type:'SA9.LARGE16',min_running:0,max_owned:2,resident_instance_id:null,global_model_limit:4,node_model_limit:4,
    compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,total_cap_cny_per_hour:4,noncompute_cap_cny_per_hour:2.4,
    quote_sha256:sha256(canonical(quote)),expense_policy_sha256:h,expense_policy_revision:1,time_zone:'Asia/Shanghai',period_cap_cny:48,reservation_hours:1,drain_reserve_hours:1,
    source_sha256:h,image_sha256:h,network_review_sha256:h,image_id:'img-synthetic',vpc_id:'vpc-synthetic',subnet_id:'subnet-synthetic',security_group_id:'sg-synthetic',
    private_pg_verified:true,service_credentials_verified:true,stop_charging_verified:true,stop_charging_evidence_sha256:h,
    role_names:['role-a','role-b'],services:[{service_id:'authoring',capabilities:['authoring']}],scale_up_wait_seconds:60,idle_seconds:300,failure_cooldown_seconds:300,
    registration_directory:directory,cloud_quote_file:join(directory,'quote.json'),cloud_quote_refresh:{version:'lighthouse-quote-refresh-v1',instance_id:'lhins-4i18xeto',
      bundle_id:'bundle_starter_mc_med4_01',bandwidth_mbps:5,traffic_package_total_bytes:total,pricing_valid_until:'2027-01-01T00:00:00Z',snapshot_file:join(directory,'cloud-quote-snapshot.json')}};
  const caller={AccountId:config.account_id,RequestId:'synthetic-caller'};
  const instances={TotalCount:1,RequestId:'synthetic-instance',InstanceSet:[{InstanceId:'lhins-4i18xeto',InstanceState:'RUNNING',Zone:'ap-beijing-7',BundleId:config.cloud_quote_refresh.bundle_id,
    InternetAccessible:{InternetChargeType:'TRAFFIC_POSTPAID_BY_HOUR',InternetMaxBandwidthOut:5,PublicIpAssigned:true},ExpiredTime:'2027-10-24T11:03:49Z'}]};
  const traffic={TotalCount:1,RequestId:'synthetic-traffic',InstanceTrafficPackageSet:[{InstanceId:'lhins-4i18xeto',TrafficPackageSet:[{TrafficPackageId:'lhtfp-synthetic',TrafficUsed:21069349184,
    TrafficPackageTotal:total,TrafficPackageRemaining:515801562816,TrafficOverflow:0,StartTime:'2026-10-24T11:03:49Z',EndTime:'2026-11-24T11:03:49Z',Deadline:'2027-10-24T11:03:49Z',Status:'NETWORK_NORMAL'}]}]};
  const transport={async call(s,a,p){state.calls++;if(s==='sts'){assert.equal(a,'GetCallerIdentity');return structuredClone(caller);}
    assert.equal(s,'lighthouse');assert.deepEqual(p,{InstanceIds:['lhins-4i18xeto'],Offset:0,Limit:1});
    return structuredClone(a==='DescribeInstances'?instances:traffic);}};
  const save=async()=>{await writeFile(configPath,canonical(config),{mode:0o600});await writeFile(config.cloud_quote_file,canonical(quote),{mode:0o600});};
  await save();return {state,configPath,config,quote,caller,instances,traffic,transport,save,
    refresh:extra=>refreshCloudQuote({configPath,config,transport,capturedAt:new Date(state.at).toISOString(),now:()=>state.at,...extra})};
}

test('cross-midnight refresh publishes an indivisible quote/config and retains fixed liabilities and tariff evidence',async t=>{
  const f=await quoteFixture(t,{at:Date.parse('2026-11-15T15:59:00Z')});
  let r=await f.refresh();assert.equal(r.quote.valid_until,'2026-11-15T16:00:00.000Z');assert.equal(f.state.calls,3);
  const originalConfig=await readFile(f.configPath),originalQuote=await readFile(f.config.cloud_quote_file);
  f.state.at+=61000;t.mock.timers.enable({apis:['Date'],now:f.state.at});r=await f.refresh();assert.equal(f.state.calls,6);
  assert.equal(r.quote.valid_until,'2026-11-16T16:00:00.000Z');assert.equal(r.observation.required_remaining_bytes,Math.ceil(5e6/8*86399));
  assert.deepEqual(r.quote.fixed_commitments,f.quote.fixed_commitments);
  for(const old of f.quote.components){const c=r.quote.components.find(c=>c.kind===old.kind);assert.equal(c.running_cny_per_node_hour,old.running_cny_per_node_hour);assert.equal(c.evidence_sha256,old.evidence_sha256);}
  assert.deepEqual(await readFile(f.configPath),originalConfig);assert.deepEqual(await readFile(f.config.cloud_quote_file),originalQuote);
  const disk=JSON.parse(await readFile(f.config.cloud_quote_refresh.snapshot_file,'utf8'));
  assert.equal(sha256(canonical(disk.quote)),disk.config.quote_sha256);assert.deepEqual(disk.config,r.config);
  assert.equal((await lstat(f.config.cloud_quote_refresh.snapshot_file)).mode&0o777,0o600);
  const expense=produceExpenseSnapshot({ledger:{captured_at:new Date(f.state.at).toISOString(),nodes:[],operations:[]},inventory:[],quote:r.quote,config:r.config});
  assert.equal(expense.fixed_commitments_upper_bound_cny,20.4);assert.equal(costAdmission(expense,[],r.config).allowed,true);
  await f.refresh();assert.equal(f.state.calls,6,'same tick reuses the durable bound, no duplicated API query');
});

test('account/instance/bundle/bandwidth, unavailable/expired/inconsistent traffic and inadequate whole-host allowance reject publication',async t=>{
  const f=await quoteFixture(t);const base={caller:f.caller,instances:f.instances,traffic:f.traffic,config:f.config,at:f.state.at};
  for(const change of [
    x=>x.caller.AccountId='999',x=>x.instances.InstanceSet[0].InstanceId='lhins-other',x=>x.instances.InstanceSet[0].BundleId='other',
    x=>x.instances.InstanceSet[0].InternetAccessible.InternetMaxBandwidthOut=6,x=>x.instances.InstanceSet[0].ExpiredTime='2026-11-14T00:00:00Z',
    x=>x.traffic.InstanceTrafficPackageSet[0].InstanceId='lhins-other',x=>x.traffic.TotalCount=2,
    x=>x.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0].Status='OVERDUE_NETWORK_DISABLED',
    x=>x.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0].TrafficOverflow=1,
    x=>x.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0].EndTime='2026-11-15T15:00:00Z',
    x=>{const p=x.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0];p.TrafficPackageRemaining=1;p.TrafficUsed=total-1;},
    x=>x.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0].TrafficUsed='21069349184',
  ]){const x=structuredClone(base);change(x);assert.throws(()=>observeLighthouseQuote(x),/QUOTE_/);}
  await assert.rejects(readFile(f.config.cloud_quote_refresh.snapshot_file),{code:'ENOENT'});
});

test('clock rollback, quota rollback and package changes before rollover cannot replace a published snapshot',async t=>{
  const f=await quoteFixture(t);await f.refresh();const original=await readFile(f.config.cloud_quote_refresh.snapshot_file);
  f.state.at-=1;await assert.rejects(f.refresh(),/QUOTE_CLOCK_ROLLBACK/);f.state.at+=31001;
  const p=f.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0];p.TrafficUsed--;p.TrafficPackageRemaining++;
  await assert.rejects(f.refresh(),/QUOTE_TRAFFIC_ROLLBACK/);p.TrafficUsed++;p.TrafficPackageRemaining--;p.TrafficPackageId='lhtfp-other';
  await assert.rejects(f.refresh(),/QUOTE_PACKAGE_DRIFT/);assert.deepEqual(await readFile(f.config.cloud_quote_refresh.snapshot_file),original);
});

test('actual new package at the exact boundary may refresh, but never quotes through an old package expiry',async t=>{
  const f=await quoteFixture(t,{at:Date.parse('2026-11-23T15:59:00Z')});await f.refresh();
  f.state.at=Date.parse('2026-11-24T10:00:00Z');await assert.rejects(f.refresh(),/QUOTE_PACKAGE_EXPIRED/);
  f.state.at=Date.parse('2026-11-24T11:04:00Z');const p=f.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0];
  Object.assign(p,{TrafficPackageId:'lhtfp-next',TrafficUsed:0,TrafficPackageRemaining:total,StartTime:p.EndTime,EndTime:'2026-12-24T11:03:49Z'});
  assert.equal((await f.refresh()).observation.traffic.TrafficPackageId,'lhtfp-next');
});

test('API error, expired pricing, zeroed fixed obligations, interrupted rename and concurrent config change refuse new snapshots',async t=>{
  const f=await quoteFixture(t);await f.refresh();f.state.at+=31000;const original=await readFile(f.config.cloud_quote_refresh.snapshot_file);
  await assert.rejects(f.refresh({transport:{call:async()=>{throw Error('synthetic API outage');}}}),/outage/);
  await assert.rejects(f.refresh({beforeRename:async()=>{throw Error('synthetic write interrupted');}}),/interrupted/);
  assert.deepEqual(await readFile(f.config.cloud_quote_refresh.snapshot_file),original);
  await assert.rejects(f.refresh({beforeRename:async()=>{await writeFile(f.configPath,canonical({...f.config,source_sha256:'b'.repeat(64)}));}}),/QUOTE_CONFIG_DRIFT/);
  await f.save();const expired=structuredClone(f.config);expired.cloud_quote_refresh.pricing_valid_until='2026-11-14T00:00:00Z';
  await assert.rejects(f.refresh({config:expired}),/QUOTE_TARIFF_EXPIRED/);
  const q=structuredClone(f.quote);q.fixed_commitments[1].upper_bound_cny=0;
  const c={...f.config,quote_sha256:sha256(canonical(q))};await assert.rejects(f.refresh({config:c,readConfig:async p=>p===c.cloud_quote_file?q:c}),/QUOTE_FIXED_LIABILITY/);
});

test('deadline retains a pending single flight and forbids late publication or a second request',async t=>{
  const f=await quoteFixture(t);let release,calls=0;
  const transport={call:async()=>{calls++;await new Promise(r=>{release=r;});return f.caller;}};
  await assert.rejects(f.refresh({transport,deadlineMs:20}),/QUOTE_REFRESH_DEADLINE/);
  await assert.rejects(f.refresh({transport,deadlineMs:20}),/QUOTE_REFRESH_BUSY/);assert.equal(calls,1);
  release();await new Promise(r=>setImmediate(r));await assert.rejects(readFile(f.config.cloud_quote_refresh.snapshot_file),{code:'ENOENT'});
  assert.equal((await f.refresh()).config.quote_sha256.length,64);
});

test('self-consistent hashes cannot legitimize a modified tariff, fixed commitment or effective config in a snapshot',async t=>{
  const f=await quoteFixture(t);await f.refresh();const path=f.config.cloud_quote_refresh.snapshot_file;
  const initial=JSON.parse(await readFile(path,'utf8'));
  for(const mutate of [s=>s.quote.fixed_commitments[1].upper_bound_cny=0,s=>s.quote.components[0].running_cny_per_node_hour=.1,
    s=>s.config.source_sha256='b'.repeat(64)]){
    const s=structuredClone(initial);mutate(s);s.config.quote_sha256=sha256(canonical(s.quote));await writeFile(path,canonical(s));
    await assert.rejects(f.refresh(),/QUOTE_SNAPSHOT_DRIFT/);
  }
});

test('both nodes include persistent-gated fault boots and six scans; low reserves fail and conservative reserves remain valid',async t=>{
  assert.equal(quoteSsmRequestBound(1440),319944);
  assert.equal(quoteSsmRequestBound(0),264);
  const f=await quoteFixture(t,{at:Date.parse('2026-11-15T16:00:00Z')});
  const refreshed=await f.refresh();
  assert.equal(refreshed.quote.refresh_bounds.remaining_window_minutes,1440);
  assert.equal(refreshed.quote.refresh_bounds.ssm_calls_upper_bound,319944);
  assert.equal(refreshed.quote.refresh_bounds.ssm_api_upper_bound_cny,12.8);
  for(const [coefficient,constant,rate] of [[94,48,.2],[354,528,.4],[618,1056,.8]])await t.test(`checks ${coefficient}N+${constant} reserve`,async st=>{
    const previous=await quoteFixture(st,{at:Date.parse('2026-11-15T16:00:00Z')});
    previous.quote.components.find(c=>c.kind==='secret').running_cny_per_node_hour=rate;
    previous.config.quote_sha256=sha256(canonical(previous.quote));await previous.save();
    const oldApi=Math.ceil((coefficient*1440+constant)/10000)*.4;
    assert.ok(8.4+2*rate*24>=6+oldApi,'the earlier quote would cover its old branch');
    if(coefficient===94)await assert.rejects(previous.refresh(),/QUOTE_SECRET_CALL_BOUND/);
    else assert.equal((await previous.refresh()).quote.refresh_bounds.ssm_calls_upper_bound,319944);
  });
});

test('the shared automatic/manual tick lock serializes publication across independent callers',async t=>{
  const f=await quoteFixture(t),release=await acquireControlTick(f.config.registration_directory,{now:()=>f.state.at});
  assert.equal(await acquireControlTick(f.config.registration_directory,{now:()=>f.state.at}),null);
  await f.refresh();await release();f.state.at+=60000;
  const next=await acquireControlTick(f.config.registration_directory,{now:()=>f.state.at});assert.equal(typeof next,'function');await next();
});

test('a rollback below the persisted tick clock closes admission before any quote or cloud request',async t=>{
  const f=await quoteFixture(t);let budget=true;
  const release=await acquireControlTick(f.config.registration_directory,{now:()=>f.state.at});await release();f.state.at-=1;
  const control={listPendingOperations:async()=>[],snapshot:async()=>({policy:{managed_nodes:true,budget_available:budget,revision:1,expense_policy_sha256:h},nodes:[]}),
    setAdmissionBudget:async(_,v)=>{budget=v;}};
  const handler=createExecutionPoolOpsHandler({control,configPath:f.configPath,expenseLedger:async()=>{throw Error('must not read ledger');},
    dependencies:{now:()=>f.state.at,cloud:{inventory:async()=>{throw Error('must not query cloud');},transport:f.transport}}});
  await handler.tick();assert.equal(budget,false);assert.equal(f.state.calls,0);
});

test('TC3 exposes only the two exact Lighthouse reads and preserves the Run status action',async()=>{
  const actions=[];const transport=new TencentTransport({region:'ap-beijing',credentials:async()=>({secretId:'synthetic',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+600000}),
    fetchImpl:async(url,o)=>{actions.push(o.headers['X-TC-Action']);if(url.includes('lighthouse'))assert.equal(o.headers['X-TC-Version'],'2020-03-24');return new Response(JSON.stringify({Response:{RequestId:'synthetic'}}));}});
  for(const a of ['DescribeInstances','DescribeInstancesTrafficPackages'])await transport.call('lighthouse',a,{InstanceIds:['lhins-4i18xeto'],Offset:0,Limit:1});
  await transport.call('cvm','DescribeInstancesStatus',{InstanceIds:['ins-synthetic']});
  await assert.rejects(transport.call('lighthouse','StartInstances',{}),/ACTION_NOT_ALLOWED/);
  await assert.rejects(transport.call('lighthouse','DescribeInstances',{InstanceIds:['lhins-other'],Offset:0,Limit:1}),/LIGHTHOUSE_EXACT_SCOPE/);
  assert.deepEqual(actions,['DescribeInstances','DescribeInstancesTrafficPackages','DescribeInstancesStatus']);
});

test('a failed refresh closes the PG budget flag yet still advances an ongoing graceful drain',async t=>{
  const f=await quoteFixture(t);let budget=true,drains=0;
  const node={identity:{account_id:f.config.account_id,region:f.config.region,instance_id:'ins-synthetic',epoch:'synthetic'},state:'draining',revision:1,drain_operation_id:'synthetic-drain'};
  const control={listPendingOperations:async()=>[],snapshot:async()=>({policy:{managed_nodes:true,budget_available:budget,revision:1,expense_policy_sha256:h},nodes:[node]}),
    setAdmissionBudget:async(_,v)=>{budget=v;},beginDrain:async()=>{drains++;return node;},drainProof:async()=>null};
  const handler=createExecutionPoolOpsHandler({configPath:f.configPath,control,expenseLedger:async()=>({captured_at:new Date(f.state.at).toISOString(),nodes:[],operations:[]}),
    dependencies:{now:()=>f.state.at,cloud:{inventory:async()=>[],transport:{call:async()=>{throw Error('synthetic LH outage');}}}}});
  await handler.tick();assert.equal(budget,false);assert.equal(drains,1);
});
