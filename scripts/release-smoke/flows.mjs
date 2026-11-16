import {chromium,expect} from '@playwright/test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {sha256} from './support.mjs';
import {qaProspectusFixture,confirmQaProspectus} from './qa-prospectus.mjs';
import {retainQaPreparation,qaPreparationURL} from './qa-preparation.mjs';

export async function runJourneys({out,report,privateData,save}){
 const browser=await chromium.launch(process.env.BB_RELEASE_BROWSER_CHANNEL?{channel:process.env.BB_RELEASE_BROWSER_CHANNEL}:{});
 const context=await browser.newContext({baseURL:report.baseURL,viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await context.newPage();page.setDefaultTimeout(45000);
 const {fixtures:f,account}=privateData;
 async function login(){
  await page.goto('/');await page.getByLabel('用户名',{exact:true}).fill(account.username);await page.getByLabel('密码',{exact:true}).fill(account.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('link',{name:'任务进度与结果',exact:true})).toBeVisible();
 }
 async function upload(locator,path){
  await expect(locator).toBeEnabled();
  const saved=page.waitForResponse(r=>r.request().method()==='POST'&&/\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname),{timeout:180000});
  saved.catch(()=>{});
  await locator.setInputFiles(path);const receipt=await saved;
  if(!receipt.ok())throw Error('Upload failed: '+receipt.status()+' '+basename(path));
  return receipt.json();
 }
 async function submit(locator,pathPattern){
  await expect(locator).toBeEnabled({timeout:300000});
  const receipt=page.waitForResponse(r=>r.request().method()==='POST'&&pathPattern.test(new URL(r.url()).pathname),{timeout:120000});
  receipt.catch(()=>{});
  await locator.click();
  // Existing product confirmation dialogs are part of the user journey.
  for(let i=0;i<220;i++){
   const received=await Promise.race([receipt.then(response=>({response})),page.waitForTimeout(500).then(()=>null)]);
   if(received){const r=received.response;if(!r.ok())throw Error('Task submission failed: '+r.status()+' '+(await r.text()).slice(0,600));return r.json();}
   const confirm=page.locator('dialog[open]').getByRole('button',{name:/^(确认并开始|确认开始|确认编制|确认并执行|开始执行|确认回填|确认并回答)/});
   if(await confirm.count()){await confirm.first().click();break;}
   if(await page.locator('#qa-confirm').isVisible()){await page.locator('#qa-confirm').click();break;}
  }
  const r=await receipt;if(!r.ok())throw Error('Task submission failed: '+r.status()+' '+(await r.text()).slice(0,600));return r.json();
 }
 async function readRun(id,entry){
  let response=await page.request.get('/api/v1/runs/'+encodeURIComponent(id));
  if(response.status()===401){
   // Restore through the real app, never by patching cookies or resubmitting work.
   await page.reload();await expect(page.getByRole('link',{name:'任务进度与结果',exact:true})).toBeVisible({timeout:60000});
   response=await page.request.get('/api/v1/runs/'+encodeURIComponent(id));
  }
  if(!response.ok())throw Error('Cannot read submitted run: '+response.status());
  const run=await response.json();entry.runState=run.state;entry.stage=run.stage;
  entry.projectId=run.project_id;entry.inputHash=run.input_hash;entry.inputRevision=run.input_revision;entry.artifactId=run.artifact_id;save();return run;
 }
 async function waitRun(id,entry){
  const run=await readRun(id,entry);
  if(run.state!=='succeeded')throw Error('Run did not succeed: '+run.state+'/'+run.stage);
  return run;
 }
 async function download(button,name,entry){
  await expect(button).toBeVisible({timeout:60000});const downloading=page.waitForEvent('download',{timeout:120000});downloading.catch(()=>{});await button.click();
  const item=await downloading;if(await item.failure())throw Error('Download failed');
  const path=join(entry.evidenceDirectory,name);await item.saveAs(path);const bytes=readFileSync(path);
  if(bytes.length<1000||bytes.subarray(0,2).toString()!=='PK')throw Error('Download is not a nonempty Word file');
  entry.downloads??=[];entry.downloads.push({filename:item.suggestedFilename(),path,bytes:bytes.length,sha256:sha256(bytes)});save();
 }
 const flows={
  'update-rq-202509':async (entry,phase)=>{
   if(!entry.runId){
    await page.goto('/#/new');await page.getByLabel('发行人全称',{exact:true}).fill('任丘市建设投资集团有限公司');
    await page.getByLabel('发行市场',{exact:true}).selectOption('sse');await page.getByLabel('发行方式',{exact:true}).selectOption('private');
    await page.getByLabel('最新报告期年份',{exact:true}).selectOption('2025');await page.getByRole('radio',{name:'9月末',exact:true}).check();
    await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
    await upload(page.getByLabel('募集书新版本文件',{exact:true}),f.rq.find(x=>x.role==='historical').path);
    await expect(page.getByLabel('与目标发行人的关系',{exact:true})).toBeVisible();
    await page.getByLabel('与目标发行人的关系',{exact:true}).selectOption({label:'同企业'});
    await page.getByLabel('原发行市场',{exact:true}).selectOption('sse');await page.getByLabel('原品种',{exact:true}).selectOption('private');
    await page.getByLabel('原稿最新报告期年份',{exact:true}).selectOption('2025');await page.getByRole('radiogroup',{name:'原稿最新报告期期末',exact:true}).getByRole('radio',{name:'6月末',exact:true}).check();
    for(const file of f.rq.filter(x=>x.role!=='historical')){
     // The current UI has one financial-material picker; legacy role-specific
     // pickers no longer exist. Exercise that real unified upload control.
     await upload(page.locator('#upload-audit'),file.path);
    }
    await expect(page.getByText('服务器已确认保存',{exact:false})).toHaveCount(3,{timeout:60000});
    await expect(page.locator('#save-state')).toHaveText('已保存',{timeout:60000});
    entry.projectURL=page.url();save();await page.reload();
    await expect(page.getByLabel('原稿最新报告期年份',{exact:true})).toHaveValue('2025');
    const run=await submit(page.getByRole('button',{name:'开始更新',exact:true}),/\/runs\/execute$/);
    entry.runId=run.run_id;save();
   }
   if(phase==='submit')return;
   const run=await waitRun(entry.runId,entry);if(!run.artifact_id)throw Error('Successful update has no artifact');
   // Re-enter the actual project and its embedded result, rather than bypassing
   // a broken result handoff with an artifact URL obtained from the API.
   await page.goto(entry.projectURL);await page.reload();
   await download(page.locator('#execution-delivery').getByRole('button',{name:'下载修订版',exact:true}),'tracked.docx',entry);
   await download(page.locator('#execution-delivery').getByRole('button',{name:'下载清洁版',exact:true}),'clean.docx',entry);
  },
  'review-dongying':async (entry,phase)=>{
   if(!entry.runId){
    await page.goto('/#review?new=1');await page.locator('#issuer').fill('东营市城市建设发展集团有限公司');
    await page.locator('#market').selectOption('sse');await page.locator('#offering').selectOption('private');
    await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
    await upload(page.locator('[data-review-upload-role=historical]'),f.dongying);
    await expect(page.getByRole('button',{name:'删除 '+basename(f.dongying),exact:true})).toBeEnabled();
    for(const path of f.financial){await upload(page.locator('[data-review-upload-role=audit]'),path);await expect(page.getByRole('button',{name:'删除 '+basename(path),exact:true})).toBeEnabled();}
    entry.projectURL=page.url();save();await page.reload();
    const run=await submit(page.getByRole('button',{name:'开始复核',exact:true}),/\/review-executions$/);entry.runId=run.run_id;save();
   }
   if(phase==='submit')return;
   await waitRun(entry.runId,entry);await page.goto(entry.projectURL);
   await page.locator('[data-review-tab="results"]').first().click();await page.reload();
   await download(page.getByRole('button',{name:/^下载复核报告(?:（Word）)?$/}),'review.docx',entry);
  },
  'qa-dongying':async (entry,phase)=>{
   if(!entry.projectURL){
    await page.goto('/#qa');await page.locator('#project-entry-new').click();const modal=page.locator('dialog[open]').filter({has:page.getByRole('heading',{name:'新建项目',exact:true})});
    await modal.getByLabel('项目名称',{exact:true}).fill('发布前测试-东营问答');await modal.getByLabel('发行人全称',{exact:true}).fill('东营市城市建设发展集团有限公司');
    await modal.locator('select[name="market"]').selectOption('sse');await modal.locator('select[name="offering"]').selectOption('private');
    await modal.getByRole('button',{name:'创建项目并开始问答',exact:true}).click();await expect(page.locator('#qa-manage-prospectus')).toBeVisible();
    entry.projectURL=page.url();save();
   }else await page.goto(entry.preparationId&&!entry.runId?qaPreparationURL(entry.projectURL,entry.preparationId):entry.projectURL);
   if(!entry.runId){
    if(!entry.prepared){
     await expect(page.locator('#qa-manage-prospectus')).toBeVisible();
     if(!(await page.locator('.qa-project-materials').innerText()).includes('募集说明书已就绪')){
     await page.locator('#qa-manage-prospectus').click();await upload(page.getByLabel('募集书新版本文件',{exact:true}),f.dongying);
     }
     entry.qaProspectus=await confirmQaProspectus(page,{projectURL:entry.projectURL,expected:qaProspectusFixture(f.dongying)});save();
     await retainQaPreparation(page,{entry,expected:qaProspectusFixture(f.questions),upload:()=>upload(page.locator('#qa-upload'),f.questions),save});
     await expect(page.locator('.qa-question-list article')).toHaveCount(7,{timeout:180000});entry.prepared=true;save();
    }
    await page.reload();await expect(page.locator('.qa-question-list article')).toHaveCount(7,{timeout:60000});
    await page.locator('#qa-save').click();
    entry.qaProspectus=await confirmQaProspectus(page,{projectURL:entry.projectURL,expected:qaProspectusFixture(f.dongying),round:true,previous:entry.qaProspectus});save();
    const run=await submit(page.locator('#qa-start'),/\/qa\/runs$/);entry.runId=run.run_id;save();
   }
   if(phase==='submit')return;
   await waitRun(entry.runId,entry);
   await page.goto(entry.projectURL+'&run='+encodeURIComponent(entry.runId));await page.reload();
   await expect(page.locator('[data-qa-answer-question]')).toHaveCount(7,{timeout:60000});
   for(const answer of await page.locator('[data-qa-answer-question]').all()){
    if(await answer.getAttribute('open')===null)await answer.locator('summary').click();
    await expect(answer).toHaveAttribute('open','');
    const text=await answer.locator('.qa-answer-body').innerText();
    const missing=(await answer.locator('.qa-warning').allTextContents()).join('\n');
    expect(text.trim()||missing.trim(),'Each question needs an answer or a specific material gap').not.toBe('');
   }
   await download(page.locator('#qa-download'),'answers.docx',entry);
  }
 };
 async function attempt(entry,phase){
  entry.attempt=(entry.attempt??0)+1;
  const path=join(out,entry.id,'attempt-'+entry.attempt+'-'+phase);mkdirSync(path,{recursive:true,mode:0o700});entry.evidenceDirectory=path;
  entry.status='running';entry.startedAt??=new Date().toISOString();delete entry.error;save();
  await context.tracing.start({screenshots:true,snapshots:true,sources:false});
  try{await flows[entry.id](entry,phase);entry.status=phase==='submit'?'submitted':'passed';if(phase==='submit')entry.submittedAt??=new Date().toISOString();console.log(entry.id,entry.status);}
  catch(error){entry.status='failed';entry.error=String(error.message);console.error(entry.id,entry.error);writeFileSync(join(path,'page.txt'),await page.locator('body').innerText().catch(()=>''),{mode:0o600});}
  finally{entry.finishedAt=new Date().toISOString();await page.screenshot({path:join(path,'page.png'),fullPage:true}).catch(()=>{});await context.tracing.stop({path:join(path,'trace.zip')});save();}
 }
 try{
  await login();
  for(const entry of report.cases)if(entry.status!=='passed')await attempt(entry,'submit');
  const started=Date.now(),deadline=started+65*60000;let lastPrinted=0;
  while(report.cases.some(c=>c.status==='submitted')){
   if(Date.now()>deadline){for(const c of report.cases.filter(c=>c.status==='submitted')){c.status='failed';c.error='Waiting exceeded 65 minutes; original task retained, not resubmitted';}save();break;}
   for(const entry of report.cases.filter(c=>c.status==='submitted')){
    const run=await readRun(entry.runId,entry);
    if(!['queued','running'].includes(run.state))await attempt(entry,'check');
   }
   if(Date.now()-lastPrinted>=60000){lastPrinted=Date.now();console.log(report.cases.map(c=>c.id+': '+c.status+(c.status==='submitted'?' / '+c.runState+'/'+c.stage:'')).join(' | '));}
   if(report.cases.some(c=>c.status==='submitted'))await page.waitForTimeout(5000);
  }
 }finally{await context.close();await browser.close();}
}
