import {expect,test,type Page} from '@playwright/test';
import {INTEGRITY_PRICE,INTEGRITY_SITES,resolveIntegritySite,type IntegrityDraft,type IntegrityEvidence,type IntegrityManual} from '@bondbuddy/contracts';
import type {IntegrityRecoveryValue} from '../src/integrity-recovery';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {assertFixture,checkId,exportId,fixture,historicalDraft,historicalRounds,install,integrityWrites,material,newPin,oldPin,otherOwnerId,otherProjectId,ownerId,projectId,sha,workspaceReads,writes,type State} from './integrity-continuation-fixtures';

// Public-schema synthetic browser UX only. These cases never visit official
// websites, inspect real Word files, settle credits or execute a worker.
// The disabled-catalog fixture deliberately retains historical fixed-price
// confirmation/recovery coverage; it does not simulate current automatic pricing.
const cacheKey=`bb-integrity-recovery:${ownerId}:${projectId}`;
const opened=new WeakMap<Page,State>();
const route=(run:string|null=exportId,project=projectId)=>`/#integrity?project=${project}${run?`&run=${run}`:''}`;
const modal=(page:Page)=>page.locator('.integrity-modal[open]');
const subjectField=(page:Page,id:string,field:string)=>page.locator(`[data-subject="${id}"][data-field="${field}"]`);
const evidenceButton=(page:Page,index:number,siteId:string)=>page.locator(`[data-evidence="${index}:${siteId}"]`);
const nextPending=(page:Page)=>page.locator('#integrity-next-pending:visible');
const originalSubjects=()=>historicalDraft().subjects;
const preparedDraft=()=>({...historicalDraft(),site_ids:['bankruptcy','local-tax']});
test.afterEach(async({page})=>assertFixture(page));
async function open(page:Page,state=fixture(),run:string|null=exportId){opened.set(page,state);await install(page,state);await page.goto(route(run));await expect(page.locator(run?'#integrity-records':'#integrity-roster')).toBeVisible();return state;}
async function openRetained(page:Page,state=fixture(),index=0,siteId='credit-china'){
  // Synthetic pre-upgrade local state only. Fresh query records cannot create
  // manual evidence (2026-10-28 decision); the real resume UI must restore it.
  const subject=historicalDraft().subjects[index],site=resolveIntegritySite(INTEGRITY_SITES.find(value=>value.id===siteId)!,subject);
  const value:IntegrityRecoveryValue={revision:state.workspace.revision,draft:structuredClone(state.workspace.draft),evidenceDraft:{roundId:checkId,subjectId:subject.id,siteId,url:site.links[0].url,time:'',note:'',conclusion:'unresolved',...(siteId.startsWith('local-')?{registration:{province:subject.province,city:subject.city}}:{})}};
  await page.addInitScript(({key,owner,project,value})=>{
    const marker=key+':synthetic-seed-once';if(sessionStorage.getItem(marker))return;sessionStorage.setItem(marker,'1');
    if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:'integrity-recovery-cache-v1',owner,project,value}));
  },{key:cacheKey,owner:ownerId,project:projectId,value});
  return open(page,state);
}
function expectOnlySavedDraft(state:State,draft:IntegrityDraft){
  const body={expected_revision:10,draft};
  expect(writes(state)).toEqual([{method:'POST',path:`/projects/${projectId}/integrity/draft`,search:'',body}]);
  expect(state.drafts).toEqual([body]);expect(state.workspace.revision).toBe(11);expect(state.workspace.draft).toEqual(draft);
  expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);expect(state.manuals).toEqual([]);expect(state.uploads).toEqual([]);expect(state.uploadBytes).toBe(0);expect(state.accepted.size).toBe(0);expect(state.acceptedManuals.size).toBe(0);expect(state.available).toBe(10000);
}
async function adopt(page:Page){await page.locator('#integrity-use-round').click();await expect(page.locator('#integrity-adopt-confirm')).toBeVisible();await page.locator('#integrity-adopt-confirm').click();await expect(page.locator('#integrity-roster')).toBeVisible();}
async function expectLocal(page:Page,siteIds=preparedDraft().site_ids){
  await expect(page.locator('[data-subject-row]')).toHaveCount(3);for(const subject of originalSubjects())for(const field of ['kind','name','role','identifier'] as const)await expect(subjectField(page,subject.id,field)).toHaveValue(subject[field]);
  await expect(page.locator('#integrity-notes')).toHaveValue(historicalDraft().notes);
  await expect(page.locator('[name=integrity-site]:checked')).toHaveCount(siteIds.length);for(const id of siteIds)await expect(page.locator(`[name=integrity-site][value="${id}"]`)).toBeChecked();
  for(const subject of originalSubjects().filter(subject=>subject.kind==='company'))for(const field of ['province','city'] as const)await expect(page.locator(`[data-region="${subject.id}"][data-field="${field}"]`)).toHaveValue(subject[field]);
}
async function expectPending(page:Page){await expect(page.locator('#integrity-recovery')).toBeVisible();await expect(page.locator('#integrity-retry-pending')).toBeEnabled();}
async function start(page:Page){await page.locator('[name=integrity-site][value=tax]').check();await page.locator('#integrity-start').click();await expect(page.locator('#integrity-confirm')).toBeVisible();await page.locator('#integrity-confirm').click();}
async function freeExport(page:Page){await page.locator('#integrity-export').click();await expect(page.locator('#integrity-export-free-confirm')).toBeVisible();await page.locator('#integrity-export-free-confirm').click();}
async function openEvidence(page:Page,index=0,siteId='credit-china'){
  const state=opened.get(page)!,before=structuredClone(writes(state)),button=evidenceButton(page,index,siteId);
  await button.locator('xpath=ancestor::details').evaluate((element:HTMLDetailsElement)=>{element.open=true;});await button.click();
  await expect(page.locator('#integrity-evidence-form')).toHaveCount(0);await expect(modal(page).locator('[name=time]')).toHaveCount(0);expect(writes(state)).toEqual(before);
  await modal(page).locator('[data-close]').click();await page.locator('#integrity-resume-evidence').click();await expect(page.locator('#integrity-evidence-form')).toBeVisible();expect(writes(state)).toEqual(before);
}
async function fillEvidence(page:Page,materialIndex='0',note='合成查询：人工核对该主体与官网事项，仍待核实。'){
  await expect(page.locator('#integrity-existing-materials')).toBeVisible();await page.locator('#integrity-existing-materials').selectOption(materialIndex);
  await modal(page).locator('[name=time]').fill('2026-10-24T10:20');await modal(page).locator('[name=note]').fill(note);await modal(page).locator('[name=conclusion]').selectOption('unresolved');
}
async function saveEvidence(page:Page){await page.locator('#integrity-evidence-save').click();}
async function screenshotAtTop(page:Page,directory:string,filename:string){await mkdir(directory,{recursive:true});await page.evaluate(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));(document.activeElement as HTMLElement|null)?.blur();window.scrollTo(0,0);});await page.screenshot({path:join(directory,filename),fullPage:true});}

