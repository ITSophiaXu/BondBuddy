import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { readTestApplicabilityRef } from '@bondbuddy/api/test-rule-applicability-pin';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer, reviewIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { RULE_APPLICABILITY_FEATURE_DIMENSIONS } from '@bondbuddy/contracts';
import { inputLockStage, runPipelineOnce, type RunStage } from './run-pipeline.js';
import { runGrantCommand } from './non-production-test-grants.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl=await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL');
const origin='http://bondbuddy.test';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const pythonBin=process.env.BB_PYTHON_BIN ?? 'python3';
const wordPythonReady=spawnSync(pythonBin,['-c','import lxml'],{stdio:'ignore'}).status===0;
const wordSkipReason=!databaseUrl?'set BB_TEST_CHANNEL_DATABASE_URL or BB_TEST_DATABASE_URL to a migrated PostgreSQL 16 template':
  !process.env.BB_TEST_AZURITE_CONNECTION_STRING?'set BB_TEST_AZURITE_CONNECTION_STRING to an Azurite instance':
  !wordPythonReady?`${pythonBin} must import lxml (set BB_PYTHON_BIN to a Python with python-docx installed)`:false;

test('test input gate pauses a missing applicability ref before capability loading', {skip:!databaseUrl},async()=>{
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:databaseUrl});
  const owner=`test-ref-owner-${randomUUID()}`;
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try{
    const project=(await send('POST','/api/v1/projects',{name:'Synthetic missing ref',kind:'review',issuer_name:null,market:null,offering:null})).json().project_id;
    const input=(await send('POST',`/api/v1/projects/${project}/input-revisions`,
      {draft_revision:1,material_versions:[],requirement_message_ids:[]})).json();
    const grantId=randomUUID();
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic',now()+interval '1 hour')`,
    [grantId,owner,project,input.input_hash,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]);
    const run=(await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,
      input_revision:1,input_hash:input.input_hash,task_kind:'review',input_manifest_ref:'synthetic',storage_origin:'cloud',
      workspace_id:'synthetic',test_grant_id:grantId})).json();
    let called=false;
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages:[inputLockStage],
      testRuleCapabilityLoader:async()=>{called=true;return {status:'not_ready',reason:'unexpected'};}}),'paused');
    assert.equal(called,false);
    const event=(await pool.query(`SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1`,[run.run_id])).rows[0];
    assert.equal(event.payload.reason,'test_reviewed_applicability_pin_missing');
    const stopped=(await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1',[run.run_id])).rows[0];
    assert.deepEqual(stopped,{state:'paused',stage:'capability_not_ready'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=(SELECT id FROM bb_jobs WHERE run_id=$1)',
      [run.run_id])).rows[0].n,0,'the missing ref cannot start a model call');
    const locked=(await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=1',
      [owner,project])).rows[0];
    const tampered={...locked.manifest,test_rule_applicability_ref:{context_id:'forged',version:1,content_hash:'a'.repeat(64),
      source_input_revision:1,source_input_hash:'b'.repeat(64)}};
    const gate=await inputLockStage.run({pool:{query:async()=>({rows:[{...locked,manifest:tampered}]})} as any,
      run:{owner_user_id:owner,project_id:project,input_revision:1,input_hash:input.input_hash,task_kind:'review',
        channel:'non_production_test',test_grant_id:grantId},testRuleCapabilityLoader:async()=>{
        called=true;return {status:'not_ready',reason:'unexpected'};
      }} as any);
    assert.deepEqual(gate,{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
    assert.equal(called,false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=(SELECT id FROM bb_jobs WHERE run_id=$1)',
      [run.run_id])).rows[0].n,0,'the tampered ref cannot start a model call');
    const blocked={...locked.manifest,test_rule_applicability_ref:null,
      test_rule_applicability_block_reason:'rule_applicability_overall_review_withdrawn'};
    const blockedHash=inputManifestHash(blocked);
    const blockedGate=await inputLockStage.run({pool:{query:async()=>({rows:[{...locked,manifest:blocked,input_hash:blockedHash}]})} as any,
      run:{owner_user_id:owner,project_id:project,input_revision:1,input_hash:blockedHash,task_kind:'review',
        channel:'non_production_test',test_grant_id:grantId},testRuleCapabilityLoader:async()=>{
        called=true;return {status:'not_ready',reason:'unexpected'};
      }} as any);
    assert.deepEqual(blockedGate,{kind:'pause',stage:'capability_not_ready',reason:'rule_applicability_overall_review_withdrawn'});
    assert.equal(called,false);
    // The immutable DB row rejects mutation; the gate also rejects a mismatched manifest hash if storage is compromised.
    await assert.rejects(pool.query('UPDATE bb_input_revisions SET manifest=$2 WHERE project_id=$1 AND revision=1',
      [project,tampered]));
  }finally{
    await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});

