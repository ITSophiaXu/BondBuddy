import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { M1_UPLOAD_MIME_TYPES, type M4MaterialPin, type M4Workspace } from './billing-types.js';
import { ApiError, type Dto } from './api.js';
import { AssistantUploadRecovery } from './assistant-upload-recovery.js';
import { UploadRecoveryConflictError, UploadRecoveryStorageError, type UploadRecoveryStorage } from './upload-recovery.js';

const now = '2026-10-25T10:00:00Z', mime = M1_UPLOAD_MIME_TYPES[0], bytes = 'assistant original bytes', sha = createHash('sha256').update(bytes).digest('hex');
const file = () => new File([bytes], '原话题材料.docx', { type: mime });
const material = (change: Partial<Dto<'MaterialResponse'>> = {}): Dto<'MaterialResponse'> => ({ material_id: 'material-a', material_version: 3, upload_id: 'upload-a', role: 'audit', filename: '原话题材料.docx', media_type: mime, byte_size: Buffer.byteLength(bytes), sha256: sha, state: 'persisted', persisted_at: now, error: null, ...change });
class Store implements UploadRecoveryStorage {
  data = new Map<string, string>(); fail = false;
  get length() { return this.data.size; } key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; } setItem(key: string, value: string) { if (this.fail) throw new Error('full'); this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const store = new Store(), calls: { method: string; project?: string; topic?: string; id?: string; version?: number; pin?: M4MaterialPin }[] = [], pins = new Map<string, M4MaterialPin[]>();
  const state = { live: true, sequence: 0, put: async () => {}, complete: async () => material(), get: async () => material(), beforeWorkspace: async () => {},
    afterAssociation: async () => {}, beforeAssociation: async () => {}, afterRead: async () => {} };
  const api: ConstructorParameters<typeof AssistantUploadRecovery>[0] = {
    createUpload: async project => { calls.push({ method: 'create', project }); return { upload_id: 'upload-a', state: 'uploading', upload_url: '/private-bytes', expires_at: '2099-01-01T00:00:00Z', max_bytes: 10000 }; },
    uploadBytes: async () => { calls.push({ method: 'put' }); await state.put(); },
    completeUpload: async (project, id) => { calls.push({ method: 'complete', project, id }); return state.complete(); },
    material: async (project, id, _signal, version) => { calls.push({ method: 'material', project, id, version }); return state.get(); },
    project: async () => { throw new Error('unexpected project discovery'); },
  };
  const m4: ConstructorParameters<typeof AssistantUploadRecovery>[1] = {
    workspace: async topic => { calls.push({ method: 'workspace', topic }); await state.beforeWorkspace(); const value = { topic: { topic_id: topic }, materials: structuredClone(pins.get(topic) ?? []) } as M4Workspace; await state.afterRead(); return value; },
    material: async (topic, pin) => { calls.push({ method: 'associate', topic, pin: structuredClone(pin) }); await state.beforeAssociation(); if (!(pins.get(topic) ?? []).some(value => JSON.stringify(value) === JSON.stringify(pin))) pins.set(topic, [...pins.get(topic) ?? [], pin]); await state.afterAssociation(); },
  };
  const make = (owner = 'owner-a') => new AssistantUploadRecovery(api, m4, owner, () => state.live, { store, now: () => Date.parse(now), id: () => 'nonce-' + ++state.sequence, lock: { run: async (_name, action) => action() } });
  const begin = (helper: AssistantUploadRecovery, project = 'actual-project-a', topic = 'topic-a', id = 'op-a') => helper.begin(file(), 'audit', project, topic, 'business', id);
  return { store, calls, pins, state, make, begin };
}
const methods = (h: ReturnType<typeof harness>) => h.calls.map(call => call.method);

test('assistant journal discovery is local and fixes owner, actual project, topic, role and entrypoint', async () => {
  const h = harness(), helper = h.make();
  const original = await h.begin(helper); await h.begin(helper, 'other-project', 'other-topic', 'op-b'); await h.begin(h.make('owner-b'), 'actual-project-a', 'topic-a');
  assert.deepEqual(helper.list('topic-a'), [original]); assert.equal(original.projectId, 'actual-project-a'); assert.equal(original.declaration.role, 'audit');
  assert.deepEqual(original.context, { version: 1, kind: 'assistant-material', topic_id: 'topic-a', entrypoint: 'business' }); assert.deepEqual(methods(h), []);
});

test('unknown PUT automatically confirms and associates the original upload without a second PUT', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); h.state.put = async () => { throw new ApiError(0, 'DATA_UNAVAILABLE'); };
  const result = await helper.resume(original, { file: file() });
  assert.deepEqual(methods(h), ['create', 'put', 'complete', 'workspace', 'associate', 'workspace']);
  assert.equal(result.associated, true); assert.equal(result.uploadId, 'upload-a'); assert.equal(h.calls.filter(call => call.method === 'put').length, 1);
  assert.equal(h.calls.find(call => call.method === 'associate')!.topic, 'topic-a'); assert.equal(h.store.length, 0);
});

