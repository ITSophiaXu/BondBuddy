import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import Fastify from 'fastify';
import { BILLING_WIRE_HEADER, BILLING_WIRE_VERSION, LEGACY_BILLING_WIRE_VERSION, openApiDocument, schemas } from '@bondbuddy/contracts';
import { installBillingWire } from './billing-wire.js';
import { consumption } from './log-ops.js';

// Synthetic complete DTOs exercise the actual accumulator, HTTP hooks/serializer and
// published OpenAPI schema. The separate PG logical-job/probe suites exercise real routes.
const timestamp = '2026-11-12T00:00:00.000Z';
type UsageRow = Parameters<typeof consumption>[0][number];
const measured = (input_tokens: number | string): UsageRow => ({ usage_status: 'measured', call_status: 'completed', attempt_no: 1, input_tokens, output_tokens: 0, cached_input_tokens: null, reasoning_tokens: null });
const unknown: UsageRow = { usage_status: 'unknown', call_status: 'failed', attempt_no: 2, input_tokens: null, output_tokens: null, cached_input_tokens: null, reasoning_tokens: null };

function fixture(rows: UsageRow[]) {
  const completed = rows.filter(r => r.call_status === 'completed');
  const allUsage = consumption(rows), completedUsage = consumption(completed);
  const timeline = {
    job: { job_id: 'synthetic-job', user_id: 'synthetic-owner', project_id: null, run_id: null, channel: 'production', trace_id: null,
      input_revision: 3, job_type: 'preflight', subtype: 'synthetic_test', state: 'succeeded', stage: null, attempts: rows.length,
      error_code: null, created_at: timestamp, updated_at: timestamp, duration_ms: 12 },
    prompts: [], user_submissions: [], stages: [], errors: [], artifact: null,
    attempts: rows.map((row, i) => ({ attempt_id: `attempt-${i}`, logical_call_id: 'synthetic-call', attempt_no: row.attempt_no,
      channel: 'production', status: row.call_status, model_id: 'synthetic', provider_request_id: null, prompt_snapshot_ref: null,
      user_submission_id: null, usage_status: row.usage_status, usage: { input_tokens: row.input_tokens, output_tokens: row.output_tokens,
        cached_input_tokens: row.cached_input_tokens, reasoning_tokens: row.reasoning_tokens }, corrected: false, duration_ms: 12,
      error_code: null, created_at: timestamp })),
    outcome: { state: 'succeeded', error_code: null, artifact_available: false },
    consumption: { all_attempts: allUsage, completed_attempts: completedUsage }
  };
  const metrics = {
    window: { from: null, to: null }, operations: { submitted: 2, rejected: 0 },
    jobs: { total: 2, succeeded: 1, failed: 1, cancelled: 0, rejected: 0, other: 0, success_rate: 0.5, failure_rate: 0.5, duration_ms_avg: 12.5, duration_ms_p95: 13 },
    attempts: { total: rows.length, completed: completed.length, failed: rows.length - completed.length, pending_reconcile: 0, confirmed_not_sent: 0, conflict: 0, duration_ms_avg: 12.5 },
    consumption: { all_attempts: allUsage, completed_attempts: completedUsage, retry_attempts: consumption(rows.filter(r => r.attempt_no > 1)) },
    by_model: [{ model_id: 'synthetic', attempts: rows.length, completed: completed.length, failed: rows.length - completed.length,
      input_tokens: allUsage.input_tokens, output_tokens: allUsage.output_tokens, cached_input_tokens: allUsage.cached_input_tokens, reasoning_tokens: allUsage.reasoning_tokens }], errors: []
  };
  const app = Fastify();
  installBillingWire(app, { db: () => { throw new Error('read-only synthetic route must not open a database'); }, owner: async () => 'synthetic-owner' });
  app.setErrorHandler((error: any, _request, reply) => reply.code(error.status ?? error.statusCode ?? 500).send({ code: error.code }));
  app.get('/api/v1/admin/jobs/:id/timeline', { schema: { response: { 200: schemas.AdminJobTimelineResponse } } }, async () => timeline);
  app.get('/api/v1/admin/metrics', { schema: { response: { 200: schemas.AdminMetricsResponse } } }, async () => metrics);
  return app;
}

const document = openApiDocument() as any;
const ajv = new Ajv({ strict: false }); // No type coercion: a number must fail the modern schema.
const routes = [
  { url: '/api/v1/admin/jobs/synthetic-job/timeline', path: '/api/v1/admin/jobs/{job_id}/timeline', legacy: schemas.AdminJobTimelineResponse },
  { url: '/api/v1/admin/metrics', path: '/api/v1/admin/metrics', legacy: schemas.AdminMetricsResponse }
].map(route => {
  const operation = document.paths[route.path].get;
  const ref = operation.responses['200'].content['application/json'].schema.$ref;
  assert.match(ref, /BillingInt64_/);
  assert.equal(operation.parameters.find((p: any) => p.name === BILLING_WIRE_HEADER).schema.default, BILLING_WIRE_VERSION);
  return { ...route, modern: ajv.compile<any>(document.components.schemas[ref.split('/').at(-1)]), numeric: ajv.compile<any>(route.legacy) };
});

