// Synthetic immutable inputs; actual PostgreSQL queue, worker resolver and write fences.
import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {uid,digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {claim,type Lease} from '@bondbuddy/api/queue';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {runPipelineOnce,type StageContext} from './run-pipeline.js';
import {recordM4Progress} from './m4-action-progress.js';
import {lockIntegrityObservation} from './integrity-browser-stage.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'worker-run-execution-consumers');
test('worker consumers resolve only the exact initial execution and reject later identities before work or writes',{skip:!connection,timeout:30000},async t=>{
  const pool=new Pool({connectionString:connection});
  async function fixture(){
    const owner=uid(),project=uid(),runId=uid(),jobId=uid(),manifest={synthetic:'worker-execution-identity',nonce:uid()},hash=inputManifestHash(manifest);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic worker identity','generation')",[project,owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,'[]','[]')`,[project,owner,hash,manifest]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,'generation',$6,'queued','queued')`,[runId,owner,project,hash,uid(),digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,'generation','default','queued','queued')`,[jobId,owner,runId]);
    return {owner,project,runId,jobId,hash};
  }
  const mutate=[
    ['hash',(lease:Lease)=>{lease.inputHash='b'.repeat(64);}],
    ['revision',(lease:Lease)=>{lease.inputRevision=2;}],
    ['successor version',(lease:Lease)=>{lease.executionVersion=2;}],
  ] as const;
  try{
    await t.test('real pipeline stage receives the resolved V1 identity',async()=>{
      const f=await fixture();let called=0;
      const outcome=await runPipelineOnce({pool,blobs:{} as PrivateBlobs,runKinds:['generation'],stages:[{name:'synthetic_identity_consumer',run:async ctx=>{
        called++;assert.equal(ctx.run.id,f.runId);assert.deepEqual({executionVersion:ctx.lease.executionVersion,inputRevision:ctx.lease.inputRevision,inputHash:ctx.lease.inputHash},{executionVersion:1,inputRevision:1,inputHash:f.hash});
        const resolved=ctx.run as StageContext['run']&{executionVersion:number;inputRevision:number;inputHash:string};
        assert.deepEqual({executionVersion:resolved.executionVersion,inputRevision:resolved.inputRevision,inputHash:resolved.inputHash},{executionVersion:1,inputRevision:1,inputHash:f.hash});
        return {kind:'stopped'};
      }}]});assert.equal(outcome,'stopped');assert.equal(called,1);
    });
    for(const [name,change] of mutate)await t.test(`pipeline rejects wrong ${name} at resolution before entering any stage`,async()=>{
      const f=await fixture();let called=0;const diagnostics:Array<{stage:string|null;code:string|null}>=[];
      // The pipeline's existing infrastructure-error handler reports the conflict
      // and returns retry; its rejected lease cannot release or mutate this run.
      assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,runKinds:['generation'],onLease:lease=>{if(lease){assert.equal(lease.runId,f.runId);change(lease);}},onUnexpectedError:error=>diagnostics.push(error),
        stages:[{name:'must_not_begin',run:async()=>{called++;return {kind:'stopped'};}}]}),'retry');
      assert.equal(called,0);assert.deepEqual(diagnostics.map(({stage,code})=>({stage,code})),[{stage:null,code:'INPUT_REVISION_CONFLICT'}]);
      assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.jobId])).rows[0].checkpoint,{});
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[f.jobId])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE run_id=$1',[f.runId])).rows[0].n,0);
    });
    await t.test('independent M4/integrity writers fence the supplied identity without changing durable state',async()=>{
      const f=await fixture(),lease=await claim(pool,60,{runKinds:['generation']});assert.ok(lease);assert.equal(lease.runId,f.runId);
      const run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[f.runId])).rows[0];
      const ctx={pool,run,lease,signal:new AbortController().signal} as StageContext;
      const snapshot=async()=>({run:(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[f.runId])).rows,events:(await pool.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq',[f.runId])).rows,outbox:(await pool.query('SELECT * FROM bb_outbox WHERE owner_user_id=$1 ORDER BY id',[f.owner])).rows});
      const before=await snapshot();
      for(const [,change] of mutate){const original={...lease};change(lease);
        await assert.rejects(recordM4Progress(ctx,'m4_reading_materials'),{code:'INPUT_REVISION_CONFLICT'});
        await assert.rejects(transaction(pool,client=>lockIntegrityObservation(client,ctx)),{code:'INPUT_REVISION_CONFLICT'});
        assert.deepEqual(await snapshot(),before);Object.assign(lease,original);
      }
      await recordM4Progress(ctx,'m4_reading_materials');
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND type='run.progress'",[f.runId])).rows[0].n,1);
      await assert.rejects(pool.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
        VALUES($1,$2,$3,2,1,$4)`,[f.owner,f.project,f.runId,f.hash]),{code:'23514'});
    });
  }finally{await pool.end();}
});
