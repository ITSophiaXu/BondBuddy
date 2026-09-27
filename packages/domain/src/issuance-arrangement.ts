import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DOCUMENT_PURPOSES, OFFERINGS, MoneySchema, moneyInMicroYuan, isMarketOffering } from '@bondbuddy/contracts';
import { updateContentHash } from './historical-update.js';
import { estimateUpdateDifficulty, type UpdateDifficultyEstimateInput } from './update-difficulty.js';

/** Internal #32 proposal/review format, not an HTTP DTO, issuer fact or Word plan. */
export const ARRANGEMENT_VERSION = 'issuance-arrangement-review-v1';
const strict = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '\\S' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map((v: T[number]) => Type.Literal(v)));
const ids = Type.Array(id, { minItems: 1, maxItems: 30, uniqueItems: true });
const scope = Type.Union([Type.Literal('all'), Type.Literal('single_only'), ids]);
const span = strict({ sourceId: id, version: Type.Integer({ minimum: 1 }), textHash: hash,
  start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }), quote: Type.String({ minLength: 1, maxLength: 6000, pattern: '\\S' }) });
const claim = <T extends TSchema>(value: T) => strict({ value: nullable(value),
  evidence: Type.Array(span, { maxItems: 20 }), uncertainty: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 20 }) });
const textClaim = claim(Type.String({ minLength: 1, maxLength: 3000, pattern: '\\S' }));
const amountClaim = claim(strict({ amount: MoneySchema, qualifier: enumOf(['exact', 'ceiling'] as const) }));
const termNames = ['tenor', 'renewal', 'interestType', 'payment', 'redemption', 'put', 'rateAdjustment', 'creditEnhancement', 'fundUse', 'investors'] as const;
type TermName = typeof termNames[number];
const optionalText = Type.Optional(textClaim);
const optionalShared = Type.Optional(strict({ claim: textClaim, scope }));
const terms = strict(Object.fromEntries(termNames.map(name => [name, optionalText])) as Record<TermName, typeof optionalText>);
const commonTerms = strict(Object.fromEntries(termNames.map(name => [name, optionalShared])) as Record<TermName, typeof optionalShared>);

export const ArrangementProposalSchema = strict({
  context: strict({ ownerUserId: id, projectId: id, inputRevision: Type.Integer({ minimum: 1 }), inputHash: hash }),
  sources: Type.Array(strict({ sourceId: id, version: Type.Integer({ minimum: 1 }), ownerUserId: id, projectId: id,
    kind: enumOf(['project_field', 'message'] as const), text: Type.String({ minLength: 1, maxLength: 24000, pattern: '\\S' }), textHash: hash }), { maxItems: 50 }),
  document: strict({ sourcePurpose: nullable(enumOf(DOCUMENT_PURPOSES)), targetPurpose: nullable(enumOf(DOCUMENT_PURPOSES)),
    sourceActualOffering: nullable(enumOf(OFFERINGS)), targetActualOffering: nullable(enumOf(OFFERINGS)),
    // Covered tools describe registration scope. They never create tranches.
    coveredOfferings: Type.Array(enumOf(OFFERINGS), { uniqueItems: true, maxItems: 8 }) }),
  registrationAmount: amountClaim, issuanceAmount: amountClaim,
  commonTerms,
  tranches: Type.Array(strict({ trancheId: id, name: textClaim, amount: amountClaim, terms }), { maxItems: 30 }),
  callbacks: Type.Array(strict({ from: id, to: id, terms: textClaim }), { maxItems: 60 }),
  institutions: Type.Array(strict({ institutionId: id, name: textClaim, section: enumOf(['underwriting', 'other_agencies'] as const),
    // Preserve evidenced role wording rather than infer trustee/bookrunner roles.
    roles: Type.Array(textClaim, { maxItems: 12 }), scope }), { maxItems: 30 }),
});
export type ArrangementProposal = Static<typeof ArrangementProposalSchema>;
export type ArrangementTextClaim = Static<typeof textClaim>;
export type ArrangementAmountClaim = Static<typeof amountClaim>;
type SourceSpan = Static<typeof span>;
type ScopedTerm = NonNullable<ArrangementProposal['commonTerms'][TermName]>;
export interface ArrangementIssue { code: string; path: string; message: string; evidence: SourceSpan[] }
const chapterNames = ['封面', '发行概况', '风险因素', '募集资金用途', '偿债安排', '评级与增信', '投资者保护', '参与机构'] as const;
export interface ArrangementReview {
  schemaVersion: typeof ARRANGEMENT_VERSION; proposalHash: string; reviewHash: string;
  status: 'ready_for_review' | 'needs_confirmation'; sourceStatus: 'user_asserted'; eligibleForManuscript: false;
  context: ArrangementProposal['context']; sources: ArrangementProposal['sources']; proposal: ArrangementProposal;
  difficulty: ReturnType<typeof estimateUpdateDifficulty>;
  structureReasons: string[];
  tranches: { trancheId: string; name: ArrangementTextClaim; amount: ArrangementAmountClaim;
    terms: Partial<Record<TermName, { claim: ArrangementTextClaim; inherited: boolean }>> }[];
  institutions: { institutionId: string; name: ArrangementTextClaim; roles: ArrangementTextClaim[];
    trancheIds: string[]; roleDerivation: 'explicit' | 'single_underwriter' | 'unresolved' }[];
  issues: ArrangementIssue[];
  chapterChecks: { chapter: typeof chapterNames[number]; trancheIds: string[]; reason: string }[];
}

