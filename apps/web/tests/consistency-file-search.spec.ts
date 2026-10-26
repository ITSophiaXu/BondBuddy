import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {PROJECT_FILE_UPDATE_PRICE} from '@bondbuddy/contracts';
import {fixture,open,openUpdate,detail,resultRow,fileIds,checkId,patchRun,base,cacheKey,
  seedSelection,addHistoricalCheck,pausedClock,holdNextRead,writes,serverSnapshot,assertFixture,type State} from './consistency-reading-fixtures';
import {replaceCurrent} from './consistency-selection-fixtures';
import {captureConsistencyFileSearch,installConsistencyFileSearchReference} from './consistency-file-search-reference';

// Desktop-only synthetic HTTP/browser journeys. These checks do not exercise a
// worker, PostgreSQL, actual billing, Word/WPS or professional business review.
// Reuse the existing closed public-schema producer and its unexpected-call guard.
const reference=process.env.BB_CONSISTENCY_FILE_SEARCH_REFERENCE==='1';
const search=(page:Page)=>page.locator('#fc-file-search');
const clear=(page:Page)=>page.locator('[data-fc-clear-search]');
const rows=(page:Page)=>page.locator('[data-fc-result-version]');
const checkbox=(page:Page,version:string)=>page.locator('[data-fc-select="'+version+'"]');
const facet=(page:Page,value:string)=>page.locator('.fc-summary [data-fc-filter="'+value+'"]');
const dialog=(page:Page)=>page.locator('dialog.fc-confirm[open]');
const visibleVersions=(page:Page)=>rows(page).evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.fcResultVersion));
const cached=(page:Page)=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),cacheKey);
function rename(s:State,version:string,name:string){
  s.files.find(f=>f.version_id===version)!.filename=name;
  for(const c of s.checks)for(const f of c.files)if(f.file_version_id===version)f.filename=name;
  for(const batch of s.batches)for(const item of batch.items)if(item.file_version_id===version)item.filename=name;
}
async function frames(page:Page){await page.clock.runFor(80);}
async function start(page:Page,s=fixture({active:false}),file?:string){
  await pausedClock(page);await open(page,s,file);await expect(search(page)).toBeVisible();await frames(page);return s;
}
async function tick(page:Page,s:State){
  const before={...s.readCounts};await page.clock.runFor(4000);
  for(const kind of ['checks','files','workspace','updates'] as const)
    await expect.poll(()=>s.reads.filter(r=>r.kind===kind&&r.generation>before[kind]&&r.replied).length).toBeGreaterThan(0);
  await frames(page);
}
async function selection(page:Page,count:number,hidden=0){
  const text='已选择 '+count+' 份文件 · 共 '+(count*PROJECT_FILE_UPDATE_PRICE.points).toLocaleString('zh-CN')+' 积分'+(hidden?'（含 '+hidden+' 份筛选外文件）':'');
  await expect(page.locator('#fc-selection')).toHaveText(text);await expect(page.locator('[data-fc-selection]')).toHaveText(text);
}
async function chooseTwo(page:Page){await checkbox(page,fileIds.issuer).check();await checkbox(page,fileIds.financial).check();}
async function noBusiness(page:Page,s:State,before:ReturnType<typeof serverSnapshot>){
  expect(writes(s)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);await assertFixture(page);
}
async function caret(page:Page){return search(page).evaluate((e:HTMLInputElement)=>({start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection}));}

test.afterEach(async({page})=>assertFixture(page));

