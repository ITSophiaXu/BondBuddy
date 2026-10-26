import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {expect,test,type Page,type Route} from '@playwright/test';
import {PROJECT_FILE_UPDATE_PRICE,type ProjectFileAsset,type ProjectFileCheck,type ProjectFileFinding,
  type ProjectFileSource,type ProjectFileUpdateBatches,type ProjectFileVersion,type ProspectusVersions} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';

// One synthetic backend state serves the real application routes throughout this journey.
// These bytes and receipts verify UI ownership, version pins and delivery behavior only;
// they do not verify generated Word contents, a real points ledger or professional acceptance.
const projectId='journey-project',sourceId='journey-source',now='2026-10-25T06:00:00Z';
const base=`/projects/${projectId}/project-files`,checkId='journey-check',batchId='journey-batch';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const uploadedBytes=Buffer.from('Synthetic prospectus V2; no customer information.');
const deliveredBytes={revision:Buffer.from('Synthetic revision Word bytes; manual finding retained.'),
  clean:Buffer.from('Synthetic clean Word bytes; manual finding retained.')};
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const project:Dto<'ProjectResponse'>={project_id:projectId,name:'合成项目完整文件流程',kind:'generation',issuer_name:'合成发行人',
  market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now};
const prospectusVersion=(sequence:number):ProspectusVersions['versions'][number]=>({version_id:`source-v${sequence}`,sequence,
  origin:'upload',filename:`合成募集说明书_V${sequence}.docx`,sha256:sequence===2?hash(uploadedBytes):hash('source-v1'),
  created_at:now,material_id:`source-material-${sequence}`,material_version:1,artifact_id:null,artifact_version:null,
  revision_artifact_id:null,run_id:null});
const materialAsset=(id:string,owner=projectId,sha256=hash(id)):ProjectFileAsset=>({kind:'material',pin:{
  source_project_id:owner,material_id:id,material_version:1,sha256}});
const finding=(id:string,manual=false):ProjectFileFinding=>({id,target_span_id:'target-'+id,original:'合成原文数值 100',
  replacement:manual?null:'合成募集书数值 120',source_span_id:manual?null:'source-'+id,
  source_quote:manual?'':'募集书披露合成数值 120',source_location:'募集书第 12 页',target_location:'关联文件第 3 页',
  reason:manual?'授信口径缺少足够依据，仍需人工确认。':'关联文件数值与本轮募集书不同。',
  field:manual?'授信口径':'合成财务数据',period:'2025年度',unit:'万元',kind:manual?'manual':'conflict'});
const initialFile=(id:'issuer'|'financial',filename:string):ProjectFileVersion=>({version_id:id+'-v1',file_id:id+'-file',
  document_type:id,filename,sequence:1,asset:materialAsset(id+'-material'),revision_asset:null,source_version_id:'source-v1',
  template_id:null,template_version:null,source_name:prospectusVersion(1).filename,source_sequence:1,created_at:now,run_id:null,
  links:[],latest:true,version_count:1,consistency:{status:'unchecked',count:0,check_run_id:null}});
type Call={method:string;path:string;body:unknown};
type CheckBody=Dto<'ProjectFileCheckRequest'>;
type UpdateBody=Dto<'ProjectFileUpdateRequest'>;
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});

