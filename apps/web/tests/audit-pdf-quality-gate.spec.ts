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
  job=qualityJob(audit);job.pdf_quality!.low_resolution_pages=[{page:7,dpi:144}];job.pdf_quality!.page_count=7;job.pdf_quality!.checked_pages=7;
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
  await expect(page.getByText('清晰度检查完成',{exact:true})).toBeVisible();await expect(page.locator('#execute-input')).toBeEnabled();
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
for(const width of [1440,390])test('material row matches approved scope prototype at '+width+'px',async({page})=>{
 await page.setViewportSize({width,height:900});await page.goto('/');
 await page.setContent(readFileSync(resolve(root,'product-prototype/public/audit-pdf-quality-gate.html'),'utf8'));
 await page.screenshot({path:resolve(evidence,'prototype-'+width+'.png'),fullPage:true});const expected=await page.locator('#status').innerText();
 await page.evaluate(async()=>{
  const modulePath='/src/material-processing.ts';const {MaterialProcessing}=await import(modulePath);
  const material={material_id:'audit',material_version:1,sha256:'a'.repeat(64),filename:'合成审计报告.pdf',media_type:'application/pdf',role:'audit',byte_size:1024,state:'persisted',upload_id:'upload',persisted_at:'2026-11-18T00:00:00Z',error:null};
  const job={job_id:'job',job_type:'parse',subtype:'material_parse',project_id:'project',material_id:'audit',material_version:1,material_sha256:material.sha256,parser_version:'pdf-raster-quality-2',state:'succeeded',stage:'succeeded',completed_stages:['pdf_quality'],attempts:1,max_attempts:3,error_code:null,outcome:null,parse_status:null,profile_version:null,pending_capabilities:[],updated_at:material.persisted_at,pdf_quality:{version:'pdf-raster-quality-2',status:'complete',page_count:7,checked_pages:7,low_resolution_pages:[{page:7,dpi:144}]}};
  const controller=new MaterialProcessing({material:async()=>material,materialPdfQuality:async()=>job},'project',()=>{},{auditPdfGate:true,auditOnly:true});
  controller.sync([material]);await new Promise(r=>setTimeout(r,10));document.getElementById('status')!.innerHTML=controller.render(material);controller.dispose();
 });
 await page.addStyleTag({content:readFileSync(resolve(root,'apps/web/src/material-processing.css'),'utf8')});
 expect((await page.locator('#status').innerText()).replace(/\s/g,'')).toBe(expected.replace(/\s/g,''));
 await page.screenshot({path:resolve(evidence,'implementation-'+width+'.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

for(const width of [1440,390])test('sample success matches prototype and allows next step at '+width+'px',async({page})=>{
 const samples=[5,8,12,1,25,50,75,100];
 const s=fixture(),audit=s.materials.find(m=>m.role==='audit')!;
 s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
 const job=qualityJob(audit);job.pdf_quality={version:'pdf-raster-quality-3',status:'complete',page_count:100,checked_pages:8,sampled_pages:samples,low_resolution_pages:[]};
 await page.setViewportSize({width,height:900});await install(page,s);
 await page.route('**/pdf-quality',route=>route.fulfill({contentType:'application/json',body:fixtureJson(route,job)}));
 await page.goto('/#/projects/'+projectId+'?step=materials');
 await expect(page.getByText('清晰度抽查完成',{exact:true})).toBeVisible();
 await expect(page.getByText('已抽查 8 页，未发现低分辨率页面。',{exact:true})).toBeVisible();
 await expect(page.locator('#execute-input')).toBeEnabled();expectNoExecution(s);await assertFixture(page);
 const dir=resolve(root,'apps/web/test-evidence/audit-pdf-quality-sampling');mkdirSync(dir,{recursive:true});
 await page.screenshot({path:resolve(dir,'full-page-'+width+'.png'),fullPage:true});
 await page.setContent(readFileSync(resolve(root,'product-prototype/public/audit-pdf-quality-sampling.html'),'utf8'));
 const expected=await page.locator('#status').innerText();await page.screenshot({path:resolve(dir,'prototype-'+width+'.png'),fullPage:true});
 await page.evaluate(async({audit,job})=>{
  const modulePath='/src/material-processing.ts';const {MaterialProcessing}=await import(modulePath);
  const c=new MaterialProcessing({material:async()=>audit,materialPdfQuality:async()=>job},job.project_id,()=>{},{auditPdfGate:true});
  c.sync([audit]);await new Promise(r=>setTimeout(r,10));document.getElementById('status')!.innerHTML=c.render(audit);c.dispose();
 },{audit,job});
 await page.addStyleTag({content:readFileSync(resolve(root,'apps/web/src/material-processing.css'),'utf8')});
 expect((await page.locator('#status').innerText()).replace(/\s/g,'')).toBe(expected.replace(/\s/g,''));
 await page.screenshot({path:resolve(dir,'implementation-'+width+'.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
