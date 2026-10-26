import {expect,type Page,type Route} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {PROJECT_DOCUMENT_CATALOG,ProjectFileVersionSchema,schemas,type ProjectFileVersion} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {fixture as originalsFixture,install as installOriginals,assertFixture as assertOriginals,checkId,cacheKey,
  filesRoute,checkRoute,ids,docx,editedFile,hash,mime} from './consistency-originals-fixtures';
import {appendMaterial,businessCalls,now} from './word-roundtrip-fixtures';

export {checkId,cacheKey,filesRoute,checkRoute,ids,editedFile};
export const otherProject='return-second-root',fileKey='project-file:'+ids.family;
const json=(route:Route,status:number,value:unknown)=>route.fulfill({status,json:value});
const failure=(route:Route,status=503)=>json(route,status,{code:status===401?'SESSION_EXPIRED':status===404?'NOT_FOUND':'DATA_UNAVAILABLE',
  message:'Synthetic return fixture response',retryable:status>=500,correlation_id:'project-file-return',field_errors:[]});
type FileRow=Dto<'ProjectFilesResponse'>['items'][number];
export function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

/** Extend the sealed Word/R30 HTTP fixture with an actual multi-type collection.
 * Its native M4 task, original bytes, upload/CAS and pending receipts remain in
 * the inherited fixture. This is synthetic HTTP, with no worker or real storage. */
