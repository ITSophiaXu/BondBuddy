import type { ReviewCheckCoverage, ReviewFinding } from '../../contracts/dist/review-results.js';
import { canonical, evidenceKey, uniqueEvidence, validateReviewEvidence, type ReviewEvidenceContext } from './review-evidence.js';
import { validateReviewFinancialObservation, type ReviewFinancialObservation } from './review-financial-checks.js';
import { normalizeReviewFindings, type ReviewEvaluation } from './review-finding-normalization.js';
import { convert, decimal, equal, type Rational } from './update-arithmetic.js';

const aliases:Record<string,string>={yuan:'元',thousand_yuan:'千元',ten_thousand:'万元',ten_thousand_yuan:'万元',hundred_million_yuan:'亿元',percent:'%',percentage_point:'百分点'};
const originalAmount=(value:string,unit:string)=>({value:decimal(value),unit:aliases[unit]??unit});
function normalized(value:string,unit:string):{value:Rational;unit:string}{
  const name=aliases[unit]??unit;
  return ['元','千元','万元','亿元'].includes(name)?{value:convert(decimal(value),name,'元'),unit:'元'}:{value:decimal(value),unit:name};
}
function rationalKey(value:Rational):string{
  let a=value.numerator<0n?-value.numerator:value.numerator,b=value.denominator;
  while(b){const remainder=a%b;a=b;b=remainder;}
  return String(value.numerator/a)+'/'+String(value.denominator/a);
}
const destination=(ref:ReviewFinding['target_refs'][number],amount:{value:Rational;unit:string})=>
  canonical([evidenceKey(ref),amount.unit,rationalKey(amount.value)]);
const roundingReasons=new Set(['audit_source_rounding_ambiguous','audit_cross_rule_rounding_ambiguous']);
type Constraint={check:ReviewCheckCoverage;findings:ReviewFinding[];kind:'pass'|'conflict'|'rounding';observed:Rational};
type Block={reasons:Set<string>;related:Map<string,ReviewFinding>;checks:Map<string,ReviewCheckCoverage>};
const explanations:Record<string,string>={
  financial_repair_proposals_conflict:'不同检查对同一披露金额给出不同修订值。',
  financial_repair_blocked_by_verified_pass:'另有已验证检查支持当前披露金额，不能用其他复算值直接覆盖。',
  financial_repair_blocked_by_source_conflict:'同一目标仍有财务来源冲突，不能自动选取其中一个金额。',
  financial_repair_blocked_by_rounding:'同一目标存在累计显示舍入限制，尚不能确认显示差异需要修改。',
};

/**
 * Only trusted financial evaluator outputs belong here; merge model concerns afterwards.
 * checkTargets binds a check to its result observation, not to its supporting evidence/operands.
 * It is internal producer metadata, never read from the model or a persisted public report.
 * Records have no numeric-token offsets: repeated equal numerals/units in one record remain one
 * conservative destination, even if extracted metrics differ. This can withhold, never select, a repair.
 */
