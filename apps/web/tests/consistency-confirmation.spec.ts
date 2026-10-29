import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,test,type Page,type Locator} from '@playwright/test';
import {PROJECT_FILE_UPDATE_PRICE,encodeBillingDto} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {fixture,open,assertFixture,expected,typeName,resultHash,completeReceipt,changeLive,forgetOriginalCheck,
  selectedVersions,sharedFilename,excludedFilename,ids,base,cacheKey,fileIds,checkId,writes,serverSnapshot,type State} from './consistency-confirmation-fixtures';

// Actual native main/project/consistency routes with a closed, owner-scoped
// synthetic HTTP producer. No worker, actual billing, model or Word/WPS runs.
const modal=(page:Page)=>page.locator('dialog.fc-confirm[open]');
const row=(page:Page,version:string)=>page.locator('[data-fc-result-version="'+version+'"]');
const checkbox=(page:Page,version:string)=>page.locator('[data-fc-select="'+version+'"]');
const confirmationRow=(page:Page,version:string)=>modal(page).locator('.fc-confirm-files > li[data-confirm-version="'+version+'"]');
const body=(page:Page)=>modal(page).locator('.fc-confirm-body');
const scope=(page:Page)=>modal(page).locator('details.fc-confirm-scope');
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
type Cached={chosen:string[];pendingUpdate:{checkId:string;body:Dto<'ProjectFileUpdateRequest'>;filenames:string[];attempted:boolean;confirmation?:unknown}};
const cached=(page:Page)=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null') as Cached|null,cacheKey);

