import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,test,type Page,type Route} from '@playwright/test';
import {resultFilename,PROJECT_FILE_UPDATE_PRICE,type ProjectFileAsset,type ProjectFileCheck,type ProjectFileFinding,
  type ProjectFileSource,type ProjectFileVersion,type ProjectFileWorkspace,type ProjectFileUpdateBatches} from '@bondbuddy/contracts';
import {fixtureJson,fixtureRequest,serveDisabledBillingCatalog,type Dto} from './billing-fixture-wire';
import {installConsistencyFreshnessReference} from './consistency-freshness-reference';

// Disabled commerce/subscription catalogs explicitly select the historical free-check
// and 4,500-point update contract; no new free-check SKU is implied.
// Synthetic HTTP projections test the page's confirmation and recovery behavior.
// No model, wallet, private storage or real Word generation is involved.
const projectId='consistency-workbench-root',sourceProject='consistency-workbench-source';
const base=`/projects/${projectId}/project-files`,now='2026-10-25T04:00:00Z';
const checkId='check-current',olderCheckId='check-older';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const deliveredBytes={revision:Buffer.from('Synthetic tracked Word bytes with a retained manual comment.'),
  clean:Buffer.from('Synthetic clean Word bytes with a retained manual comment.')};
const project:Dto<'ProjectResponse'>={project_id:projectId,name:'合成关联文件核对项目',kind:'generation',issuer_name:'合成发行人',
  market:'sse',offering:'private',draft_revision:3,input_revision:null,input_hash:null,updated_at:now};
const materialAsset=(id:string,owner=projectId):ProjectFileAsset=>({kind:'material',pin:{source_project_id:owner,
  material_id:id,material_version:1,sha256:hash(id)}});
const source:ProjectFileSource={project_id:sourceProject,version_id:'prospectus-v2',selection_revision:5,
  filename:'本项目募集说明书_V2.docx',sequence:2,asset:materialAsset('prospectus-material-v2',sourceProject)};
const finding=(id:string,manual=false):ProjectFileFinding=>({id,target_span_id:'target-'+id,original:'原文合成数值 100',
  replacement:manual?null:'本轮建议合成数值 120',source_span_id:manual?null:'source-'+id,source_quote:manual?'':'募集书合成数值 120',
  source_location:'募集书第 12 页',target_location:'关联文件第 3 页',reason:manual?'仍需人工确认授信口径及补充依据。':'与本轮募集书披露数值不同。',
  field:manual?'授信口径':'合成财务数据',period:'2025年度',unit:'万元',kind:manual?'manual':'conflict'});
const file=(id:string,type:ProjectFileVersion['document_type'],filename:string):ProjectFileVersion=>({
  version_id:id+'-v1',file_id:id+'-file',document_type:type,filename,sequence:1,asset:materialAsset(id+'-material'),revision_asset:null,
  source_version_id:source.version_id,template_id:null,template_version:null,source_name:source.filename,source_sequence:source.sequence,
  created_at:now,run_id:null,links:[],latest:true,version_count:1,consistency:{status:id==='credit'?'manual':'conflict',count:id==='credit'?0:1,check_run_id:checkId},
});
const initialFiles=[file('issuer','issuer','发行人基本情况.docx'),file('financial','financial','财务情况.docx'),file('credit','credit','授信情况.docx')];
function check(id:string,files:ProjectFileVersion[],basis:ProjectFileSource):ProjectFileCheck{
  return {run_id:id,state:'succeeded',stage:'completed',created_at:now,source:structuredClone(basis),stale:false,sha256:hash('result-'+id),
    files:files.map(f=>({file_id:f.file_id,file_version_id:f.version_id,filename:f.filename,sequence:f.sequence})),updates:[],
    result:{version:'project-file-check-v1',files:files.map(f=>({file_version_id:f.version_id,status:f.document_type==='credit'?'manual':'conflict',
      coverage:'本轮合成检查范围',findings:f.document_type==='credit'?[finding(id+'-credit-manual',true)]:
        f.document_type==='issuer'?[finding(id+'-issuer-conflict'),finding(id+'-issuer-manual',true)]:[finding(id+'-financial-conflict')],links:[]}))}};
}
type UpdateBody=Dto<'ProjectFileUpdateRequest'>;
type CheckBody=Dto<'ProjectFileCheckRequest'>;
type UpdatePost={checkId:string;body:UpdateBody};
type Call={method:string;path:string;body:unknown;rawBody:string|null};
type FixtureOptions={
  shortageOnce?:boolean;dropUpdateOnce?:boolean;unpreparedWorkspace?:boolean;workspaceFailure?:boolean;
  changed?:'source-version'|'source-revision'|'file-version';missingRun?:boolean;delivered?:boolean;
  nullReplacement?:boolean;transientOnce?:408|429;dropCheckOnce?:boolean;
  freshness?:'replaced'|'scope-gap'|'combined'|'source-selection';historyCheck?:boolean;
  emptyState?:'source'|'files';latest?:boolean;
};
const json=(route:Route,status:number,value:unknown)=>route.fulfill({status,contentType:'application/json',body:fixtureJson(route,value)});

