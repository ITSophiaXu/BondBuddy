import {
  SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
  type SemanticFactExtractionRequest,
  type SemanticFactExtractionResult,
  type SemanticFactExtractor,
} from './fact-candidate-producer.js';
import type { DocumentParseResponse } from './document-parser.js';

/** This first native mapper is intentionally limited to one explicit XLSX layout and metric. */
export const NATIVE_FINANCIAL_FACT_EXTRACTOR_ID = 'native-consolidated-income-statement' as const;
export const NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION = '1.0.0' as const;
const SUPPORTED_PARSER_VERSIONS = new Set([
  'bondbuddy-document-parser-1.0.3',
  'bondbuddy-document-parser-1.0.5',
  'bondbuddy-document-parser-1.0.6',
]);
const TARGET_SHEET = '合并利润表';
const TARGET_METRIC = 'operating_revenue';
const TARGET_PERIOD = { start: '2023-01-01', end: '2023-12-31' } as const;
const MAX_REVIEW_EVIDENCE_REFS = 32;

type CellRecord = SemanticFactExtractionRequest['records'][number] & {
  locator: { sheet: string; cell: string };
};

export type NativeFinancialParseCompletion = Pick<DocumentParseResponse, 'status' | 'warnings'>;
export type NativeFinancialParseCompletionResolver = (
  request: SemanticFactExtractionRequest,
) => Promise<NativeFinancialParseCompletion>;

function isCellRecord(record: SemanticFactExtractionRequest['records'][number]): record is CellRecord {
  return record.locator_type === 'xlsx_cell' && typeof record.locator.sheet === 'string' &&
    typeof record.locator.cell === 'string' && /^[A-Z]{1,3}[1-9][0-9]*$/.test(record.locator.cell);
}

function columnOf(cell: string): string {
  return /^[A-Z]+/.exec(cell)?.[0] ?? '';
}

function rowOf(cell: string): number {
  return Number(/[1-9][0-9]*$/.exec(cell)?.[0] ?? NaN);
}

function inTargetSheet(records: readonly CellRecord[]): CellRecord[] {
  return records.filter((record) => record.locator.sheet === TARGET_SHEET);
}

function boundedEvidenceRefs(
  request: SemanticFactExtractionRequest,
  relevantEvidence: readonly SemanticFactExtractionRequest['records'][number][],
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (record: SemanticFactExtractionRequest['records'][number]) => {
    if (record.record_id && !seen.has(record.record_id) && refs.length < MAX_REVIEW_EVIDENCE_REFS) {
      seen.add(record.record_id);
      refs.push(record.record_id);
    }
  };

  // Call-site anchors retain priority and their authored order.
  relevantEvidence.forEach(add);
  // If the anchor set is smaller than the cap, fill deterministically by ID; stable sort preserves
  // the original parser-record order for duplicate IDs.
  request.records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => (left.record.record_id < right.record.record_id ? -1 :
      left.record.record_id > right.record.record_id ? 1 : left.index - right.index))
    .forEach(({ record }) => add(record));
  return refs;
}

function reviewResult(
  request: SemanticFactExtractionRequest,
  reasonCode: string,
  evidence: readonly SemanticFactExtractionRequest['records'][number][],
): SemanticFactExtractionResult {
  const evidenceRefs = boundedEvidenceRefs(request, evidence);
  if (evidenceRefs.length === 0) {
    const error = new Error('NATIVE_FINANCIAL_NO_PARSE_EVIDENCE');
    error.name = 'NativeFinancialFactExtractorError';
    throw error;
  }
  return {
    schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
    extractor: { id: NATIVE_FINANCIAL_FACT_EXTRACTOR_ID, version: NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION },
    parse_snapshot: {
      snapshot_id: request.parse_snapshot_id,
      response_sha256: request.parse_response_sha256,
      parser_version: request.parser_version,
      material_id: request.material_id,
      material_version: request.material_version,
      content_sha256: request.material_sha256,
    },
    facts: [],
    needs_review: [{ evidence_refs: evidenceRefs, reason_code: reasonCode }],
  };
}

/**
 * Extracts only the 2023 consolidated `营业收入` row from a native XLSX `合并利润表`.
 * It uses literal cell anchors and never normalizes units or infers missing table context.
 */
