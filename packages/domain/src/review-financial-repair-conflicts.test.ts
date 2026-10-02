import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewFixture } from './review-test-fixtures.js';
import { validateReviewEvidence } from './review-evidence.js';
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
