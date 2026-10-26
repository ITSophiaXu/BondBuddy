import {expect,type Locator,type Page} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,ProjectFileVersionSchema,type ProjectFileFinding,type ProjectFileUpdateBatches} from '@bondbuddy/contracts';
import {assertFixture as assertOriginals,base,cacheKey,checkId,checkRoute,downloadBytes,editedFile,filesRoute,
  fixture as originalsFixture,hash,ids,install as installOriginals,issuerFamily,issuerVersion,originalBytes,writeCalls} from './consistency-originals-fixtures';

export {base,cacheKey,checkId,downloadBytes,editedFile,filesRoute,hash,ids,issuerFamily,issuerVersion,originalBytes,writeCalls};
export const activeRun='manual-reading-existing-issuer-patch';
export const itemIds={autoA:'manual-reading-auto-a',autoB:'manual-reading-auto-b',first:'manual-reading-shared-id',
  nullConflict:'manual-reading-null-conflict',withReplacement:'manual-reading-manual-with-replacement',last:'manual-reading-last'};
export const isManual=(finding:ProjectFileFinding)=>finding.kind==='manual'||finding.replacement===null;
export type Options={active?:boolean;emptyManual?:boolean;dropUpdateOnce?:boolean;historical?:boolean;long?:boolean};

/** Extend R30's real OOXML/import-CAS HTTP producer. All business data are synthetic. */
export function fixture(options:Options={}){
  const s=originalsFixture({dropUpdateOnce:options.dropUpdateOnce,historical:options.historical});
  s.rootProject.name='合成人工事项逐项阅读项目';
  const result=s.check.result!.files.find(file=>file.file_version_id===ids.version)!,auto=structuredClone(result.findings[0]);
  const long=(label:string,id:string)=>`${label} · ${id}\n`+Array.from({length:options.long===false?2:12},(_,index)=>
    `合成第${index+1}段：逐项核实原文件、募集书依据、期间及单位。此段只用于真实长页滚动与完整内容检查，不代表业务结论。`).join('\n')+`\n${label}结束标记 ${id}`;
  const make=(id:string,kind:ProjectFileFinding['kind'],replacement:boolean):ProjectFileFinding=>({...structuredClone(auto),id,kind,
    target_span_id:id+'-target',source_span_id:id+'-source',field:'合成字段 '+id,period:'2026年度',unit:'万元',
    original:long('关联文件原文',id),source_quote:long('本轮募集书依据',id),reason:long('本轮说明',id),
    replacement:replacement?long('建议内容',id):null,target_location:'合成原文件第3页 '+id,source_location:'合成募集书第8页 '+id});
  // Deliberately interleave classification at the HTTP boundary. Non-null
  // kind=manual and null kind=conflict both retain the existing manual label.
  result.findings=[make(itemIds.first,'manual',false),make(itemIds.autoA,'conflict',true),
    make(itemIds.nullConflict,'conflict',false),make(itemIds.autoB,'conflict',true),
    make(itemIds.withReplacement,'manual',true),make(itemIds.last,'manual',false)];
  result.status='conflict';result.coverage='合成固定检查范围：全部原文、依据、说明和建议均应完整保留。';
  const issuer=s.check.result!.files.find(file=>file.file_version_id===issuerVersion)!;
  issuer.findings=[{...make(itemIds.first,'manual',false),original:'另一文件同名ID的人工事项，不能借用立项报告内容。'},make('manual-reading-issuer-auto','conflict',true)];
  issuer.status='conflict';
  for(const version of s.registry){const found=s.check.result!.files.find(file=>file.file_version_id===version.version_id);if(found)version.consistency={status:'conflict',count:found.findings.filter(f=>!isManual(f)).length,check_run_id:checkId};}
  if(options.emptyManual){result.findings=[];result.status='manual';s.registry.find(file=>file.version_id===ids.version)!.consistency={status:'manual',count:0,check_run_id:checkId};}
  const batches:ProjectFileUpdateBatches['batches']=[];
  if(options.active){
    const checked=s.check.files.find(file=>file.file_version_id===issuerVersion)!;
    s.check.updates=[{file_version_id:issuerVersion,issue_ids:['manual-reading-issuer-auto'],run_id:activeRun,state:'running',new_version_id:null}];
    batches.push({batch_id:'manual-reading-existing-batch',state:'running',items:[{file_version_id:issuerVersion,filename:checked.filename,run_id:activeRun,error:null}]});
  }
  return Object.assign(s,{manualOptions:options,batches,projectionFaults:[
    'R39 schema-allowed classification probes: conflict/null and manual/non-null; conservative public label coverage, not a normal verified worker-output claim',
    ...(options.emptyManual?['R39 defensive manual status with zero supplied findings; public shape permits missing item detail']:[])],
    readCounts:{checks:0,files:0,workspace:0,updates:0},readLog:[] as {kind:string;generation:number;replied:boolean}[]});
}
export type State=ReturnType<typeof fixture>;
export const row=(page:Page,version=ids.version)=>page.locator(`[data-fc-result-version="${version}"]`);
export const detail=(page:Page,version=ids.version)=>row(page,version).locator(`[data-fc-detail="${version}"]`);
export const finding=(page:Page,id:string,version=ids.version)=>row(page,version).locator(`[data-fc-finding-id="${id}"]`);
export const control=(page:Page,mode:'first'|'previous'|'next'|'file',origin?:string,version=ids.version)=>
  origin?finding(page,origin,version).locator(`button[data-fc-manual-mode="${mode}"]`):row(page,version).locator(`button[data-fc-manual-mode="${mode}"]`);
