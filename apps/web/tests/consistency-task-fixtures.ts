import {createHash} from 'node:crypto';
import {expect,type Page,type Route} from '@playwright/test';
import {FormatRegistry,Type,type TSchema} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {resultFilename,M4_DOCUMENT_TYPES,M4DraftInputSchema,M4ViewStateSchema,PROJECT_FILE_UPDATE_PRICE,
  ProjectFileCheckSchema,ProjectFileSourceSchema,ProjectFileVersionSchema,projectFileSchemas,schemas,
  type M4Draft,type M4Workspace,type ProjectFileAsset,type ProjectFileCheck,type ProjectFileFinding,
  type ProjectFileSource,type ProjectFileUpdateBatches,type ProjectFileVersion} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {docx,downloadBytes} from './word-roundtrip-fixtures';
export {docx,downloadBytes};

// Closed, owner-scoped synthetic HTTP. The normal projections follow the public
// producer: collection task -> acceptance run -> original check/file -> delivered
// version. Explicit projection faults exercise defensive UI correspondence; they
// are not claims that PostgreSQL or the worker produces those inconsistent rows.
// Reuse the unchanged stored-OOXML helper; no Word application or model runs here.
export const ids={owner:'consistency-task-owner',root:'consistency-task-root',workspace:'consistency-task-workspace',
  topic:'consistency-task-topic',family:'consistency-task-issuer-family',manualFamily:'consistency-task-manual-family',
  v1:'consistency-task-issuer-v1',v2:'consistency-task-issuer-v2',v3:'consistency-task-issuer-v3',manual:'consistency-task-manual-v1',
  oldCheck:'consistency-task-old-check',newCheck:'consistency-task-new-check',oldRun:'consistency-task-old-patch',
  laterRun:'consistency-task-later-patch',oldClean:'consistency-task-old-clean',oldRevision:'consistency-task-old-revision',
  laterClean:'consistency-task-later-clean',laterRevision:'consistency-task-later-revision'};
export const now='2026-10-25T16:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const oldTime='2026-10-25T12:00:00Z',oldRunTime='2026-10-25T13:00:00Z',newTime='2026-10-25T14:00:00Z',laterTime='2026-10-25T15:00:00Z';
export const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
FormatRegistry.Set('date-time',value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)&&Number.isFinite(Date.parse(value)));
export const oldBytes={revision:docx('合成旧任务 V2 修订版。保留原检查的2024年度差异与人工事项。'),clean:docx('合成旧任务 V2 清洁版。原任务准确字节。')};
export const laterBytes={revision:docx('合成后续任务 V3 修订版。不能冒作旧任务的交付。'),clean:docx('合成后续任务 V3 清洁版。不能替换旧 V2。')};
export type Variant='revision'|'clean';
export type ProjectionFault='missing-update'|'duplicate-update'|'wrong-input-file'|'missing-result'|'duplicate-result'|'result-file'|'result-run';
export type Options={state?:'succeeded'|'failed'|'paused';projection?:ProjectionFault};
type Task=Dto<'ProjectTasksResponse'>['items'][number];
export type Call={method:string;path:string;search:string;body:unknown};
type StoredArtifact={metadata:Dto<'ArtifactResponse'>;bytes:Buffer};
type Pending={checkId:string;body:Dto<'ProjectFileUpdateRequest'>;filenames:string[];attempted:true};
const listSchema=Type.Object({files:Type.Array(ProjectFileVersionSchema)},{additionalProperties:false});
const checksSchema=Type.Object({checks:Type.Array(ProjectFileCheckSchema)},{additionalProperties:false});
// ProjectFileUpdateBatches has a public TS type but no exported response schema.
const batchesSchema=Type.Object({batches:Type.Array(Type.Object({batch_id:Type.String({minLength:1}),state:Type.String(),items:Type.Array(Type.Object({
  file_version_id:Type.String({minLength:1}),filename:Type.String({minLength:1}),run_id:Type.Union([Type.String({minLength:1}),Type.Null()]),error:Type.Union([Type.String(),Type.Null()])},{additionalProperties:false}))},{additionalProperties:false}))},{additionalProperties:false});
