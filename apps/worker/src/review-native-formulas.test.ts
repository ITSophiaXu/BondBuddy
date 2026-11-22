import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import {
  evidenceKey,
  referenceFor,
  reviewContentHash,
} from '../../../packages/domain/dist/review-evidence.js';
import { reviewFinancialEvidence } from '../../../packages/domain/dist/review-financial-checks.js';
import { normalizeReviewFindings } from '../../../packages/domain/dist/review-finding-normalization.js';
import { produceNativeReviewFormulas } from './review-native-formulas.js';
import {
  chunkReviewRecords,
  normalizeModelReviewAnalysis,
  reviewModelStage,
  type ReviewAnalysisInput,
  type ReviewAnalysisRecord,
  type ReviewAnalysisResult,
  type ModelReviewAnalysis,
} from './review-model-stage.js';
import { reviewPromptRecordId } from './review-record-context.js';
import { syntheticCliReview } from './review-cli-test-fixtures.js';
import type { StageContext } from './run-pipeline.js';

const python = process.env.BONDBUDDY_TEST_PYTHON ?? process.env.BB_PYTHON ?? 'python3';
const pythonAvailable =
  spawnSync(python, ['-c', 'import docx,lxml,openpyxl,pdfplumber,pypdf'], {
    encoding: 'utf8',
    windowsHide: true,
  }).status === 0;
const nativeOptions = {
  skip: pythonAvailable
    ? false
    : 'Set BONDBUDDY_TEST_PYTHON to Python with the document parser dependencies',
};
const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const statement = (metric: string, value: string) =>
  '合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 ' + metric + value + '。';
const citation = (r: ReviewAnalysisRecord) => ({
  record_id: reviewPromptRecordId(r),
  quote: r.literal_quote,
});
const empty = (ids: string[]): ModelReviewAnalysis => ({
  reviewed_record_ids: ids,
  observations: [],
  calculations: [],
  compliance_assessments: [],
  concerns: [],
  limitations: [],
});
function observation(r: ReviewAnalysisRecord): ModelReviewAnalysis['observations'][number] {
  const match = /(甲项|乙项|合计)([\d.]+)。$/.exec(r.literal_quote)!;
  assert(match, r.literal_quote);
  const ref = citation(r);
  return {
    observation_id: match[1]!,
    source_record_id: reviewPromptRecordId(r),
    entity_id: '合成甲公司',
    metric: match[1]!,
    accounting_scope: '合并',
    basis: '原始报表',
    period: { start: '2025-01-01', end: '2025-12-31', as_of: null },
    currency: 'CNY',
    unit: '万元',
    value: match[2]!,
    value_literal: match[2]!,
    value_refs: [ref],
    context_refs: {
      entity: [ref],
      period: [ref],
      accounting_scope: [ref],
      currency: [ref],
      unit: [ref],
      basis: [ref],
    },
  };
}
function inputFor(records: ReviewAnalysisRecord[]): ReviewAnalysisInput {
  return {
    input_hash: 'f'.repeat(64),
    evidence: {
      owner_user_id: 'owner',
      project_id: 'project',
      report_id: 'formula-report',
      source_material: {
        material_id: 'source',
        material_version: 1,
        sha256: records[0]!.material_sha256,
      },
      records,
      rules: [],
    },
    rule_context: null,
    rule_packs: [],
    formatting_requirements: [],
    requirements: [],
    scope: { mode: 'full_review', finding_ids: [] },
    report_version: 1,
    created_at: '2026-10-02T08:00:00Z',
    limitations: [],
  };
}
function values(records: readonly ReviewAnalysisRecord[]) {
  return records.filter((r) => r.literal_quote.startsWith('合成甲公司'));
}
function normalized(input: ReviewAnalysisInput) {
  const raw = empty(input.evidence.records.map(reviewPromptRecordId));
  raw.observations = values(input.evidence.records).map(observation);
  return normalizeModelReviewAnalysis(input, raw).financial.observations;
}
function record(
  id: string,
  quote: string,
  row: number,
  column: number,
  kind: 'docx' | 'xlsx' = 'docx',
): ReviewAnalysisRecord {
  return {
    owner_user_id: 'owner',
    project_id: 'project',
    material_id: 'source',
    material_version: 1,
    material_sha256: 'a'.repeat(64),
    parse_snapshot_id: 'snapshot',
    parse_response_sha256: 'b'.repeat(64),
    record_id: id,
    record_sha256: reviewContentHash([id, quote]),
    locator_type: kind === 'docx' ? 'docx_block' : 'xlsx_cell',
    locator:
      kind === 'docx'
        ? { stable_ref: id, path: [{ table: 1 }, { row }, { column }, { paragraph: 1 }] }
        : { sheet: '合并表', cell: String.fromCharCode(64 + column) + row },
    literal_quote: quote,
    extraction_method: 'native_text',
    uncertainty: [],
    formatting: kind === 'xlsx' ? { sheet_state: 'visible' } : {},
    source_kind: 'disclosure',
  };
}
function synthetic(kind: 'docx' | 'xlsx' = 'docx', formula = '计算关系：合计=甲项+乙项') {
  const records = [
    record('label-a', '甲项', 1, 1, kind),
    record('value-a', statement('甲项', '10.00'), 1, 2, kind),
    record('label-b', '乙项', 2, 1, kind),
    record('value-b', statement('乙项', '20.00'), 2, 2, kind),
    record('label-total', '合计', 3, 1, kind),
    record('value-total', statement('合计', '35.00'), 3, 2, kind),
    record('formula', formula, 4, 1, kind),
  ];
  const input = inputFor(records);
  return { records, input, observations: normalized(input) };
}
function produce(f: ReturnType<typeof synthetic>, selected = f.records, full = true) {
  return produceNativeReviewFormulas({
    evidence: f.input.evidence,
    records: f.records,
    observations: f.observations,
    target_keys: new Set(selected.map(evidenceKey)),
    full_review: full,
  });
}

