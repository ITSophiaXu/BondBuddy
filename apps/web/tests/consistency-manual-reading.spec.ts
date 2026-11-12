import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Locator,type Page} from '@playwright/test';
import {assertFixture,assertPureNavigation,base,cacheCalls,cacheKey,cacheValue,checkId,control,currentFile,detail,dialog,download,
  editedFile,enterFromFiles,expand,finding,fixture,frames,hash,ids,isManual,itemIds,issuerVersion,manualFindings,navigationSnapshot,
  observeCache,open,originalBytes,pausedClock,position,row,serverSnapshot,tick,verifyInstalled,writeCalls,type State} from './consistency-manual-reading-fixtures';
import {captureConsistencyManualReading,installConsistencyManualReadingReference} from './consistency-manual-reading-reference';

// Native main.ts routes and public controls only. Defensive JSON projections are
// explicitly labelled; none is a normal immutable worker-result claim. Root runs
// these independently. Mobile, real services, Word/WPS and ledger acceptance are out of scope.
// Every run discovers current journeys, the sealed baseline and both comparison sides.
const rows=(page:Page)=>page.locator('[data-fc-result-version]');
const idsIn=(locator:Locator)=>locator.locator('[data-fc-finding-id]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.fcFindingId));
async function setup(page:Page,options:Parameters<typeof fixture>[0]={}){await pausedClock(page);const s=await enterFromFiles(page,fixture(options));await observeCache(page);return s;}
async function first(page:Page){await control(page,'first').click();await expect(finding(page,itemIds.first)).toBeFocused();}
async function keyboard(button:Locator,page:Page){await button.focus();await page.keyboard.press('Enter');}
async function inertFocus(page:Page){
  const active=await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id,
    version:(document.activeElement as HTMLElement)?.dataset.fcResultVersion,finding:(document.activeElement as HTMLElement)?.dataset.fcFindingId}));
  expect(active.finding).toBeUndefined();expect(active.version===ids.version||['fc-results-heading','fc-page-heading'].includes(active.id??'')).toBe(true);
  await expect(page.locator('[data-fc-file]:focus,[data-fc-accept]:focus,#fc-accept:focus,[data-fc-control]:focus')).toHaveCount(0);
}
async function pollReadOnly(page:Page,s:State,before=serverSnapshot(s),cache?:string|null){
  await tick(page,s);expect(serverSnapshot(s)).toEqual(before);expect(writeCalls(s)).toEqual([]);if(cache!==undefined)expect(await cacheValue(page)).toBe(cache);assertFixture(s);
}

test.afterEach(async({page})=>verifyInstalled(page));

test.describe('manual reading sealed R38 baseline',()=>{
  test('manual reading baseline: file manual facet still leaves mixed manual findings after automatic findings and has no item navigation',async({page})=>{
    await pausedClock(page);const verify=await installConsistencyManualReadingReference(page),s=await enterFromFiles(page,fixture());
    await page.locator('[data-fc-filter="manual"]').click();await expand(page);await expect(rows(page)).toHaveCount(2);
    // This baseline proves only the old mixed grouping and absent item controls.
    // R38 already preserves full pre-wrap text and original download routes.
    const order=await idsIn(row(page));expect(order.indexOf(itemIds.first)).toBeGreaterThan(order.indexOf(itemIds.autoB));
    await expect(row(page).locator('[data-fc-manual-nav]')).toHaveCount(0);await expect(row(page).locator('[data-fc-manual-position]')).toHaveCount(0);
    for(const item of s.check.result!.files[0].findings)await expect(finding(page,item.id)).toContainText(item.reason);
    expect(writeCalls(s)).toEqual([]);expect(s.updateReceipts.size).toBe(0);assertFixture(s);
    const output=process.env.BB_CONSISTENCY_MANUAL_BASELINE_EVIDENCE;expect(output,'Explicit baseline evidence output').toBeTruthy();
    await finding(page,itemIds.first).evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));await frames(page);
    const facts=await captureConsistencyManualReading(page,output!,'r38-mixed-manual-baseline-1440',{synthetic:true,claim:'Old mixed ordering and absence of item navigation only',http:s.calls,business_writes:writeCalls(s),projection_faults:s.projectionFaults});
    expect(facts.scrollY).toBeGreaterThan(0);await writeFile(join(output!,'baseline-reference-provenance.json'),JSON.stringify(await verify(),null,2)+'\n');
  });
});

