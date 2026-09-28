import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkScpMc4OmissionEvidence,
  type ScpMc4Assertion,
  type ScpMc4InterimRequirement,
  type ScpMc4OmissionEvidenceInput,
  type ScpMc4Period,
  type ScpMc4PublicItem,
} from './scp-mc4-omission-evidence.js';

const citation = {
  sourceRefId: 'synthetic:public-record',
  sourceKind: 'public_market_record' as const,
  sourceVersion: 'synthetic-v1',
  locator: 'page 1, paragraph 1',
  quote: 'Synthetic evidence fixture; not an industry sample.',
};

function cited<T>(value: T, extra: Partial<Extract<ScpMc4Assertion<T>, { status: 'cited' }>> = {}): ScpMc4Assertion<T> {
  return { status: 'cited', value, citations: [citation], ...extra };
}

function transitionSchemeCited(subject: 'funds_management_controls' | 'short_term_liquidity_plan', sourceKind: 'official_publication' | 'public_market_record' | 'user_assertion' = citation.sourceKind, quote?: string): ScpMc4Assertion<'included' | 'missing'> {
  const subjectQuote = subject === 'funds_management_controls'
    ? '已披露资金运营内控制度过渡方案：过渡期间采取双人复核和限额审批措施，并尽快完成制度制定。'
    : '已披露短期资金调度应急预案过渡方案：过渡期间采取临时调度措施，并尽快完成预案制定。';
  return cited('included', { citations: [{ ...citation, sourceKind, quote: quote ?? subjectQuote }] });
}

