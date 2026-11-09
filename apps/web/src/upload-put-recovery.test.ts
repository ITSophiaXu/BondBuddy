import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { ApiClient, ApiError, type Dto } from './api.js';
import { UploadRecovery, type UploadRecoveryStorage } from './upload-recovery.js';
import { UPLOAD_BYTES_PENDING_FIELD_ERROR } from '@bondbuddy/contracts';

const bytes = 'synthetic original file';
const declaration: Dto<'UploadCreateRequest'> = { filename: 'synthetic.docx', role: 'other',
  media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  byte_size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
const material: Dto<'MaterialResponse'> = { ...declaration, material_id: 'material-a', material_version: 1, upload_id: 'upload-a',
  state: 'persisted', persisted_at: '2026-11-09T00:00:00Z', error: null };
const file = () => new File([bytes], declaration.filename, { type: declaration.media_type });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Retry-After': '0.05' },
});
const notReceived = () => response({ code: 'MATERIAL_UNREADABLE', field_errors: [UPLOAD_BYTES_PENDING_FIELD_ERROR] }, 422);
const pending = () => response({ status: 'confirming', upload_id: 'upload-a' }, 202);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

class Store implements UploadRecoveryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

function fixture(t: TestContext, putError = new ApiError(524, 'DATA_UNAVAILABLE', { correlationId: 'original-put' })) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = globalThis.fetch, doc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
  t.after(() => { globalThis.fetch = before; if (doc) Object.defineProperty(globalThis, 'document', doc); else Reflect.deleteProperty(globalThis, 'document'); });
  const store = new Store(), calls: string[] = [], signals: AbortSignal[] = [];
  const state = { reply: (_signal: AbortSignal): Response | Promise<Response> => notReceived() };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/v1/projects/project-a/materials/uploads/upload-a/complete');
    assert.equal(init?.method, 'POST'); assert.equal((init?.headers as Record<string, string>).Prefer, 'respond-async');
    assert.deepEqual(JSON.parse(String(init?.body)), { byte_size: declaration.byte_size, sha256: declaration.sha256 });
    const signal = init!.signal!; signal.throwIfAborted(); signals.push(signal); calls.push('complete');
    return state.reply(signal);
  };
  const client = new ApiClient(() => {});
  const api: ConstructorParameters<typeof UploadRecovery>[0] = {
    createUpload: async () => {
      calls.push('create'); return { upload_id: 'upload-a', state: 'uploading', upload_url: '/original/bytes',
        expires_at: '2026-11-09T00:15:00Z', max_bytes: 1000 };
    },
    uploadBytes: async () => { calls.push('put'); throw putError; },
    completeUpload: (...args) => client.completeUpload(...args),
    material: async () => { throw new Error('Unexpected material read'); },
    project: async () => { throw new Error('Unexpected project read'); },
  };
  const make = () => new UploadRecovery(api, 'owner-a', 'project-a', 'purpose-a', () => true, {
    store, digest: async () => declaration.sha256, now: () => Date.parse('2026-11-09T00:00:00Z'),
    lock: { run: async (_name, action) => action() },
  });
  const recovery = make(); recovery.begin(declaration, { request_id: 'fixed-request' }, 'operation-a');
  return { state, calls, store, signals, make, recovery, putError };
}

test('524 followed by delayed received and 202/200 automatically saves only the exact original receipt', async t => {
  const f = fixture(t); let saved = false;
  const work = f.recovery.resume('operation-a', { file: file(), requireDurableRecord: true }).then(value => { saved = true; return value; });
  await flush();
  assert.deepEqual(f.calls, ['create', 'put', 'complete']); assert.equal(saved, false);
  t.mock.timers.tick(2000); await flush(); assert.equal(saved, false);
  const waiting = f.recovery.list()[0];
  assert.equal(waiting.stage, 'bytes_unknown'); assert.equal(waiting.uploadId, 'upload-a');
  assert.deepEqual(waiting.lastError, { status: 524, code: 'DATA_UNAVAILABLE', correlationId: 'original-put' });
  let replies = 0; f.state.reply = () => ++replies === 1 ? pending() : response(material);
  t.mock.timers.tick(2000); await flush(); assert.equal(saved, false);
  t.mock.timers.tick(50); assert.deepEqual(await work, material);
  assert.equal(f.calls.filter(x => x === 'create').length, 1); assert.equal(f.calls.filter(x => x === 'put').length, 1);
  assert.equal(f.recovery.list()[0].stage, 'saved'); assert.equal(f.recovery.list()[0].lastError, undefined);
});

test('bytes never received fails within one ten-minute budget, preserving original error and reopen identity', async t => {
  const f = fixture(t), work = f.recovery.resume('operation-a', { file: file() });
  const rejected = assert.rejects(work, error => error === f.putError); await flush();
  t.mock.timers.tick(599_999); await flush(); assert.equal(f.recovery.list()[0].stage, 'bytes_unknown');
  t.mock.timers.tick(1); await rejected;
  const record = f.recovery.list()[0];
  assert.deepEqual(record.declaration, declaration); assert.deepEqual(record.context, { request_id: 'fixed-request' });
  assert.equal(record.uploadId, 'upload-a'); assert.equal(record.material, undefined); assert.equal(record.lastError!.status, 524);
  assert.equal(f.calls.filter(x => x === 'create').length, 1); assert.equal(f.calls.filter(x => x === 'put').length, 1);
  f.state.reply = () => response(material);
  assert.deepEqual(await f.make().resume('operation-a', { file: file() }), material);
  assert.equal(f.calls.filter(x => x === 'create').length, 1); assert.equal(f.calls.filter(x => x === 'put').length, 1);
});