test.describe('manual reading current desktop journeys',()=>{

  test('manual reading: native project-file entry keeps every finding, classifies null and non-null manual items, and preserves each group order',async({page})=>{
    const s=await setup(page),input=structuredClone(s.check.result!.files[0].findings);await expand(page);
    expect(await idsIn(row(page))).toEqual([...input.filter(f=>!isManual(f)),...input.filter(isManual)].map(f=>f.id));
    await expect(row(page).locator('[data-fc-manual-item]')).toHaveCount(4);
    for(const[index,item]of input.filter(isManual).entries()){
      const target=finding(page,item.id);await expect(target.locator('span[data-fc-manual-position]')).toHaveText(`人工事项 ${index+1}/4`);
      for(const text of [item.original,item.source_quote,item.reason,...(item.replacement===null?[]:[item.replacement])])await expect(target).toContainText(text);
      const paragraphs=await target.locator('p').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,whiteSpace:getComputedStyle(node).whiteSpace,maxHeight:getComputedStyle(node).maxHeight,clamp:getComputedStyle(node).webkitLineClamp})));
      for(const text of [item.original,item.source_quote,item.reason])expect(paragraphs.some(p=>p.text?.includes(text)&&p.whiteSpace==='pre-wrap'&&p.maxHeight==='none'&&p.clamp==='none')).toBe(true);
    }
    for(const item of input.filter(f=>!isManual(f)))await expect(finding(page,item.id).locator('[data-fc-manual-position],[data-fc-manual-nav]')).toHaveCount(0);
    expect(writeCalls(s)).toEqual([]);expect(s.check.result!.files[0].findings).toEqual(input);
  });

  test('manual reading: keyboard first/previous/next/file controls reveal exact items, stop at both boundaries and never execute',async({page})=>{
    const s=await setup(page);if(await detail(page).getAttribute('open')!==null){await detail(page).locator('summary').focus();await page.keyboard.press('Enter');}
    const before=await navigationSnapshot(page,s);await keyboard(control(page,'first'),page);await expect(detail(page)).toHaveAttribute('open','');await expect(finding(page,itemIds.first)).toBeFocused();
    await expect(control(page,'previous',itemIds.first)).toBeDisabled();await expect(control(page,'previous',itemIds.first)).toHaveAttribute('data-fc-manual-origin',itemIds.first);
    await keyboard(control(page,'next',itemIds.first),page);await expect(finding(page,itemIds.nullConflict)).toBeFocused();
    await keyboard(control(page,'next',itemIds.nullConflict),page);await expect(finding(page,itemIds.withReplacement)).toBeFocused();
    await keyboard(control(page,'previous',itemIds.withReplacement),page);await expect(finding(page,itemIds.nullConflict)).toBeFocused();
    await keyboard(control(page,'next',itemIds.nullConflict),page);await keyboard(control(page,'next',itemIds.withReplacement),page);await expect(finding(page,itemIds.last)).toBeFocused();
    await expect(control(page,'next',itemIds.last)).toBeDisabled();await expect(control(page,'next',itemIds.last)).toHaveAttribute('data-fc-manual-target','');
    expect((await position(finding(page,itemIds.last))).scrollY).toBeGreaterThan(0);await keyboard(control(page,'file',itemIds.last),page);
    await expect(row(page)).toBeFocused();await expect(row(page)).toHaveAttribute('tabindex','-1');await assertPureNavigation(page,s,before);
  });

  test('manual reading: same finding ID in a second file stays scoped to its complete file identity',async({page})=>{
    const s=await setup(page),before=await navigationSnapshot(page,s);await first(page);
    await control(page,'first',undefined,issuerVersion).click();await expect(finding(page,itemIds.first,issuerVersion)).toBeFocused();
    await expect(finding(page,itemIds.first,issuerVersion)).toContainText('另一文件同名ID');await expect(finding(page,itemIds.first)).not.toBeFocused();
    await control(page,'file',itemIds.first,issuerVersion).click();await expect(row(page,issuerVersion)).toBeFocused();
    await control(page,'first').click();await expect(finding(page,itemIds.first)).toBeFocused();await assertPureNavigation(page,s,before);
  });

  test('manual reading: file manual facet and item reading preserve one selected file and the original 4,500 point explicit confirmation boundary',async({page})=>{
    const s=await setup(page);await row(page).locator('[data-fc-select]').check();await expect(page.locator('#fc-selection')).toContainText('4,500');
    const writes=writeCalls(s).length,calls=s.calls.length;await page.locator('[data-fc-filter="manual"]').click();await expect(rows(page)).toHaveCount(2);
    // Local result filtering keeps the shell wallet mounted; item reading stays local too.
    expect(s.calls.slice(calls),'Local status filtering performs zero HTTP, including wallet reads').toEqual([]);expect(writeCalls(s).length).toBe(writes);await expect(row(page).locator('[data-fc-select]')).toBeChecked();await expect(page.locator('#fc-selection')).toContainText('4,500');
    const before=await navigationSnapshot(page,s);await first(page);await control(page,'next',itemIds.first).click();await control(page,'file',itemIds.nullConflict).click();await assertPureNavigation(page,s,before);
    await page.locator('#fc-accept-top').click();await expect(dialog(page)).toContainText('4,500');await expect(dialog(page).locator('.fc-confirm-filename')).toHaveText([s.check.files[0].filename]);
    expect(s.updatePosts).toEqual([]);await dialog(page).getByRole('button',{name:'返回调整',exact:true}).click();expect(s.updatePosts).toEqual([]);
    await page.locator('#fc-accept-top').click();await dialog(page).locator('#fc-confirm-update').click();await expect.poll(()=>s.updatePosts.length).toBe(1);
    expect(s.updatePosts[0].body.files).toEqual([{file_version_id:ids.version}]);expect(s.updatePosts[0].body.expected_points).toBe(4500);expect(s.updateReceipts.size).toBe(1);
    expect(s.imports).toEqual([]);expect(s.executions).toEqual([]);expect(s.checkRequests).toEqual([]);
  });

  test('manual reading: a manual status with zero supplied findings says details unavailable and never says no differences',async({page})=>{
    const s=await setup(page,{emptyManual:true});await expand(page);await expect(row(page).locator('[data-fc-manual-unavailable]')).toContainText('未提供逐项信息');
    await expect(row(page).locator('[data-fc-manual-mode],[data-fc-manual-position]')).toHaveCount(0);await expect(detail(page)).not.toContainText('本轮已核对的内容未发现不一致');
    await expect(row(page).locator('[data-fc-select]')).toBeDisabled();expect(writeCalls(s)).toEqual([]);
  });

  for(const mode of ['first','previous','next','file'] as const)test(`manual reading: actual ${mode} control keeps focus and real long-page position through native active-task polls`,async({page})=>{
    const s=await setup(page,{active:true});await first(page);const target=mode==='first'?control(page,'first'):control(page,mode,itemIds.nullConflict);
    await target.focus();await target.evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));await frames(page);
    const at=await position(target),token=await target.getAttribute('data-fc-manual-nav'),snapshot=serverSnapshot(s),cache=await cacheValue(page),callsBefore=(await cacheCalls(page)).length;
    expect(at.visible).toBe(true);expect(at.scrollY).toBeGreaterThan(0);await pollReadOnly(page,s,snapshot,cache);await expect(target).toBeFocused();await expect(target).toHaveAttribute('data-fc-manual-nav',token!);
    const after=await position(target);expect(after.visible).toBe(true);expect(Math.abs(after.top-at.top)).toBeLessThanOrEqual(2);
    // Existing poll/syncSelection may call its cache setter. This is explicitly
    // separate from the zero-setter navigation window above.
    expect((await cacheCalls(page)).length).toBeGreaterThanOrEqual(callsBefore);await pollReadOnly(page,s,snapshot,cache);await expect(target).toBeFocused();
  });

  const signatureFields=['target_span_id','original','replacement','source_span_id','source_quote','source_location','target_location','reason','field','period','unit','kind'] as const;
  for(const role of ['origin','target'] as const)for(const field of signatureFields)test(`manual reading: same-ID changed ${role}.${field} invalidates the full finding identity without borrowing its neighbor`,async({page})=>{
    const s=await setup(page,{active:true});await first(page);const button=control(page,'next',itemIds.first);await button.focus();await button.evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));
    const id=role==='origin'?itemIds.first:itemIds.nullConflict,item=s.check.result!.files[0].findings.find(f=>f.id===id)!;
    s.projectionFaults.push(`R39 defensive immutable-result projection: same check hash/ID but changed ${role}.${field}; not normal worker output`);
    if(field==='kind')item.kind=item.kind==='manual'?'conflict':'manual';else if(field==='replacement')item.replacement=item.replacement===null?'合成变化后的建议内容':item.replacement+' 变化';
    else item[field]=(item[field]??'')+'-changed';
    const before=serverSnapshot(s),cache=await cacheValue(page);await pollReadOnly(page,s,before,cache);await inertFocus(page);await expect(finding(page,itemIds.last)).not.toBeFocused();
    await expect(page.locator('#fc-status')).toContainText('变化');expect(s.updatePosts).toEqual([]);
  });

  for(const fault of ['missing-origin','missing-target','duplicate-origin','duplicate-target','changed-adjacency','family','sequence','hash','source'] as const)
    test(`manual reading: defensive ${fault} projection cannot reuse a stale control or another item`,async({page})=>{
      const s=await setup(page,{active:true});await first(page);const button=control(page,'next',itemIds.first);await button.focus();const old=await button.elementHandle();
      const result=s.check.result!.files[0],checked=s.check.files[0];s.projectionFaults.push(`R39 schema-allowed stale/corrupt ${fault} response with original reading context; not a normal producer transition`);
      if(fault==='missing-origin'||fault==='missing-target')result.findings=result.findings.filter(f=>f.id!==(fault==='missing-origin'?itemIds.first:itemIds.nullConflict));
      if(fault==='duplicate-origin'||fault==='duplicate-target')result.findings.push(structuredClone(result.findings.find(f=>f.id===(fault==='duplicate-origin'?itemIds.first:itemIds.nullConflict))!));
      if(fault==='changed-adjacency'){const manual=manualFindings(s),automatic=result.findings.filter(f=>!isManual(f));result.findings=[...automatic,manual[0],manual[2],manual[1],manual[3]];}
      if(fault==='family')checked.file_id='manual-reading-different-family';if(fault==='sequence')checked.sequence=99;
      if(fault==='hash')s.check.sha256=hash('defensive different report');if(fault==='source')s.check.source.selection_revision++;
      const before=serverSnapshot(s),cache=await cacheValue(page);await pollReadOnly(page,s,before,cache);await inertFocus(page);
      expect(await old!.evaluate(node=>node.isConnected)).toBe(false);const focused=await page.evaluate(()=>document.activeElement?.outerHTML),nav=await navigationSnapshot(page,s);
      // Native click on a retained disconnected DOM node exercises the real
      // listener, not a component method or injected component state.
      await old!.evaluate(node=>(node as HTMLButtonElement).click());expect(await page.evaluate(()=>document.activeElement?.outerHTML)).toBe(focused);await assertPureNavigation(page,s,nav);
      expect(s.updatePosts).toEqual([]);expect(s.checkRequests).toEqual([]);
    });

  test('manual reading: duplicate IDs across manual and automatic findings retain every row and disable ambiguous item entry',async({page})=>{
    const s=fixture();s.projectionFaults.push('R39 defensive duplicate ID across manual/automatic classification; invalid immutable producer identity');
    s.check.result!.files[0].findings.find(f=>f.id===itemIds.autoA)!.id=itemIds.first;await pausedClock(page);await enterFromFiles(page,s);await observeCache(page);await expand(page);
    await expect(row(page).locator('[data-fc-finding-id]')).toHaveCount(6);await expect(control(page,'first')).toBeDisabled();await expect(row(page).locator('[data-fc-manual-unavailable]')).toContainText('重复');
    expect(writeCalls(s)).toEqual([]);expect(s.updateReceipts.size).toBe(0);
  });

  test('manual reading: a detached control from another check cannot navigate matching IDs in the current check',async({page})=>{
    const s=fixture({active:true}),older=structuredClone(s.check);older.run_id='manual-reading-older-check';older.sha256=hash(older.run_id);older.updates=[];
    older.result!.files[0].findings.find(f=>f.id===itemIds.first)!.reason='另一检查原事项，不能被旧控制定位。';s.checks.push(older);
    await pausedClock(page);await enterFromFiles(page,s);await observeCache(page);await first(page);const old=await control(page,'next',itemIds.first).elementHandle();
    await page.locator('#fc-history').selectOption(older.run_id);await expect(page.locator('#fc-history')).toHaveValue(older.run_id);const before=await navigationSnapshot(page,s);
    await old!.evaluate(node=>(node as HTMLButtonElement).click());await expect(finding(page,itemIds.nullConflict)).not.toBeFocused();await expect(page.locator('#fc-history')).toBeFocused();
    await expect(finding(page,itemIds.first)).toContainText('另一检查原事项，不能被旧控制定位。');await assertPureNavigation(page,s,before);
  });

  test('manual reading: a real unknown update remains frozen while reading and an open confirmation keeps priority across polling',async({page})=>{
    const s=await setup(page,{dropUpdateOnce:true});await row(page).locator('[data-fc-select]').check();await page.locator('#fc-accept-top').click();await dialog(page).locator('#fc-confirm-update').click();
    await expect(page.locator('#fc-pending-action')).toBeVisible();const post=structuredClone(s.updatePosts[0]);expect(s.updateReceipts.size).toBe(1);
    await dialog(page).getByRole('button',{name:'返回调整',exact:true}).click();const pending=JSON.parse((await cacheValue(page))!).pendingUpdate;
    const before=await navigationSnapshot(page,s);await first(page);await control(page,'next',itemIds.first).click();await control(page,'file',itemIds.nullConflict).click();await assertPureNavigation(page,s,before);
    await row(page).locator('.fc-manual-next a').click();await expect(page).toHaveURL(/#consistency\?/);expect(JSON.parse((await cacheValue(page))!).pendingUpdate).toEqual(pending);
    // Existing accepted batch gives genuine scheduled reads; no synthetic extra
    // charge is created just to make the polling assertion possible.
    s.batches.push({batch_id:'originals-accepted-batch',state:'queued',items:[{file_version_id:ids.version,filename:s.check.files[0].filename,run_id:null,error:null}]});
    const oldPending=await page.locator('#fc-pending-action').elementHandle();
    await page.locator('[data-fc-refresh]').first().click();await expect(page.locator('#fc-status')).toHaveText('已重新读取任务与文件记录。');
    expect(await oldPending!.evaluate(node=>node.isConnected),'Refresh final paint replaced the old pending control').toBe(false);
    await page.locator('#fc-pending-action').click();await expect(dialog(page)).toBeVisible();const confirm=dialog(page).locator('#fc-confirm-update'),handle=await confirm.elementHandle();await confirm.focus();
    const cache=await cacheValue(page),server=serverSnapshot(s);await control(page,'first').evaluate(node=>(node as HTMLButtonElement).click());await expect(confirm).toBeFocused();await tick(page,s);
    expect(await handle!.evaluate(node=>node.isConnected)).toBe(true);await expect(confirm).toBeFocused();
    const background=await control(page,'first').elementHandle();expect(await background!.evaluate(node=>node.isConnected)).toBe(true);await background!.evaluate(node=>(node as HTMLButtonElement).click());await expect(confirm).toBeFocused();
    expect(await cacheValue(page)).toBe(cache);expect(serverSnapshot(s)).toEqual(server);expect(s.updatePosts).toEqual([post]);
    await confirm.click();await expect.poll(()=>s.updatePosts.length).toBe(2);expect(s.updatePosts[1]).toEqual(post);expect(s.updateReceipts.size).toBe(1);
    expect(s.imports).toEqual([]);expect(s.checkRequests).toEqual([]);
  });

  test('manual reading: long-item return preserves exact R30 downloads, file href, revision import and explicit free recheck',async({page})=>{
    const s=await setup(page),checked=structuredClone(s.check),source=s.materials.get('word-source-material')!.bytes;await first(page);
    await control(page,'next',itemIds.first).click();await control(page,'next',itemIds.nullConflict).click();await control(page,'next',itemIds.withReplacement).click();await control(page,'file',itemIds.last).click();await expect(row(page)).toBeFocused();
    expect(await download(page,row(page).locator('[data-fc-original]'))).toEqual(originalBytes);expect(await download(page,page.locator('[data-fc-source-download]'))).toEqual(source);
    expect(s.downloadResponses.filter(r=>r.target==='artifact').map(r=>r.kind)).toEqual(['metadata','run','bytes']);expect(writeCalls(s)).toEqual([]);
    const link=row(page).locator('.fc-manual-next a'),href=await link.getAttribute('href'),q=new URLSearchParams(href!.split('?')[1]);
    expect(href!.split('?')[0]).toBe('#/projects/'+ids.root+'/files');expect(q.get('file')).toBe(ids.family);expect(q.get('version')).toBe(ids.version);expect(q.get('check')).toBe(checkId);
    await link.click();await expect(currentFile(page)).toBeFocused();await expect(currentFile(page)).toHaveAttribute('data-file-version',ids.version);await expect(page.locator('#pw-file-context')).toContainText('检查时原文件');
    await currentFile(page).locator('[data-file-edit-upload]').click();const modal=page.getByRole('dialog',{name:'上传此文件修改稿',exact:true});
    await expect(modal.locator('[name=type]')).toHaveValue('init');await expect(modal.locator('[name=type]')).toBeDisabled();await modal.locator('[name=file]').setInputFiles(editedFile);
    await expect(modal).toHaveCount(0);await expect(page.locator('#pw-import-result')).toContainText('修改稿已保存为 V2');
    expect(s.imports).toHaveLength(1);expect(s.imports[0].expected_latest_version_id).toBe(ids.version);expect(s.imports[0].material.sha256).toBe(hash(editedFile.buffer));expect(s.check).toEqual(checked);expect(s.checkRequests).toEqual([]);
    await page.locator('#pw-import-result').getByRole('link',{name:'检查全部项目文件',exact:true}).click();await expect(page.locator('.fc-results')).toBeVisible();expect(s.checkRequests).toEqual([]);
    await page.locator('[data-fc-start]').click();await expect.poll(()=>s.checkRequests.length).toBe(1);expect(s.checkRequests[0].expected_source_version_id).toBe(s.source.version_id);
    expect(s.checks[0].files.map(f=>f.file_version_id).sort()).toEqual(s.registry.filter(f=>f.latest).map(f=>f.version_id).sort());expect(s.check).toEqual(checked);expect(s.updatePosts).toEqual([]);expect(s.executions).toEqual([]);expect(s.quotes).toEqual([]);
  });
});

