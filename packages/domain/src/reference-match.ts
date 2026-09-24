import { createHash } from 'node:crypto';
import { isMarketOffering, type Market, type Offering } from '@bondbuddy/contracts';

/** Internal matching inputs. These types are not API DTOs. */
export interface BusinessRevenueLine {
  readonly code: string | null;
  readonly label: string;
  readonly originalLabel: string;
  /** Base-10 decimal text, kept exact so a third-place tie is not a float artifact. */
  readonly revenue: string | null;
  /** Original business rank in the full annual revenue table. */
  readonly rank: number;
  readonly evidence: readonly string[];
  readonly classificationEvidence: readonly string[];
}

export interface AnnualBusinessProfile {
  readonly issuerId: string;
  readonly profileVersion: string;
  readonly taxonomyVersion: string;
  readonly fiscalYear: number;
  readonly completeAnnualPeriod: boolean;
  readonly latestCompleteAnnual: boolean;
  readonly verificationStatus: 'verified' | 'pending' | 'rejected';
  readonly accountingScope: 'consolidated' | 'parent' | 'mixed' | 'unknown';
  /** Same-grain, comparable revenue basis, e.g. consolidated operating revenue. */
  readonly revenueBasis: string;
  readonly currency: string;
  readonly unit: string;
  readonly allComparableBusinessLinesPresent: boolean;
  readonly sourceEvidence: readonly string[];
  readonly lines: readonly BusinessRevenueLine[];
}

export interface ReferenceTarget {
  readonly market: Market;
  readonly offering: Offering;
  readonly instrument: string;
  readonly documentStage: 'registration' | 'issuance';
  readonly ruleVersion: string;
}

export interface AcceptedChapterMapping {
  readonly status: 'accepted' | 'draft' | 'rejected';
  readonly version: string;
  readonly sourceMarket: Market;
  readonly targetMarket: Market;
  readonly sourceOffering: Offering;
  readonly targetOffering: Offering;
  readonly instrument: string;
  readonly documentStage: 'registration' | 'issuance';
  readonly ruleVersion: string;
}

export interface ReferenceCandidate {
  readonly referenceId: string;
  readonly documentVersion: string;
  readonly profile: AnnualBusinessProfile;
  readonly market: Market;
  readonly offering: Offering;
  readonly instrument: string;
  readonly documentStage: 'registration' | 'issuance';
  readonly availability: 'published' | 'pending' | 'superseded' | 'withdrawn';
  readonly readable: boolean;
  readonly useAuthorized: boolean;
  readonly sourceValidity: 'valid' | 'invalid' | 'unknown';
  readonly reviewQuality: number;
  readonly disclosedAt: string | null;
  readonly applicableScopes: readonly {
    readonly market: Market;
    readonly offering: Offering;
    readonly instrument: string;
    readonly documentStage: 'registration' | 'issuance';
    readonly ruleVersion: string;
  }[];
  readonly chapterMappings: readonly AcceptedChapterMapping[];
}

export interface ReferenceMatchInput {
  readonly targetProfile: AnnualBusinessProfile;
  readonly target: ReferenceTarget;
  readonly ruleVersion: string;
  readonly referenceIndexVersion: string;
  readonly libraryAvailable: boolean;
  readonly candidates: readonly ReferenceCandidate[];
}

export type ReferenceMatchStatus = 'exact' | 'needs_evidence' | 'needs_review' | 'no_match' | 'unavailable';

export interface ReferenceCandidateDecision {
  readonly referenceId: string;
  readonly documentVersion: string;
  readonly profileVersion: string;
  readonly reason: string;
  readonly disposition: 'matched' | 'excluded';
}

