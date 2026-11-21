import { FILE_AUTHORING_RECOVERY_LIMITS, FILE_AUTHORING_CONTEXT_ROTATION_LIMIT, FILE_AUTHORING_CAPTURE_VERSION, FILE_AUTHORING_CAPTURE_FAILURES, isFileAuthoringDeadline,
  type FileAuthoringCapture, type FileAuthoringCaptureOutcome } from '@bondbuddy/contracts';
import {withPerformanceSpan} from './performance-trace.js';
import {executionClaimGate,lockTaskQueueScheduling,accountExecutionLoadSql,lockExecutionReleaseContext,executionNodeForPool} from './execution-capacity.js';
import { Pool, type PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { date, missing, Problem, run, runDto, transaction, uid, type PrivateBlobs, digest } from './data.js';
import { emitInternal, internalEvent, recordOperation } from './observability.js';
import { AuthoringActivitySchema, type AuthoringActivity, ERROR_CODES, RUN_PAUSE_STAGES, TASK_KINDS, ReviewActionSchema, type ReviewAction, type M4AssistantReply, type ERROR_CATEGORIES, type ErrorCode } from '@bondbuddy/contracts';
import { assertGateOpen, ensureExternalCallsAllowed, guardEvidenceWrite,gateState,restoreCanonical } from './evidence-gate.js';
import { assertModelCallAllowed, reportTrialRejection, trialGuardConfig } from './trial-guard.js';
import { DOCX_LIMITS, inspectDocx, inspectGeneratedWord, GENERATED_WORD_DELIVERY_VERSION, WORD_MEDIA_TYPE, type DocxInspection } from './docx-inspector.js';
import { assertTestGrant } from './non-production-test.js';
import { errorDiagnostic } from './error-diagnostics.js';
import { READ_ONLY_MATERIAL_ADAPTER_VERSION } from './provider-results.js';
import { nextProviderReconcileUnknown, PROVIDER_RECONCILE_UNKNOWN_GRACE_MS } from './provider-reconcile-unknown.js';
import { inputManifestHash } from './production-rule-pin.js';
import { registerGeneratedProspectus } from './prospectus-versions.js';
import { registerProjectFileOutcome } from './project-file-storage.js';
import {AuthoringWorkflowV1Schema,ChapterReceiptV1Schema,WorkflowPostprocessManifestV1Schema,
 type AuthoringWorkflowV1,type ChapterReceiptV1,type WorkflowPostprocessManifestV1,type WorkflowPhase} from '@bondbuddy/contracts';
import {workflowExecutionEnabled} from './execution-capacity.js';
import {executionCloudCompletionMatches,type ExecutionCloudOperation} from '@bondbuddy/contracts';

import { syncAuthoringProgress } from './authoring-progress.js';
import { creditBalanceExact,lockCreditAccount } from './billing.js';
import { debitAuthoringCredits } from './authoring-credit-debit.js';
import { lockWalletSafetyForControl } from './billing-safety.js';
import { integrityQueryEvidenceReady } from './integrity-billing-evidence.js';

const terminal = new Set(['succeeded','test_completed','failed','cancelled','rejected']);
const fileAuthoringOutputLimitErrors: readonly string[] = ['MODEL_OUTPUT_TOO_LARGE','MODEL_PROVIDER_OUTPUT_LIMIT'];
const fileAuthoringRecoveryErrors = ['MODEL_PROVIDER_PAYLOAD_TOO_LARGE',...fileAuthoringOutputLimitErrors,'MODEL_TIMEOUT','MODEL_CONTEXT_ROTATION_REQUIRED'];
function isTerminatedProviderOutputLimit(runtime:{error_code?:string;finish_reason?:string;exit_code?:number;exit_signal?:string|null}) {
  return runtime.error_code==='MODEL_PROVIDER_OUTPUT_LIMIT' && runtime.finish_reason==='max_output_tokens' &&
    runtime.exit_code===1 && runtime.exit_signal===null;
}
/** Includes only the trusted SQL safety failure, never unrelated SQL 55000s. */
export function isBillingBlocked(error:unknown):boolean {
  return error instanceof Problem&&error.code==='BILLING_NOT_READY'||
    !!error&&typeof error==='object'&&(error as {code?:string}).code==='55000'&&
      /^BILLING_NOT_READY: wallet is isolated$/.test(String((error as {message?:string}).message));
}
async function walletIsolated(client:PoolClient,r:any){
  if(!r.reservation_id)return false;
  await lockWalletSafetyForControl(client,r.owner_user_id);
  return !!(await client.query("SELECT 1 FROM bb_billing_safety_blocks WHERE scope_key=$1 AND resume_event_id IS NULL",['wallet:'+r.owner_user_id])).rowCount;
}
async function billingContractRecoverable(client:PoolClient,r:any,j:any){
  if(!r.reservation_id)return true;
  const contract=(await client.query('SELECT state,billing_policy,charged_points FROM bb_credit_reservations WHERE id=$1 AND owner_user_id=$2',[r.reservation_id,r.owner_user_id])).rows[0];
  if(contract?.state==='held')return true;
  // Existing private, delivery-only authorizations retain their prior zero
  // charge release. A timeout retry has neither of these evidence contracts.
  if(contract?.state!=='released'||contract.billing_policy!=='on_delivery'||String(contract.charged_points)!=='0')return false;
  if(j.checkpoint?.word_pair_delivery_recovery?.policy==='generated_pair_v1')return true;
  if(j.checkpoint?.review_assembly_recovery)
    return (await client.query('SELECT bb_review_assembly_recovery_credit_ready(r) ready FROM bb_runs r WHERE r.id=$1 AND r.owner_user_id=$2',[r.id,r.owner_user_id])).rows[0]?.ready===true;
  return false;
}
async function parkBilling(client:PoolClient,r:any,j:any,reason='wallet_isolated',cancel=false,restoreAttempt=false){
  if(workflowOwned(j)&&j.lease_token){
    await client.query(`UPDATE bb_jobs SET billing_resume_stage=CASE WHEN stage='billing_reconcile' THEN billing_resume_stage ELSE stage END,
      billing_cancel_requested_at=CASE WHEN $2 THEN COALESCE(billing_cancel_requested_at,now()) ELSE billing_cancel_requested_at END WHERE id=$1`,[j.id,cancel]);
    await pendingWorkflowDisposition(client,r,j,{kind:cancel?'cancel':'pause',stage:'billing_reconcile',reason,error_code:'BILLING_NOT_READY'});return;
  }
  await client.query(`UPDATE bb_jobs SET state='paused',stage='billing_reconcile',lease_token=NULL,lease_until=NULL,
    billing_resume_stage=CASE WHEN stage='billing_reconcile' THEN billing_resume_stage ELSE stage END,
    billing_cancel_requested_at=CASE WHEN $2 THEN COALESCE(billing_cancel_requested_at,now()) ELSE billing_cancel_requested_at END,
    attempts=GREATEST(0,attempts-CASE WHEN $3 THEN 1 ELSE 0 END),updated_at=now() WHERE id=$1`,[j.id,cancel,restoreAttempt]);
  await event(client,r,'paused','billing_reconcile',reason,'BILLING_NOT_READY');
}
async function finalizePendingCancellation(client:PoolClient,r:any,j:any){
  await client.query("UPDATE bb_jobs SET state='cancelled',stage='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
  await event(client,r,'cancelled','cancelled','user_cancelled_after_billing_reconcile');
}
export type Lease = { jobId:string; runId:string; owner:string; token:string; checkpoint:Record<string,unknown>; attempts:number };
export type RunKind = typeof TASK_KINDS[number];
export function checkedRunKinds(kinds: readonly RunKind[] = TASK_KINDS): RunKind[] {
  if (!kinds.length || kinds.some(kind => !(TASK_KINDS as readonly string[]).includes(kind)) || new Set(kinds).size !== kinds.length)
    throw new Error('Invalid worker run kinds');
  return [...kinds];
}

async function event(client:PoolClient, r:any, state:string, stage:string|null, reason:string, errorCode?:string, type='run.state_changed', audit:Record<string,string|number>={},meterMode?:'preserve_restore_v1') {
  if(meterMode&&(state!=='queued'||reason!=='database_restore_reconciled'))throw new Problem(409,'CAPABILITY_NOT_READY','Restore meter preservation requires the verified queue transition');
  if(!meterMode)await syncAuthoringProgress(client,r,{state,stage,reason});
  if(terminal.has(state))await client.query('DELETE FROM bb_run_model_activity WHERE run_id=$1 AND owner_user_id=$2',[r.id,r.owner_user_id]);
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
const fixedPriceRun = `EXISTS(SELECT 1 FROM bb_runs billing_run WHERE billing_run.id=j.run_id AND (
  billing_run.billing_mode='fixed_credits' OR billing_run.billing_mode='metered_credits' AND j.subtype IN ('m4_document_v1','m4_qa_v1')
  OR EXISTS(SELECT 1 FROM bb_commerce_scope_runs coverage JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
    WHERE coverage.owner_user_id=billing_run.owner_user_id AND coverage.run_id=billing_run.id AND scope.amount_fen=0)
  OR EXISTS(SELECT 1 FROM bb_automatic_scope_runs coverage JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
    WHERE coverage.owner_user_id=billing_run.owner_user_id AND coverage.run_id=billing_run.id AND scope.amount_fen=0 AND scope.automatic_price IS NOT NULL)))`;
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

export async function providerCallNeedsReconciliation(client:PoolClient, jobId:string) {
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
export async function claim(pool:Pool, leaseSeconds=30, options:{platformProbe?:boolean; runKinds?:readonly RunKind[]; interactiveOnly?:boolean;workflowPhase?:WorkflowPhase}={}):Promise<Lease|null> {
  const runKinds = checkedRunKinds(options.runKinds);
  return transaction(pool,async client=>{
    await executionClaimGate(client,pool,options.workflowPhase);
    await lockTaskQueueScheduling(client);
    // Lock order is run then job in every transition, including cancellation.
    const q=await client.query(`SELECT r.* FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE (j.state='queued' OR (j.state='running' AND j.lease_until<now())) AND NOT (j.execution_node_id IS NOT NULL AND j.lease_token IS NOT NULL) AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected') AND (j.job_type='platform_probe')=$1 AND ($1 OR j.job_type=ANY($2::text[])) AND (NOT $3 OR j.subtype IN ('m4_qa_v1','project_qa_v1','project_file_v1'))
      AND bb_restore_account_permitted(r.owner_user_id)
      AND (($4::text IS NULL AND NOT j.checkpoint ? 'workflow_v1' AND NOT j.checkpoint ? 'workflow_admission_v1'
        AND NOT ((SELECT workflow_slots_enabled FROM bb_execution_capacity_policy WHERE singleton) AND bb_workflow_run_eligible(j.id) AND j.attempts=0
          AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=j.id)
          AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(j.checkpoint->'stages','{}'::jsonb)) stage WHERE stage NOT IN ('input_lock','materials_ready','workflow_budget_v1','chapter_context_v1')))) OR ($4::text IS NOT NULL AND
        ((j.checkpoint#>>'{workflow_v1,protocol_version}'='1' AND j.checkpoint#>>'{workflow_v1,phase}'=$4)
        OR ($4='authoring' AND NOT j.checkpoint ? 'workflow_v1' AND
         (NOT j.checkpoint ? 'workflow_admission_v1' OR (j.checkpoint#>>'{workflow_admission_v1,protocol_version}'='1'
          AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(j.checkpoint->'stages','{}'::jsonb)) stage WHERE stage NOT IN ('input_lock','materials_ready','workflow_budget_v1','chapter_context_v1','workflow_outline_v1','workflow_outline_prompt'))))
         AND (NOT j.checkpoint ? 'workflow_admission_v1' OR bb_workflow_preparation_calls_safe(j.id,j.checkpoint))))))
      ORDER BY ${accountExecutionLoadSql('r.owner_user_id')},j.created_at,j.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,[options.platformProbe===true,runKinds,options.interactiveOnly===true,options.workflowPhase??null]);
    const r=q.rows[0];if(!r)return null;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[r.id])).rows[0];
    let admittedPhase=options.workflowPhase;
    if(admittedPhase==='authoring'&&!workflowOwned(j)){
      const fresh=!!(await client.query('SELECT bb_workflow_run_eligible($1) AS eligible',[j.id])).rows[0]?.eligible&&j.attempts===0&&
        !Object.keys(j.checkpoint.stages??{}).some(k=>!['input_lock','materials_ready','workflow_budget_v1','chapter_context_v1'].includes(k))&&
        !(await client.query('SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1',[j.id])).rowCount;
      if(!fresh){admittedPhase=undefined;await executionClaimGate(client,pool);}
    }
    if(j.state==='running' && new Date(j.lease_until).getTime()>=Date.now())return null;
    if(await walletIsolated(client,r)){await parkBilling(client,r,j);return null;}
    if(j.billing_cancel_requested_at){await finalizePendingCancellation(client,r,j);return null;}
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
    await client.query('DELETE FROM bb_run_model_activity WHERE job_id=$1',[j.id]);
    const admitted=(await client.query(`UPDATE bb_jobs SET state='running',stage=CASE WHEN stage='queued' THEN 'claimed' ELSE COALESCE(stage,'claimed') END,lease_token=$2,lease_until=now()+($3::integer * interval '1 second'),attempts=attempts+1,
      checkpoint=CASE WHEN $4::text='authoring' AND NOT checkpoint ? 'workflow_v1' THEN checkpoint||jsonb_build_object('workflow_admission_v1',jsonb_build_object('protocol_version',1,'input_hash',$5::text)) ELSE checkpoint END,
      updated_at=now() WHERE id=$1 RETURNING checkpoint`,[j.id,token,leaseSeconds,admittedPhase??null,String(r.input_hash).trim()])).rows[0];
    await event(client,r,'running',j.stage==='queued'?'claimed':j.stage ?? 'claimed',j.state==='running'?'lease_recovered':'claimed');
    return {jobId:j.id,runId:r.id,owner:r.owner_user_id,token,checkpoint:admitted.checkpoint,attempts:j.attempts+1};
  });
}

async function lockedLease(client:PoolClient, lease:Lease, renewing=false) {
  const r=await run(client,lease.owner,lease.runId,true);
  const j=(await client.query(renewing
    ? `SELECT *,transaction_timestamp()<lease_until AS renewal_started_in_time FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 FOR UPDATE`
    : 'SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 FOR UPDATE',[lease.jobId,lease.owner,lease.runId])).rows[0];
  // Only a renewal already waiting before expiry may survive a long delivery
  // transaction's run/job locks. A new request after expiry, a different token,
  // or any terminal/control transition still loses. Other writes remain strict.
  const expired=j && new Date(j.lease_until).getTime()<=Date.now();
  if(!j || j.lease_token!==lease.token || j.state!=='running' || expired&&!(renewing&&j.renewal_started_in_time===true) || terminal.has(r.state)) throw new Problem(409,'ALREADY_TERMINAL','Lease is no longer active');
  return {r,j};
}

function workflowOwned(j:any){return !!j.checkpoint?.workflow_v1||j.checkpoint?.workflow_admission_v1?.protocol_version===1;}
function workflowVerificationState(j:any){return j.checkpoint.workflow_v1??{workflow_admission_v1:j.checkpoint.workflow_admission_v1,stages:j.checkpoint.stages??{}};}
function checkedWorkflow(r:any,j:any):AuthoringWorkflowV1 {
  const w=j.checkpoint?.workflow_v1;
  if(!Value.Check(AuthoringWorkflowV1Schema,w)||w.input_hash!==String(r.input_hash).trim()||w.plan_hash!==w.plan.plan_hash||w.plan.input_hash!==w.input_hash)
    throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow input or protocol changed');
  const {plan_hash,...plan}=w.plan;
  if(inputManifestHash(plan)!==plan_hash)throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow plan hash changed');
  if(new Set(w.plan.chapters.map(c=>c.chapter_id)).size!==w.plan.chapters.length||w.plan.chapters.some((c,index)=>c.order!==index||new Set(c.batches.map(b=>b.batch_id)).size!==c.batches.length||c.batches.some((b,i)=>b.order!==i)))
    throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow plan order or identity is ambiguous');
  return structuredClone(w);
}
async function saveWorkflow(client:PoolClient,j:any,w:AuthoringWorkflowV1,lease?:Lease){
  const q=await client.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('workflow_v1',$2::jsonb),updated_at=now() WHERE id=$1 RETURNING checkpoint",[j.id,JSON.stringify(w)]);
  j.checkpoint=q.rows[0].checkpoint;if(lease)lease.checkpoint=j.checkpoint;
}
type WorkflowDisposition=NonNullable<AuthoringWorkflowV1['pending_disposition']>;
async function pendingWorkflowDisposition(client:PoolClient,r:any,j:any,disposition:WorkflowDisposition,lease?:Lease){
  if(!j.checkpoint?.workflow_v1){
    if(!workflowOwned(j))throw new Problem(409,'INPUT_REVISION_CONFLICT','No admitted workflow');
    const q=await client.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('workflow_pending_disposition_v1',$2::jsonb),updated_at=now() WHERE id=$1 RETURNING checkpoint",[j.id,JSON.stringify(disposition)]);
    j.checkpoint=q.rows[0].checkpoint;if(lease)lease.checkpoint=j.checkpoint;
    await event(client,r,'running','stopping','workflow_pause_pending',disposition.error_code,'run.progress');return;
  }
  const w=checkedWorkflow(r,j);
  // Cancellation wins a simultaneous handoff or material/provider pause.
  if(w.pending_disposition?.kind==='cancel'&&disposition.kind!=='cancel')return;
  w.pending_disposition=disposition;await saveWorkflow(client,j,w,lease);
  await event(client,r,'running','stopping',disposition.kind==='handoff'?'workflow_handoff_pending':'workflow_pause_pending',disposition.error_code,'run.progress');
}
async function verifyPreparationOutline(pool:Pool,lease:Lease,workflow:AuthoringWorkflowV1,blobs?:PrivateBlobs){
  const j=(await pool.query('SELECT j.checkpoint,r.project_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE j.id=$1 AND j.run_id=$2 AND j.owner_user_id=$3',[lease.jobId,lease.runId,lease.owner])).rows[0];
  const outline=j?.checkpoint.stages?.workflow_outline_v1;if(!outline)return undefined;
  if(!blobs)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow outline requires private object verification');
  const context=j.checkpoint.stages.chapter_context_v1?.ref;
  const read=async(object:any)=>{if(!object?.key?.startsWith(`users/${lease.owner}/projects/${j.project_id}/runs/${lease.runId}/workflow-v1/`)||!Number.isSafeInteger(object.byte_size)||object.byte_size<1||object.byte_size>100*1024*1024)throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow preparation object identity changed');
    const bytes=await blobs.getIfExistsBounded(object.key,100*1024*1024);if(!bytes||bytes.length!==object.byte_size||digest(bytes)!==object.sha256)throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow preparation object changed');return JSON.parse(bytes.toString('utf8'));};
  const c=await read(context),o=await read(outline.ref);
  if(c.version!=='chapter-context-v1'||c.input_hash!==workflow.input_hash||c.material_snapshot_hash!==workflow.plan.material_snapshot_hash||inputManifestHash({input:c.input,parser_version:c.parser_version})!==c.material_snapshot_hash||
    outline.context_hash!==c.material_snapshot_hash||outline.logical_call_id!==inputManifestHash([lease.runId,workflow.input_hash,c.material_snapshot_hash,'outline-v1'])||
    o.version!=='workflow-outline-v1'||o.input_hash!==workflow.input_hash||o.context_hash!==outline.context_hash||!Array.isArray(o.chapters)||!o.chapters.length||o.chapters.length>40||o.chapters.some((title:any)=>typeof title!=='string'||!title.trim())||
    restoreCanonical(o.chapters)!==restoreCanonical(workflow.plan.chapters.map(chapter=>chapter.title)))throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow outline or context binding changed');
  return inputManifestHash(workflowVerificationState(j));
}
export async function initializeWorkflow(pool:Pool,lease:Lease,workflow:AuthoringWorkflowV1,options?:{blobs:PrivateBlobs}):Promise<AuthoringWorkflowV1>{
  if(!await workflowExecutionEnabled(pool,'authoring'))throw new Problem(409,'CAPABILITY_NOT_READY','Workflow phase execution is not enabled');
  const verifiedOutline=await verifyPreparationOutline(pool,lease,workflow,options?.blobs);
  return transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    if(j.checkpoint?.workflow_v1){const prior=checkedWorkflow(r,j);if(prior.plan_hash!==workflow.plan_hash)throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow already initialized with another plan');return prior;}
    if(j.execution_admission_phase!=='authoring'||!(await client.query('SELECT bb_workflow_preparation_calls_safe($1,$2::jsonb) AS safe',[j.id,JSON.stringify(j.checkpoint)])).rows[0]?.safe||
      Object.keys(j.checkpoint?.stages??{}).some(k=>!['input_lock','materials_ready','workflow_budget_v1','chapter_context_v1','workflow_outline_v1','workflow_outline_prompt'].includes(k))||Object.keys(j.checkpoint??{}).some(k=>k.startsWith('file_authoring'))||
      j.checkpoint.stages?.workflow_outline_v1&&verifiedOutline!==inputManifestHash(workflowVerificationState(j)))
      throw new Problem(409,'INPUT_REVISION_CONFLICT','An existing legacy execution cannot change protocol');
    const candidate={...j,checkpoint:{...j.checkpoint,workflow_v1:workflow}};const w=checkedWorkflow(r,candidate);
    if(j.checkpoint?.stages?.workflow_budget_v1?.run_deadline_at&&j.checkpoint.stages.workflow_budget_v1.run_deadline_at!==w.run_deadline_at)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow preparation deadline changed');
    if(w.phase!=='authoring'||w.next_cursor.chapter!==0||w.next_cursor.batch!==0||w.completed.length||w.token_budget.used_known||w.token_budget.unknown_calls.length||w.repair_budget.used_ms||w.repair_budget.used_revisions||w.phase_failures.authoring||w.phase_failures.postprocess||w.pending_disposition)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Initial workflow cursor or budget is not empty');
    if(j.checkpoint.workflow_phase_failures_v1)w.phase_failures=j.checkpoint.workflow_phase_failures_v1;
    const usage=await workflowUsage(client,j.id);if(usage.unknown_calls.length||usage.used_known>=w.token_budget.limit)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow preparation token budget is exhausted or unknown');
    w.token_budget={...w.token_budget,...usage};
    await saveWorkflow(client,j,w,lease);return w;
  });
}
async function workflowUsage(client:PoolClient,jobId:string){
  const rows=(await client.query(`SELECT a.id,a.status,u.usage_status,u.conflicting_measurements,u.input_tokens,u.output_tokens
    FROM bb_model_call_attempts a LEFT JOIN bb_call_usage u ON u.attempt_id=a.id
    WHERE a.job_id=$1 AND a.status<>'confirmed_not_sent' ORDER BY a.created_at,a.id`,[jobId])).rows;
  const unknown=rows.filter(a=>a.status==='pending_reconcile'||a.usage_status!=='measured'||Number(a.conflicting_measurements)>0).map(a=>a.id);
  let used=0n;for(const a of rows)if(a.usage_status==='measured'&&Number(a.conflicting_measurements)===0)used+=BigInt(a.input_tokens??0)+BigInt(a.output_tokens??0);
  if(used>BigInt(Number.MAX_SAFE_INTEGER))throw new Problem(409,'CAPABILITY_NOT_READY','Workflow token budget exceeds supported accounting range');
  return {used_known:Number(used),unknown_calls:unknown};
}
export async function commitChapter(pool:Pool,lease:Lease,expectedCursor:{chapter:number;batch:number},receipt:ChapterReceiptV1):Promise<AuthoringWorkflowV1>{
  if(!Value.Check(ChapterReceiptV1Schema,receipt))throw new Problem(422,'VALIDATION_FAILED','Invalid chapter receipt');
  return transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease),w=checkedWorkflow(r,j);
    if(receipt.run_id!==r.id||receipt.job_id!==j.id||receipt.input_hash!==w.input_hash||receipt.plan_hash!==w.plan_hash)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Chapter receipt input changed');
    const prior=w.completed.find(c=>c.chapter_id===receipt.chapter_id&&c.batch_id===receipt.batch_id);
    if(prior){const {created_at:priorTime,...priorBody}=prior,{created_at:receiptTime,...receiptBody}=receipt;
      if(inputManifestHash(priorBody)!==inputManifestHash(receiptBody))throw new Problem(409,'IDEMPOTENCY_CONFLICT','CHAPTER_RECEIPT_CONFLICT');return w;}
    if(w.phase!=='authoring'||w.pending_disposition||w.next_cursor.chapter!==expectedCursor.chapter||w.next_cursor.batch!==expectedCursor.batch)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow cursor changed');
    const chapter=w.plan.chapters[expectedCursor.chapter],batch=chapter?.batches[expectedCursor.batch];
    if(!chapter||!batch||chapter.chapter_id!==receipt.chapter_id||batch.batch_id!==receipt.batch_id)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Chapter receipt is outside the planned range');
    if(!receipt.object.key.startsWith(`users/${lease.owner}/projects/${r.project_id}/`))throw new Problem(409,'INPUT_REVISION_CONFLICT','Chapter object ownership changed');
    const attempt=(await client.query('SELECT status,attempt_no FROM bb_model_call_attempts WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 ORDER BY attempt_no DESC LIMIT 1',[lease.owner,j.id,receipt.logical_call_id])).rows[0];
    if(attempt?.status!=='completed'||attempt.attempt_no!==receipt.execution_generation||await providerCallNeedsReconciliation(client,j.id))
      throw new Problem(409,'CAPABILITY_NOT_READY','Chapter call is not reconciled');
    const usage=await workflowUsage(client,j.id);if(usage.unknown_calls.length)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow usage is unknown');
    w.token_budget={...w.token_budget,...usage};w.completed.push(receipt);
    w.next_cursor=expectedCursor.batch+1<chapter.batches.length?{chapter:expectedCursor.chapter,batch:expectedCursor.batch+1}:{chapter:expectedCursor.chapter+1,batch:0};
    await saveWorkflow(client,j,w,lease);await event(client,r,'running','model_generation','workflow_chapter_committed',undefined,'run.progress');return w;
  });
}
export async function preparePostprocess(pool:Pool,lease:Lease,expectedPhase:'authoring',manifest:WorkflowPostprocessManifestV1):Promise<void>{
  if(!Value.Check(WorkflowPostprocessManifestV1Schema,manifest))throw new Problem(422,'VALIDATION_FAILED','Invalid workflow manifest');
  await transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease),w=checkedWorkflow(r,j);
    if(w.phase!==expectedPhase||w.pending_disposition||manifest.input_hash!==w.input_hash||manifest.plan_hash!==w.plan_hash||w.next_cursor.chapter!==w.plan.chapters.length||w.next_cursor.batch!==0||
      inputManifestHash(manifest.chapter_receipts)!==inputManifestHash(w.completed)||await providerCallNeedsReconciliation(client,j.id))
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow is not ready for postprocess');
    if(!manifest.candidate.key.startsWith(`users/${lease.owner}/projects/${r.project_id}/`))throw new Problem(409,'INPUT_REVISION_CONFLICT','Manifest object ownership changed');
    w.phase='postprocess';w.handoff_id=uid();w.postprocess_manifest=manifest;
    await saveWorkflow(client,j,w,lease);await pendingWorkflowDisposition(client,r,j,{kind:'handoff',stage:'model_generation',reason:'workflow_postprocess_ready'},lease);
  });
}
export async function requestWorkflowPause(pool:Pool,lease:Lease,stage:string,reason:string,errorCode?:string){
  await transaction(pool,async client=>{const {r,j}=await lockedLease(client,lease);await pendingWorkflowDisposition(client,r,j,{kind:'pause',stage,reason,...(errorCode?{error_code:errorCode}:{})},lease);});
}
export async function recordWorkflowFailure(pool:Pool,lease:Lease,phase:WorkflowPhase){
  return transaction(pool,async client=>{const {r,j}=await lockedLease(client,lease);
    if(!j.checkpoint?.workflow_v1&&workflowOwned(j)){
      const failures={authoring:0,postprocess:0,...j.checkpoint.workflow_phase_failures_v1};failures[phase]++;
      const q=await client.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('workflow_phase_failures_v1',$2::jsonb) WHERE id=$1 RETURNING checkpoint",[j.id,JSON.stringify(failures)]);lease.checkpoint=q.rows[0].checkpoint;
      return {failures:failures[phase],exhausted:failures[phase]>=3};
    }
    const w=checkedWorkflow(r,j);w.phase_failures[phase]++;await saveWorkflow(client,j,w,lease);return {failures:w.phase_failures[phase],exhausted:w.phase_failures[phase]>=3};});
}
export type WorkflowRepairInput={kind:'reserve_revision';repairKey:string;logicalCallId:string;expectedRevision:number;revision:number;deadlineAt:string;failureCode:string}|
 {kind:'record_elapsed';logicalCallId:string;elapsedMs:number};
/** Reservation, deadline and accounting are one commit; replay advances only a
 * measured duration delta, never a second revision or a renewed deadline. */
export async function recordWorkflowRepair(pool:Pool,lease:Lease,input:WorkflowRepairInput):Promise<AuthoringWorkflowV1>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(input.logicalCallId))throw new Problem(422,'VALIDATION_FAILED','Invalid workflow repair call');
  if(input.kind==='record_elapsed'&&(!Number.isSafeInteger(input.elapsedMs)||input.elapsedMs<0))throw new Problem(422,'VALIDATION_FAILED','Invalid workflow repair duration');
  return transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease),w=checkedWorkflow(r,j),ledger={...j.checkpoint.workflow_repair_ledger_v1};
    if(input.kind==='reserve_revision'){
      if(input.repairKey!==`workflow_repair_${w.next_cursor.chapter}_${w.next_cursor.batch}`||!Number.isInteger(input.expectedRevision)||input.expectedRevision<0||input.revision!==input.expectedRevision+1||
        !['WORD_EDIT_ANCHOR_MISMATCH','WORD_EDIT_STALE_PROJECTION','WORD_EDIT_REQUEST_INVALID'].includes(input.failureCode)||!Number.isFinite(Date.parse(input.deadlineAt)))
        throw new Problem(422,'VALIDATION_FAILED','Invalid workflow repair reservation');
      const key='revision:'+input.logicalCallId,prior=ledger[key],stage=j.checkpoint.stages?.[input.repairKey];
      if(prior){if(prior.repair_key!==input.repairKey||prior.revision!==input.revision||prior.deadline_at!==input.deadlineAt||prior.failure_code!==input.failureCode)
        throw new Problem(409,'IDEMPOTENCY_CONFLICT','Workflow repair reservation changed');lease.checkpoint=j.checkpoint;return w;}
      if((stage?.revision??0)!==input.expectedRevision||stage&&stage.deadline_at!==input.deadlineAt)
        throw new Problem(409,'INPUT_REVISION_CONFLICT','Workflow repair revision or deadline changed');
      const remaining=w.plan.limits.repair_ms-w.repair_budget.used_ms;
      if(remaining<=0)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow repair budget exhausted');
      if(Date.parse(input.deadlineAt)<=Date.now()||Date.parse(input.deadlineAt)>Date.parse(w.run_deadline_at)||Date.parse(input.deadlineAt)>Date.now()+remaining)
        throw new Problem(409,'CAPABILITY_NOT_READY','Workflow repair deadline exhausted or extended');
      if(input.revision>w.plan.limits.repair_revisions)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow repair budget exhausted');
      w.repair_budget.used_revisions++;
      const repair={revision:input.revision,deadline_at:input.deadlineAt,failure_code:input.failureCode};
      ledger[key]={...repair,repair_key:input.repairKey};
      const q=await client.query(`UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('workflow_v1',$2::jsonb,'workflow_repair_ledger_v1',$3::jsonb,
        'stages',COALESCE(checkpoint->'stages','{}'::jsonb)||jsonb_build_object($4::text,$5::jsonb)),updated_at=now() WHERE id=$1 RETURNING checkpoint`,[j.id,JSON.stringify(w),JSON.stringify(ledger),input.repairKey,JSON.stringify(repair)]);
      lease.checkpoint=q.rows[0].checkpoint;return w;
    }
    const measured=(await client.query(`SELECT count(a.id)::int AS attempts,count(t.attempt_id)::int AS runtimes,COALESCE(sum(t.duration_ms),0) AS duration FROM bb_model_call_attempts a
      LEFT JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id WHERE a.job_id=$1 AND a.logical_call_id=$2`,[j.id,input.logicalCallId])).rows[0];
    if(measured.attempts!==measured.runtimes)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow repair runtime is unavailable');
    const total=Math.max(input.elapsedMs,Number(measured.duration));
    if(!Number.isSafeInteger(total)||total<0)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow repair runtime is unavailable');
    const key='elapsed:'+input.logicalCallId,prior=Number(ledger[key]?.accounted_ms??0),next=Math.max(prior,total);
    const delta=next-prior;if(delta===0){lease.checkpoint=j.checkpoint;return w;}
    if(w.repair_budget.used_ms+delta>w.plan.limits.repair_ms)throw new Problem(409,'CAPABILITY_NOT_READY','Workflow repair budget exhausted');
    w.repair_budget.used_ms+=delta;ledger[key]={accounted_ms:next};
    const q=await client.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('workflow_v1',$2::jsonb,'workflow_repair_ledger_v1',$3::jsonb),updated_at=now() WHERE id=$1 RETURNING checkpoint",[j.id,JSON.stringify(w),JSON.stringify(ledger)]);
    lease.checkpoint=q.rows[0].checkpoint;return w;
  });
}

type WorkflowResumeVerification={workflowHash:string};
async function verifyWorkflowResume(pool:Pool,owner:string,runId:string,blobs?:PrivateBlobs):Promise<WorkflowResumeVerification|null|undefined>{
  const q=await pool.query('SELECT r.input_hash,r.project_id,j.checkpoint,j.lease_token,j.attempts,j.execution_node_id,j.execution_node_epoch,j.execution_session_id,j.id FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id WHERE r.id=$1 AND r.owner_user_id=$2',[runId,owner]);
  const j=q.rows[0];if(!j||!workflowOwned(j))return undefined;
  if(!blobs||j.lease_token)return null;
  try{
    const w=j.checkpoint.workflow_v1?checkedWorkflow({input_hash:j.input_hash},j):undefined;
    const objects=w?[...(w.plan_ref?[w.plan_ref]:[]),...w.completed.map(c=>c.object),...(w.postprocess_manifest?[w.postprocess_manifest.candidate]:[])]:
      [j.checkpoint.stages?.chapter_context_v1?.ref].filter(Boolean);
    const prefix=`users/${owner}/projects/${j.project_id}/`;
    for(const object of objects){
      if(!object.key.startsWith(prefix)||object.byte_size>100*1024*1024)return null;
      const bytes=await blobs.getIfExistsBounded(object.key,100*1024*1024);
      if(!bytes||bytes.length!==object.byte_size||digest(bytes)!==object.sha256)return null;
    }
    let chapter=0,batch=0;
    for(const receipt of w?.completed??[]){
      if(!w)return null;
      const planned=w.plan.chapters[chapter],item=planned?.batches[batch];
      if(!item||receipt.chapter_id!==planned.chapter_id||receipt.batch_id!==item.batch_id||receipt.input_hash!==w.input_hash||receipt.plan_hash!==w.plan_hash||receipt.run_id!==runId||receipt.job_id!==j.id)return null;
      if(++batch===planned.batches.length){chapter++;batch=0;}
    }
    if(w&&(chapter!==w.next_cursor.chapter||batch!==w.next_cursor.batch))return null;
    return {workflowHash:inputManifestHash(workflowVerificationState(j))};
  }catch{return null;}
}
async function workflowResumeReady(client:PoolClient,r:any,j:any,verified:WorkflowResumeVerification|null|undefined){
  const gate=await gateState(client);if(gate.state==='paused'&&gate.reason_code==='database_restore_quarantine')return false;
  if(!(await client.query('SELECT bb_restore_account_permitted($1) AS permitted',[r.owner_user_id])).rows[0]?.permitted)return false;
  if(!workflowOwned(j))return true;
  if(!verified||j.lease_token||inputManifestHash(workflowVerificationState(j))!==verified.workflowHash)return false;
  const w=j.checkpoint.workflow_v1?checkedWorkflow(r,j):undefined,inputHash=String(r.input_hash).trim(),release=j.checkpoint.positive_release_v1,fence=j.checkpoint.cloud_fence_v1,never=j.checkpoint.never_admitted_v1;
  const positive=release?.version==='positive-release-v1'&&release.job_id===j.id&&release.run_id===r.id&&release.input_hash===inputHash&&
    release.execution_node_id===j.execution_node_id&&release.epoch===j.execution_node_epoch&&release.session_id===j.execution_session_id&&
    typeof release.lease_token==='string'&&release.native_processes===0&&release.active_executions===0&&typeof release.cgroup_identity==='string';
  const fenced=fence?.version==='cloud-fence-v1'&&fence.job_id===j.id&&fence.epoch===j.execution_node_epoch&&fence.node_id===j.execution_node_id&&
    !!(await client.query(`SELECT 1 FROM bb_execution_cloud_operations WHERE operation_id=$1 AND state='completed' AND action IN ('stop','destroy')
      AND epoch=$2 AND instance_id=$3 AND cloud_observation IS NOT NULL`,[fence.operation_id,fence.epoch,fence.instance_id])).rowCount;
  const neverAdmitted=never?.version==='never-admitted-v1'&&never.job_id===j.id&&j.attempts===0&&!j.execution_session_id&&
    !(await client.query('SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1',[j.id])).rowCount;
  const restored=j.checkpoint.database_restore_quarantine&&await restoreReleaseReady(client,r,j);
  if(!positive&&!fenced&&!neverAdmitted&&!restored)return false;
  const input=(await client.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE project_id=$1 AND owner_user_id=$2 AND revision=$3',[r.project_id,r.owner_user_id,r.input_revision])).rows[0];
  if(!input||input.input_hash.trim()!==inputHash||inputManifestHash(input.manifest)!==inputHash)return false;
  const usage=await workflowUsage(client,j.id);
  if(usage.unknown_calls.length||w&&w.phase==='authoring'&&usage.used_known>=w.token_budget.limit)return false;
  if(w){w.token_budget={...w.token_budget,...usage};await saveWorkflow(client,j,w);}
  await client.query("SELECT set_config('bb.workflow_resume_verified_hash',$1,true)",[inputManifestHash(workflowVerificationState(j))]);return true;
}
export async function resumeVerifiedWorkflow(pool:Pool,owner:string,runId:string,reason:Parameters<typeof resumePausedRun>[3],options:{blobs:PrivateBlobs}){
  return resumePausedRun(pool,owner,runId,reason,options);
}

type RestoreToken={kind:'job'|'message';id:string;token:string};
const restoreConflict=(reason='Restore execution proof is missing or changed'):never=>{throw new Problem(409,'CAPABILITY_NOT_READY',reason);};
const restoreDigest=(value:unknown)=>digest(Buffer.from(restoreCanonical(value)));
async function assertRestoreControlPrivileges(db:Pool|PoolClient){
  const permitted=(await db.query(`SELECT has_table_privilege(current_user,'public.bb_database_restore_fence_releases','INSERT')
    AND has_table_privilege(current_user,'public.bb_database_restore_reconciliations','INSERT') AS permitted`)).rows[0]?.permitted;
  if(permitted!==true)restoreConflict('Restore control privileges are required');
}
function restoreJobIdentity(j:any){return {id:j.id,owner_user_id:j.owner_user_id,project_id:j.project_id,run_id:j.run_id,lease_token:j.lease_token,execution_node_id:j.execution_node_id,execution_node_epoch:j.execution_node_epoch,execution_session_id:j.execution_session_id};}
/** Operator-only ingress for an exact off-host Stop result that postdates a
 * backup. The immutable restore manifest is the trust anchor; IO precedes CAS.
 * This releases capacity only and never changes a provider attempt or money. */
export async function fenceRestoredExecutionEpoch(pool:Pool,actorId:string,input:{quarantineId:string;manifestSha256:string;nodeId:string;epoch:string;expectedTokens:RestoreToken[];evidenceRef:string},options:{readObject:(ref:string)=>Promise<Buffer>}){
  if(!actorId||!/^[a-f0-9]{64}$/.test(input.manifestSha256)||!input.evidenceRef)restoreConflict();
  await assertRestoreControlPrivileges(pool);
  const pre=(await pool.query('SELECT * FROM bb_database_restore_quarantines WHERE id=$1',[input.quarantineId])).rows[0];
  if(!pre||pre.manifest_sha256.trim()!==input.manifestSha256||pre.receipt.manifest_sha256!==input.manifestSha256||
    restoreDigest(Object.fromEntries(Object.entries(pre.receipt).filter(([key])=>key!=='manifest_sha256')))!==input.manifestSha256)restoreConflict();
  const fence=pre.receipt.fences.find((f:any)=>f.node_id===input.nodeId&&f.epoch===input.epoch),original=pre.preimage.nodes.find((n:any)=>n.id===input.nodeId&&n.epoch===input.epoch);
  if(!fence||!original||['account_id','region','instance_id','cloud_start_operation_id'].some(key=>original[key]!==fence[key])||
    ['source_sha256','image_sha256','launch_manifest_sha256'].some(key=>original[key]?.trim()!==fence[key]))restoreConflict();
  const bytes=await options.readObject(input.evidenceRef);if(!bytes.length||bytes.length>4*1024*1024)restoreConflict();
  let operation:any;try{operation=JSON.parse(bytes.toString('utf8'));}catch{restoreConflict();}
  if(operation.operation_id!==fence.stop_operation_id||operation.state!=='completed'||!['stop','destroy'].includes(operation.action)||
    ['account_id','region','instance_id','epoch'].some(key=>operation[key]!==fence[key])||
    !operation.cloud_observation||restoreDigest(operation.cloud_observation)!==fence.cloud_observation_sha256||
    !executionCloudCompletionMatches({...operation,identity:{account_id:fence.account_id,region:fence.region,instance_id:fence.instance_id,epoch:fence.epoch}} as ExecutionCloudOperation,operation.cloud_observation))restoreConflict('Restore cloud Stop completion is unproven');
  const jobs=pre.preimage.jobs.filter((j:any)=>j.execution_node_id===input.nodeId&&j.execution_node_epoch===input.epoch&&j.lease_token),
    messages=(pre.preimage.messages??[]).filter((m:any)=>m.execution_node_id===input.nodeId&&m.execution_node_epoch===input.epoch&&m.lease_token),
    holders=pre.preimage.holders.filter((h:any)=>h.execution_node_id===input.nodeId&&h.execution_node_epoch===input.epoch),
    waiters=(pre.preimage.waiters??[]).filter((h:any)=>h.execution_node_id===input.nodeId&&h.execution_node_epoch===input.epoch);
  const expected:RestoreToken[]=[...jobs.map((j:any)=>({kind:'job' as const,id:j.id,token:j.lease_token})),...messages.map((m:any)=>({kind:'message' as const,id:m.id,token:m.lease_token}))];
  const ordered=(values:RestoreToken[])=>[...values].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
  if(restoreCanonical(ordered(expected))!==restoreCanonical(ordered(input.expectedTokens)))restoreConflict('Restore token preimage changed');
  const releasePreimage={node:original,jobs:jobs.map(restoreJobIdentity),messages:messages.map(restoreJobIdentity),holders,waiters},evidenceSha=digest(bytes);
  return transaction(pool,async c=>{
    await assertRestoreControlPrivileges(c);
    await c.query('SELECT public.bb_lock_evidence_gate(true)');
    const q=(await c.query('SELECT * FROM bb_database_restore_quarantines ORDER BY seq DESC LIMIT 1 FOR UPDATE')).rows[0],gate=await gateState(c);
    if(!q||q.id!==pre.id||q.manifest_sha256.trim()!==input.manifestSha256||restoreCanonical(q.preimage)!==restoreCanonical(pre.preimage))restoreConflict();
    const existing=(await c.query('SELECT * FROM bb_database_restore_fence_releases WHERE quarantine_id=$1 AND original_node_id=$2 AND original_epoch=$3',[q.id,input.nodeId,input.epoch])).rows[0];
    if(existing){if(existing.evidence_sha256.trim()!==evidenceSha||restoreCanonical(existing.release_preimage)!==restoreCanonical(releasePreimage))restoreConflict();return {id:existing.id,idempotent:true};}
    if(gate.state!=='paused'||gate.reason_code!=='database_restore_quarantine')restoreConflict();
    const n=(await c.query('SELECT * FROM bb_execution_nodes WHERE id=$1 FOR UPDATE',[input.nodeId])).rows[0];
    if(!n||n.epoch!==input.epoch||!['lost','stop_submitted','stopped'].includes(n.state)||['account_id','region','instance_id','cloud_start_operation_id'].some(key=>n[key]!==original[key]))restoreConflict('Restored node identity changed');
    const currentJobs=(await c.query('SELECT * FROM bb_jobs WHERE execution_node_id=$1 AND execution_node_epoch=$2 AND lease_token IS NOT NULL ORDER BY id FOR UPDATE',[input.nodeId,input.epoch])).rows;
    if(restoreCanonical(currentJobs.map(restoreJobIdentity).sort((a,b)=>a.id.localeCompare(b.id)))!==restoreCanonical(jobs.map(restoreJobIdentity).sort((a:any,b:any)=>a.id.localeCompare(b.id))))restoreConflict('Restore token preimage changed');
    for(const j of currentJobs)if(j.checkpoint.database_restore_quarantine?.restore_id!==q.id||j.checkpoint.database_restore_quarantine?.manifest_sha256!==input.manifestSha256)restoreConflict();
    const currentMessages=(await c.query('SELECT * FROM bb_review_messages WHERE execution_node_id=$1 AND execution_node_epoch=$2 AND lease_token IS NOT NULL ORDER BY id FOR UPDATE',[input.nodeId,input.epoch])).rows;
    if(restoreCanonical(currentMessages.map(restoreJobIdentity).sort((a,b)=>a.id.localeCompare(b.id)))!==restoreCanonical(messages.map(restoreJobIdentity).sort((a:any,b:any)=>a.id.localeCompare(b.id))))restoreConflict('Restore message token preimage changed');
    for(const [table,rows] of [['bb_model_capacity_holders',holders],['bb_model_capacity_waiters',waiters]] as const){
      const current=(await c.query(`SELECT row_to_json(h) AS record FROM ${table} h WHERE execution_node_id=$1 AND execution_node_epoch=$2 ORDER BY token FOR UPDATE`,[input.nodeId,input.epoch])).rows.map(row=>row.record);
      if(restoreCanonical(current)!==restoreCanonical([...rows].sort((a,b)=>a.token.localeCompare(b.token))))restoreConflict('Restore capacity preimage changed');
      for(const h of current)if((await c.query(`DELETE FROM ${table} h WHERE token=$1 AND row_to_json(h)::jsonb=$2::jsonb`,[h.token,JSON.stringify(h)])).rowCount!==1)restoreConflict();
    }
    const id=uid(),proof={version:'restore-fence-v1',receipt_id:id,quarantine_id:q.id,manifest_sha256:input.manifestSha256,node_id:input.nodeId,epoch:input.epoch,operation_id:fence.stop_operation_id,evidence_sha256:evidenceSha};
    await c.query(`INSERT INTO bb_database_restore_fence_releases(id,quarantine_id,manifest_sha256,original_node_id,original_epoch,evidence_ref,evidence_sha256,release_preimage,actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,q.id,input.manifestSha256,input.nodeId,input.epoch,input.evidenceRef,evidenceSha,releasePreimage,actorId]);
    for(const j of currentJobs)await c.query("UPDATE bb_jobs SET lease_token=NULL,lease_until=NULL,checkpoint=checkpoint||jsonb_build_object('restore_fence_v1',$3::jsonb),updated_at=now() WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token,JSON.stringify(proof)]);
    for(const m of currentMessages){await c.query("UPDATE bb_review_messages SET lease_token=NULL,lease_until=NULL,reply_status='unknown',error='EXECUTION_EPOCH_STOPPED' WHERE id=$1 AND lease_token=$2",[m.id,m.lease_token]);
      await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'review.assistant_replied',$4)",[uid(),m.owner_user_id,m.project_id,{message_id:m.id,status:'unknown',error:'EXECUTION_EPOCH_STOPPED'}]);}
    await c.query("UPDATE bb_execution_node_sessions SET state='lost',ready=false WHERE node_id=$1 AND epoch=$2",[input.nodeId,input.epoch]);
    return {id,idempotent:false};
  });
}

async function restoreReleaseReady(c:PoolClient,r:any,j:any){
  const quarantine=j.checkpoint.database_restore_quarantine,proof=j.checkpoint.restore_fence_v1;
  if(!quarantine||j.lease_token)return false;
  const q=(await c.query('SELECT * FROM bb_database_restore_quarantines ORDER BY seq DESC LIMIT 1')).rows[0];
  if(!q||q.id!==quarantine.restore_id||q.manifest_sha256.trim()!==quarantine.manifest_sha256)return false;
  const original=q.preimage.jobs.find((old:any)=>old.id===j.id&&old.owner_user_id===r.owner_user_id&&old.run_id===r.id);
  if(!original)return false;
  if(!original.lease_token){
    if(original.attempts===0&&!original.execution_session_id&&j.checkpoint.never_admitted_v1?.version==='never-admitted-v1'&&j.checkpoint.never_admitted_v1.job_id===j.id)return true;
    const fenced=(await c.query('SELECT 1 FROM bb_database_restore_fence_releases WHERE quarantine_id=$1 AND manifest_sha256=$2 AND original_node_id=$3 AND original_epoch=$4',[q.id,q.manifest_sha256,original.execution_node_id,original.execution_node_epoch])).rowCount;
    return !!fenced&&original.execution_node_id===j.execution_node_id&&original.execution_node_epoch===j.execution_node_epoch&&original.execution_session_id===j.execution_session_id;
  }
  const release=(await c.query('SELECT * FROM bb_database_restore_fence_releases WHERE id=$1 AND quarantine_id=$2 AND manifest_sha256=$3 AND original_node_id=$4 AND original_epoch=$5',
    [proof?.receipt_id,q.id,q.manifest_sha256,original.execution_node_id,original.execution_node_epoch])).rows[0];
  return !!release&&proof?.version==='restore-fence-v1'&&proof.quarantine_id===q.id&&proof.manifest_sha256===q.manifest_sha256.trim()&&proof.evidence_sha256===release.evidence_sha256.trim()&&
    proof.node_id===j.execution_node_id&&proof.epoch===j.execution_node_epoch&&j.execution_node_id===original.execution_node_id&&j.execution_node_epoch===original.execution_node_epoch&&j.execution_session_id===original.execution_session_id&&
    release.release_preimage.jobs.some((old:any)=>restoreCanonical(old)===restoreCanonical(restoreJobIdentity(original)));
}

/** Final account-authorized restore CAS. Ordinary user/automatic resume cannot
 * enter this branch or infer not_sent from an older snapshot. */
export async function resumeRestoredRun(pool:Pool,actorId:string,owner:string,runId:string,input:{quarantineId:string;manifestSha256:string},options:{blobs:PrivateBlobs}){
  if(!actorId)restoreConflict();
  await assertRestoreControlPrivileges(pool);
  const verified=await verifyWorkflowResume(pool,owner,runId,options.blobs);
  return transaction(pool,async c=>{
    await assertRestoreControlPrivileges(c);
    await c.query('SELECT public.bb_lock_evidence_gate(false)');
    const r=await run(c,owner,runId,true),j=(await c.query('SELECT * FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 FOR UPDATE',[runId,owner])).rows[0];
    if(!j||terminal.has(r.state)||j.state!=='paused'||j.checkpoint.database_restore_quarantine?.restore_id!==input.quarantineId||j.checkpoint.database_restore_quarantine?.manifest_sha256!==input.manifestSha256)return false;
    if((await gateState(c)).state!=='open'||!await restoreReleaseReady(c,r,j)||!await workflowResumeReady(c,r,j,verified))return false;
    const immutable=(await c.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE project_id=$1 AND owner_user_id=$2 AND revision=$3',[r.project_id,owner,r.input_revision])).rows[0];
    if(!immutable||immutable.input_hash.trim()!==String(r.input_hash).trim()||inputManifestHash(immutable.manifest)!==String(r.input_hash).trim()||await providerCallNeedsReconciliation(c,j.id)||await walletIsolated(c,r)||!await billingContractRecoverable(c,r,j))return false;
    if(!(await c.query('SELECT 1 FROM bb_projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL AND deleted_at IS NULL',[r.project_id,owner])).rowCount)return false;
    if(j.billing_cancel_requested_at){await finalizePendingCancellation(c,r,j);return true;}
    if(j.user_pause_requested||j.credit_pause_requested)return false;
    await c.query("UPDATE bb_jobs SET state='queued',stage='queued',checkpoint=(checkpoint-'database_restore_quarantine')||jsonb_build_object('database_restore_resumed_v1',$2::jsonb),updated_at=now() WHERE id=$1",[j.id,{quarantine_id:input.quarantineId,manifest_sha256:input.manifestSha256,actor_id:actorId}]);
    await event(c,r,'queued','queued','database_restore_reconciled',undefined,'run.state_changed',{quarantine_id:input.quarantineId},'preserve_restore_v1');return true;
  });
}

type OriginalCaptureExecution={nodeId:string;epoch:string;sessionId:string};
type CaptureCallProof={version:'call_cgroup_v1';key:string;identity:string;parentKey:string;parentIdentity:string;logicalCallId:string;generation:number;epoch:string;sessionId:string;sealed:true;nativeProcesses:0};
async function registeredCaptureSession(client:PoolClient,pool:Pool){
  const c=executionNodeForPool(pool);if(!c)throw new Problem(409,'CAPABILITY_NOT_READY','Capture registration requires a trusted execution session');
  const n=(await client.query('SELECT id,epoch,state FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3 FOR UPDATE',[c.identity.account_id,c.identity.region,c.identity.instance_id])).rows[0];
  if(!n||n.epoch!==c.identity.epoch||!(await client.query("SELECT 1 FROM bb_execution_node_sessions WHERE session_id=$1 AND node_id=$2 AND epoch=$3 AND state='active'",[c.session_id,n.id,n.epoch])).rowCount)
    throw new Problem(409,'CAPABILITY_NOT_READY','Capture registration session is stale');
  return {nodeId:n.id,epoch:n.epoch,sessionId:c.session_id};
}
async function exactCaptureAttempt(client:PoolClient,input:{ownerUserId:string;projectId:string;runId:string;jobId:string;attemptId:string;logicalCallId:string;attemptNo:number;originalExecution:OriginalCaptureExecution}){
  const q=await client.query(`SELECT a.id FROM bb_model_call_attempts a JOIN bb_model_attempt_execution_configs c ON c.attempt_id=a.id
    JOIN bb_execution_node_sessions s ON s.session_id=c.execution_session_id
    WHERE a.id=$1 AND a.owner_user_id=$2 AND a.job_id=$3 AND a.logical_call_id=$4 AND a.attempt_no=$5
    AND c.project_id=$6 AND c.run_id=$7 AND c.execution_session_id=$8 AND c.execution_node_epoch=$9 AND s.node_id=$10 AND s.epoch=$9`,
  [input.attemptId,input.ownerUserId,input.jobId,input.logicalCallId,input.attemptNo,input.projectId,input.runId,input.originalExecution.sessionId,input.originalExecution.epoch,input.originalExecution.nodeId]);
  if(!q.rowCount)throw new Problem(409,'INPUT_REVISION_CONFLICT','Capture does not match the immutable original attempt configuration');
}
export async function recordSealedCapture(pool:Pool,lease:Lease,input:{attemptId:string;logicalCallId:string;attemptNo:number;originalExecution:OriginalCaptureExecution;spoolId:string;localManifestSha256:string;callExitProof:CaptureCallProof;rawUsage:unknown;rawOutcome:unknown}){
  const p=input.callExitProof,scopeKey=digest(Buffer.from(JSON.stringify({kind:'job',id:lease.jobId,token:lease.token})));
  if(p?.version!=='call_cgroup_v1'||p.sealed!==true||p.nativeProcesses!==0||p.parentKey!==scopeKey||p.logicalCallId!==input.logicalCallId||p.generation!==input.attemptNo||p.epoch!==input.originalExecution.epoch||p.sessionId!==input.originalExecution.sessionId||
    !/^[a-f0-9-]+:[0-9]+:[0-9]+$/.test(p.identity)||!/^[a-f0-9-]+:[0-9]+:[0-9]+$/.test(p.parentIdentity)||!/^[a-f0-9]{64}$/.test(input.localManifestSha256)||!input.spoolId)
    throw new Problem(422,'VALIDATION_FAILED','Capture lacks an exact sealed call proof');
  return transaction(pool,async client=>{
    const current=await registeredCaptureSession(client,pool);
    if(input.originalExecution.nodeId!==current.nodeId||input.originalExecution.epoch!==current.epoch||input.originalExecution.sessionId!==current.sessionId)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Only the original session can register the local sealed call');
    const r=await run(client,lease.owner,lease.runId,true),j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND run_id=$2 AND owner_user_id=$3 FOR UPDATE',[lease.jobId,lease.runId,lease.owner])).rows[0];
    if(!j||j.state!=='running'||j.lease_token!==lease.token||j.execution_session_id!==current.sessionId||j.execution_node_epoch!==current.epoch)
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Capture lease identity changed');
    await exactCaptureAttempt(client,{...input,ownerUserId:lease.owner,projectId:r.project_id,runId:r.id,jobId:j.id});
    const hash=inputManifestHash({...input,jobId:j.id,runId:r.id,owner:lease.owner,leaseToken:lease.token});
    const id=uid();await client.query(`INSERT INTO bb_sealed_model_captures(id,owner_user_id,project_id,run_id,job_id,attempt_id,logical_call_id,attempt_no,execution_node_id,execution_node_epoch,execution_session_id,lease_token,spool_id,manifest_sha256,call_exit_proof,raw_usage,raw_outcome,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(attempt_id) DO NOTHING`,
      [id,lease.owner,r.project_id,r.id,j.id,input.attemptId,input.logicalCallId,input.attemptNo,current.nodeId,current.epoch,current.sessionId,lease.token,input.spoolId,input.localManifestSha256,p,JSON.stringify(input.rawUsage??null),JSON.stringify(input.rawOutcome),hash]);
    const prior=(await client.query('SELECT id,evidence_sha256 FROM bb_sealed_model_captures WHERE attempt_id=$1',[input.attemptId])).rows[0];
    if(prior.evidence_sha256.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Sealed capture evidence changed');
    return {id:prior.id as string,idempotent:prior.id!==id};
  });
}
export async function registerRecoveredCaptureEvidence(pool:Pool,input:{ownerUserId:string;projectId:string;runId:string;jobId:string;attemptId:string;logicalCallId:string;attemptNo:number;originalExecution:OriginalCaptureExecution;capture:{key:string;sha256:string;byteSize:number};manifestSha256:string},options:{blobs:PrivateBlobs}){
  const capture=input.capture;
  if(!/^[a-f0-9]{64}$/.test(capture.sha256)||!Number.isSafeInteger(capture.byteSize)||capture.byteSize<1||capture.byteSize>100*1024*1024||
    capture.key!==`users/${input.ownerUserId}/projects/${input.projectId}/recovered-captures/${input.attemptId}-${capture.sha256}.json`||!/^[a-f0-9]{64}$/.test(input.manifestSha256))
    throw new Problem(422,'VALIDATION_FAILED','Invalid recovered capture object');
  const bytes=await options.blobs.getIfExistsBounded(capture.key,100*1024*1024);
  if(!bytes||bytes.length!==capture.byteSize||digest(bytes)!==capture.sha256)throw new Problem(409,'CAPABILITY_NOT_READY','Recovered capture object is missing or changed');
  return transaction(pool,async client=>{
    const current=await registeredCaptureSession(client,pool);await exactCaptureAttempt(client,input);
    const hash=inputManifestHash(input),id=uid();
    await client.query(`INSERT INTO bb_recovered_capture_evidence(id,owner_user_id,project_id,run_id,job_id,attempt_id,logical_call_id,attempt_no,original_node_id,original_epoch,original_session_id,recovery_session_id,capture_ref,capture_sha256,byte_size,manifest_sha256,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(attempt_id,capture_sha256) DO NOTHING`,
      [id,input.ownerUserId,input.projectId,input.runId,input.jobId,input.attemptId,input.logicalCallId,input.attemptNo,input.originalExecution.nodeId,input.originalExecution.epoch,input.originalExecution.sessionId,current.sessionId,capture.key,capture.sha256,capture.byteSize,input.manifestSha256,hash]);
    const prior=(await client.query('SELECT id,evidence_sha256 FROM bb_recovered_capture_evidence WHERE attempt_id=$1 AND capture_sha256=$2',[input.attemptId,capture.sha256])).rows[0];
    if(prior.evidence_sha256.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Recovered capture identity changed');
    return {id:prior.id as string,idempotent:prior.id!==id};
  });
}

/** A request is registered before either the local or shared model-capacity queue.
 * Do not change run state/stage: an executing job waiting for a model still owns
 * its lease. Only this lease's complete set of requests controls its meter. */
export async function setRunModelActivity(pool:Pool,lease:Lease,requestId:string,state:'waiting'|'active'|'finished'|'abandoned'):Promise<boolean>{
  if(!/^[a-f0-9-]{36}$/.test(requestId))throw new Problem(422,'VALIDATION_FAILED','Invalid model activity request');
  return transaction(pool,async client=>{
    let locked;
    try{locked=await lockedLease(client,lease);}
    catch(error){
      if((state==='finished'||state==='abandoned')&&error instanceof Problem&&['ALREADY_TERMINAL','NOT_FOUND'].includes(error.code))return false;
      throw error;
    }
    const {r}=locked;
    const prior=(await client.query('SELECT * FROM bb_run_model_activity WHERE request_id=$1',[requestId])).rows[0];
    if(prior&&(prior.owner_user_id!==lease.owner||prior.run_id!==lease.runId||prior.job_id!==lease.jobId||prior.lease_token!==lease.token))
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Model activity request belongs to another lease');
    if(prior?.state===state)return true;
    if(state==='waiting'&&prior||state==='active'&&prior?.state!=='waiting')
      throw new Problem(409,'INPUT_REVISION_CONFLICT','Model activity cannot be reopened');
    if((state==='finished'||state==='abandoned')&&!prior)return false;
    if(state==='finished'&&prior.state!=='active')return false;
    // Settle the old interval before the transition, then start/freeze the new
    // interval at the database clock. Renewals and cancellation use these locks.
    await syncAuthoringProgress(client,r);
    if(state==='waiting'){
      await client.query(`INSERT INTO bb_run_model_activity(request_id,owner_user_id,run_id,job_id,lease_token,state)
        VALUES($1,$2,$3,$4,$5,'waiting')`,[requestId,lease.owner,lease.runId,lease.jobId,lease.token]);
    }else if(state==='finished'){
      await client.query('DELETE FROM bb_run_model_activity WHERE request_id=$1',[requestId]);
    }else{
      await client.query('UPDATE bb_run_model_activity SET state=$2,updated_at=clock_timestamp() WHERE request_id=$1',[requestId,state]);

    }
    // An abandoned wait remains a frozen marker until work explicitly resumes.
    // Deleting the last failed waiter here would start charging before the
    // caller has persisted its pause/failure (possibly behind a blocked DB lock).
    await syncAuthoringProgress(client,r);
    return true;
  });
}


export async function renew(pool:Pool, lease:Lease, leaseSeconds=30) {
  const parked=await transaction(pool,async client=>{const {r,j}=await lockedLease(client,lease,true);
    if(j.checkpoint?.workflow_v1?.pending_disposition||j.checkpoint?.workflow_pending_disposition_v1){lease.checkpoint=j.checkpoint;return true;}
    if(await walletIsolated(client,r)){await parkBilling(client,r,j,'wallet_isolated',false,true);return true;}
    await syncAuthoringProgress(client,r);
    // now() is the transaction start, which can be minutes before these locks
    // become available. Publish the next lease at the end using wall-clock time.
    // The running meter inherits the same deadline; a paused meter stays frozen.
    // A bookkeeping lock can also outlive the old lease after its clock sample.
    // Shift only that unconfirmed gap out of the cursor, preserving the pending
    // valid delta for the next dynamic debit instead of advancing active_ms here.
    await client.query(`WITH renewed AS (
      UPDATE bb_jobs SET lease_until=clock_timestamp()+($2::integer * interval '1 second'),updated_at=clock_timestamp()
      WHERE id=$1 RETURNING run_id,owner_user_id,lease_until,updated_at AS renewed_at
    ) UPDATE bb_authoring_progress progress SET
      clock_at=progress.clock_at+GREATEST(interval '0 seconds',renewed.renewed_at-GREATEST(progress.clock_at,progress.lease_until)),
      lease_until=renewed.lease_until FROM renewed
      WHERE progress.run_id=renewed.run_id AND progress.owner_user_id=renewed.owner_user_id AND progress.lease_until IS NOT NULL`,[lease.jobId,leaseSeconds]);return false;});
  // Commit the control pause before revoking the caller's lease. Heartbeats
  // abort in-flight work immediately instead of waiting for another renewal.
  if(parked)throw new Problem(409,'ALREADY_TERMINAL','Lease paused for billing reconciliation');
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
    if(await walletIsolated(client,r)){await parkBilling(client,r,j,'wallet_isolated',false,true);return true;}
    await syncAuthoringProgress(client,r);
    const creditPause=(await client.query('SELECT credit_pause_requested FROM bb_jobs WHERE id=$1',[j.id])).rows[0].credit_pause_requested;
    if(creditPause){
      if(workflowOwned(j)){await pendingWorkflowDisposition(client,r,j,{kind:'pause',stage:'credits_exhausted',reason:'credits_exhausted',error_code:'CREDITS_INSUFFICIENT'},lease);return true;}
      await client.query("UPDATE bb_jobs SET state='paused',stage='credits_exhausted',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await event(client,r,'paused','credits_exhausted','credits_exhausted','CREDITS_INSUFFICIENT');
      return true;
    }
    if(!j.user_pause_requested)return false;
    if(workflowOwned(j)){await pendingWorkflowDisposition(client,r,j,{kind:'pause',stage:'user_paused',reason:'user_paused'},lease);return true;}
    await client.query("UPDATE bb_jobs SET state='paused',stage='user_paused',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
    await event(client,r,'paused','user_paused','user_paused');
    return true;
  });
}
export async function beginRunStage(pool:Pool,lease:Lease,stage:string){
  await transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    if(!['update','generation'].includes(r.task_kind)||(String(j.subtype).startsWith('m4_')&&j.subtype!=='m4_document_v1'))return;
    await syncAuthoringProgress(client,r);
    await client.query("DELETE FROM bb_run_model_activity WHERE job_id=$1 AND lease_token=$2 AND state='abandoned'",[j.id,lease.token]);
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
    const {r,j}=await lockedLease(client,lease);
    const next=workflowOwned(j)?{...j.checkpoint,...value,...(j.checkpoint.workflow_v1?{workflow_v1:j.checkpoint.workflow_v1}:{}),...(j.checkpoint.workflow_admission_v1?{workflow_admission_v1:j.checkpoint.workflow_admission_v1}:{})}:value;
    await client.query('UPDATE bb_jobs SET checkpoint=$2,stage=$3,updated_at=now() WHERE id=$1',[lease.jobId,next,stage]);lease.checkpoint=next;
    await event(client,r,'running',stage,'checkpoint_saved',undefined,'run.progress');
  });
}

// Persist intent before any supplier request. An unknown attempt is never silently resent.
export async function recordPotentialCall(pool:Pool, lease:Lease, logicalCallId:string, attemptNo:number, metadata:{callId?:string;modelId?:string;promptSnapshotId?:string;fileAuthoringRecoveryCapture?:boolean;fileAuthoringDeadlineAt?:string}={}) {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(logicalCallId)||!Number.isSafeInteger(attemptNo)||attemptNo<1)throw new Problem(422,'VALIDATION_FAILED','Invalid provider call identity');
  const attemptId=metadata.callId??uid();
  if(metadata.fileAuthoringRecoveryCapture===true&&!/^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(logicalCallId))
    throw new Problem(422,'VALIDATION_FAILED','Invalid file recovery capture identity');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId))throw new Problem(422,'VALIDATION_FAILED','Invalid provider call identity');
  if(metadata.fileAuthoringDeadlineAt!==undefined&&(!metadata.fileAuthoringRecoveryCapture||!isFileAuthoringDeadline(metadata.fileAuthoringDeadlineAt)))
    throw new Problem(422,'VALIDATION_FAILED','Invalid file authoring deadline');
  // #79: no durable intent, no call. An evidence outage pauses every NEW external call.
  await ensureExternalCallsAllowed(pool);
  let recordedCheckpoint:Record<string,unknown>|undefined;
  await guardEvidenceWrite(pool,'call_intent_not_persisted',()=>transaction(pool,async client=>{
    await assertGateOpen(client);
    const {r,j}=await lockedLease(client,lease);
    if(j.checkpoint?.workflow_v1?.pending_disposition||j.checkpoint?.workflow_pending_disposition_v1)throw new Problem(409,'ALREADY_TERMINAL','Workflow is stopping before another provider call');
    // The first host intent binds this logical call even across ordinary operator
    // retries. A later attempt cannot remove, extend, or replace its deadline.
    const deadlines=Object.values(j.checkpoint?.file_authoring_recovery_captures??{}) as FileAuthoringCapture[];
    for(const prior of deadlines)if(prior?.logical_call_id===logicalCallId&&Object.hasOwn(prior,'deadline_at')){
      if(!isFileAuthoringDeadline(prior.deadline_at)||metadata.fileAuthoringDeadlineAt!==prior.deadline_at)
        throw new Problem(409,'INPUT_REVISION_CONFLICT','File authoring deadline changed');
    }
    if(metadata.fileAuthoringDeadlineAt!==undefined&&Date.parse(metadata.fileAuthoringDeadlineAt)<=Date.now())
      throw new Problem(409,'CAPABILITY_NOT_READY','AUTHORING_CONTEXT_DEADLINE_EXCEEDED');
    // A private review reassembly may only read its completed durable call. This
    // check uses the locked database checkpoint, never a caller's stale lease copy.
    if(j.checkpoint?.review_assembly_recovery)
      throw new Problem(409,'CAPABILITY_NOT_READY','Review reassembly is reuse-only; new provider calls are forbidden');
    // Admission may wait on the shared model budget. Check again while holding
    // the lease/job locks, before the durable intent can authorize a new call.
    if(j.user_pause_requested||j.credit_pause_requested)
      throw new Problem(409,'CAPABILITY_NOT_READY','Run paused before provider admission');
    if(r.channel==='non_production_test')await assertTestGrant(client,{grantId:r.test_grant_id,userId:r.owner_user_id,projectId:r.project_id,inputRevision:r.input_revision,inputHash:r.input_hash});
    // Re-check the kill switch and deny override before every new call; daily usage is uncapped.
    await assertModelCallAllowed(client,trialGuardConfig(),lease.owner);
    if(metadata.promptSnapshotId){
      const ref=await client.query('SELECT 1 FROM bb_snapshot_refs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND run_id=$4',[metadata.promptSnapshotId,lease.owner,r.project_id,r.id]);
      if(!ref.rowCount)throw missing();
    }
    const sequence=await client.query('SELECT COALESCE(max(attempt_no),0)::int AS last_attempt FROM bb_model_call_attempts WHERE job_id=$1 AND logical_call_id=$2',[lease.jobId,logicalCallId]);
    if(attemptNo!==Number(sequence.rows[0].last_attempt)+1)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Provider attempt numbers must increase monotonically');
    await client.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,prompt_snapshot_id,channel) VALUES($1,$2,$3,$4,$5,'pending_reconcile',$6,$7,$8)",[attemptId,lease.owner,lease.jobId,logicalCallId,attemptNo,metadata.modelId??null,metadata.promptSnapshotId??null,r.channel]);
    if(metadata.fileAuthoringRecoveryCapture===true){
      const capture:FileAuthoringCapture={version:FILE_AUTHORING_CAPTURE_VERSION,owner_user_id:lease.owner,project_id:r.project_id,run_id:r.id,job_id:j.id,
        input_revision:Number(r.input_revision),input_hash:String(r.input_hash).trim(),attempt_id:attemptId,logical_call_id:logicalCallId,
        prepared_at:new Date().toISOString(),state:'prepared',failure_code:null,
        ...(metadata.fileAuthoringDeadlineAt!==undefined?{deadline_at:metadata.fileAuthoringDeadlineAt}:{})};
      recordedCheckpoint={...j.checkpoint,file_authoring_recovery_captures:{...j.checkpoint?.file_authoring_recovery_captures,[attemptId]:capture}};
      await client.query('UPDATE bb_jobs SET checkpoint=$2::jsonb,updated_at=now() WHERE id=$1',[j.id,JSON.stringify(recordedCheckpoint)]);
    }
    await emitInternal(client,internalEvent({kind:'model.call_started',owner:lease.owner,projectId:r.project_id,runId:r.id,jobId:lease.jobId,traceId:r.id,logicalCallId,attemptNo,promptSnapshotRef:metadata.promptSnapshotId}));
    await event(client,r,'running','provider_call','provider_call_may_be_sent');
  })).catch(async error=>{await reportTrialRejection(pool,error,lease.owner);throw error;});
  if(recordedCheckpoint)lease.checkpoint=recordedCheckpoint;
  return attemptId;
}

function fileAuthoringCapture(r:any,j:any,a:{id:string;logical_call_id:string}):FileAuthoringCapture|null {
  const value=j.checkpoint?.file_authoring_recovery_captures?.[a.id];
  if(!value||value.version!==FILE_AUTHORING_CAPTURE_VERSION||value.owner_user_id!==r.owner_user_id||value.project_id!==r.project_id||value.run_id!==r.id||value.job_id!==j.id
    ||value.input_revision!==Number(r.input_revision)||value.input_hash!==String(r.input_hash).trim()||value.attempt_id!==a.id||value.logical_call_id!==a.logical_call_id
    ||typeof value.prepared_at!=='string'||!Number.isFinite(Date.parse(value.prepared_at))
    ||Object.hasOwn(value,'deadline_at')&&!isFileAuthoringDeadline(value.deadline_at))return null;
  if(!['prepared','saved','failed'].includes(value.state)||(value.state==='failed'?!FILE_AUTHORING_CAPTURE_FAILURES.includes(value.failure_code):value.failure_code!==null))return null;
  return value;
}

/** A failed result write leaves the intent's prepared marker intact; it cannot turn a modern call into a legacy one. */
export async function recordFileAuthoringCaptureOutcome(pool:Pool,lease:Lease,attemptId:string,logicalCallId:string,outcome:FileAuthoringCaptureOutcome) {
  if(!outcome||!['saved','failed'].includes(outcome.state)||(outcome.state==='failed'?!FILE_AUTHORING_CAPTURE_FAILURES.includes(outcome.failure_code):outcome.failure_code!==null))
    throw new Problem(422,'VALIDATION_FAILED','Invalid file recovery capture outcome');
  let checkpoint:Record<string,unknown>|undefined;
  await transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease),capture=fileAuthoringCapture(r,j,{id:attemptId,logical_call_id:logicalCallId});
    const current=(await client.query('SELECT id FROM bb_model_call_attempts WHERE job_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC,attempt_no DESC LIMIT 1',[j.id,lease.owner])).rows[0];
    if(!capture||current?.id!==attemptId)throw new Problem(409,'INPUT_REVISION_CONFLICT','File recovery capture attempt changed');
    const snapshot=j.checkpoint?.stages?.file_authoring_recovery;
    if(outcome.state==='saved'&&(!validFileAuthoringRecovery(snapshot,{owner:lease.owner,project:r.project_id,run:r.id,
      inputHash:String(r.input_hash).trim(),attempt:attemptId,logical:logicalCallId})||snapshot?.deadline_at!==capture.deadline_at))
      throw new Problem(409,'INPUT_REVISION_CONFLICT','A complete matching recovery checkpoint is required');
    if(capture.state!=='prepared'&&(capture.state!==outcome.state||capture.failure_code!==outcome.failure_code))
      throw new Problem(409,'IDEMPOTENCY_CONFLICT','File recovery capture outcome is already recorded');
    checkpoint={...j.checkpoint,file_authoring_recovery_captures:{...j.checkpoint.file_authoring_recovery_captures,[attemptId]:{...capture,state:outcome.state,failure_code:outcome.failure_code}}};
    await client.query('UPDATE bb_jobs SET checkpoint=$2::jsonb,updated_at=now() WHERE id=$1',[j.id,JSON.stringify(checkpoint)]);
  });
  lease.checkpoint=checkpoint!;
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

