import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

const fail=()=>{throw Error('LOCAL_START_NON_SUBMISSION_UNPROVEN');};
const requireThat=value=>{if(!value)fail();};
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const canonical=v=>JSON.stringify(sorted(v));
const digest=v=>createHash('sha256').update(v).digest('hex');
const equal=(a,b)=>canonical(a)===canonical(b);

async function pinnedJson(ref){
  requireThat(ref&&isAbsolute(ref.path)&&/^[a-f0-9]{64}$/.test(ref.sha256)&&Number.isSafeInteger(ref.bytes));
  requireThat(await realpath(dirname(ref.path))===dirname(ref.path));
  const file=await open(ref.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await file.stat();
    requireThat(before.isFile()&&before.uid===process.getuid()&&(before.mode&0o777)===0o600&&before.nlink===1&&before.size===ref.bytes&&before.size<=131072);
    const bytes=await file.readFile(),after=await file.stat(),path=await lstat(ref.path);
    requireThat(before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&
      !path.isSymbolicLink()&&path.ino===after.ino&&path.dev===after.dev&&digest(bytes)===ref.sha256);
    return JSON.parse(bytes.toString('utf8'));
  }finally{await file.close();}
}

/** Explicit trusted local recovery only. No HTTP entry, cloud SDK or redispatch.
 * pin is the operator's reviewed single-operation evidence and CAS, never input
 * from a runtime, tick, queue item or public request. A stopped inventory alone
 * cannot prove non-submission: the separately pinned local failure is required.
 */
