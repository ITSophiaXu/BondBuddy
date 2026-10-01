import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { Value } from '@sinclair/typebox/value';
import {
  OCR_V2_LIMITS, OcrAggregateV2Schema, OcrBatchRequestV2Schema, OcrBatchResponseV2Schema,
  OcrCorrectionSchema, OcrEngineResponseSchema, OcrPageCheckpointV2Schema, OcrPageResultV2Schema,
  ocrPageIdentitySha256V2, ocrPageResultSha256V2, openApiDocument,
  validateOcrAggregateV2, validateOcrBatchRequestV2, validateOcrBatchResponseV2, validateOcrPageCheckpointV2,
  type OcrAggregateV2, type OcrBatchRequestV2, type OcrBatchResponseV2, type OcrCheckpointReaderV2,
  type OcrCheckpointRefV2, type OcrDocumentIdentityV2, type OcrEngineResponse,
  type OcrPageCheckpointV2, type OcrPageResultV2
} from './index.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/ocr-v2.json', import.meta.url), 'utf8'));
assert.equal(fixture.synthetic, true);
assert.ok(Value.Check(OcrBatchRequestV2Schema, fixture.request));
assert.ok(Value.Check(OcrPageResultV2Schema, fixture.result));
const exampleRequest: OcrBatchRequestV2 = fixture.request;
const exampleResult: OcrPageResultV2 = fixture.result;
const image = Buffer.from(fixture.image_base64, 'base64');
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const pages = (count: number, start = 1) => Array.from({ length: count }, (_, index) => start + index);
const ajv = new Ajv({ strict: true, allErrors: true });
const schemas = { OcrBatchRequestV2Schema, OcrBatchResponseV2Schema, OcrPageCheckpointV2Schema, OcrAggregateV2Schema };
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
function schemaAccepts(name: keyof typeof schemas, value: unknown) {
  assert.equal(validators[name](value), true, ajv.errorsText(validators[name].errors));
}

async function checkpoint(document: OcrDocumentIdentityV2, page: number, requestId: string): Promise<OcrPageCheckpointV2> {
  const result = structuredClone(exampleResult);
  result.page.page = page;
  result.records[0].page = page;
  result.records[0].record_id = `synthetic-p${page}-r1`;
  const identity = { document: structuredClone(document), page };
  const hashInput = { identity_sha256: await ocrPageIdentitySha256V2(identity), source_request_id: requestId, result };
  return {
    schema_version: 'ocr-page-checkpoint-v2', identity, ...hashInput,
    result_sha256: await ocrPageResultSha256V2(hashInput)
  };
}
function ref(value: OcrPageCheckpointV2): OcrCheckpointRefV2 {
  return {
    page: value.identity.page, identity_sha256: value.identity_sha256,
    result_sha256: value.result_sha256, source_request_id: value.source_request_id
  };
}
function reader(checkpoints: OcrPageCheckpointV2[]): OcrCheckpointReaderV2 {
  return async reference => {
    const stored = checkpoints.find(item => item.identity.page === reference.page);
    assert.ok(stored, 'synthetic checkpoint not found');
    return { checkpoint: stored, image };
  };
}
function response(request: OcrBatchRequestV2, checkpoints: OcrPageCheckpointV2[]): OcrBatchResponseV2 {
  return {
    schema_version: 'ocr-response-v2', request_id: request.request_id,
    document: request.document, context: request.context,
    page_results: checkpoints.map(item => ({
      page: item.identity.page, status: 'succeeded', reused: item.source_request_id !== request.request_id, checkpoint: ref(item)
    })),
    attempted_pages: checkpoints.filter(item => item.source_request_id === request.request_id).length,
    coverage: 'partial', eligible_for_manuscript: false
  };
}
function aggregate(request: OcrBatchRequestV2, checkpoints: OcrPageCheckpointV2[]): OcrAggregateV2 {
  return {
    schema_version: 'ocr-aggregate-v2', document: request.document, context: request.context,
    successful_pages: checkpoints.map(ref), coverage: checkpoints.length === request.document.page_count ? 'complete' : checkpoints.length ? 'partial' : 'none',
    eligible_for_manuscript: false
  };
}

