import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {uploadFileSha256} from './upload-file-digest.js';
import { M1_UPLOAD_MIME_TYPES, UPLOAD_INSPECTION_PUBLIC_REASONS } from '@bondbuddy/contracts';
import { ApiError, type Dto } from './api.js';
import { UploadRecovery, UploadRecoveryConflictError, UploadRecoveryLockError, UploadRecoveryNeedsFileError,
  UploadRecoveryReceiptError, UploadRecoveryStorageError, validateUploadMaterial,
  type UploadRecoveryLock, type UploadRecoveryRecord, type UploadRecoveryStorage } from './upload-recovery.js';

const mime = M1_UPLOAD_MIME_TYPES[0], bytes = 'original bytes', sha = createHash('sha256').update(bytes).digest('hex');
const declaration = (): Dto<'UploadCreateRequest'> => ({ filename: '原始.docx', media_type: mime, byte_size: Buffer.byteLength(bytes), sha256: sha, role: 'other' });
const file = (name = '原始.docx', body = bytes, type: string = mime) => new File([body], name, { type });
const material = (change: Partial<Dto<'MaterialResponse'>> = {}): Dto<'MaterialResponse'> => ({ material_id: 'material-a', material_version: 2, upload_id: 'upload-a',
  role: 'other', filename: '原始.docx', media_type: mime, byte_size: Buffer.byteLength(bytes), sha256: sha, state: 'persisted', persisted_at: '2026-10-25T10:00:00Z', error: null, ...change });
const session = (change: Partial<Dto<'UploadSessionResponse'>> = {}): Dto<'UploadSessionResponse'> => ({ upload_id: 'upload-a', state: 'uploading', upload_url: 'https://storage.invalid/private-token', expires_at: '2026-10-25T11:00:00Z', max_bytes: 1000, ...change });
const project = (): Dto<'ProjectResponse'> => ({ project_id: 'project-a', draft_revision: 1, input_revision: null, input_hash: null, name: 'A', kind: 'update', issuer_name: null, market: null, offering: null, updated_at: '2026-10-25T10:00:00Z' });
class Store implements UploadRecoveryStorage {
  data = new Map<string, string>(); onSet?: (key: string, value: string) => void; onGet?: (key: string, value: string | null) => string | null;
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { const value = this.data.get(key) ?? null; return this.onGet ? this.onGet(key, value) : value; }
  setItem(key: string, value: string) { this.onSet?.(key, value); this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
class Lock implements UploadRecoveryLock {
  active = new Set<string>();
  async run<T>(name: string, action: () => Promise<T>, signal?: AbortSignal) {
    signal?.throwIfAborted(); if (this.active.has(name)) throw new UploadRecoveryLockError(); this.active.add(name);
    try { return await action(); } finally { this.active.delete(name); }
  }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function harness(store = new Store(), lock = new Lock()) {
  const calls: { method: string; project?: string; id?: string; input?: unknown; version?: number }[] = [];
  const h = { store, lock, calls, live: true, sequence: 0, emitProgress: true,
    create: async () => session(), complete: async () => material(), put: async () => {}, get: async () => material(), project: async () => project() };
  const api: ConstructorParameters<typeof UploadRecovery>[0] = {
    createUpload: async (p, input) => { calls.push({ method: 'create', project: p, input }); return h.create(); },
    completeUpload: async (p, id, input) => { calls.push({ method: 'complete', project: p, id, input }); return h.complete(); },
    uploadBytes: async (_url, f, progress) => { calls.push({ method: 'put', input: f.name }); if (h.emitProgress) progress(f.size, f.size); return h.put(); },
    material: async (p, id, _signal, version) => { calls.push({ method: 'material', project: p, id, version }); return h.get(); },
    project: async p => { calls.push({ method: 'project', project: p }); return h.project(); },
  };
  const make = (owner = 'owner-a', p = 'project-a', purpose = 'purpose-a', useLock = true) => new UploadRecovery(api, owner, p, purpose, () => h.live,
    { store, ...(useLock ? { lock } : {}), now: () => Date.parse('2026-10-25T10:00:00Z'), id: () => 'nonce-' + ++h.sequence });
  return { ...h, make, api, state: h };
}
function seed(h: ReturnType<typeof harness>, recovery: UploadRecovery, change: Partial<UploadRecoveryRecord> = {}) {
  const record = recovery.begin(declaration(), { request_id: 'original-cas-request', expected_revision: 3 }, 'op-a');
  const key = [...h.store.data.keys()].find(key => JSON.parse(h.store.data.get(key)!).id === record.id)!;
  const updated = { ...record, uploadId: 'upload-a', expiresAt: '2026-10-25T11:00:00Z', stage: 'session' as const, ...change };
  h.store.data.set(key, JSON.stringify(updated)); return { record: updated, key };
}
const methods = (h: ReturnType<typeof harness>) => h.calls.map(call => call.method);

test('begin/list are network-free, detached and preserve full business context including URL text', () => {
  const h = harness(), r = h.make(), input = declaration(), context = { request_id: 'original', requirements: ['https://issuer.invalid 是补充说明'], expected_revision: 5 };
  const item = r.begin(input, context, 'op-a'); input.filename = 'changed.docx'; context.requirements.push('changed'); item.declaration.filename = 'outside.docx';
  assert.equal(r.list()[0].declaration.filename, '原始.docx'); assert.deepEqual(r.list()[0].context, { request_id: 'original', requirements: ['https://issuer.invalid 是补充说明'], expected_revision: 5 });
  assert.deepEqual(methods(h), []); assert.equal(h.store.length, 1);
});

test('same ID is idempotent for semantically equal declarations/context and rejects changed original body', () => {
  const h = harness(), r = h.make(); r.begin(declaration(), { a: 1, b: 2 }, 'op-a');
  assert.equal(r.begin(Object.fromEntries(Object.entries(declaration()).reverse()) as Dto<'UploadCreateRequest'>, { b: 2, a: 1 }, 'op-a').id, 'op-a'); assert.equal(h.store.length, 1);
  assert.throws(() => r.begin({ ...declaration(), role: 'legal' }, { a: 1, b: 2 }, 'op-a'), UploadRecoveryConflictError);
  assert.throws(() => r.begin(declaration(), { a: 2, b: 2 }, 'op-a'), UploadRecoveryConflictError);
});

test('journal reads isolate owner, actual project and purpose', () => {
  const h = harness(); for (const [owner, p, purpose] of [['owner-a', 'project-a', 'purpose-a'], ['owner-b', 'project-a', 'purpose-a'], ['owner-a', 'project-b', 'purpose-a'], ['owner-a', 'project-a', 'purpose-b']]) h.make(owner, p, purpose).begin(declaration(), undefined, 'op-a');
  assert.equal(h.store.length, 4); for (const record of h.make().list()) { assert.equal(record.owner, 'owner-a'); assert.equal(record.projectId, 'project-a'); assert.equal(record.purpose, 'purpose-a'); }
});

test('conditional context updates cannot overwrite another tab confirmation with a stale preview',async()=>{
  const h=harness(),first=h.make(),second=h.make();first.begin(declaration(),undefined,'op-a');
  const pending={request:{request_id:'fixed',mapping:['A','B']}};
  await first.updateContext('op-a',pending,{context:undefined});
  await assert.rejects(second.updateContext('op-a',{draft:{mapping:['C']}},{context:undefined}),UploadRecoveryConflictError);
  assert.deepEqual(second.list()[0].context,pending);
  await second.updateContext('op-a',pending,{context:pending});assert.deepEqual(methods(h),[]);
});

test('fresh explicit resume does create PUT complete in order and persists each identity before writes', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a');
  h.state.create = async () => { assert.equal(r.list()[0].stage, 'creating'); return session(); };
  h.state.put = async () => { assert.equal(r.list()[0].uploadId, 'upload-a'); assert.equal(r.list()[0].stage, 'bytes_unknown'); };
  h.state.complete = async () => { assert.equal(r.list()[0].stage, 'confirming'); return material(); };
  assert.deepEqual(await r.resume('op-a', { file: file() }), material()); assert.deepEqual(methods(h), ['create', 'put', 'complete']);
  assert.equal(r.list()[0].stage, 'saved'); assert.ok(![...h.store.data.values()].join('').includes('private-token')); assert.ok(![...h.store.data.values()].join('').includes('upload_url'));
});

test('pending without file prompts locally without creating a session', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a');
  await assert.rejects(r.resume('op-a'), error => error instanceof UploadRecoveryNeedsFileError && error.record.declaration.filename === '原始.docx'); assert.deepEqual(methods(h), []);
});

test('unknown PUT automatically confirms without another PUT or File', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a'); h.state.put = async () => { throw new ApiError(0, 'DATA_UNAVAILABLE'); };
  assert.deepEqual(await r.resume('op-a', { file: file() }), material()); assert.equal(r.list()[0].stage, 'saved');
  assert.deepEqual(methods(h), ['create', 'put', 'complete']);
});

