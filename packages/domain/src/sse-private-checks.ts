import type { FactStatus } from './facts.js';
import type { RulePack } from './index.js';

/** Internal, pure research evaluator. Not an API DTO, fact verifier or release authority. */
export const SSE_PRIVATE_CHECKER_VERSION = '1';
export const SSE_PRIVATE_CHECKER_ID = 'sse-private-structured-evidence';
export const SSE_PRIVATE_CHECKED_RULES = [
  'sse-private-private-investors', 'sse-private-financial-validity-sse',
  'sse-private-private-use-change', 'sse-private-idle-proceeds-2026',
  'sse-private-continuing-disclosure',
] as const;
type RuleId = typeof SSE_PRIVATE_CHECKED_RULES[number];
type Outcome = 'pass' | 'issue' | 'needs_evidence' | 'needs_judgement' | 'not_applicable';
export interface CheckEvidence<T> {
  value: T | null;
  status: FactStatus;
  /** Exact version-bound source anchors; supplied by the trusted fact/review adapter. */
  anchors: readonly string[];
}
export interface SsePrivateCheckInput {
  market: string | null;
  offering: string | null;
  /** Rule applicability date, never substituted with the financial cutoff. */
  asOf: CheckEvidence<string>;
  investors?: {
    professionalOnly: CheckEvidence<boolean>;
    publicSolicitation: CheckEvidence<boolean>;
    issuanceCount: CheckEvidence<number>;
    transferPlanned: CheckEvidence<boolean>;
    transferProfessionalOnly?: CheckEvidence<boolean>;
    holdersAfterTransfer?: CheckEvidence<number>;
  };
  financialValidity?: {
    cutoff: CheckEvidence<string>;
    newApplication: CheckEvidence<boolean>;
    /** Approval evidence is required; an application for extension is not approval. */
    approvedExtensionUntil?: CheckEvidence<string>;
  };
  useChange?: {
    proposed: CheckEvidence<boolean>;
    restrictedDebtUse?: CheckEvidence<boolean>;
    changesToNonRestrictedUse?: CheckEvidence<boolean>;
    procedureAgreed?: CheckEvidence<boolean>;
    materialImpact?: CheckEvidence<boolean>;
    holderResolution?: CheckEvidence<boolean>;
    agreedProcedureFollowed?: CheckEvidence<boolean>;
  };
  temporaryUse?: {
    planned: CheckEvidence<boolean>;
    principleRestrictionPresent?: CheckEvidence<boolean>;
    termsExplicit?: CheckEvidence<boolean>;
    recoveryMechanism?: CheckEvidence<boolean>;
    decisionProcedure?: CheckEvidence<boolean>;
    internalApproval?: CheckEvidence<boolean>;
    start?: CheckEvidence<string>;
    repayment?: CheckEvidence<string>;
    /** null=unknown; [] only with reviewed evidence that there is no payment node. */
    paymentNodes?: CheckEvidence<readonly string[]>;
  };
  continuingDisclosure?: {
    financialYearEnd: CheckEvidence<string>;
    halfYearEnd: CheckEvidence<string>;
    promisedAnnualBy: CheckEvidence<string>;
    promisedInterimBy: CheckEvidence<string>;
    annualAudited: CheckEvidence<boolean>;
  };
}
export interface SsePrivateFinding {
  ruleId: RuleId;
  code: string;
  outcome: Outcome;
  message: string;
  sourceRefIds: readonly string[];
  evidenceAnchors: readonly string[];
}

function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
/** Calendar months, including leap days and month-end clamping; never months * 30. */
function monthsAfter(value: string, months: number): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  const last = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months + 1, 0));
  last.setUTCDate(Math.min(parsed.getUTCDate(), last.getUTCDate()));
  return last.toISOString().slice(0, 10);
}
function reportingDeadline(value: string, months: number): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  const end = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0));
  return parsed.getUTCDate() === end.getUTCDate()
    ? new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months + 1, 0)).toISOString().slice(0, 10)
    : monthsAfter(value, months);
}
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Returns local check results even while the pack is disabled. The explicit research
 * envelope and uncovered list prohibit treating those results as a production release
 * or whole-document legal conclusion. The #19 authenticated release gate is unchanged.
 */
