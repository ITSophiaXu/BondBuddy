import { createHash } from 'node:crypto';
import { M1_MATERIAL_PARTITIONS, type OcrReview, type ReportingPeriod } from '@bondbuddy/contracts';
import type { DocumentParseRecord, DocumentParseResponse } from './document-parser.js';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';
import { recognizeHistoricalOcr } from './historical-ocr-recognition.js';

const FINANCIAL_ROLE_CODES: ReadonlySet<string> = new Set(M1_MATERIAL_PARTITIONS.find(partition => partition.label === '财务与审计')?.roles.map(role => role.code) ?? []);
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

export type TargetPeriodAnchor =
  | { readonly kind: 'table_header' | 'entity' | 'scope'; readonly evidence: TargetPeriodEvidenceRef }
  | { readonly kind: 'period_end'; readonly evidence: TargetPeriodEvidenceRef; readonly raw_period_token: string };

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

export type TargetPeriodCandidateMaterialPin = LockedFinancialMaterialRef;
export type TargetPeriodCandidateSnapshotPin = {
  readonly method: 'native_text' | 'ocr';
  readonly snapshot_id: string;
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly response_sha256: string;
  readonly parser_version: string;
  readonly status: string;
  readonly evidence_records: readonly { readonly record_id: string; readonly record_sha256: string }[];
  readonly page_image_sha256s?: readonly { readonly page: number; readonly sha256: string }[];
};

export type TargetPeriodCandidateSet = {
  readonly status: 'needs_confirmation';
  readonly completeness: 'not_determined';
  readonly reporting_cutoff: string;
  readonly locked_material_pins: readonly TargetPeriodCandidateMaterialPin[];
  readonly source_snapshot_pins: readonly TargetPeriodCandidateSnapshotPin[];
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
  /** Preserve which original recognized period token linked each immutable evidence record. */
  readonly evidence: readonly { readonly ref: TargetPeriodEvidenceRef; readonly raw_value: string | null }[];
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
  const materialIds = new Set<string>();
  for (const material of materials) {
    if (!validId(material.material_id) || !Number.isSafeInteger(material.material_version) || material.material_version < 1 ||
        !VALID_SHA.test(material.material_sha256) || !FINANCIAL_ROLE_CODES.has(material.role)) throw fail('TARGET_PERIOD_CANDIDATE_LOCK_INVALID');
    const key = `${material.material_id}\0${material.material_version}`;
    if (map.has(key) || materialIds.has(material.material_id)) throw fail('TARGET_PERIOD_CANDIDATE_LOCK_DUPLICATE');
    map.set(key, material);
    materialIds.add(material.material_id);
  }
  if (map.size === 0) throw fail('TARGET_PERIOD_CANDIDATE_FINANCIAL_MATERIALS_REQUIRED');
  return map;
}

function nativeSnapshotPin(snapshot: NativePeriodEvidenceSnapshot): TargetPeriodCandidateSnapshotPin {
  const byId = new Map<string, string>();
  for (const item of snapshot.records) {
    const prior = byId.get(item.record_id);
    const contentHash = sha256(item);
    if (prior !== undefined && prior !== contentHash) throw fail('TARGET_PERIOD_CANDIDATE_RECORD_ID_CONFLICT');
    byId.set(item.record_id, contentHash);
  }
  return {
    method: 'native_text', snapshot_id: snapshot.snapshot_id, material_id: snapshot.material_id,
    material_version: snapshot.material_version, material_sha256: snapshot.material_sha256,
    response_sha256: snapshot.response_sha256, parser_version: snapshot.parser_version, status: snapshot.status,
    evidence_records: [...new Map(snapshot.records.map(item => [item.record_id, item.record_sha256])).entries()]
      .map(([record_id, record_sha256]) => ({ record_id, record_sha256 })).sort((a, b) => a.record_id.localeCompare(b.record_id)),
  };
}

