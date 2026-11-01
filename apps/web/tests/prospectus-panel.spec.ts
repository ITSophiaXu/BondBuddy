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
const version=(sequence:number):ProspectusVersion=>({version_id:'v'+sequence,sequence,filename:sequence===1?'合成历史募集书.docx':'合成发行人2026年度第一期公司债券募集说明书_提交审阅稿_含财务与风险披露_修订后清洁版.docx',origin:sequence===1?'upload':'generated',created_at:now,material_id:sequence===1?'material-1':null,material_version:sequence===1?1:null,artifact_id:sequence===1?null:'clean',artifact_version:sequence===1?null:1,revision_artifact_id:sequence===1?null:'revision',run_id:sequence===1?null:'generated-run',delete_block_reason:sequence===1?null:'generated',sha256});
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
    if(method==='GET'&&path.startsWith(base+'/materials/')){
      const download=path.endsWith('/download'),materialId=path.split('/').at(download?-2:-1);
      const receipt=[...sessions.values()].find(s=>s.material?.material_id===materialId)?.material;
      if(!download&&receipt)return reply(route,'MaterialResponse',receipt);
      const v=state.versions.find(v=>v.material_id===materialId);
      if(v)return download?route.fulfill({contentType:mime,body:bytes}):reply(route,'MaterialResponse',{
        material_id:v.material_id!,material_version:v.material_version!,upload_id:`upload-${v.material_id}`,role:'historical',filename:v.filename,
        media_type:mime,byte_size:bytes.length,sha256:v.sha256,state:'persisted',persisted_at:now,error:null,
      });
    }
    if(method==='DELETE'&&path.startsWith(base+'/materials/')){
      const materialId=path.split('/').at(-1);const wasCurrent=state.versions.some(v=>v.material_id===materialId&&v.version_id===state.current_version_id);state.versions=state.versions.filter(v=>v.material_id!==materialId);if(wasCurrent){state.current_version_id=state.versions[0]?.version_id??null;state.selection_revision++;}return route.fulfill({status:204});
    }
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
          state.versions.unshift({...version(1),version_id:'v3',sequence:3,filename:session.input.filename,material_id:'material-3'});if(purpose==='update'){state.current_version_id='v3';state.selection_revision++;}}
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
  const reenter=async()=>{await page.goto('/panel-harness');
  await page.evaluate(async({purpose,prototypeRoot})=>{
    const load=(path:string)=>import(path);await load('/src/style.css');await load('/src/update-entry.css');await load(prototypeRoot+'styles.css');await load(prototypeRoot+'project-workspace.css');await load('/src/prototype-adapter.css');if(purpose==='generation')await load('/src/generation-flow.css');
    const {ProspectusPanel}=await load('/src/prospectus-panel.ts'),{ApiClient}=await load('/src/api.ts');
    const panel=new ProspectusPanel(new ApiClient(()=>{}),'synthetic-panel-project',document.querySelector('#panel'),async()=>true,async()=>{},()=>{},purpose,'synthetic-owner');
    await panel.refresh();Object.assign(window,{panelFixture:{refresh:()=>panel.refresh(),sourceSelectionMessage:()=>panel.sourceSelectionMessage,hasUnconfirmed:()=>panel.hasUnconfirmed}});
  },{purpose,prototypeRoot});
  await expect(page.locator('[data-prospectus-heading]')).toBeVisible();};await reenter();return{state,calls,reenter};
}
const history=(page:Page)=>page.locator('[data-prospectus-history]');
async function dragFiles(page:Page,names:string[],empty=false){
  return page.evaluateHandle(({names,bytes})=>{const data=new DataTransfer();for(const name of names)data.items.add(new File([new Uint8Array(bytes)],name,{type:name.endsWith('.pdf')?'application/pdf':name.endsWith('.txt')?'text/plain':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));return data;},{names,bytes:empty?[]:[...bytes]});
}

test('reference upload matches the material picker, supports keyboard selection, and fits narrow screens',async({page})=>{
  await setup(page);const picker=page.getByRole('button',{name:'上传历史／参考稿',exact:true});
  await expect(picker).toHaveText('点击或拖入文件');await expect(picker).toHaveAttribute('aria-describedby','reference-upload-hint');
  await expect(picker).toHaveCSS('border-top-style','dashed');
  await expect(page.locator('.prospectus-panel-heading button')).toHaveCount(0);
  const out=process.env.BB_REFERENCE_DROP_EVIDENCE;if(out)await mkdir(out,{recursive:true});
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:960});
    const bounds=await picker.boundingBox(),files=await page.locator('[data-prospectus-files]').boundingBox();
    expect(bounds!.width).toBeCloseTo(files!.width,0);expect(bounds!.height).toBeGreaterThanOrEqual(90);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(out)await page.locator('.prospectus-panel').screenshot({path:`${out}/implementation-empty-${width}.png`});
  }
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),picker.press('Enter')]);
  await chooser.setFiles({name:'键盘选择募集书.docx',mimeType:mime,buffer:bytes});
  await expect(page.locator('.reference-file.is-selected')).toContainText('键盘选择募集书.docx');
  await expect(picker).toBeEnabled();
});

