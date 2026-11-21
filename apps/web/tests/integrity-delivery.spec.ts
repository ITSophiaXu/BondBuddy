import {expect,test,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkId,exportId,historicalDraft,oldPin,workspaceReads,writes} from './integrity-continuation-fixtures';
import {assertFixture,fixture,historical,install,progress,readPayload,route,word,type Kind,type State} from './integrity-delivery-fixtures';
import {downloadBytes,hash} from './word-roundtrip-fixtures';
import {installIntegrityDeliveryReference} from './integrity-delivery-reference';

// Desktop 1440 only. HTTP/OOXML fixtures do not execute a worker, official query,
// production content, private storage, credit settlement or a Word application.
const mismatch='所选底稿的任务或版本无法核实，未下载。请重新读取本轮底稿后再试。';
const success='文件已准备好。如未自动下载，请点击：保存文件';
const modal=(page:Page)=>page.locator('.integrity-modal[open]');
const panel=(page:Page)=>page.locator('.integrity-panel').first();
const button=(page:Page,s:State,run=exportId,kind:Kind='company')=>page.locator(`[data-integrity-download="${word(s,run,kind).artifact_id}"]`);
test.beforeEach(async({page})=>{await page.setViewportSize({width:1440,height:900});});
test.afterEach(async({page})=>{await assertFixture(page);});
async function open(page:Page,s=fixture(),run=exportId){await install(page,s);await page.goto(route(run));await expect(page.locator('#integrity-records')).toBeVisible();return s;}
async function visit(page:Page,run:string){await page.goto(route(run));await expect(page.locator('#integrity-records')).toBeVisible();expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('run'))).toBe(run);}
function stableHistory(s:State){return s.workspace.rounds.filter(round=>[checkId,exportId].includes(round.run_id)).map(round=>({run_id:round.run_id,manifest:structuredClone(round.manifest),records:structuredClone(round.records),artifacts:structuredClone(round.artifacts),artifact_id:round.artifact_id}));}
async function exactWord(page:Page,s:State,run=exportId,kind:Kind='company'){
  const expected=word(s,run,kind),pending=page.waitForEvent('download');await button(page,s,run,kind).click();const receipt=await pending,bytes=await downloadBytes(receipt);
  expect(receipt.suggestedFilename()).toBe(expected.metadata.filename);expect(bytes).toEqual(expected.bytes);expect(hash(bytes)).toBe(expected.metadata.sha256);expect(bytes.subarray(0,4)).toEqual(Buffer.from([0x50,0x4b,0x03,0x04]));
  expect(readPayload(bytes)).toEqual(expected.payload);expect(expected.metadata.run_id).toBe(run);expect(expected.metadata.artifact_id).toBe(expected.artifact_id);expect(expected.metadata.version).toBe(expected.version);
  await expect(page.locator('#integrity-status')).toHaveText(success);await expect(page.locator('#integrity-status').getByRole('link',{name:'保存文件'})).toBeVisible();return {bytes,payload:readPayload(bytes),filename:receipt.suggestedFilename()};
}
async function saveEvidence(page:Page,s:State,note:string,index=0,site='credit-china'){
  const count=s.manuals.length,action=page.locator(`[data-evidence="${index}:${site}"]`);await action.locator('xpath=ancestor::details').evaluate((node:HTMLDetailsElement)=>{node.open=true;});await action.click();
  await expect(page.locator('#integrity-evidence-form')).toBeVisible();await page.locator('#integrity-existing-materials').selectOption('0');
  await modal(page).locator('[name=time]').fill('2026-10-24T10:20');await modal(page).locator('[name=note]').fill(note);await modal(page).locator('[name=conclusion]').selectOption('unresolved');
  await page.locator('#integrity-evidence-save').click();await expect.poll(()=>s.manuals.length).toBe(count+1);await expect(modal(page)).toHaveCount(0);
  expect(s.manuals[count].checkId).toBe(checkId);expect(s.manuals[count].body.material).toEqual(oldPin);return s.manuals[count];
}
async function freeExport(page:Page,s:State){
  await page.locator('#integrity-export').click();await expect(page.locator('#integrity-export-free-confirm')).toBeVisible();await expect(modal(page)).toContainText('0 积分');await expect(modal(page)).toContainText('不重新查询官网');
  expect(s.exports).toEqual([]);await page.locator('#integrity-export-free-confirm').click();await expect.poll(()=>s.accepted.size).toBe(1);
  const accepted=[...s.accepted.values()][0];await expect(panel(page).locator('h2')).toContainText('排队');await expect(page.locator('[data-integrity-download]')).toHaveCount(0);
  expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('run'))).toBe(accepted.round.run_id);return accepted;
}
async function expectNearDownloadFeedback(page:Page,text=mismatch){
  const status=page.locator('#integrity-status');await expect(status).toHaveCount(1);await expect(status).toHaveText(text);await expect(status).toBeVisible();await expect(panel(page).locator('#integrity-status')).toHaveCount(1);
  const bounds=await status.boundingBox(),head=await panel(page).locator('.pf-section-head').boundingBox();expect(bounds).not.toBeNull();expect(head).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(head!.y+head!.height-1);expect(bounds!.y+ bounds!.height).toBeLessThanOrEqual(900);expect(bounds!.y-head!.y-head!.height).toBeLessThan(60);
}

