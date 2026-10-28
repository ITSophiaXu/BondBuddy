import {expect,test,type Locator,type Page} from '@playwright/test';
import {assertFixture,checkingRun,collection,deliveredManual,editedFile,familyKey,fileKey,filesHash,filesRoute,fixture,gate,hash,ids,latest,navigate,
  noBusiness,noExecution,open,ready,status,uploadJournal,type State} from './project-file-status-fixtures';
import {downloadBytes,originalBytes} from './word-roundtrip-fixtures';

type Group='all'|'check'|'review'|'checking'|'consistent'|'unsynced'|'other';
const group=(page:Page,value:Group)=>page.locator('#pw-file-status [data-file-status="'+value+'"]');
const rows=(page:Page)=>page.locator('#file-list>.collection-file[data-file-key]');
const row=(page:Page,key=fileKey)=>page.locator('#file-list>.collection-file[data-file-key="'+key+'"]');
const note=(page:Page)=>page.locator('#pw-file-status-note');
const params=(page:Page)=>page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
async function choose(page:Page,value:Group){await group(page,value).click();await expect(group(page,value)).toHaveAttribute('aria-pressed','true');}
async function count(page:Page,value:Group,expected:number|string){await expect(group(page,value).locator('[data-file-status-count]')).toHaveText(String(expected));}
async function visibleKeys(page:Page,expected:string[]){await expect.poll(()=>rows(page).evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.fileKey!).sort())).toEqual([...expected].sort());}
async function refresh(page:Page){await page.locator('#refresh-files').click();await expect(page.locator('#refresh-files')).toBeEnabled();}
async function returnFiles(page:Page){await page.getByRole('link',{name:'返回本项目文件',exact:true}).click();await expect(page.locator('#file-list')).toBeVisible();await ready(page);}
async function enterTask(page:Page,s:State){
  const link=row(page).getByRole('link',{name:'打开此稿继续修改',exact:true}),href=await link.getAttribute('href'),q=new URLSearchParams(href!.split('?')[1]);
  expect(q.get('topic')).toBe(ids.topic);expect(q.get('run')).toBe(ids.originalRun);expect(q.get('return_project')).toBe(ids.root);
  await link.click();await expect(page.locator('.m4-delivery')).toContainText('立项报告原稿_V1.docx');expect(s.quotes).toEqual([]);expect(s.executions).toEqual([]);
}
async function focusReading(target:Locator){await target.focus();await target.evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));return (await target.boundingBox())!.y;}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}

