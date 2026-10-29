import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactDownloadName } from './artifact-filename.js';
const row={id:'r',version:1,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',naming_created_at:'2026-10-09T02:00:00Z',naming_manifest:{name:'冻结项目名'},naming_input_revision:5,naming_pair:{revision_artifact_id:'r',clean_artifact_id:'c'}};
test('workpaper download keeps original catalogue number and compact name; version stays metadata',()=>{
  assert.deepEqual(artifactDownloadName({...row,naming_m4_kind:'document',naming_m4_revision:4,naming_m4_manifest:{input:{workpaper:{entry:{path:'尽职调查/1-3 资产分析.docx'}}}}}),{filename:'1-3 资产分析.docx',display_version:4});
});

test('old workpaper metadata removes flattened annotations from the locked original title',()=>{
  const entry={code:'2-4-5',title:'受限资产说明（包括明细、原因与影响）',path:'2-4-5 受限资产说明及明细、原因与影响.docx'};
  const input={...row,naming_m4_kind:'document',naming_m4_revision:243,naming_m4_manifest:{input:{workpaper:{entry}}}};
  assert.deepEqual(artifactDownloadName(input),{filename:'2-4-5 受限资产说明.docx',display_version:243});
  assert.equal(entry.path,'2-4-5 受限资产说明及明细、原因与影响.docx');
});
test('authoring names use pinned input and variant, not mutable project fields or artifact version 1',()=>{
  assert.deepEqual(artifactDownloadName({...row,name:'已改名'}),{filename:'冻结项目名_募集书修订版_V5_20261009.docx',display_version:5});
  assert.equal(artifactDownloadName({...row,id:'c'}).filename,'冻结项目名_募集书清洁版_V5_20261009.docx');
});
test('review and material names agree across metadata and list row shapes',()=>{
  for(const shape of [{id:'r',version:1},{artifact_id:'r',artifact_version:1}]){
    assert.equal(artifactDownloadName({...row,...shape,naming_review_kind:'comments',naming_review_version:2}).filename,'冻结项目名_原文批注版_V2_20261009.docx');
    assert.equal(artifactDownloadName({...row,...shape,naming_manifest:{},naming_m4_manifest:{project_name:'材料项目'},naming_m4_kind:'document',naming_m4_type:'init',naming_m4_revision:3}).filename,'材料项目_立项报告_V3_20261009.docx');
  }
  assert.equal(artifactDownloadName({...row,naming_manifest:{issuer_name:'历史发行人'},naming_review_kind:'report',naming_review_version:2}).filename,'历史发行人_复核报告_V2_20261009.docx');
});
