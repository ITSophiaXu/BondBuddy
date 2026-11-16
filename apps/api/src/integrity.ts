import {isAutomaticPriceVersion} from '@bondbuddy/contracts';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {OUTCOME_PRICE_VERSION,commerceMetadata,INTEGRITY_PRICE,INTEGRITY_SUBJECT_LIMIT,INTEGRITY_COMMERCIAL_RULE,IntegrityScopeMeasurementSchema,integrityLockedScopeValid,integrityPricingScope,integrityScopeMeasurement,inferIntegrityRegion,INTEGRITY_SITES,isRetiredIntegritySite,integritySchemas,resolveIntegritySite,integritySourceAllowed,type IntegrityDraft,type IntegrityInput,type IntegrityWorkspace,type IntegrityRound,type IntegrityManual} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,Problem,date,digest,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {enqueue} from './queue.js';
import {creditBalanceExact,lockCreditAccount,reserveCreditLots} from './billing.js';
import {readProjectFileAsset} from './project-file-storage.js';
import {requestScope,assertScopeQuote,scopePriceMetadata,workScopeHash} from './scope-quotations.js';
import {bindCommerceScopeRun} from './commerce-coverage.js';
import {automaticBillingEnabled} from './automatic-billing-context.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {readBillingRequestRejection,recordBillingRequestRejection,billingRequestRejectedProblem,type BillingRequestRejection} from './billing-request-rejections.js';

