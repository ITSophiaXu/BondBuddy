import { Pool, type PoolClient } from 'pg';
import { date, missing, Problem, run, runDto, transaction, uid, type PrivateBlobs, digest } from './data.js';
import { emitInternal, internalEvent } from './observability.js';
import { ERROR_CODES, RUN_PAUSE_STAGES, type ERROR_CATEGORIES, type ErrorCode } from '@bondbuddy/contracts';
import { assertGateOpen, ensureExternalCallsAllowed, guardEvidenceWrite } from './evidence-gate.js';
import { assertModelCallAllowed, reportTrialRejection, trialGuardConfig } from './trial-guard.js';
import { DOCX_LIMITS, inspectDocx, WORD_DELIVERY_VALIDATOR_VERSION, WORD_MEDIA_TYPE, type DocxInspection } from './docx-inspector.js';

const terminal = new Set(['succeeded','failed','cancelled','rejected']);
export type Lease = { jobId:string; runId:string; owner:string; token:string; checkpoint:Record<string,unknown>; attempts:number };

async function event(client:PoolClient, r:any, state:string, stage:string|null, reason:string, errorCode?:string, type='run.state_changed') {
  const seq=r.event_cursor+1, id=uid(), trace=r.id;
  const payload={reason,...(errorCode?{error_code:errorCode}:{})};
  await client.query('UPDATE bb_runs SET state=$2,stage=$3,event_cursor=$4,updated_at=now() WHERE id=$1',[r.id,state,stage,seq]);
  await client.query('INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,r.owner_user_id,r.id,seq,trace,type,state,stage,payload]);
  await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),r.owner_user_id,'run',r.id,type,{run_id:r.id,event_id:id,seq,state,stage,reason,...(errorCode?{error_code:errorCode}:{})}]);
  const job=await client.query('SELECT id FROM bb_jobs WHERE run_id=$1',[r.id]);
  await emitInternal(client,internalEvent({kind:'job.state_changed',owner:r.owner_user_id,projectId:r.project_id,runId:r.id,jobId:job.rows[0]?.id,traceId:trace,status:state as any,stage}));
  r.state=state;r.stage=stage;r.event_cursor=seq;
}

async function providerCallNeedsReconciliation(client:PoolClient, jobId:string) {
  const q=await client.query(`SELECT 1
    FROM bb_model_call_attempts a
    LEFT JOIN bb_call_usage u ON u.attempt_id=a.id
    WHERE a.job_id=$1 AND (
      a.status IN ('pending_reconcile','failed')
      OR (a.status='completed' AND (
        COALESCE(u.usage_status,'unknown')<>'measured'
        OR COALESCE(u.conflicting_measurements,0)>0
        OR (SELECT count(*) FROM bb_provider_result_refs p WHERE p.attempt_id=a.id)<>1
        OR NOT EXISTS (
          SELECT 1 FROM bb_provider_call_observations o
          JOIN bb_provider_result_refs p ON p.id=o.result_id AND p.attempt_id=o.attempt_id
          WHERE o.attempt_id=a.id AND o.outcome='completed' AND o.usage_status='measured'
        )
      ))
    ) LIMIT 1`,[jobId]);
  return !!q.rowCount;
}

export async function enqueue(client:PoolClient, r:any, subtype='default') {
  await client.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,$4,$5,'queued','queued')",[uid(),r.owner_user_id,r.id,r.task_kind,subtype]);
  await event(client,{...r,event_cursor:0},'queued','queued','submitted');
}

// Run jobs and #79/#16 platform probes share the lease model but are claimed separately, so the
// run pipeline never picks up a probe and the probe worker never picks up a user run.
export async function claim(pool:Pool, leaseSeconds=30, options:{platformProbe?:boolean}={}):Promise<Lease|null> {
  return transaction(pool,async client=>{
    // Lock order is run then job in every transition, including cancellation.
    const q=await client.query("SELECT r.* FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE (j.state='queued' OR (j.state='running' AND j.lease_until<now())) AND r.state NOT IN ('cancelled','failed','succeeded','rejected') AND (j.job_type='platform_probe')=$1 ORDER BY j.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1",[options.platformProbe===true]);
    const r=q.rows[0];if(!r)return null;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[r.id])).rows[0];
    if(j.state==='running' && new Date(j.lease_until).getTime()>=Date.now())return null;
    if(await providerCallNeedsReconciliation(client,j.id)){
      await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await event(client,r,'paused','provider_reconcile','provider_reconciliation_required');
      return null;
    }
    const token=uid();
    await client.query("UPDATE bb_jobs SET state='running',stage=COALESCE(stage,'claimed'),lease_token=$2,lease_until=now()+($3::integer * interval '1 second'),attempts=attempts+1,updated_at=now() WHERE id=$1",[j.id,token,leaseSeconds]);
    await event(client,r,'running',j.stage ?? 'claimed',j.state==='running'?'lease_recovered':'claimed');
    return {jobId:j.id,runId:r.id,owner:r.owner_user_id,token,checkpoint:j.checkpoint,attempts:j.attempts+1};
  });
}

