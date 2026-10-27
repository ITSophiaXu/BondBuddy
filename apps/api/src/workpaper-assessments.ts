import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {WorkpaperAssessSchema,type WorkpaperAssess,type WorkpaperAssessment,type WorkpaperAssessmentInput,type WorkpaperEntry} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,missing,Problem,date,assertCanonicalBusinessRunIdle} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {projectFileSource,readProjectFileAsset} from './project-file-storage.js';
import {readM4MaterialPin} from './m4-workspace.js';
import {enqueue} from './queue.js';
export async function readWorkpaperAssessments(db:Pool|PoolClient,owner:string,id:string,requested?:string):Promise<WorkpaperAssessment[]>{
 await project(db,owner,id);
 const rows=(await db.query(`SELECT a.*,r.state,(SELECT coalesce(sum(jsonb_array_length(c.decisions)),0) FROM bb_workpaper_assessment_chunks c WHERE c.run_id=a.run_id) completed_items
 FROM bb_workpaper_assessments a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
 WHERE a.owner_user_id=$1 AND a.project_id=$2 ORDER BY (a.run_id=$3) DESC NULLS LAST,a.created_at DESC LIMIT 20`,[owner,id,requested??null])).rows;
 return rows.map(a=>({assessment_id:a.run_id,state:a.state,source:a.manifest.source,request:a.manifest.request,created_at:date(a.created_at),
 result_hash:a.state==='succeeded'?a.result_hash?.trim()??null:null,decisions:a.state==='succeeded'?a.result?.decisions??[]:[],warnings:a.result?.warnings??[],completed_items:Number(a.completed_items)}));
}
export function registerWorkpaperAssessments(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>){
 app.post('/api/v1/projects/:project_id/workpapers/assessments',{schema:{body:WorkpaperAssessSchema}},async r=>{
  const user=await owner(r),id=(r.params as {project_id:string}).project_id,b=r.body as WorkpaperAssess,requestHash=inputManifestHash({id,...b});
  const runId=await transaction(db(),async c=>{
   const p=await project(c,user,id,true),key='workpaper-assessment:'+b.request_id;
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':'+key]);
   const old=(await c.query('SELECT id,request_hash FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,key])).rows[0];
   if(old){if(old.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','此判断请求已使用。');return old.id;}
   if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
   await assertCanonicalBusinessRunIdle(c,user,p);
   const cat=(await c.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,b.catalogue_id])).rows[0];
   if(!cat)throw missing();if(cat.sha256.trim()!==b.catalogue_sha256)throw conflict('INPUT_REVISION_CONFLICT','目录已变化，请重新核对。');
   const entries=(cat.entries as WorkpaperEntry[]).filter(e=>e.kind==='file'&&b.item_ids.includes(e.id));
   if(entries.length!==b.item_ids.length)throw new Problem(422,'VALIDATION_FAILED','请选择有效底稿行。');
   const source=await projectFileSource(c,user,id);
   if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.source_selection_revision)throw conflict('PROJECT_FILE_BATCH_INPUT_EXPIRED','募集书依据已变化，请刷新后重新判断。');
   await readProjectFileAsset(c,user,source.asset);await readM4MaterialPin(c,user,cat.material);
   const manifest:WorkpaperAssessmentInput={version:'workpaper-assessment-v1',request:b,source,entries},hash=inputManifestHash(manifest),run=uid();
   const revision=Number((await c.query('SELECT coalesce(max(revision),0)+1 n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].n);
   await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,'[]','[]')",[id,revision,user,p.draft_revision,hash,manifest]);
   const row=(await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,'generation',$7,'queued') RETURNING *",[run,user,id,revision,hash,key,requestHash])).rows[0];
   await c.query('INSERT INTO bb_workpaper_assessments(run_id,owner_user_id,project_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',[run,user,id,manifest,hash]);
   await c.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id,revision]);
   await enqueue(c,row,'workpaper_assessment_v1');
   await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'workpaper.assessment_started',$4)",[uid(),user,id,{run_id:run}]);
   return run;
  });
  return (await readWorkpaperAssessments(db(),user,id,runId)).find(a=>a.assessment_id===runId);
 });
}
