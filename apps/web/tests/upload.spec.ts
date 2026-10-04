import { expect, test, type Page, type Route } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MaterialParseJob, Recognition } from '@bondbuddy/contracts';

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
  unavailableNextComplete: Map<string, string>;
  dropNextComplete: Set<string>;
  releaseSlowComplete?: () => void;
  holdNextCreate: boolean;
  releaseCreate?: () => void;
  expireNextBytes: boolean;
  inspectionFailures: Map<string, { reason: string; correlationId: string }>;
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
      const inspection = state.inspectionFailures.get(upload.filename);
      if (inspection) {
        state.inspectionFailures.delete(upload.filename);
        return json(route, 422, {
          code: 'MATERIAL_UNREADABLE', retryable: false, correlation_id: inspection.correlationId,
          field_errors: [{ field: 'material_upload', code: inspection.reason, message: 'File inspection was not completed' }],
        });
      }
      state.putNames.push(upload.filename);
      return route.fulfill({ status: 204 });
    }
    const completeMatch = path.match(new RegExp(`/api/v1/projects/${projectId}/materials/uploads/([^/]+)/complete$`));
    if (completeMatch && request.method() === 'POST') {
      const upload = state.uploads.get(decodeURIComponent(completeMatch[1]));
      if (!upload || upload.owner !== state.owner) return json(route, 404, { code: 'NOT_FOUND' });
      if (!upload.bytes) return json(route, 422, { code: 'MATERIAL_UNREADABLE' });
      const unavailable = state.unavailableNextComplete.get(upload.filename);
      if (unavailable) {
        state.unavailableNextComplete.delete(upload.filename);
        return json(route, 503, { code: 'DATA_UNAVAILABLE', retryable: true, correlation_id: unavailable });
      }
      if (state.failNextComplete.has(upload.filename)) {
        state.failNextComplete.delete(upload.filename);
        return json(route, 422, { code: 'MATERIAL_CONTENT_MISMATCH' });
      }
      if (upload.filename === 'slow-save.pdf' && state.releaseSlowComplete === undefined) await new Promise<void>(resolve => { state.releaseSlowComplete = resolve; });
      const body = request.postDataJSON() as { byte_size: number; sha256: string };
      const material: Material = [...state.materials.values()].find(item => item.role === upload.role && item.sha256 === body.sha256) ?? { material_id: randomUUID(), material_version: 1, upload_id: decodeURIComponent(completeMatch[1]), role: upload.role, filename: upload.filename, media_type: 'application/pdf', byte_size: body.byte_size, sha256: body.sha256, state: 'persisted', persisted_at: now, error: null };
      state.materials.set(material.material_id, material);
      state.sequence++;
      if (state.dropNextComplete.delete(upload.filename)) return route.abort('failed');
      return json(route, 200, material);
    }
    return json(route, 404, { code: 'NOT_FOUND' });
  });
}

function state(): FixtureState {
  return { owner: null, uploads: new Map(), materials: new Map(), sequence: 0, failNextComplete: new Set(), unavailableNextComplete: new Map(), dropNextComplete: new Set(), holdNextCreate: false, expireNextBytes: false, inspectionFailures: new Map(), byteAttempts: [], putNames: [] };
}

async function login(page: Page, username: string, expectProject = true) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录工作区' })).toBeVisible();
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill('Synthetic-password-123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  if (await page.getByRole('button', { name: '打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('link', { name: '全部项目', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '全部项目', exact: true })).toBeVisible();
  await page.goto(`/#/projects/${projectId}`);
  if (expectProject) {
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '提供项目材料' })).toBeVisible();
  } else {
    await expect(page.getByText('无法访问这个项目，它可能已移除或不属于当前账号。')).toBeVisible();
  }
}

