import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { ApiClient, ApiError, type Dto } from './api.js';
import { UploadRecovery, type UploadRecoveryStorage } from './upload-recovery.js';

// Model XHR's native total-request timeout and transport events independently
// from the upload event target; advancing time never supplies an HTTP receipt.
function transport(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: Xhr[] = [];
  class Xhr extends EventTarget {
    upload = new EventTarget(); timeout = 0; status = 0; responseText = '';
    withCredentials = false; url = ''; sent = false; ended = false; aborts = 0;
    private timer?: ReturnType<typeof setTimeout>;
    constructor() { super(); requests.push(this); }
    open(method: string, url: string) { assert.equal(method, 'PUT'); this.url = url; }
    setRequestHeader() {}
    send() {
      this.sent = true;
      if (this.timeout) this.timer = setTimeout(() => this.end('timeout'), this.timeout);
    }
    private end(type: string) {
      if (this.ended) return;
      this.ended = true; clearTimeout(this.timer);
      this.dispatchEvent(new Event(type)); this.dispatchEvent(new Event('loadend'));
    }
    abort() { this.aborts++; this.end('abort'); }
    finish(status = 204) { this.status = status; this.end('load'); }
    fail() { this.end('error'); }
    transferred() { this.upload.dispatchEvent(new Event('load')); }
    progress(loaded: number, total: number) {
      this.upload.dispatchEvent(Object.assign(new Event('progress'), { loaded, total, lengthComputable: true }));
    }
  }
  const replacements = { XMLHttpRequest: Xhr, document: { cookie: '' }, window: { location: new URL('https://app.invalid/') } };
  for (const [key, value] of Object.entries(replacements)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key); });
  }
  return { api: new ApiClient(() => {}), requests };
}

const uploadUrl = '/api/v1/projects/project-a/materials/uploads/upload-a/bytes';
const bytes = 'synthetic original bytes';
const file = () => new File([bytes], 'synthetic.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 0 && error.code === 'DATA_UNAVAILABLE';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('buffered PUT accepts 204 more than 120 seconds after browser upload.load', async t => {
  const f = transport(t), progress: number[] = [];
  let saved = false;
  const work = f.api.uploadBytes(uploadUrl, file(), loaded => progress.push(loaded), new AbortController().signal).then(() => { saved = true; });
  const xhr = f.requests[0];
  t.mock.timers.tick(49_718); xhr.progress(file().size, file().size); xhr.transferred();
  t.mock.timers.tick(120_001); await flush();
  assert.equal(saved, false); assert.equal(xhr.ended, false); assert.equal(xhr.aborts, 0);
  t.mock.timers.tick(60_000); xhr.finish(); await work;
  assert.equal(saved, true); assert.deepEqual(progress, [file().size]); assert.equal(f.requests.length, 1);
});

test('no HTTP response fails at ten minutes from send, even without upload.load', async t => {
  const f = transport(t);
  const work = [false, true].map(transferred => {
    const pending = f.api.uploadBytes(uploadUrl, file(), () => {}, new AbortController().signal);
    if (transferred) f.requests.at(-1)!.transferred();
    return assert.rejects(pending, unavailable);
  });
  t.mock.timers.tick(599_999); await flush();
  assert.ok(f.requests.every(xhr => !xhr.ended));
  t.mock.timers.tick(1); await Promise.all(work);
  assert.ok(f.requests.every(xhr => xhr.ended)); assert.equal(f.requests.length, 2);
  t.mock.timers.tick(600_000); assert.equal(f.requests.length, 2);
});

test('user cancellation immediately aborts both transfer and response waiting', async t => {
  const f = transport(t);
  for (const transferred of [false, true]) {
    const controller = new AbortController();
    const work = f.api.uploadBytes(uploadUrl, file(), () => {}, controller.signal);
    const xhr = f.requests.at(-1)!;
    if (transferred) xhr.transferred();
    controller.abort();
    assert.equal(xhr.ended, true); assert.equal(xhr.aborts, 1);
    await assert.rejects(work, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  }
  t.mock.timers.tick(600_000); assert.equal(f.requests.length, 2);
});

test('an already cancelled upload never sends bytes', async t => {
  const f = transport(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.api.uploadBytes(uploadUrl, file(), () => {}, controller.signal), { name: 'AbortError' });
  assert.ok(f.requests.every(xhr => !xhr.sent));
});

class Store implements UploadRecoveryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

for (const failure of ['timeout', 'network'] as const) {
  test(`${failure} preserves the original upload and error; reopen confirms without another PUT or session`, async t => {
    const f = transport(t), store = new Store(), calls: string[] = [];
    const input: Dto<'UploadCreateRequest'> = { filename: file().name, media_type: file().type as Dto<'UploadCreateRequest'>['media_type'],
      role: 'other', byte_size: file().size, sha256: createHash('sha256').update(bytes).digest('hex') };
    const material: Dto<'MaterialResponse'> = { ...input, material_id: 'material-a', material_version: 1, upload_id: 'upload-a',
      state: 'persisted', persisted_at: '2026-11-09T00:00:00Z', error: null };
    const api: ConstructorParameters<typeof UploadRecovery>[0] = {
      createUpload: async () => {
        calls.push('create');
        return { upload_id: 'upload-a', state: 'uploading', upload_url: uploadUrl, expires_at: '2026-11-09T00:15:00Z', max_bytes: 1000 };
      },
      uploadBytes: (...args) => { calls.push('put'); return f.api.uploadBytes(...args); },
      completeUpload: async (_project, id, declaration) => {
        calls.push('complete'); assert.equal(id, 'upload-a');
        assert.deepEqual(declaration, { sha256: input.sha256, byte_size: input.byte_size }); return material;
      },
      material: async () => { throw new Error('Unexpected material read'); },
      project: async () => { throw new Error('Unexpected project read'); },
    };
    const make = () => new UploadRecovery(api, 'owner-a', 'project-a', 'purpose-a', () => true, {
      store, digest: async () => input.sha256, now: () => Date.parse('2026-11-09T00:00:00Z'),
      lock: { run: async (_name, action) => action() },
    });
    const recovery = make(); recovery.begin(input, { request_id: 'original-request' }, 'operation-a');
    const work = recovery.resume('operation-a', { file: file() }); const rejected = assert.rejects(work, unavailable);
    await flush(); assert.equal(f.requests.length, 1); f.requests[0].transferred();
    if (failure === 'timeout') t.mock.timers.tick(600_000); else f.requests[0].fail();
    await rejected;
    const record = make().list()[0];
    assert.equal(record.uploadId, 'upload-a'); assert.equal(record.stage, 'bytes_unknown');
    assert.deepEqual(record.declaration, input); assert.deepEqual(record.context, { request_id: 'original-request' });
    assert.deepEqual(record.lastError, { status: 0, code: 'DATA_UNAVAILABLE' }); assert.equal(record.material, undefined);
    assert.deepEqual(calls, ['create', 'put']);
    const reopened = make(); assert.deepEqual(await reopened.resume('operation-a'), material);
    assert.deepEqual(calls, ['create', 'put', 'complete']); assert.equal(f.requests.length, 1);
    assert.equal(reopened.list()[0].stage, 'saved'); assert.equal(reopened.list()[0].lastError, undefined);
  });
}