async function lockedLease(client:PoolClient, lease:Lease) {
  const r=await run(client,lease.owner,lease.runId,true);
  const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 FOR UPDATE',[lease.jobId,lease.owner,lease.runId])).rows[0];
  if(!j || j.lease_token!==lease.token || j.state!=='running' || new Date(j.lease_until).getTime()<=Date.now() || terminal.has(r.state)) throw new Problem(409,'ALREADY_TERMINAL','Lease is no longer active');
  return {r,j};
}

export async function renew(pool:Pool, lease:Lease, leaseSeconds=30) {
  await transaction(pool,async client=>{await lockedLease(client,lease);await client.query("UPDATE bb_jobs SET lease_until=now()+($2::integer * interval '1 second'),updated_at=now() WHERE id=$1",[lease.jobId,leaseSeconds]);});
}

export async function checkpoint(pool:Pool, lease:Lease, stage:string, value:Record<string,unknown>) {
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    await client.query('UPDATE bb_jobs SET checkpoint=$2,stage=$3,updated_at=now() WHERE id=$1',[lease.jobId,value,stage]);
    await event(client,r,'running',stage,'checkpoint_saved',undefined,'run.progress');
  });
}

// Persist intent before any supplier request. An unknown attempt is never silently resent.
export async function recordPotentialCall(pool:Pool, lease:Lease, logicalCallId:string, attemptNo:number, metadata:{callId?:string;modelId?:string;promptSnapshotId?:string}={}) {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(logicalCallId)||!Number.isSafeInteger(attemptNo)||attemptNo<1)throw new Problem(422,'VALIDATION_FAILED','Invalid provider call identity');
  const attemptId=metadata.callId??uid();
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId))throw new Problem(422,'VALIDATION_FAILED','Invalid provider call identity');
  // #79: no durable intent, no call. An evidence outage pauses every NEW external call.
  await ensureExternalCallsAllowed(pool);
  await guardEvidenceWrite(pool,'call_intent_not_persisted',()=>transaction(pool,async client=>{
    await assertGateOpen(client);
    const {r}=await lockedLease(client,lease);
    // #35: kill switch, deny override and the daily token quota are re-checked before every call.
    await assertModelCallAllowed(client,trialGuardConfig(),lease.owner);
    if(metadata.promptSnapshotId){
      const ref=await client.query('SELECT 1 FROM bb_snapshot_refs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND run_id=$4',[metadata.promptSnapshotId,lease.owner,r.project_id,r.id]);
      if(!ref.rowCount)throw missing();
    }
    const sequence=await client.query('SELECT COALESCE(max(attempt_no),0)::int AS last_attempt FROM bb_model_call_attempts WHERE job_id=$1 AND logical_call_id=$2',[lease.jobId,logicalCallId]);
    if(attemptNo!==Number(sequence.rows[0].last_attempt)+1)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider attempt numbers must increase monotonically');
    await client.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,prompt_snapshot_id) VALUES($1,$2,$3,$4,$5,'pending_reconcile',$6,$7)",[attemptId,lease.owner,lease.jobId,logicalCallId,attemptNo,metadata.modelId??null,metadata.promptSnapshotId??null]);
    await emitInternal(client,internalEvent({kind:'model.call_started',owner:lease.owner,projectId:r.project_id,runId:r.id,jobId:lease.jobId,traceId:r.id,logicalCallId,attemptNo,promptSnapshotRef:metadata.promptSnapshotId}));
    await event(client,r,'running','provider_call','provider_call_may_be_sent');
  })).catch(async error=>{await reportTrialRejection(pool,error,lease.owner);throw error;});
  return attemptId;
}

