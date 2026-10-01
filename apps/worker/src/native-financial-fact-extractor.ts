import {
  SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
  type SemanticFactExtractionRequest,
  type SemanticFactExtractionResult,
  type SemanticFactExtractor,
} from './fact-candidate-producer.js';
import type { DocumentParseResponse } from './document-parser.js';

/** Native mapper for two explicit XLSX layouts; every emitted metric remains source-evidence-bound. */
export const NATIVE_FINANCIAL_FACT_EXTRACTOR_ID = 'native-consolidated-income-statement' as const;
export const NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION = '1.1.0' as const;
const SUPPORTED_PARSER_VERSIONS = new Set([
  'bondbuddy-document-parser-1.0.3',
  'bondbuddy-document-parser-1.0.5',
  'bondbuddy-document-parser-1.0.6',
  'bondbuddy-document-parser-1.0.7',
]);
const LEGACY_TARGET_SHEET = '合并利润表';
const INTERIM_TARGET_SHEET = '02合并利润表';
const TARGET_METRIC = 'operating_revenue';
const LEGACY_TARGET_PERIOD = { start: '2023-01-01', end: '2023-12-31' } as const;
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

function isVisible(record: CellRecord): boolean {
  return record.formatting.sheet_state !== 'hidden' && record.formatting.sheet_state !== 'veryHidden';
}

function inTargetSheet(records: readonly CellRecord[], sheetName: string): CellRecord[] {
  return records.filter((record) => record.locator.sheet === sheetName && isVisible(record));
}

function reviewContext(records: readonly CellRecord[]): CellRecord[] {
  const targetSheets = new Set([LEGACY_TARGET_SHEET, INTERIM_TARGET_SHEET]);
  return records.filter((record) => targetSheets.has(record.locator.sheet) && isVisible(record) &&
    (rowOf(record.locator.cell) <= 6 || /营业收入/.test(record.literal_quote)));
}

