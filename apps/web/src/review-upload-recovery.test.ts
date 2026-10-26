import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { isReviewReport, type ReviewContext, type ReviewDraft, type ReviewDraftInput, type ReviewMaterialPin, type ReviewReport, type ReviewWorkspace } from '@bondbuddy/contracts';
import { ApiError, type Dto } from './api.js';
import { ReviewUploadRecovery, ReviewUploadRecoveryError, reviewUploadAdoptionInput, reviewUploadContext, reviewUploadRecordMatches, reviewUploadSame, reviewUploadValidInput } from './review-upload-recovery.js';
import { UploadRecoveryConflictError, UploadRecoveryLockError, UploadRecoveryNeedsFileError, UploadRecoveryStorageError, type UploadRecoveryLock, type UploadRecoveryStorage } from './upload-recovery.js';

const now = '2026-10-25T12:00:00Z', sha = (text: string) => createHash('sha256').update(text).digest('hex');
const pdf = 'application/pdf', docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const file = (name = '原复核材料.pdf', bytes = 'synthetic review material bytes') => new File([bytes], name, { type: name.endsWith('.docx') ? docx : pdf });
const base = (): ReviewDraftInput => ({ source_material_ref: null, material_versions: [], requirements: ['原完整要求', '保留第二行'], as_of: '2026-09-30' });
const materialPin = (m: Dto<'MaterialResponse'>): ReviewMaterialPin => ({ material_id: m.material_id, material_version: m.material_version, sha256: m.sha256 });
const report = (): ReviewReport => ({ report_id: 'report-original', project_id: 'project', run_id: 'run-original', input_revision: 4, version: 2,
  source_material: { material_id: 'old-source', material_version: 2, sha256: sha('source') }, scope: { mode: 'full_review', finding_ids: [] }, findings: [{
    finding_id: 'finding-original', report_id: 'report-original', dimension: 'financial', conclusion: 'needs_evidence', severity: 'P2', title: '原补证事项', description: '原报告待核对说明', target_refs: [], evidence_refs: [], limitations: [],
    repairability: { can_revise: false, reason: '需要原始材料', allowed_record_ids: [] }, origin_report_id: 'report-original', check_status: 'rechecked',
  }], coverage: [], limitations: [], created_at: now });
