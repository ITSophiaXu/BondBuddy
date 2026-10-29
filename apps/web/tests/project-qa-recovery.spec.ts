import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
import {expect,test,type Page} from '@playwright/test';
import {PROJECT_QA_PRICE} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';
import {QaRecoveryCache,type QaRecoveryValue} from '../src/qa-recovery-cache';
import {answerId,assertFixture,checked,fixture,historicalRecords,install,newMaterial,oldArtifact,oldMaterial,originalDraft,ownerId,projectId,
  qaWrites,workspaceReads,writes,type State} from './project-qa-continuation-fixtures';

// Adversarial browser-only recovery over the frozen public HTTP fixture. No real
// Word generation, model calls, credit settlement or production delivery occurs.
const url=(run:string|null=answerId)=>`/#qa?project=${projectId}${run?`&run=${run}`:''}`;
const selectedIds=(page:Page)=>page.locator('[data-remove-q]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.removeQ));
test.beforeEach(async({page})=>{page.on('dialog',dialog=>void dialog.accept());});
test.afterEach(async({page})=>{await assertFixture(page);});

async function open(page:Page,state=fixture(),run:string|null=answerId){await install(page,state);await page.goto(url(run));await expect(page.locator('#qa-history')).toBeVisible();if(await page.locator('.qa-followup').count())await page.locator('.qa-followup>summary').click();return state;}
async function adopt(page:Page){if(await page.locator('.qa-followup').getAttribute('open')===null)await page.locator('.qa-followup>summary').click();await page.locator('#qa-continue').click();await expect(page.locator('#qa-requirements')).toBeVisible();await expect(page.locator('#qa-save')).toBeEnabled();}
async function start(page:Page){await page.locator('#qa-start').click();}
async function frozen(page:Page){
  // Check the native fieldset property and actual inherited control behavior.
  await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',true);
  await expect(page.locator('#qa-requirements')).toBeDisabled();await expect(page.locator('#qa-save')).toBeDisabled();await expect(page.locator('#qa-start')).toBeDisabled();
  await expect(page.locator('#qa-history')).toBeDisabled();await expect(page.locator('#qa-upload')).toBeDisabled();
}
async function closeModal(page:Page){const modal=page.locator('.qa-modal[open]');if(await modal.isVisible()){await expect(modal.locator('[data-close]')).toBeEnabled();await modal.locator('[data-close]').click();}}
async function storageEntries(page:Page){return page.evaluate(()=>Object.fromEntries(Array.from({length:localStorage.length},(_,index)=>{const key=localStorage.key(index)!;return [key,localStorage.getItem(key)!];})));}
async function peekRecovery(page:Page){
  // Use the exported cache reader with a real browser storage snapshot. Do not
  // guess its key, wrapper shape, optional fields, or private implementation data.
  const entries=await storageEntries(page);
  const storage={getItem:(key:string)=>entries[key]??null,setItem:()=>{throw Error('Read-only synthetic snapshot');},removeItem:()=>{throw Error('Read-only synthetic snapshot');}};
  return new QaRecoveryCache(ownerId,projectId,storage).read();
}
async function readRecovery(page:Page):Promise<QaRecoveryValue>{
  const result=await peekRecovery(page);expect(result.status).toBe('valid');
  if(result.status!=='valid')throw Error(`Expected a valid QA recovery snapshot, received ${result.status}`);
  return structuredClone(result.value);
}
async function clearOnlyMainRecovery(page:Page){
  // Ask the public cache API which key it clears; leave the independent journal
  // untouched, without inventing either storage implementation's private shape.
  const entries=await storageEntries(page);let removed:string|undefined;
  const storage={getItem:(key:string)=>entries[key]??null,setItem:()=>{throw Error('Unexpected write during clear');},removeItem:(key:string)=>{removed=key;delete entries[key];}};
  expect(new QaRecoveryCache(ownerId,projectId,storage).clear().status).toBe('empty');expect(removed).toEqual(expect.any(String));
  await page.evaluate(key=>localStorage.removeItem(key),removed!);
}
async function blockStorageWrites(page:Page){await page.evaluate(()=>{
  const target=window as Window&{__syntheticQaOriginalSetItem?:Storage['setItem']};
  target.__syntheticQaOriginalSetItem=Storage.prototype.setItem;
  Storage.prototype.setItem=()=>{throw new DOMException('Synthetic storage failure after request submission','QuotaExceededError');};
});}
async function restoreStorageWrites(page:Page){await page.evaluate(()=>{
  const target=window as Window&{__syntheticQaOriginalSetItem?:Storage['setItem']};
  if(target.__syntheticQaOriginalSetItem){Storage.prototype.setItem=target.__syntheticQaOriginalSetItem;delete target.__syntheticQaOriginalSetItem;}
});}
async function failPersistenceAfterPost(page:Page,kind:'draft'|'answer'|'prepare'){
  const capture:{value?:QaRecoveryValue;body?:unknown}={},suffix=kind==='answer'?'runs':kind;
  await page.route(`**/api/v1/projects/${projectId}/qa/${suffix}`,async route=>{
    if(route.request().method()!=='POST'||capture.value)return route.fallback();
    const body:unknown=fixtureRequest(route.request());checked(kind==='draft'?'QaDraftRequest':kind==='answer'?'QaAnswerRequest':'QaPrepareRequest',body);
    capture.body=structuredClone(body);capture.value=await readRecovery(page);expect(capture.value.pending?.kind).toBe(kind);expect(capture.value.pending?.request).toEqual(body);
    await blockStorageWrites(page);await route.fallback();
  });return capture;
}
async function recoverStorage(page:Page){await closeModal(page);await expect(page.locator('#qa-recheck-cache')).toBeEnabled();await restoreStorageWrites(page);await page.locator('#qa-recheck-cache').click();}
async function secondary(page:Page,state:State){const second=await page.context().newPage();second.on('dialog',dialog=>void dialog.accept());second.on('pageerror',error=>state.errors.push(error.message));return second;}

test('draft acknowledgement with a failed local write retains the full original pending revision and recovers through GET only',async({page})=>{
  const state=await open(page);await adopt(page);const capture=await failPersistenceAfterPost(page,'draft');await page.locator('#qa-save').click();
  await expect.poll(()=>state.drafts.length).toBe(1);await expect(page.locator('#qa-recheck-cache')).toBeVisible();await frozen(page);
  expect(state.workspace.revision).toBe(11);const original=capture.value!;expect(original.revision).toBe(10);expect(original.pending?.kind).toBe('draft');expect(await readRecovery(page)).toEqual(original);
  await recoverStorage(page);await expect(page.locator('#qa-refresh-pending')).toBeEnabled();expect(await readRecovery(page)).toEqual(original);
  const reads=workspaceReads(state).length;await page.locator('#qa-refresh-pending').click();await expect.poll(()=>workspaceReads(state).length).toBeGreaterThan(reads);
  await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',false);await expect(page.locator('#qa-requirements')).toBeEditable();
  const recovered=await readRecovery(page);expect(recovered.pending).toBeUndefined();expect(recovered.revision).toBe(11);expect(recovered.draft).toEqual(state.drafts[0].draft);
  expect(state.drafts).toHaveLength(1);expect(state.answers).toEqual([]);expect(state.prepares).toEqual([]);
});

test('answer acknowledgement with a failed local write keeps the original complete envelope and retries without a second accepted run',async({page})=>{
  const state=await open(page),old=historicalRecords(state);await adopt(page);const capture=await failPersistenceAfterPost(page,'answer');await start(page);
  await expect.poll(()=>state.answers.length).toBe(1);await expect(page.locator('#qa-recheck-cache')).toBeVisible();await frozen(page);
  const original=capture.value!,body=structuredClone(state.answers[0]);expect(original.revision).toBe(body.expected_revision);expect(original.pending).toEqual({kind:'answer',request:body});expect(await readRecovery(page)).toEqual(original);expect(state.accepted.size).toBe(1);
  await recoverStorage(page);await expect(page.locator('#qa-retry-pending')).toBeEnabled();expect(await readRecovery(page)).toEqual(original);
  await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.answers.length).toBe(2);await expect(page.locator('#qa-retry-pending')).toHaveCount(0);
  expect(state.answers).toEqual([body,body]);expect(state.drafts).toHaveLength(1);expect(state.accepted.size).toBe(1);expect((await readRecovery(page)).pending).toBeUndefined();expect(historicalRecords(state)).toEqual(old);
});

