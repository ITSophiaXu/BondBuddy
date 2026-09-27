import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SemanticFactExtractionRequest } from './fact-candidate-producer.js';
import { createRqQ3FormulaCandidateExtractor, RQ_Q3_FORMULA_SOURCE_SHA256 } from './rq-q3-formula-candidate-extractor.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function request(overrides: Partial<SemanticFactExtractionRequest> = {}): SemanticFactExtractionRequest {
  const records: SemanticFactExtractionRequest['records'][number][] = [];
  const add = (sheet: string, cell: string, literal_quote: string,
    formatting: Record<string, unknown> = {}, uncertainty: string[] = []) => {
    records.push({ record_id: `evidence-${records.length}`, material_id: 'material-rq-q3', material_version: 1,
      content_hash: RQ_Q3_FORMULA_SOURCE_SHA256, locator_type: 'xlsx_cell', locator: { sheet, cell }, literal_quote,
      context: '', extraction_method: 'native_text', extractor_version: 'bondbuddy-document-parser-1.0.6', confidence: 1,
      uncertainty, formatting: { sheet_state: 'visible', ...formatting } });
  };
  const statements = [
    { sheet: '01合并资产负债表', period: '2025年9月30日', parent: false, header: '期末余额', cells: [['资产总计', 'D78']] },
    { sheet: '01母公司资产负债', period: '2025年9月30日', parent: true, header: '期末余额', cells: [['资产总计', 'D78']] },
    { sheet: '02合并利润表', period: '2025年1-9月', parent: false, header: '2025年1-9月', cells: [['其中：营业收入', 'D6'], ['净利润', 'D44']] },
    { sheet: '02母公司利润表', period: '2025年1-9月', parent: true, header: '本期金额', cells: [['其中：营业收入', 'D6'], ['净利润', 'D44']] },
    { sheet: '03合并现金流量表', period: '2025年1-9月', parent: false, header: '2025年1-9月', cells: [['经营活动产生的现金流量净额', 'C32']] },
    { sheet: '03母公司现金流量表', period: '2025年1-9月', parent: true, header: '本期金额', cells: [['经营活动产生的现金流量净额', 'C32']] },
  ] as const;
  for (const { sheet, period, parent, header, cells } of statements) {
    const kind = sheet.startsWith('01') ? '资产负债表' : sheet.startsWith('02') ? '利润表' : '现金流量表';
    add(sheet, 'A1', `${parent ? '母公司' : '合并'}${kind}`);
    add(sheet, 'B3', parent ? `=period!A1` : period,
      parent ? { cached_formula_result: period } : {});
    add(sheet, sheet.startsWith('03') ? 'C4' : 'D4', header);
    const unitCell = sheet.startsWith('01') && parent ? 'F3' : sheet.startsWith('03') ? 'D3' : 'E3';
    add(sheet, unitCell, '金额单位：人民币元');
    for (const [label, valueCell] of cells) {
      add(sheet, `A${valueCell.match(/\d+$/)![0]}`, label);
      add(sheet, valueCell, '=SUM(B1:B2)', { cached_formula_result: '123.4500' }, ['formula_cached_result_unverified']);
    }
  }
  // A hidden formula/cache remains outside the exact visible current-period allowlist.
  add('Sheet1', 'A1', '=SUM(A2:A3)', { sheet_state: 'hidden', cached_formula_result: '999' }, ['formula_cached_result_unverified']);
  return {
    schema_version: 'semantic-fact-extraction-request-v1', owner_user_id: 'owner-1', project_id: 'project-1',
    input_revision: 1, input_hash: digest('input'), issuer_identity_record_id: 'identity-1', issuer_identity_version: 1,
    issuer_identity_hash: digest('identity'), entity_id: 'issuer-1', material_id: 'material-rq-q3', material_version: 1,
    material_sha256: RQ_Q3_FORMULA_SOURCE_SHA256, parse_snapshot_id: 'snapshot-1',
    parse_response_sha256: digest('response'), parser_version: 'bondbuddy-document-parser-1.0.6', records, ...overrides,
  };
}

