import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  ReviewConclusionSchema,
  ReviewDimensionSchema,
  type ReviewReport,
  type ReviewEvidenceRef,
} from '../../../packages/contracts/dist/review-results.js';
import type { RuleContext, RulePack } from '@bondbuddy/domain';
import {
  canonical,
  evidenceKey,
  referenceFor,
  reviewContentHash,
  validateReviewEvidence,
  type ReviewEvidenceContext,
  type TrustedReviewRecord,
} from '../../../packages/domain/dist/review-evidence.js';
import type {
  ReviewFinancialInput,
  ReviewFinancialObservation,
} from '../../../packages/domain/dist/review-financial-checks.js';
import { verifyModelFinancialContext } from '../../../packages/domain/dist/review-financial-context.js';
import type {
  ReviewComplianceInput,
  ReviewFormattingRequirement,
} from '../../../packages/domain/dist/review-compliance-checks.js';
import type { ReviewFindingCandidate } from '../../../packages/domain/dist/review-finding-normalization.js';
import type { DifferentialFindingMapping } from './review-anchor-mapping.js';
import {
  promptReviewRecord,
  reviewPromptRecordId,
  reviewTableScope,
  sameReviewSnapshot,
} from './review-record-context.js';
export { reviewPromptRecordId } from './review-record-context.js';
/** Loaded from authorized immutable parse storage, not from model output. */
export interface ReviewAnalysisRecord extends TrustedReviewRecord {
  source_kind: ReviewFinancialObservation['source_kind'];
  formatting?: Record<string, unknown>;
  context?: string;
}
export interface ReviewAnalysisInput {
  input_hash: string;
  evidence: Omit<ReviewEvidenceContext, 'records'> & { records: readonly ReviewAnalysisRecord[] };
  rule_context: RuleContext | null;
  rule_packs: RulePack[];
  formatting_requirements: ReviewFormattingRequirement[];
  requirements: string[];
  context_messages?: { role: string; content: string; context: unknown }[];
  scope: ReviewReport['scope'];
  previous_report?: ReviewReport;
  historical_records?: readonly TrustedReviewRecord[];
  report_version: number;
  created_at: string;
  limitations: string[];
}
export interface ReviewAnalysisResult {
  version: 'review-analysis-v1';
  input_hash: string;
  report: ReviewReport;
  model_calls: number;
  input: ReviewAnalysisInput;
  anchor_mappings?: DifferentialFindingMapping[];
}
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' });
const text = Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' });
const nullableText = Type.Union([text, Type.Null()]);
const strings = Type.Array(text, { maxItems: 200 });
const ids = Type.Array(id, { maxItems: 2000, uniqueItems: true });
const strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
// Prompt record IDs include material/parse/record pins because each parser restarts its record numbering.
const citation = strict({ record_id: id, quote: text });
const citations = Type.Array(citation, { maxItems: 200 });
const observation = strict({
  observation_id: id,
  source_record_id: id,
  entity_id: text,
  metric: text,
  accounting_scope: text,
  basis: text,
  period: strict({ start: nullableText, end: nullableText, as_of: nullableText }),
  currency: text,
  unit: text,
  value: Type.String({ pattern: '^[+-]?\\d+(?:\\.\\d+)?$', maxLength: 200 }),
  value_literal: text,
  value_refs: Type.Array(citation, { minItems: 1, maxItems: 200 }),
  context_refs: strict({
    entity: citations,
    period: citations,
    accounting_scope: citations,
    currency: citations,
    unit: citations,
    basis: citations,
  }),
});
const calculation = strict({
  calculation_id: id,
  label: text,
  operation: Type.Union([
    Type.Literal('sum'),
    Type.Literal('ratio_percent'),
    Type.Literal('growth_percent'),
    Type.Literal('percentage_point'),
  ]),
  result_id: id,
  operand_ids: ids,
  complete_terms: Type.Boolean(),
});
const assessment = strict({
  check_id: id,
  rule_keys: Type.Array(id, { minItems: 1, maxItems: 200 }),
  outcome: Type.Union([
    Type.Literal('pass'),
    Type.Literal('issue'),
    Type.Literal('needs_evidence'),
    Type.Literal('manual'),
    Type.Literal('uncovered'),
    Type.Literal('not_applicable'),
  ]),
  title: text,
  description: text,
  target_refs: citations,
  evidence_refs: citations,
  claims_document_absence: Type.Boolean(),
  suggested_change: nullableText,
});
const concern = strict({
  stable_key: id,
  dimension: Type.Exclude(ReviewDimensionSchema, Type.Literal('public')),
  conclusion: ReviewConclusionSchema,
  severity: Type.Union([Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')]),
  title: text,
  description: text,
  target_refs: citations,
  evidence_refs: citations,
  rule_keys: ids,
  suggested_change: nullableText,
  limitations: strings,
});
/** Internal structured extraction protocol. Public findings/report enums and DTOs live only in contracts. */
export const ReviewAnalysisSchema = strict({
  reviewed_record_ids: ids,
  observations: Type.Array(observation, { maxItems: 2000 }),
  calculations: Type.Array(calculation, { maxItems: 1000 }),
  compliance_assessments: Type.Array(assessment, { maxItems: 1000 }),
  concerns: Type.Array(concern, { maxItems: 1000 }),
  limitations: strings,
});
export type ModelReviewAnalysis = Static<typeof ReviewAnalysisSchema>;
export const reviewPromptRuleId = (rule: ReviewEvidenceContext['rules'][number]): string =>
  `L-${reviewContentHash(rule).slice(0, 32)}`;
export class ReviewAnalysisInvalid extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ReviewAnalysisInvalid';
  }
}
function invalid(code: string): never {
  throw new ReviewAnalysisInvalid(code);
}

