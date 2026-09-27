import type { CheckEvidence } from './sse-private-checks.js';
import { compareText, date, decimal, enumOf, nonempty, nonnegative, places, sameBasis, stringSet,
  type CheckContext, type TextComparison } from './sse-private-check-context.js';
import * as a from './update-arithmetic.js';

export const ADDITIONAL_CHECKED_RULES = [
  'source-authority', 'evidence-state', 'identity', 'current-terms', 'funds-simulation',
  'business-revenue', 'indicators', 'cause-evidence', 'debt-liquidity', 'rating-enhancement',
  'protection', 'risk-disclosure', 'document-delivery', 'trustee-continuing-duties',
] as const;
type E<T> = CheckEvidence<T>;
interface FactBinding { entityId: string; scope: 'parent' | 'consolidated'; currency: string; unit: string; periodStart: string; periodEnd: string }
/** All observations are scoped, reviewed inputs. These are not public DTOs or approvals. */
export interface AdditionalCheckInput {
  sourceSelection?: {
    selected: E<string>; completeCandidateInventory: E<boolean>;
    candidates: readonly { value: E<string>; applicable: E<boolean> }[];
    resolution?: { selected: E<string>; rationale: E<string> };
  };
  evidenceUse?: { original: E<string>; publishedAsConfirmed: E<boolean>; markedForConfirmation: E<boolean> };
  identityComparison?: { expected: E<FactBinding>; actual: E<FactBinding> };
  currentTerm?: { value: TextComparison; trancheId: E<string>; approvalRoute: E<'private_listing' | 'public_registration'> };
  fundsSimulation?: {
    included: E<boolean>; simpleCashDebtOnly?: E<boolean>; comparable?: E<boolean>; assumptions?: E<string>;
    feeTreatment?: E<'expense' | 'deduct_debt'>;
    openingAssets?: E<string>; openingLiabilities?: E<string>; openingEquity?: E<string>;
    grossProceeds?: E<string>; expenses?: E<string>; debtRepayment?: E<string>;
    closingAssets?: E<string>; closingLiabilities?: E<string>; closingEquity?: E<string>;
  };
  previousProceeds?: { repeatApplication: E<boolean>; total?: E<string>; used?: E<string>; balance?: E<string>;
    comparable?: E<boolean>; unrectifiedUnauthorizedUse?: E<boolean>; disclosureComplete?: E<boolean> };
  businessSegment?: { comparable: E<boolean>; revenue: E<string>; cost: E<string>; grossProfit: E<string>;
    totalRevenue: E<string>; totalGrossProfit: E<string>; grossMarginPercent: E<string>; marginPlaces: E<number>;
    operationsDisclosed: E<boolean>; materialRisk: E<boolean> };
  indicator?: { definition: E<string>; comparable: E<boolean>; numerator: E<string>; denominator: E<string>;
    disclosed: E<string>; scale: E<'ratio' | 'percent'>; decimalPlaces: E<number> };
  causeStatement?: { cause: E<string>; supportKind: E<'business_evidence' | 'calculation_only' | 'model_guess'>;
    support?: E<string>; causalLinkReviewed?: E<boolean>; markedForConfirmation: E<boolean> };
  debtReconciliation?: { comparable: E<boolean>; completeInventory: E<boolean>; total: E<string>; statementTotal: E<string>;
    adjustments: readonly E<string>[]; maturityBuckets: readonly E<string>[]; differenceExplanation?: E<string> };
  creditFacility?: { comparable: E<boolean>; simpleAvailableEqualsTotalMinusUsed: E<boolean>;
    total: E<string>; used: E<string>; available: E<string> };
  ratingEnhancement?: { rated: E<boolean>; rating?: TextComparison; currentReport?: E<string>;
    enhanced: E<boolean>; guarantee?: TextComparison; currentContract?: E<string> };
  protectionTerms?: { trusteeAgreementPresent: E<boolean>; meetingRulesPresent: E<boolean>; term: TextComparison;
    referenceExampleAdded: E<boolean>; actualAgreement?: E<string> };
  riskUpdate?: { fact: TextComparison; historicalRiskRemoved: E<boolean>; removalBasis?: E<string> };
  delivery?: { artifactHash: E<string>; requiredSections: E<readonly string[]>; deliveredSections: E<readonly string[]>;
    exemptSections: E<readonly string[]>; exemptionBasis?: E<string>; hasHistory: E<boolean>; contentChanged: E<boolean>;
    revisionCount: E<number>; commentsNeeded: E<boolean>; commentCount: E<number>; wpsOpenedAndReopened: E<boolean> };
  trusteeStatement?: { duty: TextComparison; statementKind: E<'arrangement' | 'performed'>;
    supportKind: E<'agreement' | 'performance_record' | 'guideline_example'>; actualSupport: E<string> };
}
const binding = (v: unknown): v is FactBinding => {
  if (!v || typeof v !== 'object') return false;
  const row = v as FactBinding;
  return nonempty(row.entityId) && ['parent', 'consolidated'].includes(row.scope) && nonempty(row.currency)
    && nonempty(row.unit) && date(row.periodStart) && date(row.periodEnd) && row.periodStart <= row.periodEnd;
};
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function sumValues(ctx: CheckContext, key: string, rows: readonly E<string>[] | undefined, signed: boolean, allowEmpty = false): a.Rational | undefined {
  if (!Array.isArray(rows) || (!allowEmpty && !rows.length) || rows.length > 1000) {
    ctx.add(`${key}_inventory`, 'needs_evidence', '缺少分项或超出完整遍历范围；不能静默截断或把未知清单当空集合。'); return;
  }
  let sum = a.decimal('0'), valid = true;
  for (const [i, row] of rows.entries()) {
    const value = ctx.read(`${key}_${i}`, row, signed ? decimal : nonnegative);
    if (value === undefined) valid = false; else sum = a.add(sum, a.decimal(value));
  }
  return valid ? sum : undefined;
}

