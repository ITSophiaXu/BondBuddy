import {fixtureBody,serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureJson,fixtureRequest} from './billing-fixture-wire';
import {expect,type Page,type Route} from '@playwright/test';
import {PROJECT_QA_PRICE,schemas,type ProjectFileAsset,type QaDraft,type QaInput,type QaQuestion,type QaResult,type QaRun,type QaWorkspace} from '@bondbuddy/contracts';
import {FormatRegistry} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Dto} from './billing-fixture-wire';
import {taskPage} from './collection-fixtures';

// Synthetic public HTTP fixtures. These tests do not generate, inspect or deliver
// Word bytes, call a model, settle credits, or assert a production worker result.
export const projectId='synthetic-qa-continuation-a',otherProjectId='synthetic-qa-continuation-b';
export const ownerId='synthetic-qa-owner-a',otherOwnerId='synthetic-qa-owner-b';
export const prepareId='synthetic-qa-prepare-1',answerId='synthetic-qa-answer-5',otherAnswerId='synthetic-qa-answer-9';
export const now='2026-10-25T06:00:00Z';
FormatRegistry.Set('date-time',value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export type Call={method:string;path:string;search:string;body?:unknown};
type DraftRequest=Dto<'QaDraftRequest'>;
type AnswerRequest=Dto<'QaAnswerRequest'>;
type PrepareRequest=Dto<'QaPrepareRequest'>;
type Accepted={body:AnswerRequest|PrepareRequest;run:QaRun;generic:Dto<'RunResponse'>};
export const source:ProjectFileAsset={kind:'material',pin:{source_project_id:projectId,material_id:'synthetic-question-word',material_version:2,sha256:sha('source-word-v2')}};
export const oldMaterial:ProjectFileAsset={kind:'material',pin:{source_project_id:projectId,material_id:'synthetic-business-report',material_version:2,sha256:sha('business-v2')}};
export const newMaterial:ProjectFileAsset={kind:'material',pin:{source_project_id:projectId,material_id:'synthetic-business-report',material_version:3,sha256:sha('business-v3')}};
export const oldArtifact:ProjectFileAsset={kind:'artifact',pin:{source_project_id:projectId,artifact_id:'synthetic-prospectus-clean',artifact_version:4,sha256:sha('prospectus-clean-v4')}};
const texts=['合成问题清单','以下问题均为浏览器测试合成资料。','请说明本期偿债资金来源。','请列示现金流与预计偿付安排。','请说明收入变动原因。','本段为原清单保留的说明。','补充核查事项','请说明关联交易的定价依据。','请补充主要交易对手及报告期明细。'];
export const snapshot:QaResult['snapshot']={version:'project-file-text-v1',sha256:source.pin.sha256,format:'docx',
  spans:texts.map((text,index)=>({id:`p${index}`,text,location:`原文段落 ${index+1}`,sha256:sha(text)})),warnings:[],coverage:'complete'};
export const questions:QaQuestion[]=[[2,3],[4,4],[7,8]].map(([start,end])=>({id:`q${start}`,start,end,question:texts.slice(start,end+1).join('\n').trim()}));
const evidence:QaResult['evidence']=[{filename:'合成业务报告_v2.pdf',snapshot:{version:'project-file-text-v1',sha256:oldMaterial.pin.sha256,format:'pdf',
  spans:[{id:'revenue-p1',text:'合成收入变动依据，仅用于界面测试。',location:'第 1 页',sha256:sha('revenue-evidence')}],warnings:[],coverage:'complete'}}];
export function originalDraft():QaDraft{return {preparation_id:prepareId,questions:[structuredClone(questions[1])],materials:[structuredClone(newMaterial)],requirements:'服务器当前草稿，与历史回答不同。',use_knowledge:false};}
function input(operation:'prepare'|'answer',selected:QaQuestion[]=questions,materials:ProjectFileAsset[]=[oldMaterial,oldArtifact],requirements='保留历史要求：逐题说明依据与待补材料。'):QaInput{
  return {version:'project-qa-v1',operation,project_name:'合成 QA 续答项目',source:{filename:'合成问题清单_v2.docx',asset:structuredClone(source)},preparation_id:operation==='prepare'?null:prepareId,
    questions:operation==='prepare'?[]:structuredClone(selected),materials:operation==='prepare'?[]:materials.map(asset=>({filename:asset.kind==='artifact'?'合成募集书_清洁版_v4.docx':asset.pin.sha256===newMaterial.pin.sha256?'合成业务报告_v3.pdf':'合成业务报告_v2.pdf',asset:structuredClone(asset)})),
    requirements:operation==='prepare'?'':requirements,cases:[],price_version:PROJECT_QA_PRICE.version,points:operation==='prepare'?0:selected.length*PROJECT_QA_PRICE.points};
}
function result(manifest:QaInput):QaResult{
  return {version:'project-qa-result-v1',input_hash:sha(JSON.stringify(manifest)),document:{key:`synthetic/${manifest.operation}.docx`,sha256:sha(`${manifest.operation}-document`),byte_size:2048},
    snapshot:structuredClone(snapshot),questions:manifest.operation==='prepare'?questions.map(question=>({...structuredClone(question),end:question.start,question:texts[question.start].trim()})):structuredClone(manifest.questions),answers:manifest.operation==='prepare'?[]:manifest.questions.map(question=>({question_id:question.id,
      answer:question.id==='q4'?'合成回答草稿，仍需人工审阅。':`本题缺少可定位的项目资料：${question.id}`,status:question.id==='q4'?'draft':'missing',
      missing_materials:question.id==='q4'?[]:[question.id==='q2'?'请补充偿债资金与现金流安排。':'请补充关联交易明细及定价依据。'],
      citations:question.id==='q4'?[{asset_index:0,span_id:'revenue-p1',quote:evidence[0].snapshot.spans[0].text}]:[],case_ids:[],approach:''})),
    warnings:[],evidence:manifest.operation==='prepare'?[]:structuredClone(evidence)};
}
export function completed(manifest:QaInput,runId:string,sequence:number):QaRun{return {run_id:runId,sequence,operation:manifest.operation,state:'succeeded',stage:null,created_at:now,
  manifest,result:result(manifest),artifact_id:manifest.operation==='answer'?`synthetic-artifact-${sequence}`:null,reserved_points:0,charged_points:manifest.points};}
function project(id:string):Dto<'ProjectResponse'>{return {project_id:id,name:id===projectId?'合成 QA 续答项目':'另一个合成 QA 项目',kind:'generation',issuer_name:'合成发行人有限公司',market:'sse',offering:'private',draft_revision:3,input_revision:null,input_hash:null,updated_at:now};}
export function fixture(){
  const prepared=completed(input('prepare'),prepareId,1),answer=completed(input('answer'),answerId,5),other=completed(input('answer',questions,[newMaterial],'另一历史轮要求：核对业务报告第三版。'),otherAnswerId,9);
  const workspace:QaWorkspace={draft:originalDraft(),revision:10,price:PROJECT_QA_PRICE,runs:[other,answer,prepared],prospectus:{project_id:projectId,version_id:'prospectus-v4',selection_revision:4,sequence:4,filename:'合成募集书_清洁版_v4.docx',asset:structuredClone(oldArtifact)},materials:[
    {filename:'合成业务报告_v2.pdf',asset:structuredClone(oldMaterial)},{filename:'合成募集书_清洁版_v4.docx',asset:structuredClone(oldArtifact)},{filename:'合成业务报告_v3.pdf',asset:structuredClone(newMaterial)}]};
  const otherWorkspace:QaWorkspace={draft:{preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:true},revision:0,price:PROJECT_QA_PRICE,runs:[],materials:[]};
  return {owner:ownerId,workspace,otherWorkspace,project:project(projectId),otherProject:project(otherProjectId),calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],
    drafts:[] as DraftRequest[],answers:[] as AnswerRequest[],prepares:[] as PrepareRequest[],accepted:new Map<string,Accepted>(),
    dropDraft:false,dropAnswer:undefined as 'before'|'after'|undefined,dropPrepare:undefined as 'before'|'after'|undefined,
    rejectAnswer:undefined as 'CREDITS_INSUFFICIENT'|'INPUT_REVISION_CONFLICT'|'QUOTE_CHANGED'|undefined,
    workspaceRead:undefined as QaWorkspace|undefined,omitRequestedRun:false,allowUploads:false,uploads:[] as Dto<'UploadCreateRequest'>[],uploadBytes:0,
    uploadMaterial:undefined as Dto<'MaterialResponse'>|undefined,available:10000};
}
export type State=ReturnType<typeof fixture>;
const installed=new WeakMap<Page,State>();
export function checked<K extends keyof typeof schemas>(name:K,value:unknown):asserts value is Dto<K>{expect(Value.Check(schemas[name],value),`${name}: ${JSON.stringify([...Value.Errors(schemas[name],value)])}`).toBe(true);}
async function reply<K extends keyof typeof schemas>(route:Route,name:K,body:Dto<K>,status=200){checked(name,body);await route.fulfill({status,contentType:'application/json',body:fixtureJson(route,body)});}
const problem=(route:Route,status:number,code:string)=>route.fulfill({status,json:fixtureBody(route,{code})});
export const writes=(state:State)=>state.calls.filter(call=>call.method!=='GET');
export const qaWrites=(state:State)=>writes(state).filter(call=>call.path.includes('/qa/'));
export const workspaceReads=(state:State)=>state.calls.filter(call=>call.method==='GET'&&call.path===`/projects/${projectId}/qa`);
export const historicalRecords=(state:State)=>structuredClone(state.workspace.runs.filter(run=>[prepareId,answerId,otherAnswerId].includes(run.run_id)));
function queued(state:State,body:AnswerRequest|PrepareRequest,operation:'answer'|'prepare'):Accepted{
  const manifest=operation==='answer'?input('answer',state.workspace.draft.questions,state.workspace.draft.materials,state.workspace.draft.requirements):input('prepare');
  if(operation==='prepare')manifest.source={filename:state.uploadMaterial?.filename??'合成问题清单_v2.docx',asset:structuredClone((body as PrepareRequest).source)};
  const sequence=Math.max(...state.workspace.runs.map(run=>run.sequence))+1,runId=`synthetic-qa-${operation}-${sequence}`;
  const run:QaRun={run_id:runId,sequence,operation,state:'queued',stage:'queued',created_at:now,manifest,result:null,artifact_id:null,reserved_points:manifest.points,charged_points:0};
  const generic:Dto<'RunResponse'>={run_id:runId,execution_request_id:`qa-${operation}:${body.request_id}`,project_id:projectId,input_revision:100+sequence,input_hash:sha(JSON.stringify(manifest)),channel:'production',test_grant_id:null,
    uncovered_items:[],state:'queued',stage:'queued',event_cursor:0,billing_mode:'fixed_credits',reservation_id:operation==='answer'?`synthetic-reservation-${sequence}`:null,artifact_id:null,prompt_snapshot_ref:null,updated_at:now};
  state.workspace.runs.unshift(run);return {body:structuredClone(body),run,generic};
}
export async function install(page:Page,state=fixture()){
  installed.set(page,state);page.on('pageerror',error=>state.errors.push(error.message));
  await page.context().route('**/synthetic-qa-upload',async route=>{
    if(state.allowUploads&&route.request().method()==='PUT'){state.uploadBytes++;return route.fulfill({status:204,body:''});}
    state.unexpected.push(`BINARY ${route.request().method()} ${route.request().url()}`);return route.abort();
  });
  await page.context().route('https://synthetic.invalid/**',async route=>{state.unexpected.push(`BINARY ${route.request().method()} ${route.request().url()}`);return route.abort();});
  await page.context().route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
    const body:unknown=request.postData()&&request.headers()['content-type']?.includes('application/json')?fixtureRequest(request):undefined;
    state.calls.push({method,path,search:url.search,...(body===undefined?{}:{body:structuredClone(body)})});
    if(method==='GET'&&path==='/commerce/catalog')return route.fulfill({status:404,json:fixtureBody(route,{code:'NOT_FOUND'})});
    if(method==='GET'&&path==='/me')return reply(route,'MeResponse',{user_id:state.owner,session_status:'active'});
    if(method==='GET'&&path==='/auth/recovery/info')return reply(route,'RecoveryInfoResponse',{enabled:false,support_contact:null,link_minutes:30});
    if(method==='GET'&&path==='/account')return reply(route,'AccountResponse',{user_id:state.owner,username:'synthetic_qa',phone_masked:null,status:'active',created_at:now,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(method==='GET'&&path==='/credits/balance')return reply(route,'CreditBalanceResponse',{enabled:true,available:state.available,frozen:0});
    if(method==='GET'&&path==='/m4/topics')return problem(route,503,'DATA_UNAVAILABLE');
    if(method==='GET'&&path==='/projects')return reply(route,'ProjectListResponse',{items:state.owner===ownerId?[state.project,state.otherProject].map(p=>({project_id:p.project_id,name:p.name,draft_revision:p.draft_revision,updated_at:now,kind:p.kind,issuer_name:p.issuer_name,market:p.market,offering:p.offering,latest_run:null,latest_artifact:null})):[],page:{has_more:false,next_cursor:null}});
    const projectMatch=path.match(/^\/projects\/([^/]+)(.*)$/);
    if(projectMatch){const id=projectMatch[1],suffix=projectMatch[2];
      if(state.owner!==ownerId||![projectId,otherProjectId].includes(id))return problem(route,404,'NOT_FOUND');
      const p=id===projectId?state.project:state.otherProject,w=id===projectId?state.workspace:state.otherWorkspace;
      if(method==='GET'&&suffix==='')return reply(route,'ProjectResponse',p);
      if(method==='GET'&&suffix==='/tasks')return reply(route,'ProjectTasksResponse',taskPage(id,[],'generation'));
      if(method==='GET'&&suffix==='/qa'){
        const response=structuredClone(id===projectId?state.workspaceRead??w:w);
        if(state.omitRequestedRun&&url.searchParams.has('run_id'))response.runs=response.runs.filter(run=>run.run_id!==url.searchParams.get('run_id'));
        return reply(route,'QaWorkspaceResponse',response);
      }
      if(id===projectId&&method==='POST'&&suffix==='/qa/draft'){
        checked('QaDraftRequest',body);state.drafts.push(structuredClone(body));
        if(body.expected_revision!==state.workspace.revision)return problem(route,409,'INPUT_REVISION_CONFLICT');
        state.workspace.draft=structuredClone(body.draft);state.workspace.revision++;
        if(state.dropDraft){state.dropDraft=false;return route.abort('connectionreset');}
        return reply(route,'QaWorkspaceResponse',state.workspace);
      }
      if(id===projectId&&method==='POST'&&(suffix==='/qa/runs'||suffix==='/qa/prepare')){
        const operation=suffix.endsWith('/runs')?'answer':'prepare';
        if(operation==='answer'){checked('QaAnswerRequest',body);state.answers.push(structuredClone(body));}else{checked('QaPrepareRequest',body);state.prepares.push(structuredClone(body));}
        const b=body as AnswerRequest|PrepareRequest,key=`${operation}:${b.request_id}`,old=state.accepted.get(key);
        if(old){if(!isDeepStrictEqual(old.body,b))return problem(route,409,'IDEMPOTENCY_CONFLICT');return reply(route,'QaRunResponse',{run_id:old.run.run_id});}
        const drop=operation==='answer'?state.dropAnswer:state.dropPrepare;
        if(operation==='answer')state.dropAnswer=undefined;else state.dropPrepare=undefined;
        if(drop==='before')return route.abort('connectionreset');
        if(operation==='answer'){
          const answer=b as AnswerRequest;
          if(state.rejectAnswer){const code=state.rejectAnswer;state.rejectAnswer=undefined;return problem(route,code==='CREDITS_INSUFFICIENT'?402:409,code);}
          if(answer.expected_revision!==state.workspace.revision)return problem(route,409,'INPUT_REVISION_CONFLICT');
          expect(answer.expected_points).toBe(state.workspace.draft.questions.length*PROJECT_QA_PRICE.points);
          expect(answer.price_version).toBe(PROJECT_QA_PRICE.version);
        }
        const accepted=queued(state,b,operation);state.accepted.set(key,accepted);
        if(drop==='after')return route.abort('connectionreset');
        return reply(route,'QaRunResponse',{run_id:accepted.run.run_id});
      }
      if(id===projectId&&state.allowUploads&&method==='POST'&&suffix==='/materials/uploads'){
        checked('UploadCreateRequest',body);state.uploads.push(structuredClone(body));
        state.uploadMaterial={material_id:`synthetic-uploaded-${state.uploads.length}`,material_version:1,upload_id:`synthetic-upload-${state.uploads.length}`,role:body.role,filename:body.filename,media_type:body.media_type,byte_size:body.byte_size,sha256:body.sha256,state:'persisted',persisted_at:now,error:null};
        return reply(route,'UploadSessionResponse',{upload_id:state.uploadMaterial.upload_id,state:'uploading',upload_url:'/synthetic-qa-upload',expires_at:new Date(Date.now()+3600000).toISOString(),max_bytes:100*1024*1024},201);
      }
      if(id===projectId&&state.allowUploads&&method==='POST'&&/^\/materials\/uploads\/[^/]+\/complete$/.test(suffix)){
        checked('UploadCompleteRequest',body);expect(body).toEqual({byte_size:state.uploadMaterial!.byte_size,sha256:state.uploadMaterial!.sha256});
        const material=state.uploadMaterial!;if(!state.workspace.materials.some(m=>m.asset.kind==='material'&&m.asset.pin.material_id===material.material_id&&m.asset.pin.material_version===material.material_version))state.workspace.materials.push({filename:material.filename,asset:{kind:'material',pin:{source_project_id:projectId,material_id:material.material_id,material_version:material.material_version,sha256:material.sha256}}});
        return reply(route,'MaterialResponse',material);
      }
      if(id===projectId&&state.allowUploads&&method==='GET'&&suffix===`/materials/${state.uploadMaterial?.material_id}`){
        checked('MaterialVersionQuery',Object.fromEntries(url.searchParams));
        if(url.searchParams.get('version')!==String(state.uploadMaterial!.material_version))return problem(route,404,'NOT_FOUND');
        return reply(route,'MaterialResponse',state.uploadMaterial!);
      }
    }
    const generic=[...state.accepted.values()].find(value=>path===`/runs/${value.run.run_id}`);
    if(method==='GET'&&generic)return state.owner===ownerId?reply(route,'RunResponse',generic.generic):problem(route,404,'NOT_FOUND');
    state.unexpected.push(`${method} ${path}`);return problem(route,501,'UNEXPECTED_SYNTHETIC_REQUEST');
  });return state;
}
export async function assertFixture(page:Page){const state=installed.get(page);if(!state)return;expect(state.unexpected,'Synthetic HTTP endpoints must be explicitly allowed.').toEqual([]);expect(state.errors,'No unhandled browser errors.').toEqual([]);}