test('free preparation acknowledgement with a failed local write keeps the original source pin and recovers without another upload',async({page})=>{
  const state=await open(page);state.allowUploads=true;const capture=await failPersistenceAfterPost(page,'prepare');
  await page.locator('#qa-upload').setInputFiles({name:'合成恢复问题清单.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic recovery upload, not a real Word file')});
  await expect.poll(()=>state.prepares.length).toBe(1);await expect(page.locator('#qa-recheck-cache')).toBeVisible();await frozen(page);
  const original=capture.value!,body=structuredClone(state.prepares[0]);expect(original.revision).toBe(10);expect(original.pending).toEqual({kind:'prepare',request:body});expect(await readRecovery(page)).toEqual(original);
  await recoverStorage(page);await expect(page.locator('#qa-retry-pending')).toBeEnabled();await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.prepares.length).toBe(2);await expect(page.locator('#qa-retry-pending')).toHaveCount(0);
  expect(state.prepares).toEqual([body,body]);expect(state.accepted.size).toBe(1);expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.drafts).toEqual([]);expect(state.answers).toEqual([]);
});

for(const code of ['CSRF_DENIED','NOT_FOUND'] as const)test(`an unknown accepted answer keeps pending when its later retry receives ${code}`,async({page})=>{
  const state=await open(page);await adopt(page);state.dropAnswer='after';await start(page);await expect.poll(()=>state.answers.length).toBe(1);await expect(page.locator('#qa-retry-pending')).toBeEnabled();
  const original=await readRecovery(page),body=structuredClone(state.answers[0]),rejected:Dto<'QaAnswerRequest'>[]=[];let once=true;
  await page.route(`**/api/v1/projects/${projectId}/qa/runs`,async route=>{
    if(route.request().method()!=='POST'||!once)return route.fallback();once=false;
    const request:unknown=fixtureRequest(route.request());checked('QaAnswerRequest',request);rejected.push(structuredClone(request));
    return route.fulfill({status:code==='CSRF_DENIED'?403:404,json:fixtureBody(route,{code})});
  });
  await page.locator('#qa-retry-pending').click();await expect.poll(()=>rejected.length).toBe(1);await expect(page.locator('#qa-retry-pending')).toBeEnabled();await frozen(page);
  expect(rejected).toEqual([body]);expect(await readRecovery(page)).toEqual(original);expect(state.accepted.size).toBe(1);expect(state.drafts).toHaveLength(1);
  await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.answers.length).toBe(2);await expect(page.locator('#qa-retry-pending')).toHaveCount(0);
  expect(state.answers).toEqual([body,body]);expect(state.accepted.size).toBe(1);
});

