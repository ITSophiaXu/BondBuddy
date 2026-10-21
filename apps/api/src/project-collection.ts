import type { Pool } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { schemas } from '@bondbuddy/contracts';
import type { Static } from '@sinclair/typebox';
import { date, project, Problem } from './data.js';
import { artifactDownloadName, artifactNameColumns, artifactNameJoins } from './artifact-filename.js';

// Each member must independently belong to this owner. Hidden assistant topics never
// become document tasks or project files. A source project remains the collection root.
export const memberProjectsSql = (alias:string) => `
 SELECT member.id FROM bb_projects member
 WHERE member.owner_user_id=${alias}.owner_user_id AND member.deleted_at IS NULL
 AND (member.id=${alias}.id
   OR member.id IN(SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=${alias}.owner_user_id AND source_project_id=${alias}.id)
   OR member.id IN(SELECT t.project_id FROM bb_m4_topics t WHERE t.owner_user_id=${alias}.owner_user_id AND t.surface<>'assistant'
     AND (t.source_project_id=${alias}.id OR t.source_project_id IN(SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=${alias}.owner_user_id AND source_project_id=${alias}.id))))
`;
export const collectionTasksSql = `
 SELECT r.*, CASE WHEN e.run_id IS NOT NULL THEN 'review' ELSE r.task_kind END AS display_kind,
   coalesce(CASE WHEN ir.operation='check' THEN 'integrity_check' WHEN ir.operation='export' THEN 'integrity_export' END,e.operation,CASE WHEN pf.operation='check' THEN 'file_check' WHEN pf.operation='patch' THEN 'file_patch' END) AS operation, t.id AS topic_id, me.manifest#>>'{input,document_type}' AS document_type,
   (SELECT id FROM bb_review_reports rep WHERE rep.owner_user_id=r.owner_user_id AND rep.run_id=r.id LIMIT 1) AS report_id,
   row_number() OVER(PARTITION BY r.project_id,CASE WHEN e.run_id IS NOT NULL THEN 'review' ELSE r.task_kind END,
     coalesce(me.manifest#>>'{input,document_type}',pf.operation,'integrity_'||ir.operation,'') ORDER BY r.created_at DESC,r.id DESC) AS lane_rank
 FROM bb_runs r
 LEFT JOIN bb_integrity_runs ir ON ir.owner_user_id=r.owner_user_id AND ir.run_id=r.id
 LEFT JOIN bb_project_file_operations pf ON pf.owner_user_id=r.owner_user_id AND pf.run_id=r.id
 LEFT JOIN bb_review_executions e ON e.owner_user_id=r.owner_user_id AND e.run_id=r.id
 LEFT JOIN bb_m4_executions me ON me.owner_user_id=r.owner_user_id AND me.run_id=r.id
 LEFT JOIN bb_m4_topics t ON t.owner_user_id=r.owner_user_id AND t.id=me.topic_id
 WHERE r.owner_user_id=$1 AND r.project_id IN(SELECT id FROM members)
   AND (t.id IS NULL OR t.surface<>'assistant')
`;
export const activeTaskSql = "('preparing','queued','running','validating','delivering','settlement_pending')";
export const terminalTaskSql = "('succeeded','test_completed','failed','cancelled','rejected')";
export const taskDto = (r:any) => r ? ({
  run_id:r.id,project_id:r.project_id,kind:r.display_kind,state:r.state,stage:r.stage,
  created_at:date(r.created_at),updated_at:date(r.updated_at),artifact_id:r.artifact_id??null,
  report_id:r.report_id??null,topic_id:r.topic_id??null,document_type:r.document_type??null,operation:r.operation??null
}) : null;

