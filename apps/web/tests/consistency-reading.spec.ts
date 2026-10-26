import {expect,test,type Page,type Locator} from '@playwright/test';
import {fixture,open,openUpdate,install,routeFor,detail,finding,resultRow,fileIds,checkId,patchRun,ids,base,cacheKey,seedSelection,seedUnknownUpdate,addHistoricalCheck,
  pausedClock,holdNextRead,failNextRead,changeCurrentSource,writes,serverSnapshot,assertFixture,assertReadOnly,type State} from './consistency-reading-fixtures';
import {replaceCurrent} from './consistency-selection-fixtures';

// Desktop-only synthetic browser journeys. Root owns execution and raw evidence.
// These assertions do not claim real worker, storage, billing, Word or business
// acceptance. Active batches keep their original project-wide execution guard.
const summary=(page:Page,version=fileIds.financial)=>detail(page,version).locator('summary');
const selected=(page:Page)=>page.locator('[data-fc-select="'+fileIds.financial+'"]');
const refresh=(page:Page)=>page.locator('[data-fc-refresh]').first();
const dialog=(page:Page)=>page.locator('dialog.fc-confirm[open]');
const key=(s:State,version=fileIds.financial,index=4)=>s.checks.find(c=>c.run_id===checkId)!.result!.files.find(f=>f.file_version_id===version)!.findings[index].id;
const byFinding=(page:Page,id:string,version=fileIds.financial)=>resultRow(page,version).locator('[data-fc-finding-id="'+id+'"]');
async function position(locator:Locator){return locator.evaluate(e=>({y:e.getBoundingClientRect().top,visible:e.checkVisibility()&&e.getBoundingClientRect().bottom>0&&e.getBoundingClientRect().top<innerHeight,scrollY}));}
async function observe(page:Page){await page.evaluate(()=>{
  const w=window as any;w.consistencyReadingPaints=0;w.consistencyReadingScrolls=[];
  new MutationObserver(records=>{if(records.some(r=>r.type==='childList'&&r.target===document.querySelector('#app')))w.consistencyReadingPaints++;}).observe(document.querySelector('#app')!,{childList:true,subtree:true});
  const native=window.scrollBy;window.scrollBy=function(...args:any[]){w.consistencyReadingScrolls.push({method:'scrollBy',args,before:scrollY});Reflect.apply(native,window,args);} as typeof window.scrollBy;
});}
const paints=(page:Page)=>page.evaluate(()=>(window as any).consistencyReadingPaints as number);
async function frames(page:Page){await page.clock.runFor(80);}
async function waitPaint(page:Page,before:number){await expect.poll(()=>paints(page)).toBeGreaterThan(before);await frames(page);}
async function waitQuartet(s:State,before:State['readCounts']){for(const kind of ['checks','files','workspace','updates'] as const)await expect.poll(()=>s.reads.filter(r=>r.kind===kind&&r.generation>before[kind]&&r.replied).length).toBeGreaterThan(0);}
async function tick(page:Page,s:State,paint=true){const before={...s.readCounts},count=await paints(page);await page.clock.runFor(4000);await waitQuartet(s,before);if(paint)await waitPaint(page,count);else await frames(page);}
async function setup(page:Page,file?:string){await pausedClock(page);const s=fixture();await seedSelection(page,s);await open(page,s,file);await observe(page);return s;}
async function expand(page:Page,version=fileIds.financial){if(await detail(page,version).getAttribute('open')===null){await summary(page,version).focus();await page.keyboard.press('Enter');}await expect(detail(page,version)).toHaveAttribute('open','');}
async function longReading(page:Page){await expand(page);await finding(page).evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await frames(page);}
async function stablePosition(locator:Locator,before:Awaited<ReturnType<typeof position>>){const after=await position(locator);expect(after.visible).toBe(true);expect(Math.abs(after.y-before.y)).toBeLessThanOrEqual(1.5);}
async function noBusiness(page:Page,s:State,before=serverSnapshot(s)){assertReadOnly(s);expect(serverSnapshot(s)).toEqual(before);await assertFixture(page);}
async function actualWheel(page:Page,delta=180){const before=await page.evaluate(()=>scrollY);await page.mouse.move(1190,580);await page.mouse.wheel(0,delta);await expect.poll(()=>page.evaluate(()=>scrollY)).not.toBe(before);await frames(page);}
test.afterEach(async({page})=>assertFixture(page));

