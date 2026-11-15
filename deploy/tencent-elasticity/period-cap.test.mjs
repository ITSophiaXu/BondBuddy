import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical, sha256} from './policy.mjs';
import {expensePeriod, produceExpenseSnapshot, costAdmission} from './costcap.mjs';
import {refreshCloudQuote} from './cloud-quote-refresh.mjs';

// Synthetic complete history and cloud responses; no SQL or provider calls.
const h='a'.repeat(64), now=Date.parse('2026-11-15T14:00:00Z');
const time=hours=>new Date(now+hours*3600000).toISOString();
const fees=['spent_upper_bound_cny','reserved_upper_bound_cny','unknown_liability_cny','drain_reserve_cny',
  'resident_remaining_period_cny','prospective_slot_cny','fixed_commitments_upper_bound_cny','external_liability_upper_bound_cny'];
const total=s=>fees.reduce((n,k)=>n+Math.ceil(s[k]*1e6),0)/1e6;

async function fixture(t, cap) {
  const directory=await mkdtemp(join(tmpdir(),'bb-period-cap-'));
  t.after(()=>rm(directory,{recursive:true}));
  const period=expensePeriod(time(0),'Asia/Shanghai');
  const quote={version:'execution-cloud-price-bounds-v1',currency:'CNY',account_id:'100006372392',region:'ap-beijing',policy_revision:1,
    valid_from:period.period_start,valid_until:period.period_end,
    fixed_commitments:[{kind:'secret',upper_bound_cny:6},{kind:'snapshot',upper_bound_cny:12}].map(c=>({...c,evidence_ref:'synthetic/fixed',evidence_sha256:h,enforced_bound_sha256:h})),
    components:['compute','disk','ip','egress','network','secret'].map((kind,i)=>({kind,running_cny_per_node_hour:[.8,.11,0,0,0,.4][i],
      stopped_cny_per_node_hour:[0,.11,0,0,0,.4][i],evidence_ref:'synthetic/rate',evidence_sha256:h,enforced_bound_sha256:h}))};
  const config={account_id:quote.account_id,region:quote.region,phase:'two_node_validation',min_running:1,time_zone:'Asia/Shanghai',
    expense_policy_sha256:h,expense_policy_revision:1,quote_sha256:sha256(canonical(quote)),total_cap_cny_per_hour:4,reservation_hours:1,drain_reserve_hours:1,
    registration_directory:directory,cloud_quote_file:join(directory,'quote.json'),
    cloud_quote_refresh:{version:'lighthouse-quote-refresh-v1',instance_id:'lhins-4i18xeto',bundle_id:'bundle_starter_mc_med4_01',
      bandwidth_mbps:5,traffic_package_total_bytes:536870912000,pricing_valid_until:period.period_end,snapshot_file:join(directory,'cloud-quote-snapshot.json')}};
  if(cap!==undefined)config.period_cap_cny=cap;
  const configPath=join(directory,'config.json');
  await writeFile(configPath,canonical(config),{mode:0o600});await writeFile(config.cloud_quote_file,canonical(quote),{mode:0o600});
  let calls=0;
  const transport={async call(service,action){
    calls++;
    if(service==='sts')return {AccountId:config.account_id,RequestId:'synthetic-caller'};
    if(action==='DescribeInstances')return {TotalCount:1,RequestId:'synthetic-instance',InstanceSet:[{
      InstanceId:'lhins-4i18xeto',BundleId:'bundle_starter_mc_med4_01',InstanceState:'RUNNING',Zone:'ap-beijing-7',ExpiredTime:time(48),
      InternetAccessible:{InternetChargeType:'TRAFFIC_POSTPAID_BY_HOUR',InternetMaxBandwidthOut:5,PublicIpAssigned:true}}]};
    assert.equal(action,'DescribeInstancesTrafficPackages');
    return {TotalCount:1,RequestId:'synthetic-traffic',InstanceTrafficPackageSet:[{InstanceId:'lhins-4i18xeto',TrafficPackageSet:[{
      TrafficPackageId:'lhtfp-synthetic',TrafficUsed:0,TrafficPackageTotal:536870912000,TrafficPackageRemaining:536870912000,TrafficOverflow:0,
      StartTime:period.period_start,EndTime:time(48),Deadline:time(48),Status:'NETWORK_NORMAL'}]}]};
  }};
  return {config,quote,configPath,calls:()=>calls,refresh:()=>refreshCloudQuote({configPath,config,transport,capturedAt:time(0),now:()=>now})};
}

