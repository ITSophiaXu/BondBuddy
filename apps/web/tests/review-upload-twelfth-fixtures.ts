import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { FormatRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { schemas, ReviewDraftInputSchema, ReviewDraftRequestSchema, isReviewReport,
  type ReviewDraftInput, type ReviewDraftRequest, type ReviewReport, type ReviewWorkspace } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';

export const ids = { owner: 'review-twelfth-owner', otherOwner: 'review-twelfth-owner-b', project: 'review-twelfth-project', report: 'review-twelfth-report-1', otherReport: 'review-twelfth-report-2', finding: 'same-public-finding' };
export const now = '2026-10-25T12:00:00Z', mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const file = { name: '原现金流补证-手机长文件名换行检查.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic review twelfth evidence\n%%EOF') };
export const secondFile = { name: '第二份附注.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic second ordered evidence\n%%EOF') };
export const pin = (material: Dto<'MaterialResponse'>) => ({ material_id: material.material_id, material_version: material.material_version, sha256: material.sha256 });
export const inputOf = (draft: ReviewWorkspace['draft']): ReviewDraftInput => { const { version: _version, ...input } = draft; return structuredClone(input); };
FormatRegistry.Set('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export function check(schema: TSchema, value: unknown) { expect(Value.Check(schema, value), JSON.stringify([...Value.Errors(schema, value)])).toBe(true); }
export type Call = { method: string; path: string; search: string; body?: unknown };
type Upload = { declaration: Dto<'UploadCreateRequest'>; received: boolean; material?: Dto<'MaterialResponse'>; confirmationFailures?: number };
export function fixture() {
  const source: Dto<'MaterialResponse'> = { material_id: 'review-twelfth-source', material_version: 1, upload_id: 'original-source-upload', filename: '合成原募集书.docx', media_type: mime, byte_size: 37, sha256: hash('Synthetic original source'), role: 'historical', state: 'persisted', persisted_at: now, error: null };
  const oldEvidence: Dto<'MaterialResponse'> = { ...source, material_id: 'review-twelfth-old-evidence', upload_id: 'original-evidence-upload', filename: '原已保存证据.pdf', media_type: 'application/pdf', byte_size: 29, sha256: hash('Synthetic old evidence'), role: 'audit' };
  const report = (report_id: string, version: number): ReviewReport => ({ report_id, project_id: ids.project, run_id: `review-twelfth-run-${version}`, input_revision: 2, version, source_material: pin(source), scope: { mode: 'full_review', finding_ids: [] }, findings: [{
    finding_id: ids.finding, report_id, dimension: 'financial', conclusion: 'needs_evidence', severity: 'P2', title: `R${version} 原现金流口径待补证`, description: `报告 R${version} 需要同口径现金流附注。`, target_refs: [{ material_id: source.material_id, material_version: 1, material_sha256: source.sha256, parse_snapshot_id: 'review-twelfth-parse', parse_response_sha256: hash('parse'), record_id: 'review-twelfth-record', record_sha256: hash('source record'), locator_type: 'docx_block', locator: { paragraph: 12 }, quote: '合成现金流原文', extraction_method: 'native_text', uncertainty: [] }], evidence_refs: [], suggested_change: '补充原报告要求的附注后重新核验。', limitations: ['合成测试，不代表专业复核。'], repairability: { can_revise: false, reason: '缺少同口径证据。', allowed_record_ids: [] }, origin_report_id: report_id, check_status: 'rechecked' }], coverage: [], limitations: [], created_at: now });
  const reports = new Map([[ids.report, report(ids.report, 1)], [ids.otherReport, report(ids.otherReport, 2)]]); reports.forEach(value => expect(isReviewReport(value)).toBe(true));
  const draft: ReviewWorkspace['draft'] = { version: 3, source_material_ref: pin(source), material_versions: [pin(source), pin(oldEvidence)], requirements: ['保留原已保存要求。', '保持金额单位与统计口径。'], as_of: '2026-09-30', evidence_links: [{ report_id: ids.otherReport, finding_id: ids.finding, material_ref: pin(oldEvidence) }] };
  return { owner: ids.owner as string, project: { project_id: ids.project, name: '合成复核上传恢复项目', kind: 'review', issuer_name: '合成发行人', market: 'sse', offering: 'private', draft_revision: 1, input_revision: 2, input_hash: hash('original review input'), updated_at: now } as ReviewWorkspace['project'], draft, reports,
    materials: new Map([[source.material_id, source], [oldEvidence.material_id, oldEvidence]]), uploads: new Map<string, Upload>(), missingUploads: new Set<string>(), calls: [] as Call[], errors: [] as string[], unexpected: [] as string[],
    unavailableReports: new Set<string>(), dropPut: undefined as 'before' | 'after' | undefined, dropComplete: false, dropCompleteAt: 0,
    dropDraft: undefined as 'before' | 'after' | undefined, failDraftReads: false, afterDraft: undefined as ((request: Extract<ReviewDraftRequest, { kind: 'input' }>) => void) | undefined,
    completeGate: undefined as (() => Promise<void>) | undefined, draftGate: undefined as (() => Promise<void>) | undefined,
    dedupMaterial: undefined as Dto<'MaterialResponse'> | undefined };
}
export type State = ReturnType<typeof fixture>;
function workspace(state: State, requested: string | null): ReviewWorkspace {
  const selected = state.reports.get(requested ?? ids.report) ?? null;
  const value: ReviewWorkspace = { project: state.project, materials: [...state.materials.values()], draft: structuredClone(state.draft), message_drafts: [], active_run: null, selected_report: selected,
    reports: [...state.reports.values()].map(report => ({ report_id: report.report_id, run_id: report.run_id, version: report.version, created_at: now })), messages: [], plan: null, artifacts: [] };
  check(schemas.ProjectResponse, value.project); check(ReviewDraftInputSchema, inputOf(value.draft)); value.materials.forEach(material => check(schemas.MaterialResponse, material));
  if (selected) expect(isReviewReport(selected)).toBe(true); return value;
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: fixtureBody(route,body) });
function problem(route: Route, status: number, code: Dto<'Error'>['code']) { const body: Dto<'Error'> = { code, message: `Synthetic ${code}`, retryable: status >= 500, correlation_id: 'review-twelfth-trace', field_errors: [] }; check(schemas.Error, body); return json(route, body, status); }
export async function install(page: Page, state = fixture()) {
  page.on('pageerror', error => state.errors.push(error.message)); await page.clock.install({ time: new Date(now) });
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length), method = request.method(), isBytes = path.endsWith('/bytes');
    const body = request.postData() && !isBytes ? fixtureRequest(request) : undefined; state.calls.push({ method, path, search: url.search, ...(body === undefined ? {} : { body }) });
    if (state.owner !== ids.owner) return problem(route, 404, 'NOT_FOUND');
    if (method === 'GET') {
      if (path === `/projects/${ids.project}`) return json(route, state.project);
      if (path === `/projects/${ids.project}/review-workspace`) { const report = url.searchParams.get('report_id'); if (report && state.unavailableReports.has(report)) return problem(route, 404, 'NOT_FOUND'); return json(route, workspace(state, report)); }
      if (path === `/projects/${ids.project}/review-draft`) { if (state.failDraftReads) return problem(route, 503, 'DATA_UNAVAILABLE'); check(ReviewDraftInputSchema, inputOf(state.draft)); return json(route, { draft: state.draft, message_drafts: [] }); }
      if (path === `/projects/${ids.project}/review-history`) return json(route, { items: [] });
      if (path === `/projects/${ids.project}/prospectus-versions`) { const value: Dto<'ProspectusVersionsResponse'> = { project_id: ids.project, current_version_id: null, selection_revision: 0, inactive_material_ids: [], versions: [] }; check(schemas.ProspectusVersionsResponse, value); return json(route, value); }
      const material = path.match(new RegExp(`^/projects/${ids.project}/materials/([^/]+)$`));
      if (material) { const saved = state.materials.get(material[1]); if (!saved) return problem(route, 404, 'NOT_FOUND'); if (url.searchParams.has('version')) expect(Number(url.searchParams.get('version'))).toBe(saved.material_version); check(schemas.MaterialResponse, saved); return json(route, saved); }
    }
    if (method === 'POST' && path === `/projects/${ids.project}/materials/uploads`) {
      check(schemas.UploadCreateRequest, body); const id = `review-twelfth-U-${state.uploads.size + 1}`; state.uploads.set(id, { declaration: structuredClone(body), received: false });
      const value: Dto<'UploadSessionResponse'> = { upload_id: id, state: 'uploading', upload_url: `/api/v1/projects/${ids.project}/materials/uploads/${id}/bytes`, expires_at: '2099-01-01T00:00:00Z', max_bytes: 104857600 }; check(schemas.UploadSessionResponse, value); return json(route, value, 201);
    }
    const transfer = path.match(new RegExp(`^/projects/${ids.project}/materials/uploads/([^/]+)/(bytes|complete)$`));
    if (transfer) {
      const saved = state.uploads.get(transfer[1]); if (!saved || state.missingUploads.has(transfer[1])) return problem(route, 404, 'NOT_FOUND');
      if (method === 'PUT' && transfer[2] === 'bytes') {
        const bytes = request.postDataBuffer()!; expect(bytes.length).toBe(saved.declaration.byte_size); expect(hash(bytes)).toBe(saved.declaration.sha256);
        const drop = state.dropPut; state.dropPut = undefined; if (drop === 'before') return route.abort('connectionreset'); saved.received = true;
        // One lost PUT acknowledgement is automatically reconciled. Keep its
        // confirmation unavailable through all four attempts to exercise manual recovery.
        if (drop === 'after') { saved.confirmationFailures = 4; return route.abort('connectionreset'); }
        return route.fulfill({ status: 204 });
      }
      if (method === 'POST' && transfer[2] === 'complete') {
        check(schemas.UploadCompleteRequest, body); expect(body).toEqual({ byte_size: saved.declaration.byte_size, sha256: saved.declaration.sha256 }); if (!saved.received) return problem(route, 422, 'MATERIAL_UNREADABLE');
        if (saved.confirmationFailures) { saved.confirmationFailures--; return problem(route, 503, 'DATA_UNAVAILABLE'); }
        if (!saved.material) { saved.material = state.dedupMaterial ?? { ...saved.declaration, material_id: 'material-' + transfer[1], material_version: 1, upload_id: transfer[1], state: 'persisted', persisted_at: now, error: null }; state.materials.set(saved.material.material_id, saved.material); }
        if (state.completeGate) await state.completeGate();
        const failedFile = [file, secondFile][state.dropCompleteAt - 1];
        if (state.dropComplete || failedFile && saved.declaration.filename === failedFile.name && saved.declaration.sha256 === hash(failedFile.buffer)) {
          state.dropComplete = false; state.dropCompleteAt = 0; saved.confirmationFailures = 3; return route.abort('connectionreset');
        }
        check(schemas.MaterialResponse, saved.material); return json(route, saved.material);
      }
    }
    if (method === 'PUT' && path === `/projects/${ids.project}/review-draft`) {
      check(ReviewDraftRequestSchema, body); if (body.kind !== 'input') throw new Error('Upload fixture permits only full input draft adoption.');
      if (state.draftGate) await state.draftGate(); const drop = state.dropDraft; state.dropDraft = undefined;
      if (drop === 'before') { state.afterDraft?.(body); return route.abort('connectionreset'); }
      if (body.expected_version !== state.draft.version) return problem(route, 409, 'INPUT_REVISION_CONFLICT');
      expect(new Set(body.input.material_versions.map((pin: { material_id: string }) => pin.material_id)).size).toBe(body.input.material_versions.length);
      for (const selected of body.input.material_versions) { const material = state.materials.get(selected.material_id); expect(material && pin(material)).toEqual(selected); }
      for (const link of body.input.evidence_links ?? []) { const report = state.reports.get(link.report_id); expect(report?.findings.some(finding => finding.finding_id === link.finding_id)).toBe(true); expect(body.input.material_versions).toContainEqual(link.material_ref); }
      if (body.input.source_material_ref) expect(body.input.material_versions).toContainEqual(body.input.source_material_ref);
      state.draft = { ...structuredClone(body.input), version: body.expected_version + 1 }; state.afterDraft?.(body); if (drop === 'after') return route.abort('connectionreset'); return json(route, { draft: state.draft, message_drafts: [] });
    }
    state.unexpected.push(method + ' ' + path); return problem(route, 500, 'DATA_UNAVAILABLE');
  });
  await page.route(new URL('/', process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173').href, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div class="prototype-app"><main class="shell"></main></div></body></html>' })); return state;
}
export async function mount(page: Page, options: { navigation?: 'initial' | 'reload' | 'same-page'; report?: string; tab?: 'materials' | 'results'; owner?: string } = {}) {
  if (options.navigation === 'reload') await page.reload(); else if (options.navigation !== 'same-page') await page.goto('/');
  await page.evaluate(async options => {
    const w = window as unknown as { reviewComponent?: { dispose(): void }; reviewOwner?: string };
    w.reviewComponent?.dispose(); w.reviewOwner = options.owner;
    const path = '/src/review-workspace.ts', apiPath = '/src/api.ts', { ReviewWorkspace } = await import(path), { ApiClient } = await import(apiPath);
    const component = new ReviewWorkspace(new ApiClient(), options.owner, options.project, (html: string) => { document.querySelector('.shell')!.innerHTML = html; }, () => w.reviewOwner === options.owner, options.report, options.tab);
    w.reviewComponent = component; await component.render();
  }, { owner: options.owner ?? ids.owner, project: ids.project, report: options.report ?? ids.report, tab: options.tab ?? 'materials' });
  for (const path of ['src/style.css', '../../product-prototype/public/styles.css', '../../product-prototype/public/source-prospectus.css', '../../product-prototype/public/project-workspace.css', 'src/prototype-adapter.css']) await page.addStyleTag({ content: (await readFile(resolve(process.cwd(), path), 'utf8')).replace(/@import\s+[^;]+;/g, '') });
  if ((options.owner ?? ids.owner) === ids.owner) await expect(page.locator('#review-upload-groups')).toBeAttached();
}
export const writes = (state: State) => state.calls.filter(call => call.method !== 'GET');
export const uploads = (state: State, kind: 'create' | 'bytes' | 'complete') => state.calls.filter(call => kind === 'create' ? call.method === 'POST' && /\/materials\/uploads$/.test(call.path) : kind === 'bytes' ? call.method === 'PUT' && call.path.endsWith('/bytes') : call.method === 'POST' && call.path.endsWith('/complete'));
export const draftWrites = (state: State) => state.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/review-draft')).map(call => call.body as Extract<ReviewDraftRequest, { kind: 'input' }>);
export function noBusiness(state: State) { expect(state.calls.filter(call => call.method !== 'GET' && /\/(?:revision-plan|review-executions(?:\/quote)?|review-updates(?:\/quote)?|review-messages|review-proposal-adoptions)$/.test(call.path))).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]); }
export const recovery = (page: Page, filename = file.name) => page.locator('[data-review-recovery-id]').filter({ hasText: filename }).first();
export async function records(page: Page) { return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bb-review-upload-v1:')).map(key => ({ key, raw: localStorage.getItem(key)!, value: JSON.parse(localStorage.getItem(key)!) }))); }
export async function selectEvidence(page: Page, selectedFile: typeof file | typeof file[] = file) {
  await page.locator('#review-tab-results').click(); const finding = page.locator(`[data-finding-id="${ids.finding}"]`); await finding.locator('summary').click(); await finding.locator('[data-review-action=evidence]').click();
  await expect(page.getByRole('dialog', { name: '为此问题补充材料' })).toBeVisible(); await page.locator('#review-upload-role').selectOption('other'); await page.locator('#review-upload-file').setInputFiles(selectedFile);
}