for(const side of ['implementation','reference'] as const)test.describe('manual reading comparison '+side,()=>{
const reference=side==='reference';
test('manual reading component comparison: exact R38/current native entry, actual long viewport, item reading and return at 1440',async({page})=>{
  await pausedClock(page);const verify=reference?await installConsistencyManualReadingReference(page):undefined,s=await enterFromFiles(page,fixture());await observeCache(page);
  const output=process.env.BB_CONSISTENCY_MANUAL_EVIDENCE?join(process.env.BB_CONSISTENCY_MANUAL_EVIDENCE,side):test.info().outputPath('component-capture',side);
  const audit=()=>({synthetic:true,scope:'Only sealed R38 FileConsistency versus current component; same current surrounding app and HTTP data',http:s.calls,business_writes:writeCalls(s),projection_faults:s.projectionFaults,errors:s.errors,unexpected:s.unexpected,server:serverSnapshot(s)});
  await row(page).evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));await frames(page);await captureConsistencyManualReading(page,output!,side+'-file-entry-1440',audit());
  await page.locator('[data-fc-filter="manual"]').click();await expand(page);await frames(page);
  if(reference){await finding(page,itemIds.first).focus();await finding(page,itemIds.first).evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));}
  else{const before=await navigationSnapshot(page,s);await first(page);await assertPureNavigation(page,s,before);}
  await frames(page);const reading=await captureConsistencyManualReading(page,output!,side+'-long-manual-reading-1440',audit());expect(reading.scrollY).toBeGreaterThan(0);
  if(reference){await finding(page,itemIds.last).focus();await finding(page,itemIds.last).evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));}
  else{await control(page,'next',itemIds.first).click();await control(page,'next',itemIds.nullConflict).click();await control(page,'next',itemIds.withReplacement).click();await expect(finding(page,itemIds.last)).toBeFocused();}
  await frames(page);const last=await captureConsistencyManualReading(page,output!,side+'-last-manual-reading-1440',audit());expect(last.scrollY).toBeGreaterThan(reading.scrollY);
  if(reference){await row(page).focus();await row(page).evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));}
  else{await control(page,'file',itemIds.last).click();await expect(row(page)).toBeFocused();}
  await frames(page);await captureConsistencyManualReading(page,output!,side+'-returned-file-operations-1440',audit());expect(writeCalls(s)).toEqual([]);expect(s.updateReceipts.size).toBe(0);assertFixture(s);
  if(verify){await mkdir(output!,{recursive:true});await writeFile(join(output!,'reference-provenance-1440.json'),JSON.stringify(await verify(),null,2)+'\n');}
});
});