export async function resolvePotentialCall(pool:Pool, lease:Lease, logicalCallId:string, attemptNo:number, status:'confirmed_not_sent'|'completed'|'failed', providerRequestId?:string) {
  if(status!=='confirmed_not_sent')throw new Problem(409,'CAPABILITY_NOT_READY','Completed or failed supplier calls need a durable result before reconciliation');
  if(providerRequestId)throw new Problem(409,'IDEMPOTENCY_CONFLICT','A confirmed not-sent attempt cannot have a provider request ID');
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    const q=await client.query("UPDATE bb_model_call_attempts SET status=$5,provider_request_id=$6,updated_at=now() WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4 AND status='pending_reconcile' RETURNING id",[lease.owner,lease.jobId,logicalCallId,attemptNo,status,providerRequestId??null]);
    if(!q.rowCount)throw missing();
    await event(client,r,'running','provider_call','provider_call_reconciled');
  });
}

// Trusted provider adapter calls this only after checking the actual supplier request.
// It cannot be invoked through the public API or by a client-supplied claim.
export async function reconcilePausedCall(pool:Pool, owner:string, runId:string, logicalCallId:string, attemptNo:number, status:'confirmed_not_sent'|'completed'|'failed', providerRequestId?:string) {
  if(status!=='confirmed_not_sent')throw new Problem(409,'CAPABILITY_NOT_READY','Completed or failed supplier calls need a durable result before reconciliation');
  if(providerRequestId)throw new Problem(409,'IDEMPOTENCY_CONFLICT','A confirmed not-sent attempt cannot have a provider request ID');
  await transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j || r.state!=='paused' || j.state!=='paused')throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not awaiting reconciliation');
    const q=await client.query("UPDATE bb_model_call_attempts SET status=$5,provider_request_id=$6,updated_at=now() WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4 AND status='pending_reconcile' RETURNING id",[owner,j.id,logicalCallId,attemptNo,status,providerRequestId??null]);
    if(!q.rowCount)throw missing();
    await event(client,r,'paused','provider_reconcile','provider_call_reconciled');
  });
}

export async function action(pool:Pool,owner:string,runId:string,kind:'cancel'|'resume') {
  return transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j)throw missing();
    if(terminal.has(r.state))throw new Problem(409,'ALREADY_TERMINAL','Run already finished');
    if(kind==='resume'){
      if(r.state!=='paused')throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not paused');
      if(await providerCallNeedsReconciliation(client,j.id))throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs a durable result and verified usage before resume');
    }
    await client.query('UPDATE bb_jobs SET state=$2,stage=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[j.id,kind==='cancel'?'cancelled':'queued',kind==='cancel'?'cancelled':'queued']);
    await event(client,r,kind==='cancel'?'cancelled':'queued',kind==='cancel'?'cancelled':'queued',kind==='cancel'?'user_cancelled':'user_resumed');
    return runDto({...r,updated_at:new Date()});
  });
}

type WordDeliveryCode='not_attempted'|'readback_verified'|'blob_write_failed'|'blob_missing'|'blob_too_large'|'blob_read_failed'|'blob_hash_mismatch';
export type WordPromotionResult={
  status:'available'|'rejected'|'unavailable';
  artifactId:string;
  artifactVersion:number;
  objectKey:string;
  evidenceId:string;
  sha256:string;
  byteSize:number;
  deliveryCode:WordDeliveryCode;
  failureCode?:'WORD_QUALITY_REJECTED'|'WORD_DELIVERY_UNAVAILABLE';
  inspection:DocxInspection;
};

async function recordWordEvidence(client:PoolClient,lease:Lease,artifactId:string,artifactVersion:number,inspection:DocxInspection,qualityStatus:'passed'|'failed',deliveryStatus:'not_attempted'|'unavailable'|'available',deliveryCode:WordDeliveryCode,readback?:{sha256:string;byteSize:number}) {
  const q=await client.query(`INSERT INTO bb_word_delivery_evidence
    (id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size) DO NOTHING
    RETURNING id`,[uid(),lease.owner,lease.runId,artifactId,artifactVersion,inspection.sha256,inspection.byte_size,inspection.validator_version,qualityStatus,deliveryStatus,deliveryCode,readback?.sha256??null,readback?.byteSize??null,inspection]);
  if(q.rows[0])return q.rows[0].id as string;
  const existing=await client.query(`SELECT id FROM bb_word_delivery_evidence
    WHERE owner_user_id=$1 AND run_id=$2 AND artifact_id=$3 AND artifact_version=$4 AND candidate_sha256=$5
      AND validator_version=$6 AND quality_status=$7 AND delivery_status=$8 AND delivery_code=$9
      AND readback_sha256 IS NOT DISTINCT FROM $10 AND readback_byte_size IS NOT DISTINCT FROM $11`,
  [lease.owner,lease.runId,artifactId,artifactVersion,inspection.sha256,inspection.validator_version,qualityStatus,deliveryStatus,deliveryCode,readback?.sha256??null,readback?.byteSize??null]);
  if(!existing.rows[0])throw new Problem(409,'IDEMPOTENCY_CONFLICT','Word delivery evidence identity conflicted');
  return existing.rows[0].id as string;
}

