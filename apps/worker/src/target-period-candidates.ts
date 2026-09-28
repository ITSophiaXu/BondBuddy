import { createHash } from 'node:crypto';
import type { OcrReview, ReportingPeriod } from '@bondbuddy/contracts';
import type { DocumentParseRecord, DocumentParseResponse } from './document-parser.js';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';
import { recognizeHistoricalOcr } from './historical-ocr-recognition.js';

const FINANCIAL_ROLE_CODES = new Set(['audit', 'financial', 'interimFinancial', 'notes', 'accountDetails']);
const FINANCIAL_CONTEXT = /财务会计信息|财务报表|审计报告|资产负债表|利润表|现金流量表|主要财务数据|报告期|合并口径|母公司口径/;
const ENTITY_LABEL = /发行人(?:全称|名称)?|企业名称|公司名称|单位名称/;
const VALID_SHA = /^[a-f0-9]{64}$/;

export type LockedFinancialMaterialRef = {
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly role: string;
};

/** The fields below are projections of one immutable bb_parse_snapshots row and its evidence rows. */
export type NativePeriodEvidenceSnapshot = {
  readonly method: 'native_text';
  readonly snapshot_id: string;
  readonly response_sha256: string;
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly media_type: NonNullable<DocumentParseResponse['material']>['media_type'];
  readonly parser_version: string;
  readonly status: DocumentParseResponse['status'];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly records: readonly (DocumentParseRecord & { readonly record_sha256: string })[];
};

/** The fields below are projections of the immutable OCR snapshot/page/evidence rows. */
export type OcrPeriodEvidenceSnapshot = {
  readonly method: 'ocr';
  readonly review: OcrReview;
  readonly processor_version: string;
  readonly material_sha256: string;
  readonly record_sha256_by_id: Readonly<Record<string, string>>;
};

export type TargetPeriodEvidenceSnapshot = NativePeriodEvidenceSnapshot | OcrPeriodEvidenceSnapshot;

export type TargetPeriodEvidenceRef = {
  readonly evidence_method: 'native_text' | 'ocr';
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly snapshot_id: string;
  readonly parser_version: string;
  readonly response_sha256: string;
  readonly record_id: string;
  readonly record_sha256: string;
  readonly page?: number;
  readonly page_image_sha256?: string;
  readonly quote: string;
  readonly context: string;
  readonly locator: Record<string, unknown> | null;
  readonly uncertainty: readonly string[];
};

export type TargetPeriodAnchor = {
  readonly kind: 'table_header' | 'entity' | 'scope' | 'period_end';
  readonly evidence: TargetPeriodEvidenceRef;
};

export type ProposedTargetPeriod = {
  readonly start: string | null;
  readonly end: string | null;
  readonly period_kind: ReportingPeriod['period_kind'];
  readonly scope: ReportingPeriod['scope'];
  readonly raw_value: string | null;
  readonly status: 'needs_confirmation';
  readonly cutoff_relation: 'on_or_before' | 'after' | 'unknown';
  readonly evidence: readonly TargetPeriodEvidenceRef[];
  readonly anchors: readonly TargetPeriodAnchor[];
  readonly pending_reasons: readonly string[];
};

export type TargetPeriodCandidateSet = {
  readonly status: 'needs_confirmation';
  readonly completeness: 'not_determined';
  readonly reporting_cutoff: string;
  readonly candidates: readonly ProposedTargetPeriod[];
  /** Preserved snapshot-level warnings; not treated as selected period-anchor uncertainty. */
  readonly source_warnings: readonly string[];
  readonly pending_reasons: readonly string[];
  readonly candidate_hash: string;
};

type CandidateOptions = {
  readonly reporting_cutoff: string;
  readonly locked_materials: readonly LockedFinancialMaterialRef[];
  readonly snapshots: readonly TargetPeriodEvidenceSnapshot[];
};

type PeriodSource = {
  readonly period: ReportingPeriod;
  readonly evidence: readonly TargetPeriodEvidenceRef[];
};

function fail(code: string): Error { return new Error(code); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw fail('TARGET_PERIOD_CANDIDATE_INVALID');
  return json;
}

