import { Pool } from 'pg';
import { renewModelCapacity } from './model-capacity-renewal.js';
import { withPerformanceSpan } from '@bondbuddy/api/performance-trace';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {executionNodeForPool} from '@bondbuddy/api/execution-capacity';

export interface ModelCallPermit {
  signal: AbortSignal;
  bindProcess(pid: number, codexHome?: string): Promise<void>;
  renew(): Promise<void>;
  /** Only after the contained process has closed, including cancellation. */
  release(): Promise<void>;
}
export interface ModelCallBudget {
  acquire(signal?: AbortSignal, scope?: string, admission?:ModelCallAdmission): Promise<ModelCallPermit>;
  reconcileOwnExitedProcesses?(): Promise<void>;
}
export type ModelCallAdmission={kind:'job'|'assistant';id:string;token:string};
const namespace = 0x42424d43;
const budgets = new WeakMap<Pool, ModelCallBudget>();
/** Private operational evidence: never serialize an exception/message or request bytes. */
export function modelCancellationDiagnostic(reason: unknown, source: 'capacity_renewal' | 'task_signal' | 'capacity_signal', phase: 'renewal' | 'before_spawn' | 'native', scope?: string) {
  const error = reason as { code?: unknown; message?: unknown; cancellation?: { original_error_code: string | null; error_class: string } } | null;
  const safeCode = (value: unknown) => typeof value === 'string' && (/^[0-9A-Z]{5}$/.test(value) || ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOTFOUND'].includes(value)) ? value : null;
  const code = safeCode(error?.cancellation?.original_error_code) ?? safeCode(error?.code);
  const errorClass = error?.message === 'Connection terminated due to connection timeout' ? 'pg_connect_timeout' : error?.message === 'Query read timeout' ? 'pg_query_timeout' : error?.message === 'Model capacity holder lost' ? 'holder_missing' : reason instanceof DOMException && reason.name === 'AbortError' ? 'abort' : reason instanceof Error ? 'error' : 'unavailable';
  const preservedClass = error?.cancellation?.error_class;
  return { kind: 'model_cancellation', source, phase,
    original_error_code: code,
    error_class: preservedClass && ['pg_connect_timeout','pg_query_timeout','holder_missing','abort','error','unavailable'].includes(preservedClass) ? preservedClass : errorClass,
    ...(scope && /^[A-Za-z0-9:_-]{1,180}$/.test(scope) ? { scope } : {}) };
}
export function reportModelCancellation(diagnostic: ReturnType<typeof modelCancellationDiagnostic>) {
  try { process.stderr.write(JSON.stringify(diagnostic) + '\n'); } catch { /* evidence cannot alter cancellation */ }
}
export function modelCallConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const value = env.BB_MODEL_CALL_CONCURRENCY;
  if (value === undefined || value === 'auto') return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid BB_MODEL_CALL_CONCURRENCY');
  return Number(value);
}
/** Resource capacity, never a business-task limit. An explicit local setting may
 * reduce this worker's footprint; omission follows the shared policy. */