export async function action(pool:Pool,owner:string,runId:string,kind:'cancel'|'resume'|'pause',requestId?:string,options?:{blobs:PrivateBlobs}) {
  const workflowVerified=kind==='resume'?await verifyWorkflowResume(pool,owner,runId,options?.blobs):undefined;
  return transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j)throw missing();
    if(terminal.has(r.state))throw new Problem(409,'ALREADY_TERMINAL','Run already finished');
    if(j.checkpoint.database_restore_quarantine){
      if(kind==='resume')throw new Problem(409,'CAPABILITY_NOT_READY','Database restore requires the dedicated verified recovery entry');
      await client.query(kind==='pause'?'UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1':'UPDATE bb_jobs SET billing_cancel_requested_at=COALESCE(billing_cancel_requested_at,now()) WHERE id=$1',[j.id]);
      return runDto(r);
    }
    if(workflowOwned(j)&&kind==='resume'&&!await workflowResumeReady(client,r,j,workflowVerified))
      throw new Problem(409,'CAPABILITY_NOT_READY','Workflow requires verified objects and a positive termination receipt before resume');
    if(workflowOwned(j)&&j.lease_token&&(kind==='cancel'||kind==='pause')){
      if(kind==='pause')await client.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[j.id]);
      else await client.query('UPDATE bb_jobs SET billing_cancel_requested_at=COALESCE(billing_cancel_requested_at,now()) WHERE id=$1',[j.id]);
      await pendingWorkflowDisposition(client,r,j,{kind:kind==='cancel'?'cancel':'pause',stage:kind==='cancel'?'cancelled':'user_paused',reason:kind==='cancel'?'user_cancelled':'user_paused'});
      return runDto(r);
    }
    if(kind==='cancel'||kind==='resume'||kind==='pause'){
      if(await walletIsolated(client,r)){
        if(kind==='pause'){
          if(!['update','generation','review'].includes(r.task_kind)||(String(j.subtype).startsWith('m4_')&&j.subtype!=='m4_document_v1'))
            throw new Problem(422,'VALIDATION_FAILED','This task does not support pausing');
          await client.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[j.id]);
          if(j.stage!=='billing_reconcile')await parkBilling(client,r,j);
          return runDto(r);
        }
        if(kind==='cancel'){
          if(!j.billing_cancel_requested_at){
            await parkBilling(client,r,j,'cancellation_waiting_billing_reconcile',true);
            if(requestId)await recordOperation(client,{owner,projectId:r.project_id,runId,jobId:j.id,requestId,traceId:runId,kind:'run_cancel',status:'submitted'});
          }
          return runDto(r);
        }
        throw new Problem(409,'BILLING_NOT_READY','余额核对完成后将继续原任务；已请求取消的任务将释放原预留。');
      }
      if(j.billing_cancel_requested_at){await finalizePendingCancellation(client,r,j);return runDto(r);}
      if(kind==='resume'&&j.stage==='billing_reconcile'&&!await billingContractRecoverable(client,r,j))
        throw new Problem(409,'BILLING_NOT_READY','Original task billing contract requires independent verification');
    }
    if(kind==='pause'){
      if(!['update','generation','review'].includes(r.task_kind)||(String(j.subtype).startsWith('m4_')&&j.subtype!=='m4_document_v1'))
        throw new Problem(422,'VALIDATION_FAILED','This task does not support pausing');
      if(r.stage==='credits_exhausted'){
        await client.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[j.id]);
        return runDto(r);
      }
      // The request may race the worker's recovery or context-rotation pause. Persist the user's
      // intent even though the supplier blocker has already paused execution.
      if(!j.user_pause_requested && r.state==='paused' && r.stage==='provider_reconcile' && r.task_kind==='update' &&
        (await client.query(`SELECT 1 FROM bb_model_call_attempts a JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
          JOIN bb_jobs j ON j.id=a.job_id
          WHERE a.job_id=$1 AND a.owner_user_id=$2 AND a.status='pending_reconcile'
          AND t.error_code=ANY($3::text[])
          AND a.logical_call_id ~ '^file-authoring-(v1|size-repair-[1-9][0-9]*)$' LIMIT 1`,[j.id,owner,fileAuthoringRecoveryErrors])).rowCount){
        await client.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[j.id]);
        await event(client,r,'paused','provider_reconcile','user_pause_requested');
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
    let creditPauseCleared=false;
    if(kind==='resume'&&j.credit_pause_requested){
      await lockCreditAccount(client,owner);
      if((await creditBalanceExact(client,owner)).available<1n)throw new Problem(402,'CREDITS_INSUFFICIENT','积分已用完，请充值后继续本次任务。');
      if(r.state==='running')throw new Problem(409,'INPUT_REVISION_CONFLICT','正在保存当前进度，保存后自动继续。');
      await client.query('UPDATE bb_jobs SET credit_pause_requested=false WHERE id=$1',[j.id]);
      j.credit_pause_requested=false;
      creditPauseCleared=true;
    }
    // A user may undo a pending pause while the model is saving its current result.
    if(kind==='resume'&&r.state==='running'&&j.user_pause_requested){
      await client.query('UPDATE bb_jobs SET user_pause_requested=false WHERE id=$1',[j.id]);
      await event(client,r,r.state,r.stage,'user_resumed');
      return runDto({...r,updated_at:new Date()});
    }
    if(kind==='resume'){
      if(r.state!=='paused')throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not paused');
      if(creditPauseCleared&&r.task_kind==='update'&&r.stage==='provider_reconcile'&&j.stage==='provider_reconcile'){
        // Recharge clears only its independent blocker. Unknown calls still need
        // reconciliation and a complete saved workspace.
        await event(client,r,'paused','provider_reconcile','credits_recharged');
        if(requestId)await recordOperation(client,{owner,projectId:r.project_id,runId,jobId:j.id,requestId,traceId:runId,kind:'run_resume',status:'submitted'});
        return runDto({...r,updated_at:new Date()});
      }
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
  const inspection=await withPerformanceSpan('document.inspect',{input_bytes:candidate.length},()=> (policy==='generated_pair_v1'||policy==='generated_review_v1')?inspectGeneratedWord(candidate):inspectDocx(candidate));
  const identity=wordArtifactIdentity(lease,inspection);
  if(inspection.quality_status!=='passed')return persistRejectedWord(pool,lease,inspection,identity);
  await withPerformanceSpan('artifact.prepare_registration',{},()=>transaction(pool,async client=>{
    await assertLockedWordLease(client,lease);
    await client.query(`INSERT INTO bb_artifact_versions
      (id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'passed','pending') ON CONFLICT(id,version) DO NOTHING`,
    [identity.artifactId,identity.artifactVersion,lease.owner,lease.runId,WORD_MEDIA_TYPE,inspection.sha256,identity.objectKey]);
    const artifact=await ensureWordArtifact(client,lease,inspection,identity);
    if(artifact.quality_status==='failed')throw new Problem(409,'IDEMPOTENCY_CONFLICT','Word artifact has a prior quality rejection');
  }));
  try { await withPerformanceSpan('artifact.upload',{input_bytes:candidate.length},()=>blobs.put(identity.objectKey,candidate,WORD_MEDIA_TYPE)); }
  catch { return persistUnavailableWord(pool,lease,inspection,identity,'blob_write_failed'); }
  let readback:Buffer|null;
  try { readback=await withPerformanceSpan('artifact.readback',{operation:'promotion'},()=>blobs.getIfExistsBounded(identity.objectKey,DOCX_LIMITS.archiveBytes)); }
  catch(error) {
    const code=error instanceof Problem && error.status===413?'blob_too_large':'blob_read_failed';
    return persistUnavailableWord(pool,lease,inspection,identity,code);
  }
  if(!readback)return persistUnavailableWord(pool,lease,inspection,identity,'blob_missing');
  if(readback.length>DOCX_LIMITS.archiveBytes)return persistUnavailableWord(pool,lease,inspection,identity,'blob_too_large');
  const readbackSha256=digest(readback);
  if(readback.length!==inspection.byte_size || readbackSha256!==inspection.sha256)
    return persistUnavailableWord(pool,lease,inspection,identity,'blob_hash_mismatch',{sha256:readbackSha256,byteSize:readback.length});
  return withPerformanceSpan('artifact.register',{},()=>persistAvailableWord(pool,lease,inspection,identity));
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
    try { bytes=await withPerformanceSpan('artifact.readback',{operation:'finish'},()=>options.blobs!.getIfExistsBounded(artifact.object_key,DOCX_LIMITS.archiveBytes)); }
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
    const inspection=await withPerformanceSpan('document.inspect',{operation:'finish',input_bytes:bytes.length},()=>artifact.validator_version===GENERATED_WORD_DELIVERY_VERSION?inspectGeneratedWord(bytes!):inspectDocx(bytes!));
    const evidence=artifact.quality_evidence as DocxInspection;
    if(inspection.quality_status!=='passed' || inspection.validator_version!==artifact.validator_version
      || inspection.sha256!==artifact.sha256.trim() || inspection.byte_size!==Number(artifact.evidence_byte_size)
      || evidence?.quality_status!=='passed' || evidence.validator_version!==inspection.validator_version
      || evidence.sha256!==inspection.sha256 || evidence.byte_size!==inspection.byte_size)
      throw new Problem(422,'DELIVERY_FAILED','Word artifact quality evidence mismatch');
  }
  return withPerformanceSpan('run.terminal_persist',{outcome},()=>transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    if(await walletIsolated(client,r)){
      await client.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('billing_terminal',$2::jsonb) WHERE id=$1",
        [j.id,JSON.stringify({outcome,artifactId:options.artifactId,artifactVersion:options.artifactVersion,errorCode:options.errorCode,failedStage:options.failedStage})]);
      await parkBilling(client,r,j,'wallet_isolated',false,true);return runDto(r);
    }
    if(j.billing_cancel_requested_at){await finalizePendingCancellation(client,r,j);return runDto(r);}
    // Charge the remaining locked price only when delivery is ready. Insufficient funds preserve the pair.
    if(outcome==='succeeded'&&!j.user_pause_requested){
      const coveredZero=(await client.query(`SELECT (EXISTS(SELECT 1 FROM bb_commerce_scope_runs coverage
        JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
        WHERE coverage.owner_user_id=$1 AND coverage.run_id=$2 AND scope.amount_fen=0)
        OR EXISTS(SELECT 1 FROM bb_automatic_scope_runs coverage
        JOIN bb_scope_quotations scope ON scope.owner_user_id=coverage.owner_user_id AND scope.id=coverage.scope_quote_id
        WHERE coverage.owner_user_id=$1 AND coverage.run_id=$2 AND scope.amount_fen=0 AND scope.automatic_price IS NOT NULL)) AS covered`,[r.owner_user_id,r.id])).rows[0].covered;
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
      }else if(j.subtype==='workpaper_assessment_v1'){
        const ready=(await client.query('SELECT result FROM bb_workpaper_assessments WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3',[r.owner_user_id,r.project_id,r.id])).rows[0];
        if(!ready?.result||ready.result.document.sha256!==artifact.sha256.trim())throw new Problem(422,'DELIVERY_FAILED','Assessment report required');
      }else if(j.subtype==='project_qa_v1'){
        const ready=(await client.query('SELECT operation,result,manifest FROM bb_project_qa_runs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3',[r.owner_user_id,r.project_id,r.id])).rows[0];
        if(!ready?.result||ready.operation==='answer'&&ready.result.answers.length!==ready.manifest.questions.length||ready.result.document.sha256!==artifact.sha256.trim())
          throw new Problem(422,'DELIVERY_FAILED','Question coverage and filled Word required');
      }else if(j.subtype==='integrity_v1'){
        const ready=await client.query("SELECT i.operation,i.result FROM bb_integrity_runs i WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.run_id=$3",[r.owner_user_id,r.project_id,r.id]);
        if(!ready.rowCount||ready.rows[0].operation==='check'&&!await integrityQueryEvidenceReady(client,r.owner_user_id,r.id,ready.rows[0].result?.records??[]))
          throw new Problem(422,'DELIVERY_FAILED','Integrity workpaper requires recorded actual search');
      }else if(j.subtype==='project_file_v1'&&(await client.query("SELECT 1 FROM bb_project_file_operations WHERE owner_user_id=$1 AND run_id=$2 AND operation='check'",[r.owner_user_id,r.id])).rowCount){
        // Checks deliver one report Word. The locked structured result must cover every selected version.
        // The normal artifact verification above still requires actual Word bytes and readback evidence.
        const ready=(await client.query('SELECT bb_project_file_check_delivery_ready(r) ready FROM bb_runs r WHERE r.id=$1 AND r.owner_user_id=$2',[r.id,r.owner_user_id])).rows[0];
        if(!ready?.ready)throw new Problem(422,'DELIVERY_FAILED','Delivered immutable consistency report required');
      }else if((r.billing_mode==='fixed_credits'||coveredZero)&&r.task_kind!=='review'){
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
        if(workflowOwned(j)){await client.query('UPDATE bb_jobs SET credit_pause_requested=true WHERE id=$1',[j.id]);await pendingWorkflowDisposition(client,r,j,{kind:'pause',stage:'credits_exhausted',reason:'credits_exhausted',error_code:'CREDITS_INSUFFICIENT'},lease);return runDto(r);}
        await client.query("UPDATE bb_jobs SET credit_pause_requested=true,state='paused',stage='credits_exhausted',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
        await event(client,r,'paused','credits_exhausted','credits_exhausted','CREDITS_INSUFFICIENT');
        return runDto({...r,updated_at:new Date()});
      }
    }
    // Pause acceptance and success settlement serialize on the same run/job locks.
    if(outcome!=='failed'&&j.user_pause_requested){
      if(workflowOwned(j)){await pendingWorkflowDisposition(client,r,j,{kind:'pause',stage:'user_paused',reason:'user_paused'},lease);return runDto(r);}
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
    if(workflowOwned(j)){
      await pendingWorkflowDisposition(client,r,j,{kind:outcome==='failed'?'fail':'succeeded',stage:outcome,reason:outcome==='failed'?'processor_failed':'word_delivered',
        ...(options.errorCode?{error_code:options.errorCode}:{}),...(artifact?{artifact_id:artifact.id,artifact_version:artifact.version}:{})},lease);
      return runDto({...r,artifact_id:artifact?.id??null,updated_at:new Date()});
    }
    await client.query('UPDATE bb_jobs SET state=$2,stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[lease.jobId,outcome]);
    if(outcome==='failed')await recordRunFailure(client,r,lease.jobId,options.errorCode,options.failedStage);
    await event(client,r,outcome,outcome,outcome==='failed'?'processor_failed':'word_delivered',options.errorCode);
    if(outcome==='succeeded'){
      await registerGeneratedProspectus(client,r,j.checkpoint?.stages?.word_delivery_pair);
      await registerProjectFileOutcome(client,r,artifact,j.checkpoint?.stages?.word_delivery_pair);
    }
    return runDto({...r,artifact_id:artifact?.id??null,updated_at:new Date()});
  }));
}

