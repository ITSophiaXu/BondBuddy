import test from 'node:test';
import assert from 'node:assert/strict';
import { executionRecovery, recoveryMaterialId, recoverySupportSummary } from './execution-recovery.js';

test('stale state takes precedence over every previously observed outcome', () => {
  for (const state of ['running','paused','failed','succeeded'] as const) {
    const result=executionRecovery({state,stage:'user_paused'},{stale:true});
    assert.equal(result?.kind,'refresh');
    assert.match(result!.instruction,/不能确认/);
  }
});
test('only explicit user pause suggests resuming; automatic pauses ask for a read', () => {
  assert.equal(executionRecovery({state:'paused',stage:'user_paused'})?.kind,'resume');
  for(const stage of ['provider_reconcile','billing_reconcile','awaiting_materials','trial_limit'])
    assert.equal(executionRecovery({state:'paused',stage})?.kind,'refresh');
});
test('exhausted or repeated repairs need support, not another retry', () => {
  const run={state:'paused',stage:'capability_not_ready'} as const;
  assert.equal(executionRecovery(run,{reason:'word_size_repair_exhausted'})?.kind,'support');
  assert.equal(executionRecovery(run,{repeatedPause:true})?.kind,'support');
});
test('material recovery distinguishes terminal preparation from locked active input', () => {
  for(const reason of ['MATERIAL_UNREADABLE','material_parse_failed:sample:2','authoring_ocr_incomplete']) {
    assert.match(executionRecovery({state:'failed',stage:'failed'},{reason})!.instruction,/准备只打开草稿/);
    assert.match(executionRecovery({state:'awaiting_input',stage:'awaiting_materials'},{reason})!.instruction,/先停止/);
  }
  assert.equal(recoveryMaterialId('material_parse_failed:sample:2'),'sample');
  assert.equal(recoveryMaterialId('material_parse_cancelled:sample'),'sample');
  assert.equal(recoveryMaterialId('processor_failed'),undefined);
});
test('unknown failures never invent a material cause or promise refunds', () => {
  const plan=executionRecovery({state:'failed',stage:'failed'},{reason:'unknown_private_detail'});
  assert.equal(plan?.kind,'support');
  assert.doesNotMatch(JSON.stringify(plan),/unknown_private_detail|免费|全退/);
  assert.equal(executionRecovery({state:'cancelled',stage:null})?.kind,'prepare');
  assert.equal(executionRecovery({state:'succeeded',stage:'completed'}),undefined);
  assert.equal(executionRecovery({state:'paused',stage:'credits_exhausted'},{needsRecharge:true}),undefined);
});
test('support summary includes only bounded safe identifiers and observed state', () => {
  const summary=recoverySupportSummary({run_id:'synthetic-run-1',state:'failed',updated_at:'2026-11-12T00:00:00Z'},'任务失败',true);
  assert.match(summary,/synthetic-run-1/);assert.match(summary,/暂不可获取/);
  assert.doesNotMatch(summary,/https?:|sha256|input_hash/);
  const rejected=recoverySupportSummary({run_id:'secret/customer.docx?token=private',state:'failed',updated_at:'unknown'},'任务失败',false);
  assert.doesNotMatch(rejected,/secret|customer|token|private/);assert.match(rejected,/更新时间：未知/);
});