export function evaluateAdditionalCheck(ruleId: string, input: AdditionalCheckInput, ctx: CheckContext): void {
  const { add, read, bool, expect } = ctx;
  const key = ruleId.replace(/^sse-private-/, '');
  if (key === 'source-authority') {
    const d = input.sourceSelection;
    const selected = read('source_selected', d?.selected, nonempty);
    const complete = bool('source_inventory_complete', d?.completeCandidateInventory);
    if (!Array.isArray(d?.candidates) || !d.candidates.length || d.candidates.length > 1000) {
      add('source_candidates', 'needs_evidence', '需逐字段列举本期可比来源，不采用所有文件通用的优先排名。'); return;
    }
    const values: string[] = []; let pending = false;
    for (const [i, row] of d.candidates.entries()) {
      const applicable = bool(`source_${i}_applicable`, row.applicable);
      if (applicable === undefined) pending = true;
      if (applicable !== true) continue;
      const value = read(`source_${i}_value`, row.value, nonempty);
      if (value === undefined) pending = true; else values.push(value);
    }
    const refs = d.candidates.flatMap(row => [row.value, row.applicable]);
    if (complete !== true || pending || selected === undefined || !values.length) {
      add('source_selection_incomplete', 'needs_evidence', '来源未完整核对或无适用候选，不能以已选一个值消除冲突。', d.selected, d.completeCandidateInventory, ...refs); return;
    }
    if (!values.includes(selected)) { add('source_not_in_candidates', 'issue', '所选值不来自已核对的适用来源。', d.selected, ...refs); return; }
    if (new Set(values).size > 1) {
      const resolution = read('conflict_resolution_value', d.resolution?.selected, nonempty);
      const reason = read('conflict_resolution_reason', d.resolution?.rationale, nonempty);
      if (resolution !== undefined && reason !== undefined) add('source_conflict_resolution', resolution === selected ? 'pass' : 'issue',
        '仅核对本字段真实审核决定与采用值是否一致；保留其他冲突候选，不由算法宣告来源优劣。', d.selected, d.resolution?.selected, d.resolution?.rationale, ...refs);
    } else add('source_agreement', 'pass', '本次完整列举的可比来源值一致；仅限该字段。', d.selected, d.completeCandidateInventory, ...refs);
  } else if (key === 'evidence-state') {
    const d = input.evidenceUse;
    const published = bool('evidence_published_confirmed', d?.publishedAsConfirmed);
    const marked = bool('evidence_confirmation_marker', d?.markedForConfirmation);
    const value = read('original_fact', d?.original, nonempty);
    if (value === undefined) {
      if (published !== undefined && marked !== undefined) add('unverified_fact_use', !published && marked ? 'pass' : 'issue',
        '未核证/OCR存疑/用户陈述须带待确认标记且不能宣称已核验；局部缺口仍可继续工作稿。', d?.original, d?.publishedAsConfirmed, d?.markedForConfirmation);
    } else add('verified_fact_local', 'pass', '此值满足结构化证据前提，不据此确认其他事实。', d?.original);
  } else if (key === 'identity') {
    const d = input.identityComparison;
    const expected = read('identity_expected', d?.expected, binding), actual = read('identity_actual', d?.actual, binding);
    if (expected && actual) for (const field of ['entityId', 'scope', 'currency', 'unit', 'periodStart', 'periodEnd'] as const) {
      add(`identity_${field}`, expected[field] === actual[field] ? 'pass' : 'issue', `核对${field}，不以同名或近似期间替代已审核主体与口径。`, d?.expected, d?.actual);
    }
  } else if (key === 'current-terms') {
    const d = input.currentTerm;
    read('term_tranche', d?.trancheId, nonempty);
    compareText(ctx, 'current_term', d?.value);
    const route = read('term_approval_route', d?.approvalRoute, enumOf(['private_listing', 'public_registration']));
    if (route) add('private_approval_route', route === 'private_listing' ? 'pass' : 'issue', '本次私募挂牌条件确认不写成证监会公募注册。', d?.approvalRoute);
    add('terms_inventory', 'needs_judgement', '逐品种、字段及章节调用；本项差分不证明决议、批文、规模、机构和其他条款已穷尽。');
  } else if (key === 'funds-simulation') {
    const d = input.fundsSimulation;
    const included = bool('simulation_included', d?.included);
    if (included === false) add('simulation_absent', 'not_applicable', '稿内无发行后模拟表；本项不宣称模拟披露义务已豁免，仍核前次使用情况。', d?.included);
    if (included === true) {
      const simple = bool('simulation_simple_cash_debt', d?.simpleCashDebtOnly);
      const basis = sameBasis(ctx, 'simulation', d?.comparable);
      const assumptions = read('simulation_assumptions', d?.assumptions, nonempty);
      const feeTreatment = read('simulation_fee_treatment', d?.feeTreatment, enumOf(['expense','deduct_debt']));
      if (simple !== true) add('simulation_complex', 'needs_judgement', '本公式只支持到账、现金偿债及明确费用处理的简化模拟；投资、税项、后续摊销等另建经审核模型。', d?.simpleCashDebtOnly);
      if (simple === true && basis && assumptions && feeTreatment) {
        const fields = ['openingAssets', 'openingLiabilities', 'openingEquity', 'grossProceeds', 'expenses', 'debtRepayment', 'closingAssets', 'closingLiabilities', 'closingEquity'] as const;
        const values = fields.map(f => read(`simulation_${f}`, d?.[f], f.endsWith('Equity') ? decimal : nonnegative));
        if (values.every(v => v !== undefined)) {
          const [assets, liabilities, equity, gross, fees, repayment, outAssets, outLiabilities, outEquity] = values.map(v => a.decimal(v!)) as [a.Rational,a.Rational,a.Rational,a.Rational,a.Rational,a.Rational,a.Rational,a.Rational,a.Rational];
          const refs = fields.map(f => d?.[f]);
          add('simulation_opening_balance', a.equal(assets, a.add(liabilities, equity)) ? 'pass' : 'issue', '模拟期初资产=负债+权益，不能改源数勾平。', ...refs);
          const cashOut = a.add(fees, repayment);
          const validCash = a.subtract(gross, cashOut).numerator >= 0n && a.subtract(liabilities, repayment).numerator >= 0n;
          add('simulation_cash_boundary', validCash ? 'pass' : 'needs_judgement', '仅支持费用及偿债不超过募集总额、偿债不超过期初负债的简化情形。', ...refs);
          if (validCash) {
            add('simulation_assets', a.equal(outAssets, a.subtract(a.add(assets, gross), cashOut)) ? 'pass' : 'issue', '模拟资产=期初资产+募集总额−发行费用−现金偿债。', ...refs, d?.assumptions);
            const closingDebt = a.subtract(a.subtract(a.add(liabilities, gross), repayment), feeTreatment === 'deduct_debt' ? fees : a.decimal('0'));
            const closingCapital = a.subtract(equity, feeTreatment === 'expense' ? fees : a.decimal('0'));
            add('simulation_liabilities', a.equal(outLiabilities, closingDebt) ? 'pass' : 'issue', '模拟负债=期初负债+本次债务−现金偿债；若已核定费用抵减债务初始账面金额，再扣费用。', ...refs, d?.assumptions, d?.feeTreatment);
            add('simulation_equity', a.equal(outEquity, closingCapital) ? 'pass' : 'issue', '按已审核费用处理假设核对权益；不由检查器选择会计政策或生成税项影响。', ...refs, d?.assumptions, d?.feeTreatment);
          }
        }
      }
    }
    const p = input.previousProceeds;
    const repeat = bool('previous_repeat_application', p?.repeatApplication);
    if (repeat === false) add('previous_first_application', 'not_applicable', '已核实无前次发行，本次不检查前次使用明细。', p?.repeatApplication);
    if (repeat === true) {
      const basis = sameBasis(ctx, 'previous_proceeds', p?.comparable);
      const total = read('previous_total', p?.total, nonnegative), used = read('previous_used', p?.used, nonnegative), balance = read('previous_balance', p?.balance, nonnegative);
      if (basis && total !== undefined && used !== undefined && balance !== undefined) add('previous_balance', a.equal(a.decimal(total), a.add(a.decimal(used), a.decimal(balance))) ? 'pass' : 'issue', '前次总额=实际使用+余额；专户利息等差异须先说明并统一口径。', p?.total, p?.used, p?.balance, p?.comparable);
      expect('previous_unrectified_use', p?.unrectifiedUnauthorizedUse, false, '截至申报发行仍有擅自改变用途未整改情形，不得再次申报发行；不编造已整改。');
      expect('previous_disclosure', p?.disclosureComplete, true, '逐项披露总额、使用及余额、专户、约定/调整/实际用途、违规整改及签署日自查。');
    }
  } else if (key === 'business-revenue') {
    const d = input.businessSegment;
    if (!sameBasis(ctx, 'business', d?.comparable)) return;
    const names = ['revenue', 'cost', 'grossProfit', 'totalRevenue', 'totalGrossProfit', 'grossMarginPercent'] as const;
    const values = names.map(f => read(`business_${f}`, d?.[f], decimal));
    const precision = read('business_margin_places', d?.marginPlaces, places);
    const material = bool('business_material_risk', d?.materialRisk);
    if (values.some(v => v === undefined)) return;
    const [revenue,cost,profit,total,allProfit,margin] = values.map(v => a.decimal(v!)) as [a.Rational,a.Rational,a.Rational,a.Rational,a.Rational,a.Rational];
    const refs = names.map(f => d?.[f]);
    add('business_gross_profit', a.equal(a.subtract(revenue,cost),profit) ? 'pass' : 'issue', '本板块毛利润=收入−成本，不改变原数。', ...refs);
    if (revenue.numerator <= 0n || total.numerator <= 0n || allProfit.numerator <= 0n) {
      add('business_nonpositive_base', 'needs_judgement', '零负收入/毛利分母不机械比较占比或毛利率，须说明经营情况。', ...refs); return;
    }
    if (precision !== undefined) add('business_margin', a.equal(a.decimal(a.display(a.scale(a.divide(profit,revenue),100n),precision,false)),margin) ? 'pass' : 'issue', '毛利率按本期披露精度四舍五入，仅最终显示舍入。', ...refs, d?.marginPlaces);
    const significant = a.subtract(a.scale(revenue,10n),total).numerator >= 0n || a.subtract(a.scale(profit,10n),allProfit).numerator >= 0n;
    if (significant || material === true) expect('business_operations_disclosure', d?.operationsDisclosed, true, '收入或毛利润占比达到10%的一般主要板块及重大风险板块需披露经营情况；不只取前三个。');
    else add('business_below_threshold', 'needs_judgement', '低于一般10%线不自动豁免；完整板块、三年经营模式、项目建设和波动原因另核。', ...refs);
  } else if (key === 'indicators') {
    const d = input.indicator;
    const definition = read('indicator_definition', d?.definition, nonempty);
    if (!sameBasis(ctx, 'indicator', d?.comparable)) return;
    const numerator = read('indicator_numerator', d?.numerator, decimal), denominator = read('indicator_denominator', d?.denominator, decimal);
    const result = read('indicator_disclosed', d?.disclosed, decimal), scale = read('indicator_scale', d?.scale, enumOf(['ratio','percent']));
    const precision = read('indicator_places', d?.decimalPlaces, places);
    if (definition && numerator !== undefined && denominator !== undefined && result !== undefined && scale && precision !== undefined) {
      if (a.decimal(denominator).numerator <= 0n) { add('indicator_denominator_nonpositive', 'needs_judgement', '零或负分母保留解释，不生成无穷大或正常值。', d?.denominator); return; }
      const expected = a.display(a.scale(a.divide(a.decimal(numerator),a.decimal(denominator)),scale === 'percent' ? 100n : 1n),precision,false);
      add('indicator_value', a.equal(a.decimal(expected),a.decimal(result)) ? 'pass' : 'issue', '按已确认定义、分子/分母及精度核算；不把大公募专用指标清单强加私募。', d?.definition, d?.numerator, d?.denominator, d?.disclosed, d?.decimalPlaces, d?.scale);
    }
  } else if (key === 'cause-evidence') {
    const d = input.causeStatement;
    read('cause_text', d?.cause, nonempty);
    const kind = read('cause_support_kind', d?.supportKind, enumOf(['business_evidence','calculation_only','model_guess']));
    if (kind === 'business_evidence') {
      read('cause_support', d?.support, nonempty);
      expect('cause_link_reviewed', d?.causalLinkReviewed, true, '需核对业务材料与所写原因的联系；有材料不代表已证明因果。');
    } else if (kind) {
      const marked = bool('cause_marker', d?.markedForConfirmation);
      if (marked !== undefined) add('cause_unsubstantiated', marked ? 'needs_judgement' : 'issue', '计算差额或模型推测不是业务原因，只能作为待确认说明。', d?.cause, d?.supportKind, d?.markedForConfirmation);
    }
  } else if (key === 'debt-liquidity') {
    const d = input.debtReconciliation;
    const basis = sameBasis(ctx, 'debt', d?.comparable), complete = bool('debt_inventory_complete', d?.completeInventory);
    const total = read('debt_total', d?.total, nonnegative), statement = read('debt_statement', d?.statementTotal, nonnegative);
    const adjustments = sumValues(ctx,'debt_adjustments',d?.adjustments,true,true), buckets = sumValues(ctx,'debt_maturities',d?.maturityBuckets,false);
    if (complete !== true) add('debt_inventory_unconfirmed', 'needs_judgement', '需完整债务类型/期限集合与报表调整桥，不用部分清单认定全部有息债务。', d?.completeInventory);
    if (basis && complete === true && total !== undefined && statement !== undefined && adjustments && buckets) {
      add('debt_bridge', a.equal(a.decimal(total),a.add(a.decimal(statement),adjustments)) ? 'pass' : 'issue', '全口径有息债务=报表债务+已核对调整项。', d?.total,d?.statementTotal,...d!.adjustments);
      add('debt_maturity_sum', a.equal(a.decimal(total),buckets) ? 'pass' : 'issue', '无重叠的期限分项合计应与全口径债务一致。',d?.total,...d!.maturityBuckets);
      if (!a.equal(a.decimal(total),a.decimal(statement))) read('debt_difference_explanation',d?.differenceExplanation,nonempty);
    }
    const c = input.creditFacility;
    const cb = sameBasis(ctx,'credit',c?.comparable), simple = bool('credit_simple_arithmetic',c?.simpleAvailableEqualsTotalMinusUsed);
    const ct = read('credit_total',c?.total,nonnegative), used = read('credit_used',c?.used,nonnegative), available = read('credit_available',c?.available,nonnegative);
    if (simple !== true) add('credit_conditional_facility','needs_judgement','循环/共享/附条件授信额度须按银行凭证核对，不能据差额推定可用承诺。',c?.simpleAvailableEqualsTotalMinusUsed);
    if (cb && simple === true && ct !== undefined && used !== undefined && available !== undefined) add('credit_balance',a.equal(a.decimal(ct),a.add(a.decimal(used),a.decimal(available))) ? 'pass' : 'issue','同一时点及授信口径下总额=已用+剩余。',c?.total,c?.used,c?.available,c?.comparable);
    add('debt_risk_scope','needs_judgement','债务违约、集中偿付、增长原因、尚未发行额度及偿债能力另作完整核验。');
  } else if (key === 'rating-enhancement') {
    const d = input.ratingEnhancement;
    const rated = bool('rating_present',d?.rated), enhanced = bool('enhancement_present',d?.enhanced);
    if (rated === false) add('rating_absent','not_applicable','已核实未评级，不据此直接判私募不合规。',d?.rated);
    if (rated === true) { read('rating_current_report',d?.currentReport,nonempty); compareText(ctx,'rating_conclusion',d?.rating); }
    if (enhanced === false) add('enhancement_absent','not_applicable','已核实无增信安排，不生成担保承诺。',d?.enhanced);
    if (enhanced === true) { read('enhancement_current_contract',d?.currentContract,nonempty); compareText(ctx,'enhancement_terms',d?.guarantee); }
    if (rated || enhanced) add('rating_enhancement_detail','needs_judgement','评级变化、债项高于主体原因、保证人财务及担保范围/期限/有效性须逐项审核。');
  } else if (key === 'protection') {
    const d = input.protectionTerms;
    expect('protection_trustee_agreement',d?.trusteeAgreementPresent,true,'应有本期受托管理协议。');
    expect('protection_meeting_rules',d?.meetingRulesPresent,true,'应有本期持有人会议规则。');
    compareText(ctx,'protection_term',d?.term);
    if (bool('protection_example_added',d?.referenceExampleAdded) === true) read('protection_actual_agreement',d?.actualAgreement,nonempty);
    add('protection_full_review','needs_judgement','参考文本可参照，新增承诺须实际约定；受托/会议/增信/违约条款须全量交叉核对，协会配套现行依据仍待补齐。');
  } else if (key === 'risk-disclosure') {
    const d = input.riskUpdate;
    compareText(ctx,'risk_fact',d?.fact);
    if (bool('risk_removed',d?.historicalRiskRemoved) === true) read('risk_removal_basis',d?.removalBasis,nonempty);
    add('risk_sufficiency','needs_judgement','金额/事件同步不证明风险充分；不得无依据删除有效风险，重大事项提示和应对进展另审。');
  } else if (key === 'document-delivery') {
    const d = input.delivery;
    const hash = read('delivery_artifact_hash',d?.artifactHash,(v): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v));
    const required = read('delivery_required',d?.requiredSections,stringSet), delivered = read('delivery_sections',d?.deliveredSections,stringSet), exempt = read('delivery_exempt',d?.exemptSections,stringSet);
    if (required && !required.length) add('delivery_empty_plan','needs_evidence','缺少经确认的本稿章节/披露项清单，不能空集合通过。',d?.requiredSections);
    if (hash && required?.length && delivered && exempt) {
      const justification = exempt.length ? read('delivery_exemption_basis',d?.exemptionBasis,nonempty) : 'none';
      if (justification) add('delivery_coverage',required.every(id=>delivered.includes(id)||exempt.includes(id)) && exempt.every(id=>required.includes(id)) ? 'pass' : 'issue',
        '按本稿经审核披露清单核对，不把专家16节设为唯一法定目录，也不要求私募必须交摘要。',d?.artifactHash,d?.requiredSections,d?.deliveredSections,d?.exemptSections,d?.exemptionBasis);
    }
    const history = bool('delivery_history',d?.hasHistory), changed = bool('delivery_changed',d?.contentChanged);
    if (hash && history === true && changed === true) { const revisions = read('delivery_revision_count',d?.revisionCount,count); if (revisions !== undefined) add('delivery_revisions',revisions > 0 ? 'pass' : 'issue','历史稿有修改时需真实修订记录；计数不等于已验证每处修改。',d?.artifactHash,d?.revisionCount); }
    if (bool('delivery_comments_needed',d?.commentsNeeded) === true && hash) { const comments = read('delivery_comment_count',d?.commentCount,count); if (comments !== undefined) add('delivery_comments',comments > 0 ? 'pass' : 'issue','需批注的待确认内容应有实际批注；仍需逐处核查定位。',d?.artifactHash,d?.commentCount); }
    const wps = bool('delivery_wps_reopened',d?.wpsOpenedAndReopened);
    if (hash && wps !== undefined) add('delivery_wps_receipt',wps ? 'pass' : 'needs_judgement','WPS实际打开/保存重开由产出后的人工记录证明，不能以XML计数替代或作为首跑前置。',d?.artifactHash,d?.wpsOpenedAndReopened);
    add('delivery_professional_acceptance','needs_judgement','需真实Word/WPS逐章、金额、修订、批注与可下载验收；本检查不修改run终态。');
  } else if (key === 'trustee-continuing-duties') {
    const d = input.trusteeStatement;
    compareText(ctx,'trustee_duty',d?.duty);
    const kind = read('trustee_statement_kind',d?.statementKind,enumOf(['arrangement','performed']));
    const source = read('trustee_support_kind',d?.supportKind,enumOf(['agreement','performance_record','guideline_example']));
    const support = read('trustee_actual_support',d?.actualSupport,nonempty);
    if (kind && source && support) add('trustee_claim_basis',kind === 'performed' ? (source === 'performance_record' ? 'pass' : 'issue') : (source === 'agreement' ? 'pass' : 'needs_judgement'),
      '约定安排与已履职事实分开；指南鼓励及示范案例不能冒充已开展信用监测。',d?.statementKind,d?.supportKind,d?.actualSupport);
    add('trustee_full_lifecycle','needs_judgement','全量信用监测、风险处置及日常披露属于持续履职审核，本条不宣称已全部履行。');
  } else throw new Error(`SSE_PRIVATE_ADDITIONAL_RULE_UNKNOWN:${ruleId}`);
}