const sourceSchema=Type.Object({project_id:Type.String({minLength:1}),source:ProjectFileSourceSchema},{additionalProperties:true});
function checked(schema:TSchema,value:unknown,label:string){expect(Value.Check(schema,value),label+': '+JSON.stringify([...Value.Errors(schema,value)])).toBe(true);}
function json(route:Route,value:unknown,schema?:TSchema,label='HTTP response'){if(schema)checked(schema,value,label);return route.fulfill({status:200,json:value});}
function dto<K extends keyof typeof schemas>(route:Route,name:K,value:Dto<K>){return json(route,value,schemas[name],name);}
const error=(route:Route,status:number,code='DATA_UNAVAILABLE')=>route.fulfill({status,json:{code,message:'Synthetic '+code,retryable:status>=500,correlation_id:'consistency-task-test',field_errors:[]}});
const materialAsset=(id:string):ProjectFileAsset=>({kind:'material',pin:{source_project_id:ids.root,material_id:id,material_version:1,sha256:hash(id)}});
const project=(id:string,name:string):Dto<'ProjectResponse'>=>({project_id:id,name,kind:'generation',issuer_name:'合成多项目发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now});
function finding(id:string,manual=false):ProjectFileFinding{return {id,kind:manual?'manual':'conflict',target_span_id:'target-'+id,original:'合成原文件数值100',replacement:manual?null:'合成募集书数值120',source_span_id:manual?null:'source-'+id,source_quote:manual?'':'合成募集书数值120',source_location:'原募集书第12页',target_location:'原关联文件第3页',reason:manual?'需人工核对原始依据。':'本轮合成差异。',field:manual?'授信口径':'合成财务数值',period:'2024年度',unit:'万元'};}
function check(id:string,input:ProjectFileVersion[],source:ProjectFileSource,time:string):ProjectFileCheck{return {run_id:id,state:'succeeded',stage:'completed',created_at:time,source:structuredClone(source),stale:source.sequence!==3,sha256:hash(id),files:input.map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence})),updates:[],result:{version:'project-file-check-v1',files:input.map(v=>({file_version_id:v.version_id,status:v.file_id===ids.manualFamily?'manual':'conflict',coverage:'明确标记的合成检查范围',findings:[finding(id+'-'+v.file_id,v.file_id===ids.manualFamily)],links:[]}))}};}
function version(id:string,sequence:number,asset:ProjectFileAsset,runId:string|null,latest:boolean):ProjectFileVersion{return {version_id:id,file_id:ids.family,document_type:'issuer',filename:'合成发行人基本情况_V'+sequence+'.docx',sequence,asset,revision_asset:null,source_version_id:'consistency-task-source-v1',source_name:'原募集说明书_V1.docx',source_sequence:1,template_id:null,template_version:null,created_at:sequence===3?laterTime:oldTime,run_id:runId,links:[],latest,version_count:3,consistency:{status:'manual',count:0,check_run_id:ids.oldCheck}};}
function task(runId:string,state:Task['state'],operation:Task['operation'],time:string,artifactId:string|null=null):Task{return {run_id:runId,project_id:ids.root,kind:'generation',state,stage:state==='succeeded'?'completed':state==='failed'?'failed':'queued',created_at:time,updated_at:now,artifact_id:artifactId,report_id:null,topic_id:null,document_type:null,operation};}
function run(t:Task):Dto<'RunResponse'>{return {run_id:t.run_id,execution_request_id:'prior-'+t.run_id,project_id:ids.root,input_revision:t.run_id===ids.oldCheck?1:t.run_id===ids.oldRun?2:t.run_id===ids.laterRun?4:t.created_at===now?5:3,input_hash:hash(t.run_id),state:t.state,stage:t.stage,event_cursor:0,channel:'production',test_grant_id:null,uncovered_items:[],billing_mode:'fixed_credits',reservation_id:null,artifact_id:t.artifact_id,prompt_snapshot_ref:null,updated_at:now};}

