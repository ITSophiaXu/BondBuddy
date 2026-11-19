/** Private, explicit import into a separately authorized NEW run. Never reopens a terminal run. */
import type {Pool} from 'pg';
import {transaction,digest,uid,type PrivateBlobs} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {validFileAuthoringRecovery} from '@bondbuddy/api/queue';
import {FILE_AUTHORING_CAPTURE_VERSION,FILE_AUTHORING_RECOVERY_LIMITS,isFileAuthoringDeadline} from '@bondbuddy/contracts';
import type {FileAuthoringRecovery} from './file-authoring-recovery.js';
export const FILE_AUTHORING_SEED_STAGE='file_authoring_prior_work';
export const FILE_AUTHORING_SEED_MAX_MS=90*60*1000;
export type FileAuthoringSeed={version:'file-authoring-new-run-seed-v1';owner_user_id:string;project_id:string;run_id:string;job_id:string;
 input_revision:number;input_hash:string;source_run_id:string;source_job_id:string;source_attempt_id:string;source_snapshot_sha256:string;
 actor:string;authorized_at:string;deadline_at:string;budget_ms:number;small_batches:boolean;snapshot:FileAuthoringRecovery;snapshot_sha256:string};
const field=/^[A-Za-z0-9_.@-]{1,128}$/;
const conflict=()=>new Error('AUTHORING_SEED_CONFLICT');
const prefix=(r:{owner_user_id:string;project_id:string;id:string})=>`owners/${r.owner_user_id}/projects/${r.project_id}/runs/${r.id}/file-authoring/recovery/`;

export function validFileAuthoringSeed(value:unknown,scope:{owner:string;project:string;run:string;job:string;revision:number;inputHash:string}):value is FileAuthoringSeed{
 const s=value as FileAuthoringSeed;
 return !!s&&s.version==='file-authoring-new-run-seed-v1'&&s.owner_user_id===scope.owner&&s.project_id===scope.project&&s.run_id===scope.run&&s.job_id===scope.job
  &&s.input_revision===scope.revision&&s.input_hash===scope.inputHash&&s.source_run_id!==s.run_id&&s.source_job_id!==s.job_id
  &&[s.source_run_id,s.source_job_id,s.source_attempt_id,s.actor].every(x=>typeof x==='string'&&field.test(x))
  &&/^[a-f0-9]{64}$/.test(s.source_snapshot_sha256)&&typeof s.small_batches==='boolean'
  &&isFileAuthoringDeadline(s.authorized_at)&&isFileAuthoringDeadline(s.deadline_at)&&Number.isSafeInteger(s.budget_ms)&&s.budget_ms>0&&s.budget_ms<=FILE_AUTHORING_SEED_MAX_MS
  &&Date.parse(s.deadline_at)-Date.parse(s.authorized_at)===s.budget_ms
  &&s.snapshot?.attempt_id===`seed-${inputManifestHash({source:s.source_run_id,attempt:s.source_attempt_id,target:s.run_id}).slice(0,40)}`
  &&s.snapshot.deadline_at===s.deadline_at&&s.snapshot_sha256===inputManifestHash(s.snapshot)
  &&validFileAuthoringRecovery(s.snapshot,{...scope,attempt:s.snapshot.attempt_id,logical:'file-authoring-v1'});
}

/** Caller must already have created a normal queued run/quote/reservation. The
 * original budget, terminal state, raw observations and credit ledger are read-only.
 * Locks cover the complete verified copy and atomic seed receipt publication. */
