import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {chromium,expect as playwrightExpect} from '@playwright/test';
import {baseURL,apiURL,terms,runtime,config,pgBase} from './config.mjs';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';

// Real Edge, HTTP and PostgreSQL. Fault injection only discards a completed
// server response; it never replaces responses, edits a wallet or pays a vendor.
const expect=playwrightExpect.configure({timeout:15000});
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database,connectionTimeoutMillis:10000});
const startedAt=new Date().toISOString(),runId='edge_'+randomUUID(),out=join(runtime,'cashier-edge-browser',runId);
const selectedCase=process.argv.find(value=>value.startsWith('--case='))?.slice(7).padStart(2,'0');
if(selectedCase)assert.match(selectedCase,/^(?:0[1-9]|1[0-2])$/,'--case must select 1 through 12');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const cases=[],accounts=[],screenshots=[];
const password='Synthetic-Edge-2026!';
const apiPath=action=>'/__billing-test/api/'+action;
const checkout=id=>baseURL+'/__billing-test/checkout?'+new URLSearchParams({order:id});
const intentKey=(username,id)=>'bb-local-cashier-refund-v1:'+JSON.stringify([username,id]);

async function post(context,path,data={},status=200,extraHeaders={}){
  const csrf=(await context.cookies(baseURL)).find(cookie=>cookie.name==='bb_csrf')?.value??'';
  const response=await context.request.post(baseURL+path,{headers:{origin:baseURL,'x-bb-csrf':csrf,...extraHeaders},data});
  const body=await response.json();assert.equal(response.status(),status,JSON.stringify({path,status:response.status(),body}));return body;
}
const state=context=>post(context,apiPath('state'));
async function register(context,prefix='billing_edge_'){
  const username=prefix+randomUUID().slice(0,8),registered=await post(context,'/api/v1/auth/register',{username,password,accepted_terms_version:terms},201);
  const account={username,owner:registered.user_id};accounts.push(account);return account;
}
async function topup(context,paid=true){
  const order=await post(context,'/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'5000',provider:'wechat'},201);
  if(paid)await post(context,apiPath('payment/outcome'),{id:order.order_id,outcome:'paid',delivery:'callback'});
  return order.order_id;
}
async function monthlySubscription(context){
  const checkout=await post(context,'/api/v1/subscriptions',{request_id:randomUUID(),plan_id:'light',provider:'wechat',billing_cycle:'monthly'},201);
  await post(context,apiPath('payment/outcome'),{id:checkout.order.order_id,outcome:'paid',delivery:'callback'});
  await post(context,'/api/v1/subscriptions/'+checkout.subscription.id+'/auto-renew',{request_id:randomUUID(),enabled:true});
  const authorized=await post(context,'/api/v1/subscriptions/'+checkout.subscription.id+'/auto-renew/refresh');
  assert.equal(authorized.subscription.auto_renew,true);assert.equal(authorized.subscription.mandate_status,'active');await amounts(context,21000);
  return {subscriptionId:checkout.subscription.id,orderId:checkout.order.order_id};
}
async function subscriptionProof(owner){
  return(await pool.query(`SELECT
    (SELECT count(*)::int FROM bb_recharge_orders WHERE owner_user_id=$1) orders,
    (SELECT count(*)::int FROM bb_local_billing_charges WHERE owner_user_id=$1) charges,
    (SELECT count(*)::int FROM bb_local_billing_charges WHERE owner_user_id=$1 AND automatic AND state='paid') recurring_paid,
    (SELECT count(*)::int FROM bb_local_billing_advances WHERE owner_user_id=$1) advances,
    (SELECT count(*)::int FROM bb_credit_lots WHERE owner_user_id=$1) lots,
    (SELECT COALESCE(sum(remaining),0)::text FROM bb_credit_lots WHERE owner_user_id=$1) remaining,
    (SELECT COALESCE(sum(frozen),0)::text FROM bb_credit_lots WHERE owner_user_id=$1) frozen,
    (SELECT now_at FROM bb_local_billing_clock WHERE owner_user_id=$1) clock`,[owner])).rows[0];
}
async function amounts(context,available,held=0){
  const current=await state(context);assert.equal(current.account.available_points,String(available));
  assert.equal(current.account.refund_held_points,String(held));assert.equal(current.account.task_held_points,'0');return current;
}
async function paymentProof(owner,id){
  return(await pool.query(`SELECT
    (SELECT count(*)::int FROM bb_recharge_orders WHERE owner_user_id=$1 AND id=$2) orders,
    (SELECT count(*)::int FROM bb_local_billing_charges WHERE owner_user_id=$1 AND order_id=$2) charges,
    (SELECT count(*)::int FROM bb_payment_cash_proofs WHERE owner_user_id=$1 AND order_id=$2) cash_proofs,
    (SELECT count(*)::int FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key='recharge:'||$2) lots,
    (SELECT count(*)::int FROM bb_credit_events WHERE owner_user_id=$1 AND kind='grant') grants`,[owner,id])).rows[0];
}
async function refundProof(owner,id){
  return(await pool.query(`SELECT
    (SELECT count(*)::int FROM bb_payment_refunds WHERE owner_user_id=$1 AND order_id=$2) refunds,
    (SELECT count(*)::int FROM bb_payment_refund_events e JOIN bb_payment_refunds r ON r.id=e.refund_id WHERE r.owner_user_id=$1 AND r.order_id=$2 AND e.kind='requested') requests,
    (SELECT count(*)::int FROM bb_payment_refund_events e JOIN bb_payment_refunds r ON r.id=e.refund_id WHERE r.owner_user_id=$1 AND r.order_id=$2 AND e.kind='succeeded') settlements,
    (SELECT COALESCE(sum(a.points),0)::text FROM bb_payment_refund_allocations a JOIN bb_payment_refunds r ON r.id=a.refund_id WHERE r.owner_user_id=$1 AND r.order_id=$2) allocated,
    (SELECT COALESCE(sum(remaining),0)::text FROM bb_credit_lots WHERE owner_user_id=$1) remaining,
    (SELECT COALESCE(sum(frozen),0)::text FROM bb_credit_lots WHERE owner_user_id=$1) frozen`,[owner,id])).rows[0];
}
async function shot(page,record,name){
  const file=record.name+'-'+name+'.png';await page.screenshot({path:join(out,file),fullPage:true});
  screenshots.push(file);record.screenshots.push(file);
}
async function open(page,id){await page.goto(checkout(id));await expect(page.locator('#checkout-title')).toHaveText('积分已到账');}
async function localIntent(page,username,id){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)??'null'),intentKey(username,id));}
function responseFor(page,path){return page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===apiPath(path));}
function watchRequestOutcome(page,matches){
  let resolve,settled=false;const completed=new Promise(done=>{resolve=done;});
  const finish=value=>{if(settled)return;settled=true;resolve(value);};
  const failed=request=>{if(matches(request))finish({kind:'requestfailed',error:request.failure()?.errorText});};
  const received=response=>{if(matches(response.request()))finish({kind:'response',status:response.status()});};
  page.on('requestfailed',failed);page.on('response',received);
  return {completed,dispose(){page.off('requestfailed',failed);page.off('response',received);}};
}
async function discardNextCompletedResponse(page,path,record){
  let resolve;const completed=new Promise(done=>{resolve=done;});
  await page.route('**'+apiPath(path),async route=>{
    const response=await route.fetch(),body=await response.json();
    const evidence={kind:'client response-loss fault injection',path:apiPath(path),request:route.request().postDataJSON(),serverStatus:response.status(),serverBody:body};
    record.faults.push(evidence);await route.abort('failed');resolve(evidence);
  },{times:1});
  return {completed};
}
async function runCase(name,operation){
  if(selectedCase&&!name.startsWith(selectedCase+'-'))return;
  const record={name,browserMode:'headless',passed:false,startedAt:new Date().toISOString(),screenshots:[],faults:[],requests:[],responses:[],pageErrors:[],externalRequests:[],requestFailures:[]};cases.push(record);
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  context.on('page',page=>{
    page.on('pageerror',error=>record.pageErrors.push({url:page.url(),message:error.message}));
    page.on('requestfailed',request=>record.requestFailures.push({url:request.url(),error:request.failure()?.errorText}));
  });
  context.on('request',request=>{
    const url=new URL(request.url());
    if(['http:','https:'].includes(url.protocol)&&!['localhost','127.0.0.1'].includes(url.hostname))record.externalRequests.push(request.url());
    if(request.method()==='POST'&&url.pathname===apiPath('refund/request'))record.requests.push({path:url.pathname,body:request.postDataJSON()});
  });
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    return ['http:','https:'].includes(url.protocol)&&!['localhost','127.0.0.1'].includes(url.hostname)?route.abort('blockedbyclient'):route.continue();
  });
  const page=await context.newPage();
  try{
    const account=await register(context);record.account=account;await amounts(context,0);
    await operation({context,page,account,record});
    assert.deepEqual(record.pageErrors,[]);assert.deepEqual(record.externalRequests,[]);
    assert.equal((await auditCredits(pool,account.owner)).consistent,true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[account.owner])).rows[0].n,0);
    record.passed=true;
  }catch(error){
    record.error=String(error);record.stack=error.stack;
    for(const [index,current] of context.pages().entries())await shot(current,record,'failure-'+index).catch(()=>{});
    console.error(JSON.stringify({name,error:record.error,evidence:out}));
  }finally{
    record.finishedAt=new Date().toISOString();await writeFile(join(out,name+'.json'),JSON.stringify(record,null,2)+'\n');await context.close();
  }
}