/** M4 QA completes with its persisted text result; legacy Word delivery stays unchanged. */
export async function finishM4Qa(pool:Pool,lease:Lease,reply:M4AssistantReply) {
  const {completeM4Qa,settleM4Metering}=await import('./m4-workspace.js');
  return withPerformanceSpan('run.qa_finish',{},()=>transaction(pool,async client=>{
    const {r,j}=await lockedLease(client,lease);
    if(j.subtype!=='m4_qa_v1' || r.task_kind!=='qa' || r.channel!=='production')throw new Problem(422,'VALIDATION_FAILED','M4 QA lease required');
    if(await walletIsolated(client,r)){
      await client.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('billing_qa_reply',$2::jsonb) WHERE id=$1",[j.id,JSON.stringify(reply)]);
      await parkBilling(client,r,j,'wallet_isolated',false,true);return runDto(r);
    }
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
  }));
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
  const category:typeof ERROR_CATEGORIES[number]=errorCode?.startsWith('MODEL_')?'model_provider':code==='DELIVERY_FAILED'||errorCode?.startsWith('WORD_')?'delivery':code==='CAPABILITY_NOT_READY'?'queue':code.startsWith('MATERIAL_')?'material_parse':'internal';
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
export async function checkpointStage(pool:Pool,lease:Lease,stage:string,value:Record<string,unknown>,completed=true) {
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(stage))throw new Problem(422,'VALIDATION_FAILED','Invalid stage');
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    const q=await client.query(`UPDATE bb_jobs SET stage=$2,updated_at=now(),
      checkpoint=checkpoint || jsonb_build_object('stages', COALESCE(checkpoint->'stages','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb))
      WHERE id=$1 RETURNING checkpoint`,[lease.jobId,stage,JSON.stringify(value)]);
    lease.checkpoint=q.rows[0].checkpoint;
    if(completed){
      const started=(await client.query(`SELECT GREATEST(0,EXTRACT(EPOCH FROM (now()-occurred_at))*1000)::bigint AS ms
        FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 AND stage=$3 AND payload->>'reason'='stage_started'
        ORDER BY seq DESC LIMIT 1`,[lease.owner,lease.runId,stage])).rows[0];
      await event(client,r,'running',stage,'stage_completed',undefined,'run.progress',started?{duration_ms:Number(started.ms)}:{});
    }
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
    const {r,j}=await lockedLease(client,lease);
    if(workflowOwned(j)){await pendingWorkflowDisposition(client,r,j,{kind:'pause',stage,reason,...(errorCode?{error_code:errorCode}:{})},lease);return;}
    if(stage==='billing_reconcile'){
      const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0];
      await parkBilling(client,r,j,reason,false,true);return;
    }
    await client.query("UPDATE bb_jobs SET state='paused',stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[lease.jobId,stage]);
    await event(client,r,'paused',stage,reason,errorCode);
  });
}

