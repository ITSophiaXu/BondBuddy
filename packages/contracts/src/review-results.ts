import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const id = Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' });
const text = Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const strict = <T extends Parameters<typeof Type.Object>[0]>(fields: T) => Type.Object(fields, { additionalProperties: false });
const strings = Type.Array(text, { maxItems: 200 });
const ids = Type.Array(id, { maxItems: 2000, uniqueItems: true });

export const ReviewDimensionSchema = Type.Union([Type.Literal('financial'), Type.Literal('compliance'), Type.Literal('public')]);
export const ReviewPublicCategorySchema = Type.Union(['entity_control','bonds_credit','litigation_penalties','material_events'].map(value => Type.Literal(value)));
export const ReviewConclusionSchema = Type.Union([Type.Literal('error'), Type.Literal('conflict'), Type.Literal('needs_evidence'), Type.Literal('manual'), Type.Literal('uncovered')]);
export const ReviewCheckStatusSchema = Type.Union([Type.Literal('rechecked'), Type.Literal('carried_forward')]);

/** Source pins are verified against trusted parse records; a schema-valid quote alone is not evidence. */
export const ReviewEvidenceRefSchema = strict({
  material_id: id, material_version: Type.Integer({ minimum: 1 }), material_sha256: hash,
  parse_snapshot_id: id, parse_response_sha256: hash, record_id: id, record_sha256: hash,
  locator_type: Type.Union([Type.Literal('docx_block'), Type.Literal('pdf_bbox'), Type.Literal('xlsx_cell'), Type.Literal('csv_cell'), Type.Literal('text_line'), Type.Literal('ocr_bbox')]),
  locator: Type.Record(Type.String({ minLength: 1 }), Type.Unknown()),
  quote: text, extraction_method: Type.Union([Type.Literal('native_text'), Type.Literal('ocr')]),
  uncertainty: strings,
});
export type ReviewEvidenceRef = Static<typeof ReviewEvidenceRefSchema>;

export const ReviewRuleRefSchema = strict({
  rule_id: id, rule_version: id, pack_id: id, pack_version: id, pack_sha256: hash,
  source_id: id, source_version: id, source_sha256: hash, quote: text, locator: text,
  effective_from: Type.Union([day, Type.Null()]), effective_to: Type.Union([day, Type.Null()]),
  applicability: Type.Union([Type.Literal('applicable'), Type.Literal('not_applicable'), Type.Literal('unknown')]),
  authority: Type.Union([Type.Literal('regulatory'), Type.Literal('template'), Type.Literal('internal_method')]),
  url: Type.Optional(Type.String({ pattern: '^https?://[^\\s]+$', maxLength: 4096 })),
});
export type ReviewRuleRef = Static<typeof ReviewRuleRefSchema>;
/** Created by the worker from a persisted web_search event, never from a model-authored URL. */
export const ReviewPublicSourceSchema = strict({
  tool_call_id: id, tool: Type.Literal('web_search'),
  url: Type.String({ pattern: '^https?://[^\\s]+$', maxLength: 4096 }), title: text,
  retrieved_at: timestamp, published_at: Type.Union([day, Type.Null()]),
  entity: text, as_of: Type.Union([day, Type.Null()]), quote: text, locator: text,
  availability: Type.Union([Type.Literal('available'), Type.Literal('unreachable'), Type.Literal('conflicting')]),
  entity_match: Type.Union([Type.Literal('confirmed'), Type.Literal('ambiguous'), Type.Literal('mismatch')]),
});
export type ReviewPublicSource = Static<typeof ReviewPublicSourceSchema>;
const evidence = Type.Array(ReviewEvidenceRefSchema, { maxItems: 1000 });
const rules = Type.Array(ReviewRuleRefSchema, { maxItems: 200 });
const publicSources = Type.Array(ReviewPublicSourceSchema, { maxItems: 200 });

