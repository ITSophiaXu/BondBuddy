import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {DocumentProjectionV1Schema,AuthoringWorkflowV1Schema,ChapterReceiptV1Schema} from './workflow-authoring-v1.js';

test('workflow rejects model completion claims and unrestricted output styles',()=>{
  assert.equal(Value.Check(ChapterReceiptV1Schema,{call_status:'done'}),false);
  assert.equal(Value.Check(AuthoringWorkflowV1Schema,{protocol_version:1,completed:['done']}),false);
  assert.equal(Value.Check(DocumentProjectionV1Schema,{version:'document-projection-v1',blocks:[{style_key:'external-xml'}]}),false);
});