test('unknown complete after registration is confirmed by original ID after reload', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a'); h.state.complete = async () => { throw new ApiError(503, 'DATA_UNAVAILABLE'); };
  await assert.rejects(r.resume('op-a', { file: file() }), ApiError); h.state.complete = async () => material();
  await h.make().resume('op-a'); assert.deepEqual(methods(h), ['create', 'put', 'complete', 'complete']); assert.equal(h.calls.at(-1)!.id, 'upload-a');
});

test('an expired session still completes first without File or replacement create', async () => {
  const h = harness(), r = h.make(); seed(h, r, { expiresAt: '2020-01-01T00:00:00Z' }); await r.resume('op-a'); assert.deepEqual(methods(h), ['complete']);
});

test('refreshed session without URL confirms then asks for exact bytes, retaining old identity', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.state.complete = async () => { throw new ApiError(422, 'MATERIAL_UNREADABLE'); };
  await assert.rejects(h.make().resume('op-a'), UploadRecoveryNeedsFileError); assert.deepEqual(methods(h), ['complete']); assert.equal(r.list()[0].uploadId, 'upload-a');
});

test('reselection after URL loss confirms old upload before explicit replacement and keeps old declaration/history', async () => {
  const h = harness(), r = h.make(); seed(h, r); let confirmations = 0;
  h.state.complete = async () => { if (++confirmations === 1) throw new ApiError(422, 'MATERIAL_UNREADABLE'); return material({ upload_id: 'replacement' }); };
  h.state.create = async () => session({ upload_id: 'replacement' });
  await h.make().resume('op-a', { file: file('renamed.docx') }); assert.deepEqual(methods(h), ['complete', 'create', 'put', 'complete']);
  assert.equal((h.calls[1].input as Dto<'UploadCreateRequest'>).filename, '原始.docx'); assert.deepEqual(r.list()[0].previousUploadIds, ['upload-a']);
});

test('authentication recovery confirms the original upload without replaying rejected PUT bytes', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a'); h.state.put = async () => { throw new ApiError(401, 'UNAUTHENTICATED'); };
  await assert.rejects(r.resume('op-a', { file: file() }));
  assert.deepEqual(await r.resume('op-a'), material());
  assert.deepEqual(methods(h), ['create', 'put', 'complete']);
});

for (const reason of UPLOAD_INSPECTION_PUBLIC_REASONS) test('inspection reason ' + reason + ' preserves original identity and never means missing bytes', async () => {
  const h = harness(), r = h.make(); seed(h, r); const error = new ApiError(422, 'MATERIAL_UNREADABLE', { uploadReason: reason, correlationId: 'trace-a' });
  h.state.complete = async () => { throw error; }; await assert.rejects(r.resume('op-a', { file: file() }), actual => actual === error);
  assert.deepEqual(methods(h), ['complete']); assert.equal(r.list()[0].lastError!.uploadReason, reason); assert.equal(r.list()[0].lastError!.correlationId, 'trace-a');
});

for (const reason of ['inspection_timeout', 'inspection_queue_timeout', 'inspection_worker_failed'] as const) test('explicit retry after unknown PUT and temporary ' + reason + ' rechecks only the original upload', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a');
  h.state.put = async () => { throw new ApiError(0, 'DATA_UNAVAILABLE'); };
  h.state.complete = async () => { throw new ApiError(422, 'MATERIAL_UNREADABLE', { uploadReason: reason }); };
  await assert.rejects(r.resume('op-a', { file: file() }), error => error instanceof ApiError && error.details.uploadReason === reason);
  assert.equal(r.list()[0].stage, 'bytes_unknown'); assert.equal(r.list()[0].lastError!.status, 422);
  h.state.complete = async () => material();
  assert.deepEqual(await h.make().resume('op-a'), material());
  assert.deepEqual(methods(h), ['create', 'put', 'complete', 'complete']);
  assert.ok(h.calls.filter(call => call.method === 'complete').every(call => call.id === 'upload-a'));
  assert.equal(r.list()[0].stage, 'saved'); assert.equal(r.list()[0].lastError, undefined);
});

