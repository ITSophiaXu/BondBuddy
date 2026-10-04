import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { ReviewEvidenceRefSchema, ReviewRuleRefSchema,
  type ReviewEvidenceRef, type ReviewRuleRef } from '../../contracts/dist/review-results.js';

/** Constructed from authenticated, immutable parse storage, never from model output. */
export interface TrustedReviewRecord extends Omit<ReviewEvidenceRef, 'quote'> {
  owner_user_id: string; project_id: string; literal_quote: string;
}
export interface ReviewEvidenceContext {
  owner_user_id: string; project_id: string; report_id: string;
  source_material: { material_id: string; material_version: number; sha256: string };
  records: readonly TrustedReviewRecord[];
  /** Trusted rule adapter has already checked current release, scope, date and withdrawal. */
  rules: readonly ReviewRuleRef[];
}
export const reviewContentHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const evidenceKey = (ref: Pick<ReviewEvidenceRef, 'material_id'|'material_version'|'material_sha256'|'parse_snapshot_id'|'parse_response_sha256'|'record_id'|'record_sha256'>): string => canonical([
  ref.material_id, ref.material_version, ref.material_sha256, ref.parse_snapshot_id,
  ref.parse_response_sha256, ref.record_id, ref.record_sha256,
]);
export function uniqueEvidence(refs: readonly ReviewEvidenceRef[]): ReviewEvidenceRef[] {
  const result = new Map<string, ReviewEvidenceRef>();
  for (const ref of refs) result.set(canonical(ref), ref);
  return [...result.values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

export function validReviewLocator(ref: Pick<ReviewEvidenceRef, 'locator_type' | 'locator'>): boolean {
  const l = ref.locator;
  if (!l || typeof l !== 'object' || !Object.keys(l).length) return false;
  const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
  switch (ref.locator_type) {
    case 'docx_block': return typeof l.stable_ref === 'string' && !!l.stable_ref.trim()
      && Array.isArray(l.path) && l.path.length > 0 && l.path.every(part => typeof part === 'object' && part !== null
        && Object.entries(part).length > 0 && Object.entries(part).every(([key, value]) => ['paragraph','table','row','column'].includes(key) && positive(value)));
    case 'xlsx_cell': return typeof l.sheet === 'string' && !!l.sheet.trim() && typeof l.cell === 'string' && /^[A-Z]{1,3}[1-9]\d*$/.test(l.cell);
    case 'csv_cell': return positive(l.row) && positive(l.column);
    case 'text_line': return positive(l.line);
    case 'pdf_bbox': {
      if (!positive(l.page) || typeof l.bbox !== 'object' || l.bbox === null) return false;
      const box = l.bbox as Record<string, unknown>;
      return [box.x0, box.top, box.x1, box.bottom].every(n => typeof n === 'number' && Number.isFinite(n))
        && Number(box.x1) > Number(box.x0) && Number(box.bottom) > Number(box.top);
    }
    case 'ocr_bbox': return positive(l.page) && Array.isArray(l.bbox) && l.bbox.length === 4
      && l.bbox.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      && l.bbox[2] > l.bbox[0] && l.bbox[3] > l.bbox[1];
  }
}

export function validateReviewEvidence(ref: unknown, ctx: ReviewEvidenceContext, target = false): string[] {
  if (!Value.Check(ReviewEvidenceRefSchema, ref)) return ['evidence_schema_invalid'];
  if (!validReviewLocator(ref)) return ['evidence_locator_invalid'];
  const key = evidenceKey(ref);
  // Parser IDs and material IDs are required string pins. Exclude unrelated records
  // before canonicalizing the full pin; long reviews otherwise serialize the entire
  // material set for every citation and can starve the worker lease heartbeat.
  // Still collect all matching pins, so duplicates remain ambiguous. No cached index
  // survives this call: later owner, pin, quote and locator mutations are rechecked.
  const matches = ctx.records.filter(record => record.owner_user_id === ctx.owner_user_id && record.project_id === ctx.project_id
    && record.record_id === ref.record_id && record.material_id === ref.material_id && evidenceKey(record) === key);
  return validateMatchedEvidence(ref, ctx, matches, target);
}

/** Synchronous batch boundary: build one scope-bound index, retaining ambiguous pins.
 * No index survives the call, so a later mutation cannot reuse stale validation.
 */
export function validateReviewEvidenceBatch(refs: readonly unknown[], ctx: ReviewEvidenceContext, target = false): string[][] {
  const indexed = new Map<string, TrustedReviewRecord[]>();
  for (const record of ctx.records) {
    if (record.owner_user_id !== ctx.owner_user_id || record.project_id !== ctx.project_id) continue;
    const key = evidenceKey(record), matches = indexed.get(key);
    if (matches) matches.push(record); else indexed.set(key, [record]);
  }
  return refs.map(ref => {
    if (!Value.Check(ReviewEvidenceRefSchema, ref)) return ['evidence_schema_invalid'];
    if (!validReviewLocator(ref)) return ['evidence_locator_invalid'];
    return validateMatchedEvidence(ref, ctx, indexed.get(evidenceKey(ref)) ?? [], target);
  });
}

function validateMatchedEvidence(ref: ReviewEvidenceRef, ctx: ReviewEvidenceContext, matches: readonly TrustedReviewRecord[], target: boolean): string[] {
  if (matches.length !== 1) return ['evidence_pin_missing_or_ambiguous'];
  const record = matches[0]!;
  const problems: string[] = [];
  if (record.locator_type !== ref.locator_type || canonical(record.locator) !== canonical(ref.locator)) problems.push('evidence_locator_mismatch');
  if (!ref.quote.trim() || !record.literal_quote.includes(ref.quote)) problems.push('evidence_quote_mismatch');
  if (record.extraction_method !== ref.extraction_method || canonical(record.uncertainty) !== canonical(ref.uncertainty)) problems.push('evidence_uncertainty_or_method_mismatch');
  if (target && (ref.material_id !== ctx.source_material.material_id || ref.material_version !== ctx.source_material.material_version
    || ref.material_sha256 !== ctx.source_material.sha256)) problems.push('target_material_mismatch');
  return problems;
}

export function validateReviewRule(ref: unknown, ctx: ReviewEvidenceContext): string[] {
  if (!Value.Check(ReviewRuleRefSchema, ref)) return ['rule_schema_invalid'];
  const matches = ctx.rules.filter(rule => rule.rule_id === ref.rule_id && rule.rule_version === ref.rule_version
    && rule.pack_id === ref.pack_id && rule.pack_version === ref.pack_version && rule.source_id === ref.source_id);
  if (matches.length !== 1 || canonical(matches[0]) !== canonical(ref)) return ['rule_pin_or_quote_mismatch'];
  return [];
}

export function referenceFor(record: TrustedReviewRecord, quote = record.literal_quote): ReviewEvidenceRef {
  return { material_id:record.material_id, material_version:record.material_version, material_sha256:record.material_sha256,
    parse_snapshot_id:record.parse_snapshot_id, parse_response_sha256:record.parse_response_sha256,
    record_id:record.record_id, record_sha256:record.record_sha256, locator_type:record.locator_type,
    locator:structuredClone(record.locator), quote, extraction_method:record.extraction_method, uncertainty:[...record.uncertainty] };
}
