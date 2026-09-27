import {
  SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
  type SemanticFactExtractionRequest,
  type SemanticFactExtractionResult,
  type SemanticFactExtractor,
} from './fact-candidate-producer.js';
import type { NativeFinancialParseCompletionResolver } from './native-financial-fact-extractor.js';
import {
  RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID,
  RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION,
  RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256,
} from './rq-prospectus-annual-fact-constants.js';

/** Narrow mapper for the explicitly identified historical-prospectus statement tables in rq-202509. */
const PARSER_VERSIONS = new Set([
  'bondbuddy-document-parser-1.0.3',
  'bondbuddy-document-parser-1.0.5',
  'bondbuddy-document-parser-1.0.6',
]);
const ACCEPTED_DOCX_WARNINGS = new Set(['DOCX_DRAWINGS', 'DOCX_AUXILIARY_PARTS']);
const MAX_REVIEW_EVIDENCE_REFS = 32;

interface TableSpec {
  table: number;
  title: string;
  scope: 'consolidated' | 'parent_only';
  statement: 'balance' | 'income' | 'cashflow';
  rows: Readonly<Record<string, { row: number; label: string; metric: string; periodKind: 'asOf' | 'range' }>>;
}

const SPECS: readonly TableSpec[] = [
  { table: 44, title: '表5-1', scope: 'consolidated', statement: 'balance', rows: {
    assets: { row: 26, label: '资产总计', metric: 'total_assets', periodKind: 'asOf' },
  } },
  { table: 45, title: '表5-2', scope: 'consolidated', statement: 'income', rows: {
    revenue: { row: 3, label: '其中：营业收入', metric: 'operating_revenue', periodKind: 'range' },
    profit: { row: 25, label: '五、净利润（净亏损“-”填列）', metric: 'net_profit', periodKind: 'range' },
  } },
  { table: 46, title: '表5-3', scope: 'consolidated', statement: 'cashflow', rows: {
    operating_cashflow: { row: 12, label: '经营活动产生的现金流量净额', metric: 'net_cash_from_operating_activities', periodKind: 'range' },
  } },
  { table: 47, title: '表5-4', scope: 'parent_only', statement: 'balance', rows: {
    assets: { row: 24, label: '资产总计', metric: 'total_assets', periodKind: 'asOf' },
  } },
  { table: 48, title: '表5-5', scope: 'parent_only', statement: 'income', rows: {
    revenue: { row: 2, label: '一、营业收入', metric: 'operating_revenue', periodKind: 'range' },
    profit: { row: 24, label: '五、净利润（净亏损“-”填列）', metric: 'net_profit', periodKind: 'range' },
  } },
  { table: 49, title: '表5-6', scope: 'parent_only', statement: 'cashflow', rows: {
    operating_cashflow: { row: 12, label: '经营活动产生的现金流量净额', metric: 'net_cash_from_operating_activities', periodKind: 'range' },
  } },
];

type RecordEntry = SemanticFactExtractionRequest['records'][number];
type DocxRecord = RecordEntry & { locator: { path: Array<Record<string, unknown>> } };
type TableCoordinate = { table: number; row: number; column: number };

function docxPath(record: RecordEntry): DocxRecord['locator']['path'] | null {
  if (record.locator_type !== 'docx_block' || !Array.isArray(record.locator.path)) return null;
  const path = record.locator.path;
  if (path.length !== 2 || !path.every((part) => typeof part === 'object' && part !== null && !Array.isArray(part))) return null;
  return path as DocxRecord['locator']['path'];
}

function tableCoordinate(record: RecordEntry): TableCoordinate | null {
  const path = docxPath(record);
  const table = path?.[0]?.table;
  const row = path?.[0]?.row;
  const column = path?.[0]?.column;
  if (!Number.isSafeInteger(table) || !Number.isSafeInteger(row) || !Number.isSafeInteger(column) ||
      !Number.isSafeInteger(path?.[1]?.paragraph) || Number(path?.[1]?.paragraph) < 1) return null;
  return { table: Number(table), row: Number(row), column: Number(column) };
}

