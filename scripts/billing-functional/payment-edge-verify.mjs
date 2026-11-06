import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,config,pgBase,runtime,terms} from './config.mjs';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';

// Channel facts and worker milestones are synthetic. All orders, credits,
// freezes, debits and corrections cross the authenticated product API and its
// real PostgreSQL transactions. SQL below is read-only and marker constrained.
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database});
const startedAt=new Date().toISOString(),nonce=randomUUID().slice(0,8);
const evidence=join(runtime,'payment-edge-'+nonce);mkdirSync(evidence,{recursive:true});
const checks=[],accounts=[],resources={orders:[],tasks:[],runs:[],refunds:[]};
const record=name=>{checks.push(name);console.log('PASS '+name);};
const requestLog=join(evidence,'http.jsonl');
function client(){
  const cookies=new Map(),a={};
  a.send=async(method,path,body)=>{
    const headers={origin:baseURL,cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??''};
    if(body!==undefined)headers['content-type']='application/json';
    const started=new Date().toISOString();
    const response=await fetch(baseURL+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    const logged=body&&Object.hasOwn(body,'password')?{...body,password:'[synthetic password omitted]'}:body;
    appendFileSync(requestLog,JSON.stringify({started,finished:new Date().toISOString(),account:a.username??null,method,path,body:logged,status:response.status,data})+'\n');
    return {status:response.status,data};
  };
  a.post=async(path,body={},expected=200)=>{const r=await a.send('POST',path,body);assert.equal(r.status,expected,JSON.stringify({path,...r}));return r.data;};
  a.get=async(path,expected=200)=>{const r=await a.send('GET',path);assert.equal(r.status,expected,JSON.stringify({path,...r}));return r.data;};
  a.state=()=>a.post('/__billing-test/api/state');
  a.pay=async(id)=>{await a.post('/__billing-test/api/payment/outcome',{id,outcome:'paid',delivery:'query'});await a.post('/api/v1/commerce/topups/'+id+'/refresh');};
  return a;
}
async function account(prefix){const a=client();a.username=prefix+randomUUID().slice(0,8);const r=await a.post('/api/v1/auth/register',{username:a.username,password:'Synthetic-Edge-2026!',accepted_terms_version:terms},201);a.owner=r.user_id;accounts.push(a);return a;}
const topup=async(a,amount)=>{const p=await a.post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:String(amount),provider:'wechat'},201);resources.orders.push(p.order_id);return p;};
const amounts=(s,available,taskHeld=0,refundHeld=0)=>{assert.equal(BigInt(s.account.available_points),BigInt(available));assert.equal(BigInt(s.account.task_held_points),BigInt(taskHeld));assert.equal(BigInt(s.account.refund_held_points),BigInt(refundHeld));};
const task=(s,id)=>{const t=s.tasks.find(t=>t.id===id);assert.ok(t,'Missing task '+id);return t;};
async function prepare(a,mode='commerce'){const id=randomUUID(),s=await a.post('/__billing-test/api/review/prepare',{id,mode});resources.tasks.push(id);return task(s,id);}
async function start(a,t){const s=await a.post('/__billing-test/api/review/start',{id:t.id});const r=task(s,t.id);if(!resources.runs.includes(r.run_id))resources.runs.push(r.run_id);return r;}
const cancel=(a,id)=>a.post('/api/v1/runs/'+id+'/cancel',{reason:'synthetic_edge_cleanup'});
const refundPath=id=>'/api/v1/commerce/topups/'+id+'/refunds';
async function refund(a,id,amount){const r=await a.post(refundPath(id),{request_id:randomUUID(),amount_fen:String(amount)},202);resources.refunds.push(r.refund_id);return r;}
async function refundOutcome(a,id,outcome){await a.post('/__billing-test/api/refund/outcome',{id,outcome,delivery:'query'});return a.post('/api/v1/commerce/refunds/'+id+'/refresh');}
const eligibility=(a,id)=>a.get('/api/v1/commerce/topups/'+id+'/refund-eligibility');
const rows=async(sql,params)=>(await pool.query(sql,params)).rows;
const allocations=async(owner,run)=>rows(`SELECT a.lot_id,a.points::text,a.charged_points::text,l.source_key,l.cash_order_id
  FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id JOIN bb_credit_lots l ON l.id=a.lot_id
  WHERE r.owner_user_id=$1 AND r.run_id=$2 ORDER BY l.created_at,l.id`,[owner,run]);
