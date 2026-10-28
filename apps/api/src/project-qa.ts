import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {QA_HISTORY_CAPABILITY,PROJECT_QA_PRICE,OUTCOME_PRICE_VERSION,qaSchemas,qaProspectusIssue,type QaDraft,type QaInput,type QaResult,type QaWorkspace,type QaQuestion} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,Problem,date,assertCanonicalBusinessRunIdle} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {creditBalance,lockCreditAccount} from './billing.js';
import {enqueue} from './queue.js';
import {outcomeMetadata} from './outcome-pricing.js';
import {readProjectFileAsset,projectFileSource} from './project-file-storage.js';
import {memberProjectsSql} from './project-collection.js';
import {qaCaseSearch} from './qa-knowledge.js';
import {requestScope,assertScopeQuote,scopePriceMetadata} from './scope-quotations.js';
const empty=():QaDraft=>({preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:true});
const terminal=['succeeded','failed','cancelled','rejected','test_completed'];
type Db=Pool|PoolClient;
export async function qaMaterials(db:Db,owner:string,id:string){
 await project(db,owner,id);
 const rows=(await db.query(`SELECT m.* FROM bb_material_versions m WHERE m.owner_user_id=$1 AND m.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM bb_project_qa_runs q WHERE q.owner_user_id=m.owner_user_id AND q.manifest#>>'{source,asset,pin,material_id}'=m.id) AND m.project_id IN(SELECT members.id FROM bb_projects p CROSS JOIN LATERAL(${memberProjectsSql('p')}) members WHERE p.owner_user_id=$1 AND p.id=$2)
 ORDER BY m.persisted_at DESC,m.id LIMIT 300`,[owner,id])).rows;
 const materials:QaInput['materials']=rows.map(m=>({filename:m.filename,asset:{kind:'material',pin:{source_project_id:m.project_id,material_id:m.id,material_version:m.version,sha256:m.sha256.trim()}}}));
 const current=await projectFileSource(db,owner,id);
 if(current&&!materials.some(m=>inputManifestHash(m.asset)===inputManifestHash(current.asset)))materials.unshift({filename:current.filename,asset:current.asset});
 return materials;
}
export function validateQaQuestions(questions:QaQuestion[],result:QaResult){
 if(!questions.length||questions.length>200)throw new Problem(422,'INPUT_REQUIRED','请确认 1 至 200 个问题。');
 let last=-1;const ids=new Set<string>();
 for(const q of questions){
  const spans=result.snapshot.spans.slice(q.start,q.end+1),text=spans.map(s=>s.text).join('\n').trim();
  if(q.start<=last||q.end<q.start||q.end>=result.snapshot.spans.length||q.id!=='q'+q.start||ids.has(q.id)||!text||q.question!==text)throw new Problem(422,'VALIDATION_FAILED','问题与原文定位不一致，请重新核对问题范围。');
  last=q.end;ids.add(q.id);
 }
}
async function preparation(db:Db,owner:string,id:string,run:string|null){
 const row=(await db.query(`SELECT q.* FROM bb_project_qa_runs q JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id
 WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id=$3 AND q.operation='prepare' AND r.state='succeeded'`,[owner,id,run])).rows[0];
 if(!row?.result||inputManifestHash(row.result)!==row.result_hash?.trim())throw new Problem(422,'INPUT_REQUIRED','请先完成问题清单解析。');return row as {manifest:QaInput;result:QaResult};
}
async function validateDraft(db:Db,owner:string,id:string,d:QaDraft,starting=false){
 const p=await preparation(db,owner,id,d.preparation_id);if(d.questions.length||starting)validateQaQuestions(d.questions,p.result);
 const available=await qaMaterials(db,owner,id),keys=new Set(available.map(m=>inputManifestHash(m.asset))),used=new Set<string>();
 for(const asset of d.materials){const key=inputManifestHash(asset);if(!keys.has(key)||used.has(key)||key===inputManifestHash(p.manifest.source.asset))throw new Problem(422,'VALIDATION_FAILED','材料已变化，或问题清单被选为事实依据，请重新选择。');used.add(key);await readProjectFileAsset(db,owner,asset);}
 const prospectus=starting?await projectFileSource(db,owner,id):null;
 if(starting){const issue=qaProspectusIssue(prospectus,d.materials,p.manifest.source.asset);if(issue)throw new Problem(422,'INPUT_REQUIRED',issue);}
 return {p,prospectus,materials:d.materials.map(asset=>available.find(m=>inputManifestHash(m.asset)===inputManifestHash(asset))!)};
}
async function notify(c:PoolClient,owner:string,id:string,type:string,payload:unknown){
 await c.query('UPDATE bb_projects SET updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id]);
 await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)",[uid(),owner,id,type,payload]);
}
/** An explicit original-scope continuation cannot add questions or requirements. New evidence is allowed. */
export async function validateIncludedQaFollowup(db:Db,owner:string,projectId:string,parentId:string,questions:QaQuestion[],requirements:string,source:QaInput['source']){
 const parent=(await db.query(`SELECT q.manifest FROM bb_project_qa_runs q JOIN bb_runs run ON run.id=q.run_id AND run.owner_user_id=q.owner_user_id
 JOIN bb_credit_reservations res ON res.run_id=q.run_id AND res.owner_user_id=q.owner_user_id
 JOIN bb_project_qa_quotes price ON price.id=res.quote_id AND price.run_id=q.run_id AND price.owner_user_id=q.owner_user_id
 WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id=$3 AND q.operation='answer' AND run.state='succeeded'
 AND res.state='settled' AND res.charged_points=price.points AND price.price_version=$4 AND price.scope_quote_id IS NOT NULL AND price.points>0`,[owner,projectId,parentId,OUTCOME_PRICE_VERSION])).rows[0];
 if(!parent||parent.manifest.requirements!==requirements||inputManifestHash(parent.manifest.source.asset)!==inputManifestHash(source.asset)
 ||!questions.length||questions.some(q=>!parent.manifest.questions.some((old:QaQuestion)=>inputManifestHash(old)===inputManifestHash(q))))
   throw conflict('INPUT_REVISION_CONFLICT','原范围续做须引用本人同项目已付成功任务，保持原问题、原要求和问题清单；新增范围请单独报价。');
}
/** Price and quotation identity are deliberately excluded from the business-scope hash. */
export const qaAnswerScope=(input:Pick<QaInput,'source'|'preparation_id'|'questions'|'materials'|'requirements'>)=>({
 source:input.source,preparation_id:input.preparation_id,questions:input.questions,materials:input.materials,requirements:input.requirements,
});
export async function reserveQaCredits(c:PoolClient,owner:string,run:any,input:QaInput){
 await lockCreditAccount(c,owner);const points=input.points;
 const scope=input.price_version===OUTCOME_PRICE_VERSION&&!input.included_followup_of
  ?await assertScopeQuote(c,input.scope_quote_id,owner,run.project_id,'project_qa_answer',inputManifestHash(qaAnswerScope(input)),points):null;
 if((await creditBalance(c,owner)).available<points)throw new Problem(402,'CREDITS_INSUFFICIENT',input.price_version===OUTCOME_PRICE_VERSION?`本轮 ${input.questions.length} 个问题需要 ¥${(points/100).toFixed(2)}；问题与材料已保留。`:`本轮 ${input.questions.length} 个问题需要 ${points} 积分；问题与材料已保留。`);
 const quote=uid(),reservation=uid();
 await c.query('INSERT INTO bb_project_qa_quotes(id,owner_user_id,run_id,input_hash,question_count,unit_points,points,price_version,scope_quote_id,scope_lines,scope_work_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[quote,owner,run.id,run.input_hash,input.questions.length,input.price_version===OUTCOME_PRICE_VERSION?0:PROJECT_QA_PRICE.points,points,input.price_version,scope?.scope_quote_id??null,JSON.stringify(scope?.scope_lines??[]),scope?inputManifestHash(qaAnswerScope(input)):null]);
 if(input.included_followup_of&&points===0)return;
 await c.query("INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,$5,'on_delivery')",[reservation,owner,run.id,quote,points]);
 const lots=(await c.query("SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen AND (expires_at IS NULL OR expires_at>now()) ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE",[owner])).rows;
 let left=points;for(const lot of lots){const take=Math.min(left,Number(lot.remaining)-Number(lot.frozen));await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[lot.id,take]);await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[reservation,lot.id,take]);left-=take;if(!left)break;}
 if(left)throw new Problem(503,'DATA_UNAVAILABLE','Q&A credit allocation mismatch');
 await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,'project_qa_questions_confirmed')",[uid(),owner,'reserve:'+reservation,points,reservation,run.id]);
 await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run.id,reservation]);
}
async function existing(c:PoolClient,owner:string,key:string,hash:string){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner+':'+key]);const old=(await c.query('SELECT id,request_hash FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[owner,key])).rows[0];if(old&&old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','请求已用于其他问题清单。');return old?.id as string|undefined;}
async function createRun(c:PoolClient,owner:string,p:any,key:string,requestHash:string,manifest:QaInput){
 await assertCanonicalBusinessRunIdle(c,owner,p);
 if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
 if((await c.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND NOT(state=ANY($3::text[]))',[owner,p.id,terminal])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','本项目有任务正在执行，请完成后再开始。');
 const revision=Number((await c.query('SELECT coalesce(max(revision),0)+1 n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[owner,p.id])).rows[0].n),hash=inputManifestHash(manifest),runId=uid();
 await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,'[]','[]')",[p.id,revision,owner,p.draft_revision,hash,manifest]);
 const run=(await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,'generation',$7,'queued') RETURNING *",[runId,owner,p.id,revision,hash,key,requestHash])).rows[0];
 await c.query('INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) SELECT $1,$2,$3,coalesce(max(sequence),0)+1,$4,$5,$6 FROM bb_project_qa_runs WHERE project_id=$3',[runId,owner,p.id,manifest.operation,manifest,hash]);
 if(manifest.operation==='answer')await reserveQaCredits(c,owner,run,manifest);
 await c.query('UPDATE bb_projects SET latest_input_revision=$3 WHERE owner_user_id=$1 AND id=$2',[owner,p.id,revision]);
 await enqueue(c,run,'project_qa_v1');await notify(c,owner,p.id,'project.qa_started',{run_id:runId,operation:manifest.operation});return runId;
}
export async function readQa(db:Pool,owner:string,id:string,requested?:string,answerSequence=true,commercial=false):Promise<QaWorkspace>{
 const materials=await qaMaterials(db,owner,id),d=(await db.query('SELECT * FROM bb_project_qa_drafts WHERE owner_user_id=$1 AND project_id=$2',[owner,id])).rows[0];
 const rows=(await db.query(`WITH answers AS (
 SELECT run_id,row_number() OVER(ORDER BY sequence) AS answer_sequence FROM bb_project_qa_runs
 WHERE owner_user_id=$1 AND project_id=$2 AND operation='answer'
 ), selected AS (
 SELECT run_id FROM bb_project_qa_runs WHERE owner_user_id=$1 AND project_id=$2 ORDER BY sequence DESC LIMIT 100
 ), answer_history AS (
 SELECT run_id FROM answers ORDER BY answer_sequence DESC LIMIT 100
 ), included AS (
 SELECT run_id FROM selected UNION SELECT run_id FROM answer_history UNION SELECT $3::text UNION SELECT $4::text
 UNION SELECT manifest->>'preparation_id' FROM bb_project_qa_runs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3
 ) SELECT q.*,a.answer_sequence,r.state,r.stage,r.artifact_id,c.points,c.charged_points,c.state reservation_state,
 (SELECT j.error_code FROM bb_jobs j WHERE j.owner_user_id=q.owner_user_id AND j.run_id=q.run_id AND j.subtype='project_qa_v1' LIMIT 1) AS error_code FROM bb_project_qa_runs q
 JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id LEFT JOIN bb_credit_reservations c ON c.run_id=r.id
 LEFT JOIN answers a ON a.run_id=q.run_id
 WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id IN(SELECT run_id FROM included)
 ORDER BY (q.run_id=$3) DESC NULLS LAST,q.sequence DESC`,[owner,id,requested??null,d?.draft?.preparation_id??null])).rows;
 return {draft:d?.draft??empty(),revision:d?.revision??0,materials,prospectus:await projectFileSource(db,owner,id),price:commercial?{points:0,version:OUTCOME_PRICE_VERSION,...outcomeMetadata(0),quote_status:'pending_scope',scope_lines:[]}:PROJECT_QA_PRICE,runs:rows.map(r=>({run_id:r.run_id,sequence:r.sequence,...(answerSequence&&r.operation==='answer'?{answer_sequence:Number(r.answer_sequence)}:{}),operation:r.operation,state:r.state,stage:r.stage??null,error_code:r.error_code??null,created_at:date(r.created_at),manifest:r.manifest,...(r.manifest.pricing_mode==='outcome_cny_v1'?{...outcomeMetadata(r.manifest.points),scope_quote_id:r.manifest.scope_quote_id,quote_status:'ready' as const,scope_lines:r.manifest.scope_lines??[]}:{}),result:r.result??null,artifact_id:r.state==='succeeded'&&r.operation==='answer'?r.artifact_id:null,reserved_points:r.reservation_state==='held'?Number(r.points):0,charged_points:r.reservation_state==='settled'?Number(r.charged_points??r.points):0}))};
}
export function registerProjectQa(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,commercial=false){
 const base='/api/v1/projects/:project_id/qa',id=(r:FastifyRequest)=>(r.params as {project_id:string}).project_id;
 app.get(base,{schema:{querystring:qaSchemas.QaQuery,response:{200:qaSchemas.QaWorkspaceResponse}}},async r=>readQa(db(),await owner(r),id(r),(r.query as {run_id?:string}).run_id,r.headers[QA_HISTORY_CAPABILITY.header]===QA_HISTORY_CAPABILITY.value,commercial));
 app.post(base+'/prepare',{schema:{body:qaSchemas.QaPrepareRequest,response:{200:qaSchemas.QaRunResponse}}},async r=>{
  const user=await owner(r),pid=id(r),b=r.body as Static<typeof qaSchemas.QaPrepareRequest>;
  const run_id=await transaction(db(),async c=>{const p=await project(c,user,pid,true),hash=inputManifestHash({pid,...b}),key='qa-prepare:'+b.request_id,old=await existing(c,user,key,hash);if(old)return old;
   if(b.source.kind!=='material'||b.source.pin.source_project_id!==pid)throw new Problem(422,'VALIDATION_FAILED','请上传本项目的问题清单。');
   const source=await readProjectFileAsset(c,user,b.source);
   if(!['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword','application/pdf'].includes(source.media_type))throw new Problem(422,'VALIDATION_FAILED','请上传 DOCX、DOC 或 PDF 问题清单。');
   return createRun(c,user,p,key,hash,{version:'project-qa-v1',operation:'prepare',project_name:p.name,source:{filename:source.filename,asset:b.source},preparation_id:null,questions:[],materials:[],requirements:'',cases:[],price_version:PROJECT_QA_PRICE.version,points:0});
  });return {run_id};
 });
 app.post(base+'/draft',{schema:{body:qaSchemas.QaDraftRequest,response:{200:qaSchemas.QaWorkspaceResponse}}},async r=>{
  const user=await owner(r),pid=id(r),b=r.body as Static<typeof qaSchemas.QaDraftRequest>;
  await transaction(db(),async c=>{const p=await project(c,user,pid,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
   const old=(await c.query('SELECT revision FROM bb_project_qa_drafts WHERE owner_user_id=$1 AND project_id=$2',[user,pid])).rows[0];if((old?.revision??0)!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','问题清单已在其他页面修改，请刷新后核对。');
   await validateDraft(c,user,pid,b.draft);
   await c.query('INSERT INTO bb_project_qa_drafts(owner_user_id,project_id,revision,draft) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,draft=EXCLUDED.draft',[user,pid,b.expected_revision+1,b.draft]);await notify(c,user,pid,'project.qa_draft_saved',{revision:b.expected_revision+1});
  });return readQa(db(),user,pid,undefined,r.headers[QA_HISTORY_CAPABILITY.header]===QA_HISTORY_CAPABILITY.value,commercial);

 });
 app.post(base+'/quote',{schema:{body:qaSchemas.QaQuoteRequest,response:{200:qaSchemas.QaQuoteResponse}}},async r=>{
  const user=await owner(r),pid=id(r),b=r.body as Static<typeof qaSchemas.QaQuoteRequest>;
  return transaction(db(),async c=>{
   await project(c,user,pid,true);
   const row=(await c.query('SELECT * FROM bb_project_qa_drafts WHERE owner_user_id=$1 AND project_id=$2',[user,pid])).rows[0];
   if(!row||row.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','问题或材料已变化，请重新确认。');
   const d=row.draft as QaDraft,{p:prepared,materials}=await validateDraft(c,user,pid,d,true);
   if(b.included_followup_of){
    if(!commercial)throw conflict('QUOTE_CHANGED','请使用原任务服务入口核实续做范围。');
    await validateIncludedQaFollowup(c,user,pid,b.included_followup_of,d.questions,d.requirements,prepared.manifest.source);
    return {points:0,price_version:OUTCOME_PRICE_VERSION,...outcomeMetadata(0),quote_status:'ready',scope_lines:[]};
   }
   if(!commercial)return {points:d.questions.length*PROJECT_QA_PRICE.points,price_version:PROJECT_QA_PRICE.version};
   const snapshot=qaAnswerScope({source:prepared.manifest.source,preparation_id:d.preparation_id,questions:d.questions,materials,requirements:d.requirements});
   const scope=await requestScope(c,user,pid,'project_qa_answer',inputManifestHash(snapshot),snapshot);
   return {points:scope.amount_fen,price_version:scope.price_version,...scopePriceMetadata(scope)};
  });
 });
 app.post(base+'/runs',{schema:{body:qaSchemas.QaAnswerRequest,response:{200:qaSchemas.QaRunResponse}}},async r=>{
  const user=await owner(r),pid=id(r),b=r.body as Static<typeof qaSchemas.QaAnswerRequest>;
  const run_id=await transaction(db(),async c=>{const p=await project(c,user,pid,true),hash=inputManifestHash({pid,...b}),key='qa-answer:'+b.request_id,old=await existing(c,user,key,hash);if(old)return old;
   const row=(await c.query('SELECT * FROM bb_project_qa_drafts WHERE owner_user_id=$1 AND project_id=$2',[user,pid])).rows[0];if(!row||row.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','问题或材料已变化，请重新确认。');
   const d=row.draft as QaDraft,{p:prepared,materials,prospectus}=await validateDraft(c,user,pid,d,true);
   if(b.included_followup_of){if(!commercial)throw conflict('QUOTE_CHANGED','请使用原任务服务入口核实续做范围。');await validateIncludedQaFollowup(c,user,pid,b.included_followup_of,d.questions,d.requirements,prepared.manifest.source);}
   const snapshot=qaAnswerScope({source:prepared.manifest.source,preparation_id:d.preparation_id,questions:d.questions,materials,requirements:d.requirements});
   const scope=commercial&&!b.included_followup_of?await assertScopeQuote(c,b.scope_quote_id,user,pid,'project_qa_answer',inputManifestHash(snapshot),b.expected_points):null;
   const points=b.included_followup_of?0:commercial?scope!.amount_fen:d.questions.length*PROJECT_QA_PRICE.points;
   if(points!==b.expected_points||b.price_version!==(commercial?OUTCOME_PRICE_VERSION:PROJECT_QA_PRICE.version))throw conflict('QUOTE_CHANGED','实际处理范围与费用已变化，请重新确认。');
   const cases:QaInput['cases']=[];if(d.use_knowledge)for(const q of d.questions){for(const item of await qaCaseSearch(c,q.question,3))if(!cases.some(x=>x.id===item.id)&&cases.length<40)cases.push(item);}
   return createRun(c,user,p,key,hash,{...prepared.manifest,operation:'answer',prospectus:prospectus!,preparation_id:d.preparation_id,questions:d.questions,materials,requirements:d.requirements,cases,points,price_version:commercial?OUTCOME_PRICE_VERSION:PROJECT_QA_PRICE.version,...(scope?scopePriceMetadata(scope):commercial?{...outcomeMetadata(0),quote_status:'ready' as const,scope_lines:[]}:{}),...(b.included_followup_of?{included_followup_of:b.included_followup_of}:{})});
  });return {run_id};
 });
}
