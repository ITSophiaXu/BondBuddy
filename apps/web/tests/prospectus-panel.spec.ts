import {test,expect,type Page,type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {schemas,type ProspectusVersions,type ProspectusVersion} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import type {Dto} from '../src/api';
import '../src/schema-formats';

const prototypeRoot='/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/',import.meta.url)).replaceAll('\\','/');
const project='synthetic-panel-project',base='/api/v1/projects/'+project,now='2026-10-25T02:00:00Z';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const bytes=Buffer.from('synthetic prospectus panel transport fixture'),sha256=createHash('sha256').update(bytes).digest('hex');
const version=(sequence:number):ProspectusVersion=>({version_id:'v'+sequence,sequence,filename:sequence===1?'合成历史募集书.docx':'合成发行人2026年度第一期公司债券募集说明书_提交审阅稿_含财务与风险披露_修订后清洁版.docx',origin:sequence===1?'upload':'generated',created_at:now,material_id:sequence===1?'material-1':null,material_version:sequence===1?1:null,artifact_id:sequence===1?null:'clean',artifact_version:sequence===1?null:1,revision_artifact_id:sequence===1?null:'revision',run_id:sequence===1?null:'generated-run',sha256});
function checked<K extends keyof typeof schemas>(name:K,value:unknown){expect([...Value.Errors(schemas[name],value)].map(e=>({path:e.path,message:e.message})),name).toEqual([]);}
async function reply<K extends keyof typeof schemas>(route:Route,name:K,value:Dto<K>,status=200){checked(name,value);return route.fulfill({status,json:value});}
// Real component and ApiClient; synthetic bytes, owners and receipts, without model/storage/billing.
async function setup(page:Page,{versions=false,purpose='update',retry=false}={}){
  const state:ProspectusVersions={project_id:project,selection_revision:versions?2:0,current_version_id:versions?'v2':null,versions:versions?[version(2),version(1)]:[],inactive_material_ids:[]};
  const calls:{method:string;path:string;body:any}[]=[],sessions=new Map<string,{input:Dto<'UploadCreateRequest'>;received:boolean;material?:Dto<'MaterialResponse'>}>();
  let dropComplete=retry;
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const body=method==='POST'?request.postDataJSON():null;calls.push({method,path,body});
    if(path===base+'/prospectus-versions'&&method==='GET')return reply(route,'ProspectusVersionsResponse',structuredClone(state));
    if(path===base+'/materials/uploads'&&method==='POST'){
      checked('UploadCreateRequest',body);const id='upload-'+(sessions.size+1);sessions.set(id,{input:body,received:false});
      return reply(route,'UploadSessionResponse',{upload_id:id,state:'uploading',upload_url:base+'/materials/uploads/'+id+'/bytes',expires_at:'2099-01-01T00:00:00Z',max_bytes:100*1024*1024},201);
    }
    const transfer=path.match(/\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
    if(transfer){const session=sessions.get(transfer[1])!;
      if(transfer[2]==='bytes'&&method==='PUT'){expect(request.postDataBuffer()).toEqual(bytes);session.received=true;return route.fulfill({status:204});}
      if(transfer[2]==='complete'&&method==='POST'){
        checked('UploadCompleteRequest',body);expect(body).toEqual({sha256:session.input.sha256,byte_size:session.input.byte_size});expect(session.received).toBe(true);
        if(!session.material){session.material={material_id:'material-3',material_version:1,upload_id:transfer[1],role:'historical',filename:session.input.filename,media_type:session.input.media_type,byte_size:session.input.byte_size,sha256:session.input.sha256,state:'persisted',persisted_at:now,error:null};
          state.versions.unshift({...version(1),version_id:'v3',sequence:3,filename:session.input.filename,material_id:'material-3'});}
        if(dropComplete){dropComplete=false;return route.abort('connectionreset');}
        return reply(route,'MaterialResponse',session.material);
      }
    }
    if(path===base+'/prospectus-versions/current'&&method==='POST'){
      checked('ProspectusVersionSelectRequest',body);expect(body.expected_selection_revision).toBe(state.selection_revision);state.current_version_id=body.version_id;state.selection_revision++;
      return reply(route,'ProspectusVersionsResponse',structuredClone(state));
    }
    if(path==='/api/v1/artifacts/clean')return reply(route,'ArtifactResponse',{artifact_id:'clean',run_id:'generated-run',version:1,filename:'募集说明书_V2_清洁版.docx',media_type:mime,sha256,quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/clean/download',expires_at:'2099-01-01T00:00:00Z'});
    if(path==='/api/v1/artifacts/clean/download')return route.fulfill({contentType:mime,body:bytes});
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  await page.route('**/panel-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main style="max-width:1160px;margin:0 auto;padding:32px 20px"><div id="panel"></div></main></body></html>'}));
  await page.goto('/panel-harness');
  await page.evaluate(async({purpose,prototypeRoot})=>{
    const load=(path:string)=>import(path);await load('/src/style.css');await load('/src/update-entry.css');await load(prototypeRoot+'styles.css');await load(prototypeRoot+'project-workspace.css');await load('/src/prototype-adapter.css');
    const {ProspectusPanel}=await load('/src/prospectus-panel.ts'),{ApiClient}=await load('/src/api.ts');
    const panel=new ProspectusPanel(new ApiClient(()=>{}),'synthetic-panel-project',document.querySelector('#panel'),async()=>true,async()=>{},()=>{},purpose,'synthetic-owner');
    await panel.refresh();Object.assign(window,{panelFixture:{refresh:()=>panel.refresh()}});
  },{purpose,prototypeRoot});
  await expect(page.getByRole('heading',{name:'项目募集说明书'})).toBeVisible();return{state,calls};
}
const history=(page:Page)=>page.locator('[data-prospectus-history]');
async function selectFile(page:Page,name='合成新稿.docx'){const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'上传募集说明书',exact:true}).click();await(await chooser).setFiles({name,mimeType:name.endsWith('.txt')?'text/plain':mime,buffer:bytes});}
async function adopt(page:Page,id:string){await history(page).evaluate(el=>(el as HTMLDetailsElement).open=true);await page.locator('[data-use-version="'+id+'"]').click();await expect(page.locator('dialog[open]')).toBeVisible();}