/** Trusted runtime resume (never a browser principal): re-queues a paused run whose blocker cleared. */
export async function resumePausedRun(pool:Pool,owner:string,runId:string,reason:'materials_ready'|'provider_reconciled'|'trial_limit_cleared'|'credits_recharged'|'billing_reconciled',options?:{blobs:PrivateBlobs}) {
  const workflowVerified=await verifyWorkflowResume(pool,owner,runId,options?.blobs);
  return transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j||j.checkpoint.database_restore_quarantine||!['paused','settlement_pending'].includes(r.state)||j.state!=='paused')return false;
    if(!await workflowResumeReady(client,r,j,workflowVerified))return false;
    if(reason==='provider_reconciled'&&j.billing_cancel_requested_at){
      if(await walletIsolated(client,r)){await parkBilling(client,r,j);return false;}
      await finalizePendingCancellation(client,r,j);return true;
    }
    if(reason==='provider_reconciled'&&!(await client.query('SELECT 1 FROM bb_projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL AND deleted_at IS NULL',[r.project_id,owner])).rowCount)return false;
    if(reason==='billing_reconciled'){
      if(r.stage!=='billing_reconcile'||j.stage!=='billing_reconcile'||await walletIsolated(client,r))return false;
      if(!await billingContractRecoverable(client,r,j))return false;
      if(j.billing_cancel_requested_at){await finalizePendingCancellation(client,r,j);return true;}
      if(await providerCallNeedsReconciliation(client,j.id)){
        // An in-flight supplier result can become unknown during isolation.
        // Hand it to the existing reconciliation sweep once funds are healthy.
        await client.query("UPDATE bb_jobs SET stage='provider_reconcile',updated_at=now() WHERE id=$1",[j.id]);
        await event(client,r,'paused','provider_reconcile','provider_reconciliation_required');
        return false;
      }
    }else if(j.stage==='billing_reconcile')return false;
    if(reason==='credits_recharged'){
      const providerPaused=r.task_kind==='update'&&r.stage==='provider_reconcile'&&j.stage==='provider_reconcile';
      if(!j.credit_pause_requested||(!providerPaused&&(r.stage!=='credits_exhausted'||j.user_pause_requested)))return false;
      await lockCreditAccount(client,owner);
      if((await creditBalanceExact(client,owner)).available<1n)return false;
      if(providerPaused){
        if(j.billing_cancel_requested_at||await walletIsolated(client,r)||!await billingContractRecoverable(client,r,j))return false;
        await client.query('UPDATE bb_jobs SET credit_pause_requested=false,updated_at=now() WHERE id=$1',[j.id]);
        await event(client,r,'paused','provider_reconcile','credits_recharged');
        return true;
      }
    }else if(j.user_pause_requested)return false;

    if(await providerCallNeedsReconciliation(client,j.id))return false;
    // Another blocker may have won while the in-flight result was being saved.
    // Once it clears, retain the credit blocker rather than strand the run in that old stage.
    if(j.credit_pause_requested&&reason!=='credits_recharged'){
      await lockCreditAccount(client,owner);
      if((await creditBalanceExact(client,owner)).available<1n){
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
    const nextStage=reason==='credits_recharged'?'queued':reason==='billing_reconciled'?(j.billing_resume_stage??'queued'):j.stage;
    await client.query("UPDATE bb_jobs SET state='queued',stage=$2,credit_pause_requested=false,checkpoint=CASE WHEN $3 THEN checkpoint-'provider_reconcile_unknown' ELSE checkpoint END,updated_at=now() WHERE id=$1",[j.id,nextStage,reason==='provider_reconciled']);
    await event(client,r,'queued',nextStage,reason);
    return true;
  });
}