test('reference drag feedback survives child transitions and clears on leaving or dropping',async({page})=>{
  const f=await setup(page),panel=page.locator('.reference-prospectus'),picker=page.locator('.reference-upload-picker');
  const text=await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('text/plain','not a file');return data;});
  await picker.dispatchEvent('dragover',{dataTransfer:text});await expect(panel).not.toHaveClass(/is-dragging/);await text.dispose();
  const data=await dragFiles(page,['拖入募集书.pdf']);
  await picker.dispatchEvent('dragover',{dataTransfer:data});await expect(panel).toHaveClass(/is-dragging/);
  await expect(picker).toHaveCSS('background-color','rgb(237, 244, 229)');
  await picker.evaluate(el=>el.dispatchEvent(new DragEvent('dragleave',{bubbles:true,relatedTarget:el.querySelector('span')})));
  await expect(panel).toHaveClass(/is-dragging/);
  const out=process.env.BB_REFERENCE_DROP_EVIDENCE;if(out)await panel.screenshot({path:`${out}/implementation-dragging.png`});
  await panel.dispatchEvent('dragleave',{relatedTarget:null});await expect(panel).not.toHaveClass(/is-dragging/);
  // The whole reference card remains a drop target, including the file-list empty state.
  await page.locator('.reference-empty').dispatchEvent('drop',{dataTransfer:data});await data.dispose();
  await expect(page.locator('.reference-file.is-selected')).toContainText('拖入募集书.pdf');
  await expect(panel).not.toHaveClass(/is-dragging/);
  expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  expect(f.calls.filter(c=>/runs|authoring|wallet/.test(c.path))).toEqual([]);
});

test('reference drops reject invalid files and suppress a second upload while saving',async({page})=>{
  const f=await setup(page),picker=page.locator('.reference-upload-picker');
  for(const [names,empty,message] of [[['a.pdf','b.pdf'],false,'每次请选择一份'],[['错误.txt'],false,'请上传不超过 100 MB'],[['空文件.pdf'],true,'请上传不超过 100 MB']] as const){
    const data=await dragFiles(page,[...names],empty);await picker.dispatchEvent('drop',{dataTransfer:data});await data.dispose();
    await expect(page.getByRole('alert')).toContainText(message);expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  }
  let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
  await page.route('**/materials/uploads/*/bytes',async route=>{await blocked;await route.fallback();});
  const data=await dragFiles(page,['正确参考稿.docx']);
  try{
    await picker.dispatchEvent('drop',{dataTransfer:data});await expect(picker).toBeDisabled();
    await expect.poll(()=>f.calls.filter(c=>c.path.endsWith('/materials/uploads')).length).toBe(1);
    await picker.dispatchEvent('dragover',{dataTransfer:data});await expect(page.locator('.reference-prospectus')).not.toHaveClass(/is-dragging/);
    await picker.dispatchEvent('drop',{dataTransfer:data});
    expect(f.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);
  }finally{release();await data.dispose();}
  await expect(page.locator('.reference-file.is-selected')).toContainText('正确参考稿.docx');
  await expect(picker).toBeEnabled();expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
});

async function selectFile(page:Page,name='合成新稿.docx'){const chooser=page.waitForEvent('filechooser');await page.locator('#choose-prospectus-version').click();await(await chooser).setFiles({name,mimeType:name.endsWith('.txt')?'text/plain':mime,buffer:bytes});}
async function adopt(page:Page,id:string){await history(page).evaluate(el=>(el as HTMLDetailsElement).open=true);await page.locator('[data-use-version="'+id+'"]').click();await expect(page.locator('dialog[open]')).toBeVisible();}

