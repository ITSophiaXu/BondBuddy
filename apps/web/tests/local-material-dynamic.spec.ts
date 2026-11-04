import {test,expect} from '@playwright/test';
import {Pool} from 'pg';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {account,login} from './live-helpers';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {grantCredits} from '../../api/dist/billing.js';
import {transaction,digest} from '../../api/dist/data.js';
import {databaseURL,runtime} from '../../../scripts/local-integration/config.mjs';

test.skip(process.env.BB_E2E_LOCAL_INTEGRATION!=='1','Explicit dedicated local environment only.');
test('real material upload, one-point debit, process log and durable pause without a model call',async({page,playwright})=>{
  test.setTimeout(120000);
  if(process.env.BB_E2E_BASE_URL!=='http://localhost:5178'||new URL(databaseURL).pathname!=='/bb_integration_20261012')throw Error('Dedicated local environment required');
  const user=await account(playwright),pool=new Pool({connectionString:databaseURL}),evidence=join(runtime,'evidence/material-dynamic-20261013');mkdirSync(evidence,{recursive:true});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    const owner=(await pool.query('SELECT id FROM bb_users WHERE username=$1',[user.username])).rows[0].id;
    await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:'material-one-point-'+owner,points:1,expiresAt:null,actor:'local-synthetic-test',reason:'One-point exhaustion before model call'}));
    await login(page,user);await page.goto('/#generate?new=synthetic-material-dynamic');
    await page.locator('[data-m4-type][value=private_summary]').check();
    await page.getByLabel('上传最新版募集说明书',{exact:true}).setInputFiles({name:'合成动态材料原稿.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:makeSyntheticDocxFixture({text:'Synthetic material generation flow only. No customer data.'})});
    await expect(page.locator('.m4-source-file')).toContainText('合成动态材料原稿.docx');
    await page.locator('[data-m4-field=market]').selectOption('sse');
    await page.locator('#m4-requirements').fill('合成测试：一积分在输入保存后暂停，不进入模型。');
    const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&/\/m4\/topics\/[^/]+\/execute$/.test(new URL(r.url()).pathname));
    await page.getByRole('button',{name:'生成募集说明书摘要',exact:true}).click();
    const response=await submitted;expect(response.status()).toBe(200);const {run}=await response.json();
    await expect(page.getByRole('tab',{name:'生成进度',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(page.locator('.task-progress')).toContainText('积分已用完，任务已暂停',{timeout:60000});
    await expect(page.locator('.authoring-credit-meter strong')).toHaveText('1 积分');
    await expect(page.locator('.authoring-credit-meter')).toContainText('可用余额 0 积分');
    await expect(page.locator('[aria-label=生成过程]')).toContainText('积分已用完，已保存进度并暂停');
    await expect(page.locator('.m4-tab-close')).toHaveCount(0);await expect(page.getByText('来源与版本',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('link',{name:'查看积分与支付状态',exact:true})).toBeVisible();
    await page.reload();await expect(page.locator('.task-progress')).toContainText('积分已用完，任务已暂停');
    for(const width of [1440,390]){await page.setViewportSize({width,height:width===1440?960:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(evidence,`real-exhausted-${width}.png`),fullPage:true});}
    const stored=(await pool.query('SELECT r.state,c.billing_policy,c.charged_points,j.checkpoint FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id JOIN bb_credit_reservations c ON c.id=r.reservation_id WHERE r.id=$1 AND r.owner_user_id=$2',[run.run_id,owner])).rows[0];
    expect(stored.state).toBe('paused');expect(stored.billing_policy).toBe('authoring_balance_v2');expect(Number(stored.charged_points)).toBe(1);expect(stored.checkpoint.stages).toHaveProperty('input_lock');
    expect((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1',[run.run_id])).rows[0].n).toBe(0);
    await page.getByRole('button',{name:'结束本次生成',exact:true}).click();await expect(page.locator('.task-progress')).toContainText('本轮已停止');
    await expect(page.locator('.authoring-credit-meter')).toContainText('本次已扣费');await expect(page.locator('.authoring-credit-meter strong')).toHaveText('1 积分');
    expect(errors).toEqual([]);
    writeFileSync(join(evidence,'verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),apiMocked:false,workerImage:JSON.parse(readFileSync(join(runtime,'linux-worker.json'),'utf8')).imageId,runId:run.run_id,projectURL:page.url(),directStart:true,chargedPoints:1,modelCalls:0,checkpointSaved:true,preservedAfterReload:true,endedSyntheticRun:true,errors,passed:true},null,2));
  }finally{await pool.end();}
});

test('existing user material files and legacy released credits survive the update',async({page})=>{
  test.setTimeout(90000);
  if(process.env.BB_E2E_BASE_URL!=='http://localhost:5178')throw Error('Local only');
  const pool=new Pool({connectionString:databaseURL}),evidence=join(runtime,'evidence/material-dynamic-20261013');mkdirSync(evidence,{recursive:true});
  try{
    await login(page,{username:'integration_user',password:'Local-Test-2026!'});
    const row=(await pool.query("SELECT topic_id FROM bb_m4_executions WHERE run_id='ac144271-6a1f-4828-a802-aa4fd6abbbe7'")).rows[0];
    const response=await page.request.get(`/api/v1/m4/topics/${row.topic_id}/workspace`);expect(response.status()).toBe(200);const ws=await response.json();
    const task=ws.tasks.find((t:any)=>t.run.run_id==='ac144271-6a1f-4828-a802-aa4fd6abbbe7');expect(task.run.state).toBe('failed');expect(task.credit_charge.state).toBe('released');expect(task.credit_charge.quote.billing_policy).toBe('on_delivery');expect(task.artifacts).toHaveLength(2);
    const verified=[];
    for(const a of task.artifacts){const download=await page.request.get(`/api/v1/m4/artifacts/${a.artifact_id}/versions/${a.artifact_version}/bytes`);expect(download.status()).toBe(200);const bytes=await download.body();expect(digest(bytes)).toBe(a.sha256);verified.push({kind:a.kind,bytes:bytes.length,hashMatched:true});}
    await page.goto(`/#generate?topic=${row.topic_id}&run=${task.run.run_id}`);
    await expect(page.getByRole('button',{name:'下载正文 Word',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'下载编制说明',exact:true})).toBeVisible();
    await expect(page.getByText('来源与版本',{exact:true})).toHaveCount(0);await expect(page.locator('.m4-tab-close')).toHaveCount(0);
    writeFileSync(join(evidence,'legacy-files.json'),JSON.stringify({checkedAt:new Date().toISOString(),stateUnchanged:'failed',oldChargeState:'released',modelCalls:0,newExecutions:0,verified,passed:true},null,2));
  }finally{await pool.end();}
});
