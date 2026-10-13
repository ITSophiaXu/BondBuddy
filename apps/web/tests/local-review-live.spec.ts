import {test,expect} from '@playwright/test';
import {Pool} from 'pg';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {account,login} from './live-helpers';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {grantCredits} from '../../api/dist/billing.js';
import {transaction} from '../../api/dist/data.js';
import {databaseURL,runtime} from '../../../scripts/local-integration/config.mjs';

test.skip(process.env.BB_E2E_LOCAL_INTEGRATION!=='1','Explicit local-only real API/worker/ledger regression.');
test('real local review starts directly, debits one point and pauses before model execution',async({page,playwright})=>{
  test.setTimeout(120000);
  if(process.env.BB_E2E_BASE_URL!=='http://localhost:5178'||new URL(databaseURL).pathname!=='/bb_integration_20261012')throw Error('Dedicated local environment required');
  const user=await account(playwright),pool=new Pool({connectionString:databaseURL}),evidence=join(runtime,'evidence/review-live-20261013');mkdirSync(evidence,{recursive:true});
  try{
    const owner=(await pool.query('SELECT id FROM bb_users WHERE username=$1',[user.username])).rows[0].id;
    await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:'review-one-point-'+owner,points:1,expiresAt:null,actor:'local-synthetic-test',reason:'One-point exhaustion, no model call'}));
    await login(page,user);await page.goto('/#review');
    await page.locator('#issuer').fill('动态复核合成验收有限公司');await page.locator('#market').selectOption('szse');await page.locator('#offering').selectOption('private');
    await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
    await page.locator('[data-review-upload-role=historical]').setInputFiles({name:'合成动态复核.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:makeSyntheticDocxFixture({text:'Synthetic review flow only, no customer data.'})});
    await expect(page.getByRole('button',{name:'删除 合成动态复核.docx',exact:true})).toBeEnabled();
    await page.getByLabel('补充复核要求（选填）',{exact:true}).fill('合成流程验收：一积分在输入保存后暂停，不进入模型。');
    const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&/\/review-executions$/.test(new URL(r.url()).pathname));
    await page.getByRole('button',{name:'开始复核',exact:true}).click();const response=await submitted;expect(response.status()).toBe(200);const run=await response.json();
    await expect(page.getByRole('dialog',{name:'确认本次执行范围'})).toHaveCount(0);
    await expect(page.getByRole('dialog',{name:'积分已用完'})).toBeVisible({timeout:60000});await page.getByRole('dialog').getByRole('button',{name:'返回',exact:true}).click();
    await expect(page.locator('.authoring-credit-meter')).toContainText('1 积分');await expect(page.locator('.authoring-credit-meter')).toContainText('可用余额 0 积分');
    await expect(page.locator('#review-making-panel')).toContainText('积分已用完，复核已暂停',{timeout:30000});
    await page.reload();await expect(page.locator('#review-making-panel')).toContainText('积分已用完，复核已暂停');
    if(await page.getByRole('dialog',{name:'积分已用完'}).isVisible())await page.getByRole('dialog').getByRole('button',{name:'返回',exact:true}).click();
    for(const width of [1440,390]){await page.setViewportSize({width,height:width===1440?960:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(evidence,`real-exhausted-${width}.png`),fullPage:true});}
    await expect(page.getByRole('region',{name:'复核过程'})).toContainText('准备本次材料');
    const stored=(await pool.query('SELECT r.state,c.billing_policy,c.charged_points,j.checkpoint FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id JOIN bb_credit_reservations c ON c.id=r.reservation_id WHERE r.id=$1 AND r.owner_user_id=$2',[run.run_id,owner])).rows[0];
    expect(stored.state).toBe('paused');expect(stored.billing_policy).toBe('authoring_balance_v2');expect(Number(stored.charged_points)).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1',[run.run_id])).rows[0].n).toBe(0);
    await page.getByRole('button',{name:'结束本次复核',exact:true}).click();await expect(page.locator('#review-making-panel')).toContainText('本轮已停止');
    const history=await page.request.get('/api/v1/runs/'+run.run_id+'/credit-charge');expect(history.status()).toBe(200);expect((await history.json()).progress.charged_points).toBe(1);
    writeFileSync(join(evidence,'verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),apiMocked:false,workerImage:'sha256:e6fe1694717c7b8e415e59293dcebc38ac10f32e62373562cbdcef09ac9713db',runId:run.run_id,projectURL:page.url(),directStart:true,chargedPoints:1,modelCalls:0,checkpointSaved:!!stored.checkpoint,preservedAfterReload:true,endedSyntheticRun:true,passed:true},null,2));
  }finally{await pool.end();}
});