test('integrity delivery: old exact Word, original-round evidence, free queued/running/succeeded export and both new Word files retain the old bytes',async({page})=>{
  test.setTimeout(40000);const s=await open(page),history=stableHistory(s),draft=structuredClone(s.workspace.draft),revision=s.workspace.revision;
  await expect(page.locator('#integrity-status')).toBeHidden();const oldCompany=await exactWord(page,s),oldPerson=await exactWord(page,s,exportId,'person');
  expect(oldCompany.payload.evidence.map(item=>item.id)).toEqual(['synthetic-evidence-old']);expect(oldPerson.payload.draft.subjects).toHaveLength(1);expect(oldPerson.payload.draft.subjects[0].identifier).toBe('****7788');
  expect(oldPerson.bytes.toString('utf8')).not.toContain('内部核对尾号7788');expect(oldCompany.payload.draft.subjects.map(item=>item.kind)).toEqual(['company','company']);expect(oldPerson.payload.records).toHaveLength(4);
  await visit(page,checkId);await exactWord(page,s,checkId);await exactWord(page,s,checkId,'person');await visit(page,exportId);
  const note='合成补证：导出前核对发行人原查询，继续保留待核实结论。';await saveEvidence(page,s,note);expect(stableHistory(s)).toEqual(history);
  await expect(panel(page)).toContainText('新增证据尚未包含');const accepted=await freeExport(page,s),newId=accepted.round.run_id;
  expect(newId).not.toBe(checkId);expect(newId).not.toBe(exportId);expect(accepted.round.round_id).toBe(checkId);expect(accepted.round.manifest.points).toBe(0);expect(accepted.generic.reservation_id).toBeNull();
  expect(s.exports[0].checkId).toBe(checkId);expect(s.exports[0].body.expected_evidence_ids).toEqual(['synthetic-evidence-old','synthetic-evidence-new','synthetic-evidence-added-1']);
  expect(accepted.round.manifest.draft).toEqual(historicalDraft());expect(accepted.round.manifest.records).toEqual(historical(s,checkId).records);
  let reads=workspaceReads(s).length;progress(s,'running');await expect.poll(()=>workspaceReads(s).length,{timeout:7500}).toBeGreaterThan(reads);await expect(panel(page).locator('h2')).toContainText('处理中');
  await expect(page.locator('[data-integrity-download]')).toHaveCount(0);expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('run'))).toBe(newId);
  reads=workspaceReads(s).length;progress(s,'succeeded');await expect.poll(()=>workspaceReads(s).length,{timeout:7500}).toBeGreaterThan(reads);await expect(page.locator('[data-integrity-download]')).toHaveCount(2);
  const company=await exactWord(page,s,newId),person=await exactWord(page,s,newId,'person');expect(company.payload.run_id).toBe(newId);expect(person.payload.run_id).toBe(newId);expect(company.payload.round_id).toBe(checkId);
  expect(company.payload.evidence.map(item=>item.id)).toEqual(s.exports[0].body.expected_evidence_ids);expect(company.payload.evidence.find(item=>item.id==='synthetic-evidence-added-1')?.material).toEqual(oldPin);
  expect(company.payload.evidence.find(item=>item.id==='synthetic-evidence-added-1')?.note).toBe(note);expect(company.payload.records).toEqual(historical(s,checkId).records.filter(item=>item.subject_id!=='person-a'));expect(person.payload.evidence).toEqual([]);
  expect(company.bytes).not.toEqual(oldCompany.bytes);expect(person.bytes).not.toEqual(oldPerson.bytes);expect(word(s,newId).version).toBe(1);expect(historical(s,newId).sequence).toBe(3);
  await visit(page,exportId);expect((await exactWord(page,s)).bytes).toEqual(oldCompany.bytes);expect((await exactWord(page,s,exportId,'person')).bytes).toEqual(oldPerson.bytes);
  await page.reload();await expect(page.locator('#integrity-records')).toBeVisible();expect(stableHistory(s)).toEqual(history);expect(s.workspace.draft).toEqual(draft);expect(s.workspace.revision).toBe(revision);
  expect(s.checks).toEqual([]);expect(s.drafts).toEqual([]);expect(s.uploads).toEqual([]);expect(s.uploadBytes).toBe(0);expect(s.exports).toHaveLength(1);expect(s.manuals).toHaveLength(1);expect(writes(s)).toHaveLength(2);
});

