// Synthetic rows verify linkage only; source evidence is never invented by the projection.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isReviewReport, type ReviewCheckCoverage, type ReviewFinding, type ReviewReport } from '@bondbuddy/contracts';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { referenceFor, reviewContentHash } from '../../../packages/domain/dist/review-evidence.js';
import { withReviewFollowUp } from './review-follow-up.js';

function fixture() {
  const f=reviewFixture();f.addRecord('selected','Synthetic selected issue');f.addRecord('retained','Synthetic retained issue');
  const refs=f.records.map(r=>referenceFor(r));
  const finding=(id:string,index:number):ReviewFinding=>({finding_id:id,report_id:'old-report',dimension:'financial',conclusion:'manual',severity:'P2',
    title:id,description:'Synthetic issue',target_refs:[refs[index]!],evidence_refs:[refs[index]!],limitations:[],
    repairability:{can_revise:false,reason:'Human verification required',allowed_record_ids:[]},origin_report_id:'old-report',check_status:'rechecked'});
  const previous:ReviewReport={report_id:'old-report',project_id:f.ctx.project_id,run_id:'old-run',input_revision:1,version:1,
    source_material:f.ctx.source_material,scope:{mode:'full_review',finding_ids:[]},findings:[finding('F1',0),finding('F2',1)],
    coverage:[],limitations:[],created_at:'2026-10-02T00:00:00Z'};
  const report:ReviewReport={...structuredClone(previous),report_id:'new-report',run_id:'new-run',version:2,input_revision:2,
    scope:{mode:'differential_review',finding_ids:['F1']},findings:[{...structuredClone(previous.findings[1]!),report_id:'new-report',check_status:'carried_forward'}]};
  const scope:ReviewCheckCoverage={check_id:'scope:F1',dimension:'financial',outcome:'pass',reason:'Actual explicit recheck passed',finding_ids:[],
    evidence_refs:[refs[0]!],rule_refs:[],origin_report_id:'new-report',check_status:'rechecked'};
  return {previous,report,scope,input:{scope:report.scope,previous_report:previous}};
}

test('explicit pass links resolved source finding and retains unselected provenance without mutating either report',()=>{
  const {previous,report,scope,input}=fixture();report.coverage.push(scope);const before=structuredClone({previous,report});
  const linked=withReviewFollowUp(report,input);
  assert.equal(isReviewReport(linked),true);assert.deepEqual({previous,report},before);
  assert.equal(linked.follow_up?.source_report_id,previous.report_id);assert.equal(linked.follow_up?.source_report_sha256,reviewContentHash(previous));
  assert.deepEqual(linked.follow_up?.findings.map(f=>[f.source_finding_id,f.status,f.outcome,f.current_finding_ids,f.coverage_check_ids]),
    [['F1','rechecked','resolved',[],['scope:F1']],['F2','carried_forward','carried_forward',['F2'],[]]]);
});

test('missing selected coverage and an unmapped selected target cannot be projected as resolved',()=>{
  for(const mode of ['missing','uncovered','pending'] as const){
    const {report,scope,input}=fixture();
    if(mode!=='missing')report.coverage.push({...scope,outcome:mode==='uncovered'?'uncovered':'manual'});
    if(mode==='pending')report.findings.push({...structuredClone(input.previous_report.findings[0]!),finding_id:'current-F1',report_id:'new-report',
      origin_report_id:'new-report',limitations:['selected_finding_not_independently_resolved']});
    const linked=withReviewFollowUp(report,input),row=linked.follow_up!.findings[0]!;
    assert.equal(row.status,'uncompleted');assert.equal(row.outcome,'uncovered');assert.equal(isReviewReport(linked),true);
  }
});

test('scope-linked current target retains its identity after a material moves and reports the actual issue',()=>{
  const {report,scope,input}=fixture(),current={...structuredClone(input.previous_report.findings[0]!),finding_id:'new-issue',report_id:'new-report',
    origin_report_id:'new-report',conclusion:'error' as const,target_refs:[]};
  report.findings.push(current);report.coverage.push({...scope,outcome:'issue',finding_ids:[current.finding_id]});
  const linked=withReviewFollowUp(report,input),row=linked.follow_up!.findings[0]!;
  assert.equal(row.outcome,'issue');assert.deepEqual(row.current_finding_ids,['new-issue']);assert.equal(isReviewReport(linked),true);
});

test('public recheck without actual sources remains incomplete and a sourced semantic check remains manual',()=>{
  for(const sources of [false,true]){
    const {previous,report,scope,input}=fixture();previous.findings[0]!.dimension='public';previous.findings[0]!.public_category='entity_control';
    report.findings.push({...structuredClone(previous.findings[0]!),report_id:'new-report',check_status:'carried_forward'});
    report.coverage.push({...scope,dimension:'public',outcome:'manual',finding_ids:['F1']});
    report.coverage.push({...scope,check_id:'public:entity_control',dimension:'public',outcome:sources?'manual':'uncovered',public_sources:sources?[{
      tool_call_id:'actual-search-event',tool:'web_search',url:'https://example.invalid/disclosure',title:'Synthetic public source',
      retrieved_at:'2026-10-02T00:00:00Z',published_at:null,entity:'Synthetic entity',as_of:null,quote:'Synthetic evidence',locator:'Actual returned search event',
      availability:'available',entity_match:'ambiguous'}]:[]});
    const linked=withReviewFollowUp(report,input),row=linked.follow_up!.findings[0]!;
    assert.equal(row.status,sources?'rechecked':'uncompleted');assert.equal(row.outcome,sources?'manual':'uncovered');
    assert.deepEqual(row.current_finding_ids,['F1']);assert.equal(isReviewReport(linked),true);
  }
});

test('follow-up schema refuses unrelated pass, fabricated crossrefs, missing selected lineage and lost retained rows',()=>{
  const {report,scope,input}=fixture();report.coverage.push(scope);const good=withReviewFollowUp(report,input);
  for(const mutate of [
    (r:ReviewReport)=>{r.scope.mode='full_review';},
    (r:ReviewReport)=>{r.follow_up!.source_report_id=r.report_id;},
    (r:ReviewReport)=>{r.follow_up!.findings[0]!.current_finding_ids=['foreign'];},
    (r:ReviewReport)=>{r.follow_up!.findings[0]!.coverage_check_ids=['foreign'];},
    (r:ReviewReport)=>{r.coverage[0]!.check_id='unrelated-pass';r.follow_up!.findings[0]!.coverage_check_ids=['unrelated-pass'];},
    (r:ReviewReport)=>{r.follow_up!.findings.shift();},
    (r:ReviewReport)=>{r.follow_up!.findings[1]!.current_finding_ids=[];},
    (r:ReviewReport)=>{r.follow_up!.findings[0]!.status='uncompleted';},
    (r:ReviewReport)=>{r.follow_up!.findings.push(structuredClone(r.follow_up!.findings[0]!));},
  ]){const bad=structuredClone(good);mutate(bad);assert.equal(isReviewReport(bad),false);}
});

test('legacy and full reports retain their original schema and identity',()=>{
  const {previous,report,input}=fixture();
  assert.equal(withReviewFollowUp(previous,{scope:previous.scope,previous_report:previous}),previous);
  assert.equal(withReviewFollowUp(report,{scope:input.scope,previous_report:undefined}),report);
  assert.equal(isReviewReport(previous),true);
});
