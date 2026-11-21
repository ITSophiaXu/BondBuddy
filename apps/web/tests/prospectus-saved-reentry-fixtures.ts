import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import {createHash} from 'node:crypto';
import {expect,type Page,type Route} from '@playwright/test';
import {FormatRegistry,Type} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {M4_DOCUMENT_TYPES,M4DocumentManifestSchema,M4DraftInputSchema,M4ViewStateSchema,
  ProjectFileSourceSchema,ProjectFileVersionSchema,schemas,type M4DocumentType,type M4Draft,
  type M4DraftInput,type M4Workspace,type ProjectFileSource,type ProjectFileVersion,
  type ProjectFileWorkspace,type ProspectusVersion,type ProspectusVersions,type Run} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';
import {assertDownloadProgress,checkedDownloadProgress,type DownloadProgressDiagnostic} from './artifact-download-diagnostic-fixture';

// One closed synthetic HTTP producer serves the actual main.ts routes throughout
// each desktop journey. No root HTML override, component mount, worker or ledger.
export const ids={owner:'saved-reentry-owner',project:'saved-reentry-project',source:'saved-reentry-project',
  execution:'saved-reentry-execution',topic:'saved-reentry-topic',originalRun:'saved-reentry-original-run',
  old:'saved-reentry-old-version',candidate:'saved-reentry-new-version'};