async function setup(page:Page,options:FixtureOptions={}){
  const files=structuredClone(initialFiles),basis=structuredClone(source);
  const checks=[check(checkId,files,basis),check(olderCheckId,files,basis)];
  const batches:ProjectFileUpdateBatches['batches']=[];
  const calls:Call[]=[],updates:UpdatePost[]=[],receipts=new Map<string,{post:UpdatePost;batchId:string}>();
  const checkPosts:CheckBody[]=[],checkReceipts=new Map<string,{body:CheckBody;runId:string}>();
  const flags={shortage:!!options.shortageOnce,drop:!!options.dropUpdateOnce,prepared:!options.unpreparedWorkspace,
    transient:options.transientOnce,dropCheck:!!options.dropCheckOnce};
  if(options.nullReplacement){
    const unresolved=checks[0].result!.files.find(f=>f.file_version_id==='credit-v1')!;
    unresolved.status='conflict';unresolved.findings=[{...finding(checkId+'-credit-null'),replacement:null,reason:'缺少足够依据，建议文字尚待人工确认。'}];
  }
  if(options.changed==='source-version'){
    basis.version_id='prospectus-v3';basis.selection_revision=6;basis.sequence=3;basis.filename='本项目募集说明书_V3.docx';
    basis.asset=materialAsset('prospectus-material-v3',sourceProject);
  }
  if(options.changed==='source-revision')basis.selection_revision+=2;
  if(options.changed==='file-version'){
    files[0].latest=false;
    files.push({...structuredClone(files[0]),version_id:'issuer-v2',sequence:2,latest:true,version_count:2,asset:materialAsset('issuer-new-material')});
  }
  if(options.delivered){
    files[0].latest=false;
    const asset=(variant:'revision'|'clean'):ProjectFileAsset=>({kind:'artifact',pin:{source_project_id:projectId,
      artifact_id:'delivered-'+variant,artifact_version:1,sha256:hash(deliveredBytes[variant])}});
    files.push({...structuredClone(files[0]),version_id:'issuer-delivered-v2',sequence:2,asset:asset('clean'),revision_asset:asset('revision'),
      latest:true,version_count:2,run_id:'delivered-run',consistency:{status:'manual',count:0,check_run_id:checkId}});
    checks[0].updates.push({file_version_id:'issuer-v1',issue_ids:[checkId+'-issuer-conflict'],run_id:'delivered-run',state:'succeeded',new_version_id:'issuer-delivered-v2'});
  }
  if(options.freshness==='replaced'||options.freshness==='combined'){
    // An old consistent result and old manual findings remain historical facts;
    // neither becomes a conclusion about these independently saved new files.
    for(const historical of checks){const item=historical.result!.files.find(f=>f.file_version_id==='issuer-v1')!;item.status='consistent';item.findings=[];}
    for(const id of ['issuer','credit']){const prior=files.find(f=>f.version_id===id+'-v1')!;prior.latest=false;
      files.push({...structuredClone(prior),version_id:id+'-manual-v2',sequence:2,latest:true,version_count:2,asset:materialAsset(id+'-manual-v2-material'),consistency:{status:'unchecked',count:0,check_run_id:null}});
    }
  }
  if(options.freshness==='scope-gap'||options.freshness==='combined'){
    files.find(f=>f.version_id==='financial-v1')!.latest=false;
    files.push({...file('proceeds','proceeds','新增募集资金用途.docx'),consistency:{status:'unchecked',count:0,check_run_id:null}});
  }
  if(options.freshness==='source-selection')basis.selection_revision+=3;
  if(options.emptyState)checks.length=0;
  if(options.emptyState==='files')files.length=0;
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.replace('/api/v1',''),method=req.method();
    const body=method==='POST'||method==='PATCH'?fixtureRequest(req) as unknown:null;
    calls.push({method,path,body,rawBody:req.postData()});
    if(await serveDisabledBillingCatalog(route))return;
    if(path==='/me')return json(route,200,{user_id:'synthetic-consistency-owner',session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:'synthetic-consistency-owner',username:'sample_user'});
    if(path==='/credits/balance')return json(route,200,{enabled:true,available:18000,frozen:0});
    if(path==='/projects')return json(route,200,{items:[{...project,status:'draft',latest_run:null,file_count:3}],page:{has_more:false,next_cursor:null}});
    if(path===`/projects/${projectId}`)return json(route,200,project);
    if(path===`/projects/${projectId}/tasks`)return json(route,200,{project_id:projectId,items:[],page:{has_more:false,next_cursor:null}});
    if(path===`/projects/${projectId}/files`)return json(route,200,{project_id:projectId,items:files.map(f=>({file_id:f.asset.kind==='material'?f.asset.pin.material_id:f.asset.pin.artifact_id,file_key:'project-file:'+f.file_id,project_id:f.asset.pin.source_project_id,source:f.asset.kind,filename:f.filename,version:f.asset.kind==='material'?f.asset.pin.material_version:f.asset.pin.artifact_version,display_version:f.sequence,sha256:f.asset.pin.sha256,created_at:f.created_at,folder:'4.1',run_id:f.run_id,current:false,latest:f.latest,version_count:f.version_count}))});
    if(path===`/projects/${projectId}/prospectus-versions`||path===`/projects/${sourceProject}/prospectus-versions`)return json(route,200,{project_id:options.emptyState==='source'?projectId:sourceProject,current_version_id:null,selection_revision:0,inactive_material_ids:[],versions:[]});
    if(path===base&&method==='GET')return json(route,200,{files});
    if(path===base+'/checks'&&method==='GET')return json(route,200,{checks});
    if(options.missingRun&&path===base+'/checks/missing-check'&&method==='GET')return json(route,404,{code:'NOT_FOUND',message:'Synthetic requested check is unavailable',retryable:false,correlation_id:'consistency-workbench-missing',field_errors:[]});
    if(path===base+'/checks'&&method==='POST'){
      const input=body as CheckBody;checkPosts.push(structuredClone(input));
      const old=checkReceipts.get(input.request_id);
      if(old){expect(input).toEqual(old.body);return json(route,200,{run_id:old.runId});}
      const runId='check-recovered',created=check(runId,files.filter(f=>f.latest),basis);
      created.state='queued';created.stage='queued';created.result=null;created.sha256=null;checks.unshift(created);
      checkReceipts.set(input.request_id,{body:structuredClone(input),runId});
      if(flags.dropCheck){flags.dropCheck=false;return route.abort('connectionreset');}
      return json(route,200,{run_id:runId});
    }
    if(path===base+'/updates'&&method==='GET')return json(route,200,{batches});
    if(path===base+'/workspace'){
      const projection:Pick<ProjectFileWorkspace,'project_id'|'source'>={project_id:projectId,source:options.emptyState==='source'?null:basis};
      if(method==='GET'){
        if(options.workspaceFailure)return json(route,503,{code:'DATA_UNAVAILABLE'});
        return flags.prepared?json(route,200,projection):json(route,404,{code:'NOT_FOUND'});
      }
      if(method==='POST'){
        expect(body).toEqual({request_id:expect.any(String)});flags.prepared=true;
        return json(route,200,projection);
      }
    }
    const update=path.match(new RegExp('^'+base+'/checks/([^/]+)/updates$'));
    if(update&&method==='POST'){
      const post={checkId:decodeURIComponent(update[1]),body:body as UpdateBody};updates.push(structuredClone(post));
      const old=receipts.get(post.body.request_id);
      if(old){expect(post).toEqual(old.post);return json(route,200,{batch_id:old.batchId});}
      expect(post.body.expected_points).toBe(post.body.files.length*PROJECT_FILE_UPDATE_PRICE.points);
      expect(post.body.price_version).toBe(PROJECT_FILE_UPDATE_PRICE.version);
      if(flags.shortage){flags.shortage=false;return json(route,402,{code:'CREDITS_INSUFFICIENT'});}
      if(flags.transient){const status=flags.transient;flags.transient=undefined;return json(route,status,{code:status===429?'RATE_LIMITED':'DATA_UNAVAILABLE'});}
      const batchId='synthetic-update-'+(receipts.size+1);receipts.set(post.body.request_id,{post:structuredClone(post),batchId});
      batches.push({batch_id:batchId,state:'queued',items:post.body.files.map(f=>({file_version_id:f.file_version_id,
        filename:files.find(v=>v.version_id===f.file_version_id)!.filename,run_id:null,error:null}))});
      if(flags.drop){flags.drop=false;return route.abort('connectionreset');}
      return json(route,200,{batch_id:batchId});
    }
    const artifact=path.match(/^\/artifacts\/delivered-(revision|clean)(\/download)?$/);
    if(artifact){
      const variant=artifact[1] as 'revision'|'clean',bytes=deliveredBytes[variant],id='delivered-'+variant;
      const filename=resultFilename({project:'发行人基本情况',kind:variant==='revision'?'修订版':'清洁版',version:3,createdAt:now,mediaType:mime});
      // Match the authenticated artifact endpoint's frozen filename projection.
      if(artifact[2])return route.fulfill({status:200,contentType:mime,headers:{'Content-Disposition':`attachment; filename="delivered-${variant}.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`},body:bytes});
      const value:Dto<'ArtifactResponse'>={artifact_id:id,run_id:'delivered-run',version:1,filename,display_version:3,
        media_type:mime,sha256:hash(bytes),quality_status:'passed',delivery_status:'available',
        download_url:`/api/v1/artifacts/${id}/download?grant=synthetic`,expires_at:'2099-01-01T00:00:00Z'};
      return json(route,200,value);
    }
    return json(route,404,{code:'NOT_FOUND'});
  });
  await page.goto(`/#consistency?project=${projectId}${options.emptyState||options.latest?'':'&run='+(options.missingRun?'missing-check':options.historyCheck?olderCheckId:checkId)}`);
  if(options.workspaceFailure)await expect(page.getByRole('alert')).toBeVisible();
  else if(options.missingRun)await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取'})).toBeVisible();
  else if(options.emptyState)await expect(page.locator('.fc-empty')).toBeVisible();
  else await expect(page.locator('.fc-results')).toBeVisible();
  return {basis,files,checks,calls,updates,batches,receipts,checkPosts,checkReceipts};
}
const row=(page:Page,versionId:string)=>page.locator(`article.fc-file:has([data-fc-select="${versionId}"])`);
async function selectTwo(page:Page){
  await page.locator('[data-fc-select="issuer-v1"]').check();
  await page.locator('[data-fc-select="financial-v1"]').check();
}