let preflightFailure;
try{
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  const status=await(await fetch(apiURL+'/__billing-test/status')).json();assert.equal(status.ready,true);assert.equal(status.synthetic,true);

  await runCase('01-payment-response-loss',async({context,page,account,record})=>{
    const id=await topup(context,false);record.order=id;await page.goto(checkout(id));
    await expect(page.locator('#checkout-title')).toHaveText('等待模拟支付');await page.locator('#delivery').selectOption('callback');
    const loss=await discardNextCompletedResponse(page,'payment/outcome',record);await page.locator('#simulate-paid').click();
    assert.equal((await loss.completed).serverStatus,200);await expect(page.locator('#error')).toBeVisible();await amounts(context,5000);
    await shot(page,record,'unknown-response');await page.reload();await expect(page.locator('#checkout-title')).toHaveText('积分已到账');
    for(let i=0;i<2;i++){const done=responseFor(page,'payment/refresh');await page.locator('#refresh-payment').click();assert.equal((await done).status(),200);await expect(page.locator('#refresh-payment')).toBeEnabled();}
    await amounts(context,5000);record.ledger=await paymentProof(account.owner,id);
    assert.deepEqual(record.ledger,{orders:1,charges:1,cash_proofs:1,lots:1,grants:1});await shot(page,record,'recovered-once');
  });

  await runCase('02-refund-request-response-loss-retry',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;await open(page,id);await page.locator('#refund-amount').fill('10');
    const loss=await discardNextCompletedResponse(page,'refund/request',record);await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();
    assert.equal((await loss.completed).serverStatus,200);await expect(page.locator('#error')).toBeVisible();await amounts(context,4000,1000);
    const intent=await localIntent(page,account.username,id);assert.deepEqual(intent,record.faults[0].request);record.originalIntent=intent;
    await expect(page.locator('#refund-amount')).toHaveAttribute('readonly','');await shot(page,record,'unknown-response-retains-request');
    const retry=responseFor(page,'refund/request');await page.getByRole('button',{name:'重试同一退款申请',exact:true}).click();assert.equal((await retry).status(),200);
    await expect(page.locator('.refund')).toHaveCount(1);await amounts(context,4000,1000);assert.equal(await localIntent(page,account.username,id),null);
    assert.equal(record.requests.length,2);assert.deepEqual(record.requests[0].body,record.requests[1].body);
    record.ledger=await refundProof(account.owner,id);assert.deepEqual(record.ledger,{refunds:1,requests:1,settlements:0,allocated:'1000',remaining:'5000',frozen:'1000'});
  });

  await runCase('03-refund-request-response-loss-reload',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;await open(page,id);await page.locator('#refund-amount').fill('10');
    const loss=await discardNextCompletedResponse(page,'refund/request',record);await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();
    assert.equal((await loss.completed).serverStatus,200);await expect(page.locator('#error')).toBeVisible();
    record.originalIntent=await localIntent(page,account.username,id);assert.ok(record.originalIntent?.request_id);
    await page.reload();await expect(page.locator('.refund')).toHaveCount(1);await expect(page.locator('.refund h3')).toContainText('退款处理中');
    assert.equal(await localIntent(page,account.username,id),null);assert.equal(record.requests.length,1);await amounts(context,4000,1000);
    record.ledger=await refundProof(account.owner,id);assert.deepEqual(record.ledger,{refunds:1,requests:1,settlements:0,allocated:'1000',remaining:'5000',frozen:'1000'});
    const accepted=(await state(context)).refunds;assert.equal(accepted[0].request_id,record.originalIntent.request_id);await shot(page,record,'recovered-original-request');
  });

  await runCase('04-refund-settlement-response-loss',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;await open(page,id);await page.locator('#refund-amount').fill('10');
    await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();await expect(page.locator('.refund')).toHaveCount(1);
    await page.locator('#delivery').selectOption('callback');const loss=await discardNextCompletedResponse(page,'refund/outcome',record);
    await page.locator('[data-refund-action=succeeded]').click();assert.equal((await loss.completed).serverStatus,200);await expect(page.locator('#error')).toBeVisible();
    await amounts(context,4000);await page.reload();await expect(page.locator('.refund h3')).toContainText('模拟原路退款成功');
    for(let i=0;i<2;i++){const done=responseFor(page,'refund/refresh');await page.locator('[data-refund-action=refresh]').click();assert.equal((await done).status(),200);await expect(page.locator('[data-refund-action=refresh]')).toBeEnabled();}
    await amounts(context,4000);record.ledger=await refundProof(account.owner,id);
    assert.deepEqual(record.ledger,{refunds:1,requests:1,settlements:1,allocated:'1000',remaining:'4000',frozen:'0'});await shot(page,record,'settled-original-refund-once');
  });

  await runCase('05-two-tab-refund-race',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;const other=await context.newPage();await Promise.all([open(page,id),open(other,id)]);
    await Promise.all([page.locator('#refund-amount').fill('10'),other.locator('#refund-amount').fill('10')]);
    let release,serverReady;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{serverReady=resolve;});
    await page.route('**'+apiPath('refund/request'),async route=>{
      const response=await route.fetch(),body=await response.json();record.faults.push({kind:'client response-delay fault injection',path:apiPath('refund/request'),serverStatus:response.status(),serverBody:body});
      serverReady();await gate;await route.fulfill({response});
    },{times:1});
    try{
      const first=responseFor(page,'refund/request');await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();await ready;
      const second=responseFor(other,'refund/request');await other.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();
      const secondResponse=await second;record.responses.push({status:secondResponse.status(),body:await secondResponse.json()});
      await expect(other.locator('.refund')).toHaveCount(1);await expect(other.locator('#reload-state')).toBeEnabled();
      release();const firstResponse=await first;record.responses.push({status:firstResponse.status(),body:await firstResponse.json()});
      await expect(page.locator('.refund')).toHaveCount(1);await expect(page.locator('#reload-state')).toBeEnabled();
      await expect(page.locator('#error')).toBeHidden();await expect(other.locator('#error')).toBeHidden();
      assert.deepEqual(record.responses.map(response=>response.status),[200,200]);
      assert.equal(record.requests.length,2);assert.deepEqual(record.requests[0].body,record.requests[1].body);
    }finally{release();}
    await amounts(context,4000,1000);record.ledger=await refundProof(account.owner,id);
    assert.deepEqual(record.ledger,{refunds:1,requests:1,settlements:0,allocated:'1000',remaining:'5000',frozen:'1000'});
    for(const current of [page,other]){await current.reload();await expect(current.locator('.refund')).toHaveCount(1);}
    await amounts(context,4000,1000);await shot(page,record,'first-tab');await shot(other,record,'second-tab');
    record.concurrencyLimit='Two overlapping real browser submissions share the original unknown refund UUID; local control actions use the existing serial harness. Different-UUID product transaction concurrency is verified separately.';
  });

  await runCase('06-account-switch-isolation',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;await open(page,id);const before=await refundProof(account.owner,id);
    const foreignContext=await browser.newContext(),foreign=await register(foreignContext,'billing_edge_b_');record.foreign=foreign;await foreignContext.close();
    const product=await context.newPage();await product.goto(baseURL+'/#/account');await expect(product.locator('#logout')).toBeVisible();
    // Keyboard activation lets this independent isolation case continue even
    // if the separately asserted pointer-reachability case finds an overlay.
    await product.locator('#logout').focus();await product.keyboard.press('Enter');await expect(product.locator('#login-form')).toBeVisible();
    await expect.poll(async()=>(await page.locator('#checkout').innerText()).includes(id),{timeout:3000}).toBe(false).catch(error=>{record.logoutRedactionError=String(error);});
    record.cashierAfterLogout={identity:await page.locator('#identity').innerText(),checkout:await page.locator('#checkout').innerText(),refunds:await page.locator('#refunds').innerText()};
    await shot(page,record,'after-product-logout');
    await product.locator('#username').fill(foreign.username);await product.locator('#password').fill(password);
    await product.getByRole('button',{name:'登录',exact:true}).click();await expect(product.locator('#logout')).toBeVisible();
    assert.equal((await state(context)).username,foreign.username);await page.bringToFront();
    await expect.poll(async()=>(await page.locator('#checkout').innerText()).includes(id)||(await page.locator('#identity').innerText()).includes(account.username),{timeout:3000}).toBe(false).catch(error=>{record.loginRedactionError=String(error);});
    record.cashierBeforeReload={identity:await page.locator('#identity').innerText(),checkout:await page.locator('#checkout').innerText(),refunds:await page.locator('#refunds').innerText()};
    await shot(page,record,'after-other-account-login');
    // Test the real server guard even if the stale browser view is defective.
    const guard=await post(context,apiPath('payment/refresh'),{id},404);record.serverGuard=guard;
    assert.deepEqual(await refundProof(account.owner,id),before);await amounts(context,0);
    const stale=record.cashierBeforeReload.checkout.includes(id)||record.cashierBeforeReload.identity.includes(account.username);
    if(await page.locator('#refresh-payment').count()){
      const response=responseFor(page,'payment/refresh');await page.locator('#refresh-payment').click();assert.equal((await response).status(),404);
      await expect(page.locator('#error')).toBeVisible();record.cashierAfterDeniedAction=await page.locator('#checkout').innerText();await shot(page,record,'after-denied-old-order-action');
    }
    await page.locator('#reload-state').click();await expect(page.locator('#identity')).toContainText(foreign.username);await expect(page.locator('#checkout-title')).toHaveText('订单不可用');
    assert.deepEqual(await refundProof(account.owner,id),before);
    assert.equal(record.cashierAfterLogout.checkout.includes(id),false,'Cashier must clear the prior account order after real product logout in another tab');
    assert.equal(stale,false,'Cashier must not display the previous account identity/order after another account logs in');
    if(record.cashierAfterDeniedAction)assert.equal(record.cashierAfterDeniedAction.includes(id),false,'Denied financial action must clear the previous account order');
  });

  await runCase('07-invalid-refund-input-no-request',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;await open(page,id);record.invalidAmounts=[];
    for(const value of ['50.01','0','1.001','1e1','-1']){
      await page.locator('#refund-amount').fill(value);await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();
      await expect(page.locator('#error')).toContainText('请输入不超过当前可退金额、最多两位小数的退款金额');
      assert.equal(record.requests.length,0);assert.equal(await localIntent(page,account.username,id),null);record.invalidAmounts.push(value);
    }
    await amounts(context,5000);record.ledger=await refundProof(account.owner,id);
    assert.deepEqual(record.ledger,{refunds:0,requests:0,settlements:0,allocated:'0',remaining:'5000',frozen:'0'});await shot(page,record,'invalid-inputs-blocked');
  });

  await runCase('08-product-logout-pointer-reachable',async({page,record})=>{
    await page.goto(baseURL+'/#/account');await expect(page.locator('#logout')).toBeVisible();await shot(page,record,'before-click');
    await page.locator('#logout').click({timeout:5000});await expect(page.locator('#login-form')).toBeVisible();await shot(page,record,'signed-out');
  });

  await runCase('09-same-account-focus-preserves-input',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;await open(page,id);await page.bringToFront();
    await page.locator('#refund-amount').fill('12.34');await page.locator('#delivery').selectOption('callback');
    await page.evaluate(()=>{
      window.__billingFocusAudit={focus:0,visible:0};
      window.addEventListener('focus',()=>window.__billingFocusAudit.focus++);
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')window.__billingFocusAudit.visible++;});
    });
    record.focusEvent={synthetic:true,kind:'browser focus event injection',reason:'Headless Edge bringToFront does not emit native tab focus here; cross-tab account changes use real product BroadcastChannel in other cases.'};
    const refreshed=responseFor(page,'state');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal((await refreshed).status(),200);
    await expect(page.locator('#identity')).toContainText(account.username);await expect(page.locator('#refund-amount')).toHaveValue('12.34');
    await expect(page.locator('#delivery')).toHaveValue('callback');await expect(page.locator('#refund-form button')).toBeEnabled();
    record.events=await page.evaluate(()=>window.__billingFocusAudit);assert.equal(record.events.focus,1,'The labelled injected focus event must trigger a real HTTP recheck');
    assert.equal(record.requests.length,0);await amounts(context,5000);record.ledger=await refundProof(account.owner,id);
    assert.deepEqual(record.ledger,{refunds:0,requests:0,settlements:0,allocated:'0',remaining:'5000',frozen:'0'});await shot(page,record,'typed-amount-preserved');
  });

  await runCase('10-old-state-response-after-account-switch',async({context,page,account,record})=>{
    const id=await topup(context);record.order=id;await open(page,id);const before=await refundProof(account.owner,id);
    const foreignContext=await browser.newContext(),foreign=await register(foreignContext,'billing_edge_b_');record.foreign=foreign;await foreignContext.close();
    const product=await context.newPage();await product.goto(baseURL+'/#/account');await expect(product.locator('#logout')).toBeVisible();
    let release,serverReady,originalRequest;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{serverReady=resolve;});
    const original=watchRequestOutcome(page,request=>request===originalRequest);
    await page.route('**'+apiPath('state'),async route=>{
      originalRequest=route.request();
      const response=await route.fetch(),body=await response.json();
      record.faults.push({kind:'client response-delay fault injection',path:apiPath('state'),serverStatus:response.status(),serverBody:body});
      serverReady();await gate;
      try{await route.fulfill({response});}catch(error){record.deliveryError=String(error);const outcome=await original.completed;if(outcome.kind!=='requestfailed')throw error;}
    },{times:1});
    try{
      await page.locator('#reload-state').click();await ready;
      assert.equal(record.faults[0].serverStatus,200);assert.equal(record.faults[0].serverBody.username,account.username);
      await product.locator('#logout').click();await expect(product.locator('#login-form')).toBeVisible();
      await product.locator('#username').fill(foreign.username);await product.locator('#password').fill(password);
      await product.getByRole('button',{name:'登录',exact:true}).click();await expect(product.locator('#logout')).toBeVisible();
      await expect(page.locator('#checkout')).not.toContainText(id);await expect(page.locator('#identity')).not.toContainText(account.username);
      await shot(page,record,'old-response-held-after-switch');
      await page.evaluate(({username,id})=>{
        window.__billingOldViewLeaks=[];
        new MutationObserver(()=>{
          const text=['#identity','#checkout','#refunds'].map(selector=>document.querySelector(selector)?.textContent??'').join('\n');
          if(text.includes(username)||text.includes(id))window.__billingOldViewLeaks.push(text);
        }).observe(document.querySelector('main'),{subtree:true,childList:true,characterData:true});
      },{username:account.username,id});
      release();record.originalClientOutcome=await original.completed;
      if(record.originalClientOutcome.kind==='response')assert.equal(record.originalClientOutcome.status,200);else assert.match(record.originalClientOutcome.error,/ABORTED/i);
      await expect(page.locator('#identity')).toContainText(foreign.username);await expect(page.locator('#checkout-title')).toHaveText('订单不可用');
      await expect(page.locator('#reload-state')).toBeEnabled();record.oldViewLeaks=await page.evaluate(()=>window.__billingOldViewLeaks);
      assert.deepEqual(record.oldViewLeaks,[],'A late real response must never repaint the prior account, even transiently');
      assert.deepEqual(await refundProof(account.owner,id),before);await amounts(context,0);assert.equal(record.requests.length,0);
      await shot(page,record,'late-response-ignored');
    }finally{release();original.dispose();}
  });

  await runCase('11-late-unauthorized-advance-does-not-replay-as-new-account',async({context,page,account,record})=>{
    record.subscriptionA=await monthlySubscription(context);
    const foreignContext=await browser.newContext(),foreign=await register(foreignContext,'billing_edge_b_');record.foreign=foreign;
    record.subscriptionB=await monthlySubscription(foreignContext);await foreignContext.close();
    record.beforeA=await subscriptionProof(account.owner);record.beforeB=await subscriptionProof(foreign.owner);
    const product=await context.newPage();await product.goto(baseURL+'/#/account');await expect(product.locator('#logout')).toBeVisible();
    await page.goto(baseURL+'/__billing-test');await expect(page.locator('#identity')).toContainText(account.username);await expect(page.locator('#advance-subscription')).toBeEnabled();
    record.sessionRaceRequests=[];
    context.on('request',request=>{
      const path=new URL(request.url()).pathname;
      if(request.method()==='POST'&&[apiPath('subscription/advance'),'/api/v1/auth/refresh'].includes(path))record.sessionRaceRequests.push({path,body:request.postData()?JSON.parse(request.postData()):null});
    });
    let permitDispatch,permitDelivery,requestIntercepted,serverReady,originalRequest;
    const dispatch=new Promise(resolve=>{permitDispatch=resolve;}),delivery=new Promise(resolve=>{permitDelivery=resolve;});
    const intercepted=new Promise(resolve=>{requestIntercepted=resolve;}),ready=new Promise(resolve=>{serverReady=resolve;});
    const original=watchRequestOutcome(page,request=>request===originalRequest);
    await page.route('**'+apiPath('subscription/advance'),async route=>{
      originalRequest=route.request();
      const originalHeaders=await route.request().allHeaders();record.originalAdvance=route.request().postDataJSON();requestIntercepted();await dispatch;
      // Forward the captured original A request unchanged, after its real logout.
      // Cookies stay in memory only. This must yield a genuine product 401.
      const response=await route.fetch({headers:originalHeaders}),body=await response.json();
      record.faults.push({kind:'client request and response-delay fault injection',path:apiPath('subscription/advance'),request:record.originalAdvance,serverStatus:response.status(),serverBody:body});
      serverReady();await delivery;
      try{await route.fulfill({response});}
      catch(error){
        // A session-bound AbortSignal may already have cancelled this browser
        // request. The captured server response remains genuine evidence.
        record.deliveryError=String(error);const outcome=await original.completed;if(outcome.kind!=='requestfailed')throw error;
      }
    },{times:1});
    try{
      await page.locator('#advance-subscription').click();await intercepted;
      await product.locator('#logout').click();await expect(product.locator('#login-form')).toBeVisible();
      await product.locator('#username').fill(foreign.username);await product.locator('#password').fill(password);
      await product.getByRole('button',{name:'登录',exact:true}).click();await expect(product.locator('#logout')).toBeVisible();
      await expect(page.locator('#identity')).not.toContainText(account.username);await expect(page.locator('#payments')).not.toContainText(record.subscriptionA.orderId);
      assert.equal((await state(context)).username,foreign.username);permitDispatch();await ready;
      assert.equal(record.faults[0].serverStatus,401,'The delayed original A action must be rejected by the real server');
      record.refreshCountBeforeDelivery=record.sessionRaceRequests.filter(request=>request.path==='/api/v1/auth/refresh').length;
      await shot(page,record,'genuine-old-401-held-after-b-login');permitDelivery();
      const outcome=await original.completed;record.originalClientOutcome=outcome;
      if(outcome.kind==='response')assert.equal(outcome.status,401);else assert.match(outcome.error,/ABORTED/i,'Only an explicitly aborted original browser request may replace delivery');
      await expect(page.locator('#identity')).toContainText(foreign.username);await expect(page.locator('#advance-subscription')).toBeEnabled();
      record.afterA=await subscriptionProof(account.owner);record.afterB=await subscriptionProof(foreign.owner);
      record.refreshCountAfterDelivery=record.sessionRaceRequests.filter(request=>request.path==='/api/v1/auth/refresh').length;
      record.advanceCount=record.sessionRaceRequests.filter(request=>request.path===apiPath('subscription/advance')).length;
      record.currentState=await state(context);await shot(page,record,'old-401-fully-processed');
      assert.equal(record.advanceCount,1,'A delayed 401 must not replay the original advance under B cookies');
      assert.equal(record.refreshCountAfterDelivery,record.refreshCountBeforeDelivery,'A delayed A 401 must not refresh B session');
      assert.deepEqual(record.afterA,record.beforeA);assert.deepEqual(record.afterB,record.beforeB,'B must have no new order, channel charge, clock advance or credit grant');
      assert.equal(record.currentState.account.available_points,'21000');assert.equal(record.currentState.subscription_test.charges.recurring_paid_orders,0);
    }finally{permitDispatch();permitDelivery();original.dispose();}
  });

  await runCase('12-server-owner-binding-rejects-cross-account-advance',async({context,page,account,record})=>{
    record.testBoundary='Server-only identity binding: manually replay a captured A owner header and UUID with real B cookies/CSRF, bypassing browser AbortSignal protection.';
    const initial=await state(context);assert.equal(initial.owner_user_id,account.owner);record.verifiedOwnerA=initial.owner_user_id;
    record.subscriptionA=await monthlySubscription(context);
    const foreignContext=await browser.newContext(),foreign=await register(foreignContext,'billing_edge_b_');record.foreign=foreign;
    record.subscriptionB=await monthlySubscription(foreignContext);await foreignContext.close();
    record.beforeA=await subscriptionProof(account.owner);record.beforeB=await subscriptionProof(foreign.owner);
    const product=await context.newPage();await product.goto(baseURL+'/#/account');await expect(product.locator('#logout')).toBeVisible();
    await page.goto(baseURL+'/__billing-test');await expect(page.locator('#identity')).toContainText(account.username);await expect(page.locator('#advance-subscription')).toBeEnabled();
    let captured;const capturedRequest=new Promise(resolve=>{captured=resolve;});
    await page.route('**'+apiPath('subscription/advance'),async route=>{
      record.originalAdvance={owner:await route.request().headerValue('x-bb-test-owner'),body:route.request().postDataJSON()};
      record.faults.push({kind:'client request-capture fault injection',path:apiPath('subscription/advance'),forwarded:false,reason:'Capture the real A owner binding/UUID without advancing A; the manual B-cookie replay below tests only the server guard.'});
      await route.abort('failed');captured();
    },{times:1});
    await page.locator('#advance-subscription').click();await capturedRequest;await expect(page.locator('#error')).toBeVisible();
    assert.equal(record.originalAdvance.owner,account.owner,'The real browser action must carry the owner verified from A state');assert.match(record.originalAdvance.body.id,/^[a-f0-9-]{36}$/);
    assert.deepEqual(await subscriptionProof(account.owner),record.beforeA);
    await product.locator('#logout').click();await expect(product.locator('#login-form')).toBeVisible();
    await product.locator('#username').fill(foreign.username);await product.locator('#password').fill(password);
    await product.getByRole('button',{name:'登录',exact:true}).click();await expect(product.locator('#logout')).toBeVisible();
    const current=await state(context);assert.equal(current.username,foreign.username);assert.equal(current.owner_user_id,foreign.owner);record.verifiedOwnerB=current.owner_user_id;
    const sameSession=await post(context,apiPath('state'),{},200,{'x-bb-test-owner':foreign.owner});
    assert.equal(sameSession.owner_user_id,foreign.owner);record.validBSessionControl={owner:sameSession.owner_user_id,status:200};
    record.manualReplay={path:apiPath('subscription/advance'),ownerHeader:record.originalAdvance.owner,body:record.originalAdvance.body,authenticatedOwner:foreign.owner};
    record.serverRejection=await post(context,apiPath('subscription/advance'),record.originalAdvance.body,403,{'x-bb-test-owner':record.originalAdvance.owner});
    assert.equal(record.serverRejection.code,'CSRF_DENIED');
    assert.equal(record.serverRejection.message,'账号会话已变化，原测试操作不能在新账号下执行。','Valid B CSRF must reach the specific owner-binding guard');
    record.afterA=await subscriptionProof(account.owner);record.afterB=await subscriptionProof(foreign.owner);
    assert.deepEqual(record.afterA,record.beforeA);assert.deepEqual(record.afterB,record.beforeB,'An old owner binding must not create B orders, charges, clock advances or credits');
    const after=await amounts(context,21000);assert.equal(after.subscription_test.charges.recurring_paid_orders,0);
    await expect(page.locator('#identity')).toContainText(foreign.username);await shot(page,record,'cross-account-server-rejection');
  });
}catch(error){preflightFailure={error:String(error),stack:error.stack};}
finally{
  const accountAudits=[];
  for(const account of accounts){
    try{
      const audit=await auditCredits(pool,account.owner),modelCalls=(await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[account.owner])).rows[0].n;
      accountAudits.push({...account,consistent:audit.consistent,modelCalls});assert.equal(audit.consistent,true);assert.equal(modelCalls,0);
    }catch(error){preflightFailure??={error:String(error),stack:error.stack};}
  }
  const result={synthetic:true,realBrowser:'Microsoft Edge',realHttp:true,realPostgres:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,
    faultInjection:'Completed real HTTP responses are discarded or delayed at the client; no response or ledger is fabricated.',
    startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,runId,selectedCase: selectedCase??'all',accounts,accountAudits,passed:cases.filter(item=>item.passed).length,
    failed:cases.filter(item=>!item.passed).length+(preflightFailure?1:0),skipped:12-cases.length,cases,screenshots,...(preflightFailure?{preflightFailure}:{})};
  await writeFile(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({evidence:out,passed:result.passed,failed:result.failed,skipped:result.skipped,cases:cases.map(({name,passed,error})=>({name,passed,error}))}));
  await browser.close();await pool.end();if(result.failed)process.exitCode=1;
}
