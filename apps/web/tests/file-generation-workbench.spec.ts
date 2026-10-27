import {documentChoice,clearRows,addDocuments,selectedRows} from './file-generation-rows';
import {expect,test,type Page,type Route} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {PROJECT_DOCUMENT_CATALOG,M4_DOCUMENT_FIXED_PRICE,m4Schemas,projectFileSchemas,
  type M4DocumentType,type M4Draft,type M4DraftRequest,type M4Template,
  type ProjectFileBatch,type ProjectFileWorkspace} from '@bondbuddy/contracts';
import type {FileGenerationBatchRequest} from '../src/file-generation-cache';

// Synthetic HTTP fixtures exercise preparation and request recovery. They do not run
// a model, persist production documents, charge credits, or upload external content.
const sourceProject='synthetic-source-S',apiProject='synthetic-api-P',otherApiProject='synthetic-api-P2';
const navigationProject='synthetic-navigation-N',owner='synthetic-file-owner',topic='synthetic-file-topic';
const now='2026-10-25T04:00:00Z',sha='a'.repeat(64),templateSha='b'.repeat(64);
type Call={method:string;path:string;body:unknown};
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
const href=(project=apiProject,extra:Record<string,string>={})=>'#generate?'+new URLSearchParams({project,return_project:navigationProject,...extra});
const batchPath=(project=apiProject)=>`/projects/${project}/project-files/batches`;
const draftPath=(type:M4DocumentType)=>`/m4/topics/${topic}/drafts/${type}`;
const draftWrites=(calls:Call[])=>calls.filter(c=>c.method==='PUT'&&c.path.startsWith(`/m4/topics/${topic}/drafts/`));
const batches=(calls:Call[],project=apiProject)=>calls.filter(c=>c.method==='POST'&&c.path===batchPath(project));

function workspace(project=apiProject):ProjectFileWorkspace{
  const source={project_id:sourceProject,version_id:'source-v3',selection_revision:7,filename:'募集说明书_V3.docx',sequence:3,
    asset:{kind:'material' as const,pin:{source_project_id:sourceProject,material_id:'source-material',material_version:1,sha256:sha}}};
  const templates:M4Template[]=PROJECT_DOCUMENT_CATALOG.map(d=>({template_id:`template-${d.id}`,template_version:1,sha256:templateSha,
    name:`合成${d.name}模板`,broker:'合成券商',document_type:d.id,
    material:{source_project_id:project,material_id:`template-material-${d.id}`,material_version:1,sha256:templateSha},
    owner_scope:'private',market:'sse',offering:'private',status:'active',created_at:now,retired_at:null}));
  const drafts={} as Record<M4DocumentType,M4Draft>;
  for(const d of PROJECT_DOCUMENT_CATALOG){drafts[d.id]={
    document_type:d.id,version:1,sha256:sha,updated_at:now,
    project_file:{project_id:project,source_version_id:source.version_id,source_selection_revision:source.selection_revision},
    source_material:source.asset.pin,materials:[],template:{template_id:`template-${d.id}`,template_version:1,sha256:templateSha},
    edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',offering:'private',broker:'合成券商'},
    requirements:[{requirement_id:`requirement-${d.id}`,text:`${d.name}的专业要求`,message_id:`message-${d.id}`,message_version:1}],
    supplemental_requirements:`${d.name}原有补充要求`,
  };}
  return {project_id:project,source,files:[],batches:[],workspace:{
    topic:{topic_id:topic,project_id:'synthetic-m4-execution',source_project_id:project,name:'合成文件工作区',surface:'materials',created_at:now,updated_at:now},
    project:{project_id:'synthetic-m4-execution',name:'合成文件工作区',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now},
    drafts,templates,materials:[],material_details:[],messages:[],tasks:[],artifacts:[],pending_requirements:[],
    view:{selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',
      unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},active_run:null,
  }};
}

