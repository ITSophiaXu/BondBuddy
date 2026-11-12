import { Pool, type PoolClient } from 'pg';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DIRECT_UPLOAD_TRANSPORT, M1_UPLOAD_LIMITS, type SignatureAssessment } from '@bondbuddy/contracts';
import { conflict, missing, Problem, project, materialDto, readBlobToFile, transaction, uid, verifiedMediaFileDetailed, type PrivateBlobs, type BlobDigest } from './data.js';
import { assertUploadVersion, cachedUploadVersion, recordUploadIntegrity, boundedVersion } from './upload-integrity.js';
import { registerUploadedProspectus } from './prospectus-versions.js';
import { assertProspectusUploadFormat } from './prospectus-upload.js';
import { enqueueMaterialParse } from './material-jobs.js';
import { appendProjectMaterialEvent } from './project-material-events.js';
import { recordOperation } from './observability.js';
import { configuredUploadInspectionException, uploadInspectionExceptionMatches } from './upload-inspection-exception.js';
import { discardSpool, reserveSpool, spoolDirectory } from './upload-spool.js';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type UploadDeclaration = { byte_size:number; sha256:string };
/** Internal measurements, never content, storage URLs or connection errors. */
export type UploadPhaseTiming = {phase:'read'|'inspection'|'commit';elapsed_ms:number};
export type UploadTimingObserver = (event:UploadPhaseTiming)=>void;
export async function measureUploadPhase<T>(phase:UploadPhaseTiming['phase'],observe:UploadTimingObserver|undefined,work:()=>Promise<T>):Promise<T>{
  const started=performance.now();
  try{return await work();}finally{try{observe?.({phase,elapsed_ms:performance.now()-started});}catch{/* Logging cannot change persistence. */}}
}
export type PreparedUpload = {
  proofs:Record<string,BlobDigest>;
  source?:{ objectKey:string; mediaType:string; signatureAssessment:SignatureAssessment|null; excepted:boolean };
};
export type CompletionOptions = {
  traceId?:string; inspectionException?:ReturnType<typeof configuredUploadInspectionException>;
  prepared?:PreparedUpload;
  beforeCommit?:(client:PoolClient)=>Promise<void>;
  expectedUpload?:{object_key:string;role:string;filename:string;declared_media_type:string};
  onAccepted?:(client:PoolClient,material:ReturnType<typeof materialDto>)=>Promise<void>;
};
export async function completeStoredUpload(pool:Pool,blobs:PrivateBlobs,user:string,id:string,uploadId:string,b:UploadDeclaration,requestId:string,options:CompletionOptions={}) {
  if(options.prepared)return commitPreparedUpload(pool,blobs,user,id,uploadId,b,requestId,options);
  for(let attempt=0;attempt<3;attempt++){
    const prepared=await prepareStoredUpload(pool,blobs,user,id,uploadId,b,options.inspectionException??null);
    try{return await commitPreparedUpload(pool,blobs,user,id,uploadId,b,requestId,{...options,prepared});}
    catch(error){if(!(error instanceof Problem&&error.status===503&&error.message==='UPLOAD_REVERIFY_REQUIRED')||attempt===2)throw error;}
  }
  throw new Problem(503,'DATA_UNAVAILABLE','UPLOAD_REVERIFY_REQUIRED');
}
async function commitPreparedUpload(pool:Pool,blobs:PrivateBlobs,user:string,id:string,uploadId:string,b:UploadDeclaration,requestId:string,options:CompletionOptions) {
  const prepared=options.prepared!;
  const traceId=options.traceId??uid(),uploadInspectionException=options.inspectionException??null;
  return transaction(pool,async client=>{

      // Same lock order as deletion/snapshot creation; concurrent equal uploads resolve once.
      const uploadProject = await project(client,user,id,true);
      const q=await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,uploadId]);const u=q.rows[0];if(!u)throw missing();
      if((await client.query('SELECT 1 FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId])).rowCount)throw missing();
      if(Number(u.byte_size)!==b.byte_size||u.sha256.trim()!==b.sha256)throw conflict('IDEMPOTENCY_CONFLICT','Upload declaration changed');
      if(options.expectedUpload&&Object.entries(options.expectedUpload).some(([key,value])=>u[key]!==value))throw conflict('IDEMPOTENCY_CONFLICT','Upload identity changed');
      await options.beforeCommit?.(client);
      const receipt=await client.query('SELECT material_id,material_version FROM bb_upload_reuse_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId]);
      let excepted=false;
      // The storage receipt and operation commit together. Legacy projects retain auxiliary parsing.
      const accepted=async (m:any)=>{
        if(m.role==='historical')await registerUploadedProspectus(client,user,id,m,
          uploadProject.kind==='update'&&uploadProject.update_details?.authoring_mode==='unified_v1'&&!receipt.rowCount&&u.state!=='completed');
        // Unified authoring reads the original in the Codex task. Do not start an
        // independent parsing/OCR pass simply because the original has been stored.
        if (uploadProject.update_details?.authoring_mode !== 'unified_v1')
          await enqueueMaterialParse(client,{owner:user,projectId:id,materialId:m.id,materialVersion:m.version,sha256:m.sha256.trim(),traceId});
        await recordOperation(client,{owner:user,projectId:id,requestId:requestId,traceId,kind:'material_complete',status:'submitted'});
        if(excepted)await recordOperation(client,{owner:user,projectId:id,requestId:requestId,traceId,kind:'material_upload_exception_complete',status:'submitted'});
        const result=materialDto(m);
        await options.onAccepted?.(client,result);
        return result;
      };
      const checkedMaterial=async (m:any,replay=false)=>{
        if(!m)throw missing();
        {
          const proof=prepared.proofs[m.object_key];
          if(!proof)throw new Problem(503,'DATA_UNAVAILABLE','UPLOAD_REVERIFY_REQUIRED');
          await assertUploadVersion(blobs,m,proof);
          await recordUploadIntegrity(client,m,proof);
        }
        return accepted(m);
      };
      if(receipt.rows[0]){
        const r=receipt.rows[0];
        const existing=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[user,id,r.material_id,r.material_version]);
        return checkedMaterial(existing.rows[0],true);
      }
      if(u.state==='completed'){const existing=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND upload_id=$2 AND deleted_at IS NULL',[user,uploadId]);return checkedMaterial(existing.rows[0],true);}
      if(u.state==='deleting'||u.state==='purged')throw missing();
      assertProspectusUploadFormat(uploadProject.kind,u.role,u.filename,u.declared_media_type);
      if(u.state==='deleting'||u.state==='purged')throw missing();
  if(u.state!=='received'&&!(u.state==='uploading'&&u.upload_transport===DIRECT_UPLOAD_TRANSPORT))throw Object.assign(new Problem(422,'MATERIAL_UNREADABLE','Upload bytes not received'),{uploadBytesPending:true});
      // Re-verify the stored object from a disk copy: hash while streaming, then inspect the file.
      let media:string;
      let verifiedBlob: BlobDigest | undefined;
      let signatureAssessment: SignatureAssessment | null = null;
      {
        const source=prepared.source,proof=prepared.proofs[u.object_key];
        if(!source||source.objectKey!==u.object_key||!proof)throw new Problem(503,'DATA_UNAVAILABLE','UPLOAD_REVERIFY_REQUIRED');
        await assertUploadVersion(blobs,u,proof);
        verifiedBlob=proof;media=source.mediaType;signatureAssessment=source.signatureAssessment;excepted=source.excepted;
      }
      if(u.state==='uploading'&&u.upload_transport===DIRECT_UPLOAD_TRANSPORT){
        await client.query("UPDATE bb_uploads SET state='received',received_sha256=$4,received_bytes=$5 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND state='uploading'",[user,id,uploadId,verifiedBlob!.sha256,verifiedBlob!.byteSize]);
        await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'upload',$3,'upload.received',$4)",[uid(),user,uploadId,{project_id:id,byte_size:verifiedBlob!.byteSize}]);
      }
      const duplicate=await client.query(`SELECT * FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND role=$3 AND sha256=$4 AND byte_size=$5 AND media_type=$6 AND deleted_at IS NULL
        ORDER BY persisted_at,id,version LIMIT 1`,[user,id,u.role,b.sha256,b.byte_size,media]);
      if(duplicate.rows[0]){
        const priorAssessment=duplicate.rows[0].signature_assessment;
        // New PDF uploads do not assess signatures. Reuse an identical old material
        // with its immutable historical assessment instead of rejecting or erasing it.
        if (media !== 'application/pdf' && (signatureAssessment
          ? priorAssessment?.status!==signatureAssessment.status || priorAssessment?.profile_version!==signatureAssessment.profile_version || priorAssessment?.signature_count!==signatureAssessment.signature_count
          : priorAssessment!==null)) throw new Problem(503,'DATA_UNAVAILABLE','Stored material inspection metadata is inconsistent');
        const m=duplicate.rows[0], result=await checkedMaterial(m);
        await client.query('INSERT INTO bb_upload_reuse_receipts(upload_id,owner_user_id,project_id,material_id,material_version) VALUES($1,$2,$3,$4,$5)',[uploadId,user,id,m.id,m.version]);
        await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'upload',$3,'upload.reused',$4)",[uid(),user,uploadId,{project_id:id,material_id:m.id,material_version:m.version}]);
        return result;
      }
      const capacity=(await client.query('SELECT count(*)::int AS files,COALESCE(sum(byte_size),0)::bigint AS bytes FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL AND NOT internal_template',[user,id])).rows[0];
      if(capacity.files>=M1_UPLOAD_LIMITS.projectFiles||Number(capacity.bytes)+b.byte_size>M1_UPLOAD_LIMITS.projectBytes)
        throw new Problem(422,'VALIDATION_FAILED','Project material limit: 60 files / 500 MiB');
      const materialId=uid();
      const inserted=await client.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state,signature_assessment) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted',$11::jsonb) RETURNING *",[materialId,user,id,uploadId,u.role,u.filename,media,b.byte_size,b.sha256,u.object_key,signatureAssessment===null?null:JSON.stringify(signatureAssessment)]);
      await client.query("UPDATE bb_uploads SET state='completed' WHERE owner_user_id=$1 AND id=$2",[user,uploadId]);
      await recordUploadIntegrity(client,inserted.rows[0],verifiedBlob!);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'material',materialId,'material.persisted',{material_id:materialId,material_version:1,project_id:id}]);
      await appendProjectMaterialEvent(client, user, id, materialId, Number(inserted.rows[0].byte_size));
      return accepted(inserted.rows[0]);

  });
}

