import type {Pool,PoolClient} from 'pg';
import { PROJECT_DOCUMENT_CATALOG, type ProjectDocumentType, type ProjectFileAsset, type ProjectFileSource, type ProjectFileVersion, type ProjectFileLink } from '@bondbuddy/contracts';
import { project,uid,date,missing,conflict,Problem } from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
type Db=Pool|PoolClient;

export async function readProjectFileAsset(db:Db,owner:string,asset:ProjectFileAsset){
  const pin=asset.pin;await project(db,owner,pin.source_project_id);
  const row=asset.kind==='material'
    ? (await db.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL AND NOT internal_template',[owner,pin.source_project_id,asset.pin.material_id,asset.pin.material_version])).rows[0]
    : (await db.query(`SELECT a.*,r.project_id FROM bb_artifact_versions a JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id
      WHERE a.owner_user_id=$1 AND r.project_id=$2 AND a.id=$3 AND a.version=$4 AND a.delivery_status='available' AND a.quality_status='passed'`,[owner,pin.source_project_id,asset.pin.artifact_id,asset.pin.artifact_version])).rows[0];
  if(!row||row.sha256.trim()!==pin.sha256)throw missing();
  return row;
}

/** Resolve a displayed collection's source, including its retained update workspace. */
export async function projectFileSource(db:Db,owner:string,id:string,versionId?:string):Promise<ProjectFileSource|null>{
  await project(db,owner,id);
  const related=(await db.query('SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2',[owner,id])).rows[0]?.update_project_id;
  const ids=related?[related,id]:[id];
  const v=(await db.query(`SELECT v.*,s.revision AS selection_revision FROM bb_prospectus_versions v
    LEFT JOIN bb_prospectus_selection s ON s.owner_user_id=v.owner_user_id AND s.project_id=v.project_id
    WHERE v.owner_user_id=$1 AND v.project_id=ANY($2::text[])
      AND CASE WHEN $3::text IS NULL THEN v.id=s.version_id ELSE v.id=$3 END
    ORDER BY array_position($2::text[],v.project_id),v.sequence DESC LIMIT 1`,[owner,ids,versionId??null])).rows[0];
  if(!v)return null;
  const common={source_project_id:v.project_id,sha256:v.sha256.trim()};
  const asset:ProjectFileAsset=v.material_id?{kind:'material',pin:{...common,material_id:v.material_id,material_version:v.material_version}}
    :{kind:'artifact',pin:{...common,artifact_id:v.artifact_id,artifact_version:v.artifact_version}};
  await readProjectFileAsset(db,owner,asset);
  return {project_id:v.project_id,version_id:v.id,selection_revision:v.selection_revision??0,sequence:v.sequence,filename:v.filename,asset};
}

export async function projectFileFamily(c:PoolClient,owner:string,id:string,type:ProjectDocumentType){
  if(!PROJECT_DOCUMENT_CATALOG.some(d=>d.id===type))throw new Problem(422,'VALIDATION_FAILED','请选择文件清单中的类型。');
  const p=await project(c,owner,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
  return (await c.query(`INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type) VALUES($1,$2,$3,$4)
    ON CONFLICT(project_id,document_type) DO UPDATE SET document_type=EXCLUDED.document_type RETURNING *`,[uid(),owner,id,type])).rows[0];
}

export async function appendProjectFile(c:PoolClient,owner:string,family:any,input:{filename:string;asset:ProjectFileAsset;revision_asset?:ProjectFileAsset;
  source_version_id?:string;template_id?:string;template_version?:number;run_id?:string;links?:ProjectFileLink[]},promote=true){
  if(input.run_id){const old=(await c.query('SELECT * FROM bb_project_file_versions WHERE owner_user_id=$1 AND run_id=$2',[owner,input.run_id])).rows[0];if(old)return old;}
  await readProjectFileAsset(c,owner,input.asset);
  if(input.revision_asset)await readProjectFileAsset(c,owner,input.revision_asset);
  const v=(await c.query(`INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset,revision_asset,source_version_id,template_id,template_version,run_id,links)
    SELECT $1,$2,$3,COALESCE(max(sequence),0)+1,$4,$5,$6,$7,$8,$9,$10,$11 FROM bb_project_file_versions WHERE file_id=$3 RETURNING *`,
    [uid(),owner,family.id,input.filename,input.asset,input.revision_asset??null,input.source_version_id??null,input.template_id??null,input.template_version??null,input.run_id??null,JSON.stringify(input.links??[])])).rows[0];
  if(promote)await c.query('UPDATE bb_project_files SET latest_version_id=$3 WHERE owner_user_id=$1 AND id=$2',[owner,family.id,v.id]);
  await c.query('UPDATE bb_projects SET updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,family.project_id]);
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'project.file_version_saved',$4)`,
    [uid(),owner,family.project_id,{file_id:family.id,version_id:v.id,sequence:v.sequence,promoted:promote}]);
  return v;
}

export async function projectFileVersions(db:Db,owner:string,id:string):Promise<ProjectFileVersion[]>{
  await project(db,owner,id);const source=await projectFileSource(db,owner,id);
  const checks=(await db.query(`SELECT o.*,r.state FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
    WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.operation='check' ORDER BY o.created_at DESC`,[owner,id])).rows;
  const updates=(await db.query(`SELECT a.*,r.state,v.id AS new_version_id,patch.manifest AS patch_manifest FROM bb_project_file_acceptances a
    JOIN bb_project_file_operations o ON o.owner_user_id=a.owner_user_id AND o.run_id=a.check_run_id
    JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
    JOIN bb_project_file_operations patch ON patch.owner_user_id=a.owner_user_id AND patch.run_id=a.run_id
    LEFT JOIN bb_project_file_versions v ON v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
    WHERE a.owner_user_id=$1 AND o.project_id=$2`,[owner,id])).rows;
  const rows=(await db.query(`SELECT v.*,f.document_type,f.latest_version_id,s.filename AS source_name,s.sequence AS source_sequence,
    count(*) OVER(PARTITION BY f.id)::int AS version_count FROM bb_project_files f
    JOIN bb_project_file_versions v ON v.owner_user_id=f.owner_user_id AND v.file_id=f.id
    LEFT JOIN bb_prospectus_versions s ON s.owner_user_id=v.owner_user_id AND s.id=v.source_version_id
    LEFT JOIN bb_runs r ON r.owner_user_id=v.owner_user_id AND r.id=v.run_id
    WHERE f.owner_user_id=$1 AND f.project_id=$2 AND (v.run_id IS NULL OR r.state='succeeded') ORDER BY v.created_at DESC,v.id DESC`,[owner,id])).rows;
  return rows.map(row=>{
    const check=checks.find(c=>c.manifest.files.some((f:any)=>f.file_id===row.file_id));
    let status:ProjectFileVersion['consistency']['status']=row.source_version_id&&row.source_version_id!==source?.version_id?'stale':'unchecked',count=0;
    if(check){
      const target=check.manifest.files.find((f:any)=>f.file_id===row.file_id),result=check.result?.files.find((f:any)=>f.file_version_id===target.file_version_id);
      const accepted=updates.filter(a=>a.check_run_id===check.run_id&&a.file_version_id===target.file_version_id&&a.state==='succeeded');
      const applied=accepted.find(a=>a.new_version_id===row.id);
      const acceptedIds=new Set(applied?.patch_manifest.findings.map((f:any)=>f.id)??[]);
      const matchingVersion=row.id===target.file_version_id||accepted.some(a=>a.new_version_id===row.id);
      if(check.manifest.source.version_id!==source?.version_id||check.manifest.source.selection_revision!==source?.selection_revision||!matchingVersion)status='stale';
      else if(['queued','running','validating','delivering','preparing'].includes(check.state))status='checking';
      else if(check.state==='succeeded'&&result){
        count=result.findings.filter((f:any)=>f.kind==='conflict'&&!acceptedIds.has(f.id)).length;
        status=count?'conflict':result.findings.some((f:any)=>f.kind==='manual')?'manual':applied?'updated':result.status;
      }
    }
    return {version_id:row.id,file_id:row.file_id,document_type:row.document_type,filename:row.filename,sequence:row.sequence,asset:row.asset,revision_asset:row.revision_asset,
      source_version_id:row.source_version_id,template_id:row.template_id,template_version:row.template_version,source_name:row.source_name,source_sequence:row.source_sequence,
      created_at:date(row.created_at),run_id:row.run_id,links:row.links,latest:row.latest_version_id===row.id,version_count:row.version_count,
      consistency:{status,count,check_run_id:check?.run_id??null}};
  });
}

/** Runs inside queue.finish's locked transaction; failed/unpublished outputs never replace a current file. */
export async function registerProjectFileOutcome(c:PoolClient,run:any,artifact:{id:string;version:number},pair:any){
  const input=(await c.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[run.owner_user_id,run.project_id,run.input_revision])).rows[0]?.manifest;
  // Catalogue items have independent identities in bb_workpaper_items; they are not
  // successive versions of the twelve fixed project document families.
  if(input?.version==='m4-document-input-v1'&&input.input?.document_type==='workpaper')return;
  const link=input?.kind==='document'?input.input?.project_file:null;
  const operation=input?.version==='project-file-operation-v1'?input:null;
  if(!link&&operation?.operation!=='patch'&&!(input?.kind==='document'&&input?.version==='m4-document-input-v1'))return;
  const owner=run.owner_user_id;
  const asset=async(id:string,version?:number):Promise<ProjectFileAsset>=>{
    const a=(await c.query(`SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND id=$3
      AND ($4::int IS NULL OR version=$4) AND delivery_status='available' AND quality_status='passed' ORDER BY version DESC LIMIT 1`,[owner,run.id,id,version??null])).rows[0];
    if(!a)throw missing();return {kind:'artifact',pin:{source_project_id:run.project_id,artifact_id:a.id,artifact_version:a.version,sha256:a.sha256.trim()}};
  };
  if(!link&&input?.kind==='document'){
    const topic=(await c.query('SELECT * FROM bb_m4_topics WHERE owner_user_id=$1 AND id=$2 AND surface<>\'assistant\'',[owner,input.topic_id])).rows[0];if(!topic)return;
    const source=topic.source_project_id??topic.project_id;
    const root=(await c.query('SELECT source_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND update_project_id=$2',[owner,source])).rows[0]?.source_project_id??source;
    const family=await projectFileFamily(c,owner,root,input.input.document_type);
    await appendProjectFile(c,owner,family,{filename:PROJECT_DOCUMENT_CATALOG.find(d=>d.id===input.input.document_type)!.name+'.docx',asset:await asset(artifact.id,artifact.version),
      template_id:input.input.template?.template_id,template_version:input.input.template?.template_version,run_id:run.id});
  }else if(link){
    const family=await projectFileFamily(c,owner,link.project_id,input.input.document_type);
    const metadata=(await c.query('SELECT result,result_hash FROM bb_project_file_generation_links WHERE owner_user_id=$1 AND run_id=$2',[owner,run.id])).rows[0];
    if(!metadata||inputManifestHash(metadata.result)!==metadata.result_hash.trim())throw conflict('INPUT_REVISION_CONFLICT','文件内容关联记录未保存。');
    const generated=await asset(artifact.id,artifact.version);
    if(metadata.result.source_sha256!==input.input.source_material.sha256||metadata.result.target_sha256!==generated.pin.sha256)throw conflict('INPUT_REVISION_CONFLICT','文件内容关联与成果版本不同。');
    await appendProjectFile(c,owner,family,{filename:PROJECT_DOCUMENT_CATALOG.find(d=>d.id===input.input.document_type)!.name+'.docx',asset:generated,
      source_version_id:link.source_version_id,template_id:input.input.template.template_id,template_version:input.input.template.template_version,run_id:run.id,links:metadata.result.links},family.latest_version_id===(link.expected_file_version_id??null));
  }else{
    const family=(await c.query('SELECT * FROM bb_project_files WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,operation.file_id])).rows[0];
    if(!family||!pair?.clean_artifact_id)throw missing();
    const source=await projectFileSource(c,owner,family.project_id);
    const clean=await asset(pair.clean_artifact_id),metadata=(await c.query('SELECT result,result_hash FROM bb_project_file_generation_links WHERE owner_user_id=$1 AND run_id=$2',[owner,run.id])).rows[0];
    if(!metadata||inputManifestHash(metadata.result)!==metadata.result_hash.trim()||metadata.result.source_sha256!==operation.source.asset.pin.sha256||metadata.result.target_sha256!==clean.pin.sha256)throw conflict('INPUT_REVISION_CONFLICT','更新文件内容关联与成果不一致。');
    const original=(await c.query('SELECT template_id,template_version FROM bb_project_file_versions WHERE owner_user_id=$1 AND id=$2',[owner,operation.file_version_id])).rows[0];
    await appendProjectFile(c,owner,family,{filename:operation.filename,asset:clean,revision_asset:await asset(artifact.id,artifact.version),
      source_version_id:operation.source.version_id,run_id:run.id,links:metadata.result.links,template_id:original?.template_id,template_version:original?.template_version},family.latest_version_id===operation.expected_current_version_id&&source?.version_id===operation.source.version_id&&source?.selection_revision===operation.source.selection_revision);
  }
}
