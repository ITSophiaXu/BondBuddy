import type { PoolClient } from 'pg';
import { date, Problem, transaction, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { assertRunExecution, readExecutionStages } from './run-execution.js';
import { providerCallNeedsReconciliation } from './queue.js';
import { readRunSupplementCandidate } from './run-supplement-draft.js';
import { loadRunSupplementProcessingBasis, type RunSupplementProcessingBasis,
  type RunSupplementProcessingBasisInput, type RunSupplementProcessingKind } from './run-supplement-preparation.js';

export type RunSupplementProcessingPlanBody={
  version:'run-supplement-processing-plan-v1';kind:RunSupplementProcessingKind;
  owner:string;projectId:string;runId:string;revision:number;requestId:string;
  receipt:{requestId:string;requestHash:string};sourceExecution:RunSupplementProcessingBasis['sourceExecution'];
  checkpointHash:string;candidateInputHash:string;basisHash:string;
  materials:RunSupplementProcessingBasis['materials'][number]['pin'][];
  delta:Pick<RunSupplementProcessingBasis['delta'],'additions'|'replacements'|'unchanged'|'discardPreviousOutput'>;
  priorWorkStatus:RunSupplementProcessingBasis['priorWorkStatus'];priorWork:RunSupplementProcessingBasis['priorWork'];
  recipe:{version:'supplement-conservative-full-review-v1';candidateScope:'all_candidate_materials';
    previousWork:'saved_clean_editing_baseline'|'source_reference_only'|'none';retainedClaims:'recheck_against_complete_candidate';
    operationScope:'preserve_frozen_operation_and_selected_findings';unsavedScratch:'unavailable'};
};
export type RunSupplementProcessingPlan={id:string;planHash:string;basisHash:string;
  body:RunSupplementProcessingPlanBody;createdAt:string};
export type CreateRunSupplementProcessingPlanInput=RunSupplementProcessingBasisInput & {
  kind:RunSupplementProcessingKind;requestId:string;expectedBasisHash:string};
export type ReadRunSupplementProcessingPlanInput=RunSupplementProcessingBasisInput & {
  kind:RunSupplementProcessingKind;planId:string};
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const unavailable=()=>new Problem(409,'INPUT_REVISION_CONFLICT','续做处理计划或补料依据已变化，请保留补料并重新核对。');
const key=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=128;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a:unknown,b:unknown)=>inputManifestHash(a)===inputManifestHash(b);

function body(basis:RunSupplementProcessingBasis,requestId:string):RunSupplementProcessingPlanBody{
  const {additions,replacements,unchanged,discardPreviousOutput}=basis.delta;
  const planned:RunSupplementProcessingPlanBody={version:'run-supplement-processing-plan-v1',kind:basis.kind,
    owner:basis.owner,projectId:basis.projectId,runId:basis.runId,revision:basis.revision,requestId,
    receipt:{requestId:basis.requestId,requestHash:basis.requestHash},sourceExecution:basis.sourceExecution,
    checkpointHash:basis.checkpointHash,candidateInputHash:basis.candidateInputHash,basisHash:basis.basisHash,
    materials:basis.materials.map(material=>material.pin),delta:{additions,replacements,unchanged,discardPreviousOutput},
    priorWorkStatus:basis.priorWorkStatus,priorWork:basis.priorWork,
    recipe:{version:'supplement-conservative-full-review-v1',candidateScope:'all_candidate_materials',
      previousWork:!basis.priorWork?'none':basis.kind==='authoring'&&!discardPreviousOutput?'saved_clean_editing_baseline':'source_reference_only',
      retainedClaims:'recheck_against_complete_candidate',
      operationScope:'preserve_frozen_operation_and_selected_findings',unsavedScratch:'unavailable'}};
  return structuredClone(planned);
}

/** Scope locks never span Blob I/O or the independent content-purge transactions.
 * Under project -> run -> job locks, check the live identity, captured receipt,
 * candidate and byte metadata again before persisting or consuming a plan. */
