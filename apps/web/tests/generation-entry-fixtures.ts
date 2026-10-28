import {clearRows,addDocuments,selectedRows} from './file-generation-rows';
import {expect,type Page,type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import {PROJECT_DOCUMENT_CATALOG,m4Schemas,projectFileSchemas,type M4DocumentType,type M4Draft,type M4DraftRequest,type M4Template,type ProjectFileBatch,type ProjectFileWorkspace} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import type {FileGenerationBatchRequest} from '../src/file-generation-cache';

// Owner-scoped synthetic HTTP, real main.ts routes and native controls. These
// fixtures do not execute a model, settle credits or prove external persistence.
export const ids={owner:'generation-entry-owner',api:'generation-entry-api-P',other:'generation-entry-api-P2',
  source:'generation-entry-source-S',navigation:'generation-entry-navigation-N',topic:'generation-entry-topic'};
export const now='2026-10-25T14:00:00Z',sha='a'.repeat(64),templateSha='b'.repeat(64);
export const note='请在原范围保留待核实事项，并保留各文件已有的专业要求。';
export const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const file={name:'原范围补充依据.docx',mimeType:mime,buffer:Buffer.from('synthetic generation entry original bytes')};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export type Call={method:string;path:string;body:unknown};
type Session={project:string;declaration:Dto<'UploadCreateRequest'>;received:boolean;material?:Dto<'MaterialResponse'>};
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,json:body});
export const key=(kind:string,project=ids.api,owner=ids.owner)=>`bondbuddy:file-generation:${encodeURIComponent(owner)}:${encodeURIComponent(project)}:${kind}`;
export const href=(extra:Record<string,string>={},project=ids.api,navigation=ids.api)=>'#generate?'+new URLSearchParams({project,return_project:navigation,...extra});
export const writes=(s:State)=>s.calls.filter(c=>c.method!=='GET');
export const drafts=(s:State)=>s.calls.filter(c=>c.method==='PUT'&&c.path.startsWith(`/m4/topics/${ids.topic}/drafts/`));
export const batches=(s:State,project=ids.api)=>s.calls.filter(c=>c.method==='POST'&&c.path===`/projects/${project}/project-files/batches`);
export const templateWrites=(s:State)=>s.calls.filter(c=>c.method==='POST'&&c.path==='/m4/templates');
export const selected=selectedRows;
export const query=(page:Page)=>page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
export async function raw(page:Page,kind:string,project=ids.api,owner=ids.owner){return page.evaluate(k=>sessionStorage.getItem(k),key(kind,project,owner));}

export function workspace(project=ids.api):ProjectFileWorkspace{
  const source={project_id:ids.source,version_id:'source-v3',selection_revision:7,filename:'募集说明书_V3.docx',sequence:3,
    asset:{kind:'material' as const,pin:{source_project_id:ids.source,material_id:'source-material',material_version:1,sha256:sha}}};
  const templates:M4Template[]=PROJECT_DOCUMENT_CATALOG.map(d=>({template_id:`template-${d.id}`,template_version:1,sha256:templateSha,
    name:`合成${d.name}模板`,broker:'原券商',document_type:d.id,
    material:{source_project_id:project,material_id:`template-material-${d.id}`,material_version:1,sha256:templateSha},
    owner_scope:'private',market:'sse',offering:'private',status:'active',created_at:now,retired_at:null}));
  const all={} as Record<M4DocumentType,M4Draft>;
  for(const d of PROJECT_DOCUMENT_CATALOG)all[d.id]={document_type:d.id,version:1,sha256:sha,updated_at:now,
    project_file:{project_id:project,source_version_id:source.version_id,source_selection_revision:source.selection_revision},
    source_material:source.asset.pin,materials:[],template:{template_id:`template-${d.id}`,template_version:1,sha256:templateSha},edit_base:null,scope:'whole',
    fields:{issuer_name:'合成发行人',market:'sse',offering:'private',broker:'原券商'},
    requirements:[{requirement_id:`professional-${d.id}`,text:`${d.name}已有专业要求`,message_id:`message-${d.id}`,message_version:1}],
    supplemental_requirements:`${d.name}原有补充要求`};
  return {project_id:project,source,files:[],batches:[],workspace:{
    topic:{topic_id:ids.topic,project_id:'generation-entry-execution',source_project_id:project,name:'合成文件工作区',created_at:now,updated_at:now},
    project:{project_id:'generation-entry-execution',name:'合成文件工作区',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now},
    drafts:all,templates,materials:[],material_details:[],messages:[],tasks:[],artifacts:[],pending_requirements:[],
    view:{selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},active_run:null}};
}

