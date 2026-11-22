import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {GenerationProgressSchema,GenerationProgressQuerySchema,type GenerationProgress} from '@bondbuddy/contracts';
import {project,missing,digest} from './data.js';

type Db=Pool|PoolClient;
/**
 * Two SELECTs (three for a historical batch), no manifests, file links, templates or
 * documents cross the DB connection. Ordered state projections cover changes that
 * do not increment batch.revision: stage, delivery, billing and maintained versions.
 */
export async function readGenerationProgress(db:Db,owner:string,id:string,kind:'workpapers'|'file-generation',batch?:string):Promise<GenerationProgress>{
  await project(db,owner,id);
  if(batch&&!(await db.query('SELECT id FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[owner,id,batch])).rowCount)throw missing();
  const row=(await db.query(`
    WITH fg AS (
      SELECT id,workpaper_batch_id,document_batch_id FROM bb_file_generation_batches
      WHERE owner_user_id=$1 AND project_id=$2 AND $3='file-generation' ORDER BY created_at DESC,id DESC LIMIT 20
    ), recent AS (
      SELECT id FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND $3='workpapers'
      ORDER BY created_at DESC,id DESC LIMIT 10
    ), wb AS (
      SELECT id,state,revision,error,pause_reason FROM bb_workpaper_batches
      WHERE owner_user_id=$1 AND project_id=$2
        AND (id IN (SELECT id FROM recent) OR id IN (SELECT workpaper_batch_id FROM fg) OR id=$4)
    ), wi AS (
      SELECT i.batch_id,i.item_id,i.run_id,i.attempt,i.state,i.error,r.state AS run_state,r.stage,
        w.result_hash FROM bb_workpaper_items i
      JOIN wb ON wb.id=i.batch_id
      LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
      LEFT JOIN bb_workpaper_item_results w ON w.owner_user_id=i.owner_user_id AND w.run_id=i.run_id
      WHERE i.owner_user_id=$1
    ), db AS (
      SELECT b.id,b.state,b.items FROM bb_project_file_batches b
      WHERE b.owner_user_id=$1 AND b.project_id=$2 AND b.id IN (SELECT document_batch_id FROM fg)
    ), di AS (
      SELECT db.id,item->>'run_id' AS run_id,item->>'error' AS error,item->>'attempt' AS attempt,
        r.state,r.stage FROM db CROSS JOIN LATERAL jsonb_array_elements(db.items) item
      LEFT JOIN bb_runs r ON r.owner_user_id=$1 AND r.id=item->>'run_id'
    )
    SELECT
      (EXISTS(SELECT 1 FROM wb WHERE state IN ('queued','running')) OR
       EXISTS(SELECT 1 FROM db WHERE state IN ('queued','running')) OR
       EXISTS(SELECT 1 FROM wi WHERE run_state IN ('queued','preparing','running','validating','delivering')) OR
       EXISTS(SELECT 1 FROM di WHERE state IN ('queued','preparing','running','validating','delivering'))) AS active,
      (SELECT jsonb_agg(to_jsonb(fg) ORDER BY id) FROM fg) AS generation,
      (SELECT jsonb_agg(to_jsonb(wb) ORDER BY id) FROM wb) AS batches,
      (SELECT jsonb_agg(to_jsonb(wi) ORDER BY batch_id,item_id) FROM wi) AS items,
      (SELECT jsonb_agg(jsonb_build_array(id,state) ORDER BY id) FROM db) AS documents,
      (SELECT jsonb_agg(to_jsonb(di) ORDER BY id,run_id) FROM di) AS document_items,
      (SELECT jsonb_agg(jsonb_build_array(a.run_id,a.artifact_id,a.artifact_version,v.delivery_status,v.quality_status) ORDER BY a.run_id,a.artifact_id,a.artifact_version)
       FROM bb_m4_artifacts a JOIN bb_artifact_versions v ON v.owner_user_id=a.owner_user_id AND v.id=a.artifact_id AND v.version=a.artifact_version
       WHERE a.owner_user_id=$1 AND a.run_id IN (SELECT run_id FROM wi)) AS artifacts,
      (SELECT jsonb_agg(jsonb_build_array(c.run_id,c.state,c.charged_points::text,c.points::text) ORDER BY c.run_id)
       FROM bb_credit_reservations c WHERE c.owner_user_id=$1 AND c.run_id IN
         (SELECT a.run_id FROM bb_workpaper_attempts a JOIN wb ON wb.id=a.batch_id WHERE a.owner_user_id=$1)) AS charges,
      (SELECT jsonb_agg(jsonb_build_array(f.id,f.latest_version_id,v.id) ORDER BY f.id,v.id)
       FROM bb_project_files f JOIN bb_project_file_versions v ON v.owner_user_id=f.owner_user_id AND v.file_id=f.id
       WHERE f.owner_user_id=$1 AND f.project_id=$2) AS versions,
      (SELECT jsonb_agg(jsonb_build_array(o.run_id,o.result_hash,r.state) ORDER BY o.run_id)
       FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
       WHERE o.owner_user_id=$1 AND o.project_id=$2) AS checks,
      (SELECT jsonb_agg(jsonb_build_array(s.project_id,s.version_id,s.revision) ORDER BY s.project_id)
       FROM bb_prospectus_selection s WHERE s.owner_user_id=$1 AND (s.project_id=$2 OR s.project_id IN
         (SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2))) AS source
  `,[owner,id,kind,batch??null])).rows[0];
  return {revision:digest(JSON.stringify(row)),active:row.active};
}

export function registerGenerationProgress(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,kind:'workpapers'|'file-generation'){
  app.get('/api/v1/projects/:project_id/'+kind+'/progress',{
    schema:{querystring:GenerationProgressQuerySchema,response:{200:GenerationProgressSchema}}
  },async(r,reply)=>{
    const user=await owner(r),id=(r.params as {project_id:string}).project_id;
    const data=await readGenerationProgress(db(),user,id,kind,(r.query as {batch_id?:string}).batch_id);
    // Private change detection. No shared or persistent response cache.
    reply.header('Cache-Control','private, no-store');
    return data;
  });
}
