import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { validateTestDatabase } from './prospectus-quality-gate.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
const command = (...args) => execFileSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('synthetic browser upload, adoption and execution preserve the exact source in real API/PG input',
  { timeout: 210_000 }, async t => {
    const cleanup = [];
    t.after(async () => {
      const errors = [];
      for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'Browser input cleanup failed');
    });
    assert.equal(process.env.BB_PROSPECTUS_BROWSER_ISOLATED, '1', 'Use the credential-free runner');
    validateTestDatabase(process.env.BB_TEST_DATABASE_URL);
    for (const key of Object.keys(process.env)) {
      assert.ok(!/TOKEN|SECRET|API_KEY|PASSWORD|CONNECTION_STRING|DATABASE_URL$/.test(key) || key === 'BB_TEST_DATABASE_URL', key);
    }
    // Observe and reject off-host Node sockets before loading the API and storage SDK.
    // No API request, repository, principal, database result or locked input is mocked.
    const remoteSockets = [];
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const values = Array.isArray(args[0]) ? args[0] : args;
      const first = values[0];
      const host = typeof first === 'object' ? first?.host ?? first?.hostname ?? 'localhost'
        : typeof values[1] === 'string' ? values[1] : 'localhost';
      if (!loopback(host)) { remoteSockets.push(host); throw Error('BROWSER_INPUT_EXTERNAL_SOCKET_BLOCKED'); }
      return originalConnect.apply(this, args);
    };
    cleanup.push(() => { net.Socket.prototype.connect = originalConnect; });
    const [{ Pool }, { chromium, expect }, { createServer: createViteServer }, { createServer },
      { azureBlobs }, { makeSyntheticDocxFixture }, { pdfSample },
      { inputManifestHash }, { editingSource }, { loadUnifiedInput, unifiedInputGate }, { runUploadConfirmationOnce }] = await Promise.all([
      import('pg'), import('@playwright/test'), import('vite'), import('../apps/api/dist/server.js'),
      import('../apps/api/dist/data.js'),
      import('../apps/api/dist/docx-fixtures.js'), import('../apps/api/dist/upload-safety.samples.js'),
      import('../apps/api/dist/production-rule-pin.js'), import('../apps/worker/dist/file-authoring-stage.js'),
      import('../apps/worker/dist/unified-input.js'), import('../apps/api/dist/upload-confirmation.js')
    ]);
    assert.match(new URL(process.env.BB_TEST_DATABASE_URL).pathname, /^\/bb_prospectus_quality_browser_[a-f0-9]{32}$/);
    const pool = new Pool({ connectionString: process.env.BB_TEST_DATABASE_URL });
    cleanup.push(() => pool.end());
    const version = Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(version >= 160000 && version < 170000, 'PostgreSQL 16 is required');
    const work = await mkdtemp(resolve(process.env.HOME, 'browser-fixture-'));
    cleanup.push(() => rm(work, { recursive: true, force: true }));
    const storagePort = Number(process.env.BB_PROSPECTUS_BROWSER_STORAGE_PORT);
    assert.ok(storagePort > 0 && storagePort <= 65535);
    // SDK expands only the public Azurite development account, never a production key.
    const developmentKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
    const azurite = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${developmentKey};BlobEndpoint=http://127.0.0.1:${storagePort}/devstoreaccount1;`;
    const blobs = azureBlobs(azurite, 'synthetic-prospectus-input');
    await blobs.put('readiness', Buffer.from('synthetic'), 'text/plain');
    command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', resolve(work, 'key.pem'), '-out', resolve(work, 'cert.pem'));
    let apiProxy;
    const web = await createViteServer({ configFile: false, root: resolve('apps/web'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true,
        https: { key: await readFile(resolve(work, 'key.pem')), cert: await readFile(resolve(work, 'cert.pem')) },
        proxy: { '/api/v1': { target: 'http://127.0.0.1:1', configure: proxy => { apiProxy = proxy; } } } } });
    cleanup.push(() => web.close());
    await web.listen();
    const origin = `https://127.0.0.1:${web.httpServer.address().port}`;
    const app = createServer({ pool, blobs, allowedOrigin: origin, auth: { termsVersion: 'synthetic-browser-input-v1' },
      enableRunRuntime: true, enableSyntheticQueue: false, enableRunStaging: false });
    cleanup.push(() => app.close());
    const api = await app.listen({ host: '127.0.0.1', port: 0 });
    apiProxy.options.target = api;
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
    cleanup.push(() => browser.close());
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    const browserExternal = [];
    context.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) browserExternal.push(url.origin);
    });
    const page = await context.newPage();
    const username = `bb${randomUUID().replaceAll('-', '').slice(0, 16)}`, password = `Synthetic-${randomUUID()}-Only`;
    // Fixture account setup uses HTTP registration; the browser logs in through the normal UI.
    const registration = await context.request.post(`${origin}/api/v1/auth/register`, {
      headers: { origin }, data: { username, password, accepted_terms_version: 'synthetic-browser-input-v1' } });
    assert.equal(registration.status(), 201, await registration.text());
    const owner = (await registration.json()).user_id;
    await context.clearCookies();
    const login = async target => {
      await target.goto('/');
      await target.getByLabel('用户名', { exact: true }).fill(username);
      await target.getByLabel('密码', { exact: true }).fill(password);
      await target.getByRole('button', { name: '登录', exact: true }).click();
      await expect(target.getByRole('link', { name: '更新募集书', exact: true })).toBeVisible();
    };
    await login(page);
    await page.getByRole('link', { name: '更新募集书', exact: true }).click();
    await page.getByRole('link', { name: '＋ 新建项目', exact: true }).click();
    await page.locator('#issuer').fill('合成输入链发行人有限公司');
    await page.locator('#market').selectOption('szse');
    await page.locator('#offering').selectOption('private');
    await page.locator('#reporting-year').selectOption('2025');
    await page.getByRole('radio', { name: '9月末', exact: true }).check();
    await page.getByRole('button', { name: '创建项目，继续提供材料', exact: true }).click();
    await expect(page.locator('#project-heading')).toContainText('合成输入链发行人有限公司');
    const projectId = new URL(page.url()).hash.split('/').at(-1);
    const projectUrl = page.url();
    const sourceBytes = makeSyntheticDocxFixture({ text: '合成原稿；2024年度；只验证输入链，不是客户资料。' });
    const financialBytes = pdfSample({ tag: 'synthetic-2025-Q3' });
    const uploaded = async (label, name, mimeType, buffer) => {
      const pending = page.waitForResponse(r => r.request().method() === 'POST' &&
        r.url().includes(`/projects/${projectId}/materials/uploads/`) && r.url().endsWith('/complete'));
      await page.getByLabel(label, { exact: true }).setInputFiles({ name, mimeType, buffer });
      const confirming = await pending;
      assert.equal(confirming.status(), 202, await confirming.text());
      assert.equal(confirming.request().headers().prefer, 'respond-async');
      assert.equal(confirming.headers()['retry-after'], '2');
      const upload = await confirming.json();
      assert.equal(upload.status, 'confirming');
      assert.ok(confirming.url().endsWith(`/uploads/${upload.upload_id}/complete`));
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE upload_id=$1',
        [upload.upload_id])).rows[0].n, 0, 'Pending confirmation must not publish material');
      // Run the production upload-only consumer against real PG/Blob. Do not start
      // the worker runtime, parse queue or any model/provider execution loops.
      const completed = page.waitForResponse(r => r.request().method() === 'POST' &&
        r.url() === confirming.url() && r.status() !== 202);
      assert.equal(await runUploadConfirmationOnce(pool, blobs), 'completed');
      const response = await completed;
      assert.equal(response.status(), 200, await response.text());
      assert.deepEqual(response.request().postDataJSON(), confirming.request().postDataJSON());
      const material = await response.json();
      assert.equal(material.sha256, hash(buffer));
      assert.equal(material.byte_size, buffer.length);
      const confirmation = (await pool.query(`SELECT c.state,c.result,o.delivered_at
        FROM bb_upload_confirmations c JOIN bb_outbox o ON o.id=c.outbox_id WHERE c.upload_id=$1`,
      [upload.upload_id])).rows;
      assert.equal(confirmation.length, 1);
      assert.equal(confirmation[0].state, 'completed');
      assert.deepEqual(confirmation[0].result, material);
      assert.ok(confirmation[0].delivered_at);
      return material;
    };
    const source = await uploaded('募集书新版本文件', 'synthetic-source.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sourceBytes);
    // Current upload may auto-adopt; if it offers adoption, use the real confirmation controls.
    if (await page.locator('[data-use-version]').count()) {
      await page.locator('[data-use-version]').first().click();
      await page.locator('#confirm-prospectus-selection').click();
    }
    await expect(page.getByLabel('原发行市场', { exact: true })).toBeVisible();
    await page.getByLabel('与目标发行人的关系', { exact: true }).selectOption('same_issuer');
    await page.getByLabel('原发行市场', { exact: true }).selectOption('szse');
    await page.getByLabel('原品种', { exact: true }).selectOption('private');
    await page.getByLabel('原稿最新报告期年份', { exact: true }).selectOption('2024');
    await page.getByRole('radio', { name: '年末', exact: true }).check();
    const financial = await uploaded('为审计报告（可含报表及附注）选择文件', 'synthetic-financial.pdf', 'application/pdf', financialBytes);
    await expect(page.locator('#save-state')).toHaveText('已保存');
    await expect(page.locator('#execute-input')).toBeEnabled();
    const locking = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/projects/${projectId}/input-revisions`));
    const executing = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/runs/execute'));
    await page.locator('#execute-input').click();
    const locked = await locking;
    assert.equal(locked.status(), 201, await locked.text());
    const input = await locked.json();
    const execution = await executing;
    assert.equal(execution.status(), 202, await execution.text());
    const run = await execution.json();
    const persisted = (await pool.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner, projectId, input.input_revision])).rows[0];
    const manifest = persisted.manifest;
    assert.equal(inputManifestHash(manifest), input.input_hash);
    assert.equal(persisted.input_hash.trim(), input.input_hash);
    const expectedPins = [
      { material_id: source.material_id, material_version: source.material_version, role: 'historical', sha256: hash(sourceBytes) },
      { material_id: financial.material_id, material_version: financial.material_version, role: 'audit', sha256: hash(financialBytes) }
    ].sort((a, b) => a.material_id.localeCompare(b.material_id));
    assert.deepEqual([...manifest.materials].sort((a, b) => a.material_id.localeCompare(b.material_id)), expectedPins);
    assert.equal(manifest.issuer_name, '合成输入链发行人有限公司');
    assert.equal(manifest.update_details.reporting_cutoff, '2025-09-30');
    assert.equal(manifest.update_details.target_reporting_periods.at(-1).end, '2025-09-30');
    assert.equal(manifest.authoring.source_prospectuses[0].reporting_periods.at(-1).end, '2024-12-31');
    assert.equal(manifest.authoring.source_prospectuses[0].relation, 'same_issuer');
    assert.equal(manifest.authoring.format_policy.mode, 'preserve_docx');
    assert.deepEqual(manifest.authoring.format_policy.template, { kind: 'material', material_id: source.material_id,
      material_version: source.material_version, sha256: hash(sourceBytes) });
    const runRow = (await pool.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2', [run.run_id, owner])).rows[0];
    assert.equal(runRow.input_hash.trim(), input.input_hash);
    assert.equal(runRow.state, 'queued');
    // Stop at the actual worker input boundary. No worker/model executor is started.
    assert.equal(await unifiedInputGate(pool, runRow, persisted), null);
    const loaded = await loadUnifiedInput({ pool, run: runRow }, { originalFiles: true });
    assert.deepEqual(editingSource(loaded).pin, expectedPins.find(pin => pin.role === 'historical'));
    const counters = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM bb_input_revisions WHERE project_id=$1) inputs,
      (SELECT count(*)::int FROM bb_runs WHERE project_id=$1) runs,
      (SELECT count(*)::int FROM bb_outbox WHERE aggregate_id=$1 OR aggregate_id IN (SELECT id FROM bb_runs WHERE project_id=$1)) outbox,
      (SELECT count(*)::int FROM bb_jobs WHERE run_id IN (SELECT id FROM bb_runs WHERE project_id=$1)) jobs,
      (SELECT count(*)::int FROM bb_run_events WHERE run_id IN (SELECT id FROM bb_runs WHERE project_id=$1)) events,
      (SELECT coalesce(sum(event_cursor),0)::int FROM bb_runs WHERE project_id=$1) event_cursor`, [projectId])).rows[0];
    const stable = await counters();
    const browserPost = (path, body) => page.evaluate(async ({ path, body }) => {
      const csrf = document.cookie.split('; ').find(value => value.startsWith('bb_csrf='))?.slice(8) ?? '';
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bb-csrf': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { path, body });
    const originalRequest = locked.request().postDataJSON();
    const omitted = await browserPost(`/api/v1/projects/${projectId}/input-revisions`, {
      ...originalRequest, material_versions: originalRequest.material_versions.filter(pin => pin.material_id !== source.material_id) });
    assert.equal(omitted.status, 409);
    assert.deepEqual(await counters(), stable, 'Rejected omission must not write input/run/outbox');
    const wrongVersion = await browserPost(`/api/v1/projects/${projectId}/input-revisions`, {
      ...originalRequest, material_versions: originalRequest.material_versions.map(pin => pin.material_id === source.material_id
        ? { ...pin, material_version: pin.material_version + 1 } : pin) });
    assert.equal(wrongVersion.status, 404);
    assert.equal(wrongVersion.body.code, 'NOT_FOUND');
    assert.deepEqual(await counters(), stable);
    const repeated = await browserPost('/api/v1/runs/execute', execution.request().postDataJSON());
    assert.equal(repeated.status, 202);
    assert.equal(repeated.body.run_id, run.run_id);
    assert.deepEqual(await counters(), stable);
    await context.clearCookies();
    await login(page);
    await page.goto(projectUrl);
    await expect(page.locator('#project-heading')).toContainText('合成输入链发行人有限公司');
    await expect(page.getByLabel('原稿最新报告期年份', { exact: true })).toHaveValue('2024');
    assert.equal((await pool.query('SELECT input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
      [projectId, input.input_revision])).rows[0].input_hash.trim(), input.input_hash);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_provider_call_observations')).rows[0].n, 0);
    assert.deepEqual(remoteSockets, []);
    assert.deepEqual(browserExternal, []);
    t.diagnostic('Real browser/API/PostgreSQL/Azurite and upload confirmation consumer; synthetic inputs; model boundary not executed; provider records and off-host sockets = 0.');
  });