function ocrSnapshotPin(snapshot: OcrPeriodEvidenceSnapshot): TargetPeriodCandidateSnapshotPin {
  const review = snapshot.review;
  const recordContent = new Map<string, string>();
  for (const item of review.records) {
    const prior = recordContent.get(item.record_id);
    const contentHash = sha256({ record: item, record_sha256: snapshot.record_sha256_by_id[item.record_id] ?? null });
    if (prior !== undefined && prior !== contentHash) throw fail('TARGET_PERIOD_CANDIDATE_RECORD_ID_CONFLICT');
    recordContent.set(item.record_id, contentHash);
  }
  const recordIds = new Set(review.records.map(item => item.record_id));
  if (Object.keys(snapshot.record_sha256_by_id).some(id => !recordIds.has(id)) ||
      review.records.some(item => !snapshot.record_sha256_by_id[item.record_id])) throw fail('TARGET_PERIOD_CANDIDATE_RECORD_HASH_SET_INVALID');
  const pages = new Map<number, string>();
  for (const page of review.pages) {
    const prior = pages.get(page.page);
    if (prior !== undefined && prior !== page.image_sha256) throw fail('TARGET_PERIOD_CANDIDATE_PAGE_ID_CONFLICT');
    pages.set(page.page, page.image_sha256);
  }
  return {
    method: 'ocr', snapshot_id: review.snapshot_id, material_id: review.material_id,
    material_version: review.material_version, material_sha256: snapshot.material_sha256,
    response_sha256: review.result_sha256, parser_version: snapshot.processor_version,
    status: `needs_confirmation:${review.coverage}`, evidence_records: [...recordIds].map(record_id => ({
      record_id, record_sha256: snapshot.record_sha256_by_id[record_id]!,
    })).sort((a, b) => a.record_id.localeCompare(b.record_id)),
    page_image_sha256s: [...pages.entries()].map(([page, sha256]) => ({ page, sha256 })).sort((a, b) => a.page - b.page),
  };
}

function uniqueSnapshots(snapshots: readonly TargetPeriodEvidenceSnapshot[]): {
  snapshots: TargetPeriodEvidenceSnapshot[]; pins: TargetPeriodCandidateSnapshotPin[];
} {
  const byIdentity = new Map<string, { snapshot: TargetPeriodEvidenceSnapshot; fingerprint: string; pin: TargetPeriodCandidateSnapshotPin }>();
  for (const snapshot of snapshots) {
    const pin = snapshot.method === 'native_text' ? nativeSnapshotPin(snapshot) : ocrSnapshotPin(snapshot);
    const identity = `${pin.method}\0${pin.snapshot_id}`;
    const fingerprint = sha256({ pin, snapshot });
    const prior = byIdentity.get(identity);
    if (prior && prior.fingerprint !== fingerprint) throw fail('TARGET_PERIOD_CANDIDATE_SNAPSHOT_ID_CONFLICT');
    if (!prior) byIdentity.set(identity, { snapshot, fingerprint, pin });
  }
  const values = [...byIdentity.values()].sort((a, b) => a.pin.snapshot_id.localeCompare(b.pin.snapshot_id) || a.pin.method.localeCompare(b.pin.method));
  const ids = new Set<string>();
  for (const item of values) {
    if (ids.has(item.pin.snapshot_id)) throw fail('TARGET_PERIOD_CANDIDATE_SNAPSHOT_ID_CONFLICT');
    ids.add(item.pin.snapshot_id);
  }
  return { snapshots: values.map(item => item.snapshot), pins: values.map(item => item.pin) };
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
    return { period, evidence: evidence.map(ref => ({ ref, raw_value: period.raw_value })) };
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
    return { period, evidence: evidence.map(ref => ({ ref, raw_value: period.raw_value })) };
  });
}