for(const width of [1440,390])test(`${width}: explicit whole-round adoption is local, exact and survives refresh without POST`,async({page})=>{
  await page.setViewportSize({width,height:width===390?844:960});const state=await open(page),history=historicalRounds(state),server=structuredClone(state.workspace.draft);
  expect(writes(state)).toEqual([]);await expect(page.locator('[data-integrity-download]')).toHaveCount(2);const directory=process.env.BB_UX_EVIDENCE_DIR;
  if(width===390){const button=evidenceButton(page,0,'credit-china');await button.scrollIntoViewIfNeeded();const bounds=await button.boundingBox();expect(bounds).not.toBeNull();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);await expect(button).toBeInViewport();expect(await button.evaluate(element=>{const wrap=element.closest('.integrity-table-wrap');return !wrap||wrap.scrollLeft===0;})).toBe(true);if(directory){await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,'integrity-continuation-action-390.png')});}}
  if(directory)await screenshotAtTop(page,directory,`integrity-continuation-history-${width}.png`);
  await page.locator('#integrity-use-round').click();await expect(modal(page)).toContainText('3');expect(writes(state)).toEqual([]);await page.locator('#integrity-adopt-confirm').click();await expectLocal(page);
  await expect(page.locator('.integrity-notice').filter({hasText:'已采用历史名单'})).toContainText('第 2 次底稿导出');await expect(page.locator('.integrity-notice').filter({hasText:'已采用历史名单'})).not.toContainText(exportId);
  expect(state.workspace.draft).toEqual(server);expect(integrityWrites(state)).toEqual([]);await page.reload();await expectLocal(page);expect(writes(state)).toEqual([]);expect(historicalRounds(state)).toEqual(history);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(directory)await screenshotAtTop(page,directory,`integrity-continuation-preparation-${width}.png`);
});

test('opening either check or export history and returning to preparation never adopts it',async({page})=>{
  const state=await open(page),server=structuredClone(state.workspace.draft);await page.goto(route(checkId));await expect(page.locator('#integrity-records')).toBeVisible();await page.goto(route(null));
  await expect(subjectField(page,'current-company','name')).toHaveValue(server.subjects[0].name);await expect(page.locator('#integrity-notes')).toHaveValue(server.notes);expect(state.workspace.draft).toEqual(server);expect(writes(state)).toEqual([]);
});

test('cancelling adoption leaves the current complete preparation unchanged',async({page})=>{
  const state=await open(page);await page.locator('#integrity-use-round').click();await modal(page).locator('[data-close]').click();await page.goto(route(null));await expect(subjectField(page,'current-company','name')).toHaveValue(state.workspace.draft.subjects[0].name);expect(writes(state)).toEqual([]);
});

test('local adopted edits persist without saving and leave old history immutable',async({page})=>{
  const state=await open(page),history=historicalRounds(state);await adopt(page);await subjectField(page,'company-b','role').fill('本地准备的新关系');await page.locator('#integrity-notes').fill('只在本地准备的新说明。');await page.reload();
  await expect(subjectField(page,'company-b','role')).toHaveValue('本地准备的新关系');await expect(page.locator('#integrity-notes')).toHaveValue('只在本地准备的新说明。');expect(writes(state)).toEqual([]);expect(historicalRounds(state)).toEqual(history);
});

test('a requested missing historical run never falls back to current preparation',async({page})=>{
  const state=fixture();state.omitRequestedRun=true;await install(page,state);await page.goto(route('synthetic-missing-integrity'));
  await expect(page.getByRole('alert')).toContainText('没有此核查记录');await expect(page.locator('#integrity-roster')).toHaveCount(0);await expect(page.locator('#integrity-use-round')).toHaveCount(0);await expect(page.locator('#integrity-start')).toHaveCount(0);expect(writes(state)).toEqual([]);
});

test('pending/all filters use original automatic status and do not turn attached evidence into clearance',async({page})=>{
  const state=await open(page);await page.locator('#integrity-filter').selectOption('pending');await expect(page.locator('[data-evidence]')).toHaveCount(5);
  await expect(evidenceButton(page,0,'credit-china')).toBeAttached();await expect(evidenceButton(page,1,'local-tax')).toBeAttached();await expect(evidenceButton(page,2,'bankruptcy')).toHaveCount(0);
  await page.locator('#integrity-filter').selectOption('all');await expect(page.locator('[data-evidence]')).toHaveCount(12);expect(writes(state)).toEqual([]);
});

