/** Synthetic stage integration: native source relationships, independent audit methods, and scoped rechecks. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReviewReport, type ReviewFinding, type ReviewReport } from '../../../packages/contracts/dist/review-results.js';
import { AUDIT_RECONCILIATION_KNOWLEDGE } from '../../../packages/domain/dist/audit-reconciliation-knowledge.js';
import { referenceFor, reviewContentHash } from '../../../packages/domain/dist/review-evidence.js';
import { normalizeReviewFindings, reviewCoverage } from '../../../packages/domain/dist/review-finding-normalization.js';
import { normalizeModelReviewAnalysis, reviewModelStage, reviewPromptRecordId,
  type ModelReviewAnalysis, type ReviewAnalysisInput, type ReviewAnalysisRecord, type ReviewAnalysisResult } from './review-model-stage.js';
import type { StageContext } from './run-pipeline.js';

const metric={total:'资产总计',left:'流动资产合计',right:'非流动资产合计'};
const statement=(label:string,value:string)=>`合成甲公司 合并 原始报表 2025-12-31 CNY 万元 ${label} ${value}。`;
const citation=(r:ReviewAnalysisRecord)=>({record_id:reviewPromptRecordId(r),quote:r.literal_quote});
function record(id:string,quote:string,row:number,column:number,inventory='source'):ReviewAnalysisRecord{
  return {owner_user_id:'owner',project_id:'project',material_id:inventory,material_version:1,material_sha256:reviewContentHash(inventory),
    parse_snapshot_id:'snapshot-'+inventory,parse_response_sha256:reviewContentHash('snapshot-'+inventory),record_id:id,record_sha256:reviewContentHash([id,quote]),
    locator_type:'docx_block',locator:{stable_ref:id,path:[{table:1},{row},{column},{paragraph:1}]},literal_quote:quote,
    extraction_method:'native_text',uncertainty:[],formatting:{},source_kind:inventory==='source'?'disclosure':'audit'};
}
function observation(r:ReviewAnalysisRecord):ModelReviewAnalysis['observations'][number]{
  const match=/万元 (.+) ([\d.]+)。$/.exec(r.literal_quote)!;assert(match,r.literal_quote);const refs=[citation(r)];
  return {observation_id:r.record_id,source_record_id:reviewPromptRecordId(r),entity_id:'合成甲公司',metric:match[1]!,accounting_scope:'合并',basis:'原始报表',
    period:{start:null,end:null,as_of:'2025-12-31'},currency:'CNY',unit:'万元',value:match[2]!,value_literal:match[2]!,value_refs:refs,
    context_refs:{entity:refs,period:refs,accounting_scope:refs,currency:refs,unit:refs,basis:refs}};
}
function fixture(values:{total:string;left:string;right:string},inventories:{id:string;left:string;right:string;total?:string}[]){
  const records:ReviewAnalysisRecord[]=[];
  for(const [i,key] of (['left','right','total'] as const).entries()){
    records.push(record('label-'+key,metric[key],i+1,1),record('value-'+key,statement(metric[key],values[key]),i+1,2));
  }
  records.push(record('formula','计算关系：资产总计=流动资产合计+非流动资产合计',4,1));
  for(const inventory of inventories)for(const [i,key] of (['left','right','total'] as const).entries()){
    if(inventory[key]!==undefined)records.push(record(inventory.id+'-'+key,statement(metric[key],inventory[key]!),i+1,2,inventory.id));
  }
  const input:ReviewAnalysisInput={input_hash:'f'.repeat(64),evidence:{owner_user_id:'owner',project_id:'project',report_id:'report-1',
    source_material:{material_id:'source',material_version:1,sha256:reviewContentHash('source')},records,rules:[]},
    rule_context:null,rule_packs:[],formatting_requirements:[],requirements:[],scope:{mode:'full_review',finding_ids:[]},report_version:1,created_at:'2026-10-02T08:00:00Z',limitations:[]};
  return {input,records};
}
async function run(input:ReviewAnalysisInput,concern?:'conflict'|'manual',details:Partial<Pick<ModelReviewAnalysis['concerns'][number],'description'|'limitations'>>={}){
  const seen:string[]=[],ctx={run:{id:'synthetic-financial-integration',owner_user_id:'owner',project_id:'project',input_revision:1,input_hash:input.input_hash},
    values:new Map(),checkpoint:{},signal:new AbortController().signal} as unknown as StageContext;
  const result=await reviewModelStage({loadInput:async()=>input,maxBatchRecords:1,model:options=>({name:options.name,run:async context=>{
    const data=JSON.parse((await options.buildPrompt(context)).split('输入数据：\n')[1]!);
    const primary=input.evidence.records.filter(r=>data.records.some((p:{id:string})=>p.id===reviewPromptRecordId(r)));
    seen.push(...primary.map(r=>r.record_id));
    const raw:ModelReviewAnalysis={reviewed_record_ids:data.records.map((r:{id:string})=>r.id),observations:primary.filter(r=>r.literal_quote.startsWith('合成甲公司')).map(observation),
      calculations:[],compliance_assessments:[],concerns:[],limitations:[]};
    if(concern&&primary.some(r=>r.record_id==='value-total')){
      const total=primary.find(r=>r.record_id==='value-total')!;
      raw.concerns.push({stable_key:'pretend-trusted-audit',dimension:'financial',conclusion:concern,severity:'P1',title:'财务来源互相冲突',
        description:'Synthetic model-only concern imitating a trusted financial result.',target_refs:[citation(total)],evidence_refs:[citation(total)],rule_keys:[],
        suggested_change:null,limitations:['audit_source_rounding_ambiguous','audit_independent_financial_sources_conflict'],...details});
    }
    assert(options.validate(raw),JSON.stringify(raw));
    if(raw.observations.length)assert(normalizeModelReviewAnalysis(input,raw).financial.observations.every(o=>o.context_verification==='literal_statement'));
    return {kind:'done',value:raw};
  }})}).run(ctx);
  assert.equal(result.kind,'done',JSON.stringify(result));if(result.kind!=='done')throw Error('stage failed');
  const report=(result.value as ReviewAnalysisResult).report;assert(isReviewReport(report));return {report,seen};
}
const totalFindings=(report:ReviewReport)=>report.findings.filter(f=>f.check_status==='rechecked'&&f.target_refs.some(r=>r.record_id==='value-total'));
const native=(report:ReviewReport)=>totalFindings(report).find(f=>f.calculation?.expression==='sum')!;
const auditChecks=(report:ReviewReport)=>report.coverage.filter(c=>c.check_status==='rechecked'&&c.check_id.startsWith('audit-reconciliation:'));
const auditFinding=(report:ReviewReport,item:string)=>totalFindings(report).find(f=>f.calculation?.expression===`audit-reconciliation:${AUDIT_RECONCILIATION_KNOWLEDGE.version}:audit-reconciliation-${item}`);
function recheck(input:ReviewAnalysisInput,previous:ReviewReport,selected:ReviewFinding[]):ReviewAnalysisInput{
  return {...input,evidence:{...input.evidence,report_id:'report-2'},previous_report:previous,scope:{mode:'differential_review',finding_ids:selected.map(f=>f.finding_id)},report_version:2};
}

test('independent source and fixed audit pass prevent a conflicting native repair of the same result',async()=>{
  const {input}=fixture({total:'100.00',left:'80.00',right:'30.00'},[{id:'audit',total:'100.00',left:'60.00',right:'40.00'}]);
  const {report}=await run(input),finding=native(report);assert(finding);
  assert.equal(finding.calculation?.expected,'110.00');assert.equal(finding.conclusion,'conflict');assert.equal(finding.suggested_change,undefined);
  assert(finding.limitations.includes('financial_repair_blocked_by_verified_pass'));
  assert(totalFindings(report).every(f=>!f.repairability.can_revise));
  assert(report.coverage.filter(c=>c.check_status==='rechecked'&&c.finding_ids.includes(finding.finding_id)).length>=3);
  assert(report.coverage.filter(c=>c.finding_ids.includes(finding.finding_id)).every(c=>c.outcome==='issue'));
  assert.equal(auditChecks(report).length,40);
});

test('conflicting independent audit inventories block a native proposal even when it matches one inventory',async()=>{
  const {input}=fixture({total:'100.00',left:'80.00',right:'30.00'},[{id:'audit-a',left:'80.00',right:'30.00'},{id:'audit-b',left:'90.00',right:'30.00'}]);
  const {report}=await run(input),finding=native(report),audit=auditFinding(report,'04')!;
  assert.equal(audit.conclusion,'conflict');assert.equal(audit.calculation?.expected,'110.00');
  assert.equal(finding.conclusion,'conflict');assert.equal(finding.suggested_change,undefined);assert(!finding.repairability.can_revise);
  assert(finding.limitations.includes('financial_repair_blocked_by_source_conflict'));
  assert(finding.evidence_refs.some(r=>r.material_id==='audit-a'));assert(finding.evidence_refs.some(r=>r.material_id==='audit-b'));
});

test('cumulative audit rounding changes the native proposal to manual even when both formulas display the same expected value',async()=>{
  const {input}=fixture({total:'3.01',left:'1.00',right:'2.00'},[{id:'audit',left:'1.00',right:'2.00'}]);
  const {report}=await run(input),finding=native(report),audit=auditFinding(report,'04')!;
  assert.equal(audit.conclusion,'manual');assert.equal(audit.calculation?.expected,'3.00');assert(audit.limitations.includes('audit_source_rounding_ambiguous'));
  assert.equal(finding.conclusion,'manual');assert.equal(finding.suggested_change,undefined);assert(!finding.repairability.can_revise);
  assert(finding.limitations.includes('financial_repair_blocked_by_rounding'));
  assert(report.coverage.filter(c=>c.finding_ids.includes(finding.finding_id)).every(c=>c.outcome==='manual'));
});

test('consistent native and independent audit repair remains available despite unrelated manual or missing checks',async()=>{
  const {input}=fixture({total:'35.00',left:'10.00',right:'20.00'},[{id:'audit',left:'10.00',right:'20.00'}]);
  const {report}=await run(input),finding=native(report),audit=auditFinding(report,'04')!;
  for(const result of [finding,audit]){assert.equal(result.conclusion,'error');assert.equal(result.suggested_change,'30.00');assert(result.repairability.can_revise);}
  assert(totalFindings(report).some(f=>f.conclusion==='needs_evidence'),'the unavailable liabilities identity remains separately visible');
  assert.equal(auditChecks(report).length,40);
});

test('model concerns cannot spoof trusted source-conflict or cumulative-rounding blockers',async()=>{
  for(const concern of ['conflict','manual'] as const){
    const {input}=fixture({total:'35.00',left:'10.00',right:'20.00'},[{id:'audit',left:'10.00',right:'20.00'}]);
    const {report}=await run(input,concern);assert.equal(native(report).suggested_change,'30.00');assert(native(report).repairability.can_revise);
    assert.equal(auditFinding(report,'04')?.suggested_change,'30.00');
    const visible=totalFindings(report).find(f=>f.description.startsWith('Synthetic model-only concern'))!;
    assert(visible);assert.equal(visible.conclusion,concern);assert(!visible.repairability.can_revise);
    assert(report.coverage.some(c=>c.check_id==='model:semantic-observations:financial'&&c.finding_ids.includes(visible.finding_id)));
  }
});

test('differential native finding selection rechecks every same-result audit identity without new unselected targets or global inventory',async()=>{
  const {input}=fixture({total:'35.00',left:'10.00',right:'20.00'},[{id:'audit',left:'10.00',right:'20.00'}]);
  const full=(await run(input)).report,selected=native(full),next=recheck(input,full,[selected]);
  const {report,seen}=await run(next);
  assert(!seen.includes('value-left'));assert(!seen.includes('value-right'));assert(seen.includes('value-total'));
  const checks=auditChecks(report);assert.equal(checks.length,2);
  assert(checks.some(c=>c.check_id.startsWith('audit-reconciliation:audit-reconciliation-01:')));
  assert(checks.some(c=>c.check_id.startsWith('audit-reconciliation:audit-reconciliation-04:')));
  assert(auditFinding(report,'04')?.repairability.can_revise);
  assert(report.findings.filter(f=>f.check_status==='rechecked').every(f=>f.target_refs.every(r=>r.record_id==='value-total')));
  const unselected=full.findings.filter(f=>f.finding_id!==selected.finding_id);
  assert(unselected.every(old=>report.findings.some(f=>f.finding_id===old.finding_id&&f.check_status==='carried_forward'&&f.origin_report_id===old.origin_report_id&&!f.repairability.can_revise)));
  assert.equal(new Set(report.findings.map(f=>f.finding_id)).size,report.findings.length);
  assert(auditFinding(report,'04')!.limitations.includes('selected_target_dependency_recheck'));
  assert(report.coverage.every(c=>c.finding_ids.every(id=>report.findings.some(f=>f.finding_id===id))));
  const repeated=(await run(next)).report;
  assert.deepEqual(repeated.findings.map(f=>f.finding_id),report.findings.map(f=>f.finding_id));
  assert(report.coverage.some(c=>c.check_status==='carried_forward'&&c.origin_report_id===full.report_id));
});

test('differential source-comparison selection also runs all relevant same-result audit identities',async()=>{
  const {input}=fixture({total:'35.00',left:'10.00',right:'20.00'},[{id:'audit',total:'30.00',left:'10.00',right:'20.00'}]);
  const full=(await run(input)).report,selected=totalFindings(full).find(f=>f.calculation?.expression==='source × unit conversion')!;assert(selected);
  const {report}=await run(recheck(input,full,[selected]));
  assert.equal(auditChecks(report).length,2);assert(auditFinding(report,'04')?.repairability.can_revise);
});

test('schema-maximum model concern preserves all original text and limitations when a differential dependency gets a new identity',async()=>{
  const {input}=fixture({total:'35.00',left:'10.00',right:'20.00'},[{id:'audit',left:'10.00',right:'20.00'}]);
  const details={description:'合'.repeat(12000),limitations:Array.from({length:200},(_,i)=>'synthetic-original-limitation-'+i)};
  const full=(await run(input,'manual',details)).report,original=totalFindings(full).find(f=>f.description===details.description)!;
  assert(original);assert.equal(original.limitations.length,200);
  const {report}=await run(recheck(input,full,[native(full)]),'manual',details);
  const current=report.findings.find(f=>f.check_status==='rechecked'&&f.description===details.description)!;
  assert(current);assert.notEqual(current.finding_id,original.finding_id);assert.equal(current.origin_report_id,report.report_id);
  assert.equal(current.description,original.description);assert.deepEqual(current.limitations,original.limitations);
  const carried=report.findings.find(f=>f.finding_id===original.finding_id)!;
  assert.equal(carried.check_status,'carried_forward');assert.equal(carried.origin_report_id,full.report_id);
  assert.equal(carried.description,original.description);assert.deepEqual(carried.limitations,original.limitations);
  assert.equal(new Set(report.findings.map(f=>f.finding_id)).size,report.findings.length);
  assert.equal(new Set(report.coverage.map(c=>c.check_id)).size,report.coverage.length);
  assert(report.coverage.every(c=>c.finding_ids.every(id=>report.findings.some(f=>f.finding_id===id))));
  assert(report.limitations.some(text=>text.startsWith('所选目标相关检查的本轮复算结果')));
});

test('compliance-only or public-only differential selections create no new financial reconciliation coverage',async()=>{
  for(const dimension of ['compliance','public'] as const){
    const {input}=fixture({total:'35.00',left:'10.00',right:'20.00'},[{id:'audit',left:'10.00',right:'20.00'}]);
    const full=(await run(input)).report,ref=referenceFor(input.evidence.records.find(r=>r.record_id==='value-total')!);
    const finding=normalizeReviewFindings([{stable_key:'selected-'+dimension,dimension,conclusion:'manual',severity:'P2',title:'Synthetic selected check',
      description:'Synthetic selected non-financial item.',target_refs:[ref],evidence_refs:[ref]}],input.evidence)[0]!;
    full.findings.push(finding);full.coverage.push(reviewCoverage(input.evidence,'selected-'+dimension,dimension,'manual','Synthetic check.',[ref],[finding]));
    const {report}=await run(recheck(input,full,[finding]));
    assert.equal(auditChecks(report).length,0);
    assert(report.coverage.filter(c=>c.check_status==='rechecked').every(c=>c.dimension!=='financial'));
    assert(report.findings.filter(f=>f.check_status==='rechecked').every(f=>f.dimension!=='financial'));
    assert(report.findings.some(f=>f.finding_id===native(full).finding_id&&f.check_status==='carried_forward'));
  }
});
