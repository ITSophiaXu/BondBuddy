// #79/#16 operator-only platform probe. Claims one platform_probe job (never a user run), saves
// the fixed synthetic prompt as the run's model_request snapshot, runs it through the contained
// Codex adapter with the PostgreSQL durable journal, and finishes the job. Attempt, usage,
// runtime and cost-ledger rows are the normal #79 rows. The trial kill switch, deny override,
// daily token quota and evidence gate are enforced by recordPotentialCall before the intent.
// Env credential mode only: an auth.json configuration is refused.
import type { Pool } from 'pg';
import type { PlatformProbeTemplateId } from '@bondbuddy/contracts';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { claim, finishPlatformProbe, pauseRun, renew, type Lease } from '@bondbuddy/api/queue';
import { CodexAdapterError, loadCodexAdapterConfig, runContainedModelCall, type CodexAdapterConfig } from './codex-adapter.js';
import { CodexDurableJournal } from './durable-probe-journal.js';
import {resolveRunExecution} from '@bondbuddy/api/run-execution';

type Template = { version: string; prompt: string; schema: Record<string, unknown>; validate: (value: unknown) => boolean };
// SYNTHETIC. Contains no user, customer or bond data.
export const PLATFORM_PROBE_TEMPLATES: Record<PlatformProbeTemplateId, Template> = {
  bb_probe_json_echo_v1: {
    version: 'bb_probe_json_echo_v1',
    prompt: [
      'This is a synthetic BondBuddy platform connectivity probe. It contains no user data.',
      'Reply with only a JSON object with exactly two fields: "status" set to "ok" and "probe" set to "bb_probe_json_echo_v1".'
    ].join('\n'),
    schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] }, probe: { type: 'string', enum: ['bb_probe_json_echo_v1'] } }, required: ['status', 'probe'], additionalProperties: false },
    validate: v => typeof v === 'object' && v !== null && Object.keys(v).length === 2 && (v as { status?: unknown }).status === 'ok' && (v as { probe?: unknown }).probe === 'bb_probe_json_echo_v1'
  }
};
export const PLATFORM_PROBE_LOGICAL_CALL_ID = 'platform_probe';

export type PlatformProbeOutcome = 'idle' | 'succeeded' | 'failed' | 'paused' | 'lost';
export type PlatformProbeDependencies = { pool: Pool; blobs: PrivateBlobs; config: CodexAdapterConfig; leaseSeconds?: number };

/** Refuses anything but the env credential mode and a present credential; never reads or prints its value. */
export function assertProbeConfig(config: CodexAdapterConfig, env: NodeJS.ProcessEnv = process.env) {
  if (config.credential.kind === 'auth_file') throw new Error('Platform probe does not accept auth.json');
  if (config.credential.kind === 'env' && !env[config.credential.name]) throw new Error(`Platform probe credential ${config.credential.name} is not set`);
}

