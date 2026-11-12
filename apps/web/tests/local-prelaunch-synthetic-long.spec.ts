import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Page} from '@playwright/test';
import {test,expect,billingApi,topupUI,integer} from './local-prelaunch-billing-helpers';
import {downloadedHash,openProject} from './local-prelaunch-helpers';
import {finishSyntheticLong,privateSyntheticDirectory,syntheticEvidenceRoot,syntheticLongInputs,type SyntheticLongReceipt} from './local-prelaunch-synthetic-long-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1'||process.env.BB_E2E_SYNTHETIC_LONG!=='1',
  'Explicit isolated local instance, synthetic fixtures and shared real-model window required');
test.use({viewport:{width:1440,height:1000}});
test.setTimeout(7200000);
test.beforeAll(()=>{
  if(resolve(process.env.BB_PRELAUNCH_EVIDENCE_ROOT??'')!==join(syntheticEvidenceRoot,'synthetic-long-billing-evidence'))
    throw Error('External dedicated synthetic-long billing evidence root required');
  syntheticLongInputs();
});

async function upload(page:Page,projectId:string,file:any,source=false){
  const picker=page.getByLabel(source?'募集书新版本文件':'为审计报告（可含报表及附注）选择文件',{exact:true});await expect(picker).toBeEnabled();
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith(`/api/v1/projects/${projectId}/materials/uploads/`)
    &&r.url().endsWith('/complete')&&r.request().method()==='POST',{timeout:180000});
  await picker.setInputFiles(file.path);const response=await pending;expect(response.status(),await response.text()).toBe(200);
  const material=await response.json();expect(await downloadedHash(page,projectId,material.material_id)).toEqual({status:200,bytes:file.bytes,sha256:file.sha256});
  return material;
}