test('admin log default and explicit modern responses match full OpenAPI; legacy retains exact numbers', async () => {
  const app = fixture([measured(2), unknown]);
  try {
    for (const version of [undefined, BILLING_WIRE_VERSION, LEGACY_BILLING_WIRE_VERSION]) {
      const legacy = version === LEGACY_BILLING_WIRE_VERSION;
      const headers = version ? { [BILLING_WIRE_HEADER]: version } : {};
      for (const route of routes) {
        const response = await app.inject({ url: route.url, headers });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers[BILLING_WIRE_HEADER], version ?? BILLING_WIRE_VERSION);
        const body = response.json(), validate = legacy ? route.numeric : route.modern;
        assert.ok(validate(body), JSON.stringify(validate.errors));
        assert.deepEqual(body.consumption.all_attempts, {
          attempts: legacy ? 2 : '2', measured_attempts: legacy ? 1 : '1', unresolved_attempts: legacy ? 1 : '1',
          input_tokens: legacy ? 2 : '2', output_tokens: legacy ? 0 : '0', cached_input_tokens: null, reasoning_tokens: null
        });
        if (body.job) {
          assert.equal(body.job.attempts, legacy ? 2 : '2');
          assert.equal(body.job.input_revision, 3);
          assert.equal(body.job.duration_ms, 12);
          assert.equal(body.attempts[0].attempt_no, 1);
          assert.equal(body.attempts[0].usage.input_tokens, legacy ? 2 : '2');
          assert.equal(body.attempts[1].usage.input_tokens, null);
        } else {
          assert.equal(body.jobs.total, legacy ? 2 : '2');
          assert.equal(body.attempts.total, legacy ? 2 : '2');
          assert.equal(body.by_model[0].input_tokens, legacy ? 2 : '2');
          assert.equal(body.jobs.success_rate, 0.5);
          assert.equal(body.jobs.duration_ms_avg, 12.5);
        }
        // Prove the published schema does not silently permit number|string or malformed integers.
        for (const invalid of legacy ? ['2'] : [2, '02', '-1', '1.5', '9223372036854775808']) {
          const malformed = structuredClone(body);
          malformed.consumption.all_attempts.attempts = invalid;
          assert.equal(validate(malformed), false, `${route.url}: ${String(invalid)}`);
        }
      }
    }
  } finally { await app.close(); }
});

test('admin log cumulative sums retain MAX_SAFE and full int64 precision; legacy refuses unsafe reads', async () => {
  for (const sample of [
    { inputs: ['9007199254740991'], sum: '9007199254740991', legacy: true },
    { inputs: ['9007199254740991', '2'], sum: '9007199254740993', legacy: false },
    { inputs: ['9223372036854775807'], sum: '9223372036854775807', legacy: false }
  ]) {
    const app = fixture(sample.inputs.map(measured));
    try {
      for (const route of routes) {
        for (const version of [undefined, BILLING_WIRE_VERSION]) {
          const response = await app.inject({ url: route.url, headers: version ? { [BILLING_WIRE_HEADER]: version } : {} });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.headers[BILLING_WIRE_HEADER], BILLING_WIRE_VERSION);
          const body = response.json();
          assert.ok(route.modern(body), JSON.stringify(route.modern.errors));
          assert.equal(body.consumption.all_attempts.input_tokens, sample.sum);
          assert.equal(body.consumption.completed_attempts.input_tokens, sample.sum);
          if (body.job) assert.deepEqual(body.attempts.map((a: any) => a.usage.input_tokens), sample.inputs);
          else assert.equal(body.by_model[0].input_tokens, sample.sum);
        }
        const old = await app.inject({ url: route.url, headers: { [BILLING_WIRE_HEADER]: LEGACY_BILLING_WIRE_VERSION } });
        if (sample.legacy) {
          assert.equal(old.statusCode, 200, old.body);
          assert.equal(old.headers[BILLING_WIRE_HEADER], LEGACY_BILLING_WIRE_VERSION);
          assert.ok(route.numeric(old.json()), JSON.stringify(route.numeric.errors));
          assert.equal(old.json().consumption.all_attempts.input_tokens, Number.MAX_SAFE_INTEGER);
        } else {
          assert.equal(old.statusCode, 503, old.body);
          assert.deepEqual(old.json(), { code: 'DATA_UNAVAILABLE' });
        }
      }
    } finally { await app.close(); }
  }
  assert.throws(() => consumption([measured('9223372036854775807'), measured(1)]), /out of range/);
});

test('admin log no usage and unknown usage stay null; measured zero is an exact zero', async () => {
  for (const sample of [
    { rows: [], attempts: '0', unresolved: '0', input: null },
    { rows: [unknown], attempts: '1', unresolved: '1', input: null },
    { rows: [measured(0)], attempts: '1', unresolved: '0', input: '0' }
  ]) {
    const app = fixture(sample.rows);
    try {
      for (const route of routes) {
        const response = await app.inject({ url: route.url });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        assert.ok(route.modern(body), JSON.stringify(route.modern.errors));
        assert.equal(body.consumption.all_attempts.attempts, sample.attempts);
        assert.equal(body.consumption.all_attempts.unresolved_attempts, sample.unresolved);
        assert.equal(body.consumption.all_attempts.input_tokens, sample.input);
      }
    } finally { await app.close(); }
  }
});
