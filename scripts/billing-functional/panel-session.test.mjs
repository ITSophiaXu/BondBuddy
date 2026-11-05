import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {chromium} from '@playwright/test';
import {baseURL,runtime,terms,config,pgBase} from './config.mjs';

test('panel refreshes an expired real session once and never retries uncertain business requests',{timeout:90000},async()=>{
  const saved=config();assert.match(saved.database,/^bb_billing_functional_[a-f0-9]{16}$/);
  const pool=new Pool({connectionString:pgBase+saved.database}),browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext();
  const username='billing_sess_'+randomUUID().slice(0,8),checks=[],startedAt=new Date().toISOString();let owner,page;
  assert.match(username,/^billing_sess_[a-f0-9]{8}$/);assert.notEqual(username,'billing_tester');
  const cookie=async()=>((await context.cookies(baseURL)).find(value=>value.name==='bb_csrf')?.value??'');
  const api=async(path,data)=>{const response=await context.request.post(baseURL+path,{headers:{origin:baseURL,'x-bb-csrf':await cookie()},...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
  const expire=async()=>{const changed=await pool.query("UPDATE bb_auth_sessions SET access_expires_at=now()-interval '1 minute' WHERE user_id=$1 AND revoked_at IS NULL AND user_id=(SELECT id FROM bb_users WHERE username=$2)",[owner,username]);assert.ok(changed.rowCount>0);};
  const completed=async(message)=>{await page.locator('#log').getByText(message,{exact:false}).waitFor();};
  try{
    assert.equal((await pool.query('SELECT instance_id FROM bb_local_billing_instance')).rows[0].instance_id,saved.id);
    owner=(await api('/api/v1/auth/register',{username,password:'Synthetic-Session-2026!',accepted_terms_version:terms})).user_id;
    page=await context.newPage();const requests=[];
    page.on('request',request=>{const path=new URL(request.url()).pathname;if(request.method()==='POST'&&['/__billing-test/api/review/start','/api/v1/auth/refresh'].includes(path))requests.push({path,body:request.postData()});});
    await page.goto(baseURL+'/__billing-test');await page.locator('#identity').getByText('当前登录：'+username,{exact:true}).waitFor();
    await page.locator('#prepare').click();await page.locator('[data-action="start"]').waitFor();
    const id=await page.locator('[data-action="start"]').getAttribute('data-id'),originalBody=JSON.stringify({id});
    const startPath='**/__billing-test/api/review/start',refreshPath='**/api/v1/auth/refresh';
    const startCalls=()=>requests.filter(request=>request.path.endsWith('/review/start'));
    const refreshCalls=()=>requests.filter(request=>request.path.endsWith('/auth/refresh'));
    // Controlled client-side failures are deliberately separate from the real
    // expired-session + wallet test below; these do not reach the backend.
    for(const code of [403,500,'network']){
      requests.length=0;
      await page.route(startPath,route=>code==='network'?route.abort('failed'):route.fulfill({status:code,contentType:'application/json',body:JSON.stringify({code:'SYNTHETIC_'+code,message:'Injected response for retry guard'})}));
      await page.locator('[data-action="start"]').click();await page.locator('#error:not([hidden])').waitFor();
      assert.equal(startCalls().length,1);assert.equal(refreshCalls().length,0);assert.equal(startCalls()[0].body,originalBody);
      await page.unroute(startPath);checks.push(`${code}: no refresh and no request replay`);
    }
    requests.length=0;
    await page.route(startPath,route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({code:'UNAUTHENTICATED',message:'Injected second 401'})}));
    await page.locator('[data-action="start"]').click();await page.locator('#identity').getByText('请先登录真实产品账户',{exact:true}).waitFor();
    assert.equal(startCalls().length,2);assert.equal(refreshCalls().length,1);assert.ok(startCalls().every(request=>request.body===originalBody));
    await page.unroute(startPath);checks.push('second 401 stops after one real refresh and one identical retry');
    await page.reload();await page.locator('#identity').getByText('当前登录：'+username,{exact:true}).waitFor();
    await expire();requests.length=0;
    await page.route(refreshPath,route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'SYNTHETIC_REFRESH_FAILED',message:'Injected refresh failure'})}));
    await page.locator('[data-action="start"]').click();await page.locator('#error').getByText(/SYNTHETIC_REFRESH_FAILED/).waitFor();
    assert.equal(startCalls().length,1);assert.equal(refreshCalls().length,1);assert.equal(startCalls()[0].body,originalBody);
    await page.unroute(refreshPath);checks.push('real expired-session 401 plus failed refresh does not replay business');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n,0);
    await api('/api/v1/auth/refresh');
    const order=await api('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'60000',provider:'wechat'});
    await api('/__billing-test/api/payment/outcome',{id:order.order_id,outcome:'paid',delivery:'query'});
    await api('/api/v1/commerce/topups/'+order.order_id+'/refresh',{});
    await expire();requests.length=0;
    await page.locator('[data-action="start"]').click();await completed('开始任务完成');
    assert.equal(startCalls().length,2);assert.equal(refreshCalls().length,1);assert.ok(startCalls().every(request=>request.body===originalBody));
    const counters=(await pool.query(`SELECT (SELECT count(*)::int FROM bb_runs WHERE owner_user_id=$1) runs,
      (SELECT count(*)::int FROM bb_credit_reservations WHERE owner_user_id=$1) reservations,
      (SELECT COALESCE(sum(frozen),0)::text FROM bb_credit_lots WHERE owner_user_id=$1) held`,[owner])).rows[0];
    assert.deepEqual(counters,{runs:1,reservations:1,held:'27195'});checks.push('real expired session refreshes and same funded task reserves exactly once');
    await page.locator('[data-action="failed"]').click();await completed('核对失败与退款完成');
    assert.equal((await pool.query('SELECT COALESCE(sum(frozen),0)::text held FROM bb_credit_lots WHERE owner_user_id=$1',[owner])).rows[0].held,'0');
    checks.push('cleanup through actual failed finish releases test reservation');
    const proof={synthetic:true,username,startedAt,finishedAt:new Date().toISOString(),passed:checks.length,checks,
      realHttpSessionExpiry:true,clientFailureInjection:true,productionAuthChanged:false,defaultDemoAccountTouched:false};
    writeFileSync(join(runtime,'panel-session-verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
  }finally{await context.close();await browser.close();await pool.end();}
});
