import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewComplianceEvidence, type ReviewComplianceInput, type ReviewRuleAssessment } from './review-compliance-checks.js';
import { referenceFor } from './review-evidence.js';
import { reviewFixture, syntheticReviewPack, syntheticRuleContext } from './review-test-fixtures.js';

async function fixture(){
  const f=reviewFixture(),{pack,ref}=await syntheticReviewPack();f.ctx.rules=[ref];
  const target=referenceFor(f.addRecord('d','Synthetic prospectus clause.'));
  const input:ReviewComplianceInput={context:syntheticRuleContext,packs:[pack],assessments:[],formatting_requirements:[],formatted_records:[]};
  const assessment:ReviewRuleAssessment={check_id:'synthetic-check',rule_id:ref.rule_id,pack_id:ref.pack_id,outcome:'pass',title:'Synthetic clause check',description:'Synthetic expected clause is present.',target_refs:[target],evidence_refs:[target],rule_refs:[ref],evaluation_method:'structured_checker',claims_document_absence:false,complete_document_examined:true};
  return {...f,input,assessment,ref,target};
}
test('eligible but unexecuted rules and missing formatting requirements remain explicitly uncovered',async()=>{
  const f=await fixture(),result=reviewComplianceEvidence(f.input,f.ctx);assert(result.coverage.some(c=>c.check_id.endsWith(':not-run')&&c.outcome==='uncovered'));assert(result.coverage.some(c=>c.check_id==='formatting:requirements-missing'&&c.outcome==='uncovered'));assert(result.coverage.every(c=>c.outcome!=='pass'));
});
test('exact market/offering/stage gates prohibit public-all, private and DFI fallback',async()=>{
  for(const context of [{...syntheticRuleContext,offering:'private' as const},{...syntheticRuleContext,market:'nafmii' as const,offering:'dfi' as const},{...syntheticRuleContext,document_stage:'unknown' as const},{...syntheticRuleContext,as_of:'2025-01-01'}]){
    const f=await fixture();f.input.context=context;f.input.assessments=[f.assessment];const result=reviewComplianceEvidence(f.input,f.ctx);assert(result.coverage.every(c=>c.outcome!=='pass'));assert.equal(result.findings.length,0);
  }
});
test('unpublished, withdrawn, changed or absent packs cannot produce compliance pass',async()=>{
  for(const mode of ['draft','withdrawn','tampered','missing']){
    const f=await fixture();if(mode==='missing')f.input.packs=[];else if(mode==='draft')f.input.packs[0]!.status='draft';else if(mode==='withdrawn')f.input.packs[0]!.status='withdrawn';else f.input.packs[0]!.rules[0]!.title='tampered after release';
    f.input.assessments=[f.assessment];const result=reviewComplianceEvidence(f.input,f.ctx);assert(result.coverage.every(c=>c.outcome!=='pass'));
  }
});
test('structured proven checks may pass; raw model pass, issue and nonapplicability remain manual',async()=>{
  const f=await fixture();f.input.assessments=[f.assessment];assert.equal(reviewComplianceEvidence(f.input,f.ctx).coverage.find(c=>c.check_id==='synthetic-check')?.outcome,'pass');
  for(const outcome of ['pass','issue','not_applicable'] as const){f.input.assessments=[{...f.assessment,evaluation_method:'model',outcome,suggested_change:'Synthetic proposed text'}];const result=reviewComplianceEvidence(f.input,f.ctx);assert.equal(result.coverage.find(c=>c.check_id==='synthetic-check')?.outcome,'manual');assert.equal(result.findings[0]?.repairability.can_revise,false);}
});
test('excerpt absence, fabricated citations and mismatched rule source prevent definitive legal findings',async()=>{
  const f=await fixture();for(const a of [{...f.assessment,outcome:'issue' as const,claims_document_absence:true,complete_document_examined:false},{...f.assessment,rule_refs:[{...f.ref,quote:'Fabricated law'}]},{...f.assessment,evidence_refs:[{...f.target,quote:'Fabricated source'}]}]){
    f.input.assessments=[a];const result=reviewComplianceEvidence(f.input,f.ctx);assert.equal(result.coverage.find(c=>c.check_id==='synthetic-check')?.outcome,'manual');assert(result.findings.every(x=>x.conclusion!=='error'));
  }
});
test('DOCX inherited properties use explicit template requirements and do not claim legal violation',async()=>{
  const f=await fixture();const template={...f.ref,authority:'template' as const};f.ctx.rules=[template];f.input.packs=[];
  f.input.formatting_requirements=[{check_id:'font',record_ids:['d'],rule_ref:template,property:'east_asia_font',expected:'宋体'}];
  f.input.formatted_records=[{ref:f.target,formatting:{style:'BodyText',runs:[{east_asia_font:'宋体',east_asia_theme:null,half_points:'24',sample:'中文',characters:2}]}}];
  assert.equal(reviewComplianceEvidence(f.input,f.ctx).coverage.find(c=>c.check_id==='font')?.outcome,'pass');
  f.input.formatted_records[0]!.formatting.runs=[{east_asia_font:'黑体',east_asia_theme:null,half_points:'24',sample:'中文',characters:2}];
  const result=reviewComplianceEvidence(f.input,f.ctx);assert(result.findings[0]?.title.includes('模板'));assert.equal(result.findings[0]?.conclusion,'error');assert(result.findings[0]?.description.includes('不表示实际字体环境或视觉分页已验证'));
});
test('theme fonts, missing inherited values, PDF and rendered layout are not visual passes',async()=>{
  for(const mode of ['theme','missing','pdf','layout']){
    const f=await fixture();f.input.formatting_requirements=[{check_id:'format',record_ids:['d'],rule_ref:f.ref,property:mode==='layout'?'rendered_layout':'east_asia_font',expected:'宋体'}];
    f.input.formatted_records=[{ref:f.target,formatting:{runs:[{east_asia_font:mode==='missing'?null:'宋体',east_asia_theme:mode==='theme'?'minorEastAsia':null}]}}];
    if(mode==='pdf'){const record=f.records[0]!;record.locator_type='pdf_bbox';record.locator={page:1,bbox:{x0:0,top:0,x1:100,bottom:30}};f.input.formatted_records[0]!.ref=referenceFor(record);}
    assert.equal(reviewComplianceEvidence(f.input,f.ctx).coverage.find(c=>c.check_id==='format')?.outcome,'uncovered');
  }
});
test('known style discrepancy is retained alongside unknown portions and cannot become a full pass',async()=>{
  const f=await fixture();f.input.formatting_requirements=[{check_id:'format',record_ids:['d'],rule_ref:f.ref,property:'half_points',expected:'24'}];
  f.input.formatted_records=[{ref:f.target,formatting:{runs:[{half_points:'22'},{half_points:null}]}}];const result=reviewComplianceEvidence(f.input,f.ctx);
  assert.equal(result.findings[0]?.conclusion,'error');assert.equal(result.coverage.find(c=>c.check_id==='format')?.outcome,'uncovered');
});

