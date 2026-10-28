import {addDocuments} from './file-generation-rows';
import {expect,test,type Page,type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PROJECT_DOCUMENT_CATALOG,type M4DocumentType,type M4Draft,type M4DraftRequest,type M4Template,type ProjectFileWorkspace,type ProspectusVersion} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {taskPage} from './collection-fixtures';

// Synthetic component/browser acceptance. No real model, storage or billing calls.
const owner='entry-recovery-owner',project='entry-recovery-project',topic='entry-recovery-topic';
const base=`/api/v1/projects/${project}`,now='2026-10-25T04:00:00Z',sha='a'.repeat(64);
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const file={name:'合成原材料.docx',mimeType:mime,buffer:Buffer.from('synthetic original document for entry recovery')};
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
type Call={method:string;path:string;body:unknown};
type Session={declaration:Dto<'UploadCreateRequest'>;received:boolean;material?:Dto<'MaterialResponse'>};
function workspace():ProjectFileWorkspace{
  const pin={source_project_id:project,material_id:'original-source',material_version:1,sha256:sha};
  const source={project_id:project,version_id:'source-v1',selection_revision:1,filename:'合成募集书.docx',sequence:1,asset:{kind:'material' as const,pin}};
  const templates:M4Template[]=PROJECT_DOCUMENT_CATALOG.map(d=>({template_id:`template-${d.id}`,template_version:1,sha256:sha,name:'已有合成模板',broker:'原券商',document_type:d.id,material:pin,owner_scope:'private',market:'sse',offering:'private',status:'active',created_at:now,retired_at:null}));
  const drafts={} as Record<M4DocumentType,M4Draft>;
  for(const d of PROJECT_DOCUMENT_CATALOG)drafts[d.id]={document_type:d.id,version:1,sha256:sha,updated_at:now,project_file:{project_id:project,source_version_id:source.version_id,source_selection_revision:1},source_material:pin,materials:[],template:{template_id:`template-${d.id}`,template_version:1,sha256:sha},edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',offering:'private',broker:'原券商'},requirements:[],supplemental_requirements:'原要求'};
  return {project_id:project,source,files:[],batches:[],workspace:{topic:{topic_id:topic,project_id:project,source_project_id:project,name:'合成工作区',created_at:now,updated_at:now},project:{project_id:project,name:'合成项目',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now},drafts,templates,materials:[],material_details:[],messages:[],tasks:[],artifacts:[],pending_requirements:[],view:{selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},active_run:null}};
}
async function fixture(page:Page){
  const state={calls:[] as Call[],unexpected:[] as string[],sessions:new Map<string,Session>(),materials:new Map<string,Dto<'MaterialResponse'>>(),versions:[] as ProspectusVersion[],work:workspace(),dropBytes:false,dropComplete:false,dropImport:false,dropTemplate:false,dropDraft:undefined as M4DocumentType|undefined,failDraft:undefined as M4DocumentType|undefined,imports:new Map<string,unknown>(),templates:new Map<string,M4Template>(),puts:0};
  const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,json:body});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();
    const body=method==='PUT'&&path.endsWith('/bytes')?null:req.postData()?req.postDataJSON():undefined;
    state.calls.push({method,path,body});
    if(method==='GET'&&path===base)return json(route,200,state.work.workspace.project);
    if(method==='GET'&&path===`${base}/tasks`)return json(route,200,taskPage(project,[]));
    if(method==='GET'&&path===`${base}/files`)return json(route,200,{project_id:project,items:[],page:{has_more:false,next_cursor:null}});
    if(method==='GET'&&path===`${base}/project-files`)return json(route,200,{files:[]});
    if(method==='GET'&&path===`${base}/workpapers/library`)return json(route,200,{items:[],total:0,offset:0,limit:30,source:null,checks:[]});
    if(method==='GET'&&path===`${base}/project-files/workspace`)return json(route,200,state.work);
    if(method==='GET'&&path===`${base}/prospectus-versions`)return json(route,200,{project_id:project,current_version_id:null,selection_revision:0,inactive_material_ids:[],versions:state.versions});
    if(method==='POST'&&path===`${base}/materials/uploads`){const id=`upload-${state.sessions.size+1}`;state.sessions.set(id,{declaration:body,received:false});return json(route,201,{upload_id:id,state:'uploading',upload_url:`${base}/materials/uploads/${id}/bytes`,expires_at:'2099-01-01T00:00:00Z',max_bytes:100*1024*1024});}
    const transfer=path.match(/\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
    if(transfer){const s=state.sessions.get(transfer[1]);if(!s)return json(route,404,{code:'NOT_FOUND'});
      if(method==='PUT'&&transfer[2]==='bytes'){const bytes=req.postDataBuffer()!;expect(bytes.length).toBe(s.declaration.byte_size);expect(hash(bytes)).toBe(s.declaration.sha256);state.puts++;if(state.dropBytes){state.dropBytes=false;return route.abort('connectionreset');}s.received=true;return route.fulfill({status:204});}
      if(method==='POST'&&transfer[2]==='complete'){expect(body).toEqual({byte_size:s.declaration.byte_size,sha256:s.declaration.sha256});if(!s.received)return json(route,422,{code:'MATERIAL_UNREADABLE'});
        if(!s.material){s.material={...s.declaration,material_id:`material-${transfer[1]}`,material_version:1,upload_id:transfer[1],state:'persisted',persisted_at:now,error:null};state.materials.set(s.material.material_id,s.material);if(s.declaration.role==='historical')state.versions.push({version_id:`version-${transfer[1]}`,sequence:1,origin:'upload',filename:s.material.filename,sha256:s.material.sha256,created_at:now,material_id:s.material.material_id,material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null});}
        if(state.dropComplete){state.dropComplete=false;return route.abort('connectionreset');}return json(route,200,s.material);
      }
    }
    const material=path.match(/\/materials\/([^/]+)$/);
    if(material&&method==='GET'){const m=state.materials.get(material[1]);return m?json(route,200,m):json(route,404,{code:'NOT_FOUND'});}
    if(path===`${base}/project-files/imports`&&method==='POST'){const request=body as {request_id:string};if(state.imports.has(request.request_id))expect(body).toEqual(state.imports.get(request.request_id));else state.imports.set(request.request_id,structuredClone(body));if(state.dropImport){state.dropImport=false;return route.abort('connectionreset');}return json(route,200,{saved:true});}
    if(path===`/api/v1/m4/topics/${topic}/materials`&&method==='POST')return route.fulfill({status:204});
    const draft=path.match(new RegExp(`/m4/topics/${topic}/drafts/([^/]+)$`));
    if(draft&&method==='PUT'){const request=body as M4DraftRequest,type=draft[1] as M4DocumentType,current=state.work.workspace.drafts[type];if(current.version!==request.expected_version)return json(route,409,{code:'INPUT_REVISION_CONFLICT'});if(state.failDraft===type){state.failDraft=undefined;return json(route,503,{code:'DATA_UNAVAILABLE'});}state.work.workspace.drafts[type]={...request.input,version:current.version+1,sha256:sha,updated_at:now};if(state.dropDraft===type){state.dropDraft=undefined;return route.abort('connectionreset');}return json(route,200,{draft:state.work.workspace.drafts[type]});}
    if(path==='/api/v1/m4/templates'&&method==='POST'){const request=body as Parameters<import('../src/m4-api').M4Api['template']>[0];let t=state.templates.get(request.creation_request_id);if(!t){t={...request,template_id:`saved-template-${state.templates.size+1}`,template_version:1,sha256:request.material.sha256,owner_scope:'private',market:request.market!,offering:request.offering!,status:'active',created_at:now,retired_at:null};state.templates.set(request.creation_request_id,t);}if(state.dropTemplate){state.dropTemplate=false;return route.abort('connectionreset');}return json(route,200,{template:t});}
    state.unexpected.push(`${method} ${path}`);return json(route,500,{code:'DATA_UNAVAILABLE'});
  });
  await page.route(new URL('/',process.env.BB_E2E_BASE_URL??'http://127.0.0.1:5173').href,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main id="entry-fixture"></main></body></html>'}));
  return state;
}
async function mount(page:Page,mode:'panel'|'files'|'generation',reload=false){
  if(reload)await page.reload();else await page.goto('/');
  await page.evaluate(async({mode,owner,project})=>{
    const apiPath='/src/api.ts',{ApiClient}=await import(apiPath),api=new ApiClient(),host=document.querySelector<HTMLElement>('#entry-fixture')!;
    let component;
    if(mode==='panel'){const path='/src/prospectus-panel.ts',{ProspectusPanel}=await import(path);component=new ProspectusPanel(api,project,host,async()=>true,async()=>{},()=>{},'update',owner);await component.refresh();}
    else {const shell=(html:string)=>{host.innerHTML=html;};if(mode==='files'){const path='/src/project-files.ts',{ProjectFiles}=await import(path);component=new ProjectFiles(api,shell,()=>true,project,owner);}else{history.replaceState(null,'',`/#generate?project=${project}&step=documents`);const path='/src/file-workspace.ts',{FileWorkspace}=await import(path);component=new FileWorkspace(api,shell,()=>true,project,owner);}await component.render();}
    Object.assign(window,{entryComponent:component});
  },{mode,owner,project});
  // Match the production global CSS order without importing main.ts or its APIs.
  for(const path of ['src/style.css','../../product-prototype/public/styles.css','../../product-prototype/public/source-prospectus.css','../../product-prototype/public/project-workspace.css','src/prototype-adapter.css'])await page.addStyleTag({content:(await readFile(join(process.cwd(),path),'utf8')).replace(/@import\s+[^;]+;/g,'')});
}
const writes=(calls:Call[],suffix:string)=>calls.filter(c=>c.method!=='GET'&&c.path.endsWith(suffix));
const noBusiness= (calls:Call[])=>expect(calls.filter(c=>/\/(?:execute|credits|credit-quote|quote|answer)(?:\/|$)|prospectus-versions\/current/.test(c.path))).toEqual([]);
async function capture(page:Page,name:string){const dir=process.env.BB_ENTRY_RECOVERY_EVIDENCE_DIR;if(!dir)return;await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,name+'.png'),fullPage:true});const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText}));expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);await writeFile(join(dir,name+'.json'),JSON.stringify(layout,null,2));}

