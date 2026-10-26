import {expect,type Page,type Route} from '@playwright/test';
import {emptyUpdateDetails,reportingWindow,schemas,sourceProspectusInputGaps,updateDetailsErrors,type SourceProspectus} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {FormatRegistry} from '@sinclair/typebox';
import {createHash} from 'node:crypto';
import type {Dto} from '../src/api';
import {taskPage} from './collection-fixtures';

// Derived from authoring-onboarding.spec.ts's public HTTP fixture (lines 1–197,
// source SHA-256 7ebdb98b4e5f4d5aab8ddab38d40239bf6050b2a7a1e6210ba2b0c678d6e1c2a).
// Independent desktop source-guidance fixture; the original file is unchanged.
// Synthetic DTOs verify UI navigation and submitted snapshots, not parsing,
// model output, storage, worker execution or a real credit ledger.
export const projectId='synthetic-source-guide-project',now='2026-10-25T03:00:00Z';
export const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
FormatRegistry.Set('date-time',value=>value===now);
const emptyMessages={version:1,content_sha256:sha256('bondbuddy:empty-project-messages'),message_ids:[]};
type Material=Dto<'MaterialResponse'>;
type Call={method:string;path:string;search:string;body?:unknown};
type LockedInput={request:Dto<'InputRevisionCreateRequest'>;project:Dto<'ProjectResponse'>;response:Dto<'InputRevisionResponse'>};
export const historicalId='synthetic-guide-historical',referenceId='synthetic-guide-reference',auditId='synthetic-guide-audit';
export function material(id:string,version:number,role:Material['role'],filename:string):Material{return {material_id:id,material_version:version,upload_id:id+'-upload',role,filename,media_type:'application/pdf',byte_size:4096,sha256:sha256(id+'-v'+version),state:'persisted',persisted_at:now,error:null};}
export function sourceDeclaration(m:Material,patch:Partial<SourceProspectus>={}):SourceProspectus{return {material_id:m.material_id,material_version:m.material_version,sha256:m.sha256,issuer_name:null,relation:'same_issuer',market:'sse',offering:'private',
  reporting_periods:[{start:'2023-01-01',end:'2023-12-31',period_kind:'annual',scope:null,status:'needs_confirmation',evidence_refs:[]}],status:'user_asserted',...structuredClone(patch)};}
export function fixture(){
  const materials=[material(historicalId,2,'historical','合成历史募集书_准确原件.pdf'),material(referenceId,4,'reference','合成母公司参考募集书_第四稿.pdf'),material(auditId,3,'audit','合成已保存审计报告.pdf')];
  const project:Dto<'ProjectResponse'>={project_id:projectId,name:'合成原稿信息定位项目',issuer_name:'合成目标发行人有限公司',kind:'update',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now,
    update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-06-30',target_reporting_periods:reportingWindow('sse','private','2026-06-30'),
      source_prospectuses:[sourceDeclaration(materials[1],{relation:'parent',market:null,offering:null,reporting_periods:[]})]}};
  return {project,materials,selectionRevision:5,patches:[] as {body:Dto<'ProjectPatchRequest'>;ifMatch:string|undefined}[],locked:[] as LockedInput[],inputs:new Map<number,Dto<'InputRevisionResponse'>>(),
    preflights:[] as Dto<'PreflightRequest'>[],quotes:[] as Dto<'FixedQuoteRequest'>[],executes:[] as Dto<'ExecuteRequest'>[],runs:new Map<string,Dto<'RunResponse'>>(),quote:null as Dto<'FixedQuoteResponse'>['quote'],
    calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],holdTasks:false,heldTasks:false,releaseTasks:undefined as (()=>void)|undefined};
}
export type State=ReturnType<typeof fixture>;
const installed=new WeakMap<Page,State>();
export const writes=(s:State)=>s.calls.filter(call=>call.method!=='GET');
export function expectNoExecution(s:State){expect(s.locked).toEqual([]);expect(s.preflights).toEqual([]);expect(s.quotes).toEqual([]);expect(s.executes).toEqual([]);}
function checked<K extends keyof typeof schemas>(name:K,value:unknown):asserts value is Dto<K>{expect(Value.Check(schemas[name],value),`${name}: ${JSON.stringify([...Value.Errors(schemas[name],value)])}`).toBe(true);}
async function reply<K extends keyof typeof schemas>(route:Route,name:K,body:Dto<K>,status=200){checked(name,body);await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});}
const errorReply=(route:Route,status:number,code:string)=>route.fulfill({status,json:{code}});
const refs=(s:State)=>s.materials.map(m=>({material_id:m.material_id,material_version:m.material_version}));
function input(revision:number,materials:Dto<'InputRevisionResponse'>['material_versions'],hash=sha256('synthetic-guide-input-'+revision)):Dto<'InputRevisionResponse'>{return {project_id:projectId,input_revision:revision,input_hash:hash,material_versions:structuredClone(materials),
  target_confirmation:{status:'unconfirmed',market:null,offering:null,as_of:null,document_purpose:null,target_reporting_periods:[],confirmed_at:null,confirmed_by:null},rule_pack_version:null,template_version:null,reference_release:null,created_at:now};}
