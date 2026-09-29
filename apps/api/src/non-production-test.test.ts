import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { claim } from './queue.js';
import { assertTestGrant } from './non-production-test.js';
import { digest, type PrivateBlobs } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { documentParserVersion } from './material-jobs.js';
import { inputManifestHash } from './production-rule-pin.js';

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
    const preflightPayload={input_revision:1,input_hash:input.input_hash,test_grant_id:grantId};
    const checked=await send('POST',`/api/v1/projects/${project}/preflight`,preflightPayload);
    assert.equal(checked.statusCode,200,checked.body);
    assert.ok(checked.json().missing_inputs.includes('rule_pack:issuer_identity_not_bound'));
    assert.ok(checked.json().blocking_inputs.includes('rule_pack:issuer_identity_not_bound'),
      'an input without an issuer source observation remains technically blocked');
    assert.ok(checked.json().blocking_inputs.includes('material_versions'),
      'missing material bytes are still blocking');
    const preflightAudit=(await pool.query("SELECT channel,test_grant_id,stage FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2 AND subtype='free_preflight' ORDER BY created_at DESC LIMIT 1",
      [user,project])).rows[0];
    assert.deepEqual(preflightAudit,{channel:'non_production_test',test_grant_id:grantId,stage:'blocked'});
    const wrongPreflight=await send('POST',`/api/v1/projects/${project}/preflight`,
      {...preflightPayload,input_hash:sha('d')});
    assert.equal(wrongPreflight.statusCode,409,wrongPreflight.body);
    const expiredPreflight=await send('POST',`/api/v1/projects/${project}/preflight`,
      {...preflightPayload,test_grant_id:expiredGrant});
    assert.equal(expiredPreflight.statusCode,409,expiredPreflight.body);
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
    const artifactId=randomUUID(),artifactBytes=Buffer.from('synthetic test-only artifact'),artifactHash=digest(artifactBytes);
    const client=await pool.connect();
    await client.query('BEGIN');
    try{
      const evidenceId=randomUUID();
      await client.query(`INSERT INTO bb_word_delivery_evidence
        (id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,
         quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
        VALUES($1,$2,$3,$4,1,$5,$6,'synthetic-validator','passed','available','readback_verified',$5,$6,$7)`,
        [evidenceId,user,testRun.run_id,artifactId,artifactHash,artifactBytes.length,{sha256:artifactHash,byte_size:artifactBytes.length,validator_version:'synthetic-validator',quality_status:'passed'}]);
      await client.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
        VALUES($1,1,$2,$3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'passed','test_only',$6)`,
        [artifactId,user,testRun.run_id,artifactHash,`synthetic-test/${artifactId}`,evidenceId]);
      await client.query("UPDATE bb_runs SET state='test_completed',artifact_id=$2,artifact_version=1 WHERE id=$1",[testRun.run_id,artifactId]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await assert.rejects(pool.query("UPDATE bb_runs SET state='succeeded' WHERE id=$1",[testRun.run_id]),
      (error:any)=>error.code==='23514');
    const readApp=createServer({pool,blobs:{getIfExistsBounded:async()=>artifactBytes} as unknown as PrivateBlobs,
      allowedOrigin:origin,principal:async()=>({userId:user,csrfVerified:true})});
    const read=(url:string)=>readApp.inject({method:'GET',url,headers:{origin}});
    try{
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,`synthetic_${randomUUID().replaceAll('-','').slice(0,20)}`]);
      await pool.query("INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,'log_reader','synthetic-test','synthetic_test')",[randomUUID(),user]);
      await pool.query("INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,'prompt_viewer','synthetic-test','synthetic_test')",[randomUUID(),user]);
      const jobId=(await pool.query('SELECT id FROM bb_jobs WHERE run_id=$1',[testRun.run_id])).rows[0].id as string;
      const snapshotId=randomUUID(),promptUrl=`/api/v1/admin/prompts/${snapshotId}?reason_code=synthetic_test`;
      await pool.query(`INSERT INTO bb_snapshot_refs
        (id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version)
        VALUES($1,$2,$3,$4,'user_prompt',1,$5,$6,'scrub_v1')`,
        [snapshotId,user,project,testRun.run_id,`users/${user}/projects/${project}/snapshots/${snapshotId}`,artifactHash]);
      const detail=await read(`/api/v1/artifacts/${artifactId}`);
      assert.equal(detail.statusCode,200,detail.body);
      const downloadUrl=detail.json().download_url as string;
      assert.equal((await read(downloadUrl)).statusCode,200);
      assert.equal((await read(`/api/v1/admin/jobs/${jobId}/timeline`)).statusCode,200);
      assert.equal((await read(promptUrl)).statusCode,200);
      for(const [tier,channel] of [['production','enabled'],['production','disabled'],['preprod','disabled']] as const){
        process.env.BB_DEPLOYMENT_TIER=tier;process.env.BB_NON_PRODUCTION_TEST_CHANNEL=channel;
        assert.equal((await read(`/api/v1/artifacts/${artifactId}`)).statusCode,404);
        assert.equal((await read(downloadUrl)).statusCode,404);
        assert.equal((await read(`/api/v1/runs/${testRun.run_id}`)).statusCode,404);
        assert.equal((await read(`/api/v1/runs/${testRun.run_id}/events`)).statusCode,404);
        assert.equal((await read(`/api/v1/runs/${testRun.run_id}/stream`)).statusCode,404);
        assert.equal((await read(`/api/v1/admin/jobs/${jobId}/timeline`)).statusCode,404);
        assert.equal((await read(promptUrl)).statusCode,404);
      }
      process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
      assert.equal((await read(`/api/v1/artifacts/${artifactId}`)).statusCode,200);
      assert.equal((await read(downloadUrl)).statusCode,200);
    }finally{await readApp.close();}
    user=`test-other-${randomUUID()}`;
    assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/artifacts/${artifactId}/download?grant=synthetic`)).statusCode,404);
  } finally{
    await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});

