import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const prototypeRoot='/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/',import.meta.url)).replaceAll('\\','/');
const project='synthetic-review',base='/projects/'+project,filename='合成募集说明书.docx';
// Real page, ApiClient and upload component; synthetic HTTP responses, no backend/model/billing.
async function setup(page:Page,{files=0,source=false,saveFailure=false,readFailure=false,history=false}={}){
  const calls:{method:string;path:string;body:any}[]=[];
  let current=source,failSave=saveFailure,failRead=readFailure,checkStarted=false;
  let upload:any;
  const version={version_id:'source-v1',sequence:1,filename,origin:'upload',created_at:'2026-10-25T02:00:00Z',material_id:'material-1',material_version:1,sha256:'a'.repeat(64)};
  const sourceValue=()=>current?{project_id:project,version_id:'source-v1',selection_revision:1,sequence:1,filename}:null;
  const versions=()=>({current_version_id:current?'source-v1':null,selection_revision:current?1:0,versions:current||history?[version]:[],inactive_material_ids:[]});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method();
    const body=req.postData()&&method!=='PUT'?req.postDataJSON():null;
    calls.push({method,path,body});let result:unknown={},status=200;
    if(path===base)result={project_id:project,name:'合成复核项目'};
    else if(path===base+'/project-files/workspace')result={source:sourceValue()};
    else if(path===base+'/project-files/updates')result={batches:[]};
    else if(path===base+'/project-files')result={files:Array.from({length:files},(_,i)=>({file_id:'file-'+i,version_id:'file-v'+i,latest:true}))};
    else if(path===base+'/project-files/checks'){
      if(method==='POST'){checkStarted=true;result={run_id:'check-1'};}
      else result={checks:checkStarted?[{run_id:'check-1',state:'running',source:sourceValue(),files:[{}],updates:[],created_at:'2026-10-25T02:00:00Z'}]:[]};
    }else if(path===base+'/prospectus-versions'){
      if(method==='GET'&&failRead){failRead=false;status=503;result={code:'DATA_UNAVAILABLE'};}
      else if(method==='POST'&&failSave){failSave=false;status=503;result={code:'DATA_UNAVAILABLE'};}
      else{if(method==='POST')current=true;result=versions();}
    }else if(path===base+'/prospectus-versions/current'){current=true;result=versions();}
    else if(path===base+'/materials/uploads'){upload=body;result={upload_id:'upload-1',upload_url:'/api/v1/synthetic-bytes',expires_at:'2099-01-01T00:00:00Z'};}
    else if(path==='/synthetic-bytes'){expect(req.postDataBuffer()!.length).toBe(upload.byte_size);await route.fulfill({status:204});return;}
    else if(path===base+'/materials/uploads/upload-1/complete')result={material_id:'material-1',material_version:1,sha256:upload.sha256};
    else{status=404;result={code:'NOT_FOUND'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.route('**/consistency-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main style="max-width:1160px;margin:0 auto;padding:32px 20px"><div id="content"></div></main></body></html>'}));
  await page.goto('/consistency-harness#consistency?project='+project);
  await page.evaluate(async prototypeRoot=>{
    const load=(path:string)=>import(path);
    await load('/src/style.css');await load(prototypeRoot+'styles.css');await load(prototypeRoot+'project-workspace.css');await load('/src/prototype-adapter.css');
    const {ApiClient}=await load('/src/api.ts'),{FileConsistency}=await load('/src/file-consistency.ts');
    const mount=async()=>{(window as any).consistencyPage?.dispose();const view=new FileConsistency(new ApiClient(()=>{}),(html:string)=>document.querySelector('#content')!.innerHTML=html,()=>true,'synthetic-review');(window as any).consistencyPage=view;await view.render();};
    (window as any).remountConsistency=mount;await mount();
  },prototypeRoot);
  await expect(page.getByRole('heading',{name:'文件一致性检查',exact:true})).toBeVisible();
  return calls;
}
async function choose(page:Page,name=filename){
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'上传募集说明书',exact:true}).click();
  await(await chooser).setFiles({name,mimeType:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic upload bytes')});
}
test('empty check page exposes upload and both related-file paths on desktop and phone',async({page})=>{
  const calls=await setup(page);
  await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeDisabled();
  await expect(page.getByRole('link',{name:'上传关联文件'})).toHaveAttribute('href','#/projects/'+project+'/files');
  await expect(page.getByRole('link',{name:'生成关联文件'})).toHaveAttribute('href','#generate?project='+project);
  await expect(page.locator('.prospectus-upload-hint')).toContainText('不启动检查或扣费');
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  expect(calls.filter(c=>c.method!=='GET').map(c=>c.path)).toEqual([base+'/project-files/workspace']);
});
for(const ext of ['docx','pdf'])test(`${ext} upload stays in the project, saves source and only checks after explicit click`,async({page})=>{
  const calls=await setup(page,{files:1});await choose(page,'合成募集说明书.'+ext);
  expect(calls.some(c=>c.path.endsWith('/materials/uploads'))).toBe(false);
  await page.getByRole('button',{name:'保存为当前版本'}).click();
  await expect(page.locator('.pf-source-strip')).toContainText(filename);
  await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeEnabled();
  await expect(page).toHaveURL(/#consistency\?project=synthetic-review$/);
  expect(calls.filter(c=>c.path.endsWith('/checks')&&c.method==='POST')).toHaveLength(0);
  const save=calls.find(c=>c.path===base+'/prospectus-versions'&&c.method==='POST')!;
  expect(save.body).toMatchObject({material_id:'material-1',material_version:1,expected_selection_revision:0});
  await page.evaluate(()=>(window as any).remountConsistency());
  await expect(page.locator('.pf-source-strip')).toContainText(filename);
  await page.getByRole('button',{name:'开始检查（免费）'}).click();
  await expect(page.getByRole('heading',{name:'正在检查文件一致性',exact:true})).toBeVisible();
  expect(calls.find(c=>c.path.endsWith('/checks')&&c.method==='POST')!.body.expected_source_version_id).toBe('source-v1');
  expect(calls.some(c=>/credits|batches|runs|imports/.test(c.path))).toBe(false);
});
test('source alone does not enable checking without related files',async({page})=>{
  await setup(page);await choose(page);await page.getByRole('button',{name:'保存为当前版本'}).click();
  await expect(page.getByRole('heading',{name:'还没有可检查的关联文件'})).toBeVisible();
  await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeDisabled();
});
test('save failure preserves chosen file and retries without uploading bytes twice',async({page})=>{
  const calls=await setup(page,{files:1,saveFailure:true});await choose(page);await page.getByRole('button',{name:'保存为当前版本'}).click();
  await expect(page.locator('#prospectus-status')).toHaveAttribute('role','alert');
  await expect(page.locator('.prospectus-selected-file')).toContainText(filename);
  await page.getByRole('button',{name:'保存为当前版本'}).click();await expect(page.locator('.pf-source-strip')).toBeVisible();
  expect(calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  const saves=calls.filter(c=>c.method==='POST'&&c.path===base+'/prospectus-versions');expect(saves).toHaveLength(2);expect(saves[0].body).toEqual(saves[1].body);
});
test('failed source read offers retry; a saved version can be selected without upload',async({page})=>{
  const calls=await setup(page,{files:1,readFailure:true,history:true});
  await page.getByRole('button',{name:'重试读取募集说明书'}).click();await page.locator('.prospectus-history summary').click();
  await page.getByRole('button',{name:'设为当前版本'}).click();await expect(page.getByRole('button',{name:'开始检查（免费）'})).toBeEnabled();
  expect(calls.some(c=>c.path.includes('/materials/uploads'))).toBe(false);
});
test('repaint retains a pending file; leaving the page disposes its uploader',async({page})=>{
  await setup(page);await choose(page);
  await page.evaluate(()=>(window as any).consistencyPage.paint());await expect(page.locator('.prospectus-selected-file')).toContainText(filename);
  await page.evaluate(()=>(window as any).consistencyPage.dispose());
  expect(await page.evaluate(()=>(window as any).consistencyPage.prospectus.controller.signal.aborted)).toBe(true);
});
test('capture matching empty-state prototype and implementation',async({page})=>{
  const out=process.env.BB_CONSISTENCY_EVIDENCE;test.skip(!out,'Optional visual evidence');await mkdir(out!,{recursive:true});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:960});await setup(page);await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeVisible();
    await page.locator('#content').screenshot({path:`${out}/implementation-${width}.png`});
    await page.goto(prototypeRoot+'prospectus-panel.html?purpose=consistency');await page.locator('#consistency-preview').screenshot({path:`${out}/prototype-${width}.png`});
  }
});