function wordArtifactIdentity(lease:Lease,inspection:DocxInspection) {
  const artifactId=`word-${digest(`${lease.owner}\n${lease.runId}\n${inspection.validator_version}\n${inspection.sha256}`)}`;
  const objectKey=`users/${lease.owner}/runs/${lease.runId}/artifacts/${artifactId}/v1.docx`;
  return {artifactId,artifactVersion:1,objectKey};
}

async function ensureWordArtifact(client:PoolClient,lease:Lease,inspection:DocxInspection,identity:ReturnType<typeof wordArtifactIdentity>) {
  const q=await client.query('SELECT * FROM bb_artifact_versions WHERE id=$1 AND version=$2 FOR UPDATE',[identity.artifactId,identity.artifactVersion]);
  const artifact=q.rows[0];
  if(!artifact || artifact.owner_user_id!==lease.owner || artifact.run_id!==lease.runId || artifact.media_type!==WORD_MEDIA_TYPE || artifact.sha256.trim()!==inspection.sha256 || artifact.object_key!==identity.objectKey)
    throw new Problem(409,'IDEMPOTENCY_CONFLICT','Word artifact identity changed');
  return artifact;
}

async function persistRejectedWord(pool:Pool,lease:Lease,inspection:DocxInspection,identity:ReturnType<typeof wordArtifactIdentity>):Promise<WordPromotionResult> {
  const evidenceId=await transaction(pool,async client=>{
    await assertLockedWordLease(client,lease);
    const id=await recordWordEvidence(client,lease,identity.artifactId,identity.artifactVersion,inspection,'failed','not_attempted','not_attempted');
    await client.query(`INSERT INTO bb_artifact_versions
      (id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'failed','revoked',$8) ON CONFLICT(id,version) DO NOTHING`,
    [identity.artifactId,identity.artifactVersion,lease.owner,lease.runId,WORD_MEDIA_TYPE,inspection.sha256,identity.objectKey,id]);
    const artifact=await ensureWordArtifact(client,lease,inspection,identity);
    if(artifact.quality_status!=='failed' || artifact.delivery_status!=='revoked')throw new Problem(409,'IDEMPOTENCY_CONFLICT','Rejected Word artifact changed');
    await client.query('UPDATE bb_artifact_versions SET word_delivery_evidence_id=$3 WHERE id=$1 AND version=$2',[identity.artifactId,identity.artifactVersion,id]);
    return id;
  });
  return {status:'rejected',...identity,evidenceId,sha256:inspection.sha256,byteSize:inspection.byte_size,deliveryCode:'not_attempted',failureCode:'WORD_QUALITY_REJECTED',inspection};
}

async function assertLockedWordLease(client:PoolClient,lease:Lease) {
  const {r}=await lockedLease(client,lease);
  if(await providerCallNeedsReconciliation(client,lease.jobId))throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs reconciliation');
  return r;
}

async function persistUnavailableWord(pool:Pool,lease:Lease,inspection:DocxInspection,identity:ReturnType<typeof wordArtifactIdentity>,deliveryCode:Exclude<WordDeliveryCode,'not_attempted'|'readback_verified'>,readback?:{sha256:string;byteSize:number}):Promise<WordPromotionResult> {
  const evidenceId=await transaction(pool,async client=>{
    await assertLockedWordLease(client,lease);
    const artifact=await ensureWordArtifact(client,lease,inspection,identity);
    if(artifact.quality_status!=='passed')throw new Problem(409,'IDEMPOTENCY_CONFLICT','Word artifact quality state changed');
    const id=await recordWordEvidence(client,lease,identity.artifactId,identity.artifactVersion,inspection,'passed','unavailable',deliveryCode,readback);
    await client.query(`UPDATE bb_artifact_versions SET delivery_status='revoked',word_delivery_evidence_id=$3
      WHERE id=$1 AND version=$2 AND owner_user_id=$4 AND run_id=$5`,[identity.artifactId,identity.artifactVersion,id,lease.owner,lease.runId]);
    return id;
  });
  return {status:'unavailable',...identity,evidenceId,sha256:inspection.sha256,byteSize:inspection.byte_size,deliveryCode,failureCode:'WORD_DELIVERY_UNAVAILABLE',inspection};
}