for (const reason of ['structure_invalid', 'content_mismatch', 'unsupported_content', 'encrypted_content', 'external_link_invalid', 'size_limit']) test('unknown PUT with terminal ' + reason + ' remains rejected without another request', async () => {
  const h = harness(), r = h.make();
  seed(h, r, { stage: 'bytes_unknown', lastError: { status: 422, code: 'MATERIAL_UNREADABLE', uploadReason: reason } });
  await assert.rejects(r.resume('op-a', { file: file() }), error => error instanceof ApiError && error.status === 422 && error.details.uploadReason === reason);
  assert.deepEqual(methods(h), []); assert.equal(r.list()[0].uploadId, 'upload-a'); assert.equal(r.list()[0].stage, 'bytes_unknown');
});

for (const previous of [{ status: 422, code: 'MATERIAL_UNREADABLE' }, { status: 422, code: 'MATERIAL_CONTENT_MISMATCH', uploadReason: 'inspection_timeout' }, { status: 403, code: 'FORBIDDEN', uploadReason: 'inspection_timeout' }]) test('unknown PUT cannot treat non-temporary response ' + JSON.stringify(previous) + ' as a retryable inspection', async () => {
  const h = harness(), r = h.make(); seed(h, r, { stage: 'bytes_unknown', lastError: previous });
  await assert.rejects(r.resume('op-a', { file: file() }), error => error instanceof ApiError && error.status === previous.status && error.code === previous.code);
  assert.deepEqual(methods(h), []); assert.equal(r.list()[0].uploadId, 'upload-a');
});

for (const [status, code] of [[503, 'DATA_UNAVAILABLE'], [422, 'MATERIAL_CONTENT_MISMATCH'], [409, 'IDEMPOTENCY_CONFLICT'], [415, 'UNSUPPORTED_MEDIA_TYPE'], [401, 'UNAUTHENTICATED']] as const) test('complete ' + status + ' ' + code + ' cannot replace or retransmit', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.state.complete = async () => { throw new ApiError(status, code); };
  await assert.rejects(r.resume('op-a', { file: file() }), ApiError); assert.deepEqual(methods(h), ['complete']); assert.equal(r.list()[0].uploadId, 'upload-a');
});

test('404 cannot replace a session before actual-project authorization succeeds', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.state.complete = async () => { throw new ApiError(404, 'NOT_FOUND'); }; h.state.project = async () => { throw new ApiError(404, 'NOT_FOUND'); };
  await assert.rejects(r.resume('op-a', { file: file() }), ApiError); assert.deepEqual(methods(h), ['complete', 'project']); assert.equal(r.list()[0].uploadId, 'upload-a');
});

test('authorized 404 still needs explicit bytes and never guesses an upload URL', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.state.complete = async () => { throw new ApiError(404, 'NOT_FOUND'); };
  await assert.rejects(r.resume('op-a'), UploadRecoveryNeedsFileError); assert.deepEqual(methods(h), ['complete', 'project']);
});

test('authorized 404 with matching bytes may replace; wrong project receipt is rejected', async () => {
  const h = harness(), r = h.make(); seed(h, r); let count = 0; h.state.complete = async () => { if (++count === 1) throw new ApiError(404, 'NOT_FOUND'); return material({ upload_id: 'new' }); }; h.state.create = async () => session({ upload_id: 'new' });
  await r.resume('op-a', { file: file() }); assert.deepEqual(methods(h), ['complete', 'project', 'create', 'put', 'complete']);
  const other = harness(), rr = other.make(); seed(other, rr); other.state.complete = async () => { throw new ApiError(404, 'NOT_FOUND'); }; other.state.project = async () => ({ ...project(), project_id: 'other' });
  await assert.rejects(rr.resume('op-a', { file: file() }), UploadRecoveryReceiptError); assert.deepEqual(methods(other), ['complete', 'project']);
});

for (const f of [() => file('same.docx', 'altered bytes!'), () => file('same.docx', bytes + 'x'), () => file('same.pdf', bytes, M1_UPLOAD_MIME_TYPES[1])]) test('reselected changed content, size or extension cannot alter original operation', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.state.complete = async () => { throw new ApiError(422, 'MATERIAL_UNREADABLE'); };
  await assert.rejects(r.resume('op-a', { file: f() }), UploadRecoveryConflictError); assert.deepEqual(methods(h), ['complete']); assert.equal(r.list()[0].declaration.sha256, sha);
});

test('legal reuse receipt may have old upload ID and old name, while all declared fields match', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.state.complete = async () => material({ upload_id: 'original-older-upload', filename: '旧名称.docx' });
  const result = await r.resume('op-a'); assert.equal(result.upload_id, 'original-older-upload'); assert.equal(r.list()[0].uploadId, 'upload-a');
});

for (const change of [{ sha256: 'f'.repeat(64) }, { byte_size: 1 }, { role: 'legal' }, { media_type: M1_UPLOAD_MIME_TYPES[1] }, { state: 'uploading' }, { error: 'failed' }, { material_version: 0 }, { persisted_at: '2026-02-30T00:00:00Z' }]) test('incorrect material receipt ' + JSON.stringify(change) + ' never becomes a pin', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.state.complete = async () => ({ ...material(), ...change }) as Dto<'MaterialResponse'>;
  await assert.rejects(r.resume('op-a'), UploadRecoveryReceiptError); assert.equal(r.list()[0].material, undefined); assert.deepEqual(methods(h), ['complete']);
});

test('already-saved recovery reads original scoped exact version and never uploads', async () => {
  const h = harness(), r = h.make(); seed(h, r, { stage: 'saved', material: material() });
  await h.make().resume('op-a'); assert.deepEqual(h.calls, [{ method: 'material', project: 'project-a', id: 'material-a', version: 2 }]);
});

