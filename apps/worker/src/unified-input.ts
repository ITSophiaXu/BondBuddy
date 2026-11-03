import { ReviewResultPinSchema, SourceFormatPolicySchema, sameFormatTemplate, type ReviewResultPin } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { isUnifiedInput, isMarketOffering, UpdateDetailsSchema, isReviewReport, isReviewRevisionPin, executableRevisionFinding,
  type ReviewRevisionPin, type ReviewEvidenceRef, type UnifiedAuthoringInput, type UpdateDetails, type Market, type Offering } from '@bondbuddy/contracts';
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

/** Preserve the pre-format-policy source order for both authoring and its gate. */
export function selectLegacySourcePin<T extends UnifiedManifest['materials'][number]>(materials:readonly T[],
  authoring:Pick<UnifiedAuthoringInput,'source_prospectuses'|'review_result'>):T|null {
  return [...materials].filter(material=>['project_output','historical','reference'].includes(material.role)).sort((a,b)=>{
    const rank=(material:typeof a)=>material.material_id===authoring.review_result?.source_material.material_id?-2:
      material.role==='project_output'?-1:authoring.source_prospectuses.find(source=>source.material_id===material.material_id)?.relation==='same_issuer'?0:1;
    return rank(a)-rank(b)||a.material_id.localeCompare(b.material_id);
  })[0]??null;
}

export function revisionEvidenceRefs(pin: ReviewRevisionPin): ReviewEvidenceRef[] {
  return pin.selected_findings.filter(executableRevisionFinding).flatMap(finding => [...finding.target_refs, ...finding.evidence_refs]);
}

/** A revision can only consume the immutable report and explicitly accepted plan from its owner/project. */
export async function reviewRevisionInputGate(pool: Pool, run: RunRow, pin: ReviewRevisionPin): Promise<boolean> {
  if (!isReviewRevisionPin(pin) || pin.owner_user_id !== run.owner_user_id || pin.project_id !== run.project_id) return false;
  const reportRow = (await pool.query(`SELECT run_id,version,content_sha256,report FROM bb_review_reports
    WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND version=$4`,
  [pin.source_report.report_id, run.owner_user_id, run.project_id, pin.source_report.version])).rows[0];
  const report = reportRow?.report;
  if (!reportRow || !isReviewReport(report) || String(reportRow.content_sha256).trim() !== pin.source_report.sha256
      || inputManifestHash(report) !== pin.source_report.sha256 || reportRow.run_id !== pin.source_report.run_id
      || report.run_id !== pin.source_report.run_id || report.report_id !== pin.source_report.report_id
      || report.version !== pin.source_report.version || report.input_revision !== pin.source_report.input_revision
      || report.project_id !== run.project_id || inputManifestHash(report.source_material) !== inputManifestHash(pin.source_material)
      || pin.selected_findings.some(finding => inputManifestHash(finding) !== inputManifestHash(report.findings.find(item => item.finding_id === finding.finding_id) ?? null))
      || pin.excluded_findings.some(finding => !report.findings.some(item => item.finding_id === finding.finding_id))) return false;
  const planRow = (await pool.query(`SELECT content_sha256,accepted_at,plan FROM bb_review_revision_plans
    WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND version=$4`,
  [pin.accepted_plan.plan_id, run.owner_user_id, run.project_id, pin.accepted_plan.version])).rows[0];
  if (!planRow?.plan || !planRow.accepted_at || !Number.isFinite(new Date(planRow.accepted_at).getTime())
      || !Array.isArray(planRow.plan.finding_ids) || !Array.isArray(planRow.plan.excluded_findings)
      || !Array.isArray(planRow.plan.requirements)) return false;
  const { sha256: planSha256, ...content } = planRow.plan;
  return planSha256 === pin.accepted_plan.sha256 && String(planRow.content_sha256).trim() === pin.accepted_plan.sha256
    && inputManifestHash(content) === pin.accepted_plan.sha256
    && content.plan_id === pin.accepted_plan.plan_id && content.version === pin.accepted_plan.version
    && content.accepted_at === pin.accepted_plan.accepted_at
    && new Date(planRow.accepted_at).toISOString() === pin.accepted_plan.accepted_at
    && content.source_report_id === pin.source_report.report_id
    && content.finding_ids.every((id:unknown) => typeof id === 'string')
    && inputManifestHash([...content.finding_ids].sort()) === inputManifestHash(pin.selected_findings.map(finding => finding.finding_id).sort())
    && inputManifestHash(content.excluded_findings) === inputManifestHash(pin.excluded_findings)
    && inputManifestHash(content.requirements) === inputManifestHash(pin.requirements);
}