async function chooseTwo(page:Page){
  // Deliberately cross a facet and a name filter. The final list must still
  // describe the two selected immutable versions, including the hidden one.
  await page.locator('.fc-summary [data-fc-filter="manual"]').click();
  await checkbox(page,fileIds.issuer).check();
  await page.locator('.fc-summary [data-fc-filter="all"], [data-fc-show-all="toolbar"]').first().click();
  await page.locator('#fc-file-search').fill(sharedFilename);
  await checkbox(page,fileIds.financial).check();
  await page.locator('#fc-file-search').fill('另行保留');
  await expect(row(page,fileIds.credit)).toHaveCount(1);
  await expect(page.locator('[data-fc-selection]')).toContainText('2 份筛选外文件');
}
async function chooseDirect(page:Page,versions=selectedVersions){for(const version of versions)await checkbox(page,version).check();}
async function noBusiness(page:Page,s:State,before:ReturnType<typeof serverSnapshot>){expect(writes(s)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);await assertFixture(page);}
async function exactIdentity(page:Page,label:string,value:unknown){
  const actual=await scope(page).locator('dt').evaluateAll((nodes,label)=>nodes.filter(node=>node.textContent===label).map(node=>node.nextElementSibling?.textContent),label);
  expect(actual,'One exact definition for '+label).toEqual([typeof value==='string'?value:JSON.stringify(value)]);
}
async function assertBusinessScope(page:Page,s:State,versions=selectedVersions){
  const original=expected(s),source=modal(page).locator('.fc-confirm-source');
  await expect(source.locator('strong')).toHaveText(original.source.filename);
  await expect(source).toContainText('V'+original.source.sequence+' · 采用记录 '+original.source.selection_revision);
  await expect(modal(page).locator('.fc-confirm-project')).toHaveText(original.projectName);
  expect(await modal(page).locator('.fc-confirm-files > li').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.confirmVersion))).toEqual(versions);
  for(const version of versions){
    const file=original.files.find(f=>f.version_id===version)!,item=confirmationRow(page,version);
    await expect(item.locator('.fc-confirm-filename')).toHaveText(file.filename);
    await expect(item.locator('.fc-confirm-version')).toHaveText('检查时 V'+file.sequence);
    await expect(item.locator('.fc-confirm-type')).toHaveText(typeName(file.document_type));
    await expect(item.locator('.fc-confirm-counts')).toHaveText('自动更新 '+file.automatic+' 处 · '+(file.manualUnlisted?'人工事项未提供逐项信息，继续保留':'人工 '+file.manual+' 项继续保留'));
  }
  await expect(modal(page).locator('.fc-confirm-total')).toHaveText(versions.length+' 份 × 4,500 积分 = '+(versions.length*PROJECT_FILE_UPDATE_PRICE.points).toLocaleString('zh-CN')+' 积分');
  await expect(modal(page)).toContainText('需人工判断的内容保留批注');
}
async function assertFullScope(page:Page,s:State,versions=selectedVersions){
  const original=expected(s);await expect(scope(page)).not.toHaveAttribute('open','');
  await scope(page).locator('summary').focus();await page.keyboard.press('Enter');await expect(scope(page)).toHaveAttribute('open','');
  await exactIdentity(page,'检查编号',checkId);await exactIdentity(page,'检查结果 hash',original.check.sha256);
  await exactIdentity(page,'募集书项目编号',original.source.project_id);await exactIdentity(page,'募集书版本编号',original.source.version_id);
  await exactIdentity(page,'募集书文件引用',original.source.asset);
  for(const [index,version] of versions.entries()){
    const file=original.files.find(f=>f.version_id===version)!;
    await exactIdentity(page,'文件 '+(index+1)+' 版本编号',file.version_id);
    await exactIdentity(page,'文件 '+(index+1)+' 文件族编号',file.file_id);
    await exactIdentity(page,'文件 '+(index+1)+' 原稿引用',file.asset);
  }
}
async function readSelectedDifferences(page:Page,s:State){
  const original=expected(s);
  for(const version of selectedVersions){
    const file=row(page,version),details=file.locator('details[data-fc-detail]');
    if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();
    for(const finding of original.check.result!.files.find(f=>f.file_version_id===version)!.findings){
      const item=file.locator('[data-fc-finding-id="'+finding.id+'"]');
      await expect(item).toContainText(finding.original);await expect(item).toContainText(finding.target_location);
      await expect(item).toContainText(finding.reason);
      if(finding.kind==='conflict'&&finding.replacement!==null){
        await expect(item).toContainText(finding.source_quote);await expect(item).toContainText(finding.source_location);
        await expect(item.locator('.fc-replacement')).toContainText(finding.replacement);
      }else await expect(item).toContainText('此项不会自动修改');
    }
  }
}
async function startUnknown(page:Page,s=fixture({dropUpdateOnce:true})){
  const wireBodies:unknown[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1'+base+'/checks/'+checkId+'/updates')wireBodies.push(request.postDataJSON());});
  await open(page,s);await chooseDirect(page);await page.locator('#fc-accept-top').click();
  await assertBusinessScope(page,s);await modal(page).locator('#fc-confirm-update').click();
  await expect.poll(()=>s.posts.length).toBe(1);await expect(page.locator('#fc-pending-action')).toBeVisible();
  const original=structuredClone(s.posts[0]);expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);
  // The producer keeps small domain numbers; browser storage and HTTP use int64 strings.
  // Compare each layer with its own immutable envelope, including the actual wire replay.
  expect(wireBodies).toEqual([encodeBillingDto('projectFileUpdateRequest',original.body)]);
  const saved=await cached(page);expect(saved?.pendingUpdate.confirmation).toBeDefined();
  await modal(page).getByRole('button',{name:'返回调整',exact:true}).click();
  await page.locator('[data-fc-clear-selection]').click();expect((await cached(page))?.chosen).toEqual([]);
  return {s,original,wireBodies,confirmation:structuredClone(saved!.pendingUpdate.confirmation)};
}

test.afterEach(async({page})=>assertFixture(page));

