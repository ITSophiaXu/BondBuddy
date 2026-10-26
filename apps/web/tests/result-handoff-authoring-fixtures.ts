import {expect,type Page,type Route} from '@playwright/test';
import {FormatRegistry} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {emptyUpdateDetails,schemas} from '@bondbuddy/contracts';
import {createHash} from 'node:crypto';
import type {Dto} from '../src/api';
import {taskPage} from './collection-fixtures';
import {docx,downloadBytes} from './word-roundtrip-fixtures';
export {downloadBytes};

// Closed public HTTP projections and minimal stored OOXML. No model, worker,
// ledger, database or Word application is exercised by this browser fixture.
export const ids={owner:'result-handoff-authoring-owner',project:'result-handoff-authoring-project',oldRun:'result-handoff-authoring-old-run',newRun:'result-handoff-authoring-new-run',source:'result-handoff-authoring-source',audit:'result-handoff-authoring-audit'};
export const oldTime='2026-10-24T02:00:00Z',newTime='2026-10-25T03:00:00Z';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
FormatRegistry.Set('date-time',value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)&&Number.isFinite(Date.parse(value)));
type Stored={metadata:Dto<'ArtifactResponse'>;bytes:Buffer};
type Call={method:string;path:string;body:unknown};
export type Variant='clean'|'revision';
export const artifactId=(round:2|3,variant:Variant)=>`result-handoff-authoring-${round}-${variant}`;

function input(revision:number,materials:Dto<'MaterialResponse'>[]):Dto<'InputRevisionResponse'>{return {project_id:ids.project,input_revision:revision,input_hash:hash('input-'+revision),
  material_versions:materials.map(m=>({material_id:m.material_id,material_version:m.material_version})),target_confirmation:{status:'unconfirmed',market:null,offering:null,as_of:null,document_purpose:null,target_reporting_periods:[],confirmed_at:null,confirmed_by:null},rule_pack_version:null,template_version:null,reference_release:null,created_at:revision===2?oldTime:newTime};}
function run(round:2|3):Dto<'RunResponse'>{return {run_id:round===2?ids.oldRun:ids.newRun,execution_request_id:'execution-'+round,project_id:ids.project,input_revision:round,input_hash:hash('input-'+round),channel:'production',test_grant_id:null,uncovered_items:[],state:'succeeded',stage:'completed',event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:artifactId(round,'revision'),prompt_snapshot_ref:null,updated_at:round===2?oldTime:newTime};}

