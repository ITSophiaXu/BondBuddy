import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addActiveRun, assertFixture, expectNoExecution, fixture, historicalId, install, projectId, referenceId, sourceDeclaration, type State } from './authoring-source-guide-fixtures';

// Synthetic HTTP integration fixtures exercise the actual material controls and
// project save envelope. They do not claim a real worker or DOCX generation run.
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const pin = (m: State['materials'][number]) => ({ material_id: m.material_id, material_version: m.material_version, sha256: m.sha256 });
const choice = (page: Page, id: string) => page.locator(`[data-format-template="${id}"]`);
function data() {
  const s = fixture();
  for (const m of s.materials.filter(m => ['historical', 'reference'].includes(m.role))) {
    m.media_type = docx; m.filename = m.filename.replace(/\.pdf$/, '.docx');
  }
  s.project.update_details!.source_prospectuses = s.materials.filter(m => ['historical', 'reference'].includes(m.role)).map(m => sourceDeclaration(m));
  return s;
}
async function open(page: Page, s: State) {
  await install(page, s);
  await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('#workspace-material-count')).toContainText(`${s.materials.length} 份已保存材料`);
  await expect(page.locator('#material-editing')).toBeEnabled();
  await page.locator('#material-partitions').evaluate(node => { for (const detail of node.querySelectorAll('details')) detail.open = true; for (let p = node.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true; });
}
async function saved(page: Page, s: State, previous: number) {
  await expect.poll(() => s.patches.length).toBeGreaterThan(previous);
  await expect(page.locator('#save-state')).toHaveText('已保存');
}
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });
test.afterEach(async ({ page }) => { await assertFixture(page); });

test('one Word source is automatically displayed without an extra save or execution', async ({ page }) => {
  const s = data(); s.materials = s.materials.filter(m => m.material_id !== referenceId);
  s.project.update_details!.source_prospectuses = s.project.update_details!.source_prospectuses!.filter(m => m.material_id !== referenceId);
  await open(page, s);
  await expect(choice(page, historicalId)).toBeChecked();
  await expect(choice(page, historicalId).locator('..')).toContainText('自动选择');
  expect(s.patches).toEqual([]); expectNoExecution(s);
});

