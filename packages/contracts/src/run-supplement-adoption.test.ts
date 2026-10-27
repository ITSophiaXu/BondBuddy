import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { openApiDocument } from './index.js';
import { RunSupplementAdoptRequestSchema, RunSupplementAdoptionQuerySchema, RunSupplementAdoptionResponseSchema } from './run-supplement-adoption.js';

const hash = 'a'.repeat(64);
const request = {request_id:'synthetic-adopt-request',quote_id:'synthetic-quote',confirmation_id:'synthetic-confirmation',quote_hash:hash};
const receipt = {adoption_id:'synthetic-adoption',...request,project_id:'synthetic-project',run_id:'synthetic-run',job_id:'synthetic-job',
  execution_version:2,input_revision:3,input_hash:hash,adopted_at:'2026-10-27T02:00:00Z'};

test('adoption requires exact quote and confirmation without caller-supplied financial or execution authority', () => {
  assert.equal(Value.Check(RunSupplementAdoptRequestSchema,request),true);
  for (const field of ['request_id','quote_id','confirmation_id','quote_hash']) {
    const invalid = {...request} as Record<string,unknown>; delete invalid[field];
    assert.equal(Value.Check(RunSupplementAdoptRequestSchema,invalid),false,field);
  }
  for (const field of ['points','total_points','plan_id','execution_version','input_revision','billing_segment_id','test_grant_id'])
    assert.equal(Value.Check(RunSupplementAdoptRequestSchema,{...request,[field]:'untrusted'}),false,field);
  assert.equal(Value.Check(RunSupplementAdoptRequestSchema,{...request,quote_hash:hash.toUpperCase()}),false);
  assert.equal(Value.Check(RunSupplementAdoptionQuerySchema,{request_id:request.request_id}),true);
  assert.equal(Value.Check(RunSupplementAdoptionQuerySchema,{}),false);
});

test('adoption receipt distinguishes independent positive rework, original-fee carry and unbilled zero additions', () => {
  for (const billing of [
    {assignment_kind:'rework',additional_points:4500,billing_segment_id:'synthetic-fee',reservation_id:'synthetic-fee'},
    {assignment_kind:'carry',additional_points:0,billing_segment_id:'synthetic-original-fee',reservation_id:'synthetic-original-fee'},
    {assignment_kind:'unbilled',additional_points:0,billing_segment_id:null,reservation_id:null},
  ]) assert.equal(Value.Check(RunSupplementAdoptionResponseSchema,{adoption:{...receipt,...billing}}),true);
  for (const billing of [
    {assignment_kind:'rework',additional_points:0,billing_segment_id:'fee',reservation_id:'fee'},
    {assignment_kind:'rework',additional_points:4500,billing_segment_id:null,reservation_id:null},
    {assignment_kind:'carry',additional_points:1,billing_segment_id:'fee',reservation_id:'fee'},
    {assignment_kind:'carry',additional_points:0,billing_segment_id:null,reservation_id:null},
    {assignment_kind:'unbilled',additional_points:1,billing_segment_id:null,reservation_id:null},
    {assignment_kind:'unbilled',additional_points:0,billing_segment_id:'fee',reservation_id:'fee'},
  ]) assert.equal(Value.Check(RunSupplementAdoptionResponseSchema,{adoption:{...receipt,...billing}}),false);
  const adoption = {...receipt,assignment_kind:'unbilled',additional_points:0,billing_segment_id:null,reservation_id:null};
  for (const field of ['state','queued','plan','checkpoint','object_key','metadata'])
    assert.equal(Value.Check(RunSupplementAdoptionResponseSchema,{adoption:{...adoption,[field]:'untrusted'}}),false,field);
});

test('OpenAPI separates mutating production adoption from read-only exact receipt recovery', () => {
  const paths = openApiDocument().paths as Record<string,Record<string,any>>;
  const operations = paths['/api/v1/runs/{run_id}/supplement-adoptions'];
  for (const method of ['get','post']) {
    const operation = operations[method];
    assert.deepEqual(operation.security,[{sessionCookie:[]}]);
    assert.match(operation['x-implementation-status'],/production-only/);
    assert.equal(operation.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/RunSupplementAdoptionResponse');
    assert.ok(operation.parameters.some((parameter:any) => parameter.name === 'run_id' && parameter.required));
    if (method === 'post') {
      assert.equal(operation.requestBody.content['application/json'].schema.$ref,'#/components/schemas/RunSupplementAdoptRequest');
      assert.ok(operation.responses['402']); assert.ok(operation.responses['409']);
      for (const name of ['Origin','X-BB-CSRF']) assert.ok(operation.parameters.some((parameter:any) => parameter.name === name && parameter.required));
    } else {
      assert.equal(operation.requestBody,undefined);
      assert.ok(operation.parameters.some((parameter:any) => parameter.name === 'request_id' && parameter.in === 'query' && parameter.required));
      assert.ok(!operation.parameters.some((parameter:any) => parameter.name === 'X-BB-CSRF'));
    }
  }
});

test('current adoption recovery needs no browser journal and carries no execution or charging authority', () => {
  const paths = openApiDocument().paths as Record<string,Record<string,any>>;
  const operation = paths['/api/v1/runs/{run_id}/supplement-adoptions/current'].get;
  assert.deepEqual(operation.security,[{sessionCookie:[]}]);
  assert.match(operation['x-implementation-status'],/production-only; current-execution; read-only/);
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/RunSupplementAdoptionResponse');
  assert.ok(operation.responses['404']); assert.ok(operation.responses['409']);
  assert.equal(operation.requestBody,undefined);
  assert.deepEqual(operation.parameters.map((parameter:any) => [parameter.name,parameter.in]),[['run_id','path']]);
});