export async function seedFileAuthoringRun(pool:Pool,blobs:PrivateBlobs,input:{sourceRunId:string;targetRunId:string;actor:string;budgetMs:number}){
 if(![input.sourceRunId,input.targetRunId,input.actor].every(x=>field.test(x))||input.sourceRunId===input.targetRunId||!Number.isSafeInteger(input.budgetMs)||input.budgetMs<1||input.budgetMs>FILE_AUTHORING_SEED_MAX_MS)throw conflict();
 return transaction(pool,async client=>{
  const target=(await client.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[input.targetRunId])).rows[0];
  if(!target)throw conflict();
  const job=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[target.id,target.owner_user_id])).rows[0];
  if(!job)throw conflict();
  const scope={owner:target.owner_user_id,project:target.project_id,run:target.id,job:job.id,revision:Number(target.input_revision),inputHash:String(target.input_hash).trim()};
  const prior=job.checkpoint?.stages?.[FILE_AUTHORING_SEED_STAGE];
  if(prior){
   if(!validFileAuthoringSeed(prior,scope)||prior.source_run_id!==input.sourceRunId||prior.actor!==input.actor||prior.budget_ms!==input.budgetMs)throw conflict();
   return {run_id:target.id,source_run_id:prior.source_run_id,files:prior.snapshot.files.length,deadline_at:prior.deadline_at,idempotent:true};
  }
  if(target.task_kind!=='update'||target.state!=='queued'||target.stage!=='queued'||target.artifact_id||target.billing_mode!=='fixed_credits'
   ||job.job_type!=='update'||job.subtype!=='update_pipeline_v1'||job.state!=='queued'||job.lease_token||job.lease_until
   ||job.user_pause_requested||job.credit_pause_requested||job.billing_cancel_requested_at||Object.keys(job.checkpoint??{}).length)throw conflict();
  const source=(await client.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 FOR UPDATE',[input.sourceRunId,scope.owner,scope.project])).rows[0];
  const old=source&&(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[source.id,scope.owner])).rows[0];
  if(!source||!old||source.task_kind!=='update'||source.state!=='failed'||source.stage!=='failed'||source.artifact_id||source.channel!==target.channel
   ||source.billing_mode!=='fixed_credits'||Number(source.input_revision)!==scope.revision||String(source.input_hash).trim()!==scope.inputHash
   ||new Date(source.created_at).getTime()>=new Date(target.created_at).getTime()||old.job_type!=='update'||old.subtype!=='update_pipeline_v1'||old.state!=='failed'||old.lease_token||old.lease_until||old.billing_cancel_requested_at)throw conflict();
  const project=(await client.query('SELECT archived_at,deleted_at FROM bb_projects WHERE id=$1 AND owner_user_id=$2',[scope.project,scope.owner])).rows[0];
  if(!project||project.archived_at||project.deleted_at)throw conflict();
  const reservations=(await client.query('SELECT * FROM bb_credit_reservations WHERE id=ANY($1::text[]) AND owner_user_id=$2 FOR UPDATE',[[source.reservation_id,target.reservation_id],scope.owner])).rows;
  if(source.reservation_id===target.reservation_id||reservations.length!==2||!reservations.some(r=>r.id===source.reservation_id&&r.run_id===source.id&&r.state==='released'&&r.billing_policy==='on_delivery'&&String(r.charged_points)==='0')
   ||!reservations.some(r=>r.id===target.reservation_id&&r.run_id===target.id&&r.state==='held'&&r.billing_policy==='on_delivery'))throw conflict();
  const exists=await client.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1)
    OR EXISTS(SELECT 1 FROM bb_artifact_versions WHERE run_id=ANY($2::text[]))`,[job.id,[source.id,target.id]]);
  if(exists.rowCount)throw conflict();
  const a=(await client.query(`SELECT a.*,t.adapter,t.adapter_version,t.exit_code,t.exit_signal,t.finish_reason,t.error_code,u.usage_status,u.conflicting_measurements
   FROM bb_model_call_attempts a JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id JOIN bb_call_usage u ON u.attempt_id=a.id
   WHERE a.job_id=$1 AND a.owner_user_id=$2 ORDER BY a.created_at DESC,a.attempt_no DESC LIMIT 1`,[old.id,scope.owner])).rows[0];
  const snapshot=old.checkpoint?.stages?.file_authoring_recovery as FileAuthoringRecovery|undefined,capture=old.checkpoint?.file_authoring_recovery_captures?.[a?.id],audit=old.checkpoint?.operator_reconciliations?.[a?.id];
  if(!a||a.status!=='failed'||a.logical_call_id!=='file-authoring-v1'||a.adapter!=='codex_exec'||a.adapter_version!=='codex-file-authoring-2'
   ||a.error_code!=='MODEL_TIMEOUT'||a.finish_reason!=='timeout'||!['SIGTERM','SIGKILL'].includes(a.exit_signal)||a.exit_code!==null
   ||a.usage_status!=='unknown'||Number(a.conflicting_measurements)!==0||!snapshot||!isFileAuthoringDeadline(snapshot.deadline_at)||Date.parse(snapshot.deadline_at)>Date.now()
   ||!validFileAuthoringRecovery(snapshot,{owner:scope.owner,project:scope.project,run:source.id,inputHash:scope.inputHash,attempt:a.id,logical:a.logical_call_id})
   ||!snapshot.files.some(f=>f.path==='output/operations.json'&&f.byte_size>0)
   ||capture?.version!==FILE_AUTHORING_CAPTURE_VERSION||capture.state!=='saved'||capture.failure_code!==null||capture.attempt_id!==a.id||capture.logical_call_id!==a.logical_call_id
   ||!isFileAuthoringDeadline(capture.prepared_at)||capture.owner_user_id!==scope.owner||capture.project_id!==scope.project||capture.run_id!==source.id||capture.job_id!==old.id||capture.input_revision!==scope.revision||capture.input_hash!==scope.inputHash||capture.deadline_at!==snapshot.deadline_at
   ||audit?.actor!=='worker_file_authoring_recovery'||audit.reason_code!=='file_authoring_context_deadline_exhausted'||audit.decision!=='fail_run'||audit.attempt_id!==a.id||audit.logical_call_id!==a.logical_call_id||audit.deadline_at!==snapshot.deadline_at)throw conflict();
  const evidence=(await client.query(`SELECT
   EXISTS(SELECT 1 FROM bb_model_call_attempts n WHERE n.job_id=$1 AND (n.created_at>(SELECT created_at FROM bb_model_call_attempts WHERE id=$2) OR n.created_at=(SELECT created_at FROM bb_model_call_attempts WHERE id=$2) AND n.attempt_no>$3)) AS newer,
   EXISTS(SELECT 1 FROM bb_provider_result_refs p WHERE p.attempt_id IN(SELECT id FROM bb_model_call_attempts WHERE job_id=$1)) AS result,
   EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=$2 AND o.outcome='pending_reconcile' AND o.error_code='MODEL_TIMEOUT' AND o.finish_reason='timeout' AND o.usage_status='unknown' AND o.result_id IS NULL) AS observed,
   EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=$2 AND (o.outcome<>'pending_reconcile' OR o.error_code IS DISTINCT FROM 'MODEL_TIMEOUT' OR o.finish_reason IS DISTINCT FROM 'timeout' OR o.usage_status<>'unknown' OR o.result_id IS NOT NULL)) AS conflict`,[old.id,a.id,a.attempt_no])).rows[0];
  const terminal=(await client.query('SELECT payload FROM bb_run_events WHERE run_id=$1 AND seq=$2',[source.id,source.event_cursor])).rows[0]?.payload;
  if(evidence.newer||evidence.result||!evidence.observed||evidence.conflict||terminal?.reason!=='file_authoring_context_deadline_exhausted'||terminal.error_code!=='MODEL_TIMEOUT')throw conflict();
  const seedId=`seed-${inputManifestHash({source:source.id,attempt:a.id,target:target.id}).slice(0,40)}`;
  const copied:FileAuthoringRecovery={...snapshot,attempt_id:seedId,files:[]};
  for(const f of snapshot.files){
   const bytes=await blobs.getIfExistsBounded(f.key,FILE_AUTHORING_RECOVERY_LIMITS.fileBytes);
   if(!bytes||bytes.length!==f.byte_size||digest(bytes)!==f.sha256)throw Error('WORD_OUTPUT_BLOB_MISMATCH');
   const key=`${prefix(target)}${seedId}/${f.sha256}/${f.path}`;
   await blobs.put(key,bytes,'application/octet-stream');
   const readback=await blobs.getIfExistsBounded(key,FILE_AUTHORING_RECOVERY_LIMITS.fileBytes);
   if(!readback||readback.length!==f.byte_size||digest(readback)!==f.sha256)throw Error('AUTHORING_OUTPUT_STORE_FAILED');
   copied.files.push({...f,key});
  }
  const now=Date.now(),authorizedAt=new Date(now).toISOString(),deadlineAt=new Date(now+input.budgetMs).toISOString();copied.deadline_at=deadlineAt;
  const receipt:FileAuthoringSeed={version:'file-authoring-new-run-seed-v1',owner_user_id:scope.owner,project_id:scope.project,run_id:scope.run,job_id:scope.job,input_revision:scope.revision,input_hash:scope.inputHash,
   source_run_id:source.id,source_job_id:old.id,source_attempt_id:a.id,source_snapshot_sha256:inputManifestHash(snapshot),actor:input.actor,authorized_at:authorizedAt,deadline_at:deadlineAt,budget_ms:input.budgetMs,
   small_batches:Object.values(old.checkpoint?.operator_reconciliations??{}).some((v:any)=>v?.logical_call_id===a.logical_call_id&&(v.reason_code==='file_authoring_payload_auto_retry'||v.reason_code==='file_authoring_output_limit_auto_retry'&&v.error_code==='MODEL_PROVIDER_OUTPUT_LIMIT')),snapshot:copied,snapshot_sha256:inputManifestHash(copied)};
  if(!validFileAuthoringSeed(receipt,scope))throw conflict();
  await client.query(`UPDATE bb_jobs SET checkpoint=jsonb_build_object('stages',jsonb_build_object($2::text,$3::jsonb)),updated_at=now() WHERE id=$1`,[job.id,FILE_AUTHORING_SEED_STAGE,JSON.stringify(receipt)]);
  const seq=Number(target.event_cursor)+1,eventId=uid(),payload={reason:'file_authoring_prior_work_seeded',source_run_id:source.id,source_attempt_id:a.id,deadline_at:deadlineAt,files:copied.files.length};
  await client.query('UPDATE bb_runs SET event_cursor=$2,updated_at=now() WHERE id=$1',[target.id,seq]);
  await client.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$3,'run.progress','queued','queued',$5)`,[eventId,scope.owner,target.id,seq,payload]);
  await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'run',$3,'run.progress',$4)`,[uid(),scope.owner,target.id,{run_id:target.id,event_id:eventId,seq,state:'queued',stage:'queued',...payload}]);
  return {run_id:target.id,source_run_id:source.id,files:copied.files.length,deadline_at:deadlineAt,idempotent:false};
 });
}