function completeHistory(config, hours=22, external=10.32) {
  const ledger={captured_at:time(0),nodes:[],operations:[]};
  for(const id of ['ins-olda','ins-oldb']){
    const identity={account_id:config.account_id,region:config.region,instance_id:id,epoch:id+'-epoch'};
    ledger.operations.push({operation_id:'run-'+id,identity,action:'run',state:'completed',created_at:time(-hours),
      dispatched_at:time(-hours),completed_at:time(-hours+.01)});
    ledger.nodes.push({identity,launch_manifest_sha256:h,cloud_start_operation_id:'run-'+id,created_at:time(-hours+.01),destroyed_at:time(0)});
  }
  const history={version:'execution-cloud-history-v1',...expensePeriod(time(0),config.time_zone),currency:'CNY',time_zone:config.time_zone,
    account_id:config.account_id,region:config.region,expense_policy_sha256:h,expense_policy_revision:1,
    source_system_identifier:'123456789',source_evidence_sha256:h,valid_from:time(-1),valid_until:time(2),ledger,ledger_sha256:sha256(canonical(ledger)),
    fixed_obligation_dedup_receipt_sha256:h,external_liabilities:[{liability_id:'manual-builder',kind:'manual_compute',scope:'outside_source_ledger_and_current_quote',
      source_ref:'synthetic/manual-original',source_sha256:h,resource_ids:['ins-manual'],coverage_end:time(2),
      spent_upper_bound_cny:0,unknown_carry_upper_bound_cny:external,remaining_period_upper_bound_cny:0}]};
  const pinned={...config,external_expense_history:{file:'/synthetic/history.json',sha256:sha256(canonical(history)),
    source_ledger_sha256:history.ledger_sha256,source_system_identifier:history.source_system_identifier,source_evidence_sha256:h}};
  return {history,config:pinned};
}
function bound(quote, config, hours, external) {
  const source=completeHistory(config,hours,external);
  return {...source,snapshot:produceExpenseSnapshot({ledger:{captured_at:time(0),nodes:[],operations:[]},inventory:[],quote,config:source.config,history:source.history})};
}

test('default 48 and explicit 96 flow through refreshed quote, complete history and real admission',async t=>{
  t.mock.timers.enable({apis:['Date'],now});
  const results=[];
  for(const cap of [undefined,48,96]){
    const f=await fixture(t,cap),fresh=await f.refresh(),b=bound(fresh.quote,fresh.config);
    assert.equal(f.calls(),3);assert.equal(b.snapshot.period_cap_cny,cap??48);
    assert.equal(b.snapshot.external_liability_upper_bound_cny,10.32);
    assert.ok(total(b.snapshot)>48&&total(b.snapshot)<96);
    const result=costAdmission(b.snapshot,[],b.config);
    assert.equal(result.allowed,cap===96);
    if(cap!==96)assert.equal(result.reason,'period_cap');
    else assert.equal(result.headroom_cny,(96000000-Math.round(total(b.snapshot)*1e6))/1e6);
    results.push(b.snapshot);
    assert.deepEqual(bound(fresh.quote,fresh.config).snapshot,b.snapshot,'repeated history never accumulates or drops liability');
    assert.deepEqual(fresh.quote.components.map(c=>[c.kind,c.running_cny_per_node_hour,c.stopped_cny_per_node_hour]),f.quote.components.map(c=>[c.kind,c.running_cny_per_node_hour,c.stopped_cny_per_node_hour]));
    assert.deepEqual(fresh.quote.fixed_commitments,f.quote.fixed_commitments);
  }
  for(const key of [...fees,'rows','ledger_sha256','resource_ids'])assert.deepEqual(results[0][key],results[2][key]);
});

test('exact configured boundaries admit and the next micro-CNY rejects without omitting external responsibility',async t=>{
  t.mock.timers.enable({apis:['Date'],now});
  for(const cap of [undefined,48,96]){
    const f=await fixture(t,cap),limit=cap??48;
    const baseline=bound(f.quote,f.config,2,0),external=(limit*1e6-Math.round(total(baseline.snapshot)*1e6))/1e6;
    const exact=bound(f.quote,f.config,2,external);
    assert.equal(total(exact.snapshot),limit);assert.deepEqual(costAdmission(exact.snapshot,[],exact.config),{allowed:true,headroom_cny:0});
    const over=bound(f.quote,f.config,2,external+.000001);
    assert.ok(total(over.snapshot)>limit);assert.deepEqual(costAdmission(over.snapshot,[],over.config),{allowed:false,reason:'period_cap'});
  }
});

test('snapshot cap drift cannot raise a default cap or reuse an old admission after protected config changes',async t=>{
  t.mock.timers.enable({apis:['Date'],now});
  const f=await fixture(t),b=bound(f.quote,f.config);
  assert.equal(costAdmission({...b.snapshot,period_cap_cny:96},[],b.config).reason,'expense_source_mismatch');
  assert.equal(costAdmission(b.snapshot,[],{...b.config,period_cap_cny:96}).reason,'expense_source_mismatch');
});

test('invalid caps reject at refresh, producer and admission while hourly and reservation bounds stay enforced',async t=>{
  t.mock.timers.enable({apis:['Date'],now});
  const valid=await fixture(t,96),b=bound(valid.quote,valid.config);
  for(const cap of [null,0,-1,'96',NaN,Infinity,.0000001,96.0000001,Number.MAX_SAFE_INTEGER]){
    const f=await fixture(t,cap);
    await assert.rejects(f.refresh(),/EXPENSE_PERIOD_CAP/);assert.equal(f.calls(),0);
    assert.throws(()=>bound(valid.quote,{...valid.config,period_cap_cny:cap}),/EXPENSE_PERIOD_CAP/);
    assert.equal(costAdmission(b.snapshot,[],{...b.config,period_cap_cny:cap}).reason,'expense_source_mismatch');
  }
  for(const delta of [{total_cap_cny_per_hour:4.01},{reservation_hours:.5},{drain_reserve_hours:.5}])
    assert.throws(()=>bound(valid.quote,{...valid.config,...delta}),/EXPENSE_RATE_CAP/);
});
