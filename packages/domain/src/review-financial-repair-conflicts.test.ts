import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewFixture } from './review-test-fixtures.js';
import { referenceFor, validateReviewEvidence } from './review-evidence.js';
import { reviewFinancialEvidence, type ReviewFinancialObservation } from './review-financial-checks.js';
import { normalizeReviewFindings, reviewCoverage } from './review-finding-normalization.js';
import { guardFinancialRepairConflicts } from './review-financial-repair-conflicts.js';

function fixture(values:string[]){
  const f=reviewFixture(),d=f.observation('d','10.00'),a=f.observation('a','110.00',{source_kind:'audit'});
  const findings=values.flatMap((expected,i)=>normalizeReviewFindings([{stable_key:`method${i}`,dimension:'financial',conclusion:'error',severity:'P1',title:`method${i}`,description:'Synthetic deterministic repair proposal.',target_refs:d.value_refs,evidence_refs:a.value_refs,
    suggested_change:expected,can_revise:true,verification:'deterministic',calculation:{expression:`method${i}`,operands:['a'],expected,observed:'10.00',unit:'万元',rounding:'Synthetic fixture.'}}],f.ctx));
  return {f,evaluation:{findings,coverage:findings.map(item=>reviewCoverage(f.ctx,item.finding_id,'financial','issue','Synthetic check.',item.evidence_refs,[item])),limitations:[]}};
}
test('conflicting source-comparison and formula proposals retain chains and disable all repairs',()=>{
  const {f,evaluation}=fixture(['110.00','120.00']);const result=guardFinancialRepairConflicts(evaluation,f.ctx);
  assert.equal(result.findings.length,2);assert(result.findings.every(item=>item.conclusion==='conflict'&&!item.repairability.can_revise&&!item.suggested_change));
  assert.deepEqual(result.findings.map(item=>item.calculation?.expected),['110.00','120.00']);
  assert(result.coverage.every(check=>check.finding_ids.every(id=>result.findings.some(item=>item.finding_id===id))));
});
test('different display precision of the same numeric suggestion is not a proposal conflict',()=>{
  const {f,evaluation}=fixture(['110.00','110']);assert.equal(guardFinancialRepairConflicts(evaluation,f.ctx),evaluation);
});
test('different valid quotes of one trusted original amount cannot bypass proposal conflict protection',()=>{
  const {f,evaluation}=fixture(['110.00','120.00']);
  evaluation.findings[1]!.target_refs[0]={...evaluation.findings[1]!.target_refs[0]!,quote:'10.00'};
  assert.notEqual(evaluation.findings[0]!.target_refs[0]!.quote,evaluation.findings[1]!.target_refs[0]!.quote);
  assert(evaluation.findings.every(item=>validateReviewEvidence(item.target_refs[0]!,f.ctx,true).length===0));
  const result=guardFinancialRepairConflicts(evaluation,f.ctx);
  assert.equal(result.findings.length,2);
  assert(result.findings.every(item=>item.conclusion==='conflict'&&!item.repairability.can_revise&&!item.suggested_change));
  assert.deepEqual(result.findings.map(item=>item.calculation?.expected),['110.00','120.00']);
  assert(result.coverage.every(check=>check.outcome==='issue'&&check.finding_ids.every(id=>result.findings.some(item=>item.finding_id===id))));
});

function independentlyChecked(sources:string[]){
  const f=reviewFixture(),target=f.observation('target','100.00'),left=f.observation('left','80.00',{metric:'left'}),right=f.observation('right','30.00',{metric:'right'});
  const observations=[target,left,right,...sources.map((value,i)=>f.observation('audit-'+i,value,{source_kind:'audit'}))];
  const calculation={calculation_id:'authored-sum',label:'Explicit sum',operation:'sum' as const,result_id:target.observation_id,operand_ids:[left.observation_id,right.observation_id],complete_terms:true,relation_verification:'trusted_structured' as const};
  const evaluation=reviewFinancialEvidence({observations,calculations:[calculation]},f.ctx);
  const targets=new Map([['compare:target',target],['calculation:authored-sum',target]]);
  return {f,target,evaluation,targets};
}

test('a real independent pass blocks a competing sum and replaces the pass coverage with its linked conflict',()=>{
  const {f,evaluation,targets}=independentlyChecked(['100.00']);
  assert.equal(evaluation.coverage.find(c=>c.check_id==='compare:target')?.outcome,'pass');
  assert.equal(evaluation.findings.find(c=>c.calculation?.expression==='sum')?.suggested_change,'110.00');
  const result=guardFinancialRepairConflicts(evaluation,f.ctx,targets);
  const sum=result.findings.find(c=>c.calculation?.expression==='sum')!;
  assert.equal(sum.conclusion,'conflict');assert.equal(sum.suggested_change,undefined);assert.equal(sum.repairability.can_revise,false);
  assert(sum.limitations.includes('financial_repair_blocked_by_verified_pass'));
  assert(sum.evidence_refs.some(r=>r.record_id==='audit-0'));
  const pass=result.coverage.find(c=>c.check_id==='compare:target')!;
  assert.equal(pass.outcome,'issue');assert(pass.finding_ids.includes(sum.finding_id));
  assert(result.coverage.find(c=>c.check_id==='calculation:authored-sum')!.finding_ids.includes(sum.finding_id));
});

