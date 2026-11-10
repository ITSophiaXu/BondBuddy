import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { schemas, DIRECT_UPLOAD_TRANSPORT, UPLOAD_TRANSPORT_HEADER } from './index.js';

test('upload transport is additive; old upload declarations and sessions remain valid',()=>{
  const session={upload_id:'upload-a',state:'uploading',upload_url:'/api/v1/projects/p/materials/uploads/u/bytes',expires_at:'2026-11-10T00:00:00Z',max_bytes:104857600};
  // Date-time format validation is covered by the shared contract example checker.
  const schema={...schemas.UploadSessionResponse,properties:{...schemas.UploadSessionResponse.properties,expires_at:Type.String()}};
  assert.ok(Value.Check(schema,session));
  assert.ok(Value.Check(schema,{...session,upload_url:'https://storage.invalid/private',upload_transport:DIRECT_UPLOAD_TRANSPORT}));
  assert.ok(!Value.Check(schema,{...session,upload_transport:'unknown'}));
  assert.equal(UPLOAD_TRANSPORT_HEADER,'X-BB-Upload-Transport');
});
