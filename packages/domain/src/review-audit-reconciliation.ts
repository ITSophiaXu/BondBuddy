import type { ReviewEvidenceRef, ReviewFinding } from '../../contracts/dist/review-results.js';
import { AUDIT_RECONCILIATION_KNOWLEDGE } from './audit-reconciliation-knowledge.js';
import { type ReviewFinancialObservation, validateReviewFinancialObservation } from './review-financial-checks.js';
import { canonical, evidenceKey, referenceFor, uniqueEvidence, validateReviewEvidence, type ReviewEvidenceContext } from './review-evidence.js';
import { normalizeReviewFindings, reviewCoverage, type ReviewEvaluation, type ReviewFindingCandidate } from './review-finding-normalization.js';
import { add, subtract, scale, convert, decimal, display, equal, type Rational } from './update-arithmetic.js';

type Rule = typeof AUDIT_RECONCILIATION_KNOWLEDGE.rules[number];
type Term = NonNullable<Rule['terms']>[number];
const pack = AUDIT_RECONCILIATION_KNOWLEDGE;
const unitAliases: Record<string, string> = { yuan:'元', thousand_yuan:'千元', ten_thousand:'万元', ten_thousand_yuan:'万元', hundred_million_yuan:'亿元' };
const moneyUnits = new Set(['元','千元','万元','亿元']);
const unit = (value: string) => unitAliases[value] ?? value;
const refs = (o: ReviewFinancialObservation) => uniqueEvidence([...o.value_refs,...Object.values(o.context_refs).flat()]);
const sourcePin = (ref: Pick<ReviewEvidenceRef,'material_id'|'material_version'|'material_sha256'|'parse_snapshot_id'|'parse_response_sha256'>) => canonical([ref.material_id,ref.material_version,ref.material_sha256,ref.parse_snapshot_id,ref.parse_response_sha256]);
const context = (o: ReviewFinancialObservation) => canonical([o.entity_id,o.currency,o.accounting_scope,o.basis]);
const places = (o: ReviewFinancialObservation) => o.value_literal.replace(/[％%）)]$/,'').split('.')[1]?.length ?? 0;
const absolute = (n: Rational): Rational => ({ numerator:n.numerator < 0n ? -n.numerator : n.numerator,denominator:n.denominator });
const atMost = (a: Rational,b: Rational) => a.numerator*b.denominator <= b.numerator*a.denominator;
const converted = (o: ReviewFinancialObservation,to: string) => convert(decimal(o.value),unit(o.unit),unit(to));
const labels = (metric: string,aliases: readonly string[] = []) => [metric,...aliases];
const knownLabels = [...new Set(pack.rules.flatMap(rule => [...labels(rule.result_metric,rule.result_aliases),
  ...(rule.terms ?? []).flatMap(term => labels(term.metric,term.aliases))]))].sort((a,b) => b.length-a.length);
const labelCharacter = (value: string) => /[\p{L}\p{N}_]/u.test(value);
const matchesMetric = (o: ReviewFinancialObservation,metric: string,aliases?: readonly string[]) => labels(metric,aliases).includes(o.metric);
const consolidated = (scope: string) => ['consolidated','合并','合并报表'].includes(scope);
const unresolvedContext = (value: string) => typeof value !== 'string' || ['unknown','未知','不详','未提供','未确认','unspecified','undefined','null','n/a','na']
  .includes(value.trim().toLowerCase());