let failure;
try{
  assert.deepEqual(await rows('SELECT current_database() database,instance_id FROM bb_local_billing_instance'),[{database:saved.database,instance_id:saved.id}]);
  record('dedicated local database marker matches before any API mutation');

  const a=await account('edge_idem_'),key=randomUUID(),body={request_id:key,amount_fen:'30000',provider:'wechat'};
  const simultaneous=await Promise.all(Array.from({length:8},()=>a.send('POST','/api/v1/commerce/topups',body)));
  assert.deepEqual(simultaneous.map(r=>r.status),Array(8).fill(201));
  const ids=new Set(simultaneous.map(r=>r.data.order_id));assert.equal(ids.size,1);const orderId=[...ids][0];resources.orders.push(orderId);
  assert.equal((await rows('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2',[a.owner,key]))[0].n,1);
  assert.equal((await rows('SELECT count(*)::int n FROM bb_local_billing_charges WHERE order_id=$1 AND owner_user_id=$2',[orderId,a.owner]))[0].n,1);
  await a.pay(orderId);amounts(await a.state(),30000);
  record('eight concurrent real topup submissions share one order, one channel intent and one credited lot');
  const changed=await Promise.all(Array.from({length:4},()=>a.send('POST','/api/v1/commerce/topups',{...body,amount_fen:'30001'})));
  assert.deepEqual(changed.map(r=>r.status),Array(4).fill(409));
  const racingKey=randomUUID(),different=await Promise.all(['5001','5002'].map(amount_fen=>a.send('POST','/api/v1/commerce/topups',{request_id:racingKey,amount_fen,provider:'wechat'})));
  assert.deepEqual(different.map(r=>r.status).sort(),[201,409]);
  const created=different.find(r=>r.status===201).data;resources.orders.push(created.order_id);await a.post('/__billing-test/api/payment/close',{id:created.order_id});amounts(await a.state(),30000);
  record('concurrent reuse with changed topup bodies returns 409 and never creates a second intent');

  const t=await prepare(a),execute='/api/v1/projects/'+t.project_id+'/review-executions';
  const executions=await Promise.all(Array.from({length:6},()=>a.send('POST',execute,t.request)));
  assert.deepEqual(executions.map(r=>r.status),Array(6).fill(200));const runIds=new Set(executions.map(r=>r.data.run_id));assert.equal(runIds.size,1);
  const runId=[...runIds][0];resources.runs.push(runId);await start(a,t);
  amounts(await a.state(),2805,27195);assert.equal((await rows('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2',[a.owner,runId]))[0].n,1);
  await a.post(execute,{...t.request,expected_input_version:2},409);await cancel(a,runId);amounts(await a.state(),30000);
  record('six concurrent real execution submissions create one run and one hold; changed body conflicts and cancellation releases once');

  const candidates=[await prepare(a),await prepare(a)];
  const competing=await Promise.all(candidates.map(t=>a.send('POST','/api/v1/projects/'+t.project_id+'/review-executions',t.request)));
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,402]);amounts(await a.state(),2805,27195);
  const win=competing.findIndex(r=>r.status===200);resources.runs.push(competing[win].data.run_id);await start(a,candidates[win]);await cancel(a,competing[win].data.run_id);amounts(await a.state(),30000);
  record('two independent concurrent tasks cannot reserve the same wallet funds twice');

  const b=await account('edge_refund_'),bo=await topup(b,10000);await b.pay(bo.order_id);
  const refundBodies=[0,1].map(()=>({request_id:randomUUID(),amount_fen:'7000'}));
  const refunds=await Promise.all(refundBodies.map(body=>b.send('POST',refundPath(bo.order_id),body)));
  assert.deepEqual(refunds.map(r=>r.status).sort(),[202,409]);const refundIndex=refunds.findIndex(r=>r.status===202),pending=refunds[refundIndex].data;resources.refunds.push(pending.refund_id);
  amounts(await b.state(),3000,0,7000);
  assert.equal((await rows('SELECT count(*)::int n FROM bb_payment_refunds WHERE owner_user_id=$1 AND order_id=$2',[b.owner,bo.order_id]))[0].n,1);
  const replay=await Promise.all(Array.from({length:8},()=>b.send('POST',refundPath(bo.order_id),refundBodies[refundIndex])));
  assert.ok(replay.every(r=>r.status===202&&r.data.refund_id===pending.refund_id));amounts(await b.state(),3000,0,7000);
  await b.post(refundPath(bo.order_id),{...refundBodies[refundIndex],amount_fen:'7001'},409);
  assert.equal((await rows("SELECT count(*)::int n FROM bb_payment_refund_events WHERE refund_id=$1 AND kind='requested'",[pending.refund_id]))[0].n,1);
  await refundOutcome(b,pending.refund_id,'failed');amounts(await b.state(),10000);
  record('different-key concurrent refunds serialize within original-order capacity; eight same-key retries freeze once and failure releases once');

  const freeze=await refund(b,bo.order_id,9999),blocked=await prepare(b);
  await b.post('/api/v1/projects/'+blocked.project_id+'/review-executions',blocked.request,402);amounts(await b.state(),1,0,9999);
  const small=await prepare(b,'dynamic'),smallRun=await start(b,small);
  let state=await b.post('/__billing-test/api/review/progress',{id:small.id,stage:'input_lock'});
  amounts(state,0,0,9999);assert.equal(task(state,small.id).state,'paused');assert.equal(task(state,small.id).gross_charged_points,'1');
  const frozenLot=await rows('SELECT frozen::text FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2',[b.owner,'recharge:'+bo.order_id]);assert.equal(frozenLot[0].frozen,'9999');
  await refundOutcome(b,freeze.refund_id,'failed');
  state=await b.post('/__billing-test/api/review/finish',{id:small.id,outcome:'failed'});amounts(state,10000);assert.equal(task(state,small.id).charged_points,'0');
  assert.equal((await allocations(b.owner,smallRun.run_id)).reduce((n,r)=>n+BigInt(r.points),0n),1n);
  record('refund-frozen points cannot fund a full-price task or a dynamic milestone; the one spendable point pauses and failure restores it');

  for(let race=0;race<2;race++){
    const c=await account('edge_race_'),co=await topup(c,30000);await c.pay(co.order_id);const ct=await prepare(c);
    const taskRequest=()=>c.send('POST','/api/v1/projects/'+ct.project_id+'/review-executions',ct.request);
    const refundRequest=()=>c.send('POST',refundPath(co.order_id),{request_id:randomUUID(),amount_fen:'7000'});
    const pair=race===0?await Promise.all([taskRequest(),refundRequest()]):await Promise.all([refundRequest(),taskRequest()]);
    const taskResult=pair[race===0?0:1],refundResult=pair[race===0?1:0];
    assert.ok(taskResult.status===200&&refundResult.status===409||taskResult.status===402&&refundResult.status===202,JSON.stringify(pair));
    if(taskResult.status===200){resources.runs.push(taskResult.data.run_id);amounts(await c.state(),2805,27195);await start(c,ct);await cancel(c,taskResult.data.run_id);}
    else {resources.refunds.push(refundResult.data.refund_id);amounts(await c.state(),23000,0,7000);await refundOutcome(c,refundResult.data.refund_id,'failed');}
    amounts(await c.state(),30000);
  }
  record('concurrent task reservation versus cash-refund freeze never overcommits funds in either request launch order');

  const mixed=await account('edge_sources_'),one=await topup(mixed,10000);await mixed.pay(one.order_id);const two=await topup(mixed,30000);await mixed.pay(two.order_id);
  const mixedTask=await prepare(mixed),mixedRun=await start(mixed,mixedTask);amounts(await mixed.state(),12805,27195);
  const sourceAllocations=await allocations(mixed.owner,mixedRun.run_id);assert.equal(sourceAllocations.length,2);
  assert.deepEqual(sourceAllocations.map(r=>[r.source_key,r.points]),[['recharge:'+one.order_id,'10000'],['recharge:'+two.order_id,'17195']]);
  assert.equal((await eligibility(mixed,one.order_id)).refundable_fen,'0');assert.equal((await eligibility(mixed,two.order_id)).refundable_fen,'12805');
  state=await mixed.post('/__billing-test/api/review/finish',{id:mixedTask.id,outcome:'succeeded'});amounts(state,12805);assert.equal(task(state,mixedTask.id).charged_points,'27195');
  await mixed.post(refundPath(one.order_id),{request_id:randomUUID(),amount_fen:'1'},409);
  await mixed.post(refundPath(two.order_id),{request_id:randomUUID(),amount_fen:'12806'},409);
  const remaining=await refund(mixed,two.order_id,12805);await refundOutcome(mixed,remaining.refund_id,'succeeded');amounts(await mixed.state(),0);
  assert.equal((await eligibility(mixed,two.order_id)).refunded_fen,'12805');
  record('successful task consumes exact slices across two purchases; refunds use original-source remainder, not aggregate wallet balance');

  const corrected=await account('edge_correction_'),originA=await topup(corrected,1000);await corrected.pay(originA.order_id);const originB=await topup(corrected,30000);await corrected.pay(originB.order_id);
  for(const stages of [['input_lock'],['input_lock','model_generation']]){
    const ft=await prepare(corrected,'dynamic'),fr=await start(corrected,ft);
    for(const stage of stages)await corrected.post('/__billing-test/api/review/progress',{id:ft.id,stage});
    const before=await allocations(corrected.owner,fr.run_id),beforeGross=before.reduce((n,r)=>n+BigInt(r.points),0n);assert.ok(beforeGross>0n);
    if(stages.length===2)assert.equal(new Set(before.map(r=>r.cash_order_id)).size,2);
    state=await corrected.post('/__billing-test/api/review/finish',{id:ft.id,outcome:'failed'});amounts(state,31000);assert.equal(task(state,ft.id).charged_points,'0');
    // Finishing itself can durably advance dynamic work and collect its final
    // incremental point before failure correction. Compare the final ledger,
    // rather than assuming the pre-finish milestone was the last debit.
    const gross=(await allocations(corrected.owner,fr.run_id)).reduce((n,r)=>n+BigInt(r.points),0n);assert.ok(gross>=beforeGross);
    const settled=(await rows("SELECT COALESCE(sum(e.points),0)::text points FROM bb_credit_events e JOIN bb_credit_reservations r ON r.id=e.reservation_id WHERE r.owner_user_id=$1 AND r.run_id=$2 AND e.kind='settle'",[corrected.owner,fr.run_id]))[0].points;
    assert.equal(BigInt(settled),gross);
    const events=await rows(`SELECT e.lot_id,e.points::text,l.cash_order_id,l.cash_origin_lot_id,l.cash_basis_fen::text,l.cash_basis_points::text
      FROM bb_credit_events e JOIN bb_credit_reservations r ON r.id=e.reservation_id JOIN bb_credit_lots l ON l.id=e.lot_id
      WHERE r.owner_user_id=$1 AND r.run_id=$2 AND e.kind='correction' ORDER BY e.lot_id`,[corrected.owner,fr.run_id]);
    assert.equal(events.reduce((n,r)=>n+BigInt(r.points),0n),gross);
    for(const e of events){assert.ok([originA.order_id,originB.order_id].includes(e.cash_order_id));assert.ok(e.cash_origin_lot_id);assert.equal(e.cash_basis_fen,e.cash_order_id===originA.order_id?'1000':'30000');assert.equal(e.cash_basis_points,e.cash_basis_fen);}
    const beforeReplay=await rows('SELECT id,remaining::text,frozen::text FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id',[corrected.owner]);
    await corrected.post('/__billing-test/api/review/finish',{id:ft.id,outcome:'failed'});
    assert.deepEqual(await rows('SELECT id,remaining::text,frozen::text FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id',[corrected.owner]),beforeReplay);
    assert.equal((await eligibility(corrected,originA.order_id)).refundable_fen,'1000');assert.equal((await eligibility(corrected,originB.order_id)).refundable_fen,'30000');
  }
  record('failure after input lock and after cross-source model milestone restores exact cash provenance once and preserves full original-order refund capacity');
  const ra=await refund(corrected,originA.order_id,1000);await refundOutcome(corrected,ra.refund_id,'succeeded');
  const rb=await refund(corrected,originB.order_id,30000);await refundOutcome(corrected,rb.refund_id,'succeeded');amounts(await corrected.state(),0);
  await corrected.post(refundPath(originA.order_id),{request_id:randomUUID(),amount_fen:'1'},409);await corrected.post(refundPath(originB.order_id),{request_id:randomUUID(),amount_fen:'1'},409);
  record('source-preserving failure corrections can be cashed out only once and cannot exceed either original payment');

  for(const a of accounts){
    const audit=await auditCredits(pool,a.owner);assert.equal(audit.consistent,true,JSON.stringify(audit));
    assert.equal((await rows('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[a.owner]))[0].n,0);
    assert.equal((await rows("SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND state NOT IN ('cancelled','failed','succeeded','test_completed','rejected')",[a.owner]))[0].n,0);
    assert.equal((await rows('SELECT count(*)::int n FROM bb_credit_lots WHERE owner_user_id=$1 AND (remaining<0 OR frozen<0 OR frozen>remaining)',[a.owner]))[0].n,0);
  }
  record('every fresh test account passes wallet audit with nonnegative lots, no pending task and zero real model calls');
}catch(error){failure=error;}
finally{
  const cleanup=[];
  if(failure)for(const a of accounts){
    const active=await rows("SELECT id FROM bb_runs WHERE owner_user_id=$1 AND state NOT IN ('cancelled','failed','succeeded','test_completed','rejected')",[a.owner]);
    for(const run of active)try{await cancel(a,run.id);cleanup.push({owner:a.owner,run:run.id,cancelled:true});}catch(error){cleanup.push({owner:a.owner,run:run.id,error:String(error)});}
  }
  const proof={synthetic:true,realHttp:true,realPostgres:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,
    accounts:accounts.map(({username,owner})=>({username,owner})),resources,passed:checks.length,failed:failure?1:0,skipped:0,checks,cleanup,...(failure?{error:String(failure),stack:failure.stack}:{})};
  writeFileSync(join(evidence,'verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({evidence,...proof}));await pool.end();
}
if(failure)throw failure;
