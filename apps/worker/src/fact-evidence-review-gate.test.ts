import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { FactIdentity } from '@bondbuddy/domain/facts';
import {
  createFactEvidenceReviewGuardedLoader,
  gateReviewedOfferableFacts,
  FACT_EVIDENCE_REVIEW_GATE_VERSION,
  type FactEvidenceReviewGatePool,
  type FactEvidenceReviewGateScope,
} from './fact-evidence-review-gate.js';
import type { FactEvidenceReviewDetermination, FactEvidenceReviewPin } from './fact-evidence-review-seam.js';
import type { StoredFactCandidate } from './fact-repository.js';
import type { HistoricalGenerationInput } from './historical-generation-input.js';
import type { StageContext } from './run-pipeline.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const scope: FactEvidenceReviewGateScope = { ownerUserId: 'owner-1', projectId: 'project-1', issuerEntityId: 'issuer-1' };
const unusedPool = {} as unknown as FactEvidenceReviewGatePool;

function identity(overrides: Partial<FactIdentity> = {}): FactIdentity {
  return { accountId: 'owner-1', entityId: 'issuer-1', scope: 'consolidated', metric: 'assets',
    period: { end: '2025-12-31' }, currency: 'CNY', unit: 'yuan', basis: 'balance_sheet', dataVersion: 'v1', ...overrides };
}

