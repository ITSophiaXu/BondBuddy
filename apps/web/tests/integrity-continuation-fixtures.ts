import {expect,type Page,type Route} from '@playwright/test';
import {INTEGRITY_PRICE,INTEGRITY_SITES,resolveIntegritySite,schemas,type IntegrityDraft,type IntegrityEvidence,type IntegrityInput,type IntegrityManual,type IntegrityRecord,type IntegrityRound,type IntegrityWorkspace,type M4MaterialPin} from '@bondbuddy/contracts';
import {FormatRegistry} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Dto} from '../src/api';
import {taskPage} from './collection-fixtures';

// Synthetic public HTTP records only. No official website is visited, no real
// Word bytes are generated, and no production worker or credit settlement runs.
export const projectId='synthetic-integrity-continuation-a',otherProjectId='synthetic-integrity-continuation-b';
export const ownerId='synthetic-integrity-owner-a',otherOwnerId='synthetic-integrity-owner-b';
export const checkId='synthetic-integrity-check-1',exportId='synthetic-integrity-export-2';
export const now='2026-10-25T06:00:00Z',oldTime='2026-10-24T02:15:00Z';
export const siteIds=['credit-china','execution-dishonest','bankruptcy','local-tax'];
export const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
FormatRegistry.Set('date-time',value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export type Call={method:string;path:string;search:string;body?:unknown};
type DraftRequest=Dto<'IntegrityDraftRequest'>;
type CheckRequest=Dto<'IntegrityRunRequest'>;
type ExportRequest=Dto<'IntegrityExportRequest'>;
type Accepted={body:CheckRequest|ExportRequest;round:IntegrityRound;generic:Dto<'RunResponse'>;checkId?:string};
export const oldPin:M4MaterialPin={source_project_id:projectId,material_id:'synthetic-integrity-existing-pdf',material_version:2,sha256:sha('integrity-evidence-pdf-v2')};
export const newPin:M4MaterialPin={...oldPin,material_version:3,sha256:sha('integrity-evidence-pdf-v3')};
export const imagePin:M4MaterialPin={source_project_id:projectId,material_id:'synthetic-integrity-existing-image',material_version:1,sha256:sha('integrity-evidence-image')};
export function historicalDraft():IntegrityDraft{return {subjects:[
  {id:'company-a',kind:'company',name:'合成发行人有限公司',identifier:'9131000SYNTHETIC01',role:'发行人',province:'上海',city:''},
  {id:'company-b',kind:'company',name:'合成子公司有限公司',identifier:'9144030SYNTHETIC02',role:'子公司',province:'广东',city:'深圳'},
  {id:'person-a',kind:'person',name:'合成人员甲',identifier:'内部核对尾号7788',role:'董事',province:'',city:''}
],site_ids:[...siteIds],notes:'历史原轮范围：保留企业、人员、注册地和身份核对说明。'};}
export function originalDraft():IntegrityDraft{return {subjects:[{id:'current-company',kind:'company',name:'当前准备企业有限公司',identifier:'',role:'待核查',province:'北京',city:''}],site_ids:['csrc'],notes:'服务器当前准备，与历史名单不同。'};}
function records():IntegrityRecord[]{
  const statuses:IntegrityRecord['status'][]=['needs_manual','no_public_results','public_matches','query_failed','no_public_results','query_failed','no_public_results','needs_manual','needs_manual','no_public_results','not_applicable','not_applicable'];
  return historicalDraft().subjects.flatMap((subject,index)=>siteIds.map((siteId,siteIndex)=>{
    const site=resolveIntegritySite(INTEGRITY_SITES.find(value=>value.id===siteId)!,subject),status=statuses[index*siteIds.length+siteIndex];
    return {subject_id:subject.id,site_id:siteId,site_name:site.name,urls:site.links.map(link=>link.url),query:status==='not_applicable'?'':`${subject.name} ${site.topic}`,status,
      reason:status==='needs_manual'?'合成官网验证码限制，原查询待人工补证。':status==='query_failed'?'合成官网查询失败，原状态仍待补证。':status==='not_applicable'?'该网站仅适用于企业，人员不适用。':status==='public_matches'?'合成公开记录线索，仍需人工核对主体。':'本次合成查询未检索到公开记录，不代表无风险。',
      checked_at:oldTime,search_performed:['public_matches','no_public_results'].includes(status),sources:status==='public_matches'?[{url:site.links[0].url,title:'合成公开线索',quote:'仅用于界面测试的公开记录摘要。',retrieved_at:oldTime,tool_call_id:'synthetic-integrity-source',sha256:sha('synthetic public source')}]:[]};
  }));
}
export function evidence():IntegrityEvidence[]{return [
  {id:'synthetic-evidence-old',created_at:oldTime,request_id:'synthetic-evidence-request-old',subject_id:'company-a',site_id:'credit-china',queried_at:oldTime,url:'https://www.creditchina.gov.cn/',note:'旧版已包含的合成人工证据。',conclusion:'unresolved',material:structuredClone(oldPin)},
  {id:'synthetic-evidence-new',created_at:now,request_id:'synthetic-evidence-request-new',subject_id:'company-b',site_id:'local-tax',queried_at:now,url:resolveIntegritySite(INTEGRITY_SITES.find(site=>site.id==='local-tax')!,historicalDraft().subjects[1]).links[0].url,note:'旧版底稿生成后新增，尚未进入旧导出。',conclusion:'no_records',material:structuredClone(imagePin),registration:{province:'广东',city:'深圳'}}
];}
function manifest(operation:'check'|'export',draft=historicalDraft()):IntegrityInput{return {version:'integrity-round-v1',operation,round_id:checkId,project_name:'合成诚信核查项目',draft,price_version:INTEGRITY_PRICE.version,points:operation==='check'?5000:0,records:operation==='export'?records():[],evidence_ids:operation==='export'?['synthetic-evidence-old']:[],collector:'official-browser-v1'};}
function completed(operation:'check'|'export'):IntegrityRound{
  const runId=operation==='check'?checkId:exportId;
  return {run_id:runId,round_id:checkId,operation,sequence:operation==='check'?1:2,state:'succeeded',stage:null,created_at:oldTime,manifest:manifest(operation),records:records(),evidence:evidence(),
    artifact_id:`${runId}-company-word`,artifacts:[{kind:'company',artifact_id:`${runId}-company-word`,artifact_version:operation==='check'?1:2},{kind:'person',artifact_id:`${runId}-person-word`,artifact_version:operation==='check'?1:2}],charged_points:operation==='check'?5000:0,reserved_points:0};
}
function project(id:string):Dto<'ProjectResponse'>{return {project_id:id,name:id===projectId?'合成诚信核查项目':'另一个合成诚信项目',kind:'generation',issuer_name:'合成发行人有限公司',market:'sse',offering:'private',draft_revision:3,input_revision:null,input_hash:null,updated_at:now};}
export function material(pin:M4MaterialPin,filename:string,mediaType:Dto<'MaterialResponse'>['media_type']):Dto<'MaterialResponse'>{return {material_id:pin.material_id,material_version:pin.material_version,upload_id:`${pin.material_id}-upload-${pin.material_version}`,role:'other',filename,media_type:mediaType,byte_size:2048,sha256:pin.sha256,state:'persisted',persisted_at:oldTime,error:null};}
export function fixture(){
  const workspace:IntegrityWorkspace={draft:originalDraft(),revision:10,price:INTEGRITY_PRICE,rounds:[completed('export'),completed('check')]};
  const otherWorkspace:IntegrityWorkspace={draft:{subjects:[],site_ids:[],notes:''},revision:0,price:INTEGRITY_PRICE,rounds:[]};
  const materials=[material(oldPin,'合成历史证据_v2.pdf','application/pdf'),material(newPin,'合成历史证据_v3.pdf','application/pdf'),material(imagePin,'合成查询截图.png','image/png')];
  return {owner:ownerId,workspace,otherWorkspace,project:project(projectId),otherProject:project(otherProjectId),materials,calls:[] as Call[],unexpected:[] as string[],errors:[] as string[],
    drafts:[] as DraftRequest[],checks:[] as CheckRequest[],exports:[] as {checkId:string;body:ExportRequest}[],manuals:[] as {checkId:string;body:IntegrityManual}[],accepted:new Map<string,Accepted>(),acceptedManuals:new Map<string,{checkId:string;body:IntegrityManual}>(),
    dropDraft:false,dropCheck:undefined as 'before'|'after'|undefined,dropExport:undefined as 'before'|'after'|undefined,dropManual:undefined as 'before'|'after'|undefined,
    rejectCheck:undefined as 'CREDITS_INSUFFICIENT'|'INPUT_REVISION_CONFLICT'|'QUOTE_CHANGED'|undefined,rejectExport:false,rejectManual:false,
    workspaceRead:undefined as IntegrityWorkspace|undefined,omitRequestedRun:false,allowUploads:false,uploads:[] as Dto<'UploadCreateRequest'>[],uploadBytes:0,uploadMaterial:undefined as Dto<'MaterialResponse'>|undefined,reusedUploadMaterial:undefined as Dto<'MaterialResponse'>|undefined,uploadReceiptMismatch:undefined as 'sha256'|'byte_size'|'media_type'|'role'|undefined,available:10000};
}
export type State=ReturnType<typeof fixture>;
const installed=new WeakMap<Page,State>();
export function checked<K extends keyof typeof schemas>(name:K,value:unknown):asserts value is Dto<K>{expect(Value.Check(schemas[name],value),`${name}: ${JSON.stringify([...Value.Errors(schemas[name],value)])}`).toBe(true);}
async function reply<K extends keyof typeof schemas>(route:Route,name:K,body:Dto<K>,status=200){checked(name,body);await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});}
const problem=(route:Route,status:number,code:string)=>route.fulfill({status,json:{code}});
export const writes=(state:State)=>state.calls.filter(call=>call.method!=='GET');
export const integrityWrites=(state:State)=>writes(state).filter(call=>call.path.includes('/integrity/'));
export const workspaceReads=(state:State)=>state.calls.filter(call=>call.method==='GET'&&call.path===`/projects/${projectId}/integrity`);
export const historicalRounds=(state:State)=>structuredClone(state.workspace.rounds.filter(round=>[checkId,exportId].includes(round.run_id)));
function filePage(state:State,id=projectId):Dto<'ProjectFilesResponse'>{return {project_id:id,items:id===projectId?state.materials.map(m=>({file_id:m.material_id,file_key:`material:${m.material_id}:${m.material_version}`,project_id:id,source:'material',filename:m.filename,version:m.material_version,display_version:m.material_version,sha256:m.sha256,created_at:m.persisted_at,folder:'sources',run_id:null,current:false,latest:m.material_version!==2,version_count:m.material_id===oldPin.material_id?3:1})):[]};}
function queued(state:State,body:CheckRequest|ExportRequest,operation:'check'|'export',roundId?:string):Accepted{
  const sequence=Math.max(...state.workspace.rounds.map(round=>round.sequence))+1,runId=`synthetic-integrity-${operation}-${sequence}`;
  const check=state.workspace.rounds.find(round=>round.run_id===roundId&&round.operation==='check');
  const input:IntegrityInput=operation==='check'?{...manifest('check',structuredClone(state.workspace.draft)),round_id:runId}:{...structuredClone(check!.manifest),operation:'export',points:0,records:structuredClone(check!.records),evidence_ids:[...(body as ExportRequest).expected_evidence_ids]};
  const round:IntegrityRound={run_id:runId,round_id:input.round_id,operation,sequence,state:'queued',stage:'queued',created_at:now,manifest:input,records:[],evidence:operation==='export'?structuredClone(check!.evidence):[],artifact_id:null,artifacts:[],reserved_points:operation==='check'?5000:0,charged_points:0};
  const generic:Dto<'RunResponse'>={run_id:runId,execution_request_id:`integrity${operation==='export'?'-export':''}:${body.request_id}`,project_id:projectId,input_revision:100+sequence,input_hash:sha(JSON.stringify(input)),channel:'production',test_grant_id:null,uncovered_items:[],state:'queued',stage:'queued',event_cursor:0,billing_mode:'fixed_credits',reservation_id:operation==='check'?`synthetic-reservation-${sequence}`:null,artifact_id:null,prompt_snapshot_ref:null,updated_at:now};
  state.workspace.rounds.unshift(round);return {body:structuredClone(body),round,generic,...(roundId?{checkId:roundId}:{})};
}
export async function install(page:Page,state=fixture()){
  installed.set(page,state);page.on('pageerror',error=>state.errors.push(error.message));
  await page.context().route('**/synthetic-integrity-upload',async route=>{
    if(state.allowUploads&&route.request().method()==='PUT'){state.uploadBytes++;return route.fulfill({status:204,body:''});}
    state.unexpected.push(`BINARY ${route.request().method()} ${route.request().url()}`);return route.abort();
  });
  await page.context().route('https://synthetic.invalid/**',async route=>{state.unexpected.push(`BINARY ${route.request().method()} ${route.request().url()}`);return route.abort();});
  await page.context().route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
    const body:unknown=request.postData()&&request.headers()['content-type']?.includes('application/json')?request.postDataJSON():undefined;
    state.calls.push({method,path,search:url.search,...(body===undefined?{}:{body:structuredClone(body)})});
    if(method==='GET'&&path==='/commerce/catalog')return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
    if(method==='GET'&&path==='/me')return reply(route,'MeResponse',{user_id:state.owner,session_status:'active'});
    if(method==='GET'&&path==='/account')return reply(route,'AccountResponse',{user_id:state.owner,username:'synthetic_integrity',phone_masked:null,status:'active',created_at:now,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(method==='GET'&&path==='/credits/balance')return reply(route,'CreditBalanceResponse',{enabled:true,available:state.available,frozen:0});
    if(method==='GET'&&path==='/m4/topics')return problem(route,503,'DATA_UNAVAILABLE');
    if(method==='GET'&&path==='/projects')return reply(route,'ProjectListResponse',{items:state.owner===ownerId?[state.project,state.otherProject].map(p=>({project_id:p.project_id,name:p.name,draft_revision:p.draft_revision,updated_at:now,kind:p.kind,issuer_name:p.issuer_name,market:p.market,offering:p.offering,latest_run:null,latest_artifact:null})):[],page:{has_more:false,next_cursor:null}});
    const match=path.match(/^\/projects\/([^/]+)(.*)$/);
    if(match){const id=match[1],suffix=match[2];
      if(state.owner!==ownerId||![projectId,otherProjectId].includes(id))return problem(route,404,'NOT_FOUND');
      const p=id===projectId?state.project:state.otherProject,w=id===projectId?state.workspace:state.otherWorkspace;
      if(method==='GET'&&suffix==='')return reply(route,'ProjectResponse',p);
      if(method==='GET'&&suffix==='/tasks')return reply(route,'ProjectTasksResponse',taskPage(id,[],'generation'));
      if(method==='GET'&&suffix==='/files')return reply(route,'ProjectFilesResponse',filePage(state,id));
      if(method==='GET'&&suffix==='/integrity'){
        checked('IntegrityQuery',Object.fromEntries(url.searchParams));const response=structuredClone(id===projectId?state.workspaceRead??w:w);
        if(state.omitRequestedRun&&url.searchParams.has('run_id'))response.rounds=response.rounds.filter(round=>round.run_id!==url.searchParams.get('run_id'));
        return reply(route,'IntegrityWorkspaceResponse',response);
      }
      const materialMatch=suffix.match(/^\/materials\/([^/]+)$/);
      if(method==='GET'&&materialMatch){const m=state.materials.find(value=>value.material_id===materialMatch[1]&&(!url.searchParams.has('version')||value.material_version===Number(url.searchParams.get('version'))));return m?reply(route,'MaterialResponse',m):problem(route,404,'NOT_FOUND');}
      if(id===projectId&&method==='POST'&&suffix==='/integrity/draft'){
        checked('IntegrityDraftRequest',body);state.drafts.push(structuredClone(body));if(body.expected_revision!==state.workspace.revision)return problem(route,409,'INPUT_REVISION_CONFLICT');
        state.workspace.draft=structuredClone(body.draft);state.workspace.revision++;
        if(state.dropDraft){state.dropDraft=false;return route.abort('connectionreset');}return reply(route,'IntegrityWorkspaceResponse',state.workspace);
      }
      const exportMatch=suffix.match(/^\/integrity\/runs\/([^/]+)\/exports$/);
      if(id===projectId&&method==='POST'&&(suffix==='/integrity/runs'||exportMatch)){
        const operation=exportMatch?'export':'check';
        if(operation==='check'){checked('IntegrityRunRequest',body);state.checks.push(structuredClone(body));}else{checked('IntegrityExportRequest',body);state.exports.push({checkId:exportMatch![1],body:structuredClone(body)});}
        const b=body as CheckRequest|ExportRequest,key=`${operation}:${b.request_id}`,old=state.accepted.get(key);
        if(old){if(!isDeepStrictEqual(old.body,b)||old.checkId!==exportMatch?.[1])return problem(route,409,'IDEMPOTENCY_CONFLICT');return reply(route,'IntegrityRunResponse',{run_id:old.round.run_id});}
        const drop=operation==='check'?state.dropCheck:state.dropExport;if(operation==='check')state.dropCheck=undefined;else state.dropExport=undefined;
        if(drop==='before')return route.abort('connectionreset');
        if(operation==='check'){
          if(state.rejectCheck){const code=state.rejectCheck;state.rejectCheck=undefined;return problem(route,code==='CREDITS_INSUFFICIENT'?402:409,code);}
          expect((b as CheckRequest).expected_points).toBe(5000);expect((b as CheckRequest).price_version).toBe(INTEGRITY_PRICE.version);
          if((b as CheckRequest).expected_revision!==state.workspace.revision)return problem(route,409,'INPUT_REVISION_CONFLICT');
        }else{
          const check=state.workspace.rounds.find(round=>round.run_id===exportMatch![1]&&round.operation==='check');if(!check)return problem(route,404,'NOT_FOUND');
          if(state.rejectExport){state.rejectExport=false;return problem(route,409,'INPUT_REVISION_CONFLICT');}
          if(!isDeepStrictEqual([...(b as ExportRequest).expected_evidence_ids].sort(),check.evidence.map(item=>item.id).sort()))return problem(route,409,'INPUT_REVISION_CONFLICT');
        }
        const accepted=queued(state,b,operation,exportMatch?.[1]);state.accepted.set(key,accepted);if(drop==='after')return route.abort('connectionreset');return reply(route,'IntegrityRunResponse',{run_id:accepted.round.run_id});
      }
      const evidenceMatch=suffix.match(/^\/integrity\/runs\/([^/]+)\/evidence$/);
      if(id===projectId&&method==='POST'&&evidenceMatch){
        checked('IntegrityManualRequest',body);const roundId=evidenceMatch[1];state.manuals.push({checkId:roundId,body:structuredClone(body)});
        const old=state.acceptedManuals.get(body.request_id);if(old){if(!isDeepStrictEqual(old,{checkId:roundId,body}))return problem(route,409,'IDEMPOTENCY_CONFLICT');return reply(route,'IntegrityWorkspaceResponse',state.workspace);}
        const drop=state.dropManual;state.dropManual=undefined;if(drop==='before')return route.abort('connectionreset');
        const check=state.workspace.rounds.find(round=>round.run_id===roundId&&round.operation==='check');if(!check)return problem(route,404,'NOT_FOUND');
        if(state.rejectManual){state.rejectManual=false;return problem(route,409,'INPUT_REVISION_CONFLICT');}
        expect(body.material.source_project_id).toBe(projectId);expect(check.manifest.draft.subjects.some(subject=>subject.id===body.subject_id)).toBe(true);expect(check.manifest.draft.site_ids).toContain(body.site_id);
        state.acceptedManuals.set(body.request_id,{checkId:roundId,body:structuredClone(body)});
        const item:IntegrityEvidence={...structuredClone(body),id:`synthetic-evidence-added-${state.acceptedManuals.size}`,created_at:now};state.workspace.rounds.filter(round=>round.round_id===roundId).forEach(round=>round.evidence.push(structuredClone(item)));
        if(drop==='after')return route.abort('connectionreset');return reply(route,'IntegrityWorkspaceResponse',state.workspace);
      }
      if(id===projectId&&state.allowUploads&&method==='POST'&&suffix==='/materials/uploads'){
        checked('UploadCreateRequest',body);state.uploads.push(structuredClone(body));state.uploadMaterial={material_id:`synthetic-uploaded-${state.uploads.length}`,material_version:1,upload_id:`synthetic-upload-${state.uploads.length}`,role:body.role,filename:body.filename,media_type:body.media_type,byte_size:body.byte_size,sha256:body.sha256,state:'persisted',persisted_at:now,error:null};
        return reply(route,'UploadSessionResponse',{upload_id:state.uploadMaterial.upload_id,state:'uploading',upload_url:'/synthetic-integrity-upload',expires_at:new Date(Date.now()+3600000).toISOString(),max_bytes:100*1024*1024},201);
      }
      if(id===projectId&&state.allowUploads&&method==='POST'&&/^\/materials\/uploads\/[^/]+\/complete$/.test(suffix)){
        checked('UploadCompleteRequest',body);expect(body).toEqual({byte_size:state.uploadMaterial!.byte_size,sha256:state.uploadMaterial!.sha256});
        // Match server.ts's same-project/role/hash/size/media reuse semantics:
        // the existing material keeps its original upload ID and is not added twice.
        if(state.reusedUploadMaterial){const prior=state.reusedUploadMaterial;expect(state.materials).toContainEqual(prior);for(const field of ['role','sha256','byte_size','media_type'] as const)expect(prior[field]).toEqual(state.uploadMaterial![field]);}
        else state.materials.push(state.uploadMaterial!);
        const response=structuredClone(state.reusedUploadMaterial??state.uploadMaterial!);if(state.uploadReceiptMismatch==='sha256')response.sha256=sha('synthetic-wrong-upload-receipt');if(state.uploadReceiptMismatch==='byte_size')response.byte_size++;if(state.uploadReceiptMismatch==='media_type')response.media_type='image/png';if(state.uploadReceiptMismatch==='role')response.role='audit';return reply(route,'MaterialResponse',response);
      }
    }
    const accepted=[...state.accepted.values()].find(value=>path===`/runs/${value.round.run_id}`);if(method==='GET'&&accepted)return state.owner===ownerId?reply(route,'RunResponse',accepted.generic):problem(route,404,'NOT_FOUND');
    state.unexpected.push(`${method} ${path}`);return problem(route,501,'UNEXPECTED_SYNTHETIC_REQUEST');
  });return state;
}
export async function assertFixture(page:Page){const state=installed.get(page);if(!state)return;expect(state.unexpected,'Synthetic endpoints must be explicitly allowed.').toEqual([]);expect(state.errors,'No unhandled browser errors.').toEqual([]);}
