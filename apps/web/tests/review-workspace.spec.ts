import { expect, test, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { ReviewDraftRequestSchema, ReviewExecutionRequestSchema, ReviewMessageRequestSchema, ReviewPlanRequestSchema, isReviewReport,
  type ReviewWorkspace, type ReviewReport, type ReviewEvidenceRef, type ReviewContext, type ReviewMessageRequest,
  type ReviewExecutionRequest, type ReviewPlanRequest, type ReviewHistoryEntry, type Run } from '@bondbuddy/contracts';
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
  const state={workspace,history,owner:'owner-a',requests:[] as ReviewMessageRequest[],plans:[] as ReviewPlanRequest[],executes:[] as ReviewExecutionRequest[],runs:new Map([['old',oldRun]]),uploads:[] as Dto<'UploadCreateRequest'>[],uploadBytes:0,dropMessageOnce:false,dropExecutionOnce:false,dropUploadOnce:false,failDrafts:false,delayMessage:false,workspaceReads:0,makeRun};
  return state;
}
async function setup(page:Page,state=fixture(),routePath=`#/projects/${id}/review?tab=results`){
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
    if(path==='/me')return reply(route,200,{user_id:state.owner,session_status:'active'});
    if(path==='/projects')return reply(route,200,{items:[{...state.workspace.project,status:state.workspace.active_run?.state??'succeeded',latest_artifact:null,latest_run:null}],page:{next_cursor:null,has_more:false}});
    if(state.owner!=='owner-a')return reply(route,404,{code:'NOT_FOUND'});
    if(path===`/projects/${id}`)return reply(route,200,state.workspace.project);
    if(path.endsWith('/review-workspace')){state.workspaceReads++;return reply(route,200,state.workspace);}
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
      if(body.expected_version!==(state.workspace.plan?.version??0))return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
      const {expected_version,proposal_id,...plan}=body;state.workspace.plan={...plan,version:expected_version+1,plan_id:'plan-1',sha256:hash(JSON.stringify(body)),accepted_at:now};return reply(route,200,state.workspace.plan);
    }
    if(path.endsWith('/review-executions')){
      const body=request.postDataJSON() as ReviewExecutionRequest;expect(Value.Check(ReviewExecutionRequestSchema,body)).toBe(true);state.executes.push(body);
      let run=state.runs.get(body.execution_request_id);
      if(!run){if(state.workspace.active_run)return reply(route,409,{code:'ACTIVE_RUN_CONFLICT'});run=state.makeRun(`run-${state.runs.size+1}`,'queued',body.execution_request_id);state.runs.set(body.execution_request_id,run);state.workspace.active_run=run;state.history.push({run,operation:body.operation,version:state.history.length+1,source_report_id:body.source_report_id,report_id:null,input:structuredClone(state.workspace.draft),input_revision:state.workspace.draft.version,finding_ids:body.finding_ids,plan:structuredClone(state.workspace.plan),artifacts:[],created_at:'2026-10-02T11:00:00Z'});}
      if(state.dropExecutionOnce){state.dropExecutionOnce=false;return route.abort('connectionreset');}
      return reply(route,202,run);
    }
    if(path.startsWith('/runs/')){
      const run=[...state.runs.values()].find(r=>path.includes(`/${r.run_id}`));if(!run)return reply(route,404,{code:'NOT_FOUND'});
      if(path.endsWith('/cancel')){run.state='cancelled';state.workspace.active_run=null;}return reply(route,200,run);
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
    if(path==='/artifacts/artifact-1')return reply(route,200,{artifact_id:'artifact-1',run_id:'run-1',version:1,media_type:mime,sha256:hash('synthetic verified bytes'),quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/artifact-1/download',expires_at:'2027-01-01T00:00:00Z'});
    if(path==='/artifacts/artifact-1/download')return route.fulfill({status:200,contentType:mime,body:'synthetic verified bytes'});
    return reply(route,404,{code:'NOT_FOUND'});
  });
  await page.goto(`/${routePath}`);return state;
}
const finding=(page:Page,id:string)=>page.locator(`[data-finding-id="${id}"]`);
async function openFinding(page:Page,id:string){const card=finding(page,id);if(!await card.getAttribute('open').then(v=>v!==null))await card.locator('summary').click();return card;}