test('consistency confirmation: native file entry reviews differences and confirms only two of three actionable original files',async({page})=>{
  const s=await open(page,fixture(),'files'),before=serverSnapshot(s),original=expected(s);
  const third=structuredClone(s.files.filter(f=>f.file_id===original.files.find(f=>f.version_id===fileIds.credit)!.file_id));
  const file=page.locator('[data-file-version="'+fileIds.issuer+'"]');
  await file.getByRole('link',{name:'查看差异 / 更新',exact:true}).click();await expect(page.locator('.fc-results')).toBeVisible();
  expect(new URLSearchParams(new URL(await page.url()).hash.split('?')[1]).get('file')).toBe(original.files.find(f=>f.version_id===fileIds.issuer)!.file_id);
  await expect(page.locator('.fc-summary [data-fc-filter="conflict"]')).toContainText(/3\s*份文件/);
  await readSelectedDifferences(page,s);await noBusiness(page,s,before);
  await chooseTwo(page);await page.locator('#fc-accept-top').click();await assertBusinessScope(page,s);
  await expect(confirmationRow(page,fileIds.credit)).toHaveCount(0);await expect(modal(page)).not.toContainText(excludedFilename);
  await assertFullScope(page,s);await noBusiness(page,s,before);
  await modal(page).getByRole('button',{name:'返回调整',exact:true}).click();await expect(modal(page)).toHaveCount(0);
  await expect(page.locator('[data-fc-selection]')).toContainText('9,000');await noBusiness(page,s,before);
  await page.locator('#fc-accept').click();await assertBusinessScope(page,s);
  await modal(page).locator('#fc-confirm-update').click();await expect(modal(page)).toHaveCount(0);
  expect(s.posts).toHaveLength(1);expect(s.validatedNewEnvelopes).toHaveLength(1);
  expect(s.posts[0]).toEqual({checkId,body:{request_id:expect.any(String),expected_check_sha256:resultHash(original.check.result),
    price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:9000,files:selectedVersions.map(file_version_id=>({file_version_id}))}});
  expect(s.files.filter(f=>f.file_id===third[0].file_id)).toEqual(third);
  completeReceipt(s,s.posts[0].body.request_id);await page.reload();await expect(page.locator('.fc-results')).toBeVisible();
  for(const version of selectedVersions){
    const result=row(page,version);await expect(result.locator('.fc-downloads')).toBeVisible();
    const output=s.files.find(f=>s.checks[0].updates.some(u=>u.file_version_id===version&&u.new_version_id===f.version_id))!;
    for(const [variant,label] of [['revision','下载修订版'],['clean','下载清洁版']] as const){
      const asset=variant==='revision'?output.revision_asset:output.asset;expect(asset?.kind).toBe('artifact');if(asset?.kind!=='artifact')throw new Error('Missing synthetic artifact');
      const waiting=page.waitForEvent('download');await result.getByRole('button',{name:label,exact:true}).click();const download=await waiting;
      expect(await download.failure()).toBeNull();const saved=await download.path();expect(saved).not.toBeNull();
      expect(await readFile(saved!)).toEqual(s.artifacts.get(asset.pin.artifact_id)!.bytes);
    }
  }
  await expect(row(page,fileIds.issuer).locator('.fc-manual-next')).toContainText('需人工确认的事项继续保留');
  expect(s.files.filter(f=>f.file_id===third[0].file_id)).toEqual(third);
  await page.getByRole('link',{name:'返回项目文件',exact:true}).click();await expect(page.locator('#file-list')).toBeVisible();
  const issuer=s.files.find(f=>f.latest&&f.file_id===original.files.find(f=>f.version_id===fileIds.issuer)!.file_id)!;
  await expect(page.locator('[data-file-version="'+issuer.version_id+'"]')).toContainText('需人工确认');
  expect(writes(s).map(c=>c.path)).toEqual([base+'/checks/'+checkId+'/updates']);
});

test('consistency confirmation: a direct file update shows one exact original with its own 4,500 point scope',async({page})=>{
  const s=await open(page),before=serverSnapshot(s);await row(page,fileIds.financial).locator('[data-fc-file]').click();
  await assertBusinessScope(page,s,[fileIds.financial]);await assertFullScope(page,s,[fileIds.financial]);
  await modal(page).getByRole('button',{name:'返回调整',exact:true}).click();await noBusiness(page,s,before);
});

test('consistency confirmation: incomplete manual projection says item details were not supplied instead of claiming zero remaining work',async({page})=>{
  const s=await open(page,fixture({manualUnlisted:true})),before=serverSnapshot(s);await checkbox(page,fileIds.issuer).check();await page.locator('#fc-accept-top').click();
  await assertBusinessScope(page,s,[fileIds.issuer]);
  await expect(confirmationRow(page,fileIds.issuer).locator('.fc-confirm-counts')).not.toContainText('人工 0 项');
  await noBusiness(page,s,before);
});

