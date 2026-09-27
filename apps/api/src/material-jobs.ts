import { Pool, type PoolClient } from 'pg';
import {
  ERROR_CODES, MATERIAL_PARSE_JOB_SUBTYPE, MATERIAL_PARSE_JOB_TYPE, MATERIAL_PARSE_OCR_STAGE, MATERIAL_PARSE_STAGES,
  type ERROR_CATEGORIES, type ErrorCode, type MATERIAL_PARSE_EVENT_TYPES, type MATERIAL_PARSE_RUNTIME_EVENT_TYPES, type MaterialParseJob,
} from '@bondbuddy/contracts';
import type { PlatformProcessingCostPayload } from '@bondbuddy/contracts';
import { date, material, missing, Problem, transaction, uid } from './data.js';
import { emitInternal, internalEvent } from './observability.js';

// Must equal python/bondbuddy_document_parser PARSER_VERSION; the worker rejects a snapshot from any other parser.
export const DEFAULT_DOCUMENT_PARSER_VERSION = 'bondbuddy-document-parser-1.0.7';
export const DEFAULT_MATERIAL_PARSE_MAX_ATTEMPTS = 3;
export const documentParserVersion = () => process.env.BB_DOCUMENT_PARSER_VERSION ?? DEFAULT_DOCUMENT_PARSER_VERSION;

type Stage = typeof MATERIAL_PARSE_STAGES[number] | typeof MATERIAL_PARSE_OCR_STAGE;
type EventType = typeof MATERIAL_PARSE_EVENT_TYPES[number] | typeof MATERIAL_PARSE_RUNTIME_EVENT_TYPES[number];
type Category = typeof ERROR_CATEGORIES[number];
export type MaterialParseCheckpoint = { stages?: Partial<Record<Stage, Record<string, unknown>>> };
export type MaterialParseLease = {
  jobId: string; owner: string; projectId: string; materialId: string; materialVersion: number;
  materialSha256: string; parserVersion: string; traceId: string; token: string;
  attempts: number; maxAttempts: number; checkpoint: MaterialParseCheckpoint;
};
export type MaterialParseResult = {
  outcome: 'parsed' | 'needs_confirmation' | 'pending_ocr';
  parse_status: 'parsed' | 'needs_confirmation' | 'failed' | null;
  profile_version: number | null;
  pending_capabilities: 'ocr'[];
};

export type MaterialParseCostStage = 'ocr' | 'parse';
export type MaterialParseCostInput = Omit<PlatformProcessingCostPayload,
  'job_id' | 'material_id' | 'material_version' | 'attempt' | 'stage' | 'billable' | 'cost_payer' | 'pricing_status' | 'unit_price_ref'>;

const finalStates = new Set(['succeeded', 'failed', 'cancelled']);
const safeStage = /^[a-z][a-z0-9_]{0,63}$/;

async function journal(client: PoolClient, job: any, type: EventType, state: string, stage: string | null, extra: Record<string, unknown> = {}) {
  // Domain outbox row for downstream consumers plus the #79 timeline row (which writes its own outbox row).
  await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'material_parse_job',$3,$4,$5)",
    [uid(), job.owner_user_id, job.id, type, { job_id: job.id, project_id: job.project_id, material_id: job.material_id,
      material_version: job.material_version, parser_version: job.parser_version, state, stage, attempts: job.attempts, ...extra }]);
  await emitInternal(client, internalEvent({ kind: 'job.state_changed', owner: job.owner_user_id, projectId: job.project_id, jobId: job.id,
    traceId: job.trace_id, jobKind: 'parse', status: state as any, stage: stage && safeStage.test(stage) ? stage : null }));
  // #17 runtime: ordered per-job event for the resumable stream. Every caller holds the job row lock.
  const payload: Record<string, unknown> = { attempts: job.attempts };
  for (const key of ['reason', 'error_code', 'outcome'] as const) if (typeof extra[key] === 'string') payload[key] = extra[key];
  await client.query(`INSERT INTO bb_job_events(id,owner_user_id,job_id,seq,type,state,stage,payload)
    SELECT $1,$2,$3,COALESCE(max(seq),0)+1,$4,$5,$6,$7 FROM bb_job_events WHERE job_id=$3`, [uid(), job.owner_user_id, job.id, type, state, stage, payload]);
}

