import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { appendIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { createMaterialsReadyStage, inputLockStage, runPipelineOnce, type RunStage } from './run-pipeline.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl=await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL','pending-issuer-working-draft');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

test('a pinned unreviewed issuer reaches the test model gate; a second observation pauses before it',
  {skip:!databaseUrl},async()=>{
  const oldTier=process.env.BB_DEPLOYMENT_TIER,oldSwitch=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
  process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
  const pool=new Pool({connectionString:databaseUrl});
  const owner=`pending-owner-${randomUUID()}`,origin='http://bondbuddy.test';
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{origin},payload:payload as any});
  try{
    const projectResponse=await send('/api/v1/projects',{name:'Synthetic pending issuer',kind:'update',
      issuer_name:null,market:'sse',offering:'private'});
    assert.equal(projectResponse.statusCode,201,projectResponse.body);
    const project=projectResponse.json().project_id as string;
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
    await addEvidence(evidence,'合成发行人甲',0);
    await appendIssuerIdentitySourceRecord({pool},{ownerUserId:owner,projectId:project,materialId:material,materialVersion:1,
      requestId:`issuer-${evidence}`,sourceRecordId:evidence,issuerDisplayName:'合成发行人甲',entityId:`issuer-name:${sha('合成发行人甲').slice(0,32)}`});
    const inputResponse=await send(`/api/v1/projects/${project}/input-revisions`,
      {draft_revision:1,material_versions:[{material_id:material,material_version:1}],requirement_message_ids:[]});
    assert.equal(inputResponse.statusCode,201,inputResponse.body);
    const input=inputResponse.json();
    const manifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=1',
      [owner,project])).rows[0].manifest;
    assert.equal(manifest.issuer_identity.status,'pending');
    assert.equal(manifest.test_issuer_candidate.status,'pending_test_candidate');
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
    await addEvidence(another,'合成发行人乙',1);
    await appendIssuerIdentitySourceRecord({pool},{ownerUserId:owner,projectId:project,materialId:material,materialVersion:1,
      requestId:`issuer-${another}`,sourceRecordId:another,issuerDisplayName:'合成发行人乙',entityId:`issuer-name:${sha('合成发行人乙').slice(0,32)}`});
    assert.equal((await submit()).statusCode,202);
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages,testRuleCapabilityLoader:capability}),'paused');
    assert.equal(reached,1,'a changed issuer observation cannot pass the pinned test input');
  }finally{
    await app.close();await pool.end();
    if(oldTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=oldTier;
    if(oldSwitch===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=oldSwitch;
  }
});
