import test from 'node:test';
import assert from 'node:assert/strict';
import { hasReviewReportBody } from '@bondbuddy/contracts';
import { readDocxBodyText } from './docx-inspector.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';

test('empty or internal-progress Word is distinguishable from a substantive zero-finding report',()=>{
  for(const text of ['', 'BB_REVIEW_PROGRESS:read_materials:started', '```\nBB_REVIEW_PROGRESS:prepare_report:completed\n```']){
    const body=readDocxBodyText(makeSyntheticDocxFixture({text}));
    assert.notEqual(body,null);assert.equal(hasReviewReportBody(body!),false);
  }
  const text='已核对本轮材料，未发现需修改事项。公开信息未覆盖，需人工确认。';
  assert.equal(hasReviewReportBody(readDocxBodyText(makeSyntheticDocxFixture({text}))!),true);
  assert.equal(readDocxBodyText(Buffer.from('not a Word file')),null,'unreadable is distinct from proven empty');
});

test('a report may discuss progress markers without losing its actual explanation',()=>{
  assert.equal(hasReviewReportBody('说明：BB_REVIEW_PROGRESS:read_materials:started 是内部标记，不属于报告结论。'),true);
  assert.equal(hasReviewReportBody('BB_REVIEW_PROGRESS:read_materials:started\n\n已核对材料。'),true);
});