test('two actionable files require a 9,000 point confirmation and manual-only files cannot be selected',async({page})=>{
  const f=await setup(page);
  await expect(page.locator('[data-fc-select="credit-v1"]')).toBeDisabled();
  await expect(row(page,'credit-v1').locator('[data-fc-file]')).toHaveCount(0);
  await expect(row(page,'issuer-v1').locator('[data-fc-file]')).toContainText('4,500');
  await selectTwo(page);await expect(page.locator('#fc-selection')).toContainText('9,000');
  for(const width of [1440,390]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:test.info().outputPath(`consistency-results-${width}.png`),fullPage:false});}
  await page.setViewportSize({width:1440,height:960});
  await page.locator('#fc-accept').click();
  const dialog=page.locator('dialog.fc-confirm[open]');
  await expect(dialog).toBeVisible();await expect(dialog).toContainText('发行人基本情况.docx');await expect(dialog).toContainText('财务情况.docx');
  await expect(dialog).toContainText('4,500');await expect(dialog).toContainText('9,000');
  await expect(dialog).toContainText('余额覆盖本批总额');
  await page.screenshot({path:test.info().outputPath('consistency-confirm-1440.png'),fullPage:false});
  expect(f.updates).toHaveLength(0);expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  await dialog.locator('[data-close]').last().click();
  expect(f.updates).toHaveLength(0);
});

