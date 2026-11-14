import {expect,test,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {qaUploadFixture,installQaUpload11th,assertQaUpload11th,qaUploadUrl,qaUploadFile,qaTransportWrites,projectId,otherOwnerId,type QaUploadState} from './qa-upload-11th-fixtures';
import {QaRecoveryCache} from '../src/qa-recovery-cache';
const row=(page:Page)=>page.locator('[data-qa-upload-id]');
const confirm=(page:Page)=>row(page).locator('[data-qa-upload-action="resume"]');
async function open(page:Page,state=qaUploadFixture()){await installQaUpload11th(page,state);await page.goto(qaUploadUrl);await expect(page.locator('#qa-supplement')).toBeAttached();return state;}
async function capture(page:Page,name:string){const out=process.env.BB_QA_UPLOAD_11TH_EVIDENCE_DIR;if(out){await mkdir(out,{recursive:true});await page.screenshot({path:join(out,`qa-upload-11th-${name}.png`)});}}
async function local(page:Page){const entries=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)!])));return new QaRecoveryCache('synthetic-qa-owner-a',projectId,{getItem:k=>entries[k]??null,setItem:()=>{throw Error('read only');},removeItem:()=>{throw Error('read only');}}).read();}
async function pending(page:Page,state:QaUploadState,source=false,file=qaUploadFile(source?'合成原问题清单.doc':'合成原补充材料.pdf')){
 await page.locator(source?'#qa-upload':'#qa-supplement').setInputFiles(file);
 // A 503 first exhausts completeUpload's existing bounded automatic retries
 // (three 2-second waits) before the original manual recovery becomes available.
 await expect(confirm(page)).toBeEnabled({timeout:15000});await expect(row(page).locator('[role=alert]').first()).toBeVisible();await expect(row(page)).toContainText(file.name);expect(state.qa.prepares).toEqual([]);
 const writes=qaTransportWrites(state).length;await page.reload();await expect(confirm(page)).toBeVisible();expect(qaTransportWrites(state)).toHaveLength(writes);expect(state.qa.prepares).toEqual([]);return file;
}
test.beforeEach(async({page})=>{page.on('dialog',d=>void d.accept());});
for(const width of [1440,390]){
 test(`QA supplementary upload restores only the original preparation and never posts a task at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});const state=await open(page),original=structuredClone(state.qa.workspace.draft);await pending(page,state);
  await row(page).scrollIntoViewIfNeeded();await capture(page,`supplement-pending-${width}`);state.completeUnavailable=false;
  await confirm(page).click();await expect(row(page)).toHaveCount(0);await expect(page.locator('#qa-save')).toBeEnabled();
  expect(state.uploads.size).toBe(1);expect(state.calls.filter(c=>c.method==='PUT')).toHaveLength(1);const saved=await local(page);expect(saved.status).toBe('valid');
  if(saved.status==='valid'){expect(saved.value.draft.preparation_id).toBe(original.preparation_id);expect(saved.value.draft.requirements).toBe(original.requirements);expect(saved.value.draft.materials).toHaveLength(original.materials.length+1);}
  await expect(page.locator('.qa-materials')).toContainText('合成原补充材料.pdf');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.locator('.qa-materials').scrollIntoViewIfNeeded();await capture(page,`supplement-saved-${width}`);await assertQaUpload11th(page,state);
 });
 test(`QA Word recovery confirms the original upload before an explicit original free prepare at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});const state=await open(page);state.deduplicate=true;await pending(page,state,true);state.completeUnavailable=false;
  await confirm(page).click();await expect(row(page).getByRole('button',{name:'继续文件处理',exact:true})).toBeVisible();expect(state.qa.prepares).toEqual([]);
  await row(page).scrollIntoViewIfNeeded();await capture(page,`source-saved-${width}`);state.qa.dropPrepare='after';
  await row(page).getByRole('button',{name:'继续文件处理',exact:true}).click();await expect.poll(()=>state.qa.prepares.length).toBe(1);await expect(page.locator('#qa-retry-pending')).toBeVisible();const body=structuredClone(state.qa.prepares[0]);
  const writes=qaTransportWrites(state).length;await page.reload();await expect(page.locator('#qa-retry-pending')).toBeVisible();expect(state.qa.prepares).toEqual([body]);expect(qaTransportWrites(state)).toHaveLength(writes);
  await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.qa.prepares.length).toBe(2);expect(state.qa.prepares).toEqual([body,body]);expect(state.qa.accepted.size).toBe(1);
  expect(state.uploads.size).toBe(1);expect(state.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect([...state.uploads.values()][0].declaration.media_type).toBe('application/msword');await assertQaUpload11th(page,state);
 });
}
test('QA initial uninterrupted Word selection retains the existing free identification path',async({page})=>{
 const state=qaUploadFixture();state.lostPut=false;state.completeUnavailable=false;await open(page,state);await page.locator('#qa-upload').setInputFiles(qaUploadFile('合成正常问题清单.doc'));
 await expect.poll(()=>state.qa.prepares.length).toBe(1);expect(state.qa.accepted.size).toBe(1);await expect(row(page)).toHaveCount(0);await assertQaUpload11th(page,state);
});
test('QA refuses changed original bytes before replacing a missing upload and keeps renamed equal content',async({page})=>{
 const state=qaUploadFixture();state.lostPut=false;await open(page,state);const file=await pending(page,state);
 // The PUT was acknowledged; the original session is now explicitly absent.
 // Recovery must still authorize the original project and verify original bytes.
 state.missingUploads.add([...state.uploads.keys()][0]);state.completeUnavailable=false;
 await confirm(page).click();const reselect=row(page).locator('[data-qa-upload-reselect]');await expect(reselect).toBeEnabled();const changed=Buffer.from(file.buffer);changed[0]^=1;
 await reselect.setInputFiles({...file,buffer:changed});await expect(row(page).getByRole('alert')).toHaveText('上传恢复记录发生冲突，原文件声明和记录已保留，请勿改用其他文件继续。');expect(state.uploads.size).toBe(1);expect(state.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
 const originalFile=row(page).locator('[data-qa-upload-reselect]');await expect(originalFile).toBeEnabled();await originalFile.setInputFiles({...file,name:'改名但仍是原材料.pdf'});await expect(row(page)).toHaveCount(0);expect(state.uploads.size).toBe(2);expect([...state.uploads.values()][1].declaration).toEqual([...state.uploads.values()][0].declaration);await assertQaUpload11th(page,state);
});

test('QA unknown PUT and a generic unreadable rejection do not authorize replacing the original bytes',async({page})=>{
 const state=qaUploadFixture();state.dropBeforeReceive=true;state.lostPut=false;state.completeUnavailable=false;await open(page,state);await pending(page,state);
 const writes=qaTransportWrites(state).length;await confirm(page).click();await expect(row(page).getByRole('alert')).toContainText('材料尚未满足当前处理条件');
 await expect(row(page).locator('[data-qa-upload-reselect]')).toHaveCount(0);expect(qaTransportWrites(state)).toHaveLength(writes);
 expect(state.uploads.size).toBe(1);expect(state.calls.filter(c=>c.method==='PUT')).toHaveLength(1);await assertQaUpload11th(page,state);
});
test('QA server preparation changed while the original complete was pending never adopts the material into another round',async({page})=>{
 const state=await open(page);await pending(page,state);state.completeUnavailable=false;let release!:()=>void;state.completeGate=()=>new Promise<void>(r=>{release=r;});await confirm(page).click();await expect.poll(()=>state.activeCompletes).toBe(1);
 state.qa.workspace.revision++;state.qa.workspace.draft.requirements='另一页面的新要求';release();await expect(row(page)).toContainText('没有加入当前另一轮');
 const saved=await local(page);expect(saved.status==='valid'&&saved.value.draft.requirements).not.toBe('另一页面的新要求');expect(state.qa.workspace.draft.requirements).toBe('另一页面的新要求');await assertQaUpload11th(page,state);
});
test('QA lost local envelope write keeps the original selected file visible and starts no upload',async({page})=>{
 await page.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('bb-qa-upload-v1:'))throw new DOMException('Synthetic quota','QuotaExceededError');return set.call(this,k,v);};});
 const state=await open(page),file=qaUploadFile();await page.locator('#qa-supplement').setInputFiles(file);await expect(page.locator('.qa-materials')).toContainText(file.name);await expect(page.locator('.qa-materials')).toContainText('无法可靠保存');expect(qaTransportWrites(state)).toEqual([]);await assertQaUpload11th(page,state);
});
test('QA late original-owner completion cannot restore private filename or mutate preparation after the session changed',async({page})=>{
 const state=await open(page),file=await pending(page,state);state.completeUnavailable=false;let release!:()=>void;state.completeGate=()=>new Promise<void>(r=>{release=r;});await confirm(page).click();await expect.poll(()=>state.activeCompletes).toBe(1);
 state.qa.owner=otherOwnerId;await page.evaluate(()=>{const c=new BroadcastChannel('bondbuddy-session');c.postMessage('changed');c.close();});await expect(page.getByRole('heading',{name:'登录工作区',exact:true})).toBeVisible();release();await expect.poll(()=>state.activeCompletes).toBe(0);
 await expect(page.locator('body')).not.toContainText(file.name);expect(state.calls.filter(c=>c.owner===otherOwnerId&&c.method!=='GET')).toEqual([]);await assertQaUpload11th(page,state);
});