test.describe('consistency file search desktop journeys',()=>{
test.skip(reference,'Only the exact component comparison runs in reference mode.');

test('consistency file search: full displayed filenames use trimmed case-insensitive literal text and never finding text or identifiers',async({page})=>{
  const s=fixture({active:false});
  const name='合成'+'长文件名用于确认完整名称'.repeat(8)+'_Tail[最终].DOCX';rename(s,fileIds.financial,name);
  rename(s,fileIds.issuer,'合成带点星号.*的文件.docx');
  const finding=s.checks[0].result!.files.find(f=>f.file_version_id===fileIds.financial)!.findings[0];finding.reason+='正文专用查找词';
  await start(page,s);const before=serverSnapshot(s),calls=s.calls.length,wholeCounts=await page.locator('.fc-summary strong').allTextContents();
  await search(page).fill('  tail[最终].docx  ');expect(await visibleVersions(page)).toEqual([fileIds.financial]);
  await expect(resultRow(page,fileIds.financial).locator('.pf-template-row strong')).toHaveText(name);
  await expect(page.locator('[data-fc-search-count]')).toHaveText('当前显示 1 份 / 本轮 12 份文件。');
  expect(await page.locator('.fc-summary strong').allTextContents()).toEqual(wholeCounts);
  await search(page).fill('.*');expect(await visibleVersions(page)).toEqual([fileIds.issuer]);
  for(const query of ['正文专用查找词',finding.id,fileIds.financial,checkId,'[不存在]']){
    await search(page).fill(query);await expect(rows(page)).toHaveCount(0);await expect(page.locator('.fc-filter-empty')).toBeVisible();
  }
  await search(page).fill('   ');await expect(rows(page)).toHaveCount(12);
  expect(s.calls.slice(calls),'Pure filename searches perform no HTTP, including wallet reads').toEqual([]);await noBusiness(page,s,before);
});

test('consistency file search: duplicate filenames retain distinct original versions and replacement filenames do not rename historical results',async({page})=>{
  const s=fixture({active:false}),shared='合成并列[终稿].DOCX';rename(s,fileIds.issuer,shared);rename(s,fileIds.financial,shared);
  const replacement=replaceCurrent(s,fileIds.issuer);replacement.filename='合成替换稿独有名称.docx';
  await start(page,s);const before=serverSnapshot(s);
  await search(page).fill('并列[终稿].docx');expect(await visibleVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);
  await expect(checkbox(page,fileIds.issuer)).toBeDisabled();await expect(checkbox(page,fileIds.financial)).toBeEnabled();
  await expect(resultRow(page,fileIds.issuer).locator('.pf-template-row strong')).toHaveText(shared);
  await search(page).fill('替换稿独有名称');await expect(rows(page)).toHaveCount(0);await noBusiness(page,s,before);
});

test('consistency file search: query intersects status, clearing preserves status, and view-all clears both without HTTP',async({page})=>{
  const s=fixture({active:false});rename(s,fileIds.issuer,'交集人工发行人.docx');rename(s,fileIds.financial,'交集财务文件.docx');
  await start(page,s);const before=serverSnapshot(s),calls=s.calls.length;
  await search(page).fill('交集');await facet(page,'manual').click();
  await expect(search(page)).toHaveValue('交集');await expect(page.locator('#fc-filter')).toHaveValue('manual');expect(await visibleVersions(page)).toEqual([fileIds.issuer]);
  await clear(page).click();await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('manual');
  expect(await visibleVersions(page)).toEqual([fileIds.issuer,fileIds.credit]);
  await search(page).fill('财务文件');await expect(rows(page)).toHaveCount(0);
  await page.locator('.fc-filter-empty [data-fc-filter="all"]').click();await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('all');await expect(rows(page)).toHaveCount(12);
  expect(s.calls.slice(calls)).toEqual([]);await noBusiness(page,s,before);
});

test('consistency file search: local query is absent from business cache and reload starts with an empty query while retaining chosen versions',async({page})=>{
  const s=await start(page),before=serverSnapshot(s);await chooseTwo(page);const original=await cached(page),calls=s.calls.length;
  await page.evaluate(key=>{
    const w=window as any;w.consistencySearchCacheWrites=[];
    const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
    Storage.prototype.setItem=function(k:string,value:string){if(this===sessionStorage&&k===key)w.consistencySearchCacheWrites.push({method:'set',value});return set.call(this,k,value);};
    Storage.prototype.removeItem=function(k:string){if(this===sessionStorage&&k===key)w.consistencySearchCacheWrites.push({method:'remove'});return remove.call(this,k);};
  },cacheKey);
  await search(page).fill('不会匹配的唯一查找词');await expect(rows(page)).toHaveCount(0);
  expect(await cached(page),'Typing must not add search text to the business retry/selection cache').toEqual(original);
  await clear(page).click();await expect(rows(page)).toHaveCount(12);expect(await cached(page)).toEqual(original);expect(s.calls.slice(calls)).toEqual([]);
  expect(await page.evaluate(()=>(window as any).consistencySearchCacheWrites),'Pure search and clear do not rewrite business cache').toEqual([]);
  await search(page).fill('不会持久化的第二个查找词');await page.reload();await expect(search(page)).toHaveValue('');
  await expect(checkbox(page,fileIds.issuer)).toBeChecked();await expect(checkbox(page,fileIds.financial)).toBeChecked();await selection(page,2);await noBusiness(page,s,before);
});

test('consistency file search: select-all changes only displayed eligible files and hidden selection remains chargeable and reviewable',async({page})=>{
  const s=fixture({active:false});rename(s,fileIds.issuer,'单独显示的发行人.docx');rename(s,fileIds.financial,'隐藏的财务文件.docx');
  await start(page,s);const before=serverSnapshot(s);await checkbox(page,fileIds.financial).check();
  await search(page).fill('单独显示');await selection(page,1,1);await page.locator('#fc-all').check();await selection(page,2,1);
  await page.locator('#fc-all').uncheck();await selection(page,1,1);
  await clear(page).click();await expect(checkbox(page,fileIds.issuer)).not.toBeChecked();await expect(checkbox(page,fileIds.financial)).toBeChecked();
  await checkbox(page,fileIds.issuer).check();await search(page).fill('单独显示');await selection(page,2,1);
  await page.locator('[data-fc-show-selected]').click();await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('selected');
  expect(await visibleVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);await selection(page,2);await noBusiness(page,s,before);
});

test('consistency file search: hidden chosen originals appear in either confirmation and only explicit confirmation submits the full unchanged price envelope',async({page})=>{
  const s=fixture({active:false});rename(s,fileIds.issuer,'显示发行人.docx');rename(s,fileIds.financial,'隐藏财务.docx');
  await start(page,s);await chooseTwo(page);const before=serverSnapshot(s),names=[fileIds.issuer,fileIds.financial].map(v=>s.checks[0].files.find(f=>f.file_version_id===v)!.filename);
  await search(page).fill('显示发行人');await selection(page,2,1);await page.locator('#fc-accept-top').click();await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(names);await expect(dialog(page)).toContainText('9,000');await noBusiness(page,s,before);
  await dialog(page).getByRole('button',{name:'返回调整',exact:true}).click();await page.locator('#fc-accept').click();await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(names);expect(s.posts).toEqual([]);
  await dialog(page).locator('#fc-confirm-update').click();await expect.poll(()=>s.posts.length).toBe(1);
  expect(s.posts[0]).toEqual({checkId,body:{request_id:expect.any(String),expected_check_sha256:s.checks[0].sha256,price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:9000,files:[{file_version_id:fileIds.issuer},{file_version_id:fileIds.financial}]}});
  expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);expect(writes(s).map(c=>c.path)).toEqual([base+'/checks/'+checkId+'/updates']);
  expect(s.checks).toEqual(before.checks);expect(s.files).toEqual(before.files);expect(s.source).toEqual(before.source);
});

test('consistency file search: searching after a lost receipt preserves the frozen original request and explicit retry accepts only that receipt once',async({page})=>{
  const s=fixture({active:false});s.dropRemaining=true;await start(page,s);await chooseTwo(page);await page.locator('#fc-accept-top').click();await dialog(page).locator('#fc-confirm-update').click();
  await expect.poll(()=>s.posts.length).toBe(1);await expect(page.locator('#fc-pending-action')).toBeVisible();const original=structuredClone(s.posts[0]),pending=(await cached(page)).pendingUpdate,before=serverSnapshot(s);
  await dialog(page).getByRole('button',{name:'返回调整',exact:true}).click();const calls=s.calls.length;
  await search(page).fill('完全无匹配');await expect(rows(page)).toHaveCount(0);await clear(page).click();await facet(page,'manual').click();await search(page).fill('仍然无匹配');
  await page.locator('.fc-filter-empty [data-fc-filter="all"]').click();await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('all');
  expect((await cached(page)).pendingUpdate).toEqual(pending);expect(s.calls.slice(calls)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);expect(s.posts).toHaveLength(1);
  await expect(page.locator('#fc-accept-top')).toBeDisabled();await expect(page.locator('#fc-accept')).toBeDisabled();
  await page.locator('#fc-pending-action').click();await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(pending.filenames);await expect(dialog(page)).toContainText('9,000');
  await dialog(page).locator('#fc-confirm-update').click();await expect.poll(()=>s.posts.length).toBe(2);expect(s.posts[1]).toEqual(original);expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);
});

