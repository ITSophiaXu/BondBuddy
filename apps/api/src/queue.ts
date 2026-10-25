import { Pool, type PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { date, missing, Problem, run, runDto, transaction, uid, type PrivateBlobs, digest } from './data.js';
import { emitInternal, internalEvent, recordOperation } from './observability.js';
import { AuthoringActivitySchema, type AuthoringActivity, ERROR_CODES, RUN_PAUSE_STAGES, TASK_KINDS, ReviewActionSchema, type ReviewAction, type M4AssistantReply, type ERROR_CATEGORIES, type ErrorCode } from '@bondbuddy/contracts';
import { assertGateOpen, ensureExternalCallsAllowed, guardEvidenceWrite } from './evidence-gate.js';
import { assertModelCallAllowed, reportTrialRejection, trialGuardConfig } from './trial-guard.js';
import { DOCX_LIMITS, inspectDocx, inspectGeneratedWord, GENERATED_WORD_DELIVERY_VERSION, WORD_MEDIA_TYPE, type DocxInspection } from './docx-inspector.js';
import { assertTestGrant } from './non-production-test.js';
import { errorDiagnostic } from './error-diagnostics.js';
import { READ_ONLY_MATERIAL_ADAPTER_VERSION } from './provider-results.js';
import { inputManifestHash } from './production-rule-pin.js';
import { registerGeneratedProspectus } from './prospectus-versions.js';
import { registerProjectFileOutcome } from './project-file-storage.js';

import { syncAuthoringProgress } from './authoring-progress.js';
import { creditBalance,lockCreditAccount } from './billing.js';
import { debitAuthoringCredits } from './authoring-credit-debit.js';

const terminal = new Set(['succeeded','test_completed','failed','cancelled','rejected']);
export type Lease = { jobId:string; runId:string; owner:string; token:string; checkpoint:Record<string,unknown>; attempts:number };
export type RunKind = typeof TASK_KINDS[number];
export function checkedRunKinds(kinds: readonly RunKind[] = TASK_KINDS): RunKind[] {
  if (!kinds.length || kinds.some(kind => !(TASK_KINDS as readonly string[]).includes(kind)) || new Set(kinds).size !== kinds.length)
    throw new Error('Invalid worker run kinds');
  return [...kinds];
}

async function event(client:PoolClient, r:any, state:string, stage:string|null, reason:string, errorCode?:string, type='run.state_changed', audit:Record<string,string>={}) {
  await syncAuthoringProgress(client,r,{state,stage,reason});
  const seq=r.event_cursor+1, id=uid(), trace=r.id;
  const payload={reason,channel:r.channel ?? 'production',...(errorCode?{error_code:errorCode}:{}),...audit};
  await client.query('UPDATE bb_runs SET state=$2,stage=$3,event_cursor=$4,updated_at=now() WHERE id=$1',[r.id,state,stage,seq]);
  await client.query('INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,r.owner_user_id,r.id,seq,trace,type,state,stage,payload]);
  await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),r.owner_user_id,'run',r.id,type,{run_id:r.id,event_id:id,seq,state,stage,...payload}]);
  const job=await client.query('SELECT id FROM bb_jobs WHERE run_id=$1',[r.id]);
  await emitInternal(client,internalEvent({kind:'job.state_changed',owner:r.owner_user_id,projectId:r.project_id,runId:r.id,jobId:job.rows[0]?.id,traceId:trace,status:(state==='settlement_pending'?'paused':state) as any,stage}));
  r.state=state;r.stage=stage;r.event_cursor=seq;
}

// Used by claim, the operator queue and resolve so no paused attempt is invisible.
const fixedPriceRun = "EXISTS(SELECT 1 FROM bb_runs billing_run WHERE billing_run.id=j.run_id AND (billing_run.billing_mode='fixed_credits' OR billing_run.billing_mode='metered_credits' AND j.subtype IN ('m4_document_v1','m4_qa_v1')))";
const needsProviderReconciliation = `(
  a.status='pending_reconcile'
  OR (a.status='failed' AND NOT (COALESCE(j.checkpoint->'operator_reconciliations','{}'::jsonb) ? a.id) AND (
    COALESCE(u.usage_status,'unknown')<>'measured'
    OR COALESCE(u.conflicting_measurements,0)>0
    OR EXISTS (SELECT 1 FROM bb_provider_result_refs p WHERE p.attempt_id=a.id)
    OR NOT EXISTS (SELECT 1 FROM bb_provider_call_observations o
      WHERE o.attempt_id=a.id AND o.outcome='failed' AND o.usage_status='measured')
  ))
  OR (a.status='completed' AND (
    (NOT ${fixedPriceRun} AND (COALESCE(u.usage_status,'unknown')<>'measured'
      OR COALESCE(u.conflicting_measurements,0)>0))
    OR (SELECT count(*) FROM bb_provider_result_refs p WHERE p.attempt_id=a.id)<>1
    OR NOT EXISTS (
      SELECT 1 FROM bb_provider_call_observations o
      JOIN bb_provider_result_refs p ON p.id=o.result_id AND p.attempt_id=o.attempt_id
      WHERE o.attempt_id=a.id AND ((o.outcome='completed' AND (o.usage_status='measured' OR ${fixedPriceRun}))
        OR (${fixedPriceRun} AND o.outcome='pending_reconcile' AND o.finish_reason='stop' AND o.error_code IN ('MODEL_USAGE_PENDING','USAGE_PENDING')))
    )
  ))
)`;

async function providerCallNeedsReconciliation(client:PoolClient, jobId:string) {
  const q=await client.query(`SELECT 1
    FROM bb_model_call_attempts a
    JOIN bb_jobs j ON j.id=a.job_id
    LEFT JOIN bb_call_usage u ON u.attempt_id=a.id
    WHERE a.job_id=$1 AND ${needsProviderReconciliation} LIMIT 1`,[jobId]);
  return !!q.rowCount;
}

export async function enqueue(client:PoolClient, r:any, subtype='default') {
  await client.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,channel,test_grant_id) VALUES($1,$2,$3,$4,$5,'queued','queued',$6,$7)",[uid(),r.owner_user_id,r.id,r.task_kind,subtype,r.channel ?? 'production',r.test_grant_id ?? null]);
  await event(client,{...r,event_cursor:0},'queued','queued','submitted');
}

// Run jobs and #79/#16 platform probes share the lease model but are claimed separately, so the
// run pipeline never picks up a probe and the probe worker never picks up a user run.
export async function claim(pool:Pool, leaseSeconds=30, options:{platformProbe?:boolean; runKinds?:readonly RunKind[]}={}):Promise<Lease|null> {
  const runKinds = checkedRunKinds(options.runKinds);
  return transaction(pool,async client=>{
    // Lock order is run then job in every transition, including cancellation.
    const q=await client.query("SELECT r.* FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE (j.state='queued' OR (j.state='running' AND j.lease_until<now())) AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected') AND (j.job_type='platform_probe')=$1 AND ($1 OR j.job_type=ANY($2::text[])) ORDER BY j.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1",[options.platformProbe===true,runKinds]);
    const r=q.rows[0];if(!r)return null;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[r.id])).rows[0];
    if(j.state==='running' && new Date(j.lease_until).getTime()>=Date.now())return null;
    if(r.channel==='non_production_test'){
      try { await assertTestGrant(client,{grantId:r.test_grant_id,userId:r.owner_user_id,projectId:r.project_id,inputRevision:r.input_revision,inputHash:r.input_hash}); }
      catch(error){
        const code=error instanceof Problem?error.code:'TEST_GRANT_INVALID';
        await client.query("UPDATE bb_jobs SET state='paused',stage='test_grant_invalid',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
        await event(client,r,'paused','test_grant_invalid',code.toLowerCase());
        return null;
      }
    }
    if(await providerCallNeedsReconciliation(client,j.id)){
      await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await event(client,r,'paused','provider_reconcile','provider_reconciliation_required');
      return null;
    }
    const token=uid();
    await client.query("UPDATE bb_jobs SET state='running',stage=CASE WHEN stage='queued' THEN 'claimed' ELSE COALESCE(stage,'claimed') END,lease_token=$2,lease_until=now()+($3::integer * interval '1 second'),attempts=attempts+1,updated_at=now() WHERE id=$1",[j.id,token,leaseSeconds]);
    await event(client,r,'running',j.stage==='queued'?'claimed':j.stage ?? 'claimed',j.state==='running'?'lease_recovered':'claimed');
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
  await transaction(pool,async client=>{const {r}=await lockedLease(client,lease);await client.query("UPDATE bb_jobs SET lease_until=now()+($2::integer * interval '1 second'),updated_at=now() WHERE id=$1",[lease.jobId,leaseSeconds]);await syncAuthoringProgress(client,r);});
}

/** Progress is an owner/lease-checked projection; it never advances the execution stage. */
export async function recordReviewAction(pool:Pool, lease:Lease, action:ReviewAction):Promise<boolean> {
  if (!Value.Check(ReviewActionSchema, action)) throw new Problem(422,'VALIDATION_FAILED','Invalid review action');
  return transaction(pool,async client=>{
    let locked;
    try { locked=await lockedLease(client,lease); }
    catch(error) { if(error instanceof Problem && ['ALREADY_TERMINAL','NOT_FOUND'].includes(error.code))return false;throw error; }
    const {r}=locked;
    if(r.state!=='running')return false;
    const previous=(await client.query(`SELECT payload->'action' AS action FROM bb_run_events
      WHERE owner_user_id=$1 AND run_id=$2 AND type='run.progress' AND payload->'action'->>'action_id'=$3
      ORDER BY seq DESC LIMIT 1`,[lease.owner,lease.runId,action.action_id])).rows[0]?.action as ReviewAction|undefined;
    // Replays cannot reopen a finished action or bind its identity to another kind of work.
    if(previous && (previous.code!==action.code || previous.state===action.state || previous.state!=='started'))return false;
    const seq=Number(r.event_cursor??0)+1,id=uid(),payload={reason:'review_action',action};
    await client.query('UPDATE bb_runs SET event_cursor=$2,updated_at=now() WHERE id=$1',[r.id,seq]);
    await client.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
      VALUES($1,$2,$3,$4,$3,'run.progress',$5,$6,$7)`,[id,lease.owner,r.id,seq,r.state,r.stage,payload]);
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'run',$3,'run.progress',$4)`,[uid(),lease.owner,r.id,{run_id:r.id,event_id:id,seq,state:r.state,stage:r.stage,...payload}]);
    await syncAuthoringProgress(client,r);
    await client.query('UPDATE bb_authoring_progress SET last_activity_at=now() WHERE run_id=$1 AND owner_user_id=$2',[r.id,lease.owner]);
    return true;
  });
}