test('empty state exposes upload, has no saved history entries, and fits phone widths',async({page})=>{
  await setup(page);await expect(page.getByRole('button',{name:/^(上传募集说明书|上传历史／参考稿)$/})).toBeVisible();await expect(history(page).locator('[data-prospectus-version]')).toHaveCount(0);await expect(page.locator('.reference-empty')).toContainText('没有参考稿也可以继续');
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:/^(上传募集说明书|上传历史／参考稿)$/}).click();await chooser;
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const card=await page.locator('.prospectus-panel').boundingBox(),heading=await page.locator('[data-prospectus-heading]').boundingBox();expect(heading!.x-card!.x).toBeGreaterThanOrEqual(18);}
});

for(const purpose of ['update','consistency'])test(purpose+' uploads a corrected selection with purpose-specific adoption and no task execution',async({page})=>{
  const f=await setup(page,{purpose});await selectFile(page,'错误.txt');await page.evaluate(()=>window.panelFixture.refresh());await expect(page.getByRole('alert')).toContainText('请上传不超过 100 MB');expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  await expect(page.getByRole('button',{name:'上传并保存',exact:true})).toHaveCount(0);
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'重新选择',exact:true}).click();await(await chooser).setFiles({name:'合成新稿.docx',mimeType:mime,buffer:bytes});
  await expect(page.locator('#prospectus-status')).toContainText(purpose==='update'?/已保存并自动采用/:/已保存.*尚未采用/);await page.evaluate(()=>window.panelFixture.refresh());
  expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(f.state.current_version_id).toBe(purpose==='update'?'v3':null);await expect(page.locator('#save-prospectus-version')).toBeHidden();
  expect(await page.evaluate(()=>window.panelFixture.sourceSelectionMessage())).toBe('');
  if(process.env.BB_UPLOAD_EVIDENCE){await mkdir(process.env.BB_UPLOAD_EVIDENCE,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('.prospectus-panel').screenshot({path:`${process.env.BB_UPLOAD_EVIDENCE}/${purpose}-uploaded-${width}.png`});}}
});

for(const purpose of ['update','consistency'])test(purpose+' drops one file and ignores a second selection event while uploading',async({page})=>{
  const f=await setup(page,{purpose});
  await page.evaluate(bytes=>{const input=document.querySelector<HTMLInputElement>('#prospectus-version-file')!,data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'拖入募集书.pdf',{type:'application/pdf'}));document.querySelector('.prospectus-upload-editor')!.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));input.dispatchEvent(new Event('change',{bubbles:true}));},[...bytes]);
  await expect(page.locator('#prospectus-status')).toContainText(purpose==='update'?/已保存并自动采用/:/已保存.*尚未采用/);expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(f.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);expect(f.state.current_version_id).toBe(purpose==='update'?'v3':null);
});

test('unknown upload receipt retries the original session and keeps the automatically adopted source',async({page})=>{
  const f=await setup(page,{retry:true});await selectFile(page);await expect(page.locator('[data-resume-prospectus]')).toBeVisible();await expect(page.locator('.prospectus-selected-file')).toContainText('合成新稿.docx');
  await page.getByRole('button',{name:'确认原上传',exact:true}).click();await expect(page.locator('#prospectus-status')).toContainText(/已保存并自动采用/);expect(f.state.current_version_id).toBe('v3');expect(f.state.selection_revision).toBe(1);expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);
  expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(f.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);const completions=f.calls.filter(c=>c.path.endsWith('/complete'));expect(completions).toHaveLength(2);expect(completions[0].body).toEqual(completions[1].body);
  await expect(page.locator('.reference-file.is-selected')).toContainText('本次更新已选用');await expect(page.locator('[data-use-version="v3"]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.panelFixture.sourceSelectionMessage())).toBe('');
});

test('current version downloads, history disclosure survives refresh, and adoption needs confirmation',async({page})=>{
  const f=await setup(page,{versions:true});const download=page.waitForEvent('download');await page.locator('.reference-file.is-selected').getByRole('button',{name:'下载清洁版'}).click();expect((await download).suggestedFilename()).toBe('募集说明书_V2_清洁版.docx');
  await expect(history(page)).toBeHidden();const details=page.locator('[data-prospectus-version="v1"] [data-prospectus-ref]');await details.locator('summary').focus();await page.keyboard.press('Enter');await page.evaluate(()=>window.panelFixture.refresh());await expect(details).toHaveAttribute('open','');await expect(details.locator('summary')).toBeFocused();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await adopt(page,'v1');expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);await page.locator('#confirm-prospectus-selection').click();await expect(page.locator('.reference-file.is-selected')).toContainText('本次更新已选用');expect(f.calls.find(c=>c.path.endsWith('/prospectus-versions/current'))!.body).toMatchObject({version_id:'v1',expected_selection_revision:2});
});