/** Internal trace only. It intentionally contains no reference issuer facts or revenue values. */
export interface ReferenceSelectionSnapshot {
  readonly schemaVersion: 'reference-selection-v1';
  readonly targetIssuerId: string;
  readonly targetProfileVersion: string;
  readonly targetTaxonomyVersion: string;
  readonly targetFiscalYear: number;
  readonly targetTop3SetKey: string | null;
  readonly targetBusinessProfile: {
    readonly accountingScope: AnnualBusinessProfile['accountingScope'];
    readonly revenueBasis: string;
    readonly currency: string;
    readonly unit: string;
    readonly topThree: readonly {
      readonly code: string;
      readonly label: string;
      readonly originalLabel: string;
      readonly revenue: string;
      readonly rank: number;
      readonly evidence: readonly string[];
      readonly classificationEvidence: readonly string[];
    }[];
  } | null;
  readonly target: ReferenceTarget;
  readonly ruleVersion: string;
  readonly referenceIndexVersion: string;
  readonly selectedReferenceId: string | null;
  readonly selectedDocumentVersion: string | null;
  readonly selectedProfileVersion: string | null;
  readonly selectedTaxonomyVersion: string | null;
  readonly chapterMappingVersion: string | null;
}

export interface ReferenceMatchResult {
  readonly status: ReferenceMatchStatus;
  readonly selectedReferenceId: string | null;
  readonly decisions: readonly ReferenceCandidateDecision[];
  readonly snapshot: ReferenceSelectionSnapshot;
  readonly reasons: readonly string[];
  readonly selectionHash: string;
}

interface ProfileInspection {
  readonly reason: string | null;
  readonly topThree: readonly { code: string; revenue: bigint; line: BusinessRevenueLine }[];
}