test('only explicit native relationship and unique row anchors permit a sum; facts keep their independent context gate', () => {
  const f = synthetic(),
    before = structuredClone(f),
    result = produce(f);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.calculations.length, 1);
  assert.equal(result.calculations[0]?.relation_verification, 'trusted_structured');
  assert.deepEqual(result.calculations[0]?.relation_refs?.map((r) => r.record_id).sort(), [
    'formula',
    'label-a',
    'label-b',
    'label-total',
  ]);
  const report = reviewFinancialEvidence(
    { observations: f.observations, calculations: result.calculations },
    f.input.evidence,
  );
  const error = report.findings.find((r) => r.conclusion === 'error')!;
  assert(error);
  assert.equal(error.suggested_change, '30.00');
  assert.deepEqual(
    error.target_refs.map((r) => r.record_id),
    ['value-total'],
  );
  assert(error.evidence_refs.some((r) => r.record_id === 'formula'));
  assert.deepEqual(
    f,
    before,
    'producer must not change original literals, uncertainty, or context',
  );
  const noDeclaration = synthetic('docx', '合计');
  assert.equal(produce(noDeclaration).calculations.length, 0);
  for (const mutation of ['unverified', 'scope', 'basis', 'period']) {
    const copy = structuredClone(f);
    if (mutation === 'unverified') copy.observations[0]!.context_verification = 'unverified';
    if (mutation === 'scope') copy.observations[0]!.accounting_scope = '母公司';
    if (mutation === 'basis') copy.observations[0]!.basis = '重述';
    if (mutation === 'period')
      copy.observations[0]!.period = { start: '2024-01-01', end: '2024-12-31', as_of: null };
    const checked = reviewFinancialEvidence(
      { observations: copy.observations, calculations: produce(copy).calculations },
      copy.input.evidence,
    );
    assert(
      checked.findings.every((r) => r.conclusion !== 'error' && !r.repairability.can_revise),
      mutation,
    );
  }
});

test('named relationships reject duplicate labels, omitted extra value cells, OCR labels, missing rows and source pin changes', () => {
  for (const kind of [
    'duplicate-label',
    'second-period-not-extracted',
    'label-uncertain',
    'value-uncertain',
    'declaration-uncertain',
    'missing',
    'wrong-pin',
    'incomplete-snapshot',
  ]) {
    const f = synthetic();
    if (kind === 'duplicate-label') f.records.push(record('duplicate', '甲项', 6, 1));
    if (kind === 'second-period-not-extracted')
      f.records.push(record('prior-period', '8.00', 1, 3));
    if (kind === 'label-uncertain') f.records[0]!.uncertainty = ['ocr-label'];
    if (kind === 'value-uncertain') f.records[1]!.uncertainty = ['ocr-digit'];
    if (kind === 'declaration-uncertain') f.records[6]!.uncertainty = ['ocr-relation'];
    if (kind === 'missing') f.records.splice(0, 2);
    if (kind === 'wrong-pin') {
      f.input.evidence = { ...f.input.evidence, records: structuredClone(f.records) };
      f.records[6]!.parse_response_sha256 = 'c'.repeat(64);
    }
    if (kind === 'incomplete-snapshot') {
      f.input.evidence = {
        ...f.input.evidence,
        records: [...f.records, record('unprovided', '9.00', 1, 3)],
      };
    }
    const checked = produce(f);
    assert.equal(checked.calculations.length, 0, kind);
    assert(checked.gaps.length, kind);
    assert(
      checked.gaps.every((g) =>
        g.evidence_refs.every((ref) =>
          f.input.evidence.records.some((r) => evidenceKey(r) === evidenceKey(ref)),
        ),
      ),
      kind,
    );
  }
});

