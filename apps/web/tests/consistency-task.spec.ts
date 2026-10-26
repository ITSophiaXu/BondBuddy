import {expect,test,type Page} from '@playwright/test';
import {assertFixture,base,cacheKey,downloadBytes,fixture,ids,oldBytes,openProjects,openTask,pendingRequest,seedCache,
  serverSnapshot,targetInput,taskRoute,writes,type ProjectionFault,type State,type Variant} from './consistency-task-fixtures';

// Desktop only. A fresh Playwright page/context and one fixture per test avoid
// reusing a same-hash document with another synthetic server projection.
const panel=(page:Page)=>page.locator('#fc-update-task');
const inputRow=(page:Page,id:string)=>page.locator(`[data-fc-result-version="${id}"]`);
const originalDownload=(page:Page,variant:Variant)=>panel(page).locator(`[data-fc-update-download="${ids.oldRun}"][data-variant="${variant}"]`);
async function ready(page:Page,s:State){await expect(panel(page)).toHaveAttribute('data-fc-update-run',ids.oldRun);await expect(panel(page)).toHaveAttribute('data-fc-update-file-version',targetInput(s)!);await expect(page.locator('#fc-history')).toHaveValue(ids.oldCheck);}
async function noBusiness(s:State,before=serverSnapshot(s)){expect(writes(s)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);}
async function downloadOriginal(page:Page,s:State,variant:Variant){
  const download=page.waitForEvent('download');await originalDownload(page,variant).click();const received=await download;
  const artifact=variant==='revision'?ids.oldRevision:ids.oldClean;
  expect(received.suggestedFilename()).toBe(s.artifacts.get(artifact)!.metadata.filename);expect(await downloadBytes(received)).toEqual(oldBytes[variant]);
  expect(s.byteReads.at(-1)).toBe(variant==='revision'?ids.oldRevision:ids.oldClean);return received;
}
test.beforeEach(async({page})=>{await page.setViewportSize({width:1440,height:900});});
test.afterEach(async({page})=>{await assertFixture(page);});

for(const entry of ['projects','files'] as const)test(`consistency task: ${entry} historical patch opens its original check and exact V2 pair despite a newer check and V3`,async({page})=>{
  const s=fixture(),before=serverSnapshot(s);await openProjects(page,s,entry);
  const link=entry==='projects'?page.locator(`[data-run-id="${ids.oldRun}"] a`):page.locator(`#pw-task-summary a[href*="${ids.oldRun}"]`);
  await expect(link).toHaveAttribute('href',new RegExp(`project=${ids.root}&update_run=${ids.oldRun}(?:&|$)`));await link.click();await ready(page,s);
  await expect(panel(page)).toContainText('本次交付 V2');await expect(panel(page)).not.toContainText('本次交付 V3');
  await expect(originalDownload(page,'revision')).toHaveAttribute('data-fc-download',ids.v2);await expect(originalDownload(page,'clean')).toHaveAttribute('data-fc-download',ids.v2);
  await expect(inputRow(page,ids.v1)).toBeFocused();await expect(inputRow(page,ids.v1).locator('details[data-fc-detail]')).toHaveAttribute('open');
  for(const variant of ['revision','clean'] as const)await downloadOriginal(page,s,variant);
  expect(s.metadataReads).toEqual([ids.oldRevision,ids.oldClean]);expect(s.byteReads).toEqual([ids.oldRevision,ids.oldClean]);
  const reads=s.checkReads;await page.reload();await ready(page,s);expect(s.checkReads).toBeGreaterThan(reads);
  await expect(panel(page)).toContainText('本次交付 V2');await noBusiness(s,before);
});

test('consistency task: a failed original acceptance never borrows its successful retry or invents a reason',async({page})=>{
  const s=fixture({state:'failed'}),before=serverSnapshot(s);await openProjects(page,s);
  const link=page.locator(`[data-run-id="${ids.oldRun}"] a`);await expect(link).not.toContainText('原因');await link.click();await ready(page,s);
  await expect(page.locator('#fc-update-task-state')).toHaveText('本次未完成');await expect(panel(page)).toContainText('当前记录未提供失败原因');
  await expect(panel(page).locator('[data-fc-download]')).toHaveCount(0);await expect(panel(page)).not.toContainText('本次交付 V3');
  // The page may still show the full check's later success, clearly labelled as
  // aggregate history rather than a delivery of the selected failed run.
  await expect(page.locator('.fc-history-scope')).toContainText('包含其他更新与重试');await expect(inputRow(page,ids.v2)).toContainText('可能来自其他更新或重试');
  await page.reload();await ready(page,s);await expect(panel(page).locator('[data-fc-download]')).toHaveCount(0);
  expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);await noBusiness(s,before);
});

