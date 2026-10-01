import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKET_OFFERINGS, emptyUpdateDetails, type Project } from '@bondbuddy/contracts';
import { blankDraft, changeMarket, draftFromProject, materialHints, projectKind, validateDraft } from './form-model.js';

test('kind follows the historical-prospectus answer: only "no history" routes to generation', () => {
  assert.equal(projectKind(false), 'generation');
  assert.equal(projectKind(true), 'update');
  assert.equal(projectKind(null), 'update');
  assert.equal(projectKind(undefined), 'update');
  const saved: Project = { project_id: 'synthetic-project', draft_revision: 1, input_revision: null, input_hash: null,
    kind: 'generation', name: '无历史稿项目', issuer_name: '合成发行人', market: 'sse', offering: 'private',
    updated_at: '2026-09-29T00:00:00Z', update_details: { ...emptyUpdateDetails(), has_historical: false } };
  assert.equal(draftFromProject(saved).kind, 'generation');
  assert.deepEqual(validateDraft({ ...blankDraft(), name: '无历史稿', market: 'sse', offering: 'private', kind: 'generation' }), []);
});

test('all eleven market/offering combinations use the shared contract; DFI is NAFMII only', () => {
  let combinations = 0;
  for (const [market, offerings] of Object.entries(MARKET_OFFERINGS)) {
    for (const offering of offerings) {
      const draft = { ...blankDraft(), name: '合成测试项目', market: market as keyof typeof MARKET_OFFERINGS, offering };
      assert.deepEqual(validateDraft(draft), []); combinations++;
    }
  }
  assert.equal(combinations, 11);
  assert.notDeepEqual(validateDraft({ ...blankDraft(), name: '测试', market: 'sse', offering: 'dfi' }), []);
});
test('market switch clears only incompatible offering and preserves all other fields', () => {
  const draft = { ...blankDraft(), name: '测试', market: 'nafmii' as const, offering: 'dfi' as const };
  draft.update_details!.bond_terms = '统一注册，覆盖 MTN、SCP；各期金额待定';
  draft.update_details!.underwriting = '合成证券';
  const next = changeMarket(draft, 'sse');
  assert.equal(next.cleared, true); assert.equal(next.draft.offering, null);
  assert.deepEqual(next.draft.update_details, draft.update_details);
  const compatible = changeMarket({ ...draft, market: 'sse', offering: 'public_all' }, 'szse');
  assert.equal(compatible.draft.offering, 'public_all'); assert.equal(compatible.cleared, false);
});
test('DFI restores unknown amounts, one underwriter and supplementary text without invented tranches', () => {
  const saved: Project = { project_id: 'synthetic-project', draft_revision: 2, input_revision: null, input_hash: null, kind: 'update', name: '测试', issuer_name: null, market: 'nafmii', offering: 'dfi', updated_at: '2026-09-24T00:00:00Z', update_details: { ...emptyUpdateDetails(), has_historical: false, underwriting: '合成证券', supplementary_notes: '授信信息待补充' } };
  const restored = draftFromProject(saved);
  assert.equal(restored.offering, 'dfi'); assert.equal(restored.market, 'nafmii');
  assert.equal(restored.update_details!.registration_amount, null);
  assert.equal(restored.update_details!.bond_terms, null); assert.deepEqual(restored.update_details!.funding_uses, []);
  restored.update_details!.underwriting = '另一个机构';
  assert.equal(saved.update_details!.underwriting, '合成证券', 'editing cannot mutate the saved comparison');
  assert.deepEqual(validateDraft(restored), []);
  assert.deepEqual(materialHints(restored.update_details!), ['审计报告，或财务报表及附注', '相似募集书（可选）']);
});
test('calendar, units, decimal precision, null and false are distinct', () => {
  const draft = { ...blankDraft(), name: '测试' }; const d = draft.update_details!;
  d.reporting_cutoff = '2025-02-29'; assert.match(validateDraft(draft).join(), /截止日/);
  d.reporting_cutoff = '2024-02-29'; d.has_historical = false;
  d.registration_amount = { value: '0.1', unit: 'hundred_million' };
  d.issuance_amount = { value: '1000.000001', unit: 'ten_thousand' };
  assert.match(validateDraft(draft).join(), /超过/);
  d.issuance_amount.value = '1000'; assert.deepEqual(validateDraft(draft), []);
  d.issuance_amount.value = '1.0000001'; assert.notDeepEqual(validateDraft(draft), []);
  d.issuance_amount = { value: '0', unit: 'yuan' }; assert.deepEqual(validateDraft(draft), []);
  d.registration_amount = null; assert.deepEqual(validateDraft(draft), []);
  (d as unknown as Record<string, unknown>).unexpected = 'not allowed'; assert.notDeepEqual(validateDraft(draft), []);
});
