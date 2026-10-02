import assert from 'node:assert/strict';
import test from 'node:test';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {inspectDocx,inspectGeneratedWord,GENERATED_WORD_DELIVERY_VERSION} from './docx-inspector.js';

test('large generated Word is downloadable without parsing the XML that the legacy inspector rejects',()=>{
  const bytes=makeSyntheticDocxFixture({text:'synthetic '.repeat(850000),stored:true});
  assert.deepEqual(inspectDocx(bytes).failure_codes,['DOCX_XML_SIZE_LIMIT']);
  const result=inspectGeneratedWord(bytes);
  assert.equal(result.quality_status,'passed');
  assert.equal(result.validator_version,GENERATED_WORD_DELIVERY_VERSION);
  assert.equal(result.content_review,'not_performed');
  assert.ok(Object.values(result.checks).every(s=>s==='not_run'));
});
test('missing or non-file output cannot be labelled as available Word',()=>{
  for(const bytes of [Buffer.alloc(0),Buffer.from('plain text, no Word file')])assert.equal(inspectGeneratedWord(bytes).quality_status,'failed');
});