export async function fixture(page:Page){
  const state={owner:ids.owner as string,calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],
    workspaces:new Map([[ids.api,workspace()],[ids.other,workspace(ids.other)]]),workspaceMissing:false,
    batchFailure:undefined as 'network'|{status:409;code:'INPUT_REVISION_CONFLICT'|'PROJECT_FILE_BATCH_INPUT_EXPIRED'}|undefined,batchState:'complete' as 'complete'|'running',
    failDraft:undefined as M4DocumentType|undefined,dropDraft:undefined as M4DocumentType|undefined,dropTemplate:false,
    sessions:new Map<string,Session>(),materials:new Map<string,Dto<'MaterialResponse'>>(),templates:new Map<string,M4Template>(),puts:0};
  page.on('pageerror',error=>state.errors.push(error.message));
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.replace('/api/v1',''),method=req.method();
    const body=method==='PUT'&&path.endsWith('/bytes')?undefined:req.postData()?req.postDataJSON():undefined;
    state.calls.push({path,method,body});
    if(path==='/me')return json(route,200,{user_id:state.owner,session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:state.owner,username:'synthetic_entry_owner',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/credits/balance')return json(route,200,{enabled:true,available:86000,frozen:0});
    if(path==='/projects')return json(route,200,{items:[],page:{next_cursor:null,has_more:false}});
    if([ids.api,ids.other,ids.source,ids.navigation].some(p=>path===`/projects/${p}`))return json(route,200,{project_id:path.split('/').at(-1),name:path.endsWith(ids.navigation)?'原导航项目':'合成关联文件项目',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now});
    if(/^\/projects\/[^/]+\/tasks$/.test(path))return json(route,200,{project_id:path.split('/')[2],items:[],page:{has_more:false,next_cursor:null}});
    if(/^\/projects\/[^/]+\/files$/.test(path))return json(route,200,{project_id:path.split('/')[2],items:[]});
    if(/^\/projects\/[^/]+\/project-files$/.test(path)&&method==='GET')return json(route,200,{files:[]});
    if(method==='GET'&&[ids.api,ids.other].some(p=>path===`/projects/${p}/workpapers/library`))return json(route,200,{items:[],total:0,offset:0,limit:30,source:null,checks:[]});
    const work=path.match(/^\/projects\/([^/]+)\/project-files\/workspace$/);
    if(work){if(method==='GET'&&state.workspaceMissing){state.workspaceMissing=false;return json(route,404,{code:'NOT_FOUND'});}return json(route,200,state.workspaces.get(work[1]));}
    if(path===`/projects/${ids.source}/prospectus-versions`){
      const s=state.workspaces.get(ids.api)!.source!;
      return json(route,200,{project_id:ids.source,current_version_id:s.version_id,selection_revision:s.selection_revision,inactive_material_ids:[],versions:[{version_id:s.version_id,sequence:s.sequence,origin:'upload',filename:s.filename,sha256:sha,created_at:now,material_id:'source-material',material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}]});
    }
    const source=path.match(/^\/projects\/([^/]+)\/project-files\/source$/);
    if(source&&method==='POST')return json(route,200,state.workspaces.get(source[1]));
    const draft=path.match(new RegExp(`^/m4/topics/${ids.topic}/drafts/([^/]+)$`));
    if(draft&&method==='PUT'){
      expect(Value.Check(m4Schemas.M4DraftRequest,body)).toBe(true);
      const input=body as M4DraftRequest,type=draft[1] as M4DocumentType,w=state.workspaces.get(input.input.project_file!.project_id)!,current=w.workspace.drafts[type];
      expect(input.input.document_type).toBe(type);expect(input.expected_version).toBe(current.version);
      if(state.failDraft===type){state.failDraft=undefined;return json(route,503,{code:'DATA_UNAVAILABLE'});}
      w.workspace.drafts[type]={...input.input,version:current.version+1,sha256:String(current.version+1).padStart(64,'0'),updated_at:now};
      if(state.dropDraft===type){state.dropDraft=undefined;return route.abort('connectionreset');}
      return json(route,200,{draft:w.workspace.drafts[type]});
    }
    if(path===`/m4/topics/${ids.topic}/materials`&&method==='POST')return route.fulfill({status:204});
    const create=path.match(/^\/projects\/([^/]+)\/materials\/uploads$/);
    if(create&&method==='POST'){const id=`entry-upload-${state.sessions.size+1}`;state.sessions.set(id,{project:create[1],declaration:body,received:false});return json(route,201,{upload_id:id,state:'uploading',upload_url:`/api/v1/projects/${create[1]}/materials/uploads/${id}/bytes`,expires_at:'2099-01-01T00:00:00Z',max_bytes:100000000});}
    const transfer=path.match(/^\/projects\/([^/]+)\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
    if(transfer){const session=state.sessions.get(transfer[2]);if(!session||session.project!==transfer[1])return json(route,404,{code:'NOT_FOUND'});
      if(method==='PUT'&&transfer[3]==='bytes'){const bytes=req.postDataBuffer()!;expect(bytes.length).toBe(session.declaration.byte_size);expect(hash(bytes)).toBe(session.declaration.sha256);session.received=true;state.puts++;return route.fulfill({status:204});}
      if(method==='POST'&&transfer[3]==='complete'){expect(body).toEqual({byte_size:session.declaration.byte_size,sha256:session.declaration.sha256});expect(session.received).toBe(true);if(!session.material){session.material={...session.declaration,material_id:`material-${transfer[2]}`,material_version:1,upload_id:transfer[2],state:'persisted',persisted_at:now,error:null};state.materials.set(session.material.material_id,session.material);}return json(route,200,session.material);}
    }
    const material=path.match(/^\/projects\/([^/]+)\/materials\/([^/]+)$/);
    if(material&&method==='GET'){const m=state.materials.get(material[2]);return m?json(route,200,m):json(route,404,{code:'NOT_FOUND'});}
    if(path==='/m4/templates'&&method==='POST'){
      const request=body as Parameters<import('../src/m4-api').M4Api['template']>[0];let t=state.templates.get(request.creation_request_id);
      if(!t){t={...request,template_id:`entry-saved-template-${state.templates.size+1}`,template_version:1,sha256:request.material.sha256,owner_scope:'private',market:request.market!,offering:request.offering!,status:'active',created_at:now,retired_at:null};state.templates.set(request.creation_request_id,t);state.workspaces.get(ids.api)!.workspace.templates.push(t);}
      if(state.dropTemplate){state.dropTemplate=false;return route.abort('connectionreset');}return json(route,200,{template:t});
    }
    const batch=path.match(/^\/projects\/([^/]+)\/project-files\/batches$/);
    if(batch&&method==='POST'){
      expect(Value.Check(projectFileSchemas.ProjectFileBatchRequest,body)).toBe(true);
      if(state.batchFailure){const failure=state.batchFailure;state.batchFailure=undefined;if(failure==='network')return route.abort('connectionreset');return json(route,failure.status,{code:failure.code,retryable:false});}
      const input=body as FileGenerationBatchRequest,result:ProjectFileBatch={batch_id:'entry-batch-'+batches(state,batch[1]).length,state:state.batchState,items:input.documents.map(d=>({document_type:d.document_type,run_id:null,state:state.batchState==='running'?'queued':'succeeded',error:null}))};
      state.workspaces.get(batch[1])!.batches.unshift(result);return json(route,201,result);
    }
    state.unexpected.push(`${method} ${path}`);return json(route,500,{code:'DATA_UNAVAILABLE'});
  });
  return state;
}
export type State=Awaited<ReturnType<typeof fixture>>;
export async function open(page:Page,extra:Record<string,string>={}){await page.goto('/'+href({step:'documents',...extra}));await expect(page.locator('#pf-generate')).toBeVisible();}
export async function choose(page:Page,types:M4DocumentType[]){await clearRows(page);await addDocuments(page,types);}
export async function confirm(page:Page){await page.locator('#pf-generate').click();await expect(page.locator('#pf-confirm-generation')).toBeVisible();}
export async function openFiles(page:Page){await page.goto(`/#/projects/${ids.api}/files`);await expect(page.locator('#file-list')).toBeVisible();}
export async function entry(page:Page,type:M4DocumentType){
  await openFiles(page);return clickEntry(page,type);
}
export async function clickEntry(page:Page,type:M4DocumentType){
  const details=page.locator('.pw-prepare');await details.locator('summary').click();
  const row=details.locator('.collection-file').filter({has:page.locator(`[data-import-type="${type}"]`)}),link=row.getByRole('link',{name:'准备生成',exact:true});
  const target=await link.getAttribute('href');await link.focus();await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#generate\?/);await expect(page.locator('#pf-source-next,#pf-retry-batch,#pf-reprepare,#pf-entry-retry').first()).toBeVisible();return target!;
}
export async function documents(page:Page){
  await expect(page.locator('#pf-source-next,#pf-generate').first()).toBeVisible();
  if(await page.locator('#pf-source-next').isVisible()){await expect(page.locator('#pf-prospectus .pf-selected-source')).toContainText(/V\d/);await page.locator('#pf-source-next').click();}
  await expect(page.locator('#pf-generate')).toBeVisible();
}
export function assertFixture(s:State){expect(s.unexpected).toEqual([]);expect(s.errors).toEqual([]);expect(s.calls.filter(c=>/\/(?:quote|execute|credit-quote|checks|updates|answer)(?:\/|$)/.test(c.path))).toEqual([]);}

