import { expect, test, type Page } from '@playwright/test';
import { reportingWindow } from '@bondbuddy/contracts';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertFixture, auditId, expectNoExecution, fixture, historicalId, install, now, projectId, referenceId, sourceDeclaration, type State } from './authoring-source-guide-fixtures';
import { fixtureRequest, fixtureBody, type Dto } from './billing-fixture-wire';

// Actual browser controls with synthetic HTTP data; no real extraction or model run.
function data() {
  const s = fixture();
  s.materials = s.materials.filter(m => m.material_id !== referenceId);
  s.materials[0].filename = '合成历史募集书.docx';
  s.materials[0].media_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  s.materials[1].filename = '合成2026年半年度财务报表.pdf';
  const d = s.project.update_details!;
  d.reporting_cutoff = '2025-12-31';
  d.target_reporting_periods = reportingWindow(s.project.market, s.project.offering, d.reporting_cutoff);
  d.source_prospectuses = [sourceDeclaration(s.materials[0], { reporting_periods: reportingWindow('sse', 'private', '2026-06-30') })];
  return s;
}
const sourceRow = (page: Page) => page.locator(`[data-source-material="${historicalId}"]`);
const materialHint = (page: Page) => page.locator(`[data-material-period-check="${auditId}"]`);
async function open(page: Page, s: State) {
  await install(page, s);
  await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('#workspace-material-count')).toContainText('2 份已保存材料');
  await expect(page.locator('#material-editing')).toBeEnabled();
  await page.locator('#material-partitions').evaluate(node => {
    for (const detail of node.querySelectorAll('details')) detail.open = true;
    for (let p = node.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
  });
}
async function saved(page: Page, s: State) {
  await expect.poll(() => s.patches.length).toBeGreaterThan(0);
  await expect(page.locator('#save-state')).toHaveText('已保存');
}
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });
test.afterEach(async ({ page }) => { await assertFixture(page); });

test('both inline hints leave input untouched and allow the normal explicit start', async ({ page }) => {
  const s = data(), before = structuredClone(s.project.update_details); await open(page, s);
  await expect(sourceRow(page).locator('[data-source-period-check]')).toContainText('原稿报告期填写为2026年6月末，晚于本次目标2025年末');
  await expect(materialHint(page)).toContainText('文件名显示财务期间可能截至2026年6月末');
  await expect(materialHint(page)).toContainText('报表正文');
  expect(s.patches).toEqual([]); expectNoExecution(s); expect(s.project.update_details).toEqual(before);
  await expect(page.locator('#execute-input')).toBeEnabled();
  await page.locator('#execute-input').click();
  await expect.poll(() => s.executes.length).toBe(1);
  expect(s.locked[0].project.update_details).toEqual(before);
  expect(s.calls.some(call => /recognition|source-profile|parse-job/.test(call.path))).toBe(false);
});

test('correcting the source removes its hint immediately while focus and target remain unchanged', async ({ page }) => {
  const s = data(); await open(page, s);
  const year = sourceRow(page).locator('[data-source-field="year"]');
  await year.focus(); const input = await year.elementHandle();
  await year.selectOption('2025');
  await expect(sourceRow(page).locator('[data-source-period-check]')).toBeEmpty();
  await expect(year).toBeFocused(); expect(await input!.evaluate(node => node.isConnected)).toBe(true);
  await sourceRow(page).locator('[data-source-field="quarter"][value="12-31"]').check();
  await saved(page, s);
  expect(s.project.update_details!.reporting_cutoff).toBe('2025-12-31');
  expect(s.project.update_details!.source_prospectuses![0].reporting_periods.at(-1)!.end).toBe('2025-12-31');
  await expect(materialHint(page)).toContainText('可能截至2026年6月末');
  expectNoExecution(s);
});

test('target area shows the same named anomalies and clears them after target correction and reload', async ({ page }) => {
  const s = data(), sources = structuredClone(s.project.update_details!.source_prospectuses); await open(page, s);
  await page.locator('#edit-project-details').click();
  const summary = page.locator('#draft-form [data-target-period-check]');
  await expect(summary.locator('.reporting-period-hint')).toHaveCount(2);
  await expect(summary).toContainText(s.materials[0].filename);
  await expect(summary).toContainText(s.materials[1].filename);
  // An unrelated assistant view must not have its hints changed by this form.
  await page.evaluate(() => { const host = document.createElement('div'); host.id = 'foreign-period-hint'; host.innerHTML = '<div data-target-period-check>另一个项目的提示</div>'; document.body.append(host); });
  await page.locator('#reporting-year').selectOption('2026');
  await page.locator('[name="reporting_quarter"][value="06-30"]').check();
  await expect(summary).toBeEmpty(); await saved(page, s);
  expect(s.project.update_details!.reporting_cutoff).toBe('2026-06-30');
  expect(s.project.update_details!.source_prospectuses).toEqual(sources);
  await expect(page.locator('#foreign-period-hint')).toHaveText('另一个项目的提示');
  await page.reload();
  await expect(page.locator('#reporting-year')).toHaveValue('2026');
  await expect(page.locator('[name="reporting_quarter"][value="06-30"]')).toBeChecked();
  await expect(page.locator('#draft-form [data-target-period-check]')).toBeEmpty();
  expectNoExecution(s);
});