function paragraphNumber(record: RecordEntry): number | null {
  if (record.locator_type !== 'docx_block' || !Array.isArray(record.locator.path) || record.locator.path.length !== 1) return null;
  const part = record.locator.path[0];
  if (!part || typeof part !== 'object' || !Number.isSafeInteger((part as Record<string, unknown>).paragraph)) return null;
  return Number((part as Record<string, number>).paragraph);
}

function trim(value: string): string { return value.replace(/[\u3000\s]+/g, '').trim(); }

function evidenceForCell(records: readonly RecordEntry[], table: number, row: number, column: number): RecordEntry[] {
  return records.filter((record) => {
    const coordinate = tableCoordinate(record);
    return coordinate?.table === table && coordinate.row === row && coordinate.column === column;
  });
}

function periodValue(label: string, periodKind: 'asOf' | 'range'): { start?: string; end?: string; asOf?: string } | null {
  const normalized = trim(label);
  if (periodKind === 'asOf') {
    const match = /^(20\d{2})年末$/.exec(normalized);
    return match ? { asOf: `${match[1]}-12-31` } : null;
  }
  const match = /^(20\d{2})年度$/.exec(normalized);
  return match ? { start: `${match[1]}-01-01`, end: `${match[1]}-12-31` } : null;
}

function amount(value: string): string | null {
  const normalized = trim(value).replaceAll(',', '');
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) ? normalized : null;
}

function boundedEvidenceIds(refs: readonly RecordEntry[]): string[] {
  return [...new Set(refs.map((record) => record.record_id).filter(Boolean))].slice(0, MAX_REVIEW_EVIDENCE_REFS);
}

function review(request: SemanticFactExtractionRequest, reason: string, refs: readonly RecordEntry[]): SemanticFactExtractionResult {
  const ids = boundedEvidenceIds(refs);
  if (!ids.length) {
    const error = new Error('RQ_PROSPECTUS_NO_REVIEW_EVIDENCE');
    error.name = 'RqProspectusAnnualFactExtractorError';
    throw error;
  }
  return {
    schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
    extractor: { id: RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID, version: RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION },
    parse_snapshot: { snapshot_id: request.parse_snapshot_id, response_sha256: request.parse_response_sha256,
      parser_version: request.parser_version, material_id: request.material_id, material_version: request.material_version,
      content_sha256: request.material_sha256 },
    facts: [], needs_review: [{ evidence_refs: ids, reason_code: reason }],
  };
}

function allRecords(request: SemanticFactExtractionRequest, table: number): RecordEntry[] {
  return request.records.filter((record) => tableCoordinate(record)?.table === table);
}

function precedingParagraphs(request: SemanticFactExtractionRequest, beforeIndex: number): Array<{ record: RecordEntry; paragraph: number }> {
  return request.records.slice(0, beforeIndex).flatMap((record) => {
    const paragraph = paragraphNumber(record);
    return paragraph === null ? [] : [{ record, paragraph }];
  });
}

function contextEvidence(request: SemanticFactExtractionRequest, table: number, firstIndex: number):
  { title?: RecordEntry; unit?: RecordEntry; section?: RecordEntry } {
  const previous = precedingParagraphs(request, firstIndex);
  const priorTableLastIndex = request.records.reduce((latest, record, index) =>
    tableCoordinate(record)?.table === table - 1 ? index : latest, -1);
  const localParagraphs = previous.filter(({ record }) => request.records.indexOf(record) > priorTableLastIndex);
  const title = [...localParagraphs].reverse().find(({ record }) => trim(record.literal_quote).startsWith(`表5-${table - 43}`));
  const titleIndex = title ? request.records.indexOf(title.record) : -1;
  const unit = [...localParagraphs].reverse().find(({ record }) => request.records.indexOf(record) > titleIndex &&
    trim(record.literal_quote) === '单位：万元');

  const groupStartTable = table <= 46 ? 44 : 47;
  const groupStartIndex = request.records.findIndex((record) => tableCoordinate(record)?.table === groupStartTable);
  const priorGroupTableLastIndex = request.records.reduce((latest, record, index) =>
    tableCoordinate(record)?.table === groupStartTable - 1 ? index : latest, -1);
  const sectionLabel = table <= 46 ? '（一）合并财务报表' : '（二）母公司财务报表';
  const sectionCandidates = precedingParagraphs(request, groupStartIndex < 0 ? firstIndex : groupStartIndex)
    .filter(({ record }) => request.records.indexOf(record) > priorGroupTableLastIndex);
  const section = [...sectionCandidates].reverse().find(({ record }) => trim(record.literal_quote) === sectionLabel);
  return { title: title?.record, unit: unit?.record, section: section?.record };
}

