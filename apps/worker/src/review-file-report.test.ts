import test from 'node:test';
import assert from 'node:assert/strict';
import {type ReviewEditorSnapshot,isReviewReport,ReviewEditorSnapshotSchema} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {fileReviewReport} from './review-file-report.js';
const editor:ReviewEditorSnapshot={version:'review-editor-v1',source_filename:'synthetic.docx',source_format:'docx',source_sha256:'a'.repeat(64),warnings:[],paragraphs:[],issues:[{id:'R001',decision:'suggested',manual_text:'',category:'财务数据一致性',title:'合成金额差异',original:'100',replacement:'120',reason:'须核对依据',evidence:'合成附件',missing:'',uncertain:false,paragraph_id:null,applied:true,limitation:''}]};
const input={reportId:'report-1',projectId:'project-1',runId:'run-1',inputRevision:1,version:1,source:{material_id:'material-1',material_version:1,sha256:'a'.repeat(64)},operation:'full_review' as const,findingIds:[],createdAt:'2026-11-17T00:00:00.000Z'};
test('editor keeps optional source location and remains compatible with immutable old snapshots',()=>{
 assert.ok(Value.Check(ReviewEditorSnapshotSchema,editor));
 const next=structuredClone(editor);next.issues[0]!.original_location='第五节「财务情况」—「期间费用表」';
 assert.ok(Value.Check(ReviewEditorSnapshotSchema,next));
 assert.ok(isReviewReport(fileReviewReport(input,next)));
 assert.equal(Value.Check(ReviewEditorSnapshotSchema,{...next,unexpected:true}),false);
});
test('file report keeps editor IDs and never invents trusted evidence or automated repair',()=>{
 const r=fileReviewReport(input,editor);assert.ok(isReviewReport(r));assert.equal(r.findings[0]!.finding_id,'R001');assert.equal(r.findings[0]!.conclusion,'manual');assert.deepEqual(r.findings[0]!.evidence_refs,[]);assert.equal(r.findings[0]!.repairability.can_revise,false);
});
test('missing differential issue is uncompleted, never assumed resolved',()=>{
 const r=fileReviewReport({...input,operation:'differential_review',sourceReportId:'source-report',sourceReportSha256:'b'.repeat(64),findingIds:['R001','R002']},editor);assert.ok(isReviewReport(r));assert.equal(r.follow_up!.findings[0]!.status,'uncompleted','same local R001 does not prove cross-edition identity');assert.equal(r.follow_up!.findings[1]!.status,'uncompleted');assert.equal(r.follow_up!.findings[1]!.outcome,'uncovered');
});

