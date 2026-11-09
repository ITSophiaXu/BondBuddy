import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { sourceFixture } from './generation-source-fixtures';
import { href, file, batches } from './generation-entry-fixtures';

const evidence = 'test-evidence/generation-upload-retry-20261109';
const sourceFile = { ...file, name: '合成港务集团有限公司2026年度中期票据募集说明书及补充披露材料-长文件名.docx' };

for (const width of [1440, 390, 320]) for (const restored of [false, true]) {
  test(`generation retry matches standard buttons beside filename at ${width}, restored=${restored}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const state = await sourceFixture(page, false);
    let fail = true;
    await page.route('**/materials/uploads/*/complete', route => fail
      ? route.fulfill({ status: 503, json: { code: 'DATA_UNAVAILABLE', retryable: true } })
      : route.fallback());
    await page.goto('/' + href({ step: 'source', mode: 'documents' }));
    await page.locator('#prospectus-version-file').setInputFiles(sourceFile);
    await expect(page.locator('#save-prospectus-version')).toBeEnabled();
    if (restored) await page.reload();
    const retry = page.locator(restored ? '[data-resume-prospectus]' : '#save-prospectus-version');
    await expect(retry).toBeVisible(); await expect(retry).toBeEnabled();
    const row = page.locator('.pf-source-upload-state').filter({ hasText: sourceFile.name });
    await row.scrollIntoViewIfNeeded();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/${process.env.BB_RETRY_BASELINE ? 'before-' : ''}${restored ? 'restored' : 'retry'}-${width}.png` });

    // Compare computed appearance with the shared secondary button in the same panel.
    const appearance = await retry.evaluate(button => {
      const standard = document.createElement('button');
      standard.className = 'btn secondary'; standard.textContent = button.textContent;
      button.closest('.pf-source-picker')!.append(standard);
      const read = (element: Element) => {
        const css = getComputedStyle(element);
        return { radius: css.borderRadius, color: css.color, background: css.backgroundColor,
          border: css.border, padding: css.padding, font: css.font, marginTop: css.marginTop };
      };
      const result = { actual: read(button), standard: read(standard) };
      standard.remove(); return result;
    });
    expect(appearance.actual).toEqual(appearance.standard);
    const name = (await row.locator('strong').boundingBox())!, button = (await retry.boundingBox())!;
    expect(button.x).toBeGreaterThanOrEqual(name.x + name.width);
    expect(Math.abs(button.y + button.height / 2 - name.y - name.height / 2)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    fail = false;
    await retry.focus(); await expect(retry).toBeFocused(); await retry.press('Enter');
    await expect(page.locator('.pf-selected-source')).toContainText(sourceFile.name);
    await expect(page.locator('#pf-source-next')).toBeEnabled();
    expect(state.state.sessions.size).toBe(1); expect(state.state.puts).toBe(1);
    expect(state.selections).toHaveLength(1); expect(batches(state.state)).toHaveLength(0);
    await expect(page).toHaveURL(/step=source/);
  });
}
