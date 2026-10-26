import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {downloadBytes,oldBytes,type Variant} from './consistency-task-fixtures';
import {base,historyFixture,ids,individualPath,open,openHistoryTask,readonly,serverSnapshot,type HistoryState} from './consistency-update-history-fixtures';

// Desktop real-frontend/synthetic-HTTP journeys. No worker, ledger, external
// storage, supplier, professional review or Word application is exercised.
const panel=(page:Page)=>page.locator('#fc-update-task');
const evidence=process.env.BB_UPDATE_HISTORY_EVIDENCE_DIR;
async function capture(page:Page,name:string){if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,name+'.png')});}}
async function ready(page:Page){
  await expect(panel(page)).toHaveAttribute('data-fc-update-run',ids.oldRun);
  await expect(panel(page)).toHaveAttribute('data-fc-update-file-version',ids.v1);
  await expect(page.locator('#fc-history')).toHaveValue(ids.oldCheck);
  await expect(page.locator('.pf-source-strip strong')).toHaveText('原募集说明书_V1.docx');
}
async function missing(page:Page){
  await expect(panel(page).getByRole('heading')).toHaveText('指定的文件更新任务暂时无法读取');
  await expect(panel(page).locator('[data-fc-update-download]')).toHaveCount(0);
  await expect(page.locator('.fc-results')).toHaveCount(0);
}
async function originalDownload(page:Page,s:HistoryState,variant:Variant){
  const button=panel(page).locator('[data-fc-update-download="'+ids.oldRun+'"][data-variant="'+variant+'"]');
  await expect(button).toHaveAttribute('data-fc-download',ids.v2);
  const pending=page.waitForEvent('download');await button.click();const download=await pending;
  expect(download.suggestedFilename()).toBe(s.artifacts.get(variant==='revision'?ids.oldRevision:ids.oldClean)!.metadata.filename);
  expect(await downloadBytes(download)).toEqual(oldBytes[variant]);
}

for(const entry of ['projects','files'] as const)test('update history: '+entry+' task entry resolves beyond the recent thirty and downloads its original V2 pair instead of current V3',async({page})=>{
  const s=historyFixture(),before=serverSnapshot(s);await openHistoryTask(page,s,entry);await ready(page);
  expect(s.individualReads).toEqual([individualPath]);await expect(page.locator('#fc-history option')).toHaveCount(31);
  await expect(panel(page)).toContainText('本次交付 V2');await expect(panel(page)).not.toContainText('本次交付 V3');
  await expect(page.locator('[data-fc-result-version="'+ids.v1+'"]')).toBeFocused();
  await panel(page).scrollIntoViewIfNeeded();if(entry==='projects')await capture(page,'update-history-original-v2-1440');
  for(const variant of ['revision','clean'] as const)await originalDownload(page,s,variant);
  expect(s.metadataReads).toEqual([ids.oldRevision,ids.oldClean]);expect(s.byteReads).toEqual([ids.oldRevision,ids.oldClean]);
  await page.reload();await ready(page);await expect(panel(page)).toContainText('本次交付 V2');
  expect(s.individualReads).toEqual([individualPath,individualPath]);await readonly(page,s,before);
});

test('update history: the failed original run never borrows its later successful retry after resolving its old check',async({page})=>{
  const s=await open(page,historyFixture({state:'failed'})),before=serverSnapshot(s);
  await expect(panel(page)).toHaveAttribute('data-fc-update-run',ids.oldRun);await expect(page.locator('#fc-history')).toHaveValue(ids.oldCheck);
  await expect(page.locator('#fc-update-task-state')).toHaveText('本次未完成');await expect(panel(page)).toContainText('当前记录未提供失败原因');
  await expect(panel(page).locator('[data-fc-download]')).toHaveCount(0);expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);
  await readonly(page,s,before);
});

test('update history: an update-only link with a missing workspace remains readable through reload without preparing it',async({page})=>{
  const s=historyFixture();s.workspaceUnavailable=true;const before=serverSnapshot(s);await open(page,s);await ready(page);
  await page.reload();await ready(page);
  expect(s.calls.filter(call=>call.path===base+'/workspace').map(call=>call.method)).toEqual(['GET','GET']);await readonly(page,s,before);
});