async function fixture(page:Page){
  const state={owner,calls:[] as Call[],workspaces:new Map([[apiProject,workspace()],[otherApiProject,workspace(otherApiProject)]]),
    workspaceMissing:false,batchFailure:undefined as 401|408|429|'network'|{status:409;code:'INPUT_REVISION_CONFLICT'|'PROJECT_FILE_BATCH_INPUT_EXPIRED'}|undefined,
    failDraft:undefined as M4DocumentType|undefined,completeFailures:0,completed:false,holdComplete:undefined as Promise<void>|undefined,
    upload:undefined as undefined|{upload_id:string;filename:string;media_type:string;byte_size:number;sha256:string}};
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method();
    const body=path.startsWith('/synthetic-upload/')?undefined:req.postData()?req.postDataJSON():undefined;
    state.calls.push({path,method,body});
    if(path==='/me')return json(route,200,{user_id:state.owner,session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:state.owner,username:'synthetic_user',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/credits/balance')return json(route,200,{enabled:true,available:86000,frozen:0});
    if(path==='/projects')return json(route,200,{items:[],page:{next_cursor:null,has_more:false}});
    if([apiProject,otherApiProject,navigationProject,sourceProject].some(p=>path===`/projects/${p}`))return json(route,200,{
      project_id:path.split('/').at(-1),name:path.endsWith(navigationProject)?'原债券项目':'合成关联文件项目',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now});
    const workspaceMatch=path.match(/^\/projects\/([^/]+)\/project-files\/workspace$/);
    if(workspaceMatch){
      if(method==='GET'&&state.workspaceMissing){state.workspaceMissing=false;return json(route,404,{code:'NOT_FOUND'});}
      return json(route,200,state.workspaces.get(workspaceMatch[1]));
    }
    if([`/projects/${sourceProject}/prospectus-versions`,`/projects/${apiProject}/prospectus-versions`].includes(path)){
      const s=state.workspaces.get(apiProject)!.source;
      if(!s)return json(route,200,{project_id:apiProject,current_version_id:null,selection_revision:0,inactive_material_ids:[],versions:[]});
      return json(route,200,{project_id:sourceProject,current_version_id:s.version_id,selection_revision:s.selection_revision,inactive_material_ids:[],versions:[{
        version_id:s.version_id,sequence:s.sequence,origin:'upload',filename:s.filename,sha256:sha,created_at:now,material_id:'source-material',material_version:1,
        artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}]});
    }
    if(path===`/projects/${apiProject}/project-files/source`)return json(route,200,state.workspaces.get(apiProject));
    const draftMatch=path.match(new RegExp(`^/m4/topics/${topic}/drafts/([^/]+)$`));
    if(draftMatch&&method==='PUT'){
      expect(Value.Check(m4Schemas.M4DraftRequest,body)).toBe(true);
      const input=body as M4DraftRequest,type=draftMatch[1] as M4DocumentType;
      expect(input.input.document_type).toBe(type);
      const w=state.workspaces.get(input.input.project_file!.project_id)!,current=w.workspace.drafts[type];
      expect(input.expected_version).toBe(current.version);
      if(state.failDraft===type){state.failDraft=undefined;return json(route,503,{code:'DATA_UNAVAILABLE',retryable:true});}
      const saved:M4Draft={...input.input,version:current.version+1,sha256:String(current.version+1).padStart(64,'0'),updated_at:now};
      w.workspace.drafts[type]=saved;return json(route,200,{draft:saved});
    }
    if(path===`/m4/topics/${topic}/materials`&&method==='POST')return route.fulfill({status:204});
    if(path===`/projects/${apiProject}/materials/uploads`&&method==='POST'){
      const upload_id='synthetic-support-upload';state.upload={...body,upload_id};
      return json(route,201,{upload_id,state:'uploading',upload_url:`/api/v1/synthetic-upload/${upload_id}`,expires_at:'2030-01-01T00:00:00Z',max_bytes:100000000});
    }
    if(path.startsWith('/synthetic-upload/')&&method==='PUT')return route.fulfill({status:204});
    if(path===`/projects/${apiProject}/materials/synthetic-support-material`&&method==='GET')return state.completed&&new URL(req.url()).searchParams.get('version')==='1'?json(route,200,{...state.upload!,material_id:'synthetic-support-material',material_version:1,role:'other',state:'persisted',persisted_at:now,error:null}):json(route,404,{code:'NOT_FOUND'});
    if(path===`/projects/${apiProject}/materials/uploads/synthetic-support-upload/complete`&&method==='POST'){
      if(state.holdComplete)await state.holdComplete;
      if(state.completeFailures>0){state.completeFailures--;return json(route,503,{code:'DATA_UNAVAILABLE',retryable:true});}
      const u=state.upload!;expect(body).toEqual({sha256:u.sha256,byte_size:u.byte_size});
      state.completed=true;
      return json(route,200,{...u,material_id:'synthetic-support-material',material_version:1,role:'other',state:'persisted',persisted_at:now,error:null});
    }
    const batchMatch=path.match(/^\/projects\/([^/]+)\/project-files\/batches$/);
    if(batchMatch&&method==='POST'){
      expect(Value.Check(projectFileSchemas.ProjectFileBatchRequest,body)).toBe(true);
      if(state.batchFailure){const failure=state.batchFailure;state.batchFailure=undefined;
        if(failure==='network')return route.abort('failed');
        if(typeof failure==='object')return json(route,failure.status,{code:failure.code,retryable:false});
        return json(route,failure,{code:failure===401?'UNAUTHENTICATED':failure===429?'RATE_LIMITED':'DATA_UNAVAILABLE',retryable:failure!==401});
      }
      const input=body as FileGenerationBatchRequest;
      const batch:ProjectFileBatch={batch_id:'synthetic-batch',state:'complete',items:input.documents.map(d=>({document_type:d.document_type,run_id:null,state:'succeeded',error:null}))};
      state.workspaces.get(batchMatch[1])!.batches.unshift(batch);return json(route,201,batch);
    }
    return json(route,404,{code:'NOT_FOUND'});
  });
  return state;
}

async function open(page:Page,project=apiProject,extra:Record<string,string>={}){
  await page.goto('/'+href(project,extra));
  await expect(page.locator('#pf-generate')).toBeVisible();
}
async function choose(page:Page,types:M4DocumentType[]){await addDocuments(page,types);}
async function confirm(page:Page){await page.locator('#pf-generate').click();await expect(page.locator('#pf-confirm-generation')).toBeVisible();}
const supportFile={name:'合成补充依据.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 synthetic test content')};

for(const width of [1440,390])test(`support upload opens a multiple-file chooser from the keyboard at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:960});const s=await fixture(page);await open(page);
  const details=page.locator('#pf-support-details');if(await details.getAttribute('open')===null)await details.locator('summary').click();
  const upload=page.getByRole('button',{name:'上传补充依据',exact:true});
  await expect(upload).toBeDisabled();await expect(page.locator('#pf-support-upload-hint')).toContainText('先在上方添加');
  await choose(page,['init']);await expect(upload).toBeEnabled();await expect(page.locator('#pf-support-formats')).toContainText('100 MB');
  const chooser=page.waitForEvent('filechooser');await upload.press('Enter');const dialog=await chooser;expect(dialog.isMultiple()).toBe(true);await dialog.setFiles(supportFile);
  await expect(page.locator('#pf-support-feedback')).toContainText('补充依据已保存');
  expect(s.workspaces.get(apiProject)!.workspace.drafts.init.materials).toHaveLength(1);
  await expect(upload).toBeEnabled();expect(batches(s.calls)).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('support drop validates every file and cannot bypass selection or an active upload',async({page})=>{
  const s=await fixture(page);await open(page);
  const drop=async(names:string[])=>page.locator('#pf-support-upload').evaluate((node,names)=>{const transfer=new DataTransfer();for(const name of names)transfer.items.add(new File(['%PDF-1.4 synthetic upload'],name,{type:'application/pdf'}));const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});node.dispatchEvent(event);return event.defaultPrevented;},names);
  expect(await drop(['忽略.pdf'])).toBe(true);expect(s.calls.filter(c=>c.method==='POST')).toEqual([]);
  await choose(page,['init','underwriter']);await drop(['有效.pdf','不支持.txt']);
  await expect(page.locator('#pf-support-feedback')).toContainText('DOCX、PDF 或 XLSX');expect(s.calls.filter(c=>c.method==='POST')).toEqual([]);
  let release!:()=>void;s.holdComplete=new Promise<void>(resolve=>{release=resolve;});
  await drop(['拖拽依据.pdf']);await expect(page.locator('#pf-support-upload')).toBeDisabled();await expect(page.locator('#pf-support-upload')).toHaveAttribute('aria-busy','true');
  await expect.poll(()=>s.calls.filter(c=>c.path.endsWith('/complete')).length).toBe(1);
  await drop(['重复提交.pdf']);release();
  await expect(page.locator('#pf-support-feedback')).toContainText('补充依据已保存');
  expect(s.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.init.materials).toHaveLength(1);expect(s.workspaces.get(apiProject)!.workspace.drafts.underwriter.materials).toHaveLength(1);
  await expect(page.locator('#pf-support-upload')).toBeEnabled();expect(batches(s.calls)).toEqual([]);
});

test('prepared source opens document selection without preparation or initial bulk selection',async({page})=>{
  const dir=process.env.BB_UX_EVIDENCE_DIR;if(dir)await page.setViewportSize({width:1440,height:1000});
  const s=await fixture(page);await open(page);
  await expect(page.getByRole('heading',{name:'文件生成',exact:true})).toBeVisible();
  await expect(page.locator('select[data-pf-document]')).toHaveCount(1);
  await expect(page.locator('select[data-pf-document]:not([data-pf-document=""])')).toHaveCount(0);
  await expect(page.locator('#pf-requirements')).toHaveValue('');
  await expect(page.locator('#pf-generate')).toBeDisabled();
  await expect(page.locator('#pf-source-summary')).toContainText('募集说明书_V3.docx');
  await expect(page.locator('[data-project-context-name]')).toHaveText('原债券项目');
  await expect(page.getByRole('link',{name:'返回项目文件',exact:true})).toHaveAttribute('href',`#/projects/${navigationProject}/files`);
  expect(s.calls.filter(c=>c.method==='POST')).toEqual([]);
  expect(s.calls.filter(c=>c.path.endsWith('/project-files/workspace')).map(c=>c.method)).toEqual(['GET']);
  expect(new Set([sourceProject,apiProject,navigationProject]).size).toBe(3);
  if(dir){
    await mkdir(dir,{recursive:true});await choose(page,['init','underwriter']);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:join(dir,'file-generation-preparation-1440.png'),fullPage:true});
    await confirm(page);await page.screenshot({path:join(dir,'file-generation-confirmation-1440.png')});
    expect(batches(s.calls)).toHaveLength(0);
  }
});