function makeCandidate(source: PeriodSource, cutoff: string): ProposedTargetPeriod {
  const period = source.period;
  const evidenceLinks = [...new Map(source.evidence.map(link =>
    [`${link.ref.snapshot_id}\0${link.ref.record_id}\0${link.raw_value ?? ''}`, link])).values()]
    .sort((a, b) => a.ref.material_id.localeCompare(b.ref.material_id) || a.ref.material_version - b.ref.material_version ||
      a.ref.snapshot_id.localeCompare(b.ref.snapshot_id) || a.ref.record_id.localeCompare(b.ref.record_id) ||
      String(a.raw_value ?? '').localeCompare(String(b.raw_value ?? '')));
  const evidence = [...new Map(evidenceLinks.map(link => [`${link.ref.snapshot_id}\0${link.ref.record_id}`, link.ref])).values()]
    .sort((a, b) => a.material_id.localeCompare(b.material_id) || a.material_version - b.material_version ||
      a.snapshot_id.localeCompare(b.snapshot_id) || a.record_id.localeCompare(b.record_id));
  const anchors: TargetPeriodAnchor[] = [];
  for (const { ref: item, raw_value: sourceRawValue } of evidenceLinks) {
    const text = `${item.quote}\n${item.context}`;
    if (/报告期|财务报表|财务数据|财务会计信息|审计报告|资产负债表|利润表|现金流量表/.test(text) ||
        recordIsFinancialHeader({ quote: item.quote, context: item.context, locator: item.locator })) anchors.push({ kind: 'table_header', evidence: item });
    if (recordMentionsEntity({ quote: item.quote, context: item.context })) anchors.push({ kind: 'entity', evidence: item });
    if (/合并|母公司|公司本部/.test(text)) anchors.push({ kind: 'scope', evidence: item });
    const matchedRawToken = sourceRawValue?.split('；').find(rawToken => rawToken.length > 0 && item.quote.includes(rawToken));
    const periodEndToken = matchedRawToken ?? (period.end !== null && item.quote.includes(period.end) ? period.end : null);
    if (period.end !== null && periodEndToken !== null)
      anchors.push({ kind: 'period_end', evidence: item, raw_period_token: periodEndToken });
  }
  const uniqueAnchors = [...new Map(anchors.sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.evidence.snapshot_id.localeCompare(b.evidence.snapshot_id) ||
    a.evidence.record_id.localeCompare(b.evidence.record_id) ||
    (a.kind === 'period_end' ? a.raw_period_token : '').localeCompare(b.kind === 'period_end' ? b.raw_period_token : ''))
    .map(anchor => [`${anchor.kind}\0${anchor.evidence.snapshot_id}\0${anchor.evidence.record_id}`, anchor])).values()];
  const anchorKinds = new Set(uniqueAnchors.map(anchor => anchor.kind));
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
    evidence, anchors: uniqueAnchors,
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
  const materialPins = [...locked.values()].sort((a, b) => a.material_id.localeCompare(b.material_id));
  const unique = uniqueSnapshots(options.snapshots);
  const sources = unique.snapshots.flatMap(snapshot => snapshot.method === 'native_text'
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
  const allRecords = unique.snapshots.flatMap(snapshot => snapshot.method === 'native_text'
    ? snapshot.records.map(item => ({ quote: item.literal_quote, context: item.context, locator: item.locator }))
    : snapshot.review.records.map(item => ({ quote: item.text, context: '', locator: { page: item.page, bbox: item.bbox } })));
  if (allRecords.length > 0 && !allRecords.some(item => recordIsFinancialHeader(item)))
    pending.add('financial_table_header_anchor_missing');
  if (allRecords.length > 0 && candidates.length === 0 && allRecords.some(item => recordIsFinancialHeader(item)))
    pending.add('financial_period_end_anchor_missing');
  if (candidates.some(candidate => candidate.cutoff_relation === 'after')) pending.add('candidate_period_after_reporting_cutoff');
  if (candidates.some(candidate => candidate.pending_reasons.length > 0)) pending.add('one_or_more_periods_need_review');
  if (unique.snapshots.length === 0) pending.add('period_evidence_snapshots_missing');
  if (unique.snapshots.some(snapshot => snapshot.method === 'native_text' && snapshot.status === 'failed'))
    pending.add('one_or_more_parse_snapshots_failed');
  if (unique.snapshots.some(snapshot => snapshot.method === 'native_text' && snapshot.status === 'needs_confirmation'))
    pending.add('one_or_more_parse_snapshots_need_confirmation');
  if (unique.snapshots.some(snapshot => snapshot.method === 'ocr' && snapshot.review.coverage !== 'complete'))
    pending.add('one_or_more_ocr_snapshots_have_partial_coverage');
  const sourceWarnings = [...new Set(unique.snapshots.flatMap(snapshot => snapshot.method === 'native_text'
    ? [...snapshot.warnings.map(warning => `${warning.code}:${warning.message}`), ...(snapshot.status === 'failed' ? ['parse_snapshot_failed'] : []),
      ...(snapshot.status === 'needs_confirmation' ? ['parse_snapshot_needs_confirmation'] : [])]
    : [...snapshot.review.warnings.map(warning => `ocr_warning:${warning}`), ...(snapshot.review.coverage !== 'complete' ? ['ocr_coverage_partial'] : [])]))].sort();
  const normalized = { status: 'needs_confirmation' as const, completeness: 'not_determined' as const,
    reporting_cutoff: options.reporting_cutoff, locked_material_pins: materialPins, source_snapshot_pins: unique.pins,
    candidates, source_warnings: sourceWarnings,
    pending_reasons: [...pending].sort() };
  return { ...normalized, candidate_hash: sha256({
    hash_domain: 'bondbuddy:target-period-candidate-set:v1', version: 1,
    locked_material_pins: materialPins, source_snapshot_pins: unique.pins,
    proposal: { reporting_cutoff: options.reporting_cutoff, candidates, source_warnings: sourceWarnings,
      pending_reasons: [...pending].sort(), completeness: 'not_determined', status: 'needs_confirmation' },
  }) };
}
