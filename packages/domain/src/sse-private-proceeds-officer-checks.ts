import { FUNDING_PURPOSES } from '@bondbuddy/contracts';
import type { CheckEvidence, SsePrivateFinding } from './sse-private-checks.js';
import * as arithmetic from './update-arithmetic.js';

type Purpose = typeof FUNDING_PURPOSES[number]['code'];
/** Internal evidence supplied by the trusted adapter, never a draft-form approval. */
export interface ProceedsOfficerCheckInput {
  fundsUse?: {
    productiveExpenditureSimplification: CheckEvidence<boolean>;
    completeAllocationInventory: CheckEvidence<boolean>;
    sameCurrencyUnitAndGrossNetBasis: CheckEvidence<boolean>;
    allocationTotal: CheckEvidence<string>;
    allocations: readonly {
      purpose: CheckEvidence<Purpose>;
      amount: CheckEvidence<string>;
      /** Reviewed support for this particular use; not merely a filename/upload. */
      supportingEvidence: CheckEvidence<boolean>;
    }[];
  };
  disclosureOfficer?: {
    name: CheckEvidence<string>;
    position: CheckEvidence<string>;
    contact: CheckEvidence<string>;
    liaisonName: CheckEvidence<string>;
    liaisonPosition: CheckEvidence<string>;
    liaisonContact: CheckEvidence<string>;
    eligiblePosition: CheckEvidence<boolean>;
    disqualificationReviewComplete: CheckEvidence<boolean>;
    disqualificationPresent: CheckEvidence<boolean>;
    changed: CheckEvidence<boolean>;
    currentSignedCommitment?: CheckEvidence<boolean>;
    previousValidCommitment?: CheckEvidence<boolean>;
  };
}
interface Context {
  add(code: string, outcome: SsePrivateFinding['outcome'], message: string, ...evidence: (CheckEvidence<unknown> | undefined)[]): void;
  read<T>(key: string, item: CheckEvidence<T> | undefined, valid: (value: unknown) => value is T): T | undefined;
  bool(key: string, item: CheckEvidence<boolean> | undefined): boolean | undefined;
  expect(key: string, item: CheckEvidence<boolean> | undefined, expected: boolean, message: string): void;
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 12000;
const amount = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,19})(?:\.\d{1,12})?$/.test(value);

export function evaluateProceedsOfficerCheck(ruleId: string, input: ProceedsOfficerCheckInput, ctx: Context): void {
  const { add, read, bool, expect } = ctx;
  if (ruleId === 'sse-private-funds-use-evidence') {
    const data = input.fundsUse;
    const simplified = bool('productive_expenditure_simplification', data?.productiveExpenditureSimplification);
    if (simplified !== false) {
      if (simplified) add('productive_expenditure_exception', 'needs_judgement',
        '生产性支出概括约定有适用条件及排除情形；本检查不认定简化披露资格，也不自动豁免用途规模。', data?.productiveExpenditureSimplification);
      return;
    }
    const complete = bool('allocation_inventory_complete', data?.completeAllocationInventory);
    const comparable = bool('allocation_same_basis', data?.sameCurrencyUnitAndGrossNetBasis);
    const total = read('allocation_total', data?.allocationTotal, amount);
    const rows = data?.allocations ?? [];
    if (!rows.length) { add('allocation_rows_missing', 'needs_evidence', '缺少各类资金用途及对应规模，保留待人工确认。'); return; }
    if (rows.length > 1000) { add('allocation_inventory_limit', 'needs_judgement', '用途分项超过本检查支持范围，不能截断后认定完整。'); return; }
    let validAmounts = true;
    let sum = arithmetic.decimal('0');
    for (const [index, row] of rows.entries()) {
      const key = `allocation_${index}`;
      read(`${key}_purpose`, row.purpose, (value): value is Purpose => FUNDING_PURPOSES.some(p => p.code === value));
      const value = read(`${key}_amount`, row.amount, amount);
      if (value === undefined) validAmounts = false;
      else sum = arithmetic.add(sum, arithmetic.decimal(value));
      expect(`${key}_support`, row.supportingEvidence, true,
        '应核对本项用途、对象及适用配套材料；缺可研、许可、协议或债务依据时标记缺口，不编造已取得事实。');
    }
    if (complete !== true || comparable !== true) {
      add('allocation_scope_unconfirmed', 'needs_judgement',
        '分项集合、币种单位及发行费用扣除前后口径须一致；不能用部分用途之和或募集总额／净额混算判断金额一致。',
        data?.completeAllocationInventory, data?.sameCurrencyUnitAndGrossNetBasis);
    } else if (total !== undefined && validAmounts) {
      add('allocation_sum', arithmetic.equal(sum, arithmetic.decimal(total)) ? 'pass' : 'issue',
        '资金用途分项之和应与同口径的分配总额一致；精确十进制比较，不提前四舍五入。',
        data?.allocationTotal, data?.completeAllocationInventory, data?.sameCurrencyUnitAndGrossNetBasis, ...rows.map(row => row.amount));
    }
    add('funds_use_check_scope', 'needs_judgement', '本检查核对用途分项与证据状态，不证明项目／基金／股权投资或资金使用已经合法获批。');
  } else if (ruleId === 'sse-private-disclosure-officer-2026') {
    const data = input.disclosureOfficer;
    for (const field of ['name', 'position', 'contact', 'liaisonName', 'liaisonPosition', 'liaisonContact'] as const) {
      if (read(`officer_${field}`, data?.[field], text) !== undefined)
        add(`officer_${field}`, 'pass', '本项负责人／联络人信息有已核对内容及来源。', data?.[field]);
    }
    expect('officer_eligible_position', data?.eligiblePosition, true, '负责人应为董事、高级管理人员或履行同等职责人员。');
    const reviewed = bool('officer_disqualification_review', data?.disqualificationReviewComplete);
    if (reviewed === true) expect('officer_disqualification', data?.disqualificationPresent, false, '任职禁止情形须逐项核对，不能把未检索当作不存在。');
    else if (reviewed === false) add('officer_disqualification_incomplete', 'needs_judgement', '任职禁止情形尚未核对完整，不能认定符合任职条件。', data?.disqualificationReviewComplete);
    const changed = bool('officer_changed', data?.changed);
    if (changed === true) expect('officer_current_commitment', data?.currentSignedCommitment, true, '变更后需要本任负责人的真实签署承诺；模型不能代签。');
    else if (changed === false) {
      // An unchanged officer need not re-sign. A verified existing valid commitment is sufficient.
      const previous = data?.previousValidCommitment;
      if (previous?.status === 'verified' && previous.value === true && previous.anchors.length && previous.anchors.every(a => a.trim())) {
        add('officer_existing_commitment', 'pass', '负责人未变更且有有效既有承诺，无需重复签署。', data?.changed, previous);
      } else expect('officer_current_commitment', data?.currentSignedCommitment, true, '需确认本任负责人的有效既有承诺或实际新签承诺；缺证据不写成已签署。');
    }
    add('officer_check_scope', 'needs_judgement', '本检查不代替实际任职资格、变更公告和持续履职的专业核验。');
  }
}