test('synthetic JSON example has strict schemas and a reproducible image/hash domain', async () => {
  schemaAccepts('OcrBatchRequestV2Schema', fixture.request);
  assert.equal(digest(image), exampleResult.page.image_sha256);
  await validateOcrBatchRequestV2(exampleRequest);
  const value = await checkpoint(exampleRequest.document, 1, exampleRequest.request_id);
  schemaAccepts('OcrPageCheckpointV2Schema', value);
  await validateOcrPageCheckpointV2(value, value.identity, image);
  const result = value.result;
  // Independent fixed-order preimage proves the documented serialization, not just self-consistency.
  const expected = `{"identity_sha256":"${value.identity_sha256}","result":{"eligible_for_manuscript":false,"page":{"coordinate_system":"rendered_pixels_top_left","height":1,"image_sha256":"${digest(image)}","page":1,"rotation_clockwise":90,"warnings":["synthetic_only","orientation_unverified"],"width":1},"records":[{"bbox":[0,0,1,1],"cell":{"column":1,"column_span":3,"row":1,"row_span":2,"table_id":"synthetic-table"},"confidence":0.4,"eligible_for_manuscript":false,"numeric":{"decimal":"-1234.50","kind":"number","unit":null},"page":1,"record_id":"synthetic-p1-r1","text":"(1,234.50)","uncertainty":["critical_value_requires_confirmation","synthetic_only"]}],"status":"needs_confirmation"},"schema_version":"ocr-page-result-v2","source_request_id":"${value.source_request_id}"}`;
  assert.equal(value.result_sha256, digest(expected));
  assert.equal(await ocrPageResultSha256V2({
    source_request_id: value.source_request_id, identity_sha256: value.identity_sha256,
    result: { eligible_for_manuscript: false, status: 'needs_confirmation', records: result.records, page: result.page }
  }), value.result_sha256);
  const reordered = structuredClone(value.identity);
  reordered.document.engine.language_data_sha256 = Object.fromEntries(Object.entries(reordered.document.engine.language_data_sha256).reverse());
  assert.equal(await ocrPageIdentitySha256V2(reordered), value.identity_sha256);
});

for (const count of [70, 74]) {
  test(`${count} physical pages require bounded batches, then exact verified contiguous aggregation`, async () => {
    const request = structuredClone(exampleRequest);
    request.document.page_count = count;
    const all: OcrPageCheckpointV2[] = [];
    for (let start = 1; start <= count; start += OCR_V2_LIMITS.batch_pages) {
      request.request_id = `synthetic-batch-${start}`;
      request.pages = pages(Math.min(50, count - start + 1), start);
      await validateOcrBatchRequestV2(request);
      const batch = await Promise.all(request.pages.map(page => checkpoint(request.document, page, request.request_id)));
      const result = response(request, batch);
      schemaAccepts('OcrBatchResponseV2Schema', result);
      assert.equal((await validateOcrBatchResponseV2(result, request, reader(batch))).coverage, 'partial');
      assert.equal(result.attempted_pages, batch.length);
      await assert.rejects(validateOcrBatchResponseV2({ ...result, coverage: 'complete' }, request, reader(batch)));
      all.push(...batch);
    }
    const complete = aggregate(request, all);
    schemaAccepts('OcrAggregateV2Schema', complete);
    assert.equal((await validateOcrAggregateV2(complete, request, reader(all))).coverage, 'complete');
    assert.deepEqual(complete.successful_pages.map(item => item.page), pages(count));
    const partial = aggregate(request, all.filter(item => item.identity.page !== 7));
    assert.equal((await validateOcrAggregateV2(partial, request, reader(all))).coverage, 'partial');
    await assert.rejects(validateOcrAggregateV2({ ...partial, coverage: 'complete' }, request, reader(all)), /coverage/);
    const retry = { ...request, request_id: `synthetic-retry-${count}-7`, pages: [7], reuse: [] };
    const recovered = await checkpoint(request.document, 7, retry.request_id);
    await validateOcrBatchResponseV2(response(retry, [recovered]), retry, reader([recovered]));
    const resumed = all.map(item => item.identity.page === 7 ? recovered : item);
    assert.equal((await validateOcrAggregateV2(aggregate(request, resumed), request, reader(resumed))).coverage, 'complete');
    assert.deepEqual(resumed.filter(item => item.identity.page !== 7).map(ref), partial.successful_pages, 'successful pages stay unchanged after retry');
    for (const invalidPages of [
      complete.successful_pages.slice(1), [...complete.successful_pages, complete.successful_pages[0]],
      [...complete.successful_pages.slice(0, -1), { ...complete.successful_pages.at(-1)!, page: count + 1 }],
      [...complete.successful_pages].reverse(),
      [{ ...complete.successful_pages[0], page: 0 }, ...complete.successful_pages.slice(1)]
    ]) await assert.rejects(validateOcrAggregateV2({ ...complete, successful_pages: invalidPages }, request, reader(all)));
  });
}

