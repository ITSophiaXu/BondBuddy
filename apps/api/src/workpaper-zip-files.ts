import type {Pool,PoolClient} from 'pg';
import {workpaperZipPath,type WorkpaperBatch,type BillingWireDto} from '@bondbuddy/contracts';
import {missing} from './data.js';
import type {WorkpaperZipFile} from './workpaper-zip.js';

/** Batch metadata has already been owner-checked. Resolve the visible, current
 * pins in two queries rather than re-reading the project for every DOCX. */
export async function readWorkpaperZipFiles(db:Pool|PoolClient,owner:string,data:BillingWireDto<WorkpaperBatch,'workpaperBatch'>):Promise<WorkpaperZipFile[]>{
  const explanationItems=data.items.filter(i=>i.explanation);
  const explanations=explanationItems.length?(await db.query(`SELECT i.item_id,coalesce(i.explanation,w.explanation) AS explanation
    FROM bb_workpaper_items i LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
    LEFT JOIN bb_workpaper_item_results w ON w.owner_user_id=i.owner_user_id AND w.run_id=i.run_id AND r.state='succeeded'
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=ANY($3::text[])`,[owner,data.batch_id,explanationItems.map(i=>i.entry.id)])).rows:[];
  const documents=data.items.flatMap(item=>item.artifacts.filter(a=>a.kind==='document').map(a=>({item,pin:a.pin})));
  const artifacts=documents.length?(await db.query(`SELECT a.object_key,a.sha256,pin.source_project_id,pin.artifact_id,pin.artifact_version
    FROM jsonb_to_recordset($2::jsonb) AS pin(source_project_id text,artifact_id text,artifact_version integer,sha256 text)
    JOIN bb_artifact_versions a ON a.owner_user_id=$1 AND a.id=pin.artifact_id AND a.version=pin.artifact_version AND a.sha256=pin.sha256
    JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.project_id=pin.source_project_id
    JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id AND p.deleted_at IS NULL
    WHERE a.delivery_status='available' AND a.quality_status='passed'`,[owner,JSON.stringify(documents.map(d=>d.pin))])).rows:[];
  const used=new Set<string>(),files:WorkpaperZipFile[]=[];
  for(const item of explanationItems){
    const stored=explanations.find(e=>e.item_id===item.entry.id)?.explanation;
    if(!stored||stored.sha256!==item.explanation!.sha256)throw missing();
    files.push({path:workpaperZipPath(item.entry,true,used),key:stored.key,sha256:stored.sha256,maxBytes:1024*1024});
  }
  for(const {item,pin} of documents){
    const stored=artifacts.find(a=>a.source_project_id===pin.source_project_id&&a.artifact_id===pin.artifact_id&&a.artifact_version===pin.artifact_version&&a.sha256.trim()===pin.sha256);
    if(!stored)throw missing();
    files.push({path:workpaperZipPath(item.entry,false,used),key:stored.object_key,sha256:pin.sha256,maxBytes:64*1024*1024});
  }
  return files;
}
