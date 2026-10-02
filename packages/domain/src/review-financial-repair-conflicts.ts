import type { ReviewFinding } from '../../contracts/dist/review-results.js';
import { canonical, evidenceKey, uniqueEvidence, type ReviewEvidenceContext } from './review-evidence.js';
import { normalizeReviewFindings, type ReviewEvaluation } from './review-finding-normalization.js';
import { convert, decimal, equal, type Rational } from './update-arithmetic.js';

const aliases:Record<string,string>={yuan:'元',thousand_yuan:'千元',ten_thousand:'万元',ten_thousand_yuan:'万元',hundred_million_yuan:'亿元'};
function normalized(value:string,unit:string):{value:Rational;unit:string}{
  const name=aliases[unit]??unit;
  return ['元','千元','万元','亿元'].includes(name)?{value:convert(decimal(value),name,'元'),unit:'元'}:{value:decimal(value),unit:name};
}
function rationalKey(value:Rational):string{
  let a=value.numerator<0n?-value.numerator:value.numerator,b=value.denominator;
  while(b){const remainder=a%b;a=b;b=remainder;}
  return `${value.numerator/a}/${value.denominator/a}`;
}

/** All financial evaluators share one repair destination. Conflicting proposals are never selectable. */
export function guardFinancialRepairConflicts(evaluation:ReviewEvaluation,ctx:ReviewEvidenceContext):ReviewEvaluation{
  const groups=new Map<string,{finding:ReviewFinding;value:Rational}[]>();
  for(const finding of evaluation.findings){
    if(finding.dimension!=='financial'||!finding.repairability.can_revise||!finding.suggested_change||!finding.calculation)continue;
    const proposed=normalized(finding.suggested_change,finding.calculation.unit);
    const observed=normalized(finding.calculation.observed,finding.calculation.unit);
    for(const ref of finding.target_refs){
      // Quotes may be different valid excerpts of the same trusted numeric destination.
      const key=canonical([evidenceKey(ref),observed.unit,rationalKey(observed.value)]);
      const group=groups.get(key)??[];group.push({finding,value:proposed.value});groups.set(key,group);
    }
  }
  const conflicts=new Map<string,ReviewFinding[]>();
  for(const group of groups.values()){
    if(!group.some(item=>!equal(item.value,group[0]!.value)))continue;
    for(const item of group)conflicts.set(item.finding.finding_id,[...new Map([...(conflicts.get(item.finding.finding_id)??[]),...group.map(i=>i.finding)].map(f=>[f.finding_id,f])).values()]);
  }
  if(!conflicts.size)return evaluation;
  const replacements=new Map<string,ReviewFinding>();
  const findings=evaluation.findings.map(finding=>{
    const related=conflicts.get(finding.finding_id);if(!related)return finding;
    const replacement=normalizeReviewFindings([{stable_key:`repair-conflict:${finding.finding_id}`,dimension:'financial',conclusion:'conflict',severity:finding.severity,
      title:'同一财务位置的修订建议互相冲突',description:`各检查对相同披露数值给出不同建议，须先核对来源与计算口径。${related.map(f=>`${f.calculation!.expression}：${f.suggested_change} ${f.calculation!.unit}`).join('；')}`,
      target_refs:finding.target_refs,evidence_refs:uniqueEvidence(related.flatMap(f=>f.evidence_refs)),calculation:finding.calculation,
      limitations:[...finding.limitations,'financial_repair_proposals_conflict'],verification:'deterministic'}],ctx)[0]!;
    replacements.set(finding.finding_id,replacement);return replacement;
  });
  const coverage=evaluation.coverage.map(check=>check.finding_ids.some(id=>replacements.has(id))?{...check,outcome:'issue' as const,
    reason:`${check.reason} 同一目标的建议金额存在冲突，不能自动修订。`,finding_ids:check.finding_ids.map(id=>replacements.get(id)?.finding_id??id)}:check);
  return {findings,coverage,limitations:[...new Set([...evaluation.limitations,'financial_repair_proposals_conflict'])]};
}