export function fixture(options:Parameters<typeof originalsFixture>[0]={}){
  const s=originalsFixture(options);s.rootProject.name='合成多文件返回项目';
  for(const item of PROJECT_DOCUMENT_CATALOG){
    if(s.registry.some(v=>v.document_type===item.id))continue;
    const materialId='return-material-'+item.id,bytes=Buffer.from(docx('合成已有项目文件：'+item.name));
    const dto:Dto<'MaterialResponse'>={material_id:materialId,material_version:1,upload_id:'prior-'+materialId,role:'other',filename:item.name+'_已有稿.docx',
      media_type:mime,byte_size:bytes.length,sha256:hash(bytes),state:'persisted',persisted_at:now,error:null};
    s.materials.set(materialId,{owner:ids.owner,project:ids.root,dto,bytes});
    const version:ProjectFileVersion={...structuredClone(s.registry[1]),version_id:'return-'+item.id+'-v1',file_id:'return-'+item.id+'-family',document_type:item.id,
      filename:dto.filename,asset:{kind:'material',pin:{source_project_id:ids.root,material_id:materialId,material_version:1,sha256:dto.sha256}},
      consistency:{status:'unchecked',count:0,check_run_id:null}};
    expect(Value.Check(ProjectFileVersionSchema,version)).toBe(true);s.registry.push(version);
  }
  const extras:FileRow[]=[];
  for(let index=0;index<8;index++)extras.push({file_id:'return-raw-'+index,file_key:'raw:'+index,project_id:ids.root,source:'material',
    filename:'原始资料_'+String(index+1).padStart(2,'0')+'.pdf',version:1,display_version:1,sha256:hash('raw-'+index),created_at:now,
    folder:'sources',run_id:null,current:false,latest:true,version_count:1});
  return Object.assign(s,{authenticated:true,extras,fileReplies:0,panelReads:0,panelReplies:0,taskReads:0,
    filesGate:undefined as Promise<void>|undefined,panelGate:undefined as Promise<void>|undefined,
    secondProject:{...s.rootProject,project_id:otherProject,name:'合成另一个项目'},
    authPosts:[] as {path:string;body:unknown}[]});
}
export type State=ReturnType<typeof fixture>;
export function promoteInit(s:State){return appendMaterial(s,Buffer.from(docx('本轮离页后保存的 V2；按文件族恢复，不沿旧版本执行。')),'立项报告当前稿_V2.docx');}
export function removeInitWithSameName(s:State){
  const original=s.registry.find(v=>v.file_id===ids.family&&v.latest)!;
  s.registry=s.registry.filter(v=>v.file_id!==ids.family);
  s.extras.push({file_id:'return-same-name-other-material',file_key:'raw:same-name-unrelated',project_id:ids.root,source:'material',filename:original.filename,
    version:1,display_version:1,sha256:hash('unrelated same name'),created_at:now,folder:'1',run_id:null,current:false,latest:true,version_count:1});
}
export function collection(s:State):Dto<'ProjectFilesResponse'>{
  const source=s.source.asset;if(source.kind!=='material')throw new Error('Expected inherited material source');
  const versions:FileRow[]=s.registry.map(v=>({file_id:v.asset.kind==='material'?v.asset.pin.material_id:v.asset.pin.artifact_id,file_key:'project-file:'+v.file_id,
    project_id:v.asset.pin.source_project_id,source:v.asset.kind,filename:v.filename,version:v.asset.kind==='material'?v.asset.pin.material_version:v.asset.pin.artifact_version,
    display_version:v.sequence,sha256:v.asset.pin.sha256,created_at:v.created_at,folder:PROJECT_DOCUMENT_CATALOG.find(d=>d.id===v.document_type)!.folder,
    run_id:v.run_id,current:false,latest:v.latest,version_count:v.version_count}));
  // Put unrelated files before and after the target to make viewport restoration
  // measurable in the ordinary unfiltered collection, rather than at page end.
  const original=versions.filter(v=>v.file_key===fileKey),others=versions.filter(v=>v.file_key!==fileKey);
  const result={project_id:ids.root,items:[...s.extras.slice(0,4),...others.slice(0,5),...original,...others.slice(5),...s.extras.slice(4),
    {file_id:source.pin.material_id,file_key:'prospectus',project_id:source.pin.source_project_id,source:'material' as const,filename:s.source.filename,
      version:source.pin.material_version,display_version:s.source.sequence,sha256:source.pin.sha256,created_at:now,folder:'2' as const,run_id:null,current:true,latest:true,version_count:1}]};
  expect(Value.Check(schemas.ProjectFilesResponse,result)).toBe(true);return result;
}
function emptyFiles(project:string):Dto<'ProjectFilesResponse'>{return {project_id:project,items:[]};}
export async function install(page:Page,s=fixture()){
  await installOriginals(page,s);
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length),method=request.method();
    const foreign=path.startsWith('/projects/'+otherProject)||s.owner!==ids.owner&&path.startsWith('/projects/'+ids.otherRoot);
    const handled=method==='GET'&&['/me','/projects','/auth/recovery/info'].includes(path)||method==='POST'&&['/auth/login','/auth/logout'].includes(path)||foreign||
      method==='GET'&&[...['/files','/tasks','/prospectus-versions'].map(t=>'/projects/'+ids.root+t)].includes(path);
    if(!handled)return route.fallback();
    const body=method==='POST'&&request.postData()?request.postDataJSON():null;
    s.calls.push({owner:s.owner,method,path,search:url.search,body:structuredClone(body)});
    try{
      if(path==='/auth/recovery/info')return json(route,200,{enabled:false,support_contact:null,link_minutes:30});
      if(path==='/auth/login'){
        expect(Value.Check(schemas.LoginRequest,body)).toBe(true);s.owner=body.username==='return_b'?ids.otherOwner:ids.owner;s.authenticated=true;
        s.authPosts.push({path,body:structuredClone(body)});return json(route,200,{user_id:s.owner,expires_at:'2030-01-01T00:00:00Z',session_status:'active'});
      }
      if(path==='/auth/logout'){s.authPosts.push({path,body});s.authenticated=false;return route.fulfill({status:204});}
      if(!s.authenticated)return failure(route,401);
      if(path==='/me')return json(route,200,{user_id:s.owner,session_status:'active'});
      if(path==='/projects'){
        const projects=s.owner===ids.owner?[s.rootProject,s.secondProject]:[{...s.rootProject,project_id:ids.otherRoot,name:'另一个账号的项目'}];
        const result:Dto<'ProjectListResponse'>={items:projects.map(p=>({project_id:p.project_id,name:p.name,kind:p.kind,issuer_name:p.issuer_name,market:p.market,offering:p.offering,
          draft_revision:p.draft_revision,updated_at:p.updated_at,file_count:p.project_id===ids.root?collection(s).items.length:0,latest_run:null,latest_artifact:null,status:'draft'})),page:{has_more:false,next_cursor:null}};
        expect(Value.Check(schemas.ProjectListResponse,result)).toBe(true);return json(route,200,result);
      }
      if(foreign){
        if(method!=='GET'){s.unexpected.push(method+' '+path);return failure(route,500);}
        const project=s.owner===ids.owner&&path.startsWith('/projects/'+otherProject)?s.secondProject:s.owner===ids.otherOwner&&path.startsWith('/projects/'+ids.otherRoot)?{...s.rootProject,project_id:ids.otherRoot,name:'另一个账号的项目'}:undefined;
        if(!project)return failure(route,404);const base='/projects/'+project.project_id;
        if(path===base)return json(route,200,project);
        if(path===base+'/files')return json(route,200,emptyFiles(project.project_id));
        if(path===base+'/tasks')return json(route,200,{project_id:project.project_id,items:[],page:{has_more:false,next_cursor:null}});
        if(path===base+'/project-files')return json(route,200,{files:[]});
        if(path===base+'/project-files/workspace')return failure(route,404);
        if(path===base+'/prospectus-versions')return json(route,200,{project_id:project.project_id,current_version_id:null,selection_revision:0,inactive_material_ids:[],versions:[]});
        s.unexpected.push(method+' '+path);return failure(route,500);
      }
      if(s.owner!==ids.owner)return failure(route,404);
      if(path==='/projects/'+ids.root+'/files'){
        s.readFiles++;await s.filesGate;
        if(s.filesFailure){s.fileReplies++;return failure(route);}
        await json(route,200,collection(s));s.fileReplies++;return;
      }
      if(path==='/projects/'+ids.root+'/tasks'){
        s.taskReads++;const result:Dto<'ProjectTasksResponse'>={project_id:ids.root,items:[{run_id:ids.originalRun,project_id:ids.execution,kind:'generation',state:'succeeded',stage:'completed',
          artifact_id:ids.originalArtifact,created_at:now,updated_at:now,report_id:null,topic_id:ids.topic,document_type:'init',operation:null}],page:{has_more:false,next_cursor:null}};
        expect(Value.Check(schemas.ProjectTasksResponse,result)).toBe(true);return json(route,200,result);
      }
      if(path==='/projects/'+ids.root+'/prospectus-versions'){
        s.panelReads++;await s.panelGate;
        const result={project_id:ids.root,current_version_id:s.source.version_id,selection_revision:s.source.selection_revision,inactive_material_ids:[],versions:[{
          version_id:s.source.version_id,sequence:s.source.sequence,origin:'upload',filename:s.source.filename,sha256:s.source.asset.pin.sha256,created_at:now,
          material_id:sourceMaterialId(s),material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}]};
        await json(route,200,result);s.panelReplies++;return;
      }
      s.unexpected.push(method+' '+path);return failure(route,500);
    }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return failure(route,500);}
  });return s;
}
function sourceMaterialId(s:State){if(s.source.asset.kind!=='material')throw new Error('Expected source material');return s.source.asset.pin.material_id;}
export async function open(page:Page,s=fixture(),hash='#/projects/'+ids.root+'/files'){
  await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto('/'+hash);
  await expect(page.locator('#file-list')).toBeVisible();return s;
}
export async function ready(page:Page){await expect(page.locator('.prospectus-panel')).toBeVisible();await expect(page.locator('#refresh-files')).toBeEnabled();}
/** Set only the browser route; native hashchange goes through main.beforeLeave. */
export async function navigate(page:Page,hash:string){await page.evaluate(value=>{location.hash=value;},hash);}
export async function login(page:Page,username='return_a'){
  await expect(page.locator('#login-form')).toBeVisible();await page.locator('#username').fill(username);await page.locator('#password').fill('Synthetic.Return.Password.2026');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#project-list')).toBeVisible();
}
export async function uploadJournal(page:Page){return page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('bondbuddy:upload-recovery:v1:')).sort().map(k=>[k,localStorage.getItem(k)])));}
export function assertFixture(s:State){assertOriginals(s);expect(s.authPosts.every(p=>['/auth/login','/auth/logout'].includes(p.path))).toBe(true);}
export function assertNoBusiness(s:State){
  expect(businessCalls(s)).toEqual([]);expect(s.imports).toEqual([]);expect(s.checkRequests).toEqual([]);expect(s.updatePosts).toEqual([]);
  const allowed=new Set(['/auth/login','/auth/logout','/m4/topics/'+ids.topic+'/view']);
  expect(s.calls.filter(c=>c.method!=='GET'&&!allowed.has(c.path))).toEqual([]);assertFixture(s);
}
