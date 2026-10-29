import { artifactNameColumns, artifactNameJoins, artifactDownloadName } from './artifact-filename.js';
import { contentDisposition } from './material-download.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { m4DocumentInputIssues, M4_API_BASE, M4_DOCUMENT_TYPES, M4_DOCUMENT_LABELS, M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_SUBTYPE, M4_QA_SUBTYPE, M4DraftRequestSchema, M4ViewRequestSchema,
  M4TopicCreateRequestSchema, M4TemplateCreateRequestSchema, M4MessageRequestSchema, M4QuoteRequestSchema, M4ExecuteRequestSchema,
  M4HandoffBindRequestSchema, M4HandoffBindResponseSchema,
  M4AssistantReplySchema, isM4Manifest, type M4Topic, type M4DraftInput, type M4Draft, type M4DocumentType, type M4MaterialPin,
  type M4ArtifactPin, type M4MessageContext, type M4ViewState, type M4Message, type M4AssistantReply, type M4Template,
  type M4Artifact, type M4Manifest, type M4DocumentManifest, type M4QaManifest, type M4Workspace, type M4TopicCreateRequest, type M4DraftRequest, type M4ViewRequest,
  type M4TemplateCreateRequest, type M4MessageRequest, type M4ExecuteRequest, type M4QuoteRequest, type M4BillingTask,
  type M4HandoffBindRequest, type M4HandoffBindResponse } from '@bondbuddy/contracts';