for(const projection of ['missing-update','duplicate-update','wrong-input-file'] as const)test(`consistency task: ${projection} cannot select the latest check or another input`,async({page})=>{
  const s=fixture({projection}),before=serverSnapshot(s);await openTask(page,s);
  await expect(panel(page).getByRole('heading')).toHaveText('指定的文件更新任务暂时无法读取');await expect(panel(page)).not.toHaveAttribute('data-fc-update-file-version',/.+/);
  await expect(panel(page).locator('[data-fc-download]')).toHaveCount(0);await expect(page.locator('.fc-results')).toHaveCount(0);
  expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);await noBusiness(s,before);
});

for(const projection of ['missing-result','duplicate-result','result-file','result-run'] as ProjectionFault[])test(`consistency task: ${projection} retains the original task but refuses unrelated delivery bytes`,async({page})=>{
  const s=fixture({projection}),before=serverSnapshot(s);await openTask(page,s);await ready(page,s);
  await expect(panel(page)).toContainText('原任务的交付文件尚待同步');await expect(panel(page).locator('[data-fc-download]')).toHaveCount(0);
  await expect(panel(page)).not.toContainText('本次交付 V3');expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);await noBusiness(s,before);
});

for(const extra of [`&run=${ids.newCheck}`,`&update_run=${ids.laterRun}`,`&file=${ids.manual}`,`&run=${ids.oldCheck}&run=${ids.newCheck}`])test(`consistency task: conflicting route ${extra} fails explicitly without latest fallback`,async({page})=>{
  const s=fixture(),before=serverSnapshot(s);await openTask(page,s,taskRoute(extra));
  await expect(panel(page).getByRole('heading')).toHaveText('指定的文件更新任务暂时无法读取');await expect(page.locator('.fc-results')).toHaveCount(0);
  await expect(panel(page).locator('[data-fc-download]')).toHaveCount(0);expect(s.byteReads).toEqual([]);await noBusiness(s,before);
});

test('consistency task: arrival reveals the exact input once, later user filters survive read-only refresh and explicit locate is pure',async({page})=>{
  const s=fixture(),before=serverSnapshot(s);
  await seedCache(page,{owner:ids.owner,project:ids.root,selectionCheck:ids.oldCheck,chosen:[ids.manual],filter:'manual',needsCredits:false});
  await openTask(page,s);await ready(page,s);await expect(page.locator('#fc-filter')).toHaveValue('all');await expect(inputRow(page,ids.v1)).toBeFocused();
  await expect(inputRow(page,ids.v1).locator('details')).toHaveAttribute('open');
  await page.locator('#fc-filter').selectOption('manual');await expect(inputRow(page,ids.v1)).toHaveCount(0);await expect(inputRow(page,ids.manual)).toBeVisible();
  const reads=s.checkReads;await panel(page).locator('[data-fc-refresh]').click();await expect.poll(()=>s.checkReads).toBeGreaterThan(reads);await ready(page,s);
  await expect(page.locator('#fc-filter')).toHaveValue('manual');await expect(inputRow(page,ids.v1)).toHaveCount(0);
  await panel(page).locator('[data-fc-locate-update]').click();await expect(page.locator('#fc-filter')).toHaveValue('all');await expect(inputRow(page,ids.v1)).toBeFocused();
  await expect(inputRow(page,ids.v1).locator('details')).toHaveAttribute('open');await noBusiness(s,before);
});