export function addActiveRun(s:State){
  const snapshot=input(1,refs(s));s.inputs.set(1,snapshot);s.project.input_revision=1;s.project.input_hash=snapshot.input_hash;
  const run:Dto<'RunResponse'>={run_id:'synthetic-guide-active-run',execution_request_id:'synthetic-guide-active-execution',project_id:projectId,input_revision:1,input_hash:snapshot.input_hash,state:'running',stage:'model_generation',event_cursor:0,
    channel:'production',test_grant_id:null,uncovered_items:[],billing_mode:'fixed_credits',reservation_id:null,artifact_id:null,prompt_snapshot_ref:null,updated_at:now};
  s.runs.set(run.execution_request_id,run);return run;
}

export async function install(page:Page,s=fixture()){
  expect(updateDetailsErrors(s.project.update_details!),'Initial synthetic project must satisfy cross-field draft validation.').toEqual([]);
  installed.set(page,s);page.on('pageerror',error=>s.errors.push(error.message));
  await page.context().route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
    const body:unknown=request.headers()['content-type']?.includes('application/json')&&request.postData()?request.postDataJSON():undefined;
    s.calls.push({method,path,search:url.search,...(body===undefined?{}:{body:structuredClone(body)})});
    if(method==='GET'&&path==='/me')return reply(route,'MeResponse',{user_id:'synthetic-source-guide-owner',session_status:'active'});
    if(method==='GET'&&path==='/account')return reply(route,'AccountResponse',{user_id:'synthetic-source-guide-owner',username:'synthetic',phone_masked:null,status:'active',created_at:now,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(method==='GET'&&path==='/credits/balance')return reply(route,'CreditBalanceResponse',{enabled:true,available:100000,frozen:0});
    if(method==='GET'&&path==='/m4/topics')return route.fulfill({json:{topics:[]}});
    if(method==='GET'&&path==='/projects')return reply(route,'ProjectListResponse',{items:[{project_id:projectId,name:s.project.name,draft_revision:s.project.draft_revision,updated_at:now,kind:s.project.kind,issuer_name:s.project.issuer_name,market:s.project.market,offering:s.project.offering,latest_run:null,latest_artifact:null}],page:{has_more:false,next_cursor:null}});
    if(path===`/projects/${projectId}`&&method==='PATCH'){
      checked('ProjectPatchRequest',body);const ifMatch=request.headers()['if-match'];s.patches.push({body:structuredClone(body),ifMatch});
      if(ifMatch!==String(s.project.draft_revision))return errorReply(route,409,'DRAFT_REVISION_CONFLICT');
      s.project={...s.project,...structuredClone(body),draft_revision:s.project.draft_revision+1,updated_at:now};return reply(route,'ProjectResponse',s.project);
    }
    if(path===`/projects/${projectId}`&&method==='GET')return reply(route,'ProjectResponse',s.project);
    if(path===`/projects/${projectId}/tasks`&&method==='GET'){
      if(s.holdTasks){s.holdTasks=false;s.heldTasks=true;await new Promise<void>(resolve=>{s.releaseTasks=resolve;});s.heldTasks=false;s.releaseTasks=undefined;}
      return reply(route,'ProjectTasksResponse',taskPage(projectId,[...s.runs.values()],s.project.kind));
    }
    if(path===`/projects/${projectId}/events`&&method==='GET'){
      const after=Number(url.searchParams.get('after')??0);return reply(route,'ProjectEventsResponse',{items:s.materials.map((m,index)=>({event_id:`source-guide-material-${index}`,schema_version:1 as const,trace_id:'synthetic-guide-trace',project_id:projectId,seq:index+1,occurred_at:now,type:'material.upload_progress' as const,payload:{material_id:m.material_id}})).filter(event=>event.seq>after),next_cursor:null});
    }
    if(path===`/projects/${projectId}/messages`&&method==='GET')return reply(route,'ProjectMessagePage',{conversation_id:projectId,items:[],project_message_set_ref:emptyMessages,next_cursor:null,has_more:false});
    if(path===`/projects/${projectId}/prospectus-versions`&&method==='GET'){
      const historical=s.materials.find(m=>m.role==='historical');return reply(route,'ProspectusVersionsResponse',{project_id:projectId,current_version_id:historical?'synthetic-guide-source-version':null,selection_revision:historical?s.selectionRevision:0,inactive_material_ids:[],versions:historical?[{version_id:'synthetic-guide-source-version',sequence:1,origin:'upload',filename:historical.filename,sha256:historical.sha256,created_at:now,material_id:historical.material_id,material_version:historical.material_version,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}]:[]});
    }
    const material=s.materials.find(m=>path===`/projects/${projectId}/materials/${m.material_id}`);
    if(material&&method==='GET')return !url.searchParams.has('version')||Number(url.searchParams.get('version'))===material.material_version?reply(route,'MaterialResponse',material):errorReply(route,404,'NOT_FOUND');
    if(method==='GET'&&s.materials.some(m=>path===`/projects/${projectId}/materials/${m.material_id}/parse-job`))return errorReply(route,404,'NOT_FOUND');
    if(path===`/projects/${projectId}/input-revisions`&&method==='POST'){
      checked('InputRevisionCreateRequest',body);expect(body.draft_revision).toBe(s.project.draft_revision);expect(body.prospectus_selection_revision).toBe(s.materials.some(m=>m.role==='historical')?s.selectionRevision:0);
      const order=(values:{material_id:string;material_version:number}[])=>[...values].sort((a,b)=>a.material_id.localeCompare(b.material_id));expect(order(body.material_versions)).toEqual(order(refs(s)));expect(body.project_message_set_ref).toEqual(emptyMessages);expect(body.requirement_message_ids).toEqual([]);
      expect(sourceProspectusInputGaps(s.materials,s.project.update_details?.source_prospectuses)).toEqual([]);
      const revision=Math.max(0,...s.inputs.keys())+1,response=input(revision,body.material_versions,sha256(JSON.stringify(body)));s.inputs.set(revision,response);s.locked.push({request:structuredClone(body),project:structuredClone(s.project),response:structuredClone(response)});
      s.project.input_revision=revision;s.project.input_hash=response.input_hash;return reply(route,'InputRevisionResponse',response,201);
    }
    const revision=path.match(new RegExp(`^/projects/${projectId}/input-revisions/(\\d+)$`));if(revision&&method==='GET'){const snapshot=s.inputs.get(Number(revision[1]));return snapshot?reply(route,'InputRevisionResponse',snapshot):errorReply(route,404,'NOT_FOUND');}
    if(path===`/projects/${projectId}/preflight`&&method==='POST'){
      checked('PreflightRequest',body);s.preflights.push(structuredClone(body));const snapshot=s.locked.at(-1)!.response;expect(body).toEqual({input_revision:snapshot.input_revision,input_hash:snapshot.input_hash});return reply(route,'PreflightResponse',{project_id:projectId,...body,status:'ready',missing_inputs:[],blocking_inputs:[],advisory_inputs:[],uncertainty:[],billing_mode:'fixed_credits'});
    }
    if(path===`/projects/${projectId}/credit-quote`&&method==='POST'){
      checked('FixedQuoteRequest',body);s.quotes.push(structuredClone(body));expect(body).toEqual(s.preflights.at(-1));s.quote={quote_id:'synthetic-source-guide-quote',project_id:projectId,...body,task_type:'interim',points:17900,price_version:'synthetic-v1',reason:'合成一期编制',created_at:now};
      return reply(route,'FixedQuoteResponse',{enabled:true,quote:s.quote,balance:{available:100000,frozen:0},shortage:0,reason:null});
    }
    if(path==='/runs/execute'&&method==='POST'){
      checked('ExecuteRequest',body);s.executes.push(structuredClone(body));const snapshot=s.locked.at(-1)!.response;expect(body.project_id).toBe(projectId);expect(body.input_revision).toBe(snapshot.input_revision);expect(body.input_hash).toBe(snapshot.input_hash);expect(body.quote_id).toBe(s.quote!.quote_id);
      let run=s.runs.get(body.execution_request_id);if(!run){run={run_id:'synthetic-source-guide-run',execution_request_id:body.execution_request_id,project_id:projectId,input_revision:body.input_revision,input_hash:body.input_hash,state:'queued',stage:'queued',event_cursor:0,channel:'production',test_grant_id:null,uncovered_items:[],billing_mode:'fixed_credits',reservation_id:null,artifact_id:null,prompt_snapshot_ref:null,updated_at:now};s.runs.set(body.execution_request_id,run);}return reply(route,'RunResponse',run,202);
    }
    const run=[...s.runs.values()].find(value=>path===`/runs/${value.run_id}`||path.startsWith(`/runs/${value.run_id}/`));
    if(run&&method==='GET'){
      if(path===`/runs/${run.run_id}/events`)return reply(route,'RunEventsResponse',{items:[],next_cursor:null});
      if(path===`/runs/${run.run_id}/credit-charge`)return reply(route,'RunCreditChargeResponse',{quote:s.quote,state:s.quote?'held':null});
      if(path===`/runs/${run.run_id}/stream`)return route.fulfill({contentType:'text/event-stream',body:': synthetic polling fallback\n\n'});
      if(path===`/runs/${run.run_id}`)return reply(route,'RunResponse',run);
    }
    s.unexpected.push(`${method} ${path}`);return errorReply(route,501,'UNEXPECTED_SYNTHETIC_REQUEST');
  });return s;
}
export async function assertFixture(page:Page){const s=installed.get(page);if(!s)return;expect(s.unexpected,'Only explicitly allowed synthetic endpoints may run.').toEqual([]);expect(s.errors,'No unhandled browser errors.').toEqual([]);}
