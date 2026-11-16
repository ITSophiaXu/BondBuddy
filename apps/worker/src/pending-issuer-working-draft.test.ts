import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { appendIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { isTestIssuerCandidate, testIssuerCandidateMatches } from '@bondbuddy/api/test-issuer-candidate';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { createMaterialsReadyStage, inputLockStage, runPipelineOnce, type RunStage } from './run-pipeline.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl=await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL','pending-issuer-working-draft');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

test('two identical unreviewed issuer anchors are pinned together; conflicts and drift fail closed',
  {skip:!databaseUrl},async()=>{
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:databaseUrl});
  const owner=`pending-owner-${randomUUID()}`,origin='http://bondbuddy.test';
  const settings={pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true};
  // Keep the original unpriced production input so the worker's issuer gate is exercised.
  const app=createServer({...settings,historicalBillingFixture:true,enablePaidAuthoring:false});
  // Keep the worker's out-of-request billing default on its original historical Pool.
  const currentPool=new Pool({connectionString:databaseUrl});
  const current=createServer({...settings,pool:currentPool});
  const send=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{origin},payload:payload as any});
  try{
    const projectResponse=await send('/api/v1/projects',{name:'Synthetic pending issuer',kind:'update',
      issuer_name:null,market:'sse',offering:'private'});
    assert.equal(projectResponse.statusCode,201,projectResponse.body);
    const project=projectResponse.json().project_id as string;
    const storedName='合成　发行人Ａ';
    const candidateKey=`issuer-name:${sha('合成 发行人A').slice(0,32)}`;
    const material=randomUUID(),upload=randomUUID(),snapshot=randomUUID(),evidence=randomUUID();
    const materialHash=sha(`material-${material}`),snapshotHash=sha(`snapshot-${snapshot}`);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
      state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
    [upload,owner,project,materialHash,`synthetic/${upload}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$5,$6,'parsed')`,
    [material,owner,project,upload,materialHash,`synthetic/${material}`]);
    const meta={schema_version:'document-parse-response-v1',request_id:`parse-${snapshot}`,status:'parsed',
      parser_version:'synthetic-parser',material:{material_id:material,material_version:1,
        media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sha256:materialHash},
      warnings:[],document:{page_count:1},error:null};
    await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,
      request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-parser',$6,'parsed','document-parse-response-v1',$7,2,$8::jsonb)`,
    [snapshot,owner,project,material,materialHash,sha(`request-${snapshot}`),snapshotHash,JSON.stringify(meta)]);
    const addEvidence=async(id:string,quote:string,ordinal:number)=>pool.query(`INSERT INTO bb_parse_evidence
      (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,
       context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'docx_block',$7::jsonb,$8,'synthetic','native_text','synthetic-parser',0.99,'[]','{}',$9,$10)`,
    [owner,project,material,snapshot,id,materialHash,JSON.stringify({paragraph:ordinal}),quote,sha(id),ordinal]);
    await addEvidence(evidence,storedName,0);
    await appendIssuerIdentitySourceRecord({pool},{ownerUserId:owner,projectId:project,materialId:material,materialVersion:1,
      requestId:`issuer-${evidence}`,sourceRecordId:evidence,issuerDisplayName:storedName,entityId:candidateKey});
    const inputResponse=await send(`/api/v1/projects/${project}/input-revisions`,
      {draft_revision:1,material_versions:[{material_id:material,material_version:1}],requirement_message_ids:[]});
    assert.equal(inputResponse.statusCode,201,inputResponse.body);
    const input=inputResponse.json();
    const manifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=1',
      [owner,project])).rows[0].manifest;
    assert.equal(manifest.issuer_identity.status,'pending');
    assert.equal(manifest.test_issuer_candidate.status,'pending_test_candidate');
    assert.equal(manifest.test_issuer_candidate.issuer_display_name,storedName,
      'one source retains its exact stored legal spelling');
    assert.equal(manifest.test_issuer_candidate.observations,undefined,'the single-source pin keeps its old shape');
    assert.equal(manifest.test_issuer_candidate.observations_sha256,undefined);
    const grant=randomUUID(),sample='a'.repeat(64),taxonomy='b'.repeat(64),pack='c'.repeat(64);
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic',now()+interval '1 hour')`,
    [grant,owner,project,input.input_hash,sample,taxonomy,pack]);
    const submit=async()=>send('/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,
      input_revision:1,input_hash:input.input_hash,task_kind:'update',input_manifest_ref:'synthetic',
      storage_origin:'cloud',workspace_id:'synthetic',test_grant_id:grant});
    assert.equal((await submit()).statusCode,202);
    let reached=0;
    const stages:RunStage[]=[inputLockStage,{name:'model_generation',run:async()=>{reached++;return {kind:'done'};}}];
    const capability=async()=>({status:'ready' as const,sampleManifestSha256:sample,taxonomyHash:taxonomy,
      rulePackHash:pack,uncoveredItems:[]});
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:capability}),'paused');
    assert.equal(reached,1,'the pending identity is admissible only in the test channel');
    const unparsed=await submit();
    assert.equal(unparsed.statusCode,202,unparsed.body);
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,
      stages:[inputLockStage,createMaterialsReadyStage()],testRuleCapabilityLoader:capability}),'paused');
    const unparsedRun=(await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1',[unparsed.json().run_id])).rows[0];
    assert.deepEqual(unparsedRun,{state:'paused',stage:'awaiting_materials'},
      'an unparsed material cannot yield a completed Word');
    const another=randomUUID();
    await addEvidence(another,storedName,1);
    await appendIssuerIdentitySourceRecord({pool},{ownerUserId:owner,projectId:project,materialId:material,materialVersion:1,
      requestId:`issuer-${another}`,sourceRecordId:another,issuerDisplayName:storedName,entityId:candidateKey});
    assert.equal((await submit()).statusCode,202);
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:capability}),'paused');
    assert.equal(reached,1,'a changed issuer observation cannot pass the pinned test input');
    const twoResponse=await send(`/api/v1/projects/${project}/input-revisions`,
      {draft_revision:1,material_versions:[{material_id:material,material_version:1}],requirement_message_ids:[]});
    assert.equal(twoResponse.statusCode,201,twoResponse.body);
    const two=twoResponse.json();
    const twoManifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=2',
      [owner,project])).rows[0].manifest;
    const candidate=twoManifest.test_issuer_candidate;
    assert.ok(isTestIssuerCandidate(candidate));
    assert.equal(candidate.status,'pending_test_candidate');
    assert.ok(candidate.observations);
    assert.ok(candidate.observations_sha256);
    assert.equal(candidate.observations.length,2);
    const pinnedIds=candidate.observations.map(item=>item.source_record_id);
    assert.equal(new Set(pinnedIds).size,2);
    assert.deepEqual(pinnedIds,[...pinnedIds].sort());
    assert.equal(candidate.observations_sha256.length,64);
    assert.equal(twoManifest.issuer_identity.status,'pending');
    assert.equal(twoManifest.issuer_name,null);
    assert.equal(twoManifest.issuer_entity_id,null);
    assert.equal(await testIssuerCandidateMatches(pool,{ownerUserId:owner,projectId:project},candidate),true);
    assert.equal(await testIssuerCandidateMatches(pool,{ownerUserId:owner,projectId:project},
      {...candidate,source_content_sha256:'f'.repeat(64)}),false,'tampered material pin cannot pass');
    assert.equal(isTestIssuerCandidate({...candidate,observations:[
      {...candidate.observations[0]!,quote_sha256:'f'.repeat(64)},candidate.observations[1]!]}),false,
      'one changed anchor invalidates the set hash');
    await assert.rejects(testIssuerCandidateMatches(pool,{ownerUserId:`other-${owner}`,projectId:project},candidate),
      'another owner cannot borrow source evidence');
    const twoGrant=randomUUID();
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,2,$4,$5,$6,$7,'synthetic-operator','synthetic',now()+interval '1 hour')`,
    [twoGrant,owner,project,two.input_hash,sample,taxonomy,pack]);
    const checked=await send(`/api/v1/projects/${project}/preflight`,{input_revision:2,input_hash:two.input_hash,
      test_grant_id:twoGrant});
    assert.equal(checked.statusCode,200,checked.body);
    assert.ok(checked.json().advisory_inputs.includes('issuer_identity_not_bound:issuer_identity_source_missing_unreviewed_or_conflicting'));
    assert.ok(!checked.json().blocking_inputs.some((reason:string)=>reason.startsWith('issuer_identity_not_bound:')));
    const submitTwo=(grantId:string|null=twoGrant)=>send('/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,
      input_revision:2,input_hash:two.input_hash,task_kind:'update',input_manifest_ref:'synthetic',
      storage_origin:'cloud',workspace_id:'synthetic',...(grantId?{test_grant_id:grantId}:{})});
    const twoRun=await submitTwo();
    assert.equal(twoRun.statusCode,202,twoRun.body);
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:capability}),'paused');
    assert.equal(reached,2,'the same-subject set passes the test input gate');
    const beforeCurrent=(await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n;
    const currentProduction=await current.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin},payload:{
      execution_request_id:randomUUID(),project_id:project,input_revision:2,input_hash:two.input_hash,task_kind:'update',
      input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'}});
    assert.equal(currentProduction.statusCode,422,currentProduction.body);
    assert.equal(currentProduction.json().code,'INPUT_REQUIRED','current admission still rejects the unchanged unpriced legacy input');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n,beforeCurrent);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n,0);
    const production=await submitTwo(null);
    assert.equal(production.statusCode,202,production.body);
    assert.equal(production.json().channel,'production');
    assert.equal(production.json().billing_mode,'platform_trial');
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:capability}),'paused');
    assert.equal(reached,2,'production remains closed to unreviewed identity');
    assert.deepEqual((await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1',[production.json().run_id])).rows[0],
      {state:'paused',stage:'capability_not_ready'});
    assert.equal((await pool.query("SELECT payload->>'reason' reason FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1",
      [production.json().run_id])).rows[0].reason,'issuer_identity_source_missing_unreviewed_or_conflicting');
    const third=randomUUID();
    await addEvidence(third,'合成发行人乙',2);
    await appendIssuerIdentitySourceRecord({pool},{ownerUserId:owner,projectId:project,materialId:material,materialVersion:1,
      requestId:`issuer-${third}`,sourceRecordId:third,issuerDisplayName:'合成发行人乙',entityId:`issuer-name:${sha('合成发行人乙').slice(0,32)}`});
    assert.equal(await testIssuerCandidateMatches(pool,{ownerUserId:owner,projectId:project},candidate),false,
      'a changed observation set invalidates every pinned anchor');
    const stale=await submitTwo();assert.equal(stale.statusCode,202,stale.body);
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:capability}),'paused');
    assert.equal(reached,2,'new conflicting source does not reach the model');
    const conflictInput=await send(`/api/v1/projects/${project}/input-revisions`,
      {draft_revision:1,material_versions:[{material_id:material,material_version:1}],requirement_message_ids:[]});
    assert.equal(conflictInput.statusCode,201,conflictInput.body);
    const conflictManifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=3',
      [owner,project])).rows[0].manifest;
    assert.equal(conflictManifest.test_issuer_candidate,undefined,'a true issuer conflict has no candidate');
  }finally{
    await current.close();await currentPool.end();await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});
