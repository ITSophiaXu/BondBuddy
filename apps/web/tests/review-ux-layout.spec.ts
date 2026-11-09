import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { install, mount, file, recovery, noBusiness } from './review-upload-twelfth-fixtures';
import { hold } from './upload-progress-fixtures';

const evidence = 'test-evidence/review-ux-20261109';
const projectName = '合成交通投资集团有限公司-上交所-普通私募公司债-募集书复核';
const sourceFile = { ...file, name: '合成交通投资集团有限公司2026年面向专业投资者非公开发行公司债券募集说明书.docx' };

async function styles(page: Page) {
  // Match the final production cascade, including the document workspace layout.
  for (const name of ['workspace-typography', 'desktop-workspace-polish', 'document-workspace']) {
    await page.addStyleTag({ content: await readFile(`../../product-prototype/public/${name}.css`, 'utf8') });
  }
}
async function screenshot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${process.env.BB_REVIEW_UX_BASELINE ? 'before-' : ''}${name}.png` });
}

for (const width of [2560, 1440, 390, 320]) {
  test(`review header keeps a single project identity at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const state = await install(page); state.project.name = projectName;
    await mount(page); await styles(page);
    await screenshot(page, `header-${width}`);
    const header = page.locator('.review-header');
    await expect(header.getByRole('heading', { name: '复核募集说明书', exact: true })).toBeVisible();
    await expect(header.getByText(projectName, { exact: true })).toBeVisible();
    await expect(header.getByText(state.project.issuer_name!, { exact: true })).toHaveCount(0);
    await expect(header.getByText(/提供复核材料和要求/)).toHaveCount(0);
    await expect(header.getByRole('link', { name: '更换项目' })).toHaveAttribute('href', '#review');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    noBusiness(state);
  });

  test(`review upload and saving use the material width at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const state = await install(page);
    state.materials.clear(); state.draft.source_material_ref = null;
    state.draft.material_versions = []; state.draft.evidence_links = [];
    await mount(page); await styles(page); await hold(page);
    await page.locator('[data-review-upload-role=historical]').setInputFiles(sourceFile);
    const row = recovery(page, sourceFile.name);
    const group = page.locator('[data-review-drop=historical]');
    const progress = row.locator('.file-upload-progress');
    await expect(row.getByRole('progressbar')).toHaveAttribute('value', '40');
    await group.scrollIntoViewIfNeeded();
    await screenshot(page, `upload-${width}`);
    async function aligned() {
      const upload = (await group.locator('.material-picker').boundingBox())!;
      const activity = (await progress.boundingBox())!;
      expect(Math.abs(activity.x - upload.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(activity.width - upload.width)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await aligned();
    await page.evaluate(() => (window as any).releaseBytes());
    await expect(row.getByRole('progressbar')).not.toHaveAttribute('value');
    await expect(row).toContainText('正在保存');
    await screenshot(page, `saving-${width}`); await aligned();
    await expect.poll(() => page.evaluate(() => typeof (window as any).releaseSave)).toBe('function');
    await page.evaluate(() => (window as any).releaseSave());
    await expect(row).toHaveCount(0);
    await expect(page.locator('.review-selected-source')).toContainText(sourceFile.name);
    noBusiness(state);
  });
}