test('a terminal missing record is pending without borrowing another subject result',async({page})=>{
  // Defensive DTO-only terminal history: this is not a claim that a successful
  // production Word can omit an observation. A cancelled check retains partials.
  const state=fixture(),round=state.workspace.rounds.find(value=>value.run_id===checkId)!;round.state='cancelled';round.artifact_id=null;round.artifacts=[];round.charged_points=0;round.records=round.records.filter(record=>!(record.subject_id==='person-a'&&record.site_id==='execution-dishonest'));
  await open(page,state,checkId);await page.locator('#integrity-filter').selectOption('pending');await expect(page.locator('[data-evidence]')).toHaveCount(6);await expect(evidenceButton(page,2,'execution-dishonest')).toBeAttached();expect(writes(state)).toEqual([]);
});

test('next pending follows original subject/site order and preserves the saved subject position',async({page})=>{
  const state=await openRetained(page),history=historicalRounds(state);await page.locator('#integrity-filter').selectOption('pending');await nextPending(page).click();await expect(modal(page)).toContainText('合成发行人有限公司');
  await expect(modal(page).locator('h2')).toHaveText('合成发行人有限公司 · 信用中国');await expect(page.locator('#integrity-evidence-form')).toHaveCount(0);expect(writes(state)).toEqual([]);
  await modal(page).locator('[data-close]').click();await page.locator('#integrity-resume-evidence').click();await expect(modal(page).locator('[name=time]')).toHaveValue('');
  await fillEvidence(page);await saveEvidence(page);await expect.poll(()=>state.manuals.length).toBe(1);await expect(modal(page)).toHaveCount(0);
  await expect(page.locator('#integrity-filter')).toHaveValue('pending');await nextPending(page).click();await expect(modal(page)).toContainText('合成发行人有限公司');await expect(modal(page)).toContainText('税务局');
  await expect(modal(page).locator('h2')).toHaveText('合成发行人有限公司 · 上海税务局');await expect(modal(page).getByRole('link',{name:'官网入口'})).toHaveAttribute('href','http://shanghai.chinatax.gov.cn/');
  expect(state.manuals[0].body.site_id).toBe('credit-china');expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);
  const savedWrites=structuredClone(writes(state));
  // Every remaining pending pair and wraparound follow the original roster/site order.
  for(const [index,siteId] of [[1,'execution-dishonest'],[1,'local-tax'],[2,'credit-china'],[0,'credit-china']] as const){
    await modal(page).locator('[data-close]').click();await nextPending(page).click();const subject=originalSubjects()[index],site=resolveIntegritySite(INTEGRITY_SITES.find(value=>value.id===siteId)!,subject);
    await expect(modal(page).locator('h2')).toHaveText(subject.name+' · '+site.name);await expect(page.locator('#integrity-evidence-form')).toHaveCount(0);expect(writes(state)).toEqual(savedWrites);
  }
  for(const round of state.workspace.rounds){const old=history.find(value=>value.run_id===round.run_id)!;expect(round.records).toEqual(old.records);expect(round.manifest).toEqual(old.manifest);}
});

test('a retained regional evidence draft preserves the original subject and registration without a new query',async({page})=>{
  const state=await openRetained(page,fixture(),0,'local-tax'),history=historicalRounds(state);await openEvidence(page,0,'local-tax');
  await expect(modal(page)).toContainText('合成发行人有限公司');await expect(modal(page)).toContainText('税务局');await expect(modal(page).locator('[name=province]')).toHaveValue('上海');await expect(modal(page).locator('[name=city]')).toHaveValue('');await expect(modal(page).locator('[name=time]')).toHaveValue('');
  expect(writes(state)).toEqual([]);expect(historicalRounds(state)).toEqual(history);
});

test('reusing an existing historical version sends its exact pin to the original check from export history',async({page})=>{
  const state=await openRetained(page),history=historicalRounds(state);await openEvidence(page);await expect(modal(page).locator('[name=time]')).toHaveValue('');await expect(modal(page)).toContainText('PDF');await expect(modal(page)).toContainText('Word');
  await fillEvidence(page,'0');await saveEvidence(page);await expect.poll(()=>state.manuals.length).toBe(1);expect(state.manuals[0].checkId).toBe(checkId);expect(state.manuals[0].body.material).toEqual(oldPin);expect(state.manuals[0].body.queried_at).toBe(await page.evaluate(()=>new Date('2026-10-24T10:20').toISOString()));expect(state.calls).toContainEqual({method:'GET',path:`/projects/${projectId}/materials/${oldPin.material_id}`,search:'?version=2'});
  expect(state.uploads).toEqual([]);expect(state.uploadBytes).toBe(0);expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);
  for(const round of state.workspace.rounds)expect(round.records).toEqual(history.find(old=>old.run_id===round.run_id)!.records);
  await page.locator('#integrity-filter').selectOption('pending');await expect(page.locator('[data-evidence]')).toHaveCount(5);
});

test('selecting the newer material version is explicit and never substitutes it for the old exact pin',async({page})=>{
  const state=await openRetained(page);await openEvidence(page);await fillEvidence(page,'1');await saveEvidence(page);await expect.poll(()=>state.manuals.length).toBe(1);expect(state.manuals[0].body.material).toEqual(newPin);expect(state.calls).toContainEqual({method:'GET',path:`/projects/${projectId}/materials/${newPin.material_id}`,search:'?version=3'});expect(state.manuals[0].body.material).not.toEqual(oldPin);expect(state.uploads).toEqual([]);
});

