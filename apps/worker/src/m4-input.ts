import type { Pool } from 'pg';
import { isM4Manifest, m4DocumentScopeSupported, M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_SUBTYPE, M4_QA_SUBTYPE, type M4Manifest, type M4MaterialPin, type M4ArtifactPin } from '@bondbuddy/contracts';
import {validM4Knowledge} from '@bondbuddy/api/m4-knowledge';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { StageContext, RunRow, InputRevisionRow, StageOutcome } from './run-pipeline.js';
import { readRunExecutionInput, type M4ExecutionInputSnapshot } from '@bondbuddy/api/run-execution-input';

export type M4WorkerMaterial = {pin: M4MaterialPin; filename: string; mediaType: string; objectKey: string};
export type M4WorkerArtifact = {pin: M4ArtifactPin; filename: string; mediaType: string; objectKey: string; bodyContent?: string};
export type M4WorkerInput = {manifest: M4Manifest; materials: M4WorkerMaterial[]; artifacts: M4WorkerArtifact[]};
const same = (a: unknown, b: unknown) => inputManifestHash(a) === inputManifestHash(b);
export const hasM4Manifest = (value: unknown) => !!value && typeof value === 'object'
  && typeof (value as {version?:unknown}).version === 'string' && String((value as {version:string}).version).startsWith('m4-');

function materialPins(manifest: M4Manifest): M4MaterialPin[] {
  const pins = manifest.kind === 'document'
    ? [...manifest.input.materials, ...(manifest.input.source_material ? [manifest.input.source_material] : []), ...(manifest.template_material ? [manifest.template_material] : [])]
    : [...manifest.materials, ...(manifest.context.source_material ? [manifest.context.source_material] : []),
      ...manifest.context.citations.filter(c => c.kind === 'material').map(c => c.ref as M4MaterialPin)];
  return [...new Map(pins.map(pin => [inputManifestHash(pin), pin])).values()];
}
function artifactPins(manifest: M4Manifest): M4ArtifactPin[] {
  const pins = manifest.kind === 'document' ? (manifest.input.edit_base ? [manifest.input.edit_base] : [])
    : [...(manifest.context.reading_artifact ? [manifest.context.reading_artifact] : []),
      ...manifest.context.citations.filter(c => c.kind === 'artifact').map(c => c.ref as M4ArtifactPin)];
  return [...new Map(pins.map(pin => [inputManifestHash(pin), pin])).values()];
}

async function authorizedMaterial(pool: Pool, owner: string, pin: M4MaterialPin): Promise<M4WorkerMaterial | null> {
  const row = (await pool.query(`SELECT m.filename,m.media_type,m.object_key,m.sha256 FROM bb_material_versions m
    JOIN bb_projects p ON p.id=m.project_id AND p.owner_user_id=m.owner_user_id AND p.deleted_at IS NULL
    WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4 AND m.deleted_at IS NULL`,
  [owner, pin.source_project_id, pin.material_id, pin.material_version])).rows[0];
  return row && String(row.sha256).trim() === pin.sha256
    ? {pin, filename: row.filename, mediaType: row.media_type, objectKey: row.object_key} : null;
}
async function authorizedArtifact(pool: Pool, owner: string, pin: M4ArtifactPin): Promise<M4WorkerArtifact | null> {
  const row = (await pool.query(`SELECT a.object_key,a.media_type,a.sha256,m.body_content FROM bb_artifact_versions a
    JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id
    JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id AND p.deleted_at IS NULL
    LEFT JOIN bb_m4_artifacts m ON m.owner_user_id=a.owner_user_id AND m.artifact_id=a.id AND m.artifact_version=a.version
    WHERE a.owner_user_id=$1 AND r.project_id=$2 AND a.id=$3 AND a.version=$4
      AND a.quality_status='passed' AND a.delivery_status='available'`,
  [owner, pin.source_project_id, pin.artifact_id, pin.artifact_version])).rows[0];
  return row && String(row.sha256).trim() === pin.sha256
    ? {pin, filename: `artifact-${pin.artifact_version}.${row.media_type === 'text/plain' ? 'txt' : 'docx'}`, mediaType: row.media_type, objectKey: row.object_key,
      ...(typeof row.body_content === 'string' ? {bodyContent:row.body_content} : {})} : null;
}

