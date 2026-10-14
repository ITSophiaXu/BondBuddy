import {test,expect} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';

for(const width of [1440,390])test(`duplicate feedback prototype reference at ${width}`,async({page})=>{
  const root=new URL('../../../product-prototype/public/',import.meta.url);
  await page.setViewportSize({width,height:960});
  await page.setContent((await readFile(new URL('duplicate-upload-feedback.html',root),'utf8')).replace('<link rel="stylesheet" href="duplicate-upload-feedback.css">',''));
  await page.addStyleTag({content:await readFile(new URL('duplicate-upload-feedback.css',root),'utf8')});
  await expect(page.locator('.duplicate-upload-notice')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.BB_DUPLICATE_EVIDENCE){await mkdir(process.env.BB_DUPLICATE_EVIDENCE,{recursive:true});await page.screenshot({path:`${process.env.BB_DUPLICATE_EVIDENCE}/prototype-${width}.png`});}
});