test('failed physical page retries alone; prior successful pages reuse without counting them again', async () => {
  const request = structuredClone(exampleRequest);
  request.pages = [1, 7, 74];
  const first = await checkpoint(request.document, 1, request.request_id);
  const last = await checkpoint(request.document, 74, request.request_id);
  const failed: OcrBatchResponseV2 = {
    ...response(request, [first, last]), attempted_pages: 3,
    page_results: [
      { page: 1, status: 'succeeded', reused: false, checkpoint: ref(first) },
      { page: 7, status: 'failed', attempted: true, retryable: true, error: 'OCR_ENGINE_TIMEOUT', warnings: ['synthetic_only'] },
      { page: 74, status: 'succeeded', reused: false, checkpoint: ref(last) }
    ]
  };
  schemaAccepts('OcrBatchResponseV2Schema', failed);
  await validateOcrBatchResponseV2(failed, request, reader([first, last]));
  const retry: OcrBatchRequestV2 = { ...request, request_id: 'synthetic-retry-7', pages: [7] };
  const retried = await checkpoint(request.document, 7, retry.request_id);
  await validateOcrBatchResponseV2(response(retry, [retried]), retry, reader([retried]));
  const reuse = { ...request, request_id: 'synthetic-reuse', reuse: [ref(first), ref(last)] };
  const fresh = await checkpoint(request.document, 7, reuse.request_id);
  const reused = response(reuse, [first, fresh, last]);
  assert.equal((await validateOcrBatchResponseV2(reused, reuse, reader([first, fresh, last]))).attempted_pages, 1);
  const allReused = { ...reuse, request_id: 'synthetic-reuse-only', pages: [1, 74] };
  assert.equal((await validateOcrBatchResponseV2(response(allReused, [first, last]), allReused, reader([first, last]))).attempted_pages, 0);
  assert.equal(failed.attempted_pages, 3, 'original consumption is never rewritten by retry/reuse');
  await assert.rejects(validateOcrBatchResponseV2({ ...reused, attempted_pages: 3 }, reuse, reader([first, fresh, last])), /accounting/);
  await assert.rejects(validateOcrBatchResponseV2(reused, { ...reuse, reuse: [] }, reader([first, fresh, last])), /reuse/);
});

test('unknown, not-started and measured failed attempts remain distinct from successful checkpoints', async () => {
  const request = structuredClone(exampleRequest);
  const result: OcrBatchResponseV2 = {
    schema_version: 'ocr-response-v2', request_id: request.request_id, document: request.document, context: request.context,
    page_results: request.pages.map((page, index) => ({
      page, status: 'failed', attempted: [true, false, null][index], retryable: true, error: 'OCR_INTERRUPTED', warnings: []
    })),
    attempted_pages: null, coverage: 'none', eligible_for_manuscript: false
  };
  const noReads: OcrCheckpointReaderV2 = async () => { throw new Error('unexpected checkpoint read'); };
  await validateOcrBatchResponseV2(result, request, noReads);
  for (const attempted_pages of [0, 1, 3]) {
    await assert.rejects(validateOcrBatchResponseV2({ ...result, attempted_pages }, request, noReads), /accounting/);
  }
  await validateOcrAggregateV2(aggregate(request, []), request, noReads);
  await assert.rejects(validateOcrAggregateV2({ ...aggregate(request, []), coverage: 'complete' }, request, noReads));
  const success = await checkpoint(request.document, 1, request.request_id);
  await assert.rejects(validateOcrPageCheckpointV2({ ...success, result: { ...success.result, status: 'failed' } }, success.identity, image));
});

