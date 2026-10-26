import { expect, type Page, type Route } from '@playwright/test';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { emptyUpdateDetails, schemas, type UploadInspectionPublicReason } from '@bondbuddy/contracts';
import type { Dto } from '../src/api';

// HTTP/browser acceptance fixtures, not live Blob inspection, parsing or generation.
// Read-only source base (after Round 9), develop ffd637fac6c1fdf1581112e728f21ec29a94c67c:
// main.ts 40A414DDCF1C9506674C6D11884B17A03792C6895CFCEEBEFB2F3E2BCBA673FD
// api.ts 25238FDCB47DADEE305C8C58ADDFD12DF90DA0675409273213C820BA19B7EC6E
// contracts/index.ts CB1BA36767C981B9D763A6BC34BCF28CB692541AABD8DD10E9D80CF8C5C4CC2D
// Existing upload.spec.ts remains untouched and is not imported for its private fixture.
export const now = '2026-10-25T09:00:00Z';
export const ids = { owner: 'upload-recovery-owner-a', otherOwner: 'upload-recovery-owner-b',
  project: 'upload-recovery-project-a', sibling: 'upload-recovery-project-a2', otherProject: 'upload-recovery-project-b' };
export const secretUrlToken = 'SYNTHETIC_UPLOAD_URL_MUST_NOT_BE_PERSISTED';
export type Material = Dto<'MaterialResponse'>;
export type Declaration = Dto<'UploadCreateRequest'>;
export type FilePayload = { name: string; mimeType: string; buffer: Buffer };
export type Call = { page: string; owner: string | null; method: string; path: string; search?: string; body?: unknown };
export type Upload = { id: string; owner: string; project: string; declaration: Declaration; expiresAt: string;
  state: 'uploading' | 'received' | 'completed'; bytes?: Buffer; materialId?: string };
