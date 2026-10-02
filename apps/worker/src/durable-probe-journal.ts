import type { Pool } from 'pg';
import { recordPotentialCall, type Lease } from '@bondbuddy/api/queue';
import { latestProviderAttempt, persistProviderResultObject, readCheckpointedProviderResult, recordModelAttemptRuntime, recordProviderCallObservation, type ModelAttemptRuntime, type ProviderCallIntent, type ProviderCallObservation, type ProviderResultReference } from '@bondbuddy/api/provider-results';
import type { PrivateBlobs } from '@bondbuddy/api/provider-results';
import type { ProbeJournal } from './deepseek-probe.js';
import type { CodexJournal, PriorAttempt } from './codex-adapter.js';

// This is an internal worker seam. It never accepts a browser principal and is not
// installed by the production worker entry point until the live release gates pass.
export class DurableProbeJournal implements ProbeJournal {
  constructor(private readonly input: {
    pool: Pool;
    blobs: PrivateBlobs;
    lease: Lease;
    validateResult: (value: unknown) => boolean;
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

  async recordRuntime(intent: ProviderCallIntent, runtime: ModelAttemptRuntime): Promise<void> {
    await recordModelAttemptRuntime(this.codexInput.pool,this.codexInput.lease,intent,runtime);
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