const identityChanges: Array<[string, (document: OcrDocumentIdentityV2) => void]> = [
  ['owner', value => { value.owner_user_id = 'other-owner'; }],
  ['project', value => { value.project_id = 'other-project'; }],
  ['material ID', value => { value.material.material_id = 'other-material'; }],
  ['material version', value => { value.material.material_version++; }],
  ['material hash', value => { value.material.sha256 = '1'.repeat(64); }],
  ['physical page count', value => { value.page_count++; }],
  ['processor', value => { value.processor_version = 'other-processor'; }],
  ['engine', value => { value.engine.name = 'other-engine'; }],
  ['engine version', value => { value.engine.version = 'other-version'; }],
  ['language', value => { value.engine.language = 'eng'; }],
  ['language data', value => { value.engine.language_data_sha256.eng = '1'.repeat(64); }],
  ['orientation model', value => { value.engine.language_data_sha256.osd = '1'.repeat(64); }],
  ['OCR options', value => { value.engine.parameters_sha256 = '1'.repeat(64); }],
  ['renderer', value => { value.rendering.renderer = 'other-renderer'; }],
  ['renderer version', value => { value.rendering.renderer_version = 'other-renderer-version'; }],
  ['DPI', value => { value.rendering.dpi++; }],
  ['pixel budget', value => { value.rendering.max_page_pixels--; }],
  ['render options', value => { value.rendering.parameters_sha256 = '1'.repeat(64); }]
];
for (const [name, mutate] of identityChanges) {
  test(`checkpoint and reuse identity bind ${name}`, async () => {
    const value = await checkpoint(exampleRequest.document, 1, 'synthetic-old-request');
    const changed = structuredClone(value.identity);
    mutate(changed.document);
    assert.notEqual(await ocrPageIdentitySha256V2(changed), value.identity_sha256);
    await assert.rejects(validateOcrPageCheckpointV2(value, changed, image), /identity/);
    const request = { ...exampleRequest, document: changed.document, pages: [1], reuse: [ref(value)] };
    await assert.rejects(validateOcrBatchRequestV2(request), /identity/);
    const forged = { ...value, identity: changed, identity_sha256: await ocrPageIdentitySha256V2(changed) };
    await assert.rejects(validateOcrAggregateV2(aggregate(exampleRequest, [forged]), exampleRequest, reader([forged])), /identity/);
  });
}

test('single-page identity cannot be relabelled or referenced by a different result/request hash', async () => {
  const value = await checkpoint(exampleRequest.document, 1, exampleRequest.request_id);
  const changed = { ...value.identity, page: 2 };
  assert.notEqual(await ocrPageIdentitySha256V2(changed), value.identity_sha256);
  await assert.rejects(validateOcrPageCheckpointV2(value, changed, image));
  const relabelled = { ...value, identity: changed, identity_sha256: await ocrPageIdentitySha256V2(changed) };
  await assert.rejects(validateOcrPageCheckpointV2(relabelled, changed, image), /checkpoint page/);
  const changedOwner = structuredClone(value.identity);
  changedOwner.document.owner_user_id = 'other-owner';
  await assert.rejects(validateOcrPageCheckpointV2({
    ...value, identity: changedOwner, identity_sha256: await ocrPageIdentitySha256V2(changedOwner)
  }, changedOwner, image), /result hash/);
  await assert.rejects(validateOcrPageCheckpointV2({ ...value, source_request_id: 'rewritten-request' }, value.identity, image), /result hash/);
  for (const patch of [
    { result_sha256: '0'.repeat(64) }, { identity_sha256: '0'.repeat(64) }, { source_request_id: 'foreign-request' }
  ]) {
    const partial = aggregate(exampleRequest, [value]);
    partial.successful_pages[0] = { ...partial.successful_pages[0], ...patch };
    await assert.rejects(validateOcrAggregateV2(partial, exampleRequest, reader([value])), /reference/);
  }
});