test('purely invented long prospectus is updated by the actual model with scoped financial values and preserved dual Word',async({page,billing})=>{
  const fixture=syntheticLongInputs(),directory=join(syntheticEvidenceRoot,'synthetic-long-run-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  privateSyntheticDirectory(directory);await page.context().storageState({path:join(directory,'session.json')});
  writeFileSync(join(directory,'provenance.json'),JSON.stringify({case:fixture.manifest.schema,syntheticOnly:true,customerInputsRead:false,
    fixtureDirectory:fixture.directory,manifestHash:fixture.manifestHash,modelResultsFabricated:false,industrySignoff:false},null,2));
  await page.goto('/#/new');await page.getByLabel('发行人全称',{exact:true}).fill(fixture.manifest.issuer);
  await page.getByLabel('发行市场',{exact:true}).selectOption('sse');await page.getByLabel('发行方式',{exact:true}).selectOption('private');
  await page.getByLabel('最新报告期年份',{exact:true}).selectOption('2026');await page.locator('[name="reporting_quarter"][value="09-30"]').check();
  const creating=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/projects'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();const created=await creating;expect(created.status()).toBe(201);
  const project=await created.json();await openProject(page,project.project_id);
  const source=await upload(page,project.project_id,fixture.files.find((f:any)=>f.role==='historical'),true);
  const fields=page.locator(`[data-source-material="${source.material_id}"]`);
  await fields.locator('[data-source-field="relation"]').selectOption('same_issuer');await fields.locator('[data-source-field="market"]').selectOption('sse');
  await fields.locator('[data-source-field="offering"]').selectOption('private');await fields.locator('[data-source-field="year"]').selectOption('2025');
  await fields.locator('[data-source-field="quarter"][value="12-31"]').check();await expect(page.locator('#save-state')).toHaveText('已保存');
  const financial=await upload(page,project.project_id,fixture.files.find((f:any)=>f.role==='financial'));
  const notes=await upload(page,project.project_id,fixture.files.find((f:any)=>f.role==='notes'));
  const instruction='这是完全虚构的长篇工程验收案例。请按提供的三份合成材料将全文更新至2026年9月30日，目标报告期为2024及2025年度、2026年1至9月。保留所有14章及正文、合成明细索引、目录内链、图片、页眉页脚、章节样式和跨页表头。六张财务表均补入本期；流量表另列2025年1至9月可比数据。合并工作簿单位为元，母公司工作簿单位为万元，原稿单位为万元，准确换算。严分合并与母公司、期末与年初、累计与上年同期，不把2025全年数当作同期数。根据附注核对24项关键值；其余非财务条款保持原有内容。交付真实修订版与清洁版，局部存疑明确标注，不能删减成摘要。';
  await page.getByLabel('补充募集书更新说明',{exact:true}).fill(instruction);await page.getByLabel('补充募集书更新说明',{exact:true}).blur();
  await expect(page.locator('#conversation-status')).toContainText(/已自动保存|已保存/);
  billing.record('synthetic-long-three-inputs-prepared',{fixtureDirectory:fixture.directory,manifestHash:fixture.manifestHash,source,financial,notes,instruction});
  const free=billing.checkpoint('synthetic-long-free-preparation');expect(free.runs).toEqual([]);expect(free.events).toEqual([]);expect(free.modelCalls).toEqual([]);
  const payment=await topupUI(page,'10000');await page.locator('#delivery').selectOption('callback');await page.locator('#simulate-paid').click();
  await expect(page.locator('#checkout-title')).toHaveText('积分已到账');await page.locator('#return-paid').click();
  billing.record('synthetic-long-simulated-payment-real-ledger',payment);
  expect(billing.checkpoint('synthetic-long-funded').lots.reduce((sum:bigint,row:any)=>sum+integer(row.remaining),0n)).toBe(1000000n);
  await openProject(page,project.project_id);await expect(page.locator('#execute-input')).toBeEnabled();
  const submitting=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/runs/execute'&&r.request().method()==='POST',{timeout:180000});
  await page.locator('#execute-input').click();const submitted=await submitting,accepted=await submitted.json(),request=submitted.request().postDataJSON();
  const receipt:SyntheticLongReceipt={case:'synthetic-long-2026q3-v1',owner:billing.owner,username:billing.username,projectId:project.project_id,
    runId:accepted.run_id,directory,fixtureDirectory:fixture.directory,manifestHash:fixture.manifestHash,
    sourceHashes:fixture.files.map(({role,filename,bytes,sha256}:any)=>({role,filename,bytes,sha256})),
    materialVersions:[source,financial,notes].map(m=>({material_id:m.material_id,material_version:m.material_version})),request};
  writeFileSync(join(directory,'run.json'),JSON.stringify(receipt,null,2));
  console.log(`Synthetic long accepted ${accepted.run_id}; private evidence ${directory}`);
  billing.record('synthetic-long-submitted',{status:submitted.status(),accepted,request});expect(submitted.status(),JSON.stringify(accepted)).toBe(202);
  const charge=await billingApi(page,'GET',`/api/v1/runs/${accepted.run_id}/credit-charge`);expect(charge.status).toBe(200);
  receipt.originalQuote=charge.body.quote;writeFileSync(join(directory,'run.json'),JSON.stringify(receipt,null,2));
  const input=await billingApi(page,'GET',`/api/v1/projects/${project.project_id}/input-revisions/${request.input_revision}`);expect(input.status).toBe(200);
  expect(input.body.input_hash).toBe(request.input_hash);expect(input.body.material_versions).toHaveLength(3);
  expect([...input.body.material_versions].sort((a:any,b:any)=>a.material_id.localeCompare(b.material_id)))
    .toEqual([...receipt.materialVersions].sort((a,b)=>a.material_id.localeCompare(b.material_id)));
  // finishSyntheticLong verifies the immutable unified manifest consumed by the worker.
  // The optional legacy target_confirmation DTO is intentionally not an authoring target source.
  billing.record('synthetic-long-immutable-input',input.body);await page.reload();await finishSyntheticLong(page,billing,receipt);
});