test('a 402 keeps findings and selected files and requires a fresh explicit confirmation after recharge',async({page})=>{
  const f=await setup(page,{shortageOnce:true});await selectTwo(page);await page.locator('#fc-accept').click();
  await page.locator('#fc-confirm-update').click();
  await expect(page.locator('dialog.fc-confirm[open]')).toHaveCount(0);
  await expect(page.locator('#fc-status')).toContainText('积分不足');
  await expect(page.getByRole('link',{name:'查看余额与支付状态',exact:true})).toHaveAttribute('href',new RegExp('project='+projectId));
  await expect(page.locator('[data-fc-select="issuer-v1"]')).toBeChecked();
  await expect(page.locator('[data-fc-select="financial-v1"]')).toBeChecked();
  await expect(page.locator('.fc-file')).toHaveCount(3);expect(f.updates).toHaveLength(1);expect(f.batches).toHaveLength(0);
  await page.reload();await expect(page.locator('.fc-results')).toBeVisible();
  await expect(page.locator('[data-fc-select="issuer-v1"]')).toBeChecked();
  await expect(page.locator('[data-fc-select="financial-v1"]')).toBeChecked();
  await expect(page.locator('#fc-selection')).toContainText('9,000');expect(f.updates).toHaveLength(1);
  await page.locator('#fc-accept').click();
  await expect(page.locator('dialog.fc-confirm[open]')).toBeVisible();expect(f.updates).toHaveLength(1);
  await page.locator('#fc-confirm-update').click();
  await expect.poll(()=>f.updates.length).toBe(2);await expect(page.locator('dialog.fc-confirm[open]')).toHaveCount(0);
  expect(f.updates[1].body.request_id).not.toBe(f.updates[0].body.request_id);
  expect(f.updates[1].body.files).toEqual(f.updates[0].body.files);expect(f.receipts.size).toBe(1);
});

for(const changed of ['source-version','source-revision','file-version'] as const)
  test(`changed ${changed} disables stale updates and explains which input needs another check`,async({page})=>{
    const f=await setup(page,{changed});
    await expect(page.locator('[data-fc-select="issuer-v1"]')).toBeDisabled();
    await expect(row(page,'issuer-v1').locator('[data-fc-file]')).toBeDisabled();
    await expect(row(page,'issuer-v1')).toContainText(changed==='file-version'?'这份文件在检查后已换版':changed==='source-revision'?'募集书采用记录已变化':'募集书已换稿');
    if(changed==='file-version')await expect(page.locator('[data-fc-select="financial-v1"]')).toBeEnabled();
    else await expect(page.locator('[data-fc-select="financial-v1"]')).toBeDisabled();
    await expect(page.locator('#fc-accept')).toBeDisabled();
    // Source and file checks must work even when the server's separate stale flag is false.
    expect(f.checks[0].stale).toBe(false);expect(f.updates).toHaveLength(0);
  });

test('an unknown update retries the same body and check even after another check and file selection are opened',async({page})=>{
  const f=await setup(page,{dropUpdateOnce:true});await selectTwo(page);await page.locator('#fc-accept').click();
  await page.locator('#fc-confirm-update').click();
  await expect(page.locator('#fc-confirm-update')).toBeEnabled();
  await expect(page.locator('#fc-confirm-status')).toContainText('尚未确认');expect(f.updates).toHaveLength(1);
  const first=structuredClone(f.updates[0]);
  await page.locator('dialog.fc-confirm[open] [data-close]').last().click();
  await expect(page.locator('#fc-pending-action')).toBeVisible();
  await page.locator('#fc-history').selectOption(olderCheckId);
  await expect(page).toHaveURL(new RegExp('run='+olderCheckId));
  await page.locator('[data-fc-select="financial-v1"]').check();
  await page.locator('#fc-pending-action').click();
  const dialog=page.locator('dialog.fc-confirm[open]');
  await expect(dialog).toContainText('9,000');await expect(dialog).toContainText('发行人基本情况.docx');
  await page.locator('#fc-confirm-update').click();
  await expect.poll(()=>f.updates.length).toBe(2);await expect(page.locator('dialog.fc-confirm[open]')).toHaveCount(0);
  expect(f.updates[1]).toEqual(first);expect(first.checkId).toBe(checkId);
  expect(first.body.expected_check_sha256).toBe(f.checks[0].sha256);
  expect(first.body.expected_check_sha256).not.toBe(f.checks[1].sha256);
  expect(f.receipts.size).toBe(1);expect(f.batches).toHaveLength(1);
});

