import { expect, test, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const now = '2026-09-24T12:00:00Z';
const projectId = 'project-synthetic-owner-a';
type Material = { material_id: string; material_version: number; upload_id: string; role: string; filename: string; media_type: string; byte_size: number; sha256: string; state: 'persisted'; persisted_at: string; error: null };
type FixtureState = {
  owner: string | null;
  uploads: Map<string, { owner: string; filename: string; role: string; bytes: number; failedOnce: boolean }>;
  materials: Map<string, Material>;
  sequence: number;
  failNextComplete: Set<string>;
  releaseSlowComplete?: () => void;
  holdNextCreate: boolean;
  releaseCreate?: () => void;
  expireNextBytes: boolean;
  byteAttempts: string[];
  putNames: string[];
};

const json = (route: Route, status: number, value?: unknown) => route.fulfill({ status, contentType: 'application/json', body: value === undefined ? '' : JSON.stringify(value) });
const project = { project_id: projectId, draft_revision: 1, input_revision: null, input_hash: null, name: '合成上传项目', kind: 'update', issuer_name: null, market: null, offering: null, updated_at: now };

async function installApi(page: Page, state: FixtureState) {
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/v1/me' && request.method() === 'GET') {
      return state.owner ? json(route, 200, { user_id: state.owner, session_status: 'active' }) : json(route, 401, { code: 'UNAUTHENTICATED' });
    }
    if (path === '/api/v1/auth/login' && request.method() === 'POST') {
      const body = request.postDataJSON() as { username: string };
      state.owner = `user-${body.username}`;
      await page.context().addCookies([
        { name: 'bb_session', value: state.owner, url: origin, httpOnly: true },
        { name: 'bb_csrf', value: 'synthetic-csrf', url: origin }
      ]);
      return json(route, 200, { user_id: state.owner, session_status: 'active', expires_at: now });
    }
    if (path === '/api/v1/auth/refresh' && request.method() === 'POST') return json(route, 200, { user_id: state.owner, session_status: 'active', expires_at: now });
    if (path === '/api/v1/auth/logout' && request.method() === 'POST') { state.owner = null; return route.fulfill({ status: 204 }); }
    if (path === '/api/v1/projects' && request.method() === 'GET') return json(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    if (path === `/api/v1/projects/${projectId}` && request.method() === 'GET') {
      return state.owner === 'user-owner_a' ? json(route, 200, project) : json(route, 404, { code: 'NOT_FOUND' });
    }
    if (path === `/api/v1/projects/${projectId}/events` && request.method() === 'GET') {
      if (state.owner !== 'user-owner_a') return json(route, 404, { code: 'NOT_FOUND' });
      const after = Number(url.searchParams.get('after') ?? 0);
      const available = [...state.materials.values()].map((material, index) => ({
        event_id: `event-${material.material_id}`, schema_version: 1, trace_id: 'trace-synthetic', project_id: projectId,
        seq: index + 1, occurred_at: material.persisted_at, type: 'material.upload_progress',
        payload: { material_id: material.material_id, uploaded_bytes: material.byte_size, total_bytes: material.byte_size }
      })).filter(item => item.seq > after);
      const items = available.slice(0, 50);
      return json(route, 200, { items, next_cursor: available.length > 50 ? items.at(-1)!.seq : null });
    }
    const materialMatch = path.match(new RegExp(`/api/v1/projects/${projectId}/materials/([^/]+)$`));
    if (materialMatch && request.method() === 'GET') {
      const material = state.materials.get(decodeURIComponent(materialMatch[1]));
      return material && state.owner === 'user-owner_a' ? json(route, 200, material) : json(route, 404, { code: 'NOT_FOUND' });
    }
    const uploadCreate = path === `/api/v1/projects/${projectId}/materials/uploads` && request.method() === 'POST';
    if (uploadCreate) {
      const body = request.postDataJSON() as { filename: string; role: string };
      if (state.holdNextCreate) {
        state.holdNextCreate = false;
        await new Promise<void>(resolve => { state.releaseCreate = resolve; });
      }
      if (state.owner !== 'user-owner_a') return json(route, 404, { code: 'NOT_FOUND' });
      const uploadId = randomUUID();
      state.uploads.set(uploadId, { owner: state.owner, filename: body.filename, role: body.role, bytes: 0, failedOnce: false });
      return json(route, 201, { upload_id: uploadId, state: 'uploading', upload_url: `/api/v1/projects/${projectId}/materials/uploads/${uploadId}/bytes`, expires_at: now, max_bytes: 100_000_000 });
    }
    const bytesMatch = path.match(new RegExp(`/api/v1/projects/${projectId}/materials/uploads/([^/]+)/bytes$`));
    if (bytesMatch && request.method() === 'PUT') {
      const upload = state.uploads.get(decodeURIComponent(bytesMatch[1]));
      if (!upload || upload.owner !== state.owner) return json(route, 404, { code: 'NOT_FOUND' });
      upload.bytes = request.postDataBuffer()?.length ?? 0;
      state.byteAttempts.push(upload.filename);
      if (state.expireNextBytes) { state.expireNextBytes = false; return json(route, 401, { code: 'UNAUTHENTICATED' }); }
      state.putNames.push(upload.filename);
      return route.fulfill({ status: 204 });
    }
    const completeMatch = path.match(new RegExp(`/api/v1/projects/${projectId}/materials/uploads/([^/]+)/complete$`));
    if (completeMatch && request.method() === 'POST') {
      const upload = state.uploads.get(decodeURIComponent(completeMatch[1]));
      if (!upload || upload.owner !== state.owner) return json(route, 404, { code: 'NOT_FOUND' });
      if (state.failNextComplete.has(upload.filename)) {
        state.failNextComplete.delete(upload.filename);
        return json(route, 422, { code: 'MATERIAL_CONTENT_MISMATCH' });
      }
      if (upload.filename === 'slow-save.pdf' && state.releaseSlowComplete === undefined) await new Promise<void>(resolve => { state.releaseSlowComplete = resolve; });
      const body = request.postDataJSON() as { byte_size: number; sha256: string };
      const material: Material = { material_id: randomUUID(), material_version: 1, upload_id: decodeURIComponent(completeMatch[1]), role: upload.role, filename: upload.filename, media_type: 'application/pdf', byte_size: body.byte_size, sha256: body.sha256, state: 'persisted', persisted_at: now, error: null };
      state.materials.set(material.material_id, material);
      state.sequence++;
      return json(route, 200, material);
    }
    return json(route, 404, { code: 'NOT_FOUND' });
  });
}