test('selecting another source persists its exact version and survives reload and metadata edits', async ({ page }) => {
  const s = data(); await open(page, s);
  await choice(page, referenceId).check(); await saved(page, s, 0);
  const expected = pin(s.materials.find(m => m.material_id === referenceId)!);
  expect(s.project.update_details!.format_template).toEqual(expected);
  await expect(choice(page, historicalId)).not.toBeChecked();
  await expect(page.locator('.source-format-notice')).toContainText('格式模板：');
  await page.reload();
  await expect(choice(page, referenceId)).toBeChecked();
  const previous = s.patches.length;
  const relation = page.locator(`[data-source-material="${referenceId}"] [data-source-field="relation"]`);
  await relation.evaluate(node => { for (let p = node.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true; });
  await relation.selectOption('parent'); await saved(page, s, previous);
  expect(s.project.update_details!.format_template).toEqual(expected);
  expectNoExecution(s);
});

test('reference-based generation also saves an explicit format source', async ({ page }) => {
  const s = data(); s.project.kind = 'generation'; await open(page, s);
  await choice(page, referenceId).check(); await saved(page, s, 0);
  expect(s.project.update_details!.format_template).toEqual(pin(s.materials.find(m => m.material_id === referenceId)!));
  expectNoExecution(s);
});

test('a replaced source never silently reuses the old pin; automatic selection can be restored', async ({ page }) => {
  const s = data(), m = s.materials.find(m => m.material_id === referenceId)!;
  s.project.update_details!.format_template = { ...pin(m), material_version: m.material_version - 1, sha256: 'f'.repeat(64) };
  await open(page, s);
  await expect(page.locator('.source-format-warning')).toContainText('已更换或移除');
  await expect(page.locator('[data-format-template]:checked')).toHaveCount(0);
  expect(s.patches).toEqual([]);
  await page.locator('[data-format-template-auto]').click(); await saved(page, s, 0);
  expect(s.project.update_details!.format_template).toBeNull();
  await expect(choice(page, historicalId)).toBeChecked();
  await expect(page.locator('.source-format-warning')).toHaveCount(0);
  expectNoExecution(s);
});

test('PDF selection states reconstruction and does not change source declarations', async ({ page }) => {
  const s = data(), pdf = s.materials.find(m => m.material_id === referenceId)!;
  pdf.media_type = 'application/pdf'; pdf.filename = '合成参考募集说明书.pdf';
  const declarations = structuredClone(s.project.update_details!.source_prospectuses);
  await open(page, s);
  await expect(choice(page, referenceId).locator('../..')).toContainText('PDF 原稿将重建');
  await choice(page, referenceId).check(); await saved(page, s, 0);
  expect(s.project.update_details!.format_template).toEqual(pin(pdf));
  expect(s.project.update_details!.source_prospectuses).toEqual(declarations);
  expectNoExecution(s);
});

test('an active task locks template edits including synthetic change events', async ({ page }) => {
  const s = data(); addActiveRun(s); await install(page, s);
  await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('#workspace-material-count')).toContainText(`${s.materials.length} 份已保存材料`);
  await expect(choice(page, referenceId)).toBeDisabled();
  await choice(page, referenceId).evaluate(node => { (node as HTMLInputElement).checked = true; node.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(900);
  expect(s.patches).toEqual([]); expect(s.project.update_details!.format_template).toBeUndefined(); expectNoExecution(s);
});

test('format choice matches the shared prototype at desktop and narrow widths', async ({ page }) => {
  const s = data(); await open(page, s);
  const directory = resolve('test-evidence/template-fidelity-20261029'); await mkdir(directory, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const fieldset = page.locator(`[data-source-material="${historicalId}"]`), actual = fieldset.locator('.source-format-choice');
    await actual.scrollIntoViewIfNeeded();
    const dimensions = await fieldset.evaluate(node => ({ width: node.getBoundingClientRect().width }));
    await actual.screenshot({ path: resolve(directory, `implementation-${width}.png`) });
    const prototype = await page.evaluate(async ({ modulePath, filename }) => {
      const { projectWorkspace } = await import(modulePath);
      const item = { key: 'synthetic-prototype-source', role: 'historical', stored: true, file: { name: filename, size: 4096 } };
      const draft = { projectId: 'synthetic-prototype-project', updateMode: 'full', exchange: 'sse', offering: 'private', year: '2026', quarter: '06-30', informationLayout: 'expanded', projectMessages: [], sourceProspectuses: { 'synthetic-prototype-source': { relation: 'same_issuer', market: 'sse', offering: 'private', year: '2023', quarter: '12-31' } } };
      const state = { accountEpoch: 1, route: 'update', step: 2, files: { update: [item] }, health: { authoringVersion: 2, projectInputVersion: 3, oneClickExecution: true } };
      const workspace = projectWorkspace({ state, esc: (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), icon: () => '', bytes: () => '4 KB', head: () => '', api: async () => ({}), post: async () => ({}), toast: () => {}, render: async () => {}, draft: () => draft, saveDraft: () => {}, authoring: {}, reportingPreview: () => '', refreshJobs: async () => {} });
      const template = document.createElement('template'); template.innerHTML = workspace.page('update');
      return template.content.querySelector('.source-format-choice')!.outerHTML;
    }, { modulePath: '/@fs/' + resolve('../../product-prototype/public/project-workspace.js').replaceAll('\\', '/'), filename: s.materials.find(m => m.material_id === historicalId)!.filename });
    await page.evaluate(({ width, choice, materialId }) => {
      const host = document.createElement('div'); host.id = 'format-prototype-reference';
      host.style.cssText = `position:fixed;inset:0 auto auto 0;width:${width}px;background:white;z-index:100000`;
      host.innerHTML = `<fieldset class="source-prospectus" style="box-sizing:border-box;width:${width}px"><legend>原稿信息（上传后必填）</legend>${choice}</fieldset>`;
      document.querySelector(`[data-source-material="${materialId}"]`)!.parentElement!.append(host);
    }, { width: dimensions.width, choice: prototype, materialId: historicalId });
    await expect(page.locator('#format-prototype-reference .source-format-choice')).toHaveText(await actual.innerText(), { useInnerText: true });
    await page.locator('#format-prototype-reference .source-format-choice').screenshot({ path: resolve(directory, `prototype-${width}.png`) });
    await page.locator('#format-prototype-reference').evaluate(node => node.remove());
    expect(await fieldset.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
});