test('another page changing the same cache scope freezes this page while preserving its input and requires explicit adoption',async({page})=>{
  const state=await open(page);await adopt(page);const localText='本页尚未提交的要求：保留现金流核对。',foreignText='另一页本机准备：补充关联交易核对。';
  await page.locator('#qa-requirements').fill(localText);const second=await secondary(page,state);
  try{
    await second.goto(url(null));await expect(second.locator('#qa-requirements')).toHaveValue(localText);await second.locator('#qa-requirements').fill(foreignText);
    await expect(page.locator('#qa-recheck-cache')).toBeEnabled();await frozen(page);await expect(page.locator('#qa-requirements')).toHaveValue(localText);expect(writes(state)).toEqual([]);
    await page.locator('#qa-recheck-cache').click();await expect(page.locator('#qa-use-stored')).toBeVisible();await expect(page.locator('.qa-recovery')).toContainText(localText);await expect(page.locator('.qa-recovery')).toContainText(foreignText);
    await expect(page.locator('#qa-requirements')).toHaveValue(localText);expect(writes(state)).toEqual([]);
    await page.locator('#qa-use-stored').click();await expect(page.locator('#qa-requirements')).toHaveValue(foreignText);await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',false);await expect(page.locator('#qa-requirements')).toBeEditable();
    expect(writes(state)).toEqual([]);expect((await readRecovery(page)).draft.requirements).toBe(foreignText);
  }finally{await second.close();}
});