function state(): FixtureState {
  return { owner: null, uploads: new Map(), materials: new Map(), sequence: 0, failNextComplete: new Set(), holdNextCreate: false, expireNextBytes: false, byteAttempts: [], putNames: [] };
}

async function login(page: Page, username: string, expectProject = true) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录工作区' })).toBeVisible();
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill('Synthetic-password-123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await page.goto(`/#/projects/${projectId}`);
  if (expectProject) {
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '项目材料' })).toBeVisible();
  } else {
    await expect(page.getByText('无法访问这个项目，它可能已移除或不属于当前账号。')).toBeVisible();
  }
}

test('three independent files, 100% remains saving, failed file retry, then owner-scoped relogin recovery', async ({ page }) => {
  const fixture = state(); fixture.failNextComplete.add('failed-once.pdf'); await installApi(page, fixture);
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await login(page, 'owner_a');
  for (const partition of ['募集说明书', '财务与审计', '发行安排与资金用途', '工商、信用与评级', '债务、授信与担保', '经营、治理与行业']) {
    await expect(page.getByRole('heading', { name: partition, exact: true })).toBeVisible();
  }
  await expect(page.locator('select')).toHaveCount(0);
  const auditInput = page.getByLabel('为审计报告（可含报表及附注）选择文件');
  await auditInput.setInputFiles([
    { name: 'slow-save.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic slow') },
    { name: 'failed-once.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic fail') },
    { name: 'survives.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic ok') }
  ]);
  const slowRow = page.locator('.material-file-row').filter({ hasText: 'slow-save.pdf' });
  await expect(slowRow.getByRole('progressbar')).toHaveAttribute('value', '19');
  await expect(slowRow).toContainText('正在保存和核验');
  expect(fixture.releaseSlowComplete).toBeDefined();
  fixture.releaseSlowComplete!();
  await expect(slowRow).toContainText('服务器已确认保存');
  const failedRow = page.locator('.material-file-row').filter({ hasText: 'failed-once.pdf' });
  await expect(failedRow).toContainText('服务器检测到文件内容与声明格式不符');
  await expect(page.locator('.material-file-row').filter({ hasText: 'survives.pdf' })).toContainText('服务器已确认保存');
  expect(fixture.materials.size).toBe(2);
  await failedRow.getByRole('button', { name: '重试此文件' }).click();
  await expect(failedRow).toContainText('服务器已确认保存');
  expect(fixture.materials.size).toBe(3);

  await page.reload();
  await expect(page.getByText('已从服务器恢复 3 份当前账号可访问的材料记录。')).toBeVisible();
  await expect(page.locator('.persisted-material')).toHaveCount(3);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await login(page, 'owner_a');
  await expect(page.getByText('已从服务器恢复 3 份当前账号可访问的材料记录。')).toBeVisible();
  await expect(page.locator('.persisted-material')).toHaveCount(3);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await login(page, 'owner_b', false);
  await expect(page.getByText('无法访问这个项目，它可能已移除或不属于当前账号。')).toBeVisible();
  const persistedMaterialId = [...fixture.materials.keys()][0];
  const foreignMaterialStatus = await page.evaluate(path => fetch(path, { credentials: 'same-origin' }).then(response => response.status), `/api/v1/projects/${projectId}/materials/${persistedMaterialId}`);
  expect(foreignMaterialStatus).toBe(404);
  await expect(page.getByText(/slow-save\.pdf|failed-once\.pdf|survives\.pdf/)).toHaveCount(0);
  expect(fixture.putNames.filter(name => name === 'survives.pdf')).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

