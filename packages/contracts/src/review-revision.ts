import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ReviewFindingSchema, type ReviewFinding } from './review-results.js';

const id = Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' });
const text = Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const version = Type.Integer({ minimum: 1 });
const strict = <T extends Parameters<typeof Type.Object>[0]>(fields: T) => Type.Object(fields, { additionalProperties: false });
const texts = Type.Array(text, { maxItems: 200 });

/** The API locks this exact accepted plan and report in the existing update input revision. */
export const ReviewRevisionPinSchema = strict({
  version: Type.Literal('review-revision-v1'), owner_user_id: id, project_id: id,
  source_report: strict({ report_id: id, run_id: id, version, input_revision: version, sha256: hash }),
  source_material: strict({ material_id: id, material_version: version, sha256: hash }),
  accepted_plan: strict({ plan_id: id, version, sha256: hash,
    accepted_at: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' }) }),
  selected_findings: Type.Array(ReviewFindingSchema, { minItems: 1, maxItems: 1000 }),
  excluded_findings: Type.Array(strict({ finding_id: id, reason: text }), { maxItems: 10000 }),
  requirements: texts, limitations: texts,
});
export type ReviewRevisionPin = Static<typeof ReviewRevisionPinSchema>;

/** Evidence conflicts and uncertain/OCR records remain pending even if a user selected them. */
export function executableRevisionFinding(finding: ReviewFinding): boolean {
  return finding.conclusion === 'error' && finding.repairability.can_revise && !!finding.suggested_change?.trim()
    && finding.repairability.allowed_record_ids.length > 0 && finding.target_refs.length > 0 && finding.evidence_refs.length > 0
    && [...finding.target_refs, ...finding.evidence_refs].every(ref => ref.extraction_method === 'native_text' && ref.uncertainty.length === 0)
    && (finding.rule_refs ?? []).every(ref => ref.applicability === 'applicable')
    && finding.repairability.allowed_record_ids.every(id => finding.target_refs.some(ref => ref.record_id === id));
}

/** Shape/cross-reference validation only; the caller also verifies persisted report/plan and parse hashes. */
export function isReviewRevisionPin(value: unknown): value is ReviewRevisionPin {
  if (!Value.Check(ReviewRevisionPinSchema, value) || !Number.isFinite(Date.parse(value.accepted_plan.accepted_at))) return false;
  const selected = new Set(value.selected_findings.map(finding => finding.finding_id));
  const excluded = new Set(value.excluded_findings.map(finding => finding.finding_id));
  const source = value.source_material;
  return selected.size === value.selected_findings.length && excluded.size === value.excluded_findings.length
    && value.excluded_findings.every(finding => !selected.has(finding.finding_id))
    && value.selected_findings.every(finding => finding.report_id === value.source_report.report_id
      && finding.target_refs.every(ref => ref.material_id === source.material_id && ref.material_version === source.material_version
        && ref.material_sha256 === source.sha256)
      && new Set(finding.repairability.allowed_record_ids).size === finding.repairability.allowed_record_ids.length
      && finding.repairability.allowed_record_ids.every(id => finding.target_refs.some(ref => ref.record_id === id)));
}

export const ReviewRevisionHandlingItemSchema = strict({
  finding_id: id, report_id: id,
  status: Type.Union([Type.Literal('modified'), Type.Literal('not_modified'), Type.Literal('needs_evidence')]),
  reason: text,
  locations: Type.Array(strict({ record_id: id, locator: Type.Record(Type.String(), Type.Unknown()) }), { maxItems: 2000 }),
  evidence_refs: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 2000, uniqueItems: true }),
  review_passed: Type.Literal(false),
});
export type ReviewRevisionHandlingItem = Static<typeof ReviewRevisionHandlingItemSchema>;
export const ReviewRevisionHandlingSchema = strict({
  version: Type.Literal('review-revision-handling-v1'),
  source_report: ReviewRevisionPinSchema.properties.source_report,
  accepted_plan: ReviewRevisionPinSchema.properties.accepted_plan,
  source_material: ReviewRevisionPinSchema.properties.source_material,
  items: Type.Array(ReviewRevisionHandlingItemSchema, { minItems: 1, maxItems: 10000 }),
  limitations: texts, review_passed: Type.Literal(false),
});
export type ReviewRevisionHandling = Static<typeof ReviewRevisionHandlingSchema>;
