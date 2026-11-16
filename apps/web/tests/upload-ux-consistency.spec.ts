// Shared upload UX: real controllers, synthetic HTTP and files, no business execution.
import {test,expect,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import * as review from './review-upload-twelfth-fixtures';
import * as qa from './qa-upload-11th-fixtures';
import * as m4 from './m4-upload-thirteenth-fixtures';
import * as assistant from './assistant-upload-11th-fixtures';
import * as integrity from './integrity-upload-eleventh-fixtures';
import {ownerId,projectId,checkId,exportId} from './integrity-continuation-fixtures';
import * as files from './project-file-status-fixtures';

const out=process.env.BB_UPLOAD_UX_EVIDENCE??'test-evidence/upload-ux-consistency';
async function capture(page:Page,name:string,selector:string){
 await mkdir(out,{recursive:true});
 const root=page.locator(selector).first();await expect(root).toBeVisible();
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:960});
  await expect(async()=>{await root.screenshot({path:join(out,`${name}-${width}.png`)});}).toPass({timeout:5000});
  expect(await root.evaluate(e=>e.matches('.bb-upload-picker,.bb-upload-action')||!!e.querySelector('.bb-upload-picker,.bb-upload-action'))).toBe(true);
  for(const control of await root.locator('.bb-upload-action:visible,.bb-upload-picker--compact:visible').all()){
   const style=await control.evaluate(e=>{const s=getComputedStyle(e);return {width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,border:parseFloat(s.borderTopWidth)};});
   expect(style.width).toBeGreaterThanOrEqual(44);expect(style.height).toBeGreaterThanOrEqual(44);expect(style.border).toBeGreaterThanOrEqual(1);
  }
  for(const height of await root.evaluate(e=>[...(e.matches('.bb-upload-picker--standard')?[e]:[]),...e.querySelectorAll('.bb-upload-picker--standard')].filter(n=>n.getBoundingClientRect().width>0).map(n=>n.getBoundingClientRect().height)))expect(height).toBeGreaterThanOrEqual(112);
  expect(await root.evaluate(e=>[e,...e.querySelectorAll('.bb-upload-picker,.bb-upload-action')].filter(n=>n.getBoundingClientRect().width>0).every(n=>{const b=n.getBoundingClientRect();return b.left>=-1&&b.right<=innerWidth+1;}))).toBe(true);
  const controls=await root.evaluate(root=>Array.from(root.querySelectorAll('button,label,input[type=file]')).filter(e=>e.matches('input[type=file]')||/上传|重试|停止|取消|原文件|保存|附件|待办/.test(e.textContent??'')).map(e=>{const s=getComputedStyle(e),b=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,text:e.textContent?.trim().slice(0,120),class:e.className,display:s.display,width:b.width,height:b.height,border:s.border,background:s.backgroundColor,cursor:s.cursor,tabIndex:(e as HTMLElement).tabIndex,accept:e.getAttribute('accept'),multiple:e.hasAttribute('multiple')};}));
  await writeFile(join(out,`${name}-${width}.json`),JSON.stringify({name,width,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),controls},null,2));
 }
}
test('audit review entry and recovery',async({page})=>{
 const s=review.fixture();s.materials.clear();s.draft.source_material_ref=null;s.draft.material_versions=[];s.draft.evidence_links=[];
 await review.install(page,s);await review.mount(page);await capture(page,'review-entry','#review-upload-groups');
 const missingBytes=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/v1/projects/${review.ids.project}/materials/uploads/review-twelfth-U-1/complete`&&response.status()===422);
 s.dropPut='before';await page.locator('[data-review-upload-role=audit]').setInputFiles(review.file);
 expect(await (await missingBytes).json()).toMatchObject({code:'MATERIAL_UNREADABLE',field_errors:[{field:'upload_session',code:'bytes_pending'}]});
 // Keep the original ten-minute unknown-PUT budget; only advance the installed browser clock.
 await page.clock.fastForward(600_001);
 await expect(review.recovery(page).getByRole('button',{name:'重试',exact:true})).toBeVisible();
 await expect(review.recovery(page).getByRole('button',{name:'重试',exact:true})).toBeEnabled();
 expect(review.uploads(s,'create')).toHaveLength(1);expect(review.uploads(s,'bytes')).toHaveLength(1);
 expect([...s.uploads.keys()]).toEqual(['review-twelfth-U-1']);expect(s.uploads.get('review-twelfth-U-1')!.received).toBe(false);
 expect(s.materials.size).toBe(0);expect(review.draftWrites(s)).toEqual([]);expect(await review.records(page)).toHaveLength(1);
 for(const complete of review.uploads(s,'complete'))expect(complete).toEqual({method:'POST',path:`/projects/${review.ids.project}/materials/uploads/review-twelfth-U-1/complete`,search:'',body:{byte_size:review.file.buffer.length,sha256:review.hash(review.file.buffer)}});
 const originalWrites=structuredClone(review.writes(s));
 await capture(page,'review-recovery','#review-upload-groups');
 await review.recovery(page).locator('[data-review-recovery-remove]').click();await expect(review.recovery(page)).toHaveCount(0);review.noBusiness(s);
 expect(review.writes(s)).toEqual(originalWrites);expect(await review.records(page)).toHaveLength(0);
});

test('shared picker supports keyboard, drag, single-file errors and disabled fields',async({page})=>{
 await page.route('**/upload-picker-harness',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><main style="padding:16px"><div id="root"></div></main>'}));
 await page.goto('/upload-picker-harness');
 await page.evaluate(async()=>{
  const {uploadPicker}=await import(String('/src/upload-picker.ts'));
  document.querySelector('#root')!.innerHTML='<label>查询证据'+uploadPicker('<input id="single" type="file" accept=".pdf">')+'</label><label>补充资料'+uploadPicker('<input id="multiple" type="file" multiple hidden>',{size:'compact',label:'添加附件'})+'</label><fieldset disabled>'+uploadPicker('<input id="disabled" type="file">')+'</fieldset>';
  (window as any).changes=[];document.addEventListener('change',e=>(window as any).changes.push((e.target as HTMLElement).id));
 });
 const first=page.locator('#single');await first.focus();await expect(first).toBeFocused();
 const choose=page.waitForEvent('filechooser');await first.press('Space');await(await choose).setFiles({name:'合成证据.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic')});
 await first.focus();await first.press('Tab');await expect(page.locator('#multiple')).toBeFocused();
 const data=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['first'],'first.pdf',{type:'application/pdf'}));d.items.add(new File(['second'],'second.pdf',{type:'application/pdf'}));return d;});
 await first.locator('..').dispatchEvent('drop',{dataTransfer:data});await expect(page.locator('[data-upload-picker-error]').first()).toHaveText('每次请选择一份文件。');expect(await first.evaluate(e=>(e as HTMLInputElement).files![0].name)).toBe('合成证据.pdf');
 await page.locator('#multiple').locator('..').dispatchEvent('drop',{dataTransfer:data});expect(await page.locator('#multiple').evaluate(e=>(e as HTMLInputElement).files!.length)).toBe(2);
 await page.locator('#disabled').locator('..').dispatchEvent('drop',{dataTransfer:data});expect(await page.locator('#disabled').evaluate(e=>(e as HTMLInputElement).files!.length)).toBe(0);
 expect(await page.evaluate(()=>(window as any).changes)).toEqual(['single','multiple']);await data.dispose();
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:960});expect(await page.locator('.bb-upload-picker--standard').first().evaluate(e=>e.getBoundingClientRect().height)).toBe(112);expect(await page.locator('.bb-upload-picker--compact').evaluate(e=>e.getBoundingClientRect().height)).toBe(44);}
});
test('audit QA entry and recovery',async({page})=>{
 const s=qa.qaUploadFixture();await qa.installQaUpload11th(page,s);await page.goto(qa.qaUploadUrl);
 await expect(page.locator('#qa-supplement')).toBeAttached();await capture(page,'qa-entry','.qa-page');
 await page.locator('#qa-supplement').setInputFiles(qa.qaUploadFile());
 await expect(page.locator('[data-qa-upload-stop]')).toBeEnabled({timeout:15000});await capture(page,'qa-recovery','.qa-upload-recovery');
 await page.locator('[data-qa-upload-stop]').click();await expect(page.locator('[data-qa-upload-stop]')).toHaveCount(0);expect(s.calls.filter(c=>c.method==='DELETE')).toEqual([]);
 expect(s.qa.answers).toEqual([]);
});
test('audit integrity evidence entry and recovery',async({page})=>{
 const s=integrity.uploadFixture();
 await page.addInitScript(({key,owner,project,draft,revision,roundId})=>localStorage.setItem(key,JSON.stringify({version:'integrity-recovery-cache-v1',owner,project,value:{revision,draft,evidenceDraft:{roundId,subjectId:'company-a',siteId:'credit-china',url:'https://www.creditchina.gov.cn/',time:'',note:'',conclusion:'unresolved'}}})),{key:`bb-integrity-recovery:${ownerId}:${projectId}`,owner:ownerId,project:projectId,draft:s.workspace.draft,revision:s.workspace.revision,roundId:checkId});
 await integrity.installUpload(page,s);await page.goto(`/#integrity?project=${projectId}&run=${exportId}`);
 await page.locator('#integrity-resume-evidence').click();await capture(page,'integrity-entry','#integrity-evidence-form');
 s.unavailable=true;await page.locator('[name=time]').fill('2026-11-09T10:20');await page.locator('[name=note]').fill('合成检查资料');
 await page.locator('[name=file]').setInputFiles({name:'合成证据.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic audit evidence')});
 await expect(page.locator('#integrity-confirm-upload')).toBeEnabled({timeout:15000});await capture(page,'integrity-recovery','#integrity-evidence-form');
 await page.locator('#integrity-stop-upload').click();await expect(page.locator('#integrity-confirm-upload')).toHaveCount(0);expect(s.calls.filter(c=>c.method==='DELETE')).toEqual([]);
 expect(s.manuals).toEqual([]);
});
test('audit assistant attachment entry and recovery',async({page})=>{
 const s=await assistant.assistantFixture(page);await assistant.mountAssistant(page);await capture(page,'assistant-entry','.ba-composer');
 s.dropAssociation=true;await page.locator('.ba-composer [data-file]').setInputFiles(assistant.file);
 await expect(page.locator('[data-a=retry-upload]')).toBeEnabled();await capture(page,'assistant-recovery','.ba-composer');
 await page.locator('[data-a=retry-upload]').click();await expect(page.locator('[data-uploads] [data-associated=true]')).toContainText('已保存');assistant.noBusiness(s);
});

