import {expect, test} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fixture, install, assertFixture} from './authoring-source-guide-fixtures';

// Synthetic browser fixture: verifies user-visible copy and route consistency only.
// No backend, model, storage or billing call is made.
test.afterEach(async ({page}) => { await assertFixture(page); });

const entryPromise = '先保存项目；开始编制前需上传历史／参考募集书并填写原稿信息，已有核验成果可继续修改。';
const createPromise = '先保存项目，再上传历史／参考募集书并填写原稿信息。';

test('entry, create and material pages no longer promise a start without a source prospectus', async ({page}) => {
  const s = fixture();
  await install(page, s);
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    await page.goto('/#/update');
    const heading = page.locator('.project-entry-update .page-head > div > p:not(.eyebrow)');
    await expect(heading).toHaveText(entryPromise);
    const primary = page.locator('.update-entry-primary');
    await expect(primary).toContainText('历史／参考募集书、原稿信息、财务材料和补充要求');
    await expect(primary).toContainText('可用本企业历史稿、母子公司稿或相似企业参考稿；参考稿事实不作为本发行人的既有事实。');
    await expect(page.locator('body')).not.toContainText('没有原稿也可');
    await expect(page.locator('body')).not.toContainText('编制首稿');
    if (process.env.BB_ENTRY_PROMISE_EVIDENCE) {
      await mkdir(process.env.BB_ENTRY_PROMISE_EVIDENCE, {recursive: true});
      await page.screenshot({path: `${process.env.BB_ENTRY_PROMISE_EVIDENCE}/entry-${width}.png`, fullPage: true});
    }
  }
  await page.locator('.update-entry-primary a.btn.primary').click();
  await expect(page.locator('.page-head > div > p:not(.eyebrow)')).toHaveText(createPromise);
  await expect(page.locator('#create-form')).not.toContainText('没有历史募集书');
  await expect(page.locator('#create-form')).not.toContainText('编制首稿');
  await page.locator('#issuer').fill('合成目标发行人有限公司');
  await expect(page.getByRole('button', {name: '创建项目，继续提供材料'})).toBeEnabled();
  if (process.env.BB_ENTRY_PROMISE_EVIDENCE) {
    await mkdir(process.env.BB_ENTRY_PROMISE_EVIDENCE, {recursive: true});
    await page.screenshot({path: `${process.env.BB_ENTRY_PROMISE_EVIDENCE}/create-390.png`, fullPage: true});
    await page.setViewportSize({width: 1440, height: 1000});
    await page.screenshot({path: `${process.env.BB_ENTRY_PROMISE_EVIDENCE}/create-1440.png`, fullPage: true});
  }
});
