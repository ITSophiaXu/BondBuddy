import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Locator,type Page} from '@playwright/test';
import {assertFixture,base,cacheKey,checkId,downloadBytes,editedFile,filesRoute,fixture,hash,ids,issuerVersion,
  open,originalBytes,replaceMaterial,replaceSource,writeCalls,type ContextFault,type DownloadFault,type DownloadTarget,type State} from './consistency-originals-fixtures';
import {captureConsistencyOriginals,installConsistencyOriginalsReference} from './consistency-originals-reference';

const reference=process.env.BB_CONSISTENCY_ORIGINALS_REFERENCE==='1';
const row=(page:Page,version=ids.version)=>page.locator(`[data-fc-result-version="${version}"]`);
const file=(page:Page,family=ids.family)=>page.locator(`.collection-file[data-file-family="${family}"]`);
const original=(page:Page,version=ids.version)=>page.locator(`[data-fc-original="${version}"]`);
const originalStatus=(page:Page,version=ids.version)=>page.locator(`[data-fc-original-status="file:${checkId}:${version}"]`);
const manualReturn=(page:Page)=>row(page).locator('.fc-manual-next a');
const importDialog=(page:Page)=>page.getByRole('dialog',{name:'上传此文件修改稿',exact:true});
async function saveDownload(page:Page,button:Locator){const pending=page.waitForEvent('download');await button.click();return downloadBytes(await pending);}
async function noWrites(s:State){expect(writeCalls(s)).toEqual([]);expect(s.imports).toEqual([]);expect(s.executions).toEqual([]);expect(s.quotes).toEqual([]);assertFixture(s);}
async function exactReturn(page:Page){
  const href=await manualReturn(page).getAttribute('href'),query=new URLSearchParams(href!.split('?')[1]);
  expect(href!.split('?')[0]).toBe('#/projects/'+ids.root+'/files');expect(query.get('file')).toBe(ids.family);expect(query.get('version')).toBe(ids.version);expect(query.get('check')).toBe(checkId);return href!;
}
async function returnCheck(page:Page){
  const link=page.locator('#pw-file-context').getByRole('link');await expect(link).toHaveCount(1);
  const href=await link.getAttribute('href'),query=new URLSearchParams(href!.split('?')[1]);expect(query.get('project')).toBe(ids.root);expect(query.get('run')).toBe(checkId);
  expect([ids.family,ids.version]).toContain(query.get('file'));return link;
}