function fact(candidateId: string, overrides: Partial<FactIdentity> = {}, sourceKind: 'audited' | 'external' = 'audited'): StoredFactCandidate {
  return {
    candidate: { candidateId, identity: identity(overrides), value: { kind: 'known', decimalOrText: '100' },
      source: { kind: sourceKind, sourceId: 'src', observedAt: '2026-01-01T00:00:00.000Z' }, confidence: 0.73,
      uncertainty: 'ORIGINAL_WARNING', auditCheck: null },
    provenance: { status: 'needs_confirmation', evidence: [], uncertainty: ['ORIGINAL_WARNING'], materialId: 'm', materialVersion: 1,
      sourceObservedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function pin(candidateId: string): FactEvidenceReviewPin {
  return { candidateId, evidenceContextSetId: `ctx-${candidateId}`, evidenceSetSha256: sha(`evidence-${candidateId}`),
    candidateIdentitySha256: sha(`identity-${candidateId}`), sourceKind: 'audited', inputRevision: 3, inputHash: sha('input'),
    materialId: `m-${candidateId}`, materialVersion: 2, materialSha256: sha(`material-${candidateId}`), snapshotId: `s-${candidateId}`,
    parserVersion: 'parser-1.0.7', parseResponseSha256: sha(`response-${candidateId}`) };
}

function determination(candidateId: string, overrides: Partial<FactEvidenceReviewDetermination> = {}): FactEvidenceReviewDetermination {
  return { schemaVersion: 'fact-evidence-review-seam-v1', reviewedAndCurrent: true, offerable: true, externalImpactReviewed: false,
    outcome: 'evidence_impact_reviewed', sourceKind: 'audited', reason: 'review_current', reviewId: `review-${candidateId}`,
    reviewerUserId: 'reviewer-1', reviewerGrantId: 'grant-1', reviewedAt: '2026-09-29T00:00:00.000Z',
    evidenceContextSetId: `ctx-${candidateId}`, evidenceSetSha256: sha(`evidence-${candidateId}`), verificationEffect: 'none',
    originalFieldsPreserved: true, ...overrides };
}

function gate(facts: readonly StoredFactCandidate[], options: {
  pins?: (id: string) => FactEvidenceReviewPin | undefined;
  determinations?: (id: string) => FactEvidenceReviewDetermination;
  loadPins?: () => Promise<ReadonlyMap<string, FactEvidenceReviewPin>>;
  determine?: () => Promise<readonly FactEvidenceReviewDetermination[]>;
} = {}) {
  return gateReviewedOfferableFacts({
    pool: unusedPool,
    loadPins: options.loadPins ?? (async (_scope, ids) => new Map(ids.map(id => {
      const value = options.pins ? options.pins(id) : pin(id);
      return value ? [id, value] as const : null;
    }).filter((entry): entry is readonly [string, FactEvidenceReviewPin] => entry !== null))),
    determine: options.determine ?? (async (_pool, _scope, pins) => pins.map(p => options.determinations ? options.determinations(p.candidateId) : determination(p.candidateId))),
  }, scope, facts);
}

test('an audited current review is the only fact allowed into the generated set', async () => {
  const audited = fact('c1');
  const outcome = await gate([audited]);
  assert.equal(outcome.schemaVersion, FACT_EVIDENCE_REVIEW_GATE_VERSION);
  assert.deepEqual(outcome.facts.map(f => f.candidate.candidateId), ['c1']);
  assert.deepEqual(outcome.offeredCandidateIds, ['c1']);
  assert.deepEqual(outcome.excludedCandidateIds, []);
  assert.equal(outcome.originalFieldsPreserved, true);
  assert.equal(outcome.facts[0], audited, 'the retained candidate object is returned unchanged');
});

test('external, withdrawn, needs-more-evidence and missing-context candidates are excluded', async () => {
  const external = fact('external');
  const pending = fact('pending');
  const missing = fact('missing');
  const withdrawn = fact('withdrawn');
  const outcome = await gate([external, pending, missing, withdrawn], {
    pins: id => id === 'missing' ? undefined : pin(id),
    determinations: id => {
      if (id === 'external') return determination(id, { sourceKind: 'external', offerable: false,
        externalImpactReviewed: true, outcome: 'external_evidence_impact_reviewed', reason: 'external_impact_reviewed' });
      if (id === 'pending') return determination(id, { reviewedAndCurrent: false, offerable: false,
        outcome: 'needs_more_evidence', reason: 'review_needs_more_evidence' });
      if (id === 'withdrawn') return determination(id, { reviewedAndCurrent: false, offerable: false,
        outcome: null, sourceKind: null, reason: 'no_current_exact_review', reviewId: null, reviewerUserId: null,
        reviewerGrantId: null, reviewedAt: null });
      return determination(id);
    },
  });
  assert.deepEqual(outcome.facts, []);
  assert.deepEqual(outcome.offeredCandidateIds, []);
  assert.deepEqual([...outcome.excludedCandidateIds].sort(), ['external', 'missing', 'pending', 'withdrawn']);
  assert.equal(outcome.exclusionByCandidateId.external, 'external_impact_reviewed');
  assert.equal(outcome.exclusionByCandidateId.pending, 'review_needs_more_evidence');
  assert.equal(outcome.exclusionByCandidateId.missing, 'no_evidence_context_set');
  assert.equal(outcome.exclusionByCandidateId.withdrawn, 'no_current_exact_review');
});

test('one non-offerable member excludes the whole identity group instead of concealing it', async () => {
  const offerable = fact('a');
  const conflicted = fact('b');
  const outcome = await gate([offerable, conflicted], {
    determinations: id => id === 'b'
      ? determination(id, { reviewedAndCurrent: false, offerable: false, outcome: 'needs_more_evidence', reason: 'review_needs_more_evidence' })
      : determination(id),
  });
  assert.deepEqual(outcome.facts, []);
  assert.equal(outcome.exclusionByCandidateId.a, 'identity_group_not_fully_offerable');
  assert.equal(outcome.exclusionByCandidateId.b, 'review_needs_more_evidence');
});

test('a fully offerable identity group is kept together', async () => {
  const first = fact('a');
  const second = fact('b');
  const outcome = await gate([first, second]);
  assert.deepEqual(outcome.facts, [first, second]);
  assert.deepEqual([...outcome.offeredCandidateIds].sort(), ['a', 'b']);
});

test('non-issuer entity candidates are left untouched and never gate the run', async () => {
  const subsidiary = fact('subsidiary', { entityId: 'other-entity' });
  const audited = fact('c1');
  const outcome = await gate([subsidiary, audited]);
  assert.deepEqual(outcome.facts, [subsidiary, audited]);
  assert.deepEqual(outcome.offeredCandidateIds, ['c1']);
});

test('reader failure fails closed by withholding every issuer fact and keeping original objects', async () => {
  const audited = fact('c1');
  const subsidiary = fact('subsidiary', { entityId: 'other-entity' });
  const outcome = await gate([audited, subsidiary], { loadPins: async () => { throw new Error('db down'); } });
  assert.deepEqual(outcome.facts, [subsidiary]);
  assert.deepEqual(outcome.excludedCandidateIds, ['c1']);
  assert.equal(outcome.exclusionByCandidateId.c1, 'review_gate_unavailable');
  assert.equal(outcome.facts[0], subsidiary);
});

test('a determination/pin count mismatch fails closed', async () => {
  const outcome = await gate([fact('c1')], { determine: async () => [] });
  assert.deepEqual(outcome.facts, []);
  assert.equal(outcome.exclusionByCandidateId.c1, 'review_gate_unavailable');
});

test('the gate is read-only and idempotent across repeated calls', async () => {
  const audited = fact('c1');
  const facts = [audited];
  const first = await gate(facts);
  const second = await gate(facts);
  assert.deepEqual(second, first);
  assert.equal(audited.candidate.uncertainty, 'ORIGINAL_WARNING', 'original warning is preserved');
  assert.equal(audited.provenance.status, 'needs_confirmation', 'original status is preserved');
});

function inputWith(facts: readonly StoredFactCandidate[]): HistoricalGenerationInput {
  return { locked: { context: { ownerUserId: 'owner-1', projectId: 'project-1', issuerEntityId: 'issuer-1' } }, facts } as unknown as HistoricalGenerationInput;
}

const ctx = { pool: unusedPool } as unknown as StageContext;

test('the guarded loader leaves the input untouched when the guard is disabled', async () => {
  const input = inputWith([fact('c1')]);
  const load = createFactEvidenceReviewGuardedLoader(async () => input, { enabled: () => false,
    dependencies: { loadPins: async () => new Map(), determine: async () => [] } });
  const loaded = await load(ctx);
  assert.equal(loaded.facts, input.facts, 'disabled gate returns the exact input facts');
});

test('the guarded loader defaults to off when no enable predicate is installed', async () => {
  const input = inputWith([fact('c1')]);
  const load = createFactEvidenceReviewGuardedLoader(async () => input);
  assert.equal((await load(ctx)).facts, input.facts);
});

test('the guarded loader narrows facts to the offerable set when enabled and fails closed on reader error', async () => {
  const audited = fact('c1');
  const holder = fact('c2', { metric: 'revenue' });
  const input = inputWith([audited, holder]);
  const enabled = createFactEvidenceReviewGuardedLoader(async () => input, { enabled: () => true,
    dependencies: { loadPins: async () => new Map([['c1', pin('c1')], ['c2', pin('c2')]]),
      determine: async (_pool, _scope, pins) => pins.map(p => determination(p.candidateId, {
        offerable: p.candidateId === 'c1', outcome: p.candidateId === 'c1' ? 'evidence_impact_reviewed' : 'needs_more_evidence',
        reviewedAndCurrent: p.candidateId === 'c1', ...(p.candidateId === 'c1' ? {} : { reason: 'review_needs_more_evidence' as const }) })) } });
  assert.deepEqual((await enabled(ctx)).facts.map(f => f.candidate.candidateId), ['c1']);
  const failing = createFactEvidenceReviewGuardedLoader(async () => input, { enabled: () => true,
    dependencies: { loadPins: async () => { throw new Error('boom'); } } });
  assert.deepEqual((await failing(ctx)).facts, []);
});
