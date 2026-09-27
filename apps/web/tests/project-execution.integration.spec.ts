import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173';

function requireLoopbackHttpsOrigin(value: string) {
  const webOrigin = new URL(value);
  const hostname = webOrigin.hostname.replace(/^\[|\]$/g, '');
  if (webOrigin.protocol !== 'https:' || !['localhost', '127.0.0.1', '::1'].includes(hostname) ||
      webOrigin.port !== '5173' || webOrigin.username || webOrigin.password || webOrigin.pathname !== '/' ||
      webOrigin.search || webOrigin.hash || webOrigin.origin !== value) {
    throw new Error('Use the local HTTPS web origin https://127.0.0.1:5173 (or loopback hostname equivalent).');
  }
  return webOrigin.origin;
}

function requireIsolatedLocalInputs(webOrigin = origin) {
  const databaseUrl = process.env.BB_TEST_DATABASE_URL;
  const azurite = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
  const termsVersion = process.env.BB_E2E_TERMS_VERSION;
  if (!databaseUrl || !azurite || !termsVersion) {
    throw new Error('Set BB_TEST_DATABASE_URL, BB_TEST_AZURITE_CONNECTION_STRING and BB_E2E_TERMS_VERSION for the isolated live test.');
  }
  const database = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(database.hostname) || database.port !== '55433' ||
      database.pathname !== '/bondbuddy_local') {
    throw new Error('This browser integration requires the isolated deploy/local PostgreSQL database at loopback port 55433.');
  }
  if (azurite !== 'UseDevelopmentStorage=true') {
    throw new Error('This browser integration requires the local Azurite connection string UseDevelopmentStorage=true.');
  }
  return { databaseUrl, azurite, termsVersion, origin: requireLoopbackHttpsOrigin(webOrigin) };
}

async function bridgeApi(page: Page, target: string) {
  await page.route('**/api/v1/**', async route => {
    const requestUrl = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `${target}${requestUrl.pathname}${requestUrl.search}`, maxRedirects: 0 });
      await route.fulfill({ response });
    } catch {
      await route.abort('failed');
    }
  });
}

test('execution live-test guard rejects remote web origins before sending synthetic credentials', () => {
  expect(() => requireLoopbackHttpsOrigin('https://remote.example:5173'))
    .toThrow('Use the local HTTPS web origin');
  expect(requireLoopbackHttpsOrigin('https://127.0.0.1:5173')).toBe('https://127.0.0.1:5173');
});

