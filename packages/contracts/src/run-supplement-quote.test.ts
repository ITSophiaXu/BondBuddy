import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { BILLING_TASKS } from './billing.js';
import { M4_DOCUMENT_BILLING_TASKS } from './m4-document-types.js';
import { openApiDocument, schemas } from './index.js';
import {
  RunSupplementQuoteSchema, RunSupplementQuoteItemSchema, RunSupplementQuoteRequestSchema,
  RunSupplementQuoteConfirmRequestSchema, RunSupplementQuoteResponseSchema,
  type RunSupplementQuote, type RunSupplementQuoteConfirmation,
} from './run-supplement-quote.js';

const hash = 'a'.repeat(64);
const quote = (): RunSupplementQuote => ({
  quote_id: 'quote-synthetic', project_id: 'project-synthetic', run_id: 'run-synthetic',
  supplement_revision: 2, saved_request_id: 'saved-request-synthetic', pricing_rule: 'b1_full_document_v1',
  items: [{ target_id: 'target-synthetic', document_name: '合成发行人募集说明书', needs_redo: true,
    task_type: 'annual', price_version: 'price-synthetic', full_price_points: 27900, points: 27900 }],
  total_points: 27900, quote_hash: hash, created_at: '2026-10-27T01:00:00.123Z', expires_at: '2026-10-27T01:05:00Z',
});
const confirmation = (): RunSupplementQuoteConfirmation => ({
  confirmation_id: 'confirmation-synthetic', quote_id: 'quote-synthetic', project_id: 'project-synthetic',
  run_id: 'run-synthetic', request_id: 'confirmation-request-synthetic', quote_hash: hash,
  total_points: 27900, confirmed_at: '2026-10-27T01:01:00Z',
});

test('one immutable business-document quote supports an absent or explicit confirmation receipt', () => {
  assert.equal(Value.Check(RunSupplementQuoteResponseSchema, { quote: quote(), confirmation: null }), true);
  assert.equal(Value.Check(RunSupplementQuoteResponseSchema, { quote: quote(), confirmation: confirmation() }), true);
  assert.equal(Value.Check(schemas.RunSupplementQuoteResponse, { quote: quote(), confirmation: confirmation() }), true);
  assert.equal(Value.Check(RunSupplementQuoteResponseSchema, { quote: quote() }), false);
});

test('a target with no rework has zero additional points and no required or invented price', () => {
  const unchanged = { target_id: 'target-synthetic', document_name: '合成文书', needs_redo: false,
    task_type: null, price_version: null, full_price_points: null, points: 0 };
  assert.equal(Value.Check(RunSupplementQuoteItemSchema, unchanged), true);
  assert.equal(Value.Check(RunSupplementQuoteSchema, { ...quote(), items: [unchanged], total_points: 0 }), true);
  for (const change of [{ points: 1 }, { task_type: 'annual' }, { price_version: 'invented-price' }, { full_price_points: 1 }])
    assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...unchanged, ...change }), false);
  const priced = quote().items[0]!;
  for (const change of [{ points: 0 }, { task_type: null }, { price_version: null }, { full_price_points: 0 }, { full_price_points: null }])
    assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...priced, ...change }), false);
});

test('priced targets use only the existing authoring, review and document billing tasks', () => {
  for (const task_type of [...Object.keys(BILLING_TASKS), ...Object.values(M4_DOCUMENT_BILLING_TASKS)])
    assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...quote().items[0], task_type }), true, task_type);
  for (const task_type of ['m4_Q00', 'm4_Q01', 'm4_task_assistance', 'underwriter', 'unknown-task'])
    assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...quote().items[0], task_type }), false, task_type);
});

test('quote creation and confirmation reject caller-provided prices, tasks and private processing metadata', () => {
  const request = { request_id: 'request-synthetic', supplement_revision: 2,
    saved_request_id: 'saved-request-synthetic', candidate_input_hash: hash };
  assert.equal(Value.Check(RunSupplementQuoteRequestSchema, request), true);
  for (const field of ['price', 'points', 'total_points', 'task_type', 'plan_id', 'plan_hash', 'basis', 'raw_metadata'])
    assert.equal(Value.Check(RunSupplementQuoteRequestSchema, { ...request, [field]: 'untrusted' }), false, field);
  assert.equal(Value.Check(RunSupplementQuoteRequestSchema, { ...request, supplement_revision: 0 }), false);
  assert.equal(Value.Check(RunSupplementQuoteRequestSchema, { ...request, candidate_input_hash: 'short' }), false);
  const confirm = { request_id: 'confirm-synthetic', quote_hash: hash };
  assert.equal(Value.Check(RunSupplementQuoteConfirmRequestSchema, confirm), true);
  for (const field of ['total_points', 'price_version', 'plan_id', 'adopt', 'resume'])
    assert.equal(Value.Check(RunSupplementQuoteConfirmRequestSchema, { ...confirm, [field]: true }), false, field);
  assert.equal(Value.Check(RunSupplementQuoteConfirmRequestSchema, { ...confirm, quote_hash: hash.toUpperCase() }), false);
});