test('integrity delivery: evidence saved through the original UI after export acceptance grows shared history but stays outside that frozen Word',async({page})=>{
  const s=await open(page),history=stableHistory(s),oldBytes=Buffer.from(word(s).bytes),accepted=await freeExport(page,s),newId=accepted.round.run_id,frozen=structuredClone(accepted.round.manifest);
  await saveEvidence(page,s,'合成补证：此项在免费导出受理后新增，不应进入已冻结的版本。');expect(accepted.round.evidence).toHaveLength(3);expect(accepted.round.manifest).toEqual(frozen);
  progress(s,'running');await expect(panel(page).locator('h2')).toContainText('处理中',{timeout:7500});progress(s,'succeeded');await expect(page.locator('[data-integrity-download]')).toHaveCount(2,{timeout:7500});
  const next=await exactWord(page,s,newId);expect(next.payload.evidence_ids).toEqual(['synthetic-evidence-old','synthetic-evidence-new']);expect(next.payload.evidence.map(item=>item.id)).toEqual(frozen.evidence_ids);
  expect(next.payload.evidence.some(item=>item.id==='synthetic-evidence-added-1')).toBe(false);await expect(panel(page)).toContainText('1 份新增证据尚未包含');
  expect(stableHistory(s)).toEqual(history);expect(word(s).bytes).toEqual(oldBytes);await visit(page,exportId);expect((await exactWord(page,s)).bytes).toEqual(oldBytes);expect(historical(s,exportId).evidence).toHaveLength(3);
  expect(s.exports).toHaveLength(1);expect(s.manuals).toHaveLength(1);expect(s.checks).toEqual([]);expect(s.drafts).toEqual([]);expect(s.uploads).toEqual([]);expect(writes(s)).toHaveLength(2);
});

for(const fault of ['artifact_id','version','run_id'] as const)test(`integrity delivery: selected export metadata ${fault} mismatch rejects bytes and explicit retry downloads its exact Word`,async({page})=>{
  const s=await open(page),downloads:string[]=[];page.on('download',item=>downloads.push(item.suggestedFilename()));s.words.fault=fault;
  await button(page,s).click();await expectNearDownloadFeedback(page);await expect(button(page,s)).toBeEnabled();expect(s.words.metadata).toEqual([word(s).artifact_id]);expect(s.words.downloads).toEqual([]);expect(downloads).toEqual([]);
  const metadata=s.words.responses[0],expected=word(s).metadata;expect(metadata.artifact_id).toBe(fault==='artifact_id'?word(s,exportId,'person').artifact_id:expected.artifact_id);
  expect(metadata.run_id).toBe(fault==='run_id'?checkId:exportId);expect(metadata.version).toBe(fault==='version'?expected.version+1:expected.version);
  if(fault==='artifact_id')expect(metadata).toEqual(word(s,exportId,'person').metadata);
  await expect.poll(()=>s.words.diagnostics.length).toBe(1);
  expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('run'))).toBe(exportId);expect(word(s).metadata.run_id).not.toBe(checkId);
  s.words.fault=undefined;await exactWord(page,s);await expectNearDownloadFeedback(page,success);expect(downloads).toEqual([word(s).metadata.filename]);expect(s.words.downloads).toEqual([word(s).artifact_id]);expect(writes(s)).toEqual([]);
});

test('integrity delivery: an explicit save link survives a suppressed automatic download without repeating network reads',async({page})=>{
  await page.addInitScript(()=>{HTMLAnchorElement.prototype.click=function(){};});
  const s=await open(page),expected=word(s);await button(page,s).click();
  const link=page.locator('#integrity-status').getByRole('link',{name:'保存文件'});await expect(link).toBeVisible();
  const pending=page.waitForEvent('download');await link.click();const downloaded=await pending;
  expect(downloaded.suggestedFilename()).toBe(expected.metadata.filename);expect(await downloadBytes(downloaded)).toEqual(expected.bytes);
  const details=()=>s.words.diagnostics.map(item=>JSON.parse((item as {message:string}).message));
  await expect.poll(()=>details().map(item=>item.event)).toEqual(['verified','auto_save_requested','save_link_clicked']);
  expect(new Set(details().map(item=>item.download_id)).size).toBe(1);
  expect(details().every(item=>item.completed.includes('hash')&&item.received_bytes===expected.bytes.length)).toBe(true);
  expect(s.words.metadata).toEqual([expected.artifact_id]);expect(s.words.downloads).toEqual([expected.artifact_id]);expect(writes(s)).toEqual([]);
});