test('real local API saves exact material and intent, then recovers the same staged run after a new login', async ({ page, browser }) => {
  test.skip(process.env.BB_E2E_REAL_API !== '1' || process.env.BB_E2E_EXECUTION_STAGING !== '1',
    'requires the explicitly enabled local real-API/PG16/Azurite staged-execution test');
  test.setTimeout(120_000);
  const { databaseUrl, azurite, termsVersion, origin: localOrigin } = requireIsolatedLocalInputs();

  const { Pool } = await import('pg');
  const { createServer } = await import('../../api/dist/server.js');
  const { azureBlobs } = await import('../../api/dist/data.js');
  const { PDF, pdfSample } = await import('../../api/dist/upload-safety.samples.js');
  const pool = new Pool({ connectionString: databaseUrl });
  const app = createServer({ pool, blobs: azureBlobs(azurite), allowedOrigin: localOrigin,
    auth: { termsVersion }, enableRunStaging: true, enableSyntheticQueue: false, enableRunRuntime: false });
  const username = `bb${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = `Synthetic-${randomUUID()}-Browser`;
  let reopenedContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const pgVersion = Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
    expect(pgVersion).toBeGreaterThanOrEqual(160000);
    expect(pgVersion).toBeLessThan(170000);
    const registration = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin: localOrigin },
      payload: { username, password, accepted_terms_version: termsVersion } });
    expect(registration.statusCode, registration.body).toBe(201);
    const ownerId = registration.json().user_id as string;
    const apiTarget = await app.listen({ host: '127.0.0.1', port: 0 });
    await bridgeApi(page, apiTarget);

    await page.goto('/');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();

    await page.goto('/#/new');
    const projectName = `合成执行恢复 ${username}`;
    await page.locator('#name').fill(projectName);
    await page.locator('#issuer').fill('合成发行人有限公司');
    await page.locator('#market').selectOption('sse');
    await page.locator('#offering').selectOption('private');
    await page.locator('input[name="has_historical"][value="yes"]').check();
    await page.getByRole('button', { name: '＋ 添加目标报告期间' }).click();
    await page.locator('#target_period_start_0').fill('2025-01-01');
    await page.locator('#target_period_end_0').fill('2025-12-31');
    await page.locator('#target_period_kind_0').selectOption('annual');
    await page.locator('#target_period_scope_0').selectOption('consolidated');
    await page.getByRole('button', { name: '创建并保存项目' }).click();
    await expect(page).toHaveURL(/#\/projects\//);
    const projectId = new URL(page.url()).hash.split('/').at(-1)!;
    await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();

    const uploadComplete = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/materials/uploads/`) &&
      response.url().endsWith('/complete') && response.request().method() === 'POST');
    await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({
      name: 'synthetic-audit.pdf', mimeType: PDF, buffer: pdfSample()
    });
    const uploadResponse = await uploadComplete;
    expect(uploadResponse.status()).toBe(200);
    const material = await uploadResponse.json() as { material_id: string; material_version: number };
    await expect(page.locator('.material-file-row').filter({ hasText: 'synthetic-audit.pdf' })).toContainText('服务器已确认保存 · 材料版本 1');

    await page.getByLabel('本次文书用途', { exact: true }).selectOption('issuance');
    await page.getByLabel('本次法规适用日', { exact: true }).fill('2026-09-27');
    await page.getByLabel('确认以上目标为本次拟定安排', { exact: false }).check();
    const savingInput = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/input-revisions`) &&
      response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存材料版本', exact: true }).click();
    const inputResponse = await savingInput;
    expect(inputResponse.status()).toBe(201);
    const input = await inputResponse.json() as {
      project_id: string; input_revision: number; input_hash: string;
      material_versions: { material_id: string; material_version: number }[];
      target_confirmation: { market: string; offering: string; document_purpose: string; as_of: string;
        target_reporting_periods: { start: string; end: string; period_kind: string; scope: string }[] };
    };
    expect(input.material_versions).toEqual([{ material_id: material.material_id, material_version: 1 }]);
    expect(input.target_confirmation).toMatchObject({ market: 'sse', offering: 'private', document_purpose: 'issuance', as_of: '2026-09-27',
      target_reporting_periods: [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated' }] });
    await expect(page.getByRole('button', { name: '检查已保存版本', exact: true })).toBeEnabled();

    const preflight = page.waitForResponse(response => response.url().endsWith(`/projects/${projectId}/preflight`) &&
      response.request().method() === 'POST');
    await page.getByRole('button', { name: '检查已保存版本', exact: true }).click();
    const preflightResponse = await preflight;
    expect(preflightResponse.status()).toBe(200);
    const readiness = await preflightResponse.json() as { status: string; missing_inputs: string[] };
    expect(['blocked', 'needs_confirmation']).toContain(readiness.status);
    await expect(page.locator('#execute-input')).toBeEnabled();

    const executing = page.waitForResponse(response => response.url().endsWith('/runs/execute') && response.request().method() === 'POST');
    await page.locator('#execute-input').click();
    const executeResponse = await executing;
    expect(executeResponse.status()).toBe(202);
    const run = await executeResponse.json() as { run_id: string; execution_request_id: string; state: string;
      project_id: string; input_revision: number; input_hash: string };
    expect(run).toMatchObject({ state: 'paused', project_id: projectId, input_revision: input.input_revision, input_hash: input.input_hash });
    expect(run.execution_request_id).toMatch(/^web-update-[a-f0-9]{64}$/);
    await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
    await expect(page.locator('#execution-progress')).toContainText('所需处理能力尚未就绪');

    const pinned = await pool.query(`SELECT r.id AS run_id,r.execution_request_id,r.state,r.input_revision,r.input_hash,
        i.manifest->'target_confirmation' AS target_confirmation,i.material_versions,
        e.type AS event_type,e.state AS event_state,e.payload
      FROM bb_runs r JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
      JOIN bb_run_events e ON e.owner_user_id=r.owner_user_id AND e.run_id=r.id AND e.seq=1
      WHERE r.owner_user_id=$1 AND r.project_id=$2`, [ownerId, projectId]);
    expect(pinned.rowCount).toBe(1);
    expect(pinned.rows[0]).toMatchObject({ run_id: run.run_id, execution_request_id: run.execution_request_id,
      state: 'paused', input_revision: input.input_revision, input_hash: input.input_hash, event_type: 'run.state_changed',
      event_state: 'paused', payload: { reason: 'capability_not_ready' }, material_versions: [{ material_id: material.material_id, material_version: 1 }] });
    expect(pinned.rows[0].target_confirmation).toMatchObject(input.target_confirmation);

    await page.context().close();
    reopenedContext = await browser.newContext({ baseURL: localOrigin, ignoreHTTPSErrors: true });
    const reopened = await reopenedContext.newPage();
    await bridgeApi(reopened, apiTarget);
    await reopened.goto('/');
    await reopened.getByLabel('用户名').fill(username);
    await reopened.getByLabel('密码').fill(password);
    await reopened.getByRole('button', { name: '登录', exact: true }).click();
    await expect(reopened.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    const recoveredRunResponse = reopened.waitForResponse(response => response.url().endsWith(`/runs/${run.run_id}`) &&
      response.request().method() === 'GET');
    await reopened.goto(`/#/projects/${encodeURIComponent(projectId)}`);
    expect((await recoveredRunResponse).status()).toBe(200);
    await expect(reopened.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
    await expect(reopened.locator('#execution-snapshot')).toContainText('已保存材料版本 1');
    await expect(reopened.locator('#execution-snapshot')).toContainText('synthetic-audit.pdf · 版本 1');
    await expect(reopened.locator('#execution-snapshot')).toContainText('本期发行文件');
    await expect(reopened.locator('#execution-progress')).toContainText('任务已暂停');
    await expect(reopened.locator('#execution-progress')).toContainText('所需处理能力尚未就绪');

    const repeated = await reopened.evaluate(async ({ request }) => {
      const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('bb_csrf='))?.slice('bb_csrf='.length) ?? '';
      const response = await fetch('/api/v1/runs/execute', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bb-csrf': csrf }, body: JSON.stringify(request) });
      return { status: response.status, body: await response.json() };
    }, { request: { execution_request_id: run.execution_request_id, project_id: projectId, input_revision: input.input_revision,
      input_hash: input.input_hash, task_kind: 'update', input_manifest_ref: input.input_hash, storage_origin: 'cloud', workspace_id: projectId } });
    expect(repeated.status).toBe(202);
    expect(repeated.body.run_id).toBe(run.run_id);
    expect((await pool.query('SELECT count(*)::int AS n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2', [ownerId, projectId])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2', [ownerId, run.run_id])).rows[0].n).toBe(1);
  } finally {
    if (reopenedContext) await reopenedContext.close();
    await app.close();
    await pool.end();
  }
});
