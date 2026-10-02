import type { ReviewEvidenceRef } from '../../../packages/contracts/dist/review-results.js';
import { evidenceKey, referenceFor, reviewContentHash, uniqueEvidence, validateReviewEvidence, type ReviewEvidenceContext } from '../../../packages/domain/dist/review-evidence.js';
import type { ReviewFinancialCalculation, ReviewFinancialObservation } from '../../../packages/domain/dist/review-financial-checks.js';
import type { ReviewAnalysisRecord } from './review-model-stage.js';
import { reviewTableScope } from './review-record-context.js';

export interface NativeReviewFormulaGap { check_id:string; reason:string; target_refs:ReviewEvidenceRef[]; evidence_refs:ReviewEvidenceRef[] }
export interface NativeReviewFormulaResult { calculations:ReviewFinancialCalculation[]; gaps:NativeReviewFormulaGap[] }
type Declaration={record:ReviewAnalysisRecord;scope:string;result:string;terms:string[];problem?:string};
type Resolution={records:ReviewAnalysisRecord[];labels:ReviewAnalysisRecord[];observations:ReviewFinancialObservation[];problem?:string};
const MAX_TERMS=64,MAX_GRAPH_STEPS=4096,MAX_GRAPH_DEPTH=64;
const cell=/^([A-Z]{1,3})([1-9]\d*)$/;
const plainTerm=(value:string)=>value.length>0&&value.length<=80&&!/[+=＝!:：\[\]{};,；，\r\n]/u.test(value);
const targetKey=(scope:string,term:string)=>JSON.stringify([scope,term]);
function sumTerms(text:string):{terms:string[];problem?:string}{
  const range=/^SUM\(([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)\)$/i.exec(text);
  if(range){
    const first=Number(range[2]),last=Number(range[4]);
    if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||range[1]!.toUpperCase()!==range[3]!.toUpperCase()
      ||last<=first||last-first+1>MAX_TERMS)return {terms:[],problem:'sum_range_unsupported'};
    return {terms:Array.from({length:last-first+1},(_,i)=>range[1]!.toUpperCase()+(first+i))};
  }
  const terms=text.split(/[+＋]/u).map(t=>t.trim());
  if(terms.length<2||terms.length>MAX_TERMS||terms.some(t=>!plainTerm(t)||/[*/×÷()（）]/u.test(t)))return {terms,problem:'explicit_sum_syntax_unsupported'};
  return {terms};
}
function declaration(record:ReviewAnalysisRecord):Declaration|null{
  const scope=reviewTableScope(record);if(!scope||record.source_kind!=='disclosure')return null;
  // A bare “合计” label does not establish a formula.
  const match=/^(?:计算关系|勾稽关系|公式)\s*[:：]\s*(.+?)\s*[=＝]\s*(.+?)[。；;]?$/u.exec(record.literal_quote.trim());
  if(!match)return null;
  const result=match[1]!.trim(),parsed=sumTerms(match[2]!.trim());
  return {record,scope:scope.key,result,terms:parsed.terms,problem:!plainTerm(result)?'explicit_sum_target_unsupported':parsed.problem};
}
const certain=(r:ReviewAnalysisRecord)=>r.extraction_method==='native_text'&&!r.uncertainty.length
  &&(r.locator_type!=='xlsx_cell'||r.formatting?.sheet_state==='visible');
const direct=(r:ReviewAnalysisRecord)=>certain(r)&&!r.literal_quote.trim().startsWith('=')
  &&!Object.hasOwn(r.formatting??{},'cached_formula_result');

/** Check the source-authored graph without recursion or exponential revisiting. */
function graphProblem(start:string,edges:ReadonlyMap<string,string[]>):string|undefined{
  const active=new Set<string>(),done=new Set<string>();
  const stack:{key:string;exit:boolean}[]=[{key:start,exit:false}];
  let steps=0;
  while(stack.length){
    if(++steps>MAX_GRAPH_STEPS)return 'formula_graph_limit';
    const next=stack.pop()!;
    if(next.exit){active.delete(next.key);done.add(next.key);continue;}
    if(active.has(next.key))return 'formula_cycle';
    if(done.has(next.key))continue;
    if(active.size>=MAX_GRAPH_DEPTH)return 'formula_graph_limit';
    active.add(next.key);stack.push({key:next.key,exit:true});
    for(const key of edges.get(next.key)??[]){if(edges.has(key))stack.push({key,exit:false});if(stack.length>MAX_GRAPH_STEPS)return 'formula_graph_limit';}
  }
  return undefined;
}

