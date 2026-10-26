import { importProspectusMaterial } from './prospectus-import.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { ReviewEditorResponseSchema, ReviewEditorQuerySchema, ReviewEditorSnapshotSchema, ReviewExportRequestSchema, ReviewSourceRequestSchema, RUN_PIPELINE_SUBTYPE, type ReviewExportRequest, type ReviewEditorResponse, type ReviewEditorSnapshot, type ReviewEditorExecution, type ReviewEditorQuery } from '@bondbuddy/contracts';
import { project, transaction, uid, missing, conflict, Problem, executionKeyStorage, assertCanonicalBusinessRunIdle, runDto, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { enqueue, type Lease } from './queue.js';
import { assertRunExecution, type RunExecutionIdentity } from './run-execution.js';
import { readRunExecutionInput } from './run-execution-input.js';
import { testChannelEnabled } from './non-production-test.js';

const editorConflict=()=>conflict('INPUT_REVISION_CONFLICT','复核编辑快照与准确执行版本不一致。');
export const reviewEditorExecution=(identity:RunExecutionIdentity):ReviewEditorExecution=>({execution_version:identity.executionVersion,
  input_revision:identity.inputRevision,input_hash:identity.inputHash});

/** Resolve a source edition from persisted identity, never a different run's active lease or input projection. */
export async function resolveReviewEditorExecution(db:Pool|PoolClient,user:string,id:string,runId:string,
  version=1):Promise<RunExecutionIdentity>{
  await project(db,user,id);
  if(!Number.isInteger(version)||version<1||version>2147483647)throw missing();
  const row=(await db.query(`SELECT e.execution_version,e.input_revision,e.input_hash FROM bb_run_execution_versions e
    JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
    WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3 AND e.execution_version=$4`,[user,id,runId,version])).rows[0];
  if(!row)throw missing();
  return {executionVersion:row.execution_version,inputRevision:row.input_revision,inputHash:row.input_hash.trim()};
}

/** Save a trusted writer result only while the exact run/job lease is still current. */
export async function registerReviewEditorSnapshot(pool:Pool,lease:Lease,projectId:string,snapshot:ReviewEditorSnapshot):Promise<void>{
  if(!Value.Check(ReviewEditorSnapshotSchema,snapshot))throw editorConflict();
  const hash=inputManifestHash(snapshot);
  // A rolling old writer can hold the legacy unique key while waiting for our
  // parent locks. Retry only the complete, idempotent DB registration after a
  // deadlock; each attempt rechecks the live owner/run/job lease and identity.
  for(let attempt=0;attempt<3;attempt++)try{
    await transaction(pool,async c=>{
    const p=await project(c,lease.owner,projectId,true);
    if(p.archived_at)throw editorConflict();
    const run=(await c.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',
      [lease.owner,projectId,lease.runId])).rows[0];
    if(!run||run.state!=='running')throw editorConflict();
    const job=(await c.query(`SELECT id FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 AND state='running'
      AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,[lease.jobId,lease.owner,lease.runId,lease.token])).rows[0];
    if(!job)throw editorConflict();
    await assertRunExecution(c,run,lease);
    const frozen=await readRunExecutionInput(c,lease.owner,lease.runId,lease);
    const pin=frozen.reviewExecution?.snapshot.input?.source_material_ref;
    const review=frozen.input.manifest.review as {file_delivery?:{version?:string}}|undefined;
    if(frozen.run.project_id!==projectId||!pin||pin.sha256!==snapshot.source_sha256
      ||review?.file_delivery?.version!=='review-correction-v2')throw editorConflict();
    const exact=[lease.owner,projectId,lease.runId,lease.executionVersion,lease.inputRevision,lease.inputHash];
    await c.query(`INSERT INTO bb_review_execution_editors(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,snapshot,sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id,execution_version) DO NOTHING`,[...exact,snapshot,hash]);
    const saved=(await c.query(`SELECT snapshot,sha256,created_at FROM bb_review_execution_editors
      WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$4 AND input_revision=$5 AND input_hash=$6`,exact)).rows[0];
    if(!saved||saved.sha256.trim()!==hash||inputManifestHash(saved.snapshot)!==hash)throw editorConflict();
    // Old services read this immutable V1 mirror. Successors must never collide with its run primary key.
    if(lease.executionVersion===1){
      await c.query(`INSERT INTO bb_review_editors(owner_user_id,project_id,run_id,snapshot,sha256,created_at)
        SELECT owner_user_id,project_id,run_id,snapshot,sha256,created_at FROM bb_review_execution_editors
        WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$4 AND input_revision=$5 AND input_hash=$6
        ON CONFLICT(run_id) DO NOTHING`,exact);
      const legacy=await c.query(`SELECT 1 FROM bb_review_editors l JOIN bb_review_execution_editors e
        ON l.owner_user_id=e.owner_user_id AND l.project_id=e.project_id AND l.run_id=e.run_id
          AND l.snapshot=e.snapshot AND l.sha256=e.sha256 AND l.created_at=e.created_at
        WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3 AND e.execution_version=$4 AND e.input_revision=$5 AND e.input_hash=$6`,exact);
      if(legacy.rowCount!==1)throw editorConflict();
    }
    });
    return;
  }catch(error){
    if((error as {code?:string}).code!=='40P01'||attempt===2)throw error;
  }
}

export async function reviewEditor(db:Pool|PoolClient,user:string,id:string,runId:string,expected:RunExecutionIdentity):Promise<ReviewEditorResponse>{
  await project(db,user,id);
  if(!expected)throw editorConflict();
  const row=(await db.query(`SELECT e.*,i.manifest FROM bb_review_execution_editors e
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    JOIN bb_review_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
      AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
    JOIN bb_run_execution_deliveries d ON d.owner_user_id=e.owner_user_id AND d.project_id=e.project_id AND d.run_id=e.run_id
      AND d.execution_version=e.execution_version AND d.input_revision=e.input_revision AND d.input_hash=e.input_hash
      AND d.delivery_phase='final' AND bb_execution_delivery_phase_valid(d)
    WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3 AND e.execution_version=$4 AND e.input_revision=$5 AND e.input_hash=$6
      AND ((d.channel='production' AND d.terminal_state='succeeded') OR
        (d.channel='non_production_test' AND d.terminal_state='test_completed' AND $7::boolean AND EXISTS(
          SELECT 1 FROM bb_non_production_test_grants g WHERE g.grant_id=d.test_grant_id AND g.user_id=d.owner_user_id
            AND g.project_id=d.project_id AND g.input_revision=d.input_revision AND g.input_hash=d.input_hash
            AND g.revoked_at IS NULL AND g.expires_at>now())))
      AND NOT EXISTS(SELECT 1 FROM bb_run_execution_delivery_artifacts m
        JOIN bb_artifact_versions a ON a.owner_user_id=m.owner_user_id AND a.run_id=m.run_id
          AND a.id=m.artifact_id AND a.version=m.artifact_version AND a.sha256=m.artifact_sha256
        WHERE m.run_id=d.run_id AND m.execution_version=d.execution_version AND m.delivery_phase=d.delivery_phase
          AND NOT bb_execution_delivery_artifact_ready(a,d.channel))`,
    [user,id,runId,expected.executionVersion,expected.inputRevision,expected.inputHash,testChannelEnabled()])).rows[0];
  if(!row)throw missing();
  if(!Value.Check(ReviewEditorSnapshotSchema,row.snapshot)||inputManifestHash(row.snapshot)!==row.sha256.trim()
    ||inputManifestHash(row.manifest)!==expected.inputHash)throw new Problem(503,'DATA_UNAVAILABLE','复核成果暂不可用。');
  return {run_id:runId,sha256:row.sha256.trim(),snapshot:row.snapshot,execution:reviewEditorExecution(expected)};
}

export function registerReviewEditor(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs){
  app.get('/api/v1/projects/:project_id/review-executions/:run_id/editor',{
    // The server intentionally disables global AJV coercion. Convert only this
    // canonical integer query representation; the shared schema rejects the rest.
    preValidation:async r=>{
      const query=r.query as Record<string,unknown>,raw=query.execution_version;
      if(typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)){
        const parsed={...query,execution_version:Number(raw)};
        if(Value.Check(ReviewEditorQuerySchema,parsed))r.query=parsed;
      }
    },schema:{querystring:ReviewEditorQuerySchema,response:{200:ReviewEditorResponseSchema}}},async(r,reply)=>{
    const p=r.params as {project_id:string;run_id:string};reply.header('Cache-Control','private, no-store');
    const user=await owner(r),execution=await resolveReviewEditorExecution(db(),user,p.project_id,p.run_id,(r.query as ReviewEditorQuery).execution_version??1);
    return reviewEditor(db(),user,p.project_id,p.run_id,execution);
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
      const execution=await resolveReviewEditorExecution(c,user,id,b.source_run_id,b.source_execution?.execution_version??1);
      if(b.source_execution&&!Value.Equal(b.source_execution,reviewEditorExecution(execution)))throw editorConflict();
      const editor=await reviewEditor(c,user,id,b.source_run_id,execution);
      if(editor.sha256!==b.expected_editor_sha256)throw conflict('INPUT_REVISION_CONFLICT','复核成果已变化，请重新载入。');
      const ids=new Set(b.decisions.map(d=>d.id));
      if(ids.size!==b.decisions.length||ids.size!==editor.snapshot.issues.length||editor.snapshot.issues.some(i=>!ids.has(i.id)))throw new Problem(422,'VALIDATION_FAILED','请提交这份成果的全部问题处理选择。');
      const source=(await c.query(`SELECT i.manifest,e.snapshot FROM bb_review_execution_snapshots e
        JOIN bb_input_revisions i ON i.project_id=e.project_id AND i.owner_user_id=e.owner_user_id AND i.revision=e.input_revision AND i.input_hash=e.input_hash
        WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3 AND e.execution_version=$4 AND e.input_revision=$5 AND e.input_hash=$6`,
        [user,id,b.source_run_id,execution.executionVersion,execution.inputRevision,execution.inputHash])).rows[0];
      if(source?.manifest?.review?.file_delivery?.version!=='review-correction-v2')throw missing();
      const version=Number((await c.query('SELECT COALESCE(max(version),0)+1 n FROM bb_review_execution_snapshots WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].n);
      const revision=Number((await c.query('SELECT COALESCE(max(revision),0)+1 n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].n);
      const manifest=structuredClone(source.manifest),sourceExecution=reviewEditorExecution(execution);
      manifest.review={...manifest.review,version_number:version,report_id:uid(),file_delivery:{...manifest.review.file_delivery,export:{source_run_id:b.source_run_id,source_execution:sourceExecution,editor_sha256:editor.sha256,decisions:b.decisions}}};
      const hash=inputManifestHash(manifest),runId=uid();
      await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,'[]')`,[id,revision,user,p.draft_revision,hash,manifest,JSON.stringify(manifest.materials)]);
      const run=(await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,billing_mode)
        VALUES($1,$2,$3,$4,$5,$6,'review',$7,'queued','platform_trial') RETURNING *`,[runId,user,id,revision,hash,key,requestHash])).rows[0];
      await c.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[runId,user,id,version,manifest.review.operation,manifest.review.source_report_id,{...source.snapshot,source_run_id:b.source_run_id,source_execution:sourceExecution,export_only:true}]);
      await c.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id,revision]);
      await enqueue(c,run,RUN_PIPELINE_SUBTYPE);
      return runDto({...run,stage:'queued',event_cursor:1});
    });
  });
}
