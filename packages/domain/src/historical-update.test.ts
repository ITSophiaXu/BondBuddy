import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planHistoricalUpdate, updateContentHash, type HistoricalUpdateInput, type UpdateFact } from './historical-update.js';
import * as arithmetic from './update-arithmetic.js';

function fixture(): HistoricalUpdateInput {
  return JSON.parse(readFileSync(new URL('../../../tests/fixtures/historical-update/input.json', import.meta.url), 'utf8'));
}
function code(input: HistoricalUpdateInput, expected: string): void {
  const result = planHistoricalUpdate(input);
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.deliverable, false);
  assert.ok(result.findings.some(finding => finding.code === expected), JSON.stringify(result.findings));
}
function numericInput(): HistoricalUpdateInput {
  const input = fixture();
  input.columns = [];
  input.occurrences = [input.occurrences[2]!];
  input.coverage = input.baseline.blocks.map(block => ({ recordId: block.recordId, disposition: block.recordId === 'p2' ? 'update' : 'retain', reason: 'Synthetic isolated arithmetic case' }));
  return input;
}
function numericOutput(input: HistoricalUpdateInput): string {
  const result = planHistoricalUpdate(input);
  assert.equal(result.status, 'planned', JSON.stringify(result.findings));
  return result.replacements[0]!.after;
}

test('synthetic annual update preserves old years, risks, audit opinion, formatting and source immutability', () => {
  const input = fixture(); const before = structuredClone(input);
  const plan = planHistoricalUpdate(input);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.deliverable, false);
  assert.equal(plan.replacements.length, 3);
  assert.equal(plan.textPreview[0]!.after, '上海证券交易所非公开发行公司债券。财务报告截止日2024-12-31。');
  assert.equal(plan.textPreview[1]!.after, '2024年度营业收入为120.00万元。');
  for (const block of plan.textPreview.slice(2)) assert.equal(block.after, block.before);
  assert.deepEqual(plan.columns[0]!.cells.map(cell => cell.after), ['2024年度', '120.00']);
  assert.equal(plan.columns[0]!.requiresPhysicalGridValidation, true);
  assert.deepEqual(plan.source.priorRevisions, { insertions: 0, deletions: 0 });
  assert.deepEqual(plan.coverage, { total: 10, retained: 6, updated: 4, pending: 0 });
  assert.deepEqual(input, before);
  assert.ok(plan.replacements.every(change => change.evidence[0]!.materialId === 'audit-1' && change.sourceStatuses[0] === 'extracted'));
  assert.deepEqual(plan, planHistoricalUpdate(input));
  plan.textPreview[0]!.formatting.style = 'Modified';
  assert.deepEqual(input, before);
});

test('canonical plan/input hashes change with evidence, rules or prior revisions, but not object key order', () => {
  const input = fixture(); const original = planHistoricalUpdate(input);
  assert.equal(updateContentHash({ a: 1, b: 2 }), updateContentHash({ b: 2, a: 1 }));
  input.context.ruleSnapshot.version = '2';
  assert.notEqual(planHistoricalUpdate(input).planHash, original.planHash);
  assert.notEqual(planHistoricalUpdate(input).planningInputHash, original.planningInputHash);
  input.baseline.priorRevisions.deletions++;
  assert.notEqual(planHistoricalUpdate(input).baselineHash, original.baselineHash);
});

test('same-period restatement requires old/new source versions and the old displayed amount', () => {
  const input = numericInput(); const old = input.facts[1]!;
  const revised = structuredClone(old) as UpdateFact;
  revised.candidate = { ...revised.candidate, candidateId: 'restated-2023', identity: { ...old.candidate.identity, dataVersion: 'restated-v2' }, value: { kind: 'known', decimalOrText: '1100000' } };
  input.facts = [...input.facts, revised];
  input.bindings = [{ bindingId: 'revenue-new', reason: 'restatement', expression: { kind: 'fact', identity: revised.candidate.identity }, replaces: old.candidate.identity }];
  assert.equal(numericOutput(input), '110.00');
  assert.deepEqual(planHistoricalUpdate(input).replacements[0]!.candidateIds, ['restated-2023', 'revenue-2023']);
  input.facts = [revised]; code(input, 'UPDATE_FACT_MISSING');
  input.facts = [revised, { ...old, candidate: { ...old.candidate, value: { kind: 'known', decimalOrText: '999' } } }];
  code(input, 'UPDATE_RESTATEMENT_BASELINE_MISMATCH');
});