export async function cancelLocalStartBeforeSubmission(pool,pin){
  const proof=await pinnedJson(pin.proof),inventory=await pinnedJson(pin.inventory);
  requireThat(proof.version==='unknown-start-exact-local-preflight-v1'&&proof.operation_id===pin.operationId&&proof.state==='unknown'&&
    proof.provider_request_id===null&&proof.cloud_mutations===0&&proof.exact_local_gate==='WARM_START_CLOUD_MANIFEST_DRIFT'&&
    proof.legacy_matches===true&&proof.new_matches===false&&proof.current_bootstrap_manifest===pin.currentManifest&&
    proof.new_pin===pin.businessOverlaySha256&&proof.expected_creation_manifest_sha256===pin.creationManifest&&
    proof.original_without_business_bootstrap===pin.creationManifest&&pin.currentManifest!==pin.creationManifest);
  const i=inventory.InstanceSet?.[0];
  requireThat(inventory.RequestId===pin.inventoryRequestId&&inventory.TotalCount===1&&inventory.InstanceSet.length===1&&
    i.InstanceId===pin.instanceId&&i.ImageId===pin.imageId&&i.InstanceState==='STOPPED'&&i.StopChargingMode==='STOP_CHARGING'&&
    i.LatestOperation==='StopInstances'&&i.LatestOperationState==='SUCCESS'&&i.LatestOperationRequestId===pin.stopAck);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    // Same lock order as reservation, completion and never-dispatched cancel.
    await client.query('SELECT singleton FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE');
    const n=(await client.query('SELECT to_jsonb(n) AS value FROM bb_execution_nodes n WHERE account_id=$1 AND region=$2 AND instance_id=$3 FOR UPDATE',
      [pin.accountId,pin.region,pin.instanceId])).rows[0]?.value;
    const result=await client.query('SELECT to_jsonb(o) AS value,dispatched_at=$2::timestamptz AS dispatch_matches FROM bb_execution_cloud_operations o WHERE operation_id=$1 FOR UPDATE',
      [pin.operationId,pin.dispatchedAt]);
    const o=result.rows[0]?.value;
    requireThat(o&&n&&o.action==='start'&&o.account_id===pin.accountId&&o.region===pin.region&&o.instance_id===pin.instanceId&&
      o.request_sha256===pin.requestSha256&&digest(canonical(o.request))===pin.requestSha256&&result.rows[0].dispatch_matches&&
      o.client_token===digest(canonical(pin.operationId))&&o.epoch===pin.epoch&&o.provider_request_id===null&&
      o.cloud_observation===null&&o.run_acceptance===null&&o.rejection_evidence===null&&o.authorization_denial===null);
    const prior=o.node_preimage,reserved=o.reserved_node_preimage;
    requireThat(prior&&reserved&&prior.id===n.id&&prior.account_id===pin.accountId&&prior.region===pin.region&&prior.instance_id===pin.instanceId&&
      prior.state==='stopped'&&prior.destroyed_at===null&&prior.epoch===pin.priorEpoch&&prior.stop_operation_id===pin.priorStopId&&
      reserved.state==='starting'&&reserved.epoch===pin.epoch&&reserved.revision===pin.nodeRevision&&reserved.cloud_start_operation_id===pin.operationId&&
      o.request.account_id===pin.accountId&&o.request.region===pin.region&&o.request.instance_id===pin.instanceId&&o.request.epoch===pin.epoch&&
      o.request.launch_manifest_sha256===pin.creationManifest&&prior.launch_manifest_sha256===pin.creationManifest&&
      reserved.launch_manifest_sha256===pin.creationManifest&&prior.source_sha256===reserved.source_sha256&&prior.image_sha256===reserved.image_sha256&&
      o.request.source_sha256===reserved.source_sha256&&o.request.image_sha256===reserved.image_sha256&&
      equal(o.request.services,reserved.expected_services)&&equal([...o.request.capabilities].sort(),[...reserved.capabilities].sort()));
    const restored={...prior,revision:pin.nodeRevision+1};
    if(o.local_preflight_cancellation){
      requireThat(o.state==='cancelled'&&o.revision===pin.operationRevision+1&&equal(n,restored)&&
        o.local_preflight_cancellation.proof_sha256===pin.proof.sha256&&o.local_preflight_cancellation.inventory_sha256===pin.inventory.sha256);
      await client.query('COMMIT');return {state:'cancelled',operation_id:o.operation_id,revision:o.revision,node:n,already_completed:true};
    }
    requireThat(o.state==='unknown'&&o.revision===pin.operationRevision&&n.revision===pin.nodeRevision&&equal(n,reserved));
    const stop=(await client.query('SELECT * FROM bb_execution_cloud_operations WHERE operation_id=$1 FOR SHARE',[pin.priorStopId])).rows[0];
    const observation=stop?.cloud_observation;
    requireThat(stop?.action==='stop'&&stop.state==='completed'&&stop.account_id===pin.accountId&&stop.region===pin.region&&stop.instance_id===pin.instanceId&&
      stop.epoch===pin.priorEpoch&&stop.provider_request_id===pin.stopAck&&observation?.instance_state==='STOPPED'&&
      observation.latest_operation==='StopInstances'&&observation.latest_operation_state==='SUCCESS'&&observation.latest_operation_request_id===pin.stopAck&&
      observation.stop_charging_mode==='STOP_CHARGING');
    requireThat((await client.query(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM bb_execution_node_sessions WHERE node_id=$1 AND epoch=$2) OR
      EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=$1) OR
      EXISTS(SELECT 1 FROM bb_jobs WHERE execution_node_id=$1 AND lease_token IS NOT NULL) OR
      EXISTS(SELECT 1 FROM bb_review_messages WHERE execution_node_id=$1 AND lease_token IS NOT NULL)`,[n.id,n.epoch])).rowCount===0);
    const audit={version:'execution-local-start-cancellation-v1',reason:proof.exact_local_gate,original_operation:o,
      proof_sha256:pin.proof.sha256,inventory_sha256:pin.inventory.sha256,proof,inventory_request_id:inventory.RequestId,
      stopped_provider_request_id:pin.stopAck};
    const cancelled=await client.query(`UPDATE bb_execution_cloud_operations SET state='cancelled',revision=revision+1,
      completed_at=clock_timestamp(),local_preflight_cancellation=$2 WHERE operation_id=$1 AND to_jsonb(bb_execution_cloud_operations)=$3::jsonb RETURNING revision`,
      [pin.operationId,audit,o]);
    requireThat(cancelled.rowCount===1);
    // The trigger independently checks exact full preimages and absence of work.
    const update=await client.query(`UPDATE bb_execution_nodes n SET epoch=prior.epoch,state=prior.state,revision=n.revision+1,
      source_sha256=prior.source_sha256,image_sha256=prior.image_sha256,capabilities=prior.capabilities,
      cloud_start_operation_id=prior.cloud_start_operation_id,expected_services=prior.expected_services,
      launch_manifest_sha256=prior.launch_manifest_sha256,stop_operation_id=prior.stop_operation_id,
      drain_operation_id=prior.drain_operation_id,drain_proof=prior.drain_proof,registration_token_sha256=prior.registration_token_sha256
      FROM jsonb_populate_record(NULL::bb_execution_nodes,$2::jsonb) prior WHERE n.id=$1 AND to_jsonb(n)=$3::jsonb RETURNING to_jsonb(n) AS value`,
      [n.id,prior,reserved]);
    requireThat(update.rowCount===1&&equal(update.rows[0].value,restored));
    await client.query('COMMIT');
    return {state:'cancelled',operation_id:pin.operationId,revision:Number(cancelled.rows[0].revision),node:update.rows[0].value,already_completed:false};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