for (const change of [{ material_version: 3 }, { material_id: 'other-material' }, { upload_id: 'other-upload' }, { sha256: 'a'.repeat(64) }]) test('saved recovery rejects metadata substitution ' + JSON.stringify(change), async () => {
  const h = harness(), r = h.make(); seed(h, r, { stage: 'saved', material: material() }); h.state.get = async () => material(change);
  await assert.rejects(r.resume('op-a'), UploadRecoveryReceiptError); assert.equal(r.list()[0].material!.material_version, 2); assert.deepEqual(methods(h), ['material']);
});

test('create response loss leaves creating without guessed ID; explicit file retry creates a new session only', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a'); h.state.create = async () => { throw new ApiError(0, 'DATA_UNAVAILABLE'); };
  await assert.rejects(r.resume('op-a', { file: file() })); assert.equal(r.list()[0].stage, 'creating'); assert.equal(r.list()[0].uploadId, undefined);
  h.state.create = async () => session(); await h.make().resume('op-a', { file: file() }); assert.deepEqual(methods(h), ['create', 'create', 'put', 'complete']);
});

for (const change of [{ expires_at: '2020-01-01T00:00:00Z' }, { expires_at: '2026-02-30T00:00:00Z' }, { max_bytes: 1 }, { upload_url: 'javascript:alert(1)' }, { upload_id: '' }]) test('invalid session ' + JSON.stringify(change) + ' stops before PUT', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a'); h.state.create = async () => session(change);
  await assert.rejects(r.resume('op-a', { file: file() }), UploadRecoveryReceiptError); assert.deepEqual(methods(h), ['create']); assert.equal(r.list()[0].uploadId, undefined);
});

test('unavailable/full store and failed read-back stop before network and retain a visible error', async () => {
  const h = harness(), r = h.make(); h.store.onSet = () => { throw new Error('QuotaExceeded'); }; assert.throws(() => r.begin(declaration()), UploadRecoveryStorageError); assert.deepEqual(methods(h), []);
  h.store.onSet = undefined; r.begin(declaration(), undefined, 'op-a'); h.store.onSet = () => { throw new Error('QuotaExceeded'); };
  await assert.rejects(r.resume('op-a', { file: file() }), UploadRecoveryStorageError); assert.deepEqual(methods(h), []);
  const bad = harness(), rr = bad.make(); bad.store.onGet = () => null; assert.throws(() => rr.begin(declaration()), UploadRecoveryStorageError);
});

test('session receipt followed by local save failure must not PUT; same instance preserves identity for confirmation', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a');
  h.store.onSet = (_key, raw) => { if (JSON.parse(raw).stage === 'session') throw new Error('full'); };
  await assert.rejects(r.resume('op-a', { file: file() }), UploadRecoveryStorageError); assert.deepEqual(methods(h), ['create']); assert.equal(r.list()[0].uploadId, undefined);
  h.store.onSet = undefined; await r.resume('op-a'); assert.deepEqual(methods(h), ['create', 'complete']); assert.equal(r.list()[0].uploadId, 'upload-a');
});

test('material receipt followed by local save failure keeps durable original ID and re-confirms after reload', async () => {
  const h = harness(), r = h.make(); seed(h, r); h.store.onSet = (_key, raw) => { if (JSON.parse(raw).stage === 'saved') throw new Error('full'); };
  await assert.rejects(r.resume('op-a'), error => {
    assert.ok(error instanceof UploadRecoveryStorageError);
    assert.deepEqual(error.confirmedMaterial, material());
    assert.deepEqual(error.record?.material, material());
    assert.equal(error.record?.lastError, undefined);
    return true;
  });
  assert.equal(r.list()[0].uploadId, 'upload-a'); assert.equal(r.list()[0].material, undefined);
  h.store.onSet = undefined; await h.make().resume('op-a'); assert.deepEqual(methods(h), ['complete', 'complete']);
});

for (const status of [404, 503]) test('saved checkpoint cannot masquerade as a fresh receipt when recheck ' + status + ' and error journaling fail', async () => {
  const h = harness(), r = h.make();
  const original = seed(h, r, { stage: 'saved', material: material() }).record;
  h.state.get = async () => { throw new ApiError(status, status === 404 ? 'NOT_FOUND' : 'DATA_UNAVAILABLE'); };
  h.store.onSet = (_key, raw) => { if (JSON.parse(raw).lastError) throw new Error('full'); };
  await assert.rejects(r.resume('op-a'), error => {
    assert.ok(error instanceof UploadRecoveryStorageError);
    assert.deepEqual(error.record?.material, material());
    assert.equal(error.record?.lastError?.status, status);
    assert.equal(error.confirmedMaterial, undefined);
    return true;
  });
  assert.deepEqual(r.list()[0], original);
  assert.deepEqual(h.calls, [{ method: 'material', project: 'project-a', id: 'material-a', version: 2 }]);
});

test('a second tab cannot concurrently confirm the same operation; it can verify the saved pin later', async () => {
  const h = harness(), first = h.make(), second = h.make(), gate = deferred<Dto<'MaterialResponse'>>(); seed(h, first); h.state.complete = async () => gate.promise;
  const pending = first.resume('op-a'); await assert.rejects(second.resume('op-a'), UploadRecoveryLockError); gate.resolve(material()); await pending; await second.resume('op-a'); assert.deepEqual(methods(h), ['complete', 'material']);
});

test('explicit retry restores a missing journal checkpoint and confirms its original upload without create or PUT', async () => {
  const h = harness(), first = h.make(), second = h.make(), retained = seed(h, first).record;
  await first.forget('op-a'); assert.equal(h.store.length, 0);
  h.state.complete = async () => { assert.ok(h.lock.active.size); assert.equal(second.list()[0].uploadId, 'upload-a'); return material(); };
  await second.resume('op-a', { previousRecord: retained });
  assert.deepEqual(h.calls, [{ method: 'complete', project: 'project-a', id: 'upload-a', input: { byte_size: declaration().byte_size, sha256: sha } }]);
  assert.equal(second.list()[0].stage, 'saved'); assert.deepEqual(second.list()[0].context, retained.context);
});

test('explicit retry restores a missing saved checkpoint and reads its original project/material/exact version', async () => {
  const h = harness(), r = h.make(), retained = seed(h, r, { stage: 'saved', material: material() }).record;
  await r.forget('op-a'); await h.make().resume('op-a', { previousRecord: retained });
  assert.deepEqual(h.calls, [{ method: 'material', project: 'project-a', id: 'material-a', version: 2 }]);
  assert.equal(r.list()[0].material!.material_version, 2);
});

