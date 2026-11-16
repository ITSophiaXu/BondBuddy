import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {encodeBillingDto,PROJECT_FILE_UPDATE_PRICE} from '@bondbuddy/contracts';
import {fixture,open,assertFixture,writes,serverSnapshot,fileIds,checkId,ids,base,cacheKey,replaceCurrent,changeSource,type State} from './consistency-selection-fixtures';
import {captureConsistencySelection,installConsistencySelectionReference} from './consistency-selection-reference';

const reference=process.env.BB_CONSISTENCY_SELECTION_REFERENCE==='1';
const row=(page:Page,id:string)=>page.locator(`[data-fc-result-version="${id}"]`);
const checkbox=(page:Page,id:string)=>page.locator(`[data-fc-select="${id}"]`);
const facet=(page:Page,value:string)=>page.locator(`.fc-summary [data-fc-filter="${value}"]`);
const dialog=(page:Page)=>page.locator('dialog.fc-confirm[open]');
const names=(s:State)=>[fileIds.issuer,fileIds.financial].map(id=>s.checks[0].files.find(f=>f.file_version_id===id)!.filename);
const chosenVersions=(page:Page)=>page.locator('[data-fc-result-version]').evaluateAll(rows=>rows.map(r=>(r as HTMLElement).dataset.fcResultVersion));
async function chooseTwo(page:Page){await checkbox(page,fileIds.issuer).check();await checkbox(page,fileIds.financial).check();}
async function selection(page:Page,count:number,points:number,hidden=0,blocked=0){
  const text=`已选择 ${count} 份文件 · 共 ${points.toLocaleString('zh-CN')} 积分`+(hidden?`（含 ${hidden} 份筛选外文件）`:'')+(blocked?`；另有 ${blocked} 份已选文件当前不可更新，未计入费用。`:'');
  await expect(page.locator('[data-fc-selection]')).toHaveText(text);await expect(page.locator('#fc-selection')).toHaveText(text);
}
async function alignSummary(page:Page){await page.locator('.fc-summary').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));}
async function noBusiness(page:Page,s:State,before:ReturnType<typeof serverSnapshot>){expect(writes(s)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);await assertFixture(page);}

