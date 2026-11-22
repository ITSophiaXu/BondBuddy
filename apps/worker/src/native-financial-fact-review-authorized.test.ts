import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { SemanticFactExtractionRequest } from './fact-candidate-producer.js';
import { createNativeFinancialFactExtractor } from './native-financial-fact-extractor.js';
import { createRqQ3FormulaCandidateExtractor } from './rq-q3-formula-candidate-extractor.js';
import { runDocumentParser, type DocumentParseRequest } from './document-parser.js';

const sourceRoot = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../../..'));
const manifestPath = join(sourceRoot, 'tests/samples/2026-09-25/manifest.json');
const parserPython = process.env.BB_PYTHON?.trim() || 'python3';
const parser106Root = process.env.BB_PARSER_106_SOURCE_ROOT?.trim();
const runAuthorized = process.env.BB_RUN_AUTHORIZED_LARGE_XLSX === '1';

if (runAuthorized && !parser106Root) {
  throw new Error(
    'BB_RUN_AUTHORIZED_LARGE_XLSX=1 requires BB_PARSER_106_SOURCE_ROOT pointing to the #196 parser 1.0.6 source tree',
  );
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

type AuthorizedFile = {
  file_id: string;
  path: string;
  bytes: number;
  sha256: string;
  media_type: string;
};
type AuthorizedManifest = { cases: Array<{ files: AuthorizedFile[] }> };

test(
  'authorized rq XLSX extracts direct consolidated lines and holds cached operating revenue for review',
  {
    skip: !runAuthorized
      ? 'set BB_RUN_AUTHORIZED_LARGE_XLSX=1 and BB_PARSER_106_SOURCE_ROOT to run the authorized XLSX check'
      : false,
  },
  async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
    const file = manifest.cases
      .flatMap((item) => item.files)
      .find((item) => item.file_id === 'rq-202509-02');
    assert.ok(file, 'manifest must identify the authorized large rq-202509 XLSX');
    assert.equal(
      file.media_type,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const filePath = resolve(sourceRoot, 'tests/samples/2026-09-25', file.path);
    const bytes = await readFile(filePath);
    assert.equal(
      bytes.byteLength,
      file.bytes,
      'authorized sample byte count must match its manifest',
    );
    const contentHash = sha(bytes);
    assert.equal(contentHash, file.sha256, 'authorized sample SHA-256 must match its manifest');

    const parseRequest: DocumentParseRequest = {
      schema_version: 'document-parse-request-v1',
      request_id: 'authorized-rq-202509-review-only',
      material: {
        material_id: file.file_id,
        material_version: 1,
        media_type: file.media_type as DocumentParseRequest['material']['media_type'],
        sha256: contentHash,
        authorized_local_path: filePath,
      },
      options: {},
    };
    let outputBytes = 0;
    const parsed = await runDocumentParser(parseRequest, {
      maxOutputBytes: 32 * 1024 * 1024,
      invoke: async (serialized, options) => {
        const python = spawnSync(parserPython, ['-m', 'bondbuddy_document_parser'], {
          cwd: parser106Root!,
          env: { ...process.env, PYTHONPATH: join(parser106Root!, 'python') },
          input: serialized,
          encoding: 'utf8',
          maxBuffer: options.maxOutputBytes,
          timeout: options.timeoutMs,
        });
        assert.equal(python.status, 0, `Python 1.0.6 parser failed: ${python.stderr}`);
        assert.ifError(python.error);
        outputBytes = Buffer.byteLength(python.stdout);
        return python.stdout;
      },
    });

    assert.equal(parsed.parser_version, 'bondbuddy-document-parser-1.0.6');
    assert.equal(parsed.status, 'needs_confirmation');
    assert.equal(parsed.records.length, 22014);
    assert.equal(parsed.document.cached_formula_results, 3821);
    assert.equal(
      parsed.records.filter((record) =>
        record.uncertainty.includes('formula_cached_result_unverified'),
      ).length,
      3821,
    );
    assert.ok(
      outputBytes > 13_000_000 && outputBytes < 32 * 1024 * 1024,
      'the authorized check must exercise the complete large Python response',
    );
    assert.ok(
      parsed.records.some((record) => record.formatting.sheet_state === 'hidden'),
      'the workbook must include its hidden auxiliary worksheets',
    );

    const { request_id: _retryRequestId, ...stableResponse } = parsed;

    const factRequest: SemanticFactExtractionRequest = {
      schema_version: 'semantic-fact-extraction-request-v1',
      owner_user_id: 'authorized-review-only-owner',
      project_id: 'authorized-rq-202509-review-only',
      input_revision: 1,
      input_hash: sha('authorized review-only input revision'),
      issuer_identity_record_id: 'reviewed-rq-identity',
      issuer_identity_version: 1,
      issuer_identity_hash: sha('authorized review-only identity binding'),
      entity_id: 'authorized-rq-entity',
      material_id: file.file_id,
      material_version: 1,
      material_sha256: contentHash,
      parse_snapshot_id: 'authorized-rq-review-only-snapshot',
      parse_response_sha256: sha(canonical(stableResponse)),
      parser_version: parsed.parser_version,
      records: parsed.records,
    };
    const mapped = await createNativeFinancialFactExtractor(async () => ({
      status: parsed.status,
      warnings: parsed.warnings,
    })).extract(factRequest);
    const q3Candidates = await createRqQ3FormulaCandidateExtractor(async () => ({
      status: parsed.status,
      warnings: parsed.warnings,
    })).extract(factRequest);
    assert.deepEqual(mapped.parse_snapshot, {
      snapshot_id: factRequest.parse_snapshot_id,
      response_sha256: factRequest.parse_response_sha256,
      parser_version: parsed.parser_version,
      material_id: file.file_id,
      material_version: 1,
      content_sha256: contentHash,
    });

    const statement = parsed.records.filter(
      (record) => record.locator_type === 'xlsx_cell' && record.locator.sheet === '02合并利润表',
    );
    const parentStatement = parsed.records.filter(
      (record) => record.locator_type === 'xlsx_cell' && record.locator.sheet === '02母公司利润表',
    );
    const byCell = (cell: string) => statement.find((record) => record.locator.cell === cell);
    const parentByCell = (cell: string) =>
      parentStatement.find((record) => record.locator.cell === cell);
    assert.equal(byCell('B3')?.literal_quote, '2025年1-9月');
    assert.equal(byCell('D4')?.literal_quote, '2025年1-9月');
    assert.equal(byCell('E3')?.literal_quote, '金额单位：人民币元');
    assert.equal(byCell('A6')?.literal_quote.trim(), '其中：营业收入');
    assert.equal(byCell('D6')?.literal_quote, '=[1]利润试算!$AI$7');
    assert.ok(byCell('D6')?.uncertainty.includes('formula_cached_result_unverified'));
    assert.equal(byCell('D6')?.formatting.cached_formula_result, '641154596.19');
    assert.equal(byCell('A24')?.literal_quote.trim(), '其中：利息费用');
    assert.equal(byCell('D24')?.literal_quote, '295374639.71');
    assert.equal(byCell('D24')?.uncertainty.length, 0);
    assert.equal(byCell('A25')?.literal_quote.trim(), '利息收入');
    assert.equal(byCell('D25')?.literal_quote, '5438663.77');
    assert.equal(byCell('D25')?.uncertainty.length, 0);
    assert.equal(parentByCell('A1')?.literal_quote, '母公司利润表');
    assert.ok(parentByCell('D6')?.uncertainty.includes('formula_cached_result_unverified'));
    assert.ok(parentByCell('D24')?.uncertainty.includes('formula_cached_result_unverified'));

    assert.deepEqual(mapped.facts.map((fact) => fact.identity.metric).sort(), [
      'interest_expense',
      'interest_income',
    ]);
    assert.ok(
      mapped.facts.every(
        (fact) =>
          fact.source_kind === 'external' && fact.identity.basis === 'reported_financial_statement',
      ),
    );
    assert.equal(mapped.needs_review.length, 1);
    assert.equal(
      q3Candidates.facts.length,
      8,
      `the separate Q3 mapper emits exactly the eight allowlisted current-period formula candidates; mapped=${q3Candidates.facts.map((fact) => `${fact.identity.scope}:${fact.identity.metric}`).join(',')}; reviewed=${JSON.stringify(
        q3Candidates.needs_review.map((item) => ({
          reason: item.reason_code,
          cells: item.evidence_refs.map((id) => {
            const record = parsed.records.find((row) => row.record_id === id)!;
            return record.locator_type === 'xlsx_cell'
              ? `${record.locator.sheet}!${record.locator.cell}`
              : record.locator_type;
          }),
        })),
      )}`,
    );
    assert.equal(q3Candidates.needs_review.length, 0);
    assert.ok(
      q3Candidates.facts.every(
        (fact) =>
          fact.source_kind === 'external' &&
          fact.confidence < 0.9 &&
          fact.uncertainty.includes('FORMULA_CACHE_VALUE_UNVERIFIED') &&
          fact.uncertainty.includes('FORMULA_SOURCE_CHAIN_UNVERIFIED'),
      ),
    );
    assert.ok(
      q3Candidates.facts
        .filter((fact) => fact.identity.metric === 'operating_revenue')
        .every((fact) => fact.uncertainty.includes('REVENUE_EXTERNAL_WORKBOOK_NOT_AUTHORIZED')),
    );
    assert.ok(
      q3Candidates.facts
        .filter((fact) => fact.identity.scope === 'parent_only')
        .every((fact) => fact.uncertainty.includes('PERIOD_HEADER_FORMULA_CACHE_UNVERIFIED')),
    );
    assert.deepEqual(
      q3Candidates.facts.map((fact) => `${fact.identity.scope}:${fact.identity.metric}`).sort(),
      [
        'consolidated:net_cash_from_operating_activities',
        'consolidated:net_profit',
        'consolidated:operating_revenue',
        'consolidated:total_assets',
        'parent_only:net_cash_from_operating_activities',
        'parent_only:net_profit',
        'parent_only:operating_revenue',
        'parent_only:total_assets',
      ],
    );
    for (const fact of q3Candidates.facts) {
      const expected =
        fact.identity.metric === 'total_assets'
          ? { sheet: '01', cell: 'D78' }
          : fact.identity.metric === 'operating_revenue'
            ? { sheet: '02', cell: 'D6' }
            : fact.identity.metric === 'net_profit'
              ? { sheet: '02', cell: 'D44' }
              : { sheet: '03', cell: 'C32' };
      const expectedSheet = `${expected.sheet}${fact.identity.scope === 'consolidated' ? '合并' : '母公司'}`;
      const target = fact.evidence_refs
        .map((id) => parsed.records.find((record) => record.record_id === id)!)
        .find(
          (record) =>
            record.locator_type === 'xlsx_cell' &&
            typeof record.locator.sheet === 'string' &&
            record.locator.sheet.startsWith(expectedSheet) &&
            record.locator.cell === expected.cell,
        );
      assert.ok(target, 'each Q3 candidate retains its exact formula and cache evidence anchor');
      assert.ok(target.literal_quote.startsWith('='));
      assert.ok(target.uncertainty.includes('formula_cached_result_unverified'));
      assert.equal(typeof target.formatting.cached_formula_result, 'string');
      assert.equal(
        fact.identity.period.start,
        fact.identity.metric === 'total_assets' ? '2025-09-30' : '2025-01-01',
      );
      assert.equal(fact.identity.period.end, '2025-09-30');
      assert.equal(fact.identity.currency, 'CNY');
      assert.equal(fact.identity.unit, 'yuan');
    }
    const revenueReview = mapped.needs_review[0]!;
    assert.equal(revenueReview.reason_code, 'PARSER_EVIDENCE_NEEDS_CONFIRMATION');
    assert.ok(
      revenueReview.evidence_refs.includes(byCell('D6')!.record_id),
      'uncertain operating revenue must retain its exact cell anchor',
    );
    assert.ok(
      revenueReview.evidence_refs.every((recordId) => {
        const record = parsed.records.find((item) => item.record_id === recordId);
        return record?.locator_type === 'xlsx_cell' && record.locator.sheet === '02合并利润表';
      }),
      'revenue review anchors must stay on the visible consolidated statement',
    );
    assert.ok(
      mapped.facts.every(
        (fact) =>
          fact.identity.scope === 'consolidated' &&
          fact.identity.period.start === '2025-01-01' &&
          fact.identity.period.end === '2025-09-30' &&
          fact.identity.currency === 'CNY' &&
          fact.identity.unit === 'yuan',
      ),
    );
    const interestExpense = mapped.facts.find(
      (fact) => fact.identity.metric === 'interest_expense',
    );
    const interestIncome = mapped.facts.find((fact) => fact.identity.metric === 'interest_income');
    assert.equal(interestExpense?.value.kind, 'known');
    if (interestExpense?.value.kind === 'known')
      assert.equal(interestExpense.value.decimalOrText, '295374639.71');
    assert.equal(interestIncome?.value.kind, 'known');
    if (interestIncome?.value.kind === 'known')
      assert.equal(interestIncome.value.decimalOrText, '5438663.77');
    assert.ok(interestExpense?.evidence_refs.includes(byCell('A24')!.record_id));
    assert.ok(interestExpense?.evidence_refs.includes(byCell('D24')!.record_id));
    assert.ok(interestIncome?.evidence_refs.includes(byCell('A25')!.record_id));
    assert.ok(interestIncome?.evidence_refs.includes(byCell('D25')!.record_id));
    assert.ok(
      mapped.facts.every((fact) =>
        fact.evidence_refs.every((recordId) => {
          const record = parsed.records.find((item) => item.record_id === recordId);
          return record?.locator_type === 'xlsx_cell' && record.locator.sheet === '02合并利润表';
        }),
      ),
      'parent and hidden auxiliary sheets must never supply consolidated fact anchors',
    );
    const evidenceIds = new Set(parsed.records.map((record) => record.record_id));
    assert.ok(
      mapped.needs_review[0]!.evidence_refs.every((recordId) => evidenceIds.has(recordId)),
      'review refs must point back to parser evidence',
    );
  },
);