/** Paused runs at a stage, oldest first; the runtime sweeps them after their blocker may have cleared. */
export async function pausedRuns(pool:Pool,stage:typeof RUN_PAUSE_STAGES[number],limit=20,runKinds?:readonly RunKind[]) {
  const q=await pool.query(`SELECT j.id AS job_id,j.run_id,j.owner_user_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id
    WHERE j.job_type<>'parse' AND j.state='paused'
    AND (j.stage=$1 OR ($1='credits_exhausted' AND r.task_kind='update' AND r.stage='provider_reconcile'
      AND j.stage='provider_reconcile' AND j.credit_pause_requested))
    AND (r.state='paused' OR r.state='settlement_pending' AND j.subtype IN ('m4_document_v1','m4_qa_v1'))
    AND ($3::text[] IS NULL OR j.job_type=ANY($3::text[]))
    AND ($1<>'credits_exhausted' OR ((NOT j.user_pause_requested OR j.stage='provider_reconcile')
      AND EXISTS(SELECT 1 FROM bb_credit_lots l WHERE l.owner_user_id=r.owner_user_id AND l.remaining>l.frozen
        AND (l.expires_at IS NULL OR l.expires_at>now()))))
    ORDER BY j.updated_at,j.id LIMIT $2`,
    [stage,limit,runKinds ? checkedRunKinds(runKinds) : null]);
  return q.rows as {job_id:string;run_id:string;owner_user_id:string}[];
}