test('consistency file search: a real scheduled quartet preserves the query, input focus and backward selection range',async({page})=>{
  const s=fixture();rename(s,fileIds.financial,'CaretFinancial文件.docx');await start(page,s);const before=serverSnapshot(s);
  await search(page).fill('CaretFinancial');await search(page).evaluate((e:HTMLInputElement)=>e.setSelectionRange(2,9,'backward'));const original=await caret(page);
  await tick(page,s);await expect(search(page)).toHaveValue('CaretFinancial');await expect(search(page)).toBeFocused();expect(await caret(page)).toEqual(original);expect(await visibleVersions(page)).toEqual([fileIds.financial]);
  await search(page).fill('零匹配焦点');await page.locator('[data-fc-show-all="toolbar"]').focus();await tick(page,s);await expect(page.locator('[data-fc-show-all="toolbar"]')).toBeFocused();
  await page.locator('[data-fc-show-all="empty"]').focus();await tick(page,s);await expect(page.locator('[data-fc-show-all="empty"]')).toBeFocused();await noBusiness(page,s,before);
});

test('consistency file search: a delayed scheduled response honors the newer query and safe search focus instead of restoring an old file or execution control',async({page})=>{
  const s=fixture();rename(s,fileIds.issuer,'先前结果发行人.docx');rename(s,fileIds.financial,'后来结果财务.docx');await start(page,s);const before=serverSnapshot(s);
  await search(page).fill('先前结果');const held=holdNextRead(s);await page.clock.runFor(4000);await held.arrived;
  await search(page).fill('后来结果');expect(await visibleVersions(page)).toEqual([fileIds.financial]);await search(page).fill('后来也没有结果');await expect(rows(page)).toHaveCount(0);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+base+'/checks');held.release();await response;await frames(page);
  await expect(search(page)).toHaveValue('后来也没有结果');await expect(search(page)).toBeFocused();await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('[data-fc-file]:focus,#fc-accept:focus,#fc-accept-top:focus,#fc-all:focus')).toHaveCount(0);await noBusiness(page,s,before);
});