for(const useServer of [false,true])test(`a real server CAS conflict preserves both complete drafts until explicit ${useServer?'server':'local'} choice`,async({page})=>{
  const state=await open(page);await adopt(page);const localText='本机要求：保留所选两题与旧材料。',serverText='服务器并发要求：仅核对第三版材料。';
  await page.locator('#qa-requirements').fill(localText);const local=await readRecovery(page);
  state.workspace.revision++;state.workspace.draft={...originalDraft(),requirements:serverText};const server=structuredClone(state.workspace);
  await page.locator('#qa-save').click();await expect.poll(()=>state.drafts.length).toBe(1);await expect(page.locator('#qa-keep-local')).toBeVisible();await expect(page.locator('#qa-use-server')).toBeVisible();await frozen(page);
  expect(state.drafts[0]).toEqual({expected_revision:10,draft:local.draft});expect(state.workspace.draft).toEqual(server.draft);
  await page.locator('.qa-recovery > details > summary').click();await expect(page.locator('.qa-recovery')).toContainText(localText);await expect(page.locator('.qa-recovery')).toContainText(serverText);
  await page.locator(useServer?'#qa-use-server':'#qa-keep-local').click();await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',false);await expect(page.locator('#qa-requirements')).toBeEditable();
  expect(state.drafts).toHaveLength(1);expect(state.answers).toEqual([]);expect(state.prepares).toEqual([]);
  if(useServer){
    await expect(page.locator('#qa-requirements')).toHaveValue(serverText);await expect.poll(()=>selectedIds(page)).toEqual(['q4']);expect((await readRecovery(page)).draft).toEqual(server.draft);expect((await readRecovery(page)).revision).toBe(11);
  }else{
    await expect(page.locator('#qa-requirements')).toHaveValue(localText);await expect.poll(()=>selectedIds(page)).toEqual(['q2','q7']);expect((await readRecovery(page)).draft).toEqual(local.draft);expect((await readRecovery(page)).revision).toBe(11);
    await page.locator('#qa-save').click();await expect.poll(()=>state.drafts.length).toBe(2);expect(state.drafts[1]).toEqual({expected_revision:11,draft:local.draft});expect(state.workspace.revision).toBe(12);
  }
});

for(const malformed of ['duplicate','unknown'] as const)test(`schema-only defensive ${malformed} answer mapping cannot be adopted or submitted`,async({page})=>{
  // These malformed mappings satisfy the public DTO's array schema only. They
  // are not legal successful Word deliveries or worker acceptance evidence.
  const state=fixture(),run=state.workspace.runs.find(value=>value.run_id===answerId)!;
  if(malformed==='duplicate')run.result!.answers.push(structuredClone(run.result!.answers[0]));else run.result!.answers[0].question_id='q999';
  await open(page,state);await expect(page.locator('.qa-followup [role=alert]')).toBeVisible();await expect(page.locator('.qa-followup fieldset')).toHaveJSProperty('disabled',true);
  await expect(page.locator('[data-qa-followup]').first()).toBeDisabled();await expect(page.locator('#qa-continue')).toBeDisabled();await expect(page.locator('#qa-start')).toHaveCount(0);expect(writes(state)).toEqual([]);
});