async function persistAvailableWord(pool:Pool,lease:Lease,inspection:DocxInspection,identity:ReturnType<typeof wordArtifactIdentity>):Promise<WordPromotionResult> {
  const evidenceId=await transaction(pool,async client=>{
    await assertLockedWordLease(client,lease);
    const artifact=await ensureWordArtifact(client,lease,inspection,identity);
    if(artifact.quality_status!=='passed')throw new Problem(409,'IDEMPOTENCY_CONFLICT','Word artifact quality state changed');
    const id=await recordWordEvidence(client,lease,identity.artifactId,identity.artifactVersion,inspection,'passed','available','readback_verified',{sha256:inspection.sha256,byteSize:inspection.byte_size});
    await client.query(`UPDATE bb_artifact_versions SET delivery_status='available',word_delivery_evidence_id=$3
      WHERE id=$1 AND version=$2 AND owner_user_id=$4 AND run_id=$5`,[identity.artifactId,identity.artifactVersion,id,lease.owner,lease.runId]);
    return id;
  });
  return {status:'available',...identity,evidenceId,sha256:inspection.sha256,byteSize:inspection.byte_size,deliveryCode:'readback_verified',inspection};
}

// This seam accepts bytes from a trusted processor. It never writes an invalid DOCX and
// marks an artifact available only after a bounded Blob readback matches the candidate.
export async function promoteWordArtifact(pool:Pool,lease:Lease,candidate:Buffer,blobs:PrivateBlobs):Promise<WordPromotionResult> {
  const inspection=inspectDocx(candidate);
  const identity=wordArtifactIdentity(lease,inspection);
  if(inspection.quality_status!=='passed')return persistRejectedWord(pool,lease,inspection,identity);
  await transaction(pool,async client=>{
    await assertLockedWordLease(client,lease);
    await client.query(`INSERT INTO bb_artifact_versions
      (id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'passed','pending') ON CONFLICT(id,version) DO NOTHING`,
    [identity.artifactId,identity.artifactVersion,lease.owner,lease.runId,WORD_MEDIA_TYPE,inspection.sha256,identity.objectKey]);
    const artifact=await ensureWordArtifact(client,lease,inspection,identity);
    if(artifact.quality_status==='failed')throw new Problem(409,'IDEMPOTENCY_CONFLICT','Word artifact has a prior quality rejection');
  });
  try { await blobs.put(identity.objectKey,candidate,WORD_MEDIA_TYPE); }
  catch { return persistUnavailableWord(pool,lease,inspection,identity,'blob_write_failed'); }
  let readback:Buffer|null;
  try { readback=await blobs.getIfExistsBounded(identity.objectKey,DOCX_LIMITS.archiveBytes); }
  catch(error) {
    const code=error instanceof Problem && error.status===413?'blob_too_large':'blob_read_failed';
    return persistUnavailableWord(pool,lease,inspection,identity,code);
  }
  if(!readback)return persistUnavailableWord(pool,lease,inspection,identity,'blob_missing');
  if(readback.length>DOCX_LIMITS.archiveBytes)return persistUnavailableWord(pool,lease,inspection,identity,'blob_too_large');
  const readbackSha256=digest(readback);
  if(readback.length!==inspection.byte_size || readbackSha256!==inspection.sha256)
    return persistUnavailableWord(pool,lease,inspection,identity,'blob_hash_mismatch',{sha256:readbackSha256,byteSize:readback.length});
  return persistAvailableWord(pool,lease,inspection,identity);
}

async function revokeWordArtifactAfterReadbackFailure(pool:Pool,lease:Lease,artifact:any,deliveryCode:'blob_missing'|'blob_too_large'|'blob_read_failed'|'blob_hash_mismatch',readback?:{sha256:string;byteSize:number}) {
  await transaction(pool,async client=>{
    await lockedLease(client,lease);
    const q=await client.query(`SELECT e.validator_version,e.byte_size AS evidence_byte_size,e.quality_evidence
      FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e
        ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.version=$4
        AND a.word_delivery_evidence_id=$5 AND a.sha256=$6
        AND a.quality_status='passed' AND a.delivery_status='available'
        AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
      FOR UPDATE OF a`,[lease.owner,lease.runId,artifact.id,artifact.version,artifact.word_delivery_evidence_id,artifact.sha256]);
    const existing=q.rows[0];
    if(!existing)return;
    const inspection=existing.quality_evidence as DocxInspection;
    if(inspection?.quality_status!=='passed'||inspection.validator_version!==existing.validator_version
      ||inspection.sha256!==artifact.sha256.trim()||inspection.byte_size!==Number(existing.evidence_byte_size))
      throw new Problem(422,'DELIVERY_FAILED','Word artifact quality evidence mismatch');
    const evidenceId=await recordWordEvidence(client,lease,artifact.id,artifact.version,inspection,'passed','unavailable',deliveryCode,readback);
    await client.query(`UPDATE bb_artifact_versions SET delivery_status='revoked',word_delivery_evidence_id=$3
      WHERE id=$1 AND version=$2 AND owner_user_id=$4 AND run_id=$5 AND word_delivery_evidence_id=$6`,
    [artifact.id,artifact.version,evidenceId,lease.owner,lease.runId,artifact.word_delivery_evidence_id]);
  });
}

