import {expect,test,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertFixture,checkId,exportId,otherOwnerId,ownerId,projectId,sha} from './integrity-continuation-fixtures';
import {installUpload,uploadFixture,type UploadState} from './integrity-upload-eleventh-fixtures';
import {installEleventhReference} from './upload-eleventh-reference';

const reference=process.env.BB_ELEVENTH_REFERENCE==='1';
const route=`/#integrity?project=${projectId}&run=${exportId}`;
const bytes=Buffer.from('Synthetic eleventh evidence PDF bytes; not an inspected real PDF.');
const pdf={name:'合成原事项证据.pdf',mimeType:'application/pdf',buffer:bytes};
const modal=(page:Page)=>page.locator('.integrity-modal[open]');
const cacheKey=`bb-integrity-recovery:${ownerId}:${projectId}`;
test.afterEach(async({page})=>assertFixture(page));
async function open(page:Page,state=uploadFixture()){
 await page.addInitScript(({key,owner,project,draft,revision,roundId})=>{if(localStorage.getItem(key))return;localStorage.setItem(key,JSON.stringify({version:'integrity-recovery-cache-v1',owner,project,value:{revision,draft,evidenceDraft:{roundId,subjectId:'company-a',siteId:'credit-china',url:'https://www.creditchina.gov.cn/',time:'',note:'',conclusion:'unresolved'}}}));},{key:cacheKey,owner:ownerId,project:projectId,draft:state.workspace.draft,revision:state.workspace.revision,roundId:checkId});
 await installUpload(page,state);page.on('dialog',dialog=>void dialog.accept());await page.goto(route);await expect(page.locator('#integrity-records')).toBeVisible();return state;
}
async function evidence(page:Page){await page.locator('#integrity-resume-evidence').click();await expect(page.locator('#integrity-evidence-form')).toBeVisible();}
async function fill(page:Page){await modal(page).locator('[name=time]').fill('2026-10-24T10:20');await modal(page).locator('[name=note]').fill('合成核对：原发行人与原网站事项，实际查询时间和结论保持不变。');}
async function choose(page:Page,input=pdf){await modal(page).locator('[name=file]').setInputFiles(input);}
async function unknown(page:Page,state:UploadState){state.unavailable=true;await evidence(page);await fill(page);await choose(page);await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();expect(state.manuals).toEqual([]);expect(state.uploads).toHaveLength(1);}
async function reopen(page:Page){await page.reload();await expect(page.locator('#integrity-records')).toBeVisible();await page.locator('#integrity-resume-evidence').click();await expect(page.locator('#integrity-confirm-upload')).toBeVisible();}
const noBusiness=(s:UploadState)=>{expect(s.manuals).toEqual([]);expect(s.drafts).toEqual([]);expect(s.checks).toEqual([]);expect(s.exports).toEqual([]);};
async function stored(page:Page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).value,cacheKey);}