for (const change of [{ owner: 'owner-b' }, { projectId: 'project-b' }, { purpose: 'purpose-b' }, { id: 'op-b' }, { version: 2 }, { stage: 'saved' }, { declaration: { ...declaration(), sha256: 'invalid' } }]) test('missing checkpoint rejects foreign or malformed original identity ' + JSON.stringify(change), async () => {
  const h = harness(), r = h.make(), retained = seed(h, r).record; await r.forget('op-a');
  await assert.rejects(r.resume('op-a', { previousRecord: { ...retained, ...change } as UploadRecoveryRecord }), UploadRecoveryConflictError);
  assert.equal(h.store.length, 0); assert.deepEqual(methods(h), []);
});

test('checkpoint cannot overwrite an existing ID with a different original declaration', async () => {
  const h = harness(), r = h.make(), retained = seed(h, r).record;
  await r.forget('op-a'); r.begin({ ...declaration(), role: 'legal' }, { original: 'other' }, 'op-a'); const before = [...h.store.data];
  await assert.rejects(r.resume('op-a', { previousRecord: retained }), UploadRecoveryConflictError);
  assert.deepEqual([...h.store.data], before); assert.deepEqual(methods(h), []);
});

test('checkpoint keeps the newer durable session and exact business context when the declaration still matches', async () => {
  const h = harness(), r = h.make(), { record: retained, key } = seed(h, r);
  const newer = { ...retained, uploadId: 'upload-newer', previousUploadIds: ['upload-a'], context: { request_id: 'newer-cas', expected_revision: 9 } };
  h.store.data.set(key, JSON.stringify(newer)); h.state.complete = async () => material({ upload_id: 'upload-newer' });
  await r.resume('op-a', { previousRecord: retained });
  assert.equal(h.calls[0].id, 'upload-newer'); assert.deepEqual(r.list()[0].context, newer.context); assert.equal(h.store.length, 1);
});

test('checkpoint cannot overwrite corrupt scoped storage or append beside duplicate identities', async () => {
  for (const corrupt of [true, false]) {
    const h = harness(), r = h.make(), { record: retained, key } = seed(h, r);
    if (corrupt) h.store.data.set(key, '{broken'); else h.store.data.set(key + '-duplicate', h.store.data.get(key)!);
    const before = [...h.store.data];
    await assert.rejects(r.resume('op-a', { previousRecord: retained }), corrupt ? UploadRecoveryStorageError : UploadRecoveryConflictError);
    assert.deepEqual([...h.store.data], before); assert.deepEqual(methods(h), []);
  }
});

test('checkpoint persistence failure prevents all network calls and retains the original retry identity in the error', async () => {
  const h = harness(), r = h.make(), retained = seed(h, r).record; await r.forget('op-a');
  h.store.onSet = () => { throw new Error('full'); };
  await assert.rejects(r.resume('op-a', { previousRecord: retained }), error => error instanceof UploadRecoveryStorageError && error.record?.uploadId === 'upload-a');
  assert.equal(h.store.length, 0); assert.deepEqual(methods(h), []);
});

test('checkpoint rejects File Blob URL and hidden transport payloads before serialization', async () => {
  const hidden = Object.defineProperty({}, 'upload_url', { value: 'https://private.invalid/token', enumerable: false });
  const accessor = Object.defineProperty({}, 'note', { get() { throw new Error('must not execute'); }, enumerable: true });
  const array = Object.assign(['business note'], { upload_url: 'https://private.invalid/token' });
  for (const context of [{ data: file() }, { data: new Blob([bytes]) }, { data: new URL('https://private.invalid/token') }, { upload_url: 'https://private.invalid/token' }, hidden, accessor, array]) {
    const h = harness(), r = h.make(), retained = seed(h, r).record; await r.forget('op-a');
    await assert.rejects(r.resume('op-a', { previousRecord: { ...retained, context: context as never } }), UploadRecoveryConflictError);
    assert.equal(h.store.length, 0); assert.deepEqual(methods(h), []);
  }
});

test('missing journal without an explicit retained checkpoint never scans or starts an upload', async () => {
  const h = harness(), r = h.make(); seed(h, r); await r.forget('op-a');
  await assert.rejects(r.resume('op-a', { file: file() }), UploadRecoveryConflictError);
  assert.deepEqual(methods(h), []); assert.equal(h.store.length, 0);
});

for (const stage of ['pending', 'creating'] as const) test('missing journal cannot restore a stale ' + stage + ' checkpoint without an original upload ID even with a File', async () => {
  const h = harness(), r = h.make(), retained = { ...r.begin(declaration(), undefined, 'op-a'), stage }; await r.forget('op-a');
  await assert.rejects(r.resume('op-a', { previousRecord: retained, file: file() }), UploadRecoveryConflictError);
  assert.deepEqual(methods(h), []); assert.equal(h.store.length, 0);
});

test('an existing durable pending operation still begins its first upload when passed the same checkpoint', async () => {
  const h = harness(), r = h.make(), retained = r.begin(declaration(), undefined, 'op-a');
  await r.resume('op-a', { previousRecord: retained, file: file() });
  assert.deepEqual(methods(h), ['create', 'put', 'complete']);
});

test('checkpoint restoration requires the same exclusive operation lock before any journal mutation', async () => {
  const h = harness(), r = h.make(), retained = seed(h, r).record; await r.forget('op-a');
  h.lock.active.add('bondbuddy:upload-recovery:v1:owner-a:project-a:purpose-a:op-a');
  await assert.rejects(r.resume('op-a', { previousRecord: retained }), UploadRecoveryLockError);
  assert.deepEqual(methods(h), []); assert.equal(h.store.length, 0);
});

test('different operations do not overwrite each other and may progress independently', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), { target: 'a' }, 'op-a'); r.begin(declaration(), { target: 'b' }, 'op-b');
  await Promise.all([r.resume('op-a', { file: file() }), r.resume('op-b', { file: file() })]); assert.equal(r.list().length, 2); assert.ok(r.list().every(item => item.stage === 'saved'));
});