test('financial formulas use exact source amounts and convert units before division', () => {
  const input = numericInput(); const latest = input.facts[0]!.candidate.identity; const old = input.facts[1]!.candidate.identity;
  input.bindings = [{ bindingId: 'revenue-new', reason: 'new_period', expression: { kind: 'growth_percent', left: latest, right: old } }];
  input.occurrences = [{ ...input.occurrences[0]!, display: { kind: 'number', unit: '%', decimalPlaces: 2, groupThousands: false } }];
  assert.equal(numericOutput(input), '20.00');
  const denominator = structuredClone(input.facts[0]!) as UpdateFact;
  denominator.candidate = { ...denominator.candidate, candidateId: 'assets', identity: { ...latest, metric: 'assets', unit: '万元' }, value: { kind: 'known', decimalOrText: '300' } };
  input.facts = [...input.facts, denominator];
  input.bindings = [{ bindingId: 'revenue-new', reason: 'correction', expression: { kind: 'ratio', left: latest, right: denominator.candidate.identity } }];
  assert.equal(numericOutput(input), '40.00');
  input.facts = [...input.facts.slice(0, -1), { ...denominator, candidate: { ...denominator.candidate, value: { kind: 'known', decimalOrText: '0' } } }];
  code(input, 'UPDATE_ZERO_DENOMINATOR');
});

test('large decimals, repeated sums, rounding and negative zero never use floating point', () => {
  assert.equal(arithmetic.display(arithmetic.decimal('9007199254740993.125'), 2, true), '9,007,199,254,740,993.13');
  assert.equal(arithmetic.display(arithmetic.decimal('-1.005'), 2, false), '-1.01');
  assert.equal(arithmetic.display(arithmetic.decimal('-0.0001'), 2, false), '0.00');
  assert.equal(arithmetic.display(arithmetic.add(arithmetic.decimal('0.1'), arithmetic.decimal('0.2')), 2, false), '0.30');
  assert.equal(arithmetic.display(arithmetic.convert(arithmetic.decimal('123456789'), '元', '亿元'), 8, false), '1.23456789');
  assert.throws(() => arithmetic.display(arithmetic.decimal('1'), 13, false), /INVALID_DISPLAY/);
  assert.throws(() => arithmetic.convert(arithmetic.decimal('1'), '美元', '元'), /UNIT_MISMATCH/);
});

test('difference and explicitly defined sums preserve period/scope and reject duplicate components', () => {
  const input = numericInput(); const latest = input.facts[0]!.candidate.identity; const old = input.facts[1]!.candidate.identity;
  input.bindings = [{ bindingId: 'revenue-new', reason: 'new_period', expression: { kind: 'difference', left: latest, right: old } }];
  assert.equal(numericOutput(input), '20.00');
  const component: UpdateFact = { ...input.facts[0]!, candidate: { ...input.facts[0]!.candidate, candidateId: 'other-component', identity: { ...latest, metric: 'other-revenue' }, value: { kind: 'known', decimalOrText: '0.3' } } };
  input.facts = [...input.facts, component];
  input.bindings = [{ bindingId: 'revenue-new', reason: 'correction', expression: { kind: 'sum', terms: [latest, component.candidate.identity] } }];
  input.occurrences = [{ ...input.occurrences[0]!, display: { kind: 'number', unit: '元', decimalPlaces: 1, groupThousands: false } }];
  assert.equal(numericOutput(input), '1200000.3');
  input.bindings = [{ bindingId: 'revenue-new', reason: 'correction', expression: { kind: 'sum', terms: [latest, latest] } }];
  code(input, 'UPDATE_DUPLICATE_FORMULA_TERM');
});

