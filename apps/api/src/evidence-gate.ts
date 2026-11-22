import type { Pool, PoolClient } from 'pg';
import { Problem, transaction, uid } from './data.js';

// #79: if execution evidence cannot be persisted, NEW external model calls stop until an
// operator appends a resume. The DB gate covers every process; the in-process flag covers
// the case where even the pause itself could not be written.
let unpersistedPause: string | null = null;
const infraClasses = ['08', '53', '54', '57', '58', 'XX'];

/** True for connection/resource/crash failures; constraint and validation errors are not evidence outages. */
export function isEvidencePersistenceFailure(error: unknown) {
  if (error instanceof Problem) return false;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return infraClasses.includes(code.slice(0, 2));
  return true;
}

export async function raiseAlert(db: Pool | PoolClient, input: { kind: string; severity: 'warning' | 'critical'; scope: string; detail: Record<string, string | number>; bucketSeconds?: number }) {
  const bucket = Math.floor(Date.now() / 1000 / (input.bucketSeconds ?? 3600));
  const dedupe = `${input.kind}:${input.scope}:${bucket}`;
  const q = await db.query('INSERT INTO bb_ops_alerts(id,kind,severity,dedupe_key,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id', [uid(), input.kind, input.severity, dedupe, input.detail]);
  if (q.rows[0]) return q.rows[0].id as string;
  return (await db.query('SELECT id FROM bb_ops_alerts WHERE dedupe_key=$1', [dedupe])).rows[0]?.id as string;
}

export async function gateState(db: Pool | PoolClient) {
  const q = await db.query('SELECT state,reason_code,created_at FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1');
  return { state: (q.rows[0]?.state ?? 'open') as 'open' | 'paused', reason_code: (q.rows[0]?.reason_code ?? null) as string | null, changed_at: q.rows[0] ? new Date(q.rows[0].created_at).toISOString() : null, process_state: (unpersistedPause ? 'paused' : 'open') as 'open' | 'paused' };
}

async function persistPause(pool: Pool, reason: string) {
  await transaction(pool, async client => {
    await client.query('LOCK TABLE bb_evidence_gate_events IN SHARE ROW EXCLUSIVE MODE');
    const alert = await raiseAlert(client, { kind: 'evidence_persist_failed', severity: 'critical', scope: 'model_calls', detail: { reason_code: reason } });
    if ((await gateState(client)).state !== 'paused')
      await client.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type,alert_id) VALUES($1,'paused',$2,'system',$3)", [uid(), reason, alert]);
  });
}

/** Record an evidence outage. Never throws: the caller re-throws its own error. */
export async function tripEvidenceGate(pool: Pool, reason: string) {
  unpersistedPause = reason;
  try { await persistPause(pool, reason); unpersistedPause = null; } catch { /* keep the in-process pause */ }
}

const pausedProblem = () => new Problem(503, 'DATA_UNAVAILABLE', 'External model calls are paused until execution evidence can be persisted');

/** Call before recording a new external call intent (outside its transaction). */
export async function ensureExternalCallsAllowed(pool: Pool) {
  if (unpersistedPause) {
    try { await persistPause(pool, unpersistedPause); unpersistedPause = null; } catch { /* still unreachable */ }
    throw pausedProblem();
  }
}
/** Call inside the intent transaction so a concurrent pause is observed. */
export async function assertGateOpen(client: PoolClient) {
  await client.query('LOCK TABLE bb_evidence_gate_events IN SHARE MODE');
  if ((await gateState(client)).state === 'paused') throw pausedProblem();
}

/** Run an evidence write; an infrastructure failure pauses new external calls and raises an alert. */
export async function guardEvidenceWrite<T>(pool: Pool, reason: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) { if (isEvidencePersistenceFailure(error)) await tripEvidenceGate(pool, reason); throw error; }
}

export async function resumeEvidenceGate(pool: Pool, actorId: string, reason: string) {
  return transaction(pool, async client => {
    await client.query('LOCK TABLE bb_evidence_gate_events IN SHARE ROW EXCLUSIVE MODE');
    if ((await gateState(client)).state !== 'paused') throw new Problem(409, 'ALREADY_TERMINAL', 'Evidence gate is already open');
    await client.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type,actor_id) VALUES($1,'open',$2,'operator',$3)", [uid(), reason, actorId]);
    unpersistedPause = null;
    return gateState(client);
  });
}
/** Test hook only. */
export function resetProcessGateForTests() { unpersistedPause = null; }