function sha256(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function periodKey(period: ReportingPeriod): string {
  return canonical({ start: period.start, end: period.end, period_kind: period.period_kind, scope: period.scope });
}
function recordIsFinancialHeader(source: { quote: string; context: string; locator: Record<string, unknown> | null }): boolean {
  const text = `${source.quote}\n${source.context}`;
  const locatorJson = source.locator === null ? '' : canonical(source.locator);
  return FINANCIAL_CONTEXT.test(text) || /table|worksheet|sheet/i.test(locatorJson);
}
function recordMentionsEntity(source: { quote: string; context: string }): boolean {
  const text = `${source.quote}\n${source.context}`;
  return ENTITY_LABEL.test(text) && /[:：]\s*[^\s:：]{2,}/.test(text);
}
function hasFormulaOrOcrUncertainty(items: readonly string[]): boolean {
  return items.some(item => /formula|cache|external|外链|公式|缓存|OCR|ocr|识别存疑|数字存疑/i.test(item));
}

function assertLockedMaterials(materials: readonly LockedFinancialMaterialRef[]): Map<string, LockedFinancialMaterialRef> {
  const map = new Map<string, LockedFinancialMaterialRef>();
  for (const material of materials) {
    if (!validId(material.material_id) || !Number.isSafeInteger(material.material_version) || material.material_version < 1 ||
        !VALID_SHA.test(material.material_sha256) || !FINANCIAL_ROLE_CODES.has(material.role)) throw fail('TARGET_PERIOD_CANDIDATE_LOCK_INVALID');
    const key = `${material.material_id}\0${material.material_version}`;
    if (map.has(key)) throw fail('TARGET_PERIOD_CANDIDATE_LOCK_DUPLICATE');
    map.set(key, material);
  }
  if (map.size === 0) throw fail('TARGET_PERIOD_CANDIDATE_FINANCIAL_MATERIALS_REQUIRED');
  return map;
}

function nativeSources(snapshot: NativePeriodEvidenceSnapshot, locked: Map<string, LockedFinancialMaterialRef>): PeriodSource[] {
  const key = `${snapshot.material_id}\0${snapshot.material_version}`;
  const material = locked.get(key);
  if (!material || material.material_sha256 !== snapshot.material_sha256 || !VALID_SHA.test(snapshot.response_sha256) ||
      !VALID_SHA.test(snapshot.material_sha256) || !validId(snapshot.snapshot_id) || !snapshot.parser_version.trim() ||
      snapshot.records.some(item => item.material_id !== snapshot.material_id || item.material_version !== snapshot.material_version ||
        item.content_hash !== snapshot.material_sha256 || item.extractor_version !== snapshot.parser_version ||
        !VALID_SHA.test(item.record_sha256))) {
    throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_NOT_LOCKED');
  }
  if (snapshot.status === 'failed') return [];
  const response: DocumentParseResponse = {
    schema_version: 'document-parse-response-v1', request_id: null, parser_version: snapshot.parser_version,
    // The recognition helper copies response-level warnings onto every period.
    // Those warnings are retained separately below so only record/anchor-level
    // uncertainty becomes period-specific.
    status: 'parsed',
    material: { material_id: snapshot.material_id, material_version: snapshot.material_version,
      media_type: snapshot.media_type, sha256: snapshot.material_sha256 },
    records: snapshot.records.map(({ record_sha256: _hash, ...item }) => item),
    warnings: snapshot.warnings.map(warning => ({ code: warning.code, message: warning.message })),
    document: { page_count: null }, error: null,
  };
  const recognition = recognizeHistoricalNativeText(response, { profileVersion: 1 });
  const recordsById = new Map(snapshot.records.map(item => [item.record_id, item]));
  return recognition.reporting_periods.map(period => {
    const evidence = period.provenance.evidence_refs.flatMap(id => {
      const row = recordsById.get(id);
      if (!row) return [];
      return [{ evidence_method: 'native_text' as const, material_id: snapshot.material_id,
        material_version: snapshot.material_version, material_sha256: snapshot.material_sha256, snapshot_id: snapshot.snapshot_id,
        parser_version: snapshot.parser_version, response_sha256: snapshot.response_sha256, record_id: row.record_id,
        record_sha256: row.record_sha256, quote: row.literal_quote, context: row.context, locator: row.locator,
        uncertainty: [...row.uncertainty] }];
    });
    return { period, evidence };
  });
}

function ocrSources(snapshot: OcrPeriodEvidenceSnapshot, locked: Map<string, LockedFinancialMaterialRef>): PeriodSource[] {
  const review = snapshot.review;
  const key = `${review.material_id}\0${review.material_version}`;
  const material = locked.get(key);
  if (!material || material.material_sha256 !== snapshot.material_sha256 || !VALID_SHA.test(review.result_sha256) ||
      !VALID_SHA.test(snapshot.material_sha256) || !validId(review.snapshot_id) || !snapshot.processor_version.trim() ||
      review.pages.some(page => !VALID_SHA.test(page.image_sha256)) ||
      review.records.some(item => !VALID_SHA.test(snapshot.record_sha256_by_id[item.record_id] ?? ''))) {
    throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_NOT_LOCKED');
  }
  const recognition = recognizeHistoricalOcr(review, { profileVersion: 1 });
  const recordsById = new Map(review.records.map(item => [item.record_id, item]));
  const pageHashes = new Map(review.pages.map(page => [page.page, page.image_sha256]));
  return recognition.reporting_periods.map(period => {
    const evidence = period.provenance.evidence_refs.flatMap(id => {
      const row = recordsById.get(id);
      if (!row) return [];
      const pageImageSha256 = pageHashes.get(row.page);
      if (!pageImageSha256) return [];
      return [{ evidence_method: 'ocr' as const, material_id: review.material_id,
        material_version: review.material_version, material_sha256: snapshot.material_sha256, snapshot_id: review.snapshot_id,
        parser_version: snapshot.processor_version, response_sha256: review.result_sha256, record_id: row.record_id,
        record_sha256: snapshot.record_sha256_by_id[row.record_id]!, page: row.page, page_image_sha256: pageImageSha256,
        quote: row.text, context: '', locator: { page: row.page, bbox: row.bbox }, uncertainty: [...row.uncertainty] }];
    });
    return { period, evidence };
  });
}

function makeCandidate(source: PeriodSource, cutoff: string): ProposedTargetPeriod {
  const period = source.period;
  const evidence = [...new Map(source.evidence.map(item => [`${item.snapshot_id}\0${item.record_id}`, item])).values()]
    .sort((a, b) => a.material_id.localeCompare(b.material_id) || a.material_version - b.material_version ||
      a.snapshot_id.localeCompare(b.snapshot_id) || a.record_id.localeCompare(b.record_id));
  const anchors: TargetPeriodAnchor[] = [];
  for (const item of evidence) {
    const text = `${item.quote}\n${item.context}`;
    if (/报告期|财务报表|财务数据|财务会计信息|审计报告|资产负债表|利润表|现金流量表/.test(text) ||
        recordIsFinancialHeader({ quote: item.quote, context: item.context, locator: item.locator })) anchors.push({ kind: 'table_header', evidence: item });
    if (recordMentionsEntity({ quote: item.quote, context: item.context })) anchors.push({ kind: 'entity', evidence: item });
    if (/合并|母公司|公司本部/.test(text)) anchors.push({ kind: 'scope', evidence: item });
    if (period.end !== null && (item.quote.includes(period.end.slice(0, 4)) || item.quote.includes(period.raw_value ?? '\u0000')))
      anchors.push({ kind: 'period_end', evidence: item });
  }
  const anchorKinds = new Set(anchors.map(anchor => anchor.kind));
  const reasons = new Set<string>();
  reasons.add('candidate_requires_reviewer_decision');
  for (const reason of period.uncertainty) reasons.add(reason);
  if (!anchorKinds.has('table_header')) reasons.add('missing_financial_table_header_anchor');
  if (!anchorKinds.has('entity')) reasons.add('missing_explicit_entity_anchor');
  reasons.add('issuer_identity_requires_reviewer_binding');
  if (!anchorKinds.has('scope') || period.scope === null) reasons.add('reporting_scope_unresolved');
  if (!anchorKinds.has('period_end') || period.end === null) reasons.add('period_end_anchor_missing');
  if (period.start === null || period.period_kind === null) reasons.add('period_start_or_kind_unresolved');
  if (period.end !== null && validDate(period.end) && period.end > cutoff) reasons.add('candidate_after_reporting_cutoff');
  if (evidence.some(item => hasFormulaOrOcrUncertainty(item.uncertainty)))
    reasons.add('source_contains_formula_or_ocr_uncertainty');
  return {
    start: period.start, end: period.end, period_kind: period.period_kind, scope: period.scope, raw_value: period.raw_value,
    status: 'needs_confirmation',
    cutoff_relation: period.end === null || !validDate(period.end) ? 'unknown' : period.end <= cutoff ? 'on_or_before' : 'after',
    evidence, anchors: anchors.sort((a, b) => a.kind.localeCompare(b.kind) || a.evidence.record_id.localeCompare(b.evidence.record_id)),
    pending_reasons: [...reasons].sort(),
  };
}

/**
 * Proposes periods from exact locked financial materials and immutable parser/OCR evidence.
 * This function never approves a period, verifies a subject, or interprets the cutoff as a period.
 */
export function proposeTargetReportingPeriods(options: CandidateOptions): TargetPeriodCandidateSet {
  if (!validDate(options.reporting_cutoff)) throw fail('TARGET_PERIOD_CANDIDATE_CUTOFF_INVALID');
  const locked = assertLockedMaterials(options.locked_materials);
  const sources = options.snapshots.flatMap(snapshot => snapshot.method === 'native_text'
    ? nativeSources(snapshot, locked) : ocrSources(snapshot, locked));
  const candidatesByPeriod = new Map<string, PeriodSource>();
  for (const source of sources) {
    const key = periodKey(source.period);
    const prior = candidatesByPeriod.get(key);
    if (!prior) candidatesByPeriod.set(key, source);
    else candidatesByPeriod.set(key, {
      period: { ...prior.period, raw_value: [...new Set([prior.period.raw_value, source.period.raw_value].filter((value): value is string => value !== null))].sort().join('；') || null,
        uncertainty: [...new Set([...prior.period.uncertainty, ...source.period.uncertainty])].sort(), status: 'needs_confirmation' },
      evidence: [...prior.evidence, ...source.evidence],
    });
  }
  const candidates = [...candidatesByPeriod.values()].map(source => makeCandidate(source, options.reporting_cutoff))
    .sort((a, b) => String(a.end ?? '').localeCompare(String(b.end ?? '')) || String(a.start ?? '').localeCompare(String(b.start ?? '')) ||
      String(a.scope ?? '').localeCompare(String(b.scope ?? '')) || String(a.period_kind ?? '').localeCompare(String(b.period_kind ?? '')));
  const pending = new Set<string>();
  if (candidates.length === 0) pending.add('no_evidenced_reporting_period_candidates');
  if (candidates.some(candidate => !candidate.anchors.some(anchor => anchor.kind === 'entity')))
    pending.add('issuer_identity_not_established_by_candidate_evidence');
  if (candidates.some(candidate => candidate.end === null || !candidate.anchors.some(anchor => anchor.kind === 'period_end')))
    pending.add('period_end_evidence_incomplete');
  const allRecords = options.snapshots.flatMap(snapshot => snapshot.method === 'native_text'
    ? snapshot.records.map(item => ({ quote: item.literal_quote, context: item.context, locator: item.locator }))
    : snapshot.review.records.map(item => ({ quote: item.text, context: '', locator: { page: item.page, bbox: item.bbox } })));
  if (allRecords.length > 0 && !allRecords.some(item => recordIsFinancialHeader(item)))
    pending.add('financial_table_header_anchor_missing');
  if (allRecords.length > 0 && candidates.length === 0 && allRecords.some(item => recordIsFinancialHeader(item)))
    pending.add('financial_period_end_anchor_missing');
  if (candidates.some(candidate => candidate.cutoff_relation === 'after')) pending.add('candidate_period_after_reporting_cutoff');
  if (candidates.some(candidate => candidate.pending_reasons.length > 0)) pending.add('one_or_more_periods_need_review');
  if (options.snapshots.length === 0) pending.add('period_evidence_snapshots_missing');
  if (options.snapshots.some(snapshot => snapshot.method === 'native_text' && snapshot.status === 'failed'))
    pending.add('one_or_more_parse_snapshots_failed');
  if (options.snapshots.some(snapshot => snapshot.method === 'native_text' && snapshot.status === 'needs_confirmation'))
    pending.add('one_or_more_parse_snapshots_need_confirmation');
  if (options.snapshots.some(snapshot => snapshot.method === 'ocr' && snapshot.review.coverage !== 'complete'))
    pending.add('one_or_more_ocr_snapshots_have_partial_coverage');
  const sourceWarnings = [...new Set(options.snapshots.flatMap(snapshot => snapshot.method === 'native_text'
    ? [...snapshot.warnings.map(warning => `${warning.code}:${warning.message}`), ...(snapshot.status === 'failed' ? ['parse_snapshot_failed'] : []),
      ...(snapshot.status === 'needs_confirmation' ? ['parse_snapshot_needs_confirmation'] : [])]
    : [...snapshot.review.warnings.map(warning => `ocr_warning:${warning}`), ...(snapshot.review.coverage !== 'complete' ? ['ocr_coverage_partial'] : [])]))].sort();
  const normalized = { status: 'needs_confirmation' as const, completeness: 'not_determined' as const,
    reporting_cutoff: options.reporting_cutoff, candidates, source_warnings: sourceWarnings,
    pending_reasons: [...pending].sort() };
  return { ...normalized, candidate_hash: sha256(normalized) };
}