test('consistency file search: synthetic IME composition keeps the same live input and committed list through polling then applies the complete value once',async({page})=>{
  const s=fixture();rename(s,fileIds.issuer,'Origin初始文件.docx');rename(s,fileIds.financial,'IMEMatch财务终稿.docx');await start(page,s);const before=serverSnapshot(s);
  await search(page).fill('Origin');const handle=await search(page).elementHandle();
  await search(page).evaluate((e:HTMLInputElement)=>{e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));e.value='IMEMatch';e.dispatchEvent(new InputEvent('input',{bubbles:true,data:'IMEMatch',inputType:'insertCompositionText',isComposing:true}));});
  expect(await visibleVersions(page)).toEqual([fileIds.issuer]);await tick(page,s);
  expect(await handle!.evaluate(e=>e.isConnected&&e===document.querySelector('#fc-file-search'))).toBe(true);await expect(search(page)).toHaveValue('IMEMatch');await expect(search(page)).toBeFocused();expect(await visibleVersions(page)).toEqual([fileIds.issuer]);
  await search(page).evaluate((e:HTMLInputElement)=>{e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'IMEMatch'}));});
  await expect.poll(()=>visibleVersions(page)).toEqual([fileIds.financial]);await expect(search(page)).toHaveValue('IMEMatch');await expect(search(page)).toBeFocused();
  // Browsers can emit a final matching input after compositionend. It must not
  // create another query transition or remount the just committed input.
  const committed=await search(page).elementHandle(),calls=s.calls.length;
  await search(page).evaluate((e:HTMLInputElement)=>e.dispatchEvent(new InputEvent('input',{bubbles:true,data:'IMEMatch',inputType:'insertText',isComposing:false})));
  expect(await committed!.evaluate(e=>e.isConnected&&e===document.querySelector('#fc-file-search'))).toBe(true);expect(await visibleVersions(page)).toEqual([fileIds.financial]);expect(s.calls.slice(calls)).toEqual([]);await noBusiness(page,s,before);
});

test('consistency file search: file deep-link starts unfiltered, later status changes retain the explicitly entered query',async({page})=>{
  const s=fixture({active:false});rename(s,fileIds.financial,'DeepLink财务文件.docx');await seedSelection(page,s,[fileIds.issuer],'manual');await start(page,s,fileIds.financial);const before=serverSnapshot(s);
  await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('all');await expect(rows(page)).toHaveCount(12);await expect(detail(page)).toHaveAttribute('open','');
  await search(page).fill('DeepLink');await facet(page,'conflict').click();await expect(search(page)).toHaveValue('DeepLink');expect(await visibleVersions(page)).toEqual([fileIds.financial]);
  await facet(page,'manual').click();await expect(search(page)).toHaveValue('DeepLink');await expect(rows(page)).toHaveCount(0);await noBusiness(page,s,before);
});

