import {lockStorageObject} from './storage-object-lock.js';
import type {Pool,PoolClient} from 'pg';
import {schemas,type Material} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {Problem,project,transaction,uid,missing,conflict,materialDto,type PrivateBlobs} from './data.js';
import {completeStoredUpload,prepareStoredUpload,type UploadDeclaration} from './complete-upload.js';
import {cachedUploadVersion} from './upload-integrity.js';
import {configuredUploadInspectionException,uploadInspectionExceptionMatches} from './upload-inspection-exception.js';

export type UploadConfirmationLease={id:string;owner:string;projectId:string;uploadId:string;token:string;requestId:string;declaration:UploadDeclaration;upload:any;excepted:boolean;attempts:number};
const pending=(uploadId:string)=>({status:'confirming' as const,upload_id:uploadId});
function restoreError(e:any):Problem{
  return new Problem(e.status,e.code,e.message,e.uploadReason,e.uploadDetail);
}
function safeError(error:unknown){
  const e=error instanceof Problem?error:new Problem(503,'DATA_UNAVAILABLE','Upload confirmation is temporarily unavailable');
  return {status:e.status,code:e.code,message:e.message,...(e.uploadReason?{uploadReason:e.uploadReason}:{}),...(e.uploadDetail?{uploadDetail:e.uploadDetail}:{})};
}