test('public quote bounds allow exactly one target and bounded integer prices and document names', () => {
  const base = quote(), item = base.items[0]!;
  assert.equal(Value.Check(RunSupplementQuoteSchema, { ...base, items: [] }), false);
  assert.equal(Value.Check(RunSupplementQuoteSchema, { ...base, items: [item, item] }), false);
  for (const document_name of ['', '文'.repeat(501)])
    assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...item, document_name }), false);
  assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...item, document_name: '文'.repeat(500) }), true);
  for (const value of [-1, 0.5, 1000000001]) {
    assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...item, points: value }), false);
    assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...item, full_price_points: value }), false);
    assert.equal(Value.Check(RunSupplementQuoteSchema, { ...base, total_points: value }), false);
  }
  assert.equal(Value.Check(RunSupplementQuoteItemSchema, { ...item, full_price_points: 1000000000, points: 1000000000 }), true);
});

test('public responses reject private plans and execution metadata at every exposed object boundary', () => {
  const value = { quote: quote(), confirmation: confirmation() };
  for (const field of ['plan_id', 'basis_hash', 'metadata']) {
    assert.equal(Value.Check(RunSupplementQuoteResponseSchema, { ...value, [field]: {} }), false);
    assert.equal(Value.Check(RunSupplementQuoteResponseSchema, { ...value, quote: { ...value.quote, [field]: {} } }), false);
    assert.equal(Value.Check(RunSupplementQuoteResponseSchema, { ...value,
      quote: { ...value.quote, items: [{ ...value.quote.items[0], [field]: {} }] } }), false);
    assert.equal(Value.Check(RunSupplementQuoteResponseSchema, { ...value,
      confirmation: { ...value.confirmation, [field]: {} } }), false);
  }
});

test('OpenAPI exposes only the three session-scoped quote operations with explicit mutation protection', () => {
  const paths = openApiDocument().paths as Record<string, Record<string, any>>;
  const base = '/api/v1/runs/{run_id}/supplement-quotes';
  for (const [path, method, request] of [[base, 'post', 'RunSupplementQuoteRequest'],
    [base + '/{quote_id}', 'get', null],
    [base + '/{quote_id}/confirm', 'post', 'RunSupplementQuoteConfirmRequest']] as const) {
    const operation = paths[path]![method]!;
    assert.deepEqual(operation.security, [{ sessionCookie: [] }]);
    assert.match(operation['x-implementation-status'], /quote-and-confirmation-only/);
    assert.match(operation['x-implementation-status'], /never-adopt-resume-reserve-or-charge/);
    assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/RunSupplementQuoteResponse');
    assert.ok(operation.parameters.some((parameter: any) => parameter.name === 'run_id' && parameter.in === 'path' && parameter.required));
    if (path !== base) assert.ok(operation.parameters.some((parameter: any) => parameter.name === 'quote_id' && parameter.in === 'path' && parameter.required));
    if (request) {
      assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/' + request);
      for (const name of ['Origin', 'X-BB-CSRF'])
        assert.ok(operation.parameters.some((parameter: any) => parameter.name === name && parameter.in === 'header' && parameter.required));
      assert.ok(operation.responses['409']);
    } else {
      assert.equal(operation.requestBody, undefined);
      assert.ok(!operation.parameters.some((parameter: any) => parameter.name === 'X-BB-CSRF'));
    }
    for (const status of ['401', '403', '404', '422', '503']) assert.ok(operation.responses[status]);
  }
  assert.deepEqual(Object.keys(paths[base]!), ['post']);
  assert.deepEqual(Object.keys(paths[base + '/{quote_id}']!), ['get']);
  assert.deepEqual(Object.keys(paths[base + '/{quote_id}/confirm']!), ['post']);
});
