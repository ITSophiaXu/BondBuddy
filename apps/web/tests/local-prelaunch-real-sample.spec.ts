import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test,expect,billingApi,billingLedger,topupUI,integer} from './local-prelaunch-billing-helpers';
import {downloadedHash,openProject} from './local-prelaunch-helpers';
import type {Page} from '@playwright/test';

const repo=fileURLToPath(new URL('../../..',import.meta.url));
const sourceRoot=join(repo,'tests/samples/2026-09-25');
const evidenceRoot=resolve(repo,'../quality-prelaunch-20261107');
// Artifact reading/checks use the bundled runtime; product execution remains in the Linux worker image.
const bundledPython=process.env.BB_PRELAUNCH_QUALITY_PYTHON??'C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1'||process.env.BB_E2E_RQ_REAL_SAMPLE!=='1',
  'Explicit owned local stack, authorized RQ files, and shared real-model window required.');
test.setTimeout(7200000);
test.use({viewport:{width:1440,height:1000}});
test.beforeAll(()=>{
  if(!process.env.BB_PRELAUNCH_EVIDENCE_ROOT||resolve(process.env.BB_PRELAUNCH_EVIDENCE_ROOT)!==join(evidenceRoot,'billing-evidence'))
    throw Error('Run this real-sample spec alone with BB_PRELAUNCH_EVIDENCE_ROOT set to the external quality-prelaunch-20261107/billing-evidence directory.');
});

function sources(){
  const manifest=JSON.parse(readFileSync(join(sourceRoot,'manifest.json'),'utf8'));
  const selected=manifest.cases.find((entry:any)=>(entry.case_id??entry.id)==='rq-202509');
  if(!selected||selected.files.length!==3)throw Error('Exactly the three authorized RQ Q3 inputs are required.');
  return selected.files.map((entry:any)=>{
    const path=resolve(sourceRoot,entry.path),bytes=readFileSync(path);
    if(!path.startsWith(resolve(sourceRoot,'rq-202509')+'/')&&!path.startsWith(resolve(sourceRoot,'rq-202509')+'\\'))throw Error('Unauthorized input path');
    expect(bytes.length).toBe(entry.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    return {...entry,absolutePath:path};
  });
}

async function upload(page:Page,projectId:string,source:any,label:string){
  await expect(page.getByLabel(label,{exact:true})).toBeEnabled();
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith(`/api/v1/projects/${projectId}/materials/uploads/`)
    &&r.url().endsWith('/complete')&&r.request().method()==='POST',{timeout:180000});
  await page.getByLabel(label,{exact:true}).setInputFiles(source.absolutePath);
  const response=await pending;expect(response.status(),await response.text()).toBe(200);const material=await response.json();
  expect(await downloadedHash(page,projectId,material.material_id)).toEqual({status:200,bytes:source.bytes,sha256:source.sha256});
  return material;
}

