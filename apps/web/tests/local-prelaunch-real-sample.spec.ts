import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {test,expect,billingApi,topupUI,integer} from './local-prelaunch-billing-helpers';
import {downloadedHash,openProject} from './local-prelaunch-helpers';
import {finishRealSample,privateRealSampleDirectory,qualityPython,realSampleEvidenceRoot as evidenceRoot,
  realSampleRepo as repo,realSampleSources} from './local-prelaunch-real-sample-helpers';
import type {Page} from '@playwright/test';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1'||process.env.BB_E2E_RQ_REAL_SAMPLE!=='1',
  'Explicit owned local stack, authorized RQ files, and shared real-model window required.');
test.setTimeout(7200000);
test.use({viewport:{width:1440,height:1000}});
test.beforeAll(()=>{
  if(!process.env.BB_PRELAUNCH_EVIDENCE_ROOT||resolve(process.env.BB_PRELAUNCH_EVIDENCE_ROOT)!==join(evidenceRoot,'billing-evidence'))
    throw Error('Run this real-sample spec alone with BB_PRELAUNCH_EVIDENCE_ROOT set to the external quality-prelaunch-20261107/billing-evidence directory.');
});

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
  const original=realSampleSources(),directory=join(evidenceRoot,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  privateRealSampleDirectory(directory);
  await page.context().storageState({path:join(directory,'session.json')});
  const provenance={schema:'local-prelaunch-real-sample-v1',case:'rq-202509' as const,realCustomerInputs:true,syntheticAccounts:true,
    syntheticPaymentChannel:true,httpMocked:false,taskResultsFabricated:false,industrySignoff:false,financialFactApproval:false,
    sourceHashes:original.map((s:any)=>({file_id:s.file_id,sha256:s.sha256,bytes:s.bytes})),sourceCutoff:'2025-06-30',targetCutoff:'2025-09-30',
    outputDirectory:directory,owner:billing.owner,username:billing.username};
  writeFileSync(join(directory,'provenance.json'),JSON.stringify(provenance,null,2));billing.record('real-customer-input-provenance',provenance);
  const baseline=execFileSync(qualityPython,[join(repo,'scripts/local-quality/rq_q3_baseline.py'),'--output-dir',directory],
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
  const submitted=await submission,accepted=await submitted.json(),request=submitted.request().postDataJSON();
  const receipt={...provenance,projectId:project.project_id,runId:accepted.run_id,request,originalQuote:undefined as any};
  // Persist the accepted identity before assertions so a harness interruption never requires resubmission.
  writeFileSync(join(directory,'run.json'),JSON.stringify(receipt,null,2));
  billing.record('real-full-prospectus-run-submission',{status:submitted.status(),request,accepted});
  expect(submitted.status(),JSON.stringify(accepted)).toBe(202);
  const charge=await billingApi(page,'GET',`/api/v1/runs/${accepted.run_id}/credit-charge`);expect(charge.status).toBe(200);
  receipt.originalQuote=charge.body.quote;writeFileSync(join(directory,'run.json'),JSON.stringify(receipt,null,2));
  expect(receipt.originalQuote.quote_id).toBe(request.quote_id);
  billing.record('original-full-prospectus-locked-quote',receipt.originalQuote);
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
  const duplicate=await billingApi(page,'POST','/api/v1/runs/execute',request);expect(duplicate.status).toBe(202);expect(duplicate.body.run_id).toBe(accepted.run_id);
  await page.reload();await finishRealSample(page,billing,receipt);
});