/**
 * Source-authored sums built once from the complete pinned snapshot after all model batches.
 * This verifies only the declared relationship and exact locations. Existing observation,
 * semantic-context, source, uncertainty and arithmetic gates still apply in the domain checker.
 * It does not approve facts, promote model context, or substitute cached values for original text.
 */
export function produceNativeReviewFormulas(input:{evidence:ReviewEvidenceContext;records:readonly ReviewAnalysisRecord[];
  observations:readonly ReviewFinancialObservation[];target_keys:ReadonlySet<string>;full_review:boolean;
  /** CLI tools select declarations. Omitted preserves the existing native producer API. */
  declaration_record_keys?:ReadonlySet<string>}):NativeReviewFormulaResult{
  const output:NativeReviewFormulaResult={calculations:[],gaps:[]};
  const declarations=input.records.flatMap(r=>{const d=declaration(r);return d?[d]:[];});
  const groups=new Map<string,ReviewAnalysisRecord[]>();
  const expectedGroups=new Map<string,string[]>();
  for(const record of input.evidence.records){const scope=reviewTableScope(record);if(scope){const keys=expectedGroups.get(scope.key)??[];keys.push(evidenceKey(record));expectedGroups.set(scope.key,keys);}}
  for(const record of input.records){const scope=reviewTableScope(record);if(scope){const group=groups.get(scope.key)??[];group.push(record);groups.set(scope.key,group);}}
  const pinCache=new Map<ReviewAnalysisRecord,boolean>();
  const pinned=(record:ReviewAnalysisRecord):boolean=>{
    if(pinCache.has(record))return pinCache.get(record)!;
    const matches=input.evidence.records.filter(r=>evidenceKey(r)===evidenceKey(record));
    const valid=record.owner_user_id===input.evidence.owner_user_id&&record.project_id===input.evidence.project_id
      &&matches.length===1&&matches[0]!.literal_quote===record.literal_quote&&!validateReviewEvidence(referenceFor(record),input.evidence,true).length;
    pinCache.set(record,valid);return valid;
  };
  const resolutionCache=new Map<string,Resolution>();
  const resolve=(d:Declaration,term:string):Resolution=>{
    const key=targetKey(d.scope,term);if(resolutionCache.has(key))return resolutionCache.get(key)!;
    const records=groups.get(d.scope)!;
    let candidates:ReviewAnalysisRecord[],labels:ReviewAnalysisRecord[]=[];
    const byCell=d.record.locator_type==='xlsx_cell'&&cell.test(term);
    if(byCell)candidates=records.filter(r=>r.locator.cell===term);
    else{
      labels=records.filter(r=>r.literal_quote.trim()===term);
      if(labels.length!==1){const result={records:labels,labels,observations:[],problem:'formula_label_missing_or_ambiguous'};resolutionCache.set(key,result);return result;}
      const label=labels[0]!,row=reviewTableScope(label)!.row;
      candidates=records.filter(r=>r!==label&&reviewTableScope(r)!.row===row&&r.literal_quote.trim());
    }
    // The model cannot hide a second period/value cell by extracting just one observation.
    const keys=new Set(candidates.map(evidenceKey));
    const observations=input.observations.filter(o=>o.source_kind==='disclosure'&&o.value_refs.length===1
      &&keys.has(evidenceKey(o.value_refs[0]!))&&(byCell||o.metric===term));
    const result={records:candidates,labels,observations,problem:candidates.length!==1?'formula_value_location_missing_or_ambiguous':undefined};
    resolutionCache.set(key,result);return result;
  };
  // Address and metric aliases share the same physical node, including duplicate/cycle checks.
  const locationKey=(d:Declaration,term:string)=>{const resolved=resolve(d,term);return JSON.stringify(resolved.records.length===1&&!resolved.problem
    ?['record',d.scope,evidenceKey(resolved.records[0]!)] : ['term',d.scope,term]);};
  const declarationsByTarget=new Map<string,Declaration[]>(),edges=new Map<string,string[]>();
  for(const d of declarations){
    const key=locationKey(d,d.result),values=declarationsByTarget.get(key)??[];values.push(d);declarationsByTarget.set(key,values);
    edges.set(key,[...edges.get(key)??[],...d.terms.slice(0,MAX_TERMS).map(term=>locationKey(d,term))]);
  }
  for(const d of declarations){
    if(input.declaration_record_keys&&!input.declaration_record_keys.has(evidenceKey(d.record)))continue;
    const records=groups.get(d.scope)!;
    const target=resolve(d,d.result),targeted=target.observations.filter(o=>o.value_refs.every(ref=>input.target_keys.has(evidenceKey(ref))));
    const targetRecords=target.records.filter(r=>input.target_keys.has(evidenceKey(r)));
    // The complete snapshot supplies evidence; it cannot expand selected differential targets.
    if(!targeted.length&&!targetRecords.length&&(!input.full_review||!input.target_keys.has(evidenceKey(d.record))))continue;
    const id='native-sum:'+reviewContentHash([evidenceKey(d.record),d.result,d.terms]).slice(0,32);
    const targetRefs=targeted.length?targeted.flatMap(o=>o.value_refs):targetRecords.length?targetRecords.map(r=>referenceFor(r)):[referenceFor(d.record)];
    const operands=d.terms.slice(0,MAX_TERMS).map(term=>resolve(d,term)),resolutions=[target,...operands];
    const allRecords=[d.record,...resolutions.flatMap(o=>[...o.labels,...o.records])];
    let problem=d.problem;
    const expected=expectedGroups.get(d.scope)??[],actual=new Set(records.map(evidenceKey));
    if(!problem&&(expected.length!==records.length||expected.some(key=>!actual.has(key))))problem='formula_snapshot_scope_incomplete';
    if(!problem&&!allRecords.every(pinned))problem='formula_source_pin_invalid';
    if(!problem&&!certain(d.record))problem='formula_source_uncertain_or_hidden';
    if(!problem&&resolutions.some(r=>r.labels.some(label=>!certain(label))))problem='formula_label_uncertain_or_hidden';
    if(!problem&&(declarationsByTarget.get(locationKey(d,d.result))?.length??0)!==1)problem='formula_declaration_ambiguous';
    if(!problem&&new Set(d.terms).size!==d.terms.length)problem='formula_duplicate_operand';
    if(!problem)problem=graphProblem(locationKey(d,d.result),edges);
    if(!problem)problem=resolutions.find(r=>r.problem)?.problem;
    if(!problem&&(target.observations.length!==1||targeted.length!==1))problem='formula_target_missing_or_ambiguous';
    if(!problem&&operands.some(o=>o.observations.length!==1))problem='formula_operand_missing_or_ambiguous';
    if(!problem){
      const values=resolutions.map(r=>r.records[0]!);
      if(new Set(values.map(evidenceKey)).size!==values.length)problem='formula_duplicate_or_self_location';
      else if(values.some(r=>!direct(r)))problem='formula_requires_direct_native_values';
    }
    if(problem){
      output.gaps.push({check_id:id,reason:'原文显式求和关系尚不可独立复算（'+problem+'）；不将缺项、缓存、OCR或多义关系作为确定性修改依据。',target_refs:targetRefs,
        evidence_refs:uniqueEvidence([...targetRefs,...allRecords.slice(0,500).map(r=>referenceFor(r))].filter(ref=>!validateReviewEvidence(ref,input.evidence).length))});
      continue;
    }
    output.calculations.push({calculation_id:id,label:'原文声明：'+d.result+'='+d.terms.join('+'),operation:'sum',result_id:targeted[0]!.observation_id,
      operand_ids:operands.map(o=>o.observations[0]!.observation_id),complete_terms:true,relation_verification:'trusted_structured',
      relation_refs:uniqueEvidence([d.record,...resolutions.flatMap(o=>o.labels)].map(r=>referenceFor(r)))});
  }
  return output;
}
