import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCreditFacilityAmounts,
  factCandidateStatus,
  factIdentityKey,
  groupFactCandidates,
  normalizeDecimal,
  parseCacheKey,
  type CreditFacilityAmount,
  type FactCandidate,
  type FactIdentity,
} from './facts.js';

const identity = (overrides: Partial<FactIdentity> = {}): FactIdentity => ({
  accountId: 'synthetic-account-a',
  entityId: 'synthetic-issuer',
  scope: 'consolidated',
  metric: 'operating_revenue',
  period: { start: '2025-01-01', end: '2025-12-31' },
  currency: 'CNY',
  unit: 'ten_thousand',
  basis: 'accounting_standard_x',
  dataVersion: 'material-v1',
  ...overrides,
});

const candidate = (value: string, overrides: Partial<FactCandidate> = {}): FactCandidate => ({
  candidateId: `synthetic-${value}`,
  identity: identity(),
  value: { kind: 'known', decimalOrText: value },
  source: { kind: 'audited', sourceId: 'synthetic-audit', observedAt: '2026-01-01T00:00:00Z', validAsOf: '2025-12-31' },
  confidence: 0.99,
  auditCheck: {
    kind: 'source_anchor_review', evidenceId: 'synthetic-anchor-check', verifierId: 'synthetic-reviewer', verifierRole: 'internal_reviewer',
  },
  ...overrides,
});

test('fact identity keeps entity, scope, period, currency, unit, basis, version and account separate', () => {
  const base = identity();
  for (const changed of [
    { accountId: 'synthetic-account-b' },
    { entityId: 'synthetic-parent' },
    { scope: 'parent_only' },
    { period: { asOf: '2025-12-31' } },
    { currency: 'USD' },
    { unit: 'yuan' },
    { basis: 'cash_basis' },
    { dataVersion: 'material-v2' },
  ]) assert.notEqual(factIdentityKey(base), factIdentityKey(identity(changed)));
  assert.notEqual(factIdentityKey(base), factIdentityKey(identity({ metric: 'net_profit' })));
});

test('different same-name scopes remain separate and same-key disagreement retains both candidates', () => {
  const consolidated = candidate('100');
  const disagreement = candidate('101', { candidateId: 'synthetic-user-correction', source: {
    kind: 'user_statement', sourceId: 'synthetic-user-note', observedAt: '2026-02-01T00:00:00Z',
  }, auditCheck: null });
  const parentOnly = candidate('100', { candidateId: 'synthetic-parent-fact', identity: identity({ scope: 'parent_only' }) });
  const groups = groupFactCandidates([consolidated, disagreement, parentOnly]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.candidates.length === 2)?.status, 'conflicted');
  assert.equal(groups.find((group) => group.candidates.length === 2)?.candidates.length, 2);
  assert.equal(groups.find((group) => group.candidates.length === 1)?.status, 'single');
});

test('template/reference examples cannot enter issuer fact groups', () => {
  const template = candidate('999', { source: {
    kind: 'template', sourceId: 'synthetic-template-example', observedAt: '2026-01-01T00:00:00Z',
  } });
  const reference = candidate('888', { source: {
    kind: 'reference', sourceId: 'synthetic-reference-issuer', observedAt: '2026-01-01T00:00:00Z',
  } });
  assert.deepEqual(groupFactCandidates([template, reference]), []);
  assert.throws(() => factCandidateStatus(template), /NON_ISSUER_FACT_SOURCE/);
});