test('ambiguous and date-only financial filenames never produce a warning', async ({ page }) => {
  const s = data();
  s.project.update_details!.source_prospectuses = [sourceDeclaration(s.materials[0])];
  for (const filename of ['2026-10-12_财务资料.pdf', '2026年半年度及2025年度财务报表.pdf']) {
    s.materials[1].filename = filename;
    if (filename.startsWith('2026-10')) await open(page, s); else await page.reload();
    await expect(materialHint(page)).toBeEmpty();
    await expect(sourceRow(page).locator('[data-source-period-check]')).toBeEmpty();
  }
  expectNoExecution(s); expect(s.patches).toEqual([]);
});

test('a newly saved financial upload shows its hint without a page reload or parsing request', async ({ page }) => {
  const s = data(); s.materials[1].filename = '合成2025年度审计报告.pdf'; await open(page, s);
  let declaration: Dto<'UploadCreateRequest'>;
  await page.route(`**/projects/${projectId}/materials/uploads`, async route => {
    declaration = fixtureRequest(route.request());
    await route.fulfill({ json: fixtureBody(route, { upload_id: 'period-upload', state: 'uploading', upload_url: '/api/v1/synthetic-period-bytes', expires_at: '2099-01-01T00:00:00Z', max_bytes: 104857600 }) });
  });
  await page.route('**/api/v1/synthetic-period-bytes', route => route.fulfill({ status: 204 }));
  await page.route('**/materials/uploads/period-upload/complete', async route => {
    const material: Dto<'MaterialResponse'> = { ...declaration, material_id: 'new-period-material', material_version: 1, upload_id: 'period-upload', state: 'persisted', persisted_at: now, error: null };
    s.materials.push(material); await route.fulfill({ json: fixtureBody(route, material) });
  });
  await page.locator('#upload-audit').setInputFiles({ name: '合成2026年半年度财务报表.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic period hint fixture\n%%EOF') });
  await expect(page.locator('[data-material-period-check="new-period-material"]')).toContainText('可能截至2026年6月末');
  expect(s.calls.some(call => /recognition|source-profile|parse-job/.test(call.path))).toBe(false);
  expect(s.project.update_details!.reporting_cutoff).toBe('2025-12-31'); expectNoExecution(s);
});

test('desktop and mobile warnings match the prototype with readable wrapping', async ({ page }) => {
  const s = data(); await open(page, s);
  const directory = test.info().outputPath('reporting-period-hints-20261105');
  await mkdir(directory, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const kind of ['source', 'material', 'target'] as const) {
      if (kind === 'target') await page.locator('#edit-project-details').click();
      const actual = kind === 'target' ? page.locator('#draft-form [data-target-period-check]') : kind === 'source' ? sourceRow(page).locator('.reporting-period-hint') : materialHint(page).locator('.reporting-period-hint');
      await actual.scrollIntoViewIfNeeded();
      await actual.evaluate(node => node.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: resolve(directory, `context-${kind}-${width}.png`) });
      await actual.screenshot({ path: resolve(directory, `implementation-${kind}-${width}.png`) });
      const dimensions = await actual.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, overflow: node.scrollWidth > node.clientWidth + 1 }));
      const actualText = await actual.innerText();
      expect(dimensions.overflow).toBe(false);
      const prototype = await page.evaluate(async ({ modulePath, kind }) => {
        const { projectWorkspace } = await import(modulePath);
        const items = [{ key: 'source', role: 'historical', stored: true, file: { name: '合成历史募集书.docx', size: 4096 } }, { key: 'audit', role: 'audit', stored: true, file: { name: '合成2026年半年度财务报表.pdf', size: 4096 } }];
        const draft = { projectId: 'synthetic', exchange: 'sse', offering: 'private', year: '2025', quarter: '12-31', projectMessages: [], sourceProspectuses: { source: { relation: 'same_issuer', market: 'sse', offering: 'private', year: '2026', quarter: '06-30' } } };
        const workspace = projectWorkspace({ state: { accountEpoch: 1, route: 'update', step: kind === 'target' ? 1 : 2, files: { update: items }, health: { authoringVersion: 2, projectInputVersion: 3, oneClickExecution: true } }, draft: () => draft, esc: (s: unknown) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), icon: () => '', bytes: () => '4 KB', head: () => '', api: async () => ({}), post: async () => ({}), toast: () => {}, render: async () => {}, saveDraft: () => {}, authoring: { optional: () => '' }, reportingPreview: () => '', refreshJobs: async () => {} });
        const template = document.createElement('template'); template.innerHTML = workspace.page('update');
        return template.content.querySelector(kind === 'target' ? '[data-target-period-check]' : `[data-reporting-period-hint="${kind}"]`)!.outerHTML;
      }, { modulePath: '/@fs/' + resolve('../../product-prototype/public/project-workspace.js').replaceAll('\\', '/'), kind });
      await actual.evaluate((node, html) => { const host = document.createElement('div'); host.id = 'period-prototype'; host.innerHTML = html; node.parentElement!.append(host); }, prototype);
      const reference = page.locator(kind === 'target' ? '#period-prototype [data-target-period-check]' : '#period-prototype .reporting-period-hint');
      await expect(reference).toHaveText(actualText, { useInnerText: true });
      expect(await reference.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))).toEqual({ width: dimensions.width, height: dimensions.height });
      await reference.evaluate(node => node.scrollIntoView({ block: 'center' }));
      await reference.screenshot({ path: resolve(directory, `prototype-${kind}-${width}.png`) });
      await page.locator('#period-prototype').evaluate(node => node.remove());
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#continue-materials').click();
  }
});
