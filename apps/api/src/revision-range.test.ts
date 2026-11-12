import { lockSyntheticAuthoringInput, quoteSyntheticAuthoringRun, syntheticAuthoringBlobs } from './test-authoring-source.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {executionKeyHash} from './observability.js';

import { isolatedTestDatabase } from './test-database.js';
const connection=await isolatedTestDatabase();
test('contract-valid revision beyond PostgreSQL integer range has owned atomic rejection evidence', {skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection});
  const first=`revision-${randomUUID()}`,second=`revision-${randomUUID()}`;
  const stagedOwner=`revision-${randomUUID()}`,queuedOwner=`revision-${randomUUID()}`,rollbackOwner=`revision-${randomUUID()}`;
  let actor:string|null=first,csrf=true;
  const settings={pool,blobs:syntheticAuthoringBlobs(),allowedOrigin:'http://bondbuddy.test',principal:async()=>actor?{userId:actor,csrfVerified:csrf}:null};
  const disabled=createServer(settings);
  const staged=createServer({...settings,enableRunStaging:true});
  const queued=createServer({...settings,enableSyntheticQueue:true});
  const send=(app:typeof disabled,url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  const count=async(table:string,owner:string)=>(await pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_user_id=$1`,[owner])).rows[0].n as number;
  const evidence=async(jobId:string,expectedEvents=2)=>{
    const events=(await pool.query('SELECT id FROM bb_observability_events WHERE job_id=$1',[jobId])).rows.map(x=>x.id);
    assert.equal(events.length,expectedEvents);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND aggregate_id=ANY($1)",[events])).rows[0].n,expectedEvents);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[jobId])).rows[0].n,0);
  };
  const hash='a'.repeat(64),wide=2147483648;
  const makeProject=async()=>{
    const response=await send(disabled,'/api/v1/projects',{name:'Synthetic revision range',kind:'update',issuer_name:null,market:null,offering:null});
    assert.equal(response.statusCode,201,response.body);
    return response.json().project_id as string;
  };
  try {
    const project=await makeProject();
    const preflight=()=>send(disabled,`/api/v1/projects/${project}/preflight`,{input_revision:wide,input_hash:hash});
    const pre=await preflight();
    assert.equal(pre.statusCode,422,pre.body);assert.equal(pre.json().code,'VALIDATION_FAILED');
    const preJob=(await pool.query("SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND request_id=$2",[first,pre.json().correlation_id])).rows[0];
    assert.equal(preJob.subtype,'preflight_rejected');assert.equal(preJob.stage,'revision_out_of_range');
    assert.equal(preJob.input_revision,null);assert.equal(preJob.input_hash,null);assert.equal(preJob.run_id,null);
    assert.equal((await pool.query('SELECT input_revision,input_hash FROM bb_operations WHERE id=$1',[preJob.operation_id])).rows[0].input_revision,null);
    await evidence(preJob.id);
    const preAgain=await preflight();
    assert.equal(preAgain.statusCode,422,preAgain.body);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2 AND subtype='preflight_rejected' AND stage='revision_out_of_range'",[first,project])).rows[0].n,2,'free preflight has no business key');

    const payload={execution_request_id:'wide\0key',project_id:project,input_revision:wide,input_hash:hash,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace'};
    const execute=(app:typeof disabled,body:Record<string,unknown>=payload)=>send(app,'/api/v1/runs/execute',body);
    const firstReject=await execute(disabled);
    assert.equal(firstReject.statusCode,422,firstReject.body);
    const replay=await execute(disabled);
    assert.equal(replay.statusCode,422,replay.body);
    const reordered=Object.fromEntries(Object.entries(payload).reverse());
    assert.equal((await execute(disabled,reordered)).statusCode,422);
    const conflict=await execute(disabled,{...payload,input_hash:'b'.repeat(64)});
    assert.equal(conflict.statusCode,409,conflict.body);
    assert.equal(conflict.json().code,'IDEMPOTENCY_CONFLICT');
    const job=(await pool.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2',[first,executionKeyHash(payload.execution_request_id)])).rows;
    assert.equal(job.length,1);assert.equal(job[0].subtype,'execute_rejected');
    assert.equal(job[0].input_revision,null);assert.equal(job[0].input_hash,null);
    assert.equal(job[0].execution_request_id,null);assert.equal(job[0].rejection_http_status,422);
    const audits=(await pool.query('SELECT request_id,error_code FROM bb_operations WHERE owner_user_id=$1 AND project_id=$2 AND operation_kind=$3 AND run_id IS NULL',[first,project,'execute'])).rows;
    assert.equal(audits.length,4);assert.equal(new Set(audits.map(x=>x.request_id)).size,4);
    await evidence(job[0].id,5);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[first])).rows[0].n,0);

    for(const [app,key,runOwner] of [[staged,'staged-wide',stagedOwner],[queued,'queued-wide',queuedOwner]] as const){
      actor=runOwner;
      const runProject=await makeProject();
      const runPayload={...payload,project_id:runProject,execution_request_id:key};
      const rejected=await execute(app,runPayload);
      assert.equal(rejected.statusCode,422,rejected.body);
      assert.equal((await execute(app,runPayload)).statusCode,422);
      const rows=(await pool.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2',[runOwner,executionKeyHash(key)])).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].input_revision,null);await evidence(rows[0].id,3);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[runOwner])).rows[0].n,0);
    }
    actor=first;
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[first])).rows[0].n,0);
    const normalKey='normal-then-wide';
    assert.equal((await execute(disabled,{...payload,execution_request_id:normalKey,input_revision:1})).statusCode,501);
    const normalConflict=await execute(disabled,{...payload,execution_request_id:normalKey});
    assert.equal(normalConflict.statusCode,409,normalConflict.body);
    const locked=await lockSyntheticAuthoringInput(disabled,project);
    assert.equal(locked.statusCode,201,locked.body);
    const quoteId=await quoteSyntheticAuthoringRun(staged,pool,first,project,locked.json());
    const runKey='run-then-wide';
    const run=await execute(staged,{...payload,execution_request_id:runKey,input_revision:1,input_hash:locked.json().input_hash,quote_id:quoteId});
    assert.equal(run.statusCode,202,run.body);
    const runConflict=await execute(staged,{...payload,execution_request_id:runKey});
    assert.equal(runConflict.statusCode,409,runConflict.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE id=$1',[run.json().run_id])).rows[0].n,1);

    actor=second;
    const ownSecond=await makeProject();
    const cross=await execute(disabled,{...payload,project_id:ownSecond});
    assert.equal(cross.statusCode,422,cross.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2',[second,executionKeyHash(payload.execution_request_id)])).rows[0].n,1);
    const foreignPre=await preflight();
    assert.equal(foreignPre.statusCode,404,foreignPre.body);
    const foreignRun=await execute(staged,{...payload,execution_request_id:'foreign-wide'});
    assert.equal(foreignRun.statusCode,404,foreignRun.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2',[second,project])).rows[0].n,0);
    for(const response of [foreignPre,foreignRun]){
      const operation=(await pool.query('SELECT project_id FROM bb_operations WHERE owner_user_id=$1 AND request_id=$2',[second,response.json().correlation_id])).rows[0];
      assert.equal(operation.project_id,null);
    }

    actor=null;
    const beforeUnauth=await count('bb_operations',first);
    const unauth=await preflight();
    assert.equal(unauth.statusCode,401);assert.equal(await count('bb_operations',first),beforeUnauth);
    actor=first;csrf=false;
    const beforeDenied=await count('bb_operations',first);
    const denied=await execute(staged,{...payload,execution_request_id:'csrf-wide'});
    assert.equal(denied.statusCode,403);assert.equal(await count('bb_operations',first),beforeDenied);
    csrf=true;

    actor=rollbackOwner;
    const rollbackProject=await makeProject();
    actor=first;
    await pool.query("CREATE FUNCTION bb_revision_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='job.state_changed' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER bb_revision_fail_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_revision_fail_outbox()');
    const before=(await pool.query('SELECT count(*)::int n FROM bb_outbox')).rows[0].n;
    const beforeFirstOperations=await count('bb_operations',first),beforeFirstJobs=await count('bb_jobs',first);
    const rolledPre=await preflight();
    actor=rollbackOwner;
    const beforeRollbackOperations=await count('bb_operations',rollbackOwner),beforeRollbackJobs=await count('bb_jobs',rollbackOwner);
    const rollbackPayload={...payload,project_id:rollbackProject,execution_request_id:'rollback-wide'};
    const rolledRun=await execute(staged,rollbackPayload);
    assert.equal(rolledPre.statusCode,500,rolledPre.body);assert.equal(rolledRun.statusCode,500,rolledRun.body);
    assert.equal(await count('bb_operations',first),beforeFirstOperations);
    assert.equal(await count('bb_jobs',first),beforeFirstJobs);
    assert.equal(await count('bb_operations',rollbackOwner),beforeRollbackOperations);
    assert.equal(await count('bb_jobs',rollbackOwner),beforeRollbackJobs);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox')).rows[0].n,before);
    await pool.query('DROP TRIGGER bb_revision_fail_outbox ON bb_outbox');
    await pool.query('DROP FUNCTION bb_revision_fail_outbox()');
    assert.equal((await execute(staged,rollbackPayload)).statusCode,422);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS bb_revision_fail_outbox ON bb_outbox');
    await pool.query('DROP FUNCTION IF EXISTS bb_revision_fail_outbox()');
    await disabled.close();await staged.close();await queued.close();await pool.end();
  }
});
