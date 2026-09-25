import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  evaluateRulePackCapability,
  rulePackContentHash,
  validateRulePackCompanions,
  type RulePack,
} from '@bondbuddy/domain';
import type { ChapterTemplate, CoverageManifest } from '@bondbuddy/domain';
import type { Market, Offering } from '@bondbuddy/contracts';

export type ProductionRulePackRequest = {
  readonly market: Market;
  readonly offering: Offering;
  readonly instrument: string;
  readonly documentStage: 'registration' | 'issuance';
  readonly issuerScope: string;
  readonly investorScope?: string | null;
  readonly industry?: string | null;
  readonly specialFeatures?: readonly string[] | null;
  readonly asOf: string;
};

export type ProductionRulePackPin = {
  readonly releaseEventId: string;
  readonly packId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly templateHash: string;
  readonly coverageId: string;
  readonly coverageVersion: string;
  readonly coverageHash: string;
  readonly sourceCheckIds: readonly string[];
  readonly sampleEvidenceIds: readonly string[];
  readonly market: Market;
  readonly offering: Offering;
  readonly instrument: string;
  readonly documentStage: 'registration' | 'issuance';
  readonly asOf: string;
};

export type ProductionRulePackSelection =
  | { readonly status: 'selected'; readonly pin: ProductionRulePackPin; readonly pack: RulePack; readonly template: ChapterTemplate; readonly coverage: CoverageManifest }
  | { readonly status: 'blocked'; readonly reasons: readonly ProductionRulePackBlockReason[] };

export type ProductionRulePackBlockReason =
  | 'invalid_selection_context'
  | 'production_rule_pack_registry_empty'
  | 'production_rule_pack_withdrawn'
  | 'production_rule_pack_not_effective'
  | 'production_rule_pack_source_not_current'
  | 'production_rule_pack_evidence_missing'
  | 'production_rule_pack_reviewer_grant_inactive'
  | 'production_rule_pack_capability_not_ready'
  | 'production_rule_pack_snapshot_invalid'
  | 'production_rule_pack_scope_mismatch'
  | 'production_rule_pack_ambiguous';

type ProductionRulePackRow = Record<string, unknown> & {
  id: string;
  pack_id: string;
  action: string;
  pack_version: string;
  content_hash: string;
  market: string;
  offering: string;
  instruments: string[];
  document_stages: string[];
  effective_from: string | Date;
  effective_to: string | Date | null;
  pack_snapshot: unknown;
  source_check_ids: string[];
  sample_evidence_ids: string[];
  template_version: string;
  template_hash: string;
  coverage_version: string;
  coverage_hash: string;
  operator_user_id: string;
  operator_grant_id: string;
  industry_reviewer_user_id: string | null;
  industry_reviewer_grant_id: string | null;
  technical_reviewer_user_id: string | null;
  technical_reviewer_grant_id: string | null;
  template_snapshot: unknown;
  coverage_snapshot: unknown;
};

