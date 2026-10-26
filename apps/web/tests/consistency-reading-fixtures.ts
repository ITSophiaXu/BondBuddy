import {expect,type Page} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,ProjectFileSourceSchema,ProjectFileVersionSchema,PROJECT_FILE_UPDATE_PRICE,schemas,type ProjectFileFinding} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {fixture as selectionFixture,install as installSelection,assertFixture as assertSelection,
  ids,base,cacheKey,fileIds,checkId,routeFor as selectionRoute,changeSource,writes,serverSnapshot} from './consistency-selection-fixtures';
import {now,seedCache,hash} from './consistency-task-fixtures';

export {ids,base,cacheKey,fileIds,checkId,writes,serverSnapshot};
export const patchRun='consistency-reading-running-issuer-patch';
export const batchId='consistency-reading-running-batch';
export type ReadKind='checks'|'files'|'workspace'|'updates';
export function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
type Read={kind:ReadKind;generation:number;order:number;state:string;source:string|null;fileCount:number;replied:boolean;failed:boolean};
type HeldRead={kind:ReadKind;generation:number;arrived:ReturnType<typeof gate>;held:ReturnType<typeof gate>};

// Extend the existing owner-scoped, schema-checked HTTP producer. A completed
// check remains readable while an actual accepted patch/batch is running. The
// financial findings are outside that running update, so reading never executes
// the row being observed. All text and all HTTP state are explicitly synthetic.
export function fixture(options:{active?:boolean;long?:boolean}={}){
  const s=selectionFixture({long:true}),check=s.checks[0];s.rootProject.name='合成长检查结果阅读项目';
  for(const result of check.result!.files){
    if(![fileIds.issuer,fileIds.financial,fileIds.credit].includes(result.file_version_id))continue;
    const first=structuredClone(result.findings[0]),count=options.long===false?2:result.file_version_id===fileIds.financial?10:6;
    const longText=(label:string,index:number)=>`合成阅读诊断第${index+1}项，${label}。`+Array.from({length:8},(_,n)=>`合成第${n+1}段：同一报告期、相同单位的披露数值和上下文需要逐项核对；此段只用于稳定长结果阅读位置。`).join('');
    result.findings=Array.from({length:count},(_,index):ProjectFileFinding=>{
      const id='consistency-reading-'+result.file_version_id+'-'+index;
      return {...structuredClone(first),id,target_span_id:id+'-target',source_span_id:first.kind==='manual'?null:id+'-source',
        field:`合成阅读字段${index+1}`,original:longText('关联文件原文',index),source_quote:first.kind==='manual'?'':longText('固定募集书依据',index),
        reason:longText('本轮差异说明',index),replacement:first.replacement===null?null:longText('建议更新内容',index)};
    });
    if(result.file_version_id===fileIds.issuer){const manual=structuredClone(check.result!.files.find(f=>f.file_version_id===fileIds.credit)!.findings[0]);manual.id='consistency-reading-issuer-manual';manual.target_span_id=manual.id+'-target';result.findings.push(manual);}
    s.files.find(f=>f.version_id===result.file_version_id)!.consistency.count=result.findings.filter(f=>f.kind==='conflict'&&f.replacement!==null).length;
  }
  if(options.active!==false){
    const input=check.files.find(f=>f.file_version_id===fileIds.issuer)!;
    check.updates=[{file_version_id:input.file_version_id,issue_ids:check.result!.files.find(f=>f.file_version_id===input.file_version_id)!.findings.filter(f=>f.kind==='conflict'&&f.replacement!==null).map(f=>f.id),run_id:patchRun,state:'running',new_version_id:null}];
    s.tasks.unshift({...structuredClone(s.tasks[0]),run_id:patchRun,state:'running',stage:'file_patch',operation:'file_patch',artifact_id:null,document_type:'issuer',created_at:now,updated_at:now});
    s.batches=[{batch_id:batchId,state:'running',items:[{file_version_id:input.file_version_id,filename:input.filename,run_id:patchRun,error:null}]}];
  }
  return Object.assign(s,{reads:[] as Read[],readCounts:{checks:0,files:0,workspace:0,updates:0} as Record<ReadKind,number>,heldRead:undefined as HeldRead|undefined,failRead:undefined as {kind:ReadKind;generation:number}|undefined,allowPause:false});
}
export type State=ReturnType<typeof fixture>;
export const routeFor=(file?:string)=>selectionRoute()+(file?'&file='+encodeURIComponent(file):'');
export const resultRow=(page:Page,version=fileIds.financial)=>page.locator('[data-fc-result-version="'+version+'"]');
export const detail=(page:Page,version=fileIds.financial)=>page.locator('[data-fc-detail="'+version+'"]');
export const finding=(page:Page,version=fileIds.financial,index=4)=>resultRow(page,version).locator('.fc-finding').nth(index);
export async function seedSelection(page:Page,s:State,versions:string[]=[fileIds.financial],filter='all'){
  for(const version of versions)expect(s.checks[0].files.some(f=>f.file_version_id===version)).toBe(true);
  // Restore an earlier explicit selection rather than trying to newly select a
  // file while the legitimate project-wide active-batch guard disables inputs.
  await seedCache(page,{owner:ids.owner,project:ids.root,selectionCheck:checkId,chosen:versions,filter});
}
export async function seedUnknownUpdate(page:Page,s:State){
  const check=s.checks.find(c=>c.run_id===checkId)!,version=fileIds.financial;
  const pending={checkId,body:{request_id:'consistency-reading-original-unknown-request',expected_check_sha256:check.sha256!,price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:PROJECT_FILE_UPDATE_PRICE.points,files:[{file_version_id:version}]} satisfies Dto<'ProjectFileUpdateRequest'>,filenames:[check.files.find(f=>f.file_version_id===version)!.filename],attempted:true as const};
  const original={checkId,body:structuredClone(pending.body)},receiptBatch='consistency-reading-existing-unknown-batch';
  // This is an already persisted server receipt whose acknowledgement the
  // restored browser has not confirmed. Only explicit retry may POST it again.
  s.receipts.set(pending.body.request_id,{post:original,batchId:receiptBatch});
  s.batches.push({batch_id:receiptBatch,state:'queued',items:[{file_version_id:version,filename:pending.filenames[0],run_id:null,error:null}]});
  await seedCache(page,{owner:ids.owner,project:ids.root,selectionCheck:checkId,chosen:[version],filter:'all',pendingUpdate:pending});return pending;
}
export function addHistoricalCheck(s:State){
  const original=s.checks.find(c=>c.run_id===checkId)!,older=structuredClone(original),id='consistency-reading-older-check';
  older.run_id=id;older.sha256=hash(id);older.created_at='2026-10-25T10:00:00Z';older.updates=[];s.checks.push(older);
  const checkTask=s.tasks.find(t=>t.run_id===checkId)!;s.tasks.push({...structuredClone(checkTask),run_id:id,artifact_id:id+'-report',created_at:older.created_at,updated_at:older.created_at});return older;
}
export function holdNextRead(s:State,kind:ReadKind='checks'){
  const held={kind,generation:s.readCounts[kind]+1,arrived:gate(),held:gate()};s.heldRead=held;
  return {arrived:held.arrived.promise,release:held.held.release,generation:held.generation};
}
export function failNextRead(s:State,kind:ReadKind='checks'){s.failRead={kind,generation:s.readCounts[kind]+1};}
export function changeCurrentSource(s:State){changeSource(s);}
export function stopActive(s:State){for(const check of s.checks)for(const update of check.updates)if(update.run_id===patchRun)update.state='failed';for(const task of s.tasks)if(task.run_id===patchRun){task.state='failed';task.stage='failed';}s.batches=[];}
function assertData(s:State){
  for(const c of s.checks){expect(Value.Check(ProjectFileCheckSchema,c),'Existing public check response schema').toBe(true);
    if(c.result)expect(c.result.files.map(f=>f.file_version_id)).toEqual(c.files.map(f=>f.file_version_id));
    for(const update of c.updates){expect(c.files.some(f=>f.file_version_id===update.file_version_id)).toBe(true);expect(s.tasks.some(t=>t.run_id===update.run_id&&t.state===update.state)).toBe(true);}}
  for(const file of s.files)expect(Value.Check(ProjectFileVersionSchema,file),'Existing public file version schema').toBe(true);
  expect(Value.Check(ProjectFileSourceSchema,s.source),'Existing public source response schema').toBe(true);
  for(const batch of s.batches)for(const item of batch.items){expect(s.files.some(f=>f.version_id===item.file_version_id&&f.filename===item.filename)).toBe(true);if(item.run_id)expect(s.checks.some(c=>c.updates.some(u=>u.run_id===item.run_id&&u.file_version_id===item.file_version_id))).toBe(true);}
}
const installed=new WeakMap<Page,State>();
export async function install(page:Page,s=fixture()){
  assertData(s);await installSelection(page,s);installed.set(page,s);
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length);
    if(req.method()==='POST'&&path===`/runs/${patchRun}/pause`&&s.allowPause){
      const body=req.postDataJSON();s.calls.push({method:'POST',path,search:url.search,body:structuredClone(body)});
      try{
        expect(Value.Check(schemas.RunActionRequest,body),'Existing explicit run action request schema').toBe(true);expect(body).toEqual({reason:'user_paused'});
        const task=s.tasks.find(t=>t.run_id===patchRun)!;expect(task.state).toBe('running');task.state='paused';task.stage='paused';
        for(const check of s.checks)for(const update of check.updates)if(update.run_id===patchRun)update.state='paused';s.runActions.push({run:patchRun,action:'pause',body:structuredClone(body)});
        const result:Dto<'RunResponse'>={run_id:patchRun,execution_request_id:'prior-'+patchRun,project_id:ids.root,input_revision:4,input_hash:hash(patchRun),state:'paused',stage:'paused',event_cursor:0,channel:'production',test_grant_id:null,uncovered_items:[],billing_mode:'fixed_credits',reservation_id:null,artifact_id:null,prompt_snapshot_ref:null,updated_at:now};
        expect(Value.Check(schemas.RunResponse,result),'Existing explicit run action response schema').toBe(true);return route.fulfill({status:200,json:result});
      }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return route.fulfill({status:500,json:{code:'DATA_UNAVAILABLE',message:'Synthetic explicit pause failed',retryable:true,correlation_id:'consistency-reading',field_errors:[]}});}
    }
    const kind:ReadKind|undefined=path===base+'/checks'?'checks':path===base?'files':path===base+'/workspace'?'workspace':path===base+'/updates'?'updates':undefined;
    if(req.method()!=='GET'||!kind)return route.fallback();
    s.calls.push({method:'GET',path,search:url.search,body:null});
    try{
      assertData(s);const generation=++s.readCounts[kind];if(kind==='checks')s.checkReads++;
      // Capture at arrival, before waiting. A released response must not silently
      // acquire newer server state and turn a stale-response journey into a lie.
      const payload=structuredClone(kind==='checks'?{checks:s.checks}:kind==='files'?{files:s.files}:kind==='updates'?{batches:s.batches}:{project_id:ids.root,source:s.source,workspace:s.workspace,files:s.files,batches:[]});
      const record:Read={kind,generation,order:s.reads.length,state:s.checks[0]?.state??'missing',source:s.source?.version_id??null,fileCount:s.files.length,replied:false,failed:false};s.reads.push(record);
      const held=s.heldRead;if(held&&held.kind===kind&&held.generation===generation){held.arrived.release();await held.held.promise;}
      const failure=s.failRead;if(failure&&failure.kind===kind&&failure.generation===generation){s.failRead=undefined;record.failed=true;record.replied=true;return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',message:'Synthetic scheduled reading refresh failure',retryable:true,correlation_id:'consistency-reading',field_errors:[]}});}
      record.replied=true;return route.fulfill({status:200,json:payload});
    }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return route.fulfill({status:500,json:{code:'DATA_UNAVAILABLE',message:'Synthetic reading fixture assertion failed',retryable:true,correlation_id:'consistency-reading',field_errors:[]}});}
  });return s;
}
export async function open(page:Page,s=fixture(),file?:string){await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto(routeFor(file));await expect(page.locator('.fc-results')).toBeVisible();return s;}
export async function openUpdate(page:Page,s=fixture()){await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto(routeFor()+'&update_run='+patchRun);await expect(page.locator('#fc-update-task')).toHaveAttribute('data-fc-update-run',patchRun);return s;}
export async function assertFixture(page:Page){await assertSelection(page);const s=installed.get(page);if(s)assertData(s);}
export function assertReadOnly(s:State){expect(writes(s),'Passive reading and scheduled refresh create no business writes').toEqual([]);}
export async function pausedClock(page:Page){const start=new Date('2026-10-25T16:00:00Z');await page.clock.install({time:start});await page.clock.pauseAt(new Date(start.getTime()+1000));}
