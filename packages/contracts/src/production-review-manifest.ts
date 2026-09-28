import { Type, type Static } from '@sinclair/typebox';
import { DOCUMENT_PURPOSES, MARKETS, MARKET_OFFERINGS, OFFERINGS } from './public-enums.js';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const version = Type.String({ minLength: 1, maxLength: 128 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const nullableDate = Type.Union([date, Type.Null()]);
const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal<T[number]>(value)));
const nonEmptyCode = Type.String({ minLength: 1, maxLength: 128 });

export const PRODUCTION_REVIEW_MANIFEST_VERSION = 'production-review-content-v1' as const;
export const PRODUCTION_REVIEW_MANIFEST_HASH_DOMAIN = 'bondbuddy:production-review-content:v1' as const;
export const PRODUCTION_REVIEW_MANIFEST_CANONICALIZATION = 'utf8-json-sorted-object-keys-preserve-declared-array-order-v1' as const;

const componentRef = Type.Object({ id, version, sha256: hash }, { additionalProperties: false });
const sourceLocator = Type.Object({ kind: nonEmptyCode, value: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false });

const sourceDateEvidence = Type.Object({
  source_evidence_id: id,
  source_sha256: hash,
  source_kind: Type.Union([
    Type.Literal('binding_rule'), Type.Literal('interpretive_guidance'),
    Type.Literal('template'), Type.Literal('internal_method'),
  ]),
  document_revision_date: nullableDate,
  signed_date: nullableDate,
  official_publication_date: nullableDate,
  acquired_date: date,
  legal_effective_date: nullableDate,
  legal_expiry_date: nullableDate,
  legal_effective_date_basis: Type.Union([
    Type.Literal('explicit_text'), Type.Literal('publication_commencement'),
    Type.Literal('unknown'), Type.Literal('not_legal_effectivity'),
  ]),
  effective_date_derivation_evidence: Type.Array(sourceLocator, { maxItems: 20 }),
  transition_from_date: nullableDate,
  transition_until_date: nullableDate,
  transition_evidence: Type.Array(sourceLocator, { maxItems: 20 }),
  approved_method_window: Type.Union([
    Type.Null(),
    Type.Object({
      enabled_from: date,
      enabled_until: nullableDate,
      approval_evidence_id: id,
      approval_evidence_sha256: hash,
    }, { additionalProperties: false }),
  ]),
  locators: Type.Array(sourceLocator, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false, description: 'Dates retain their original semantics. Official web publication, signing, revision and acquisition dates never implicitly become legal effective dates. Internal method enablement is a separate approved window.' });

const sampleEvidence = Type.Object({
  sample_evidence_id: id,
  sample_evidence_sha256: hash,
  authorization_evidence_id: id,
  authorization_evidence_sha256: hash,
  sample_case_id: id,
  expected_outcome_sha256: hash,
  reviewed_result_sha256: hash,
}, { additionalProperties: false, description: 'Reference to an authorized real sample and its reviewed outcome; synthetic fixtures cannot satisfy this record.' });

const applicabilityScope = Type.Object({
  market: enumOf(MARKETS),
  offering: enumOf(OFFERINGS),
  instruments: Type.Array(nonEmptyCode, { minItems: 1, maxItems: 100, uniqueItems: true }),
  document_stages: Type.Array(enumOf(DOCUMENT_PURPOSES), { minItems: 1, maxItems: 2, uniqueItems: true }),
  applicable_from: nullableDate,
  applicable_until: nullableDate,
  issuer_scopes: Type.Array(nonEmptyCode, { minItems: 1, maxItems: 100, uniqueItems: true }),
  investor_scopes: Type.Array(nonEmptyCode, { minItems: 1, maxItems: 100, uniqueItems: true }),
  industry_codes: Type.Array(nonEmptyCode, { minItems: 1, maxItems: 1000, uniqueItems: true }),
  special_feature_codes: Type.Array(nonEmptyCode, { maxItems: 100, uniqueItems: true, description: 'Empty means reviewed absence of special features, not unknown.' }),
  exceptions: Type.Array(Type.Object({ code: nonEmptyCode, description: Type.String({ minLength: 1, maxLength: 2048 }), evidence_ids: Type.Array(id, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }), { maxItems: 200 }),
  uncovered_items: Type.Array(Type.Object({ code: nonEmptyCode, description: Type.String({ minLength: 1, maxLength: 2048 }), evidence_ids: Type.Array(id, { maxItems: 100 }) }, { additionalProperties: false }), { maxItems: 200 }),
}, { additionalProperties: false });

/**
 * Content-only hash input. Attestations and release events are separate append-only
 * records and must never be inserted here or included in this content hash.
 */
export const ProductionReviewContentSchema = Type.Object({
  contract_version: Type.Literal(PRODUCTION_REVIEW_MANIFEST_VERSION),
  hash_domain: Type.Literal(PRODUCTION_REVIEW_MANIFEST_HASH_DOMAIN),
  canonicalization: Type.Literal(PRODUCTION_REVIEW_MANIFEST_CANONICALIZATION),
  rule_pack: componentRef,
  chapter_template: componentRef,
  coverage_manifest: componentRef,
  applicability_scope: applicabilityScope,
  source_date_evidence: Type.Array(sourceDateEvidence, { minItems: 1, maxItems: 1000 }),
  authorized_real_sample_evidence: Type.Array(sampleEvidence, { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false, description: 'Canonical hash domain. Arrays preserve declared order; object keys are sorted. Attestations and release events are excluded.' });

/** Immutable manifest envelope. The content hash is SHA-256 over canonicalized `content` only. */
export const ProductionReviewManifestSchema = Type.Object({
  manifest_id: id,
  manifest_version: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  content_sha256: hash,
  content: ProductionReviewContentSchema,
}, { additionalProperties: false });

export const productionReviewManifestSchemas = {
  ProductionReviewManifest: ProductionReviewManifestSchema,
} as const;

export type ProductionReviewManifest = Static<typeof ProductionReviewManifestSchema>;
export type ProductionReviewContent = Static<typeof ProductionReviewContentSchema>;

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function validCalendarDate(value: string | null): boolean {
  if (value === null) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Semantic checks that JSON Schema alone cannot express. Set-like reference arrays
 * must be strictly sorted and unique before hashing; locator arrays preserve source order. */
export function validProductionReviewManifestContent(value: ProductionReviewManifest): boolean {
  const scope = value.content.applicability_scope;
  const offerings = MARKET_OFFERINGS[scope.market] as readonly string[];
  if (!offerings.includes(scope.offering)) return false;
  if (![scope.instruments, scope.issuer_scopes, scope.investor_scopes, scope.industry_codes, scope.special_feature_codes].every(sortedUnique)) return false;
  if (!scope.exceptions.every((item, index) => sortedUnique(item.evidence_ids) && (index === 0 || scope.exceptions[index - 1]!.code < item.code))) return false;
  if (!scope.uncovered_items.every((item, index) => sortedUnique(item.evidence_ids) && (index === 0 || scope.uncovered_items[index - 1]!.code < item.code))) return false;
  if (!value.content.source_date_evidence.every((item, index) => index === 0 || value.content.source_date_evidence[index - 1]!.source_evidence_id < item.source_evidence_id)) return false;
  if (!value.content.authorized_real_sample_evidence.every((item, index) => index === 0 || value.content.authorized_real_sample_evidence[index - 1]!.sample_evidence_id < item.sample_evidence_id)) return false;
  const sourceIds = value.content.source_date_evidence.map(source => source.source_evidence_id);
  const sampleIds = value.content.authorized_real_sample_evidence.map(sample => sample.sample_evidence_id);
  const knownEvidence = new Set([...sourceIds, ...sampleIds]);
  if (scope.exceptions.some(item => item.evidence_ids.some(id => !knownEvidence.has(id))) ||
      scope.uncovered_items.some(item => item.evidence_ids.some(id => !knownEvidence.has(id)))) return false;
  const dates = [scope.applicable_from, scope.applicable_until, ...value.content.source_date_evidence.flatMap(source => [
    source.document_revision_date, source.signed_date, source.official_publication_date, source.acquired_date,
    source.legal_effective_date, source.legal_expiry_date, source.transition_from_date, source.transition_until_date,
    source.approved_method_window?.enabled_from ?? null, source.approved_method_window?.enabled_until ?? null,
  ])];
  if (dates.some(dateValue => !validCalendarDate(dateValue))) return false;
  if (scope.applicable_from && scope.applicable_until && scope.applicable_from > scope.applicable_until) return false;
  for (const source of value.content.source_date_evidence) {
    if (source.transition_from_date && source.transition_until_date && source.transition_from_date > source.transition_until_date) return false;
    if (source.legal_expiry_date && source.legal_effective_date && source.legal_expiry_date < source.legal_effective_date) return false;
    if (source.legal_effective_date_basis === 'publication_commencement') {
      if (source.source_kind !== 'binding_rule' || !source.official_publication_date ||
          source.legal_effective_date !== source.official_publication_date || source.effective_date_derivation_evidence.length === 0) return false;
    }
    if (source.legal_effective_date_basis === 'explicit_text') {
      if (source.source_kind !== 'binding_rule' || !source.legal_effective_date || source.effective_date_derivation_evidence.length === 0) return false;
    }
    if (source.legal_effective_date_basis === 'unknown' || source.legal_effective_date_basis === 'not_legal_effectivity') {
      if (source.legal_effective_date !== null) return false;
    }
    if (source.source_kind !== 'binding_rule' && source.legal_effective_date !== null) return false;
    if (source.source_kind === 'internal_method') {
      if (source.legal_effective_date_basis !== 'not_legal_effectivity' || source.approved_method_window === null) return false;
    } else if (source.approved_method_window !== null) return false;
  }
  return true;
}

/** Backwards-readable alias emphasizing the primary semantic requirement. */
export const validProductionReviewManifestDates = validProductionReviewManifestContent;
