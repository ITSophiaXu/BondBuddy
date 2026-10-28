import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {expect,type Download,type Page,type Route} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {M4_DOCUMENT_TYPES,M4_DOCUMENT_BILLING_TASKS,M4_DOCUMENT_FIXED_PRICE,M4DraftRequestSchema,
  M4ViewRequestSchema,M4ExecuteRequestSchema,projectFileSchemas,schemas,
  type M4Artifact,type M4ArtifactPin,type M4DocumentType,type M4Draft,type M4DraftRequest,
  type M4ExecuteRequest,type M4QuoteRequest,type M4QuoteResponse,type M4Task,type M4ViewRequest,
  type ProjectFileCheck,type ProjectFileVersion,type ProjectFileWorkspace,type Run} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';

// A synthetic owner-scoped HTTP server projection. All UI uses the real main.ts
// route and native controls. It models immutable bytes, imports CAS/idempotency,
// draft/quote/execute and delivery registration; it does not prove real storage,
// model output, ledger settlement or an external Word application.
export const ids={owner:'word-roundtrip-owner-a',otherOwner:'word-roundtrip-owner-b',root:'word-roundtrip-root',
  otherRoot:'word-roundtrip-root-b',execution:'word-roundtrip-execution',topic:'word-roundtrip-topic',
  originalRun:'word-roundtrip-original-run',originalArtifact:'word-roundtrip-original-document',
  family:'word-roundtrip-init-family',version:'word-roundtrip-init-v1'};