export interface NormalizedReviewAnalysis {
  financial: ReviewFinancialInput;
  compliance: ReviewComplianceInput['assessments'];
  concerns: ReviewFindingCandidate[];
  reviewed_record_ids: string[];
  limitations: string[];
}
function sourceMatches(record: TrustedReviewRecord, input: ReviewAnalysisInput): boolean {
  const source = input.evidence.source_material;
  return (
    record.material_id === source.material_id &&
    record.material_version === source.material_version &&
    record.material_sha256 === source.sha256
  );
}

/**
 * A model's claim that a sum has all terms is insufficient. For a native table sum, independently
 * enumerate the preceding numeric cells in the result column and require exactly those operands.
 * Complex/nested totals, prose and OCR sums stay pending unless a separate trusted checker supplies them.
 */
function completeNativeSum(
  result: ReviewFinancialObservation,
  operands: ReviewFinancialObservation[],
  input: ReviewAnalysisInput,
): boolean {
  const position = (
    ref: ReviewEvidenceRef,
  ): { group: string; row: number; column: string } | null => {
    if (ref.extraction_method !== 'native_text' || ref.uncertainty.length) return null;
    if (ref.locator_type === 'docx_block') {
      const path = ref.locator.path;
      if (!Array.isArray(path)) return null;
      const table = path.find((p) => p && typeof p === 'object' && 'table' in p),
        row = path.find((p) => p && typeof p === 'object' && 'row' in p),
        column = path.find((p) => p && typeof p === 'object' && 'column' in p);
      if (!table || !row || !column) return null;
      return {
        group: canonical([
          ref.material_id,
          ref.material_version,
          ref.parse_snapshot_id,
          table.table,
        ]),
        row: Number(row.row),
        column: String(column.column),
      };
    }
    if (ref.locator_type === 'xlsx_cell') {
      const match = /^([A-Z]+)(\d+)$/.exec(String(ref.locator.cell));
      if (!match) return null;
      return {
        group: canonical([
          ref.material_id,
          ref.material_version,
          ref.parse_snapshot_id,
          ref.locator.sheet,
        ]),
        row: Number(match[2]),
        column: match[1]!,
      };
    }
    return null;
  };
  if (
    result.value_refs.length !== 1 ||
    !operands.length ||
    operands.some((o) => o.value_refs.length !== 1)
  )
    return false;
  const end = position(result.value_refs[0]!);
  if (!end) return false;
  const expected = operands.map((o) => position(o.value_refs[0]!));
  if (
    expected.some((p) => !p || p.group !== end.group || p.column !== end.column || p.row >= end.row)
  )
    return false;
  const numeric = input.evidence.records.filter((r) => {
    const p = position(referenceFor(r));
    return (
      p &&
      p.group === end.group &&
      p.column === end.column &&
      p.row < end.row &&
      /^[+\-（(]?\d[\d,.]*[)）]?[%％]?$/.test(r.literal_quote.trim())
    );
  });
  const operandKeys = new Set(operands.map((o) => evidenceKey(o.value_refs[0]!)));
  return (
    numeric.length === operands.length && numeric.every((r) => operandKeys.has(evidenceKey(r)))
  );
}