test('a reused material still requires a user supplied actual query time',async({page})=>{
  const state=await openRetained(page);await openEvidence(page);await page.locator('#integrity-existing-materials').selectOption('0');await modal(page).locator('[name=note]').fill('已选材料仍不能自动推断查询时间。');await saveEvidence(page);
  await expect(modal(page).locator('[name=time]')).toHaveValue('');expect(state.manuals).toEqual([]);expect(state.uploads).toEqual([]);
});

test('company-only websites cannot attach personnel evidence',async({page})=>{
  const state=await open(page);await page.locator('#integrity-filter').selectOption('all');const button=evidenceButton(page,2,'bankruptcy');await button.locator('xpath=ancestor::details').evaluate((element:HTMLDetailsElement)=>{element.open=true;});await button.click();
  await expect(modal(page)).toContainText('合成人员甲');await expect(page.locator('#integrity-evidence-form')).toHaveCount(0);expect(writes(state)).toEqual([]);
});

test('free export requires explicit confirmation and freezes all current evidence against the original check',async({page})=>{
  const state=await open(page),history=historicalRounds(state);await page.locator('#integrity-export').click();await expect(page.locator('#integrity-export-free-confirm')).toBeVisible();await expect(modal(page)).toContainText('免费');expect(writes(state)).toEqual([]);
  await page.locator('#integrity-export-free-confirm').click();await expect.poll(()=>state.exports.length).toBe(1);expect(state.exports[0]).toEqual({checkId,body:{request_id:expect.any(String),expected_evidence_ids:['synthetic-evidence-old','synthetic-evidence-new']}});
  const accepted=[...state.accepted.values()][0];expect(accepted.round.manifest.points).toBe(0);expect(accepted.generic.reservation_id).toBeNull();expect(accepted.round.reserved_points).toBe(0);expect(accepted.round.charged_points).toBe(0);expect(accepted.round.manifest.draft).toEqual(historicalDraft());expect(accepted.round.manifest.records).toEqual(history.find(round=>round.run_id===checkId)!.records);
  expect(state.checks).toEqual([]);expect(state.drafts).toEqual([]);expect(historicalRounds(state)).toEqual(history);
});

test('a paid new check confirms 5,000 and freezes the whole adopted roster without inheriting old findings',async({page})=>{
  const state=await open(page),history=historicalRounds(state);await adopt(page);await page.locator('[name=integrity-site][value="tax"]').check();const expected={...preparedDraft(),site_ids:[...preparedDraft().site_ids,'tax']};await page.locator('#integrity-start').click();await expect(modal(page)).toContainText('5,000');for(const subject of originalSubjects())await expect(modal(page)).toContainText(subject.name);
  // /quote and /runs bind a saved expected_revision. Saving the exact draft
  // is preparation; no run, reservation, export or upload exists before confirmation.
  expectOnlySavedDraft(state,expected);expect(historicalRounds(state)).toEqual(history);
  const roundId=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).value.roundId,cacheKey);expect(roundId).toMatch(/^[a-f0-9-]{36}$/);
  await page.locator('#integrity-confirm').click();await expect.poll(()=>state.checks.length).toBe(1);expect(state.drafts).toEqual([{expected_revision:10,draft:expected}]);expect(state.checks[0]).toEqual({request_id:expect.any(String),round_id:roundId,expected_revision:11,price_version:INTEGRITY_PRICE.version,expected_points:5000});
  const accepted=[...state.accepted.values()][0];expect(accepted.round.manifest.draft).toEqual(expected);expect(accepted.round.manifest.records).toEqual([]);expect(accepted.round.manifest.evidence_ids).toEqual([]);expect(historicalRounds(state)).toEqual(history);expect(state.manuals).toEqual([]);expect(state.exports).toEqual([]);
});

test('cancelling the paid confirmation retains the exact saved draft without query, export or upload',async({page})=>{
  const state=await open(page),history=historicalRounds(state);await adopt(page);await page.locator('[name=integrity-site][value=tax]').check();const expected={...preparedDraft(),site_ids:[...preparedDraft().site_ids,'tax']};await page.locator('#integrity-start').click();await expect(page.locator('#integrity-confirm')).toBeVisible();expectOnlySavedDraft(state,expected);const before=structuredClone(writes(state));
  await modal(page).locator('[data-close]').click();await expectLocal(page,[...preparedDraft().site_ids,'tax']);expect(writes(state)).toEqual(before);expectOnlySavedDraft(state,expected);expect(historicalRounds(state)).toEqual(history);
});

test('local storage persistence failure blocks execution before any draft or paid POST',async({page})=>{
  const state=await open(page),history=historicalRounds(state);await adopt(page);await page.locator('[name=integrity-site][value=tax]').check();const retained=await page.evaluate(key=>localStorage.getItem(key),cacheKey);
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('Synthetic quota failure','QuotaExceededError');};});await page.locator('#integrity-start').click();
  await expect(page.locator('#integrity-status')).not.toHaveText('');await expect(page.locator('#integrity-recovery')).toContainText('本机保存');await expect(page.locator('#integrity-confirm')).toHaveCount(0);expect(integrityWrites(state)).toEqual([]);expect(state.accepted.size).toBe(0);
  expect(writes(state)).toEqual([]);expect(state.drafts).toEqual([]);expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);expect(state.manuals).toEqual([]);expect(state.uploads).toEqual([]);expect(state.uploadBytes).toBe(0);expect(historicalRounds(state)).toEqual(history);expect(await page.evaluate(key=>localStorage.getItem(key),cacheKey)).toBe(retained);
});