// One entry per immutable file version. Only successful delivered artifacts are shown;
// execution snapshots, prompts, failed deliveries and assistant output stay private.
export const collectionFilesSql = `
 SELECT m.id AS file_id,m.sha256||':'||m.role AS file_key,m.project_id,'material'::text AS source,
 m.filename,m.version,m.version AS display_version,m.sha256,m.persisted_at AS created_at,
 CASE WHEN m.role='historical' THEN '2' ELSE 'sources' END AS folder,NULL::text AS run_id,
 EXISTS(SELECT 1 FROM bb_prospectus_selection s JOIN bb_prospectus_versions v ON v.id=s.version_id AND v.owner_user_id=s.owner_user_id
   WHERE s.owner_user_id=m.owner_user_id AND v.material_id=m.id AND v.material_version=m.version) AS current,
 NULL::jsonb AS naming
 FROM bb_material_versions m WHERE m.owner_user_id=$1 AND m.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM bb_project_file_versions fv JOIN bb_project_files ff ON ff.owner_user_id=fv.owner_user_id AND ff.id=fv.file_id WHERE fv.owner_user_id=m.owner_user_id AND ff.project_id IN(SELECT id FROM members) AND fv.asset#>>'{pin,material_id}'=m.id AND (fv.asset#>>'{pin,material_version}')::int=m.version)
 AND (m.project_id IN(SELECT id FROM members) OR EXISTS(
   SELECT 1 FROM bb_m4_topic_materials tm JOIN bb_m4_topics t ON t.owner_user_id=tm.owner_user_id AND t.id=tm.topic_id
   WHERE tm.owner_user_id=m.owner_user_id AND tm.source_project_id=m.project_id AND tm.material_id=m.id AND tm.material_version=m.version
     AND t.project_id IN(SELECT id FROM members) AND t.surface<>'assistant'))
 UNION ALL
 SELECT a.id,r.project_id||':'||coalesce(CASE WHEN n_input.manifest->>'version'='integrity-round-v1' THEN 'integrity' END,n_m4.document_type,CASE WHEN n_review.run_id IS NOT NULL THEN 'review' ELSE r.task_kind END)||':'||
   coalesce(n_integrity.kind,n_m4.kind,n_review_art.kind,CASE WHEN n_job.checkpoint#>>'{stages,word_delivery_pair,clean_artifact_id}'=a.id THEN 'clean'
    WHEN n_job.checkpoint#>>'{stages,word_delivery_pair,revision_artifact_id}'=a.id THEN 'revision' ELSE 'result' END),
 r.project_id,'artifact','',a.version,a.version,a.sha256,a.created_at,
 CASE WHEN n_input.manifest->>'version'='integrity-round-v1' THEN '4.3' WHEN n_m4.kind='preparation_note' THEN '4.1' WHEN n_m4.document_type='init' THEN '1'
   WHEN n_m4.document_type IN ('annual','semiannual') THEN '3' WHEN n_m4.document_type IN ('issuer','financial','credit','proceeds') THEN '4.1' WHEN n_m4.document_type IS NOT NULL THEN '2.2' WHEN n_input.manifest->>'version'='project-file-operation-v1' THEN '4.2' WHEN n_review_art.kind='report' THEN '4.2' ELSE '2' END,r.id,
 EXISTS(SELECT 1 FROM bb_prospectus_selection s JOIN bb_prospectus_versions v ON v.id=s.version_id AND v.owner_user_id=s.owner_user_id
   WHERE s.owner_user_id=a.owner_user_id AND v.artifact_id=a.id AND v.artifact_version=a.version),
 (SELECT to_jsonb(names) FROM (SELECT a.id,a.version,a.media_type,${artifactNameColumns('a')}) names)
 FROM bb_artifact_versions a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
 ${artifactNameJoins('a')}
 WHERE a.owner_user_id=$1 AND r.project_id IN(SELECT id FROM members) AND r.state='succeeded'
 AND a.quality_status='passed' AND a.delivery_status='available'
 AND NOT EXISTS(SELECT 1 FROM bb_project_file_versions fv JOIN bb_project_files ff ON ff.owner_user_id=fv.owner_user_id AND ff.id=fv.file_id WHERE fv.owner_user_id=a.owner_user_id AND ff.project_id IN(SELECT id FROM members)
   AND ((fv.asset#>>'{pin,artifact_id}'=a.id AND (fv.asset#>>'{pin,artifact_version}')::int=a.version) OR (fv.revision_asset#>>'{pin,artifact_id}'=a.id AND (fv.revision_asset#>>'{pin,artifact_version}')::int=a.version)))
 AND (a.id=r.artifact_id OR n_integrity.kind IS NOT NULL OR n_m4.kind IN('document','preparation_note') OR n_review_art.kind IS NOT NULL
   OR a.id IN(n_job.checkpoint#>>'{stages,word_delivery_pair,clean_artifact_id}',n_job.checkpoint#>>'{stages,word_delivery_pair,revision_artifact_id}'))
 UNION ALL
 SELECT coalesce(v.asset#>>'{pin,material_id}',v.asset#>>'{pin,artifact_id}'),'project-file:'||f.id,
 v.asset#>>'{pin,source_project_id}',v.asset->>'kind',v.filename,
 coalesce(v.asset#>>'{pin,material_version}',v.asset#>>'{pin,artifact_version}')::int,v.sequence,v.asset#>>'{pin,sha256}',v.created_at,
 CASE f.document_type WHEN 'init' THEN '1' WHEN 'annual' THEN '3' WHEN 'semiannual' THEN '3'
 WHEN 'issuer' THEN '4.1' WHEN 'financial' THEN '4.1' WHEN 'credit' THEN '4.1' WHEN 'proceeds' THEN '4.1' ELSE '2.2' END,
 v.run_id,false,NULL::jsonb FROM bb_project_files f JOIN bb_project_file_versions v ON v.owner_user_id=f.owner_user_id AND v.file_id=f.id
 LEFT JOIN bb_runs r ON r.owner_user_id=v.owner_user_id AND r.id=v.run_id
 WHERE f.owner_user_id=$1 AND f.project_id IN(SELECT id FROM members) AND (v.run_id IS NULL OR r.state='succeeded')
`;
export async function collectionScope(db:Pool,owner:string,id:string) {
  await project(db,owner,id);
  return `SELECT members.id FROM bb_projects p CROSS JOIN LATERAL(${memberProjectsSql('p')}) members WHERE p.owner_user_id=$1 AND p.id=$2`;
}
export function registerProjectCollection(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>) {
  app.get('/api/v1/projects/:project_id/tasks',{schema:{querystring:schemas.ProjectTasksQuery,response:{200:schemas.ProjectTasksResponse}}},async request=>{
    const user=await owner(request),id=(request.params as {project_id:string}).project_id,scope=await collectionScope(db(),user,id);
    const q=request.query as Static<typeof schemas.ProjectTasksQuery>;let cursor:{time:string;id:string}|null=null;
    if(q.cursor)try{
      const c=JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8'));
      if(c.project!==id||typeof c.id!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.time)||!Number.isFinite(Date.parse(c.time)))throw Error();
      cursor=c;
    }catch{throw new Problem(422,'VALIDATION_FAILED','Invalid task cursor');}
    const limit=Number(q.limit??20);
    const rows=(await db().query(`WITH members AS(${scope}),tasks AS(${collectionTasksSql})
      SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM tasks
      WHERE ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text))
      ORDER BY created_at DESC,id DESC LIMIT $5`,[user,id,cursor?.time??null,cursor?.id??null,limit+1])).rows;
    const page=rows.slice(0,limit),last=page.at(-1);
    return {project_id:id,items:page.map(taskDto),page:{has_more:rows.length>limit,next_cursor:rows.length>limit?Buffer.from(JSON.stringify({project:id,time:last.cursor_time,id:last.id})).toString('base64url'):null}};
  });
  app.get('/api/v1/projects/:project_id/files',{schema:{response:{200:schemas.ProjectFilesResponse}}},async request=>{
    const user=await owner(request),id=(request.params as {project_id:string}).project_id,scope=await collectionScope(db(),user,id);
    const rows=(await db().query(`WITH members AS(${scope}),files AS(${collectionFilesSql})
      SELECT *,row_number() OVER(PARTITION BY file_key ORDER BY created_at DESC,file_id DESC,version DESC)=1 AS latest,
      count(*) OVER(PARTITION BY file_key)::int AS version_count FROM files ORDER BY created_at DESC,file_id DESC,version DESC`,[user,id])).rows;
    const currentFiles=(await db().query('SELECT f.id,v.sequence FROM bb_project_files f JOIN bb_project_file_versions v ON v.owner_user_id=f.owner_user_id AND v.id=f.latest_version_id WHERE f.owner_user_id=$1 AND f.project_id=$2',[user,id])).rows;
    for(const row of rows)if(row.file_key.startsWith('project-file:'))row.latest=currentFiles.some(f=>'project-file:'+f.id===row.file_key&&f.sequence===row.display_version);
    return {project_id:id,items:rows.map(({naming,...row})=>({...row,sha256:row.sha256.trim(),created_at:date(row.created_at),...(naming?artifactDownloadName(naming):{})}))};
  });
}