export function normalizeModelReviewAnalysis(
  input: ReviewAnalysisInput,
  raw: unknown,
  accessibleRecordIds?: ReadonlySet<string>,
): NormalizedReviewAnalysis {
  if (!Value.Check(ReviewAnalysisSchema, raw)) return invalid('review_analysis_schema_invalid');
  const records = new Map(input.evidence.records.map((r) => [reviewPromptRecordId(r), r]));
  if (records.size !== input.evidence.records.length)
    return invalid('review_analysis_records_ambiguous');
  const rules = new Map(input.evidence.rules.map((r) => [reviewPromptRuleId(r), r]));
  const ref = (cited: Static<typeof citation>): ReviewEvidenceRef => {
    const record = records.get(cited.record_id);
    if (!record || (accessibleRecordIds && !accessibleRecordIds.has(cited.record_id)))
      return invalid('review_analysis_unknown_citation');
    const reference = referenceFor(record, cited.quote);
    if (validateReviewEvidence(reference, input.evidence).length)
      return invalid('review_analysis_invalid_citation');
    return reference;
  };
  const refs = (items: Static<typeof citations>) => items.map(ref);
  const ruleRefs = (keys: string[]) =>
    keys.map((key) => rules.get(key) ?? invalid('review_analysis_unknown_rule'));
  if (raw.reviewed_record_ids.some((id) => !records.has(id)))
    return invalid('review_analysis_unknown_reviewed_record');
  const observationIds = new Map<string, string>();
  const observations = raw.observations.map((o) => {
    if (observationIds.has(o.observation_id))
      return invalid('review_analysis_duplicate_observation_id');
    const source = records.get(o.source_record_id);
    if (!source) return invalid('review_analysis_unknown_source');
    const valueRefs = refs(o.value_refs);
    if (
      !valueRefs.some((r) => evidenceKey(r) === evidenceKey(source)) ||
      valueRefs.some(
        (r) =>
          r.material_id !== source.material_id || r.material_version !== source.material_version,
      )
    )
      return invalid('review_analysis_mixed_value_source');
    const contextRefs = Object.fromEntries(
      Object.entries(o.context_refs).map(([key, value]) => [key, refs(value)]),
    ) as ReviewFinancialObservation['context_refs'];
    if (
      Object.values(contextRefs)
        .flat()
        .some(
          (r) =>
            r.material_id !== source.material_id || r.material_version !== source.material_version,
        )
    )
      return invalid('review_analysis_mixed_context_source');
    const sourceTable = reviewTableScope(source);
    const contextRecords = Object.values(contextRefs)
      .flat()
      .map((r) => records.get(reviewPromptRecordId(r))!);
    const unboundTableContext = !!sourceTable && contextRecords.some((r) => !reviewTableScope(r));
    if (
      sourceTable &&
      contextRecords.some((r) => {
        const table = reviewTableScope(r);
        // A same-snapshot DOCX preamble can be cited but cannot establish a table's semantics.
        return table
          ? table.key !== sourceTable.key
          : source.locator_type !== 'docx_block' ||
              r.locator_type !== 'docx_block' ||
              !sameReviewSnapshot(source, r);
      })
    )
      return invalid('review_analysis_mixed_table_context');
    if (source.source_kind === 'disclosure' && !sourceMatches(source, input))
      return invalid('review_analysis_disclosure_source_mismatch');
    if (source.source_kind !== 'disclosure' && sourceMatches(source, input))
      return invalid('review_analysis_source_role_mismatch');
    const observationId = `O-${reviewContentHash([valueRefs.map(evidenceKey).sort(), o.entity_id, o.metric, o.accounting_scope, o.basis, o.period, o.currency, o.unit, o.value]).slice(0, 32)}`;
    observationIds.set(o.observation_id, observationId);
    const normalized: ReviewFinancialObservation = {
      observation_id: observationId,
      source_kind: source.source_kind,
      entity_id: o.entity_id,
      metric: o.metric,
      accounting_scope: o.accounting_scope,
      basis: o.basis,
      period: o.period,
      currency: o.currency,
      unit: o.unit,
      value: o.value,
      value_literal: o.value_literal,
      value_refs: valueRefs,
      context_refs: contextRefs,
    };
    const verified = verifyModelFinancialContext(normalized, input.evidence);
    if (unboundTableContext)
      return {
        ...normalized,
        context_verification: 'unverified' as const,
        context_limitations: [
          ...(verified.context_limitations ?? []),
          'financial_table_context_unbound',
        ],
      };
    if (source.locator_type === 'xlsx_cell' && source.formatting?.sheet_state !== 'visible')
      return {
        ...normalized,
        context_verification: 'unverified' as const,
        context_limitations: [
          ...(verified.context_limitations ?? []),
          'financial_worksheet_visibility_unconfirmed',
        ],
      };
    return { ...normalized, ...verified };
  });
  if (new Set(raw.calculations.map((c) => c.calculation_id)).size !== raw.calculations.length)
    return invalid('review_analysis_duplicate_calculation_id');
  const calculations = raw.calculations.map((c) => {
    const result = observationIds.get(c.result_id);
    const operands = c.operand_ids.map((id) => observationIds.get(id));
    if (!result || operands.some((id) => !id))
      return invalid('review_analysis_unknown_formula_operand');
    const resultObservation = observations.find((o) => o.observation_id === result)!;
    const operandObservations = operands.map((id) =>
      observations.find((o) => o.observation_id === id)!,
    );
    return {
      ...c,
      calculation_id: `C-${reviewContentHash([c.operation, result, operands]).slice(0, 32)}`,
      result_id: result,
      operand_ids: operands as string[],
      complete_terms:
        c.complete_terms &&
        (c.operation !== 'sum' || completeNativeSum(resultObservation, operandObservations, input)),
      relation_verification: 'unverified' as const,
    };
  });
  const compliance: ReviewComplianceInput['assessments'] = raw.compliance_assessments.map((a) => {
    const rr = ruleRefs(a.rule_keys),
      first = rr[0]!;
    if (rr.some((r) => r.pack_id !== first.pack_id || r.rule_id !== first.rule_id))
      return invalid('review_analysis_mixed_rule_assessment');
    const target_refs = refs(a.target_refs),
      evidence_refs = refs(a.evidence_refs);
    return {
      check_id: `M-${reviewContentHash([first.pack_id, first.rule_id, target_refs.map(evidenceKey).sort(), a.description]).slice(0, 32)}`,
      pack_id: first.pack_id,
      rule_id: first.rule_id,
      outcome: a.outcome,
      title: a.title,
      description: a.description,
      target_refs,
      evidence_refs,
      rule_refs: rr,
      evaluation_method: 'model',
      claims_document_absence: a.claims_document_absence,
      complete_document_examined: false,
      ...(a.suggested_change ? { suggested_change: a.suggested_change } : {}),
    };
  });
  const concerns: ReviewFindingCandidate[] = raw.concerns.map((c) => ({
    ...c,
    stable_key: `model:${reviewContentHash([c.dimension, c.stable_key, c.description]).slice(0, 32)}`,
    target_refs: refs(c.target_refs),
    evidence_refs: refs(c.evidence_refs),
    rule_refs: ruleRefs(c.rule_keys),
    suggested_change: c.suggested_change ?? undefined,
    verification: 'model_only',
    can_revise: false,
  }));
  return {
    financial: { observations, calculations },
    compliance,
    concerns,
    reviewed_record_ids: raw.reviewed_record_ids,
    limitations: raw.limitations,
  };
}

/** Hard bounds fail explicitly; no record or tail is silently truncated. */
export function chunkReviewRecords(
  records: readonly ReviewAnalysisRecord[],
  maxBytes = 64000,
  maxRecords = 120,
): ReviewAnalysisRecord[][] {
  const chunks: ReviewAnalysisRecord[][] = [];
  let current: ReviewAnalysisRecord[] = [];
  let bytes = 0;
  let material = '';
  for (const record of records) {
    const count = Buffer.byteLength(JSON.stringify(promptReviewRecord(record)));
    if (count > maxBytes) throw new ReviewAnalysisInvalid('review_record_exceeds_model_batch');
    const identity = canonical([
      record.material_id,
      record.material_version,
      record.parse_snapshot_id,
    ]);
    if (
      current.length &&
      (bytes + count > maxBytes || current.length >= maxRecords || identity !== material)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(record);
    bytes += count;
    material = identity;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
