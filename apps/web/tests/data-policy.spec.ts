import { expect, test, type Page, type Route } from '@playwright/test';

// #6 synthetic browser check: policy copy is rendered from the API field, and deletion actions call the API.
// Mocked API only; this is not deployed-browser acceptance.
const origin = process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const now = '2026-09-25T08:00:00Z';
const projectId = 'project-synthetic-policy';
const project = { project_id: projectId, draft_revision: 1, input_revision: null, input_hash: null, name: '合成数据政策项目', kind: 'update', issuer_name: null, market: null, offering: null, updated_at: now };
const material = { material_id: 'material-synthetic-1', material_version: 1, upload_id: 'upload-synthetic-1', role: 'audit', filename: '合成审计报告.pdf', media_type: 'application/pdf', byte_size: 2048, sha256: 'a'.repeat(64), state: 'persisted', persisted_at: now, error: null };
const policy = { policy_version: 'data_policy_m1_v1', storage_location: 'platform_private_cloud', server_side_processing: true, model_provider_processing: true, active_retention: 'until_user_deletes', purge_enabled: true, deleted_content_purge_days: 17, orphan_upload_purge_hours: 6, log_content_retention_days: 180, backup_retention_days: 21, pinned_by_active_run: 'retained_until_run_ends', purged_content: ['material_bytes'], retained_metadata: ['hashes_and_sizes'] };
const json = (route: Route, status: number, value?: unknown) => route.fulfill({ status, contentType: 'application/json', body: value === undefined ? '' : JSON.stringify(value) });

async function install(page: Page, calls: string[], options: { blockProject?: boolean } = {}) {
  let materialLive = true;
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === '/api/v1/me') return json(route, 200, { user_id: 'user-policy', session_status: 'active', expires_at: now });
    if (path === '/api/v1/data-policy') { calls.push('policy'); return json(route, 200, policy); }
    if (path === '/api/v1/projects' && method === 'GET') return json(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    if (path === `/api/v1/projects/${projectId}` && method === 'GET') return json(route, 200, project);
    if (path === `/api/v1/projects/${projectId}` && method === 'DELETE') {
      calls.push('delete-project');
      return options.blockProject ? json(route, 409, { code: 'PROJECT_DELETE_BLOCKED' }) : route.fulfill({ status: 204 });
    }
    if (path === `/api/v1/projects/${projectId}/events`) return json(route, 200, { items: materialLive ? [{ event_id: 'e1', schema_version: 1, trace_id: 't1', project_id: projectId, seq: 1, occurred_at: now, type: 'material.upload_progress', payload: { material_id: material.material_id, uploaded_bytes: 2048, total_bytes: 2048 } }] : [], next_cursor: null });
    if (path === `/api/v1/projects/${projectId}/materials/${material.material_id}` && method === 'GET') return materialLive ? json(route, 200, material) : json(route, 404, { code: 'NOT_FOUND' });
    if (path === `/api/v1/projects/${projectId}/materials/${material.material_id}` && method === 'DELETE') { calls.push('delete-material'); materialLive = false; return route.fulfill({ status: 204 }); }
    return json(route, 404, { code: 'NOT_FOUND' });
  });
  await page.context().addCookies([{ name: 'bb_csrf', value: 'synthetic-csrf', url: origin }]);
}

test('upload only links to policy; independent page keeps accurate retention and processing details', async ({ page }) => {
  const calls: string[] = []; await install(page, calls);
  await page.goto(`/#/projects/${projectId}`);
  const note = page.locator('#upload-policy-note');
  await expect(note).toHaveText('数据保存与删除说明');
  expect(calls).not.toContain('policy');
  await expect(page.locator('main')).not.toContainText('自动清理时限尚未配置');
  await expect(note).not.toContainText('模型服务商');
  await note.getByRole('link', { name: '数据保存与删除说明' }).click();
  await expect(page.getByRole('heading', { name: '数据保存与删除说明' })).toBeVisible();
  for (const text of ['6 小时', '180 天', '21 天', '删除项目', '浏览器中的文件不是唯一副本']) await expect(page.locator('main')).toContainText(text);
  await expect(page.locator('body')).not.toContainText('只保存在本机');
});

test('owner deletes a saved material and then the project through the API', async ({ page }) => {
  const calls: string[] = []; await install(page, calls);
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.locator('#material-partitions').getByText(material.filename, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText(material.filename)).toHaveCount(0);
  await page.getByRole('button', { name: '删除项目' }).click();
  await page.getByRole('link', { name: '全部项目', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '全部项目', exact: true })).toBeVisible();
  expect(calls).toEqual(expect.arrayContaining(['delete-material', 'delete-project']));
});

test('project deletion blocked by an active run shows the reason and stays on the project', async ({ page }) => {
  const calls: string[] = []; await install(page, calls, { blockProject: true });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`/#/projects/${projectId}`);
  await page.getByRole('button', { name: '删除项目' }).click();
  await expect(page.getByText('项目中还有任务尚未结束，暂时不能删除。')).toBeVisible();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
});