test('workspace is prepared only after its initial GET returns 404',async({page})=>{
  const s=await fixture(page);s.workspaceMissing=true;await open(page);
  const calls=s.calls.filter(c=>c.path.endsWith('/project-files/workspace'));
  expect(calls.map(c=>c.method)).toEqual(['GET','POST']);
  expect(calls[1].body).toEqual({request_id:expect.any(String)});
  expect(batches(s.calls)).toHaveLength(0);
});

for(const mode of ['first','retry','replacement'] as const)test(`uploaded template immediately updates readiness and library: ${mode}`,async({page})=>{
  const s=await fixture(page),w=s.workspaces.get(apiProject)!.workspace;
  if(mode!=='replacement'){w.drafts.issuer.template=null;w.templates=w.templates.filter(t=>t.document_type!=='issuer');}
  const requests:unknown[]=[];let saved:M4Template|undefined;
  await page.route('**/api/v1/m4/templates',async route=>{
    const b=route.request().postDataJSON();requests.push(b);
    saved??={template_id:mode==='replacement'?'template-issuer':'uploaded-issuer',template_version:mode==='replacement'?2:1,sha256:b.material.sha256,name:b.name,broker:b.broker,document_type:b.document_type,material:b.material,owner_scope:'private',market:b.market,offering:b.offering,status:'active',created_at:now,retired_at:null};
    if(!w.templates.some(t=>t.template_id===saved!.template_id&&t.template_version===saved!.template_version))w.templates.push(saved);
    return json(route,200,{template:saved});
  });
  if(mode==='retry')s.failDraft='issuer';
  await open(page);await choose(page,['issuer']);await page.locator('[data-pf-template="issuer"]').click();
  await page.locator('#pf-template-form input[type=file]').setInputFiles({name:'首次模板.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic template bytes')});
  await page.getByRole('button',{name:'保存并用于本次生成',exact:true}).click();
  if(mode==='retry'){
    await expect(page.locator('#pf-modal-status')).not.toHaveText('正在保存…');
    await page.locator('dialog [data-close]').click();await page.locator('[data-generation-resume]').click();
  }
  await expect(page.locator('#pf-generate')).toBeEnabled();await expect(page.locator('#pf-template-list')).toContainText('首次模板.docx');
  await page.locator('[data-pf-template="issuer"]').click();await expect(page.locator('dialog .pf-template-row')).toContainText(['首次模板.docx']);
  expect(w.drafts.issuer.template).toEqual({template_id:saved!.template_id,template_version:saved!.template_version,sha256:saved!.sha256});
  expect(s.calls.filter(c=>c.method==='PUT'&&c.path.startsWith('/synthetic-upload/'))).toHaveLength(1);
  expect(new Set(requests.map(r=>JSON.stringify(r))).size).toBe(1);expect(batches(s.calls)).toEqual([]);
});

test('missing templates explain why only the selected package cannot run',async({page})=>{
  const s=await fixture(page);s.workspaces.get(apiProject)!.workspace.drafts.legal.template=null;await open(page);
  await choose(page,['legal']);
  await expect(page.locator('#pf-generate')).toBeDisabled();
  await expect(page.locator('#pf-package-readiness')).toContainText(/模板/);
  await expect(page.locator('#pf-template-list')).toContainText('法律意见书');
  await expect(page.locator('[data-pf-template=legal]')).toHaveText('添加模板');await page.locator('[data-pf-template=legal]').click();
  await expect(page.locator('dialog')).toContainText('法律意见书');await page.locator('dialog [data-close]').click();
  await clearRows(page);await choose(page,['init']);
  await expect(page.locator('#pf-footer-template')).toBeHidden();
  await expect(page.locator('#pf-generate')).toBeEnabled();
  expect(batches(s.calls)).toHaveLength(0);
});

test('scope and authoring fees are reviewed before an exact public batch request',async({page})=>{
  const s=await fixture(page);await open(page);await choose(page,['init','underwriter']);
  await expect(page.locator('#pf-price')).toContainText('9,000');
  await confirm(page);
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('立项报告');await expect(dialog).toContainText('主承销商核查意见');
  await expect(dialog).toContainText('9,000');
  await expect(dialog).toContainText(/4,500/);
  await expect(dialog).toContainText(/排队/);await expect(dialog).toContainText(/暂停/);
  await expect(dialog).toContainText(/停止|主动结束/);await expect(dialog).toContainText(/退回|退还|退款/);
  await expect(dialog).not.toContainText('交付后扣费');
  expect(M4_DOCUMENT_FIXED_PRICE.points).toBe(4500);expect(batches(s.calls)).toHaveLength(0);
  await page.locator('#pf-confirm-generation').click();
  await expect(page.getByRole('heading',{name:'文件生成任务'})).toBeVisible();
  expect(batches(s.calls).map(c=>c.body)).toEqual([{request_id:expect.any(String),source_version_id:'source-v3',expected_selection_revision:7,
    documents:[{document_type:'init',draft_version:1},{document_type:'underwriter',draft_version:1}]}]);
  expect(draftWrites(s.calls)).toHaveLength(0);
  expect(s.calls.some(c=>c.method==='POST'&&c.path.startsWith(`/projects/${navigationProject}/`))).toBe(false);
});

