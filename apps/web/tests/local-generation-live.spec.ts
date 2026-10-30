import {test,expect} from '@playwright/test';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {login} from './live-helpers';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';

test.skip(process.env.BB_E2E_REAL_MODEL!=='1','Explicit opt-in: calls a real model on the isolated local instance.');
const runtime=fileURLToPath(new URL('../../../../work/local-integration-runtime-20261012/',import.meta.url));
test('real model: browser upload, queued authoring, durable success and both Word downloads',async({page})=>{
 test.setTimeout(1200000);
 expect(process.env.BB_E2E_BASE_URL).toBe('http://localhost:5178');
 const evidence=join(runtime,'evidence');mkdirSync(evidence,{recursive:true});
 await login(page,{username:'integration_user',password:'Local-Test-2026!'});
 await page.goto('/#update');
 await page.getByLabel('发行人全称',{exact:true}).fill('本地真实生成验证有限公司');
 await page.getByLabel('发行市场',{exact:true}).selectOption('szse');
 await page.getByLabel('发行方式',{exact:true}).selectOption('private');
 await page.getByLabel('最新报告期年份',{exact:true}).selectOption('2026');
 await page.getByRole('radio',{name:'6月末',exact:true}).check();
 await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
 await expect(page.getByLabel('募集书新版本文件',{exact:true})).toBeEnabled();
 await page.getByLabel('募集书新版本文件',{exact:true}).setInputFiles({name:'生成链路验证合成原稿.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:makeSyntheticDocxFixture({text:'本地真实生成验证有限公司募集说明书（合成测试稿）。报告期为2025年度。本文件仅用于验证本地生成和下载，不含真实企业、财务数据或发行安排。业务概况、财务信息、发行条款均待人工提供。'})});
 await expect(page.locator('#prospectus-status')).toContainText('尚未采用');
 await page.locator('[data-use-version]').click();
 await page.locator('#confirm-prospectus-selection').click();
 await expect(page.getByLabel('原发行市场',{exact:true})).toBeVisible();
 await page.getByLabel('与目标发行人的关系',{exact:true}).selectOption({label:'同企业'});
 await page.getByLabel('原发行市场',{exact:true}).selectOption('szse');
 await page.getByLabel('原品种',{exact:true}).selectOption('private');
 await page.getByLabel('原稿最新报告期年份',{exact:true}).selectOption('2025');
 await page.getByRole('radio',{name:'年末',exact:true}).check();
 await expect(page.getByText('服务器已确认保存',{exact:false})).toHaveCount(1);
 const note='仅用于本地生成链路验收。本轮范围只对这份合成原稿做最小修订：将报告期由2025年度改为2026年6月末，保留原文的合成测试和资料缺失声明，不扩写完整募集书章节，不虚构财务数据或发行条款。请交付修订版和清洁版Word，各保留一段简短说明即可。';
 await page.getByLabel('补充募集书更新说明',{exact:true}).fill(note);
 await page.getByRole('button',{name:'保存补充说明',exact:true}).click();
 await expect(page.getByText(note,{exact:true})).toBeVisible();
 await expect(page.locator('#save-state')).toHaveText('已保存');
 const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/runs/execute'),{timeout:60000});
 await page.getByRole('button',{name:'开始编制',exact:true}).click();
 const response=await submitted;expect(response.ok()).toBeTruthy();
 const initial=await response.json();
 const proof:any={startedAt:new Date().toISOString(),projectURL:page.url(),runId:initial.run_id,syntheticInput:true,realModel:true,
  imageId:JSON.parse(readFileSync(join(runtime,'linux-worker.json'),'utf8')).imageId};
 writeFileSync(join(runtime,'generation-e2e.json'),JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof));
 let run=initial,last='';
 await expect.poll(async()=>{
  const r=await page.request.get(`/api/v1/runs/${initial.run_id}`);expect(r.ok()).toBeTruthy();run=await r.json();
  if(last!==`${run.state}/${run.stage}`){last=`${run.state}/${run.stage}`;console.log(last);}
  return ['succeeded','failed','cancelled','rejected','paused'].includes(run.state);
 },{timeout:1080000,intervals:[3000,5000,10000]}).toBe(true);
 proof.state=run.state;proof.artifactId=run.artifact_id;writeFileSync(join(runtime,'generation-e2e.json'),JSON.stringify(proof,null,2));
 expect(run.state).toBe('succeeded');expect(run.artifact_id).toBeTruthy();
 await page.goto(`/#/artifacts/${run.artifact_id}`);
 await expect(page.getByRole('button',{name:'下载清洁版',exact:true})).toBeVisible();
 const files=[];
 for(const [label,name] of [['下载修订版','real-generation-tracked.docx'],['下载清洁版','real-generation-clean.docx']]){
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();
  const download=await downloading;const path=join(evidence,name);await download.saveAs(path);
  const data=readFileSync(path);expect(data.subarray(0,2).toString()).toBe('PK');expect(data.length).toBeGreaterThan(1000);
  files.push({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
 }
 await page.screenshot({path:join(evidence,'real-generation-success.png'),fullPage:true});
 Object.assign(proof,{completedAt:new Date().toISOString(),passed:true,files});
 writeFileSync(join(runtime,'generation-e2e.json'),JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof));
});
