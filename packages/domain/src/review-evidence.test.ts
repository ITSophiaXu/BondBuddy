import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReviewReport, type ReviewReport } from '../../contracts/dist/review-results.js';
import { referenceFor, validateReviewEvidence, validateReviewEvidenceBatch, validReviewLocator } from './review-evidence.js';
import { carryForwardReviewFindings, normalizeReviewFindings, reviewCoverage, type ReviewFindingCandidate } from './review-finding-normalization.js';
import { reviewFixture } from './review-test-fixtures.js';

test('evidence is pinned to owner, project, material, parser response, record, quote and exact locator',()=>{
  const f=reviewFixture(),record=f.addRecord('d','Synthetic literal 100'),ref=referenceFor(record);assert.deepEqual(validateReviewEvidence(ref,f.ctx,true),[]);
  for(const key of ['material_sha256','parse_response_sha256','record_sha256'] as const)assert(validateReviewEvidence({...ref,[key]:'f'.repeat(64)},f.ctx).length);
  for(const key of ['material_id','parse_snapshot_id','record_id'] as const)assert(validateReviewEvidence({...ref,[key]:'forged'},f.ctx).length);
  assert(validateReviewEvidence({...ref,quote:'not present'},f.ctx).length);assert(validateReviewEvidence({...ref,locator:{stable_ref:'other',path:[{paragraph:1}]}},f.ctx).length);
  assert(validateReviewEvidence(ref,{...f.ctx,owner_user_id:'another'}).length);assert(validateReviewEvidence(ref,{...f.ctx,project_id:'another'}).length);
  const evidence=referenceFor(f.addRecord('a','100',false));assert(validateReviewEvidence(evidence,f.ctx,true).includes('target_material_mismatch'));
});
test('models cannot erase OCR uncertainty or alter extraction method',()=>{
  const f=reviewFixture(),r=f.addRecord('ocr','100',true,{extraction_method:'ocr',uncertainty:['uncertain-digit']});const ref=referenceFor(r);
  assert.deepEqual(validateReviewEvidence(ref,f.ctx),[]);assert(validateReviewEvidence({...ref,uncertainty:[]},f.ctx).length);assert(validateReviewEvidence({...ref,extraction_method:'native_text'},f.ctx).length);
});
test('batch verification retains scope, exact pins, OCR warnings, duplicate ambiguity and quote failures',()=>{
  const f=reviewFixture(),a=f.addRecord('batch-a','Synthetic literal 100'),b=f.addRecord('batch-b','Synthetic OCR 200',true,{extraction_method:'ocr',uncertainty:['uncertain-digit']});
  const refs=[referenceFor(a),referenceFor(b),null,{...referenceFor(a),record_sha256:'f'.repeat(64)},
    {...referenceFor(a),quote:'not present'},{...referenceFor(b),uncertainty:[]},
    {...referenceFor(a),locator:{stable_ref:'wrong',path:[{paragraph:1}]}},
    {...referenceFor(a),locator:{stable_ref:'invalid',path:[{paragraph:0}]}}];
  assert.deepEqual(validateReviewEvidenceBatch(refs,f.ctx),refs.map(ref=>validateReviewEvidence(ref,f.ctx)));
  f.records.push({...a});
  assert.deepEqual(validateReviewEvidenceBatch([referenceFor(a)],f.ctx),[['evidence_pin_missing_or_ambiguous']]);
  assert.deepEqual(validateReviewEvidenceBatch([referenceFor(b)],{...f.ctx,owner_user_id:'another'}),[['evidence_pin_missing_or_ambiguous']]);
  const supporting=f.addRecord('batch-support','Synthetic support',false);
  assert.deepEqual(validateReviewEvidenceBatch([referenceFor(supporting)],f.ctx,true),[['target_material_mismatch']]);
});
test('batch verification rebuilds its index after trusted input changes',()=>{
  const f=reviewFixture(),record=f.addRecord('batch-changing','Synthetic 100'),ref=referenceFor(record);
  assert.deepEqual(validateReviewEvidenceBatch([ref],f.ctx),[[]]);
  record.record_sha256='f'.repeat(64);
  assert.deepEqual(validateReviewEvidenceBatch([ref],f.ctx),[['evidence_pin_missing_or_ambiguous']]);
});
test('large document evidence verification completes as one indexed batch',{timeout:10000},()=>{
  const f=reviewFixture();
  for(let i=0;i<12000;i++)f.addRecord(`large-${i}`,`Synthetic document line ${i}`);
  const result=validateReviewEvidenceBatch(f.ctx.records.map(record=>referenceFor(record)),f.ctx);
  assert.equal(result.length,12000);assert(result.every(errors=>errors.length===0));
});
test('actual DOCX column paths and native PDF bbox objects are accepted; malformed positions are rejected',()=>{
  assert(validReviewLocator({locator_type:'docx_block',locator:{stable_ref:'t1r1c1',path:[{table:1},{row:1,column:1}]}}));
  assert(validReviewLocator({locator_type:'pdf_bbox',locator:{page:1,bbox:{x0:-10,top:1,x1:10,bottom:30}}}));
  assert(!validReviewLocator({locator_type:'pdf_bbox',locator:{page:1,bbox:[0,0,10,10]}}));
  assert(!validReviewLocator({locator_type:'docx_block',locator:{stable_ref:'p0',path:[{paragraph:0}]}}));
});
const candidate=(f:ReturnType<typeof reviewFixture>):ReviewFindingCandidate=>({stable_key:'synthetic-issue',dimension:'financial',conclusion:'error',severity:'P1',title:'Synthetic difference',description:'Same metric differs',target_refs:[referenceFor(f.addRecord('d1','100'))],evidence_refs:[referenceFor(f.addRecord('a','200',false))],suggested_change:'200',can_revise:true,verification:'deterministic'});
test('stable finding IDs survive input ordering and report versions, while duplicate positions are retained',()=>{
  const f=reviewFixture(),one=candidate(f),two={...one,target_refs:[referenceFor(f.addRecord('d2','100'))]};const first=normalizeReviewFindings([one,two],f.ctx);
  assert.equal(first.length,1);assert.equal(first[0]?.target_refs.length,2);assert.deepEqual(first,normalizeReviewFindings([two,one],f.ctx));
  assert.equal(first[0]?.finding_id,normalizeReviewFindings([one],{...f.ctx,report_id:'report-next'})[0]?.finding_id);
});
test('unverified model errors and ambiguous suggestions are not repairable',()=>{
  const f=reviewFixture(),one=candidate(f);const raw=normalizeReviewFindings([{...one,verification:'model_only'}],f.ctx)[0]!;
  assert.equal(raw.conclusion,'manual');assert.equal(raw.repairability.can_revise,false);
  const conflict=normalizeReviewFindings([one,{...one,suggested_change:'300'}],f.ctx)[0]!;assert.equal(conflict.repairability.can_revise,false);assert.equal(conflict.suggested_change,undefined);assert(conflict.limitations.includes('conflicting_suggested_changes'));
  const tampered=normalizeReviewFindings([{...one,target_refs:[{...one.target_refs[0]!,quote:'not in document'}]}],f.ctx)[0]!;assert.equal(tampered.conclusion,'manual');assert.equal(tampered.target_refs.length,0);
});
test('differential reports distinguish carried-forward results and validate selection IDs',()=>{
  const f=reviewFixture(),one=candidate(f),findings=normalizeReviewFindings([one,{...one,stable_key:'second'}],f.ctx);
  const carried=carryForwardReviewFindings(findings,[findings[0]!.finding_id],'report-2');assert.equal(carried.length,1);assert.equal(carried[0]?.origin_report_id,f.ctx.report_id);assert.equal(carried[0]?.check_status,'carried_forward');assert.equal(carried[0]?.repairability.can_revise,false);
  assert.throws(()=>carryForwardReviewFindings(findings,['absent'],'report-2'),/UNKNOWN_FINDING/);
});
test('report contract checks origin, duplicates, repair targets, calendar dates and public source schema',()=>{
  const f=reviewFixture(),findings=normalizeReviewFindings([candidate(f)],f.ctx);const report:ReviewReport={report_id:f.ctx.report_id,project_id:f.ctx.project_id,run_id:'synthetic-run',input_revision:1,version:1,source_material:f.ctx.source_material,scope:{mode:'full_review',finding_ids:[]},findings,coverage:[reviewCoverage(f.ctx,'check','financial','issue','Synthetic check',findings[0]!.evidence_refs,findings)],limitations:[],created_at:'2026-09-24T02:00:00Z'};
  assert(isReviewReport(report));assert(!isReviewReport({...report,findings:[...findings,...findings]}));assert(!isReviewReport({...report,created_at:'2026-02-30T02:00:00Z'}));
  const wrong=structuredClone(report);wrong.findings[0]!.repairability.allowed_record_ids=['unrelated'];assert(!isReviewReport(wrong));
  const unknown=structuredClone(report);unknown.coverage[0]!.finding_ids=['absent'];assert(!isReviewReport(unknown));
  const stale=structuredClone(report);stale.findings[0]!.check_status='carried_forward';assert(!isReviewReport(stale));
  const publicReport=structuredClone(report);publicReport.coverage.push({...reviewCoverage(f.ctx,'public','public','pass','Synthetic tool evidence',[]),public_sources:[{tool:'web_search',tool_call_id:'synthetic-call',url:'https://example.invalid/source',title:'Synthetic',retrieved_at:'2026-09-24T02:00:00Z',published_at:null,entity:'Synthetic issuer',as_of:null,quote:'Synthetic quote',locator:'tool-result-1',availability:'available',entity_match:'confirmed'}]});assert(isReviewReport(publicReport));
});