test('common requirements append only to selected files and confirmation captures saved draft versions',async({page})=>{
  const s=await fixture(page),before=structuredClone(s.workspaces.get(apiProject)!.workspace.drafts);
  await open(page);await choose(page,['init','underwriter']);
  await page.locator('#pf-requirements').fill('本轮统一保留待核实标记');
  await page.locator('#pf-save-requirements').click();
  await expect(page.locator('#pf-requirements')).toHaveValue('');
  await expect(page.locator('[data-pf-saved-requirements]').first()).toContainText('本轮统一保留待核实标记');
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('init'),draftPath('underwriter')]);
  for(const type of ['init','underwriter'] as const){
    const saved=s.workspaces.get(apiProject)!.workspace.drafts[type];
    expect(saved.supplemental_requirements).toContain(before[type].supplemental_requirements!);
    expect(saved.supplemental_requirements).toContain('本轮统一保留待核实标记');
    expect(saved.requirements).toEqual(before[type].requirements);expect(saved.version).toBe(2);
  }
  expect(s.workspaces.get(apiProject)!.workspace.drafts.legal).toEqual(before.legal);
  await confirm(page);expect(batches(s.calls)).toHaveLength(0);
  await page.locator('#pf-confirm-generation').click();
  await expect(page.getByRole('heading',{name:'文件生成任务'})).toBeVisible();
  expect((batches(s.calls)[0].body as FileGenerationBatchRequest).documents).toEqual([
    {document_type:'init',draft_version:2},{document_type:'underwriter',draft_version:2}]);
  expect(draftWrites(s.calls)).toHaveLength(2);
});

test('unsaved common note survives reopening and is appended before confirmation',async({page})=>{
  const s=await fixture(page);await open(page);await choose(page,['credit']);
  await page.locator('#pf-requirements').fill('刷新后仍需保留的补充要求');await page.reload();
  await expect(documentChoice(page,'credit')).toHaveValue('credit');
  await expect(page.locator('#pf-requirements')).toHaveValue('刷新后仍需保留的补充要求');
  expect(draftWrites(s.calls)).toHaveLength(0);
  await confirm(page);
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('credit')]);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.credit.supplemental_requirements).toContain('刷新后仍需保留的补充要求');
  expect(batches(s.calls)).toHaveLength(0);
});

test('a partially saved note resumes its original document scope after reselection and reload',async({page})=>{
  const s=await fixture(page);s.failDraft='underwriter';
  const before=structuredClone(s.workspaces.get(apiProject)!.workspace.drafts),note='本轮原范围的共同补充要求';
  await open(page);await choose(page,['init','underwriter']);await page.locator('#pf-requirements').fill(note);
  await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeVisible();
  await expect(page.locator('#pf-save-requirements')).toBeEnabled();
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('init'),draftPath('underwriter')]);
  await clearRows(page);await choose(page,['credit']);await page.reload();
  await expect(documentChoice(page,'credit')).toHaveValue('credit');await expect(documentChoice(page,'init')).toHaveCount(0);
  await expect(page.locator('#pf-stop-note')).toBeVisible();
  expect(draftWrites(s.calls)).toHaveLength(2);
  await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeHidden();
  await expect(page.locator('#pf-requirements')).toHaveValue('');
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('init'),draftPath('underwriter'),draftPath('underwriter')]);
  for(const type of ['init','underwriter'] as const){
    expect(s.workspaces.get(apiProject)!.workspace.drafts[type].supplemental_requirements).toBe(before[type].supplemental_requirements+'\n\n'+note);
    expect(s.workspaces.get(apiProject)!.workspace.drafts[type].requirements).toEqual(before[type].requirements);
  }
  expect(s.workspaces.get(apiProject)!.workspace.drafts.credit).toEqual(before.credit);
  expect(batches(s.calls)).toHaveLength(0);
});

test('note recovery preserves a later append from another page without duplicating the original note',async({page})=>{
  const s=await fixture(page);s.failDraft='underwriter';
  const note='第一次共同补充要求',later='另一页面后来追加的要求';
  await open(page);await choose(page,['init','underwriter']);await page.locator('#pf-requirements').fill(note);
  await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeVisible();
  await expect(page.locator('#pf-save-requirements')).toBeEnabled();
  const draft=s.workspaces.get(apiProject)!.workspace.drafts.init;
  draft.supplemental_requirements+='\n\n'+later;draft.version++;draft.sha256='c'.repeat(64);
  const afterOtherPage=structuredClone(draft);
  await page.reload();await expect(page.locator('#pf-stop-note')).toBeVisible();
  expect(draftWrites(s.calls)).toHaveLength(2);
  await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeHidden();
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('init'),draftPath('underwriter'),draftPath('underwriter')]);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.init).toEqual(afterOtherPage);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.init.supplemental_requirements!.split(note)).toHaveLength(2);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.underwriter.supplemental_requirements).toContain(note);
  expect(batches(s.calls)).toHaveLength(0);
});

test('stopping a partial note operation preserves saved requirements and never applies them to a new selection',async({page})=>{
  const s=await fixture(page);s.failDraft='underwriter';
  const before=structuredClone(s.workspaces.get(apiProject)!.workspace.drafts),note='只保留已成功保存的部分';
  await open(page);await choose(page,['init','underwriter']);await page.locator('#pf-requirements').fill(note);
  await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeVisible();
  await expect(page.locator('#pf-save-requirements')).toBeEnabled();
  await page.locator('#pf-stop-note').click();await expect(page.locator('#pf-stop-note')).toBeHidden();
  await clearRows(page);await choose(page,['credit']);await page.reload();
  await expect(page.locator('#pf-stop-note')).toBeHidden();await expect(page.locator('#pf-requirements')).toHaveValue('');
  expect(s.workspaces.get(apiProject)!.workspace.drafts.init.supplemental_requirements).toBe(before.init.supplemental_requirements+'\n\n'+note);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.underwriter).toEqual(before.underwriter);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.credit).toEqual(before.credit);
  expect(draftWrites(s.calls)).toHaveLength(2);expect(batches(s.calls)).toHaveLength(0);
});