test('an unavailable historical material version remains selected and blocks answering until explicitly removed',async({page})=>{
  const state=fixture();state.workspace.materials=state.workspace.materials.filter(material=>material.asset.pin.sha256!==oldMaterial.pin.sha256);await open(page,state);await adopt(page);
  await expect(page.locator('[data-qa-material="missing"]')).toBeChecked();await expect(page.locator('.qa-materials')).toContainText('原材料版本暂不可用');
  await expect(page.locator('#qa-start')).toBeDisabled();await expect(page.locator('.qa-materials label').filter({hasText:'合成业务报告_v3.pdf'}).locator('input')).not.toBeChecked();
  expect((await readRecovery(page)).draft.materials).toEqual([oldMaterial,oldArtifact]);expect(qaWrites(state)).toEqual([]);
  await page.locator('[data-qa-material="missing"]').focus();await expect(page.locator('[data-qa-material="missing"]')).toBeFocused();await page.keyboard.press('Space');await expect(page.locator('[data-qa-material="missing"]')).toHaveCount(0);await expect(page.locator('#qa-start')).toBeEnabled();expect((await readRecovery(page)).draft.materials).toEqual([oldArtifact]);
  expect((await readRecovery(page)).draft.materials).not.toContainEqual(newMaterial);expect(qaWrites(state)).toEqual([]);
});

test('unchanged owner project and draft revision produce the same execution key across pages and one accepted run',async({page})=>{
  const ready=fixture();ready.workspace.draft.materials.push(structuredClone(oldArtifact));
  const state=await open(page,ready,null),old=historicalRecords(state);await expect(page.locator('#qa-start')).toBeEnabled();await start(page);await expect.poll(()=>state.answers.length).toBe(1);await expect(page.locator('#qa-confirm')).toHaveCount(0);
  const body=structuredClone(state.answers[0]);expect(body.expected_revision).toBe(10);expect(body.expected_points).toBe(PROJECT_QA_PRICE.points);expect(state.drafts).toEqual([]);expect(state.accepted.size).toBe(1);
  const second=await secondary(page,state);
  try{
    await second.goto(url(null));await expect(second.locator('#qa-requirements')).toHaveValue(originalDraft().requirements);await expect(second.locator('#qa-start')).toBeEnabled();await start(second);await expect.poll(()=>state.answers.length).toBe(2);await expect(second.locator('#qa-confirm')).toHaveCount(0);
    expect(state.answers).toEqual([body,body]);expect(state.accepted.size).toBe(1);expect(state.drafts).toEqual([]);expect(state.prepares).toEqual([]);expect(historicalRecords(state)).toEqual(old);
  }finally{await second.close();}
});

test('another page acknowledging the same request cannot make this page discard its original pending through draft adoption',async({page})=>{
  const state=await open(page);await adopt(page);state.dropAnswer='after';await start(page);await expect.poll(()=>state.answers.length).toBe(1);await expect(page.locator('#qa-retry-pending')).toBeEnabled();
  const original=await readRecovery(page),body=structuredClone(state.answers[0]),second=await secondary(page,state);
  try{
    await second.goto(url(null));await expect(second.locator('#qa-retry-pending')).toBeEnabled();await second.locator('#qa-retry-pending').click();await expect.poll(()=>state.answers.length).toBe(2);await expect(second.locator('#qa-retry-pending')).toHaveCount(0);
    await expect(second).toHaveURL(/run=synthetic-qa-answer-/);
    await expect.poll(async()=>(await readRecovery(page)).pending).toBeUndefined();await expect(page.locator('#qa-recheck-cache')).toBeEnabled();await page.locator('#qa-recheck-cache').click();
    await expect(page.locator('#qa-retry-original-conflict')).toBeEnabled();await frozen(page);await expect(page.locator('#qa-requirements')).toHaveValue(original.draft.requirements);
    const adoptStored=page.locator('#qa-use-stored');if(await adoptStored.count())await expect(adoptStored).toBeDisabled();
    expect(state.answers).toEqual([body,body]);await page.locator('#qa-retry-original-conflict').click();await expect.poll(()=>state.answers.length).toBe(3);await expect(page.locator('#qa-retry-original-conflict')).toHaveCount(0);
    await expect(page.locator('#qa-history')).toBeEnabled();expect(state.answers).toEqual([body,body,body]);expect(state.accepted.size).toBe(1);expect(state.drafts).toHaveLength(1);
  }finally{await second.close();}
});

