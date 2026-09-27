import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import { runPipelineOnce, type RunStage } from './run-pipeline.js';
import { runGrantCommand } from './non-production-test-grants.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl=await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL');
const origin='http://bondbuddy.test';

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
  {skip:!databaseUrl || !process.env.BB_TEST_AZURITE_CONNECTION_STRING || !process.env.BB_PYTHON_BIN},async()=>{
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
    const project=(await send('POST','/api/v1/projects',{name:'Synthetic test Word',kind:'update',issuer_name:null,market:null,offering:null})).json().project_id;
    const input=(await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]})).json();
    const grantId=randomUUID(),sample='a'.repeat(64),taxonomy='b'.repeat(64),pack='c'.repeat(64);
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic',now()+interval '1 hour')`,
      [grantId,user,project,input.input_hash,sample,taxonomy,pack]);
    const submitted=await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:project,input_revision:1,input_hash:input.input_hash,
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