export async function resolveModelCallConcurrency(pool:Pool,local=modelCallConcurrency()):Promise<number>{
  const policy=(await pool.query('SELECT global_model_limit,node_model_limit,managed_nodes FROM bb_execution_capacity_policy WHERE singleton')).rows[0];
  if(!policy)throw Error('Model capacity policy unavailable');
  const node=executionNodeForPool(pool);
  if(policy.managed_nodes&&!node)throw Error('Managed execution node identity required');
  const values=[Number(policy.global_model_limit),...(node?[Number(policy.node_model_limit)]:[]),...(local===undefined?[]:[local])];
  if(values.some(value=>!Number.isSafeInteger(value)||value<1))throw Error('Invalid model capacity policy');
  return Math.min(...values);
}
async function processIdentity(pid: number): Promise<{start:string;group:number} | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields=stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ? {start:fields[19],group:Number(fields[2])} : null;
  } catch (error) {
    if (['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error; // unreadable is not evidence of absence
  }
}

const processStart = async (pid: number) => (await processIdentity(pid))?.start ?? null;
async function groupOrHomeAlive(group: number | null, home: string | null) {
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    const identity = await processIdentity(Number(name));
    if (!identity) continue;
    if (group !== null && identity.group === group) return true;
    if (home !== null) {
      try {
        const env=await readFile(`/proc/${name}/environ`);
        if (env.includes(Buffer.from(`CODEX_HOME=${home}\0`))) return true;
      } catch (error) {
        if (!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  }
  return false;
}

/** Durable bounded semaphore in the sole PG, shared by authoring/review/assistants.
 * Scope rotation prevents a large batch from monopolizing permits. Waiters hold
 * no checked-out connection/transaction, and at most the configured per-process bound can register.
 * Active holders have NO TTL: confirmed loss or bounded confirmation failure aborts the process; its row is
 * retained until actual process exit. Historical unknown billing stays in the
 * existing journal, independently of active capacity. */
export class PgModelCallBudget implements ModelCallBudget {
  private active = 0;
  private readonly exitedTokens = new Set<string>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly sessions: Pool;
  private readonly host = hostname();
  private limit = 0;
  constructor(private readonly pool: Pool, private readonly configuredLimit?: number) {
    if (configuredLimit !== undefined && (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1)) throw new Error('Invalid model call concurrency');
    this.sessions = new Pool({ ...pool.options, max: pool.options.max ?? 10, application_name: 'bondbuddy_model_budget',
      // Renew every five seconds on the existing connection instead of reopening
      // the database transport each time. Idle connections still retire promptly.
      connectionTimeoutMillis: 5000, query_timeout: pool.options.query_timeout ?? 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true });
    this.sessions.on('error', () => { /* a failed operation is fail-closed */ });
  }
  private async enter(scope: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.limit=await resolveModelCallConcurrency(this.pool,this.configuredLimit);
    signal?.throwIfAborted();
    if (this.active < this.limit && !this.waiters.size) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal?.removeEventListener('abort', cancel); this.active++; resolve(); };
      const cancel = () => {
        const queue = this.waiters.get(scope);
        if (queue) { const index = queue.indexOf(ready); if (index >= 0) queue.splice(index,1); if (!queue.length) this.waiters.delete(scope); }
        reject(signal?.reason ?? new Error('Model capacity wait cancelled'));
      };
      const queue = this.waiters.get(scope) ?? [];
      queue.push(ready); this.waiters.set(scope,queue);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      this.drain();
    });
  }
  private leave() { this.active--;this.drain(); }
  private drain() {
    while(this.active<this.limit){
    const head = this.waiters.entries().next().value;
    if (!head) return;
    const [scope,queue] = head;
    const ready = queue.shift()!;
    this.waiters.delete(scope);
    if (queue.length) this.waiters.set(scope,queue);
    ready();
    }
  }
  /** Only this container's prior process may be recovered using /proc start identity.
   * Foreign/unreadable/possibly-live holders remain fenced for host reconciliation.
   * A restarted PID 1 namespace is direct evidence that its old child tree died. */
  async reconcileOwnExitedProcesses() {
    const currentNamespace=await readlink('/proc/self/ns/pid');
    const currentBoot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    const currentInit=await processStart(1);
    const context=executionNodeForPool(this.pool);
    const rows = (await this.sessions.query(`SELECT * FROM bb_model_capacity_holders WHERE host_id=$1 AND pid_namespace=$2 AND host_boot_id=$3 AND namespace_init_start=$4
      AND ($5::uuid IS NULL AND execution_node_id IS NULL OR execution_node_epoch=$5 AND execution_session_id=$6)`,[this.host,currentNamespace,currentBoot,currentInit,context?.identity.epoch??null,context?.session_id??null])).rows;
    for (const row of rows) {
      if (this.exitedTokens.has(row.token)) {
        await this.sessions.query('DELETE FROM bb_model_capacity_holders WHERE token=$1 AND host_id=$2',[row.token,this.host]);
        this.exitedTokens.delete(row.token);continue;
      }
      const parent = await processStart(row.parent_pid);
      if (parent === row.parent_start) continue;
      const child = row.child_pid === null ? null : await processStart(row.child_pid);
      if (child === row.child_start && child !== null) continue;
      if (row.child_pid === null && row.parent_pid !== 1) continue; // unbound spawn cannot be guessed dead
      if (await groupOrHomeAlive(row.child_group,row.codex_home)) continue;
      await this.sessions.query('DELETE FROM bb_model_capacity_holders WHERE token=$1 AND host_id=$2 AND parent_start=$3',[row.token,this.host,row.parent_start]);
    }
  }
  async acquire(signal?: AbortSignal, scope = 'unscoped',admission?:ModelCallAdmission): Promise<ModelCallPermit> {
    if (!/^[A-Za-z0-9:_-]{1,180}$/.test(scope)) throw new Error('Invalid model capacity scope');
    await withPerformanceSpan('model.capacity.local_wait', { wait_reason: 'local_capacity' }, async span => {
      try { await this.enter(scope, signal); } catch (error) { if (signal?.aborted) span.end('cancelled'); throw error; }
    });
    const token = randomUUID(), controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setInterval> | undefined;
    let released = false, granted = false;
    let renewal: Promise<void> | undefined;
    const release = async () => {
      if (released) return;
      released = true;
      this.exitedTokens.add(token);
      if (timer) clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      // A caller releases only after process exit. Do not race an in-flight check.
      await renewal?.catch(()=>{});
      try {
        await this.sessions.query('DELETE FROM bb_model_capacity_waiters WHERE token=$1',[token]);
        await this.sessions.query('DELETE FROM bb_model_capacity_holders WHERE token=$1 AND host_id=$2',[token,this.host]);
        this.exitedTokens.delete(token);
      } finally { this.leave(); }
    };
    try {
      await withPerformanceSpan('model.capacity.global_wait', { wait_reason: 'global_capacity' }, async span => {
      try {
      controller.signal.throwIfAborted();
      const parentStart = await processStart(process.pid);
      const hostBootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
      const pidNamespace=await readlink('/proc/self/ns/pid');
      const namespaceInitStart=await processStart(1);
      if (!namespaceInitStart) throw new Error('Model capacity namespace identity unavailable');
      const context=executionNodeForPool(this.pool);
      if((await this.sessions.query('SELECT managed_nodes FROM bb_execution_capacity_policy WHERE singleton')).rows[0].managed_nodes&&!context)throw Error('Managed execution node identity required');
      const executionHost=context?createHash('sha256').update(JSON.stringify(context.identity)).digest('hex'):process.env.BB_MODEL_EXECUTION_HOST_ID || createHash('sha256').update(await readFile('/etc/machine-id')).digest('hex');
      if (!/^[a-f0-9]{64}$/.test(executionHost)) throw new Error('Invalid model execution host identity');
      if (!parentStart) throw new Error('Model capacity process identity unavailable');
      await this.reconcileOwnExitedProcesses();
      await this.sessions.query('INSERT INTO bb_model_capacity_scopes(scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
      const waiterNode=context?(await this.sessions.query('SELECT id FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3 AND epoch=$4',[context.identity.account_id,context.identity.region,context.identity.instance_id,context.identity.epoch])).rows[0]:null;
      if(context&&!waiterNode)throw Error('Execution node capacity fenced');
      await this.sessions.query("INSERT INTO bb_model_capacity_waiters(token,scope,wait_until,execution_node_id,execution_node_epoch,execution_session_id,admission_job_id,admission_message_id,admission_lease_token) VALUES($1,$2,now()+interval '30 seconds',$3,$4,$5,$6,$7,$8)",[token,scope,waiterNode?.id??null,context?.identity.epoch??null,context?.session_id??null,admission?.kind==='job'?admission.id:null,admission?.kind==='assistant'?admission.id:null,admission?.token??null]);
      while (!granted) {
        controller.signal.throwIfAborted();
        const client = await this.sessions.connect();
        try {
          await client.query('BEGIN');
          const lock = (await client.query('SELECT pg_try_advisory_xact_lock($1::integer,0) AS locked',[namespace])).rows[0];
          if (lock.locked) {
            if(context){
              const valid=(await client.query(`SELECT 1 FROM bb_execution_nodes n WHERE n.id=$1 AND n.epoch=$2 AND n.state IN ('ready','draining') AND (
               EXISTS(SELECT 1 FROM bb_jobs j WHERE j.id=$3 AND j.execution_node_id=n.id AND j.execution_node_epoch=n.epoch AND j.execution_session_id=$4 AND j.state='running' AND j.lease_token=$5 AND j.lease_until>clock_timestamp()) OR
               EXISTS(SELECT 1 FROM bb_review_messages m WHERE m.id=$6 AND m.execution_node_id=n.id AND m.execution_node_epoch=n.epoch AND m.execution_session_id=$4 AND m.reply_status='running' AND m.lease_token::text=$5 AND m.lease_until>clock_timestamp()))`,[waiterNode.id,context.identity.epoch,admission?.kind==='job'?admission.id:null,context.session_id,admission?.token??null,admission?.kind==='assistant'?admission.id:null])).rowCount;
              if(!valid)throw Error('Execution model admission lease lost');
            }
            await client.query("UPDATE bb_model_capacity_waiters SET wait_until=now()+interval '30 seconds' WHERE token=$1",[token]);
            const head = (await client.query(`SELECT w.token FROM bb_model_capacity_waiters w JOIN bb_model_capacity_scopes s USING(scope)
              LEFT JOIN bb_execution_nodes n ON n.id=w.execution_node_id AND n.epoch=w.execution_node_epoch
              JOIN bb_execution_capacity_policy p ON p.singleton
              WHERE w.wait_until>now() AND (w.execution_node_id IS NULL AND NOT p.managed_nodes OR n.state IN ('ready','draining')
               AND (SELECT count(*) FROM bb_model_capacity_holders h WHERE h.execution_node_id=n.id)<p.node_model_limit AND (
                EXISTS(SELECT 1 FROM bb_jobs j WHERE j.id=w.admission_job_id AND j.execution_node_id=n.id AND j.execution_node_epoch=n.epoch AND j.execution_session_id=w.execution_session_id AND j.state='running' AND j.lease_token=w.admission_lease_token AND j.lease_until>clock_timestamp()) OR
                EXISTS(SELECT 1 FROM bb_review_messages m WHERE m.id=w.admission_message_id AND m.execution_node_id=n.id AND m.execution_node_epoch=n.epoch AND m.execution_session_id=w.execution_session_id AND m.reply_status='running' AND m.lease_token::text=w.admission_lease_token AND m.lease_until>clock_timestamp())))
              ORDER BY s.last_granted,w.ticket LIMIT 1`)).rows[0];
            if (head?.token === token) {
              const policy=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR SHARE')).rows[0];
              if(policy.managed_nodes&&!context)throw Error('Managed execution node identity required');
              const node=context?(await client.query('SELECT id,state,epoch FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3 FOR UPDATE',[context.identity.account_id,context.identity.region,context.identity.instance_id])).rows[0]:null;
              if(context&&(!node||node.epoch!==context.identity.epoch||!['ready','draining'].includes(node.state)||!admission))throw Error('Execution node capacity fenced');
              // Slot IDs are unique. The first ID above its ordinal marks the
              // first gap. Count holders above a lowered limit as well.
              const slot = (policy.budget_available||!!node)&&(await client.query(`
                SELECT coalesce(min(ordinal) FILTER (WHERE slot>ordinal),count(*)+1)::integer AS slot
                FROM (SELECT slot,row_number() OVER (ORDER BY slot) AS ordinal FROM bb_model_capacity_holders) occupied
                HAVING count(*)<$1::integer`,[policy.global_model_limit])).rows[0]?.slot;
              const nodeSlot=node?(await client.query('SELECT g.slot FROM generate_series(1,$2::integer) g(slot) WHERE NOT EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=$1 AND node_slot=g.slot) LIMIT 1',[node.id,policy.node_model_limit])).rows[0]?.slot:null;
              if (slot !== undefined && slot!==false && (!node||nodeSlot!==undefined)) {
                if(admission)await client.query("SELECT set_config('bb.execution_lease_token',$1,true)",[admission.token]);
                await client.query(`INSERT INTO bb_model_capacity_holders(token,scope,slot,host_id,parent_pid,parent_start,execution_host,host_boot_id,pid_namespace,namespace_init_start,
                  execution_node_id,execution_node_epoch,execution_session_id,node_slot,admission_job_id,admission_message_id)
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[token,scope,slot,this.host,process.pid,parentStart,executionHost,hostBootId,pidNamespace,namespaceInitStart,node?.id??null,context?.identity.epoch??null,context?.session_id??null,nodeSlot??null,admission?.kind==='job'?admission.id:null,admission?.kind==='assistant'?admission.id:null]);
                await client.query("UPDATE bb_model_capacity_scopes SET last_granted=nextval('bb_model_capacity_order') WHERE scope=$1",[scope]);
                await client.query('DELETE FROM bb_model_capacity_waiters WHERE token=$1',[token]);
                granted = true;
              }
            }
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
        finally { client.release(); }
        if (!granted) await delay(100, undefined, { signal: controller.signal });
      }
      } catch (error) { if (controller.signal.aborted) span.end('cancelled'); throw error; }
      });
      let lastConfirmed = Date.now(), nextTick = Date.now()+5000;
      const renew = (eventLoopLagMs = 0): Promise<void> => {
        if (released || controller.signal.aborted) return Promise.reject(new Error('Model capacity holder lost'));
        if (renewal) return renewal;
        renewal = (async () => {
          try {
            await renewModelCapacity({sessions:this.sessions,token,host:this.host,admission,
              signal:controller.signal,scope,lastConfirmed,eventLoopLagMs});
            controller.signal.throwIfAborted();
            lastConfirmed=Date.now();
          } catch (error) {
            const diagnostic = modelCancellationDiagnostic(error, 'capacity_renewal', 'renewal', scope);
            reportModelCancellation(diagnostic);
            const lost = Object.assign(new Error('Model capacity holder lost'), { cancellation: diagnostic });
            controller.abort(lost); throw lost;
          }
        })().finally(()=>{renewal=undefined;});
        return renewal;
      };
      timer = setInterval(() => {
        const lag=Math.max(0,Date.now()-nextTick);nextTick=Date.now()+5000;
        void renew(lag).catch(()=>{});
      },5000);
      timer.unref();
      const bindProcess = async (pid: number, codexHome?: string) => {
        const identity = await processIdentity(pid);
        if (!identity) throw new Error('Model capacity child identity unavailable');
        const result = await this.sessions.query('UPDATE bb_model_capacity_holders SET child_pid=$3,child_start=$4,child_group=$5,codex_home=$6 WHERE token=$1 AND host_id=$2',[token,this.host,pid,identity.start,identity.group,codexHome ?? null]);
        if (!result.rowCount) throw new Error('Model capacity holder lost');
      };
      controller.signal.throwIfAborted();
      return { signal:controller.signal,bindProcess,renew:()=>renew(),release };
    } catch (error) { await release(); throw error; }
  }
}
export function modelCallBudgetFor(pool: Pool): ModelCallBudget {
  let budget = budgets.get(pool);
  if (!budget) { budget = new PgModelCallBudget(pool, modelCallConcurrency()); budgets.set(pool,budget); }
  return budget;
}
