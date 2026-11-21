import assert from 'node:assert/strict';
import { Pool } from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const fail=code=>{throw new Error(code);};
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!v.includes('\0');
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export function validateRestoreReceipt(receipt,backupHash){
  if(!receipt||receipt.version!=='database-restore-safety-v1'||!text(receipt.restore_id)||!sha(receipt.backup_sha256)
    ||!sha(receipt.manifest_sha256)||!uuid(receipt.control_epoch)
    ||!receipt.audit||typeof receipt.audit.complete!=='boolean'||!Number.isFinite(Date.parse(receipt.audit.backup_at))
    ||!Number.isFinite(Date.parse(receipt.audit.covered_until))||Date.parse(receipt.audit.backup_at)>Date.parse(receipt.audit.covered_until)
    ||!Array.isArray(receipt.account_ids)||receipt.account_ids.some(id=>!text(id))||new Set(receipt.account_ids).size!==receipt.account_ids.length
    ||!Array.isArray(receipt.fences)||!Array.isArray(receipt.calls)||!Array.isArray(receipt.billing)||!Array.isArray(receipt.never_sent_runs))fail('RESTORE_RECEIPT_INVALID');
  if(receipt.backup_sha256!==backupHash)fail('RESTORE_BACKUP_HASH_MISMATCH');
  if(hash(Object.fromEntries(Object.entries(receipt).filter(([key])=>key!=='manifest_sha256')))!==receipt.manifest_sha256)fail('RESTORE_RECEIPT_HASH_MISMATCH');
  const ids=new Set();
  for(const call of receipt.calls){
    if(!['attempt_id','job_id','run_id','owner_user_id','logical_call_id'].every(key=>text(call[key]))
      ||!['confirmed_not_sent','completed_verified','unknown'].includes(call.status)||ids.has(call.attempt_id)
      ||!receipt.account_ids.includes(call.owner_user_id)||call.status==='completed_verified'&&(!text(call.result_ref)||!sha(call.result_sha256)))fail('RESTORE_RECEIPT_INVALID');
    ids.add(call.attempt_id);
  }
  const nodes=new Set();
  for(const fence of receipt.fences){
    if(!['node_id','epoch','account_id','region','instance_id','cloud_start_operation_id','stop_operation_id'].every(key=>text(fence[key]))
      ||!['source_sha256','image_sha256','launch_manifest_sha256','cloud_observation_sha256'].every(key=>sha(fence[key]))
      ||!uuid(fence.epoch)||fence.epoch===receipt.control_epoch||nodes.has(fence.node_id+':'+fence.epoch))fail('RESTORE_FENCE_INVALID');
    nodes.add(fence.node_id+':'+fence.epoch);
  }
  if(receipt.never_sent_runs.some(id=>!text(id))||new Set(receipt.never_sent_runs).size!==receipt.never_sent_runs.length
    ||new Set(receipt.billing.map(row=>row.owner_user_id)).size!==receipt.billing.length)fail('RESTORE_RECEIPT_INVALID');
  for(const row of receipt.billing)if(!receipt.account_ids.includes(row.owner_user_id)||!sha(row.sha256)||typeof row.consistent!=='boolean')fail('RESTORE_RECEIPT_INVALID');
  return receipt;
}
function readReceipt(path,backupHash){
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16*1024*1024)fail('RESTORE_RECEIPT_FILE_UNSAFE');
  const receipt=JSON.parse(readFileSync(path,'utf8'));
  return validateRestoreReceipt(receipt,backupHash??receipt.backup_sha256);
}
export function classifyRestoreCalls(jobs,attempts,receipt){
  return jobs.map(job=>{
    const reasons=[];
    const offline=receipt.calls.filter(call=>call.job_id===job.id&&call.owner_user_id===job.owner_user_id&&call.run_id===job.run_id);
    const actual=attempts.filter(call=>call.job_id===job.id&&call.owner_user_id===job.owner_user_id);
    if(!receipt.audit.complete)reasons.push('audit_incomplete');
    if(!receipt.billing.some(row=>row.owner_user_id===job.owner_user_id&&row.consistent))reasons.push('billing_unknown');
    if(offline.some(call=>!actual.some(a=>a.id===call.attempt_id&&a.logical_call_id===call.logical_call_id)))reasons.push('lost_intent');
    if(actual.some(a=>!offline.some(call=>call.attempt_id===a.id)))reasons.push('audit_missing_call');
    if(offline.some(call=>call.status==='unknown'||!actual.some(a=>a.id===call.attempt_id&&
      (call.status==='confirmed_not_sent'?a.status==='confirmed_not_sent':a.status==='completed'&&a.result_sha256?.trim()===call.result_sha256))))reasons.push('provider_unknown');
    if(!offline.length&&!receipt.never_sent_runs.includes(job.run_id))reasons.push('not_sent_unproven');
    return {job_id:job.id,run_id:job.run_id,owner_user_id:job.owner_user_id,
      classification:reasons.length?'unknown':'recovery_candidate',reasons:[...new Set(reasons)]};
  });
}
export async function freezeRestoreSource(pool,receipt){
  validateRestoreReceipt(receipt,receipt.backup_sha256);
  const c=await pool.connect();try{
    await c.query('BEGIN');await c.query('SELECT public.bb_lock_evidence_gate(true)');
    const freezeId='restore-source-freeze-'+receipt.restore_id;
    const prior=(await c.query('SELECT id FROM bb_evidence_gate_events WHERE id=$1',[freezeId])).rows[0];
    if(prior){
      const current=(await c.query('SELECT id,state,reason_code FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')).rows[0];
      if(current?.id!==freezeId||current.state!=='paused'||current.reason_code!=='database_restore_quarantine')fail('RESTORE_SOURCE_FREEZE_CHANGED');
    }else await c.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'paused','database_restore_quarantine','system')",[freezeId]);
    await c.query('UPDATE bb_execution_capacity_policy SET budget_available=false,revision=revision+1 WHERE singleton');
    await c.query('COMMIT');return {state:'frozen',restore_id:receipt.restore_id};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function verifyRestoreSource(pool,receipt){
  validateRestoreReceipt(receipt,receipt.backup_sha256);
  const {executionCloudCompletionMatches}=await import('@bondbuddy/contracts');
  const gate=(await pool.query('SELECT state,reason_code,created_at FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')).rows[0];
  if(gate?.state!=='paused'||gate.reason_code!=='database_restore_quarantine')fail('RESTORE_SOURCE_NOT_FROZEN');
  if(Date.parse(receipt.audit.covered_until)<new Date(gate.created_at).getTime())fail('RESTORE_AUDIT_INCOMPLETE');
  const nodes=(await pool.query('SELECT * FROM bb_execution_nodes')).rows;
  const operations=(await pool.query("SELECT * FROM bb_execution_cloud_operations WHERE action IN ('stop','destroy')")).rows;
  for(const fence of receipt.fences){
    const operation=operations.find(op=>op.operation_id===fence.stop_operation_id);
    const original=operation?.node_preimage;
    if(!operation||operation.state!=='completed'||!executionCloudCompletionMatches({...operation,identity:{account_id:fence.account_id,region:fence.region,instance_id:fence.instance_id,epoch:fence.epoch}},operation.cloud_observation)
      ||['account_id','region','instance_id','epoch'].some(key=>operation[key]!==fence[key])
      ||hash(operation.cloud_observation)!==fence.cloud_observation_sha256||!original
      ||original.id!==fence.node_id||['source_sha256','image_sha256','launch_manifest_sha256','cloud_start_operation_id'].some(key=>original[key]?.trim()!==fence[key]))fail('RESTORE_FENCE_UNVERIFIED');
  }
  for(const node of nodes)if(!receipt.fences.some(f=>f.node_id===node.id&&f.epoch===node.epoch))fail('RESTORE_OLD_EPOCH_UNFENCED');
  if((await pool.query(`SELECT 1 FROM bb_jobs WHERE execution_node_id IS NULL AND lease_token IS NOT NULL
    UNION ALL SELECT 1 FROM bb_review_messages WHERE execution_node_id IS NULL AND lease_token IS NOT NULL
    UNION ALL SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id IS NULL LIMIT 1`)).rows[0])fail('RESTORE_LEGACY_EXECUTION_UNFENCED');
  const owners=(await pool.query('SELECT id FROM bb_users UNION SELECT owner_user_id AS id FROM bb_jobs')).rows;
  if(owners.some(owner=>!receipt.account_ids.includes(owner.id)))fail('RESTORE_ACCOUNT_COVERAGE_INCOMPLETE');
  const attempts=(await pool.query(`SELECT a.*,trim(p.result_sha256) result_sha256 FROM bb_model_call_attempts a
    LEFT JOIN bb_provider_result_refs p ON p.attempt_id=a.id ORDER BY a.id`)).rows;
  if(receipt.audit.complete&&attempts.some(a=>!receipt.calls.some(call=>call.attempt_id===a.id&&call.job_id===a.job_id&&call.owner_user_id===a.owner_user_id&&call.logical_call_id===a.logical_call_id)))fail('RESTORE_AUDIT_INCOMPLETE');
  const jobs=(await pool.query('SELECT id,run_id,attempts,execution_session_id,checkpoint FROM bb_jobs WHERE run_id=ANY($1::text[])',[receipt.never_sent_runs])).rows;
  if(receipt.never_sent_runs.some(id=>!jobs.some(job=>job.run_id===id&&job.attempts===0&&!job.execution_session_id
    &&job.checkpoint.never_admitted_v1?.version==='never-admitted-v1'&&job.checkpoint.never_admitted_v1.job_id===job.id
    &&!attempts.some(call=>call.job_id===job.id))))fail('RESTORE_NOT_SENT_UNPROVEN');
  const {restoreBillingSnapshot}=await import('../apps/api/dist/evidence-gate.js');
  for(const row of receipt.billing)if(row.consistent&&hash(await restoreBillingSnapshot(pool,row.owner_user_id))!==row.sha256)fail('RESTORE_BILLING_SNAPSHOT_MISMATCH');
  return {state:'source_verified_frozen',manifest_sha256:receipt.manifest_sha256,old_epochs:nodes.length};
}
export async function quarantineRestoredDatabase(pool,receipt){
  validateRestoreReceipt(receipt,receipt.backup_sha256);
  const c=await pool.connect();try{
    await c.query('BEGIN');await c.query('SELECT public.bb_lock_evidence_gate(true)');
    const existing=(await c.query('SELECT * FROM bb_database_restore_quarantines WHERE id=$1',[receipt.restore_id])).rows[0];
    if(existing){
      const latest=(await c.query('SELECT id FROM bb_database_restore_quarantines ORDER BY seq DESC LIMIT 1')).rows[0];
      if(existing.manifest_sha256.trim()!==receipt.manifest_sha256||latest?.id!==existing.id)fail('RESTORE_RECEIPT_CONFLICT');
      const gate=(await c.query('SELECT state FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')).rows[0];
      await c.query('COMMIT');return {state:gate?.state==='paused'?'quarantined':'already_reconciled',restore_id:receipt.restore_id};
    }
    const nodes=(await c.query('SELECT * FROM bb_execution_nodes FOR UPDATE')).rows;
    if(nodes.some(node=>!receipt.fences.some(f=>f.node_id===node.id&&f.epoch===node.epoch
      &&['account_id','region','instance_id','source_sha256','image_sha256','launch_manifest_sha256'].every(key=>node[key]?.trim()===f[key]))))fail('RESTORE_OLD_EPOCH_UNFENCED');
    const owners=(await c.query('SELECT id FROM bb_users UNION SELECT owner_user_id AS id FROM bb_jobs')).rows;
    if(owners.some(owner=>!receipt.account_ids.includes(owner.id)))fail('RESTORE_ACCOUNT_COVERAGE_INCOMPLETE');
    const jobs=(await c.query("SELECT * FROM bb_jobs WHERE run_id IS NOT NULL AND state NOT IN ('succeeded','failed','cancelled') ORDER BY run_id,id FOR UPDATE")).rows;
    const attempts=(await c.query(`SELECT a.*,trim(p.result_sha256) result_sha256 FROM bb_model_call_attempts a
      LEFT JOIN bb_provider_result_refs p ON p.attempt_id=a.id ORDER BY a.id`)).rows;
    const classifications=classifyRestoreCalls(jobs,attempts,receipt);
    const holders=(await c.query('SELECT * FROM bb_model_capacity_holders')).rows;
    const messages=(await c.query('SELECT * FROM bb_review_messages ORDER BY id FOR UPDATE')).rows;
    const waiters=(await c.query('SELECT * FROM bb_model_capacity_waiters')).rows;
    const runs=(await c.query('SELECT * FROM bb_runs WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[jobs.map(job=>job.run_id)])).rows;
    const event='restore-quarantine-'+receipt.restore_id;
    await c.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'paused','database_restore_quarantine','system')",[event]);
    await c.query(`INSERT INTO bb_database_restore_quarantines(id,backup_sha256,manifest_sha256,control_epoch,receipt,preimage,gate_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[receipt.restore_id,receipt.backup_sha256,receipt.manifest_sha256,receipt.control_epoch,receipt,{nodes,holders,waiters,messages,jobs,runs,classifications},event]);
    await c.query('UPDATE bb_execution_capacity_policy SET budget_available=false,revision=revision+1 WHERE singleton');
    // Pending cloud-stop state already rejects admission; its existing fence cannot be bypassed.
    await c.query("UPDATE bb_execution_nodes SET state='lost',registration_token_sha256=NULL,revision=revision+1 WHERE state<>'stop_submitted'");
    for(const row of classifications){
      const quarantine={restore_id:receipt.restore_id,manifest_sha256:receipt.manifest_sha256,control_epoch:receipt.control_epoch,...row};
      await c.query("UPDATE bb_jobs SET state='paused',stage='database_restore_quarantine',checkpoint=checkpoint||jsonb_build_object('database_restore_quarantine',$2::jsonb),updated_at=clock_timestamp() WHERE id=$1",[row.job_id,quarantine]);
    }
    // Publish the isolated pause without invoking active-time billing or modifying prior usage/credits.
    for(const run of runs){
      if(['succeeded','test_completed','failed','cancelled','rejected'].includes(run.state))continue;
      const seq=run.event_cursor+1,id=randomUUID(),stage='database_restore_quarantine';
      const payload={reason:stage,restore_id:receipt.restore_id,manifest_sha256:receipt.manifest_sha256,channel:run.channel??'production'};
      await c.query('UPDATE bb_runs SET state=\'paused\',stage=$2,event_cursor=$3,updated_at=clock_timestamp() WHERE id=$1',[run.id,stage,seq]);
      await c.query("INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$3,'run.state_changed','paused',$5,$6)",[id,run.owner_user_id,run.id,seq,stage,payload]);
      await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'run',$3,'run.state_changed',$4)",[randomUUID(),run.owner_user_id,run.id,{run_id:run.id,event_id:id,seq,state:'paused',stage,...payload}]);
    }
    await c.query('COMMIT');return {state:'quarantined',restore_id:receipt.restore_id,unknown:classifications.filter(r=>r.classification==='unknown').length};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

async function verifyLegacyRestore(){
const { azureBlobs, digest } = await import('../apps/api/dist/data.js');
const { createServer } = await import('../apps/api/dist/server.js');
if (!process.env.DATABASE_URL || !process.env.RESTORE_DATABASE_URL) throw new Error('DATABASE_URL and RESTORE_DATABASE_URL required');
const source=new Pool({connectionString:process.env.DATABASE_URL});
const restored=new Pool({connectionString:process.env.RESTORE_DATABASE_URL});
try {
  for(const table of ['bb_schema_migrations','bb_projects','bb_uploads','bb_material_versions','bb_input_revisions','bb_runs','bb_run_events','bb_outbox','bb_artifact_versions','bb_artifact_download_grants','bb_jobs','bb_model_call_attempts','bb_operations','bb_snapshot_refs','bb_usage_observations','bb_observability_errors','bb_observability_events','bb_log_access_audit','bb_provider_result_refs','bb_provider_call_observations']){
    const a=await source.query(`SELECT count(*)::int AS n FROM ${table}`),b=await restored.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(b.rows[0].n,a.rows[0].n,`${table} count`);
  }
  const client=await restored.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query('SELECT 1 FROM bb_input_revisions LIMIT 1')).rowCount) await assert.rejects(client.query("UPDATE bb_input_revisions SET input_hash=repeat('a',64) WHERE project_id=(SELECT project_id FROM bb_input_revisions LIMIT 1)"),error=>error.code==='23514');
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    if ((await client.query('SELECT 1 FROM bb_runs LIMIT 1')).rowCount) await assert.rejects(client.query('INSERT INTO bb_runs SELECT * FROM bb_runs LIMIT 1'),error=>error.code==='23505');
    await client.query('ROLLBACK');
  } finally {client.release();}
  const snapshot=(await restored.query('SELECT id FROM bb_snapshot_refs LIMIT 1')).rows[0];
  if(snapshot){await assert.rejects(restored.query('UPDATE bb_snapshot_refs SET version=version+1 WHERE id=$1',[snapshot.id]),error=>error.code==='23514');}
  const usage=(await restored.query('SELECT id FROM bb_usage_observations LIMIT 1')).rows[0];
  if(usage){await assert.rejects(restored.query('DELETE FROM bb_usage_observations WHERE id=$1',[usage.id]),error=>error.code==='23514');}
  const providerResult=(await restored.query('SELECT * FROM bb_provider_result_refs ORDER BY created_at,id LIMIT 1')).rows[0];
  if(providerResult){
    const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
    if(!blobConnection)throw new Error('BB_TEST_AZURITE_CONNECTION_STRING is required to verify restored provider result bytes');
    const blob=azureBlobs(blobConnection,process.env.BB_TEST_PROVIDER_RESULT_CONTAINER ?? 'bondbuddy-private');
    const bytes=await blob.get(providerResult.result_ref);
    assert.equal(bytes.length,Number(providerResult.byte_size),'provider result byte size after restore');
    assert.equal(digest(bytes),providerResult.result_sha256.trim(),'provider result SHA-256 after restore');
    assert.doesNotThrow(()=>JSON.parse(bytes.toString('utf8')),'provider result JSON after restore');
    const checkpoint=(await restored.query('SELECT checkpoint FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 AND run_id=$3',[providerResult.owner_user_id,providerResult.job_id,providerResult.run_id])).rows[0];
    const refs=checkpoint?.checkpoint?.provider_results ?? [];
    assert.ok(refs.some(ref=>ref.call_id===providerResult.call_id&&ref.result_id===providerResult.id&&ref.result_sha256===providerResult.result_sha256.trim()),'restored job checkpoint points at immutable provider result');
    const observation=(await restored.query("SELECT id FROM bb_provider_call_observations WHERE owner_user_id=$1 AND project_id=$2 AND job_id=$3 AND run_id=$4 AND attempt_id=$5 AND result_id=$6 LIMIT 1",[providerResult.owner_user_id,providerResult.project_id,providerResult.job_id,providerResult.run_id,providerResult.attempt_id,providerResult.id])).rows[0];
    assert.ok(observation,'restored provider result has its owner/run/call observation');
    await assert.rejects(restored.query('UPDATE bb_provider_result_refs SET result_sha256=repeat(\'a\',64) WHERE id=$1',[providerResult.id]),error=>error.code==='23514');
    await assert.rejects(restored.query('DELETE FROM bb_provider_call_observations WHERE id=$1',[observation.id]),error=>error.code==='23514');
  }
  const app=createServer({pool:restored,principal:async()=>({userId:'synthetic-alice',csrfVerified:true}),allowedOrigin:'http://bondbuddy.test',enableRunStaging:true});
  try {
    const project=(await restored.query("SELECT id FROM bb_projects WHERE owner_user_id='synthetic-alice' ORDER BY created_at LIMIT 1")).rows[0];
    if(project){const stale=await app.inject({method:'PATCH',url:`/api/v1/projects/${project.id}`,headers:{origin:'http://bondbuddy.test','if-match':'1'},payload:{name:'restore-conflict'}});
    assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'INPUT_REVISION_CONFLICT');}
    const run=(await restored.query("SELECT * FROM bb_runs WHERE owner_user_id='synthetic-alice' LIMIT 1")).rows[0];
    if(run){const key=await app.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin:'http://bondbuddy.test'},payload:{execution_request_id:run.execution_request_id,project_id:run.project_id,input_revision:run.input_revision,input_hash:run.input_hash.trim(),task_kind:run.task_kind,input_manifest_ref:'changed-after-restore',storage_origin:'cloud',workspace_id:'restore-check'}});
    assert.equal(key.statusCode,409);assert.equal(key.json().code,'IDEMPOTENCY_CONFLICT');}
  } finally {await app.close();}
  process.stdout.write('Restore counts, provider Blob hash/checkpoint, and snapshot/unique/immutability constraints verified\n');
} finally {await source.end();await restored.end();}
}
async function main(){
  const [mode,path,backupHash]=process.argv.slice(2);
  if(!mode||!mode.startsWith('--restore-'))return verifyLegacyRestore();
  const receipt=readReceipt(path,backupHash);
  if(mode==='--restore-safety-dry'){process.stdout.write(JSON.stringify({state:'validated_frozen',restore_id:receipt.restore_id,manifest_sha256:receipt.manifest_sha256})+'\n');return;}
  const target=mode==='--restore-safety-apply'?process.env.RESTORE_DATABASE_URL:process.env.DATABASE_URL;
  if(!target)fail('RESTORE_DATABASE_URL_REQUIRED');
  if(mode==='--restore-safety-apply'&&target===process.env.DATABASE_URL)fail('RESTORE_DATABASE_NOT_ISOLATED');
  const pool=new Pool({connectionString:target});try{
    if(mode==='--restore-safety-apply'){
      if(!process.env.DATABASE_URL)fail('RESTORE_SOURCE_DATABASE_URL_REQUIRED');
      const actual=(await pool.query('SELECT current_database() AS name')).rows[0].name;
      const sourceName=process.env.DATABASE_URL?decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)):'bondbuddy';
      if(actual===sourceName||actual!==process.env.BB_RESTORE_DATABASE_NAME)fail('RESTORE_DATABASE_NOT_ISOLATED');
      // This entry point is safe even when invoked directly, without restore.sh's earlier preflight.
      const source=new Pool({connectionString:process.env.DATABASE_URL});
      try{await verifyRestoreSource(source,receipt);}finally{await source.end();}
    }
    const result=mode==='--restore-freeze'?await freezeRestoreSource(pool,receipt):mode==='--restore-safety-preflight'?await verifyRestoreSource(pool,receipt):mode==='--restore-safety-apply'?await quarantineRestoredDatabase(pool,receipt):fail('RESTORE_MODE_INVALID');
    process.stdout.write(JSON.stringify(result)+'\n');
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
