import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test('review setup design snapshot supports scope details and automatic naming without submission', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://prototype.test/**', async route => {
    if (new URL(route.request().url()).pathname !== '/review-setup.html') return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: 'text/html', body: await readFile('../../product-prototype/public/review-setup.html') });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1040 : 844 });
    await page.goto('http://prototype.test/review-setup.html');
    const form = page.locator('#review-create-form');
    await expect(form.locator('details[open]')).toHaveCount(0);
    await expect(page.locator('#generated-review-name')).toHaveText('合成发行人有限公司-上交所-普通私募公司债-募集书复核');
    await expect(page.locator('#review-create-status')).toBeEmpty();
    const dir = 'test-evidence/review-setup-20261011';
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/prototype-collapsed-${width}.png`, fullPage: true });
    await form.locator('[data-scope=compliance] summary').click();
    await form.locator('[data-scope=public] summary').click();
    await expect(form.locator('[data-scope=public]')).toContainText('不会自动访问工商网站');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${dir}/prototype-expanded-${width}.png`, fullPage: true });
    await page.locator('#market').selectOption('nafmii');
    await page.locator('#offering').selectOption('ppn');
    await expect(form.locator('[data-review-rule-scope]')).toContainText('定向发行协议');
    await page.locator('#issuer').fill('另一合成发行人');
    await expect(page.locator('#generated-review-name')).toHaveText('另一合成发行人-交易商协会-PPN · 定向债务融资工具-募集书复核');
    await page.getByRole('button', { name: '创建项目，继续提供材料' }).click();
    await expect(page.locator('#review-create-status')).toContainText('当前未提交');
  }
  expect(errors).toEqual([]);
});