export function fixture(options:Options={}){
  const rootProject=project(ids.root,'合成原更新任务衔接项目'),workspaceProject=project(ids.workspace,'既有文件工作区');
  const source:ProjectFileSource={project_id:ids.root,version_id:'consistency-task-source-v3',selection_revision:7,filename:'当前募集说明书_V3.docx',sequence:3,asset:materialAsset('consistency-task-source-material-v3')};
  const oldSource:ProjectFileSource={...structuredClone(source),version_id:'consistency-task-source-v1',selection_revision:3,filename:'原募集说明书_V1.docx',sequence:1,asset:materialAsset('consistency-task-source-material-v1')};
  const artifacts=new Map<string,StoredArtifact>();
  // Match the file-operation producer: frozen input filename + variant + run input_revision.
  // The result's collection sequence (V2/V3) is a separate version, never the download version.
  const asset=(id:string,runId:string,bytes:Buffer):ProjectFileAsset=>{const inputRevision=runId===ids.oldRun?2:4;artifacts.set(id,{bytes,metadata:{artifact_id:id,run_id:runId,version:1,filename:resultFilename({project:'合成发行人基本情况_V'+(runId===ids.oldRun?1:2),kind:id.endsWith('revision')?'修订版':'清洁版',version:inputRevision,createdAt:runId===ids.oldRun?oldRunTime:laterTime,mediaType:mime}),display_version:inputRevision,media_type:mime,sha256:hash(bytes),quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/'+id+'/download?grant=synthetic-task',expires_at:'2099-01-01T00:00:00Z'}});return {kind:'artifact',pin:{source_project_id:ids.root,artifact_id:id,artifact_version:1,sha256:hash(bytes)}};};
  const v1=version(ids.v1,1,materialAsset('consistency-task-issuer-material-v1'),null,false);
  const v2=version(ids.v2,2,asset(ids.oldClean,ids.oldRun,oldBytes.clean),ids.oldRun,false);v2.created_at=oldRunTime;v2.revision_asset=asset(ids.oldRevision,ids.oldRun,oldBytes.revision);
  const v3=version(ids.v3,3,asset(ids.laterClean,ids.laterRun,laterBytes.clean),ids.laterRun,true);v3.revision_asset=asset(ids.laterRevision,ids.laterRun,laterBytes.revision);
  const manual:ProjectFileVersion={...version(ids.manual,1,materialAsset('consistency-task-manual-material'),null,true),file_id:ids.manualFamily,document_type:'credit',filename:'合成需人工确认授信事项.docx',version_count:1};
  const oldCheck=check(ids.oldCheck,[v1,manual],oldSource,oldTime),newCheck=check(ids.newCheck,[v2,manual],source,newTime);
  if(!options.state||options.state==='succeeded'){v3.source_version_id=newCheck.source.version_id;v3.source_name=newCheck.source.filename;v3.source_sequence=newCheck.source.sequence;}
  oldCheck.updates=[{file_version_id:ids.v1,issue_ids:[oldCheck.result!.files[0].findings[0].id],run_id:ids.oldRun,state:'succeeded',new_version_id:ids.v2}];
  newCheck.updates=[{file_version_id:ids.v2,issue_ids:[newCheck.result!.files[0].findings[0].id],run_id:ids.laterRun,state:'succeeded',new_version_id:ids.v3}];
  const files=[v1,v2,v3,manual],checks=[newCheck,oldCheck];
  let tasks=[task(ids.laterRun,'succeeded','file_patch',laterTime,ids.laterClean),task(ids.newCheck,'succeeded','file_check',newTime,'consistency-task-new-check-report'),task(ids.oldRun,'succeeded','file_patch',oldRunTime,ids.oldClean),task(ids.oldCheck,'succeeded','file_check',oldTime,'consistency-task-old-check-report')];
  const batches:ProjectFileUpdateBatches['batches']=[];
  if(options.state==='failed'){
    // Real retry shape: failed acceptance survives; retry replaces the batch's
    // run, while the same original V2 input produces a later successful V3.
    v2.asset=materialAsset('consistency-task-imported-v2');v2.revision_asset=null;v2.run_id=null;v2.created_at=oldTime;
    artifacts.delete(ids.oldClean);artifacts.delete(ids.oldRevision);
    oldCheck.files[0]={file_id:ids.family,file_version_id:ids.v2,filename:v2.filename,sequence:2};oldCheck.result!.files[0].file_version_id=ids.v2;
    oldCheck.updates=[{file_version_id:ids.v2,issue_ids:[oldCheck.result!.files[0].findings[0].id],run_id:ids.oldRun,state:'failed',new_version_id:null},{file_version_id:ids.v2,issue_ids:[oldCheck.result!.files[0].findings[0].id],run_id:ids.laterRun,state:'succeeded',new_version_id:ids.v3}];
    newCheck.files[0]={file_id:ids.family,file_version_id:ids.v3,filename:v3.filename,sequence:3};newCheck.result!.files[0].file_version_id=ids.v3;newCheck.updates=[];newCheck.created_at=now;
    tasks=[task(ids.newCheck,'succeeded','file_check',now,'consistency-task-new-check-report'),task(ids.laterRun,'succeeded','file_patch',laterTime,ids.laterClean),task(ids.oldRun,'failed','file_patch',oldRunTime),task(ids.oldCheck,'succeeded','file_check',oldTime,'consistency-task-old-check-report')];
  }else if(options.state==='paused'){
    artifacts.clear();files.splice(1,2);v1.latest=true;v1.version_count=1;
    Object.assign(source,structuredClone(oldSource));oldCheck.stale=false;checks.splice(0,1);
    oldCheck.updates[0]={...oldCheck.updates[0],state:'paused',new_version_id:null};
    tasks=[task(ids.oldRun,'paused','file_patch',oldRunTime),task(ids.oldCheck,'succeeded','file_check',oldTime,'consistency-task-old-check-report')];
    batches.push({batch_id:'consistency-task-paused-batch',state:'running',items:[{file_version_id:ids.v1,filename:v1.filename,run_id:ids.oldRun,error:null}]});
  }
  const drafts={} as Record<(typeof M4_DOCUMENT_TYPES)[number],M4Draft>;
  for(const document_type of M4_DOCUMENT_TYPES)drafts[document_type]={document_type,project_file:{project_id:ids.root,source_version_id:source.version_id,source_selection_revision:source.selection_revision},source_material:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{},requirements:[],supplemental_requirements:'',version:0,sha256:hash('empty-'+document_type),updated_at:null};
  const workspace:M4Workspace={topic:{topic_id:ids.topic,project_id:ids.workspace,source_project_id:ids.root,name:workspaceProject.name,created_at:now,updated_at:now},project:workspaceProject,drafts,materials:[],material_details:[],templates:[],messages:[],tasks:[],artifacts:[],pending_requirements:[],view:{version:0,selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null}},active_run:null};
  const s={options,rootProject,source,oldSource,workspace,files,checks,tasks,batches,artifacts,
    calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],metadataReads:[] as string[],byteReads:[] as string[],checkReads:0,
    runActions:[] as {run:string;action:string;body:unknown}[],updatePosts:[] as {checkId:string;body:Dto<'ProjectFileUpdateRequest'>}[],
    allowResume:false,pending:undefined as Pending|undefined,workspaceUnavailable:false,
    metadataFault:undefined as {artifact:string;field:'id'|'run'|'version'|'hash'}|undefined,projectionFaults:[] as string[]};
  assertCanonical(s);
  if(options.projection){
    const update=oldCheck.updates.find(u=>u.run_id===ids.oldRun)!;
    if(options.projection==='missing-update')oldCheck.updates=oldCheck.updates.filter(u=>u.run_id!==ids.oldRun);
    if(options.projection==='duplicate-update')oldCheck.updates.push(structuredClone(update));
    if(options.projection==='wrong-input-file')update.file_version_id='consistency-task-unlisted-file-version';
    if(options.projection==='missing-result')s.files=s.files.filter(v=>v.version_id!==ids.v2);
    if(options.projection==='duplicate-result')s.files.push(structuredClone(v2));
    if(options.projection==='result-file')v2.file_id=ids.manualFamily;
    if(options.projection==='result-run')v2.run_id=ids.laterRun;
    s.projectionFaults.push(options.projection);
  }
  return s;
}
export type State=ReturnType<typeof fixture>;
export const writes=(s:State)=>s.calls.filter(call=>call.method!=='GET');
export const base=`/projects/${ids.root}/project-files`;
export const cacheKey='bondbuddy:file-consistency:'+encodeURIComponent(ids.owner)+':'+encodeURIComponent(ids.root);
export const taskRoute=(extra='')=>`/#consistency?project=${ids.root}&update_run=${ids.oldRun}${extra}`;
export const targetInput=(s:State)=>s.checks.find(c=>c.run_id===ids.oldCheck)!.updates.find(u=>u.run_id===ids.oldRun)?.file_version_id;
export const serverSnapshot=(s:State)=>structuredClone({source:s.source,files:s.files,checks:s.checks,batches:s.batches,tasks:s.tasks});
function assertCanonical(s:State){
  expect(new Set(s.files.map(v=>v.version_id)).size).toBe(s.files.length);
  expect(new Set(s.checks.map(c=>c.run_id)).size).toBe(s.checks.length);
  for(const c of s.checks){
    expect(c.result?.files.map(f=>f.file_version_id)).toEqual(c.files.map(f=>f.file_version_id));
    for(const u of c.updates){const input=c.files.find(f=>f.file_version_id===u.file_version_id);expect(input).toBeDefined();
      if(u.state==='succeeded'){const outputs=s.files.filter(f=>f.version_id===u.new_version_id);expect(outputs).toHaveLength(1);const output=outputs[0];expect(output.file_id).toBe(input!.file_id);expect(output.run_id).toBe(u.run_id);expect(output).toMatchObject({source_version_id:c.source.version_id,source_name:c.source.filename,source_sequence:c.source.sequence});
        for(const a of [output.asset,output.revision_asset]){expect(a?.kind).toBe('artifact');if(a?.kind==='artifact'){const stored=s.artifacts.get(a.pin.artifact_id)!;expect(stored).toBeDefined();expect(stored.metadata).toMatchObject({artifact_id:a.pin.artifact_id,run_id:u.run_id,version:a.pin.artifact_version,sha256:a.pin.sha256});expect(a.pin.source_project_id).toBe(ids.root);expect(hash(stored.bytes)).toBe(a.pin.sha256);}}
      }else expect(u.new_version_id).toBeNull();
    }
  }
  expect(s.workspace.topic.project_id).toBe(s.workspace.project.project_id);expect(s.workspace.topic.source_project_id).toBe(ids.root);
  for(const draft of Object.values(s.workspace.drafts)){const {version:_,sha256:__,updated_at:___,...input}=draft;checked(M4DraftInputSchema,input,'M4 input');}
  const {version:_,...view}=s.workspace.view;checked(M4ViewStateSchema,view,'M4 view');
}
function collection(s:State):Dto<'ProjectFilesResponse'>{return {project_id:ids.root,items:s.files.map(v=>({file_id:v.asset.kind==='artifact'?v.asset.pin.artifact_id:v.asset.pin.material_id,file_key:'project-file:'+v.file_id,project_id:v.asset.pin.source_project_id,source:v.asset.kind,filename:v.filename,version:v.asset.kind==='artifact'?v.asset.pin.artifact_version:v.asset.pin.material_version,display_version:v.sequence,sha256:v.asset.pin.sha256,created_at:v.created_at,folder:'4.1',run_id:v.run_id,current:false,latest:v.latest,version_count:v.version_count}))};}
const installed=new WeakMap<Page,State>();
export async function install(page:Page,s=fixture()){
  expect(installed.has(page),'Each test/page owns exactly one fixture; use a fresh page to change synthetic identities.').toBe(false);installed.set(page,s);page.on('pageerror',e=>s.errors.push(e.message));
  checked(listSchema,{files:s.files},'Project file list');checked(checksSchema,{checks:s.checks},'Checks');checked(batchesSchema,{batches:s.batches},'Update batches');
  await page.context().route('**/api/v1/**',async route=>{
    try{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length),method=req.method();
    const body:unknown=req.postData()?req.postDataJSON():null;s.calls.push({method,path,search:url.search,body:structuredClone(body)});
    if(method==='GET'&&path==='/me')return dto(route,'MeResponse',{user_id:ids.owner,session_status:'active'});
    if(method==='GET'&&path==='/account')return dto(route,'AccountResponse',{user_id:ids.owner,username:'synthetic_task_owner',phone_masked:null,status:'active',created_at:now,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(method==='GET'&&path==='/credits/balance')return dto(route,'CreditBalanceResponse',{enabled:true,available:100000,frozen:0});
    if(method==='GET'&&path==='/m4/topics')return json(route,{topics:[]});
    if(method==='GET'&&path==='/projects')return dto(route,'ProjectListResponse',{items:[{project_id:ids.root,name:s.rootProject.name,kind:s.rootProject.kind,issuer_name:s.rootProject.issuer_name,market:s.rootProject.market,offering:s.rootProject.offering,draft_revision:s.rootProject.draft_revision,updated_at:now,file_count:s.files.filter(v=>v.latest).length,latest_run:null,latest_artifact:null,task_summary:{active:s.tasks.filter(t=>['queued','running','preparing','validating','delivering','settlement_pending'].includes(t.state)).length,attention:s.tasks.some(t=>t.state==='paused')?1:0,completed:s.tasks.filter(t=>t.state==='succeeded').length,total:s.tasks.length,latest:s.tasks[0]??null,recent_result:s.tasks.find(t=>['succeeded','failed','rejected','cancelled','test_completed'].includes(t.state))??null}}],page:{has_more:false,next_cursor:null}});
    if(method==='GET'&&path===`/projects/${ids.root}`)return dto(route,'ProjectResponse',s.rootProject);
    if(method==='GET'&&path===`/projects/${ids.root}/tasks`)return dto(route,'ProjectTasksResponse',{project_id:ids.root,items:s.tasks,page:{has_more:false,next_cursor:null}});
    if(method==='GET'&&path===`/projects/${ids.root}/files`)return dto(route,'ProjectFilesResponse',collection(s));
    if(method==='GET'&&path===base)return json(route,{files:s.files},listSchema,'Project file registry');
    if(method==='GET'&&path===base+'/checks'){s.checkReads++;return json(route,{checks:s.checks},checksSchema,'Project checks');}
    if(method==='GET'&&path===base+'/updates')return json(route,{batches:s.batches},batchesSchema,'Update batches');
    if(method==='GET'&&path===base+'/workspace')return s.workspaceUnavailable?error(route,404,'NOT_FOUND'):json(route,{project_id:ids.root,source:s.source,workspace:s.workspace,files:s.files,batches:[]},sourceSchema,'Existing workspace');
    if(method==='GET'&&path===`/projects/${ids.root}/prospectus-versions`)return dto(route,'ProspectusVersionsResponse',{project_id:ids.root,current_version_id:s.source.version_id,selection_revision:s.source.selection_revision,inactive_material_ids:[],versions:[{version_id:s.source.version_id,sequence:s.source.sequence,origin:'upload',filename:s.source.filename,sha256:s.source.asset.pin.sha256,created_at:oldTime,material_id:s.source.asset.kind==='material'?s.source.asset.pin.material_id:null,material_version:s.source.asset.kind==='material'?s.source.asset.pin.material_version:null,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}]});
    const artifact=path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
    if(method==='GET'&&artifact){const stored=s.artifacts.get(artifact[1]);if(!stored){s.unexpected.push('unknown artifact '+path);return error(route,404,'NOT_FOUND');}
      if(artifact[2]){s.byteReads.push(artifact[1]);expect(url.searchParams.get('grant')).toBe('synthetic-task');return route.fulfill({status:200,contentType:mime,body:stored.bytes});}
      s.metadataReads.push(artifact[1]);const metadata=structuredClone(stored.metadata),fault=s.metadataFault;
      if(fault?.artifact===artifact[1]){if(fault.field==='id')metadata.artifact_id=ids.laterClean;if(fault.field==='run')metadata.run_id=ids.laterRun;if(fault.field==='version')metadata.version+=1;if(fault.field==='hash')metadata.sha256=hash('wrong authorized hash');}
      return dto(route,'ArtifactResponse',metadata);
    }
    const control=path.match(/^\/runs\/([^/]+)\/resume$/);
    if(method==='POST'&&control&&s.allowResume){checked(schemas.RunActionRequest,body,'Explicit resume');expect(control[1]).toBe(ids.oldRun);expect(body).toEqual({reason:'user_resumed'});s.runActions.push({run:control[1],action:'resume',body:structuredClone(body)});const t=s.tasks.find(t=>t.run_id===ids.oldRun)!;expect(t.state).toBe('paused');t.state='queued';t.stage='queued';for(const c of s.checks)for(const u of c.updates)if(u.run_id===ids.oldRun)u.state='queued';return dto(route,'RunResponse',run(t));}
    const update=path.match(new RegExp('^'+base+'/checks/([^/]+)/updates$'));
    if(method==='POST'&&update&&s.pending){checked(projectFileSchemas.ProjectFileUpdateRequest,body,'Original pending update');expect(update[1]).toBe(s.pending.checkId);expect(body).toEqual(s.pending.body);s.updatePosts.push({checkId:update[1],body:structuredClone(body) as Dto<'ProjectFileUpdateRequest'>});return json(route,{batch_id:'consistency-task-original-pending-batch'});}
    s.unexpected.push(method+' '+path+url.search);return error(route,501);
    }catch(cause){s.errors.push(cause instanceof Error?cause.message:String(cause));return error(route,500);}
  });
  return s;
}
export async function openTask(page:Page,s=fixture(),url=taskRoute()){
  await page.goto('about:blank');await install(page,s);await page.goto(url);await expect(page.locator('#fc-update-task')).toBeVisible();return s;
}
export async function openProjects(page:Page,s=fixture(),entry:'projects'|'files'='projects'){
  await page.goto('about:blank');await install(page,s);await page.goto(entry==='projects'?'/#tasks':`/#/projects/${ids.root}/files`);
  if(entry==='projects'){await expect(page.locator(`[data-tasks="${ids.root}"]`)).toBeVisible();await page.locator(`[data-tasks="${ids.root}"]`).click();await expect(page.locator(`[data-run-id="${ids.oldRun}"] a`)).toBeVisible();}
  else await expect(page.locator('#pw-task-summary article').filter({has:page.locator(`a[href*="${ids.oldRun}"]`)})).toBeVisible();return s;
}
export async function seedCache(page:Page,value:unknown){await page.addInitScript(({key,value})=>{if(location.protocol==='http:'||location.protocol==='https:')sessionStorage.setItem(key,JSON.stringify(value));},{key:cacheKey,value});}
export function pendingRequest(s:State):Pending{
  const current=s.checks.find(c=>c.run_id===ids.newCheck)!;const input=current.files.find(f=>f.file_id===ids.family)!;
  return {checkId:ids.newCheck,body:{request_id:'consistency-task-original-request',expected_check_sha256:current.sha256!,price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:PROJECT_FILE_UPDATE_PRICE.points,files:[{file_version_id:input.file_version_id}]},filenames:[input.filename],attempted:true};
}
export async function assertFixture(page:Page,s=installed.get(page)){
  if(!s)return;expect(s.unexpected,'Only the explicit synthetic HTTP allow-list may be used.').toEqual([]);expect(s.errors,'No browser page errors.').toEqual([]);
}
