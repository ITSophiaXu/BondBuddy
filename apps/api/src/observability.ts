import { Value } from '@sinclair/typebox/value';
import { schemas, ERROR_CODES, ERROR_CATEGORIES, type InternalObservabilityEvent } from '@bondbuddy/contracts';
import { Pool, type PoolClient } from 'pg';
import { digest, missing, transaction, uid, type PrivateBlobs } from './data.js';

const safeCode=/^[a-z][a-z0-9_]{0,63}$/;
const validId=(value:string)=>/^[A-Za-z0-9_-]{1,128}$/.test(value);
export async function emitInternal(client:PoolClient,event:InternalObservabilityEvent) {
  if(!Value.Check(schemas.InternalObservabilityEvent,event))throw new Error('Invalid internal observability event');
  const {event_id,user_id,project_id,job_id,run_id,trace_id,kind}=event;
  if(!user_id)throw new Error('Owned event required');
  await client.query('INSERT INTO bb_observability_events(id,owner_user_id,project_id,job_id,run_id,trace_id,kind,event) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[event_id,user_id,project_id,job_id,run_id,trace_id,kind,event]);
  await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user_id,'observability',event_id,kind,{event_id,schema_version:1}]);
}
export function internalEvent(input:{kind:InternalObservabilityEvent['kind'];owner:string;projectId?:string|null;runId?:string|null;jobId?:string|null;traceId:string;operationId?:string;requestId?:string;status?:InternalObservabilityEvent['status'];stage?:string|null;error?:InternalObservabilityEvent['error'];usage?:InternalObservabilityEvent['usage'];logicalCallId?:string|null;attemptNo?:number|null;promptSnapshotRef?:string|null}):InternalObservabilityEvent {
  if(input.stage&&!safeCode.test(input.stage))throw new Error('Unsafe event stage');
  return {event_id:uid(),schema_version:1,kind:input.kind,occurred_at:new Date().toISOString(),operation_id:input.operationId??input.runId??uid(),request_id:input.requestId??uid(),trace_id:input.traceId,span_id:uid(),parent_span_id:null,actor_type:'system',user_id:input.owner,project_id:input.projectId??null,conversation_id:null,message_id:null,job_id:input.jobId??null,parent_job_id:null,run_id:input.runId??null,work_item_id:null,logical_call_id:input.logicalCallId??null,call_id:null,attempt_no:input.attemptNo??null,job_kind:null,stage:input.stage??null,status:input.status??null,prompt_snapshot_ref:input.promptSnapshotRef??null,error:input.error??null,usage:input.usage??null};
}
export async function recordOperation(client:PoolClient,input:{owner:string;projectId?:string|null;runId?:string|null;requestId:string;traceId:string;kind:string;status:'submitted'|'rejected';errorCode?:string;inputRevision?:number;inputHash?:string}) {
  if(!validId(input.requestId)||!validId(input.traceId)||!safeCode.test(input.kind))throw new Error('Invalid operation identifiers');
  if(input.errorCode&&!ERROR_CODES.includes(input.errorCode as typeof ERROR_CODES[number]))throw new Error('Invalid error code');
  if(input.runId){const r=await client.query('SELECT 1 FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3',[input.runId,input.owner,input.projectId]);if(!r.rowCount)throw missing();}
  const id=uid();
  await client.query('INSERT INTO bb_operations(id,owner_user_id,project_id,run_id,request_id,trace_id,operation_kind,status,error_code,input_revision,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,input.owner,input.projectId??null,input.runId??null,input.requestId,input.traceId,input.kind,input.status,input.errorCode??null,input.inputRevision??null,input.inputHash??null]);
  await emitInternal(client,internalEvent({kind:input.status==='rejected'?'operation.rejected':'operation.submitted',owner:input.owner,projectId:input.projectId,runId:input.runId,traceId:input.traceId,operationId:id,requestId:input.requestId,status:input.status==='rejected'?'rejected':'created',error:input.errorCode?{error_id:uid(),code:input.errorCode as typeof ERROR_CODES[number],category:'validation',retryable:false}:undefined}));
  return id;
}
export async function rejectOperation(pool:Pool,input:Parameters<typeof recordOperation>[1]) {
  await transaction(pool,client=>recordOperation(client,{...input,status:'rejected'}));
}
export async function saveSnapshotRef(pool:Pool,input:{owner:string;projectId:string;runId?:string;kind:'user_prompt'|'model_request'|'structured_input';version:number;objectKey:string;sha256:string;redactionVersion:string;inputRevision?:number;inputHash?:string;templateVersion?:string;rulePackVersion?:string;modelParametersVersion?:string;blobs:PrivateBlobs}) {
  if(!input.objectKey.startsWith(`users/${input.owner}/projects/${input.projectId}/snapshots/`)||!/^[A-Za-z0-9_-]{1,128}$/.test(input.objectKey.slice(`users/${input.owner}/projects/${input.projectId}/snapshots/`.length))||!/^[a-f0-9]{64}$/.test(input.sha256)||!safeCode.test(input.redactionVersion))throw new Error('Invalid private snapshot metadata');
  const bytes=await input.blobs.get(input.objectKey);
  if(digest(bytes)!==input.sha256)throw new Error('Snapshot hash mismatch');
  return transaction(pool,async client=>{
    if(input.inputRevision){const rev=await client.query('SELECT 1 FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4',[input.owner,input.projectId,input.inputRevision,input.inputHash]);if(!rev.rowCount)throw missing();}
    if(input.runId){const run=await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND ($4::integer IS NULL OR input_revision=$4)',[input.owner,input.projectId,input.runId,input.inputRevision??null]);if(!run.rowCount)throw missing();}
    const id=uid();
    await client.query('INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash,template_version,rule_pack_version,model_parameters_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[id,input.owner,input.projectId,input.runId??null,input.kind,input.version,input.objectKey,input.sha256,input.redactionVersion,input.inputRevision??null,input.inputHash??null,input.templateVersion??null,input.rulePackVersion??null,input.modelParametersVersion??null]);
    await emitInternal(client,internalEvent({kind:'prompt.snapshot_saved',owner:input.owner,projectId:input.projectId,runId:input.runId,traceId:input.runId??id,promptSnapshotRef:id}));
    return id;
  });
}
export type UsageInput={owner:string;attemptId:string;source:'provider'|'gateway'|'framework'|'reconciliation';sourceEventId:string;status:'unknown'|'pending'|'measured';inputTokens?:number;outputTokens?:number;cachedInputTokens?:number;reasoningTokens?:number;evidenceRef?:string};
export async function observeUsage(pool:Pool,input:UsageInput) {
  if(!validId(input.sourceEventId)|| (input.evidenceRef&&!validId(input.evidenceRef)))throw new Error('Invalid usage reference');
  return transaction(pool,async client=>{
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
  });
}
export async function recordStructuredError(pool:Pool,input:{owner:string;projectId?:string;jobId?:string;attemptId?:string;traceId:string;code:typeof ERROR_CODES[number];category:typeof ERROR_CATEGORIES[number];stage?:string;providerStatus?:number;retryCount?:number;fingerprint?:string;safeMessageCode?:string;recoveryStatus?:string}) {
  if(!ERROR_CODES.includes(input.code)||!ERROR_CATEGORIES.includes(input.category)||!validId(input.traceId)|| (input.fingerprint&&!/^[a-f0-9]{64}$/.test(input.fingerprint))||(input.safeMessageCode&&!safeCode.test(input.safeMessageCode))||(input.stage&&!safeCode.test(input.stage))||(input.recoveryStatus&&!safeCode.test(input.recoveryStatus)))throw new Error('Invalid structured error');
  return transaction(pool,async client=>{
    if(input.jobId){
      const job=await client.query('SELECT r.project_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE j.id=$1 AND j.owner_user_id=$2',[input.jobId,input.owner]);
      if(!job.rowCount|| (input.projectId&&input.projectId!==job.rows[0].project_id))throw missing();
    }
    const id=uid();
    await client.query('INSERT INTO bb_observability_errors(id,owner_user_id,project_id,job_id,attempt_id,trace_id,code,category,stage,provider_status,retry_count,fingerprint,safe_message_code,recovery_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[id,input.owner,input.projectId??null,input.jobId??null,input.attemptId??null,input.traceId,input.code,input.category,input.stage??null,input.providerStatus??null,input.retryCount??0,input.fingerprint??null,input.safeMessageCode??null,input.recoveryStatus??null]);
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
  return {attempts:rows.length,measured_attempts:rows.filter(r=>r.usage_status==='measured').length,unresolved_attempts:rows.filter(r=>r.usage_status!=='measured').length,input_tokens:rows.reduce((n,r)=>n+(r.input_tokens??0),0),output_tokens:rows.reduce((n,r)=>n+(r.output_tokens??0),0),cached_input_tokens:rows.reduce((n,r)=>n+(r.cached_input_tokens??0),0),reasoning_tokens:rows.reduce((n,r)=>n+(r.reasoning_tokens??0),0)};
}