test('empty state exposes upload, has no saved history entries, and fits phone widths',async({page})=>{
  await setup(page);await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeVisible();await expect(history(page).locator('[data-prospectus-version]')).toHaveCount(0);await expect(page.getByText('尚未保存募集说明书')).toBeVisible();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'上传募集说明书',exact:true}).click();await chooser;
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const card=await page.locator('.prospectus-panel').boundingBox(),heading=await page.getByRole('heading',{name:'项目募集说明书'}).boundingBox();expect(heading!.x-card!.x).toBeGreaterThanOrEqual(18);}
});

test('file choice is explicit, survives refresh, and can be cancelled or corrected',async({page})=>{
  const f=await setup(page);await selectFile(page,'错误.txt');await page.evaluate(()=>window.panelFixture.refresh());await expect(page.getByRole('alert')).toContainText('请上传不超过 100 MB');await expect(page.getByRole('button',{name:'上传并保存',exact:true})).toBeDisabled();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'重新选择',exact:true}).click();await(await chooser).setFiles({name:'合成新稿.docx',mimeType:mime,buffer:bytes});await page.evaluate(()=>window.panelFixture.refresh());
  await expect(page.locator('.prospectus-selected-file')).toContainText('合成新稿.docx');expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.prospectus-selected-file')).toHaveCount(0);await expect(page.getByLabel('募集书新版本文件')).toHaveValue('');await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeFocused();
});

test('unknown upload receipt retries the original session without reupload and saving does not adopt',async({page})=>{
  const f=await setup(page,{retry:true});await selectFile(page);await page.getByRole('button',{name:'上传并保存',exact:true}).click();await expect(page.locator('[data-resume-prospectus]')).toBeVisible();await expect(page.locator('.prospectus-selected-file')).toContainText('合成新稿.docx');
  await page.getByRole('button',{name:'确认原上传',exact:true}).click();await expect(page.locator('#prospectus-status')).toContainText(/已保存.*尚未采用/);expect(f.state.current_version_id).toBeNull();expect(f.state.selection_revision).toBe(0);expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);
  expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(f.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);const completions=f.calls.filter(c=>c.path.endsWith('/complete'));expect(completions).toHaveLength(2);expect(completions[0].body).toEqual(completions[1].body);
  await adopt(page,'v3');expect(f.state.current_version_id).toBeNull();await page.locator('#confirm-prospectus-selection').click();await expect(page.locator('.prospectus-current-file')).toContainText('当前版本 · V3');expect(f.state.current_version_id).toBe('v3');
});

