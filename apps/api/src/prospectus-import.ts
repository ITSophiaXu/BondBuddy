import type { PoolClient } from 'pg';
import { M1_UPLOAD_LIMITS } from '@bondbuddy/contracts';
import { project,uid,digest,missing,conflict,Problem,materialDto,type PrivateBlobs } from './data.js';

/** Requires the project transaction; copies artifact bytes into independent material ownership. */
export async function importProspectusMaterial(c:PoolClient,blobs:PrivateBlobs,user:string,id:string,versionId:string){
      const p=await project(c,user,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
      const v=(await c.query('SELECT * FROM bb_prospectus_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,versionId])).rows[0];
      if(!v)throw missing();
      const imported=(await c.query('SELECT material_id FROM bb_review_source_imports WHERE owner_user_id=$1 AND project_id=$2 AND version_id=$3',[user,id,v.id])).rows[0];
      if(v.material_id||imported){
        const m=(await c.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[user,id,v.material_id??imported.material_id,v.material_version??1])).rows[0];
        if(m)return materialDto(m);
        if(v.material_id)throw missing();
        await c.query('DELETE FROM bb_review_source_imports WHERE owner_user_id=$1 AND project_id=$2 AND version_id=$3',[user,id,v.id]);
      }
      const a=(await c.query(`SELECT a.* FROM bb_execution_artifact_versions a JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id
        WHERE a.owner_user_id=$1 AND r.project_id=$2 AND a.id=$3 AND a.version=$4 AND a.quality_status='passed' AND a.delivery_status='available'`,[user,id,v.artifact_id,v.artifact_version])).rows[0];
      if(!a||a.sha256.trim()!==v.sha256.trim())throw missing();
      const bytes=await blobs.getIfExistsBounded(a.object_key,M1_UPLOAD_LIMITS.fileBytes);
      if(!bytes||digest(bytes)!==v.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','募集书文件暂不可用。');
      const capacity=(await c.query('SELECT count(*)::int files,COALESCE(sum(byte_size),0)::bigint bytes FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL',[user,id])).rows[0];
      if(capacity.files>=M1_UPLOAD_LIMITS.projectFiles||Number(capacity.bytes)+bytes.length>M1_UPLOAD_LIMITS.projectBytes)throw new Problem(422,'VALIDATION_FAILED','项目材料达到容量上限。');
      const upload=uid(),material=uid(),key=`users/${user}/projects/${id}/uploads/${upload}`,media='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      await blobs.put(key,bytes,media);
      const readback=await blobs.getIfExistsBounded(key,M1_UPLOAD_LIMITS.fileBytes);if(!readback||digest(readback)!==v.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','保存募集书尚未确认。');
      await c.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_bytes,received_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,'historical',$8,now()+interval '1 hour','completed',$6,$7)`,[upload,user,id,v.filename,media,bytes.length,v.sha256,key]);
      const m=(await c.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical',$5,$6,$7,$8,$9,'persisted') RETURNING *`,[material,user,id,upload,`V${v.sequence} · ${v.filename}`,media,bytes.length,v.sha256,key])).rows[0];
      await c.query('INSERT INTO bb_review_source_imports(owner_user_id,project_id,version_id,material_id) VALUES($1,$2,$3,$4)',[user,id,v.id,material]);
      await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'review.source_imported',$4)`,[uid(),user,id,{version_id:v.id,material_id:material}]);
      return materialDto(m);
}