test('page records, table/box provenance, uncertainty and image bytes are checked before reuse', async () => {
  const value = await checkpoint(exampleRequest.document, 1, exampleRequest.request_id);
  const mutations: Array<(result: OcrPageResultV2) => void> = [
    result => { result.records[0].page = 2; },
    result => { result.records.push(structuredClone(result.records[0])); },
    result => { result.records[0].bbox = [0, 0, 2, 1]; },
    result => { result.records[0].bbox = [1, 0, 1, 1]; },
    result => { result.records[0].uncertainty = []; },
    result => { result.records[0].uncertainty = [' ']; },
    result => { result.records[0].numeric.decimal = 'NaN'; },
    result => { result.records[0].numeric = { kind: 'blank', decimal: '0', unit: null }; },
    result => { result.records[0].numeric = { kind: 'unparsed', decimal: '1', unit: null }; },
    result => { result.records[0].cell!.row_span = 0; },
    result => { result.page.width = 20000; result.page.height = 20000; }
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(value);
    mutate(invalid.result);
    await assert.rejects(validateOcrPageCheckpointV2(invalid, value.identity, image));
  }
  const changed = structuredClone(value);
  changed.result.records[0].text = 'different value';
  await assert.rejects(validateOcrPageCheckpointV2(changed, value.identity, image), /result hash/);
  changed.result = structuredClone(value.result);
  changed.result.records[0].cell!.table_id = 'another-table';
  await assert.rejects(validateOcrPageCheckpointV2(changed, value.identity, image), /result hash/);
  const tampered = Buffer.from(image);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(validateOcrPageCheckpointV2(value, value.identity, tampered), /image hash/);
  const wrongSize = Buffer.from(image);
  wrongSize.writeUInt32BE(2, 16);
  await assert.rejects(validateOcrPageCheckpointV2(value, value.identity, wrongSize), /dimensions/);
  await assert.rejects(validateOcrPageCheckpointV2(value, value.identity, new Uint8Array(0)), /size/);
  for (const kind of ['blank', 'dash', 'unparsed'] as const) {
    const result = structuredClone(exampleResult);
    result.records[0].numeric = { kind, decimal: null, unit: null };
    await ocrPageResultSha256V2({ result, identity_sha256: value.identity_sha256, source_request_id: value.source_request_id });
  }
  await assert.rejects(validateOcrPageCheckpointV2({ ...value, result: { ...value.result, eligible_for_manuscript: true } }, value.identity, image));
  await assert.rejects(validateOcrPageCheckpointV2({ ...value, result: { ...value.result, status: 'verified' } }, value.identity, image));
});

test('batch validation rejects missing, duplicate, extra outcomes and mismatched request/context', async () => {
  const request = structuredClone(exampleRequest);
  const stored = await Promise.all(request.pages.map(page => checkpoint(request.document, page, request.request_id)));
  const result = response(request, stored);
  for (const value of [
    { ...result, page_results: result.page_results.slice(1) },
    { ...result, page_results: [result.page_results[0], ...result.page_results] },
    { ...result, page_results: [...result.page_results].reverse() },
    { ...result, request_id: 'foreign' },
    { ...result, document: { ...result.document, owner_user_id: 'foreign' } },
    { ...result, context: { ...result.context, run: null } },
    { ...result, context: { purpose: 'source_preflight', run: null, billable: false, cost_payer: 'platform' } },
    { ...result, coverage: 'none' },
    { ...result, attempted_pages: 0 }
  ]) await assert.rejects(validateOcrBatchResponseV2(value, request, reader(stored)));
  const newRequest = { ...request, request_id: 'new-request' };
  await assert.rejects(validateOcrBatchResponseV2({ ...result, request_id: newRequest.request_id }, newRequest, reader(stored)), /new checkpoint/);
  await assert.rejects(validateOcrBatchResponseV2(result, request, async () => { throw new Error('readback unavailable'); }), /readback unavailable/);
});

test('bounded requests reject unsupported, malformed and scope-bypassing inputs', async () => {
  for (const value of [
    { ...exampleRequest, pages: [] }, { ...exampleRequest, pages: pages(51) },
    { ...exampleRequest, pages: [1, 1] }, { ...exampleRequest, pages: [2, 1] },
    { ...exampleRequest, pages: [0] }, { ...exampleRequest, pages: [75] },
    { ...exampleRequest, pages: [1.5] }, { ...exampleRequest, context: { ...exampleRequest.context, run: null } },
    { ...exampleRequest, context: { ...exampleRequest.context, billable: true } },
    { ...exampleRequest, context: { ...exampleRequest.context, cost_payer: 'user' } },
    { ...exampleRequest, document: { ...exampleRequest.document, page_count: 1501 } },
    { ...exampleRequest, document: { ...exampleRequest.document, engine: { ...exampleRequest.document.engine, language_data_sha256: {} } } },
    { ...exampleRequest, document: { ...exampleRequest.document, engine: { ...exampleRequest.document.engine, language: 'eng+eng' } } },
    { ...exampleRequest, document: { ...exampleRequest.document, material: { ...exampleRequest.document.material, media_type: 'image/png' } } },
    { ...exampleRequest, document: { ...exampleRequest.document, processor_version: '' } },
    { ...exampleRequest, document: { ...exampleRequest.document, processor_version: ' ' } },
    { ...exampleRequest, authorized: true }
  ]) await assert.rejects(validateOcrBatchRequestV2(value));
  const stored = await checkpoint(exampleRequest.document, 1, 'synthetic-previous');
  await assert.rejects(validateOcrBatchRequestV2({ ...exampleRequest, pages: [2], reuse: [ref(stored)] }), /outside/);
  await assert.rejects(validateOcrBatchRequestV2({ ...exampleRequest, request_id: stored.source_request_id, reuse: [ref(stored)] }), /earlier/);
  await assert.rejects(validateOcrBatchRequestV2({ ...exampleRequest, reuse: [ref(stored), ref(stored)] }), /duplicate/);
  await validateOcrBatchRequestV2({ ...exampleRequest, pages: pages(50) });
  await validateOcrBatchRequestV2({ ...exampleRequest, document: { ...exampleRequest.document, page_count: 1500 }, pages: [1500] });
});