for(const acceptance of ['before','after'] as const)test(`unknown paid check ${acceptance} acceptance reopens read-only and retries the complete original body`,async({page})=>{
  const state=await open(page);await adopt(page);state.dropCheck=acceptance;await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expectPending(page);const envelope=structuredClone(state.checks[0]);
  await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',true);await expect(page.locator('#integrity-notes')).toBeDisabled();await expect(page.locator('#integrity-save')).toBeDisabled();await expect(page.locator('#integrity-start')).toBeDisabled();
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);expect(state.checks).toEqual([envelope]);expect(state.drafts).toHaveLength(1);expect(state.accepted.size).toBe(acceptance==='after'?1:0);
  await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.checks.length).toBe(2);await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);expect(state.checks).toEqual([envelope,envelope]);expect(state.accepted.size).toBe(1);expect(state.drafts).toHaveLength(1);expect(state.uploads).toEqual([]);
});

for(const acceptance of ['before','after'] as const)test(`unknown free export ${acceptance} acceptance keeps original check and evidence body across refresh`,async({page})=>{
  const state=await open(page);state.dropExport=acceptance;await freeExport(page);await expect.poll(()=>state.exports.length).toBe(1);await expectPending(page);const envelope=structuredClone(state.exports[0]);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);expect(state.exports).toEqual([envelope]);await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.exports.length).toBe(2);await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);
  expect(state.exports).toEqual([envelope,envelope]);expect(state.accepted.size).toBe(1);expect(state.checks).toEqual([]);expect(state.drafts).toEqual([]);expect(state.uploads).toEqual([]);
});

test('unknown evidence before acceptance retries the original material pin and body without uploading',async({page})=>{
  const state=await openRetained(page);state.dropManual='before';await openEvidence(page);await fillEvidence(page);await saveEvidence(page);await expect.poll(()=>state.manuals.length).toBe(1);await expectPending(page);const envelope=structuredClone(state.manuals[0]);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);expect(state.manuals).toEqual([envelope]);await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.manuals.length).toBe(2);await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);
  expect(state.manuals).toEqual([envelope,envelope]);expect(state.acceptedManuals.size).toBe(1);expect(state.uploads).toEqual([]);expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);
});

test('an accepted unknown evidence request is recognized only by complete exact authoritative readback',async({page})=>{
  const state=await openRetained(page);state.workspaceRead=structuredClone(state.workspace);state.dropManual='after';await openEvidence(page);await fillEvidence(page);await saveEvidence(page);await expect.poll(()=>state.manuals.length).toBe(1);await expectPending(page);const envelope=structuredClone(state.manuals[0]);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);expect(state.manuals).toEqual([envelope]);state.workspaceRead=undefined;const reads=workspaceReads(state).length;await page.locator('#integrity-refresh-pending').click();await expect.poll(()=>workspaceReads(state).length).toBeGreaterThan(reads);
  await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);expect(state.manuals).toEqual([envelope]);expect(state.acceptedManuals.size).toBe(1);expect(state.uploads).toEqual([]);
});

test('an unknown uploaded evidence request retains the verified pin and never uploads the same bytes twice',async({page})=>{
  const state=await openRetained(page);state.allowUploads=true;state.dropManual='before';await openEvidence(page);await modal(page).locator('[name=time]').fill('2026-10-24T10:20');await modal(page).locator('[name=note]').fill('合成新上传证据。');await modal(page).locator('[name=file]').setInputFiles({name:'合成补证.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic evidence bytes, not a real PDF')});await saveEvidence(page);
  await expect.poll(()=>state.manuals.length).toBe(1);await expectPending(page);const envelope=structuredClone(state.manuals[0]);expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.manuals.length).toBe(2);expect(state.manuals).toEqual([envelope,envelope]);expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);
});

test('unknown draft refresh compares every field and the exact revision without sending another save',async({page})=>{
  const state=await open(page);await adopt(page);state.workspaceRead=structuredClone(state.workspace);state.dropDraft=true;await page.locator('#integrity-save').click();await expect.poll(()=>state.drafts.length).toBe(1);await expect(page.locator('#integrity-refresh-pending')).toBeEnabled();const envelope=structuredClone(state.drafts[0]),accepted=structuredClone(state.workspace);
  state.workspaceRead={...structuredClone(accepted),revision:accepted.revision+1};page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.locator('#integrity-refresh-pending')).toBeEnabled();
  state.workspaceRead={...structuredClone(accepted),draft:{...structuredClone(accepted.draft),notes:'别的页面的不同说明。'}};await page.locator('#integrity-refresh-pending').click();await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',true);await expect(page.locator('#integrity-notes')).toHaveValue(envelope.draft.notes);
  state.workspaceRead=accepted;await page.locator('#integrity-refresh-pending').click();await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',false);expect(state.drafts).toEqual([envelope]);expect(state.checks).toEqual([]);
});

test('local historical preparation is isolated by project',async({page})=>{
  const state=await open(page);await adopt(page);await page.goto(route(null,otherProjectId));await expect(page.locator('#integrity-roster')).toBeVisible();await expect(page.locator('[data-subject-row]')).toHaveCount(0);await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);
  await page.goto(route(null));await expectLocal(page);expect(writes(state)).toEqual([]);
});

test('another account cannot restore the prior owner preparation or paid request',async({page})=>{
  const state=await open(page);await adopt(page);state.dropCheck='after';await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expectPending(page);state.owner=otherOwnerId;page.on('dialog',dialog=>void dialog.accept());await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('#integrity-roster')).toHaveCount(0);await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);expect(state.checks).toHaveLength(1);expect(state.drafts).toHaveLength(1);
});

