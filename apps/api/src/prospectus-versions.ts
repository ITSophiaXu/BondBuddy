import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { schemas, type ProspectusVersions } from '@bondbuddy/contracts';
import { project, transaction, uid, digest, conflict, missing, Problem, date, readBlobToFile, type PrivateBlobs } from './data.js';

export async function prospectusVersions(db: Pool | PoolClient, owner: string, id: string): Promise<ProspectusVersions> {
  await project(db, owner, id);
  const selection = (await db.query('SELECT * FROM bb_prospectus_selection WHERE owner_user_id=$1 AND project_id=$2', [owner,id])).rows[0];
  const versions = (await db.query('SELECT * FROM bb_prospectus_versions WHERE owner_user_id=$1 AND project_id=$2 ORDER BY sequence DESC', [owner,id])).rows;
  const current=versions.find(v=>v.id===selection?.version_id);
  let active=current?.material_id?[current.material_id]:[];
  if(current?.run_id){
    const manifest=(await db.query(`SELECT i.manifest FROM bb_runs r JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision WHERE r.owner_user_id=$1 AND r.id=$2`,[owner,current.run_id])).rows[0]?.manifest;
    active=(manifest?.materials??[]).filter((m:any)=>m.role==='historical').map((m:any)=>m.material_id);
  }
  return { project_id:id, current_version_id:selection?.version_id ?? null, selection_revision:selection?.revision ?? 0,
    inactive_material_ids:current?versions.filter(v=>v.material_id&&!active.includes(v.material_id)).map(v=>v.material_id):[],
    versions:versions.map(v => ({version_id:v.id,sequence:v.sequence,origin:v.origin,filename:v.filename,sha256:v.sha256.trim(),created_at:date(v.created_at),
      material_id:v.material_id,material_version:v.material_version,artifact_id:v.artifact_id,artifact_version:v.artifact_version,revision_artifact_id:v.revision_artifact_id,run_id:v.run_id})) };
}

async function changed(c:PoolClient, owner:string, id:string, versionId:string) {
  await c.query(`INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)
    ON CONFLICT(project_id) DO UPDATE SET version_id=$3,revision=bb_prospectus_selection.revision+1`,[owner,id,versionId]);
  await c.query('UPDATE bb_projects SET draft_revision=draft_revision+1,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id]);
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'project',$3,'prospectus.current_changed',$4)`,[uid(),owner,id,{version_id:versionId}]);
}

/** Called inside the project lock. Version numbers are append-only, independent of material IDs. */
export async function registerUploadedProspectus(c:PoolClient,owner:string,id:string,m:any,selectFirst=false) {
  let v=(await c.query('SELECT * FROM bb_prospectus_versions WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4',[owner,id,m.id,m.version])).rows[0];
  if(!v) v=(await c.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version)
    SELECT $1,$2,$3,COALESCE(max(sequence),0)+1,'upload',$4,$5,$6,$7 FROM bb_prospectus_versions WHERE project_id=$3 RETURNING *`,
    [uid(),owner,id,m.filename,m.sha256.trim(),m.id,m.version])).rows[0];
  if(selectFirst && !(await c.query('SELECT 1 FROM bb_prospectus_selection WHERE project_id=$1',[id])).rowCount) await changed(c,owner,id,v.id);
  return v;
}

/** Completion archives both outputs, but only promotes if the user has not switched/uploaded since input lock. */
export async function registerGeneratedProspectus(c:PoolClient,r:any,pair:any) {
  if(r.task_kind!=='update'||r.channel!=='production'||!pair?.clean_artifact_id||!pair?.revision_artifact_id)return;
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
  if((s?.revision??0)===(manifest?.prospectus_selection?.revision??0))await changed(c,r.owner_user_id,r.project_id,v.id);
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
      if(p.kind!=='update')throw conflict('INPUT_REVISION_CONFLICT','请先进入此项目的更新募集书工作区。');
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
      if(s?.version_id!==v.id)await changed(c,user,projectId,v.id);
      await c.query('INSERT INTO bb_prospectus_selection_requests(owner_user_id,project_id,request_id,request_hash) VALUES($1,$2,$3,$4)',[user,projectId,b.request_id,requestHash]);
      return prospectusVersions(c,user,projectId);
    });
  });
}