async function setupJourney(page:Page){
  const versions:ProspectusVersions={project_id:sourceId,current_version_id:'source-v1',selection_revision:2,
    inactive_material_ids:[],versions:[prospectusVersion(1)]};
  const files=[initialFile('issuer','发行人基本情况.docx'),initialFile('financial','财务情况.docx')];
  const checks:ProjectFileCheck[]=[],batches:ProjectFileUpdateBatches['batches']=[];
  const calls:Call[]=[],checkPosts:CheckBody[]=[],updatePosts:UpdateBody[]=[],unexpected:Call[]=[];
  let upload:Dto<'UploadCreateRequest'>|undefined,received=false,completed=false;
  const currentSource=():ProjectFileSource=>{
    const v=versions.versions.find(v=>v.version_id===versions.current_version_id)!;
    return {project_id:sourceId,version_id:v.version_id,selection_revision:versions.selection_revision,
      filename:v.filename,sequence:v.sequence,asset:materialAsset(v.material_id!,sourceId,v.sha256)};
  };
  const versionProjection=():ProspectusVersions=>({...structuredClone(versions),inactive_material_ids:versions.versions
    .filter(v=>v.version_id!==versions.current_version_id).map(v=>v.material_id!)});
  const collection=():Dto<'ProjectFilesResponse'>=>({project_id:projectId,items:[
    ...versions.versions.map(v=>({file_id:v.material_id!,file_key:'prospectus',project_id:sourceId,source:'material' as const,
      filename:v.filename,version:1,display_version:v.sequence,sha256:v.sha256,created_at:v.created_at,folder:'2' as const,run_id:null,
      current:v.version_id===versions.current_version_id,latest:v.version_id===versions.current_version_id,version_count:versions.versions.length})),
    ...files.map(v=>({file_id:v.asset.kind==='artifact'?v.asset.pin.artifact_id:v.asset.pin.material_id,
      file_key:'project-file:'+v.file_id,project_id:projectId,source:v.asset.kind,filename:v.filename,
      version:v.asset.kind==='artifact'?v.asset.pin.artifact_version:v.asset.pin.material_version,display_version:v.sequence,
      sha256:v.asset.pin.sha256,created_at:v.created_at,folder:'4.1' as const,run_id:v.run_id,current:false,latest:v.latest,version_count:v.version_count})),
  ]});
  const artifactAsset=(variant:'revision'|'clean'):ProjectFileAsset=>({kind:'artifact',pin:{source_project_id:projectId,
    artifact_id:'journey-'+variant,artifact_version:1,sha256:hash(deliveredBytes[variant])}});
  const finishCheck=()=>{
    const checked=checks[0];expect(checked.state).toBe('queued');
    checked.state='succeeded';checked.stage='completed';checked.sha256=hash('journey-check-result');
    checked.result={version:'project-file-check-v1',files:checked.files.map(f=>({file_version_id:f.file_version_id,status:'conflict',
      coverage:'合成检查范围',findings:f.file_version_id==='issuer-v1'?[finding('issuer-conflict'),finding('issuer-manual',true)]:
        [finding('financial-conflict')],links:[]}))};
    for(const f of files){f.consistency={status:'conflict',count:1,check_run_id:checkId};}
  };
  const finishPartialBatch=()=>{
    const checked=checks[0],batch=batches[0];expect(batch.state).toBe('queued');
    const old=files.find(f=>f.version_id==='issuer-v1')!;old.latest=false;old.version_count=2;
    const basis=checked.source;
    files.push({...structuredClone(old),version_id:'issuer-v2',sequence:2,asset:artifactAsset('clean'),revision_asset:artifactAsset('revision'),
      source_version_id:basis.version_id,source_name:basis.filename,source_sequence:basis.sequence,run_id:'journey-issuer-run',
      latest:true,version_count:2,consistency:{status:'manual',count:1,check_run_id:checkId}});
    checked.updates=[{file_version_id:'issuer-v1',issue_ids:['issuer-conflict'],run_id:'journey-issuer-run',state:'succeeded',new_version_id:'issuer-v2'},
      {file_version_id:'financial-v1',issue_ids:['financial-conflict'],run_id:'journey-financial-run',state:'failed',new_version_id:null}];
    batch.state='paused';batch.items=[{file_version_id:'issuer-v1',filename:old.filename,run_id:'journey-issuer-run',error:null},
      {file_version_id:'financial-v1',filename:'财务情况.docx',run_id:'journey-financial-run',error:'合成财务文件更新失败，等待处理'}];
  };
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method();
    const body=method==='POST'||method==='PATCH'?req.postDataJSON() as unknown:null;
    const call={method,path,body};calls.push(call);
    if(method==='GET'&&path==='/me')return json(route,200,{user_id:'synthetic-journey-owner',session_status:'active'});
    if(method==='GET'&&path==='/account')return json(route,200,{user_id:'synthetic-journey-owner',username:'sample_user'});
    if(method==='GET'&&path==='/credits/balance')return json(route,200,{enabled:true,available:18000,frozen:0});
    if(method==='GET'&&path==='/projects')return json(route,200,{items:[{...project,status:'draft',file_count:3,latest_run:null,latest_artifact:null}],page:{has_more:false,next_cursor:null}});
    if(method==='GET'&&path===`/projects/${projectId}`)return json(route,200,project);
    if(method==='GET'&&path===`/projects/${projectId}/tasks`)return json(route,200,{project_id:projectId,items:[],page:{has_more:false,next_cursor:null}});
    if(method==='GET'&&path===`/projects/${projectId}/files`)return json(route,200,collection());
    if(method==='GET'&&path===base)return json(route,200,{files});
    if(method==='GET'&&path===base+'/workspace')return json(route,200,{project_id:projectId,source:currentSource()});
    if(method==='GET'&&path===base+'/checks')return json(route,200,{checks});
    if(method==='GET'&&path===base+'/updates')return json(route,200,{batches});
    if(method==='GET'&&path===`/projects/${sourceId}/prospectus-versions`)return json(route,200,versionProjection());
    if(method==='POST'&&path===`/projects/${sourceId}/materials/uploads`){
      upload=body as Dto<'UploadCreateRequest'>;
      expect(upload).toEqual({filename:prospectusVersion(2).filename,media_type:mime,byte_size:uploadedBytes.length,
        sha256:hash(uploadedBytes),role:'historical'});
      return json(route,201,{upload_id:'journey-upload',state:'uploading',upload_url:`/api/v1/projects/${sourceId}/materials/uploads/journey-upload/bytes`,
        expires_at:'2099-01-01T00:00:00Z',max_bytes:100000});
    }
    if(method==='PUT'&&path===`/projects/${sourceId}/materials/uploads/journey-upload/bytes`){
      expect(upload).toBeDefined();expect(req.postDataBuffer()).toEqual(uploadedBytes);received=true;return route.fulfill({status:204});
    }
    if(method==='POST'&&path===`/projects/${sourceId}/materials/uploads/journey-upload/complete`){
      expect(received).toBe(true);expect(body).toEqual({sha256:upload!.sha256,byte_size:upload!.byte_size});
      if(!completed){versions.versions.unshift(prospectusVersion(2));completed=true;}
      const material:Dto<'MaterialResponse'>={material_id:'source-material-2',material_version:1,upload_id:'journey-upload',role:'historical',
        filename:upload!.filename,media_type:mime,byte_size:uploadedBytes.length,sha256:hash(uploadedBytes),state:'persisted',persisted_at:now,error:null};
      return json(route,200,material);
    }
    if(method==='POST'&&path===`/projects/${sourceId}/prospectus-versions/current`){
      const input=body as Dto<'ProspectusVersionSelectRequest'>;
      expect(input).toMatchObject({version_id:'source-v2',expected_selection_revision:2,request_id:expect.any(String)});
      expect(versions.versions.some(v=>v.version_id===input.version_id)).toBe(true);
      versions.current_version_id=input.version_id;versions.selection_revision++;
      for(const f of files)f.consistency={status:'stale',count:0,check_run_id:null};
      return json(route,200,versionProjection());
    }
    if(method==='POST'&&path===base+'/checks'){
      const input=body as CheckBody;checkPosts.push(structuredClone(input));
      expect(input).toEqual({request_id:expect.any(String),expected_source_version_id:'source-v2'});
      expect(checks).toHaveLength(0);
      checks.push({run_id:checkId,state:'queued',stage:'queued',created_at:now,source:structuredClone(currentSource()),stale:false,
        sha256:null,files:files.filter(f=>f.latest).map(f=>({file_id:f.file_id,file_version_id:f.version_id,filename:f.filename,sequence:f.sequence})),
        result:null,updates:[]});
      return json(route,200,{run_id:checkId});
    }
    if(method==='POST'&&path===base+`/checks/${checkId}/updates`){
      const input=body as UpdateBody;updatePosts.push(structuredClone(input));
      expect(input).toEqual({request_id:expect.any(String),expected_check_sha256:checks[0].sha256,
        price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:9000,
        files:[{file_version_id:'issuer-v1'},{file_version_id:'financial-v1'}]});
      expect(batches).toHaveLength(0);
      checks[0].updates=input.files.map(f=>({file_version_id:f.file_version_id,issue_ids:[f.file_version_id==='issuer-v1'?'issuer-conflict':'financial-conflict'],
        run_id:f.file_version_id==='issuer-v1'?'journey-issuer-run':'journey-financial-run',state:'queued',new_version_id:null}));
      batches.push({batch_id:batchId,state:'queued',items:input.files.map(f=>({file_version_id:f.file_version_id,
        filename:files.find(v=>v.version_id===f.file_version_id)!.filename,run_id:null,error:null}))});
      return json(route,200,{batch_id:batchId});
    }
    const artifact=path.match(/^\/artifacts\/journey-(revision|clean)(\/download)?$/);
    if(method==='GET'&&artifact){
      const variant=artifact[1] as 'revision'|'clean',id='journey-'+variant;
      if(artifact[2])return route.fulfill({status:200,contentType:mime,body:deliveredBytes[variant]});
      const response:Dto<'ArtifactResponse'>={artifact_id:id,run_id:'journey-issuer-run',version:1,filename:'发行人基本情况.docx',
        media_type:mime,sha256:hash(deliveredBytes[variant]),quality_status:'passed',delivery_status:'available',
        download_url:`/api/v1/artifacts/${id}/download?grant=synthetic`,expires_at:'2099-01-01T00:00:00Z'};
      return json(route,200,response);
    }
    if(method==='GET'&&path==='/runs/journey-issuer-run'){
      const response:Dto<'RunResponse'>={run_id:'journey-issuer-run',execution_request_id:'journey-issuer-request',project_id:projectId,
        input_revision:1,input_hash:hash('synthetic-run-input'),channel:'production',test_grant_id:null,uncovered_items:[],
        state:'succeeded',stage:'completed',event_cursor:1,billing_mode:'fixed_credits',reservation_id:null,
        artifact_id:'journey-revision',prompt_snapshot_ref:null,updated_at:now};
      return json(route,200,response);
    }
    unexpected.push(call);return json(route,404,{code:'NOT_FOUND'});
  });
  return {versions,files,checks,batches,calls,checkPosts,updatePosts,unexpected,finishCheck,finishPartialBatch};
}

