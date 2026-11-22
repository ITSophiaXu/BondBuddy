import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveFactEvidenceReviewDetermination,
  type FactEvidenceReviewPin,
  type FactEvidenceReviewSeamRow,
} from './fact-evidence-review-seam.js';

const sha = (value: string) =>
  value
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^a-f0-9]/g, 'a');

function pin(overrides: Partial<FactEvidenceReviewPin> = {}): FactEvidenceReviewPin {
  return {
    candidateId: 'candidate-1',
    evidenceContextSetId: 'context-1',
    evidenceSetSha256: sha('evidence'),
    candidateIdentitySha256: sha('identity'),
    sourceKind: 'audited',
    inputRevision: 3,
    inputHash: sha('input'),
    materialId: 'material-1',
    materialVersion: 2,
    materialSha256: sha('material'),
    snapshotId: 'snapshot-1',
    parserVersion: 'parser-1.0.7',
    parseResponseSha256: sha('response'),
    ...overrides,
  };
}

function row(overrides: Partial<FactEvidenceReviewSeamRow> = {}): FactEvidenceReviewSeamRow {
  return {
    reviewId: 'review-1',
    outcome: 'evidence_impact_reviewed',
    candidateId: 'candidate-1',
    evidenceContextSetId: 'context-1',
    evidenceSetSha256: sha('evidence'),
    candidateIdentitySha256: sha('identity'),
    sourceKind: 'audited',
    inputRevision: 3,
    inputHash: sha('input'),
    materialId: 'material-1',
    materialVersion: 2,
    materialSha256: sha('material'),
    snapshotId: 'snapshot-1',
    parserVersion: 'parser-1.0.7',
    parseResponseSha256: sha('response'),
    reviewerUserId: 'reviewer-1',
    reviewerGrantId: 'grant-1',
    reviewedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

test('an audited exact current review is the only offerable state', () => {
  const result = deriveFactEvidenceReviewDetermination(row(), pin());
  assert.equal(result.reviewedAndCurrent, true);
  assert.equal(result.offerable, true);
  assert.equal(result.externalImpactReviewed, false);
  assert.equal(result.reason, 'review_current');
  assert.equal(result.reviewId, 'review-1');
  assert.equal(result.verificationEffect, 'none');
  assert.equal(result.originalFieldsPreserved, true);
});

test('an external review certifies evidence and impact only, never offerable as audited', () => {
  const result = deriveFactEvidenceReviewDetermination(
    row({ sourceKind: 'external', outcome: 'external_evidence_impact_reviewed' }),
    pin({ sourceKind: 'external' }),
  );
  assert.equal(result.reviewedAndCurrent, true);
  assert.equal(result.externalImpactReviewed, true);
  assert.equal(result.offerable, false);
  assert.equal(result.sourceKind, 'external');
  assert.equal(result.reason, 'external_impact_reviewed');
});

test('needs_more_evidence is current-but-not-reviewed and never offerable', () => {
  const result = deriveFactEvidenceReviewDetermination(
    row({ outcome: 'needs_more_evidence' }),
    pin(),
  );
  assert.equal(result.reviewedAndCurrent, false);
  assert.equal(result.offerable, false);
  assert.equal(result.externalImpactReviewed, false);
  assert.equal(result.reason, 'review_needs_more_evidence');
});

test('a missing current review is not offerable', () => {
  const result = deriveFactEvidenceReviewDetermination(null, pin());
  assert.equal(result.reviewedAndCurrent, false);
  assert.equal(result.offerable, false);
  assert.equal(result.reason, 'no_current_exact_review');
  assert.equal(result.outcome, null);
});

test('any pin drift between the run and the reviewed row fails closed', () => {
  const drifts: Partial<FactEvidenceReviewPin>[] = [
    { candidateId: 'candidate-2' },
    { evidenceContextSetId: 'context-2' },
    { evidenceSetSha256: sha('other') },
    { candidateIdentitySha256: sha('other') },
    { sourceKind: 'external' },
    { inputRevision: 4 },
    { inputHash: sha('other') },
    { materialId: 'material-2' },
    { materialVersion: 3 },
    { materialSha256: sha('other') },
    { snapshotId: 'snapshot-2' },
    { parserVersion: 'parser-2.0.0' },
    { parseResponseSha256: sha('other') },
  ];
  for (const drift of drifts) {
    const result = deriveFactEvidenceReviewDetermination(row(), pin(drift));
    assert.equal(result.reviewedAndCurrent, false, JSON.stringify(drift));
    assert.equal(result.offerable, false, JSON.stringify(drift));
    assert.equal(result.reason, 'review_pin_mismatch', JSON.stringify(drift));
  }
});

test('an outcome that contradicts its source kind fails closed even if pins match', () => {
  const result = deriveFactEvidenceReviewDetermination(
    row({ outcome: 'evidence_impact_reviewed', sourceKind: 'external' }),
    pin({ sourceKind: 'external' }),
  );
  assert.equal(result.reviewedAndCurrent, false);
  assert.equal(result.offerable, false);
  assert.equal(result.reason, 'review_pin_mismatch');
});