const empty=():IntegrityDraft=>({subjects:[],site_ids:[],notes:''});
const terminal=['succeeded','failed','cancelled','rejected','test_completed'];
export function validateIntegrityDraft(d:IntegrityDraft,start=false){
 if(d.subjects.length>INTEGRITY_SUBJECT_LIMIT)throw new Problem(422,'VALIDATION_FAILED','每轮最多 5 个核查对象，请减少名单后保存。');
 if(start&&(!d.subjects.length||!d.site_ids.length))throw new Problem(422,'INPUT_REQUIRED','请添加核查对象并选择网站。');
 if(d.site_ids.some(id=>!INTEGRITY_SITES.some(s=>s.id===id)))throw new Problem(422,'VALIDATION_FAILED','网站范围已变化，请重新选择。');
 if(d.site_ids.some(isRetiredIntegritySite))throw new Problem(422,'VALIDATION_FAILED','所选范围包含已移除的网站，请刷新并保存当前网站范围。');
 const ids=new Set<string>(),names=new Set<string>();
 for(const s of d.subjects){
  if(!s.name.trim()||ids.has(s.id)||names.has(s.kind+':'+s.name.trim()+':'+s.identifier.trim()))throw new Problem(422,'VALIDATION_FAILED','请填写对象名称，并移除重复对象。');
  if(s.kind==='company'&&s.identifier&&!/^[0-9A-Z]{18}$/.test(s.identifier))throw new Problem(422,'VALIDATION_FAILED','统一社会信用代码应为 18 位大写字母或数字，也可暂不填写。');
  if(start&&!d.site_ids.some(id=>{const site=INTEGRITY_SITES.find(x=>x.id===id)!;return !(s.kind==='person'&&site.companyOnly)&&resolveIntegritySite(site,{...s,...inferIntegrityRegion(s)}).links.length>0;}))throw new Problem(422,'INPUT_REQUIRED','每个对象至少需要一个可查询的适用官网；请核对人员适用网站和企业注册地。');
  ids.add(s.id);names.add(s.kind+':'+s.name.trim()+':'+s.identifier.trim());
 }
}
async function event(c:PoolClient,owner:string,id:string,type:string,payload:unknown){
 await c.query('UPDATE bb_projects SET updated_at=now() WHERE id=$1 AND owner_user_id=$2',[id,owner]);
 await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)",[uid(),owner,id,type,payload]);
}
async function reserve(c:PoolClient,owner:string,run:any,manifest:IntegrityInput,scopeHash?:string){
 await lockCreditAccount(c,owner);
 const points=manifest.points;
 const balance=await creditBalanceExact(c,owner);
 if(balance.available<points)throw new Problem(402,'CREDITS_INSUFFICIENT',isAutomaticPriceVersion(manifest.price_version)?`本轮诚信核查需要 ${points.toLocaleString('zh-CN')} 积分，当前可用 ${balance.available.toLocaleString('zh-CN')} 积分，还差 ${(BigInt(points)-balance.available).toLocaleString('zh-CN')} 积分；名单已保留，补足后自动继续。`:manifest.pricing_mode?'服务余额不足，请补充本次已确认金额；名单已保留。':'每轮诚信核查需要 5,000 积分，请补充积分后开始；名单已保留。');
 const quote=uid(),reservation=uid();
 await c.query('INSERT INTO bb_integrity_quotes(id,owner_user_id,run_id,input_hash,points,price_version,scope_quote_id,scope_lines,scope_work_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[quote,owner,run.id,run.input_hash,points,manifest.price_version,manifest.scope_quote_id??null,JSON.stringify(manifest.scope_lines??[]),scopeHash??null]);
 await c.query("INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,$5,'on_delivery')",[reservation,owner,run.id,quote,points]);
 await reserveCreditLots(c,owner,reservation,BigInt(points));
 await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,'integrity_round_confirmed')",[uid(),owner,'reserve:'+reservation,points,reservation,run.id]);
 await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run.id,reservation]);
 if(manifest.scope_quote_id)await bindCommerceScopeRun(c,owner,manifest.scope_quote_id,run.id);
}
async function createRun(c:PoolClient,owner:string,p:any,key:string,requestHash:string,manifest:IntegrityInput,scopeHash?:string){
 if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
 if((await c.query("SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND bb_is_integrity_input(owner_user_id,project_id,input_revision) AND NOT(state=ANY($3::text[]))",[owner,p.id,terminal])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','本项目已有诚信核查任务正在执行，请完成或结束后再开始核查。');
 const revision=Number((await c.query('SELECT coalesce(max(revision),0)+1 n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[owner,p.id])).rows[0].n);
 const hash=inputManifestHash(manifest),runId=manifest.operation==='check'?manifest.round_id:uid();
 await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,'[]','[]')",[p.id,revision,owner,p.draft_revision,hash,manifest]);
 const run=(await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,'generation',$7,'queued') RETURNING *",[runId,owner,p.id,revision,hash,key,requestHash])).rows[0];
 await c.query('INSERT INTO bb_integrity_runs(run_id,owner_user_id,project_id,round_id,sequence,operation,manifest,input_hash) SELECT $1,$2,$3,$4,coalesce(max(sequence),0)+1,$5,$6,$7 FROM bb_integrity_runs WHERE project_id=$3',[runId,owner,p.id,manifest.round_id,manifest.operation,manifest,hash]);
 if(manifest.operation==='check')await reserve(c,owner,run,manifest,scopeHash);
 // Integrity has its own draft and run input; keep the authoring input/quote pointer unchanged.
 await enqueue(c,run,'integrity_v1');await event(c,owner,p.id,'integrity.started',{run_id:runId,round_id:manifest.round_id,operation:manifest.operation});return runId;
}
async function existing(c:PoolClient,owner:string,key:string,hash:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner+':'+key]);
 const old=(await c.query('SELECT id,request_hash FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[owner,key])).rows[0];
 if(old&&old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此请求已用于其他核查。');return old?.id as string|undefined;
}
async function ownedRound(c:Pool|PoolClient,owner:string,id:string,runId:string){
 await project(c,owner,id);
 const row=(await c.query('SELECT i.*,r.state FROM bb_integrity_runs i JOIN bb_runs r ON r.id=i.run_id AND r.owner_user_id=i.owner_user_id WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.run_id=$3 AND i.operation=\'check\'',[owner,id,runId])).rows[0];
 if(!row)throw new Problem(404,'NOT_FOUND','核查记录不存在。');return row;
}
export async function readIntegrity(db:Pool,owner:string,id:string,requested?:string,commercial=false):Promise<IntegrityWorkspace>{
 await project(db,owner,id);
 const draft=(await db.query('SELECT revision,draft FROM bb_integrity_drafts WHERE owner_user_id=$1 AND project_id=$2',[owner,id])).rows[0];
 const rows=(await db.query('SELECT i.*,r.state,r.stage,r.artifact_id,c.points,c.state reservation_state,c.charged_points FROM bb_integrity_runs i JOIN bb_runs r ON r.id=i.run_id AND r.owner_user_id=i.owner_user_id LEFT JOIN bb_credit_reservations c ON c.run_id=r.id WHERE i.owner_user_id=$1 AND i.project_id=$2 ORDER BY (i.run_id=$3) DESC NULLS LAST,i.sequence DESC LIMIT 50',[owner,id,requested??null])).rows;
 const evidence=(await db.query('SELECT * FROM bb_integrity_evidence WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at,id',[owner,id])).rows;
 const observations=(await db.query('SELECT run_id,record FROM bb_integrity_observations WHERE owner_user_id=$1 AND run_id=ANY($2::text[]) ORDER BY subject_id,site_id',[owner,rows.map(r=>r.run_id)])).rows;
 const artifacts=(await db.query('SELECT a.* FROM bb_integrity_artifacts a JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id WHERE a.owner_user_id=$1 AND r.project_id=$2 AND r.state=\'succeeded\'',[owner,id])).rows;
 const priceVersion=commercial&&automaticBillingEnabled(db)?await resolveAutomaticTaskPriceVersion(db,owner):OUTCOME_PRICE_VERSION;
 return {draft:draft?.draft??empty(),revision:draft?.revision??0,price:commercial?{points:0,version:priceVersion,...commerceMetadata(0),price_version:priceVersion,quote_status:'pending_scope'}:INTEGRITY_PRICE,rounds:rows.map(r=>({
  run_id:r.run_id,round_id:r.round_id,operation:r.operation,sequence:r.sequence,state:r.state,stage:r.stage??null,created_at:date(r.created_at),manifest:r.manifest,
  records:r.result?.records??observations.filter(x=>x.run_id===r.run_id).map(x=>x.record),
  evidence:evidence.filter(e=>e.round_id===r.round_id).map(e=>({...e.record,id:e.id,created_at:date(e.created_at)})),
  artifact_id:r.state==='succeeded'?r.artifact_id:null,artifacts:artifacts.filter(a=>a.run_id===r.run_id).map(a=>({kind:a.kind,artifact_id:a.artifact_id,artifact_version:a.artifact_version})),charged_points:r.reservation_state==='settled'?Number(r.charged_points??r.points):0,reserved_points:r.reservation_state==='held'?Number(r.points):0
 }))};
}
export function registerIntegrity(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs,commercial=false){
 const base='/api/v1/projects/:project_id/integrity',params=(r:FastifyRequest)=>r.params as {project_id:string;run_id:string};
 app.get(base,{schema:{querystring:integritySchemas.IntegrityQuery,response:{200:integritySchemas.IntegrityWorkspaceResponse}}},async r=>readIntegrity(db(),await owner(r),params(r).project_id,(r.query as {run_id?:string}).run_id,commercial));
 app.post(base+'/quote',{schema:{body:integritySchemas.IntegrityQuoteRequest,response:{200:integritySchemas.IntegrityQuoteResponse}}},async r=>{
  const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof integritySchemas.IntegrityQuoteRequest>;
  return transaction(db(),async c=>{
   await project(c,user,id);const draft=(await c.query('SELECT * FROM bb_integrity_drafts WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0];
   if(!draft||draft.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','请保存名单与网站范围后获取报价。');validateIntegrityDraft(draft.draft,true);
   if(!commercial)return {points:INTEGRITY_PRICE.points,price_version:INTEGRITY_PRICE.version};
   if(!b.round_id)throw new Problem(422,'INPUT_REQUIRED','请重新准备本次核查，取得独立的核查轮标识。');
   const snapshot=integrityPricingScope(draft.draft,b.round_id,integrityScopeMeasurement(draft.draft)),price=await requestScope(c,user,id,'integrity_round',workScopeHash(snapshot),snapshot);
   return{points:price.amount_fen,price_version:OUTCOME_PRICE_VERSION,...scopePriceMetadata(price)};
  });
 });
 app.get(base+'/runs/:run_id/captures/:capture_id',{schema:{params:integritySchemas.IntegrityCaptureParams}},async(r,reply)=>{
  const user=await owner(r),{project_id,run_id,capture_id}=r.params as Static<typeof integritySchemas.IntegrityCaptureParams>;
  await ownedRound(db(),user,project_id,run_id);
  const row=(await db().query('SELECT c.*,b.payload,b.sha256 FROM bb_integrity_browser_captures c JOIN bb_integrity_browser_batches b ON b.owner_user_id=c.owner_user_id AND b.run_id=c.run_id AND b.subject_id=c.subject_id AND b.site_id=c.site_id WHERE c.id=$1 AND c.owner_user_id=$2 AND c.run_id=$3',[capture_id,user,run_id])).rows[0];
  if(!row)throw new Problem(404,'NOT_FOUND','截图不存在。');
  if(inputManifestHash(row.payload)!==row.sha256.trim()||!row.payload.captures.some((c:any)=>c.metadata.id===capture_id&&inputManifestHash(c.metadata)===inputManifestHash(row.metadata)&&c.screenshot_key===row.screenshot_key))throw new Problem(409,'INPUT_REVISION_CONFLICT','截图记录校验失败。');
  const bytes=await blobs().getIfExistsBounded(row.screenshot_key,15000000);
  if(!bytes||bytes.length!==row.metadata.byte_size||digest(bytes)!==row.metadata.screenshot_sha256)throw new Problem(409,'INPUT_REVISION_CONFLICT','截图内容校验失败。');
  return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').type('image/png').send(bytes);
 });
 app.post(base+'/draft',{schema:{body:integritySchemas.IntegrityDraftRequest,response:{200:integritySchemas.IntegrityWorkspaceResponse}}},async r=>{
  const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof integritySchemas.IntegrityDraftRequest>;validateIntegrityDraft(b.draft);
  await transaction(db(),async c=>{const p=await project(c,user,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
   const old=(await c.query('SELECT revision FROM bb_integrity_drafts WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0];
   if((old?.revision??0)!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','名单已在其他页面修改，请刷新后核对。');
   await c.query('INSERT INTO bb_integrity_drafts(owner_user_id,project_id,revision,draft) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,draft=EXCLUDED.draft',[user,id,b.expected_revision+1,b.draft]);
   await event(c,user,id,'integrity.draft_saved',{revision:b.expected_revision+1});
  });return readIntegrity(db(),user,id,undefined,commercial);
 });
 app.post(base+'/runs',{schema:{body:integritySchemas.IntegrityRunRequest,response:{200:integritySchemas.IntegrityRunResponse}}},async r=>{
  const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof integritySchemas.IntegrityRunRequest>;
  const outcome=await transaction(db(),async c=>{const p=await project(c,user,id,true),hash=inputManifestHash({id,...b}),key='integrity:'+b.request_id,old=await existing(c,user,key,hash);if(old)return {runId:old};
   const identity={owner:user,kind:'integrity' as const,requestId:b.request_id,resourceId:id,hash},rejection=await readBillingRequestRejection(c,identity);if(rejection)return {rejection};
   const reject=async(reason_code:BillingRequestRejection['reason_code'],message:string)=>({rejection:await recordBillingRequestRejection(c,identity,{reason_code,message})});
   if(commercial&&!b.scope_quote_id)return reject('QUOTE_REQUIRED','本次核查需要重新确认独立核查轮及当前范围积分。');
   const draft=(await c.query('SELECT * FROM bb_integrity_drafts WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0];
   if(!draft||draft.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','请保存名单与网站范围后开始。');validateIntegrityDraft(draft.draft,true);
   if(b.round_id&&(await c.query('SELECT 1 FROM bb_runs WHERE id=$1',[b.round_id])).rowCount)throw conflict('IDEMPOTENCY_CONFLICT','此核查轮已开始，请查看原任务；新一轮需重新准备。');
   const quoted=commercial?(await c.query("SELECT snapshot,price_version FROM bb_scope_quotations WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND action='integrity_round'",[b.scope_quote_id,user,id])).rows[0]:undefined;
   if(commercial&&(!quoted||inputManifestHash(quoted.snapshot.draft)!==inputManifestHash(draft.draft)||quoted.snapshot.round_id&&quoted.snapshot.round_id!==b.round_id))return reject('QUOTE_CHANGED','名单或核查轮与原范围积分不一致，请重新确认。');
   const measurement=quoted?.snapshot.scope_measurement??integrityScopeMeasurement(draft.draft);
   if(!Value.Check(IntegrityScopeMeasurementSchema,measurement)||!integrityLockedScopeValid(draft.draft,measurement))return reject('QUOTE_CHANGED','锁定官网查询范围无法核实，请重新确认。');
   if(quoted?.price_version===INTEGRITY_COMMERCIAL_RULE.version&&(!b.round_id||quoted.snapshot.round_id!==b.round_id||!quoted.snapshot.scope_measurement))return reject('QUOTE_REQUIRED','新计价标准需要明确核查轮和锁定的官网查询范围。');
   const scope=quoted?.snapshot??integrityPricingScope(draft.draft,b.round_id,measurement);let price:Awaited<ReturnType<typeof assertScopeQuote>>|null=null;
   try{price=commercial?await assertScopeQuote(c,b.scope_quote_id,user,id,'integrity_round',workScopeHash(scope),b.expected_points):null;}
   catch(error){if(error instanceof Problem&&['QUOTE_REQUIRED','QUOTE_CHANGED'].includes(error.code))return reject(error.code as 'QUOTE_REQUIRED'|'QUOTE_CHANGED',error.message);throw error;}
   if(b.price_version!==(price?.price_version??INTEGRITY_PRICE.version)||!commercial&&b.expected_points!==INTEGRITY_PRICE.points)return reject('QUOTE_CHANGED','请核对本轮范围积分。');
   return {runId:await createRun(c,user,p,key,hash,{version:'integrity-round-v1',operation:'check',round_id:b.round_id??uid(),...((commercial?quoted?.snapshot.round_id:b.round_id)?{scope_round_id:b.round_id}:{}),scope_measurement:measurement,project_name:p.name,draft:draft.draft,points:price?.amount_fen??INTEGRITY_PRICE.points,...(price?scopePriceMetadata(price):{}),price_version:price?.price_version??INTEGRITY_PRICE.version,records:[],evidence_ids:[],collector:'official-browser-v1'},commercial?workScopeHash(scope):undefined)};
  });if(outcome.rejection)throw billingRequestRejectedProblem(outcome.rejection);return {run_id:outcome.runId};
 });
 app.post(base+'/runs/:run_id/evidence',{schema:{body:integritySchemas.IntegrityManualRequest,response:{200:integritySchemas.IntegrityWorkspaceResponse}}},async r=>{
  const user=await owner(r),{project_id:id,run_id}=params(r),b=r.body as IntegrityManual;
  await transaction(db(),async c=>{await project(c,user,id,true);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':integrity-evidence:'+b.request_id]);const round=await ownedRound(c,user,id,run_id),hash=inputManifestHash({id,run_id,...b});
   const old=(await c.query('SELECT request_hash FROM bb_integrity_evidence WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
   if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','证据请求已用于其他记录。');return;}
   const input=round.manifest as IntegrityInput,subject=input.draft.subjects.find(s=>s.id===b.subject_id),site=INTEGRITY_SITES.find(s=>s.id===b.site_id);
   if(!subject||!site||!input.draft.site_ids.includes(site.id)||subject.kind==='person'&&site.companyOnly)throw new Problem(422,'VALIDATION_FAILED','核查对象或网站不属于本轮。');
   if(!integritySourceAllowed(resolveIntegritySite(site,b.registration??subject),b.url)||!Number.isFinite(Date.parse(b.queried_at))||Date.parse(b.queried_at)>Date.now()+60000||!b.note.trim())throw new Problem(422,'VALIDATION_FAILED','请填写对应官网查询网址、查询时间及证据说明。');
   if(b.material.source_project_id!==id)throw new Problem(404,'NOT_FOUND','请将证据上传至本项目。');
   const material=await readProjectFileAsset(c as unknown as Pool,user,{kind:'material',pin:b.material});
   if(!['image/png','image/jpeg','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(material.media_type))throw new Problem(422,'VALIDATION_FAILED','证据应为 PNG、JPG、PDF 或 Word。');
   await c.query('INSERT INTO bb_integrity_evidence(id,owner_user_id,project_id,round_id,request_id,request_hash,record) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid(),user,id,run_id,b.request_id,hash,b]);
   await event(c,user,id,'integrity.evidence_added',{round_id:run_id,site_id:site.id,subject_id:subject.id});
  });return readIntegrity(db(),user,id,undefined,commercial);
 });
 app.post(base+'/runs/:run_id/exports',{schema:{body:integritySchemas.IntegrityExportRequest,response:{200:integritySchemas.IntegrityRunResponse}}},async r=>{
  const user=await owner(r),{project_id:id,run_id}=params(r),b=r.body as Static<typeof integritySchemas.IntegrityExportRequest>;
  const runId=await transaction(db(),async c=>{const p=await project(c,user,id,true),hash=inputManifestHash({id,run_id,...b}),key='integrity-export:'+b.request_id,old=await existing(c,user,key,hash);if(old)return old;
   const round=await ownedRound(c,user,id,run_id);
   if(!terminal.includes(round.state))throw conflict('INPUT_REVISION_CONFLICT','本轮尚未结束，请完成核查后导出。');
   if(!round.result){
    const observations=(await c.query('SELECT record,sha256 FROM bb_integrity_observations WHERE owner_user_id=$1 AND run_id=$2',[user,run_id])).rows;
    if(observations.some(o=>inputManifestHash(o.record)!==o.sha256.trim()))throw conflict('INPUT_REVISION_CONFLICT','查询记录校验失败。');
    const input=round.manifest as IntegrityInput;
    round.result={version:'integrity-records-v1',records:input.draft.subjects.flatMap(s=>input.draft.site_ids.map(siteId=>{
     const observed=observations.find(o=>o.record.subject_id===s.id&&o.record.site_id===siteId);if(observed)return observed.record;
     const site=resolveIntegritySite(INTEGRITY_SITES.find(x=>x.id===siteId)!,s);
     return {subject_id:s.id,site_id:siteId,site_name:site.name,urls:site.links.map(l=>l.url),query:'',status:s.kind==='person'&&site.companyOnly?'not_applicable':'query_failed',reason:'本轮结束前未取得本项查询记录，无需上传补充证据。',checked_at:new Date().toISOString(),sources:[],search_performed:false};
    }))};
    await c.query('UPDATE bb_integrity_runs SET result=$3,result_hash=$4 WHERE owner_user_id=$1 AND run_id=$2 AND result IS NULL',[user,run_id,round.result,inputManifestHash(round.result)]);
   }
   const evidence=(await c.query('SELECT id FROM bb_integrity_evidence WHERE owner_user_id=$1 AND round_id=$2 ORDER BY id',[user,run_id])).rows.map(x=>x.id);
   if(JSON.stringify(evidence)!==JSON.stringify([...b.expected_evidence_ids].sort()))throw conflict('INPUT_REVISION_CONFLICT','证据已变化，请刷新后导出。');
   return createRun(c,user,p,key,hash,{...round.manifest,operation:'export',round_id:run_id,points:0,...(round.manifest.pricing_mode?commerceMetadata(0):{}),records:round.result.records,evidence_ids:evidence});
  });return {run_id:runId};
 });
}

