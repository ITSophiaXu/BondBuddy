import {chromium,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {basename,join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,databaseURL,instance,repo,runtime} from './config.mjs';

if(instance!=='direct-20261125')throw Error('Use only the isolated direct DOCX instance');
const caseId=process.env.BB_LOCAL_RQ_CASE??'rq-202509';
const existingProjectId=process.env.BB_LOCAL_RQ_PROJECT_ID??'';
if(existingProjectId&&!/^[0-9a-f-]{36}$/.test(existingProjectId))throw Error('Invalid local project ID');
if(!['rq-202506','rq-202509'].includes(caseId))throw Error('Unknown authorized Renqiu sample');
const manifest=JSON.parse(readFileSync(join(repo,'tests/samples/2026-09-25/manifest.json'),'utf8'));
const sample=manifest.cases.find(item=>item.case_id===caseId);
if(!sample)throw Error('Sample manifest missing');
const files=sample.files.map(item=>{
  const path=join(repo,'tests/samples/2026-09-25',item.path);
  const hash=createHash('sha256').update(readFileSync(path)).digest('hex');
  if(hash!==item.sha256)throw Error('Sample hash mismatch: '+item.file_id);
  return {...item,path};
});
const account=JSON.parse(readFileSync(join(runtime,'test-accounts.json'),'utf8')).accounts.find(item=>item.username==='integration_user');
if(!account)throw Error('Local account missing');
const evidencePath=join(runtime,`direct-${caseId}-acceptance.json`);
const evidence={caseId,baseURL,model:'gpt-6-sol',provider:'copilot_enterprise',sampleHashes:files.map(item=>({id:item.file_id,sha256:item.sha256})),startedAt:new Date().toISOString()};
const save=()=>{mkdirSync(runtime,{recursive:true});writeFileSync(evidencePath,JSON.stringify(evidence,null,2));};
const browser=await chromium.launch();
const context=await browser.newContext({baseURL,viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage();page.setDefaultTimeout(45000);
async function upload(locator,path){
  await expect(locator).toBeEnabled();
  const saved=page.waitForResponse(r=>r.request().method()==='POST'&&/\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname),{timeout:180000});
  await locator.setInputFiles(path);
  const response=await saved;
  if(!response.ok())throw Error(`Upload failed: ${response.status()} ${basename(path)} ${(await response.text()).slice(0,200)}`);
}
async function submit(){
  const button=page.getByRole('button',{name:'开始更新',exact:true});
  await expect(button).toBeEnabled({timeout:300000});
  const receipt=page.waitForResponse(r=>r.request().method()==='POST'&&/\/runs\/execute$/.test(new URL(r.url()).pathname),{timeout:120000});
  await button.click();
  for(let i=0;i<220;i++){
    const received=await Promise.race([receipt.then(response=>({response})),page.waitForTimeout(500).then(()=>null)]);
    if(received){if(!received.response.ok())throw Error(`Submission failed: ${received.response.status()} ${(await received.response.text()).slice(0,500)}`);return received.response.json();}
    const confirm=page.locator('dialog[open]').getByRole('button',{name:/^(确认并开始|确认开始|确认编制|确认并执行|开始执行)/});
    if(await confirm.count()){await confirm.first().click();break;}
  }
  const response=await receipt;
  if(!response.ok())throw Error(`Submission failed: ${response.status()} ${(await response.text()).slice(0,500)}`);
  return response.json();
}
try{
  await page.goto('/');
  await page.getByLabel('用户名',{exact:true}).fill(account.username);
  await page.getByLabel('密码',{exact:true}).fill(account.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('link',{name:'任务进度与结果',exact:true})).toBeVisible();
  const original=files.find(item=>item.upload_role==='historical');
  if(!original)throw Error('Historical DOCX missing');
  if(existingProjectId){
    await page.goto(`/#/projects/${existingProjectId}`);
    const resume=page.getByRole('button',{name:'确认原上传'});
    if(await resume.count())await resume.first().click();
  }else{
    await page.goto('/#/new');
    await page.getByLabel('发行人全称',{exact:true}).fill('任丘市建设投资集团有限公司');
    await page.getByLabel('发行市场',{exact:true}).selectOption('sse');
    await page.getByLabel('发行方式',{exact:true}).selectOption('private');
    await page.getByLabel('最新报告期年份',{exact:true}).selectOption('2025');
    await page.getByRole('radio',{name:caseId==='rq-202509'?'9月末':'6月末',exact:true}).check();
    await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
    await upload(page.getByLabel('募集书新版本文件',{exact:true}),original.path);
  }
  await expect(page.getByLabel('与目标发行人的关系',{exact:true})).toBeVisible({timeout:120000});
  await page.getByLabel('与目标发行人的关系',{exact:true}).selectOption({label:'同企业'});
  await page.getByLabel('原发行市场',{exact:true}).selectOption('sse');
  await page.getByLabel('原品种',{exact:true}).selectOption('private');
  await page.getByLabel('原稿最新报告期年份',{exact:true}).selectOption(caseId==='rq-202509'?'2025':'2024');
  await page.getByRole('radiogroup',{name:'原稿最新报告期期末',exact:true}).getByRole('radio',{name:caseId==='rq-202509'?'6月末':'9月末',exact:true}).check();
  await page.locator('[data-format-template]').first().click();
  await expect(page.locator('[data-format-template-details]')).toContainText('格式模板');
  for(const item of files.filter(item=>item.upload_role!=='historical'))await upload(page.locator('#upload-audit'),item.path);
  await expect(page.locator('#save-state')).toHaveText('已保存',{timeout:120000});
  evidence.projectURL=page.url();save();
  const response=await submit();
  evidence.runId=response.run_id;
  const pool=new Pool({connectionString:databaseURL});
  try{
    const row=(await pool.query(`SELECT j.job_type,i.manifest#>>'{authoring,format_policy,version}' AS policy,
      i.manifest#>>'{authoring,direct_rule_list_version}' AS rule_list_version
      FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id JOIN bb_input_revisions i
      ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision WHERE r.id=$1`,[evidence.runId])).rows[0];
    evidence.jobType=row?.job_type;evidence.policy=row?.policy;evidence.ruleListVersion=row?.rule_list_version;
    if(row?.job_type!=='update_direct'||row?.policy!=='direct-docx-v1')throw Error('Direct DOCX policy was not admitted');
  }finally{await pool.end();}
  evidence.submittedAt=new Date().toISOString();save();
  console.log(JSON.stringify({runId:evidence.runId,jobType:evidence.jobType,policy:evidence.policy,evidencePath}));
}catch(error){
  evidence.error=String(error?.stack??error);evidence.failedAt=new Date().toISOString();save();
  await page.screenshot({path:join(runtime,`direct-${caseId}-failure.png`),fullPage:true}).catch(()=>{});
  throw error;
}finally{await browser.close();}
