import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

for (const viewport of [{width:1360,height:900},{width:581,height:753}]) test(`readable synthetic design comparison ${viewport.width}`, async ({page}) => {
  test.skip(!process.env.BB_E2E_PROTOTYPE_URL, 'Local standalone design server required.');
  await page.setViewportSize(viewport); await page.goto(`${process.env.BB_E2E_PROTOTYPE_URL}/review-v2.html?delivery=files`);
  await expect(page.getByRole('navigation',{name:'三个复核维度'})).toBeVisible();
  await page.locator('[data-readable-section]').filter({hasText:'财务核对'}).click();
  await page.getByRole('button',{name:'展开全部事项',exact:true}).click();
  await expect(page.locator('.readable-item[open]')).toHaveCount(2);
  await expect(page.locator('.readable-body')).toContainText('确认口径后统一金额');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await mkdir(test.info().outputPath('review-readable'),{recursive:true});
  await page.screenshot({path:test.info().outputPath('review-readable',`prototype-${viewport.width}.png`),fullPage:true});
});
