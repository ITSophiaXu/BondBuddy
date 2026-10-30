import {test,expect,type Page} from '@playwright/test';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {fixture,install,route,word,assertFixture} from './integrity-delivery-fixtures';
import {writes} from './integrity-continuation-fixtures';
import {downloadBytes} from './word-roundtrip-fixtures';
import {fixture as fileFixture,open as openFiles,collection,noExecution} from './project-file-status-fixtures';

async function capture(page:Page,name:string){const dir=process.env.BB_UX_EVIDENCE;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,name+'.png')});}}

test('download reports preparation immediately, prevents duplicates and retains exact bytes on retry',async({page})=>{
  const s=fixture();await install(page,s);let release!:()=>void,count=0;
  const gate=new Promise<void>(resolve=>release=resolve),expected=word(s);
  await page.route(`**/api/v1/artifacts/${expected.artifact_id}`,async intercepted=>{count++;await gate;return intercepted.fallback();});
  await page.goto(route());const button=page.locator(`[data-integrity-download="${expected.artifact_id}"]`);
  await button.click();await expect(button).toBeDisabled();await expect(button).toHaveAttribute('aria-busy','true');
  await expect(page.locator('#integrity-status')).toContainText('正在准备下载');
  await button.dispatchEvent('click');expect(count).toBe(1);await capture(page,'integrity-download-preparing');
  const download=page.waitForEvent('download');release();const received=await download;
  expect(await downloadBytes(received)).toEqual(expected.bytes);await expect(button).toBeEnabled();
  await expect(page.locator('#integrity-status')).toContainText('请在浏览器下载列表查看');
  let fail=true;await page.route(`**/api/v1/artifacts/${expected.artifact_id}/download**`,intercepted=>fail?intercepted.abort('failed'):intercepted.fallback());
  await button.click();await expect(button).toBeEnabled();await expect(page.locator('#integrity-status')).not.toContainText('已交给浏览器');
  await capture(page,'integrity-download-error');
  fail=false;const retried=page.waitForEvent('download');await button.click();expect(await downloadBytes(await retried)).toEqual(expected.bytes);
  expect(writes(s)).toEqual([]);await assertFixture(page);
});

for(const width of [1366,1093,390])test(`integrity result toolbar aligns and remains usable at ${width}px`,async({page})=>{
  const s=fixture();await install(page,s);await page.setViewportSize({width,height:768});await page.goto(route());
  const toolbar=page.locator('.integrity-workbar'),filter=page.locator('#integrity-filter'),next=page.locator('#integrity-next-pending');
  await toolbar.scrollIntoViewIfNeeded();const a=await filter.boundingBox(),b=await next.boundingBox();
  expect(Math.abs(a!.height-b!.height)).toBeLessThanOrEqual(1);
  if(width>650)expect(Math.abs(a!.y-b!.y)).toBeLessThanOrEqual(1);
  else expect(b!.y).toBeGreaterThanOrEqual(a!.y+a!.height);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await capture(page,`integrity-toolbar-${width}`);
  await filter.selectOption('pending');await expect(filter).toHaveValue('pending');await next.click();await expect(page.locator('.integrity-query[open]')).not.toHaveCount(0);
  await filter.selectOption('all');await expect(filter).toHaveValue('all');expect(writes(s)).toEqual([]);await assertFixture(page);
});

test('project files distinguish per-file V1 from exact current prospectus V2 in both row and history',async({page})=>{
  const s=fileFixture();s.source.sequence=2;s.collectionProjection=collection(s);
  const item=s.collectionProjection.items.find(item=>item.current)!;item.display_version=1;
  await openFiles(page,s);const row=page.locator('.collection-file').filter({hasText:s.source.filename});
  await expect(row).toContainText('文件版本 V1');await expect(row).toContainText('当前募集书 V2');
  await row.scrollIntoViewIfNeeded();await capture(page,'file-version-row');
  await row.getByRole('button',{name:/版本记录/}).click();const dialog=page.getByRole('dialog',{name:'文件版本记录'});
  await expect(dialog).toContainText('文件版本 V1');await expect(dialog).toContainText('当前募集书 V2');await capture(page,'file-version-history');
  await page.keyboard.press('Escape');noExecution(s);
});