test('consistency reading: real 4s poll keeps offscreen native summary focus and the visible nonexecuting finding without zero-delta scrolling',async({page})=>{
  const s=await setup(page),before=serverSnapshot(s);await longReading(page);const id=key(s),at=await position(byFinding(page,id));expect(at.visible).toBe(true);await expect(summary(page)).toBeFocused();
  await expect(selected(page)).toBeChecked();await expect(selected(page)).toBeDisabled();await expect(page.locator('#fc-selection')).toContainText('共 0 积分');
  await page.evaluate(()=>(window as any).consistencyReadingScrolls=[]);await tick(page,s);await stablePosition(byFinding(page,id),at);await expect(summary(page)).toBeFocused();await expect(detail(page)).toHaveAttribute('open','');
  expect(await page.evaluate(()=>(window as any).consistencyReadingScrolls)).toEqual([]);await expect(selected(page)).toBeChecked();await noBusiness(page,s,before);
});
test('consistency reading: source change keeps exact historical finding and safe focus while blocking execution of the selected original',async({page})=>{
  const s=await setup(page);await longReading(page);const id=key(s),at=await position(byFinding(page,id));changeCurrentSource(s);const before=serverSnapshot(s);
  await tick(page,s);await expect(page.locator('.fc-source-freshness')).toContainText(s.source.filename);await stablePosition(byFinding(page,id),at);await expect(summary(page)).toBeFocused();
  await expect(selected(page)).toBeChecked();await expect(selected(page)).toBeDisabled();await expect(page.locator('#fc-accept-top')).toBeDisabled();await expect(page.locator('#fc-selection')).toContainText('共 0 积分');await noBusiness(page,s,before);
});
test('consistency reading: an individually running issuer update keeps an enabled financial checkbox selection and native focus through polling',async({page})=>{
  await pausedClock(page);const s=fixture();s.batches=[];await open(page,s);await observe(page);const before=serverSnapshot(s);
  // The check's accepted issuer update still drives the real timer. This case
  // has no global batch; the running issuer is blocked while financial remains
  // eligible. The normal running-batch case above still forbids new selection.
  await expect(selected(page)).toBeEnabled();await selected(page).check();await expect(selected(page)).toBeFocused();await expect(page.locator('#fc-selection')).toContainText('共 4,500 积分');await tick(page,s);
  await expect(selected(page)).toBeChecked();await expect(selected(page)).toBeEnabled();await expect(selected(page)).toBeFocused();await expect(page.locator('#fc-selection')).toContainText('共 4,500 积分');await noBusiness(page,s,before);
});
for(const change of ['source','current-version'] as const)test(`consistency reading: selected checkbox disabled by ${change} falls back to the exact original nonexecuting file`,async({page})=>{
  await pausedClock(page);const s=fixture();s.batches=[];await open(page,s);await observe(page);await selected(page).check();await expect(selected(page)).toBeFocused();
  if(change==='source')changeCurrentSource(s);else replaceCurrent(s,fileIds.financial);const before=serverSnapshot(s);await tick(page,s);
  await expect(selected(page)).toBeChecked();await expect(selected(page)).toBeDisabled();await expect(resultRow(page,fileIds.financial)).toBeFocused();await expect(page.locator('#fc-selection')).toContainText('共 0 积分');await expect(page.locator('[data-fc-file]:focus')).toHaveCount(0);
  expect(await page.evaluate(()=>(document.activeElement as HTMLElement)?.dataset.fcResultVersion)).toBe(fileIds.financial);await noBusiness(page,s,before);
});
test('consistency reading: select-all focus and checked state do not borrow the old eligible collection after its source changes',async({page})=>{
  await pausedClock(page);const s=fixture();s.batches=[];await open(page,s);await observe(page);const all=page.locator('#fc-all');await all.check();await expect(all).toBeFocused();await expect(selected(page)).toBeChecked();changeCurrentSource(s);const before=serverSnapshot(s);await tick(page,s);
  await expect(all).not.toBeChecked();await expect(all).not.toBeFocused();await expect(selected(page)).toBeChecked();await expect(selected(page)).toBeDisabled();await expect(page.locator('#fc-results-heading')).toBeFocused();await expect(page.locator('#fc-selection')).toContainText('共 0 积分');await noBusiness(page,s,before);
});
test('consistency reading: deep-linked native details can be hand-closed and stay closed across repeated 4s polls',async({page})=>{
  const s=await setup(page,fileIds.financial),before=serverSnapshot(s);await summary(page).focus();await page.keyboard.press('Enter');await expect(detail(page)).not.toHaveAttribute('open','');
  await tick(page,s);await expect(detail(page)).not.toHaveAttribute('open','');await expect(summary(page)).toBeFocused();await tick(page,s);await expect(detail(page)).not.toHaveAttribute('open','');await noBusiness(page,s,before);
});
test('consistency reading: a visible native summary keeps keyboard focus after polling and can be toggled again',async({page})=>{
  const s=await setup(page),before=serverSnapshot(s);await expand(page);await summary(page).evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await frames(page);await tick(page,s);await expect(summary(page)).toBeFocused();await page.keyboard.press('Enter');await expect(detail(page)).not.toHaveAttribute('open','');await noBusiness(page,s,before);
});
test('consistency reading: BODY reading preserves its visible finding through source growth without creating a new focus',async({page})=>{
  const s=await setup(page,fileIds.financial);await page.evaluate(()=>{const active=document.activeElement;if(active instanceof HTMLElement)active.blur();});await finding(page).evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await frames(page);
  expect(await page.evaluate(()=>document.activeElement?.tagName)).toBe('BODY');const id=key(s),at=await position(byFinding(page,id));changeCurrentSource(s);const before=serverSnapshot(s);await tick(page,s);
  await stablePosition(byFinding(page,id),at);expect(await page.evaluate(()=>document.activeElement?.tagName)).toBe('BODY');await noBusiness(page,s,before);
});
test('consistency reading: delayed poll uses the newer filter, native details, focus and actual wheel position',async({page})=>{
  const s=await setup(page),before=serverSnapshot(s);await longReading(page);const held=holdNextRead(s);await page.clock.runFor(4000);await held.arrived;
  await page.locator('#fc-filter').selectOption('manual');await expand(page,fileIds.credit);await finding(page,fileIds.credit,2).evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await frames(page);await actualWheel(page);
  const id=key(s,fileIds.credit,2),at=await position(byFinding(page,id,fileIds.credit)),count=await paints(page);held.release();await waitPaint(page,count);await expect(page.locator('#fc-filter')).toHaveValue('manual');await expect(summary(page,fileIds.credit)).toBeFocused();await stablePosition(byFinding(page,id,fileIds.credit),at);await noBusiness(page,s,before);
});
test('consistency reading: delayed poll respects a newer wheel and focused nonexecuting finding in the same filter',async({page})=>{
  const s=await setup(page),before=serverSnapshot(s);await longReading(page);const held=holdNextRead(s);await page.clock.runFor(4000);await held.arrived;
  const next=byFinding(page,key(s,fileIds.financial,6));await next.focus();await next.evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await frames(page);await actualWheel(page);const at=await position(next),count=await paints(page);held.release();await waitPaint(page,count);await stablePosition(next,at);await expect(next).toBeFocused();await noBusiness(page,s,before);
});
test('consistency reading: failed scheduled read keeps old content and focus then retries exactly once after 4s',async({page})=>{
  const s=await setup(page),before=serverSnapshot(s);await longReading(page);const id=key(s),at=await position(byFinding(page,id)),count=await paints(page);failNextRead(s);await tick(page,s,false);
  await expect(page.locator('#fc-status')).toContainText('刷新未成功');expect(await paints(page)).toBe(count);await stablePosition(byFinding(page,id),at);await expect(summary(page)).toBeFocused();
  const reads=s.readCounts.checks;await tick(page,s);expect(s.readCounts.checks).toBe(reads+1);expect(s.reads.filter(r=>r.kind==='checks'&&r.failed)).toHaveLength(1);await stablePosition(byFinding(page,id),at);await expect(summary(page)).toBeFocused();await noBusiness(page,s,before);
});
test('consistency reading: explicit read-only refresh paints once and preserves its native keyboard focus',async({page})=>{
  const s=await setup(page),before=serverSnapshot(s);await refresh(page).focus();const count=await paints(page),reads=s.readCounts.checks;await page.keyboard.press('Enter');await expect(page.locator('#fc-status')).toContainText('已重新读取任务与文件记录');await expect(refresh(page)).toBeEnabled();await waitPaint(page,count);
  expect(await paints(page)).toBe(count+1);expect(s.readCounts.checks).toBe(reads+1);await expect(refresh(page)).toBeFocused();await noBusiness(page,s,before);
});
test('consistency reading: late old quartet cannot overwrite newer source, success status or the next poll schedule',async({page})=>{
  const s=await setup(page);await longReading(page);const held=holdNextRead(s),oldSource=s.source.version_id;await page.clock.runFor(4000);await held.arrived;changeCurrentSource(s);const before=serverSnapshot(s);
  await refresh(page).click();await expect(page.locator('#fc-status')).toContainText('已重新读取任务与文件记录');await expect(refresh(page)).toBeEnabled();await expect(page.locator('.fc-source-freshness')).toContainText(s.source.filename);await frames(page);
  const count=await paints(page),reads=s.readCounts.checks,text=await page.locator('.fc-source-freshness').textContent();expect(s.reads.some(r=>r.kind==='checks'&&r.generation===held.generation&&r.source===oldSource&&!r.replied)).toBe(true);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+base+'/checks');held.release();await response;await expect.poll(()=>s.reads.find(r=>r.kind==='checks'&&r.generation===held.generation)?.replied).toBe(true);await frames(page);
  expect(await paints(page)).toBe(count);await expect(page.locator('.fc-source-freshness')).toHaveText(text!);await expect(page.locator('#fc-status')).toContainText('已重新读取任务与文件记录');await tick(page,s);expect(s.readCounts.checks).toBe(reads+1);await expect(page.locator('.fc-source-freshness')).toHaveText(text!);await noBusiness(page,s,before);
});
test('consistency reading: selecting a different check does not borrow the same file or finding IDs from the previous check',async({page})=>{
  await pausedClock(page);const s=fixture(),older=addHistoricalCheck(s);await seedSelection(page,s);await open(page,s);await observe(page);const before=serverSnapshot(s);await longReading(page);await page.locator('#fc-history').selectOption(older.run_id);await expect(page.locator('#fc-history')).toHaveValue(older.run_id);await expect(detail(page)).not.toHaveAttribute('open','');
  await expect(selected(page)).not.toBeChecked();await expect(byFinding(page,key(s))).not.toBeFocused();await tick(page,s);await expect(page.locator('#fc-history')).toHaveValue(older.run_id);await expect(detail(page)).not.toHaveAttribute('open','');await noBusiness(page,s,before);
});
test('consistency reading: a missing exact finding falls back to its nonexecuting file or heading, never the shifted neighbor',async({page})=>{
  const s=await setup(page);await longReading(page);const id=key(s),old=byFinding(page,id);await old.focus();await old.evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));
  // Explicit defensive projection: immutable real check results do not normally
  // lose an item with an unchanged report hash. Public JSON shape still permits
  // this stale/corrupt projection, so the UI must not borrow the adjacent ID.
  s.projectionFaults.push('R33 defensive missing finding with unchanged report hash; not a normal worker output');const result=s.checks[0].result!.files.find(f=>f.file_version_id===fileIds.financial)!;result.findings=result.findings.filter(f=>f.id!==id);const before=serverSnapshot(s);await tick(page,s);await expect(old).toHaveCount(0);
  const active=await page.evaluate(()=>({id:document.activeElement?.id,version:(document.activeElement as HTMLElement)?.dataset.fcResultVersion,finding:(document.activeElement as HTMLElement)?.dataset.fcFindingId}));expect(active.finding).toBeUndefined();expect(active.version===fileIds.financial||active.id==='fc-results-heading').toBe(true);await noBusiness(page,s,before);
});
test('consistency reading: an existing unknown envelope and open confirmation keep dialog focus during a real poll and retry only that receipt',async({page})=>{
  await pausedClock(page);const s=fixture(),pending=await seedUnknownUpdate(page,s);await open(page,s);await observe(page);const before=serverSnapshot(s);await page.locator('#fc-pending-action').click();await dialog(page).locator('#fc-confirm-update').focus();const handle=await dialog(page).elementHandle();changeCurrentSource(s);const changed=serverSnapshot(s);await tick(page,s);
  expect(await handle!.evaluate(e=>e.isConnected)).toBe(true);await expect(dialog(page).locator('#fc-confirm-update')).toBeFocused();await expect(dialog(page).locator('.fc-confirm-filename')).toHaveText(pending.filenames);await expect(dialog(page)).toContainText('4,500');
  expect(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)!).pendingUpdate,cacheKey)).toEqual(pending);await noBusiness(page,s,changed);expect(before.source.version_id).not.toBe(s.source.version_id);
  const count=await paints(page);await dialog(page).locator('#fc-confirm-update').click();await expect(dialog(page)).toHaveCount(0);await expect(page.locator('#fc-status')).toContainText('已提交所选文件更新');await waitPaint(page,count);expect(await paints(page)).toBe(count+1);
  expect(s.posts).toEqual([{checkId,body:pending.body}]);expect(s.receipts.size).toBe(1);expect(writes(s).map(c=>({path:c.path,body:c.body}))).toEqual([{path:base+'/checks/'+checkId+'/updates',body:pending.body}]);await assertFixture(page);
});
test('consistency reading: explicit pause submits the exact run once and final act paint does not refocus an execution button',async({page})=>{
  const s=await setup(page);s.allowPause=true;const pause=page.locator('[data-fc-control="pause"][data-run="'+patchRun+'"]');await pause.focus();const count=await paints(page);await page.keyboard.press('Enter');await expect.poll(()=>s.runActions.length).toBe(1);await expect(page.locator('#fc-status')).toContainText('任务状态已更新');await waitPaint(page,count);
  expect(await paints(page)).toBe(count+1);expect(s.runActions).toEqual([{run:patchRun,action:'pause',body:{reason:'user_paused'}}]);expect(writes(s).map(c=>({path:c.path,body:c.body}))).toEqual([{path:'/runs/'+patchRun+'/pause',body:{reason:'user_paused'}}]);await expect(page.locator('[data-fc-control]:focus')).toHaveCount(0);
  const active=await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id}));expect(['H1','H2','ARTICLE']).toContain(active.tag);await assertFixture(page);
});
test('consistency reading: exact update arrival locates once, polling preserves the newer filter, and explicit locate remains read-only',async({page})=>{
  await pausedClock(page);const s=fixture();await openUpdate(page,s);await observe(page);const before=serverSnapshot(s);await expect(resultRow(page,fileIds.issuer)).toBeFocused();await expect(detail(page,fileIds.issuer)).toHaveAttribute('open','');await expect(page.locator('#fc-history')).toHaveValue(checkId);
  await page.locator('#fc-filter').selectOption('consistent');await expect(resultRow(page,fileIds.issuer)).toHaveCount(0);await tick(page,s);await expect(page.locator('#fc-filter')).toHaveValue('consistent');await expect(resultRow(page,fileIds.issuer)).toHaveCount(0);
  await page.locator('[data-fc-locate-update]').click();await expect(page.locator('#fc-filter')).toHaveValue('all');await expect(resultRow(page,fileIds.issuer)).toBeFocused();await expect(detail(page,fileIds.issuer)).toHaveAttribute('open','');await noBusiness(page,s,before);
});
test('consistency reading: real running-check polling shows progress until a completed result exists without executing an update',async({page})=>{
  await pausedClock(page);const s=fixture({active:false}),complete=structuredClone(s.checks[0]),task=s.tasks.find(t=>t.run_id===checkId)!;
  s.checks[0].state='running';s.checks[0].stage='checking';s.checks[0].result=null;s.checks[0].sha256=null;task.state='running';task.stage='checking';task.artifact_id=null;
  await install(page,s);await page.goto(routeFor());await expect(page.locator('.fc-progress')).toBeVisible();await observe(page);await tick(page,s);await expect(page.locator('.fc-results')).toHaveCount(0);expect(s.reads.filter(r=>r.kind==='checks').map(r=>r.state)).toEqual(['running','running']);
  s.checks[0]=complete;task.state='succeeded';task.stage='completed';task.artifact_id='consistency-reading-completed-check-report';const before=serverSnapshot(s);await tick(page,s);await expect(page.locator('.fc-results')).toBeVisible();await expect(page.locator('#fc-history')).toHaveValue(checkId);await expect(page.locator('[data-fc-result-version]')).toHaveCount(12);await noBusiness(page,s,before);
});
