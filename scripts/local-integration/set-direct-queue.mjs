import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {baseURL,instance,runtime} from './config.mjs';

if(instance!=='direct-20261125')throw Error('Use only the isolated direct DOCX instance');
const [action,...runIds]=process.argv.slice(2);
if(!['pause','resume'].includes(action)||!runIds.length||!runIds.every(id=>/^[0-9a-f-]{36}$/.test(id)))
  throw Error('Usage: set-direct-queue.mjs pause|resume <run-id> ...');
const account=JSON.parse(readFileSync(join(runtime,'test-accounts.json'),'utf8')).accounts.find(a=>a.username==='integration_user');
assert.ok(account);
const browser=await chromium.launch();
try{
  const context=await browser.newContext({baseURL});
  const page=await context.newPage();
  await page.goto('/');
  await page.getByLabel('用户名',{exact:true}).fill(account.username);
  await page.getByLabel('密码',{exact:true}).fill(account.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('link',{name:'任务进度与结果',exact:true})).toBeVisible();
  const csrf=(await context.cookies(baseURL)).find(cookie=>cookie.name==='bb_csrf')?.value;
  assert.ok(csrf,'local session CSRF cookie missing');
  for(const id of runIds){
    const beforeResponse=await context.request.get(`/api/v1/runs/${id}`);
    assert.equal(beforeResponse.status(),200);
    const before=await beforeResponse.json();
    assert.equal(before.state,action==='pause'?'queued':'paused',`unexpected state for ${id}`);
    if(action==='resume')assert.equal(before.stage,'user_paused');
    const response=await context.request.post(`/api/v1/runs/${id}/${action}`,{
      headers:{origin:baseURL,'x-bb-csrf':csrf},data:{reason:'isolated direct update concurrency test'}});
    assert.equal(response.status(),200,`${id}: ${(await response.text()).slice(0,300)}`);
    const afterResponse=await context.request.get(`/api/v1/runs/${id}`);
    assert.equal(afterResponse.status(),200);
    const after=await afterResponse.json();
    assert.equal(after.state,action==='pause'?'paused':'queued');
    console.log(JSON.stringify({runId:id,action,state:after.state,stage:after.stage}));
  }
}finally{await browser.close();}
