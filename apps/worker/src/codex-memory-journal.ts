// Non-durable CodexJournal for the operator probe CLI and unit tests. It keeps the same
// ordering rules as the durable journal but persists nothing; never use it for real runs.
import { createHash } from 'node:crypto';
import type { ModelAttemptRuntime, ProviderCallIntent, ProviderCallObservation } from '@bondbuddy/api/provider-results';
import type { CodexJournal, PriorAttempt } from './codex-adapter.js';

export class MemoryCodexJournal implements CodexJournal {
  readonly events: string[] = [];
  readonly intents: ProviderCallIntent[] = [];
  readonly observations: { observation: ProviderCallObservation; retryable: boolean }[] = [];
  readonly runtimes: ModelAttemptRuntime[] = [];
  readonly results = new Map<string, Buffer>();
  readonly execLogs = new Map<string, { bytes: Buffer; truncated: boolean }>();
  prior: PriorAttempt | null = null;

  async recordIntent(intent: ProviderCallIntent) { this.events.push(`intent:${intent.attempt_no}`); this.intents.push(intent); }
  async storeExecLog(intent: ProviderCallIntent, bytes: Buffer, meta: { truncated: boolean }) {
    this.execLogs.set(intent.call_id, { bytes: Buffer.from(bytes), truncated: meta.truncated });
    this.events.push(`exec_log:${intent.attempt_no}`);
  }
  async storeResult(intent: ProviderCallIntent, bytes: Buffer, schemaVersion: string) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    this.results.set(intent.call_id, bytes);
    this.events.push(`result:${intent.attempt_no}`);
    return { result_ref: `users/${intent.owner_user_id}/projects/${intent.project_id}/provider-results/${intent.call_id}-${sha}.json`, result_sha256: sha, result_schema_version: schemaVersion, result_byte_size: bytes.length };
  }
  async recordObservation(observation: ProviderCallObservation, options: { retryable?: boolean } = {}) { this.events.push(`observation:${observation.attempt_no}`); this.observations.push({ observation, retryable: options.retryable === true }); }
  async recordRuntime(intent: ProviderCallIntent, runtime: ModelAttemptRuntime) { this.events.push(`runtime:${intent.attempt_no}`); this.runtimes.push(runtime); }
  async latestAttempt() { return this.prior; }
  async readCompleted(_logicalCallId: string, _attemptNo: number): Promise<{ value: unknown; result_sha256: string } | null> { return null; }
}