/** A pause freezes billing immediately and stops execution at a durable boundary. */
export async function pauseAtCheckpoint(pool:Pool,lease:Lease):Promise<boolean>{
  return transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    await syncAuthoringProgress(client,r);
    const creditPause=(await client.query('SELECT credit_pause_requested FROM bb_jobs WHERE id=$1',[j.id])).rows[0].credit_pause_requested;
    if(creditPause){
      await client.query("UPDATE bb_jobs SET state='paused',stage='credits_exhausted',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await event(client,r,'paused','credits_exhausted','credits_exhausted','CREDITS_INSUFFICIENT');
      return true;
    }
    if(!j.user_pause_requested)return false;
    await client.query("UPDATE bb_jobs SET state='paused',stage='user_paused',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
    await event(client,r,'paused','user_paused','user_paused');
    return true;
  });
}
export async function beginRunStage(pool:Pool,lease:Lease,stage:string){
  await transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    if(!['update','generation'].includes(r.task_kind)||(String(j.subtype).startsWith('m4_')&&j.subtype!=='m4_document_v1'))return;
    await client.query('UPDATE bb_jobs SET stage=$2,updated_at=now() WHERE id=$1',[j.id,stage]);
    await event(client,r,'running',stage,'stage_started',undefined,'run.progress');
  });
}
export async function recordAuthoringActivity(pool:Pool,lease:Lease,activity:AuthoringActivity):Promise<boolean>{
  if(!Value.Check(AuthoringActivitySchema,activity))throw new Problem(422,'VALIDATION_FAILED','Invalid authoring activity');
  return transaction(pool,async client=>{
    let locked;
    try{locked=await lockedLease(client,lease);}catch(error){if(error instanceof Problem&&['ALREADY_TERMINAL','NOT_FOUND'].includes(error.code))return false;throw error;}
    const {r,j}=locked;
    if(!['update','generation'].includes(r.task_kind)||r.state!=='running'||j.user_pause_requested||(String(j.subtype).startsWith('m4_')&&j.subtype!=='m4_document_v1'))return false;
    const prior=(await client.query("SELECT payload->'authoring_activity' AS activity FROM bb_run_events WHERE run_id=$1 AND owner_user_id=$2 AND payload->'authoring_activity'->>'activity_id'=$3 ORDER BY seq DESC LIMIT 1",[r.id,lease.owner,activity.activity_id])).rows[0]?.activity;
    if(prior&&(prior.state===activity.state||prior.state!=='started'||prior.code!==activity.code))return false;
    const seq=Number(r.event_cursor??0)+1,id=uid(),payload={reason:'authoring_activity',authoring_activity:activity};
    await client.query('UPDATE bb_runs SET event_cursor=$2,updated_at=now() WHERE id=$1',[r.id,seq]);
    await client.query("INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$3,'run.progress',$5,$6,$7)",[id,lease.owner,r.id,seq,r.state,r.stage,payload]);
    await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'run',$3,'run.progress',$4)",[uid(),lease.owner,r.id,{run_id:r.id,event_id:id,seq,state:r.state,stage:r.stage,...payload}]);
    await client.query('UPDATE bb_authoring_progress SET last_activity_at=now() WHERE run_id=$1 AND owner_user_id=$2',[r.id,lease.owner]);
    return true;
  });
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
    const {r,j}=await lockedLease(client,lease);
    // A private review reassembly may only read its completed durable call. This
    // check uses the locked database checkpoint, never a caller's stale lease copy.
    if(j.checkpoint?.review_assembly_recovery)
      throw new Problem(409,'CAPABILITY_NOT_READY','Review reassembly is reuse-only; new provider calls are forbidden');
    if(r.channel==='non_production_test')await assertTestGrant(client,{grantId:r.test_grant_id,userId:r.owner_user_id,projectId:r.project_id,inputRevision:r.input_revision,inputHash:r.input_hash});
    // #35: kill switch, deny override and the daily token quota are re-checked before every call.
    await assertModelCallAllowed(client,trialGuardConfig(),lease.owner);
    if(metadata.promptSnapshotId){
      const ref=await client.query('SELECT 1 FROM bb_snapshot_refs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND run_id=$4',[metadata.promptSnapshotId,lease.owner,r.project_id,r.id]);
      if(!ref.rowCount)throw missing();
    }
    const sequence=await client.query('SELECT COALESCE(max(attempt_no),0)::int AS last_attempt FROM bb_model_call_attempts WHERE job_id=$1 AND logical_call_id=$2',[lease.jobId,logicalCallId]);
    if(attemptNo!==Number(sequence.rows[0].last_attempt)+1)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider attempt numbers must increase monotonically');
    await client.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,prompt_snapshot_id,channel) VALUES($1,$2,$3,$4,$5,'pending_reconcile',$6,$7,$8)",[attemptId,lease.owner,lease.jobId,logicalCallId,attemptNo,metadata.modelId??null,metadata.promptSnapshotId??null,r.channel]);
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