test('a delayed active-run poll cannot replace the draft while supplementary upload is awaiting completion',async({page})=>{
  const state=fixture(),active=structuredClone(state.workspace.runs.find(run=>run.run_id===answerId)!);
  active.run_id='synthetic-active-qa-round';active.sequence=11;active.state='queued';active.stage='queued';active.result=null;active.artifact_id=null;active.reserved_points=active.manifest.points;active.charged_points=0;state.workspace.runs.unshift(active);state.allowUploads=true;
  await open(page,state,null);const original=structuredClone(state.workspace.draft);let heldRead=false,readDelivered=false,heldUpload=false;
  let releaseRead!:()=>void,releaseUpload!:()=>void;const readGate=new Promise<void>(resolve=>{releaseRead=resolve;}),uploadGate=new Promise<void>(resolve=>{releaseUpload=resolve;});
  await page.route(`**/api/v1/projects/${projectId}/qa`,async route=>{
    if(route.request().method()!=='GET'||heldRead)return route.fallback();const old=structuredClone(state.workspace);checked('QaWorkspaceResponse',old);heldRead=true;
    await readGate;await route.fulfill({json:fixtureBody(route,old)});readDelivered=true;
  });
  await page.route(`**/api/v1/projects/${projectId}/materials/uploads/*/complete`,async route=>{
    if(route.request().method()!=='POST')return route.fallback();const body:unknown=fixtureRequest(route.request());checked('UploadCompleteRequest',body);heldUpload=true;await uploadGate;await route.fallback();
  });
  try{
    await expect.poll(()=>heldRead,{timeout:10000}).toBe(true);await page.locator('#qa-requirements').evaluate(node=>(node as HTMLElement).dataset.syntheticDraftMarker='before-poll');
    await page.locator('#qa-supplement').setInputFiles({name:'合成轮询竞态补充.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic delayed supplement, not a real PDF')});
    await expect.poll(()=>heldUpload).toBe(true);await expect(page.locator('#qa-requirements')).toBeDisabled();releaseRead();await expect.poll(()=>readDelivered).toBe(true);
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));await expect(page.locator('#qa-requirements')).toHaveAttribute('data-synthetic-draft-marker','before-poll');
    releaseUpload();await expect(page.locator('.qa-materials')).toContainText('合成轮询竞态补充.pdf');await expect(page.locator('#qa-save')).toBeEnabled();await page.locator('#qa-save').click();await expect.poll(()=>state.drafts.length).toBe(1);
    const uploaded=state.uploadMaterial!,pin={kind:'material' as const,pin:{source_project_id:projectId,material_id:uploaded.material_id,material_version:uploaded.material_version,sha256:uploaded.sha256}};
    expect(state.drafts[0]).toEqual({expected_revision:10,draft:{...original,materials:[...original.materials,pin]}});expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.answers).toEqual([]);expect(state.prepares).toEqual([]);
  }finally{releaseRead();releaseUpload();}
});

