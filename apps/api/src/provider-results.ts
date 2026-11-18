import { inputManifestHash } from './production-rule-pin.js';
import { syncAuthoringProgress } from './authoring-progress.js';
import { Pool, type PoolClient } from 'pg';
import { digest, missing, Problem, transaction, uid, type PrivateBlobs, run as getRun } from './data.js';
import { emitInternal, internalEvent } from './observability.js';
import { errorDiagnostic } from './error-diagnostics.js';
import { MODEL_ADAPTER_ERROR_CODES, FILE_AUTHORING_CAPTURE_VERSION, isFileAuthoringDeadline, type ModelAdapterErrorCode, type RunEvent } from '@bondbuddy/contracts';
import { runEventPayloadDto } from './run-event-dto.js';
import type { Lease } from './queue.js';
export type { PrivateBlobs } from './data.js';

// This adapter exposes only immutable, run-local material reads; no side-effecting tools.
export const READ_ONLY_MATERIAL_ADAPTER_VERSION = 'codex-material-readonly-1';

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeVersion = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const safeError = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const safeFinish = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const safeRequestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
const token = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export type ProviderCallIntent = {
  owner_user_id: string;
  project_id: string;
  job_id: string;
  run_id: string;
  trace_id: string;
  logical_call_id: string;
  call_id: string;
  attempt_no: number;
  model_id: string;
  model_config_version: string;
  prompt_snapshot_ref: string;
};

export type ProviderUsage = {
  status: 'measured' | 'pending' | 'unknown';
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
};

export type ProviderResultReference = {
  result_ref: string;
  result_sha256: string;
  result_schema_version: string;
  result_byte_size: number;
};

export type ProviderCallObservation = ProviderCallIntent & {
  provider_request_id: string | null;
  finish_reason: string | null;
  outcome: 'completed' | 'failed' | 'pending_reconcile' | 'confirmed_not_sent';
  usage: ProviderUsage;
  error_code: string | null;
  result_ref: string | null;
  result_sha256: string | null;
  result_schema_version: string | null;
  result_byte_size: number | null;
};

export type ProviderObservationResult = {
  attempt_status: 'completed' | 'failed' | 'pending_reconcile' | 'confirmed_not_sent';
  usage_status: 'measured' | 'pending' | 'unknown' | 'conflict';
  idempotent: boolean;
};

export function providerResultObjectKey(intent: ProviderCallIntent, sha256: string): string {
  if (!safeId(intent.owner_user_id) || !safeId(intent.project_id) || !safeId(intent.call_id) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid provider result identity');
  }
  return `users/${intent.owner_user_id}/projects/${intent.project_id}/provider-results/${intent.call_id}-${sha256}.json`;
}

function assertIntent(intent: ProviderCallIntent) {
  if (!safeId(intent.owner_user_id) || !safeId(intent.project_id) || !safeId(intent.job_id) || !safeId(intent.run_id) ||
      !safeId(intent.trace_id) || !safeId(intent.logical_call_id) || !safeId(intent.call_id) || !Number.isSafeInteger(intent.attempt_no) || intent.attempt_no < 1 ||
      !safeId(intent.model_id) || !safeVersion(intent.model_config_version) || !safeId(intent.prompt_snapshot_ref) || intent.trace_id !== intent.run_id || intent.call_id.length > 128) {
    throw new Error('Invalid provider call identity');
  }
}

function assertObservation(observation: ProviderCallObservation) {
  assertIntent(observation);
  if (observation.provider_request_id !== null && !safeRequestId(observation.provider_request_id)) throw new Error('Invalid provider request reference');
  if (observation.finish_reason !== null && !safeFinish(observation.finish_reason)) throw new Error('Invalid provider finish reason');
  if (observation.error_code !== null && !safeError(observation.error_code)) throw new Error('Invalid provider error code');
  const u = observation.usage;
  if (!u || !['measured','pending','unknown'].includes(u.status)) throw new Error('Invalid provider usage status');
  const values = [u.input_tokens,u.cached_input_tokens,u.output_tokens,u.reasoning_tokens,u.total_tokens];
  if (values.some(value => value !== null && !token(value))) throw new Error('Invalid provider usage counts');
  if (u.cached_input_tokens !== null && u.input_tokens !== null && u.cached_input_tokens > u.input_tokens) throw new Error('Invalid cached input count');
  if (u.reasoning_tokens !== null && u.output_tokens !== null && u.reasoning_tokens > u.output_tokens) throw new Error('Invalid reasoning output count');
  if (u.status === 'measured' && (u.input_tokens === null || u.output_tokens === null || u.total_tokens !== u.input_tokens + u.output_tokens)) throw new Error('Measured provider usage is incomplete');
  if (u.status === 'unknown' && values.some(value => value !== null)) throw new Error('Unknown usage cannot include token counts');
  const refParts = [observation.result_ref,observation.result_sha256,observation.result_schema_version,observation.result_byte_size];
  const hasResult = refParts.every(value => value !== null);
  if (refParts.some(value => value === null) && refParts.some(value => value !== null)) throw new Error('Provider result reference is incomplete');
  if (hasResult) {
    if (!/^[a-f0-9]{64}$/.test(observation.result_sha256!) || !safeVersion(observation.result_schema_version) || !Number.isSafeInteger(observation.result_byte_size) || observation.result_byte_size! < 1 || observation.result_byte_size! > 10485760 ||
        observation.result_ref !== providerResultObjectKey(observation,observation.result_sha256!)) throw new Error('Invalid provider result reference');
  }
  if (!['completed','failed','pending_reconcile','confirmed_not_sent'].includes(observation.outcome)) throw new Error('Invalid provider outcome');
  if (observation.outcome === 'completed' && (!hasResult || u.status !== 'measured' || observation.finish_reason !== 'stop' || observation.error_code !== null)) throw new Error('Completed call needs a checked result and measured usage');
  if (observation.outcome === 'confirmed_not_sent' && (hasResult || observation.provider_request_id !== null || u.status !== 'unknown')) throw new Error('Not-sent observation cannot have supplier response or usage evidence');
}

/** Large result evidence may yield while revalidating; every caller awaits its verdict. */
export type ProviderResultValidator = (value: unknown) => boolean | Promise<boolean>;

