import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { azureBlobs } from '../../api/dist/data.js';
import { runMaterialParseOnce } from '../../worker/src/material-parse-job.js';
import { runDocumentParser, validateDocumentParseResponse, type DocumentParseRequest } from '../../worker/src/document-parser.js';
import { account, login } from './live-helpers';

test.skip(process.env.BB_E2E_PARSE !== '1', 'Requires a dedicated migrated PostgreSQL/API/Azurite and Python, never production.');

test('real upload/worker/Python profile, one durable job after reuse, reopen/relogin, OCR pause and foreign denial', async ({ page, context, playwright }) => {
  test.setTimeout(120000);
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const python = process.env.BB_PYTHON ?? 'python3';
  const fixtures = mkdtempSync(join(tmpdir(), 'bb-recognition-synthetic-'));
  const filename = join(fixtures, 'synthetic-history.docx');
  // A small, explicitly synthetic native DOCX. No customer data, model calls or parser-response fixtures.
  execFileSync(python, ['-c', "import sys\nfrom docx import Document\nd=Document()\nd.add_heading('募集说明书封面',1)\nd.add_paragraph('本期债券发行场所：上海证券交易所。')\nd.add_paragraph('本期债券采取非公开发行方式。')\nd.add_heading('本次发行概况',1)\nd.add_paragraph('本期债券在上海证券交易所发行。')\nd.add_paragraph('本期公司债券采用私募发行。')\nd.add_heading('财务会计信息',1)\nd.add_paragraph('合并财务报表报告期：2022年度、2023年度、2024年度。')\nd.save(sys.argv[1])", filename]);
  const pool = new Pool({ connectionString: process.env.BB_TEST_DATABASE_URL });
  const blobs = azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING!);
  const parser = async (request: DocumentParseRequest) => {
    if (process.platform !== 'win32') return runDocumentParser(request, { pythonExecutable: python, repoRoot: root });
    // The production bridge targets Linux and accepts POSIX staging paths only. On Windows
    // run the same real Python module on its trusted native staging path, validating the result.
    // This harness does not establish Windows worker/production deployment acceptance.
    const output = execFileSync(python, ['-m', 'bondbuddy_document_parser'], { cwd: root,
      env: { ...process.env, PYTHONPATH: join(root, 'python'), PYTHONUTF8: '1' }, input: JSON.stringify(request), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return validateDocumentParseResponse(JSON.parse(output), request);
  };
  const worker = () => runMaterialParseOnce({ pool, material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key) }, parser } });
  let projectId: string | undefined;
  try {
    const user = await account(playwright), foreign = await account(playwright);
    await login(page, user);
    const newProject = page.locator('#main > .page-head').getByRole('link', { name: '新建项目', exact: true });
    await expect(newProject).toHaveAttribute('href', '#/new');
    await newProject.click();
    const issuer = '合成上传识别联调有限公司', projectName = `${issuer}-交易商协会-MTN · 中期票据-募集书更新`;
    await page.getByLabel('发行人全称', { exact: true }).fill(issuer);
    await page.getByLabel('发行市场', { exact: true }).selectOption('nafmii');
    await page.getByLabel('发行方式', { exact: true }).selectOption('mtn');
    await expect(page.locator('#generated-project-name')).toHaveText(projectName);
    await page.getByRole('button', { name: '创建项目，继续提供材料' }).click();
    await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
    projectId = decodeURIComponent(new URL(page.url()).hash.split('/').at(-1)!);
    // The real upload-confirmation consumer finalizes the original declaration after 202.
    const completedUpload = () => page.waitForResponse(r => r.url().includes(`/projects/${projectId}/materials/uploads/`) && r.url().endsWith('/complete') && r.request().method() === 'POST' && r.status() !== 202);
    const savedResponse = completedUpload();
    const sourceFile = () => page.getByLabel('募集书新版本文件', { exact: true });
    await expect(sourceFile()).toBeEnabled();
    await sourceFile().setInputFiles(filename);
    await expect(page.locator('.material-file-row').filter({ hasText: 'synthetic-history.docx' })).toContainText('服务器已确认保存', { timeout: 15000 });
    const saved = await savedResponse; expect(saved.status()).toBe(200); const material = await saved.json();
    await expect(page.locator('.material-processing')).toContainText('等待处理');
    await expect(page.locator('.source-profile')).toHaveCount(0);
    const route = page.url(); await page.close(); page = await context.newPage(); await page.goto(route);
    await expect(page.locator('.material-processing')).toContainText('等待处理');
    expect(await worker()).toBe('succeeded');
    await expect(page.locator('.material-processing')).toContainText('处理完成', { timeout: 20000 });
    await expect(page.locator('.source-profile, [data-source-correction]')).toHaveCount(0);
    const profile = await page.evaluate(async path => (await fetch(path)).json(), `/api/v1/projects/${projectId}/materials/${material.material_id}/source-profile`);
    expect(profile.source_market.value).toBe('sse');
    expect(profile.source_offering.value).toBe('private');
    expect(profile.latest_reporting_cutoff.value).toBe('2024-12-31');
    await expect(page.getByLabel('发行市场', { exact: true })).toHaveValue('nafmii');
    await expect(page.getByLabel('发行方式', { exact: true })).toHaveValue('mtn');
    const reusedResponse = completedUpload();
    await expect(sourceFile()).toBeEnabled();
    await sourceFile().setInputFiles({ name: 'renamed-history.docx', mimeType: material.media_type, buffer: readFileSync(filename) });
    const reused = await reusedResponse; expect(reused.status()).toBe(200);
    expect(await reused.json()).toMatchObject({ material_id: material.material_id, material_version: material.material_version, sha256: material.sha256, upload_id: material.upload_id });
    await expect(page.locator('#prospectus-status')).toContainText('已保存并自动采用 V1 · synthetic-history.docx');
    await expect(page.locator('[data-prospectus-files] [data-prospectus-version]')).toHaveCount(1);
    await expect(page.locator('.material-file-row')).toHaveCount(1);
    expect((await pool.query("SELECT id FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [material.material_id])).rowCount).toBe(1);
    expect(await worker()).toBe('idle');
    expect((await pool.query('SELECT id FROM bb_runs WHERE project_id=$1', [projectId])).rowCount).toBe(0);
    expect((await pool.query('SELECT profile_version FROM bb_historical_profiles WHERE material_id=$1', [material.material_id])).rowCount).toBe(1);

    const scanResponse = completedUpload();
    await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({ name: 'synthetic-scan.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    expect((await scanResponse).status()).toBe(200); expect(await worker()).toBe('paused');
    await expect(page.locator('.material-file-row').filter({ hasText: 'synthetic-scan.png' })).toContainText('处理暂缓', { timeout: 20000 });
    await page.getByRole('button', { name: '退出', exact: true }).click(); await login(page, user); await page.goto(route);
    await expect(page.locator('.material-file-row').filter({ hasText: 'synthetic-history.docx' })).toContainText('处理完成');
    await expect(page.locator('.source-profile')).toHaveCount(0);
    await expect(page.locator('.material-file-row').filter({ hasText: 'synthetic-scan.png' })).toContainText('处理暂缓');
    await page.getByRole('button', { name: '退出', exact: true }).click(); await login(page, foreign); await page.goto(route);
    await expect(page.getByText('无法访问这个项目，它可能已移除或不属于当前账号。')).toBeVisible();
    for (const suffix of ['parse-job', 'source-profile']) {
      // Browser fetch keeps the real Secure-cookie session on trustworthy localhost;
      // Playwright's Node HTTP context does not send Secure cookies over local HTTP.
      const status = await page.evaluate(async path => (await fetch(path, { credentials: 'same-origin' })).status, `/api/v1/projects/${projectId}/materials/${material.material_id}/${suffix}`);
      expect(status).toBe(404);
    }
    await expect(page.locator('.source-profile')).toHaveCount(0);
  } finally {
    // This dedicated test creates a paused OCR job. Retire only this test's jobs so later
    // worker drains never claim them; preserve all material/profile/log evidence.
    if (projectId) await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE project_id=$1 AND job_type='parse' AND state IN ('queued','running','paused')", [projectId]);
    await pool.end(); rmSync(filename); rmdirSync(fixtures);
  }
});