test('shared upload reference at desktop and mobile widths',async({page})=>{
 const {resolve}=await import('node:path');await mkdir(out,{recursive:true});
 await page.goto('/@fs/'+resolve(process.cwd(),'../../product-prototype/public/upload-ux-unified.html').replaceAll('\\','/'));
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(out,`prototype-${width}.png`),fullPage:true});}
});
test('audit topic generation material entry and recovery',async({page})=>{
 const s=await m4.install(page);await m4.mount(page);await capture(page,'topic-entry','[data-m4-drop=material]');
 const originalDrafts=structuredClone(s.workspace.drafts),originalMaterials=structuredClone([...s.materials]);
 const missingBytes=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/projects/${m4.ids.project}/materials/uploads/m4-thirteenth-U-1/complete`&&response.status()===422);
 s.dropPut='before';await page.locator('[data-m4-upload=material]').last().setInputFiles(m4.file);
 expect(await (await missingBytes).json()).toMatchObject({code:'MATERIAL_UNREADABLE',field_errors:[{field:'upload_session',code:'bytes_pending'}]});
 await expect(m4.recovery(page).locator('[data-m4-recovery-remove]')).toBeDisabled();
 const originalRecords=await m4.records(page);expect(originalRecords).toHaveLength(1);
 expect(originalRecords[0].value).toMatchObject({owner:m4.ids.owner,projectId:m4.ids.project,topicId:m4.ids.topic,purpose:'material',documentType:'private_summary',items:[{index:0,stage:'prepared',declaration:{filename:m4.file.name,byte_size:m4.file.buffer.length,sha256:m4.hash(m4.file.buffer)}}]});
 // Keep the original ten-minute unknown-PUT budget; only advance the installed browser clock.
 await page.clock.fastForward(600_001);
 await expect(m4.recovery(page).locator('[data-m4-recovery-action=resume]')).toBeEnabled();
 await expect(m4.recovery(page).locator('[data-m4-recovery-remove]')).toBeEnabled();
 expect(m4.uploads(s,'create')).toHaveLength(1);expect(m4.uploads(s,'bytes')).toHaveLength(1);
 expect([...s.uploads.keys()]).toEqual(['m4-thirteenth-U-1']);expect(s.uploads.get('m4-thirteenth-U-1')!.received).toBe(false);
 expect(m4.libraryWrites(s)).toEqual([]);expect(m4.draftWrites(s)).toEqual([]);expect(await m4.records(page)).toEqual(originalRecords);
 for(const complete of m4.uploads(s,'complete'))expect(complete).toEqual({method:'POST',path:`/projects/${m4.ids.project}/materials/uploads/m4-thirteenth-U-1/complete`,search:'',body:{byte_size:m4.file.buffer.length,sha256:m4.hash(m4.file.buffer)}});
 const originalWrites=structuredClone(m4.writes(s));
 await expect(m4.recovery(page)).toBeVisible();await capture(page,'topic-recovery','.m4-upload-recovery-list');
 await m4.recovery(page).locator('[data-m4-recovery-remove]').click();await expect(m4.recovery(page)).toHaveCount(0);m4.noBusiness(s);
 expect(m4.writes(s)).toEqual(originalWrites);expect(await m4.records(page)).toHaveLength(0);
 expect(s.workspace.drafts).toEqual(originalDrafts);expect([...s.materials]).toEqual(originalMaterials);
});
test('audit project file import',async({page})=>{
 const s=await files.open(page);await page.locator('#import-project-file').click();
 await capture(page,'project-import','.pw-file-import[open]');files.noBusiness(s);
});