test('explicit native XLSX cell/range sums reject caches, hidden sheets, external refs, cycles, repeated operands and unbounded ranges', () => {
  for (const formula of ['公式：B3=B1+B2', '公式：B3=SUM(B1:B2)']) {
    const f = synthetic('xlsx', formula);
    assert.equal(produce(f).calculations.length, 1, formula);
  }
  for (const [kind, formula] of [
    ['cache', '公式：B3=B1+B2'],
    ['hidden', '公式：B3=B1+B2'],
    ['unknown', '公式：B3=B1+B2'],
    ['formula-value', '公式：B3=B1+B2'],
    ['external', '公式：B3=[book.xlsx]Sheet1!B1+B2'],
    ['other-sheet', '公式：B3=Sheet2!B1+B2'],
    ['duplicate', '公式：B3=B1+B1'],
    ['self', '公式：B3=B3+B1'],
    ['range', '公式：B3=SUM(B1:B200)'],
    ['single', '公式：B3=SUM(B1:B1)'],
  ]) {
    const f = synthetic('xlsx', formula!);
    if (kind === 'cache')
      f.records[1]!.formatting = { sheet_state: 'visible', cached_formula_result: 0 };
    if (kind === 'hidden') for (const r of f.records) r.formatting = { sheet_state: 'hidden' };
    if (kind === 'unknown') for (const r of f.records) r.formatting = {};
    if (kind === 'formula-value') f.records[1]!.literal_quote = '=10';
    const result = produce(f);
    assert.equal(result.calculations.length, 0, kind);
    assert(result.gaps.length, kind);
  }
  const cycle = synthetic('xlsx', '公式：B3=B1+B2');
  cycle.records.push(record('cycle', '公式：B1=B3+B2', 5, 1, 'xlsx'));
  assert(produce(cycle).gaps.some((g) => g.reason.includes('formula_cycle')));
  const aliasedCycle = synthetic('xlsx', '公式：B3=甲项+乙项');
  aliasedCycle.records.push(record('alias-cycle', '公式：甲项=合计+乙项', 5, 1, 'xlsx'));
  assert(produce(aliasedCycle).gaps.some((g) => g.reason.includes('formula_cycle')));
  const aliasedDuplicate = synthetic('xlsx', '公式：B3=B1+B2');
  aliasedDuplicate.records.push(record('alias-duplicate', '公式：合计=甲项+乙项', 5, 1, 'xlsx'));
  assert.equal(produce(aliasedDuplicate).calculations.length, 0);
  assert(
    produce(aliasedDuplicate).gaps.every((g) => g.reason.includes('formula_declaration_ambiguous')),
  );
  const chain = synthetic('xlsx', '公式：B3=B4+B2');
  for (let i = 4; i < 75; i++)
    chain.records.push(
      record('chain-' + i, '公式：B' + i + '=B' + (i + 1) + '+B2', i + 10, 1, 'xlsx'),
    );
  assert(produce(chain).gaps.some((g) => g.reason.includes('formula_graph_limit')));
});

