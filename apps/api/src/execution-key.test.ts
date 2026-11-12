import { lockSyntheticAuthoringInput, quoteSyntheticAuthoringRun, syntheticAuthoringBlobs } from './test-authoring-source.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {canonical,digest,executionKeyStorage,uid} from './data.js';
import {executionKeyHash} from './observability.js';

import { isolatedTestDatabase } from './test-database.js';
const connection=await isolatedTestDatabase();
test('PostgreSQL execute keys preserve JS identity, legacy replay, owner isolation and atomic outbox', {skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection});
  const first=`execution-${randomUUID()}`,second=`execution-${randomUUID()}`;
  let actor:string|null=first;
  const app=createServer({pool,blobs:syntheticAuthoringBlobs(),allowedOrigin:'http://bondbuddy.test',principal:async()=>actor?{userId:actor,csrfVerified:true}:null,enableRunStaging:true});
  const send=(method:'GET'|'POST',url:string,payload?:unknown)=>app.inject({method,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  const makeProject=async()=>{
    const project=(await send('POST','/api/v1/projects',{name:'Synthetic key test',kind:'update',issuer_name:null,market:null,offering:null})).json().project_id as string;
    const input=(await lockSyntheticAuthoringInput(app,project)).json();
    return {project,input};
  };
  try {
    const {project,input}=await makeProject();
    const fields={project_id:project,input_revision:1,input_hash:input.input_hash as string,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace',quote_id:undefined as string|undefined};
    const execute=(key:string,changes:Record<string,unknown>={})=>send('POST','/api/v1/runs/execute',{execution_request_id:key,...fields,...changes});
    // Independent new executions need independent current scopes; exact-key retries below reuse one body.
    const prepareScope=async(label:string)=>{
      const current=await send('GET',`/api/v1/projects/${project}`);
      assert.equal(current.statusCode,200,current.body);
      const edited=await app.inject({method:'PATCH',url:`/api/v1/projects/${project}`,
        headers:{origin:'http://bondbuddy.test','if-match':String(current.json().draft_revision)},
        payload:{name:'Synthetic key test '+label}});
      assert.equal(edited.statusCode,200,edited.body);
      const versions=await send('GET',`/api/v1/projects/${project}/prospectus-versions`);
      assert.equal(versions.statusCode,200,versions.body);
      const locked=await send('POST',`/api/v1/projects/${project}/input-revisions`,{
        draft_revision:edited.json().draft_revision,prospectus_selection_revision:versions.json().selection_revision,
        material_versions:input.material_versions,requirement_message_ids:[]});
      assert.equal(locked.statusCode,201,locked.body);
      const next=locked.json(),quoteId=await quoteSyntheticAuthoringRun(app,pool,first,project,next);
      assert.notEqual(next.input_hash,fields.input_hash,'a distinct execution locks its own current scope');
      assert.notEqual(quoteId,fields.quote_id,'a new business scope has its own unused quote');
      fields.input_revision=next.input_revision;fields.input_hash=next.input_hash;fields.quote_id=quoteId;
    };

    // A pre-existing run stores the contract key in its original PostgreSQL text column.
    const legacyKey='legacy.key-1',legacyRun=uid();
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'update',$6,'paused')",[legacyRun,first,project,input.input_hash,legacyKey,digest(canonical(fields))]);
    const legacyReplay=await execute(legacyKey);
    assert.equal(legacyReplay.statusCode,202,legacyReplay.body);
    assert.equal(legacyReplay.json().run_id,legacyRun);
    assert.equal(legacyReplay.json().execution_request_id,legacyKey);

    // Legacy replay above preserves its original request hash without a quote.
    fields.quote_id=await quoteSyntheticAuthoringRun(app,pool,first,project,input);
    const ordinaryKey='ordinary.key-1';
    const ordinary=await execute(ordinaryKey);
    assert.equal(ordinary.statusCode,202,ordinary.body);
    assert.equal((await execute(ordinaryKey)).json().run_id,ordinary.json().run_id);
    assert.equal((await pool.query('SELECT execution_request_id FROM bb_runs WHERE id=$1',[ordinary.json().run_id])).rows[0].execution_request_id,ordinaryKey);

    const disabled=createServer({pool,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:first,csrfVerified:true})});
    try {
      const rejectedKey='disabled\0key',payload={execution_request_id:rejectedKey,...fields};
      const reject=()=>disabled.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin:'http://bondbuddy.test'},payload});
      assert.equal((await reject()).statusCode,501);
      assert.equal((await reject()).statusCode,501);
      const rejected=(await pool.query("SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2",[first,executionKeyHash(rejectedKey)])).rows;
      assert.equal(rejected.length,1);assert.equal(rejected[0].execution_request_id,null);
      assert.equal((await execute(rejectedKey,{input_hash:'f'.repeat(64)})).statusCode,409);
    } finally {await disabled.close();}

    await prepareScope('NUL key');
    const nulKey='opaque\0key';
    const concurrent=await Promise.all(Array.from({length:5},()=>execute(nulKey)));
    assert.ok(concurrent.every(r=>r.statusCode===202),concurrent.map(r=>r.body).join('\n'));
    const nulRun=concurrent[0].json().run_id as string;
    assert.ok(concurrent.every(r=>r.json().run_id===nulRun&&r.json().execution_request_id===nulKey));
    const stored=(await pool.query('SELECT execution_request_id FROM bb_runs WHERE id=$1',[nulRun])).rows[0].execution_request_id as string;
    assert.equal(stored,executionKeyStorage(nulKey));
    assert.ok(!stored.includes('\0'));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[first,stored])).rows[0].n,1);
    assert.equal((await send('GET',`/api/v1/runs/${nulRun}`)).json().execution_request_id,nulKey);
    const changed=await execute(nulKey,{input_hash:'f'.repeat(64)});
    assert.equal(changed.statusCode,409,changed.body);
    assert.equal(changed.json().code,'IDEMPOTENCY_CONFLICT');

    const lone='\ud800',replacement='\ufffd';
    await prepareScope('lone surrogate key');
    const loneResult=await execute(lone);
    await prepareScope('replacement key');
    const replacementResult=await execute(replacement);
    assert.equal(loneResult.statusCode,202,loneResult.body);
    assert.equal(replacementResult.statusCode,202,replacementResult.body);
    assert.notEqual(loneResult.json().run_id,replacementResult.json().run_id);
    assert.equal(loneResult.json().execution_request_id,lone);
    assert.equal(replacementResult.json().execution_request_id,replacement);
    assert.notEqual(executionKeyStorage(lone),executionKeyStorage(replacement));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type=$1 AND event_type=$2 AND aggregate_id=ANY($3)', ['run','run.staged',[nulRun,loneResult.json().run_id,replacementResult.json().run_id]])).rows[0].n,3);

    actor=second;
    const other=await makeProject();
    const otherQuote=await quoteSyntheticAuthoringRun(app,pool,second,other.project,other.input);
    const otherRun=await execute(nulKey,{project_id:other.project,input_revision:other.input.input_revision,input_hash:other.input.input_hash,quote_id:otherQuote});
    assert.equal(otherRun.statusCode,202,otherRun.body);
    assert.notEqual(otherRun.json().run_id,nulRun);
    assert.equal((await send('GET',`/api/v1/runs/${nulRun}`)).statusCode,404);
    const foreign=await execute('foreign.opaque');
    assert.equal(foreign.statusCode,404,foreign.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2',[second,project])).rows[0].n,0);
    actor=null;
    assert.equal((await execute('no-session.opaque')).statusCode,401);

    actor=first;
    // Prepare the current scope and funds before the rollback counter and failure trigger.
    await prepareScope('outbox rollback');
    await pool.query("CREATE FUNCTION bb_execution_key_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='run.staged' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER bb_execution_key_fail_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_execution_key_fail_outbox()');
    const outboxBefore=(await pool.query('SELECT count(*)::int n FROM bb_outbox')).rows[0].n;
    const rollbackKey='rollback\0key';
    const rolled=await execute(rollbackKey);
    assert.equal(rolled.statusCode,500,rolled.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[first,executionKeyStorage(rollbackKey)])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox')).rows[0].n,outboxBefore);
    await pool.query('DROP TRIGGER bb_execution_key_fail_outbox ON bb_outbox');
    await pool.query('DROP FUNCTION bb_execution_key_fail_outbox()');
    assert.equal((await execute(rollbackKey)).statusCode,202);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS bb_execution_key_fail_outbox ON bb_outbox');
    await pool.query('DROP FUNCTION IF EXISTS bb_execution_key_fail_outbox()');
    await app.close();await pool.end();
  }
});