export function fixture(){
  const materials:Dto<'MaterialResponse'>[]=[{material_id:ids.source,material_version:1,upload_id:'result-handoff-source-upload',role:'historical',filename:'合成原始募集书.pdf',media_type:'application/pdf',byte_size:100,sha256:hash('source'),state:'persisted',persisted_at:oldTime,error:null},
    {material_id:ids.audit,material_version:1,upload_id:'result-handoff-audit-upload',role:'audit',filename:'合成审计报告.pdf',media_type:'application/pdf',byte_size:100,sha256:hash('audit'),state:'persisted',persisted_at:oldTime,error:null}];
  const project:Dto<'ProjectResponse'>={project_id:ids.project,name:'合成历史募集书找稿项目',kind:'update',issuer_name:'合成债券发行人有限公司',market:'sse',offering:'private',draft_revision:10,input_revision:3,input_hash:hash('input-3'),updated_at:newTime,
    update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',has_historical:true,reporting_cutoff:'2025-12-31',target_reporting_periods:[{start:'2024-01-01',end:'2024-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]},{start:'2025-01-01',end:'2025-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]}],
      source_prospectuses:[{material_id:ids.source,material_version:1,sha256:materials[0].sha256,issuer_name:'合成债券发行人有限公司',relation:'same_issuer',market:'sse',offering:'private',status:'user_asserted',reporting_periods:[{start:'2023-01-01',end:'2023-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]}]}]}};
  const runs=new Map([run(2),run(3)].map(r=>[r.run_id,r])),artifacts=new Map<string,Stored>();
  for(const round of [2,3] as const)for(const variant of ['clean','revision'] as const){
    const id=artifactId(round,variant),bytes=docx(`合成第${round}轮${variant==='clean'?'清洁版':'修订版'}。本文件仅为历史任务准确字节的测试材料。`);
    artifacts.set(id,{bytes,metadata:{artifact_id:id,run_id:round===2?ids.oldRun:ids.newRun,version:round+5,display_version:round,filename:`合成原项目_募集书${variant==='clean'?'清洁版':'修订版'}_V${round}_202610${round===2?'24':'25'}.docx`,media_type:mime,sha256:hash(bytes),quality_status:'passed',delivery_status:'available',download_url:`/api/v1/artifacts/${id}/download?grant=synthetic-authoring`,expires_at:'2099-01-01T00:00:00Z',
      word_delivery:{variant,revision_artifact_id:artifactId(round,'revision'),clean_artifact_id:artifactId(round,'clean'),writer_version:'bondbuddy-unified-word-1.0.0',source_sha256:materials[0].sha256,baseline_hash:null,effective_baseline_sha256:null,plan_hash:null,delivery_policy:'generated_pair_v1',content_review:'not_performed',baseline_kind:'uploaded_source',source_issuer:project.issuer_name,replacements:null,columns:null,pending_review_count:null,pending_review:[],authoring_summary:[`本轮为合成第${round}轮成果。仍需核对原始材料与工作稿。`]}}});
  }
  const versions:Dto<'ProspectusVersionsResponse'>={project_id:ids.project,current_version_id:'result-handoff-version-3',selection_revision:3,inactive_material_ids:[],versions:[
    {version_id:'result-handoff-version-1',sequence:1,origin:'upload',filename:materials[0].filename,sha256:materials[0].sha256,created_at:oldTime,material_id:ids.source,material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null},
    ...([2,3] as const).map(round=>({version_id:'result-handoff-version-'+round,sequence:round,origin:'generated' as const,filename:`合成第${round}轮清洁版.docx`,sha256:artifacts.get(artifactId(round,'clean'))!.metadata.sha256,created_at:round===2?oldTime:newTime,material_id:null,material_version:null,artifact_id:artifactId(round,'clean'),artifact_version:round+5,revision_artifact_id:artifactId(round,'revision'),run_id:round===2?ids.oldRun:ids.newRun}))]};
  return {project,materials,runs,artifacts,versions,inputs:new Map([[2,input(2,materials)],[3,input(3,materials)]]),allowPatch:false,failNextPatch:false,patches:[] as Dto<'ProjectPatchRequest'>[],calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],metadataReads:[] as string[],byteReads:[] as string[]};
}
export type State=ReturnType<typeof fixture>;
const installed=new WeakMap<Page,State>();
function checked<K extends keyof typeof schemas>(name:K,value:unknown):asserts value is Dto<K>{expect(Value.Check(schemas[name],value),name+': '+JSON.stringify([...Value.Errors(schemas[name],value)])).toBe(true);}
function dto<K extends keyof typeof schemas>(route:Route,name:K,value:Dto<K>){checked(name,value);return route.fulfill({status:200,json:value});}
const error=(route:Route,status:number,code='DATA_UNAVAILABLE')=>route.fulfill({status,json:{code,message:'Synthetic '+code,retryable:status>=500,correlation_id:'result-handoff-authoring',field_errors:[]}});
export const writes=(s:State)=>s.calls.filter(c=>c.method!=='GET');
export function immutableSnapshot(s:State){return structuredClone({materials:s.materials,inputs:[...s.inputs],runs:[...s.runs],versions:s.versions,artifacts:[...s.artifacts].map(([id,a])=>({id,metadata:a.metadata,sha256:hash(a.bytes)}))});}
export function validateFixture(s:State){
  checked('ProjectResponse',s.project);checked('ProspectusVersionsResponse',s.versions);
  for(const r of s.runs.values()){checked('RunResponse',r);expect(r.project_id).toBe(ids.project);expect(s.inputs.get(r.input_revision)?.input_hash).toBe(r.input_hash);}
  for(const i of s.inputs.values())checked('InputRevisionResponse',i);
  for(const m of s.materials)checked('MaterialResponse',m);
  for(const [id,a]of s.artifacts){checked('ArtifactResponse',a.metadata);expect(a.metadata.artifact_id).toBe(id);expect(hash(a.bytes)).toBe(a.metadata.sha256);expect(s.runs.get(a.metadata.run_id)?.artifact_id).toBe(a.metadata.word_delivery!.revision_artifact_id);}
  expect(s.versions.versions.find(v=>v.version_id===s.versions.current_version_id)?.run_id).toBe(ids.newRun);
  expect(s.runs.get(ids.oldRun)?.input_revision).toBe(2);expect(s.runs.get(ids.newRun)?.input_revision).toBe(3);
}
export async function install(page:Page,s=fixture()){
  validateFixture(s);expect(installed.has(page)).toBe(false);installed.set(page,s);page.on('pageerror',e=>s.errors.push(e.message));
  await page.route('**/api/v1/**',async route=>{
    try{
      const req=route.request(),url=new URL(req.url()),method=req.method(),path=url.pathname.slice('/api/v1'.length),body:unknown=req.postData()?req.postDataJSON():null;s.calls.push({method,path,body:structuredClone(body)});
      if(method==='GET'&&path==='/me')return dto(route,'MeResponse',{user_id:ids.owner,session_status:'active'});
      if(method==='GET'&&path==='/account')return dto(route,'AccountResponse',{user_id:ids.owner,username:'synthetic_authoring_owner',phone_masked:null,status:'active',created_at:oldTime,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
      if(method==='GET'&&path==='/credits/balance')return dto(route,'CreditBalanceResponse',{enabled:true,available:100000,frozen:0});
      if(method==='GET'&&path==='/m4/topics')return route.fulfill({status:200,json:{topics:[]}});
      if(method==='GET'&&path==='/projects')return dto(route,'ProjectListResponse',{items:[{project_id:ids.project,name:s.project.name,kind:s.project.kind,issuer_name:s.project.issuer_name,market:s.project.market,offering:s.project.offering,draft_revision:s.project.draft_revision,updated_at:s.project.updated_at,latest_run:{run_id:ids.newRun,state:'succeeded',updated_at:newTime},latest_artifact:{artifact_id:artifactId(3,'revision'),run_id:ids.newRun,version:8,created_at:newTime}}],page:{has_more:false,next_cursor:null}});
      const base='/projects/'+ids.project;
      if(method==='GET'&&path===base)return dto(route,'ProjectResponse',s.project);
      if(method==='PATCH'&&path===base&&s.allowPatch){checked('ProjectPatchRequest',body);s.patches.push(structuredClone(body));expect(req.headers()['if-match']).toBe(String(s.project.draft_revision));if(s.failNextPatch){s.failNextPatch=false;return error(route,503);}s.project={...s.project,...structuredClone(body),draft_revision:s.project.draft_revision+1,updated_at:newTime};return dto(route,'ProjectResponse',s.project);}
      if(method==='GET'&&path===base+'/tasks')return dto(route,'ProjectTasksResponse',taskPage(ids.project,[s.runs.get(ids.newRun)!,s.runs.get(ids.oldRun)!]));
      if(method==='GET'&&path===base+'/prospectus-versions')return dto(route,'ProspectusVersionsResponse',s.versions);
      if(method==='GET'&&path===base+'/messages')return dto(route,'ProjectMessagePage',{conversation_id:ids.project,items:[],project_message_set_ref:{version:1,content_sha256:hash('bondbuddy:empty-project-messages'),message_ids:[]},next_cursor:null,has_more:false});
      if(method==='GET'&&path===base+'/events')return dto(route,'ProjectEventsResponse',{items:s.materials.map((m,i)=>({event_id:'authoring-material-'+i,schema_version:1 as const,trace_id:'synthetic',project_id:ids.project,seq:i+1,occurred_at:oldTime,type:'material.upload_progress' as const,payload:{material_id:m.material_id}})).filter(e=>e.seq>Number(url.searchParams.get('after')??0)),next_cursor:null});
      const material=s.materials.find(m=>path===base+'/materials/'+m.material_id);if(method==='GET'&&material)return dto(route,'MaterialResponse',material);
      if(method==='GET'&&s.materials.some(m=>path===base+'/materials/'+m.material_id+'/parse-job'))return error(route,404,'NOT_FOUND');
      const revision=path.match(new RegExp('^'+base+'/input-revisions/(\\d+)$'));if(method==='GET'&&revision){const saved=s.inputs.get(Number(revision[1]));return saved?dto(route,'InputRevisionResponse',saved):error(route,404,'NOT_FOUND');}
      const runMatch=path.match(/^\/runs\/([^/]+)(.*)$/);if(method==='GET'&&runMatch){const r=s.runs.get(runMatch[1]);if(r){if(!runMatch[2])return dto(route,'RunResponse',r);if(runMatch[2]==='/events')return dto(route,'RunEventsResponse',{items:[],next_cursor:null});if(runMatch[2]==='/credit-charge')return dto(route,'RunCreditChargeResponse',{quote:null,state:null});if(runMatch[2]==='/stream')return route.fulfill({contentType:'text/event-stream',body:': synthetic polling fallback\n\n'});}}
      const artifact=path.match(/^\/artifacts\/([^/]+)(\/download)?$/);if(method==='GET'&&artifact){const a=s.artifacts.get(artifact[1]);if(a){if(artifact[2]){s.byteReads.push(artifact[1]);expect(url.searchParams.get('grant')).toBe('synthetic-authoring');return route.fulfill({status:200,contentType:mime,body:a.bytes});}s.metadataReads.push(artifact[1]);return dto(route,'ArtifactResponse',a.metadata);}}
      s.unexpected.push(method+' '+path+url.search);return error(route,501);
    }catch(cause){s.errors.push(cause instanceof Error?cause.message:String(cause));return error(route,500);}
  });return s;
}
export const routeFor=(step:'materials'|'details'='materials')=>`/#/projects/${ids.project}?step=${step}&run=${ids.oldRun}&from=projects`;
export async function open(page:Page,s=fixture(),url=routeFor()){await page.setViewportSize({width:1440,height:900});await page.goto('about:blank');await install(page,s);await page.goto(url);await expect(page.locator('.artifact-download-panel')).toBeVisible();return s;}
export async function assertFixture(page:Page,s=installed.get(page)){if(s){expect(s.unexpected,'Closed synthetic HTTP allow-list').toEqual([]);expect(s.errors,'No page or fixture errors').toEqual([]);}}