test('same labels in other tables, worksheets or snapshots cannot complete a relationship; selection never widens', () => {
  for (const kind of ['table', 'snapshot', 'sheet']) {
    const f = synthetic(kind === 'sheet' ? 'xlsx' : 'docx');
    for (const r of f.records.slice(0, 2)) {
      if (kind === 'table')
        r.locator.path = [
          { table: 2 },
          { row: 1 },
          { column: r.record_id === 'label-a' ? 1 : 2 },
          { paragraph: 1 },
        ];
      if (kind === 'snapshot') {
        r.parse_snapshot_id = 'other';
        r.parse_response_sha256 = 'd'.repeat(64);
      }
      if (kind === 'sheet') r.locator.sheet = '其他表';
    }
    f.observations = normalized(f.input);
    assert.equal(produce(f).calculations.length, 0, kind);
    assert(produce(f).gaps.length, kind);
  }
  const f = synthetic(),
    unrelated = f.records[1]!,
    total = f.records[5]!;
  assert.deepEqual(produce(f, [unrelated], false), { calculations: [], gaps: [] });
  f.observations = f.observations.filter((o) => o.metric === '合计');
  const selected = produce(f, [total], false);
  assert.equal(selected.calculations.length, 0);
  assert.equal(selected.gaps.length, 1);
  assert.deepEqual(
    selected.gaps[0]!.target_refs.map((r) => r.record_id),
    ['value-total'],
  );
});

