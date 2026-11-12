import { expect, test, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { AUTOMATIC_PRICE_VERSION, reportingWindow } from '@bondbuddy/contracts';
import type { Dto } from '../src/api';

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
  const databaseHost = database.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(databaseHost) || database.port !== '55433' ||
      database.pathname !== '/bondbuddy_local' || database.search || database.hash) {
    throw new Error('This browser integration requires the isolated deploy/local PostgreSQL database at loopback port 55433.');
  }
  if (azurite !== 'UseDevelopmentStorage=true') {
    throw new Error('This browser integration requires the local Azurite connection string UseDevelopmentStorage=true.');
  }
  return { database: { host: databaseHost, port: Number(database.port), database: database.pathname.slice(1),
    user: decodeURIComponent(database.username), password: decodeURIComponent(database.password) },
    azurite, termsVersion, origin: requireLoopbackHttpsOrigin(webOrigin) };
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

test('real local current UI saves both selected materials and cutoff, then recovers the same staged run after a new login', async ({ page, browser }) => {
  test.skip(process.env.BB_E2E_REAL_API !== '1' || process.env.BB_E2E_EXECUTION_STAGING !== '1',
    'requires the explicitly enabled local real-API/PG16/Azurite staged-execution test');
  test.setTimeout(120_000);
  const { database, azurite, termsVersion, origin: localOrigin } = requireIsolatedLocalInputs();

  const { Pool } = await import('pg');
  const { createServer } = await import('../../api/dist/server.js');
  const { azureBlobs, transaction } = await import('../../api/dist/data.js');
  const { creditBalanceExact, grantCredits } = await import('../../api/dist/billing.js');
  const { DOCX, PDF, docxSample, pdfSample } = await import('../../api/dist/upload-safety.samples.js');
  const pool = new Pool(database);
  const app = createServer({ pool, blobs: azureBlobs(azurite), allowedOrigin: localOrigin,
    auth: { termsVersion }, paymentProviders: [], enableRunStaging: true, enableSyntheticQueue: false, enableRunRuntime: false });
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
    // Synthetic local wallet fixture through the real ledger service, not a payment.
    // Current automatic pricing and reservation remain enabled; no historical billing seam.
    await transaction(pool, client => grantCredits(client, { owner: ownerId, source: 'existing_grant',
      key: 'synthetic-staged-execution-' + ownerId, points: 1_000_000, expiresAt: null,
      actor: 'local-synthetic-test', reason: 'Isolated staged-run browser fixture; no real payment or model call' }));
    const apiTarget = await app.listen({ host: '127.0.0.1', port: 0 });
    await bridgeApi(page, apiTarget);

    await page.goto('/');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();

    await page.getByRole('link', { name: '更新募集书', exact: true }).click();
    await page.getByRole('link', { name: '＋ 新建项目', exact: true }).click();
    const issuer = `合成执行恢复 ${username} 有限公司`;
    await page.getByLabel('发行人全称', { exact: true }).fill(issuer);
    await page.getByLabel('发行市场', { exact: true }).selectOption('sse');
    await page.getByLabel('发行方式', { exact: true }).selectOption('private');
    await page.getByLabel('最新报告期年份', { exact: true }).selectOption('2025');
    await page.locator('input[name="reporting_quarter"][value="12-31"]').check();
    const projectName = (await page.locator('#generated-project-name').innerText()).trim();
    expect(projectName).toContain(issuer);
    const creating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/projects' &&
      response.request().method() === 'POST');
    await page.getByRole('button', { name: '创建项目，继续提供材料', exact: true }).click();
    const createdResponse = await creating;
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = await createdResponse.json() as Dto<'ProjectResponse'>;
    expect(created).toMatchObject({ name: projectName, issuer_name: issuer, kind: 'update', market: 'sse', offering: 'private',
      update_details: { authoring_mode: 'unified_v1', reporting_cutoff: '2025-12-31',
        target_reporting_periods: reportingWindow('sse', 'private', '2025-12-31') } });
    await expect(page).toHaveURL(/#\/projects\//);
    const projectId = created.project_id;
    expect(new URL(page.url()).hash.split('?')[0]).toBe(`#/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();

    const auditBytes = pdfSample();
    // setInputFiles bypasses disabled controls; wait for the real upload entry to be ready.
    await expect(page.getByLabel('为审计报告（可含报表及附注）选择文件')).toBeEnabled();
    const uploadComplete = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/materials/uploads/`) &&
      response.url().endsWith('/complete') && response.request().method() === 'POST' && response.status() !== 202);
    await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({
      name: 'synthetic-audit.pdf', mimeType: PDF, buffer: auditBytes
    });
    const uploadResponse = await uploadComplete;
    expect(uploadResponse.status()).toBe(200);
    const material = await uploadResponse.json() as Dto<'MaterialResponse'>;
    expect(material).toMatchObject({ material_version: 1, role: 'audit', state: 'persisted',
      sha256: createHash('sha256').update(auditBytes).digest('hex') });
    await expect(page.locator('.material-file-row').filter({ hasText: 'synthetic-audit.pdf' })).toContainText('服务器已确认保存 · 材料版本 1');

    // A new execution must satisfy today's mandatory source rule. This small DOCX
    // and its user-declared source metadata are synthetic, not reviewed business facts.
    await expect(page.locator('#execute-input')).toBeDisabled();
    const sourceBytes = await docxSample([], Buffer.from(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>纯合成测试，非客户募集书。${issuer}，上海证券交易所非公开发行公司债券募集说明书。原稿报告期为2022年度、2023年度、2024年度。</w:t></w:r></w:p></w:body></w:document>`));
    await expect(page.getByLabel('募集书新版本文件', { exact: true })).toBeEnabled();
    const sourceComplete = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/materials/uploads/`) &&
      response.url().endsWith('/complete') && response.request().method() === 'POST' && response.status() !== 202);
    await page.getByLabel('募集书新版本文件', { exact: true }).setInputFiles({
      name: 'synthetic-history.docx', mimeType: DOCX, buffer: sourceBytes
    });
    const sourceResponse = await sourceComplete;
    expect(sourceResponse.status(), await sourceResponse.text()).toBe(200);
    const historical = await sourceResponse.json() as Dto<'MaterialResponse'>;
    expect(historical).toMatchObject({ material_version: 1, role: 'historical', state: 'persisted',
      sha256: createHash('sha256').update(sourceBytes).digest('hex') });
    const source = page.locator(`[data-source-material="${historical.material_id}"]`);
    await expect(source).toBeVisible();
    await source.locator('[data-source-field="relation"]').selectOption('same_issuer');
    await source.locator('[data-source-field="market"]').selectOption('sse');
    await source.locator('[data-source-field="offering"]').selectOption('private');
    await source.locator('[data-source-field="year"]').selectOption('2024');
    await source.locator('[data-source-field="quarter"][value="12-31"]').check();
    await expect(source.locator('[data-source-required-message]')).toHaveText('原稿信息已填写完整。');
    await expect(page.locator('#save-state')).toHaveText('已保存');
    const materialPins = [material, historical].map(item => ({ material_id: item.material_id, material_version: 1 }))
      .sort((a, b) => a.material_id.localeCompare(b.material_id));
    const sourceDeclaration = { material_id: historical.material_id, material_version: 1, sha256: historical.sha256,
      issuer_name: null, relation: 'same_issuer', market: 'sse', offering: 'private',
      reporting_periods: reportingWindow('sse', 'private', '2024-12-31'), status: 'user_asserted' };

    const savingInput = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/input-revisions`) &&
      response.request().method() === 'POST');
    const checkingReadiness = page.waitForResponse(response => response.url().endsWith(`/projects/${projectId}/preflight`) &&
      response.request().method() === 'POST');
    const quoting = page.waitForResponse(response => response.url().endsWith(`/projects/${projectId}/credit-quote`) &&
      response.request().method() === 'POST');
    const executing = page.waitForResponse(response => response.url().endsWith('/runs/execute') && response.request().method() === 'POST');
    await expect(page.locator('#execute-input')).toBeEnabled();
    await page.getByRole('button', { name: '开始更新', exact: false }).click();
    const inputResponse = await savingInput;
    expect(inputResponse.status()).toBe(201);
    const input = await inputResponse.json() as {
      project_id: string; input_revision: number; input_hash: string;
      material_versions: { material_id: string; material_version: number }[];
      target_confirmation: { status: string; market: string | null; offering: string | null;
        document_purpose: string | null; as_of: string | null; target_reporting_periods: unknown[] };
    };
    expect(input.material_versions).toEqual(materialPins);
    expect(input.target_confirmation).toMatchObject({ status: 'unconfirmed', market: null, offering: null,
      document_purpose: null, as_of: null, target_reporting_periods: [] });

    const preflightResponse = await checkingReadiness;
    expect(preflightResponse.status()).toBe(200);
    const readiness = await preflightResponse.json() as Dto<'PreflightResponse'>;
    // Current unified authoring submits directly after ready preflight; target
    // confirmation remains explicitly unconfirmed in the immutable input.
    expect(readiness).toMatchObject({ project_id: projectId, input_revision: input.input_revision, input_hash: input.input_hash,
      status: 'ready', missing_inputs: [], uncertainty: [], blocking_inputs: [], advisory_inputs: [], billing_mode: 'fixed_credits' });
    const quoteResponse = await quoting;
    expect(quoteResponse.status(), await quoteResponse.text()).toBe(200);
    const quote = await quoteResponse.json() as Dto<'FixedQuoteResponse'>;
    expect(quote.enabled).toBe(true);
    expect(quote.quote).toMatchObject({ project_id: projectId, input_revision: input.input_revision, input_hash: input.input_hash,
      price_version: AUTOMATIC_PRICE_VERSION, quote_status: 'ready', auto_charge: true });
    expect(BigInt(quote.quote!.points)).toBeGreaterThan(0n);
    expect(BigInt(quote.shortage)).toBe(0n);

    const executeResponse = await executing;
    expect(executeResponse.status()).toBe(202);
    const run = await executeResponse.json() as { run_id: string; execution_request_id: string; state: string;
      project_id: string; input_revision: number; input_hash: string };
    expect(run).toMatchObject({ state: 'paused', project_id: projectId, input_revision: input.input_revision, input_hash: input.input_hash });
    expect(run.execution_request_id).toMatch(/^web-update-[a-f0-9]{64}$/);
    // Replay the complete actual request, including the input-bound quote identity.
    const executeRequest = executeResponse.request().postDataJSON() as Dto<'ExecuteRequest'>;
    expect(executeRequest).toEqual({ execution_request_id: run.execution_request_id, project_id: projectId,
      input_revision: input.input_revision, input_hash: input.input_hash, task_kind: 'update',
      input_manifest_ref: input.input_hash, storage_origin: 'cloud', workspace_id: projectId, quote_id: quote.quote!.quote_id });
    await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
    await expect(page.locator('#execution-progress')).toContainText('所需处理能力尚未就绪');

    const pinned = await pool.query(`SELECT r.id AS run_id,r.execution_request_id,r.state,r.input_revision,r.input_hash,
        i.manifest->'target_confirmation' AS target_confirmation,i.manifest->'update_details' AS update_details,i.material_versions,
        i.manifest->>'issuer_name' AS issuer_name,i.manifest->'authoring'->'source_prospectuses' AS sources,
        i.manifest->'materials' AS manifest_materials,
        e.type AS event_type,e.state AS event_state,e.payload
      FROM bb_runs r JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
      JOIN bb_run_events e ON e.owner_user_id=r.owner_user_id AND e.run_id=r.id AND e.seq=1
      WHERE r.owner_user_id=$1 AND r.project_id=$2`, [ownerId, projectId]);
    expect(pinned.rowCount).toBe(1);
    expect(pinned.rows[0]).toMatchObject({ run_id: run.run_id, execution_request_id: run.execution_request_id,
      state: 'paused', input_revision: input.input_revision, input_hash: input.input_hash, event_type: 'run.state_changed',
      event_state: 'paused', payload: { reason: 'capability_not_ready' }, material_versions: materialPins });
    expect(pinned.rows[0].update_details).toMatchObject({ authoring_mode: 'unified_v1', reporting_cutoff: '2025-12-31',
      target_reporting_periods: reportingWindow('sse', 'private', '2025-12-31'), source_prospectuses: [sourceDeclaration] });
    expect(pinned.rows[0].issuer_name).toBe(issuer);
    expect(pinned.rows[0].sources).toEqual([sourceDeclaration]);
    expect(pinned.rows[0].manifest_materials).toEqual([material, historical].map(item => ({
      material_id: item.material_id, material_version: 1, role: item.role, sha256: item.sha256
    })).sort((a, b) => a.material_id.localeCompare(b.material_id)));
    expect(pinned.rows[0].target_confirmation).toMatchObject(input.target_confirmation);

    const reservations = await pool.query('SELECT quote_id,points::text AS points FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2', [ownerId, run.run_id]);
    expect(reservations.rows).toEqual([{ quote_id: quote.quote!.quote_id, points: String(quote.quote!.points) }]);
    const stagedBalance = await creditBalanceExact(pool, ownerId);

    await page.context().close();
    reopenedContext = await browser.newContext({ baseURL: localOrigin, ignoreHTTPSErrors: true });
    const reopened = await reopenedContext.newPage();
    await bridgeApi(reopened, apiTarget);
    await reopened.goto('/');
    await reopened.getByLabel('用户名').fill(username);
    await reopened.getByLabel('密码').fill(password);
    await reopened.getByRole('button', { name: '登录', exact: true }).click();
    await expect(reopened.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
    await reopened.getByRole('link', { name: '任务进度与结果', exact: true }).first().click();
    await expect(reopened.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
    const projectRow = reopened.locator(`.collection-project[data-project-id="${projectId}"]`);
    await expect(projectRow.getByRole('link', { name: projectName, exact: true })).toBeVisible();
    await projectRow.locator('[data-tasks]').click();
    const task = reopened.locator(`.collection-task[data-run-id="${run.run_id}"]`);
    await expect(task).toContainText('已暂停');
    const taskLink = task.getByRole('link', { name: '查看任务', exact: true });
    await expect(taskLink).toHaveAttribute('href', `#/projects/${projectId}?from=projects&run=${run.run_id}`);
    const recoveredRunResponse = reopened.waitForResponse(response => response.url().endsWith(`/runs/${run.run_id}`) &&
      response.request().method() === 'GET');
    await taskLink.click();
    const recoveredResponse = await recoveredRunResponse;
    expect(recoveredResponse.status()).toBe(200);
    expect(await recoveredResponse.json()).toMatchObject({ run_id: run.run_id, execution_request_id: run.execution_request_id,
      project_id: projectId, input_revision: input.input_revision, input_hash: input.input_hash, state: 'paused' });
    await expect(reopened.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
    await expect(reopened.locator('#execution-progress .task-progress')).toHaveAttribute('data-input-revision', String(input.input_revision));
    await reopened.getByRole('button', { name: '查看材料', exact: true }).click();
    const recoveredMaterial = reopened.locator('.material-file-row').filter({ hasText: 'synthetic-audit.pdf' });
    await expect(recoveredMaterial).toBeVisible();
    await expect(recoveredMaterial).toContainText('服务器已确认保存');
    await expect(recoveredMaterial).toContainText('版本 1');
    const recoveredSource = reopened.locator('.material-file-row').filter({ hasText: 'synthetic-history.docx' });
    await expect(recoveredSource).toBeVisible();
    await expect(recoveredSource).toContainText('服务器已确认保存');
    await expect(recoveredSource).toContainText('版本 1');
    await expect(recoveredSource.locator('[data-source-field="relation"]')).toHaveValue('same_issuer');
    await expect(recoveredSource.locator('[data-source-field="market"]')).toHaveValue('sse');
    await expect(recoveredSource.locator('[data-source-field="offering"]')).toHaveValue('private');
    await expect(recoveredSource.locator('[data-source-field="year"]')).toHaveValue('2024');
    await expect(recoveredSource.locator('[data-source-field="quarter"][value="12-31"]')).toBeChecked();
    await expect(reopened.locator('#execution-progress')).toContainText('任务已暂停');
    await expect(reopened.locator('#execution-progress')).toContainText('所需处理能力尚未就绪');

    const repeated = await reopened.evaluate(async ({ request }) => {
      const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('bb_csrf='))?.slice('bb_csrf='.length) ?? '';
      const response = await fetch('/api/v1/runs/execute', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bb-csrf': csrf }, body: JSON.stringify(request) });
      return { status: response.status, body: await response.json() };
    }, { request: executeRequest });
    expect(repeated.status).toBe(202);
    expect(repeated.body.run_id).toBe(run.run_id);
    expect((await pool.query('SELECT count(*)::int AS n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2', [ownerId, projectId])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2', [ownerId, run.run_id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2', [ownerId, projectId])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT quote_id,points::text AS points FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2', [ownerId, run.run_id])).rows).toEqual(reservations.rows);
    expect(await creditBalanceExact(pool, ownerId)).toEqual(stagedBalance);
  } finally {
    if (reopenedContext) await reopenedContext.close();
    await app.close();
    await pool.end();
  }
});