test('RQ Q3 formula mapper emits only eight external needs-confirmation cache candidates with exact statement anchors', async () => {
  const req = request();
  const extractor = createRqQ3FormulaCandidateExtractor(async () => ({ status: 'needs_confirmation', warnings: [
    { code: 'XLSX_HIDDEN_SHEET', message: 'hidden sheet present' },
    { code: 'XLSX_FORMULA_CACHE_UNVERIFIED', message: 'formula caches are unresolved' },
  ] }));
  const result = await extractor.extract(req);
  assert.equal(result.facts.length, 8);
  assert.deepEqual(result.needs_review, []);
  assert.ok(result.facts.every(fact => fact.source_kind === 'external' && fact.value.kind === 'known' &&
    fact.confidence < 0.9 && fact.uncertainty.includes('FORMULA_CACHE_VALUE_UNVERIFIED') &&
    fact.uncertainty.includes('FORMULA_SOURCE_CHAIN_UNVERIFIED')));
  assert.deepEqual(result.facts.map(fact => `${fact.identity.scope}:${fact.identity.metric}`).sort(), [
    'consolidated:net_cash_from_operating_activities', 'consolidated:net_profit', 'consolidated:operating_revenue',
    'consolidated:total_assets', 'parent_only:net_cash_from_operating_activities', 'parent_only:net_profit',
    'parent_only:operating_revenue', 'parent_only:total_assets',
  ]);
  assert.ok(result.facts.filter(fact => fact.identity.metric === 'operating_revenue').every(fact =>
    fact.uncertainty.includes('REVENUE_EXTERNAL_WORKBOOK_NOT_AUTHORIZED')));
  assert.ok(result.facts.filter(fact => fact.identity.scope === 'parent_only').every(fact =>
    fact.uncertainty.includes('PERIOD_HEADER_FORMULA_CACHE_UNVERIFIED')));
  for (const fact of result.facts) {
    const value = fact.evidence_refs.map(id => req.records.find(record => record.record_id === id)!).find(record =>
      record.locator_type === 'xlsx_cell' && record.formatting.cached_formula_result === '123.4500');
    assert.ok(value);
    assert.ok(value.uncertainty.includes('formula_cached_result_unverified'));
    assert.equal(value.formatting.cached_formula_result, '123.4500');
    assert.equal(fact.identity.period.start, fact.identity.metric === 'total_assets' ? '2025-09-30' : '2025-01-01');
    assert.equal(fact.identity.period.end, '2025-09-30');
    assert.equal(fact.identity.currency, 'CNY');
    assert.equal(fact.identity.unit, 'yuan');
  }
  const parser107Request=request({parser_version:'bondbuddy-document-parser-1.0.7',
    records:req.records.map(record=>({...record,extractor_version:'bondbuddy-document-parser-1.0.7'}))});
  const parser107Result=await extractor.extract(parser107Request);
  assert.deepEqual(parser107Result.facts,result.facts);
  assert.deepEqual(parser107Result.needs_review,result.needs_review);
});

test('RQ Q3 formula mapper fails closed on a source hash mismatch and an unrecognized formula cache', async () => {
  const resolver = async () => ({ status: 'needs_confirmation' as const, warnings: [
    { code: 'XLSX_FORMULA_CACHE_UNVERIFIED', message: 'formula caches are unresolved' },
  ] });
  const extractor = createRqQ3FormulaCandidateExtractor(resolver);
  const wrongSource = await extractor.extract(request({ material_sha256: digest('other workbook') }));
  assert.equal(wrongSource.facts.length, 0);
  assert.equal(wrongSource.needs_review[0]?.reason_code, 'RQ_Q3_FORMULA_SOURCE_OR_PARSER_UNSUPPORTED');

  const req = request();
  const target = req.records.find(record => record.locator_type === 'xlsx_cell' && record.locator.sheet === '01合并资产负债表' && record.locator.cell === 'D78');
  assert.ok(target);
  const changed = req.records.map(record => record === target ? { ...record, uncertainty: [] } : record);
  const invalid = await extractor.extract({ ...req, records: changed });
  assert.equal(invalid.facts.length, 7);
  assert.equal(invalid.needs_review.length, 1);
  assert.equal(invalid.needs_review[0]?.reason_code, 'RQ_Q3_FORMULA_CACHE_ANCHOR_INCOMPLETE');
});