async function parseSynthetic(kind: 'docx' | 'xlsx'): Promise<ReviewAnalysisRecord[]> {
  const directory = await mkdtemp(resolve(tmpdir(), 'bb-native-formulas-'));
  try {
    const path = resolve(directory, 'synthetic.' + kind);
    const script = [
      'import sys',
      'from docx import Document',
      'from openpyxl import Workbook',
      "rows=[('甲项','10.00'),('乙项','20.00'),('合计','35.00')]",
      "def statement(metric,value): return '合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 '+metric+value+'。'",
      "if sys.argv[2]=='docx':",
      ' d=Document();t=d.add_table(rows=4,cols=2)',
      ' for i,(metric,value) in enumerate(rows): t.cell(i,0).text=metric;t.cell(i,1).text=statement(metric,value)',
      " t.cell(3,0).text='计算关系：合计=甲项+乙项'",
      ' d.save(sys.argv[1])',
      'else:',
      " w=Workbook();s=w.active;s.title='合并表'",
      ' for i,(metric,value) in enumerate(rows,1): s.cell(i,1,metric);s.cell(i,2,statement(metric,value))',
      " s['A4']='公式：B3=SUM(B1:B2)'",
      ' w.save(sys.argv[1])',
    ].join('\n');
    const generated = spawnSync(python, ['-B', '-c', script, path, kind], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(generated.status, 0, generated.stderr);
    const sha = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    const media_type =
      kind === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const request = {
      schema_version: 'document-parse-request-v1',
      request_id: 'synthetic-formula-' + kind,
      material: {
        material_id: 'source',
        material_version: 1,
        media_type,
        sha256: sha,
        authorized_local_path: path,
      },
      options: {},
    };
    const parsed = spawnSync(python, ['-B', '-m', 'bondbuddy_document_parser'], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: resolve(root, 'python'), PYTHONIOENCODING: 'utf-8' },
      input: JSON.stringify(request),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const response = JSON.parse(parsed.stdout);
    assert.equal(response.schema_version, 'document-parse-response-v1');
    const responseSha = inputManifestHash(response);
    return response.records.map((r: Record<string, unknown>) => ({
      owner_user_id: 'owner',
      project_id: 'project',
      material_id: 'source',
      material_version: 1,
      material_sha256: sha,
      parse_snapshot_id: 'snapshot',
      parse_response_sha256: responseSha,
      record_id: r.record_id,
      record_sha256: inputManifestHash(r),
      locator_type: r.locator_type,
      locator: r.locator,
      literal_quote: r.literal_quote,
      extraction_method: r.extraction_method,
      uncertainty: r.uncertainty,
      formatting: r.formatting,
      context: r.context,
      source_kind: 'disclosure',
    }));
  } finally {
    assert(directory.startsWith(resolve(tmpdir(), 'bb-native-formulas-')));
    await rm(directory, { recursive: true, force: true });
  }
}
async function runStage(
  input: ReviewAnalysisInput,
  includeModelFormula = true,
  selectNative = true,
) {
  let calls = 0;
  const ctx = {
    run: {
      id: 'synthetic-native-formula-run',
      owner_user_id: 'owner',
      project_id: 'project',
      input_revision: 1,
      input_hash: input.input_hash,
    },
    values: new Map(),
    checkpoint: {},
    signal: new AbortController().signal,
  } as unknown as StageContext;
  const result = await reviewModelStage({
    loadInput: async () => input,
    model: (options) => ({
      name: options.name,
      run: async (context) => {
        calls++;
        const prompt = JSON.parse((await options.buildPrompt(context)).split('输入数据：\n')[1]!);
        assert.equal(prompt.records, undefined, 'the CLI prompt is not an extraction batch');
        const data = options.reviewTools!;
        const primary = values(input.evidence.records).filter((r) =>
          data.allowed_target_ids.includes(reviewPromptRecordId(r)),
        );
        const observations = primary.map(observation);
        const calculations: ModelReviewAnalysis['calculations'] =
          includeModelFormula && observations.length === 3
            ? [
                {
                  calculation_id: 'cli-sum',
                  label: 'CLI explicitly selected sum',
                  operation: 'sum',
                  result_id: '合计',
                  operand_ids: ['甲项', '乙项'],
                  complete_terms: true,
                },
              ]
            : [];
        const native_formula_record_ids = selectNative
          ? input.evidence.records
              .filter((r) => /^(计算关系|公式)：/.test(r.literal_quote))
              .map(reviewPromptRecordId)
          : [];
        const value = syntheticCliReview(data, {
          financial: { observations, calculations, native_formula_record_ids },
        });
        assert(options.validate(value.output));
        return { kind: 'done', value };
      },
    }),
  }).run(ctx);
  assert.equal(result.kind, 'done');
  if (result.kind !== 'done') throw Error('stage failed');
  return { report: (result.value as ReviewAnalysisResult).report, calls };
}
for (const kind of ['docx', 'xlsx'] as const)
  test(
    'real ' +
      kind +
      ' parser → CLI-requested native source sum → bounded financial target without automatic scans',
    nativeOptions,
    async () => {
      const records = await parseSynthetic(kind),
        before = structuredClone(records),
        input = inputFor(records);
      const batches = chunkReviewRecords(records, 64000, 1);
      assert(batches.length >= 7);
      const full = await runStage(input);
      assert.equal(full.calls, 1, 'one CLI turn uses explicit tools instead of extraction batches');
      const errors = full.report.findings.filter((f) => f.conclusion === 'error');
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.suggested_change, '30.00');
      assert.equal(errors[0]!.repairability.can_revise, true);
      const total = records.find((r) => r.literal_quote === statement('合计', '35.00'))!;
      assert.deepEqual(errors[0]!.target_refs.map(evidenceKey), [evidenceKey(total)]);
      assert(
        errors[0]!.evidence_refs.some((r) =>
          r.quote.startsWith(kind === 'docx' ? '计算关系：' : '公式：'),
        ),
      );
      assert.deepEqual(records, before);
      assert.equal(
        full.report.coverage.filter((c) => c.check_id.startsWith('calculation:')).length,
        1,
        'the explicitly selected native relation is not duplicated',
      );
      const unrequested = await runStage(input, false, false);
      assert(
        !unrequested.report.findings.some(
          (f) => f.conclusion === 'error' && f.calculation?.expression === 'sum',
        ),
        'backend must not discover and calculate the native relation on its own',
      );
      assert(
        !unrequested.report.coverage.some(
          (c) => c.check_id.startsWith('native-sum:') || c.check_id.startsWith('calculation:'),
        ),
      );
      const unverified = await runStage(input, true, false);
      assert(
        unverified.report.findings.every((f) => !f.repairability.can_revise),
        'CLI arithmetic without explicit verified native relation is not repair authority',
      );
      const prior = normalizeReviewFindings(
        [
          {
            stable_key: 'selected-sum',
            dimension: 'financial',
            conclusion: 'manual',
            severity: 'P2',
            title: '合成合计待核',
            description: '只复核合计值',
            target_refs: [referenceFor(total)],
            evidence_refs: [referenceFor(total)],
          },
        ],
        { ...input.evidence, report_id: 'previous-report' },
      )[0]!;
      input.previous_report = {
        ...full.report,
        report_id: 'previous-report',
        run_id: 'previous-run',
        findings: [prior],
        coverage: [],
      };
      input.scope = { mode: 'differential_review', finding_ids: [prior.finding_id] };
      const selected = await runStage(input);
      assert.equal(selected.calls, 1);
      assert(
        selected.report.findings.every((f) =>
          f.target_refs.every((ref) => evidenceKey(ref) === evidenceKey(total)),
        ),
      );
      assert(selected.report.findings.every((f) => !f.repairability.can_revise));
      assert(
        selected.report.coverage.some(
          (c) => c.check_id.startsWith('native-sum:') && c.outcome === 'manual',
        ),
      );
    },
  );