test.afterEach(async({page})=>assertFixture(page));
test.describe('consistency selection desktop journeys',()=>{
  test.skip(reference,'Only the exact component comparison runs in reference mode.');

  test('consistency selection: a project-file link exposes mixed manual work and defensive null replacements through keyboard-operable facets',async({page})=>{
    // Issuer is a normal mixed result. Credit deliberately uses the schema-valid
    // conflict/null projection; the real worker normally normalizes it to manual.
    const s=await open(page,fixture({nullManual:true}),'files'),before=serverSnapshot(s);
    const file=page.locator(`[data-file-version="${fileIds.issuer}"]`),link=file.getByRole('link',{name:'查看差异 / 更新',exact:true});
    const query=new URLSearchParams((await link.getAttribute('href'))!.split('?')[1]);
    expect(query.get('run')).toBe(checkId);expect(query.get('file')).toBe(s.files.find(f=>f.version_id===fileIds.issuer)!.file_id);
    await link.click();await expect(page.locator('.fc-results')).toBeVisible();await expect(row(page,fileIds.issuer).locator('details')).toHaveAttribute('open');
    await expect(page.locator('.fc-summary [data-fc-filter]')).toHaveCount(4);
    await expect(facet(page,'conflict')).toContainText(/不一致\s*2\s*份文件/);
    await expect(facet(page,'manual')).toContainText(/需人工确认\s*2\s*份文件/);
    await expect(page.locator('.fc-history-scope')).toContainText('各类数量不相加');
    await facet(page,'manual').focus();await page.keyboard.press('Enter');
    await expect(facet(page,'manual')).toHaveAttribute('aria-pressed','true');await expect(facet(page,'manual')).toBeFocused();
    await expect(page.locator('#fc-filter')).toHaveValue('manual');expect(await chosenVersions(page)).toEqual([fileIds.issuer,fileIds.credit]);
    await expect(row(page,fileIds.issuer).locator('.pf-chip')).toContainText('不一致');await expect(checkbox(page,fileIds.issuer)).toBeEnabled();
    await expect(row(page,fileIds.issuer).locator('.fc-manual-next')).toContainText('需人工确认的事项继续保留');
    await expect(checkbox(page,fileIds.credit)).toBeDisabled();await expect(row(page,fileIds.credit).locator('[data-fc-file]')).toHaveCount(0);
    await row(page,fileIds.credit).locator('summary').click();await expect(row(page,fileIds.credit)).toContainText('此项不会自动修改');
    await facet(page,'conflict').click();expect(await chosenVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);
    await facet(page,'consistent').click();await expect(page.locator('[data-fc-result-version]')).toHaveCount(0);
    await page.locator('[data-fc-filter="all"]').click();await expect(page.locator('[data-fc-result-version]')).toHaveCount(3);
    await noBusiness(page,s,before);
  });

  test('consistency selection: long catalogue lists keep both summaries synchronized and make hidden selections reviewable and clearable',async({page})=>{
    const s=await open(page,fixture({long:true})),before=serverSnapshot(s);
    await expect(page.locator('[data-fc-result-version]')).toHaveCount(12);expect(new Set(s.files.map(f=>f.document_type)).size).toBe(12);
    await alignSummary(page);await expect(page.locator('#fc-accept-top')).toBeInViewport({ratio:1});
    expect(await page.locator('#fc-accept').evaluate(e=>e.getBoundingClientRect().top)).toBeGreaterThan(960);
    await chooseTwo(page);await selection(page,2,9000);
    await facet(page,'manual').click();await selection(page,2,9000,1);
    expect(await chosenVersions(page)).toEqual([fileIds.issuer,fileIds.credit]);
    await expect(page.locator('#fc-accept-top')).toBeEnabled();await expect(page.locator('#fc-accept')).toBeEnabled();
    await page.locator('[data-fc-show-selected]').click();await expect(page.locator('#fc-filter')).toHaveValue('selected');
    expect(await chosenVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);await selection(page,2,9000);
    await page.locator('[data-fc-clear-selection]').click();await selection(page,0,0);await expect(page.locator('#fc-filter')).toBeFocused();
    await expect(page.locator('[data-fc-result-version]')).toHaveCount(0);await expect(page.locator('.fc-filter-empty')).toContainText('当前没有已选文件');
    await expect(page.locator('#fc-accept-top')).toBeDisabled();await expect(page.locator('#fc-accept')).toBeDisabled();
    await page.locator('[data-fc-filter="all"]').click();await expect(page.locator('[data-fc-result-version]')).toHaveCount(12);
    await noBusiness(page,s,before);
  });

  test('consistency selection: keyboard removal in selected view moves to the remaining checkbox and then the filter',async({page})=>{
    const s=await open(page),before=serverSnapshot(s);await chooseTwo(page);await page.locator('[data-fc-show-selected]').click();
    await checkbox(page,fileIds.issuer).focus();await page.keyboard.press('Space');
    await expect(row(page,fileIds.issuer)).toHaveCount(0);await expect(checkbox(page,fileIds.financial)).toBeFocused();await selection(page,1,4500);
    await page.keyboard.press('Space');await expect(page.locator('[data-fc-result-version]')).toHaveCount(0);
    await expect(page.locator('#fc-filter')).toBeFocused();await expect(page.locator('#fc-filter')).toHaveValue('selected');await selection(page,0,0);
    await page.locator('[data-fc-filter="all"]').click();await expect(page.locator('#fc-filter')).toHaveValue('all');
    await noBusiness(page,s,before);
  });

  test('consistency selection: either summary opens the same 9,000 point confirmation and only explicit confirmation submits',async({page})=>{
    const s=await open(page),before=serverSnapshot(s);await chooseTwo(page);await page.locator('#fc-accept-top').click();
    await expect(dialog(page)).toBeVisible();await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(names(s));
    await expect(dialog(page)).toContainText('9,000');await expect(dialog(page)).toContainText('需人工判断的内容保留批注');
    await expect(dialog(page)).toContainText(s.source.filename);await noBusiness(page,s,before);
    await dialog(page).getByRole('button',{name:'返回调整',exact:true}).click();await expect(dialog(page)).toHaveCount(0);
    await selection(page,2,9000);await page.locator('#fc-accept').click();
    await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(names(s));expect(s.posts).toHaveLength(0);
    await dialog(page).locator('#fc-confirm-update').click();await expect.poll(()=>s.posts.length).toBe(1);await expect(dialog(page)).toHaveCount(0);
    expect(s.posts[0]).toEqual({checkId,body:{request_id:expect.any(String),expected_check_sha256:s.checks[0].sha256,
      price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:9000,files:[{file_version_id:fileIds.issuer},{file_version_id:fileIds.financial}]}});
    expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);expect(writes(s).map(c=>c.path)).toEqual([base+'/checks/'+checkId+'/updates']);
    expect(s.checks).toEqual(before.checks);expect(s.source).toEqual(before.source);expect(s.files).toEqual(before.files);
    await page.getByRole('link',{name:'返回项目文件',exact:true}).click();await expect(page.locator('#file-list')).toBeVisible();
    await expect(page.locator('[data-file-version]')).toHaveCount(3);expect(s.posts).toHaveLength(1);await assertFixture(page);
  });

  test('consistency selection: saved replacement and stale source keep blocked selected originals visible without charging them',async({page})=>{
    const s=await open(page),originalCheck=structuredClone(s.checks[0]);await chooseTwo(page);await page.locator('[data-fc-show-selected]').click();
    replaceCurrent(s);await page.reload();await expect(page.locator('.fc-results')).toBeVisible();await expect(page.locator('#fc-filter')).toHaveValue('selected');
    expect(await chosenVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);await expect(checkbox(page,fileIds.issuer)).toBeChecked();await expect(checkbox(page,fileIds.issuer)).toBeDisabled();
    await expect(row(page,fileIds.issuer)).toContainText('这份文件在检查后已换版');await expect(checkbox(page,fileIds.financial)).toBeEnabled();
    await selection(page,1,4500,0,1);expect(s.checks[0]).toEqual(originalCheck);
    changeSource(s);const before=serverSnapshot(s);await page.reload();await expect(page.locator('.fc-results')).toBeVisible();
    expect(await chosenVersions(page)).toEqual([fileIds.issuer,fileIds.financial]);await selection(page,0,0,0,2);
    await expect(checkbox(page,fileIds.issuer)).toBeDisabled();await expect(checkbox(page,fileIds.financial)).toBeDisabled();
    await expect(page.locator('#fc-accept-top')).toBeDisabled();await expect(page.locator('#fc-accept')).toBeDisabled();
    await expect(row(page,fileIds.issuer).locator('.fc-manual-next')).toContainText('需人工确认的事项继续保留');
    await noBusiness(page,s,before);
  });

  test('consistency selection: clearing local selection after a lost receipt still retries only the exact frozen original envelope',async({page})=>{
    const wireBodies:string[]=[];
    page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1'+base+'/checks/'+checkId+'/updates')wireBodies.push(request.postData()!);});
    const s=await open(page,fixture({dropUpdateOnce:true}));await chooseTwo(page);await page.locator('[data-fc-show-selected]').click();
    await page.locator('#fc-accept-top').click();const readsBeforeSubmit=s.checkReads;await dialog(page).locator('#fc-confirm-update').click();
    await expect.poll(()=>s.posts.length).toBe(1);await expect(page.locator('#fc-pending-action')).toBeVisible();
    const original=structuredClone(s.posts[0]);expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);
    // No reload or source/file change has yet supplied a separate blocking reason.
    // Every fresh-update entry must be disabled while the original receipt is unknown.
    await dialog(page).getByRole('button',{name:'返回调整',exact:true}).click();await expect(dialog(page)).toHaveCount(0);
    await selection(page,2,9000);await expect(page.locator('#fc-accept-top')).toBeDisabled();await expect(page.locator('#fc-accept')).toBeDisabled();
    for(const id of [fileIds.issuer,fileIds.financial]){
      await expect(row(page,id).locator('[data-fc-file]')).toBeDisabled();
      await expect(row(page,id).locator('.fc-file-freshness')).toHaveCount(0);
    }
    await expect(page.locator('#fc-pending-action')).toBeEnabled();expect(s.checkReads).toBe(readsBeforeSubmit);
    expect(s.posts).toHaveLength(1);expect(writes(s)).toHaveLength(1);expect(writes(s)[0].body).toEqual(original.body);
    replaceCurrent(s);changeSource(s);await page.reload();await expect(page.locator('#fc-pending-action')).toBeVisible();
    await expect(page.locator('#fc-accept-top')).toBeDisabled();await expect(page.locator('#fc-accept')).toBeDisabled();
    await page.locator('[data-fc-clear-selection]').click();await expect(page.locator('[data-fc-result-version]')).toHaveCount(0);
    const cached=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),cacheKey);
    expect(wireBodies).toHaveLength(1);const originalWire=wireBodies[0];
    expect(JSON.parse(originalWire)).toEqual(encodeBillingDto('projectFileUpdateRequest',original.body));
    expect(cached.pendingUpdate.body).toEqual(JSON.parse(originalWire));expect(cached.pendingUpdate.checkId).toBe(original.checkId);expect(cached.chosen).toEqual([]);
    expect(s.posts).toHaveLength(1);await page.locator('#fc-pending-action').click();await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(names(s));
    await expect(dialog(page)).toContainText('9,000');await expect(dialog(page)).toContainText('重试沿用同一份已确认请求');
    await dialog(page).locator('#fc-confirm-update').click();await expect.poll(()=>s.posts.length).toBe(2);await expect(dialog(page)).toHaveCount(0);
    expect(s.posts[1]).toEqual(original);expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);
    expect(wireBodies).toEqual([originalWire,originalWire]);
    expect(writes(s).map(c=>c.path)).toEqual([base+'/checks/'+checkId+'/updates',base+'/checks/'+checkId+'/updates']);
    expect(s.files.find(f=>f.latest&&f.file_id===s.checks[0].files[0].file_id)?.sequence).toBe(2);expect(s.source.sequence).toBe(4);
    await assertFixture(page);
  });
});

