import type { Pool, PoolClient } from 'pg';
import { Problem, digest, transaction, uid } from './data.js';
import {auditCreditClient} from './billing-audit.js';
import {lockWalletSafetyForControl} from './billing-safety.js';

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
    await client.query('SELECT public.bb_lock_evidence_gate(true)');
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
  await client.query('SELECT public.bb_lock_evidence_gate(false)');
  if ((await gateState(client)).state === 'paused') throw pausedProblem();
}

/** Run an evidence write; an infrastructure failure pauses new external calls and raises an alert. */
export async function guardEvidenceWrite<T>(pool: Pool, reason: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) { if (isEvidencePersistenceFailure(error)) await tripEvidenceGate(pool, reason); throw error; }
}

export async function resumeEvidenceGate(pool: Pool, actorId: string, reason: string) {
  return transaction(pool, async client => {
    await client.query('SELECT public.bb_lock_evidence_gate(true)');
    const state=await gateState(client);
    if (state.reason_code==='database_restore_quarantine')
      throw new Problem(409,'RESTORE_QUARANTINE_REQUIRES_RECONCILIATION','Database restoration requires verified call, fence and billing reconciliation');
    if (state.state !== 'paused') throw new Problem(409, 'ALREADY_TERMINAL', 'Evidence gate is already open');
    await client.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type,actor_id) VALUES($1,'open',$2,'operator',$3)", [uid(), reason, actorId]);
    unpersistedPause = null;
    return gateState(client);
  });
}