export const now='2026-10-26T02:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
if(!FormatRegistry.Has('date-time'))FormatRegistry.Set('date-time',value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)&&Number.isFinite(Date.parse(value)));
const xml=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
/** Minimal real OOXML ZIP. These bytes verify transport identity, not Word UX. */
export function docx(text:string){
  const entries=[['[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml',`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${xml(text)}</w:t></w:r></w:p></w:body></w:document>`]];
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const[name,content]of entries){const filename=Buffer.from(name),bytes=Buffer.from(content),crc=crc32(bytes),h=Buffer.alloc(30),c=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(bytes.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(filename.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);
    local.push(h,filename,bytes);central.push(c,filename);offset+=h.length+filename.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
export const oldBytes=docx('合成项目原募集书；原任务固定使用本稿。'),newBytes=docx('合成项目新募集书；明确采用以前不能替换项目当前稿。');
const inputOf=(draft:M4Draft):M4DraftInput=>{const{version:_v,sha256:_s,updated_at:_u,...input}=draft;return structuredClone(input);};
type Selection=Dto<'ProspectusVersionSelectRequest'>;
type Call={method:string;path:string;search:string;body:unknown};
type Material={dto:Dto<'MaterialResponse'>;bytes:Buffer};
type Session={declaration:Dto<'UploadCreateRequest'>;bytes?:Buffer;material?:Dto<'MaterialResponse'>};
type ArtifactMetadataRead={artifact:Dto<'ArtifactResponse'>;callIndex:number};
type ArtifactTransfer={artifact:Dto<'ArtifactResponse'>;metadataCall:number;binaryCall:number;sha256:string;byteSize:number;downloadId?:string};
type Options={noCurrent?:boolean;sameName?:boolean;candidate?:boolean;rollback?:boolean;currentLatest?:boolean;generated?:boolean};
const makeVersion=(id:string,sequence:number,materialId:string,materialVersion:number,filename:string,bytes:Buffer):ProspectusVersion=>({version_id:id,sequence,origin:'upload',filename,sha256:hash(bytes),created_at:now,material_id:materialId,material_version:materialVersion,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null});
export function fixture(options:Options={}){
  const old=makeVersion(ids.old,1,'saved-reentry-old-material',2,options.sameName?'同名募集说明书.docx':'合成募集说明书_原稿.docx',oldBytes);
  const candidate:ProspectusVersion={...makeVersion(ids.candidate,options.noCurrent?1:2,'saved-reentry-new-material',1,options.sameName?old.filename:'合成募集说明书_新稿.docx',newBytes),...(options.generated?{origin:'generated' as const,material_id:null,material_version:null,artifact_id:'saved-reentry-generated-artifact',artifact_version:6,run_id:'saved-reentry-generated-run'}:{})};
  const project:Dto<'ProjectResponse'>={project_id:ids.project,name:'合成保存新稿后重入项目',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:3,input_revision:null,input_hash:null,updated_at:now};
  const materials=new Map<string,Material>();
  const register=(v:ProspectusVersion,bytes:Buffer,upload_id='prior-'+v.version_id)=>{const dto:Dto<'MaterialResponse'>={material_id:v.material_id!,material_version:v.material_version!,upload_id,role:'historical',filename:v.filename,media_type:mime,byte_size:bytes.length,sha256:hash(bytes),state:'persisted',persisted_at:now,error:null};materials.set(dto.material_id,{dto,bytes});return dto;};
  register(old,oldBytes);
  const versions:ProspectusVersions={project_id:ids.source,current_version_id:options.noCurrent?null:old.version_id,selection_revision:options.noCurrent?0:7,inactive_material_ids:[],versions:options.noCurrent?[]:[old]};
  if(options.candidate||options.rollback||options.currentLatest||options.generated){versions.versions.unshift(candidate);if(candidate.origin==='upload')register(candidate,newBytes);}
  if(options.rollback){const newest=makeVersion('saved-reentry-third-version',3,'saved-reentry-third-material',1,'合成已保存第三稿.docx',docx('合成第三稿，项目曾采用后已回选第一稿。'));versions.versions.unshift(newest);register(newest,docx('合成第三稿，项目曾采用后已回选第一稿。'));versions.selection_revision=9;}
  if(options.currentLatest)versions.current_version_id=candidate.version_id;
  const oldPin={source_project_id:ids.source,material_id:old.material_id!,material_version:old.material_version!,sha256:old.sha256};
  const drafts={} as Record<M4DocumentType,M4Draft>;
  for(const type of M4_DOCUMENT_TYPES)drafts[type]={document_type:type,version:3,sha256:hash('saved draft '+type),updated_at:now,source_material:options.noCurrent?null:oldPin,materials:[],template:null,edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',offering:'private'},requirements:[],supplemental_requirements:'各文种已保存的原要求保持不变。'};
  const run:Run={run_id:ids.originalRun,project_id:ids.execution,execution_request_id:'saved-reentry-original-execution',input_revision:1,input_hash:hash('immutable original input'),state:'failed',stage:'completed',channel:'production',test_grant_id:null,uncovered_items:[],event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:null,prompt_snapshot_ref:null,updated_at:now};
  const historical=inputOf(drafts.init);historical.source_material=oldPin;historical.supplemental_requirements='原任务冻结要求，项目当前稿变化不能改写。';
  const workspace:M4Workspace={topic:{topic_id:ids.topic,project_id:ids.execution,source_project_id:ids.project,name:project.name,surface:'materials',created_at:now,updated_at:now},project:{...project,project_id:ids.execution},drafts,materials:[oldPin],material_details:[{...oldPin,filename:old.filename,state:'persisted',media_type:mime}],templates:[],messages:[],tasks:[{run,manifest:{version:'m4-document-input-v1',kind:'document',topic_id:ids.topic,execution_scope_project_id:ids.project,draft_version:1,input:historical,template_material:null,market:'sse',offering:'private',billing_task:'m4_G01'},created_at:now,events:[],artifacts:[]}],artifacts:[],pending_requirements:[],view:{version:0,selected_document_type:'init',open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:'init',draft_version:3,source_material:oldPin,citations:[],reading_artifact:null}},active_run:null};
  const files:ProjectFileVersion[]=[];
  for(const type of ['issuer','financial'] as const){const bytes=docx('合成已有'+type+'文件，原版本必须保留。'),id='saved-reentry-'+type+'-material';const dto:Dto<'MaterialResponse'>={material_id:id,material_version:1,upload_id:'prior-'+id,role:'other',filename:type==='issuer'?'合成发行人基本情况.docx':'合成财务情况.docx',media_type:mime,byte_size:bytes.length,sha256:hash(bytes),state:'persisted',persisted_at:now,error:null};materials.set(id,{dto,bytes});files.push({version_id:'saved-reentry-'+type+'-v1',file_id:'saved-reentry-'+type+'-family',document_type:type,filename:dto.filename,sequence:1,asset:{kind:'material',pin:{source_project_id:ids.project,material_id:id,material_version:1,sha256:dto.sha256}},revision_asset:null,source_version_id:old.version_id,template_id:null,template_version:null,source_name:old.filename,source_sequence:1,created_at:now,run_id:null,links:[],latest:true,version_count:1,consistency:{status:'unchecked',count:0,check_run_id:null}});}
  return{options,project,old,candidate,versions,workspace,files,materials,register,sessions:new Map<string,Session>(),receipts:new Map<string,{request:Selection;response:ProspectusVersions}>(),calls:[] as Call[],selections:[] as Selection[],puts:0,completions:0,appliedSelections:0,versionReads:0,filesReads:0,unexpected:[] as string[],errors:[] as string[],artifactMetadataReads:[] as ArtifactMetadataRead[],artifactTransfers:[] as ArtifactTransfer[],downloadDiagnostics:[] as DownloadProgressDiagnostic[],balance:{enabled:true,available:100000,frozen:0} satisfies Dto<'CreditBalanceResponse'>};
}
export type State=ReturnType<typeof fixture>;
export function projection(s:State):ProspectusVersions{const current=s.versions.versions.find(v=>v.version_id===s.versions.current_version_id);return{...structuredClone(s.versions),inactive_material_ids:current?s.versions.versions.filter(v=>v.material_id&&v.material_id!==current.material_id).map(v=>v.material_id!):[]};}
export function currentSource(s:State):ProjectFileSource|null{const v=s.versions.versions.find(v=>v.version_id===s.versions.current_version_id);return v?{project_id:ids.source,version_id:v.version_id,selection_revision:s.versions.selection_revision,filename:v.filename,sequence:v.sequence,asset:v.origin==='upload'?{kind:'material',pin:{source_project_id:ids.source,material_id:v.material_id!,material_version:v.material_version!,sha256:v.sha256}}:{kind:'artifact',pin:{source_project_id:ids.source,artifact_id:v.artifact_id!,artifact_version:v.artifact_version!,sha256:v.sha256}}}:null;}
export function collection(s:State):Dto<'ProjectFilesResponse'>{return{project_id:ids.project,items:[...s.versions.versions.map(v=>({file_id:v.origin==='upload'?v.material_id!:v.artifact_id!,file_key:'prospectus',project_id:ids.source,source:v.origin==='upload'?'material' as const:'artifact' as const,filename:v.filename,version:v.origin==='upload'?v.material_version!:v.artifact_version!,display_version:v.sequence,sha256:v.sha256,created_at:v.created_at,folder:'2' as const,run_id:v.run_id,current:v.version_id===s.versions.current_version_id,latest:v.version_id===s.versions.current_version_id,version_count:s.versions.versions.length})),...s.files.map(v=>({file_id:v.asset.kind==='material'?v.asset.pin.material_id:v.asset.pin.artifact_id,file_key:'project-file:'+v.file_id,project_id:ids.project,source:v.asset.kind,filename:v.filename,version:v.asset.kind==='material'?v.asset.pin.material_version:v.asset.pin.artifact_version,display_version:v.sequence,sha256:v.asset.pin.sha256,created_at:v.created_at,folder:'4.1' as const,run_id:v.run_id,current:false,latest:v.latest,version_count:v.version_count}))]};}
export const writes=(s:State)=>s.calls.filter(c=>c.method!=='GET');
export const fixedSnapshot=(s:State)=>structuredClone({tasks:s.workspace.tasks,drafts:s.workspace.drafts,artifacts:s.workspace.artifacts,balance:s.balance,files:s.files.map(({consistency:_c,...file})=>file)});
export function check<K extends keyof typeof schemas>(name:K,value:unknown):asserts value is Dto<K>{expect([...Value.Errors(schemas[name],value)].map(e=>({path:e.path,message:e.message})),name).toEqual([]);}
const registrySchema=Type.Object({files:Type.Array(ProjectFileVersionSchema)},{additionalProperties:false});
function assertState(s:State){check('ProjectResponse',s.project);check('ProspectusVersionsResponse',projection(s));check('ProjectFilesResponse',collection(s));for(const m of s.materials.values()){check('MaterialResponse',m.dto);expect(hash(m.bytes)).toBe(m.dto.sha256);expect(m.bytes.length).toBe(m.dto.byte_size);}for(const draft of Object.values(s.workspace.drafts))expect([...Value.Errors(M4DraftInputSchema,inputOf(draft))]).toEqual([]);for(const task of s.workspace.tasks)expect([...Value.Errors(M4DocumentManifestSchema,task.manifest)]).toEqual([]);const{version:_v,...view}=s.workspace.view;expect([...Value.Errors(M4ViewStateSchema,view)]).toEqual([]);expect([...Value.Errors(registrySchema,{files:s.files})]).toEqual([]);const source=currentSource(s);if(source)expect([...Value.Errors(ProjectFileSourceSchema,source)]).toEqual([]);}
async function reply<K extends keyof typeof schemas>(route:Route,name:K,value:Dto<K>,status=200){check(name,value);return route.fulfill({status,json:fixtureBody(route,structuredClone(value))});}
const failure=(route:Route,status=409)=>route.fulfill({status,json:fixtureBody(route,{code:status===409?'INPUT_REVISION_CONFLICT':'NOT_FOUND',message:'Synthetic saved-source response',retryable:false,correlation_id:'saved-reentry',field_errors:[]})});
function generatedArtifact(s:State):Dto<'ArtifactResponse'>{
  expect(s.candidate.origin).toBe('generated');expect(hash(newBytes)).toBe(s.candidate.sha256);
  expect(s.versions.versions.filter(version=>version.version_id===s.candidate.version_id)).toEqual([s.candidate]);
  const artifact:Dto<'ArtifactResponse'>={artifact_id:s.candidate.artifact_id!,run_id:s.candidate.run_id!,version:s.candidate.artifact_version!,filename:s.candidate.filename,media_type:mime,sha256:s.candidate.sha256,quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/'+s.candidate.artifact_id+'/download',expires_at:'2099-01-01T00:00:00Z'};
  check('ArtifactResponse',artifact);return artifact;
}
const installed=new WeakMap<Page,State>();
export async function install(page:Page,s=fixture()){
  assertState(s);installed.set(page,s);page.on('pageerror',error=>s.errors.push(error.message));
  await page.clock.install({time:new Date(now)});await page.clock.pauseAt(new Date(Date.parse(now)+1000));
  await page.route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length),method=request.method();
    const body:unknown=request.headers()['content-type']?.includes('application/json')&&request.postData()?fixtureRequest(request):null;
    if(method==='POST'&&path==='/browser-errors'&&!url.search){
      try{
        const diagnostic=checkedDownloadProgress(body),artifact=generatedArtifact(s);
        expect(diagnostic.detail).toMatchObject({artifact_id:artifact.artifact_id,run_id:artifact.run_id,version:artifact.version,received_bytes:newBytes.byteLength});
        if(diagnostic.report.project_id!==undefined)expect(diagnostic.report.project_id).toBe(ids.project);
        const previous=s.downloadDiagnostics.filter(entry=>entry.detail.download_id===diagnostic.detail.download_id);
        expect(previous.some(entry=>entry.detail.event===diagnostic.detail.event),'Each controlled event is recorded only once.').toBe(false);
        const transfer=diagnostic.detail.event==='verified'
          ?s.artifactTransfers.find(entry=>!entry.downloadId&&entry.artifact.artifact_id===artifact.artifact_id)
          :s.artifactTransfers.find(entry=>entry.downloadId===diagnostic.detail.download_id);
        expect(transfer,'Verified progress requires its actual metadata read and binary GET.').toBeDefined();
        expect(transfer!.artifact).toEqual(artifact);expect(transfer!.sha256).toBe(artifact.sha256);expect(transfer!.byteSize).toBe(diagnostic.detail.received_bytes);
        expect(transfer!.metadataCall).toBeLessThan(transfer!.binaryCall);expect(transfer!.binaryCall).toBeLessThan(s.calls.length);
        if(diagnostic.detail.event==='verified'){expect(previous).toEqual([]);transfer!.downloadId=diagnostic.detail.download_id;}
        else expect(previous.map(entry=>entry.detail.event)).toEqual(diagnostic.detail.event==='auto_save_requested'?['verified']:['verified','auto_save_requested']);
        s.downloadDiagnostics.push(diagnostic);
        return reply(route,'BrowserErrorReportResponse',{report_id:'saved-reentry-download-report',deduplicated:false,received_at:now},201);
      }catch(error){s.unexpected.push(method+' '+path);s.errors.push(error instanceof Error?error.message:String(error));return failure(route,500);}
    }
    s.calls.push({method,path,search:url.search,body:structuredClone(body)});
    if(method==='GET'&&path==='/me')return reply(route,'MeResponse',{user_id:ids.owner,session_status:'active'});
    if(method==='GET'&&path==='/account')return reply(route,'AccountResponse',{user_id:ids.owner,username:'synthetic_saved_source',phone_masked:null,status:'active',created_at:now,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(method==='GET'&&path==='/credits/balance')return reply(route,'CreditBalanceResponse',s.balance);
    if(method==='GET'&&path==='/m4/topics')return route.fulfill({json:fixtureBody(route,{topics:[]})});
    if(method==='GET'&&path==='/projects')return reply(route,'ProjectListResponse',{items:[{project_id:ids.project,name:s.project.name,kind:s.project.kind,issuer_name:s.project.issuer_name,market:s.project.market,offering:s.project.offering,draft_revision:s.project.draft_revision,updated_at:now,file_count:collection(s).items.length,latest_run:null,latest_artifact:null,status:'draft'}],page:{has_more:false,next_cursor:null}});
    const base='/projects/'+ids.project;
    if(method==='GET'&&path===base+'/workpapers/library')return route.fulfill({json:fixtureBody(route,{items:[],total:0,offset:0,limit:100,source:currentSource(s),checks:[]})});
    if(method==='GET'&&path===base)return reply(route,'ProjectResponse',s.project);
    if(method==='GET'&&path===base+'/workpapers/library')return route.fulfill({json:fixtureBody(route,{items:[],total:0,offset:0,limit:60,source:null,checks:[]})});
    if(method==='GET'&&path===base+'/tasks')return reply(route,'ProjectTasksResponse',{project_id:ids.project,items:[{run_id:ids.originalRun,project_id:ids.execution,kind:'generation',state:'failed',stage:'completed',artifact_id:null,created_at:now,updated_at:now,report_id:null,topic_id:ids.topic,document_type:'init',operation:null}],page:{has_more:false,next_cursor:null}});
    if(method==='GET'&&path===base+'/files'){s.filesReads++;return reply(route,'ProjectFilesResponse',collection(s));}
    if(method==='GET'&&path===base+'/project-files'){expect([...Value.Errors(registrySchema,{files:s.files})]).toEqual([]);return route.fulfill({json:fixtureBody(route,{files:structuredClone(s.files)})});}
    if(method==='GET'&&path===base+'/project-files/workspace'){assertState(s);const value:ProjectFileWorkspace={project_id:ids.project,source:currentSource(s),workspace:s.workspace,files:s.files,batches:[]};return route.fulfill({json:fixtureBody(route,structuredClone(value))});}
    if(method==='GET'&&path===base+'/prospectus-versions'){s.versionReads++;return reply(route,'ProspectusVersionsResponse',projection(s));}
    if(method==='POST'&&path===base+'/materials/uploads'){
      check('UploadCreateRequest',body);expect(body).toEqual({filename:s.candidate.filename,media_type:mime,byte_size:newBytes.length,sha256:hash(newBytes),role:'historical'});
      const id='saved-reentry-upload-'+(s.sessions.size+1);s.sessions.set(id,{declaration:structuredClone(body)});return reply(route,'UploadSessionResponse',{upload_id:id,state:'uploading',upload_url:'/api/v1'+base+'/materials/uploads/'+id+'/bytes',expires_at:'2099-01-01T00:00:00Z',max_bytes:100*1024*1024},201);
    }
    const transfer=path.match(new RegExp('^'+base+'/materials/uploads/([^/]+)/(bytes|complete)$'));
    if(transfer){const session=s.sessions.get(transfer[1]);if(!session)return failure(route,404);
      if(method==='PUT'&&transfer[2]==='bytes'){const bytes=request.postDataBuffer()!;expect(bytes).toEqual(newBytes);expect(hash(bytes)).toBe(session.declaration.sha256);session.bytes=bytes;s.puts++;return route.fulfill({status:204});}
      if(method==='POST'&&transfer[2]==='complete'){check('UploadCompleteRequest',body);expect(body).toEqual({sha256:session.declaration.sha256,byte_size:session.declaration.byte_size});expect(session.bytes).toEqual(newBytes);s.completions++;if(!session.material){session.material=s.register(s.candidate,session.bytes!,transfer[1]);if(!s.versions.versions.some(v=>v.version_id===s.candidate.version_id))s.versions.versions.unshift(structuredClone(s.candidate));}return reply(route,'MaterialResponse',session.material);}
    }
    if(method==='POST'&&path===base+'/prospectus-versions/current'){
      check('ProspectusVersionSelectRequest',body);s.selections.push(structuredClone(body));const prior=s.receipts.get(body.request_id);
      if(prior){expect(body).toEqual(prior.request);return reply(route,'ProspectusVersionsResponse',prior.response);}
      if(body.expected_selection_revision!==s.versions.selection_revision||!s.versions.versions.some(v=>v.version_id===body.version_id))return failure(route);
      s.versions.current_version_id=body.version_id;s.versions.selection_revision++;s.appliedSelections++;s.project.draft_revision++;for(const f of s.files)f.consistency={status:'stale',count:0,check_run_id:null};
      const response=projection(s);s.receipts.set(body.request_id,{request:structuredClone(body),response:structuredClone(response)});return reply(route,'ProspectusVersionsResponse',response);
    }
    const material=path.match(new RegExp('^'+base+'/materials/([^/]+)(/download)?$'));
    if(method==='GET'&&material){const stored=s.materials.get(decodeURIComponent(material[1]));if(!stored||url.searchParams.has('version')&&Number(url.searchParams.get('version'))!==stored.dto.material_version)return failure(route,404);return material[2]?route.fulfill({contentType:mime,body:stored.bytes}):reply(route,'MaterialResponse',stored.dto);}
    if(method==='GET'&&s.candidate.origin==='generated'&&path==='/artifacts/'+s.candidate.artifact_id){const artifact=generatedArtifact(s);s.artifactMetadataReads.push({artifact:structuredClone(artifact),callIndex:s.calls.length-1});return reply(route,'ArtifactResponse',artifact);}
    if(method==='GET'&&s.candidate.origin==='generated'&&path==='/artifacts/'+s.candidate.artifact_id+'/download'){
      const artifact=generatedArtifact(s),metadata=s.artifactMetadataReads.at(-1);expect(metadata,'A binary download must follow its exact metadata.').toBeDefined();expect(metadata!.artifact).toEqual(artifact);
      s.artifactTransfers.push({artifact:structuredClone(artifact),metadataCall:metadata!.callIndex,binaryCall:s.calls.length-1,sha256:hash(newBytes),byteSize:newBytes.byteLength});
      return route.fulfill({contentType:mime,body:newBytes});
    }
    s.unexpected.push(method+' '+path);return failure(route,501);
  });return s;
}
export async function ready(page:Page){await expect(page.locator('#pw-prospectus .prospectus-panel')).toBeVisible();await expect(page.locator('#refresh-files')).toBeEnabled();}
export async function open(page:Page,s=fixture(),entry='/#/projects/'+ids.project+'/files'){await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto(entry);if(entry.includes('#generate'))await expect(page.locator('#pf-prospectus .prospectus-panel')).toBeVisible();else await ready(page);await page.clock.runFor(80);return s;}
export async function upload(page:Page,s:State){
  const input=page.locator('#prospectus-version-file'),details=input.locator('xpath=ancestor::details[1]');
  if(!await details.evaluate(e=>(e as HTMLDetailsElement).open))await details.locator(':scope > summary').click();
  await input.setInputFiles({name:s.candidate.filename,mimeType:mime,buffer:newBytes});
  if(process.env.BB_PROSPECTUS_REFERENCE_DIR)await page.locator('#save-prospectus-version').click();
  // Bounded hashing yields through timers; the fixture deliberately freezes this clock.
  await expect.poll(async()=>{await page.clock.runFor(20);return page.locator('#prospectus-status').textContent();}).toMatch(/已保存.*尚未采用/);
  if(!process.env.BB_PROSPECTUS_REFERENCE_DIR)await expect(page.locator('#save-prospectus-version')).toBeHidden();
  expect(s.puts).toBe(1);expect(s.completions).toBe(1);
}
export async function reenter(page:Page){await page.locator('a.back-link[href="#tasks"]').click();await expect(page.locator('#project-list')).toHaveAttribute('aria-busy','false');const link=page.locator('[data-project-id="'+ids.project+'"] a.collection-title');await expect(link).toHaveAttribute('href','#/projects/'+ids.project+'/files');await link.click();await ready(page);await page.clock.runFor(80);}
export const history=(page:Page)=>page.locator('details[data-prospectus-history]');
export const version=(page:Page,id:string)=>page.locator('[data-prospectus-version="'+id+'"]');
export async function review(page:Page){await page.locator('[data-prospectus-saved-review]').click();await expect(history(page)).toHaveAttribute('open','');await expect(page.locator('[data-prospectus-history-summary]')).toBeFocused();}
export async function uploadJournal(page:Page){return page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('bondbuddy:upload-recovery:v1:')).sort().map(k=>[k,localStorage.getItem(k)])));}
export function assertFixture(s:State){assertState(s);expect(s.unexpected).toEqual([]);expect(s.errors).toEqual([]);expect(s.appliedSelections).toBe(s.receipts.size);}
export function noBusiness(s:State){const allowed=new RegExp('^/projects/'+ids.project+'/(?:materials/uploads(?:/[^/]+/(?:bytes|complete))?|prospectus-versions/current)$');expect(writes(s).filter(c=>!allowed.test(c.path))).toEqual([]);expect(s.calls.filter(c=>c.method!=='GET'&&/\/(?:execute|quote|credit-quote|checks|updates|batches|preflight|input-revisions)(?:\/|$)|^\/credits\//.test(c.path))).toEqual([]);expect(s.balance).toEqual({enabled:true,available:100000,frozen:0});assertFixture(s);}
export function fixedUnchanged(s:State,before:ReturnType<typeof fixedSnapshot>){expect(fixedSnapshot(s)).toEqual(before);noBusiness(s);}
export async function verifyInstalled(page:Page){
  const s=installed.get(page);if(!s)return;assertFixture(s);
  // The page clock is deliberately frozen and diagnostics use fire-and-forget
  // fetches. Await actual route receipts with the runner clock before teardown.
  for(const event of ['verified','auto_save_requested'])await expect.poll(()=>s.downloadDiagnostics.filter(entry=>entry.detail.event===event).length,{timeout:5000,message:'Each real artifact transfer must reach '+event+' diagnostics.'}).toBe(s.artifactTransfers.length);
  assertDownloadProgress(s.downloadDiagnostics);
  expect(s.downloadDiagnostics.filter(entry=>entry.detail.event==='verified').map(entry=>entry.detail.artifact_id)).toEqual(s.artifactTransfers.map(transfer=>transfer.artifact.artifact_id));
  assertFixture(s);
}