const target = (): ReviewContext => ({ project_id: 'project', report_id: 'report-original', finding_ids: ['finding-original'], material_refs: [] });
class Store implements UploadRecoveryStorage {
  data = new Map<string, string>(); beforeSet?: (key: string, value: string) => void; beforeRemove?: (key: string) => void;
  get length() { return this.data.size; } key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.beforeSet?.(key, value); this.data.set(key, value); }
  removeItem(key: string) { this.beforeRemove?.(key); this.data.delete(key); }
}
function harness(input = base()) {
  const store = new Store(), calls: { method: string; project?: string; id?: string; body?: unknown }[] = [], declarations = new Map<string, Dto<'UploadCreateRequest'>>(), materials = new Map<string, Dto<'MaterialResponse'>>();
  const held = new Set<string>(); let nonce = 0;
  const lock: UploadRecoveryLock = { async run(name, action) { if (held.has(name)) throw new UploadRecoveryLockError(); held.add(name); try { return await action(); } finally { held.delete(name); } } };
  const state = { live: true, page: { version: 7, input: structuredClone(input) }, server: { ...structuredClone(input), version: 7 } as ReviewDraft,
    selected: report() as ReviewReport | null, dropPut: false, failDraftBefore: false, failDraftAfter: false, draftWrites: 0,
    beforeRead: async () => {}, afterRead: async () => {}, beforeComplete: async () => {}, beforeDraft: async () => {}, afterDraft: async () => {}, beforeWorkspace: async () => {},
    completeChange: {} as Partial<Dto<'MaterialResponse'>> };
  const api: ConstructorParameters<typeof ReviewUploadRecovery>[0] = {
    createUpload: async (project, body) => { const id = 'upload-' + declarations.size; declarations.set(id, structuredClone(body)); calls.push({ method: 'create', project, id, body }); return { upload_id: id, state: 'uploading', upload_url: '/bytes/' + id, expires_at: '2099-01-01T00:00:00Z', max_bytes: 104857600 }; },
    uploadBytes: async () => { calls.push({ method: 'put' }); if (state.dropPut) { state.dropPut = false; throw new ApiError(0, 'DATA_UNAVAILABLE'); } },
    completeUpload: async (project, id) => { calls.push({ method: 'complete', project, id }); await state.beforeComplete(); const d = declarations.get(id)!;
      const m: Dto<'MaterialResponse'> = { ...d, material_id: 'material-' + id, material_version: 1, upload_id: id, state: 'persisted', persisted_at: now, error: null, ...state.completeChange }; materials.set(m.material_id, m); return structuredClone(m); },
    material: async (project, id, _signal, version) => { calls.push({ method: 'material', project, id, body: version }); const m = materials.get(id); if (!m) throw new ApiError(404, 'NOT_FOUND'); return structuredClone(m); },
    project: async () => { throw new Error('unexpected project discovery'); },
  };
  const review: ConstructorParameters<typeof ReviewUploadRecovery>[1] = {
    drafts: async () => { calls.push({ method: 'get-draft' }); await state.beforeRead(); const value = { draft: structuredClone(state.server), message_drafts: [] }; await state.afterRead(); return value; },
    saveDraft: async body => { calls.push({ method: 'draft', body: structuredClone(body) }); state.draftWrites++; await state.beforeDraft();
      if (state.failDraftBefore) throw new ApiError(0, 'DATA_UNAVAILABLE'); assert.equal(body.kind, 'input'); if (body.kind !== 'input') throw new Error();
      if (body.expected_version !== state.server.version) throw new ApiError(409, 'INPUT_REVISION_CONFLICT'); state.server = { ...structuredClone(body.input), version: body.expected_version + 1 }; await state.afterDraft(); if (state.failDraftAfter) throw new ApiError(0, 'DATA_UNAVAILABLE'); },
    workspace: async id => { calls.push({ method: 'workspace', id }); await state.beforeWorkspace(); return { project: { project_id: 'project' }, selected_report: state.selected } as ReviewWorkspace; },
  };
  const make = (change: Partial<ConstructorParameters<typeof ReviewUploadRecovery>[4]> = {}) => new ReviewUploadRecovery(api, review, 'owner', 'project', { current: () => state.live, snapshot: () => structuredClone(state.page), store, lock,
    id: () => 'id-' + ++nonce, digest: async f => sha(await f.text()), ...change });
  const helper = make(), apply = (draft: ReviewDraft) => { const { version, ...input } = draft; state.page = { version, input: structuredClone(input) }; };
  const envelopeKey = () => [...store.data.keys()].find(key => key.startsWith('bb-review-upload-v1:'))!;
  const coreKeys = () => [...store.data.keys()].filter(key => key.startsWith('bondbuddy:upload-recovery:v1:'));
  return { helper, make, state, store, calls, materials, apply, envelopeKey, coreKeys };
}
const methods = (h: ReturnType<typeof harness>) => h.calls.map(call => call.method);
const drafts = (h: ReturnType<typeof harness>) => h.calls.filter(call => call.method === 'draft');
const cacheKey = 'bb-review-input:owner:project';
async function unknownDraft(h = harness()) { const e = await h.helper.prepare([file()], 'other'); h.state.failDraftBefore = true; const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'retryable'); return { h, e, r }; }