const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function snapshotHash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function dateText(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

/** Mirrors the business gates in domain.publishRulePack for persisted snapshots. */
function isPublishableProductionPack(pack: RulePack): boolean {
  const releaseAt = pack.release?.released_at;
  if (!releaseAt || !Number.isFinite(Date.parse(releaseAt))) return false;
  const releaseDate = releaseAt.slice(0, 10);
  if (pack.validity.effective_to !== null && pack.validity.effective_to < releaseDate) return false;
  if (pack.sources.some((source) => source.kind === 'unverified_lead'
    || (source.effective_to !== null && source.effective_to < releaseDate)
    || (source.verified_at !== null && Date.parse(source.verified_at) > Date.parse(releaseAt)))) return false;
  if (pack.rules.some((rule) => !rule.enabled || rule.enforcement === 'research_only')) return false;
  if (pack.sample_suite.cases.some((sample) => sample.result !== 'passed'
    || Date.parse(sample.reviewed_at) > Date.parse(releaseAt))) return false;
  if (!(['positive', 'negative', 'boundary'] as const).every((polarity) =>
    pack.sample_suite.cases.some((sample) => sample.polarity === polarity))) return false;
  if (pack.reviews.some((review) => Date.parse(review.reviewed_at) > Date.parse(releaseAt))) return false;
  return true;
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validContext(input: ProductionRulePackRequest): boolean {
  return typeof input.market === 'string' && typeof input.offering === 'string'
    && typeof input.instrument === 'string' && input.instrument.trim().length > 0
    && (input.documentStage === 'registration' || input.documentStage === 'issuance')
    && typeof input.issuerScope === 'string' && input.issuerScope.trim().length > 0
    && validDate(input.asOf);
}

function mapAndValidate(row: ProductionRulePackRow): RulePack | null {
  const coverage = parseJson(row.coverage_snapshot) as CoverageManifest;
  const checked = validateRulePackCompanions(parseJson(row.pack_snapshot),
    parseJson(row.template_snapshot) as ChapterTemplate, coverage);
  if (!checked.ok || coverage.open_blockers.length > 0 || coverage.items.some((item) => item.disposition === 'uncovered')) return null;
  const pack = checked.pack;
  const industryReview = pack.reviews.find((review) => review.reviewer_role === 'industry_reviewer'
    && review.reviewer_id === row.industry_reviewer_user_id && review.source_verified && review.scope_verified && review.samples_verified);
  const technicalReview = pack.reviews.find((review) => review.reviewer_role === 'technical_reviewer'
    && review.reviewer_id === row.technical_reviewer_user_id && review.source_verified && review.scope_verified && review.samples_verified);
  if (row.action !== 'production_release' && row.action !== 'production_rollback') return null;
  if (pack.status !== 'published' || pack.release?.channel !== 'production'
    || pack.pack_id !== row.pack_id || pack.version !== row.pack_version
    || pack.release.content_hash !== row.content_hash || !HASH.test(row.content_hash)
    || pack.validity.published_on !== pack.release.released_at.slice(0, 10)
    || rulePackContentHash(pack) !== row.content_hash
    || pack.scope.market !== row.market || pack.scope.offering !== row.offering
    || JSON.stringify(pack.scope.instruments) !== JSON.stringify(row.instruments)
    || JSON.stringify(pack.scope.document_stages) !== JSON.stringify(row.document_stages)
    || pack.validity.effective_from !== dateText(row.effective_from)
    || pack.validity.effective_to !== dateText(row.effective_to)
    || checked.template.version !== row.template_version || snapshotHash(checked.template) !== row.template_hash
    || checked.coverage.version !== row.coverage_version || snapshotHash(checked.coverage) !== row.coverage_hash
    || pack.sample_suite.data_classification !== 'authorized_real'
    || !isPublishableProductionPack(pack)
    || !industryReview || !technicalReview || industryReview.reviewer_id === technicalReview.reviewer_id) return null;
  return pack;
}

/**
 * Resolves a production release from the append-only production registry only.
 * Test-channel events are never queried or accepted. All release evidence is
 * rechecked for the requested as-of date so an old pin cannot revive stale rules.
 */
export async function selectProductionRulePack(
  pool: Pick<Pool, 'query'>,
  input: ProductionRulePackRequest,
): Promise<ProductionRulePackSelection> {
  if (!validContext(input)) return { status: 'blocked', reasons: ['invalid_selection_context'] };

  const result = await pool.query<ProductionRulePackRow>(`
    WITH latest AS (
      SELECT DISTINCT ON (pack_id) id,pack_id,action,pack_version,content_hash,market,offering,
        instruments,document_stages,effective_from,effective_to,pack_snapshot,template_snapshot,coverage_snapshot,
        source_check_ids,sample_evidence_ids,template_version,template_hash,coverage_version,coverage_hash,
        operator_user_id,operator_grant_id,industry_reviewer_user_id,industry_reviewer_grant_id,
        technical_reviewer_user_id,technical_reviewer_grant_id
      FROM bb_rule_pack_production_release_events
      ORDER BY pack_id,sequence DESC
    )
    SELECT * FROM latest`, []);
  const rows = result.rows;
  if (rows.length === 0) return { status: 'blocked', reasons: ['production_rule_pack_registry_empty'] };

  let withdrawn = false;
  let notEffective = false;
  let sourceNotCurrent = false;
  let evidenceMissing = false;
  let reviewerGrantInactive = false;
  let capabilityNotReady = false;
  let snapshotInvalid = false;
  let scopeMismatch = false;
  const matches: Array<{ row: ProductionRulePackRow; pack: RulePack }> = [];

  for (const row of rows) {
    if (row.action === 'production_withdrawal') {
      if (row.market === input.market && row.offering === input.offering) withdrawn = true;
      continue;
    }
    if (row.market !== input.market || row.offering !== input.offering) continue;
    const pack = mapAndValidate(row);
    if (!pack) { snapshotInvalid = true; continue; }
    if (input.asOf < pack.validity.effective_from || (pack.validity.effective_to && input.asOf > pack.validity.effective_to)) {
      notEffective = true;
      continue;
    }

    const proof = await pool.query<{ reviewers_active: boolean; sources_current: boolean; samples_complete: boolean }>(`
      SELECT
        EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants g
          WHERE g.id=$10 AND g.user_id=$11 AND g.role='rule_pack_operator' AND g.market=$5 AND g.offering=$6 AND g.revoked_at IS NULL
            AND g.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz)
        AND EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants g
          WHERE g.id=$12 AND g.user_id=$13 AND g.role='rule_pack_industry_reviewer' AND g.market=$5 AND g.offering=$6 AND g.revoked_at IS NULL
            AND g.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz)
        AND EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants g
          WHERE g.id=$14 AND g.user_id=$15 AND g.role='rule_pack_technical_reviewer' AND g.market=$5 AND g.offering=$6 AND g.revoked_at IS NULL
            AND g.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz)
        AS reviewers_active,
        cardinality($1::text[]) > 0
        AND cardinality($1::text[]) = (
          SELECT count(*)::int FROM bb_rule_pack_production_source_checks s
          JOIN bb_rule_pack_production_reviewer_grants g ON g.id=s.verifier_grant_id AND g.user_id=s.verifier_user_id
          WHERE s.id=ANY($1::text[]) AND s.pack_id=$2 AND s.pack_version=$3 AND s.pack_hash=$4
            AND s.market=$5 AND s.offering=$6 AND s.checked_at <= ($7::date + interval '1 day')
            AND s.checked_at<=($8::jsonb->'release'->>'released_at')::timestamptz
            AND s.created_at<=($8::jsonb->'release'->>'released_at')::timestamptz
            AND s.effective_from <= $7::date AND (s.effective_to IS NULL OR s.effective_to >= $7::date)
            AND g.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz
            AND g.role='rule_pack_industry_reviewer' AND g.revoked_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements($8::jsonb->'sources') src
          WHERE NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_source_checks s
            JOIN bb_rule_pack_production_reviewer_grants g ON g.id=s.verifier_grant_id AND g.user_id=s.verifier_user_id
            WHERE s.id=ANY($1::text[]) AND s.pack_id=$2 AND s.pack_version=$3 AND s.pack_hash=$4
              AND s.market=$5 AND s.offering=$6 AND s.source_id=src->>'source_id'
              AND s.authority=src->>'authority' AND s.official_url=src->>'official_url'
              AND s.source_version=src->>'source_version' AND s.document_hash IS NOT DISTINCT FROM NULLIF(src->>'document_hash','')::char(64)
              AND s.clause_locator=src->>'clause_locator' AND s.exact_quote=src->>'exact_quote'
              AND s.effective_from IS NOT DISTINCT FROM NULLIF(src->>'effective_from','')::date
              AND s.effective_to IS NOT DISTINCT FROM NULLIF(src->>'effective_to','')::date
              AND s.checked_at <= ($7::date + interval '1 day') AND s.effective_from <= $7::date
              AND s.checked_at<=($8::jsonb->'release'->>'released_at')::timestamptz
              AND s.created_at<=($8::jsonb->'release'->>'released_at')::timestamptz
              AND (s.effective_to IS NULL OR s.effective_to >= $7::date)
              AND g.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz
              AND g.role='rule_pack_industry_reviewer' AND g.revoked_at IS NULL)
        ) AS sources_current,
        cardinality($9::text[]) >= 3
        AND cardinality($9::text[]) = (
          SELECT count(*)::int FROM bb_rule_pack_production_sample_evidence s
          JOIN bb_rule_pack_production_reviewer_grants g ON g.id=s.reviewer_grant_id AND g.user_id=s.reviewer_user_id
          JOIN bb_rule_pack_sample_authorizations a ON a.id=s.authorization_id AND a.material_sha256=s.material_sha256
            AND a.market=s.market AND a.offering=s.offering
          JOIN bb_rule_pack_production_reviewer_grants ag ON ag.id=a.authorizer_grant_id AND ag.user_id=a.authorized_by_user_id
          WHERE s.id=ANY($9::text[]) AND s.pack_id=$2 AND s.pack_version=$3 AND s.pack_hash=$4
            AND s.market=$5 AND s.offering=$6 AND a.authorization_scope='rule_pack_validation' AND a.revoked_at IS NULL
            AND ag.role='rule_pack_operator' AND ag.market=$5 AND ag.offering=$6 AND ag.revoked_at IS NULL
            AND a.authorized_at<=($8::jsonb->'release'->>'released_at')::timestamptz
            AND s.reviewed_at<=($8::jsonb->'release'->>'released_at')::timestamptz
            AND g.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz
            AND ag.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz
            AND g.role IN ('rule_pack_industry_reviewer','rule_pack_technical_reviewer') AND g.market=$5 AND g.offering=$6
            AND s.observed_outcome=s.expected_outcome AND g.revoked_at IS NULL
        )
        AND (SELECT count(DISTINCT s.polarity) FROM bb_rule_pack_production_sample_evidence s
          JOIN bb_rule_pack_sample_authorizations a ON a.id=s.authorization_id AND a.material_sha256=s.material_sha256
            AND a.market=s.market AND a.offering=s.offering
          JOIN bb_rule_pack_production_reviewer_grants ag ON ag.id=a.authorizer_grant_id AND ag.user_id=a.authorized_by_user_id
          WHERE s.id=ANY($9::text[]) AND s.pack_id=$2 AND s.pack_version=$3 AND s.pack_hash=$4
            AND s.market=$5 AND s.offering=$6 AND a.authorization_scope='rule_pack_validation' AND a.revoked_at IS NULL
            AND ag.role='rule_pack_operator' AND ag.market=$5 AND ag.offering=$6 AND ag.revoked_at IS NULL)=3
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($8::jsonb->'sample_suite'->'cases') c
          WHERE NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_sample_evidence s
            JOIN bb_rule_pack_production_reviewer_grants g ON g.id=s.reviewer_grant_id AND g.user_id=s.reviewer_user_id
            JOIN bb_rule_pack_sample_authorizations a ON a.id=s.authorization_id AND a.material_sha256=s.material_sha256
              AND a.market=s.market AND a.offering=s.offering
            JOIN bb_rule_pack_production_reviewer_grants ag ON ag.id=a.authorizer_grant_id AND ag.user_id=a.authorized_by_user_id
            WHERE s.id=ANY($9::text[]) AND s.pack_id=$2 AND s.pack_version=$3 AND s.pack_hash=$4
              AND s.market=$5 AND s.offering=$6 AND s.sample_case_id=c->>'case_id' AND s.polarity=c->>'polarity'
              AND s.expected_outcome=c->>'expected_outcome' AND c->>'result'='passed'
              AND s.reviewer_user_id=c->>'reviewed_by' AND g.role IN ('rule_pack_industry_reviewer','rule_pack_technical_reviewer')
              AND g.market=$5 AND g.offering=$6 AND g.revoked_at IS NULL
              AND a.authorization_scope='rule_pack_validation' AND a.revoked_at IS NULL
              AND ag.role='rule_pack_operator' AND ag.market=$5 AND ag.offering=$6 AND ag.revoked_at IS NULL
              AND a.authorized_at<=($8::jsonb->'release'->>'released_at')::timestamptz
              AND s.reviewed_at<=($8::jsonb->'release'->>'released_at')::timestamptz
              AND g.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz
              AND ag.granted_at<=($8::jsonb->'release'->>'released_at')::timestamptz))
        AND jsonb_array_length($8::jsonb->'sample_suite'->'cases')=cardinality($9::text[])
        AS samples_complete`, [row.source_check_ids, row.pack_id, row.pack_version, row.content_hash,
      row.market, row.offering, input.asOf, JSON.stringify(pack), row.sample_evidence_ids,
      row.operator_grant_id, row.operator_user_id, row.industry_reviewer_grant_id, row.industry_reviewer_user_id,
      row.technical_reviewer_grant_id, row.technical_reviewer_user_id]);
    const verified = proof.rows[0];
    if (!verified?.reviewers_active) { reviewerGrantInactive = true; continue; }
    if (!verified?.sources_current) { sourceNotCurrent = true; continue; }
    if (!verified.samples_complete) { evidenceMissing = true; continue; }

    const decision = evaluateRulePackCapability(pack, {
      market: input.market,
      offering: input.offering,
      document_stage: input.documentStage,
      issuer_scope: input.issuerScope,
      instrument: input.instrument,
      investor_scope: input.investorScope,
      industry: input.industry,
      special_features: input.specialFeatures == null ? null : [...input.specialFeatures],
      as_of: input.asOf,
    });
    const template = parseJson(row.template_snapshot) as ChapterTemplate;
    if (!template.document_stages.includes(input.documentStage)) {
      scopeMismatch = true;
      continue;
    }
    const coverage = parseJson(row.coverage_snapshot) as CoverageManifest;
    const stageCoverage = coverage.items.filter((item) => item.document_stages.includes(input.documentStage));
    if (!stageCoverage.some((item) => item.disposition === 'covered')
      || stageCoverage.some((item) => item.disposition === 'uncovered')) {
      scopeMismatch = true;
      continue;
    }
    if (decision.decision !== 'eligible_for_evaluation') {
      if (decision.decision === 'not_applicable') scopeMismatch = true;
      else capabilityNotReady = true;
      continue;
    }
    matches.push({ row, pack });
  }

  if (matches.length > 1) return { status: 'blocked', reasons: ['production_rule_pack_ambiguous'] };
  const selected = matches[0];
  if (selected) return {
    status: 'selected',
    template: parseJson(selected.row.template_snapshot) as ChapterTemplate,
    coverage: parseJson(selected.row.coverage_snapshot) as CoverageManifest,
    pin: {
      releaseEventId: selected.row.id,
      packId: selected.row.pack_id,
      version: selected.row.pack_version,
      contentHash: selected.row.content_hash,
      templateId: (parseJson(selected.row.template_snapshot) as ChapterTemplate).template_id,
      templateVersion: (parseJson(selected.row.template_snapshot) as ChapterTemplate).version,
      templateHash: snapshotHash(parseJson(selected.row.template_snapshot)),
      coverageId: (parseJson(selected.row.coverage_snapshot) as CoverageManifest).manifest_id,
      coverageVersion: (parseJson(selected.row.coverage_snapshot) as CoverageManifest).version,
      coverageHash: snapshotHash(parseJson(selected.row.coverage_snapshot)),
      sourceCheckIds: [...selected.row.source_check_ids],
      sampleEvidenceIds: [...selected.row.sample_evidence_ids],
      market: input.market,
      offering: input.offering,
      instrument: input.instrument,
      documentStage: input.documentStage,
      asOf: input.asOf,
    },
    pack: selected.pack,
  };

  const reasons: ProductionRulePackBlockReason[] = [];
  if (withdrawn) reasons.push('production_rule_pack_withdrawn');
  if (notEffective) reasons.push('production_rule_pack_not_effective');
  if (sourceNotCurrent) reasons.push('production_rule_pack_source_not_current');
  if (evidenceMissing) reasons.push('production_rule_pack_evidence_missing');
  if (reviewerGrantInactive) reasons.push('production_rule_pack_reviewer_grant_inactive');
  if (capabilityNotReady) reasons.push('production_rule_pack_capability_not_ready');
  if (snapshotInvalid) reasons.push('production_rule_pack_snapshot_invalid');
  if (scopeMismatch) reasons.push('production_rule_pack_scope_mismatch');
  return { status: 'blocked', reasons: reasons.length ? reasons : ['production_rule_pack_scope_mismatch'] };
}
