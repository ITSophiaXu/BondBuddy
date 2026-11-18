import assert from 'node:assert/strict';
import test from 'node:test';
import type {QaAnswer, QaResult} from './billing-types.js';
import {qaCitationDetails} from './qa-citations.js';

const result = {
  evidence: [{
    filename: '合成材料.docx',
    snapshot: {
      sha256: 'a'.repeat(64),
      spans: [{id: 'p1', text: '金额 5 亿元', location: '表格 1 / 行 2'}]
    }
  }]
} as unknown as QaResult;
const answer = {
  citations: [{asset_index: 0, span_id: 'p1', quote: '金额 5 亿元'}]
} as unknown as QaAnswer;

test('citation details expose filename, location, quote and material version outside the answer body', () => {
  const html = qaCitationDetails(result, answer);
  assert.match(html, /依据 1 处/);
  assert.match(html, /合成材料\.docx/);
  assert.match(html, /表格 1 \/ 行 2/);
  assert.match(html, /金额 5 亿元/);
  assert.match(html, /材料 aaaaaaaaaaaa/);
});

test('answers without citations render no empty disclosure', () => {
  assert.equal(qaCitationDetails(result, {citations: []} as unknown as QaAnswer), '');
});