for (const mismatch of ['scope', 'currency', 'basis', 'period', 'order', 'unit'] as const) test(`refuses formula ${mismatch} mismatch`, () => {
  const input = numericInput(); const latest = input.facts[0]!.candidate.identity;
  let old = structuredClone(input.facts[1]!.candidate.identity);
  if (mismatch === 'scope') old = { ...old, scope: 'parent_only' };
  if (mismatch === 'currency') old = { ...old, currency: 'USD' };
  if (mismatch === 'basis') old = { ...old, basis: 'OTHER' };
  if (mismatch === 'period') old = { ...old, period: { start: '2023-01-01', end: '2023-06-30' } };
  if (mismatch === 'unit') old = { ...old, unit: '人' };
  input.facts = [input.facts[0]!, { ...input.facts[1]!, candidate: { ...input.facts[1]!.candidate, identity: old } }];
  input.bindings = [{ bindingId: 'revenue-new', reason: 'new_period', expression: { kind: 'growth_percent', left: mismatch === 'order' ? old : latest, right: mismatch === 'order' ? latest : old } }];
  const result = planHistoricalUpdate(input);
  assert.equal(result.status, 'needs_confirmation'); assert.equal(result.replacements.length, 0);
});

for (const scenario of ['conflict', 'unknown', 'ocr', 'user', 'reference', 'status_upgrade'] as const) test(`refuses ${scenario} facts without replacing the rest of that binding`, () => {
  const input = fixture(); const first = input.facts[0]!;
  if (scenario === 'conflict') input.facts = [...input.facts, { ...first, candidate: { ...first.candidate, candidateId: 'conflict', value: { kind: 'known', decimalOrText: '1200000.000000000001' } } }];
  if (scenario === 'unknown') first.candidate = { ...first.candidate, value: { kind: 'unknown' } };
  if (scenario === 'ocr') first.evidence = [{ ...first.evidence[0]!, uncertainty: ['OCR_REVIEW_REQUIRED'] }];
  if (scenario === 'user' || scenario === 'reference') first.candidate = { ...first.candidate, source: { ...first.candidate.source, kind: scenario === 'user' ? 'user_statement' : 'reference' } };
  if (scenario === 'status_upgrade') first.status = 'verified';
  const plan = planHistoricalUpdate(input);
  assert.equal(plan.status, 'needs_confirmation'); assert.equal(plan.replacements.length, 0); assert.equal(plan.columns.length, 0);
  assert.equal(plan.coverage.pending, 4);
});

test('stale and overlapping anchors suppress every occurrence of the failed binding', () => {
  const input = fixture(); input.occurrences = [{ ...input.occurrences[0]!, before: 'wrong' }, ...input.occurrences.slice(1)];
  code(input, 'UPDATE_STALE_ANCHOR'); assert.equal(planHistoricalUpdate(input).replacements.length, 0);
  const overlap = fixture(); overlap.occurrences = [...overlap.occurrences, { ...overlap.occurrences[2]!, occurrenceId: 'overlap' }];
  code(overlap, 'UPDATE_OVERLAPPING_CHANGES'); assert.equal(planHistoricalUpdate(overlap).columns.length, 0);
});

test('missing coverage and mixed resolved/unresolved changes stay pending', () => {
  const input = fixture(); input.coverage = input.coverage.slice(1);
  code(input, 'UPDATE_COVERAGE_INCOMPLETE');
  assert.equal(planHistoricalUpdate(input).coverage.total, planHistoricalUpdate(input).coverage.retained + planHistoricalUpdate(input).coverage.updated + planHistoricalUpdate(input).coverage.pending);
  const mixed = fixture(); mixed.bindings = [...mixed.bindings, { ...mixed.bindings[0]!, bindingId: 'bad' }];
  mixed.occurrences = [...mixed.occurrences, { ...mixed.occurrences[2]!, bindingId: 'bad', occurrenceId: 'bad-value', start: 999 }];
  const plan = planHistoricalUpdate(mixed); assert.equal(plan.coverage.pending, 1); assert.equal(plan.coverage.updated, 3);
});

for (const scenario of ['pdf', 'uncertain', 'profile', 'foreign_evidence', 'missing_date', 'cross_market'] as const) test(`baseline ${scenario} blocks all edits`, () => {
  const input = fixture();
  if (scenario === 'pdf') input.baseline.format = 'pdf_requires_reconstruction';
  if (scenario === 'uncertain') input.baseline.blocks[0]!.uncertainty = ['UNSUPPORTED_REVISION'];
  if (scenario === 'profile') input.baseline.profile.source_market.status = 'user_asserted';
  if (scenario === 'foreign_evidence') input.baseline.profile.source_market.provenance.evidence_refs = ['foreign-record'];
  if (scenario === 'missing_date') input.baseline.profile.reporting_periods[0]!.end = null;
  if (scenario === 'cross_market') input.context.targetMarket = 'szse';
  const result = planHistoricalUpdate(input);
  assert.equal(result.status, 'needs_confirmation'); assert.equal(result.replacements.length, 0); assert.equal(result.columns.length, 0);
});