export const PAUSED_RUN_SWEEP_STAGES=['awaiting_materials','credits_exhausted','billing_reconcile','trial_limit'] as const;
export type PausedRunSweepStage=typeof PAUSED_RUN_SWEEP_STAGES[number];
export type PausedRunSweepCandidate={job_id:string;run_id:string;owner_user_id:string;pause_stage:string;pause_event_seq:number;workflow_owned:boolean;workflow_protocol_version:unknown};
type PausedSweepDisposition='checking'|'waiting'|'error'|'manual_required'|'resumed';
const pauseSweepDelay=(attempts:number)=>Math.min(300000,15000*2**Math.min(attempts,5));
const pausedSweepAnchor=`COALESCE((SELECT e.seq FROM bb_run_events e WHERE e.run_id=r.id AND e.state='paused' AND e.type='run.state_changed' ORDER BY e.seq DESC LIMIT 1),0)`;
const pausedSweepVersion=`COALESCE(j.checkpoint#>'{workflow_v1,protocol_version}',j.checkpoint#>'{workflow_admission_v1,protocol_version}','null'::jsonb)`;
const pausedSweepSame=`COALESCE(j.checkpoint#>>ARRAY['paused_sweep_v1',$1::text,'pause_event_seq'],'')=${pausedSweepAnchor}::text
  AND ${pausedSweepVersion}=COALESCE(j.checkpoint#>ARRAY['paused_sweep_v1',$1::text,'workflow_protocol_version'],'null'::jsonb)`;
/** A bounded keyset page, independent of the pause clock. Legacy/NULL due is
 * immediately due; a new pause or protocol invalidates an old disposition. */
export async function pausedRunSweepCandidates(pool:Pool,stage:PausedRunSweepStage,limit=20,runKinds?:readonly RunKind[],afterJobId?:string){
  if(!PAUSED_RUN_SWEEP_STAGES.includes(stage)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid paused sweep page');
  return (await pool.query(`SELECT j.id AS job_id,j.run_id,j.owner_user_id,j.stage AS pause_stage,${pausedSweepAnchor} AS pause_event_seq,
    j.checkpoint ? 'workflow_v1' OR j.checkpoint ? 'workflow_admission_v1' AS workflow_owned,
    COALESCE(j.checkpoint#>'{workflow_v1,protocol_version}',j.checkpoint#>'{workflow_admission_v1,protocol_version}') AS workflow_protocol_version
    FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
    WHERE j.job_type<>'parse' AND j.state='paused' AND j.lease_token IS NULL
    AND (j.stage=$1 OR ($1='credits_exhausted' AND r.task_kind='update' AND r.stage='provider_reconcile' AND j.stage='provider_reconcile' AND j.credit_pause_requested))
    AND (r.state='paused' OR r.state='settlement_pending' AND j.subtype IN ('m4_document_v1','m4_qa_v1'))
    AND ($3::text[] IS NULL OR j.job_type=ANY($3::text[])) AND ($4::text IS NULL OR j.id>$4)
    AND (NOT (${pausedSweepSame}) OR (COALESCE(j.checkpoint#>>ARRAY['paused_sweep_v1',$1::text,'disposition'],'')<>'manual_required'
      AND CASE WHEN jsonb_typeof(j.checkpoint#>ARRAY['paused_sweep_v1',$1::text,'next_due_ms'])='number'
       THEN (j.checkpoint#>>ARRAY['paused_sweep_v1',$1::text,'next_due_ms'])::numeric ELSE 0 END<=EXTRACT(EPOCH FROM clock_timestamp())*1000))
    ORDER BY j.id LIMIT $2`,[stage,limit,runKinds?checkedRunKinds(runKinds):null,afterJobId??null])).rows as PausedRunSweepCandidate[];
}
async function lockedPausedSweep(client:PoolClient,candidate:PausedRunSweepCandidate,allowQueued=false){
  const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[candidate.run_id,candidate.owner_user_id])).rows[0];
  const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND run_id=$2 AND owner_user_id=$3 FOR UPDATE',[candidate.job_id,candidate.run_id,candidate.owner_user_id])).rows[0];
  if(!r||!j||j.lease_token||!(['paused',...(allowQueued?['queued']:[])].includes(j.state))||
    (j.state==='paused'&&j.stage!==candidate.pause_stage)||!['paused','settlement_pending',...(allowQueued?['queued']:[])].includes(r.state))return null;
  const anchor=(await client.query(`SELECT ${pausedSweepAnchor} AS pause_seq,floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::text AS checked_ms FROM bb_runs r WHERE r.id=$1`,[candidate.run_id])).rows[0];
  if(Number(anchor.pause_seq)!==candidate.pause_event_seq)return null;
  return {r,j,now:Number(anchor.checked_ms)};
}
async function writePausedSweep(client:PoolClient,j:any,stage:PausedRunSweepStage,record:Record<string,unknown>){
  const value=j.checkpoint.paused_sweep_v1,scans=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  await client.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('paused_sweep_v1',$2::jsonb) WHERE id=$1",[j.id,JSON.stringify({...scans,[stage]:record})]);
}
/** Persist the retry responsibility before readiness/object IO. The same due
 * record prevents duplicate scans after a crash or a second worker's read. */
export async function beginPausedRunSweep(pool:Pool,candidate:PausedRunSweepCandidate,stage:PausedRunSweepStage):Promise<string|null>{
  return transaction(pool,async client=>{
    const locked=await lockedPausedSweep(client,candidate);if(!locked)return null;const {j,now}=locked;
    const version=j.checkpoint.workflow_v1?.protocol_version??j.checkpoint.workflow_admission_v1?.protocol_version??null;
    if(JSON.stringify(version)!==JSON.stringify(candidate.workflow_protocol_version??null))return null;
    const prior=j.checkpoint.paused_sweep_v1?.[stage],same=prior?.pause_event_seq===candidate.pause_event_seq&&JSON.stringify(prior.workflow_protocol_version??null)===JSON.stringify(version);
    if(same&&(prior.disposition==='manual_required'||typeof prior.next_due_ms==='number'&&prior.next_due_ms>now))return null;
    const attempts=same&&Number.isSafeInteger(prior.attempts)&&prior.attempts>=0?Math.min(Number.MAX_SAFE_INTEGER,prior.attempts+1):1,checkId=uid();
    await writePausedSweep(client,j,stage,{version:1,check_id:checkId,pause_event_seq:candidate.pause_event_seq,pause_stage:candidate.pause_stage,workflow_protocol_version:version,
      attempts,last_checked_ms:now,next_due_ms:now+pauseSweepDelay(attempts),disposition:'checking',reason_code:'readiness_check'});return checkId;
  });
}
export async function completePausedRunSweep(pool:Pool,candidate:PausedRunSweepCandidate,stage:PausedRunSweepStage,checkId:string,disposition:Exclude<PausedSweepDisposition,'checking'>,reasonCode:string){
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode))throw Error('Invalid paused sweep disposition');
  return transaction(pool,async client=>{
    const locked=await lockedPausedSweep(client,candidate,disposition==='resumed');if(!locked)return false;const {j,now}=locked,prior=j.checkpoint.paused_sweep_v1?.[stage];
    if(prior?.check_id!==checkId)return false;
    await writePausedSweep(client,j,stage,{...prior,last_checked_ms:now,next_due_ms:disposition==='manual_required'||disposition==='resumed'?null:now+pauseSweepDelay(prior.attempts),disposition,reason_code:reasonCode});return true;
  });
}

/** A separate keyset scan keeps old unknown calls (and blocked size-limit calls) from
 * starving new recoverable work. Advancing a worker cursor never edits evidence. */
export async function fileAuthoringPayloadRecoveryCandidates(pool:Pool,limit=20,runKinds?:readonly RunKind[],afterJobId?:string) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid recovery batch size');
  const q=await pool.query(`SELECT j.id AS job_id,j.run_id,j.owner_user_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id
    WHERE j.state='paused' AND j.stage='provider_reconcile' AND r.state='paused' AND r.stage='provider_reconcile'
    AND r.task_kind='update' AND ($2::text[] IS NULL OR r.task_kind=ANY($2::text[])) AND ($3::text IS NULL OR j.id>$3)
    AND NOT (COALESCE(j.checkpoint->'provider_reconcile_unknown'->>'exhausted','false')='true')
    AND EXISTS(SELECT 1 FROM bb_model_call_attempts a JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
      WHERE a.job_id=j.id AND a.owner_user_id=j.owner_user_id AND a.status='pending_reconcile'
      AND t.error_code=ANY($4::text[])
      AND a.logical_call_id ~ '^file-authoring-(v1|size-repair-[1-9][0-9]*)$')
    ORDER BY j.id LIMIT $1`,[limit,runKinds?checkedRunKinds(runKinds):null,afterJobId??null,fileAuthoringRecoveryErrors]);
  return q.rows as {job_id:string;run_id:string;owner_user_id:string}[];
}

/** Immutable pause event, not updated_at: scans/progress never extend the deadline. */
const providerPauseStartedAt = `COALESCE((SELECT e.occurred_at FROM bb_run_events e WHERE e.run_id=r.id
  AND e.state='paused' AND e.stage='provider_reconcile' AND e.type='run.state_changed'
  ORDER BY e.seq DESC LIMIT 1),r.updated_at)`;

/** Keyset paging advances even when one row throws or cannot progress. Terminal
 * history is never scanned. Exhausted records from older releases must be closed. */
export async function providerReconciliationCandidates(pool:Pool,limit=20,runKinds?:readonly RunKind[],afterJobId?:string) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid reconciliation batch size');
  return (await pool.query(`SELECT j.id AS job_id,j.run_id,j.owner_user_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id
    WHERE j.state='paused' AND j.stage='provider_reconcile' AND r.state IN ('paused','settlement_pending') AND r.stage='provider_reconcile'
    AND NOT (COALESCE(j.checkpoint#>>'{provider_reconcile_manual,disposition}','')='manual_required'
      AND COALESCE(j.checkpoint#>>'{provider_reconcile_manual,reason_code}','')='workflow_protocol_unsupported')
    AND ($2::text[] IS NULL OR j.job_type=ANY($2::text[])) AND ($3::text IS NULL OR j.id>$3)
    AND (COALESCE(j.checkpoint->'provider_reconcile_unknown'->>'exhausted','false')='true'
      OR ${providerPauseStartedAt}<=clock_timestamp()-interval '1 hour'
      OR CASE WHEN jsonb_typeof(j.checkpoint#>'{provider_reconcile_unknown,next_check_ms}')='number'
        THEN (j.checkpoint#>>'{provider_reconcile_unknown,next_check_ms}')::numeric ELSE 0 END<=EXTRACT(EPOCH FROM clock_timestamp())*1000)
    ORDER BY j.id LIMIT $1`,[limit,runKinds?checkedRunKinds(runKinds):null,afterJobId??null])).rows as
      {job_id:string;run_id:string;owner_user_id:string}[];
}

/** A future workflow protocol cannot be interpreted by this release. Record
 * that boundary atomically without querying a supplier or changing its evidence.
 * Only explicit supported-schema recovery can later remove this manual marker. */
export async function recordUnsupportedWorkflowReconcile(pool:Pool,owner:string,runId:string,jobId:string):Promise<boolean>{
  return transaction(pool,async client=>{
    const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[runId,owner])).rows[0];
    if(!r||!['paused','settlement_pending'].includes(r.state)||r.stage!=='provider_reconcile')return false;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND run_id=$2 AND owner_user_id=$3 FOR UPDATE',[jobId,runId,owner])).rows[0];
    if(!j||j.state!=='paused'||j.stage!=='provider_reconcile')return false;
    const version=j.checkpoint?.workflow_v1?.protocol_version;
    if(!Number.isSafeInteger(version)||version<1||version===1)return false;
    const prior=j.checkpoint?.provider_reconcile_manual;
    if(prior?.disposition==='manual_required'&&prior.reason_code==='workflow_protocol_unsupported'&&prior.protocol_version===version)return true;
    const checked=(await client.query('SELECT clock_timestamp() AS checked_at')).rows[0].checked_at;
    const manual={disposition:'manual_required',reason_code:'workflow_protocol_unsupported',protocol_version:version,last_checked_at:new Date(checked).toISOString()};
    await client.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{provider_reconcile_manual}',$2::jsonb,true),updated_at=now() WHERE id=$1",[jobId,JSON.stringify(manual)]);
    await event(client,r,r.state,'provider_reconcile','workflow_protocol_unsupported','CAPABILITY_NOT_READY','run.progress',{disposition:'manual_required',protocol_version:version});
    return true;
  });
}

