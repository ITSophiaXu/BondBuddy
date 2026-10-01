import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkMtnQuarterlyUpdateEvidence,
  type MtnQuarterlyNa058ExceptionEvidence,
  type MtnQuarterlyUpdateEvidenceInput,
} from './mtn-quarterly-update-evidence.js';
import type { MtnEvidenceValue } from './mtn-registration-evidence.js';

const citation = {
  sourceRefId: 'synthetic:mtn-quarterly-update',
  materialVersion: 'synthetic-v1',
  locator: 'page 1, paragraph 1',
  quote: 'Synthetic evidence only; not an actual issuer document or legal conclusion.',
};

function ev<T>(value: T, quote = citation.quote): MtnEvidenceValue<T> {
  return { value, citations: [{ ...citation, quote }], uncertainty: 'clear' };
}

function na058Exception(
  overrides: Partial<MtnQuarterlyNa058ExceptionEvidence> = {},
): MtnQuarterlyNa058ExceptionEvidence {
  return {
    claimed: ev(true),
    issuerBasis: ev('first_class'),
    reportKind: ev('q1'),
    scope: ev('movement_analysis_only'),
    statementListing: {
      latestStatements: ev(true),
      dataSource: ev(true),
      consolidatedAndParent: ev(true),
    },
    listedCompanyCleanRecord: ev<'not_applicable'>('not_applicable'),
    effectivityBasis: ev('qa_publication_2022_05_25'),
    ...overrides,
  };
}

function input(overrides: Partial<MtnQuarterlyUpdateEvidenceInput> = {}): MtnQuarterlyUpdateEvidenceInput {
  return {
    actualInstrument: ev('mtn'),
    issuerEntityId: ev('uscc:synthetic-issuer-001'),
    issuerTier: ev('basic_tier'),
    registrationArrangement: ev('basic_tier_unified_quota'),
    investorScope: ev('interbank-institutional'),
    triggerBasis: ev('new_quarterly_report_then_first_market_issuance'),
    issuanceEventDate: ev('2026-06-15'),
    firstMarketIssuance: ev('first_market_issuance'),
    latestQuarterlyReportPeriod: ev({ periodId: '2026-q1', startDate: '2026-01-01', endDate: '2026-03-31' }),
    quarterlyReportPublicationDate: ev('2026-04-28'),
    quarterlyReportSourceSha256: ev('a'.repeat(64)),
    documentCoveragePeriod: ev({ periodId: 'document-coverage-2026-q1', startDate: '2023-01-01', endDate: '2026-03-31' }),
    na058Exception: null,
    ...overrides,
  };
}

test('complete synthetic MTN first-market quarterly evidence passes shape only', () => {
  const evidence = input();
  const result = checkMtnQuarterlyUpdateEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.equal(result.engineeringOnly, true);
  assert.equal(result.evidence, evidence);
});

test('quarterly refresh evidence is not forced for every tier or prior market issuance', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    issuerTier: ev('mature_first_class'),
    registrationArrangement: ev('dfi_unified'),
    firstMarketIssuance: ev('prior_market_issuance_exists'),
  }));
  assert.equal(result.decision, 'evidence_shape_pass');
});

test('unknown registration or market history and missing citations remain needs_review', () => {
  const unknown = checkMtnQuarterlyUpdateEvidence(input({
    issuerTier: ev('unknown'),
    registrationArrangement: ev('unknown'),
    firstMarketIssuance: ev('unknown'),
  }));
  assert.equal(unknown.decision, 'needs_review');
  assert.ok(unknown.reasons.includes('issuer_tier_or_registration_arrangement_unresolved'));
  assert.ok(unknown.reasons.includes('first_market_issuance_unresolved'));

  const uncited = checkMtnQuarterlyUpdateEvidence(input({
    quarterlyReportPublicationDate: { value: '2026-04-28', citations: [], uncertainty: 'clear' },
  }));
  assert.equal(uncited.decision, 'needs_review');
  assert.ok(uncited.reasons.includes('quarterly_report_publication_date_missing_uncited_or_uncertain'));
});

test('blank or whitespace issuer identity remains needs_review despite a citation', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({ issuerEntityId: ev('   ') }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('issuer_entity_id_empty'));
});

