import type { Pool } from 'pg';
import { DIRECT_UPLOAD_TRANSPORT, M1_UPLOAD_LIMITS, type schemas } from '@bondbuddy/contracts';
import type { Static } from '@sinclair/typebox';
import { conflict, missing, Problem, project, transaction, type PrivateBlobs } from './data.js';

export async function uploadTicket(blobs:PrivateBlobs, projectId:string, upload:{id:string;object_key:string;upload_transport:string;expires_at:Date|string}):Promise<Static<typeof schemas.UploadSessionResponse>> {
  const expires=new Date(upload.expires_at);
  const direct=upload.upload_transport===DIRECT_UPLOAD_TRANSPORT;
  if(direct&&!blobs.createUploadUrl)throw new Problem(503,'DATA_UNAVAILABLE','Direct upload signing is unavailable');
  // Signing failures must never expose an SDK request or signed URL in an API error.
  let url:string;
  try { url=direct?await blobs.createUploadUrl!(upload.object_key,expires):`/api/v1/projects/${encodeURIComponent(projectId)}/materials/uploads/${encodeURIComponent(upload.id)}/bytes`; }
  catch { throw new Problem(503,'DATA_UNAVAILABLE','Upload ticket is temporarily unavailable'); }
  if(direct){
    const target=new URL(url);
    if(target.protocol!=='https:'||target.username||target.password||target.hash)throw new Problem(503,'DATA_UNAVAILABLE','Direct upload signing is unavailable');
  }
  return {upload_id:upload.id,state:'uploading',upload_url:url,expires_at:expires.toISOString(),max_bytes:M1_UPLOAD_LIMITS.fileBytes,...(direct?{upload_transport:DIRECT_UPLOAD_TRANSPORT}:{})};
}

/** Reissue only for the same owner/project/declaration. Completion always wins over a fresh PUT. */
export async function refreshUploadTicket(pool:Pool,blobs:PrivateBlobs,owner:string,projectId:string,uploadId:string,b:{byte_size:number;sha256:string},directRequested:boolean){
  return transaction(pool,async client=>{
    await project(client,owner,projectId,true);
    const u=(await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[owner,projectId,uploadId])).rows[0];
    if(!u||['deleting','purged'].includes(u.state))throw missing();
    if(Number(u.byte_size)!==b.byte_size||u.sha256.trim()!==b.sha256)throw conflict('IDEMPOTENCY_CONFLICT','Upload declaration changed');
    if(u.state!=='uploading'||(await client.query('SELECT 1 FROM bb_upload_confirmations WHERE owner_user_id=$1 AND upload_id=$2 UNION ALL SELECT 1 FROM bb_upload_reuse_receipts WHERE owner_user_id=$1 AND upload_id=$2 UNION ALL SELECT 1 FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND upload_id=$2',[owner,uploadId])).rowCount)
      throw conflict('IDEMPOTENCY_CONFLICT','Upload already received; retry completion');
    if(u.upload_transport===DIRECT_UPLOAD_TRANSPORT){
      if(!directRequested)throw conflict('IDEMPOTENCY_CONFLICT','Direct upload negotiation is required');
      if(!blobs.headVersion)throw new Problem(503,'DATA_UNAVAILABLE','Stored object version is unavailable');
      if(await blobs.headVersion(u.object_key))throw conflict('IDEMPOTENCY_CONFLICT','Upload already received; retry completion');
    }
    u.expires_at=new Date(Date.now()+15*60_000);
    const ticket=await uploadTicket(blobs,projectId,u);
    await client.query('UPDATE bb_uploads SET expires_at=$4 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[owner,projectId,uploadId,u.expires_at]);
    return ticket;
  });
}