for(const missing of [false,true])test('consistency confirmation: unknown receipt restores the original scope after delivery and live changes'+(missing?' even when the original check leaves the recent list':''),async({page})=>{
  const {s,original,wireBodies,confirmation}=await startUnknown(page);completeReceipt(s,original.body.request_id);changeLive(s);
  s.rootProject.name='合成后来变更的项目名称';if(missing)forgetOriginalCheck(s);
  await page.reload();await expect(page.locator('#fc-pending-action')).toBeVisible();
  if(missing)expect(s.calls.filter(call=>call.method==='GET'&&call.path===base+'/checks/'+checkId)).toHaveLength(1);
  expect((await cached(page))?.pendingUpdate.body).toEqual(wireBodies[0]);
  expect((await cached(page))?.pendingUpdate.confirmation).toEqual(confirmation);
  await page.locator('#fc-pending-action').click();await assertBusinessScope(page,s);await assertFullScope(page,s);
  await expect(modal(page)).not.toContainText(s.source.filename);await expect(modal(page)).not.toContainText('合成后来保存的财务新稿.docx');
  await exactIdentity(page,'请求编号',original.body.request_id);await modal(page).locator('#fc-confirm-update').click();
  await expect.poll(()=>s.posts.length).toBe(2);expect(s.posts[1]).toEqual(original);
  expect(wireBodies).toEqual([wireBodies[0],wireBodies[0]]);
  expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);expect(s.validatedNewEnvelopes).toHaveLength(1);
  expect(s.files.find(f=>f.latest&&f.document_type==='financial')!.sequence).toBe(6);
});

for(const mode of ['legacy','foreign-binding','partial-files'] as const)test('consistency confirmation: '+mode+' pending snapshot degrades honestly while retrying the unchanged original envelope',async({page})=>{
  const {s,original,wireBodies}=await startUnknown(page);completeReceipt(s,original.body.request_id);changeLive(s);forgetOriginalCheck(s);
  await page.evaluate(({key,mode})=>{
    const value=JSON.parse(sessionStorage.getItem(key)!);
    if(mode==='legacy')delete value.pendingUpdate.confirmation;
    else if(mode==='foreign-binding')value.pendingUpdate.confirmation.binding.project='another-project';
    else value.pendingUpdate.confirmation.files.pop();
    sessionStorage.setItem(key,JSON.stringify(value));
  },{key:cacheKey,mode});
  await page.reload();await expect(page.locator('#fc-pending-action')).toBeVisible();
  expect(s.calls.filter(call=>call.method==='GET'&&call.path===base+'/checks/'+checkId)).toHaveLength(1);
  await page.locator('#fc-pending-action').click();
  await expect(modal(page)).toContainText('原确认的版本与修改明细无法完整恢复');
  await expect(modal(page).locator('.fc-confirm-source,.fc-confirm-counts,.fc-confirm-version,.fc-confirm-type')).toHaveCount(0);
  await expect(modal(page).locator('.fc-confirm-filename')).toHaveText([sharedFilename,sharedFilename]);
  await expect(modal(page)).not.toContainText(s.source.filename);await expect(modal(page).locator('.fc-confirm-total')).toContainText('9,000');
  await scope(page).locator('summary').click();await exactIdentity(page,'检查编号',original.checkId);await exactIdentity(page,'检查结果 hash',original.body.expected_check_sha256);
  await exactIdentity(page,'请求编号',original.body.request_id);
  await exactIdentity(page,'文件 1 版本编号',selectedVersions[0]);await exactIdentity(page,'文件 2 版本编号',selectedVersions[1]);
  expect((await cached(page))?.pendingUpdate.body).toEqual(wireBodies[0]);
  await modal(page).locator('#fc-confirm-update').click();await expect.poll(()=>s.posts.length).toBe(2);
  expect(s.posts[1]).toEqual(original);expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);
  expect(wireBodies).toEqual([wireBodies[0],wireBodies[0]]);
});

