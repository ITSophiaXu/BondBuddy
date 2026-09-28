import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkMtnQuarterlyUpdateEvidence,
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

function input(overrides: Partial<MtnQuarterlyUpdateEvidenceInput> = {}): MtnQuarterlyUpdateEvidenceInput {
  return {
    actualInstrument: ev('mtn'),
    issuerEntityId: ev('uscc:synthetic-issuer-001'),
    issuerTier: ev('basic_tier'),
    registrationArrangement: ev('basic_tier_unified_quota'),
    issuanceEventDate: ev('2026-06-15'),
    firstMarketIssuance: ev('first_market_issuance'),
    latestQuarterlyReportPeriod: ev({ periodId: '2026-q1', startDate: '2026-01-01', endDate: '2026-03-31' }),
    quarterlyReportPublicationDate: ev('2026-04-28'),
    quarterlyReportSourceSha256: ev('a'.repeat(64)),
    documentCoveragePeriod: ev({ periodId: 'document-coverage-2026-q1', startDate: '2023-01-01', endDate: '2026-03-31' }),
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

test('document coverage ending before the reported quarter remains review, not a compliance verdict', () => {
  const result = checkMtnQuarterlyUpdateEvidence(input({
    documentCoveragePeriod: ev({ periodId: 'document-coverage-2025', startDate: '2023-01-01', endDate: '2025-12-31' }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('document_coverage_ends_before_latest_quarterly_period'));
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

test('an unanchored opposing assertion cannot be elevated to evidence_conflict', () => {
  const firstMarket = ev<'first_market_issuance' | 'prior_market_issuance_exists' | 'unknown'>('first_market_issuance');
  firstMarket.conflictingAssertions = [{ value: 'prior_market_issuance_exists', citations: [] }];
  const result = checkMtnQuarterlyUpdateEvidence(input({ firstMarketIssuance: firstMarket }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('first_market_issuance_status_conflict_assertion_uncited_or_unanchored'));
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