test('consistency file search: original update locate clears query and status only on arrival or explicit locate, while later polls retain new intent',async({page})=>{
  await pausedClock(page);const s=fixture();rename(s,fileIds.financial,'UpdateOther财务文件.docx');await openUpdate(page,s);await frames(page);const before=serverSnapshot(s);
  await expect(search(page)).toHaveValue('');await expect(resultRow(page,fileIds.issuer)).toBeFocused();await expect(page.locator('#fc-update-task')).toHaveAttribute('data-fc-update-run',patchRun);
  await search(page).fill('UpdateOther');await facet(page,'manual').click();await expect(rows(page)).toHaveCount(0);await tick(page,s);await expect(search(page)).toHaveValue('UpdateOther');await expect(page.locator('#fc-filter')).toHaveValue('manual');
  await page.locator('[data-fc-locate-update]').click();await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('all');await expect(resultRow(page,fileIds.issuer)).toBeFocused();await expect(detail(page,fileIds.issuer)).toHaveAttribute('open','');
  await search(page).fill('UpdateOther');await tick(page,s);await expect(search(page)).toHaveValue('UpdateOther');expect(await visibleVersions(page)).toEqual([fileIds.financial]);await noBusiness(page,s,before);
});

test('consistency file search: switching to a distinct historical check clears query without borrowing same-version reading or selection',async({page})=>{
  const s=fixture({active:false});rename(s,fileIds.financial,'History财务文件.docx');const older=addHistoricalCheck(s);await start(page,s);const before=serverSnapshot(s);
  await checkbox(page,fileIds.financial).check();await search(page).fill('History');await facet(page,'conflict').click();await detail(page).locator('summary').click();
  await page.locator('#fc-history').selectOption(older.run_id);await expect(page.locator('#fc-history')).toHaveValue(older.run_id);await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('conflict');
  expect(await visibleVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);await expect(checkbox(page,fileIds.financial)).not.toBeChecked();await expect(detail(page)).not.toHaveAttribute('open','');await selection(page,0);await noBusiness(page,s,before);
});

test('consistency file search: desktop search has an accessible name, limits input to 200 characters and introduces no horizontal overflow at 1440 or 1024',async({page})=>{
  const s=await start(page),before=serverSnapshot(s);await expect(search(page)).toHaveAccessibleName(/文件|查找/);await expect(search(page)).toHaveAttribute('maxlength','200');
  await search(page).fill('查'.repeat(220));expect((await search(page).inputValue()).length).toBe(200);await expect(rows(page)).toHaveCount(0);
  for(const width of [1440,1024]){
    await page.setViewportSize({width,height:960});await frames(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const boxes=await page.locator('#fc-file-search,[data-fc-clear-search],[data-fc-search-count]').evaluateAll(nodes=>nodes.filter(n=>n.checkVisibility()).map(n=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})));
    expect(boxes.length).toBeGreaterThanOrEqual(2);for(const box of boxes){expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width);expect(box.width).toBeGreaterThan(0);}
  }
  await noBusiness(page,s,before);
});

