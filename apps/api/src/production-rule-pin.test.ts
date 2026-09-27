import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ReviewedRuleApplicabilityContextResult, RuleApplicabilityContextPin } from '@bondbuddy/rule-applicability-context';
import { inputManifestHash, loadExactReviewedContext, lockProductionRulePack,
  type ReviewedContextLoader, type RuleApplicabilityContextRef } from './production-rule-pin.js';
import type { VerifiedIssuerIdentityBinding } from './issuer-identity-binding.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const material = { material_id: 'material-1', material_version: 1, role: 'historical', sha256: sha('material') };
const identity: VerifiedIssuerIdentityBinding = {
  status: 'verified', record_id: 'identity-1', version: 1, content_hash: sha('identity'), entity_id: 'entity-1',
  issuer_display_name: 'Synthetic issuer', material_id: material.material_id, material_version: material.material_version,
  source_snapshot_id: 'snapshot-1', source_record_id: 'record-1', source_record_sha256: sha('record'),
  source_content_sha256: material.sha256, reviewed_by: 'reviewer-1', reviewed_at: '2026-09-28T00:00:00.000Z',
};
const contextPin = { context_id: 'context-1', version: 1, applicability: { market: 'sse', offering: 'private' } };
const ref: RuleApplicabilityContextRef = {
  context_id: 'context-1', version: 1, content_hash: inputManifestHash(contextPin),
  source_input_revision: 1, source_input_hash: sha('input'),
};
const current = { draftRevision: 1, materials: [material] };
const request = {
  market: 'sse' as const, offering: 'private' as const, instrument: 'ordinary-company-bond',
  documentStage: 'registration' as const, issuerScope: 'domestic-company', investorScope: 'professional',
  industry: 'industry-code-v1', specialFeatures: [], asOf: '2026-09-28',
};

function sourceDb() {
  let selectorCalled = false;
  const db = { async query(sql: string) {
    if (sql.includes('FROM bb_input_revisions')) return { rows: [{ input_hash: ref.source_input_hash,
      draft_revision: current.draftRevision, manifest: { draft_revision: current.draftRevision, materials: [material] },
      material_versions: [{ material_id: material.material_id, material_version: material.material_version }] }] };
    if (sql.includes('FROM bb_material_versions')) return { rows: [{ role: material.role, sha256: material.sha256, deleted_at: null }] };
    if (sql.includes('bb_rule_pack_production_release_events')) {
      selectorCalled = true;
      return { rows: [] };
    }
    throw new Error(`Unexpected query in production-rule-pin test: ${sql}`);
  } };
  return { db: db as unknown as Parameters<typeof loadExactReviewedContext>[0], selectorWasCalled: () => selectorCalled };
}

const approved = (pin: unknown): ReviewedRuleApplicabilityContextResult => ({
  status: 'approved', reasons: [], contextPin: pin as unknown as RuleApplicabilityContextPin & Record<string, unknown>,
  request,
} as ReviewedRuleApplicabilityContextResult);

test('approved loader result reaches the production selector after context-pin hash verification', async () => {
  const { db, selectorWasCalled } = sourceDb();
  const loader: ReviewedContextLoader = async () => approved(contextPin);
  const result = await lockProductionRulePack(db, { owner_user_id: 'owner-1', id: 'project-1', market: 'sse', offering: 'private' },
    current, identity, ref, loader);

  assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_registry_empty'] });
  assert.equal(selectorWasCalled(), true, 'the approved context should be passed to the existing production selector');
});

test('approved loader result with a mismatched context hash fails closed before selection', async () => {
  const { db, selectorWasCalled } = sourceDb();
  const loader: ReviewedContextLoader = async () => approved({ ...contextPin, version: 2 });
  const result = await loadExactReviewedContext(db, 'owner-1', 'project-1', ref, identity, current, loader);

  assert.deepEqual(result, { status: 'needs_review', reasons: ['rule_applicability_context_hash_mismatch'] });
  assert.equal(selectorWasCalled(), false);
});

test('needs_review and withdrawn loader outcomes remain fail closed', async (t) => {
  for (const reason of ['rule_applicability_overall_review_required', 'rule_applicability_overall_review_withdrawn']) {
    await t.test(reason, async () => {
      const { db, selectorWasCalled } = sourceDb();
      const loader: ReviewedContextLoader = async () => ({ status: 'needs_review', reasons: [reason] });
      const result = await lockProductionRulePack(db, { owner_user_id: 'owner-1', id: 'project-1', market: 'sse', offering: 'private' },
        current, identity, ref, loader);

      assert.deepEqual(result, { status: 'blocked', reasons: [reason] });
      assert.equal(selectorWasCalled(), false);
    });
  }
});