test('original owner/project, ordered declarations, source policy and small transport references are durably fixed before create', async () => {
  const h = harness(), e = await h.helper.prepare([file(), file('第二份.pdf', 'second bytes')], 'audit');
  assert.deepEqual(methods(h), ['get-draft']); assert.equal(e.owner, 'owner'); assert.equal(e.projectId, 'project'); assert.equal(e.sourcePolicy, 'adopt-first-source-if-empty');
  assert.equal(e.items[1].index, 1); assert.notEqual(e.items[0].id, e.items[1].id); assert.deepEqual(h.helper.list(), [e]);
  for (const item of e.items) { const record = h.helper.transportRecords().find(record => record.id === item.id)!; assert.equal(reviewUploadRecordMatches(e, item.index, record), true); assert.deepEqual(record.context, reviewUploadContext(e, item.index)); assert.ok(JSON.stringify(record.context).length < 300); }
});

test('a complete original draft larger than the core limit remains in its independent strict envelope', async () => {
  const input = base(); input.requirements = Array.from({ length: 25 }, (_, i) => String(i) + '原'.repeat(11990)); const h = harness(input), e = await h.helper.prepare([file()], 'other');
  assert.ok(JSON.stringify(e.baseInput).length > 256000); assert.equal(h.helper.list()[0].baseInput.requirements[24], input.requirements[24]); assert.ok(JSON.stringify(h.helper.transportRecords()[0]).length < 3000);
});

test('normal serial adoption preserves full requirements and the first verified source for later historical items', async () => {
  const h = harness(), files = [file('第一份.docx', 'first source'), file('第二份.docx', 'second source')], e = await h.helper.prepare(files, 'historical');
  const first = await h.helper.resume(e.id, 0, { file: files[0] }); assert.equal(first.state, 'adopted'); assert.equal(first.applyToPage, true); h.apply(first.draft!);
  const originalSource = first.draft!.source_material_ref; const second = await h.helper.resume(e.id, 1, { file: files[1] });
  assert.equal(second.state, 'complete'); assert.equal(second.applyToPage, true); assert.deepEqual(second.draft!.source_material_ref, originalSource); assert.deepEqual(second.draft!.requirements, base().requirements);
  assert.equal(second.draft!.material_versions.length, 2); assert.deepEqual(h.helper.list(), []); assert.deepEqual(h.helper.transportRecords(), []); assert.equal(drafts(h).length, 2);
  assert.equal((drafts(h)[1].body as { expected_version: number }).expected_version, 8);
});

test('a later batch item cannot run before its original prefix has been fully adopted and cleaned', async () => {
  const h = harness(), e = await h.helper.prepare([file(), file('later.pdf')], 'other'), before = h.calls.length;
  await assert.rejects(h.helper.resume(e.id, 1, { file: file('later.pdf') }), /前一份/); assert.equal(h.calls.length, before); assert.equal(drafts(h).length, 0);
});

test('unknown byte response refresh confirms the original upload with no File and no second create or byte PUT', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.state.dropPut = true; await assert.rejects(h.helper.resume(e.id, 0, { file: file() }));
  const before = h.calls.length, r = await h.make().resume(e.id, 0); assert.equal(r.state, 'complete'); assert.equal(h.calls.filter(call => call.method === 'create').length, 1); assert.equal(h.calls.filter(call => call.method === 'put').length, 1);
  assert.equal(h.calls.slice(before)[0].method, 'complete'); assert.equal(r.draft!.version, 8);
});

test('lost original draft response after acceptance converges only through exact v+1 and the complete input', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.state.failDraftAfter = true; const r = await h.helper.resume(e.id, 0, { file: file() });
  assert.equal(r.state, 'complete'); assert.equal(r.draft!.version, 8); assert.equal(drafts(h).length, 1); assert.deepEqual(h.helper.list(), []);
});

