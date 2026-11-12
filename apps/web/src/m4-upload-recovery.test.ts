import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { M4_DOCUMENT_TYPES, type M4Draft, type M4DraftInput, type M4DraftRequest, type M4MaterialPin, type M4Requirement, type M4Workspace } from './billing-types.js';
import { ApiError, type Dto } from './api.js';
import { M4UploadRecovery, M4UploadRecoveryError, m4UploadAdoptionInput, m4UploadContext, m4UploadInputOf, m4UploadRecordMatches, m4UploadSame, m4UploadValidInput, type M4UploadPageSnapshot } from './m4-upload-recovery.js';
import { UploadRecoveryLockError, UploadRecoveryStorageError, type UploadRecoveryStorage, type UploadRecoveryLock } from './upload-recovery.js';

const now = '2026-10-25T12:00:00Z', sha = (text: string) => createHash('sha256').update(text).digest('hex');
const pdf = 'application/pdf', cacheKey = 'bb-m4:owner:topic', otherType = M4_DOCUMENT_TYPES.find(t => t !== 'init')!;
const file = (name = '原材料.pdf', bytes = 'synthetic m4 upload') => new File([bytes], name, { type: pdf });
const decl = async (f: File, kind: 'source' | 'material' = 'material'): Promise<Dto<'UploadCreateRequest'>> => ({ filename: f.name, media_type: pdf, byte_size: f.size, sha256: sha(await f.text()), role: kind === 'source' ? 'historical' : 'other' });
const p = (name: string): M4MaterialPin => ({ source_project_id: 'actual-project', material_id: name, material_version: 1, sha256: sha(name) });
const row = (name: string): M4Requirement => ({ requirement_id: 'requirement-' + name, text: '原要求 ' + name, message_id: 'message-' + name, message_version: 1 });
const base = (): M4DraftInput => ({ document_type: 'init', source_material: p('old-source'), materials: [p('old-material')], template: null, edit_base: null, scope: 'whole', fields: { issuer: '原发行人', market: 'sse' }, requirements: [], supplemental_requirements: '原补充要求\n保持顺序' });
const serverDraft = (input: M4DraftInput, version: number): M4Draft => ({ ...structuredClone(input), version, sha256: sha(JSON.stringify(input)), updated_at: version ? now : null });
const pageOf = (d: M4Draft): M4UploadPageSnapshot => ({ version: d.version, input: m4UploadInputOf(d), dirty: false, conflict: false });
class Store implements UploadRecoveryStorage {
  data = new Map<string, string>(); beforeSet?: (key: string, value: string) => void; beforeRemove?: (key: string) => void;
  get length() { return this.data.size; } key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; } setItem(key: string, value: string) { this.beforeSet?.(key, value); this.data.set(key, value); } removeItem(key: string) { this.beforeRemove?.(key); this.data.delete(key); }
}
function harness(input = base(), version = 7) {
  const store = new Store(), calls: { method: string; project?: string; id?: string; body?: unknown }[] = [], declarations = new Map<string, Dto<'UploadCreateRequest'>>(), materials = new Map<string, Dto<'MaterialResponse'>>();
  const held = new Set<string>(); let nonce = 0;
  const lock: UploadRecoveryLock = { async run(name, action) { if (held.has(name)) throw new UploadRecoveryLockError(); held.add(name); try { return await action(); } finally { held.delete(name); } } };
  const state = { live: true, page: pageOf(serverDraft(input, version)), server: serverDraft(input, version), pending: [] as M4Requirement[], rows: [...input.requirements], membership: [] as M4MaterialPin[],
    failDraftBefore: false, failDraftAfter: false, failMembershipBefore: false, failMembershipAfter: false, dropBytes: false, keepPending: false,
    beforeComplete: async () => {}, beforeWorkspace: async () => {}, beforeDraft: async () => {}, afterDraft: async () => {}, completeChange: {} as Partial<Dto<'MaterialResponse'>>, workspaceChange: {} as Partial<M4Workspace> };
  const api: ConstructorParameters<typeof M4UploadRecovery>[0] = {
    createUpload: async (project, body) => { const id = 'upload-' + declarations.size; declarations.set(id, structuredClone(body)); calls.push({ method: 'create', project, id, body }); return { upload_id: id, state: 'uploading', upload_url: '/bytes/' + id, expires_at: '2099-01-01T00:00:00Z', max_bytes: 104857600 }; },
    uploadBytes: async () => { calls.push({ method: 'bytes' }); if (state.dropBytes) { state.dropBytes = false; throw new ApiError(0, 'DATA_UNAVAILABLE'); } },
    completeUpload: async (project, id) => { calls.push({ method: 'complete', project, id }); await state.beforeComplete(); const d = declarations.get(id)!; const m: Dto<'MaterialResponse'> = { ...d, material_id: 'material-' + id, material_version: 1, upload_id: id, state: 'persisted', persisted_at: now, error: null, ...state.completeChange }; materials.set(m.material_id, m); return structuredClone(m); },
    material: async (project, id, _s, v) => { calls.push({ method: 'material', project, id, body: v }); const m = materials.get(id); if (!m) throw new ApiError(404, 'NOT_FOUND'); return structuredClone(m); },
    project: async () => { throw new Error('unexpected project discovery'); },
  };
  const business: ConstructorParameters<typeof M4UploadRecovery>[1] = {
    workspace: async id => { calls.push({ method: 'workspace', id }); await state.beforeWorkspace(); const drafts = Object.fromEntries(M4_DOCUMENT_TYPES.map(t => [t, t === 'init' ? structuredClone(state.server) : serverDraft({ ...base(), document_type: t }, 0)]));
      return { topic: { topic_id: 'topic', project_id: 'actual-project', source_project_id: 'navigation-project', surface: 'materials' }, project: { project_id: 'actual-project' }, drafts,
        materials: structuredClone(state.membership), pending_requirements: structuredClone(state.pending), messages: [...state.rows, ...state.pending].map(r => ({ message_id: r.message_id, version: r.message_version, role: 'assistant', reply: { requirements: [r.text] } })),
        templates: input.template ? [{ ...input.template, document_type: 'init', status: 'active' }] : [], artifacts: input.edit_base ? [{ ...input.edit_base, kind: 'document', document_type: 'init' }] : [], ...state.workspaceChange } as unknown as M4Workspace;
    },
    material: async (id, pin) => { calls.push({ method: 'membership', id, body: structuredClone(pin) }); if (state.failMembershipBefore) throw new ApiError(0, 'DATA_UNAVAILABLE'); if (!state.membership.some(m => m4UploadSame(m, pin))) state.membership.push(structuredClone(pin)); if (state.failMembershipAfter) throw new ApiError(0, 'DATA_UNAVAILABLE'); },
    draft: async (id, body) => { calls.push({ method: 'draft', id, body: structuredClone(body) }); await state.beforeDraft(); if (state.failDraftBefore) throw new ApiError(0, 'DATA_UNAVAILABLE'); if (state.server.version !== body.expected_version) throw new ApiError(409, 'INPUT_REVISION_CONFLICT'); const merged = structuredClone(body.input); for (const r of state.pending) if (!merged.requirements.some(old => old.requirement_id === r.requirement_id)) merged.requirements.push(structuredClone(r));
      const noOp = state.server.version > 0 && m4UploadSame(m4UploadInputOf(state.server), merged); state.server = serverDraft(merged, noOp ? state.server.version : state.server.version + 1); if (!state.keepPending) state.pending = []; await state.afterDraft(); if (state.failDraftAfter) throw new ApiError(0, 'DATA_UNAVAILABLE'); },
  };
  const make = (change: Partial<ConstructorParameters<typeof M4UploadRecovery>[5]> = {}) => new M4UploadRecovery(api, business, 'owner', 'actual-project', 'topic', { current: () => state.live, snapshot: () => structuredClone(state.page), store, lock, id: () => 'id-' + ++nonce, digest: async f => sha(await f.text()), ...change });
  const helper = make(), wrapper = () => ({ owner: 'owner', topic: 'topic', drafts: { init: structuredClone(state.page), [otherType]: { ...structuredClone(state.page), input: { ...structuredClone(state.page.input), document_type: otherType } } }, viewVersion: 4, viewDirty: false });
  store.setItem(cacheKey, JSON.stringify(wrapper()));
  const envelopeKey = () => [...store.data.keys()].find(k => k.startsWith('bb-m4-upload-v1:'))!, coreKeys = () => [...store.data.keys()].filter(k => k.startsWith('bondbuddy:upload-recovery:v1:'));
  const prepare = async (files = [file()], kind: 'source' | 'material' = 'material') => helper.prepare(await Promise.all(files.map(f => decl(f, kind))), kind, 'init');
  const apply = (d: M4Draft) => { state.page = pageOf(d); };
  return { helper, make, state, store, calls, materials, wrapper, envelopeKey, coreKeys, prepare, apply };
}
const writes = (h: ReturnType<typeof harness>, method = 'draft') => h.calls.filter(c => c.method === method);
async function unknownDraft(h = harness()) { const e = await h.prepare(); h.state.failDraftBefore = true; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'retryable'); return { h, e }; }