async function parseAndValidate(bytes: Buffer, validate: ProviderResultValidator): Promise<unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new Problem(422,'DELIVERY_FAILED','Provider result is not valid UTF-8 JSON'); }
  if (!await validate(value)) throw new Problem(422,'DELIVERY_FAILED','Provider result failed its versioned schema');
  return value;
}

export async function persistProviderResultObject(input: {
  blobs: PrivateBlobs;
  intent: ProviderCallIntent;
  bytes: Buffer;
  resultSchemaVersion: string;
  validate: ProviderResultValidator;
}): Promise<ProviderResultReference> {
  assertIntent(input.intent);
  if (!safeVersion(input.resultSchemaVersion) || input.bytes.length < 1 || input.bytes.length > 10485760) throw new Problem(422,'DELIVERY_FAILED','Invalid provider result size or schema version');
  // Validation can yield. Bind the persisted bytes to the exact snapshot checked,
  // even if the caller subsequently changes its mutable Buffer.
  const bytes = Buffer.from(input.bytes);
  await parseAndValidate(bytes,input.validate);
  const sha256 = digest(bytes);
  const resultRef = providerResultObjectKey(input.intent,sha256);
  await input.blobs.put(resultRef,bytes,'application/json');
  const stored = await input.blobs.get(resultRef);
  if (stored.length !== bytes.length || digest(stored) !== sha256) throw new Problem(409,'CAPABILITY_NOT_READY','Provider result Blob verification failed');
  return {result_ref:resultRef,result_sha256:sha256,result_schema_version:input.resultSchemaVersion,result_byte_size:bytes.length};
}

function observationHash(observation: ProviderCallObservation): string {
  return digest(JSON.stringify({
    owner_user_id:observation.owner_user_id,project_id:observation.project_id,job_id:observation.job_id,run_id:observation.run_id,trace_id:observation.trace_id,
    logical_call_id:observation.logical_call_id,call_id:observation.call_id,attempt_no:observation.attempt_no,provider_request_id:observation.provider_request_id,
    model_id:observation.model_id,model_config_version:observation.model_config_version,prompt_snapshot_ref:observation.prompt_snapshot_ref,
    finish_reason:observation.finish_reason,outcome:observation.outcome,usage:{status:observation.usage.status,input_tokens:observation.usage.input_tokens,cached_input_tokens:observation.usage.cached_input_tokens,output_tokens:observation.usage.output_tokens,reasoning_tokens:observation.usage.reasoning_tokens,total_tokens:observation.usage.total_tokens},error_code:observation.error_code,
    result_ref:observation.result_ref,result_sha256:observation.result_sha256,result_schema_version:observation.result_schema_version,result_byte_size:observation.result_byte_size
  }));
}

async function verifyObservationResult(blobs: PrivateBlobs, observation: ProviderCallObservation, validate: ProviderResultValidator) {
  if (observation.result_ref === null) return;
  let bytes: Buffer;
  try { bytes = await blobs.get(observation.result_ref); }
  catch { throw new Problem(409,'CAPABILITY_NOT_READY','Provider result Blob is unavailable; call remains pending'); }
  if (bytes.length !== observation.result_byte_size || digest(bytes) !== observation.result_sha256) throw new Problem(409,'CAPABILITY_NOT_READY','Provider result Blob hash mismatch; call remains pending');
  await parseAndValidate(bytes,validate);
}

async function lockIdentity(client: PoolClient, observation: ProviderCallObservation, lease?: Lease) {
  // Both binding tables prove an accepted included task. A zero amount without
  // that owned binding must not relax reconciliation for ordinary trial runs.
  const r = (await client.query(`SELECT r.*,(EXISTS(SELECT 1 FROM bb_commerce_scope_runs coverage
    JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
    WHERE coverage.owner_user_id=r.owner_user_id AND coverage.run_id=r.id AND scope.amount_fen=0)
    OR EXISTS(SELECT 1 FROM bb_automatic_scope_runs coverage
    JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
    WHERE coverage.owner_user_id=r.owner_user_id AND coverage.run_id=r.id AND scope.amount_fen=0 AND scope.automatic_price IS NOT NULL)) AS covered_zero_outcome
    FROM bb_runs r JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    WHERE r.owner_user_id=$1 AND r.id=$2 AND p.deleted_at IS NULL FOR UPDATE OF r`,[observation.owner_user_id,observation.run_id])).rows[0];
  if(!r)throw missing();
  if (r.project_id !== observation.project_id) throw missing();
  const job = (await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[observation.owner_user_id,observation.job_id,observation.run_id])).rows[0];
  if (!job) throw missing();
  if (['succeeded','test_completed','failed','cancelled','rejected'].includes(r.state)) throw new Problem(409,'ALREADY_TERMINAL','Run already finished');
  if (lease) {
    if (lease.owner !== observation.owner_user_id || lease.runId !== observation.run_id || lease.jobId !== observation.job_id || job.state !== 'running' || job.lease_token !== lease.token || !job.lease_until || new Date(job.lease_until).getTime() <= Date.now()) {
      throw new Problem(409,'CAPABILITY_NOT_READY','Provider observation lease is no longer active');
    }
  } else if (r.state !== 'paused' || job.state !== 'paused') {
    throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not awaiting provider reconciliation');
  }
  return {r,job};
}

async function assertObservationScope(pool: Pool, observation: ProviderCallObservation, lease?: Lease) {
  const q=await pool.query(`SELECT r.state,j.state AS job_state,j.lease_token,j.lease_until,a.model_id,a.prompt_snapshot_id
    FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN bb_model_call_attempts a ON a.owner_user_id=j.owner_user_id AND a.job_id=j.id
    WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND j.id=$4
      AND a.logical_call_id=$5 AND a.attempt_no=$6 AND a.id=$7`,[observation.owner_user_id,observation.project_id,observation.run_id,observation.job_id,observation.logical_call_id,observation.attempt_no,observation.call_id]);
  const row=q.rows[0];
  if(!row || row.model_id!==observation.model_id || row.prompt_snapshot_id!==observation.prompt_snapshot_ref)throw missing();
  if(['succeeded','test_completed','failed','cancelled','rejected'].includes(row.state))throw new Problem(409,'ALREADY_TERMINAL','Run already finished');
  if(lease){
    if(lease.owner!==observation.owner_user_id || lease.runId!==observation.run_id || lease.jobId!==observation.job_id || row.job_state!=='running' || row.lease_token!==lease.token || !row.lease_until || new Date(row.lease_until).getTime()<=Date.now())throw new Problem(409,'CAPABILITY_NOT_READY','Provider observation lease is no longer active');
  }else if(row.state!=='paused' || row.job_state!=='paused')throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not awaiting provider reconciliation');
}