export async function finish(pool:Pool,lease:Lease,outcome:'failed'|'succeeded',options:{errorCode?:string;artifactId?:string;artifactVersion?:number;blobs?:PrivateBlobs;failedStage?:string}={}) {
  // Verify bytes before the terminal transaction; re-check immutable metadata inside it.
  let artifact:any;
  if(outcome==='succeeded'){
    if(!options.artifactId || !options.artifactVersion || !options.blobs)throw new Problem(422,'DELIVERY_FAILED','Verified Word artifact required');
    const q=await pool.query(`SELECT a.*,e.validator_version,e.byte_size AS evidence_byte_size,e.quality_evidence
      FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e
        ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.version=$4
        AND a.media_type=$5 AND a.quality_status='passed' AND a.delivery_status='available'
        AND e.artifact_id=a.id AND e.artifact_version=a.version AND e.candidate_sha256=a.sha256
        AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
        AND e.readback_sha256=e.candidate_sha256 AND e.readback_byte_size=e.byte_size`,
    [lease.owner,lease.runId,options.artifactId,options.artifactVersion,WORD_MEDIA_TYPE]);
    artifact=q.rows[0];if(!artifact)throw new Problem(422,'DELIVERY_FAILED','Passed Word artifact unavailable');
    let bytes:Buffer|null;
    try { bytes=await options.blobs.getIfExistsBounded(artifact.object_key,DOCX_LIMITS.archiveBytes); }
    catch(error) {
      const code=error instanceof Problem && error.status===413?'blob_too_large':'blob_read_failed';
      await revokeWordArtifactAfterReadbackFailure(pool,lease,artifact,code);
      throw new Problem(422,'DELIVERY_FAILED','Word artifact readback failed');
    }
    if(!bytes) {
      await revokeWordArtifactAfterReadbackFailure(pool,lease,artifact,'blob_missing');
      throw new Problem(422,'DELIVERY_FAILED','Word artifact is missing');
    }
    if(bytes.length>DOCX_LIMITS.archiveBytes) {
      await revokeWordArtifactAfterReadbackFailure(pool,lease,artifact,'blob_too_large');
      throw new Problem(422,'DELIVERY_FAILED','Word artifact exceeds the bounded read limit');
    }
    if(bytes.length!==Number(artifact.evidence_byte_size) || digest(bytes)!==artifact.sha256.trim()) {
      await revokeWordArtifactAfterReadbackFailure(pool,lease,artifact,'blob_hash_mismatch',{sha256:digest(bytes),byteSize:bytes.length});
      throw new Problem(422,'DELIVERY_FAILED','Word artifact hash mismatch');
    }
    const inspection=inspectDocx(bytes);
    const evidence=artifact.quality_evidence as DocxInspection;
    if(inspection.quality_status!=='passed' || inspection.validator_version!==WORD_DELIVERY_VALIDATOR_VERSION
      || inspection.sha256!==artifact.sha256.trim() || inspection.byte_size!==Number(artifact.evidence_byte_size)
      || evidence?.quality_status!=='passed' || evidence.validator_version!==inspection.validator_version
      || evidence.sha256!==inspection.sha256 || evidence.byte_size!==inspection.byte_size)
      throw new Problem(422,'DELIVERY_FAILED','Word artifact quality evidence mismatch');
  }
  return transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    if(await providerCallNeedsReconciliation(client,lease.jobId))throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs reconciliation');
    if(outcome==='succeeded'){
      const q=await client.query(`SELECT 1 FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e
        ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
        WHERE a.owner_user_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.version=$4 AND a.object_key=$5 AND a.sha256=$6
          AND a.media_type=$7 AND a.quality_status='passed' AND a.delivery_status='available'
          AND e.artifact_id=a.id AND e.artifact_version=a.version AND e.candidate_sha256=a.sha256
          AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
          AND e.readback_sha256=e.candidate_sha256 AND e.readback_byte_size=e.byte_size
        FOR UPDATE OF a`,[lease.owner,lease.runId,artifact.id,artifact.version,artifact.object_key,artifact.sha256,WORD_MEDIA_TYPE]);
      if(!q.rowCount)throw new Problem(422,'DELIVERY_FAILED','Word artifact changed');
      await client.query('UPDATE bb_runs SET artifact_id=$2,artifact_version=$3 WHERE id=$1',[r.id,artifact.id,artifact.version]);
    }
    await client.query('UPDATE bb_jobs SET state=$2,stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[lease.jobId,outcome]);
    if(outcome==='failed')await recordRunFailure(client,r,lease.jobId,options.errorCode,options.failedStage);
    await event(client,r,outcome,outcome,outcome==='failed'?'processor_failed':'word_delivered',options.errorCode);
    return runDto({...r,artifact_id:artifact?.id??null,updated_at:new Date()});
  });
}

