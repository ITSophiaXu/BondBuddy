import type { Pool } from 'pg';
import type { Lease } from '@bondbuddy/api/queue';
import { readCheckpointedProviderResult, type PrivateBlobs } from '@bondbuddy/api/provider-results';

// Processor entry point for a logical provider call. A result found in the durable
// checkpoint is hash/schema checked and returned without invoking send. A prior attempt
// without an approved checkpoint throws, so unknown evidence cannot fall through to resend.
export async function reuseProviderCallOrSend<T>(input: {
  pool: Pool;
  blobs: PrivateBlobs;
  lease: Lease;
  logicalCallId: string;
  attemptNo: number;
  validateResult: (value: unknown) => boolean;
  send: () => Promise<T>;
}): Promise<{ reused: boolean; value: T | unknown; resultRef?: string; resultSha256?: string }> {
  const result = await readCheckpointedProviderResult({
    pool: input.pool,
    blobs: input.blobs,
    lease: input.lease,
    logicalCallId: input.logicalCallId,
    attemptNo: input.attemptNo,
    validateResult: input.validateResult,
  });
  if (result)
    return {
      reused: true,
      value: result.value,
      resultRef: result.result_ref,
      resultSha256: result.result_sha256,
    };
  return { reused: false, value: await input.send() };
}
