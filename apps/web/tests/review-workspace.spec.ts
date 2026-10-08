import { expect, test, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { schemas, ReviewDraftRequestSchema, ReviewExecutionRequestSchema, ReviewMessageRequestSchema, ReviewPlanRequestSchema, isReviewReport,
  type ReviewWorkspace, type ReviewDraftInput, type ReviewReport, type ReviewEvidenceRef, type ReviewContext, type ReviewMessageRequest,
  type ReviewExecutionRequest, type ReviewPlanRequest, type ReviewProposal, type ReviewProposalV2, type ReviewProposalAdoptionRequest, type ReviewProposalAdoptionResponse, type ReviewHistoryEntry, type ReviewRevisionHandling, type Run, type RunEvent } from '@bondbuddy/contracts';
import type { Dto } from '../src/api';

// Real Chromium with an owner-aware synthetic HTTP fixture. Not model, database or Word acceptance.
const id='synthetic-review-project',now='2026-10-02T10:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const reply=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
const key=(context:ReviewContext)=>JSON.stringify(context);
const readableMarkdown='# 合成复核报告\n\n## 复核范围与依据\n本轮按 input.json 的 full_review 执行；输入锁与 input_hash 一致。\n材料路径 materials/m0.docx，SHA-256 为内部校验值。\n\n## 财务核对\n**本次结论：** 发现两项需要处理的事项，财务差异需要优先核对。\n\n**核对范围：** 已对照合成募集书与2025年合成审计报告。\n\n### 1. 现金流金额与审计报告不一致\n**原文位置：** 第八章，经营现金流表。\n\n**核对依据：** 合成审计报告。\n\n原文值 | 对照值 | 差异\n--- | --- | ---\n100 | 120 | 20\n\n**修改建议：** 确认口径后统一金额。\n\n### 2. 财务分析中的单位需核对\n**问题说明：** 原文分析使用元，报表使用万元。\n\n**修改建议：** 统一单位后重新核对分析文字。\n\n## 合规与披露\n**本次结论：** 历史名称披露缺少时间依据。\n\n### 3. 历史名称披露待补充证据\n**原文位置：** 第二章，发行人历史沿革。\n\n**待确认事项：** 缺少名称变更日期依据。\n\n**修改建议：** 补充变更文件及生效日期。\n\n## 公开信息核验\n**本次结论：** 公开信息核验未执行，不能据此判断无风险。\n\n**还需确认：** 发行人名称变更及重大诉讼的最新公开记录。\n\n## 建议处理顺序\n1. 核对财务口径\n2. 补充名称变更证据';
function fixture(){
  const materials:Dto<'MaterialResponse'>[]=['historical','audit'].map((role,index)=>({material_id:`material-${index}`,material_version:1,upload_id:`upload-${index}`,role:role as 'historical'|'audit',filename:role==='historical'?'合成募集书.docx':'合成审计报告.docx',media_type:mime,byte_size:100,sha256:hash(role),state:'persisted',persisted_at:now,error:null}));
  const pin=(index:number)=>({material_id:materials[index].material_id,material_version:1,sha256:materials[index].sha256});
  const evidence=(index:number,quote:string):ReviewEvidenceRef=>({material_id:materials[index].material_id,material_version:1,material_sha256:materials[index].sha256,parse_snapshot_id:`parse-${index}`,parse_response_sha256:hash('parse'),record_id:`record-${index}`,record_sha256:hash(quote),locator_type:'docx_block',locator:{paragraph:index+10},quote,extraction_method:'native_text',uncertainty:[]});
  const report:ReviewReport={report_id:'report-v1',project_id:id,run_id:'run-1',input_revision:1,version:1,source_material:pin(0),scope:{mode:'full_review',finding_ids:[]},findings:[
    {finding_id:'F01',report_id:'report-v1',dimension:'financial',conclusion:'error',severity:'P1',title:'现金流金额与审计报告不一致',description:'合成数据：募集书列示 100，审计报告列示 120。',target_refs:[evidence(0,'现金流 100')],evidence_refs:[evidence(1,'现金流 120')],suggested_change:'按已核实的 120 更新金额及关联引用。',limitations:[],repairability:{can_revise:true,reason:'有同口径可核对依据。',allowed_record_ids:['record-0']},origin_report_id:'report-v1',check_status:'rechecked'},
    {finding_id:'F02',report_id:'report-v1',dimension:'public',conclusion:'needs_evidence',severity:'P2',title:'历史名称需要补充说明',description:'当前材料缺少名称变更时间依据。',target_refs:[evidence(0,'原公司名称')],evidence_refs:[],limitations:['公开信息尚未核验。'],repairability:{can_revise:false,reason:'先补证，不能直接替换历史名称。',allowed_record_ids:[]},origin_report_id:'report-v1',check_status:'rechecked'}
  ],coverage:[{check_id:'financial-total',dimension:'financial',outcome:'issue',reason:'发现同口径差异',finding_ids:['F01'],evidence_refs:[evidence(1,'现金流 120')],rule_refs:[],origin_report_id:'report-v1',check_status:'rechecked'},{check_id:'public-name',dimension:'public',outcome:'needs_evidence',reason:'缺少更名依据',finding_ids:['F02'],evidence_refs:[],rule_refs:[],origin_report_id:'report-v1',check_status:'rechecked'}],limitations:['合成测试报告，用于验证页面操作。'],created_at:now};
  expect(isReviewReport(report)).toBe(true);
  const workspace:ReviewWorkspace={project:{project_id:id,name:'合成募集书复核项目',issuer_name:'合成发行人',kind:'review',market:'sse',offering:'private',draft_revision:1,input_revision:1,input_hash:hash('input'),updated_at:now},materials,draft:{version:1,source_material_ref:pin(0),material_versions:[pin(0),pin(1)],requirements:['核对财务摘要引用。'],as_of:null,evidence_links:[]},message_drafts:[],active_run:null,selected_report:report,reports:[{report_id:report.report_id,version:1,run_id:report.run_id,created_at:now}],messages:[],plan:null,artifacts:[{artifact_id:'artifact-1',artifact_version:1,kind:'report',filename:'合成问题报告.docx'}]};
  const makeRun=(runId:string,state:Run['state'],requestId='old'):Run=>({run_id:runId,execution_request_id:requestId,project_id:id,input_revision:1,input_hash:hash('input'),channel:'production',test_grant_id:null,uncovered_items:[],state,stage:null,event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:state==='succeeded'?'artifact-1':null,prompt_snapshot_ref:null,updated_at:now});
  const oldRun=makeRun('run-1','succeeded');
  const history:ReviewHistoryEntry[]=[{run:oldRun,operation:'full_review',version:1,source_report_id:null,report_id:report.report_id,input:structuredClone(workspace.draft),input_revision:1,finding_ids:[],plan:null,artifacts:workspace.artifacts,created_at:now}];
  const state={workspace,history,owner:'owner-a',requests:[] as ReviewMessageRequest[],plans:[] as ReviewPlanRequest[],executes:[] as ReviewExecutionRequest[],projectPatches:[] as Dto<'ProjectPatchRequest'>[],failProjectPatch:false,failPlan:false,runs:new Map([['old',oldRun]]),uploads:[] as Dto<'UploadCreateRequest'>[],uploadBytes:0,dropMessageOnce:false,dropExecutionOnce:false,dropUploadOnce:false,failDrafts:false,delayMessage:false,workspaceReads:0,makeRun,artifacts:new Map<string,Dto<'ArtifactResponse'>>(),artifactReads:[] as string[],materialReads:[] as string[],materialDownloads:[] as string[]};
  return {...state,uploadGates:{} as {bytes?:(id:string)=>Promise<void>;complete?:(id:string)=>Promise<void>;draft?:(input:ReviewDraftInput)=>Promise<void>},linked:false,deferCancellation:false,allReports:new Map([[report.report_id,report]]),adoptions:[] as ReviewProposalAdoptionRequest[],adoptionResults:new Map<string,ReviewProposalAdoptionResponse>(),dropAdoptionOnce:false,events:new Map<string,RunEvent[]>()};
}
async function setup(page:Page,state=fixture(),routePath=`#/projects/${id}/review?tab=results`){
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
    if(path.endsWith('/quote'))return reply(route,200,{enabled:false,quote:null,balance:{available:0,frozen:0},shortage:0,reason:null});
    if(path==='/me')return reply(route,200,{user_id:state.owner,session_status:'active'});
    if(path.endsWith('/readable-report'))return reply(route,200,{version:'review-readable-v1',project_id:id,run_id:'run-1',execution_version:1,status:'available',markdown:readableMarkdown,content_sha256:hash(readableMarkdown)});
    if(path==='/projects')return reply(route,200,{items:[{...state.workspace.project,status:state.workspace.active_run?.state??'succeeded',latest_artifact:null,latest_run:null}],page:{next_cursor:null,has_more:false}});
    if(state.owner!=='owner-a')return reply(route,404,{code:'NOT_FOUND'});
    if(path===`/projects/${id}`){
      if(method==='PATCH'){
        const body=request.postDataJSON() as Dto<'ProjectPatchRequest'>;expect(Value.Check(schemas.ProjectPatchRequest,body)).toBe(true);state.projectPatches.push(body);
        if(state.failProjectPatch)return reply(route,503,{code:'DATA_UNAVAILABLE'});
        if(request.headers()['if-match']!==String(state.workspace.project.draft_revision))return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
        state.workspace.project={...state.workspace.project,...body,draft_revision:state.workspace.project.draft_revision+1,updated_at:now};
      }
      return reply(route,200,state.workspace.project);
    }
    if(path.endsWith('/review-workspace')){state.workspaceReads++;
      if(!state.linked)return reply(route,200,state.workspace);
      const selected=url.searchParams.get('report_id'),report=selected?state.allReports.get(selected):state.workspace.selected_report;
      const timeline=[...state.workspace.messages.map(message=>({kind:'message' as const,entry_id:`message:${message.message_id}`,created_at:message.created_at,message})),...state.history.map(item=>({kind:'task' as const,entry_id:`task:${item.run.run_id}`,created_at:item.created_at,task:{run:item.run,operation:item.operation,version:item.version,input_version:item.input_revision,input_revision:item.input_revision,input_sha256:item.run.input_hash,source_report_id:item.source_report_id,report_id:item.report_id,finding_ids:item.finding_ids,origin:item.origin??{version:'review-execution-origin-v1' as const,entrypoint:'quick_action' as const,accepted_proposal:null,context_report_ref:null},artifacts:item.artifacts,events:state.events.get(item.run.run_id)??[]}}))];
      return reply(route,200,{...state.workspace,selected_report:report??null,timeline});
    }
    if(path.endsWith('/review-history'))return reply(route,200,{items:state.history});
    if(path.endsWith('/review-draft')){
      if(method==='PUT'){
        const body=request.postDataJSON();expect(Value.Check(ReviewDraftRequestSchema,body)).toBe(true);
        if(state.failDrafts)return reply(route,503,{code:'DATA_UNAVAILABLE'});
        if(body.kind==='input'){
          await state.uploadGates.draft?.(body.input);
          if(body.expected_version!==state.workspace.draft.version)return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
          state.workspace.draft={...body.input,version:body.expected_version+1};
        }else{
          const index=state.workspace.message_drafts.findIndex(d=>key(d.context)===key(body.context)),old=state.workspace.message_drafts[index];
          if(body.expected_version!==(old?.version??0))return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
          const next={context:body.context,content:body.content,version:body.expected_version+1,updated_at:now};
          if(index<0)state.workspace.message_drafts.push(next);else state.workspace.message_drafts[index]=next;
        }
      }
      return reply(route,200,{draft:state.workspace.draft,message_drafts:state.workspace.message_drafts});
    }
    if(path.endsWith('/review-messages')){
      const body=request.postDataJSON() as ReviewMessageRequest;expect(Value.Check(ReviewMessageRequestSchema,body)).toBe(true);state.requests.push(body);
      let message=state.workspace.messages.find(m=>m.message_id===body.submission_request_id);
      if(!message){message={message_id:body.submission_request_id,role:'user',content:body.content,context:body.context,created_at:now,reply_status:'completed',reply_to:null,proposal:null,error:null};state.workspace.messages.push(message);state.workspace.messages.push({...message,message_id:`reply-${message.message_id}`,role:'assistant',content:'合成助手回复：已理解说明，可核对修订提议。',reply_to:message.message_id,proposal:{proposal_id:`proposal-${message.message_id}`,source_report_id:'report-v1',finding_ids:['F01'],requirements:['保留历史名称，只修改本期金额。'],explanation:'仅调整已核实的现金流金额。'}});}
      if(state.dropMessageOnce){state.dropMessageOnce=false;return route.abort('connectionreset');}
      if(state.delayMessage)await new Promise(resolve=>setTimeout(resolve,500));
      return reply(route,201,{message});
    }
    if(path.endsWith('/revision-plan')){
      const body=request.postDataJSON() as ReviewPlanRequest;expect(Value.Check(ReviewPlanRequestSchema,body)).toBe(true);state.plans.push(body);
      if(state.failPlan)return reply(route,503,{code:'DATA_UNAVAILABLE'});
      if(body.expected_version!==(state.workspace.plan?.version??0))return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
      const {expected_version,proposal_id,...plan}=body;
      const proposal=proposal_id?state.workspace.messages.find(message=>message.role==='assistant'&&message.proposal?.proposal_id===proposal_id)?.proposal:undefined;
       if(proposal_id&&(!proposal||proposal.source_report_id!==body.source_report_id||'version' in proposal))return reply(route,422,{code:'VALIDATION_FAILED'});
      const proposal_origin=proposal?{proposal:structuredClone(proposal),sha256:hash(JSON.stringify(proposal)),adoption:JSON.stringify([...proposal.finding_ids].sort())===JSON.stringify([...body.finding_ids].sort())&&JSON.stringify(proposal.requirements)===JSON.stringify(body.requirements)?'as_proposed' as const:'user_adjusted' as const}:undefined;
      state.workspace.plan={...plan,version:expected_version+1,plan_id:'plan-1',sha256:hash(JSON.stringify(body)),accepted_at:now,...(proposal_origin?{proposal_origin}:{})};return reply(route,200,state.workspace.plan);
    }
    if(path.endsWith('/review-proposal-adoptions')){
      const body=request.postDataJSON() as ReviewProposalAdoptionRequest;state.adoptions.push(body);
      let result=state.adoptionResults.get(body.adoption_request_id);
      if(!result){
        const proposal=state.workspace.messages.find(message=>message.proposal?.proposal_id===body.proposal_id)?.proposal as ReviewProposalV2;
        if(!proposal||body.expected_input_version!==state.workspace.draft.version)return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
        state.workspace.draft={...state.workspace.draft,version:state.workspace.draft.version+1,requirements:[...state.workspace.draft.requirements,...body.requirements]};
        const accepted={acceptance_id:`acceptance-${body.adoption_request_id}`,proposal,proposal_sha256:hash('proposal'),adoption:'as_proposed' as const,accepted_at:now,input_version:state.workspace.draft.version,input_sha256:hash('adopted'),report_catalog_version:state.workspace.reports.length,finding_ids:body.finding_ids,excluded_findings:body.excluded_findings,requirements:body.requirements};
        state.workspace.accepted_proposals=[...(state.workspace.accepted_proposals??[]),accepted];
        const plan=proposal.operation==='revision'?{plan_id:'adopted-plan',version:(state.workspace.plan?.version??0)+1,source_report_id:proposal.source_report_id!,finding_ids:[...body.finding_ids],excluded_findings:structuredClone(body.excluded_findings),requirements:[...body.requirements],sha256:hash('adopted-plan'),accepted_at:now,proposal_origin:{proposal:structuredClone(proposal),sha256:hash('proposal'),adoption:'as_proposed' as const}}:null;
        if(plan)state.workspace.plan=plan;
        result={accepted_proposal:accepted,draft:state.workspace.draft,plan};state.adoptionResults.set(body.adoption_request_id,result);
      }
      if(state.dropAdoptionOnce){state.dropAdoptionOnce=false;return route.abort('connectionreset');}return reply(route,200,result);
    }
    if(path.endsWith('/review-executions')){
      const body=request.postDataJSON() as ReviewExecutionRequest;expect(Value.Check(ReviewExecutionRequestSchema,body)).toBe(true);state.executes.push(body);
      let run=state.runs.get(body.execution_request_id);
      if(!run){if(state.workspace.active_run)return reply(route,409,{code:'ACTIVE_RUN_CONFLICT'});run=state.makeRun(`run-${state.runs.size+1}`,'queued',body.execution_request_id);state.runs.set(body.execution_request_id,run);state.workspace.active_run=run;state.history.push({run,operation:body.operation,version:state.history.length+1,source_report_id:body.source_report_id,report_id:null,input:structuredClone(state.workspace.draft),input_revision:state.workspace.draft.version,finding_ids:body.finding_ids,plan:structuredClone(state.workspace.plan),artifacts:[],created_at:'2026-10-02T11:00:00Z'});}
      if(state.linked){const history=state.history.find(item=>item.run.run_id===run!.run_id);if(history)history.origin={version:'review-execution-origin-v1',entrypoint:body.entrypoint??'quick_action',accepted_proposal:state.workspace.accepted_proposals?.find(item=>item.acceptance_id===body.accepted_proposal_id)??null,context_report_ref:body.context_report_ref??null};}
      if(state.dropExecutionOnce){state.dropExecutionOnce=false;return route.abort('connectionreset');}
      return reply(route,202,run);
    }
    if(path.startsWith('/runs/')){
      const run=[...state.runs.values()].find(r=>path.includes(`/${r.run_id}`));if(!run)return reply(route,404,{code:'NOT_FOUND'});
      if(path.endsWith('/cancel')){
        if(state.deferCancellation){run.event_cursor=(run.event_cursor??0)+1;state.events.set(run.run_id,[...(state.events.get(run.run_id)??[]),{event_id:`stop-request-${run.event_cursor}`,schema_version:1,trace_id:'trace',run_id:run.run_id,seq:run.event_cursor,occurred_at:now,stage:run.stage,type:'run.progress',state:run.state,payload:{reason:'user_cancel_requested'}}]);}
        else{run.state='cancelled';state.workspace.active_run=null;}
      }return reply(route,200,run);
    }
    const referencedMaterial=state.workspace.materials.find(material=>path===`/projects/${id}/materials/${material.material_id}`||path===`/projects/${id}/materials/${material.material_id}/download`);
    if(referencedMaterial&&method==='GET'){
      if(path.endsWith('/download')){state.materialDownloads.push(referencedMaterial.material_id);return route.fulfill({status:200,contentType:referencedMaterial.media_type,body:referencedMaterial.role});}
      state.materialReads.push(referencedMaterial.material_id);return reply(route,200,referencedMaterial);
    }
    if(path.endsWith('/materials/uploads')){
      const body=request.postDataJSON() as Dto<'UploadCreateRequest'>;state.uploads.push(body);
      const uploadId='upload-evidence'+(state.uploads.length===1?'':'-'+state.uploads.length);
      return reply(route,201,{upload_id:uploadId,state:'uploading',upload_url:'/api/v1/synthetic-upload/'+uploadId,expires_at:'2027-01-01T00:00:00Z',max_bytes:104857600});
    }
    if(path.startsWith('/synthetic-upload/')){state.uploadBytes++;await state.uploadGates.bytes?.(path.split('/').at(-1)!);return route.fulfill({status:204});}
    if(/\/upload-evidence(?:-\d+)?\/complete$/.test(path)){
      const uploadId=path.split('/').at(-2)!,index=Number(uploadId.match(/-(\d+)$/)?.[1]??1)-1;
      await state.uploadGates.complete?.(uploadId);
      const materialId='evidence-new'+(index?'-'+(index+1):'');
      const upload=state.uploads[index];let material=state.workspace.materials.find(m=>m.material_id===materialId);
      if(!material){material={...upload,material_id:materialId,material_version:1,upload_id:uploadId,state:'persisted',persisted_at:now,error:null};state.workspace.materials.push(material);}
      if(state.dropUploadOnce){state.dropUploadOnce=false;return route.abort('connectionreset');}return reply(route,200,material);
    }
    if(path.startsWith('/artifacts/')&&!path.endsWith('/download')){state.artifactReads.push(path);const artifact=state.artifacts.get(path.split('/').at(-1)!);if(artifact)return reply(route,200,artifact);}
    if(path==='/artifacts/artifact-1')return reply(route,200,{artifact_id:'artifact-1',run_id:'run-1',version:1,media_type:mime,sha256:hash('synthetic verified bytes'),quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/artifact-1/download',expires_at:'2027-01-01T00:00:00Z'});
    if(path==='/artifacts/artifact-1/download')return route.fulfill({status:200,contentType:mime,body:'synthetic verified bytes'});
    return reply(route,404,{code:'NOT_FOUND'});
  });
  await page.goto(`/${routePath}`);return state;
}
const finding=(page:Page,id:string)=>page.locator(`details.review-finding[data-finding-id="${id}"]`);

test('report-update adoption is durable, retains exact report scope, and never executes on adoption',async({page})=>{
  const state=fixture(),intent='请依据这份报告修正现金流引用，保留历史名称。';
  await setup(page,state);await page.locator('#review-message-input').fill(intent);await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'将这条需求用于本报告更新',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'核对根据复核报告更新的需求',exact:true});await expect(dialog).toContainText('report-v1');await expect(dialog).toContainText('run-1');await expect(dialog).toContainText(state.workspace.draft.source_material_ref!.sha256);
  expect(state.plans).toHaveLength(0);await dialog.getByRole('button',{name:'采用为本报告更新要求',exact:true}).click();
  await expect(page.locator('.review-update-cta')).toContainText(intent);expect(state.workspace.plan?.source_report_id).toBe('report-v1');expect(state.workspace.plan?.requirements).toEqual([intent]);expect(state.workspace.plan?.finding_ids).toEqual([]);expect(state.executes).toHaveLength(0);
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('bb-review-update-notes:'))localStorage.removeItem(key);});await page.reload();
  await expect(page.locator('.review-update-cta')).toContainText(intent);await page.getByRole('button',{name:'将这条需求用于本报告更新',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'采用为本报告更新要求',exact:true}).click();
  expect(state.plans).toHaveLength(1);expect(state.executes).toHaveLength(0);
});