test('a report published after an issuance cannot establish that it was then available', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    quarterlyReportPublicationDate: ev('2026-06-16'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('quarterly_report_postdates_issuance_event'));
});

test('a later report still cannot be backdated for an issuer with earlier market issuances', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    firstMarketIssuance: ev('prior_market_issuance_exists'),
    quarterlyReportPublicationDate: ev('2026-06-16'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('quarterly_report_postdates_issuance_event'));
});

test('a report disclosed on the same day as issuance cannot establish the required order', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    quarterlyReportPublicationDate: ev('2026-06-15'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('quarterly_report_publication_not_before_issuance_event'));
});

test('document coverage ending before the reported quarter remains review, not a compliance verdict', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    documentCoveragePeriod: ev({ periodId: 'document-coverage-2025', startDate: '2023-01-01', endDate: '2025-12-31' }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('document_coverage_ends_before_latest_quarterly_period'));
});

test('an issuance whose asserted scope is not interbank institutional remains needs_review', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    investorScope: ev('other'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('investor_scope_not_interbank_institutional'));
});

test('rewriting the trigger as the first tranche under a new registration notice is rejected', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    triggerBasis: ev('registration_notice_first_period'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('trigger_basis_rewritten_to_registration_notice_first_period'));
});

test('an unresolved trigger basis cannot be treated as the NA022 reading', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    triggerBasis: ev('unknown'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('trigger_basis_unresolved_or_not_na022_reading'));
});

test('a claimed NA058 exception is never a machine approval even with complete limit evidence', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({ na058Exception: na058Exception() }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('na058_exception_requires_human_review'));
  assert.ok(result.reasons.includes('na058_na022_intersection_requires_human_review'));
  assert.ok(!result.reasons.includes('na058_exception_issuer_not_first_class_or_listed_company'));
});

test('NA058 is not extended to issuers that are neither first-class nor listed', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    na058Exception: na058Exception({ issuerBasis: ev('other') }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('na058_exception_issuer_not_first_class_or_listed_company'));
});

test('NA058 is not extended to half-year or annual reports', () => {
  for (const reportKind of ['half_year', 'annual'] as const) {
    const result = checkMtnQuarterlyUpdateEvidence(input({
      na058Exception: na058Exception({ reportKind: ev(reportKind) }),
    }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('na058_exception_report_kind_not_quarterly'));
  }
});

test('NA058 cannot be expanded beyond the movement-analysis update', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    na058Exception: na058Exception({ scope: ev('entire_quarterly_section') }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('na058_exception_scope_expanded_beyond_movement_analysis'));
});

test('NA058 keeps the mandatory latest-statement listing and source', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    na058Exception: na058Exception({
      statementListing: {
        latestStatements: ev(false),
        dataSource: ev(false),
        consolidatedAndParent: ev(false),
      },
    }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('na058_exception_latest_statements_listing_missing'));
  assert.ok(result.reasons.includes('na058_exception_statement_data_source_missing'));
  assert.ok(result.reasons.includes('na058_exception_consolidated_and_parent_statements_missing'));
});

test('a listed company under enforcement is excluded from the NA058 exception', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    na058Exception: na058Exception({
      issuerBasis: ev('listed_company'),
      listedCompanyCleanRecord: ev(false),
    }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('na058_exception_enforcement_record_excluded'));
});

test('a listed company may not claim the exception with an unresolved clean-record status', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    na058Exception: na058Exception({
      issuerBasis: ev('listed_company'),
      listedCompanyCleanRecord: ev<'not_applicable'>('not_applicable'),
    }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('na058_exception_listed_company_clean_record_required'));
});

test('the NA058 compilation file date cannot prove its 2026 effect', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    na058Exception: na058Exception({ effectivityBasis: ev('compilation_file_date') }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('na058_exception_effectivity_from_compilation_file_date_not_allowed'));
});

