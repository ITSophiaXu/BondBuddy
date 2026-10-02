import { type ReviewDraftInput, type ReviewReport, type ReviewMessage } from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { checkpointStage } from '@bondbuddy/api/queue';
import { getParseSnapshot } from './parse-evidence-repository.js';
import type { StageContext, StageOutcome, RunRow, InputRevisionRow } from './run-pipeline.js';
import type { Pool } from 'pg';
import type { ReviewAnalysisInput, ReviewAnalysisRecord } from './review-model-stage.js';
import { isReviewReport } from '@bondbuddy/contracts';
import { loadReviewRuleContext } from './review-rule-context.js';
import { loadReviewDocumentFormatting } from './review-document-formatting.js';
import type { ReviewFormattedDocument } from '../../../packages/domain/dist/review-compliance-checks.js';

export type ReviewManifest = Record<string, unknown> & {
  issuer_name: string | null; market: string | null; offering: string | null;
  materials: { material_id: string; material_version: number; sha256: string; role: string }[];
  review: { version: 'review_v1'; operation: 'full_review' | 'differential_review' | 'revision'; report_id: string; version_number: number; input: ReviewDraftInput;
    source_report_id: string | null; source_report_sha256: string | null; finding_ids: string[]; context_messages?: ReviewMessage[] };
};
export function isReviewInput(value: unknown): value is ReviewManifest {
  return !!value && typeof value === 'object' && (value as ReviewManifest).review?.version === 'review_v1';
}
export async function reviewInputGate(pool: Pool, run: RunRow, input: InputRevisionRow): Promise<Extract<StageOutcome, { kind: 'fail' }> | null> {
  const invalid = { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' } as const;
  if (!isReviewInput(input.manifest) || inputManifestHash(input.manifest) !== run.input_hash.trim() || input.input_hash.trim() !== run.input_hash.trim()) return invalid;
  const m = input.manifest;
  if (!m.review.input.source_material_ref || !Array.isArray(m.materials) || !m.materials.some(p => p.material_id === m.review.input.source_material_ref!.material_id && p.material_version === m.review.input.source_material_ref!.material_version && p.sha256 === m.review.input.source_material_ref!.sha256)) return invalid;
  const execution = (await pool.query('SELECT version,operation,snapshot FROM bb_review_executions WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3', [run.owner_user_id, run.project_id, run.id])).rows[0];
  if (!execution || execution.version !== m.review.version_number || execution.operation !== m.review.operation || inputManifestHash(execution.snapshot.input) !== inputManifestHash(m.review.input)) return invalid;
  for (const pin of m.materials) {
    const row = (await pool.query('SELECT sha256,role FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL', [run.owner_user_id, run.project_id, pin.material_id, pin.material_version])).rows[0];
    if (!row || row.sha256.trim() !== pin.sha256 || row.role !== pin.role) return invalid;
  }
  return null;
}

export async function reviewMaterialsReady(ctx: Pick<StageContext, 'pool' | 'run'>): Promise<StageOutcome> {
  const input = (await ctx.pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3', [ctx.run.owner_user_id, ctx.run.project_id, ctx.run.input_revision])).rows[0];
  if (!isReviewInput(input?.manifest)) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
  for (const pin of input.manifest.materials) {
    const job = (await ctx.pool.query("SELECT state,stage FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND subtype='material_parse' AND parser_version=$5", [ctx.run.owner_user_id, ctx.run.project_id, pin.material_id, pin.material_version, documentParserVersion()])).rows[0];
    if (!job || ['queued','running'].includes(job.state)) return { kind: 'pause', stage: 'awaiting_materials', reason: 'material_parse_pending' };
    // Failed or OCR-pending material is an explicit coverage gap, not fabricated evidence.
  }
  return { kind: 'done', checkpoint: { review_mode: 'review_v1' } };
}

export async function loadReviewInput(ctx: StageContext): Promise<ReviewAnalysisInput> {
  const row = (await ctx.pool.query(`SELECT i.*,r.created_at FROM bb_input_revisions i JOIN bb_runs r ON r.project_id=i.project_id AND r.owner_user_id=i.owner_user_id AND r.input_revision=i.revision
    WHERE r.id=$1 AND r.owner_user_id=$2`, [ctx.run.id, ctx.run.owner_user_id])).rows[0];
  if (!row || !isReviewInput(row.manifest) || await reviewInputGate(ctx.pool, ctx.run, row)) throw new Error('INPUT_REVISION_CONFLICT');
  const manifest = row.manifest as ReviewManifest, review = manifest.review;
  const records: ReviewAnalysisRecord[] = [], limitations: string[] = [];
  const formatted_documents:ReviewFormattedDocument[]=[];
  type SnapshotPin = { material_id: string; material_version: number; snapshot_id: string | null; response_sha256: string | null; gap: string | null };
  let snapshots = ctx.checkpoint.review_sources?.snapshots as SnapshotPin[] | undefined;
  if (!snapshots) {
    snapshots = [];
    for (const pin of manifest.materials) {
      const job = (await ctx.pool.query("SELECT state,checkpoint FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND subtype='material_parse' AND parser_version=$5", [ctx.run.owner_user_id, ctx.run.project_id, pin.material_id, pin.material_version, documentParserVersion()])).rows[0];
      const snapshotId = job?.checkpoint?.stages?.parse_evidence?.snapshot_id;
      const snapshot = snapshotId ? await getParseSnapshot({ pool: ctx.pool }, { ownerUserId: ctx.run.owner_user_id, projectId: ctx.run.project_id, materialId: pin.material_id, materialVersion: pin.material_version }, snapshotId) : null;
      snapshots.push({ material_id: pin.material_id, material_version: pin.material_version, snapshot_id: snapshot?.snapshotId ?? null, response_sha256: snapshot?.responseSha256 ?? null, gap: job?.state === 'succeeded' ? null : `材料 ${pin.material_id} 未完整解析：${job?.state ?? 'missing'}` });
    }
    await checkpointStage(ctx.pool, ctx.lease, 'review_sources', { snapshots });
    ctx.checkpoint.review_sources = { snapshots };
  }
  for (const pin of manifest.materials) {
    const selected = snapshots.find(p => p.material_id === pin.material_id && p.material_version === pin.material_version);
    if (!selected) throw new Error('INPUT_REVISION_CONFLICT');
    if (selected.gap) limitations.push(selected.gap);
    if (!selected.snapshot_id) { limitations.push(`材料 ${pin.material_id} 无可用解析证据，本次未覆盖。`); continue; }
    const snapshot = await getParseSnapshot({ pool: ctx.pool }, { ownerUserId: ctx.run.owner_user_id, projectId: ctx.run.project_id, materialId: pin.material_id, materialVersion: pin.material_version }, selected.snapshot_id);
    if (!snapshot || snapshot.contentSha256 !== pin.sha256 || snapshot.responseSha256 !== selected.response_sha256) throw new Error('INPUT_REVISION_CONFLICT');
    if(pin.material_id===review.input.source_material_ref!.material_id){
      const document=loadReviewDocumentFormatting(snapshot,{owner_user_id:ctx.run.owner_user_id,project_id:ctx.run.project_id,
        source:review.input.source_material_ref!,snapshot_id:selected.snapshot_id,response_sha256:selected.response_sha256});
      if(document)formatted_documents.push(document);
    }
    for (const warning of snapshot.response.warnings) limitations.push(`材料 ${pin.material_id}：${warning.code}`);
    for (const record of snapshot.evidence) {
      records.push({ owner_user_id: ctx.run.owner_user_id, project_id: ctx.run.project_id,
        material_id: pin.material_id, material_version: pin.material_version, material_sha256: pin.sha256,
        parse_snapshot_id: snapshot.snapshotId, parse_response_sha256: snapshot.responseSha256,
        record_id: record.record_id, record_sha256: inputManifestHash(record), locator_type: record.locator_type, locator: record.locator,
        literal_quote: record.literal_quote, extraction_method: record.extraction_method, uncertainty: record.uncertainty,
        source_kind: pin.material_id === review.input.source_material_ref!.material_id ? 'disclosure' : pin.role === 'audit' ? 'audit' : ['financial','interimFinancial','notes','accountDetails'].includes(pin.role) ? 'financial_statement' : 'user_statement',
        formatting: record.formatting, context: record.context });
    }
  }
  let previous: ReviewReport | undefined;
  if (review.source_report_id) {
    const source = (await ctx.pool.query('SELECT report,content_sha256 FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2 AND id=$3', [ctx.run.owner_user_id, ctx.run.project_id, review.source_report_id])).rows[0];
    if (!source || !isReviewReport(source.report) || source.content_sha256.trim() !== review.source_report_sha256 || inputManifestHash(source.report) !== review.source_report_sha256) throw new Error('INPUT_REVISION_CONFLICT');
    previous = source.report;
  }
  const historicalRecords: ReviewAnalysisRecord[] = [];
  if (previous && inputManifestHash(previous.source_material) !== inputManifestHash(review.input.source_material_ref)) {
    const oldRefs = previous.findings.filter(f => review.finding_ids.includes(f.finding_id)).flatMap(f => f.target_refs);
    const snapshotPins = [...new Map(oldRefs.map(ref => [inputManifestHash([ref.material_id,ref.material_version,ref.parse_snapshot_id]),ref])).values()];
    for (const ref of snapshotPins) {
      if (ref.material_id !== previous.source_material.material_id || ref.material_version !== previous.source_material.material_version || ref.material_sha256 !== previous.source_material.sha256) continue;
      const snapshot = await getParseSnapshot({ pool: ctx.pool }, { ownerUserId: ctx.run.owner_user_id, projectId: ctx.run.project_id, materialId: ref.material_id, materialVersion: ref.material_version }, ref.parse_snapshot_id);
      if (!snapshot || snapshot.contentSha256 !== ref.material_sha256 || snapshot.responseSha256 !== ref.parse_response_sha256) throw new Error('INPUT_REVISION_CONFLICT');
      for (const record of snapshot.evidence) historicalRecords.push({ owner_user_id: ctx.run.owner_user_id, project_id: ctx.run.project_id,
        material_id: ref.material_id, material_version: ref.material_version, material_sha256: ref.material_sha256,
        parse_snapshot_id: snapshot.snapshotId, parse_response_sha256: snapshot.responseSha256,
        record_id: record.record_id, record_sha256: inputManifestHash(record), locator_type: record.locator_type, locator: record.locator,
        literal_quote: record.literal_quote, extraction_method: record.extraction_method, uncertainty: record.uncertainty,
        source_kind: 'disclosure', formatting: record.formatting, context: record.context });
    }
  }
  const ruleContext = await loadReviewRuleContext(ctx, manifest, records);
  limitations.push(...ruleContext.limitations);
  const input: ReviewAnalysisInput = { input_hash: ctx.run.input_hash.trim(), evidence: { owner_user_id: ctx.run.owner_user_id, project_id: ctx.run.project_id, report_id: review.report_id,
    source_material: review.input.source_material_ref!, records, rules: ruleContext.rules },
    rule_context: ruleContext.rule_context,
    formatted_documents,
    rule_packs: ruleContext.rule_packs, formatting_requirements: ruleContext.formatting_requirements, requirements: review.input.requirements,
    context_messages: review.context_messages ?? [],
    ...{ historical_records: historicalRecords },
    scope: { mode: review.operation === 'differential_review' ? 'differential_review' : 'full_review', finding_ids: review.finding_ids },
    ...(previous ? { previous_report: previous } : {}), report_version: review.version_number, created_at: new Date(row.created_at).toISOString(), limitations: [...new Set(limitations)] };
  ctx.values.set('review_input', input);
  return input;
}
