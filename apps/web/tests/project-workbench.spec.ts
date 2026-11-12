import {createHash} from 'node:crypto';
import {expect,test,type Page,type Route} from '@playwright/test';
import type {ProjectFileVersion,ProspectusVersions} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import type {UploadRecoveryRecord} from '../src/upload-recovery';

// Synthetic HTTP fixtures exercise project navigation and version ownership only.
const root='workbench-root',source='workbench-source',now='2026-10-25T02:00:00Z';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const bytes=Buffer.from('synthetic project Word file'),sha=createHash('sha256').update(bytes).digest('hex');
const project:Dto<'ProjectResponse'>={project_id:root,name:'合成债券项目',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now};
const version=(id:string,sequence:number):ProspectusVersions['versions'][number]=>({version_id:id,sequence,origin:'upload',filename:`募集说明书_V${sequence}.docx`,sha256:sha,created_at:now,material_id:'source-material-'+sequence,material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null});
const registered:ProjectFileVersion={version_id:'issuer-v1',file_id:'issuer-file',document_type:'issuer',filename:'发行人基本情况.docx',sequence:1,asset:{kind:'material',pin:{source_project_id:root,material_id:'issuer-material',material_version:1,sha256:sha}},revision_asset:null,source_version_id:'source-v1',template_id:null,template_version:null,source_name:'募集说明书_V1.docx',source_sequence:1,created_at:now,run_id:null,links:[],latest:true,version_count:1,consistency:{status:'unchecked',count:0,check_run_id:null}};
const material=(id:string):Dto<'MaterialResponse'>=>({material_id:id,material_version:1,upload_id:'upload-id',role:'other',filename:'发行人基本情况.docx',media_type:mime,byte_size:bytes.length,sha256:sha,state:'persisted',persisted_at:now,error:null});
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});