test('duplicate operation slots are explicit conflicts rather than fake localStorage CAS', async () => {
  const h = harness(), r = h.make(); const { key } = seed(h, r); h.store.data.set(key + '-other', h.store.data.get(key)!);
  assert.throws(() => r.list(), UploadRecoveryConflictError); await assert.rejects(r.resume('op-a'), UploadRecoveryConflictError); assert.deepEqual(methods(h), []); assert.equal(h.store.length, 2);
});

test('missing Web Locks fails explicitly, without a fake fallback or network request', async () => {
  const h = harness(), r = h.make('owner-a', 'project-a', 'purpose-a', false); r.begin(declaration(), undefined, 'op-a');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try { await assert.rejects(r.resume('op-a', { file: file() }), UploadRecoveryLockError); assert.deepEqual(methods(h), []); }
  finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator'); }
});

test('owner/route change suppresses late UI callbacks and receipt adoption', async () => {
  const h = harness(), r = h.make(), gate = deferred<Dto<'MaterialResponse'>>(); seed(h, r); h.state.complete = async () => gate.promise;
  let updates = 0; const pending = r.resume('op-a', { status: () => { updates++; }, progress: () => { updates++; } }); const before = updates;
  h.state.live = false; gate.resolve(material()); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(updates, before);
  h.state.live = true; assert.equal(r.list()[0].material, undefined); assert.equal(r.list()[0].uploadId, 'upload-a');
});

test('aborted requests cannot adopt late receipts or trigger a replacement', async () => {
  const h = harness(), r = h.make(), gate = deferred<Dto<'MaterialResponse'>>(), controller = new AbortController(); seed(h, r); h.state.complete = async () => gate.promise;
  const pending = r.resume('op-a', { signal: controller.signal }); controller.abort(); gate.resolve(material()); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(r.list()[0].material, undefined); assert.deepEqual(methods(h), ['complete']);
});

test('updateContext persists exact original business CAS body and forget only removes the local record', async () => {
  const h = harness(), r = h.make(); const original = seed(h, r).record;
  await r.updateContext('op-a', { request_id: 'original', expected_latest_version_id: 'version-old', target_report_id: 'original-report' });
  assert.deepEqual(r.list()[0].declaration, original.declaration); assert.equal(r.list()[0].uploadId, original.uploadId); assert.deepEqual(methods(h), []);
  await r.forget('op-a'); assert.deepEqual(r.list(), []); assert.deepEqual(methods(h), []);
});

test('two pages may finish local cleanup of a confirmed result without reviving its upload', async () => {
  const h = harness(), first = h.make(), second = h.make(); seed(h, first);
  await first.resume('op-a'); await first.forget('op-a'); await second.forget('op-a');
  assert.deepEqual(first.list(), []); assert.deepEqual(methods(h), ['complete']);
  await assert.rejects(second.resume('op-a'), UploadRecoveryConflictError);
  assert.deepEqual(methods(h), ['complete']);
});

test('cleanup of an absent item leaves sibling operations and other scopes untouched', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), { target: 'sibling' }, 'op-b');
  h.make('owner-b').begin(declaration(), { target: 'other account' }, 'op-a'); const before = [...h.store.data];
  await r.forget('op-a'); assert.deepEqual([...h.store.data], before); assert.deepEqual(methods(h), []);
});

test('absent cleanup still rejects corrupt or duplicate scoped journals', async () => {
  for (const corrupt of [true, false]) {
    const h = harness(), r = h.make(), { key } = seed(h, r);
    if (corrupt) h.store.data.set(key, '{broken'); else h.store.data.set(key + '-duplicate', h.store.data.get(key)!);
    const before = [...h.store.data];
    await assert.rejects(r.forget('absent'), corrupt ? UploadRecoveryStorageError : UploadRecoveryConflictError);
    assert.deepEqual([...h.store.data], before); assert.deepEqual(methods(h), []);
  }
});

test('cleanup reports removal failure and failed readback without claiming the item was removed', async () => {
  for (const readback of [false, true]) {
    const h = harness(), r = h.make(), { key } = seed(h, r), raw = h.store.data.get(key)!;
    if (readback) h.store.onGet = (current, value) => current === key ? raw : value;
    else h.store.removeItem = () => { throw new Error('storage unavailable'); };
    await assert.rejects(r.forget('op-a'), error => error instanceof UploadRecoveryStorageError && error.record?.id === 'op-a');
    assert.deepEqual(methods(h), []);
  }
});

test('absent cleanup still requires the original operation lock and a live page', async () => {
  const h = harness(), r = h.make();
  h.lock.active.add('bondbuddy:upload-recovery:v1:owner-a:project-a:purpose-a:absent');
  await assert.rejects(r.forget('absent'), UploadRecoveryLockError); h.lock.active.clear();
  h.state.live = false; await assert.rejects(r.forget('absent'), { name: 'AbortError' });
  assert.deepEqual(methods(h), []); assert.equal(h.store.length, 0);
});

test('invalid version/scope/schema journal records remain untouched and block unsafe execution', async () => {
  for (const change of [{ version: 2 }, { owner: 'other-owner' }, { purpose: 'other-purpose' }, { declaration: { ...declaration(), sha256: 'bad' } }, { stage: 'saved' }, { upload_url: 'https://secret.invalid' }]) {
    const h = harness(), r = h.make(), { key } = seed(h, r); const raw = JSON.stringify({ ...JSON.parse(h.store.data.get(key)!), ...change }); h.store.data.set(key, raw);
    assert.throws(() => r.list(), UploadRecoveryStorageError); await assert.rejects(r.resume('op-a'), UploadRecoveryStorageError); assert.equal(h.store.data.get(key), raw); assert.deepEqual(methods(h), []);
  }
});

test('context rejects transport URLs, files, bytes, cycles and non-finite values rather than serializing them', () => {
  const h = harness(), r = h.make(); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const context of [{ upload_url: 'https://secret.invalid' }, { file: file() }, new Uint8Array([1]), { data: file() }, cycle, { value: NaN }]) assert.throws(() => r.begin(declaration(), context as never), UploadRecoveryConflictError);
  assert.equal(h.store.length, 0);
});

test('declaration uses public role/media constraints and shared per-file size bound', () => {
  const h = harness(), r = h.make();
  for (const input of [{ ...declaration(), role: 'reference', media_type: M1_UPLOAD_MIME_TYPES[2] }, { ...declaration(), byte_size: 100 * 1024 * 1024 + 1 }, { ...declaration(), sha256: 'invalid' }]) assert.throws(() => r.begin(input as Dto<'UploadCreateRequest'>), UploadRecoveryReceiptError);
  assert.deepEqual(methods(h), []);
});