test('v+B preserves the original sealed CAS and only an explicit retry replays the exact same complete body', async () => {
  const { h, e } = await unknownDraft(), saved = h.helper.list()[0].items[0], original = structuredClone(saved.adoptionRequest), before = h.calls.length;
  assert.equal(saved.stage, 'adoption_unknown'); assert.equal((await h.make().resume(e.id, 0)).state, 'retryable'); assert.deepEqual(h.calls.slice(before).map(call => call.method), ['get-draft']); assert.equal(drafts(h).length, 1);
  h.state.failDraftBefore = false; const r = await h.make().resume(e.id, 0, { retryAdoption: true }); assert.equal(r.state, 'complete'); assert.deepEqual(drafts(h).map(call => call.body), [original, original]); assert.equal(h.calls.filter(call => call.method === 'put').length, 1);
});

test('refresh after an accepted unknown request permits exact already-displayed v+1/S and clears only the original cache', async () => {
  const { h, e } = await unknownDraft(), item = h.helper.list()[0].items[0]; h.state.server = { ...structuredClone(item.adoptionRequest!.input), version: 8 }; h.apply(h.state.server);
  const before = h.calls.length, r = await h.make().reconcile(e.id, 0); assert.equal(r.state, 'complete'); assert.equal(r.applyToPage, true); assert.deepEqual(h.calls.slice(before).map(call => call.method), ['get-draft']); assert.equal(drafts(h).length, 1);
});

for (const variant of ['higher-same', 'next-different', 'same-different', 'rollback'] as const) test('read-only reconciliation rejects ' + variant + ' without rebasing or replay', async () => {
  const { h, e } = await unknownDraft(), item = h.helper.list()[0].items[0];
  if (variant === 'higher-same') h.state.server = { ...structuredClone(item.adoptionRequest!.input), version: 9 };
  if (variant === 'next-different') h.state.server = { ...base(), requirements: ['foreign'], version: 8 };
  if (variant === 'same-different') h.state.server = { ...base(), requirements: ['foreign'], version: 7 };
  if (variant === 'rollback') h.state.server = { ...base(), version: 6 };
  const before = h.calls.length, r = await h.make().resume(e.id, 0, { retryAdoption: true }); assert.equal(r.state, 'conflict'); assert.equal(r.applyToPage, false); assert.deepEqual(h.calls.slice(before).map(call => call.method), ['get-draft']);
  assert.deepEqual(h.helper.list()[0].items[0].adoptionRequest, item.adoptionRequest); assert.equal(drafts(h).length, 1);
});

test('a failed GET after original PUT stays unknown and cannot be treated as proof of no acceptance', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.state.afterDraft = async () => { h.state.beforeRead = async () => { throw new ApiError(503, 'DATA_UNAVAILABLE'); }; };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.helper.list()[0].items[0].stage, 'adoption_unknown'); assert.equal(drafts(h).length, 1);
});

for (const field of ['page', 'cache', 'server'] as const) test('changed original ' + field + ' while material completion is pending cannot overwrite new preparation', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other');
  h.state.beforeComplete = async () => { if (field === 'page') h.state.page.input.requirements = ['new local']; if (field === 'cache') h.store.setItem(cacheKey, 'foreign raw'); if (field === 'server') h.state.server = { ...base(), requirements: ['new server'], version: 8 }; };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.helper.list()[0].items[0].stage, 'material_saved'); assert.equal(drafts(h).length, 0); assert.equal(h.helper.transportRecords()[0].stage, 'saved');
});

test('targeted adoption uses the original complete report and exact target even when a different report is selected elsewhere', async () => {
  assert.equal(isReviewReport(report()), true); const h = harness(), e = await h.helper.prepare([file()], 'other', target());
  const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.deepEqual(r.draft!.evidence_links, [{ report_id: 'report-original', finding_id: 'finding-original', material_ref: r.draft!.material_versions[0] }]);
  assert.ok(h.calls.filter(call => call.method === 'workspace').every(call => call.id === 'report-original')); assert.deepEqual(r.envelope.targetContext, target());
});