async function setup(page:Page,options:{workspace?:boolean;taskFailure?:boolean;taskGate?:Promise<void>;retainedRootCurrent?:boolean}={}){
  const state={calls:[] as {method:string;path:string;body:unknown}[],selected:'source-v1',selectionRevision:2,taskFailure:options.taskFailure??false,filesFailure:false,registryFailure:false,importStatus:200,imports:[] as Record<string,unknown>[],uploadRequests:0,putRequests:0,completeRequests:0,uploaded:false,completed:false,completeFailures:0,dropPutOnce:false,declaration:undefined as Dto<'UploadCreateRequest'>|undefined,fileReplies:0,holdUpload:undefined as Promise<void>|undefined,holdFiles:undefined as Promise<void>|undefined};
  const importedMaterial=()=>({...material('imported-material'),...state.declaration});
  const versions=()=>({project_id:source,current_version_id:state.selected,selection_revision:state.selectionRevision,inactive_material_ids:[],versions:[version('source-v2',2),version('source-v1',1)]});
  const files=():Dto<'ProjectFilesResponse'>=>({project_id:root,items:[{file_id:state.selected==='source-v1'?'source-material-1':'source-material-2',file_key:'prospectus',project_id:source,source:'material',filename:state.selected==='source-v1'?'募集说明书_V1.docx':'募集说明书_V2.docx',version:1,display_version:state.selected==='source-v1'?1:2,sha256:sha,created_at:now,folder:'2',run_id:null,current:true,latest:true,version_count:2},{file_id:'issuer-material',file_key:'project-file:issuer-file',project_id:root,source:'material',filename:'发行人基本情况.docx',version:1,display_version:1,sha256:sha,created_at:now,folder:'4.1',run_id:null,current:false,latest:true,version_count:1}]});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method();
    const body=method==='POST'||method==='PATCH'?req.postDataJSON() as unknown:null;state.calls.push({method,path,body});
    if(path==='/me')return json(route,200,{user_id:'synthetic-owner',session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:'synthetic-owner',username:'sample_user'});
    if(path==='/credits/balance')return json(route,200,{enabled:true,available:86000,frozen:0});
    if(path==='/projects')return json(route,200,{items:[{...project,file_count:2,latest_run:null,latest_artifact:null,status:'draft'}],page:{has_more:false,next_cursor:null}});
    if(path===`/projects/${root}`)return json(route,200,project);
    if(path===`/projects/${root}/files`){await state.holdFiles;const result=files();if(options.retainedRootCurrent)result.items.push({...result.items[0],file_id:'retained-root-material',file_key:'retained-root',project_id:root,filename:'原项目保留旧稿.docx'});await json(route,state.filesFailure?503:200,state.filesFailure?{code:'DATA_UNAVAILABLE'}:result).catch(()=>{});state.fileReplies++;return;}
    if(path===`/projects/${root}/project-files`)return json(route,state.registryFailure?503:200,state.registryFailure?{code:'DATA_UNAVAILABLE'}:{files:[{...registered,consistency:{...registered.consistency,status:state.selected==='source-v1'?'unchecked':'stale'}}]});
    if(path===`/projects/${root}/tasks`){await options.taskGate;return json(route,state.taskFailure?503:200,state.taskFailure?{code:'DATA_UNAVAILABLE'}:{project_id:root,items:[],page:{has_more:false,next_cursor:null}});}
    if(path===`/projects/${root}/project-files/workspace`){
      if(!options.workspace)return json(route,404,{code:'NOT_FOUND'});
      const v=state.selected==='source-v1'?version('source-v1',1):version('source-v2',2);
      return json(route,200,{source:{project_id:source,version_id:v.version_id,selection_revision:state.selectionRevision,filename:v.filename,sequence:v.sequence,asset:{kind:'material',pin:{source_project_id:source,material_id:v.material_id,material_version:1,sha256:sha}}}});
    }
    if(path===`/projects/${source}/prospectus-versions`)return json(route,200,versions());
    if(path===`/projects/${source}/prospectus-versions/current`&&method==='POST'){
      const input=body as {version_id:string;expected_selection_revision:number};
      if(input.expected_selection_revision!==state.selectionRevision)return json(route,409,{code:'INPUT_REVISION_CONFLICT'});
      state.selected=input.version_id;state.selectionRevision++;return json(route,200,versions());
    }
    if(path===`/projects/${root}/materials/issuer-material`)return json(route,200,material('issuer-material'));
    if(path===`/projects/${root}/materials/imported-material`&&method==='GET')return state.completed&&new URL(req.url()).searchParams.get('version')==='1'?json(route,200,importedMaterial()):json(route,404,{code:'NOT_FOUND'});
    if(path===`/projects/${root}/materials/issuer-material/download`)return route.fulfill({status:200,contentType:mime,body:bytes});
    if(path===`/projects/${root}/materials/uploads`){state.uploadRequests++;state.declaration=body as Dto<'UploadCreateRequest'>;await state.holdUpload;return json(route,201,{upload_id:'upload-id',state:'uploading',upload_url:'/api/v1/synthetic-upload',expires_at:'2030-01-01T00:00:00Z',max_bytes:100000});}
    if(path==='/synthetic-upload'){state.putRequests++;state.uploaded=true;if(state.dropPutOnce){state.dropPutOnce=false;return route.abort('failed');}return route.fulfill({status:204});}
    if(path===`/projects/${root}/materials/uploads/upload-id/complete`){state.completeRequests++;if(!state.uploaded)return json(route,422,{code:'MATERIAL_UNREADABLE'});state.completed=true;if(state.completeFailures>0){state.completeFailures--;return route.abort('failed');}return json(route,200,importedMaterial());}
    if(path===`/projects/${root}/project-files/imports`){state.imports.push(body as Record<string,unknown>);return json(route,state.importStatus,state.importStatus===200?{}:{code:state.importStatus===409?'INPUT_REVISION_CONFLICT':'DATA_UNAVAILABLE'});}
    return json(route,404,{code:'NOT_FOUND'});
  });
  await page.goto(`/#/projects/${root}/files`);
  await expect(page.locator('#pw-current-source')).toContainText('募集说明书_V1.docx');
  await expect(page.locator('.prospectus-panel')).toBeVisible();
  return state;
}

