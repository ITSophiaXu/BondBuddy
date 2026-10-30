import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,apiURL,runtime,terms,config,pgBase} from './config.mjs';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';

// The repair command is intentionally private and is verified in PostgreSQL
// integration tests. This smoke checks the affected public settlement path.
const cookies=new Map();
async function send(method,path,body,expected=200){
  const response=await fetch(baseURL+path,{method,headers:{origin:baseURL,'content-type':'application/json',
    cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??''},...(body===undefined?{}:{body:JSON.stringify(body)})});
  for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
  const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
}
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database}),startedAt=new Date().toISOString(),checks=[],username='billing_settle_'+randomUUID().slice(0,8);
let owner;
const state=()=>send('POST','/__billing-test/api/state',{});
const balance=(s,available,held=0)=>{assert.equal(BigInt(s.account.available_points),BigInt(available));assert.equal(BigInt(s.account.task_held_points),BigInt(held));};
const task=(s,id)=>{const t=s.tasks.find(t=>t.id===id);assert.ok(t);return t;};
const prepare=async()=>{const id=randomUUID(),s=await send('POST','/__billing-test/api/review/prepare',{id});assert.equal(task(s,id).quote.auto_charge,true);assert.equal(BigInt(task(s,id).quote.points),27195n);return id;};
try{
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  assert.equal((await pool.query("SELECT to_regprocedure('bb_review_assembly_recovery_credit_ready(bb_runs)')::text ready")).rows[0].ready,'bb_review_assembly_recovery_credit_ready(bb_runs)');
  const ready=await(await fetch(apiURL+'/__billing-test/status')).json(),launch=JSON.parse(readFileSync(join(runtime,'state.json'),'utf8'));assert.equal(ready.ready,true);assert.equal(ready.launch_id,launch.launchId);
  owner=(await send('POST','/api/v1/auth/register',{username,password:'Synthetic-Settlement-2026!',accepted_terms_version:terms},201)).user_id;
  const paid=await send('POST','/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'100000',provider:'wechat'},201);
  await send('POST','/api/v1/commerce/topups/'+paid.order_id+'/refresh',{});balance(await state(),100000);checks.push('one new random account funds its real wallet through a synthetic verified topup');
  const failed=await prepare();let current=await send('POST','/__billing-test/api/review/start',{id:failed});balance(current,72805,27195);const failedRun=task(current,failed).run_id;
  current=await send('POST','/__billing-test/api/review/finish',{id:failed,outcome:'failed'});balance(current,100000);assert.equal(task(current,failed).charge_state,'released');assert.equal(BigInt(task(current,failed).charged_points??0),0n);
  checks.push('failed full review releases its complete 27195-point reservation and charges zero');
  current=await send('POST','/__billing-test/api/review/start',{id:failed});assert.equal(task(current,failed).run_id,failedRun);balance(current,100000);
  current=await send('POST','/__billing-test/api/review/finish',{id:failed,outcome:'failed'});balance(current,100000);checks.push('replayed failed submission and completion keep the original run without another hold or release');
  const delivered=await prepare();current=await send('POST','/__billing-test/api/review/start',{id:delivered});balance(current,72805,27195);const deliveredRun=task(current,delivered).run_id;
  current=await send('POST','/__billing-test/api/review/finish',{id:delivered,outcome:'succeeded'});balance(current,72805);assert.equal(task(current,delivered).charge_state,'settled');assert.equal(BigInt(task(current,delivered).charged_points),27195n);
  current=await send('POST','/__billing-test/api/review/finish',{id:delivered,outcome:'succeeded'});balance(current,72805);checks.push('delivered synthetic Word settles exactly once; repeated completion does not debit again');
  const refund=await send('GET','/api/v1/tasks/'+deliveredRun+'/refund-eligibility');assert.equal(refund.charged_points,'27195');assert.equal(refund.enabled,true);assert.equal(refund.units.length,1);checks.push('success exposes its exact originally charged quality-refund unit');
  const ledger=(await pool.query(`SELECT r.run_id,r.state,r.charged_points,
    (SELECT count(*)::int FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='reserve') reserves,
    (SELECT count(*)::int FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='settle') settles,
    (SELECT count(*)::int FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='release') releases
    FROM bb_credit_reservations r WHERE r.owner_user_id=$1 ORDER BY r.run_id`,[owner])).rows;
  assert.equal(ledger.length,2);for(const r of ledger){assert.equal(r.reserves,1);assert.equal(r.settles,r.run_id===deliveredRun?1:0);assert.equal(r.releases,r.run_id===failedRun?1:0);}
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  const audit=await auditCredits(pool,owner);assert.equal(audit.consistent,true,JSON.stringify(audit));checks.push('owner-only SQL confirms one reserve per run, one settle or release, zero model calls and a consistent ledger');
  const proof={synthetic:true,realHttp:true,realPostgres:true,modelCallsPerformed:0,realPaymentCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,launchId:ready.launch_id,
    username,owner,failedRun,deliveredRun,checks,passed:checks.length,failed:0,skipped:0};
  writeFileSync(join(runtime,'review-settlement-smoke.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}catch(error){writeFileSync(join(runtime,'review-settlement-smoke.json'),JSON.stringify({synthetic:true,startedAt,finishedAt:new Date().toISOString(),username,owner,checks,passed:checks.length,failed:1,error:String(error)},null,2)+'\n');throw error;
}finally{await pool.end();}