export async function m4InputGate(pool: Pool, run: RunRow, input: InputRevisionRow,
  execution?: M4ExecutionInputSnapshot | null): Promise<Extract<StageOutcome, {kind: 'fail' | 'pause'}> | null> {
  const fail = {kind: 'fail', code: 'INPUT_REVISION_CONFLICT'} as const;
  const manifest = input.manifest;
  if (!isM4Manifest(manifest) || inputManifestHash(manifest) !== run.input_hash.trim() || input.input_hash.trim() !== run.input_hash.trim()
    || run.task_kind !== (manifest.kind === 'document' ? 'generation' : 'qa')) return fail;
  // A supplied snapshot came from the exact execution reader. Absence must not
  // fall back to another business snapshot; standalone gates still load theirs.
  if (execution !== undefined && (!execution || execution.owner_user_id !== run.owner_user_id
    || execution.run_id !== run.id || execution.topic_id !== manifest.topic_id
    || typeof execution.input_hash !== 'string' || execution.input_hash.trim() !== run.input_hash.trim()
    || !same(execution.manifest, manifest))) return fail;
  const scope = (await pool.query(execution === undefined ? `SELECT t.source_project_id,COALESCE(p.execution_scope_project_id,p.id) AS scope_id,
    e.input_hash,e.manifest,j.subtype FROM bb_m4_topics t
    JOIN bb_projects p ON p.id=t.project_id AND p.owner_user_id=t.owner_user_id AND p.deleted_at IS NULL
    LEFT JOIN bb_projects s ON s.id=t.source_project_id AND s.owner_user_id=t.owner_user_id
    JOIN bb_m4_executions e ON e.topic_id=t.id AND e.owner_user_id=t.owner_user_id AND e.run_id=$3
    JOIN bb_jobs j ON j.run_id=e.run_id AND j.owner_user_id=e.owner_user_id
    WHERE t.owner_user_id=$1 AND t.id=$2 AND t.project_id=$4 AND (t.source_project_id IS NULL OR s.deleted_at IS NULL)`
    : `SELECT t.source_project_id,COALESCE(p.execution_scope_project_id,p.id) AS scope_id,j.subtype FROM bb_m4_topics t
    JOIN bb_projects p ON p.id=t.project_id AND p.owner_user_id=t.owner_user_id AND p.deleted_at IS NULL
    LEFT JOIN bb_projects s ON s.id=t.source_project_id AND s.owner_user_id=t.owner_user_id
    JOIN bb_jobs j ON j.run_id=$3 AND j.owner_user_id=t.owner_user_id
    WHERE t.owner_user_id=$1 AND t.id=$2 AND t.project_id=$4 AND (t.source_project_id IS NULL OR s.deleted_at IS NULL)`,
    [run.owner_user_id,manifest.topic_id,run.id,run.project_id])).rows[0];
  if (!scope || execution === undefined && (String(scope.input_hash).trim() !== run.input_hash.trim() || !same(scope.manifest,manifest))
    || scope.subtype !== (manifest.kind === 'document' ? M4_DOCUMENT_SUBTYPE : M4_QA_SUBTYPE)) return fail;
  if (manifest.kind === 'document') {
    if(!m4DocumentScopeSupported(manifest.input.document_type,manifest.market,manifest.offering,!!manifest.input.project_file))return fail;
    if(manifest.billing_task!==M4_DOCUMENT_BILLING_TASKS[manifest.input.document_type])return fail;
    if(manifest.knowledge && !validM4Knowledge(manifest.knowledge,manifest.market,manifest.input.document_type,manifest.offering))return fail;
    if(['underwriter','legal','application','recommendation'].includes(manifest.input.document_type)&&!manifest.knowledge)return fail;
    if(!manifest.input.project_file&&['application','recommendation'].includes(manifest.input.document_type)&&!manifest.knowledge?.template)return fail;
    if(manifest.input.project_file){
      const link=manifest.input.project_file,source=manifest.input.source_material;
      if(!manifest.input.template||!manifest.template_material||!source)return fail;
      const binding=(await pool.query(`SELECT 1 FROM bb_project_file_workspaces w JOIN bb_prospectus_versions v ON v.owner_user_id=w.owner_user_id
        WHERE w.owner_user_id=$1 AND w.project_id=$2 AND w.topic_id=$3 AND v.id=$4 AND v.sha256=$5 AND v.project_id=$6
        AND (v.project_id=w.project_id OR v.project_id IN(SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=w.project_id))`,
        [run.owner_user_id,link.project_id,manifest.topic_id,link.source_version_id,source.sha256,source.source_project_id])).rowCount;
      if(!binding)return fail;
    }
    if (scope.scope_id !== manifest.execution_scope_project_id
      || manifest.input.scope !== 'whole') return fail;
    if (manifest.input.document_type === 'init' && (!manifest.input.template || !manifest.template_material))
      return {kind: 'pause', stage: 'awaiting_materials', reason: 'm4_broker_template_required'};
    if (manifest.input.document_type === 'private_summary' && !manifest.input.source_material && !manifest.input.edit_base) return fail;
    if (!manifest.input.materials.length && !manifest.input.source_material && !manifest.input.edit_base) return fail;
    if (manifest.input.template) {
      const ref=manifest.input.template;
      const template=(await pool.query(`SELECT broker,document_type,market,offering,sha256,material,retired_at FROM bb_m4_templates
        WHERE owner_user_id=$1 AND id=$2 AND version=$3`,[run.owner_user_id,ref.template_id,ref.template_version])).rows[0];
      if (!template || manifest.input.document_type==='init' && !template.broker?.trim() || template.document_type!==manifest.input.document_type
        || template.market!==manifest.market || (manifest.input.project_file&&template.offering!==manifest.offering) || String(template.sha256).trim()!==ref.sha256
        || !same(template.material,manifest.template_material)
        || manifest.input.fields.broker && manifest.input.fields.broker.trim()!==String(template.broker??'').trim()) return fail;
    } else if (manifest.template_material) return fail;
    if (manifest.template_material && manifest.input.template?.sha256 !== manifest.template_material.sha256) return fail;
    if(manifest.input.edit_base){const pin=manifest.input.edit_base;
      const base=(await pool.query(`SELECT kind,document_type FROM bb_m4_artifacts WHERE owner_user_id=$1 AND artifact_id=$2 AND artifact_version=$3`,
        [run.owner_user_id,pin.artifact_id,pin.artifact_version])).rows[0];
      if(!base || base.kind!=='document' || base.document_type!==manifest.input.document_type)return fail;
    }
  }
  for (const pin of materialPins(manifest)) if (!await authorizedMaterial(pool, run.owner_user_id, pin)) return fail;
  for (const pin of artifactPins(manifest)) if (!await authorizedArtifact(pool, run.owner_user_id, pin)) return fail;
  return null;
}

