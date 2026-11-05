import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {chromium,expect as playwrightExpect} from '@playwright/test';
import {baseURL,config,pgBase,runtime,terms} from './config.mjs';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';

// Real Edge tabs, authenticated HTTP, a synthetic channel and PostgreSQL. Only
// dispatch/delivery timing and dropped responses are injected at the browser;
// no response body, channel receipt, clock or account balance is fabricated.
const expect=playwrightExpect.configure({timeout:15000}),saved=config(),pool=new Pool({connectionString:pgBase+saved.database});
const nonce=randomUUID().slice(0,8),out=join(runtime,'subscription-two-tab-'+nonce),startedAt=new Date().toISOString();await mkdir(out,{recursive:true});
const selected=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);if(selected)assert.match(selected,/^[1-4]$/);
const browser=await chromium.launch({channel:'msedge',headless:true}),contexts=[],accounts=[],cases=[];
const path='/__billing-test/api/subscription/advance',key=user=>'bb-local-billing-action-v1:'+JSON.stringify([user,'subscription-advance']);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function post(context,url,body={},status=200){const csrf=(await context.cookies(baseURL)).find(c=>c.name==='bb_csrf')?.value??'';
  const response=await context.request.post(baseURL+url,{headers:{origin:baseURL,'x-bb-csrf':csrf},data:body});const data=await response.json();assert.equal(response.status(),status,JSON.stringify({url,status:response.status(),data}));return data;}
const state=context=>post(context,'/__billing-test/api/state');
async function setup(){
  const context=await browser.newContext();contexts.push(context);const username='two_tab_'+randomUUID().slice(0,8);
  const r=await post(context,'/api/v1/auth/register',{username,password:'Synthetic-Two-Tab-2026!',accepted_terms_version:terms},201);const account={username,owner:r.user_id};accounts.push(account);
  const subscription=await post(context,'/api/v1/subscriptions',{request_id:randomUUID(),plan_id:'light',provider:'wechat',billing_cycle:'monthly'},201);
  await post(context,'/__billing-test/api/payment/outcome',{id:subscription.order.order_id,outcome:'paid',delivery:'callback'});
  await post(context,'/api/v1/subscriptions/'+subscription.subscription.id+'/auto-renew',{request_id:randomUUID(),enabled:true});
  const authorized=await post(context,'/api/v1/subscriptions/'+subscription.subscription.id+'/auto-renew/refresh');assert.equal(authorized.subscription.auto_renew,true);
  const current=await state(context);assert.equal(current.subscription_test.charges.recurring_paid_orders,0);assert.ok(current.subscription_test.next_event);
  return {context,account,current};
}
async function panel(context,username){const page=await context.newPage();await page.goto(baseURL+'/__billing-test');await expect(page.locator('#identity')).toContainText(username);await expect(page.locator('#advance-subscription')).toBeEnabled();return page;}
const click=page=>page.evaluate(()=>document.querySelector('#advance-subscription').click());
const intent=(page,username)=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)??'null'),key(username));
async function proof(owner){return(await pool.query(`SELECT
  (SELECT count(*)::int FROM bb_recharge_orders WHERE owner_user_id=$1) orders,
  (SELECT count(*)::int FROM bb_subscription_periods WHERE owner_user_id=$1) periods,
  (SELECT count(*)::int FROM bb_local_billing_charges WHERE owner_user_id=$1 AND automatic AND state='paid') recurring_paid,
  (SELECT count(*)::int FROM bb_local_billing_advances WHERE owner_user_id=$1) advances,
  (SELECT count(*)::int FROM bb_credit_events WHERE owner_user_id=$1 AND kind='grant') grants,
  (SELECT COALESCE(sum(amount_fen),0)::text FROM bb_recharge_orders WHERE owner_user_id=$1 AND state='paid') paid_fen,
  (SELECT now_at FROM bb_local_billing_clock WHERE owner_user_id=$1) clock`,[owner])).rows[0];}