function tableCellText(request: SemanticFactExtractionRequest, table: number, row: number, column: number): { record?: RecordEntry; text?: string } {
  const matches = evidenceForCell(request.records, table, row, column);
  return matches.length === 1 ? { record: matches[0], text: matches[0]!.literal_quote } : {};
}

/**
 * Extracts only the issuer's explicitly labeled FY2023/FY2024 annual statements from historical
 * prospectus tables 5-1 through 5-6. It remains an external/PDS source and cannot attest audit.
 */
export function createRqProspectusAnnualFactExtractor(
  resolveParseCompletion: NativeFinancialParseCompletionResolver,
): SemanticFactExtractor {
  return {
    id: RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID,
    version: RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION,
    async extract(request) {
      const completion = await resolveParseCompletion(request);
      if (request.material_sha256 !== RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256 ||
          !PARSER_VERSIONS.has(request.parser_version) || request.records.some((record) => record.locator_type !== 'docx_block')) {
        return review(request, 'UNSUPPORTED_RQ_PROSPECTUS_PARSE', request.records);
      }
      if ((completion.status !== 'parsed' && completion.status !== 'needs_confirmation') ||
          completion.warnings.some((warning) => !ACCEPTED_DOCX_WARNINGS.has(warning.code))) {
        return review(request, 'RQ_PROSPECTUS_PARSE_NEEDS_CONFIRMATION', request.records);
      }
      const issuerEvidence = request.records.find((record) => paragraphNumber(record) !== null &&
        record.literal_quote.includes('任丘市建设投资集团有限公司'));
      if (!issuerEvidence || issuerEvidence.uncertainty.length > 0) {
        return review(request, 'RQ_PROSPECTUS_ISSUER_EVIDENCE_MISSING_OR_UNCERTAIN', issuerEvidence ? [issuerEvidence] : request.records);
      }

      const facts: SemanticFactExtractionResult['facts'][number][] = [];
      const reviewRefs: RecordEntry[] = [];
      for (const spec of SPECS) {
        const tableRecords = allRecords(request, spec.table);
        const firstIndex = request.records.findIndex((record) => tableCoordinate(record)?.table === spec.table);
        if (!tableRecords.length || firstIndex < 0) {
          reviewRefs.push(...request.records.filter((record) => {
            const paragraph = paragraphNumber(record);
            const text = trim(record.literal_quote);
            return paragraph !== null && (text.startsWith(spec.title) || text === '单位：万元' ||
              text === (spec.scope === 'consolidated' ? '（一）合并财务报表' : '（二）母公司财务报表'));
          }));
          continue;
        }
        const { title, unit, section } = contextEvidence(request, spec.table, firstIndex);
        const expectedTitlePrefix = spec.title;
        const titleText = title ? trim(title.literal_quote) : '';
        const unitText = unit ? trim(unit.literal_quote) : '';
        const header = [2, 3, 4].map((column) => tableCellText(request, spec.table, 1, column));
        const headerLabels = header.map((cell) => cell.text ? trim(cell.text) : '');
        const headerPeriods = headerLabels.map((value) => periodValue(value, spec.statement === 'balance' ? 'asOf' : 'range'));
        const headerOkay = headerPeriods[1] !== null && headerPeriods[2] !== null &&
          JSON.stringify(headerPeriods[1]) === JSON.stringify(spec.statement === 'balance'
            ? { asOf: '2024-12-31' } : { start: '2024-01-01', end: '2024-12-31' }) &&
          JSON.stringify(headerPeriods[2]) === JSON.stringify(spec.statement === 'balance'
            ? { asOf: '2023-12-31' } : { start: '2023-01-01', end: '2023-12-31' });
        const expectedSection = spec.scope === 'consolidated' ? '（一）合并财务报表' : '（二）母公司财务报表';
        if (!title || !titleText.startsWith(expectedTitlePrefix) || !section || trim(section.literal_quote) !== expectedSection ||
            !unit || unitText !== '单位：万元' || !headerOkay || header.some((cell) => !cell.record)) {
          reviewRefs.push(...(title ? [title] : []), ...(unit ? [unit] : []), ...(section ? [section] : []),
            ...header.flatMap((cell) => cell.record ? [cell.record] : []));
          continue;
        }

        for (const definition of Object.values(spec.rows)) {
          const labelCell = tableCellText(request, spec.table, definition.row, 1);
          const normalizedExpected = trim(definition.label);
          if (!labelCell.record || trim(labelCell.text ?? '') !== normalizedExpected) {
            reviewRefs.push(title, unit, section, ...header.flatMap((cell) => cell.record ? [cell.record] : []),
              ...(labelCell.record ? [labelCell.record] : []));
            continue;
          }
          for (const column of [3, 4]) {
            const headerRecord = header[column - 2]!.record!;
            const valueCell = tableCellText(request, spec.table, definition.row, column);
            const value = valueCell.text ? amount(valueCell.text) : null;
            if (!valueCell.record || valueCell.record.uncertainty.length > 0 || value === null ||
                labelCell.record.uncertainty.length > 0 || headerRecord.uncertainty.length > 0 ||
                title.uncertainty.length > 0 || unit.uncertainty.length > 0 || section.uncertainty.length > 0) {
              reviewRefs.push(...[title, unit, section, headerRecord, labelCell.record, ...(valueCell.record ? [valueCell.record] : [])]);
              continue;
            }
            const period = periodValue(headerLabels[column - 2]!, definition.periodKind);
            if (!period) {
              reviewRefs.push(title, unit, section, headerRecord, labelCell.record, valueCell.record);
              continue;
            }
            facts.push({
              extraction_id: `rq-${definition.metric}-${spec.scope}-${'asOf' in period ? period.asOf : period.start?.slice(0, 4)}`,
              identity: { scope: spec.scope, metric: definition.metric, period, currency: 'CNY', unit: 'ten_thousand_yuan',
                basis: 'reported_financial_statement_in_historical_prospectus' },
              value: { kind: 'known', decimalOrText: value }, source_kind: 'external', confidence: 1, uncertainty: [],
              evidence_refs: [issuerEvidence.record_id, title.record_id, unit.record_id, section.record_id,
                headerRecord.record_id, labelCell.record!.record_id, valueCell.record!.record_id],
            });
          }
        }
      }

      if (facts.length === 0 && reviewRefs.length === 0) return review(request, 'RQ_PROSPECTUS_ANNUAL_TABLES_MISSING', request.records);
      return {
        schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
        extractor: { id: RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID, version: RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION },
        parse_snapshot: { snapshot_id: request.parse_snapshot_id, response_sha256: request.parse_response_sha256,
          parser_version: request.parser_version, material_id: request.material_id, material_version: request.material_version,
          content_sha256: request.material_sha256 },
        facts,
        needs_review: reviewRefs.length ? [{ evidence_refs: boundedEvidenceIds(reviewRefs),
          reason_code: 'RQ_PROSPECTUS_ANNUAL_TABLE_INCOMPLETE_OR_UNCERTAIN' }] : [],
      };
    },
  };
}
