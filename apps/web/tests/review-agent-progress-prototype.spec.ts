import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Optional same-size design comparison against the standalone synthetic prototype.
test('approved prototype shows a compact action and folded task record on desktop and narrow screens',async({page})=>{
  test.skip(!process.env.BB_E2E_PROTOTYPE_URL,'Set BB_E2E_PROTOTYPE_URL to the local product-prototype server.');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1360,height:900});await page.goto(`${process.env.BB_E2E_PROTOTYPE_URL}/review-v2.html`);
  await page.getByRole('button',{name:'从准备开始体验',exact:true}).click();await page.getByRole('button',{name:'开始复核体验',exact:true}).click();
  await page.getByRole('button',{name:'明确开始完整复核',exact:true}).click();
  const bar=page.locator('#review-progress-bar'),card=page.locator('#agent-task-R2');await expect(bar).toContainText('正在读取材料');
  await card.getByRole('button',{name:'下一项演示动作',exact:true}).click();await card.getByRole('button',{name:'下一项演示动作',exact:true}).click();await card.getByRole('button',{name:'下一项演示动作',exact:true}).click();
  await expect(bar).toContainText('正在检查合规与格式');await expect(card.locator('.task-current')).toContainText('正在检查合规与格式');
  await expect(card.locator('details')).not.toHaveAttribute('open','');await card.locator('summary').click();await card.locator('summary').click();
  await bar.getByRole('button',{name:'查看进展',exact:true}).click();await expect(card).toBeFocused();await page.evaluate(()=>window.scrollTo(0,0));
  await expect(page.locator('#agent-panel')).not.toContainText(/10:24|10:32|心跳|预计|已用时|\d+%/);await expect(page.locator('.progress-fill')).toHaveCount(0);
  await mkdir('test-evidence/m3-agent-progress',{recursive:true});await page.screenshot({path:'test-evidence/m3-agent-progress/prototype-desktop-1360x900.png'});
  await page.setViewportSize({width:1280,height:720});await bar.getByRole('button',{name:'查看进展',exact:true}).click();await page.screenshot({path:'test-evidence/m3-agent-progress/prototype-desktop-1280x720.png'});
  await page.setViewportSize({width:581,height:753});await bar.getByRole('button',{name:'查看进展',exact:true}).click();await expect(card).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-evidence/m3-agent-progress/prototype-narrow-581x753.png'});
  await page.reload();await expect(page.locator('#agent-panel')).toBeVisible();await expect(card).toHaveCount(1);await expect(card.locator('.task-current')).toContainText('正在检查合规与格式');expect(errors).toEqual([]);
});