test('rejects foreign issuer/account and duplicate identities before planning', () => {
  const foreign = fixture(); foreign.context.issuerEntityId = 'other-issuer';
  assert.throws(() => planHistoricalUpdate(foreign), /OWNER_OR_ISSUER/);
  const duplicate = fixture(); duplicate.baseline.blocks = [...duplicate.baseline.blocks, duplicate.baseline.blocks[0]!];
  assert.throws(() => planHistoricalUpdate(duplicate), /INVALID_BASELINE/);
  const changes = fixture(); changes.occurrences = [...changes.occurrences, changes.occurrences[0]!];
  assert.throws(() => planHistoricalUpdate(changes), /DUPLICATE_CHANGE/);
});

test('new columns refuse mixed periods, grid holes, partial rows and complex cells', () => {
  const mixed = fixture(); mixed.bindings = [...mixed.bindings, { bindingId: 'old', reason: 'new_period', expression: { kind: 'fact', identity: mixed.facts[1]!.candidate.identity } }];
  mixed.columns = [{ ...mixed.columns[0]!, cells: [mixed.columns[0]!.cells[0]!, { ...mixed.columns[0]!.cells[1]!, bindingId: 'old' }] }];
  code(mixed, 'UPDATE_COLUMN_PERIOD_NOT_NEW');
  const future = fixture(); const futureFact: UpdateFact = { ...future.facts[0]!, candidate: { ...future.facts[0]!.candidate, candidateId: 'future', identity: { ...future.facts[0]!.candidate.identity, period: { start: '2025-01-01', end: '2025-12-31' } } } };
  future.facts = [...future.facts, futureFact]; future.bindings = [...future.bindings, { bindingId: 'future', reason: 'new_period', expression: { kind: 'fact', identity: futureFact.candidate.identity } }];
  future.columns = [{ ...future.columns[0]!, cells: [future.columns[0]!.cells[0]!, { ...future.columns[0]!.cells[1]!, bindingId: 'future' }] }];
  code(future, 'UPDATE_COLUMN_CONTEXT_MISMATCH');
  const partial = fixture(); partial.columns = [{ ...partial.columns[0]!, cells: partial.columns[0]!.cells.slice(1) }];
  code(partial, 'UPDATE_TABLE_COVERAGE_INCOMPLETE');
  const complex = fixture(); complex.baseline.blocks[9]!.locator.path = [{ table: 1, row: 2, column: 3 }, { paragraph: 2 }];
  code(complex, 'UPDATE_COMPLEX_TABLE_REQUIRES_MAPPING');
  const holes = fixture(); holes.baseline.blocks = holes.baseline.blocks.filter(block => !['t1r1c2', 't1r2c2'].includes(block.recordId)); holes.coverage = holes.coverage.filter(row => !['t1r1c2', 't1r2c2'].includes(row.recordId));
  code(holes, 'UPDATE_TABLE_COVERAGE_INCOMPLETE');
});

test('UTF-16 anchors keep supplementary characters intact and reject half-character edits', () => {
  const input = numericInput();
  input.baseline.blocks[1]!.text = '🙂' + input.baseline.blocks[1]!.text;
  input.occurrences = input.occurrences.map(item => ({ ...item, start: item.start + 2, end: item.end + 2 }));
  assert.equal(numericOutput(input), '120.00');
  input.occurrences = [{ ...input.occurrences[0]!, start: 0, end: 1, before: '\uD83D' }];
  code(input, 'UPDATE_STALE_ANCHOR');
});

test('does not invent explanations: source text must literally occur in supporting evidence', () => {
  const input = numericInput(); input.facts[0]!.candidate = { ...input.facts[0]!.candidate, value: { kind: 'known', decimalOrText: '营业收入增长系销售增加所致' } };
  input.occurrences = [{ ...input.occurrences[0]!, display: { kind: 'source_text' } }];
  code(input, 'UPDATE_TEXT_REQUIRES_SOURCE');
});