test('a matching-looking unrelated check is never treated as an unknown paid receipt',async({page})=>{
  const state=await open(page);await adopt(page);state.dropCheck='before';await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expectPending(page);
  const unrelated=structuredClone(state.workspace.rounds.find(round=>round.run_id===checkId)!);unrelated.run_id='synthetic-unrelated-check';unrelated.round_id=unrelated.run_id;unrelated.manifest.round_id=unrelated.run_id;unrelated.manifest.draft=historicalDraft();unrelated.sequence=99;state.workspace.rounds.unshift(unrelated);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);expect(state.checks).toHaveLength(1);expect(state.accepted.size).toBe(0);
});

for(const code of ['BILLING_REQUEST_REJECTED'] as const)test(`durable ${code} rejection retains preparation and requires another explicit 5,000 confirmation`,async({page})=>{
  const state=await open(page);await adopt(page);state.rejectCheck=code;await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',false);await expectLocal(page,[...preparedDraft().site_ids,'tax']);
  if(await modal(page).isVisible())await modal(page).locator('[data-close]').click();expect(state.accepted.size).toBe(0);await page.locator('#integrity-start').click();await expect(page.locator('#integrity-confirm')).toBeVisible();expect(state.checks).toHaveLength(1);await page.locator('#integrity-confirm').click();await expect.poll(()=>state.checks.length).toBe(2);expect(state.checks[1].expected_points).toBe(5000);
});

test('an export evidence conflict does not silently modify or replay its original confirmation body',async({page})=>{
  const state=await open(page);state.dropExport='before';await freeExport(page);await expect.poll(()=>state.exports.length).toBe(1);await expectPending(page);const original=structuredClone(state.exports[0]);
  const added:IntegrityEvidence={...structuredClone(state.workspace.rounds[0].evidence[0]),id:'synthetic-concurrent-evidence',request_id:'synthetic-concurrent-evidence-request',note:'另一个页面添加的证据。'};state.workspace.rounds.filter(round=>round.round_id===checkId).forEach(round=>round.evidence.push(structuredClone(added)));
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);expect(state.exports).toEqual([original]);await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.exports.length).toBe(2);expect(state.exports).toEqual([original,original]);expect(state.accepted.size).toBe(0);
  await expect(page.locator('#integrity-status')).not.toHaveText('');expect(state.checks).toEqual([]);expect(state.drafts).toEqual([]);
});

test('a same-id evidence readback with changed note or material pin cannot settle an unknown attachment',async({page})=>{
  const state=await openRetained(page);state.dropManual='before';await openEvidence(page);await fillEvidence(page);await saveEvidence(page);await expect.poll(()=>state.manuals.length).toBe(1);await expectPending(page);const body:IntegrityManual=state.manuals[0].body;
  const impostor:IntegrityEvidence={...structuredClone(body),id:'synthetic-impostor',created_at:'2026-10-25T06:00:00Z',note:'同request_id却不是原完整内容。',material:structuredClone(newPin)};state.workspace.rounds.filter(round=>round.round_id===checkId).forEach(round=>round.evidence.push(structuredClone(impostor)));
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectPending(page);expect(state.manuals).toHaveLength(1);expect(state.acceptedManuals.size).toBe(0);expect(state.uploads).toEqual([]);
});

test('a retained journal recovers the original paid envelope after the main cache is removed without an automatic POST',async({page})=>{
  const state=await open(page);await adopt(page);state.dropCheck='before';await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expectPending(page);const envelope=structuredClone(state.checks[0]);
  const cleared=await page.evaluate(async({owner,project})=>{
    const module='/src/integrity-recovery.ts';const {IntegrityRecoveryCache}=await import(module);const cache=new IntegrityRecoveryCache(owner,project),read=cache.read();if(read.status!=='valid')return read.status;return cache.clear(read.value).status;
  },{owner:ownerId,project:projectId});expect(cleared).toBe('empty');
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.locator('[data-integrity-journal]')).toHaveCount(1);expect(state.checks).toEqual([envelope]);await expect(page.locator('#integrity-start')).toBeDisabled();
  await page.locator('[data-integrity-journal]').click();await expectPending(page);expect(state.checks).toEqual([envelope]);await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.checks.length).toBe(2);expect(state.checks).toEqual([envelope,envelope]);expect(state.accepted.size).toBe(1);
});

test('an acknowledged paid run remains confirmed when local journal deletion readback fails',async({page})=>{
  const state=await open(page);await adopt(page);await page.route(`**/projects/${projectId}/integrity/runs`,async route=>{
    await page.evaluate(()=>{
      const remove=Storage.prototype.removeItem,get=Storage.prototype.getItem;let removed:string|undefined;
      Storage.prototype.removeItem=function(key:string){remove.call(this,key);removed=key;};
      Storage.prototype.getItem=function(key:string){if(key===removed)throw new DOMException('Synthetic cleanup readback unavailable','SecurityError');return get.call(this,key);};
    });await route.fallback();
  });
  await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expect.poll(()=>state.accepted.size).toBe(1);const runId=[...state.accepted.values()][0].round.run_id;
  await expect(page).toHaveURL(new RegExp(`run=${runId}`));await expect(page.locator('#integrity-records')).toBeVisible();await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);expect(state.checks).toHaveLength(1);expect(state.drafts).toHaveLength(1);
});

test('a paid acknowledgement with one failed main-cache save shows confirmed recovery and only retries local storage',async({page})=>{
  const state=await open(page);await adopt(page);await page.route(`**/projects/${projectId}/integrity/runs`,async route=>{
    await page.evaluate(async()=>{const module='/src/integrity-recovery.ts';const {IntegrityRecoveryCache}=await import(module),save=IntegrityRecoveryCache.prototype.save;let failed=false;
      IntegrityRecoveryCache.prototype.save=function(value:Record<string,unknown>,...rest:unknown[]){if(!value.pending&&!failed){failed=true;return {status:'unavailable'};}return save.call(this,value,...rest);};
    });await route.fallback();
  });
  await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expect(page.locator('#integrity-finish-confirmed')).toBeEnabled();await expect(page.locator('#integrity-recovery')).toContainText('服务器已确认');await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);
  const body=structuredClone(state.checks[0]),runId=[...state.accepted.values()][0].round.run_id;await page.locator('#integrity-finish-confirmed').click();await expect(page).toHaveURL(new RegExp(`run=${runId}`));await expect(page.locator('#integrity-records')).toBeVisible();expect(state.checks).toEqual([body]);expect(state.drafts).toHaveLength(1);expect(state.accepted.size).toBe(1);
});

