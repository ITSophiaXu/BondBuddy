import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { claim } from './queue.js';
import { assertTestGrant } from './non-production-test.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl=await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL');
const origin='http://bondbuddy.test';
const sha=(letter:string)=>letter.repeat(64);

test('scoped test grants reject invalid submissions, preserve idempotency and pause revoked runs',
  {skip:!databaseUrl},async()=>{
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:databaseUrl});
  let user=`test-owner-${randomUUID()}`;
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:user,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try{
    const projectResponse=await send('POST','/api/v1/projects',{name:'Synthetic test channel',kind:'update',issuer_name:null,market:null,offering:null});
    assert.equal(projectResponse.statusCode,201,projectResponse.body);
    const project=projectResponse.json().project_id as string;
    const inputResponse=await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
    assert.equal(inputResponse.statusCode,201,inputResponse.body);
    const input=inputResponse.json();
    const grantId=randomUUID(),otherGrantId=randomUUID();
    for(const id of [grantId,otherGrantId])await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic test',now()+interval '1 hour')`,
      [id,user,project,input.input_hash,sha('a'),sha('b'),sha('c')]);
    await assert.rejects(assertTestGrant(pool,{grantId,userId:`foreign-${randomUUID()}`,projectId:project,inputRevision:1,inputHash:input.input_hash}),
      (error:any)=>error.code==='TEST_GRANT_INVALID');
    await assert.rejects(assertTestGrant(pool,{grantId,userId:user,projectId:project,inputRevision:1,inputHash:sha('d')}),
      (error:any)=>error.code==='TEST_GRANT_MISMATCH');
    const expiredGrant=randomUUID();
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,created_at,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic test',now()-interval '2 hours',now()-interval '1 hour')`,
      [expiredGrant,user,project,input.input_hash,sha('a'),sha('b'),sha('c')]);
    await assert.rejects(assertTestGrant(pool,{grantId:expiredGrant,userId:user,projectId:project,inputRevision:1,inputHash:input.input_hash}),
      (error:any)=>error.code==='TEST_GRANT_EXPIRED');
    const request={execution_request_id:randomUUID(),project_id:project,input_revision:1,input_hash:input.input_hash,
      task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace',test_grant_id:grantId};
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL='disabled';
    const disabled=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID()});
    assert.equal(disabled.statusCode,403,disabled.body);assert.equal(disabled.json().code,'TEST_CHANNEL_DISABLED');
    const rejectedLog=(await pool.query("SELECT channel,test_grant_id FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2 AND subtype='execute_rejected' ORDER BY created_at DESC LIMIT 1",[user,project])).rows[0];
    assert.equal(rejectedLog.channel,'non_production_test');assert.equal(rejectedLog.test_grant_id,grantId);
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
    const submitted=await send('POST','/api/v1/runs/execute',request);
    assert.equal(submitted.statusCode,202,submitted.body);
    assert.equal(submitted.json().channel,'non_production_test');assert.equal(submitted.json().test_grant_id,grantId);
    assert.equal(submitted.json().billing_mode,'non_billable_test');
    await assert.rejects(pool.query("UPDATE bb_runs SET channel='production',test_grant_id=NULL WHERE id=$1",[submitted.json().run_id]),
      (error:any)=>error.code==='23514');
    const replay=await send('POST','/api/v1/runs/execute',request);
    assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().run_id,submitted.json().run_id);
    const conflict=await send('POST','/api/v1/runs/execute',{...request,test_grant_id:otherGrantId});
    assert.equal(conflict.statusCode,409,conflict.body);assert.equal(conflict.json().code,'IDEMPOTENCY_CONFLICT');
    const wrongHash=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID(),input_hash:sha('d')});
    assert.equal(wrongHash.statusCode,409,wrongHash.body);
    const expired=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID(),test_grant_id:expiredGrant});
    assert.equal(expired.statusCode,409,expired.body);assert.equal(expired.json().code,'TEST_GRANT_EXPIRED');
    user=`test-other-${randomUUID()}`;
    const foreign=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID()});
    assert.equal(foreign.statusCode,404,foreign.body);
    user=(await pool.query('SELECT owner_user_id FROM bb_runs WHERE id=$1',[submitted.json().run_id])).rows[0].owner_user_id;
    await pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic-operator',revoked_reason='synthetic-revoke' WHERE grant_id=$1`,[grantId]);
    await assert.rejects(pool.query(`UPDATE bb_non_production_test_grants SET reason='changed' WHERE grant_id=$1`,[grantId]),(error:any)=>error.code==='23514');
    const revoked=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID()});
    assert.equal(revoked.statusCode,409,revoked.body);assert.equal(revoked.json().code,'TEST_GRANT_REVOKED');
    assert.equal(await claim(pool),null);
    const run=(await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1',[submitted.json().run_id])).rows[0];
    assert.equal(run.state,'paused');assert.equal(run.stage,'test_grant_invalid');
    await assert.rejects(pool.query("UPDATE bb_jobs SET channel='production',test_grant_id=NULL WHERE run_id=$1",[submitted.json().run_id]),
      (error:any)=>error.code==='23514');
    await assert.rejects(pool.query("UPDATE bb_runs SET state='succeeded' WHERE id=$1",[submitted.json().run_id]),(error:any)=>error.code==='23514');
    const production=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID(),test_grant_id:undefined});
    assert.equal(production.statusCode,202,production.body);
    await assert.rejects(pool.query("UPDATE bb_runs SET state='test_completed' WHERE id=$1",[production.json().run_id]),(error:any)=>error.code==='23514');
    const testRun=(await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID(),test_grant_id:otherGrantId})).json();
    await assert.rejects(pool.query("UPDATE bb_runs SET state='settlement_pending' WHERE id=$1",[testRun.run_id]),(error:any)=>error.code==='23514');
    const artifactId=randomUUID();
    const client=await pool.connect();
    await client.query('BEGIN');
    try{
      const evidenceId=randomUUID();
      await client.query(`INSERT INTO bb_word_delivery_evidence
        (id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,
         quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
        VALUES($1,$2,$3,$4,1,$5,123,'synthetic-validator','passed','available','readback_verified',$5,123,$6)`,
        [evidenceId,user,testRun.run_id,artifactId,sha('e'),{sha256:sha('e'),byte_size:123,validator_version:'synthetic-validator',quality_status:'passed'}]);
      await client.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
        VALUES($1,1,$2,$3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'passed','test_only',$6)`,
        [artifactId,user,testRun.run_id,sha('e'),`synthetic-test/${artifactId}`,evidenceId]);
      await client.query("UPDATE bb_runs SET state='test_completed',artifact_id=$2,artifact_version=1 WHERE id=$1",[testRun.run_id,artifactId]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await assert.rejects(pool.query("UPDATE bb_runs SET state='succeeded' WHERE id=$1",[testRun.run_id]),
      (error:any)=>error.code==='23514');
    user=`test-other-${randomUUID()}`;
    assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}/download?grant=synthetic`)).statusCode,404);
  } finally{
    await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});