test('working draft admission requires parsed owner materials and fails closed for invalid windows',
  {skip:!databaseUrl},async()=>{
  const names=['BB_DEPLOYMENT_TIER','BB_NON_PRODUCTION_TEST_CHANNEL','BB_PREPROD_WORKING_DRAFT_EXPIRES_AT',
    'BB_PREPROD_WORKING_DRAFT_SAMPLE_MANIFEST_SHA256','BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH',
    'BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH','BB_PREPROD_WORKING_DRAFT_STAGE','BB_PREPROD_WORKING_DRAFT_AS_OF'] as const;
  const original=names.map(name=>process.env[name]);
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT=new Date(Date.now()+3_600_000).toISOString();
  process.env.BB_PREPROD_WORKING_DRAFT_SAMPLE_MANIFEST_SHA256=sha('a');
  process.env.BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH=sha('b');
  process.env.BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH=sha('c');
  process.env.BB_PREPROD_WORKING_DRAFT_STAGE='issuance';
  process.env.BB_PREPROD_WORKING_DRAFT_AS_OF='2026-09-29';
  const pool=new Pool({connectionString:databaseUrl});
  let owner=`auto-owner-${randomUUID()}`;
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{origin},payload:payload as any});
  try{
    const projectResponse=await send('/api/v1/projects',{name:'Synthetic working draft',kind:'update',
      issuer_name:null,market:null,offering:null});
    assert.equal(projectResponse.statusCode,201,projectResponse.body);
    const project=projectResponse.json().project_id as string;
    const locked=async(refs:{material_id:string;material_version:number}[])=>{
      const response=await send(`/api/v1/projects/${project}/input-revisions`,
        {draft_revision:1,material_versions:refs,requirement_message_ids:[]});
      assert.equal(response.statusCode,201,response.body);
      const input=response.json() as {input_revision:number;input_hash:string};
      return {revision:input.input_revision,input_hash:input.input_hash};
    };
    const request=(input:{revision:number;input_hash:string})=>({
      execution_request_id:randomUUID(),project_id:project,input_revision:input.revision,input_hash:input.input_hash,
      task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'});
    const check=async(input:{revision:number;input_hash:string})=>send(`/api/v1/projects/${project}/preflight`,
      {input_revision:input.revision,input_hash:input.input_hash});
    const counts=async()=>({
      grants:Number((await pool.query('SELECT count(*) AS n FROM bb_non_production_test_grants WHERE user_id=$1 AND project_id=$2',[owner,project])).rows[0].n),
      grantEvents:Number((await pool.query(`SELECT count(*) AS n FROM bb_outbox WHERE owner_user_id=$1
        AND aggregate_type='test_grant'`,[owner])).rows[0].n),
      runs:Number((await pool.query('SELECT count(*) AS n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n)
    });
    const empty=await locked([]);
    assert.equal((await check(empty)).json().code,'INPUT_REQUIRED');
    assert.equal((await send('/api/v1/runs/execute',request(empty))).json().code,'INPUT_REQUIRED');
    assert.deepEqual(await counts(),{grants:0,grantEvents:0,runs:0});

    const addMaterial=async(role:'historical'|'financial',hash:string)=>{
      const id=randomUUID(),uploadId=randomUUID();
      const media=role==='historical'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,$4,$5,20,$6,$7,$8,now()+interval '1 day','completed')`,
      [uploadId,owner,project,`synthetic.${role==='historical'?'docx':'xlsx'}`,media,hash,role,`synthetic/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,'synthetic', $6,20,$7,$8,'parsed')`,
      [id,owner,project,uploadId,role,media,hash,`users/${owner}/projects/${project}/materials/${id}`]);
      await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,project_id,material_id,material_version,
        material_sha256,parser_version,trace_id,max_attempts,result)
        VALUES($1,$2,NULL,'parse','material_parse','succeeded',$3,$4,1,$5,$6,$7,3,$8)`,
      [randomUUID(),owner,project,id,hash,documentParserVersion(),randomUUID(),
        {outcome:'parsed',parse_status:'parsed',profile_version:null,pending_capabilities:[]}]);
      return {material_id:id,material_version:1};
    };
    const financial=await addMaterial('financial',sha('f'));
    const onlyFinancial=await locked([financial]);
    assert.equal((await check(onlyFinancial)).json().code,'INPUT_REQUIRED');
    assert.equal((await send('/api/v1/runs/execute',request(onlyFinancial))).json().code,'INPUT_REQUIRED');
    assert.deepEqual(await counts(),{grants:0,grantEvents:0,runs:0});
    const historical=await addMaterial('historical',sha('e'));
    const valid=await locked([historical,financial]);
    const validRequest=request(valid);
    const wrongHash=await send('/api/v1/runs/execute',{...validRequest,execution_request_id:randomUUID(),input_hash:sha('d')});
    assert.equal(wrongHash.statusCode,409,wrongHash.body);
    owner=`foreign-${randomUUID()}`;
    assert.equal((await check(valid)).statusCode,404);
    assert.equal((await send('/api/v1/runs/execute',request(valid))).statusCode,404);
    owner=(await pool.query('SELECT owner_user_id FROM bb_projects WHERE id=$1',[project])).rows[0].owner_user_id;
    assert.deepEqual(await counts(),{grants:0,grantEvents:0,runs:0});

    const changed=await addMaterial('financial',sha('b'));
    const changedInput=await locked([historical,changed]);
    await pool.query('UPDATE bb_material_versions SET sha256=$2 WHERE id=$1',[changed.material_id,sha('c')]);
    assert.equal((await check(changedInput)).json().code,'INPUT_REVISION_CONFLICT');
    assert.equal((await send('/api/v1/runs/execute',request(changedInput))).json().code,'INPUT_REVISION_CONFLICT');
    const stored=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
      [project,valid.revision])).rows[0].manifest;
    const staleManifest=structuredClone(stored);
    const stalePin=staleManifest.materials.find((item:{material_id:string})=>item.material_id===financial.material_id);
    stalePin.material_version=2;
    const staleVersion={revision:999,input_hash:inputManifestHash(staleManifest)};
    await pool.query(`INSERT INTO bb_input_revisions
      (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,$3,1,$4,$5,$6,'[]')`,[project,staleVersion.revision,owner,staleVersion.input_hash,
        staleManifest,JSON.stringify([{...historical},{material_id:financial.material_id,material_version:2}])]);
    assert.equal((await check(staleVersion)).json().code,'INPUT_REVISION_CONFLICT');
    assert.equal((await send('/api/v1/runs/execute',request(staleVersion))).json().code,'INPUT_REVISION_CONFLICT');
    const removed=await addMaterial('financial',sha('a'));
    const removedInput=await locked([historical,removed]);
    await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1',[removed.material_id]);
    assert.equal((await check(removedInput)).json().code,'INPUT_REVISION_CONFLICT');
    assert.equal((await send('/api/v1/runs/execute',request(removedInput))).json().code,'INPUT_REVISION_CONFLICT');
    const unreadable=await addMaterial('financial',sha('1'));
    const unreadableInput=await locked([historical,unreadable]);
    await pool.query("UPDATE bb_material_versions SET state='ready' WHERE id=$1",[unreadable.material_id]);
    assert.equal((await check(unreadableInput)).json().code,'MATERIAL_UNREADABLE');
    assert.equal((await send('/api/v1/runs/execute',request(unreadableInput))).json().code,'MATERIAL_UNREADABLE');
    assert.deepEqual(await counts(),{grants:0,grantEvents:0,runs:0});

    process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT='invalid';
    for(const response of [await check(valid),await send('/api/v1/runs/execute',request(valid))]){
      assert.equal(response.statusCode,409,response.body);
      assert.equal(response.json().code,'TEST_GRANT_INVALID');
    }
    process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT=new Date(Date.now()-3_600_000).toISOString();
    assert.equal((await check(valid)).json().code,'TEST_GRANT_EXPIRED');
    assert.equal((await send('/api/v1/runs/execute',request(valid))).json().code,'TEST_GRANT_EXPIRED');
    assert.deepEqual(await counts(),{grants:0,grantEvents:0,runs:0});

    process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT=new Date(Date.now()+3_600_000).toISOString();
    const preflight=await check(valid);
    assert.equal(preflight.statusCode,200,preflight.body);
    const submitted=await send('/api/v1/runs/execute',validRequest);
    assert.equal(submitted.statusCode,202,submitted.body);
    assert.equal(submitted.json().channel,'non_production_test');
    const grantId=submitted.json().test_grant_id as string;
    assert.equal((await send('/api/v1/runs/execute',validRequest)).json().run_id,submitted.json().run_id);
    assert.deepEqual(await counts(),{grants:1,grantEvents:1,runs:1});
    await pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic-operator',
      revoked_reason='synthetic_revoke' WHERE grant_id=$1`,[grantId]);
    assert.equal((await check(valid)).json().code,'TEST_GRANT_REVOKED');
    assert.equal((await send('/api/v1/runs/execute',request(valid))).json().code,'TEST_GRANT_REVOKED');
    assert.deepEqual(await counts(),{grants:1,grantEvents:1,runs:1});
    process.env.BB_DEPLOYMENT_TIER='production';
    assert.equal((await send('/api/v1/runs/execute',request(valid))).json().code,'TEST_CHANNEL_DISABLED');
    for(const name of names.filter(name=>name.startsWith('BB_PREPROD_WORKING_DRAFT_')))delete process.env[name];
    const production=await send('/api/v1/runs/execute',request(valid));
    assert.equal(production.statusCode,202,production.body);
    assert.equal(production.json().channel,'production');
  }finally{
    await app.close();await pool.end();
    names.forEach((name,index)=>{if(original[index]===undefined)delete process.env[name];else process.env[name]=original[index];});
  }
});