test('unavailable browser session storage prevents a generation request before any batch is submitted',async({page})=>{
  await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Synthetic storage unavailable','QuotaExceededError');};});
  const s=await fixture(page);await open(page);await choose(page,['init']);await confirm(page);
  await page.locator('#pf-confirm-generation').click();
  await expect(page.locator('#pf-status')).toContainText(/提交记录|会话存储/);
  await expect(page.locator('#pf-generate')).toBeVisible();await expect(page.locator('#pf-retry-batch')).toHaveCount(0);
  expect(batches(s.calls)).toHaveLength(0);
});

test('support save retry retains frozen document scope and never repeats accepted upload bytes',async({page})=>{
  const s=await fixture(page);s.failDraft='underwriter';await open(page);await choose(page,['init','underwriter']);
  await page.locator('#pf-support').setInputFiles(supportFile);
  await expect(page.locator('#pf-retry-support')).toBeVisible();
  await clearRows(page);await choose(page,['credit']);
  await expect(page.locator('#pf-support-list')).toContainText('立项报告');
  await expect(page.locator('#pf-support-list')).toContainText('主承销商核查意见');
  await page.locator('#pf-retry-support').click();
  await expect(page.locator('#pf-retry-support')).toBeHidden();
  const writes=draftWrites(s.calls);
  expect(writes.map(c=>c.path)).toEqual([draftPath('init'),draftPath('underwriter'),draftPath('underwriter')]);
  for(const type of ['init','underwriter'] as const){
    const pins=s.workspaces.get(apiProject)!.workspace.drafts[type].materials;
    expect(pins).toHaveLength(1);expect(pins[0].source_project_id).toBe(apiProject);
  }
  expect(s.workspaces.get(apiProject)!.workspace.drafts.credit.materials).toEqual([]);
  expect(s.calls.filter(c=>c.path===`/projects/${apiProject}/materials/uploads`)).toHaveLength(1);
  expect(s.calls.filter(c=>c.path.startsWith('/synthetic-upload/')&&c.method==='PUT')).toHaveLength(1);
  expect(s.calls.filter(c=>c.path.endsWith('/complete'))).toHaveLength(1);
  expect(batches(s.calls)).toHaveLength(0);
});

test('uncertain upload completion reconciles the original session while selection stays frozen',async({page})=>{
  const s=await fixture(page);s.completeFailures=1;let release!:()=>void;
  s.holdComplete=new Promise<void>(resolve=>{release=resolve;});
  await open(page);await choose(page,['init','underwriter']);
  await page.locator('#pf-support').setInputFiles(supportFile);
  try{
    await expect.poll(()=>s.calls.filter(c=>c.path.endsWith('/complete')).length).toBe(1);
    expect(await page.locator('.pf-generation-grid').evaluate(n=>(n as HTMLElement).inert)).toBe(true);
    await page.evaluate(()=>{const input=document.querySelector<HTMLSelectElement>('select[data-pf-document]')!;input.value='credit';input.dispatchEvent(new Event('change',{bubbles:true}));});
  }finally{release();s.holdComplete=undefined;}
  await expect(page.locator('#pf-retry-support')).toBeVisible();
  await page.locator('#pf-retry-support').click();await expect(page.locator('#pf-retry-support')).toBeHidden();
  expect(s.calls.filter(c=>c.path.endsWith('/complete'))).toHaveLength(2);
  expect(s.calls.filter(c=>c.path===`/projects/${apiProject}/materials/uploads`)).toHaveLength(1);
  expect(s.calls.filter(c=>c.path.startsWith('/synthetic-upload/')&&c.method==='PUT')).toHaveLength(1);
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('init'),draftPath('underwriter')]);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.credit.materials).toEqual([]);
});

test('empty or unsupported support files are rejected before upload and allow a valid replacement',async({page})=>{
  const s=await fixture(page);await open(page);await choose(page,['init']);
  for(const file of [
    {name:'空文件.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(0)},
    {name:'不支持的资料.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic invalid extension')},
  ]){
    await page.locator('#pf-support').setInputFiles(file);
    await expect(page.locator('#pf-status')).toContainText(/DOCX|PDF|XLSX|空|格式|支持|文件/);
    await expect(page.locator('#pf-support')).toBeEnabled();
    await expect(page.locator('#pf-retry-support')).toBeHidden();
    await expect(page.locator('#pf-generate')).toBeEnabled();
    expect(s.calls.filter(c=>c.path===`/projects/${apiProject}/materials/uploads`)).toHaveLength(0);
    expect(draftWrites(s.calls)).toHaveLength(0);expect(batches(s.calls)).toHaveLength(0);
  }
  await page.locator('#pf-support').setInputFiles(supportFile);
  await expect.poll(()=>s.workspaces.get(apiProject)!.workspace.drafts.init.materials.length).toBe(1);
  await expect(page.locator('#pf-support')).toBeEnabled();
  await expect(page.locator('#pf-retry-support')).toBeHidden();
  expect(s.calls.filter(c=>c.path===`/projects/${apiProject}/materials/uploads`)).toHaveLength(1);
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('init')]);
  expect(batches(s.calls)).toHaveLength(0);
});

test('stopping a partially saved support package releases preparation and preserves accepted material',async({page})=>{
  const s=await fixture(page);s.failDraft='underwriter';await open(page);await choose(page,['init','underwriter']);
  await page.locator('#pf-support').setInputFiles(supportFile);
  await expect(page.locator('#pf-retry-support')).toBeVisible();
  await expect(page.locator('#pf-stop-support')).toBeVisible();
  await expect(page.locator('#pf-generate')).toBeDisabled();
  const accepted=structuredClone(s.workspaces.get(apiProject)!.workspace.drafts.init.materials);
  expect(accepted).toHaveLength(1);expect(s.workspaces.get(apiProject)!.workspace.drafts.underwriter.materials).toEqual([]);
  await page.locator('#pf-stop-support').click();
  await expect(page.locator('#pf-support-feedback')).toBeEmpty();
  await expect(page.locator('#pf-retry-support')).toBeHidden();
  await expect(page.locator('#pf-stop-support')).toBeHidden();
  await expect(page.locator('#pf-support')).toBeEnabled();await expect(page.locator('#pf-generate')).toBeEnabled();
  expect(s.workspaces.get(apiProject)!.workspace.drafts.init.materials).toEqual(accepted);
  expect(s.workspaces.get(apiProject)!.workspace.drafts.underwriter.materials).toEqual([]);
  expect(draftWrites(s.calls).map(c=>c.path)).toEqual([draftPath('init'),draftPath('underwriter')]);
  expect(batches(s.calls)).toHaveLength(0);
  await page.reload();await expect(page.locator('#pf-support')).toBeEnabled();
  expect(s.workspaces.get(apiProject)!.workspace.drafts.init.materials).toEqual(accepted);
  expect(batches(s.calls)).toHaveLength(0);
});

