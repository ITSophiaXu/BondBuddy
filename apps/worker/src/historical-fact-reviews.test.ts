import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { factIdentityKey } from '@bondbuddy/domain/facts';
import { updateContentHash } from '@bondbuddy/domain/historical-update';
import type { StoredFactCandidate } from './fact-repository.js';
import {
  readHistoricalFactReviews,
  historicalReviewAllowsExistingFact,
} from './historical-fact-reviews.js';

function setup(kind: 'audited' | 'external' = 'audited') {
  const input = JSON.parse(
    readFileSync(
      new URL('../../../tests/fixtures/historical-update/input.json', import.meta.url),
      'utf8',
    ),
  );
  const f = input.facts[0];
  const fact: StoredFactCandidate = {
    candidate: { ...f.candidate, source: { ...f.candidate.source, kind } },
    provenance: {
      status: f.status,
      uncertainty: [],
      materialId: f.evidence[0].materialId,
      materialVersion: 1,
      sourceObservedAt: f.candidate.source.observedAt,
      createdAt: '2026-09-29T00:00:00Z',
      evidence: f.evidence.map((a: Record<string, unknown>) => ({
        evidence_id: a.recordId,
        material_id: a.materialId,
        material_version: a.materialVersion,
        content_hash: a.contentHash,
        locator_type: a.locatorType,
        locator: a.locator,
        literal_quote: a.literalQuote,
        extraction_method: 'native_text',
        extraction_version: a.extractionVersion,
        confidence: 1,
        uncertainty: [],
      })),
    },
  };
  const scope = {
    ownerUserId: fact.candidate.identity.accountId,
    projectId: 'project-1',
    inputRevision: 1,
    inputHash: '1'.repeat(64),
  };
  const body = {
    schema_version: 'fact-evidence-context-v1',
    owner_user_id: scope.ownerUserId,
    project_id: scope.projectId,
    input_revision: scope.inputRevision,
    input_hash: scope.inputHash,
    candidate_id: fact.candidate.candidateId,
    candidate_identity_sha256: createHash('sha256')
      .update(factIdentityKey(fact.candidate.identity))
      .digest('hex'),
    fact_identity: fact.candidate.identity,
    source_kind: kind,
    material_id: fact.provenance.materialId,
    material_version: 1,
    material_sha256: fact.provenance.evidence[0]!.content_hash,
    snapshot_id: 'snapshot-1',
    parser_version: 'synthetic-parser-1',
    parse_response_sha256: '2'.repeat(64),
    completeness_status: 'complete',
    reviewable: true,
  };
  const sha = updateContentHash(body),
    context = {
      id: 'context-1',
      candidate_id: fact.candidate.candidateId,
      evidence_set_sha256: sha,
      has_recorded_review: true,
      manifest: { ...body, evidence_set_sha256: sha },
    };
  const review: Record<string, unknown> = {
    review_id: 'review-1',
    outcome: kind === 'audited' ? 'evidence_impact_reviewed' : 'external_evidence_impact_reviewed',
    candidate_id: body.candidate_id,
    evidence_context_set_id: context.id,
    evidence_set_sha256: sha,
    candidate_identity_sha256: body.candidate_identity_sha256,
    source_kind: kind,
    input_revision: 1,
    input_hash: scope.inputHash,
    material_id: body.material_id,
    material_version: 1,
    material_sha256: body.material_sha256,
    snapshot_id: body.snapshot_id,
    parser_version: body.parser_version,
    parse_response_sha256: body.parse_response_sha256,
    reviewer_user_id: 'reviewer-1',
    reviewer_grant_id: 'grant-1',
    reviewed_at: '2026-09-29T00:00:00Z',
  };
  const state = { contexts: [context], reviews: [review] },
    queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      assert.deepEqual(values.slice(0, 2), [scope.ownerUserId, scope.projectId]);
      if (sql.includes('FROM bb_current_fact_evidence_reviews')) return { rows: state.reviews };
      assert.ok(sql.includes('FROM bb_fact_evidence_context_sets'));
      assert.deepEqual(values.slice(3, 5), [scope.inputRevision, scope.inputHash]);
      return { rows: state.contexts };
    },
  };
  return { fact, scope, state, pool, queries };
}