test('an explicit missing run never silently displays the latest check',async({page})=>{
  const f=await setup(page,{missingRun:true});
  await expect(page.locator('.fc-results')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toBeVisible();
  await expect(page.locator('.fc-empty')).toContainText('没有自动切换到其他一轮。');
  expect(f.calls.filter(call=>call.method==='GET'&&call.path===base+'/checks/missing-check')).toHaveLength(1);
  expect(f.calls.every(call=>call.method==='GET')).toBe(true);
  await expect(page).toHaveURL(/run=missing-check/);expect(f.updates).toHaveLength(0);
  await page.locator('[data-fc-latest]').click();
  await expect(page.locator('.fc-results')).toBeVisible();await expect(page).not.toHaveURL(/run=missing-check/);
  expect(f.calls.every(call=>call.method==='GET')).toBe(true);expect(f.updates).toHaveLength(0);expect(f.checkPosts).toHaveLength(0);
});

test('an existing workspace is read with GET and page reopening never prepares it again',async({page})=>{
  const f=await setup(page);await page.reload();await expect(page.locator('.fc-results')).toBeVisible();
  const workspace=f.calls.filter(c=>c.path===base+'/workspace');
  expect(workspace.length).toBeGreaterThanOrEqual(2);expect(workspace.every(c=>c.method==='GET')).toBe(true);
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('a first workspace 404 permits one POST preparation and subsequent reads use GET',async({page})=>{
  const f=await setup(page,{unpreparedWorkspace:true,latest:true});
  expect(f.calls.filter(c=>c.path===base+'/workspace').map(c=>c.method)).toEqual(['GET','POST']);
  await page.reload();await expect(page.locator('.fc-results')).toBeVisible();
  expect(f.calls.filter(c=>c.path===base+'/workspace').map(c=>c.method)).toEqual(['GET','POST','GET']);
  expect(f.calls.filter(c=>c.method==='POST').map(c=>c.path)).toEqual([base+'/workspace']);expect(f.updates).toHaveLength(0);
});

test('an explicit check with a workspace 404 stays readable and never prepares the workspace',async({page})=>{
  const f=await setup(page,{unpreparedWorkspace:true});
  await expect(page).toHaveURL(new RegExp('run='+checkId));await expect(page.locator('.fc-results')).toBeVisible();
  expect(f.calls.filter(c=>c.path===base+'/workspace').map(c=>c.method)).toEqual(['GET']);
  await page.reload();await expect(page.locator('.fc-results')).toBeVisible();
  expect(f.calls.filter(c=>c.path===base+'/workspace').map(c=>c.method)).toEqual(['GET','GET']);
  expect(f.calls.every(c=>c.method==='GET')).toBe(true);expect(f.updates).toHaveLength(0);expect(f.checkPosts).toHaveLength(0);
});

test('a workspace read failure does not create a workspace as a fallback',async({page})=>{
  const f=await setup(page,{workspaceFailure:true});
  expect(f.calls.filter(c=>c.path===base+'/workspace').map(c=>c.method)).toEqual(['GET']);
  expect(f.calls.filter(c=>c.method==='POST')).toEqual([]);await expect(page.locator('.fc-results')).toHaveCount(0);
});

test('successful dual Word delivery stays downloadable while manual findings remain visible',async({page})=>{
  const f=await setup(page,{delivered:true}),delivered=row(page,'issuer-v1');
  await expect(delivered.getByRole('button',{name:'下载修订版',exact:true})).toBeVisible();
  await expect(delivered.getByRole('button',{name:'下载清洁版',exact:true})).toBeVisible();
  await expect(delivered.locator('[data-fc-select]')).toBeDisabled();
  await expect(delivered.locator('.pf-chip')).toContainText('需人工确认');
  await delivered.locator('details summary').click();
  await expect(delivered.locator('.fc-finding').filter({hasText:'仍需人工确认授信口径及补充依据。'})).toContainText('需人工确认');
  await expect(page.locator('.fc-summary')).toContainText('已生成修订版');
  for(const [variant,label] of [['revision','下载修订版'],['clean','下载清洁版']] as const){
    const download=page.waitForEvent('download');await delivered.getByRole('button',{name:label,exact:true}).click();
    const completed=await download;expect(await completed.failure()).toBeNull();
    await test.info().attach('download-protocol-'+variant,{body:JSON.stringify({url:completed.url(),suggestedFilename:completed.suggestedFilename()}),contentType:'application/json'});
    expect(await readFile((await completed.path())!)).toEqual(deliveredBytes[variant]);
    expect(completed.suggestedFilename()).toContain(variant==='revision'?'修订版':'清洁版');
    expect(f.calls.some(c=>c.method==='GET'&&c.path===`/artifacts/delivered-${variant}`)).toBe(true);
    expect(f.calls.some(c=>c.method==='GET'&&c.path===`/artifacts/delivered-${variant}/download`)).toBe(true);
  }
  await expect(row(page,'issuer-v1').locator('.pf-chip')).toContainText('需人工确认');
  expect(f.updates).toHaveLength(0);
});

test('a conflict without replacement remains manual and is never presented as updated or consistent',async({page})=>{
  const f=await setup(page,{nullReplacement:true}),unresolved=row(page,'credit-v1');
  await expect(unresolved.locator('[data-fc-select]')).toBeDisabled();
  await expect(unresolved.locator('[data-fc-file]')).toHaveCount(0);
  await expect(unresolved.locator('.pf-chip')).toHaveText('需人工确认');
  await unresolved.locator('details summary').click();
  const item=unresolved.locator('.fc-finding');
  await expect(item).toContainText('需人工确认');await expect(item).toContainText('此项不会自动修改');
  await expect(item).not.toContainText('已更新');await expect(unresolved.locator('.pf-chip')).not.toContainText('本轮未发现差异');
  await page.locator('#fc-filter').selectOption('manual');await expect(row(page,'credit-v1')).toBeVisible();
  expect(f.updates).toHaveLength(0);
});

test('filtering keeps all eligible selections in the total and identifies the hidden selected files',async({page})=>{
  const f=await setup(page);await selectTwo(page);
  await page.locator('#fc-filter').selectOption('manual');
  await expect(page.locator('.fc-file')).toHaveCount(2);
  await expect(page.locator('[data-fc-select="issuer-v1"]')).toBeChecked();
  await expect(page.locator('[data-fc-select="financial-v1"]')).toHaveCount(0);
  await expect(page.locator('#fc-selection')).toContainText('9,000');
  await expect(page.locator('#fc-selection')).toContainText(/1 份筛选外文件/);
  await expect(page.locator('#fc-accept')).toBeEnabled();await page.locator('#fc-accept').click();
  const dialog=page.locator('dialog.fc-confirm[open]');
  await expect(dialog).toContainText('9,000');await expect(dialog.locator('li')).toHaveCount(2);
  await expect(dialog).toContainText('发行人基本情况.docx');await expect(dialog).toContainText('财务情况.docx');
  await expect(dialog).not.toContainText('授信情况.docx');expect(f.updates).toHaveLength(0);
});

test('refresh restores an uncertain update without resubmitting and later retries its original envelope',async({page})=>{
  const f=await setup(page,{dropUpdateOnce:true});await selectTwo(page);await page.locator('#fc-accept').click();
  await page.locator('#fc-confirm-update').click();await expect(page.locator('#fc-confirm-update')).toBeEnabled();
  const first=structuredClone(f.updates[0]);expect(f.updates).toHaveLength(1);
  await page.locator('dialog.fc-confirm[open] [data-close]').last().click();
  await page.locator('#fc-history').selectOption(olderCheckId);
  page.once('dialog',dialog=>dialog.accept());await page.reload();
  await expect(page.locator('.fc-results')).toBeVisible();await expect(page.locator('#fc-pending-action')).toBeVisible();
  await expect(page.locator('#fc-status')).toContainText('恢复');expect(f.updates).toHaveLength(1);
  await page.locator('#fc-pending-action').click();
  await expect(page.locator('dialog.fc-confirm[open]')).toContainText('9,000');
  await page.locator('#fc-confirm-update').click();
  await expect.poll(()=>f.updates.length).toBe(2);await expect(page.locator('dialog.fc-confirm[open]')).toHaveCount(0);
  expect(f.updates[1]).toEqual(first);expect(f.receipts.size).toBe(1);expect(f.batches).toHaveLength(1);
});

for(const status of [408,429] as const)
  test(`a ${status} update response retains the original confirmation envelope for an explicit retry`,async({page})=>{
    const f=await setup(page,{transientOnce:status});await selectTwo(page);await page.locator('#fc-accept').click();
    await page.locator('#fc-confirm-update').click();await expect(page.locator('#fc-confirm-update')).toBeEnabled();
    await expect(page.locator('#fc-confirm-status')).toContainText('尚未确认');
    expect(f.updates).toHaveLength(1);expect(f.receipts.size).toBe(0);
    const first=structuredClone(f.updates[0]);
    await page.locator('dialog.fc-confirm[open] [data-close]').last().click();await page.locator('#fc-pending-action').click();
    await page.locator('#fc-confirm-update').click();
    await expect.poll(()=>f.updates.length).toBe(2);expect(f.updates[1]).toEqual(first);expect(f.receipts.size).toBe(1);
  });

test('refresh restores an uncertain free check and retries its saved body without creating a second run',async({page})=>{
  const f=await setup(page,{dropCheckOnce:true});
  await expect(page.locator('[data-fc-start]')).toHaveText('重新检查（免费）');
  await page.locator('[data-fc-start]').click();
  await expect(page.locator('[data-fc-start]')).toHaveText('重试确认原检查');
  expect(f.checkPosts).toHaveLength(1);expect(f.checkReceipts.size).toBe(1);
  const first=structuredClone(f.checkPosts[0]);
  // The shared retry label covers all price modes. Prove this legacy request is
  // still free through its exact envelope and the absence of quote/payment calls.
  expect(first).toEqual({request_id:expect.any(String),expected_source_version_id:f.basis.version_id});
  const firstWire=f.calls.find(c=>c.method==='POST'&&c.path===base+'/checks')!.rawBody;
  page.once('dialog',dialog=>dialog.accept());await page.reload();
  await expect(page.locator('[data-fc-start]')).toHaveText('重试确认原检查');
  expect(f.checkPosts).toHaveLength(1);
  await page.locator('[data-fc-start]').click();
  await expect.poll(()=>f.checkPosts.length).toBe(2);await expect(page).toHaveURL(/run=check-recovered/);
  expect(f.checkPosts[1]).toEqual(first);expect(f.checkReceipts.size).toBe(1);expect(f.updates).toHaveLength(0);
  const writes=f.calls.filter(c=>c.method!=='GET');
  expect(writes.map(c=>c.path)).toEqual([base+'/checks',base+'/checks']);
  expect(writes.map(c=>c.rawBody)).toEqual([firstWire,firstWire]);
});

const freshnessReference=process.env.BB_CONSISTENCY_FRESHNESS_REFERENCE==='1';
const freshnessBanner=(page:Page)=>page.getByRole('region',{name:'当前文件与本轮检查范围',exact:true});
const freshnessRow=(page:Page,version:string)=>page.locator(`[data-fc-result-version="${version}"]`);
async function captureFreshness(page:Page,name:string,extra:Record<string,unknown>={}){
  const directory=process.env.BB_CONSISTENCY_FRESHNESS_EVIDENCE_DIR;if(!directory)return;
  await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name+'.png')});
  const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText,
    active:document.activeElement?.getAttribute('id')??document.activeElement?.tagName}));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width+1);
  const sources=[];for(const file of ['file-consistency.ts','file-workspace.css','project-files.ts']){const path='apps/web/src/'+file;sources.push({path,sha256:hash(await readFile(resolve('../..',path)))});}
  await writeFile(join(directory,name+'.json'),JSON.stringify({scenario:name,scope:freshnessReference?'Exact previous components with current shell/helpers':'Current consistency and ProjectFiles with synthetic owner-scoped HTTP',metrics,current_sources:sources,...extra},null,2));
}