/** Always reload exact persisted inputs; an open tab or latest draft never chooses the run's source. */
export async function loadM4WorkerInput(ctx: StageContext): Promise<M4WorkerInput> {
  if (!ctx.lease || ctx.run.id !== ctx.lease.runId || ctx.run.owner_user_id !== ctx.lease.owner
    || ctx.run.input_revision !== ctx.lease.inputRevision || ctx.run.input_hash.trim() !== ctx.lease.inputHash)
    throw Error('INPUT_REVISION_CONFLICT');
  const resolved = await readRunExecutionInput(ctx.pool, ctx.lease.owner, ctx.lease.runId, ctx.lease);
  if (resolved.run.project_id !== ctx.run.project_id || resolved.run.task_kind !== ctx.run.task_kind
    || resolved.run.input_revision !== ctx.run.input_revision || resolved.run.input_hash.trim() !== ctx.run.input_hash.trim())
    throw Error('INPUT_REVISION_CONFLICT');
  const row = resolved.input;
  if (!row || !isM4Manifest(row.manifest) || await m4InputGate(ctx.pool, ctx.run, row, resolved.m4Execution)) throw Error('INPUT_REVISION_CONFLICT');
  const manifest = row.manifest;
  const materials: M4WorkerMaterial[] = [], artifacts: M4WorkerArtifact[] = [];
  for (const pin of materialPins(manifest)) {
    const file = await authorizedMaterial(ctx.pool, ctx.run.owner_user_id, pin);
    if (!file) throw Error('INPUT_REVISION_CONFLICT');
    materials.push(file);
  }
  for (const pin of artifactPins(manifest)) {
    const file = await authorizedArtifact(ctx.pool, ctx.run.owner_user_id, pin);
    if (!file) throw Error('INPUT_REVISION_CONFLICT');
    artifacts.push(file);
  }
  if (manifest.kind === 'document' && manifest.input.source_material && !materials.some(m => same(m.pin, manifest.input.source_material))) throw Error('INPUT_REVISION_CONFLICT');
  return {manifest, materials, artifacts};
}