test.describe('integrity eleventh functional',()=>{
 test.skip(reference,'Old-component comparison runs only the two visual cases.');
 test('file selection uploads automatically before evidence confirmation and sends the exact original pin',async({page})=>{
  const state=await open(page);await evidence(page);await fill(page);await choose(page);await expect(page.locator('#integrity-selected-evidence')).toContainText('文件已保存');noBusiness(state);await page.locator('#integrity-evidence-save').click();await expect.poll(()=>state.manuals.length).toBe(1);
  expect(state.uploads).toHaveLength(1);expect(state.puts).toHaveLength(1);expect(state.completes).toEqual(['synthetic-eleventh-u-1']);expect(state.manuals[0].checkId).toBe(checkId);expect(state.manuals[0].body.subject_id).toBe('company-a');expect(state.manuals[0].body.site_id).toBe('credit-china');expect(state.manuals[0].body.material.sha256).toBe(sha(bytes.toString()));expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);
 });
 for(const width of [1440,390])test(`${width}: refresh is read-only and no-File original completion accepts legal old upload ID`,async({page})=>{
  await page.setViewportSize({width,height:900});const state=await open(page);state.deduplicate=true;await unknown(page,state);const original=await stored(page),count=state.completes.length;await reopen(page);
  expect(state.completes).toHaveLength(count);expect(state.uploads).toHaveLength(1);expect(state.puts).toHaveLength(1);noBusiness(state);await expect(modal(page).locator('[name=file]')).toHaveValue('');await expect(modal(page).locator('[name=time]')).toHaveValue(original.evidenceDraft.time);
  state.unavailable=false;await page.locator('#integrity-confirm-upload').click();await expect(page.locator('#integrity-evidence-save')).toBeEnabled();await expect(page.locator('#integrity-confirm-upload')).toHaveCount(0);noBusiness(state);expect(state.uploads).toHaveLength(1);expect(state.puts).toHaveLength(1);
  const retained=await stored(page);expect(retained.evidenceDraft.material).toEqual({source_project_id:projectId,material_id:'synthetic-eleventh-evidence',material_version:4,sha256:sha(bytes.toString())});expect(retained.evidenceDraft.subjectId).toBe('company-a');expect(state.sessions.get('synthetic-eleventh-u-1')!.material!.upload_id).toBe('original-reused-upload-id');
  await page.locator('#integrity-evidence-save').click();await expect.poll(()=>state.manuals.length).toBe(1);expect(state.manuals[0].body.material).toEqual(retained.evidenceDraft.material);expect(state.calls.some(call=>call.method==='GET'&&call.path.endsWith('/materials/synthetic-eleventh-evidence')&&call.search==='?version=4')).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
 test('unknown PUT checks the original completion before sending the file again',async({page})=>{
  const state=await open(page);state.putFault='after';await evidence(page);await fill(page);await choose(page);await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();expect(state.completes).toEqual([]);await reopen(page);await page.locator('#integrity-confirm-upload').click();await expect(page.locator('#integrity-confirm-upload')).toHaveCount(0);expect(state.completes).toEqual(['synthetic-eleventh-u-1']);expect(state.puts).toHaveLength(1);expect(state.uploads).toHaveLength(1);noBusiness(state);
 });
 test('missing bytes require the same selected file; a different file never creates a replacement',async({page})=>{
  const state=await open(page);state.putFault='before';await evidence(page);await fill(page);await choose(page);await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();await reopen(page);await page.locator('#integrity-confirm-upload').click();await expect(modal(page).locator('[role=status]').last()).toContainText('相同内容的文件');expect(state.uploads).toHaveLength(1);
  await choose(page,{...pdf,buffer:Buffer.from('Different evidence content')});await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();expect(state.uploads).toHaveLength(1);noBusiness(state);
  await choose(page);await expect(page.locator('#integrity-confirm-upload')).toHaveCount(0);expect(state.uploads).toHaveLength(2);expect(state.puts).toHaveLength(2);noBusiness(state);
 });
 for(const field of ['sha256','byte_size','media_type','role'] as const)test(`a schema-valid ${field} mismatch never reaches the evidence form or business POST`,async({page})=>{
  const state=await open(page);state.mismatch=field;await evidence(page);await fill(page);await choose(page);await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();expect((await stored(page)).evidenceDraft.material).toBeUndefined();noBusiness(state);expect(state.uploads).toHaveLength(1);
 });
 test('another page changing the full form before retry stops transport and preserves the foreign cache',async({page})=>{
  const state=await open(page);await unknown(page,state);const original=await stored(page);const foreign={...original,evidenceDraft:{...original.evidenceDraft,note:'另一页面保留的不同说明。'}};
  await page.evaluate(({key,value})=>{const wrapper=JSON.parse(localStorage.getItem(key)!);wrapper.value=value;localStorage.setItem(key,JSON.stringify(wrapper));}, {key:cacheKey,value:foreign});const count=state.completes.length;await page.locator('#integrity-confirm-upload').click();await expect(modal(page).locator('[role=status]').last()).not.toHaveText('');expect(state.completes).toHaveLength(count);expect(await stored(page)).toEqual(foreign);noBusiness(state);
 });
 test('a late old-owner completion cannot associate a pin or submit evidence for the next account',async({page})=>{
  const state=await open(page);let release!:()=>void;state.holdComplete=new Promise<void>(resolve=>{release=resolve;});await evidence(page);await fill(page);await choose(page);await expect.poll(()=>state.completeEntered).toBe(true);state.owner=otherOwnerId;await page.reload();release();await expect(page.locator('#integrity-confirm-upload')).toHaveCount(0);noBusiness(state);expect(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.includes('upload-recovery')&&key.includes('synthetic-integrity-owner-b')))).toBe(false);
 });
 test('storage failure blocks upload creation before any network or evidence write',async({page})=>{
  const state=await open(page);await evidence(page);await fill(page);await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('Synthetic quota failure','QuotaExceededError');};});await choose(page);await expect(page.locator('#integrity-evidence-save')).toBeDisabled();await expect(page.locator('#integrity-status')).toContainText('本机保存暂不可用');expect(state.uploads).toEqual([]);expect(state.puts).toEqual([]);noBusiness(state);
 });
 test('a refused browser lock leaves the same prepared identity and performs no upload request',async({page})=>{
  const state=await open(page);await evidence(page);await fill(page);await page.evaluate(()=>{Object.defineProperty(navigator,'locks',{configurable:true,value:{request:()=>Promise.reject(new Error('Synthetic denied lock'))}});});await choose(page);await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();expect(state.uploads).toEqual([]);expect((await stored(page)).evidenceDraft.uploadOperationId).toEqual(expect.any(String));noBusiness(state);
 });
 test('a missing known transport record stops without creating another upload',async({page})=>{
  const state=await open(page);await unknown(page,state);await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('bondbuddy:upload-recovery:v1:'))localStorage.removeItem(key);});const count=state.completes.length;await page.locator('#integrity-confirm-upload').click();await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();expect(state.completes).toHaveLength(count);expect(state.uploads).toHaveLength(1);noBusiness(state);
 });
 test('an unlinked original record exposes only local cleanup and never revives the lost form or pin',async({page})=>{
  const state=await open(page);await unknown(page,state);
  await page.evaluate(key=>{const wrapper=JSON.parse(localStorage.getItem(key)!);delete wrapper.value.evidenceDraft.uploadOperationId;localStorage.setItem(key,JSON.stringify(wrapper));},cacheKey);
  const count=state.completes.length;await page.reload();await page.locator('#integrity-resume-evidence').click();await expect(page.locator('[data-integrity-stop-orphan]')).toBeEnabled();await expect(page.locator('#integrity-confirm-upload')).toHaveCount(0);await expect(page.locator('#integrity-upload-recovery')).toContainText(pdf.name);await expect(page.locator('#integrity-evidence-save')).toBeDisabled();noBusiness(state);
  await page.locator('[data-integrity-stop-orphan]').click();await expect(page.locator('[data-integrity-stop-orphan]')).toHaveCount(0);await expect(page.locator('#integrity-evidence-save')).toBeEnabled();expect(state.completes).toHaveLength(count);expect(state.uploads).toHaveLength(1);expect((await stored(page)).evidenceDraft.material).toBeUndefined();noBusiness(state);
 });
 test('stopping local tracking keeps server bytes and does not save, delete, export or start a check',async({page})=>{
  const state=await open(page);await unknown(page,state);await page.locator('#integrity-stop-upload').click();await expect(page.locator('#integrity-confirm-upload')).toHaveCount(0);expect((await stored(page)).evidenceDraft.uploadOperationId).toBeUndefined();expect(state.sessions.get('synthetic-eleventh-u-1')!.received).toBe(true);expect(state.calls.filter(call=>call.method==='DELETE')).toEqual([]);noBusiness(state);
 });
 test('an unknown original evidence request keeps its request ID after refresh and never restarts upload',async({page})=>{
  const state=await open(page);state.dropManual='before';await evidence(page);await fill(page);await choose(page);await expect(page.locator('#integrity-selected-evidence')).toContainText('文件已保存');noBusiness(state);await page.locator('#integrity-evidence-save').click();await expect.poll(()=>state.manuals.length).toBe(1);await expect(page.locator('#integrity-retry-pending')).toBeEnabled();const body=structuredClone(state.manuals[0]);await page.reload();await expect(page.locator('#integrity-retry-pending')).toBeEnabled();expect(state.uploads).toHaveLength(1);await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.manuals.length).toBe(2);expect(state.manuals).toEqual([body,body]);expect(state.puts).toHaveLength(1);expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);
 });
});

