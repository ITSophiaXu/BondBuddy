import { importProspectusMaterial } from './prospectus-import.js';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { schemas, type ProspectusVersions } from '@bondbuddy/contracts';
import { project, transaction, uid, digest, conflict, missing, Problem, date, readBlobToFile, type PrivateBlobs } from './data.js';

// Used both for the displayed action and the locked deletion check. Material IDs
// are owner-unique; inspect nested pins too (M4 and file operations are cross-project).
const deletionReason = `CASE
  WHEN v.origin='generated' THEN 'generated'
  WHEN EXISTS(SELECT 1 FROM bb_prospectus_selection s JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
    WHERE s.owner_user_id=v.owner_user_id AND s.version_id=v.id AND NOT (p.kind='update' AND COALESCE(p.update_details->>'authoring_mode','')='unified_v1')) THEN 'current'
  WHEN EXISTS(SELECT 1 FROM bb_input_revisions i WHERE i.owner_user_id=v.owner_user_id AND (
    i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',v.material_id)) OR
    jsonb_path_exists(i.manifest,'$.**.material_id ? (@ == $material)',jsonb_build_object('material',v.material_id))))
    OR EXISTS(SELECT 1 FROM bb_project_file_versions f WHERE f.owner_user_id=v.owner_user_id AND
      (f.source_version_id=v.id OR f.asset#>>'{pin,material_id}'=v.material_id))
    OR EXISTS(SELECT 1 FROM bb_workpaper_batches b WHERE b.owner_user_id=v.owner_user_id AND b.source->>'version_id'=v.id)
    OR EXISTS(SELECT 1 FROM bb_review_drafts d WHERE d.owner_user_id=v.owner_user_id AND
      jsonb_path_exists(d.input,'$.**.material_id ? (@ == $material)',jsonb_build_object('material',v.material_id)))
  THEN 'used' ELSE NULL END`;

/** Caller holds the project lock, shared with selection and input creation. */
export async function assertProspectusRemovable(c:PoolClient,owner:string,id:string,materialId:string) {
  const rows=(await c.query(`SELECT ${deletionReason} AS reason FROM bb_prospectus_versions v
    WHERE v.owner_user_id=$1 AND v.project_id=$2 AND v.material_id=$3`,[owner,id,materialId])).rows;
  if(rows.some(v=>v.reason==='current'))throw conflict('INPUT_REVISION_CONFLICT','此文件正在使用，请先选择其他参考稿。');
  if(rows.some(v=>v.reason))throw conflict('INPUT_REVISION_CONFLICT','此文件已被任务或关联文件使用，需保留原始依据。');
  return rows.length>0;
}

export async function prospectusVersions(db: Pool | PoolClient, owner: string, id: string): Promise<ProspectusVersions> {
  const p=await project(db, owner, id);
  const selection = (await db.query('SELECT * FROM bb_prospectus_selection WHERE owner_user_id=$1 AND project_id=$2', [owner,id])).rows[0];
  const versions = (await db.query(`SELECT v.*,${deletionReason} AS delete_block_reason FROM bb_prospectus_versions v
    WHERE v.owner_user_id=$1 AND v.project_id=$2 AND (v.material_id IS NULL OR EXISTS(
      SELECT 1 FROM bb_material_versions m WHERE m.owner_user_id=v.owner_user_id AND m.id=v.material_id
        AND m.version=v.material_version AND m.deleted_at IS NULL)) ORDER BY v.sequence DESC`, [owner,id])).rows;
  const current=versions.find(v=>v.id===selection?.version_id);
  let active=current?.material_id?[current.material_id]:[];
  if(current?.run_id){
    const manifest=(await db.query(`SELECT i.manifest FROM bb_runs r JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision WHERE r.owner_user_id=$1 AND r.id=$2`,[owner,current.run_id])).rows[0]?.manifest;
    active=(manifest?.materials??[]).filter((m:any)=>m.role==='historical').map((m:any)=>m.material_id);
  }
  return { project_id:id, current_version_id:selection?.version_id ?? null, selection_revision:selection?.revision ?? 0,
    inactive_material_ids:current||p.kind==='update'&&p.update_details?.authoring_mode==='unified_v1'?versions.filter(v=>v.material_id&&!active.includes(v.material_id)).map(v=>v.material_id):[],
    versions:versions.map(v => ({version_id:v.id,sequence:v.sequence,origin:v.origin,filename:v.filename,sha256:v.sha256.trim(),created_at:date(v.created_at),
      material_id:v.material_id,material_version:v.material_version,artifact_id:v.artifact_id,artifact_version:v.artifact_version,revision_artifact_id:v.revision_artifact_id,run_id:v.run_id,delete_block_reason:v.delete_block_reason})) };
}

