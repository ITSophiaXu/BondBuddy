import {expect, type Page, type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import {
  emptyUpdateDetails, M4_DOCUMENT_TYPES, schemas,
  type M4Draft, type M4Workspace, type ReviewWorkspace, type Run,
  type RunSupplementChange, type RunSupplementDraftRequest, type RunSupplementDraftResponse,
  type RunSupplementMaterial, type RunSupplementInputPreview, type RunSupplementSavedWork,
} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {taskPage} from './collection-fixtures';

// Stateful synthetic HTTP boundaries in real Chromium. No database, model or Word acceptance.
export const supplementIds={owner:'supplement-owner',project:'supplement-project',run:'supplement-run',topic:'supplement-topic'};
export const supplementNow='2026-10-26T10:00:00Z';
export const supplementMime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const supplementHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const supplementPin=(m:Pick<RunSupplementMaterial,'material_id'|'material_version'|'sha256'>)=>({material_id:m.material_id,material_version:m.material_version,sha256:m.sha256});
const samePin=(a:ReturnType<typeof supplementPin>,b:ReturnType<typeof supplementPin>)=>JSON.stringify(a)===JSON.stringify(b);
export type SupplementSurface='panel'|'m1'|'m3'|'m4';
const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});

export function supplementFixture(){
  const {project:projectId,run:runId}=supplementIds;
  const materials:Dto<'MaterialResponse'>[]=['historical','audit'].map((role,index)=>({
    material_id:`supplement-base-${index}`,material_version:1,upload_id:`supplement-base-upload-${index}`,
    filename:index===0?'原冻结募集书.docx':'原冻结审计报告.docx',role:role as 'historical'|'audit',
    media_type:supplementMime,byte_size:100,sha256:supplementHash(role),state:'persisted',persisted_at:supplementNow,error:null,
  }));
  const project:Dto<'ProjectResponse'>={
    project_id:projectId,name:'合成暂停补料项目',issuer_name:'合成发行人',kind:'update',market:'sse',offering:'private',
    draft_revision:4,input_revision:7,input_hash:supplementHash('original-frozen-input'),updated_at:supplementNow,
    update_details:{...emptyUpdateDetails(),has_historical:true,authoring_mode:'unified_v1',reporting_cutoff:'2025-12-31'},
  };
  const run:Run={run_id:runId,project_id:projectId,execution_request_id:'supplement-original-execution',
    input_revision:7,input_hash:project.input_hash!,state:'paused',stage:'user_paused',channel:'production',test_grant_id:null,
    uncovered_items:[],event_cursor:0,billing_mode:'fixed_credits',reservation_id:'supplement-reservation',artifact_id:null,prompt_snapshot_ref:null,updated_at:supplementNow};
  const input:Dto<'InputRevisionResponse'>={project_id:projectId,input_revision:7,input_hash:run.input_hash,
    material_versions:materials.map(supplementPin),target_confirmation:{status:'unconfirmed',market:null,offering:null,as_of:null,document_purpose:null,target_reporting_periods:[],confirmed_at:null,confirmed_by:null},
    rule_pack_version:null,template_version:null,reference_release:null,created_at:supplementNow};
  const base:RunSupplementMaterial[]=materials.map(m=>({...supplementPin(m),source_project_id:projectId,filename:m.filename,role:m.role,media_type:m.media_type,available:true}));
  const review:ReviewWorkspace={project:{...project,kind:'review'},materials:structuredClone(materials),draft:{
    version:2,source_material_ref:supplementPin(materials[0]),material_versions:materials.map(supplementPin),requirements:['原冻结复核要求'],as_of:null,evidence_links:[]},
    message_drafts:[],active_run:run,selected_report:null,reports:[],messages:[],plan:null,artifacts:[],
    timeline:[{kind:'task',entry_id:'task:'+runId,created_at:supplementNow,task:{run,operation:'full_review',version:1,input_version:2,input_revision:7,input_sha256:run.input_hash,source_report_id:null,report_id:null,finding_ids:[],origin:{version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null},artifacts:[],events:[]}}],
  };
  const m4Pin={...supplementPin(materials[0]),source_project_id:projectId};
  const draft=(document_type:typeof M4_DOCUMENT_TYPES[number]):M4Draft=>({document_type,version:2,sha256:supplementHash(document_type),updated_at:supplementNow,
    source_material:document_type==='private_summary'?m4Pin:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',broker:'合成券商'},requirements:[]});
  const m4:M4Workspace={topic:{topic_id:supplementIds.topic,project_id:projectId,source_project_id:null,name:project.name,created_at:supplementNow,updated_at:supplementNow},
    project:{...project,kind:'generation'},drafts:Object.fromEntries(M4_DOCUMENT_TYPES.map(type=>[type,draft(type)])) as M4Workspace['drafts'],
    materials:[m4Pin],material_details:[{...m4Pin,filename:materials[0].filename,state:'persisted',media_type:supplementMime}],templates:[],messages:[],pending_requirements:[],artifacts:[],
    view:{selected_document_type:'private_summary',open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},
    active_run:run,tasks:[],
  };
  const charge:Dto<'RunCreditChargeResponse'>={quote:null,state:'held',progress:{policy:'authoring_balance_v2',accrued_points:1200,charged_points:1200,released_points:0,
    active_ms:60000,credit_exhausted:false,available_points:10000,pause_requested:true,queued_at:supplementNow,sampled_at:supplementNow,last_activity_at:supplementNow,queue_ahead:null,clock_running:false}};
  m4.tasks=[{run,manifest:{version:'m4-document-input-v1',kind:'document',topic_id:supplementIds.topic,execution_scope_project_id:projectId,draft_version:2,
    input:structuredClone(m4.drafts.private_summary),template_material:null,market:'sse',offering:'private',billing_task:'m4_G05'},created_at:supplementNow,events:[],artifacts:[],credit_charge:{...charge,quote:null}}];
  return {project,run,input,materials,base,review,m4,charge,revision:0,changes:[] as RunSupplementChange[],
    receipts:new Map<string,RunSupplementDraftResponse>(),requestBodies:new Map<string,RunSupplementDraftRequest>(),
    saves:[] as RunSupplementDraftRequest[],reads:[] as (string|null)[],controls:[] as string[],unexpectedMutations:[] as string[],unhandledReads:[] as string[],
    uploads:[] as Dto<'UploadCreateRequest'>[],byteWrites:0,completions:[] as string[],
    dropSaveOnce:false,dropUnacceptedSaveOnce:false,failReceiptReads:false,receiptMismatchOnce:false,failLatestReads:false,
    holdDraftRead:false,releaseDraftRead:undefined as (()=>void)|undefined,holdSave:false,releaseSave:undefined as (()=>void)|undefined,
    holdComplete:false,releaseComplete:undefined as (()=>void)|undefined,dropCompleteOnce:false,canSave:true,blockedReason:null as string|null,
    inputPreview:null as RunSupplementInputPreview|null,
    savedWork:null as RunSupplementSavedWork|null,workStageCount:0,workResultCount:0,
  };
}
export type SupplementFixture=ReturnType<typeof supplementFixture>;

export function supplementResponse(s:SupplementFixture,requestId:string|null=null):RunSupplementDraftResponse{
  const changed=s.changes.flatMap(c=>c.replaces?[c.replaces]:[]);
  const result=s.base.filter(m=>!changed.some(pin=>samePin(supplementPin(m),pin)));
  for(const change of s.changes){const m=s.materials.find(m=>samePin(supplementPin(m),change.material));if(m)result.push({...supplementPin(m),source_project_id:supplementIds.project,filename:m.filename,role:m.role,media_type:m.media_type,available:true});}
  return {run_id:s.run.run_id,project_id:s.project.project_id,revision:s.revision,latest_revision:s.revision,request_id:requestId,
    saved_at:s.revision?supplementNow:null,base_input_revision:s.run.input_revision,base_input_hash:s.run.input_hash,base_materials:structuredClone(s.base),changes:structuredClone(s.changes),
    result_materials:structuredClone(result),saved_work:structuredClone(s.savedWork??{status:'not_captured',stage_count:0,result_count:0}),input_preview:s.inputPreview??(s.changes.length?{
      compiler_version:'run-supplement-input-v1',status:'prepared',candidate_input_hash:supplementHash(JSON.stringify(s.changes)),issues:[],
    }:{compiler_version:'run-supplement-input-v1',status:'unchanged',candidate_input_hash:null,issues:[]}),
    can_save:s.canSave&&s.run.state==='paused',blocked_reason:s.canSave&&s.run.state==='paused'?null:s.blockedReason??'本次任务尚未安全暂停，请先核对任务状态。',adopted:false};
}

export async function installSupplementHttp(page:Page,s:SupplementFixture){
  await page.context().route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
    if(path===`/runs/${s.run.run_id}/supplement-draft`){
      if(method==='GET'){
        const id=url.searchParams.get('request_id');s.reads.push(id);
        if(id){if(s.failReceiptReads)return json(route,{code:'DATA_UNAVAILABLE'},503);const receipt=s.receipts.get(id);if(receipt&&s.receiptMismatchOnce){s.receiptMismatchOnce=false;return json(route,{...receipt,request_id:'unrelated-request-id',latest_revision:s.revision});}return receipt?json(route,{...receipt,saved_work:s.savedWork??receipt.saved_work,latest_revision:s.revision,can_save:s.canSave&&s.run.state==='paused'}):json(route,{code:'NOT_FOUND'},404);}
        if(s.failLatestReads)return json(route,{code:'DATA_UNAVAILABLE'},503);
        const response=supplementResponse(s);if(s.holdDraftRead){s.holdDraftRead=false;await new Promise<void>(resolve=>{s.releaseDraftRead=resolve;});}return json(route,response);
      }
      const body=request.postDataJSON() as RunSupplementDraftRequest;
      expect(Value.Check(schemas.RunSupplementDraftRequest,body)).toBe(true);s.saves.push(structuredClone(body));
      const prior=s.requestBodies.get(body.request_id);
      if(prior)return JSON.stringify(prior)===JSON.stringify(body)?json(route,{...s.receipts.get(body.request_id)!,saved_work:s.savedWork??s.receipts.get(body.request_id)!.saved_work,latest_revision:s.revision}):json(route,{code:'INPUT_REVISION_CONFLICT'},409);
      if(s.holdSave){s.holdSave=false;await new Promise<void>(resolve=>{s.releaseSave=resolve;});}
      if(s.dropUnacceptedSaveOnce){s.dropUnacceptedSaveOnce=false;return route.abort('connectionreset');}
      if(body.expected_revision!==s.revision||!s.canSave)return json(route,{code:'INPUT_REVISION_CONFLICT'},409);
      s.revision++;s.changes=structuredClone(body.changes);s.savedWork={status:'captured',stage_count:s.workStageCount,result_count:s.workResultCount};s.requestBodies.set(body.request_id,structuredClone(body));
      const response=supplementResponse(s,body.request_id);s.receipts.set(body.request_id,response);
      if(s.dropSaveOnce){s.dropSaveOnce=false;return route.abort('connectionreset');}return json(route,response);
    }
    if(path===`/projects/${s.project.project_id}/materials/uploads`&&method==='POST'){
      const declaration=request.postDataJSON();expect(Value.Check(schemas.UploadCreateRequest,declaration)).toBe(true);s.uploads.push(declaration);
      const id='supplement-upload-'+s.uploads.length;return json(route,{upload_id:id,state:'uploading',upload_url:'/api/v1/supplement-bytes/'+id,expires_at:'2099-01-01T00:00:00Z',max_bytes:104857600},201);
    }
    if(path.startsWith('/supplement-bytes/')){s.byteWrites++;return route.fulfill({status:204});}
    if(path.match(/\/materials\/uploads\/supplement-upload-\d+\/complete$/)){
      const id=path.split('/').at(-2)!,declaration=s.uploads[Number(id.split('-').at(-1))-1];s.completions.push(id);
      if(s.holdComplete){s.holdComplete=false;await new Promise<void>(resolve=>{s.releaseComplete=resolve;});}
      let m=s.materials.find(m=>m.sha256===declaration.sha256&&m.role===declaration.role);
      if(!m){m={...declaration,material_id:'material-'+id,material_version:1,upload_id:id,state:'persisted',persisted_at:supplementNow,error:null};s.materials.push(m);}
      if(s.dropCompleteOnce){s.dropCompleteOnce=false;return route.abort('connectionreset');}return json(route,m);
    }
    if(path==='/me')return json(route,{user_id:supplementIds.owner,session_status:'active'});
    if(path===`/projects/${s.project.project_id}`&&method==='GET')return json(route,s.project);
    if(path===`/projects/${s.project.project_id}/tasks`)return json(route,taskPage(s.project.project_id,[s.run],s.project.kind));
    if(path===`/projects/${s.project.project_id}/input-revisions/7`)return json(route,s.input);
    if(path===`/projects/${s.project.project_id}/prospectus-versions`)return json(route,{project_id:s.project.project_id,current_version_id:null,selection_revision:0,inactive_material_ids:[],versions:[]});
    const material=s.materials.find(m=>path===`/projects/${s.project.project_id}/materials/${m.material_id}`);if(material&&method==='GET')return json(route,material);
    if(path===`/runs/${s.run.run_id}/credit-charge`)return json(route,s.charge);
    if(path===`/runs/${s.run.run_id}/events`)return json(route,{items:[],next_cursor:null});
    if(path===`/runs/${s.run.run_id}/stream`)return route.fulfill({status:200,contentType:'text/event-stream',body:': synthetic stream\n\n'});
    if(path===`/runs/${s.run.run_id}`)return json(route,s.run);
    if(path===`/runs/${s.run.run_id}/resume`&&method==='POST'){
      s.controls.push('resume');s.run.state='running';s.run.stage='model_generation';s.charge.progress!.pause_requested=false;s.charge.progress!.clock_running=true;return json(route,s.run);
    }
    if(path==='/credits/balance')return json(route,{enabled:true,available:10000,frozen:0});
    if(path===`/projects/${s.project.project_id}/review-workspace`)return json(route,s.review);
    if(path===`/projects/${s.project.project_id}/review-history`)return json(route,{items:[]});
    if(path==='/m4/topics')return json(route,{topics:[s.m4.topic]});
    if(path===`/m4/topics/${supplementIds.topic}/workspace`)return json(route,s.m4);
    if(path===`/m4/topics/${supplementIds.topic}/view`){const body=request.postDataJSON();s.m4.view={...body.view,version:body.expected_version+1};return json(route,{view:s.m4.view});}
    if(method!=='GET')s.unexpectedMutations.push(method+' '+path);else s.unhandledReads.push(path);
    return json(route,{code:'NOT_FOUND'},404);
  });
}

export async function mountSupplementSurface(page:Page,s:SupplementFixture,surface:SupplementSurface='panel'){
  await page.setViewportSize({width:1440,height:960});
  const origin=process.env.BB_E2E_BASE_URL??'http://127.0.0.1:5173';
  await page.route(new URL('/',origin).href,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div class="prototype-app"><main class="shell"></main></div></body></html>'}));
  const hash=surface==='m3'?`#/projects/${s.project.project_id}/review?tab=making&run=${s.run.run_id}`:surface==='m4'?`#generate?topic=${supplementIds.topic}&run=${s.run.run_id}`:`#/projects/${s.project.project_id}?run=${s.run.run_id}`;
  await page.goto('/'+hash);
  await page.evaluate(async input=>{const path='/tests/run-supplement-browser-harness.ts',{mountSupplementBrowserHarness}=await import(path);await mountSupplementBrowserHarness(input);},
    {surface,owner:supplementIds.owner,project:s.project,run:s.run,topic:supplementIds.topic});
}
