import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {chromium,expect as playwrightExpect} from '@playwright/test';
import {baseURL,apiURL,terms,config,pgBase,runtime} from './config.mjs';

// Fixture endpoints only prepare synthetic input. The actual local cashier UI
// records the channel outcome; execution, checkout and recovery use the product.
// No browser routes, responses, localStorage records or payment balances are mocked.
const expect=playwrightExpect.configure({timeout:15000});
const saved=config(),startedAt=new Date().toISOString(),username='billing_recover_'+randomUUID().slice(0,8);
const out=join(runtime,'product-recovery-20261105',username);
await mkdir(out,{recursive:true});
assert.match(username,/^billing_recover_[a-f0-9]{8}$/);assert.notEqual(username,'billing_tester');
const pool=new Pool({connectionString:pgBase+saved.database});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();
const checks=[],pageErrors=[],executionRequests=[],executionResponses=[],checkoutRequests=[];
let owner,projectId,runId,requestId,resumeId,expectedPoints,orderId,failure,cleanupError;
const cookie=async()=>((await context.cookies(baseURL)).find(value=>value.name==='bb_csrf')?.value??'');
const api=async(path,data={})=>{
  const response=await context.request.post(baseURL+path,{headers:{origin:baseURL,'x-bb-csrf':await cookie()},data});
  assert.ok(response.ok(),await response.text());return response.json();
};
const account=async()=>((await api('/__billing-test/api/state')).account);
const amounts=async(available,held='0')=>{const row=await account();assert.equal(row.available_points,String(available));assert.equal(row.task_held_points,String(held));return row;};
const counters=async()=>(await pool.query(`SELECT
  (SELECT count(*)::int FROM bb_runs WHERE owner_user_id=$1) runs,
  (SELECT count(*)::int FROM bb_credit_reservations WHERE owner_user_id=$1) reservations,
  (SELECT COALESCE(sum(frozen),0)::text FROM bb_credit_lots WHERE owner_user_id=$1) held`,[owner])).rows[0];
