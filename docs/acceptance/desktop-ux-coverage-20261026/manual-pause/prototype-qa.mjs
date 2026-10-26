import {chromium,expect} from '@playwright/test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const output=resolve('docs/acceptance/desktop-ux-coverage-20261026/manual-pause');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge'});
const base=pathToFileURL(resolve('docs/ux/prototypes/pause-supplement-resume.html')).href;
const results=[];
async function scenario(name,query,run){
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(/^https?:/,route=>{errors.push('Unexpected external request '+route.request().url());return route.abort();});
  try{await page.goto(base+'?'+query);await run(page);expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);results.push({name,passed:true});}
  finally{await context.close();}
}
try{
 await scenario('fee remains pending by default','scenario=saved',async page=>{
  await expect(page.locator('#demo-fee')).toHaveValue('');await expect(page.locator('#adopt-resume')).toBeDisabled();
  await expect(page.locator('#supplement-adoption-label')).toContainText('尚未');
  await page.screenshot({path:resolve(output,'proposal-fee-pending.png'),fullPage:true});
  for(const pending of ['adopt-unknown','conflict']){
   await page.goto(base+'?scenario='+pending+'&receipt=adopted');
   await page.locator('#read-adoption').click();
   await expect(page.locator('#demo-counts')).toContainText('只读核对：1 次');
   await expect(page.locator('#action-notice')).toContainText('仅为历史备选A');
   await expect(page.locator('#supplement-adoption-label')).not.toHaveText('已用于本次任务');
   await expect(page.locator('#adopt-resume')).toBeDisabled();await expect(page.locator('#demo-complete')).toBeDisabled();
   await expect(page.locator('#results')).toHaveCount(0);await page.reload();
   await expect(page.locator('#demo-fee')).toHaveValue('');await expect(page.locator('#demo-complete')).toBeDisabled();
   await expect(page.locator('#supplement-adoption-label')).not.toHaveText('已用于本次任务');
  }
 });
 await scenario('save then explicitly adopt in the original task demo','scenario=running&fee=a',async page=>{
  await page.locator('#pause-task').click();await expect(page.locator('#status-title')).toContainText('正在保存');
  await expect(page.locator('#add-sample-file')).toBeDisabled();await expect(page.locator('#status-title')).toContainText('任务已暂停');
  await page.locator('#add-sample-file').click();await expect(page.locator('#supplement-adoption-label')).toContainText('尚未');
  await expect(page.locator('#adopt-resume')).toBeEnabled();await page.locator('#adopt-resume').click();
  await expect(page.locator('#status-title')).toContainText('继续');await expect(page.locator('#demo-counts')).toContainText('采用动作：1 次');
  await page.locator('#demo-complete').click();await expect(page.locator('#result-source')).toContainText('最新采用');
  await expect(page.locator('#results')).toContainText('2,300 万元');
  await page.screenshot({path:resolve(output,'proposal-latest-supplement.png'),fullPage:true});
  await page.locator('#demo-fee').selectOption('');
  await expect(page.locator('#status-title')).toContainText('暂停');
  await expect(page.locator('#supplement-adoption-label')).toContainText('尚未');
  await expect(page.locator('#adopt-resume')).toBeDisabled();await expect(page.locator('#demo-complete')).toBeDisabled();
  await expect(page.locator('#results')).toHaveCount(0);await page.reload();
  await expect(page.locator('#demo-fee')).toHaveValue('');await expect(page.locator('#supplement-adoption-label')).toContainText('尚未');
  await page.locator('#demo-fee').selectOption('a');await page.locator('#adopt-resume').click();
  await expect(page.locator('#status-title')).toContainText('确认');await page.locator('#demo-fee').selectOption('');
  // Cross the cancelled 1.2-second adoption callback to check it cannot resurrect historical A.
  await page.waitForTimeout(1400);await expect(page.locator('#status-title')).toContainText('暂停');
  await expect(page.locator('#supplement-adoption-label')).toContainText('尚未');await expect(page.locator('#demo-complete')).toBeDisabled();
  await page.evaluate(()=>{const key='bondbuddy-pause-proposal:'+location.pathname+location.search;const stale=JSON.parse(sessionStorage.getItem(key));stale.fee='';stale.adopted=true;stale.phase='completed';sessionStorage.setItem(key,JSON.stringify(stale));});
  await page.reload();await expect(page.locator('#status-title')).toContainText('暂停');
  await expect(page.locator('#supplement-adoption-label')).toContainText('尚未');await expect(page.locator('#demo-complete')).toBeDisabled();
 });
 await scenario('unknown adoption is read back without another adoption','scenario=adopt-unknown&fee=a&receipt=adopted',async page=>{
  const before=await page.locator('#demo-counts').textContent();await expect(page.locator('#adopt-resume')).toBeDisabled();
  await page.locator('#read-adoption').click();await expect(page.locator('#status-title')).toContainText('继续');
  const after=await page.locator('#demo-counts').textContent();expect(after.split(' · ')[0]).toBe(before.split(' · ')[0]);
  expect(after).toContain('只读核对：1 次');await page.reload();await expect(page.locator('#demo-counts')).toHaveText(after);
  await page.screenshot({path:resolve(output,'proposal-recovered-adoption.png'),fullPage:true});
 });
 await writeFile(resolve(output,'prototype-qa.json'),JSON.stringify({synthetic:true,scope:'Proposed standalone HTML only; not implemented API/worker/billing acceptance',viewport:{width:1440,height:960},results},null,2)+'\n');
 console.log(JSON.stringify({passed:results.length,failed:0,results},null,2));
}finally{await browser.close();}
