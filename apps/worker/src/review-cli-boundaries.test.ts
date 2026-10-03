/** Synthetic run-local CLI regressions; no customer documents or professional acceptance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewFixture, syntheticReviewPack } from '../../../packages/domain/dist/review-test-fixtures.js';
import { referenceFor, reviewContentHash } from '../../../packages/domain/dist/review-evidence.js';
import { normalizeReviewFindings, reviewCoverage } from '../../../packages/domain/dist/review-finding-normalization.js';
import { AUDIT_RECONCILIATION_KNOWLEDGE } from '../../../packages/domain/dist/audit-reconciliation-knowledge.js';
import { isReviewReport, type ReviewReport } from '../../../packages/contracts/dist/review-results.js';
import { normalizeModelReviewAnalysis, reviewModelStage, reviewPromptRecordId, type ModelReviewAnalysis,
  type ReviewAnalysisInput, type ReviewAnalysisRecord, type ReviewAnalysisResult } from './review-model-stage.js';
import { syntheticCliReview } from './review-cli-test-fixtures.js';
import { callReviewTool, type ReviewToolData } from './review-tools.js';
import type { StageContext } from './run-pipeline.js';

const statement = (metric: string, value: string) => `合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 ${metric}${value}。`;
const empty = (): ModelReviewAnalysis => ({ reviewed_record_ids: [], observations: [], calculations: [], compliance_assessments: [], concerns: [], limitations: [] });

function fixture(count = 1) {
  const f = reviewFixture();
  for (let i = 0; i < count; i++) f.addRecord(`target-${i}`, statement('营业收入', `${100 + i}.00`));
  const records: ReviewAnalysisRecord[] = f.records.map(r => ({ ...r, source_kind: 'disclosure' }));
  const input: ReviewAnalysisInput = { input_hash: 'f'.repeat(64), evidence: { ...f.ctx, records },
    rule_context: null, rule_packs: [], formatting_requirements: [], requirements: ['只复核所选事项。'],
    scope: { mode: 'full_review', finding_ids: [] }, report_version: 2, created_at: '2026-10-02T08:00:00Z', limitations: [] };
  return { input, records };
}

function previous(input: ReviewAnalysisInput, selections: { key: string; dimension: 'financial' | 'compliance'; records: ReviewAnalysisRecord[] }[]): ReviewReport {
  const evidence = { ...input.evidence, report_id: 'previous-report' };
  const findings = normalizeReviewFindings(selections.map(s => ({ stable_key: s.key, dimension: s.dimension,
    conclusion: 'manual' as const, severity: 'P2' as const, title: s.key, description: s.key,
    target_refs: s.records.map(r => referenceFor(r)), evidence_refs: s.records.map(r => referenceFor(r)) })), evidence);
  return { report_id: evidence.report_id, project_id: evidence.project_id, run_id: 'previous-run', input_revision: 1,
    version: 1, source_material: evidence.source_material, scope: { mode: 'full_review', finding_ids: [] },
    findings, coverage: [], limitations: [], created_at: '2026-10-01T08:00:00Z' };
}

function selectAll(input: ReviewAnalysisInput, report: ReviewReport) {
  input.previous_report = report;
  input.scope = { mode: 'differential_review', finding_ids: report.findings.map(f => f.finding_id) };
}

async function run(input: ReviewAnalysisInput, turn: (data: ReviewToolData) => ReturnType<typeof syntheticCliReview>) {
  const ctx = { run: { id: 'synthetic-boundary-run', owner_user_id: input.evidence.owner_user_id,
    project_id: input.evidence.project_id, input_revision: 1, input_hash: input.input_hash },
    values: new Map(), checkpoint: {}, signal: new AbortController().signal } as unknown as StageContext;
  const result = await reviewModelStage({ loadInput: async () => input,
    model: o => ({ name: o.name, run: async () => ({ kind: 'done', value: turn(o.reviewTools!) }) }) }).run(ctx);
  assert.equal(result.kind, 'done');
  if (result.kind !== 'done') throw Error('Synthetic CLI failed');
  const report = (result.value as ReviewAnalysisResult).report;
  assert(isReviewReport(report));
  return report;
}

test('multiple selected findings sharing one source anchor produce one valid dimension target', async () => {
  const { input, records } = fixture();
  selectAll(input, previous(input, ['first', 'second'].map(key => ({ key, dimension: 'financial' as const, records }))));
  const report = await run(input, data => {
    assert.deepEqual(data.allowed_target_ids, [reviewPromptRecordId(records[0]!)]);
    assert.deepEqual(data.allowed_target_ids_by_dimension?.financial, data.allowed_target_ids);
    return syntheticCliReview(data);
  });
  assert.equal(report.coverage.filter(c => c.check_id.startsWith('scope:') && c.outcome === 'manual').length, 2);
  assert.match(report.coverage.find(c => c.check_id === 'cli:reading-coverage:financial')!.reason, /本轮目标 1 条，实际读取 1 条，未读 0 条/);
  assert(!report.coverage.some(c => c.check_id === 'cli:reading-coverage:compliance'));
});

test('a selected compliance anchor permits its formatting tool and rejects another anchor', async () => {
  const { input, records } = fixture(2);
  const { ref } = await syntheticReviewPack();
  const template = { ...ref, authority: 'template' as const };
  input.evidence.rules = [template];
  records[0]!.formatting = { runs: [{ east_asia_font: '黑体', east_asia_theme: null }] };
  input.formatting_requirements = [{ check_id: 'selected-font', record_ids: [records[0]!.record_id],
    rule_ref: template, property: 'east_asia_font', expected: '宋体' }];
  selectAll(input, previous(input, [{ key: 'font-issue', dimension: 'compliance', records: [records[0]!] }]));
  const report = await run(input, data => {
    assert.deepEqual(data.allowed_target_ids_by_dimension?.formatting, [reviewPromptRecordId(records[0]!)]);
    const value = syntheticCliReview(data, { compliance: { assessments: [], rule_keys: [],
      formatting_check_ids: ['selected-font'], formatting_record_ids: [reviewPromptRecordId(records[0]!)] } });
    assert.throws(() => callReviewTool(data, 'check_compliance', { assessments: [], rule_keys: [],
      formatting_check_ids: ['selected-font'], formatting_record_ids: [reviewPromptRecordId(records[1]!)] }, value.tool_trace), /FORMAT_SCOPE_INVALID/);
    return value;
  });
  assert.equal(report.coverage.find(c => c.check_id === 'selected-font')?.outcome, 'issue');
  assert.equal(report.coverage.find(c => c.check_id === `scope:${input.scope.finding_ids[0]}`)?.outcome, 'issue');
  assert(report.findings.some(f => f.dimension === 'compliance' && f.conclusion === 'error'));
});

function observation(record: ReviewAnalysisRecord, metric: string, value: string): ModelReviewAnalysis['observations'][number] {
  const record_id = reviewPromptRecordId(record), refs = [{ record_id, quote: record.literal_quote }];
  return { observation_id: metric, source_record_id: record_id, entity_id: '合成甲公司', metric,
    accounting_scope: '合并', basis: '原始报表', period: { start: '2025-01-01', end: '2025-12-31', as_of: null },
    currency: 'CNY', unit: '万元', value, value_literal: value, value_refs: refs,
    context_refs: { entity: refs, period: refs, accounting_scope: refs, currency: refs, unit: refs, basis: refs } };
}

function formulaFixture() {
  const { input, records } = fixture();
  const base = records[0]!;
  const record = (id: string, quote: string, row: number, column: number): ReviewAnalysisRecord => ({ ...base,
    record_id: id, record_sha256: reviewContentHash([id, quote]), parse_snapshot_id: 'formula-snapshot',
    parse_response_sha256: 'b'.repeat(64), locator: { stable_ref: id, path: [{ table: 1 }, { row }, { column }, { paragraph: 1 }] }, literal_quote: quote });
  const metrics = ['甲项', '乙项', '丙项', '丁项', '合计'], amounts = ['10.00', '20.00', '15.00', '20.00', '30.00'];
  const values = metrics.map((metric, i) => record(`value-${i}`, statement(metric, amounts[i]!), i + 1, 2));
  const labels = metrics.map((metric, i) => record(`label-${i}`, metric, i + 1, 1));
  const declaration = record('declaration', '计算关系：合计=甲项+乙项', 6, 1);
  input.evidence.records = [...values, ...labels, declaration];
  const observations = values.map((r, i) => observation(r, metrics[i]!, amounts[i]!));
  const current: ModelReviewAnalysis['calculations'][number] = { calculation_id: 'current-sum', label: 'Current explicit sum',
    operation: 'sum', result_id: '合计', operand_ids: ['甲项', '乙项'], complete_terms: true };
  const old: ModelReviewAnalysis['calculations'][number] = { ...current, calculation_id: 'old-sum', operand_ids: ['丙项', '丁项'] };
  const normalized = normalizeModelReviewAnalysis(input, { ...empty(), observations, calculations: [current, old] }).financial;
  return { input, values, observations, current, normalized, declaration };
}

test('same-cell sum passes release only the original bound error formula and operands', async () => {
  for (const mode of ['same-formula', 'different-check', 'different-operands', 'unbound-finding', 'original-conflict'] as const) {
    const { input, values, observations, current, normalized, declaration } = formulaFixture();
    const oldReport = previous(input, [{ key: `old-formula-${mode}`, dimension: 'financial', records: [values[4]!] }]);
    const prior = oldReport.findings[0]!;
    prior.conclusion = mode === 'original-conflict' ? 'conflict' : 'error';
    const currentCalc = normalized.calculations[0]!, oldCalc = normalized.calculations[1]!;
    prior.calculation = { expression: 'sum', operands: mode === 'different-check' || mode === 'different-operands' ? oldCalc.operand_ids : currentCalc.operand_ids,
      observed: '30.00', expected: '35.00', unit: '万元', rounding: 'Original precision' };
    oldReport.coverage = [reviewCoverage({ ...input.evidence, report_id: oldReport.report_id },
      `calculation:${mode === 'different-check' ? oldCalc.calculation_id : currentCalc.calculation_id}`,
      'financial', 'issue', 'Original formula issue.', prior.evidence_refs, mode === 'unbound-finding' ? [] : [prior])];
    selectAll(input, oldReport);
    const report = await run(input, data => {
      const value = syntheticCliReview(data, { financial: { observations, calculations: [current], native_formula_record_ids: [reviewPromptRecordId(declaration)] } });
      const receipt = value.tool_trace.receipts[0]!;
      const pass = receipt.evaluation.coverage.find(c => c.check_id === `calculation:${currentCalc.calculation_id}` && c.outcome === 'pass');
      assert(pass, `${mode}: the new formula itself must actually pass`);
      value.output.checks = [{ check_id: 'claimed-resolution', dimension: 'financial', outcome: 'pass', reason: 'Current sum passes.',
        evidence_refs: [], rule_keys: [], concern_keys: [], receipt_id: receipt.receipt_id, receipt_check_id: pass.check_id,
        resolves_finding_ids: [prior.finding_id] }];
      return value;
    });
    assert.equal(report.coverage.find(c => c.check_id === `scope:${prior.finding_id}`)?.outcome, mode === 'same-formula' ? 'pass' : 'manual', mode);
  }
});

test('an audit-method pass without an exact issued operand chain keeps its historical issue manual', async () => {
  const { input, records } = fixture();
  const rule = AUDIT_RECONCILIATION_KNOWLEDGE.rules.find(r => r.id === 'audit-reconciliation-01')!;
  assert.equal(rule.terms?.length, 2);
  const auditStatement = (metric: string, amount: string) => `合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 ${metric} ${amount}。`;
  const target = { ...records[0]!, literal_quote: auditStatement(rule.result_metric, '100.00'),
    record_sha256: reviewContentHash(auditStatement(rule.result_metric, '100.00')) };
  const source = (id: string, metric: string, amount: string): ReviewAnalysisRecord => ({ ...target,
    source_kind: 'audit', material_id: 'synthetic-audit', material_sha256: 'c'.repeat(64),
    parse_snapshot_id: 'audit-snapshot', parse_response_sha256: 'd'.repeat(64), record_id: id,
    record_sha256: reviewContentHash([id, metric, amount]), locator: { stable_ref: id, path: [{ paragraph: Number(id.slice(-1)) + 1 }] },
    literal_quote: auditStatement(metric, amount) });
  const sources = [source('audit-0', rule.terms![0]!.metric, '60.00'), source('audit-1', rule.terms![1]!.metric, '40.00'),
    source('audit-2', rule.result_metric, '100.00')];
  input.evidence.records = [target, ...sources];
  const observations = [observation(target, rule.result_metric, '100.00'),
    observation(sources[0]!, rule.terms![0]!.metric, '60.00'), observation(sources[1]!, rule.terms![1]!.metric, '40.00'),
    { ...observation(sources[2]!, rule.result_metric, '100.00'), observation_id: 'audit-result' }];
  const normalized = normalizeModelReviewAnalysis(input, { ...empty(), observations }).financial.observations;
  const oldReport = previous(input, [{ key: 'old-audit-error', dimension: 'financial', records: [target] }]);
  const prior = oldReport.findings[0]!;
  prior.conclusion = 'error';
  prior.calculation = { expression: `audit-reconciliation:${AUDIT_RECONCILIATION_KNOWLEDGE.version}:${rule.id}`,
    operands: normalized.filter(o => o.source_kind === 'audit' && o.metric !== rule.result_metric).map(o => o.observation_id),
    observed: '100.00', expected: '110.00', unit: '万元', rounding: 'Original precision' };
  const checkId = `audit-reconciliation:${rule.id}:${normalized.find(o => o.source_kind === 'disclosure')!.observation_id}`;
  oldReport.coverage = [reviewCoverage({ ...input.evidence, report_id: oldReport.report_id }, checkId,
    'financial', 'issue', 'Original audit-method issue.', prior.evidence_refs, [prior])];
  selectAll(input, oldReport);
  const report = await run(input, data => {
    const value = syntheticCliReview(data, { financial: { observations, calculations: [], audit_rule_ids: [rule.id] } });
    const receipt = value.tool_trace.receipts[0]!, pass = receipt.evaluation.coverage.find(c => c.check_id === checkId && c.outcome === 'pass');
    assert(pass, 'The selected current audit method must actually pass');
    assert.equal(receipt.evaluation.findings.length, 0);
    value.output.checks = [{ check_id: 'claimed-audit-resolution', dimension: 'financial', outcome: 'pass', reason: 'Current method passes.',
      evidence_refs: [], rule_keys: [], concern_keys: [], receipt_id: receipt.receipt_id, receipt_check_id: pass.check_id,
      resolves_finding_ids: [prior.finding_id] }];
    return value;
  });
  assert.equal(report.coverage.find(c => c.check_id === checkId)?.outcome, 'pass');
  assert.equal(report.coverage.find(c => c.check_id === `scope:${prior.finding_id}`)?.outcome, 'manual');
});

test('differential reading coverage counts the targets of each selected dimension', async () => {
  const { input, records } = fixture(3);
  selectAll(input, previous(input, [{ key: 'amount', dimension: 'financial', records: [records[0]!] },
    { key: 'clauses', dimension: 'compliance', records: records.slice(1) }]));
  const report = await run(input, data => {
    assert.equal(data.allowed_target_ids_by_dimension?.financial?.length, 1);
    assert.equal(data.allowed_target_ids_by_dimension?.compliance?.length, 2);
    return syntheticCliReview(data);
  });
  assert.match(report.coverage.find(c => c.check_id === 'cli:reading-coverage:financial')!.reason, /本轮目标 1 条，实际读取 1 条，未读 0 条/);
  assert.match(report.coverage.find(c => c.check_id === 'cli:reading-coverage:compliance')!.reason, /本轮目标 2 条，实际读取 2 条，未读 0 条/);
});

test('a model-only financial concern cannot deliver a fabricated suggested amount', async () => {
  const { input, records } = fixture();
  const target = records[0]!, refs = [{ record_id: reviewPromptRecordId(target), quote: target.literal_quote }];
  const report = await run(input, data => {
    const value = syntheticCliReview(data, { concerns: [{ stable_key: 'unsupported-amount', dimension: 'financial',
      conclusion: 'error', severity: 'P2', title: '金额口径需补证', description: '当前披露缺少独立核对依据。',
      target_refs: refs, evidence_refs: refs, rule_keys: [], suggested_change: '9999.00', limitations: [] }] });
    assert.equal(value.tool_trace.receipts.length, 0, 'No financial tool calculated the proposed amount');
    return value;
  });
  assert.equal(report.findings.length, 1, 'The cited semantic concern remains available for manual review');
  const finding = report.findings[0]!;
  assert.equal(finding.conclusion, 'manual');
  assert.equal(finding.suggested_change, undefined);
  assert.equal(finding.calculation, undefined);
  assert.equal(finding.repairability.can_revise, false);
  assert(!JSON.stringify(report).includes('9999.00'));
});