test('generation guidance and same-size visual evidence',async({page})=>{
  await setup(page,{purpose:'generation'});await expect(page.locator('#choose-prospectus-version')).toBeVisible();await expect(history(page)).toBeHidden();await expect(page.getByText('上传募集书新版本',{exact:true})).toHaveCount(0);await expect(page.locator('.pf-source-modes')).toBeHidden();
  const out=process.env.BB_PANEL_EVIDENCE;if(!out)return;await mkdir(out,{recursive:true});
  for(const state of ['empty','current'])for(const width of [1440,390]){await page.setViewportSize({width,height:960});await setup(page,{versions:state==='current'});await page.locator('.prospectus-panel').screenshot({path:`${out}/implementation-${state}-${width}.png`});await page.goto(prototypeRoot+'prospectus-panel.html?state='+state);await page.locator('.prospectus-panel').screenshot({path:`${out}/prototype-${state}-${width}.png`});}
});

for(const width of [1440,390,320])test(`generation empty project only exposes upload, ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:960});const f=await setup(page,{purpose:'generation'});
  const out=process.env.BB_EMPTY_SOURCE_EVIDENCE;
  if(out){await mkdir(out,{recursive:true});await page.screenshot({path:`${out}/implementation-empty-${width}.png`,fullPage:true});}
  await expect(page.getByRole('radio',{name:'选择项目已有募集说明书',exact:true})).toBeHidden();
  await expect(page.locator('.pf-source-modes')).toBeHidden();await expect(page.locator('#pf-source-existing')).toBeHidden();
  await expect(page.locator('#choose-prospectus-version')).toBeVisible();
  await expect(page.locator('.pf-source-picker')).not.toContainText('选择一种方式');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('generation refresh removes stale project choice and restores it for saved unselected versions',async({page})=>{
  const f=await setup(page,{purpose:'generation',versions:true});
  const existing=page.getByRole('radio',{name:'选择项目已有募集说明书',exact:true});
  await page.getByRole('radio',{name:'上传新募集说明书',exact:true}).check();await existing.check();
  f.state.versions=[];f.state.current_version_id=null;f.state.selection_revision++;
  await page.evaluate(()=>window.panelFixture.refresh());
  await expect(existing).toBeHidden();await expect(page.locator('#pf-source-existing')).toBeHidden();
  await expect(page.locator('#choose-prospectus-version')).toBeVisible();
  f.state.versions=[version(1)];await page.evaluate(()=>window.panelFixture.refresh());
  await expect(existing).toBeVisible();await existing.check();
  await expect(page.locator('#pf-project-source option')).toHaveText(['请选择募集说明书版本','V1 · 合成历史募集书.docx']);
  await expect(page.locator('.pf-selected-source')).toHaveCount(0);
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('generation does not offer unverified versions as existing project sources',async({page})=>{
  const f=await setup(page,{purpose:'generation',versions:true});f.state.project_id='another-project';
  await page.evaluate(()=>window.panelFixture.refresh());
  await expect(page.getByRole('radio',{name:'选择项目已有募集说明书',exact:true})).toBeHidden();
  await expect(page.locator('#pf-source-existing')).toBeHidden();await expect(page.locator('#choose-prospectus-version')).toBeVisible();
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('generation drop zone validates files and automatically saves one valid file',async({page})=>{
  const f=await setup(page,{purpose:'generation'});
  const drop=async(names:string[])=>{const data=await page.evaluateHandle(({names,bytes})=>{const data=new DataTransfer();for(const name of names)data.items.add(new File([new Uint8Array(bytes)],name,{type:'application/pdf'}));return data;},{names,bytes:[...bytes]});await page.locator('#choose-prospectus-version').dispatchEvent('drop',{dataTransfer:data});await data.dispose();};
  await drop(['a.pdf','b.pdf']);await expect(page.locator('#prospectus-status')).toContainText('每次请选择一份');
  await drop(['错误.txt']);await expect(page.locator('#save-prospectus-version')).toBeDisabled();
  await page.locator('#cancel-prospectus-version').click();await drop(['拖放募集书.pdf']);
  await expect(page.locator('.pf-selected-source')).toContainText('拖放募集书.pdf');
  await page.evaluate(()=>window.panelFixture.refresh());
  await expect(page.locator('.pf-selected-source')).toBeVisible();
  await expect(page.locator('.pf-source-upload-state')).toHaveCount(0);
  await expect(page.locator('#save-prospectus-version')).toBeHidden();
  expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  expect(f.state.current_version_id).toBe('v3');
});

test('generation upload recovery auto-selects saved source using the original receipt',async({page})=>{
  const f=await setup(page,{purpose:'generation',retry:true});await selectFile(page);
  await expect(page.locator('#save-prospectus-version')).toBeVisible();
  await page.locator('#save-prospectus-version').click();await expect(page.locator('.pf-selected-source')).toContainText('合成新稿.docx');
  expect(f.state.current_version_id).toBe('v3');expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('.pf-selected-source')).toContainText('V3');
  expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(1);
});
declare global{interface Window{panelFixture:{refresh:()=>Promise<void>;sourceSelectionMessage:()=>string;hasUnconfirmed:()=>boolean}}}

test('mistaken saved upload can be cancelled, deleted, refreshed away and replaced',async({page})=>{
  const f=await setup(page);await expect(page.locator('[data-prospectus-heading]')).toHaveText('历史／参考募集书（选填）');
  await expect(page.getByRole('button',{name:'先提供发行人材料'})).toBeVisible();
  await selectFile(page,'误上传的历史稿.docx');
  const row=page.locator('[data-prospectus-version="v3"]');await expect(row).toContainText('本次更新已选用');await expect(row.locator('[data-use-version]')).toHaveCount(0);
  await row.getByRole('button',{name:'删除',exact:true}).click();await page.locator('[data-cancel-delete]').click();expect(f.calls.filter(c=>c.method==='DELETE')).toHaveLength(0);
  await row.getByRole('button',{name:'删除',exact:true}).click();await page.locator('[data-confirm-delete]').click();
  await expect(row).toHaveCount(0);await page.evaluate(()=>window.panelFixture.refresh());await expect(history(page).locator('[data-prospectus-version]')).toHaveCount(0);
  expect(f.calls.filter(c=>c.method==='DELETE')).toHaveLength(1);expect(f.state.current_version_id).toBeNull();
  expect(await page.evaluate(()=>window.panelFixture.sourceSelectionMessage())).toBe('');
  await selectFile(page,'正确参考稿.docx');await expect(page.locator('[data-prospectus-version="v3"]')).toContainText('正确参考稿.docx');
  expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);
});

test('used and current uploads explain why deletion is unavailable',async({page})=>{
  const f=await setup(page,{versions:true});f.state.versions[1].delete_block_reason='used';await page.evaluate(()=>window.panelFixture.refresh());
  await history(page).evaluate(el=>(el as HTMLDetailsElement).open=true);
  await expect(page.locator('[data-prospectus-version="v1"]')).toContainText('已被任务或关联文件使用');await expect(page.locator('[data-delete-version]')).toHaveCount(0);
  f.state.current_version_id='v1';f.state.selection_revision++;f.state.versions[1].delete_block_reason='current';await page.evaluate(()=>window.panelFixture.refresh());
  await expect(page.locator('[data-prospectus-version="v1"]')).toContainText('本次更新已选用');await expect(page.locator('[data-delete-version]')).toHaveCount(0);
});

test('concurrent adoption blocks deletion and reconciles the current version',async({page})=>{
  const f=await setup(page,{versions:true});await history(page).evaluate(el=>(el as HTMLDetailsElement).open=true);
  await page.locator('[data-delete-version="v1"]').click();
  await page.route('**/materials/material-1',async route=>{
    f.state.current_version_id='v1';f.state.selection_revision++;f.state.versions[1].delete_block_reason='current';
    return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT',message:'changed'}});
  });
  await page.locator('[data-confirm-delete]').click();await expect(page.locator('#prospectus-status')).toContainText('不能删除');await expect(page.locator('.reference-file.is-selected')).toContainText('合成历史募集书');
  await expect(page.locator('[data-delete-version="v1"]')).toHaveCount(0);
});

test('uploaded references remain visible on reentry and only previous generated outputs collapse',async({page})=>{
  const f=await setup(page,{versions:true});
  const longName='相似业务企业2025年度第一期公司债券募集说明书_含财务报表及附注_供本次结构参考.docx';
  f.state.versions.push({...version(1),version_id:'v4',sequence:4,material_id:'material-4',filename:longName});
  f.state.versions.push({...version(2),version_id:'v3',sequence:3});
  f.state.current_version_id=null;await f.reenter();
  await expect(page.locator('[data-prospectus-files] [data-prospectus-version]')).toHaveCount(2);
  await expect(page.locator('[data-prospectus-saved-notice]')).toHaveCount(0);
  await expect(page.locator('.prospectus-upload-editor')).toBeHidden();
  for(const id of ['v1','v4']){
    const row=page.locator(`[data-prospectus-version="${id}"]`);
    await expect(row).toBeVisible();await expect(row.getByRole('button',{name:'改用此版'})).toBeVisible();
    await expect(row.getByRole('button',{name:'下载原文件'})).toBeVisible();await expect(row.getByRole('button',{name:'删除',exact:true})).toBeVisible();
  }
  await expect(history(page)).not.toHaveAttribute('open','');await expect(history(page).locator('[data-prospectus-version]')).toHaveCount(2);
  await history(page).locator(':scope > summary').click();await expect(history(page).locator('[data-prospectus-version="v3"]')).toBeVisible();
  await history(page).locator(':scope > summary').click();await expect(history(page).locator('[data-prospectus-version="v3"]')).toBeHidden();
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  const downloaded=page.waitForEvent('download');await page.locator('[data-prospectus-version="v4"]').getByRole('button',{name:'下载原文件'}).click();
  const original=await downloaded;expect(original.suggestedFilename()).toBe(longName);
  const stream=await original.createReadStream(),chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));expect(Buffer.concat(chunks)).toEqual(bytes);
  await page.locator('[data-use-version="v1"]').click();await page.locator('#cancel-prospectus-selection').click();expect(f.state.current_version_id).toBeNull();
  await page.locator('[data-use-version="v1"]').click();await page.locator('#confirm-prospectus-selection').click();
  await f.reenter();await expect(page.locator('[data-prospectus-files] [data-prospectus-version]').first()).toHaveAttribute('data-prospectus-version','v1');
  await expect(page.locator('[data-prospectus-version="v1"] [data-prospectus-selection-state]')).toHaveText('本次更新已选用');
  await expect(page.locator('[data-prospectus-version="v4"]')).toBeVisible();
  for(const width of [1440,900,390,320]){
    await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.BB_REFERENCE_EVIDENCE)await page.locator('.prospectus-panel').screenshot({path:`${process.env.BB_REFERENCE_EVIDENCE}/implementation-multiple-${width}.png`});
  }
});

test('reference upload visual comparison at desktop and mobile widths',async({page})=>{
  const out=process.env.BB_REFERENCE_EVIDENCE;if(!out)return;await mkdir(out,{recursive:true});
  for(const width of [1440,390,320])for(const saved of [false,true]){
    const f=await setup(page);await page.setViewportSize({width,height:960});
    if(saved){f.state.versions=[version(1)];f.state.current_version_id='v1';f.state.selection_revision=1;await page.evaluate(()=>window.panelFixture.refresh());await history(page).evaluate(el=>(el as HTMLDetailsElement).open=true);}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.locator('.prospectus-panel').screenshot({path:`${out}/implementation-${saved?'saved':'empty'}-${width}.png`});
    await page.goto(prototypeRoot+`prospectus-reference.html?state=${saved?'saved':'empty'}`);
    await page.locator('.prospectus-panel').screenshot({path:`${out}/prototype-${saved?'saved':'empty'}-${width}.png`});
  }
});


test('failed version read after automatic adoption blocks starting until the same upload is confirmed',async({page})=>{
  const f=await setup(page);let failRead=true;
  await page.route('**/prospectus-versions',route=>{if(failRead){failRead=false;return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});}return route.fallback();});
  await selectFile(page);
  await expect(page.locator('#prospectus-status')).toContainText('版本记录暂未读取');
  expect(await page.evaluate(()=>window.panelFixture.hasUnconfirmed())).toBe(true);
  await page.locator('#save-prospectus-version').click();
  await expect(page.locator('#prospectus-status')).toContainText('已保存并自动采用');
  expect(await page.evaluate(()=>window.panelFixture.hasUnconfirmed())).toBe(false);
  expect(f.state.current_version_id).toBe('v3');expect(f.state.selection_revision).toBe(1);
  expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);
});
