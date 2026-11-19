import type{Pool}from'pg';
import{mkdtemp,mkdir,writeFile,readFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';import{isDeepStrictEqual}from'node:util';
import{digest,transaction,type PrivateBlobs}from'@bondbuddy/api/data';
import{inputManifestHash}from'@bondbuddy/api/production-rule-pin';
import{readProjectFileAsset,appendProjectFile}from'@bondbuddy/api/project-file-storage';
import{inspectDocx,WORD_MEDIA_TYPE}from'@bondbuddy/api/docx-inspector';
import{inspectProjectFile,normalizeWorkpaperLayout}from'./project-file-tools.js';
import{verifiedFileLinks}from'./project-file-evidence.js';import type{StageContext}from'./run-pipeline.js';
export const WORKPAPER_LAYOUT_REPAIR_METHOD='host-workpaper-pagination-20261119-v2';
const fail=()=>new Error('WORKPAPER_LAYOUT_REVISION_CONFLICT');
/** Private operator action. Candidate bytes are always derived from the exact
 * paid artifact by host code; no uploaded replacement or model response is accepted.
 * The locked commit publishes a new download pin, evidence and receipt together.
 * Deliberately never invokes queue.finish, a model, or any billing mutation. */
export async function repairDeliveredWorkpaperLayout(pool:Pool,blobs:PrivateBlobs,input:{owner:string;versionId:string;expectedSha256:string;actor:string}){
 if(!/^[A-Za-z0-9_.@-]{1,128}$/.test(input.actor)||!input.owner||!input.versionId||!/^[a-f0-9]{64}$/.test(input.expectedSha256))throw fail();
 return transaction(pool,async c=>{
  const row=(await c.query(`SELECT v.*,f.project_id,f.latest_version_id,b.batch_id,b.item_id,batch.source,batch.state AS batch_state,
    r.project_id AS run_project_id,r.state AS run_state,p.archived_at,p.deleted_at
    FROM bb_project_file_versions v JOIN bb_project_files f ON f.owner_user_id=v.owner_user_id AND f.id=v.file_id AND f.document_type='workpaper'
    JOIN bb_projects p ON p.owner_user_id=f.owner_user_id AND p.id=f.project_id
    JOIN bb_workpaper_file_bindings b ON b.owner_user_id=v.owner_user_id AND b.original_version_id=v.id AND b.file_id=f.id
    JOIN bb_workpaper_batches batch ON batch.owner_user_id=b.owner_user_id AND batch.id=b.batch_id AND batch.project_id=f.project_id
    JOIN bb_workpaper_items i ON i.owner_user_id=b.owner_user_id AND i.batch_id=b.batch_id AND i.item_id=b.item_id AND i.run_id=v.run_id AND i.state='succeeded'
    JOIN bb_runs r ON r.owner_user_id=v.owner_user_id AND r.id=v.run_id
    WHERE v.owner_user_id=$1 AND v.id=$2 FOR UPDATE OF f`,[input.owner,input.versionId])).rows[0];
  if(!row||row.asset?.kind!=='artifact'||row.asset.pin.sha256!==input.expectedSha256||row.run_state!=='succeeded'||row.archived_at||row.deleted_at||!['complete','partial'].includes(row.batch_state))throw fail();
  const previous=(await c.query('SELECT * FROM bb_workpaper_layout_revisions WHERE owner_user_id=$1 AND parent_version_id=$2 AND method=$3',[input.owner,input.versionId,WORKPAPER_LAYOUT_REPAIR_METHOD])).rows[0];
  if(previous){if(previous.input_sha256.trim()!==input.expectedSha256||inputManifestHash(previous.receipt)!==previous.receipt_sha256.trim())throw fail();return {revision_id:previous.id,version_id:previous.new_version_id,sha256:previous.output_sha256.trim(),reused:true};}
  if(row.latest_version_id!==row.id||(await c.query(`SELECT 1 FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
    WHERE o.owner_user_id=$1 AND o.manifest->>'file_id'=$2 AND r.state NOT IN ('succeeded','failed','cancelled') LIMIT 1`,[input.owner,row.file_id])).rowCount)throw fail();
  const original=await readProjectFileAsset(c,input.owner,row.asset),sourceAsset=await readProjectFileAsset(c,input.owner,row.source.asset);
  if(original.run_id!==row.run_id||original.project_id!==row.run_project_id)throw fail();
  const read=async(a:any,sha:string)=>{const bytes=await blobs.getIfExistsBounded(a.object_key,64*1024*1024);if(!bytes||digest(bytes)!==sha)throw fail();return bytes;};
  const raw=await read(original,input.expectedSha256),sourceBytes=await read(sourceAsset,row.source.asset.pin.sha256);
  const dir=await mkdtemp(join(tmpdir(),'bb-delivered-layout-'));try{
   await mkdir(join(dir,'output'));const path=join(dir,'output/document.docx'),sourcePath=join(dir,row.source.filename.toLowerCase().endsWith('.pdf')?'source.pdf':'source.docx');
   await writeFile(path,raw);await writeFile(sourcePath,sourceBytes);
   const ctx={run:{id:row.run_id,project_id:row.run_project_id,owner_user_id:input.owner},blobs}as StageContext;
   const before=await inspectProjectFile(ctx,path,true),source=await inspectProjectFile(ctx,sourcePath,true);
   const layout=await normalizeWorkpaperLayout(ctx,dir);if(!layout) return {revision_id:null,version_id:row.id,sha256:input.expectedSha256,reused:true};
   const candidate=await readFile(path),after=await inspectProjectFile(ctx,path,true),inspection=inspectDocx(candidate);
   if(inspection.quality_status!=='passed'||inspection.sha256!==layout.output_sha256||before.coverage!=='complete'||after.coverage!=='complete'||source.coverage!=='complete'||!isDeepStrictEqual(before.spans,after.spans)||!isDeepStrictEqual(before.warnings,after.warnings))throw fail();
   if(!Array.isArray(row.links)||!row.links.length||row.links.some((l:any)=>l.source_sha256!==source.sha256||l.target_sha256!==before.sha256))throw fail();
   const links=verifiedFileLinks(source,after,row.links,100000);
   if(links.length!==row.links.length||!isDeepStrictEqual(links,row.links.map((l:any)=>({...l,target_sha256:after.sha256}))))throw fail();
   const identity=inputManifestHash({owner:input.owner,parent:row.id,method:WORKPAPER_LAYOUT_REPAIR_METHOD,sha256:after.sha256});
   const artifactId='layout-word-'+identity,key=`users/${input.owner}/runs/${row.run_id}/layout-revisions/${identity}/v1.docx`,evidenceId='layout-evidence-'+identity;
   await blobs.put(key,candidate,WORD_MEDIA_TYPE);const back=await blobs.getIfExistsBounded(key,64*1024*1024);
   if(!back||back.length!==candidate.length||digest(back)!==inspection.sha256)throw fail();
   await c.query(`INSERT INTO bb_word_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,'passed','available','readback_verified',$5,$6,$8)`,[evidenceId,input.owner,row.run_id,artifactId,inspection.sha256,candidate.length,inspection.validator_version,inspection]);
   await c.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
    VALUES($1,1,$2,$3,$4,$5,$6,'passed','available',$7)`,[artifactId,input.owner,row.run_id,WORD_MEDIA_TYPE,after.sha256,key,evidenceId]);
   const asset={kind:'artifact' as const,pin:{source_project_id:row.run_project_id,artifact_id:artifactId,artifact_version:1,sha256:after.sha256}};
   const version=await appendProjectFile(c,input.owner,{id:row.file_id,project_id:row.project_id},{filename:row.filename,asset,source_version_id:row.source_version_id,template_id:row.template_id,template_version:row.template_version,links});
   const receipt={...layout,method:WORKPAPER_LAYOUT_REPAIR_METHOD,actor:input.actor,owner_user_id:input.owner,file_id:row.file_id,parent_version_id:row.id,new_version_id:version.id,
    batch_id:row.batch_id,item_id:row.item_id,run_id:row.run_id,artifact:asset.pin,links_sha256:inputManifestHash(links),inspection_sha256:inputManifestHash(inspection),billing_action:'none',model_action:'none'};
   const revisionId='layout-revision-'+identity;
   await c.query(`INSERT INTO bb_workpaper_layout_revisions(id,owner_user_id,file_id,parent_version_id,new_version_id,batch_id,item_id,run_id,method,actor,input_sha256,output_sha256,receipt,receipt_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[revisionId,input.owner,row.file_id,row.id,version.id,row.batch_id,row.item_id,row.run_id,WORKPAPER_LAYOUT_REPAIR_METHOD,input.actor,input.expectedSha256,after.sha256,receipt,inputManifestHash(receipt)]);
   return {revision_id:revisionId,version_id:version.id,sha256:after.sha256,reused:false};
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