/** Capture full-read proofs before taking the project lock. The final transaction
 * checks metadata and ETags again; a new competing canonical object asks for retry. */
export async function prepareStoredUpload(pool:Pool,blobs:PrivateBlobs,user:string,id:string,uploadId:string,b:UploadDeclaration,inspectionException:ReturnType<typeof configuredUploadInspectionException>=null,beforeMaterialRead?:(m:any)=>Promise<void>,observe?:UploadTimingObserver):Promise<PreparedUpload> {
  const p=await project(pool,user,id);
  const u=(await pool.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,uploadId])).rows[0];
  if(!u)throw missing();
  if(Number(u.byte_size)!==b.byte_size||u.sha256.trim()!==b.sha256)throw conflict('IDEMPOTENCY_CONFLICT','Upload declaration changed');
  const result:PreparedUpload={proofs:{}};
  const receipt=(await pool.query('SELECT material_id,material_version FROM bb_upload_reuse_receipts WHERE owner_user_id=$1 AND project_id=$2 AND upload_id=$3',[user,id,uploadId])).rows[0];
  if(receipt||u.state==='completed'){
    const m=(await pool.query(`SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL AND
      ${receipt?'id=$3 AND version=$4':'upload_id=$3'}`,[user,id,receipt?receipt.material_id:uploadId,...(receipt?[receipt.material_version]:[])])).rows[0];
    if(!m)throw missing();
    await beforeMaterialRead?.(m);
    result.proofs[m.object_key]=await cachedUploadVersion(pool,blobs,m)??await fullMaterialProof(blobs,m,observe);
    return result;
  }
  if(u.state==='deleting'||u.state==='purged')throw missing();
  if(u.state!=='received'&&!(u.state==='uploading'&&u.upload_transport===DIRECT_UPLOAD_TRANSPORT))throw Object.assign(new Problem(422,'MATERIAL_UNREADABLE','Upload bytes not received'),{uploadBytesPending:true});
  assertProspectusUploadFormat(p.kind,u.role,u.filename,u.declared_media_type);
  const direct=u.upload_transport===DIRECT_UPLOAD_TRANSPORT;
  const version=direct&&blobs.headVersion?await boundedVersion(blobs,u.object_key):null;
  if(direct&&!version)throw Object.assign(new Problem(422,'MATERIAL_UNREADABLE','Upload bytes not received'),{uploadBytesPending:true});
  // Same declaration/HEAD boundary as the pending direct-upload recovery fix.
  if(direct&&version!.byteSize!==b.byte_size)
    throw Object.assign(new Problem(422,'MATERIAL_CONTENT_MISMATCH','Stored bytes differ from the upload declaration'),{rejectedUploadVersion:{key:u.object_key,etag:version!.etag}});
  const release=reserveSpool(b.byte_size),copy=join(spoolDirectory(),`${uid()}.blob`);
  try{
    await mkdir(spoolDirectory(),{recursive:true,mode:0o700});
    // Both lanes reserve this declaration, so the real stream must share its
    // hard byte ceiling, including legacy received uploads and raced changes.
    const proof=await measureUploadPhase('read',observe,()=>readBlobToFile(blobs,u.object_key,copy,b.byte_size));
    if(!proof)throw new Problem(503,'DATA_UNAVAILABLE','Stored upload bytes are temporarily unavailable');
    if(direct&&proof.etag!==version!.etag)throw new Problem(503,'DATA_UNAVAILABLE','UPLOAD_REVERIFY_REQUIRED');
    if(proof.byteSize!==b.byte_size||proof.sha256!==b.sha256)throw new Problem(422,'MATERIAL_CONTENT_MISMATCH','Stored bytes or hash mismatch');
    const excepted=uploadInspectionExceptionMatches(inspectionException,{ownerUserId:user,projectId:id,role:u.role,byteSize:proof.byteSize,sha256:proof.sha256,mediaType:u.declared_media_type});
    const inspection=await measureUploadPhase('inspection',observe,async()=>excepted?{mediaType:XLSX_MEDIA_TYPE,signatureAssessment:null}:verifiedMediaFileDetailed(copy,proof.byteSize,u.declared_media_type));
    result.proofs[u.object_key]=proof;
    result.source={objectKey:u.object_key,mediaType:inspection.mediaType,signatureAssessment:inspection.signatureAssessment,excepted};
    const m=(await pool.query(`SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND role=$3 AND sha256=$4 AND byte_size=$5 AND media_type=$6 AND deleted_at IS NULL ORDER BY persisted_at,id,version LIMIT 1`,[user,id,u.role,b.sha256,b.byte_size,inspection.mediaType])).rows[0];
    if(m){await beforeMaterialRead?.(m);result.proofs[m.object_key]=await fullMaterialProof(blobs,m,observe);}
    return result;
  }catch(error){
    const e=direct&&error instanceof Problem&&error.status===413?new Problem(422,'MATERIAL_CONTENT_MISMATCH','Stored bytes exceed the upload declaration'):error;
    if(direct&&version&&e instanceof Problem&&[415,422].includes(e.status))Object.assign(e,{rejectedUploadVersion:{key:u.object_key,etag:version.etag}});
    throw e;
  }finally{await discardSpool(copy);release();}
}
export async function fullMaterialProof(blobs:PrivateBlobs,m:any,observe?:UploadTimingObserver):Promise<BlobDigest>{
  const proof=await measureUploadPhase('read',observe,()=>readBlobToFile(blobs,m.object_key,null,Number(m.byte_size)));
  if(!proof||proof.byteSize!==Number(m.byte_size)||proof.sha256!==m.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Saved material is temporarily unavailable');
  return proof;
}