export async function changed(c:PoolClient, owner:string, id:string, versionId:string|null) {
  await c.query(`INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)
    ON CONFLICT(project_id) DO UPDATE SET version_id=$3,revision=bb_prospectus_selection.revision+1`,[owner,id,versionId]);
  await c.query('UPDATE bb_projects SET draft_revision=draft_revision+1,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id]);
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'project',$3,'prospectus.current_changed',$4)`,[uid(),owner,id,{version_id:versionId}]);
}

/** Called inside the project lock. Version numbers are append-only, independent of material IDs. */
export async function registerUploadedProspectus(c:PoolClient,owner:string,id:string,m:any,adopt=false) {
  let v=(await c.query('SELECT * FROM bb_prospectus_versions WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4',[owner,id,m.id,m.version])).rows[0];
  if(!v) v=(await c.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version)
    SELECT $1,$2,$3,COALESCE(max(sequence),0)+1,'upload',$4,$5,$6,$7 FROM bb_prospectus_versions WHERE project_id=$3 RETURNING *`,
    [uid(),owner,id,m.filename,m.sha256.trim(),m.id,m.version])).rows[0];
  // Only a newly completed upload adopts. Replaying an old completion must not
  // switch away from a newer upload or a subsequently selected/generated result.
  if(adopt){
    const cleared=await c.query("UPDATE bb_projects SET update_details=update_details-'format_template' WHERE owner_user_id=$1 AND id=$2 AND update_details ? 'format_template' RETURNING id",[owner,id]);
    if(cleared.rowCount || !(await c.query('SELECT 1 FROM bb_prospectus_selection WHERE project_id=$1 AND version_id=$2',[id,v.id])).rowCount)
      await changed(c,owner,id,v.id);
  }
  return v;
}

/** A mistaken, unused automatic source can be removed without stranding the project. */
export async function reselectAfterProspectusRemoval(c:PoolClient,owner:string,id:string,materialId:string){
  const selected=(await c.query(`SELECT 1 FROM bb_prospectus_selection s JOIN bb_prospectus_versions v
    ON v.owner_user_id=s.owner_user_id AND v.project_id=s.project_id AND v.id=s.version_id
    WHERE s.owner_user_id=$1 AND s.project_id=$2 AND v.material_id=$3`,[owner,id,materialId])).rowCount;
  if(!selected)return;
  const next=(await c.query(`SELECT v.id FROM bb_prospectus_versions v WHERE v.owner_user_id=$1 AND v.project_id=$2
    AND (EXISTS(SELECT 1 FROM bb_material_versions m WHERE m.owner_user_id=v.owner_user_id AND m.id=v.material_id AND m.version=v.material_version AND m.deleted_at IS NULL)
      OR EXISTS(SELECT 1 FROM bb_artifact_versions a WHERE a.owner_user_id=v.owner_user_id AND a.id=v.artifact_id AND a.version=v.artifact_version AND a.delivery_status='available'))
    ORDER BY v.sequence DESC LIMIT 1`,[owner,id])).rows[0];
  await changed(c,owner,id,next?.id??null);
  await c.query("UPDATE bb_projects SET update_details=update_details-'format_template' WHERE owner_user_id=$1 AND id=$2",[owner,id]);
}

