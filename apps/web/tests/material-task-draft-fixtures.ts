import {expect,type Page} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {M4_DOCUMENT_TYPES,M4DocumentManifestSchema,M4DraftInputSchema,type M4Artifact,type M4ArtifactPin,
  type M4DocumentType,type M4Draft,type M4DraftInput,type M4MaterialPin,type M4Requirement,type M4Task,type Run} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {fixture as wordFixture,install as installWord,assertFixture as assertWord,docx,hash,ids,now,mime,writeCalls} from './word-roundtrip-fixtures';

export {ids,now,hash,writeCalls};
export const taskRun='material-task-draft-history-init';
export const cacheKey='bb-m4:'+ids.owner+':'+ids.topic;
export const inputOf=(draft:M4Draft):M4DraftInput=>{const{version:_v,sha256:_s,updated_at:_u,...input}=draft;return structuredClone(input);};
export const artifactPin=(a:M4Artifact):M4ArtifactPin=>({source_project_id:a.source_project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256});
export const requirement=(id:string,text:string):M4Requirement=>({requirement_id:id,text,message_id:'message-'+id,message_version:2});
const materialKey=(pin:M4MaterialPin)=>[pin.source_project_id,pin.material_id,pin.material_version,pin.sha256].join(':');

// Extend the existing closed owner-scoped HTTP producer. The page is always
// main.ts's real #generate?topic=... route, never a hand-mounted component.
// All materials, immutable manifests, pending cache and bytes are synthetic.
export function fixture(state:Run['state']='failed'){
  const s=wordFixture(),materialVersions=new Map<string,{pin:M4MaterialPin;dto:Dto<'MaterialResponse'>}>();
  // The inherited producer copied draft response metadata into the historical
  // input. Retain that historical input, stripping only non-input metadata.
  for(const inherited of s.workspace.tasks)if(inherited.manifest.kind==='document')inherited.manifest.input=inputOf(inherited.manifest.input as M4Draft);
  for(const material of s.materials.values()){
    const pin={source_project_id:material.project,material_id:material.dto.material_id,material_version:material.dto.material_version,sha256:material.dto.sha256};
    materialVersions.set(materialKey(pin),{pin,dto:structuredClone(material.dto)});
  }
  const register=(id:string,name:string,version:number,text:string):M4MaterialPin=>{
    const bytes=docx(text),pin={source_project_id:ids.root,material_id:id,material_version:version,sha256:hash(bytes)};
    const dto:Dto<'MaterialResponse'>={material_id:id,material_version:version,upload_id:'synthetic-'+id+'-'+version,role:'other',filename:name,media_type:mime,byte_size:bytes.length,sha256:pin.sha256,state:'persisted',persisted_at:now,error:null};
    materialVersions.set(materialKey(pin),{pin,dto});s.materials.set(id,{owner:ids.owner,project:ids.root,dto,bytes});
    s.workspace.materials.push(pin);s.workspace.material_details.push({...pin,filename:name,state:'persisted',media_type:mime});return pin;
  };
  s.executionProject.name='合成历史任务与下一轮输入核对';s.workspace.project.name=s.executionProject.name;s.workspace.topic.name=s.executionProject.name;s.workspace.topic.surface='materials';
  const oldSource=register('material-task-shared-source','同名募集说明书.docx',1,'合成旧任务固定募集书，旧报告期。');
  const currentSource=register('material-task-shared-source','同名募集说明书.docx',2,'合成当前立项草稿募集书，新报告期。');
  const oldSupport=register('material-task-old-support','同名财务证明.docx',1,'合成旧任务支持材料。');
  const currentSupport=register('material-task-current-support','同名财务证明.docx',3,'合成当前立项支持材料。');
  const legalSource=register('material-task-legal-source','合成法律专用募集书.docx',4,'合成法律草稿专用募集书。');
  s.artifact.filename='同名立项底稿.docx';s.workspace.artifacts[0].filename=s.artifact.filename;s.workspace.tasks[0].artifacts[0].filename=s.artifact.filename;
  const baseBytes=docx('合成当前立项修改底稿，独立于历史失败任务。');
  const currentBase:M4Artifact={...structuredClone(s.artifact),artifact_id:'material-task-current-base',artifact_version:3,sha256:hash(baseBytes),byte_size:baseBytes.length,run_id:'material-task-current-base-run',revision_number:3};
  s.workspace.artifacts.push(currentBase);s.artifactBytes.set(currentBase.artifact_id,baseBytes);
  const currentBaseTask:M4Task={...structuredClone(s.workspace.tasks[0]),run:{...s.run(currentBase.run_id,currentBase.artifact_id)},artifacts:[currentBase]};
  s.workspace.tasks.push(currentBaseTask);
  const current=s.workspace.drafts.init;
  Object.assign(current,{source_material:currentSource,materials:[currentSupport],edit_base:artifactPin(currentBase),requirements:[requirement('material-task-current-one','当前立项已采纳要求一：保留金额单位。'),requirement('material-task-current-two','当前立项已采纳要求二：保留新报告期。')],
    supplemental_requirements:'当前立项草稿补充要求；绝不能恢复为旧任务要求。\n第二行保留完整。'});
  current.fields={...current.fields,issuer_name:'合成当前立项发行人',custom_current_only:'本轮新字段 <原样> & "引号"',custom_empty:'',broker:'合成当前券商'};
  current.project_file={...current.project_file!,source_version_id:'material-task-current-source-version',source_selection_revision:9,expected_file_version_id:ids.version};
  const legal=s.workspace.drafts.legal;legal.source_material=legalSource;legal.materials=[legalSource];legal.edit_base=null;
  legal.fields={...legal.fields,issuer_name:'合成法律草稿发行人',custom_legal_only:'法律草稿必须逐字保留'};
  legal.requirements=[requirement('material-task-legal','法律已采纳要求，不得被立项接续覆盖。')];legal.supplemental_requirements='法律草稿专用要求，不能被立项替换。';
  const submitted=inputOf(current);submitted.source_material=oldSource;submitted.materials=[oldSupport];submitted.edit_base=artifactPin(s.artifact);
  submitted.template={template_id:'material-task-old-template',template_version:1,sha256:hash('Synthetic old template')};
  submitted.fields={issuer_name:'合成历史任务发行人',market:'sse',offering:'private',broker:'合成旧券商',custom_old_only:'旧任务字段，不能恢复到当前草稿'};
  submitted.requirements=[requirement('material-task-submitted','历史任务已固定要求；不能覆盖当前立项草稿。')];submitted.supplemental_requirements='历史任务冻结补充要求。';
  submitted.project_file={project_id:ids.root,source_version_id:'material-task-old-source-version',source_selection_revision:1,expected_file_version_id:null};
  const task:M4Task={run:{...s.run(taskRun,null),state,stage:state==='paused'?'user_paused':state==='running'?'m4_document_prompt':'completed'},
    manifest:{version:'m4-document-input-v1',kind:'document',topic_id:ids.topic,execution_scope_project_id:ids.root,draft_version:1,input:submitted,template_material:oldSource,market:'sse',offering:'private',billing_task:'m4_G01'},
    created_at:'2026-10-24T10:00:00Z',events:[],artifacts:[]};
  s.workspace.tasks.push(task);s.workspace.active_run=['running','paused','queued','awaiting_input'].includes(state)?task.run:null;
  s.workspace.view.selected_document_type='init';s.workspace.view.workspace_tab='input';
  s.workspace.view.unsent_content='合成尚未发送的讨论文字，继续修改不得发送或清空。';
  s.workspace.view.unsent_context={document_type:'legal',draft_version:legal.version,source_material:legalSource,citations:[{kind:'material',ref:legalSource,locator:'合成法律第3页'}],reading_artifact:artifactPin(s.artifact)};
  s.workspace.view.quotation={citation:{kind:'material',ref:legalSource,locator:'合成法律第3页'},original_text:'合成尚未发送的准确引用。',anchor:'合成原文段落'};
  for(const req of [...current.requirements,...legal.requirements,...submitted.requirements])s.workspace.messages.push({message_id:req.message_id,version:req.message_version,role:'assistant',content:req.text,context:structuredClone(s.workspace.view.unsent_context),created_at:now,reply_status:'completed',reply_to:null,run_id:null,reply:{content:req.text,citations:[],requirements:[req.text],fields:{},intent:'draft',document_type:null,target_business:null,retrieval:'not_performed'},error:null});
  return Object.assign(s,{task,currentBase,oldSource,currentSource,oldSupport,currentSupport,legalSource,materialVersions,workspaceReads:0,projectionFaults:[] as string[]});
}
export type State=ReturnType<typeof fixture>;
const installed=new WeakMap<Page,State>();
export const routeFor=(run?:string)=>'/#generate?topic='+ids.topic+'&project='+ids.root+'&return_project='+ids.root+(run?'&run='+encodeURIComponent(run):'');
export const delivery=(page:Page)=>page.locator('.m4-delivery[data-run-id="'+taskRun+'"]');
export const prepare=(page:Page)=>delivery(page).locator('[data-m4-action="prepare"]');
export const comparison=(page:Page)=>page.locator('[data-material-task-draft]');
export const detail=(page:Page)=>page.locator('details[data-m4-detail="task-draft"]');
export const row=(page:Page,key:string)=>comparison(page).locator('[data-task-draft-row="'+key+'"]');
export const side=(page:Page,key:string,value:'submitted'|'current')=>row(page,key).locator('[data-task-draft-side="'+value+'"]');
export const selected=(page:Page)=>page.locator('[data-m4-type]:checked');
export const cache=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)??'null'),cacheKey);
export type LocalDraftSnapshot=Record<M4DocumentType,{version:number;input:M4DraftInput;dirty:boolean;conflict:boolean}>;
export async function localDrafts(page:Page):Promise<LocalDraftSnapshot>{
  await expect.poll(async()=>Object.keys((await cache(page))?.drafts??{}).sort()).toEqual([...M4_DOCUMENT_TYPES].sort());
  return structuredClone((await cache(page)).drafts);
}
export async function assertLocalDrafts(page:Page,before:LocalDraftSnapshot){await expect.poll(async()=>(await cache(page))?.drafts).toEqual(before);}
export const draftWrites=(s:State)=>writeCalls(s).filter(c=>/\/drafts\//.test(c.path));
export const viewWrites=(s:State)=>writeCalls(s).filter(c=>c.method==='PUT'&&c.path==='/m4/topics/'+ids.topic+'/view');
export function snapshot(s:State){return structuredClone({drafts:s.workspace.drafts,materials:s.workspace.materials,templates:s.workspace.templates,messages:s.workspace.messages,pending_requirements:s.workspace.pending_requirements,manifests:s.workspace.tasks.map(t=>({id:t.run.run_id,manifest:t.manifest})),artifacts:s.workspace.artifacts});}
export function noExecution(s:State){expect(s.quotes).toEqual([]);expect(s.executions).toEqual([]);expect(writeCalls(s).filter(c=>c.method!=='PUT'||(!c.path.includes('/drafts/')&&!c.path.endsWith('/view')))).toEqual([]);}
export function assertFixture(s:State){assertWord(s);noExecution(s);for(const d of Object.values(s.workspace.drafts))expect(Value.Check(M4DraftInputSchema,inputOf(d))).toBe(true);}
export async function install(page:Page,s=fixture()){
  await page.clock.install({time:new Date(now)});await page.clock.pauseAt(new Date(Date.parse(now)+1000));
  await installWord(page,s);installed.set(page,s);
  for(const task of s.workspace.tasks)if(task.manifest.kind==='document')expect(Value.Check(M4DocumentManifestSchema,task.manifest),'Public synthetic document manifest schema').toBe(true);
  await page.route('**/api/v1/m4/topics/*/workspace',async route=>{
    if(route.request().method()!=='GET')return route.fallback();s.workspaceReads++;
    s.calls.push({owner:s.owner,method:'GET',path:'/m4/topics/'+ids.topic+'/workspace',search:new URL(route.request().url()).search,body:null});
    return route.fulfill({json:structuredClone(s.workspace)});
  });
  await page.route('**/api/v1/projects/*/materials/*',async route=>{
    const request=route.request(),url=new URL(request.url()),match=url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/materials\/([^/]+)$/);
    if(request.method()!=='GET'||!match)return route.fallback();
    const material=[...s.materialVersions.values()].find(m=>m.pin.source_project_id===decodeURIComponent(match[1])&&m.pin.material_id===decodeURIComponent(match[2])&&(!url.searchParams.has('version')||m.pin.material_version===Number(url.searchParams.get('version'))));
    if(!material)return route.fallback();s.calls.push({owner:s.owner,method:'GET',path:url.pathname.slice('/api/v1'.length),search:url.search,body:null});return route.fulfill({json:structuredClone(material.dto)});
  });return s;
}
export async function frames(page:Page){await page.clock.runFor(80);}
export async function open(page:Page,s=fixture(),run?:string){await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto(routeFor(run));await expect(page.locator('#m4-content')).toBeVisible();await expect(page.locator('#m4-content')).toHaveAttribute('data-tab',run?'run:'+run:'input');await frames(page);return s;}
export async function chooseLegal(page:Page){await page.locator('[data-m4-type][value="legal"]').check();await expect(selected(page)).toHaveValue('legal');}
export async function openTask(page:Page){await page.locator('.m4-recent-run [data-m4-action="task"][data-run="'+taskRun+'"]').click();await expect(delivery(page)).toBeVisible();await expect(page.locator('#m4-content')).toHaveAttribute('data-tab','run:'+taskRun);}
export async function expand(page:Page){if(await detail(page).getAttribute('open')===null)await detail(page).locator(':scope > summary').click();await expect(detail(page)).toHaveAttribute('open','');}
export async function returnToInit(page:Page){await prepare(page).click();await expect(selected(page)).toHaveValue('init');await expect(page.locator('#m4-content')).toHaveAttribute('data-tab','input');}
export async function assertUnchanged(page:Page,s:State,before:ReturnType<typeof snapshot>){expect(snapshot(s)).toEqual(before);expect(draftWrites(s)).toEqual([]);noExecution(s);assertFixture(s);}
export async function verifyInstalled(page:Page){const s=installed.get(page);if(s)assertFixture(s);}
export async function seedCache(page:Page,s:State,options:{dirtyInit?:boolean;pending?:boolean}={}){
  const drafts=Object.fromEntries(M4_DOCUMENT_TYPES.map(type=>[type,{version:s.workspace.drafts[type].version,input:inputOf(s.workspace.drafts[type]),dirty:false,conflict:false}]));
  if(options.dirtyInit){drafts.init.input.supplemental_requirements='合成本机尚未保存的立项要求，必须优先保留。';drafts.init.dirty=true;}
  const{version:viewVersion,...view}=structuredClone(s.workspace.view);
  const pendingMessage=options.pending?{request:{submission_request_id:'material-task-original-message',content:'合成原问题，结果未知，不得自动重发。',context:structuredClone(view.unsent_context),quote_id:'material-task-original-message-quote',execute:false},viewContent:'合成原问题，结果未知，不得自动重发。'}:undefined;
  const pendingExecution=options.pending?{execution_request_id:'material-task-original-execution',document_type:'legal',expected_draft_version:s.workspace.drafts.legal.version,quote_id:'material-task-original-execution-quote',entrypoint:'workspace'}:undefined;
  const value={owner:ids.owner,topic:ids.topic,drafts,view,viewVersion,viewDirty:false,pendingMessage,pendingExecution};
  await page.addInitScript(({key,value})=>{if(location.protocol==='http:'||location.protocol==='https:')if(localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify(value));},{key:cacheKey,value});return value;
}
export async function poll(page:Page,s:State){const reads=s.workspaceReads;await page.clock.runFor(2300);await expect.poll(()=>s.workspaceReads).toBeGreaterThan(reads);await frames(page);}
export async function refreshBehindSelection(page:Page,s:State){
  const reads=s.workspaceReads;await page.evaluate(()=>{const title=document.querySelector('.m4-delivery h2')!;const range=document.createRange();range.selectNodeContents(title);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);window.dispatchEvent(new Event('online'));});
  await expect.poll(()=>s.workspaceReads).toBe(reads+1);await frames(page);
}