/** A task can fail while supplier usage remains unknown. No observation, usage,
 * result or native-process fence is rewritten. Existing terminal billing triggers
 * release/refund the original contract in the same transaction as the event. */
export async function recordProviderReconcileUnknown(
  pool:Pool,owner:string,runId:string,jobId:string,reconciler:string,now=Date.now()
) {
  return transaction(pool,async client=>{
    const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[runId,owner])).rows[0];
    if(!r||r.state!=='paused'||r.stage!=='provider_reconcile')return false;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 FOR UPDATE',[jobId,owner,runId])).rows[0];
    if(!j||j.state!=='paused'||j.stage!=='provider_reconcile'||j.lease_token||j.lease_until)return false;
    if(await walletIsolated(client,r)){await parkBilling(client,r,j);return false;}
    if(j.billing_cancel_requested_at){await finalizePendingCancellation(client,r,j);return true;}
    if(j.user_pause_requested||j.credit_pause_requested){
      const stage=j.user_pause_requested?'user_paused':'credits_exhausted';
      await client.query('UPDATE bb_jobs SET stage=$2,updated_at=now() WHERE id=$1',[jobId,stage]);
      await event(client,r,'paused',stage,stage,stage==='credits_exhausted'?'CREDITS_INSUFFICIENT':undefined);
      return false;
    }
    const attempts=(await client.query(`SELECT a.id,a.logical_call_id,t.error_code,t.exit_code,t.exit_signal,t.adapter,t.adapter_version,t.finish_reason,
      EXISTS(SELECT 1 FROM bb_provider_result_refs p WHERE p.attempt_id=a.id) AS has_result,
      EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=a.id
        AND o.error_code=t.error_code AND o.outcome IN ('failed','pending_reconcile') AND o.result_id IS NULL
         AND (t.error_code<>'MODEL_PROVIDER_OUTPUT_LIMIT' OR
           o.finish_reason='max_output_tokens' AND o.outcome='pending_reconcile' AND o.usage_status='unknown')) AS observed_failure,
      EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=a.id
        AND (o.outcome NOT IN ('failed','pending_reconcile') OR o.error_code IS DISTINCT FROM t.error_code OR o.result_id IS NOT NULL OR
           t.error_code='MODEL_PROVIDER_OUTPUT_LIMIT' AND (o.finish_reason IS DISTINCT FROM 'max_output_tokens' OR
             o.outcome<>'pending_reconcile' OR o.usage_status<>'unknown'))) AS conflicting
      FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id
      LEFT JOIN bb_call_usage u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
      WHERE a.job_id=$1 AND a.owner_user_id=$2 AND ${needsProviderReconciliation} ORDER BY a.created_at,a.id`,[jobId,owner])).rows;
    const project=(await client.query('SELECT archived_at,deleted_at FROM bb_projects WHERE id=$1 AND owner_user_id=$2',[r.project_id,owner])).rows[0];
    const inactive=!project||!!project.archived_at||!!project.deleted_at;
    if(!attempts.length&&!inactive)return false;
    const anchor=(await client.query(`SELECT ${providerPauseStartedAt} AS started_at FROM bb_runs r WHERE r.id=$1`,[runId])).rows[0];
    const transition=nextProviderReconcileUnknown(j.checkpoint?.provider_reconcile_unknown,now,reconciler,
      PROVIDER_RECONCILE_UNKNOWN_GRACE_MS,new Date(anchor.started_at).getTime());
    // Only the no-lookup adapter can prove that another query adds no evidence.
    // A prepared/saved snapshot or conflicting/result evidence gets the full
    // reconciliation window; it is never discarded on a transient recovery miss.
    const unrecoverable=reconciler==='codex_no_lookup'&&attempts.length>0&&attempts.every(a=>
      a.adapter==='codex_exec'&&(a.exit_code!==null||/^SIG[A-Z0-9]+$/.test(a.exit_signal??''))&&
      a.error_code&&a.observed_failure&&!a.conflicting&&!a.has_result&&
      (!/^file-authoring-/.test(a.logical_call_id)||(!j.checkpoint?.stages?.file_authoring_recovery&&
        !['prepared','saved'].includes(j.checkpoint?.file_authoring_recovery_captures?.[a.id]?.state))));
    const [attempt]=attempts;
    const knownOutputLimit=!inactive&&r.task_kind==='update'&&attempts.length===1&&attempt.adapter==='codex_exec'&&attempt.adapter_version==='codex-file-authoring-2'&&
      /^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(attempt.logical_call_id)&&isTerminatedProviderOutputLimit(attempt)&&
      attempt.observed_failure&&!attempt.conflicting&&!attempt.has_result;
    const fail=inactive||unrecoverable||transition.exhausted;
    if(fail)transition.state.exhausted=true;
    await client.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(COALESCE(checkpoint,'{}'::jsonb),
      '{provider_reconcile_unknown}',$2::jsonb,true),updated_at=now() WHERE id=$1`,[jobId,JSON.stringify(transition.state)]);
    if(transition.first)await event(client,r,'paused','provider_reconcile',
      knownOutputLimit?'file_authoring_output_limit_recovery_unavailable':'provider_reconcile_unknown',
      knownOutputLimit?'MODEL_PROVIDER_OUTPUT_LIMIT':'MODEL_PRIOR_ATTEMPT_UNRESOLVED','run.progress',{reconciler,queries:transition.state.queries});
    if(fail){
      const reason=inactive?'provider_reconcile_project_inactive':knownOutputLimit?'file_authoring_output_limit_recovery_unavailable':
        unrecoverable?'provider_reconcile_unrecoverable':'provider_reconcile_unknown_exhausted';
      const error=attempts.at(-1)?.error_code??'DATA_UNAVAILABLE';
      const audit={reconciler,reason_code:reason,decided_at:new Date(now).toISOString(),attempt_ids:attempts.map(a=>a.id)};
      await client.query(`UPDATE bb_jobs SET state='failed',stage='failed',checkpoint=jsonb_set(checkpoint,
        '{provider_reconcile_terminal}',$2::jsonb,true),updated_at=now() WHERE id=$1`,[jobId,JSON.stringify(audit)]);
      await recordRunFailure(client,r,jobId,error,'provider_reconcile');
      await event(client,r,'failed','failed',reason,error,'run.state_changed',
        {reconciler,queries:transition.state.queries,first_at:transition.state.first_at});
    }
    return fail;
  });
}

/** Both recovery policies must refuse archived projects before creating work. */
async function providerRecoveryAllowed(client:PoolClient,r:any,j:any){
  return j.checkpoint?.provider_reconcile_unknown?.exhausted!==true&&!!(await client.query(
    'SELECT 1 FROM bb_projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL AND deleted_at IS NULL',
    [r.project_id,r.owner_user_id])).rowCount;
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
    if(!await providerRecoveryAllowed(client,r,j)||await walletIsolated(client,r)||!await billingContractRecoverable(client,r,j)||j.billing_cancel_requested_at)return false;
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
      const stage=j.user_pause_requested?'user_paused':j.credit_pause_requested?'credits_exhausted':'queued';
      const state=stage==='queued'?'queued':'paused';
      await client.query("UPDATE bb_jobs SET state=$2,stage=$3,checkpoint=checkpoint-'provider_reconcile_unknown' WHERE id=$1",[jobId,state,stage]);
      await event(client,r,state,stage,stage==='queued'?'provider_timeout_retry_scheduled':stage,undefined,'run.state_changed',audit);
    }
    return true;
  });
}
/** Host-created metadata only. The worker verifies every blob/hash again before
 * restoring files; no local path or supplier prose authorizes another call. */
export function validFileAuthoringRecovery(value:unknown,scope:{owner:string;project:string;run:string;inputHash:string;attempt:string;logical:string}):boolean {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(v.version!=='file-authoring-recovery-v1' || v.input_hash!==scope.inputHash ||
    v.attempt_id!==scope.attempt || v.logical_call_id!==scope.logical || !Array.isArray(v.files) ||
    !v.files.length || v.files.length>FILE_AUTHORING_RECOVERY_LIMITS.files ||
    Object.hasOwn(v,'deadline_at')&&!isFileAuthoringDeadline(v.deadline_at))return false;
  const prefix=`owners/${scope.owner}/projects/${scope.project}/runs/${scope.run}/file-authoring/recovery/${scope.attempt}/`;
  const paths=new Set<string>();let total=0;
  for(const entry of v.files){
    if(!entry || typeof entry!=='object' || Array.isArray(entry))return false;
    const f=entry as Record<string,unknown>,path=f.path;
    if(typeof path!=='string' || path.length>1024 || /[\\:\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some(part=>!part || part==='.' || part==='..' || /[. ]$/.test(part)) ||
      !(path==='input.json' || /^(scratch|output)\/.+/.test(path)) || paths.has(path) ||
      typeof f.sha256!=='string' || !/^[a-f0-9]{64}$/.test(f.sha256) ||
      !Number.isSafeInteger(f.byte_size) || Number(f.byte_size)<(path==='input.json'?1:0) || Number(f.byte_size)>FILE_AUTHORING_RECOVERY_LIMITS.fileBytes ||
      f.key!==`${prefix}${f.sha256}/${path}`)return false;
    paths.add(path);total+=Number(f.byte_size);if(total>FILE_AUTHORING_RECOVERY_LIMITS.totalBytes)return false;
  }
  for(const path of paths)for(let parent=path.substring(0,path.lastIndexOf('/'));parent.includes('/');parent=parent.substring(0,parent.lastIndexOf('/')))
    if(paths.has(parent))return false;
  if(Object.hasOwn(v,'controlled_replay')&&(v.controlled_replay!==true||!paths.has('output/operations.json')))return false;
  return paths.has('input.json');
}

const fileAuthoringAutoRetryReasons=['file_authoring_payload_auto_retry','file_authoring_output_limit_auto_retry','file_authoring_timeout_auto_retry'];
function fileAuthoringRetryLimitReached(checkpoint:any,logical:string):boolean {
  const history=Object.values(checkpoint?.operator_reconciliations??{}) as {reason_code?:string;logical_call_id?:string}[];
  const retries=history.filter(h=>fileAuthoringAutoRetryReasons.includes(h.reason_code??'')||h.reason_code==='file_authoring_manual_restart');
  return retries.length>=6||retries.filter(h=>h.logical_call_id===logical).length>=2;
}
function fileAuthoringRetryReason(error:string):string {
  return error==='MODEL_CONTEXT_ROTATION_REQUIRED'?'file_authoring_context_rotation':error==='MODEL_TIMEOUT'?'file_authoring_timeout_auto_retry':
    fileAuthoringOutputLimitErrors.includes(error)?'file_authoring_output_limit_auto_retry':'file_authoring_payload_auto_retry';
}
function fileAuthoringRecoveryEvent(error:string,suffix:string):string {
  return `${error==='MODEL_CONTEXT_ROTATION_REQUIRED'?'file_authoring_context_rotation':error==='MODEL_TIMEOUT'?'file_authoring_timeout':fileAuthoringOutputLimitErrors.includes(error)?'file_authoring_output_limit':'file_authoring_payload'}_${suffix}`;
}
/** Recovery uses immutable evidence. Supplier output exhaustion also requires
 * the exact finish reason in the observation, not just a runtime error code. */
async function fileAuthoringRetryEvidence(client:PoolClient,r:any,j:any,a:any) {
  const outcomes=a.error_code==='MODEL_PROVIDER_PAYLOAD_TOO_LARGE'?['failed']:['pending_reconcile'];
  const finishReason=a.error_code==='MODEL_PROVIDER_OUTPUT_LIMIT'?'max_output_tokens':null;
  return (await client.query(`SELECT
    EXISTS(SELECT 1 FROM bb_input_revisions WHERE owner_user_id=$7 AND project_id=$8 AND revision=$9 AND input_hash=$10) AS input_matches,
    EXISTS(SELECT 1 FROM bb_provider_result_refs WHERE attempt_id=$1) AS has_attempt_result,
    EXISTS(SELECT 1 FROM bb_provider_call_observations WHERE attempt_id=$1 AND error_code=$3 AND usage_status='unknown'
      AND result_id IS NULL AND outcome=ANY($6::text[]) AND ($11::text IS NULL OR finish_reason=$11)) AS supported_observation,
    EXISTS(SELECT 1 FROM bb_provider_call_observations WHERE attempt_id=$1 AND (error_code IS DISTINCT FROM $3 OR usage_status<>'unknown'
      OR result_id IS NOT NULL OR NOT(outcome=ANY($6::text[])) OR ($11::text IS NOT NULL AND finish_reason IS DISTINCT FROM $11))) AS conflicting,
    EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=$2 AND id<>$1
      AND (logical_call_id=$4 AND attempt_no>$5 OR created_at>(SELECT created_at FROM bb_model_call_attempts WHERE id=$1))) AS newer`,
    [a.id,j.id,a.error_code,a.logical_call_id,a.attempt_no,outcomes,r.owner_user_id,r.project_id,r.input_revision,r.input_hash,finishReason])).rows[0];
}
function fileAuthoringJobMatchesInput(r:any,j:any):boolean {
  // Run-backed jobs bind input through run_id; the optional copied fields also
  // serve parse/preflight jobs and are normally null for an authoring enqueue.
  return j.job_type==='update'&&j.owner_user_id===r.owner_user_id&&j.run_id===r.id&&
    (j.project_id==null||j.project_id===r.project_id)&&(j.input_revision==null||j.input_revision===r.input_revision)&&
    (j.input_hash==null||String(j.input_hash).trim()===String(r.input_hash).trim());
}

/** Only an observed, terminated size-limit failure or local timeout in the contained authoring
 * worker authorizes a fresh context. Prior usage remains unknown; the original
 * run/reservation and one shared retry budget survive concurrent sweeps/clicks. */
export async function recoverFileAuthoringPayload(pool:Pool,owner:string,runId:string,jobId:string) {
  return transaction(pool,async client=>{
    const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[runId,owner])).rows[0];
    if(!r || r.task_kind!=='update' || r.state!=='paused' || r.stage!=='provider_reconcile')return false;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND run_id=$2 AND owner_user_id=$3 FOR UPDATE',[jobId,runId,owner])).rows[0];
    if(!j || j.state!=='paused' || j.stage!=='provider_reconcile' || j.lease_token || j.lease_until || j.billing_cancel_requested_at ||
      !fileAuthoringJobMatchesInput(r,j))return false;
    if(!await providerRecoveryAllowed(client,r,j)||await walletIsolated(client,r) || !await billingContractRecoverable(client,r,j))return false;
    const unresolved=await client.query(`SELECT a.*,u.usage_status AS observed_usage,u.conflicting_measurements,t.error_code,t.exit_code,t.exit_signal,t.adapter,t.adapter_version,t.finish_reason
      FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id
      LEFT JOIN bb_call_usage u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
      WHERE a.job_id=$1 AND a.owner_user_id=$2 AND ${needsProviderReconciliation}`,[jobId,owner]);
    if(unresolved.rows.length!==1)return false;
    const a=unresolved.rows[0];
    if(a.status!=='pending_reconcile' || !/^file-authoring-(?:v1|size-repair-[1-9]\d*)$/.test(a.logical_call_id) ||
      a.adapter!=='codex_exec' || a.adapter_version!=='codex-file-authoring-2' ||
      a.observed_usage!=='unknown' || a.conflicting_measurements>0 ||
      !fileAuthoringRecoveryErrors.includes(a.error_code) ||
      !(a.exit_code!==null || /^SIG[A-Z0-9]+$/.test(a.exit_signal??'')))return false;
    const providerOutputLimit=a.error_code==='MODEL_PROVIDER_OUTPUT_LIMIT';
    if(providerOutputLimit&&!isTerminatedProviderOutputLimit(a))return false;
    const evidence=await fileAuthoringRetryEvidence(client,r,j,a);
    if(!evidence.input_matches || r.artifact_id || evidence.has_attempt_result || !evidence.supported_observation || evidence.conflicting || evidence.newer)return false;
    const rotation=a.error_code==='MODEL_CONTEXT_ROTATION_REQUIRED';
    const history=Object.values(j.checkpoint?.operator_reconciliations??{}) as {reason_code?:string}[];
    const exhausted=rotation?history.filter(h=>h.reason_code==='file_authoring_context_rotation').length>=FILE_AUTHORING_CONTEXT_ROTATION_LIMIT:
      fileAuthoringRetryLimitReached(j.checkpoint,a.logical_call_id);
    const saved=j.checkpoint?.stages?.file_authoring_recovery;
    const ready=validFileAuthoringRecovery(saved,{owner,project:r.project_id,run:runId,
      inputHash:String(r.input_hash).trim(),attempt:a.id,logical:a.logical_call_id});
    const capture=fileAuthoringCapture(r,j,a),hasCapture=Object.hasOwn(j.checkpoint?.file_authoring_recovery_captures??{},a.id);
    const noSnapshot=!Object.hasOwn(j.checkpoint?.stages??{},'file_authoring_recovery');
    // A modern call requires both a complete snapshot and an exact saved capture.
    // Failed/incomplete or conflicting capture evidence never authorizes fresh work.
    if(hasCapture&&(!capture||capture.state!=='saved'||!ready))return false;
    // A snapshot deadline is useful only when the intent bound that exact value.
    if(ready&&saved.deadline_at!==capture?.deadline_at)return false;
    const deadlineEvidence=[...Object.values(j.checkpoint?.file_authoring_recovery_captures??{}),
      ...Object.values(j.checkpoint?.operator_reconciliations??{})] as {logical_call_id?:string;deadline_at?:unknown}[];
    if(ready&&deadlineEvidence.some(prior=>prior?.logical_call_id===a.logical_call_id&&Object.hasOwn(prior,'deadline_at')&&
      (!isFileAuthoringDeadline(prior.deadline_at)||prior.deadline_at!==saved.deadline_at)))return false;
    // Supplier output exhaustion and normal rotation require the modern,
    // deadline-bound capture for this exact attempt, never an older snapshot.
    if((rotation||providerOutputLimit)&&(!capture||capture.state!=='saved'||!isFileAuthoringDeadline(saved?.deadline_at)))return false;
    // Only an attempt without the modern protocol marker is historical.
    if(!hasCapture&&['MODEL_OUTPUT_TOO_LARGE','MODEL_TIMEOUT'].includes(a.error_code)&&noSnapshot)return false;
    const operationHash=ready?(saved.files as {path:string;sha256:string}[]).find(file=>file.path==='output/operations.json')?.sha256:undefined;
    const previousAttempt=a.attempt_no>1?(await client.query(`SELECT id FROM bb_model_call_attempts
      WHERE job_id=$1 AND owner_user_id=$2 AND logical_call_id=$3 AND attempt_no=$4`,
      [jobId,owner,a.logical_call_id,a.attempt_no-1])).rows[0]:undefined;
    const prior=previousAttempt?(j.checkpoint?.operator_reconciliations?.[previousAttempt.id] as {operations_sha256?:string}|undefined):undefined;
    // Two timed-out attempts with the same saved operation log have made
    // no substantive Word-edit progress; a third identical attempt is wasteful.
    const stalled=a.error_code==='MODEL_TIMEOUT'&&!!operationHash&&prior?.operations_sha256===operationHash;
    const expired=ready&&isFileAuthoringDeadline(saved.deadline_at)&&Date.parse(saved.deadline_at)<=Date.now();
    const terminal=expired||exhausted||stalled||!ready;
    const reason=expired?'file_authoring_context_deadline_exhausted':exhausted?fileAuthoringRecoveryEvent(a.error_code,rotation?'limit_exhausted':'retries_exhausted'):
      stalled?'file_authoring_no_edit_progress':
      !ready?fileAuthoringRecoveryEvent(a.error_code,'recovery_unavailable'):fileAuthoringRetryReason(a.error_code);
    const recoveryState=terminal?'failed':j.user_pause_requested?'user_paused':j.credit_pause_requested?'credits_exhausted':'queued';
    const audit={actor:'worker_file_authoring_recovery',reason_code:reason,attempt_id:a.id,logical_call_id:a.logical_call_id,
      decision:terminal?'fail_run':'retry_unknown_usage',recovery_state:recoveryState,
      ...(operationHash?{operations_sha256:operationHash}:{}),
      ...(providerOutputLimit?{error_code:'MODEL_PROVIDER_OUTPUT_LIMIT'}:{}),
      ...(ready&&saved.deadline_at!==undefined?{deadline_at:saved.deadline_at}:{})};
    // Unknown usage is an immutable historical fact. A durable disposition permits
    // a later attempt without claiming this multi-turn invocation consumed zero.
    await client.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint-'provider_reconcile_unknown','{operator_reconciliations}',
      COALESCE(checkpoint->'operator_reconciliations','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true),updated_at=now() WHERE id=$1`,
      [jobId,a.id,JSON.stringify(audit)]);
    await client.query("UPDATE bb_model_call_attempts SET status='failed',updated_at=now() WHERE id=$1",[a.id]);
    if(terminal){
      const error=expired?'MODEL_TIMEOUT':a.error_code;
      await client.query("UPDATE bb_jobs SET state='failed',stage='failed',updated_at=now() WHERE id=$1",[jobId]);
      await recordRunFailure(client,r,jobId,error,'provider_reconcile');
      await event(client,r,'failed','failed',reason,error,'run.state_changed',audit);
    }else if(recoveryState!=='queued'){
      // Resolve the supplier blocker without overriding an independent user or
      // credit pause. The normal resume/recharge paths can now reuse the work.
      await client.query("UPDATE bb_jobs SET state='paused',stage=$2,updated_at=now() WHERE id=$1",[jobId,recoveryState]);
      await event(client,r,'paused',recoveryState,recoveryState,recoveryState==='credits_exhausted'?'CREDITS_INSUFFICIENT':undefined,'run.state_changed',audit);
    }else{
      await client.query("UPDATE bb_jobs SET state='queued',stage='queued',updated_at=now() WHERE id=$1",[jobId]);
      await event(client,r,'queued','queued',fileAuthoringRecoveryEvent(a.error_code,'retry_scheduled'),undefined,'run.state_changed',audit);
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
    // A paid assembly repair keeps the exact completed failure release. It may
    // not reinterpret a consumed or partially charged historical reservation.
    if(r.billing_mode==='fixed_credits'){
      const credits=(await client.query(`SELECT state,billing_policy,charged_points FROM bb_credit_reservations
        WHERE id=$1 AND owner_user_id=$2 AND run_id=$3`,[r.reservation_id,r.owner_user_id,r.id])).rows[0];
      if(!credits||credits.state!=='released'||credits.billing_policy!=='on_delivery'||String(credits.charged_points)!=='0')throw refuse();
    }
    const audit={actor:input.actor,policy:'review_assembly_v1',attempt_id:a.id,attempt_no:String(a.attempt_no),logical_call_id:a.logical_call_id,
      result_id:p.id,result_sha256:input.resultSha256,prompt_snapshot_id:prompt.id,prompt_sha256:prompt.content_sha256.trim(),
      input_revision:String(r.input_revision),input_hash:r.input_hash.trim(),failure_event_seq:String(r.event_cursor),failure_error_id:failure.id};
    await client.query(`UPDATE bb_jobs SET state='queued',stage='queued',error_code=NULL,updated_at=now(),
      checkpoint=jsonb_set(checkpoint,'{review_assembly_recovery}',$2::jsonb,true) WHERE id=$1`,[j.id,JSON.stringify({...audit,reuse_only:true})]);
    await event(client,r,'queued','queued','review_assembly_requeued',undefined,'run.state_changed',{...audit,reuse_only:'true'});
    if(r.billing_mode==='fixed_credits'){
      const checked=(await client.query('SELECT bb_review_assembly_recovery_credit_ready(r) ready FROM bb_runs r WHERE r.id=$1',[r.id])).rows[0];
      if(checked?.ready!==true)throw refuse();
    }
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
    if(r.reservation_id){
      const billing=(await client.query('SELECT state FROM bb_credit_reservations WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[r.reservation_id,r.owner_user_id])).rows[0];
      if(!billing||billing.state!=='held')throw new Problem(409,'BILLING_NOT_READY','Finalized paid task requires a separately authorized repair billing contract');
    }
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
    const a=(await client.query('SELECT id,status,logical_call_id FROM bb_model_call_attempts WHERE id=$1 AND owner_user_id=$2 AND job_id=$3 FOR UPDATE',[input.attemptId,r.owner_user_id,j.id])).rows[0];
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
    const capture=fileAuthoringCapture(r,j,{id:a.id,logical_call_id:a.logical_call_id});
    const disposition={decision:input.decision,reason_code:input.reasonCode,actor:input.actor,
      ...(capture?.deadline_at!==undefined?{attempt_id:a.id,logical_call_id:a.logical_call_id,deadline_at:capture.deadline_at}:{})};
    const audit={...disposition,attempt_id:a.id};
    if(input.decision==='retry_unknown_usage'){
      if(a.status==='completed')throw new Problem(409,'CAPABILITY_NOT_READY','Completed result requires provider reconciliation or run termination');
      const evidence=await client.query(`SELECT u.usage_status,
        EXISTS(SELECT 1 FROM bb_provider_result_refs p WHERE p.attempt_id=$1) AS has_result
        FROM bb_call_usage u WHERE u.attempt_id=$1`,[a.id]);
      if(evidence.rows[0]?.has_result || evidence.rows[0]?.usage_status!=='unknown')
        throw new Problem(409,'CAPABILITY_NOT_READY','Existing result or non-unknown usage requires provider reconciliation');
      await client.query("UPDATE bb_model_call_attempts SET status='failed',usage_status='unknown',updated_at=now() WHERE id=$1",[a.id]);
      await client.query(`UPDATE bb_jobs SET state='queued',stage='queued',
        checkpoint=jsonb_set(checkpoint-'provider_reconcile_unknown','{operator_reconciliations}',COALESCE(checkpoint->'operator_reconciliations','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true),updated_at=now() WHERE id=$1`,
        [j.id,a.id,JSON.stringify(disposition)]);
      await event(client,r,'queued','queued','provider_operator_retry_unknown_usage',undefined,'run.state_changed',audit);
    }else{
      await client.query("UPDATE bb_jobs SET state='failed',stage='failed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await recordRunFailure(client,r,j.id,'DATA_UNAVAILABLE','provider_reconcile');
      await client.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',COALESCE(checkpoint->'operator_reconciliations','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true) WHERE id=$1`,
        [j.id,a.id,JSON.stringify(disposition)]);
      await event(client,r,'failed','failed','provider_operator_terminated','DATA_UNAVAILABLE','run.state_changed',audit);
    }
    return {run_id:r.id,attempt_id:a.id,decision:input.decision,idempotent:false};
  });
}

/** Expire only. Managed consumers retain the token until their local completion
 * barrier calls completeManagedRunRelease; expiry is never proof of process death. */
export async function releaseLease(pool:Pool,lease:Lease,reason='lease_released') {
  await transaction(pool,async client=>{
    let locked;
    try { locked=await lockedLease(client,lease); } catch { return; }
    await client.query("UPDATE bb_jobs SET lease_until=now()-interval '1 millisecond',updated_at=now() WHERE id=$1",[lease.jobId]);
    await event(client,locked.r,'running',locked.j.stage,reason,undefined,'run.progress');
  });
}

/** Private worker handoff, never a user/operator timeout-recovery endpoint.
 * Task proof follows pipeline/renewal completion and sealed native containment.
 * Legacy proof still requires whole-consumer quiescence. Restart never acquires
 * another session's release authority. */
export type ManagedRunReleaseProof={nativeProcesses:0;activeExecutions:0}|
 {version:'task_cgroup_v1';nativeProcesses:0;activeExecutions:0;jobId:string;token:string;epoch:string;sessionId:string;cgroupIdentity:string};
export async function completeManagedRunRelease(pool:Pool,lease:Lease,proof:ManagedRunReleaseProof) {
 if(proof.nativeProcesses!==0||proof.activeExecutions!==0)throw Error('EXECUTION_RELEASE_NOT_QUIESCENT');
 const task='version' in proof?proof:undefined;
 const registered=executionNodeForPool(pool);
 if(task&&(task.version!=='task_cgroup_v1'||task.jobId!==lease.jobId||task.token!==lease.token||
   task.epoch!==registered?.identity.epoch||task.sessionId!==registered?.session_id||
   !/^[a-f0-9-]+:[0-9]+:[0-9]+$/.test(task.cgroupIdentity)))throw Error('EXECUTION_RELEASE_SCOPE_MISMATCH');
 return transaction(pool,async client=>{
  const context=await lockExecutionReleaseContext(client,pool,task?lease.jobId:undefined);if(!context)return 'blocked' as const;
  const r=(await client.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[lease.runId,lease.owner])).rows[0];
  const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND run_id=$2 AND owner_user_id=$3 FOR UPDATE',[lease.jobId,lease.runId,lease.owner])).rows[0];
  if(!r||!j||terminal.has(r.state)||j.state!=='running'||j.lease_token!==lease.token)return 'stale' as const;
  if(j.execution_node_id!==context.nodeId||j.execution_node_epoch!==context.epoch||j.execution_session_id!==context.sessionId)throw Error('EXECUTION_RELEASE_OWNER_MISMATCH');
  if(!j.lease_until||new Date(j.lease_until).getTime()>=Date.now())return 'blocked' as const;
  const unknown=await providerCallNeedsReconciliation(client,j.id);
  if(workflowOwned(j)){
    if(!task)throw Error('WORKFLOW_RELEASE_TASK_PROOF_REQUIRED');
    const w=j.checkpoint.workflow_v1?checkedWorkflow(r,j):undefined,disposition=w?.pending_disposition??j.checkpoint.workflow_pending_disposition_v1;
    const usage=await workflowUsage(client,j.id);if(w)w.token_budget={...w.token_budget,...usage};
    const unreconciled=unknown||usage.unknown_calls.length>0;
    let stage='queued',state='queued',reason='worker_retry_released';
    if(await walletIsolated(client,r)){stage='billing_reconcile';state='paused';reason='wallet_isolated';}
    else if(disposition?.kind==='cancel'||j.billing_cancel_requested_at){stage='cancelled';state='cancelled';reason='user_cancelled';}
    else if(unreconciled){stage='provider_reconcile';state='paused';reason='provider_reconciliation_required';}
    else if(disposition?.kind==='fail'){stage='failed';state='failed';reason=disposition.reason;}
    else if(disposition?.kind==='succeeded'&&!j.user_pause_requested&&!j.credit_pause_requested){
      stage=disposition.stage==='test_completed'?'test_completed':'succeeded';state=stage;reason='word_delivered';
      const artifact=(await client.query(`SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND id=$3 AND version=$4
        AND quality_status='passed' AND delivery_status=$5 FOR UPDATE`,[lease.owner,r.id,disposition.artifact_id,disposition.artifact_version,stage==='test_completed'?'test_only':'available'])).rows[0];
      if(!artifact)throw new Problem(409,'DELIVERY_FAILED','Prepared workflow Word artifact changed before release');
    }else if(j.user_pause_requested){stage='user_paused';state='paused';reason='user_paused';}
    else if(j.credit_pause_requested){stage='credits_exhausted';state='paused';reason='credits_exhausted';}
    else if(disposition?.kind==='pause'){stage=disposition.stage;state='paused';reason=disposition.reason;}
    else if(disposition?.kind==='handoff'){reason='workflow_handoff_released';}
    if(w)delete w.pending_disposition;
    const positive={version:'positive-release-v1',job_id:j.id,run_id:r.id,input_hash:String(r.input_hash).trim(),plan_hash:w?.plan_hash??null,lease_token:lease.token,
      execution_node_id:context.nodeId,epoch:context.epoch,session_id:context.sessionId,cgroup_identity:task.cgroupIdentity,handoff_id:w?.handoff_id??null,
      native_processes:0,active_executions:0,event_seq:Number(r.event_cursor)+1,released_at:new Date().toISOString()};
    await client.query(`UPDATE bb_jobs SET state=$2,stage=$3,lease_token=NULL,lease_until=NULL,
      checkpoint=(checkpoint-'workflow_pending_disposition_v1')||CASE WHEN $4::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('workflow_v1',$4::jsonb) END||jsonb_build_object('positive_release_v1',$5::jsonb),updated_at=now() WHERE id=$1 RETURNING checkpoint`,[j.id,state,stage,w?JSON.stringify(w):null,JSON.stringify(positive)]);
    lease.checkpoint={...j.checkpoint,...(w?{workflow_v1:w}:{}),positive_release_v1:positive};delete lease.checkpoint.workflow_pending_disposition_v1;
    if(state==='failed')await recordRunFailure(client,r,j.id,disposition?.error_code,disposition?.stage);
    await event(client,r,state,stage,reason,disposition?.error_code,'run.state_changed',{release_proof:'task_cgroup_v1',native_processes:0,active_executions:0,execution_session_id:context.sessionId,cgroup_identity:task.cgroupIdentity});
    if(state==='succeeded'){
      const artifact=(await client.query('SELECT * FROM bb_artifact_versions WHERE id=$1 AND version=$2',[disposition!.artifact_id,disposition!.artifact_version])).rows[0];
      await registerGeneratedProspectus(client,r,j.checkpoint?.stages?.word_delivery_pair);
      await registerProjectFileOutcome(client,r,artifact,j.checkpoint?.stages?.word_delivery_pair);
    }
    return state as 'queued'|'paused'|'failed'|'succeeded'|'test_completed'|'cancelled';
  }
  const stage=unknown?'provider_reconcile':j.user_pause_requested?'user_paused':j.credit_pause_requested?'credits_exhausted':'queued';
  const state=stage==='queued'?'queued':'paused';
  await client.query('UPDATE bb_jobs SET state=$2,stage=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[j.id,state,stage]);
  await event(client,r,state,stage,unknown?'provider_reconciliation_required':'worker_retry_released',undefined,'run.state_changed',
    {release_proof:task?'task_cgroup_v1':'local_quiescence_v1',native_processes:0,active_executions:0,execution_session_id:context.sessionId,
      ...(task?{cgroup_identity:task.cgroupIdentity}:{})});
  return state;
 });
}

/** Cloud death is a capacity fence, never authority to replay a supplier call.
 * Preserve the existing journal and publish the recovery pause atomically. */
export async function fenceStoppedExecutionEpoch(client:PoolClient,nodeId:string,epoch:string){
 const stopped=(await client.query(`SELECT n.instance_id,n.stop_operation_id,o.provider_request_id,o.proof_sha256 FROM bb_execution_nodes n
  JOIN bb_execution_cloud_operations o ON o.operation_id=n.stop_operation_id AND o.epoch=n.epoch
  WHERE n.id=$1 AND n.epoch=$2 AND o.state='completed' AND o.action IN ('stop','destroy') AND o.cloud_observation IS NOT NULL`,[nodeId,epoch])).rows[0];
 const runs=(await client.query(`SELECT r.* FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id WHERE j.execution_node_id=$1 AND j.execution_node_epoch=$2 AND j.lease_token IS NOT NULL ORDER BY r.id FOR UPDATE OF r`,[nodeId,epoch])).rows;
 for(const r of runs){const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[r.id])).rows[0];
  if(workflowOwned(j)&&!stopped)throw Error('WORKFLOW_CLOUD_FENCE_RECEIPT_REQUIRED');
  const fence=stopped?{version:'cloud-fence-v1',job_id:j.id,node_id:nodeId,epoch,instance_id:stopped.instance_id,operation_id:stopped.stop_operation_id,provider_request_id:stopped.provider_request_id,proof_sha256:stopped.proof_sha256?.trim(),fenced_at:new Date().toISOString()}:null;
  await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,checkpoint=CASE WHEN $2::jsonb IS NULL THEN checkpoint ELSE checkpoint||jsonb_build_object('cloud_fence_v1',$2::jsonb) END,updated_at=now() WHERE id=$1",[j.id,workflowOwned(j)?JSON.stringify(fence):null]);
  await event(client,r,'paused','provider_reconcile','execution_epoch_stopped');
 }
 const messages=(await client.query('SELECT * FROM bb_review_messages WHERE execution_node_id=$1 AND execution_node_epoch=$2 AND lease_token IS NOT NULL ORDER BY id FOR UPDATE',[nodeId,epoch])).rows;
 for(const m of messages){await client.query("UPDATE bb_review_messages SET reply_status='unknown',error='EXECUTION_EPOCH_STOPPED',lease_token=NULL,lease_until=NULL WHERE id=$1",[m.id]);
  await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'review.assistant_replied',$4)",[uid(),m.owner_user_id,m.project_id,{message_id:m.id,status:'unknown',error:'EXECUTION_EPOCH_STOPPED'}]);
 }
}