test.describe('consistency originals desktop journeys',()=>{
  test.skip(reference,'The exact R29 run records actual missing original-download/context entry points.');

  test('consistency originals: manual finding downloads exact original and source, returns to its family, saves a revision and starts a new check only explicitly',async({page})=>{
    const s=await open(page),checked=structuredClone(s.check),sourceBytes=s.materials.get('word-source-material')!.bytes;
    await expect(row(page).locator('.fc-manual-next')).toContainText('需人工确认的事项继续保留');await exactReturn(page);
    expect(await saveDownload(page,original(page))).toEqual(originalBytes);
    await expect(originalStatus(page)).toHaveText('检查时原稿已交给浏览器下载。');
    expect(await saveDownload(page,page.locator('[data-fc-source-download]'))).toEqual(sourceBytes);
    expect(s.calls.filter(c=>c.path===base+'/materials/word-source-material').map(c=>c.search)).toEqual(['?version=1']);
    expect(s.downloadResponses.filter(v=>v.target==='artifact').map(v=>v.kind)).toEqual(['metadata','run','bytes']);await noWrites(s);
    await manualReturn(page).click();await expect(page.locator('#pw-file-context')).toBeVisible();await expect(file(page)).toBeFocused();
    await expect(file(page)).toHaveAttribute('data-file-version',ids.version);await expect(page.locator('dialog[open]')).toHaveCount(0);await returnCheck(page);
    await file(page).locator('[data-file-edit-upload]').click();const dialog=importDialog(page);await expect(dialog).toBeVisible();
    await expect(dialog.locator('[name=type]')).toHaveValue('init');await expect(dialog.locator('[name=type]')).toBeDisabled();await expect(dialog.locator('#pw-import-target')).toContainText('V1');
    await dialog.locator('[name=file]').setInputFiles(editedFile);expect(s.checkRequests).toEqual([]);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#pw-import-result')).toContainText('修改稿已保存为 V2，原 V1 保留。');
    const saved=s.registry.find(v=>v.file_id===ids.family&&v.latest)!;expect(saved.sequence).toBe(2);expect(saved.consistency.status).toBe('unchecked');
    expect(s.imports).toHaveLength(1);expect(s.imports[0].expected_latest_version_id).toBe(ids.version);expect(s.imports[0].document_type).toBe('init');expect(s.imports[0].material.sha256).toBe(hash(editedFile.buffer));
    expect(saved.asset).toEqual({kind:'material',pin:s.imports[0].material});expect(s.puts).toBe(1);expect(s.sessions.size).toBe(1);expect(s.checkRequests).toEqual([]);expect(s.check).toEqual(checked);
    await page.locator('#pw-import-result').getByRole('link',{name:'检查全部项目文件',exact:true}).click();
    await expect(page.locator('.fc-results')).toBeVisible();expect(s.checkRequests).toEqual([]);
    await page.locator('[data-fc-start]').click();await expect.poll(()=>s.checkRequests.length).toBe(1);
    expect(s.checkRequests[0].expected_source_version_id).toBe(s.source.version_id);expect(s.checks[0].files.map(f=>f.file_version_id).sort()).toEqual(s.registry.filter(v=>v.latest).map(v=>v.version_id).sort());
    expect(s.checks[0].files).toHaveLength(2);expect(s.checks[0].files.some(f=>f.file_version_id===saved.version_id)).toBe(true);expect(s.check).toEqual(checked);
    expect(s.updatePosts).toEqual([]);expect(s.executions).toEqual([]);expect(s.quotes).toEqual([]);assertFixture(s);
  });

  test('consistency originals: historical artifact/material/source pins never download their later current versions',async({page})=>{
    const s=fixture({historical:true}),material=replaceMaterial(s),source=replaceSource(s);await open(page,s);
    await expect(row(page).locator('.fc-file-freshness')).toContainText('本轮检查针对原 V1');
    expect(await saveDownload(page,original(page))).toEqual(originalBytes);
    expect(await saveDownload(page,original(page,issuerVersion))).toEqual(material.old);
    expect(await saveDownload(page,page.locator('[data-fc-source-download]'))).toEqual(source.old);
    expect(material.old).not.toEqual(material.current);expect(source.old).not.toEqual(source.current);
    expect(s.calls.filter(c=>c.path===base+'/materials/word-issuer-material').map(c=>c.search)).toEqual(['?version=1']);
    expect(s.calls.filter(c=>c.path===base+'/materials/word-source-material').map(c=>c.search)).toEqual(['?version=1']);
    expect(s.downloadResponses.filter(v=>v.kind==='bytes'&&v.target!=='artifact').map(v=>v.version)).toEqual([1,1]);
    await exactReturn(page);await manualReturn(page).click();await expect(file(page)).toBeFocused();
    const current=s.registry.find(v=>v.file_id===ids.family&&v.latest)!;
    await expect(file(page)).toHaveAttribute('data-file-version',current.version_id);await expect(page.locator('#pw-file-context')).toContainText('V1');await expect(page.locator('#pw-file-context')).toContainText('V2');
    await expect(page.locator('dialog[open]')).toHaveCount(0);const back=await returnCheck(page);await back.click();
    await expect(row(page).locator('details')).toHaveAttribute('open');expect(await saveDownload(page,original(page))).toEqual(originalBytes);await noWrites(s);
  });

  test('consistency originals: artifact metadata/run/bytes mismatches deny downloads and explicit retry uses the same pinned original',async({context})=>{
    for(const fault of ['id','version','hash','missing','run-id','run-response-id','run-project','run-state','bytes'] as DownloadFault[]){
      const page=await context.newPage(),s=fixture();s.faults.artifact=fault;await open(page,s);const downloads:string[]=[];page.on('download',d=>downloads.push(d.suggestedFilename()));
      await original(page).click();await expect(originalStatus(page)).not.toHaveText('');await expect(original(page)).toBeEnabled();expect(downloads).toEqual([]);
      expect(s.downloadResponses.filter(v=>v.target==='artifact'&&v.kind==='bytes')).toHaveLength(fault==='bytes'?1:0);await noWrites(s);
      delete s.faults.artifact;expect(await saveDownload(page,original(page))).toEqual(originalBytes);await expect(originalStatus(page)).toHaveText('检查时原稿已交给浏览器下载。');
      expect(downloads).toHaveLength(1);await noWrites(s);await page.close();
    }
  });

  test('consistency originals: an artifact-backed historical source verifies its own successful project without inventing a file run pin',async({page})=>{
    const s=fixture(),asset=s.registry.find(v=>v.version_id===ids.version)!.asset;
    if(asset.kind!=='artifact')throw new Error('Expected original artifact');
    s.check.source={...s.check.source,project_id:asset.pin.source_project_id,filename:s.artifact.filename,asset:structuredClone(asset)};s.check.stale=true;
    await open(page,s);expect(await saveDownload(page,page.locator('[data-fc-source-download]'))).toEqual(originalBytes);
    expect(s.downloadResponses.map(v=>v.kind)).toEqual(['metadata','run','bytes']);await noWrites(s);
    // Schema-valid but mismatched project/pin is an explicit defensive projection.
    s.check.source.project_id=ids.otherRoot;await page.reload();await expect(page.locator('.fc-results')).toBeVisible();
    const reads=s.downloadResponses.length,downloads:string[]=[];page.on('download',d=>downloads.push(d.suggestedFilename()));await page.locator('[data-fc-source-download]').click();
    await expect(page.locator(`[data-fc-original-status="source:${checkId}"]`)).toContainText('暂不可核对');expect(downloads).toEqual([]);expect(s.downloadResponses).toHaveLength(reads);await noWrites(s);
  });

  test('consistency originals: material and source id/version/hash/bytes faults deny saving until the exact pin is readable again',async({context})=>{
    for(const target of ['material','source'] as DownloadTarget[])for(const fault of ['id','version','hash','missing','bytes'] as DownloadFault[]){
      const page=await context.newPage(),s=fixture();replaceMaterial(s);s.faults[target]=fault;await open(page,s);
      const version=issuerVersion,button=target==='source'?page.locator('[data-fc-source-download]'):original(page,version),status=target==='source'?page.locator(`[data-fc-original-status="source:${checkId}"]`):originalStatus(page,version);
      const downloads:string[]=[];page.on('download',d=>downloads.push(d.suggestedFilename()));await button.click();await expect(status).not.toHaveText('');await expect(button).toBeEnabled();expect(downloads).toEqual([]);
      expect(s.downloadResponses.filter(v=>v.target===target&&v.kind==='bytes')).toHaveLength(fault==='bytes'?1:0);
      delete s.faults[target];const expected=s.pinnedMaterials.get(ids.root+':'+(target==='source'?'word-source-material':'word-issuer-material')+':1')!.bytes;
      expect(await saveDownload(page,button)).toEqual(expected);expect(downloads).toHaveLength(1);await noWrites(s);await page.close();
    }
  });

  test('consistency originals: invalid or unreadable exact targets never guess another check, family or collection mapping',async({context})=>{
    const faults:ContextFault[]=['unreadable','duplicate-check','duplicate-file','wrong-family','wrong-sequence','missing-version','registry-unreadable','collection-mismatch','duplicate-collection'];
    for(const contextFault of faults){
      const page=await context.newPage(),s=await open(page,fixture({historical:true,contextFault}),'files');await expect(page.locator('#pw-file-context')).toBeVisible();
      await expect(page.locator('#pw-file-context [role=status]')).toContainText('暂时无法核实原检查与这份文件的对应关系');
      await expect(page.locator('#pw-file-context').getByRole('link')).toHaveCount(0);await expect(page.locator('#pw-file-context [data-file-context-locate]:not(:disabled)')).toHaveCount(0);
      expect(await page.evaluate(()=>document.activeElement?.closest('[data-file-family]')?.getAttribute('data-file-family')??null)).toBeNull();await expect(page.locator('[data-file-context-target="true"]')).toHaveCount(0);
      await expect(page.locator('dialog[open]')).toHaveCount(0);await noWrites(s);await page.close();
    }
    for(const extra of ['&file=different-family','&version=different-version','&check=different-check']){
      const page=await context.newPage(),s=await open(page,fixture(),'files',extra);await expect(page.locator('#pw-file-context')).toBeVisible();
      await expect(page.locator('#pw-file-context [role=status]')).toContainText('原检查的文件定位信息不完整或无效');
      await expect(page.locator('#pw-file-context').getByRole('link')).toHaveCount(0);await expect(page.locator('#pw-file-context [data-file-context-locate]:not(:disabled)')).toHaveCount(0);
      expect(await page.evaluate(()=>document.activeElement?.closest('[data-file-family]')?.getAttribute('data-file-family')??null)).toBeNull();await expect(page.locator('[data-file-context-target="true"]')).toHaveCount(0);
      await expect(page.locator('dialog[open]')).toHaveCount(0);await noWrites(s);await page.close();
    }
  });

  test('consistency originals: manual filters and refresh preserve intent until explicit locate reveals the verified current family again',async({page})=>{
    const s=await open(page,fixture({historical:true}),'files','&folder=4.1');await expect(file(page)).toBeFocused();
    await page.locator('#file-search').fill('没有匹配的合成文件');await expect(page.locator('#file-search')).toBeFocused();await expect(file(page)).toHaveCount(0);
    await page.locator('#refresh-files').click();await expect(page.locator('#refresh-files')).toBeEnabled();await expect(page.locator('#file-search')).toHaveValue('没有匹配的合成文件');await expect(file(page)).toHaveCount(0);
    await expect(page.locator('#pw-file-context')).toBeVisible();await page.locator('[data-file-context-locate]').click();await expect(file(page)).toBeFocused();await expect(file(page)).toBeVisible();
    await expect(page.locator('#file-search')).toHaveValue('');await page.locator('[data-file-type="issuer"]').click();await expect(file(page)).toHaveCount(0);
    await page.locator('#refresh-files').click();await expect(page.locator('#refresh-files')).toBeEnabled();await expect(file(page)).toHaveCount(0);
    await page.locator('[data-file-context-locate]').click();await expect(file(page)).toBeFocused();await returnCheck(page);await noWrites(s);
  });

  test('consistency originals: a late independent check read keeps the usable file search and focus until explicit locate',async({page})=>{
    const s=fixture({historical:true});let release!:()=>void;s.checkReadGate=new Promise<void>(resolve=>{release=resolve;});
    try{
      await open(page,s,'files');await expect(file(page)).toBeVisible();expect(s.checkReads).toBe(1);
      await expect(page.locator('#pw-prospectus')).toContainText(s.source.filename);await expect(page.locator('[data-file-context-locate]')).toHaveCount(0);
      const search=page.locator('#file-search');await search.fill('检查迟到时保留这次搜索');await expect(search).toBeFocused();await expect(file(page)).toHaveCount(0);
      // Observe actual explicit context/row scroll calls while forwarding them;
      // browser scroll anchoring after the context grows is not a locator action.
      await page.evaluate(()=>{
        const original=Element.prototype.scrollIntoView,record:string[]=[];
        (window as unknown as {originalsLateScrolls:string[]}).originalsLateScrolls=record;
        Element.prototype.scrollIntoView=function(options?:boolean|ScrollIntoViewOptions){if(this.id==='pw-file-context'||(this as HTMLElement).dataset.fileFamily)record.push(this.id||'file-family');return original.call(this,options);};
      });
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+base+'/project-files/checks'&&r.request().method()==='GET');
      release();await response;await expect(page.locator('[data-file-context-locate]')).toBeVisible();
      expect(s.checkReads).toBe(1);expect(s.calls.filter(c=>c.method==='GET'&&c.path===base+'/project-files/checks')).toHaveLength(1);
      await expect(search).toHaveValue('检查迟到时保留这次搜索');await expect(search).toBeFocused();await expect(file(page)).toHaveCount(0);
      expect(await page.evaluate(()=>(window as unknown as {originalsLateScrolls:string[]}).originalsLateScrolls)).toEqual([]);
      await page.locator('[data-file-context-locate]').click();await expect(file(page)).toBeFocused();await expect(file(page)).toBeVisible();await expect(search).toHaveValue('');
      await expect(page.locator('[data-file-type="init"]')).toHaveAttribute('aria-current','page');await returnCheck(page);await noWrites(s);
    }finally{release();s.checkReadGate=undefined;}
  });

  test('consistency originals: unknown update receipt survives download, blocked navigation and local selection changes without changing its envelope',async({page})=>{
    const s=await open(page,fixture({dropUpdateOnce:true}));await page.locator(`[data-fc-select="${ids.version}"]`).check();await page.locator('#fc-accept-top').click();
    await page.locator('dialog[open] #fc-confirm-update').click();await expect(page.locator('#fc-pending-action')).toBeVisible();
    const originalPost=structuredClone(s.updatePosts[0]);expect(s.updateReceipts.size).toBe(1);await page.locator('dialog[open]').getByRole('button',{name:'返回调整',exact:true}).click();
    const pending=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)!).pendingUpdate,cacheKey);
    expect(await saveDownload(page,original(page))).toEqual(originalBytes);await manualReturn(page).click();await expect(page.locator('.fc-results')).toBeVisible();await expect(page).toHaveURL(/#consistency\?/);
    await page.locator('[data-fc-clear-selection]').click();expect(s.updatePosts).toEqual([originalPost]);expect(s.updateReceipts.size).toBe(1);
    const after=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)!).pendingUpdate,cacheKey);expect(after).toEqual(pending);expect(after.body).toEqual(originalPost.body);
    await page.locator('#fc-pending-action').click();await expect(page.locator('dialog[open] .fc-confirm-filename')).toHaveText([s.check.files[0].filename]);
    await page.locator('dialog[open] #fc-confirm-update').click();await expect.poll(()=>s.updatePosts.length).toBe(2);expect(s.updatePosts[1]).toEqual(originalPost);expect(s.updateReceipts.size).toBe(1);
    expect(s.imports).toEqual([]);expect(s.checkRequests).toEqual([]);assertFixture(s);
  });

  test('consistency originals: unknown free-check receipt remains the exact original request through read-only downloads and a prevented return',async({page})=>{
    const s=await open(page,fixture({dropCheckOnce:true}));await page.locator('[data-fc-start]').click();await expect.poll(()=>s.checkRequests.length).toBe(1);
    await expect(page.locator('[data-fc-start]')).toContainText('重试确认');const request=structuredClone(s.checkRequests[0]);
    const cached=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)!).checkRequest,cacheKey);expect(cached).toEqual(request);
    expect(await saveDownload(page,original(page,issuerVersion))).toEqual(s.materials.get('word-issuer-material')!.bytes);await manualReturn(page).click();await expect(page).toHaveURL(/#consistency\?/);
    expect(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)!).checkRequest,cacheKey)).toEqual(request);expect(s.checkRequests).toEqual([request]);
    await page.locator('[data-fc-start]').click();await expect.poll(()=>s.checkRequests.length).toBe(2);expect(s.checkRequests[1]).toEqual(request);expect(s.checkReceipts.size).toBe(1);
    expect(s.updatePosts).toEqual([]);expect(s.imports).toEqual([]);assertFixture(s);
  });
});