test('replaying an unknown paid envelope after another page edits main storage preserves the foreign preparation',async({page})=>{
  const state=await open(page);await adopt(page);state.dropCheck='before';await start(page);await expect.poll(()=>state.checks.length).toBe(1);await expectPending(page);const original=structuredClone(state.checks[0]);
  const other=await page.context().newPage();await other.goto(route(null));await expect(other.locator('#integrity-retry-pending')).toBeVisible();
  const foreign=await other.evaluate(async({owner,project})=>{const module='/src/integrity-recovery.ts';const {IntegrityRecoveryCache}=await import(module),cache=new IntegrityRecoveryCache(owner,project),read=cache.read();if(read.status!=='valid')throw Error('Synthetic cache unavailable');const next=structuredClone(read.value);delete next.pending;next.draft.notes='另一页面的独立准备必须保留。';const saved=cache.save(next,read.value);if(saved.status!=='valid')throw Error('Synthetic foreign preparation rejected');return saved.value;},{owner:ownerId,project:projectId});
  await expect(page.locator('#integrity-recovery')).toContainText('另一页面');await other.close();await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.checks.length).toBe(2);await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);
  const after=await page.evaluate(async({owner,project})=>{const module='/src/integrity-recovery.ts';const {IntegrityRecoveryCache}=await import(module);return new IntegrityRecoveryCache(owner,project).read();},{owner:ownerId,project:projectId});expect(after).toEqual({status:'valid',value:foreign});expect(state.checks).toEqual([original,original]);expect(state.accepted.size).toBe(1);
});

test('an unknown draft GET mismatch presents both preparations and explicit local rebase performs no POST',async({page})=>{
  const state=await open(page);await adopt(page);state.workspaceRead=structuredClone(state.workspace);state.dropDraft=true;await page.locator('#integrity-save').click();await expect.poll(()=>state.drafts.length).toBe(1);await expect(page.locator('#integrity-refresh-pending')).toBeEnabled();
  state.workspaceRead={...structuredClone(state.workspace),revision:12,draft:{subjects:[{id:'foreign-company',kind:'company',name:'另一页面的服务器企业有限公司',identifier:'',role:'另一名单',province:'北京',city:''}],site_ids:['csrc'],notes:'服务器当前完整准备，需要与本机核对。'}};
  await page.locator('#integrity-refresh-pending').click();await expect(page.locator('#integrity-recovery')).toContainText('合成发行人有限公司');await expect(page.locator('#integrity-recovery')).toContainText('另一页面的服务器企业有限公司');await expect(page.locator('#integrity-rebase-pending-draft')).toBeEnabled();expect(state.drafts).toHaveLength(1);
  await page.locator('#integrity-rebase-pending-draft').click();await expect(page.locator('#integrity-rebase-pending-draft')).toHaveCount(0);await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',false);await expectLocal(page);expect(state.drafts).toHaveLength(1);expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);
  const saved=await page.evaluate(async({owner,project})=>{const module='/src/integrity-recovery.ts';const {IntegrityRecoveryCache}=await import(module);return new IntegrityRecoveryCache(owner,project).read();},{owner:ownerId,project:projectId});expect(saved).toMatchObject({status:'valid',value:{revision:12,draft:preparedDraft()}});
});

test('raw evidence fields survive close, reopen and refresh while blank actual time stays blank',async({page})=>{
  const state=await openRetained(page);await openEvidence(page);await modal(page).locator('[name=note]').fill('尚未提交的人工核对说明。');await modal(page).locator('[name=url]').fill('https://www.creditchina.gov.cn/synthetic-query');await modal(page).locator('[name=conclusion]').selectOption('records_found');await expect(modal(page).locator('[name=time]')).toHaveValue('');await modal(page).locator('[data-close]').click();
  await openEvidence(page);await expect(modal(page).locator('[name=note]')).toHaveValue('尚未提交的人工核对说明。');await expect(modal(page).locator('[name=url]')).toHaveValue('https://www.creditchina.gov.cn/synthetic-query');await expect(modal(page).locator('[name=conclusion]')).toHaveValue('records_found');await expect(modal(page).locator('[name=time]')).toHaveValue('');await modal(page).locator('[data-close]').click();await page.reload();
  await expect(page.locator('#integrity-resume-evidence')).toBeEnabled();await page.locator('#integrity-resume-evidence').click();await expect(modal(page).locator('[name=note]')).toHaveValue('尚未提交的人工核对说明。');await expect(modal(page).locator('[name=time]')).toHaveValue('');expect(writes(state)).toEqual([]);
});

