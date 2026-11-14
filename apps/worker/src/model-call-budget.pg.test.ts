import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedTestDatabase } from './test-database.js';
import { PgModelCallBudget, modelCallConcurrency } from './model-call-budget.js';
const connection = await isolatedTestDatabase(undefined,'global-model-budget');
const until = async (check:()=>Promise<boolean>) => {
  for (let i=0;i<100;i++) { if (await check()) return; await delay(25); }
  throw new Error('Capacity condition did not settle');
};
test('model budget accepts only a bounded strict integer',()=>{
  assert.equal(modelCallConcurrency({}),4);
  for (const value of ['0','5','-1','4.0','4; echo injected','']) assert.throws(()=>modelCallConcurrency({BB_MODEL_CALL_CONCURRENCY:value}));
});
test('cross-container pools share four durable slots; waiting cancels without holding a job connection',{skip:!connection,timeout:20000},async()=>{
  const pool = new Pool({connectionString:connection,max:1});
  const a = new PgModelCallBudget(pool), b = new PgModelCallBudget(pool);
  const held = await Promise.all(Array.from({length:4},(_,i)=>a.acquire(undefined,`batch:${i}`)));
  const controller = new AbortController();
  const waiting = b.acquire(controller.signal,'assistant:fresh');
  await until(async()=>(await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_waiters')).rows[0].n===1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders')).rows[0].n,4);
  assert.equal((await pool.query("SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND application_name='bondbuddy_model_budget' AND state='idle in transaction'")).rows[0].n,0);
  controller.abort(); await assert.rejects(waiting);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_waiters')).rows[0].n,0);
  await Promise.all(held.map(p=>p.release())); await pool.end();
});
test('a 250-item batch yields to fresh authoring/assistant scopes before taking all slots again',{skip:!connection,timeout:20000},async()=>{
  const pool = new Pool({connectionString:connection});
  const budget = new PgModelCallBudget(pool), other = new PgModelCallBudget(pool);
  const held = await Promise.all(Array.from({length:4},()=>budget.acquire(undefined,'batch:large')));
  const cancellations = Array.from({length:250},()=>new AbortController()); let batchGrants=0;
  const backlog = cancellations.map(cancelled=>budget.acquire(cancelled.signal,'batch:large').then(p=>{batchGrants++;return p;},()=>null));
  let assistantGranted=false;
  const assistant = other.acquire(undefined,'assistant:new').then(p=>{assistantGranted=true;return p;});
  await until(async()=>(await pool.query("SELECT 1 FROM bb_model_capacity_waiters WHERE scope='assistant:new'")).rowCount===1);
  await held[0]!.release();
  const fresh = await assistant;
  assert.equal(assistantGranted,true); assert.ok(batchGrants<=1,'fresh scope is not behind 250 batch requests');
  cancellations.forEach(cancelled=>cancelled.abort());
  await fresh.release(); await Promise.all(held.slice(1).map(p=>p.release()));
  const granted=await Promise.all(backlog);await Promise.all(granted.filter(p=>p!==null).map(p=>p!.release()));
  await pool.end();
});
test('stale renewal never frees an actual live process; dead local process identity permits recovery',{skip:!connection,timeout:20000},async()=>{
  const pool = new Pool({connectionString:connection});
  const budget=new PgModelCallBudget(pool);
  const held=await Promise.all(Array.from({length:4},(_,i)=>budget.acquire(undefined,`holder:${i}`)));
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  assert.ok(child.pid);await held[0]!.bindProcess(child.pid!);
  await pool.query("UPDATE bb_model_capacity_holders SET renewed_at=now()-interval '100 days'");
  let fifthGranted=false;const controller=new AbortController();
  const fifth=new PgModelCallBudget(pool).acquire(controller.signal,'fresh:after_loss').then(p=>{fifthGranted=true;return p;});
  await delay(300);assert.equal(fifthGranted,false,'no TTL reclaim of four holders');
  // A former parent identity with its real child still alive must remain fenced.
  await pool.query("UPDATE bb_model_capacity_holders SET parent_start='prior-process' WHERE child_pid=$1",[child.pid]);
  await budget.reconcileOwnExitedProcesses();
  assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders')).rows[0].n,4);
  assert.equal(child.exitCode,null,'bound process is still alive before stop');
  child.kill('SIGKILL');await exited;
  await budget.reconcileOwnExitedProcesses();
  const next=await fifth;assert.equal(fifthGranted,true);await next.release();
  await Promise.all(held.map(p=>p.release()));
  assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders WHERE host_id=$1',[hostname()])).rows[0].n,0);
  await pool.end();
});