import { project, projectDto, runDto, transaction, uid, date, digest, executionKeyStorage, Problem, missing, conflict, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { enqueue } from './queue.js';
import { runEventPayloadDto } from './run-event-dto.js';
import { quoteM4, reserveM4, readM4CreditCharge } from './m4-billing.js';
import {loadM4Knowledge,loadProjectFileKnowledge} from './m4-knowledge.js';
import { MARKETS, MARKET_OFFERINGS } from '@bondbuddy/contracts';
export { settleM4Metering } from './m4-billing.js';

type Db = Pool | PoolClient;
const terminal=['succeeded','test_completed','failed','cancelled','rejected'];
const invalid=(s:string):never=>{throw new Problem(422,'VALIDATION_FAILED',s);};
const stale=():never=>{throw conflict('INPUT_REVISION_CONFLICT','任务、引用或版本已变化，请恢复工作区后继续。');};
const equal=(a:unknown,b:unknown)=>inputManifestHash(a)===inputManifestHash(b);
function normalizedAssistantFields(fields:M4AssistantReply['fields']){const result={...fields},period=fields.reporting_period;
  if(period && /^\d{4}-\d{2}-\d{2}$/.test(period) && Number.isFinite(Date.parse(`${period}T00:00:00.000Z`))
    && new Date(`${period}T00:00:00.000Z`).toISOString().slice(0,10)===period && (!fields.reporting_cutoff || fields.reporting_cutoff===period)){
    result.reporting_cutoff=period;delete result.reporting_period;
  }return result;
}
const param=(r:FastifyRequest,k:string)=>(r.params as Record<string,string>)[k];
export const emptyM4Draft=(type:M4DocumentType):M4DraftInput=>({document_type:type,source_material:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{},requirements:[]});
export const emptyM4Context=():M4MessageContext=>({document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null});
export const emptyM4View=():M4ViewState=>({selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:emptyM4Context()});
const topicDto=(t:any):M4Topic=>({surface:t.surface,topic_id:t.id,project_id:t.project_id,source_project_id:t.source_project_id,name:t.name,created_at:date(t.created_at),updated_at:date(t.updated_at)});
const templateDto=(t:any):M4Template=>({template_id:t.id,template_version:t.version,sha256:t.sha256.trim(),name:t.name,broker:t.broker,document_type:t.document_type,
  material:t.material,owner_scope:'private',market:t.market,offering:t.offering??'private',status:t.retired_at?'retired':'active',created_at:date(t.created_at),retired_at:t.retired_at?date(t.retired_at):null});
const messageDto=(m:any):M4Message=>({message_id:m.id,role:m.role,version:m.version,content:m.content,context:m.context,created_at:date(m.created_at),
  reply_status:m.reply_status==='completed'?'completed':['failed','cancelled','rejected'].includes(m.run_state)?'failed':m.run_state==='running'?'running':m.reply_status,
  reply_to:m.reply_to,run_id:m.run_id,reply:Value.Check(M4AssistantReplySchema,m.reply)?m.reply:null,
  error:m.error??(['failed','cancelled','rejected'].includes(m.run_state)&&m.reply_status!=='completed'?'助手任务未完成；已保存消息，可以核对原因后再次发送。':null)});
async function requireTopic(db:Db,owner:string,id:string,lock=false){
  const t=(await db.query('SELECT * FROM bb_m4_topics WHERE owner_user_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[owner,id])).rows[0];
  if(!t)throw missing();await project(db,owner,t.project_id,lock);if(t.source_project_id)await project(db,owner,t.source_project_id);return t;
}
async function topicEvent(db:Db,owner:string,topic:string,event:string,payload:unknown){await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES($1,$2,'m4_topic',$3,$4,$5)`,[uid(),owner,topic,event,payload]);await db.query('UPDATE bb_m4_topics SET updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,topic]);}
async function bindHandoff(db:PoolClient,owner:string,topicId:string,b:M4HandoffBindRequest):Promise<M4HandoffBindResponse>{
  const t=await requireTopic(db,owner,topicId);
  const message=(await db.query(`SELECT * FROM bb_m4_messages WHERE owner_user_id=$1 AND topic_id=$2 AND id=$3 AND role='user' FOR SHARE`,[owner,topicId,b.message_id])).rows[0];
  if(!message)throw missing();
  if(message.version!==b.message_version)stale();
  const pin=message.context?.source_material as M4MaterialPin|null;
  if(!pin)throw new Problem(422,'INPUT_REQUIRED','原消息尚未固定来源，请先在目标工作区明确选择待处理稿及版本。');
  if(!equal(pin,b.source_material))stale();
  const initialSource=await project(db,owner,pin.source_project_id),scope=initialSource.execution_scope_project_id||initialSource.id;
  // Existing executors have different target/canonical lock orders. NOWAIT turns
  // overlapping transactions into a retryable conflict instead of a deadlock.
  const ids=[...new Set([t.project_id,pin.source_project_id,scope,b.target_project_id])].sort();
  let locked:any[];
  try{locked=(await db.query(`SELECT * FROM bb_projects WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE NOWAIT`,[owner,ids])).rows;}
  catch(error){if((error as {code?:string}).code==='55P03')throw conflict('INPUT_REVISION_CONFLICT','项目正在保存或提交任务，请稍后重试采用来源。');throw error;}
  if(locked.length!==ids.length)throw missing();
  const source=locked.find(p=>p.id===pin.source_project_id)!,target=locked.find(p=>p.id===b.target_project_id)!;
  if((source.execution_scope_project_id||source.id)!==scope)stale();
  await readM4MaterialPin(db,owner,pin);
  if(!['update','review'].includes(target.kind)||target.id===source.id||target.id===scope)
    invalid('请选择新建的募集书更新或复核项目采用来源。');
  const binding={topic_id:topicId,message_id:message.id,message_version:message.version,target_project_id:target.id,
    source_material:pin,execution_scope_project_id:scope};
  // A retry of an already established lineage is read-only, even after execution.
  if(target.execution_scope_project_id===scope)return {binding};
  if(target.execution_scope_project_id&&target.execution_scope_project_id!==target.id)
    throw conflict('INPUT_REVISION_CONFLICT','目标项目已采用其他来源，请新建目标项目。');
  if((await db.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND execution_scope_project_id=$2 AND id<>$2 LIMIT 1',[owner,target.id])).rowCount)
    throw conflict('INPUT_REVISION_CONFLICT','目标项目已是其他业务的来源，请新建目标项目。');
  if((await db.query("SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind<>'qa' LIMIT 1",[owner,target.id])).rowCount)
    throw conflict('INPUT_REVISION_CONFLICT','目标项目已有业务任务，请新建目标项目采用来源。');
  // Advance the draft so paid quotations require a current input. Immutable runs
  // and legacy free input snapshots are retained under the bound canonical mutex.
  await db.query(`UPDATE bb_projects SET execution_scope_project_id=$3,draft_revision=draft_revision+1,updated_at=now()
    WHERE owner_user_id=$1 AND id=$2`,[owner,target.id,scope]);
  await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'project',$3,'project.m4_handoff_bound',$4)`,[uid(),owner,target.id,binding]);
  return {binding};
}
export async function readM4MaterialPin(db:Db,owner:string,pin:M4MaterialPin,allowInternalTemplate=false){
  await project(db,owner,pin.source_project_id);
  const m=(await db.query(`SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,[owner,pin.source_project_id,pin.material_id,pin.material_version])).rows[0];
  if(!m || m.sha256.trim()!==pin.sha256 || m.internal_template&&!allowInternalTemplate)throw missing();return m;
}
export async function readM4ArtifactPin(db:Db,owner:string,pin:M4ArtifactPin){
  await project(db,owner,pin.source_project_id);
  const a=(await db.query(`SELECT v.*,r.project_id FROM bb_artifact_versions v JOIN bb_runs r ON r.id=v.run_id AND r.owner_user_id=v.owner_user_id
    WHERE v.owner_user_id=$1 AND r.project_id=$2 AND v.id=$3 AND v.version=$4 AND v.delivery_status='available' AND v.quality_status='passed'`,[owner,pin.source_project_id,pin.artifact_id,pin.artifact_version])).rows[0];
  if(!a || a.sha256.trim()!==pin.sha256)throw missing();return a;
}
async function validateContext(db:Db,owner:string,topic:any,c:M4MessageContext){
  if(c.document_type){const d=await readDraft(db,owner,topic.id,c.document_type);if(d.version!==c.draft_version)stale();}
  if(c.source_material)await readM4MaterialPin(db,owner,c.source_material);
  for(const ref of c.citations)if(ref.kind==='material')await readM4MaterialPin(db,owner,ref.ref);else await readM4ArtifactPin(db,owner,ref.ref);
  if(c.reading_artifact)await readM4ArtifactPin(db,owner,c.reading_artifact);
}
async function readDraft(db:Db,owner:string,topic:string,type:M4DocumentType):Promise<M4Draft>{
  const row=(await db.query('SELECT * FROM bb_m4_drafts WHERE owner_user_id=$1 AND topic_id=$2 AND document_type=$3',[owner,topic,type])).rows[0];
  return row?{...row.input,version:row.version,sha256:row.sha256.trim(),updated_at:date(row.updated_at)}:{...emptyM4Draft(type),version:0,sha256:inputManifestHash(emptyM4Draft(type)),updated_at:null};
}
async function validateDraft(db:Db,owner:string,topic:string,input:M4DraftInput){
  if(input.document_type==='workpaper'||input.workpaper)invalid('请在底稿目录批量生成入口准备底稿。');
  if(input.project_file){
    const link=input.project_file;
    const w=(await db.query('SELECT 1 FROM bb_project_file_workspaces WHERE owner_user_id=$1 AND project_id=$2 AND topic_id=$3',[owner,link.project_id,topic])).rowCount;
    const s=input.source_material;
    const v=s&&(await db.query(`SELECT v.* FROM bb_prospectus_versions v LEFT JOIN bb_review_source_imports i ON i.owner_user_id=v.owner_user_id AND i.version_id=v.id
      WHERE v.owner_user_id=$1 AND v.project_id=$2 AND v.id=$3 AND v.sha256=$4
       AND ((v.material_id=$5 AND v.material_version=$6) OR (i.material_id=$5 AND $6=1))`,[owner,s.source_project_id,link.source_version_id,s.sha256,s.material_id,s.material_version])).rows[0];
    const related=v&&(v.project_id===link.project_id||(await db.query('SELECT 1 FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2 AND update_project_id=$3',[owner,link.project_id,v.project_id])).rowCount);
    if(!w||!v||!related)invalid('请选择当前项目中已保存的募集说明书版本。');
  }
  if(new Set(input.materials.map(m=>`${m.material_id}:${m.material_version}`)).size!==input.materials.length)invalid('同一材料版本不能重复采用。');
  for(const m of input.materials)await readM4MaterialPin(db,owner,m);
  if(input.source_material)await readM4MaterialPin(db,owner,input.source_material);
  if(input.edit_base){await readM4ArtifactPin(db,owner,input.edit_base);
    const base=(await db.query('SELECT * FROM bb_m4_artifacts WHERE owner_user_id=$1 AND artifact_id=$2 AND artifact_version=$3',[owner,input.edit_base.artifact_id,input.edit_base.artifact_version])).rows[0];
    if(!base || base.kind!=='document' || base.document_type!==input.document_type)invalid('全文改稿必须明确选择同文种的已交付正文，复核报告与编制说明不能作为正文底稿。');}
  if(input.template){const t=(await db.query('SELECT * FROM bb_m4_templates WHERE owner_user_id=$1 AND id=$2 AND version=$3',[owner,input.template.template_id,input.template.template_version])).rows[0];
    if(!t || t.sha256.trim()!==input.template.sha256 || t.document_type!==input.document_type || t.retired_at)stale();await readM4MaterialPin(db,owner,t.material,true);}
  for(const requirement of input.requirements){const m=(await db.query('SELECT * FROM bb_m4_messages WHERE owner_user_id=$1 AND topic_id=$2 AND id=$3 AND version=$4',[owner,topic,requirement.message_id,requirement.message_version])).rows[0];
    if(!m || m.role!=='assistant' || !m.reply?.requirements?.includes(requirement.text))invalid('采用的要求必须来自本话题助手的准确消息。');}
}
async function pendingDraftRequirements(db:Db,owner:string,topic:string):Promise<M4DraftInput['requirements']>{return (await db.query(`SELECT requirement_id,text,message_id,message_version FROM bb_m4_pending_requirements
  WHERE owner_user_id=$1 AND topic_id=$2 AND consumed_document_type IS NULL ORDER BY created_at,requirement_id`,[owner,topic])).rows;}
async function consumePendingRequirements(db:Db,owner:string,topic:string,type:M4DocumentType,version:number){await db.query(`UPDATE bb_m4_pending_requirements SET consumed_document_type=$3,consumed_draft_version=$4
  WHERE owner_user_id=$1 AND topic_id=$2 AND consumed_document_type IS NULL`,[owner,topic,type,version]);}
async function saveDraft(db:Db,owner:string,topic:string,input:M4DraftInput,expected:number){
  const old=await readDraft(db,owner,topic,input.document_type);if(old.version!==expected)stale();
  const pending=await pendingDraftRequirements(db,owner,topic);
  input={...input,requirements:[...input.requirements,...pending.filter(r=>!input.requirements.some(x=>x.requirement_id===r.requirement_id))]};
  await validateDraft(db,owner,topic,input);
  const {version:_version,sha256:_sha,updated_at:_updated,...oldInput}=old;
  if(old.version && equal(oldInput,input)){if(pending.length)await consumePendingRequirements(db,owner,topic,input.document_type,old.version);return old;}
  const row=(await db.query(`INSERT INTO bb_m4_drafts(owner_user_id,topic_id,document_type,version,input,sha256) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(topic_id,document_type) DO UPDATE SET version=EXCLUDED.version,input=EXCLUDED.input,sha256=EXCLUDED.sha256,updated_at=now() RETURNING *`,[owner,topic,input.document_type,old.version+1,input,inputManifestHash(input)])).rows[0];
  if(pending.length)await consumePendingRequirements(db,owner,topic,input.document_type,row.version);
  await topicEvent(db,owner,topic,'m4.draft_saved',{document_type:input.document_type,version:row.version});return {...row.input,version:row.version,sha256:row.sha256.trim(),updated_at:date(row.updated_at)} as M4Draft;
}
async function sharedMaterials(db:Db,owner:string,topic:string):Promise<M4MaterialPin[]>{return (await db.query(`SELECT tm.source_project_id,tm.material_id,tm.material_version,tm.sha256 FROM bb_m4_topic_materials tm
  JOIN bb_material_versions m ON m.owner_user_id=tm.owner_user_id AND m.project_id=tm.source_project_id
    AND m.id=tm.material_id AND m.version=tm.material_version AND m.sha256=tm.sha256 AND m.deleted_at IS NULL
  JOIN bb_projects p ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id AND p.deleted_at IS NULL
  WHERE tm.owner_user_id=$1 AND tm.topic_id=$2 ORDER BY tm.created_at,tm.material_id`,[owner,topic])).rows.map(m=>({...m,sha256:m.sha256.trim()}));}
async function adoptMaterial(db:Db,owner:string,topic:string,pin:M4MaterialPin){await readM4MaterialPin(db,owner,pin);await db.query(`INSERT INTO bb_m4_topic_materials(owner_user_id,topic_id,source_project_id,material_id,material_version,sha256)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[owner,topic,pin.source_project_id,pin.material_id,pin.material_version,pin.sha256]);}
async function templateFor(db:Db,owner:string,ref:M4DraftInput['template']){if(!ref)return null;const t=(await db.query('SELECT * FROM bb_m4_templates WHERE owner_user_id=$1 AND id=$2 AND version=$3',[owner,ref.template_id,ref.template_version])).rows[0];if(!t || t.sha256.trim()!==ref.sha256 || t.retired_at)stale();return t;}
async function documentManifest(db:Db,owner:string,t:any,type:M4DocumentType,expected:number):Promise<M4DocumentManifest>{
  const current=await readDraft(db,owner,t.id,type);if(current.version!==expected)stale();
  const {version:dv,sha256:_hash,updated_at:_time,...input}=current;await validateDraft(db,owner,t.id,input);
  const p=await project(db,owner,t.project_id),sourceId=input.source_material?.source_project_id||input.edit_base?.source_project_id||t.source_project_id;
  const source=sourceId?await project(db,owner,sourceId):null;
  const market=input.fields.market;
  const offering=input.project_file?input.fields.offering:type==='recommendation'?input.fields.offering:'private';
  if(input.fields.brokers || input.fields.scope && input.fields.scope!=='whole')
    throw new Problem(422,'CAPABILITY_NOT_READY','M4 首发支持单承销商、交易所普通私募与全文制作，当前选择需后续能力。');
  if(source && source.kind!=='generation' && source.offering && source.offering!==offering)throw new Problem(422,'CAPABILITY_NOT_READY','来源项目的品种与本次材料不一致，请选择对应品种的项目或上传本次材料。');
  // Uploaded prospectuses can carry the issuer. The file task reads that source;
  // opening a chat to restate it is not a prerequisite for the material form.
  const template=await templateFor(db,owner,input.template);
  if(input.project_file&&template?.offering!==offering)invalid('模板与当前项目品种不同，请选择对应范围的模板。');
  const inputIssues=m4DocumentInputIssues(input,template);
  if(inputIssues.length)throw Object.assign(new Problem(422,'INPUT_REQUIRED','请补充所列信息后再生成。'),{inputIssues});
  const resolvedInput={...input,fields:{...input.fields,issuer_name:input.fields.issuer_name||source?.issuer_name||p.issuer_name||'',market,offering,broker:input.fields.broker||template?.broker||''}};
  if(input.project_file){const family=(await db.query('SELECT latest_version_id FROM bb_project_files WHERE owner_user_id=$1 AND project_id=$2 AND document_type=$3',[owner,input.project_file.project_id,type])).rows[0];resolvedInput.project_file={...input.project_file,expected_file_version_id:family?.latest_version_id??null};}
  return {version:'m4-document-input-v1',kind:'document',project_name:source?.name||p.name||t.name,topic_id:t.id,execution_scope_project_id:source?.execution_scope_project_id||source?.id||t.project_id,
    draft_version:dv,input:resolvedInput,template_material:template?.material??null,market:market as M4DocumentManifest['market'],offering:offering as M4DocumentManifest['offering'],
    knowledge:input.project_file?loadProjectFileKnowledge(market as M4DocumentManifest['market'],type,offering as M4DocumentManifest['offering']):loadM4Knowledge(market as M4DocumentManifest['market'],type,offering,input.fields.case_template_id),billing_task:M4_DOCUMENT_BILLING_TASKS[type]};
}
export function m4UnavailableDocument(content:string):boolean{return content.split(/[，。；;\n]/).some(clause=>{
  if(/(?:不要|无需|不用|不需要|不必|禁止|不得).{0,12}(?:生成|制作|起草|编制|撰写|准备|写|出具).{0,30}(?:公募.{0,8}摘要|DFI)/.test(clause))return false;
  return /(?:生成|制作|起草|编制|撰写|准备|写一份|出具).{0,30}(?:公募.{0,8}摘要|DFI)/.test(clause);
});}
export function m4UnavailableLocalScope(content:string):boolean{return content.split(/[，。；;\n]/).some(clause=>{
  if(/(?:不要|无需|不用|不需要|不必|禁止|不得).{0,12}(?:只|仅|局部)(?:修改|改|更新)/.test(clause))return false;
  return /^(?:请|帮我)?(?:只|仅)(?:修改|改|更新)|局部修改|局部改稿/.test(clause.trim());
});}
export function m4UnavailableResearch(content:string):boolean{return content.split(/[，。；;\n]/).some(clause=>{
  if(/(?:不要|无需|不用|不需要|不必|禁止|不得).{0,12}(?:联网|公开检索|实时查询|实时检索|法规检索|深度研究|多期系统分析|检索最新法规|查询现行法规)/.test(clause))return false;
  if(/(?:解释|什么是|是什么|是什么意思|概念).{0,15}(?:公开检索|实时查询|法规效力|法规适用|深度研究)|(?:公开检索|实时查询|法规效力|法规适用性|深度研究).{0,15}(?:是什么|是什么意思|概念)/.test(clause))return false;
  return /(?:联网|公开检索|实时查询|实时检索|法规检索|深度研究|多期系统分析)|(?:查找|检索|搜索|查询|核验|确认|验证).{0,30}(?:最新法规|现行法规|法规效力|法规适用|公开网站|公开信息|实时信息)|(?:法规效力|法规适用性).{0,15}(?:判断|核验|检索|查询)/.test(clause);
});}
export function classifyM4Qa(content:string,context:M4MessageContext):M4BillingTask|'m4_Q00'|'m4_task_assistance'{
  // Capability explanations and preparing a task never reserve user credits. Basic analysis still uses its actual QA category.
  const greeting=/^(?:(?:你好|您好|嗨|hi|hello)(?:[，,\s]*(?:bondbuddy|券商助手|项目助手))?|你是谁|你(?:能|可以)(?:帮我)?做什么|你有什么功能|介绍一下你自己)[\s!！?？。,.，]*$/i;
  const productSurface='(?:bondbuddy|券商助手|项目助手|产品|本产品|这个产品|材料生成|这个页面|这个功能)';
  const uploadTarget='(?:(?:财务|审计)?材料|附件|文件|原稿|模板|募集说明书|募集书|参考稿|历史稿|资料)';
  const outputTarget='(?:(?:已(?:经)?(?:生成|完成)(?:的)?|生成的|当前任务的|本次任务的|本项目的|我的|复核|财务|审计)?(?:成果|结果|文件|报告|word|pdf|修订版|清洁版)(?:文件|报告)?)';
  const outputOperation='(?:下载|查看|打开|找到|查找)';
  const outputHelp=`(?:(?:如何|怎么|在哪(?:里)?|哪里|从哪(?:里)?)${outputOperation}${outputTarget}|${outputTarget}(?:如何|怎么|在哪(?:里)?|在哪里)${outputOperation}?|下载(?:入口|链接)(?:在哪(?:里)?|在哪里))`;
  const workflowHelp='(?:(?:如何|怎么|在哪(?:里)?|哪里)(?:(?:查看|查询|查)(?:任务进度|任务状态|项目进度|项目状态|积分余额|余额|可用积分|积分流水|消费记录|积分记录)|(?:充值|购买)积分|(?:取消|停止)(?:当前|正在运行的|本次)?任务)|(?:任务进度|任务状态|积分余额|积分流水|余额)(?:如何|怎么|在哪(?:里)?|在哪里)(?:查看|查询|查)?|(?:当前|正在运行的|本次)?任务(?:如何|怎么)(?:取消|停止)|积分(?:如何|怎么)(?:充值|购买))';
  const productHelp=new RegExp(String.raw`^(?:并|也|还)?(?:请问|请你|请|能否|能不能|可以|能|麻烦你|麻烦)?(?:告诉我|帮我|说明|介绍|解释)?\s*(?:${productSurface}(?:的)?\s*)?(?:(?:如何|怎么)使用${productSurface}?|(?:如何|怎么)上传${uploadTarget}?(?:(?:到|至)(?:当前项目|本项目|这个项目|项目))?|${outputHelp}|${workflowHelp}|(?:产品|使用)帮助|支持哪些功能)(?:\s*吗)?$`,'i');
  // A selected source does not turn product help into paid material analysis. Every
  // clause must be help: an upload/use phrase cannot make a separate business question free.
  const clauses=content.split(/[，,。；;：:!！?？\n]/).map(c=>c.trim()).filter(Boolean);
  if(greeting.test(content.trim())||clauses.length && clauses.every(c=>greeting.test(c)||productHelp.test(c)))return 'm4_Q00';
  if(m4UnavailableDocument(content)||m4UnavailableResearch(content)||m4UnavailableLocalScope(content))return 'm4_task_assistance';
  const analysis=/解释|解读|查询|分析|计算|比较|对比|概念|条款|有哪些|是否|为什么|是什么意思|是什么|有什么|怎么理解|如何理解|同比|比率|公式/.test(content);
  if(context.document_type && !analysis)return 'm4_task_assistance';
  if(!analysis && /立项报告|募集说明书摘要|主承销商核查意见|法律意见书|申请书|推荐函|材料生成|任务要求|当前任务|开始制作|开始执行|准备材料|补充材料|采用.*模板|券商.*是|发行人.*是|要求.*(?:保存|记录)|保留|不要(?:生成|新增)|(?:作为|列为).*(?:重点|要求)|重点关注|(?:更新|复核).{0,15}(?:募集说明书|募集书)/.test(content))return 'm4_task_assistance';
  if(/比较|对比|两期|两年/.test(content))return 'm4_Q04';
  if(/计算|同比|资产负债率|流动比率|速动比率|公式/.test(content))return 'm4_Q03';
  return context.citations.length||context.source_material||context.reading_artifact?'m4_Q02':'m4_Q01';
}
async function qaSnapshot(db:Db,owner:string,t:any,b:{content:string;context:M4MessageContext}){
  await validateContext(db,owner,t,b.context);
  const draft=b.context.document_type?await readDraft(db,owner,t.id,b.context.document_type):null;
  const input=draft?(({version:_v,sha256:_s,updated_at:_u,...i})=>i)(draft):null;
  const messages=(await db.query('SELECT id AS message_id,version,role,content FROM bb_m4_messages WHERE owner_user_id=$1 AND topic_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200',[owner,t.id])).rows.reverse();
  const view=(await db.query('SELECT view FROM bb_m4_views WHERE owner_user_id=$1 AND topic_id=$2',[owner,t.id])).rows[0]?.view;
  const quotation=view?.quotation && b.context.citations.some(c=>equal(c,view.quotation.citation))?view.quotation:null;
  const selected=[...await sharedMaterials(db,owner,t.id),...b.context.citations.flatMap(c=>c.kind==='material'?[c.ref]:[]),...(b.context.source_material?[b.context.source_material]:[])];
  const materials=[...new Map(selected.map(p=>[`${p.source_project_id}:${p.material_id}:${p.material_version}`,p])).values()];
  for(const p of materials)await readM4MaterialPin(db,owner,p);
  const selectedProject=view?.assistant?.project_id?await project(db,owner,view.assistant.project_id):null;
  const assistant_context=t.surface==='assistant'?{project_id:selectedProject?.id??null,project_name:selectedProject?.name??'',
    issuer_name:selectedProject?.issuer_name??'',market:selectedProject?.market??'',offering:selectedProject?.offering??'',
    reporting_cutoff:selectedProject?.update_details?.reporting_cutoff??'',action:view?.assistant?.action??null}:undefined;
  return {content:b.content,context:b.context,context_snapshot:{draft:input,messages,quotation},materials,
    ...(assistant_context?{assistant_context}:{}),billing_task:classifyM4Qa(b.content,b.context)};
}
async function newRun(c:PoolClient,owner:string,t:any,requestKey:string,requestHash:string,manifest:M4Manifest,quoteId:string|undefined,intentHash:string,queueEnabled:boolean){
  const p=await project(c,owner,t.project_id,true);const rev=Number((await c.query('SELECT COALESCE(max(revision),0)+1 AS next FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[owner,t.project_id])).rows[0].next);
  const hash=inputManifestHash(manifest),materials=manifest.kind==='document'?[...manifest.input.materials,...(manifest.input.source_material?[manifest.input.source_material]:[]),...(manifest.template_material?[manifest.template_material]:[])]:manifest.materials;
  await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[t.project_id,rev,owner,p.draft_revision,hash,manifest,JSON.stringify(materials),JSON.stringify(manifest.kind==='document'?manifest.input.requirements.map(r=>r.message_id):[])]);
  await c.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,t.project_id,rev]);
  const r=(await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[uid(),owner,t.project_id,rev,hash,executionKeyStorage(requestKey),manifest.kind==='document'?'generation':'qa',requestHash,queueEnabled?'queued':'paused'])).rows[0];
  await c.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',[r.id,owner,t.id,manifest,hash]);
  await reserveM4(c,owner,r,quoteId,t.id,intentHash);
  await enqueue(c,r,manifest.kind==='document'?M4_DOCUMENT_SUBTYPE:M4_QA_SUBTYPE);
  r.state='queued';r.stage='queued';
  if(!queueEnabled){
    const eventId=uid(),seq=2,payload={reason:'m4_runtime_disabled'};
    await c.query("UPDATE bb_jobs SET state='paused',stage='capability_not_ready' WHERE run_id=$1",[r.id]);
    await c.query("UPDATE bb_runs SET state='paused',stage='capability_not_ready',event_cursor=$2 WHERE id=$1",[r.id,seq]);
    await c.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$3,'run.state_changed','paused','capability_not_ready',$5)`,[eventId,owner,r.id,seq,payload]);
    await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'run',$3,'run.state_changed',$4)`,[uid(),owner,r.id,{run_id:r.id,event_id:eventId,seq,state:'paused',stage:'capability_not_ready',...payload}]);
    r.state='paused';r.stage='capability_not_ready';r.event_cursor=seq;
  }else r.event_cursor=1;
  await topicEvent(c,owner,t.id,'m4.execution_started',{run_id:r.id,input_hash:hash});return r;
}
async function executeDocument(c:PoolClient,owner:string,t:any,b:M4ExecuteRequest,queueEnabled:boolean){
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${owner}:${b.execution_request_id}`]);const requestHash=inputManifestHash({topic_id:t.id,...b});
  const old=(await c.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[owner,executionKeyStorage(b.execution_request_id)])).rows[0];
  if(old){if(old.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','执行请求已绑定其他任务。');return old;}
  const manifest=await documentManifest(c,owner,t,b.document_type,b.expected_draft_version);
  if(manifest.kind!=='document')invalid('Invalid document input');
  const currentProject=await project(c,owner,t.project_id,true);
  if((currentProject.execution_scope_project_id||currentProject.id)!==manifest.execution_scope_project_id
    && (await c.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND execution_scope_project_id=$2 AND id<>$2 LIMIT 1',[owner,t.project_id])).rowCount)
    throw conflict('INPUT_REVISION_CONFLICT','本话题已被其他业务采用为来源，请新建话题使用新的来源。');
  if((await c.query("SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind<>'qa' AND NOT(state=ANY($3::text[])) AND NOT bb_is_workpaper_assessment(owner_user_id,project_id,input_revision)",[owner,t.project_id,terminal])).rowCount)
    throw conflict('PROJECT_RUN_ACTIVE','本话题已有任务执行中，新输入将作为后继草稿保存。');
  const sourceId=manifest.input.source_material?.source_project_id||manifest.input.edit_base?.source_project_id||t.source_project_id;
  const scopeIds=[...new Set([manifest.execution_scope_project_id,...(sourceId?[sourceId]:[])])].sort();
  let scopeProjects:any[];
  try{scopeProjects=(await c.query(`SELECT * FROM bb_projects WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE NOWAIT`,[owner,scopeIds])).rows;}
  catch(error){if((error as {code?:string}).code==='55P03')throw conflict('INPUT_REVISION_CONFLICT','来源项目正在保存或提交任务，请稍后重新核对并执行。');throw error;}
  if(scopeProjects.length!==scopeIds.length)throw missing();
  if(sourceId){const source=scopeProjects.find(p=>p.id===sourceId)!;if((source.execution_scope_project_id||source.id)!==manifest.execution_scope_project_id)stale();}
  const active=(await c.query(`SELECT r.id FROM bb_runs r JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND COALESCE(p.execution_scope_project_id,p.id)=$2 AND r.task_kind<>'qa' AND NOT(r.state=ANY($3::text[]))
    AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision) LIMIT 1`,[owner,manifest.execution_scope_project_id,terminal])).rows[0];
  if(active)throw conflict('PROJECT_RUN_ACTIVE','同一项目已有任务执行中；新要求已保存，请等待完成或停止任务后执行。');
  await c.query("UPDATE bb_projects SET execution_scope_project_id=$3,kind=CASE WHEN kind='qa' THEN 'generation' ELSE kind END WHERE owner_user_id=$1 AND id=$2",[owner,t.project_id,manifest.execution_scope_project_id]);
  return newRun(c,owner,t,b.execution_request_id,requestHash,manifest,b.quote_id,inputManifestHash(manifest),queueEnabled);
}
async function artifactRows(db:Db,owner:string,topic:string){return (await db.query(`SELECT a.*,v.sha256,v.media_type,r.project_id,${artifactNameColumns('v')} FROM bb_m4_artifacts a
  JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id
  JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id ${artifactNameJoins('v')} WHERE a.owner_user_id=$1 AND a.topic_id=$2
  AND NOT coalesce(a.document_type='workpaper' AND a.kind='preparation_note',false)
  AND v.quality_status='passed' AND v.delivery_status='available' AND (r.state='succeeded' OR NOT EXISTS(SELECT 1 FROM bb_credit_reservations c WHERE c.id=r.reservation_id AND c.owner_user_id=r.owner_user_id AND c.billing_policy='authoring_balance_v2')) ORDER BY a.created_at,a.kind`,[owner,topic])).rows;}
const artifactDto=(a:any):M4Artifact=>({source_project_id:a.project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256.trim(),
  topic_id:a.topic_id,run_id:a.run_id,document_type:a.document_type,kind:a.kind,filename:artifactDownloadName(a).filename,mime_type:a.media_type,byte_size:Number(a.byte_size),
  created_at:date(a.created_at),base_artifact:a.base_artifact,input_hash:a.input_hash.trim(),revision_number:a.revision_number??null});
export type M4ArtifactRegistration={kind:'document'|'preparation_note';artifact_id:string;artifact_version:number;filename:string;byte_size:number;preview_content?:string};
/** Worker transaction must hold its current lease. Owned delivered metadata is checked, never inferred from a client. */
export async function registerM4Artifacts(db:Db,owner:string,runId:string,entries:M4ArtifactRegistration[]){
  const e=(await db.query('SELECT * FROM bb_m4_executions WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows[0];
  if(!e || !isM4Manifest(e.manifest) || e.manifest.kind!=='document')throw missing();const manifest=e.manifest;
  await requireTopic(db,owner,e.topic_id,true);
  const previous=(await db.query('SELECT revision_number FROM bb_m4_artifacts WHERE owner_user_id=$1 AND run_id=$2 AND revision_number IS NOT NULL LIMIT 1',[owner,runId])).rows[0];
  const revisionNumber=previous?.revision_number??Number((await db.query('SELECT COALESCE(max(revision_number),0)+1 AS next FROM bb_m4_artifacts WHERE owner_user_id=$1 AND topic_id=$2 AND document_type=$3',[owner,e.topic_id,manifest.input.document_type])).rows[0].next);
  for(const a of entries){const row=(await db.query(`SELECT v.*,e.byte_size AS delivered_bytes FROM bb_artifact_versions v JOIN bb_word_delivery_evidence e
    ON e.id=v.word_delivery_evidence_id AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id
    WHERE v.owner_user_id=$1 AND v.run_id=$2 AND v.id=$3 AND v.version=$4
    AND v.delivery_status='available' AND v.quality_status='passed' AND e.delivery_code='readback_verified' AND e.readback_sha256=v.sha256`,[owner,runId,a.artifact_id,a.artifact_version])).rows[0];
    if(!row || row.media_type!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document' || !Number.isSafeInteger(a.byte_size) || a.byte_size<1 || Number(row.delivered_bytes)!==a.byte_size)throw new Problem(422,'DELIVERY_FAILED','M4 Word unavailable');
    const filename=`${manifest.input.workpaper?.entry.path.split('/').at(-1)?.replace(/\.docx$/i,'')??M4_DOCUMENT_LABELS[manifest.input.document_type as M4DocumentType]} 第${revisionNumber}稿${a.kind==='preparation_note'?' 编制说明':''}.docx`;
    const prior=(await db.query('SELECT * FROM bb_m4_artifacts WHERE run_id=$1 AND kind=$2',[runId,a.kind])).rows[0];
    if(prior){if(prior.artifact_id!==a.artifact_id || prior.artifact_version!==a.artifact_version || prior.filename!==filename || Number(prior.byte_size)!==a.byte_size)throw conflict('IDEMPOTENCY_CONFLICT','M4 artifact changed');continue;}
    await db.query(`INSERT INTO bb_m4_artifacts(owner_user_id,topic_id,run_id,artifact_id,artifact_version,kind,filename,byte_size,document_type,base_artifact,input_hash,preview_content,revision_number)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[owner,e.topic_id,runId,a.artifact_id,a.artifact_version,a.kind,filename,a.byte_size,manifest.input.document_type,manifest.input.edit_base,e.input_hash,a.preview_content??null,revisionNumber]);
  }
  await topicEvent(db,owner,e.topic_id,'m4.artifacts_ready',{run_id:runId,kinds:entries.map(a=>a.kind)});
}
/** Persist a real textual answer and restoreable reply. No Word delivery semantics are applied to QA. */
export async function completeM4Qa(db:Db,owner:string,runId:string,reply:M4AssistantReply):Promise<{artifactId:string;artifactVersion:number}>{
  if(!Value.Check(M4AssistantReplySchema,reply))invalid('Invalid M4 assistant reply');
  const replyFields=normalizedAssistantFields(reply.fields);
  const e=(await db.query('SELECT * FROM bb_m4_executions WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows[0];
  if(!e || !isM4Manifest(e.manifest) || e.manifest.kind!=='qa')throw missing();const manifest=e.manifest as M4QaManifest;
  const t=await requireTopic(db,owner,e.topic_id,true);
  if(t.surface==='assistant' && (reply.intent==='execute'||reply.document_type||reply.requirements.length||Object.keys(reply.fields).length))invalid('Global assistant replies only propose a confirmation card');
  for(const citation of reply.citations){if(!manifest.context.citations.some(c=>equal(c,citation))
    && !(citation.kind==='material' && (manifest.materials.some(p=>equal(p,citation.ref)) || equal(manifest.context.source_material,citation.ref)))
    && !(citation.kind==='artifact' && equal(manifest.context.reading_artifact,citation.ref)))invalid('Assistant citation was not in the pinned task input');}
  const prior=(await db.query('SELECT * FROM bb_m4_messages WHERE owner_user_id=$1 AND reply_to=$2',[owner,manifest.message_id])).rows[0];
  if(prior && !equal(prior.reply,reply))throw conflict('IDEMPOTENCY_CONFLICT','Assistant reply already persisted with another result');
  let messageId=prior?.id??uid();
  if(!prior){await db.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,reply_to,run_id,reply_status,reply)
    VALUES($1,$2,$3,'assistant',$4,$5,$6,$7,'completed',$8)`,[messageId,owner,e.topic_id,reply.content,manifest.context,manifest.message_id,runId,reply]);
    // Apply only to the same saved draft version. Newer drafts retain their own input and receive a visible conflict.
    if(reply.document_type && (reply.requirements.length || Object.keys(reply.fields).length)){
      const current=await readDraft(db,owner,t.id,reply.document_type);
      if(manifest.context.document_type===reply.document_type && current.version===manifest.context.draft_version || manifest.context.document_type===null && current.version===0){
        const {version,sha256:_s,updated_at:_u,...input}=current;
        const fields={...input.fields};for(const [key,value] of Object.entries(replyFields))if(['issuer_name','broker','market','offering','case_template_id','reporting_period','reporting_cutoff','bond_name','amount','term','use_of_proceeds'].includes(key))fields[key]=value;
        const requirements=[...input.requirements,...reply.requirements.filter(s=>!input.requirements.some(r=>r.text===s)).map((text,i)=>({requirement_id:`${messageId}:${i}`,text,message_id:messageId,message_version:1}))];
        const pending=await pendingDraftRequirements(db,owner,t.id),adopted={...input,fields,requirements:[...requirements,...pending.filter(r=>!requirements.some(x=>x.requirement_id===r.requirement_id))]};
        // Repeating the already displayed task must preserve its version and quote. A newly consumed pending requirement is an input change.
        if(!equal(input,adopted))await saveDraft(db,owner,t.id,adopted,version);
        else if(pending.length)await consumePendingRequirements(db,owner,t.id,reply.document_type,version);
      }else {await db.query('UPDATE bb_m4_messages SET error=$3 WHERE owner_user_id=$1 AND id=$2',[owner,messageId,'任务草稿已变化，本条建议未自动覆盖输入，请核对准确上下文后采纳。']);
        await topicEvent(db,owner,t.id,'m4.reply_adoption_conflict',{message_id:messageId,document_type:reply.document_type});}
    }else if(!reply.document_type && reply.requirements.length){
      for(const [i,text] of reply.requirements.entries())await db.query(`INSERT INTO bb_m4_pending_requirements(owner_user_id,topic_id,requirement_id,message_id,message_version,text)
        VALUES($1,$2,$3,$4,1,$5) ON CONFLICT DO NOTHING`,[owner,t.id,`${messageId}:${i}`,messageId,text]);
    }
  }
  if(manifest.execution_proposal && !prior && reply.intent==='execute' && reply.document_type===manifest.execution_proposal.document_type){
    const proposal=manifest.execution_proposal,current=await readDraft(db,owner,t.id,proposal.document_type);
    if(current.version===proposal.expected_draft_version && reply.requirements.every(s=>current.requirements.some(r=>r.text===s))
      && Object.entries(replyFields).every(([k,v])=>current.fields[k]===v)){
      await db.query('SAVEPOINT m4_semantic_execute');
      try{const r=await executeDocument(db as PoolClient,owner,t,{execution_request_id:`m4-intent-${manifest.message_id}`,document_type:proposal.document_type,
        expected_draft_version:proposal.expected_draft_version,quote_id:proposal.quote_id,entrypoint:'assistant'},true);
        await topicEvent(db,owner,t.id,'m4.intent_executed',{message_id:messageId,run_id:r.id});await db.query('RELEASE SAVEPOINT m4_semantic_execute');
      }catch(error){await db.query('ROLLBACK TO SAVEPOINT m4_semantic_execute');if(!(error instanceof Problem))throw error;
        await db.query('UPDATE bb_m4_messages SET error=$3 WHERE owner_user_id=$1 AND id=$2',[owner,messageId,error.message]);}
    }else await db.query('UPDATE bb_m4_messages SET error=$3 WHERE owner_user_id=$1 AND id=$2',[owner,messageId,'输入或要求已更新，请核对工作区最新任务和预留上限后明确执行。']);
  }
  await db.query("UPDATE bb_m4_messages SET reply_status='completed' WHERE owner_user_id=$1 AND id=$2",[owner,manifest.message_id]);
  const textContent=reply.content+'\n'+(reply.citations.length?'\n来源引用：\n'+reply.citations.map(c=>JSON.stringify(c)).join('\n'):'')+'\n公开检索：未执行。\n';
  const hash=digest(textContent),artifactId=`m4qa-${runId}`,bytes=Buffer.byteLength(textContent);
  const evidenceId=`m4qa-evidence-${runId}`;
  await db.query(`INSERT INTO bb_m4_text_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,sha256,byte_size,content)
    VALUES($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT DO NOTHING`,[evidenceId,owner,runId,artifactId,hash,bytes,textContent]);
  await db.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,m4_text_delivery_evidence_id)
    VALUES($1,1,$2,$3,'text/plain',$4,$5,'passed','available',$6) ON CONFLICT DO NOTHING`,[artifactId,owner,runId,hash,`m4/qa/${owner}/${runId}/${hash}.txt`,evidenceId]);
  await db.query(`INSERT INTO bb_m4_artifacts(owner_user_id,topic_id,run_id,artifact_id,artifact_version,kind,filename,byte_size,input_hash,body_content,preview_content)
    VALUES($1,$2,$3,$4,1,'qa_text','项目问答.txt',$5,$6,$7,$7) ON CONFLICT DO NOTHING`,[owner,e.topic_id,runId,artifactId,bytes,e.input_hash,textContent]);
  await topicEvent(db,owner,t.id,'m4.reply_completed',{message_id:messageId,run_id:runId});return {artifactId,artifactVersion:1};
}
async function workspace(db:Db,owner:string,id:string):Promise<M4Workspace>{
  const t=await requireTopic(db,owner,id),p=await project(db,owner,t.project_id),materials=await sharedMaterials(db,owner,id);
  const material_details=await Promise.all(materials.map(async pin=>{const m=await readM4MaterialPin(db,owner,pin);return {...pin,filename:m.filename,state:m.state,media_type:m.media_type,role:m.role};}));
  const messages=(await db.query(`SELECT m.*,r.state AS run_state FROM bb_m4_messages m LEFT JOIN bb_runs r ON r.id=m.run_id AND r.owner_user_id=m.owner_user_id
    WHERE m.owner_user_id=$1 AND m.topic_id=$2 ORDER BY m.created_at,m.id`,[owner,id])).rows.map(messageDto);
  const artifacts=(await artifactRows(db,owner,id)).map(artifactDto);
  const rows=(await db.query(`SELECT r.*,e.manifest FROM bb_m4_executions e JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
    WHERE e.owner_user_id=$1 AND e.topic_id=$2 ORDER BY e.created_at`,[owner,id])).rows;
  const tasks=await Promise.all(rows.map(async r=>({run:runDto(r),manifest:r.manifest as M4Manifest,created_at:date(r.created_at),...(r.manifest.kind==='document'?{credit_charge:await readM4CreditCharge(db,owner,r.id)}:{}),artifacts:artifacts.filter(a=>a.run_id===r.id),
    events:(await db.query('SELECT * FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 ORDER BY seq',[owner,r.id])).rows.map(ev=>({event_id:ev.id,schema_version:1 as const,trace_id:ev.trace_id,run_id:ev.run_id,seq:ev.seq,type:ev.type,state:ev.state,stage:ev.stage,payload:runEventPayloadDto(ev.payload),occurred_at:date(ev.occurred_at)}))})));
  const view=(await db.query('SELECT * FROM bb_m4_views WHERE owner_user_id=$1 AND topic_id=$2',[owner,id])).rows[0];
  const templates=(await db.query(`SELECT t.* FROM bb_m4_templates t
    WHERE t.owner_user_id=$1 AND EXISTS (
      SELECT 1 FROM bb_material_versions m JOIN bb_projects p ON p.id=m.project_id AND p.owner_user_id=m.owner_user_id
      WHERE m.owner_user_id=t.owner_user_id AND m.project_id=t.material->>'source_project_id'
        AND m.id=t.material->>'material_id' AND m.version=(t.material->>'material_version')::int
        AND m.sha256=t.material->>'sha256' AND m.deleted_at IS NULL AND p.deleted_at IS NULL)
    ORDER BY t.created_at DESC`,[owner])).rows.map(templateDto);
  const pending_requirements=(await db.query(`SELECT requirement_id,text,message_id,message_version FROM bb_m4_pending_requirements
    WHERE owner_user_id=$1 AND topic_id=$2 AND consumed_document_type IS NULL ORDER BY created_at,requirement_id`,[owner,id])).rows;
  const drafts=Object.fromEntries(await Promise.all(M4_DOCUMENT_TYPES.map(async type=>[type,await readDraft(db,owner,id,type)]))) as M4Workspace['drafts'];
  return {topic:topicDto(t),project:projectDto(p),drafts,
    materials,material_details,templates,messages,tasks,artifacts,pending_requirements,view:{...(view?.view??emptyM4View()),version:view?.version??0},active_run:[...tasks].reverse().find(t=>t.manifest.kind==='document' && !terminal.includes(t.run.state))?.run??null};
}
export function registerM4Routes(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs,queueEnabled:boolean){
  const base=M4_API_BASE;
  app.get(`${base}/topics`,async request=>{const user=await owner(request);const rows=(await db().query(`SELECT t.* FROM bb_m4_topics t JOIN bb_projects p ON p.id=t.project_id AND p.owner_user_id=t.owner_user_id
    WHERE t.owner_user_id=$1 AND p.deleted_at IS NULL ORDER BY t.updated_at DESC,t.id`,[user])).rows;return {topics:rows.map(topicDto)};});
  app.post(`${base}/topics`,{schema:{body:M4TopicCreateRequestSchema}},async request=>{const user=await owner(request),b=request.body as M4TopicCreateRequest;
    return transaction(db(),async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:m4-topic:${b.creation_request_id}`]);const h=inputManifestHash(b);
      const old=(await c.query('SELECT * FROM bb_m4_topics WHERE owner_user_id=$1 AND creation_request_id=$2',[user,b.creation_request_id])).rows[0];
      if(old){if(old.request_hash.trim()!==h)throw conflict('IDEMPOTENCY_CONFLICT','话题请求已被使用。');return {topic:topicDto(old)};}
      const source=b.source_project_id?await project(c,user,b.source_project_id,true):null,projectId=uid(),topicId=uid();
      const scope=source?.execution_scope_project_id||source?.id||projectId;
      await c.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,execution_scope_project_id)
        VALUES($1,$2,$3,$7,$4,$5,'private',$6)`,[projectId,user,b.name,source?.issuer_name??null,source?.market??null,scope,b.surface==='assistant'?'qa':'generation']);
      const t=(await c.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash,surface)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[topicId,user,projectId,source?.id??null,b.name,b.creation_request_id,h,b.surface??'materials'])).rows[0];
      await topicEvent(c,user,topicId,'m4.topic_created',{project_id:projectId});return {topic:topicDto(t)};});});
  app.get(`${base}/topics/:topic_id/workspace`,async request=>workspace(db(),await owner(request),param(request,'topic_id')));
  app.post(`${base}/topics/:topic_id/handoffs/bind`,{schema:{body:M4HandoffBindRequestSchema,response:{200:M4HandoffBindResponseSchema}}},async request=>{
    const user=await owner(request),id=param(request,'topic_id'),b=request.body as M4HandoffBindRequest;
    return transaction(db(),c=>bindHandoff(c,user,id,b));});
  app.put(`${base}/topics/:topic_id/drafts/:document_type`,{schema:{body:M4DraftRequestSchema}},async request=>{const user=await owner(request),id=param(request,'topic_id'),type=param(request,'document_type'),b=request.body as M4DraftRequest;
    if(!M4_DOCUMENT_TYPES.includes(type as M4DocumentType)||b.input.document_type!==type)invalid('Unknown material type');
    return transaction(db(),async c=>{await requireTopic(c,user,id,true);for(const pin of b.input.materials)await adoptMaterial(c,user,id,pin);return {draft:await saveDraft(c,user,id,b.input,b.expected_version)};});});
  app.post(`${base}/topics/:topic_id/materials`,async request=>{const user=await owner(request),id=param(request,'topic_id'),b=request.body as {material:M4MaterialPin};
    const {M4MaterialPinSchema}=await import('@bondbuddy/contracts');if(!Value.Check(M4MaterialPinSchema,b?.material))invalid('Exact material version required');
    return transaction(db(),async c=>{await requireTopic(c,user,id,true);await adoptMaterial(c,user,id,b.material);await topicEvent(c,user,id,'m4.material_adopted',{material:b.material});return {materials:await sharedMaterials(c,user,id)};});});
  app.put(`${base}/topics/:topic_id/view`,{schema:{body:M4ViewRequestSchema}},async request=>{const user=await owner(request),id=param(request,'topic_id'),b=request.body as M4ViewRequest;
    return transaction(db(),async c=>{const t=await requireTopic(c,user,id,true);const old=(await c.query('SELECT * FROM bb_m4_views WHERE owner_user_id=$1 AND topic_id=$2',[user,id])).rows[0];
      if((old?.version??0)!==b.expected_version)stale();
      if(b.view.assistant?.project_id)await project(c,user,b.view.assistant.project_id);
      if(b.view.assistant && t.surface!=='assistant')invalid('Assistant state requires an assistant conversation');
      for(const a of [...b.view.open_tabs,...(b.view.active_tab?[b.view.active_tab]:[])])await readM4ArtifactPin(c,user,a);
      // An unsent old context can be restored as-is; validate its precise references without forcing a newer draft.
      await validateContext(c,user,t,{...b.view.unsent_context,document_type:null,draft_version:0});
      const row=(await c.query(`INSERT INTO bb_m4_views(owner_user_id,topic_id,version,view) VALUES($1,$2,$3,$4) ON CONFLICT(topic_id)
        DO UPDATE SET version=EXCLUDED.version,view=EXCLUDED.view,updated_at=now() RETURNING *`,[user,id,b.expected_version+1,b.view])).rows[0];
      await topicEvent(c,user,id,'m4.view_saved',{version:row.version});return {view:{...row.view,version:row.version}};});});
  app.get(`${base}/templates`,async request=>{const user=await owner(request);return {templates:(await db().query('SELECT * FROM bb_m4_templates WHERE owner_user_id=$1 ORDER BY created_at DESC',[user])).rows.map(templateDto)};});
  app.post(`${base}/templates`,{schema:{body:M4TemplateCreateRequestSchema}},async request=>{const user=await owner(request),b=request.body as M4TemplateCreateRequest;
    return transaction(db(),async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:template:${b.creation_request_id}`]);const h=inputManifestHash(b);
      const old=(await c.query('SELECT * FROM bb_m4_templates WHERE owner_user_id=$1 AND creation_request_id=$2',[user,b.creation_request_id])).rows[0];if(old){if(old.request_hash.trim()!==h)throw conflict('IDEMPOTENCY_CONFLICT','模板创建请求已被使用。');return {template:templateDto(old)};}
      const material=await readM4MaterialPin(c,user,b.material);if(material.media_type!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document')invalid('券商模板须为 Word 文档。');
      if(b.document_type==='init'&&!b.broker.trim())throw new Problem(422,'INPUT_REQUIRED','立项模板须填写所属券商。');
      const p=await project(c,user,b.material.source_project_id);const market=b.market||p.market;if(!(MARKETS as readonly string[]).includes(market))throw new Problem(422,'INPUT_REQUIRED','模板须明确市场范围。');
      const offering=b.offering??'private';if(!(MARKET_OFFERINGS[market as typeof MARKETS[number]] as readonly string[]).includes(offering))invalid('模板的市场与品种不匹配。');
      let id=uid(),version=1;if(b.replaces_template_id){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:m4-template-version:${b.replaces_template_id}`]);
        const previous=(await c.query('SELECT * FROM bb_m4_templates WHERE owner_user_id=$1 AND id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE',[user,b.replaces_template_id])).rows[0];
        if(!previous)throw missing();if(previous.document_type!==b.document_type)invalid('A template revision must retain its document type');id=previous.id;version=previous.version+1;}
      const row=(await c.query(`INSERT INTO bb_m4_templates(id,version,owner_user_id,document_type,name,broker,material,sha256,creation_request_id,request_hash,market,offering)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[id,version,user,b.document_type,b.name,b.broker,b.material,b.material.sha256,b.creation_request_id,h,market,offering])).rows[0];return {template:templateDto(row)};});});
  app.post(`${base}/topics/:topic_id/quote`,{schema:{body:M4QuoteRequestSchema}},async request=>{const user=await owner(request),id=param(request,'topic_id'),b=request.body as M4QuoteRequest;
    return transaction(db(),async c=>{const t=await requireTopic(c,user,id,true);if(b.kind==='document'){const m=await documentManifest(c,user,t,b.document_type,b.expected_draft_version);if(m.kind!=='document')invalid('Invalid document');return quoteM4(c,user,id,m.billing_task,inputManifestHash(m),m);}
      const s=await qaSnapshot(c,user,t,b);return quoteM4(c,user,id,s.billing_task,inputManifestHash(s),s);});});
  app.post(`${base}/topics/:topic_id/execute`,{schema:{body:M4ExecuteRequestSchema}},async request=>{const user=await owner(request),id=param(request,'topic_id'),b=request.body as M4ExecuteRequest;
    return transaction(db(),async c=>{const t=await requireTopic(c,user,id,true);return {run:runDto(await executeDocument(c,user,t,b,queueEnabled))};});});
  app.post(`${base}/topics/:topic_id/messages`,{schema:{body:M4MessageRequestSchema}},async request=>{const user=await owner(request),id=param(request,'topic_id'),b=request.body as M4MessageRequest;
    return transaction(db(),async c=>{const t=await requireTopic(c,user,id,true);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:m4-message:${b.submission_request_id}`]);const h=inputManifestHash({topic_id:id,...b});
      const old=(await c.query('SELECT * FROM bb_m4_messages WHERE owner_user_id=$1 AND submission_request_id=$2',[user,b.submission_request_id])).rows[0];
      if(old){if(old.request_hash.trim()!==h)throw conflict('IDEMPOTENCY_CONFLICT','Message request already used');const r=(await c.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[user,old.run_id])).rows[0];return {message:messageDto(old),run:runDto(r)};}
      if(b.execute && t.surface==='assistant')invalid('Please confirm the saved task card');
      if(b.execute){
        if(!b.context.document_type || !b.context.draft_version || !b.quote_id)throw new Problem(422,'INPUT_REQUIRED','请先核对本业务工作区的完整任务和当前预留上限，再明确执行。');
        // Extra free text must first become an adopted requirement; an execution flag never discards it.
        if(!/^(开始制作|开始执行|按当前任务制作|按当前任务执行)[。！!\s]*$/.test(b.content.trim())){
          await validateContext(c,user,t,b.context);const snapshot=await qaSnapshot(c,user,t,b),messageId=uid();
          const proposal={document_type:b.context.document_type,expected_draft_version:b.context.draft_version,quote_id:b.quote_id};
          const manifest:M4Manifest={version:'m4-qa-input-v1',kind:'qa',topic_id:id,message_id:messageId,...snapshot,billing_task:'m4_task_assistance',execution_proposal:proposal};
          const row=(await c.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,submission_request_id,request_hash,reply_status)
            VALUES($1,$2,$3,'user',$4,$5,$6,$7,'queued') RETURNING *`,[messageId,user,id,b.content,b.context,b.submission_request_id,h])).rows[0];
          const freeQuote=await quoteM4(c,user,id,'m4_task_assistance',inputManifestHash(manifest),manifest);
          const r=await newRun(c,user,t,`m4-message-${b.submission_request_id}`,h,manifest,freeQuote.quote.quote_id,inputManifestHash(manifest),queueEnabled);
          await c.query('UPDATE bb_m4_messages SET run_id=$2 WHERE id=$1',[messageId,r.id]);row.run_id=r.id;return {message:messageDto(row),run:runDto(r)};
        }
        await validateContext(c,user,t,b.context);
        const r=await executeDocument(c,user,t,{execution_request_id:`m4-chat-${b.submission_request_id}`,document_type:b.context.document_type,
          expected_draft_version:b.context.draft_version,quote_id:b.quote_id,entrypoint:'assistant'},queueEnabled);
        const messageId=uid(),row=(await c.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,submission_request_id,request_hash,run_id,reply_status)
          VALUES($1,$2,$3,'user',$4,$5,$6,$7,$8,'completed') RETURNING *`,[messageId,user,id,b.content,b.context,b.submission_request_id,h,r.id])).rows[0];
        const reply:M4AssistantReply={content:'已按当前工作区的准确输入开始制作；执行过程将在这里持续展示。',citations:[],requirements:[],fields:{},intent:'execute',document_type:b.context.document_type,target_business:null,retrieval:'not_performed'};
        await c.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,reply_to,run_id,reply_status,reply)
          VALUES($1,$2,$3,'assistant',$4,$5,$6,$7,'completed',$8)`,[uid(),user,id,reply.content,b.context,messageId,r.id,reply]);
        await topicEvent(c,user,id,'m4.message_executed',{message_id:messageId,run_id:r.id});return {message:messageDto(row),run:runDto(r)};
      }
      if(t.surface==='assistant' && b.execute)invalid('Please confirm the saved task card');
      const snapshot=await qaSnapshot(c,user,t,b),messageId=uid();
      const row=(await c.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,submission_request_id,request_hash,reply_status)
        VALUES($1,$2,$3,'user',$4,$5,$6,$7,'queued') RETURNING *`,[messageId,user,id,b.content,b.context,b.submission_request_id,h])).rows[0];
      const manifest:M4Manifest={version:'m4-qa-input-v1',kind:'qa',topic_id:id,message_id:messageId,...snapshot};
      let quoteId=b.quote_id;if(['m4_Q00','m4_task_assistance'].includes(snapshot.billing_task)&&!quoteId)quoteId=(await quoteM4(c,user,id,snapshot.billing_task,inputManifestHash(snapshot),snapshot)).quote.quote_id;
      const r=await newRun(c,user,t,`m4-message-${b.submission_request_id}`,h,manifest,quoteId,inputManifestHash(snapshot),queueEnabled);
      await c.query('UPDATE bb_m4_messages SET run_id=$2 WHERE id=$1',[messageId,r.id]);row.run_id=r.id;
      await topicEvent(c,user,id,'m4.message_sent',{message_id:messageId,run_id:r.id});return {message:messageDto(row),run:runDto(r)};});});
  const readArtifact=async(request:FastifyRequest)=>{const user=await owner(request),artifactId=param(request,'artifact_id'),version=Number(param(request,'artifact_version'));
    if(!Number.isSafeInteger(version)||version<1)invalid('Invalid artifact version');
    const a=(await db().query(`SELECT a.*,v.sha256,v.media_type,v.object_key,r.project_id,${artifactNameColumns('v')} FROM bb_m4_artifacts a
      JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id
      JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id ${artifactNameJoins('v')}
      WHERE a.owner_user_id=$1 AND a.artifact_id=$2 AND a.artifact_version=$3 AND p.deleted_at IS NULL AND v.delivery_status='available' AND v.quality_status='passed' AND (r.state='succeeded' OR NOT EXISTS(SELECT 1 FROM bb_credit_reservations c WHERE c.id=r.reservation_id AND c.owner_user_id=r.owner_user_id AND c.billing_policy='authoring_balance_v2'))`,[user,artifactId,version])).rows[0];if(!a)throw missing();return a;};
  app.get(`${base}/artifacts/:artifact_id/versions/:artifact_version/preview`,async request=>{const a=await readArtifact(request);return {artifact:artifactDto(a),content:a.preview_content??'此准确版本暂无文本预览，请下载原始 Word 查看。'};});
  app.get(`${base}/artifacts/:artifact_id/versions/:artifact_version/bytes`,async(request,reply)=>{const a=await readArtifact(request);
    const bytes=a.kind==='qa_text'?Buffer.from(a.body_content??'','utf8'):await blobs().getIfExistsBounded(a.object_key,100*1024*1024);
    if(!bytes || bytes.length!==Number(a.byte_size) || digest(bytes)!==a.sha256.trim())throw new Problem(503,'DELIVERY_FAILED','成果字节或准确版本核验失败。');
    return reply.type(a.media_type).header('Cache-Control','private, no-store').header('Content-Disposition',contentDisposition(artifactDownloadName(a).filename)).send(bytes);});
}

export { documentManifest as projectFileDocumentManifest, newRun as startPinnedM4Run, workspace as readM4Workspace, saveDraft as saveM4Draft };
