import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,apiURL,runtime,terms,config,pgBase} from './config.mjs';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';

// Every account and task is newly registered by this run. All financial
// mutations use authenticated product APIs and synthetic channel receipts.
function client(){
  const cookies=new Map();
  return async(method,path,body,expected=200)=>{
    const response=await fetch(baseURL+path,{method,headers:{origin:baseURL,'content-type':'application/json',
      cookie:[...cookies].map(([name,value])=>name+'='+value).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??''},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const data=await response.json();if(expected!==null)assert.equal(response.status,expected,JSON.stringify(data));
    return expected===null?{status:response.status,data}:data;
  };
}
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database}),startedAt=new Date().toISOString(),checks=[],skipped=[],accounts=[];
const record=name=>checks.push(name),state=a=>a.send('POST','/__billing-test/api/state',{});
const refresh=async(a,id,outcome='paid')=>{
  if(outcome!=='pending')await a.send('POST','/__billing-test/api/payment/outcome',{id,outcome,delivery:'query'});
  return a.send('POST','/api/v1/commerce/topups/'+id+'/refresh',{});
};
const amounts=(s,available,held=0,changeHeld=0)=>{assert.equal(BigInt(s.account.available_points),BigInt(available));assert.equal(BigInt(s.account.task_held_points),BigInt(held));assert.equal(BigInt(s.account.change_held_points),BigInt(changeHeld));};
async function account(plan='professional'){
  const username='billing_change_'+randomUUID().slice(0,8),send=client();
  const registered=await send('POST','/api/v1/auth/register',{username,password:'Synthetic-Change-2026!',accepted_terms_version:terms},201);
  const a={username,owner:registered.user_id,send};accounts.push(a);
  const paid=await send('POST','/api/v1/subscriptions',{request_id:randomUUID(),plan_id:plan,billing_cycle:'monthly',provider:'wechat'},201);
  a.firstOrderId=paid.order.order_id;a.subscriptionId=paid.subscription.id;
  await refresh(a,a.firstOrderId);amounts(await state(a),plan==='light'?21000:55000);return a;
}
async function quote(a,plan='intensive',cycle='monthly',requestId=randomUUID()){
  return{requestId,...await a.send('POST','/api/v1/subscriptions/change-quotes',{request_id:requestId,plan_id:plan,billing_cycle:cycle},201)};
}
async function checkout(a,q,requestId=randomUUID()){
  return{requestId,...await a.send('POST','/api/v1/subscriptions/change-checkouts',{request_id:requestId,quote_id:q.quote.quote_id,provider:'wechat'},201)};
}
async function original(a){return(await pool.query('SELECT p.lot_id,p.status,l.remaining,l.frozen FROM bb_subscription_periods p JOIN bb_credit_lots l ON l.id=p.lot_id WHERE p.owner_user_id=$1 AND p.order_id=$2',[a.owner,a.firstOrderId])).rows[0];}
async function prepare(a){const id=randomUUID();await a.send('POST','/__billing-test/api/review/prepare',{id});const s=await a.send('POST','/__billing-test/api/review/start',{id});return{id,runId:s.tasks.find(t=>t.id===id).run_id,state:s};}
async function clean(a){const audit=await auditCredits(pool,a.owner);assert.equal(audit.consistent,true,JSON.stringify(audit));}
try{
  assert.match(saved.database,/^bb_billing_functional_[a-f0-9]{16}$/);
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  const ready=await(await fetch(apiURL+'/__billing-test/status')).json(),launch=JSON.parse(readFileSync(join(runtime,'state.json'),'utf8'));
  assert.equal(ready.ready,true);assert.equal(ready.launch_id,launch.launchId);
  assert.equal((await pool.query("SELECT to_regclass('bb_subscription_changes') present")).rows[0].present,'bb_subscription_changes');

  const full=await account();
  await full.send('POST','/api/v1/subscriptions/'+full.subscriptionId+'/auto-renew',{request_id:randomUUID(),enabled:true});
  await full.send('POST','/api/v1/subscriptions/'+full.subscriptionId+'/auto-renew/refresh',{});
  const fq=await quote(full),fc=await checkout(full,fq);
  assert.equal(fq.quote.transfer_points,'55000');assert.equal(fq.quote.credit_offset_fen,'49900');assert.equal(fq.quote.pay_now_fen,'50000');
  amounts(await state(full),0,0,55000);await clean(full);
  const before=await state(full);assert.equal(before.account.subscription.auto_renew,false);assert.equal(before.account.subscription.mandate_status,'cancelled');
  record('professional monthly upgrade freezes 55000 transferable points, offsets 499 yuan and verifies old renewal cancellation');
  const replay=await checkout(full,fq,fc.requestId);assert.equal(replay.order.order_id,fc.order.order_id);amounts(await state(full),0,0,55000);
  await refresh(full,fc.order.order_id);await refresh(full,fc.order.order_id);amounts(await state(full),114000);await clean(full);
  assert.equal((await original(full)).remaining,'0');assert.equal((await original(full)).status,'superseded');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1',[full.owner])).rows[0].n,2);
  record('checkout and verified-payment replay creates one new 500-yuan order and one intensive contract without restoring old points');

  const held=await account(),task=await prepare(held);amounts(task.state,27805,27195);
  const hq=await quote(held,'professional','annual');assert.equal(hq.quote.transfer_points,'27805');assert.equal(hq.quote.excluded_held_points,'27195');
  assert.equal(hq.quote.credit_offset_fen,'25227');assert.equal(hq.quote.pay_now_fen,'513693');
  const hc=await checkout(held,hq);amounts(await state(held),0,27195,27805);await clean(held);
  await refresh(held,hc.order.order_id);amounts(await state(held),55000,27195);await clean(held);
  const cancelled=await held.send('POST','/api/v1/runs/'+task.runId+'/cancel',{reason:'user_cancelled'});assert.equal(cancelled.state,'cancelled');
  amounts(await state(held),82195);assert.equal((await original(held)).remaining,'27195');await clean(held);
  record('task-frozen points stay with original source during month-to-year conversion; real queued-task cancellation restores only that 27195-point hold');

  const used=await account(),usedTask=await prepare(used);
  const finished=await used.send('POST','/__billing-test/api/review/finish',{id:usedTask.id,outcome:'succeeded'},null);
  if(finished.status===409&&finished.data.code==='INPUT_REVISION_CONFLICT'){
    await used.send('POST','/api/v1/runs/'+usedTask.runId+'/cancel',{reason:'user_cancelled'});
    skipped.push('settled-task HTTP conversion: another queued task prevents local completion; this run cancelled only its own task');
  }else{
    assert.equal(finished.status,200,JSON.stringify(finished.data));amounts(finished.data,27805);
    const uq=await quote(used);assert.equal(uq.quote.credit_offset_fen,'25227');assert.equal(uq.quote.pay_now_fen,'74673');
    const uc=await checkout(used,uq);await refresh(used,uc.order.order_id);amounts(await state(used),114000);await clean(used);
    record('after a real synthetic-delivery settlement of 27195 points, upgrade offsets ceil(original paid consideration) and charges 746.73 yuan');
  }

  const chained=await account('light'),first=await quote(chained,'professional'),middle=await checkout(chained,first);await refresh(chained,middle.order.order_id);
  assert.equal(first.quote.credit_offset_fen,'19900');assert.equal(middle.order.amount_fen,'30000');amounts(await state(chained),55000);
  const cq=await quote(chained,'intensive','annual'),sameQuote=await quote(chained,'intensive','annual',cq.requestId);assert.equal(sameQuote.quote.quote_id,cq.quote.quote_id);
  const cc=await checkout(chained,cq);assert.equal(cc.order.amount_fen,'1029020');await refresh(chained,cc.order.order_id);amounts(await state(chained),114000);await clean(chained);
  const period=(await pool.query('SELECT * FROM bb_subscription_periods WHERE owner_user_id=$1 AND order_id=$2',[chained.owner,cc.order.order_id])).rows[0];
  const fund=(await pool.query('SELECT * FROM bb_subscription_funding_sources WHERE owner_user_id=$1 AND period_id=$2',[chained.owner,period.id])).rows;
  assert.equal(fund.length,3);assert.equal(new Set(fund.map(f=>f.source_order_id)).size,3);
  const schedule=(await pool.query('SELECT * FROM bb_subscription_credit_releases WHERE owner_user_id=$1 AND period_id=$2 ORDER BY installment_index',[chained.owner,period.id])).rows;
  assert.equal(schedule.length,12);assert.equal(schedule.reduce((n,r)=>n+BigInt(r.amount_fen),0n),1029020n);assert.ok(new Set(schedule.map(r=>r.amount_fen)).size>1);
  record('light month to professional month to intensive year preserves three original cash sources and exact unequal-cent installment allocation');
  const advanceId=randomUUID(),beforeOrders=(await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1',[chained.owner])).rows[0].n;
  let advanced=await chained.send('POST','/__billing-test/api/subscription/advance',{id:advanceId});amounts(advanced,228000);
  advanced=await chained.send('POST','/__billing-test/api/subscription/advance',{id:advanceId});amounts(advanced,228000);await clean(chained);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1',[chained.owner])).rows[0].n,beforeOrders);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM bb_subscription_lot_funding lf JOIN bb_subscription_credit_releases r ON r.lot_id=lf.lot_id
    WHERE r.period_id=$1 AND r.owner_user_id=$2 AND r.state='issued'`,[period.id,chained.owner])).rows[0].n,6);
  record('annual next-month release grants 114000 more points once with all funding sources and no new payment');

  const pending=await account(),pq=await quote(pending),pc=await checkout(pending,pq);
  await refresh(pending,pc.order.order_id,'pending');amounts(await state(pending),0,0,55000);
  assert.equal((await original(pending)).remaining,'55000');assert.equal((await original(pending)).status,'active');await clean(pending);
  record('unknown payment retains original contract and transfer hold without granting new points');
  await refresh(pending,pc.order.order_id,'failed');amounts(await state(pending),55000);await clean(pending);
  assert.equal((await original(pending)).status,'active');assert.equal((await original(pending)).frozen,'0');
  record('verified failed change releases exact held points and keeps the original monthly contract');

  const foreign=await pending.send('POST','/api/v1/subscriptions/change-checkouts',{request_id:randomUUID(),quote_id:fq.quote.quote_id,provider:'wechat'},404);assert.ok(foreign.code);
  record('another authenticated owner cannot spend an existing change quote');
  for(const a of accounts){await clean(a);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[a.owner])).rows[0].n,0);}
  record('all five new accounts pass authoritative wallet/funding audit with zero model calls');
  const proof={synthetic:true,realHttp:true,realPostgres:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),
    instanceId:saved.id,launchId:ready.launch_id,accounts:accounts.map(({username,owner,firstOrderId,subscriptionId})=>({username,owner,firstOrderId,subscriptionId})),checks,skipped,passed:checks.length,failed:0};
  writeFileSync(join(runtime,'subscription-change-verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}catch(error){writeFileSync(join(runtime,'subscription-change-verification.json'),JSON.stringify({synthetic:true,startedAt,finishedAt:new Date().toISOString(),
  accounts:accounts.map(({username,owner})=>({username,owner})),checks,skipped,passed:checks.length,failed:1,error:String(error)},null,2)+'\n');throw error;
}finally{await pool.end();}
