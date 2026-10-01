import type { CheckEvidence, SsePrivateFinding } from './sse-private-checks.js';

type Opinion = 'unmodified' | 'emphasis_unmodified' | 'qualified' | 'adverse' | 'disclaimer';
const statements = ['parent:balance', 'parent:income', 'parent:cashflow',
  'consolidated:balance', 'consolidated:income', 'consolidated:cashflow'] as const;
type Statement = typeof statements[number];

/** Internal reviewed evidence only. Each report/statement/item invocation is scoped;
 * the adapter must enumerate every required period and row, never infer completeness. */
export interface FinancialCheckInput {
  reportingWindow?: {
    targetCutoff: CheckEvidence<string>;
    calendarYearBasis: CheckEvidence<boolean>;
    exceptionClaimed: CheckEvidence<boolean>;
    disclosedAnnualEnds: CheckEvidence<readonly string[]>;
    disclosedInterimEnds: CheckEvidence<readonly string[]>;
  };
  auditOpinion?: {
    periodEnd: CheckEvidence<string>;
    periodKind: CheckEvidence<'annual' | 'interim'>;
    audited: CheckEvidence<boolean>;
    opinion?: CheckEvidence<Opinion>;
    issuerExplanation?: CheckEvidence<boolean>;
    accountantSupplement?: CheckEvidence<boolean>;
    debtImpactAnalysis?: CheckEvidence<boolean>;
    qualifiedImpactReview?: CheckEvidence<boolean>;
  };
  financialStatements?: {
    periodEnd: CheckEvidence<string>;
    consolidatedPrepared: CheckEvidence<boolean>;
    disclosedStatements: CheckEvidence<readonly Statement[]>;
    restatementPresent: CheckEvidence<boolean>;
    originalAndRestatedSeparated?: CheckEvidence<boolean>;
    restatementBasisDisclosed?: CheckEvidence<boolean>;
    materialConsolidationChange: CheckEvidence<boolean>;
    newSubsidiariesOnly?: CheckEvidence<boolean>;
    consolidationChangeDetails?: CheckEvidence<boolean>;
  };
  mdnaItem?: {
    itemLabel: CheckEvidence<string>;
    periodEnd: CheckEvidence<string>;
    previousPeriodEnd: CheckEvidence<string>;
    kind: CheckEvidence<'asset' | 'liability' | 'other'>;
    /** Canonical decimal amounts, same currency/unit/entity/basis; no floating point. */
    currentAmount: CheckEvidence<string>;
    previousAmount: CheckEvidence<string>;
    categoryTotal?: CheckEvidence<string>;
    comparable: CheckEvidence<boolean>;
    materialRisk: CheckEvidence<boolean>;
    movementDisclosed?: CheckEvidence<boolean>;
    causeSupported?: CheckEvidence<boolean>;
  };
}
interface Context {
  add(code: string, outcome: SsePrivateFinding['outcome'], message: string, ...evidence: (CheckEvidence<unknown> | undefined)[]): void;
  read<T>(key: string, item: CheckEvidence<T> | undefined, valid: (value: unknown) => value is T): T | undefined;
  bool(key: string, item: CheckEvidence<boolean> | undefined): boolean | undefined;
  day(key: string, item: CheckEvidence<string> | undefined): string | undefined;
  expect(key: string, item: CheckEvidence<boolean> | undefined, expected: boolean, message: string): void;
}
const enumOf = <T extends string>(values: readonly T[]) => (value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const uniqueDates = (value: unknown): value is readonly string[] => Array.isArray(value)
  && value.every(validDate) && new Set(value).size === value.length;
const decimal = (value: unknown): value is string => typeof value === 'string'
  && /^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,12})?$/.test(value);
function scaled(value: string): bigint {
  const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
  return BigInt(`${integer}${fraction.padEnd(12, '0')}`) * (value.startsWith('-') ? -1n : 1n);
}
const abs = (value: bigint) => value < 0n ? -value : value;