export function createNativeFinancialFactExtractor(
  resolveParseCompletion: NativeFinancialParseCompletionResolver,
): SemanticFactExtractor {
  return {
    id: NATIVE_FINANCIAL_FACT_EXTRACTOR_ID,
    version: NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION,
    async extract(request) {
      const completion = await resolveParseCompletion(request);
      if (completion.status !== 'parsed' || completion.warnings.length > 0) {
        return reviewResult(request, 'PARSER_STATUS_OR_WARNING_NEEDS_CONFIRMATION', []);
      }
      const cells = request.records.filter(isCellRecord);
      if (!SUPPORTED_PARSER_VERSIONS.has(request.parser_version) || cells.length !== request.records.length) {
        return reviewResult(request, 'UNSUPPORTED_NATIVE_FINANCIAL_PARSE', []);
      }

      // XLSX parser warnings are reflected either on the affected cells or as hidden-sheet metadata.
      // If any such evidence exists anywhere in the workbook, this narrow mapper does not guess.
      const uncertain = request.records.filter((record) => record.uncertainty.length > 0 ||
        record.formatting.sheet_state === 'hidden' || record.formatting.sheet_state === 'veryHidden');
      const sheet = inTargetSheet(cells);
      if (uncertain.length > 0) return reviewResult(request, 'PARSER_EVIDENCE_NEEDS_CONFIRMATION', [...uncertain, ...sheet]);
      if (sheet.length === 0) return reviewResult(request, 'FINANCIAL_SHEET_MISSING', request.records);

      const sheetTitle = sheet.filter((record) => record.locator.cell === 'A1' && record.literal_quote === TARGET_SHEET);
      const scopeCells = sheet.filter((record) => record.locator.cell === 'B2' && record.literal_quote === '口径：合并口径');
      const periodNotes = sheet.filter((record) => record.locator.cell === 'C2' && record.literal_quote === '期间：2023年度、2022年度、2021年度');
      const unitCells = sheet.filter((record) => record.locator.cell === 'E2' && record.literal_quote === '金额单位：人民币元');
      const yearHeaders = sheet.filter((record) => rowOf(record.locator.cell) === 3 && record.literal_quote === '2023年度');
      const metricLabels = sheet.filter((record) => /^[\s　]*其中[：:]\s*营业收入[\s　]*$/.test(record.literal_quote) &&
        columnOf(record.locator.cell) === 'A');

      if (sheetTitle.length !== 1 || scopeCells.length !== 1 || periodNotes.length !== 1 || unitCells.length !== 1) {
        return reviewResult(request, 'FINANCIAL_HEADER_OR_UNIT_AMBIGUOUS', sheet.filter((record) => [1, 2].includes(rowOf(record.locator.cell))));
      }
      if (yearHeaders.length !== 1) return reviewResult(request, 'FINANCIAL_PERIOD_HEADER_MISSING_OR_DUPLICATE', sheet.filter((record) => rowOf(record.locator.cell) === 3));
      if (metricLabels.length !== 1) return reviewResult(request, metricLabels.length ? 'FINANCIAL_METRIC_LABEL_DUPLICATE' : 'FINANCIAL_METRIC_LABEL_MISSING', sheet);
      if (!periodNotes[0]!.literal_quote.includes('2023年度') || scopeCells[0]!.literal_quote !== '口径：合并口径' ||
          unitCells[0]!.literal_quote !== '金额单位：人民币元') {
        return reviewResult(request, 'FINANCIAL_PERIOD_SCOPE_OR_UNIT_UNSUPPORTED', [periodNotes[0]!, scopeCells[0]!, unitCells[0]!]);
      }

      const valueCell = `${columnOf(yearHeaders[0]!.locator.cell)}${rowOf(metricLabels[0]!.locator.cell)}`;
      const values = sheet.filter((record) => record.locator.cell === valueCell);
      const numericValue = values[0]?.literal_quote.trim();
      if (values.length !== 1 || numericValue === undefined || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(numericValue)) {
        return reviewResult(request, values.length > 1 ? 'FINANCIAL_VALUE_DUPLICATE' : 'FINANCIAL_VALUE_MISSING_OR_INVALID',
          [metricLabels[0]!, yearHeaders[0]!, ...values]);
      }

      const evidence = [sheetTitle[0]!, scopeCells[0]!, periodNotes[0]!, unitCells[0]!, yearHeaders[0]!, metricLabels[0]!, values[0]!];
      return {
      schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
      extractor: { id: NATIVE_FINANCIAL_FACT_EXTRACTOR_ID, version: NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION },
      parse_snapshot: {
        snapshot_id: request.parse_snapshot_id,
        response_sha256: request.parse_response_sha256,
        parser_version: request.parser_version,
        material_id: request.material_id,
        material_version: request.material_version,
        content_sha256: request.material_sha256,
      },
      facts: [{
        extraction_id: 'zq-consolidated-operating-revenue-2023',
        identity: {
          scope: 'consolidated', metric: TARGET_METRIC, period: TARGET_PERIOD,
          currency: 'CNY', unit: 'yuan', basis: 'reported_financial_statement',
        },
        value: { kind: 'known', decimalOrText: numericValue },
        source_kind: 'external',
        // This is mapping confidence only, not source verification. The producer leaves auditCheck null;
        // parser anchors with null confidence add uncertainty and keep the persisted candidate pending.
        confidence: 1,
        uncertainty: [],
        evidence_refs: evidence.map((record) => record.record_id),
      }],
      needs_review: [],
      };
    },
  };
}