test('exact audited context/review is pinned without changing original candidates; replay selects frozen IDs', async () => {
  const s = setup(),
    before = structuredClone(s.fact),
    first = await readHistoricalFactReviews(s, s.scope, [s.fact]);
  assert.equal(first.entries[0]!.determination!.offerable, true);
  assert.equal(historicalReviewAllowsExistingFact(first, s.fact.candidate.candidateId), true);
  assert.deepEqual(await readHistoricalFactReviews(s, s.scope, [s.fact], first), first);
  assert.deepEqual(s.queries.at(-2)!.values[5], ['context-1']);
  assert.deepEqual(s.fact, before);
});
test('external impact review stays external and never claims audited eligibility', async () => {
  const s = setup('external'),
    before = structuredClone(s.fact),
    r = await readHistoricalFactReviews(s, s.scope, [s.fact]);
  assert.equal(r.entries[0]!.determination!.offerable, false);
  assert.equal(r.entries[0]!.determination!.externalImpactReviewed, true);
  assert.equal(historicalReviewAllowsExistingFact(r, s.fact.candidate.candidateId), true);
  assert.deepEqual(s.fact, before);
});
test('missing context is frozen as missing; never fetch later evidence on recovery', async () => {
  const s = setup();
  s.state.contexts = [];
  const first = await readHistoricalFactReviews(s, s.scope, [s.fact]);
  assert.equal(first.entries[0]!.pin, null);
  assert.equal(historicalReviewAllowsExistingFact(first, s.fact.candidate.candidateId), true);
  s.queries.length = 0;
  assert.deepEqual(await readHistoricalFactReviews(s, s.scope, [s.fact], first), first);
  assert.equal(s.queries.length, 0);
});
test('no prior review is not a new manual gate, but a withdrawn prior review cannot silently fall back', async () => {
  const s = setup();
  s.state.reviews = [];
  s.state.contexts[0]!.has_recorded_review = false;
  const missing = await readHistoricalFactReviews(s, s.scope, [s.fact]);
  assert.equal(historicalReviewAllowsExistingFact(missing, s.fact.candidate.candidateId), true);
  s.state.contexts[0]!.has_recorded_review = true;
  const withdrawn = await readHistoricalFactReviews(s, s.scope, [s.fact]);
  assert.equal(historicalReviewAllowsExistingFact(withdrawn, s.fact.candidate.candidateId), false);
});
test('negative or pin-mismatched reviews restrict the candidate', async () => {
  for (const bad of ['needs_more_evidence', 'wrong_input']) {
    const s = setup();
    if (bad === 'needs_more_evidence') s.state.reviews[0]!.outcome = bad;
    else s.state.reviews[0]!.input_hash = 'f'.repeat(64);
    const r = await readHistoricalFactReviews(s, s.scope, [s.fact]);
    assert.equal(historicalReviewAllowsExistingFact(r, s.fact.candidate.candidateId), false, bad);
  }
});
test('withdrawal, grant/source invalidation, review replacement and set drift reject frozen replay', async () => {
  for (const change of ['withdrawn', 'replacement', 'set_changed', 'set_missing']) {
    const s = setup();
    const first = await readHistoricalFactReviews(s, s.scope, [s.fact]);
    if (change === 'withdrawn') s.state.reviews = [];
    if (change === 'replacement') s.state.reviews[0]!.review_id = 'review-2';
    if (change === 'set_changed') s.state.contexts[0]!.id = 'context-2';
    if (change === 'set_missing') s.state.contexts = [];
    await assert.rejects(
      readHistoricalFactReviews(s, s.scope, [s.fact], first),
      /UPDATE_FACT_EVIDENCE_REVIEW_CHANGED/,
      change,
    );
  }
});
test('context hash, account/input/material scope and partial checkpoint corruption fail closed', async () => {
  for (const key of ['owner_user_id', 'input_hash', 'material_sha256', 'fact_identity']) {
    const s = setup();
    Object.assign(s.state.contexts[0]!.manifest, { [key]: 'wrong' });
    await assert.rejects(
      readHistoricalFactReviews(s, s.scope, [s.fact]),
      /UPDATE_FACT_EVIDENCE_CONTEXT_MISMATCH/,
      key,
    );
  }
  const s = setup(),
    first = await readHistoricalFactReviews(s, s.scope, [s.fact]);
  first.entries = [];
  await assert.rejects(
    readHistoricalFactReviews(s, s.scope, [s.fact], first),
    /UPDATE_FACT_EVIDENCE_REVIEW_CHANGED/,
  );
  const other = setup();
  Object.assign(other.fact.candidate.identity, { accountId: 'another-owner' });
  await assert.rejects(
    readHistoricalFactReviews(other, other.scope, [other.fact]),
    /UPDATE_FACT_EVIDENCE_CONTEXT_MISMATCH/,
  );
});
