import {test, expect} from '@playwright/test';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as qa from './project-qa-continuation-fixtures';

for(const width of [960,760,390,320])test(`mobile navigation and assistant touch targets at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const state=qa.fixture();await qa.install(page,state);
  await page.goto('/#qa?project='+qa.projectId);await expect(page.locator('.qa-page')).toBeVisible();
  const measurements:Record<string,unknown>={};
  const target=async(selector:string)=>{
    const locator=page.locator(selector);await expect(locator).toBeVisible();const box=(await locator.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
    measurements[selector]=box;return box;
  };
  await target('#toggle-menu');await page.locator('#toggle-menu').click();await expect(page.locator('#toggle-menu')).toHaveAttribute('aria-expanded','true');
  await target('#close-menu');
  const directory=process.env.BB_UX_AUDIT_DIR;
  if(directory){await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,`navigation-${width}.png`)});}
  await page.locator('#close-menu').click();await expect(page.locator('#toggle-menu')).toHaveAttribute('aria-expanded','false');
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  const icons=['new','history','toggle'];let lastRight=0;
  for(const name of icons){const box=await target(`.ba-toolbar [data-a=${name}]`);if(lastRight)expect(box.x-lastRight).toBeGreaterThanOrEqual(4);lastRight=box.x+box.width;}
  await target('.ba-send');await target('.ba-attach');
  await page.locator('.ba-toolbar [data-a=history]').click();await expect(page.locator('.ba-history')).toBeVisible();
  await page.getByRole('button',{name:'返回当前对话',exact:true}).click();await expect(page.locator('.ba-history')).toHaveCount(0);
  await page.locator('[data-composer]').fill('合成触控验证草稿');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  if(directory){await page.screenshot({path:join(directory,`assistant-controls-${width}.png`)});await writeFile(join(directory,`mobile-controls-${width}.json`),JSON.stringify(measurements,null,2));}
  await page.locator('.ba-toolbar [data-a=toggle]').click();await expect(page.locator('#ba-panel')).toBeHidden();
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('[data-composer]')).toHaveValue('合成触控验证草稿');
  expect(qa.writes(state)).toEqual([]);await qa.assertFixture(page);
});

test('desktop assistant retains compact toolbar targets',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await qa.install(page,qa.fixture());await page.goto('/#qa?project='+qa.projectId);
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  for(const name of ['new','history','wide','toggle']){const box=(await page.locator(`.ba-toolbar [data-a=${name}]`).boundingBox())!;expect(box.width).toBe(32);expect(box.height).toBe(32);}
});

for(const width of [390,320])test(`assistant design reference matches mobile targets at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.setContent(await readFile(new URL('../../../product-prototype/public/project-assistant-refined.html',import.meta.url),'utf8'));
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  for(const name of ['new','history','toggle']){const box=(await page.locator(`.ba-toolbar [data-a=${name}]`).boundingBox())!;expect(box.width).toBe(44);expect(box.height).toBe(44);}
  await page.getByRole('textbox',{name:'发送给 BondBuddy'}).fill('合成触控验证草稿');
  const directory=process.env.BB_UX_AUDIT_DIR;if(directory){await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,`assistant-prototype-${width}.png`)});}
  await page.getByRole('button',{name:'收起助手',exact:true}).click();await expect(page.locator('.bb-assistant')).toBeHidden();
});

for(const width of [390,320])test(`navigation design reference matches mobile targets at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  const path=fileURLToPath(new URL('../../../product-prototype/public/navigation-responsive.html',import.meta.url)).replaceAll('\\','/');
  await page.goto('/@fs/'+path);
  const toggle=page.locator('#toggle-menu');await expect(toggle).toBeVisible();const openBox=(await toggle.boundingBox())!;expect(openBox.width).toBe(44);expect(openBox.height).toBe(44);
  await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','true');
  const close=page.locator('#close-menu'),closeBox=(await close.boundingBox())!;expect(closeBox.width).toBe(44);expect(closeBox.height).toBe(44);
  const directory=process.env.BB_UX_AUDIT_DIR;if(directory){await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,`navigation-prototype-${width}.png`)});}
  await close.click();await expect(toggle).toHaveAttribute('aria-expanded','false');
});
