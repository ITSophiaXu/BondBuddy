import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { schemas, emptyUpdateDetails, M1_UPLOAD_LIMITS } from '@bondbuddy/contracts';
import { project, transaction, uid, missing, Problem, conflict, readBlobToFile, putBlobFile, type PrivateBlobs } from './data.js';
import { reserveSpool, spoolDirectory, discardSpool } from './upload-spool.js';
import { registerUploadedProspectus, changed } from './prospectus-versions.js';

type MaterialEvent=(c:PoolClient,owner:string,id:string,materialId:string,size:number)=>Promise<void>;

/** Each source version gets its own private upload reservation, so retry and deletion stay independent. */
async function copyMaterial(pool:Pool,blobs:PrivateBlobs,owner:string,target:string,sourceId:string,materialId:string,version:number,event:MaterialEvent) {
  const reserve=async(c:PoolClient,m:any)=>{
    const id=uid();
    await c.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour')`,[id,owner,target,m.filename,m.media_type,m.byte_size,m.sha256,m.role,`users/${owner}/projects/${target}/uploads/${id}`]);
    return id;
  };
  await transaction(pool,async c=>{
    await project(c,owner,target,true); await project(c,owner,sourceId);
    if((await c.query('SELECT 1 FROM bb_update_material_copies WHERE project_id=$1 AND source_material_id=$2 AND source_material_version=$3',[target,materialId,version])).rowCount)return;
    const m=(await c.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[owner,sourceId,materialId,version])).rows[0];
    if(!m)throw missing();
    const upload=await reserve(c,m);
    await c.query(`INSERT INTO bb_update_material_copies(owner_user_id,project_id,source_project_id,source_material_id,source_material_version,upload_id) VALUES($1,$2,$3,$4,$5,$6)`,[owner,target,sourceId,materialId,version,upload]);
  });
  await transaction(pool,async c=>{
    await project(c,owner,target,true);const source=await project(c,owner,sourceId);
    const receipt=(await c.query('SELECT * FROM bb_update_material_copies WHERE project_id=$1 AND source_material_id=$2 AND source_material_version=$3 FOR UPDATE',[target,materialId,version])).rows[0];
    if(receipt.material_id)return;
    const m=(await c.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL FOR SHARE',[owner,sourceId,materialId,version])).rows[0];
    if(!m)throw missing();
    const capacity=(await c.query('SELECT count(*)::int files,COALESCE(sum(byte_size),0)::bigint bytes FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL',[owner,target])).rows[0];
    if(capacity.files>=M1_UPLOAD_LIMITS.projectFiles||Number(capacity.bytes)+Number(m.byte_size)>M1_UPLOAD_LIMITS.projectBytes)throw new Problem(422,'VALIDATION_FAILED','项目材料已达到 60 份 / 500 MB 上限。');
    let upload=(await c.query('SELECT * FROM bb_uploads WHERE id=$1 FOR UPDATE',[receipt.upload_id])).rows[0];
    if(['deleting','purged'].includes(upload.state)){
      const id=await reserve(c,m);await c.query('UPDATE bb_update_material_copies SET upload_id=$4 WHERE project_id=$1 AND source_material_id=$2 AND source_material_version=$3',[target,materialId,version,id]);
      upload=(await c.query('SELECT * FROM bb_uploads WHERE id=$1',[id])).rows[0];
    }
    const release=reserveSpool(Number(m.byte_size)),path=join(spoolDirectory(),`${uid()}.copy`);
    try {
      await mkdir(spoolDirectory(),{recursive:true,mode:0o700});
      const bytes=await readBlobToFile(blobs,m.object_key,path,Number(m.byte_size));
      if(!bytes||bytes.sha256!==m.sha256.trim()||bytes.byteSize!==Number(m.byte_size))throw new Problem(503,'DATA_UNAVAILABLE','原项目材料暂不可用，请重试。');
      await putBlobFile(blobs,upload.object_key,path,m.media_type);
      const readback=await readBlobToFile(blobs,upload.object_key,null,Number(m.byte_size));
      if(!readback||readback.sha256!==bytes.sha256||readback.byteSize!==bytes.byteSize)throw new Problem(503,'DATA_UNAVAILABLE','材料保存结果尚未确认。');
    }finally{await discardSpool(path);release();}
    const id=uid();
    await c.query("UPDATE bb_uploads SET state='received',received_bytes=byte_size,received_sha256=sha256 WHERE id=$1 AND state='uploading'",[upload.id]);
    await c.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state,signature_assessment)
      VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted',$11)`,[id,owner,target,upload.id,m.role,m.filename,m.media_type,m.byte_size,m.sha256,upload.object_key,m.signature_assessment]);
    await c.query("UPDATE bb_uploads SET state='completed',received_bytes=byte_size,received_sha256=sha256 WHERE id=$1",[upload.id]);
    await c.query('UPDATE bb_update_material_copies SET material_id=$4 WHERE project_id=$1 AND source_material_id=$2 AND source_material_version=$3',[target,materialId,version,id]);
    const profile=source.update_details?.source_prospectuses?.find((s:any)=>s.material_id===materialId&&s.material_version===version&&s.sha256===m.sha256.trim());
    if(profile)await c.query(`UPDATE bb_projects SET update_details=jsonb_set(update_details,'{source_prospectuses}',COALESCE(update_details->'source_prospectuses','[]'::jsonb)||$3::jsonb),draft_revision=draft_revision+1 WHERE owner_user_id=$1 AND id=$2`,[owner,target,JSON.stringify([{...profile,material_id:id,material_version:1}])]);
    await event(c,owner,target,id,Number(m.byte_size));
    if(m.role==='historical')await registerUploadedProspectus(c,owner,target,{...m,id,version:1});
    await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'update.material_copied',$4)`,[uid(),owner,target,{source_project_id:sourceId,source_material_id:materialId,source_material_version:version,material_id:id}]);
  });
}

export function registerUpdateWorkspace(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs,event:MaterialEvent) {
  app.post('/api/v1/projects/:project_id/update-workspace',{schema:{body:schemas.UpdateWorkspaceRequest,response:{200:schemas.UpdateWorkspaceResponse}}},async r=>{
    const user=await owner(r),id=(r.params as {project_id:string}).project_id;
    const target=await transaction(db(),async c=>{
      const p=await project(c,user,id,true);
      if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
      if(p.kind==='update')return id;
      const prior=(await c.query('SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2',[user,id])).rows[0];
      if(prior){await project(c,user,prior.update_project_id);return prior.update_project_id as string;}
      const updateId=uid(),details={...emptyUpdateDetails(),...p.update_details,authoring_mode:'unified_v1',source_prospectuses:[]};
      await c.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details,execution_scope_project_id)
        VALUES($1,$2,$3,'update',$4,$5,$6,$7,$8)`,[updateId,user,p.name,p.issuer_name,p.market,p.offering,details,p.execution_scope_project_id||p.id]);
      await c.query('INSERT INTO bb_update_workspaces(owner_user_id,source_project_id,update_project_id) VALUES($1,$2,$3)',[user,id,updateId]);
      await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'update.workspace_created',$4)`,[uid(),user,id,{update_project_id:updateId}]);
      return updateId;
    });
    if(target!==id){
      const source=await project(db(),user,id);
      const sources=[...new Set([id,...(source.execution_scope_project_id&&source.execution_scope_project_id!==id?[source.execution_scope_project_id]:[])])];
      for(const sourceId of sources){
        await project(db(),user,sourceId);
        const materials=(await db().query('SELECT DISTINCT ON(id) id,version FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL ORDER BY id,version DESC',[user,sourceId])).rows;
        for(const m of materials)await copyMaterial(db(),blobs(),user,target,sourceId,m.id,m.version,event);
        await transaction(db(),async c=>{
          await project(c,user,target,true);
          if((await c.query('SELECT 1 FROM bb_prospectus_selection WHERE owner_user_id=$1 AND project_id=$2',[user,target])).rowCount)return;
          const current=(await c.query(`SELECT COALESCE(v.material_id,i.material_id) material_id,COALESCE(v.material_version,i.material_version) material_version
            FROM bb_prospectus_selection s JOIN bb_prospectus_versions v ON v.project_id=s.project_id AND v.id=s.version_id AND v.owner_user_id=s.owner_user_id
            LEFT JOIN bb_review_source_imports i ON i.project_id=v.project_id AND i.version_id=v.id AND i.owner_user_id=v.owner_user_id
            WHERE s.owner_user_id=$1 AND s.project_id=$2`,[user,sourceId])).rows[0];
          if(!current?.material_id)return;
          const selected=(await c.query(`SELECT v.id FROM bb_update_material_copies c JOIN bb_prospectus_versions v
            ON v.project_id=c.project_id AND v.material_id=c.material_id AND v.owner_user_id=c.owner_user_id
            WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.source_material_id=$3 AND c.source_material_version=$4`,[user,target,current.material_id,current.material_version])).rows[0];
          if(selected)await changed(c,user,target,selected.id);
        });
      }
    }
    return {source_project_id:id,update_project_id:target};
  });
}
