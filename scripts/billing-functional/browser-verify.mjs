import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:15000});
const base='http://localhost:5189',out='evidence/subscription-billing-20261029/completion/functional-manual-20261030';
await mkdir(out,{recursive:true});
const username='billing_ui_'+Date.now(),password='Local-Test-2026!';
const registration=await fetch(base+'/api/v1/auth/register',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username,password,accepted_terms_version:'billing-functional-20261030'})});
assert.equal(registration.status,201,await registration.text());
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const state=()=>page.evaluate(async()=>{const token=document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('bb_csrf='))?.slice(8);const r=await fetch('/__billing-test/api/state',{method:'POST',headers:{'content-type':'application/json','x-bb-csrf':token},body:'{}'});if(!r.ok)throw Error(await r.text());return r.json();});
const balance=async(available,held=0)=>{const s=await state();assert.equal(s.account.available_points,String(available));assert.equal(s.account.task_held_points,String(held));return s;};
const paid=async()=>{await expect(page.locator('#refresh-subscription-payment')).toBeVisible();await page.locator('#refresh-subscription-payment').click();await expect(page.getByRole('heading',{name:'积分已到账',exact:true})).toBeVisible();};
try{
  await page.goto(base+'/#/login');await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#login-form')).toHaveCount(0);await page.goto(base+'/__billing-test');await expect(page.locator('#identity')).toContainText(username);await balance(0);checks.push('real login and zero initial balance');
  await page.locator('#prepare').click();await expect(page.locator('.task')).toHaveCount(1);await page.locator('[data-action=start]').click();await expect(page.locator('#error')).toContainText('CREDITS_INSUFFICIENT');await balance(0);checks.push('insufficient balance creates no hold');
  await page.goto(base+'/#/account');await page.getByRole('button',{name:'开通轻量',exact:true}).click();await paid();await balance(21000);checks.push('real subscription checkout grants 21000 after synthetic receipt');
  await page.goto(base+'/#/account');await page.locator('#subscription-topup-amount').fill('100');await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();await paid();await balance(31000);checks.push('real topup adds permanent 10000');
  await page.goto(base+'/__billing-test');await expect(page.locator('#identity')).toContainText(username);await page.locator('[data-action=start]').click();await expect(page.locator('[data-action=succeeded]')).toBeEnabled();await balance(3805,27195);await page.screenshot({path:out+'/reserved-desktop.png',fullPage:true});checks.push('start reserves exact quote without amount confirmation');
  await page.locator('[data-action=succeeded]').click();await expect(page.locator('.task')).toContainText('succeeded');await balance(3805);checks.push('synthetic delivery uses real settlement');
  await page.locator('[data-action=replay]').click();await expect(page.locator('[data-action=replay]')).toBeEnabled();await balance(3805);checks.push('execution replay does not charge twice');
  await page.goto(base+'/#/account');await page.locator('#subscription-topup-amount').fill('300');await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();await paid();await balance(33805);
  await page.goto(base+'/__billing-test');await page.locator('#prepare').click();await expect(page.locator('.task')).toHaveCount(2);await page.locator('[data-action=start]').first().click();await expect(page.locator('[data-action=failed]').first()).toBeEnabled();await balance(6610,27195);await page.locator('[data-action=failed]').first().click();await expect(page.locator('.task').first()).toContainText('failed');await balance(33805);checks.push('failed task releases the entire hold');
  await page.reload();await expect(page.locator('#identity')).toContainText(username);await balance(33805);checks.push('reload retains real ledger');
  await page.screenshot({path:out+'/ledger-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/ledger-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.goto(base+'/#/account');await expect(page.locator('#subscription-topup-amount')).toBeVisible();await page.screenshot({path:out+'/account-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);checks.push('desktop/mobile usable, no page exceptions');
  console.log(JSON.stringify({passed:checks.length,checks,username,synthetic:true,realMoneyCharged:false,modelCalls:0}));
  await writeFile(out+'/browser-result.json',JSON.stringify({passed:checks.length,checks,username,errors,synthetic:true,realMoneyCharged:false,modelCalls:0},null,2)+'\n');
}catch(error){console.error({checks,errors,visibleError:await page.locator('#error').textContent().catch(()=>null)});await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});throw error;}
finally{await browser.close();}
