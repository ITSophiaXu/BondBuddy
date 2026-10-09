import assert from 'node:assert/strict';
import test from 'node:test';
import { resultFilename } from './artifact-filename.js';
const base={project:'合成发行项目',kind:'募集书修订版',version:3,createdAt:'2026-10-09T16:01:00Z',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
test('uses frozen generation date in Shanghai, logical version and distinct kind',()=>{
  assert.equal(resultFilename(base),'合成发行项目_募集书修订版_V3_20261010.docx');
  assert.notEqual(resultFilename(base),resultFilename({...base,kind:'募集书清洁版'}));
  assert.notEqual(resultFilename(base),resultFilename({...base,version:4}));
  assert.equal(resultFilename({...base,createdAt:new Date(base.createdAt)}),resultFilename(base));
});
test('preserves Unicode, caps bytes, and removes unsafe path and control characters',()=>{
  const name=resultFilename({...base,project:' .'+('超长中文😀/\\:*?"<>|\r\n\u202e'.repeat(40)),kind:'原文批注版'});
  assert.ok(Buffer.byteLength(name,'utf8')<240);
  assert.doesNotMatch(name,/[\\/:*?"<>|\x00-\x1f\u202e]/);
  assert.match(name,/中文/); assert.ok(!name.includes('\ufffd')); assert.match(name,/_原文批注版_V3_20261010.docx$/);
});
test('extension follows delivered media and legacy metadata never uses download time',()=>{
  for(const [mediaType,extension] of [['application/pdf','pdf'],['text/plain; charset=utf-8','txt'],['application/json','json']])
    assert.ok(resultFilename({...base,mediaType}).endsWith('.'+extension));
  assert.equal(resultFilename({mediaType:'unknown/type'}),'项目成果_成果_V1_日期未记录.bin');
  assert.equal(resultFilename({...base,createdAt:'invalid'}),'合成发行项目_募集书修订版_V3_日期未记录.docx');
});