/**
 * #79/#16 terminal transition for a platform probe. Success needs a completed attempt with a
 * stored result and measured usage (0027 re-checks it); a failure needs no unresolved attempt.
 */
export async function finishPlatformProbe(pool:Pool,lease:Lease,outcome:'failed'|'succeeded',options:{errorCode?:string;failedStage?:string}={}) {
  return transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    if(j.job_type!=='platform_probe')throw new Problem(409,'IDEMPOTENCY_CONFLICT','Not a platform probe job');
    const pending=await client.query("SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1 AND status='pending_reconcile' LIMIT 1",[j.id]);
    if(pending.rowCount)throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs reconciliation');
    if(outcome==='succeeded'){
      const done=await client.query(`SELECT 1 FROM bb_model_call_attempts a JOIN bb_call_usage u ON u.attempt_id=a.id
        JOIN bb_provider_call_observations o ON o.attempt_id=a.id AND o.outcome='completed' AND o.usage_status='measured'
        JOIN bb_provider_result_refs p ON p.id=o.result_id AND p.attempt_id=a.id
        WHERE a.job_id=$1 AND a.status='completed' AND u.usage_status='measured' AND u.conflicting_measurements=0 LIMIT 1`,[j.id]);
      if(!done.rowCount)throw new Problem(409,'CAPABILITY_NOT_READY','Probe has no completed measured provider result');
    }
    await client.query('UPDATE bb_jobs SET state=$2,stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[j.id,outcome]);
    if(outcome==='failed')await recordRunFailure(client,r,j.id,options.errorCode,options.failedStage);
    await event(client,r,outcome,outcome,outcome==='failed'?'processor_failed':'platform_probe_completed',outcome==='failed'?options.errorCode:undefined);
    return {state:outcome};
  });
}

export async function jobSnapshot(pool:Pool,owner:string,runId:string) {
  const q=await pool.query('SELECT j.id,j.state,j.stage,j.checkpoint,j.attempts,j.lease_until FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE r.owner_user_id=$1 AND r.id=$2',[owner,runId]);
  if(!q.rows[0])throw missing();return {...q.rows[0],lease_until:q.rows[0].lease_until?date(q.rows[0].lease_until):null};
}

// ---------------------------------------------------------------- #17 worker runtime

// A failed run keeps its checkpoint, input revision and materials; this adds the #79 structured
// error so the admin timeline shows why. Internal codes (e.g. WORD_QUALITY_REJECTED) map to a public one.
async function recordRunFailure(client:PoolClient,r:any,jobId:string,errorCode:string|undefined,stage:string|undefined) {
  const code:ErrorCode=(ERROR_CODES as readonly string[]).includes(errorCode??'')?errorCode as ErrorCode:errorCode?.startsWith('WORD_')?'DELIVERY_FAILED':'DATA_UNAVAILABLE';
  const category:typeof ERROR_CATEGORIES[number]=errorCode?.startsWith('MODEL_')?'model_provider':code==='DELIVERY_FAILED'?'delivery':code==='CAPABILITY_NOT_READY'?'queue':code.startsWith('MATERIAL_')?'material_parse':'internal';
  const safeStage=stage&&/^[a-z][a-z0-9_]{0,63}$/.test(stage)?stage:null;
  const attempts=(await client.query('SELECT attempts FROM bb_jobs WHERE id=$1',[jobId])).rows[0]?.attempts??0;
  await client.query('UPDATE bb_jobs SET error_code=$2 WHERE id=$1',[jobId,code]);
  const id=uid();
  await client.query(`INSERT INTO bb_observability_errors(id,owner_user_id,project_id,job_id,trace_id,code,category,stage,retry_count,recovery_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'terminal')`,[id,r.owner_user_id,r.project_id,jobId,r.id,code,category,safeStage,attempts]);
  await emitInternal(client,internalEvent({kind:'error.recorded',owner:r.owner_user_id,projectId:r.project_id,runId:r.id,jobId,traceId:r.id,stage:safeStage,error:{error_id:id,code,category,retryable:false}}));
}

