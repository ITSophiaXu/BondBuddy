import { modelCallBudgetFor } from './model-call-budget.js';
import type { Pool } from 'pg';
import { recordPotentialCall, type Lease } from '@bondbuddy/api/queue';
import { latestProviderAttempt, persistProviderResultObject, readCheckpointedProviderResult, recordModelAttemptRuntime, recordProviderCallObservation, type ModelAttemptRuntime, type ProviderCallIntent, type ProviderCallObservation, type ProviderResultReference, type ProviderResultValidator } from '@bondbuddy/api/provider-results';
import type { PrivateBlobs } from '@bondbuddy/api/provider-results';
import { recordCodexExecLog } from '@bondbuddy/api/exec-logs';
import type { ProbeJournal } from './deepseek-probe.js';
import type { CodexJournal, PriorAttempt } from './codex-adapter.js';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { Problem, transaction, run as getRun } from '@bondbuddy/api/data';
import { guardEvidenceWrite } from '@bondbuddy/api/evidence-gate';

// This is an internal worker seam. It never accepts a browser principal and is not
// installed by the production worker entry point until the live release gates pass.
export class DurableProbeJournal implements ProbeJournal {
  constructor(private readonly input: {
    pool: Pool;
    blobs: PrivateBlobs;
    lease: Lease;
    validateResult: ProviderResultValidator;
  }) {}

  private assertLeaseIdentity(intent: ProviderCallIntent) {
    const {lease}=this.input;
    if (intent.owner_user_id!==lease.owner || intent.job_id!==lease.jobId || intent.run_id!==lease.runId || intent.trace_id!==lease.runId) throw new Error('PROVIDER_ATTEMPT_SCOPE_MISMATCH');
  }

  async recordIntent(intent: ProviderCallIntent): Promise<void> {
    this.assertLeaseIdentity(intent);
    const attemptId=await recordPotentialCall(this.input.pool,this.input.lease,intent.logical_call_id,intent.attempt_no,{callId:intent.call_id,modelId:intent.model_id,promptSnapshotId:intent.prompt_snapshot_ref});
    if (attemptId!==intent.call_id) throw new Error('PROVIDER_ATTEMPT_ID_MISMATCH');
  }

  async storeResult(intent: ProviderCallIntent, bytes: Buffer, schemaVersion: string): Promise<ProviderResultReference> {
    this.assertLeaseIdentity(intent);
    try {
      return await persistProviderResultObject({blobs:this.input.blobs,intent,bytes,resultSchemaVersion:schemaVersion,validate:this.input.validateResult});
    } catch {
      // Keep raw provider output and internal storage errors out of errors/logs.
      throw new Error('RESULT_STORE_FAILED');
    }
  }

  async recordObservation(observation: ProviderCallObservation, options: {retryable?: boolean} = {}): Promise<void> {
    this.assertLeaseIdentity(observation);
    await recordProviderCallObservation(this.input.pool,this.input.blobs,observation,this.input.validateResult,{lease:this.input.lease,source:'provider',retryable:options.retryable===true});
  }
}

// #16 Codex adapter journal: adds #79 runtime rows and restart lookups to the probe journal.
export class CodexDurableJournal extends DurableProbeJournal implements CodexJournal {
  constructor(private readonly codexInput: ConstructorParameters<typeof DurableProbeJournal>[0]) { super(codexInput); }

  acquireCallSlot(signal?: AbortSignal) { return modelCallBudgetFor(this.codexInput.pool).acquire(signal, `run:${this.codexInput.lease.runId}`); }

  async recordWebSearchEvents(intent: ProviderCallIntent, events: NonNullable<import('./codex-adapter.js').CodexProcessResult['web_search_events']>) {
    const { pool, lease } = this.codexInput;
    if (intent.owner_user_id !== lease.owner || intent.job_id !== lease.jobId || intent.run_id !== lease.runId) throw new Error('PROVIDER_ATTEMPT_SCOPE_MISMATCH');
    await guardEvidenceWrite(pool,'web_search_evidence_not_persisted',()=>transaction(pool,async client=>{
      // The evidence INSERT has a run foreign key. Take its run lock before the
      // job/attempt locks, matching renewal, cancellation and runtime evidence.
      const run=await getRun(client,lease.owner,lease.runId,true);
      if(run.project_id!==intent.project_id || ['failed','cancelled','rejected','succeeded','test_completed'].includes(run.state))
        throw new Problem(409,'CAPABILITY_NOT_READY','Web search evidence lease or attempt is no longer valid');
      const active=await client.query(`SELECT 1 FROM bb_jobs j JOIN bb_model_call_attempts a ON a.job_id=j.id AND a.owner_user_id=j.owner_user_id
        JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
        WHERE j.id=$1 AND j.owner_user_id=$2 AND j.run_id=$3 AND r.project_id=$4 AND j.lease_token=$5
        AND j.state='running' AND j.lease_until>now() AND r.state NOT IN ('failed','cancelled','rejected','succeeded','test_completed')
        AND a.id=$6 AND a.logical_call_id=$7 AND a.attempt_no=$8 FOR UPDATE OF j,a`,
      [intent.job_id,intent.owner_user_id,intent.run_id,intent.project_id,lease.token,intent.call_id,intent.logical_call_id,intent.attempt_no]);
      if(!active.rowCount)throw new Problem(409,'CAPABILITY_NOT_READY','Web search evidence lease or attempt is no longer valid');
      const hash=inputManifestHash(events);
      await client.query(`INSERT INTO bb_model_web_search_evidence(call_id,owner_user_id,project_id,run_id,job_id,logical_call_id,content_sha256,events)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(call_id) DO NOTHING`,
      [intent.call_id,intent.owner_user_id,intent.project_id,intent.run_id,intent.job_id,intent.logical_call_id,hash,JSON.stringify(events)]);
      const saved=(await client.query('SELECT content_sha256 FROM bb_model_web_search_evidence WHERE call_id=$1',[intent.call_id])).rows[0];
      if(saved?.content_sha256.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Web search evidence cannot be replaced');
    }));
  }

  async recordRuntime(intent: ProviderCallIntent, runtime: ModelAttemptRuntime): Promise<void> {
    await recordModelAttemptRuntime(this.codexInput.pool,this.codexInput.lease,intent,runtime);
  }

  async storeExecLog(intent: ProviderCallIntent, bytes: Buffer, meta: { truncated: boolean }): Promise<void> {
    await recordCodexExecLog(this.codexInput.pool,this.codexInput.blobs,this.codexInput.lease,intent,bytes,meta);
  }

  async latestAttempt(logicalCallId: string): Promise<PriorAttempt | null> {
    const row=await latestProviderAttempt(this.codexInput.pool,this.codexInput.lease,logicalCallId);
    return row?{call_id:row.call_id,attempt_no:row.attempt_no,status:row.status,observed:row.observed,operator_retry:row.operator_retry}:null;
  }

  async readCompleted(logicalCallId: string, attemptNo: number) {
    try {
      const result=await readCheckpointedProviderResult({pool:this.codexInput.pool,blobs:this.codexInput.blobs,lease:this.codexInput.lease,logicalCallId,attemptNo,validateResult:this.codexInput.validateResult});
      return result?{value:result.value,result_sha256:result.result_sha256}:null;
    } catch { return null; }
  }
}
