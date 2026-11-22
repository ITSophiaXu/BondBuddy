import type {
  SemanticFactExtractionRequest,
  SemanticFactExtractionResult,
  SemanticFactExtractor,
} from './fact-candidate-producer.js';
import { SEMANTIC_FACT_EXTRACTION_RESULT_VERSION } from './semantic-fact-extraction-constants.js';
import type { NativeFinancialParseCompletionResolver } from './native-financial-fact-extractor.js';
import {
  RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_ID,
  RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_VERSION,
  RQ_Q3_FORMULA_SOURCE_SHA256,
} from './rq-q3-formula-candidate-constants.js';

export {
  RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_ID,
  RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_VERSION,
  RQ_Q3_FORMULA_SOURCE_SHA256,
} from './rq-q3-formula-candidate-constants.js';

type Evidence = SemanticFactExtractionRequest['records'][number] & {
  locator: { sheet: string; cell: string };
};

interface Target {
  readonly sheet: string;
  readonly scope: 'consolidated' | 'parent_only';
  readonly metric: string;
  readonly valueCell: string;
  readonly labelCell: string;
  readonly label: RegExp;
  readonly headerCell: string;
  readonly headerText: string;
  readonly periodCell: string;
  readonly unitCell: string;
  readonly titleContains: string;
  readonly titleKind: string;
  readonly periodKind: 'balance' | 'duration';
}

const targets: readonly Target[] = [
  {
    sheet: '01合并资产负债表',
    scope: 'consolidated',
    metric: 'total_assets',
    valueCell: 'D78',
    labelCell: 'A78',
    label: /资产总计/,
    headerCell: 'D4',
    headerText: '期末余额',
    periodCell: 'B3',
    unitCell: 'E3',
    titleContains: '合并',
    titleKind: '资产负债表',
    periodKind: 'balance',
  },
  {
    sheet: '01母公司资产负债',
    scope: 'parent_only',
    metric: 'total_assets',
    valueCell: 'D78',
    labelCell: 'A78',
    label: /资产总计/,
    headerCell: 'D4',
    headerText: '期末余额',
    periodCell: 'B3',
    unitCell: 'F3',
    titleContains: '母公司',
    titleKind: '资产负债表',
    periodKind: 'balance',
  },
  {
    sheet: '02合并利润表',
    scope: 'consolidated',
    metric: 'operating_revenue',
    valueCell: 'D6',
    labelCell: 'A6',
    label: /其中营业收入/,
    headerCell: 'D4',
    headerText: '2025年1-9月',
    periodCell: 'B3',
    unitCell: 'E3',
    titleContains: '合并',
    titleKind: '利润表',
    periodKind: 'duration',
  },
  {
    sheet: '02母公司利润表',
    scope: 'parent_only',
    metric: 'operating_revenue',
    valueCell: 'D6',
    labelCell: 'A6',
    label: /其中营业收入/,
    headerCell: 'D4',
    headerText: '本期金额',
    periodCell: 'B3',
    unitCell: 'E3',
    titleContains: '母公司',
    titleKind: '利润表',
    periodKind: 'duration',
  },
  {
    sheet: '02合并利润表',
    scope: 'consolidated',
    metric: 'net_profit',
    valueCell: 'D44',
    labelCell: 'A44',
    label: /净利润/,
    headerCell: 'D4',
    headerText: '2025年1-9月',
    periodCell: 'B3',
    unitCell: 'E3',
    titleContains: '合并',
    titleKind: '利润表',
    periodKind: 'duration',
  },
  {
    sheet: '02母公司利润表',
    scope: 'parent_only',
    metric: 'net_profit',
    valueCell: 'D44',
    labelCell: 'A44',
    label: /净利润/,
    headerCell: 'D4',
    headerText: '本期金额',
    periodCell: 'B3',
    unitCell: 'E3',
    titleContains: '母公司',
    titleKind: '利润表',
    periodKind: 'duration',
  },
  {
    sheet: '03合并现金流量表',
    scope: 'consolidated',
    metric: 'net_cash_from_operating_activities',
    valueCell: 'C32',
    labelCell: 'A32',
    label: /经营活动产生的现金流量净额/,
    headerCell: 'C4',
    headerText: '2025年1-9月',
    periodCell: 'B3',
    unitCell: 'D3',
    titleContains: '合并',
    titleKind: '现金流量表',
    periodKind: 'duration',
  },
  {
    sheet: '03母公司现金流量表',
    scope: 'parent_only',
    metric: 'net_cash_from_operating_activities',
    valueCell: 'C32',
    labelCell: 'A32',
    label: /经营活动产生的现金流量净额/,
    headerCell: 'C4',
    headerText: '本期金额',
    periodCell: 'B3',
    unitCell: 'D3',
    titleContains: '母公司',
    titleKind: '现金流量表',
    periodKind: 'duration',
  },
];

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'RqQ3FormulaCandidateExtractorError';
  return error;
}

