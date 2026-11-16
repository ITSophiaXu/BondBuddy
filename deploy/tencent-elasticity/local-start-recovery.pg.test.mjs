import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {cancelLocalStartBeforeSubmission} from './local-start-recovery.mjs';

const canonical=v=>JSON.stringify((function sort(x){return Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;})(v));
const hash=v=>createHash('sha256').update(v).digest('hex');

// Synthetic operation and inventory; real PostgreSQL, migration and epoch fence.
test('local non-submission cancellation preserves history and full node CAS',async()=>{
  assert.ok(process.env.BB_LOCAL_RECOVERY_TEST_URL,'Dedicated local PostgreSQL connection required');
  const schema='local_cancel_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:process.env.BB_LOCAL_RECOVERY_TEST_URL});
  const pool=new Pool({connectionString:process.env.BB_LOCAL_RECOVERY_TEST_URL,options:`-c search_path=${schema}`});
  const dir=await mkdtemp('/data/workspaces/bb-local-start-cancellation-test-');
  try{
    await chmod(dir,0o700);await admin.query(`CREATE SCHEMA ${schema}`);
    const original=await readFile(new URL('../../db/migrations/0181_execution_node_capacity.sql',import.meta.url),'utf8');
    await pool.query(original.slice(original.indexOf('CREATE TABLE bb_execution_capacity_policy'),original.indexOf('CREATE INDEX bb_execution_cloud_pending')));
    await pool.query(`ALTER TABLE bb_execution_cloud_operations ADD COLUMN run_acceptance jsonb,ADD COLUMN authorization_denial jsonb;
      CREATE TABLE bb_model_capacity_holders(execution_node_id text);
      CREATE TABLE bb_jobs(execution_node_id text,lease_token text);
      CREATE TABLE bb_review_messages(execution_node_id text,lease_token text);`);
    await pool.query(original.slice(original.indexOf('CREATE FUNCTION bb_execution_guard_epoch()'),original.indexOf('-- Eligibility observation only.')));
    await pool.query(await readFile(new URL('../../db/migrations/0187_execution_local_start_cancellation.sql',import.meta.url),'utf8'));
    const h='a'.repeat(64),id=randomUUID(),epoch=randomUUID(),priorEpoch=randomUUID(),stopId=randomUUID(),stopAck=randomUUID();
    const request={account_id:'synthetic-account',region:'ap-beijing',instance_id:'ins-synthetic',instance_count:1,epoch,source_sha256:h,image_sha256:h,
      launch_manifest_sha256:h,capabilities:['authoring'],services:[{service_id:'authoring',capabilities:['authoring']}]};
    await pool.query(`INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,revision,source_sha256,image_sha256,launch_manifest_sha256,
      capabilities,expected_services,cloud_start_operation_id,stop_operation_id) VALUES('node',$1,$2,$3,$4,'stopped',11,$5,$5,$5,$6,$7,'prior-start',$8)`,
      [request.account_id,request.region,request.instance_id,priorEpoch,h,request.capabilities,JSON.stringify(request.services),stopId]);
    const prior=(await pool.query('SELECT to_jsonb(n) AS v FROM bb_execution_nodes n')).rows[0].v;
    await pool.query("UPDATE bb_execution_nodes SET state='starting',epoch=$1,revision=12,cloud_start_operation_id=$2,stop_operation_id=NULL",[epoch,id]);
    const reserved=(await pool.query('SELECT to_jsonb(n) AS v FROM bb_execution_nodes n')).rows[0].v;
    const observation={instance_state:'STOPPED',latest_operation:'StopInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:stopAck,stop_charging_mode:'STOP_CHARGING'};
    await pool.query(`INSERT INTO bb_execution_cloud_operations(operation_id,account_id,region,instance_id,epoch,action,state,request_sha256,client_token,provider_request_id,cloud_observation)
      VALUES($1,$2,$3,$4,$5,'stop','completed',$6,'synthetic-stop-token',$7,$8)`,[stopId,request.account_id,request.region,request.instance_id,priorEpoch,h,stopAck,observation]);
    const dispatchedAt='2026-11-16T02:07:54.97933Z';
    await pool.query(`INSERT INTO bb_execution_cloud_operations(operation_id,account_id,region,instance_id,epoch,action,state,revision,request,request_sha256,client_token,
      dispatched_at,node_preimage,reserved_node_preimage) VALUES($1,$2,$3,$4,$5,'start','unknown',2,$6,$7,$8,$9,$10,$11)`,
      [id,request.account_id,request.region,request.instance_id,epoch,request,hash(canonical(request)),hash(canonical(id)),dispatchedAt,prior,reserved]);
    async function file(name,value){const path=dir+'/'+name,bytes=Buffer.from(JSON.stringify(value));await writeFile(path,bytes,{mode:0o600});return {path,bytes:bytes.length,sha256:hash(bytes)};}
    const currentManifest='b'.repeat(64),businessOverlaySha256='c'.repeat(64),inventoryRequestId=randomUUID();
    const proof=await file('proof.json',{version:'unknown-start-exact-local-preflight-v1',operation_id:id,state:'unknown',provider_request_id:null,cloud_mutations:0,
      exact_local_gate:'WARM_START_CLOUD_MANIFEST_DRIFT',legacy_matches:true,new_matches:false,current_bootstrap_manifest:currentManifest,new_pin:businessOverlaySha256,
      expected_creation_manifest_sha256:h,original_without_business_bootstrap:h});
    const inventory=await file('inventory.json',{TotalCount:1,RequestId:inventoryRequestId,InstanceSet:[{InstanceId:request.instance_id,ImageId:'img-synthetic',
      InstanceState:'STOPPED',StopChargingMode:'STOP_CHARGING',LatestOperation:'StopInstances',LatestOperationState:'SUCCESS',LatestOperationRequestId:stopAck}]});
    const pin={operationId:id,operationRevision:2,requestSha256:hash(canonical(request)),dispatchedAt,nodeRevision:12,epoch,priorEpoch,priorStopId:stopId,stopAck,
      accountId:request.account_id,region:request.region,instanceId:request.instance_id,imageId:'img-synthetic',creationManifest:h,currentManifest,businessOverlaySha256,inventoryRequestId,proof,inventory};
    const recover=p=>cancelLocalStartBeforeSubmission(pool,{...pin,...p});
    // Missing/stale evidence, CAS, and any uncertain cloud ACK cannot cancel.
    await assert.rejects(recover({proof:{...proof,sha256:h}}));
    await assert.rejects(recover({operationRevision:3}));
    await assert.rejects(recover({nodeRevision:13}));
    await assert.rejects(recover({requestSha256:h}));
    await pool.query("UPDATE bb_execution_cloud_operations SET provider_request_id='unexpected-ack' WHERE operation_id=$1",[id]);
    await assert.rejects(recover());
    await pool.query('UPDATE bb_execution_cloud_operations SET provider_request_id=NULL WHERE operation_id=$1',[id]);
    await pool.query("INSERT INTO bb_jobs VALUES('node','active-lease')");await assert.rejects(recover());await pool.query('DELETE FROM bb_jobs');
    // A changed field outside the normal DTO still invalidates the full image.
    await pool.query("UPDATE bb_execution_nodes SET idle_since=clock_timestamp()");await assert.rejects(recover());
    await pool.query('UPDATE bb_execution_nodes SET idle_since=NULL');
    const before=(await pool.query('SELECT to_jsonb(o) AS v FROM bb_execution_cloud_operations o WHERE operation_id=$1',[id])).rows[0].v;
    // A bare cancelled label still cannot bypass the actual epoch trigger.
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query("UPDATE bb_execution_cloud_operations SET state='cancelled' WHERE operation_id=$1",[id]);
      await assert.rejects(client.query("UPDATE bb_execution_nodes SET state='stopped',epoch=$1,revision=13",[priorEpoch]),/Prior node epoch/);
      await client.query('ROLLBACK');
    }finally{client.release();}
    const result=await recover();assert.equal(result.state,'cancelled');assert.equal(result.revision,3);assert.deepEqual(result.node,{...prior,revision:13});
    const after=(await pool.query('SELECT to_jsonb(o) AS v FROM bb_execution_cloud_operations o WHERE operation_id=$1',[id])).rows[0].v;
    assert.deepEqual(after.local_preflight_cancellation.original_operation,before);
    assert.equal(after.dispatched_at,before.dispatched_at);assert.equal(after.provider_request_id,null);assert.equal(after.cloud_observation,null);
    for(const key of Object.keys(before).filter(k=>!['state','revision','completed_at','local_preflight_cancellation'].includes(k)))assert.deepEqual(after[key],before[key]);
    assert.equal((await recover()).already_completed,true);
    assert.equal(Number((await pool.query("SELECT count(*) FROM bb_execution_cloud_operations WHERE state IN ('intent','submitted','unknown')")).rows[0].count),0);
    await assert.rejects(pool.query("UPDATE bb_execution_cloud_operations SET state='unknown' WHERE operation_id=$1",[id]),/immutable/);
  }finally{
    await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});
  }
});
