import { importProspectusMaterial } from './prospectus-import.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ReviewEditorResponseSchema, ReviewExportRequestSchema, ReviewSourceRequestSchema, RUN_PIPELINE_SUBTYPE, type ReviewExportRequest, type ReviewEditorResponse } from '@bondbuddy/contracts';
import { project, transaction, uid, missing, conflict, Problem, executionKeyStorage, assertCanonicalBusinessRunIdle, runDto, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { enqueue } from './queue.js';

export async function reviewEditor(db:Pool|PoolClient,user:string,id:string,runId:string):Promise<ReviewEditorResponse>{
  await project(db,user,id);
  const row=(await db.query(`SELECT e.* FROM bb_review_editors e JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id
    WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3 AND r.state IN ('succeeded','test_completed')`,[user,id,runId])).rows[0];
  if(!row)throw missing();
  if(inputManifestHash(row.snapshot)!==row.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','复核成果暂不可用。');
  return {run_id:runId,sha256:row.sha256.trim(),snapshot:row.snapshot};
}

export function registerReviewEditor(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs){
  app.get('/api/v1/projects/:project_id/review-executions/:run_id/editor',{schema:{response:{200:ReviewEditorResponseSchema}}},async(r,reply)=>{
    const p=r.params as {project_id:string;run_id:string};reply.header('Cache-Control','private, no-store');
    return reviewEditor(db(),await owner(r),p.project_id,p.run_id);
  });
  app.post('/api/v1/projects/:project_id/review-entry',async r=>{
    const user=await owner(r),id=(r.params as {project_id:string}).project_id;await project(db(),user,id);
    const target=(await db().query('SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2',[user,id])).rows[0]?.update_project_id??id;
    await project(db(),user,target);return {project_id:target};
  });
  app.post('/api/v1/projects/:project_id/review-source',{schema:{body:ReviewSourceRequestSchema}},async r=>{
    const user=await owner(r),id=(r.params as {project_id:string}).project_id,b=r.body as {version_id:string};
    return transaction(db(),c=>importProspectusMaterial(c,blobs(),user,id,b.version_id));
  });
  app.post('/api/v1/projects/:project_id/review-exports',{schema:{body:ReviewExportRequestSchema}},async r=>{
    const user=await owner(r),id=(r.params as {project_id:string}).project_id,b=r.body as ReviewExportRequest;
    return transaction(db(),async c=>{
      const p=await project(c,user,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
      const key=executionKeyStorage(b.request_id),requestHash=inputManifestHash({project_id:id,...b});
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${b.request_id}`]);
      const prior=(await c.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,key])).rows[0];
      if(prior){if(prior.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','请求已用于其他修改。');return runDto(prior);}
      await assertCanonicalBusinessRunIdle(c,user,p);
      const editor=await reviewEditor(c,user,id,b.source_run_id);
      if(editor.sha256!==b.expected_editor_sha256)throw conflict('INPUT_REVISION_CONFLICT','复核成果已变化，请重新载入。');
      const ids=new Set(b.decisions.map(d=>d.id));
      if(ids.size!==b.decisions.length||ids.size!==editor.snapshot.issues.length||editor.snapshot.issues.some(i=>!ids.has(i.id)))throw new Problem(422,'VALIDATION_FAILED','请提交这份成果的全部问题处理选择。');
      const source=(await c.query(`SELECT i.manifest,e.snapshot FROM bb_runs r JOIN bb_input_revisions i ON i.project_id=r.project_id AND i.owner_user_id=r.owner_user_id AND i.revision=r.input_revision
        JOIN bb_review_executions e ON e.run_id=r.id WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3`,[user,id,b.source_run_id])).rows[0];
      if(source?.manifest?.review?.file_delivery?.version!=='review-correction-v2')throw missing();
      const version=Number((await c.query('SELECT COALESCE(max(version),0)+1 n FROM bb_review_executions WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].n);
      const revision=Number((await c.query('SELECT COALESCE(max(revision),0)+1 n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].n);
      const manifest=source.manifest;
      manifest.review={...manifest.review,version_number:version,report_id:uid(),file_delivery:{...manifest.review.file_delivery,export:{source_run_id:b.source_run_id,editor_sha256:editor.sha256,decisions:b.decisions}}};
      const hash=inputManifestHash(manifest),runId=uid();
      await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,'[]')`,[id,revision,user,p.draft_revision,hash,manifest,JSON.stringify(manifest.materials)]);
      const run=(await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,billing_mode)
        VALUES($1,$2,$3,$4,$5,$6,'review',$7,'queued','platform_trial') RETURNING *`,[runId,user,id,revision,hash,key,requestHash])).rows[0];
      await c.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[runId,user,id,version,manifest.review.operation,manifest.review.source_report_id,{...source.snapshot,source_run_id:b.source_run_id,export_only:true}]);
      await c.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id,revision]);
      await enqueue(c,run,RUN_PIPELINE_SUBTYPE);
      return runDto({...run,stage:'queued',event_cursor:1});
    });
  });
}