/** Completion archives both outputs, but only promotes if the user has not switched/uploaded since input lock. */
export async function registerGeneratedProspectus(c:PoolClient,r:any,pair:any) {
  if(!['update','review'].includes(r.task_kind)||r.channel!=='production'||!pair?.clean_artifact_id||!pair?.revision_artifact_id)return;
  await project(c,r.owner_user_id,r.project_id,true);
  if((await c.query('SELECT 1 FROM bb_prospectus_versions WHERE project_id=$1 AND run_id=$2',[r.project_id,r.id])).rowCount)return;
  const a=(await c.query(`SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND id=$3
    AND quality_status='passed' AND delivery_status='available' ORDER BY version DESC LIMIT 1`,[r.owner_user_id,r.id,pair.clean_artifact_id])).rows[0];
  if(!a)return;
  const v=(await c.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,artifact_id,artifact_version,revision_artifact_id,run_id)
    SELECT $1,$2,$3,COALESCE(max(sequence),0)+1,'generated','募集说明书清洁版.docx',$4,$5,$6,$7,$8 FROM bb_prospectus_versions WHERE project_id=$3 RETURNING *`,
    [uid(),r.owner_user_id,r.project_id,a.sha256.trim(),a.id,a.version,pair.revision_artifact_id,r.id])).rows[0];
  const manifest=(await c.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[r.owner_user_id,r.project_id,r.input_revision])).rows[0]?.manifest;
  const s=(await c.query('SELECT revision FROM bb_prospectus_selection WHERE project_id=$1',[r.project_id])).rows[0];
  if(r.task_kind==='update'&&!manifest?.review&&(s?.revision??0)===(manifest?.prospectus_selection?.revision??0))await changed(c,r.owner_user_id,r.project_id,v.id);
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'prospectus.generated',$4)`,[uid(),r.owner_user_id,r.project_id,{version_id:v.id,run_id:r.id}]);
}

export function registerProspectusRoutes(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs) {
  const path='/api/v1/projects/:project_id/prospectus-versions';
  const id=(r:FastifyRequest)=>(r.params as {project_id:string}).project_id;
  app.get(path,{schema:{response:{200:schemas.ProspectusVersionsResponse}}},async r=>prospectusVersions(db(),await owner(r),id(r)));
  for(const mode of ['upload','select'] as const) app.post(path+(mode==='select'?'/current':''),{schema:{body:mode==='upload'?schemas.ProspectusVersionSaveRequest:schemas.ProspectusVersionSelectRequest,response:{200:schemas.ProspectusVersionsResponse}}},async r=>{
    const user=await owner(r),projectId=id(r),b=r.body as any;
    return transaction(db(),async c=>{
      const p=await project(c,user,projectId,true);
      if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
      const requestHash=digest(JSON.stringify({mode,...b}));
      const prior=(await c.query('SELECT request_hash FROM bb_prospectus_selection_requests WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3',[user,projectId,b.request_id])).rows[0];
      if(prior){if(prior.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','此请求已用于其他版本。');return prospectusVersions(c,user,projectId);}
      const s=(await c.query('SELECT * FROM bb_prospectus_selection WHERE project_id=$1',[projectId])).rows[0];
      if((s?.revision??0)!==b.expected_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','当前募集书已变化，请刷新后重新选择。');
      let v:any;
      if(mode==='upload'){
        const m=(await c.query(`SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,[user,projectId,b.material_id,b.material_version])).rows[0];
        if(!m)throw missing();
        if(m.role!=='historical'||m.sha256.trim()!==b.sha256||!['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(m.media_type))throw new Problem(422,'VALIDATION_FAILED','请选择已保存的本项目募集说明书。');
        const bytes=await readBlobToFile(blobs(),m.object_key,null,Number(m.byte_size));
        if(!bytes||bytes.sha256!==m.sha256.trim()||bytes.byteSize!==Number(m.byte_size))throw new Problem(503,'DATA_UNAVAILABLE','募集书文件暂不可用。');
        v=await registerUploadedProspectus(c,user,projectId,m);
      }else{
        v=(await c.query('SELECT * FROM bb_prospectus_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,projectId,b.version_id])).rows[0];
        if(!v)throw missing();
        const available=v.material_id
          ? await c.query('SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[user,projectId,v.material_id,v.material_version])
          : await c.query("SELECT 1 FROM bb_artifact_versions WHERE owner_user_id=$1 AND id=$2 AND version=$3 AND delivery_status='available'",[user,v.artifact_id,v.artifact_version]);
        if(!available.rowCount)throw missing();
      }
      if(v.origin==='generated'&&p.kind!=='update')await importProspectusMaterial(c,blobs(),user,projectId,v.id);
      if(s?.version_id!==v.id)await changed(c,user,projectId,v.id);
      await c.query('INSERT INTO bb_prospectus_selection_requests(owner_user_id,project_id,request_id,request_hash) VALUES($1,$2,$3,$4)',[user,projectId,b.request_id,requestHash]);
      return prospectusVersions(c,user,projectId);
    });
  });
}
