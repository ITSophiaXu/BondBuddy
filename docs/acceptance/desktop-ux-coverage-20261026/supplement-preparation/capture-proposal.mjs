import {chromium,expect} from '@playwright/test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const output=resolve('.local/supplement-preparation/screenshots');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(/^https?:/,route=>route.abort());
  await page.goto(pathToFileURL(resolve('docs/ux/prototypes/pause-supplement-resume.html')).href+'?scenario=saved');
  await expect(page.locator('#demo-fee')).toHaveValue('');
  await expect(page.locator('#adopt-resume')).toBeDisabled();
  await page.locator('#supplement-title').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(output,'proposal-saved-viewport.png')});
  await page.screenshot({path:resolve(output,'proposal-saved.png'),fullPage:true});
  expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await writeFile(resolve('.local/supplement-preparation/proposal-capture.json'),JSON.stringify({synthetic:true,scope:'Existing standalone proposal only; no API, worker, storage, billing or adoption acceptance',viewport:{width:1440,height:960},fee:'B selected; formula pending',adoptionEnabled:false,errors},null,2)+'\n');
  console.log('Captured saved B proposal at 1440x960; adoption disabled; no page errors or horizontal overflow.');
}finally{await browser.close();}