test('consistency task: explicit re-read restores a missing acceptance without executing or preparing a workspace',async({page})=>{
  const s=fixture(),old=s.checks.find(c=>c.run_id===ids.oldCheck)!,saved=structuredClone(old.updates);old.updates=[];s.projectionFaults.push('temporarily missing acceptance');
  await openTask(page,s);await expect(panel(page).getByRole('heading')).toHaveText('指定的文件更新任务暂时无法读取');
  old.updates=saved;const before=serverSnapshot(s),reads=s.checkReads;s.workspaceUnavailable=true;
  await panel(page).locator('[data-fc-refresh]').click();await expect.poll(()=>s.checkReads).toBeGreaterThan(reads);await ready(page,s);
  await expect(panel(page)).toContainText('本次交付 V2');expect(s.calls.some(c=>c.method==='POST'&&c.path===base+'/workspace')).toBe(false);
  expect(s.metadataReads).toEqual([]);await noBusiness(s,before);
});

test('consistency task: an existing pending request keeps its original check, body and identity during historical navigation and explicit retry',async({page})=>{
  const s=fixture();s.pending=pendingRequest(s);const pending=structuredClone(s.pending),before=serverSnapshot(s);
  await seedCache(page,{owner:ids.owner,project:ids.root,selectionCheck:pending.checkId,chosen:pending.body.files.map(f=>f.file_version_id),filter:'manual',pendingUpdate:pending});
  await openTask(page,s);await ready(page,s);await expect(page.locator('#fc-pending-action')).toBeVisible();await noBusiness(s,before);
  const retained=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),cacheKey);expect(retained.pendingUpdate).toEqual(pending);
  const oldPending=await page.locator('#fc-pending-action').elementHandle();
  await panel(page).locator('[data-fc-refresh]').click();await expect(page.locator('#fc-status')).toHaveText('已重新读取任务与文件记录。');
  expect(await oldPending!.evaluate(node=>node.isConnected),'Read-only final paint replaced the old pending control').toBe(false);
  await expect(page.locator('#fc-pending-action')).toBeVisible();expect(writes(s)).toEqual([]);
  await page.locator('#fc-pending-action').click();await expect(page.getByRole('dialog')).toContainText(pending.filenames[0]);expect(writes(s)).toEqual([]);
  await page.locator('#fc-confirm-update').click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(s.updatePosts).toEqual([{checkId:pending.checkId,body:pending.body}]);expect(writes(s).map(c=>({path:c.path,body:c.body}))).toEqual([{path:base+'/checks/'+pending.checkId+'/updates',body:pending.body}]);
  await ready(page,s);expect(serverSnapshot(s)).toEqual(before);
});

test('consistency task: paused navigation stays read-only until an explicit resume targets the exact original run',async({page})=>{
  const s=fixture({state:'paused'});await openTask(page,s);await ready(page,s);await expect(page.locator('#fc-update-task-state')).toHaveText('等待恢复');
  const resume=panel(page).locator(`[data-fc-control="resume"][data-run="${ids.oldRun}"]`);await expect(resume).toBeEnabled();expect(writes(s)).toEqual([]);
  s.allowResume=true;await resume.click();await expect(page.locator('#fc-update-task-state')).toContainText('排队');
  expect(s.runActions).toEqual([{run:ids.oldRun,action:'resume',body:{reason:'user_resumed'}}]);expect(writes(s).map(c=>c.path)).toEqual([`/runs/${ids.oldRun}/resume`]);
});

for(const field of ['id','run','version','hash'] as const)test(`consistency task: metadata ${field} mismatch refuses bytes and a correct retry downloads the original V2`,async({page})=>{
  const s=fixture(),before=serverSnapshot(s);s.metadataFault={artifact:ids.oldRevision,field};await openTask(page,s);await ready(page,s);
  const downloads:string[]=[];page.on('download',download=>downloads.push(download.suggestedFilename()));await originalDownload(page,'revision').click();
  await expect(page.locator('#fc-status')).toContainText(/无法核实|校验|未通过/);expect(s.metadataReads).toEqual([ids.oldRevision]);expect(s.byteReads).toEqual([]);expect(downloads).toEqual([]);
  s.metadataFault=undefined;await downloadOriginal(page,s,'revision');await expect(page.locator('#fc-status')).toContainText('已交给浏览器下载');
  expect(s.metadataReads).toEqual([ids.oldRevision,ids.oldRevision]);expect(s.byteReads).toEqual([ids.oldRevision]);expect(downloads).toHaveLength(1);await noBusiness(s,before);
});
