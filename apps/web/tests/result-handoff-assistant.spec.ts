import {expect,test,type Page,type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {FormatRegistry,type TSchema} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {AssistantCardRequestSchema,M4_DOCUMENT_TYPES,M4DocumentManifestSchema,M4DraftInputSchema,M4ViewStateSchema,
  ReviewDraftInputSchema,STREAM_LIMITS,emptyUpdateDetails,isReviewReport,schemas,
  type AssistantCard,type M4Artifact,type M4Draft,type M4Task,type M4Workspace,type ReviewHistoryEntry,type ReviewReport,type ReviewWorkspace,type Run} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {taskPage} from './collection-fixtures';

// Synthetic owner-scoped HTTP data, real main.ts navigation and result consumers.
// This does not execute a model, prove DOCX quality, settle credits or contact a service.
const ids={owner:'result-handoff-owner',topic:'result-handoff-assistant-topic',scope:'result-handoff-assistant-scope',project:'result-handoff-project'};
const now='2026-10-25T08:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const runId=(version:number)=>`result-handoff-run-${version}`;
const reportId=(version:number)=>`result-handoff-report-${version}`;
const artifactId=(version:number)=>`result-handoff-artifact-${version}`;
const marker=(version:number)=>`合成原任务第${version}轮专属内容`;
FormatRegistry.Set('date-time',value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
function check(schema:TSchema,value:unknown){expect(Value.Check(schema,value),JSON.stringify([...Value.Errors(schema,value)])).toBe(true);}
const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,json:body});
type Operation=AssistantCard['operation'];
type Call={method:string;path:string;search:string};