/** Retain only public codes; supplier text and unknown runtime fields never enter task events. */
export function providerRunEventPayload(reason: string, errorCode?: ModelAdapterErrorCode | null): RunEvent['payload'] {
  return runEventPayloadDto({ reason, ...(errorCode ? { error_code: errorCode } : {}) });
}

async function appendRunEvent(client: PoolClient, r: any, state: string, stage: string, reason: string, type='run.progress', errorCode?: ModelAdapterErrorCode | null) {
  const seq = r.event_cursor + 1;
  const eventId = uid();
  const payload = providerRunEventPayload(reason, errorCode);
  await syncAuthoringProgress(client,r,{state,stage,reason});
  await client.query('UPDATE bb_runs SET state=$2,stage=$3,event_cursor=$4,updated_at=now() WHERE id=$1',[r.id,state,stage,seq]);
  await client.query('INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[eventId,r.owner_user_id,r.id,seq,r.id,type,state,stage,payload]);
  await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),r.owner_user_id,'run',r.id,type,{run_id:r.id,event_id:eventId,seq,state,stage,...payload}]);
  const job = await client.query('SELECT id FROM bb_jobs WHERE run_id=$1',[r.id]);
  await emitInternal(client,internalEvent({kind:'job.state_changed',owner:r.owner_user_id,projectId:r.project_id,runId:r.id,jobId:job.rows[0]?.id,traceId:r.id,status:state as any,stage}));
  r.state=state;r.stage=stage;r.event_cursor=seq;
}

async function insertUsageEvidence(client: PoolClient, observation: ProviderCallObservation, source: 'provider'|'reconciliation', hash: string, resultId: string | null) {
  const u=observation.usage;
  const measured=u.status==='measured';
  const values=measured?[u.input_tokens,u.output_tokens,u.cached_input_tokens,u.reasoning_tokens]:[null,null,null,null];
  const sourceEventId=`${source}-${hash}`;
  const evidenceRef=resultId ?? observation.call_id;
  const inserted=await client.query("INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(attempt_id,source,source_event_id) DO NOTHING RETURNING id",[uid(),observation.owner_user_id,observation.call_id,source,sourceEventId,u.status,...values,evidenceRef]);
  if (!inserted.rowCount) {
    const old=(await client.query('SELECT usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,evidence_ref FROM bb_usage_observations WHERE attempt_id=$1 AND source=$2 AND source_event_id=$3',[observation.call_id,source,sourceEventId])).rows[0];
    if (!old || old.usage_status!==u.status || ![old.input_tokens,old.output_tokens,old.cached_input_tokens,old.reasoning_tokens].every((v,i)=>v===values[i]) || old.evidence_ref!==evidenceRef) throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider usage event conflicts with its previous evidence');
    return false;
  }
  const usageEvent=internalEvent({kind:'model.usage_observed',owner:observation.owner_user_id,projectId:observation.project_id,jobId:observation.job_id,runId:observation.run_id,traceId:observation.trace_id,logicalCallId:observation.logical_call_id,attemptNo:observation.attempt_no,promptSnapshotRef:observation.prompt_snapshot_ref,usage:{status:measured?'reported':u.status==='pending'?'pending':'unavailable',input_tokens:u.input_tokens,output_tokens:u.output_tokens,cached_input_tokens:u.cached_input_tokens,reasoning_tokens:u.reasoning_tokens,evidence_ref:evidenceRef}});
  usageEvent.call_id=observation.call_id;
  await emitInternal(client,usageEvent);
  return true;
}

async function appendCallFinished(client: PoolClient, observation: ProviderCallObservation, status: 'running'|'paused'|'succeeded'|'failed') {
  const u=observation.usage;
  const measured=u.status==='measured';
  const finished=internalEvent({kind:'model.call_finished',owner:observation.owner_user_id,projectId:observation.project_id,jobId:observation.job_id,runId:observation.run_id,traceId:observation.trace_id,logicalCallId:observation.logical_call_id,attemptNo:observation.attempt_no,promptSnapshotRef:observation.prompt_snapshot_ref,status,usage:{status:measured?'reported':u.status==='pending'?'pending':'unavailable',input_tokens:u.input_tokens,output_tokens:u.output_tokens,cached_input_tokens:u.cached_input_tokens,reasoning_tokens:u.reasoning_tokens,evidence_ref:observation.result_sha256 ?? observation.call_id}});
  finished.call_id=observation.call_id;
  await emitInternal(client,finished);
}

function checkpointWithResult(checkpoint: Record<string,unknown>, item: {logical_call_id:string;attempt_no:number;call_id:string;result_id:string;result_ref:string;result_sha256:string;result_schema_version:string}) {
  const current=Array.isArray(checkpoint.provider_results)?checkpoint.provider_results as Record<string,unknown>[]:[];
  const matches=current.filter(entry=>entry.logical_call_id===item.logical_call_id&&entry.attempt_no===item.attempt_no);
  if(matches.length>1)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Checkpoint has duplicate provider result entries for this call');
  const old=matches[0];
  if (old && (old.call_id!==item.call_id || old.result_id!==item.result_id || old.result_sha256!==item.result_sha256 || old.result_ref!==item.result_ref)) throw new Problem(409,'IDEMPOTENCY_CONFLICT','Checkpoint already names different provider result evidence');
  const next=old?current:[...current,item];
  return {...checkpoint,provider_results:next};
}