const expectOne=(before,after)=>{assert.equal(after.orders,before.orders+1);assert.equal(after.periods,before.periods+1);assert.equal(after.recurring_paid,before.recurring_paid+1);assert.equal(after.advances,before.advances+1);assert.equal(after.grants,before.grants+1);};
async function shot(page,record,name){const filename=record.name+'-'+name+'.png';await page.screenshot({path:join(out,filename),fullPage:true});record.screenshots.push(filename);}
async function run(number,name,work){if(selected&&selected!==String(number))return;const start=contexts.length,record={number,name,faults:[],screenshots:[]};cases.push(record);try{await work(record);record.passed=true;console.log('PASS '+name);}catch(error){record.passed=false;record.error=String(error);record.stack=error.stack;console.log('FAIL '+name+': '+error.message);}finally{for(const context of contexts.splice(start))await context.close();}}
let preflightFailure;
try{
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  await run(1,'different-UUIDs-share-an-old-event-without-advancing-two-months',async record=>{
    const {context,account,current}=await setup();record.account=account;record.oldEvent=current.subscription_test.next_event;record.before=await proof(account.owner);
    const a=await panel(context,account.username);
    // Independent durable browser stores model two signed-in profiles/windows;
    // both actual Edge tabs have the same valid session and same rendered event.
    const other=await browser.newContext({storageState:await context.storageState()});contexts.push(other);const b=await panel(other,account.username);
    record.storageBoundary='Two actual Edge tabs with copied valid session cookies and independent localStorage, producing distinct real UI UUIDs.';
    const arrived=deferred(),dispatch=deferred();let count=0;
    for(const [tab,page] of [['a',a],['b',b]])await page.route('**'+path,async route=>{
      const request=route.request().postDataJSON();if(++count===2)arrived.resolve();await dispatch.promise;
      const response=await route.fetch(),body=await response.json();record.faults.push({kind:'real request dispatch barrier',tab,request,status:response.status(),body});await route.fulfill({response});
    },{times:1});
    try{
      await Promise.all([click(a),click(b)]);await arrived.promise;record.pendingA=await intent(a,account.username);record.pendingB=await intent(b,account.username);
      assert.notEqual(record.pendingA.id,record.pendingB.id);dispatch.resolve();
      await expect(a.locator('#advance-subscription')).toBeEnabled();await expect(b.locator('#advance-subscription')).toBeEnabled();
      record.after=await proof(account.owner);await shot(a,record,'tab-a');await shot(b,record,'tab-b');expectOne(record.before,record.after);
      assert.ok(record.faults.every(f=>JSON.stringify(f.request.expected_event)===JSON.stringify(record.oldEvent)));
      assert.equal(record.faults.filter(f=>f.body.subscription_action?.advanced===true).length,1);
      const changed=record.faults.find(f=>f.body.subscription_action?.event_changed===true);assert.ok(changed);assert.equal(changed.body.subscription_action.request_id,changed.request.id);
      const stalePage=changed.tab==='a'?a:b;await expect(stalePage.locator('#subscription-test')).toContainText('原事件已变化');await expect(stalePage.locator('#log')).toContainText('请核实下一事件');
      const stable=await proof(account.owner),retry={id:randomUUID(),expected_event:record.oldEvent};
      await stalePage.evaluate(({k,value})=>localStorage.setItem(k,JSON.stringify(value)),{k:key(account.username),value:retry});await click(stalePage);
      await expect(stalePage.locator('#advance-subscription')).toBeEnabled();await expect(stalePage.locator('#log')).toContainText('请核实下一事件');
      assert.deepEqual(await proof(account.owner),stable);assert.equal(await intent(stalePage,account.username),null);record.staleRetry=retry;await shot(stalePage,record,'old-event-new-key-retry-blocked');
    }finally{dispatch.resolve();}
  });
  await run(2,'same-UUID-shared-store-acknowledgements-arrive-in-reverse-order',async record=>{
    const {context,account}=await setup();record.account=account;record.before=await proof(account.owner);const a=await panel(context,account.username),b=await panel(context,account.username);
    const firstReady=deferred(),deliverFirst=deferred(),firstDone=deferred();
    await a.route('**'+path,async route=>{const response=await route.fetch(),body=await response.json();record.faults.push({kind:'delay completed genuine first response',request:route.request().postDataJSON(),status:response.status(),body});firstReady.resolve();await deliverFirst.promise;await route.fulfill({response});firstDone.resolve();},{times:1});
    try{
      await click(a);await firstReady.promise;record.firstIntent=await intent(a,account.username);assert.ok(record.firstIntent);
      const secondResponse=b.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');await click(b);const second=await secondResponse;
      record.second={request:second.request().postDataJSON(),status:second.status(),body:await second.json()};assert.deepEqual(record.second.request,record.firstIntent);
      await expect(b.locator('#advance-subscription')).toBeEnabled();await expect(b.locator('#error')).toBeHidden();assert.equal(await intent(b,account.username),null);
      deliverFirst.resolve();await firstDone.promise;await expect(a.locator('#advance-subscription')).toBeEnabled();await expect(a.locator('#error')).toBeHidden();
      record.after=await proof(account.owner);expectOne(record.before,record.after);
      assert.equal(record.faults[0].body.subscription_action.request_id,record.firstIntent.id);assert.equal(record.second.body.subscription_action.request_id,record.firstIntent.id);
      assert.equal(record.second.body.subscription_action.replayed,true);assert.equal(await intent(a,account.username),null);await shot(a,record,'late-ack-is-success');await shot(b,record,'earlier-replay-ack-is-success');
    }finally{deliverFirst.resolve();}
  });
  await run(3,'lost-response-reload-replays-the-original-UUID-and-event',async record=>{
    const {context,account}=await setup();record.account=account;record.before=await proof(account.owner);let page=await panel(context,account.username);const dropped=deferred();
    await page.route('**'+path,async route=>{const response=await route.fetch(),body=await response.json();record.faults.push({kind:'discard completed genuine response',request:route.request().postDataJSON(),status:response.status(),body});await route.abort('failed');dropped.resolve();},{times:1});
    await click(page);await dropped.promise;await expect(page.locator('#error')).toBeVisible();record.originalIntent=await intent(page,account.username);assert.ok(record.originalIntent?.expected_event);
    record.applied=await proof(account.owner);expectOne(record.before,record.applied);await shot(page,record,'unknown-result-keeps-original-event');
    await page.close();page=await panel(context,account.username);assert.deepEqual(await intent(page,account.username),record.originalIntent);
    const replay=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');await click(page);const response=await replay;
    record.replay={request:response.request().postDataJSON(),status:response.status(),body:await response.json()};assert.deepEqual(record.replay.request,record.originalIntent);
    await expect(page.locator('#advance-subscription')).toBeEnabled();await expect(page.locator('#error')).toBeHidden();assert.equal(await intent(page,account.username),null);
    record.after=await proof(account.owner);assert.deepEqual(record.after,record.applied);assert.equal(record.replay.body.subscription_action.request_id,record.originalIntent.id);assert.equal(record.replay.body.subscription_action.replayed,true);await shot(page,record,'recovered-without-second-period');
  });
  await run(4,'legacy-ID-only-pending-records-can-only-recover-an-existing-event',async record=>{
    record.branches=[];
    for(const mode of ['existing','unknown','existing-with-no-next-event']){
      const {context,account,current}=await setup(),original={id:randomUUID()};record.branches.push({mode,account,original});const branch=record.branches.at(-1);
      if(mode==='existing-with-no-next-event')await post(context,'/__billing-test/api/subscription/outcome',{outcome:'failed'});
      if(mode!=='unknown')branch.applied=await post(context,path,{...original,expected_event:current.subscription_test.next_event});
      branch.before=await proof(account.owner);
      // An untouched old JavaScript tab sends only {id}; the route itself must
      // treat that as recovery, even when the new panel never added a flag.
      branch.rawLegacyResponse=await post(context,path,original);assert.equal(branch.rawLegacyResponse.subscription_action.request_id,original.id);
      assert.equal(branch.rawLegacyResponse.subscription_action.replayed,mode!=='unknown');
      if(mode==='unknown'){assert.equal(branch.rawLegacyResponse.subscription_action.event_changed,true);assert.equal(branch.rawLegacyResponse.subscription_action.advanced,false);}
      assert.deepEqual(await proof(account.owner),branch.before);
      const page=await context.newPage();await page.goto(baseURL+'/__billing-test');await expect(page.locator('#identity')).toContainText(account.username);
      await page.evaluate(({k,value})=>localStorage.setItem(k,JSON.stringify(value)),{k:key(account.username),value:original});await page.reload();await expect(page.locator('#identity')).toContainText(account.username);
      await expect(page.locator('#advance-subscription')).toBeEnabled();const response=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');void response.catch(()=>undefined);
      await click(page);
      // Validation errors produce no HTTP request on the old UI. Observe the
      // actual status area first so this regression fails promptly and visibly.
      await expect.poll(async()=>({error:await page.locator('#error').isVisible(),pending:await intent(page,account.username)})).toEqual({error:false,pending:null});
      const receipt=await response;branch.response={request:receipt.request().postDataJSON(),body:await receipt.json(),status:receipt.status()};
      assert.deepEqual(branch.response.request,{...original,replay_only:true});assert.equal(branch.response.body.subscription_action.request_id,original.id);
      assert.equal(branch.response.body.subscription_action.replayed,mode!=='unknown');assert.deepEqual(await proof(account.owner),branch.before);
      if(mode==='unknown')await expect(page.locator('#log')).toContainText('请核实下一事件');
      await shot(page,record,'legacy-'+mode);branch.after=await proof(account.owner);
    }
  });
}catch(error){preflightFailure={error:String(error),stack:error.stack};}
finally{
  const audits=[];for(const account of accounts){try{const audit=await auditCredits(pool,account.owner),calls=(await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[account.owner])).rows[0].n;assert.equal(audit.consistent,true);assert.equal(calls,0);audits.push({...account,consistent:true,modelCalls:calls});}catch(error){preflightFailure??={error:String(error),stack:error.stack};}}
  const result={synthetic:true,realBrowser:'Microsoft Edge',realHttp:true,realPostgres:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,selectedCase:selected??'all',
    passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length+(preflightFailure?1:0),skipped:selected?4-cases.length:0,cases,audits,...(preflightFailure?{preflightFailure}:{})};
  await writeFile(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({evidence:out,passed:result.passed,failed:result.failed,skipped:result.skipped,cases:cases.map(({name,passed,error})=>({name,passed,error}))}));
  for(const context of contexts)await context.close();await browser.close();await pool.end();if(result.failed)process.exitCode=1;
}