export const ReviewFindingSchema = strict({
  finding_id: id, report_id: id, dimension: ReviewDimensionSchema, conclusion: ReviewConclusionSchema,
  severity: Type.Union([Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')]),
  title: text, description: text, target_refs: evidence, evidence_refs: evidence,
  public_category: Type.Optional(ReviewPublicCategorySchema),
  rule_refs: Type.Optional(rules), public_sources: Type.Optional(publicSources), suggested_change: Type.Optional(text), limitations: strings,
  calculation: Type.Optional(strict({ expression: text, operands: ids, expected: text, observed: text, unit: id, rounding: text })),
  repairability: strict({ can_revise: Type.Boolean(), reason: text, allowed_record_ids: ids }),
  origin_report_id: id, check_status: ReviewCheckStatusSchema,
});
export type ReviewFinding = Static<typeof ReviewFindingSchema>;

export const ReviewCheckCoverageSchema = strict({
  check_id: id, dimension: ReviewDimensionSchema,
  outcome: Type.Union([Type.Literal('pass'), Type.Literal('issue'), Type.Literal('needs_evidence'), Type.Literal('manual'), Type.Literal('uncovered'), Type.Literal('not_applicable')]),
  reason: text, finding_ids: ids, evidence_refs: evidence, rule_refs: rules, public_sources: Type.Optional(publicSources),
  origin_report_id: id, check_status: ReviewCheckStatusSchema,
});
export type ReviewCheckCoverage = Static<typeof ReviewCheckCoverageSchema>;

/** Links each source finding to actual current coverage, including an explicit incomplete outcome. */
export const ReviewFollowUpSchema = strict({
  version: Type.Literal('review-follow-up-v1'), source_report_id: id, source_report_sha256: hash,
  findings: Type.Array(strict({ source_finding_id: id, current_finding_ids: ids, coverage_check_ids: ids,
    status: Type.Union([Type.Literal('rechecked'), Type.Literal('carried_forward'), Type.Literal('uncompleted')]),
    outcome: Type.Union(['issue','resolved','needs_evidence','manual','uncovered','carried_forward'].map(v => Type.Literal(v))), reason: text,
  }), { maxItems: 10000 }),
});
export type ReviewFollowUp = Static<typeof ReviewFollowUpSchema>;

export const ReviewReportSchema = strict({
  report_id: id, project_id: id, run_id: id, input_revision: Type.Integer({ minimum: 1 }),
  version: Type.Integer({ minimum: 1 }),
  source_material: strict({ material_id: id, material_version: Type.Integer({ minimum: 1 }), sha256: hash }),
  scope: strict({ mode: Type.Union([Type.Literal('full_review'), Type.Literal('differential_review')]), finding_ids: ids }),
  findings: Type.Array(ReviewFindingSchema, { maxItems: 10000 }),
  coverage: Type.Array(ReviewCheckCoverageSchema, { maxItems: 10000 }), limitations: strings,
  follow_up: Type.Optional(ReviewFollowUpSchema),
  created_at: timestamp,
});
export type ReviewReport = Static<typeof ReviewReportSchema>;

/** Shape and cross-reference check; callers must separately verify source pins and authorization. */
export function isReviewReport(value: unknown): value is ReviewReport {
  if (!Value.Check(ReviewReportSchema, value)) return false;
  const ids = new Set(value.findings.map(finding => finding.finding_id));
  if (ids.size !== value.findings.length || new Set(value.coverage.map(check => check.check_id)).size !== value.coverage.length) return false;
  const validDay = (date: string | null) => date === null || Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
  const validTime = (date: string) => Number.isFinite(Date.parse(date)) && validDay(date.slice(0,10));
  if (!validTime(value.created_at)) return false;
  if (value.follow_up) {
    const follow = value.follow_up, checks = new Map(value.coverage.map(c => [c.check_id,c]));
    if (value.scope.mode !== 'differential_review' || follow.source_report_id === value.report_id
      || new Set(follow.findings.map(f => f.source_finding_id)).size !== follow.findings.length
      || value.scope.finding_ids.some(id => !follow.findings.some(f => f.source_finding_id === id))
      || follow.findings.some(f => f.current_finding_ids.some(id => !ids.has(id)) || f.coverage_check_ids.some(id => !checks.has(id))
        || (f.status === 'carried_forward') !== (f.outcome === 'carried_forward')
        || (f.status === 'carried_forward') === value.scope.finding_ids.includes(f.source_finding_id)
        || f.status === 'carried_forward' && (!f.current_finding_ids.includes(f.source_finding_id)
          || f.current_finding_ids.some(id => value.findings.find(v => v.finding_id === id)!.check_status !== 'carried_forward')
          || f.coverage_check_ids.some(id => checks.get(id)!.check_status !== 'carried_forward'))
        || f.outcome === 'resolved' && (f.status !== 'rechecked' || f.current_finding_ids.length > 0
          || !f.coverage_check_ids.some(id => { const c=checks.get(id)!;return c.check_id===`scope:${f.source_finding_id}`&&c.check_status==='rechecked'&&c.outcome==='pass'
            && (c.evidence_refs.length>0||c.rule_refs.length>0||(c.public_sources?.length??0)>0); })))) return false;
  }
  const allRefs = [...value.findings,...value.coverage];
  if (allRefs.some(item => (item.rule_refs ?? []).some(ref => !validDay(ref.effective_from) || !validDay(ref.effective_to))
    || (item.public_sources ?? []).some(ref => !validTime(ref.retrieved_at) || !validDay(ref.published_at) || !validDay(ref.as_of)))) return false;
  return value.findings.every(finding => finding.report_id === value.report_id
    && (finding.check_status !== 'rechecked' || finding.origin_report_id === value.report_id)
    && (finding.check_status !== 'carried_forward' || finding.origin_report_id !== value.report_id)
    && (!finding.repairability.can_revise || (finding.conclusion === 'error' && !!finding.suggested_change
      && finding.target_refs.length > 0 && finding.evidence_refs.length > 0 && finding.repairability.allowed_record_ids.length > 0
      && finding.repairability.allowed_record_ids.every(id => finding.target_refs.some(ref => ref.record_id === id)))))
    && value.coverage.every(check => check.finding_ids.every(id => ids.has(id))
      && (check.check_status !== 'rechecked' || check.origin_report_id === value.report_id)
      && (check.check_status !== 'carried_forward' || check.origin_report_id !== value.report_id)
      && (!['pass', 'not_applicable'].includes(check.outcome) || check.evidence_refs.length > 0 || check.rule_refs.length > 0 || (check.public_sources?.length ?? 0) > 0));
}