export function restoreCanonical(value:unknown):string {
  return JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)
    ?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
}
/** Exact ledger snapshot, distinct from a self-reported billing-consistent flag. */
export async function restoreBillingSnapshot(db:Pool|PoolClient,owner:string){
  const result:Record<string,unknown[]>={};
  // Cover the authoritative schema's owner-bound ledger, cash and subscription rights, including
  // annual releases/refund allocations added after the original wallet implementation.
  const tables=(await db.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public'
    AND column_name='owner_user_id' AND (table_name LIKE 'bb_credit_%' OR table_name='bb_recharge_orders'
      OR table_name LIKE 'bb_payment_%' OR table_name LIKE 'bb_subscription%'
      OR table_name IN ('bb_authoring_progress','bb_run_model_activity')) ORDER BY table_name`)).rows.map(row=>String(row.table_name));
  for(const table of tables){
    if(!/^bb_[a-z_]+$/.test(table))throw new Problem(409,'RESTORE_BILLING_RECONCILIATION_REQUIRED','Unrecognized restore billing table');
    result[table]=(await db.query(`SELECT to_jsonb(t) AS record FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`,[owner])).rows.map(row=>row.record);
  }
  result.bb_credit_allocations=(await db.query(`SELECT to_jsonb(t) record FROM bb_credit_allocations t
    JOIN bb_credit_reservations r ON r.id=t.reservation_id WHERE r.owner_user_id=$1 ORDER BY t.reservation_id,t.lot_id`,[owner])).rows.map(row=>row.record);
  return result;
}
type RestoreCall={attempt_id:string;owner_user_id:string;job_id:string;run_id:string;logical_call_id:string;status:string;result_ref?:string;result_sha256?:string};
type RestoreReceipt={account_ids:string[];calls:RestoreCall[];audit:{complete:boolean};billing:{owner_user_id:string;sha256:string;consistent:boolean}[];never_sent_runs:string[];fences:Record<string,unknown>[]};
/** A trusted private-object reader. All network reads finish before the short CAS transaction. */
export async function resumeDatabaseRestoreGate(pool:Pool,actorId:string,input:{quarantine_id:string;manifest_sha256:string;owner_user_ids:string[]},readObject:(ref:string)=>Promise<Buffer>){
  const fail=(code='RESTORE_RECONCILIATION_REQUIRED'):never=>{throw new Problem(409,code,'Restore evidence is incomplete or changed; model calls remain isolated');};
  if(!actorId||!/^[a-f0-9]{64}$/.test(input.manifest_sha256)||!input.owner_user_ids.length||input.owner_user_ids.length>16
    ||new Set(input.owner_user_ids).size!==input.owner_user_ids.length)fail();
  const pre=(await pool.query('SELECT * FROM bb_database_restore_quarantines WHERE id=$1',[input.quarantine_id])).rows[0];
  if(!pre||pre.manifest_sha256.trim()!==input.manifest_sha256)fail('RESTORE_RECEIPT_CONFLICT');
  const receipt=pre.receipt as RestoreReceipt;
  if(!receipt.audit.complete||input.owner_user_ids.some(owner=>!receipt.account_ids.includes(owner)))fail();
  const queryCalls=async(db:Pool|PoolClient)=> (await db.query(`SELECT a.*,j.run_id,p.id result_id,p.result_ref,p.byte_size,trim(p.result_sha256) result_sha256
    FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id
    LEFT JOIN bb_provider_result_refs p ON p.attempt_id=a.id WHERE a.owner_user_id=ANY($1::text[]) ORDER BY a.id,p.id`,[input.owner_user_ids])).rows;
  const calls=await queryCalls(pool);
  if(new Set(calls.map(call=>call.id)).size!==calls.length)fail(); // Competing result hashes remain unknown.
  const relevant=receipt.calls.filter(call=>input.owner_user_ids.includes(call.owner_user_id));
  const verified:Record<string,string>={};
  for(const call of relevant){
    const actual=calls.find(a=>a.id===call.attempt_id&&a.owner_user_id===call.owner_user_id&&a.job_id===call.job_id&&a.run_id===call.run_id&&a.logical_call_id===call.logical_call_id);
    if(!actual||!['completed','confirmed_not_sent'].includes(actual.status))fail();
    if(call.status!=='unknown'&&call.status!==(actual.status==='completed'?'completed_verified':actual.status))fail();
    if(actual.status==='completed'){
      if(!actual.result_ref||!actual.result_sha256||call.result_sha256&&call.result_sha256!==actual.result_sha256
        ||call.result_ref&&call.result_ref!==actual.result_ref)fail();
      const completed=(await pool.query("SELECT id FROM bb_provider_call_observations WHERE attempt_id=$1 AND result_id=$2 AND outcome='completed' LIMIT 1",[actual.id,actual.result_id])).rows[0];
      if(!completed)fail();
      const bytes=await readObject(actual.result_ref);
      if(!bytes.length||bytes.length!==Number(actual.byte_size)||bytes.length>10*1024*1024||digest(bytes)!==actual.result_sha256)fail('RESTORE_OBJECT_HASH_MISMATCH');
      verified[actual.id]=actual.result_sha256;
    }else{
      const proof=(await pool.query("SELECT id FROM bb_provider_call_observations WHERE attempt_id=$1 AND outcome='confirmed_not_sent' LIMIT 1",[actual.id])).rows[0];
      if(!proof)fail();
      verified[actual.id]='confirmed_not_sent:'+proof.id;
    }
  }
  if(calls.some(call=>!relevant.some(r=>r.attempt_id===call.id)))fail();
  return transaction(pool,async c=>{
    await c.query('SELECT public.bb_lock_evidence_gate(true)');
    const current=(await c.query('SELECT * FROM bb_database_restore_quarantines ORDER BY seq DESC LIMIT 1 FOR UPDATE')).rows[0];
    if(!current||current.id!==pre.id||current.manifest_sha256.trim()!==input.manifest_sha256)fail('RESTORE_RECEIPT_CONFLICT');
    if(restoreCanonical(await queryCalls(c))!==restoreCanonical(calls))fail('RESTORE_RECEIPT_CONFLICT');
    const state=await gateState(c);
    if(state.state==='paused'&&state.reason_code!=='database_restore_quarantine')fail();
    for(const owner of [...input.owner_user_ids].sort()){
      await lockWalletSafetyForControl(c,owner);
      await c.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE',[owner]);
      const jobs=(await c.query("SELECT id,run_id,attempts,execution_session_id,checkpoint FROM bb_jobs WHERE owner_user_id=$1 AND run_id IS NOT NULL AND state NOT IN ('succeeded','failed','cancelled')",[owner])).rows;
      if(jobs.some(job=>!relevant.some(call=>call.job_id===job.id)&&!(receipt.never_sent_runs.includes(job.run_id)
        &&job.attempts===0&&!job.execution_session_id&&job.checkpoint.never_admitted_v1?.version==='never-admitted-v1'
        &&job.checkpoint.never_admitted_v1.job_id===job.id)))fail();
      const occupied=(await c.query(`SELECT 1 FROM bb_jobs WHERE owner_user_id=$1 AND lease_token IS NOT NULL
        UNION ALL SELECT 1 FROM bb_review_messages WHERE owner_user_id=$1 AND lease_token IS NOT NULL
        UNION ALL SELECT 1 FROM bb_model_capacity_holders WHERE admission_job_id IN(SELECT id FROM bb_jobs WHERE owner_user_id=$1)
          OR admission_message_id IN(SELECT id FROM bb_review_messages WHERE owner_user_id=$1) OR execution_node_id IS NULL
        UNION ALL SELECT 1 FROM bb_model_capacity_waiters WHERE admission_job_id IN(SELECT id FROM bb_jobs WHERE owner_user_id=$1)
          OR admission_message_id IN(SELECT id FROM bb_review_messages WHERE owner_user_id=$1) OR execution_node_id IS NULL LIMIT 1`,[owner])).rows[0];
      if(occupied)fail('RESTORE_EXECUTION_NOT_FENCED');
      const billing=receipt.billing.find(row=>row.owner_user_id===owner);
      if(!billing) return fail('RESTORE_BILLING_RECONCILIATION_REQUIRED');
      if(!billing.consistent||digest(restoreCanonical(await restoreBillingSnapshot(c,owner)))!==billing.sha256
        ||!(await auditCreditClient(c,owner)).consistent)fail('RESTORE_BILLING_RECONCILIATION_REQUIRED');
      await c.query(`INSERT INTO bb_database_restore_reconciliations(id,quarantine_id,owner_user_id,manifest_sha256,evidence,actor_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(quarantine_id,owner_user_id) DO NOTHING`,
        [uid(),pre.id,owner,input.manifest_sha256,{version:'database-restore-reconciled-v1',calls:verified,billing_sha256:billing.sha256},actorId]);
    }
    if(state.state==='paused')await c.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type,actor_id) VALUES($1,'open','database_restore_reconciled','operator',$2)",[uid(),actorId]);
    // No lease, holder, run cursor, usage or money record is changed here.
    unpersistedPause=null;
    return {state:'open',quarantine_id:pre.id,permitted_owner_user_ids:input.owner_user_ids};
  });
}
/** Test hook only. */
export function resetProcessGateForTests() { unpersistedPause = null; }
