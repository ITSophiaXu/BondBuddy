import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedTestDatabase } from './test-database.js';
import { PgModelCallBudget, modelCallConcurrency, type ModelCallPermit } from './model-call-budget.js';
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
  try {
  await until(async()=>(await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_waiters')).rows[0].n===1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders')).rows[0].n,4);
  // Admission checks use short transactions; sample the actual waiting interval
  // rather than racing the gap between two statements of an in-flight check.
  await until(async()=>(await pool.query("SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND application_name='bondbuddy_model_budget' AND state='idle in transaction'")).rows[0].n===0);
  controller.abort(); await assert.rejects(waiting);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_waiters')).rows[0].n,0);
  } finally {
    controller.abort();await waiting.then(permit=>permit.release(),()=>undefined);
    await Promise.all(held.map(p=>p.release()));await pool.end();
  }
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
  await held[0]!.release();await held[1]!.release();
  const fresh = await assistant;
  assert.equal(assistantGranted,true); assert.ok(batchGrants<=1,'fresh scope is not behind 250 batch requests');
  cancellations.forEach(cancelled=>cancelled.abort());
  await fresh.release(); await Promise.all(held.slice(2).map(p=>p.release()));
  const granted=await Promise.all(backlog);await Promise.all(granted.filter(p=>p!==null).map(p=>p!.release()));
  await pool.end();
});
test('stale renewal never frees an actual live process; dead local process identity permits recovery',{skip:!connection,timeout:20000},async()=>{
  const pool = new Pool({connectionString:connection}), budget=new PgModelCallBudget(pool);
  const held: ModelCallPermit[]=[];
  const controller=new AbortController();
  let child:ReturnType<typeof spawn>|undefined,exited:Promise<void>|undefined;
  let fifth:Promise<{permit:ModelCallPermit|null;error:unknown}>|undefined,fixtureToken:string|undefined;
  let fifthGranted=false;
  try{
    held.push(...await Promise.all(Array.from({length:4},(_,i)=>budget.acquire(undefined,'holder:'+i))));
    child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
    exited=new Promise<void>(resolve=>child!.once('close',()=>resolve()));
    assert.ok(child.pid);await held[0]!.bindProcess(child.pid!);
    await pool.query("UPDATE bb_model_capacity_holders SET renewed_at=now()-interval '100 days'");
    fifth=new PgModelCallBudget(pool).acquire(controller.signal,'fresh:after_loss').then(
      permit=>{fifthGranted=true;return {permit,error:null};},error=>({permit:null,error}));
    await delay(300);assert.equal(fifthGranted,false,'no TTL reclaim of four holders');

    // 0181 makes an existing entitlement's identity immutable. Preserve that
    // guard, and INSERT a synthetic former-parent association from the saved
    // entitlement instead. The child itself is real, directly owned and reaped.
    await assert.rejects(pool.query("UPDATE bb_model_capacity_holders SET parent_start='prior-process' WHERE child_pid=$1",[child.pid]),/Model entitlement identity immutable/);
    const saved=(await pool.query('SELECT * FROM bb_model_capacity_holders WHERE child_pid=$1',[child.pid])).rows[0];
    assert.ok(saved);
    fixtureToken=randomUUID();
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::integer,0)',[0x42424d43]);
      await held[0]!.release();
      await client.query('INSERT INTO bb_model_capacity_holders SELECT * FROM json_populate_record(NULL::bb_model_capacity_holders,$1::json)',
        [JSON.stringify({...saved,token:fixtureToken,parent_start:'prior-process'})]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await budget.reconcileOwnExitedProcesses();
    assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders')).rows[0].n,4);
    assert.equal(child.exitCode,null,'bound process is still alive before stop');
    assert.equal(fifthGranted,false,'a synthetic dead parent does not free its live child');
    child.kill('SIGKILL');await exited;
    await budget.reconcileOwnExitedProcesses();
    await until(async()=>fifthGranted);
    const next=await fifth;assert.ifError(next.error);assert.ok(next.permit);await next.permit.release();
    await Promise.all(held.map(permit=>permit.release()));
    assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders WHERE host_id=$1',[hostname()])).rows[0].n,0);
  }finally{
    controller.abort();
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    if(exited)await exited;
    const pending=await fifth;
    if(pending?.permit)await pending.permit.release();
    await Promise.all(held.map(permit=>permit.release()));
    if(fixtureToken)await pool.query('DELETE FROM bb_model_capacity_holders WHERE token=$1',[fixtureToken]);
    await pool.end();
  }
});