async function structuredError(client: PoolClient, job: any, code: ErrorCode, category: Category, stage: string | null, recovery: 'retry_scheduled' | 'terminal') {
  const id = uid();
  await client.query(`INSERT INTO bb_observability_errors(id,owner_user_id,project_id,job_id,trace_id,code,category,stage,retry_count,recovery_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, job.owner_user_id, job.project_id, job.id, job.trace_id, code, category, stage, job.attempts, recovery]);
  await emitInternal(client, internalEvent({ kind: 'error.recorded', owner: job.owner_user_id, projectId: job.project_id, jobId: job.id,
    traceId: job.trace_id, jobKind: 'parse', stage, error: { error_id: id, code, category, retryable: recovery === 'retry_scheduled' } }));
}

/**
 * Called inside the verified upload-completion transaction, after the material row exists.
 * Idempotent per owner + material version + parser version: replays return the existing job.
 */
export async function enqueueMaterialParse(client: PoolClient, input: { owner: string; projectId: string; materialId: string; materialVersion: number; sha256: string; traceId: string; parserVersion?: string; maxAttempts?: number }) {
  const parserVersion = input.parserVersion ?? documentParserVersion();
  const inserted = await client.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,project_id,material_id,material_version,material_sha256,parser_version,trace_id,max_attempts)
    VALUES($1,$2,NULL,$3,$4,'queued','queued',$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (owner_user_id,project_id,material_id,material_version,subtype,parser_version) WHERE job_type='parse' DO NOTHING RETURNING *`,
  [uid(), input.owner, MATERIAL_PARSE_JOB_TYPE, MATERIAL_PARSE_JOB_SUBTYPE, input.projectId, input.materialId, input.materialVersion,
    input.sha256, parserVersion, input.traceId, input.maxAttempts ?? DEFAULT_MATERIAL_PARSE_MAX_ATTEMPTS]);
  if (inserted.rows[0]) {
    await journal(client, inserted.rows[0], 'material_parse.enqueued', 'queued', 'queued');
    return { jobId: inserted.rows[0].id as string, created: true };
  }
  const existing = await client.query(`SELECT id FROM bb_jobs WHERE job_type='parse' AND owner_user_id=$1 AND project_id=$2 AND material_id=$3
    AND material_version=$4 AND subtype=$5 AND parser_version=$6`, [input.owner, input.projectId, input.materialId, input.materialVersion, MATERIAL_PARSE_JOB_SUBTYPE, parserVersion]);
  return { jobId: existing.rows[0].id as string, created: false };
}

function leaseOf(job: any, token: string): MaterialParseLease {
  return { jobId: job.id, owner: job.owner_user_id, projectId: job.project_id, materialId: job.material_id, materialVersion: job.material_version,
    materialSha256: job.material_sha256.trim(), parserVersion: job.parser_version, traceId: job.trace_id, token,
    attempts: job.attempts, maxAttempts: job.max_attempts, checkpoint: job.checkpoint ?? {} };
}

