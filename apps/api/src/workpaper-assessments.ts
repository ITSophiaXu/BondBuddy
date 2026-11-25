import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {WorkpaperAssessSchema,type WorkpaperAssess,type WorkpaperAssessment} from '@bondbuddy/contracts';
import {project,transaction,conflict,missing,Problem,date} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
export async function readWorkpaperAssessments(db:Pool|PoolClient,owner:string,id:string,requested?:string):Promise<WorkpaperAssessment[]>{
 await project(db,owner,id);
 const rows=(await db.query(`SELECT a.*,r.state,r.stage,paused.reason,coalesce(paused.error_code,provider.error_code) AS error_code,(SELECT coalesce(sum(jsonb_array_length(c.decisions)),0) FROM bb_workpaper_assessment_chunks c WHERE c.run_id=a.run_id) completed_items
 FROM bb_workpaper_assessments a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
 LEFT JOIN LATERAL (SELECT e.payload->>'reason' AS reason,e.payload->>'error_code' AS error_code FROM bb_run_events e
  WHERE e.owner_user_id=r.owner_user_id AND e.run_id=r.id AND r.state='paused' AND e.state=r.state
   AND e.stage IS NOT DISTINCT FROM r.stage AND e.type='run.state_changed' AND e.seq<=r.event_cursor ORDER BY e.seq DESC LIMIT 1) paused ON true
 LEFT JOIN LATERAL (SELECT o.error_code FROM bb_provider_call_observations o WHERE r.state='paused' AND r.stage='provider_reconcile'
  AND o.owner_user_id=r.owner_user_id AND o.run_id=r.id ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) provider ON true
 WHERE a.owner_user_id=$1 AND a.project_id=$2 ORDER BY (a.run_id=$3) DESC NULLS LAST,a.created_at DESC LIMIT 20`,[owner,id,requested??null])).rows;
 return rows.map(a=>({assessment_id:a.run_id,state:a.state,source:a.manifest.source,request:a.manifest.request,created_at:date(a.created_at),
 result_hash:a.state==='succeeded'?a.result_hash?.trim()??null:null,decisions:a.state==='succeeded'?a.result?.decisions??[]:[],warnings:a.result?.warnings??[],completed_items:Number(a.completed_items),
 pause:a.state==='paused'?{stage:a.stage??null,reason:typeof a.reason==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(a.reason)?a.reason:null,
  error_code:typeof a.error_code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(a.error_code)?a.error_code:null}:null}));
}
export function registerWorkpaperAssessments(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>){
 app.get('/api/v1/projects/:project_id/workpapers/assessments/:run_id',async r=>{
  const {project_id:id,run_id:run} = r.params as {project_id:string;run_id:string};
  const assessment=(await readWorkpaperAssessments(db(),await owner(r),id,run)).find(a=>a.assessment_id===run);
  if(!assessment)throw missing();return assessment;
 });
 app.post('/api/v1/projects/:project_id/workpapers/assessments',{schema:{body:WorkpaperAssessSchema}},async r=>{
  const user=await owner(r),id=(r.params as {project_id:string}).project_id,b=r.body as WorkpaperAssess,requestHash=inputManifestHash({id,...b});
  const runId=await transaction(db(),async c=>{
   await project(c,user,id,true);const key='workpaper-assessment:'+b.request_id;
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':'+key]);
   const old=(await c.query('SELECT id,request_hash FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,key])).rows[0];
   if(old){if(old.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','此判断请求已使用。');return old.id;}
   throw new Problem(410,'VALIDATION_FAILED','尽职调查底稿包已下线，不能新建可生成性判断。');
  });
  return (await readWorkpaperAssessments(db(),user,id,runId)).find(a=>a.assessment_id===runId);
 });
}