export async function action(pool:Pool,owner:string,runId:string,kind:'cancel'|'resume'|'pause',requestId?:string) {
  return transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j)throw missing();
    if(terminal.has(r.state))throw new Problem(409,'ALREADY_TERMINAL','Run already finished');
    if(kind==='pause'){
      if(!['update','generation','review'].includes(r.task_kind)||(String(j.subtype).startsWith('m4_')&&j.subtype!=='m4_document_v1'))
        throw new Problem(422,'VALIDATION_FAILED','This task does not support pausing');
      if(r.stage==='credits_exhausted'){
        await client.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[j.id]);
        return runDto(r);
      }
      if(j.user_pause_requested||r.state==='paused')return runDto(r);
      if(!['queued','running'].includes(r.state))throw new Problem(409,'INPUT_REVISION_CONFLICT','Task cannot pause at this stage');
      await client.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[j.id]);
      if(j.state==='queued'){
        await client.query("UPDATE bb_jobs SET state='paused',stage='user_paused',lease_token=NULL,lease_until=NULL WHERE id=$1",[j.id]);
        await event(client,r,'paused','user_paused','user_paused');
      }else await event(client,r,r.state,r.stage,'user_pause_requested');
      return runDto({...r,updated_at:new Date()});
    }
    if(kind==='resume'&&j.credit_pause_requested){
      await lockCreditAccount(client,owner);
      if((await creditBalance(client,owner)).available<1)throw new Problem(402,'CREDITS_INSUFFICIENT','积分已用完，请充值后继续本次任务。');
      if(r.state==='running')throw new Problem(409,'INPUT_REVISION_CONFLICT','正在保存当前进度，保存后自动继续。');
      await client.query('UPDATE bb_jobs SET credit_pause_requested=false WHERE id=$1',[j.id]);
    }
    // A user may undo a pending pause while the model is saving its current result.
    if(kind==='resume'&&r.state==='running'&&j.user_pause_requested){
      await client.query('UPDATE bb_jobs SET user_pause_requested=false WHERE id=$1',[j.id]);
      await event(client,r,r.state,r.stage,'user_resumed');
      return runDto({...r,updated_at:new Date()});
    }
    if(kind==='resume'){
      if(r.state!=='paused')throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not paused');
      if(await providerCallNeedsReconciliation(client,j.id))throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs a durable result and verified usage before resume');
      if(j.stage==='trial_limit')await assertModelCallAllowed(client,trialGuardConfig(),owner);
      if(r.task_kind==='update' && r.stage==='capability_not_ready' && j.stage==='capability_not_ready'){
        const latest=await client.query(`SELECT payload->>'reason' AS reason FROM bb_run_events
          WHERE owner_user_id=$1 AND run_id=$2 AND state='paused' AND type='run.state_changed'
          ORDER BY seq DESC LIMIT 1`,[owner,runId]);
        if(latest.rows[0]?.reason==='issuer_identity_source_missing_unreviewed_or_conflicting'){
          const input=await client.query(`SELECT input_hash,manifest FROM bb_input_revisions
            WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,[owner,r.project_id,r.input_revision]);
          if(!input.rows[0] || String(input.rows[0].input_hash).trim()!==String(r.input_hash).trim())
            throw new Problem(409,'INPUT_REVISION_CONFLICT','Locked input changed');
          const manifest=input.rows[0].manifest;
          if(manifest?.issuer_identity?.status==='pending' &&
             manifest.issuer_identity.reason==='issuer_identity_source_missing_unreviewed_or_conflicting' &&
             !manifest.test_issuer_candidate)
            throw new Problem(409,'CAPABILITY_NOT_READY',
              'Issuer identity source is unresolved in this locked input; verify the source and create a new input revision');
        }
      }
    }
    if(kind==='resume')await client.query('UPDATE bb_jobs SET user_pause_requested=false WHERE id=$1',[j.id]);
    await client.query('UPDATE bb_jobs SET state=$2,stage=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[j.id,kind==='cancel'?'cancelled':'queued',kind==='cancel'?'cancelled':'queued']);
    await event(client,r,kind==='cancel'?'cancelled':'queued',kind==='cancel'?'cancelled':'queued',kind==='cancel'?'user_cancelled':'user_resumed');
    if(requestId)await recordOperation(client,{owner,projectId:r.project_id,runId,jobId:j.id,requestId,traceId:runId,kind:kind==='cancel'?'run_cancel':'run_resume',status:'submitted'});
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
    const currentRun=await run(client,lease.owner,lease.runId);
    const deliveryStatus=currentRun.channel==='non_production_test'?'test_only':'available';
    const artifact=await ensureWordArtifact(client,lease,inspection,identity);
    if(artifact.quality_status!=='passed')throw new Problem(409,'IDEMPOTENCY_CONFLICT','Word artifact quality state changed');
    const id=await recordWordEvidence(client,lease,identity.artifactId,identity.artifactVersion,inspection,'passed','available','readback_verified',{sha256:inspection.sha256,byteSize:inspection.byte_size});
    await client.query(`UPDATE bb_artifact_versions SET delivery_status=$6,word_delivery_evidence_id=$3
      WHERE id=$1 AND version=$2 AND owner_user_id=$4 AND run_id=$5`,[identity.artifactId,identity.artifactVersion,id,lease.owner,lease.runId,deliveryStatus]);
    return id;
  });
  return {status:'available',...identity,evidenceId,sha256:inspection.sha256,byteSize:inspection.byte_size,deliveryCode:'readback_verified',inspection};
}

// Generated pairs use file availability only; legacy processors retain their inspector.
// Both policies require owned private storage and byte-for-byte readback.
export async function promoteWordArtifact(pool:Pool,lease:Lease,candidate:Buffer,blobs:PrivateBlobs,policy?:import('@bondbuddy/contracts').GeneratedWordDeliveryPolicy):Promise<WordPromotionResult> {
  const inspection=(policy==='generated_pair_v1'||policy==='generated_review_v1')?inspectGeneratedWord(candidate):inspectDocx(candidate);
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

/** PDF comments are source overlays checked by the trusted Python writer, not Word candidates. */
export async function promoteReviewPdfArtifact(pool:Pool,lease:Lease,bytes:Buffer,blobs:PrivateBlobs):Promise<
  {status:'available';artifactId:string;artifactVersion:number} | {status:'unavailable';failureCode:'WORD_DELIVERY_UNAVAILABLE'}> {
  const unavailable = {status:'unavailable' as const,failureCode:'WORD_DELIVERY_UNAVAILABLE' as const};
  if(bytes.length < 8 || bytes.length > 100*1024*1024 || bytes.subarray(0,5).toString() !== '%PDF-')return unavailable;
  const sha=digest(bytes),artifactId=`review-pdf-${digest(`${lease.owner}\n${lease.runId}\n${sha}`)}`;
  const key=`users/${lease.owner}/runs/${lease.runId}/artifacts/${artifactId}/v1.pdf`;
  const check=async(client:PoolClient)=>{
    const run=await assertLockedWordLease(client,lease);
    if(!(await client.query("SELECT 1 FROM bb_review_executions WHERE owner_user_id=$1 AND run_id=$2 AND operation IN ('full_review','differential_review')",[lease.owner,lease.runId])).rowCount)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','PDF annotation requires a review execution');
    return run;
  };
  await transaction(pool,check);
  try {
    await blobs.put(key,bytes,'application/pdf');
    const readback=await blobs.getIfExistsBounded(key,100*1024*1024);
    if(!readback || readback.length!==bytes.length || digest(readback)!==sha)return unavailable;
  } catch {return unavailable;}
  await transaction(pool,async client=>{
    const run=await check(client),status=run.channel==='non_production_test'?'test_only':'available';
    const input=(await client.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[lease.owner,run.project_id,run.input_revision])).rows[0];
    const source=input?.manifest?.review?.input?.source_material_ref;
    if(!source)throw new Problem(409,'INPUT_REVISION_CONFLICT','Missing reviewed source');
    const evidenceId=`pdf-delivery-${digest(`${lease.owner}\n${lease.runId}\n${sha}`)}`;
    await client.query(`INSERT INTO bb_review_pdf_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,sha256,byte_size,object_key,source_material_id,source_material_version,source_sha256)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,[evidenceId,lease.owner,lease.runId,artifactId,sha,bytes.length,key,source.material_id,source.material_version,source.sha256]);
    const evidence=(await client.query('SELECT * FROM bb_review_pdf_delivery_evidence WHERE id=$1',[evidenceId])).rows[0];
    if(evidence.owner_user_id!==lease.owner || evidence.run_id!==lease.runId || evidence.artifact_id!==artifactId || evidence.artifact_version!==1
      || evidence.sha256.trim()!==sha || Number(evidence.byte_size)!==bytes.length || evidence.object_key!==key
      || evidence.source_material_id!==source.material_id || evidence.source_material_version!==source.material_version || evidence.source_sha256.trim()!==source.sha256)
      throw new Problem(409,'IDEMPOTENCY_CONFLICT','PDF delivery evidence changed');
    await client.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,review_pdf_delivery_evidence_id)
      VALUES($1,1,$2,$3,'application/pdf',$4,$5,'passed',$6,$7) ON CONFLICT(id,version) DO NOTHING`,[artifactId,lease.owner,lease.runId,sha,key,status,evidenceId]);
    const a=(await client.query('SELECT * FROM bb_artifact_versions WHERE id=$1 AND version=1 FOR UPDATE',[artifactId])).rows[0];
    if(a.owner_user_id!==lease.owner || a.run_id!==lease.runId || a.sha256.trim()!==sha || a.object_key!==key || a.media_type!=='application/pdf' || a.quality_status!=='passed' || a.delivery_status!==status || a.review_pdf_delivery_evidence_id!==evidenceId)
      throw new Problem(409,'IDEMPOTENCY_CONFLICT','PDF annotation identity changed');
  });
  return {status:'available',artifactId,artifactVersion:1};
}

async function revokeWordArtifactAfterReadbackFailure(pool:Pool,lease:Lease,artifact:any,deliveryCode:'blob_missing'|'blob_too_large'|'blob_read_failed'|'blob_hash_mismatch',readback?:{sha256:string;byteSize:number}) {
  await transaction(pool,async client=>{
    await lockedLease(client,lease);
    const q=await client.query(`SELECT e.validator_version,e.byte_size AS evidence_byte_size,e.quality_evidence
      FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e
        ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.version=$4
        AND a.word_delivery_evidence_id=$5 AND a.sha256=$6
        AND a.quality_status='passed' AND a.delivery_status IN ('available','test_only')
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

export async function finish(pool:Pool,lease:Lease,outcome:'failed'|'succeeded'|'test_completed',options:{errorCode?:string;artifactId?:string;artifactVersion?:number;blobs?:PrivateBlobs;failedStage?:string}={}) {
  // Verify bytes before the terminal transaction; re-check immutable metadata inside it.
  let artifact:any;
  if(outcome==='succeeded' || outcome==='test_completed'){
    if(!options.artifactId || !options.artifactVersion || !options.blobs)throw new Problem(422,'DELIVERY_FAILED','Verified Word artifact required');
    const q=await pool.query(`SELECT a.*,e.validator_version,e.byte_size AS evidence_byte_size,e.quality_evidence
      FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e
        ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
      WHERE a.owner_user_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.version=$4
        AND a.media_type=$5 AND a.quality_status='passed' AND a.delivery_status=$6
        AND e.artifact_id=a.id AND e.artifact_version=a.version AND e.candidate_sha256=a.sha256
        AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
        AND e.readback_sha256=e.candidate_sha256 AND e.readback_byte_size=e.byte_size`,
    [lease.owner,lease.runId,options.artifactId,options.artifactVersion,WORD_MEDIA_TYPE,outcome==='test_completed'?'test_only':'available']);
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
    const inspection=artifact.validator_version===GENERATED_WORD_DELIVERY_VERSION?inspectGeneratedWord(bytes):inspectDocx(bytes);
    const evidence=artifact.quality_evidence as DocxInspection;
    if(inspection.quality_status!=='passed' || inspection.validator_version!==artifact.validator_version
      || inspection.sha256!==artifact.sha256.trim() || inspection.byte_size!==Number(artifact.evidence_byte_size)
      || evidence?.quality_status!=='passed' || evidence.validator_version!==inspection.validator_version
      || evidence.sha256!==inspection.sha256 || evidence.byte_size!==inspection.byte_size)
      throw new Problem(422,'DELIVERY_FAILED','Word artifact quality evidence mismatch');
  }
  return transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    // Charge the remaining locked price only when delivery is ready. Insufficient funds preserve the pair.
    if(outcome==='succeeded'&&!j.user_pause_requested){
      if(j.subtype==='m4_document_v1'){
        const ready=await client.query(`SELECT a.kind,v.id FROM bb_m4_artifacts a
          JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
          JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id
          WHERE a.run_id=$1 AND a.owner_user_id=$2 AND a.kind IN ('document','preparation_note')
            AND v.delivery_status='available' AND e.artifact_id=v.id AND e.artifact_version=v.version
            AND e.delivery_code='readback_verified' AND e.delivery_status='available' AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256
          FOR UPDATE OF v`,[r.id,r.owner_user_id]);
        if(ready.rowCount!==2||!ready.rows.some(a=>a.kind==='document'&&a.id===artifact.id))
          throw new Problem(422,'DELIVERY_FAILED','Material document and preparation note required for settlement');
      }else if(j.subtype==='project_qa_v1'){
        const ready=(await client.query('SELECT operation,result,manifest FROM bb_project_qa_runs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3',[r.owner_user_id,r.project_id,r.id])).rows[0];
        if(!ready?.result||ready.operation==='answer'&&ready.result.answers.length!==ready.manifest.questions.length||ready.result.document.sha256!==artifact.sha256.trim())
          throw new Problem(422,'DELIVERY_FAILED','Question coverage and filled Word required');
      }else if(j.subtype==='integrity_v1'){
        const ready=await client.query("SELECT i.operation,i.result FROM bb_integrity_runs i WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.run_id=$3",[r.owner_user_id,r.project_id,r.id]);
        if(!ready.rowCount||ready.rows[0].operation==='check'&&!ready.rows[0].result?.records?.some((v:any)=>v.search_performed===true))
          throw new Problem(422,'DELIVERY_FAILED','Integrity workpaper requires recorded actual search');
      }else if(r.billing_mode==='fixed_credits'&&r.task_kind!=='review'){
        const pair=j.checkpoint?.stages?.word_delivery_pair;
        if(!pair?.revision_artifact_id||!pair?.clean_artifact_id||pair.revision_artifact_id!==artifact.id)
          throw new Problem(422,'DELIVERY_FAILED','Both generated Word files required for settlement');
        for(const id of [pair.revision_artifact_id,pair.clean_artifact_id]){
          const ready=await client.query(`SELECT 1 FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e ON e.id=a.word_delivery_evidence_id
            WHERE a.id=$1 AND a.owner_user_id=$2 AND a.run_id=$3 AND a.delivery_status='available'
              AND e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.artifact_id=a.id AND e.artifact_version=a.version
              AND e.delivery_code='readback_verified' AND e.delivery_status='available' AND e.readback_sha256=a.sha256 AND e.candidate_sha256=a.sha256
            FOR UPDATE OF a`,[id,r.owner_user_id,r.id]);
          if(!ready.rowCount)throw new Problem(422,'DELIVERY_FAILED','Both generated Word files required for settlement');
        }
      }
      if(r.channel!=='production')throw new Problem(409,'TEST_GRANT_MISMATCH','Run channel cannot enter this terminal state');
      if(await providerCallNeedsReconciliation(client,j.id))throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs reconciliation');
      const debit=await debitAuthoringCredits(client,r,Number.MAX_SAFE_INTEGER);
      if(debit&&debit.charged<debit.ceiling){
        await client.query("UPDATE bb_jobs SET credit_pause_requested=true,state='paused',stage='credits_exhausted',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
        await event(client,r,'paused','credits_exhausted','credits_exhausted','CREDITS_INSUFFICIENT');
        return runDto({...r,updated_at:new Date()});
      }
    }
    // Pause acceptance and success settlement serialize on the same run/job locks.
    if(outcome!=='failed'&&j.user_pause_requested){
      await client.query("UPDATE bb_jobs SET state='paused',stage='user_paused',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await event(client,r,'paused','user_paused','user_paused');
      return runDto({...r,updated_at:new Date()});
    }
    if(r.channel==='non_production_test')await assertTestGrant(client,{grantId:r.test_grant_id,userId:r.owner_user_id,projectId:r.project_id,inputRevision:r.input_revision,inputHash:r.input_hash});
    if((r.channel==='non_production_test' && outcome==='succeeded') || (r.channel==='production' && outcome==='test_completed'))throw new Problem(409,'TEST_GRANT_MISMATCH','Run channel cannot enter this terminal state');
    if(await providerCallNeedsReconciliation(client,lease.jobId))throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs reconciliation');
    if(outcome==='succeeded' || outcome==='test_completed'){
      const q=await client.query(`SELECT 1 FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e
        ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
        WHERE a.owner_user_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.version=$4 AND a.object_key=$5 AND a.sha256=$6
          AND a.media_type=$7 AND a.quality_status='passed' AND a.delivery_status=$8
          AND e.artifact_id=a.id AND e.artifact_version=a.version AND e.candidate_sha256=a.sha256
          AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
          AND e.readback_sha256=e.candidate_sha256 AND e.readback_byte_size=e.byte_size
        FOR UPDATE OF a`,[lease.owner,lease.runId,artifact.id,artifact.version,artifact.object_key,artifact.sha256,WORD_MEDIA_TYPE,outcome==='test_completed'?'test_only':'available']);
      if(!q.rowCount)throw new Problem(422,'DELIVERY_FAILED','Word artifact changed');
      await client.query('UPDATE bb_runs SET artifact_id=$2,artifact_version=$3 WHERE id=$1',[r.id,artifact.id,artifact.version]);
    }
    await client.query('UPDATE bb_jobs SET state=$2,stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[lease.jobId,outcome]);
    if(outcome==='failed')await recordRunFailure(client,r,lease.jobId,options.errorCode,options.failedStage);
    await event(client,r,outcome,outcome,outcome==='failed'?'processor_failed':'word_delivered',options.errorCode);
    if(outcome==='succeeded'){
      await registerGeneratedProspectus(client,r,j.checkpoint?.stages?.word_delivery_pair);
      await registerProjectFileOutcome(client,r,artifact,j.checkpoint?.stages?.word_delivery_pair);
    }
    return runDto({...r,artifact_id:artifact?.id??null,updated_at:new Date()});
  });
}

/** M4 QA completes with its persisted text result; legacy Word delivery stays unchanged. */
export async function finishM4Qa(pool:Pool,lease:Lease,reply:M4AssistantReply) {
  const {completeM4Qa,settleM4Metering}=await import('./m4-workspace.js');
  return transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    if(j.subtype!=='m4_qa_v1' || r.task_kind!=='qa' || r.channel!=='production')throw new Problem(422,'VALIDATION_FAILED','M4 QA lease required');
    if(await providerCallNeedsReconciliation(client,lease.jobId))throw new Problem(409,'CAPABILITY_NOT_READY','QA provider call needs reconciliation');
    const artifact=await completeM4Qa(client,lease.owner,lease.runId,reply);
    const metering=await settleM4Metering(client,lease.owner,lease.runId);
    await client.query('UPDATE bb_runs SET artifact_id=$2,artifact_version=$3 WHERE id=$1',[r.id,artifact.artifactId,artifact.artifactVersion]);
    if(!metering.ready){
      await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[lease.jobId]);
      await event(client,r,'settlement_pending','provider_reconcile','m4_usage_pending');
      return runDto({...r,artifact_id:artifact.artifactId,artifact_version:artifact.artifactVersion,updated_at:new Date()});
    }
    await client.query("UPDATE bb_jobs SET state='succeeded',stage='succeeded',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[lease.jobId]);
    await event(client,r,'succeeded','succeeded','qa_text_delivered');
    return runDto({...r,artifact_id:artifact.artifactId,artifact_version:artifact.artifactVersion,updated_at:new Date()});
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
  const diagnostic=errorDiagnostic({code,category,stage:safeStage,recoveryStatus:'terminal'});
  await client.query(`INSERT INTO bb_observability_errors(id,owner_user_id,project_id,job_id,trace_id,code,category,stage,retry_count,recovery_status,fingerprint,safe_message)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'terminal',$10,$11)`,[id,r.owner_user_id,r.project_id,jobId,r.id,code,category,safeStage,attempts,diagnostic.fingerprint,diagnostic.safeMessage]);
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
export async function pauseRun(pool:Pool,lease:Lease,stage:typeof RUN_PAUSE_STAGES[number],reason:string,errorCode?:string) {
  if(!RUN_PAUSE_STAGES.includes(stage)||!/^[a-z][a-z0-9_]{0,63}$/.test(reason))throw new Problem(422,'VALIDATION_FAILED','Invalid pause');
  if(errorCode && !(ERROR_CODES as readonly string[]).includes(errorCode))throw new Problem(422,'VALIDATION_FAILED','Invalid pause error code');
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    await client.query("UPDATE bb_jobs SET state='paused',stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[lease.jobId,stage]);
    await event(client,r,'paused',stage,reason,errorCode);
  });
}

/** Trusted runtime resume (never a browser principal): re-queues a paused run whose blocker cleared. */
export async function resumePausedRun(pool:Pool,owner:string,runId:string,reason:'materials_ready'|'provider_reconciled'|'trial_limit_cleared'|'credits_recharged') {
  return transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j||!['paused','settlement_pending'].includes(r.state)||j.state!=='paused')return false;
    if(reason==='credits_recharged'){
      if(r.stage!=='credits_exhausted'||!j.credit_pause_requested||j.user_pause_requested)return false;
      await lockCreditAccount(client,owner);
      if((await creditBalance(client,owner)).available<1)return false;
    }else if(j.user_pause_requested)return false;
    if(await providerCallNeedsReconciliation(client,j.id))return false;
    // Another blocker may have won while the in-flight result was being saved.
    // Once it clears, retain the credit blocker rather than strand the run in that old stage.
    if(j.credit_pause_requested&&reason!=='credits_recharged'){
      await lockCreditAccount(client,owner);
      if((await creditBalance(client,owner)).available<1){
        await client.query("UPDATE bb_jobs SET stage='credits_exhausted',updated_at=now() WHERE id=$1",[j.id]);
        await event(client,r,'paused','credits_exhausted','credits_exhausted','CREDITS_INSUFFICIENT');
        return false;
      }
    }
    if(r.billing_mode==='metered_credits' && j.subtype.startsWith('m4_') &&
      (r.state==='settlement_pending' || (await client.query('SELECT 1 FROM bb_m4_artifacts WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rowCount)){
      const {settleM4Metering}=await import('./m4-billing.js');
      const metered=await settleM4Metering(client,owner,runId);if(!metered.ready)return false;
    }
    const nextStage=reason==='credits_recharged'?'queued':j.stage;
    await client.query("UPDATE bb_jobs SET state='queued',stage=$2,credit_pause_requested=false,updated_at=now() WHERE id=$1",[j.id,nextStage]);
    await event(client,r,'queued',nextStage,reason);
    return true;
  });
}

/** Paused runs at a stage, oldest first; the runtime sweeps them after their blocker may have cleared. */
export async function pausedRuns(pool:Pool,stage:typeof RUN_PAUSE_STAGES[number],limit=20,runKinds?:readonly RunKind[]) {
  const q=await pool.query("SELECT j.id AS job_id,j.run_id,j.owner_user_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE j.job_type<>'parse' AND j.state='paused' AND j.stage=$1 AND (r.state='paused' OR r.state='settlement_pending' AND j.subtype IN ('m4_document_v1','m4_qa_v1')) AND ($3::text[] IS NULL OR j.job_type=ANY($3::text[])) AND ($1<>'credits_exhausted' OR (NOT j.user_pause_requested AND EXISTS(SELECT 1 FROM bb_credit_lots l WHERE l.owner_user_id=r.owner_user_id AND l.remaining>l.frozen AND (l.expires_at IS NULL OR l.expires_at>now())))) ORDER BY j.updated_at,j.id LIMIT $2",[stage,limit,runKinds ? checkedRunKinds(runKinds) : null]);
  return q.rows as {job_id:string;run_id:string;owner_user_id:string}[];
}

export type OperatorReconcileDecision = 'retry_unknown_usage' | 'fail_run';

/** M1 authoring can retry a locally terminated timeout, never an unobserved/crashed call.
 * The original supplier usage stays unknown. Row locks bound retries across worker sweeps.
 * Completed results and any contradictory evidence always go through reconciliation.
 */
export async function recoverUnifiedTimeout(pool:Pool,owner:string,runId:string,jobId:string) {
  return transaction(pool,async client=>{
    const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[runId,owner])).rows[0];
    if(!r || r.state!=='paused' || r.stage!=='provider_reconcile')return false;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND run_id=$2 AND owner_user_id=$3 FOR UPDATE',[jobId,runId,owner])).rows[0];
    if(!j || j.state!=='paused' || j.stage!=='provider_reconcile' || j.lease_token || j.lease_until)return false;
    const input=await client.query(`SELECT 1 FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2
      AND revision=$3 AND input_hash=$4 AND manifest->'update_details'->>'authoring_mode'='unified_v1'`,
      [owner,r.project_id,r.input_revision,r.input_hash]);
    if(!input.rowCount)return false;
    const unresolved=await client.query(`SELECT a.*,u.usage_status AS observed_usage,t.error_code,t.exit_code,t.exit_signal,t.tool_attempts,t.adapter,t.adapter_version
      FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id
      LEFT JOIN bb_call_usage u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
      WHERE a.job_id=$1 AND a.owner_user_id=$2 AND ${needsProviderReconciliation}`,[jobId,owner]);
    if(unresolved.rows.length!==1)return false;
    const a=unresolved.rows[0];
    const legacyTextOnly=/^unified-v3-(read_\d+_\d+(?:_part_[01])?|update_\d+|outline|draft_\d+)$/.test(a.logical_call_id) && a.tool_attempts===0;
    const materialReads=/^unified-v4-(update_\d+|outline|draft_\d+)$/.test(a.logical_call_id) &&
      a.adapter==='codex_exec' && a.adapter_version===READ_ONLY_MATERIAL_ADAPTER_VERSION;
    if(a.status!=='pending_reconcile' || !(legacyTextOnly || materialReads) ||
      a.observed_usage!=='unknown' || a.error_code!=='MODEL_TIMEOUT' ||
      !(a.exit_code!==null || ['SIGTERM','SIGKILL'].includes(a.exit_signal)))return false;
    const evidence=await client.query(`SELECT
      EXISTS(SELECT 1 FROM bb_provider_result_refs WHERE attempt_id=$1) AS has_result,
      EXISTS(SELECT 1 FROM bb_provider_call_observations WHERE attempt_id=$1 AND outcome='pending_reconcile'
        AND error_code='MODEL_TIMEOUT' AND usage_status='unknown' AND result_id IS NULL) AS timeout_observed,
      EXISTS(SELECT 1 FROM bb_provider_call_observations WHERE attempt_id=$1 AND
        (outcome<>'pending_reconcile' OR error_code IS DISTINCT FROM 'MODEL_TIMEOUT' OR usage_status<>'unknown' OR result_id IS NOT NULL)) AS conflicting,
      EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=$2 AND logical_call_id=$3 AND attempt_no>$4) AS newer`,
      [a.id,jobId,a.logical_call_id,a.attempt_no]);
    const e=evidence.rows[0];
    if(e.has_result || !e.timeout_observed || e.conflicting || e.newer)return false;
    const history=Object.values(j.checkpoint?.operator_reconciliations ?? {}) as {reason_code?:string;logical_call_id?:string}[];
    const retries=history.filter(h=>h.reason_code==='terminated_timeout_auto_retry');
    const exhausted=retries.length>=6 || retries.filter(h=>h.logical_call_id===a.logical_call_id).length>=2;
    const audit={actor:'worker_timeout_recovery',reason_code:exhausted?'terminated_timeout_retries_exhausted':'terminated_timeout_auto_retry',
      attempt_id:a.id,logical_call_id:a.logical_call_id,decision:exhausted?'fail_run':'retry_unknown_usage'};
    // Reuse the durable retry disposition understood by claim/latestProviderAttempt;
    // no observation or usage is rewritten into a fabricated successful/not-sent call.
    await client.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',
      COALESCE(checkpoint->'operator_reconciliations','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true),updated_at=now() WHERE id=$1`,
      [jobId,a.id,JSON.stringify(audit)]);
    if(exhausted){
      await client.query("UPDATE bb_jobs SET state='failed',stage='failed' WHERE id=$1",[jobId]);
      await recordRunFailure(client,r,jobId,'MODEL_TIMEOUT','provider_reconcile');
      await event(client,r,'failed','failed','provider_timeout_retries_exhausted','MODEL_TIMEOUT','run.state_changed',audit);
    }else{
      await client.query("UPDATE bb_model_call_attempts SET status='failed',updated_at=now() WHERE id=$1",[a.id]);
      await client.query("UPDATE bb_jobs SET state='queued',stage='queued' WHERE id=$1",[jobId]);
      await event(client,r,'queued','queued','provider_timeout_retry_scheduled',undefined,'run.state_changed',audit);
    }
    return true;
  });
}
const operatorField = /^[A-Za-z0-9_.@-]{1,128}$/;
const operatorReason = /^[a-z][a-z0-9_]{1,63}$/;