test('consistency file search: a defensive ambiguous checked-version projection cannot borrow one matching filename to reveal another row',async({page})=>{
  const s=fixture({active:false}),check=s.checks[0],original=check.files.find(f=>f.file_version_id===fileIds.financial)!;
  // Explicit corrupt/stale projection allowed by the JSON shape, not a claim
  // about normal immutable worker output. Keep both schema arrays aligned.
  s.projectionFaults.push('R41 defensive duplicate checked file_version_id with different filenames; not a normal producer output');
  check.files.push({...structuredClone(original),filename:'AmbiguousOnly借用名称.docx'});check.result!.files.push(structuredClone(check.result!.files.find(f=>f.file_version_id===fileIds.financial)!));
  await start(page,s);const before=serverSnapshot(s);await search(page).fill('AmbiguousOnly');await expect(rows(page)).toHaveCount(0);await noBusiness(page,s,before);
});
test('consistency file search: status choices including show-all and show-selected retain existing filter memory without persisting the query',async({page})=>{
  const s=await start(page),before=serverSnapshot(s);await chooseTwo(page);await facet(page,'manual').click();expect((await cached(page)).filter).toBe('manual');
  const remembered=await cached(page);
  await page.evaluate(key=>{const w=window as any;w.searchScopeCacheCalls=[];const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
    Storage.prototype.setItem=function(k:string,v:string){if(this===sessionStorage&&k===key)w.searchScopeCacheCalls.push('set');return set.call(this,k,v);};
    Storage.prototype.removeItem=function(k:string){if(this===sessionStorage&&k===key)w.searchScopeCacheCalls.push('remove');return remove.call(this,k);};},cacheKey);
  const calls=s.calls.length;await search(page).fill('没有匹配的文件');await page.locator('[data-fc-show-all="toolbar"]').click();await page.locator('[data-fc-show-selected]').click();
  await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('selected');expect(await visibleVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);
  expect(await cached(page)).toEqual({...remembered,filter:'selected'});expect(await page.evaluate(()=>(window as any).searchScopeCacheCalls)).toEqual(['set','set']);expect(s.calls.slice(calls)).toEqual([]);
  await page.reload();await expect(search(page)).toHaveValue('');await expect(page.locator('#fc-filter')).toHaveValue('selected');expect((await cached(page)).chosen).toEqual(remembered.chosen);await noBusiness(page,s,before);
});

});

test('consistency file search component comparison: exact R40 and current preserve the same twelve original families, hidden choices and two-file confirmation at 1440',async({page})=>{
  const verify=reference?await installConsistencyFileSearchReference(page):undefined;
  await pausedClock(page);const s=fixture({active:false});await open(page,s);await frames(page);const before=serverSnapshot(s);
  const originals=s.checks[0].files,target=originals[originals.length-1],names=[fileIds.issuer,fileIds.financial].map(v=>originals.find(f=>f.file_version_id===v)!.filename);
  const directory=process.env.BB_CONSISTENCY_FILE_SEARCH_EVIDENCE??test.info().outputPath(reference?'reference':'current');
  const align=()=>page.locator('.fc-results').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  const audit=(action:string)=>({reference,synthetic:true,action,check:checkId,source_version:s.source.version_id,
    checked_families:originals.length,unique_document_types:new Set(s.files.map(f=>f.document_type)).size,
    intended_query:target.filename,target_version:target.file_version_id,projection_faults:s.projectionFaults,writes:writes(s),
    limits:'Exact R40 component comparison in the current surrounding app; synthetic HTTP only. No real worker, Word/WPS, ledger or overall UX acceptance.'});
  await chooseTwo(page);await selection(page,2);await align();
  const full=await captureConsistencyFileSearch(page,directory,'consistency-file-search-full-list-1440',audit('Both implementations display twelve original catalogue families with exactly the issuer and financial originals selected.'));
  expect(full.rows).toHaveLength(12);await expect(rows(page)).toHaveCount(12);
  if(reference)await expect(search(page)).toHaveCount(0);else await expect(search(page)).toHaveValue('');
  const calls=s.calls.length;
  if(!reference){await search(page).fill(target.filename);expect(await visibleVersions(page)).toEqual([target.file_version_id]);await selection(page,2,2);}
  await align();
  const narrowed=await captureConsistencyFileSearch(page,directory,'consistency-file-search-target-1440',audit(reference?
    'R40 has no filename input: the intended last-file query cannot be entered, so all twelve rows remain and the two chosen originals stay selected.':
    'Current filename query reveals the exact last original only. Both already chosen originals are hidden, remain selected and keep the unchanged 9,000-point total.'));
  expect(narrowed.rows.map(r=>r.version)).toEqual(reference?originals.map(f=>f.file_version_id):[target.file_version_id]);
  expect(s.calls.slice(calls),'Capturing and current local query add no HTTP').toEqual([]);
  await page.locator('#fc-accept').click();await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(names);await expect(dialog(page)).toContainText('9,000');
  await captureConsistencyFileSearch(page,directory,'consistency-file-search-confirm-1440',audit('Both implementations open the same footer confirmation for exactly the original issuer and financial files, without submitting or charging.'));
  await noBusiness(page,s,before);
  if(verify){await mkdir(directory,{recursive:true});await writeFile(join(directory,'consistency-file-search-reference-1440.json'),JSON.stringify(await verify(),null,2)+'\n');}
});