test('workbench uses the real source without preparing a workspace; optional tasks do not block files',async({page})=>{
  const state=await setup(page,{taskFailure:true,retainedRootCurrent:true});
  await expect(page.getByRole('heading',{name:'合成债券项目',exact:true})).toBeVisible();
  await expect(page.locator('#pw-task-summary')).toContainText('最近任务暂未同步');
  expect(state.calls.some(c=>c.path===`/projects/${source}/prospectus-versions`)).toBe(true);
  expect(state.calls.some(c=>c.path===`/projects/${root}/prospectus-versions`)).toBe(false);
  expect(state.calls.filter(c=>c.method!=='GET')).toEqual([]);
  const business=page.getByRole('navigation',{name:'本项目业务'});
  for(const section of ['update','review','generate','integrity','qa'])await expect(business.locator(`a[href^="#${section}?"]`).first()).toHaveAttribute('href',new RegExp(`project=${root}&return_project=${root}`));
  await expect(page.locator('.pw-prepare')).not.toHaveAttribute('open');
  await expect(page.locator('.pw-prepare .collection-file').first()).toBeHidden();
  const issuer=page.locator('#file-list>.collection-file').filter({hasText:'发行人基本情况.docx'});
  await expect(issuer).toBeVisible();
  const download=page.waitForEvent('download');await issuer.getByRole('button',{name:'下载',exact:true}).click();
  expect(await (await download).failure()).toBeNull();
  state.taskFailure=false;await page.getByRole('button',{name:'刷新文件',exact:true}).click();
  await expect(page.locator('#pw-task-summary')).toBeEmpty();
  for(const width of [1440,1024,390,320]){await page.setViewportSize({width,height:960});if(width<=760)await expect(page.locator('#pw-folder-picker')).not.toHaveAttribute('open');else await expect(page.locator('#pw-folder-picker')).toHaveAttribute('open');await page.evaluate(()=>scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(width===1440||width===390)await page.screenshot({path:test.info().outputPath(`project-workbench-${width}.png`),fullPage:true});}
});

test('adoption refreshes source, files and registry and asks for a new check',async({page})=>{
  const state=await setup(page,{workspace:true});
  await page.getByText('版本历史（2）',{exact:true}).click();
  await page.locator('[data-use-version="source-v2"]').click();
  await expect(page.getByRole('dialog')).toContainText('关联文件需要按新版重新核对');
  expect(state.calls.filter(c=>c.method==='POST')).toHaveLength(0);
  await page.getByRole('button',{name:'确认采用',exact:true}).click();
  await expect(page.locator('#pw-current-source')).toContainText('已采用 V2');
  await expect(page.locator('#pw-check-note')).toHaveText('当前募集书或文件版本已变化。请先检查，再查看哪些文件需要更新。');
  await expect(page.locator('#file-list>.collection-file').first()).toContainText('募集说明书_V2.docx');
  await expect(page.locator('#file-list')).toContainText('版本已变化 · 请重查');
  expect(state.calls.filter(c=>c.path===`/projects/${root}/files`).length).toBeGreaterThan(1);
  expect(state.calls.filter(c=>c.path===`/projects/${root}/project-files`).length).toBeGreaterThan(1);
  expect(state.calls.filter(c=>c.path===`/projects/${root}/project-files/workspace`).length).toBeGreaterThan(1);
  expect(state.calls.filter(c=>c.method==='POST').map(c=>c.path)).toEqual([`/projects/${source}/prospectus-versions/current`]);
});

test('mobile files appear before the collapsed directory and folder selection closes it',async({page})=>{
  await page.setViewportSize({width:390,height:844});await setup(page);
  const picker=page.locator('#pw-folder-picker'),summary=picker.locator(':scope>summary');
  await expect(picker).not.toHaveAttribute('open');await expect(page.locator('#file-folders')).toBeHidden();
  await expect(page.locator('#file-list>.collection-file')).toHaveCount(2);
  const gap=await page.evaluate(()=>document.querySelector('#file-list>.collection-file')!.getBoundingClientRect().top-document.querySelector('.pw-files-head')!.getBoundingClientRect().bottom);
  expect(gap).toBeLessThan(330);
  await page.locator('.pw-files-head').evaluate(element=>element.scrollIntoView({block:'start'}));
  await expect(page.locator('#file-list>.collection-file').first()).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('project-workbench-mobile-files.png'),fullPage:true});
  const status=page.locator('#pw-file-status'),filters=status.locator('[data-file-status]');
  await expect(filters).toHaveCount(7);
  const targets=await filters.evaluateAll(buttons=>buttons.map(button=>{const box=button.getBoundingClientRect();return {top:box.top,height:box.height};}));
  expect(new Set(targets.map(box=>box.top)).size).toBe(1);expect(targets.every(box=>box.height>=44)).toBe(true);
  expect(await status.evaluate(host=>host.scrollWidth>host.clientWidth)).toBe(true);
  const other=status.locator('[data-file-status="other"]');
  await other.click();await expect(other).toHaveAttribute('aria-pressed','true');await expect(other).toBeFocused();
  expect(await other.evaluate(button=>{const frame=button.closest('#pw-file-status')!.getBoundingClientRect(),box=button.getBoundingClientRect();return box.left>=frame.left&&box.right<=frame.right;})).toBe(true);
  await expect(page.locator('#file-list>.collection-file')).toHaveCount(1);await expect(page.locator('#file-list>.collection-file')).toContainText('募集说明书_V1.docx');
  await status.locator('[data-file-status="all"]').click();await expect(page.locator('#file-list>.collection-file')).toHaveCount(2);
  await summary.click();await expect(page.locator('#file-folders')).toBeVisible();
  await page.locator('[data-folder="4.1"]').click();
  await expect(picker).not.toHaveAttribute('open');await expect(summary).toContainText('说明性文件');
  await expect(page.locator('#folder-title')).toBeFocused();
  await expect(page.locator('#file-list>.collection-file')).toHaveCount(1);
  await expect(page.locator('#file-list>.collection-file').first()).toContainText('发行人基本情况.docx');
  await expect(page.locator('#file-list>.collection-file').first()).toBeInViewport();
  await summary.click();await page.locator('[data-file-type="issuer"]').click();await expect(picker).not.toHaveAttribute('open');
  await expect(page.locator('#folder-title')).toHaveText('发行人基本情况说明');
  await page.setViewportSize({width:1440,height:960});await expect(picker).toHaveAttribute('open');await expect(summary).toBeHidden();await expect(page.locator('#file-folders')).toBeVisible();
  await page.setViewportSize({width:390,height:844});await expect(picker).not.toHaveAttribute('open');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a slow optional task summary does not hold the project workbench',async({page})=>{
  let release!:()=>void;const taskGate=new Promise<void>(resolve=>{release=resolve;});
  await setup(page,{taskGate});
  await expect(page.locator('#file-list>.collection-file')).toHaveCount(2);
  await expect(page.locator('#pw-task-summary')).toContainText('正在同步最近任务');
  release();await expect(page.locator('#pw-task-summary')).toBeEmpty();
});

