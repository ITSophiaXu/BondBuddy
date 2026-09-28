/**
 * Internal evidence-shape checker for the SCP MC.4-2/3/4 omission condition.
 * A candidate is never an approval to omit disclosure or a compliance finding.
 */

export type ScpMc4EvidenceCitation = {
  sourceRefId: string;
  sourceKind: 'official_publication' | 'public_market_record' | 'user_assertion';
  sourceVersion: string;
  locator: string;
  quote: string;
};

export type ScpMc4Assertion<T> =
  | { status: 'cited'; value: T; citations: ScpMc4EvidenceCitation[]; conflicts?: Array<{ value: T; citations: ScpMc4EvidenceCitation[] }> }
  | { status: 'uncertain'; value: T | null; reason: string; citations?: ScpMc4EvidenceCitation[] };

export type ScpMc4Period = {
  periodId: string;
  kind: 'annual' | 'interim';
  /** Fiscal-year label, supplied from the issuer's reporting evidence. */
  fiscalYear: number;
  startDate: string;
  endDate: string;
};

export type ScpMc4InformationCategory = 'operating' | 'financial' | 'credit';
export type ScpMc4InterimRequirement =
  | { decision: 'required'; period: ScpMc4Period }
  | { decision: 'not_required' };

/** One public item may support multiple categories and periods. It is not a report-count proxy. */
export type ScpMc4PublicItem = {
  documentRefId: string;
  version: string;
  categories: ScpMc4InformationCategory[];
  /** A single publication/version can evidence several reporting periods and categories. */
  periods: ScpMc4Period[];
  entityScope: 'consolidated' | 'parent' | 'both' | 'other';
  auditStatus: 'audited' | 'unaudited' | 'not_applicable';
  publishedOn: string;
  /** Explicitly evaluated against actionDate; retrieval today does not establish historic availability. */
  availableOnActionDate: ScpMc4Assertion<boolean>;
  /** Changes stay attached to the version; the checker does not infer their legal effect. */
  publicationEvents: Array<{
    kind: 'corrected' | 'withdrawn';
    effectiveOn: string;
    version: string;
    citations: ScpMc4EvidenceCitation[];
  }>;
  citations: ScpMc4EvidenceCitation[];
};

export type ScpMc4OmissionEvidenceInput = {
  /** Actual registration/issuance disclosure date being evaluated, not a report period or task date. */
  actionDate: ScpMc4Assertion<string>;
  firstPublicRegistration: ScpMc4Assertion<boolean>;
  /** Issuer tier and its source are preserved; applicability is separately resolved for this action. */
  issuerTier: ScpMc4Assertion<string>;
  effectivePublicInformation: ScpMc4Assertion<boolean>;
  /** The standard latest three complete fiscal years are an evidence-backed candidate set. */
  candidateAnnualFiscalYears: ScpMc4Assertion<[number, number, number]>;
  /** Decision and (if required) the applicable interim period must be sourced for this issuer/action. */
  interimRequirement: ScpMc4Assertion<ScpMc4InterimRequirement>;
  publicItems: ScpMc4PublicItem[];
  /** M-5/M-6/M-7 content retained independently of any omission candidate. */
  fundsManagementControls: ScpMc4Assertion<'included' | 'missing'>;
  shortTermLiquidityPlan: ScpMc4Assertion<'included' | 'missing'>;
  /** OF007 note 1: keep evidence for each transition scheme separate. */
  fundsManagementControlsTransitionScheme: ScpMc4Assertion<'included' | 'missing'>;
  shortTermLiquidityPlanTransitionScheme: ScpMc4Assertion<'included' | 'missing'>;
};

export type ScpMc4OmissionDecision =
  | 'full_disclosure_required'
  | 'omission_candidate_needs_professional_review'
  | 'needs_review';