type Control={read?:boolean;selection?:boolean;clearNote?:boolean;trace:string[]};
export async function installStorageControl(page:Page){
  await page.addInitScript(()=>{
    const control:Control={trace:[]};Object.assign(window,{entryCacheControl:control});
    const get=Storage.prototype.getItem,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
    Storage.prototype.getItem=function(k){if(k.startsWith('bondbuddy:file-generation:')&&control.read)throw new DOMException('Synthetic read blocked','SecurityError');return get.call(this,k);};
    Storage.prototype.setItem=function(k,v){if(k.startsWith('bondbuddy:file-generation:')){control.trace.push('set:'+k.split(':').at(-1));if(k.endsWith(':selection')&&control.selection)throw new DOMException('Synthetic selection blocked','QuotaExceededError');}return set.call(this,k,v);};
    Storage.prototype.removeItem=function(k){if(k.startsWith('bondbuddy:file-generation:')){control.trace.push('remove:'+k.split(':').at(-1));if(k.endsWith(':note')&&control.clearNote)throw new DOMException('Synthetic note clear blocked','SecurityError');}return remove.call(this,k);};
  });
}
export async function fault(page:Page,value:Partial<Control>){await page.evaluate(value=>Object.assign((window as unknown as {entryCacheControl:Control}).entryCacheControl,value),value);}
export async function trace(page:Page){return page.evaluate(()=>(window as unknown as {entryCacheControl:Control}).entryCacheControl.trace);}