function parseInterimPeriod(value: string): { start: string; end: string } | null {
  const match = /^([0-9]{4})年1-([0-9]{1,2})月$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${match[1]}-01-01`, end: `${match[1]}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}` };
}

function boundedEvidenceRefs(
  request: SemanticFactExtractionRequest,
  relevantEvidence: readonly SemanticFactExtractionRequest['records'][number][],
  includeFallback = true,
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
  if (!includeFallback) return refs;
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
 * Extracts only an exact consolidated `营业收入` row from the two explicitly supported native
 * XLSX layouts. It uses literal cell anchors and never normalizes units or infers table context.
 */
export function createNativeFinancialFactExtractor(
  resolveParseCompletion: NativeFinancialParseCompletionResolver,
): SemanticFactExtractor {
  return {
    id: NATIVE_FINANCIAL_FACT_EXTRACTOR_ID,
    version: NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION,
    async extract(request) {
      const completion = await resolveParseCompletion(request);
      const cells = request.records.filter(isCellRecord);
      if (!SUPPORTED_PARSER_VERSIONS.has(request.parser_version) || cells.length !== request.records.length) {
        return reviewResult(request, 'UNSUPPORTED_NATIVE_FINANCIAL_PARSE', []);
      }

      const toleratedWarnings = completion.status === 'needs_confirmation' && completion.warnings.length > 0 &&
        completion.warnings.every((warning) => ['XLSX_HIDDEN_SHEET', 'XLSX_FORMULA_CACHE_UNVERIFIED'].includes(warning.code));
      if (!(completion.status === 'parsed' && completion.warnings.length === 0) && !toleratedWarnings) {
        return reviewResult(request, 'PARSER_STATUS_OR_WARNING_NEEDS_CONFIRMATION', reviewContext(cells));
      }

      const targetSheetNames = [LEGACY_TARGET_SHEET, INTERIM_TARGET_SHEET];
      const matchingSheets = targetSheetNames.filter((name) => cells.some((record) => record.locator.sheet === name && isVisible(record)));
      if (matchingSheets.length !== 1) return reviewResult(request, matchingSheets.length ? 'FINANCIAL_SHEET_AMBIGUOUS' : 'FINANCIAL_SHEET_MISSING', request.records);
      const targetSheet = matchingSheets[0]!;
      const sheet = inTargetSheet(cells, targetSheet);
      const currentInterimLayout = targetSheet === INTERIM_TARGET_SHEET;
      const sheetTitle = sheet.filter((record) => record.locator.cell === 'A1' && record.literal_quote === '合并利润表');
      const scopeCells = currentInterimLayout
        ? sheet.filter((record) => record.locator.cell === 'A1' && record.literal_quote === '合并利润表' && targetSheet.startsWith('02'))
        : sheet.filter((record) => record.locator.cell === 'B2' && record.literal_quote === '口径：合并口径');
      const periodNotes = currentInterimLayout
        ? sheet.filter((record) => record.locator.cell === 'B3' && /^\d{4}年1-\d{1,2}月$/.test(record.literal_quote.trim()))
        : sheet.filter((record) => record.locator.cell === 'C2' && /^期间：\d{4}年度、/.test(record.literal_quote));
      const unitCells = currentInterimLayout
        ? sheet.filter((record) => record.locator.cell === 'E3' && record.literal_quote === '金额单位：人民币元')
        : sheet.filter((record) => record.locator.cell === 'E2' && record.literal_quote === '金额单位：人民币元');
      const yearHeaders = currentInterimLayout
        ? sheet.filter((record) => rowOf(record.locator.cell) === 4 && columnOf(record.locator.cell) === 'D' && record.literal_quote === periodNotes[0]?.literal_quote)
        : sheet.filter((record) => rowOf(record.locator.cell) === 3 && record.literal_quote === '2023年度');
      const metricLabels = sheet.filter((record) => /^[\s　]*其中[：:]\s*营业收入[\s　]*$/.test(record.literal_quote) &&
        columnOf(record.locator.cell) === 'A');

      if (sheetTitle.length !== 1 || scopeCells.length !== 1 || periodNotes.length !== 1 || unitCells.length !== 1) {
        return reviewResult(request, 'FINANCIAL_HEADER_OR_UNIT_AMBIGUOUS', sheet.filter((record) => [1, 2].includes(rowOf(record.locator.cell))));
      }
      if (yearHeaders.length !== 1) return reviewResult(request, 'FINANCIAL_PERIOD_HEADER_MISSING_OR_DUPLICATE', sheet.filter((record) => [3, 4].includes(rowOf(record.locator.cell))));
      if (currentInterimLayout) {
        const period = parseInterimPeriod(periodNotes[0]!.literal_quote);
        if (!period) return reviewResult(request, 'FINANCIAL_PERIOD_UNSUPPORTED', [periodNotes[0]!, yearHeaders[0]!]);
        if (unitCells[0]!.literal_quote !== '金额单位：人民币元') {
          return reviewResult(request, 'FINANCIAL_PERIOD_SCOPE_OR_UNIT_UNSUPPORTED', [periodNotes[0]!, scopeCells[0]!, unitCells[0]!]);
        }
        const commonEvidence = [sheetTitle[0]!, periodNotes[0]!, unitCells[0]!, yearHeaders[0]!];
        const definitions = [
          { metric: 'operating_revenue', row: 6, label: /^[\s　]*其中[：:]\s*营业收入[\s　]*$/ },
          { metric: 'interest_expense', row: 24, label: /^[\s　]*其中[：:]\s*利息费用[\s　]*$/ },
          { metric: 'interest_income', row: 25, label: /^[\s　]*利息收入[\s　]*$/ },
        ] as const;
        const facts: SemanticFactExtractionResult['facts'][number][] = [];
        const needsReview: SemanticFactExtractionResult['needs_review'][number][] = [];
        for (const definition of definitions) {
          const labels = sheet.filter((record) => rowOf(record.locator.cell) === definition.row && columnOf(record.locator.cell) === 'A' && definition.label.test(record.literal_quote));
          if (labels.length === 0 && definition.metric !== 'operating_revenue') continue;
          if (labels.length !== 1) {
            needsReview.push({ evidence_refs: boundedEvidenceRefs(request, [...commonEvidence, ...labels], false), reason_code: labels.length ? 'FINANCIAL_METRIC_LABEL_DUPLICATE' : 'FINANCIAL_METRIC_LABEL_MISSING' });
            continue;
          }
          const valueCell = `D${definition.row}`;
          const values = sheet.filter((record) => record.locator.cell === valueCell);
          const value = values[0]?.literal_quote.trim();
          const support = [...commonEvidence, labels[0]!, ...values];
          if (values.length !== 1 || values[0]!.uncertainty.length > 0 || value === undefined || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
            needsReview.push({ evidence_refs: boundedEvidenceRefs(request, support, false),
              reason_code: values.length > 1 ? 'FINANCIAL_VALUE_DUPLICATE' : values[0]?.uncertainty.length ? 'PARSER_EVIDENCE_NEEDS_CONFIRMATION' : 'FINANCIAL_VALUE_MISSING_OR_INVALID' });
            continue;
          }
          if (support.some((record) => record.uncertainty.length > 0)) {
            needsReview.push({ evidence_refs: boundedEvidenceRefs(request, support.filter((record) => record.uncertainty.length > 0).concat(labels[0]!, values[0]!), false),
              reason_code: 'PARSER_EVIDENCE_NEEDS_CONFIRMATION' });
            continue;
          }
          facts.push({
            extraction_id: `financial-${period.start}-${period.end}-${definition.metric}`,
            identity: { scope: 'consolidated', metric: definition.metric, period, currency: 'CNY', unit: 'yuan', basis: 'reported_financial_statement' },
            value: { kind: 'known', decimalOrText: value }, source_kind: 'external', confidence: 1, uncertainty: [],
            evidence_refs: [...new Set(support.map((record) => record.record_id))],
          });
        }
        if (facts.length === 0 && needsReview.length === 0) return reviewResult(request, 'FINANCIAL_METRIC_LABEL_MISSING', sheet);
        return {
          schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
          extractor: { id: NATIVE_FINANCIAL_FACT_EXTRACTOR_ID, version: NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION },
          parse_snapshot: { snapshot_id: request.parse_snapshot_id, response_sha256: request.parse_response_sha256,
            parser_version: request.parser_version, material_id: request.material_id, material_version: request.material_version,
            content_sha256: request.material_sha256 },
          facts, needs_review: needsReview,
        };
      }
      if (metricLabels.length !== 1) return reviewResult(request, metricLabels.length ? 'FINANCIAL_METRIC_LABEL_DUPLICATE' : 'FINANCIAL_METRIC_LABEL_MISSING', sheet);
      if ((!currentInterimLayout && (!periodNotes[0]!.literal_quote.includes('2023年度') || scopeCells[0]!.literal_quote !== '口径：合并口径')) ||
          unitCells[0]!.literal_quote !== '金额单位：人民币元') {
        return reviewResult(request, 'FINANCIAL_PERIOD_SCOPE_OR_UNIT_UNSUPPORTED', [periodNotes[0]!, scopeCells[0]!, unitCells[0]!]);
      }

      const valueCell = `${columnOf(yearHeaders[0]!.locator.cell)}${rowOf(metricLabels[0]!.locator.cell)}`;
      const values = sheet.filter((record) => record.locator.cell === valueCell);
      const numericValue = values[0]?.literal_quote.trim();
      const period = currentInterimLayout ? parseInterimPeriod(periodNotes[0]!.literal_quote) : LEGACY_TARGET_PERIOD;
      if (!period) return reviewResult(request, 'FINANCIAL_PERIOD_UNSUPPORTED', [periodNotes[0]!]);
      if (values.length === 1 && values[0]!.uncertainty.length > 0) {
        return reviewResult(request, 'PARSER_EVIDENCE_NEEDS_CONFIRMATION', [metricLabels[0]!, yearHeaders[0]!, values[0]!]);
      }
      if (values.length !== 1 || numericValue === undefined || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(numericValue)) {
        return reviewResult(request, values.length > 1 ? 'FINANCIAL_VALUE_DUPLICATE' : 'FINANCIAL_VALUE_MISSING_OR_INVALID',
          [metricLabels[0]!, yearHeaders[0]!, ...values]);
      }
      const referencedUncertain = [sheetTitle[0]!, scopeCells[0]!, periodNotes[0]!, unitCells[0]!, yearHeaders[0]!, metricLabels[0]!, values[0]!]
        .filter((record) => record.uncertainty.length > 0);
      if (referencedUncertain.length > 0) return reviewResult(request, 'PARSER_EVIDENCE_NEEDS_CONFIRMATION', referencedUncertain);

      const evidence = [...new Map([sheetTitle[0]!, scopeCells[0]!, periodNotes[0]!, unitCells[0]!, yearHeaders[0]!,
        metricLabels[0]!, values[0]!].map((record) => [record.record_id, record])).values()];
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
          scope: 'consolidated', metric: TARGET_METRIC, period,
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