test('integrity delivery: ambiguous same-ID descriptors are rejected before metadata without borrowing either kind or the latest round',async({page})=>{
  // Public-schema defense only: same ID/different versions can be represented,
  // while the current worker emits distinct kind IDs and artifact version 1.
  const s=fixture(),round=historical(s);round.artifacts[1]={...round.artifacts[1],artifact_id:round.artifacts[0].artifact_id,artifact_version:round.artifacts[0].artifact_version+1};await open(page,s);
  const downloads:string[]=[];page.on('download',item=>downloads.push(item.suggestedFilename()));await page.locator('[data-integrity-download]').first().click();await expectNearDownloadFeedback(page);
  expect(s.words.metadata).toEqual([]);expect(s.words.downloads).toEqual([]);expect(downloads).toEqual([]);expect(writes(s)).toEqual([]);
});

test('integrity delivery desktop component comparison at 1440px uses identical long complete results and mismatched download metadata',async({page})=>{
  const reference=process.env.BB_INTEGRITY_DELIVERY_REFERENCE==='1',verify=reference?await installIntegrityDeliveryReference(page):undefined,s=await open(page),dir=process.env.BB_INTEGRITY_DELIVERY_EVIDENCE_DIR??process.env.BB_UX_EVIDENCE_DIR??test.info().outputPath('component-capture');
  await mkdir(dir,{recursive:true});const before=stableHistory(s),downloads:string[]=[];page.on('download',item=>downloads.push(item.suggestedFilename()));
  await page.locator('[data-integrity-subject]').evaluateAll(nodes=>nodes.forEach(node=>{(node as HTMLDetailsElement).open=true;}));await expect(page.locator('[data-evidence]:visible')).toHaveCount(12);
  const capture=async(name:string,action:string)=>{
    await page.evaluate(()=>{(document.activeElement as HTMLElement|null)?.blur();scrollTo(0,0);});
    const layout=await page.evaluate(()=>{const status=document.querySelector<HTMLElement>('#integrity-status'),rect=status?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollY,scrollWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,text:document.body.innerText,
      selectedRun:new URLSearchParams(location.hash.split('?')[1]).get('run'),status:{count:document.querySelectorAll('#integrity-status').length,text:status?.textContent??null,hidden:status?.hidden??null,inFirstPanel:document.querySelector('.integrity-panel')?.contains(status??null)??false,y:rect?.y??null,height:rect?.height??null}};});
    expect(layout.scrollWidth).toBeLessThanOrEqual(1441);expect(layout.documentHeight).toBeGreaterThan(1800);expect(layout.selectedRun).toBe(exportId);
    await page.screenshot({path:join(dir!,`integrity-delivery-${name}-1440.png`),fullPage:name==='long-result'});
    await writeFile(join(dir!,`integrity-delivery-${name}-1440.json`),JSON.stringify({...layout,reference,action,expectedWord:{artifact_id:word(s).artifact_id,run_id:exportId,version:word(s).version,sha256:word(s).metadata.sha256},metadata:s.words.metadata,responses:s.words.responses,bytes:s.words.downloads,downloads,writes:writes(s)},null,2));
  };
  await capture('long-result','same selected complete historical export, all subjects expanded');s.words.fault='comparison_cross_run';
  if(reference){const pending=page.waitForEvent('download');await button(page,s).click();const receipt=await pending;expect(await downloadBytes(receipt)).toEqual(word(s,checkId).bytes);expect(receipt.suggestedFilename()).toBe(word(s,checkId).metadata.filename);expect(s.words.downloads).toEqual([word(s,checkId).artifact_id]);}
  else{await button(page,s).click();await expectNearDownloadFeedback(page);expect(s.words.downloads).toEqual([]);expect(downloads).toEqual([]);}
  await capture('download-feedback',reference?'previous component accepts self-consistent metadata and bytes from the wrong check run':'current component rejects mismatched metadata before bytes and shows nearby feedback');
  expect(stableHistory(s)).toEqual(before);expect(writes(s)).toEqual([]);if(verify)await writeFile(join(dir!,'integrity-delivery-reference-1440.json'),JSON.stringify(await verify(),null,2));
});
