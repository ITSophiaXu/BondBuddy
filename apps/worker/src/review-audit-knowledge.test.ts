/** Synthetic integration checks; no genuine client balances or professional attestations. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIT_RECONCILIATION_KNOWLEDGE } from '../../../packages/domain/dist/audit-reconciliation-knowledge.js';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { reviewContentHash } from '../../../packages/domain/dist/review-evidence.js';
import { isReviewReport } from '../../../packages/contracts/dist/review-results.js';
import { buildReviewAnalysisPrompt, reviewAuditKnowledgePin, reviewAnalysisTemplateVersion, reviewModelStage, reviewPromptRecordId,
  type ReviewAnalysisInput, type ReviewAnalysisRecord, type ModelReviewAnalysis, type ReviewAnalysisResult } from './review-model-stage.js';
import type { StageContext } from './run-pipeline.js';

function fixture() {
  const f=reviewFixture();
  const context='合成甲公司 合并 原始报表 2025-12-31 CNY 万元';
  const audit={material_id:'synthetic-audit',material_version:1,material_sha256:reviewContentHash('synthetic-audit'),
    parse_snapshot_id:'synthetic-audit-parse',parse_response_sha256:reviewContentHash('synthetic-audit-parse')};
  f.addRecord('assets',`${context} 资产总计 100.00`,true);
  f.addRecord('liabilities',`${context} 负债合计 80.00`,false,audit);
  f.addRecord('equity',`${context} 所有者权益合计 30.00`,false,audit);
  const records:ReviewAnalysisRecord[]=f.records.map(r=>({...r,source_kind:r.material_id===f.ctx.source_material.material_id?'disclosure':'audit'}));
  const input:ReviewAnalysisInput={input_hash:'f'.repeat(64),evidence:{...f.ctx,records},rule_context:null,rule_packs:[],formatting_requirements:[],requirements:['核对勾稽；先不修改。'],scope:{mode:'full_review',finding_ids:[]},report_version:1,created_at:'2026-10-02T08:00:00Z',limitations:[]};
  const ctx={run:{id:'synthetic-run',owner_user_id:f.ctx.owner_user_id,project_id:f.ctx.project_id,input_revision:1,input_hash:input.input_hash},
    values:new Map(),checkpoint:{},signal:new AbortController().signal} as unknown as StageContext;
  return {input,ctx};
}

test('prompt supplies all 40 original items as a pinned internal method and preserves applicability limits',()=>{
  const {input}=fixture();
  const prompt=buildReviewAnalysisPrompt(input);
  const data=JSON.parse(prompt.split('输入数据：\n')[1]!);
  assert.equal(data.audit_reconciliation_knowledge.rules.length,40);
  assert.equal(data.audit_reconciliation_knowledge.authority,'internal_method');
  assert.equal(data.audit_reconciliation_knowledge.source_sha256,'0dd2a03aaca23e48b01144594b50451f17806059460ef9567aedd782f1124ecb');
  assert.equal(data.audit_reconciliation_knowledge.content_sha256,reviewAuditKnowledgePin);
  assert.equal(reviewAuditKnowledgePin,reviewContentHash(AUDIT_RECONCILIATION_KNOWLEDGE));
  assert.match(prompt,/缺少桥接/);assert.match(prompt,/模型不能改写/);assert.match(prompt,/监管出处不代表已验证/);
  assert.match(reviewAnalysisTemplateVersion,new RegExp(reviewAuditKnowledgePin.slice(0,16)));
});

test('worker aggregates pinned audit terms across batches and executes the fixed balance identity',async()=>{
  const {input,ctx}=fixture();const calls:string[]=[];
  const result=await reviewModelStage({loadInput:async()=>input,maxBatchRecords:1,model:options=>({name:options.name,replay:true,run:async context=>{
    calls.push(options.logicalCallId);
    assert(options.name.includes(reviewAuditKnowledgePin.slice(0,16)));
    assert.equal(options.templateVersion,reviewAnalysisTemplateVersion);
    const data=JSON.parse((await options.buildPrompt(context)).split('输入数据：\n')[1]!);
    const raw:ModelReviewAnalysis={reviewed_record_ids:data.records.map((r:{id:string})=>r.id),observations:[],calculations:[],
      compliance_assessments:[],concerns:[],limitations:[]};
    for(const source of data.records){
      const record=input.evidence.records.find(r=>reviewPromptRecordId(r)===source.id)!;
      const [metric,value]=record.record_id==='assets'?['资产总计','100.00']:record.record_id==='liabilities'?['负债合计','80.00']:['所有者权益合计','30.00'];
      const refs=[{record_id:source.id,quote:record.literal_quote}];
      raw.observations.push({observation_id:record.record_id,source_record_id:source.id,entity_id:'合成甲公司',metric,accounting_scope:'合并',basis:'原始报表',
        period:{start:null,end:null,as_of:'2025-12-31'},currency:'CNY',unit:'万元',value,value_literal:value,
        value_refs:refs,context_refs:{entity:refs,period:refs,accounting_scope:refs,currency:refs,unit:refs,basis:refs}});
    }
    assert(options.validate(raw));return {kind:'done',value:raw};
  }})}).run(ctx);
  assert.equal(result.kind,'done');if(result.kind!=='done')return;
  const {report}=result.value as ReviewAnalysisResult;
  assert(isReviewReport(report));assert.equal(calls.length,3);
  const finding=report.findings.find(f=>f.calculation?.expression===`audit-reconciliation:${AUDIT_RECONCILIATION_KNOWLEDGE.version}:audit-reconciliation-01`)!;
  assert(finding);assert.equal(finding.conclusion,'error');assert.equal(finding.suggested_change,'110.00');
  assert.equal(finding.repairability.can_revise,true);assert.equal(finding.target_refs[0]?.record_id,'assets');
  assert.deepEqual(finding.evidence_refs.filter(r=>r.material_id==='synthetic-audit').map(r=>r.record_id).sort(),['equity','liabilities']);
  assert.equal(report.coverage.filter(c=>c.check_id.startsWith('audit-reconciliation:')).length,40);
  assert.equal((result.checkpoint as Record<string,unknown>).audit_knowledge_sha256,reviewAuditKnowledgePin);
});

test('missing conditional bridge never becomes an automatic repair or a financial pass',async()=>{
  const {input,ctx}=fixture();input.evidence.records=input.evidence.records.filter(r=>r.source_kind==='disclosure');
  input.evidence.records[0]!.literal_quote='合成甲公司 合并 原始报表 2025-12-31 CNY 万元 未分配利润期末余额 100.00';
  input.evidence.records[0]!.record_sha256=reviewContentHash(input.evidence.records[0]!.literal_quote);
  const result=await reviewModelStage({loadInput:async()=>input,model:options=>({name:options.name,run:async c=>{
    const data=JSON.parse((await options.buildPrompt(c)).split('输入数据：\n')[1]!);const r=data.records[0];const refs=[{record_id:r.id,quote:r.literal_quote}];
    return {kind:'done',value:{reviewed_record_ids:[r.id],observations:[{observation_id:'retained',source_record_id:r.id,entity_id:'合成甲公司',metric:'未分配利润期末余额',accounting_scope:'合并',basis:'原始报表',period:{start:null,end:null,as_of:'2025-12-31'},currency:'CNY',unit:'万元',value:'100.00',value_literal:'100.00',value_refs:refs,context_refs:{entity:refs,period:refs,accounting_scope:refs,currency:refs,unit:refs,basis:refs}}],calculations:[],compliance_assessments:[],concerns:[],limitations:[]}};
  }})}).run(ctx);
  assert.equal(result.kind,'done');if(result.kind!=='done')return;
  const {report}=result.value as ReviewAnalysisResult;
  const coverage=report.coverage.filter(c=>c.check_id.startsWith('audit-reconciliation:'));
  assert.equal(coverage.length,40);assert(coverage.some(c=>c.outcome==='manual'));
  assert(report.findings.every(f=>!f.repairability.can_revise));assert(coverage.every(c=>c.outcome!=='pass'));
});

test('interrupted or completed runs cannot resume with a different knowledge method',async()=>{
  const checkpoints:StageContext['checkpoint'][]=[
    {review_v1_extract_0_1234567890abcdef_prompt:{snapshot_id:'old-template'}},
    {review_v1_extract_0_1234567890abcdef_0000000000000000_prompt:{snapshot_id:'other-method'}},
    {model_generation:{version:'review-analysis-v1',audit_knowledge_sha256:'0'.repeat(64)}},
    {model_generation:{version:'review-analysis-v1'}}
  ];
  for(const checkpoint of checkpoints){
    const {input,ctx}=fixture();ctx.checkpoint=checkpoint;let calls=0;
    const result=await reviewModelStage({loadInput:async()=>input,model:options=>({name:options.name,run:async()=>{
      calls++;return {kind:'done',value:{}};
    }})}).run(ctx);
    assert.deepEqual(result,{kind:'pause',stage:'capability_not_ready',reason:'review_audit_knowledge_version_changed'});
    assert.equal(calls,0);
  }
});