async function recheck(db:PoolClient,input:RunSupplementProcessingBasisInput,basis:RunSupplementProcessingBasis){
  const project=(await db.query(`SELECT p.* FROM bb_projects p JOIN bb_users u ON u.id=p.owner_user_id
    WHERE p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL AND p.archived_at IS NULL
      AND u.closed_at IS NULL AND u.status<>'closed' FOR UPDATE OF p`,[input.owner,input.projectId])).rows[0];
  if(!project)throw unavailable();
  const run=(await db.query(`SELECT * FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
    [input.owner,input.projectId,input.runId])).rows[0];
  if(!run||run.state!=='paused')throw unavailable();
  const job=(await db.query(`SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.owner,input.runId])).rows[0];
  if(!job||job.state!=='paused'||!job.user_pause_requested||job.lease_token||job.lease_until
    ||!record(job.checkpoint)
    ||inputManifestHash(job.checkpoint)!==basis.checkpointHash||await providerCallNeedsReconciliation(db,job.id))throw unavailable();
  const source=await assertRunExecution(db,run,basis.sourceExecution);
  readExecutionStages(job.checkpoint,source);
  const receipt=(await db.query(`SELECT d.*,w.job_id,w.execution_version,w.input_revision,w.input_hash,
      w.source_checkpoint,w.checkpoint_hash FROM bb_run_supplement_drafts d
    JOIN bb_run_supplement_saved_work w ON w.owner_user_id=d.owner_user_id AND w.project_id=d.project_id
      AND w.run_id=d.run_id AND w.supplement_revision=d.revision
    WHERE d.owner_user_id=$1 AND d.project_id=$2 AND d.run_id=$3 AND d.revision=$4`,
    [input.owner,input.projectId,input.runId,input.revision])).rows[0];
  if(!receipt||receipt.job_id!==job.id||receipt.execution_version!==source.executionVersion
    ||receipt.input_revision!==source.inputRevision||receipt.input_hash.trim()!==source.inputHash
    ||receipt.request_id!==basis.requestId||receipt.request_hash.trim()!==basis.requestHash
    ||receipt.checkpoint_hash.trim()!==basis.checkpointHash||!same(receipt.source_checkpoint,job.checkpoint)
    ||receipt.base_input_revision!==source.inputRevision||receipt.base_input_hash.trim()!==source.inputHash)throw unavailable();
  const candidate=await readRunSupplementCandidate(db,input.owner,run,job,receipt);
  if(!candidate.base.supported||candidate.preview.status!=='prepared'||!candidate.candidate
    ||candidate.preview.candidate_input_hash!==basis.candidateInputHash
    ||!same(candidate.candidate.manifest,basis.manifest))throw unavailable();
  for(const material of basis.materials){
    const pin=material.pin,sourceProject='source_project_id' in pin?pin.source_project_id:input.projectId;
    const current=(await db.query(`SELECT m.* FROM bb_material_versions m JOIN bb_projects p
      ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id WHERE m.owner_user_id=$1 AND m.project_id=$2
      AND m.id=$3 AND m.version=$4 AND m.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [input.owner,sourceProject,pin.material_id,pin.material_version])).rows[0];
    if(!current||current.sha256.trim()!==pin.sha256||current.role!==pin.role||current.object_key!==material.objectKey
      ||current.filename!==material.filename||current.media_type!==material.mediaType)throw unavailable();
  }
  if(basis.priorWorkStatus==='no_prior_work'){
    const stages=readExecutionStages(job.checkpoint,source);
    if(basis.priorWork!==null||stages.model_generation!==undefined)throw unavailable();
    const prompt=stages[basis.kind==='authoring'?'file_authoring_v1_prompt':basis.kind==='review'?'review_file_v1_prompt':'m4_document_v1_prompt'];
    if(prompt!==undefined){
      const saved=(await db.query(`SELECT 1 FROM bb_snapshot_refs s WHERE s.id=$1 AND s.owner_user_id=$2
        AND s.project_id=$3 AND s.run_id=$4 AND s.snapshot_kind='model_request' AND s.input_revision=$5 AND s.input_hash=$6
        AND NOT EXISTS(SELECT 1 FROM bb_log_content_tombstones t WHERE t.content_kind='prompt_snapshot' AND t.content_id=s.id)`,
        [prompt.snapshot_id,input.owner,input.projectId,input.runId,source.inputRevision,source.inputHash])).rows[0];
      if(!saved)throw unavailable();
    }
    const work=(await db.query(`SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1
      UNION ALL SELECT 1 FROM bb_provider_result_refs WHERE job_id=$1
      UNION ALL SELECT 1 FROM bb_run_supplement_saved_results WHERE owner_user_id=$2 AND project_id=$3 AND run_id=$4 AND supplement_revision=$5
      UNION ALL SELECT 1 FROM bb_run_working_objects WHERE owner_user_id=$2 AND project_id=$3 AND run_id=$4 LIMIT 1`,
      [job.id,input.owner,input.projectId,input.runId,input.revision])).rows;
    if(work.length)throw unavailable();
  }else{
    if(!basis.priorWork)throw unavailable();
    const prior=basis.priorWork;
    const result=(await db.query(`SELECT p.* FROM bb_run_supplement_saved_results c
      JOIN bb_provider_result_refs p ON p.owner_user_id=c.owner_user_id AND p.project_id=c.project_id
        AND p.run_id=c.run_id AND p.id=c.result_id AND p.attempt_id=c.attempt_id
      JOIN bb_model_call_attempts a ON a.id=p.attempt_id AND a.job_id=p.job_id AND a.status='completed'
      WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.run_id=$3 AND c.supplement_revision=$4 AND c.result_id=$5
        AND p.job_id=$6 AND p.result_schema_version=$7 AND p.result_sha256=$8
        AND NOT EXISTS(SELECT 1 FROM bb_log_content_tombstones t WHERE
          (t.content_kind='provider_result' AND t.content_id=p.id) OR
          (t.content_kind='prompt_snapshot' AND t.content_id=p.prompt_snapshot_ref))`,
      [input.owner,input.projectId,input.runId,input.revision,prior.source.resultId,job.id,prior.source.resultSchemaVersion,prior.resultHash])).rows;
    if(result.length!==1)throw unavailable();
    for(const file of prior.files){
      const current=(await db.query(`SELECT o.*,s.stored_at,s.purge_started_at,s.purged_at
        FROM bb_run_working_objects o LEFT JOIN bb_run_working_object_state s ON s.object_key=o.object_key
        WHERE o.object_key=$1`,[file.key])).rows[0];
      // Pre-inventory legacy files remain eligible only through the existing
      // byte reader; registered files must retain their exact durable state.
      if(current&&(!current.stored_at||current.purge_started_at||current.purged_at
        ||current.owner_user_id!==input.owner||current.project_id!==input.projectId||current.run_id!==input.runId
        ||current.sha256.trim()!==file.sha256||Number(current.byte_size)!==file.byteSize
        ||current.media_type!==file.mediaType||current.filename!==file.name))throw unavailable();
    }
  }
  return job.id as string;
}

function result(row:any):RunSupplementProcessingPlan{
  if(!row||!record(row.body)||!hash(row.plan_hash?.trim())||!hash(row.basis_hash?.trim())
    ||inputManifestHash(row.body)!==row.plan_hash.trim()||row.body.basisHash!==row.basis_hash.trim())throw unavailable();
  return {id:row.id,planHash:row.plan_hash.trim(),basisHash:row.basis_hash.trim(),
    body:structuredClone(row.body),createdAt:date(row.created_at)};
}

/** Persist only a fixed conservative recipe and exact provenance, never content.
 * A plan is not an accepted input, a material retention pin or an execution grant. */
export async function createRunSupplementProcessingPlan(raw:CreateRunSupplementProcessingPlanInput):Promise<RunSupplementProcessingPlan>{
  const input={...raw};
  if(!key(input.requestId)||!hash(input.expectedBasisHash))throw unavailable();
  const basis=await loadRunSupplementProcessingBasis(input,input.kind);
  if(basis.basisHash!==input.expectedBasisHash)throw unavailable();
  const planned=body(basis,input.requestId),planHash=inputManifestHash(planned);
  return transaction(input.db,async db=>{
    const jobId=await recheck(db,input,basis);
    const existing=(await db.query(`SELECT * FROM bb_run_supplement_processing_plans
      WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`,[input.owner,input.runId,input.requestId])).rows[0];
    if(existing){
      const saved=result(existing);
      if(existing.project_id!==input.projectId||existing.kind!==input.kind||!same(saved.body,planned))throw unavailable();
      return saved;
    }
    const source=basis.sourceExecution;
    const row=(await db.query(`INSERT INTO bb_run_supplement_processing_plans
      (id,owner_user_id,project_id,run_id,supplement_revision,job_id,kind,request_id,receipt_request_id,receipt_request_hash,
       execution_version,input_revision,input_hash,checkpoint_hash,candidate_input_hash,basis_hash,plan_hash,body)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [uid(),input.owner,input.projectId,input.runId,input.revision,jobId,input.kind,input.requestId,basis.requestId,basis.requestHash,
        source.executionVersion,source.inputRevision,source.inputHash,basis.checkpointHash,basis.candidateInputHash,basis.basisHash,planHash,planned])).rows[0];
    return result(row);
  });
}

/** Internal consumption always reloads the byte-verified current basis and fixed
 * recipe. Persisted metadata cannot revive purged files or authorise execution. */
export async function readRunSupplementProcessingPlan(raw:ReadRunSupplementProcessingPlanInput):
  Promise<{plan:RunSupplementProcessingPlan;basis:RunSupplementProcessingBasis}>{
  const input={...raw};
  if(!key(input.planId))throw unavailable();
  const select=`SELECT * FROM bb_run_supplement_processing_plans WHERE owner_user_id=$1 AND project_id=$2
    AND run_id=$3 AND supplement_revision=$4 AND kind=$5 AND id=$6`;
  const args=[input.owner,input.projectId,input.runId,input.revision,input.kind,input.planId];
  const row=(await input.db.query(select,args)).rows[0],plan=result(row);
  const basis=await loadRunSupplementProcessingBasis(input,input.kind);
  if(plan.basisHash!==basis.basisHash||!same(plan.body,body(basis,row.request_id)))throw unavailable();
  return transaction(input.db,async db=>{
    await recheck(db,input,basis);
    const fresh=result((await db.query(select,args)).rows[0]);
    if(!same(fresh,plan))throw unavailable();
    return {plan:fresh,basis};
  });
}