test('platform source preflight stays within first five physical pages; full OCR still needs explicit run pins', async () => {
  const request: OcrBatchRequestV2 = {
    ...exampleRequest, context: { purpose: 'source_preflight', run: null, billable: false, cost_payer: 'platform' }
  };
  for (const selected of [[1, 2, 3], [1, 2, 3, 4, 5], [3]]) {
    await validateOcrBatchRequestV2({ ...request, pages: selected });
  }
  for (const selected of [[6], [1, 7], pages(6)]) await assert.rejects(validateOcrBatchRequestV2({ ...request, pages: selected }));
  const onePage = { ...request, document: { ...request.document, page_count: 1 }, pages: [1] };
  const stored = await checkpoint(onePage.document, 1, request.request_id);
  await validateOcrAggregateV2(aggregate(onePage, [stored]), onePage, reader([stored]));
  const pageSix = await checkpoint(request.document, 6, request.request_id);
  await assert.rejects(validateOcrAggregateV2(aggregate(request, [pageSix]), request, reader([pageSix])), /preflight/);
  // Reusing extraction evidence never removes the new execution's authorization/context requirement.
  const full = { ...onePage, request_id: 'synthetic-full', context: exampleRequest.context, reuse: [ref(stored)] };
  await validateOcrBatchResponseV2(response(full, [stored]), full, reader([stored]));
  await assert.rejects(validateOcrAggregateV2(aggregate(onePage, [stored]), full, reader([stored])), /context/);
});

test('v1 shape, 50-page ceiling, optional consumption and user-asserted correction remain unchanged', () => {
  const result: OcrEngineResponse = {
    schema_version: 'ocr-response-v1', request_id: 'synthetic-v1', processor_version: 'bondbuddy-ocr-1.0.0',
    engine_version: 'synthetic-only', language_data_sha256: { eng: 'a'.repeat(64) }, language: 'eng',
    purpose: 'full_ocr', status: 'needs_confirmation', material: exampleRequest.document.material,
    page_count: 50, coverage: 'complete', pages: pages(50).map(page => ({ ...exampleResult.page, page, image_base64: fixture.image_base64 })),
    records: [], warnings: ['synthetic_only'], error: null, eligible_for_manuscript: false
  };
  const validate = ajv.compile(OcrEngineResponseSchema);
  assert.equal(validate(result), true);
  assert.equal(validate({ ...result, attempted_pages: 50 }), true);
  assert.equal(validate({ ...result, attempted_pages: 51 }), false);
  assert.equal(validate({ ...result, pages: [...result.pages, { ...result.pages[0], page: 51 }] }), false);
  assert.equal(validate({ ...result, schema_version: 'ocr-response-v2' }), false);
  const correction = {
    correction_id: 'synthetic-correction', record_id: 'synthetic-p1-r1', revision: 1,
    original_text: '(1,234.50)', corrected_text: '(1,234.60)', reason: 'Synthetic user correction',
    period: null, scope: null, unit: null, actor_user_id: 'synthetic-owner',
    created_at: '2026-09-26T00:00:00Z', status: 'user_asserted', eligible_for_manuscript: false
  };
  assert.equal(Value.Check(OcrCorrectionSchema, correction), true);
  assert.equal(Value.Check(OcrCorrectionSchema, { ...correction, status: 'verified' }), false);
  assert.equal(Value.Check(OcrCorrectionSchema, { ...correction, eligible_for_manuscript: true }), false);
  const publicDocument = JSON.stringify(openApiDocument());
  for (const name of ['ocr-request-v2', 'ocr-response-v2', 'ocr-page-checkpoint-v2', 'ocr-aggregate-v2']) {
    assert.ok(!publicDocument.includes(name), 'internal contract must not advertise a public v2 API');
  }
});
