import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ApiError, type Dto } from './api.js';
import { UploadRecovery, UploadRecoveryConflictError, type UploadRecoveryRecord } from './upload-recovery.js';

const bytes = 'synthetic original PDF';
const declaration: Dto<'UploadCreateRequest'> = { filename: 'original.pdf', role: 'audit', media_type: 'application/pdf', byte_size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
const file = () => new File([bytes], declaration.filename, { type: declaration.media_type });
const material = (upload = 'new-upload'): Dto<'MaterialResponse'> => ({ ...declaration, upload_id: upload, material_id: 'material-a', material_version: 1, state: 'persisted', persisted_at: '2026-11-09T15:00:01Z', error: null });
const pending = () => new ApiError(422, 'MATERIAL_UNREADABLE', { uploadBytesPending: true });
const flush = () => new Promise(resolve => setImmediate(resolve));
class Store {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
function fixture(expired = true) {
  const store = new Store(), calls: string[] = [];
  const state = { current: true, old: async (): Promise<Dto<'MaterialResponse'>> => { throw pending(); }, fresh: async () => material(), put: async () => {}, createdId: 'new-upload' };
  const api = {
    createUpload: async () => { calls.push('create'); return { upload_id: state.createdId, state: 'uploading' as const, upload_url: '/new/bytes', expires_at: '2026-11-09T15:15:00Z', max_bytes: 104857600 }; },
    uploadBytes: async () => { calls.push('put'); await state.put(); },
    completeUpload: async (_p: string, id: string) => { calls.push('complete:' + id); return id === 'old-upload' ? state.old() : state.fresh(); },
    project: async () => { throw new Error('Unexpected project fallback'); },
    material: async () => { calls.push('material'); return material(); },
  };
  const make = (owner = 'owner-a') => new UploadRecovery(api, owner, 'project-a', 'purpose-a', () => state.current, { store, now: () => Date.parse('2026-11-09T15:00:00Z'), digest: async f => createHash('sha256').update(Buffer.from(await f.arrayBuffer())).digest('hex'), lock: { run: async (_name, action) => action() } });
  const recovery = make(); recovery.begin(declaration, undefined, 'operation-a');
  const key = [...store.data.keys()][0];
  const record: UploadRecoveryRecord = { ...JSON.parse(store.getItem(key)!), stage: 'bytes_unknown', uploadId: 'old-upload', expiresAt: expired ? '2026-11-09T09:00:00Z' : '2026-11-09T15:15:00Z', lastError: { status: 521, code: 'DATA_UNAVAILABLE' } };
  store.setItem(key, JSON.stringify(record));
  return { store, calls, state, recovery, make, record };
}
const selection = () => ({ file: file(), reselectExpiredSession: true });

test('explicit expired reselection confirms old identity, creates one fresh session and PUTs once', async () => {
  const f = fixture(); const m = await f.recovery.resume('operation-a', { ...selection(), previousRecord: f.record });
  assert.deepEqual(f.calls, ['complete:old-upload', 'create', 'put', 'complete:new-upload']);
  assert.equal(m.upload_id, 'new-upload'); const saved = f.recovery.list()[0];
  assert.deepEqual(saved.previousUploadIds, ['old-upload']); assert.deepEqual(saved.declaration, declaration); assert.equal(saved.stage, 'saved');
});

test('expired old upload already saved is reused without creating or sending bytes', async () => {
  const f = fixture(); f.state.old = async () => material('old-upload');
  assert.equal((await f.recovery.resume('operation-a', selection())).upload_id, 'old-upload');
  assert.deepEqual(f.calls, ['complete:old-upload']);
});

test('received old upload finishes its confirmation before any replacement is considered', async () => {
  const f = fixture(); let finish!: (m: Dto<'MaterialResponse'>) => void;
  f.state.old = () => new Promise(resolve => { finish = resolve; });
  const work = f.recovery.resume('operation-a', selection()); await flush();
  assert.deepEqual(f.calls, ['complete:old-upload']); finish(material('old-upload'));
  assert.equal((await work).upload_id, 'old-upload'); assert.deepEqual(f.calls, ['complete:old-upload']);
});

for (const explicit of [true, false]) test(explicit ? 'unexpired unknown upload still waits on its original ID after reselection' : 'passive retry with retained file never replaces an expired unknown upload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(!explicit);
  const work = f.recovery.resume('operation-a', { file: file(), reselectExpiredSession: explicit }); await flush();
  assert.deepEqual(f.calls, ['complete:old-upload']); f.state.old = async () => material('old-upload');
  t.mock.timers.tick(2000); await flush(); assert.equal((await work).upload_id, 'old-upload');
  assert.deepEqual(f.calls, ['complete:old-upload', 'complete:old-upload']);
});

test('wrong reselected hash is rejected before confirmation or creation', async () => {
  const f = fixture(); const wrong = new File(['x'.repeat(declaration.byte_size)], declaration.filename, { type: declaration.media_type });
  await assert.rejects(f.recovery.resume('operation-a', { file: wrong, reselectExpiredSession: true }), UploadRecoveryConflictError);
  assert.deepEqual(f.calls, []); assert.equal(f.recovery.list()[0].uploadId, 'old-upload');
});

test('refresh and reopen after an uncertain replacement PUT confirm only the new ID, then its saved version', async () => {
  const f = fixture(); f.state.put = async () => { throw new ApiError(524, 'DATA_UNAVAILABLE'); };
  f.state.fresh = async () => { throw new ApiError(0, 'DATA_UNAVAILABLE'); };
  await assert.rejects(f.recovery.resume('operation-a', selection()), ApiError);
  const checkpoint = f.recovery.list()[0]; assert.equal(checkpoint.uploadId, 'new-upload'); assert.deepEqual(checkpoint.previousUploadIds, ['old-upload']);
  f.state.fresh = async () => material(); await f.make().resume('operation-a'); await f.make().resume('operation-a');
  assert.deepEqual(f.calls, ['complete:old-upload', 'create', 'put', 'complete:new-upload', 'complete:new-upload', 'material']);
});

test('only the exact bytes-pending response permits replacement; authentication and inspection errors stop', async () => {
  for (const error of [new ApiError(401, 'UNAUTHENTICATED'), new ApiError(403, 'FORBIDDEN'), new ApiError(404, 'NOT_FOUND'), new ApiError(409, 'IDEMPOTENCY_CONFLICT'), new ApiError(422, 'MATERIAL_UNREADABLE'), new ApiError(422, 'MATERIAL_UNREADABLE', { uploadBytesPending: true, uploadReason: 'inspection_timeout' }), new ApiError(0, 'DATA_UNAVAILABLE')]) {
    const f = fixture(); f.state.old = async () => { throw error; };
    await assert.rejects(f.recovery.resume('operation-a', selection()), e => e === error);
    assert.deepEqual(f.calls, ['complete:old-upload']); assert.equal(f.recovery.list()[0].uploadId, 'old-upload');
  }
});

test('owner, current-page and cancellation boundaries prevent replacement', async () => {
  for (const kind of ['owner', 'current', 'cancel']) {
    const f = fixture(); const c = new AbortController(); if (kind === 'current') f.state.current = false; if (kind === 'cancel') c.abort();
    await assert.rejects((kind === 'owner' ? f.make('owner-b') : f.recovery).resume('operation-a', { ...selection(), signal: c.signal }));
    assert.deepEqual(f.calls, []);
  }
});

test('a reused old session ID is rejected before PUT and the old record is retained', async () => {
  const f = fixture(); f.state.createdId = 'old-upload';
  await assert.rejects(f.recovery.resume('operation-a', selection()));
  assert.deepEqual(f.calls, ['complete:old-upload', 'create']); assert.equal(f.recovery.list()[0].uploadId, 'old-upload');
});


test('original-ID filename changes are rejected while canonical reuse retains its legitimate old name', async () => {
  const bad = fixture(); bad.state.old = async () => ({ ...material('old-upload'), filename: 'wrong.pdf' });
  await assert.rejects(bad.recovery.resume('operation-a', selection())); assert.deepEqual(bad.calls, ['complete:old-upload']);
  const reused = fixture(); reused.state.old = async () => ({ ...material('canonical-upload'), filename: 'canonical.pdf' });
  const result = await reused.recovery.resume('operation-a', selection()); assert.equal(result.upload_id, 'canonical-upload');
  assert.deepEqual(reused.calls, ['complete:old-upload']);
});
