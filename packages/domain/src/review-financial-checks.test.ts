import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewFinancialEvidence, type ReviewFinancialObservation, type ReviewFinancialCalculation } from './review-financial-checks.js';
import { reviewFixture } from './review-test-fixtures.js';

test('synthetic missing digit is a repairable deterministic error with only numeric target anchors',()=>{
  const f=reviewFixture(),target=f.observation('d','100.00'),source=f.observation('a','1000.00',{source_kind:'audit'});
  const result=reviewFinancialEvidence({observations:[target,source],calculations:[]},f.ctx);
  assert.equal(result.findings[0]?.conclusion,'error');assert.equal(result.findings[0]?.suggested_change,'1000.00');
  assert.deepEqual(result.findings[0]?.repairability.allowed_record_ids,['d']);
  assert.equal(result.coverage[0]?.outcome,'issue');assert.equal(result.findings[0]?.calculation?.observed,'100.00');
});
test('exact unit conversion and final rounding preserve visible precision without float errors',()=>{
  for(const [observed,source,unit] of [['12.35','123450','元'],['0.30','3000','元'],['100000000000000.00','1000000000000000000','元']]){
    const f=reviewFixture();const result=reviewFinancialEvidence({observations:[f.observation('d',observed!),f.observation('a',source!,{source_kind:'audit',unit:unit!})],calculations:[]},f.ctx);
    assert.equal(result.findings.length,0);assert.equal(result.coverage[0]?.outcome,'pass');
  }
});
test('commas, accounting negatives and legitimate zero are values; malformed/missing numbers are not zero',()=>{
  for(const [value,literal] of [['-1234.50','(1,234.50)'],['0','0'],['1234.50','1,234.50']]){
    const f=reviewFixture();const result=reviewFinancialEvidence({observations:[f.observation('d',value!,{value_literal:literal}),f.observation('a',value!,{source_kind:'audit'})],calculations:[]},f.ctx);
    assert.equal(result.coverage[0]?.outcome,'pass');
  }
  for(const literal of ['—','','12,34','1,234,','1000']){
    const f=reviewFixture();const result=reviewFinancialEvidence({observations:[f.observation('d','0',{value_literal:literal}),f.observation('a','0',{source_kind:'audit'})],calculations:[]},f.ctx);
    assert.equal(result.coverage[0]?.outcome,'needs_evidence');
  }
});
test('numeric substring cannot turn 1000 into quoted evidence for 100',()=>{
  const f=reviewFixture(),d=f.observation('d','1000');d.value='100';d.value_literal='100';
  const result=reviewFinancialEvidence({observations:[d,f.observation('a','100',{source_kind:'audit'})],calculations:[]},f.ctx);
  assert(result.findings[0]?.limitations.includes('financial_value_not_in_source'));assert.equal(result.coverage[0]?.outcome,'needs_evidence');
  d.value_refs=[{...d.value_refs[0]!,quote:'100'}];
  assert(reviewFinancialEvidence({observations:[d],calculations:[]},f.ctx).findings[0]?.limitations.includes('financial_value_not_in_source'));
  const negative=f.observation('n','-100');negative.value='100';negative.value_literal='100';negative.value_refs=[{...negative.value_refs[0]!,quote:'100'}];
  assert(reviewFinancialEvidence({observations:[negative],calculations:[]},f.ctx).findings[0]?.limitations.includes('financial_value_not_in_source'));
});
test('entity, currency, scope, basis and period mismatch never creates a hard monetary error',()=>{
  const changes:Partial<ReviewFinancialObservation>[]=[{entity_id:'other'},{currency:'USD'},{accounting_scope:'parent'},{basis:'restated'},{period:{start:'2024-01-01',end:'2024-12-31',as_of:null}}];
  for(const change of changes){const f=reviewFixture();const result=reviewFinancialEvidence({observations:[f.observation('d','100'),f.observation('a','200',{source_kind:'audit',...change})],calculations:[]},f.ctx);
    assert(result.findings.length);assert(result.findings.every(x=>x.conclusion!=='error'&&!x.repairability.can_revise));assert(result.coverage.every(c=>c.outcome!=='pass'));}
});
test('contradicting comparable sources retain both citations instead of selecting one',()=>{
  const f=reviewFixture();const result=reviewFinancialEvidence({observations:[f.observation('d','100'),f.observation('a','100',{source_kind:'audit'}),f.observation('b','110',{source_kind:'financial_statement'})],calculations:[]},f.ctx);
  assert.equal(result.findings[0]?.conclusion,'conflict');assert.deepEqual(result.findings[0]?.evidence_refs.map(r=>r.record_id).sort(),['a','b']);assert.equal(result.findings[0]?.repairability.can_revise,false);
});
test('parse uncertainty, missing context, same-document audit and unsupported units prevent pass',()=>{
  for(const kind of ['uncertainty','context','self','unit']){
    const f=reviewFixture(),d=f.observation('d','100'),a=f.observation('a','100',{source_kind:'audit'});
    if(kind==='uncertainty'){f.records.find(r=>r.record_id==='a')!.uncertainty=['ocr-digit'];a.value_refs[0]!.uncertainty=['ocr-digit'];}
    if(kind==='context')d.context_refs.period=[];
    if(kind==='self'){a.value_refs=d.value_refs;a.context_refs=d.context_refs;}
    if(kind==='unit')a.unit='USD million';
    const result=reviewFinancialEvidence({observations:[d,a],calculations:[]},f.ctx);assert(result.coverage.every(c=>c.outcome!=='pass'));assert(result.findings.every(c=>c.conclusion!=='error'));
  }
});
function formula(operation:ReviewFinancialCalculation['operation'],values:string[],result:string,options:{complete?:boolean;previous?:boolean;unit?:string}={}){
  const f=reviewFixture();const sources=values.map((v,i)=>f.observation(`a${i}`,v,{source_kind:'audit',unit:options.unit??'万元',...(options.previous&&i===1?{period:{start:'2024-01-01',end:'2024-12-31',as_of:null}}:{})}));
  const d=f.observation('d',result,{metric:'formula-result',unit:operation==='sum'?'万元':operation==='percentage_point'?'百分点':'%'});
  const calculation:ReviewFinancialCalculation={calculation_id:'formula',label:'Synthetic formula',operation,result_id:'d',operand_ids:sources.map(s=>s.observation_id),complete_terms:options.complete??true,relation_verification:'trusted_structured'};
  return {...f,observations:[d,...sources],calculation};
}
test('sum, ratios, growth and percentage points use deterministic formulas and final rounding',()=>{
  const cases=[formula('sum',['0.1','0.2'],'0.3'),formula('ratio_percent',['1','3'],'33.33'),formula('growth_percent',['120','100'],'20.00',{previous:true}),formula('percentage_point',['12.35','10.01'],'2.34',{unit:'%'})];
  for(const f of cases){const result=reviewFinancialEvidence({observations:f.observations,calculations:[f.calculation]},f.ctx);assert.equal(result.findings.length,0);assert(result.coverage.some(c=>c.check_id==='calculation:formula'&&c.outcome==='pass'));}
  const f=formula('sum',['100','20'],'12');const result=reviewFinancialEvidence({observations:f.observations,calculations:[f.calculation]},f.ctx);assert.equal(result.findings[0]?.suggested_change,'120');
});
test('incomplete sum, duplicate terms, zero/negative denominator and mixed interim growth are not hard errors',()=>{
  const incomplete=formula('sum',['1','2'],'3',{complete:false});const duplicate=formula('sum',['1','2'],'3');duplicate.calculation.operand_ids=['a0','a0'];
  const mixed=formula('growth_percent',['120','100'],'20.00',{previous:true});mixed.observations[2]!.period={start:'2024-01-01',end:'2024-06-30',as_of:null};
  for(const f of [incomplete,duplicate,mixed,formula('ratio_percent',['1','0'],'0'),formula('ratio_percent',['1','-1'],'-100')]){
    const result=reviewFinancialEvidence({observations:f.observations,calculations:[f.calculation]},f.ctx);assert(result.findings.every(c=>c.conclusion!=='error'));assert(result.coverage.every(c=>c.outcome!=='pass'));
  }
});
test('empty extraction is explicitly uncovered and duplicate IDs are rejected',()=>{
  const f=reviewFixture();assert.equal(reviewFinancialEvidence({observations:[],calculations:[]},f.ctx).coverage[0]?.outcome,'uncovered');
  const d=f.observation('d','1');assert.throws(()=>reviewFinancialEvidence({observations:[d,d],calculations:[]},f.ctx),/DUPLICATE_ID/);
});