/** Claims one queued parse job or recovers one whose lease expired. Attempts are bounded by max_attempts. */
export async function claimMaterialParse(pool: Pool, leaseSeconds = 30): Promise<MaterialParseLease | null> {
  for (let scanned = 0; scanned < 20; scanned++) {
    const outcome = await transaction(pool, async client => {
      const q = await client.query(`SELECT * FROM bb_jobs WHERE job_type='parse' AND (state='queued' OR (state='running' AND lease_until<now()))
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
      const job = q.rows[0];
      if (!job) return { done: true as const, lease: null };
      const recovered = job.state === 'running';
      if (job.attempts >= job.max_attempts) {
        // The final attempt lost its lease (crash or stall); do not start another.
        await client.query("UPDATE bb_jobs SET state='failed',error_code='DATA_UNAVAILABLE',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [job.id]);
        await structuredError(client, job, 'DATA_UNAVAILABLE', 'queue', job.stage, 'terminal');
        await journal(client, job, 'material_parse.failed', 'failed', job.stage, { error_code: 'DATA_UNAVAILABLE', reason: 'attempts_exhausted' });
        return { done: false as const, lease: null };
      }
      const token = uid();
      const updated = await client.query(`UPDATE bb_jobs SET state='running',stage=CASE WHEN stage='queued' THEN 'claimed' ELSE stage END,lease_token=$2,
        lease_until=now()+($3::integer * interval '1 second'),attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`, [job.id, token, leaseSeconds]);
      await journal(client, updated.rows[0], 'material_parse.claimed', 'running', updated.rows[0].stage, { reason: recovered ? 'lease_recovered' : 'claimed' });
      return { done: true as const, lease: leaseOf(updated.rows[0], token) };
    });
    if (outcome.done) return outcome.lease;
  }
  return null;
}

async function lockedLease(client: PoolClient, lease: MaterialParseLease) {
  const q = await client.query("SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND job_type='parse' FOR UPDATE", [lease.jobId, lease.owner]);
  const job = q.rows[0];
  if (!job || job.lease_token !== lease.token || job.state !== 'running' || new Date(job.lease_until).getTime() <= Date.now())
    throw new Problem(409, 'ALREADY_TERMINAL', 'Lease is no longer active');
  return job;
}

export async function renewMaterialParse(pool: Pool, lease: MaterialParseLease, leaseSeconds = 30) {
  await transaction(pool, async client => {
    await lockedLease(client, lease);
    await client.query("UPDATE bb_jobs SET lease_until=now()+($2::integer * interval '1 second'),updated_at=now() WHERE id=$1", [lease.jobId, leaseSeconds]);
  });
}

/** Persists a completed stage. A later attempt reads it from the checkpoint instead of redoing the stage. */
export async function completeMaterialParseStage(pool: Pool, lease: MaterialParseLease, stage: Stage, value: Record<string, unknown>) {
  await transaction(pool, async client => {
    const job = await lockedLease(client, lease);
    const updated = await client.query(`UPDATE bb_jobs SET stage=$2,updated_at=now(),
      checkpoint=checkpoint || jsonb_build_object('stages', COALESCE(checkpoint->'stages','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb))
      WHERE id=$1 RETURNING *`, [job.id, stage, JSON.stringify(value)]);
    lease.checkpoint = updated.rows[0].checkpoint;
    await journal(client, updated.rows[0], 'material_parse.stage_completed', 'running', stage);
  });
}

/**
 * Persists one measured source-preflight OCR/parse attempt with its job checkpoint
 * and #79 outbox event atomically. The job row lock plus the stable attempt key
 * makes a repeated report idempotent without creating an accounting ledger.
 */
export async function recordMaterialParseProcessingCost(pool: Pool, lease: MaterialParseLease, stage: MaterialParseCostStage, input: MaterialParseCostInput) {
  if (!Number.isSafeInteger(input.processing_ms) || input.processing_ms < 1 ||
      !(input.quantity === null || (Number.isSafeInteger(input.quantity) && input.quantity >= 0)) ||
      (stage === 'ocr' && input.unit !== 'ocr_page') || (stage === 'parse' && (input.unit !== 'document' || input.quantity !== 1)) ||
      (stage === 'parse' && (input.ocr_pages !== undefined || input.ocr_engine !== undefined || input.ocr_engine_version !== undefined))) {
    throw new Error('INVALID_PROCESSING_COST');
  }
  return transaction(pool, async client => {
    const job = await lockedLease(client, lease);
    const payload: PlatformProcessingCostPayload = {
      job_id: job.id, material_id: job.material_id, material_version: job.material_version,
      stage, attempt: lease.attempts, unit: input.unit, quantity: input.quantity,
      processing_ms: input.processing_ms, billable: false, cost_payer: 'platform',
      pricing_status: 'unknown', unit_price_ref: null, outcome: input.outcome,
      ...(stage === 'ocr' ? { ocr_pages: input.ocr_pages ?? input.quantity, ocr_engine: input.ocr_engine ?? null, ocr_engine_version: input.ocr_engine_version ?? null } : {}),
    };
    const prior = await client.query(`SELECT payload FROM bb_outbox WHERE aggregate_type='material_parse_job'
      AND aggregate_id=$1 AND event_type='platform.processing_cost'
      AND payload->>'job_id'=$1 AND payload->>'stage'=$2 AND (payload->>'attempt')::integer=$3 LIMIT 1`,
    [job.id, stage, lease.attempts]);
    if (prior.rows[0]) return prior.rows[0].payload as PlatformProcessingCostPayload;

    const checkpoint = { ...(job.checkpoint ?? {}) };
    const costs = { ...((checkpoint.processing_costs as Record<string, unknown> | undefined) ?? {}) };
    const key = `${stage}:${lease.attempts}`;
    costs[key] = payload;
    checkpoint.processing_costs = costs;
    await client.query('UPDATE bb_jobs SET checkpoint=$2,updated_at=now() WHERE id=$1', [job.id, checkpoint]);
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'material_parse_job',$3,'platform.processing_cost',$4)`, [uid(), job.owner_user_id, job.id, payload]);
    return payload;
  });
}

/** Result depends on an unconnected capability (OCR): keep the checkpoint and wait, never report success. */
export async function pauseMaterialParse(pool: Pool, lease: MaterialParseLease, stage: 'awaiting_ocr', result: MaterialParseResult, reason: 'ocr_not_connected' | 'ocr_unavailable' = 'ocr_not_connected') {
  await transaction(pool, async client => {
    const job = await lockedLease(client, lease);
    const updated = await client.query("UPDATE bb_jobs SET state='paused',stage=$2,result=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id, stage, result]);
    await journal(client, updated.rows[0], 'material_parse.paused', 'paused', stage, { reason });
  });
}

export async function succeedMaterialParse(pool: Pool, lease: MaterialParseLease, result: MaterialParseResult) {
  await transaction(pool, async client => {
    const job = await lockedLease(client, lease);
    const updated = await client.query("UPDATE bb_jobs SET state='succeeded',stage='succeeded',result=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id, result]);
    await journal(client, updated.rows[0], 'material_parse.succeeded', 'succeeded', 'succeeded', { outcome: result.outcome });
  });
}

/** Retryable failures requeue until max_attempts; everything else is terminal with a structured error_code. */
export async function failMaterialParse(pool: Pool, lease: MaterialParseLease, failure: { code: ErrorCode; retryable: boolean; category: Category }) {
  if (!ERROR_CODES.includes(failure.code)) throw new Error('Invalid error code');
  return transaction(pool, async client => {
    const job = await lockedLease(client, lease);
    if (failure.retryable && job.attempts < job.max_attempts) {
      const updated = await client.query("UPDATE bb_jobs SET state='queued',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id]);
      await structuredError(client, updated.rows[0], failure.code, failure.category, job.stage, 'retry_scheduled');
      await journal(client, updated.rows[0], 'material_parse.retry_scheduled', 'queued', job.stage, { error_code: failure.code });
      return 'retry_scheduled' as const;
    }
    const updated = await client.query("UPDATE bb_jobs SET state='failed',error_code=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id, failure.code]);
    await structuredError(client, updated.rows[0], failure.code, failure.category, job.stage, 'terminal');
    await journal(client, updated.rows[0], 'material_parse.failed', 'failed', job.stage, { error_code: failure.code });
    return 'failed' as const;
  });
}

export function materialParseJobDto(job: any): MaterialParseJob {
  const stages = Object.keys(job.checkpoint?.stages ?? {}).filter((s): s is Stage => (MATERIAL_PARSE_STAGES as readonly string[]).includes(s));
  const result = job.result as MaterialParseResult | null;
  return { job_id: job.id, job_type: MATERIAL_PARSE_JOB_TYPE, subtype: MATERIAL_PARSE_JOB_SUBTYPE, project_id: job.project_id, material_id: job.material_id,
    material_version: job.material_version, material_sha256: job.material_sha256.trim(), parser_version: job.parser_version, state: job.state, stage: job.stage,
    completed_stages: MATERIAL_PARSE_STAGES.filter(s => stages.includes(s)), attempts: job.attempts, max_attempts: job.max_attempts,
    error_code: job.error_code ?? null, outcome: result?.outcome ?? null, parse_status: result?.parse_status ?? null,
    profile_version: result?.profile_version ?? null, pending_capabilities: result?.pending_capabilities ?? [], updated_at: date(job.updated_at) };
}

async function currentJob(client: Pool | PoolClient, owner: string, projectId: string, materialId: string, lock = false) {
  const m = await material(client, owner, projectId, materialId);
  const q = await client.query(`SELECT * FROM bb_jobs WHERE job_type='parse' AND owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
    AND subtype=$5 AND parser_version=$6 ${lock ? 'FOR UPDATE' : ''}`, [owner, projectId, materialId, m.version, MATERIAL_PARSE_JOB_SUBTYPE, documentParserVersion()]);
  if (!q.rows[0]) throw missing();
  return { material: m, job: q.rows[0] };
}

/** Owner-scoped read of the current material version's parse job; foreign and unknown IDs share 404. */
export async function readMaterialParseJob(pool: Pool, owner: string, projectId: string, materialId: string) {
  return (await currentJob(pool, owner, projectId, materialId)).job;
}

/** Cancel and worker completion both take the job row lock; the loser observes a final state. */
export async function cancelMaterialParse(client: PoolClient, owner: string, projectId: string, materialId: string) {
  const { job } = await currentJob(client, owner, projectId, materialId, true);
  if (finalStates.has(job.state)) throw new Problem(409, 'ALREADY_TERMINAL', 'Parse job already finished');
  const updated = await client.query("UPDATE bb_jobs SET state='cancelled',stage='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id]);
  await journal(client, updated.rows[0], 'material_parse.cancelled', 'cancelled', 'cancelled', { reason: 'user_cancelled' });
  return updated.rows[0];
}

// ---------------------------------------------------------------- #17 worker runtime

/** Graceful shutdown: expire our lease now so another worker resumes from the checkpoint immediately. */
export async function releaseMaterialParse(pool: Pool, lease: MaterialParseLease) {
  await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 millisecond',updated_at=now() WHERE id=$1 AND job_type='parse' AND state='running' AND lease_token=$2", [lease.jobId, lease.token]);
}

/**
 * Re-queues paused `awaiting_ocr` parse jobs once a server-side OCR processor is configured.
 * The completed stages stay in the checkpoint; only the OCR stage runs on the next claim.
 */
export async function requeueAwaitingOcrParseJobs(pool: Pool, options: { limit?: number; minPausedSeconds?: number } = {}) {
  const limit = options.limit ?? 20, minPaused = options.minPausedSeconds ?? 0;
  return transaction(pool, async client => {
    // minPausedSeconds backs off jobs that just paused again (e.g. OCR engine still unavailable).
    const q = await client.query(`SELECT * FROM bb_jobs WHERE job_type='parse' AND state='paused' AND stage='awaiting_ocr'
      AND updated_at <= now()-($2::integer * interval '1 second') ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit, minPaused]);
    for (const job of q.rows) {
      // A pause is not a failure: the claim that ended in the pause does not count against max_attempts.
      const updated = await client.query("UPDATE bb_jobs SET state='queued',attempts=GREATEST(attempts-1,0),updated_at=now() WHERE id=$1 RETURNING *", [job.id]);
      await journal(client, updated.rows[0], 'material_parse.resumed', 'queued', 'awaiting_ocr', { reason: 'ocr_available' });
    }
    return q.rows.length;
  });
}

/** Owner-scoped ordered events of one parse job after a cursor (the SSE source). */
export async function readMaterialParseJobEvents(pool: Pool, owner: string, jobId: string, after: number, limit = 100) {
  const q = await pool.query(`SELECT id,job_id,seq,type,state,stage,payload,occurred_at FROM bb_job_events
    WHERE owner_user_id=$1 AND job_id=$2 AND seq>$3 ORDER BY seq LIMIT $4`, [owner, jobId, after, limit]);
  return q.rows.map(e => ({ event_id: e.id as string, schema_version: 1 as const, job_id: e.job_id as string, job_type: 'parse' as const, seq: Number(e.seq),
    occurred_at: date(e.occurred_at), type: e.type as string, state: e.state as string, stage: e.stage as string | null, payload: e.payload as Record<string, unknown> }));
}

export { currentJob as currentMaterialParseJob };
