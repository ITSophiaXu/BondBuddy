import {UPLOAD_BYTES_PENDING_FIELD_ERROR} from '@bondbuddy/contracts';
import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { FormatRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { M4_DOCUMENT_TYPES, M4DraftInputSchema, M4DraftRequestSchema, M4MaterialPinSchema, M4ViewRequestSchema, schemas,
  type M4Artifact, type M4DocumentType, type M4Draft, type M4DraftInput, type M4DraftRequest, type M4MaterialPin, type M4Requirement, type M4Workspace } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';

// The actual component and public HTTP boundary are used. No model, DOCX, billing or object-store acceptance is implied.
export const ids = { owner: 'm4-thirteenth-owner', otherOwner: 'm4-thirteenth-owner-b', topic: 'm4-thirteenth-topic', project: 'm4-thirteenth-project', sourceProject: 'm4-thirteenth-source-project' };
export const now = '2026-10-25T12:00:00Z', mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const file = { name: '原合并口径募集书-手机长文件名换行检查.pdf', mimeType: 'application/pdf' as const, buffer: Buffer.from('%PDF-1.7\nSynthetic M4 thirteenth original file\n%%EOF') };
export const secondFile = { name: '第二份资金用途证明.pdf', mimeType: 'application/pdf' as const, buffer: Buffer.from('%PDF-1.7\nSynthetic M4 ordered second file\n%%EOF') };
export const inputOf = (draft: M4Draft): M4DraftInput => { const { version: _v, sha256: _s, updated_at: _u, ...input } = draft; return structuredClone(input); };
export const pin = (material: Dto<'MaterialResponse'>, project = ids.project): M4MaterialPin => ({ source_project_id: project, material_id: material.material_id, material_version: material.material_version, sha256: material.sha256 });
export const pinKey = (value: M4MaterialPin) => [value.source_project_id, value.material_id, value.material_version, value.sha256].join(':');
export const requirement = (id: string, text = `保留结构化要求 ${id}。`): M4Requirement => ({ requirement_id: id, text, message_id: `assistant-${id}`, message_version: 2 });
FormatRegistry.Set('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export function check(schema: TSchema, value: unknown) { expect(Value.Check(schema, value), JSON.stringify([...Value.Errors(schema, value)])).toBe(true); }
export const materialOf = (selected: { name: string; mimeType: Dto<'MaterialResponse'>['media_type']; buffer: Buffer } = file, id = 'm4-thirteenth-existing-upload'): Dto<'MaterialResponse'> => ({ material_id: id, material_version: 1, upload_id: 'older-legal-upload', filename: selected.name, media_type: selected.mimeType, byte_size: selected.buffer.length, sha256: hash(selected.buffer), role: 'other', state: 'persisted', persisted_at: now, error: null });
export type Call = { method: string; path: string; search: string; body?: unknown };
type Upload = { declaration: Dto<'UploadCreateRequest'>; received: boolean; bytes?: Buffer; material?: Dto<'MaterialResponse'> };
export function fixture() {
  const source: Dto<'MaterialResponse'> = { ...materialOf({ name: '原已保存募集书.docx', mimeType: mime, buffer: Buffer.from('Synthetic old prospectus') }, 'm4-thirteenth-source'), role: 'historical' };
  const supporting: Dto<'MaterialResponse'> = materialOf({ name: '原已保存审计说明.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Synthetic old supporting note') }, 'm4-thirteenth-supporting');
  const oldSource = pin(source, ids.sourceProject), support = pin(supporting);
  const artifact: M4Artifact = { source_project_id: ids.project, artifact_id: 'm4-thirteenth-edit-base', artifact_version: 2, sha256: hash('Synthetic old artifact'), topic_id: ids.topic, run_id: 'm4-thirteenth-old-run', document_type: 'private_summary', kind: 'document', filename: '原已保存摘要.docx', mime_type: mime, byte_size: 31, created_at: now, base_artifact: null, input_hash: hash('old complete input'), revision_number: 2 };
  const draft = (type: M4DocumentType): M4Draft => ({ document_type: type, version: 3, sha256: hash(type), updated_at: now, source_material: structuredClone(oldSource), materials: [structuredClone(support)],
    template: { template_id: 'm4-thirteenth-template', template_version: 2, sha256: hash('template') }, edit_base: { source_project_id: artifact.source_project_id, artifact_id: artifact.artifact_id, artifact_version: artifact.artifact_version, sha256: artifact.sha256 }, scope: 'whole',
    fields: { issuer_name: '合成发行人', market: 'sse', offering: 'private', broker: '合成券商', source_mode: 'upload', reporting_cutoff: '2026-09-30', custom_complete_field: `原${type}完整字段` },
    requirements: [requirement('original-1'), requirement('original-2', '保留消息版本、顺序和金额单位。')], supplemental_requirements: `原${type}补充要求，不能被其他文种覆盖。` });
  const drafts = Object.fromEntries(M4_DOCUMENT_TYPES.map(type => [type, draft(type)])) as M4Workspace['drafts'];
  const workspace: M4Workspace = { topic: { topic_id: ids.topic, project_id: ids.project, source_project_id: ids.sourceProject, name: '合成材料上传恢复项目', surface: 'materials', created_at: now, updated_at: now },
    project: { project_id: ids.project, draft_revision: 1, input_revision: null, input_hash: null, name: '合成材料上传恢复项目', kind: 'generation', issuer_name: '合成发行人', market: 'sse', offering: 'private', updated_at: now }, drafts,
    materials: [oldSource, support], material_details: [{ ...oldSource, filename: source.filename, state: 'persisted', media_type: source.media_type }, { ...support, filename: supporting.filename, state: 'persisted', media_type: supporting.media_type }],
    templates: [{ template_id: 'm4-thirteenth-template', template_version: 2, sha256: hash('template'), name: '原私有模板', broker: '合成券商', document_type: 'private_summary', material: support, owner_scope: 'private', market: 'sse', offering: 'private', status: 'active', created_at: now, retired_at: null }],
    messages: [], tasks: [], pending_requirements: [], artifacts: [artifact], view: { selected_document_type: 'private_summary', open_tabs: [], active_tab: null, unsent_content: '', unsent_context: { document_type: 'private_summary', draft_version: 3, source_material: oldSource, citations: [], reading_artifact: null }, workspace_tab: 'input', tab_scroll: {}, version: 0 }, active_run: null };
  const materials = new Map([[pinKey(oldSource), source], [pinKey(support), supporting]]);
  return { owner: ids.owner as string, workspace, materials, materialBytes: new Map<string, Buffer>([[pinKey(oldSource), Buffer.from('Synthetic old prospectus')], [pinKey(support), Buffer.from('Synthetic old supporting note')]]), uploads: new Map<string, Upload>(), calls: [] as Call[], errors: [] as string[], unexpected: [] as string[], workspaceReads: 0,
    sessionLifetimeMs: undefined as number|undefined, confirmationFaults: new Map<string, number>(), dropPut: undefined as 'before' | 'after' | undefined, dropCompleteAt: 0, dropLibrary: undefined as 'before' | 'after' | undefined, dropDraft: undefined as 'before' | 'after' | undefined,
    failWorkspaceReads: false, failMaterialReads: false, unavailableTopic: false,
    beforeDraft: undefined as ((request: M4DraftRequest) => void) | undefined, afterDraft: undefined as ((request: M4DraftRequest) => void) | undefined,
    workspaceObservation: undefined as ((workspace: M4Workspace, read: number) => M4Workspace) | undefined,
    workspaceGate: undefined as ((workspace: M4Workspace, read: number) => Promise<void>) | undefined,
    completeGate: undefined as (() => Promise<void>) | undefined, libraryGate: undefined as (() => Promise<void>) | undefined, draftGate: undefined as (() => Promise<void>) | undefined,
    dedupMaterial: undefined as Dto<'MaterialResponse'> | undefined, projectFileSources: new Map<string, M4MaterialPin>() };
}
export type State = ReturnType<typeof fixture>;
export function addMaterial(state: State, material: Dto<'MaterialResponse'>, project = ids.project, library = false) {
  const selected = pin(material, project); state.materials.set(pinKey(selected), material);
  if (library && !state.workspace.materials.some(value => pinKey(value) === pinKey(selected))) { state.workspace.materials.push(selected); state.workspace.material_details.push({ ...selected, filename: material.filename, state: material.state, media_type: material.media_type, role: material.role }); }
  return selected;
}
function validateWorkspace(state: State, value: M4Workspace) {
  expect(value.topic.topic_id).toBe(ids.topic); expect(value.topic.project_id).toBe(ids.project); check(schemas.ProjectResponse, value.project);
  for (const type of M4_DOCUMENT_TYPES) { const draft = value.drafts[type]; check(M4DraftInputSchema, inputOf(draft)); expect(draft.document_type).toBe(type); expect(Number.isSafeInteger(draft.version) && draft.version >= 0).toBe(true); }
  value.materials.forEach(selected => check(M4MaterialPinSchema, selected)); value.pending_requirements.forEach(value => expect(value.message_version).toBe(2)); return value;
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: fixtureBody(route,body) });
function requirementMessages(state: State) {
  const rows = [...Object.values(state.workspace.drafts).flatMap(draft => draft.requirements), ...state.workspace.pending_requirements], grouped = new Map<string, M4Requirement[]>();
  for (const row of rows) { const key = `${row.message_id}:${row.message_version}`, previous = grouped.get(key) ?? []; if (!previous.some(value => value.requirement_id === row.requirement_id)) previous.push(row); grouped.set(key, previous); }
  for (const values of grouped.values()) { const first = values[0]; if (state.workspace.messages.some(message => message.message_id === first.message_id && message.version === first.message_version)) continue; const content = values.map(value => value.text).join('\n'); state.workspace.messages.push({ message_id: first.message_id, role: 'assistant', content, version: first.message_version, context: { document_type: null, draft_version: 0, source_material: null, citations: [], reading_artifact: null }, created_at: now, reply_status: 'completed', reply_to: null, run_id: null, reply: { content, citations: [], requirements: values.map(value => value.text), fields: {}, intent: 'draft', document_type: null, target_business: null, retrieval: 'not_performed' }, error: null }); }
}
function problem(route: Route, status: number, code: Dto<'Error'>['code']) { const body: Dto<'Error'> = { code, message: `Synthetic ${code}`, retryable: status >= 500, correlation_id: 'm4-thirteenth-trace', field_errors: [] }; check(schemas.Error, body); return json(route, body, status); }
export async function install(page: Page, state = fixture()) {
  page.on('pageerror', error => state.errors.push(error.message)); await page.clock.install({ time: new Date(now) });
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length), method = request.method(), isBytes = path.endsWith('/bytes');
    const body = request.postData() && !isBytes ? fixtureRequest(request) : undefined; state.calls.push({ method, path, search: url.search, ...(body === undefined ? {} : { body }) });
    if (state.owner !== ids.owner) return problem(route, 404, 'NOT_FOUND');
    if (method === 'GET') {
      if (path === '/me') return json(route, { user_id: ids.owner, session_status: 'active' });
      if (path === '/m4/topics') return json(route, { topics: [state.workspace.topic] });
      if (path === `/projects/${ids.project}`) return json(route, state.workspace.project);
      if (path === `/projects/${ids.sourceProject}`) return json(route, { ...state.workspace.project, project_id: ids.sourceProject, name: '仅导航来源项目', kind: 'update' });
      if (path === `/m4/topics/${ids.topic}/workspace`) {
        state.workspaceReads++; if (state.unavailableTopic) return problem(route, 404, 'NOT_FOUND'); if (state.failWorkspaceReads) return problem(route, 503, 'DATA_UNAVAILABLE');
        requirementMessages(state); const value = validateWorkspace(state, state.workspaceObservation?.(structuredClone(state.workspace), state.workspaceReads) ?? structuredClone(state.workspace)); if (state.workspaceGate) await state.workspaceGate(value, state.workspaceReads); return json(route, value);
      }
      const download = path.match(/^\/projects\/([^/]+)\/materials\/([^/]+)\/download$/);
      if (download) { expect(url.searchParams.has('version')).toBe(true); const material = [...state.materials.values()].find(value => value.material_id === download[2] && value.material_version === Number(url.searchParams.get('version'))), selected = material && pin(material, download[1]), bytes = selected && state.materialBytes.get(pinKey(selected)); if (!material || !bytes) return problem(route, 404, 'NOT_FOUND'); expect(hash(bytes)).toBe(material.sha256); expect(bytes.length).toBe(material.byte_size); return route.fulfill({ status: 200, contentType: material.media_type, body: bytes }); }
      const selected = path.match(/^\/projects\/([^/]+)\/materials\/([^/]+)$/);
      if (selected) {
        if (state.failMaterialReads) return problem(route, 503, 'DATA_UNAVAILABLE');
        const candidates = [...state.materials.entries()].filter(([key]) => key.startsWith(`${selected[1]}:${selected[2]}:`)).map(([, material]) => material);
        const material = url.searchParams.has('version') ? candidates.find(value => value.material_version === Number(url.searchParams.get('version'))) : candidates.sort((a, b) => b.material_version - a.material_version)[0];
        if (!material) return problem(route, 404, 'NOT_FOUND'); check(schemas.MaterialResponse, material); return json(route, material);
      }
      if (path === `/m4/artifacts/${state.workspace.artifacts[0].artifact_id}/versions/2/preview`) return json(route, { artifact: state.workspace.artifacts[0], content: '合成原成果正文。阅读不应保存任何草稿或页面状态。' });
    }
    if (method === 'POST' && path === `/projects/${ids.project}/materials/uploads`) {
      check(schemas.UploadCreateRequest, body); const id = `m4-thirteenth-U-${state.uploads.size + 1}`; state.uploads.set(id, { declaration: structuredClone(body), received: false });
      const value: Dto<'UploadSessionResponse'> = { upload_id: id, state: 'uploading', upload_url: `/api/v1/projects/${ids.project}/materials/uploads/${id}/bytes`, expires_at: state.sessionLifetimeMs===undefined?'2099-01-01T00:00:00Z':new Date(await page.evaluate(()=>Date.now())+state.sessionLifetimeMs).toISOString(), max_bytes: 104857600 }; check(schemas.UploadSessionResponse, value); return json(route, value, 201);
    }
    const transfer = path.match(new RegExp(`^/projects/${ids.project}/materials/uploads/([^/]+)/(bytes|complete)$`));
    if (transfer) {
      const saved = state.uploads.get(transfer[1]); if (!saved) return problem(route, 404, 'NOT_FOUND');
      if (method === 'PUT' && transfer[2] === 'bytes') { const bytes = request.postDataBuffer()!; expect(bytes.length).toBe(saved.declaration.byte_size); expect(hash(bytes)).toBe(saved.declaration.sha256); const drop = state.dropPut; state.dropPut = undefined; if (drop === 'before') return route.abort('connectionreset'); saved.received = true; saved.bytes = bytes; if (drop === 'after') {state.confirmationFaults.set(transfer[1],4);return route.abort('connectionreset');} return route.fulfill({ status: 204 }); }
      if (method === 'POST' && transfer[2] === 'complete') {
        check(schemas.UploadCompleteRequest, body); expect(body).toEqual({ byte_size: saved.declaration.byte_size, sha256: saved.declaration.sha256 }); if (!saved.received) return json(route,{code:'MATERIAL_UNREADABLE',message:'Synthetic original bytes have not arrived',retryable:false,correlation_id:'missing-original-bytes',field_errors:[{...UPLOAD_BYTES_PENDING_FIELD_ERROR,message:'Upload bytes not received'}]},422);
        const remaining=state.confirmationFaults.get(transfer[1])??0;if(remaining){state.confirmationFaults.set(transfer[1],remaining-1);return problem(route,503,'DATA_UNAVAILABLE');}
        if (!saved.material) { saved.material = state.dedupMaterial ?? { ...saved.declaration, material_id: 'material-' + transfer[1], material_version: 1, upload_id: transfer[1], state: 'persisted', persisted_at: now, error: null }; const selected = addMaterial(state, saved.material); if (saved.bytes) state.materialBytes.set(pinKey(selected), saved.bytes); }
        if (state.completeGate) await state.completeGate(); if (state.dropCompleteAt === Number(transfer[1].split('-').at(-1))) { state.dropCompleteAt = 0; state.confirmationFaults.set(transfer[1],3); return route.abort('connectionreset'); } check(schemas.MaterialResponse, saved.material); return json(route, saved.material);
      }
    }
    if (method === 'POST' && path === `/m4/topics/${ids.topic}/materials`) {
      check(M4MaterialPinSchema, body?.material); expect(Object.keys(body)).toEqual(['material']); if (!state.materials.has(pinKey(body.material))) return problem(route, 404, 'NOT_FOUND');
      if (state.libraryGate) await state.libraryGate(); const drop = state.dropLibrary; state.dropLibrary = undefined; if (drop === 'before') return route.abort('connectionreset');
      addMaterial(state, state.materials.get(pinKey(body.material))!, body.material.source_project_id, true); if (drop === 'after') return route.abort('connectionreset'); return json(route, { materials: state.workspace.materials });
    }
    if (method === 'PUT' && path.startsWith(`/m4/topics/${ids.topic}/drafts/`)) {
      check(M4DraftRequestSchema, body); const sent = body as M4DraftRequest; expect(path.split('/').at(-1)).toBe(sent.input.document_type);
      if (state.draftGate) await state.draftGate(); state.beforeDraft?.(sent); const drop = state.dropDraft; state.dropDraft = undefined; if (drop === 'before') return route.abort('connectionreset');
      const previous = state.workspace.drafts[sent.input.document_type]; if (sent.expected_version !== previous.version) return problem(route, 409, 'INPUT_REVISION_CONFLICT');
      const adopted: M4DraftInput = { ...structuredClone(sent.input), requirements: [...structuredClone(sent.input.requirements), ...structuredClone(state.workspace.pending_requirements.filter(value => !sent.input.requirements.some(old => old.requirement_id === value.requirement_id)))] }; check(M4DraftInputSchema, adopted);
      requirementMessages(state); for (const value of adopted.requirements) expect(state.workspace.messages.some(message => message.message_id === value.message_id && message.version === value.message_version && message.role === 'assistant' && message.reply?.requirements.includes(value.text))).toBe(true);
      expect(new Set(adopted.materials.map(value => `${value.material_id}:${value.material_version}`)).size).toBe(adopted.materials.length);
      for (const selected of [...adopted.materials, ...(adopted.source_material ? [adopted.source_material] : [])]) if (!state.materials.has(pinKey(selected))) return problem(route, 404, 'NOT_FOUND');
      if (adopted.project_file && pinKey(state.projectFileSources.get(adopted.project_file.source_version_id) ?? { source_project_id: '', material_id: '', material_version: 1, sha256: '' }) !== (adopted.source_material ? pinKey(adopted.source_material) : '')) return problem(route, 422, 'VALIDATION_FAILED');
      for (const selected of adopted.materials) addMaterial(state, state.materials.get(pinKey(selected))!, selected.source_project_id, true);
      const same = isDeepStrictEqual(inputOf(previous), adopted); state.workspace.drafts[sent.input.document_type] = previous.version > 0 && same ? previous : { ...adopted, version: previous.version + 1, sha256: hash(JSON.stringify(adopted)), updated_at: now };
      state.workspace.pending_requirements = []; state.afterDraft?.(sent); if (drop === 'after') return route.abort('connectionreset'); return json(route, { draft: state.workspace.drafts[sent.input.document_type] });
    }
    if (method === 'PUT' && path === `/m4/topics/${ids.topic}/view`) { check(M4ViewRequestSchema, body); if (body.expected_version !== state.workspace.view.version) return problem(route, 409, 'INPUT_REVISION_CONFLICT'); state.workspace.view = { ...structuredClone(body.view), version: body.expected_version + 1 }; return json(route, { view: state.workspace.view }); }
    state.unexpected.push(method + ' ' + path); return problem(route, 500, 'DATA_UNAVAILABLE');
  });
  await page.route(new URL('/', process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173').href, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div class="prototype-app"><main class="shell"></main></div></body></html>' })); return state;
}
export async function mount(page: Page, options: { navigation?: 'initial' | 'reload' | 'same-page'; owner?: string; entry?: 'topic' | 'generation-project' } = {}) {
  if (options.navigation === 'reload') await page.reload(); else if (options.navigation !== 'same-page') await page.goto('/');
  await page.evaluate(async options => {
    const w = window as unknown as { m4Component?: { dispose(): void }; m4Owner?: string }; w.m4Component?.dispose(); w.m4Owner = options.owner;
    const path = '/src/material-workspace.ts', apiPath = '/src/api.ts', { MaterialWorkspace } = await import(path), { ApiClient } = await import(apiPath);
    const component = new MaterialWorkspace(new ApiClient(), options.owner, (html: string) => { document.querySelector('.shell')!.innerHTML = html; }, () => w.m4Owner === options.owner, options.entry === 'generation-project' ? undefined : options.topic, options.entry === 'generation-project' ? options.project : options.sourceProject);
    w.m4Component = component; await component.render();
  }, { owner: options.owner ?? ids.owner, topic: ids.topic, project: ids.project, sourceProject: ids.sourceProject, entry: options.entry ?? 'topic' });
  for (const path of ['src/style.css', '../../product-prototype/public/styles.css', '../../product-prototype/public/source-prospectus.css', '../../product-prototype/public/project-workspace.css', 'src/prototype-adapter.css']) await page.addStyleTag({ content: (await readFile(resolve(process.cwd(), path), 'utf8')).replace(/@import\s+[^;]+;/g, '') });
  if ((options.owner ?? ids.owner) === ids.owner) await expect(page.locator('#m4-tabs')).toBeAttached();
}
export const writes = (state: State) => state.calls.filter(call => call.method !== 'GET');
export const uploads = (state: State, kind: 'create' | 'bytes' | 'complete') => state.calls.filter(call => kind === 'create' ? call.method === 'POST' && /\/materials\/uploads$/.test(call.path) : kind === 'bytes' ? call.method === 'PUT' && call.path.endsWith('/bytes') : call.method === 'POST' && call.path.endsWith('/complete'));
export const draftWrites = (state: State) => state.calls.filter(call => call.method === 'PUT' && call.path.includes('/drafts/')).map(call => call.body as M4DraftRequest);
export const libraryWrites = (state: State) => state.calls.filter(call => call.method === 'POST' && call.path === `/m4/topics/${ids.topic}/materials`);
export function noBusiness(state: State) { expect(state.calls.filter(call => call.method !== 'GET' && /\/(?:messages|quote|execute|templates|handoffs(?:\/bind)?)$/.test(call.path))).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]); }
export const recovery = (page: Page, filename = file.name) => page.locator('[data-m4-recovery-id]').filter({ hasText: filename }).first();
export async function records(page: Page) { return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bb-m4-upload-v1:')).map(key => ({ key, raw: localStorage.getItem(key)!, value: JSON.parse(localStorage.getItem(key)!) }))); }
export async function legacyCache(page: Page) { return page.evaluate(({ owner, topic }) => JSON.parse(localStorage.getItem(`bb-m4:${owner}:${topic}`) ?? 'null'), ids); }
export async function choose(page: Page, type: M4DocumentType) { await page.locator(`[data-m4-type][value=${type}]`).check(); await expect(page.locator('[data-m4-type]:checked')).toHaveValue(type); }