for(const width of [1440,390])test(`prospectus upload survives refresh without File or adoption at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const s=await fixture(page);s.dropComplete=true;await mount(page,'panel');
  await page.locator('summary').filter({hasText:'上传历史／参考稿'}).click();await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect(page.locator('[data-resume-prospectus]')).toBeVisible();expect(s.puts).toBe(1);const count=s.calls.filter(c=>c.method!=='GET').length;
  await mount(page,'panel',true);expect(s.calls.filter(c=>c.method!=='GET')).toHaveLength(count);await capture(page,`panel-recovery-${width}`);await page.locator('[data-resume-prospectus]').click();await expect(page.locator('#prospectus-status')).toContainText('已保存 V1');expect(s.puts).toBe(1);expect(s.sessions.size).toBe(1);expect(s.versions).toHaveLength(1);noBusiness(s.calls);expect(s.unexpected).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
for(const width of [1440,390])test(`project file resumes the original import after refresh at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const s=await fixture(page);s.dropImport=true;await mount(page,'files');await page.locator('#import-project-file').click();await page.locator('dialog select').selectOption('init');await page.locator('dialog input[type=file]').setInputFiles(file);await expect(page.locator('[data-resume-project-file]')).toBeVisible();const original=writes(s.calls,'/imports')[0].body,count=s.calls.filter(c=>c.method!=='GET').length;
  await mount(page,'files',true);expect(s.calls.filter(c=>c.method!=='GET')).toHaveLength(count);await capture(page,`import-recovery-${width}`);await page.locator('[data-resume-project-file]').click();await expect(page.locator('dialog select')).toHaveValue('init');await expect(page.locator('dialog select')).toBeDisabled();await page.locator('dialog form button').click();await expect(page.locator('[data-resume-project-file]')).toHaveCount(0);expect(writes(s.calls,'/imports')).toHaveLength(2);expect(writes(s.calls,'/imports')[1].body).toEqual(original);expect(s.imports.size).toBe(1);expect(s.puts).toBe(1);expect(s.sessions.size).toBe(1);noBusiness(s.calls);expect(s.unexpected).toEqual([]);
});
test('support resumes its original types and acknowledged CAS after refresh',async({page})=>{
  const s=await fixture(page);s.dropDraft='init';await mount(page,'generation');await addDocuments(page,['init']);await addDocuments(page,['credit']);await page.locator('#pf-support').setInputFiles(file);await expect(page.locator('#pf-support-recovery [data-generation-resume]')).toBeVisible();expect(s.work.workspace.drafts.init.materials).toHaveLength(1);
  const count=s.calls.filter(c=>c.method!=='GET').length;await mount(page,'generation',true);expect(s.calls.filter(c=>c.method!=='GET')).toHaveLength(count);await page.locator('[data-pf-remove=credit]').click();await page.locator('#pf-support-recovery [data-generation-resume]').click();await expect(page.locator('#pf-support-recovery [data-generation-resume]')).toHaveCount(0);expect(s.work.workspace.drafts.credit.materials).toHaveLength(1);expect(writes(s.calls,'/drafts/init')).toHaveLength(1);expect(s.puts).toBe(1);noBusiness(s.calls);expect(s.unexpected).toEqual([]);
});
test('support retains its original CAS and stops on another page revision',async({page})=>{
  const s=await fixture(page);s.failDraft='init';await mount(page,'generation');await addDocuments(page,['init']);await page.locator('#pf-support').setInputFiles(file);await expect(page.locator('#pf-support-recovery [data-generation-resume]')).toBeVisible();s.work.workspace.drafts.init.version++;s.work.workspace.drafts.init.supplemental_requirements='另一页面明确保存的新要求';const count=writes(s.calls,'/drafts/init').length;
  await mount(page,'generation',true);await page.locator('#pf-support-recovery [data-generation-resume]').click();await expect(page.locator('#pf-status')).toContainText('其他页面修改');expect(writes(s.calls,'/drafts/init')).toHaveLength(count);expect(s.work.workspace.drafts.init.materials).toHaveLength(0);expect(s.puts).toBe(1);noBusiness(s.calls);expect(s.unexpected).toEqual([]);
});
test('template creation resumes its original request and fields after refresh',async({page})=>{
  const s=await fixture(page);s.dropTemplate=true;await mount(page,'generation');await addDocuments(page,['init']);await page.locator('[data-pf-template=init]').click();await page.locator('dialog input[name=broker]').fill('本次原券商');await page.locator('dialog input[type=file]').setInputFiles(file);await expect(page.locator('#pf-template-recovery [data-generation-resume]')).toBeVisible();const original=writes(s.calls,'/m4/templates')[0].body;s.work.workspace.drafts.init.fields.broker='后来当前券商';const count=s.calls.filter(c=>c.method!=='GET').length;
  await mount(page,'generation',true);expect(s.calls.filter(c=>c.method!=='GET')).toHaveLength(count);await page.locator('#pf-template-recovery [data-generation-resume]').click();await expect(page.locator('#pf-template-recovery [data-generation-resume]')).toHaveCount(0);expect(writes(s.calls,'/m4/templates')[1].body).toEqual(original);expect(s.templates.size).toBe(1);expect(s.work.workspace.drafts.init.fields.broker).toBe('本次原券商');expect(s.puts).toBe(1);noBusiness(s.calls);expect(s.unexpected).toEqual([]);
});
test('project file requires exact original bytes before replacing an unreceived upload',async({page})=>{
  const s=await fixture(page);s.dropBytes=true;await mount(page,'files');await page.locator('#import-project-file').click();await page.locator('dialog select').selectOption('init');await expect(page.locator('dialog select')).toHaveValue('init');await page.locator('dialog input[type=file]').setInputFiles(file);await expect(page.locator('[data-resume-project-file]')).toBeVisible();
  await mount(page,'files',true);await page.locator('[data-resume-project-file]').click();await page.locator('dialog form button').click();await expect(page.locator('dialog [role=status]')).toContainText('需要重新上传');const changed=Buffer.from(file.buffer);changed[0]^=1;await page.locator('dialog input[type=file]').setInputFiles({...file,buffer:changed});await expect(page.locator('dialog [role=status]')).toContainText('请勿改用其他文件');expect(s.sessions.size).toBe(1);expect(s.puts).toBe(1);expect(s.imports.size).toBe(0);noBusiness(s.calls);expect(s.unexpected).toEqual([]);
});
test('template recovery cannot overwrite a newer draft after its creation receipt was lost',async({page})=>{
  const s=await fixture(page);s.dropTemplate=true;await mount(page,'generation');await addDocuments(page,['init']);await page.locator('[data-pf-template=init]').click();await page.locator('dialog input[type=file]').setInputFiles(file);await expect(page.locator('#pf-template-recovery [data-generation-resume]')).toBeVisible();s.work.workspace.drafts.init.version++;s.work.workspace.drafts.init.fields.broker='另一页面已保存券商';
  await mount(page,'generation',true);await page.locator('#pf-template-recovery [data-generation-resume]').click();await expect(page.locator('#pf-status')).toContainText('其他页面修改');expect(writes(s.calls,'/drafts/init')).toHaveLength(0);expect(s.work.workspace.drafts.init.fields.broker).toBe('另一页面已保存券商');expect(s.templates.size).toBe(1);expect(s.puts).toBe(1);noBusiness(s.calls);expect(s.unexpected).toEqual([]);
});