for(const width of [1440,390])test(`${width}: integrity eleventh visual comparison in the original evidence form`,async({page})=>{
 await page.setViewportSize({width,height:900});const finalize=reference?await installEleventhReference(page,['integrity-workspace']):undefined;
 await page.addInitScript(({key,owner,project,check,hash,isReference,size})=>{
  const evidenceDraft={roundId:check,subjectId:'company-a',siteId:'credit-china',url:'https://www.creditchina.gov.cn/',time:'2026-10-24T10:20',note:'合成原事项：上传结果待确认，尚未提交补证。',conclusion:'unresolved',uploadOperationId:'synthetic-visual-operation'};
  const draft={subjects:[{id:'current-company',kind:'company',name:'当前准备企业有限公司',identifier:'',role:'待核查',province:'北京',city:''}],site_ids:['csrc'],notes:'服务器当前准备，与历史名单不同。'};
  const {uploadOperationId:_operation,...oldForm}=evidenceDraft;
  localStorage.setItem(key,JSON.stringify({version:'integrity-recovery-cache-v1',owner,project,value:{revision:10,draft,evidenceDraft:isReference?oldForm:evidenceDraft}}));
  if(isReference)return;
  const record={version:1,id:evidenceDraft.uploadOperationId,owner,projectId:project,purpose:'integrity-evidence',declaration:{filename:'合成原事项证据.pdf',media_type:'application/pdf',role:'other',byte_size:size,sha256:hash},context:{kind:'integrity-evidence',roundId:check,subjectId:'company-a',siteId:'credit-china'},stage:'confirming',uploadId:'synthetic-visual-u',expiresAt:'2026-10-25T10:00:00Z'};
  localStorage.setItem(`bondbuddy:upload-recovery:v1:${owner}:${project}:integrity-evidence:${record.id}:slot`,JSON.stringify(record));
 },{key:cacheKey,owner:ownerId,project:projectId,check:checkId,hash:sha(bytes.toString()),isReference:reference,size:bytes.length});
 const state=await open(page);await page.locator('#integrity-resume-evidence').click();await expect(page.locator('#integrity-evidence-form')).toBeVisible();if(!reference)await expect(page.locator('#integrity-confirm-upload')).toBeEnabled();noBusiness(state);expect(state.uploads).toEqual([]);expect(state.puts).toEqual([]);expect(state.completes).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const directory=process.env.BB_UX_EVIDENCE_DIR;
 if(directory){await mkdir(directory,{recursive:true});await page.locator('#integrity-evidence-save').scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,`upload-eleventh-integrity-${reference?'reference-r10':'implementation'}-form-${width}.png`),fullPage:false});await writeFile(join(directory,`upload-eleventh-integrity-${reference?'reference-r10':'implementation'}-form-${width}.json`),JSON.stringify({width,height:900,scope:'Original evidence form at its save action, synthetic HTTP, no business writes',scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth),...(finalize?{reference:await finalize()}:{})},null,2));}
 else if(finalize)await finalize();
});