const lostLease = (error: unknown) => (error as { code?: string })?.code === 'ALREADY_TERMINAL';
const safeCode = (error: unknown) => {
  const code = error instanceof CodexAdapterError ? error.code : (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'DATA_UNAVAILABLE';
};

async function ensurePromptSnapshot(pool: Pool, blobs: PrivateBlobs, lease: Lease, template: Template) {
  const run=await resolveRunExecution(pool,lease.owner,lease.runId,lease);
  const existing = await pool.query("SELECT id FROM bb_snapshot_refs WHERE owner_user_id=$1 AND run_id=$2 AND snapshot_kind='model_request' ORDER BY created_at,id LIMIT 1", [lease.owner, lease.runId]);
  if (existing.rows[0]) return { projectId: run.project_id as string, promptRef: existing.rows[0].id as string };
  const version = Number((await pool.query("SELECT COALESCE(max(version),0)+1 AS v FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'", [lease.owner, run.project_id])).rows[0].v);
  const promptRef = await savePromptSnapshot(pool, blobs, { owner: lease.owner, projectId: run.project_id, runId: lease.runId, kind: 'model_request', version,
    body: template.prompt, redactionVersion: 'synthetic_probe_v1', inputRevision: run.input_revision, inputHash: String(run.input_hash).trim(),
    templateVersion: template.version });
  return { projectId: run.project_id as string, promptRef };
}

export async function runPlatformProbeOnce(deps: PlatformProbeDependencies): Promise<PlatformProbeOutcome> {
  const leaseSeconds = deps.leaseSeconds ?? Math.max(30, Math.ceil(deps.config.timeout_ms / 1000) + 30);
  const lease = await claim(deps.pool, leaseSeconds, { platformProbe: true });
  if (!lease) return 'idle';
  const heartbeat = setInterval(() => { renew(deps.pool, lease, leaseSeconds).catch(() => undefined); }, Math.max(1000, leaseSeconds * 1000 / 3));
  try {
    const templateId = lease.checkpoint?.template_id as PlatformProbeTemplateId | undefined;
    const template = templateId ? PLATFORM_PROBE_TEMPLATES[templateId] : undefined;
    if (!template) return await finishPlatformProbe(deps.pool, lease, 'failed', { errorCode: 'VALIDATION_FAILED', failedStage: 'probe_template' }).then(() => 'failed' as const);
    const { projectId, promptRef } = await ensurePromptSnapshot(deps.pool, deps.blobs, lease, template);
    const journal = new CodexDurableJournal({ pool: deps.pool, blobs: deps.blobs, lease, validateResult: template.validate });
    const result = await runContainedModelCall({ owner_user_id: lease.owner, project_id: projectId, job_id: lease.jobId, run_id: lease.runId, trace_id: lease.runId,
      logical_call_id: PLATFORM_PROBE_LOGICAL_CALL_ID, prompt_snapshot_ref: promptRef, prompt: template.prompt, result_schema_version: template.version,
      output: { kind: 'json', schema: template.schema, validate: template.validate } }, journal, deps.config);
    if (result.status === 'completed' || result.status === 'reused') { await finishPlatformProbe(deps.pool, lease, 'succeeded'); return 'succeeded'; }
    if (result.status === 'needs_reconcile') { await pauseRun(deps.pool, lease, 'provider_reconcile', 'provider_reconciliation_required'); return 'paused'; }
    await finishPlatformProbe(deps.pool, lease, 'failed', { errorCode: result.error_code ?? 'DATA_UNAVAILABLE', failedStage: 'provider_call' });
    return 'failed';
  } catch (error) {
    if (lostLease(error)) return 'lost';
    // Kill switch, deny override, quota, evidence gate or adapter configuration: no intent was sent.
    try { await finishPlatformProbe(deps.pool, lease, 'failed', { errorCode: safeCode(error), failedStage: 'provider_call' }); return 'failed'; }
    catch (finishError) {
      if (lostLease(finishError)) return 'lost';
      // An unresolved attempt exists: park it for reconciliation instead of guessing.
      if ((finishError as { code?: string })?.code === 'CAPABILITY_NOT_READY') { await pauseRun(deps.pool, lease, 'provider_reconcile', 'provider_reconciliation_required'); return 'paused'; }
      throw finishError;
    }
  } finally { clearInterval(heartbeat); }
}

// Manual one-shot drain for operators; the worker container runs the same probe inside runtime.ts when BB_PLATFORM_PROBE_ENABLED=1.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { Pool: PgPool } = await import('pg');
  const { azureBlobs } = await import('@bondbuddy/api/data');
  if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING are required');
  const config = loadCodexAdapterConfig();
  assertProbeConfig(config);
  const pool = new PgPool({ connectionString: process.env.DATABASE_URL });
  try {
    const outcome = await runPlatformProbeOnce({ pool, blobs: azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING), config });
    process.stdout.write(`${JSON.stringify({ worker: 'platform_probe', outcome })}\n`);
  } finally { await pool.end(); }
}
