import type { ReviewFinancialObservation } from './review-financial-checks.js';
import { evidenceKey, validateReviewEvidence, type ReviewEvidenceContext } from './review-evidence.js';

type Verification = Pick<ReviewFinancialObservation,'context_verification'|'context_limitations'>;
type Span = { start:number;end:number;text:string };
const unverified=(reason:string):Verification=>({context_verification:'unverified',context_limitations:[reason]});
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const alternatives=(values:readonly string[])=>values.map(escape).sort((a,b)=>b.length-a.length).join('|');
const scopes:Record<string,string[]>={
  合并:['合并口径','合并报表','合并'],consolidated:['合并口径','合并报表','合并'],
  母公司:['母公司口径','母公司报表','母公司'],parent:['母公司口径','母公司报表','母公司'],parent_only:['母公司口径','母公司报表','母公司'],
};
const bases:Record<string,string[]>={
  原始报表:['原始报表','原始口径','未重述'],original:['原始报表','原始口径','未重述'],
  重述:['重述报表','重述后','重述'],重述后:['重述报表','重述后','重述'],restated:['重述报表','重述后','重述'],
};
const currencies:Record<string,string[]>={CNY:['CNY','人民币','RMB'],USD:['USD','美元'],HKD:['HKD','港币']};
const units:Record<string,string[]>={元:['元'],yuan:['元'],千元:['千元'],thousand_yuan:['千元'],万元:['万元'],ten_thousand:['万元'],ten_thousand_yuan:['万元'],亿元:['亿元'],hundred_million_yuan:['亿元'],'%':['%','％'],percent:['%','％'],百分点:['百分点'],percentage_point:['百分点']};
function periodPattern(period:ReviewFinancialObservation['period']):string|null{
  const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
  const chinese=(s:string)=>{const [y,m,d]=s.split('-');return `${y}年${Number(m)}月${Number(d)}日`;};
  if(period.as_of&&date(period.as_of)&&!period.start&&!period.end){
    const [y,m,d]=period.as_of.split('-');const variants=[period.as_of,chinese(period.as_of)];
    if(Number(d)===new Date(Date.UTC(Number(y),Number(m),0)).getUTCDate())variants.push(`${y}年${Number(m)}月末`);
    if(m==='12'&&d==='31')variants.push(`${y}年末`);
    return alternatives(variants);
  }
  if(period.as_of||!period.start||!period.end||!date(period.start)||!date(period.end)||period.start>period.end)return null;
  const sep='\\s*(?:至|到|—|–|-|~|～)\\s*';
  const variants=[`${escape(period.start)}${sep}${escape(period.end)}`,`${escape(chinese(period.start))}${sep}${escape(chinese(period.end))}`];
  const [year,startMonth,startDay]=period.start.split('-'),[endYear,endMonth,endDay]=period.end.split('-');
  if(year===endYear&&startMonth==='01'&&startDay==='01'&&Number(endDay)===new Date(Date.UTC(Number(endYear),Number(endMonth),0)).getUTCDate()){
    variants.push(`${year}年1${sep}${Number(endMonth)}月`);
    if(endMonth==='12')variants.push(`${year}年度`);
    if(endMonth==='06')variants.push(`${year}年(?:上半年|半年度)`);
    if(endMonth==='09')variants.push(`${year}年前三季度`);
    if(endMonth==='03')variants.push(`${year}年第一季度`);
  }
  return variants.join('|');
}

/**
 * A deliberately narrow proof: one complete native statement contains only one
 * entity, metric, period, scope, basis, currency, unit and numeral. A scattered
 * table/header, several facts or any extra semantic text remains model-only.
 * This establishes literal identity, not truth or professional sign-off.
 */
export function verifyModelFinancialContext(o:ReviewFinancialObservation,ctx:ReviewEvidenceContext):Verification{
  if(o.value_refs.length!==1)return unverified('financial_context_requires_single_complete_statement');
  const target=o.value_refs[0]!;const records=ctx.records.filter(r=>evidenceKey(r)===evidenceKey(target));
  if(records.length!==1||validateReviewEvidence(target,ctx).length)return unverified('financial_context_record_unverified');
  const record=records[0]!;
  if(record.extraction_method!=='native_text'||record.uncertainty.length)return unverified('financial_context_native_text_required');
  const period=periodPattern(o.period),scope=scopes[o.accounting_scope],basis=bases[o.basis],currency=currencies[o.currency],unit=units[o.unit];
  if(!period||!scope||!basis||!currency||!unit||!o.entity_id.trim()||!o.metric.trim())return unverified('financial_context_dictionary_or_period_unsupported');
  const fields:[string,string][]=[['entity',escape(o.entity_id)],['metric',escape(o.metric)],['period',period],['accounting_scope',alternatives(scope)],['basis',alternatives(basis)],['currency',alternatives(currency)],['unit',alternatives(unit)],['value',escape(o.value_literal)]];
  const spans=new Map<string,Span>();
  for(const [field,pattern] of fields){
    const matches=[...record.literal_quote.matchAll(new RegExp(`(?:${pattern})`,'gu'))];
    if(matches.length!==1)return unverified(`financial_context_${field}_missing_or_ambiguous`);
    const match=matches[0]!;spans.set(field,{start:match.index,end:match.index+match[0].length,text:match[0]});
    if(field in o.context_refs){const refs=o.context_refs[field as keyof typeof o.context_refs];
      if(!refs.length||refs.some(ref=>evidenceKey(ref)!==evidenceKey(record)||validateReviewEvidence(ref,ctx).length)||!refs.some(ref=>ref.quote.includes(match[0])))
        return unverified(`financial_context_${field}_citation_not_bound`);
    }
  }
  const ordered=[...spans.values()].sort((a,b)=>a.start-b.start);
  if(ordered.some((span,i)=>i>0&&span.start<ordered[i-1]!.end))return unverified('financial_context_fields_overlap');
  let remainder='',end=0;
  for(const span of ordered){remainder+=record.literal_quote.slice(end,span.start);end=span.end;}
  remainder+=record.literal_quote.slice(end);
  if(!/^[\s,，:：;；。.!！]*(?:(?:为|是|等于)[\s,，:：;；。.!！]*)?$/.test(remainder))return unverified('financial_context_unbound_or_conflicting_text');
  return {context_verification:'literal_statement',context_limitations:[]};
}
