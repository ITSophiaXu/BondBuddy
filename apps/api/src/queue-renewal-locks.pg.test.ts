// Synthetic lock/lease regression in a private PostgreSQL clone. No model calls,
// materials, production tasks or billing reservations are involved.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {checkpoint,renew,type Lease} from './queue.js';
import {measuredActiveMs} from './authoring-progress.js';

const connection=await isolatedTestDatabase('BB_TEST_QUEUE_RENEWAL_DATABASE_URL');

test('queue renewal survives delivery locks without reviving expired or replaced leases',{skip:!connection},async t=>{
  const applicationName=`synthetic-renewal-lock-${randomUUID()}`;
  const pool=new Pool({connectionString:connection,max:4,application_name:applicationName,statement_timeout:10000});
  const observer=new Pool({connectionString:connection,max:3,statement_timeout:10000});
  const outcome=(work:Promise<unknown>)=>work.then(value=>({value,error:null as any}),error=>({value:null,error}));

  async function fixture():Promise<Lease>{
    const owner=`synthetic-owner-${randomUUID()}`,projectId=randomUUID(),runId=randomUUID(),jobId=randomUUID(),token=randomUUID();
    const inputHash='a'.repeat(64);
    await observer.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic renewal lock review','review')",[projectId,owner]);
    await observer.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[projectId,owner,inputHash]);
    await observer.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$1,'review',$4,'running')`,[runId,owner,projectId,inputHash]);
    await observer.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'review','synthetic','running',$4,clock_timestamp()+interval '2 seconds',1)`,[jobId,owner,runId,token]);
    return {jobId,runId,owner,token,checkpoint:{},attempts:1};
  }

  async function lockDelivery(lease:Lease):Promise<PoolClient>{
    const holder=await observer.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[lease.owner,lease.runId]);
    await holder.query('SELECT id FROM bb_jobs WHERE id=$1 FOR UPDATE',[lease.jobId]);
    return holder;
  }

  async function waitForLock(lease:Lease){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const row=(await observer.query(`SELECT a.xact_start<j.lease_until AS started_in_time FROM pg_stat_activity a
        CROSS JOIN bb_jobs j WHERE a.application_name=$1 AND j.id=$2 AND a.wait_event_type='Lock'
        AND cardinality(pg_blocking_pids(a.pid))>0`,[applicationName,lease.jobId])).rows[0];
      if(row){assert.equal(row.started_in_time,true,'renewal/write must have started before expiry');return;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('transaction did not reach the held lock');
  }

  async function waitForExpiry(lease:Lease){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      if((await observer.query('SELECT clock_timestamp()>lease_until AS expired FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].expired)return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('synthetic lease did not expire');
  }

  async function assertFreshDeadline(lease:Lease){
    const row=(await observer.query(`SELECT j.lease_token,j.lease_until>clock_timestamp()+interval '750 milliseconds' AS fresh,
      p.lease_until=j.lease_until AS meter_matches FROM bb_jobs j JOIN bb_authoring_progress p ON p.run_id=j.run_id
      WHERE j.id=$1`,[lease.jobId])).rows[0];
    assert.equal(row.lease_token,lease.token);assert.equal(row.fresh,true,'the next second starts after lock/bookkeeping work');
    assert.equal(row.meter_matches,true,'active billing meter inherits the renewed deadline');
  }

  try{
    // Establish the first worker connection before starting a deliberately short
    // lease, so a cold connection cannot turn the timely-renewal fixture late.
    await pool.query('SELECT 1');
    await t.test('a timely renewal waits past expiry on run/job locks, then receives a fresh lease',async()=>{
      const lease=await fixture(),holder=await lockDelivery(lease);
      const renewing=outcome(renew(pool,lease,1));
      try{
        await waitForLock(lease);await waitForExpiry(lease);await holder.query('COMMIT');
        assert.equal((await renewing).error,null);await assertFreshDeadline(lease);
      }finally{await holder.query('ROLLBACK');holder.release();await renewing;}
    });

    await t.test('progress bookkeeping cannot consume the next lease while it is blocked',async()=>{
      const lease=await fixture();
      await observer.query('INSERT INTO bb_authoring_progress(run_id,owner_user_id) VALUES($1,$2)',[lease.runId,lease.owner]);
      const before=(await observer.query(`SELECT p.clock_at,j.lease_until FROM bb_authoring_progress p JOIN bb_jobs j ON j.run_id=p.run_id
        WHERE p.run_id=$1`,[lease.runId])).rows[0];
      const confirmedBeforeRenewal=new Date(before.lease_until).getTime()-new Date(before.clock_at).getTime();
      const holder=await observer.connect();await holder.query('BEGIN');
      await holder.query('SELECT run_id FROM bb_authoring_progress WHERE run_id=$1 FOR UPDATE',[lease.runId]);
      const renewing=outcome(renew(pool,lease,1));
      try{
        await waitForLock(lease);await waitForExpiry(lease);
        // SELECT clock_timestamp() can be evaluated before FOR UPDATE acquires
        // the row. Make that unconfirmed gap much larger than timing tolerance.
        await observer.query('SELECT pg_sleep(1.5)');await holder.query('COMMIT');
        assert.equal((await renewing).error,null);await assertFreshDeadline(lease);
        const after=(await observer.query(`SELECT p.*,j.updated_at AS renewed_at,clock_timestamp() AS sampled_at
          FROM bb_authoring_progress p JOIN bb_jobs j ON j.run_id=p.run_id WHERE p.run_id=$1`,[lease.runId])).rows[0];
        const currentConfirmed=new Date(after.sampled_at).getTime()-new Date(after.renewed_at).getTime();
        const measured=measuredActiveMs(after,new Date(after.sampled_at));
        assert.ok(measured<=confirmedBeforeRenewal+currentConfirmed+250,'the expired lock-wait gap must not be billed');
        assert.ok(measured>=confirmedBeforeRenewal+currentConfirmed-250,'the valid pending interval remains in the next debit delta');
        await renew(pool,lease,10);
        const sampled=(await observer.query('SELECT active_ms FROM bb_authoring_progress WHERE run_id=$1',[lease.runId])).rows[0];
        assert.ok(Number(sampled.active_ms)>=confirmedBeforeRenewal-250,'the next debit sample includes the preserved interval');
      }finally{await holder.query('ROLLBACK');holder.release();await renewing;}
    });

    await t.test('a replaced token wins while an earlier renewal is waiting',async()=>{
      const lease=await fixture(),holder=await lockDelivery(lease),replacement=randomUUID();
      const renewing=outcome(renew(pool,lease,1));
      try{
        await waitForLock(lease);await waitForExpiry(lease);
        const changed=(await holder.query("UPDATE bb_jobs SET lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1 RETURNING lease_until",[lease.jobId,replacement])).rows[0];
        await holder.query('COMMIT');assert.equal((await renewing).error?.code,'ALREADY_TERMINAL');
        const job=(await observer.query('SELECT lease_token,lease_until FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0];
        assert.equal(job.lease_token,replacement);assert.deepEqual(job.lease_until,changed.lease_until);
      }finally{await holder.query('ROLLBACK');holder.release();await renewing;}
    });

    for(const state of ['cancelled','paused','failed'])await t.test(`${state} wins before a waiting renewal takes the locks`,async()=>{
      const lease=await fixture(),holder=await lockDelivery(lease);
      const renewing=outcome(renew(pool,lease,1));
      try{
        await waitForLock(lease);
        await holder.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[lease.runId,state]);
        // Keep a live token to prove the state transition itself wins.
        if(state!=='failed')await holder.query('UPDATE bb_jobs SET state=$2 WHERE id=$1',[lease.jobId,state]);
        const before=(await holder.query('SELECT lease_until FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0];
        await holder.query('COMMIT');assert.equal((await renewing).error?.code,'ALREADY_TERMINAL');
        assert.deepEqual((await observer.query('SELECT lease_until FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0],before);
      }finally{await holder.query('ROLLBACK');holder.release();await renewing;}
    });

    await t.test('a renewal first requested after expiry remains rejected',async()=>{
      const lease=await fixture();
      await observer.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[lease.jobId]);
      await assert.rejects(renew(pool,lease,1),{code:'ALREADY_TERMINAL'});
      assert.equal((await observer.query('SELECT clock_timestamp()>lease_until AS expired FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].expired,true);
    });

    await t.test('renewing an in-flight pause does not restart the frozen billing meter',async()=>{
      const lease=await fixture();
      await observer.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[lease.jobId]);
      await renew(pool,lease,1);
      const row=(await observer.query(`SELECT j.lease_until>clock_timestamp() AS active,p.lease_until AS meter_deadline
        FROM bb_jobs j JOIN bb_authoring_progress p ON p.run_id=j.run_id WHERE j.id=$1`,[lease.jobId])).rows[0];
      assert.equal(row.active,true);assert.equal(row.meter_deadline,null);
    });

    await t.test('ordinary checkpoint writes still lose when their lock wait crosses expiry',async()=>{
      const lease=await fixture(),holder=await lockDelivery(lease);
      const writing=outcome(checkpoint(pool,lease,'materials_ready',{synthetic:true}));
      try{
        await waitForLock(lease);await waitForExpiry(lease);await holder.query('COMMIT');
        assert.equal((await writing).error?.code,'ALREADY_TERMINAL');
        assert.deepEqual((await observer.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].checkpoint,{});
      }finally{await holder.query('ROLLBACK');holder.release();await writing;}
    });
  }finally{await pool.end();await observer.end();}
});