export const now='2026-10-25T13:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
/** Small real OOXML ZIP, stored rather than compressed, with explicit text. */
export function docx(text:string):Buffer{
  const entries=[['[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml',`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${xml(text)}</w:t></w:r></w:p></w:body></w:document>`]];
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const[name,text]of entries){const filename=Buffer.from(name),bytes=Buffer.from(text),crc=crc32(bytes),h=Buffer.alloc(30),c=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(bytes.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(filename.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);
    local.push(h,filename,bytes);central.push(c,filename);offset+=h.length+filename.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export const originalBytes=docx('原始立项报告。原审批口径必须保留。');
export const editedFile={name:'立项报告_人工修改稿.docx',mimeType:mime,buffer:docx('原始立项报告。人工离线修改：新增2026年10月授信说明。')};
const sourceBytes=docx('当前募集说明书，2026年10月固定依据。');
const issuerBytes=docx('发行人基本情况，第二类当前项目文件。');
const pin=(a:M4Artifact):M4ArtifactPin=>({source_project_id:a.source_project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256});
export type Call={owner:string;method:string;path:string;search:string;body:unknown};
type ImportBody=Dto<'ProjectFileImportRequest'>;
type Material={owner:string;project:string;dto:Dto<'MaterialResponse'>;bytes:Buffer};
type Session={owner:string;project:string;declaration:Dto<'UploadCreateRequest'>;bytes?:Buffer;material?:Material};
type Options={mismatch?:'hash'|'version'|'project'|'missing-run'|'file-patch'|'plain-topic';registryFailure?:boolean;workspaceFailure?:boolean};
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,json:body});
const failure=(route:Route,status:number,code='DATA_UNAVAILABLE')=>json(route,status,{code,message:'Synthetic '+code,retryable:status>=500,correlation_id:'word-roundtrip-test',field_errors:[]});
const project=(id:string,name:string):Dto<'ProjectResponse'>=>({project_id:id,name,kind:'generation',issuer_name:'合成往返发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now});
export function fixture(options:Options={}){
  const rootProject=project(ids.root,'合成 Word 往返项目'),executionProject=project(ids.execution,'本项目文件生成工作区');
  const sourcePin={source_project_id:ids.root,material_id:'word-source-material',material_version:1,sha256:hash(sourceBytes)};
  const source:ProjectFileWorkspace['source']={project_id:ids.root,version_id:'word-source-v2',selection_revision:4,filename:'当前募集说明书_V2.docx',sequence:2,asset:{kind:'material',pin:sourcePin}};
  const artifact:M4Artifact={...{source_project_id:ids.execution,artifact_id:ids.originalArtifact,artifact_version:1,sha256:hash(originalBytes)},topic_id:ids.topic,run_id:ids.originalRun,
    document_type:'init',kind:'document',filename:'立项报告原稿_V1.docx',mime_type:mime,byte_size:originalBytes.length,created_at:now,base_artifact:null,input_hash:hash('original input'),revision_number:1};
  const material=(id:string,name:string,bytes:Buffer,scope=ids.root):Material=>({owner:ids.owner,project:scope,bytes,dto:{material_id:id,material_version:1,upload_id:'prior-'+id,role:'other',filename:name,media_type:mime,byte_size:bytes.length,sha256:hash(bytes),state:'persisted',persisted_at:now,error:null}});
  const sourceMaterial=material(sourcePin.material_id,source.filename,sourceBytes),issuer=material('word-issuer-material','发行人基本情况.docx',issuerBytes);
  const drafts={} as Record<M4DocumentType,M4Draft>;
  for(const type of M4_DOCUMENT_TYPES)drafts[type]={document_type:type,version:2,sha256:hash(type),updated_at:now,source_material:sourcePin,materials:[sourcePin],template:{template_id:'word-template-'+type,template_version:1,sha256:hash('template-'+type)},edit_base:null,scope:'whole',fields:{issuer_name:'合成往返发行人',market:'sse',offering:'private',broker:'合成券商'},requirements:[],supplemental_requirements:'原审批口径必须保留。',project_file:{project_id:ids.root,source_version_id:source.version_id,source_selection_revision:source.selection_revision}};
  const run=(id:string,artifactId:string|null=artifact.artifact_id):Run=>({run_id:id,project_id:ids.execution,execution_request_id:'prior-'+id,input_revision:1,input_hash:hash(id),state:'succeeded',stage:'completed',channel:'production',test_grant_id:null,uncovered_items:[],event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:artifactId,prompt_snapshot_ref:null,updated_at:now});
  const originalTask:M4Task={run:run(ids.originalRun),manifest:{version:'m4-document-input-v1',kind:'document',topic_id:ids.topic,execution_scope_project_id:ids.root,draft_version:1,input:structuredClone(drafts.init),template_material:sourcePin,market:'sse',offering:'private',billing_task:M4_DOCUMENT_BILLING_TASKS.init},created_at:now,events:[],artifacts:[artifact]};
  const workspace:ProjectFileWorkspace['workspace']={topic:{topic_id:ids.topic,project_id:ids.execution,source_project_id:ids.root,name:executionProject.name,created_at:now,updated_at:now},project:executionProject,drafts,materials:[sourcePin],material_details:[{...sourcePin,filename:source.filename,state:'persisted',media_type:mime}],templates:M4_DOCUMENT_TYPES.map(type=>({template_id:'word-template-'+type,template_version:1,sha256:hash('template-'+type),name:'合成现有模板',broker:'合成券商',document_type:type,material:sourcePin,owner_scope:'private',market:'sse',offering:'private',status:'active',created_at:now,retired_at:null})),messages:[],tasks:[originalTask],artifacts:[artifact],pending_requirements:[],view:{selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},active_run:null};
  const registry:ProjectFileVersion[]=[{version_id:ids.version,file_id:ids.family,document_type:'init',filename:artifact.filename,sequence:1,asset:{kind:'artifact',pin:pin(artifact)},revision_asset:null,source_version_id:source.version_id,template_id:'word-template-init',template_version:1,source_name:source.filename,source_sequence:2,created_at:now,run_id:ids.originalRun,links:[],latest:true,version_count:1,consistency:{status:'unchecked',count:0,check_run_id:null}},
    {version_id:'word-issuer-v1',file_id:'word-issuer-family',document_type:'issuer',filename:issuer.dto.filename,sequence:1,asset:{kind:'material',pin:{source_project_id:ids.root,material_id:issuer.dto.material_id,material_version:1,sha256:issuer.dto.sha256}},revision_asset:null,source_version_id:source.version_id,template_id:null,template_version:null,source_name:source.filename,source_sequence:2,created_at:now,run_id:null,links:[],latest:true,version_count:1,consistency:{status:'unchecked',count:0,check_run_id:null}}];
  const state={owner:ids.owner as string,options,rootProject,executionProject,source,workspace,registry,artifact,run,
    calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],sessions:new Map<string,Session>(),materials:new Map([[sourcePin.material_id,sourceMaterial],[issuer.dto.material_id,issuer]]),
    artifactBytes:new Map([[artifact.artifact_id,originalBytes]]),imports:[] as ImportBody[],importReceipts:new Map<string,{body:ImportBody;versionId:string}>(),
    quotes:[] as M4QuoteRequest[],quoteSnapshots:new Map<string,M4Task['manifest']>(),executions:[] as M4ExecuteRequest[],checks:[] as ProjectFileCheck[],checkRequests:[] as Dto<'ProjectFileCheckRequest'>[],
    dropImportOnce:false,filesFailure:false,failFilesAfterImport:false,puts:0,readFiles:0};
  if(options.mismatch==='hash')workspace.artifacts[0]={...artifact,sha256:hash('same name wrong hash')};
  if(options.mismatch==='version')workspace.artifacts[0]={...artifact,artifact_version:2};
  if(options.mismatch==='project')workspace.artifacts[0]={...artifact,source_project_id:ids.otherRoot};
  if(options.mismatch==='missing-run')workspace.tasks=[];
  if(options.mismatch==='file-patch'){workspace.artifacts=[];workspace.tasks=[];}
  if(options.mismatch==='plain-topic')delete workspace.drafts.init.project_file;
  return state;
}
export type State=ReturnType<typeof fixture>;
export const writeCalls=(s:State)=>s.calls.filter(c=>c.method!=='GET');
export const importCalls=(s:State)=>s.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/project-files/imports'));
export const businessCalls=(s:State)=>s.calls.filter(c=>c.method!=='GET'&&/\/(?:quote|execute|checks|updates|credit-quote|answer)(?:\/|$)/.test(c.path));
export const originalPin=(s:State)=>pin(s.artifact);
export function appendMaterial(s:State,bytes:Buffer=docx('另一页面稍后保存的第三稿。'),name='立项报告_另页新稿.docx'){
  const current=s.registry.find(v=>v.file_id===ids.family&&v.latest)!;
  const id='word-import-material-'+(s.materials.size+1),dto:Dto<'MaterialResponse'>={material_id:id,material_version:1,upload_id:'prior-'+id,role:'other',filename:name,media_type:mime,byte_size:bytes.length,sha256:hash(bytes),state:'persisted',persisted_at:now,error:null};
  s.materials.set(id,{owner:ids.owner,project:ids.root,dto,bytes});
  return appendVersion(s,current,{kind:'material',pin:{source_project_id:ids.root,material_id:id,material_version:1,sha256:dto.sha256}},name);
}
function appendVersion(s:State,current:ProjectFileVersion,asset:ProjectFileVersion['asset'],filename:string,runId:string|null=null,promote=true){
  const sequence=Math.max(...s.registry.filter(v=>v.file_id===current.file_id).map(v=>v.sequence))+1;
  if(promote)for(const item of s.registry)if(item.file_id===current.file_id)item.latest=false;
  const saved:ProjectFileVersion={...structuredClone(current),version_id:current.file_id+'-v'+sequence,sequence,filename,asset,revision_asset:null,run_id:runId,latest:promote,version_count:sequence,consistency:{status:'unchecked',count:0,check_run_id:null}};
  s.registry.push(saved);for(const item of s.registry)if(item.file_id===current.file_id)item.version_count=sequence;return saved;
}
function collection(s:State):Dto<'ProjectFilesResponse'>{
  return {project_id:ids.root,items:[{file_id:'word-source-material',file_key:'prospectus',project_id:ids.root,source:'material',filename:s.source.filename,version:1,display_version:2,sha256:s.source.asset.pin.sha256,created_at:now,folder:'2',run_id:null,current:true,latest:true,version_count:1},
    ...s.registry.map(v=>({file_id:v.asset.kind==='material'?v.asset.pin.material_id:v.asset.pin.artifact_id,file_key:'project-file:'+v.file_id,project_id:v.asset.pin.source_project_id,source:v.asset.kind,filename:v.filename,version:v.asset.kind==='material'?v.asset.pin.material_version:v.asset.pin.artifact_version,display_version:v.sequence,sha256:v.asset.pin.sha256,created_at:v.created_at,folder:v.document_type==='init'?'1' as const:'4.1' as const,run_id:v.run_id,current:false,latest:v.latest,version_count:v.version_count}))]};
}
export async function install(page:Page,s=fixture()){
  page.on('pageerror',error=>s.errors.push(error.message));
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length),method=req.method(),owner=s.owner;
    const body=method!=='GET'&&method!=='PUT'||method==='PUT'&&!path.endsWith('/bytes')?req.postData()?req.postDataJSON():null:null;
    s.calls.push({owner,method,path,search:url.search,body});
    if(path==='/me')return json(route,200,{user_id:owner,session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:owner,username:owner===ids.owner?'roundtrip_owner_a':'roundtrip_owner_b'});
    if(path==='/credits/balance')return json(route,200,{enabled:true,available:86000,frozen:0});
    if(path==='/projects')return json(route,200,{items:[{...(owner===ids.owner?s.rootProject:project(ids.otherRoot,'另一个账号的项目')),file_count:3,latest_run:null,latest_artifact:null,status:'draft'}],page:{has_more:false,next_cursor:null}});
    if(owner!==ids.owner){
      if(path===`/projects/${ids.otherRoot}`)return json(route,200,project(ids.otherRoot,'另一个账号的项目'));
      if(path===`/projects/${ids.otherRoot}/files`||path===`/projects/${ids.otherRoot}/tasks`)return json(route,200,{project_id:ids.otherRoot,items:[],page:{has_more:false,next_cursor:null}});
      if(path===`/projects/${ids.otherRoot}/project-files`)return json(route,200,{files:[]});
      if(path===`/projects/${ids.otherRoot}/prospectus-versions`)return json(route,200,{project_id:ids.otherRoot,current_version_id:null,selection_revision:0,inactive_material_ids:[],versions:[]});
      return failure(route,404,'NOT_FOUND');
    }
    if(path===`/projects/${ids.root}`)return json(route,200,s.rootProject);
    if(path===`/projects/${ids.execution}`)return json(route,200,s.executionProject);
    const base=`/projects/${ids.root}`;
    if(path===base+'/workpapers/library'&&method==='GET')return json(route,200,{items:[],total:0,offset:0,limit:60,source:s.source,checks:[]});
    if(path===base+'/tasks')return json(route,200,{project_id:ids.root,items:[],page:{has_more:false,next_cursor:null}});
    if(path===base+'/files'){s.readFiles++;return s.filesFailure?failure(route,503):json(route,200,collection(s));}
    if(path===base+'/project-files'&&method==='GET')return s.options.registryFailure?failure(route,503):json(route,200,{files:s.registry});
    if(path===base+'/project-files/workspace'&&method==='GET')return s.options.workspaceFailure?failure(route,503):json(route,200,{project_id:ids.root,source:s.source,workspace:s.workspace,files:s.registry,batches:[]});
    if(path===base+'/prospectus-versions')return json(route,200,{project_id:ids.root,current_version_id:s.source.version_id,selection_revision:s.source.selection_revision,inactive_material_ids:[],versions:[{version_id:s.source.version_id,sequence:s.source.sequence,origin:'upload',filename:s.source.filename,sha256:s.source.asset.pin.sha256,created_at:now,material_id:'word-source-material',material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}]});
    if(path===base+'/materials/uploads'&&method==='POST'){
      expect(Value.Check(schemas.UploadCreateRequest,body)).toBe(true);const declaration=body as Dto<'UploadCreateRequest'>;
      expect(declaration.role).toBe('other');const id='word-upload-'+(s.sessions.size+1);s.sessions.set(id,{owner,project:ids.root,declaration:structuredClone(declaration)});
      return json(route,201,{upload_id:id,state:'uploading',expires_at:'2099-01-01T00:00:00Z',max_bytes:104857600,upload_url:`/api/v1${base}/materials/uploads/${id}/bytes?cap=word-test`});
    }
    const transfer=path.match(new RegExp('^'+base+'/materials/uploads/([^/]+)/(bytes|complete)$'));
    if(transfer){const session=s.sessions.get(transfer[1]);if(!session||session.owner!==owner)return failure(route,404,'NOT_FOUND');
      if(method==='PUT'&&transfer[2]==='bytes'){const bytes=req.postDataBuffer()!;expect(bytes.length).toBe(session.declaration.byte_size);expect(hash(bytes)).toBe(session.declaration.sha256);session.bytes=bytes;s.puts++;return route.fulfill({status:204});}
      if(method==='POST'&&transfer[2]==='complete'){
        expect(body).toEqual({byte_size:session.declaration.byte_size,sha256:session.declaration.sha256});if(!session.bytes)return failure(route,422,'MATERIAL_UNREADABLE');
        if(!session.material){const dto:Dto<'MaterialResponse'>={...session.declaration,material_id:'material-'+transfer[1],material_version:1,upload_id:transfer[1],state:'persisted',persisted_at:now,error:null};session.material={owner,project:ids.root,dto,bytes:session.bytes};s.materials.set(dto.material_id,session.material);}
        return json(route,200,session.material.dto);
      }
    }
    const material=path.match(new RegExp('^'+base+'/materials/([^/]+)(/download)?$'));
    if(material&&method==='GET'){const stored=s.materials.get(material[1]);if(!stored||stored.owner!==owner||stored.project!==ids.root||url.searchParams.has('version')&&Number(url.searchParams.get('version'))!==stored.dto.material_version)return failure(route,404,'NOT_FOUND');
      return material[2]?route.fulfill({status:200,contentType:mime,body:stored.bytes}):json(route,200,stored.dto);
    }
    if(path===base+'/project-files/imports'&&method==='POST'){
      expect(Value.Check(projectFileSchemas.ProjectFileImportRequest,body)).toBe(true);const input=body as ImportBody;s.imports.push(structuredClone(input));
      const old=s.importReceipts.get(input.request_id);
      if(old){expect(input).toEqual(old.body);return json(route,200,{files:s.registry});}
      const current=s.registry.find(v=>v.latest&&v.document_type===input.document_type);
      if((current?.version_id??null)!==input.expected_latest_version_id)return failure(route,409,'INPUT_REVISION_CONFLICT');
      expect(input.material.source_project_id).toBe(ids.root);const stored=s.materials.get(input.material.material_id);
      expect(stored?.owner).toBe(owner);expect(stored?.dto.material_version).toBe(input.material.material_version);expect(stored?.dto.sha256).toBe(input.material.sha256);
      if(!current||!stored)return failure(route,422,'INPUT_REQUIRED');
      const saved=appendVersion(s,current,{kind:'material',pin:input.material},stored.dto.filename);s.importReceipts.set(input.request_id,{body:structuredClone(input),versionId:saved.version_id});
      if(s.failFilesAfterImport)s.filesFailure=true;
      if(s.dropImportOnce){s.dropImportOnce=false;return route.abort('connectionreset');}
      return json(route,200,{files:s.registry});
    }
    if(path===base+'/project-files/checks'&&method==='GET')return json(route,200,{checks:s.checks});
    if(path===base+'/project-files/updates'&&method==='GET')return json(route,200,{batches:[]});
    if(path===base+'/project-files/checks'&&method==='POST'){
      expect(Value.Check(projectFileSchemas.ProjectFileCheckRequest,body)).toBe(true);const input=body as Dto<'ProjectFileCheckRequest'>;s.checkRequests.push(structuredClone(input));expect(input.expected_source_version_id).toBe(s.source.version_id);
      const latest=s.registry.filter(v=>v.latest),runId='word-check-'+s.checks.length;
      s.checks.unshift({run_id:runId,state:'queued',stage:'queued',created_at:now,source:structuredClone(s.source),stale:false,sha256:null,result:null,updates:[],files:latest.map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence}))});
      return json(route,200,{run_id:runId});
    }
    if(path==='/m4/topics'&&method==='GET')return json(route,200,{topics:[s.workspace.topic]});
    const m4=`/m4/topics/${ids.topic}`;
    if(path===m4+'/workspace'&&method==='GET')return json(route,200,s.workspace);
    if(path===m4+'/drafts/init'&&method==='PUT'){
      expect(Value.Check(M4DraftRequestSchema,body)).toBe(true);const input=body as M4DraftRequest,current=s.workspace.drafts.init;if(input.expected_version!==current.version)return failure(route,409,'INPUT_REVISION_CONFLICT');
      const {version:_v,sha256:_s,updated_at:_t,...previous}=current;
      const next={...input.input,version:current.version+1,sha256:hash(JSON.stringify(input.input)),updated_at:now};
      s.workspace.drafts.init=Value.Equal(previous,input.input)?current:next;
      return json(route,200,{draft:s.workspace.drafts.init});
    }
    if(path===m4+'/view'&&method==='PUT'){
      expect(Value.Check(M4ViewRequestSchema,body)).toBe(true);const input=body as M4ViewRequest;if(input.expected_version!==s.workspace.view.version)return failure(route,409,'INPUT_REVISION_CONFLICT');
      s.workspace.view={...input.view,version:input.expected_version+1};return json(route,200,{view:s.workspace.view});
    }
    if(path===m4+'/quote'&&method==='POST'){
      const input=body as M4QuoteRequest;s.quotes.push(structuredClone(input));expect(input).toEqual({kind:'document',document_type:'init',expected_draft_version:s.workspace.drafts.init.version});
      const saved=s.workspace.drafts.init,quoteId='word-quote-'+s.quotes.length,resolved=structuredClone(saved);
      resolved.project_file={...resolved.project_file!,expected_file_version_id:s.registry.find(v=>v.file_id===ids.family&&v.latest)?.version_id??null};
      const {version:_v,sha256:_s,updated_at:_t,...draftInput}=resolved;
      s.quoteSnapshots.set(quoteId,{version:'m4-document-input-v1',kind:'document',topic_id:ids.topic,execution_scope_project_id:ids.root,draft_version:saved.version,input:draftInput,template_material:saved.source_material,market:'sse',offering:'private',billing_task:M4_DOCUMENT_BILLING_TASKS.init});
      const response:M4QuoteResponse={quote:{quote_id:quoteId,topic_id:ids.topic,input_hash:hash(JSON.stringify(draftInput)),task_type:M4_DOCUMENT_BILLING_TASKS.init,points:M4_DOCUMENT_FIXED_PRICE.points,price_version:M4_DOCUMENT_FIXED_PRICE.version,reason:'沿用现有 M4 文件生成报价；成功交付后结算。',created_at:now,expires_at:'2099-01-01T00:00:00Z',billing_policy:'on_delivery',billing_method:'fixed',amount_semantics:'fixed_price',multiplier:1},balance:{available:86000,frozen:0},shortage:0};
      return json(route,200,response);
    }
    if(path===m4+'/execute'&&method==='POST'){
      expect(Value.Check(M4ExecuteRequestSchema,body)).toBe(true);const input=body as M4ExecuteRequest;s.executions.push(structuredClone(input));
      const old=s.workspace.tasks.find(t=>t.run.execution_request_id===input.execution_request_id);if(old)return json(route,200,{run:old.run});
      const manifest=s.quoteSnapshots.get(input.quote_id);expect(manifest?.kind).toBe('document');if(!manifest||manifest.kind!=='document')return failure(route,409,'INPUT_REVISION_CONFLICT');
      expect(input.expected_draft_version).toBe(manifest.draft_version);expect(manifest.input.edit_base).not.toBeNull();
      const bytes=docx('生成的新稿。'+manifest.input.supplemental_requirements),id='word-generated-document',runId='word-generated-run';
      const output:M4Artifact={...s.artifact,artifact_id:id,run_id:runId,filename:'立项报告新稿_V2.docx',sha256:hash(bytes),byte_size:bytes.length,base_artifact:manifest.input.edit_base,revision_number:2};
      const task:M4Task={run:{...s.run(runId,id),execution_request_id:input.execution_request_id},manifest:structuredClone(manifest),created_at:now,events:[],artifacts:[output]};
      s.workspace.tasks.push(task);s.workspace.artifacts.push(output);s.artifactBytes.set(id,bytes);
      const current=s.registry.find(v=>v.file_id===ids.family&&v.latest)!;appendVersion(s,current,{kind:'artifact',pin:pin(output)},output.filename,runId,current.version_id===manifest.input.project_file?.expected_file_version_id);
      return json(route,200,{run:task.run});
    }
    const m4Artifact=path.match(/^\/m4\/artifacts\/([^/]+)\/versions\/(\d+)\/(preview|bytes)$/);
    if(m4Artifact&&method==='GET'){const a=s.workspace.artifacts.find(a=>a.artifact_id===m4Artifact[1]&&a.artifact_version===Number(m4Artifact[2])),bytes=s.artifactBytes.get(m4Artifact[1]);if(!a||!bytes)return failure(route,404,'NOT_FOUND');return m4Artifact[3]==='bytes'?route.fulfill({status:200,contentType:mime,body:bytes}):json(route,200,{artifact:a,content:bytes.toString('utf8').match(/<w:t>(.*?)<\/w:t>/)?.[1]??'合成正文'});}
    const artifact=path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
    if(artifact&&method==='GET'){const a=s.workspace.artifacts.find(a=>a.artifact_id===artifact[1]),bytes=s.artifactBytes.get(artifact[1]);if(!a||!bytes)return failure(route,404,'NOT_FOUND');return artifact[2]?route.fulfill({status:200,contentType:mime,body:bytes}):json(route,200,{artifact_id:a.artifact_id,run_id:a.run_id,version:a.artifact_version,filename:a.filename,media_type:mime,sha256:a.sha256,quality_status:'passed',delivery_status:'available',download_url:`/api/v1/artifacts/${a.artifact_id}/download?grant=synthetic`,expires_at:'2099-01-01T00:00:00Z'} satisfies Dto<'ArtifactResponse'>);}
    const readRun=path.match(/^\/runs\/([^/]+)$/);if(readRun&&method==='GET'){const task=s.workspace.tasks.find(t=>t.run.run_id===readRun[1]);if(task)return json(route,200,task.run);}
    s.unexpected.push(method+' '+path);return failure(route,500);
  });
  return s;
}
export async function openFiles(page:Page,root=ids.root){await page.goto(`/#/projects/${root}/files`);await expect(page.locator('#file-list')).toBeVisible();}
export async function downloadBytes(download:Download){expect(await download.failure()).toBeNull();const path=await download.path();expect(path).not.toBeNull();return readFile(path!);}
export function assertFixture(s:State){expect(s.unexpected).toEqual([]);expect(s.errors).toEqual([]);}