test('three independent files, 100% remains saving, failed file retry, then owner-scoped relogin recovery', async ({ page }) => {
  const fixture = state(); fixture.failNextComplete.add('failed-once.pdf'); await installApi(page, fixture);
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await login(page, 'owner_a');
  for (const partition of ['历史／参考募集书（选填）', '审计报告 / 财务报表及附注', '募投项目与权证材料', '其他项目材料']) {
    await expect(page.getByRole('heading', { name: partition, exact: true })).toBeVisible();
  }
  await expect(page.locator('#material-partitions select')).toHaveCount(0);
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
  await expect(failedRow).toContainText('文件内容校验与声明不一致');
  await expect(page.locator('.material-file-row').filter({ hasText: 'survives.pdf' })).toContainText('服务器已确认保存');
  expect(fixture.materials.size).toBe(2);
  await failedRow.getByRole('button', { name: '重试此文件' }).click();
  await expect(failedRow).toContainText('服务器已确认保存');
  expect(fixture.materials.size).toBe(3);

  await page.reload();
  await expect(page.getByText('已恢复 3 份材料。')).toBeVisible();
  await expect(page.locator('.persisted-material')).toHaveCount(3);
  if (await page.getByRole('button', { name:'打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await login(page, 'owner_a');
  await expect(page.getByText('已恢复 3 份材料。')).toBeVisible();
  await expect(page.locator('.persisted-material')).toHaveCount(3);
  if (await page.getByRole('button', { name:'打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
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

test('an unsupported external workbook reference is explained without claiming file damage; only that file retries', async ({ page }) => {
  const fixture=state(); fixture.inspectionFailures.set('external.xlsx', {
    reason: 'external_link_invalid', correlationId: 'synthetic-external-link',
  });
  await installApi(page,fixture); await login(page,'owner_a');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles([
    { name:'external.xlsx', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer:Buffer.from('synthetic external workbook') },
    { name:'saved.pdf', mimeType:'application/pdf', buffer:Buffer.from('%PDF synthetic saved') },
  ]);
  const row=page.locator('.material-file-row').filter({hasText:'external.xlsx'});
  await expect(row).toContainText('外部工作簿引用');
  await expect(row).toContainText('错误编号：synthetic-external-link');
  await expect(row).not.toContainText('损坏');
  if (process.env.BB_361_ERROR_EVIDENCE_DIR) {
    for (const [device, width, height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({path:join(process.env.BB_361_ERROR_EVIDENCE_DIR,`upload-error-${device}.png`)});
    }
  }
  await expect(page.locator('.material-file-row').filter({hasText:'saved.pdf'})).toContainText('服务器已确认保存');
  await row.getByRole('button',{name:'重试此文件'}).click();
  await expect(row).toContainText('服务器已确认保存');
  expect(fixture.materials.size).toBe(2);
  expect(fixture.byteAttempts.filter(name=>name==='saved.pdf')).toHaveLength(1);
});

test('uncertain completion keeps the support reference and reconciles before resending bytes', async ({ page }) => {
  const fixture=state(); fixture.unavailableNextComplete.set('uncertain.pdf', 'synthetic-completion-503');
  await installApi(page,fixture); await login(page,'owner_a');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({
    name:'uncertain.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF synthetic uncertain'),
  });
  const row=page.locator('.material-file-row').filter({hasText:'uncertain.pdf'});
  await expect(row).toContainText('错误编号：synthetic-completion-503');
  await expect(row).toContainText('请勿盲目重传');
  await row.getByRole('button',{name:'核对并继续保存'}).click();
  await expect(row).toContainText('服务器已确认保存');
  expect(fixture.byteAttempts.filter(name=>name==='uncertain.pdf')).toHaveLength(1);
});

test('lost completion response automatically reconciles the original upload without resending bytes', async ({ page }) => {
  const fixture = state(); fixture.dropNextComplete.add('lost.pdf'); await installApi(page, fixture);
  await login(page, 'owner_a');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({ name: 'lost.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic lost response') });
  const row = page.locator('.material-file-row').filter({ hasText: 'lost.pdf' });
  await expect(row).toContainText('服务器已确认保存');
  expect(fixture.uploads.size).toBe(1);
  expect(fixture.putNames).toEqual(['lost.pdf']);
  expect(fixture.materials.size).toBe(1);
});

test('server refresh reconciles a delayed receipt but never matches only a filename', async ({ page }) => {
  const fixture = state(); fixture.unavailableNextComplete.set('delayed.pdf', 'synthetic-delayed-503');
  await installApi(page, fixture); await login(page, 'owner_a');
  const buffer = Buffer.from('%PDF synthetic delayed receipt');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({name:'delayed.pdf', mimeType:'application/pdf', buffer});
  const row = page.locator('[data-upload-phase="uncertain"]').filter({hasText:'delayed.pdf'});
  await expect(row).toContainText('保存结果尚未确认');
  const material: Material = {material_id:'delayed-material', material_version:1, upload_id:[...fixture.uploads.keys()][0], role:'audit', filename:'delayed.pdf', media_type:'application/pdf', byte_size:buffer.length, sha256:'a'.repeat(64), state:'persisted', persisted_at:now, error:null};
  fixture.materials.set(material.material_id,material);
  for (const invalid of [
    {sha256:'a'.repeat(64)},
    {sha256:createHash('sha256').update(buffer).digest('hex'),role:'other'},
    {role:'audit',byte_size:buffer.length + 1},
    {byte_size:buffer.length,media_type:'text/plain'},
  ]) {
    Object.assign(material,invalid);
    await page.getByRole('button',{name:'刷新已保存材料'}).click();
    await expect(page.locator('#material-recovery-status')).toContainText('已恢复 1 份材料');
    await expect(row).toBeVisible();
    await expect(page.getByRole('button',{name:'开始编制',exact:true})).toBeDisabled();
  }
  // A renamed, deduplicated receipt may have another upload ID, but its bytes and role must agree.
  Object.assign(material,{media_type:'application/pdf',upload_id:'prior-deduplicated-upload',filename:'renamed.pdf'});
  await page.getByRole('button',{name:'刷新已保存材料'}).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.material-file-row')).toHaveCount(1);
  await expect(page.locator('.material-file-row')).toContainText('服务器已确认保存');
  expect(fixture.putNames).toEqual(['delayed.pdf']); expect(fixture.uploads.size).toBe(1);
});

test('renamed equal-content uploads display one saved material and survive reload', async ({ page }) => {
  const fixture = state(); await installApi(page, fixture); await login(page, 'owner_a');
  const buffer = Buffer.from('%PDF synthetic same history');
  await page.getByLabel('为本企业历史募集书选择文件').setInputFiles([
    { name: 'history.pdf', mimeType: 'application/pdf', buffer },
    { name: 'renamed.pdf', mimeType: 'application/pdf', buffer }
  ]);
  await expect(page.locator('#material-recovery-status')).toContainText('1 份重复上传已复用原材料版本');
  await expect(page.locator('.material-file-row')).toHaveCount(1);
  expect(fixture.materials.size).toBe(1);
  await page.reload();
  await expect(page.locator('.persisted-material')).toHaveCount(1);
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


test('a late material refresh cannot restore a row removed by a newer refresh', async ({ page }) => {
  const current = state();
  const material: Material = { material_id: 'late-material', material_version: 1, upload_id: 'upload-late', role: 'audit', filename: 'late-result.pdf', media_type: 'application/pdf', byte_size: 20, sha256: 'a'.repeat(64), state: 'persisted', persisted_at: now, error: null };
  current.materials.set(material.material_id, material);
  await installApi(page, current);
  await login(page, 'owner_a');
  await expect(page.locator('.persisted-material')).toHaveCount(1);
  let release!: () => void;
  let held = false;
  await page.route(`**/api/v1/projects/${projectId}/materials/${material.material_id}`, async route => {
    held = true;
    await new Promise<void>(resolve => { release = resolve; });
    await json(route, 200, material).catch(() => {});
  });
  await page.getByRole('button', { name: '刷新已保存材料' }).click();
  await expect.poll(() => held).toBe(true);
  current.materials.clear();
  await page.getByRole('button', { name: '刷新已保存材料' }).click();
  await expect(page.getByText('尚未添加材料。')).toBeVisible();
  release();
  await expect(page.locator('.persisted-material')).toHaveCount(0);
});

// Synthetic shared-contract responses; live parser coverage is in material-processing.integration.spec.ts.
function parseJob(material: Material, state: MaterialParseJob['state'] = 'succeeded'): MaterialParseJob {
  return { job_id: `parse-${material.material_id}`, job_type: 'parse', subtype: 'material_parse', project_id: projectId, material_id: material.material_id, material_version: material.material_version, material_sha256: material.sha256, parser_version: 'synthetic-v1', state, stage: state === 'running' ? 'historical_profile' : state, completed_stages: state === 'queued' ? [] : ['parse_evidence', 'historical_profile'], attempts: state === 'queued' ? 0 : 1, max_attempts: 3, error_code: null, outcome: state === 'succeeded' ? 'parsed' : null, parse_status: state === 'succeeded' ? 'parsed' : null, profile_version: state === 'succeeded' ? 1 : null, pending_capabilities: [], updated_at: now };
}
function recognition(material: Material): Recognition {
  const provenance = { material_id: material.material_id, material_version: material.material_version, method: 'native_text' as const, extractor_version: 'synthetic-v1', evidence_refs: ['synthetic-evidence'] };
  const field = <T>(value: T, raw_value: string) => ({ value, raw_value, provenance, status: 'recognized' as const, uncertainty: [] });
  return { material_id: material.material_id, material_version: material.material_version, profile_version: 1, state: 'ready', source_market: field('nafmii', '中国银行间市场交易商协会'), source_offering: field('dfi', 'DFI 储架发行'), latest_reporting_cutoff: field('2025-06-30', '2025年1-6月'), reporting_periods: [
    { start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated', raw_value: '2024年度合并财务报表', provenance, status: 'recognized', uncertainty: [] },
    { start: '2025-01-01', end: '2025-06-30', period_kind: 'interim', scope: null, raw_value: '<img src=x onerror=alert(1)>2025年1-6月', provenance, status: 'needs_confirmation', uncertainty: ['报表口径需要核对'] }
  ] };
}
async function installProcessing(page: Page, current: FixtureState, response: (material: Material) => MaterialParseJob) {
  const reads: string[] = [];
  await page.route('**/materials/*/parse-job', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    reads.push(id); const material = current.materials.get(id);
    return material && current.owner === 'user-owner_a' ? json(route, 200, response(material)) : json(route, 404, { code: 'NOT_FOUND' });
  });
  await page.route('**/materials/*/source-profile', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    const material = current.materials.get(id);
    return material && current.owner === 'user-owner_a' ? json(route, 200, recognition(material)) : json(route, 404, { code: 'NOT_FOUND' });
  });
  return reads;
}

test('upload processing stays compact with pending evidence, unchanged targets and refresh/relogin recovery', async ({ page }) => {
  test.setTimeout(60000);
  const current = state(); await installApi(page, current);
  let stage: MaterialParseJob['state'] = 'queued';
  await installProcessing(page, current, material => ({ ...parseJob(material, stage),
    ...(stage === 'succeeded' ? { outcome: 'needs_confirmation', parse_status: 'needs_confirmation' } : {}) }));
  await page.route(`**/api/v1/projects/${projectId}`, route => json(route, 200, { ...project, market: 'sse', offering: 'public_all' }));
  const mutations: string[] = [], profileRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/source-profile')) profileRequests.push(request.method());
    if (request.url().includes('/api/v1/') && request.method() !== 'GET') mutations.push(new URL(request.url()).pathname);
  });
  const noReview = async () => {
    await expect(page.locator('.source-profile, [data-source-correction], a[href$="/ocr"]')).toHaveCount(0);
    await expect(page.locator('#material-partitions')).not.toContainText(/evidence-|native_text|核对识别内容|原文：|有待确认项|历史稿信息/);
  };
  await login(page, 'owner_a');
  await page.getByLabel('为本企业历史募集书选择文件').setInputFiles({ name: 'synthetic-history.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic recognition') });
  const row = page.locator('.material-file-row').filter({ hasText: 'synthetic-history.pdf' });
  await expect(row).toContainText('服务器已确认保存'); await expect(row).toContainText('等待处理');
  await noReview(); await expect(row.getByRole('progressbar')).toHaveCount(0);
  stage = 'running'; await expect(row).toContainText('处理中', { timeout: 15000 }); await noReview();
  stage = 'succeeded'; await expect(row).toContainText('处理完成', { timeout: 15000 }); await noReview();
  await expect(page.getByLabel('发行市场', { exact: true })).toHaveValue('sse');
  await expect(page.getByLabel('发行方式', { exact: true })).toHaveValue('public_all');
  await page.reload(); await expect(row).toContainText('处理完成'); await noReview();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  if (await page.getByRole('button', { name:'打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click(); await login(page, 'owner_a');
  await expect(row).toContainText('处理完成'); await noReview();
  expect(profileRequests).toEqual([]);
  expect(mutations.filter(path => !/\/auth\/(login|logout|refresh)$|\/materials\/uploads(?:\/[^/]+\/(?:bytes|complete))?$/.test(path))).toEqual([]);
});

test('OCR pending, parse failure, legacy absent job and read failure each have honest recovery states', async ({ page }) => {
  const current = state();
  for (const name of ['scan', 'bad', 'legacy', 'network']) current.materials.set(name, { material_id: name, material_version: 1, upload_id: `upload-${name}`, role: 'audit', filename: `${name}.pdf`, media_type: 'application/pdf', byte_size: 1024, sha256: 'a'.repeat(64), state: 'persisted', persisted_at: now, error: null });
  await installApi(page, current);
  let networkOk = false;
  await page.route('**/materials/*/parse-job', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    const material = current.materials.get(id)!;
    if (id === 'legacy') return json(route, 404, { code: 'NOT_FOUND' });
    if (id === 'network' && !networkOk) return json(route, 503, { code: 'DATA_UNAVAILABLE' });
    return json(route, 200, id === 'scan' ? { ...parseJob(material, 'paused'), stage: 'awaiting_ocr', outcome: 'pending_ocr', pending_capabilities: ['ocr'] }
      : id === 'bad' ? { ...parseJob(material, 'failed'), error_code: 'MATERIAL_UNREADABLE' } : parseJob(material));
  });
  await login(page, 'owner_a');
  for (const [name, message] of [['scan', '处理暂缓'], ['bad', '暂时无法读取此文件'], ['legacy', '暂未取得处理状态'], ['network', '文件保存不受影响']]) await expect(page.locator('.material-file-row').filter({ hasText: `${name}.pdf` })).toContainText(message);
  const networkRow = page.locator('.material-file-row').filter({ hasText: 'network.pdf' });
  networkOk = true; await networkRow.getByRole('button', { name: '刷新状态' }).click(); await expect(networkRow).toContainText('处理完成');
  await expect(page.locator('.source-profile')).toHaveCount(0);
});

test('duplicate uploads join one status read, and late processing responses cannot cross projects or accounts', async ({ page }) => {
  const current = state(); await installApi(page, current);
  const reads = await installProcessing(page, current, material => parseJob(material));
  let release!: () => void; let pending = 0;
  await page.route('**/materials/*/parse-job', async route => {
    const material = [...current.materials.values()][0]!; pending++;
    await new Promise<void>(resolve => { release = resolve; }); await json(route, 200, parseJob(material)).catch(() => {});
  });
  await login(page, 'owner_a');
  const buffer = Buffer.from('%PDF synthetic reused parse');
  await page.getByLabel('为本企业历史募集书选择文件').setInputFiles([{ name: 'one.pdf', mimeType: 'application/pdf', buffer }, { name: 'two.pdf', mimeType: 'application/pdf', buffer }]);
  await expect(page.locator('#material-recovery-status')).toContainText('1 份重复上传');
  await expect.poll(() => pending).toBe(1); expect(reads.length).toBe(0); // The held route supersedes the normal status reader.
  if (await page.getByRole('button', { name: '打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('link', { name: '全部项目', exact: true }).first().click(); release();
  await expect(page.locator('.source-profile')).toHaveCount(0);
  await page.goto(`/#/projects/${projectId}`); await expect.poll(() => pending).toBe(2);
  if (await page.getByRole('button', { name:'打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click(); release(); await login(page, 'owner_b', false);
  await expect(page.locator('.source-profile')).toHaveCount(0);
  expect(current.materials.size).toBe(1);
});

test('material recovery keeps the live file picker attached until its change event arrives', async ({ page }) => {
  const current = state(); await installApi(page, current); await login(page, 'owner_a');
  const picker = await page.getByLabel('为本企业历史募集书选择文件').elementHandle();
  await page.getByRole('button', { name: '刷新已保存材料' }).click();
  await expect(page.locator('#material-recovery-status')).toContainText('尚未添加材料');
  expect(await picker!.evaluate(input => input.isConnected)).toBe(true);
  await picker!.setInputFiles({ name: 'picker-survives.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic selected before recovery') });
  await expect(page.locator('.material-file-row')).toContainText('服务器已确认保存');
});