export type ScpMc4OmissionEvidenceResult = {
  decision: ScpMc4OmissionDecision;
  reasons: string[];
  evidence: ScpMc4OmissionEvidenceInput;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const REQUIRED_CATEGORIES: readonly ScpMc4InformationCategory[] = ['operating', 'financial', 'credit'];
const ENTITY_SCOPES: readonly string[] = ['consolidated', 'parent', 'both', 'other'];
const AUDIT_STATUSES: readonly string[] = ['audited', 'unaudited', 'not_applicable'];

function isCalendarDate(value: string): boolean {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= days;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasTrustworthyCitation(citation: unknown): citation is ScpMc4EvidenceCitation {
  if (citation === null || typeof citation !== 'object') return false;
  const candidate = citation as Partial<ScpMc4EvidenceCitation>;
  return (candidate.sourceKind === 'official_publication' || candidate.sourceKind === 'public_market_record') &&
    typeof candidate.sourceRefId === 'string' && candidate.sourceRefId.trim().length > 0 &&
    typeof candidate.sourceVersion === 'string' && candidate.sourceVersion.trim().length > 0 &&
    typeof candidate.locator === 'string' && candidate.locator.trim().length > 0 &&
    typeof candidate.quote === 'string' && candidate.quote.trim().length > 0;
}

function hasRelevantTransitionCitation(assertion: unknown, subject: 'funds_management_controls' | 'short_term_liquidity_plan'): boolean {
  if (!isRecord(assertion) || assertion.status !== 'cited' || !Array.isArray(assertion.citations)) return false;
  const subjectScheme = subject === 'funds_management_controls'
    ? /资金运营内控制度.{0,8}过渡方案/
    : /短期资金调度应急预案.{0,8}过渡方案/;
  const affirmativeEvidence = (clause: string): boolean => {
    const providedBeforeObject = /已(?:经)?(?:提供|披露|提交)\s*.{0,12}(?:资金运营内控制度|短期资金调度应急预案).{0,8}过渡方案/.test(clause);
    const providedAfterObject = /(?:资金运营内控制度|短期资金调度应急预案).{0,8}过渡方案.{0,12}已(?:经)?(?:提供|披露|提交)/.test(clause);
    const schemeDescribed = /(?:资金运营内控制度|短期资金调度应急预案).{0,8}过渡方案(?:为|包括|内容为)|(?:资金运营内控制度|短期资金调度应急预案).{0,8}过渡方案.{0,12}过渡期间(?:采取|由)/.test(clause);
    return providedBeforeObject || providedAfterObject || schemeDescribed;
  };
  return assertion.citations.some((citation: unknown) => {
    if (!hasTrustworthyCitation(citation)) return false;
    // The regulation proves the obligation, not that this issuer supplied a scheme. Require
    // a public-market record describing an actual issuer disclosure/arrangement.
    if (citation.sourceKind !== 'public_market_record') return false;
    const clauses = citation.quote.split(/[，,；;。！？!?、\n\r]+/).map(clause => clause.trim()).filter(Boolean);
    // Keep a negative assertion about a transition scheme from being outweighed by an
    // unrelated disclosure or affirmative phrase elsewhere in the same citation.
    if (clauses.some(clause => /(?:尚未|未|没有|未能)\s*(?:提供|披露|提交|形成)?/.test(clause) && /(?:资金运营内控制度|短期资金调度应急预案|过渡方案)/.test(clause))) return false;

    // Require the subject's named scheme and its positive disclosure/description in one
    // punctuation-delimited clause. A general control report, another item's scheme, or
    // an affirmative statement in a neighboring clause cannot establish this item.
    const matchingClauses = clauses.filter(clause => subjectScheme.test(clause) && affirmativeEvidence(clause));
    return matchingClauses.length === 1;
  });
}

function assertionStatus(assertion: unknown): 'valid' | 'uncertain' | 'conflict' {
  if (!isRecord(assertion) || assertion.status !== 'cited') return 'uncertain';
  if (!Array.isArray(assertion.citations) || assertion.citations.length === 0 || !assertion.citations.every(hasTrustworthyCitation)) return 'uncertain';
  if ('conflicts' in assertion && !Array.isArray(assertion.conflicts)) return 'uncertain';
  const conflicts = Array.isArray(assertion.conflicts) ? assertion.conflicts : [];
  for (const conflict of conflicts) {
    if (!isRecord(conflict) || !('value' in conflict) || !Array.isArray(conflict.citations) ||
        conflict.citations.length === 0 || !conflict.citations.every(hasTrustworthyCitation)) return 'uncertain';
    if (conflict.value !== assertion.value) return 'conflict';
  }
  return 'valid';
}

function isValidPeriod(period: unknown): period is ScpMc4Period {
  if (period === null || typeof period !== 'object') return false;
  const candidate = period as Partial<ScpMc4Period>;
  return typeof candidate.periodId === 'string' && candidate.periodId.trim().length > 0 &&
    (candidate.kind === 'annual' || candidate.kind === 'interim') &&
    Number.isInteger(candidate.fiscalYear) && candidate.fiscalYear! > 0 &&
    isCalendarDate(candidate.startDate!) && isCalendarDate(candidate.endDate!) && candidate.startDate! <= candidate.endDate!;
}

function isValidPublicationEvent(event: unknown): event is ScpMc4PublicItem['publicationEvents'][number] {
  if (event === null || typeof event !== 'object') return false;
  const candidate = event as Partial<ScpMc4PublicItem['publicationEvents'][number]>;
  return (candidate.kind === 'corrected' || candidate.kind === 'withdrawn') &&
    isCalendarDate(candidate.effectiveOn!) && typeof candidate.version === 'string' && candidate.version.trim().length > 0 &&
    Array.isArray(candidate.citations) && candidate.citations.length > 0 && candidate.citations.every(hasTrustworthyCitation);
}

function isFiscalYearCandidateSet(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(year => Number.isInteger(year) && year > 0) &&
    value[1] === value[0] + 1 && value[2] === value[1] + 1;
}

function isInterimRequirement(value: unknown): value is ScpMc4InterimRequirement {
  if (value === null || typeof value !== 'object' || !('decision' in value)) return false;
  const candidate = value as { decision: unknown; period?: unknown };
  if (candidate.decision === 'not_required') return true;
  return candidate.decision === 'required' && candidate.period !== null && typeof candidate.period === 'object' &&
    isValidPeriod(candidate.period as ScpMc4Period) && (candidate.period as ScpMc4Period).kind === 'interim';
}

function periodKey(period: ScpMc4Period): string {
  return `${period.kind}:${period.fiscalYear}:${period.startDate}:${period.endDate}`;
}

function hasExpectedAnnualPeriods(input: ScpMc4OmissionEvidenceInput, category: ScpMc4InformationCategory): boolean {
  if (input.candidateAnnualFiscalYears.status !== 'cited') return false;
  const expected = input.candidateAnnualFiscalYears.value;
  if (expected[1] !== expected[0] + 1 || expected[2] !== expected[1] + 1) return false;
  const annualPeriods = input.publicItems
    .filter(item => isRecord(item) && Array.isArray(item.categories) && item.categories.includes(category))
    .flatMap(item => Array.isArray(item.periods) ? item.periods.filter(period => isValidPeriod(period) && period.kind === 'annual') : []);
  return expected.every(year => annualPeriods.some(period => period.fiscalYear === year));
}

function hasRequiredInterim(input: ScpMc4OmissionEvidenceInput, category: ScpMc4InformationCategory): boolean {
  if (input.interimRequirement.status !== 'cited' || input.interimRequirement.value.decision !== 'required') return false;
  const expected = input.interimRequirement.value.period;
  return input.publicItems.some(item => isRecord(item) && Array.isArray(item.categories) && item.categories.includes(category) &&
    Array.isArray(item.periods) && item.periods.some(period => isValidPeriod(period) && period.kind === 'interim' && periodKey(period) === periodKey(expected)));
}

/**
 * Checks that period, source, publication and issuer/action applicability evidence is shaped and cited.
 * It does not determine whether an issuer legally qualifies to omit chapters.
 */
export function checkScpMc4OmissionEvidence(input: ScpMc4OmissionEvidenceInput): ScpMc4OmissionEvidenceResult {
  const reasons: string[] = [];
  if (!isRecord(input) || !Array.isArray(input.publicItems)) {
    return { decision: 'needs_review', reasons: ['evidence_input_malformed'], evidence: input };
  }
  const actionDateStatus = assertionStatus(input.actionDate);
  const actionDateAssertion = isRecord(input.actionDate) ? input.actionDate : undefined;
  const actionDate = actionDateAssertion?.status === 'cited' && typeof actionDateAssertion.value === 'string' ? actionDateAssertion.value : '';
  if (actionDateStatus !== 'valid' || !isCalendarDate(actionDate)) reasons.push('action_date_missing_or_invalid');

  const firstStatus = assertionStatus(input.firstPublicRegistration);
  const effectiveStatus = assertionStatus(input.effectivePublicInformation);
  const firstBooleanValid = firstStatus === 'valid' && input.firstPublicRegistration.status === 'cited' && typeof input.firstPublicRegistration.value === 'boolean';
  const effectiveBooleanValid = effectiveStatus === 'valid' && input.effectivePublicInformation.status === 'cited' && typeof input.effectivePublicInformation.value === 'boolean';
  if (!firstBooleanValid) reasons.push(firstStatus === 'conflict' ? 'first_public_registration_conflicting_sources' : firstStatus === 'valid' ? 'first_public_registration_value_invalid' : 'first_public_registration_not_cited');
  if (!effectiveBooleanValid) reasons.push(effectiveStatus === 'conflict' ? 'effective_public_information_conflicting_sources' : effectiveStatus === 'valid' ? 'effective_public_information_value_invalid' : 'effective_public_information_not_cited');
  if (firstBooleanValid && input.firstPublicRegistration.status === 'cited' && input.firstPublicRegistration.value === true) {
    return { decision: 'full_disclosure_required', reasons: ['first_public_registration_requires_full_m5_m6_m7'], evidence: input };
  }
  if (effectiveBooleanValid && input.effectivePublicInformation.status === 'cited' && input.effectivePublicInformation.value === false) {
    return { decision: 'full_disclosure_required', reasons: ['effective_public_information_absent_requires_full_m5_m6_m7'], evidence: input };
  }

  const issuerTierValid = assertionStatus(input.issuerTier) === 'valid' && input.issuerTier.status === 'cited' &&
    typeof input.issuerTier.value === 'string' && input.issuerTier.value.trim().length > 0;
  if (!issuerTierValid) reasons.push('issuer_tier_not_source_confirmed');
  const annualYearsStatus = assertionStatus(input.candidateAnnualFiscalYears);
  const annualYearsValid = annualYearsStatus === 'valid' && input.candidateAnnualFiscalYears.status === 'cited' && isFiscalYearCandidateSet(input.candidateAnnualFiscalYears.value);
  if (!annualYearsValid) reasons.push(annualYearsStatus === 'valid' ? 'candidate_annual_fiscal_years_malformed' : 'candidate_annual_fiscal_years_not_source_confirmed');
  const interimRequirementStatus = assertionStatus(input.interimRequirement);
  const interimRequirementValid = interimRequirementStatus === 'valid' && input.interimRequirement.status === 'cited' && isInterimRequirement(input.interimRequirement.value);
  if (!interimRequirementValid) reasons.push(interimRequirementStatus === 'valid' ? 'interim_applicability_value_invalid' : 'interim_applicability_not_source_confirmed');

  const itemIds = new Set<string>();
  for (const rawItem of input.publicItems) {
    if (!isRecord(rawItem)) {
      reasons.push('public_item_malformed');
      continue;
    }
    const item = rawItem as unknown as ScpMc4PublicItem;
    const documentRefId = typeof item.documentRefId === 'string' ? item.documentRefId : '';
    const version = typeof item.version === 'string' ? item.version : '';
    if (!documentRefId.trim() || !version.trim() || itemIds.has(`${documentRefId}:${version}`)) reasons.push('public_item_identity_missing_or_duplicated');
    itemIds.add(`${documentRefId}:${version}`);
    if (!Array.isArray(item.citations) || !item.citations.length || !item.citations.every(hasTrustworthyCitation)) reasons.push('public_item_source_or_locator_missing');
    if (!Array.isArray(item.categories) || !item.categories.length || item.categories.some(category => !REQUIRED_CATEGORIES.includes(category))) reasons.push('public_item_category_mapping_missing_or_invalid');
    if (!ENTITY_SCOPES.includes(item.entityScope)) reasons.push('public_item_entity_scope_missing_or_invalid');
    if (!AUDIT_STATUSES.includes(item.auditStatus)) reasons.push('public_item_audit_status_missing_or_invalid');
    if (!Array.isArray(item.periods) || !item.periods.length) reasons.push('public_item_periods_missing');
    else if (item.periods.some(period => !isValidPeriod(period))) reasons.push('public_item_period_invalid');
    if (!isCalendarDate(item.publishedOn)) reasons.push('public_item_publication_date_invalid');
    else if (isCalendarDate(actionDate) && item.publishedOn > actionDate) reasons.push('public_item_published_after_action_date');
    const historicAvailabilityStatus = assertionStatus(item.availableOnActionDate);
    if (historicAvailabilityStatus !== 'valid') reasons.push('public_item_historic_availability_not_source_confirmed');
    else if (item.availableOnActionDate.status !== 'cited' || typeof item.availableOnActionDate.value !== 'boolean') reasons.push('public_item_historic_availability_value_invalid');
    else if (item.availableOnActionDate.value === false) reasons.push('public_item_not_available_on_action_date');
    if (!Array.isArray(item.publicationEvents)) reasons.push('public_item_publication_events_missing_or_invalid');
    else for (const event of item.publicationEvents) {
      if (!isValidPublicationEvent(event)) {
        reasons.push('public_item_version_event_incomplete');
        continue;
      }
      if (isCalendarDate(event.effectiveOn) && isCalendarDate(actionDate) && event.effectiveOn <= actionDate) {
        reasons.push('public_item_version_change_on_or_before_action_date_requires_resolution');
      }
    }
  }

  for (const category of REQUIRED_CATEGORIES) {
    if (!input.publicItems.some(item => isRecord(item) && Array.isArray(item.categories) && item.categories.includes(category))) reasons.push(`${category}_information_coverage_missing`);
    if (annualYearsValid && !hasExpectedAnnualPeriods(input, category)) reasons.push(`${category}_candidate_annual_coverage_incomplete`);
    if (interimRequirementValid && input.interimRequirement.status === 'cited' &&
        input.interimRequirement.value.decision === 'required' && !hasRequiredInterim(input, category)) {
      reasons.push(`${category}_applicable_interim_coverage_missing`);
    }
  }

  const controlsStatus = assertionStatus(input.fundsManagementControls);
  const controlsKnown = controlsStatus === 'valid' && input.fundsManagementControls.status === 'cited' &&
    (input.fundsManagementControls.value === 'included' || input.fundsManagementControls.value === 'missing');
  const liquidityStatus = assertionStatus(input.shortTermLiquidityPlan);
  const liquidityKnown = liquidityStatus === 'valid' && input.shortTermLiquidityPlan.status === 'cited' &&
    (input.shortTermLiquidityPlan.value === 'included' || input.shortTermLiquidityPlan.value === 'missing');
  if (!controlsKnown) reasons.push('funds_management_controls_status_not_source_confirmed');
  if (!liquidityKnown) reasons.push('short_term_liquidity_plan_status_not_source_confirmed');

  // Official OF007 note 1 names a transition scheme for each control/plan. Check the matching
  // evidence independently; a citation for one cannot satisfy the other. This remains a
  // professional-review candidate only and is not a waiver.
  const transitionRequirements = [
    {
      contentMissing: controlsKnown && input.fundsManagementControls.status === 'cited' && input.fundsManagementControls.value === 'missing',
      assertion: input.fundsManagementControlsTransitionScheme,
      subject: 'funds_management_controls' as const,
      pendingReason: 'funds_management_controls_transition_scheme_not_source_confirmed',
      missingReason: 'funds_management_controls_transition_scheme_missing',
      relevanceReason: 'funds_management_controls_transition_scheme_citation_not_relevant',
    },
    {
      contentMissing: liquidityKnown && input.shortTermLiquidityPlan.status === 'cited' && input.shortTermLiquidityPlan.value === 'missing',
      assertion: input.shortTermLiquidityPlanTransitionScheme,
      subject: 'short_term_liquidity_plan' as const,
      pendingReason: 'short_term_liquidity_plan_transition_scheme_not_source_confirmed',
      missingReason: 'short_term_liquidity_plan_transition_scheme_missing',
      relevanceReason: 'short_term_liquidity_plan_transition_scheme_citation_not_relevant',
    },
  ];
  for (const requirement of transitionRequirements) {
    if (!requirement.contentMissing) continue;
    const transitionStatus = assertionStatus(requirement.assertion);
    const transitionKnown = transitionStatus === 'valid' && requirement.assertion.status === 'cited' &&
      (requirement.assertion.value === 'included' || requirement.assertion.value === 'missing');
    if (!transitionKnown) reasons.push(requirement.pendingReason);
    else if (requirement.assertion.status !== 'cited' || requirement.assertion.value !== 'included') reasons.push(requirement.missingReason);
    else if (!hasRelevantTransitionCitation(requirement.assertion, requirement.subject)) reasons.push(requirement.relevanceReason);
  }

  if (reasons.length > 0) return { decision: 'needs_review', reasons, evidence: input };
  return {
    decision: 'omission_candidate_needs_professional_review',
    reasons: ['evidence_shape_candidate_only; professional_review_required', 'no_machine_approval_or_omission_decision'],
    evidence: input,
  };
}
