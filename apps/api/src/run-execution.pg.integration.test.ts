// Synthetic PostgreSQL execution-identity regression. No material bytes, worker or supplier.
// Uses only the migrated private database clone; production V1 constraints remain enabled.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {digest,transaction} from './data.js';
import {grantCredits} from './billing.js';
import {assertRunExecution,resolveRunExecution,readExecutionStages,type RunExecutionIdentity} from './run-execution.js';
import {action,beginRunStage,checkpoint,checkpointStage,claim,finish,pauseAtCheckpoint,pauseRun,
  recordAuthoringActivity,recordPotentialCall,recordReviewAction,releaseLease,renew,upgradeStageCheckpoint,type Lease} from './queue.js';

const connection=await isolatedTestDatabase(undefined,'run-execution-identity');
const mismatch={status:409,code:'INPUT_REVISION_CONFLICT'};
type Row=Record<string,unknown>;
type Db=Pick<Pool,'query'>;
type Fixture={owner:string;projectId:string;runId:string;jobId:string;hash:string;lease:Lease};

/** Real queue APIs own a transaction. Map that transaction to a real PG savepoint
 * while corruption is visible only inside this client's outer rollback transaction.
 * No SQL result is mocked and no inner COMMIT can publish the deliberate missing row. */
function savepointPool(client:PoolClient):Pool{
  let next=0;
  return {
    query:client.query.bind(client),
    connect:async()=>{
      const name=`execution_identity_call_${++next}`;
      return {
        query:async(sql:string,values?:unknown[])=>{
          if(sql==='BEGIN')return client.query(`SAVEPOINT ${name}`);
          if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${name}`);
          if(sql==='ROLLBACK'){
            await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
            return client.query(`RELEASE SAVEPOINT ${name}`);
          }
          return client.query(sql,values);
        },
        release:()=>{},
      };
    },
  } as unknown as Pool;
}

test('initial execution identity is automatic, immutable, exact and enforced at queue/input boundaries',
  {skip:!connection,timeout:120000},async t=>{
  const pool=new Pool({connectionString:connection,max:4});
  async function fixture(state:'queued'|'running'|'paused'='paused'):Promise<Fixture>{
    const owner=`execution-owner-${randomUUID()}`,projectId=randomUUID(),runId=randomUUID(),jobId=randomUUID(),token=randomUUID();
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`execution_${randomUUID().replaceAll('-','').slice(0,16)}`]);
    await transaction(pool,client=>grantCredits(client,{owner,points:10000,key:`synthetic-${randomUUID()}`,source:'existing_grant',expiresAt:null,actor:'synthetic-test',reason:'Nonempty execution identity regression ledger'}));
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic exact execution origin','update')",[projectId,owner]);
    const hashes=new Map<number,string>();
    for(const revision of [1,2,3]){
      const manifest={synthetic:true,projectId,revision},hash=digest(JSON.stringify(manifest));hashes.set(revision,hash);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,1,$4,$5,'[]','[]')`,[projectId,revision,owner,hash,manifest]);
    }
    // The run deliberately uses neither revision 1 nor the project's newest revision.
    await pool.query('UPDATE bb_projects SET latest_input_revision=3 WHERE id=$1',[projectId]);
    const hash=hashes.get(2)!;
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,created_at)
      VALUES($1,$2,$3,2,$4,$5,'update',$6,$7,$8,'2026-10-26T00:00:00Z')`,
    [runId,owner,projectId,hash,`synthetic-execution-${randomUUID()}`,digest(randomUUID()),state,state==='running'?'model_generation':state==='paused'?'user_paused':'queued']);
    const checkpoint={synthetic_original:true,stages:{existing_stage:{saved:'original immutable-input work'}}};
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts,user_pause_requested,checkpoint)
      VALUES($1,$2,$3,'update','default',$4,$5,$6,CASE WHEN $4='running' THEN now()+interval '10 minutes' ELSE NULL END,$7,$8,$9)`,
    [jobId,owner,runId,state,state==='running'?'model_generation':state==='paused'?'user_paused':'queued',state==='running'?token:null,state==='running'?1:0,state==='paused',checkpoint]);
    await pool.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
      VALUES($1,$2,$3,1,$3,'run.progress',$4,$5,$6)`,
    [randomUUID(),owner,runId,state,state==='running'?'model_generation':state==='paused'?'user_paused':'queued',{reason:'synthetic_original_work'}]);
    await pool.query('UPDATE bb_runs SET event_cursor=1 WHERE id=$1',[runId]);
    await pool.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'run',$3,'run.synthetic_original_work',$4)`,[randomUUID(),owner,runId,{synthetic:true,run_id:runId}]);
    return {owner,projectId,runId,jobId,hash,lease:{owner,runId,jobId,token,checkpoint,attempts:state==='running'?1:0,executionVersion:1,inputRevision:2,inputHash:hash}};
  }
  async function row(db:Db,f:Fixture){
    const result=await db.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[f.owner,f.runId]);
    assert.equal(result.rows.length,1);return result.rows[0];
  }
  async function versions(db:Db,f:Fixture){
    return (await db.query('SELECT * FROM bb_run_execution_versions WHERE run_id=$1 ORDER BY execution_version',[f.runId])).rows;
  }
  async function snapshot(db:Db,f:Fixture){
    const result:Record<string,Row[]>={};
    for(const [name,sql] of [
      ['runs','SELECT * FROM bb_runs WHERE owner_user_id=$1 ORDER BY id'],
      ['jobs','SELECT * FROM bb_jobs WHERE owner_user_id=$1 ORDER BY id'],
      ['projects','SELECT * FROM bb_projects WHERE owner_user_id=$1 ORDER BY id'],
      ['inputs','SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 ORDER BY project_id,revision'],
      ['executions','SELECT * FROM bb_run_execution_versions WHERE owner_user_id=$1 ORDER BY run_id,execution_version'],
      ['events','SELECT * FROM bb_run_events WHERE owner_user_id=$1 ORDER BY run_id,seq'],
      ['outbox','SELECT * FROM bb_outbox WHERE owner_user_id=$1 ORDER BY id'],
      ['attempts','SELECT * FROM bb_model_call_attempts WHERE owner_user_id=$1 ORDER BY id'],
      ['prompts','SELECT * FROM bb_snapshot_refs WHERE owner_user_id=$1 ORDER BY id'],
      ['providerResults','SELECT * FROM bb_provider_result_refs WHERE owner_user_id=$1 ORDER BY id'],
      ['providerObservations','SELECT * FROM bb_provider_call_observations WHERE owner_user_id=$1 ORDER BY id'],
      ['runtime','SELECT * FROM bb_model_call_attempt_runtime WHERE owner_user_id=$1 ORDER BY attempt_id'],
      ['progress','SELECT * FROM bb_authoring_progress WHERE owner_user_id=$1 ORDER BY run_id'],
      ['creditAccount','SELECT * FROM bb_credit_accounts WHERE owner_user_id=$1'],
      ['creditLots','SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id'],
      ['creditReservations','SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id'],
      ['creditEvents','SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id'],
      ['observability','SELECT * FROM bb_observability_events WHERE owner_user_id=$1 ORDER BY id'],
    ])result[name!]=(await db.query(sql!,[f.owner])).rows;
    // Wrong identity is a business conflict, not an evidence-storage outage.
    result.evidenceGate=(await db.query('SELECT * FROM bb_evidence_gate_events ORDER BY seq')).rows;
    result.alerts=(await db.query('SELECT * FROM bb_ops_alerts ORDER BY id')).rows;
    return result;
  }
  const writes:Array<[string,(db:Pool,lease:Lease)=>Promise<unknown>]>=[
    ['renew', (db,lease)=>renew(db,lease,600)],
    ['begin stage',(db,lease)=>beginRunStage(db,lease,'model_generation')],
    ['replace checkpoint',(db,lease)=>checkpoint(db,lease,'model_generation',{unexpected:'must not write'})],
    ['stage checkpoint',(db,lease)=>checkpointStage(db,lease,'model_generation',{unexpected:'must not write'})],
    ['upgrade checkpoint',(db,lease)=>upgradeStageCheckpoint(db,lease,'existing_stage',{unexpected:'must not replace prior work'})],
    ['pause at checkpoint',(db,lease)=>pauseAtCheckpoint(db,lease)],
    ['pause run',(db,lease)=>pauseRun(db,lease,'awaiting_materials','synthetic_wrong_execution')],
    ['authoring activity',(db,lease)=>recordAuthoringActivity(db,lease,{activity_id:'a'.repeat(64),code:'read_materials',state:'started'})],
    ['review activity',(db,lease)=>recordReviewAction(db,lease,{version:'review-action-v1',action_id:'b'.repeat(64),code:'read_materials',state:'started'})],
    ['provider intent',(db,lease)=>recordPotentialCall(db,lease,'synthetic-execution-call',1,{callId:randomUUID(),modelId:'synthetic-model'})],
    ['failure finish',(db,lease)=>finish(db,lease,'failed',{errorCode:'DATA_UNAVAILABLE',failedStage:'model_generation'})],
  ];
  try{
    await t.test('every inserted run automatically receives one immutable V1 for the exact original input',async()=>{
      const f=await fixture(),original=await row(pool,f),initial=await versions(pool,f);
      assert.equal(initial.length,1);
      assert.deepEqual(initial[0],{owner_user_id:f.owner,project_id:f.projectId,run_id:f.runId,execution_version:1,input_revision:2,input_hash:f.hash,created_at:original.created_at});
      assert.equal((await pool.query('SELECT latest_input_revision FROM bb_projects WHERE id=$1',[f.projectId])).rows[0].latest_input_revision,3);
      const foreign=await fixture();
      const insert=`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
        VALUES($1,$2,$3,$4,$5,$6)`;
      const before=await snapshot(pool,f);
      for(const [label,values] of [
        ['different hash',[f.owner,f.projectId,f.runId,1,2,'f'.repeat(64)]],
        ['different revision',[f.owner,f.projectId,f.runId,1,3,f.hash]],
        ['different project',[f.owner,foreign.projectId,f.runId,1,2,f.hash]],
        ['different owner',[foreign.owner,f.projectId,f.runId,1,2,f.hash]],
      ] as const){
        await assert.rejects(pool.query(insert,[...values]),{code:'23514',constraint:'bb_initial_execution_origin'},label);
        assert.deepEqual(await snapshot(pool,f),before,label);
      }
      await assert.rejects(pool.query(insert,[f.owner,f.projectId,f.runId,2,2,f.hash]),{code:'23514'},'Production CHECK permits only V1; this test never relaxes it');
      await assert.rejects(pool.query(insert,[f.owner,f.projectId,f.runId,1,2,f.hash]),{code:'23505'},'The automatic initial identity cannot be duplicated');
      for(const sql of [
        'UPDATE bb_run_execution_versions SET input_hash=input_hash WHERE run_id=$1',
        'UPDATE bb_run_execution_versions SET input_revision=3 WHERE run_id=$1',
        'DELETE FROM bb_run_execution_versions WHERE run_id=$1',
      ]){
        await assert.rejects(pool.query(sql,[f.runId]),{code:'23514',constraint:'bb_run_execution_immutable'});
        assert.deepEqual(await snapshot(pool,f),before,'Rejected changes leave the entire existing state exact');
      }
      assert.deepEqual(await versions(pool,f),initial);
    });

    await t.test('claim carries V1/revision/hash and the resolver reads the original input rather than the latest project draft',async()=>{
      const f=await fixture('queued'),initial=await versions(pool,f),lease=await claim(pool,600,{runKinds:['update']});
      assert.ok(lease);assert.equal(lease.runId,f.runId);assert.equal(lease.jobId,f.jobId);assert.equal(lease.owner,f.owner);
      assert.deepEqual({executionVersion:lease.executionVersion,inputRevision:lease.inputRevision,inputHash:lease.inputHash},{executionVersion:1,inputRevision:2,inputHash:f.hash});
      assert.equal(lease.attempts,1);assert.ok(lease.token);assert.deepEqual(lease.checkpoint,f.lease.checkpoint);
      const resolved=await resolveRunExecution(pool,f.owner,f.runId,lease);
      assert.equal(resolved.id,f.runId);assert.equal(resolved.owner_user_id,f.owner);assert.equal(resolved.project_id,f.projectId);
      assert.equal(resolved.input_revision,2);assert.equal(resolved.input_hash.trim(),f.hash);
      assert.deepEqual(await assertRunExecution(pool,await row(pool,f),lease),{executionVersion:1,inputRevision:2,inputHash:f.hash});
      assert.deepEqual(await versions(pool,f),initial,'Claim and resolution do not rewrite execution origin');
      await assert.rejects(resolveRunExecution(pool,`foreign-${randomUUID()}`,f.runId,lease),{code:'NOT_FOUND'});
      await assert.rejects(resolveRunExecution(pool,f.owner,f.runId,undefined as unknown as RunExecutionIdentity),mismatch);
      await checkpointStage(pool,lease,'identity_control',{execution_version:1,input_revision:2,input_hash:f.hash});
      const saved=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.jobId])).rows[0].checkpoint;
      assert.deepEqual(saved.stages.identity_control,{execution_version:1,input_revision:2,input_hash:f.hash});
      await action(pool,f.owner,f.runId,'pause');assert.equal(await pauseAtCheckpoint(pool,lease),true);
    });

    await t.test('same live token with wrong version, revision or hash cannot mutate any queue/evidence/accounting state',async()=>{
      const f=await fixture('running'),before=await snapshot(pool,f);
      assert.ok(before.events!.length>0&&before.outbox!.length>0&&before.creditEvents!.length>0&&before.creditLots!.length>0);
      const variants:Lease[]=[{...f.lease,executionVersion:2},{...f.lease,inputRevision:3},{...f.lease,inputHash:'e'.repeat(64)}];
      for(const lease of variants){
        assert.equal(lease.token,f.lease.token,'Only execution identity changes; the owner/job/run/token remain valid');
        await assert.rejects(resolveRunExecution(pool,f.owner,f.runId,lease),mismatch);
        await assert.rejects(assertRunExecution(pool,await row(pool,f),lease),mismatch);
        for(const [name,write] of writes){
          await assert.rejects(write(pool,lease),mismatch,name);
          assert.deepEqual(await snapshot(pool,f),before,`${name}: rejected identity cannot change existing state`);
        }
        // Best-effort lease release intentionally returns without throwing; it must still do nothing.
        await releaseLease(pool,lease,'synthetic_wrong_execution');assert.deepEqual(await snapshot(pool,f),before,'Wrong execution cannot release the valid token');
      }
      await renew(pool,f.lease,600);
      await checkpointStage(pool,f.lease,'identity_control',{accepted:true});
      assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.jobId])).rows[0].checkpoint.stages.identity_control,{accepted:true},'The unmodified identity remains usable');
      await action(pool,f.owner,f.runId,'pause');assert.equal(await pauseAtCheckpoint(pool,f.lease),true);
    });

    await t.test('stage writes stamp the exact input and generic progress preserves saved work and reconciliation history',async()=>{
      const f=await fixture('running');
      const history={...f.lease.checkpoint,provider_results:[],operator_reconciliations:{'historical-attempt':{decision:'confirmed_not_sent'}}};
      await pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,history]);
      await checkpointStage(pool,f.lease,'identity_control',{accepted:true});
      await upgradeStageCheckpoint(pool,f.lease,'identity_control',{accepted:true,upgraded:true});
      await checkpoint(pool,f.lease,'synthetic_progress',{step:'saved'});
      const saved=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.jobId])).rows[0].checkpoint;
      assert.deepEqual(saved.stage_execution,{execution_version:1,input_revision:2,input_hash:f.hash});
      assert.deepEqual(readExecutionStages(saved,f.lease),{existing_stage:{saved:'original immutable-input work'},identity_control:{accepted:true,upgraded:true}});
      assert.deepEqual(saved.provider_results,history.provider_results);
      assert.deepEqual(saved.operator_reconciliations,history.operator_reconciliations);
      const before=await snapshot(pool,f);
      await assert.rejects(checkpoint(pool,f.lease,'synthetic_progress',{provider_results:[{call_id:'invented'}]}),mismatch);
      assert.deepEqual(await snapshot(pool,f),before);
      await action(pool,f.owner,f.runId,'pause');assert.equal(await pauseAtCheckpoint(pool,f.lease),true);
    });

    await t.test('a foreign stage stamp blocks claim, saved-work writes and resume without being repaired',async()=>{
      const f=await fixture('running');
      const foreign={...f.lease.checkpoint,stage_execution:{execution_version:2,input_revision:3,input_hash:'e'.repeat(64)}};
      await pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,foreign]);
      const before=await snapshot(pool,f);
      for(const [name,write] of writes){
        await assert.rejects(write(pool,f.lease),mismatch,name);
        assert.deepEqual(await snapshot(pool,f),before,name);
      }
      // Cancellation/pause remain available even when saved work is not readable.
      await action(pool,f.owner,f.runId,'pause');
      await pool.query("UPDATE bb_runs SET state='paused',stage='user_paused' WHERE id=$1",[f.runId]);
      await pool.query("UPDATE bb_jobs SET state='paused',stage='user_paused',lease_token=NULL,lease_until=NULL WHERE id=$1",[f.jobId]);
      const paused=await snapshot(pool,f);
      await assert.rejects(action(pool,f.owner,f.runId,'resume'),mismatch);
      assert.deepEqual(await snapshot(pool,f),paused);
      await pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,f.lease.checkpoint]);
      const queued=await fixture('queued');
      await pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[queued.jobId,foreign]);
      const queuedBefore=await snapshot(pool,queued);
      await assert.rejects(claim(pool,600,{runKinds:['update']}),mismatch);
      assert.deepEqual(await snapshot(pool,queued),queuedBefore);
      await action(pool,queued.owner,queued.runId,'pause');
    });

    await t.test('missing execution identity fails closed in claim, resolver and queue writes without repairing or publishing state',async()=>{
      const queued=await fixture('queued'),running=await fixture('running');
      const originalQueued=await snapshot(pool,queued),originalRunning=await snapshot(pool,running),client=await pool.connect();
      try{
        await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='10s'");
        // Deliberate corruption is local to this transaction and fully rolled back.
        // No CHECK, origin trigger or production version policy is disabled.
        await client.query('ALTER TABLE bb_run_execution_versions DISABLE TRIGGER bb_run_execution_immutable');
        await client.query('DELETE FROM bb_run_execution_versions WHERE run_id=ANY($1::text[])',[[queued.runId,running.runId]]);
        await client.query('ALTER TABLE bb_run_execution_versions ENABLE TRIGGER bb_run_execution_immutable');
        const scoped=savepointPool(client),missingQueued=await snapshot(client,queued),missingRunning=await snapshot(client,running);
        assert.equal(missingQueued.executions!.length,0);assert.equal(missingRunning.executions!.length,0);
        await assert.rejects(assertRunExecution(client,await row(client,queued),queued.lease),mismatch);
        await assert.rejects(resolveRunExecution(client,queued.owner,queued.runId,queued.lease),mismatch);
        await assert.rejects(resolveRunExecution(client,running.owner,running.runId,running.lease),mismatch);
        await assert.rejects(claim(scoped,600,{runKinds:['update']}),mismatch,'A queued run without identity cannot be claimed or silently given V1');
        assert.deepEqual(await snapshot(client,queued),missingQueued);
        for(const [name,write] of writes){
          await assert.rejects(write(scoped,running.lease),mismatch,name);
          assert.deepEqual(await snapshot(client,running),missingRunning,`${name}: missing identity is never a fallback to the original run fields`);
        }
        await releaseLease(scoped,running.lease);assert.deepEqual(await snapshot(client,running),missingRunning);
        assert.equal((await versions(client,queued)).length,0);assert.equal((await versions(client,running)).length,0,'Resolvers and writes never repair missing immutable identity');
      }finally{await client.query('ROLLBACK');client.release();}
      assert.deepEqual(await snapshot(pool,queued),originalQueued,'Rollback restores the automatic identity and its exact existing state');
      assert.deepEqual(await snapshot(pool,running),originalRunning);
      assert.deepEqual(await assertRunExecution(pool,await row(pool,running),running.lease),{executionVersion:1,inputRevision:2,inputHash:running.hash});
      // Prove immutability was restored, including after the deliberate-corruption exercise.
      await assert.rejects(pool.query('DELETE FROM bb_run_execution_versions WHERE run_id=$1',[running.runId]),{code:'23514',constraint:'bb_run_execution_immutable'});
    });
  }finally{await pool.end();}
});