function decimalCoefficient(value: string | null): { coefficient: bigint; scale: number } | null {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function inspectProfile(profile: AnnualBusinessProfile): ProfileInspection {
  if (!profile.issuerId.trim() || !profile.profileVersion.trim() || !profile.taxonomyVersion.trim()) {
    return { reason: 'profile_identity_or_version_missing', topThree: [] };
  }
  if (!Number.isInteger(profile.fiscalYear) || profile.fiscalYear < 1900 || profile.fiscalYear > 9999
    || !profile.completeAnnualPeriod || !profile.latestCompleteAnnual || profile.verificationStatus !== 'verified'
    || profile.accountingScope !== 'consolidated'
    || !profile.revenueBasis.trim() || !profile.currency.trim() || !profile.unit.trim() || !profile.allComparableBusinessLinesPresent
    || profile.sourceEvidence.length === 0) {
    return { reason: 'profile_incomplete_or_not_consolidated', topThree: [] };
  }

  const seenCodes = new Set<string>();
  const normalized: { code: string; revenue: bigint; scale: number; line: BusinessRevenueLine }[] = [];
  for (const line of profile.lines) {
    const code = line.code?.trim();
    const revenue = decimalCoefficient(line.revenue);
    if (!code || !line.label.trim() || !line.originalLabel.trim() || !Number.isSafeInteger(line.rank) || line.rank < 1 || revenue === null
      || line.evidence.length === 0 || line.classificationEvidence.length === 0) {
      return { reason: 'profile_line_evidence_or_classification_missing', topThree: [] };
    }
    if (seenCodes.has(code)) return { reason: 'profile_duplicate_business_code', topThree: [] };
    seenCodes.add(code);
    normalized.push({ code, revenue: revenue.coefficient, scale: revenue.scale, line });
  }
  if (normalized.length === 0) return { reason: 'profile_lines_missing', topThree: [] };
  const commonScale = Math.max(...normalized.map((line) => line.scale));
  const ranked = normalized.map((line) => ({ ...line, revenue: line.revenue * (10n ** BigInt(commonScale - line.scale)) }))
    .sort((a, b) => a.revenue === b.revenue ? a.code.localeCompare(b.code) : a.revenue > b.revenue ? -1 : 1);
  if (ranked.length < 3) return { reason: 'profile_fewer_than_three_businesses', topThree: [] };
  if (ranked[2]!.revenue === ranked[3]?.revenue) {
    return { reason: 'third_place_revenue_tie', topThree: [] };
  }
  return { reason: null, topThree: ranked.slice(0, 3) };
}

function canonicalSet(codes: readonly string[]): string {
  // JSON array framing prevents delimiters inside an approved taxonomy code
  // from creating a false exact match with a different three-code set.
  return JSON.stringify([...codes].sort((a, b) => a.localeCompare(b)));
}

function validScope(market: Market, offering: Offering): boolean {
  return isMarketOffering(market, offering);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function acceptedMapping(candidate: ReferenceCandidate, target: ReferenceTarget, ruleVersion: string): AcceptedChapterMapping | null {
  if (candidate.market === target.market && candidate.offering === target.offering) return null;
  return candidate.chapterMappings.find((mapping) => mapping.status === 'accepted' && mapping.version.trim() !== ''
    && mapping.sourceMarket === candidate.market && mapping.targetMarket === target.market
    && mapping.sourceOffering === candidate.offering && mapping.targetOffering === target.offering
    && mapping.instrument === target.instrument && mapping.documentStage === target.documentStage
    && mapping.ruleVersion === ruleVersion) ?? null;
}

function eligibilityReason(candidate: ReferenceCandidate, target: ReferenceTarget, ruleVersion: string): string | null {
  if (candidate.availability !== 'published') return `reference_${candidate.availability}`;
  if (!candidate.readable) return 'reference_not_readable';
  if (!candidate.useAuthorized) return 'reference_use_not_authorized';
  if (candidate.sourceValidity !== 'valid') return `reference_source_${candidate.sourceValidity}`;
  if (!validScope(candidate.market, candidate.offering) || !validScope(target.market, target.offering)) return 'market_offering_invalid';
  if (!candidate.referenceId.trim() || !candidate.instrument.trim() || !candidate.documentVersion.trim()) return 'reference_scope_or_version_missing';
  // Applicable scopes describe approved rules, not a conversion of the source
  // document into a different debt instrument or registration/issuance stage.
  if (candidate.instrument !== target.instrument || candidate.documentStage !== target.documentStage) {
    return 'reference_instrument_or_stage_mismatch';
  }
  if (!Number.isFinite(candidate.reviewQuality) || candidate.reviewQuality < 0
    || (candidate.disclosedAt !== null && !validDate(candidate.disclosedAt))) return 'reference_metadata_invalid';
  const mapping = acceptedMapping(candidate, target, ruleVersion);
  if (!mapping && candidate.market !== target.market) return 'cross_market_chapter_mapping_not_accepted';
  if (!mapping && candidate.offering !== target.offering) return 'cross_offering_chapter_mapping_not_accepted';
  const targetRuleApplies = candidate.applicableScopes.some((scope) => scope.market === target.market
    && scope.offering === target.offering && scope.instrument === target.instrument
    && scope.documentStage === target.documentStage && scope.ruleVersion === ruleVersion);
  if (!targetRuleApplies) return 'target_rule_scope_not_applicable';
  return null;
}

function preference(candidate: ReferenceCandidate, target: ReferenceTarget): readonly number[] {
  return [
    candidate.market === target.market ? 0 : 1,
    candidate.offering === target.offering ? 0 : 1,
    candidate.instrument === target.instrument ? 0 : 1,
    candidate.documentStage === target.documentStage ? 0 : 1,
    candidate.sourceValidity === 'valid' ? 0 : 1,
    -candidate.reviewQuality,
    candidate.disclosedAt ? -Date.parse(candidate.disclosedAt) : Number.POSITIVE_INFINITY,
  ];
}

function compareCandidates(a: ReferenceCandidate, b: ReferenceCandidate, target: ReferenceTarget): number {
  const aRank = preference(a, target);
  const bRank = preference(b, target);
  for (let i = 0; i < aRank.length; i += 1) {
    if (aRank[i] !== bRank[i]) return aRank[i]! - bRank[i]!;
  }
  return a.referenceId.localeCompare(b.referenceId) || a.documentVersion.localeCompare(b.documentVersion);
}

function compareDecisions(a: ReferenceCandidateDecision, b: ReferenceCandidateDecision): number {
  return a.referenceId.localeCompare(b.referenceId)
    || a.documentVersion.localeCompare(b.documentVersion)
    || a.profileVersion.localeCompare(b.profileVersion);
}

function snapshot(
  input: ReferenceMatchInput,
  top3SetKey: string | null,
  topThree: ProfileInspection['topThree'] | null,
  selected: ReferenceCandidate | null,
  mapping: AcceptedChapterMapping | null,
): ReferenceSelectionSnapshot {
  return {
    schemaVersion: 'reference-selection-v1',
    targetIssuerId: input.targetProfile.issuerId,
    targetProfileVersion: input.targetProfile.profileVersion,
    targetTaxonomyVersion: input.targetProfile.taxonomyVersion,
    targetFiscalYear: input.targetProfile.fiscalYear,
    targetTop3SetKey: top3SetKey,
    targetBusinessProfile: topThree ? {
      accountingScope: input.targetProfile.accountingScope,
      revenueBasis: input.targetProfile.revenueBasis,
      currency: input.targetProfile.currency,
      unit: input.targetProfile.unit,
      topThree: topThree.map(({ line }) => ({
        code: line.code!, label: line.label, originalLabel: line.originalLabel,
        revenue: line.revenue!, rank: line.rank,
        evidence: [...line.evidence], classificationEvidence: [...line.classificationEvidence],
      })),
    } : null,
    target: input.target,
    ruleVersion: input.ruleVersion,
    referenceIndexVersion: input.referenceIndexVersion,
    selectedReferenceId: selected?.referenceId ?? null,
    selectedDocumentVersion: selected?.documentVersion ?? null,
    selectedProfileVersion: selected?.profile.profileVersion ?? null,
    selectedTaxonomyVersion: selected?.profile.taxonomyVersion ?? null,
    chapterMappingVersion: mapping?.version ?? null,
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function result(fields: Omit<ReferenceMatchResult, 'selectionHash'>): ReferenceMatchResult {
  const selectionHash = createHash('sha256').update(canonical(fields)).digest('hex');
  return { ...fields, selectionHash };
}

/**
 * Conservative internal-only matching. A returned exact status means an exact
 * three-code set and a usable reference were found; it is not an issuer fact or
 * a compliance conclusion. The caller must still isolate copied reference text.
 */
export function matchBusinessReferences(input: ReferenceMatchInput): ReferenceMatchResult {
  const targetInspection = inspectProfile(input.targetProfile);
  const emptySnapshot = snapshot(input, null, null, null, null);
  if (targetInspection.reason) {
    const status: ReferenceMatchStatus = targetInspection.reason === 'third_place_revenue_tie'
      || targetInspection.reason === 'profile_fewer_than_three_businesses'
      ? 'needs_review' : 'needs_evidence';
    return result({ status, selectedReferenceId: null, decisions: [], snapshot: emptySnapshot, reasons: [targetInspection.reason] });
  }
  if (!input.target.instrument.trim() || !input.ruleVersion.trim() || input.ruleVersion !== input.target.ruleVersion
    || !input.referenceIndexVersion.trim() || !validScope(input.target.market, input.target.offering)) {
    return result({
      status: 'needs_review', selectedReferenceId: null, decisions: [],
      snapshot: snapshot(input, canonicalSet(targetInspection.topThree.map((line) => line.code)), targetInspection.topThree, null, null),
      reasons: ['target_rule_or_scope_version_invalid'],
    });
  }
  const targetSetKey = canonicalSet(targetInspection.topThree.map((line) => line.code));
  if (!input.libraryAvailable) {
    return result({
      status: 'unavailable', selectedReferenceId: null, decisions: [],
      snapshot: snapshot(input, targetSetKey, targetInspection.topThree, null, null), reasons: ['reference_library_unavailable'],
    });
  }

  const decisions: ReferenceCandidateDecision[] = [];
  const eligible: { candidate: ReferenceCandidate; mapping: AcceptedChapterMapping | null }[] = [];
  let pendingComparison = false;
  for (const candidate of input.candidates) {
    const reason = eligibilityReason(candidate, input.target, input.ruleVersion);
    if (reason) {
      decisions.push({ referenceId: candidate.referenceId, documentVersion: candidate.documentVersion, profileVersion: candidate.profile.profileVersion, reason, disposition: 'excluded' });
      continue;
    }
    const profileReason = inspectProfile(candidate.profile).reason;
    if (profileReason) {
      const pendingReason = `reference_${profileReason}`;
      decisions.push({ referenceId: candidate.referenceId, documentVersion: candidate.documentVersion, profileVersion: candidate.profile.profileVersion, reason: pendingReason, disposition: 'excluded' });
      pendingComparison = true;
      continue;
    }
    if (candidate.profile.accountingScope !== input.targetProfile.accountingScope
      || candidate.profile.revenueBasis !== input.targetProfile.revenueBasis) {
      decisions.push({ referenceId: candidate.referenceId, documentVersion: candidate.documentVersion, profileVersion: candidate.profile.profileVersion, reason: 'accounting_scope_or_revenue_basis_mismatch', disposition: 'excluded' });
      pendingComparison = true;
      continue;
    }
    if (candidate.profile.taxonomyVersion !== input.targetProfile.taxonomyVersion) {
      decisions.push({ referenceId: candidate.referenceId, documentVersion: candidate.documentVersion, profileVersion: candidate.profile.profileVersion, reason: 'taxonomy_version_mismatch', disposition: 'excluded' });
      pendingComparison = true;
      continue;
    }
    const candidateInspection = inspectProfile(candidate.profile);
    if (canonicalSet(candidateInspection.topThree.map((line) => line.code)) !== targetSetKey) {
      decisions.push({ referenceId: candidate.referenceId, documentVersion: candidate.documentVersion, profileVersion: candidate.profile.profileVersion, reason: 'top_three_business_set_mismatch', disposition: 'excluded' });
      continue;
    }
    const mapping = acceptedMapping(candidate, input.target, input.ruleVersion);
    eligible.push({ candidate, mapping });
  }

  if (eligible.length === 0) {
    const status = pendingComparison ? 'needs_review' : 'no_match';
    return result({
      status, selectedReferenceId: null,
      decisions: decisions.sort(compareDecisions),
      snapshot: snapshot(input, targetSetKey, targetInspection.topThree, null, null),
      reasons: pendingComparison ? ['candidate_comparison_needs_review'] : ['no_usable_exact_reference'],
    });
  }

  eligible.sort((a, b) => compareCandidates(a.candidate, b.candidate, input.target));
  const selected = eligible[0]!;
  for (const { candidate } of eligible) {
    decisions.push({
      referenceId: candidate.referenceId,
      documentVersion: candidate.documentVersion,
      profileVersion: candidate.profile.profileVersion,
      reason: candidate.referenceId === selected.candidate.referenceId
        && candidate.documentVersion === selected.candidate.documentVersion
        && candidate.profile.profileVersion === selected.candidate.profile.profileVersion
        ? 'exact_business_set_and_target_scope_selected'
        : 'exact_business_set_usable_but_lower_stable_preference',
      disposition: 'matched',
    });
  }
  return result({
    status: 'exact', selectedReferenceId: selected.candidate.referenceId,
    decisions: decisions.sort(compareDecisions),
    snapshot: snapshot(input, targetSetKey, targetInspection.topThree, selected.candidate, selected.mapping),
    reasons: ['exact_three_business_set', 'reference_scope_usable'],
  });
}