function annualPeriod(year: number): ScpMc4Period {
  return { periodId: `fy-${year}`, kind: 'annual', fiscalYear: year, startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

function interimPeriod(periodId = 'h1-2025'): ScpMc4Period {
  return { periodId, kind: 'interim', fiscalYear: 2025, startDate: '2025-01-01', endDate: '2025-06-30' };
}

function item(period: ScpMc4Period, overrides: Partial<ScpMc4PublicItem> = {}): ScpMc4PublicItem {
  return {
    documentRefId: `public-${period.periodId}`,
    version: 'v1',
    categories: ['operating', 'financial', 'credit'],
    periods: [period],
    entityScope: period.kind === 'annual' ? 'both' : 'consolidated',
    auditStatus: period.kind === 'annual' ? 'audited' : 'unaudited',
    publishedOn: period.kind === 'annual' ? `${period.fiscalYear + 1}-04-01` : '2025-08-01',
    availableOnActionDate: cited(true),
    publicationEvents: [],
    citations: [citation],
    ...overrides,
  };
}

function input(overrides: Partial<ScpMc4OmissionEvidenceInput> = {}): ScpMc4OmissionEvidenceInput {
  return {
    actionDate: cited('2025-09-01'),
    firstPublicRegistration: cited(false),
    issuerTier: cited('tier-2'),
    effectivePublicInformation: cited(true),
    candidateAnnualFiscalYears: cited([2022, 2023, 2024]),
    interimRequirement: cited({ decision: 'required', period: interimPeriod() } satisfies ScpMc4InterimRequirement),
    publicItems: [annualPeriod(2022), annualPeriod(2023), annualPeriod(2024), interimPeriod()].map(period => item(period)),
    fundsManagementControls: cited('included'),
    shortTermLiquidityPlan: cited('included'),
    fundsManagementControlsTransitionScheme: { status: 'uncertain', value: null, reason: 'not needed when controls are included' },
    shortTermLiquidityPlanTransitionScheme: { status: 'uncertain', value: null, reason: 'not needed when plan is included' },
    ...overrides,
  };
}

test('cited three-year and applicable-interim shape yields only a professional-review candidate', () => {
  const evidence = input();
  const result = checkScpMc4OmissionEvidence(evidence);
  assert.equal(result.decision, 'omission_candidate_needs_professional_review');
  assert.ok(result.reasons.includes('no_machine_approval_or_omission_decision'));
  assert.equal(result.evidence, evidence);
});

test('one public item may cover all information categories without a per-category report-count rule', () => {
  const result = checkScpMc4OmissionEvidence(input({
    publicItems: [annualPeriod(2022), annualPeriod(2023), annualPeriod(2024), interimPeriod()].map(period => item(period, {
      categories: ['operating', 'financial', 'credit'],
    })),
  }));
  assert.equal(result.decision, 'omission_candidate_needs_professional_review');
});

test('one report/version can cover multiple annual and interim periods across all three categories', () => {
  const periods = [annualPeriod(2022), annualPeriod(2023), annualPeriod(2024), interimPeriod()];
  const result = checkScpMc4OmissionEvidence(input({
    publicItems: [item(annualPeriod(2022), {
      documentRefId: 'single-public-report',
      periods,
      categories: ['operating', 'financial', 'credit'],
      publishedOn: '2025-08-01',
    })],
  }));
  assert.equal(result.decision, 'omission_candidate_needs_professional_review');
});

test('first public registration requires full M-5/M-6/M-7 disclosure', () => {
  const result = checkScpMc4OmissionEvidence(input({ firstPublicRegistration: cited(true) }));
  assert.equal(result.decision, 'full_disclosure_required');
  assert.ok(result.reasons.includes('first_public_registration_requires_full_m5_m6_m7'));
});

test('absence of effective public information requires full disclosure independently of first registration', () => {
  const result = checkScpMc4OmissionEvidence(input({ effectivePublicInformation: cited(false) }));
  assert.equal(result.decision, 'full_disclosure_required');
  assert.ok(result.reasons.includes('effective_public_information_absent_requires_full_m5_m6_m7'));
});

test('first registration OR absent effective information requires full disclosure, never an AND gate', () => {
  for (const [firstPublicRegistration, effectivePublicInformation, expected] of [
    [true, true, 'full_disclosure_required'],
    [true, false, 'full_disclosure_required'],
    [false, false, 'full_disclosure_required'],
    [false, true, 'omission_candidate_needs_professional_review'],
  ] as const) {
    assert.equal(checkScpMc4OmissionEvidence(input({
      firstPublicRegistration: cited(firstPublicRegistration),
      effectivePublicInformation: cited(effectivePublicInformation),
    })).decision, expected);
  }
});

test('missing one of the three annual fiscal years stays in review, not an automatic full-disclosure finding', () => {
  const evidence = input({ publicItems: input().publicItems.filter(entry => !entry.periods.some(period => period.fiscalYear === 2023)) });
  const result = checkScpMc4OmissionEvidence(evidence);
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('operating_candidate_annual_coverage_incomplete'));
});

test('quarterly or interim evidence is required only when its cited issuer/action rule says so', () => {
  const withoutInterim = input({
    interimRequirement: cited({ decision: 'not_required' }),
    publicItems: input().publicItems.filter(entry => !entry.periods.some(period => period.kind === 'interim')),
  });
  assert.equal(checkScpMc4OmissionEvidence(withoutInterim).decision, 'omission_candidate_needs_professional_review');

  const missingRequiredInterim = input({ publicItems: input().publicItems.filter(entry => !entry.periods.some(period => period.kind === 'interim')) });
  const result = checkScpMc4OmissionEvidence(missingRequiredInterim);
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('financial_applicable_interim_coverage_missing'));
});