for (const change of ['missing', 'finding', 'snapshot', 'wrong-report', 'wrong-project'] as const) test('an unavailable or changed original report blocks target adoption: ' + change, async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other', target());
  h.state.beforeComplete = async () => { if (change === 'missing') h.state.selected = null; else if (change === 'finding') h.state.selected!.findings = []; else if (change === 'snapshot') h.state.selected!.findings[0].description = 'changed original report'; else if (change === 'wrong-report') h.state.selected!.report_id = 'other'; else h.state.selected!.project_id = 'foreign'; };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(drafts(h).length, 0); assert.equal(h.helper.list()[0].items[0].stage, 'material_saved');
});

test('a nonempty target pin list must still belong to its original findings, not an arbitrary same-project material', async () => {
  const h = harness(); const context = target(); context.material_refs = [{ material_id: 'foreign-to-finding', material_version: 1, sha256: sha('x') }]; await assert.rejects(h.helper.prepare([file()], 'other', context)); assert.deepEqual(h.helper.list(), []); assert.equal(h.helper.transportRecords().length, 0);
});

for (const relation of ['source', 'link'] as const) test('replacing an existing material version cannot delete or strand an old ' + relation, async () => {
  const oldPin = { material_id: 'same-material', material_version: 1, sha256: sha('old') }, input = base(); input.material_versions = [oldPin];
  if (relation === 'source') input.source_material_ref = oldPin; else input.evidence_links = [{ report_id: 'report-old', finding_id: 'finding-old', material_ref: oldPin }];
  const h = harness(input), e = await h.helper.prepare([file()], 'other'); h.state.completeChange = { material_id: oldPin.material_id, material_version: 2 };
  if (relation === 'source') h.materials.set(oldPin.material_id, { material_id: oldPin.material_id, material_version: 1, sha256: oldPin.sha256, media_type: docx, role: 'historical', filename: 'source.docx', byte_size: 3, upload_id: 'source-u', state: 'persisted', persisted_at: now, error: null });
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(drafts(h).length, 0); assert.deepEqual(h.state.server, { ...input, version: 7 });
});

test('same exact material deduplication may retain the original material upload ID without rotating the original request upload', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.state.completeChange = { upload_id: 'older-upload', filename: 'older-name.pdf' };
  const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'complete'); assert.equal(r.envelope.items[0].material!.upload_id, 'older-upload'); assert.equal(h.calls.filter(call => call.method === 'create').length, 1);
});

for (const role of ['historical', 'reference'] as const) test(role + ' accepts only DOCX/PDF at both public entry and durable parsing', async () => {
  const h = harness(); await assert.rejects(h.helper.prepare([file('unsupported.xlsx')], role)); assert.equal(h.helper.list().length, 0); assert.equal(h.helper.transportRecords().length, 0);
});

test('public schema alone cannot permit duplicate material IDs, dangling links, impossible dates or limits', () => {
  const p = { material_id: 'a', material_version: 1, sha256: sha('a') }, input = base();
  assert.equal(reviewUploadValidInput({ ...input, material_versions: [p, p] }), false); assert.equal(reviewUploadValidInput({ ...input, source_material_ref: p }), false);
  assert.equal(reviewUploadValidInput({ ...input, evidence_links: [{ report_id: 'r', finding_id: 'f', material_ref: p }] }), false); assert.equal(reviewUploadValidInput({ ...input, as_of: '2026-02-30' }), false);
  assert.equal(reviewUploadValidInput({ ...input, material_versions: Array.from({ length: 61 }, (_, i) => ({ ...p, material_id: String(i) })) }), false);
});

test('adding a 61st material retains the saved receipt without sending a partial original input', async () => {
  const input = base(); input.material_versions = Array.from({ length: 60 }, (_, i) => ({ material_id: 'existing-' + i, material_version: 1, sha256: sha(String(i)) }));
  const h = harness(input), e = await h.helper.prepare([file()], 'other'); await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.helper.list()[0].items[0].stage, 'material_saved'); assert.equal(drafts(h).length, 0);
});