export async function recordProviderCallObservation(
  pool: Pool,
  blobs: PrivateBlobs,
  observation: ProviderCallObservation,
  validateResult: ProviderResultValidator,
  options: { lease?: Lease; source?: 'provider'|'reconciliation'; retryable?: boolean } = {}
): Promise<ProviderObservationResult> {
  assertObservation(observation);
  const eventErrorCode = MODEL_ADAPTER_ERROR_CODES.find(code => code === observation.error_code);
  await assertObservationScope(pool,observation,options.lease);
  await verifyObservationResult(blobs,observation,validateResult);
  const hash=observationHash(observation);
  return transaction(pool,async client=>{
    const {r,job}=await lockIdentity(client,observation,options.lease);
    const integrityInterpretation=!!options.lease&&job.subtype==='integrity_v1'&&/^integrity_browser_[a-f0-9]{24}$/.test(observation.logical_call_id);
    if(integrityInterpretation){
      // Only a captured official-site interpretation may keep a settled schema
      // failure local. The frozen job/call identity excludes other task types.
      const batches=(await client.query(`SELECT i.manifest,i.input_hash,b.subject_id,b.site_id,b.payload,b.sha256
        FROM bb_integrity_runs i JOIN bb_integrity_browser_batches b ON b.owner_user_id=i.owner_user_id AND b.run_id=i.run_id
        WHERE i.owner_user_id=$1 AND i.run_id=$2 AND i.operation='check'`,[r.owner_user_id,r.id])).rows;
      const frozen=batches.some(b=>b.manifest.collector==='official-browser-v1'&&inputManifestHash(b.manifest)===b.input_hash.trim()
        &&b.input_hash.trim()===r.input_hash.trim()&&b.manifest.draft.site_ids.includes(b.site_id)
        &&b.manifest.draft.subjects.some((s:{id:string})=>s.id===b.subject_id)
        &&observation.logical_call_id==='integrity_browser_'+inputManifestHash({subject:b.subject_id,site:b.site_id}).slice(0,24)
        &&inputManifestHash(b.payload)===b.sha256.trim()&&b.payload.outcome==='results'&&b.payload.search_performed===true
        &&Array.isArray(b.payload.captures)&&b.payload.captures.length>0);
      if(!frozen)
        throw new Problem(409,'CAPABILITY_NOT_READY','Site-local interpretation requires a frozen official browser result');
    }
    const a=(await client.query('SELECT * FROM bb_model_call_attempts WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4 FOR UPDATE',[observation.owner_user_id,observation.job_id,observation.logical_call_id,observation.attempt_no])).rows[0];
    if (!a || a.id!==observation.call_id || a.model_id!==observation.model_id || a.prompt_snapshot_id!==observation.prompt_snapshot_ref || observation.trace_id!==r.id) throw missing();
    if (a.provider_request_id && observation.provider_request_id && a.provider_request_id!==observation.provider_request_id) throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider request identity conflicts with the recorded attempt');
    const oldMeta=await client.query('SELECT model_config_version,provider_request_id FROM bb_provider_call_observations WHERE attempt_id=$1 ORDER BY observed_at,id LIMIT 1',[a.id]);
    if (oldMeta.rows[0] && oldMeta.rows[0].model_config_version!==observation.model_config_version) throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider model configuration conflicts with the recorded attempt');
    const oldRequest=await client.query('SELECT 1 FROM bb_provider_call_observations WHERE attempt_id=$1 AND provider_request_id IS NOT NULL AND provider_request_id<>$2 LIMIT 1',[a.id,observation.provider_request_id]);
    if (observation.provider_request_id && oldRequest.rowCount) throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider request identity conflicts with the recorded attempt');
    if (a.status==='confirmed_not_sent' && observation.outcome!=='confirmed_not_sent') throw new Problem(409,'IDEMPOTENCY_CONFLICT','A not-sent attempt cannot later be reused as a sent call');

    const duplicate=await client.query('SELECT id FROM bb_provider_call_observations WHERE attempt_id=$1 AND observation_hash=$2',[a.id,hash]);
    if (duplicate.rowCount) {
      const usage=(await client.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[a.id])).rows[0];
      return {attempt_status:a.status,usage_status:usage?.usage_status??'unknown',idempotent:true};
    }
    if (job.checkpoint?.operator_reconciliations?.[a.id])
      throw new Problem(409,'IDEMPOTENCY_CONFLICT','Operator-disposed attempt cannot change the run outcome');

    let result:any=null;
    const existingResults=(await client.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1 FOR UPDATE',[a.id])).rows;
    if (observation.result_ref) {
      result=existingResults.find((candidate:any)=>candidate.result_sha256.trim()===observation.result_sha256) ?? null;
      if (result) {
        if (result.result_ref!==observation.result_ref || result.result_sha256.trim()!==observation.result_sha256 || result.result_schema_version!==observation.result_schema_version || Number(result.byte_size)!==observation.result_byte_size || result.model_config_version!==observation.model_config_version || result.prompt_snapshot_ref!==observation.prompt_snapshot_ref) {
          throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider attempt already has different immutable result evidence');
        }
      } else {
        const inserted=await client.query('INSERT INTO bb_provider_result_refs(id,owner_user_id,project_id,job_id,run_id,attempt_id,logical_call_id,attempt_no,call_id,trace_id,model_id,model_config_version,prompt_snapshot_ref,result_ref,result_sha256,result_schema_version,byte_size,media_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',[uid(),observation.owner_user_id,observation.project_id,observation.job_id,observation.run_id,a.id,observation.logical_call_id,observation.attempt_no,observation.call_id,observation.trace_id,observation.model_id,observation.model_config_version,observation.prompt_snapshot_ref,observation.result_ref,observation.result_sha256,observation.result_schema_version,observation.result_byte_size,'application/json']);
        result=inserted.rows[0];
      }
    }
    const resultCandidates=await client.query('SELECT count(*)::int AS candidate_count FROM bb_provider_result_refs WHERE attempt_id=$1',[a.id]);
    const candidateCount=Number(resultCandidates.rows[0].candidate_count);
    const resultConflict=candidateCount>1;
    if (candidateCount>0 && observation.outcome==='confirmed_not_sent') throw new Problem(409,'IDEMPOTENCY_CONFLICT','A provider result cannot belong to a confirmed not-sent attempt');
    if (candidateCount>0 && observation.outcome==='failed') throw new Problem(409,'IDEMPOTENCY_CONFLICT','A completed provider result conflicts with a failed call observation');

    const resultId=result?.id ?? null;
    await client.query('INSERT INTO bb_provider_call_observations(id,owner_user_id,project_id,job_id,run_id,attempt_id,logical_call_id,attempt_no,call_id,trace_id,provider_request_id,model_id,model_config_version,prompt_snapshot_ref,result_id,outcome,finish_reason,usage_status,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,error_code,observation_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)',[uid(),observation.owner_user_id,observation.project_id,observation.job_id,observation.run_id,a.id,observation.logical_call_id,observation.attempt_no,observation.call_id,observation.trace_id,observation.provider_request_id,observation.model_id,observation.model_config_version,observation.prompt_snapshot_ref,resultId,observation.outcome,observation.finish_reason,observation.usage.status,observation.usage.input_tokens,observation.usage.cached_input_tokens,observation.usage.output_tokens,observation.usage.reasoning_tokens,observation.usage.total_tokens,observation.error_code,hash]);
    await insertUsageEvidence(client,observation,options.source??'reconciliation',hash,resultId);
    const usageRow=(await client.query('SELECT usage_status,conflicting_measurements FROM bb_call_usage WHERE attempt_id=$1',[a.id])).rows[0];
    const usageStatus:ProviderObservationResult['usage_status']=usageRow?.usage_status==='conflict'?'conflict':usageRow?.usage_status==='measured'?'measured':usageRow?.usage_status==='pending'?'pending':'unknown';
    const measuredWithoutConflict=usageStatus==='measured' && Number(usageRow.conflicting_measurements)===0;
    // A verified durable result is sufficient for a fixed-price task. Unknown or
    // conflicting usage remains in the internal cost ledger without holding credits.
    const usageOnlyPending=observation.outcome==='pending_reconcile'&&observation.finish_reason==='stop'&&
      ['MODEL_USAGE_PENDING','USAGE_PENDING'].includes(observation.error_code??'');
    const resultMayPrecedeMetering=r.covered_zero_outcome===true || r.billing_mode==='fixed_credits' || r.billing_mode==='metered_credits' && ['m4_document_v1','m4_qa_v1'].includes(job.subtype);
    const complete=!!result && candidateCount===1 &&
      (observation.outcome==='completed'&&(measuredWithoutConflict || resultMayPrecedeMetering) || resultMayPrecedeMetering&&usageOnlyPending);
    // A provider's explicit invalid_request_error is a request rejection, with no
    // generated result to reconcile. Keep usage unknown; all other unmeasured failures
    // still require reconciliation because the request may have consumed tokens.
    // A file author's previous local work may survive an explicit HTTP 413. Keep
    // unknown usage intact while the worker checks its bounded recovery policy.
    const payloadRejected=observation.error_code==='MODEL_PROVIDER_PAYLOAD_TOO_LARGE' && observation.usage.status==='unknown' && candidateCount===0;
    const payloadRecovery=observation.outcome==='failed' && payloadRejected && r.task_kind==='update'
      && /^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(observation.logical_call_id);
    // An explicit supplier output exhaustion and a local byte cap are distinct,
    // but neither proves the whole CLI attempt's usage. The recovery sweep
    // separately verifies termination and the latest saved workspace.
    const providerOutputLimit=observation.error_code==='MODEL_PROVIDER_OUTPUT_LIMIT' && observation.finish_reason==='max_output_tokens';
    const outputLimitRecovery=observation.outcome==='pending_reconcile' && (observation.error_code==='MODEL_OUTPUT_TOO_LARGE' || providerOutputLimit)
      && observation.usage.status==='unknown' && candidateCount===0 && r.task_kind==='update'
      && /^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(observation.logical_call_id);
    const timeoutRecovery=observation.outcome==='pending_reconcile' && observation.error_code==='MODEL_TIMEOUT'
      && observation.usage.status==='unknown' && candidateCount===0 && r.task_kind==='update'
      && /^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(observation.logical_call_id);
    const contextRotation=observation.outcome==='pending_reconcile' && observation.error_code==='MODEL_CONTEXT_ROTATION_REQUIRED'
      && observation.usage.status==='unknown' && candidateCount===0 && r.task_kind==='update'
      && /^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(observation.logical_call_id);
    const deadlineCapture=job.checkpoint?.file_authoring_recovery_captures?.[a.id];
    const deadlineExpiredBeforeSend=observation.outcome==='confirmed_not_sent' && observation.error_code==='MODEL_TIMEOUT'
      && observation.usage.status==='unknown' && candidateCount===0 && r.task_kind==='update'
      && /^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(observation.logical_call_id)
      && deadlineCapture?.version===FILE_AUTHORING_CAPTURE_VERSION && deadlineCapture.attempt_id===a.id
      && deadlineCapture.logical_call_id===observation.logical_call_id && deadlineCapture.run_id===r.id
      && deadlineCapture.job_id===job.id && deadlineCapture.owner_user_id===r.owner_user_id
      && deadlineCapture.project_id===r.project_id && deadlineCapture.input_revision===r.input_revision
      && deadlineCapture.input_hash===String(r.input_hash).trim()
      && isFileAuthoringDeadline(deadlineCapture.deadline_at) && Date.parse(deadlineCapture.deadline_at)<=Date.now();
    const rejected=observation.error_code==='MODEL_PROVIDER_REQUEST_REJECTED' && observation.usage.status==='unknown' && candidateCount===0
      || payloadRejected&&!payloadRecovery;
    const providerBlocked = observation.outcome === 'failed' && observation.usage.status === 'unknown' && candidateCount === 0 &&
      ['MODEL_PROVIDER_BALANCE_EXHAUSTED', 'MODEL_PROVIDER_AUTH_FAILED', 'MODEL_PROVIDER_RATE_LIMITED'].includes(observation.error_code ?? '');
    const failed=observation.outcome==='failed' && (measuredWithoutConflict || rejected);
    const notSent=observation.outcome==='confirmed_not_sent';
    const nextAttemptStatus=complete?'completed':failed?'failed':notSent?'confirmed_not_sent':'pending_reconcile';
    const nextUsageStatus=measuredWithoutConflict?'measured':usageStatus==='unknown'?'unknown':'pending';
    await client.query('UPDATE bb_model_call_attempts SET status=$2,usage_status=$3,provider_request_id=COALESCE(provider_request_id,$4),updated_at=now() WHERE id=$1',[a.id,nextAttemptStatus,nextUsageStatus,observation.provider_request_id]);

    if (complete && result) {
      const checkpoint=checkpointWithResult(job.checkpoint,{logical_call_id:observation.logical_call_id,attempt_no:observation.attempt_no,call_id:a.id,result_id:result.id,result_ref:result.result_ref,result_sha256:result.result_sha256.trim(),result_schema_version:result.result_schema_version});
      await client.query('UPDATE bb_jobs SET checkpoint=$2,updated_at=now() WHERE id=$1',[job.id,checkpoint]);
      await appendRunEvent(client,r,r.state,r.stage??'provider_call','provider_result_reconciled');
      await appendCallFinished(client,observation,'succeeded');
    } else if (integrityInterpretation&&failed&&observation.error_code==='MODEL_OUTPUT_SCHEMA_INVALID') {
      // Keep the lease for a settled, site-local schema
      // failure. Attempt and cost evidence remain durable; the enclosing stage
      // decides the aggregate outcome. Unknown integrity calls still pause below.
      await client.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{deferred_provider_calls}',
        COALESCE(checkpoint->'deferred_provider_calls','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),updated_at=now() WHERE id=$1`,
        [job.id,a.id,JSON.stringify({logical_call_id:observation.logical_call_id,attempt_no:observation.attempt_no,status:nextAttemptStatus,error_code:observation.error_code,usage_status:usageStatus})]);
      await appendRunEvent(client,r,r.state,r.stage??'provider_call','provider_call_deferred','run.progress',eventErrorCode);
      await appendCallFinished(client,observation,failed?'failed':'paused');
    } else if (providerBlocked) {
      const reason = observation.error_code === 'MODEL_PROVIDER_BALANCE_EXHAUSTED' ? 'provider_balance_exhausted' :
        observation.error_code === 'MODEL_PROVIDER_AUTH_FAILED' ? 'provider_auth_failed' : 'provider_rate_limited';
      const code = observation.error_code as ModelAdapterErrorCode;
      const diagnostic = errorDiagnostic({ code, category: 'model_provider', stage: 'provider_reconcile', providerErrorType: reason });
      const errorId = uid();
      await client.query(`INSERT INTO bb_observability_errors
        (id,owner_user_id,project_id,job_id,attempt_id,trace_id,code,category,stage,retry_count,recovery_status,
         provider_error_type,fingerprint,safe_message)
        VALUES($1,$2,$3,$4,$5,$6,$7,'model_provider','provider_reconcile',$8,'not_retried',$9,$10,$11)`,
        [errorId,r.owner_user_id,r.project_id,job.id,a.id,r.id,code,observation.attempt_no-1,reason,diagnostic.fingerprint,diagnostic.safeMessage]);
      await emitInternal(client,internalEvent({kind:'error.recorded',owner:r.owner_user_id,projectId:r.project_id,runId:r.id,jobId:job.id,
        traceId:r.id,stage:'provider_reconcile',error:{error_id:errorId,code,category:'model_provider',retryable:false}}));
      await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
      await appendRunEvent(client,r,'paused','provider_reconcile',reason,'run.state_changed',eventErrorCode);
      await appendCallFinished(client,observation,'paused');
    } else if (deadlineExpiredBeforeSend) {
      // Intent was durable but the host's deadline won before spawn. This attempt
      // is genuinely not sent; prior attempts retain their own unknown usage.
      await client.query("UPDATE bb_jobs SET state='failed',stage='failed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
      await appendRunEvent(client,r,'failed','failed','file_authoring_context_deadline_exhausted','run.state_changed','MODEL_TIMEOUT');
      await appendCallFinished(client,observation,'failed');
    } else if (failed && options.retryable && options.lease) {
      // A settled, measured failure (for example schema-invalid output) may be re-asked
      // as the next attempt number under the same lease; the job keeps running.
      await appendRunEvent(client,r,r.state,r.stage??'provider_call','provider_call_retrying','run.progress',eventErrorCode);
      await appendCallFinished(client,observation,'running');
    } else if (failed) {
      await client.query("UPDATE bb_jobs SET state='failed',stage='failed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
      await appendRunEvent(client,r,'failed','failed','provider_call_failed','run.state_changed',eventErrorCode);
      await appendCallFinished(client,observation,'failed');
    } else if (notSent) {
      await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
      await appendRunEvent(client,r,'paused','provider_reconcile','provider_call_confirmed_not_sent');
      await appendCallFinished(client,observation,'paused');
    } else {
      await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
      await appendRunEvent(client,r,'paused','provider_reconcile',usageStatus==='conflict'?'provider_usage_conflict':resultConflict?'provider_result_conflict':
        contextRotation?'file_authoring_context_rotation_pending':payloadRecovery?'file_authoring_payload_recovery_pending':outputLimitRecovery?'file_authoring_output_limit_recovery_pending':timeoutRecovery?'file_authoring_timeout_recovery_pending':'provider_result_pending',
        'run.state_changed',contextRotation?'MODEL_CONTEXT_ROTATION_REQUIRED':payloadRecovery?'MODEL_PROVIDER_PAYLOAD_TOO_LARGE':outputLimitRecovery?eventErrorCode:timeoutRecovery?'MODEL_TIMEOUT':undefined);
      await appendCallFinished(client,observation,'paused');
    }
    return {attempt_status:nextAttemptStatus,usage_status:usageStatus,idempotent:false};
  });
}

export async function reconcilePausedProviderCall(pool: Pool, blobs: PrivateBlobs, observation: ProviderCallObservation, validateResult: ProviderResultValidator) {
  return recordProviderCallObservation(pool,blobs,observation,validateResult,{source:'reconciliation'});
}

export async function pauseProviderCallForReconciliation(pool: Pool, lease: Lease, reason: 'provider_result_unavailable'|'provider_result_conflict') {
  await transaction(pool,async client=>{
    const r=await getRun(client,lease.owner,lease.runId,true);
    const job=(await client.query("SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 FOR UPDATE",[lease.jobId,lease.owner,lease.runId])).rows[0];
    if (!job || job.state!=='running' || job.lease_token!==lease.token || !job.lease_until || new Date(job.lease_until).getTime()<=Date.now() || ['failed','succeeded','cancelled','rejected'].includes(r.state)) throw new Problem(409,'CAPABILITY_NOT_READY','Cannot pause a stale provider result lease');
    await client.query("UPDATE bb_model_call_attempts SET status='pending_reconcile',usage_status=CASE WHEN usage_status='measured' THEN 'pending' ELSE usage_status END,updated_at=now() WHERE job_id=$1 AND status='completed'",[lease.jobId]);
    await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[lease.jobId]);
    await appendRunEvent(client,r,'paused','provider_reconcile',reason);
  });
}

export async function readCheckpointedProviderResult(input: {
  pool: Pool;
  blobs: PrivateBlobs;
  lease: Lease;
  logicalCallId: string;
  attemptNo: number;
  validateResult: ProviderResultValidator;
}) {
  if (!safeId(input.logicalCallId) || !Number.isSafeInteger(input.attemptNo) || input.attemptNo<1) throw new Error('Invalid replay identity');
  const activeLease=await input.pool.query("SELECT 1 FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 AND run_id=$3 AND state='running' AND lease_token=$4 AND lease_until>now()",[input.lease.owner,input.lease.jobId,input.lease.runId,input.lease.token]);
  if (!activeLease.rowCount) throw new Problem(409,'CAPABILITY_NOT_READY','Provider result reuse requires the active worker lease');
  const q=await input.pool.query(`SELECT a.id,a.status,a.logical_call_id,a.attempt_no,j.checkpoint,j.subtype,u.usage_status,u.conflicting_measurements,r.billing_mode,
    (EXISTS(SELECT 1 FROM bb_commerce_scope_runs coverage JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
      WHERE coverage.owner_user_id=r.owner_user_id AND coverage.run_id=r.id AND scope.amount_fen=0)
    OR EXISTS(SELECT 1 FROM bb_automatic_scope_runs coverage JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
      WHERE coverage.owner_user_id=r.owner_user_id AND coverage.run_id=r.id AND scope.amount_fen=0 AND scope.automatic_price IS NOT NULL)) AS covered_zero_outcome
    FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id JOIN bb_runs r ON r.id=j.run_id JOIN bb_call_usage u ON u.attempt_id=a.id
    WHERE a.owner_user_id=$1 AND a.job_id=$2 AND j.run_id=$3 AND a.logical_call_id=$4 AND a.attempt_no=$5`,[input.lease.owner,input.lease.jobId,input.lease.runId,input.logicalCallId,input.attemptNo]);
  const attempt=q.rows[0];
  if (!attempt) {
    const later=await input.pool.query('SELECT COALESCE(max(attempt_no),0)::int AS max_attempt FROM bb_model_call_attempts WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3',[input.lease.owner,input.lease.jobId,input.logicalCallId]);
    if (input.attemptNo!==Number(later.rows[0].max_attempt)+1) throw new Problem(409,'CAPABILITY_NOT_READY','Provider attempt sequence changed; never reuse an earlier attempt number');
    return null;
  }
  const checkpoint=attempt.checkpoint as Record<string,unknown>;
  const refs=Array.isArray(checkpoint.provider_results)?checkpoint.provider_results as Record<string,unknown>[]:[];
  const matches=refs.filter(entry=>entry.logical_call_id===input.logicalCallId&&entry.attempt_no===input.attemptNo);
  if (matches.length!==1) throw new Problem(409,'CAPABILITY_NOT_READY','Existing provider attempt does not have exactly one reusable checkpoint; supplier reconciliation is required');
  const replay=matches[0];
  const result=(await input.pool.query(`SELECT rr.* FROM bb_provider_result_refs rr
    WHERE rr.owner_user_id=$1 AND rr.project_id=(SELECT project_id FROM bb_runs WHERE owner_user_id=$1 AND id=$2)
      AND rr.job_id=$3 AND rr.run_id=$2 AND rr.logical_call_id=$4 AND rr.attempt_no=$5 AND rr.attempt_id=$6 AND rr.id=$7 AND rr.result_sha256=$8
      AND (SELECT count(*) FROM bb_provider_result_refs candidate WHERE candidate.attempt_id=rr.attempt_id)=1`,[input.lease.owner,input.lease.runId,input.lease.jobId,input.logicalCallId,input.attemptNo,replay.call_id,replay.result_id,replay.result_sha256])).rows[0];
  const fixedPrice=attempt.covered_zero_outcome===true || attempt.billing_mode==='fixed_credits' || attempt.billing_mode==='metered_credits' && ['m4_document_v1','m4_qa_v1'].includes(attempt.subtype);
  if (!result || attempt.status!=='completed' || !fixedPrice && (attempt.usage_status!=='measured' || Number(attempt.conflicting_measurements)>0) || result.result_ref!==replay.result_ref || result.result_schema_version!==replay.result_schema_version || Number(result.byte_size)<1 || result.trace_id!==input.lease.runId) {
    throw new Problem(409,'CAPABILITY_NOT_READY','Provider result or usage is not reconciled; call remains pending');
  }
  const observation=(await input.pool.query("SELECT 1 FROM bb_provider_call_observations WHERE owner_user_id=$1 AND project_id=$2 AND job_id=$3 AND run_id=$4 AND attempt_id=$5 AND result_id=$6 AND ((outcome='completed' AND (usage_status='measured' OR $7)) OR ($7 AND outcome='pending_reconcile' AND finish_reason='stop' AND error_code IN ('MODEL_USAGE_PENDING','USAGE_PENDING'))) LIMIT 1",[input.lease.owner,result.project_id,input.lease.jobId,input.lease.runId,result.attempt_id,result.id,fixedPrice])).rowCount;
  if (!observation) throw new Problem(409,'CAPABILITY_NOT_READY','No verified completed provider observation is available');
  let bytes:Buffer;
  try { bytes=await input.blobs.get(result.result_ref); }
  catch {
    await pauseProviderCallForReconciliation(input.pool,input.lease,'provider_result_unavailable');
    throw new Problem(409,'CAPABILITY_NOT_READY','Provider result Blob is unavailable; call remains pending');
  }
  if (bytes.length!==Number(result.byte_size) || digest(bytes)!==result.result_sha256.trim()) {
    await pauseProviderCallForReconciliation(input.pool,input.lease,'provider_result_unavailable');
    throw new Problem(409,'CAPABILITY_NOT_READY','Provider result Blob hash mismatch; call remains pending');
  }
  const value=await parseAndValidate(bytes,input.validateResult);
  return {value,result_ref:result.result_ref,result_sha256:result.result_sha256.trim(),result_schema_version:result.result_schema_version,call_id:result.call_id,attempt_no:result.attempt_no};
}

export type ModelAttemptRuntime = {
  adapter: 'codex_exec';
  adapter_version: string;
  model_provider: string;
  model_config_version: string;
  provider_request_id_status: 'unknown';
  framework_thread_id: string | null;
  started_at: string;
  duration_ms: number;
  exit_code: number | null;
  exit_signal: string | null;
  finish_reason: string | null;
  error_code: string | null;
  tool_attempts: number;
  pricing_status: 'unknown';
};

// #16/#79 framework-side evidence for one attempt. Written under the active lease;
// an identical replay is idempotent and a different record for the same attempt conflicts.
export async function recordModelAttemptRuntime(pool: Pool, lease: Lease, intent: ProviderCallIntent, runtime: ModelAttemptRuntime) {
  assertIntent(intent);
  if (runtime.adapter!=='codex_exec' || !safeVersion(runtime.adapter_version) || !/^[a-z0-9_-]{1,64}$/.test(runtime.model_provider) || runtime.model_config_version!==intent.model_config_version ||
      runtime.provider_request_id_status!=='unknown' || runtime.pricing_status!=='unknown' || (runtime.framework_thread_id!==null && !safeId(runtime.framework_thread_id)) ||
      !token(runtime.duration_ms) || !token(runtime.tool_attempts) || (runtime.exit_code!==null && !Number.isSafeInteger(runtime.exit_code)) ||
      (runtime.exit_signal!==null && !/^SIG[A-Z0-9]{1,16}$/.test(runtime.exit_signal)) || (runtime.finish_reason!==null && !/^[a-z_]{1,64}$/.test(runtime.finish_reason)) ||
      (runtime.error_code!==null && !safeError(runtime.error_code)) || Number.isNaN(Date.parse(runtime.started_at))) throw new Error('Invalid model attempt runtime');
  if (lease.owner!==intent.owner_user_id || lease.jobId!==intent.job_id || lease.runId!==intent.run_id) throw missing();
  return transaction(pool,async client=>{
    // Match renewal/cancellation's run -> job lock order. The runtime INSERT's
    // run foreign key otherwise takes a KEY SHARE lock while already holding
    // the job lock, which can deadlock a renewal holding the run row.
    const r=await getRun(client,lease.owner,lease.runId,true);
    if(r.project_id!==intent.project_id)throw missing();
    if(['succeeded','test_completed','failed','cancelled','rejected'].includes(r.state))
      throw new Problem(409,'CAPABILITY_NOT_READY','Model attempt runtime lease is no longer active');
    const job=(await client.query('SELECT state,lease_token,lease_until FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.owner,lease.jobId,lease.runId])).rows[0];
    const a=(await client.query('SELECT id FROM bb_model_call_attempts WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4',[intent.owner_user_id,intent.job_id,intent.logical_call_id,intent.attempt_no])).rows[0];
    if (!job || !a || a.id!==intent.call_id) throw missing();
    // Written before the observation, which may pause the job and release the lease.
    if (job.state!=='running' || job.lease_token!==lease.token || !job.lease_until || new Date(job.lease_until).getTime()<=Date.now()) throw new Problem(409,'CAPABILITY_NOT_READY','Model attempt runtime lease is no longer active');
    const existing=(await client.query('SELECT * FROM bb_model_call_attempt_runtime WHERE attempt_id=$1',[a.id])).rows[0];
    if (existing) {
      const same=existing.adapter_version===runtime.adapter_version && existing.duration_ms===runtime.duration_ms && existing.error_code===runtime.error_code && existing.framework_thread_id===runtime.framework_thread_id && existing.tool_attempts===runtime.tool_attempts;
      if (!same) throw new Problem(409,'IDEMPOTENCY_CONFLICT','Model attempt already has different runtime evidence');
      return {idempotent:true};
    }
    await client.query('INSERT INTO bb_model_call_attempt_runtime(id,owner_user_id,project_id,job_id,run_id,trace_id,attempt_id,logical_call_id,attempt_no,adapter,adapter_version,model_provider,model_config_version,provider_request_id_status,framework_thread_id,started_at,duration_ms,exit_code,exit_signal,finish_reason,error_code,tool_attempts,pricing_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)',
      [uid(),intent.owner_user_id,intent.project_id,intent.job_id,intent.run_id,intent.trace_id,a.id,intent.logical_call_id,intent.attempt_no,runtime.adapter,runtime.adapter_version,runtime.model_provider,runtime.model_config_version,runtime.provider_request_id_status,runtime.framework_thread_id,runtime.started_at,runtime.duration_ms,runtime.exit_code,runtime.exit_signal,runtime.finish_reason,runtime.error_code,runtime.tool_attempts,runtime.pricing_status]);
    return {idempotent:false};
  });
}

// Latest durable attempt for a logical call, read under the active lease. Callers use it
// on restart to decide between reuse, a bounded retry, or reconciliation, never a blind resend.
export async function latestProviderAttempt(pool: Pool, lease: Lease, logicalCallId: string) {
  if (!safeId(logicalCallId)) throw new Error('Invalid provider call identity');
  const active=await pool.query("SELECT 1 FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 AND run_id=$3 AND state='running' AND lease_token=$4 AND lease_until>now()",[lease.owner,lease.jobId,lease.runId,lease.token]);
  if (!active.rowCount) throw new Problem(409,'CAPABILITY_NOT_READY','Provider attempt lookup requires the active worker lease');
  const q=await pool.query(`SELECT a.id,a.attempt_no,a.status,a.usage_status,
      COALESCE(j.checkpoint->'operator_reconciliations','{}'::jsonb) ? a.id AS operator_retry,
      EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=a.id) AS observed
    FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id
    WHERE a.owner_user_id=$1 AND a.job_id=$2 AND j.run_id=$3 AND a.logical_call_id=$4
    ORDER BY a.attempt_no DESC LIMIT 1`,[lease.owner,lease.jobId,lease.runId,logicalCallId]);
  const row=q.rows[0];
  if (!row) return null;
  return {call_id:row.id as string,attempt_no:Number(row.attempt_no),status:row.status as 'pending_reconcile'|'confirmed_not_sent'|'completed'|'failed',usage_status:row.usage_status as string,observed:row.observed===true,operator_retry:row.operator_retry===true};
}