/** Private recovery of a failed full-review assembler, using the exact completed
 * CLI result. No public failed-run resume, new input, provider call or usage rewrite.
 * The worker still validates its pinned tools/schema and delivers through its normal pipeline.
 */
export async function requeueFailedReviewAssembly(pool:Pool,blobs:PrivateBlobs,input:{runId:string;attemptId:string;resultSha256:string;actor:string}) {
  if(![input.runId,input.attemptId,input.actor].every(v=>operatorField.test(v))||!/^[a-f0-9]{64}$/.test(input.resultSha256))
    throw new Problem(422,'VALIDATION_FAILED','Invalid review recovery identity');
  return transaction(pool,async client=>{
    // Share project -> run -> job lock order with submission and report registration.
    // This first read is scope only; the immutable run is re-read under its lock.
    const scope=(await client.query('SELECT project_id,owner_user_id FROM bb_runs WHERE id=$1',[input.runId])).rows[0];
    if(!scope)throw missing();
    const project=(await client.query('SELECT kind,deleted_at FROM bb_projects WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[scope.project_id,scope.owner_user_id])).rows[0];
    const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[input.runId])).rows[0];
    if(!r)throw missing();
    if(r.project_id!==scope.project_id||r.owner_user_id!==scope.owner_user_id)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Review recovery scope changed');
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[r.id,r.owner_user_id])).rows[0];
    if(!j)throw missing();
    const prior=j.checkpoint?.review_assembly_recovery;
    if(prior){
      if(prior.policy!=='review_assembly_v1'||prior.reuse_only!==true||prior.attempt_id!==input.attemptId||prior.result_sha256!==input.resultSha256||prior.actor!==input.actor)
        throw new Problem(409,'IDEMPOTENCY_CONFLICT','Review recovery already has another identity');
      return {run_id:r.id,attempt_id:input.attemptId,result_sha256:input.resultSha256,idempotent:true};
    }
    const refuse=()=>new Problem(409,'INPUT_REVISION_CONFLICT','No recoverable completed full-review result');
    if(r.channel!=='production'||r.task_kind!=='review'||r.state!=='failed'||j.state!=='failed'||j.error_code!=='VALIDATION_FAILED'||j.lease_token||j.lease_until||r.artifact_id)
      throw refuse();
    // Serialize with submissions and other recoveries; the M3 database mutex remains in force.
    if(!project||project.kind!=='review'||project.deleted_at)throw refuse();
    const active=await client.query("SELECT 1 FROM bb_runs WHERE project_id=$1 AND owner_user_id=$2 AND state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')",[r.project_id,r.owner_user_id]);
    const artifacts=await client.query('SELECT 1 FROM bb_review_reports WHERE run_id=$1 UNION ALL SELECT 1 FROM bb_review_artifacts WHERE run_id=$1 UNION ALL SELECT 1 FROM bb_artifact_versions WHERE run_id=$1',[r.id]);
    if(active.rowCount||artifacts.rowCount||await providerCallNeedsReconciliation(client,j.id))throw refuse();
    const last=(await client.query('SELECT payload FROM bb_run_events WHERE run_id=$1 AND seq=$2',[r.id,r.event_cursor])).rows[0]?.payload;
    const failure=(await client.query("SELECT id FROM bb_observability_errors WHERE owner_user_id=$1 AND project_id=$2 AND job_id=$3 AND trace_id=$4 AND code='VALIDATION_FAILED' AND stage='model_generation' AND recovery_status='terminal' ORDER BY created_at DESC LIMIT 1",[r.owner_user_id,r.project_id,j.id,r.id])).rows[0];
    if(last?.reason!=='processor_failed'||last?.error_code!=='VALIDATION_FAILED'||!failure)throw refuse();
    const locked=(await client.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[r.owner_user_id,r.project_id,r.input_revision])).rows[0];
    const execution=(await client.query('SELECT version,operation,snapshot FROM bb_review_executions WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3',[r.owner_user_id,r.project_id,r.id])).rows[0];
    const review=locked?.manifest?.review;
    if(!locked||locked.input_hash.trim()!==r.input_hash.trim()||inputManifestHash(locked.manifest)!==r.input_hash.trim()||locked.manifest.project_kind!=='review'
      ||review?.version!=='review_v1'||review.operation!=='full_review'||!execution||execution.operation!==review.operation||execution.version!==review.version_number
      ||inputManifestHash(execution.snapshot.input)!==inputManifestHash(review.input))throw refuse();
    const a=(await client.query(`SELECT a.*,u.usage_status AS measured_usage,u.conflicting_measurements FROM bb_model_call_attempts a
      JOIN bb_call_usage u ON u.attempt_id=a.id WHERE a.id=$1 AND a.owner_user_id=$2 AND a.job_id=$3 FOR UPDATE OF a`,[input.attemptId,r.owner_user_id,j.id])).rows[0];
    const identity=a&&/^review-cli-(v[23])-([a-f0-9]{24})$/.exec(a.logical_call_id);
    if(!identity||a.status!=='completed'||a.measured_usage!=='measured'||Number(a.conflicting_measurements)!==0)throw refuse();
    const latest=(await client.query('SELECT max(attempt_no)::int AS n FROM bb_model_call_attempts WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3',[r.owner_user_id,j.id,a.logical_call_id])).rows[0];
    const promptStage=`review_cli_${identity[1]}_${identity[2]}_prompt`,stages=j.checkpoint?.stages;
    if(latest.n!==a.attempt_no||stages?.[promptStage]?.snapshot_id!==a.prompt_snapshot_id||stages?.model_generation
      ||Object.keys(stages??{}).filter(k=>/^review_cli_v[23]_.*_prompt$/.test(k)).length!==1)throw refuse();
    const results=(await client.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1',[a.id])).rows;
    const p=results[0],refs=j.checkpoint?.provider_results;
    const checkpoints=Array.isArray(refs)?refs.filter(p=>p.logical_call_id===a.logical_call_id&&p.attempt_no===a.attempt_no):[];
    const ref=checkpoints[0];
    if(results.length!==1||!p||p.owner_user_id!==r.owner_user_id||p.project_id!==r.project_id||p.job_id!==j.id||p.run_id!==r.id||p.trace_id!==r.id
      ||p.call_id!==a.id||p.logical_call_id!==a.logical_call_id||p.attempt_no!==a.attempt_no||p.prompt_snapshot_ref!==a.prompt_snapshot_id||p.model_id!==a.model_id
      ||p.result_sha256.trim()!==input.resultSha256||p.result_schema_version!==`review-cli-${identity[1]}`||Number(p.byte_size)<1||Number(p.byte_size)>10485760
      ||p.result_ref!==`users/${r.owner_user_id}/projects/${r.project_id}/provider-results/${a.id}-${input.resultSha256}.json`
      ||checkpoints.length!==1||ref.call_id!==a.id||ref.result_id!==p.id||ref.result_ref!==p.result_ref||ref.result_sha256!==input.resultSha256||ref.result_schema_version!==p.result_schema_version)throw refuse();
    const observation=await client.query(`SELECT 1 FROM bb_provider_call_observations WHERE owner_user_id=$1 AND project_id=$2 AND job_id=$3 AND run_id=$4
      AND attempt_id=$5 AND result_id=$6 AND prompt_snapshot_ref=$7 AND outcome='completed' AND usage_status='measured' AND finish_reason='stop' AND error_code IS NULL`,
      [r.owner_user_id,r.project_id,j.id,r.id,a.id,p.id,a.prompt_snapshot_id]);
    const prompt=(await client.query(`SELECT * FROM bb_snapshot_refs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND run_id=$4
      AND snapshot_kind='model_request' AND input_revision=$5 AND input_hash=$6`,[a.prompt_snapshot_id,r.owner_user_id,r.project_id,r.id,r.input_revision,r.input_hash])).rows[0];
    if(!observation.rowCount||!prompt||!prompt.object_key.startsWith(`users/${r.owner_user_id}/projects/${r.project_id}/snapshots/`))throw refuse();
    let resultBytes:Buffer|null,promptBytes:Buffer|null;
    try {
      resultBytes=await blobs.getIfExistsBounded(p.result_ref,10485760);
      promptBytes=await blobs.getIfExistsBounded(prompt.object_key,10485760);
    }catch{throw new Problem(409,'CAPABILITY_NOT_READY','Review recovery Blob evidence is unavailable');}
    if(!resultBytes||resultBytes.length!==Number(p.byte_size)||digest(resultBytes)!==input.resultSha256||!promptBytes||digest(promptBytes)!==prompt.content_sha256.trim())
      throw new Problem(409,'CAPABILITY_NOT_READY','Review recovery Blob evidence is missing or changed');
    const audit={actor:input.actor,policy:'review_assembly_v1',attempt_id:a.id,attempt_no:String(a.attempt_no),logical_call_id:a.logical_call_id,
      result_id:p.id,result_sha256:input.resultSha256,prompt_snapshot_id:prompt.id,prompt_sha256:prompt.content_sha256.trim(),
      input_revision:String(r.input_revision),input_hash:r.input_hash.trim(),failure_event_seq:String(r.event_cursor),failure_error_id:failure.id};
    await client.query(`UPDATE bb_jobs SET state='queued',stage='queued',error_code=NULL,updated_at=now(),
      checkpoint=jsonb_set(checkpoint,'{review_assembly_recovery}',$2::jsonb,true) WHERE id=$1`,[j.id,JSON.stringify({...audit,reuse_only:true})]);
    await event(client,r,'queued','queued','review_assembly_requeued',undefined,'run.state_changed',{...audit,reuse_only:'true'});
    return {run_id:r.id,attempt_id:a.id,result_sha256:input.resultSha256,idempotent:false};
  });
}

