// Synthetic immutable inputs; actual PostgreSQL queue, worker resolver and write fences.
import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {uid,digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {claim,type Lease} from '@bondbuddy/api/queue';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import { resolveRunExecution } from '@bondbuddy/api/run-execution';
import {runPipelineOnce,codexModelStage,type StageContext} from './run-pipeline.js';
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
    return {owner,project,runId,jobId,hash,manifest};
  }
  const mutate=[
    ['hash',(lease:Lease)=>{lease.inputHash='b'.repeat(64);}],
    ['revision',(lease:Lease)=>{lease.inputRevision=2;}],
    ['successor version',(lease:Lease)=>{lease.executionVersion=2;}],
  ] as const;
  try{
    await t.test('real pipeline stage receives the resolved V1 identity',async()=>{
      const f=await fixture();let called=0;
      const origin=(await pool.query('SELECT input_revision,input_hash,execution_request_id,request_hash FROM bb_runs WHERE id=$1',[f.runId])).rows[0];
      const latest={...f.manifest,synthetic:'later-project-input',nonce:uid()},latestHash=inputManifestHash(latest);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,2,$3,$4,'[]','[]')`,[f.project,f.owner,latestHash,latest]);
      await pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1',[f.project]);
      const outcome=await runPipelineOnce({pool,blobs:{} as PrivateBlobs,runKinds:['generation'],stages:[{name:'synthetic_identity_consumer',run:async ctx=>{
        called++;assert.equal(ctx.run.id,f.runId);assert.deepEqual({executionVersion:ctx.lease.executionVersion,inputRevision:ctx.lease.inputRevision,inputHash:ctx.lease.inputHash},{executionVersion:1,inputRevision:1,inputHash:f.hash});
        const resolved=ctx.run;
        assert.deepEqual({executionVersion:resolved.executionVersion,inputRevision:resolved.inputRevision,inputHash:resolved.inputHash},{executionVersion:1,inputRevision:1,inputHash:f.hash});
        assert.deepEqual(resolved.originInput,{inputRevision:1,inputHash:f.hash});
        assert.equal(resolved.input_revision,resolved.inputRevision);assert.equal(resolved.input_hash,resolved.inputHash);
        assert.equal(Object.isFrozen(resolved),true);assert.equal(Object.isFrozen(resolved.originInput),true);
        const actual=(await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
          [resolved.owner_user_id,resolved.project_id,resolved.input_revision])).rows[0];
        assert.deepEqual(actual.manifest,f.manifest);assert.equal(actual.input_hash.trim(),f.hash);assert.notDeepEqual(actual.manifest,latest);
        return {kind:'stopped'};
      }}]});assert.equal(outcome,'stopped');assert.equal(called,1);
      assert.deepEqual((await pool.query('SELECT input_revision,input_hash,execution_request_id,request_hash FROM bb_runs WHERE id=$1',[f.runId])).rows[0],origin);
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
      const run=await resolveRunExecution(pool,f.owner,f.runId,lease);
      const ctx:StageContext={pool,blobs:{} as PrivateBlobs,run,lease,signal:new AbortController().signal,checkpoint:{},values:new Map()};
      const snapshot=async()=>({run:(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[f.runId])).rows,events:(await pool.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq',[f.runId])).rows,outbox:(await pool.query('SELECT * FROM bb_outbox WHERE owner_user_id=$1 ORDER BY id',[f.owner])).rows});
      const before=await snapshot();
      for(const [,change] of mutate){const original={...lease};change(lease);
        await assert.rejects(recordM4Progress(ctx,'m4_reading_materials'),{code:'INPUT_REVISION_CONFLICT'});
        await assert.rejects(transaction(pool,client=>lockIntegrityObservation(client,ctx)),{code:'INPUT_REVISION_CONFLICT'});
        assert.deepEqual(await snapshot(),before);Object.assign(lease,original);
      }
      const unbranded={id:run.id,owner_user_id:run.owner_user_id,project_id:run.project_id,task_kind:run.task_kind,
        input_revision:run.input_revision,input_hash:run.input_hash,executionVersion:run.executionVersion,
        inputRevision:run.inputRevision,inputHash:run.inputHash,originInput:{...run.originInput}} as unknown as StageContext['run'];
      const forged:[StageContext['run'],boolean][]=[
        [{...run,originInput:{...run.originInput,inputRevision:2}},true],
        [{...run,input_revision:2},false],
        [unbranded,false],
      ];
      for(const [invalidRun,leaseLost] of forged){
        const invalid={...ctx,run:invalidRun};
        if(leaseLost){
          await recordM4Progress(invalid,'m4_reading_materials');
          await assert.rejects(transaction(pool,client=>lockIntegrityObservation(client,invalid)),/WORKER_LEASE_LOST/);
        }else{
          await assert.rejects(recordM4Progress(invalid,'m4_reading_materials'),{code:'INPUT_REVISION_CONFLICT'});
          await assert.rejects(transaction(pool,client=>lockIntegrityObservation(client,invalid)),{code:'INPUT_REVISION_CONFLICT'});
        }
        assert.deepEqual(await snapshot(),before,'forged origin or conflicting aliases cannot write progress/history');
      }
      await recordM4Progress(ctx,'m4_reading_materials');
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND type='run.progress'",[f.runId])).rows[0].n,1);
      await assert.rejects(pool.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
        VALUES($1,$2,$3,2,1,$4)`,[f.owner,f.project,f.runId,f.hash]),{code:'23514'});
    });
    await t.test('a saved prompt from another input or snapshot kind is rejected before reading bytes or entering the adapter',async()=>{
      const f=await fixture(),lease=await claim(pool,60,{runKinds:['generation']});assert.ok(lease);assert.equal(lease.runId,f.runId);
      const run=await resolveRunExecution(pool,f.owner,f.runId,lease);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,1,$3,'{}','[]','[]')`,[f.project,f.owner,f.hash]);
      let reads=0,calls=0;
      const blobs={getIfExists:async()=>{reads++;throw Error('Foreign prompt bytes must not be read');}} as unknown as PrivateBlobs;
      const stage=codexModelStage({name:'model_generation',logicalCallId:'synthetic-scope',config:()=>{calls++;throw Error('Foreign prompt must not reach adapter');},
        buildPrompt:async()=>{throw Error('An existing prompt is never silently rebuilt');},schema:{type:'object'},validate:()=>true,resultSchemaVersion:'synthetic-v1'});
      for(const [index,kind,revision,hash] of [[1,'user_prompt',1,f.hash],[2,'model_request',2,f.hash],[3,'model_request',1,'c'.repeat(64)]] as const){
        const snapshot=uid();
        await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthetic-v1',$9,$10)`,[snapshot,f.owner,f.project,f.runId,kind,index,`users/${f.owner}/projects/${f.project}/snapshots/${snapshot}`,digest('synthetic-private-prompt'),revision,hash]);
        const ctx={pool,blobs,lease,run,signal:new AbortController().signal,checkpoint:{model_generation_prompt:{snapshot_id:snapshot}},values:new Map()} as StageContext;
        assert.deepEqual(await stage.run(ctx),{kind:'fail',code:'DATA_UNAVAILABLE'});
      }
      assert.equal(reads,0);assert.equal(calls,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[f.jobId])).rows[0].n,0);
    });
    await t.test('the actual pipeline refuses another execution stage set before skipping or starting any work',async()=>{
      const f=await fixture();let calls=0;
      await pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,{stage_execution:{execution_version:2,input_revision:2,input_hash:'e'.repeat(64)},stages:{model_generation:{completed:true}}}]);
      const before=(await pool.query('SELECT * FROM bb_jobs WHERE id=$1',[f.jobId])).rows[0];
      await assert.rejects(runPipelineOnce({pool,blobs:{} as PrivateBlobs,runKinds:['generation'],stages:[{name:'model_generation',run:async()=>{calls++;return {kind:'stopped'};}}]}),{code:'INPUT_REVISION_CONFLICT'});
      assert.equal(calls,0);assert.deepEqual((await pool.query('SELECT * FROM bb_jobs WHERE id=$1',[f.jobId])).rows[0],before);
    });
  }finally{await pool.end();}
});