test('an unclaimed or explicitly non-claimed NA058 exception keeps the base shape result', () => {
  const unclaimed = checkMtnQuarterlyUpdateEvidence(input({ na058Exception: null }));
  assert.equal(unclaimed.decision, 'evidence_shape_pass');
  const notClaimed = checkMtnQuarterlyUpdateEvidence(input({
    na058Exception: na058Exception({ claimed: ev(false) }),
  }));
  assert.equal(notClaimed.decision, 'evidence_shape_pass');
});

test('contradictory source-backed assertions are evidence_conflict', () => {
  const firstMarket = ev<'first_market_issuance' | 'prior_market_issuance_exists' | 'unknown'>('first_market_issuance');
  firstMarket.conflictingAssertions = [{
    value: 'prior_market_issuance_exists',
    citations: [{ ...citation, quote: 'Synthetic conflicting assertion only.' }],
  }];
  const result = checkMtnQuarterlyUpdateEvidence(input({ firstMarketIssuance: firstMarket }));
  assert.equal(result.decision, 'evidence_conflict');
  assert.ok(result.reasons.includes('first_market_issuance_status_cited_assertions_conflict'));
});

test('identical period assertions with different object references and key order are not conflicts', () => {
  const evidence = input();
  evidence.latestQuarterlyReportPeriod.conflictingAssertions = [{
    value: { endDate: '2026-03-31', periodId: '2026-q1', startDate: '2026-01-01' },
    citations: [{ ...citation, quote: 'Synthetic duplicate period assertion.' }],
  }];
  evidence.documentCoveragePeriod.conflictingAssertions = [{
    value: { endDate: '2026-03-31', startDate: '2023-01-01', periodId: 'document-coverage-2026-q1' },
    citations: [{ ...citation, quote: 'Synthetic duplicate coverage assertion.' }],
  }];
  const result = checkMtnQuarterlyUpdateEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.deepEqual(result.reasons, []);
});

test('a genuinely different cited period assertion is evidence_conflict', () => {
  const reportPeriod = ev({ periodId: '2026-q1', startDate: '2026-01-01', endDate: '2026-03-31' });
  reportPeriod.conflictingAssertions = [{
    value: { periodId: '2025-q4', startDate: '2025-10-01', endDate: '2025-12-31' },
    citations: [{ ...citation, quote: 'Synthetic conflicting quarterly period.' }],
  }];
  const result = checkMtnQuarterlyUpdateEvidence(input({ latestQuarterlyReportPeriod: reportPeriod }));
  assert.equal(result.decision, 'evidence_conflict');
  assert.ok(result.reasons.includes('latest_quarterly_report_period_cited_assertions_conflict'));
});

test('an unanchored opposing assertion cannot be elevated to evidence_conflict', () => {
  const firstMarket = ev<'first_market_issuance' | 'prior_market_issuance_exists' | 'unknown'>('first_market_issuance');
  firstMarket.conflictingAssertions = [{ value: 'prior_market_issuance_exists', citations: [] }];
  const result = checkMtnQuarterlyUpdateEvidence(input({ firstMarketIssuance: firstMarket }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('first_market_issuance_status_conflict_assertion_uncited_or_unanchored'));
});

test('a cited opposing assertion without a cited primary assertion remains needs_review', () => {
  const firstMarket = ev<'first_market_issuance' | 'prior_market_issuance_exists' | 'unknown'>('first_market_issuance');
  firstMarket.citations = [];
  firstMarket.conflictingAssertions = [{
    value: 'prior_market_issuance_exists',
    citations: [{ ...citation, quote: 'Synthetic cited opposing assertion only.' }],
  }];
  const result = checkMtnQuarterlyUpdateEvidence(input({ firstMarketIssuance: firstMarket }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(!result.reasons.includes('first_market_issuance_status_cited_assertions_conflict'));
});

test('invalid dates, ranges, and source hashes remain needs_review', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    issuanceEventDate: ev('2026-02-30'),
    latestQuarterlyReportPeriod: ev({ periodId: '', startDate: '2026-04-01', endDate: '2026-03-31' }),
    quarterlyReportSourceSha256: ev('bad-hash'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('issuance_event_date_invalid'));
  assert.ok(result.reasons.includes('latest_quarterly_report_period_invalid'));
  assert.ok(result.reasons.includes('quarterly_report_source_sha256_invalid'));
});
