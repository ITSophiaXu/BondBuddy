import type { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { RunSupplementChangeSchema, type RunSupplementChange } from '@bondbuddy/contracts';
import { Problem, digest, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { assertRunExecution, readExecutionStages, type RunExecutionIdentity } from './run-execution.js';
import { providerCallNeedsReconciliation } from './queue.js';
import { readRunSupplementCandidate } from './run-supplement-draft.js';
import { readCapturedSupplementResult } from './run-supplement-work.js';
import { extractRunFileReferences } from './run-file-reference.js';
import { listCapturedSupplementFiles, readCapturedSupplementFile, type CapturedSupplementFilePin } from './run-supplement-files.js';

type MaterialPin={material_id:string;material_version:number;role:string;sha256:string};
export type RunSupplementScopedMaterialPin=MaterialPin & {source_project_id:string};
export type RunSupplementAuthoringPreparation={
  version:'run-supplement-authoring-preparation-v1';owner:string;projectId:string;runId:string;revision:number;
  requestId:string;requestHash:string;sourceExecution:RunExecutionIdentity;checkpointHash:string;candidateInputHash:string;
  manifest:Record<string,any>;
  materials:Array<{pin:MaterialPin;filename:string;mediaType:string;objectKey:string}>;
  delta:{additions:RunSupplementScopedMaterialPin[];
    replacements:Array<{previous:RunSupplementScopedMaterialPin;current:RunSupplementScopedMaterialPin}>;
    unchanged:RunSupplementScopedMaterialPin[];sourceProspectuses:{previous:unknown[];current:unknown[]};discardPreviousOutput:boolean};
  priorWork:{source:{kind:'provider_result';resultId:string;resultSchemaVersion:'codex-file-word-v1'};
    resultHash:string;files:CapturedSupplementFilePin[]};
  planHash:string;
};
export type RunSupplementAuthoringPreparationInput={db:Pool;blobs:PrivateBlobs;owner:string;projectId:string;runId:string;
  revision:number;expectedCheckpointHash:string;expectedCandidateInputHash:string};
export type RunSupplementFilePreparation=Omit<RunSupplementAuthoringPreparation,'version'|'materials'|'priorWork'> & {
  version:'run-supplement-file-preparation-v1';kind:'review'|'m4';reviewSnapshot:unknown|null;
  materials:Array<{pin:RunSupplementScopedMaterialPin;filename:string;mediaType:string;objectKey:string}>;
  priorWork:{source:{kind:'provider_result';resultId:string;resultSchemaVersion:'codex-review-file-v1'|'codex-m4-document-v1'};
    resultHash:string;files:CapturedSupplementFilePin[];metadata:Record<string,unknown>};
};
type PreparationKind='authoring'|'review'|'m4';
const kinds={
  authoring:{schema:'codex-file-word-v1',logical:'file-authoring-v1',prompt:'file_authoring_v1_prompt',tasks:['update','generation'],required:['tracked.docx','clean.docx']},
  review:{schema:'codex-review-file-v1',logical:'review-file-v1',prompt:'review_file_v1_prompt',tasks:['review'],required:['report.docx']},
  m4:{schema:'codex-m4-document-v1',logical:'m4-document-v1',prompt:'m4_document_v1_prompt',tasks:['generation'],required:['document.docx','preparation-note.docx']},
} as const;
const MAX=100*1024*1024;
const record=(value:unknown):value is Record<string,any>=>!!value && typeof value==='object' && !Array.isArray(value);
const unavailable=()=>new Problem(409,'INPUT_REVISION_CONFLICT','已保存工作或补料准备已变化，请保留补料并核对原任务。');
const pinKey=(pin:{material_id:string;material_version:number;sha256:string})=>`${pin.material_id}\0${pin.material_version}\0${pin.sha256}`;
const scoped=(pin:RunSupplementScopedMaterialPin):RunSupplementScopedMaterialPin=>({material_id:pin.material_id,
  material_version:pin.material_version,role:pin.role,sha256:pin.sha256,source_project_id:pin.source_project_id});

async function boundary(input:RunSupplementAuthoringPreparationInput,kind:PreparationKind){
  const row=(await input.db.query(`SELECT r.*,j.id AS job_id,j.state AS job_state,j.subtype AS job_subtype,
      j.checkpoint AS job_checkpoint,j.user_pause_requested,j.lease_token,j.lease_until
    FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    JOIN bb_users u ON u.id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND p.deleted_at IS NULL AND p.archived_at IS NULL
      AND u.closed_at IS NULL AND u.status<>'closed'`,[input.owner,input.projectId,input.runId])).rows[0];
  if(!row || row.state!=='paused' || row.job_state!=='paused' || !row.user_pause_requested || row.lease_token || row.lease_until
    || !(kinds[kind].tasks as readonly string[]).includes(row.task_kind) || !record(row.job_checkpoint)
    || inputManifestHash(row.job_checkpoint)!==input.expectedCheckpointHash
    || await providerCallNeedsReconciliation(input.db,row.job_id))throw unavailable();
  const sourceExecution=await assertRunExecution(input.db,row);
  readExecutionStages(row.job_checkpoint,sourceExecution);
  return {run:row,job:{id:row.job_id,subtype:row.job_subtype,checkpoint:row.job_checkpoint},sourceExecution};
}

/** Service-internal request preparation only. It neither adopts the candidate,
 * allocates an execution/input revision, schedules a call nor changes billing.
 * Content reads keep their existing purge locks; live boundary checks before and
 * after I/O avoid holding run/job locks across those independent transactions. */
export function loadRunSupplementAuthoringPreparation(input:RunSupplementAuthoringPreparationInput):Promise<RunSupplementAuthoringPreparation>{
  return loadPreparation(input,'authoring') as Promise<RunSupplementAuthoringPreparation>;
}

export function loadRunSupplementFilePreparation(input:RunSupplementAuthoringPreparationInput,kind:'review'|'m4'):Promise<RunSupplementFilePreparation>{
  if(kind!=='review'&&kind!=='m4')return Promise.reject(unavailable());
  return loadPreparation(input,kind) as Promise<RunSupplementFilePreparation>;
}

async function loadPreparation(input:RunSupplementAuthoringPreparationInput,kind:PreparationKind):Promise<RunSupplementAuthoringPreparation|RunSupplementFilePreparation>{
  const config=kinds[kind];
  if(![input.owner,input.projectId,input.runId].every(value=>typeof value==='string' && value.length>0)
    || !Number.isSafeInteger(input.revision) || input.revision<1
    || !/^[a-f0-9]{64}$/.test(input.expectedCheckpointHash) || !/^[a-f0-9]{64}$/.test(input.expectedCandidateInputHash))throw unavailable();
  const live=await boundary(input,kind),{run,job,sourceExecution}=live;
  const receipt=(await input.db.query(`SELECT d.*,w.job_id,w.execution_version,w.input_revision,w.input_hash,
      w.source_checkpoint,w.checkpoint_hash
    FROM bb_run_supplement_drafts d JOIN bb_run_supplement_saved_work w ON w.owner_user_id=d.owner_user_id
      AND w.project_id=d.project_id AND w.run_id=d.run_id AND w.supplement_revision=d.revision
    WHERE d.owner_user_id=$1 AND d.project_id=$2 AND d.run_id=$3 AND d.revision=$4`,
  [input.owner,input.projectId,input.runId,input.revision])).rows[0];
  if(!receipt || receipt.job_id!==job.id || receipt.execution_version!==sourceExecution.executionVersion
    || receipt.input_revision!==sourceExecution.inputRevision || receipt.input_hash.trim()!==sourceExecution.inputHash
    || receipt.base_input_revision!==sourceExecution.inputRevision || receipt.base_input_hash.trim()!==sourceExecution.inputHash
    || receipt.checkpoint_hash.trim()!==input.expectedCheckpointHash || !record(receipt.source_checkpoint)
    || inputManifestHash(receipt.source_checkpoint)!==input.expectedCheckpointHash
    || !Array.isArray(receipt.changes) || !receipt.changes.every((change:unknown)=>Value.Check(RunSupplementChangeSchema,change))
    || inputManifestHash({request_id:receipt.request_id,expected_revision:receipt.revision-1,
      base_input_revision:receipt.base_input_revision,base_input_hash:receipt.base_input_hash.trim(),changes:receipt.changes})!==receipt.request_hash.trim())throw unavailable();
  const stages=readExecutionStages(receipt.source_checkpoint,sourceExecution);
  const model=stages.model_generation;
  if(!record(model) || model.logical_call_id!==config.logical || typeof model.prompt_snapshot_ref!=='string'
    || !model.prompt_snapshot_ref || stages[config.prompt]?.snapshot_id!==model.prompt_snapshot_ref)throw unavailable();
  const candidate=await readRunSupplementCandidate(input.db,input.owner,run,job,receipt);
  const sourceManifest=candidate.base.manifest,manifest=candidate.candidate?.manifest as Record<string,any>|undefined;
  if(!candidate.base.supported || candidate.preview.status!=='prepared' || !manifest
    || candidate.preview.candidate_input_hash!==input.expectedCandidateInputHash
    || inputManifestHash(manifest)!==input.expectedCandidateInputHash)throw unavailable();
  if(kind==='authoring'&&(sourceManifest.review || !record(sourceManifest.authoring)
    || sourceManifest.authoring.version!=='unified_v1' || Object.hasOwn(sourceManifest.authoring,'review_result')
    || Object.hasOwn(sourceManifest.authoring,'review_revision')))throw unavailable();
  if(kind==='review'&&(!record(sourceManifest.review)||!['full_review','differential_review'].includes(sourceManifest.review.operation)
    || !['review-file-v1','review-correction-v2'].includes(sourceManifest.review.file_delivery?.version)))throw unavailable();
  if(kind==='m4'&&(job.subtype!=='m4_document_v1'||sourceManifest.version!=='m4-document-input-v1'||sourceManifest.kind!=='document'))throw unavailable();
  if(kind!=='m4'&&(!Array.isArray(manifest.materials)||manifest.materials.length!==candidate.resultMaterials.length
    || manifest.materials.some((pin:any,index:number)=>pinKey(pin)!==pinKey(candidate.resultMaterials[index])
      || pin.role!==candidate.resultMaterials[index].role || candidate.resultMaterials[index].source_project_id!==input.projectId)))throw unavailable();
  if(kind==='m4'){
    const pins=[...manifest.input.materials,...(manifest.input.source_material?[manifest.input.source_material]:[]),...(manifest.template_material?[manifest.template_material]:[])];
    const exact=(pin:any)=>`${pin.source_project_id}\0${pinKey(pin)}`;
    const unique=new Set(pins.map(exact));
    if(unique.size!==candidate.resultMaterials.length||candidate.resultMaterials.some(pin=>!unique.has(exact(pin))))throw unavailable();
  }
  const selected=(await input.db.query(`SELECT p.id,p.attempt_id,p.result_sha256 FROM bb_run_supplement_saved_results c
    JOIN bb_provider_result_refs p ON p.id=c.result_id AND p.attempt_id=c.attempt_id AND p.owner_user_id=c.owner_user_id
      AND p.project_id=c.project_id AND p.run_id=c.run_id
    WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.run_id=$3 AND c.supplement_revision=$4
      AND p.job_id=$5 AND p.logical_call_id=$6 AND p.prompt_snapshot_ref=$7 AND p.result_schema_version=$8`,
  [input.owner,input.projectId,input.runId,input.revision,job.id,model.logical_call_id,model.prompt_snapshot_ref,config.schema])).rows;
  if(selected.length!==1)throw unavailable();
  const source={kind:'provider_result' as const,resultId:selected[0].id as string,resultSchemaVersion:config.schema};
  let metadata:Record<string,unknown>={};
  await readCapturedSupplementResult({...input,resultId:source.resultId,resultSchemaVersion:source.resultSchemaVersion,validate:value=>{
    if(!record(value) || Object.hasOwn(value,'error'))return false;
    try {
      const refs=extractRunFileReferences({scope:{owner:input.owner,projectId:input.projectId,runId:input.runId,
        inputHash:sourceExecution.inputHash,source:'provider',attemptId:selected[0].attempt_id,
        ...(kind==='review'?{reviewCorrection:sourceManifest.review.file_delivery.version==='review-correction-v2'}:{})},resultSchemaVersion:source.resultSchemaVersion,value});
      if(kind==='m4'){
        const method=stages.m4_document_method;
        if(!record(method)||method.version!=='m4-document-method-v1'||inputManifestHash(method)!==value.method_hash
          ||method.skill_sha256!==value.skill_sha256)return false;
        metadata={method_hash:value.method_hash,skill_sha256:value.skill_sha256};
      }
      return config.required.every(name=>refs.some(ref=>ref.name===name));
    }catch{throw unavailable();}
  }});
  const files=await listCapturedSupplementFiles({...input,source});
  if(!config.required.every(name=>files.some(pin=>pin.name===name)))throw unavailable();
  for(const pin of files)await readCapturedSupplementFile({...input,source,pin});
  const materials:Array<{pin:MaterialPin&{source_project_id?:string};filename:string;mediaType:string;objectKey:string}>=[];
  for(const expected of candidate.resultMaterials){
    const pin=expected;
    if(!expected.available || kind!=='m4'&&expected.source_project_id!==input.projectId)throw unavailable();
    const stored=(await input.db.query(`SELECT m.* FROM bb_material_versions m JOIN bb_projects p
      ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id
      WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4 AND m.deleted_at IS NULL
        AND p.deleted_at IS NULL`,[input.owner,expected.source_project_id,pin.material_id,pin.material_version])).rows[0];
    if(!stored || stored.role!==pin.role || stored.sha256.trim()!==pin.sha256 || typeof stored.object_key!=='string'
      || !stored.object_key || !Number.isSafeInteger(Number(stored.byte_size)) || Number(stored.byte_size)<1 || Number(stored.byte_size)>MAX)throw unavailable();
    let bytes:Buffer|null;
    try{bytes=await input.blobs.getIfExistsBounded(stored.object_key,MAX);}catch{throw unavailable();}
    if(!bytes || bytes.length!==Number(stored.byte_size) || digest(bytes)!==pin.sha256)throw unavailable();
    materials.push({pin:{material_id:pin.material_id,material_version:pin.material_version,role:pin.role,sha256:pin.sha256,
      ...(kind!=='authoring'?{source_project_id:expected.source_project_id}:{})},
      filename:stored.filename,mediaType:stored.media_type,objectKey:stored.object_key});
  }
  const changes=candidate.changes as RunSupplementChange[];
  const complete=(pin:{material_id:string;material_version:number;sha256:string},values:typeof candidate.baseMaterials)=>{
    const value=values.find(material=>pinKey(material)===pinKey(pin));if(!value)throw unavailable();return scoped(value);
  };
  const additions=changes.filter(change=>!change.replaces).map(change=>complete(change.material,candidate.resultMaterials));
  const replacements=changes.filter(change=>!!change.replaces).map(change=>({previous:complete(change.replaces!,candidate.baseMaterials),
    current:complete(change.material,candidate.resultMaterials)}));
  const replaced=new Set(changes.flatMap(change=>change.replaces?[pinKey(change.replaces)]:[]));
  const unchanged=candidate.baseMaterials.filter(pin=>!replaced.has(pinKey(pin))).map(scoped);
  const final=await boundary(input,kind);
  if(final.job.id!==job.id || inputManifestHash(final.sourceExecution)!==inputManifestHash(sourceExecution))throw unavailable();
  const plan={version:kind==='authoring'?'run-supplement-authoring-preparation-v1':'run-supplement-file-preparation-v1',
    ...(kind!=='authoring'?{kind,reviewSnapshot:candidate.candidate!.reviewSnapshot}:{}),
    owner:input.owner,projectId:input.projectId,runId:input.runId,revision:input.revision,requestId:receipt.request_id,
    requestHash:receipt.request_hash.trim(),sourceExecution,checkpointHash:input.expectedCheckpointHash,
    candidateInputHash:input.expectedCandidateInputHash,manifest,materials,
    delta:{additions,replacements,unchanged,sourceProspectuses:{previous:structuredClone(sourceManifest.authoring?.source_prospectuses??[]),
      current:structuredClone(manifest.authoring?.source_prospectuses??[])},discardPreviousOutput:changes.some(change=>change.discard_previous_output===true)},
    priorWork:{source,resultHash:selected[0].result_sha256.trim(),files,...(kind!=='authoring'?{metadata}:{})}};
  return {...plan,planHash:inputManifestHash(plan)} as RunSupplementAuthoringPreparation|RunSupplementFilePreparation;
}
