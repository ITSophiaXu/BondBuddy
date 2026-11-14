import {workpaperChapters,workpaperAdmissionOrder,WORKPAPER_MAX_PARALLEL} from '@bondbuddy/contracts';
import {int64,serializeInt64,shortageInt64,encodeBillingDto,type BillingWireDto} from '@bondbuddy/contracts';
import {registerGenerationProgress} from './generation-progress.js';
import {workpaperPreview} from './workpaper-preview.js';
import {contentDisposition} from './material-download.js';
import {loadWorkpaperTemplate} from './workpaper-templates.js';
import {registerWorkpaperLibrary} from './workpaper-library.js';
import type {Pool,PoolClient} from 'pg';
import type {Lease} from './queue.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {WorkpaperZipCache} from './workpaper-zip.js';
import {readWorkpaperZipFiles} from './workpaper-zip-files.js';
import {WorkpaperImportSchema,WorkpaperPreviewSchema,WorkpaperStartSchema,WorkpaperActionSchema,WorkpaperDecisionSchema,WORKPAPER_LIMITS,WORKPAPER_PRICE,workpaperDownloadFilename,workpaperZipPath,workpaperProgressiveSelection,
  type WorkpaperDecision,type WorkpaperCatalogue,type WorkpaperWorkspace,type WorkpaperBatch,type WorkpaperEntry,type M4DocumentManifest,type Market,type Offering} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,missing,Problem,date,digest,assertCanonicalBusinessRunIdle,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {readM4MaterialPin,startPinnedM4Run} from './m4-workspace.js';
import {quoteM4} from './m4-billing.js';
import {creditBalanceExact} from './billing.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {loadAutomaticTaskTariff} from './automatic-tariff-repository.js';
import {projectFileSource,readProjectFileAsset,workpaperFileVersions} from './project-file-storage.js';
import {importProspectusMaterial} from './prospectus-import.js';
import {loadWorkpaperKnowledge} from './m4-knowledge.js';
import {registerWorkpaperAssessments,readWorkpaperAssessments} from './workpaper-assessments.js';
import {workpaperDocx,explanationParagraphs} from './workpaper-docx.js';
export {workpaperDocx} from './workpaper-docx.js';
export {loadWorkpaperTemplate} from './workpaper-templates.js';
import {parseWorkpaperXlsx,previewWorkpaperXlsx} from './workpaper-catalogue.js';
type Db=Pool|PoolClient;
const terminal=['succeeded','failed','cancelled','rejected','test_completed'];
const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const catalogueDto=(r:any):WorkpaperCatalogue=>({catalogue_id:r.id,sha256:r.sha256.trim(),filename:r.filename,entries:r.entries,warnings:r.warnings,created_at:date(r.created_at)});
export async function makeWorkpaperExplanation(entry:WorkpaperEntry,decision:WorkpaperDecision){
 return workpaperDocx(entry.path.split('/').at(-1)!.replace(/\.docx$/i,'')+' — 不适用说明',explanationParagraphs(entry,decision),loadWorkpaperTemplate({code:entry.code,title:'不适用说明'}));
}
export type WorkpaperExplanationFile={key:string;sha256:string;filename:string};
/** Host-only publication of a durable authoring result; no public classification setter. */
export async function publishWorkpaperItemResult(db:Db,owner:string,runId:string,decision:WorkpaperDecision,explanation:WorkpaperExplanationFile|null){
 if(!Value.Check(WorkpaperDecisionSchema,decision)||(decision.status==='generate')!==(explanation===null))throw Error('WORKPAPER_RESULT_INVALID');
 const item=(await db.query('SELECT manifest FROM bb_workpaper_items WHERE owner_user_id=$1 AND run_id=$2 AND item_id=$3',[owner,runId,decision.item_id])).rows[0];
 if(item?.manifest.input.workpaper.mode!=='direct')throw Error('INPUT_REVISION_CONFLICT');
 if(explanation)explanation={key:explanation.key,sha256:explanation.sha256,filename:item.manifest.input.workpaper.entry.path.split('/').at(-1).replace(/\.docx$/i,'-不适用说明.docx')};
 const hash=inputManifestHash({decision,explanation});
 await db.query(`INSERT INTO bb_workpaper_item_results(run_id,owner_user_id,batch_id,item_id,decision,explanation,result_hash)
  SELECT i.run_id,i.owner_user_id,i.batch_id,i.item_id,$3,$4,$5 FROM bb_workpaper_items i
  WHERE i.owner_user_id=$1 AND i.run_id=$2 AND i.item_id=$6 ON CONFLICT(run_id) DO NOTHING`,[owner,runId,decision,explanation,hash,decision.item_id]);
 const old=(await db.query('SELECT result_hash FROM bb_workpaper_item_results WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows[0];
 if(old?.result_hash.trim()!==hash)throw Error('INPUT_REVISION_CONFLICT');
 if(explanation)await db.query('UPDATE bb_jobs SET credit_pause_requested=false WHERE owner_user_id=$1 AND run_id=$2',[owner,runId]);
}
async function event(c:PoolClient,owner:string,id:string,name:string,payload:unknown){
  await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)",[uid(),owner,id,name,payload]);
  await c.query('UPDATE bb_projects SET updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id]);
}
export async function pauseSharedWorkpaperBatch(pool:Pool,owner:string,batch:string,scope?:{itemId:string;runId:string;jobId:string;leaseToken?:string}){
  return transaction(pool,async c=>{
    const changed=(await c.query(`UPDATE bb_workpaper_batches SET state='paused',revision=revision+1,
      error='本批共享材料或编制计划尚未完成，请核对失败原因后继续。',pause_reason='shared_blocked',updated_at=now()
      WHERE owner_user_id=$1 AND id=$2 AND state IN ('queued','running') AND ($3::text IS NULL OR EXISTS(
        SELECT 1 FROM bb_workpaper_items i JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
        JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
        WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3 AND i.run_id=$4 AND j.id=$5
        AND (($6::text IS NOT NULL AND j.state='running' AND r.state='running' AND j.lease_token::text=$6 AND j.lease_until>now())
          OR ($6::text IS NULL AND j.state='failed' AND r.state='failed' AND j.lease_token IS NULL AND j.lease_until IS NULL)))) RETURNING project_id`,[owner,batch,scope?.itemId??null,scope?.runId??null,scope?.jobId??null,scope?.leaseToken??null])).rows[0];
    if(changed)await event(c,owner,changed.project_id,'workpaper.batch_paused',{batch_id:batch,reason:'shared_plan_incomplete'});
  });
}
/** Caller holds the batch lock. A shared preparation failure blocks siblings;
 * a later rendering failure with an accepted plan remains an independent file. */
async function pauseFailedSharedItem(c:PoolClient,b:any,item:any):Promise<boolean>{
  if(b.progressive_plan||item.run_state!=='failed'||item.manifest?.input?.workpaper?.execution!=='shared_batch_v1'||item.manifest.input.template)return false;
  if((await c.query('SELECT 1 FROM bb_workpaper_shared_plans WHERE owner_user_id=$1 AND batch_id=$2',[b.owner_user_id,b.id])).rowCount)return false;
  const error='本批共享材料或编制计划尚未完成，请核对失败原因后继续。';
  // Consume this failure before pausing so an explicit resume can advance once.
  await c.query("UPDATE bb_workpaper_items SET state='failed',error=$3 WHERE batch_id=$1 AND item_id=$2",[b.id,item.item_id,error]);
  await c.query("UPDATE bb_workpaper_batches SET state='paused',revision=revision+1,error=$2,pause_reason=NULL,updated_at=now() WHERE id=$1",[b.id,error]);
  // Do not acquire a project update lock after the scheduler's batch lock: public
  // actions lock project -> batch. The batch timestamp and outbox change atomically.
  await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'workpaper.batch_paused',$4)",
    [uid(),b.owner_user_id,b.project_id,{batch_id:b.id,reason:'shared_plan_incomplete'}]);
  return true;
}
/** A journal-settled failure clears the lease and returns `stopped`. Only that
 * exact current claim may eagerly reconcile the batch; scheduler also guards it. */
