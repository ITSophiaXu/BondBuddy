import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, symlink, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, sha256} from './policy.mjs';
import {readExpenseHistory} from './expense-history.mjs';
import {produceExpenseSnapshot, costAdmission, expensePeriod} from './costcap.mjs';

const h='a'.repeat(64), now=Date.parse('2026-11-15T14:00:00Z');
const time=hours=>new Date(now+hours*3600000).toISOString();
const quote={version:'execution-cloud-price-bounds-v1',currency:'CNY',account_id:'123456',region:'ap-beijing',policy_revision:1,
  valid_from:time(-48),valid_until:time(48),fixed_commitments:['secret','snapshot'].map(kind=>({kind,upper_bound_cny:6,evidence_ref:'synthetic/fixed',evidence_sha256:h,enforced_bound_sha256:h})),
  components:['compute','disk','ip','egress','network','secret'].map(kind=>({kind,running_cny_per_node_hour:kind==='compute'?.8:0,stopped_cny_per_node_hour:0,evidence_ref:'synthetic/rate',evidence_sha256:h,enforced_bound_sha256:h}))};
const config={account_id:'123456',region:'ap-beijing',expense_policy_sha256:h,expense_policy_revision:1,quote_sha256:sha256(canonical(quote)),time_zone:'Asia/Shanghai',total_cap_cny_per_hour:4,period_cap_cny:48,reservation_hours:1,drain_reserve_hours:1,phase:'automatic',min_running:0};
const current=()=>({captured_at:time(0),nodes:[],operations:[]});
function archive(hours=21.5){
  const ledger=current();
  for(const id of ['ins-olda','ins-oldb']){
    const identity={account_id:config.account_id,region:config.region,instance_id:id,epoch:id+'-epoch'};
    ledger.operations.push({operation_id:'run-'+id,identity,action:'run',state:'completed',dispatched_at:time(-hours),created_at:time(-hours),completed_at:time(-hours+.01)});
    ledger.nodes.push({identity,launch_manifest_sha256:h,cloud_start_operation_id:'run-'+id,created_at:time(-hours+.01),destroyed_at:time(0)});
  }
  return {...expensePeriod(time(0),config.time_zone),currency:'CNY',time_zone:config.time_zone,expense_policy_revision:1,ledger_sha256:sha256(canonical(ledger)),fixed_obligation_dedup_receipt_sha256:h,external_liabilities:[{liability_id:'manual-builder',kind:'manual_compute',scope:'outside_source_ledger_and_current_quote',source_ref:'synthetic/manual-original',source_sha256:h,coverage_end:time(2),resource_ids:['ins-manual'],spent_upper_bound_cny:0,unknown_carry_upper_bound_cny:0,remaining_period_upper_bound_cny:0}],version:'execution-cloud-history-v1',account_id:config.account_id,region:config.region,expense_policy_sha256:h,source_system_identifier:'123456789',source_evidence_sha256:h,valid_from:time(-1),valid_until:time(2),ledger};
}
const pinned=history=>{history.ledger_sha256=sha256(canonical(history.ledger));return ({...config,external_expense_history:{file:'/synthetic/history.json',sha256:sha256(canonical(history)),source_ledger_sha256:sha256(canonical(history.ledger)),source_system_identifier:history.source_system_identifier,source_evidence_sha256:h}});};
const produce=(history,c=pinned(history),ledger=current())=>produceExpenseSnapshot({ledger,inventory:[],quote,config:c,history});

