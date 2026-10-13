import {test,expect} from '@playwright/test';
import {Pool} from 'pg';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {account,login} from './live-helpers';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {databaseURL,runtime} from '../../../scripts/local-integration/config.mjs';

test.skip(process.env.BB_E2E_LOCAL_INTEGRATION!=='1','Explicit dedicated local environment only.');
test('real material upload and missing-field guidance create no generation task or debit',async({page,playwright})=>{
  test.setTimeout(90000);
  if(process.env.BB_E2E_BASE_URL!=='http://localhost:5178'||new URL(databaseURL).pathname!=='/bb_integration_20261012')throw Error('Dedicated local environment required');
  const user=await account(playwright),pool=new Pool({connectionString:databaseURL});
  const evidence=join(runtime,'evidence/material-input-feedback-20261013');mkdirSync(evidence,{recursive:true});
  const errors:string[]=[],requests:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&/\/(quote|execute)$/.test(new URL(r.url()).pathname))requests.push(new URL(r.url()).pathname);});
  try{
    const owner=(await pool.query('SELECT id FROM bb_users WHERE username=$1',[user.username])).rows[0].id;
    await login(page,user);await page.goto('/#generate?new=synthetic-input-feedback');await page.locator('[data-m4-type][value=legal]').check();
    await page.getByLabel('上传最新版募集说明书',{exact:true}).setInputFiles({name:'合成输入提示募集书.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:makeSyntheticDocxFixture({text:'Synthetic required-input guidance only. No generation or customer data.'})});
    await expect(page.locator('.m4-source-file')).toContainText('合成输入提示募集书.docx');
    await expect(page.locator('#m4-submit-status')).not.toContainText('材料已保存并加入当前草稿');
    await page.getByRole('button',{name:'生成法律意见书',exact:true}).click();
    const feedback=page.getByRole('alert',{name:'需要补充的信息'});
    await expect(feedback).toContainText('尚未选择交易所');await expect(feedback).not.toContainText('错误编号');expect(requests).toEqual([]);
    for(const width of [1440,390]){await page.setViewportSize({width,height:width===1440?960:844});await feedback.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(evidence,`real-missing-${width}.png`)});}
    const topicId=(await pool.query('SELECT id FROM bb_m4_topics WHERE owner_user_id=$1',[owner])).rows[0].id;
    const workspace=await (await page.request.get(`/api/v1/m4/topics/${topicId}/workspace`)).json();
    const csrf=(await page.context().cookies()).find(c=>c.name==='bb_csrf')!.value;
    const rejected=await page.request.post(`/api/v1/m4/topics/${topicId}/quote`,{headers:{'X-BB-CSRF':csrf,origin:'http://localhost:5178'},data:{kind:'document',document_type:'legal',expected_draft_version:workspace.drafts.legal.version}});
    expect(rejected.status()).toBe(422);const problem=await rejected.json();expect(problem.field_errors.map((f:any)=>f.code)).toEqual(['M4_MARKET_REQUIRED']);
    await feedback.getByRole('button',{name:'选择交易所',exact:true}).click();await expect(page.locator('#m4-market')).toBeFocused();
    await page.locator('#m4-market').selectOption('sse');await expect(feedback).toHaveCount(0);
    await page.getByRole('button',{name:'生成法律意见书',exact:true}).click();await expect(page.locator('#m4-submit-status')).toContainText('积分不足');
    expect(requests.filter(p=>p.endsWith('/execute'))).toHaveLength(0);
    await page.reload();await expect(page.locator('#m4-market')).toHaveValue('sse');await expect(page.locator('.m4-source-file')).toContainText('合成输入提示募集书.docx');
    expect((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n).toBe(0);
    expect(errors).toEqual([]);
    writeFileSync(join(evidence,'verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),apiMocked:false,uploaded:true,removedNotice:true,missingFields:problem.field_errors.map((f:any)=>f.field),fieldFocused:true,filledValuePreservedAfterReload:true,newGenerationTasks:0,newCharges:0,modelCalls:0,errors,passed:true},null,2));
  }finally{await pool.end();}
});
