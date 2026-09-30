import { Value } from '@sinclair/typebox/value';
import { schemas, ERROR_CODES, ERROR_CATEGORIES, type InternalObservabilityEvent } from '@bondbuddy/contracts';
import { Pool, type PoolClient } from 'pg';
import { digest, isAutoTestExecutionKeyStorage, missing, transaction, uid, type PrivateBlobs } from './data.js';
import { guardEvidenceWrite } from './evidence-gate.js';
import type { UploadRejectionReason, UploadStructureDetail } from './upload-safety.js';
import { errorDiagnostic, type RecoveryOutcome } from './error-diagnostics.js';

const safeCode=/^[a-z][a-z0-9_]{0,63}$/;
const validId=(value:string)=>/^[A-Za-z0-9_-]{1,128}$/.test(value);
export const validExecutionKey=(value:unknown):value is string=>typeof value==='string'&&[...value].length>=1&&[...value].length<=128;
export const isPgInputRevision=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=2147483647;
// Hash UTF-16 code units. UTF-8 replacement would alias a lone surrogate with U+FFFD.
export const executionKeyHash=(value:string)=>digest(Buffer.from(value,'utf16le'));
export async function emitInternal(client:PoolClient,event:InternalObservabilityEvent) {
  if(!Value.Check(schemas.InternalObservabilityEvent,event))throw new Error('Invalid internal observability event');
  const {event_id,user_id,project_id,job_id,run_id,trace_id,kind,operation_id}=event;
  if(!user_id)throw new Error('Owned event required');
  await client.query(`INSERT INTO bb_observability_events(id,owner_user_id,project_id,job_id,run_id,trace_id,kind,event,channel)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE(
      (SELECT channel FROM bb_runs WHERE id=$5 AND owner_user_id=$2),
      (SELECT channel FROM bb_jobs WHERE id=$4 AND owner_user_id=$2),
      (SELECT channel FROM bb_operations WHERE id=$9 AND owner_user_id=$2),'production'))`,
    [event_id,user_id,project_id,job_id,run_id,trace_id,kind,event,operation_id]);
  await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user_id,'observability',event_id,kind,{event_id,schema_version:1}]);
}
export function internalEvent(input:{kind:InternalObservabilityEvent['kind'];owner:string;actorType?:InternalObservabilityEvent['actor_type'];projectId?:string|null;runId?:string|null;jobId?:string|null;traceId:string;operationId?:string;requestId?:string;status?:InternalObservabilityEvent['status'];stage?:string|null;error?:InternalObservabilityEvent['error'];usage?:InternalObservabilityEvent['usage'];logicalCallId?:string|null;attemptNo?:number|null;promptSnapshotRef?:string|null;jobKind?:InternalObservabilityEvent['job_kind']}):InternalObservabilityEvent {
  if(input.stage&&!safeCode.test(input.stage))throw new Error('Unsafe event stage');
  return {event_id:uid(),schema_version:1,kind:input.kind,occurred_at:new Date().toISOString(),operation_id:input.operationId??input.runId??uid(),request_id:input.requestId??uid(),trace_id:input.traceId,span_id:uid(),parent_span_id:null,actor_type:input.actorType??'system',user_id:input.owner,project_id:input.projectId??null,conversation_id:null,message_id:null,job_id:input.jobId??null,parent_job_id:null,run_id:input.runId??null,work_item_id:null,logical_call_id:input.logicalCallId??null,call_id:null,attempt_no:input.attemptNo??null,job_kind:input.jobKind??null,stage:input.stage??null,status:input.status??null,prompt_snapshot_ref:input.promptSnapshotRef??null,error:input.error??null,usage:input.usage??null};
}
export async function recordOperation(client:PoolClient,input:{owner:string;projectId?:string|null;runId?:string|null;jobId?:string|null;requestId:string;traceId:string;kind:string;status:'submitted'|'rejected';errorCode?:string;errorId?:string;errorReason?:UploadRejectionReason;errorDetail?:UploadStructureDetail;inputRevision?:number;inputHash?:string;channel?:'production'|'non_production_test';emitEvent?:boolean}) {
  if(!validId(input.requestId)||!validId(input.traceId)||!safeCode.test(input.kind))throw new Error('Invalid operation identifiers');
  if(input.errorCode&&!ERROR_CODES.includes(input.errorCode as typeof ERROR_CODES[number]))throw new Error('Invalid error code');
  let channel=input.channel??'production';
  if(input.runId){const r=await client.query('SELECT channel FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3',[input.runId,input.owner,input.projectId]);if(!r.rowCount)throw missing();channel=r.rows[0].channel;}
  if(input.jobId){const j=await client.query(`SELECT j.channel FROM bb_jobs j
    LEFT JOIN bb_runs r ON r.owner_user_id=j.owner_user_id AND r.id=j.run_id
    WHERE j.id=$1 AND j.owner_user_id=$2 AND COALESCE(j.project_id,r.project_id) IS NOT DISTINCT FROM $3`,
    [input.jobId,input.owner,input.projectId??null]);if(!j.rowCount)throw missing();channel=j.rows[0].channel;}
  const id=uid();
  await client.query('INSERT INTO bb_operations(id,owner_user_id,project_id,run_id,request_id,trace_id,operation_kind,status,error_code,input_revision,input_hash,channel) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,input.owner,input.projectId??null,input.runId??null,input.requestId,input.traceId,input.kind,input.status,input.errorCode??null,input.inputRevision??null,input.inputHash??null,channel]);
  if(input.emitEvent!==false)await emitInternal(client,internalEvent({kind:input.status==='rejected'?'operation.rejected':'operation.submitted',owner:input.owner,actorType:'user',projectId:input.projectId,runId:input.runId,jobId:input.jobId,traceId:input.traceId,operationId:id,requestId:input.requestId,status:input.status==='rejected'?'rejected':'created',error:input.errorCode?{error_id:input.errorId??uid(),code:input.errorCode as typeof ERROR_CODES[number],category:'validation',retryable:false,...(input.errorReason?{reason:input.errorReason}:{}),...(input.errorDetail?{detail:input.errorDetail}:{})}:undefined}));
  return id;
}
/** A free preflight or an owned pre-run rejection has a terminal job, even without a run. */
export async function recordLogicalJob(client:PoolClient,input:{owner:string;projectId:string;requestId:string;traceId:string;kind:'preflight'|'execute';jobType:'preflight'|'update'|'review'|'generation'|'qa'|'submission';status:'submitted'|'rejected';errorCode?:string;inputRevision?:number;inputHash?:string;stage:string;executionRequestId?:string;requestHash?:string;httpStatus?:number;schemaRejected?:boolean;revisionRejected?:boolean;channel?:'production'|'non_production_test';testGrantId?:string}) {
  if(!validId(input.owner)||!validId(input.projectId)||!validId(input.requestId)||!validId(input.traceId)||
     (input.inputRevision!==undefined&&!isPgInputRevision(input.inputRevision))||
     (input.inputHash!==undefined&&!/^[a-f0-9]{64}$/.test(input.inputHash))||!safeCode.test(input.stage)||
     (input.status==='submitted'&&input.kind!=='preflight')||
     (input.revisionRejected
       ? input.schemaRejected||input.status!=='rejected'||input.errorCode!=='VALIDATION_FAILED'||input.httpStatus!==422||input.stage!=='revision_out_of_range'||input.inputRevision!==undefined||input.inputHash!==undefined||
         (input.kind==='execute' ? input.jobType==='submission'||!input.executionRequestId||!/^[a-f0-9]{64}$/.test(input.requestHash??'') : input.jobType!=='preflight'||input.executionRequestId!==undefined||input.requestHash!==undefined)
       : input.schemaRejected
       ? input.status!=='rejected'||input.errorCode!=='VALIDATION_FAILED'||input.httpStatus!==422||
         (input.kind==='execute' ? input.jobType!=='submission'||!/^[a-f0-9]{64}$/.test(input.requestHash??'') : input.jobType!=='preflight'||input.executionRequestId!==undefined||input.requestHash!==undefined)
       : input.inputRevision===undefined||input.inputHash===undefined||
         (input.kind==='preflight')!==(input.jobType==='preflight')||
         (input.kind==='execute' ? !input.executionRequestId||!/^[a-f0-9]{64}$/.test(input.requestHash??'')||!Number.isInteger(input.httpStatus)||(input.httpStatus??0)<400||(input.httpStatus??0)>599 : input.executionRequestId!==undefined||input.requestHash!==undefined||input.httpStatus!==undefined))||
     (input.executionRequestId!==undefined&&!validExecutionKey(input.executionRequestId)&&
       !isAutoTestExecutionKeyStorage(input.executionRequestId)))throw new Error('Invalid logical job');
  const subtype=input.schemaRejected?(input.kind==='execute'?'execute_schema_rejected':'preflight_schema_rejected'):
    input.kind==='execute'?'execute_rejected':input.status==='rejected'?'preflight_rejected':'free_preflight';
  // Execute shares #17's per-owner business key; preflight has no public idempotency key.
  const keyHash=input.executionRequestId===undefined?null:executionKeyHash(input.executionRequestId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[keyHash?`${input.owner}:${keyHash}`:`logical-job:${input.owner}:${input.requestId}`]);
  const old=input.kind==='execute'&&input.executionRequestId
    ? await client.query("SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2 AND subtype IN ('execute_rejected','execute_schema_rejected')",[input.owner,keyHash])
    : await client.query("SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND request_id=$2 AND subtype IN ('free_preflight','preflight_rejected','preflight_schema_rejected','execute_schema_rejected') AND run_id IS NULL",[input.owner,input.requestId]);
  if(old.rows[0]){
    const j=old.rows[0];
    if(input.kind==='execute'){
      const same=j.request_hash?.trim()===input.requestHash;
      if(j.request_id!==input.requestId)await recordOperation(client,{owner:input.owner,projectId:j.project_id,jobId:j.id,requestId:input.requestId,traceId:input.traceId,kind:'execute',status:'rejected',errorCode:same?j.error_code:'IDEMPOTENCY_CONFLICT',inputRevision:input.projectId===j.project_id?input.inputRevision:undefined,inputHash:input.projectId===j.project_id?input.inputHash:undefined});
      return {jobId:j.id as string,replay:true,conflict:!same,errorCode:same?j.error_code as string:'IDEMPOTENCY_CONFLICT',httpStatus:same?j.rejection_http_status as number:409};
    }
    if(j.subtype!==subtype||j.project_id!==input.projectId||j.trace_id!==input.traceId||j.job_type!==input.jobType||j.input_revision!==(input.inputRevision??null)||j.input_hash?.trim()!==(input.inputHash??undefined)||j.error_code!==(input.errorCode??null)||j.stage!==input.stage)throw new Error('Conflicting logical job replay');
    return {jobId:j.id as string,replay:true,conflict:false,errorCode:j.error_code as string|null,httpStatus:null};
  }
  const owned=await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[input.owner,input.projectId]);
  if(!owned.rowCount)throw missing();
  const operationId=await recordOperation(client,{...input,emitEvent:false});
  const jobId=uid(),state=input.status==='rejected'?'rejected':'succeeded';
  await client.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,project_id,trace_id,error_code,operation_id,request_id,input_revision,input_hash,execution_request_id,execution_request_key_hash,request_hash,rejection_http_status,channel,test_grant_id)
    VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [jobId,input.owner,input.jobType,subtype,state,input.stage,input.projectId,input.traceId,input.errorCode??null,operationId,input.requestId,input.inputRevision??null,input.inputHash??null,null,keyHash,input.requestHash??null,input.httpStatus??null,input.channel??'production',input.testGrantId??null]);
  await emitInternal(client,internalEvent({kind:input.status==='rejected'?'operation.rejected':'operation.submitted',owner:input.owner,actorType:'user',projectId:input.projectId,jobId,traceId:input.traceId,operationId,requestId:input.requestId,status:input.status==='rejected'?'rejected':'created',error:input.errorCode?{error_id:uid(),code:input.errorCode as typeof ERROR_CODES[number],category:'validation',retryable:false}:undefined}));
  await emitInternal(client,internalEvent({kind:'job.state_changed',owner:input.owner,actorType:'system',projectId:input.projectId,jobId,traceId:input.traceId,operationId,requestId:input.requestId,jobKind:input.jobType==='submission'?undefined:input.jobType,status:state,stage:input.stage,error:input.errorCode?{error_id:uid(),code:input.errorCode as typeof ERROR_CODES[number],category:'validation',retryable:false}:undefined}));
  return {jobId,replay:false,conflict:false,errorCode:input.errorCode??null,httpStatus:input.httpStatus??null};
}
export async function rejectOperation(pool:Pool,input:Parameters<typeof recordOperation>[1]) {
  await transaction(pool,client=>recordOperation(client,{...input,status:'rejected'}));
}
export async function saveSnapshotRef(pool:Pool,input:{owner:string;projectId:string;runId?:string;kind:'user_prompt'|'model_request'|'structured_input';version:number;objectKey:string;sha256:string;redactionVersion:string;inputRevision?:number;inputHash?:string;templateVersion?:string;rulePackVersion?:string;modelParametersVersion?:string;blobs:PrivateBlobs}, lockedClient?:PoolClient) {
  if(!input.objectKey.startsWith(`users/${input.owner}/projects/${input.projectId}/snapshots/`)||!/^[A-Za-z0-9_-]{1,128}$/.test(input.objectKey.slice(`users/${input.owner}/projects/${input.projectId}/snapshots/`.length))||!/^[a-f0-9]{64}$/.test(input.sha256)||!safeCode.test(input.redactionVersion))throw new Error('Invalid private snapshot metadata');
  const bytes=await input.blobs.get(input.objectKey);
  if(digest(bytes)!==input.sha256)throw new Error('Snapshot hash mismatch');
  const persist=async (client:PoolClient)=>{
    if(input.inputRevision){const rev=await client.query('SELECT 1 FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4',[input.owner,input.projectId,input.inputRevision,input.inputHash]);if(!rev.rowCount)throw missing();}
    if(input.runId){const run=await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND ($4::integer IS NULL OR input_revision=$4)',[input.owner,input.projectId,input.runId,input.inputRevision??null]);if(!run.rowCount)throw missing();}
    const id=uid();
    await client.query('INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash,template_version,rule_pack_version,model_parameters_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[id,input.owner,input.projectId,input.runId??null,input.kind,input.version,input.objectKey,input.sha256,input.redactionVersion,input.inputRevision??null,input.inputHash??null,input.templateVersion??null,input.rulePackVersion??null,input.modelParametersVersion??null]);
    await emitInternal(client,internalEvent({kind:'prompt.snapshot_saved',owner:input.owner,projectId:input.projectId,runId:input.runId,traceId:input.runId??id,promptSnapshotRef:id}));
    return id;
  };
  return lockedClient ? persist(lockedClient) : transaction(pool,persist);
}
export type UsageInput={owner:string;attemptId:string;source:'provider'|'gateway'|'framework'|'reconciliation';sourceEventId:string;status:'unknown'|'pending'|'measured';inputTokens?:number;outputTokens?:number;cachedInputTokens?:number;reasoningTokens?:number;evidenceRef?:string};
export async function observeUsage(pool:Pool,input:UsageInput) {
  if(!validId(input.sourceEventId)|| (input.evidenceRef&&!validId(input.evidenceRef)))throw new Error('Invalid usage reference');
  return guardEvidenceWrite(pool,'usage_not_persisted',()=>transaction(pool,async client=>{
    const q=await client.query('SELECT a.*,j.run_id,r.project_id FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id JOIN bb_runs r ON r.id=j.run_id WHERE a.owner_user_id=$1 AND a.id=$2 FOR UPDATE OF a',[input.owner,input.attemptId]);
    const a=q.rows[0];if(!a)throw missing();
    const values=[input.inputTokens??null,input.outputTokens??null,input.cachedInputTokens??null,input.reasoningTokens??null];
    if(input.status==='measured' ? values[0]===null||values[1]===null : values.some(x=>x!==null))throw new Error('Usage status/count mismatch');
    if(values.some(x=>x!==null&&(!Number.isSafeInteger(x)||x<0)) || (values[2]!==null&&values[0]!==null&&values[2]>values[0]) || (values[3]!==null&&values[1]!==null&&values[3]>values[1]))throw new Error('Invalid usage counts');
    const id=uid();
    const inserted=await client.query('INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(attempt_id,source,source_event_id) DO NOTHING RETURNING id',[id,input.owner,input.attemptId,input.source,input.sourceEventId,input.status,...values,input.evidenceRef??null]);
    if(!inserted.rowCount){
      const old=await client.query('SELECT usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,evidence_ref FROM bb_usage_observations WHERE attempt_id=$1 AND source=$2 AND source_event_id=$3',[input.attemptId,input.source,input.sourceEventId]);
      const same=old.rows[0]&&old.rows[0].usage_status===input.status&&[old.rows[0].input_tokens,old.rows[0].output_tokens,old.rows[0].cached_input_tokens,old.rows[0].reasoning_tokens].every((v,i)=>v===values[i])&&old.rows[0].evidence_ref===(input.evidenceRef??null);
      if(!same)throw new Error('Conflicting usage replay requires a new correction event');
      return false;
    }
    await emitInternal(client,internalEvent({kind:'model.usage_observed',owner:input.owner,projectId:a.project_id,runId:a.run_id,jobId:a.job_id,traceId:a.run_id,logicalCallId:a.logical_call_id,attemptNo:a.attempt_no,usage:{status:input.status==='measured'?'reported':input.status==='pending'?'pending':'unavailable',input_tokens:values[0],output_tokens:values[1],cached_input_tokens:values[2],reasoning_tokens:values[3],evidence_ref:input.evidenceRef??null}}));
    return true;
 }));
}
export async function recordStructuredError(pool:Pool,input:{owner:string;projectId?:string;jobId?:string;attemptId?:string;traceId:string;code:typeof ERROR_CODES[number];category:typeof ERROR_CATEGORIES[number];stage?:string;providerStatus?:number;providerErrorType?:string;retryCount?:number;stack?:string;safeMessageCode?:string;recoveryStatus?:RecoveryOutcome}) {
  if(!validId(input.traceId)||(input.safeMessageCode&&!safeCode.test(input.safeMessageCode))||
    (input.providerStatus!==undefined&&(!Number.isInteger(input.providerStatus)||input.providerStatus<100||input.providerStatus>599))||
    (input.retryCount!==undefined&&(!Number.isInteger(input.retryCount)||input.retryCount<0)))throw new Error('Invalid structured error');
  const diagnostic=errorDiagnostic({...input,providerErrorType:input.providerErrorType,recoveryStatus:input.recoveryStatus});
  return transaction(pool,async client=>{
    if(input.jobId){
      const job=await client.query('SELECT r.project_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE j.id=$1 AND j.owner_user_id=$2',[input.jobId,input.owner]);
      if(!job.rowCount|| (input.projectId&&input.projectId!==job.rows[0].project_id))throw missing();
    }
    const id=uid();
    await client.query('INSERT INTO bb_observability_errors(id,owner_user_id,project_id,job_id,attempt_id,trace_id,code,category,stage,provider_status,retry_count,fingerprint,safe_message_code,recovery_status,provider_error_type,safe_message,safe_stack) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[id,input.owner,input.projectId??null,input.jobId??null,input.attemptId??null,input.traceId,input.code,input.category,input.stage??null,input.providerStatus??null,input.retryCount??0,diagnostic.fingerprint,input.safeMessageCode??null,input.recoveryStatus??'not_retried',input.providerErrorType??null,diagnostic.safeMessage,diagnostic.safeStack]);
    await emitInternal(client,internalEvent({kind:'error.recorded',owner:input.owner,projectId:input.projectId,jobId:input.jobId,traceId:input.traceId,error:{error_id:id,code:input.code,category:input.category,retryable:false}}));
    return id;
  });
}
export async function claimOutbox(pool:Pool,limit=100,leaseSeconds=30) {
  if(!Number.isInteger(limit)||limit<1||limit>1000||!Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>3600)throw new Error('Invalid outbox lease');
  return transaction(pool,async client=>{
    const q=await client.query(`SELECT id FROM bb_outbox WHERE delivered_at IS NULL AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1`,[limit]);
    const result=[];
    for(const row of q.rows){const token=uid();const r=await client.query("UPDATE bb_outbox SET lease_token=$2,lease_until=now()+($3::integer*interval '1 second'),delivery_attempts=delivery_attempts+1 WHERE id=$1 RETURNING id,owner_user_id,event_type,payload,delivery_attempts",[row.id,token,leaseSeconds]);result.push({...r.rows[0],lease_token:token});}
    return result;
  });
}
export async function ackOutbox(pool:Pool,id:string,token:string) {
  const q=await pool.query('UPDATE bb_outbox SET delivered_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND delivered_at IS NULL RETURNING id',[id,token]);
  return !!q.rowCount;
}
export type TimelineFilter={actorId:string;owner:string;projectId?:string;jobId?:string;traceId?:string;from?:Date;to?:Date;status?:string;errorCode?:string};
export async function queryTimeline(pool:Pool,filter:TimelineFilter) {
  // Internal caller must supply a trusted owner; no HTTP route exposes this function.
  if(!validId(filter.actorId)||!validId(filter.owner))throw new Error('Trusted actor and owner required');
  return transaction(pool,async client=>{
  await client.query('INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash) VALUES($1,$2,$3,$4,$5)',[uid(),filter.actorId,filter.owner,'timeline',digest(JSON.stringify({projectId:filter.projectId,jobId:filter.jobId,traceId:filter.traceId,from:filter.from,to:filter.to,status:filter.status,errorCode:filter.errorCode}))]);
  const q=await client.query(`SELECT e.id,e.kind,e.trace_id,e.job_id,e.run_id,e.created_at,e.event FROM bb_observability_events e WHERE e.owner_user_id=$1 AND ($2::text IS NULL OR e.project_id=$2) AND ($3::text IS NULL OR e.job_id=$3) AND ($4::text IS NULL OR e.trace_id=$4) AND ($5::timestamptz IS NULL OR e.created_at>=$5) AND ($6::timestamptz IS NULL OR e.created_at<=$6) AND ($7::text IS NULL OR e.event->>'status'=$7) AND ($8::text IS NULL OR e.event->'error'->>'code'=$8) ORDER BY e.created_at,e.id LIMIT 500`,[filter.owner,filter.projectId??null,filter.jobId??null,filter.traceId??null,filter.from??null,filter.to??null,filter.status??null,filter.errorCode??null]);
  return q.rows.map(({event,...row})=>({...row,status:event.status,error:event.error,usage:event.usage,prompt_snapshot_ref:event.prompt_snapshot_ref}));
  });
}
export async function queryUsage(pool:Pool,owner:string,jobId:string,actorId:string) {
  if(!validId(actorId)||!validId(owner))throw new Error('Trusted actor and owner required');
  return transaction(pool,async client=>{
  await client.query('INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash) VALUES($1,$2,$3,$4,$5)',[uid(),actorId,owner,'usage',digest(jobId)]);
  const q=await client.query('SELECT attempt_id,logical_call_id,attempt_no,call_status,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,conflicting_measurements FROM bb_call_usage WHERE owner_user_id=$1 AND job_id=$2 ORDER BY logical_call_id,attempt_no',[owner,jobId]);
  return q.rows;
  });
}
export async function usageTotals(pool:Pool,owner:string,jobId:string,actorId:string) {
  const rows=await queryUsage(pool,owner,jobId,actorId);
  const conflicted=rows.filter(r=>r.usage_status==='conflict').length;
  const sum=(field:'input_tokens'|'output_tokens'|'cached_input_tokens'|'reasoning_tokens')=>conflicted ? null : rows.reduce((n,r)=>n+(r[field]??0),0);
  return {attempts:rows.length,measured_attempts:rows.filter(r=>r.usage_status==='measured').length,unresolved_attempts:rows.filter(r=>r.usage_status!=='measured').length,conflicted_attempts:conflicted,input_tokens:sum('input_tokens'),output_tokens:sum('output_tokens'),cached_input_tokens:sum('cached_input_tokens'),reasoning_tokens:sum('reasoning_tokens')};
}
