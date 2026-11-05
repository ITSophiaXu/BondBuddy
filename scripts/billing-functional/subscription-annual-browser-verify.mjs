import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {chromium,expect as playwrightExpect} from '@playwright/test';
import {baseURL,apiURL,terms,config,pgBase,repo,runtime} from './config.mjs';
import {payBrowserOrder} from './test-client.mjs';

// One actual annual purchase, in a new browser context and random account.
// All UI/API responses are real. Only the explicitly configured local payment
// provider and subscription clock are synthetic; no model task is created.
const expect=playwrightExpect.configure({timeout:15000});
const saved=config(),startedAt=new Date().toISOString(),username='billing_annual_ui_'+randomUUID().slice(0,8);
const out=join(runtime,'subscription-annual-browser-20261105',username);
await mkdir(out,{recursive:true});
const pool=new Pool({connectionString:pgBase+saved.database});
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const checks=[],pageErrors=[],invalidDomainRequests=[],nonLocalRequests=[],mandateRequests=[],screenshots=[];
let owner,subscriptionId,firstOrderId,failure,launchId;
const cookie=async()=>((await context.cookies(baseURL)).find(value=>value.name==='bb_csrf')?.value??'');
const api=async(path,data={})=>{
  const response=await context.request.post(baseURL+path,{headers:{origin:baseURL,'x-bb-csrf':await cookie()},data});
  assert.ok(response.ok(),await response.text());return response.json();
};
const state=()=>api('/__billing-test/api/state');
const points=async expected=>{const current=await state();assert.equal(BigInt(current.account.available_points),BigInt(expected));return current;};
const shot=async name=>{await page.screenshot({path:join(out,name),fullPage:true});screenshots.push(name);};
context.on('request',request=>{
  const url=new URL(request.url());
  if(url.hostname==='billing-functional.invalid')invalidDomainRequests.push({url:request.url(),method:request.method()});
  if(['http:','https:'].includes(url.protocol)&&!['localhost','127.0.0.1'].includes(url.hostname))nonLocalRequests.push(request.url());
  if(request.method()==='POST'&&url.pathname.includes('/auto-renew'))mandateRequests.push({path:url.pathname,body:request.postData()});
});
// A failed test must not actually reach an external payment host. Attempted
// requests are still recorded above and make the test fail; product responses
// and the local authorization script are never intercepted or substituted.
await context.route('**/*',route=>{
  const url=new URL(route.request().url());return ['http:','https:'].includes(url.protocol)&&!['localhost','127.0.0.1'].includes(url.hostname)?route.abort('blockedbyclient'):route.continue();
});
page.on('pageerror',error=>pageErrors.push(error.message));
try{
  assert.match(saved.database,/^bb_billing_functional_[a-f0-9]{16}$/);
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  const status=await(await context.request.get(apiURL+'/__billing-test/status')).json();
  launchId=status.launch_id;assert.equal(status.ready,true);assert.equal(launchId,JSON.parse(await readFile(join(runtime,'state.json'),'utf8')).launchId);
  owner=(await api('/api/v1/auth/register',{username,password:'Synthetic-Annual-UI-2026!',accepted_terms_version:terms})).user_id;
  assert.ok(owner);await points(0);checks.push('new random account and independent Edge context start at zero in the verified local instance');
  await page.goto(baseURL+'/#/account');
  await expect(page.locator('[data-billing-cycle="annual"]')).toBeVisible();await page.locator('[data-billing-cycle="annual"]').click();
  await expect(page.locator('[data-billing-cycle="annual"]')).toHaveAttribute('aria-checked','true');
  const checkoutReply=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/subscriptions');
  await page.locator('[data-subscribe="light"]').click();const checkoutResponse=await checkoutReply;assert.equal(checkoutResponse.status(),201);
  const checkout=await checkoutResponse.json();subscriptionId=checkout.subscription.id;firstOrderId=checkout.order.order_id;
  assert.equal(checkout.subscription.billing_cycle,'annual');assert.equal(BigInt(checkout.order.amount_fen),214920n);
  await expect(page.locator('#refresh-subscription-payment')).toBeVisible();await payBrowserOrder(page,firstOrderId);await page.locator('#refresh-subscription-payment').click();
  await expect(page.locator('.subscription-payment')).toHaveCount(0);await expect(page.locator('#refresh-subscription-payment')).toHaveCount(0);
  await expect(page.locator('.subscription-message')).toContainText('本月积分已到账，剩余额度按月发放');
  await expect(page.locator('.subscription-annual-releases')).toContainText('已发放 1/12');
  const paid=await points(21000);assert.equal(paid.subscription_test.charges.paid_orders,1);assert.equal(paid.subscription_test.charges.simulated_paid_fen,'214920');
  const paidQuery=new URLSearchParams(new URL(page.url()).hash.split('?')[1]);assert.equal(paidQuery.has('order'),false);assert.equal(paidQuery.has('checkout'),false);
  checks.push('real annual checkout charges 2149.20 once, closes its payment card and grants only the first 21000 points');await shot('01-annual-paid-first-month.png');
  await page.locator('#subscription-manage').click();
  await expect(page.locator('#subscription-management-title')).toBeVisible();
  await page.locator('#subscription-renewal-switch').click();
  const link=page.locator('.subscription-authorization a');await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('data-local-synthetic-mandate','true');await expect(link).toHaveAttribute('href',baseURL+'/#/account');
  assert.equal(await link.getAttribute('target'),null);assert.equal(context.pages().length,1);
  await shot('02-localized-authorization.png');
  const refreshed=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/subscriptions/${subscriptionId}/auto-renew/refresh`);
  await link.click();const refreshResponse=await refreshed;assert.equal(refreshResponse.status(),200);const authorized=await refreshResponse.json();
  assert.equal(authorized.subscription.auto_renew,true);assert.equal(authorized.subscription.mandate_status,'active');
  await expect(page.locator('#subscription-renewal-switch')).toHaveAttribute('aria-checked','true');await expect(page.locator('.subscription-authorization')).toHaveCount(0);
  assert.equal(context.pages().length,1);assert.deepEqual(invalidDomainRequests,[]);assert.deepEqual(nonLocalRequests,[]);
  assert.ok(mandateRequests.some(request=>request.path===`/api/v1/subscriptions/${subscriptionId}/auto-renew/refresh`));
  checks.push('clicking the localized authorization link triggers the actual mandate refresh, enables renewal and sends zero external requests');await shot('03-renewal-enabled.png');
  await page.locator('#subscription-renewal-switch').click();
  await expect(page.locator('#subscription-cancel-dialog')).toBeVisible();
  await page.locator('#subscription-cancel-confirm').click();
  await expect(page.locator('#subscription-renewal-switch')).toHaveAttribute('aria-checked','false');
  const cancelled=await state();assert.equal(cancelled.account.subscription.auto_renew,false);assert.equal(cancelled.account.subscription.mandate_status,'cancelled');
  const contractEnd=cancelled.account.subscription.current_period_end;
  checks.push('the real renewal switch cancels the persisted channel mandate');
  await page.goto(baseURL+'/__billing-test');await expect(page.locator('#identity')).toContainText(username);
  await expect(page.locator('#advance-subscription')).toBeEnabled();await page.locator('#advance-subscription').click();
  await expect(page.locator('#log')).toContainText('模拟下期续费/额度发放完成');
  const next=await points(42000);assert.equal(next.subscription_test.charges.paid_orders,1);assert.equal(next.subscription_test.charges.recurring_paid_orders,0);
  assert.equal(next.subscription_test.charges.simulated_paid_fen,'214920');assert.equal(next.account.subscription.current_period_end,contractEnd);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_subscription_credit_releases WHERE owner_user_id=$1 AND state=$2',[owner,'issued'])).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  checks.push('the real test-panel button releases the second annual installment after cancellation, with one original payment and no model runs');await shot('04-second-month-issued.png');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(invalidDomainRequests,[]);assert.deepEqual(nonLocalRequests,[]);
  checks.push('no browser exceptions, popups or external HTTP requests throughout the actual annual flow');
}catch(error){failure=String(error);await shot('failure.png').catch(()=>{});}
finally{
  const proof={synthetic:true,realBrowser:'Microsoft Edge / Playwright',realHttp:true,realPostgres:true,startedAt,finishedAt:new Date().toISOString(),
    instanceId:saved.id,launchId,username,owner,subscriptionId,firstOrderId,passed:checks.length,failed:failure?1:0,checks,
    invalidDomainRequests,nonLocalRequests,mandateRequests,pageErrors,screenshots,modelCallsPerformed:0,realPaymentCallsPerformed:0,
    clockScope:'subscription only; wallet expiry and sessions use real time',...(failure?{error:failure}:{})};
  await writeFile(join(out,'result.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({result:join(out,'result.json'),...proof}));
  await context.close();await browser.close();await pool.end();
}
if(failure)throw Error(failure);