test('exported material validation rejects malformed public DTOs and returns a detached legal receipt', () => {
  assert.throws(() => validateUploadMaterial(declaration(), { ...material(), untrusted: true }), UploadRecoveryReceiptError);
  const original = material(), checked = validateUploadMaterial(declaration(), original); checked.filename = 'changed'; assert.equal(original.filename, '原始.docx');
});

for (const [ext, index] of [['docx', 0], ['pdf', 1], ['xlsx', 2], ['csv', 3], ['txt', 4], ['png', 5], ['jpg', 6], ['jpeg', 6], ['doc', 7]] as const) test('public upload media ' + ext + ' keeps original declaration despite generic browser File.type', async () => {
  const h = harness(), r = h.make(), media = M1_UPLOAD_MIME_TYPES[index];
  const input = { ...declaration(), filename: '原始.' + ext, media_type: media }; r.begin(input, undefined, 'op-a');
  h.state.complete = async () => material({ media_type: media, filename: input.filename });
  await r.resume('op-a', { file: file('renamed.' + ext, bytes, 'application/octet-stream') });
  assert.deepEqual(methods(h), ['create', 'put', 'complete']); assert.deepEqual(h.calls[0].input, input);
});

test('same bytes and valid extension survive an inaccurate browser MIME type', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a'); await r.resume('op-a', { file: file('renamed.docx', bytes, 'application/pdf') }); assert.deepEqual(methods(h), ['create', 'put', 'complete']);
});

test('small successful PUT without XHR progress reports all bytes while complete is still gated, after durable status changes', async () => {
  const h = harness(), r = h.make(), completeGate = deferred<Dto<'MaterialResponse'>>(), enteredComplete = deferred<void>();
  r.begin(declaration(), undefined, 'op-a'); h.state.emitProgress = false;
  const progress: [number, number][] = [], statuses: { text: string; stage: string }[] = [];
  h.state.complete = async () => { enteredComplete.resolve(); return completeGate.promise; };
  const pending = r.resume('op-a', { file: file(), progress: (loaded, total) => progress.push([loaded, total]), status: text => statuses.push({ text, stage: r.list()[0].stage }) });
  await enteredComplete.promise;
  assert.deepEqual(progress, [[declaration().byte_size, declaration().byte_size]]);
  assert.equal(r.list()[0].stage, 'confirming'); assert.equal(r.list()[0].material, undefined);
  assert.equal(statuses.find(item => item.text === '正在准备上传文件…')?.stage, 'creating');
  assert.equal(statuses.find(item => item.text === '已准备好，开始上传文件…')?.stage, 'session');
  assert.equal(statuses.find(item => item.text === '正在上传文件…')?.stage, 'bytes_unknown');
  assert.deepEqual(statuses.at(-1), { text: '正在确认材料保存…', stage: 'confirming' });
  completeGate.resolve(material()); await pending; assert.equal(r.list()[0].stage, 'saved');
});

test('unknown PUT without progress cannot report successful 100 percent before its exact receipt', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a'); h.state.emitProgress = false;
  h.state.put = async () => { throw new ApiError(0, 'DATA_UNAVAILABLE'); }; const progress: number[] = [];
  h.state.complete = async () => { throw new ApiError(503, 'DATA_UNAVAILABLE'); };
  await assert.rejects(r.resume('op-a', { file: file(), progress: loaded => progress.push(loaded) }), ApiError);
  assert.deepEqual(progress, []); assert.equal(r.list()[0].stage, 'bytes_unknown'); assert.deepEqual(methods(h), ['create', 'put', 'complete']);
});

test('opt-in durable transfer completes normally without changing the journal schema', async () => {
  const h = harness(), r = h.make(); r.begin(declaration(), undefined, 'op-a');
  assert.deepEqual(await r.resume('op-a', { file: file(), requireDurableRecord: true }), material());
  assert.deepEqual(methods(h), ['create', 'put', 'complete']); assert.equal(r.list()[0].stage, 'saved'); assert.equal(Object.hasOwn(r.list()[0], 'requireDurableRecord'), false);
});

for (const outcome of ['success', 'api-error', 'new-slot', 'changed-record'] as const) test('opt-in durable transfer rejects removed or replaced original slot during held complete: ' + outcome, async () => {
  const h = harness(), r = h.make(), { key } = seed(h, r), gate = deferred<Dto<'MaterialResponse'>>(); h.state.complete = async () => gate.promise;
  const pending = r.resume('op-a', { requireDurableRecord: true }), raw = h.store.data.get(key)!;
  if (outcome === 'changed-record') h.store.data.set(key, JSON.stringify({ ...JSON.parse(raw), context: { request_id: 'another-intent' } }));
  else { h.store.data.delete(key); if (outcome === 'new-slot') h.store.data.set(key + '-replacement', raw); }
  if (outcome === 'api-error') gate.reject(new ApiError(503, 'DATA_UNAVAILABLE')); else gate.resolve(material());
  await assert.rejects(pending, UploadRecoveryConflictError); assert.deepEqual(methods(h), ['complete']);
  if (outcome === 'success' || outcome === 'api-error') assert.equal(h.store.length, 0); else assert.equal(r.list()[0].stage, 'confirming');
});

for (const stage of ['create', 'bytes', 'saved-material', 'file-digest', 'project-404', 'status-before-save'] as const) test('opt-in durable transfer stops subsequent work when original record disappears during ' + stage, async () => {
  const h = harness(), r = h.make(); let key: string;
  if (stage === 'saved-material') key = seed(h, r, { stage: 'saved', material: material() }).key;
  else if (stage === 'project-404') key = seed(h, r).key;
  else { r.begin(declaration(), undefined, 'op-a'); key = [...h.store.data.keys()][0]; }
  const remove = () => { h.store.data.delete(key); };
  if (stage === 'create') h.state.create = async () => { remove(); return session(); };
  if (stage === 'bytes') h.state.put = async () => { remove(); throw new ApiError(0, 'DATA_UNAVAILABLE'); };
  if (stage === 'saved-material') h.state.get = async () => { remove(); return material(); };
  if (stage === 'project-404') { h.state.complete = async () => { throw new ApiError(404, 'NOT_FOUND'); }; h.state.project = async () => { remove(); return project(); }; }
  let helper = r;
  if (stage === 'file-digest') helper = new UploadRecovery(h.api, 'owner-a', 'project-a', 'purpose-a', () => true, { store: h.store, lock: h.lock, digest: async () => { remove(); return sha; } });
  await assert.rejects(helper.resume('op-a', { file: file(), requireDurableRecord: true, status: message => { if (stage === 'status-before-save' && message === '正在准备上传文件…') remove(); } }), UploadRecoveryConflictError);
  assert.equal(h.store.length, 0);
  const expected = { create: ['create'], bytes: ['create', 'put'], 'saved-material': ['material'], 'file-digest': [], 'project-404': ['complete', 'project'], 'status-before-save': [] };
  assert.deepEqual(methods(h), expected[stage]);
});