test('saved material without a sealed draft request must still revalidate its exact original version before adoption', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.state.beforeRead = async () => { throw new ApiError(503, 'DATA_UNAVAILABLE'); };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); const saved = h.helper.list()[0].items[0]; assert.equal(saved.stage, 'material_saved'); h.state.beforeRead = async () => {};
  h.materials.get(saved.material!.material_id)!.material_version++;
  await assert.rejects(h.make().resume(e.id, 0)); assert.equal(drafts(h).length, 0); assert.equal(h.calls.filter(call => call.method === 'create').length, 1);
});

test('a saved receipt cannot reconstruct a missing known transport record when no draft request was sealed', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.state.beforeRead = async () => { throw new ApiError(503, 'DATA_UNAVAILABLE'); };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); for (const key of h.coreKeys()) h.store.removeItem(key); h.state.beforeRead = async () => {}; const before = h.calls.length;
  await assert.rejects(h.make().resume(e.id, 0)); assert.equal(h.calls.length, before); assert.equal(drafts(h).length, 0);
});

test('known missing envelope or core records never re-begin an upload from the original in-memory File', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'), before = h.calls.length; for (const key of h.coreKeys()) h.store.removeItem(key);
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.calls.length, before); h.store.removeItem(h.envelopeKey()); await assert.rejects(h.helper.resume(e.id, 0, { file: file() })); assert.equal(h.calls.length, before);
});

test('orphan transport supports only local cleanup and never discovers or adopts a candidate material', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.store.removeItem(h.envelopeKey()); const before = h.calls.length;
  assert.equal(h.helper.transportRecords().length, 1); await h.helper.removeOrphan(e.items[0].id); assert.equal(h.calls.length, before); assert.equal(h.helper.transportRecords().length, 0);
});

test('initial storage or lock failure prevents transport creation and draft adoption', async () => {
  const h = harness(); h.store.beforeSet = () => { throw new Error('quota'); }; await assert.rejects(h.helper.prepare([file()], 'other'), UploadRecoveryStorageError); assert.equal(h.calls.filter(call => ['create', 'draft', 'put'].includes(call.method)).length, 0);
  const before = h.calls.length; await assert.rejects(h.make({ lock: { run: async () => { throw new UploadRecoveryLockError(); } } }).prepare([file()], 'other'), UploadRecoveryLockError); assert.equal(h.calls.length, before);
});

test('failure to durably mark adoption_unknown stops before the complete CAS request is emitted', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.store.beforeSet = (key, value) => { if (key.startsWith('bb-review-upload') && JSON.parse(value).items[0].stage === 'adoption_unknown') throw new Error('quota'); };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), UploadRecoveryStorageError); assert.equal(h.helper.list()[0].items[0].stage, 'adoption_prepared'); assert.equal(drafts(h).length, 0);
});

test('server adoption with failed local cleanup remains cleanup-only and does not repeat any API on retry', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); h.store.beforeRemove = key => { if (key === cacheKey) throw new Error('quota'); };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), UploadRecoveryStorageError); assert.equal(h.helper.list()[0].items[0].stage, 'cleanup_pending'); assert.equal(drafts(h).length, 1);
  h.store.beforeRemove = undefined; const before = h.calls.length, r = await h.make().resume(e.id, 0); assert.equal(r.state, 'complete'); assert.equal(h.calls.length, before); assert.equal(r.applyToPage, true);
});