function splitSurrogate(text: string, position: number): boolean {
  return /[\uD800-\uDBFF]/.test(text.charAt(position - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(position));
}

/** Inspect a bounded semantic proposal against frozen user input. Span checks prove
 * attribution, not semantic correctness, authority or audit confirmation. The
 * caller must verify owner/project/input revision in persistent storage first. */
export function reviewIssuanceArrangement(proposal: ArrangementProposal, financial: UpdateDifficultyEstimateInput): ArrangementReview {
  if (!Value.Check(ArrangementProposalSchema, proposal)) throw new Error('ARRANGEMENT_INVALID_PROPOSAL');
  if (financial.targetRevision !== proposal.context.inputRevision) throw new Error('ARRANGEMENT_INPUT_REVISION_MISMATCH');
  financial = structuredClone(financial);
  const input = structuredClone(proposal);
  const sources = new Map(input.sources.map(s => [s.sourceId, s]));
  if (sources.size !== input.sources.length) throw new Error('ARRANGEMENT_DUPLICATE_SOURCE');
  for (const source of sources.values()) if (source.ownerUserId !== input.context.ownerUserId ||
    source.projectId !== input.context.projectId || updateContentHash(source.text) !== source.textHash) throw new Error('ARRANGEMENT_SOURCE_MISMATCH');
  const issues: ArrangementIssue[] = [];
  const issue = (code: string, path: string, message: string, evidence: SourceSpan[] = []) => {
    issues.push({ code, path, message, evidence: structuredClone(evidence) });
  };
  function checkClaim(c: ArrangementTextClaim | ArrangementAmountClaim, path: string): boolean {
    for (const e of c.evidence) {
      const source = sources.get(e.sourceId);
      if (!source || source.version !== e.version || source.textHash !== e.textHash || e.end <= e.start ||
        source.text.slice(e.start, e.end) !== e.quote || e.end > source.text.length || splitSurrogate(source.text, e.start) || splitSurrogate(source.text, e.end)) {
        throw new Error('ARRANGEMENT_EVIDENCE_MISMATCH');
      }
    }
    if (c.value === null) return false;
    if (!c.evidence.length || c.uncertainty.length) {
      issue('ARRANGEMENT_CLAIM_NEEDS_CONFIRMATION', path, '该安排缺少原输入定位或存在歧义，请核对。', c.evidence); return false;
    }
    if (typeof c.value === 'string') {
      if (!c.evidence.some(e => e.quote.includes(c.value as string))) {
        issue('ARRANGEMENT_TEXT_NOT_ANCHORED', path, '提取的条款未在所引原输入中找到，保留原文待核。', c.evidence); return false;
      }
    } else {
      const value = c.value;
      // Only explicit Arabic-decimal amount phrases are mechanically normalized.
      // More complex/Chinese-number wording remains a semantic review item.
      const anchored = c.evidence.some(e => {
        const preceding = sources.get(e.sourceId)!.text.slice(Math.max(0, e.start - 16), e.start);
        // Reject a suffix sliced out of a larger, decimal, signed or grouped number.
        if (/(?:[0-9０-９][,.，．]?|[.．+\-−])\s*$/.test(preceding)) return false;
        // A proposal must not drop an adjacent upper-bound word from its quote.
        if (value.qualifier === 'exact' && /(?:不超过|至多|上限为)\s*$/.test(preceding)) return false;
        const match = /^(不超过|至多|上限为)?\s*((?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?)\s*(亿元|万元|元)$/.exec(e.quote.trim());
        if (!match) return false;
        const unit = match[3] === '亿元' ? 'hundred_million' : match[3] === '万元' ? 'ten_thousand' : 'yuan';
        return (match[1] ? 'ceiling' : 'exact') === value.qualifier &&
          moneyInMicroYuan({ value: match[2]!, unit }) === moneyInMicroYuan(value.amount);
      });
      if (!anchored) { issue('ARRANGEMENT_AMOUNT_NOT_ANCHORED', path, '金额、单位或“不超过”等限定与所引原文不一致，不能用于汇总。', c.evidence); return false; }
    }
    return true;
  }
  const tranches = input.tranches;
  const trancheIds = tranches.map(t => t.trancheId);
  if (new Set(trancheIds).size !== trancheIds.length) throw new Error('ARRANGEMENT_DUPLICATE_TRANCHE');
  function applies(s: ScopedTerm['scope'], trancheId: string, path: string): boolean {
    if (Array.isArray(s) && s.some(id => !trancheIds.includes(id))) {
      issue('ARRANGEMENT_SCOPE_UNKNOWN', path, '适用范围引用了不存在的品种，请核对。'); return false;
    }
    return s === 'all' || (s === 'single_only' ? tranches.length === 1 : s.includes(trancheId));
  }
  const commonUsable = new Set<TermName>();
  for (const name of termNames) {
    const shared = input.commonTerms[name];
    if (shared && Array.isArray(shared.scope) && shared.scope.some(id => !trancheIds.includes(id))) issue('ARRANGEMENT_SCOPE_UNKNOWN', `commonTerms.${name}.scope`, '适用范围引用了不存在的品种，请核对。');
    if (shared && checkClaim(shared.claim, `commonTerms.${name}`)) commonUsable.add(name);
  }
  const issueAmountUsable = checkClaim(input.issuanceAmount, 'issuanceAmount');
  const registrationUsable = checkClaim(input.registrationAmount, 'registrationAmount');
  const registrationDocument = input.document.targetPurpose === 'registration';
  const resolved = tranches.map(t => {
    checkClaim(t.name, `tranches.${t.trancheId}.name`);
    let amount = checkClaim(t.amount, `tranches.${t.trancheId}.amount`) ? t.amount : { ...t.amount, value: null };
    if (t.amount.value === null && t.amount.uncertainty.length === 0 && tranches.length === 1 && issueAmountUsable) amount = input.issuanceAmount;
    if (amount.value === null) issue('ARRANGEMENT_TRANCHE_AMOUNT_MISSING', `tranches.${t.trancheId}.amount`, '请补充本品种的金额或上限；未确定时保留待确认。', t.amount.evidence);
    const resolvedTerms: ArrangementReview['tranches'][number]['terms'] = {};
    for (const name of termNames) {
      // Explicit null/uncertain local terms override common terms; never copy a sibling.
      const local = t.terms[name];
      if (local !== undefined) {
        const usable = checkClaim(local, `tranches.${t.trancheId}.terms.${name}`);
        resolvedTerms[name] = { claim: usable ? local : { ...local, value: null }, inherited: false };
      } else {
        const shared = input.commonTerms[name];
        if (shared && commonUsable.has(name) && applies(shared.scope, t.trancheId, `commonTerms.${name}.scope`)) {
          resolvedTerms[name] = { claim: shared.claim, inherited: true };
        }
      }
    }
    if (!resolvedTerms.tenor?.claim.value) issue('ARRANGEMENT_TENOR_MISSING', `tranches.${t.trancheId}.terms.tenor`, '请补充本品种期限；不从其他品种复制。');
    return { trancheId: t.trancheId, name: t.name, amount, terms: resolvedTerms };
  });
  if (!registrationDocument && !tranches.length) issue('ARRANGEMENT_TRANCHE_INVENTORY_MISSING', 'tranches', '尚未取得本期品种安排；不自动创建品种一、品种二。');
  if (!registrationDocument && !issueAmountUsable) issue('ARRANGEMENT_ISSUANCE_AMOUNT_MISSING', 'issuanceAmount', '本期发行规模尚待明确；注册总额不作为本期金额。');
  const amountValues = resolved.map(t => t.amount.value);
  if (issueAmountUsable && amountValues.length) {
    const total = moneyInMicroYuan(input.issuanceAmount.value!.amount);
    const lower = amountValues.reduce((sum, a) => sum + (a?.qualifier === 'exact' ? moneyInMicroYuan(a.amount) : 0n), 0n);
    const upper = amountValues.reduce((sum, a) => sum + (a ? moneyInMicroYuan(a.amount) : 0n), 0n);
    const allKnown = amountValues.every(a => a !== null);
    const allExact = amountValues.every(a => a?.qualifier === 'exact');
    if (lower > total || (input.issuanceAmount.value!.qualifier === 'exact' && allKnown && (upper < total || (allExact && lower !== total)))) {
      issue('ARRANGEMENT_AMOUNT_CONFLICT', 'tranches', '各品种金额与本期规模存在冲突，请确认分配；系统不自动调平。', input.issuanceAmount.evidence);
    } else if (!allExact) issue('ARRANGEMENT_ALLOCATION_UNDETERMINED', 'tranches', '部分品种为上限或尚未确定，不把上限之和视为实际发行金额，也不自动分配余额。');
  }
  if (issueAmountUsable && registrationUsable) {
    const current = input.issuanceAmount.value!, registration = input.registrationAmount.value!;
    if (moneyInMicroYuan(current.amount) > moneyInMicroYuan(registration.amount)) issue('ARRANGEMENT_REGISTRATION_AMOUNT_REVIEW', 'issuanceAmount', '本期规模或其上限超过申报／注册总额，请核对限定与安排；本检查不验证剩余额度。', input.issuanceAmount.evidence);
  }
  for (const [i, c] of input.callbacks.entries()) {
    if (!trancheIds.includes(c.from) || !trancheIds.includes(c.to) || c.from === c.to) issue('ARRANGEMENT_CALLBACK_SCOPE_INVALID', `callbacks.${i}`, '回拨必须指向两个已明确、不同的品种。', c.terms.evidence);
    if (!checkClaim(c.terms, `callbacks.${i}.terms`)) issue('ARRANGEMENT_CALLBACK_TERMS_MISSING', `callbacks.${i}.terms`, '回拨条件尚未明确，不能自动调整各档金额。', c.terms.evidence);
  }
  if (new Set(input.institutions.map(i => i.institutionId)).size !== input.institutions.length) throw new Error('ARRANGEMENT_DUPLICATE_INSTITUTION');
  const underwriters = input.institutions.filter(i => i.section === 'underwriting');
  const institutions = input.institutions.map(i => {
    const nameUsable = checkClaim(i.name, `institutions.${i.institutionId}.name`);
    if (!nameUsable) issue('ARRANGEMENT_INSTITUTION_NAME_MISSING', `institutions.${i.institutionId}.name`, '该机构名称尚待核对。', i.name.evidence);
    if (Array.isArray(i.scope) && i.scope.some(id => !trancheIds.includes(id))) issue('ARRANGEMENT_SCOPE_UNKNOWN', `institutions.${i.institutionId}.scope`, '机构范围引用了不存在的品种，请核对。');
    const roles = i.roles.filter((r, index) => checkClaim(r, `institutions.${i.institutionId}.roles.${index}`));
    let roleDerivation: ArrangementReview['institutions'][number]['roleDerivation'] = roles.length ? 'explicit' : 'unresolved';
    if (!i.roles.length && nameUsable && i.section === 'underwriting' && underwriters.length === 1) {
      roles.push({ value: '主承销商', evidence: i.name.evidence, uncertainty: [] }); roleDerivation = 'single_underwriter';
    }
    if (!roles.length) issue('ARRANGEMENT_INSTITUTION_ROLE_MISSING', `institutions.${i.institutionId}.roles`, '请明确该机构实际角色；不推定联席、受托管理或簿记管理职责。', i.name.evidence);
    const scoped = trancheIds.filter(id => applies(i.scope, id, `institutions.${i.institutionId}.scope`));
    if (!registrationDocument && scoped.length === 0) issue('ARRANGEMENT_INSTITUTION_SCOPE_MISSING', `institutions.${i.institutionId}.scope`, '请确认该机构负责哪些品种。');
    return { institutionId: i.institutionId, name: i.name, roles, trancheIds: scoped, roleDerivation };
  });

  const difficulty = estimateUpdateDifficulty(financial);
  const structureReasons: string[] = [];
  if (financial.source.market && financial.target.market && financial.source.market !== financial.target.market) structureReasons.push('market_changed');
  if (financial.source.offering && financial.target.offering && financial.source.offering !== financial.target.offering) structureReasons.push('offering_changed');
  if (input.document.sourcePurpose && input.document.targetPurpose && input.document.sourcePurpose !== input.document.targetPurpose) structureReasons.push('document_purpose_changed');
  const sourceActual = financial.source.offering === 'dfi' ? input.document.sourceActualOffering : financial.source.offering;
  const targetActual = financial.target.offering === 'dfi' ? input.document.targetActualOffering : financial.target.offering;
  if (sourceActual && targetActual && sourceActual !== targetActual) structureReasons.push('actual_offering_changed');
  if (!input.document.sourcePurpose) issue('ARRANGEMENT_SOURCE_PURPOSE_MISSING', 'document.sourcePurpose', '原稿文书用途尚未明确，不能把未知用途当成已发生结构变化。');
  if (!input.document.targetPurpose) issue('ARRANGEMENT_DOCUMENT_PURPOSE_MISSING', 'document.targetPurpose', '请从项目资料明确本次是注册文件还是本期发行文件，不从正文关键词猜测。');
  const target = financial.target;
  if (financial.source.offering === 'dfi' && input.document.sourcePurpose === 'issuance' && !input.document.sourceActualOffering) issue('ARRANGEMENT_DFI_SOURCE_OFFERING_MISSING', 'document.sourceActualOffering', '原稿为DFI项下本期文件时，仍须明确原稿实际工具。');
  if (target.offering === 'dfi' && input.document.targetPurpose === 'issuance' && !input.document.targetActualOffering) issue('ARRANGEMENT_DFI_ACTUAL_OFFERING_MISSING', 'document.targetActualOffering', 'DFI是注册安排；本期文件还需明确实际发行工具，不从覆盖清单挑选。');
  for (const [path, offering] of [
    ['sourceActualOffering', input.document.sourceActualOffering], ['targetActualOffering', input.document.targetActualOffering],
  ] as const) if (offering) {
    const side = path === 'sourceActualOffering' ? financial.source : target;
    if (!side.market || offering === 'dfi' || !isMarketOffering(side.market, offering) || (side.offering !== 'dfi' && side.offering !== offering)) issue('ARRANGEMENT_ACTUAL_OFFERING_CONFLICT', `document.${path}`, '实际工具与已确认文书市场／方式冲突，请保留各来源并核对。');
  }
  for (const offering of input.document.coveredOfferings) if (target.market !== 'nafmii' || offering === 'dfi' || !isMarketOffering('nafmii', offering)) issue('ARRANGEMENT_COVERED_OFFERING_INVALID', 'document.coveredOfferings', '注册覆盖范围包含不适用的发行方式，不能直接转为本期品种。');
  if (difficulty.status !== 'ready') issue('ARRANGEMENT_FINANCIAL_DIFFICULTY_PENDING', 'difficulty', '报告期或源市场信息尚未确认；不将期数默认为零或按档数增加。');
  const uniqueIssues = [...new Map(issues.map(i => [JSON.stringify([i.code, i.path]), i])).values()];
  const result: Omit<ArrangementReview, 'reviewHash'> = {
    schemaVersion: ARRANGEMENT_VERSION, proposalHash: updateContentHash({ proposal: input, financial }),
    status: uniqueIssues.length ? 'needs_confirmation' : 'ready_for_review', sourceStatus: 'user_asserted', eligibleForManuscript: false,
    context: input.context, sources: input.sources, proposal: input, difficulty, structureReasons, tranches: resolved, institutions, issues: uniqueIssues,
    chapterChecks: chapterNames.map(chapter => ({ chapter, trancheIds: [...trancheIds], reason: '逐档核对金额、期限、含权及机构范围；保留未定安排。此清单不代表原文章节已修改或规则已通过。' })),
  };
  return { ...result, reviewHash: updateContentHash(result) };
}