test.describe('consistency freshness finite contracts',()=>{
  test.skip(freshnessReference,'New freshness behavior is absent from the sealed old component.');

  test('old consistent and manual V1 findings remain scoped to V1 after manual V2 saves with the same source',async({page})=>{
    const f=await setup(page,{freshness:'replaced'}),banner=freshnessBanner(page);
    await expect(banner).toBeVisible();await expect(banner).toContainText('当前范围需要重新核对');
    const consistent=freshnessRow(page,'issuer-v1'),manual=freshnessRow(page,'credit-v1');
    for(const article of [consistent,manual]){const hint=article.locator('.fc-file-freshness[data-fc-current-state="changed"]');
      await expect(hint).toContainText('V1');await expect(hint).toContainText('V2');await expect(hint).toContainText(/不能.*当前.*检查结论/);
      await expect(article.locator('[data-fc-select]')).toBeDisabled();
    }
    await expect(consistent.locator('.pf-chip')).toContainText('本轮未发现差异');
    await manual.locator('details summary').click();await expect(manual.locator('.fc-finding')).toContainText('仍需人工确认授信口径及补充依据。');
    await expect(manual.locator('.fc-finding')).toContainText('此项不会自动修改');
    await expect(manual.locator('.pf-chip')).toContainText('需人工确认');expect(f.checks[0].stale).toBe(false);
    expect(f.basis.version_id).toBe(f.checks[0].source.version_id);expect(f.basis.selection_revision).toBe(f.checks[0].source.selection_revision);
    expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);expect(f.updates).toEqual([]);
  });

  test('added and unreadable families are explicit and only a new click checks all currently readable latest files',async({page})=>{
    const f=await setup(page,{freshness:'scope-gap'}),banner=freshnessBanner(page);
    await expect(banner).toBeVisible();const details=banner.locator('details');if(await details.count())await details.locator('summary').click();
    await expect(banner.locator('[data-fc-current-state="added"]')).toContainText('新增募集资金用途.docx');
    await expect(banner.locator('[data-fc-current-state="added"]')).toContainText('本轮未覆盖');
    await expect(banner.locator('[data-fc-current-state="missing"]')).toContainText('财务情况.docx');
    await expect(freshnessRow(page,'financial-v1').locator('.fc-file-freshness[data-fc-current-state="missing"]')).toContainText(/无法读取|不可读/);
    await expect(page.locator('[data-fc-select="financial-v1"]')).toBeDisabled();
    await expect(page.locator('[data-fc-select="issuer-v1"]')).toBeEnabled();
    expect(f.checkPosts).toEqual([]);expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
    const recheck=page.getByRole('button',{name:'按当前全部文件重新检查（免费）',exact:true});await recheck.focus();await page.keyboard.press('Enter');
    await expect.poll(()=>f.checkPosts.length).toBe(1);await expect(page).toHaveURL(/run=check-recovered/);
    expect(f.checkPosts[0]).toEqual({request_id:expect.any(String),expected_source_version_id:f.basis.version_id});
    expect(f.checks[0].files.map(v=>v.file_version_id).sort()).toEqual(f.files.filter(v=>v.latest).map(v=>v.version_id).sort());
    expect(f.checks[0].files.some(v=>v.file_id==='proceeds-file')).toBe(true);expect(f.checks[0].files.some(v=>v.file_id==='financial-file')).toBe(false);
    expect(f.updates).toEqual([]);expect(f.calls.filter(c=>c.method!=='GET').map(c=>c.path)).toEqual([base+'/checks']);
  });

  test('same source ID with a new selection revision invalidates the basis while the exact historical deep link stays selected',async({page})=>{
    const f=await setup(page,{freshness:'source-selection',historyCheck:true});
    await expect(page).toHaveURL(new RegExp('run='+olderCheckId));await expect(page.locator('#fc-history')).toHaveValue(olderCheckId);
    await expect(freshnessBanner(page)).toContainText(/募集书.*变化|依据.*变化/);
    expect(f.basis.version_id).toBe(f.checks[1].source.version_id);expect(f.basis.selection_revision).not.toBe(f.checks[1].source.selection_revision);expect(f.checks[1].stale).toBe(false);
    for(const control of await page.locator('[data-fc-select]').all())await expect(control).toBeDisabled();
    await page.goto(`/#consistency?project=${projectId}&run=${olderCheckId}&file=credit-file`);
    await expect(freshnessRow(page,'credit-v1').locator('details')).toHaveAttribute('open');
    await expect(freshnessRow(page,'credit-v1')).toContainText('仍需人工确认授信口径及补充依据。');
    await expect(page.locator('#fc-history')).toHaveValue(olderCheckId);expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  });

  test('this check delivered V2 retains both downloads and original findings but other-file failed or other-check receipts cannot claim delivery',async({page})=>{
    const f=await setup(page,{delivered:true}),article=freshnessRow(page,'issuer-v1');
    await expect(article.locator('.fc-file-freshness[data-fc-current-state="delivered"]')).toContainText('V1');
    await expect(article.locator('.fc-file-freshness[data-fc-current-state="delivered"]')).toContainText('V2');
    await article.locator('details summary').click();await expect(article).toContainText('仍需人工确认授信口径及补充依据。');
    for(const variant of ['revision','clean'] as const){const label=variant==='revision'?'下载修订版':'下载清洁版',pending=page.waitForEvent('download');await article.getByRole('button',{name:label,exact:true}).click();
      const download=await pending;expect(await download.failure()).toBeNull();expect(await readFile((await download.path())!)).toEqual(deliveredBytes[variant]);
    }
    const original=structuredClone(f.checks[0].updates[0]);
    for(const fault of ['other-file','failed','other-check'] as const){
      f.checks[0].updates=[structuredClone(original)];f.checks[1].updates=[];
      if(fault==='other-file')f.checks[0].updates[0].file_version_id='financial-v1';
      if(fault==='failed')f.checks[0].updates[0].state='failed';
      if(fault==='other-check'){f.checks[1].updates=[structuredClone(original)];f.checks[0].updates=[];}
      await page.reload();await expect(freshnessRow(page,'issuer-v1').locator('.fc-file-freshness[data-fc-current-state="changed"]')).toBeVisible();
      await expect(freshnessRow(page,'issuer-v1').locator('.fc-file-freshness[data-fc-current-state="delivered"]')).toHaveCount(0);
    }
    expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);expect(f.updates).toEqual([]);
  });

  test('missing source and missing files each give the relevant existing workbench entry without preparing or submitting work',async({context})=>{
    for(const emptyState of ['source','files'] as const){const page=await context.newPage(),f=await setup(page,{emptyState});
      const name=emptyState==='source'?'添加并采用募集书':'上传已有项目文件',link=page.getByRole('link',{name,exact:true});
      await expect(link).toHaveAttribute('href',`#/projects/${projectId}/files`);await expect(page.locator('[data-fc-start]:enabled')).toHaveCount(0);
      if(emptyState==='source')await expect(page.locator('[data-fc-start]')).toBeDisabled();
      await link.focus();await page.keyboard.press('Enter');await expect(page.locator('#file-list')).toBeVisible();
      await expect(page).toHaveURL(new RegExp('/projects/'+projectId+'/files'));expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);await page.close();
    }
  });
});

