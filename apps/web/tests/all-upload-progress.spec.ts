import {test,expect,type Page,type Locator} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {sourceFixture} from './generation-source-fixtures';
import {href,file as sourceFile} from './generation-entry-fixtures';
import {installQaUpload11th,qaUploadFixture,qaUploadUrl,qaUploadFile} from './qa-upload-11th-fixtures';
import * as m4 from './m4-upload-thirteenth-fixtures';
import * as assistant from './assistant-upload-11th-fixtures';
import * as template from './assistant-template-fifteenth-fixtures';

// Real controllers and upload recovery; synthetic HTTP/files and controlled byte callbacks.
import {hold,check} from './upload-progress-fixtures';
for(const width of [1440,390]){
 test('source upload, save and selection at '+width,async({page})=>{
  await page.setViewportSize({width,height:960});await sourceFixture(page,false);await page.goto('/'+href());await expect(page.locator('#prospectus-version-file')).toBeAttached();await hold(page);
  await page.locator('#prospectus-version-file').setInputFiles(sourceFile);
  await check(page,page.locator('[data-file-upload-progress] progress'),'source',width);
  await expect(page.locator('[data-file-upload-progress] progress')).toHaveCount(0);
 });
 test('QA supplementary upload at '+width,async({page})=>{
  await page.setViewportSize({width,height:960});const s=qaUploadFixture();s.lostPut=false;s.completeUnavailable=false;await installQaUpload11th(page,s);await page.goto(qaUploadUrl);await expect(page.locator('#qa-supplement')).toBeAttached();await hold(page);
  await page.locator('#qa-supplement').setInputFiles(qaUploadFile());await expect(page.locator('[data-qa-upload-action=resume]')).toBeHidden();await check(page,page.locator('[data-qa-upload-id] progress'),'qa',width);
  await expect(page.locator('[data-qa-upload-id]')).toHaveCount(0);expect(s.qa.answers).toEqual([]);
 });
 test('material workspace upload at '+width,async({page})=>{
  await page.setViewportSize({width,height:960});const s=await m4.install(page);await m4.mount(page);await hold(page);
  await page.locator('[data-m4-upload=material]').last().setInputFiles(m4.file);await check(page,m4.recovery(page).getByRole('progressbar'),'material',width);
  await expect(m4.recovery(page)).toHaveCount(0);m4.noBusiness(s);
 });
 test('assistant attachment upload at '+width,async({page})=>{
  await page.setViewportSize({width,height:960});const s=await assistant.assistantFixture(page);await assistant.mountAssistant(page);await hold(page);
  await page.locator('.ba-composer [data-file]').setInputFiles(assistant.file);await check(page,page.locator('[data-assistant-upload] progress'),'assistant',width);
  await expect(page.locator('[data-assistant-upload]')).toContainText('上传成功');assistant.noBusiness(s);
 });
 test('assistant private template upload at '+width,async({page})=>{
  await page.setViewportSize({width,height:960});const s=await template.install(page);await template.mount(page);await hold(page);
  await template.select(page);await check(page,template.recovery(page).getByRole('progressbar'),'template',width);await template.saved(page,s);
 });
}

test('binary template POST exposes real progress, preserves CSRF and auth retry identity',async({page})=>{
 await page.goto('/');await page.context().addCookies([{name:'bb_csrf',value:'synthetic-csrf',url:new URL(page.url()).origin}]);
 let calls=0;const bodies:Buffer[]=[];let finish!:()=>void;
 await page.route('**/api/v1/auth/refresh',r=>r.fulfill({json:{}}));
 await page.route('**/api/v1/projects/synthetic/file-generation/templates/import?request_id=same',async r=>{
  expect(r.request().headers()['x-bb-csrf']).toBe('synthetic-csrf');bodies.push(r.request().postDataBuffer()!);calls++;
  if(calls===1)return r.fulfill({status:401,json:{error:{code:'UNAUTHENTICATED'}}});
  await new Promise<void>(resolve=>finish=resolve);return r.fulfill({json:{saved:true}});
 });
 await page.evaluate(async()=>{const {ApiClient}=await import(String('/src/api.ts'));const events:any[]=(window as any).uploadEvents=[];(window as any).binaryResult=new ApiClient(()=>{}).uploadRequest('/projects/synthetic/file-generation/templates/import?request_id=same',new File(['synthetic template'],'template.docx'),(loaded:number,total:number)=>events.push({loaded,total}),new AbortController().signal,()=>events.push({processing:true}));});
 await expect.poll(()=>calls).toBe(2);expect(bodies[0].equals(bodies[1])).toBe(true);finish();
 expect(await page.evaluate(()=>(window as any).binaryResult)).toEqual({saved:true});
 const events=await page.evaluate(()=>(window as any).uploadEvents);expect(events.filter((e:any)=>e.loaded===0)).toHaveLength(2);expect(events.some((e:any)=>e.loaded===18&&e.total===18)).toBe(true);expect(events.some((e:any)=>e.processing)).toBe(true);
});

for(const width of [1440,390])test('shared upload prototype reference at '+width,async({page})=>{
 await page.setViewportSize({width,height:960});const {resolve}=await import('node:path');const path=resolve(process.cwd(),'../../product-prototype/public/upload-progress.html').replaceAll('\\','/');
 await page.goto('/@fs/'+path);await expect(page.getByRole('progressbar')).toHaveCount(4);await expect(page.getByText('正在上传文件…',{exact:true})).toHaveCount(2);await expect(page.getByText('上传成功',{exact:true})).toBeVisible();await expect(page.locator('main')).not.toContainText(/确认保存|正在保存/);await mkdir('test-evidence/all-upload-progress',{recursive:true});
 await page.screenshot({path:'test-evidence/all-upload-progress/prototype-'+width+'.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

for(const failure of ['abort','server'] as const)test('binary template POST handles '+failure+' without replay',async({page})=>{
 await page.goto('/');let calls=0;
 await page.route('**/api/v1/synthetic-template-import',r=>{calls++;return failure==='server'?r.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',correlation_id:'synthetic-upload'}}):r.abort('aborted');});
 const result=await page.evaluate(async failure=>{const {ApiClient}=await import(String('/src/api.ts'));const controller=new AbortController();if(failure==='abort')controller.abort();try{await new ApiClient(()=>{}).uploadRequest('/synthetic-template-import',new File(['synthetic'],'template.docx'),()=>{},controller.signal);return 'unexpected';}catch(error:any){return failure==='abort'?error.name:error.code;}},failure);
 expect(result).toBe(failure==='abort'?'AbortError':'DATA_UNAVAILABLE');expect(calls).toBe(failure==='abort'?0:1);
});
