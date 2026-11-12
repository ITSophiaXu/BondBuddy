import assert from 'node:assert/strict';

export const MODEL_EVIDENCE_VERSION='release-model-evidence-v1';
// Every retry is included. LEFT JOIN preserves unknown usage/provider/duration;
// neither a missing observation nor preparation work is counted as zero cost.
export const MODEL_EVIDENCE_SQL=`
WITH requested AS (
 SELECT unnest($2::text[]) run_id
 UNION SELECT run_id FROM bb_workpaper_attempts WHERE owner_user_id=$1 AND batch_id=$3
 UNION SELECT $4::text WHERE $4::text IS NOT NULL
), scoped AS (
 SELECT run_id FROM requested
 UNION SELECT q.manifest->>'preparation_id' FROM bb_project_qa_runs q JOIN requested r ON r.run_id=q.run_id
 WHERE q.owner_user_id=$1 AND q.manifest->>'preparation_id' IS NOT NULL
), owned_runs AS (
 SELECT r.id,r.owner_user_id,r.project_id,r.state,r.task_kind,q.operation AS qa_operation,q.manifest->>'preparation_id' AS preparation_id
 FROM bb_runs r JOIN scoped s ON s.run_id=r.id
 LEFT JOIN bb_project_qa_runs q ON q.run_id=r.id AND q.owner_user_id=r.owner_user_id
 WHERE r.owner_user_id=$1
), jobs AS (
 SELECT j.id,j.owner_user_id,j.run_id,j.job_type,j.subtype,j.state
 FROM bb_jobs j JOIN owned_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
)
SELECT jsonb_build_object(
 'owner_id',$1::text,'captured_at',transaction_timestamp(),
 'transaction_read_only',current_setting('transaction_read_only'),
 'transaction_isolation',current_setting('transaction_isolation'),
 'scope_run_ids',COALESCE((SELECT jsonb_agg(run_id ORDER BY run_id) FROM scoped),'[]'),
 'runs',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM owned_runs r),'[]'),
 'jobs',COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM jobs j),'[]'),
 'workpaper_batch',(SELECT jsonb_build_object('id',id,'owner_user_id',owner_user_id) FROM bb_workpaper_batches WHERE owner_user_id=$1 AND id=$3),
 'workpaper_attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('run_id',run_id,'item_id',item_id,'attempt',attempt) ORDER BY item_id,attempt) FROM bb_workpaper_attempts WHERE owner_user_id=$1 AND batch_id=$3),'[]'),
 'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'id',a.id,'owner_user_id',a.owner_user_id,'job_id',a.job_id,'run_id',j.run_id,
   'logical_call_id',a.logical_call_id,'attempt_no',a.attempt_no,'call_status',a.status,'model_id',a.model_id,
   'created_at',a.created_at,'updated_at',a.updated_at,
   'usage_present',u.attempt_id IS NOT NULL,'usage_status',u.usage_status,
   'input_tokens',u.input_tokens::text,'output_tokens',u.output_tokens::text,
   'cached_input_tokens',u.cached_input_tokens::text,'reasoning_tokens',u.reasoning_tokens::text,
   'conflicting_measurements',u.conflicting_measurements,
   'runtime_id',rt.id,'runtime_run_id',rt.run_id,'runtime_job_id',rt.job_id,'model_provider',rt.model_provider,
   'adapter',rt.adapter,'adapter_version',rt.adapter_version,'model_config_version',rt.model_config_version,
   'started_at',rt.started_at,'duration_ms',rt.duration_ms,'finish_reason',rt.finish_reason,
   'exit_code',rt.exit_code,'error_code',rt.error_code,'recorded_at',rt.recorded_at
  ) ORDER BY a.created_at,a.id) FROM bb_model_call_attempts a
  JOIN jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id
  LEFT JOIN bb_call_usage u ON u.attempt_id=a.id AND u.owner_user_id=a.owner_user_id AND u.job_id=a.job_id
  LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id AND rt.owner_user_id=a.owner_user_id),'[]')
) AS evidence`;

const id=(value,name)=>{assert.equal(typeof value,'string',name+' missing');assert.ok(value.trim()&&value.length<=128,name+' invalid');return value;};
const token=(value,name)=>{if(value===null)return null;assert.ok(typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value),name+' must preserve decimal precision');return value;};
const nullableText=value=>{assert.ok(value===null||typeof value==='string');return value;};
const unique=(values,name)=>{assert.equal(new Set(values).size,values.length,'Duplicate '+name);return values;};
const same=(left,right,name)=>assert.deepEqual([...left].sort(),[...right].sort(),name+' mismatch');

export function summarizeModelAttempts(attempts){
 const aggregate=field=>{const values=attempts.map(a=>a.usage[field]);return {known:values.reduce((sum,v)=>sum+(v===null?0n:BigInt(v)),0n).toString(),unknownAttempts:values.filter(v=>v===null).length,total:values.every(v=>v!==null)?values.reduce((sum,v)=>sum+BigInt(v),0n).toString():null};};
 const durations=attempts.map(a=>a.durationMs);
 return {attempts:attempts.length,confirmedNotSent:attempts.filter(a=>a.callStatus==='confirmed_not_sent').length,
  usageStatuses:Object.fromEntries(['measured','pending','unknown','conflict'].map(status=>[status,attempts.filter(a=>a.usage.status===status).length])),
  inputTokens:aggregate('inputTokens'),outputTokens:aggregate('outputTokens'),cachedInputTokens:aggregate('cachedInputTokens'),reasoningTokens:aggregate('reasoningTokens'),
  durationMs:{known:durations.reduce((sum,v)=>sum+(v??0),0),unknownAttempts:durations.filter(v=>v===null).length,total:durations.every(v=>v!==null)?durations.reduce((a,b)=>a+b,0):null}};
}