export const manualFindings=(s:State,version=ids.version)=>s.check.result!.files.find(file=>file.file_version_id===version)!.findings.filter(isManual);
export const dialog=(page:Page)=>page.locator('dialog.fc-confirm[open]');
export const currentFile=(page:Page)=>page.locator(`.collection-file[data-file-family="${ids.family}"]`);

export function serverSnapshot(s:State){return structuredClone({source:s.source,check:s.check,checks:s.checks,registry:s.registry,
  batches:s.batches,imports:s.imports,quotes:s.quotes,executions:s.executions,checkRequests:s.checkRequests,
  updatePosts:s.updatePosts,updateReceipts:[...s.updateReceipts],checkReceipts:[...s.checkReceipts],puts:s.puts});}
export function assertFixture(s:State){
  assertOriginals(s);for(const check of s.checks)expect(Value.Check(ProjectFileCheckSchema,check),'Existing public check response schema; defensive projections are labelled separately').toBe(true);
  for(const file of s.registry)expect(Value.Check(ProjectFileVersionSchema,file)).toBe(true);
}
export async function pausedClock(page:Page){const start=new Date('2026-10-25T17:00:00Z');await page.clock.install({time:start});await page.clock.pauseAt(new Date(start.getTime()+1000));}
const installed=new WeakMap<Page,State>();
export async function install(page:Page,s=fixture()){
  assertFixture(s);await installOriginals(page,s);installed.set(page,s);
  await page.route('**/api/v1/**',async intercepted=>{
    const req=intercepted.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length);
    const kind=path===base+'/project-files/checks'?'checks':path===base+'/project-files'?'files':
      path===base+'/project-files/workspace'?'workspace':path===base+'/project-files/updates'?'updates':undefined;
    if(req.method()!=='GET'||!kind)return intercepted.fallback();
    s.calls.push({owner:s.owner,method:'GET',path,search:url.search,body:null});
    const generation=++s.readCounts[kind];if(kind==='checks')s.checkReads++;
    const record={kind,generation,replied:false};s.readLog.push(record);
    const payload=structuredClone(kind==='checks'?{checks:s.checks}:kind==='files'?{files:s.registry}:
      kind==='updates'?{batches:s.batches}:{project_id:ids.root,source:s.source,workspace:s.workspace,files:s.registry,batches:s.batches});
    record.replied=true;return intercepted.fulfill({status:200,json:payload});
  });return s;
}
export async function open(page:Page,s=fixture(),entry:'check'|'files'='check'){
  await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto(entry==='check'?checkRoute():filesRoute());
  await expect(page.locator(entry==='check'?'.fc-results':'#file-list')).toBeVisible();return s;
}
export async function enterFromFiles(page:Page,s=fixture()){
  await open(page,s,'files');const link=currentFile(page).getByRole('link',{name:s.manualOptions.emptyManual?'查看需确认事项':'查看差异 / 更新',exact:true});
  await expect(link).toHaveCount(1);const href=await link.getAttribute('href'),q=new URLSearchParams(href!.split('?')[1]);
  expect(q.get('run')).toBe(checkId);expect(q.get('file')).toBe(ids.family);await link.click();await expect(row(page)).toBeVisible();return s;
}
export async function frames(page:Page){await page.clock.runFor(80);}
export async function expand(page:Page,version=ids.version){if(await detail(page,version).getAttribute('open')===null){await detail(page,version).locator(':scope > summary').focus();await page.keyboard.press('Enter');}await expect(detail(page,version)).toHaveAttribute('open','');}
export async function tick(page:Page,s:State){
  const before={...s.readCounts},previousRow=await row(page).elementHandle();expect(previousRow,'The original public file row exists before the poll').toBeTruthy();await page.clock.runFor(4000);
  for(const kind of ['checks','files','workspace','updates'] as const)await expect.poll(()=>s.readCounts[kind]).toBeGreaterThan(before[kind]);
  await expect.poll(()=>previousRow!.evaluate(node=>node.isConnected),{message:'Browser consumed the native GET quartet and painted a new public row'}).toBe(false);
  await frames(page);
}
/** Observe only public storage calls. No component instance or private state is accessed. */
export async function observeCache(page:Page){await page.evaluate(key=>{
  const w=window as unknown as {manualReadingCacheCalls:{method:string;value:string|null}[]};w.manualReadingCacheCalls=[];
  const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
  Storage.prototype.setItem=function(k:string,v:string){if(this===sessionStorage&&k===key)w.manualReadingCacheCalls.push({method:'setItem',value:v});return set.call(this,k,v);};
  Storage.prototype.removeItem=function(k:string){if(this===sessionStorage&&k===key)w.manualReadingCacheCalls.push({method:'removeItem',value:null});return remove.call(this,k);};
},cacheKey);}
export async function cacheCalls(page:Page){return page.evaluate(()=>(window as unknown as {manualReadingCacheCalls:{method:string;value:string|null}[]}).manualReadingCacheCalls);}
export async function cacheValue(page:Page){return page.evaluate(key=>sessionStorage.getItem(key),cacheKey);}
export async function position(locator:Locator){return locator.evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,scrollY,visible:e.checkVisibility()&&r.bottom>0&&r.top<innerHeight};});}
export async function navigationSnapshot(page:Page,s:State){return {http:s.calls.length,business:serverSnapshot(s),cache:await cacheValue(page),cacheCalls:(await cacheCalls(page)).length,
  selections:await page.locator('[data-fc-select]:checked').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.fcSelect)),summary:await page.locator('#fc-selection').textContent(),url:page.url()};}
export async function assertPureNavigation(page:Page,s:State,before:Awaited<ReturnType<typeof navigationSnapshot>>){
  await frames(page);expect(s.calls.length,'Reading controls issue zero HTTP requests').toBe(before.http);expect(serverSnapshot(s)).toEqual(before.business);
  expect(await cacheValue(page)).toBe(before.cache);expect((await cacheCalls(page)).length,'Reading controls call no business cache setter/remover').toBe(before.cacheCalls);
  expect(await page.locator('[data-fc-select]:checked').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.fcSelect))).toEqual(before.selections);
  expect(await page.locator('#fc-selection').textContent()).toBe(before.summary);expect(page.url()).toBe(before.url);assertFixture(s);
}
export async function download(page:Page,button:Locator){const waiting=page.waitForEvent('download');await button.click();return downloadBytes(await waiting);}
export async function verifyInstalled(page:Page){const s=installed.get(page);if(s)assertFixture(s);}