export function guardFinancialRepairConflicts(evaluation:ReviewEvaluation,ctx:ReviewEvidenceContext,
  checkTargets:ReadonlyMap<string,ReviewFinancialObservation>=new Map()):ReviewEvaluation{
  const groups=new Map<string,{finding:ReviewFinding;value:Rational}[]>();
  const byId=new Map(evaluation.findings.map(f=>[f.finding_id,f]));
  for(const finding of evaluation.findings){
    if(finding.dimension!=='financial'||finding.check_status!=='rechecked'||finding.origin_report_id!==ctx.report_id
      ||!finding.repairability.can_revise||!finding.suggested_change||!finding.calculation)continue;
    const proposed=normalized(finding.suggested_change,finding.calculation.unit);
    const observed=originalAmount(finding.calculation.observed,finding.calculation.unit);
    for(const ref of finding.target_refs){
      // Keep original numeral/unit identity: 1 万元 and 10000 元 in one record are separate destinations.
      const key=destination(ref,observed);
      const group=groups.get(key)??[];group.push({finding,value:proposed.value});groups.set(key,group);
    }
  }
  const constraints=new Map<string,Constraint[]>();
  const validTargets=new Map<ReviewFinancialObservation,boolean>();
  for(const check of evaluation.coverage){
    const target=checkTargets.get(check.check_id);
    if(!target||check.dimension!=='financial'||check.check_status!=='rechecked'||check.origin_report_id!==ctx.report_id
      ||target.source_kind!=='disclosure')continue;
    if(!validTargets.has(target))validTargets.set(target,!validateReviewFinancialObservation(target,ctx).length);
    if(!validTargets.get(target))continue;
    const findings=check.finding_ids.flatMap(id=>byId.get(id)?[byId.get(id)!]:[]);
    const kind=check.outcome==='pass'?'pass':findings.some(f=>f.conclusion==='conflict')?'conflict'
      :findings.some(f=>f.conclusion==='manual'&&f.limitations.some(reason=>roundingReasons.has(reason)))?'rounding':null;
    if(!kind)continue;
    const observed=normalized(target.value,target.unit);
    for(const ref of target.value_refs){
      if(!check.evidence_refs.some(evidence=>evidenceKey(evidence)===evidenceKey(ref))
        ||validateReviewEvidence(ref,ctx,true).length||validateReviewFinancialObservation({...target,value_refs:[ref]},ctx).length)continue;
      const key=destination(ref,originalAmount(target.value,target.unit)),items=constraints.get(key)??[];
      items.push({check,findings,kind,observed:observed.value});constraints.set(key,items);
    }
  }
  const blocked=new Map<string,Block>();
  const block=(finding:ReviewFinding,reason:string,related:ReviewFinding[],checks:ReviewCheckCoverage[]=[])=>{
    const item=blocked.get(finding.finding_id)??{reasons:new Set<string>(),related:new Map<string,ReviewFinding>(),checks:new Map<string,ReviewCheckCoverage>()};
    item.reasons.add(reason);
    for(const peer of [finding,...related])item.related.set(peer.finding_id,peer);
    for(const check of checks)item.checks.set(check.check_id,check);
    blocked.set(finding.finding_id,item);
  };
  for(const [key,group] of groups){
    if(group.some(item=>!equal(item.value,group[0]!.value))){
      for(const item of group)block(item.finding,'financial_repair_proposals_conflict',group.map(peer=>peer.finding));
    }
    for(const constraint of constraints.get(key)??[])for(const item of group){
      if(constraint.kind==='pass'&&equal(item.value,constraint.observed))continue;
      const reason=constraint.kind==='pass'?'financial_repair_blocked_by_verified_pass'
        :constraint.kind==='conflict'?'financial_repair_blocked_by_source_conflict':'financial_repair_blocked_by_rounding';
      block(item.finding,reason,constraint.findings,[constraint.check]);
    }
  }
  if(!blocked.size)return evaluation;
  const replacements=new Map<string,ReviewFinding>(),checkLinks=new Map<string,Set<string>>();
  const findings=evaluation.findings.map(finding=>{
    const item=blocked.get(finding.finding_id);if(!item)return finding;
    const roundingOnly=[...item.reasons].every(reason=>reason==='financial_repair_blocked_by_rounding');
    const related=[...item.related.values()],checks=[...item.checks.values()];
    const replacement=normalizeReviewFindings([{stable_key:'repair-conflict:'+finding.finding_id,dimension:'financial',
      conclusion:roundingOnly?'manual':'conflict',severity:finding.severity,
      title:roundingOnly?'同一财务金额的舍入限制尚待核对':'同一财务位置的检查结论互相冲突',
      description:[...item.reasons].map(reason=>explanations[reason]).join('')+' 相关计算：'+related.filter(f=>f.calculation)
        .map(f=>f.calculation!.expression+'：'+(f.suggested_change??f.calculation!.expected)+' '+f.calculation!.unit).join('；'),
      target_refs:finding.target_refs,evidence_refs:uniqueEvidence([...related.flatMap(f=>f.evidence_refs),...checks.flatMap(c=>c.evidence_refs)]),
      calculation:finding.calculation,limitations:[...finding.limitations,...item.reasons],verification:'deterministic'}],ctx)[0]!;
    replacements.set(finding.finding_id,replacement);
    for(const check of checks){const ids=checkLinks.get(check.check_id)??new Set<string>();ids.add(replacement.finding_id);checkLinks.set(check.check_id,ids);}
    return replacement;
  });
  const updatedById=new Map(findings.map(f=>[f.finding_id,f]));
  const coverage=evaluation.coverage.map(check=>{
    if(!check.finding_ids.some(id=>replacements.has(id))&&!checkLinks.has(check.check_id))return check;
    const ids=[...new Set([...check.finding_ids.map(id=>replacements.get(id)?.finding_id??id),...(checkLinks.get(check.check_id)??[])])];
    const affected=ids.flatMap(id=>updatedById.get(id)?[updatedById.get(id)!]:[]);
    const outcome=affected.some(f=>f.conclusion==='error'||f.conclusion==='conflict')?'issue' as const
      :affected.some(f=>f.conclusion==='manual')?'manual' as const:check.outcome;
    return {...check,outcome,reason:check.reason+' 同一目标存在其他已核检查的约束，修订建议已撤销；详见关联事项。',finding_ids:ids};
  });
  return {findings,coverage,limitations:[...new Set([...evaluation.limitations,...[...blocked.values()].flatMap(item=>[...item.reasons])])]};
}
