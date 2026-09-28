// Render the exact #85 fragment locally; no application API or customer data.
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
const root = resolve(import.meta.dirname, '../../..');
const ref = '46764161565027f332bdf28f8b335620bd035018';
const fragment = execFileSync('git', ['show', `${ref}:product-prototype/design-previews/update-workspace.fragment.html`], { cwd: root, encoding: 'utf8' });
const output = resolve(root, 'apps/web/ux-evidence/issue-18-trial');
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}</style>${fragment}</html>`);
  await page.locator('[data-action="stop"]').click();
  await page.getByRole('heading', { name: '更新已停止' }).waitFor();
  for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.screenshot({ path: join(output, `reference-${label}.png`), fullPage: true });
  }
} finally { await browser.close(); }
