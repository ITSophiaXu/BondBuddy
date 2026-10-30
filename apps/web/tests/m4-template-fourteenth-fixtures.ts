import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';
import { M4TemplateCreateRequestSchema, type M4DraftRequest, type M4Template, type M4TemplateCreateRequest } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';
import { fixture as sourceFixture, install as installSourceFixture, mount as mountSourceComponent, materialOf, addMaterial, check, ids, now, mime, hash, pin, pinKey, inputOf } from './m4-upload-thirteenth-fixtures';

// Reuse the frozen public transport/M4 CAS fixture without changing its source. These tests add only the new template contract.
export { ids, now, mime, hash, pin, pinKey, inputOf, addMaterial, requirement, uploads, writes, draftWrites, libraryWrites, legacyCache, choose } from './m4-upload-thirteenth-fixtures';
export const templateFile = { name: '原立项券商专用模板-手机长文件名换行检查.docx', mimeType: mime as Dto<'MaterialResponse'>['media_type'], buffer: Buffer.from('Synthetic exact original initiation template DOCX bytes') };
export function fixture() {
  const state = sourceFixture(), original = materialOf({ name: '原已保存立项模板.docx', mimeType: mime, buffer: Buffer.from('Synthetic previous initiation template') }, 'm4-fourteenth-old-template-material'), selected = addMaterial(state, original, ids.project, true);
  // The template-list contract validates every returned row, including the older unrelated template inherited from the source fixture.
  for (const template of state.workspace.templates) { template.material = structuredClone(selected); template.sha256 = selected.sha256; for (const draft of Object.values(state.workspace.drafts)) if (draft.template?.template_id === template.template_id && draft.template.template_version === template.template_version) draft.template.sha256 = template.sha256; }
  const template: M4Template = { template_id: 'm4-fourteenth-old-template', template_version: 2, sha256: original.sha256, name: original.filename, broker: '合成券商', document_type: 'init', material: selected, owner_scope: 'private', market: 'sse', offering: 'private', status: 'active', created_at: now, retired_at: null };
  state.workspace.templates.push(template); state.workspace.drafts.init.template = { template_id: template.template_id, template_version: template.template_version, sha256: template.sha256 };
  const artifact = { ...structuredClone(state.workspace.artifacts[0]), artifact_id: 'm4-fourteenth-init-edit-base', document_type: 'init' as const, filename: '原已保存立项报告.docx' }; state.workspace.artifacts.push(artifact);
  state.workspace.drafts.init.edit_base = { source_project_id: artifact.source_project_id, artifact_id: artifact.artifact_id, artifact_version: artifact.artifact_version, sha256: artifact.sha256 };
  state.workspace.drafts.init.project_file = { project_id: ids.sourceProject, source_version_id: 'm4-fourteenth-original-source-version', source_selection_revision: 7, expected_file_version_id: 'm4-fourteenth-original-file-version' }; state.projectFileSources.set('m4-fourteenth-original-source-version', state.workspace.drafts.init.source_material!);
  state.workspace.view.selected_document_type = 'init'; state.workspace.view.unsent_context = { ...state.workspace.view.unsent_context, document_type: 'init', draft_version: 3 };
  return { ...state, templateKeys: new Map<string, { request: M4TemplateCreateRequest; template: M4Template }>(), dropTemplate: undefined as 'before' | 'after' | undefined,
    templateGate: undefined as ((request: M4TemplateCreateRequest) => Promise<void>) | undefined, beforeTemplate: undefined as ((request: M4TemplateCreateRequest) => void) | undefined,
    afterTemplate: undefined as ((request: M4TemplateCreateRequest, template: M4Template) => void) | undefined, templateResponse: undefined as ((template: M4Template) => unknown) | undefined };
}
export type State = ReturnType<typeof fixture>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: fixtureBody(route,body) });
function problem(route: Route, status: number, code: Dto<'Error'>['code']) { return json(route, { code, message: `Synthetic ${code}`, retryable: status >= 500, correlation_id: 'm4-fourteenth-trace', field_errors: [] } satisfies Dto<'Error'>, status); }
export async function install(page: Page, state = fixture()) {
  await installSourceFixture(page, state);
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length), method = request.method();
    if (path === '/m4/templates') {
      const body = request.postData() ? fixtureRequest(request) : undefined; state.calls.push({ method, path, search: url.search, ...(body === undefined ? {} : { body }) });
      if (state.owner !== ids.owner) return problem(route, 404, 'NOT_FOUND');
      if (method === 'GET') { expect(url.search).toBe(''); const templates = new Map([...state.workspace.templates, ...[...state.templateKeys.values()].map(value => value.template)].map(value => [`${value.template_id}:${value.template_version}`, value])); return json(route, { templates: [...templates.values()] }); }
      if (method !== 'POST') { state.unexpected.push(`${method} ${path}`); return problem(route, 500, 'DATA_UNAVAILABLE'); }
      check(M4TemplateCreateRequestSchema, body); const sent = body as M4TemplateCreateRequest; if (state.templateGate) await state.templateGate(sent); state.beforeTemplate?.(sent);
      const drop = state.dropTemplate; state.dropTemplate = undefined; if (drop === 'before') return route.abort('connectionreset');
      const old = state.templateKeys.get(sent.creation_request_id);
      // As on the server, original-key idempotency precedes current material/status validation.
      if (old) { if (!isDeepStrictEqual(old.request, sent)) return problem(route, 409, 'IDEMPOTENCY_CONFLICT'); if (drop === 'after') return route.abort('connectionreset'); return json(route, { template: state.templateResponse?.(structuredClone(old.template)) ?? old.template }); }
      const material = state.materials.get(pinKey(sent.material)); if (!material) return problem(route, 404, 'NOT_FOUND');
      if (material.media_type !== mime || !sent.broker.trim() || sent.document_type !== 'init' || sent.replaces_template_id !== undefined) return problem(route, 422, 'VALIDATION_FAILED');
      const market = sent.market ?? state.workspace.project.market, offering = sent.offering ?? 'private'; if (!['sse', 'szse'].includes(market ?? '') || offering !== 'private') return problem(route, 422, 'VALIDATION_FAILED');
      const template: M4Template = { template_id: `m4-fourteenth-template-${state.templateKeys.size + 1}`, template_version: 1, sha256: material.sha256, name: sent.name, broker: sent.broker.trim(), document_type: sent.document_type, material: structuredClone(sent.material), owner_scope: 'private', market: market as M4Template['market'], offering, status: 'active', created_at: now, retired_at: null };
      state.templateKeys.set(sent.creation_request_id, { request: structuredClone(sent), template }); state.workspace.templates.push(template); state.afterTemplate?.(sent, template);
      if (drop === 'after') return route.abort('connectionreset'); return json(route, { template: state.templateResponse?.(structuredClone(template)) ?? template }, 201);
    }
    if (method === 'PUT' && path === `/m4/topics/${ids.topic}/drafts/init`) {
      const sent = fixtureRequest(request) as M4DraftRequest, ref = sent.input.template;
      if (ref) { const template = state.workspace.templates.find(value => value.template_id === ref.template_id && value.template_version === ref.template_version && value.sha256 === ref.sha256 && value.document_type === 'init' && value.status === 'active'); if (!template || !state.materials.has(pinKey(template.material))) { state.calls.push({ method, path, search: url.search, body: sent }); return problem(route, 422, 'VALIDATION_FAILED'); } }
    }
    return route.fallback();
  });
  return state;
}
export const mount = mountSourceComponent;
export const templatePosts = (state: State) => state.calls.filter(call => call.method === 'POST' && call.path === '/m4/templates').map(call => call.body as M4TemplateCreateRequest);
export function noBusiness(state: State) { expect(state.calls.filter(call => call.method !== 'GET' && /\/(?:messages|quote|execute|handoffs(?:\/bind)?)$/.test(call.path))).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]); }
export const recovery = (page: Page) => page.locator('[data-m4-template-recovery-id]').first();
export const resume = (page: Page) => recovery(page).locator('[data-m4-template-recovery-action=resume]');
export const select = (page: Page) => page.locator('[data-m4-upload=template]').setInputFiles(templateFile);
export async function records(page: Page) { return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bb-m4-template-upload-v1:')).map(key => ({ key, raw: localStorage.getItem(key)!, value: JSON.parse(localStorage.getItem(key)!) }))); }
export async function settle(page: Page) { await expect.poll(() => page.evaluate(async () => { const component = (window as unknown as { m4Component: { refreshing?: unknown; uploadReading: boolean; uploadPreparing: boolean; uploading: boolean; cacheQueue: Promise<void> } }).m4Component; if (component.refreshing || component.uploadReading || component.uploadPreparing || component.uploading) return false; const queue = component.cacheQueue; await queue; return !component.refreshing && !component.uploadReading && !component.uploadPreparing && !component.uploading && component.cacheQueue === queue; })).toBe(true); }
export async function refreshReadOnly(page: Page, state: State) { const before = state.calls.filter(call => call.method !== 'GET').length; await mount(page, { navigation: 'reload' }); await page.clock.runFor(1_000); await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }); await page.clock.runFor(1_000); await settle(page); expect(state.calls.filter(call => call.method !== 'GET')).toHaveLength(before); noBusiness(state); return before; }
export async function pending(page: Page, state: State) { await select(page); await expect(resume(page)).toBeEnabled(); expect(await records(page)).toHaveLength(1); noBusiness(state); }
export async function saved(page: Page, state: State, settlePage = true) { await expect.poll(() => templatePosts(state).length).toBeGreaterThan(0); await expect.poll(async () => (await records(page)).length).toBe(0); if (settlePage) await settle(page); noBusiness(state); }
