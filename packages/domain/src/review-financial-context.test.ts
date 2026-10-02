import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referenceFor } from './review-evidence.js';
import { verifyModelFinancialContext } from './review-financial-context.js';
import { reviewFinancialEvidence, type ReviewFinancialObservation } from './review-financial-checks.js';
import { reviewFixture } from './review-test-fixtures.js';

const make=(quote='合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入100.00。')=>{
  const f=reviewFixture();const record=f.addRecord('target',quote),ref=referenceFor(record);
  const o:ReviewFinancialObservation={observation_id:'target',source_kind:'disclosure',entity_id:'合成甲公司',metric:'营业收入',accounting_scope:'合并',basis:'原始报表',
    period:{start:'2025-01-01',end:'2025-12-31',as_of:null},currency:'CNY',unit:'万元',value:'100.00',value_literal:'100.00',value_refs:[ref],
    context_refs:{entity:[ref],period:[ref],accounting_scope:[ref],basis:[ref],currency:[ref],unit:[ref]}};
  return {...f,o,record};
};
test('one complete native statement can independently bind exact financial identity and retain a justified repair',()=>{
  const f=make();const o={...f.o,...verifyModelFinancialContext(f.o,f.ctx)};assert.equal(o.context_verification,'literal_statement');
  const source=f.addRecord('audit',f.record.literal_quote.replace('100.00','120.00'),false),ref=referenceFor(source);
  const audit:ReviewFinancialObservation={...f.o,observation_id:'audit',source_kind:'audit',value:'120.00',value_literal:'120.00',value_refs:[ref],context_refs:{entity:[ref],period:[ref],accounting_scope:[ref],basis:[ref],currency:[ref],unit:[ref]}};
  const verified={...audit,...verifyModelFinancialContext(audit,f.ctx)};assert.equal(verified.context_verification,'literal_statement');
  const result=reviewFinancialEvidence({observations:[o,verified],calculations:[]},f.ctx);assert.equal(result.findings[0]?.conclusion,'error');assert.equal(result.findings[0]?.repairability.can_revise,true);assert.equal(result.findings[0]?.suggested_change,'120.00');
});
test('authentic quotations with a wrong model entity, metric, period, currency, unit, scope or basis cannot authorize a financial edit',()=>{
  const changes:Partial<ReviewFinancialObservation>[]=[{entity_id:'甲公司'},{entity_id:'合成乙公司'},{metric:'净利润'},{metric:'收入'},
    {period:{start:'2024-01-01',end:'2024-12-31',as_of:null}},{currency:'USD'},{unit:'元'},{accounting_scope:'母公司'},{basis:'重述后'}];
  for(const change of changes){const f=make();Object.assign(f.o,change);const untrusted={...f.o,...verifyModelFinancialContext(f.o,f.ctx)};
    assert.equal(untrusted.context_verification,'unverified',JSON.stringify(change));
    const result=reviewFinancialEvidence({observations:[untrusted,f.observation('audit','120.00',{source_kind:'audit',...change})],calculations:[]},f.ctx);
    assert.equal(result.findings[0]?.conclusion,'manual');assert.equal(result.findings[0]?.repairability.can_revise,false);assert(result.coverage.every(c=>c.outcome!=='pass'));
  }
});
test('mislabelling mother-company evidence as consolidated remains manual even when all model identities match each other',()=>{
  const f=make();const o={...f.o,...verifyModelFinancialContext(f.o,f.ctx)};
  const source=f.addRecord('parent','合成甲公司 母公司 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入120.00。',false),ref=referenceFor(source);
  const a:ReviewFinancialObservation={...f.o,observation_id:'parent',source_kind:'audit',value:'120.00',value_literal:'120.00',value_refs:[ref],context_refs:{entity:[ref],period:[ref],accounting_scope:[ref],basis:[ref],currency:[ref],unit:[ref]}};
  const result=reviewFinancialEvidence({observations:[o,{...a,...verifyModelFinancialContext(a,f.ctx)}],calculations:[]},f.ctx);
  assert.equal(result.findings[0]?.conclusion,'manual');assert.equal(result.findings[0]?.repairability.can_revise,false);assert.equal(result.findings[0]?.suggested_change,undefined);
});
test('several facts, contradictory scopes, negation and repeated metric text in a paragraph stay unverified',()=>{
  for(const suffix of [' 母公司营业收入120.00。',' 合成乙公司。',' 母公司。',' 净利润。',' 不正确。',' 营业收入。']){
    const f=make();f.record.literal_quote+=suffix;assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'unverified',suffix);
  }
  const f=make('合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入不为100.00。');assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'unverified');
});
test('Chinese period aliases are bounded: annual, half-year and first-three-quarter map without treating Q3 as year-to-date',()=>{
  for(const [text,end] of [['2025年度','2025-12-31'],['2025年上半年','2025-06-30'],['2025年1—6月','2025-06-30'],['2025年前三季度','2025-09-30'],['2025年1-9月','2025-09-30']]){
    const f=make(`合成甲公司 合并 原始报表 ${text} 人民币万元 营业收入为100.00。`);f.o.period.end=end!;assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'literal_statement',text);
  }
  const f=make('合成甲公司 合并 原始报表 2025年三季度 CNY 万元 营业收入100.00。');f.o.period.end='2025-09-30';assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'unverified');
});
test('balance-sheet dates must be exact valid endpoints and must not masquerade as flow periods',()=>{
  for(const text of ['2025-09-30','2025年9月30日','2025年9月末']){const f=make(`合成甲公司 合并 原始报表 ${text} CNY 万元 总资产100.00。`);f.o.metric='总资产';f.o.period={start:null,end:null,as_of:'2025-09-30'};assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'literal_statement');}
  const f=make('合成甲公司 合并 原始报表 2025年9月末 CNY 万元 营业收入100.00。');f.o.period.end='2025-09-30';assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'unverified');
});
test('unrelated or truncated context citations and OCR cannot establish semantic identity',()=>{
  const f=make();f.o.context_refs.entity=[{...f.o.value_refs[0]!,quote:'100.00'}];assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'unverified');
  const separate=f.addRecord('separate','合成甲公司 合并 原始报表 2025年度 CNY 万元');f.o.context_refs.entity=[referenceFor(separate)];assert.equal(verifyModelFinancialContext(f.o,f.ctx).context_verification,'unverified');
  const ocr=make();ocr.record.extraction_method='ocr';ocr.o.value_refs=[referenceFor(ocr.record)];assert.equal(verifyModelFinancialContext(ocr.o,ocr.ctx).context_verification,'unverified');
});
test('missing producer verification defaults to manual while explicitly trusted structured identity retains deterministic checks',()=>{
  const f=reviewFixture(),d=f.observation('d','100'),a=f.observation('a','120',{source_kind:'audit'});delete d.context_verification;
  assert.equal(reviewFinancialEvidence({observations:[d,a],calculations:[]},f.ctx).findings[0]?.conclusion,'manual');d.context_verification='trusted_structured';
  assert.equal(reviewFinancialEvidence({observations:[d,a],calculations:[]},f.ctx).findings[0]?.repairability.can_revise,true);
});
test('correctly computed arithmetic with model-selected operands still requires an independently verified formula relationship',()=>{
  const f=reviewFixture(),d=f.observation('d','1',{unit:'%',metric:'ratio'}),a=f.observation('a','20',{source_kind:'audit'}),b=f.observation('b','100',{source_kind:'audit'});
  const result=reviewFinancialEvidence({observations:[d,a,b],calculations:[{calculation_id:'ratio',label:'Model-selected ratio',operation:'ratio_percent',result_id:'d',operand_ids:['a','b'],complete_terms:true,relation_verification:'unverified'}]},f.ctx);
  const formula=result.coverage.find(c=>c.check_id==='calculation:ratio')!;assert.equal(formula.outcome,'manual');assert(result.findings.every(f=>!f.repairability.can_revise));
});
