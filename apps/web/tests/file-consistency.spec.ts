import {test,expect,type Page,type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {schemas,ProjectFileVersionSchema,ProjectFileSourceSchema,ProjectFileCheckSchema,type ProjectFileSource,type ProjectFileVersion,type ProjectFileCheck,type ProspectusVersions,type ProspectusVersion} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import type {TSchema} from '@sinclair/typebox';
import type {Dto} from '../src/api';
import '../src/schema-formats';

const prototypeRoot='/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/',import.meta.url)).replaceAll('\\','/');
const project='synthetic-review',base='/projects/'+project,filename='合成募集说明书.docx',now='2026-10-25T02:00:00Z';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes=Buffer.from('synthetic upload bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
function checked(schema:TSchema,value:unknown){expect([...Value.Errors(schema,value)].map(e=>({path:e.path,message:e.message}))).toEqual([]);}
async function reply<K extends keyof typeof schemas>(route:Route,name:K,value:Dto<K>,status=200){checked(schemas[name],value);return route.fulfill({status,json:value});}
// Real page, ApiClient and recoverable uploader; synthetic API receipts and bytes, no backend/model/billing.
async function setup(page:Page,{files=0,source=false,saveFailure=false,readFailure=false,history=false}={}){
  const calls:{method:string;path:string;body:any}[]=[];
  let failComplete=saveFailure,failRead=readFailure,checkStarted=false;
  const version:ProspectusVersion={version_id:'source-v1',sequence:1,filename,origin:'upload',created_at:now,material_id:'material-1',material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null,sha256};
  const state:ProspectusVersions={project_id:project,current_version_id:source?version.version_id:null,selection_revision:source?1:0,versions:source||history?[structuredClone(version)]:[],inactive_material_ids:[]};
  const sessions=new Map<string,{input:Dto<'UploadCreateRequest'>;received:boolean;material?:Dto<'MaterialResponse'>}>();
  const sourceValue=():ProjectFileSource|null=>state.current_version_id?{project_id:project,version_id:version.version_id,selection_revision:state.selection_revision,sequence:1,filename:state.versions.find(v=>v.version_id===state.current_version_id)!.filename,asset:{kind:'material',pin:{source_project_id:project,material_id:'material-1',material_version:1,sha256}}}:null;
  const related:ProjectFileVersion[]=Array.from({length:files},(_,i)=>({file_id:'file-'+i,version_id:'file-v'+i,latest:true,document_type:'issuer',filename:'合成关联文件'+i+'.docx',sequence:1,asset:{kind:'material',pin:{source_project_id:project,material_id:'related-'+i,material_version:1,sha256}},revision_asset:null,source_version_id:null,template_id:null,template_version:null,source_name:null,source_sequence:null,created_at:now,run_id:null,links:[],version_count:1,consistency:{status:'unchecked',count:0,check_run_id:null}}));
  related.forEach(file=>checked(ProjectFileVersionSchema,file));
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method(),body=method==='POST'?req.postDataJSON():null;
    calls.push({method,path,body});
    if(path===base&&method==='GET')return reply(route,'ProjectResponse',{project_id:project,name:'合成复核项目',kind:'review',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now});
    if(path===base+'/project-files/workspace'){const current=sourceValue();if(current)checked(ProjectFileSourceSchema,current);return route.fulfill({json:{source:current}});}
    if(path===base+'/project-files/updates')return route.fulfill({json:{batches:[]}});
    if(path===base+'/project-files')return route.fulfill({json:{files:related}});
    if(path===base+'/project-files/checks'){
      if(method==='POST'){checked(schemas.ProjectFileCheckRequest,body);expect(body.expected_source_version_id).toBe(state.current_version_id);checkStarted=true;return route.fulfill({json:{run_id:'check-1'}});}
      const checks:ProjectFileCheck[]=checkStarted?[{run_id:'check-1',state:'running',stage:'checking',source:sourceValue()!,files:related.map(f=>({file_id:f.file_id,file_version_id:f.version_id,filename:f.filename,sequence:f.sequence})),updates:[],created_at:now,stale:false,sha256:null,result:null}]:[];checks.forEach(check=>checked(ProjectFileCheckSchema,check));return route.fulfill({json:{checks}});
    }
    if(path===base+'/prospectus-versions'&&method==='GET'){
      if(failRead){failRead=false;return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});}return reply(route,'ProspectusVersionsResponse',structuredClone(state));
    }
    if(path===base+'/prospectus-versions/current'&&method==='POST'){checked(schemas.ProspectusVersionSelectRequest,body);expect(body.expected_selection_revision).toBe(state.selection_revision);state.current_version_id=body.version_id;state.selection_revision++;return reply(route,'ProspectusVersionsResponse',structuredClone(state));}
    if(path===base+'/materials/uploads'&&method==='POST'){checked(schemas.UploadCreateRequest,body);const id='upload-'+(sessions.size+1);sessions.set(id,{input:body,received:false});return reply(route,'UploadSessionResponse',{upload_id:id,state:'uploading',upload_url:'/api/v1'+base+'/materials/uploads/'+id+'/bytes',expires_at:'2099-01-01T00:00:00Z',max_bytes:100*1024*1024},201);}
    const transfer=path.match(/\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
    if(transfer){const session=sessions.get(transfer[1])!;
      if(transfer[2]==='bytes'&&method==='PUT'){expect(req.postDataBuffer()).toEqual(bytes);session.received=true;return route.fulfill({status:204});}
      if(transfer[2]==='complete'&&method==='POST'){checked(schemas.UploadCompleteRequest,body);expect(body).toEqual({sha256:session.input.sha256,byte_size:session.input.byte_size});expect(session.received).toBe(true);
        if(!session.material){session.material={material_id:'material-1',material_version:1,upload_id:transfer[1],role:'historical',filename:session.input.filename,media_type:session.input.media_type,byte_size:session.input.byte_size,sha256:session.input.sha256,state:'persisted',persisted_at:now,error:null};state.versions=[{...version,filename:session.input.filename}];}
        if(failComplete){failComplete=false;return route.abort('connectionreset');}return reply(route,'MaterialResponse',session.material);
      }
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  await page.route('**/consistency-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main style="max-width:1160px;margin:0 auto;padding:32px 20px"><div id="content"></div></main></body></html>'}));
  await page.goto('/consistency-harness#consistency?project='+project);
  await page.evaluate(async prototypeRoot=>{
    const load=(path:string)=>import(path);await load('/src/style.css');await load(prototypeRoot+'styles.css');await load(prototypeRoot+'project-workspace.css');await load('/src/prototype-adapter.css');const {ApiClient}=await load('/src/api.ts'),{FileConsistency}=await load('/src/file-consistency.ts');
    const mount=async()=>{(window as any).consistencyPage?.dispose();const view=new FileConsistency(new ApiClient(()=>{}),(html:string)=>document.querySelector('#content')!.innerHTML=html,()=>true,'synthetic-review','synthetic-owner');(window as any).consistencyPage=view;await view.render();};(window as any).remountConsistency=mount;await mount();
  },prototypeRoot);
  await expect(page.getByRole('heading',{name:'文件一致性检查',exact:true})).toBeVisible();return{calls,state};
}
async function choose(page:Page,name=filename){const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'上传募集说明书',exact:true}).click();await(await chooser).setFiles({name,mimeType:name.endsWith('.pdf')?'application/pdf':mime,buffer:bytes});}
async function adopt(page:Page){const history=page.locator('[data-prospectus-history]');await history.evaluate(el=>(el as HTMLDetailsElement).open=true);await page.locator('[data-use-version="source-v1"]').click();await expect(page.locator('dialog[open]')).toBeVisible();await page.locator('#confirm-prospectus-selection').click();}
async function save(page:Page){await page.getByRole('button',{name:'上传并保存',exact:true}).click();await expect(page.locator('#prospectus-status')).toContainText(/已保存.*尚未采用/);}