interface TableCell { table:string;row:number;column:number }
function tableCell(ref: Pick<ReviewEvidenceRef,'locator_type'|'locator'>): TableCell | null {
  if (ref.locator_type === 'csv_cell') return {table:'csv',row:Number(ref.locator.row),column:Number(ref.locator.column)};
  if (ref.locator_type === 'xlsx_cell') {
    const cell=/^([A-Z]+)(\d+)$/.exec(String(ref.locator.cell));
    if (!cell) return null;
    return {table:`xlsx:${String(ref.locator.sheet)}`,row:Number(cell[2]),column:[...cell[1]!].reduce((n,c) => n*26+c.charCodeAt(0)-64,0)};
  }
  if (ref.locator_type !== 'docx_block' || !Array.isArray(ref.locator.path)) return null;
  const path=ref.locator.path as Record<string,unknown>[];
  let rowIndex=-1;
  path.forEach((part,i) => {if (typeof part.row === 'number') rowIndex=i;});
  if (rowIndex < 0) return null;
  const column=path.slice(rowIndex).find(part => typeof part.column === 'number')?.column;
  const part=path[rowIndex]!;
  if (typeof column !== 'number' || !path.slice(0,rowIndex+1).some(p => typeof p.table === 'number')) return null;
  const hierarchy=path.slice(0,rowIndex+1).map((p,i) => i===rowIndex ? Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'row' && key !== 'column')) : p);
  return {table:`docx:${canonical(hierarchy)}`,row:Number(part.row),column};
}
function namesIn(quote: string): {start:number;end:number;label:string}[] {
  const names: {start:number;end:number;label:string}[]=[];
  for (let i=0;i<quote.length;i++) {
    const label=knownLabels.find(label => quote.startsWith(label,i)
      && !labelCharacter(quote[i-1] ?? '') && !labelCharacter(quote[i+label.length] ?? ''));
    if (label) {names.push({start:i,end:i+label.length,label});i += label.length-1;}
  }
  return names;
}
function tablePeriodBound(o: ReviewFinancialObservation,value: ReviewEvidenceRef,cell: TableCell,ctx: ReviewEvidenceContext): boolean {
  const dateIn=(quote: string,date: string) => {
    const [year,month,day]=date.split('-');
    return [date,`${year}年${Number(month)}月${Number(day)}日`,`${year}年${month}月${day}日`,`${year}.${month}.${day}`,`${year}/${month}/${day}`].some(text => quote.includes(text));
  };
  return o.context_refs.period.some(ref => {
    const header=tableCell(ref);
    if (!header || header.table !== cell.table || header.column !== cell.column || header.row > cell.row
      || sourcePin(ref) !== sourcePin(value) || ref.uncertainty.length || validateReviewEvidence(ref,ctx).length) return false;
    if (o.period.as_of) return dateIn(ref.quote,o.period.as_of);
    if (!o.period.start || !o.period.end) return false;
    return dateIn(ref.quote,o.period.start) && dateIn(ref.quote,o.period.end)
      || o.period.start.slice(5) === '01-01' && o.period.end === `${o.period.start.slice(0,4)}-12-31`
        && ref.quote.includes(`${o.period.start.slice(0,4)}年度`);
  });
}

/** Bind the metric and numeral to the same trusted row, respecting longer labels and numeral boundaries. */
function metricInValueSource(o: ReviewFinancialObservation,metric: string,aliases: readonly string[] | undefined,ctx: ReviewEvidenceContext): ReviewEvidenceRef[] | null {
  const accepted = new Set(labels(metric,aliases));
  const inline=o.value_refs.some(ref => {
    if (validateReviewEvidence(ref,ctx,o.source_kind === 'disclosure').length) return false;
    const record = ctx.records.find(record => evidenceKey(record) === evidenceKey(ref));
    if (!record || !o.value_literal) return false;
    const names=namesIn(ref.quote);
    for (let quoteStart=record.literal_quote.indexOf(ref.quote);quoteStart >= 0;quoteStart=record.literal_quote.indexOf(ref.quote,quoteStart+1)) {
      for (let start=ref.quote.indexOf(o.value_literal);start >= 0;start=ref.quote.indexOf(o.value_literal,start+1)) {
        const absoluteStart=quoteStart+start;
        if (/[\d,.+\-（(]/.test(record.literal_quote[absoluteStart-1] ?? '')
          || /[\d,.%％)）]/.test(record.literal_quote[absoluteStart+o.value_literal.length] ?? '')) continue;
        const preceding = names.filter(name => name.end <= start).at(-1);
        if (preceding && accepted.has(preceding.label)) return true;
      }
    }
    return false;
  });
  if (inline) return [];
  for (const value of o.value_refs) {
    const cell=tableCell(value);
    if (!cell || validateReviewEvidence(value,ctx,o.source_kind === 'disclosure').length || !tablePeriodBound(o,value,cell,ctx)) continue;
    const candidates=ctx.records.flatMap(record => {
      const address=tableCell(record);
      if (!address || address.table !== cell.table || address.row !== cell.row || address.column >= cell.column
        || sourcePin(record) !== sourcePin(value) || record.owner_user_id !== ctx.owner_user_id || record.project_id !== ctx.project_id) return [];
      const names=namesIn(record.literal_quote);
      return names.length ? [{record,column:address.column,names}] : [];
    }).sort((a,b) => b.column-a.column);
    const closest=candidates[0];
    if (!closest || candidates.filter(c => c.column === closest.column).length !== 1
      || closest.names.length !== 1 || !accepted.has(closest.names[0]!.label)) continue;
    const labelRef=referenceFor(closest.record);
    if (labelRef.uncertainty.length || validateReviewEvidence(labelRef,ctx,o.source_kind === 'disclosure').length) continue;
    return [labelRef];
  }
  return null;
}