function isCell(record: SemanticFactExtractionRequest['records'][number]): record is Evidence {
  return (
    record.locator_type === 'xlsx_cell' &&
    typeof record.locator.sheet === 'string' &&
    typeof record.locator.cell === 'string' &&
    /^[A-Z]{1,3}[1-9][0-9]*$/.test(record.locator.cell)
  );
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function periodValue(record: Evidence): string {
  const cached = record.formatting.cached_formula_result;
  return record.literal_quote.startsWith('=') && typeof cached === 'string'
    ? cached.trim()
    : record.literal_quote.trim();
}

function normalizedLabel(value: string): string {
  return value.replace(/[\s　:：]/g, '');
}

function periodFor(target: Target, value: string): { start: string; end: string } | null {
  if (target.periodKind === 'balance') {
    const match = /^2025年0?9月30日$/.exec(value);
    return match ? { start: '2025-09-30', end: '2025-09-30' } : null;
  }
  return /^2025年1-9月$/.test(value) ? { start: '2025-01-01', end: '2025-09-30' } : null;
}

function resultBase(request: SemanticFactExtractionRequest) {
  return {
    schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
    extractor: {
      id: RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_ID,
      version: RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_VERSION,
    },
    parse_snapshot: {
      snapshot_id: request.parse_snapshot_id,
      response_sha256: request.parse_response_sha256,
      parser_version: request.parser_version,
      material_id: request.material_id,
      material_version: request.material_version,
      content_sha256: request.material_sha256,
    },
  } as const;
}

/**
 * Maps only the eight named current-period formula-cache cells in the authorized rq Q3 workbook.
 * Cached numbers are retained as external candidates with mandatory uncertainty; this extractor
 * does not calculate formulas, assert source freshness, or produce audited/verified facts.
 * A formula with a cached-but-unverified numeric result stays an external `needs_confirmation`
 * candidate, while a formula whose cache is genuinely absent, a conflicting statement caliber, or
 * a changed parser version fails closed as `needs_review` with a distinct reason code.
 */
export function createRqQ3FormulaCandidateExtractor(
  resolveParseCompletion: NativeFinancialParseCompletionResolver,
): SemanticFactExtractor {
  return {
    id: RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_ID,
    version: RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_VERSION,
    async extract(request) {
      const completion = await resolveParseCompletion(request);
      const cells = request.records.filter(isCell);
      if (
        request.material_sha256 !== RQ_Q3_FORMULA_SOURCE_SHA256 ||
        cells.length !== request.records.length ||
        ![
          'bondbuddy-document-parser-1.0.6',
          'bondbuddy-document-parser-1.0.7',
          'bondbuddy-document-parser-1.0.8',
        ].includes(request.parser_version)
      ) {
        return {
          ...resultBase(request),
          facts: [],
          needs_review: [
            {
              evidence_refs: request.records.slice(0, 32).map((record) => record.record_id),
              reason_code: 'RQ_Q3_FORMULA_SOURCE_OR_PARSER_UNSUPPORTED',
            },
          ],
        };
      }
      const toleratedWarnings =
        completion.status === 'needs_confirmation' &&
        completion.warnings.length > 0 &&
        completion.warnings.every((warning) =>
          ['XLSX_HIDDEN_SHEET', 'XLSX_FORMULA_CACHE_UNVERIFIED'].includes(warning.code),
        );
      if (
        !(completion.status === 'parsed' && completion.warnings.length === 0) &&
        !toleratedWarnings
      ) {
        const refs = cells
          .filter((record) =>
            targets.some(
              (target) =>
                target.sheet === record.locator.sheet &&
                [
                  target.valueCell,
                  target.labelCell,
                  target.periodCell,
                  target.headerCell,
                  target.unitCell,
                  'A1',
                ].includes(record.locator.cell),
            ),
          )
          .map((record) => record.record_id)
          .slice(0, 32);
        return {
          ...resultBase(request),
          facts: [],
          needs_review: [
            {
              evidence_refs: refs,
              reason_code: 'RQ_Q3_PARSE_STATUS_OR_WARNING_NEEDS_CONFIRMATION',
            },
          ],
        };
      }

      const facts: SemanticFactExtractionResult['facts'][number][] = [];
      const needsReview: SemanticFactExtractionResult['needs_review'][number][] = [];
      for (const target of targets) {
        const inSheet = cells.filter(
          (record) =>
            record.locator.sheet === target.sheet &&
            record.formatting.sheet_state !== 'hidden' &&
            record.formatting.sheet_state !== 'veryHidden',
        );
        const one = (cell: string): Evidence[] =>
          inSheet.filter((record) => record.locator.cell === cell);
        const value = one(target.valueCell);
        const label = one(target.labelCell);
        const periodAnchor = one(target.periodCell);
        const header = one(target.headerCell);
        const title = one('A1');
        const units = one(target.unitCell);
        const support = [...title, ...periodAnchor, ...header, ...units, ...label, ...value];
        const cache = value[0]?.formatting.cached_formula_result;
        const period =
          periodAnchor.length === 1 ? periodFor(target, periodValue(periodAnchor[0]!)) : null;
        const titleText = title.length === 1 ? normalizedLabel(title[0]!.literal_quote) : '';
        const titleMatches =
          titleText.includes(target.titleContains) && titleText.includes(target.titleKind);
        // A statement title that names both consolidated and parent scopes, or the opposite scope only,
        // is a caliber conflict rather than a candidate: never guess which column the cell belongs to.
        const oppositeScope = target.scope === 'consolidated' ? '母公司' : '合并';
        const scopeConflict =
          title.length === 1 &&
          ((titleText.includes('合并') && titleText.includes('母公司')) ||
            (!titleMatches && titleText.includes(oppositeScope)));
        const valueIsFormula = value.length === 1 && value[0]!.literal_quote.startsWith('=');
        const valueHasUnverifiedCache =
          valueIsFormula &&
          decimal(cache) &&
          value[0]!.uncertainty.includes('formula_cached_result_unverified');
        const complete =
          title.length === 1 &&
          titleMatches &&
          !scopeConflict &&
          periodAnchor.length === 1 &&
          period !== null &&
          header.length === 1 &&
          header[0]!.literal_quote.trim() === target.headerText &&
          units.length === 1 &&
          units[0]!.literal_quote.trim() === '金额单位：人民币元' &&
          label.length === 1 &&
          target.label.test(normalizedLabel(label[0]!.literal_quote)) &&
          valueHasUnverifiedCache &&
          value[0]!.uncertainty.length > 0;
        if (!complete) {
          const refs = [...new Set(support.map((record) => record.record_id))];
          if (!refs.length) throw fail('RQ_Q3_TARGET_EVIDENCE_MISSING');
          const reasonCode =
            title.length !== 1
              ? 'RQ_Q3_SCOPE_HEADER_MISSING'
              : scopeConflict
                ? 'RQ_Q3_SCOPE_CONFLICT'
                : !titleMatches
                  ? 'RQ_Q3_SCOPE_HEADER_MISSING'
                  : periodAnchor.length !== 1 || period === null
                    ? 'RQ_Q3_PERIOD_HEADER_UNRESOLVED'
                    : header.length !== 1 || header[0]!.literal_quote.trim() !== target.headerText
                      ? 'RQ_Q3_CURRENT_COLUMN_HEADER_UNRESOLVED'
                      : units.length !== 1 ||
                          units[0]!.literal_quote.trim() !== '金额单位：人民币元'
                        ? 'RQ_Q3_UNIT_HEADER_UNRESOLVED'
                        : label.length !== 1 ||
                            !target.label.test(normalizedLabel(label[0]!.literal_quote))
                          ? 'RQ_Q3_METRIC_LABEL_UNRESOLVED'
                          : // Distinguish a formula cell whose cache is genuinely absent (or non-numeric) from a
                            // cached value whose surrounding anchors are incomplete. Neither ever becomes a fact.
                            valueIsFormula && !decimal(cache)
                            ? 'RQ_Q3_FORMULA_CACHE_MISSING'
                            : 'RQ_Q3_FORMULA_CACHE_ANCHOR_INCOMPLETE';
          needsReview.push({ evidence_refs: refs, reason_code: reasonCode });
          continue;
        }
        const formulaRecord = value[0]!;
        const evidence = [...new Set(support.map((record) => record.record_id))];
        facts.push({
          extraction_id: `rq-q3-${target.scope}-${target.metric}-${target.valueCell}`,
          identity: {
            scope: target.scope,
            metric: target.metric,
            period: period!,
            currency: 'CNY',
            unit: 'yuan',
            basis: 'reported_financial_statement',
          },
          value: { kind: 'known', decimalOrText: cache as string },
          source_kind: 'external',
          confidence: 0.5,
          uncertainty: [
            'FORMULA_CACHE_VALUE_UNVERIFIED',
            'FORMULA_SOURCE_CHAIN_UNVERIFIED',
            ...(target.scope === 'parent_only' && periodAnchor[0]!.literal_quote.startsWith('=')
              ? ['PERIOD_HEADER_FORMULA_CACHE_UNVERIFIED']
              : []),
            ...(target.metric === 'operating_revenue'
              ? ['REVENUE_EXTERNAL_WORKBOOK_NOT_AUTHORIZED']
              : []),
          ],
          evidence_refs: evidence,
        });
        // Keep the exact formula text as a sanity invariant: it is stored on the value-cell evidence anchor.
        if (formulaRecord.literal_quote.length < 2) throw fail('RQ_Q3_FORMULA_TEXT_MISSING');
      }
      return { ...resultBase(request), facts, needs_review: needsReview };
    },
  };
}
