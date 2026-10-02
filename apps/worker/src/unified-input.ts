import { Value } from '@sinclair/typebox/value';
import { isUnifiedInput, isMarketOffering, UpdateDetailsSchema, type UnifiedAuthoringInput, type UpdateDetails, type Market, type Offering } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { ownerProjectMessageBody } from '@bondbuddy/api/log-ops';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { getParseSnapshot } from './parse-evidence-repository.js';
import type { DocumentParseRecord } from './document-parser.js';
import type { StageContext, StageOutcome, RunRow, InputRevisionRow } from './run-pipeline.js';
import type { Pool } from 'pg';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDocumentParser } from './document-parser.js';
import { processOcrV2 } from './ocr-v2.js';
import { readOcrV2Checkpoint } from '@bondbuddy/api/ocr-v2';

export type UnifiedManifest = Record<string, unknown> & { issuer_name: string; market: Market; offering: Offering;
  update_details: UpdateDetails; authoring: UnifiedAuthoringInput;
  materials: { material_id: string; material_version: number; role: string; sha256: string }[] };
export type UnifiedRecord = Omit<DocumentParseRecord, 'extraction_method'> & { extraction_method: 'native_text' | 'ocr' };
export type UnifiedMaterial = { pin: UnifiedManifest['materials'][number]; filename: string; mediaType: string; objectKey: string; records: UnifiedRecord[]; pending?: string[] };
export type UnifiedInput = { manifest: UnifiedManifest; materials: UnifiedMaterial[]; requirements: string[] };
export class UnifiedInputPending extends Error {}
export async function unifiedInputGate(pool: Pool, run: RunRow, input: InputRevisionRow): Promise<Extract<StageOutcome, { kind: 'pause' | 'fail' }> | null> {
  const fail = { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' } as const;
  if (!isUnifiedInput(input.manifest) || inputManifestHash(input.manifest) !== input.input_hash.trim() || input.input_hash.trim() !== run.input_hash.trim()) return fail;
  const m = input.manifest as UnifiedManifest;
  if (!Value.Check(UpdateDetailsSchema, m.update_details) || m.update_details.authoring_mode !== 'unified_v1' ||
      !Array.isArray(m.materials) || !Array.isArray(m.authoring.source_prospectuses) || !Array.isArray(m.authoring.knowledge) || !Array.isArray(m.authoring.requirements)) return fail;
  if (typeof m.issuer_name !== 'string' || !m.issuer_name.trim() || !isMarketOffering(m.market, m.offering) || !m.update_details.target_reporting_periods?.length)
    return { kind: 'pause', stage: 'awaiting_materials', reason: 'authoring_target_information_required' };
  if (!m.materials.length) return { kind: 'pause', stage: 'awaiting_materials', reason: 'authoring_issuer_materials_required' };
  for (const pin of m.materials) {
    const material = (await pool.query('SELECT role,sha256 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL', [run.owner_user_id, run.project_id, pin.material_id, pin.material_version])).rows[0];
    if (!material || material.role !== pin.role || String(material.sha256).trim() !== pin.sha256) return fail;
  }
  // Source metadata is optional context. The worker resolves gaps from the uploaded
  // material and labels uncertainty; an unfilled relationship is never a same-issuer assertion.
  if (!m.authoring.knowledge.length) return { kind: 'pause', stage: 'capability_not_ready', reason: 'authoring_knowledge_required' };
  if (m.authoring.knowledge.some(k => typeof k.markdown !== 'string' || digest(k.markdown) !== k.sha256)) return fail;
  if (m.authoring.previous_output && !await previousArtifact(pool, run, m.authoring.previous_output)) return fail;
  return null;
}

async function previousArtifact(pool: Pool, run: RunRow, pin: NonNullable<UnifiedAuthoringInput['previous_output']>) {
  const row = (await pool.query(`SELECT a.object_key,a.sha256 FROM bb_artifact_versions a JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id
    WHERE a.id=$1 AND a.version=$2 AND a.owner_user_id=$3 AND r.project_id=$4 AND r.id=$5 AND r.input_revision=$6
      AND r.state='succeeded' AND a.quality_status='passed' AND a.delivery_status='available'`,
  [pin.artifact_id,pin.version,run.owner_user_id,run.project_id,pin.run_id,pin.input_revision])).rows[0];
  return row && String(row.sha256).trim() === pin.sha256 ? row : null;
}

export async function loadUnifiedInput(ctx: StageContext, options: { originalFiles?: boolean } = {}): Promise<UnifiedInput> {
  const row = (await ctx.pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3', [ctx.run.owner_user_id, ctx.run.project_id, ctx.run.input_revision])).rows[0];
  if (!row || !isUnifiedInput(row.manifest) || inputManifestHash(row.manifest) !== ctx.run.input_hash.trim()) throw new Error('INPUT_REVISION_CONFLICT');
  const manifest = row.manifest as UnifiedManifest;
  const materials: UnifiedMaterial[] = [];
  for (const pin of manifest.materials) {
    const scope = { ownerUserId: ctx.run.owner_user_id, projectId: ctx.run.project_id, materialId: pin.material_id, materialVersion: pin.material_version };
    const result = (await ctx.pool.query(`SELECT m.filename,m.media_type,m.object_key,j.state,j.checkpoint,j.error_code
      FROM bb_material_versions m LEFT JOIN bb_jobs j ON j.owner_user_id=m.owner_user_id AND j.project_id=m.project_id
        AND j.material_id=m.id AND j.material_version=m.version AND j.subtype='material_parse' AND j.parser_version=$5
      WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4 AND m.deleted_at IS NULL`,
    [scope.ownerUserId, scope.projectId, scope.materialId, scope.materialVersion, documentParserVersion()])).rows[0];
    if (!result) throw new Error('INPUT_REVISION_CONFLICT');
    if (options.originalFiles) {
      materials.push({pin,filename:result.filename,mediaType:result.media_type,objectKey:result.object_key,records:[]});
      continue;
    }
    if (result.state !== 'succeeded') throw new UnifiedInputPending(result.state === 'failed' ? 'authoring_material_unreadable' : 'material_parse_pending');
    const snapshotId = result.checkpoint?.stages?.parse_evidence?.snapshot_id;
    const snapshot = snapshotId ? await getParseSnapshot({ pool: ctx.pool }, scope, snapshotId) : null;
    if (snapshot && snapshot.contentSha256 !== pin.sha256) throw new Error('INPUT_REVISION_CONFLICT');
    let records: UnifiedRecord[] = snapshot?.evidence ?? [];
    // Native parsers identify scanned/image pages. Preflight OCR covers only a few pages;
    // the leased authoring run consumes the existing complete, hash-checked page cache.
    if (result.checkpoint?.stages?.ocr_evidence || ['image/png','image/jpeg'].includes(result.media_type) ||
        snapshot?.response.warnings.some(w => ['PDF_PAGES_WITHOUT_TEXT','PDF_IMAGES_NOT_OCRD'].includes(w.code))) {
      const ocrScope = { owner: ctx.run.owner_user_id, projectId: ctx.run.project_id, materialId: pin.material_id,
        version: pin.material_version, purpose: 'full_ocr' as const, runId: ctx.run.id, leaseToken: ctx.lease.token };
      const { aggregate } = await processOcrV2(ctx.pool,ctx.blobs,ocrScope);
      if (aggregate.coverage !== 'complete') throw new UnifiedInputPending('authoring_ocr_incomplete');
      records = [];
      for (const ref of aggregate.successful_pages) {
        const { checkpoint } = await readOcrV2Checkpoint(ctx.pool,ctx.blobs,ocrScope,aggregate.document,ref);
        for (const record of checkpoint.result.records) records.push({ record_id:`ocr-${ref.page}-${record.record_id}`,
          material_id:pin.material_id,material_version:pin.material_version,content_hash:pin.sha256,
          locator_type:'pdf_bbox',locator:{page:ref.page,bbox:record.bbox},literal_quote:record.text,context:'',
          extraction_method:'ocr',extractor_version:'ocr-v2',confidence:record.confidence,uncertainty:[...record.uncertainty,'OCR_UNCONFIRMED'],formatting:{} });
      }
    }
    if (!records.length) throw new UnifiedInputPending('authoring_material_unreadable');
    const auxiliary = snapshot?.response.document.auxiliary_targets?.filter(t => t.text_summary?.has_text || !['empty','parsed'].includes(t.parse_status)) ?? [];
    materials.push({ pin, filename: result.filename, mediaType: result.media_type, objectKey: result.object_key, records,
      pending: auxiliary.length ? ['原稿页眉、页脚、脚注或图形等附属内容保留原样，未自动更新，请核对其中的企业名称、期间和数值。'] : [] });
  }
  const prior = manifest.authoring.previous_output;
  if (prior) {
    const stored = await previousArtifact(ctx.pool,ctx.run,prior);
    if (!stored) throw new Error('INPUT_REVISION_CONFLICT');
    const bytes = await ctx.blobs.getIfExistsBounded(stored.object_key,100 * 1024 * 1024);
    if (!bytes || digest(bytes) !== prior.sha256) throw new Error('INPUT_REVISION_CONFLICT');
    if (options.originalFiles) {
      materials.push({pin:{material_id:prior.artifact_id,material_version:prior.version,sha256:prior.sha256,role:'project_output'},filename:'本项目上一版清洁稿.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:stored.object_key,records:[]});
    } else {
    const directory = await mkdtemp(resolve(tmpdir(),'bb-prior-output-'));
    try {
      const path = resolve(directory,'baseline.docx');
      await writeFile(path,bytes,{mode:0o600});
      const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const parsed = await runDocumentParser({schema_version:'document-parse-request-v1',request_id:ctx.run.id,
        material:{material_id:prior.artifact_id,material_version:prior.version,media_type:mediaType,sha256:prior.sha256,authorized_local_path:path},options:{}},
      {pythonExecutable:process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',repoRoot:resolve(fileURLToPath(import.meta.url),'../../../..')});
      if (parsed.status === 'failed' || !parsed.records.length) throw new UnifiedInputPending('authoring_previous_output_unreadable');
      materials.push({pin:{material_id:prior.artifact_id,material_version:prior.version,sha256:prior.sha256,role:'project_output'},filename:'本项目上一版清洁稿',mediaType,objectKey:stored.object_key,records:parsed.records});
    } finally { await rm(directory,{recursive:true,force:true}); }
    }
  }
  const requirements: string[] = [];
  for (const pin of manifest.authoring.requirements) {
    const row = (await ctx.pool.query(`SELECT snapshot_id,content_sha256 FROM bb_user_submission_versions
      WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND message_id=$4 AND message_version=$5 AND submission_kind='project_message'`,
    [pin.submission_id, ctx.run.owner_user_id, ctx.run.project_id, pin.message_id, pin.message_version])).rows[0];
    if (!row || String(row.content_sha256).trim() !== pin.content_sha256) throw new Error('INPUT_REVISION_CONFLICT');
    requirements.push(await ownerProjectMessageBody(ctx.pool, ctx.blobs, ctx.run.owner_user_id, ctx.run.project_id, row.snapshot_id, pin.content_sha256, ctx.signal));
  }
  return { manifest, materials, requirements };
}
