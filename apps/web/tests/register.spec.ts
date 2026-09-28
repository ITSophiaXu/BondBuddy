import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

// Synthetic /api/v1 fixture: exercises the registration UI against the public contract, not a live API.
const origin = process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const now = '2026-09-25T12:00:00Z';
const terms = 'synthetic-terms-2026-09';
const policy = {"policy_version": "data_policy_m1_v1", "storage_location": "platform_private_cloud", "server_side_processing": true, "model_provider_processing": true, "active_retention": "until_user_deletes", "purge_enabled": true, "deleted_content_purge_days": 30, "orphan_upload_purge_hours": 24, "log_content_retention_days": 180, "backup_retention_days": 30, "pinned_by_active_run": "retained_until_run_ends", "purged_content": ["material_bytes", "parse_evidence_text", "ocr_objects", "parse_cache_objects", "word_artifacts", "prompt_snapshots", "provider_results"], "retained_metadata": ["hashes_and_sizes", "run_and_job_states", "model_call_attempts_and_usage", "audit_and_purge_receipts"]};
type Fixture = { owner: string | null; agreement: 'ok' | 'unset'; next: number | 'network' | null; registered: unknown[] };
const json = (route: Route, status: number, value?: unknown) => route.fulfill({ status, contentType: 'application/json', body: value === undefined ? '' : JSON.stringify(value) });

async function installApi(context: BrowserContext, state: Fixture) {
  await context.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    if (path === '/auth/agreement') return state.agreement === 'ok'
      ? json(route, 200, { terms_version: terms, title: 'BondBuddy 用户协议与数据保存说明', summary_url_or_path: '/#/data-policy', support_contact: null })
      : json(route, 503, { code: 'CAPABILITY_NOT_READY' });
    if (path === '/auth/register' && method === 'POST') {
      state.registered.push(request.postDataJSON());
      const next = state.next; state.next = null;
      if (next === 'network') return route.abort('failed');
      if (next === 409) return json(route, 409, { code: 'IDEMPOTENCY_CONFLICT' });
      if (next === 422) return json(route, 422, { code: 'AGREEMENT_REQUIRED' });
      if (next === 429) return json(route, 429, { code: 'RATE_LIMITED' });
      state.owner = 'user-new';
      await context.addCookies([{ name: 'bb_session', value: 'synthetic', url: origin, httpOnly: true }, { name: 'bb_csrf', value: 'synthetic-csrf', url: origin }]);
      return json(route, 201, { user_id: state.owner, session_status: 'active', expires_at: now });
    }
    if (path === '/data-policy') return json(route, 200, policy);
    if (!state.owner) return json(route, 401, { code: 'UNAUTHENTICATED' });
    if (path === '/me') return json(route, 200, { user_id: state.owner, session_status: 'active' });
    if (path === '/projects') return json(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    return json(route, 404, { code: 'NOT_FOUND' });
  });
}
async function fill(page: Page, username = 'Synthetic_New1', password = 'Synthetic-password-123', confirm = password) {
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(confirm);
}
const submit = (page: Page) => page.getByRole('button', { name: '注册并进入工作区' }).click();

test('login page switches to registration, validates locally and lands logged in with the agreement version', async ({ page, context }) => {
  const state: Fixture = { owner: null, agreement: 'ok', next: null, registered: [] };
  await installApi(context, state);
  await page.goto('/');
  await page.getByRole('link', { name: '注册', exact: true }).click();
  await expect(page.getByRole('heading', { name: '注册工作区账号' })).toBeVisible();
  await expect(page.getByText('3–32 位，以字母开头，只能包含字母、数字和下划线，不区分大小写。')).toBeVisible();
  await expect(page.locator('#terms-version')).toHaveText(terms);
  await expect(page.getByRole('link', { name: /用户协议/ })).toHaveAttribute('href', '/#/data-policy');
  await fill(page, '1bad');
  await page.getByRole('checkbox').check();
  await submit(page);
  await expect(page.locator('#login-message')).toContainText('用户名格式不正确');
  await fill(page, 'Synthetic_New1', 'Synthetic-password-123', 'Synthetic-password-124');
  await submit(page);
  await expect(page.locator('#login-message')).toHaveText('两次输入的密码不一致。');
  await fill(page);
  await page.getByRole('checkbox').uncheck();
  await submit(page);
  await expect(page.locator('#login-message')).toContainText('勾选');
  expect(state.registered).toHaveLength(0);
  await page.getByRole('checkbox').check();
  await submit(page);
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  expect(state.registered).toEqual([{ username: 'Synthetic_New1', password: 'Synthetic-password-123', accepted_terms_version: terms }]);
});

test('409, 422, 429 and network failures show friendly messages and keep the form', async ({ page, context }) => {
  const state: Fixture = { owner: null, agreement: 'ok', next: null, registered: [] };
  await installApi(context, state);
  await page.goto('/#/register');
  await fill(page); await page.getByRole('checkbox').check();
  for (const [next, text] of [[409, '该用户名已被使用，请换一个用户名。'], [422, '用户协议已更新'], [429, '尝试次数过多'], ['network', '网络连接中断']] as const) {
    state.next = next;
    await submit(page);
    await expect(page.locator('#login-message')).toContainText(text);
    await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('Synthetic_New1');
  }
  await page.getByRole('link', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录工作区' })).toBeVisible();
});

test('registration stays closed when no agreement version is configured', async ({ page, context }) => {
  await installApi(context, { owner: null, agreement: 'unset', next: null, registered: [] });
  await page.goto('/#/register');
  await expect(page.locator('#agreement')).toContainText('注册暂未开放');
  await expect(page.getByRole('button', { name: '注册并进入工作区' })).toBeDisabled();
});

test('the agreement link opens the data-policy page without an account', async ({ page, context }) => {
  await installApi(context, { owner: null, agreement: 'ok', next: null, registered: [] });
  await page.goto('/#/data-policy');
  await expect(page.getByRole('heading', { name: '数据保存与删除说明' })).toBeVisible();
  await page.getByRole('link', { name: '← 返回登录' }).click();
  await expect(page.getByRole('heading', { name: '登录工作区' })).toBeVisible();
});