for(const failure of [408,429,'network'] as const){
  test(`uncertain ${failure} generation requires explicit recovery with the identical frozen envelope`,async({page})=>{
    const s=await fixture(page);s.batchFailure=failure;await open(page);await choose(page,['init','underwriter']);
    await page.locator('#pf-requirements').fill('应进入原请求的补充要求');await confirm(page);
    await page.locator('#pf-confirm-generation').click();await expect(page.locator('#pf-retry-batch')).toBeVisible();
    expect(batches(s.calls)).toHaveLength(1);const originalBody=structuredClone(batches(s.calls)[0].body);
    expect((originalBody as FileGenerationBatchRequest).documents.every(d=>d.draft_version===2)).toBe(true);
    await expect(page.locator('#pf-support')).toHaveCount(0);await expect(page.locator('#pf-generate')).toHaveCount(0);
    await expect(page.locator('select[data-pf-document]')).toHaveCount(0);await expect(page.locator('#pf-save-requirements')).toHaveCount(0);
    const w=s.workspaces.get(apiProject)!;w.source={...w.source!,version_id:'source-v4',selection_revision:8,sequence:4,filename:'募集说明书_V4.docx'};
    for(const draft of Object.values(w.workspace.drafts)){draft.version=9;draft.project_file={project_id:apiProject,source_version_id:'source-v4',source_selection_revision:8};}
    const writesBefore=draftWrites(s.calls).length;await page.reload();
    await expect(page.locator('#pf-retry-batch')).toBeVisible();expect(batches(s.calls)).toHaveLength(1);
    await page.locator('#pf-retry-batch').click();await expect(page.getByRole('heading',{name:'文件生成任务'})).toBeVisible();
    expect(batches(s.calls).map(c=>c.body)).toEqual([originalBody,originalBody]);
    expect(draftWrites(s.calls)).toHaveLength(writesBefore);
    expect(batches(s.calls).every(c=>c.path===batchPath(apiProject))).toBe(true);
  });
}

test('a generic conflict after network uncertainty preserves the original pending request',async({page})=>{
  const s=await fixture(page);s.batchFailure='network';await open(page);await choose(page,['init']);await confirm(page);
  await page.locator('#pf-confirm-generation').click();await expect(page.locator('#pf-retry-batch')).toBeVisible();
  const originalBody=structuredClone(batches(s.calls)[0].body);
  const recovery=await page.locator('.pf-generation-recovery').elementHandle();
  s.batchFailure={status:409,code:'INPUT_REVISION_CONFLICT'};
  await page.locator('#pf-retry-batch').click();
  await expect.poll(()=>batches(s.calls).length).toBe(2);
  await expect.poll(()=>recovery!.evaluate(node=>node.isConnected)).toBe(false);
  await expect(page.locator('#pf-retry-batch')).toBeEnabled();await expect(page.locator('#pf-reprepare')).toHaveCount(0);
  expect(batches(s.calls).map(c=>c.body)).toEqual([originalBody,originalBody]);
  await page.reload();await expect(page.locator('#pf-retry-batch')).toBeVisible();
  await expect(page.locator('#pf-generate')).toHaveCount(0);await expect(page.locator('#pf-reprepare')).toHaveCount(0);
  expect(batches(s.calls)).toHaveLength(2);
});

test('an expired session during batch submission keeps the signed-out page clear of stale recovery UI',async({page})=>{
  const s=await fixture(page);s.batchFailure=401;await open(page);await choose(page,['init']);await confirm(page);
  await page.locator('#pf-confirm-generation').click();
  await expect(page.locator('#login-form')).toBeVisible();
  // Let the rejected request's catch/finally complete before checking that the
  // disposed workspace cannot replace the signed-out view.
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#login-message')).toContainText('登录已失效');
  await expect(page.locator('.pf-generation-recovery')).toHaveCount(0);
  await expect(page.locator('#pf-retry-batch')).toHaveCount(0);await expect(page.locator('#pf-generate')).toHaveCount(0);
  expect(await page.evaluate(()=>location.hash)).toBe('#/');
  expect(batches(s.calls)).toHaveLength(1);
  const submitted=s.calls.findIndex(c=>c.path===batchPath()&&c.method==='POST');
  expect(s.calls.slice(submitted+1).filter(c=>c.path!=='/auth/recovery/info')).toEqual([]);
});

test('a trusted expired-input receipt requires explicit preparation and a new package confirmation',async({page})=>{
  const s=await fixture(page);s.batchFailure='network';await open(page);await choose(page,['init']);await confirm(page);
  await page.locator('#pf-confirm-generation').click();await expect(page.locator('#pf-retry-batch')).toBeVisible();
  const originalBody=structuredClone(batches(s.calls)[0].body) as FileGenerationBatchRequest;
  const w=s.workspaces.get(apiProject)!;w.source={...w.source!,version_id:'source-v4',selection_revision:8,sequence:4,filename:'募集说明书_V4.docx'};
  for(const draft of Object.values(w.workspace.drafts)){draft.version=9;draft.project_file={project_id:apiProject,source_version_id:'source-v4',source_selection_revision:8};}
  s.batchFailure={status:409,code:'PROJECT_FILE_BATCH_INPUT_EXPIRED'};
  await page.locator('#pf-retry-batch').click();await expect(page.locator('#pf-reprepare')).toBeVisible();
  await expect(page.locator('#pf-retry-batch')).toHaveCount(0);
  expect(batches(s.calls).map(c=>c.body)).toEqual([originalBody,originalBody]);
  const callsBeforePreparation=s.calls.length;
  await page.locator('#pf-reprepare').click();await expect(page.locator('#pf-generate')).toBeVisible();
  await expect(page.locator('#pf-source-summary')).toContainText('募集说明书_V4.docx');
  expect(s.calls.slice(callsBeforePreparation).every(c=>c.method==='GET')).toBe(true);
  expect(s.calls.slice(callsBeforePreparation).some(c=>c.path.endsWith('/project-files/workspace'))).toBe(true);
  expect(batches(s.calls)).toHaveLength(2);
  await confirm(page);expect(batches(s.calls)).toHaveLength(2);
  await page.locator('#pf-confirm-generation').click();await expect(page.getByRole('heading',{name:'文件生成任务'})).toBeVisible();
  expect(batches(s.calls)).toHaveLength(3);
  const renewed=batches(s.calls)[2].body as FileGenerationBatchRequest;
  expect(renewed).toEqual({request_id:expect.any(String),source_version_id:'source-v4',expected_selection_revision:8,documents:[{document_type:'init',draft_version:9}]});
  expect(renewed.request_id).not.toBe(originalBody.request_id);
});