function previousDay(value: string): string {
  const d = new Date(`${value}T00:00:00.000Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);
}
function periodMatches(o: ReviewFinancialObservation,observed: ReviewFinancialObservation,term: Term,rule: Rule,all: readonly ReviewFinancialObservation[]): boolean {
  if ((term.period_role ?? 'same') === 'same') return canonical(o.period) === canonical(observed.period);
  if (rule.source_item !== 27 || !observed.period.as_of || observed.period.start || observed.period.end) return false;
  if (term.period_role === 'flow') return !o.period.as_of && !!o.period.start && o.period.end === observed.period.as_of;
  const flowTerm = rule.terms?.find(t => t.period_role === 'flow');
  if (!flowTerm) return false;
  const flow = all.filter(a => matchesMetric(a,flowTerm.metric,flowTerm.aliases) && context(a) === context(observed)
    && !a.period.as_of && !!a.period.start && a.period.end === observed.period.as_of
    && refs(a).length > 0 && refs(o).length > 0 && refs(a).every(ref => sourcePin(ref) === sourcePin(o.value_refs[0]!)));
  return flow.length === 1 && o.period.start === null && o.period.end === null && !!o.period.as_of
    && o.period.as_of === previousDay(flow[0]!.period.start!);
}

/** Fixed internal identities only; this pack cannot supply missing facts or released regulatory references. */
export function reviewAuditReconciliation(observations: readonly ReviewFinancialObservation[],ctx: ReviewEvidenceContext,selectedRuleIds?:readonly string[],targetObservationIds?:readonly string[]): ReviewEvaluation {
  if (observations.length > 10000) throw new Error('REVIEW_AUDIT_RECONCILIATION_INPUT_LIMIT');
  if (new Set(observations.map(o => o.observation_id)).size !== observations.length) throw new Error('REVIEW_AUDIT_RECONCILIATION_DUPLICATE_ID');
  const metadata = `internal_method:${pack.version}; source:${pack.source_name}; sha256:${pack.source_sha256}`;
  const result: ReviewEvaluation = {findings:[],coverage:[],limitations:[metadata]};
  const expectations: {rule:Rule;observed:ReviewFinancialObservation;expected:Rational;tolerance:Rational;sources:ReviewFinancialObservation[];support:ReviewEvidenceRef[]}[]=[];
  const labelEvidence=new Map<string,ReviewEvidenceRef[]>();
  const validation = new Map(observations.map(o => [o.observation_id,[...validateReviewFinancialObservation(o,ctx),
    ...([o.entity_id,o.accounting_scope,o.basis,o.currency].some(unresolvedContext) ? ['audit_context_unresolved'] : [])]]));
  const disclosure = observations.filter(o => o.source_kind === 'disclosure' && (!targetObservationIds || targetObservationIds.includes(o.observation_id)));
  const emit = (rule: Rule,observed: ReviewFinancialObservation,finding: ReviewFindingCandidate | null,support: ReviewEvidenceRef[],reason: string) => {
    const findings = finding ? normalizeReviewFindings([finding],ctx) : [];
    result.findings.push(...findings);
    const conclusion=findings[0]?.conclusion;
    result.coverage.push(reviewCoverage(ctx,`audit-reconciliation:${rule.id}:${observed.observation_id}`,'financial',
      !conclusion ? 'pass' : conclusion === 'error' || conclusion === 'conflict' ? 'issue' : conclusion,reason,
      uniqueEvidence([...refs(observed),...support].filter(ref => !validateReviewEvidence(ref,ctx).length)),findings));
  };
  const finding = (rule: Rule,o: ReviewFinancialObservation,conclusion: ReviewFinding['conclusion'],description: string,support: ReviewEvidenceRef[],limitations: string[] = []): ReviewFindingCandidate => ({
    stable_key:`audit-reconciliation:${rule.id}:${o.observation_id}`,dimension:'financial',conclusion,severity:conclusion === 'error' ? 'P1' : 'P2',
    title:`${rule.title}：${conclusion === 'error' ? '勾稽不一致' : '勾稽待核对'}`,description,target_refs:o.value_refs,evidence_refs:support,limitations,verification:'deterministic',
  });
  if (selectedRuleIds && (new Set(selectedRuleIds).size !== selectedRuleIds.length || selectedRuleIds.some(id => !pack.rules.some(rule => rule.id === id)))) throw new Error('REVIEW_AUDIT_RECONCILIATION_RULE_SELECTION_INVALID');
  for (const rule of pack.rules.filter(rule => !selectedRuleIds || selectedRuleIds.includes(rule.id))) {
    const results = disclosure.filter(o => matchesMetric(o,rule.result_metric,rule.result_aliases));
    if (!results.length) {
      result.coverage.push(reviewCoverage(ctx,`audit-reconciliation:${rule.id}`,'financial','uncovered',
        `未抽取本项披露结果，不能将未检查视作通过。${rule.title}；条件：${rule.conditions.join('；')}；限制：${rule.caveat}`,[]));continue;
    }
    for (const observed of results) {
      const problems=[...validation.get(observed.observation_id)!];
      const resultLabels=metricInValueSource(observed,rule.result_metric,rule.result_aliases,ctx);
      if (resultLabels === null) problems.push('audit_result_metric_not_in_value_source');
      else labelEvidence.set(observed.observation_id,resultLabels);
      if (new Set(refs(observed).map(sourcePin)).size !== 1) problems.push('audit_result_snapshot_mixed');
      if (problems.length) {
        emit(rule,observed,finding(rule,observed,'needs_evidence','披露科目、数值或上下文缺少可信原文依据，不能据模型科目名套用公式。',[],problems),[],problems.join('；'));continue;
      }
      if (rule.category !== 'deterministic' || rule.applicability === 'consolidated' && !consolidated(observed.accounting_scope)) {
        const reason=`须人工核对适用性及完整项目。条件：${rule.conditions.join('；')}；限制：${rule.caveat}`;
        emit(rule,observed,finding(rule,observed,'manual',reason,refs(observed),['internal_method_requires_applicability_review']),refs(observed),reason);continue;
      }
      const sources: ReviewFinancialObservation[]=[];
      const sets=(rule.terms ?? []).map(term => observations.filter(o => o.observation_id !== observed.observation_id && matchesMetric(o,term.metric,term.aliases)
        && context(o) === context(observed) && periodMatches(o,observed,term,rule,observations)));
      const independentSets=sets.map(set => set.filter(o => ['audit','financial_statement'].includes(o.source_kind)));
      const inventories=new Map<string,ReviewFinancialObservation[][]>();
      independentSets.forEach((set,i) => set.forEach(o => {
        const pins=[...new Set(refs(o).map(sourcePin))];
        if (pins.length !== 1) return;
        const inventory=inventories.get(pins[0]!) ?? independentSets.map(() => []);
        inventory[i]!.push(o);inventories.set(pins[0]!,inventory);
      }));
      const complete=[...inventories.entries()].filter(([,inventory]) => inventory.length > 0 && inventory.every(set => set.length === 1))
        .sort(([a],[b]) => a.localeCompare(b));
      const selected=complete[0]?.[1];
      const available=selected ?? sets.map(set => {
        const disclosed=set.filter(o => o.source_kind === 'disclosure');
        return disclosed.length ? disclosed : set;
      });
      for (const [i,term] of (rule.terms ?? []).entries()) {
        const matches=available[i]!;
        if (matches.length !== 1) {
          problems.push(matches.length ? `audit_operand_duplicate_or_conflict:${term.metric}` : `audit_operand_missing:${term.metric}`);
          sources.push(...matches);continue;
        }
        const source=matches[0]!;sources.push(source);
        problems.push(...validation.get(source.observation_id)!);
        const sourceLabels=metricInValueSource(source,term.metric,term.aliases,ctx);
        if (sourceLabels === null) problems.push(`audit_operand_metric_not_in_value_source:${term.metric}`);
        else labelEvidence.set(source.observation_id,sourceLabels);
      }
      if (!rule.terms?.length || sources.length !== rule.terms.length) problems.push('audit_formula_inventory_incomplete');
      if (new Set(sources.map(o => o.observation_id)).size !== sources.length) problems.push('audit_formula_duplicate_operand');
      const pins=new Set(sources.flatMap(o => refs(o).map(sourcePin)));
      const independent=sources.length > 0 && sources.every(o => ['audit','financial_statement'].includes(o.source_kind));
      const disclosureInventory=sources.length > 0 && sources.every(o => o.source_kind === 'disclosure')
        && pins.size === 1 && pins.has(sourcePin(observed.value_refs[0]!));
      if (pins.size !== 1 || !independent && !disclosureInventory) problems.push('audit_formula_source_inventory_mixed');
      if (sources.some(o => !moneyUnits.has(unit(o.unit))) || !moneyUnits.has(unit(observed.unit))) problems.push('audit_formula_money_unit_unsupported');
      const competing=independentSets.flat().filter(o => !sources.some(source => source.observation_id === o.observation_id));
      const sourceResults=observations.filter(o => ['audit','financial_statement'].includes(o.source_kind)
        && matchesMetric(o,rule.result_metric,rule.result_aliases) && context(o) === context(observed) && canonical(o.period) === canonical(observed.period));
      for (const o of [...competing,...sourceResults]) {
        problems.push(...validation.get(o.observation_id)!);
        if (new Set(refs(o).map(sourcePin)).size !== 1) problems.push('audit_competing_source_snapshot_mixed');
        const term=rule.terms?.find(term => matchesMetric(o,term.metric,term.aliases));
        const isResult=sourceResults.some(result => result.observation_id === o.observation_id);
        const metricLabels=metricInValueSource(o,isResult ? rule.result_metric : term!.metric,isResult ? rule.result_aliases : term!.aliases,ctx);
        if (metricLabels === null) problems.push('audit_competing_source_metric_not_in_value_source');else labelEvidence.set(o.observation_id,metricLabels);
        if (!moneyUnits.has(unit(o.unit))) problems.push('audit_formula_money_unit_unsupported');
      }
      const support=uniqueEvidence([...[...sources,...competing,...sourceResults].flatMap(o => [...refs(o),...(labelEvidence.get(o.observation_id) ?? [])]),...(labelEvidence.get(observed.observation_id) ?? [])]);
      if (problems.length) {
        emit(rule,observed,finding(rule,observed,'needs_evidence',`固定公式缺少同主体、币种、口径、会计基础、期间及单一材料快照的完整操作数。条件：${rule.conditions.join('；')}；限制：${rule.caveat}`,support,[...new Set(problems)]),support,[...new Set(problems)].join('；'));continue;
      }
      const contra=[9,10,12,13,14,15,25].includes(rule.source_item) && sources.some((o,i) => rule.terms![i]!.coefficient === -1 && decimal(o.value).numerator < 0n);
      if (contra) {
        const reason=`减值、累计折旧/摊销、坏账或流出金额采用负数展示，须先确认正负号列报约定再套用减法。条件：${rule.conditions.join('；')}；限制：${rule.caveat}`;
        emit(rule,observed,finding(rule,observed,'manual',reason,support,['audit_contra_account_sign_convention_unresolved']),support,reason);continue;
      }
      let expected=decimal('0'),tolerance: Rational={numerator:1n,denominator:2n*10n**BigInt(places(observed))};
      for (const [i,source] of sources.entries()) {
        expected=add(expected,scale(converted(source,observed.unit),BigInt(rule.terms![i]!.coefficient)));
        tolerance=add(tolerance,convert({numerator:1n,denominator:2n*10n**BigInt(places(source))},unit(source.unit),unit(observed.unit)));
      }
      if (independent) expectations.push({rule,observed,expected,tolerance,sources,support});
      const conflicts=competing.filter(o => {
        const i=rule.terms!.findIndex(term => matchesMetric(o,term.metric,term.aliases));
        return i >= 0 && !equal(converted(o,observed.unit),converted(sources[i]!,observed.unit));
      });
      const sourceResultDifference=sourceResults.filter(o => !equal(converted(o,observed.unit),expected));
      if (conflicts.length || sourceResultDifference.length) {
        const ambiguous=!conflicts.length && sourceResultDifference.every(o => atMost(absolute(subtract(converted(o,observed.unit),expected)),
          add(subtract(tolerance,{numerator:1n,denominator:2n*10n**BigInt(places(observed))}),
            convert({numerator:1n,denominator:2n*10n**BigInt(places(o))},unit(o.unit),unit(observed.unit)))));
        const reason=conflicts.length ? '同期间、同口径的独立财务来源对公式操作数存在不同数值，不能任意选取一个来源。'
          : ambiguous ? '审计/报表结果与固定公式显示值的差异可能由累计舍入造成，须核对未舍入金额。'
            : '审计/报表本身的明确结果与固定公式操作数不一致，不能以勾稽复算结果覆盖已披露审计事实。';
        const item=finding(rule,observed,ambiguous ? 'manual' : 'conflict',reason,support,[ambiguous ? 'audit_source_rounding_ambiguous' : 'audit_independent_financial_sources_conflict']);
        item.calculation={expression:`audit-reconciliation:${pack.version}:${rule.id}`,operands:sources.map(o => o.observation_id),expected:display(expected,places(observed),false),observed:observed.value,unit:observed.unit,rounding:'精确复算保留披露精度；独立财务来源存在争议，结果不能作为自动修订金额。'};
        emit(rule,observed,item,support,reason);continue;
      }
      if (equal(expected,decimal(observed.value))) {
        emit(rule,observed,null,support,'固定勾稽式仅在所列同一材料快照的完整操作数和源显示精度下相符。');continue;
      }
      const chain=sources.map((source,i) => `${rule.terms![i]!.coefficient === 1 ? '+' : '-'}${source.observation_id}`).join(' ');
      const calculated=display(expected,places(observed),false);
      const rounding=`全程精确有理数计算，最终保留 ${places(observed)} 位小数；考虑每个操作数及结果各半个最小显示单位的累计舍入范围。签名链：${chain}`;
      const roundingAmbiguous=atMost(absolute(subtract(expected,decimal(observed.value))),tolerance);
      const conclusion=roundingAmbiguous || !independent ? 'manual' : 'error';
      const description=roundingAmbiguous ? `显示值差异可能落在源金额累计舍入范围内，须核对未舍入数值，不直接判金额错误。${chain}`
        : !independent ? `同一披露材料的显示值按固定公式为 ${calculated} ${observed.unit}，与披露 ${observed.value} ${observed.unit} 不一致；须核对独立审计/报表证据再修订。${chain}`
        : `披露 ${observed.value} ${observed.unit}，同一审计/报表快照的完整操作数按固定公式复算为 ${calculated} ${observed.unit}，差异超过累计显示舍入范围。${chain}`;
      const item=finding(rule,observed,conclusion,description,support,roundingAmbiguous ? ['audit_source_rounding_ambiguous'] : !independent ? ['audit_independent_financial_inventory_required'] : []);
      item.calculation={expression:`audit-reconciliation:${pack.version}:${rule.id}`,operands:sources.map(o => o.observation_id),expected:calculated,observed:observed.value,unit:observed.unit,rounding};
      if (conclusion === 'error') { item.suggested_change=calculated;item.can_revise=true; }
      emit(rule,observed,item,support,roundingAmbiguous ? '源显示舍入限制需人工核对。' : independent ? '本项差异经固定公式和可信完整操作数确认。' : '披露内部勾稽差异尚需独立财务证据。');
    }
  }
  // One disclosed fact cannot be repaired to competing independently supported amounts.
  // Include formulas that initially passed: a pass must not hide a contradicting identity.
  const byResult=new Map<string,typeof expectations>();
  for (const expectation of expectations) {
    const group=byResult.get(expectation.observed.observation_id) ?? [];
    group.push(expectation);byResult.set(expectation.observed.observation_id,group);
  }
  for (const group of byResult.values()) {
    if (group.length < 2 || group.every(item => equal(item.expected,group[0]!.expected))) continue;
    const observed=group[0]!.observed;
    const resultHalf:Rational={numerator:1n,denominator:2n*10n**BigInt(places(observed))};
    const ambiguous=group.every((left,i) => group.slice(i+1).every(right => atMost(absolute(subtract(left.expected,right.expected)),
      add(subtract(left.tolerance,resultHalf),subtract(right.tolerance,resultHalf)))));
    const conclusion=ambiguous ? 'manual' : 'conflict';
    const sharedSupport=uniqueEvidence(group.flatMap(item => item.support));
    const chains=group.map(item => `${item.rule.id}: ${item.sources.map((source,i) => `${item.rule.terms![i]!.coefficient === 1 ? '+' : '-'}${source.observation_id}`).join(' ')} = ${display(item.expected,places(observed),false)} ${observed.unit}`).join('；');
    const reason=ambiguous ? '同一披露结果的独立固定勾稽式存在不同复算值，差异可能受源显示舍入影响，须人工核对；本项不保留通过或自动修订结论。'
      : '同一披露结果的独立固定勾稽式支持不同金额，不能任意选取一个公式修订；须核对来源及口径，所有相关检查均保留来源冲突。';
    for (const item of group) {
      const checkId=`audit-reconciliation:${item.rule.id}:${observed.observation_id}`;
      const previous=result.coverage.find(check => check.check_id === checkId)!;
      const oldIds=new Set(previous.finding_ids);
      result.findings=result.findings.filter(item => !oldIds.has(item.finding_id));
      const candidate=finding(item.rule,observed,conclusion,`${reason}计算链：${chains}`,sharedSupport,
        [ambiguous ? 'audit_cross_rule_rounding_ambiguous' : 'audit_cross_rule_expectations_conflict']);
      candidate.calculation={expression:`audit-reconciliation:${pack.version}:${item.rule.id}`,operands:item.sources.map(o => o.observation_id),
        expected:display(item.expected,places(observed),false),observed:observed.value,unit:observed.unit,
        rounding:'各公式全程精确有理数计算，比较使用未舍入金额；显示差异考虑每项操作数半个最小显示单位的累计舍入范围。跨公式金额未统一，不能自动修订。'};
      const normalized=normalizeReviewFindings([candidate],ctx);
      result.findings.push(...normalized);
      result.coverage[result.coverage.indexOf(previous)]=reviewCoverage(ctx,checkId,'financial',ambiguous ? 'manual' : 'issue',reason,
        uniqueEvidence([...refs(observed),...sharedSupport].filter(ref => !validateReviewEvidence(ref,ctx).length)),normalized);
    }
  }
  result.findings=[...new Map(result.findings.map(f => [f.finding_id,f])).values()];
  result.limitations=[...new Set([...result.limitations,...result.findings.flatMap(f => f.limitations)])];
  return result;
}