test('pinned source history reaches the real producer and hard-48 admission; repeated history is not charged twice',async t=>{
  t.mock.timers.enable({apis:['Date'],now});
  const baseline=produceExpenseSnapshot({ledger:current(),inventory:[],quote,config});
  assert.equal(costAdmission(baseline,[],config).allowed,true);
  const history=archive(),c=pinned(history),first=produce(history,c);
  assert.equal(first.spent_upper_bound_cny,34.4);
  assert.equal(costAdmission(first,[],c).reason,'period_cap');
  assert.deepEqual(produce(history,c),first,'repeated snapshots never accumulate liability');
  assert.deepEqual(produce(history,c,history.ledger),first,'same rows already in target ledger are deduplicated');
  const boundary=archive(21),bc=pinned(boundary);
  assert.equal(costAdmission(produce(boundary,bc),[],bc).allowed,true,'exactly 48 remains the existing boundary');
  const manual=archive(20);manual.external_liabilities[0].unknown_carry_upper_bound_cny=10.32;
  const mc=pinned(manual),ms=produce(manual,mc);
  assert.equal(ms.external_liability_upper_bound_cny,10.32);
  assert.equal(costAdmission(ms,[],mc).reason,'period_cap','independent manual liability also enters real admission');
  const overlap=structuredClone(manual);overlap.external_liabilities[0].resource_ids=['ins-olda'];
  assert.throws(()=>produce(overlap,pinned(overlap)),/EXPENSE_HISTORY_EXTERNAL_OVERLAP/);
  const duplicate=structuredClone(manual);duplicate.external_liabilities.push(duplicate.external_liabilities[0]);
  assert.throws(()=>produce(duplicate,pinned(duplicate)),/EXPENSE_HISTORY_EXTERNAL_OVERLAP/);
  const omitted=structuredClone(manual);delete omitted.external_liabilities;
  assert.throws(()=>produce(omitted,pinned(omitted)),/EXPENSE_HISTORY_EXTERNAL_REQUIRED/);
  const rollover=structuredClone(manual);rollover.period_key='Asia/Shanghai:2026-11-14';
  assert.throws(()=>produce(rollover,pinned(rollover)),/EXPENSE_HISTORY_TIME/);
  assert.equal(costAdmission({...first,external_history_sha256:null},[],c).reason,'expense_history_mismatch');
  assert.throws(()=>produce(undefined,c),/EXPENSE_HISTORY_SOURCE/);
  const conflict=structuredClone(history.ledger);conflict.operations[0].dispatched_at=time(-1);
  assert.throws(()=>produce(history,c,conflict),/EXPENSE_HISTORY_CONFLICT/);
  for(const mutate of [x=>x.account_id='foreign',x=>x.source_system_identifier='999',x=>x.source_evidence_sha256='b'.repeat(64),x=>x.expense_policy_sha256='b'.repeat(64)]){
    const bad=structuredClone(history);mutate(bad);assert.throws(()=>produce(bad,c),/EXPENSE_HISTORY_SOURCE/);
  }
  for(const mutate of [x=>x.valid_until=time(0),x=>x.valid_from=time(1),x=>x.ledger.captured_at=time(1)]){
    const bad=structuredClone(history);mutate(bad);assert.throws(()=>produce(bad,pinned(bad)),/EXPENSE_HISTORY_TIME/);
  }
  const missing=structuredClone(history);missing.ledger.nodes.pop();assert.throws(()=>produce(missing,pinned(missing)),/EXPENSE_HISTORY_COVERAGE/);
  const stale=structuredClone(history);stale.ledger.captured_at=time(-1);stale.ledger.nodes[0].destroyed_at=null;
  assert.throws(()=>produce(stale,pinned(stale)),/EXPENSE_HISTORY_STALE/);
  const directory=await mkdtemp(join(dirname(fileURLToPath(import.meta.url)),'.history-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'history.json');await writeFile(file,canonical(history),{mode:0o600});
  c.external_expense_history.file=file;
  assert.deepEqual(produce(await readExpenseHistory(c),c),first);
  await chmod(file,0o644);await assert.rejects(readExpenseHistory(c),/PRIVATE_FILE_PERMISSIONS/);await chmod(file,0o600);
  await writeFile(file,canonical(archive(21)));await assert.rejects(readExpenseHistory(c),/EXPENSE_HISTORY_HASH/);
  const link=join(directory,'link.json');await symlink(file,link);c.external_expense_history.file=link;
  await assert.rejects(readExpenseHistory(c),/EXPENSE_HISTORY_PATH/);
});