test('a source conflict without a calculation blocks a native proposal matching one source',()=>{
  const {f,evaluation,targets}=independentlyChecked(['110.00','120.00']);
  const source=evaluation.findings.find(c=>c.conclusion==='conflict')!;assert(source);assert.equal(source.calculation,undefined);
  const result=guardFinancialRepairConflicts(evaluation,f.ctx,targets),sum=result.findings.find(c=>c.calculation?.expression==='sum')!;
  assert.equal(sum.conclusion,'conflict');assert.equal(sum.repairability.can_revise,false);assert.equal(sum.suggested_change,undefined);
  assert(sum.limitations.includes('financial_repair_blocked_by_source_conflict'));
  assert.deepEqual(sum.evidence_refs.filter(r=>r.record_id.startsWith('audit-')).map(r=>r.record_id).sort(),['audit-0','audit-1']);
  assert(result.coverage.every(c=>c.finding_ids.every(id=>result.findings.some(finding=>finding.finding_id===id))));
});

test('an ordinary missing source or unverified binding cannot cancel a valid deterministic sum',()=>{
  const missing=independentlyChecked([]);
  assert.equal(guardFinancialRepairConflicts(missing.evaluation,missing.f.ctx,missing.targets),missing.evaluation);
  const unverified=independentlyChecked(['100.00']);unverified.target.context_verification='unverified';
  assert.equal(guardFinancialRepairConflicts(unverified.evaluation,unverified.f.ctx,unverified.targets),unverified.evaluation);
  const carried=independentlyChecked(['100.00']);carried.evaluation.coverage.find(c=>c.check_id==='compare:target')!.check_status='carried_forward';
  assert.equal(guardFinancialRepairConflicts(carried.evaluation,carried.f.ctx,carried.targets),carried.evaluation);
});

test('a verified pass for a different result does not block the proposal merely because it cites the target as an operand',()=>{
  const {f,target,evaluation,targets}=independentlyChecked([]),other=f.observation('other','130.00',{metric:'other'});
  evaluation.coverage.push(reviewCoverage(f.ctx,'other-sum','financial','pass','Verified other result.',[...other.value_refs,...target.value_refs]));
  targets.set('other-sum',other);
  assert.equal(guardFinancialRepairConflicts(evaluation,f.ctx,targets),evaluation);
});

test('distinct amounts in one record and equal converted amounts with different original units never collide',()=>{
  for(const pair of [['100.00','万元','110.00','10.00','万元','11.00'],['1.00','万元','2.00','10000.00','元','30000.00']] as const){
    const f=reviewFixture(),[one,oneUnit,oneExpected,two,twoUnit,twoExpected]=pair;
    const ref=referenceFor(f.addRecord('shared',`合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 营业收入 ${one} ${oneUnit}，净利润 ${two} ${twoUnit}。`));
    const observations:ReviewFinancialObservation[]=[f.observation('first',one,{metric:'revenue',unit:oneUnit}),f.observation('second',two,{metric:'profit',unit:twoUnit})];
    for(const o of observations){o.value_refs=[ref];o.context_refs={entity:[ref],period:[ref],accounting_scope:[ref],currency:[ref],unit:[ref],basis:[ref]};}
    observations.push(f.observation('a',oneExpected,{metric:'revenue',unit:oneUnit,source_kind:'audit'}),f.observation('b',twoExpected,{metric:'profit',unit:twoUnit,source_kind:'audit'}));
    const evaluation=reviewFinancialEvidence({observations,calculations:[]},f.ctx);
    assert.equal(evaluation.findings.length,2);assert(evaluation.findings.every(f=>f.repairability.can_revise));
    assert.equal(guardFinancialRepairConflicts(evaluation,f.ctx,new Map(observations.slice(0,2).map(o=>['compare:'+o.observation_id,o]))),evaluation);
  }
});

test('a contextual value ref without the observed numeral cannot create a blocking destination',()=>{
  const {f,target,evaluation,targets}=independentlyChecked([]),other=f.observation('other','100.00',{metric:'other'});
  // A broad value-ref array can contain secondary context; only the independently valid value ref is a destination.
  const nonValue=referenceFor(f.addRecord('context-only','同表的说明，不含原数值。'));
  other.value_refs.push(nonValue);
  const proposal=evaluation.findings.find(c=>c.calculation?.expression==='sum')!;
  proposal.target_refs.push(nonValue);
  evaluation.coverage.push(reviewCoverage(f.ctx,'other-pass','financial','pass','Other valid result.',[...other.value_refs,...target.value_refs]));
  targets.set('other-pass',other);
  assert.equal(guardFinancialRepairConflicts(evaluation,f.ctx,targets),evaluation);
});

test('equal numerals and units in one broad record remain conservatively blocked without trusted token offsets',()=>{
  const f=reviewFixture(),ref=referenceFor(f.addRecord('shared','合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入 10.00，净利润 10.00。'));
  const disclosures=[f.observation('revenue','10.00',{metric:'revenue'}),f.observation('profit','10.00',{metric:'profit'})];
  for(const o of disclosures){o.value_refs=[ref];o.context_refs={entity:[ref],period:[ref],accounting_scope:[ref],currency:[ref],unit:[ref],basis:[ref]};}
  const sources=[f.observation('a','110.00',{metric:'revenue',source_kind:'audit'}),f.observation('b','120.00',{metric:'profit',source_kind:'audit'})];
  const evaluation=reviewFinancialEvidence({observations:[...disclosures,...sources],calculations:[]},f.ctx);
  assert.equal(evaluation.findings.length,2);assert(evaluation.findings.every(f=>f.repairability.can_revise));
  const result=guardFinancialRepairConflicts(evaluation,f.ctx,new Map(disclosures.map(o=>['compare:'+o.observation_id,o])));
  assert(result.findings.every(f=>f.conclusion==='conflict'&&!f.repairability.can_revise&&f.suggested_change===undefined));
});
