import { Pool } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export interface ModelCallPermit {
  signal: AbortSignal;
  bindProcess(pid: number, codexHome?: string): Promise<void>;
  renew(): Promise<void>;
  /** Only after the contained process has closed, including cancellation. */
  release(): Promise<void>;
}
export interface ModelCallBudget {
  acquire(signal?: AbortSignal, scope?: string): Promise<ModelCallPermit>;
  reconcileOwnExitedProcesses?(): Promise<void>;
}
const namespace = 0x42424d43;
const budgets = new WeakMap<Pool, ModelCallBudget>();
export function modelCallConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const value = env.BB_MODEL_CALL_CONCURRENCY ?? '6';
  if (!/^[1-6]$/.test(value)) throw new Error('Invalid BB_MODEL_CALL_CONCURRENCY');
  return Number(value);
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

/** Global six-slot semaphore in the sole PG, shared by authoring/review/assistants.
 * Scope rotation prevents a large batch from monopolizing permits. Waiters hold
 * no checked-out connection/transaction, and only the configured limit per process can register.
 * Active holders have NO TTL: loss of renewal aborts the process, and its row is
 * retained until actual process exit. Historical unknown billing stays in the
 * existing journal, independently of active capacity. */
export class PgModelCallBudget implements ModelCallBudget {
  private active = 0;
  private readonly exitedTokens = new Set<string>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly sessions: Pool;
  private readonly host = hostname();
  constructor(pool: Pool, private readonly limit: number = 6) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('Invalid model call concurrency');
    this.sessions = new Pool({ ...pool.options, max: limit, application_name: 'bondbuddy_model_budget',
      connectionTimeoutMillis: 5000, query_timeout: pool.options.query_timeout ?? 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
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
    const currentNamespace=await readlink('/proc/self/ns/pid');
    const currentBoot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    const currentInit=await processStart(1);
    const rows = (await this.sessions.query('SELECT * FROM bb_model_capacity_holders WHERE host_id=$1 AND pid_namespace=$2 AND host_boot_id=$3 AND namespace_init_start=$4',[this.host,currentNamespace,currentBoot,currentInit])).rows;
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
      this.exitedTokens.add(token);
      if (timer) clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      try {
        await this.sessions.query('DELETE FROM bb_model_capacity_waiters WHERE token=$1',[token]);
        await this.sessions.query('DELETE FROM bb_model_capacity_holders WHERE token=$1 AND host_id=$2',[token,this.host]);
        this.exitedTokens.delete(token);
      } finally { this.leave(); }
    };
    try {
      controller.signal.throwIfAborted();
      const parentStart = await processStart(process.pid);
      const hostBootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
      const pidNamespace=await readlink('/proc/self/ns/pid');
      const namespaceInitStart=await processStart(1);
      if (!namespaceInitStart) throw new Error('Model capacity namespace identity unavailable');
      const executionHost=process.env.BB_MODEL_EXECUTION_HOST_ID || createHash('sha256').update(await readFile('/etc/machine-id')).digest('hex');
      if (!/^[a-f0-9]{64}$/.test(executionHost)) throw new Error('Invalid model execution host identity');
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
                await client.query(`INSERT INTO bb_model_capacity_holders(token,scope,slot,host_id,parent_pid,parent_start,execution_host,host_boot_id,pid_namespace,namespace_init_start)
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[token,scope,slot,this.host,process.pid,parentStart,executionHost,hostBootId,pidNamespace,namespaceInitStart]);
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
      const bindProcess = async (pid: number, codexHome?: string) => {
        const identity = await processIdentity(pid);
        if (!identity) throw new Error('Model capacity child identity unavailable');
        const result = await this.sessions.query('UPDATE bb_model_capacity_holders SET child_pid=$3,child_start=$4,child_group=$5,codex_home=$6 WHERE token=$1 AND host_id=$2',[token,this.host,pid,identity.start,identity.group,codexHome ?? null]);
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