/** Private delivery-only recovery under the user-approved generated-pair policy.
 * Preserve failure events, prior evidence, provider result and usage; never rerun the CLI.
 */
export async function requeueGeneratedWordDelivery(pool:Pool,input:{runId:string;actor:string}) {
  if(!operatorField.test(input.runId)||!operatorField.test(input.actor))throw new Problem(422,'VALIDATION_FAILED','Invalid recovery identity');
  return transaction(pool,async client=>{
    const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[input.runId])).rows[0];
    if(!r)throw missing();
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[r.id,r.owner_user_id])).rows[0];
    if(!j)throw missing();
    if(j.checkpoint?.word_pair_delivery_recovery)return {run_id:r.id,idempotent:true};
    const refuse=()=>new Problem(409,'INPUT_REVISION_CONFLICT','No recoverable completed Word pair');
    if(r.channel!=='production'||r.state!=='failed'||j.state!=='failed'||j.lease_token||j.lease_until||r.artifact_id)throw refuse();
    const project=(await client.query('SELECT deleted_at FROM bb_projects WHERE id=$1 AND owner_user_id=$2',[r.project_id,r.owner_user_id])).rows[0];
    if(!project||project.deleted_at)throw refuse();
    const active=await client.query("SELECT 1 FROM bb_runs WHERE project_id=$1 AND owner_user_id=$2 AND state IN ('queued','running','paused')",[r.project_id,r.owner_user_id]);
    if(active.rowCount||await providerCallNeedsReconciliation(client,j.id))throw refuse();
    const last=(await client.query('SELECT payload FROM bb_run_events WHERE run_id=$1 AND seq=$2',[r.id,r.event_cursor])).rows[0]?.payload;
    if(last?.reason!=='processor_failed'||!['WORD_QUALITY_REJECTED','WORD_DELIVERY_UNAVAILABLE'].includes(last?.error_code))throw refuse();
    if(j.checkpoint?.stages?.model_generation?.logical_call_id!=='file-authoring-v1')throw refuse();
    const results=(await client.query(`SELECT a.id,a.attempt_no,p.id AS result_id,p.result_sha256,p.result_ref
      FROM bb_model_call_attempts a JOIN bb_provider_result_refs p ON p.attempt_id=a.id
      JOIN bb_call_usage u ON u.attempt_id=a.id
      WHERE a.job_id=$1 AND a.owner_user_id=$2 AND a.logical_call_id='file-authoring-v1'
        AND a.status='completed' AND u.usage_status='measured' AND u.conflicting_measurements=0
        AND p.run_id=$3 AND p.owner_user_id=$2 AND p.result_schema_version='codex-file-word-v1'`,[j.id,r.owner_user_id,r.id])).rows;
    if(results.length!==1)throw refuse();
    const a=results[0],refs=j.checkpoint?.provider_results;
    if(!Array.isArray(refs)||!refs.some(p=>p.call_id===a.id&&p.result_id===a.result_id&&p.result_sha256===a.result_sha256.trim()&&p.result_ref===a.result_ref))throw refuse();
    const audit={actor:input.actor,attempt_id:a.id,attempt_no:a.attempt_no,result_id:a.result_id,
      policy:'generated_pair_v1',failure_event_seq:String(r.event_cursor)};
    await client.query(`UPDATE bb_jobs SET state='queued',stage='queued',error_code=NULL,updated_at=now(),
      checkpoint=jsonb_set(checkpoint,'{word_pair_delivery_recovery}',$2::jsonb,true) WHERE id=$1`,[j.id,JSON.stringify(audit)]);
    await event(client,r,'queued','queued','word_pair_delivery_requeued',undefined,'run.state_changed',{
      actor:input.actor,attempt_id:a.id,policy:audit.policy,failure_event_seq:audit.failure_event_seq});
    return {run_id:r.id,idempotent:false};
  });
}

