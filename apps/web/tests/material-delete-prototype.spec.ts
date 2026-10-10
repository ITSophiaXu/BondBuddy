import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test('review prototype offers visible delete actions and preserves result view', async ({ page }) => {
  await page.route('http://prototype.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!/^\/[\w.-]+$/.test(path)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile('../../product-prototype/public' + path), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://prototype.test/review-v2.html#materials');
  const buttons = page.locator('[data-action=delete-file]'); await expect(buttons.first()).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
    if (process.env.BB_DELETE_EVIDENCE) { const dir = 'test-evidence/material-delete-20261010'; await mkdir(dir, { recursive: true }); await page.locator('.material-list').first().screenshot({ path: `${dir}/prototype-review-${width}.png` }); }
  }
  const count = await buttons.count(); page.on('dialog', dialog => dialog.accept()); await buttons.first().click(); await expect(buttons).toHaveCount(count - 1);
  await page.locator('[data-tab=results]').click(); await expect(page.locator('.finding-card').first()).toBeVisible();
});

test('material studio prototype shows a visible delete action for an uploaded source', async ({ page }) => {
  await page.route('http://prototype.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/project-workspace.css"></head><body><main id="preview"></main></body></html>' });
    if (!/^\/[\w.-]+$/.test(path)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile('../../product-prototype/public' + path), contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css' });
  });
  await page.goto('http://prototype.test/');
  await page.evaluate(async () => {
    const path = '/material-studio.js'; const { materialStudio } = await import(path); const noop = () => {};
    const state = { health: { materialStudioVersion: 1 }, jobs: [], materialDraft: { type: 'summary', market: 'sse', sourceMode: 'upload', summaryKind: 'private', instructionMessages: [], templates: [], files: [{ role: 'prospectus', file: { name: '误传募集书.docx', size: 2000 } }] } };
    document.querySelector('#preview')!.innerHTML = materialStudio({ state, esc: String, icon: () => '', bytes: () => '2 KB', head: () => '', api: noop, upload: noop, render: noop, toast: noop, refreshJobs: noop }).page();
  });
  const row = page.locator('.file-item'); await expect(row.getByRole('button', { name: '删除 误传募集书.docx', exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
    if (process.env.BB_DELETE_EVIDENCE) await row.screenshot({ path: `test-evidence/material-delete-20261010/prototype-material-source-${width}.png` });
  }
});