test('project workbench saves then adopts a source and delivers a partially successful confirmed update',async({page})=>{
  test.setTimeout(60_000);
  const f=await setupJourney(page);
  await page.goto(`/#/projects/${projectId}/files`);
  await expect(page.getByRole('heading',{name:project.name,exact:true})).toBeVisible();
  await expect(page.locator('#pw-current-source')).toContainText('已采用 V1');
  await expect(page.locator('#file-list>.collection-file')).toHaveCount(3);
  expect(f.versions.versions.map(v=>v.version_id)).toEqual(['source-v1']);
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);

  await page.getByText('上传募集书新版本',{exact:true}).click();
  await page.locator('#prospectus-version-file').setInputFiles({name:prospectusVersion(2).filename,mimeType:mime,buffer:uploadedBytes});
  await page.locator('#save-prospectus-version').click();
  await expect(page.locator('#prospectus-status')).toContainText(/已保存.*尚未采用/);
  await expect(page.locator('#pw-current-source')).toContainText('已采用 V1');
  expect(f.versions.current_version_id).toBe('source-v1');expect(f.versions.selection_revision).toBe(2);
  expect(f.versions.versions.map(v=>v.version_id)).toEqual(['source-v2','source-v1']);
  expect(f.checkPosts).toHaveLength(0);expect(f.updatePosts).toHaveLength(0);
  expect(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);

  await page.locator('[data-use-version="source-v2"]').click();
  const adoption=page.locator('dialog[open]');
  await expect(adoption).toContainText(prospectusVersion(2).filename);
  await expect(adoption).toContainText('关联文件需要按新版重新核对');
  expect(f.versions.current_version_id).toBe('source-v1');
  await page.locator('#confirm-prospectus-selection').click();
  await expect(page.locator('#pw-current-source')).toContainText('已采用 V2');
  await expect(page.locator('#pw-check-note')).toContainText('请先免费检查');
  await expect(page.locator('#file-list')).toContainText('版本已变化 · 请重查');
  expect(f.versions.current_version_id).toBe('source-v2');expect(f.versions.selection_revision).toBe(3);
  expect(f.updatePosts).toHaveLength(0);

  await page.locator('#pw-check-link').click();
  await expect(page).toHaveURL(new RegExp(`#consistency\\?project=${projectId}&return_project=${projectId}$`));
  await expect(page.getByRole('heading',{name:'准备检查项目文件',exact:true})).toBeVisible();
  expect(f.checkPosts).toHaveLength(0);
  await page.locator('[data-fc-start]').click();
  await expect(page).toHaveURL(new RegExp(`project=${projectId}.*run=${checkId}`));
  await expect(page.getByRole('heading',{name:'等待检查',exact:true})).toBeVisible();
  expect(f.checkPosts).toHaveLength(1);
  expect(f.checks[0].source).toMatchObject({project_id:sourceId,version_id:'source-v2',selection_revision:3,sequence:2,
    asset:{kind:'material',pin:{source_project_id:sourceId,material_id:'source-material-2',sha256:hash(uploadedBytes)}}});
  expect(f.checks[0].files.map(v=>v.file_version_id)).toEqual(['issuer-v1','financial-v1']);
  f.finishCheck();
  await expect(page.locator('.fc-results')).toBeVisible({timeout:10_000});
  await expect(page.locator('.pf-source-strip')).toContainText('本轮固定使用');
  await expect(page.locator('.pf-source-strip')).toContainText(prospectusVersion(2).filename);

  await page.locator('[data-fc-select="issuer-v1"]').check();
  await page.locator('[data-fc-select="financial-v1"]').check();
  await expect(page.locator('#fc-selection')).toContainText('9,000');
  await page.locator('#fc-accept').click();
  const confirmation=page.locator('dialog.fc-confirm[open]');
  await expect(confirmation).toContainText('发行人基本情况.docx');await expect(confirmation).toContainText('财务情况.docx');
  await expect(confirmation).toContainText('9,000 积分');await expect(confirmation).toContainText('余额覆盖本批总额');
  expect(f.updatePosts).toHaveLength(0);expect(f.batches).toHaveLength(0);
  await page.locator('#fc-confirm-update').click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator('.fc-update')).toContainText('正在生成新版本');
  expect(f.updatePosts).toHaveLength(1);expect(f.batches).toHaveLength(1);
  f.finishPartialBatch();
  await expect(page.locator('.fc-update')).toContainText('文件更新需要处理',{timeout:10_000});
  await expect(page.locator('.fc-update')).toContainText('合成财务文件更新失败，等待处理');
  await expect(page.locator(`[data-fc-retry="${batchId}"]`)).toBeVisible();
  await expect(page.locator(`[data-fc-stop="${batchId}"]`)).toBeVisible();
  await expect(page.locator('[data-fc-control="resume"][data-run="journey-issuer-run"], [data-fc-control="resume"][data-run="journey-financial-run"]')).toHaveCount(0);
  const issuer=page.locator('article.fc-file').filter({has:page.locator('[data-fc-select="issuer-v1"]')});
  await expect(issuer.locator('.pf-chip')).toContainText('需人工确认');
  await expect(issuer.locator('[data-fc-select]')).toBeDisabled();
  await expect(issuer.locator('.fc-downloads')).toContainText('已保存 V2');
  await issuer.locator('details>summary').click();
  const manual=issuer.locator('.fc-finding').filter({hasText:'授信口径缺少足够依据，仍需人工确认。'});
  await expect(manual).toContainText('需人工确认');await expect(manual).toContainText('此项不会自动修改');
  await expect(page.locator('article.fc-file').filter({has:page.locator('[data-fc-select="financial-v1"]')}).locator('.fc-downloads')).toHaveCount(0);
  for(const [variant,label] of [['revision','下载修订版'],['clean','下载清洁版']] as const){
    const download=page.waitForEvent('download');await issuer.getByRole('button',{name:label,exact:true}).click();
    const receipt=await download;expect(await receipt.failure()).toBeNull();
    // The API supplies this authoritative filename for both synthetic artifacts.
    expect(receipt.suggestedFilename()).toBe('发行人基本情况.docx');
    const savedPath=await receipt.path();expect(savedPath).not.toBeNull();
    expect(await readFile(savedPath!)).toEqual(deliveredBytes[variant]);
    expect(f.calls.some(c=>c.path===`/artifacts/journey-${variant}/download`&&c.method==='GET')).toBe(true);
  }
  await expect(manual).toContainText('需人工确认');
  expect(f.checks[0].updates.map(u=>({version:u.file_version_id,state:u.state,newVersion:u.new_version_id}))).toEqual([
    {version:'issuer-v1',state:'succeeded',newVersion:'issuer-v2'},{version:'financial-v1',state:'failed',newVersion:null}]);

  await page.getByRole('link',{name:'返回项目文件',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`#/projects/${projectId}/files$`));
  await expect(page.getByRole('heading',{name:project.name,exact:true})).toBeVisible();
  await expect(page.locator('#pw-current-source')).toContainText('已采用 V2');
  const returnedIssuer=page.locator('#file-list>.collection-file').filter({hasText:'发行人基本情况.docx'});
  await expect(returnedIssuer).toHaveCount(1);await expect(returnedIssuer).toContainText('生成成果 · V2');
  await expect(returnedIssuer).toContainText('需人工确认');
  const returnedFinancial=page.locator('#file-list>.collection-file').filter({hasText:'财务情况.docx'});
  await expect(returnedFinancial).toContainText('已上传文件 · V1');
  for(const label of ['下载修订版','下载清洁版']){
    const download=page.waitForEvent('download');await returnedIssuer.getByRole('button',{name:label,exact:true}).click();
    expect(await (await download).failure()).toBeNull();
  }
  expect(f.calls.filter(c=>c.path==='/runs/journey-issuer-run'&&c.method==='GET')).toHaveLength(2);
  expect(f.versions.versions.map(v=>v.version_id)).toEqual(['source-v2','source-v1']);
  expect(f.files.filter(v=>v.file_id==='issuer-file').map(v=>({id:v.version_id,latest:v.latest}))).toEqual([
    {id:'issuer-v1',latest:false},{id:'issuer-v2',latest:true}]);
  expect(f.files.filter(v=>v.file_id==='financial-file').map(v=>v.version_id)).toEqual(['financial-v1']);
  expect(f.calls.filter(c=>c.method!=='GET').map(c=>`${c.method} ${c.path}`)).toEqual([
    `POST /projects/${sourceId}/materials/uploads`,`PUT /projects/${sourceId}/materials/uploads/journey-upload/bytes`,
    `POST /projects/${sourceId}/materials/uploads/journey-upload/complete`,`POST /projects/${sourceId}/prospectus-versions/current`,
    `POST ${base}/checks`,`POST ${base}/checks/${checkId}/updates`]);
  expect(f.unexpected).toEqual([]);expect(f.checkPosts).toHaveLength(1);expect(f.updatePosts).toHaveLength(1);
});
