import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { settleUploadConfirmationFault } from './upload-confirmation-faults';
import { FormatRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UPLOAD_BYTES_PENDING_FIELD_ERROR, schemas, emptyUpdateDetails, M4_DOCUMENT_TYPES, M4DraftInputSchema, M4MaterialPinSchema, M4ViewStateSchema, M4ViewRequestSchema,
  M4TemplateCreateRequestSchema, QaWorkspaceSchema, PROJECT_QA_PRICE, type M4Workspace, type M4ViewState, type M4Template,
  type M4TemplateCreateRequest, type M4ViewRequest, type M4MaterialPin, type M4ArtifactPin, type AssistantCard, type QaWorkspace } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';

export const now = '2026-10-25T12:00:00Z', ids = { owner: 'assistant-template-15-owner', otherOwner: 'assistant-template-15-owner-b',
  project: 'assistant-template-15-associated', scope: 'assistant-template-15-actual', topic: 'assistant-template-15-original',
  otherTopic: 'assistant-template-15-other', otherScope: 'assistant-template-15-other-scope', card: 'assistant-template-15-card' };
export const templateFile = { name: '原立项券商模板-长文件名用于手机换行核对.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const, buffer: Buffer.from('Synthetic exact original assistant initiation template DOCX bytes') };
export const attachmentFile = { name: '原助手补充资料.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic assistant ordinary material\n%%EOF') };
export const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const pin = (project: string, value: Dto<'MaterialResponse'>): M4MaterialPin => ({ source_project_id: project, material_id: value.material_id, material_version: value.material_version, sha256: value.sha256 });
export const pinKey = (value: M4MaterialPin) => [value.source_project_id, value.material_id, value.material_version, value.sha256].join(':');
export const viewOf = (work: M4Workspace): M4ViewState => { const { version, ...value } = work.view; return structuredClone(value); };
FormatRegistry.Set('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export function check(schema: TSchema, value: unknown) { expect(Value.Check(schema, value), JSON.stringify([...Value.Errors(schema, value)])).toBe(true); }
function project(project_id: string): Dto<'ProjectResponse'> { return { project_id, kind: 'generation', name: '原关联项目（不是模板上传目标）', issuer_name: '合成发行人有限公司', market: 'sse', offering: 'private', draft_revision: 3, input_revision: null, input_hash: null, updated_at: now, update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', source_prospectuses: [] } }; }
export function material(id: string, filename: string, role: Dto<'MaterialResponse'>['role'], media_type: Dto<'MaterialResponse'>['media_type']): Dto<'MaterialResponse'> { return { material_id: id, material_version: 2, upload_id: 'prior-' + id, filename, role, media_type, byte_size: 32, sha256: hash(id), state: 'persisted', persisted_at: now, error: null }; }
const source = material('assistant-template-15-source', '原已保存募集书.docx', 'historical', templateFile.mimeType);
const oldTemplateMaterial = material('assistant-template-15-template', '原已保存立项模板.docx', 'other', templateFile.mimeType);
export const sourcePin = pin(ids.project, source), oldTemplatePin = pin(ids.scope, oldTemplateMaterial);
export const artifactPin: M4ArtifactPin = { source_project_id: ids.project, artifact_id: 'assistant-template-15-artifact', artifact_version: 2, sha256: hash('Original exact delivered artifact') };
function workspace(topic: string, scope: string, associated: string | null): M4Workspace {
  const drafts = {} as M4Workspace['drafts']; for (const type of M4_DOCUMENT_TYPES) drafts[type] = { document_type: type, version: 3, sha256: hash(type), updated_at: now, source_material: sourcePin, materials: [sourcePin], template: null, edit_base: null, scope: 'whole', fields: { market: 'sse', offering: 'private' }, requirements: [], supplemental_requirements: '原文种要求必须保留' };
  return { topic: { topic_id: topic, project_id: scope, source_project_id: associated, name: topic === ids.topic ? '原立项工作对话' : '另一工作对话', surface: 'assistant', created_at: now, updated_at: now }, project: project(scope),
    drafts, materials: [sourcePin, oldTemplatePin], material_details: [], templates: [], messages: [], tasks: [], artifacts: [], pending_requirements: [], active_run: null,
    view: { version: 7, assistant: { project_id: associated, action: { business: 'generation', fields: { broker: '合成立项券商', document_type: 'init', market: 'sse', offering: 'private', issuer_name: '原发行人', name: '原材料任务', reporting_cutoff: '2026-09-30' }, requirements: '原立项补充要求，保留数字与格式。' }, template_key: 'assistant-template-15-old-template/2', draft_token: 'assistant-template-15-old-token', prepared_card_id: ids.card,
      source_prospectuses: [{ material_id: source.material_id, material_version: source.material_version, sha256: source.sha256, issuer_name: '原募集书发行人', relation: 'same_issuer', market: 'sse', offering: 'private', reporting_periods: [], status: 'user_asserted' }] },
      selected_document_type: 'legal', open_tabs: [artifactPin], active_tab: artifactPin, unsent_content: '尚未发送的原讨论文字',
      unsent_context: { document_type: null, draft_version: 0, source_material: sourcePin, citations: [{ kind: 'material', ref: sourcePin, locator: '原募集书第3节' }], reading_artifact: artifactPin },
      workspace_tab: 'artifact:original', making_run_ids: ['assistant-template-15-old-run'], tab_scroll: { original: 184 }, quotation: { citation: { kind: 'material', ref: sourcePin, locator: '原募集书第3节' }, original_text: '原文引用内容必须保留', anchor: 'p3' } } };
}
function card(work: M4Workspace): AssistantCard { return { card_id: ids.card, operation: 'generation', project_id: work.topic.project_id, execution_request_id: 'assistant-template-15-old-execution', quote_id: 'assistant-template-15-old-quote', document_type: 'init', expected_draft_version: 3, draft_token: work.view.assistant!.draft_token!, target: { issuer_name: '原发行人', market: 'sse', offering: 'private', reporting_cutoff: '2026-09-30' }, created_at: now, project_name: '原立项任务', requirements: '原立项补充要求', material_names: [source.filename], baseline: artifactPin, quote: null, balance: { available: 50000, frozen: 0 }, run: null }; }
type Upload = { project: string; declaration: Dto<'UploadCreateRequest'>; received: boolean; material?: Dto<'MaterialResponse'> };
export type Call = { owner: string; method: string; path: string; search: string; body?: any };
type Drop = 'before' | 'after' | undefined;
export function fixture() {
  const original = workspace(ids.topic, ids.scope, ids.project), other = workspace(ids.otherTopic, ids.otherScope, null);
  other.view.assistant = { project_id: null, action: null }; other.view.unsent_content = ''; other.materials = [];
  const oldTemplate: M4Template = { template_id: 'assistant-template-15-old-template', template_version: 2, sha256: oldTemplateMaterial.sha256, name: oldTemplateMaterial.filename, broker: '原券商', document_type: 'init', material: oldTemplatePin, owner_scope: 'private', market: 'sse', offering: 'private', status: 'active', created_at: now, retired_at: null };
  const qa: QaWorkspace = { draft: { preparation_id: null, questions: [], materials: [], requirements: '', use_knowledge: true }, revision: 0, runs: [], materials: [], price: PROJECT_QA_PRICE };
  return { owner: ids.owner as string, work: new Map([[ids.topic, original], [ids.otherTopic, other]]), cards: new Map([[ids.topic, [card(original)]], [ids.otherTopic, [] as AssistantCard[]]]),
    templates: [oldTemplate], templateKeys: new Map<string, { request: M4TemplateCreateRequest; template: M4Template }>(), materials: new Map([[pinKey(sourcePin), { project: ids.project, material: source }], [pinKey(oldTemplatePin), { project: ids.scope, material: oldTemplateMaterial }]]),
    uploads: new Map<string, Upload>(), confirmationFaults: new Map<string, number>(), uploadTtlMs: undefined as number | undefined, calls: [] as Call[], errors: [] as string[], unexpected: [] as string[], qa,
    dropPut: undefined as Drop, dropComplete: undefined as Drop, dropMembership: undefined as Drop, dropTemplate: undefined as Drop, dropView: undefined as Drop,
    failWorkspaceReads: false, unavailableTopic: false, dedupMaterial: undefined as Dto<'MaterialResponse'> | undefined,
    completeGate: undefined as (() => Promise<void>) | undefined, membershipGate: undefined as (() => Promise<void>) | undefined, templateGate: undefined as (() => Promise<void>) | undefined, viewGate: undefined as (() => Promise<void>) | undefined,
    afterMembership: undefined as (() => void) | undefined, afterTemplate: undefined as (() => void) | undefined, afterView: undefined as (() => void) | undefined,
    workspaceGate: undefined as ((snapshot: M4Workspace) => Promise<void>) | undefined, workspaceObservation: undefined as ((snapshot: M4Workspace) => M4Workspace) | undefined,
    templateResponse: undefined as ((value: M4Template) => unknown) | undefined, viewResponse: undefined as ((value: M4Workspace['view']) => unknown) | undefined };
}
export type State = ReturnType<typeof fixture>;
export const work = (state: State) => state.work.get(ids.topic)!;
export const writes = (state: State) => state.calls.filter(value => value.method !== 'GET');
export const templatePosts = (state: State) => state.calls.filter(value => value.method === 'POST' && value.path === '/m4/templates').map(value => value.body as M4TemplateCreateRequest);
export const viewWrites = (state: State) => state.calls.filter(value => value.method === 'PUT' && value.path === '/m4/topics/' + ids.topic + '/view').map(value => value.body as M4ViewRequest);
export const memberships = (state: State) => state.calls.filter(value => value.method === 'POST' && /\/m4\/topics\/[^/]+\/materials$/.test(value.path));
export const uploads = (state: State, stage: 'create' | 'bytes' | 'complete') => state.calls.filter(value => stage === 'create' ? value.method === 'POST' && /\/materials\/uploads$/.test(value.path) : value.method === (stage === 'bytes' ? 'PUT' : 'POST') && value.path.endsWith('/' + stage));
export function noBusiness(state: State) { expect(writes(state).filter(value => /\/(?:drafts\/[^/]+|messages|quote|execute|cards|handoffs\/bind|qa\/(?:draft|runs|prepare))$/.test(value.path) || value.path === '/projects' || value.method === 'PATCH')).toEqual([]); expect(writes(state).filter(value => value.path.startsWith('/m4/topics/') && !value.path.startsWith('/m4/topics/' + ids.topic + '/'))).toEqual([]); expect(writes(state).filter(value => value.path.startsWith('/projects/') && !value.path.startsWith('/projects/' + ids.scope + '/materials/uploads'))).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]); }
export async function install(page: Page, state = fixture()) {
  page.on('pageerror', error => state.errors.push(error.message)); await page.clock.install({ time: new Date(now) });
  const reply = (route: Route, status: number, value: unknown) => route.fulfill({ status, json: fixtureBody(route,value) });
  const problem = (route: Route, status: number, code: Dto<'Error'>['code']) => { const value: Dto<'Error'> = { code, message: 'Synthetic assistant template fault', retryable: status >= 500, correlation_id: 'assistant-template-15-trace', field_errors: [] }; check(schemas.Error, value); return reply(route, status, value); };
  const readable = (p: M4MaterialPin) => state.materials.get(pinKey(p));
  const snapshot = (value: M4Workspace) => {
    const result = structuredClone(value); result.materials = result.materials.filter(p => !!readable(p)); result.material_details = result.materials.map(p => { const m = readable(p)!.material; return { ...p, filename: m.filename, state: m.state, media_type: m.media_type, role: m.role }; });
    result.templates = state.templates.filter(t => !!readable(t.material)).map(t => structuredClone(t)); check(M4ViewStateSchema, viewOf(result)); for (const p of result.materials) check(M4MaterialPinSchema, p); return result;
  };
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length), method = request.method(), body = request.postData() && !path.endsWith('/bytes') ? fixtureRequest(request) : undefined;
    state.calls.push({ owner: state.owner, method, path, search: url.search, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (state.owner !== ids.owner) return problem(route, 404, 'NOT_FOUND');
    if (path === '/m4/topics' && method === 'GET') return reply(route, 200, { topics: [...state.work.values()].map(value => value.topic) });
    const topic = path.match(/^\/m4\/topics\/([^/]+)\/(workspace|view|materials)$/);
    if (topic) {
      const original = state.work.get(topic[1]); if (!original || state.unavailableTopic && topic[1] === ids.topic) return problem(route, 404, 'NOT_FOUND');
      if (method === 'GET' && topic[2] === 'workspace') { if (state.failWorkspaceReads) return problem(route, 503, 'DATA_UNAVAILABLE'); let value = snapshot(original); if (state.workspaceObservation) value = state.workspaceObservation(value); await state.workspaceGate?.(value); return reply(route, 200, value); }
      if (method === 'POST' && topic[2] === 'materials') {
        expect(Object.keys(body)).toEqual(['material']); check(M4MaterialPinSchema, body.material); if (!readable(body.material)) return problem(route, 404, 'NOT_FOUND');
        const drop = state.dropMembership; state.dropMembership = undefined; await state.membershipGate?.(); if (drop === 'before') return route.abort('connectionreset');
        if (!original.materials.some(value => pinKey(value) === pinKey(body.material))) original.materials.push(structuredClone(body.material)); state.afterMembership?.();
        if (drop === 'after') return route.abort('connectionreset'); return reply(route, 200, { materials: snapshot(original).materials });
      }
      if (method === 'PUT' && topic[2] === 'view') {
        check(M4ViewRequestSchema, body); const drop = state.dropView; state.dropView = undefined; await state.viewGate?.(); if (drop === 'before') return route.abort('connectionreset');
        if (body.expected_version !== original.view.version) return problem(route, 409, 'INPUT_REVISION_CONFLICT');
        for (const p of [body.view.unsent_context.source_material, ...body.view.unsent_context.citations.filter((c: any) => c.kind === 'material').map((c: any) => c.ref)].filter(Boolean)) if (!readable(p)) return problem(route, 404, 'NOT_FOUND');
        for (const p of [...body.view.open_tabs, body.view.active_tab, body.view.unsent_context.reading_artifact, ...body.view.unsent_context.citations.filter((c: any) => c.kind === 'artifact').map((c: any) => c.ref)].filter(Boolean)) if (!isDeepStrictEqual(p, artifactPin)) return problem(route, 404, 'NOT_FOUND');
        if (body.view.assistant?.project_id && ![ids.project, ids.scope, ids.otherScope].includes(body.view.assistant.project_id)) return problem(route, 404, 'NOT_FOUND');
        // Public view save always increments, including equal content; it does not validate template_key or consume M4 pending requirements.
        original.view = { ...structuredClone(body.view), version: original.view.version + 1 }; state.afterView?.(); if (drop === 'after') return route.abort('connectionreset');
        return reply(route, 200, { view: state.viewResponse ? state.viewResponse(structuredClone(original.view)) : original.view });
      }
    }
    if (path === '/m4/templates' && method === 'GET') return reply(route, 200, { templates: state.templates });
    if (path === '/m4/templates' && method === 'POST') {
      check(M4TemplateCreateRequestSchema, body); const prior = state.templateKeys.get(body.creation_request_id); if (prior) { if (!isDeepStrictEqual(prior.request, body)) return problem(route, 409, 'IDEMPOTENCY_CONFLICT'); return reply(route, 200, { template: state.templateResponse ? state.templateResponse(prior.template) : prior.template }); }
      const drop = state.dropTemplate; state.dropTemplate = undefined; await state.templateGate?.(); if (drop === 'before') return route.abort('connectionreset');
      const saved = readable(body.material); if (!saved) return problem(route, 404, 'NOT_FOUND'); if (saved.material.media_type !== templateFile.mimeType || body.document_type === 'init' && !body.broker.trim()) return problem(route, 422, 'INPUT_REQUIRED');
      const market = body.market ?? 'sse', offering = body.offering ?? 'private'; if (!['sse', 'szse'].includes(market) || offering !== 'private') return problem(route, 422, 'VALIDATION_FAILED');
      expect(body.replaces_template_id).toBeUndefined(); const value: M4Template = { template_id: 'assistant-template-15-created-' + (state.templateKeys.size + 1), template_version: 1, sha256: body.material.sha256, name: body.name, broker: body.broker, document_type: body.document_type, material: structuredClone(body.material), market, offering, owner_scope: 'private', status: 'active', created_at: now, retired_at: null };
      state.templates.push(value); state.templateKeys.set(body.creation_request_id, { request: structuredClone(body), template: value }); state.afterTemplate?.(); if (drop === 'after') return route.abort('connectionreset'); return reply(route, 200, { template: state.templateResponse ? state.templateResponse(value) : value });
    }
    const cards = path.match(/^\/assistant\/topics\/([^/]+)\/cards$/); if (cards && method === 'GET') return reply(route, 200, { cards: state.cards.get(cards[1]) ?? [] });
    const assistantProject = path.match(/^\/assistant\/projects\/([^/]+)$/); if (assistantProject && method === 'GET') return reply(route, 200, { project: project(assistantProject[1]), materials: [...state.materials.values()].filter(value => value.project === assistantProject[1]).map(value => value.material), results: [{ pin: artifactPin, run_id: 'assistant-template-15-delivered', filename: '原已交付成果.docx', label: '原已交付成果', created_at: now }] });
    const projectRead = path.match(/^\/projects\/([^/]+)$/); if (projectRead && method === 'GET') { const value = project(projectRead[1]); check(schemas.ProjectResponse, value); return reply(route, 200, value); }
    if (path === '/projects/' + ids.project + '/qa' && method === 'GET') { check(QaWorkspaceSchema, state.qa); return reply(route, 200, state.qa); }
    const create = path.match(/^\/projects\/([^/]+)\/materials\/uploads$/);
    if (create && method === 'POST') { check(schemas.UploadCreateRequest, body); const id = 'assistant-template-15-U-' + (state.uploads.size + 1); state.uploads.set(id, { project: create[1], declaration: structuredClone(body), received: false }); const value: Dto<'UploadSessionResponse'> = { upload_id: id, state: 'uploading', upload_url: '/api/v1' + path + '/' + id + '/bytes', expires_at: state.uploadTtlMs === undefined ? '2099-01-01T00:00:00Z' : new Date(await page.evaluate(() => Date.now()) + state.uploadTtlMs).toISOString(), max_bytes: 104857600 }; check(schemas.UploadSessionResponse, value); return reply(route, 201, value); }
    const transfer = path.match(/^\/projects\/([^/]+)\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
    if (transfer) {
      const value = state.uploads.get(transfer[2]); if (!value || value.project !== transfer[1]) return problem(route, 404, 'NOT_FOUND');
      if (method === 'PUT' && transfer[3] === 'bytes') { const bytes = request.postDataBuffer()!; expect(bytes.length).toBe(value.declaration.byte_size); expect(hash(bytes)).toBe(value.declaration.sha256); const drop = state.dropPut; state.dropPut = undefined; if (drop === 'before') return route.abort('connectionreset'); value.received = true; if (drop === 'after') { state.confirmationFaults.set(transfer[2], 4); return route.abort('connectionreset'); } return route.fulfill({ status: 204 }); }
      if (method === 'POST' && transfer[3] === 'complete') {
        check(schemas.UploadCompleteRequest, body); expect(body).toEqual({ byte_size: value.declaration.byte_size, sha256: value.declaration.sha256 }); const remaining = state.confirmationFaults.get(transfer[2]) ?? 0; if (remaining) { state.confirmationFaults.set(transfer[2], remaining - 1); return problem(route, 503, 'DATA_UNAVAILABLE'); } const drop = state.dropComplete; state.dropComplete = undefined; await state.completeGate?.(); if (drop === 'before') return route.abort('connectionreset'); if (!value.received) return reply(route, 422, { code: 'MATERIAL_UNREADABLE', message: 'Synthetic original bytes have not arrived', retryable: false, correlation_id: 'missing-original-bytes', field_errors: [{ ...UPLOAD_BYTES_PENDING_FIELD_ERROR, message: 'Upload bytes not received' }] });
        value.material ??= state.dedupMaterial ?? { ...value.declaration, material_id: 'saved-' + transfer[2], material_version: 1, upload_id: transfer[2], state: 'persisted', persisted_at: now, error: null }; check(schemas.MaterialResponse, value.material); state.materials.set(pinKey(pin(value.project, value.material)), { project: value.project, material: value.material }); if (drop === 'after') { state.confirmationFaults.set(transfer[2], 3); return route.abort('connectionreset'); } return reply(route, 200, value.material);
      }
    }
    const read = path.match(/^\/projects\/([^/]+)\/materials\/([^/]+)$/); if (read && method === 'GET') { const version = url.searchParams.get('version'), found = [...state.materials.values()].find(value => value.project === read[1] && value.material.material_id === read[2] && (!version || value.material.material_version === Number(version))); if (!found) return problem(route, 404, 'NOT_FOUND'); check(schemas.MaterialResponse, found.material); return reply(route, 200, found.material); }
    state.unexpected.push(method + ' ' + path); return problem(route, 500, 'DATA_UNAVAILABLE');
  });
  await page.route(new URL('/', process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173').href, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div class="prototype-app"><aside class="sidebar"><nav aria-label="账号"></nav></aside><main class="shell"><h1>原项目工作区</h1></main></div></body></html>' }));
  return state;
}
export async function mount(page: Page, options: { owner?: string; navigation?: 'initial' | 'reload' | 'same-page'; form?: boolean; open?: boolean } = {}) {
  if (options.navigation === 'reload') await page.reload(); else if (options.navigation !== 'same-page') await page.goto('/');
  await page.evaluate(async owner => { const w = window as any; w.assistantComponent?.dispose(); const path = '/src/project-assistant.ts', apiPath = '/src/api.ts', { ProjectAssistant } = await import(path), { ApiClient } = await import(apiPath); w.assistantApi = new ApiClient(); w.assistantComponent = new ProjectAssistant(w.assistantApi, owner); w.assistantComponent.mount(); }, options.owner ?? ids.owner);
  if (options.navigation !== 'same-page') for (const path of ['src/style.css', '../../product-prototype/public/styles.css', '../../product-prototype/public/source-prospectus.css', '../../product-prototype/public/project-workspace.css', 'src/prototype-adapter.css']) await page.addStyleTag({ content: (await readFile(resolve(process.cwd(), path), 'utf8')).replace(/@import\s+[^;]+;/g, '') });
  if (options.open === false) return;
  await page.getByRole('button', { name: '打开 BondBuddy', exact: true }).click(); if ((options.owner ?? ids.owner) !== ids.owner) return;
  await expect(page.locator('[data-composer]')).toBeEnabled(); if (options.form !== false) { await page.locator('[data-a=edit]').first().click(); await expect(page.locator('[data-template-upload]')).toBeAttached(); }
}
export async function mountQa(page: Page) {
  await mount(page, { open: false }); await page.evaluate(async project => { const w = window as any, path = '/src/project-qa-workspace.ts', { ProjectQaWorkspace } = await import(path); location.hash = 'qa?project=' + project; w.qaComponent = new ProjectQaWorkspace(w.assistantApi, (html: string) => { document.querySelector('main')!.innerHTML = html; }, () => true, project, w.assistantComponent.owner); await w.qaComponent.render(); }, ids.project);
  await expect(page.getByRole('heading', { name: '项目问答', exact: true })).toBeVisible(); await page.getByRole('button', { name: '打开 BondBuddy', exact: true }).click(); await expect(page.locator('[data-composer]')).toBeEnabled(); await page.locator('[data-a=edit]').first().click(); await expect(page.locator('[data-template-upload]')).toBeAttached();
}
export const recovery = (page: Page) => page.locator('[data-assistant-template-recovery-id]').first();
export const resume = (page: Page) => recovery(page).locator('[data-assistant-template-recovery-action=resume]');
export const select = (page: Page) => page.locator('[data-template-upload]').setInputFiles(templateFile);
export async function records(page: Page) { return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bb-assistant-template-upload-v1:')).map(key => ({ key, raw: localStorage.getItem(key)!, value: JSON.parse(localStorage.getItem(key)!) }))); }
export async function cache(page: Page) { return page.evaluate(({ owner, scope, topic }) => { const raw = localStorage.getItem('bb-assistant-view-v1:' + [owner, scope, topic].map(encodeURIComponent).join(':')); return raw === null ? null : JSON.parse(raw); }, ids); }
export async function settle(page: Page) { await expect.poll(() => page.evaluate(async () => { const c = (window as any).assistantComponent; if (c.busy || c.templateReading || c.templatePreparing || c.templateUploading) return false; const q = c.cacheQueue; if (q) await q; await Promise.resolve(c.saving).catch(() => {}); return !c.busy && !c.templateReading && !c.templatePreparing && !c.templateUploading && c.cacheQueue === q; })).toBe(true); }
export async function pending(page: Page, state: State) { const confirmationFault = state.dropPut === 'after' || state.dropComplete === 'after', missingBytes = state.dropPut === 'before'; const missingReceipt = missingBytes ? page.waitForResponse(response => response.status() === 422 && response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/complete')) : undefined; await select(page); if (confirmationFault) await settleUploadConfirmationFault(page, state.confirmationFaults); if (missingReceipt) { const response = await missingReceipt; expect((await response.json()).field_errors).toEqual([{ ...UPLOAD_BYTES_PENDING_FIELD_ERROR, message: 'Upload bytes not received' }]); await response.finished(); await page.clock.fastForward(600001); } await expect(resume(page)).toBeEnabled(); await settle(page); expect(await records(page)).toHaveLength(1); noBusiness(state); }
export async function saved(page: Page, state: State) { await expect.poll(() => templatePosts(state).length).toBeGreaterThan(0); await expect.poll(async () => (await records(page)).length).toBe(0); await settle(page); noBusiness(state); }
export async function refreshReadOnly(page: Page, state: State) { const before = writes(state).length; await mount(page, { navigation: 'reload' }); await page.clock.runFor(13000); await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new StorageEvent('storage', { key: null })); }); await page.clock.runFor(1000); await settle(page); expect(writes(state)).toHaveLength(before); noBusiness(state); return before; }
