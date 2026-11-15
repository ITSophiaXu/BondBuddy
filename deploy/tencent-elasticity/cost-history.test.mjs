import test from 'node:test';
import assert from 'node:assert/strict';
import {produceExpenseSnapshot} from './costcap.mjs';
import {canonical,sha256} from './policy.mjs';

const h='a'.repeat(64),hour=3600000;
const identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-history',epoch:'11111111-1111-4111-8111-111111111111'};
const epoch2='22222222-2222-4222-8222-222222222222',epoch3='33333333-3333-4333-8333-333333333333';
// All values are synthetic. Beijing midnight is November 14, 16:00 UTC.
const base=Date.parse('2026-11-14T16:00:00Z'),time=h=>new Date(base+h*hour).toISOString();
const quote={version:'execution-cloud-price-bounds-v1',currency:'CNY',account_id:identity.account_id,region:identity.region,policy_revision:1,
  valid_from:time(-48),valid_until:time(72),fixed_commitments:['secret','snapshot'].map(kind=>({kind,upper_bound_cny:6,evidence_ref:'synthetic/fixed',evidence_sha256:h,enforced_bound_sha256:h})),
  components:['compute','disk','ip','egress','network','secret'].map(kind=>({kind,running_cny_per_node_hour:kind==='compute'?.8:.08,stopped_cny_per_node_hour:kind==='compute'?0:.08,
    evidence_ref:'synthetic/bound',evidence_sha256:h,enforced_bound_sha256:h}))};
const config={account_id:identity.account_id,region:identity.region,expense_policy_revision:1,expense_policy_sha256:h,quote_sha256:sha256(canonical(quote)),time_zone:'Asia/Shanghai',
  total_cap_cny_per_hour:4,period_cap_cny:48,reservation_hours:1,drain_reserve_hours:1,phase:'automatic',min_running:0};
const launch=(id,epoch,at,action='start',state='completed')=>({operation_id:id,identity:{...identity,epoch},action,state,provider_request_id:'ack-'+id,created_at:time(at-.01),dispatched_at:time(at),completed_at:time(at+.01)});
const stop=(id,epoch,at)=>({operation_id:id,identity:{...identity,epoch},action:'stop',state:'completed',provider_request_id:'ack-'+id,created_at:time(at-.02),dispatched_at:time(at-.01),completed_at:time(at),
  cloud_observation:{latest_operation_request_id:'ack-'+id,latest_operation:'StopInstances',latest_operation_state:'SUCCESS',instance_state:'STOPPED',stop_charging_mode:'STOP_CHARGING',
    observed_at:time(at),evidence_ref:'synthetic/stop-'+id,evidence_sha256:h}});
function fixture(at=12){
  const run=launch('run',identity.epoch,0,'run'),s=stop('stop1',identity.epoch,2);
  return {captured_at:time(at),operations:[run,s],nodes:[{identity,state:'stopped',created_at:time(.02),destroyed_at:null,cloud_start_operation_id:'run',stop_operation_id:'stop1',launch_manifest_sha256:h}]};
}
function bound(ledger,state='STOPPED'){
  const inventory=ledger.nodes.filter(n=>n.destroyed_at===null).map(n=>({...n.identity,instance_state:state,observed_at:ledger.captured_at,evidence_ref:'synthetic/inventory',evidence_sha256:h}));
  return produceExpenseSnapshot({ledger,inventory,quote,config});
}
const close=(value,expected)=>assert.ok(Math.abs(value-expected)<.000002,`${value} != ${expected}`);
function reserve(ledger,state='intent'){
  const s={...launch('start2',epoch2,10,'start',state),dispatched_at:null,completed_at:null,provider_request_id:null};
  ledger.operations.push(s);ledger.nodes[0]={...ledger.nodes[0],identity:s.identity,state:'starting',cloud_start_operation_id:s.operation_id,stop_operation_id:null};
  return s;
}

test('warm dispatch permanently retains earlier STOP_CHARGING intervals, including repeated cycles',()=>{
  const ledger=fixture();
  ledger.operations.push(launch('start2',epoch2,6),stop('stop2',epoch2,8),launch('start3',epoch3,10));
  ledger.nodes[0]={...ledger.nodes[0],identity:{...identity,epoch:epoch3},state:'ready',cloud_start_operation_id:'start3',stop_operation_id:null};
  const result=bound(ledger,'RUNNING');close(result.spent_upper_bound_cny,6*1.2+6*.4);
  // Input order and today's stop pointer cannot change historical costs.
  ledger.operations.reverse();ledger.nodes[0].stop_operation_id='obsolete';
  close(bound(ledger,'RUNNING').spent_upper_bound_cny,result.spent_upper_bound_cny);
});

test('00:05 stop and noon dispatch do not add eleven hours fifty-five minutes of fictitious compute',()=>{
  const ledger=fixture(13);ledger.operations[1]=stop('stop1',identity.epoch,5/60);
  ledger.operations.push(launch('start2',epoch2,12));ledger.nodes[0]={...ledger.nodes[0],identity:{...identity,epoch:epoch2},state:'starting',cloud_start_operation_id:'start2',stop_operation_id:null};
  const result=bound(ledger,'RUNNING');close(result.spent_upper_bound_cny,(1+5/60)*1.2+(12-5/60)*.4);
  close(13*1.2-result.spent_upper_bound_cny,(12-5/60)*.8);
});

