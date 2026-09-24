import type { Pool } from 'pg';
import { recordPotentialCall, type Lease } from '@bondbuddy/api/queue';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent, type ProviderCallObservation, type ProviderResultReference } from '@bondbuddy/api/provider-results';
import type { PrivateBlobs } from '@bondbuddy/api/provider-results';
import type { ProbeJournal } from './deepseek-probe.js';

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

  async recordObservation(observation: ProviderCallObservation): Promise<void> {
    this.assertLeaseIdentity(observation);
    await recordProviderCallObservation(this.input.pool,this.input.blobs,observation,this.input.validateResult,{lease:this.input.lease,source:'provider'});
  }
}