test('a revoked grant pauses an executing test run at its next gate', {skip:!databaseUrl},async()=>{
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:databaseUrl});
  const owner=`test-owner-${randomUUID()}`;
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try{
    const project=(await send('POST','/api/v1/projects',{name:'Synthetic revoked run',kind:'update',issuer_name:null,market:null,offering:null})).json().project_id;
    const input=(await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]})).json();
    const grantId=randomUUID(),sample='a'.repeat(64),taxonomy='b'.repeat(64),pack='c'.repeat(64);
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic',now()+interval '1 hour')`,
      [grantId,owner,project,input.input_hash,sample,taxonomy,pack]);
    const run=(await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,input_revision:1,input_hash:input.input_hash,
      task_kind:'review',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic',test_grant_id:grantId})).json();
    let reachedAfter=false;
    const stages:RunStage[]=[
      {name:'input_lock',run:async()=>({kind:'done'})},
      {name:'revoke_grant',run:async()=>{
        await pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic-operator',revoked_reason='synthetic' WHERE grant_id=$1`,[grantId]);
        return {kind:'done'};
      }},
      {name:'after_revoke',run:async()=>{reachedAfter=true;return {kind:'done'};}}
    ];
    const result=await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:async()=>
      ({status:'ready',sampleManifestSha256:sample,taxonomyHash:taxonomy,rulePackHash:pack,uncoveredItems:[]})});
    assert.equal(result,'paused');assert.equal(reachedAfter,false);
    const stored=(await pool.query('SELECT state,stage,channel FROM bb_runs WHERE id=$1',[run.run_id])).rows[0];
    assert.equal(stored.state,'paused');assert.equal(stored.channel,'non_production_test');
    assert.equal((await pool.query('SELECT state FROM bb_jobs WHERE run_id=$1',[run.run_id])).rows[0].state,'paused');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=(SELECT id FROM bb_jobs WHERE run_id=$1)',[run.run_id])).rows[0].n,0);
  } finally{
    await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});

test('an unbound update identity pauses a test run before its provider intent', {skip:!databaseUrl},async()=>{
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:databaseUrl});
  const owner=`test-owner-${randomUUID()}`;
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try{
    const project=(await send('POST','/api/v1/projects',{name:'Synthetic identity gate',kind:'update',issuer_name:null,market:null,offering:null})).json().project_id;
    const input=(await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]})).json();
    const grantId=randomUUID(),sample='a'.repeat(64),taxonomy='b'.repeat(64),pack='c'.repeat(64);
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic',now()+interval '1 hour')`,
      [grantId,owner,project,input.input_hash,sample,taxonomy,pack]);
    const submitted=await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,input_revision:1,input_hash:input.input_hash,
      task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic',test_grant_id:grantId});
    assert.equal(submitted.statusCode,202,submitted.body);
    let providerIntents=0, capabilityChecks=0;
    const stages:RunStage[]=[
      {name:'input_lock',run:async()=>({kind:'done'})},
      {name:'model_generation',run:async ctx=>{
        const gate=await ctx.validateBeforeModelCall?.();
        if(gate)return gate;
        providerIntents++;
        return {kind:'done'};
      }}
    ];
    const result=await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:async()=>{
      capabilityChecks++;
      return {status:'ready',sampleManifestSha256:sample,taxonomyHash:taxonomy,rulePackHash:pack,uncoveredItems:[]};
    }});
    assert.equal(result,'paused');
    assert.equal(providerIntents,0,'identity failure must stop before a provider intent');
    assert.equal(capabilityChecks,0,'identity failure must precede the candidate capability gate');
    const runId=submitted.json().run_id;
    const stored=(await pool.query('SELECT state,stage,channel FROM bb_runs WHERE id=$1',[runId])).rows[0];
    assert.equal(stored.state,'paused');assert.equal(stored.stage,'capability_not_ready');assert.equal(stored.channel,'non_production_test');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=(SELECT id FROM bb_jobs WHERE run_id=$1)',[runId])).rows[0].n,0);
  }finally{
    await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});

