import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { FormatRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { schemas, emptyUpdateDetails, M4_DOCUMENT_TYPES, M4DraftInputSchema, M4MaterialPinSchema, M4ViewStateSchema,
  M4ViewRequestSchema, M4QuoteRequestSchema, M4TemplateCreateRequestSchema, type M4Workspace, type M4Draft,
  type M4MaterialPin, type M4QuoteResponse, type AssistantCard } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';

export const now = '2026-10-25T12:00:00Z', ids = { owner: 'assistant-upload-11th-owner', otherOwner: 'assistant-upload-11th-owner-b', project: 'assistant-upload-11th-actual', scope: 'assistant-upload-11th-topic-project', topic: 'assistant-upload-11th-original-topic', otherTopic: 'assistant-upload-11th-other-topic' };
export const file = { name: '原审计材料-长文件名用于手机换行检查.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic assistant recovery evidence\n%%EOF') };
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sha = 'a'.repeat(64), prefix = '/api/v1';
FormatRegistry.Set('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export function check(schema: TSchema, value: unknown) { expect(Value.Check(schema, value), JSON.stringify([...Value.Errors(schema, value)])).toBe(true); }
function project(project_id: string): Dto<'ProjectResponse'> { return { project_id, kind: 'update', name: '合成原项目', issuer_name: '合成发行人', market: 'sse', offering: 'private', draft_revision: 1, input_revision: null, input_hash: null, updated_at: now, update_details: { ...emptyUpdateDetails(), source_prospectuses: [], authoring_mode: 'unified_v1' } }; }
function workspace(topic: string, source: string | null): M4Workspace {
  const drafts = {} as Record<typeof M4_DOCUMENT_TYPES[number], M4Draft>;
  for (const type of M4_DOCUMENT_TYPES) drafts[type] = { document_type: type, version: 0, sha256: sha, updated_at: null, source_material: null, materials: [], template: null, edit_base: null, scope: 'whole', fields: {}, requirements: [] };
  return { topic: { topic_id: topic, project_id: ids.scope, source_project_id: source, name: topic === ids.topic ? '原合成话题' : '另一合成话题', surface: 'assistant', created_at: now, updated_at: now }, project: project(ids.scope),
    drafts, materials: [], material_details: [], templates: [], messages: [], tasks: [], artifacts: [], pending_requirements: [], active_run: null,
    view: { version: 0, selected_document_type: null, open_tabs: [], active_tab: null, unsent_content: '', unsent_context: { document_type: null, draft_version: 0, source_material: null, citations: [], reading_artifact: null }, assistant: { project_id: source, action: null } } };
}
function checkedWorkspace(value: M4Workspace) {
  check(schemas.ProjectResponse, value.project); const { version, ...view } = value.view; expect(version).toBeGreaterThanOrEqual(0); check(M4ViewStateSchema, view);
  for (const draft of Object.values(value.drafts)) { const { version, sha256, updated_at, ...input } = draft; check(M4DraftInputSchema, input); expect(version).toBeGreaterThanOrEqual(0); expect(sha256).toMatch(/^[a-f0-9]{64}$/); expect(updated_at === null || typeof updated_at === 'string').toBe(true); }
  for (const pin of value.materials) check(M4MaterialPinSchema, pin);
  return value;
}
type Upload = { declaration: Dto<'UploadCreateRequest'>; project: string; received: boolean; material?: Dto<'MaterialResponse'> };
export type Call = { method: string; path: string; body?: unknown };
export async function assistantFixture(page: Page) {
  const state = { owner: ids.owner as string, calls: [] as Call[], unexpected: [] as string[], errors: [] as string[], cards: [] as AssistantCard[], uploads: new Map<string, Upload>(), materials: new Map<string, { project: string; material: Dto<'MaterialResponse'> }>(),
    work: new Map([[ids.topic, workspace(ids.topic, ids.project)], [ids.otherTopic, workspace(ids.otherTopic, null)], ['assistant-upload-11th-owner-b-topic', workspace('assistant-upload-11th-owner-b-topic', null)]]), dropPut: false, dropComplete: false, dropAssociation: false, templateFailure: false, gate: undefined as (() => Promise<void>) | undefined };
  page.on('pageerror', error => state.errors.push(error.message)); await page.clock.install({ time: new Date(now) });
  const reply = (route: Route, status: number, body: unknown) => route.fulfill({ status, json: fixtureBody(route,body) });
  const problem = (route: Route, status: number, code: Dto<'Error'>['code']) => { const body: Dto<'Error'> = { code, message: 'Synthetic error', retryable: status >= 500, correlation_id: 'assistant-upload-11th-trace', field_errors: [] }; check(schemas.Error, body); return reply(route, status, body); };
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice(prefix.length), method = request.method();
    const body = request.postData() && !path.endsWith('/bytes') ? fixtureRequest(request) : undefined; state.calls.push({ method, path, body });
    const visibleTopic = (topic: string) => state.owner === ids.owner ? topic !== 'assistant-upload-11th-owner-b-topic' : topic === 'assistant-upload-11th-owner-b-topic';
    if (path === '/m4/topics' && method === 'GET') return reply(route, 200, { topics: [...state.work.values()].filter(value => visibleTopic(value.topic.topic_id)).map(value => value.topic) });
    const topic = path.match(/^\/m4\/topics\/([^/]+)\/(workspace|view|materials|quote)$/);
    if (topic) {
      const work = state.work.get(topic[1]); if (!work || !visibleTopic(topic[1])) return problem(route, 404, 'NOT_FOUND');
      if (method === 'GET' && topic[2] === 'workspace') return reply(route, 200, checkedWorkspace(work));
      if (method === 'PUT' && topic[2] === 'view') { check(M4ViewRequestSchema, body); expect(body.expected_version).toBe(work.view.version); work.view = { ...body.view, version: work.view.version + 1 }; return reply(route, 200, { view: work.view }); }
      if (method === 'POST' && topic[2] === 'materials') {
        expect(Object.keys(body)).toEqual(['material']); check(M4MaterialPinSchema, body.material); const pin = body.material as M4MaterialPin, saved = state.materials.get(pin.material_id);
        expect(saved?.project).toBe(pin.source_project_id); expect(saved?.material.material_version).toBe(pin.material_version); expect(saved?.material.sha256).toBe(pin.sha256);
        if (!work.materials.some(item => JSON.stringify(item) === JSON.stringify(pin))) { work.materials.push(pin); work.material_details.push({ ...pin, filename: saved!.material.filename, state: 'persisted', media_type: saved!.material.media_type, role: saved!.material.role }); }
        if (state.dropAssociation) { state.dropAssociation = false; return route.abort('connectionreset'); } return reply(route, 200, { materials: work.materials });
      }
      if (method === 'POST' && topic[2] === 'quote') { check(M4QuoteRequestSchema, body); expect(body.kind).toBe('qa'); const value: M4QuoteResponse = { quote: { quote_id: 'assistant-upload-11th-quote', topic_id: topic[1], input_hash: sha, points: 60, task_type: 'm4_Q01', billing_method: 'fixed', amount_semantics: 'fixed_price', price_version: 'synthetic', reason: 'Synthetic fixed QA', created_at: now, multiplier: 1, expires_at: '2099-01-01T00:00:00Z' }, balance: { available: 10000, frozen: 0 }, shortage: 0 }; return reply(route, 200, value); }
    }
    if (/^\/assistant\/topics\/[^/]+\/cards$/.test(path) && method === 'GET') return reply(route, 200, { cards: state.cards });
    const assistantProject = path.match(/^\/assistant\/projects\/([^/]+)$/);
    if (assistantProject && method === 'GET') { const value = project(assistantProject[1]); check(schemas.ProjectResponse, value); return reply(route, 200, { project: value, materials: [...state.materials.values()].filter(item => item.project === assistantProject[1]).map(item => item.material), results: [] }); }
    const projectRead = path.match(/^\/projects\/([^/]+)$/);
    if (projectRead && method === 'GET') { const value = project(projectRead[1]); check(schemas.ProjectResponse, value); return reply(route, 200, value); }
    const create = path.match(/^\/projects\/([^/]+)\/materials\/uploads$/);
    if (create && method === 'POST') { check(schemas.UploadCreateRequest, body); const id = `assistant-upload-11th-U-${state.uploads.size + 1}`; state.uploads.set(id, { declaration: body, project: create[1], received: false }); const value: Dto<'UploadSessionResponse'> = { upload_id: id, state: 'uploading', upload_url: `${prefix}${path}/${id}/bytes`, expires_at: '2099-01-01T00:00:00Z', max_bytes: 104857600 }; check(schemas.UploadSessionResponse, value); return reply(route, 201, value); }
    const transfer = path.match(/^\/projects\/([^/]+)\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
    if (transfer) {
      const upload = state.uploads.get(transfer[2]); if (!upload || upload.project !== transfer[1]) return problem(route, 404, 'NOT_FOUND');
      if (method === 'PUT' && transfer[3] === 'bytes') { const bytes = request.postDataBuffer()!; expect(bytes.length).toBe(upload.declaration.byte_size); expect(hash(bytes)).toBe(upload.declaration.sha256); upload.received = true; if (state.dropPut) { state.dropPut = false; return route.abort('connectionreset'); } return route.fulfill({ status: 204 }); }
      if (method === 'POST' && transfer[3] === 'complete') {
        check(schemas.UploadCompleteRequest, body); expect(body).toEqual({ byte_size: upload.declaration.byte_size, sha256: upload.declaration.sha256 }); if (!upload.received) return problem(route, 422, 'MATERIAL_UNREADABLE');
        if (!upload.material) { const existing = [...state.materials.values()].find(item => item.project === upload.project && ['role', 'sha256', 'byte_size', 'media_type'].every(key => item.material[key as keyof Dto<'MaterialResponse'>] === upload.declaration[key as keyof Dto<'UploadCreateRequest'>])); upload.material = existing?.material ?? { ...upload.declaration, material_id: 'material-' + transfer[2], material_version: 1, upload_id: transfer[2], state: 'persisted', persisted_at: now, error: null }; state.materials.set(upload.material.material_id, { project: upload.project, material: upload.material }); }
        check(schemas.MaterialResponse, upload.material); if (state.gate) await state.gate();
        if (state.dropComplete) { state.dropComplete = false; return route.abort('connectionreset'); } return reply(route, 200, upload.material);
      }
    }
    const material = path.match(/^\/projects\/([^/]+)\/materials\/([^/]+)$/);
    if (material && method === 'GET') { const saved = state.materials.get(material[2]); if (!saved || saved.project !== material[1]) return problem(route, 404, 'NOT_FOUND'); if (url.searchParams.has('version')) expect(Number(url.searchParams.get('version'))).toBe(saved.material.material_version); check(schemas.MaterialResponse, saved.material); return reply(route, 200, saved.material); }
    if (path === '/m4/templates' && method === 'POST') { check(M4TemplateCreateRequestSchema, body); expect(state.templateFailure).toBe(true); return problem(route, 503, 'DATA_UNAVAILABLE'); }
    state.unexpected.push(method + ' ' + path); return problem(route, 500, 'DATA_UNAVAILABLE');
  });
  await page.route(new URL('/', process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173').href, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div class="prototype-app"><main class="shell"><h1>合成原项目</h1></main></div></body></html>' }));
  return state;
}
export async function mountAssistant(page: Page, options: { owner?: string; navigation?: 'initial' | 'reload' | 'same-page' } = {}) {
  if (options.navigation === 'reload') await page.reload(); else if (options.navigation !== 'same-page') await page.goto('/');
  await page.evaluate(async owner => { const path = '/src/project-assistant.ts', apiPath = '/src/api.ts', { ProjectAssistant } = await import(path), { ApiClient } = await import(apiPath); const component = new ProjectAssistant(new ApiClient(), owner); component.mount(); Object.assign(window, { assistantComponent: component }); }, options.owner ?? ids.owner);
  for (const path of ['src/style.css', '../../product-prototype/public/styles.css', '../../product-prototype/public/source-prospectus.css', '../../product-prototype/public/project-workspace.css', 'src/prototype-adapter.css']) await page.addStyleTag({ content: (await readFile(resolve(process.cwd(), path), 'utf8')).replace(/@import\s+[^;]+;/g, '') });
  await page.getByRole('button', { name: '打开 BondBuddy', exact: true }).click(); await expect(page.locator('[data-composer]')).toBeEnabled();
}
export const uploadCalls = (state: Awaited<ReturnType<typeof assistantFixture>>, method: 'create' | 'put' | 'complete') => state.calls.filter(call => method === 'create' ? call.method === 'POST' && /\/materials\/uploads$/.test(call.path) : method === 'put' ? call.method === 'PUT' && /\/bytes$/.test(call.path) : call.method === 'POST' && /\/complete$/.test(call.path));
export const writes = (state: Awaited<ReturnType<typeof assistantFixture>>) => state.calls.filter(call => call.method !== 'GET');
export function noBusiness(state: Awaited<ReturnType<typeof assistantFixture>>) { expect(state.calls.filter(call => /\/(?:messages|quote|execute|prepare|answer|cards)$/.test(call.path) && call.method !== 'GET')).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]); }