test('update history: a recent-list acceptance needs no individual lookup',async({page})=>{
  const s=historyFixture();s.recent=[s.oldCheck,...s.recent.slice(0,29)];const before=serverSnapshot(s);await open(page,s);await ready(page);
  expect(s.individualReads).toEqual([]);await readonly(page,s,before);
});

for(const status of [403,404,503])test('update history: HTTP '+status+' for the original task does not substitute another update and can be read again explicitly',async({page})=>{
  const s=historyFixture();s.individualStatus=status;const before=serverSnapshot(s);await open(page,s);await missing(page);
  expect(s.individualReads).toEqual([individualPath]);expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);
  expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('update_run')).toBe(ids.oldRun);
  if(status===404)await capture(page,'update-history-missing-1440');
  s.individualStatus=200;await panel(page).locator('[data-fc-refresh]').click();await ready(page);
  expect(s.individualReads).toEqual([individualPath,individualPath]);await readonly(page,s,before);
});

for(const status of [403,404])test('update history: HTTP '+status+' after an earlier read removes the old delivery actions',async({page})=>{
  const s=await open(page),before=serverSnapshot(s);await ready(page);s.individualStatus=status;
  await panel(page).locator('[data-fc-refresh]').click();await missing(page);
  await expect(page.locator('[data-fc-control]')).toHaveCount(0);expect(s.individualReads).toEqual([individualPath,individualPath]);
  expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);await readonly(page,s,before);
});

for(const [name,query,noLookup] of [
  ['empty update','update_run=',true],
  ['duplicate update','update_run='+ids.oldRun+'&update_run='+ids.laterRun,true],
  ['conflicting check','update_run='+ids.oldRun+'&run=update-history-recent-0',false],
  ['conflicting file','update_run='+ids.oldRun+'&file='+ids.manual,false],
] as const)test('update history: '+name+' never borrows another task or delivery',async({page})=>{
  const s=await open(page,historyFixture(),query),before=serverSnapshot(s);await missing(page);
  if(noLookup)expect(s.individualReads).toEqual([]);
  expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);await readonly(page,s,before);
});

for(const fault of ['unrelated-check','duplicate-acceptance','invalid-schema'] as const)test('update history: '+fault+' in an individual response cannot become the requested task',async({page})=>{
  const s=historyFixture(),response=structuredClone(fault==='unrelated-check'?s.recent[0]:s.oldCheck);
  if(fault==='duplicate-acceptance')response.updates.push(structuredClone(response.updates[0]));
  if(fault==='invalid-schema')(response as unknown as {source:unknown}).source=null;
  s.individualPayload={check:response};const before=serverSnapshot(s);await open(page,s);await missing(page);
  expect(s.individualReads).toEqual([individualPath]);expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);await readonly(page,s,before);
});

test('update history: a running old patch survives a failed poll and automatically recovers the same original task',async({page})=>{
  const start=new Date('2026-10-26T04:00:00Z');await page.clock.install({time:start});await page.clock.pauseAt(new Date(start.getTime()+1000));
  const s=historyFixture({state:'paused'});s.oldCheck.updates[0].state='running';s.tasks.find(task=>task.run_id===ids.oldRun)!.state='running';s.batches=[];
  await open(page,s);await ready(page);await expect(panel(page).locator('[data-fc-control="pause"][data-run="'+ids.oldRun+'"]')).toBeEnabled();
  s.individualStatus=503;await page.clock.runFor(4000);await expect.poll(()=>s.individualReads.length).toBe(2);
  const warning=page.locator('.fc-warning[role="status"]');await expect(warning).toBeVisible();await expect(warning).toContainText(/上次读取|上次记录/);
  await ready(page);await expect(panel(page).locator('[data-fc-download]')).toHaveCount(0);
  s.individualStatus=200;s.oldCheck.updates[0].state='paused';s.tasks.find(task=>task.run_id===ids.oldRun)!.state='paused';
  await page.clock.runFor(4000);await expect.poll(()=>s.individualReads.length).toBe(3);await ready(page);
  await expect(panel(page).locator('[data-fc-control="resume"][data-run="'+ids.oldRun+'"]')).toBeEnabled();await expect(warning).toHaveCount(0);
  expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);await readonly(page,s);
});