test('result buttons explain, download, plan and explicitly execute without chat; active run and empty plan are guarded',async({page})=>{
  const state=await setup(page);await expect(page.locator('#review-agent')).toBeHidden();await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#review-workspace')).not.toContainText(/充值|费用|积分|余额/);
  const card=await openFinding(page,'F01');await card.getByRole('button',{name:'查看解释'}).click();await expect(page.getByRole('dialog')).toContainText('现金流 120');expect(state.requests).toHaveLength(0);await page.getByRole('button',{name:'返回',exact:true}).click();
  await page.getByRole('button',{name:'核对修订计划'}).click();await page.getByRole('button',{name:'确认范围并执行修订'}).click();await expect(page.getByRole('dialog')).toContainText('请选择至少一项');expect(state.executes).toHaveLength(0);await page.getByRole('button',{name:'返回',exact:true}).click();
  await card.getByLabel('加入修订').check();await expect.poll(()=>state.workspace.plan?.finding_ids).toEqual(['F01']);await expect(card).toHaveAttribute('open','');
  await page.getByRole('button',{name:'核对修订计划'}).click();await page.getByRole('button',{name:'确认范围并执行修订'}).click();await expect(page.getByRole('dialog')).toContainText('确认本次执行范围');expect(state.executes).toHaveLength(0);
  state.dropExecutionOnce=true;await page.getByRole('button',{name:'执行修订',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('重试沿用同一请求');await page.getByRole('button',{name:'执行修订',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(state.executes).toHaveLength(2);expect(state.executes[0].execution_request_id).toBe(state.executes[1].execution_request_id);expect(state.runs.size).toBe(2);expect(state.requests).toHaveLength(0);
  await expect(page.getByRole('button',{name:'再次完整复核'})).toBeDisabled();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载问题报告'}).click();expect((await download).suggestedFilename()).toBe('合成问题报告.docx');
  await page.getByRole('button',{name:'停止本次任务'}).click();await expect(page.locator('.review-run')).toContainText('已停止');
  await page.getByRole('button',{name:'再次完整复核'}).click();await page.getByRole('button',{name:'开始复核',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(3);expect(state.executes[2].execution_request_id).not.toBe(state.executes[0].execution_request_id);
});

test('separate context drafts survive switching, refresh and failed sync; sending and proposals never execute or change plan until adopted',async({page})=>{
  const state=await setup(page);state.failDrafts=true;
  await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await page.locator('#review-message-input').fill('F01 的未发送草稿');
  await (await openFinding(page,'F02')).getByRole('button',{name:'继续讨论此项'}).click();await page.locator('#review-message-input').fill('F02 的未发送草稿');
  await page.reload();await page.getByRole('button',{name:'项目助手',exact:true}).click();await expect(page.locator('#review-message-input')).toHaveValue('F02 的未发送草稿');
  await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await expect(page.locator('#review-message-input')).toHaveValue('F01 的未发送草稿');state.failDrafts=false;
  state.dropMessageOnce=true;await page.getByRole('button',{name:'发送说明',exact:true}).click();await expect(page.locator('#review-assistant-status')).toContainText('原请求已保留');
  await page.getByRole('button',{name:'重试待确认原请求'}).click();await expect(page.locator('.review-proposal')).toBeVisible();expect(state.requests).toHaveLength(2);expect(state.requests[0]).toEqual(state.requests[1]);expect(state.requests[0].context).toMatchObject({project_id:id,report_id:'report-v1',finding_ids:['F01'],material_refs:[{material_id:'material-0',material_version:1},{material_id:'material-1',material_version:1}]});
  expect(state.executes).toHaveLength(0);expect(state.plans).toHaveLength(0);await page.getByRole('button',{name:'查看并采纳计划'}).click();expect(state.plans).toHaveLength(0);await page.getByRole('button',{name:'采纳计划',exact:true}).click();await expect.poll(()=>state.plans.length).toBe(1);expect(state.executes).toHaveLength(0);
  await (await openFinding(page,'F02')).getByRole('button',{name:'继续讨论此项'}).click();await expect(page.locator('#review-message-input')).toHaveValue('F02 的未发送草稿');
});

test('typing while a message saves is retained; polling preserves open findings and textarea selection',async({page})=>{
  const state=await setup(page);state.delayMessage=true;await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();
  const input=page.locator('#review-message-input');await input.fill('发送的说明');await page.getByRole('button',{name:'发送说明',exact:true}).click();await expect.poll(()=>state.requests.length).toBe(1);await input.fill('发送中继续输入的新草稿');await expect(page.locator('.review-proposal')).toBeVisible();await expect(input).toHaveValue('发送中继续输入的新草稿');
  state.workspace.active_run=state.makeRun('polling-run','queued');await page.getByRole('button',{name:'刷新项目'}).click();await expect(page.locator('.review-run')).toContainText('排队中');
  await input.focus();await input.evaluate((node:HTMLTextAreaElement)=>node.setSelectionRange(3,7));const before=state.workspaceReads;await expect.poll(()=>state.workspaceReads).toBeGreaterThan(before);
  await expect(finding(page,'F01')).toHaveAttribute('open','');await expect(input).toHaveValue('发送中继续输入的新草稿');await expect(input).toBeFocused();expect(await input.evaluate((node:HTMLTextAreaElement)=>[node.selectionStart,node.selectionEnd])).toEqual([3,7]);
  await page.getByRole('tab',{name:'材料与要求'}).click();await page.locator('#review-requirements').fill('执行中也能记录下一轮要求');await expect.poll(()=>state.workspace.draft.requirements).toEqual(['执行中也能记录下一轮要求']);await page.reload();await expect(page.locator('#review-requirements')).toHaveValue('执行中也能记录下一轮要求');
});

test('input conflicts display both versions and require explicit adoption; foreign owners cannot recover another project draft',async({page})=>{
  const state=await setup(page);await page.getByRole('tab',{name:'材料与要求'}).click();state.workspace.draft={...state.workspace.draft,version:2,requirements:['另一页面保存的服务器要求']};
  await page.locator('#review-requirements').fill('本页仍需保留的要求');await expect(page.locator('#review-materials-panel')).toContainText('服务器上的输入已有变化');expect(state.workspace.draft.requirements).toEqual(['另一页面保存的服务器要求']);
  await page.getByRole('button',{name:'核对并保存本页内容为新版'}).click();await expect(page.getByRole('dialog')).toContainText('另一页面保存的服务器要求');await expect(page.getByRole('dialog')).toContainText('本页仍需保留的要求');expect(state.workspace.draft.version).toBe(2);await page.getByRole('button',{name:'将本页内容保存为新版'}).click();await expect.poll(()=>state.workspace.draft.version).toBe(3);expect(state.executes).toHaveLength(0);
  await page.getByRole('button',{name:'项目助手',exact:true}).click();await page.locator('#review-message-input').fill('仅 owner-a 可见的草稿');state.failDrafts=true;state.owner='owner-b';await page.reload();await expect(page.getByRole('heading',{name:'项目暂时无法读取'})).toBeVisible();await expect(page.locator('body')).not.toContainText('仅 owner-a 可见的草稿');
});

test('differential report labels carried-forward findings and all-projects history remains reachable',async({page})=>{
  const state=fixture(),report=state.workspace.selected_report!;report.report_id='report-v2';report.version=2;report.scope={mode:'differential_review',finding_ids:['F01']};
  report.findings=report.findings.map(f=>({...f,report_id:'report-v2',origin_report_id:f.finding_id==='F01'?'report-v2':'report-v1',check_status:f.finding_id==='F01'?'rechecked':'carried_forward'}));report.coverage=report.coverage.map(c=>({...c,origin_report_id:c.dimension==='financial'?'report-v2':'report-v1',check_status:c.dimension==='financial'?'rechecked':'carried_forward'}));
  await setup(page,state);await expect(page.locator('.review-result-hero')).toContainText('差异复核结果');await expect(finding(page,'F02')).toContainText('沿用先前结果（report-v1）');await expect(finding(page,'F01')).toContainText('本轮核验');
  await page.goto('/#tasks?kind=review');await page.getByRole('button',{name:'版本记录',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('V1 · 完整三维复核');
});

test('latest revision downloads identify their execution and retain the source report findings',async({page})=>{
  const state=fixture();state.workspace.artifact_run={run_id:'revision-run-2',version:2,operation:'revision',source_report_id:'report-v1'};
  state.workspace.artifacts=[{artifact_id:'revision-doc',artifact_version:1,kind:'revision',filename:'synthetic-revision.docx'},{artifact_id:'clean-doc',artifact_version:1,kind:'clean',filename:'synthetic-clean.docx'}];
  await setup(page,state);await expect(page.getByRole('heading',{name:'执行版本 V2 · 按已选问题修订成果'})).toBeVisible();await expect(page.locator('#review-results-panel')).toContainText('是否通过需要再次明确复核');await expect(page.getByRole('button',{name:'下载修订版'})).toBeVisible();await expect(page.getByRole('button',{name:'下载清洁版'})).toBeVisible();await expect(finding(page,'F01')).toContainText('明确错误');expect(state.executes).toHaveLength(0);
});

test('evidence upload retries the same session and pins original finding; differential execution stays explicit',async({page})=>{
  const state=await setup(page);state.dropUploadOnce=true;await (await openFinding(page,'F02')).getByRole('button',{name:'补充材料'}).click();
  await page.getByLabel('选择 DOCX／PDF／XLSX／CSV／TXT 或图片').setInputFiles({name:'更名证明.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic name change evidence')});await page.getByRole('button',{name:'上传并保存'}).click();await expect(page.getByRole('dialog')).toContainText('可以重试原上传确认保存状态');
  await page.getByRole('button',{name:'上传并保存'}).click();await expect(page.getByRole('dialog')).toContainText('材料已补充，核对下一步');expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.workspace.draft.evidence_links).toEqual([{report_id:'report-v1',finding_id:'F02',material_ref:{material_id:'evidence-new',material_version:1,sha256:hash('Synthetic name change evidence')}}]);expect(state.executes).toHaveLength(0);expect(state.requests).toHaveLength(0);
  await page.getByRole('button',{name:'核对并重新核验'}).click();await expect(page.getByRole('dialog')).toContainText('差异复核');await page.getByRole('button',{name:'开始复核',exact:true}).click();await expect.poll(()=>state.executes.length).toBe(1);expect(state.executes[0]).toMatchObject({operation:'differential_review',source_report_id:'report-v1',finding_ids:['F02']});
});

test('workbench alone owns version history and retains stopped/failed snapshots and exact report navigation',async({page})=>{
  const state=fixture();for(const [index,status]of(['failed','cancelled'] as const).entries())state.history.push({...structuredClone(state.history[0]),version:index+2,run:state.makeRun(`run-${index+2}`,status),report_id:null,input:{...structuredClone(state.workspace.draft),requirements:[`保留的${status}版本要求`]},created_at:`2026-10-02T1${index+1}:00:00Z`});
  await setup(page,state,'#dashboard');await expect(page.locator('.review-project-card')).toBeVisible();await page.getByRole('button',{name:'版本记录',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.locator('.review-history-entry')).toHaveCount(3);await expect(dialog).toContainText('已停止');await expect(dialog).toContainText('处理失败');await dialog.getByText('查看本轮输入与处理范围',{exact:true}).first().click();await expect(dialog).toContainText('保留的cancelled版本要求');
  await mkdir('test-evidence/m3-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-evidence/m3-review/history-desktop.png'});
  await dialog.getByRole('link',{name:'打开此版报告'}).click();await expect(page).toHaveURL(/report_id=report-v1/);await expect(page.getByRole('tab')).toHaveCount(2);await expect(page.locator('#review-workspace').getByRole('button',{name:'版本记录',exact:true})).toHaveCount(0);
  await mkdir('test-evidence/m3-review',{recursive:true});await page.setViewportSize({width:1440,height:1000});await (await openFinding(page,'F01')).getByRole('button',{name:'继续讨论此项'}).click();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-evidence/m3-review/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(page.locator('#review-agent')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-evidence/m3-review/narrow.png',fullPage:false});await page.getByRole('button',{name:'收起项目助手',exact:true}).last().click();await expect(page.locator('#review-agent')).toBeHidden();
});