type StoredMaterial = { owner: string; project: string; material: Material };
export type ReceiptFault = 'role' | 'media' | 'size' | 'hash' | 'schema' | 'state';
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const pdf = (name = '原审计报告.pdf', text = 'original recovery evidence A'): FilePayload =>
  ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.7\nSynthetic ${text}\n%%EOF`) });
FormatRegistry.Set('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export function checked<K extends keyof typeof schemas>(name: K, body: unknown): asserts body is Dto<K> {
  expect(Value.Check(schemas[name], body), `${name}: ${JSON.stringify([...Value.Errors(schemas[name], body)])}`).toBe(true);
}
function project(id: string): Dto<'ProjectResponse'> {
  return { project_id: id, draft_revision: 1, input_revision: null, input_hash: null, name: `合成上传恢复项目 ${id}`,
    kind: 'update', issuer_name: '合成上传恢复发行人有限公司', market: 'sse', offering: 'private', updated_at: now,
    update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', source_prospectuses: [] } };
}
export function fixture() {
  return { owner: ids.owner as string | null, clock: Date.parse(now), sequence: 0, pages: 0,
    projects: new Map([[ids.project, { owner: ids.owner, dto: project(ids.project) }],
      [ids.sibling, { owner: ids.owner, dto: project(ids.sibling) }], [ids.otherProject, { owner: ids.otherOwner, dto: project(ids.otherProject) }]]),
    uploads: new Map<string, Upload>(), materials: new Map<string, StoredMaterial>(), calls: [] as Call[],
    unexpected: [] as string[], errors: [] as string[], dropPutReplies: 0, dropBeforeReceive: 0, dropCompleteReplies: 0,
    completeUnavailable: false, blockAfterCompleteDrop: false, discoveryUnavailable: false, inspectionReason: undefined as UploadInspectionPublicReason | undefined,
    receiptFault: undefined as ReceiptFault | undefined, completeGate: undefined as ((upload: Upload) => Promise<void>) | undefined,
    putGate: undefined as ((upload: Upload) => Promise<void>) | undefined,
    createGate: undefined as ((upload: Upload) => Promise<void>) | undefined,
    activeCompletes: 0, maxActiveCompletes: 0 };
}
export type State = ReturnType<typeof fixture>;
export const calls = (state: State, kind: 'create' | 'put' | 'complete') => state.calls.filter(call =>
  kind === 'create' ? call.method === 'POST' && /\/materials\/uploads$/.test(call.path)
    : kind === 'put' ? call.method === 'PUT' && /\/bytes$/.test(call.path)
    : call.method === 'POST' && /\/complete$/.test(call.path));
export const writes = (state: State) => state.calls.filter(call => call.method !== 'GET');
export const latestUpload = (state: State) => [...state.uploads.values()].at(-1)!;
export function seedMaterial(state: State, file: FilePayload, options: { project?: string; owner?: string; role?: Declaration['role']; filename?: string; uploadId?: string } = {}) {
  const id = `recovery-seeded-${++state.sequence}`;
  const material: Material = { material_id: id, material_version: 1, upload_id: options.uploadId ?? `prior-upload-${id}`,
    role: options.role ?? 'audit', filename: options.filename ?? file.name, media_type: file.mimeType as Material['media_type'],
    byte_size: file.buffer.length, sha256: hash(file.buffer), state: 'persisted', persisted_at: now, error: null };
  checked('MaterialResponse', material);
  state.materials.set(id, { owner: options.owner ?? ids.owner, project: options.project ?? ids.project, material });
  return material;
}
async function reply<K extends keyof typeof schemas>(route: Route, name: K, body: Dto<K>, status = 200) {
  checked(name, body); return route.fulfill({ status, json: body });
}
function problem(route: Route, status: number, code: Dto<'Error'>['code'], reason?: UploadInspectionPublicReason) {
  return reply(route, 'Error', { code, message: `Synthetic ${code}`, retryable: status >= 500,
    correlation_id: reason ? `upload-inspection-${reason}` : 'upload-recovery-correlation',
    field_errors: reason ? [{ field: 'material_upload', code: reason, message: 'Synthetic inspection could not finish' }] : [] }, status);
}
const installed = new WeakMap<Page, State>();
export async function install(page: Page, state = fixture()) {
  installed.set(page, state); const pageId = `tab-${++state.pages}`;
  page.on('pageerror', error => state.errors.push(`${pageId}: ${error.message}`));
  await page.route('**/api/v1/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname.slice('/api/v1'.length), method = req.method();
    const owner = state.owner, body = method !== 'GET' && method !== 'PUT' && req.postData() ? req.postDataJSON() : undefined;
    state.calls.push({ page: pageId, owner, method, path, ...(method === 'GET' && url.search ? { search: url.search } : {}), ...(body === undefined ? {} : { body }) });
    if (method === 'POST' && path === '/auth/login') {
      checked('LoginRequest', body);
      expect(body).toEqual({ username: 'recovery_owner_b', password: 'Synthetic-recovery-owner-b' });
      state.owner = ids.otherOwner;
      return reply(route, 'SessionResponse', { user_id: ids.otherOwner, expires_at: new Date(state.clock + 3600000).toISOString(), session_status: 'active' });
    }
    if (method === 'GET' && path === '/me') return owner ? reply(route, 'MeResponse', { user_id: owner, session_status: 'active' }) : problem(route, 401, 'UNAUTHENTICATED');
    if (method === 'GET' && path === '/auth/recovery/info') return reply(route, 'RecoveryInfoResponse', { enabled: false, support_contact: null, link_minutes: 30 });
    if (!owner) return problem(route, 401, 'UNAUTHENTICATED');
    if (method === 'GET' && path === '/account') return reply(route, 'AccountResponse', { user_id: owner,
      username: owner === ids.owner ? 'recovery_owner_a' : 'recovery_owner_b', phone_masked: null, status: 'active', created_at: now,
      accepted_terms_version: 'v1', current_terms_version: 'v1', password_updated_at: null, self_service_recovery: 'unavailable', support_contact: null });
    if (method === 'GET' && path === '/credits/balance') return reply(route, 'CreditBalanceResponse', { enabled: true, available: 86000, frozen: 0 });
    if (method === 'GET' && path === '/projects') {
      checked('ProjectListQuery', Object.fromEntries(url.searchParams));
      return reply(route, 'ProjectListResponse', { items: [...state.projects.values()].filter(item => item.owner === owner).map(({ dto }) => ({
        project_id: dto.project_id, name: dto.name, draft_revision: dto.draft_revision, kind: dto.kind, updated_at: dto.updated_at,
        issuer_name: dto.issuer_name, market: dto.market, offering: dto.offering, status: 'draft' as const, archived_at: null,
        latest_run: null, latest_artifact: null, file_count: [...state.materials.values()].filter(m => m.owner === owner && m.project === dto.project_id).length
      })), page: { has_more: false, next_cursor: null } });
    }
    const scoped = path.match(/^\/projects\/([^/]+)(.*)$/);
    if (scoped) {
      const [, projectId, suffix] = scoped, p = state.projects.get(projectId);
      if (!p || p.owner !== owner) return problem(route, 404, 'NOT_FOUND');
      if (method === 'GET' && !suffix) return reply(route, 'ProjectResponse', p.dto);
      if (method === 'GET' && suffix === '/tasks') { checked('ProjectTasksQuery', Object.fromEntries(url.searchParams));
        return reply(route, 'ProjectTasksResponse', { project_id: projectId, items: [], page: { has_more: false, next_cursor: null } }); }
      if (method === 'GET' && suffix === '/prospectus-versions') return reply(route, 'ProspectusVersionsResponse', {
        project_id: projectId, current_version_id: null, selection_revision: 0, inactive_material_ids: [], versions: [] });
      if (method === 'GET' && suffix === '/messages') return reply(route, 'ProjectMessagePage', { conversation_id: projectId, items: [],
        project_message_set_ref: { version: 1, message_ids: [], content_sha256: hash('[]') }, has_more: false, next_cursor: null });
      if (method === 'GET' && suffix === '/events') {
        if (state.discoveryUnavailable) return problem(route, 503, 'DATA_UNAVAILABLE');
        const after = Number(url.searchParams.get('after') ?? 0); expect(Number.isInteger(after) && after >= 0).toBe(true);
        expect([...url.searchParams.keys()]).toEqual(['after']);
        return reply(route, 'ProjectEventsResponse', { items: [...state.materials.values()].filter(item => item.owner === owner && item.project === projectId)
          .map(({ material }, index) => ({ event_id: `event-${material.material_id}`, schema_version: 1 as const, trace_id: 'recovery-trace', project_id: projectId,
            seq: index + 1, occurred_at: material.persisted_at, type: 'material.upload_progress' as const,
            payload: { material_id: material.material_id, uploaded_bytes: material.byte_size, total_bytes: material.byte_size } })).filter(item => item.seq > after), next_cursor: null });
      }
      const materialPath = suffix.match(/^\/materials\/([^/]+)$/);
      if (method === 'GET' && materialPath) {
        checked('MaterialVersionQuery', Object.fromEntries(url.searchParams)); const item = state.materials.get(materialPath[1]);
        return item && item.owner === owner && item.project === projectId && (!url.searchParams.has('version') || Number(url.searchParams.get('version')) === item.material.material_version)
          ? reply(route, 'MaterialResponse', item.material) : problem(route, 404, 'NOT_FOUND');
      }
      if (method === 'POST' && suffix === '/materials/uploads') {
        checked('UploadCreateRequest', body); const id = `recovery-upload-${++state.sequence}`;
        const upload: Upload = { id, owner, project: projectId, declaration: structuredClone(body), state: 'uploading', expiresAt: new Date(state.clock + 15 * 60000).toISOString() };
        state.uploads.set(id, upload);
        await state.createGate?.(upload);
        return reply(route, 'UploadSessionResponse', { upload_id: id, state: 'uploading', expires_at: upload.expiresAt, max_bytes: 104857600,
          upload_url: `/api/v1/projects/${projectId}/materials/uploads/${id}/bytes?cap=${secretUrlToken}` }, 201);
      }
      const transfer = suffix.match(/^\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
      if (transfer && (method === 'PUT' && transfer[2] === 'bytes' || method === 'POST' && transfer[2] === 'complete')) {
        const upload = state.uploads.get(transfer[1]);
        if (!upload || upload.owner !== owner || upload.project !== projectId) return problem(route, 404, 'NOT_FOUND');
        if (method === 'PUT') {
          if (upload.state === 'completed' || upload.materialId) return problem(route, 409, 'IDEMPOTENCY_CONFLICT');
          if (state.clock > Date.parse(upload.expiresAt)) return problem(route, 422, 'VALIDATION_FAILED');
          expect(url.searchParams.get('cap'), 'Only the real current in-memory signed URL can transmit bytes.').toBe(secretUrlToken);
          const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
          if (bytes.length !== upload.declaration.byte_size || hash(bytes) !== upload.declaration.sha256) return problem(route, 422, 'MATERIAL_CONTENT_MISMATCH');
          if (state.dropBeforeReceive > 0) { state.dropBeforeReceive--; return route.abort('failed'); }
          upload.bytes = bytes; upload.state = 'received';
          if (state.dropPutReplies > 0) { state.dropPutReplies--; return route.abort('failed'); }
          await state.putGate?.(upload);
          return route.fulfill({ status: 204 });
        }
        checked('UploadCompleteRequest', body);
        if (body.byte_size !== upload.declaration.byte_size || body.sha256 !== upload.declaration.sha256) return problem(route, 409, 'IDEMPOTENCY_CONFLICT');
        if (state.completeUnavailable) return problem(route, 503, 'DATA_UNAVAILABLE');
        if (upload.state === 'uploading') return problem(route, 422, 'MATERIAL_UNREADABLE');
        if (state.inspectionReason) return problem(route, 422, 'MATERIAL_UNREADABLE', state.inspectionReason);
        state.activeCompletes++; state.maxActiveCompletes = Math.max(state.maxActiveCompletes, state.activeCompletes);
        try {
          await state.completeGate?.(upload);
          const d = upload.declaration;
          const existing = upload.materialId ? state.materials.get(upload.materialId) : [...state.materials.values()].find(item => item.owner === owner && item.project === projectId &&
            item.material.role === d.role && item.material.sha256 === d.sha256 && item.material.byte_size === d.byte_size && item.material.media_type === d.media_type);
          const material: Material = existing?.material ?? { material_id: `recovery-material-${++state.sequence}`, material_version: 1, upload_id: upload.id,
            role: d.role, filename: d.filename, media_type: d.media_type, byte_size: d.byte_size, sha256: d.sha256, state: 'persisted', persisted_at: new Date(state.clock).toISOString(), error: null };
          if (state.receiptFault) {
            const malformed: Record<string, unknown> = { ...material };
            if (state.receiptFault === 'role') malformed.role = d.role === 'other' ? 'audit' : 'other';
            if (state.receiptFault === 'media') malformed.media_type = d.media_type === 'text/plain' ? 'application/pdf' : 'text/plain';
            if (state.receiptFault === 'size') malformed.byte_size = d.byte_size + 1;
            if (state.receiptFault === 'hash') malformed.sha256 = 'f'.repeat(64);
            if (state.receiptFault === 'state') malformed.state = 'uploading';
            if (state.receiptFault === 'schema') delete malformed.material_version;
            else checked('MaterialResponse', malformed);
            return route.fulfill({ status: 200, json: malformed });
          }
          state.materials.set(material.material_id, { owner, project: projectId, material }); upload.materialId = material.material_id;
          if (!existing) upload.state = 'completed'; // Reuse has its own receipt, not a new material.
          if (state.dropCompleteReplies > 0) { state.dropCompleteReplies--; if (state.blockAfterCompleteDrop) state.completeUnavailable = true; return route.abort('failed'); }
          return reply(route, 'MaterialResponse', material);
        } finally { state.activeCompletes--; }
      }
    }
    state.unexpected.push(`${method} ${path}`); return problem(route, 500, 'DATA_UNAVAILABLE');
  });
  return state;
}
export async function setup(page: Page, state = fixture(), projectId = ids.project) {
  await install(page, state); await page.goto(`/#/projects/${projectId}`);
  await expect(page.locator('#project-heading')).toBeVisible();
  await expect(page.locator('[data-upload-role="audit"]')).toBeEnabled();
  return state;
}
export function assertFixture(page: Page) {
  const state = installed.get(page); if (!state) return;
  expect(state.unexpected, 'Unknown reads and every business operation outside the real upload protocol are forbidden.').toEqual([]);
  expect(state.errors, 'No unhandled page errors.').toEqual([]);
  expect(writes(state).filter(call => !((call.method === 'POST' && (call.path === '/auth/login' || /\/materials\/uploads(?:\/[^/]+\/complete)?$/.test(call.path))) ||
    call.method === 'PUT' && /\/materials\/uploads\/[^/]+\/bytes$/.test(call.path))), 'Recovery never executes, quotes, adopts, parses, generates or charges.').toEqual([]);
}