test('test-only Word passes delivery inspection and stays isolated from another account',
  {skip:wordSkipReason},async()=>{
  // Keep this delivery run away from queued jobs and leases created by other cases in this file.
  const wordDatabaseUrl=await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL','word-delivery');
  const previousCwd=process.cwd();
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:wordDatabaseUrl});
  const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING!;
  const container=`bb-test-channel-${randomUUID()}`;
  const blobs=azureBlobs(blobConnection,container);
  let user=`test-owner-${randomUUID()}`;
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:user,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try{
    const owner=user,reviewer=`test-reviewer-${randomUUID()}`;
    const projectResponse=await send('POST','/api/v1/projects',
      {name:'Synthetic test Word',kind:'update',issuer_name:'合成发行人',market:'sse',offering:'private'});
    assert.equal(projectResponse.statusCode,201,projectResponse.body);
    const project=projectResponse.json().project_id;
    const base=`/api/v1/projects/${project}`;
    const materialId=randomUUID(),uploadId=randomUUID(),snapshotId=randomUUID(),recordId=randomUUID();
    const materialHash=sha(`synthetic-word-material-${materialId}`),recordHash=sha(`synthetic-word-record-${recordId}`);
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)',
      [owner,`testowner${randomUUID().replaceAll('-','').slice(0,12)}`,
        reviewer,`testreviewer${randomUUID().replaceAll('-','').slice(0,12)}`]);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
      state,received_sha256,received_bytes) VALUES($1,$2,$3,'source.pdf','application/pdf',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
    [uploadId,owner,project,materialHash,`synthetic/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','source.pdf','application/pdf',10,$5,$6,'parsed')`,
    [materialId,owner,project,uploadId,materialHash,`users/${owner}/projects/${project}/materials/${materialId}`]);
    const parseMeta={schema_version:'document-parse-response-v1',request_id:`parse-${snapshotId}`,status:'parsed',
      parser_version:'synthetic-parser',material:{material_id:materialId,material_version:1,media_type:'application/pdf',sha256:materialHash},
      warnings:[],document:{page_count:1},error:null};
    await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,
      request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-parser',$6,'parsed','document-parse-response-v1',$7,1,$8::jsonb)`,
    [snapshotId,owner,project,materialId,materialHash,sha(`request-${snapshotId}`),sha(`response-${snapshotId}`),JSON.stringify(parseMeta)]);
    await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
      locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'合成发行人','synthetic evidence','native_text','synthetic-parser',0.99,'[]','{}',$8,0)`,
    [owner,project,materialId,snapshotId,recordId,materialHash,JSON.stringify({page:1,bbox:[0,0,1,1]}),recordHash]);
    const identity=await appendIssuerIdentitySourceRecord({pool,newId:randomUUID},{ownerUserId:owner,projectId:project,
      materialId,materialVersion:1,requestId:`identity-${materialId}`,sourceRecordId:recordId,
      issuerDisplayName:'合成发行人',entityId:`candidate-${materialId}`});
    await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$3,$4)`,[randomUUID(),reviewer,owner,project]);
    const identityReviewer=await authorizeIssuerIdentityReviewer(pool,reviewer);
    assert.ok(identityReviewer);
    await reviewIssuerIdentitySourceRecord({pool,newId:randomUUID},{ownerUserId:owner,projectId:project,materialId,materialVersion:1,
      sourceRecordRowId:identity.id,reviewer:identityReviewer,decision:'verified',reasonCode:'synthetic_verified',
      verifiedEntityId:'entity:11111111-1111-4111-8111-111111111111',entityBasisKind:'manual_attestation',
      entityBasisRef:'synthetic identity evidence'});
    const sourceResponse=await send('POST',`${base}/input-revisions`,{draft_revision:1,
      material_versions:[{material_id:materialId,material_version:1}],requirement_message_ids:[],
      target_confirmation:{market:'sse',offering:'private',document_purpose:'registration',as_of:'2026-09-27',target_reporting_periods:[]}});
    assert.equal(sourceResponse.statusCode,201,sourceResponse.body);
    const source=sourceResponse.json();
    const draftResponse=await send('POST',`${base}/input-revisions/${source.input_revision}/rule-applicability-context-drafts`,
      {request_id:`word-context-${project}`});
    assert.equal(draftResponse.statusCode,201,draftResponse.body);
    const ref=draftResponse.json().context_ref;
    await pool.query(`INSERT INTO bb_rule_applicability_reviewer_grants
      (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'rule_applicability_reviewer',$3,'synthetic_test','Synthetic Word regression only',$3,$4)`,
    [randomUUID(),reviewer,owner,project]);
    const evidenceRef={materialId,materialVersion:1,materialSha256:materialHash,parseSnapshotId:snapshotId,
      recordId,recordSha256:recordHash};
    user=reviewer;
    const reviewResponse=await send('POST',`${base}/rule-applicability-context-drafts/${ref.context_id}/versions/${ref.version}/reviews`,
      {request_id:`word-review-${project}`,action:'approve',reason:'Synthetic regression only; no professional signoff.',
        approved_values:{market:'sse',offering:'private',instrument:'ordinary-company-bond',documentStage:'registration',
          issuerScope:'domestic-company',investorScope:'professional',industry:'industry-code-v1',specialFeatures:[],asOf:'2026-09-27'},
        value_evidence:{instrument:[evidenceRef],issuerScope:[evidenceRef],investorScope:[evidenceRef],industry:[evidenceRef]},
        feature_evidence:RULE_APPLICABILITY_FEATURE_DIMENSIONS.map(dimension=>({dimension,outcome:'absent',
          reason:'Synthetic scope review against the complete locked material set.',evidenceRefs:[evidenceRef]})),
        taxonomy_version:'bondbuddy-applicability-synthetic-test-v1'});
    assert.equal(reviewResponse.statusCode,201,reviewResponse.body);
    user=owner;
    const inputResponse=await send('POST',`${base}/input-revisions`,{draft_revision:1,
      material_versions:[{material_id:materialId,material_version:1}],requirement_message_ids:[],
      test_rule_applicability_context_ref:ref});
    assert.equal(inputResponse.statusCode,201,inputResponse.body);
    const input=inputResponse.json();
    const locked=(await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner,project,input.input_revision])).rows[0];
    assert.deepEqual(readTestApplicabilityRef(locked.manifest),ref,'the API locks the reviewed ref into the manifest');
    assert.equal(locked.input_hash.trim(),inputManifestHash(locked.manifest));
    const grantId=randomUUID(),sample='a'.repeat(64),taxonomy='b'.repeat(64),pack='c'.repeat(64);
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthetic-operator','synthetic',now()+interval '1 hour')`,
      [grantId,owner,project,input.input_revision,input.input_hash,sample,taxonomy,pack]);
    const submitted=await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,
      input_revision:input.input_revision,input_hash:input.input_hash,
      task_kind:'review',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic',test_grant_id:grantId});
    assert.equal(submitted.statusCode,202,submitted.body);
    const stages:RunStage[]=[
      {name:'input_lock',run:async()=>({kind:'done'})},
      {name:'word_delivery',run:async()=>({kind:'deliver',bytes:makeWorkerDocxFixture({externalLink:false})})}
    ];
    const unexpected:string[]=[];
    const result=await runPipelineOnce({pool,blobs,stages,onUnexpectedError:error=>unexpected.push(JSON.stringify(error)),testRuleCapabilityLoader:async()=>
      ({status:'ready',sampleManifestSha256:sample,taxonomyHash:taxonomy,rulePackHash:pack,
        uncoveredItems:[{kind:'rule_check',rule_id:'synthetic-rule',source_ref_ids:['synthetic-source'],reason_code:'needs_review',evidence_ref:'docx:p0001'},
          {kind:'coverage_gap',manifest_id:'synthetic-coverage',manifest_version:'1',item_id:'unmapped-gap',
            candidate_asset_sha256:'d'.repeat(64),disposition:'uncovered',area:'资金用途',rationale:'缺少依据',
            rule_ids:[],source_ref_ids:['synthetic-source'],reason_code:'coverage_uncovered',evidence_ref:null}]})});
    assert.equal(result,'test_completed',unexpected.join('; '));
    const run=(await send('GET',`/api/v1/runs/${submitted.json().run_id}`)).json();
    assert.equal(run.state,'test_completed');assert.equal(run.channel,'non_production_test');
    assert.equal(run.uncovered_items.length,2);assert.equal(run.billing_mode,'non_billable_test');
    assert.equal(run.uncovered_items[1].kind,'coverage_gap');assert.equal(run.uncovered_items[1].item_id,'unmapped-gap');
    assert.deepEqual(run.uncovered_items[1].rule_ids,[]);assert.equal('rule_id' in run.uncovered_items[1],false);
    const artifact=await send('GET',`/api/v1/artifacts/${run.artifact_id}`);
    assert.equal(artifact.statusCode,200,artifact.body);assert.equal(artifact.json().delivery_status,'test_only');
    const download=await send('GET',artifact.json().download_url);
    assert.equal(download.statusCode,200,download.body);
    process.env.BB_DEPLOYMENT_TIER='production';
    assert.equal((await send('GET',`/api/v1/runs/${submitted.json().run_id}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/artifacts/${run.artifact_id}`)).statusCode,404);
    assert.equal((await send('GET',artifact.json().download_url)).statusCode,404);
    process.env.BB_DEPLOYMENT_TIER='preprod';
    user=`test-other-${randomUUID()}`;
    assert.equal((await send('GET',`/api/v1/artifacts/${run.artifact_id}`)).statusCode,404);
    assert.equal((await send('GET',artifact.json().download_url)).statusCode,404);
  }finally{
    await app.close();await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection).getContainerClient(container).deleteIfExists();
    process.chdir(previousCwd);
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});

test('ops grant create and revoke append outbox events atomically', {skip:!databaseUrl},async()=>{
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:databaseUrl});
  const owner=`test-owner-${randomUUID()}`;
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try{
    const project=(await send('POST','/api/v1/projects',{name:'Synthetic grant audit',kind:'update',issuer_name:null,market:null,offering:null})).json().project_id;
    const input=(await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]})).json();
    const created=await runGrantCommand(pool,['create',owner,project,'1',input.input_hash,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'synthetic-operator',new Date(Date.now()+3600000).toISOString(),'synthetic reason']) as {grant_id:string};
    const listed=await runGrantCommand(pool,['list',owner]) as {grant_id:string}[];
    assert.ok(listed.some(row=>row.grant_id===created.grant_id));
    await runGrantCommand(pool,['revoke',created.grant_id,'synthetic-operator','synthetic reason']);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='test_grant' AND aggregate_id=$1",[created.grant_id])).rows[0].n,2);
    await assert.rejects(runGrantCommand(pool,['revoke',created.grant_id,'synthetic-operator','repeat']));
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL='disabled';
    await assert.rejects(runGrantCommand(pool,['list',owner]),/disabled/);
  }finally{
    await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});