test('cancel before byte transfer and retry only that selected file', async ({ page }) => {
  const fixture = state(); fixture.holdNextCreate = true; await installApi(page, fixture);
  await login(page, 'owner_a');
  const input = page.getByLabel('为审计报告（可含报表及附注）选择文件');
  await input.setInputFiles({ name: 'retry-after-cancel.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic retry') });
  const row = page.locator('.material-file-row').filter({ hasText: 'retry-after-cancel.pdf' });
  await expect.poll(() => fixture.releaseCreate !== undefined).toBe(true);
  await row.getByRole('button', { name: '取消此文件' }).click();
  fixture.releaseCreate!();
  await expect(row).toContainText('本次传输已取消');
  expect(fixture.putNames).toHaveLength(0);
  await row.getByRole('button', { name: '重试此文件' }).click();
  await expect(row).toContainText('服务器已确认保存');
  expect(fixture.materials.size).toBe(1);
  expect(fixture.putNames).toEqual(['retry-after-cancel.pdf']);
});

test('refreshes the existing cookie session after upload authorization expires', async ({ page }) => {
  const fixture = state(); fixture.expireNextBytes = true; await installApi(page, fixture);
  await login(page, 'owner_a');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({ name: 'session-refresh.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic refresh') });
  await expect(page.locator('.material-file-row').filter({ hasText: 'session-refresh.pdf' })).toContainText('服务器已确认保存');
  expect(fixture.byteAttempts).toEqual(['session-refresh.pdf', 'session-refresh.pdf']);
  expect(fixture.putNames).toEqual(['session-refresh.pdf']);
  expect(fixture.materials.size).toBe(1);
});