/** Reload the exact successful report and its immutable source input on every recovery. */
export async function reviewResultArtifact(pool:Pool,run:RunRow,pin:ReviewResultPin){
  if(!Value.Check(ReviewResultPinSchema,pin))return null;
  const row=(await pool.query(`SELECT a.object_key,a.sha256,i.input_hash,i.manifest,e.snapshot FROM bb_artifact_versions a
    JOIN bb_review_artifacts ra ON ra.artifact_id=a.id AND ra.artifact_version=a.version AND ra.owner_user_id=a.owner_user_id AND ra.run_id=a.run_id AND ra.kind='report'
    JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id AND r.project_id=ra.project_id
    JOIN bb_review_executions e ON e.run_id=r.id AND e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id
    JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
    WHERE a.id=$1 AND a.version=$2 AND r.owner_user_id=$3 AND r.project_id=$4 AND r.id=$5 AND r.input_revision=$6
      AND r.state='succeeded' AND r.channel='production' AND e.operation IN ('full_review','differential_review')
      AND a.quality_status='passed' AND a.delivery_status='available'`,[pin.artifact_id,pin.artifact_version,run.owner_user_id,run.project_id,pin.run_id,pin.input_revision])).rows[0];
  return row&&row.sha256.trim()===pin.sha256&&row.input_hash.trim()===pin.input_hash&&inputManifestHash(row.manifest)===pin.input_hash
    && inputManifestHash(row.snapshot.input?.source_material_ref??null)===inputManifestHash(pin.source_material)?row:null;
}