test('old never-dispatched warm intent only reserves future cost; cancellation does not rewrite stop history',()=>{
  const ledger=fixture(),original=structuredClone(ledger.nodes[0]),before=bound(ledger);
  const intent=reserve(ledger);intent.created_at=time(-20);
  const pending=bound(ledger);close(pending.spent_upper_bound_cny,before.spent_upper_bound_cny);
  assert.equal(pending.unknown_liability_cny,0);close(pending.reserved_upper_bound_cny,1.2);
  intent.state='cancelled';intent.completed_at=time(11);ledger.nodes[0]=original;
  const cancelled=bound(ledger);close(cancelled.spent_upper_bound_cny,before.spent_upper_bound_cny);close(cancelled.reserved_upper_bound_cny,.4);
  assert.equal(cancelled.unknown_liability_cny,0);
});

test('unknown warm Start is charged from dispatch, even without completion or provider ACK',()=>{
  const ledger=fixture(),s=reserve(ledger,'unknown');s.dispatched_at=time(10);s.created_at=time(4);
  const result=bound(ledger,'STARTING');close(result.spent_upper_bound_cny,4*1.2+8*.4);
  assert.deepEqual(result.rows[0].operation_ids,['start2']);close(result.reserved_upper_bound_cny,1.2);
});

test('Beijing cross-day running and stopped segments survive unknown Start carry and another warm epoch',()=>{
  const ledger=fixture(26);ledger.operations[1]=stop('stop1',identity.epoch,1);
  const s=reserve(ledger,'unknown');s.dispatched_at=time(25);
  const result=bound(ledger,'STARTING');assert.equal(result.period_key,'Asia/Shanghai:2026-11-16');
  close(result.spent_upper_bound_cny,1*.4+1*1.2);close(result.unknown_liability_cny,1*1.2+23*.4);
  const intentLedger=structuredClone(ledger);intentLedger.operations.at(-1).state='intent';intentLedger.operations.at(-1).dispatched_at=null;
  const prospective=bound(intentLedger);close(prospective.spent_upper_bound_cny,2*.4);assert.equal(prospective.unknown_liability_cny,0);
});

test('unknown Stop and missing or mismatched proof never reduce running costs',()=>{
  const mutations=[
    s=>{s.state='unknown';},s=>{s.provider_request_id=null;s.cloud_observation.latest_operation_request_id=null;},
    s=>{s.cloud_observation.latest_operation_request_id='wrong';},s=>{s.cloud_observation.latest_operation='StartInstances';},
    s=>{s.cloud_observation.latest_operation_state='PENDING';},s=>{s.cloud_observation.instance_state='RUNNING';},
    s=>{s.cloud_observation.stop_charging_mode='KEEP_CHARGING';},s=>{s.cloud_observation=null;},
    s=>{s.identity.epoch=epoch2;},s=>{s.identity.account_id='different';},s=>{s.identity.region='different';},s=>{s.identity.instance_id='ins-other';},
    s=>{s.dispatched_at=null;},s=>{s.completed_at=null;},s=>{s.cloud_observation.evidence_sha256=null;},s=>{s.cloud_observation.observed_at=time(0);}
  ];
  for(const mutate of mutations){const ledger=fixture();mutate(ledger.operations[1]);close(bound(ledger).spent_upper_bound_cny,12*1.2);}
});

test('late old-epoch Stop cannot close a dispatched successor; exact new-epoch Stop can',()=>{
  const ledger=fixture();ledger.operations.push(launch('start2',epoch2,6),stop('late-old-stop',identity.epoch,8));
  ledger.nodes[0]={...ledger.nodes[0],identity:{...identity,epoch:epoch2},state:'ready',cloud_start_operation_id:'start2',stop_operation_id:null};
  close(bound(ledger,'RUNNING').spent_upper_bound_cny,8*1.2+4*.4);
  ledger.operations.push(stop('stop2',epoch2,10));close(bound(ledger).spent_upper_bound_cny,6*1.2+6*.4);
});

test('unbound Run intent never accrues past running debt; dispatched unknown Run retains all liability',()=>{
  const run={...launch('run',identity.epoch,-20,'run','intent'),identity:null,dispatched_at:null,completed_at:null,provider_request_id:null,
    request:{account_id:identity.account_id,region:identity.region,instance_count:1,launch_manifest_sha256:h}};
  const ledger={captured_at:time(12),nodes:[],operations:[run]};const intent=bound(ledger);
  assert.equal(intent.spent_upper_bound_cny,0);assert.equal(intent.unknown_liability_cny,0);close(intent.reserved_upper_bound_cny,1.2);
  run.state='unknown';assert.throws(()=>bound(ledger),/EXPENSE_DISPATCH_REQUIRED/);
  run.dispatched_at=time(-4);const unknown=bound(ledger);close(unknown.spent_upper_bound_cny,12*1.2);close(unknown.unknown_liability_cny,4*1.2);
  run.state='cancelled';run.dispatched_at=null;const cancelled=bound(ledger);assert.equal(cancelled.spent_upper_bound_cny,0);assert.equal(cancelled.reserved_upper_bound_cny,0);
});

test('an open historical stopped tail cannot discount contradictory or unknown fresh inventory',()=>{
  const ledger=fixture();
  for(const state of ['RUNNING','PENDING','UNKNOWN'])assert.throws(()=>bound(ledger,state),/EXPENSE_CURRENT_STOP_UNCONFIRMED/);
  close(bound(ledger).spent_upper_bound_cny,2*1.2+10*.4);
});