/** Private, explicit repair of the journal flag regression; never a generic failed-run resume.
 * The already-authorized timeout retry was rejected before sending another call. Preserve
 * its original failure, observations, usage and retry budget, and audit this correction.
 */
export async function repairUnifiedTimeoutRetry(pool:Pool,input:{runId:string;attemptId:string;actor:string}) {
  if(![input.runId,input.attemptId,input.actor].every(v=>operatorField.test(v)))
    throw new Problem(422,'VALIDATION_FAILED','Invalid timeout repair identity');
  return transaction(pool,async client=>{
    const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[input.runId])).rows[0];
    if(!r)throw missing();
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[r.id,r.owner_user_id])).rows[0];
    if(!j)throw missing();
    const repaired=j.checkpoint?.timeout_retry_repairs?.[input.attemptId];
    if(repaired)return {run_id:r.id,attempt_id:input.attemptId,idempotent:true};
    const refuse=()=>new Problem(409,'INPUT_REVISION_CONFLICT','Run does not match the interrupted timeout retry');
    // finish maps internal model codes to DATA_UNAVAILABLE in the job; the exact
    // original model failure remains on the terminal event checked below.
    if(r.state!=='failed'||j.state!=='failed'||j.error_code!=='DATA_UNAVAILABLE'||j.lease_token||j.lease_until)throw refuse();
    const unified=await client.query(`SELECT 1 FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2
      AND revision=$3 AND input_hash=$4 AND manifest->'update_details'->>'authoring_mode'='unified_v1'`,[r.owner_user_id,r.project_id,r.input_revision,r.input_hash]);
    if(!unified.rowCount)throw refuse();
    const a=(await client.query(`SELECT a.*,t.error_code,t.exit_code,t.exit_signal,t.tool_attempts,u.usage_status AS observed_usage
      FROM bb_model_call_attempts a JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
      JOIN bb_call_usage u ON u.attempt_id=a.id WHERE a.id=$1 AND a.job_id=$2 AND a.owner_user_id=$3`,[input.attemptId,j.id,r.owner_user_id])).rows[0];
    const disposition=j.checkpoint?.operator_reconciliations?.[input.attemptId];
    if(!a||a.status!=='failed'||a.error_code!=='MODEL_TIMEOUT'||a.observed_usage!=='unknown'||a.tool_attempts!==0||
      !(a.exit_code!==null||['SIGTERM','SIGKILL'].includes(a.exit_signal))||
      disposition?.actor!=='worker_timeout_recovery'||disposition?.decision!=='retry_unknown_usage'||
      disposition?.reason_code!=='terminated_timeout_auto_retry'||disposition?.logical_call_id!==a.logical_call_id)throw refuse();
    const history=Object.values(j.checkpoint.operator_reconciliations) as {reason_code?:string;logical_call_id?:string}[];
    const retries=history.filter(h=>h.reason_code==='terminated_timeout_auto_retry');
    if(retries.length>6||retries.filter(h=>h.logical_call_id===a.logical_call_id).length>2)throw refuse();
    const evidence=(await client.query(`SELECT
      EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1 AND
        (created_at>(SELECT created_at FROM bb_model_call_attempts WHERE id=$2) OR (logical_call_id=$4 AND attempt_no>$5))) AS newer,
      EXISTS(SELECT 1 FROM bb_provider_result_refs WHERE attempt_id=$2) AS has_result,
      EXISTS(SELECT 1 FROM bb_artifact_versions WHERE run_id=$3) AS has_artifact,
      EXISTS(SELECT 1 FROM bb_provider_call_observations WHERE attempt_id=$2 AND outcome='pending_reconcile'
        AND error_code='MODEL_TIMEOUT' AND usage_status='unknown' AND result_id IS NULL) AS timeout_observed,
      EXISTS(SELECT 1 FROM bb_provider_call_observations WHERE attempt_id=$2 AND
        (outcome<>'pending_reconcile' OR error_code IS DISTINCT FROM 'MODEL_TIMEOUT' OR usage_status<>'unknown' OR result_id IS NOT NULL)) AS conflicting`,
      [j.id,a.id,r.id,a.logical_call_id,a.attempt_no])).rows[0];
    if(evidence.newer||evidence.has_result||evidence.has_artifact||!evidence.timeout_observed||evidence.conflicting)throw refuse();
    const recent=(await client.query('SELECT seq,state,payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 3',[r.id])).rows;
    if(recent.length!==3||recent[0].seq!==r.event_cursor||recent[0].payload.reason!=='processor_failed'||
      recent[0].payload.error_code!=='MODEL_OUTPUT_SCHEMA_INVALID'||recent[1].payload.reason!=='claimed'||
      recent[2].payload.reason!=='provider_timeout_retry_scheduled'||recent[2].payload.attempt_id!==a.id)throw refuse();
    const audit={actor:input.actor,attempt_id:a.id,reason_code:'timeout_retry_flag_repaired',failure_event_seq:String(r.event_cursor)};
    await client.query(`UPDATE bb_jobs SET state='queued',stage='queued',error_code=NULL,updated_at=now(),
      checkpoint=jsonb_set(checkpoint,'{timeout_retry_repairs}',COALESCE(checkpoint->'timeout_retry_repairs','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true)
      WHERE id=$1`,[j.id,a.id,JSON.stringify(audit)]);
    await event(client,r,'queued','queued','provider_timeout_retry_repaired',undefined,'run.state_changed',audit);
    return {run_id:r.id,attempt_id:a.id,idempotent:false};
  });
}