export async function unifiedInputGate(pool: Pool, run: RunRow, input: InputRevisionRow): Promise<Extract<StageOutcome, { kind: 'pause' | 'fail' }> | null> {
  const fail = { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' } as const;
  if (!isUnifiedInput(input.manifest) || inputManifestHash(input.manifest) !== input.input_hash.trim() || input.input_hash.trim() !== run.input_hash.trim()) return fail;
  const m = input.manifest as UnifiedManifest;
  if (!Value.Check(UpdateDetailsSchema, m.update_details) || m.update_details.authoring_mode !== 'unified_v1' ||
      !Array.isArray(m.materials) || !Array.isArray(m.authoring.source_prospectuses) || !Array.isArray(m.authoring.knowledge) || !Array.isArray(m.authoring.requirements)) return fail;
  const format=m.authoring.format_policy;
  if(Object.hasOwn(m.authoring,'format_policy')){
    if(!Value.Check(SourceFormatPolicySchema,format))return fail;
    if(format.template?.kind==='artifact'){
      const {kind,...pin}=format.template;
      if(!m.authoring.previous_output || inputManifestHash(pin)!==inputManifestHash(m.authoring.previous_output))return fail;
    }else if(format.template?.kind==='material'){
      if(!m.materials.some(pin=>sameFormatTemplate(pin,format.template as import('@bondbuddy/contracts').FormatTemplatePin)))return fail;
      if(format.selection==='explicit' && !sameFormatTemplate(format.template,m.update_details.format_template))return fail;
      if(format.selection==='review_source' && !sameFormatTemplate(format.template,m.authoring.review_result?.source_material))return fail;
    }
  }
  // Resolve the version pinned by this immutable input, never the project's later
  // current selection. Older conflicting inputs fail closed without being rewritten.
  if(!m.authoring.review_result && !m.authoring.review_revision){
    const selection=m.prospectus_selection as {version_id?:unknown}|undefined;
    if(selection?.version_id!=null){
      if(typeof selection.version_id!=='string')return fail;
      const adopted=(await pool.query(`SELECT material_id,material_version,sha256 FROM bb_prospectus_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3`,
      [run.owner_user_id,run.project_id,selection.version_id])).rows[0];
      if(!adopted)return fail;
      if(adopted.material_id!==null && !m.authoring.previous_output){
        const pin={material_id:adopted.material_id,material_version:adopted.material_version,sha256:String(adopted.sha256).trim()};
        // Pre-format-policy snapshots use the same deterministic source order as
        // their legacy authoring path. A safe exact-source task can still resume.
        const legacy=!format?selectLegacySourcePin(m.materials,m.authoring):undefined;
        const editingPin=format?.template?.kind==='material'?format.template:legacy;
        if(!m.materials.some(material=>sameFormatTemplate(material,pin))
          || !sameFormatTemplate(editingPin,pin))return fail;
      }else if(adopted.material_id===null && !m.authoring.previous_output){
        // An explicit viewed-result continuation may differ from project current.
        // Its exact artifact/source/owner/hash is verified by previousArtifact below.
        return fail;
      }
    }
  }
  const result=m.authoring.review_result;
  const report=result?await reviewResultArtifact(pool,run,result):null;
  if(Object.hasOwn(m.authoring,'review_result')&&(!report||m.authoring.review_revision||m.authoring.previous_output))return fail;
  if(report&&inputManifestHash(report.manifest.materials)!==inputManifestHash(m.materials))return fail;
  const revision = m.authoring.review_revision;
  if (Object.hasOwn(m.authoring,'review_revision') && !isReviewRevisionPin(revision)) return fail;
  if (revision && (!await reviewRevisionInputGate(pool, run, revision) || m.authoring.previous_output)) return fail;
  if (revision && !revision.selected_findings.some(executableRevisionFinding))
    return { kind: 'pause', stage: 'capability_not_ready', reason: 'revision_no_executable_changes' };
  // A finding revision already pins its verified source/report/evidence. Optional project
  // labels cannot impose M1 whole-document authoring prerequisites on that accepted scope.
  if (!revision && !result && (typeof m.issuer_name !== 'string' || !m.issuer_name.trim() || !isMarketOffering(m.market, m.offering) || !m.update_details.target_reporting_periods?.length))
    return { kind: 'pause', stage: 'awaiting_materials', reason: 'authoring_target_information_required' };
  if (!m.materials.length) return { kind: 'pause', stage: 'awaiting_materials', reason: 'authoring_issuer_materials_required' };
  for (const pin of m.materials) {
    const material = (await pool.query('SELECT role,sha256,media_type FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL', [run.owner_user_id, run.project_id, pin.material_id, pin.material_version])).rows[0];
    if (!material || material.role !== pin.role || String(material.sha256).trim() !== pin.sha256) return fail;
    if(format?.template?.kind==='material' && sameFormatTemplate(format.template,pin)){
      if(!['historical','reference'].includes(material.role) && format.selection!=='review_source')return fail;
      if(material.media_type!==(format.mode==='preserve_docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf'))return fail;
    }
  }
  if (revision && (!m.materials.some(pin => pin.material_id === revision.source_material.material_id
      && pin.material_version === revision.source_material.material_version && pin.sha256 === revision.source_material.sha256)
      || revisionEvidenceRefs(revision).some(ref => !m.materials.some(pin => pin.material_id === ref.material_id
        && pin.material_version === ref.material_version && pin.sha256 === ref.material_sha256)))) return fail;
  // Source metadata is optional context. The worker resolves gaps from the uploaded
  // material and labels uncertainty; an unfilled relationship is never a same-issuer assertion.
  if (!revision && !result && !m.authoring.knowledge.length) return { kind: 'pause', stage: 'capability_not_ready', reason: 'authoring_knowledge_required' };
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
  const revision = manifest.authoring.review_revision;
  if (revision && options.originalFiles) throw new Error('INPUT_REVISION_CONFLICT');
  if (revision && !await reviewRevisionInputGate(ctx.pool, ctx.run, revision)) throw new Error('INPUT_REVISION_CONFLICT');
  const revisionRefs = revision ? revisionEvidenceRefs(revision) : [];
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
    const pinnedRefs = revisionRefs.filter(ref => ref.material_id === pin.material_id && ref.material_version === pin.material_version);
    const revisionSnapshots = new Set(pinnedRefs.map(ref => ref.parse_snapshot_id));
    if (revisionSnapshots.size > 1) throw new Error('INPUT_REVISION_CONFLICT');
    if (!revisionSnapshots.size && result.state !== 'succeeded') throw new UnifiedInputPending(result.state === 'failed' ? 'authoring_material_unreadable' : 'material_parse_pending');
    const snapshotId = revisionSnapshots.size ? [...revisionSnapshots][0] : result.checkpoint?.stages?.parse_evidence?.snapshot_id;
    const snapshot = snapshotId ? await getParseSnapshot({ pool: ctx.pool }, scope, snapshotId) : null;
    if (snapshot && snapshot.contentSha256 !== pin.sha256) throw new Error('INPUT_REVISION_CONFLICT');
    let records: UnifiedRecord[] = snapshot?.evidence ?? [];
    if (pinnedRefs.some(ref => !snapshot || snapshot.snapshotId !== ref.parse_snapshot_id || snapshot.responseSha256 !== ref.parse_response_sha256
        || ref.material_sha256 !== pin.sha256 || !records.some(record => record.record_id === ref.record_id
          && inputManifestHash(record) === ref.record_sha256 && record.literal_quote === ref.quote
          && inputManifestHash(record.locator) === inputManifestHash(ref.locator)
          && record.extraction_method === ref.extraction_method && inputManifestHash(record.uncertainty) === inputManifestHash(ref.uncertainty))))
      throw new Error('INPUT_REVISION_CONFLICT');
    // Native parsers identify scanned/image pages. Preflight OCR covers only a few pages;
    // the leased authoring run consumes the existing complete, hash-checked page cache.
    if (!revision && (result.checkpoint?.stages?.ocr_evidence || ['image/png','image/jpeg'].includes(result.media_type) ||
        snapshot?.response.warnings.some(w => ['PDF_PAGES_WITHOUT_TEXT','PDF_IMAGES_NOT_OCRD'].includes(w.code)))) {
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
  const reviewResult=manifest.authoring.review_result;
  if(reviewResult){
    if(!options.originalFiles)throw Error('INPUT_REVISION_CONFLICT');
    const stored=await reviewResultArtifact(ctx.pool,ctx.run,reviewResult);
    if(!stored||inputManifestHash(stored.manifest.materials)!==inputManifestHash(manifest.materials))throw Error('INPUT_REVISION_CONFLICT');
    materials.push({pin:{material_id:reviewResult.artifact_id,material_version:reviewResult.artifact_version,sha256:reviewResult.sha256,role:'review_report'},filename:'本次复核报告.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:stored.object_key,records:[]});
  }
  const requirements: string[] = reviewResult ? ["根据所附复核报告，结合本轮原募集书与证据材料更新文稿。有充分依据的建议才应用；待确认或缺证事项保留，不将未执行的检查写为通过。保留原稿结构，输出修订版和清洁版。",reviewResult.requirements].filter(Boolean) : [];
  // The review input's requirements and the accepted plan remain separately pinned.
  // Neither later chat messages nor the project's current mutable draft are loaded here.
  if (revision && manifest.review && typeof manifest.review === 'object') {
    const locked = (manifest.review as {input?:{requirements?:unknown}}).input?.requirements;
    if (locked !== undefined) {
      if (!Array.isArray(locked) || locked.some(value => typeof value !== 'string')) throw new Error('INPUT_REVISION_CONFLICT');
      requirements.push(...locked);
    }
  }
  for (const pin of manifest.authoring.requirements) {
    const row = (await ctx.pool.query(`SELECT snapshot_id,content_sha256 FROM bb_user_submission_versions
      WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND message_id=$4 AND message_version=$5 AND submission_kind='project_message'`,
    [pin.submission_id, ctx.run.owner_user_id, ctx.run.project_id, pin.message_id, pin.message_version])).rows[0];
    if (!row || String(row.content_sha256).trim() !== pin.content_sha256) throw new Error('INPUT_REVISION_CONFLICT');
    requirements.push(await ownerProjectMessageBody(ctx.pool, ctx.blobs, ctx.run.owner_user_id, ctx.run.project_id, row.snapshot_id, pin.content_sha256, ctx.signal));
  }
  return { manifest, materials, requirements };
}