test('heading levels use resolved paragraph attributes; old snapshots and style names cannot imply a level',async()=>{
  const f=await fixture();const standard={...f.ref,authority:'internal_method' as const};f.ctx.rules=[standard];f.input.packs=[];
  f.input.formatting_requirements=[{check_id:'outline',record_ids:['d'],rule_ref:standard,property:'outline_level',expected:'1'}];
  for(const [formatting,outcome] of [
    [{outline_level:'1'},'pass'],[{outline_level:'3'},'issue'],[{outline_level:'body'},'issue'],
    [{style:'Heading 1'},'uncovered'],[{outline_level:null},'uncovered'],[{outline_level:'10'},'uncovered'],
  ] as const){
    f.input.formatted_records=[{ref:f.target,formatting}];const result=reviewComplianceEvidence(f.input,f.ctx);
    assert.equal(result.coverage.find(c=>c.check_id==='outline')?.outcome,outcome,JSON.stringify(formatting));
    assert.equal(result.findings.length,outcome==='issue'?1:0);
    if(result.findings.length){assert.equal(result.findings[0]!.repairability.can_revise,false);assert.match(result.findings[0]!.title,/用户指定/);}
  }
});
test('fixed ledger sources with unknown project applicability retain cited manual observations only',async()=>{
  const f=await fixture();f.input.context=null;const unknown={...f.ref,applicability:'unknown' as const};f.ctx.rules=[unknown];
  f.input.assessments=[{...f.assessment,rule_refs:[unknown],evaluation_method:'model',outcome:'pass'}];
  const result=reviewComplianceEvidence(f.input,f.ctx);assert.equal(result.findings[0]?.conclusion,'manual');assert.equal(result.findings[0]?.rule_refs?.[0]?.applicability,'unknown');
  assert(result.coverage.every(c=>c.outcome!=='pass'));assert.equal(result.findings[0]?.repairability.can_revise,false);
});
