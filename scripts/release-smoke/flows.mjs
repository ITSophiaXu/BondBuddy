import {chromium,expect} from '@playwright/test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {sha256} from './support.mjs';
import {uploadFixture} from './uploads.mjs';
import {assertExecutionBudget} from './budget.mjs';
import {assertFlowBudget,caseDeadline,classifyState,expireCase,assertSubmissionCanStart} from './journey-state.mjs';
import {extendedFlows} from './flows-extended.mjs';
import {CASE_KINDS,isQuotePath,retainSubmissionRequest,retainSubmissionReceipt,acceptedQuote} from './submission.mjs';
import {BILLING_HEADERS,readBillingSnapshot,assertBillingTerminal,assertBillingUnchanged} from './billing.mjs';
import {assertCaseArtifacts} from './artifacts.mjs';
import {requiredArtifacts,assertCaseComplete} from './support.mjs';

import {qaProspectusFixture,confirmQaProspectus} from './qa-prospectus.mjs';
import {retainQaPreparation,qaPreparationURL} from './qa-preparation.mjs';

export async function runJourneys({out,report,privateData,save,inspect,execReadOnly,mapWorkpapers}){
 report.browserInputTransport=process.platform==='win32'?'original bytes, filename and MIME via Playwright buffer':'original file path';save();
 assertExecutionBudget(report.executionBudget);
 assertFlowBudget(report.flowBudget);
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
  return uploadFixture(page,locator,path);
 }
 let activeEntry=null;const pendingQuotes=new Set();
 const observeQuote=response=>{
  const entry=activeEntry;
  if(!entry||response.request().method()!=='POST'||!isQuotePath(entry.id,response.url()))return;
  const pending=(async()=>{
   const body=await response.json();entry.quoteCaptures??=[];
   entry.quoteCaptures.push({url:response.url(),status:response.status(),body,observedAt:new Date().toISOString()});save();
  })().catch(error=>{entry.quoteCaptureError=String(error.message);save();}).finally(()=>pendingQuotes.delete(pending));
  pendingQuotes.add(pending);
 };
 page.on('response',observeQuote);
 async function submit(locator,pathPattern,entry){
  if(!entry)throw Error('Submission requires its durable case record');
  assertSubmissionCanStart(entry);
  if(entry.submissionReceipt){
   if(entry.submissionReceipt.status<200||entry.submissionReceipt.status>=300)throw Error('Prior submission was refused; preserve its evidence');
   return entry.submissionReceipt.body;
  }
  await expect(locator).toBeEnabled({timeout:300000});
  let requestError;
  const observed=request=>{
   if(request.method()==='POST'&&pathPattern.test(new URL(request.url()).pathname)){
    try{retainSubmissionRequest(entry,{url:request.url(),method:request.method(),body:request.postData()},save);}catch(error){requestError=error;}
   }
  };
  page.on('request',observed);
  const receipt=page.waitForResponse(r=>r.request().method()==='POST'&&pathPattern.test(new URL(r.url()).pathname),{timeout:120000});receipt.catch(()=>{});
  try{
   await locator.click();
   for(let i=0;i<220;i++){
    if(requestError)throw requestError;
    const received=await Promise.race([receipt.then(response=>({response})),page.waitForTimeout(500).then(()=>null)]);
    if(received)break;
    const confirm=page.locator('dialog[open]').getByRole('button',{name:/^(确认并开始|确认开始|确认编制|确认并执行|开始执行|确认回填|确认并回答|确认生成\s*\d+\s*份文件)/});
    if(await confirm.count()){await confirm.first().click();break;}
    for(const selector of ['#qa-confirm','#integrity-confirm']){
     if(await page.locator(selector).isVisible()){await page.locator(selector).click();break;}
    }
   }
   const response=await receipt;if(requestError)throw requestError;
   const body=await response.json();
   const result=retainSubmissionReceipt(entry,{url:response.url(),status:response.status(),body},save);
   await Promise.all([...pendingQuotes]);entry.accepted=acceptedQuote(entry);save();return result;
  }finally{page.off('request',observed);}
 }
 async function readJson(url){
  let response=await page.request.get(url,{headers:BILLING_HEADERS});
  if(response.status()===401){await page.reload();await expect(page.getByRole('link',{name:'任务进度与结果',exact:true})).toBeVisible({timeout:60000});response=await page.request.get(url,{headers:BILLING_HEADERS});}
  if(!response.ok())throw Error('Cannot read persisted state: '+response.status());return response.json();
 }
 async function readRun(id,entry){
  const run=await readJson('/api/v1/runs/'+encodeURIComponent(id));entry.runState=run.state;entry.stage=run.stage;
  entry.projectId=run.project_id;entry.inputHash=run.input_hash;entry.inputRevision=run.input_revision;entry.artifactId=run.artifact_id;save();return run;
 }
 async function waitRun(id,entry){
  const run=await readRun(id,entry);
  if(run.state!=='succeeded')throw Error('Run did not succeed: '+run.state+'/'+run.stage);
  return run;
 }
 async function download(button,name,entry){
  await expect(button).toBeVisible({timeout:60000});
  const downloading=page.waitForEvent('download',{timeout:name==='workpaper.zip'?20*60000:120000});downloading.catch(()=>{});await button.click();
  const item=await downloading;if(await item.failure())throw Error('Download failed: '+await item.failure());
  entry.downloads??=[];
  const path=join(entry.evidenceDirectory,String(entry.downloads.length+1).padStart(3,'0')+'-'+name);
  await item.saveAs(path);const bytes=readFileSync(path);
  entry.downloads.push({role:name,filename:item.suggestedFilename(),path,bytes:bytes.length,sha256:sha256(bytes),observedAt:new Date().toISOString()});save();
  return entry.downloads.at(-1);
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
    const run=await submit(page.getByRole('button',{name:'开始更新',exact:true}),/\/runs\/execute$/,entry);
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
    const run=await submit(page.getByRole('button',{name:'开始复核',exact:true}),/\/review-executions$/,entry);entry.runId=run.run_id;save();
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
    const run=await submit(page.locator('#qa-start'),/\/qa\/runs$/,entry);entry.runId=run.run_id;save();
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
 Object.assign(flows,extendedFlows({page,fixtures:f,report,save,upload,submit,readJson,waitRun,download,mapWorkpapers}));
 async function snapshot(entry,stage){
  const value=await readBillingSnapshot({page,ownerId:report.ownerId,runIds:entry.runId?[entry.runId]:[],workpaperBatchId:entry.workpaperBatchId??null,stage,execReadOnly});
  entry.billingSnapshots??=[];entry.billingSnapshots.push(value);save();return value;
 }
 async function attempt(entry,phase,action){
  entry.attempt=(entry.attempt??0)+1;
  const path=join(out,entry.id,'attempt-'+entry.attempt+'-'+phase);mkdirSync(path,{recursive:true,mode:0o700});entry.evidenceDirectory=path;
  const record={attempt:entry.attempt,phase,startedAt:new Date().toISOString(),evidenceDirectory:path};
  entry.attemptHistory??=[];entry.attemptHistory.push(record);entry.startedAt??=record.startedAt;save();
  await context.tracing.start({screenshots:true,snapshots:true,sources:false});
  try{await action();record.status='passed';}
  catch(error){record.status='failed';record.error=String(error.message);entry.status='failed';entry.error=record.error;console.error(entry.id,entry.error);writeFileSync(join(path,'page.txt'),await page.locator('body').innerText().catch(()=>''),{mode:0o600});throw error;}
  finally{record.finishedAt=new Date().toISOString();await page.screenshot({path:join(path,'page.png'),fullPage:true}).catch(()=>{});await context.tracing.stop({path:join(path,'trace.zip')});save();}
 }
 try{
  await login();const me=await readJson('/api/v1/me');
  if(!me.user_id||(report.ownerId&&report.ownerId!==me.user_id))throw Error('Release test account identity changed');report.ownerId=me.user_id;save();
  for(const entry of report.cases){
   activeEntry=entry;
   if(entry.status==='passed'){
    assertCaseComplete(entry);
    entry.artifactEvidence=await assertCaseArtifacts(entry,{required:requiredArtifacts(entry.id),inspect});save();continue;
   }
   if(expireCase(report,entry)){save();throw Error(entry.error);}
   assertSubmissionCanStart(entry);save();
   if(!entry.billingBefore){
    if(entry.submissionRequest||entry.runId||entry.workpaperBatchId)throw Error('Accepted task is missing its pre-submission billing snapshot');
    entry.billingBefore=await snapshot(entry,'before');save();
   }
   await attempt(entry,'submit',async()=>{
    await flows[entry.id](entry,'submit');
    entry.accepted=acceptedQuote(entry);entry.submittedAt??=new Date().toISOString();entry.status='submitted';
    entry.billingAccepted=await snapshot(entry,'accepted');save();
   });
   let lastPrinted=0;
   while(true){
    if(expireCase(report,entry)){save();throw Error(entry.error);}
    const state=flows[entry.id].readState?await flows[entry.id].readState(entry):await readRun(entry.runId,entry);
    if(entry.workpaperBatchId)entry.batchState=state.state;
    const category=classifyState(state.state,{batch:!!entry.workpaperBatchId});save();
    if(category==='ready')break;
    if(category!=='waiting')throw Error('Original task requires attention or failed: '+state.state+'/'+(state.stage??''));
    if(Date.now()-lastPrinted>=60000){lastPrinted=Date.now();console.log(entry.id+': '+state.state+'/'+(state.stage??''));}
    await page.waitForTimeout(5000);
   }
   await attempt(entry,'check',async()=>{
    await flows[entry.id](entry,'check');
    entry.billingTerminal=await snapshot(entry,'terminal');
    entry.billingEvidence=assertBillingTerminal({before:entry.billingBefore,terminal:entry.billingTerminal,accepted:entry.accepted,kind:CASE_KINDS[entry.id],expectedItemIds:entry.expectedItemIds??[],integrityVerifiedPairs:entry.integrityVerifiedPairs});save();
    const identity=JSON.stringify([entry.runId??null,entry.workpaperBatchId??null]);
    await page.reload();await flows[entry.id](entry,'check');
    if(identity!==JSON.stringify([entry.runId??null,entry.workpaperBatchId??null]))throw Error('Refresh changed accepted task identity');
    entry.artifactEvidence=await assertCaseArtifacts(entry,{required:requiredArtifacts(entry.id),inspect});
    const after=await snapshot(entry,'refresh-download');
    entry.refreshEvidence={status:'passed',sameTask:true,downloads:entry.downloads.map(({role,sha256,bytes})=>({role,sha256,bytes})),billing:assertBillingUnchanged({before:entry.billingTerminal,after})};
    entry.status='passed';assertCaseComplete(entry);entry.finishedAt=new Date().toISOString();delete entry.error;save();console.log(entry.id,'passed');
   });
  }
 }finally{await Promise.all([...pendingQuotes]);page.off('response',observeQuote);await context.close();await browser.close();}
}