test('the task-list entry opens an existing running batch with the API and navigation projects preserved',async({page})=>{
  const s=await fixture(page);s.workspaces.get(apiProject)!.batches=[{batch_id:'existing-running',state:'running',items:[{document_type:'init',run_id:null,state:'queued',error:null}]}];
  await open(page);
  const tasks=page.getByRole('link',{name:/^生成记录/});
  const link=await tasks.getAttribute('href'),query=new URLSearchParams(link!.split('?')[1]);
  expect(query.get('project')).toBe(apiProject);expect(query.get('return_project')).toBe(navigationProject);expect(query.get('step')).toBe('results');
  await tasks.click();await expect(page.getByRole('heading',{name:'文件生成任务'})).toBeVisible();
  await expect(page.locator('.pf-batch')).toContainText('正在生成');
  await expect(page.locator('[data-project-context-name]')).toHaveText('原债券项目');
  await expect(page.getByRole('link',{name:'查看项目文件',exact:true})).toHaveAttribute('href',`#/projects/${navigationProject}/files`);
  expect(new URLSearchParams((await page.evaluate(()=>location.hash)).split('?')[1]).get('project')).toBe(apiProject);
  expect(batches(s.calls)).toHaveLength(0);
});

test('latest batch can seed scope while an explicit cached empty choice wins',async({page})=>{
  const s=await fixture(page);s.workspaces.get(apiProject)!.batches=[{batch_id:'previous-complete',state:'complete',items:[{document_type:'annual',run_id:null,state:'succeeded',error:null}]}];
  await open(page);await expect(documentChoice(page,'annual')).toHaveValue('annual');
  await clearRows(page);await page.reload();
  await expect(page.locator('select[data-pf-document]:not([data-pf-document=""])')).toHaveCount(0);
  await expect(page.locator('#pf-generate')).toBeDisabled();
});

test('selection and requirements cache isolate account owners and actual API projects sharing navigation',async({page})=>{
  const s=await fixture(page);await open(page);await choose(page,['init']);await page.locator('#pf-requirements').fill('仅属于 P 与当前账号');
  await open(page,otherApiProject);
  await expect(page.locator('select[data-pf-document]:not([data-pf-document=""])')).toHaveCount(0);await expect(page.locator('#pf-requirements')).toHaveValue('');
  await choose(page,['legal']);await open(page);
  await expect(documentChoice(page,'init')).toHaveValue('init');await expect(documentChoice(page,'legal')).toHaveCount(0);
  await expect(page.locator('#pf-requirements')).toHaveValue('仅属于 P 与当前账号');
  s.owner='synthetic-other-owner';await page.reload();
  await expect(page.locator('select[data-pf-document]:not([data-pf-document=""])')).toHaveCount(0);await expect(page.locator('#pf-requirements')).toHaveValue('');
  s.owner=owner;await page.reload();await expect(documentChoice(page,'init')).toHaveValue('init');
  expect(batches(s.calls)).toHaveLength(0);
});

test('pending request cache cannot appear under another API project or owner',async({page})=>{
  const s=await fixture(page);s.batchFailure=408;await open(page);await choose(page,['init']);await confirm(page);
  await page.locator('#pf-confirm-generation').click();await expect(page.locator('#pf-retry-batch')).toBeVisible();
  await open(page,otherApiProject);await expect(page.locator('#pf-retry-batch')).toHaveCount(0);
  s.owner='synthetic-other-owner';await page.goto('/'+href());await page.reload();
  await expect(page.locator('#pf-generate')).toBeVisible();await expect(page.locator('#pf-retry-batch')).toHaveCount(0);
  s.owner=owner;await page.reload();await expect(page.locator('#pf-retry-batch')).toBeVisible();
  expect(batches(s.calls)).toHaveLength(1);expect(batches(s.calls,otherApiProject)).toHaveLength(0);
});

for(const width of [390,320]){
  test(`mobile ${width}px preparation and confirmation fit the viewport`,async({page})=>{
    await page.setViewportSize({width,height:844});await fixture(page);await open(page);await choose(page,['init','underwriter']);
    const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    expect(await overflow()).toBe(false);
    const projectText=await page.locator('.project-context').boundingBox();
    expect(projectText!.width).toBeGreaterThan(150);expect(projectText!.height).toBeLessThan(125);
    for(const row of await page.locator('.pf-document-option').all()){
      const box=(await row.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.height).toBeLessThan(66);
    }
    const dir=process.env.BB_UX_EVIDENCE_DIR;
    if(dir){await mkdir(dir,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(dir,`file-generation-preparation-${width}.png`),fullPage:true});}
    await confirm(page);expect(await overflow()).toBe(false);
    await expect(page.locator('#pf-confirm-generation')).toBeVisible();
    if(dir)await page.screenshot({path:join(dir,`file-generation-confirmation-${width}.png`)});
  });
}