const executionResponse=status=>page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/projects/${projectId}/review-executions`&&response.status()===status);
page.on('pageerror',error=>pageErrors.push(error.message));
page.on('request',request=>{
  const path=new URL(request.url()).pathname;
  if(request.method()==='POST'&&path===`/api/v1/projects/${projectId}/review-executions`)executionRequests.push({path,body:request.postData()});
  if(request.method()==='POST'&&path==='/api/v1/commerce/topups')checkoutRequests.push({path,body:request.postData()});
});
page.on('response',response=>{
  const request=response.request(),path=new URL(response.url()).pathname;
  if(request.method()==='POST'&&path===`/api/v1/projects/${projectId}/review-executions`)executionResponses.push({path,status:response.status()});
});
try{
  assert.equal((await pool.query('SELECT instance_id FROM bb_local_billing_instance')).rows[0].instance_id,saved.id);
  const status=await context.request.get(apiURL+'/__billing-test/status');assert.ok(status.ok());assert.equal((await status.json()).synthetic,true);
  owner=(await api('/api/v1/auth/register',{username,password:'Synthetic-Recovery-2026!',accepted_terms_version:terms})).user_id;
  assert.ok(owner);await amounts('0');checks.push('real authenticated random account starts at zero; isolated synthetic instance verified');
  const prepared=await api('/__billing-test/api/review/prepare',{id:randomUUID()});
  assert.equal(prepared.tasks.length,1);projectId=prepared.tasks[0].project_id;
  expectedPoints=String(prepared.tasks[0].quote.points);assert.equal(expectedPoints,'27195');
  assert.equal(prepared.tasks[0].run_id,null);await amounts('0');
  await page.goto(`${baseURL}/#/projects/${encodeURIComponent(projectId)}/review?tab=materials`);
  await expect(page.getByRole('heading',{name:'复核募集说明书',exact:true})).toBeVisible();
  await expect(page.locator('[data-review-selected-source]')).toContainText('synthetic-billing-source.docx');
  const firstResponse=executionResponse(402);
  await page.locator('#review-materials-panel [data-review-action="review"]').click();
  assert.equal((await (await firstResponse).json()).code,'CREDITS_INSUFFICIENT');
  await expect(page.locator('#billing-task-notice')).toContainText('原任务尚未开始');
  assert.equal(executionRequests.length,1);assert.deepEqual(await counters(),{runs:0,reservations:0,held:'0'});await amounts('0');
  assert.equal(await page.locator('dialog[open]').count(),0);
  requestId=JSON.parse(executionRequests[0].body).execution_request_id;
  const noticeLink=page.locator('#billing-task-notice a');
  const href=await noticeLink.getAttribute('href'),query=new URLSearchParams(href.split('?')[1]);resumeId=query.get('resume_request');
  assert.ok(resumeId);assert.match(query.get('return_to'),new RegExp(projectId));
  const pending=await page.evaluate(id=>JSON.parse(localStorage.getItem('bondbuddy:billing-task:v2:'+id)),resumeId);
  assert.equal(pending.owner,owner);assert.equal(pending.state,'needs_funds');assert.equal(pending.requestId,requestId);assert.equal(pending.requiredPoints,expectedPoints);
  assert.deepEqual(pending.body,JSON.parse(executionRequests[0].body));
  checks.push('one actual review click submits without amount confirmation; 402 saves the exact original task and creates no run or hold');
  await page.screenshot({path:join(out,'01-product-insufficient.png'),fullPage:true});
  await noticeLink.click();
  await expect(page.locator('#subscription-topup-amount')).toHaveValue('271.95');
  assert.ok(page.url().includes('resume_request='+resumeId));
  checks.push('product recharge link carries recovery identity and pre-fills the exact 271.95 yuan shortage');
  await page.screenshot({path:join(out,'02-product-shortage-account.png'),fullPage:true});
  await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page.locator('#refresh-subscription-payment')).toBeVisible();
  assert.equal(checkoutRequests.length,1);assert.equal(JSON.parse(checkoutRequests[0].body).amount_fen,expectedPoints);
  assert.ok(page.url().includes('resume_request='+resumeId));
  checks.push('real account checkout creates one exact-shortage topup and preserves original task recovery');
  const recoveredResponse=executionResponse(200);
  const paymentId=new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('order');assert.ok(paymentId);
  await page.locator('[data-local-payment-checkout]').click();
  await expect(page.locator('#checkout-title')).toHaveText('等待模拟支付');
  const cashierQuery=new URL(page.url()).searchParams;
  assert.equal(cashierQuery.get('order'),paymentId);
  assert.ok(cashierQuery.get('return_to').includes('resume_request='+resumeId));
  await amounts('0');
  await page.locator('#simulate-paid').click();
  await expect(page.locator('#checkout-title')).toHaveText('渠道已支付，产品待核实入账');
  await amounts('0');
  await page.screenshot({path:join(out,'03-cashier-awaiting-confirmation.png'),fullPage:true});
  await page.locator('#return-paid').click();
  const recovered=await (await recoveredResponse).json();runId=recovered.run_id;
  assert.equal(recovered.execution_request_id,requestId);assert.equal(recovered.project_id,projectId);assert.equal(recovered.state,'queued');
  await expect(page.getByRole('heading',{name:'复核募集说明书',exact:true})).toBeVisible();
  await expect(page.locator('[data-review-action="cancel"]').first()).toBeVisible();
  assert.ok(!page.url().includes('resume_request='));
  assert.equal(executionRequests.length,2);assert.deepEqual(executionRequests[1],executionRequests[0]);
  assert.equal(await page.evaluate(id=>localStorage.getItem('bondbuddy:billing-task:v2:'+id),resumeId),null);
  checks.push('explicit cashier confirmation preserves resume identity, returns to the real review page and replays the same request key and exact body without another start click');
  assert.deepEqual(await counters(),{runs:1,reservations:1,held:expectedPoints});await amounts('0',expectedPoints);
  const held=(await pool.query(`SELECT r.execution_request_id,r.state,h.state charge_state,h.points::text,h.charged_points::text
    FROM bb_runs r JOIN bb_credit_reservations h ON h.run_id=r.id
    WHERE r.id=$1 AND r.owner_user_id=$2 AND h.owner_user_id=$2`,[runId,owner])).rows[0];
  assert.equal(held.execution_request_id,requestId);assert.equal(held.state,'queued');assert.equal(held.charge_state,'held');assert.equal(held.points,expectedPoints);assert.equal(BigInt(held.charged_points??0),0n);
  const orders=(await pool.query('SELECT id,state,amount_fen::text,points::text FROM bb_recharge_orders WHERE owner_user_id=$1',[owner])).rows;
  assert.equal(orders.length,1);assert.equal(orders[0].state,'paid');assert.equal(orders[0].amount_fen,expectedPoints);assert.equal(orders[0].points,expectedPoints);orderId=orders[0].id;
  checks.push('real database has one paid order, one queued run and one 27195-point reservation, with no settled task charge yet');
  await page.screenshot({path:join(out,'03-product-automatically-resumed.png'),fullPage:true});
  await page.reload();await expect(page.locator('[data-review-action="cancel"]').first()).toBeVisible();
  assert.equal(executionRequests.length,2);assert.deepEqual(await counters(),{runs:1,reservations:1,held:expectedPoints});
  checks.push('product reload restores the same queued task and does not submit or reserve again');
  const cancelled=await api(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`,{reason:'user_cancelled'});assert.equal(cancelled.state,'cancelled');
  await amounts(expectedPoints);assert.deepEqual(await counters(),{runs:1,reservations:1,held:'0'});
  const final=(await pool.query('SELECT state,charged_points::text FROM bb_credit_reservations WHERE run_id=$1 AND owner_user_id=$2',[runId,owner])).rows[0];
  assert.equal(final.state,'released');assert.equal(BigInt(final.charged_points??0),0n);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  checks.push('real queued-run cancellation releases the full hold; model calls remain zero');
  await page.reload();await expect(page.locator('#review-materials-panel [data-review-action="review"]')).toBeEnabled();
  await page.screenshot({path:join(out,'04-product-cancelled.png'),fullPage:true});
  assert.deepEqual(pageErrors,[]);checks.push('real product chain completes with no unhandled browser exceptions');
}catch(error){
  failure=error;
  await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});
}finally{
  // Cleanup is narrowly scoped to the random account/project. Do not claim a
  // global queue job or use the panel's unrelated prepared execution mapping.
  if(owner&&projectId){
    try{
      const active=(await pool.query("SELECT id FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND state='queued'",[owner,projectId])).rows;
      for(const row of active)await api(`/api/v1/runs/${encodeURIComponent(row.id)}/cancel`,{reason:'user_cancelled'});
    }catch(error){cleanupError=String(error);}
  }
  const proof={startedAt,finishedAt:new Date().toISOString(),username,projectId,runId,requestId,resumeId,orderId,expectedPoints,
    passed:checks.length,failed:failure||cleanupError?1:0,checks,pageErrors,
    executionRequests:executionRequests.map(({path,body})=>({path,bodySha256:createHash('sha256').update(body).digest('hex'),executionRequestId:JSON.parse(body).execution_request_id})),executionResponses,
    realProductBrowser:true,realHttp:true,realPostgres:true,fixturePreparationOnly:true,paymentOutcomeControl:true,explicitCashierClicks:true,clientResponseMocking:false,localStorageInjection:false,
    syntheticPaymentProvider:true,modelWorkerRunning:false,realMoneyCharged:false,defaultDemoAccountTouched:false,
    ...(failure?{error:String(failure)}:{}),...(cleanupError?{cleanupError}:{})};
  await writeFile(join(out,'result.json'),JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify(proof));await context.close();await browser.close();await pool.end();
}
if(failure)throw failure;if(cleanupError)throw Error(cleanupError);