export function evaluateSsePrivateDraftChecks(pack: RulePack, input: SsePrivateCheckInput) {
  if (pack.pack_id !== 'sse-private' || pack.scope.market !== 'sse' || pack.scope.offering !== 'private') {
    throw new Error('SSE_PRIVATE_CHECK_PACK_MISMATCH');
  }
  const findings: SsePrivateFinding[] = [];
  for (const ruleId of SSE_PRIVATE_CHECKED_RULES) {
    const rule = pack.rules.find(item => item.rule_id === ruleId);
    if (!rule || rule.checker.checker_id !== SSE_PRIVATE_CHECKER_ID
      || rule.checker.checker_version !== SSE_PRIVATE_CHECKER_VERSION
      || rule.checker.parameter_version !== pack.version) throw new Error(`SSE_PRIVATE_CHECKER_VERSION_MISMATCH:${ruleId}`);
    const add = (code: string, outcome: Outcome, message: string, ...evidence: (CheckEvidence<unknown> | undefined)[]) => {
      findings.push({ ruleId, code, outcome, message, sourceRefIds: [...rule.source_ref_ids],
        evidenceAnchors: [...new Set(evidence.flatMap(item => item?.anchors ?? []))] });
    };
    const read = <T>(key: string, item: CheckEvidence<T> | undefined, valid: (value: unknown) => value is T): T | undefined => {
      if (!item || item.status !== 'verified' || !item.anchors.length || item.anchors.some(anchor => !anchor.trim()) || !valid(item.value)) {
        add(`evidence:${key}`, 'needs_evidence', `${key} 缺少已核对的有效值及来源定位；保留待人工确认。`, item);
        return undefined;
      }
      return item.value as T;
    };
    const bool = (key: string, item: CheckEvidence<boolean> | undefined) => read(key, item, isBoolean);
    const day = (key: string, item: CheckEvidence<string> | undefined) => read(key, item, date);
    const expect = (key: string, item: CheckEvidence<boolean> | undefined, expected: boolean, message: string) => {
      const value = bool(key, item);
      if (value !== undefined) add(key, value === expected ? 'pass' : 'issue', message, item);
    };
    if (input.market === null || input.offering === null) {
      add('scope_unknown', 'needs_evidence', '本次目标市场或发行方式待确认。'); continue;
    }
    if (input.market !== 'sse' || input.offering !== 'private') {
      add('other_scope', 'not_applicable', '本检查仅适用于上交所普通私募公司债。'); continue;
    }
    const asOf = day('asOf', input.asOf);
    if (!asOf) continue;
    // This implementation is tied to the archived 2026-09-26 documentary baseline.
    // Historical applications need another exact pack; future amendments need re-review.
    if (asOf !== '2026-09-26') {
      add('rule_date_outside_research_baseline', 'needs_judgement', '本实现仅回放2026-09-26规则研究基准，其他适用日须另行核对规则版本。', input.asOf); continue;
    }
    if (ruleId === 'sse-private-private-investors') {
      const data = input.investors;
      expect('professional_only', data?.professionalOnly, true, '发行对象应为专业投资者。');
      expect('public_solicitation', data?.publicSolicitation, false, '不得广告、公开劝诱或变相公开发行。');
      const count = read('issuance_count', data?.issuanceCount, isCount);
      if (count !== undefined) add('issuance_count', count > 200 ? 'issue' : 'pass', '每次发行对象不得超过200人；200人本身不超限。', data?.issuanceCount);
      const transfer = bool('transfer_planned', data?.transferPlanned);
      if (transfer) {
        expect('transfer_professional_only', data?.transferProfessionalOnly, true, '转让也仅限专业投资者范围。');
        const holders = read('holders_after_transfer', data?.holdersAfterTransfer, isCount);
        if (holders !== undefined) add('holders_after_transfer', holders > 200 ? 'issue' : 'pass', '同次债券转让后合计持有人不得超过200人，不与发行时人数相加。', data?.holdersAfterTransfer);
      } else if (transfer === false) add('transfer_not_planned', 'not_applicable', '本次无转让安排，不表示免除未来转让适当性要求。', data?.transferPlanned);
      add('investor_suitability_scope', 'needs_judgement', '本检查不覆盖投资者适当性穿透、分类及例外，须结合完整规则审核。');
    } else if (ruleId === 'sse-private-financial-validity-sse') {
      const data = input.financialValidity;
      const cutoff = day('financial_cutoff', data?.cutoff);
      const newApplication = bool('new_application', data?.newApplication);
      if (!cutoff || newApplication === undefined) continue;
      if (cutoff > asOf) { add('future_cutoff', 'issue', '财务截止日晚于规则适用日，不能作为已发生财务信息。', data?.cutoff, input.asOf); continue; }
      const normalUntil = reportingDeadline(cutoff, 6);
      if (asOf <= normalUntil) { add('financial_validity', 'pass', `截止日后6个月内：${normalUntil}。`, data?.cutoff, input.asOf); continue; }
      if (newApplication) { add('new_application_expired', 'needs_judgement', '新申报已超过通常6个月期限，应核对最新一期财务报告；不得自动将其他项目延期套用于本次新申报。', data?.cutoff, input.asOf); continue; }
      const extension = day('approved_extension_until', data?.approvedExtensionUntil);
      if (!extension) continue;
      const maximum = reportingDeadline(cutoff, 7);
      add('approved_extension', extension >= normalUntil && extension <= maximum && asOf <= extension ? 'pass' : 'issue',
        `延期需实际获准，且至多延长1个月（上限${maximum}）；不以已申请等同获准。`, data?.approvedExtensionUntil, data?.cutoff, input.asOf);
    } else if (ruleId === 'sse-private-private-use-change') {
      const data = input.useChange;
      const proposed = bool('use_change_proposed', data?.proposed);
      if (proposed !== true) { if (proposed === false) add('no_use_change', 'not_applicable', '本次未提出用途变更；不替代募集资金章节完整性核对。', data?.proposed); continue; }
      const restricted = bool('restricted_debt_use', data?.restrictedDebtUse);
      const toOther = bool('changes_to_nonrestricted_use', data?.changesToNonRestrictedUse);
      if (restricted !== undefined && toOther !== undefined) add('restricted_debt_use', restricted && toOther ? 'issue' : 'pass',
        '已限定偿债用途不得变更为非限定偿债用途，持有人决议不能代替该限制。', data?.restrictedDebtUse, data?.changesToNonRestrictedUse);
      const agreed = bool('procedure_agreed', data?.procedureAgreed);
      const impact = bool('material_holder_impact', data?.materialImpact);
      if (agreed === false || impact === true) expect('holder_resolution', data?.holderResolution, true, '未约定或约定不明／重大影响持有人权益时需持有人会议通过。');
      if (agreed === true) expect('agreed_procedure_followed', data?.agreedProcedureFollowed, true, '私募按约定程序处理，不把公募跨用途类别一律开会的规则直接套用。');
    } else if (ruleId === 'sse-private-idle-proceeds-2026') {
      const data = input.temporaryUse;
      const planned = bool('temporary_use_planned', data?.planned);
      if (planned !== true) { if (planned === false) add('no_temporary_use', 'not_applicable', '没有临时补流安排；最终用途为补流与闲置资金临时补流不同。', data?.planned); continue; }
      const restricted = bool('principle_restriction_present', data?.principleRestrictionPresent);
      if (restricted === true) add('principle_restriction', 'needs_judgement', '存在集中偿付压力、信贷收缩、过度融资或限定偿债等情形，原则上不得约定临时补流；例外不得自动放行。', data?.principleRestrictionPresent);
      expect('temporary_terms_explicit', data?.termsExplicit, true, '募集说明书应明确约定临时补流条款。');
      expect('recovery_mechanism', data?.recoveryMechanism, true, '需有明确回收机制。');
      expect('decision_procedure', data?.decisionProcedure, true, '需有明确决策程序。');
      expect('internal_approval', data?.internalApproval, true, '实际使用时需履行内部审批决策程序。');
      const start = day('temporary_start', data?.start), repayment = day('temporary_repayment', data?.repayment);
      const nodes = read('original_payment_nodes', data?.paymentNodes, (value): value is readonly string[] => Array.isArray(value) && value.every(date));
      if (!start || !repayment || nodes === undefined) continue;
      const deadline = [monthsAfter(start, 12), ...nodes].sort()[0]!;
      add('temporary_repayment_deadline', repayment < start || repayment > deadline ? 'issue' : repayment === deadline ? 'needs_judgement' : 'pass',
        `回收期限取12个月和原用途付款节点（如有）的孰早日${deadline}；正好落在边界日时须核对“日前”的合同安排，不能自动放行。`, data?.start, data?.repayment, data?.paymentNodes);
    } else {
      const data = input.continuingDisclosure;
      const yearEnd = day('financial_year_end', data?.financialYearEnd), halfEnd = day('half_year_end', data?.halfYearEnd);
      const annual = day('annual_disclosure_by', data?.promisedAnnualBy), interim = day('interim_disclosure_by', data?.promisedInterimBy);
      if (yearEnd && annual) add('annual_disclosure', annual >= yearEnd && annual <= reportingDeadline(yearEnd, 4) ? 'pass' : 'issue', '募集说明书约定年后4个月内披露上年度经审计财务报告。', data?.financialYearEnd, data?.promisedAnnualBy);
      if (halfEnd && interim) add('interim_disclosure', interim >= halfEnd && interim <= reportingDeadline(halfEnd, 2) ? 'pass' : 'issue', '募集说明书约定上半年结束后2个月内披露中期报告。', data?.halfYearEnd, data?.promisedInterimBy);
      expect('annual_audited', data?.annualAudited, true, '约定披露的年度财务报告应经审计。');
    }
  }
  return {
    mode: 'research_only' as const, productionEligible: false as const,
    packId: pack.pack_id, packVersion: pack.version, checkerVersion: SSE_PRIVATE_CHECKER_VERSION,
    findings,
    uncoveredRuleIds: pack.rules.filter(rule => !(SSE_PRIVATE_CHECKED_RULES as readonly string[]).includes(rule.rule_id)).map(rule => rule.rule_id),
    limitations: ['只检查提供的结构化证据，不提取或批准事实；不覆盖整份募集书合规。',
      '部分检查通过不代表规则来源已签认、规则已发布或真实成果已通过行业验收。'],
  };
}