export async function pauseFailedSharedWorkpaperBatch(pool:Pool,lease:Lease,batch:string){
  return transaction(pool,async c=>{
    const b=(await c.query("SELECT * FROM bb_workpaper_batches WHERE owner_user_id=$1 AND id=$2 AND state IN ('queued','running') FOR UPDATE",[lease.owner,batch])).rows[0];
    if(!b)return false;
    const item=(await c.query(`SELECT i.*,r.state run_state FROM bb_workpaper_items i
      JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
      JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
      WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.run_id=$3 AND i.state='running'
        AND j.id=$4 AND j.attempts=$5 AND j.state='failed' AND r.state='failed'
        AND j.lease_token IS NULL AND j.lease_until IS NULL`,
      [lease.owner,batch,lease.runId,lease.jobId,lease.attempts])).rows[0];
    return item?pauseFailedSharedItem(c,b,item):false;
  });
}
async function ownedBatch(db:Db,owner:string,id:string,batch:string,lock=false){
  await project(db,owner,id);const row=(await db.query(`SELECT * FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 ${lock?'FOR UPDATE':''}`,[owner,id,batch])).rows[0];
  if(!row)throw missing();return row;
}
export async function readWorkpaperBatch(db:Db,owner:string,id:string,batch:string,versionSummaries?:Map<string,NonNullable<WorkpaperBatch['items'][number]['file']>>):Promise<BillingWireDto<WorkpaperBatch,'workpaperBatch'>>{
  const b=await ownedBatch(db,owner,id,batch);
  const items=(await db.query(`SELECT i.item_id,i.run_id,i.state,i.attempt,i.error,
    i.manifest->'input'->'workpaper'->'entry' AS entry,i.manifest->'input'->'workpaper'->'decision' AS input_decision,
    coalesce(i.manifest->'input'->'template'<>'null'::jsonb,false) AS has_template,
    r.state run_state,r.stage,w.decision AS output_decision,coalesce(i.explanation,w.explanation) AS delivered_explanation FROM bb_workpaper_items i LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
    LEFT JOIN bb_workpaper_item_results w ON w.owner_user_id=i.owner_user_id AND w.run_id=i.run_id AND r.state='succeeded'
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 ORDER BY i.ordinal`,[owner,batch])).rows;
  const artifacts=(await db.query(`SELECT a.*,v.sha256,r.project_id FROM bb_workpaper_items i JOIN bb_runs r ON r.id=i.run_id AND r.owner_user_id=i.owner_user_id AND r.state='succeeded'
    JOIN bb_m4_artifacts a ON a.owner_user_id=i.owner_user_id AND a.run_id=r.id JOIN bb_artifact_versions v ON v.owner_user_id=a.owner_user_id AND v.id=a.artifact_id AND v.version=a.artifact_version
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND a.kind='document' AND v.delivery_status='available' AND v.quality_status='passed'`,[owner,batch])).rows;
  const charged=(await db.query(`SELECT coalesce(sum(CASE WHEN c.state='released' THEN 0 ELSE coalesce(c.charged_points,CASE WHEN c.state='settled' THEN c.points ELSE 0 END) END),0) amount
    FROM bb_workpaper_attempts a JOIN bb_credit_reservations c ON c.owner_user_id=a.owner_user_id AND c.run_id=a.run_id WHERE a.owner_user_id=$1 AND a.batch_id=$2`,[owner,batch])).rows[0];
  const remaining=items.filter(i=>i.state==='queued').length;
  const required=b.state==='paused'&&b.pause_reason==='credits_insufficient'&&isAutomaticPriceVersion(b.price_version)&&remaining?(b.progressive_plan?1:remaining)*(await loadAutomaticTaskTariff(db,b.price_version)).workpaper.points:0;
  const balance=required?await creditBalanceExact(db,owner):null;
  const files=versionSummaries??await workpaperFileVersions(db,owner,id,false);
  return {batch_id:b.id,topic_id:b.topic_id,catalogue_id:b.catalogue_id,state:b.state,revision:b.revision,source:b.source,total_points:serializeInt64(b.total_points),charged_points:serializeInt64(charged.amount),created_at:date(b.created_at),error:b.error,start_mode:b.start_mode,
    ...(b.progressive_plan?{progressive:{...b.progressive_plan,phase:b.progressive_phase},pause_reason:b.pause_reason}:{}),
    ...(items.length?{template_mode:items.every(i=>i.has_template)?'selected' as const:items.every(i=>!i.has_template)?'automatic' as const:'mixed' as const}:{}),
    ...(balance?{billing_resume:{price_version:b.price_version,required_points:serializeInt64(required),available_points:serializeInt64(balance.available),shortage:serializeInt64(shortageInt64(required,balance.available))}}:{}),
    items:items.map(i=>{const file=files.get(batch+':'+i.item_id),current=file?.current;return {entry:i.entry,decision:i.output_decision??i.input_decision??undefined,...(i.delivered_explanation?{explanation:{filename:workpaperDownloadFilename(i.entry,{explanation:true}),sha256:i.delivered_explanation.sha256}}:{}),...(file?{file}:{}),run_id:i.run_id,state:i.run_state??(i.state==='succeeded'?'succeeded':b.state==='cancelled'?'cancelled':i.state),stage:i.stage??null,attempt:i.attempt,error:i.error,
      artifacts:current?.asset.kind==='artifact'?[{kind:'document' as const,filename:workpaperDownloadFilename(i.entry),pin:current.asset.pin}]:artifacts.filter(a=>a.run_id===i.run_id&&!i.delivered_explanation).map(a=>({kind:a.kind,filename:workpaperDownloadFilename(i.entry),pin:{source_project_id:a.project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256.trim()}}))};})};
}
export async function readWorkpapers(db:Db,owner:string,id:string):Promise<BillingWireDto<WorkpaperWorkspace,'workpaperWorkspace'>>{
  await project(db,owner,id);
  const cats=(await db.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 10',[owner,id])).rows;
  const batches=(await db.query('SELECT id FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 10',[owner,id])).rows;
  const version=automaticBillingEnabled(db)?await resolveAutomaticTaskPriceVersion(db,owner):null;
  const files=batches.length?await workpaperFileVersions(db,owner,id,false):new Map();
  return encodeBillingDto('workpaperWorkspace',{price:version?{version,points:(await loadAutomaticTaskTariff(db,version)).workpaper.points,auto_charge:true}:WORKPAPER_PRICE,assessments:await readWorkpaperAssessments(db,owner,id),catalogues:cats.map(catalogueDto),batches:await Promise.all(batches.map(b=>readWorkpaperBatch(db,owner,id,b.id,files)))});
}

const independentWorkpaperFailures=new Set(['MODEL_OUTPUT_SCHEMA_INVALID','VALIDATION_FAILED','WORD_QUALITY_REJECTED','WORD_DELIVERY_UNAVAILABLE']);
/** Locks the canonical project and admits only a second, different immutable item.
 * The database trigger repeats this check at insertion and every state transition. */
async function assertProgressiveWorkpaperAdmission(c:PoolClient,b:any,item:any,m:M4DocumentManifest){
  const scope=m.execution_scope_project_id;
  if(!(await c.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL AND archived_at IS NULL FOR NO KEY UPDATE NOWAIT',[b.owner_user_id,scope])).rowCount)
    throw conflict('INPUT_REVISION_CONFLICT','项目或来源已不可用。');
  const frozen=(await c.query(`SELECT 1 FROM bb_workpaper_items i JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3 AND i.manifest=$4 AND i.run_id IS NULL AND i.state='queued'`,[b.owner_user_id,b.id,item.item_id,m])).rowCount;
  if(!frozen)throw conflict('INPUT_REVISION_CONFLICT','底稿输入已变化。');
  const active=(await c.query(`SELECT r.id,bb_batch_child_identity(r.owner_user_id,r.project_id,r.input_revision,r.id,r.execution_request_id) AS membership
    FROM bb_runs r JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    WHERE r.owner_user_id=$1 AND COALESCE(p.execution_scope_project_id,p.id)=$2 AND r.task_kind<>'qa'
    AND NOT(r.state=ANY($3::text[])) AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision)`,[b.owner_user_id,scope,terminal])).rows;
  if(active.length>=(b.progressive_plan?.max_parallel??b.max_parallel??1)||active.some(r=>r.membership?.[0]!=='workpaper:'+b.id||r.membership?.[1]===item.item_id))
    throw conflict('PROJECT_RUN_ACTIVE','同一来源项目已有业务任务执行中，请等待当前文件完成。');
}

/** A batch is an ordered queue of independent, immutable M4 runs. A failed file does not discard siblings. */
export async function advanceWorkpaperBatch(pool:Pool):Promise<boolean>{
  return transaction(pool,async c=>{
    const b=(await c.query(`SELECT b.* FROM bb_workpaper_batches b JOIN bb_projects p ON p.id=b.project_id AND p.owner_user_id=b.owner_user_id
      WHERE (b.state IN ('queued','running') OR b.progressive_plan IS NOT NULL AND b.state IN ('paused','cancelled') AND EXISTS(
        SELECT 1 FROM bb_workpaper_items i JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
        WHERE i.batch_id=b.id AND i.state='running' AND r.state IN ('succeeded','failed','cancelled','rejected','test_completed')))
      AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1`)).rows[0];
    if(!b)return false;
    await c.query('UPDATE bb_workpaper_batches SET updated_at=now() WHERE id=$1',[b.id]);
    const running=(await c.query(`SELECT i.*,r.state run_state,r.stage run_stage,coalesce((SELECT e.payload->>'error_code' FROM bb_run_events e
      WHERE e.owner_user_id=r.owner_user_id AND e.run_id=r.id AND e.seq=r.event_cursor AND e.state=r.state),j.error_code) AS failure_code
      FROM bb_workpaper_items i LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
      LEFT JOIN bb_jobs j ON j.owner_user_id=i.owner_user_id AND j.run_id=i.run_id
      WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.state='running'`,[b.owner_user_id,b.id])).rows;
    let active=0,blocked=false;
    for(const item of running){
      if(!terminal.includes(item.run_state)){active++;if(['paused','awaiting_input'].includes(item.run_state))blocked=true;continue;}
      // A legacy shared failure can settle before its worker returns. Consume it
      // under this lock before quoting a sibling; progressive plans are per item.
      if(!b.progressive_plan&&await pauseFailedSharedItem(c,b,item))return true;
      const sharedFailure=(b.progressive_plan||b.max_parallel)&&['failed','rejected'].includes(item.run_state)&&!independentWorkpaperFailures.has(item.failure_code);
      await c.query('UPDATE bb_workpaper_items SET state=$3,error=$4 WHERE batch_id=$1 AND item_id=$2',[b.id,item.item_id,item.run_state==='succeeded'?'succeeded':'failed',item.run_state==='succeeded'?null:sharedFailure?'该文件因共享材料、模型服务或结算问题未完成；条件恢复后可重试受阻文件并继续。':'该文件未完成，其他底稿继续处理；可在本批结束后重试。']);
      if(sharedFailure)blocked=true;
    }
    // Pausing/stopping only prevents new admission; accepted runs may still publish.
    if(['paused','cancelled'].includes(b.state)){
      await c.query('UPDATE bb_workpaper_batches SET revision=revision+1 WHERE id=$1',[b.id]);return true;
    }
    if(blocked){
      await c.query("UPDATE bb_workpaper_batches SET state='paused',error='当前底稿任务遇到共享材料、模型服务或结算问题，请先处理该任务，再继续文件包。',pause_reason='shared_blocked',revision=revision+1 WHERE id=$1",[b.id]);return true;
    }
    if(active>=(b.progressive_plan?.max_parallel??b.max_parallel??1))return false;
    const eligible=b.progressive_phase==='trial'?b.progressive_plan.trial_item_ids:b.progressive_phase==='retry_failed'?b.progressive_retry_items:null;
    const queued=(await c.query("SELECT * FROM bb_workpaper_items WHERE batch_id=$1 AND state='queued' AND ($2::jsonb IS NULL OR $2::jsonb ? item_id) ORDER BY ordinal",[b.id,eligible?JSON.stringify(eligible):null])).rows;
    const grouped=queued.some(i=>i.manifest.input.workpaper?.execution==='grouped_batch_v1');
    const plan=b.progressive_plan?{...b.progressive_plan,phase:b.progressive_phase}:grouped?{phase:'remaining' as const,chapters:workpaperChapters((await c.query('SELECT manifest FROM bb_workpaper_items WHERE batch_id=$1 ORDER BY ordinal',[b.id])).rows.map(i=>i.manifest.input.workpaper.entry)),trial_item_ids:[],max_parallel:4 as const}:undefined;
    const nextId=workpaperAdmissionOrder(queued.map(i=>i.item_id),plan)[0];
    const next=queued.find(i=>i.item_id===nextId);
    if(!next){
      if(active)return false;
      const unfinished=Number((await c.query("SELECT count(*) n FROM bb_workpaper_items WHERE batch_id=$1 AND state='queued'",[b.id])).rows[0].n);
      if(b.progressive_phase==='retry_failed'&&unfinished){
        const pendingTrial=b.progressive_retry_return_phase==='awaiting_confirmation'&&(await c.query("SELECT 1 FROM bb_workpaper_items WHERE batch_id=$1 AND state='queued' AND $2::jsonb ? item_id LIMIT 1",[b.id,JSON.stringify(b.progressive_plan.trial_item_ids)])).rowCount;
        // A shared failure may interrupt the trial or remainder before every file
        // was admitted. Finish that original phase after the explicit retry.
        if(pendingTrial||b.progressive_retry_return_phase==='remaining'){
          await c.query("UPDATE bb_workpaper_batches SET state='queued',progressive_phase=$2,progressive_retry_items=NULL,progressive_retry_return_phase=NULL,revision=revision+1,error=NULL,pause_reason=NULL WHERE id=$1",[b.id,pendingTrial?'trial':'remaining']);return true;
        }
      }
      if(b.progressive_plan&&unfinished&&(b.progressive_phase==='trial'||b.progressive_phase==='retry_failed'&&b.progressive_retry_return_phase==='awaiting_confirmation')){
        await c.query("UPDATE bb_workpaper_batches SET state='paused',progressive_phase='awaiting_confirmation',progressive_retry_items=NULL,progressive_retry_return_phase=NULL,revision=revision+1,error=NULL,pause_reason=NULL WHERE id=$1",[b.id]);
        await event(c,b.owner_user_id,b.project_id,'workpaper.trial_ready',{batch_id:b.id});return true;
      }
      if(b.progressive_phase==='retry_failed'&&unfinished){
        await c.query("UPDATE bb_workpaper_batches SET state='cancelled',revision=revision+1,error=NULL,progressive_retry_items=NULL,progressive_retry_return_phase=NULL WHERE id=$1",[b.id]);return true;
      }
      await c.query("UPDATE bb_workpaper_batches SET state=CASE WHEN EXISTS(SELECT 1 FROM bb_workpaper_items WHERE batch_id=$1 AND state='failed') THEN 'partial' ELSE 'complete' END,revision=revision+1,error=NULL WHERE id=$1",[b.id]);return true;
    }
    await c.query('SAVEPOINT workpaper_start');
    try{
      const m=next.manifest as M4DocumentManifest;
      const ids=[...new Set([b.project_id,m.execution_scope_project_id,m.input.source_material!.source_project_id])].sort();
      const locked=(await c.query('SELECT * FROM bb_projects WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id FOR NO KEY UPDATE NOWAIT',[b.owner_user_id,ids])).rows;
      if(locked.length!==ids.length)throw conflict('INPUT_REVISION_CONFLICT','项目或来源已不可用。');
      if(b.max_parallel||b.progressive_plan)await assertProgressiveWorkpaperAdmission(c,b,next,m);
      else await assertCanonicalBusinessRunIdle(c,b.owner_user_id,locked.find(p=>p.id===b.project_id));
      for(const pin of [m.input.source_material!,...m.input.materials])await readM4MaterialPin(c,b.owner_user_id,pin);
      const topic=(await c.query('SELECT * FROM bb_m4_topics WHERE owner_user_id=$1 AND id=$2',[b.owner_user_id,b.topic_id])).rows[0];if(!topic)throw missing();
      const auto=isAutomaticPriceVersion(b.price_version);
      const quote=await withAutomaticBilling(c,auto,()=>quoteM4(c,b.owner_user_id,topic.id,m.billing_task,inputManifestHash(m),m,auto),auto?b.price_version:undefined);
      if(quote.quote.points!==(auto?(await loadAutomaticTaskTariff(c,b.price_version)).workpaper.points:WORKPAPER_PRICE.points)||quote.quote.price_version!==b.price_version)throw conflict('QUOTE_CHANGED','文件生成费用已变化，请重新核对。');
      const run=await startPinnedM4Run(c,b.owner_user_id,topic,`workpaper:${b.id}:${next.item_id}:${next.attempt}`,inputManifestHash({batch:b.id,item:next.item_id,attempt:next.attempt}),m,quote.quote.quote_id,inputManifestHash(m),true);
      await c.query("UPDATE bb_workpaper_items SET run_id=$3,state='running',error=NULL WHERE batch_id=$1 AND item_id=$2",[b.id,next.item_id,run.id]);
      await c.query('INSERT INTO bb_workpaper_attempts(owner_user_id,batch_id,item_id,attempt,run_id) VALUES($1,$2,$3,$4,$5)',[b.owner_user_id,b.id,next.item_id,next.attempt,run.id]);
      await c.query("UPDATE bb_workpaper_batches SET state='running',revision=revision+1,error=NULL WHERE id=$1",[b.id]);
      await event(c,b.owner_user_id,b.project_id,'workpaper.item_started',{batch_id:b.id,item_id:next.item_id,run_id:run.id});return true;
    }catch(error){
      await c.query('ROLLBACK TO SAVEPOINT workpaper_start');
      if(error instanceof Problem&&error.code==='PROJECT_RUN_ACTIVE'||['55P03','40P01'].includes((error as {code?:string}).code??''))return false;
      await c.query("UPDATE bb_workpaper_batches SET state='paused',revision=revision+1,error=$2,pause_reason=$3 WHERE id=$1",[b.id,error instanceof Problem?error.message:'底稿任务暂未启动，请刷新后继续。',error instanceof Problem&&error.code==='CREDITS_INSUFFICIENT'?'credits_insufficient':null]);return true;
    }
  });
}

export async function createWorkpaperBatch(c:PoolClient,blobs:()=>PrivateBlobs,user:string,id:string,b:Static<typeof WorkpaperStartSchema>,templateInputs?:{templates:Record<string,{template:import('@bondbuddy/contracts').M4TemplateRef;material:import('@bondbuddy/contracts').M4MaterialPin}>;materials:import('@bondbuddy/contracts').M4MaterialPin[]},additionalMaterials:import('@bondbuddy/contracts').M4MaterialPin[]=[]){
 const hash=inputManifestHash({project_id:id,...b,...(templateInputs?{templateInputs}:{}),...(additionalMaterials.length?{additionalMaterials}:{})});
      const p=await project(c,user,id,true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':workpaper-batch:'+b.request_id]);
      const prior=(await c.query('SELECT * FROM bb_workpaper_batches WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(prior){if(prior.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此请求已用于其他底稿文件包。');return prior.id;}
      if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
      const cat=(await c.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,b.catalogue_id])).rows[0];
      if(!cat)throw missing();if(cat.sha256.trim()!==b.catalogue_sha256)throw conflict('INPUT_REVISION_CONFLICT','目录已变化，请重新核对。');
      let selected=(cat.entries as WorkpaperEntry[]).filter(e=>b.item_ids.includes(e.id)&&e.kind==='file');
      if(selected.length!==b.item_ids.length)throw new Problem(422,'VALIDATION_FAILED','文件选择中包含目录或无效行。');
      let progressive:ReturnType<typeof workpaperProgressiveSelection>|undefined;
      if(b.progressive){
        try{progressive=workpaperProgressiveSelection(cat.entries,b.item_ids,b.progressive.chapter_order);}
        catch{throw new Problem(422,'VALIDATION_FAILED','章节选择或顺序与当前目录不一致，请刷新后重新选择。');}
        const byId=new Map(selected.map(e=>[e.id,e]));selected=progressive.ordered_item_ids.map(item=>byId.get(item)!);
      }
      const direct=b.start_mode==='direct';let decisions:WorkpaperDecision[]=[];
      if(!direct){
      const assessment=(await c.query("SELECT a.* FROM bb_workpaper_assessments a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.state='succeeded' WHERE a.owner_user_id=$1 AND a.project_id=$2 AND a.run_id=$3",[user,id,b.assessment_id])).rows[0];
      if(!assessment?.result||assessment.result_hash.trim()!==b.assessment_hash||inputManifestHash(assessment.result)!==b.assessment_hash)throw conflict('INPUT_REVISION_CONFLICT','请先完成判断并确认全部不生成项。');
      const {request_id:_request,...assessed}=assessment.manifest.request;
      const {request_id:_start,start_mode:_mode,assessment_id:_id,assessment_hash:_hash,expected_points:_points,price_version:_price,progressive:_progressive,...requested}=b;
      if(inputManifestHash({...assessed,item_ids:[...assessed.item_ids].sort()})!==inputManifestHash({...requested,item_ids:[...requested.item_ids].sort()}))throw conflict('INPUT_REVISION_CONFLICT','目录、选择、要求或募集书已变化，请重新判断。');
      decisions=assessment.result.decisions as WorkpaperDecision[];
      if(decisions.length!==selected.length||new Set(decisions.map(d=>d.item_id)).size!==selected.length||selected.some(e=>!decisions.some(d=>d.item_id===e.id)))throw conflict('INPUT_REVISION_CONFLICT','判断清单不完整，请重新判断。');
      }
      const generatable=direct?selected.length:decisions.filter(d=>d.status==='generate').length;
      const auto=automaticBillingEnabled(c),version=auto?await resolveAutomaticTaskPriceVersion(c,user):null,unit=version?(await loadAutomaticTaskTariff(c,version)).workpaper.points:WORKPAPER_PRICE.points;
      if(b.price_version!==(version??WORKPAPER_PRICE.version)||b.expected_points!==generatable*unit)throw conflict('QUOTE_CHANGED','文件数量或任务版本已变化，请刷新当前目录。');
      if(auto)await requireFileUpdateCredits(c,user,progressive&&generatable?unit:b.expected_points,true);
      if((await c.query("SELECT 1 FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')",[user,id])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','本项目已有底稿文件包待完成，请先继续或结束原文件包。');
      const source=await projectFileSource(c,user,id);
      if(source&&(source.selection_revision>b.source_selection_revision||source.selection_revision===b.source_selection_revision&&source.version_id!==b.source_version_id))
        throw conflict('PROJECT_FILE_BATCH_INPUT_EXPIRED','上次底稿文件包未提交，募集书依据已变化，请刷新页面重新核对。');
      if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.source_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集说明书版本已变化，请重新核对。');
      await readM4MaterialPin(c,user,cat.material);
      for(const material of additionalMaterials)await readM4MaterialPin(c,user,material);
      if(!p.market||!p.offering)throw new Problem(422,'INPUT_REQUIRED','请补充项目市场和品种。');
      const imported=await importProspectusMaterial(c,blobs(),user,source.project_id,source.version_id);
      const sourcePin={source_project_id:source.project_id,material_id:imported.material_id,material_version:imported.material_version,sha256:imported.sha256};
      const batchId=uid(),topicId=uid(),child=uid(),scope=p.execution_scope_project_id||id;
      await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,execution_scope_project_id) VALUES($1,$2,$3,'generation',$4,$5,$6,$7)",[child,user,'底稿 · '+p.name,p.issuer_name,p.market,p.offering,scope]);
      await c.query("INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash,surface) VALUES($1,$2,$3,$4,$5,$6,$7,'materials')",[topicId,user,child,id,'底稿 · '+p.name,'workpaper:'+batchId,hash]);
      await c.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,assessment_id,assessment_hash,start_mode,progressive_plan,progressive_phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14,$15)",[batchId,user,id,topicId,cat.id,b.request_id,hash,source,b.expected_points,b.price_version,b.assessment_id??null,b.assessment_hash??null,direct?'direct':'assessed',progressive?{chapters:progressive.chapters,trial_item_ids:progressive.trial_item_ids,max_parallel:WORKPAPER_MAX_PARALLEL}:null,progressive?'trial':null]);
      // Shared extraction currently reads only the prospectus. System-template
      // batches with supplements use the existing material-aware per-file path.
      for(const [ordinal,entry] of selected.entries()){
        const decision=decisions.find(d=>d.item_id===entry.id);
        const manifest:M4DocumentManifest={version:'m4-document-input-v1',kind:'document',topic_id:topicId,execution_scope_project_id:scope,project_name:p.name,draft_version:1,
          market:p.market,offering:p.offering,billing_task:'m4_workpaper',template_material:templateInputs?.templates[entry.id]?.material??null,knowledge:loadWorkpaperKnowledge(p.market as Market,p.offering as Offering,entry,!!templateInputs),
          input:{document_type:'workpaper',workpaper:{batch_id:batchId,catalogue_id:cat.id,entry,...(direct?{mode:'direct' as const,...(templateInputs||additionalMaterials.length?{}:{execution:progressive?'progressive_item_v1' as const:'grouped_batch_v1' as const})}:{decision})},source_material:sourcePin,materials:[cat.material,...(templateInputs?.materials??[]),...additionalMaterials],template:templateInputs?.templates[entry.id]?.template??null,edit_base:null,scope:'whole',
            fields:{market:p.market,offering:p.offering,issuer_name:p.issuer_name??'',source_filename:source.filename,source_version:String(source.sequence)},requirements:[],supplemental_requirements:b.requirements}};
        let explanation=null;
        if(decision&&decision.status!=='generate'){
          const bytes=await workpaperDocx(entry.path.split('/').at(-1)!.replace(/\.docx$/i,'')+' — 不适用说明',explanationParagraphs(entry,decision,source,''),loadWorkpaperTemplate({code:entry.code,title:'不适用说明'}));
          const sha256=digest(bytes),key=`owners/${user}/projects/${id}/workpapers/${batchId}/${entry.id}/${sha256}.docx`;
          await blobs().put(key,bytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
          const stored=await blobs().getIfExistsBounded(key,1024*1024);if(!stored||digest(stored)!==sha256)throw Error('WORKPAPER_EXPLANATION_STORE_FAILED');
          explanation={key,sha256,filename:entry.path.replace(/\.docx$/i,'-不适用说明.docx').split('/').at(-1)};
        }
        await c.query('INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state,explanation) VALUES($1,$2,$3,$4,$5,$6,$7)',[user,batchId,entry.id,ordinal,manifest,explanation?'succeeded':'queued',explanation]);
      }
      if(!generatable)await c.query("UPDATE bb_workpaper_batches SET state='complete' WHERE id=$1",[batchId]);
      await event(c,user,id,'workpaper.batch_submitted',{batch_id:batchId,count:selected.length});return batchId;
}

export function registerWorkpapers(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs){
  registerGenerationProgress(app,db,owner,'workpapers');
  const zipCache=new WorkpaperZipCache();
  app.addHook('onClose',()=>zipCache.close());
  registerWorkpaperAssessments(app,db,owner);
  registerWorkpaperLibrary(app,db,owner);
  const base='/api/v1/projects/:project_id/workpapers',params=(r:FastifyRequest)=>r.params as {project_id:string;batch_id:string};
  app.get(base,async r=>readWorkpapers(db(),await owner(r),params(r).project_id));
  app.get(base+'/batches/:batch_id',async r=>readWorkpaperBatch(db(),await owner(r),params(r).project_id,params(r).batch_id));
  app.get(base+'/catalogues/:catalogue_id',async r=>{
    const user=await owner(r),id=params(r).project_id;
    await project(db(),user,id);
    const row=(await db().query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,(r.params as {catalogue_id:string}).catalogue_id])).rows[0];
    if(!row)throw missing();return catalogueDto(row);
  });
  const readCatalogue=async(c:Db,user:string,id:string,b:Static<typeof WorkpaperPreviewSchema>)=>{
    if(b.material.source_project_id!==id)throw missing();const material=await readM4MaterialPin(c,user,b.material);
    if(material.media_type!==xlsx)throw new Problem(422,'VALIDATION_FAILED','请上传 XLSX 底稿目录；旧版 XLS 请先另存为 XLSX。');
    const bytes=await blobs().getIfExistsBounded(material.object_key,WORKPAPER_LIMITS.fileBytes);
    if(!bytes||digest(bytes)!==b.material.sha256)throw new Problem(422,'VALIDATION_FAILED','目录文件超过 10 MB 或暂时不可读取。');
    try{return {material,bytes,preview:previewWorkpaperXlsx(bytes,b.scope,b.mapping)};}
    catch(e){if(e instanceof Problem)throw e;throw new Problem(422,'VALIDATION_FAILED','目录格式无法读取，请另存为标准 XLSX 后上传。');}
  };
  // Read-only interpretation of a pinned upload. No catalogue, run or charge is created.
  app.post(base+'/catalogue-preview',{schema:{body:WorkpaperPreviewSchema}},async r=>{
    const user=await owner(r),id=params(r).project_id;await project(db(),user,id);
    const {material,preview}=await readCatalogue(db(),user,id,r.body as Static<typeof WorkpaperPreviewSchema>);
    return {filename:material.filename,...preview};
  });
  app.post(base+'/catalogues',{schema:{body:WorkpaperImportSchema}},async r=>{
    const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof WorkpaperImportSchema>,hash=inputManifestHash({project_id:id,...b});
    return transaction(db(),async c=>{
      const p=await project(c,user,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':workpaper-catalogue:'+b.request_id]);
      const prior=(await c.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(prior){if(prior.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此上传请求已使用。');return catalogueDto(prior);}
      const {material,bytes,preview}=await readCatalogue(c,user,id,b);
      if(!b.mapping&&preview.needs_review)throw new Problem(422,'VALIDATION_FAILED','目录结构需要确认，请打开识别预览核对名称列和条目范围，无需重新上传。');
      const parsed=parseWorkpaperXlsx(bytes,b.scope,b.mapping);parsed.warnings=preview.warnings;
      const row=(await c.query('INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [uid(),user,id,b.request_id,hash,b.material,material.filename,JSON.stringify(parsed.entries),JSON.stringify(parsed.warnings),inputManifestHash(parsed)])).rows[0];
      await event(c,user,id,'workpaper.catalogue_imported',{catalogue_id:row.id});return catalogueDto(row);
    });
  });
  app.post(base+'/batches',{schema:{body:WorkpaperStartSchema}},async r=>{
    const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof WorkpaperStartSchema>,hash=inputManifestHash({project_id:id,...b});
    const batch=await transaction(db(),async c=>{
      return createWorkpaperBatch(c,blobs,user,id,b);
    });return readWorkpaperBatch(db(),user,id,batch);
  });
  app.post(base+'/batches/:batch_id/actions',{schema:{body:WorkpaperActionSchema}},async r=>{
    const user=await owner(r),{project_id:id,batch_id:batch}=params(r),b=r.body as Static<typeof WorkpaperActionSchema>;
    await transaction(db(),async c=>{
      await project(c,user,id,true);const row=await ownedBatch(c,user,id,batch,true);
      const billing='billing_resume' in b?b:null;
      const hash=billing?inputManifestHash({project_id:id,batch_id:batch,...billing}):null;
      const continuation=b.action==='continue_remaining'?b:null;
      const continuationHash=continuation?inputManifestHash({project_id:id,batch_id:batch,...continuation}):null;
      if(continuation){
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':workpaper-continuation:'+continuation.request_id]);
        const previous=(await c.query('SELECT batch_id,request_hash FROM bb_workpaper_continuations WHERE owner_user_id=$1 AND request_id=$2',[user,continuation.request_id])).rows[0];
        if(previous){if(previous.batch_id!==batch||previous.request_hash.trim()!==continuationHash)throw conflict('IDEMPOTENCY_CONFLICT','此确认请求已用于其他底稿范围。');return;}
      }
      if(billing){
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':workpaper-billing-resume:'+billing.request_id]);
        const previous=(await c.query('SELECT batch_id,request_hash FROM bb_workpaper_billing_resumes WHERE owner_user_id=$1 AND request_id=$2',[user,billing.request_id])).rows[0];
        if(previous){if(previous.batch_id!==batch||previous.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此恢复请求已用于其他底稿范围。');return;}
      }
      if(row.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','底稿任务状态已变化，请刷新后重试。');
      if(billing){
        if(row.state!=='paused'||row.pause_reason!=='credits_insufficient'||!isAutomaticPriceVersion(row.price_version)||billing.price_version!==row.price_version)throw conflict('INPUT_REVISION_CONFLICT','本批次已不处于原余额不足状态，请查看当前进度。');
        const remaining=Number((await c.query("SELECT count(*) n FROM bb_workpaper_items WHERE owner_user_id=$1 AND batch_id=$2 AND state='queued'",[user,batch])).rows[0].n);
        const points=(row.progressive_plan?Math.min(1,remaining):remaining)*(await loadAutomaticTaskTariff(c,row.price_version)).workpaper.points;
        if(points<=0||billing.expected_points!==points)throw conflict('QUOTE_CHANGED','本批剩余底稿范围已变化，请刷新进度。');
        await withAutomaticBilling(c,true,()=>requireFileUpdateCredits(c,user,points,true),row.price_version);
      }
      if(['resume','retry_failed','continue_remaining'].includes(b.action)&&(await c.query("SELECT 1 FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND id<>$3 AND state IN ('queued','running','paused')",[user,id,batch])).rowCount)
        throw conflict('PROJECT_RUN_ACTIVE','本项目已有其他底稿文件包待完成，请先处理该文件包。');
      let state:string;
      if(b.action==='pause'&&['queued','running'].includes(row.state))state='paused';
      else if(b.action==='cancel'&&['queued','running','paused'].includes(row.state))state='cancelled';
      else if(b.action==='resume'&&row.state==='paused'&&row.progressive_phase!=='awaiting_confirmation'){
        if(row.progressive_plan){
          if((await c.query("SELECT 1 FROM bb_workpaper_items i JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id WHERE i.batch_id=$1 AND r.state IN ('paused','awaiting_input') LIMIT 1",[batch])).rowCount)
            throw conflict('PROJECT_RUN_ACTIVE','仍有文件等待处理条件恢复或补充信息，请先点击该文件的“查看任务”完成处理，再继续本批。');
          if(row.pause_reason==='shared_blocked'&&(await c.query("SELECT 1 FROM bb_workpaper_items i JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id WHERE i.batch_id=$1 AND r.state IN ('failed','cancelled','rejected','test_completed') LIMIT 1",[batch])).rowCount)
            throw conflict('INPUT_REVISION_CONFLICT','受阻文件已失败，请在当前文件收尾后点击“重试受阻文件并继续”。已完成文件会保留。');
        }else{
          // Legacy resume acknowledges only failures already durable now; it
          // does not retry that item or acknowledge an active run's future failure.
          await c.query(`UPDATE bb_workpaper_items i SET state='failed' FROM bb_runs r
            WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.state='running' AND r.owner_user_id=i.owner_user_id
              AND r.id=i.run_id AND r.state='failed' AND i.manifest->'input'->'workpaper'->>'execution'='shared_batch_v1'
              AND (i.manifest->'input'->'template' IS NULL OR i.manifest->'input'->'template'='null'::jsonb)
              AND NOT EXISTS(SELECT 1 FROM bb_workpaper_shared_plans p WHERE p.owner_user_id=i.owner_user_id AND p.batch_id=i.batch_id)`,[user,batch]);
        }
        state='queued';
      }
      else if(continuation&&row.state==='paused'&&row.progressive_phase==='awaiting_confirmation'){
        state='queued';
        await c.query("UPDATE bb_workpaper_batches SET progressive_phase='remaining',progressive_retry_items=NULL,progressive_retry_return_phase=NULL WHERE id=$1",[batch]);
      }
      else if(b.action==='retry_failed'&&(['partial','cancelled'].includes(row.state)||row.progressive_plan&&row.state==='paused'&&(row.progressive_phase==='awaiting_confirmation'||row.pause_reason==='shared_blocked'))){
        const active=(await c.query(`SELECT 1 FROM bb_workpaper_items i JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
          LEFT JOIN bb_jobs j ON j.owner_user_id=i.owner_user_id AND j.run_id=i.run_id
          WHERE i.batch_id=$1 AND (NOT(r.state=ANY($2::text[])) OR $3 AND (NOT(j.state=ANY($2::text[])) OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL))`,[batch,terminal,!!row.progressive_plan])).rowCount;
        if(active)throw conflict('PROJECT_RUN_ACTIVE','请先等待当前文件完成；等待处理的文件请点击“查看任务”完成处理。');
        if(row.progressive_plan&&(await c.query(`SELECT 1 FROM bb_workpaper_attempts a JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.run_id=a.run_id
          JOIN bb_model_call_attempts m ON m.owner_user_id=j.owner_user_id AND m.job_id=j.id
          WHERE a.batch_id=$1 AND m.status='pending_reconcile' LIMIT 1`,[batch])).rowCount)
          throw conflict('PROJECT_RUN_ACTIVE','本批模型调用仍在核对用量，请等待对账完成后重试，避免重复调用。');
        const failed=(await c.query(`SELECT i.item_id FROM bb_workpaper_items i LEFT JOIN bb_runs r ON r.id=i.run_id AND r.owner_user_id=i.owner_user_id
          WHERE i.batch_id=$1 AND (i.state='failed' OR r.state=ANY($2::text[]))`,[batch,['failed','cancelled','rejected','test_completed']])).rows.map(r=>r.item_id);
        if(!failed.length&&row.progressive_plan)throw conflict('INPUT_REVISION_CONFLICT','本批没有需要重试的失败文件。');
        const pendingRetry=row.progressive_plan&&row.state!=='cancelled'&&row.progressive_phase==='retry_failed'?(await c.query("SELECT item_id FROM bb_workpaper_items WHERE batch_id=$1 AND state='queued' AND item_id=ANY($2::text[])",[batch,row.progressive_retry_items??[]])).rows.map(r=>r.item_id):[];
        await c.query("UPDATE bb_workpaper_items SET run_id=NULL,state='queued',attempt=attempt+1,error=NULL WHERE batch_id=$1 AND item_id=ANY($2::text[])",[batch,failed]);state='queued';
        const returnPhase=row.state==='cancelled'?'cancelled':row.progressive_phase==='retry_failed'?row.progressive_retry_return_phase??'remaining':['trial','awaiting_confirmation'].includes(row.progressive_phase)?'awaiting_confirmation':'remaining';
        if(row.progressive_plan)await c.query("UPDATE bb_workpaper_batches SET progressive_phase='retry_failed',progressive_retry_items=$2,progressive_retry_return_phase=$3 WHERE id=$1",[batch,JSON.stringify([...new Set([...failed,...pendingRetry])]),returnPhase]);
      }else throw conflict('INPUT_REVISION_CONFLICT','当前状态不支持该操作。');
      await c.query('UPDATE bb_workpaper_batches SET state=$2,revision=revision+1,error=NULL,pause_reason=NULL,updated_at=now() WHERE id=$1',[batch,state]);
      if(billing)await c.query('INSERT INTO bb_workpaper_billing_resumes(owner_user_id,request_id,batch_id,request_hash) VALUES($1,$2,$3,$4)',[user,billing.request_id,batch,hash]);
      if(continuation)await c.query('INSERT INTO bb_workpaper_continuations(owner_user_id,request_id,batch_id,request_hash) VALUES($1,$2,$3,$4)',[user,continuation.request_id,batch,continuationHash]);
      await event(c,user,id,'workpaper.batch_'+b.action,{batch_id:batch});
    });return readWorkpaperBatch(db(),user,id,batch);
  });
  app.get(base+'/batches/:batch_id/explanations/:item_id',async(r,reply)=>{
    const user=await owner(r),{project_id:id,batch_id:batch}=params(r),item=(r.params as {item_id:string}).item_id;
    const file=await explanationFile(db(),blobs(),user,id,batch,item);
    return reply.header('Cache-Control','private, no-store').header('Content-Disposition',contentDisposition(file.filename)).type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(file.bytes);
  });
  app.get(base+'/batches/:batch_id/items/:item_id/preview',async(r,reply)=>{
    const user=await owner(r),{project_id:id,batch_id:batch}=params(r),itemId=(r.params as {item_id:string}).item_id;
    const data=await readWorkpaperBatch(db(),user,id,batch),item=data.items.find(i=>i.entry.id===itemId);if(!item)throw missing();
    let bytes:Buffer;
    if(item.explanation)bytes=(await explanationFile(db(),blobs(),user,id,batch,itemId)).bytes;
    else{const a=item.artifacts.find(a=>a.kind==='document');if(!a)throw missing();const row=await readProjectFileAsset(db(),user,{kind:'artifact',pin:a.pin});
      const stored=await blobs().getIfExistsBounded(row.object_key,64*1024*1024);if(!stored||digest(stored)!==a.pin.sha256)throw new Problem(503,'DATA_UNAVAILABLE','文件暂不可读取。');bytes=stored;}
    try{return reply.header('Cache-Control','private, no-store').send({text:workpaperPreview(bytes)});}catch{throw new Problem(422,'DATA_UNAVAILABLE','正文暂无法预览，请下载原文件查看。');}
  });
  app.get(base+'/batches/:batch_id/download',async(r,reply)=>{
    const user=await owner(r),{project_id:id,batch_id:batch}=params(r),data=await readWorkpaperBatch(db(),user,id,batch);
    if(!data.items.some(i=>i.artifacts.length||i.explanation))throw new Problem(422,'INPUT_REQUIRED','尚无已完成底稿可打包。');
    const files=await readWorkpaperZipFiles(db(),user,data);
    const scope=JSON.stringify([user,id,batch]);
    // Keep cold ZIP preparation out of an idle HTTP connection. Older clients
    // retain the blocking response; polling clients opt in with standard Prefer.
    const preparation=r.headers.prefer==='respond-async'?zipCache.prepare(scope,files,blobs()):true;
    if(preparation!==true)
      return reply.code(202).header('Cache-Control','private, no-store').header('Retry-After','2')
        .header('Preference-Applied','respond-async').send(preparation);
    const controller=new AbortController();
    reply.raw.once('close',()=>controller.abort());
    const started=performance.now();
    const archive=await zipCache.open(scope,files,blobs(),controller.signal);
    r.log.info({batch_id:batch,files:files.length,zip_bytes:archive.size,zip_cache_hit:archive.cached,zip_prepare_ms:Math.round(performance.now()-started)},'workpaper ZIP ready');
    return reply.header('Cache-Control','private, no-store').header('Content-Length',archive.size)
      .header('Content-Disposition',`attachment; filename="workpapers.zip"; filename*=UTF-8''${encodeURIComponent('底稿文件包.zip')}`)
      .type('application/zip').send(archive.body);
  });
}

async function explanationFile(db:Db,blobs:PrivateBlobs,owner:string,id:string,batch:string,item:string){
 await ownedBatch(db,owner,id,batch);
 const row=(await db.query(`SELECT coalesce(i.explanation,w.explanation) AS explanation,i.manifest FROM bb_workpaper_items i
  LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
  LEFT JOIN bb_workpaper_item_results w ON w.owner_user_id=i.owner_user_id AND w.run_id=i.run_id AND r.state='succeeded'
  WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3`,[owner,batch,item])).rows[0];
 if(!row?.explanation)throw missing();const bytes=await blobs.getIfExistsBounded(row.explanation.key,1024*1024);
 if(!bytes||digest(bytes)!==row.explanation.sha256)throw new Problem(503,'DATA_UNAVAILABLE','说明文件暂不可读取，请重试。');
 return {bytes,filename:workpaperDownloadFilename(row.manifest.input.workpaper.entry,{explanation:true})};
}
import {isAutomaticPriceVersion} from '@bondbuddy/contracts';
import {automaticBillingEnabled,withAutomaticBilling} from './automatic-billing-context.js';
import {requireFileUpdateCredits} from './project-file-billing.js';