/** Private maintenance read; attempt ownership is derived from the run and job, never from CLI input. */
export async function listOperatorReconciliations(pool:Pool) {
  const q=await pool.query(`SELECT r.id AS run_id,r.owner_user_id AS owner,r.channel,
      a.id AS attempt_id,a.logical_call_id,a.attempt_no,a.status AS attempt_status,a.created_at AS started_at,
      COALESCE(o.error_code,t.error_code) AS failure_code,
      u.usage_status,u.input_tokens,u.output_tokens,u.cached_input_tokens,u.reasoning_tokens
    FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id
    JOIN bb_model_call_attempts a ON a.job_id=j.id AND a.owner_user_id=r.owner_user_id
    LEFT JOIN LATERAL (SELECT error_code FROM bb_provider_call_observations WHERE attempt_id=a.id ORDER BY observed_at DESC,id DESC LIMIT 1) o ON true
    LEFT JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
    LEFT JOIN bb_call_usage u ON u.attempt_id=a.id
    WHERE r.state='paused' AND r.stage='provider_reconcile' AND j.state='paused' AND j.stage='provider_reconcile'
      AND ${needsProviderReconciliation}
    ORDER BY r.updated_at,a.created_at,a.id`,[]);
  return q.rows;
}

/** An explicit operator disposition; the run event is also the durable audit and outbox record. */
export async function resolveOperatorReconciliation(pool:Pool,input:{runId:string;attemptId:string;decision:OperatorReconcileDecision;reasonCode:string;actor:string}) {
  if(!operatorField.test(input.runId)||!operatorField.test(input.attemptId)||!operatorField.test(input.actor)||
    !operatorReason.test(input.reasonCode)||!['retry_unknown_usage','fail_run'].includes(input.decision))
    throw new Problem(422,'VALIDATION_FAILED','Invalid reconciliation fields');
  return transaction(pool,async client=>{
    const q=await client.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[input.runId]);
    const r=q.rows[0];if(!r)throw missing();
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[r.id,r.owner_user_id])).rows[0];
    if(!j)throw missing();
    const a=(await client.query('SELECT id,status FROM bb_model_call_attempts WHERE id=$1 AND owner_user_id=$2 AND job_id=$3 FOR UPDATE',[input.attemptId,r.owner_user_id,j.id])).rows[0];
    if(!a)throw missing();
    const previous=j.checkpoint?.operator_reconciliations?.[a.id];
    if(previous){
      if(previous.decision===input.decision && previous.reason_code===input.reasonCode)return {run_id:r.id,attempt_id:a.id,decision:input.decision,idempotent:true};
      throw new Problem(409,'IDEMPOTENCY_CONFLICT','Attempt already has another operator decision');
    }
    const unresolved=(await client.query(`SELECT 1 FROM bb_model_call_attempts a
      JOIN bb_jobs j ON j.id=a.job_id LEFT JOIN bb_call_usage u ON u.attempt_id=a.id
      WHERE a.id=$1 AND ${needsProviderReconciliation}`,[a.id])).rowCount;
    if(r.state!=='paused'||r.stage!=='provider_reconcile'||j.state!=='paused'||j.stage!=='provider_reconcile'||!unresolved)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not awaiting this provider call');
    const audit={actor:input.actor,reason_code:input.reasonCode,attempt_id:a.id,decision:input.decision};
    if(input.decision==='retry_unknown_usage'){
      if(a.status==='completed')throw new Problem(409,'CAPABILITY_NOT_READY','Completed result requires provider reconciliation or run termination');
      const evidence=await client.query(`SELECT u.usage_status,
        EXISTS(SELECT 1 FROM bb_provider_result_refs p WHERE p.attempt_id=$1) AS has_result
        FROM bb_call_usage u WHERE u.attempt_id=$1`,[a.id]);
      if(evidence.rows[0]?.has_result || evidence.rows[0]?.usage_status!=='unknown')
        throw new Problem(409,'CAPABILITY_NOT_READY','Existing result or non-unknown usage requires provider reconciliation');
      await client.query("UPDATE bb_model_call_attempts SET status='failed',usage_status='unknown',updated_at=now() WHERE id=$1",[a.id]);
      await client.query(`UPDATE bb_jobs SET state='queued',stage='queued',
        checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',COALESCE(checkpoint->'operator_reconciliations','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true),updated_at=now() WHERE id=$1`,
        [j.id,a.id,JSON.stringify({decision:input.decision,reason_code:input.reasonCode,actor:input.actor})]);
      await event(client,r,'queued','queued','provider_operator_retry_unknown_usage',undefined,'run.state_changed',audit);
    }else{
      await client.query("UPDATE bb_jobs SET state='failed',stage='failed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await recordRunFailure(client,r,j.id,'DATA_UNAVAILABLE','provider_reconcile');
      await client.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',COALESCE(checkpoint->'operator_reconciliations','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true) WHERE id=$1`,
        [j.id,a.id,JSON.stringify({decision:input.decision,reason_code:input.reasonCode,actor:input.actor})]);
      await event(client,r,'failed','failed','provider_operator_terminated','DATA_UNAVAILABLE','run.state_changed',audit);
    }
    return {run_id:r.id,attempt_id:a.id,decision:input.decision,idempotent:false};
  });
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
