import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { isTestUncoveredItems, schemas } from '@bondbuddy/contracts';
import { toTestCoverageGap } from './test-coverage.js';

const item = { manifestId: 'synthetic-coverage', manifestVersion: '1', itemId: 'no-rule-yet',
  candidateAssetSha256: 'a'.repeat(64), disposition: 'uncovered', area: '资金用途',
  rationale: '缺少配套依据', sourceRefIds: ['synthetic-source'], ruleIds: [] };

test('a coverage gap without a rule retains its complete identity through RunResponse', () => {
  const gap = toTestCoverageGap(item);
  assert.equal('rule_id' in gap, false);
  assert.deepEqual(gap.rule_ids, []);
  assert.equal(gap.item_id, item.itemId);
  assert.equal(gap.rationale, item.rationale);
  assert.equal(gap.candidate_asset_sha256, item.candidateAssetSha256);
  assert.deepEqual(gap.source_ref_ids, item.sourceRefIds);
  assert.ok(isTestUncoveredItems([gap]));
  assert.ok(Value.Check(schemas.RunResponse, {run_id:'r',execution_request_id:'e',project_id:'p',input_revision:1,
    input_hash:'b'.repeat(64),channel:'non_production_test',test_grant_id:'g',uncovered_items:[gap],
    state:'test_completed',stage:'test_completed',event_cursor:1,billing_mode:'non_billable_test',
    reservation_id:null,artifact_id:'a',prompt_snapshot_ref:null,updated_at:'2026-09-27T00:00:00Z'}));
});

test('not_applicable exclusions cannot become uncovered or get invented rule identities', () => {
  assert.throws(() => toTestCoverageGap({...item,itemId:'other-markets',disposition:'not_applicable'}),
    /TEST_COVERAGE_ITEM_NOT_UNCOVERED/);
  assert.equal(isTestUncoveredItems([{...toTestCoverageGap(item),disposition:'not_applicable'}]), false);
  assert.equal(isTestUncoveredItems([{...toTestCoverageGap(item),rule_id:item.itemId}]), false);
});

test('checker gaps retain real rule/source references independently of coverage IDs', () => {
  const check = {kind:'rule_check',rule_id:'synthetic-rule',reason_code:'needs_review',
    evidence_ref:'docx:p0001',source_ref_ids:['synthetic-source']};
  assert.ok(isTestUncoveredItems([toTestCoverageGap(item),check]));
  assert.equal(isTestUncoveredItems([{...check,rule_id:null}]), false);
  assert.equal(isTestUncoveredItems([{...toTestCoverageGap(item),candidate_asset_sha256:'bad'}]), false);
  assert.equal(isTestUncoveredItems([{...toTestCoverageGap(item),source_ref_ids:['source','source']}]), false);
});
