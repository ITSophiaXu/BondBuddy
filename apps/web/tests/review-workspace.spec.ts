import { expect, test, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { schemas, ReviewDraftRequestSchema, ReviewExecutionRequestSchema, ReviewMessageRequestSchema, ReviewPlanRequestSchema, isReviewReport,
  type ReviewWorkspace, type ReviewReport, type ReviewEvidenceRef, type ReviewContext, type ReviewMessageRequest,
  type ReviewExecutionRequest, type ReviewPlanRequest, type ReviewProposal, type ReviewProposalV2, type ReviewProposalAdoptionRequest, type ReviewProposalAdoptionResponse, type ReviewHistoryEntry, type ReviewRevisionHandling, type Run, type RunEvent } from '@bondbuddy/contracts';
import type { Dto } from '../src/api';

// Real Chromium with an owner-aware synthetic HTTP fixture. Not model, database or Word acceptance.
const id='synthetic-review-project',now='2026-10-02T10:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const reply=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
const key=(context:ReviewContext)=>JSON.stringify(context);
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
  return {...state,linked:false,allReports:new Map([[report.report_id,report]]),adoptions:[] as ReviewProposalAdoptionRequest[],adoptionResults:new Map<string,ReviewProposalAdoptionResponse>(),dropAdoptionOnce:false,events:new Map<string,RunEvent[]>()};
}
async function setup(page:Page,state=fixture(),routePath=`#/projects/${id}/review?tab=results`){
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
    if(path==='/me')return reply(route,200,{user_id:state.owner,session_status:'active'});
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
      if(path.endsWith('/cancel')){run.state='cancelled';state.workspace.active_run=null;}return reply(route,200,run);
    }
    const referencedMaterial=state.workspace.materials.find(material=>path===`/projects/${id}/materials/${material.material_id}`||path===`/projects/${id}/materials/${material.material_id}/download`);
    if(referencedMaterial&&method==='GET'){
      if(path.endsWith('/download')){state.materialDownloads.push(referencedMaterial.material_id);return route.fulfill({status:200,contentType:referencedMaterial.media_type,body:referencedMaterial.role});}
      state.materialReads.push(referencedMaterial.material_id);return reply(route,200,referencedMaterial);
    }
    if(path.endsWith('/materials/uploads')){
      const body=request.postDataJSON() as Dto<'UploadCreateRequest'>;state.uploads.push(body);return reply(route,201,{upload_id:'upload-evidence',state:'uploading',upload_url:'/api/v1/synthetic-upload',expires_at:'2027-01-01T00:00:00Z',max_bytes:104857600});
    }
    if(path==='/synthetic-upload'){state.uploadBytes++;return route.fulfill({status:204});}
    if(path.endsWith('/upload-evidence/complete')){
      const upload=state.uploads[0];let material=state.workspace.materials.find(m=>m.material_id==='evidence-new');
      if(!material){material={...upload,material_id:'evidence-new',material_version:1,upload_id:'upload-evidence',state:'persisted',persisted_at:now,error:null};state.workspace.materials.push(material);}
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
async function openFinding(page:Page,id:string){const card=finding(page,id);if(!await card.getAttribute('open').then(v=>v!==null))await card.locator('summary').click();return card;}

for(const routePath of [`#/projects/${id}`,`#/projects/${id}/review?tab=materials`])test(`new review project opens materials and assistant without a report or plan: ${routePath}`,async({page})=>{
  const state=fixture();
  state.workspace.materials=[];
  state.workspace.draft={version:1,source_material_ref:null,material_versions:[],requirements:[],as_of:null,evidence_links:[]};
  state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.plan=null;state.workspace.artifacts=[];
  state.history.length=0;state.runs.clear();
  await setup(page,state,routePath);
  await expect(page.getByRole('heading',{name:'合成募集书复核项目',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'项目暂时无法读取',exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'材料与要求',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tabpanel',{name:'材料与要求',exact:true})).toContainText('还没有项目材料');
  await page.getByRole('button',{name:'＋ 上传材料',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'上传项目材料',exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'返回',exact:true}).click();
  await expect(page.getByLabel('补充项目说明',{exact:true})).toBeVisible();
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

test('desktop assistant stays available without stealing focus; mobile drawer preserves finding drafts across resizing',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const state=await setup(page);
  const assistant=page.locator('#review-agent'),input=page.locator('#review-message-input'),floating=page.getByRole('button',{name:'打开项目助手',exact:true});
  await expect(assistant).toBeVisible();await expect(assistant).toHaveAttribute('role','complementary');await expect(assistant).not.toHaveAttribute('aria-modal','true');await expect(input).not.toBeFocused();
  const resultsBox=await page.locator('#review-results-panel').boundingBox(),assistantBox=await assistant.boundingBox();expect(assistantBox!.x).toBeGreaterThan(resultsBox!.x+resultsBox!.width);
  await expect(page.locator('.review-header').getByRole('button')).toHaveCount(0);await expect(page.locator('#review-meta')).toHaveCount(0);
  await expect(floating).toBeHidden();await expect(assistant.getByRole('button',{name:'收起项目助手',exact:true})).toBeHidden();
  await expect(page.locator('.review-context-project')).toHaveText('合成募集书复核项目');await expect(page.locator('.review-context-input')).toHaveText('下一输入 V1 · 左侧报告 R1');await expect(page.locator('[data-assistant-action="project"]')).toHaveCount(0);
  state.failDrafts=true;await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await input.fill('F01 / R1 在不同屏幕宽度保留的草稿');
  await expect(page.locator('.review-agent-context .review-tag')).toHaveAttribute('title','report-v1 · F01');
  await expect(page.locator('.review-agent-context')).toContainText('讨论引用：报告 R1');await expect(page.locator('.review-agent-context')).toContainText('F01');await expect(page.getByRole('button',{name:'回到项目说明',exact:true})).toBeVisible();
  await page.setViewportSize({width:1280,height:720});await expect(assistant).toHaveClass(/review-agent-compact/);expect(await page.locator('.review-chat').evaluate(log=>log.getBoundingClientRect().height)).toBeGreaterThanOrEqual(175);expect(await page.getByRole('button',{name:'发送说明',exact:true}).evaluate(button=>button.getBoundingClientRect().bottom<=innerHeight)).toBe(true);await expect(page.locator('.review-context-compact').filter({hasText:'讨论 R1 · F01'})).toBeVisible();await expect(input).toHaveValue('F01 / R1 在不同屏幕宽度保留的草稿');
  await page.setViewportSize({width:390,height:844});await expect(assistant).toBeHidden();await expect(floating).toBeVisible();await expect(floating).toBeFocused();
  await floating.click();await expect(assistant).toBeVisible();await expect(assistant).toHaveAttribute('role','dialog');await expect(assistant).toHaveAttribute('aria-modal','true');await expect(input).toHaveValue('F01 / R1 在不同屏幕宽度保留的草稿');await expect(input).toBeFocused();
  await page.setViewportSize({width:1440,height:1000});await expect(assistant).toBeVisible();await expect(assistant).toHaveAttribute('role','complementary');await expect(assistant).not.toHaveAttribute('aria-modal','true');await expect(input).toBeFocused();
  await page.setViewportSize({width:390,height:844});await expect(assistant).toBeVisible();await expect(assistant).toHaveAttribute('role','dialog');await expect(input).toHaveValue('F01 / R1 在不同屏幕宽度保留的草稿');
  await input.press('Escape');await expect(assistant).toBeHidden();await expect(floating).toBeFocused();
  await page.setViewportSize({width:1440,height:1000});await expect(assistant).toBeVisible();await expect(assistant).toHaveAttribute('role','complementary');await expect(assistant).not.toHaveAttribute('aria-modal','true');await expect(floating).toBeHidden();await expect(input).not.toBeFocused();
  await expect(input).toHaveValue('F01 / R1 在不同屏幕宽度保留的草稿');await expect(page.locator('.review-agent-context .review-tag')).toHaveAttribute('title','report-v1 · F01');
  await page.setViewportSize({width:390,height:844});await expect(assistant).toBeHidden();await floating.click();await expect(input).toHaveValue('F01 / R1 在不同屏幕宽度保留的草稿');
  expect(state.requests).toHaveLength(0);expect(state.plans).toHaveLength(0);expect(state.executes).toHaveLength(0);
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
  await mkdir('test-evidence/m3-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-evidence/m3-review/handling-desktop.png'});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-evidence/m3-review/handling-narrow.png'});
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
  const state=await setup(page);await expect(page.locator('#review-agent')).toBeVisible();await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#review-workspace')).not.toContainText(/充值|费用|积分|余额/);
  const card=await openFinding(page,'F01');await card.getByRole('button',{name:'查看解释'}).click();await expect(page.getByRole('dialog')).toContainText('现金流 120');expect(state.requests).toHaveLength(0);await page.getByRole('button',{name:'返回',exact:true}).click();
  await page.getByRole('button',{name:'核对修订计划'}).click();await page.getByRole('button',{name:'确认范围并执行修订'}).click();await expect(page.getByRole('dialog')).toContainText('请选择至少一项');expect(state.executes).toHaveLength(0);await page.getByRole('button',{name:'返回',exact:true}).click();
  await card.getByLabel('加入修订').check();await expect.poll(()=>state.workspace.plan?.finding_ids).toEqual(['F01']);await expect(card).toHaveAttribute('open','');
  await page.getByRole('button',{name:'核对修订计划'}).click();await expect(page.getByRole('dialog')).toContainText('固定输入');await expect(page.getByRole('dialog')).toContainText('合成募集书.docx · V1');await expect(page.getByRole('dialog')).toContainText('核对财务摘要引用。');expect(state.executes).toHaveLength(0);
  state.dropExecutionOnce=true;await page.getByRole('button',{name:'确认范围并执行修订',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('重试沿用同一请求');await expect(page.getByRole('dialog')).not.toContainText('确认本次执行范围');await expect(page.locator('[data-plan-finding="F01"]')).toBeDisabled();const savedPlans=state.plans.length;await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('不能改变已确认范围');expect(state.plans).toHaveLength(savedPlans);await page.getByRole('button',{name:'确认范围并执行修订',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(state.plans).toHaveLength(savedPlans);
  expect(state.executes).toHaveLength(2);expect(state.executes[0].execution_request_id).toBe(state.executes[1].execution_request_id);expect(state.runs.size).toBe(2);expect(state.requests).toHaveLength(0);
  await expect(page.getByRole('button',{name:'再次完整复核'})).toBeDisabled();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载问题报告'}).click();expect((await download).suggestedFilename()).toBe('合成问题报告.docx');
  await page.getByRole('button',{name:'停止本次任务'}).click();await expect(page.locator('.review-run')).toContainText('已停止');
  await page.getByRole('button',{name:'再次完整复核'}).click();state.dropExecutionOnce=true;await page.getByRole('button',{name:'开始复核',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(3);await expect(page.getByRole('dialog')).toContainText('重试沿用同一请求');expect(state.executes[2].execution_request_id).not.toBe(state.executes[0].execution_request_id);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.locator('.review-run')).toContainText('排队中');expect(state.executes).toHaveLength(3);
});

test('separate context drafts survive switching, refresh and failed sync; sending and proposals never execute or change plan until adopted',async({page})=>{
  const state=await setup(page);state.failDrafts=true;
  await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await page.locator('#review-message-input').fill('F01 的未发送草稿');
  await (await openFinding(page,'F02')).getByRole('button',{name:'继续讨论此项'}).click();await page.locator('#review-message-input').fill('F02 的未发送草稿');
  await page.reload();await expect(page.locator('#review-message-input')).toHaveValue('F02 的未发送草稿');
  await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await expect(page.locator('#review-message-input')).toHaveValue('F01 的未发送草稿');state.failDrafts=false;
  state.dropMessageOnce=true;await page.getByRole('button',{name:'发送说明',exact:true}).click();await expect(page.locator('#review-assistant-status')).toContainText('原请求已保留');
  await page.getByRole('button',{name:'重试待确认原请求'}).click();await expect(page.locator('.review-proposal')).toBeVisible();expect(state.requests).toHaveLength(2);expect(state.requests[0]).toEqual(state.requests[1]);expect(state.requests[0].context).toMatchObject({project_id:id,report_id:'report-v1',finding_ids:['F01'],material_refs:[{material_id:'material-0',material_version:1},{material_id:'material-1',material_version:1}]});
  expect(state.executes).toHaveLength(0);expect(state.plans).toHaveLength(0);await page.getByRole('button',{name:'查看并采纳计划'}).click();expect(state.plans).toHaveLength(0);await page.getByRole('button',{name:'采纳计划',exact:true}).click();await expect.poll(()=>state.plans.length).toBe(1);expect(state.executes).toHaveLength(0);
  await (await openFinding(page,'F02')).getByRole('button',{name:'继续讨论此项'}).click();await expect(page.locator('#review-message-input')).toHaveValue('F02 的未发送草稿');
});

for(const scenario of [
  {name:'deselected',original:['F01','F03'],edit:'remove',selected:['F01']},
  {name:'additional',original:['F01'],edit:'add',selected:['F01','F03']},
  {name:'unrepairable',original:['F01','F02'],edit:'none',selected:['F01']},
] as const)test(`assistant proposal accepts ${scenario.name} choices as the confirmed plan while retaining original provenance`,async({page})=>{
  const state=fixture(),report=state.workspace.selected_report!;
  report.findings.push({...structuredClone(report.findings[0]),finding_id:'F03',title:'关联摘要金额需要同步'});
  const proposal:ReviewProposal={proposal_id:'synthetic-editable-proposal',source_report_id:report.report_id,finding_ids:[...scenario.original],
    requirements:['保留原报告与未选问题'],explanation:'合成提议：请核对以下修改范围。'};
  state.workspace.messages.push({message_id:'proposal-message',role:'assistant',content:'合成回复，仅提出计划。',context:{project_id:id,report_id:report.report_id,finding_ids:[],material_refs:[]},
    created_at:now,reply_status:'completed',reply_to:null,proposal:structuredClone(proposal),error:null});
  await setup(page,state);await page.getByRole('button',{name:'查看并采纳计划'}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('采纳以本次核对后的选择为准，原提议保留');
  if(scenario.edit==='remove')await dialog.locator('[data-plan-finding="F03"]').uncheck();
  if(scenario.edit==='add')await dialog.locator('[data-plan-finding="F03"]').check();
  if(scenario.edit==='none'){await expect(dialog).toContainText('以下提议事项缺少修订依据');await expect(dialog).toContainText('F02');await expect(dialog.locator('[data-plan-finding="F02"]')).toHaveCount(0);}
  expect(state.plans).toHaveLength(0);expect(state.executes).toHaveLength(0);
  await dialog.getByRole('button',{name:'采纳计划',exact:true}).click();await expect(dialog).not.toBeVisible();
  expect(state.workspace.plan?.finding_ids).toEqual(scenario.selected);
  expect(state.workspace.plan?.proposal_origin).toMatchObject({proposal,adoption:'user_adjusted'});
  expect(state.workspace.messages[0].proposal).toEqual(proposal);
  expect(state.plans[0].proposal_id).toBe(proposal.proposal_id);expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
  if(scenario.edit==='none')expect(state.workspace.plan?.excluded_findings).toContainEqual({finding_id:'F02',reason:report.findings[1].repairability.reason});
  await page.getByRole('button',{name:'核对修订计划',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('当前计划经用户调整，原提议未改变');
  if(scenario.edit==='none'){await mkdir('test-evidence/m3-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-evidence/m3-review/proposal-adjusted-desktop.png'});}
  await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect.poll(()=>state.plans.length).toBe(2);
  expect(state.plans[1].proposal_id).toBe(proposal.proposal_id);expect(state.executes).toHaveLength(0);
});

test('plan failures remain visible in adoption and save dialogs with selections retained and no execution',async({page})=>{
  const state=fixture(),report=state.workspace.selected_report!;
  report.findings.push({...structuredClone(report.findings[0]),finding_id:'F03',title:'关联摘要金额需要同步'});
  const proposal:ReviewProposal={proposal_id:'synthetic-failing-plan',source_report_id:report.report_id,finding_ids:['F01','F03'],requirements:['保留原报告'],explanation:'合成提议：核对修改范围。'};
  state.workspace.messages.push({message_id:'failing-plan-message',role:'assistant',content:'合成回复，仅提出计划。',context:{project_id:id,report_id:report.report_id,finding_ids:[],material_refs:[]},created_at:now,reply_status:'completed',reply_to:null,proposal:structuredClone(proposal),error:null});
  await setup(page,state);await page.getByRole('button',{name:'查看并采纳计划'}).click();
  let dialog=page.getByRole('dialog');await dialog.locator('[data-plan-finding="F03"]').uncheck();state.failPlan=true;
  await dialog.getByRole('button',{name:'采纳计划',exact:true}).click();await expect(dialog).toBeVisible();await expect(dialog.locator('#review-dialog-status')).toBeVisible();await expect(dialog.locator('#review-dialog-status')).toContainText('选择未确认');await expect(page.locator('#review-status')).toContainText('选择未确认');
  await expect(dialog.locator('[data-plan-finding="F01"]')).toBeChecked();await expect(dialog.locator('[data-plan-finding="F03"]')).not.toBeChecked();expect(state.workspace.plan).toBeNull();expect(state.executes).toHaveLength(0);expect(state.runs.size).toBe(1);
  state.failPlan=false;await dialog.getByRole('button',{name:'采纳计划',exact:true}).click();await expect(dialog).not.toBeVisible();expect(state.workspace.plan?.finding_ids).toEqual(['F01']);
  const adopted=structuredClone(state.workspace.plan);await page.getByRole('button',{name:'核对修订计划',exact:true}).click();dialog=page.getByRole('dialog');await dialog.locator('[data-plan-finding="F03"]').check();state.failPlan=true;
  await dialog.getByRole('button',{name:'保存计划',exact:true}).click();await expect(dialog).toBeVisible();await expect(dialog.locator('#review-dialog-status')).toBeVisible();await expect(dialog.locator('#review-dialog-status')).toContainText('选择未确认');await expect(page.locator('#review-status')).toContainText('选择未确认');
  await expect(dialog.locator('[data-plan-finding="F01"]')).toBeChecked();await expect(dialog.locator('[data-plan-finding="F03"]')).toBeChecked();expect(state.workspace.plan).toEqual(adopted);expect(state.executes).toHaveLength(0);expect(state.runs.size).toBe(1);
  state.failPlan=false;await dialog.getByRole('button',{name:'保存计划',exact:true}).click();await expect(dialog).not.toBeVisible();expect(state.workspace.plan?.finding_ids).toEqual(['F01','F03']);expect(state.workspace.messages[0].proposal).toEqual(proposal);expect(state.requests).toHaveLength(0);expect(state.executes).toHaveLength(0);expect(state.runs.size).toBe(1);
});

test('missing review project details can be completed and return to the exact report with unsent and input drafts preserved',async({page})=>{
  const state=fixture();Object.assign(state.workspace.project,{issuer_name:null,market:null,offering:null});
  state.workspace.active_run=state.makeRun('active-details-run','running');state.runs.set('active-details',state.workspace.active_run);
  const originalReport=structuredClone(state.workspace.selected_report),originalRun=structuredClone(state.workspace.active_run),originalHistory=structuredClone(state.history);
  await setup(page,state);state.failDrafts=true;
  await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await page.locator('#review-message-input').fill('F01 / R1 未发送的口径说明');
  await page.getByRole('tab',{name:'材料与要求'}).click();
  await page.locator('#review-requirements').fill('下一版需要保留的复核要求');
  await expect(page.locator('#review-project-info').getByRole('link',{name:'补充项目信息',exact:true})).toBeVisible();await expect(page.locator('#review-meta')).toHaveCount(0);await expect(page.locator('#review-project-info')).not.toContainText('发行人待填写');
  await mkdir('test-evidence/m3-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-evidence/m3-review/project-details-entry-desktop.png'});
  await page.getByRole('link',{name:'补充项目信息',exact:true}).click();await expect(page.getByRole('heading',{name:'编辑复核项目信息',exact:true})).toBeVisible();
  await expect(page.locator('#draft-form input')).toHaveCount(2);await expect(page.locator('#draft-form select')).toHaveCount(2);
  state.failProjectPatch=true;await page.locator('#review-issuer').fill('补充后的合成发行人');await page.locator('#review-market').selectOption('nafmii');await page.locator('#review-offering').selectOption('dfi');
  await page.locator('#save-draft').click();await expect(page.locator('#save-state')).toContainText('保存未确认');await expect(page.locator('#review-issuer')).toHaveValue('补充后的合成发行人');
  state.failProjectPatch=false;await page.locator('#save-draft').click();await expect(page.locator('#save-state')).toContainText('已保存');
  expect(state.workspace.project).toMatchObject({kind:'review',issuer_name:'补充后的合成发行人',market:'nafmii',offering:'dfi'});
  expect(state.workspace.selected_report).toEqual(originalReport);expect(state.workspace.active_run).toEqual(originalRun);expect(state.history).toEqual(originalHistory);expect(state.executes).toHaveLength(0);
  await page.screenshot({path:'test-evidence/m3-review/project-details-form-desktop.png'});
  state.failDrafts=false;await page.getByRole('link',{name:'返回复核工作区',exact:true}).click();await expect(page).toHaveURL(/review\?tab=materials&report_id=report-v1/);
  await expect(page.getByRole('tab',{name:'材料与要求',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('#review-materials-panel')).toBeVisible();await expect(page.locator('#review-results-panel')).toBeHidden();
  await expect(page.locator('#review-requirements')).toHaveValue('下一版需要保留的复核要求');await expect(page.locator('#review-project-info')).toContainText('补充后的合成发行人');
  await expect(page.locator('#review-message-input')).toHaveValue('F01 / R1 未发送的口径说明');
  await expect(page.locator('.review-agent-context .review-tag')).toHaveAttribute('title','report-v1 · F01');await expect(page.locator('.review-agent-context')).toContainText('现金流金额与审计报告不一致');
  expect(state.requests).toHaveLength(0);expect(state.executes).toHaveLength(0);expect(state.workspace.selected_report).toEqual(originalReport);
});

test('direct report links without a valid explicit tab open results',async({page})=>{
  const state=fixture();await setup(page,state,`#/projects/${id}/review?report_id=report-v1`);
  await expect(page.getByRole('tab',{name:'复核结果',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('#review-results-panel')).toBeVisible();await expect(page.locator('#review-materials-panel')).toBeHidden();
  await page.goto(`/#/projects/${id}/review?tab=unknown&report_id=report-v1`);
  await expect(page.getByRole('tab',{name:'复核结果',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('#review-results-panel')).toBeVisible();await expect(page.locator('#review-materials-panel')).toBeHidden();
  expect(state.requests).toHaveLength(0);expect(state.executes).toHaveLength(0);
});

test('typing while a message saves is retained; polling preserves open findings and textarea selection',async({page})=>{
  const state=fixture();state.workspace.active_run=state.makeRun('polling-run','queued');state.delayMessage=true;await setup(page,state);await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();
  const input=page.locator('#review-message-input');await input.fill('发送的说明');await page.getByRole('button',{name:'发送说明',exact:true}).click();await expect.poll(()=>state.requests.length).toBe(1);await input.fill('发送中继续输入的新草稿');await expect(page.locator('.review-proposal')).toBeVisible();await expect(input).toHaveValue('发送中继续输入的新草稿');
  await expect(page.locator('.review-run')).toContainText('排队中');
  await input.focus();await input.evaluate((node:HTMLTextAreaElement)=>node.setSelectionRange(3,7));const before=state.workspaceReads;await expect.poll(()=>state.workspaceReads).toBeGreaterThan(before);
  await expect(finding(page,'F01')).toHaveAttribute('open','');await expect(input).toHaveValue('发送中继续输入的新草稿');await expect(input).toBeFocused();expect(await input.evaluate((node:HTMLTextAreaElement)=>[node.selectionStart,node.selectionEnd])).toEqual([3,7]);
  await page.getByRole('tab',{name:'材料与要求'}).click();await page.locator('#review-requirements').fill('执行中也能记录下一轮要求');await expect.poll(()=>state.workspace.draft.requirements).toEqual(['执行中也能记录下一轮要求']);await page.reload();await expect(page.locator('#review-requirements')).toHaveValue('执行中也能记录下一轮要求');
});

test('input conflicts display both versions and require explicit adoption; foreign owners cannot recover another project draft',async({page})=>{
  const state=await setup(page);await page.getByRole('tab',{name:'材料与要求'}).click();state.workspace.draft={...state.workspace.draft,version:2,requirements:['另一页面保存的服务器要求']};
  await page.locator('#review-requirements').fill('本页仍需保留的要求');await expect(page.locator('#review-materials-panel')).toContainText('服务器上的输入已有变化');expect(state.workspace.draft.requirements).toEqual(['另一页面保存的服务器要求']);
  await page.getByRole('button',{name:'核对并保存本页内容为新版'}).click();await expect(page.getByRole('dialog')).toContainText('另一页面保存的服务器要求');await expect(page.getByRole('dialog')).toContainText('本页仍需保留的要求');expect(state.workspace.draft.version).toBe(2);await page.getByRole('button',{name:'将本页内容保存为新版'}).click();await expect.poll(()=>state.workspace.draft.version).toBe(3);expect(state.executes).toHaveLength(0);
  await page.locator('#review-message-input').fill('仅 owner-a 可见的草稿');state.failDrafts=true;state.owner='owner-b';await page.reload();await expect(page.getByRole('heading',{name:'项目暂时无法读取'})).toBeVisible();await expect(page.locator('body')).not.toContainText('仅 owner-a 可见的草稿');
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
  const state=await setup(page);state.dropUploadOnce=true;await (await openFinding(page,'F02')).getByRole('button',{name:'继续讨论此项'}).click();await page.locator('#review-message-input').fill('F02 的补证说明，保留原历史名称');await page.getByRole('button',{name:'添加补充依据',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('report-v1 · F02');await expect(page.locator('#review-message-input')).toHaveValue('F02 的补证说明，保留原历史名称');
  await page.getByLabel('选择 DOCX／PDF／XLSX／CSV／TXT 或图片').setInputFiles({name:'更名证明.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic name change evidence')});await page.getByRole('button',{name:'上传并保存'}).click();await expect(page.getByRole('dialog')).toContainText('可以重试原上传确认保存状态');
  await page.getByRole('button',{name:'上传并保存'}).click();await expect(page.getByRole('dialog')).toContainText('材料已补充，核对下一步');expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.workspace.draft.evidence_links).toEqual([{report_id:'report-v1',finding_id:'F02',material_ref:{material_id:'evidence-new',material_version:1,sha256:hash('Synthetic name change evidence')}}]);expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
  await expect(page.locator('#review-message-input')).toHaveValue('F02 的补证说明，保留原历史名称');await expect(page.locator('.review-agent-context .review-tag')).toHaveAttribute('title','report-v1 · F02');
  await page.getByRole('button',{name:'核对并重新核验'}).click();await expect(page.getByRole('dialog')).toContainText('差异复核');await page.getByRole('button',{name:'开始复核',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(1);expect(state.executes[0]).toMatchObject({operation:'differential_review',source_report_id:'report-v1',finding_ids:['F02']});
});

function addTypedProposal(state:ReturnType<typeof fixture>,operation:ReviewProposalV2['operation']='differential_review'){
  state.linked=true;
  const proposal:ReviewProposalV2={version:'review-proposal-v2',proposal_id:'typed-proposal',project_id:id,operation,source_report_id:operation==='full_review'?null:'report-v1',source_report_sha256:operation==='full_review'?null:hash('report'),context_report_ref:{report_id:'report-v1',sha256:hash('report')},input_version:1,input_sha256:hash('input'),source_material_ref:state.workspace.draft.source_material_ref,material_versions:state.workspace.draft.material_versions,finding_ids:operation==='full_review'?[]:['F02'],related_finding_ids:[],excluded_findings:[],requirements:['采用补充材料核对历史名称，保留未重核事项。'],explanation:'合成提议：根据补充证据明确核验范围。'};
  state.workspace.messages.push({message_id:'typed-reply',role:'assistant',content:'这是合成回复，先确认范围才执行。',context:{project_id:id,report_id:'report-v1',finding_ids:['F02'],material_refs:[]},created_at:'2026-10-02T10:30:00Z',reply_status:'completed',reply_to:null,proposal,error:null,reply_metadata:{version:'review-reply-metadata-v1',context_report_ref:{report_id:'report-v1',sha256:hash('report')},cited_finding_ids:['F02']}});
  return proposal;
}

test('linked shortcut uses one real task card without manufacturing chat and process links stay accurate',async({page})=>{
  const state=fixture();state.linked=true;await page.setViewportSize({width:1360,height:900});await setup(page,state);
  await expect(page.locator('#review-agent')).toBeVisible();await expect(page.locator('.review-task-card')).toHaveCount(1);
  expect(await page.locator('#review-agent').evaluate(panel=>panel.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
  expect(await page.getByRole('button',{name:'发送说明',exact:true}).evaluate(button=>button.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
  await mkdir('../../../diagnostics/m3-linked-implementation',{recursive:true});await page.screenshot({path:'../../../diagnostics/m3-linked-implementation/synthetic-runtime-desktop-1360x900.png'});
  await page.locator('#review-results-panel').getByRole('button',{name:'再次完整复核',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'开始复核',exact:true}).click();
  await expect.poll(()=>state.executes.length).toBe(1);await expect(page.locator('.review-task-card')).toHaveCount(2);expect(state.workspace.messages).toHaveLength(0);expect(state.requests).toHaveLength(0);
  await expect(page.locator('[data-task-run="run-2"]')).toContainText('固定输入 V1');await expect(page.locator('[data-task-run="run-2"]')).toContainText('页面快捷操作');
  await page.reload();await expect(page.locator('[data-task-run="run-2"]')).toHaveCount(1);
  await page.locator('#review-result-task-link').getByRole('button',{name:'在助手中查看过程'}).click();await expect(page.locator('[data-task-run="run-1"]')).toBeFocused();
  await mkdir('test-evidence/m3-linked',{recursive:true});await page.screenshot({path:'test-evidence/m3-linked/runtime-desktop.png'});
  const task=state.history.find(item=>item.run.run_id==='run-2')!;task.run={...task.run,state:'failed',stage:'word_delivery_pair',event_cursor:5};state.workspace.active_run=null;
  state.events.set('run-2',[{event_id:'failed-event',schema_version:1,trace_id:'trace',run_id:'run-2',seq:5,occurred_at:'2026-10-02T11:10:00Z',stage:'word_delivery_pair',type:'run.state_changed',state:'failed',payload:{error_code:'DELIVERY_FAILED'}}]);
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('[data-task-run="run-2"]')).toContainText('文档交付失败');await expect(page.locator('.review-run')).toContainText('文档交付失败');
  task.run={...task.run,state:'running',event_cursor:3};state.workspace.active_run=task.run;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect.poll(()=>state.workspaceReads).toBeGreaterThan(4);await expect(page.locator('[data-task-run="run-2"]')).toContainText('处理失败');await expect(page.locator('.review-run')).toContainText('任务状态：处理失败');await expect(page.locator('.review-task-card')).toHaveCount(2);
});

test('720px desktop keeps the running-task timeline readable and the evidence/send controls visible',async({page})=>{
  const state=fixture();state.linked=true;state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.artifacts=[];state.workspace.draft.requirements=[];
  const run=state.makeRun('run-1','running');state.runs.set('old',run);state.workspace.active_run=run;state.history[0]={...state.history[0],run,report_id:null,artifacts:[]};
  state.workspace.messages.push({message_id:'synthetic-history-user',role:'user',content:'本次上传的合成审计报告用于现金流口径核对，请保留原历史名称并记录补充说明。',context:{project_id:id,report_id:null,finding_ids:[],material_refs:[]},created_at:'2026-10-02T09:55:00Z',reply_status:'failed',reply_to:null,proposal:null,error:'ASSISTANT_PROCESS_INTERRUPTED'});
  await page.setViewportSize({width:1280,height:720});await setup(page,state);await expect(page.locator('#review-agent')).toHaveClass(/review-agent-compact/);await expect(page.locator('[data-task-run="run-1"]')).toContainText('处理中');
  const message=page.locator('[data-message-id="synthetic-history-user"]');await expect(message).toHaveCSS('display','block');await expect(message.locator('.review-warning')).toContainText('助手回复中断');await expect(message).not.toContainText('ASSISTANT_PROCESS_INTERRUPTED');
  const messageGeometry=await message.evaluate(node=>{const box=(selector:string)=>{const bounds=node.querySelector(selector)!.getBoundingClientRect();return{top:bounds.top,bottom:bounds.bottom,width:bounds.width};};return{display:getComputedStyle(node).display,width:node.getBoundingClientRect().width,header:box('header'),body:box('p:not(.review-warning)'),context:box('small'),error:box('.review-warning')};});
  expect(messageGeometry.body.width).toBeGreaterThanOrEqual(220);expect(messageGeometry.body.width/messageGeometry.width).toBeGreaterThan(0.8);expect(messageGeometry.header.bottom).toBeLessThanOrEqual(messageGeometry.body.top);expect(messageGeometry.body.bottom).toBeLessThanOrEqual(messageGeometry.context.top);expect(messageGeometry.context.bottom).toBeLessThanOrEqual(messageGeometry.error.top);
  await mkdir('../../../diagnostics/m3-linked-implementation',{recursive:true});await page.screenshot({path:'../../../diagnostics/m3-linked-implementation/synthetic-message-desktop-1280x720.png'});await mkdir('test-evidence/m3-linked',{recursive:true});await page.screenshot({path:'test-evidence/m3-linked/runtime-message-desktop-1280x720.png'});await page.locator('.review-chat').evaluate(log=>log.scrollTop=log.scrollHeight);
  const geometry=await page.evaluate(()=>{
    const box=(selector:string)=>{const node=document.querySelector(selector)!;const bounds=node.getBoundingClientRect();return{top:bounds.top,bottom:bounds.bottom,height:bounds.height,width:bounds.width};};
    return{viewport:{width:innerWidth,height:innerHeight},assistant:box('#review-agent'),timeline:box('.review-chat'),composer:box('.review-composer'),task:box('[data-task-run="run-1"]'),send:box('[data-assistant-action="send"]'),evidence:box('[data-assistant-action="attach-evidence"]'),horizontal_overflow:document.documentElement.scrollWidth>innerWidth};
  });
  expect(geometry.viewport).toEqual({width:1280,height:720});expect(geometry.timeline.height).toBeGreaterThanOrEqual(180);expect(geometry.assistant.bottom).toBeLessThanOrEqual(720);expect(geometry.send.bottom).toBeLessThanOrEqual(720);expect(geometry.evidence.bottom).toBeLessThanOrEqual(720);expect(Math.min(geometry.task.bottom,geometry.timeline.bottom)-Math.max(geometry.task.top,geometry.timeline.top)).toBeGreaterThanOrEqual(140);expect(geometry.horizontal_overflow).toBe(false);
  await page.screenshot({path:'../../../diagnostics/m3-linked-implementation/synthetic-runtime-desktop-1280x720.png'});await writeFile('../../../diagnostics/m3-linked-implementation/synthetic-runtime-desktop-1280x720.geometry.json',JSON.stringify({kind:'synthetic UI geometry',message:messageGeometry,...geometry},null,2)+'\n');await page.screenshot({path:'test-evidence/m3-linked/runtime-desktop-1280x720.png'});
  expect(state.requests).toHaveLength(0);expect(state.executes).toHaveLength(0);expect(state.workspace.active_run).toEqual(run);
});

test('typed proposal cancel executes nothing; adoption response loss reuses its identity and binds the confirmed range',async({page})=>{
  const state=fixture();addTypedProposal(state);await setup(page,state);
  await page.getByRole('button',{name:'核对范围',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('未选择对象沿用来源报告');await page.getByRole('dialog').getByRole('button',{name:'返回',exact:true}).click();expect(state.executes).toHaveLength(0);expect(state.adoptions).toHaveLength(0);
  await page.getByRole('button',{name:'核对范围',exact:true}).click();state.dropAdoptionOnce=true;
  await page.getByRole('dialog').getByRole('button',{name:'确认并开始重新核验',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('采纳结果尚未确认');expect(state.executes).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button',{name:'确认并开始重新核验',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect.poll(()=>state.executes.length).toBe(1);
  expect(state.adoptions).toHaveLength(2);expect(state.adoptions[0]).toEqual(state.adoptions[1]);expect(state.workspace.accepted_proposals).toHaveLength(1);
  expect(state.executes[0]).toMatchObject({operation:'differential_review',source_report_id:'report-v1',finding_ids:['F02'],expected_input_version:2,entrypoint:'assistant_proposal',context_report_ref:{report_id:'report-v1',sha256:hash('report')}});
  await expect(finding(page,'F02')).toContainText('正在重新核验');await expect(finding(page,'F01')).not.toContainText('正在重新核验');await expect(page.locator('[data-task-run="run-2"]')).toContainText('对话确认执行');expect(state.requests).toHaveLength(0);
});

test('full conversation request retains full scope and discussion references without a differential source',async({page})=>{
  const state=fixture();addTypedProposal(state,'full_review');await setup(page,state);
  await page.getByRole('button',{name:'核对范围',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('完整三维复核，不缩为问题范围');await page.getByRole('dialog').getByRole('button',{name:'确认并开始重新核验',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(1);
  expect(state.executes[0]).toMatchObject({operation:'full_review',source_report_id:null,finding_ids:[],entrypoint:'assistant_proposal',context_report_ref:{report_id:'report-v1',sha256:hash('report')}});
});

test('shortcut revision preserves adopted V2 requirements in a fresh explicitly confirmed quick-action plan',async({page})=>{
  const state=fixture(),proposal=addTypedProposal(state,'revision');proposal.finding_ids=['F01'];await setup(page,state);
  await page.getByRole('button',{name:'核对范围',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'仅采纳要求，暂不执行',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(state.executes).toHaveLength(0);expect(state.plans).toHaveLength(0);expect(state.workspace.plan?.proposal_origin?.proposal).toEqual(proposal);const adoptedRequirements=[...state.workspace.draft.requirements];
  await page.getByRole('button',{name:'核对修订计划',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('修订计划要求');await expect(page.getByRole('dialog')).toContainText(proposal.requirements[0]);await page.getByRole('button',{name:'确认范围并执行修订',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(1);
  expect(state.plans).toHaveLength(1);expect(state.plans[0].proposal_id).toBeUndefined();expect(state.plans[0].requirements).toEqual(proposal.requirements);expect(state.workspace.draft.requirements).toEqual(adoptedRequirements);expect(state.workspace.accepted_proposals).toHaveLength(1);expect(state.workspace.messages[0].proposal).toEqual(proposal);
  expect(state.executes[0]).toMatchObject({operation:'revision',source_report_id:'report-v1',finding_ids:['F01'],expected_input_version:2,expected_plan_version:2,entrypoint:'quick_action'});expect(state.executes[0].accepted_proposal_id).toBeUndefined();expect(state.history.at(-1)?.origin).toMatchObject({entrypoint:'quick_action',accepted_proposal:null});
});

test('validated finding links pin old reports and new results do not replace a historical view',async({page})=>{
  const state=fixture();addTypedProposal(state);const original=state.workspace.selected_report!;
  const next=structuredClone(original);next.report_id='report-v2';next.run_id='run-2';next.version=2;next.scope={mode:'differential_review',finding_ids:['F01']};
  next.findings=next.findings.map(f=>({...f,report_id:'report-v2',origin_report_id:f.finding_id==='F01'?'report-v2':'report-v1',check_status:f.finding_id==='F01'?'rechecked':'carried_forward'}));next.coverage=next.coverage.map(c=>({...c,origin_report_id:c.dimension==='financial'?'report-v2':'report-v1',check_status:c.dimension==='financial'?'rechecked':'carried_forward'}));
  next.follow_up={version:'review-follow-up-v1',source_report_id:'report-v1',source_report_sha256:hash('report'),findings:[{source_finding_id:'F01',current_finding_ids:['F01'],coverage_check_ids:['financial-total'],status:'rechecked',outcome:'issue',reason:'本轮核验仍有问题。'},{source_finding_id:'F02',current_finding_ids:['F02'],coverage_check_ids:['public-name'],status:'carried_forward',outcome:'carried_forward',reason:'本轮未重核，保留 R1。'}]};
  state.allReports.set(next.report_id,next);state.workspace.selected_report=next;state.workspace.reports.push({report_id:next.report_id,version:2,run_id:'run-2',created_at:'2026-10-02T12:00:00Z'});
  await setup(page,state);await expect(page.locator('.review-follow-up')).toContainText('本轮已重新核验');await expect(page.locator('.review-follow-up')).toContainText('沿用原报告');
  await page.locator('.review-message-links').getByRole('button',{name:'查看 F02',exact:true}).click();await expect(page).toHaveURL(/report_id=report-v1/);await expect(finding(page,'F02')).toHaveAttribute('open','');await expect(page.locator('.review-result-hero')).toContainText('R1');await expect(page.locator('.review-notice')).toContainText('本轮有新结果 R2');
  await page.reload();await expect(page.locator('.review-result-hero')).toContainText('R1');await page.getByRole('button',{name:'查看本轮新结果',exact:true}).click();await expect(page.locator('.review-result-hero')).toContainText('R2');expect(state.executes).toHaveLength(0);
  await page.setViewportSize({width:581,height:753});await page.getByRole('button',{name:'打开项目助手',exact:true}).click();await expect(page.locator('#review-agent')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await mkdir('test-evidence/m3-linked',{recursive:true});await page.screenshot({path:'test-evidence/m3-linked/runtime-narrow.png'});
  await page.screenshot({path:'../../../diagnostics/m3-linked-implementation/synthetic-runtime-narrow-581x753.png'});
});

test('workbench alone owns version history and retains stopped/failed snapshots and exact report navigation',async({page})=>{
  const state=fixture();for(const [index,status]of(['failed','cancelled'] as const).entries())state.history.push({...structuredClone(state.history[0]),version:index+2,run:state.makeRun(`run-${index+2}`,status),report_id:null,input:{...structuredClone(state.workspace.draft),requirements:[`保留的${status}版本要求`]},created_at:`2026-10-02T1${index+1}:00:00Z`});
  await setup(page,state,'#dashboard');await expect(page.locator('.review-project-card')).toBeVisible();await page.getByRole('button',{name:'版本记录',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.locator('.review-history-entry')).toHaveCount(3);await expect(dialog).toContainText('已停止');await expect(dialog).toContainText('处理失败');await dialog.getByText('查看本轮输入与处理范围',{exact:true}).first().click();await expect(dialog).toContainText('保留的cancelled版本要求');
  await mkdir('test-evidence/m3-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-evidence/m3-review/history-desktop.png'});
  await dialog.getByRole('link',{name:'打开此版报告'}).click();await expect(page).toHaveURL(/report_id=report-v1/);await expect(page.getByRole('tab')).toHaveCount(2);await expect(page.locator('#review-workspace').getByRole('button',{name:'版本记录',exact:true})).toHaveCount(0);
  await mkdir('test-evidence/m3-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-evidence/m3-review/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'打开项目助手',exact:true}).click();await expect(page.locator('#review-agent')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-evidence/m3-review/narrow.png',fullPage:false});await page.getByRole('button',{name:'收起项目助手',exact:true}).last().click();await expect(page.locator('#review-agent')).toBeHidden();
});

test('paused review shows the actual blocker on both sides, retains execution lock and remains cancellable',async({page})=>{
  const state=fixture();state.linked=true;state.workspace.selected_report=null;state.workspace.reports=[];state.workspace.artifacts=[];
  const run={...state.makeRun('run-1','paused'),stage:'trial_limit',event_cursor:6};
  state.runs.set('old',run);state.workspace.active_run=run;state.history[0]={...state.history[0],run,report_id:null,artifacts:[]};
  const event:RunEvent={event_id:'retry-event',schema_version:1,trace_id:'trace',run_id:run.run_id,seq:5,occurred_at:'2026-10-02T11:00:00Z',stage:'provider_call',type:'run.progress',state:'running',payload:{reason:'provider_call_retrying',error_code:'MODEL_OUTPUT_SCHEMA_INVALID'}};
  state.events.set(run.run_id,[event,{...event,event_id:'paused-event',seq:6,state:'paused',stage:'trial_limit',type:'run.state_changed',payload:{reason:'model_tokens_per_user_per_day',error_code:'TRIAL_QUOTA_EXCEEDED'}}]);
  await setup(page,state);
  await expect(page.locator('.review-empty')).toContainText('复核已暂停');
  await expect(page.locator('.review-run')).toContainText('今日处理额度已用完');
  await expect(page.locator('[data-task-run="run-1"] .review-warning')).toContainText('今日处理额度已用完');
  await expect(page.locator('#review-results-panel')).not.toContainText('复核正在进行');
  await expect(page.locator('.review-run')).not.toContainText('可以明确开始下一轮');
  await expect(page.locator('[data-task-run="run-1"]')).not.toContainText('已记录处理阶段');
  await page.locator('[data-task-run="run-1"] summary').click();
  await expect(page.locator('.review-task-events')).toContainText('响应未符合成果格式');
  await expect(page.locator('.review-task-events')).toContainText('系统已准备重试');
  await page.getByRole('tab',{name:/材料与要求/}).click();
  await expect(page.getByRole('button',{name:'已有任务等待恢复',exact:true})).toBeDisabled();
  expect(state.executes).toHaveLength(0);
  await page.getByRole('tab',{name:/复核结果/}).click();
  await page.getByRole('button',{name:'停止本次任务',exact:true}).click();
  await expect(page.locator('.review-run')).toContainText('已停止');
  expect(state.workspace.active_run).toBeNull();expect(state.executes).toHaveLength(0);
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
