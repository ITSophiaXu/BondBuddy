import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {action,fenceRestoredExecutionEpoch,resumeRestoredRun,resumePausedRun} from './queue.js';
import {restoreCanonical,restoreBillingSnapshot,resumeDatabaseRestoreGate} from './evidence-gate.js';
import {digest,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {savePromptSnapshot} from './log-ops.js';
import {isolatedTestDatabase} from './test-database.js';
const connection=await isolatedTestDatabase(undefined,'workflow-restore'),h='a'.repeat(64);
// Synthetic SQL/cloud evidence and in-memory private bytes; no production or provider calls.
test('restored original tokens require exact Stop proof and a reconciled account before the one resume entry',{skip:!connection},async t=>{
 const pool=new Pool({connectionString:connection});t.after(()=>pool.end());
 const owner=randomUUID(),id=randomUUID(),nodeId=randomUUID(),epoch=randomUUID(),session=randomUUID(),token=randomUUID(),attemptId=randomUUID(),restoreId=randomUUID();
 const objects=new Map<string,Buffer>(),blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,getIfExistsBounded:async(k,max)=>{const b=objects.get(k);return b&&b.length<=max?b:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'restore_'+owner.slice(0,8)]);
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic restore','generation')",[id,owner]);
 const manifest={synthetic:true},inputHash=inputManifestHash(manifest);
 await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,inputHash,manifest]);
 await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'running')",[id,owner,inputHash]);
 await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,attempts) VALUES($1,$2,$1,'generation','default','running',1)",[id,owner]);
 await pool.query("INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,cloud_start_operation_id) VALUES($1,'synthetic','synthetic','synthetic-node',$2,'lost',$3,$3,$3,ARRAY['authoring'],'[]','synthetic-start')",[nodeId,epoch,h]);
 await pool.query("INSERT INTO bb_execution_node_sessions(session_id,node_id,epoch,service_id,state,process_identity,ready) VALUES($1,$2,$3,'synthetic','lost','{}',false)",[session,nodeId,epoch]);
 // Preserve an old backed-up lease without manufacturing a fresh claim.
 await pool.query('UPDATE bb_jobs SET lease_token=$2,lease_until=now()-interval \'1 hour\',execution_node_id=$3,execution_node_epoch=$4,execution_session_id=$5 WHERE id=$1',[id,token,nodeId,epoch,session]);
 await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,'synthetic-original-call',1,'pending_reconcile')",[attemptId,owner,id]);
 const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:id,runId:id,kind:'model_request',body:'Synthetic original prompt',inputRevision:1,inputHash,templateVersion:'synthetic-restore-v1'});
 const node=(await pool.query('SELECT row_to_json(n) AS record FROM bb_execution_nodes n WHERE id=$1',[nodeId])).rows[0].record,job=(await pool.query('SELECT row_to_json(j) AS record FROM bb_jobs j WHERE id=$1',[id])).rows[0].record;
 const observation={instance_state:'STOPPED',latest_operation:'StopInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:'synthetic-stop-ack',stop_charging_mode:'STOP_CHARGING',observed_at:new Date().toISOString(),evidence_ref:'synthetic/raw-cloud',evidence_sha256:h};
 const operation={operation_id:'synthetic-stop',account_id:'synthetic',region:'synthetic',instance_id:'synthetic-node',epoch,action:'stop',state:'completed',provider_request_id:'synthetic-stop-ack',cloud_observation:observation};
 const body={version:'database-restore-safety-v1',restore_id:restoreId,backup_sha256:h,control_epoch:randomUUID(),audit:{complete:true,backup_at:new Date(Date.now()-3600000).toISOString(),covered_until:new Date().toISOString()},account_ids:[owner],
  fences:[{node_id:nodeId,epoch,account_id:'synthetic',region:'synthetic',instance_id:'synthetic-node',cloud_start_operation_id:'synthetic-start',stop_operation_id:'synthetic-stop',source_sha256:h,image_sha256:h,launch_manifest_sha256:h,cloud_observation_sha256:digest(restoreCanonical(observation))}],
  calls:[{attempt_id:attemptId,job_id:id,run_id:id,owner_user_id:owner,logical_call_id:'synthetic-original-call',status:'confirmed_not_sent'}],billing:[{owner_user_id:owner,sha256:digest(restoreCanonical(await restoreBillingSnapshot(pool,owner))),consistent:true}],never_sent_runs:[]};
 const sha=digest(restoreCanonical(body)),receipt={...body,manifest_sha256:sha},gateId=randomUUID();
 await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'paused','database_restore_quarantine','system')",[gateId]);
 await pool.query('INSERT INTO bb_database_restore_quarantines(id,backup_sha256,manifest_sha256,control_epoch,receipt,preimage,gate_event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[restoreId,h,sha,body.control_epoch,receipt,{nodes:[node],jobs:[job],holders:[],messages:[],waiters:[]},gateId]);
 await pool.query("UPDATE bb_jobs SET state='paused',stage='database_restore_quarantine',checkpoint=jsonb_build_object('database_restore_quarantine',$2::jsonb) WHERE id=$1",[id,{restore_id:restoreId,manifest_sha256:sha,control_epoch:body.control_epoch,job_id:id,run_id:id,owner_user_id:owner,classification:'unknown',reasons:['provider_unknown']}]);
 const input={quarantineId:restoreId,manifestSha256:sha,nodeId,epoch,expectedTokens:[{kind:'job' as const,id,token}],evidenceRef:'synthetic/operation'};
 const readObject=async()=>Buffer.from(JSON.stringify(operation));
 await assert.rejects(fenceRestoredExecutionEpoch(pool,'synthetic-operator',{...input,epoch:randomUUID()},{readObject}),/missing or changed/);
 await assert.rejects(fenceRestoredExecutionEpoch(pool,'synthetic-operator',{...input,expectedTokens:[{kind:'job',id,token:randomUUID()}]},{readObject}),/token preimage changed/);
 await assert.rejects(fenceRestoredExecutionEpoch(pool,'synthetic-operator',input,{readObject:async()=>Buffer.from(JSON.stringify({...operation,state:'submitted'}))}),/Stop completion is unproven/);
 assert.equal((await pool.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[id])).rows[0].lease_token,token);
 const release=await fenceRestoredExecutionEpoch(pool,'synthetic-operator',input,{readObject});assert.equal(release.idempotent,false);
 assert.equal((await fenceRestoredExecutionEpoch(pool,'synthetic-operator',input,{readObject})).idempotent,true);
 assert.equal((await pool.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[id])).rows[0].lease_token,null);
 assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[attemptId])).rows[0].status,'pending_reconcile');
 await assert.rejects(resumeDatabaseRestoreGate(pool,'synthetic-operator',{quarantine_id:restoreId,manifest_sha256:sha,owner_user_ids:[owner]},async ref=>objects.get(ref)!),/incomplete or changed/);
 await pool.query("UPDATE bb_model_call_attempts SET status='confirmed_not_sent' WHERE id=$1",[attemptId]);
 await pool.query(`INSERT INTO bb_provider_call_observations(id,owner_user_id,project_id,job_id,run_id,attempt_id,logical_call_id,attempt_no,call_id,trace_id,model_id,model_config_version,prompt_snapshot_ref,outcome,usage_status,observation_hash)
  VALUES($1,$2,$3,$3,$3,$4,'synthetic-original-call',1,$4,$3,'synthetic','synthetic-restore',$5,'confirmed_not_sent','unknown',$6)`,[randomUUID(),owner,id,attemptId,snapshot,h]);
 await resumeDatabaseRestoreGate(pool,'synthetic-operator',{quarantine_id:restoreId,manifest_sha256:sha,owner_user_ids:[owner]},async ref=>objects.get(ref)!);
 assert.equal(await resumePausedRun(pool,owner,id,'provider_reconciled',{blobs}),false);
 await assert.rejects(action(pool,owner,id,'resume',undefined,{blobs}),/dedicated verified recovery/);
 assert.equal(await resumeRestoredRun(pool,'synthetic-operator',owner,id,{quarantineId:restoreId,manifestSha256:'b'.repeat(64)},{blobs}),false);
 assert.deepEqual((await Promise.all([resumeRestoredRun(pool,'synthetic-operator',owner,id,{quarantineId:restoreId,manifestSha256:sha},{blobs}),resumeRestoredRun(pool,'synthetic-operator',owner,id,{quarantineId:restoreId,manifestSha256:sha},{blobs})])).sort(),[false,true]);
 assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[id])).rows[0].state,'queued');
 assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[attemptId])).rows[0].status,'confirmed_not_sent');
 assert.equal(digest(restoreCanonical(await restoreBillingSnapshot(pool,owner))),body.billing[0]!.sha256);
 await assert.rejects(pool.query('DELETE FROM bb_database_restore_fence_releases WHERE id=$1',[release.id]),/immutable|snapshot/i);
});