/** Enqueue and pin before replying. Polls authorize the original upload, never an arbitrary material ID. */
export async function requestUploadConfirmation(pool:Pool,blobs:PrivateBlobs,owner:string,projectId:string,uploadId:string,b:UploadDeclaration,requestId:string,inspectionException:ReturnType<typeof configuredUploadInspectionException>=null){
  const c=await transaction(pool,async client=>{
    await project(client,owner,projectId,true);
    const u=(await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[owner,projectId,uploadId])).rows[0];
    if(!u||u.state==='deleting'||u.state==='purged')throw missing();
    if(Number(u.byte_size)!==b.byte_size||u.sha256.trim()!==b.sha256)throw conflict('IDEMPOTENCY_CONFLICT','Upload declaration changed');
    if((await client.query('SELECT 1 FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[owner,projectId,uploadId])).rowCount)throw missing();
    const existing=(await client.query('SELECT * FROM bb_upload_confirmations WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[owner,projectId,uploadId])).rows[0];
    if(existing){
      if(existing.object_key!==u.object_key||existing.sha256.trim()!==b.sha256||Number(existing.byte_size)!==b.byte_size)throw conflict('IDEMPOTENCY_CONFLICT','Upload identity changed');
      return existing;
    }
    if(!['received','completed'].includes(u.state))throw new Problem(422,'MATERIAL_UNREADABLE','Upload bytes not received');
    await lockStorageObject(client,owner,u.object_key);
    const outbox=uid();
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'upload',$3,'upload.complete_requested',$4)`,[outbox,owner,uploadId,{project_id:projectId,upload_id:uploadId,request_id:requestId}]);
    const excepted=uploadInspectionExceptionMatches(inspectionException,{ownerUserId:owner,projectId,role:u.role,byteSize:b.byte_size,sha256:b.sha256,mediaType:u.declared_media_type});
    return (await client.query(`INSERT INTO bb_upload_confirmations(upload_id,owner_user_id,project_id,outbox_id,object_key,sha256,byte_size,inspection_excepted,upload_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[uploadId,owner,projectId,outbox,u.object_key,b.sha256,b.byte_size,excepted,{object_key:u.object_key,role:u.role,filename:u.filename,declared_media_type:u.declared_media_type}])).rows[0];
  });
  if(c.state==='failed')throw restoreError(c.error);
  if(c.state!=='completed')return {statusCode:202 as const,body:pending(uploadId)};
  if(!Value.Check(schemas.MaterialResponse,c.result))throw new Problem(503,'DATA_UNAVAILABLE','Upload result is unavailable');
  const m=(await pool.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[owner,projectId,c.result.material_id,c.result.material_version])).rows[0];
  if(!m)throw missing();
  if(await cachedUploadVersion(pool,blobs,m))return {statusCode:200 as const,body:materialDto(m)};
  // A changed storage version needs a new full read, not HEAD-derived evidence.
  await transaction(pool,async client=>{
    await project(client,owner,projectId,true);
    await client.query('SELECT id FROM bb_uploads WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,uploadId]);
    await client.query('SELECT id FROM bb_outbox WHERE id=$1 FOR UPDATE',[c.outbox_id]);
    const reset=await client.query("UPDATE bb_upload_confirmations SET state='queued',result=NULL,updated_at=now() WHERE upload_id=$1 AND state='completed'",[uploadId]);
    if(reset.rowCount)await client.query('UPDATE bb_outbox SET delivered_at=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,delivery_attempts=0 WHERE id=$1',[c.outbox_id]);
  });
  return {statusCode:202 as const,body:pending(uploadId)};
}

/** Claims exactly this event type; log forwarding owns only observability events. */
export async function claimUploadConfirmation(pool:Pool,leaseSeconds=120):Promise<UploadConfirmationLease|null>{
  return transaction(pool,async client=>{
    const row=(await client.query(`SELECT * FROM bb_outbox WHERE aggregate_type='upload' AND event_type='upload.complete_requested' AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until<=now()) AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if(!row)return null;
    const token=uid();
    await client.query("UPDATE bb_outbox SET lease_token=$2,lease_until=now()+($3::integer*interval '1 second'),delivery_attempts=delivery_attempts+1 WHERE id=$1",[row.id,token,leaseSeconds]);
    const c=(await client.query("UPDATE bb_upload_confirmations SET state='verifying',updated_at=now() WHERE outbox_id=$1 AND state IN ('queued','verifying') RETURNING *",[row.id])).rows[0];
    if(!c)throw new Error('Upload confirmation event has no pending pin');
    return {id:row.id,token,owner:c.owner_user_id,projectId:c.project_id,uploadId:c.upload_id,requestId:row.payload.request_id,declaration:{byte_size:Number(c.byte_size),sha256:c.sha256.trim()},upload:c.upload_identity,excepted:c.inspection_excepted,attempts:row.delivery_attempts+1};
  });
}
async function fence(client:PoolClient,lease:UploadConfirmationLease){
  const row=(await client.query(`SELECT id FROM bb_outbox WHERE id=$1 AND owner_user_id=$2 AND aggregate_type='upload' AND aggregate_id=$3 AND event_type='upload.complete_requested' AND delivered_at IS NULL AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,[lease.id,lease.owner,lease.uploadId,lease.token])).rows[0];
  if(!row)throw new Problem(409,'ALREADY_TERMINAL','Upload confirmation lease is no longer active');
}
export async function processUploadConfirmation(pool:Pool,blobs:PrivateBlobs,lease:UploadConfirmationLease){
  try{
    const exception=lease.excepted?{ownerUserId:lease.owner,projectId:lease.projectId,role:lease.upload.role,byteSize:lease.declaration.byte_size,sha256:lease.declaration.sha256,mediaType:lease.upload.declared_media_type} as ReturnType<typeof configuredUploadInspectionException>:null;
    const prepared=await prepareStoredUpload(pool,blobs,lease.owner,lease.projectId,lease.uploadId,lease.declaration,exception,async m=>{
      await transaction(pool,async client=>{
        await project(client,lease.owner,lease.projectId,true);
        await client.query('SELECT id FROM bb_uploads WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[lease.owner,lease.uploadId]);
        await fence(client,lease);
        if(!(await client.query('SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND object_key=$5 AND deleted_at IS NULL',[lease.owner,lease.projectId,m.id,m.version,m.object_key])).rowCount)throw missing();
        await lockStorageObject(client,lease.owner,m.object_key);
        if((await client.query("SELECT 1 FROM bb_storage_tombstones WHERE owner_user_id=$1 AND object_key=$2 AND state='purged'",[lease.owner,m.object_key])).rowCount)throw missing();
        await client.query('UPDATE bb_upload_confirmations SET canonical_object_key=$2 WHERE outbox_id=$1',[lease.id,m.object_key]);
      });
    });
    await completeStoredUpload(pool,blobs,lease.owner,lease.projectId,lease.uploadId,lease.declaration,lease.requestId,{prepared,expectedUpload:lease.upload,beforeCommit:client=>fence(client,lease),onAccepted:async(client,material)=>{
      await fence(client,lease); // Recheck expiry after the bounded version probes.
      await client.query("UPDATE bb_upload_confirmations SET state='completed',result=$2,error=NULL,updated_at=now() WHERE outbox_id=$1",[lease.id,material]);
      await client.query('UPDATE bb_outbox SET delivered_at=now(),lease_token=NULL,lease_until=NULL,last_delivery_error=NULL,next_attempt_at=NULL WHERE id=$1',[lease.id]);
    }});
    return 'completed' as const;
  }catch(error){
    const e=safeError(error);
    const retry=e.status>=500&&lease.attempts<12;
    const changed=await transaction(pool,async client=>{
      try{await fence(client,lease);}catch{return false;}
      await client.query("UPDATE bb_upload_confirmations SET state=$2,error=$3,last_error=$4,updated_at=now() WHERE outbox_id=$1",[lease.id,retry?'queued':'failed',retry?null:e,e]);
      await client.query(`UPDATE bb_outbox SET lease_token=NULL,lease_until=NULL,last_delivery_error=$2,next_attempt_at=CASE WHEN $3 THEN now()+interval '5 seconds' ELSE NULL END,delivered_at=CASE WHEN $3 THEN NULL ELSE now() END WHERE id=$1`,[lease.id,retry?'sink_unavailable':'evidence_missing',retry]);
      return true;
    });
    return changed?(retry?'retry':'failed'):'lease_lost';
  }
}
export async function runUploadConfirmationOnce(pool:Pool,blobs:PrivateBlobs){
  const lease=await claimUploadConfirmation(pool);
  if(!lease)return 'idle';
  const timer=setInterval(()=>{void pool.query("UPDATE bb_outbox SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND delivered_at IS NULL AND lease_until>now()",[lease.id,lease.token]).catch(()=>{});},40000);
  try{return await processUploadConfirmation(pool,blobs,lease);}finally{clearInterval(timer);}
}
