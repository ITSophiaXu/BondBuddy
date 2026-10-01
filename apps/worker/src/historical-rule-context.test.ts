import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { rulePackContentHash } from '@bondbuddy/domain';
import { loadHistoricalRuleGuidance, HistoricalRulesUnavailable } from './historical-rule-context.js';
import { syntheticHistoricalRules } from './test-fixtures/historical-rules.js';

const db = { query: () => { throw new Error('Synthetic resolver expected'); } } as unknown as Pool;
test('locked production rules carry applicable text, exceptions and exact source quotes', async () => {
  const selected = syntheticHistoricalRules();
  const result = await loadHistoricalRuleGuidance(db, selected.pin, selected.pin.applicabilityContext, async (_db, pin) => {
    assert.equal(pin.releaseEventId, 'synthetic-release'); return selected;
  });
  assert.equal(result.rules.length, 1); assert.match(result.rules[0]!.boundaries[0]!, /金额和材料/);
  assert.match(result.rules[0]!.exceptions[0]!, /不得省略/);
  assert.equal(result.sources[0]!.exact_quote, selected.pack.sources[0]!.exact_quote);
  assert.equal(result.pack_hash, selected.pin.contentHash); assert.equal(result.constitutes_compliance_result, false);
});
test('withdrawn releases or revoked evidence cannot fall back to another pack', async () => {
  const selected = syntheticHistoricalRules();
  for (const reason of ['production_rule_pack_withdrawn', 'production_rule_pack_reviewer_grant_inactive'] as const) {
    await assert.rejects(loadHistoricalRuleGuidance(db, selected.pin, selected.pin.applicabilityContext,
      async () => ({ status: 'blocked', reasons: [reason] })), error => error instanceof HistoricalRulesUnavailable && error.message === reason);
  }
});
test('changed content and selection pins are rejected instead of changing an old run', async () => {
  for (const change of ['content', 'pin'] as const) {
    let selected = syntheticHistoricalRules(); const expected = structuredClone(selected.pin);
    if (change === 'content') selected.pack.rules[0]!.boundaries[0] = 'tampered';
    else selected = { ...selected, pin: { ...selected.pin, releaseEventId: 'latest-release' } };
    await assert.rejects(loadHistoricalRuleGuidance(db, expected, expected.applicabilityContext, async () => selected), /UPDATE_RULE_CONTENT_MISMATCH/);
  }
});
test('research rules and other market scopes never enter generation as approved rules', async () => {
  let selected = syntheticHistoricalRules(); selected.pack.status = 'draft'; selected.pack.release = null;
  selected.pack.reviews = []; selected.pack.validity.published_on = null;
  selected = { ...selected, pin: { ...selected.pin, contentHash: rulePackContentHash(selected.pack) } };
  await assert.rejects(loadHistoricalRuleGuidance(db, selected.pin, selected.pin.applicabilityContext, async () => selected), /historical_rules_not_eligible/);
  const original = syntheticHistoricalRules(); const other = { ...original, pin: { ...original.pin, offering: 'public_all' as const } };
  await assert.rejects(loadHistoricalRuleGuidance(db, other.pin, other.pin.applicabilityContext), /historical_rule_scope_not_installed/);
});

test('only applicable rules and their sources are supplied; conditional rules are not flattened into universal duties', async () => {
  const selected = syntheticHistoricalRules(draft => {
    draft.sources.push({ ...draft.sources[0]!, source_id: 'synthetic-conditional-source', exact_quote: '仅供合成绿色条款使用' });
    draft.rules.push({ ...draft.rules[0]!, rule_id: 'synthetic-green-only', source_ref_ids: ['synthetic-conditional-source'],
      applicability: { ...draft.rules[0]!.applicability, special_features: ['green'] } });
  });
  const result = await loadHistoricalRuleGuidance(db, selected.pin, selected.pin.applicabilityContext, async () => selected);
  assert.deepEqual(result.rules.map(rule => rule.rule_id), ['synthetic-research-rule']);
  assert.deepEqual(result.sources.map(source => source.source_id), ['synthetic-lead']);
});

test('oversized rule guidance pauses explicitly instead of truncating citations or exceptions', async () => {
  const selected = syntheticHistoricalRules(draft => {
    for (let i = 0; i < 16; i++) {
      const source_id = `synthetic-long-${i}`;
      draft.sources.push({ ...draft.sources[0]!, source_id, exact_quote: '合成来源'.repeat(1000) });
      draft.rules[0]!.source_ref_ids.push(source_id);
    }
  });
  await assert.rejects(loadHistoricalRuleGuidance(db, selected.pin, selected.pin.applicabilityContext, async () => selected),
    /historical_rule_context_exceeds_limit/);
});