for(const width of [1440,390])test(`consistency freshness component comparison: scope and original manual findings remain keyboard readable at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});const verifyReference=freshnessReference?await installConsistencyFreshnessReference(page):undefined;
  const f=await setup(page,{freshness:'combined'}),prefix=freshnessReference?'reference':'implementation';
  if(freshnessReference){await expect(freshnessBanner(page)).toHaveCount(0);await page.locator('.fc-summary').scrollIntoViewIfNeeded();}
  else {const banner=freshnessBanner(page);await expect(banner).toBeVisible();await banner.scrollIntoViewIfNeeded();
    const summary=banner.locator('details summary');if(await summary.count()){await summary.focus();await page.keyboard.press('Enter');await expect(banner.locator('[data-fc-current-state="added"]')).toBeVisible();}
  }
  await captureFreshness(page,`${prefix}-scope-${width}`,{comparison:'The old component shows historical statuses without the new current-file coverage banner.'});
  const manual=row(page,'credit-v1'),summary=manual.locator('details summary');await summary.focus();await page.keyboard.press('Enter');
  await expect(manual.locator('details')).toHaveAttribute('open');await expect(manual).toContainText('仍需人工确认授信口径及补充依据。');
  if(!freshnessReference)await expect(manual.locator('.fc-file-freshness[data-fc-current-state="changed"]')).toContainText('V2');
  await manual.scrollIntoViewIfNeeded();await captureFreshness(page,`${prefix}-manual-${width}`);
  const filter=page.getByRole('combobox',{name:'筛选文件状态',exact:true});await filter.focus();await page.keyboard.press('End');
  // The original findings can be filtered without any business submission.
  await expect(filter.locator('option').last()).toHaveAttribute('value',freshnessReference?'updated':'selected');
  await expect(filter).toHaveValue(freshnessReference?'updated':'selected');
  if(!freshnessReference)await expect(page.locator('[data-fc-result-version]')).toHaveCount(0);
  expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  if(verifyReference){const provenance=await verifyReference(),directory=process.env.BB_CONSISTENCY_FRESHNESS_EVIDENCE_DIR;if(directory)await writeFile(join(directory,`${prefix}-provenance-${width}.json`),JSON.stringify(provenance,null,2));}
});
