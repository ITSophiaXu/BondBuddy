import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export interface ModelCallPermit {
  signal: AbortSignal;
  bindProcess(pid: number): Promise<void>;
  renew(): Promise<void>;
  /** Only after the contained process has closed, including cancellation. */
  release(): Promise<void>;
}
export interface ModelCallBudget {
  acquire(signal?: AbortSignal, scope?: string): Promise<ModelCallPermit>;
}
const namespace = 0x42424d43;
const budgets = new WeakMap<Pool, ModelCallBudget>();
export function modelCallConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const value = env.BB_MODEL_CALL_CONCURRENCY ?? '4';
  if (!/^[1-4]$/.test(value)) throw new Error('Invalid BB_MODEL_CALL_CONCURRENCY');
  return Number(value);
}
async function processStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch (error) {
    if (['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error; // unreadable is not evidence of absence
  }
}

/** Global four-slot semaphore in the sole PG, shared by authoring/review/assistants.
 * Scope rotation prevents a large batch from monopolizing permits. Waiters hold
 * no checked-out connection/transaction, and only four per process can register.
 * Active holders have NO TTL: loss of renewal aborts the process, and its row is
 * retained until actual process exit. Historical unknown billing stays in the
 * existing journal, independently of active capacity. */
export class PgModelCallBudget implements ModelCallBudget {
  private active = 0;
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly sessions: Pool;
  private readonly host = hostname();
  constructor(pool: Pool, private readonly limit: number = 4) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('Invalid model call concurrency');
    this.sessions = new Pool({ ...pool.options, max: limit, application_name: 'bondbuddy_model_budget',
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
    this.sessions.on('error', () => { /* a failed operation is fail-closed */ });
  }
  private async enter(scope: string, signal?: AbortSignal) {
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
    });
  }
  private leave() {
    this.active--;
    const head = this.waiters.entries().next().value;
    if (!head) return;
    const [scope,queue] = head;
    const ready = queue.shift()!;
    this.waiters.delete(scope);
    if (queue.length) this.waiters.set(scope,queue);
    ready();
  }
  /** Only this container's prior process may be recovered using /proc start identity.
   * Foreign/unreadable/possibly-live holders remain fenced for host reconciliation.
   * A restarted PID 1 namespace is direct evidence that its old child tree died. */
  async reconcileOwnExitedProcesses() {
    const rows = (await this.sessions.query('SELECT * FROM bb_model_capacity_holders WHERE host_id=$1',[this.host])).rows;
    for (const row of rows) {
      const parent = await processStart(row.parent_pid);
      const child = row.child_pid === null ? null : await processStart(row.child_pid);
      if (child === row.child_start && child !== null) continue;
      if (row.child_pid === null && (parent === row.parent_start || row.parent_pid !== 1)) continue; // unbound spawn cannot be guessed dead
      await this.sessions.query('DELETE FROM bb_model_capacity_holders WHERE token=$1 AND host_id=$2 AND parent_start=$3',[row.token,this.host,row.parent_start]);
    }
  }
  async acquire(signal?: AbortSignal, scope = 'unscoped'): Promise<ModelCallPermit> {
    if (!/^[A-Za-z0-9:_-]{1,180}$/.test(scope)) throw new Error('Invalid model capacity scope');
    await this.enter(scope, signal);
    const token = randomUUID(), controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setInterval> | undefined;
    let released = false, granted = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      try {
        await this.sessions.query('DELETE FROM bb_model_capacity_waiters WHERE token=$1',[token]);
        await this.sessions.query('DELETE FROM bb_model_capacity_holders WHERE token=$1 AND host_id=$2',[token,this.host]);
      } finally { this.leave(); }
    };
    try {
      controller.signal.throwIfAborted();
      const parentStart = await processStart(process.pid);
      if (!parentStart) throw new Error('Model capacity process identity unavailable');
      await this.reconcileOwnExitedProcesses();
      await this.sessions.query('INSERT INTO bb_model_capacity_scopes(scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
      await this.sessions.query("INSERT INTO bb_model_capacity_waiters(token,scope,wait_until) VALUES($1,$2,now()+interval '30 seconds')",[token,scope]);
      while (!granted) {
        controller.signal.throwIfAborted();
        const client = await this.sessions.connect();
        try {
          await client.query('BEGIN');
          const lock = (await client.query('SELECT pg_try_advisory_xact_lock($1::integer,0) AS locked',[namespace])).rows[0];
          if (lock.locked) {
            await client.query("UPDATE bb_model_capacity_waiters SET wait_until=now()+interval '30 seconds' WHERE token=$1",[token]);
            const head = (await client.query(`SELECT w.token FROM bb_model_capacity_waiters w JOIN bb_model_capacity_scopes s USING(scope)
              WHERE w.wait_until>now() ORDER BY s.last_granted,w.ticket LIMIT 1`)).rows[0];
            if (head?.token === token) {
              const slot = (await client.query(`SELECT g.slot FROM generate_series(1,$1::integer) g(slot)
                WHERE NOT EXISTS(SELECT 1 FROM bb_model_capacity_holders h WHERE h.slot=g.slot) LIMIT 1`,[this.limit])).rows[0]?.slot;
              if (slot !== undefined) {
                await client.query(`INSERT INTO bb_model_capacity_holders(token,scope,slot,host_id,parent_pid,parent_start)
                  VALUES($1,$2,$3,$4,$5,$6)`,[token,scope,slot,this.host,process.pid,parentStart]);
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
      const renew = async () => {
        if (released || controller.signal.aborted) throw new Error('Model capacity holder lost');
        try {
          const result = await this.sessions.query('UPDATE bb_model_capacity_holders SET renewed_at=now() WHERE token=$1 AND host_id=$2',[token,this.host]);
          if (!result.rowCount) throw new Error('Model capacity holder lost');
        } catch { controller.abort(new Error('Model capacity holder lost')); throw new Error('Model capacity holder lost'); }
      };
      let renewing = false;
      timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void renew().catch(()=>{}).finally(()=>{renewing=false;});
      },5000);
      timer.unref();
      const bindProcess = async (pid: number) => {
        const start = await processStart(pid);
        if (!start) throw new Error('Model capacity child identity unavailable');
        const result = await this.sessions.query('UPDATE bb_model_capacity_holders SET child_pid=$3,child_start=$4 WHERE token=$1 AND host_id=$2',[token,this.host,pid,start]);
        if (!result.rowCount) throw new Error('Model capacity holder lost');
      };
      controller.signal.throwIfAborted();
      return { signal:controller.signal,bindProcess,renew,release };
    } catch (error) { await release(); throw error; }
  }
}
export function modelCallBudgetFor(pool: Pool): ModelCallBudget {
  let budget = budgets.get(pool);
  if (!budget) { budget = new PgModelCallBudget(pool, modelCallConcurrency()); budgets.set(pool,budget); }
  return budget;
}
