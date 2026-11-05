import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium,expect as playwrightExpect} from '@playwright/test';
import {baseURL,terms,runtime} from './config.mjs';

// Real desktop clicks against the local Web/API/PG. No API responses are mocked.
const expect=playwrightExpect.configure({timeout:15000});
const username='billing_cashier_'+randomUUID().slice(0,8),startedAt=new Date().toISOString();
const out=join(runtime,'cashier-browser',username);await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();
const checks=[],pageErrors=[],externalRequests=[],screenshots=[];
page.on('pageerror',error=>pageErrors.push(error.message));
context.on('request',request=>{
  const url=new URL(request.url());
  if(['http:','https:'].includes(url.protocol)&&!['localhost','127.0.0.1'].includes(url.hostname))externalRequests.push(request.url());
});
await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  return ['http:','https:'].includes(url.protocol)&&!['localhost','127.0.0.1'].includes(url.hostname)?route.abort('blockedbyclient'):route.continue();
});
async function post(path,data={}){
  const token=(await context.cookies(baseURL)).find(cookie=>cookie.name==='bb_csrf')?.value??'';
  const response=await context.request.post(baseURL+path,{headers:{origin:baseURL,'x-bb-csrf':token},data});
  assert.ok(response.ok(),await response.text());return response.json();
}
const state=()=>post('/__billing-test/api/state');
async function balance(available,refundHeld=0){
  const current=await state();assert.equal(BigInt(current.account.available_points),BigInt(available));
  assert.equal(BigInt(current.account.refund_held_points),BigInt(refundHeld));return current;
}
async function shot(name){
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
  await page.screenshot({path:join(out,name),fullPage:true});screenshots.push(name);
}
let failure;
try{
  await post('/api/v1/auth/register',{username,password:'Synthetic-Cashier-2026!',accepted_terms_version:terms});
  await balance(0);await page.goto(baseURL+'/#/account');
  await page.locator('#subscription-topup-amount').fill('50');
  const created=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/commerce/topups');
  await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  const order=await(await created).json(),id=order.order_id;assert.ok(id);
  const entry=page.locator('[data-local-payment-checkout]');await expect(entry).toBeVisible();
  await expect(page.locator('.commerce-native-payment')).toBeHidden();
  await page.locator('#refresh-subscription-payment').click();await balance(0);
  await expect(page.locator('[data-local-payment-checkout]')).toBeVisible();
  const originalReturn=new URL(page.url()).hash;
  await entry.click();await expect(page.locator('#checkout-title')).toHaveText('等待模拟支付');
  await expect(page.locator('.amount')).toHaveText('¥50.00');
  await shot('01-pending-1440.png');await page.setViewportSize({width:1024,height:768});await shot('02-pending-1024.png');
  await page.setViewportSize({width:1440,height:960});
  checks.push('real product checkout opens an explicit local cashier; desktop 1440/1024 fit and refresh does not pay');

  await page.locator('#simulate-paid').click();await expect(page.locator('#checkout-title')).toHaveText('渠道已支付，产品待核实入账');
  await balance(0);await page.reload();await expect(page.locator('#checkout-title')).toHaveText('渠道已支付，产品待核实入账');
  await page.locator('#refresh-payment').click();await expect(page.locator('#checkout-title')).toHaveText('积分已到账');await balance(5000);
  await page.locator('#refresh-payment').click();await expect(page.locator('#refresh-payment')).toBeEnabled();await balance(5000);
  await shot('03-paid-query-once.png');
  checks.push('explicit channel success survives reload, query credits the original order once and repeated query is idempotent');
  await page.locator('#return-paid').click();await expect(page.locator('.subscription-message')).toContainText('积分已到账');
  assert.ok(originalReturn.includes('order='+id));assert.equal(new URL(page.url()).hash.includes('order='),false);
  await page.goto(baseURL+'/__billing-test/checkout?'+new URLSearchParams({order:id}));
  await expect(page.locator('#checkout-title')).toHaveText('积分已到账');
  checks.push('confirmed return reaches the original product payment and clears its completed checkout without another order');

  await page.locator('#refund-amount').fill('10');await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();
  await expect(page.locator('.refund h3')).toContainText('退款处理中');await balance(4000,1000);
  await page.locator('[data-refund-action=refresh]').click();await expect(page.locator('[data-refund-action=refresh]')).toBeEnabled();await balance(4000,1000);
  await page.locator('#delivery').selectOption('callback');await page.locator('[data-refund-action=failed]').click();
  await expect(page.locator('.refund h3')).toContainText('模拟原路退款失败');await balance(5000);
  checks.push('refund request holds original-order points, pending refresh does not release, and authenticated failure restores them');
  await page.locator('#delivery').selectOption('query');await page.locator('#refund-amount').fill('10');
  await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();
  await expect(page.locator('.refund')).toHaveCount(2);await balance(4000,1000);
  const active=page.locator('.refund').filter({has:page.locator('[data-refund-action=succeeded]:enabled')});
  await active.locator('[data-refund-action=succeeded]').click();await expect(page.locator('#message')).toBeVisible();await balance(4000,1000);
  await page.reload();await expect(page.locator('.refund')).toHaveCount(2);
  const pending=page.locator('.refund').filter({hasText:'退款处理中'});
  await pending.locator('[data-refund-action=refresh]').click();
  await expect(page.locator('.refund').filter({hasText:'模拟原路退款成功'})).toHaveCount(1);await balance(4000);
  await page.locator('[data-refund-action=refresh]').first().click();await expect(page.locator('[data-refund-action=refresh]').first()).toBeEnabled();await balance(4000);
  await shot('04-refund-completed-once.png');
  checks.push('query-mode refund success persists across reload and settles the same held amount once');

  const failed=await post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'100',provider:'wechat'});
  await page.goto(baseURL+'/__billing-test/checkout?'+new URLSearchParams({order:failed.order_id}));
  await expect(page.locator('#simulate-failed')).toBeEnabled();await page.locator('#delivery').selectOption('callback');
  await page.locator('#simulate-failed').click();await expect(page.locator('#checkout-title')).toHaveText('支付未完成');await balance(4000);
  await expect(page.locator('#simulate-paid')).toBeDisabled();
  const closed=await post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'100',provider:'wechat'});
  await page.goto(baseURL+'/__billing-test/checkout?'+new URLSearchParams({order:closed.order_id}));
  await expect(page.locator('#close-payment')).toBeEnabled();await page.locator('#close-payment').click();
  await expect(page.locator('#checkout-title')).toHaveText('订单已关闭或过期');await balance(4000);
  await expect(page.locator('#simulate-paid')).toBeDisabled();
  checks.push('failed and closed payment states have clear outcomes, cannot be paid again and grant no points');
  await page.goto(baseURL+'/__billing-test');await expect(page.locator('#identity')).toContainText(username);
  await expect(page.locator('#prepare-dynamic')).toBeVisible();await expect(page.locator('#payments')).toContainText('5,000');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);
  checks.push('test panel shows real orders and both billing-policy test entries; zero page errors or external requests');
}catch(error){failure=error;await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
  const result={synthetic:true,realBrowser:true,realHttp:true,realPostgres:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,
    startedAt,finishedAt:new Date().toISOString(),username,passed:checks.length,failed:failure?1:0,checks,pageErrors,externalRequests,screenshots,
    ...(failure?{error:String(failure),stack:failure.stack}:{})};
  await writeFile(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,evidence:out}));await browser.close();
}
if(failure)throw failure;
