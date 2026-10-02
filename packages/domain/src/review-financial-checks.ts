import type { ReviewEvidenceRef, ReviewFinding } from '../../contracts/dist/review-results.js';
import { add, subtract, divide, scale, convert, decimal, display, equal, type Rational } from './update-arithmetic.js';
import { canonical, evidenceKey, uniqueEvidence, validateReviewEvidence, type ReviewEvidenceContext } from './review-evidence.js';
import { normalizeReviewFindings, reviewCoverage, type ReviewEvaluation, type ReviewFindingCandidate } from './review-finding-normalization.js';

export interface ReviewFinancialObservation {
  observation_id: string;
  source_kind: 'disclosure' | 'audit' | 'financial_statement' | 'user_statement';
  entity_id: string; metric: string; accounting_scope: string; basis: string;
  period: { start: string | null; end: string | null; as_of: string | null };
  currency: string; unit: string;
  /** Canonical value plus the exact visible numeral, e.g. -1234.5 and (1,234.50). */
  value: string; value_literal: string;
  value_refs: ReviewEvidenceRef[];
  /** Each context field must have traceable source text. No model confidence alone suffices. */
  context_refs: { entity: ReviewEvidenceRef[]; period: ReviewEvidenceRef[]; accounting_scope: ReviewEvidenceRef[];
    currency: ReviewEvidenceRef[]; unit: ReviewEvidenceRef[]; basis: ReviewEvidenceRef[] };
}
export interface ReviewFinancialCalculation {
  calculation_id: string; label: string;
  operation: 'sum' | 'ratio_percent' | 'growth_percent' | 'percentage_point';
  result_id: string; operand_ids: string[];
  /** A sum with an incomplete row inventory is not evidence of an arithmetic error. */
  complete_terms: boolean;
}
export interface ReviewFinancialInput { observations: ReviewFinancialObservation[]; calculations: ReviewFinancialCalculation[] }
const units: Record<string, string> = { yuan:'元', thousand_yuan:'千元', ten_thousand:'万元', ten_thousand_yuan:'万元', hundred_million_yuan:'亿元', percent:'%', percentage_point:'百分点' };
const unit = (value: string) => units[value] ?? value;
const numberLiteral = /^([+-]?)(?:(\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?$/;
function literalNumber(literal: string): string | null {
  let value = literal.trim().replace(/％$/, '%').replace(/%$/, '');
  const parens = /^\(.*\)$/.test(value) || /^（.*）$/.test(value);
  if (parens) value = value.slice(1, -1);
  if (!numberLiteral.test(value) || parens && /^[+-]/.test(value)) return null;
  return `${parens ? '-' : ''}${value.replaceAll(',', '')}`;
}
function precision(observation: ReviewFinancialObservation): number {
  const value = literalNumber(observation.value_literal);
  return value?.split('.')[1]?.length ?? 0;
}
const day = (value: string | null) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const contextIdentity = (o: ReviewFinancialObservation, includePeriod = true) => canonical([
  o.entity_id, o.accounting_scope, o.basis, o.currency, includePeriod ? o.period : null,
]);
const references = (o: ReviewFinancialObservation) => uniqueEvidence([...o.value_refs, ...Object.values(o.context_refs).flat()]);
function validObservation(o: ReviewFinancialObservation, ctx: ReviewEvidenceContext): string[] {
  const problems: string[] = [];
  if (![o.observation_id,o.entity_id,o.metric,o.accounting_scope,o.basis,o.currency,o.unit].every(value => typeof value === 'string' && value.trim())) problems.push('financial_context_missing');
  if (![o.period.start,o.period.end,o.period.as_of].every(day) || !(o.period.as_of || o.period.start && o.period.end)
    || o.period.start && o.period.end && o.period.start > o.period.end) problems.push('financial_period_invalid');
  if (!o.value_refs.length || Object.values(o.context_refs).some(refs => !refs.length)) problems.push('financial_context_evidence_missing');
  for (const ref of references(o)) problems.push(...validateReviewEvidence(ref, ctx, o.source_kind === 'disclosure'));
  if (references(o).some(ref => ref.uncertainty.length)) problems.push('financial_source_uncertain');
  if (o.source_kind === 'user_statement') problems.push('user_statement_not_audited_evidence');
  if (['audit','financial_statement'].includes(o.source_kind) && o.value_refs.some(ref => ref.material_id === ctx.source_material.material_id)) problems.push('disclosure_is_not_independent_financial_source');
  const literal = literalNumber(o.value_literal);
  try { if (literal === null || !equal(decimal(literal),decimal(o.value))) problems.push('financial_value_literal_mismatch'); }
  catch { problems.push('financial_decimal_invalid'); }
  if (!o.value_refs.some(ref => {
    const record = ctx.records.find(record => evidenceKey(record) === evidenceKey(ref));
    if (!record || !o.value_literal.length) return false;
    // Verify token boundaries in the trusted full record, not in a model-truncated quote.
    let quoteStart = record.literal_quote.indexOf(ref.quote);
    while (quoteStart >= 0) {
      let start = ref.quote.indexOf(o.value_literal);
      while (start >= 0) {
        const absolute = quoteStart + start;
        const before = record.literal_quote[absolute - 1] ?? '', after = record.literal_quote[absolute + o.value_literal.length] ?? '';
        if (!/[\d,.+\-（(]/.test(before) && !/[\d,.%％)）]/.test(after)) return true;
        start = ref.quote.indexOf(o.value_literal, start + 1);
      }
      quoteStart = record.literal_quote.indexOf(ref.quote,quoteStart + 1);
    }
    return false;
  })) problems.push('financial_value_not_in_source');
  if (precision(o) > 12) problems.push('financial_display_precision_unsupported');
  return [...new Set(problems)];
}
/** Reuse the same source, literal and context checks for immutable knowledge formulas. */
export const validateReviewFinancialObservation = validObservation;
function converted(o: ReviewFinancialObservation, to: string): Rational { return convert(decimal(o.value), unit(o.unit), unit(to)); }
function roundedEqual(expected: Rational, observed: ReviewFinancialObservation): boolean {
  return equal(decimal(display(expected, precision(observed), false)), decimal(observed.value));
}
function candidate(ctx: ReviewEvidenceContext, o: ReviewFinancialObservation, key: string, conclusion: ReviewFinding['conclusion'],
  title: string, description: string, support: ReviewEvidenceRef[], limits: string[] = []): ReviewFindingCandidate {
  return { stable_key:key,dimension:'financial',conclusion,severity:conclusion === 'error' ? 'P1' : 'P2',title,description,
    target_refs:o.value_refs,evidence_refs:support,limitations:limits,verification:'deterministic' };
}

export function reviewFinancialEvidence(input: ReviewFinancialInput, ctx: ReviewEvidenceContext): ReviewEvaluation {
  if (input.observations.length > 10000 || input.calculations.length > 10000) throw new Error('REVIEW_FINANCIAL_INPUT_LIMIT');
  if (new Set(input.observations.map(o => o.observation_id)).size !== input.observations.length
    || new Set(input.calculations.map(c => c.calculation_id)).size !== input.calculations.length) throw new Error('REVIEW_FINANCIAL_DUPLICATE_ID');
  const result: ReviewEvaluation = { findings:[],coverage:[],limitations:[] };
  const byId = new Map(input.observations.map(o => [o.observation_id,o]));
  const validation = new Map(input.observations.map(o => [o.observation_id,validObservation(o,ctx)]));
  const emit = (checkId: string, o: ReviewFinancialObservation, finding: ReviewFindingCandidate | null, support: ReviewEvidenceRef[], reason: string) => {
    const findings = finding ? normalizeReviewFindings([finding],ctx) : [];
    result.findings.push(...findings);
    const conclusion = findings[0]?.conclusion;
    const outcome = !conclusion ? 'pass' : conclusion === 'error' || conclusion === 'conflict' ? 'issue' : conclusion;
    result.coverage.push(reviewCoverage(ctx,checkId,'financial',outcome,reason,
      uniqueEvidence([...references(o),...support].filter(ref => validateReviewEvidence(ref,ctx).length === 0)),findings));
  };
  const disclosures = input.observations.filter(o => o.source_kind === 'disclosure');
  if (!disclosures.length) result.coverage.push(reviewCoverage(ctx,'financial:source-mapping','financial','uncovered',
    '尚无带主体、期间、口径和原文锚点的募集书财务观察，不能将未抽取视作无差异。',[]));
  for (const o of disclosures) {
    const key = `compare:${o.observation_id}`;
    const problems = validation.get(o.observation_id)!;
    if (problems.length) { emit(key,o,candidate(ctx,o,key,'needs_evidence','财务披露依据待核对','原文、数值或上下文证据不完整，暂不判断金额错误。',[],problems),[],problems.join('；')); continue; }
    const candidates = input.observations.filter(a => ['audit','financial_statement'].includes(a.source_kind) && a.metric === o.metric);
    const matches = candidates.filter(a => contextIdentity(a) === contextIdentity(o));
    if (!matches.length) {
      if (input.calculations.some(calculation => calculation.result_id === o.observation_id)) continue;
      const contextMismatch = candidates.filter(a => a.entity_id === o.entity_id);
      const conclusion = contextMismatch.length ? 'manual' : 'needs_evidence';
      emit(key,o,candidate(ctx,o,key,conclusion,contextMismatch.length ? '财务口径或期间不可直接比较' : '缺少相同财务事项的证据',
        '未找到主体、期间、口径、币种及会计基础一致的来源；不同截止日须先提供桥接，不直接判金额错误。',[]),[], '无完全匹配的可比财务证据。'); continue;
    }
    const support = uniqueEvidence(matches.flatMap(references));
    const sourceProblems = matches.flatMap(a => validation.get(a.observation_id)!);
    if (sourceProblems.length) { emit(key,o,candidate(ctx,o,key,'needs_evidence','财务来源待核对','存在解析、OCR 或来源上下文限制，不能直接定性。',support,sourceProblems),support,'来源尚不支持确定性比较。'); continue; }
    let values: Rational[];
    try { values = matches.map(a => converted(a,o.unit)); }
    catch { emit(key,o,candidate(ctx,o,key,'manual','金额单位不可可靠换算','仅支持有明确单位的同币种换算，不推测汇率或金额单位。',support),support,'单位转换缺少依据。'); continue; }
    if (values.some(value => !equal(value,values[0]!))) {
      emit(key,o,candidate(ctx,o,key,'conflict','财务来源互相冲突','同一主体、期间及口径存在不同来源值，保留全部来源，不自动挑选一个作为正确值。',support),support,'可比来源不一致。'); continue;
    }
    if (roundedEqual(values[0]!,o)) { emit(key,o,null,support,'仅本项数值在同一上下文、单位转换和披露精度下相符。'); continue; }
    const expected = display(values[0]!,precision(o),false);
    const finding = candidate(ctx,o,key,'error','募集书金额与财务证据不符',`相同主体、期间、口径和币种下，募集书披露 ${o.value} ${o.unit}，来源换算及舍入结果为 ${expected} ${o.unit}。`,support);
    finding.suggested_change = expected; finding.can_revise = true;
    finding.calculation = { expression:'source × unit conversion',operands:matches.map(a => a.observation_id),expected,observed:o.value,unit:o.unit,rounding:`末端按披露精度保留 ${precision(o)} 位小数，四舍五入。` };
    emit(key,o,finding,support,'本项金额差异经精确数值复算确认。');
  }
  for (const calculation of input.calculations) {
    const key = `calculation:${calculation.calculation_id}`;
    const observed = byId.get(calculation.result_id);
    const operands = calculation.operand_ids.map(id => byId.get(id));
    if (!observed || observed.source_kind !== 'disclosure' || !operands.length || operands.some(o => !o)) {
      result.coverage.push(reviewCoverage(ctx,key,'financial','uncovered','公式引用的披露结果或操作数不存在。',[])); continue;
    }
    const sources = operands as ReviewFinancialObservation[];
    const support = uniqueEvidence(sources.flatMap(references));
    const problems = [...validation.get(observed.observation_id)!, ...sources.flatMap(o => validation.get(o.observation_id)!)];
    if (new Set(calculation.operand_ids).size !== calculation.operand_ids.length || calculation.operand_ids.includes(calculation.result_id)) problems.push('formula_duplicate_or_self_reference');
    const sameContext = sources.every(o => o.entity_id === observed.entity_id && o.accounting_scope === observed.accounting_scope && o.basis === observed.basis
      && (calculation.operation === 'growth_percent' || canonical(o.period) === canonical(observed.period)))
      && sources.every(o => o.currency === sources[0]!.currency)
      && (calculation.operation !== 'sum' || sources.every(o => o.currency === observed.currency));
    if (!sameContext) problems.push('formula_context_mismatch');
    if (calculation.operation === 'sum' && !calculation.complete_terms) problems.push('formula_sum_inventory_incomplete');
    if (calculation.operation !== 'sum' && sources.length !== 2) problems.push('formula_operand_count_invalid');
    if (calculation.operation === 'growth_percent' && sources.length === 2) {
      if (canonical(sources[0]!.period) !== canonical(observed.period) || sources[0]!.metric !== sources[1]!.metric
        || !(sources[1]!.period.end ?? sources[1]!.period.as_of) || !(sources[0]!.period.end ?? sources[0]!.period.as_of)
        || (sources[1]!.period.end ?? sources[1]!.period.as_of)! >= (sources[0]!.period.end ?? sources[0]!.period.as_of)!) problems.push('formula_growth_periods_invalid');
      const [current, previous] = sources.map(o => o.period);
      if (!!current!.as_of !== !!previous!.as_of || !!current!.start !== !!previous!.start
        || current!.start && (current!.start.slice(5) !== previous!.start?.slice(5) || current!.end?.slice(5) !== previous!.end?.slice(5))) problems.push('formula_growth_period_lengths_differ');
    }
    if (problems.length) { emit(key,observed,candidate(ctx,observed,key,'needs_evidence','财务公式暂不可复算','公式的主体、期间、口径、完整行或来源不满足可比要求。',support,problems),support,problems.join('；')); continue; }
    let computed: Rational;
    try {
      if (calculation.operation === 'sum') computed = sources.reduce((sum,o) => add(sum,converted(o,observed.unit)),decimal('0'));
      else if (calculation.operation === 'percentage_point') {
        if (sources.some(o => unit(o.unit) !== '%') || unit(observed.unit) !== '百分点') throw new Error('formula_percentage_point_units');
        computed = subtract(decimal(sources[0]!.value),decimal(sources[1]!.value));
      } else {
        if (unit(observed.unit) !== '%') throw new Error('formula_percent_unit_required');
        const first = converted(sources[0]!,sources[1]!.unit), second = decimal(sources[1]!.value);
        if (second.numerator <= 0n) throw new Error('formula_nonpositive_denominator_requires_judgement');
        computed = scale(divide(calculation.operation === 'ratio_percent' ? first : subtract(first,second),second),100n);
      }
    } catch (error) { emit(key,observed,candidate(ctx,observed,key,'manual','公式定义或分母需人工判断','零或负分母、未知单位及不支持的公式口径不强行计算百分比。',support,[String((error as Error).message)]),support,'公式口径暂不可自动适用。'); continue; }
    if (roundedEqual(computed,observed)) { emit(key,observed,null,support,'仅本公式在所给完整操作数及披露精度下复算一致。'); continue; }
    const expected = display(computed,precision(observed),false);
    const finding = candidate(ctx,observed,key,'error','财务公式计算不一致',`${calculation.label}：披露 ${observed.value} ${observed.unit}，确定性复算为 ${expected} ${observed.unit}。`,support);
    finding.suggested_change = expected; finding.can_revise = true;
    finding.calculation = { expression:calculation.operation,operands:calculation.operand_ids,expected,observed:observed.value,unit:observed.unit,rounding:`最终结果保留 ${precision(observed)} 位小数。` };
    emit(key,observed,finding,support,'公式差异经精确数值复算确认。');
  }
  // Each finding may have several locations; merge only identical semantic keys produced above.
  result.findings = [...new Map(result.findings.map(f => [f.finding_id,f])).values()];
  result.limitations = [...new Set(result.findings.flatMap(f => f.limitations))];
  return result;
}
