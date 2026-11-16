import { expect, test, type Page } from '@playwright/test';
import { emptyUpdateDetails, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { FormatRegistry } from '@sinclair/typebox';
import { isDateTime } from '../src/schema-formats';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import type { Dto } from '../src/api';
import { taskPage } from './collection-fixtures';

test.beforeEach(() => { FormatRegistry.Set('date-time',isDateTime); });

// Synthetic HTTP boundary; no model, database, OCR or document acceptance.
const now='2026-09-28T03:00:00Z', id='synthetic-quarter-project';
const emptyMessages = { version: 1, content_sha256: createHash('sha256').update('bondbuddy:empty-project-messages').digest('hex'), message_ids: [] };
const periods: NonNullable<Dto<'ProjectResponse'>['update_details']>['target_reporting_periods'] = [
  {start:'2024-01-01',end:'2024-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]},
  {start:null,end:'2025-06-30',period_kind:'interim',scope:null,status:'needs_confirmation',evidence_refs:[]}
];
function fixture() {
  return {
    project: {project_id:id,name:'合成设计验收 · 募集书更新',issuer_name:'合成发行人有限公司',kind:'update',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now,
      update_details:{...emptyUpdateDetails(),reporting_cutoff:'2024-12-31',has_historical:true,target_reporting_periods:structuredClone(periods)}} as Dto<'ProjectResponse'>,
    materials: [] as Dto<'MaterialResponse'>[], snapshot: undefined as Dto<'InputRevisionResponse'> | undefined, run: undefined as Dto<'RunResponse'> | undefined,
    calls: [] as {path:string;method:string;body?:any}[], uploads:new Map<string,Dto<'UploadCreateRequest'>>(), uploadBytes:[] as string[], uploadCompletions:[] as string[], currentVersionId:null as string|null, selectionRevision:0, holdSave:false, releaseSave:undefined as (()=>void)|undefined, materialReadFails:false, preflightOff:false
  };
}
async function install(page:Page,state=fixture()) {
  const versions=():Dto<'ProspectusVersionsResponse'>=>({project_id:id,current_version_id:state.currentVersionId,selection_revision:state.selectionRevision,inactive_material_ids:[],versions:state.materials.filter(material=>['historical','reference'].includes(material.role)).map((material,index)=>({version_id:'version-'+material.material_id,sequence:index+1,origin:'upload',filename:material.filename,sha256:material.sha256,created_at:material.persisted_at!,material_id:material.material_id,material_version:material.material_version,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}))});
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method();
    const body=method==='POST'||method==='PATCH'?request.postDataJSON():undefined;
    state.calls.push({path,method,body});
    let result:unknown={},status=200;
    if(path==='/me')result={user_id:'synthetic-owner',session_status:'active'};
    else if(path==='/projects') {
      if(method==='POST'){expect(Value.Check(schemas.ProjectCreateRequest,body)).toBe(true);const {creation_request_id,...projectFields}=body;state.project={...state.project,...projectFields};expect(Value.Check(schemas.ProjectResponse,state.project)).toBe(true);status=201;result=state.project;}
      else result={items:[{...state.project,latest_run:state.run?{run_id:state.run.run_id,state:state.run.state,updated_at:now}:null}],page:{next_cursor:null,has_more:false}};
    } else if(path===`/projects/${id}`) {
      if(method==='PATCH'){expect(Value.Check(schemas.ProjectPatchRequest,body)).toBe(true);state.project={...state.project,...body,draft_revision:state.project.draft_revision+1};}
      result=state.project;
    } else if(path===`/projects/${id}/tasks` && method==='GET') {
      result=taskPage(id,state.run?[state.run]:[]);
    } else if(path===`/projects/${id}/prospectus-versions` && method==='GET') {
      result=versions();expect(Value.Check(schemas.ProspectusVersionsResponse,result)).toBe(true);
    } else if(path===`/projects/${id}/events`) {
      if(state.materialReadFails){status=503;result={code:'DATA_UNAVAILABLE'};}
      else result={items:state.materials.map((m,i)=>({event_id:`event-${i}`,schema_version:1,trace_id:'trace',project_id:id,seq:i+1,occurred_at:now,type:'material.upload_progress',payload:{material_id:m.material_id}})),next_cursor:null};
    } else if(path===`/projects/${id}/messages` && method==='GET') {
      result={conversation_id:id,items:[],project_message_set_ref:emptyMessages,next_cursor:null,has_more:false};
    } else if(path===`/projects/${id}/materials/uploads`) {
      expect(Value.Check(schemas.UploadCreateRequest,body)).toBe(true);
      const uploadId='upload-'+(state.uploads.size+1);state.uploads.set(uploadId,body);
      const expiresAt=new Date((await page.evaluate(()=>Date.now()))+60_000).toISOString();
      result={upload_id:uploadId,state:'uploading',upload_url:`/api/v1/projects/${id}/materials/uploads/${uploadId}/bytes`,expires_at:expiresAt,max_bytes:100*1024*1024};status=201;
    } else if(path.endsWith('/bytes')){state.uploadBytes.push(path.split('/').at(-2)!);await route.fulfill({status:204});return;}
    else if(path.endsWith('/complete')) {
      const uploadId=path.split('/').at(-2)!,upload=state.uploads.get(uploadId)!;state.uploadCompletions.push(uploadId);
      expect(body).toEqual({byte_size:upload.byte_size,sha256:upload.sha256});
      if(state.holdSave)await new Promise<void>(resolve=>{state.releaseSave=resolve;});
      let material=state.materials.find(value=>value.upload_id===uploadId);
      if(!material){
        material={material_id:uploadId.replace('upload-','material-'),material_version:1,upload_id:uploadId,role:upload.role,filename:upload.filename,media_type:upload.media_type,byte_size:upload.byte_size,sha256:upload.sha256,state:'persisted',persisted_at:now,error:null};
        state.materials.push(material);
        // Update uploads are adopted by the server on complete, as in the current API.
        if(material.role==='historical'){state.currentVersionId='version-'+material.material_id;state.selectionRevision++;}
      }
      result=material;
    } else if(state.materials.some(material=>path===`/projects/${id}/materials/${material.material_id}`))result=state.materials.find(material=>path.endsWith('/'+material.material_id));
    else if(path===`/projects/${id}/input-revisions`) {
      expect(Value.Check(schemas.InputRevisionCreateRequest,body)).toBe(true);
      const revision=(state.project.input_revision??0)+1,hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
      state.snapshot={project_id:id,input_revision:revision,input_hash:hash,material_versions:body.material_versions,target_confirmation:{status:'unconfirmed',market:null,offering:null,document_purpose:null,as_of:null,target_reporting_periods:[],confirmed_by:null,confirmed_at:null},rule_pack_version:null,template_version:null,reference_release:null,created_at:now};
      state.project.input_revision=revision;state.project.input_hash=hash;result=state.snapshot;status=201;
    } else if(path.includes('/input-revisions/'))result=state.snapshot;
    else if(path.endsWith('/preflight')){status=state.preflightOff?501:200;result=state.preflightOff?{code:'CAPABILITY_NOT_READY'}:{project_id:id,...body,status:'ready',missing_inputs:[],uncertainty:[],billing_mode:'platform_trial'};}
    else if(path==='/runs/execute') {
      state.run={run_id:'run-1',execution_request_id:body.execution_request_id,project_id:id,input_revision:body.input_revision,input_hash:body.input_hash,state:'queued',stage:'queued',event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:null,prompt_snapshot_ref:null,channel:'production',test_grant_id:null,uncovered_items:[],updated_at:now};result=state.run;status=202;
    } else if(path==='/runs/run-1')result=state.run;
    else if(path==='/runs/run-1/events')result={items:[],next_cursor:null};
    else {status=404;result={code:'NOT_FOUND'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
  });
  return state;
}
async function capture(page:Page,name:string) {
  await page.evaluate(()=>{document.activeElement instanceof HTMLElement&&document.activeElement.blur();scrollTo(0,0);});
  await page.screenshot({path:join(tmpdir(),`bb370-${name}.png`),fullPage:true});
}
async function addReference(page:Page,state:ReturnType<typeof fixture>){
  const file={name:'synthetic-reference.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('Synthetic reference prospectus bytes')};
  await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect.poll(()=>state.materials.filter(material=>material.role==='historical').length).toBe(1);
  const material=state.materials.find(value=>value.role==='historical')!;
  // The changed callback remounts this panel, so verify the persisted selected version after that read.
  const selected=page.locator('[data-prospectus-version="version-'+material.material_id+'"]');
  await expect(selected).toBeVisible();await expect(selected).toHaveClass(/is-selected/);
  await expect(selected.locator('[data-prospectus-selection-state]')).toHaveText('本次更新已选用');
  await expect(selected.locator('.prospectus-version-info > strong')).toHaveText(file.name);
  await expect(selected.locator('.reference-file-meta')).toContainText('V1');expect(state.selectionRevision).toBe(1);
  expect(material).toMatchObject({filename:file.name,byte_size:file.buffer.length,sha256:createHash('sha256').update(file.buffer).digest('hex')});
  expect(state.currentVersionId).toBe('version-'+material.material_id);
  const source=page.locator('[data-source-material="'+material.material_id+'"]');
  await source.getByLabel('与目标发行人的关系',{exact:true}).selectOption('same_issuer');
  await source.getByLabel('原发行市场',{exact:true}).selectOption('sse');
  await source.getByLabel('原品种',{exact:true}).selectOption('private');
  await source.getByLabel('原稿最新报告期年份',{exact:true}).selectOption('2024');
  const savedMetadata=page.waitForResponse(response=>{
    if(response.request().method()!=='PATCH'||new URL(response.url()).pathname!=='/api/v1/projects/'+id)return false;
    const fields=response.request().postDataJSON().update_details?.source_prospectuses;
    return fields?.some((value:any)=>value.material_id===material.material_id&&value.material_version===material.material_version&&value.sha256===material.sha256&&value.relation==='same_issuer'&&value.market==='sse'&&value.offering==='private'&&value.reporting_periods?.map((period:any)=>period.end).join(',')==='2023-12-31,2024-12-31')??false;
  });
  await source.getByRole('radio',{name:'年末',exact:true}).check();
  const savedResponse=await savedMetadata;expect(savedResponse.status()).toBe(200);
  const savedProject=await savedResponse.json();expect(Value.Check(schemas.ProjectResponse,savedProject)).toBe(true);
  expect(savedProject.update_details.source_prospectuses).toEqual(state.project.update_details!.source_prospectuses);
  await expect(page.locator('#save-state')).toHaveText('已保存');
  await expect(source.locator('[data-source-required-message]')).toHaveText('原稿信息已填写完整。');
  await expect.poll(()=>state.project.update_details?.source_prospectuses?.[0]?.reporting_periods.length).toBe(2);
  expect(state.project.update_details!.source_prospectuses![0]).toMatchObject({material_id:material.material_id,material_version:material.material_version,sha256:material.sha256,relation:'same_issuer',market:'sse',offering:'private'});
  expect(state.calls.filter(call=>call.path==='/runs/execute'||call.path.endsWith('/input-revisions')||call.path.endsWith('/preflight'))).toEqual([]);
}
async function addFile(page:Page){await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({name:'synthetic-audit.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF synthetic UI fixture')});}

test('quarter selection -> create -> upload -> original footer action -> refresh recovery',async({page})=>{
  const state=await install(page); await page.goto('/#/new');
  await page.setViewportSize({width:1440,height:960});
  await expect(page.locator('#create-form input[type=date]')).toHaveCount(0);
  await page.getByLabel('发行人全称').fill('合成发行人有限公司');
  await expect(page.getByRole('radio',{name:'有',exact:true})).toHaveCount(0);await page.getByLabel('发行市场',{exact:true}).selectOption('sse');await page.getByLabel('发行方式',{exact:true}).selectOption('private');
  await page.getByLabel('最新报告期年份').selectOption('2026');await page.getByRole('radio',{name:'6月末',exact:true}).check();
  await capture(page,'create-desktop');
  await page.setViewportSize({width:390,height:844});await capture(page,'create-mobile');
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
  await expect(page.locator('#start-disabled-reason')).toContainText('请先上传并采用一份历史／参考募集书');
  expect(state.project.update_details!.reporting_cutoff).toBe('2026-06-30');
  expect(state.project.update_details!.target_reporting_periods).toEqual([
    {start:'2024-01-01',end:'2024-12-31',period_kind:'annual',scope:null,status:'needs_confirmation',evidence_refs:[]},
    {start:'2025-01-01',end:'2025-12-31',period_kind:'annual',scope:null,status:'needs_confirmation',evidence_refs:[]},
    {start:'2026-01-01',end:'2026-06-30',period_kind:'interim',scope:null,status:'needs_confirmation',evidence_refs:[]}
  ]);
  await expect(page.locator('#execution-setup, #target-reporting-period-rows')).toHaveCount(0);
  await expect(page.getByText('准备好，开始更新',{exact:true})).toHaveCount(0);
  await expect(page.locator('#execution-actions input, #execution-actions select')).toHaveCount(0);
  await expect(page.locator('#upload-policy-note')).toHaveText('数据保存与删除说明');
  await addReference(page,state);await addFile(page);await expect(page.getByRole('button',{name:'开始更新',exact:true})).toBeEnabled();
  expect(state.uploadBytes).toEqual(['upload-1','upload-2']);expect(state.uploadCompletions).toEqual(['upload-1','upload-2']);
  expect(state.materials.map(material=>material.role)).toEqual(['historical','audit']);
  await page.setViewportSize({width:1440,height:960});await capture(page,'materials-desktop');
  await page.setViewportSize({width:390,height:844});await capture(page,'materials-mobile');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  const button=page.locator('#execute-input');expect(await button.evaluate(el=>Boolean(el.closest('.form-footer')))).toBe(true);
  await button.click();await expect(page.locator('#execution-progress')).toContainText('等待开始');
  expect(state.calls.filter(c=>c.path==='/runs/execute')).toHaveLength(1);
  expect(state.calls.find(c=>c.path.endsWith('/input-revisions')&&c.method==='POST')!.body).not.toHaveProperty('target_confirmation');
  await page.reload();await expect(page.locator('#execution-progress')).toContainText('等待开始');
  await expect(page.locator('#start-disabled-reason')).toContainText('已有任务');
  await page.getByRole('button',{name:'编辑项目信息'}).click();
  await expect(page.getByLabel('最新报告期年份')).toHaveValue('2026');await expect(page.getByRole('radio',{name:'6月末',exact:true})).toBeChecked();
  expect(state.calls.filter(c=>c.path==='/runs/execute')).toHaveLength(1);
});

test('unrelated edits preserve old dates and periods; quarter and year changes derive pending reporting windows',async({page})=>{
  const state=fixture();state.project.update_details!.reporting_cutoff='2024-04-20';await install(page,state);await page.goto(`/#/projects/${id}?step=details`);
  await expect(page.locator('#legacy-cutoff')).toContainText('2024-04-20');await expect(page.locator('[name=reporting_quarter]:checked')).toHaveCount(0);
  await page.locator('details.update-optional-section[data-update-group=other] > summary').click();
  await page.getByLabel('其他已知信息').fill('补充说明，不修改旧日期或期间。');
  // A pre-existing saved badge is not the acknowledgement of this edit.
  await expect.poll(()=>state.calls.filter(c=>c.method==='PATCH').length).toBe(1);
  await expect(page.locator('#save-state')).toHaveText('已保存');expect(state.project.update_details!.reporting_cutoff).toBe('2024-04-20');
  expect(state.project.update_details!.target_reporting_periods).toEqual(periods);
  const expectedWindows=[
    ['2023-12-31','2024-12-31','2025-03-31'],['2023-12-31','2024-12-31','2025-06-30'],
    ['2023-12-31','2024-12-31','2025-09-30'],['2024-12-31','2025-12-31']
  ];
  await page.getByLabel('最新报告期年份').selectOption('2025');
  let index=0;
  for(const [label,date] of [['3月末','03-31'],['6月末','06-30'],['9月末','09-30'],['年末','12-31']]) {
    await page.getByRole('radio',{name:label,exact:true}).check();await expect.poll(()=>state.project.update_details!.reporting_cutoff).toBe(`2025-${date}`);
    expect(state.project.update_details!.target_reporting_periods).toEqual(expectedWindows[index++].map(end=>({
      start:`${end.slice(0,4)}-01-01`,end,period_kind:end.endsWith('12-31')?'annual':'interim',scope:null,status:'needs_confirmation',evidence_refs:[]
    })));
  }
  await page.getByLabel('最新报告期年份').selectOption('2026');await expect.poll(()=>state.project.update_details!.reporting_cutoff).toBe('2026-12-31');
  await page.reload();await expect(page.getByRole('radio',{name:'年末',exact:true})).toBeChecked();
  await expect(page.locator('#target-reporting-period-rows, [data-remove-target-period]')).toHaveCount(0);
  expect(state.project.update_details!.target_reporting_periods).toEqual(['2025-12-31','2026-12-31'].map(end=>({start:`${end.slice(0,4)}-01-01`,end,period_kind:'annual',scope:null,status:'needs_confirmation',evidence_refs:[]})));
  expect(state.calls.find(c=>c.method==='PATCH')!.body.update_details.target_reporting_periods).toEqual(periods);
});

test('disabled reason follows actual upload/save state; capability-off only appears after API rejection',async({page})=>{
  const state=await install(page);state.preflightOff=true;
  Object.assign(state.project.update_details!,{authoring_mode:'unified_v1',has_historical:null});
  await page.goto(`/#/projects/${id}`);
  await expect(page.locator('#start-disabled-reason')).toContainText('请先上传并采用一份历史／参考募集书');await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#execution-message')).toBeEmpty();expect(state.calls.some(c=>c.path.endsWith('/preflight'))).toBe(false);
  await addReference(page,state);await expect(page.locator('#execute-input')).toBeEnabled();
  state.holdSave=true;await addFile(page);await expect.poll(()=>Boolean(state.releaseSave)).toBe(true);
  await expect(page.locator('#start-disabled-reason')).toContainText('synthetic-audit.pdf');await expect(page.locator('#start-disabled-reason')).toContainText('保存');
  await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.calls.filter(call=>call.path.endsWith('/preflight')||call.path==='/runs/execute')).toEqual([]);
  expect(state.uploadBytes).toEqual(['upload-1','upload-2']);expect(state.uploadCompletions).toEqual(['upload-1','upload-2']);
  state.releaseSave!();
  await expect(page.locator('#execute-input')).toBeEnabled();await expect(page.locator('#start-disabled-reason')).toBeEmpty();
  await page.locator('#execute-input').click();await expect(page.locator('#execution-message')).toContainText('当前环境尚未开放全文更新');
  expect(state.calls.some(c=>c.path==='/runs/execute')).toBe(false);
});

test('failed material reads give a retry reason that clears on successful recovery',async({page})=>{
  const state=fixture();state.materialReadFails=true;await install(page,state);await page.goto(`/#/projects/${id}`);
  await expect(page.locator('#start-disabled-reason')).toContainText('材料记录读取失败');await expect(page.locator('#execute-input')).toBeDisabled();
  state.materialReadFails=false;await page.getByRole('button',{name:'刷新已保存材料',exact:true}).click();
  await expect(page.locator('#start-disabled-reason')).toContainText('请先添加');await expect(page.locator('#start-disabled-reason')).not.toContainText('读取失败');
});


for(const width of [1440,390])test(`financial material guidance follows project edits and survives reload ${width}`,async({page})=>{
  const s=fixture();s.project.update_details={...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-06-30'};
  await install(page,s);await page.setViewportSize({width,height:width===1440?960:844});await page.goto(`/#/projects/${id}`);
  const guide=page.locator('[data-financial-upload-guidance]');
  await expect(guide).toBeVisible();await expect(guide.locator('li')).toHaveText(['2024年度审计报告（含财务报表及附注）','2025年度审计报告（含财务报表及附注）','2026年1—6月财务报表']);
  await expect(page.locator('.material-file-row')).toHaveCount(0);
  const box=await guide.boundingBox(),picker=await page.locator('[data-material-role=audit] .material-role-heading').boundingBox();expect(box!.y).toBeGreaterThanOrEqual(picker!.y+picker!.height);
  if(process.env.BB_GUIDANCE_EVIDENCE){const dir='test-evidence/financial-guidance-20261010';await mkdir(dir,{recursive:true});await page.locator('[data-material-role=audit]').screenshot({path:`${dir}/implementation-${width}.png`});}
  await page.getByRole('button',{name:'编辑项目信息'}).click();await page.getByLabel('发行方式',{exact:true}).selectOption('public');
  await page.getByLabel('最新报告期年份').selectOption('2027');await page.getByRole('radio',{name:'年末',exact:true}).check();
  await expect.poll(()=>s.project.update_details!.reporting_cutoff).toBe('2027-12-31');
  await expect(guide.locator('li')).toHaveText(['2025年度审计报告（含财务报表及附注）','2026年度审计报告（含财务报表及附注）','2027年度审计报告（含财务报表及附注）']);
  await page.goto(`/#/projects/${id}?step=materials`);await page.reload();await expect(guide).toBeVisible();await expect(guide.locator('li')).toHaveCount(3);await expect(guide).not.toContainText('1—');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(s.calls.some(c=>c.path==='/runs/execute')).toBe(false);
});

test('financial material guidance explains missing and invalid project inputs without blocking upload',async({page})=>{
  const s=fixture();s.project.market=null;s.project.offering=null;s.project.update_details!.reporting_cutoff=null;
  await install(page,s);await page.goto(`/#/projects/${id}`);const guide=page.locator('[data-financial-upload-guidance]');
  await expect(guide).toContainText('发行市场、品种／发行方式、财务截止日');await expect(guide.locator('li')).toHaveCount(0);
  await expect(page.locator('[data-upload-role=audit]')).toBeEnabled();
  s.project.market='sse';s.project.offering='private';s.project.update_details!.reporting_cutoff='2026-06-29';await page.reload();
  await expect(guide).toContainText('暂无法确定所需财务期间');await expect(guide.locator('li')).toHaveCount(0);
});