test('failed refresh retains files; registry failure still permits owner checked downloads',async({page})=>{
  const state=await setup(page);state.filesFailure=true;
  await page.getByRole('button',{name:'刷新文件',exact:true}).click();
  await expect(page.locator('#file-action-status')).toContainText('当前显示上次同步结果');
  await expect(page.locator('#file-list>.collection-file')).toHaveCount(2);
  state.filesFailure=false;state.registryFailure=true;
  await page.getByRole('button',{name:'刷新文件',exact:true}).click();
  await expect(page.locator('#file-action-status')).toContainText('已有文件仍可下载');
  await expect(page.locator('#file-list>.collection-file')).toHaveCount(2);
  await expect(page.locator('.pw-prepare')).toHaveCount(0);
});

test('an uncertain import retries the same pin and compare-and-set without another upload',async({page})=>{
  const state=await setup(page);state.importStatus=503;
  await page.getByRole('button',{name:'上传关联文件',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.locator('[name=type]').selectOption('issuer');
  await dialog.locator('input[type=file]').setInputFiles({name:'新版发行人情况.docx',mimeType:mime,buffer:bytes});

  await expect(dialog.locator('[role=status]')).toContainText('尚未确认');
  expect(state.imports).toHaveLength(1);expect(state.uploadRequests).toBe(1);
  state.importStatus=409;await dialog.getByRole('button',{name:'重试保存项目文件'}).click();
  await expect(dialog.locator('[role=status]')).toContainText('其他页面修改');
  expect(state.imports).toHaveLength(2);expect(state.imports[1]).toEqual(state.imports[0]);
  expect(state.imports[1].expected_latest_version_id).toBe('issuer-v1');expect(state.uploadRequests).toBe(1);
  await expect(page.locator('#pw-import-recovery')).toBeEmpty();
  await expect(dialog.locator('[name=file]')).toBeEnabled();
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>{location.hash='tasks';});
  await expect(page).toHaveURL(/#tasks$/);
});

for(const status of [503,408,429])test(`uncertain import ${status} survives closing and resumes the same operation`,async({page})=>{
  const state=await setup(page);state.importStatus=status;
  await page.getByRole('button',{name:'上传关联文件',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.locator('[name=type]').selectOption('issuer');
  await dialog.locator('[name=file]').setInputFiles({name:'待确认关联文件.docx',mimeType:mime,buffer:bytes});

  await expect(dialog.locator('[role=status]')).toContainText('保存结果尚未确认');
  await expect(dialog.locator('[name=file]')).toBeDisabled();
  const envelope=structuredClone(state.imports[0]);
  if(status===408)await dialog.press('Escape');else await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button',{name:'继续确认关联文件',exact:true})).toBeVisible();
  await page.evaluate(()=>{location.hash='tasks';});
  await expect(page).toHaveURL(new RegExp(`#/projects/${root}/files$`));
  await expect(page.locator('#file-action-status')).toContainText('关联文件保存结果尚未确认');
  await page.getByRole('button',{name:'继续确认关联文件',exact:true}).click();dialog=page.getByRole('dialog');
  await expect(dialog.locator('[name=type]')).toHaveValue('issuer');
  expect(await dialog.locator('[name=file]').evaluate(input=>(input as HTMLInputElement).files?.[0]?.name)).toBe('待确认关联文件.docx');
  state.importStatus=200;await dialog.getByRole('button',{name:'重试保存项目文件',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  expect(state.imports).toHaveLength(2);expect(state.imports[1]).toEqual(envelope);expect(state.uploadRequests).toBe(1);
  await expect(page.locator('#pw-import-recovery')).toBeEmpty();
  await page.evaluate(()=>{location.hash='tasks';});await expect(page).toHaveURL(/#tasks$/);
});

async function importRecoveryRecord(page:Page){
  const records=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('bondbuddy:upload-recovery:v1:synthetic-owner:workbench-root:project-file-import:')).map(key=>JSON.parse(localStorage.getItem(key)!)));
  expect(records).toHaveLength(1);return records[0] as UploadRecoveryRecord;
}

for(const missingReceipt of ['complete','put'] as const)for(const recovery of ['automatic','manual'] as const)test('import reconciles a lost '+missingReceipt+' receipt with '+recovery+' recovery before sending bytes again',async({page})=>{
  await page.clock.install();
  const state=await setup(page);state.dropPutOnce=missingReceipt==='put';state.completeFailures=recovery==='manual'?4:missingReceipt==='complete'?1:0;
  let release!:()=>void;state.holdUpload=new Promise<void>(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'上传关联文件',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.locator('[name=type]').selectOption('issuer');
  const file={name:'上传回执丢失.docx',mimeType:mime,buffer:bytes};
  await dialog.locator('[name=file]').setInputFiles(file);
  await expect.poll(()=>state.uploadRequests).toBe(1);
  const original=await importRecoveryRecord(page);
  const context=original.context as {request_id:string;document_type:string;expected_latest_version_id:string};
  expect(context).toEqual({request_id:expect.any(String),document_type:'issuer',expected_latest_version_id:'issuer-v1'});expect(context.request_id).not.toBe('');
  expect(original.declaration).toEqual({filename:file.name,media_type:mime,byte_size:bytes.length,sha256:sha,role:'other'});
  expect(state.declaration).toEqual(original.declaration);expect(state.putRequests).toBe(0);
  release();

  // complete retries transport failures three times; an uncertain PUT probes those same stored bytes.
  const firstAttempts=recovery==='manual'?4:missingReceipt==='complete'?2:1;
  await expect.poll(async()=>{await page.clock.runFor(2000);return state.completeRequests;}).toBe(firstAttempts);
  if(recovery==='manual'){
    await expect(dialog.locator('[role=status]')).toContainText('保存结果尚未确认');
    await expect(dialog.locator('[name=file]')).toBeDisabled();await expect(dialog.locator('[name=type]')).toBeDisabled();
    expect(state.uploadRequests).toBe(1);expect(state.putRequests).toBe(1);expect(state.imports).toHaveLength(0);expect(state.completed).toBe(true);
    const pending=await importRecoveryRecord(page);
    expect(pending).toMatchObject({id:original.id,uploadId:'upload-id',declaration:original.declaration,context,stage:missingReceipt==='complete'?'confirming':'bytes_unknown'});
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'继续确认关联文件',exact:true}).click();dialog=page.getByRole('dialog');
    await expect(dialog.locator('[name=type]')).toHaveValue('issuer');
    expect(await dialog.locator('[name=file]').evaluate(input=>(input as HTMLInputElement).files?.[0]?.name)).toBe(file.name);
    await dialog.getByRole('button',{name:'重试保存项目文件',exact:true}).click();
  }
  await expect(dialog).not.toBeVisible();
  expect(state.uploadRequests).toBe(1);expect(state.putRequests).toBe(1);expect(state.completeRequests).toBe(firstAttempts+(recovery==='manual'?1:0));
  expect(state.completed).toBe(true);expect(state.imports).toEqual([{...context,material:{source_project_id:root,material_id:'imported-material',material_version:1,sha256:sha}}]);
  expect(state.calls.filter(c=>c.path.endsWith('/complete'))).toEqual(Array.from({length:state.completeRequests},()=>({method:'POST',path:'/projects/'+root+'/materials/uploads/upload-id/complete',body:{byte_size:bytes.length,sha256:sha}})));
  expect(state.calls.filter(c=>c.method!=='GET').map(c=>c.path)).toEqual(['/projects/'+root+'/materials/uploads','/synthetic-upload',...Array(state.completeRequests).fill('/projects/'+root+'/materials/uploads/upload-id/complete'),'/projects/'+root+'/project-files/imports']);
  await expect(page.locator('#pw-import-recovery')).toBeEmpty();
});

test('navigation and closing are guarded while a file upload is in progress',async({page})=>{
  const state=await setup(page);let release!:()=>void;state.holdUpload=new Promise<void>(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'上传关联文件',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.locator('[name=type]').selectOption('init');await dialog.locator('input[type=file]').setInputFiles({name:'已有文件.docx',mimeType:mime,buffer:bytes});
  await expect.poll(()=>state.uploadRequests).toBe(1);
  await page.evaluate(()=>{location.hash='tasks';});
  await expect(page).toHaveURL(new RegExp(`#/projects/${root}/files$`));
  await expect(dialog.locator('[role=status]')).toContainText('等待本次操作确认后再离开');
  await dialog.press('Escape');await expect(dialog).toBeVisible();
  release();await expect(dialog).not.toBeVisible();await page.evaluate(()=>{location.hash='tasks';});
  await expect(page).toHaveURL(/#tasks$/);
});

test('a file response arriving after navigation cannot repaint the previous project',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const state=await setup(page);let release!:()=>void;state.holdFiles=new Promise<void>(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'刷新文件',exact:true}).click();
  await expect.poll(()=>state.calls.filter(c=>c.path===`/projects/${root}/files`).length).toBe(2);
  await page.getByRole('link',{name:'← 返回任务进度与结果',exact:true}).click();
  await expect(page.getByRole('heading',{name:'任务进度与结果',exact:true})).toBeVisible();
  release();await expect.poll(()=>state.fileReplies).toBe(2);await expect(page.locator('.project-workbench')).toHaveCount(0);
  expect(errors).toEqual([]);
});