for(const width of [1440,390,320])test(`source upload has one obvious entry and no empty disclosures at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:960});const s=await fixture(page);s.workspaces.get(apiProject)!.source=null;
  await page.goto('/'+href(apiProject,{step:'source'}));
  await expect(page.locator('.pf-prospectus-dropzone')).toBeVisible();
  await expect(page.locator('.pf-steps,.pf-project-strip,.pf-source-intro')).toHaveCount(0);
  await expect(page.locator('[data-prospectus-history]')).toBeHidden();
  await expect(page.locator('.prospectus-upload-editor')).toBeHidden();
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const dir=process.env.BB_UX_EVIDENCE_DIR;
  if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`source-empty-${width}.png`),fullPage:true});if(width===1440)await writeFile(join(dir,'source-empty.html'),await page.locator('.pf-workspace-heading').evaluate(e=>e.outerHTML+document.querySelector('.pf-source-workspace')!.outerHTML));}
  const chooser=page.waitForEvent('filechooser');await page.locator('.pf-prospectus-dropzone').click();
  await(await chooser).setFiles(supportFile);
  await expect(page.locator('.prospectus-selected-file')).toContainText(supportFile.name);
  await expect(page.locator('#save-prospectus-version')).toBeVisible();
  await expect(page.locator('#save-prospectus-version')).toBeEnabled();
  if(dir)await page.screenshot({path:join(dir,`source-selected-${width}.png`),fullPage:true});
  await page.locator('#cancel-prospectus-version').click();
  await expect(page.locator('.prospectus-upload-editor')).toBeHidden();
  await expect(page.locator('.pf-prospectus-dropzone')).toBeFocused();
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('source to file rows preserves the exact version and keeps choices beside template actions',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const s=await fixture(page);
  await page.goto('/'+href(apiProject,{step:'source'}));
  await expect(page.locator('#pf-source-next')).toBeEnabled();
  const dir=process.env.BB_UX_EVIDENCE_DIR;
  if(dir){await page.screenshot({path:join(dir,'source-current-1440.png'),fullPage:true});await writeFile(join(dir,'source-current.html'),await page.locator('.pf-workspace-heading').evaluate(e=>e.outerHTML+document.querySelector('.pf-source-workspace')!.outerHTML));}
  await page.locator('#pf-source-next').click();await expect(page.locator('.pf-file-builder')).toBeVisible();
  expect(s.calls.find(c=>c.method==='POST'&&c.path.endsWith('/project-files/source'))?.body).toEqual({source_version_id:'source-v3',expected_selection_revision:7});
  await choose(page,['init','underwriter']);
  const table=page.getByRole('table',{name:'文件与模板清单'}),box=(await table.boundingBox())!;
  expect(box.width).toBeGreaterThan(800);await expect(table.locator('tbody tr')).toHaveCount(2);
  for(const row of await table.locator('tbody tr').all()){const b=(await row.boundingBox())!;expect(b.height).toBeLessThan(110);expect(b.height).toBeGreaterThanOrEqual(64);await expect(row.locator('select')).toBeVisible();await expect(row.locator('[data-pf-template]')).toBeVisible();}
  await expect(page.locator('.pf-selection-side')).toHaveCount(0);await expect(table.getByRole('checkbox')).toHaveCount(0);
  await page.locator('#pf-add-row').click();const blank=page.locator('select[data-pf-document=""]');await expect(blank).toBeFocused();await blank.selectOption('legal');await expect(documentChoice(page,'legal')).toBeFocused();
  await page.locator('[data-pf-remove="legal"]').click();await expect(documentChoice(page,'legal')).toHaveCount(0);
  for(const button of await page.locator('[data-pf-template]').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(batches(s.calls)).toHaveLength(0);
  if(dir){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(dir,'documents-1440.png'),fullPage:true});await writeFile(join(dir,'documents.html'),await page.locator('.pf-workspace-heading').evaluate(e=>e.outerHTML+document.querySelector('.pf-generation-source')!.outerHTML+document.querySelector('.pf-documents-layout')!.outerHTML));}
});

for(const width of [1440,390])test('file rows: add, replace, duplicate prevention, removal and refresh at '+width+'px',async({page})=>{
 await page.setViewportSize({width,height:960});const s=await fixture(page);await open(page);
 await expect(page.locator('select[data-pf-document=""]')).toBeVisible();await addDocuments(page,['legal','init','credit']);
 await page.locator('#pf-add-row').click();await page.locator('#pf-add-row').click();await expect(page.locator('select[data-pf-document=""]')).toHaveCount(1);
 await expect(page.locator('select[data-pf-document=""] option[value="init"]')).toBeDisabled();
 await documentChoice(page,'init').selectOption('underwriter');expect(await selectedRows(page)).toEqual(['legal','underwriter','credit']);
 await expect(page.locator('select[data-pf-document=""] option[value="init"]')).toBeEnabled();
 await page.locator('[data-pf-remove=""]').click();await expect(page.locator('select[data-pf-document=""]')).toHaveCount(0);
 await page.locator('[data-pf-remove="legal"]').click();expect(await selectedRows(page)).toEqual(['underwriter','credit']);
 await page.reload();await expect(documentChoice(page,'underwriter')).toBeVisible();expect(await selectedRows(page)).toEqual(['underwriter','credit']);
 await addDocuments(page,['legal']);await expect(page.locator('[data-pf-template="legal"]')).toHaveText('更换模板');
 await addDocuments(page,PROJECT_DOCUMENT_CATALOG.map(d=>d.id));await expect(page.locator('#pf-add-row')).toBeDisabled();await expect(page.locator('select[data-pf-document]')).toHaveCount(12);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if(width===1440)expect((await page.locator('.pf-file-table-wrap').boundingBox())!.height).toBeLessThanOrEqual(522);
 expect(draftWrites(s.calls)).toEqual([]);expect(batches(s.calls)).toEqual([]);
});

for(const width of [1440,390])test('file row prototype and implementation comparison at '+width+'px',async({page})=>{
 await page.setViewportSize({width,height:960});await fixture(page);await open(page);await choose(page,['init','underwriter']);
 const dir=process.env.BB_ROW_EVIDENCE_DIR??test.info().outputPath('rows');await mkdir(dir,{recursive:true});
 const position=async()=>page.locator('.pf-file-builder').evaluate(n=>scrollTo(0,n.getBoundingClientRect().top+scrollY-80));await position();
 const implementation=page.locator('.pf-file-builder');await implementation.screenshot({path:join(dir,'implementation-'+width+'.png')});
 const file=resolve(process.cwd(),'../../product-prototype/public/file-generation.html').replaceAll('\\','/');
 await page.goto('/@fs/'+file+'?scene=documents');await expect(page.locator('select[data-pf-document]')).toHaveCount(2);
 await position();await page.locator('.pf-file-builder').screenshot({path:join(dir,'prototype-'+width+'.png')});
 await page.locator('#pf-add-row').click();await expect(page.locator('select[data-pf-document=""] option[value="init"]')).toBeDisabled();
 await page.locator('select[data-pf-document=""]').selectOption('legal');await expect(page.locator('select[data-pf-document]')).toHaveCount(3);
 await page.getByRole('button',{name:'移除第 3 行',exact:true}).click();await expect(page.locator('select[data-pf-document]')).toHaveCount(2);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