test('a deduplicated upload with the original upload ID attaches the exact existing material without adding another file',async({page})=>{
  const state=fixture(),bytes=Buffer.from('synthetic same-project evidence bytes, not a real PDF'),pin={source_project_id:projectId,material_id:'synthetic-reused-evidence-pdf',material_version:4,sha256:sha(bytes.toString())};
  const prior={...material(pin,'合成原有证据.pdf','application/pdf'),byte_size:bytes.length,upload_id:'synthetic-prior-upload'};state.allowUploads=true;state.materials.push(prior);state.reusedUploadMaterial=prior;const count=state.materials.length;
  await openRetained(page,state);await openEvidence(page);await modal(page).locator('[name=time]').fill('2026-10-24T10:20');await modal(page).locator('[name=note]').fill('重新选择相同字节，沿用项目中原证据版本。');await modal(page).locator('[name=file]').setInputFiles({name:'合成重新选择证据.pdf',mimeType:'application/pdf',buffer:bytes});await saveEvidence(page);
  await expect.poll(()=>state.manuals.length).toBe(1);await expect(modal(page)).toHaveCount(0);expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.uploadMaterial!.upload_id).not.toBe(prior.upload_id);
  expect(state.materials).toHaveLength(count);expect(state.manuals[0]).toMatchObject({checkId,body:{material:pin}});expect(state.acceptedManuals.size).toBe(1);expect(state.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/complete'))).toHaveLength(1);expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);
});

for(const mismatch of ['sha256','byte_size','media_type','role'] as const)test(`a schema-valid upload receipt with wrong ${mismatch} is rejected before attaching evidence`,async({page})=>{
  const state=await openRetained(page),history=historicalRounds(state),draft=structuredClone(state.workspace.draft),bytes=Buffer.from('synthetic upload receipt bytes');
  const declaration={filename:'合成回执核对.pdf',media_type:'application/pdf',role:'other',byte_size:bytes.length,sha256:sha(bytes.toString())};
  state.allowUploads=true;state.uploadReceiptMismatch=mismatch;await openEvidence(page);await modal(page).locator('[name=time]').fill('2026-10-24T10:20');await modal(page).locator('[name=note]').fill('回执必须匹配本次所选字节。');
  const completeResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/projects/${projectId}/materials/uploads/synthetic-upload-1/complete`);
  await modal(page).locator('[name=file]').setInputFiles({name:declaration.filename,mimeType:declaration.media_type,buffer:bytes});
  const complete=await completeResponse;expect(complete.status()).toBe(200);expect(complete.request().postDataJSON()).toEqual({byte_size:declaration.byte_size,sha256:declaration.sha256});
  expect(state.uploadMaterial).toMatchObject({...declaration,upload_id:'synthetic-upload-1'});
  expect(await complete.json()).toEqual({...state.uploadMaterial,[mismatch]:{sha256:sha('synthetic-wrong-upload-receipt'),byte_size:declaration.byte_size+1,media_type:'image/png',role:'audit'}[mismatch]});
  await expect.poll(()=>state.uploads.length).toBe(1);
  // Hash/size are rejected by ApiClient before recovery receives a material;
  // media/role pass that central gate and are rejected by UploadRecovery.
  const centralRejection=mismatch==='sha256'||mismatch==='byte_size';
  if(centralRejection)await expect(modal(page).locator('[role=status]')).toHaveText('当前结果无法核实，请刷新后联系支持。');
  else{await expect(modal(page).locator('[role=status]')).toContainText('上传回执与原文件声明不一致');await expect(modal(page).locator('[role=status]')).toHaveText('上传回执与原文件声明不一致，尚未确认材料保存，请重试确认原上传。');}
  const records=await page.evaluate(async({owner,project})=>{
    const apiModule='/src/api.ts',recoveryModule='/src/upload-recovery.ts',integrityModule='/src/integrity-upload.ts';
    const {ApiClient}=await import(apiModule),{UploadRecovery}=await import(recoveryModule),{integrityUploadPurpose}=await import(integrityModule);
    return new UploadRecovery(new ApiClient(()=>{}),owner,project,integrityUploadPurpose).list();
  },{owner:ownerId,project:projectId});
  expect(records).toHaveLength(1);expect(records[0]).toMatchObject({version:1,owner:ownerId,projectId,purpose:'integrity-evidence',declaration,stage:'confirming',uploadId:'synthetic-upload-1',context:{kind:'integrity-evidence',roundId:checkId,subjectId:'company-a',siteId:'credit-china'}});
  expect(records[0].material).toBeUndefined();expect(records[0].previousUploadIds).toEqual([]);
  if(centralRejection)expect(records[0].lastError).toEqual({status:0,code:'DATA_UNAVAILABLE'});else expect(records[0]).not.toHaveProperty('lastError');
  await expect(page.locator('#integrity-evidence-save')).toBeDisabled();await expect(page.locator('#integrity-selected-evidence')).toHaveText('');
  await expect(modal(page).locator('[name=time]')).toHaveValue('2026-10-24T10:20');await expect(modal(page).locator('[name=note]')).toHaveValue('回执必须匹配本次所选字节。');
  expect(await modal(page).locator('[name=file]').evaluate((input:HTMLInputElement)=>Array.from(input.files??[],file=>({name:file.name,type:file.type,size:file.size})))).toEqual([{name:declaration.filename,type:declaration.media_type,size:declaration.byte_size}]);
  expect(state.uploads).toEqual([declaration]);expect(state.uploadBytes).toBe(1);
  expect(writes(state)).toEqual([{method:'POST',path:`/projects/${projectId}/materials/uploads`,search:'',body:declaration},{method:'POST',path:`/projects/${projectId}/materials/uploads/synthetic-upload-1/complete`,search:'',body:{byte_size:declaration.byte_size,sha256:declaration.sha256}}]);
  expect(integrityWrites(state)).toEqual([]);expect(state.drafts).toEqual([]);expect(state.manuals).toEqual([]);expect(state.acceptedManuals.size).toBe(0);expect(state.checks).toEqual([]);expect(state.exports).toEqual([]);expect(state.accepted.size).toBe(0);expect(state.available).toBe(10000);expect(state.workspace.draft).toEqual(draft);expect(historicalRounds(state)).toEqual(history);
});