export function evaluateFinancialCheck(ruleId: string, input: FinancialCheckInput, asOf: string, ctx: Context): void {
  const { add, read, bool, day, expect } = ctx;
  if (ruleId === 'sse-private-period-window') {
    const data = input.reportingWindow;
    const cutoff = day('target_financial_cutoff', data?.targetCutoff);
    const calendar = bool('calendar_year_basis', data?.calendarYearBasis);
    const exception = bool('reporting_window_exception', data?.exceptionClaimed);
    if (!cutoff) return;
    if (cutoff > asOf) { add('future_target_cutoff', 'issue', '目标财务期间尚未结束。', data?.targetCutoff); return; }
    if (calendar !== true || exception !== false) {
      add('reporting_window_judgement', 'needs_judgement', '非自然年度、成立不足两年、豁免或其他特殊窗口须按证据核对，不能自动套用普通两年及一期。', data?.calendarYearBasis, data?.exceptionClaimed); return;
    }
    const annual = read('disclosed_annual_ends', data?.disclosedAnnualEnds, uniqueDates);
    const interim = read('disclosed_interim_ends', data?.disclosedInterimEnds, uniqueDates);
    const yearEnd = cutoff.endsWith('-12-31');
    const lastYear = Number(cutoff.slice(0, 4)) - (yearEnd ? 0 : 1);
    const required = [`${lastYear - 1}-12-31`, `${lastYear}-12-31`];
    if (annual) add('annual_window', required.every(end => annual.includes(end)) ? 'pass' : 'issue',
      `普通私募财务窗口应包含${required.join('、')}；不自动追加第三年度。`, data?.targetCutoff, data?.disclosedAnnualEnds);
    if (!yearEnd && interim) add('interim_window', interim.includes(cutoff) ? 'pass' : 'issue',
      `最近一期应包含${cutoff}。`, data?.targetCutoff, data?.disclosedInterimEnds);
    if (yearEnd) add('year_end_window', 'needs_judgement', '年末两年目标无需机械添加重复一期；是否有更新一期、文件有效期及申报材料完整性仍须独立审核。', data?.targetCutoff);
    add('independent_lookback', 'needs_judgement', '两年财务窗口不缩短业务模式、重大重组等独立回溯要求，也不证明财务材料可用于当期申报。');
  } else if (ruleId === 'sse-private-audit-opinion') {
    const data = input.auditOpinion;
    const end = day('audit_period_end', data?.periodEnd);
    const kind = read('audit_period_kind', data?.periodKind, enumOf(['annual', 'interim'] as const));
    const audited = bool('report_audited', data?.audited);
    if (!end || !kind || audited === undefined) return;
    if (end > asOf) { add('future_audit_period', 'issue', '尚未结束的期间不能标记已有审计报告。', data?.periodEnd); return; }
    if (!audited) {
      add('unaudited_report', kind === 'annual' ? 'issue' : 'not_applicable',
        kind === 'annual' ? '普通年度材料需要审计报告，未审计不能写成已审计。' : '中期可为未审计报表，须如实标注，不能生成审计意见。', data?.audited, data?.periodKind); return;
    }
    const opinion = read('audit_opinion_type', data?.opinion, enumOf(['unmodified', 'emphasis_unmodified', 'qualified', 'adverse', 'disclaimer'] as const));
    if (!opinion) return;
    if (opinion === 'unmodified') { add('unmodified_opinion', 'pass', '本份报告为标准无保留意见；不证明其他报告年度或全文披露已完整。', data?.opinion, data?.periodEnd); return; }
    if (opinion === 'adverse' || opinion === 'disclaimer') {
      add('other_nonstandard_opinion', 'needs_judgement', '否定或无法表示意见不能按普通带强调事项/保留意见流程自动放行，须单独专业审核。', data?.opinion); return;
    }
    expect('issuer_audit_explanation', data?.issuerExplanation, true, '需披露董事会或有权机构的相关事项处理说明。');
    expect('accountant_audit_supplement', data?.accountantSupplement, true, '需会计师事务所及注册会计师的相关补充意见。');
    expect('audit_debt_impact', data?.debtImpactAnalysis, true, '需分析审计相关事项对偿债能力的影响。');
    if (opinion === 'qualified') expect('qualified_impact_review', data?.qualifiedImpactReview, true, '申报会计师须核查保留事项及其影响是否已经消除，并发表意见；无需强行写为已消除。');
  } else if (ruleId === 'sse-private-financial-statements') {
    const data = input.financialStatements;
    const end = day('statement_period_end', data?.periodEnd);
    if (!end) return;
    if (end > asOf) { add('future_statement_period', 'issue', '报表期间尚未结束。', data?.periodEnd); return; }
    const consolidated = bool('consolidated_prepared', data?.consolidatedPrepared);
    const disclosed = read('disclosed_statements', data?.disclosedStatements, (value): value is readonly Statement[] =>
      Array.isArray(value) && value.every(enumOf(statements)) && new Set(value).size === value.length);
    if (consolidated !== undefined && disclosed) {
      const missing = statements.filter(name => (consolidated || name.startsWith('parent:')) && !disclosed.includes(name));
      add('statement_inventory', missing.length ? 'issue' : 'pass', missing.length
        ? `本期缺少报表：${missing.join('、')}。` : '本期所需合并/母公司报表种类齐备；不表示金额、附注或其他期间已核验。',
      data?.periodEnd, data?.consolidatedPrepared, data?.disclosedStatements);
    }
    const restated = bool('restatement_present', data?.restatementPresent);
    if (restated) {
      expect('restatement_separation', data?.originalAndRestatedSeparated, true, '内部证据方法：原数和重述数须分开保留，不为勾平而覆盖源数。');
      expect('restatement_basis', data?.restatementBasisDisclosed, true, '需披露重述依据并定位相关材料，不能把备考数冒充实际数。');
    }
    const changed = bool('material_consolidation_change', data?.materialConsolidationChange);
    if (changed) {
      const onlyNew = bool('new_subsidiaries_only', data?.newSubsidiariesOnly);
      if (onlyNew === false) expect('consolidation_change_details', data?.consolidationChangeDetails, true, '除新设子公司外的重大合并范围变化应披露具体变化、原因及影响。');
      if (onlyNew === true) add('new_subsidiary_exception', 'not_applicable', '3.7.1（四）本项除外情形，不豁免一般合并范围及重大事项披露。', data?.newSubsidiariesOnly);
    }
    add('statement_check_scope', 'needs_judgement', '本检查按一期盘点表种及指定说明；会计政策/估计变更、重组备考、勾稽与全文金额仍需专项核对。');
  } else if (ruleId === 'sse-private-mdna-thresholds') {
    const data = input.mdnaItem;
    const end = day('mdna_period_end', data?.periodEnd);
    const previousEnd = day('mdna_previous_period_end', data?.previousPeriodEnd);
    const label = read('mdna_item_label', data?.itemLabel, (value): value is string => typeof value === 'string' && value.trim().length > 0);
    const kind = read('mdna_item_kind', data?.kind, enumOf(['asset', 'liability', 'other'] as const));
    const comparable = bool('mdna_comparable', data?.comparable);
    const risk = bool('mdna_material_risk', data?.materialRisk);
    let triggered = risk === true, unresolved = risk === undefined;
    if (!label || !kind || !end || !previousEnd) return;
    if (end > asOf || previousEnd >= end) {
      add('mdna_period_order', 'issue', '本期不得晚于适用日，比较期须早于本期；同比口径还须独立确认。', data?.periodEnd, data?.previousPeriodEnd); return;
    }
    if (comparable !== true) {
      add('mdna_basis_judgement', 'needs_judgement', '主体、期间、单位、重述等口径尚未确认可比，不机械计算变动率。', data?.comparable);
      unresolved = true;
    } else {
      const current = read('mdna_current', data?.currentAmount, decimal);
      const previous = read('mdna_previous', data?.previousAmount, decimal);
      if (current === undefined || previous === undefined) unresolved = true;
      if (kind !== 'other') {
        const total = read('mdna_category_total', data?.categoryTotal, decimal);
        if (current !== undefined && total !== undefined) {
          if (scaled(total) <= 0n || scaled(current) < 0n || scaled(current) > scaled(total)) {
            add('mdna_share_judgement', 'needs_judgement', '总资产/总负债非正、项目为负或超过总额时先核对口径，不机械计算占比。', data?.currentAmount, data?.categoryTotal); unresolved = true;
          } else {
            const share = scaled(current) * 10n >= scaled(total);
            triggered ||= share;
            add('mdna_share_trigger', 'pass', share ? '本项目占比达到10%（含），需变动及原因分析。' : '本项目占比低于10%，仍须检查变动和重大风险。', data?.currentAmount, data?.categoryTotal, data?.kind);
          }
        } else unresolved = true;
      }
      if (current !== undefined && previous !== undefined) {
        if (scaled(previous) <= 0n) {
          add('mdna_change_judgement', 'needs_judgement', '前期为零或负数时不套用普通变动率，须判断变化的重要性。', data?.currentAmount, data?.previousAmount); unresolved = true;
        } else {
          const change = abs(scaled(current) - scaled(previous)) * 10n >= scaled(previous) * 3n;
          triggered ||= change;
          add('mdna_change_trigger', 'pass', change ? '本项目增减幅度达到30%（含），需变动及原因分析。' : '本项目变动幅度低于30%，仍须检查占比和重大风险。', data?.currentAmount, data?.previousAmount);
        }
      }
    }
    if (triggered) {
      expect('mdna_movement_disclosed', data?.movementDisclosed, true, '达到阈值或存在重大风险的项目需披露变动情况。');
      expect('mdna_cause_supported', data?.causeSupported, true, '变动原因需有证据；仅计算差额、模型推测不构成业务原因。');
    } else if (!unresolved) add('mdna_below_threshold', 'pass', '本项目未触发本次阈值/已审核重大风险条件；不表示其他项目及评估资产说明已完整。', data?.itemLabel, data?.materialRisk, data?.comparable, data?.currentAmount, data?.previousAmount, data?.categoryTotal);
    add('mdna_check_scope', 'needs_judgement', '逐项检查不能证明已穷尽近一年及近一期项目；评估价值变动及合理性补充说明另行审核。');
  } else {
    throw new Error(`SSE_PRIVATE_FINANCIAL_CHECK_UNSUPPORTED:${ruleId}`);
  }
}
