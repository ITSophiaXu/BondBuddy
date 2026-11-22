import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { syncIntegrityCompositor } from './integrity-desktop.js';

test(
  'visible official results can be captured while a remote font never finishes',
  { skip: !process.env.BB_TEST_INTEGRITY_BROWSER, timeout: 15000 },
  async () => {
    const browser = await chromium.launch({ headless: true }),
      page = await browser.newPage();
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/*', async (route) => {
      if (route.request().url().endsWith('/font.woff2')) {
        await blocked;
        await route.abort().catch(() => {});
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<style>@font-face{font-family:remote;src:url(/font.woff2)}body{font-family:remote,serif}</style><p>查询结果：共 14 条</p>',
      });
    });
    try {
      await page.goto('http://official.test/', { waitUntil: 'domcontentloaded' });
      await page.getByText('查询结果：共 14 条').waitFor();
      assert.equal(await page.evaluate(() => document.fonts.status), 'loading');
      await syncIntegrityCompositor(page);
      assert.equal(await page.evaluate(() => document.fonts.status), 'loading');
    } finally {
      release();
      await browser.close();
    }
  },
);
