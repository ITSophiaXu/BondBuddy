import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test('financial upload guidance prototype uses the same periods at desktop and mobile widths', async ({ page }) => {
  await page.route('http://prototype.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/project-workspace.css"></head><body><main id="preview"></main></body></html>' });
    if (!/^\/[\w.-]+$/.test(path)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile('../../product-prototype/public' + path), contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css' });
  });
  await page.goto('http://prototype.test/');
  await page.evaluate(async () => {
    const path = '/project-workspace.js'; const { projectWorkspace } = await import(path);
    const d = { title: '合成项目', issuer: '合成发行人', exchange: 'sse', offering: 'private', year: '2026', quarter: '06-30', updateMode: 'full', informationLayout: 'expanded', projectMessages: [] };
    const noop = () => {};
    const workspace = projectWorkspace({ state: { route: 'update', accountEpoch: 1, step: 2, files: { update: [] }, health: { authoringVersion: 2, projectInputVersion: 3, oneClickExecution: true } }, draft: () => d, saveDraft: noop, esc: (s: unknown) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;'), icon: () => '', bytes: String, head: () => '', api: noop, post: noop, toast: noop, render: noop, authoring: {}, reportingPreview: noop, refreshJobs: noop });
    document.querySelector('#preview')!.innerHTML = workspace.page('update');
  });
  await page.addStyleTag({ content: '.authoring-actions { visibility: hidden; }' }); // Isolate the upload group in this region-only comparison.
  const guide = page.getByRole('complementary', { name: '需要准备的财务材料' });
  await expect(guide.locator('li')).toHaveText(['2024年度审计报告（含财务报表及附注）', '2025年度审计报告（含财务报表及附注）', '2026年1—6月财务报表']);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
    await expect(guide).toBeVisible();
    if (process.env.BB_GUIDANCE_EVIDENCE) {
      const dir = 'test-evidence/financial-guidance-20261010'; await mkdir(dir, { recursive: true });
      const group = guide.locator('..');
      await group.evaluate((el, width) => { (el as HTMLElement).style.width = `${width === 390 ? 301 : 960}px`; (el as HTMLElement).style.maxWidth = '100%'; }, width);
      await group.screenshot({ path: `${dir}/prototype-${width}.png` });
    }
  }
});
