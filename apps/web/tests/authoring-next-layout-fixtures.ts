import {expect,type Page,type Route} from '@playwright/test';
import {schemas} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {createHash} from 'node:crypto';
import type {Dto} from '../src/api';
import {taskPage} from './collection-fixtures';
import {fixture as handoffFixture,install as installHandoff,assertFixture as assertHandoff,ids,artifactId,oldTime,newTime} from './result-handoff-authoring-fixtures';
export {ids,artifactId,oldTime,newTime,downloadBytes} from './result-handoff-authoring-fixtures';

// Extend the existing validated historical Word pair and public routes. Added
// routes model only next-input receipts and task controls, not workers/billing.
export const nextTime='2026-10-26T04:00:00Z',failedRunId='authoring-next-layout-failed-run';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const terminal=new Set(['succeeded','test_completed','failed','cancelled','rejected']);
const emptyMessages={version:1,content_sha256:hash('bondbuddy:empty-project-messages'),message_ids:[]};
export type Gate={entered:boolean;released:boolean;wait:Promise<void>;release:()=>void};
export function gate():Gate{let resolve!:()=>void;const result:Gate={entered:false,released:false,wait:new Promise<void>(done=>resolve=done),release:()=>{result.released=true;resolve();}};return result;}
export function fixture(options:{failed?:boolean}={}){
 const base=handoffFixture();base.allowPatch=true;
 // These are page metadata notes only. The original minimal Word bytes and their
 // hashes remain unchanged; the fixture does not claim Word contains these notes.
 const notes=['# 合成第2轮编制说明','## 需要补充或确认的事项',...Array.from({length:10},(_,index)=>'### 合成待核事项 '+(index+1)+'\n\n本段是用于长成果页面的合成说明。已保存的原始材料与本轮工作稿仍需人工逐项核对，部分期间、统计口径、金额单位与相关附注缺少充分证据，不能据此认定更新内容已经完成专业审查。应取得对应原始依据后，再核验原披露、对照内容、差异影响及需要保留的限定条件；尚未完成的公开信息核验也不能解释为没有风险。下一轮补充材料与要求只影响新输入，既有任务和已保存文件保持原有版本。')];
 for(const variant of ['clean','revision'] as const)base.artifacts.get(artifactId(2,variant))!.metadata.word_delivery!.authoring_summary=[...notes];
 const state=Object.assign(base,{metadataGate:undefined as {id:string;gate:Gate}|undefined,versionsGate:undefined as Gate|undefined,tasksGate:undefined as Gate|undefined,waitingGates:new Set<Gate>(),
  inputAttempts:[] as Dto<'InputRevisionCreateRequest'>[],locked:[] as {request:Dto<'InputRevisionCreateRequest'>;projectSnapshot:Dto<'ProjectResponse'>;response:Dto<'InputRevisionResponse'>}[],
  preflights:[] as Dto<'PreflightRequest'>[],quotes:[] as Dto<'FixedQuoteRequest'>[],executions:[] as Dto<'ExecuteRequest'>[],
  quote:undefined as NonNullable<Dto<'FixedQuoteResponse'>['quote']>|undefined,receipts:new Map<string,{body:Dto<'ExecuteRequest'>;run:Dto<'RunResponse'>}>(),
  runActions:[] as {run_id:string;action:string}[],dropExecute:undefined as 'before'|'after'|undefined,versionReads:0});
 if(options.failed){const prior=structuredClone(state.inputs.get(3)!);const input={...prior,input_revision:4,input_hash:hash('failed-input-4'),created_at:'2026-10-26T01:00:00Z'};state.inputs.set(4,input);
  const run:Dto<'RunResponse'>={...structuredClone(state.runs.get(ids.newRun)!),run_id:failedRunId,execution_request_id:'failed-execution-4',input_revision:4,input_hash:input.input_hash,state:'failed',stage:'failed',artifact_id:null,updated_at:input.created_at};state.runs.set(run.run_id,run);state.project.input_revision=4;state.project.input_hash=input.input_hash;}
 return state;
}
export type State=ReturnType<typeof fixture>;
const installed=new WeakMap<Page,State>();
async function waitForGate(state:State,waiting:Gate){state.waitingGates.add(waiting);waiting.entered=true;try{await waiting.wait;}finally{state.waitingGates.delete(waiting);}}
function checked<K extends keyof typeof schemas>(name:K,value:unknown):asserts value is Dto<K>{expect(Value.Check(schemas[name],value),name+': '+JSON.stringify([...Value.Errors(schemas[name],value)])).toBe(true);}
function dto<K extends keyof typeof schemas>(route:Route,name:K,value:Dto<K>,status=200){checked(name,value);return route.fulfill({status,json:value});}
const problem=(route:Route,status:number,code:string)=>route.fulfill({status,json:{code,message:'Synthetic '+code,retryable:status>=500,field_errors:[],correlation_id:'authoring-next-layout'}});
export const writes=(state:State)=>state.calls.filter(call=>call.method!=='GET');
export function oldSnapshot(state:State){const run=state.runs.get(ids.oldRun)!;return structuredClone({input:state.inputs.get(run.input_revision),run,artifacts:[...state.artifacts].filter(([,value])=>value.metadata.run_id===run.run_id).map(([id,value])=>({id,metadata:value.metadata,bytes_sha256:createHash('sha256').update(value.bytes).digest('hex')}))});}
export const selectedPin=(state:State,round:2|3)=>{const saved=state.artifacts.get(artifactId(round,'clean'))!.metadata;return {artifact_id:saved.artifact_id,artifact_version:saved.version,sha256:saved.sha256};};
export async function install(page:Page,state=fixture()){
 installed.set(page,state);
 await installHandoff(page,state);
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length),method=req.method(),base='/projects/'+ids.project;
  const metadata=path.match(/^\/artifacts\/([^/]+)$/),held=state.metadataGate;
  if(method==='GET'&&metadata&&held?.id===metadata[1]){state.metadataGate=undefined;await waitForGate(state,held.gate);return route.fallback();}
  const action=path.match(/^\/runs\/([^/]+)\/(pause|resume|cancel)$/),charge=path.match(/^\/runs\/([^/]+)\/credit-charge$/);
  const handled=method==='GET'&&['/projects',base+'/tasks',base+'/prospectus-versions'].includes(path)||method==='POST'&&[base+'/input-revisions',base+'/preflight',base+'/credit-quote','/runs/execute'].includes(path)||method==='POST'&&!!action||method==='GET'&&!!charge&&state.receipts.size>0;
  if(!handled)return route.fallback();
  try{
   const body:unknown=req.postData()?req.postDataJSON():null;state.calls.push({method,path,body:structuredClone(body)});
   if(method==='GET'&&path==='/projects'){const sorted=[...state.runs.values()].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at)),latest=sorted[0],successful=sorted.find(run=>run.state==='succeeded'&&run.artifact_id&&state.artifacts.has(run.artifact_id)),artifact=successful?.artifact_id?state.artifacts.get(successful.artifact_id):undefined;return dto(route,'ProjectListResponse',{items:[{project_id:ids.project,name:state.project.name,kind:state.project.kind,issuer_name:state.project.issuer_name,market:state.project.market,offering:state.project.offering,draft_revision:state.project.draft_revision,updated_at:state.project.updated_at,latest_run:latest?{run_id:latest.run_id,state:latest.state,updated_at:latest.updated_at}:null,latest_artifact:artifact?{artifact_id:artifact.metadata.artifact_id,run_id:artifact.metadata.run_id,version:artifact.metadata.version,created_at:successful!.updated_at}:null}],page:{has_more:false,next_cursor:null}});}
   if(method==='GET'&&path===base+'/tasks'){const runs=[...state.runs.values()].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at));expect(runs.filter(run=>!terminal.has(run.state)).length).toBeLessThanOrEqual(1);const response=taskPage(ids.project,runs),waiting=state.tasksGate;if(waiting){state.tasksGate=undefined;await waitForGate(state,waiting);}return dto(route,'ProjectTasksResponse',response);}
   if(method==='GET'&&path===base+'/prospectus-versions'){state.versionReads++;const response=structuredClone(state.versions),waiting=state.versionsGate;if(waiting){state.versionsGate=undefined;await waitForGate(state,waiting);}return dto(route,'ProspectusVersionsResponse',response);}
   if(method==='POST'&&path===base+'/input-revisions'){
    checked('InputRevisionCreateRequest',body);state.inputAttempts.push(structuredClone(body));
    if(body.draft_revision!==state.project.draft_revision||body.prospectus_selection_revision!==state.versions.selection_revision)return problem(route,409,'INPUT_REVISION_CONFLICT');
    expect([...state.runs.values()].every(run=>terminal.has(run.state))).toBe(true);expect(body).toHaveProperty('edit_base');expect(body.project_message_set_ref).toEqual(emptyMessages);expect(body.requirement_message_ids).toEqual([]);
    expect([...body.material_versions].sort((a,b)=>a.material_id.localeCompare(b.material_id))).toEqual(state.materials.filter(material=>!state.versions.inactive_material_ids.includes(material.material_id)).map(material=>({material_id:material.material_id,material_version:material.material_version})).sort((a,b)=>a.material_id.localeCompare(b.material_id)));
    if(body.edit_base)expect(state.versions.versions.some(version=>version.origin==='generated'&&version.artifact_id===body.edit_base!.artifact_id&&version.artifact_version===body.edit_base!.artifact_version&&version.sha256===body.edit_base!.sha256)).toBe(true);
    const revision=Math.max(...state.inputs.keys())+1,response:Dto<'InputRevisionResponse'>={...structuredClone(state.inputs.get(3)!),input_revision:revision,input_hash:hash(JSON.stringify({revision,body})),material_versions:structuredClone(body.material_versions),created_at:nextTime};
    state.locked.push({request:structuredClone(body),projectSnapshot:structuredClone(state.project),response:structuredClone(response)});state.inputs.set(revision,response);state.project.input_revision=revision;state.project.input_hash=response.input_hash;state.project.updated_at=nextTime;return dto(route,'InputRevisionResponse',response,201);
   }
   if(method==='POST'&&path===base+'/preflight'){checked('PreflightRequest',body);state.preflights.push(structuredClone(body));const input=state.locked.at(-1)!.response;expect(body).toEqual({input_revision:input.input_revision,input_hash:input.input_hash});return dto(route,'PreflightResponse',{project_id:ids.project,...body,status:'ready',missing_inputs:[],uncertainty:[],blocking_inputs:[],advisory_inputs:[],billing_mode:'fixed_credits'});}
   if(method==='POST'&&path===base+'/credit-quote'){checked('FixedQuoteRequest',body);state.quotes.push(structuredClone(body));expect(body).toEqual(state.preflights.at(-1));state.quote={quote_id:'authoring-next-layout-quote-'+body.input_revision,project_id:ids.project,...body,task_type:'annual',points:17900,price_version:'synthetic-next-layout-v1',reason:'合成编制续轮',created_at:nextTime};return dto(route,'FixedQuoteResponse',{enabled:true,quote:state.quote,balance:{available:100000,frozen:0},shortage:0,reason:null});}
   if(method==='POST'&&path==='/runs/execute'){
    checked('ExecuteRequest',body);state.executions.push(structuredClone(body));const input=state.locked.at(-1)!.response;expect(body.project_id).toBe(ids.project);expect(body.workspace_id).toBe(ids.project);expect(body.task_kind).toBe('update');expect(body.input_revision).toBe(input.input_revision);expect(body.input_hash).toBe(input.input_hash);expect(body.input_manifest_ref).toBe(input.input_hash);expect(body.quote_id).toBe(state.quote!.quote_id);
    const drop=state.dropExecute;state.dropExecute=undefined;if(drop==='before')return route.abort('connectionreset');
    let receipt=state.receipts.get(body.execution_request_id);if(receipt)expect(body).toEqual(receipt.body);else{expect([...state.runs.values()].every(run=>terminal.has(run.state))).toBe(true);const run:Dto<'RunResponse'>={...structuredClone(state.runs.get(ids.newRun)!),run_id:'authoring-next-layout-run-'+input.input_revision,execution_request_id:body.execution_request_id,input_revision:input.input_revision,input_hash:input.input_hash,state:'queued',stage:'queued',artifact_id:null,billing_mode:'fixed_credits',updated_at:nextTime};receipt={body:structuredClone(body),run};state.receipts.set(body.execution_request_id,receipt);state.runs.set(run.run_id,run);}
    if(drop==='after')return route.abort('connectionreset');return dto(route,'RunResponse',receipt.run,202);
   }
   if(method==='GET'&&charge){const run=state.runs.get(charge[1])!;return dto(route,'RunCreditChargeResponse',{quote:run?.billing_mode==='fixed_credits'?state.quote??null:null,state:run?.billing_mode==='fixed_credits'?(run.state==='cancelled'?'released':'held'):null});}
   if(method==='POST'&&action){const run=state.runs.get(action[1]);if(!run)return problem(route,404,'NOT_FOUND');expect(!terminal.has(run.state)).toBe(true);expect(body).toEqual({reason:action[2]==='cancel'?'user_cancelled':action[2]==='pause'?'user_paused':'user_resumed'});state.runActions.push({run_id:run.run_id,action:action[2]});run.state=action[2]==='cancel'?'cancelled':action[2]==='pause'?'paused':'queued';run.stage=action[2]==='cancel'?'cancelled':action[2]==='pause'?'user_paused':'queued';return dto(route,'RunResponse',run);}
   throw new Error('Unhandled extended route '+method+' '+path);
  }catch(cause){state.errors.push(cause instanceof Error?cause.message:String(cause));return problem(route,500,'DATA_UNAVAILABLE');}
 });return state;
}
export function routeFor(run=ids.oldRun){return '/#/projects/'+ids.project+'?step=materials&run='+run+'&from=projects';}
export async function open(page:Page,state=fixture(),run=ids.oldRun){await page.setViewportSize({width:1440,height:960});await install(page,state);await page.goto(routeFor(run));await expect(page.locator('#prepare-next-version')).toBeVisible();await expect(page.locator('#workspace-material-count')).toContainText('2');return state;}
export async function prepare(page:Page){await page.locator('#prepare-next-version').click();await expect(page.locator('[data-next-authoring-summary]')).toBeVisible();await expect(page.locator('#execute-input')).toBeEnabled();}
export async function assertFixture(page:Page){const state=installed.get(page);for(const waiting of state?.waitingGates??[])waiting.release();await assertHandoff(page);}