test('empty check page exposes upload and both related-file paths on desktop and phone',async({page})=>{
  const f=await setup(page);await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeDisabled();await expect(page.getByRole('link',{name:'上传关联文件',exact:true})).toHaveAttribute('href','#/projects/'+project+'/files');await expect(page.getByRole('link',{name:'生成关联文件',exact:true})).toHaveAttribute('href','#generate?project='+project);await expect(page.locator('.prospectus-upload-hint')).toContainText('不启动检查或扣费');
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
});
for(const ext of ['docx','pdf'])test(`${ext} saves without adoption and only checks after separate adoption and explicit start`,async({page})=>{
  const f=await setup(page,{files:1});await choose(page,'合成募集说明书.'+ext);expect(f.calls.some(c=>c.path.endsWith('/materials/uploads'))).toBe(false);await save(page);expect(f.state.current_version_id).toBeNull();await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeDisabled();expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);expect(f.calls.filter(c=>c.path.endsWith('/checks')&&c.method==='POST')).toHaveLength(0);
  await adopt(page);await expect(page.locator('.pf-source-strip')).toContainText('合成募集说明书.'+ext);await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeEnabled();await expect(page).toHaveURL(/#consistency\?project=synthetic-review$/);expect(f.calls.some(c=>c.path===base+'/prospectus-versions'&&c.method==='POST')).toBe(false);
  await page.evaluate(()=>(window as any).remountConsistency());await expect(page.locator('.pf-source-strip')).toBeVisible();await page.getByRole('button',{name:'开始检查（免费）'}).click();await expect(page.getByRole('heading',{name:'正在检查文件一致性',exact:true})).toBeVisible();expect(f.calls.find(c=>c.path.endsWith('/checks')&&c.method==='POST')!.body.expected_source_version_id).toBe('source-v1');expect(f.calls.some(c=>/credits|batches|runs|imports/.test(c.path))).toBe(false);
});
test('source alone does not enable checking without related files',async({page})=>{const f=await setup(page);await choose(page);await save(page);await adopt(page);await expect(page.getByRole('heading',{name:'还没有可检查的关联文件'})).toBeVisible();await expect(page.locator('[data-fc-start]:enabled')).toHaveCount(0);expect(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/checks'))).toHaveLength(0);});
test('unknown completion preserves the chosen file and retries the same upload without sending bytes twice',async({page})=>{
  const f=await setup(page,{files:1,saveFailure:true});await choose(page);await page.getByRole('button',{name:'上传并保存',exact:true}).click();await expect(page.locator('[data-resume-prospectus]')).toBeVisible();await expect(page.locator('.prospectus-selected-file')).toContainText(filename);await page.getByRole('button',{name:'确认原上传',exact:true}).click();await expect(page.locator('#prospectus-status')).toContainText(/已保存.*尚未采用/);expect(f.state.current_version_id).toBeNull();expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);const completions=f.calls.filter(c=>c.path.endsWith('/complete'));expect(completions).toHaveLength(2);expect(completions[0].body).toEqual(completions[1].body);await adopt(page);await expect(page.locator('.pf-source-strip')).toBeVisible();
});
test('failed source read offers retry; a saved version needs confirmed adoption without upload',async({page})=>{
  const f=await setup(page,{files:1,readFailure:true,history:true});await page.getByRole('button',{name:'重试读取募集说明书'}).click();await adopt(page);await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeEnabled();expect(f.calls.some(c=>c.path.includes('/materials/uploads'))).toBe(false);
});
test('repaint retains a pending file; leaving the page disposes its uploader',async({page})=>{await setup(page);await choose(page);await page.evaluate(()=>(window as any).consistencyPage.paint());await expect(page.locator('.prospectus-selected-file')).toContainText(filename);await page.evaluate(()=>(window as any).consistencyPage.dispose());expect(await page.evaluate(()=>(window as any).consistencyPage.prospectus.controller.signal.aborted)).toBe(true);});
test('capture matching empty-state prototype and implementation',async({page})=>{const out=process.env.BB_CONSISTENCY_EVIDENCE;if(!out)return;await mkdir(out,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:960});await setup(page);await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeVisible();await page.locator('#content').screenshot({path:`${out}/implementation-${width}.png`});await page.goto(prototypeRoot+'prospectus-panel.html?purpose=consistency');await page.locator('#consistency-preview').screenshot({path:`${out}/prototype-${width}.png`});}});