test('consistency originals component comparison: exact R29 and current share manual findings and historical target intent at 1440',async({page})=>{
  const verify=reference?await installConsistencyOriginalsReference(page):undefined,s=await open(page,fixture({historical:true}));
  const directory=process.env.BB_CONSISTENCY_ORIGINALS_EVIDENCE_DIR??test.info().outputPath(reference?'reference':'current');
  const audit=(action:string)=>({reference,synthetic:true,action,check:checkId,checked_version:ids.version,checked_family:ids.family,current_version:s.registry.find(v=>v.file_id===ids.family&&v.latest)!.version_id,writes:writeCalls(s)});
  await page.locator('.pf-source-strip').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  if(reference)await expect(page.locator('[data-fc-source-download]')).toHaveCount(0);else await expect(page.locator('[data-fc-source-download]')).toBeInViewport({ratio:1});
  const source=await captureConsistencyOriginals(page,directory,'consistency-originals-source-1440',audit('Same fixed historical check source with source strip aligned to viewport start; R29 has no source download entry point.'));
  expect(source.sourceButtons).toBe(reference?0:1);
  await row(page).evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  const manual=await captureConsistencyOriginals(page,directory,'consistency-originals-manual-1440',audit('Same historical manual finding and original version; the R29 reference has no original/source download entry points.'));
  expect(manual.originalButtons).toHaveLength(reference?0:2);expect(manual.sourceButtons).toBe(reference?0:1);
  if(reference){const href=await manualReturn(page).getAttribute('href');expect(href).toBe('#/projects/'+ids.root+'/files');}else await exactReturn(page);
  // Both receive exactly the same deep link. R29 naturally ignores its target,
  // preserving the real absence of verified context instead of simulating it.
  await page.goto(filesRoute());await expect(page.locator('#file-list')).toBeVisible();
  if(!reference){await expect(file(page)).toBeFocused();await returnCheck(page);}
  await page.locator('.pw-files-head').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  const returned=await captureConsistencyOriginals(page,directory,'consistency-originals-return-1440',audit('Both components received the same family/version/check URL; only current verifies original and current versions and locates the current family.'));
  if(reference){expect(returned.context).toBeNull();expect(returned.families).toHaveLength(0);}else{expect(returned.context).toContain('V1');expect(returned.context).toContain('V2');expect(returned.families.some(v=>v.family===ids.family)).toBe(true);}
  expect(returned.dialogs).toBe(0);await noWrites(s);
  if(verify){await mkdir(directory,{recursive:true});await writeFile(join(directory,'consistency-originals-reference-1440.json'),JSON.stringify(await verify(),null,2));}
});