test('user statements remain asserted and uncertain or low-confidence audit facts stay pending', () => {
  const userStatement = candidate('100', { source: {
    kind: 'user_statement', sourceId: 'synthetic-user-note', observedAt: '2026-02-01T00:00:00Z',
  } });
  assert.equal(factCandidateStatus(userStatement), 'user_asserted');
  assert.equal(factCandidateStatus(candidate('100', { confidence: 0.4 })), 'needs_confirmation');
  assert.equal(factCandidateStatus(candidate('100', { uncertainty: 'synthetic OCR ambiguity' })), 'needs_confirmation');
  assert.equal(factCandidateStatus(candidate('100')), 'verified');
  assert.equal(factCandidateStatus(candidate('100', { auditCheck: null })), 'extracted');
  assert.throws(() => factCandidateStatus(candidate('100', { confidence: Number.NaN })), /INVALID_CONFIDENCE/);
  assert.throws(() => factCandidateStatus(candidate('100', { confidence: Number.POSITIVE_INFINITY })), /INVALID_CONFIDENCE/);
  assert.throws(() => factCandidateStatus(candidate('100', { confidence: 1.01 })), /INVALID_CONFIDENCE/);
});

test('zero, unknown and not-applicable values remain distinct', () => {
  const zero = candidate('0');
  const unknown = candidate('ignored', { candidateId: 'synthetic-unknown', value: { kind: 'unknown' } });
  const notApplicable = candidate('ignored', { candidateId: 'synthetic-na', value: { kind: 'not_applicable' } });
  assert.equal(factCandidateStatus(zero), 'verified');
  assert.equal(factCandidateStatus(unknown), 'needs_confirmation');
  assert.equal(factCandidateStatus(notApplicable), 'extracted');
  assert.equal(groupFactCandidates([zero])[0]?.status, 'single');
  assert.equal(groupFactCandidates([unknown])[0]?.status, 'needs_confirmation');
  assert.equal(groupFactCandidates([notApplicable])[0]?.status, 'single');
  assert.equal(groupFactCandidates([zero, notApplicable])[0]?.status, 'conflicted');
});

const facility = (amount: string | null, overrides: Partial<CreditFacilityAmount> = {}): CreditFacilityAmount => ({
  bank: 'synthetic-bank', asOf: '2025-12-31', currency: 'CNY', unit: 'hundred_million',
  basis: 'committed_credit', scope: 'consolidated', amount, ...overrides,
});

test('credit facility arithmetic uses exact decimals and requires matching context', () => {
  assert.deepEqual(checkCreditFacilityAmounts(facility('100.10'), facility('80.05'), facility('20.05')),
    { status: 'consistent', statedTotal: '100.1', calculatedTotal: '100.1' });
  assert.deepEqual(checkCreditFacilityAmounts(facility('100'), facility('80'), facility('40')),
    { status: 'conflicted', statedTotal: '100', calculatedTotal: '120' });
  assert.deepEqual(checkCreditFacilityAmounts(facility('100'), facility('80', { bank: 'synthetic-other-bank' }), facility('20')),
    { status: 'needs_confirmation', reason: 'context_mismatch' });
  assert.deepEqual(checkCreditFacilityAmounts(facility('100'), facility('80'), facility(null)),
    { status: 'needs_confirmation', reason: 'missing_amount' });
  assert.equal(normalizeDecimal('9007199254740993.10'), '9007199254740993.1');
});

test('parse cache key is content/version/account scoped and ignores filename/project', () => {
  const base = {
    accountId: 'synthetic-account-a', fileSha256: 'A'.repeat(64), parserVersion: 'p1', ocrVersion: 'o1', basisVersion: 'b1',
  };
  assert.equal(parseCacheKey({ ...base, filename: 'one.pdf', projectId: 'synthetic-project-a' }),
    parseCacheKey({ ...base, filename: 'renamed.pdf', projectId: 'synthetic-project-b' }));
  assert.notEqual(parseCacheKey(base), parseCacheKey({ ...base, accountId: 'synthetic-account-b' }));
  assert.notEqual(parseCacheKey(base), parseCacheKey({ ...base, parserVersion: 'p2' }));
  assert.throws(() => parseCacheKey({ ...base, fileSha256: 'not-a-hash' }), /INVALID_SHA256/);
  assert.throws(() => parseCacheKey({ ...base, accountId: '  ' }), /INVALID_CACHE_IDENTITY/);
  assert.throws(() => parseCacheKey({ ...base, basisVersion: '' }), /INVALID_CACHE_IDENTITY/);
});