test('opt-in durable transfer rejects checkpoint restoration while default transfer keeps its existing behavior', async () => {
  const h = harness(), r = h.make(), { record, key } = seed(h, r); h.store.data.delete(key);
  await assert.rejects(r.resume('op-a', { previousRecord: record, requireDurableRecord: true }), UploadRecoveryConflictError); assert.equal(h.store.length, 0); assert.deepEqual(methods(h), []);
  r.begin(declaration(), undefined, 'op-a'); h.state.complete = async () => { h.store.data.clear(); return material(); };
  assert.deepEqual(await r.resume('op-a', { file: file() }), material()); assert.equal(r.list()[0].stage, 'saved');
});

for(const stage of ['session','bytes_unknown','confirming'] as const)test(`direct reload ${stage} confirms before renewing the same upload, without persisting SAS`,async()=>{
 const h=harness(),r=h.make();seed(h,r,{stage,uploadTransport:'azure_blob'});let n=0;
 h.state.complete=async()=>{if(++n===1)throw new ApiError(422,'MATERIAL_UNREADABLE',{uploadBytesPending:true});return material();};
 h.api.refreshUpload=async(p,id,input)=>{h.calls.push({method:'refresh',project:p,id,input});return session({upload_transport:'azure_blob',upload_url:'https://storage.invalid/private?sig=synthetic-secret'});};
 const result=await h.make().resume('op-a',{file:file()});assert.equal(result.material_id,'material-a');
 assert.deepEqual(methods(h),['complete','refresh','put','complete']);assert.equal(r.list()[0].uploadId,'upload-a');assert.deepEqual(r.list()[0].previousUploadIds,[]);
 assert.ok(![...h.store.data.values()].join('').includes('synthetic-secret'));
});
for(const status of [403,409,412])test(`direct create-only ${status} confirms the original object without another PUT or new upload`,async()=>{
 const h=harness(),r=h.make();h.state.create=async()=>session({upload_transport:'azure_blob'});h.state.put=async()=>{throw new ApiError(status,'DATA_UNAVAILABLE');};r.begin(declaration(),undefined,'op-a');
 assert.equal((await r.resume('op-a',{file:file()})).material_id,'material-a');assert.deepEqual(methods(h),['create','put','complete']);
});
test('direct reload with accepted bytes reuses complete without ticket or file',async()=>{
 const h=harness(),r=h.make();seed(h,r,{stage:'bytes_unknown',uploadTransport:'azure_blob'});
 assert.equal((await h.make().resume('op-a')).material_id,'material-a');assert.deepEqual(methods(h),['complete']);
});
test('direct original identity is retained when the ticket endpoint is unavailable or foreign',async()=>{
 const h=harness(),r=h.make();seed(h,r,{uploadTransport:'azure_blob'});h.state.complete=async()=>{throw new ApiError(404,'NOT_FOUND');};
 await assert.rejects(h.make().resume('op-a',{file:file()}),ApiError);assert.deepEqual(methods(h),['complete']);assert.equal(r.list()[0].uploadId,'upload-a');
});

test('cancelling the default SHA waiter releases its recovery lock before an unrelated hash completes',async()=>{
 const entered=deferred<void>(),release=deferred<void>(),blocker=new Blob(['unrelated original']);
 const original=blocker.slice.bind(blocker);blocker.slice=(...args)=>{
  const part=original(...args),read=part.arrayBuffer.bind(part);part.arrayBuffer=async()=>{entered.resolve();await release.promise;return read();};return part;
 };
 const heldHash=uploadFileSha256(blocker);await entered.promise;
 const h=harness(),r=h.make(),selected=file(),controller=new AbortController();let reads=0;
 selected.slice=()=>{reads++;throw Error('cancelled waiter read original bytes');};
 r.begin(declaration(),undefined,'cancel-hash');
 const work=r.resume('cancel-hash',{file:selected,signal:controller.signal});
 try{
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(h.lock.active.size,1);
  controller.abort();let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([assert.rejects(work,{name:'AbortError'}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('cancelled SHA waiter retained the recovery lock')),2000);})]);}finally{clearTimeout(timer);}
  assert.equal(reads,0);assert.equal(h.lock.active.size,0);assert.deepEqual(methods(h),[]);
  assert.equal(r.list()[0].stage,'pending');assert.equal(r.list()[0].material,undefined);
 }finally{release.resolve();await heldHash;}
 assert.equal(await uploadFileSha256(new Blob(['abc'])),createHash('sha256').update('abc').digest('hex'));
});

test('cancelling an active default SHA stops before the next chunk or any upload write',async()=>{
 const h=harness(),r=h.make(),controller=new AbortController(),selected=new File([Buffer.alloc(2*1024*1024,120)],'cancel.docx',{type:mime});
 const raw=selected.slice.bind(selected);let reads=0;
 selected.slice=(...args)=>{reads++;const part=raw(...args),read=part.arrayBuffer.bind(part);part.arrayBuffer=async()=>{const bytes=await read();controller.abort();return bytes;};return part;};
 r.begin({...declaration(),byte_size:selected.size,sha256:createHash('sha256').update(Buffer.alloc(selected.size,120)).digest('hex')},undefined,'cancel-active');
 await assert.rejects(r.resume('cancel-active',{file:selected,signal:controller.signal}),{name:'AbortError'});
 assert.equal(reads,1);assert.equal(h.lock.active.size,0);assert.deepEqual(methods(h),[]);
 assert.equal(r.list()[0].stage,'pending');assert.equal(r.list()[0].material,undefined);
});