test('authorized RQ Q3 full prospectus uses actual queue and model then preserves chapters, financial scope and dual Word semantics',async({page,billing})=>{
  const original=sources(),directory=join(evidenceRoot,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  mkdirSync(directory,{recursive:true});
  const provenance={schema:'local-prelaunch-real-sample-v1',case:'rq-202509',realCustomerInputs:true,syntheticAccounts:true,
    syntheticPaymentChannel:true,httpMocked:false,taskResultsFabricated:false,industrySignoff:false,financialFactApproval:false,
    sourceHashes:original.map((s:any)=>({file_id:s.file_id,sha256:s.sha256,bytes:s.bytes})),sourceCutoff:'2025-06-30',targetCutoff:'2025-09-30',
    outputDirectory:directory,owner:billing.owner,username:billing.username};
  writeFileSync(join(directory,'provenance.json'),JSON.stringify(provenance,null,2));billing.record('real-customer-input-provenance',provenance);
  const baseline=execFileSync(bundledPython,[join(repo,'scripts/local-quality/rq_q3_baseline.py'),'--output-dir',directory],
    {cwd:repo,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'},timeout:120000});
  billing.record('independent-original-baseline-summary',JSON.parse(baseline.trim()));

  await page.goto('/#/new');
  await page.getByLabel('发行人全称',{exact:true}).fill('任丘市建设投资集团有限公司');
  await page.getByLabel('发行市场',{exact:true}).selectOption('sse');
  await page.getByLabel('发行方式',{exact:true}).selectOption('private');
  await page.getByLabel('最新报告期年份',{exact:true}).selectOption('2025');
  await page.locator('[name="reporting_quarter"][value="09-30"]').check();
  const creation=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/projects'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
  const created=await creation;expect(created.status(),await created.text()).toBe(201);const project=await created.json();
  billing.record('real-browser-project-created',{request:created.request().postDataJSON(),project});
  await openProject(page,project.project_id);
  const historical=original.find((s:any)=>s.file_id==='rq-202509-01'),financial=original.find((s:any)=>s.file_id==='rq-202509-02'),notes=original.find((s:any)=>s.file_id==='rq-202509-03');
  const source=await upload(page,project.project_id,historical,'募集书新版本文件');
  const sourceFields=page.locator(`[data-source-material="${source.material_id}"]`);
  await sourceFields.locator('[data-source-field="relation"]').selectOption('same_issuer');
  await sourceFields.locator('[data-source-field="market"]').selectOption('sse');
  await sourceFields.locator('[data-source-field="offering"]').selectOption('private');
  await sourceFields.locator('[data-source-field="year"]').selectOption('2025');
  await sourceFields.locator('[data-source-field="quarter"][value="06-30"]').check();
  await expect(sourceFields.locator('[data-source-required-message]')).toHaveText('原稿信息已填写完整。');
  await expect(page.locator('#save-state')).toHaveText('已保存');
  // The current unified financial picker accepts statements and notes together;
  // do not inject the retired interimFinancial/notes roles through a private API.
  const main=await upload(page,project.project_id,financial,'为审计报告（可含报表及附注）选择文件');
  const note=await upload(page,project.project_id,notes,'为审计报告（可含报表及附注）选择文件');
  expect(main.role).toBe('audit');expect(note.role).toBe('audit');
  const instruction='请将本企业原募集书全文更新至2025年9月30日，完整报告期为2023、2024年度及2025年1—9月。用最近一期财务报表与附注核对新增期间，区分合并与母公司、期末与年初、累计与上年同期。以财务主表的可见报表表头识别本期，隐藏辅助页的旧期间材料不作为本期数据。保留全文章节、发行安排和原稿格式，发行人、市场与品种不变。局部缺失或存疑内容明确标注待人工确认，交付修订版和清洁版。';
  await page.getByLabel('补充募集书更新说明',{exact:true}).fill(instruction);
  await page.getByLabel('补充募集书更新说明',{exact:true}).blur();
  await expect(page.locator('#conversation-status')).toContainText(/已自动保存|已保存/);
  await page.screenshot({path:join(directory,'materials-prepared.png'),fullPage:true});
  billing.record('three-authorized-originals-saved-through-browser',{source,main,note,instruction});
  const prepared=billing.checkpoint('free-material-preparation-has-no-task-or-charge');expect(prepared.runs).toEqual([]);expect(prepared.events).toEqual([]);expect(prepared.modelCalls).toEqual([]);

  const payment=await topupUI(page,'10000');
  await page.locator('#delivery').selectOption('callback');await page.locator('#simulate-paid').click();
  await expect(page.locator('#checkout-title')).toHaveText('积分已到账');
  await page.locator('#return-paid').click();
  billing.record('synthetic-payment-real-product-credit-lot',{order:payment.order,request:payment.body});
  const funded=billing.checkpoint('full-prospectus-test-funded-by-real-payment-transaction');
  expect(funded.lots.reduce((sum:bigint,lot:any)=>sum+integer(lot.remaining),0n)).toBe(1000000n);
  await openProject(page,project.project_id);
  await expect(page.locator('#execute-input')).toBeEnabled();
  const submission=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/runs/execute'&&r.request().method()==='POST',{timeout:180000});
  await page.locator('#execute-input').click();
  const submitted=await submission,accepted=await submitted.json();expect(submitted.status(),JSON.stringify(accepted)).toBe(200);
  const request=submitted.request().postDataJSON();billing.record('real-full-prospectus-run-submission',{request,accepted});
  writeFileSync(join(directory,'run.json'),JSON.stringify({...provenance,projectId:project.project_id,runId:accepted.run_id,request},null,2));
  const input=await billingApi(page,'GET',`/api/v1/projects/${project.project_id}/input-revisions/${request.input_revision}`);
  expect(input.status,JSON.stringify(input.body)).toBe(200);expect(input.body.input_hash).toBe(request.input_hash);
  expect(input.body.material_versions.map((value:any)=>({material_id:value.material_id,material_version:value.material_version}))
    .sort((a:any,b:any)=>a.material_id.localeCompare(b.material_id)))
    .toEqual([source,main,note].map(value=>({material_id:value.material_id,material_version:value.material_version}))
      .sort((a,b)=>a.material_id.localeCompare(b.material_id)));
  expect(input.body.target_confirmation).toMatchObject({status:'confirmed',market:'sse',offering:'private',as_of:'2025-09-30'});
  expect([...new Set(input.body.target_confirmation.target_reporting_periods.map((value:any)=>value.end))].sort())
    .toEqual(['2023-12-31','2024-12-31','2025-09-30']);
  billing.record('real-task-immutable-input',input.body);
  const duplicate=await billingApi(page,'POST','/api/v1/runs/execute',request);expect(duplicate.status).toBe(200);expect(duplicate.body.run_id).toBe(accepted.run_id);
  await page.reload();let terminal:any,last='';
  await expect.poll(async()=>{
    const state=await billingApi(page,'GET',`/api/v1/runs/${accepted.run_id}`);expect(state.status).toBe(200);terminal=state.body;
    const next=`${terminal.state}/${terminal.stage}`;if(next!==last){last=next;billing.record('real-full-prospectus-worker-progress',terminal);console.log(`RQ Q3 ${accepted.run_id} ${next}`);}
    return ['succeeded','failed','cancelled','rejected','paused'].includes(terminal.state);
  },{timeout:6600000,intervals:[3000,10000,15000]}).toBe(true);
  billing.record('real-full-prospectus-terminal',terminal);expect(terminal.state,JSON.stringify(terminal)).toBe('succeeded');expect(terminal.artifact_id).toBeTruthy();
  const charge=await billingApi(page,'GET',`/api/v1/runs/${accepted.run_id}/credit-charge`);expect(charge.status).toBe(200);billing.record('full-prospectus-final-charge',charge.body);
  const settled=billing.checkpoint('real-full-prospectus-delivered-and-settled');expect(settled.runs).toHaveLength(1);
  const reservation=settled.reservations.find((row:any)=>row.run_id===accepted.run_id);
  expect(reservation.state).toBe('settled');expect(integer(reservation.charged_points)).toBeGreaterThan(0n);
  expect(settled.modelCalls.some((row:any)=>row.run_id===accepted.run_id&&row.status==='completed'&&row.model_id==='gpt-6-sol')).toBe(true);
  await page.goto(`/#/artifacts/${terminal.artifact_id}`);
  for(const [label,name] of [['下载修订版','tracked.docx'],['下载清洁版','clean.docx']] as const){
    const pending=page.waitForEvent('download',{timeout:120000});await page.getByRole('button',{name:label,exact:true}).click();
    await(await pending).saveAs(join(directory,name));
  }
  await page.screenshot({path:join(directory,'dual-Word-delivered.png'),fullPage:true});
  const check=spawnSync(bundledPython,[join(repo,'scripts/local-quality/rq_q3_check.py'),'--clean',join(directory,'clean.docx'),
    '--tracked',join(directory,'tracked.docx'),'--output-dir',directory],{cwd:repo,encoding:'utf8',windowsHide:true,
    env:{...process.env,PYTHONIOENCODING:'utf-8'},timeout:120000});
  billing.record('independent-downloaded-Word-quality-check',{exitCode:check.status,summary:check.stdout,diagnostic:check.stderr,
    reportPath:join(directory,'rq-q3-quality-report.json'),visualReview:'not_performed'});
  for(const file of original)expect(createHash('sha256').update(readFileSync(file.absolutePath)).digest('hex')).toBe(file.sha256);
  const replay=await billingApi(page,'POST','/api/v1/runs/execute',request);expect(replay.status).toBe(200);expect(replay.body.run_id).toBe(accepted.run_id);
  expect(billingLedger(billing.owner)).toEqual(settled);
  expect(check.status,'Independent Word quality report retained at '+directory).toBe(0);
});