test('continually new child run scopes cannot starve an already waiting assistant',{skip:!connection,timeout:20000},async()=>{
 const pool=new Pool({connectionString:connection}),owner=new PgModelCallBudget(pool),children=new PgModelCallBudget(pool),assistant=new PgModelCallBudget(pool);
 const prior=await assistant.acquire(undefined,'assistant:established');await prior.release();
 const held=await Promise.all(Array.from({length:4},(_,i)=>owner.acquire(undefined,`running:${i}`)));
 const cancellations=Array.from({length:250},()=>new AbortController());let grantedBeforeAssistant=0,assistantReady=false;
 const childTasks=cancellations.map((c,i)=>children.acquire(c.signal,`run:child_${i}`).then(async permit=>{if(!assistantReady)grantedBeforeAssistant++;await permit.release();},()=>{}));
 await until(async()=>(await pool.query("SELECT count(*)::integer n FROM bb_model_capacity_waiters WHERE scope LIKE 'run:child_%'")).rows[0].n===4);
 const waiting=assistant.acquire(undefined,'assistant:established').then(p=>{assistantReady=true;return p;});
 await until(async()=>(await pool.query("SELECT 1 FROM bb_model_capacity_waiters WHERE scope='assistant:established'")).rowCount===1);
 await held[0]!.release();const next=await waiting;
 assert.ok(grantedBeforeAssistant<=4,`assistant waited behind ${grantedBeforeAssistant} new child scopes`);
 cancellations.forEach(c=>c.abort());await next.release();await Promise.all(held.slice(1).map(p=>p.release()));await Promise.all(childTasks);await pool.end();
});

test('renewal connection failure aborts the actual child but does not release capacity before exit',{skip:!connection,timeout:20000},async()=>{
 const pool=new Pool({connectionString:connection}),budget=new PgModelCallBudget(pool),other=new PgModelCallBudget(pool);
 const held=await Promise.all(Array.from({length:4},(_,i)=>budget.acquire(undefined,`renew:${i}`)));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));assert.ok(child.pid);await held[0]!.bindProcess(child.pid!);
 await pool.query(`CREATE FUNCTION bb1348_fail_renew() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.renewed_at<>OLD.renewed_at THEN RAISE EXCEPTION 'synthetic renewal connection failure' USING ERRCODE='08006'; END IF;
   RETURN NEW; END $$; CREATE TRIGGER bb1348_fail_renew BEFORE UPDATE ON bb_model_capacity_holders FOR EACH ROW EXECUTE FUNCTION bb1348_fail_renew()`);
 held[0]!.signal.addEventListener('abort',()=>child.kill('SIGTERM'),{once:true});
 await assert.rejects(held[0]!.renew(),/Model capacity holder lost/);assert.equal(held[0]!.signal.aborted,true);
 assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,4,'renewal loss does not free a durable slot');
 let admitted=false;const waiting=other.acquire(undefined,'renew:new').then(p=>{admitted=true;return p;});
 await delay(100);assert.equal(admitted,false);
 await closed;await held[0]!.release();const next=await waiting;await next.release();
 await Promise.all(held.slice(1).map(p=>p.release()));
 await pool.query('DROP TRIGGER bb1348_fail_renew ON bb_model_capacity_holders;DROP FUNCTION bb1348_fail_renew()');await pool.end();
});
