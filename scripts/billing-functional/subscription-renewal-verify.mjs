import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,apiURL,runtime,terms,config,pgBase} from './config.mjs';
import {syntheticPaymentProvider} from './provider.mjs';

// Real HTTP and production subscription/payment logic. Only random accounts
// created by this run receive a synthetic subscription clock or payments.
function client(){
  const cookies=new Map();
  return async(method,path,body,expected=200,extraHeaders={})=>{
    const response=await fetch(baseURL+path,{method,headers:{origin:baseURL,'content-type':'application/json',
      cookie:[...cookies].map(([name,value])=>name+'='+value).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??'',...extraHeaders},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
  };
}
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database}),startedAt=new Date().toISOString(),checks=[],accounts=[];
const record=name=>checks.push(name),equalPoints=(state,value)=>assert.equal(BigInt(state.account.available_points),BigInt(value));
const state=account=>account.send('POST','/__billing-test/api/state',{});
const advanceBodies=new WeakMap();
async function advance(account,id=randomUUID()){
  let bodies=advanceBodies.get(account);if(!bodies){bodies=new Map();advanceBodies.set(account,bodies);}
  if(!bodies.has(id)){
    const expected_event=(await state(account)).subscription_test.next_event;assert.ok(expected_event,'A new action requires a verified next event');
    bodies.set(id,{id,expected_event});
  }
  // A retry reuses both the original UUID and its original event snapshot.
  return account.send('POST','/__billing-test/api/subscription/advance',bodies.get(id));
}
async function createAccount(cycle){
  const username='billing_renew_'+randomUUID().slice(0,8),send=client();
  const registration=await send('POST','/api/v1/auth/register',{username,password:'Synthetic-Renewal-2026!',accepted_terms_version:terms},201);
  const account={username,owner:registration.user_id,cycle,send};accounts.push(account);
  const checkout=await send('POST','/api/v1/subscriptions',{request_id:randomUUID(),plan_id:'light',provider:'wechat',billing_cycle:cycle},201);
  assert.equal(BigInt(checkout.order.amount_fen),cycle==='annual'?214920n:19900n);
  account.subscriptionId=checkout.subscription.id;account.firstOrderId=checkout.order.order_id;
  await send('POST','/__billing-test/api/payment/outcome',{id:account.firstOrderId,outcome:'paid',delivery:'query'});
  await send('POST','/api/v1/commerce/topups/'+account.firstOrderId+'/refresh',{});
  equalPoints(await state(account),21000);
  await send('POST','/api/v1/subscriptions/'+account.subscriptionId+'/auto-renew',{request_id:randomUUID(),enabled:true});
  const authorized=await send('POST','/api/v1/subscriptions/'+account.subscriptionId+'/auto-renew/refresh',{});
  assert.equal(authorized.subscription.auto_renew,true);assert.equal(authorized.subscription.mandate_status,'active');
  return account;
}
async function evidence(account){
  return(await pool.query(`SELECT
    (SELECT count(*)::int FROM bb_recharge_orders WHERE owner_user_id=$1) orders,
    (SELECT count(*)::int FROM bb_subscription_credit_releases WHERE owner_user_id=$1 AND state='issued') releases,
    (SELECT COALESCE(sum(remaining),0)::text FROM bb_credit_lots WHERE owner_user_id=$1) remaining,
    (SELECT now_at FROM bb_local_billing_clock WHERE owner_user_id=$1) clock`,[account.owner])).rows[0];
}
try{
  assert.match(saved.database,/^bb_billing_functional_[a-f0-9]{16}$/);
  const marker=(await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows;
  assert.deepEqual(marker,[{database:saved.database,instance_id:saved.id}]);
  const status=await(await fetch(apiURL+'/__billing-test/status')).json(),launch=JSON.parse(readFileSync(join(runtime,'state.json'),'utf8'));
  assert.equal(status.ready,true);assert.equal(status.launch_id,launch.launchId);
  const anonymous=client();await anonymous('POST','/__billing-test/api/subscription/advance',{id:randomUUID()},401);record('anonymous subscription simulation denied');
  const monthly=await createAccount('monthly'),annual=await createAccount('annual');
  await monthly.send('POST','/__billing-test/api/subscription/advance',{id:randomUUID()},403,{'x-bb-csrf':''});record('subscription simulation requires real CSRF');
  const catalog=await monthly.send('GET','/api/v1/subscriptions/catalog');
  assert.equal(catalog.auto_renew_available,true);assert.equal(BigInt(catalog.plans.find(p=>p.id==='light').annual_amount_fen),214920n);record('actual catalog exposes recurring capability and annual 10% discount');
  const otherBefore=await evidence(annual),monthlyRequest=randomUUID();
  let current=await advance(monthly,monthlyRequest);equalPoints(current,42000);assert.equal(current.subscription_test.charges.recurring_paid_orders,1);
  assert.equal(current.subscription_test.charges.paid_orders,2);assert.equal(current.subscription_test.charges.simulated_paid_fen,'39800');
  assert.deepEqual(await evidence(annual),otherBefore);record('monthly due event charges 199 yuan and grants one month, without changing another account');
  const monthlyAfter=await evidence(monthly);current=await advance(monthly,monthlyRequest);assert.deepEqual(await evidence(monthly),monthlyAfter);
  equalPoints(current,42000);record('replay of same advance and renewal is idempotent');
  const disabled=await monthly.send('POST','/api/v1/subscriptions/'+monthly.subscriptionId+'/auto-renew',{request_id:randomUUID(),enabled:false});
  assert.equal(disabled.subscription.auto_renew,false);assert.equal(disabled.subscription.mandate_status,'cancelled');
  current=await advance(monthly);equalPoints(current,42000);assert.equal(current.subscription_test.charges.recurring_paid_orders,1);assert.equal(current.subscription_test.charges.paid_orders,2);
  record('cancelled mandate does not charge or grant a new month at the next due date');
  // A fresh adapter reads the persisted mandate: cancellation is not in memory.
  const localProvider=syntheticPaymentProvider(pool,saved);
  for(const account of [monthly,annual]){
    const row=(await pool.query('SELECT * FROM bb_local_billing_mandates WHERE owner_user_id=$1',[account.owner])).rows[0];
    const proof=await localProvider.recurring.queryMandate({requestId:row.request_id,subscriptionId:row.subscription_id,merchantId:row.merchant_id,amountFen:Number(row.amount_fen),currency:'CNY',interval:account.cycle==='annual'?'year':'month',mandateId:row.mandate_id});
    assert.equal(proof.state,account===monthly?'cancelled':'active');assert.equal(proof.interval,account.cycle==='annual'?'year':'month');
  }
  record('a newly instantiated provider preserves cancelled monthly and active yearly mandates');
  current=await state(annual);equalPoints(current,21000);assert.equal(current.subscription_test.charges.paid_orders,1);assert.equal(current.subscription_test.charges.simulated_paid_fen,'214920');
  const annualEnd=current.account.subscription.current_period_end,annualRequest=randomUUID();
  await annual.send('POST','/api/v1/subscriptions/'+annual.subscriptionId+'/auto-renew',{request_id:randomUUID(),enabled:false});
  current=await advance(annual,annualRequest);equalPoints(current,42000);assert.equal(current.subscription_test.charges.paid_orders,1);assert.equal(current.subscription_test.charges.recurring_paid_orders,0);
  assert.equal(current.account.subscription.current_period_end,annualEnd);assert.equal((await evidence(annual)).releases,2);
  record('annual payment charges 2149.20 once, then releases next monthly 21000 even after renewal cancellation');
  const annualAfter=await evidence(annual);await advance(annual,annualRequest);assert.deepEqual(await evidence(annual),annualAfter);record('annual monthly release replay cannot duplicate credits');
  const pending=await createAccount('monthly'),pendingRequest=randomUUID();
  await pending.send('POST','/__billing-test/api/subscription/outcome',{outcome:'pending'});current=await advance(pending,pendingRequest);
  equalPoints(current,21000);assert.equal(current.subscription_test.charges.recurring_pending_orders,1);assert.equal(current.subscription_test.charges.recurring_paid_orders,0);
  const pendingAfter=await evidence(pending);current=await advance(pending,pendingRequest);assert.deepEqual(await evidence(pending),pendingAfter);equalPoints(current,21000);
  const unknown=(await pool.query(`SELECT c.*,o.expires_at FROM bb_local_billing_charges c JOIN bb_recharge_orders o ON o.id=c.order_id
    WHERE c.owner_user_id=$1 AND c.automatic`,[pending.owner])).rows[0];
  const queried=await localProvider.query({id:unknown.order_id,merchant_id:unknown.merchant_id,amount_fen:Number(unknown.amount_fen),currency:'CNY',expires_at:unknown.expires_at.toISOString()});
  assert.equal(queried.state,'pending');record('unknown renewal stays one pending order across retry and provider reconstruction, with no credits granted');
  const failed=await createAccount('monthly');await failed.send('POST','/__billing-test/api/subscription/outcome',{outcome:'failed'});
  current=await advance(failed);equalPoints(current,21000);assert.equal(current.subscription_test.charges.recurring_failed_orders,1);assert.equal(current.subscription_test.charges.recurring_paid_orders,0);
  assert.equal(current.account.subscription.auto_renew,false);record('failed renewal grants no credits and stops automatic renewal');
  const allOwners=accounts.map(a=>a.owner);assert.equal(new Set(allOwners).size,4);
  const clocks=(await pool.query('SELECT owner_user_id FROM bb_local_billing_clock WHERE owner_user_id=ANY($1::text[])',[allOwners])).rows;
  assert.equal(clocks.length,4);record('all synthetic clocks and evidence are scoped to four newly registered random accounts');
  const proof={synthetic:true,realHttp:true,realPostgres:true,modelCallsPerformed:0,realPaymentCallsPerformed:0,
    startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,launchId:status.launch_id,
    accounts:accounts.map(({username,owner,cycle,subscriptionId,firstOrderId})=>({username,owner,cycle,subscriptionId,firstOrderId})),
    clockScope:'subscription only; wallet expiry and sessions use real time',checks,passed:checks.length,failed:0};
  writeFileSync(join(runtime,'subscription-renewal-verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}catch(error){writeFileSync(join(runtime,'subscription-renewal-verification.json'),JSON.stringify({synthetic:true,startedAt,finishedAt:new Date().toISOString(),checks,failed:1,error:String(error),accounts:accounts.map(({username,owner,cycle})=>({username,owner,cycle}))},null,2)+'\n');throw error;}
finally{await pool.end();}