test('current version downloads, history disclosure survives refresh, and adoption needs confirmation',async({page})=>{
  const f=await setup(page,{versions:true});const download=page.waitForEvent('download');await page.locator('.prospectus-current-file').getByRole('button',{name:'下载清洁版'}).click();expect((await download).suggestedFilename()).toBe('募集说明书_V2_清洁版.docx');
  await history(page).locator(':scope > summary').focus();await page.keyboard.press('Enter');await expect(history(page)).toHaveAttribute('open','');await page.evaluate(()=>window.panelFixture.refresh());await expect(history(page)).toHaveAttribute('open','');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await adopt(page,'v1');expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);await page.locator('#confirm-prospectus-selection').click();await expect(page.locator('.prospectus-current-file')).toContainText('当前版本 · V1');expect(f.calls.find(c=>c.path.endsWith('/prospectus-versions/current'))!.body).toMatchObject({version_id:'v1',expected_selection_revision:2});
});

test('generation guidance and same-size visual evidence',async({page})=>{
  await setup(page,{purpose:'generation'});await expect(page.locator('.pf-prospectus-dropzone')).toBeVisible();await expect(history(page)).toBeHidden();await expect(page.getByText('上传募集书新版本',{exact:true})).toHaveCount(0);await expect(page.locator('.prospectus-upload-hint')).toContainText('不启动生成或扣费');
  const out=process.env.BB_PANEL_EVIDENCE;if(!out)return;await mkdir(out,{recursive:true});
  for(const state of ['empty','current'])for(const width of [1440,390]){await page.setViewportSize({width,height:960});await setup(page,{versions:state==='current'});await page.locator('.prospectus-panel').screenshot({path:`${out}/implementation-${state}-${width}.png`});await page.goto(prototypeRoot+'prospectus-panel.html?state='+state);await page.locator('.prospectus-panel').screenshot({path:`${out}/prototype-${state}-${width}.png`});}
});

test('generation drop zone validates files and retains the pending choice across refresh',async({page})=>{
  const f=await setup(page,{purpose:'generation'});
  const drop=async(names:string[])=>{const data=await page.evaluateHandle(names=>{const data=new DataTransfer();for(const name of names)data.items.add(new File(['synthetic'],name,{type:'application/pdf'}));return data;},names);await page.locator('.pf-prospectus-dropzone').dispatchEvent('drop',{dataTransfer:data});await data.dispose();};
  await drop(['a.pdf','b.pdf']);await expect(page.locator('#prospectus-status')).toContainText('每次请选择一份');
  await drop(['错误.txt']);await expect(page.locator('#save-prospectus-version')).toBeDisabled();
  await page.locator('#cancel-prospectus-version').click();await drop(['拖放募集书.pdf']);
  await page.evaluate(()=>window.panelFixture.refresh());
  await expect(page.locator('.prospectus-selected-file')).toContainText('拖放募集书.pdf');
  await expect(page.locator('.pf-prospectus-dropzone')).toBeHidden();
  await expect(page.locator('#save-prospectus-version')).toBeEnabled();
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('generation upload recovery and explicit adoption still use the original receipt',async({page})=>{
  const f=await setup(page,{purpose:'generation',retry:true});await selectFile(page);
  await page.locator('#save-prospectus-version').click();await expect(page.locator('[data-resume-prospectus]')).toBeVisible();
  await page.locator('[data-resume-prospectus]').click();await expect(page.locator('#prospectus-status')).toContainText(/已保存.*尚未采用/);
  expect(f.state.current_version_id).toBeNull();expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  await adopt(page,'v3');await page.locator('#confirm-prospectus-selection').click();
  await expect(page.locator('.prospectus-current-file')).toContainText('当前版本 · V3');
  expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(1);
});
declare global{interface Window{panelFixture:{refresh:()=>Promise<void>}}}