function fixture(operation:Operation,oldState:Run['state']='succeeded'){
  const project:Dto<'ProjectResponse'>={project_id:operation==='generation'?ids.scope:ids.project,name:'合成准确任务交接项目',
    kind:operation==='generation'?'qa':operation,issuer_name:'合成发行人',market:'sse',offering:'private',
    draft_revision:2,input_revision:2,input_hash:hash('input-2'),updated_at:now,
    ...(operation==='update'?{update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1' as const,reporting_cutoff:'2026-09-30'}}:{})};
  const scope:Dto<'ProjectResponse'>={...project,project_id:ids.scope,kind:'qa',name:'合成助手原对话'};
  const makeRun=(version:number,state:Run['state']):Run=>({run_id:runId(version),project_id:project.project_id,
    execution_request_id:`result-handoff-request-${version}`,input_revision:version,input_hash:hash(`input-${version}`),
    channel:'production',test_grant_id:null,uncovered_items:[],state,
    stage:state==='paused'?'user_paused':state==='running'?'model_generation':null,event_cursor:0,
    billing_mode:'platform_trial',reservation_id:null,artifact_id:state==='succeeded'?artifactId(version):null,
    prompt_snapshot_ref:null,updated_at:`2026-10-25T0${version}:00:00Z`});
  const old=makeRun(1,oldState),latest=makeRun(2,'succeeded');
  // A paused/running task cannot coexist with a later submitted task in the same
  // project. In those journeys the other success is the prior reading result.
  if(oldState==='paused'||oldState==='running'){
    old.input_revision=2;old.input_hash=hash('input-2');old.updated_at='2026-10-25T03:00:00Z';
    latest.input_revision=1;latest.input_hash=hash('input-1');latest.updated_at='2026-10-25T01:00:00Z';
  }
  const runs=[latest,old].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
  const bytes=new Map<string,Buffer>(),metadata=new Map<string,Dto<'ArtifactResponse'>>();
  for(const run of runs)if(run.artifact_id){const payload=Buffer.from(`Synthetic original run ${run.run_id} document bytes.`);bytes.set(run.artifact_id,payload);
    metadata.set(run.artifact_id,{filename:`合成项目_${operation}_V${run.input_revision}_20261025.docx`,display_version:run.input_revision,
      artifact_id:run.artifact_id,run_id:run.run_id,version:1,media_type:mime,sha256:hash(payload),quality_status:'passed',delivery_status:'available',
      download_url:`/api/v1/artifacts/${run.artifact_id}/download`,expires_at:'2027-01-01T00:00:00Z'});}
  const draft=(type:M4Draft['document_type']):M4Draft=>({document_type:type,version:2,sha256:hash(`draft-${type}`),updated_at:now,
    source_material:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',offering:'private'},requirements:[]});
  const drafts=Object.fromEntries(M4_DOCUMENT_TYPES.map(type=>[type,draft(type)])) as M4Workspace['drafts'];
  const material:Dto<'MaterialResponse'>={material_id:'result-handoff-source',material_version:1,upload_id:'result-handoff-upload',role:'historical',
    filename:'合成复核原稿.docx',media_type:mime,byte_size:100,sha256:hash('source'),state:'persisted',persisted_at:now,error:null};
  const pin={material_id:material.material_id,material_version:1,sha256:material.sha256};
  const reviewDraft:ReviewWorkspace['draft']={version:2,source_material_ref:pin,material_versions:[pin],requirements:['保留合成原稿及待核事项。'],as_of:null,evidence_links:[]};
  const reports=new Map<string,ReviewReport>();
  const history:ReviewHistoryEntry[]=runs.map(run=>{
    const version=run.input_revision,report_id=run.state==='succeeded'?reportId(version):null;
    if(report_id)reports.set(report_id,{report_id,project_id:project.project_id,run_id:run.run_id,input_revision:version,version,
      source_material:pin,scope:{mode:'full_review',finding_ids:[]},findings:[{finding_id:`handoff-finding-${version}`,report_id,
        dimension:'financial',conclusion:'needs_evidence',severity:'P2',title:marker(version),description:'合成待核事项。',target_refs:[],evidence_refs:[],limitations:['Synthetic，仅验证原任务交接。'],
        repairability:{can_revise:false,reason:'合成测试不提供业务修订依据。',allowed_record_ids:[]},origin_report_id:report_id,check_status:'rechecked'}],
      coverage:[],limitations:['Synthetic，仅验证原任务交接。'],created_at:run.updated_at});
    const artifact=run.artifact_id?metadata.get(run.artifact_id)!:undefined;
    return {run,operation:'full_review',version,source_report_id:null,report_id,input:{source_material_ref:pin,material_versions:[pin],requirements:[marker(version)],as_of:null,evidence_links:[]},
      input_revision:version,finding_ids:[],plan:null,artifacts:artifact?[{artifact_id:artifact.artifact_id,artifact_version:1,kind:'report',filename:artifact.filename!}]:[],created_at:run.updated_at};
  });
  const artifacts:M4Artifact[]=operation==='generation'?[...runs].reverse().flatMap(run=>run.artifact_id?[{source_project_id:ids.scope,artifact_id:run.artifact_id,artifact_version:1,
    sha256:metadata.get(run.artifact_id)!.sha256,topic_id:ids.topic,run_id:run.run_id,document_type:'private_summary',kind:'document',filename:metadata.get(run.artifact_id)!.filename!,
    mime_type:mime,byte_size:bytes.get(run.artifact_id)!.length,created_at:run.updated_at,base_artifact:null,input_hash:run.input_hash,revision_number:run.input_revision}]:[]):[];
  const tasks:M4Task[]=operation==='generation'?[...runs].reverse().map(run=>({run,created_at:run.updated_at,events:[],artifacts:artifacts.filter(a=>a.run_id===run.run_id),
    credit_charge:{quote:null,state:null},manifest:{version:'m4-document-input-v1',kind:'document',project_name:scope.name,topic_id:ids.topic,execution_scope_project_id:ids.scope,
      draft_version:run.input_revision,input:{...drafts.private_summary,supplemental_requirements:marker(run.run_id===old.run_id?1:2)},
      template_material:null,market:'sse',offering:'private',billing_task:'m4_G05'}})):[];
  // A draft's persistence envelope is not part of the immutable manifest input.
  for(const task of tasks)if(task.manifest.kind==='document'){const {version:_v,sha256:_s,updated_at:_u,...input}=task.manifest.input as M4Draft;task.manifest.input=input;}
  const latestArtifact=artifacts.find(a=>a.run_id===latest.run_id);
  const active=oldState==='paused'||oldState==='running'?old:null;
  const workspace:M4Workspace={topic:{topic_id:ids.topic,project_id:ids.scope,source_project_id:null,name:scope.name,surface:'assistant',created_at:now,updated_at:now},project:scope,
    drafts,materials:[],material_details:[],templates:[],messages:[],tasks,artifacts,pending_requirements:[],active_run:operation==='generation'?active:null,
    view:{version:0,selected_document_type:'private_summary',open_tabs:latestArtifact?[{source_project_id:ids.scope,artifact_id:latestArtifact.artifact_id,artifact_version:1,sha256:latestArtifact.sha256}]:[],
      active_tab:latestArtifact?{source_project_id:ids.scope,artifact_id:latestArtifact.artifact_id,artifact_version:1,sha256:latestArtifact.sha256}:null,
      workspace_tab:latestArtifact?`artifact:${latestArtifact.artifact_id}:1`:'input',unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},
      assistant:{project_id:null,action:null}}};
  const cards:AssistantCard[]=[...runs].reverse().map(run=>({card_id:`result-handoff-card-${run.run_id===old.run_id?1:2}`,operation,project_id:project.project_id,
    execution_request_id:run.execution_request_id,created_at:run.updated_at,project_name:project.name,draft_token:null,
    target:{issuer_name:'合成发行人',market:'sse',offering:'private',reporting_cutoff:'2026-09-30'},requirements:marker(run.run_id===old.run_id?1:2),material_names:[material.filename],
    baseline:null,quote:null,balance:{available:100000,frozen:0},run,...(operation==='generation'?{document_type:'private_summary' as const,expected_draft_version:run.input_revision}:operation==='update'?{input_revision:run.input_revision,input_hash:run.input_hash}:{expected_input_version:run.input_revision})}));
  return {operation,project,scope,old,latest,runs,workspace,cards,history,reports,reviewDraft,material,metadata,bytes,active,
    calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],previewReads:[] as string[],reportReads:[] as string[],downloadReads:[] as string[]};
}
type State=ReturnType<typeof fixture>;

function validate(s:State){
  check(schemas.ProjectResponse,s.project);check(schemas.ProjectResponse,s.scope);check(schemas.MaterialResponse,s.material);
  s.runs.forEach(run=>check(schemas.RunResponse,run));s.metadata.forEach(value=>check(schemas.ArtifactResponse,value));
  const {version:_v,...reviewInput}=s.reviewDraft;check(ReviewDraftInputSchema,reviewInput);
  s.reports.forEach(value=>expect(isReviewReport(value)).toBe(true));
  const {version:_view,...view}=s.workspace.view;check(M4ViewStateSchema,view);
  Object.values(s.workspace.drafts).forEach(value=>{const {version:_v,sha256:_s,updated_at:_u,...input}=value;check(M4DraftInputSchema,input);});
  s.workspace.tasks.forEach(task=>check(M4DocumentManifestSchema,task.manifest));
  for(const card of s.cards){const request={card_id:card.card_id,operation:card.operation,project_id:card.project_id,execution_request_id:card.execution_request_id,
    ...(card.operation==='generation'?{document_type:card.document_type,expected_draft_version:card.expected_draft_version}:card.operation==='update'?{input_revision:card.input_revision,input_hash:card.input_hash}:{expected_input_version:card.expected_input_version})};check(AssistantCardRequestSchema,request);}
}

async function install(page:Page,s:State){
  validate(s);page.on('pageerror',error=>s.errors.push(error.message));
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length),method=request.method();s.calls.push({method,path,search:url.search});
    if(method==='GET'){
      if(path==='/me')return json(route,{user_id:ids.owner,session_status:'active'});
      if(path==='/account')return json(route,{user_id:ids.owner,username:'synthetic_handoff_owner',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
      if(path==='/credits/balance')return json(route,{enabled:false,available:100000,frozen:0});
      if(path==='/projects')return json(route,{items:[],page:{has_more:false,next_cursor:null}});
      if(path==='/m4/topics')return json(route,{topics:[s.workspace.topic]});
      if(path===`/m4/topics/${ids.topic}/workspace`)return json(route,s.workspace);
      if(path===`/assistant/topics/${ids.topic}/cards`)return json(route,{cards:s.cards});
      if(path===`/projects/${ids.scope}`)return json(route,s.scope);
      if(path===`/projects/${ids.project}`)return json(route,s.project);
      if(/^\/projects\/[^/]+\/tasks$/.test(path))return json(route,taskPage(s.project.project_id,s.runs,s.operation==='generation'?'generation':s.operation));
      if(/^\/projects\/[^/]+\/prospectus-versions$/.test(path))return json(route,{project_id:s.project.project_id,current_version_id:null,selection_revision:0,inactive_material_ids:[],versions:[]});
      if(/^\/projects\/[^/]+\/events$/.test(path))return json(route,{items:[],next_cursor:null});
      if(/^\/projects\/[^/]+\/messages$/.test(path)){const value={conversation_id:'handoff-conversation',items:[],project_message_set_ref:{version:1,content_sha256:hash('empty-message-set'),message_ids:[]},next_cursor:null,has_more:false};check(schemas.ProjectMessagePage,value);return json(route,value);}
      const input=path.match(/^\/projects\/[^/]+\/input-revisions\/(\d+)$/);
      if(input){const revision=Number(input[1]),value:Dto<'InputRevisionResponse'>={project_id:s.project.project_id,input_revision:revision,input_hash:hash(`input-${revision}`),material_versions:[],
        target_confirmation:{status:'unconfirmed',market:null,offering:null,as_of:null,document_purpose:null,target_reporting_periods:[],confirmed_at:null,confirmed_by:null},rule_pack_version:null,template_version:null,reference_release:null,created_at:now};check(schemas.InputRevisionResponse,value);return json(route,value);}
      if(path===`/projects/${ids.project}/review-history`)return json(route,{items:s.history});
      if(path===`/projects/${ids.project}/review-workspace`){
        const requested=url.searchParams.get('report_id');if(requested)s.reportReads.push(requested);
        const report=requested?s.reports.get(requested):s.reports.get(reportId(2));
        const entry=s.history.find(item=>item.run.run_id===report?.run_id)??s.history[0];
        const timeline:ReviewWorkspace['timeline']=s.history.map(item=>({kind:'task',entry_id:`task:${item.run.run_id}`,created_at:item.created_at,
          task:{run:item.run,operation:item.operation,version:item.version,input_version:item.input_revision,input_revision:item.input_revision,input_sha256:item.run.input_hash,
            source_report_id:null,report_id:item.report_id,finding_ids:[],origin:{version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null},artifacts:item.artifacts,events:[]}}));
        const value:ReviewWorkspace={project:s.project,materials:[s.material],draft:s.reviewDraft,message_drafts:[],active_run:s.active,
          selected_report:report??null,reports:[...s.reports.values()].map(item=>({report_id:item.report_id,version:item.version,run_id:item.run_id,created_at:item.created_at})),
          messages:[],plan:null,artifacts:entry.artifacts,artifact_run:{run_id:entry.run.run_id,version:entry.version,operation:entry.operation,source_report_id:null},timeline};
        return json(route,value);
      }
      const readable=path.match(/^\/projects\/[^/]+\/review-executions\/([^/]+)\/readable-report$/);
      if(readable)return json(route,{code:'NOT_FOUND',message:'Synthetic structured report fixture',retryable:false,correlation_id:'handoff-readable',field_errors:[]},404);
      const run=path.match(/^\/runs\/([^/]+)$/);
      if(run){const value=s.runs.find(item=>item.run_id===run[1]);return json(route,value??{code:'NOT_FOUND'},value?200:404);}
      if(s.operation==='update'&&s.old.state==='paused'&&path===`/runs/${s.old.run_id}/stream`){
        expect(url.search).toBe('');
        // Mirror the public bounded SSE protocol for this known original run:
        // snapshot without a cursor, no invented persisted events, then stream end.
        return route.fulfill({contentType:'text/event-stream; charset=utf-8',headers:{'cache-control':'private, no-store'},
          body:`retry: ${STREAM_LIMITS.retryMs}\n\nevent: snapshot\ndata: ${JSON.stringify(s.old)}\n\n: keepalive\n\nevent: stream.end\ndata: ${JSON.stringify({reason:'max_duration',last_event_id:null})}\n\n`});
      }
      if(/^\/runs\/[^/]+\/events$/.test(path))return json(route,{items:[],next_cursor:null});
      if(/^\/runs\/[^/]+\/credit-charge$/.test(path))return json(route,{quote:null,state:null});
      const artifact=path.match(/^\/artifacts\/([^/]+)$/);
      if(artifact){const value=s.metadata.get(artifact[1]);return json(route,value??{code:'NOT_FOUND'},value?200:404);}
      const download=path.match(/^\/artifacts\/([^/]+)\/download$/);
      if(download){s.downloadReads.push(download[1]);return route.fulfill({contentType:mime,body:s.bytes.get(download[1])!});}
      const preview=path.match(/^\/m4\/artifacts\/([^/]+)\/versions\/1\/preview$/);
      if(preview){s.previewReads.push(preview[1]);const artifact=s.workspace.artifacts.find(item=>item.artifact_id===preview[1]);return json(route,{artifact,content:marker(artifact!.revision_number!)});}
      const m4Download=path.match(/^\/m4\/artifacts\/([^/]+)\/versions\/1\/bytes$/);
      if(m4Download){s.downloadReads.push(m4Download[1]);return route.fulfill({contentType:mime,body:s.bytes.get(m4Download[1])!});}
    }
    s.unexpected.push(`${method} ${path}${url.search}`);return json(route,{code:'DATA_UNAVAILABLE',message:'Unexpected synthetic handoff request',retryable:false,correlation_id:'handoff',field_errors:[]},500);
  });
  await page.goto('/#dashboard');
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('[data-card="result-handoff-card-1"]')).toContainText(marker(1));
}
async function openOld(page:Page,s:State,label:string){
  const link=page.locator('[data-card="result-handoff-card-1"]').getByRole('link',{name:label,exact:true});
  await expect(link).toHaveAttribute('data-assistant-task-run',s.old.run_id);
  await link.click();await page.locator('.ba-header [data-a="toggle"]').click();
}
function clean(s:State){expect(s.unexpected).toEqual([]);expect(s.errors).toEqual([]);expect(s.calls.filter(call=>call.method!=='GET')).toEqual([]);}
async function downloadBytes(page:Page,selector:string){const pending=page.waitForEvent('download');await page.locator(selector).click();const download=await pending;return {name:download.suggestedFilename(),bytes:await readFile((await download.path())!)};}

test('assistant historical review card opens its original structured report despite a newer result and survives reload',async({page})=>{
  const s=fixture('review');await install(page,s);await openOld(page,s,'查看结果');
  await expect(page.locator('#review-results-panel')).toContainText(marker(1));await expect(page.locator('#review-results-panel')).not.toContainText(marker(2));
  expect(s.reportReads).toContain(reportId(1));
  await page.reload();await expect(page.locator('#review-results-panel')).toContainText(marker(1));
  const downloaded=await downloadBytes(page,'#review-results-panel [data-review-action="download"]');
  expect(downloaded.name).toBe(s.metadata.get(artifactId(1))!.filename);expect(downloaded.bytes).toEqual(s.bytes.get(artifactId(1)));clean(s);
});

test('assistant historical update card opens the original delivered artifact and downloads its original bytes',async({page})=>{
  const s=fixture('update');await install(page,s);await openOld(page,s,'查看结果');
  await expect(page.locator('.artifact-page')).toHaveCount(2);await expect(page.locator('.page-heading')).toContainText('第 1 版');
  expect(s.calls.some(call=>call.path===`/runs/${runId(1)}`)).toBe(true);
  expect(s.calls.some(call=>call.path===`/runs/${runId(2)}`)).toBe(false);
  const downloaded=await downloadBytes(page,'[data-artifact-file="0"]');expect(downloaded.bytes).toEqual(s.bytes.get(artifactId(1)));
  await page.reload();await expect(page.locator('.page-heading')).toContainText('第 1 版');clean(s);
});

test('assistant historical generation card opens its exact assistant-topic result instead of the saved newer reading tab',async({page})=>{
  const s=fixture('generation');await install(page,s);await openOld(page,s,'查看结果');
  await expect(page.locator('#m4-tabs [aria-selected="true"]')).toHaveAttribute('data-key',`run:${runId(1)}`);
  await expect(page.locator('#m4-content')).toContainText(s.metadata.get(artifactId(1))!.filename!);
  await expect(page.locator('#m4-content')).not.toContainText(s.metadata.get(artifactId(2))!.filename!);
  await expect.poll(()=>s.previewReads).toContain(artifactId(1));
  const downloaded=await downloadBytes(page,'#m4-content [data-m4-action="download"]');expect(downloaded.bytes).toEqual(s.bytes.get(artifactId(1)));
  await page.reload();await expect(page.locator('#m4-content')).toContainText(s.metadata.get(artifactId(1))!.filename!);clean(s);
});

test('assistant failed review card opens its own task state rather than newer result',async({page})=>{
    const s=fixture('review','failed');await install(page,s);await openOld(page,s,'查看原因');
    await expect(page.locator('#review-tab-making')).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#review-making-panel')).toContainText('第 1 轮');
    await expect(page.locator('#review-making-panel')).not.toContainText('第 2 轮');
    await page.reload();await expect(page.locator('#review-making-panel')).toContainText('第 1 轮');clean(s);
});
test('assistant paused update card reads its original run while a prior result remains available',async({page})=>{
    const s=fixture('update','paused');await install(page,s);await openOld(page,s,'查看任务');
    await expect(page.locator('#execution-progress .run-status-card')).toBeVisible();
    await expect.poll(()=>s.calls.some(call=>call.path===`/runs/${runId(1)}`)).toBe(true);
    expect(s.calls.some(call=>call.path===`/runs/${runId(2)}`)).toBe(false);
    await expect(page.locator('#resume-run')).toBeVisible();clean(s);
});
test('assistant running generation card opens its own fixed input and controls instead of the prior result',async({page})=>{
    const s=fixture('generation','running');await install(page,s);await openOld(page,s,'查看进度');
    await expect(page.locator('#m4-content [data-run-id]')).toHaveAttribute('data-run-id',runId(1));
    await page.locator('#m4-content .m4-fixed-input summary').click();await expect(page.locator('#m4-content .m4-fixed-input')).toContainText(marker(1));
    await expect(page.locator('#m4-content .m4-fixed-input')).not.toContainText(marker(2));
    await expect(page.locator('#m4-content [data-m4-action="pause"]')).toHaveAttribute('data-run',runId(1));clean(s);
});
