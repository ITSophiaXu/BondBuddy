import {test,expect} from '@playwright/test';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,install,projectId,sourceDeclaration,assertFixture,qualityJob,expectNoExecution} from './authoring-source-guide-fixtures';
import {fixtureJson} from './billing-fixture-wire';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const evidence=resolve(root,'apps/web/test-evidence/audit-pdf-quality-gate');
mkdirSync(evidence,{recursive:true});
for(const width of [1440,390])test('full update page gates low audit and restores replacement at '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:900});
  const s=fixture(),audit=s.materials.find(m=>m.role==='audit')!;
  s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
  let job=qualityJob(audit);job.state='queued';delete job.pdf_quality;
  await install(page,s);
  await page.route('**/pdf-quality',route=>route.fulfill({contentType:'application/json',body:fixtureJson(route,job)}));
  await page.goto('/#/projects/'+projectId+'?step=materials');
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toContainText('正在检查');
  await page.locator('#execute-input').dispatchEvent('click');expectNoExecution(s);
  job=qualityJob(audit);job.pdf_quality!.low_resolution_pages=[{page:7,dpi:144}];job.pdf_quality!.blocking_pages=[7];job.pdf_quality!.sampled_pages=[1,2,3,4,5,6,7];job.pdf_quality!.page_count=7;job.pdf_quality!.checked_pages=7;
  await page.reload();await expect(page.getByText('请更换电子版审计报告',{exact:true})).toBeVisible();
  await expect(page.getByRole('alert').filter({hasText:'PDF 第 7 页'})).toContainText('重新上传清晰的电子版');
  await expect(page.locator('#execute-input')).toBeDisabled();
  await page.screenshot({path:resolve(evidence,'full-page-low-'+width+'.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.reload();await expect(page.locator('#start-disabled-reason')).toContainText('清晰度太低');
  await page.locator('#execute-input').dispatchEvent('click');expectNoExecution(s);
  // Saved material lists model a completed removal/replacement; real upload/delete are covered by PG/Azurite tests.
  s.materials=s.materials.filter(m=>m.material_id!==audit.material_id);await page.reload();
  await expect(page.locator('#start-disabled-reason')).toContainText('审计报告');await expect(page.locator('#execute-input')).toBeDisabled();
  const replacement={...audit,material_id:'replacement-audit',sha256:'b'.repeat(64),filename:'合成电子版审计报告.pdf'};
  s.materials.push(replacement);job=qualityJob(replacement);await page.reload();
  await expect(page.getByText('清晰度抽查完成',{exact:true})).toBeVisible();await expect(page.locator('#execute-input')).toBeEnabled();
  expectNoExecution(s);await assertFixture(page);
});
test('incomplete inspection offers an explicit retry and never accuses low resolution',async({page})=>{
  const s=fixture(),audit=s.materials.find(m=>m.role==='audit')!;
  s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
  let retried=false;await install(page,s);
  await page.route('**/pdf-quality',route=>{if(route.request().postDataJSON().retry)retried=true;const job=qualityJob(audit);if(!retried)job.pdf_quality!.status='partial';return route.fulfill({contentType:'application/json',body:fixtureJson(route,job)});});
  await page.goto('/#/projects/'+projectId+'?step=materials');
  await expect(page.locator('#execute-input')).toBeDisabled();await expect(page.locator('#start-disabled-reason')).toContainText('检查未完成');
  await expect(page.getByText('请更换电子版审计报告',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'重试清晰度检查'}).click();await expect(page.locator('#execute-input')).toBeEnabled();expect(retried).toBe(true);expectNoExecution(s);await assertFixture(page);
});
for(const width of [1440,390])test('sample success matches prototype and allows next step at '+width+'px',async({page})=>{
 const samples=[5,8,12,1,25,50,75,100];
 const s=fixture(),audit=s.materials.find(m=>m.role==='audit')!;
 s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
 const job=qualityJob(audit);job.pdf_quality={version:'pdf-raster-quality-4',status:'complete',page_count:100,checked_pages:8,sampled_pages:samples,blocking_pages:[],low_resolution_pages:[]};
 await page.setViewportSize({width,height:900});await install(page,s);
 await page.route('**/pdf-quality',route=>route.fulfill({contentType:'application/json',body:fixtureJson(route,job)}));
 await page.goto('/#/projects/'+projectId+'?step=materials');
 await expect(page.getByText('清晰度抽查完成',{exact:true})).toBeVisible();
 await expect(page.getByText('已抽查 8 页，未发现低分辨率页面。',{exact:true})).toBeVisible();
 await expect(page.locator('#execute-input')).toBeEnabled();expectNoExecution(s);await assertFixture(page);
 const dir=resolve(root,'apps/web/test-evidence/audit-pdf-quality-sampling');mkdirSync(dir,{recursive:true});
 await page.screenshot({path:resolve(dir,'full-page-'+width+'.png'),fullPage:true});

});

for(const width of [1440,390])test('readable low-DPI warning allows next step at '+width+'px',async({page})=>{
 const s=fixture(),audit=s.materials.find(m=>m.role==='audit')!;
 s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
 const job=qualityJob(audit);job.pdf_quality!.low_resolution_pages=[{page:1,dpi:150}];
 await page.setViewportSize({width,height:900});await install(page,s);
 await page.route('**/pdf-quality',route=>route.fulfill({contentType:'application/json',body:fixtureJson(route,job)}));
 await page.goto('/#/projects/'+projectId+'?step=materials');
 await expect(page.getByText('部分页面分辨率偏低，可继续；建议优先使用清晰电子版，并核对生成后的财务数字。',{exact:false})).toBeVisible();
 await expect(page.locator('#execute-input')).toBeEnabled();expectNoExecution(s);await assertFixture(page);
 await page.screenshot({path:resolve(evidence,'full-page-advisory-'+width+'.png'),fullPage:true});

});