test('consistency selection component comparison: current and exact R28 share twelve real families, the same selection and the same confirmation at 1440',async({page})=>{
  const verify=reference?await installConsistencySelectionReference(page):undefined;
  const s=await open(page,fixture({long:true})),before=serverSnapshot(s);await chooseTwo(page);
  const directory=process.env.BB_CONSISTENCY_SELECTION_EVIDENCE_DIR??test.info().outputPath(reference?'reference':'current');
  await alignSummary(page);
  const audit=(action:string)=>({reference,synthetic:true,action,check:checkId,source_version:s.source.version_id,
    checked_families:s.checks[0].files.length,unique_document_types:new Set(s.files.map(f=>f.document_type)).size,projection_faults:s.projectionFaults,writes:writes(s)});
  const selected=await captureConsistencySelection(page,directory,'consistency-selection-selected-1440',audit('Both implementations selected the exact same issuer and financial originals; summary aligned at viewport start.'));
  expect(selected.rows).toHaveLength(12);expect(selected.bottomSelection).toContain('9,000');expect(selected.rects.bottomAccept!.top).toBeGreaterThan(960);
  if(reference){expect(selected.topSelection).toBeNull();expect(selected.facets).toHaveLength(0);}
  else{expect(selected.topSelection).toBe(selected.bottomSelection);expect(selected.facets).toHaveLength(4);expect(selected.rects.topAccept!.top).toBeGreaterThanOrEqual(0);expect(selected.rects.topAccept!.bottom).toBeLessThanOrEqual(960);}
  await page.locator('#fc-filter').selectOption('manual');await alignSummary(page);
  const manual=await captureConsistencySelection(page,directory,'consistency-selection-manual-1440',audit('Both implementations used the existing manual filter with the same unchanged two selections.'));
  expect(manual.rows.map(r=>r.version)).toEqual(reference?[fileIds.credit]:[fileIds.issuer,fileIds.credit]);
  expect(manual.bottomSelection).toContain('9,000');expect(manual.bottomSelection).toContain(reference?'2 份筛选外文件':'1 份筛选外文件');
  await page.locator('#fc-accept').click();await expect(dialog(page).locator(reference?'li':'.fc-confirm-filename')).toHaveText(names(s));
  const confirmation=await captureConsistencySelection(page,directory,'consistency-selection-confirm-1440',audit('Both implementations opened the unchanged footer confirmation; no submission or charge was performed.'));
  expect(confirmation.confirmationFiles).toEqual(names(s));expect(confirmation.confirmation).toContain('9,000');expect(confirmation.confirmation).toContain('需人工判断的内容保留批注');
  await noBusiness(page,s,before);
  if(verify){await mkdir(directory,{recursive:true});await writeFile(join(directory,'consistency-selection-reference-1440.json'),JSON.stringify(await verify(),null,2));}
});
