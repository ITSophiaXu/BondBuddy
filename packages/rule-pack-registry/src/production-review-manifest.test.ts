import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { productionReviewContentHash, productionReviewContentHashMatches } from './index.js';

const examples = JSON.parse(readFileSync(new URL('../../contracts/examples/production-review-manifest.json', import.meta.url), 'utf8')) as {
  synthetic: boolean;
  cases: Array<{ name: string; value: Record<string, unknown> }>;
};
assert.equal(examples.synthetic, true);
const base = examples.cases.find(example => example.name === 'production-review-manifest-content-only-valid-synthetic')?.value;
if (!base) throw new Error('missing synthetic review manifest fixture');

function copy(): Record<string, any> {
  return structuredClone(base!);
}

test('review hash covers frozen content but not manifest or release identity', () => {
  const manifest = copy();
  const digest = productionReviewContentHash(manifest);
  assert.equal(manifest.content_sha256, digest, 'committed synthetic fixture pins its actual review content');
  manifest.content_sha256 = digest;
  assert.equal(productionReviewContentHashMatches(manifest), true);

  const newEnvelope = copy();
  newEnvelope.manifest_id = 'another-synthetic-manifest';
  newEnvelope.manifest_version = 2;
  newEnvelope.content_sha256 = digest;
  assert.equal(productionReviewContentHash(newEnvelope), digest);
  assert.equal(productionReviewContentHashMatches(newEnvelope), true);

  const invalidReleaseCycle = copy();
  invalidReleaseCycle.release_event_id = 'synthetic-release';
  assert.equal(productionReviewContentHashMatches(invalidReleaseCycle), false);
});

test('review hash detects pinned source, sample and scope drift', () => {
  const manifest = copy();
  manifest.content_sha256 = productionReviewContentHash(manifest);
  const variants = [
    (next: Record<string, any>) => { next.content.source_date_evidence[0].source_check_sha256 = '0'.repeat(64); },
    (next: Record<string, any>) => { next.content.source_date_evidence[0].source_document_sha256 = '0'.repeat(64); },
    (next: Record<string, any>) => { next.content.authorized_real_sample_evidence[0].sample_evidence_sha256 = '0'.repeat(64); },
    (next: Record<string, any>) => { next.content.authorized_real_sample_evidence[0].polarity = 'positive'; },
    (next: Record<string, any>) => { next.content.applicability_scope.instruments = ['scp']; },
    (next: Record<string, any>) => { next.content.source_date_evidence[0].applicability_basis.basis_sha256 = '0'.repeat(64); },
    (next: Record<string, any>) => { next.content.source_date_evidence[0].applicability_basis.applicability_scope.instruments = ['scp']; },
    (next: Record<string, any>) => { next.content.chapter_template.sha256 = '0'.repeat(64); },
  ];
  for (const change of variants) {
    const next = structuredClone(manifest);
    change(next);
    assert.equal(productionReviewContentHashMatches(next), false);
  }
});

test('review hash rejects noncanonical references and invented legal dates', () => {
  const duplicate = copy();
  duplicate.content.applicability_scope.instruments = ['mtn', 'mtn'];
  assert.throws(() => productionReviewContentHash(duplicate), /INVALID_PRODUCTION_REVIEW_MANIFEST/);

  const reversed = copy();
  reversed.content.source_date_evidence.reverse();
  assert.equal(productionReviewContentHashMatches(reversed), false);

  const invented = copy();
  invented.content.source_date_evidence[1].legal_effective_date = '2026-09-20';
  assert.equal(productionReviewContentHashMatches(invented), false);

  const undatedWithoutBasis = copy();
  undatedWithoutBasis.content.source_date_evidence[0].legal_effective_date = null;
  undatedWithoutBasis.content.source_date_evidence[0].legal_effective_date_basis = 'unknown';
  delete undatedWithoutBasis.content.source_date_evidence[0].applicability_basis;
  assert.equal(productionReviewContentHashMatches(undatedWithoutBasis), false);

  const unsupportedTransition = copy();
  unsupportedTransition.content.source_date_evidence[0].transition_from_date = '2026-03-23';
  assert.equal(productionReviewContentHashMatches(unsupportedTransition), false);

  const reversedMethodWindow = copy();
  reversedMethodWindow.content.source_date_evidence[1].approved_method_window.enabled_until = '2026-09-19';
  assert.equal(productionReviewContentHashMatches(reversedMethodWindow), false);
});

test('date contract keeps legal effectivity separate from reviewed applicability and method window', () => {
  const explicitGuidance = copy();
  explicitGuidance.content.source_date_evidence[0].source_kind = 'interpretive_guidance';
  assert.match(productionReviewContentHash(explicitGuidance), /^[a-f0-9]{64}$/);

  const pendingMethod = copy();
  pendingMethod.content.source_date_evidence[1].approved_method_window = null;
  assert.match(productionReviewContentHash(pendingMethod), /^[a-f0-9]{64}$/);
  assert.notEqual(productionReviewContentHash(pendingMethod), productionReviewContentHash(copy()));

  const undatedRule = copy();
  undatedRule.content.source_date_evidence[0].source_kind = 'interpretive_guidance';
  undatedRule.content.source_date_evidence[0].legal_effective_date = null;
  undatedRule.content.source_date_evidence[0].legal_effective_date_basis = 'unknown';
  undatedRule.content.source_date_evidence[0].effective_date_derivation_evidence = [];
  assert.match(productionReviewContentHash(undatedRule), /^[a-f0-9]{64}$/);
  assert.equal(undatedRule.content.source_date_evidence[0].legal_effective_date, null, 'internal applicability basis never fabricates a legal date');

  const fakeTemplateDate = copy();
  fakeTemplateDate.content.source_date_evidence[0].source_kind = 'template';
  assert.equal(productionReviewContentHashMatches(fakeTemplateDate), false);
});