test.describe('project file status: desktop next-step journeys',()=>{
  test.use({viewport:{width:1440,height:960}});

  test('seven server states form useful current-file groups without counting history or treating generated/manual drafts as checked',async({page})=>{
    const s=fixture();deliveredManual(s);await open(page,s);
    for(const [key,value] of [['all',21],['check',4],['review',4],['checking',1],['consistent',3],['unsynced',0],['other',9]] as const)await count(page,key,value);
    await expect(rows(page)).toHaveCount(21);await expect(row(page,'project-file:'+latest(s,'financial').file_id)).toContainText('V2');
    await expect(page.locator('#file-list')).not.toContainText('历史财务人工事项_V1.docx');
    await choose(page,'review');await visibleKeys(page,[fileKey,familyKey(s,'issuer'),familyKey(s,'application'),familyKey(s,'recommendation')]);
    await expect(row(page)).toContainText('发现差异');await expect(row(page,familyKey(s,'issuer'))).toContainText('需人工确认');
    await expect(row(page,familyKey(s,'issuer')).getByRole('button',{name:'下载修订版',exact:true})).toBeVisible();
    await choose(page,'check');await visibleKeys(page,[familyKey(s,'financial'),familyKey(s,'credit'),familyKey(s,'proceeds'),familyKey(s,'annual')]);
    await expect(row(page,familyKey(s,'proceeds'))).toContainText('已生成新版本');
    await choose(page,'consistent');await visibleKeys(page,[familyKey(s,'legal'),familyKey(s,'private_summary'),familyKey(s,'semiannual')]);
    await expect(row(page,familyKey(s,'issuer'))).toHaveCount(0);await expect(row(page,familyKey(s,'proceeds'))).toHaveCount(0);
    await choose(page,'checking');await visibleKeys(page,[familyKey(s,'underwriter')]);await expect(rows(page)).toContainText('正在检查');
    await expect(rows(page).getByRole('link',{name:'查看检查进度',exact:true})).toHaveAttribute('href',new RegExp('run='+checkingRun));
    await choose(page,'other');await expect(rows(page)).toHaveCount(9);expect(await rows(page).evaluateAll(nodes=>nodes.every(n=>!n.getAttribute('data-file-key')!.startsWith('project-file:')))).toBe(true);
    await noOverflow(page);noBusiness(s);
  });

  test('mixed findings use the combined review group and exact original run; absent old checks never borrow a newer result',async({page})=>{
    const s=await open(page);await choose(page,'review');const first=row(page).locator('a[href^="#consistency?"]');
    await expect(first).toHaveCount(1);const q=new URLSearchParams((await first.getAttribute('href'))!.split('?')[1]);
    expect(q.get('run')).toBe(s.check.run_id);expect(q.get('file')).toBe(ids.family);await first.click();
    await expect(page.locator('[data-fc-result-version="'+ids.version+'"]')).toContainText('审批口径尚待人工核实');
    await expect(page.locator('[data-fc-detail="'+ids.version+'"]')).toHaveAttribute('open');await returnFiles(page);await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');
    status(s,'init','conflict','status-check-older-than-public-window');status(s,'issuer','manual',null);await refresh(page);
    await expect(row(page,familyKey(s,'issuer')).locator('a[href^="#consistency?"]')).toHaveCount(0);
    const old=row(page).locator('a[href^="#consistency?"]');await expect(old).toHaveAttribute('href',/run=status-check-older-than-public-window/);await old.click();
    await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toBeVisible();await expect(page.locator('.fc-results')).toHaveCount(0);
    expect(new URLSearchParams((await page.evaluate(()=>location.hash)).split('?')[1]).get('run')).toBe('status-check-older-than-public-window');noBusiness(s);
  });

  test('folder, document type, name and status intersect while native Chinese composition keeps the previous list until commit',async({page})=>{
    const s=await open(page);await page.locator('[data-folder="4.1"]').click();await count(page,'all',4);await count(page,'check',3);await count(page,'review',1);
    await choose(page,'review');await visibleKeys(page,[familyKey(s,'issuer')]);const search=page.locator('#file-search'),before=await params(page);await search.focus();
    await search.evaluate((node:HTMLInputElement)=>{node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'cai'}));node.value='财务';node.dispatchEvent(new InputEvent('input',{bubbles:true,data:'财务',inputType:'insertCompositionText',isComposing:true}));});
    await visibleKeys(page,[familyKey(s,'issuer')]);expect(await params(page)).toEqual(before);await count(page,'all',4);
    await search.evaluate((node:HTMLInputElement)=>{node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'财务'}));node.dispatchEvent(new InputEvent('input',{bubbles:true,data:'财务',inputType:'insertText',isComposing:false}));});
    await expect(search).toBeFocused();await expect(rows(page)).toHaveCount(0);await count(page,'all',1);await count(page,'check',1);await count(page,'review',0);
    await choose(page,'check');await visibleKeys(page,[familyKey(s,'financial')]);await page.locator('[data-file-type="financial"]').click();
    const q=await params(page);expect(q).toMatchObject({folder:'4.1',type:'financial',q:'财务',file_status:'check'});await visibleKeys(page,[familyKey(s,'financial')]);
    const checkLink=note(page).getByRole('link',{name:'免费检查全部当前关联文件',exact:true});await expect(note(page)).toContainText('当前筛选只影响显示');
    const checkParams=new URLSearchParams((await checkLink.getAttribute('href'))!.split('?')[1]);expect(checkParams.get('project')).toBe(ids.root);
    for(const field of ['file','version','type','q','file_status'])expect(checkParams.has(field)).toBe(false);noBusiness(s);
  });

  test('empty status results can clear only that condition and absent document preparation appears only under all',async({page})=>{
    const s=fixture();s.registry=s.registry.filter(v=>v.document_type!=='recommendation');await open(page,s);
    await page.locator('[data-file-type="recommendation"]').click();await page.locator('#file-search').fill('推荐');await choose(page,'review');
    await expect(rows(page)).toHaveCount(0);await expect(page.locator('.pw-prepare')).toHaveCount(0);await expect(page.locator('[data-clear-file-status]')).toBeVisible();
    await page.locator('[data-clear-file-status]').click();await expect(group(page,'all')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('#file-search')).toHaveValue('推荐');await expect(page.locator('[data-file-type="recommendation"]')).toHaveAttribute('aria-current','page');
    expect(await params(page)).toMatchObject({folder:'2.2',type:'recommendation',q:'推荐'});expect((await params(page)).file_status).toBeUndefined();
    await count(page,'all',0);await expect(rows(page)).toHaveCount(0);await expect(page.locator('.pw-prepare')).toHaveCount(1);await page.locator('.pw-prepare>summary').click();
    await expect(page.locator('[data-import-type="recommendation"]')).toBeVisible();noBusiness(s);
  });

  test('status is canonical in reload URLs and malformed or duplicate state rejects the complete remembered filter set',async({page})=>{
    const s=await open(page);await page.locator('[data-file-type="financial"]').click();await page.locator('#file-search').fill('财务');await choose(page,'check');
    const original=await params(page);expect(original).toMatchObject({folder:'4.1',type:'financial',q:'财务',file_status:'check'});await page.reload();await ready(page);
    await expect(group(page,'check')).toHaveAttribute('aria-pressed','true');expect(await params(page)).toEqual(original);await visibleKeys(page,[familyKey(s,'financial')]);
    for(const suffix of ['folder=4.1&type=financial&q='+encodeURIComponent('财务')+'&file_status=wrong','folder=4.1&type=financial&q='+encodeURIComponent('财务')+'&file_status=check&file_status=review','folder=4.1&type=financial&type=issuer&file_status=check']){
      await navigate(page,'#tasks');await expect(page.locator('#project-list')).toBeVisible();await navigate(page,filesHash+'?'+suffix);await ready(page);
      await expect(group(page,'all')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#file-search')).toHaveValue('');await expect(page.locator('[data-file-type][aria-current="page"]')).toHaveCount(0);
      const rejected=await params(page);for(const key of ['folder','type','q','file_status'])expect(rejected[key]).toBeUndefined();await expect(rows(page)).toHaveCount(21);
    }
    noBusiness(s);
  });

  test('real task return and browser Back retain status reading while explicit new status replaces remembered conditions',async({page})=>{
    const s=await open(page);await page.locator('[data-file-type="init"]').click();await page.locator('#file-search').fill('立项');await choose(page,'review');
    const y=await focusReading(row(page));await enterTask(page,s);const reads=s.readFiles;await returnFiles(page);
    await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#file-search')).toHaveValue('立项');await expect(row(page)).toBeFocused();
    expect(s.readFiles).toBeGreaterThan(reads);expect(Math.abs((await row(page).boundingBox())!.y-y)).toBeLessThanOrEqual(8);
    await enterTask(page,s);await page.locator('.m4-delivery').evaluate(e=>e.scrollIntoView({block:'end',behavior:'instant'}));await page.goBack();await ready(page);
    await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await expect(row(page)).toBeFocused();expect((await params(page)).file_status).toBe('review');
    await enterTask(page,s);await navigate(page,filesHash+'?file_status=consistent');await ready(page);
    await expect(group(page,'consistent')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#file-search')).toHaveValue('');await expect(page.locator('[data-file-type][aria-current="page"]')).toHaveCount(0);
    await visibleKeys(page,[familyKey(s,'legal'),familyKey(s,'private_summary'),familyKey(s,'semiannual')]);await expect(row(page)).toHaveCount(0);noBusiness(s);
  });

  test('manual and registered thirty-second refreshes move files between groups without restoring hidden actions or changing the selected condition',async({page})=>{
    await page.clock.install();const s=await open(page);await choose(page,'review');await focusReading(row(page));status(s,'init','consistent');
    await refresh(page);await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await expect(row(page)).toHaveCount(0);await expect(page.locator('#refresh-files')).toBeFocused();
    await count(page,'review',3);await count(page,'consistent',4);status(s,'issuer','stale');const reads=s.statusRegistryReads;
    const issuer=row(page,familyKey(s,'issuer'));await focusReading(issuer);await page.clock.fastForward(30_001);
    await expect.poll(()=>s.statusRegistryReads).toBeGreaterThan(reads);await expect(page.locator('#refresh-files')).toBeEnabled();await expect(issuer).toHaveCount(0);
    await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await count(page,'review',2);await count(page,'check',5);
    expect(await page.evaluate(()=>document.activeElement?.closest('[data-file-key]')?.getAttribute('data-file-key')??null)).toBeNull();noBusiness(s);
  });

  test('an old gated refresh respects a later native status/name choice and does not steal its focus',async({page})=>{
    const s=await open(page);await choose(page,'review');await focusReading(row(page));const held=gate();s.filesGate=held.promise;
    try{
      const reads=s.readFiles;await page.locator('#refresh-files').click();await expect.poll(()=>s.readFiles).toBeGreaterThan(reads);
      await choose(page,'consistent');const search=page.locator('#file-search');await search.fill('法律');const selected=await params(page);
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/projects/'+ids.root+'/files');held.release();await response;
      await expect(page.locator('#refresh-files')).toBeEnabled();await expect(group(page,'consistent')).toHaveAttribute('aria-pressed','true');await expect(search).toBeFocused();
      await expect(search).toHaveValue('法律');expect(await params(page)).toEqual(selected);await visibleKeys(page,[familyKey(s,'legal')]);await expect(row(page)).toHaveCount(0);noBusiness(s);
    }finally{held.release();s.filesGate=undefined;}
  });

  test('a failed registry pauses the chosen group without fake zeroes or blocked downloads; recovery resumes it and exposes partial missing states',async({page})=>{
    const s=await open(page);await page.locator('[data-file-type="financial"]').click();await choose(page,'review');await expect(rows(page)).toHaveCount(0);
    s.statusRegistryFailure=true;await refresh(page);await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await count(page,'all',4);
    await expect(page.locator('[data-file-type="financial"]')).toHaveAttribute('aria-current','page');expect(await params(page)).toMatchObject({folder:'4.1',type:'financial',file_status:'review'});
    for(const key of ['check','review','checking','consistent','unsynced','other'] as const)await count(page,key,'—');
    await expect(note(page)).toContainText('文种');await expect(rows(page)).toHaveCount(4);
    await page.locator('[data-folder="all"]').click();await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await count(page,'all',21);await expect(rows(page)).toHaveCount(21);
    const download=page.waitForEvent('download');
    await row(page).getByRole('button',{name:'下载',exact:true}).click();expect(await downloadBytes(await download)).toEqual(originalBytes);
    s.statusRegistryFailure=false;await refresh(page);await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await expect(rows(page)).toHaveCount(4);await count(page,'review',4);
    s.registryProjection=structuredClone(s.registry.filter(v=>v.file_id!==latest(s,'credit').file_id));await refresh(page);await count(page,'unsynced',1);await count(page,'check',3);
    await expect(note(page)).toContainText('1');await expect(page.locator('[data-show-unsynced]')).toBeVisible();await page.locator('[data-show-unsynced]').click();
    await expect(group(page,'unsynced')).toHaveAttribute('aria-pressed','true');await visibleKeys(page,[familyKey(s,'credit')]);
    await expect(rows(page).locator('[data-file-edit-upload]')).toHaveCount(0);await expect(rows(page).locator('a[href^="#consistency?"]')).toHaveCount(0);noBusiness(s);
  });

  test('mismatched pins and duplicate current identities become unsynced rather than inferred unchecked or empty review',async({page})=>{
    const s=await open(page);await page.locator('[data-file-type="financial"]').click();await choose(page,'check');
    const wrong=collection(s);wrong.items.find(f=>f.file_key===familyKey(s,'financial')&&f.latest)!.sha256=hash('a different immutable financial asset');s.collectionProjection=wrong;await refresh(page);
    await count(page,'unsynced',0);await expect(rows(page)).toHaveCount(0);await expect(note(page)).toContainText('1');await page.locator('[data-show-unsynced]').click();
    await expect(group(page,'unsynced')).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-file-type][aria-current="page"]')).toHaveCount(0);
    await visibleKeys(page,[familyKey(s,'financial')]);expect((await params(page)).folder).toBe('4.1');
    s.collectionProjection=undefined;const duplicate=structuredClone(latest(s,'financial'));duplicate.version_id='status-financial-ambiguous-current';
    s.registryProjection=[...structuredClone(s.registry),duplicate];await refresh(page);await count(page,'unsynced',1);await visibleKeys(page,[familyKey(s,'financial')]);
    await expect(rows(page).locator('[data-file-edit-upload]')).toHaveCount(0);await expect(rows(page).locator('.pf-chip')).toHaveText('状态待同步');
    s.registryProjection=undefined;const repeated=collection(s);repeated.items.push(structuredClone(repeated.items.find(f=>f.file_key===familyKey(s,'financial')&&f.latest)!));s.collectionProjection=repeated;
    await refresh(page);await expect(note(page)).toContainText('状态');await expect(page.locator('#file-list [data-file-edit-upload]')).toHaveCount(0);
    noBusiness(s);
  });

  test('accurate original-file context ignores ordinary status memory and explicit locate clears a later hiding status',async({page})=>{
    const s=await open(page);await page.locator('[data-file-type="init"]').click();await page.locator('#file-search').fill('立项');await choose(page,'review');await enterTask(page,s);
    await navigate(page,filesRoute('&file_status=consistent&type=legal&q='+encodeURIComponent('法律')).slice(1));await ready(page);
    await expect(page.locator('#pw-file-context')).toContainText('检查时原文件');await expect(group(page,'all')).toHaveAttribute('aria-pressed','true');
    await expect(row(page)).toHaveAttribute('data-file-context-target','true');await expect(row(page)).toBeFocused();await expect(page.locator('#file-search')).toHaveValue('');
    await choose(page,'consistent');await expect(row(page)).toHaveCount(0);await page.locator('[data-file-context-locate]').click();
    await expect(group(page,'all')).toHaveAttribute('aria-pressed','true');await expect(row(page)).toBeVisible();await expect(row(page)).toBeFocused();
    await page.locator('#pw-task-summary a').click();await expect(page.locator('.m4-delivery')).toBeVisible();await returnFiles(page);
    await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#file-search')).toHaveValue('立项');noBusiness(s);
  });

  test('status changes never alter an unknown upload envelope; confirmed V2 leaves review but keeps a working new/old-version entry',async({page})=>{
    const s=await open(page);s.dropImportOnce=true;await page.locator('[data-file-type="init"]').click();await page.locator('#file-search').fill('立项');await choose(page,'review');
    await row(page).getByRole('button',{name:'上传此文件修改稿',exact:true}).click();const dialog=page.getByRole('dialog',{name:'上传此文件修改稿',exact:true});
    await dialog.locator('[name=file]').setInputFiles(editedFile);await expect(dialog.locator('[role=status]')).toContainText('尚未确认');
    const first=structuredClone(s.imports[0]),journal=await uploadJournal(page);expect(first.expected_latest_version_id).toBe(ids.version);expect(first.document_type).toBe('init');expect(Object.keys(journal)).toHaveLength(1);
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();await choose(page,'check');await page.locator('[data-file-type="financial"]').click();await page.locator('#file-search').fill('财务');
    await choose(page,'review');await page.locator('[data-file-type="init"]').click();await page.locator('#file-search').fill('立项');expect(await uploadJournal(page)).toEqual(journal);expect(s.imports).toEqual([first]);expect(s.puts).toBe(1);
    const currentHash=await page.evaluate(()=>location.hash);await page.locator('#pw-task-summary a').click();await expect.poll(()=>page.evaluate(()=>location.hash)).toBe(currentHash);
    await expect(page.locator('#file-action-status')).toContainText('保存结果尚未确认');await page.locator('[data-resume-project-file]').click();
    const recovery=page.getByRole('dialog',{name:'上传此文件修改稿',exact:true});await expect(recovery.locator('[name=type]')).toHaveValue('init');await expect(recovery.locator('[name=type]')).toBeDisabled();
    await recovery.getByRole('button',{name:'重试保存项目文件',exact:true}).click();await expect(recovery).toHaveCount(0);await expect(page.locator('#pw-import-result')).toContainText('修改稿已保存为 V2');
    expect(s.imports).toEqual([first,first]);expect(s.puts).toBe(1);expect(s.importReceipts.size).toBe(1);expect(await uploadJournal(page)).toEqual({});
    await expect(group(page,'review')).toHaveAttribute('aria-pressed','true');await expect(row(page)).toHaveCount(0);await count(page,'review',0);await count(page,'check',1);
    await page.locator('[data-saved-history]').click();const history=page.getByRole('dialog',{name:'文件版本记录',exact:true});await expect(history).toContainText('V1');await expect(history).toContainText('V2');
    const v2=history.locator('article').filter({has:page.locator('strong',{hasText:'V2 ·'})}),v1=history.locator('article').filter({has:page.locator('strong',{hasText:'V1 ·'})});
    const freshDownload=page.waitForEvent('download');await v2.getByRole('button',{name:'下载',exact:true}).click();expect(await downloadBytes(await freshDownload)).toEqual(editedFile.buffer);
    const originalDownload=page.waitForEvent('download');await v1.getByRole('button',{name:'下载',exact:true}).click();expect(await downloadBytes(await originalDownload)).toEqual(originalBytes);
    noExecution(s);assertFixture(s);
  });
});