test('cleanup after a removed original raw and lost local receipt can finish without mistaking removal for a foreign draft', async () => {
  const h = harness(); h.store.setItem(cacheKey, JSON.stringify({ owner: 'owner', project_id: 'project', version: 7, input: base() })); const e = await h.helper.prepare([file()], 'other');
  let failed = false; h.store.beforeSet = (key, value) => { const v = key.startsWith('bb-review-upload') ? JSON.parse(value) : null; if (!failed && v?.items[0].localCacheResult === 'cleared') { failed = true; throw new Error('lost cleanup journal write'); } };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), UploadRecoveryStorageError); assert.equal(h.store.getItem(cacheKey), null); h.store.beforeSet = undefined;
  const before = h.calls.length, r = await h.make().resume(e.id, 0); assert.equal(r.state, 'complete'); assert.equal(r.applyToPage, true); assert.equal(h.calls.length, before);
});

for (const change of ['cache', 'page'] as const) test('confirmed adoption preserves a newer local ' + change + ' and stops the remaining batch', async () => {
  const h = harness(), e = await h.helper.prepare([file(), file('later.pdf')], 'other'); h.state.afterDraft = async () => { if (change === 'cache') h.store.setItem(cacheKey, 'newer local raw'); else h.state.page.input.requirements = ['new local requirement']; };
  const r = await h.helper.resume(e.id, 0, { file: file() }); assert.equal(r.state, 'adopted'); assert.equal(r.applyToPage, false); assert.equal(r.envelope.items[0].localCacheResult, 'preserved');
  const before = h.calls.length; await assert.rejects(h.helper.resume(e.id, 1, { file: file('later.pdf') })); assert.equal(h.calls.length, before); if (change === 'cache') assert.equal(h.store.getItem(cacheKey), 'newer local raw');
});

test('another page changing an envelope during a GET causes complete-record CAS refusal before draft PUT', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other'); let changed = false;
  h.state.beforeRead = async () => { if (!changed) { changed = true; const key = h.envelopeKey(), value = JSON.parse(h.store.getItem(key)!); value.recordRevision++; h.store.setItem(key, JSON.stringify(value)); } };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), /另一页面/); assert.equal(drafts(h).length, 0);
});

for (const point of ['complete', 'target-read', 'draft-read'] as const) test('late owner or route change after ' + point + ' cannot adopt or expose progress to a replacement page', async () => {
  const h = harness(), e = await h.helper.prepare([file()], 'other', point === 'target-read' ? target() : undefined);
  if (point === 'complete') h.state.beforeComplete = async () => { h.state.live = false; };
  if (point === 'target-read') h.state.beforeWorkspace = async () => { h.state.live = false; };
  if (point === 'draft-read') h.state.beforeRead = async () => { h.state.live = false; };
  await assert.rejects(h.helper.resume(e.id, 0, { file: file() }), { name: 'AbortError' }); assert.equal(drafts(h).length, 0);
});

test('stop clears only the local ordered batch while keeping server material and any accepted draft', async () => {
  const { h, e } = await unknownDraft(), before = h.calls.length; await h.helper.stop(e.id); assert.equal(h.calls.length, before); assert.equal(h.materials.size, 1); assert.deepEqual(h.helper.list(), []); assert.deepEqual(h.helper.transportRecords(), []); assert.equal(h.state.server.version, 7);
});

for (const tamper of ['unknown-field', 'body', 'digest', 'target', 'stage-prefix'] as const) test('strict durable parsing rejects ' + tamper + ' without new network', async () => {
  const { h, e } = await unknownDraft(), key = h.envelopeKey(), value = JSON.parse(h.store.getItem(key)!);
  if (tamper === 'unknown-field') value.upload_url = '/private-bytes'; if (tamper === 'body') value.items[0].adoptionRequest.input.requirements = ['rewritten']; if (tamper === 'digest') value.digest = 'a'.repeat(64); if (tamper === 'target') value.targetContext = target(); if (tamper === 'stage-prefix') value.items[0].index = 1;
  h.store.setItem(key, JSON.stringify(value)); const before = h.calls.length; assert.throws(() => h.helper.list()); await assert.rejects(h.helper.resume(e.id, 0)); assert.equal(h.calls.length, before);
});