test('prepare fixes actual topic project, full original document, order and small core references without network writes', async () => {
  const h = harness(), e = await h.prepare([file(), file('second.pdf', 'second')]); assert.deepEqual(h.calls.map(c => c.method), ['workspace']); assert.equal(e.projectId, 'actual-project'); assert.equal(e.topicId, 'topic'); assert.deepEqual(e.basePage.input, base()); assert.equal(e.items[1].index, 1);
  for (const i of e.items) { const r = h.helper.transportRecords().find(r => r.id === i.id)!; assert.equal(m4UploadRecordMatches(e, i.index, r), true); assert.deepEqual(r.context, m4UploadContext(e, i.index)); assert.ok(JSON.stringify(r.context).length < 350); }
});
for (const kind of ['source', 'material'] as const) test(kind + ' preserves full unrelated input and changes only its selected pin field', async () => {
  const input = base(), h = harness(input), e = await h.prepare([file()], kind), r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.equal(r.applyToPage, true); const expected = structuredClone(input), pin = writes(h, 'membership')[0].body as M4MaterialPin;
  if (kind === 'source') expected.source_material = pin; else expected.materials.push(pin); assert.deepEqual(m4UploadInputOf(r.draft!), expected); assert.equal(writes(h)[0].id, 'topic'); assert.equal(writes(h, 'create')[0].project, 'actual-project');
});
test('complete project_file, template, artifact, field and structured requirement survive material adoption', async () => {
  const input = base(); input.project_file = { project_id: 'file-project', source_version_id: 'source-version', source_selection_revision: 4, expected_file_version_id: null }; input.template = { template_id: 'template', template_version: 3, sha256: sha('template') }; input.edit_base = { source_project_id: 'artifact-project', artifact_id: 'artifact', artifact_version: 2, sha256: sha('artifact') }; input.requirements = [row('a'), row('b')];
  const h = harness(input), e = await h.prepare(), r = await h.helper.resume(e.id, 0, { file: file() }); const expected = structuredClone(input); expected.materials = r.draft!.materials; assert.deepEqual(m4UploadInputOf(r.draft!), expected);
});
test('source with unverifiable project_file relation retains original constraint and saved file without PUT', async () => {
  const input = base(); input.project_file = { project_id: 'file-project', source_version_id: 'version', source_selection_revision: 0 }; const h = harness(input), e = await h.prepare([file()], 'source'); await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), /来源约束/); assert.equal(h.helper.list()[0].items[0].stage, 'library_registered'); assert.equal(writes(h).length, 0); assert.deepEqual(h.state.server.project_file, input.project_file);
});
test('ordered batch uses only previous confirmed complete input and version', async () => {
  const h = harness(), files = [file(), file('second.pdf', 'second')], e = await h.prepare(files), before = h.calls.length; await assert.rejects(h.helper.resume(e.id, 1, { file: files[1] })); assert.equal(h.calls.length, before);
  const one = await h.helper.resume(e.id, 0, { file: files[0] }); assert.equal(one.state, 'content_confirmed'); h.apply(one.draft!); const two = await h.helper.resume(e.id, 1, { file: files[1] }); assert.equal(two.state, 'complete'); assert.equal(two.draft!.materials.length, 3); assert.equal((writes(h)[1].body as M4DraftRequest).expected_version, 8);
});
test('lost byte reply automatically confirms the original upload without another create or bytes', async () => {
  const h = harness(), e = await h.prepare(); h.state.dropBytes = true; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.equal(writes(h, 'complete').length, 1); assert.equal(writes(h, 'create').length, 1); assert.equal(writes(h, 'bytes').length, 1);
});
test('lost membership receipt confirms exact four-part pin with GET and does not POST again', async () => {
  const h = harness(), e = await h.prepare(); h.state.failMembershipAfter = true; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.equal(writes(h, 'membership').length, 1);
});
test('unobserved membership keeps unknown and read-only refresh never repeats POST', async () => {
  const h = harness(), e = await h.prepare(); h.state.failMembershipBefore = true; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'pending'); assert.equal(r.envelope.items[0].stage, 'library_registration_unknown'); const before = h.calls.length; await h.make().reconcile(e.id, 0); assert.deepEqual(h.calls.slice(before).map(c => c.method), ['workspace']); assert.equal(writes(h).length, 0);
});
test('explicit membership retry after exact absent GET resends only the original pin', async () => {
  const h = harness(), e = await h.prepare(); h.state.failMembershipBefore = true; await h.helper.resume(e.id, 0, { file: file() }); const original = writes(h, 'membership')[0].body; h.state.failMembershipBefore = false;
  const withoutPermission = await h.make().resume(e.id, 0); assert.equal(withoutPermission.state, 'pending'); assert.equal(writes(h, 'membership').length, 1);
  const result = await h.make().resume(e.id, 0, { retryMembership: true }); assert.equal(result.state, 'complete'); assert.deepEqual(writes(h, 'membership').map(c => c.body), [original, original]); assert.equal(writes(h, 'create').length, 1); assert.equal(writes(h, 'bytes').length, 1);
});
for (const mutation of ['unavailable', 'page', 'cache', 'record'] as const) test('explicit membership retry refuses changed ' + mutation + ' before repeating POST', async () => {
  const h = harness(), e = await h.prepare(); h.state.failMembershipBefore = true; await h.helper.resume(e.id, 0, { file: file() }); h.state.failMembershipBefore = false;
  if (mutation === 'unavailable') h.state.beforeWorkspace = async () => { throw new ApiError(404, 'NOT_FOUND'); };
  if (mutation === 'page') h.state.page.input.fields.new = 'new';
  if (mutation === 'cache') { const c = JSON.parse(h.store.getItem(cacheKey)!); c.drafts.init.input.fields.new = 'new'; h.store.setItem(cacheKey, JSON.stringify(c)); }
  if (mutation === 'record') h.state.beforeWorkspace = async () => { const key = h.envelopeKey(), value = JSON.parse(h.store.getItem(key)!); value.recordRevision++; h.store.setItem(key, JSON.stringify(value)); };
  await assert.rejects(h.make().resume(e.id, 0, { retryMembership: true })); assert.equal(writes(h, 'membership').length, 1); assert.equal(writes(h).length, 0);
});
test('existing exact membership avoids POST and near-match SHA does not count as exact membership', async () => {
  const h = harness(), e = await h.prepare(); h.state.membership = [{ source_project_id: 'actual-project', material_id: 'material-upload-0', material_version: 1, sha256: sha('synthetic m4 upload') }]; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.equal(writes(h, 'membership').length, 0);
  const h2 = harness(), e2 = await h2.prepare(); h2.state.membership = [{ ...h.state.membership[0], sha256: sha('foreign') }]; await h2.helper.resume(e2.id, 0, { file: file() }); assert.equal(writes(h2, 'membership').length, 1);
});
test('lost draft reply after acceptance converges by exact v+1 complete input', async () => { const h = harness(), e = await h.prepare(); h.state.failDraftAfter = true; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.equal(r.draft!.version, 8); assert.equal(writes(h).length, 1); });
test('matching draft without its exact topic membership cannot complete business adoption', async () => { const h = harness(), e = await h.prepare(); h.state.afterDraft = async () => { h.state.membership = []; }; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'conflict'); assert.equal(r.applyToPage, false); assert.equal(h.helper.list()[0].items[0].stage, 'draft_unknown'); });
test('sealed pending rows merge by requirement ID in original order and do not duplicate existing rows', async () => {
  const input = base(); input.requirements = [row('existing')]; const h = harness(input); h.state.pending = [row('existing'), row('first'), row('second')]; const e = await h.prepare(), r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.deepEqual(r.draft!.requirements, [row('existing'), row('first'), row('second')]); assert.deepEqual((writes(h)[0].body as M4DraftRequest).input.requirements, [row('existing')]);
});
for (const version of [0, 7]) test('no-op content at base version ' + version + ' follows M4 creation/no-op version rules', async () => {
  const input = base(); input.materials.push({ source_project_id: 'actual-project', material_id: 'material-upload-0', material_version: 1, sha256: sha('synthetic m4 upload') }); const h = harness(input, version), e = await h.prepare(), r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.equal(r.draft!.version, version === 0 ? 1 : 7); assert.equal(writes(h).length, 1);
});
test('no-op same content with still-visible pending remains independently pending_unknown', async () => {
  const input = base(); input.requirements = [row('a')]; input.materials.push({ source_project_id: 'actual-project', material_id: 'material-upload-0', material_version: 1, sha256: sha('synthetic m4 upload') }); const h = harness(input); h.state.pending = [row('a')]; h.state.keepPending = true; const e = await h.prepare(), r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'pending_unknown'); assert.equal(r.draft!.version, 7); assert.equal(r.applyToPage, false); assert.equal(r.envelope.items[0].stage, 'content_satisfied_pending_unknown'); const before = h.calls.length; const again = await h.make().reconcile(e.id, 0); assert.equal(again.state, 'pending_unknown'); assert.deepEqual(h.calls.slice(before).map(c => c.method), ['workspace']); assert.equal(writes(h).length, 1);
});
test('changed content with contradictory pending observation retains content proof and blocks next item', async () => {
  const h = harness(); h.state.pending = [row('a')]; h.state.keepPending = true; const e = await h.prepare([file(), file('later.pdf', 'later')]), r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'pending_unknown'); assert.equal(r.draft!.version, 8); const before = h.calls.length; await assert.rejects(h.helper.resume(e.id, 1)); assert.equal(h.calls.length, before);
  h.state.pending = []; const confirmed = await h.make().reconcile(e.id, 0); assert.equal(confirmed.state, 'content_confirmed'); assert.equal(confirmed.applyToPage, true); assert.equal(writes(h).length, 1);
});
test('new pending arriving after sealing can produce extra server requirement and is never removed to fit E', async () => {
  const h = harness(), e = await h.prepare(); h.state.beforeDraft = async () => { h.state.pending.push(row('late')); }; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'conflict'); assert.deepEqual(h.state.server.requirements, [row('late')]); assert.equal(writes(h).length, 1);
});
test('v/B read-only check preserves sealed CAS, explicit retry replays same body without upload', async () => {
  const { h, e } = await unknownDraft(), sealed = h.helper.list()[0].items[0].draftRequest; const before = h.calls.length; assert.equal((await h.make().reconcile(e.id, 0)).state, 'retryable'); assert.deepEqual(h.calls.slice(before).map(c => c.method), ['workspace']); h.state.failDraftBefore = false; const r = await h.make().resume(e.id, 0, { retryDraft: true }); assert.equal(r.state, 'complete'); assert.deepEqual(writes(h).map(c => c.body), [sealed, sealed]); assert.equal(writes(h, 'bytes').length, 1);
});
test('retry refuses changed topic pending rather than rebasing original sealed request', async () => { const { h, e } = await unknownDraft(); h.state.pending = [row('new')]; h.state.failDraftBefore = false; await assert.rejects(h.make().resume(e.id, 0, { retryDraft: true }), /待采用要求/); assert.equal(writes(h).length, 1); });
for (const variant of ['higher-same', 'next-extra', 'same-extra', 'rollback'] as const) test('conservative reconciliation rejects ' + variant + ' without rebase or PUT', async () => {
  const { h, e } = await unknownDraft(), item = h.helper.list()[0].items[0]; if (variant === 'higher-same') h.state.server = serverDraft(item.expectedInput!, 9); if (variant === 'next-extra') h.state.server = serverDraft({ ...item.expectedInput!, fields: { newer: '保留' } }, 8); if (variant === 'same-extra') h.state.server = serverDraft({ ...base(), fields: { newer: '保留' } }, 7); if (variant === 'rollback') h.state.server = serverDraft(base(), 6);
  const before = h.calls.length, r = await h.make().resume(e.id, 0, { retryDraft: true }); assert.equal(r.state, 'conflict'); assert.equal(r.applyToPage, false); assert.deepEqual(h.calls.slice(before).map(c => c.method), ['workspace']); assert.equal(writes(h).length, 1);
});
for (const code of [401, 403, 404, 503]) test('unavailable GET ' + code + ' preserves unknown instead of inferring no commit', async () => {
  const h = harness(), e = await h.prepare(); h.state.afterDraft = async () => { h.state.beforeWorkspace = async () => { throw new ApiError(code, 'DATA_UNAVAILABLE'); }; }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.helper.list()[0].items[0].stage, 'draft_unknown'); assert.equal(writes(h).length, 1);
});
test('cache target patch preserves latest other draft and reading state', async () => {
  const h = harness(), e = await h.prepare(); h.state.afterDraft = async () => { const c = JSON.parse(h.store.getItem(cacheKey)!); c.drafts[otherType].input.fields = { other: 'new other draft' }; c.drafts[otherType].dirty = true; c.viewVersion = 18; c.viewDirty = true; h.store.setItem(cacheKey, JSON.stringify(c)); };
  const r = await h.helper.resume(e.id, 0, { file: file() }), c = JSON.parse(h.store.getItem(cacheKey)!); assert.equal(r.applyToPage, true); assert.equal(c.drafts.init.version, 8); assert.equal(c.drafts[otherType].input.fields.other, 'new other draft'); assert.equal(c.viewVersion, 18);
});
function pendingRequest(kind: 'pendingMessage' | 'pendingExecution') { return kind === 'pendingExecution' ? { execution_request_id: 'other-task', document_type: otherType, expected_draft_version: 1, quote_id: 'quote', entrypoint: 'workspace' } : { request: { submission_request_id: 'other-message', content: '待确认消息', context: { document_type: null, draft_version: 0, source_material: null, citations: [], reading_artifact: null } }, viewContent: '待确认消息' }; }
for (const kind of ['pendingMessage', 'pendingExecution'] as const) test(kind + ' already present refuses prepare before any network write', async () => { const h = harness(), c = JSON.parse(h.store.getItem(cacheKey)!); c[kind] = pendingRequest(kind); h.store.setItem(cacheKey, JSON.stringify(c)); await assert.rejects(h.prepare(), /本机草稿或请求/); assert.equal(writes(h, 'create').length, 0); assert.equal(writes(h).length, 0); });
for (const kind of ['pendingMessage', 'pendingExecution'] as const) test(kind + ' appearing in durable draft_unknown gap blocks draft network write', async () => {
  const h = harness(), e = await h.prepare(); h.store.beforeSet = (key, raw) => { if (key.startsWith('bb-m4-upload-v1:') && JSON.parse(raw).items[0].stage === 'draft_unknown') { const c = JSON.parse(h.store.getItem(cacheKey)!); c[kind] = pendingRequest(kind); h.store.data.set(cacheKey, JSON.stringify(c)); } }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), /待确认请求/); assert.equal(writes(h).length, 0); assert.equal(h.helper.list()[0].items[0].stage, 'draft_unknown');
});
for (const kind of ['pendingMessage', 'pendingExecution'] as const) test(kind + ' added during accepted PUT preserves server proof, new pending and old cache; no page apply/next item', async () => {
  const h = harness(), e = await h.prepare([file(), file('later.pdf', 'later')]); h.state.afterDraft = async () => { const c = JSON.parse(h.store.getItem(cacheKey)!); c[kind] = pendingRequest(kind); h.store.setItem(cacheKey, JSON.stringify(c)); }; const r = await h.helper.resume(e.id, 0, { file: file() }), c = JSON.parse(h.store.getItem(cacheKey)!); assert.equal(r.state, 'content_confirmed'); assert.equal(r.draft!.version, 8); assert.equal(r.applyToPage, false); assert.equal(r.envelope.items[0].localCacheResult, 'preserved'); assert.deepEqual(c[kind], pendingRequest(kind)); assert.equal(c.drafts.init.version, 7); assert.equal(h.state.page.version, 7); const before = h.calls.length; await assert.rejects(h.helper.resume(e.id, 1)); assert.equal(h.calls.length, before);
});
test('sealed pending consumed by another document prevents replay that could omit original merged requirements', async () => { const h = harness(); h.state.pending = [row('sealed')]; const { e } = await unknownDraft(h); h.state.pending = []; h.state.failDraftBefore = false; await assert.rejects(h.helper.resume(e.id, 0, { retryDraft: true }), /待采用要求/); assert.equal(writes(h).length, 1); assert.deepEqual(h.helper.list()[0].items[0].pending, [row('sealed')]); });
for (const change of ['page', 'target'] as const) test('new original ' + change + ' edit preserves local changes and refuses false apply/next prefix', async () => {
  const h = harness(), e = await h.prepare([file(), file('later.pdf', 'later')]); h.state.afterDraft = async () => { if (change === 'page') { h.state.page.input.fields.local = 'new'; h.state.page.dirty = true; } else { const c = JSON.parse(h.store.getItem(cacheKey)!); c.drafts.init.input.fields.local = 'new'; c.drafts.init.dirty = true; h.store.setItem(cacheKey, JSON.stringify(c)); } };
  const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'content_confirmed'); assert.equal(r.applyToPage, false); assert.equal(r.envelope.items[0].localCacheResult, 'preserved'); const before = h.calls.length; await assert.rejects(h.helper.resume(e.id, 1)); assert.equal(h.calls.length, before);
});
test('stale reading-only cache write during helper-patch/page-apply gap cannot restore old target', async () => {
  const h = harness(), previous = h.store.getItem(cacheKey), e = await h.prepare(), r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.applyToPage, true); const next = JSON.parse(previous!); next.viewVersion = 9; const merge = await h.helper.mergeCache(previous, JSON.stringify(next)), c = JSON.parse(merge.raw); assert.equal(c.drafts.init.version, 8); assert.equal(c.viewVersion, 9); assert.ok(merge.rejected.includes('draft:init')); assert.ok(merge.accepted.includes('viewVersion'));
});
test('cache merge accepts partial baseline and preserves foreign concurrent edits per field', async () => {
  const h = harness(), before = h.store.getItem(cacheKey), next = JSON.parse(before!); next.drafts.init.input.fields.local = 'new'; next.viewVersion = 5; const current = JSON.parse(before!); current.drafts.init.input.fields.foreign = 'keep'; h.store.setItem(cacheKey, JSON.stringify(current)); const r = await h.helper.mergeCache(before, JSON.stringify(next)), c = JSON.parse(r.raw); assert.equal(c.drafts.init.input.fields.foreign, 'keep'); assert.equal(c.drafts.init.input.fields.local, undefined); assert.equal(c.viewVersion, 5);
  const partial = JSON.stringify({ owner: 'owner', topic: 'topic', drafts: {} }); await h.helper.mergeCache(partial, partial);
});
test('cache missing at preparation is patched with confirmed target while latest unrelated fields remain', async () => { const h = harness(); h.store.removeItem(cacheKey); const e = await h.prepare(); h.state.afterDraft = async () => { h.store.setItem(cacheKey, JSON.stringify({ owner: 'owner', topic: 'topic', drafts: {}, viewVersion: 88 })); }; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.applyToPage, true); assert.equal(JSON.parse(h.store.getItem(cacheKey)!).viewVersion, 88); });
test('cache patch persisted but journal receipt lost is idempotent cleanup without network', async () => {
  const h = harness(), e = await h.prepare(); let once = false; h.store.beforeSet = (key, raw) => { if (!once && key.startsWith('bb-m4-upload-v1:') && JSON.parse(raw).items[0].localCacheResult === 'patched') { once = true; throw new Error('quota'); } }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), UploadRecoveryStorageError); assert.equal(JSON.parse(h.store.getItem(cacheKey)!).drafts.init.version, 8); h.store.beforeSet = undefined; const before = h.calls.length, r = await h.make().resume(e.id, 0); assert.equal(r.state, 'complete'); assert.equal(h.calls.length, before);
});
test('cleanup failure after confirmed content retries local cleanup only', async () => {
  const h = harness(), e = await h.prepare(); h.store.beforeRemove = key => { if (key.startsWith('bondbuddy:upload-recovery:v1:')) throw new Error('quota'); }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), UploadRecoveryStorageError); assert.equal(h.helper.list()[0].items[0].stage, 'cleanup_pending'); h.store.beforeRemove = undefined; const before = h.calls.length; assert.equal((await h.make().resume(e.id, 0)).state, 'complete'); assert.equal(h.calls.length, before);
});
for (const change of ['target', 'pendingMessage', 'pendingExecution', 'page'] as const) test('late ' + change + ' during transport cleanup prevents false apply and next-item continuation', async () => {
  const h = harness(), e = await h.prepare([file(), file('later.pdf', 'later')]); h.store.beforeRemove = key => { if (key.startsWith('bondbuddy:upload-recovery:v1:')) { const c = JSON.parse(h.store.getItem(cacheKey)!); if (change === 'target') { c.drafts.init.input.fields.late = 'new'; c.drafts.init.dirty = true; } else if (change === 'page') { h.state.page.input.fields.late = 'new'; h.state.page.dirty = true; } else c[change] = pendingRequest(change); h.store.data.set(cacheKey, JSON.stringify(c)); } };
  const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'content_confirmed'); assert.equal(r.applyToPage, false); assert.equal(r.envelope.items[0].localCacheResult, 'preserved'); const before = h.calls.length; await assert.rejects(h.helper.resume(e.id, 1)); assert.equal(h.calls.length, before); assert.equal(writes(h).length, 1);
});
test('unknown marker must persist before membership and draft network writes', async () => {
  for (const stage of ['library_registration_unknown', 'draft_unknown']) { const h = harness(), e = await h.prepare(); h.store.beforeSet = (key, raw) => { if (key.startsWith('bb-m4-upload-v1:') && JSON.parse(raw).items[0].stage === stage) throw new Error('quota'); }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), UploadRecoveryStorageError); assert.equal(writes(h, stage === 'draft_unknown' ? 'draft' : 'membership').length, 0); }
});
test('complete business envelope can exceed core size while core reference stays small', async () => { const input = base(); input.requirements = Array.from({ length: 25 }, (_, i) => ({ ...row(String(i)), text: '原'.repeat(11900) + i })); const h = harness(input), e = await h.prepare(); assert.ok(JSON.stringify(e.basePage.input).length > 256000); assert.ok(JSON.stringify(h.helper.transportRecords()[0]).length < 3000); });
test('material uniqueness follows material ID and version, including cross-project duplicates', () => { const input = base(); input.materials.push({ ...input.materials[0], source_project_id: 'foreign' }); assert.equal(m4UploadValidInput(input), false); input.materials[1].material_version = 2; assert.equal(m4UploadValidInput(input), true); });
for (const limit of ['materials', 'requirements'] as const) test(limit + ' overflow retains full original and saved file without draft PUT', async () => {
  const input = base(); if (limit === 'materials') input.materials = Array.from({ length: 60 }, (_, i) => p('old-' + i)); else input.requirements = Array.from({ length: 100 }, (_, i) => row(String(i))); const h = harness(input); if (limit === 'requirements') h.state.pending = [row('overflow')]; const e = await h.prepare(); await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(writes(h).length, 0); assert.equal(h.helper.transportRecords()[0].stage, 'saved'); assert.deepEqual(m4UploadInputOf(h.state.server), input);
});
for (const mutation of ['page', 'cache', 'server'] as const) test('changed original ' + mutation + ' during complete blocks subsequent membership/draft writes', async () => {
  const h = harness(), e = await h.prepare(); h.state.beforeComplete = async () => { if (mutation === 'page') h.state.page.input.fields.new = 'new'; else if (mutation === 'cache') { const c = JSON.parse(h.store.getItem(cacheKey)!); c.drafts.init.input.fields.new = 'new'; h.store.setItem(cacheKey, JSON.stringify(c)); } else h.state.server = serverDraft({ ...base(), fields: { new: 'new' } }, 8); }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(writes(h).length, 0); assert.equal(writes(h, 'membership').length, 0); assert.equal(h.helper.list()[0].items[0].stage, 'material_saved');
});
for (const mutation of ['topic', 'project', 'pending', 'draft']) test('strict workspace validation rejects malformed ' + mutation, async () => {
  const h = harness(), e = await h.prepare(); if (mutation === 'topic') h.state.workspaceChange.topic = { topic_id: 'foreign', project_id: 'actual-project' } as M4Workspace['topic']; if (mutation === 'project') h.state.workspaceChange.project = { project_id: 'navigation-project' } as M4Workspace['project']; if (mutation === 'pending') h.state.workspaceChange.pending_requirements = [{ ...row('x'), message_version: 1.5 }]; if (mutation === 'draft') h.state.server = { ...h.state.server, injected: true } as M4Draft; await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(writes(h).length, 0);
});
test('original core/envelope missing never re-begins from stale File; orphan removal is local only', async () => {
  const h = harness(), e = await h.prepare(), before = h.calls.length; for (const k of h.coreKeys()) h.store.removeItem(k); await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.calls.length, before); h.store.removeItem(h.envelopeKey()); await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.calls.length, before);
  const h2 = harness(), e2 = await h2.prepare(); h2.store.removeItem(h2.envelopeKey()); const count = h2.calls.length; await h2.helper.removeOrphan(e2.items[0].id); assert.equal(h2.calls.length, count); assert.equal(h2.helper.transportRecords().length, 0);
});
test('storage/lock failure stops preparation before create and malformed cached scopes fail closed', async () => {
  const h = harness(); h.store.beforeSet = () => { throw new Error('quota'); }; await assert.rejects(h.prepare(), UploadRecoveryStorageError); assert.equal(writes(h, 'create').length, 0); h.store.beforeSet = undefined; await assert.rejects(h.make({ lock: { run: async () => { throw new UploadRecoveryLockError(); } } }).prepare([await decl(file())], 'material', 'init'), UploadRecoveryLockError); h.store.setItem(cacheKey, JSON.stringify({ owner: 'foreign', topic: 'topic', drafts: {} })); await assert.rejects(h.prepare());
});
test('record changed during GET refuses complete-record CAS before next business write', async () => { const h = harness(), e = await h.prepare(); let once = false; h.state.beforeWorkspace = async () => { if (!once) { once = true; const key = h.envelopeKey(), e = JSON.parse(h.store.getItem(key)!); e.recordRevision++; h.store.setItem(key, JSON.stringify(e)); } }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), /另一页面/); assert.equal(writes(h, 'membership').length, 0); assert.equal(writes(h).length, 0); });
for (const point of ['complete', 'workspace', 'draft']) test('late owner or route change after ' + point + ' aborts adoption and cleanup', async () => {
  const h = harness(), e = await h.prepare(); if (point === 'complete') h.state.beforeComplete = async () => { h.state.live = false; }; if (point === 'workspace') h.state.beforeWorkspace = async () => { h.state.live = false; }; if (point === 'draft') h.state.afterDraft = async () => { h.state.live = false; }; await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), { name: 'AbortError' }); if (point !== 'draft') assert.equal(writes(h).length, 0); assert.equal(JSON.parse(h.store.getItem(cacheKey)!).drafts.init.version, 7);
});
test('stop preserves server file/draft and removes only local original records', async () => { const { h, e } = await unknownDraft(), before = h.calls.length; await h.helper.stop(e.id); assert.equal(h.calls.length, before); assert.equal(h.materials.size, 1); assert.deepEqual(h.helper.list(), []); assert.deepEqual(h.helper.transportRecords(), []); });
for (const tamper of ['extra-field', 'request-body', 'request-digest', 'digest', 'index', 'scope', 'stage-prefix'] as const) test('strict durable parsing rejects ' + tamper + ' without network', async () => {
  const { h, e } = await unknownDraft(), key = h.envelopeKey(), v = JSON.parse(h.store.getItem(key)!); if (tamper === 'extra-field') v.upload_url = '/private'; if (tamper === 'request-body') v.items[0].draftRequest.input.fields.hijack = 'new'; if (tamper === 'request-digest') v.items[0].requestDigest = 'a'.repeat(64); if (tamper === 'digest') v.digest = 'a'.repeat(64); if (tamper === 'index') v.items[0].index = 2; if (tamper === 'scope') v.projectId = 'navigation-project'; if (tamper === 'stage-prefix') { v.items[0].stage = 'complete'; v.items[0].coreCleaned = true; } h.store.setItem(key, JSON.stringify(v)); const before = h.calls.length; assert.throws(() => h.helper.list()); await assert.rejects(h.helper.resume(e.id, 0)); assert.equal(h.calls.length, before);
});