/** Merges one completed stage into checkpoint.stages without touching provider_results written by #16. */
export async function checkpointStage(pool:Pool,lease:Lease,stage:string,value:Record<string,unknown>) {
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(stage))throw new Problem(422,'VALIDATION_FAILED','Invalid stage');
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    const q=await client.query(`UPDATE bb_jobs SET stage=$2,updated_at=now(),
      checkpoint=checkpoint || jsonb_build_object('stages', COALESCE(checkpoint->'stages','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb))
      WHERE id=$1 RETURNING checkpoint`,[lease.jobId,stage,JSON.stringify(value)]);
    lease.checkpoint=q.rows[0].checkpoint;
    await event(client,r,'running',stage,'stage_completed',undefined,'run.progress');
  });
}

/** Upgrade an already completed stage's checkpoint without publishing another completion event. */
export async function upgradeStageCheckpoint(pool:Pool,lease:Lease,stage:string,value:Record<string,unknown>) {
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(stage))throw new Problem(422,'VALIDATION_FAILED','Invalid stage');
  await transaction(pool,async client=>{
    const {j}=await lockedLease(client,lease);
    const stages=j.checkpoint?.stages;
    if(!stages || typeof stages!=='object' || Array.isArray(stages) || !Object.prototype.hasOwnProperty.call(stages,stage))
      throw new Error('STAGE_CHECKPOINT_UPGRADE_REQUIRES_EXISTING_CHECKPOINT');
    const q=await client.query(`UPDATE bb_jobs SET stage=$2,updated_at=now(),
      checkpoint=checkpoint || jsonb_build_object('stages', COALESCE(checkpoint->'stages','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb))
      WHERE id=$1 RETURNING checkpoint`,[lease.jobId,stage,JSON.stringify(value)]);
    lease.checkpoint=q.rows[0].checkpoint;
  });
}

/**
 * Parks a run that cannot progress yet (a stage is not implemented, pinned materials are still
 * parsing). It keeps its checkpoint and is never reported as success; resume re-queues it.
 */
export async function pauseRun(pool:Pool,lease:Lease,stage:typeof RUN_PAUSE_STAGES[number],reason:string) {
  if(!RUN_PAUSE_STAGES.includes(stage)||!/^[a-z][A-Za-z0-9_:-]{0,127}$/.test(reason))throw new Problem(422,'VALIDATION_FAILED','Invalid pause');
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    await client.query("UPDATE bb_jobs SET state='paused',stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[lease.jobId,stage]);
    await event(client,r,'paused',stage,reason);
  });
}

/** Trusted runtime resume (never a browser principal): re-queues a paused run whose blocker cleared. */
export async function resumePausedRun(pool:Pool,owner:string,runId:string,reason:'materials_ready'|'provider_reconciled') {
  return transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j||r.state!=='paused'||j.state!=='paused')return false;
    if(await providerCallNeedsReconciliation(client,j.id))return false;
    await client.query("UPDATE bb_jobs SET state='queued',updated_at=now() WHERE id=$1",[j.id]);
    await event(client,r,'queued',j.stage,reason);
    return true;
  });
}

/** Paused runs at a stage, oldest first; the runtime sweeps them after their blocker may have cleared. */
export async function pausedRuns(pool:Pool,stage:typeof RUN_PAUSE_STAGES[number],limit=20) {
  const q=await pool.query("SELECT j.id AS job_id,j.run_id,j.owner_user_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE j.job_type<>'parse' AND j.state='paused' AND j.stage=$1 AND r.state='paused' ORDER BY j.updated_at,j.id LIMIT $2",[stage,limit]);
  return q.rows as {job_id:string;run_id:string;owner_user_id:string}[];
}

/** Graceful shutdown: expire our lease now so the next claim resumes from the checkpoint without waiting. */
export async function releaseLease(pool:Pool,lease:Lease,reason='lease_released') {
  await transaction(pool,async client=>{
    let locked;
    try { locked=await lockedLease(client,lease); } catch { return; }
    await client.query("UPDATE bb_jobs SET lease_until=now()-interval '1 millisecond',updated_at=now() WHERE id=$1",[lease.jobId]);
    await event(client,locked.r,'running',locked.j.stage,reason,undefined,'run.progress');
  });
}