test('uncited tier or interim applicability remains needs_review', () => {
  const result = checkScpMc4OmissionEvidence(input({
    issuerTier: { status: 'uncertain', value: null, reason: 'tier needs source confirmation' },
    interimRequirement: { status: 'uncertain', value: null, reason: 'applicability not determined' },
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('issuer_tier_not_source_confirmed'));
  assert.ok(result.reasons.includes('interim_applicability_not_source_confirmed'));
});

test('malformed gating values fail closed even when their assertions are marked cited', () => {
  const malformed = checkScpMc4OmissionEvidence(input({
    issuerTier: cited('   '),
    firstPublicRegistration: cited('false' as unknown as boolean),
    effectivePublicInformation: cited(1 as unknown as boolean),
    candidateAnnualFiscalYears: cited([2022, 2023.5, 2024] as unknown as [number, number, number]),
    interimRequirement: cited({ decision: 'maybe' } as unknown as ScpMc4InterimRequirement),
    publicItems: input().publicItems.map((entry, index) => index === 0
      ? { ...entry, availableOnActionDate: cited('yes' as unknown as boolean) }
      : entry),
  }));
  assert.equal(malformed.decision, 'needs_review');
  assert.ok(malformed.reasons.includes('issuer_tier_not_source_confirmed'));
  assert.ok(malformed.reasons.includes('first_public_registration_value_invalid'));
  assert.ok(malformed.reasons.includes('effective_public_information_value_invalid'));
  assert.ok(malformed.reasons.includes('candidate_annual_fiscal_years_malformed'));
  assert.ok(malformed.reasons.includes('interim_applicability_value_invalid'));
  assert.ok(malformed.reasons.includes('public_item_historic_availability_value_invalid'));
});

test('publication date and historic availability are separate from the covered period', () => {
  const period = annualPeriod(2024);
  const late = item(period, { publishedOn: '2025-10-01' });
  const result = checkScpMc4OmissionEvidence(input({
    actionDate: cited('2025-09-01'),
    publicItems: [late, ...input().publicItems.filter(entry => !entry.periods.some(period => period.fiscalYear === 2024))],
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('public_item_published_after_action_date'));

  const historicalUnavailable = item(period, { availableOnActionDate: cited(false) });
  const unavailableResult = checkScpMc4OmissionEvidence(input({
    publicItems: [historicalUnavailable, ...input().publicItems.filter(entry => !entry.periods.some(period => period.fiscalYear === 2024))],
  }));
  assert.equal(unavailableResult.decision, 'needs_review');
  assert.ok(unavailableResult.reasons.includes('public_item_not_available_on_action_date'));
});

test('current online retrieval cannot replace source evidence that the item was then available', () => {
  const result = checkScpMc4OmissionEvidence(input({
    publicItems: input().publicItems.map(entry => entry.periods.some(period => period.periodId === 'fy-2024')
      ? { ...entry, availableOnActionDate: { status: 'uncertain', value: true, reason: 'only verified online today' } }
      : entry),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('public_item_historic_availability_not_source_confirmed'));
});

test('publication corrections and withdrawals require dated, versioned citations', () => {
  const result = checkScpMc4OmissionEvidence(input({
    publicItems: input().publicItems.map(entry => entry.periods.some(period => period.periodId === 'fy-2024')
      ? { ...entry, publicationEvents: [{ kind: 'corrected', effectiveOn: '2025-08-20', version: 'v2', citations: [] }] }
      : entry),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('public_item_version_event_incomplete'));

  const datedChange = checkScpMc4OmissionEvidence(input({
    publicItems: input().publicItems.map(entry => entry.periods.some(period => period.periodId === 'fy-2024')
      ? { ...entry, publicationEvents: [{ kind: 'corrected', effectiveOn: '2025-08-20', version: 'v2', citations: [citation] }] }
      : entry),
  }));
  assert.equal(datedChange.decision, 'needs_review');
  assert.ok(datedChange.reasons.includes('public_item_version_change_on_or_before_action_date_requires_resolution'));
});

test('malformed publication event history and period entries fail closed without throwing', () => {
  const noEventArray = { ...input().publicItems[0], publicationEvents: null } as unknown as ScpMc4PublicItem;
  const result = checkScpMc4OmissionEvidence(input({ publicItems: [noEventArray, ...input().publicItems.slice(1)] }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('public_item_publication_events_missing_or_invalid'));

  const badEvent = { ...input().publicItems[0], publicationEvents: [null] } as unknown as ScpMc4PublicItem;
  const eventResult = checkScpMc4OmissionEvidence(input({ publicItems: [badEvent, ...input().publicItems.slice(1)] }));
  assert.equal(eventResult.decision, 'needs_review');
  assert.ok(eventResult.reasons.includes('public_item_version_event_incomplete'));

  const badPeriod = { ...input().publicItems[0], periods: [null] } as unknown as ScpMc4PublicItem;
  const periodResult = checkScpMc4OmissionEvidence(input({ publicItems: [badPeriod, ...input().publicItems.slice(1)] }));
  assert.equal(periodResult.decision, 'needs_review');
  assert.ok(periodResult.reasons.includes('public_item_period_invalid'));
});

test('entity scope and audit status remain distinct fields on annual and interim evidence', () => {
  const records = input().publicItems;
  assert.equal(records.find(entry => entry.periods[0]?.kind === 'annual')?.entityScope, 'both');
  assert.equal(records.find(entry => entry.periods[0]?.kind === 'annual')?.auditStatus, 'audited');
  assert.equal(records.find(entry => entry.periods[0]?.kind === 'interim')?.entityScope, 'consolidated');
  assert.equal(records.find(entry => entry.periods[0]?.kind === 'interim')?.auditStatus, 'unaudited');
});

test('missing or invalid entity/audit scope stays needs_review', () => {
  const base = input().publicItems;
  const { entityScope: _entityScope, ...withoutScope } = base[0]!;
  const missingScope = checkScpMc4OmissionEvidence(input({ publicItems: [withoutScope as ScpMc4PublicItem, ...base.slice(1)] }));
  assert.equal(missingScope.decision, 'needs_review');
  assert.ok(missingScope.reasons.includes('public_item_entity_scope_missing_or_invalid'));

  const invalid = { ...base[0], auditStatus: 'unknown' } as unknown as ScpMc4PublicItem;
  const invalidAudit = checkScpMc4OmissionEvidence(input({ publicItems: [invalid, ...base.slice(1)] }));
  assert.equal(invalidAudit.decision, 'needs_review');
  assert.ok(invalidAudit.reasons.includes('public_item_audit_status_missing_or_invalid'));
});

test('user assertions alone cannot establish dates, registration, availability or category coverage', () => {
  const userCitation = { ...citation, sourceKind: 'user_assertion' as const };
  const result = checkScpMc4OmissionEvidence(input({
    actionDate: cited('2025-09-01', { citations: [userCitation] }),
    firstPublicRegistration: cited(false, { citations: [userCitation] }),
    publicItems: input().publicItems.map(entry => ({
      ...entry,
      availableOnActionDate: cited(true, { citations: [userCitation] }),
    })),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('action_date_missing_or_invalid'));
  assert.ok(result.reasons.includes('first_public_registration_not_cited'));
  assert.ok(result.reasons.includes('public_item_historic_availability_not_source_confirmed'));
});

test('only official publications and public market records can support omission evidence', () => {
  const rejectedKinds = ['untrusted_source', undefined, null] as const;
  const locations = [
    (base: ScpMc4OmissionEvidenceInput, badCitation: typeof citation) => ({ ...base, actionDate: cited('2025-09-01', { citations: [badCitation] }) }),
    (base: ScpMc4OmissionEvidenceInput, badCitation: typeof citation) => ({
      ...base,
      publicItems: base.publicItems.map((entry, index) => index === 0 ? { ...entry, citations: [badCitation] } : entry),
    }),
    (base: ScpMc4OmissionEvidenceInput, badCitation: typeof citation) => ({
      ...base,
      publicItems: base.publicItems.map((entry, index) => index === 0
        ? { ...entry, availableOnActionDate: cited(true, { citations: [badCitation] }) }
        : entry),
    }),
    (base: ScpMc4OmissionEvidenceInput, badCitation: typeof citation) => ({
      ...base,
      publicItems: base.publicItems.map((entry, index) => index === 0
        ? { ...entry, publicationEvents: [{ kind: 'corrected' as const, effectiveOn: '2025-09-10', version: 'v2', citations: [badCitation] }] }
        : entry),
    }),
  ];
  for (const location of locations) {
    for (const sourceKind of [...rejectedKinds, 'user_assertion'] as const) {
      const evidence = location(input(), { ...citation, sourceKind } as unknown as typeof citation);
      const result = checkScpMc4OmissionEvidence(evidence);
      assert.equal(result.decision, 'needs_review');
      assert.equal(result.evidence, evidence);
    }
  }
});

test('malformed assertion, citation and conflict shapes fail closed without throwing or dropping evidence', () => {
  const base = input();
  const malformedAssertions: unknown[] = [
    {},
    null,
    { status: 'cited', value: '2025-09-01', citations: null },
    { status: 'cited', value: '2025-09-01' },
    { status: 'cited', value: '2025-09-01', citations: [citation], conflicts: {} },
    { status: 'cited', value: '2025-09-01', citations: [citation], conflicts: [null] },
    { status: 'cited', value: '2025-09-01', citations: [citation], conflicts: [{ value: '2025-09-01', citations: null }] },
  ];
  const malformedEvidence = [
    ...malformedAssertions.map(actionDate => ({ ...base, actionDate })),
    ...malformedAssertions.map(firstPublicRegistration => ({ ...base, firstPublicRegistration })),
    ...malformedAssertions.map(effectivePublicInformation => ({ ...base, effectivePublicInformation })),
    ...malformedAssertions.map(issuerTier => ({ ...base, issuerTier })),
    ...malformedAssertions.map(candidateAnnualFiscalYears => ({ ...base, candidateAnnualFiscalYears })),
    ...malformedAssertions.map(interimRequirement => ({ ...base, interimRequirement })),
    ...malformedAssertions.map(fundsManagementControls => ({ ...base, fundsManagementControls })),
    ...malformedAssertions.map(shortTermLiquidityPlan => ({ ...base, shortTermLiquidityPlan })),
    ...malformedAssertions.map(availableOnActionDate => ({
      ...base,
      publicItems: base.publicItems.map((entry, index) => index === 0 ? { ...entry, availableOnActionDate } : entry),
    })),
  ];

  for (const evidence of malformedEvidence) {
    const result = checkScpMc4OmissionEvidence(evidence as unknown as ScpMc4OmissionEvidenceInput);
    assert.equal(result.decision, 'needs_review');
    assert.equal(result.evidence, evidence);
  }
});

test('transition-scheme evidence is required per missing MC.4 item; a missing companion cannot be borrowed', () => {
  const cases = [
    {
      controls: 'missing', plan: 'included',
      controlsScheme: transitionSchemeCited('funds_management_controls'),
      planScheme: { status: 'uncertain', value: null, reason: 'plan exists' } as ScpMc4Assertion<'included' | 'missing'>,
      expected: 'omission_candidate_needs_professional_review',
    },
    {
      controls: 'included', plan: 'missing',
      controlsScheme: { status: 'uncertain', value: null, reason: 'controls exist' } as ScpMc4Assertion<'included' | 'missing'>,
      planScheme: transitionSchemeCited('short_term_liquidity_plan'),
      expected: 'omission_candidate_needs_professional_review',
    },
    {
      controls: 'missing', plan: 'missing',
      controlsScheme: transitionSchemeCited('funds_management_controls'),
      planScheme: transitionSchemeCited('short_term_liquidity_plan'),
      expected: 'omission_candidate_needs_professional_review',
    },
    {
      controls: 'missing', plan: 'missing',
      controlsScheme: transitionSchemeCited('funds_management_controls'),
      planScheme: { status: 'uncertain', value: null, reason: 'plan scheme missing' } as ScpMc4Assertion<'included' | 'missing'>,
      expected: 'needs_review',
    },
    {
      controls: 'missing', plan: 'missing',
      controlsScheme: { status: 'uncertain', value: null, reason: 'control scheme missing' } as ScpMc4Assertion<'included' | 'missing'>,
      planScheme: transitionSchemeCited('short_term_liquidity_plan'),
      expected: 'needs_review',
    },
  ] as const;

  for (const entry of cases) {
    const result = checkScpMc4OmissionEvidence(input({
      fundsManagementControls: cited(entry.controls),
      shortTermLiquidityPlan: cited(entry.plan),
      fundsManagementControlsTransitionScheme: entry.controlsScheme,
      shortTermLiquidityPlanTransitionScheme: entry.planScheme,
    }));
    assert.equal(result.decision, entry.expected);
    if (entry.expected === 'omission_candidate_needs_professional_review') {
      assert.ok(result.reasons.includes('no_machine_approval_or_omission_decision'));
    }
  }
});

test('transition scheme cannot be established by user assertion or by quoting only the rule obligation', () => {
  const missingControls = { fundsManagementControls: cited<'included' | 'missing'>('missing') };
  const userAssertedScheme = checkScpMc4OmissionEvidence(input({
    ...missingControls,
    fundsManagementControlsTransitionScheme: transitionSchemeCited('funds_management_controls', 'user_assertion'),
  }));
  assert.equal(userAssertedScheme.decision, 'needs_review');
  assert.ok(userAssertedScheme.reasons.includes('funds_management_controls_transition_scheme_not_source_confirmed'));

  const ruleTextOnly = checkScpMc4OmissionEvidence(input({
    ...missingControls,
    fundsManagementControlsTransitionScheme: transitionSchemeCited(
      'funds_management_controls', 'public_market_record',
      '对于尚未制定资金运营内控制度和短期资金调度应急预案的企业，需提供资金运营内控制度和短期资金调度应急预案过渡方案，并尽快完成制定。',
    ),
  }));
  assert.equal(ruleTextOnly.decision, 'needs_review');
  assert.ok(ruleTextOnly.reasons.includes('funds_management_controls_transition_scheme_citation_not_relevant'));

  const unrelatedDisclosure = checkScpMc4OmissionEvidence(input({
    ...missingControls,
    fundsManagementControlsTransitionScheme: transitionSchemeCited('funds_management_controls', 'public_market_record', '已披露董事会授权及年度预算管理办法。'),
  }));
  assert.equal(unrelatedDisclosure.decision, 'needs_review');
  assert.ok(unrelatedDisclosure.reasons.includes('funds_management_controls_transition_scheme_citation_not_relevant'));
});

test('malformed transition-scheme evidence fails closed for the missing item only', () => {
  const evidence = input({
    fundsManagementControls: cited('missing'),
    fundsManagementControlsTransitionScheme: { status: 'cited', value: 'included', citations: null } as unknown as ScpMc4Assertion<'included' | 'missing'>,
  });
  const result = checkScpMc4OmissionEvidence(evidence);
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('funds_management_controls_transition_scheme_not_source_confirmed'));
  assert.equal(result.evidence, evidence);
});

test('complete controls and liquidity disclosures do not require transition-scheme evidence', () => {
  assert.equal(checkScpMc4OmissionEvidence(input()).decision, 'omission_candidate_needs_professional_review');
});

test('invalid action dates and conflicting registration status need review', () => {
  const invalidDate = checkScpMc4OmissionEvidence(input({ actionDate: cited('2025-02-30') }));
  assert.equal(invalidDate.decision, 'needs_review');
  assert.ok(invalidDate.reasons.includes('action_date_missing_or_invalid'));

  const conflict = checkScpMc4OmissionEvidence(input({
    firstPublicRegistration: cited(false, { conflicts: [{ value: true, citations: [{ ...citation, locator: 'notice 2' }] }] }),
  }));
  assert.equal(conflict.decision, 'needs_review');
  assert.ok(conflict.reasons.includes('first_public_registration_conflicting_sources'));
});