test('a full reopen finds the original free preparation in its journal when the main cache is empty and never submits automatically',async({page})=>{
  const state=await open(page);state.allowUploads=true;state.dropPrepare='after';await page.locator('#qa-upload').setInputFiles({name:'合成日志恢复清单.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic journal source, not a real Word file')});
  await expect.poll(()=>state.prepares.length).toBe(1);await expect(page.locator('#qa-retry-pending')).toBeEnabled();const body=structuredClone(state.prepares[0]);expect((await readRecovery(page)).pending).toEqual({kind:'prepare',request:body});
  await clearOnlyMainRecovery(page);expect((await peekRecovery(page)).status).toBe('empty');await page.reload();await expect(page.locator('#qa-restore-journal')).toBeEnabled();
  expect(state.prepares).toEqual([body]);expect(state.uploads).toHaveLength(1);expect(state.drafts).toEqual([]);expect(state.answers).toEqual([]);
  const main=await peekRecovery(page);expect(['empty','valid']).toContain(main.status);if(main.status==='valid')expect(main.value.pending).toBeUndefined();
  await page.locator('#qa-restore-journal').click();await expect(page.locator('#qa-retry-pending')).toBeEnabled();expect(state.prepares).toEqual([body]);expect((await readRecovery(page)).pending).toEqual({kind:'prepare',request:body});
  await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.prepares.length).toBe(2);await expect(page.locator('#qa-retry-pending')).toHaveCount(0);
  expect(state.prepares).toEqual([body,body]);expect(state.accepted.size).toBe(1);expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.drafts).toEqual([]);expect(state.answers).toEqual([]);
});

test('an acknowledged answer stays confirmed when journal removal succeeds but its single readback throws',async({page})=>{
  const state=await open(page);await adopt(page);let armed=false;
  await page.route(`**/api/v1/projects/${projectId}/qa/runs`,async route=>{
    if(route.request().method()!=='POST'||armed)return route.fallback();armed=true;
    const body:unknown=fixtureRequest(route.request());checked('QaAnswerRequest',body);
    await page.evaluate(()=>{
      const target=window as Window&{__syntheticQaRemovalCount?:number;__syntheticQaReadFailureCount?:number};
      target.__syntheticQaRemovalCount=0;target.__syntheticQaReadFailureCount=0;
      const remove=Storage.prototype.removeItem,get=Storage.prototype.getItem;
      // Do not identify the journal's private key. The first removal really
      // happens; only its next verification read fails, then normal reads resume.
      Storage.prototype.removeItem=function(key:string){
        remove.call(this,key);Storage.prototype.removeItem=remove;target.__syntheticQaRemovalCount=(target.__syntheticQaRemovalCount??0)+1;
        Storage.prototype.getItem=function(){
          Storage.prototype.getItem=get;target.__syntheticQaReadFailureCount=(target.__syntheticQaReadFailureCount??0)+1;
          throw new DOMException('Synthetic readback failure after successful deletion','SecurityError');
        };
      };
    });
    await route.fallback();
  });
  await start(page);await expect.poll(()=>state.answers.length).toBe(1);await expect.poll(()=>state.accepted.size).toBe(1);
  const accepted=[...state.accepted.values()][0],runId=accepted.run.run_id,body=structuredClone(state.answers[0]);
  await expect.poll(()=>page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('run'))).toBe(runId);
  await expect(page.locator('#qa-retry-pending')).toHaveCount(0);await expect(page.locator('#qa-retry-original-conflict')).toHaveCount(0);await expect(page.locator('#qa-restore-journal')).toHaveCount(0);
  expect(await page.evaluate(()=>{const target=window as Window&{__syntheticQaRemovalCount?:number;__syntheticQaReadFailureCount?:number};return {removed:target.__syntheticQaRemovalCount,readFailures:target.__syntheticQaReadFailureCount};})).toEqual({removed:1,readFailures:1});
  expect((await readRecovery(page)).pending).toBeUndefined();expect(state.answers).toEqual([body]);expect(state.drafts).toHaveLength(1);expect(state.prepares).toEqual([]);
  await page.reload();await expect(page.locator('#qa-history')).toBeVisible();await expect.poll(()=>page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('run'))).toBe(runId);
  await expect(page.locator('#qa-retry-pending')).toHaveCount(0);await expect(page.locator('#qa-retry-original-conflict')).toHaveCount(0);await expect(page.locator('#qa-restore-journal')).toHaveCount(0);
  expect(state.answers).toEqual([body]);expect(state.accepted.size).toBe(1);expect(state.drafts).toHaveLength(1);expect(state.prepares).toEqual([]);expect(state.uploads).toEqual([]);
});
