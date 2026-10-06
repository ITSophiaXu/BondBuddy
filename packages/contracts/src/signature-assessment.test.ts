import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { SignatureAssessmentSchema } from './index.js';

test('signature assessment keeps v1 immutable and bounds v2 without authenticity claims', () => {
  const v2 = {status:'signature_unverified',profile_version:'signed-pdf-multipage-v2',signature_count:4};
  assert.equal(Value.Check(SignatureAssessmentSchema,v2),true);
  assert.equal(Value.Check(SignatureAssessmentSchema,{...v2,profile_version:'signed-pdf-classic-v1',signature_count:1}),true);
  for(const value of [0,-1,1.5,1501,'4',null]) assert.equal(Value.Check(SignatureAssessmentSchema,{...v2,signature_count:value}),false);
  for(const change of [{status:'verified'},{extra:true},{profile_version:'signed-pdf-classic-v1'}])
    assert.equal(Value.Check(SignatureAssessmentSchema,{...v2,...change}),false);
});