test('late bytes and pending 202 polling share the original recovery deadline', async t => {
  const f = fixture(t), work = f.recovery.resume('operation-a', { file: file() });
  const rejected = assert.rejects(work, error => error === f.putError); await flush();
  f.state.reply = pending; t.mock.timers.tick(360_000); await flush();
  assert.equal(f.recovery.list()[0].stage, 'bytes_unknown');
  t.mock.timers.tick(239_999); await flush(); assert.ok(f.signals.every(signal => !signal.aborted));
  t.mock.timers.tick(1); await rejected; assert.ok(f.signals.every(signal => signal.aborted));
  assert.equal(f.recovery.list()[0].material, undefined); assert.equal(f.calls.filter(x => x === 'put').length, 1);
});

for (const status of [0, 504, 503]) test(`uncertain PUT ${status} checks only the original upload`, async t => {
  const f = fixture(t, new ApiError(status, 'DATA_UNAVAILABLE')); f.state.reply = () => response(material);
  assert.deepEqual(await f.recovery.resume('operation-a', { file: file() }), material);
  assert.deepEqual(f.calls, ['create', 'put', 'complete']);
});

for (const [status, code] of [[422, 'MATERIAL_CONTENT_MISMATCH'], [409, 'IDEMPOTENCY_CONFLICT'], [403, 'FORBIDDEN']] as const) test(`definite PUT ${status}/${code} does not enter automatic confirmation`, async t => {
  const f = fixture(t, new ApiError(status, code));
  await assert.rejects(f.recovery.resume('operation-a', { file: file() }), error => error === f.putError);
  assert.deepEqual(f.calls, ['create', 'put']); assert.equal(f.recovery.list()[0].lastError!.code, code);
  assert.equal(f.recovery.list()[0].material, undefined);
});

for (const [status, code, fields] of [
  [422, 'MATERIAL_UNREADABLE', [{ field: 'material_upload', code: 'structure_invalid' }]],
  [422, 'MATERIAL_UNREADABLE', []],
  [422, 'MATERIAL_CONTENT_MISMATCH', []], [422, 'VALIDATION_FAILED', []],
  [409, 'IDEMPOTENCY_CONFLICT', []], [401, 'UNAUTHENTICATED', []], [403, 'FORBIDDEN', []], [404, 'NOT_FOUND', []],
] as const) test(`confirmation ${status}/${code} immediately preserves failure without another PUT`, async t => {
  const f = fixture(t); f.state.reply = () => response({ code, field_errors: fields, correlation_id: 'final-error' }, status);
  await assert.rejects(f.recovery.resume('operation-a', { file: file() }), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code);
  assert.deepEqual(f.calls, ['create', 'put', 'complete']); assert.equal(f.recovery.list()[0].material, undefined);
  assert.equal(f.recovery.list()[0].lastError!.code, code); assert.equal(f.recovery.list()[0].lastError!.correlationId, 'final-error');
  if (fields.length) assert.equal(f.recovery.list()[0].lastError!.uploadReason, 'structure_invalid');
  await assert.rejects(f.make().resume('operation-a', { file: file() }), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code);
  assert.deepEqual(f.calls, ['create', 'put', 'complete']);
  t.mock.timers.tick(600_000); assert.deepEqual(f.calls, ['create', 'put', 'complete']);
});

for (const phase of ['bytes', '202', 'request'] as const) test(`cancellation during ${phase} stops confirmation immediately and retains original upload`, async t => {
  const f = fixture(t), controller = new AbortController();
  if (phase === '202') f.state.reply = pending;
  if (phase === 'request') f.state.reply = signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const work = f.recovery.resume('operation-a', { file: file(), signal: controller.signal });
  const rejected = assert.rejects(work, { name: 'AbortError' }); await flush();
  controller.abort(); await rejected;
  const count = f.calls.length; t.mock.timers.tick(600_000); await flush(); assert.equal(f.calls.length, count);
  assert.ok(f.signals.every(signal => signal.aborted)); assert.equal(f.recovery.list()[0].stage, 'bytes_unknown');
  assert.equal(f.recovery.list()[0].uploadId, 'upload-a'); assert.equal(f.recovery.list()[0].lastError!.status, 524);
});

test('an incorrect final material hash is rejected without extending recovery or marking saved', async t => {
  const f = fixture(t); f.state.reply = () => response({ ...material, sha256: 'f'.repeat(64) });
  await assert.rejects(f.recovery.resume('operation-a', { file: file() }), ApiError);
  assert.equal(f.recovery.list()[0].material, undefined); assert.deepEqual(f.calls, ['create', 'put', 'complete']);
});

for (const change of [{ filename: 'wrong.docx' }, { role: 'legal' }, { media_type: 'application/pdf' }, { byte_size: 1 }]) test(`incorrect original receipt ${JSON.stringify(change)} never becomes saved`, async t => {
  const f = fixture(t); f.state.reply = () => response({ ...material, ...change });
  await assert.rejects(f.recovery.resume('operation-a', { file: file() }));
  assert.equal(f.recovery.list()[0].material, undefined); assert.deepEqual(f.calls, ['create', 'put', 'complete']);
});

test('an exact canonical reuse receipt may retain its older upload ID and filename', async t => {
  const f = fixture(t), canonical = { ...material, upload_id: 'older-upload', filename: 'canonical.docx' };
  f.state.reply = () => response(canonical);
  assert.deepEqual(await f.recovery.resume('operation-a', { file: file() }), canonical);
  assert.deepEqual(f.calls, ['create', 'put', 'complete']);
});