export function validateModelEvidence(db,{ownerId,runIds=[],workpaperBatchId=null,preparationId=null}){
 assert.equal(db?.owner_id,ownerId);assert.equal(db.transaction_read_only,'on');assert.equal(db.transaction_isolation,'repeatable read');
 for(const name of ['scope_run_ids','runs','jobs','workpaper_attempts','attempts'])assert.ok(Array.isArray(db[name]),name+' missing');
 unique(db.scope_run_ids,'scope run');unique(db.runs.map(r=>r.id),'run');unique(db.jobs.map(j=>j.id),'job');unique(db.attempts.map(a=>a.id),'attempt');
 same(db.runs.map(r=>r.id),db.scope_run_ids,'Owned run scope');
 for(const runId of [...runIds,...(preparationId?[preparationId]:[]),...db.workpaper_attempts.map(a=>a.run_id)])assert.ok(db.scope_run_ids.includes(runId),'Requested run missing');
 const original=[...new Set([...runIds,...(preparationId?[preparationId]:[]),...db.workpaper_attempts.map(a=>a.run_id)])];
 const expected=[...new Set([...original,...db.runs.filter(r=>original.includes(r.id)&&r.preparation_id).map(r=>r.preparation_id)])];same(db.scope_run_ids,expected,'Requested model scope');
 if(workpaperBatchId){assert.equal(db.workpaper_batch?.id,workpaperBatchId);assert.equal(db.workpaper_batch.owner_user_id,ownerId);}else assert.equal(db.workpaper_batch,null);
 for(const r of db.runs){id(r.id,'run');assert.equal(r.owner_user_id,ownerId);if(preparationId===r.id)assert.equal(r.qa_operation,'prepare','Preparation ID is not a QA preparation');}
 for(const j of db.jobs){assert.equal(j.owner_user_id,ownerId);assert.ok(db.scope_run_ids.includes(j.run_id));}
 for(const runId of db.scope_run_ids)assert.ok(db.jobs.some(j=>j.run_id===runId),'Run job evidence missing');
 const attempts=db.attempts.map(a=>{
  id(a.id,'attempt');assert.equal(a.owner_user_id,ownerId);const job=db.jobs.find(j=>j.id===a.job_id);assert.ok(job);assert.equal(a.run_id,job.run_id);assert.ok(Number.isSafeInteger(a.attempt_no)&&a.attempt_no>0);
  const runtime=a.runtime_id!==null;if(runtime){id(a.runtime_id,'runtime');assert.equal(a.runtime_run_id,a.run_id);assert.equal(a.runtime_job_id,a.job_id);}
  const status=a.usage_present?a.usage_status:'unknown';assert.ok(['measured','pending','unknown','conflict'].includes(status));
  const dimensions=['input_tokens','output_tokens','cached_input_tokens','reasoning_tokens'].map(key=>token(a[key],key));
  if(status!=='measured')for(const v of dimensions)assert.equal(v,null,'Unmeasured usage must remain unknown');
  const durationMs=runtime?a.duration_ms:null;assert.ok(durationMs===null||Number.isSafeInteger(durationMs)&&durationMs>=0);
  return {attemptId:a.id,jobId:a.job_id,runId:a.run_id,scope:db.runs.find(r=>r.id===a.run_id).qa_operation==='prepare'?'preparation':'execution',logicalCallId:a.logical_call_id,attemptNo:a.attempt_no,callStatus:a.call_status,
   model:nullableText(a.model_id),provider:runtime?nullableText(a.model_provider):null,adapter:runtime?nullableText(a.adapter):null,modelConfigVersion:runtime?nullableText(a.model_config_version):null,
   usage:{source:'bb_call_usage',present:a.usage_present,status,inputTokens:dimensions[0],outputTokens:dimensions[1],cachedInputTokens:dimensions[2],reasoningTokens:dimensions[3],conflictingMeasurements:a.conflicting_measurements},
   durationMs,startedAt:runtime?a.started_at:null,runtimeId:a.runtime_id,createdAt:a.created_at,finishReason:a.finish_reason,errorCode:a.error_code};
 });
 return {version:MODEL_EVIDENCE_VERSION,capturedAt:db.captured_at,ownerId,scopeRunIds:db.scope_run_ids,attempts,
  summary:summarizeModelAttempts(attempts),preparation:summarizeModelAttempts(attempts.filter(a=>a.scope==='preparation')),execution:summarizeModelAttempts(attempts.filter(a=>a.scope==='execution')),
  missingRuntime:attempts.filter(a=>a.runtimeId===null).map(a=>a.attemptId),raw:db};
}

export async function readModelEvidence({execReadOnly,ownerId,runIds=[],workpaperBatchId=null,preparationId=null}){
 id(ownerId,'ownerId');assert.equal(typeof execReadOnly,'function');assert.ok(Array.isArray(runIds));unique(runIds,'requested run');for(const r of runIds)id(r,'runId');if(workpaperBatchId)id(workpaperBatchId,'batchId');if(preparationId)id(preparationId,'preparationId');assert.ok(runIds.length||workpaperBatchId||preparationId,'Empty model evidence scope');
 const result=await execReadOnly({text:MODEL_EVIDENCE_SQL,values:[ownerId,runIds,workpaperBatchId,preparationId],transaction:{isolation:'repeatable read',readOnly:true}});
 assert.equal(result.rows?.length,1,'Expected one model evidence snapshot');return validateModelEvidence(result.rows[0].evidence,{ownerId,runIds,workpaperBatchId,preparationId});
}