test('report-update adoption preserves an existing plan and does not overwrite another report plan',async({page})=>{
  const state=fixture();state.workspace.plan={plan_id:'existing-plan',version:2,source_report_id:'report-v1',finding_ids:['F01'],excluded_findings:[{finding_id:'F02',reason:'原范围保留待补证'}],requirements:['原已采用要求'],sha256:hash('plan'),accepted_at:now};
  await setup(page,state);await page.locator('#review-message-input').fill('新增更新口径');await page.getByRole('button',{name:'核对本报告更新',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'采用为本报告更新要求',exact:true}).click();
  expect(state.workspace.plan!.finding_ids).toEqual(['F01']);expect(state.workspace.plan!.excluded_findings).toEqual([{finding_id:'F02',reason:'原范围保留待补证'}]);await expect.poll(()=>state.workspace.plan!.requirements).toEqual(['原已采用要求','新增更新口径']);expect(state.executes).toHaveLength(0);
  state.workspace.plan!.source_report_id='another-report';await page.reload();await page.locator('#review-message-input').fill('再新增口径');await page.getByRole('button',{name:'核对本报告更新',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'采用为本报告更新要求',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('另一份报告已有已保存修订计划');expect(state.plans).toHaveLength(1);expect(state.workspace.plan!.source_report_id).toBe('another-report');
});

for(const mode of ['valid','stale','foreign','missing','binding_failed'] as const)test(`explicit cross-business review preparation keeps exact intent and authorized source: ${mode}`,async({page})=>{
  const state=fixture(),intent='请复核这份募集书并关注金额口径',bytes='Synthetic handoff DOCX',source={source_project_id:'origin-project',material_id:'origin-material',material_version:3,sha256:hash(bytes)};
  await setup(page,state);const sourceMessage={message_id:'origin-message',version:2,role:'user',content:intent,context:{source_material:mode==='missing'?null:source}};
  await page.route('**/api/v1/m4/topics/origin-topic/workspace',route=>mode==='foreign'?reply(route,404,{code:'NOT_FOUND'}):reply(route,200,{topic:{topic_id:'origin-topic',project_id:'origin-topic-project',source_project_id:'origin-project'},project:{project_id:'origin-topic-project'},tasks:[],artifacts:[],messages:[sourceMessage]}));
  await page.route('**/api/v1/projects/origin-project/materials/origin-material',route=>reply(route,200,{...state.workspace.materials[0],material_id:source.material_id,material_version:mode==='stale'?4:source.material_version,sha256:source.sha256,byte_size:Buffer.byteLength(bytes)}));
  await page.route('**/api/v1/projects/origin-project/materials/origin-material/download',route=>route.fulfill({status:200,contentType:mime,body:bytes}));
  let bindings=0;await page.route('**/api/v1/m4/topics/origin-topic/handoffs/bind',route=>{bindings++;const b=route.request().postDataJSON();expect(b).toEqual({message_id:'origin-message',message_version:2,target_project_id:id,source_material:source});return mode==='binding_failed'?reply(route,409,{code:'ACTIVE_RUN_CONFLICT'}):reply(route,200,{binding:{topic_id:'origin-topic',...b,execution_scope_project_id:'canonical-origin'}});});
  await page.route(`**/api/v1/projects/${id}/events*`,route=>reply(route,200,{items:state.workspace.materials.filter(m=>m.material_id.startsWith('evidence-new')).map((m,i)=>({type:'material.upload_progress',seq:i+1,payload:{material_id:m.material_id}})),next_cursor:null}));
  await page.goto(`/#/projects/${id}/review?tab=materials&handoff_topic=origin-topic&handoff_message=origin-message`);
  const panel=page.locator('#business-handoff');
  if(mode==='foreign'){await expect(panel).toContainText('带入需求暂不可读取');expect(state.uploads).toHaveLength(0);return;}
  await expect(panel).toContainText(intent);expect(state.uploads).toHaveLength(0);expect(state.executes).toHaveLength(0);
  if(mode==='missing')await expect(panel).toContainText('尚未固定募集书来源');else await expect(panel).toContainText(source.sha256);
  await panel.getByRole('button').click();
  if(mode==='stale'||mode==='binding_failed'){await expect(panel).toContainText('原始需求与准确来源保留');expect(state.uploads).toHaveLength(0);expect(state.workspace.draft.requirements).not.toContain(intent);expect(state.executes).toHaveLength(0);return;}
  await expect.poll(()=>state.workspace.draft.requirements.includes(intent)).toBe(true);expect(state.executes).toHaveLength(0);
  if(mode==='valid'){expect(state.uploads).toHaveLength(1);expect(state.workspace.draft.source_material_ref?.sha256).toBe(source.sha256);}
  else expect(state.uploads).toHaveLength(0);
  expect(bindings).toBe(mode==='valid'?1:0);
  await page.reload();await expect(panel).toContainText(intent);await expect(page.locator('.review-optional-requirements')).toContainText(intent);await panel.getByRole('button').click();await expect(panel).toContainText('尚未执行');
  expect(state.workspace.draft.requirements.filter(r=>r===intent)).toHaveLength(1);expect(state.uploads).toHaveLength(mode==='valid'?1:0);expect(state.executes).toHaveLength(0);
});
async function openFinding(page:Page,id:string){const card=finding(page,id);if(!await card.getAttribute('open').then(v=>v!==null))await card.locator('summary').click();return card;}

for(const routePath of [`#/projects/${id}`,`#/projects/${id}/review?tab=materials`])test(`new review project opens categorized materials with the always-on assistant: ${routePath}`,async({page})=>{
  const state=fixture();
  state.workspace.materials=[];
  state.workspace.draft={version:1,source_material_ref:null,material_versions:[],requirements:[],as_of:null,evidence_links:[]};
  state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.plan=null;state.workspace.artifacts=[];
  state.history.length=0;state.runs.clear();
  await setup(page,state,routePath);
  await expect(page.getByRole('heading',{name:'合成募集书复核项目',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'项目暂时无法读取',exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'材料与要求',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('heading',{name:'提供复核材料',exact:true})).toBeVisible();
  await expect(page.locator('[data-review-upload-role="historical"]')).toHaveCount(1);
  await expect(page.locator('#review-requirements')).toHaveCount(0);await expect(page.locator('#review-agent')).toBeVisible();
  await expect(page.locator('#review-agent')).toBeVisible();
  await page.getByRole('tab',{name:'复核结果',exact:true}).click();
  await expect(page.getByRole('heading',{name:'还没有复核报告',exact:true})).toBeVisible();
  await expect(page.locator('#review-status')).not.toContainText('状态暂未更新');
  await page.reload();
  await expect(page.getByRole('heading',{name:'还没有复核报告',exact:true})).toBeVisible();
  expect(state.requests).toHaveLength(0);expect(state.executes).toHaveLength(0);expect(state.uploads).toHaveLength(0);expect(state.plans).toHaveLength(0);
});

test('review summary, counted filters and downloads stay ahead of findings',async({page})=>{
  const state=fixture(),report=state.workspace.selected_report!;
  report.findings.push({...structuredClone(report.findings[0]),finding_id:'F03',dimension:'compliance',severity:'P3',title:'标题样式需要统一'});
  await setup(page,state);
  await expect(page.locator('#review-tab-materials .review-tab-count')).toHaveText('2');await expect(page.locator('#review-tab-results .review-tab-count')).toHaveText('3');
  const results=page.locator('#review-results-panel');await expect(results.locator(':scope > :first-child')).toHaveClass('review-result-hero');
  await expect(page.locator('.review-run-details')).not.toHaveAttribute('open','');
  await expect(page.locator('.review-run-details').getByText('run-1',{exact:true})).toBeHidden();
  await expect(page.locator('.review-findings-heading .review-result-actions')).toBeVisible();await expect(results.getByRole('heading',{name:'复核成果',exact:true})).toHaveCount(0);
  expect(await page.locator('.review-result-actions').evaluate(node=>Boolean(node.compareDocumentPosition(document.querySelector('.review-findings')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  expect(await results.locator('.review-footer-actions').evaluate(node=>Boolean(node.compareDocumentPosition(document.querySelector('.review-run-details')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const chips=page.getByRole('group',{name:'筛选复核发现'});
  await expect(chips.locator('[data-review-filter-value="all"]')).toHaveText('全部3');await expect(chips.locator('[data-review-filter-value="priority"]')).toHaveText('优先关注2');
  await chips.locator('[data-review-filter-value="priority"]').click();await expect(finding(page,'F01')).toBeVisible();await expect(finding(page,'F02')).toBeVisible();await expect(finding(page,'F03')).toHaveCount(0);
  await chips.locator('[data-review-filter-value="compliance"]').click();await expect(finding(page,'F03')).toBeVisible();await expect(finding(page,'F01')).toHaveCount(0);
  await page.getByLabel('结论',{exact:true}).selectOption('needs_evidence');await expect(chips.locator('[data-review-filter-value="all"]')).toHaveText('全部1');await expect(page.locator('.review-findings')).toContainText('当前筛选没有发现');
  await chips.locator('[data-review-filter-value="all"]').click();await expect(finding(page,'F02')).toBeVisible();
  expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
});



test('source controls show the pinned excerpt and download only the exact material version',async({page})=>{
  const state=fixture(),findingRecord=state.workspace.selected_report!.findings[0],first=findingRecord.target_refs[0];
  findingRecord.target_refs.push({...structuredClone(first),quote:'同段另一条引用 <img src=x onerror=alert(1)>'});findingRecord.evidence_refs.push(structuredClone(first));
  state.workspace.materials.forEach(material=>material.byte_size=Buffer.byteLength(material.role));await setup(page,state);
  const card=await openFinding(page,'F01');await card.getByRole('button',{name:'合成募集书.docx · V1 · 查看原文 ↗',exact:true}).first().click();
  let source=page.getByRole('dialog',{name:'依据定位',exact:true});await expect(source).toContainText('现金流 100');await expect(source).toContainText('段落：10');await expect(source).toContainText('合成募集书.docx · V1');await expect(source).toContainText('同段另一条引用 <img src=x onerror=alert(1)>');await expect(source.locator('blockquote')).toHaveCount(2);await expect(source.locator('img')).toHaveCount(0);expect(state.materialReads).toHaveLength(0);
  const download=page.waitForEvent('download');await source.getByRole('button',{name:'下载原材料',exact:true}).click();expect((await download).suggestedFilename()).toBe('合成募集书.docx');expect(state.materialReads).toEqual(['material-0']);expect(state.materialDownloads).toEqual(['material-0']);
  await source.getByRole('button',{name:'返回',exact:true}).click();await card.getByRole('button',{name:'查看解释',exact:true}).click();await page.getByRole('dialog',{name:'问题解释',exact:true}).getByRole('button',{name:'合成审计报告.docx · V1 · 查看原文 ↗',exact:true}).click();
  source=page.getByRole('dialog',{name:'依据定位',exact:true});await expect(source).toContainText('现金流 120');await expect(source).toContainText('段落：11');
  state.workspace.materials[1].material_version=2;await source.getByRole('button',{name:'下载原材料',exact:true}).click();await expect(source.locator('#review-dialog-status')).not.toBeEmpty();expect(state.materialReads).toEqual(['material-0','material-1']);expect(state.materialDownloads).toEqual(['material-0']);
  expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
});

function revisionFixture(){
  const state=fixture(),report=state.workspace.selected_report!;
  const handling:ReviewRevisionHandling={version:'review-revision-handling-v1',source_report:{report_id:report.report_id,run_id:report.run_id,version:1,input_revision:1,sha256:hash('report')},source_material:report.source_material,accepted_plan:{plan_id:'plan-1',version:1,sha256:hash('plan'),accepted_at:now},review_passed:false,limitations:['公开信息未重新核验，需另行明确复核。'],items:[
    {finding_id:'F01',report_id:report.report_id,status:'modified',reason:'金额已按同口径审计依据改为 120。',locations:[{record_id:'record-0',locator:{paragraph:10}}],evidence_refs:['audit-record-1'],review_passed:false},
    {finding_id:'F02',report_id:report.report_id,status:'needs_evidence',reason:'缺少更名生效日期依据，历史名称暂保留。',locations:[{record_id:'record-2',locator:{paragraph:20}}],evidence_refs:[],review_passed:false},
    {finding_id:'F03',report_id:report.report_id,status:'not_modified',reason:'用户未选择此项，保留原标题。',locations:[],evidence_refs:[],review_passed:false},
  ]};
  const artifact={artifact_id:'revision-2',artifact_version:1,kind:'revision' as const,filename:'合成修订稿.docx'};
  const metadata:Dto<'ArtifactResponse'>={artifact_id:artifact.artifact_id,run_id:'revision-run-2',version:1,media_type:mime,sha256:hash('synthetic revision'),quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/revision-2/download',expires_at:'2027-01-01T00:00:00Z',word_delivery:{variant:'revision',revision_artifact_id:artifact.artifact_id,clean_artifact_id:'clean-2',baseline_artifact_id:'baseline-2',writer_version:'bondbuddy-word-delivery-1.0.0',source_sha256:report.source_material.sha256,baseline_hash:hash('baseline'),effective_baseline_sha256:hash('baseline'),plan_hash:handling.accepted_plan.sha256,replacements:1,columns:1,pending_review_count:2,pending_review:[],revision_handling:handling,review_passed:false}};
  state.workspace.artifacts=[artifact];state.workspace.artifact_run={run_id:metadata.run_id,version:2,operation:'revision',source_report_id:report.report_id};
  const entry:ReviewHistoryEntry={...structuredClone(state.history[0]),run:{...state.makeRun(metadata.run_id,'succeeded'),artifact_id:artifact.artifact_id},version:2,operation:'revision',source_report_id:report.report_id,report_id:null,artifacts:[artifact],created_at:'2026-10-02T11:00:00Z'};
  state.history.push(entry);state.artifacts.set(artifact.artifact_id,metadata);
  return {state,metadata,handling,entry};
}

test('revision results expose handling reasons and locations without chat or execution',async({page})=>{
  const {state}=revisionFixture();await setup(page,state);await expect(page.getByRole('button',{name:'处理清单',exact:true})).toBeVisible();expect(state.artifactReads).toHaveLength(0);
  await page.getByRole('button',{name:'处理清单',exact:true}).click();const dialog=page.getByRole('dialog',{name:'修订处理清单'});
  await expect(dialog).toContainText('执行版本 V2 · revision-run-2');await expect(dialog).toContainText('来源报告：report-v1 · V1');await expect(dialog).toContainText('已修改 1 项 · 未修改 1 项 · 待补证 1 项');
  await expect(dialog.locator('[data-handling-finding="F02"]')).toContainText('缺少更名生效日期依据');await expect(dialog.locator('[data-handling-finding="F03"]')).toContainText('用户未选择此项');await expect(dialog).toContainText('段落：10');await expect(dialog).toContainText('已修改不代表复核通过');await expect(dialog).toContainText('公开信息未重新核验');
  expect(state.artifactReads).toEqual(['/artifacts/revision-2']);expect(state.requests).toHaveLength(0);expect(state.executes).toHaveLength(0);
  await mkdir('test-evidence/m3-agent-progress-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-evidence/m3-agent-progress-review/handling-desktop.png'});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-evidence/m3-agent-progress-review/handling-narrow.png'});
});

test('workbench handling reads the exact historical revision and returns to its history',async({page})=>{
  const {state,handling,entry}=revisionFixture();handling.source_report.report_id='report-older';handling.items.forEach(item=>item.report_id='report-older');entry.source_report_id='report-older';
  await setup(page,state,'#dashboard');await page.getByRole('button',{name:'版本记录',exact:true}).click();const history=page.getByRole('dialog',{name:'合成募集书复核项目 · 版本记录'});const revision=history.locator('.review-history-entry').filter({hasText:'revision-run-2'});await expect(revision).toContainText('来源报告 report-older');await expect(revision.getByRole('link',{name:'打开来源报告'})).toHaveAttribute('href',/report_id=report-older/);
  await revision.getByRole('button',{name:'处理清单',exact:true}).click();const detail=page.getByRole('dialog',{name:'修订处理清单'});await expect(detail).toContainText('来源报告：report-older · V1');await expect(detail).toContainText('用户未选择此项');expect(state.artifactReads).toEqual(['/artifacts/revision-2']);await detail.getByRole('button',{name:'返回',exact:true}).click();await expect(history).toBeVisible();await expect(history.locator('.review-history-entry')).toHaveCount(2);
});

test('handling remains unavailable on missing metadata, stale artifact association or invalid status and can retry',async({page})=>{
  const {state,metadata,handling}=revisionFixture();delete metadata.word_delivery!.revision_handling;await setup(page,state);await page.getByRole('button',{name:'处理清单',exact:true}).click();const detail=page.getByRole('dialog',{name:'修订处理清单'});await expect(detail.getByRole('alert')).toContainText('尚未提供处理清单');await expect(detail.locator('.review-handling-item')).toHaveCount(0);
  metadata.word_delivery!.revision_handling=handling;metadata.run_id='other-run';await detail.getByRole('button',{name:'重试读取处理清单'}).click();await expect(detail.getByRole('alert')).toContainText('来源版本不一致');await expect(detail.locator('.review-handling-item')).toHaveCount(0);
  metadata.run_id='revision-run-2';Object.assign(handling.items[0],{review_passed:true});await detail.getByRole('button',{name:'重试读取处理清单'}).click();await expect(detail.getByRole('alert')).toContainText('来源版本不一致');await expect(detail.locator('.review-handling-item')).toHaveCount(0);
  handling.items[0].review_passed=false;await detail.getByRole('button',{name:'重试读取处理清单'}).click();await expect(detail.locator('.review-handling-item')).toHaveCount(3);expect(state.executes).toHaveLength(0);
});

test('result buttons explain, download, plan and explicitly execute without chat; active run and empty plan are guarded',async({page})=>{
  const state=await setup(page);await expect(page.locator('#review-agent')).toBeVisible();await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('#review-credit-receipt')).toContainText('未扣积分');
  const card=await openFinding(page,'F01');await card.getByRole('button',{name:'查看解释'}).click();await expect(page.getByRole('dialog')).toContainText('现金流 120');expect(state.requests).toHaveLength(0);await page.getByRole('button',{name:'返回',exact:true}).click();
  await page.getByRole('button',{name:'核对修订计划'}).click();await page.getByRole('button',{name:'确认范围并执行修订'}).click();await expect(page.getByRole('dialog')).toContainText('请选择至少一项');expect(state.executes).toHaveLength(0);await page.getByRole('button',{name:'返回',exact:true}).click();
  await card.getByLabel('加入修订').check();await expect.poll(()=>state.workspace.plan?.finding_ids).toEqual(['F01']);await expect(card).toHaveAttribute('open','');
  await page.getByRole('button',{name:'核对修订计划'}).click();await expect(page.getByRole('dialog')).toContainText('固定输入');await expect(page.getByRole('dialog')).toContainText('合成募集书.docx · V1');await expect(page.getByRole('dialog')).toContainText('核对财务摘要引用。');expect(state.executes).toHaveLength(0);
  state.dropExecutionOnce=true;await page.getByRole('button',{name:'确认范围并执行修订',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('重试沿用同一请求');await expect(page.getByRole('dialog')).not.toContainText('确认本次执行范围');await expect(page.locator('[data-plan-finding="F01"]')).toBeDisabled();const savedPlans=state.plans.length;await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('不能改变已确认范围');expect(state.plans).toHaveLength(savedPlans);await page.getByRole('button',{name:'确认范围并执行修订',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(state.plans).toHaveLength(savedPlans);
  expect(state.executes).toHaveLength(2);expect(state.executes[0].execution_request_id).toBe(state.executes[1].execution_request_id);expect(state.runs.size).toBe(2);expect(state.requests).toHaveLength(0);
  await expect(page.getByRole('button',{name:'再次完整复核'})).toBeDisabled();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载问题报告'}).click();expect((await download).suggestedFilename()).toBe('合成问题报告.docx');
  await page.locator('#review-progress-bar').getByRole('button',{name:'停止本次任务'}).click();await expect(page.locator('.review-run')).toContainText('已停止');
  await page.getByRole('button',{name:'再次完整复核'}).click();state.dropExecutionOnce=true;await page.getByRole('button',{name:'开始复核',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(3);await expect(page.getByRole('dialog')).toContainText('重试沿用同一请求');expect(state.executes[2].execution_request_id).not.toBe(state.executes[0].execution_request_id);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.locator('#review-progress-bar')).toContainText('等待开始');expect(state.executes).toHaveLength(3);
});



test('direct report links without a valid explicit tab open results',async({page})=>{
  const state=fixture();await setup(page,state,`#/projects/${id}/review?report_id=report-v1`);
  await expect(page.getByRole('tab',{name:'复核结果',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('#review-results-panel')).toBeVisible();await expect(page.locator('#review-materials-panel')).toBeHidden();
  await page.goto(`/#/projects/${id}/review?tab=unknown&report_id=report-v1`);
  await expect(page.getByRole('tab',{name:'复核结果',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('#review-results-panel')).toBeVisible();await expect(page.locator('#review-materials-panel')).toBeHidden();
  expect(state.requests).toHaveLength(0);expect(state.executes).toHaveLength(0);
});



test('input conflicts display both versions and require explicit adoption; foreign owners cannot recover another project draft',async({page})=>{
  const state=fixture();state.workspace.materials.push({...state.workspace.materials[0],material_id:'alternate-source',filename:'合成另稿.docx'});await setup(page,state);await page.getByRole('tab',{name:'材料与要求'}).click();state.workspace.draft={...state.workspace.draft,version:2,requirements:['另一页面保存的服务器要求']};
  await page.locator('#review-source').selectOption('alternate-source');await expect(page.locator('#review-materials-panel')).toContainText('其他页面已修改材料与要求');expect(state.workspace.draft.requirements).toEqual(['另一页面保存的服务器要求']);
  await page.getByRole('button',{name:'核对本页内容'}).click();await expect(page.getByRole('dialog')).toContainText('另一页面保存的服务器要求');await expect(page.getByRole('dialog')).toContainText('alternate-source');expect(state.workspace.draft.version).toBe(2);await page.getByRole('button',{name:'将本页内容保存为新版'}).click();await expect.poll(()=>state.workspace.draft.version).toBe(3);expect(state.executes).toHaveLength(0);
  state.failDrafts=true;await page.locator('#review-message-input').fill('仅 owner-a 可见的草稿');state.owner='owner-b';await page.reload();await expect(page.getByRole('heading',{name:'项目暂时无法读取'})).toBeVisible();await expect(page.locator('body')).not.toContainText('仅 owner-a 可见的草稿');
});

test('differential report labels carried-forward findings and all-projects history remains reachable',async({page})=>{
  const state=fixture(),report=state.workspace.selected_report!;report.report_id='report-v2';report.version=2;report.scope={mode:'differential_review',finding_ids:['F01']};
  report.findings=report.findings.map(f=>({...f,report_id:'report-v2',origin_report_id:f.finding_id==='F01'?'report-v2':'report-v1',check_status:f.finding_id==='F01'?'rechecked':'carried_forward'}));report.coverage=report.coverage.map(c=>({...c,origin_report_id:c.dimension==='financial'?'report-v2':'report-v1',check_status:c.dimension==='financial'?'rechecked':'carried_forward'}));
  await setup(page,state);await expect(page.locator('.review-result-hero')).toContainText('差异复核完成');await expect(finding(page,'F02')).toContainText('沿用先前结果（沿用 R1）');await expect(finding(page,'F01')).toContainText('本轮核验');
  await page.goto('/#tasks?kind=review');await page.getByRole('button',{name:'版本记录',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('V1 · 完整三维复核');
});

test('latest revision downloads identify their execution and retain the source report findings',async({page})=>{
  const state=fixture();state.workspace.artifact_run={run_id:'revision-run-2',version:2,operation:'revision',source_report_id:'report-v1'};
  state.workspace.artifacts=[{artifact_id:'revision-doc',artifact_version:1,kind:'revision',filename:'synthetic-revision.docx'},{artifact_id:'clean-doc',artifact_version:1,kind:'clean',filename:'synthetic-clean.docx'}];
  await setup(page,state);await expect(page.getByRole('heading',{name:'执行版本 V2 · 按已选问题修订成果'})).toBeVisible();await expect(page.locator('#review-results-panel')).toContainText('是否通过需要再次明确复核');await expect(page.getByRole('button',{name:'下载修订版'})).toBeVisible();await expect(page.getByRole('button',{name:'下载清洁版'})).toBeVisible();await expect(finding(page,'F01')).toContainText('明确错误');expect(state.executes).toHaveLength(0);
});

test('evidence upload retries the same session and pins original finding; differential execution stays explicit',async({page})=>{
  const state=await setup(page);state.dropUploadOnce=true;await (await openFinding(page,'F02')).getByRole('button',{name:'补充材料',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('report-v1 · F02');
  await page.getByLabel('选择 DOCX／PDF／XLSX／CSV／TXT 或图片').setInputFiles({name:'更名证明.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic name change evidence')});await page.getByRole('button',{name:'上传并保存'}).click();await expect(page.getByRole('dialog')).toContainText('可以重试原上传确认保存状态');
  await page.getByRole('button',{name:'上传并保存'}).click();await expect(page.getByRole('dialog')).toContainText('材料已补充，核对下一步');expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.workspace.draft.evidence_links).toEqual([{report_id:'report-v1',finding_id:'F02',material_ref:{material_id:'evidence-new',material_version:1,sha256:hash('Synthetic name change evidence')}}]);expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
  await page.getByRole('button',{name:'核对并重新核验'}).click();await expect(page.getByRole('dialog')).toContainText('差异复核');await page.getByRole('button',{name:'开始复核',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(1);expect(state.executes[0]).toMatchObject({operation:'differential_review',source_report_id:'report-v1',finding_ids:['F02']});
});

function addTypedProposal(state:ReturnType<typeof fixture>,operation:ReviewProposalV2['operation']='differential_review'){
  state.linked=true;
  const proposal:ReviewProposalV2={version:'review-proposal-v2',proposal_id:'typed-proposal',project_id:id,operation,source_report_id:operation==='full_review'?null:'report-v1',source_report_sha256:operation==='full_review'?null:hash('report'),context_report_ref:{report_id:'report-v1',sha256:hash('report')},input_version:1,input_sha256:hash('input'),source_material_ref:state.workspace.draft.source_material_ref,material_versions:state.workspace.draft.material_versions,finding_ids:operation==='full_review'?[]:['F02'],related_finding_ids:[],excluded_findings:[],requirements:['采用补充材料核对历史名称，保留未重核事项。'],explanation:'合成提议：根据补充证据明确核验范围。'};
  state.workspace.messages.push({message_id:'typed-reply',role:'assistant',content:'这是合成回复，先确认范围才执行。',context:{project_id:id,report_id:'report-v1',finding_ids:['F02'],material_refs:[]},created_at:'2026-10-02T10:30:00Z',reply_status:'completed',reply_to:null,proposal,error:null,reply_metadata:{version:'review-reply-metadata-v1',context_report_ref:{report_id:'report-v1',sha256:hash('report')},cited_finding_ids:['F02']}});
  return proposal;
}

















test('workbench alone owns version history and retains stopped/failed snapshots and exact report navigation',async({page})=>{
  const state=fixture();for(const [index,status]of(['failed','cancelled'] as const).entries())state.history.push({...structuredClone(state.history[0]),version:index+2,run:state.makeRun(`run-${index+2}`,status),report_id:null,input:{...structuredClone(state.workspace.draft),requirements:[`保留的${status}版本要求`]},created_at:`2026-10-02T1${index+1}:00:00Z`});
  await setup(page,state,'#dashboard');await expect(page.locator('.review-project-card')).toBeVisible();await page.getByRole('button',{name:'版本记录',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.locator('.review-history-entry')).toHaveCount(3);await expect(dialog).toContainText('已停止');await expect(dialog).toContainText('处理失败');await dialog.getByText('查看本轮输入与处理范围',{exact:true}).first().click();await expect(dialog).toContainText('保留的cancelled版本要求');
  await mkdir('test-evidence/m3-agent-progress-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-evidence/m3-agent-progress-review/history-desktop.png'});
  await dialog.getByRole('link',{name:'打开此版报告'}).click();await expect(page).toHaveURL(/report_id=report-v1/);await expect(page.getByRole('tab')).toHaveCount(3);await expect(page.locator('#review-workspace').getByRole('button',{name:'版本记录',exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await expect(page.locator('.sidebar a.active')).toContainText('全部项目');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});



test('paused recheck retains the report without claiming its findings are currently being processed',async({page})=>{
  const state=fixture();state.linked=true;
  const run={...state.makeRun('paused-recheck','paused'),stage:'trial_limit',event_cursor:1};
  state.workspace.active_run=run;state.runs.set('paused',run);
  state.history.push({...structuredClone(state.history[0]),run,operation:'differential_review',version:2,report_id:null,source_report_id:'report-v1',finding_ids:['F01'],artifacts:[],created_at:'2026-10-02T11:00:00Z'});
  state.events.set(run.run_id,[{event_id:'pause',schema_version:1,trace_id:'trace',run_id:run.run_id,seq:1,occurred_at:now,stage:'trial_limit',type:'run.state_changed',state:'paused',payload:{reason:'kill_switch',error_code:'MODEL_CALLS_SUSPENDED'}}]);
  await setup(page,state);
  await expect(page.locator('.review-result-hero')).toContainText('R1');
  await expect(page.locator('.review-run')).toContainText('复核服务暂时停用');
  await expect(finding(page,'F01')).not.toContainText('正在重新核验');
  await expect(page.getByRole('button',{name:'再次完整复核',exact:true})).toBeDisabled();
  expect(state.executes).toHaveLength(0);
});

for(const viewport of [{width:1360,height:900},{width:581,height:753}])test(`file-only report downloads without structured findings ${viewport.width}`,async({page})=>{
  await page.setViewportSize(viewport);
  const state=fixture();state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.plan=null;
  state.workspace.artifact_run={run_id:'run-1',version:1,operation:'full_review',source_report_id:null};
  state.history[0].report_id=null;
  await setup(page,state);
  await expect(page.getByRole('heading',{name:'复核报告已生成'})).toBeVisible();
  await expect(page.locator('.review-findings')).toHaveCount(0);
  await expect(page.locator('.review-filters')).toHaveCount(0);
  const button=page.getByRole('button',{name:'下载复核报告（Word）'});
  await expect(button).toBeVisible();
  const download=page.waitForEvent('download');await button.click();
  expect((await download).suggestedFilename()).toBe('合成问题报告.docx');
  await page.reload();await expect(button).toBeVisible();
  const output=process.env.BB_REVIEW_FILE_SCREENSHOTS;
  if(output){await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/review-file-${viewport.width}.png`,fullPage:true});}
});

for(const viewport of [{width:1360,height:900},{width:581,height:753}])test(`readable report navigation, findings, search and persistent downloads ${viewport.width}`,async({page})=>{
  await page.setViewportSize(viewport);
  const state=fixture();state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.plan=null;
  state.workspace.artifact_run={run_id:'run-1',version:1,operation:'full_review',source_report_id:null};state.history[0].report_id=null;
  await setup(page,state);
  await expect(page.getByRole('navigation',{name:'三个复核维度'})).toBeVisible();
  await expect(page.locator('.readable-body')).toContainText('财务差异需要优先核对');
  await page.locator('[data-readable-section]').filter({hasText:'财务核对'}).click();
  await expect(page.locator('details.readable-item')).toHaveCount(2);
  await page.locator('details.readable-item summary').first().click();
  await expect(page.locator('.readable-body table')).toBeVisible();
  await expect(page.locator('.readable-body')).toContainText('第八章，经营现金流表');
  await expect(page.locator('.readable-body')).toContainText('确认口径后统一金额');
  await page.getByRole('button',{name:'展开全部事项',exact:true}).click();
  await expect(page.locator('details.readable-item[open]')).toHaveCount(2);
  await expect(page.locator('[data-readable-report]')).not.toContainText('input.json');
  await expect(page.locator('[data-readable-report]')).not.toContainText('SHA-256');
  await expect(page.locator('[data-readable-section]')).toHaveCount(3);
  const output=process.env.BB_READABLE_SCREENSHOTS;
  if(output){await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/implementation-${viewport.width}.png`,fullPage:true});}
  await page.getByRole('searchbox').fill('名称变更');
  await expect(page.locator('.readable-body')).toContainText('缺少名称变更日期依据');
  await expect(page.locator('.readable-body')).not.toContainText('现金流金额与审计报告不一致');
  await page.getByRole('searchbox').fill('不存在的关键词');await expect(page.locator('.readable-body')).toContainText('没有找到匹配内容');
  await page.locator('[data-readable-section]').filter({hasText:'公开信息核验'}).click();
  await expect(page.locator('.readable-body')).toContainText('公开信息核验未执行');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载复核报告（Word）'}).click();await download;
  await page.reload();await expect(page.getByRole('navigation',{name:'三个复核维度'})).toBeVisible();
  expect(state.executes).toHaveLength(0);
});

test('readable view failure is retryable, preserves Word, and never re-executes review',async({page})=>{
  const state=fixture();state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.plan=null;
  state.workspace.artifact_run={run_id:'run-1',version:1,operation:'full_review',source_report_id:null};state.history[0].report_id=null;
  await setup(page,state);
  await page.route('**/readable-report',route=>reply(route,503,{code:'DATA_UNAVAILABLE'}));await page.reload();
  await expect(page.getByText('页面正文暂时无法读取，已生成的 Word 仍可下载。')).toBeVisible();
  await expect(page.getByRole('button',{name:'下载复核报告（Word）'})).toBeEnabled();
  await page.unroute('**/readable-report');await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'三个复核维度'})).toBeVisible();expect(state.executes).toHaveLength(0);
});

for(const viewport of [{width:1360,height:900},{width:390,height:844}])test(`unified review materials and discussion preserve assistant drafts ${viewport.width}`,async({page})=>{
 await page.setViewportSize(viewport);const state=await setup(page,fixture(),`#/projects/${id}/review?tab=materials&from=projects`);
 await expect(page.locator('.sidebar a.active')).toContainText('全部项目');
 await expect(page.locator('#review-agent')).toBeVisible();await expect(page.locator('.review-agent-fab')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'提供复核材料'})).toBeVisible();
 await page.getByRole('button',{name:'与助手讨论',exact:true}).click();await page.locator('#review-message-input').fill('请关注本期现金流。');
 await expect.poll(()=>state.workspace.message_drafts.some(d=>d.content==='请关注本期现金流。')).toBe(true);
 expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
 await page.reload();await expect(page.locator('#review-message-input')).toHaveValue('请关注本期现金流。');
 await page.getByRole('tab',{name:/复核结果/}).click();await expect(page.locator('.sidebar a.active')).toContainText('全部项目');
 await page.reload();await expect(page.locator('.sidebar a.active')).toContainText('全部项目');
 await page.getByRole('tab',{name:/材料与要求/}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const output=process.env.BB_WORKSPACE_SCREENSHOTS;if(output){await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/materials-${viewport.width}.png`,fullPage:true});}
});

test('direct upload retries saved bytes without a modal or duplicate upload',async({page})=>{
 const state=fixture();state.dropUploadOnce=true;
 await setup(page,state,`#/projects/${id}/review?tab=materials`);
 await page.locator('[data-review-upload-role="audit"]').setInputFiles({name:'synthetic-evidence.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic evidence')});
 await expect(page.getByRole('button',{name:'重试此文件'})).toBeVisible();expect(state.uploadBytes).toBe(1);
 await page.getByRole('button',{name:'重试此文件'}).click();await expect(page.getByRole('button',{name:'重试此文件'})).toHaveCount(0);
 expect(state.uploadBytes).toBe(1);expect(state.uploads).toHaveLength(1);expect(state.executes).toHaveLength(0);
 await expect.poll(()=>state.workspace.draft.material_versions.some(m=>m.material_id==='evidence-new')).toBe(true);
});

for(const width of [1360,390])test(`upload queue keeps other pickers usable through bytes, server save and draft save at ${width}`,async({page})=>{
 const state=fixture();
 const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
 const bytes=gate(),completion=gate(),draft=gate();
 state.uploadGates.bytes=async upload=>{if(upload==='upload-evidence')await bytes.promise;};
 state.uploadGates.complete=async upload=>{if(upload==='upload-evidence')await completion.promise;};
 state.uploadGates.draft=async input=>{if(input.material_versions.some(m=>m.material_id==='evidence-new'))await draft.promise;};
 await page.setViewportSize({width,height:width===390?844:900});
 await setup(page,state,`#/projects/${id}/review?tab=materials`);
 const first=page.locator('[data-review-drop="audit"] .material-file-row').filter({hasText:'synthetic-audit.txt'});
 const other=page.locator('[data-review-upload-role="other"]');
 const original=await other.elementHandle();
 const start=page.locator('#review-materials-panel .review-footer-actions [data-review-action="review"]');
 await page.locator('[data-review-upload-role="audit"]').setInputFiles({name:'synthetic-audit.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic audit evidence')});
 await expect.poll(()=>state.uploadBytes).toBe(1);
 await expect(start).toBeDisabled();await expect(other).toBeEnabled();
 const chooserPromise=page.waitForEvent('filechooser');
 await page.locator('label[for="review-upload-other"]').click();const chooser=await chooserPromise;
 bytes.release();await expect(first).toContainText('正在保存到服务器');
 expect(await original!.evaluate(el=>el.isConnected)).toBe(true);
 await chooser.setFiles({name:'synthetic-other.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic other evidence')});
 const second=page.locator('[data-review-drop="other"] .material-file-row').filter({hasText:'synthetic-other.txt'});
 await expect(second).toContainText('等待上传');expect(state.uploads).toHaveLength(1);
 await page.locator('#review-message-input').fill('本次补充要求保留。');
 completion.release();await expect(first).toContainText('正在保存材料选择');
 await expect(start).toBeDisabled();await expect(other).toBeEnabled();await expect(second).toContainText('等待上传');
 const output=process.env.BB_UPLOAD_EVIDENCE;
 if(output){await mkdir(output,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`${output}/implementation-uploading-${width}.png`,fullPage:true});if(width===1360)await writeFile(output+'/uploading-scene.json',JSON.stringify(await page.locator('#app').innerHTML()));}
 draft.release();
 await expect(first).toContainText('已保存');await expect(second).toContainText('已保存');await expect(start).toBeEnabled();
 expect(state.uploads).toHaveLength(2);expect(state.uploadBytes).toBe(2);
 expect(state.workspace.draft.material_versions.map(m=>m.material_id)).toEqual(['material-0','material-1','evidence-new','evidence-new-2']);
 expect(state.workspace.draft.requirements).toEqual(['核对财务摘要引用。']);
 expect(state.executes).toHaveLength(0);
 await page.reload();await expect(page.locator('#review-message-input')).toHaveValue('本次补充要求保留。');
 await expect(page.locator('[data-review-drop="other"]')).toContainText('synthetic-other.txt');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('one failed upload does not stop the queue and retry preserves its session',async({page})=>{
 const state=fixture();state.dropUploadOnce=true;
 await setup(page,state,`#/projects/${id}/review?tab=materials`);
 await page.locator('[data-review-upload-role="audit"]').setInputFiles([
  {name:'synthetic-first.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic first evidence')},
  {name:'synthetic-second.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic second evidence')}
 ]);
 const first=page.locator('[data-review-drop="audit"] .material-file-row').filter({hasText:'synthetic-first.txt'});
 const second=page.locator('[data-review-drop="audit"] .material-file-row').filter({hasText:'synthetic-second.txt'});
 await expect(first.getByRole('button',{name:'重试此文件'})).toBeVisible();
 await expect(second).toContainText('已保存');expect(state.uploadBytes).toBe(2);
 await expect(page.locator('#review-materials-panel .review-footer-actions [data-review-action="review"]')).toBeDisabled();
 await first.getByRole('button',{name:'重试此文件'}).click();
 await expect(page.getByRole('button',{name:'重试此文件'})).toHaveCount(0);
 expect(state.uploads).toHaveLength(2);expect(state.uploadBytes).toBe(2);
 await expect(page.locator('#review-materials-panel .review-footer-actions [data-review-action="review"]')).toBeEnabled();
 expect(state.workspace.draft.material_versions.filter(m=>m.material_id==='evidence-new')).toHaveLength(1);
});

test('draft-save retry continues saved material and invalid file can be removed',async({page})=>{
 const state=fixture();state.failDrafts=true;
 await setup(page,state,`#/projects/${id}/review?tab=materials`);
 await page.locator('[data-review-upload-role="other"]').setInputFiles({name:'synthetic-saved.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic saved evidence')});
 const row=page.locator('[data-review-drop="other"] .material-file-row').filter({hasText:'synthetic-saved.txt'});
 await expect(row).toContainText('材料选择尚未保存');await expect(row.getByRole('button',{name:'移除此行'})).toHaveCount(0);
 state.failDrafts=false;await row.getByRole('button',{name:'重试此文件'}).click();await expect(row).toContainText('已保存');
 expect(state.uploadBytes).toBe(1);expect(state.uploads).toHaveLength(1);
 await page.locator('[data-review-upload-role="other"]').setInputFiles({name:'synthetic-invalid.exe',mimeType:'application/octet-stream',buffer:Buffer.from('not executable')});
 await expect(page.locator('#review-materials-panel .review-footer-actions [data-review-action="review"]')).toBeDisabled();
 await page.getByRole('button',{name:'移除此行'}).click();await expect(page.locator('#review-materials-panel .review-footer-actions [data-review-action="review"]')).toBeEnabled();
 expect(state.executes).toHaveLength(0);
});

test('real stage, paused state and cancellation appear in the main panel without assistant',async({page})=>{
 const state=fixture();state.linked=true;state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.artifacts=[];
 const run={...state.makeRun('run-1','running'),stage:'provider_call',event_cursor:1};state.workspace.active_run=run;state.history[0]={...state.history[0],run,artifacts:[],report_id:null};state.runs.set('old',run);
 await setup(page,state);await expect(page.locator('#review-progress-bar')).toContainText('正在复核募集书');
 await page.getByRole('tab',{name:/材料与要求/}).click();await expect(page.locator('#review-progress-bar')).toBeVisible();await expect(page.locator('#review-requirements')).toHaveCount(0);
 run.state='paused';run.stage='provider_reconcile';run.event_cursor=2;
 await page.reload();await expect(page.locator('#review-progress-bar')).toContainText('任务已暂停');
 await expect(page.locator('[data-review-action="review"]')).toBeDisabled();
 await page.locator('#review-progress-bar').getByRole('button',{name:'停止本次任务',exact:true}).click();await expect(page.locator('#review-progress-bar')).toContainText('本轮已停止');expect(state.executes).toHaveLength(0);
});

test('file report update pins source and optional requirements, survives response loss and shows Word pair',async({page})=>{
 const state=fixture();state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.artifact_run={run_id:'run-1',version:1,operation:'full_review',source_report_id:null};state.history[0].report_id=null;
 await setup(page,state);const requests:any[]=[];let drop=true;
 await page.route('**/review-updates',async route=>{const body=route.request().postDataJSON();requests.push(body);if(drop){drop=false;return route.abort('connectionreset');}const run={...state.makeRun('update-run','queued',body.execution_request_id),stage:'queued'};state.workspace.active_run=run;return reply(route,200,run);});
 await expect(page.locator('#review-update-notes')).toHaveCount(0);await page.getByRole('button',{name:'根据复核结果更新募集书',exact:true}).click();
 await expect(page.locator('#review-status')).toContainText('尚未确认更新结果');await page.reload();await expect(page.locator('#review-update-notes')).toHaveCount(0);
 await page.getByRole('button',{name:'根据复核结果更新募集书',exact:true}).click();await expect(page.locator('#review-progress-bar')).toContainText('等待开始');
 await expect.poll(()=>requests.length).toBe(2);expect(requests[0]).toEqual(requests[1]);expect(requests[0].source_run_id).toBe('run-1');expect(requests[0].requirements).toBe('');
 state.workspace.active_run=null;state.workspace.artifact_run={run_id:'update-run',version:2,operation:'revision',source_report_id:null,source_run_id:'run-1'};
 state.workspace.artifacts=[{artifact_id:'tracked',artifact_version:1,filename:'修订版.docx',kind:'revision'},{artifact_id:'clean',artifact_version:1,filename:'清洁版.docx',kind:'clean'}];
 state.history.unshift({...structuredClone(state.history[0]),run:state.makeRun('update-run','succeeded'),operation:'revision',version:2,artifacts:state.workspace.artifacts,created_at:'2026-10-05T12:00:00Z'});
 await page.reload();await expect(page.getByRole('heading',{name:'更新后的募集书已生成'})).toBeVisible();await expect(page.getByRole('button',{name:'下载修订版 Word'})).toBeVisible();await expect(page.getByRole('button',{name:'下载清洁版 Word'})).toBeVisible();await expect(page.getByRole('navigation',{name:'三个复核维度'})).toBeVisible();
 expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
});

test('compact review creation preserves quarter, review kind and existing optional details on edits',async({page})=>{
 const state=fixture();await setup(page,state,'#review');
 await expect(page.locator('#review-create-form input[type=date]')).toHaveCount(0);
 await page.locator('#name').fill('合成复核项目');
 await page.locator('#issuer').fill('合成发行人');
 await page.locator('#market').selectOption('sse');await page.locator('#offering').selectOption('private');
 await page.locator('#reporting-year').selectOption('2025');await page.getByLabel('9月末',{exact:true}).check();
 await page.route('**/api/v1/projects',async route=>{if(route.request().method()==='POST'){const body=route.request().postDataJSON();expect(body.kind).toBe('review');expect(body.update_details.reporting_cutoff).toBe('2025-09-30');state.workspace.project={...state.workspace.project,...body};return reply(route,201,state.workspace.project);}return route.fallback();});
 await expect(page.getByRole('heading',{name:'发行规模与债券安排'})).toHaveCount(0);
 await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
 await expect.poll(()=>state.workspace.project.update_details).toBeDefined();
 state.workspace.project.update_details!.bond_terms='以前保存的债券安排，简洁表单不应清空';
 await expect(page.getByRole('heading',{name:'提供复核材料'})).toBeVisible();
 await expect(page.getByRole('navigation',{name:'复核流程'}).locator('[aria-current=step]')).toContainText('材料与要求');
 await page.reload();await expect(page.getByRole('navigation',{name:'复核流程'}).locator('[aria-current=step]')).toContainText('材料与要求');
 await page.getByRole('tab',{name:/复核结果/}).click();await expect(page.getByRole('navigation',{name:'复核流程'})).toBeHidden();
 await page.getByRole('tab',{name:/材料与要求/}).click();
 await page.getByRole('link',{name:'编辑项目信息'}).click();
 await expect(page.getByRole('navigation',{name:'复核流程'}).locator('[aria-current=step]')).toContainText('创建项目');await page.locator('#issuer').fill('合成发行人更新');
 await expect.poll(()=>state.projectPatches.length).toBeGreaterThan(0);expect(state.workspace.project.kind).toBe('review');
 expect(state.workspace.project.issuer_name).toBe('合成发行人更新');
 expect(state.workspace.project.update_details?.bond_terms).toBe('以前保存的债券安排，简洁表单不应清空');
 expect(state.workspace.project.update_details?.reporting_cutoff).toBe('2025-09-30');
});

test('synthetic workspace design scenes',async({page})=>{
 test.skip(!process.env.BB_WORKSPACE_DESIGN,'Generate only when refreshing the reviewed prototype.');
 const state=fixture();state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.plan=null;
 state.workspace.artifact_run={run_id:'run-1',version:1,operation:'full_review',source_report_id:null};state.history[0].report_id=null;
 await page.setViewportSize({width:1360,height:900});await setup(page,state,'#review');
 const scenes:Record<string,string>={};
 const capture=async(name:string)=>{
   if(['results','progress','updating'].includes(name))await expect(page.getByRole('navigation',{name:'三个复核维度'})).toBeVisible();
   scenes[name]=await page.locator('#app').innerHTML();
   const output=process.env.BB_WORKSPACE_EVIDENCE??'../../docs/acceptance/workspace-ux-20261005';await mkdir(output,{recursive:true});
   for(const width of [1360,390]){await page.setViewportSize({width,height:width===1360?900:844});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:output+'/implementation-'+name+'-'+width+'.png',fullPage:true});}
   await page.setViewportSize({width:1360,height:900});
 };
 await capture('create');
 await page.goto('/#/projects/'+id+'/review?tab=materials&from=projects');await expect(page.locator('#review-requirements')).toHaveCount(0);await expect(page.locator('#review-agent')).toBeVisible();await capture('materials');
 await page.getByRole('tab',{name:/复核结果/}).click();await expect(page.getByRole('navigation',{name:'三个复核维度'})).toBeVisible();await capture('results');
 const run={...state.makeRun('progress-run','running'),stage:'provider_call',event_cursor:1};state.workspace.active_run=run;state.linked=true;
 state.history.unshift({...structuredClone(state.history[0]),run,artifacts:[],report_id:null,version:2,created_at:'2026-10-05T12:00:00Z'});state.runs.set('progress',run);
 await page.reload();await expect(page.locator('#review-progress-bar')).toContainText('正在复核募集书');await capture('progress');
 state.history[0].operation='revision';run.stage='file_authoring';await page.reload();await capture('updating');
 if(process.env.BB_UPLOAD_EVIDENCE)scenes.uploading=JSON.parse(await readFile(process.env.BB_UPLOAD_EVIDENCE+'/uploading-scene.json','utf8'));
 const output='../../product-prototype/public';
 await writeFile(output+'/workspace-ux-scenes.json',JSON.stringify(scenes,null,2)+'\n');
 const css=await page.evaluate(()=>[...document.querySelectorAll('style[data-vite-dev-id]')].map(s=>s.textContent).join('\n'));
 await writeFile(output+'/workspace-ux-preview.css',css);
});

test('workspace prototype parity at desktop and narrow widths',async({page})=>{
 test.skip(!process.env.BB_WORKSPACE_DESIGN,'Dedicated synthetic design comparison only.');
 const output=process.env.BB_WORKSPACE_EVIDENCE??'../../docs/acceptance/workspace-ux-20261005';await mkdir(output,{recursive:true});
 for(const name of ['create','materials','results','progress','updating',...(process.env.BB_UPLOAD_EVIDENCE?['uploading']:[])]){
  for(const width of [1360,390]){
   await page.setViewportSize({width,height:width===1360?900:844});
   await page.goto((process.env.BB_PROTOTYPE_URL??'http://127.0.0.1:4330')+'/workspace-ux.html?scene='+name);await expect(page.locator('.prototype-app')).toBeVisible();
   await page.locator('#design-controls').evaluate(el=>(el as HTMLElement).style.display='none');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:output+'/prototype-'+name+'-'+width+'.png',fullPage:true});
  }
 }
});


test('review navigation retains the app scale while keeping its own layout',async({page})=>{
 const state=fixture();await setup(page,state,'#update');
 const measure=()=>page.evaluate(()=>Object.fromEntries(['.sidebar','.brand','.nav-item','.topbar','main','h1'].map(selector=>{
   const el=document.querySelector(selector)!,css=getComputedStyle(el),rect=el.getBoundingClientRect();
   return [selector,{font:css.fontSize,padding:css.padding,width:selector==='h1'?null:rect.width,left:rect.left}];
 })));
 for(const width of [1920,1360,820,390]){
  await page.setViewportSize({width,height:width===390?844:900});await page.goto('/#update');
  await expect(page.getByRole('heading',{name:'更新募集说明书',exact:true})).toBeVisible();const update=await measure();
  const updateCard=await page.locator('.form-panel').boundingBox();
  const updateSteps=await page.locator('.stepper').evaluate(el=>({font:getComputedStyle(el).fontSize,gap:getComputedStyle(el).gap,height:el.getBoundingClientRect().height}));
  const output=process.env.BB_SCALE_EVIDENCE;if(output){await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/update-entry-${width}.png`,fullPage:true});}
  if(width===390)await page.getByRole('button',{name:'打开菜单',exact:true}).click();
  await page.getByRole('link',{name:'复核募集书',exact:true}).click();
  await expect(page.getByRole('heading',{name:'准备复核项目'})).toBeVisible();const review=await measure();expect(review).toEqual(update);
  const reviewCard=await page.locator('#review-create-form').boundingBox();
  expect(reviewCard!.x).toBeCloseTo(updateCard!.x,0);expect(reviewCard!.width).toBeCloseTo(updateCard!.width,0);
  // The review-only free badge adds a row to the mobile topbar.
  if(width>=760)expect(reviewCard!.y).toBeCloseTo(updateCard!.y,0);
  expect(await page.locator('.stepper').evaluate(el=>({font:getComputedStyle(el).fontSize,gap:getComputedStyle(el).gap,height:el.getBoundingClientRect().height}))).toEqual(updateSteps);
  if(output){await page.screenshot({path:`${output}/review-entry-${width}.png`,fullPage:true});await writeFile(`${output}/scale-${width}.json`,JSON.stringify({viewport:width,update,review,updateCard,reviewCard},null,2)+'\n');}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await expect(page.getByRole('navigation',{name:'复核流程'}).locator('[aria-current=step]')).toContainText('创建项目');
  if(width===390){await page.getByRole('button',{name:'打开菜单'}).click();await expect(page.locator('#sidebar')).toBeVisible();await page.locator('#close-menu').click();}
 }
});

test('paid review confirms points before execution and shows shortage without starting',async({page})=>{
 const state=fixture();await setup(page,state);
 let available=299;
 await page.route('**/review-executions/quote',route=>reply(route,200,{enabled:true,quote:{quote_id:'synthetic-quote',task_type:'full_review',points:300,reason:'合成价格'},balance:{available,frozen:0},shortage:Math.max(0,300-available),reason:null}));
 await page.goto(`/#/projects/${id}/review?tab=materials`);
 await page.getByRole('button',{name:'开始复核',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'开始复核',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('还差 1 积分');
 await expect(page.getByRole('dialog').getByRole('link',{name:'充值积分'})).toHaveAttribute('href',`#/account?project=${id}`);
 expect(state.executes).toHaveLength(0);
 await page.getByRole('dialog').getByRole('button',{name:'返回',exact:true}).click();available=5000;
 await page.getByRole('button',{name:'开始复核',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'开始复核',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('确认后可用 4,700 积分');
 expect(state.executes).toHaveLength(0);
 await page.getByRole('button',{name:'确认并开始 · 300 积分'}).click();
 await expect.poll(()=>state.executes.length).toBe(1);expect(state.executes[0].quote_id).toBe('synthetic-quote');
});

test('review task receipt displays the actual reserved, charged and released points',async({page})=>{
 const state=fixture();
 state.workspace.active_run={...state.makeRun('paid-run','running'),billing_mode:'fixed_credits',reservation_id:'synthetic-reservation'};
 let charge='held',reads=0;
 await setup(page,state);
 await page.route('**/credit-charge',route=>{reads++;return reply(route,200,{quote:{points:300},state:charge});});
 await page.reload();
 await expect(page.locator('#review-credit-receipt')).toHaveText('本次 300 积分 · 已预留，交付后扣费');
 charge='settled';state.workspace.active_run.state='succeeded';await page.reload();
 await expect(page.locator('#review-credit-receipt')).toHaveText('本次 300 积分 · 已扣费');
 charge='released';state.workspace.active_run.state='failed';await page.reload();
 await expect(page.locator('#review-credit-receipt')).toHaveText('本次 300 积分 · 已返还，本次不扣费');
 expect(reads).toBe(3);expect(state.executes).toHaveLength(0);
});

test('dashboard review progress keeps its collection context through tab changes and reload',async({page})=>{
 const s=fixture();s.workspace.active_run=s.makeRun('active-run','running');await setup(page,s,`#/projects/${id}/review?tab=making&from=dashboard&dashboard_kind=review&dashboard_status=active`);
 await expect(page.locator('.nav-item.active')).toHaveText('工作台');await expect(page.locator('#review-tab-making')).toHaveAttribute('aria-selected','true');
 await page.locator('#review-tab-results').click();await page.reload();await expect(page.locator('.nav-item.active')).toHaveText('工作台');await expect(page.getByRole('link',{name:'返回工作台'})).toHaveAttribute('href','#dashboard?kind=review&status=active');expect(s.executes).toHaveLength(0);
});