test('unknown association response preserves the saved pin and explicit retry reads original topic before any replay', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); h.state.afterAssociation = async () => { throw new ApiError(0, 'DATA_UNAVAILABLE'); };
  await assert.rejects(helper.resume(original, { file: file() })); const retained = helper.list('topic-a')[0]; assert.equal(retained.stage, 'saved');
  h.state.afterAssociation = async () => {}; const before = h.calls.length; await h.make().resume(retained);
  assert.deepEqual(h.calls.slice(before), [{ method: 'material', project: 'actual-project-a', id: 'material-a', version: 3 }, { method: 'workspace', topic: 'topic-a' }]);
  assert.equal(h.calls.filter(call => call.method === 'associate').length, 1); assert.equal(h.store.length, 0);
});

test('association not received replays only the original full pin to the original topic, never the current topic', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); h.state.beforeAssociation = async () => { throw new ApiError(503, 'DATA_UNAVAILABLE'); };
  await assert.rejects(helper.resume(original, { file: file() })); h.state.beforeAssociation = async () => {}; await h.begin(helper, 'new-project', 'new-topic', 'op-new');
  await helper.resume(helper.list('topic-a')[0]); const requests = h.calls.filter(call => call.method === 'associate'); assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(h.pins.get('new-topic'), undefined); assert.equal(h.calls.filter(call => call.method === 'put').length, 1);
});

test('legal deduplication keeps the old material upload ID and separately reports the actual request upload ID', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); h.state.complete = async () => material({ upload_id: 'older-upload', filename: '旧文件名.docx' });
  const result = await helper.resume(original, { file: file() }); assert.equal(result.uploadId, 'upload-a'); assert.equal(result.material.upload_id, 'older-upload'); assert.equal(result.associated, true);
});

test('another tab cleaning the journal after an exact original-topic association does not turn success into a conflict', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); let reads = 0;
  h.state.afterRead = async () => { if (++reads === 2) h.store.data.clear(); };
  const result = await helper.resume(original, { file: file() }); assert.equal(result.associated, true); assert.equal(h.store.length, 0);
});

test('known identity missing in another tab is never begun again, even with the original File', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); h.store.data.clear();
  await assert.rejects(helper.resume(original, { file: file() }), UploadRecoveryConflictError); assert.deepEqual(methods(h), []); assert.equal(h.store.length, 0);
});

for (const change of [{ owner: 'owner-b' }, { projectId: 'other-project' }, { declaration: { ...material(), role: 'other' } }]) test('changed original assistant upload identity is rejected before network ' + JSON.stringify(change), async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper);
  await assert.rejects(helper.resume({ ...original, ...change } as typeof original, { file: file() }), UploadRecoveryConflictError); assert.deepEqual(methods(h), []);
});

for (const context of [{ version: 2, kind: 'assistant-material', topic_id: 'topic-a', entrypoint: 'business' }, { version: 1, kind: 'assistant-material', topic_id: '', entrypoint: 'attachment' }, { version: 1, kind: 'assistant-material', topic_id: 'topic-a', entrypoint: 'business', role: 'other' }]) test('malformed assistant business context blocks scoped discovery ' + JSON.stringify(context), async () => {
  const h = harness(), helper = h.make(); await h.begin(helper); const [key, raw] = [...h.store.data][0]; h.store.data.set(key, JSON.stringify({ ...JSON.parse(raw), context }));
  assert.throws(() => helper.list('topic-a'), UploadRecoveryConflictError); assert.deepEqual(methods(h), []);
});

for (const suffix of ['%bad:assistant-material:op-a:nonce', 'project-a:assistant-material:op-a:', 'project-a:assistant-material:op-a:nonce:extra']) test('malformed key in the current owner assistant scope stops discovery ' + suffix, () => {
  const h = harness(), helper = h.make(); h.store.data.set('bondbuddy:upload-recovery:v1:owner-a:' + suffix, '{}');
  assert.throws(() => helper.list('topic-a'), UploadRecoveryStorageError); assert.deepEqual(methods(h), []);
});

test('incorrect complete receipt never associates or clears the original journal', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); h.state.complete = async () => material({ sha256: 'f'.repeat(64) });
  await assert.rejects(helper.resume(original, { file: file() })); assert.ok(h.store.length); assert.deepEqual(methods(h), ['create', 'put', 'complete']);
});

test('late owner change after complete prevents original-topic association and local success adoption', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper), gate = deferred<Dto<'MaterialResponse'>>(); h.state.complete = async () => gate.promise;
  const pending = helper.resume(original, { file: file() }); while (!h.calls.some(call => call.method === 'complete')) await new Promise(done => setTimeout(done, 1));
  h.state.live = false; gate.resolve(material()); await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(methods(h), ['create', 'put', 'complete']); assert.ok(h.store.length);
});

test('late owner change while reading original topic prevents the subsequent material POST', async () => {
  const h = harness(), helper = h.make(), original = await h.begin(helper); h.state.beforeWorkspace = async () => { h.state.live = false; };
  await assert.rejects(helper.resume(original, { file: file() }), { name: 'AbortError' }); assert.deepEqual(methods(h), ['create', 'put', 'complete', 'workspace']);
});

test('unreliable storage stops before any assistant upload request', async () => {
  const h = harness(), helper = h.make(); h.store.fail = true; await assert.rejects(h.begin(helper), UploadRecoveryStorageError); assert.deepEqual(methods(h), []);
});