test('consistency confirmation: twelve selected catalogue files keep a keyboard-scrollable review body and reachable fixed fee controls',async({page})=>{
  const s=await open(page,fixture({long:true})),before=serverSnapshot(s);await page.locator('#fc-all').check();
  const versions=expected(s).files.map(f=>f.version_id);expect(versions).toHaveLength(12);
  await page.locator('#fc-accept-top').click();await assertBusinessScope(page,s,versions);
  const confirm=modal(page).locator('#fc-confirm-update'),back=modal(page).getByRole('button',{name:'返回调整',exact:true});
  await expect(confirm).toBeInViewport({ratio:1});await expect(back).toBeInViewport({ratio:1});
  await expect(body(page)).toHaveAttribute('tabindex','0');await body(page).focus();await page.keyboard.press('End');
  await expect.poll(()=>body(page).evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
  await expect(confirm).toBeInViewport({ratio:1});await expect(back).toBeInViewport({ratio:1});
  await page.keyboard.press('Tab');await expect(scope(page).locator('summary')).toBeFocused();await page.keyboard.press('Enter');
  await expect(scope(page)).toHaveAttribute('open','');await body(page).focus();await page.keyboard.press('End');
  await page.keyboard.press('Tab');await page.keyboard.press('Tab');await expect(back).toBeFocused();
  await page.keyboard.press('Tab');await expect(confirm).toBeFocused();
  expect(await modal(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect(await body(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');await expect(modal(page)).toHaveCount(0);
  await noBusiness(page,s,before);
});

async function capture(page:Page,s:State,directory:string,name:string){
  await mkdir(directory,{recursive:true});
  const metrics=await modal(page).evaluate(node=>{
    const box=(element:Element|null)=>{if(!element)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}};
    const body=node.querySelector<HTMLElement>('.fc-confirm-body')!;
    return {route:location.hash,width:innerWidth,height:innerHeight,dialog:box(node),body:{box:box(body),scrollTop:body.scrollTop,clientHeight:body.clientHeight,scrollHeight:body.scrollHeight,clientWidth:body.clientWidth,scrollWidth:body.scrollWidth},
      footer:box(node.querySelector('footer')),confirm:box(node.querySelector('#fc-confirm-update')),source:node.querySelector('.fc-confirm-source')?.textContent,
      rows:[...node.querySelectorAll<HTMLElement>('[data-confirm-version]')].map(row=>({version:row.dataset.confirmVersion,filename:row.querySelector('.fc-confirm-filename')?.textContent,type:row.querySelector('.fc-confirm-type')?.textContent,sequence:row.querySelector('.fc-confirm-version')?.textContent,counts:row.querySelector('.fc-confirm-counts')?.textContent})),scopeOpen:node.querySelector('details')?.hasAttribute('open'),active:document.activeElement?.id??null};
  });
  const png=await page.screenshot({path:join(directory,name+'.png'),fullPage:false});
  const sources=await Promise.all(['file-consistency.ts','consistency-confirmation.ts','consistency-confirmation.css'].map(async name=>{const path='apps/web/src/'+name,bytes=await readFile(resolve('../..',path));return {path,bytes:bytes.length,sha256:digest(bytes)}}));
  await writeFile(join(directory,name+'.json'),JSON.stringify({...metrics,png_bytes:png.length,png_sha256:digest(png),sources,
    audit:{synthetic:true,original:expected(s),writes:writes(s),limits:'Native desktop browser and synthetic owner-scoped HTTP/OOXML/receipt evidence only; no real services, worker, model, billing, Word/WPS or user acceptance. Mobile deferred.'}},null,2));
}

test('consistency confirmation current collector: same-name selection and twelve-file desktop review',async({page})=>{
  const directory=process.env.BB_CONSISTENCY_CONFIRMATION_EVIDENCE_DIR;
  test.skip(!directory,'Opt-in evidence collector; set BB_CONSISTENCY_CONFIRMATION_EVIDENCE_DIR.');
  const s=await open(page,fixture({long:true})),before=serverSnapshot(s);await chooseDirect(page);await page.locator('#fc-accept-top').click();await assertBusinessScope(page,s);
  await capture(page,s,directory!,'consistency-confirmation-selected-1440');
  await modal(page).getByRole('button',{name:'返回调整',exact:true}).click();await page.locator('#fc-all').check();await page.locator('#fc-accept-top').click();
  await assertBusinessScope(page,s,expected(s).files.map(f=>f.version_id));await capture(page,s,directory!,'consistency-confirmation-long-1440');
  await scope(page).locator('summary').click();await body(page).focus();await page.keyboard.press('End');
  await capture(page,s,directory!,'consistency-confirmation-identity-1440');await noBusiness(page,s,before);
});
