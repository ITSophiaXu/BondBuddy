import {test,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import ts from 'typescript';
import {fixture,install,writes,projectId,exportId,historicalDraft} from './integrity-continuation-fixtures';

// The unchanged develop component is a comparison reference. No dedicated
// public Integrity prototype has been verified, and this is not design approval.
const root=resolve(process.cwd(),'../..'),baseline=resolve(root,'../remote-review-20261025-ffd637f/BondBuddy-develop');
test.skip(!process.env.BB_UX_EVIDENCE_DIR||!existsSync(baseline),'Local immutable baseline and evidence directory are required for comparison capture.');
for(const width of [1440,390])test(`baseline Integrity reference at ${width}`,async({page})=>{
  const evidence=process.env.BB_UX_EVIDENCE_DIR;if(!evidence)throw Error('BB_UX_EVIDENCE_DIR is required for reference capture');
  const sourcePath=join(baseline,'apps/web/src/integrity-workspace.ts'),cssPath=join(baseline,'apps/web/src/integrity-workspace.css');
  const original=await readFile(sourcePath,'utf8'),css=await readFile(cssPath,'utf8');
  let script=ts.transpileModule(original,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  script=script.replace(/from ['"]@bondbuddy\/contracts['"]/g,`from "/@fs/${root.replaceAll('\\','/')}/packages/contracts/dist/index.js"`);
  script=script.replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name)=>quote+'/src/'+name+(name.endsWith('.css')?'':'.ts')+quote);
  let sourceLoads=0,cssLoads=0;const blockedWrites:string[]=[];
  await page.route('**/src/integrity-workspace.ts*',route=>{sourceLoads++;return route.fulfill({contentType:'text/javascript',body:script});});
  await page.route('**/src/integrity-workspace.css*',route=>{cssLoads++;return route.fulfill({contentType:'text/javascript',body:`const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);export default '';`});});
  const state=fixture();state.workspace.draft=historicalDraft();await install(page,state);
  // The fixture still validates every GET response against the public HTTP
  // schema. A write is blocked before the fixture can accept or mutate it.
  await page.route('**/api/v1/**',route=>{
    if(route.request().method()==='GET')return route.fallback();
    blockedWrites.push(`${route.request().method()} ${route.request().url()}`);return route.abort('blockedbyclient');
  });
  await page.setViewportSize({width,height:width===390?844:960});await mkdir(evidence,{recursive:true});
  const records=[];
  for(const [stateName,suffix] of [['history','&run='+exportId],['preparation','']]){
    await page.goto('/#integrity?project='+projectId+suffix);
    await expect(page.locator('main h1')).toHaveText('诚信核查');
    await expect(page.locator('main .page-head')).toContainText('按项目准备名单与网站范围，保留查询记录与核查底稿。');
    await expect(page.locator('#integrity-use-round')).toHaveCount(0);await expect(page.locator('#integrity-filter')).toHaveCount(0);
    if(stateName==='history'){
      await expect(page.locator('#integrity-records')).toBeVisible();await expect(page.locator('[data-integrity-download]')).toHaveCount(2);
      await expect(page.locator('#integrity-export')).toHaveText('重新导出底稿 · 免费');
    }else{
      await expect(page.locator('#integrity-roster')).toBeVisible();await expect(page.locator('[data-subject="company-a"][data-field="name"]')).toHaveValue('合成发行人有限公司');
      await expect(page.locator('#integrity-notes')).toHaveValue(historicalDraft().notes);await expect(page.locator('#integrity-preparation-controls')).toHaveCount(0);
    }
    await page.evaluate(async()=>{(document.activeElement as HTMLElement|null)?.blur();window.scrollTo(0,0);await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});
    const filename=`integrity-reference-${stateName}-${width}.png`;await page.screenshot({path:join(evidence,filename),fullPage:true});
    records.push({filename,viewport:{width,height:width===390?844:960},overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
  }
  expect(sourceLoads).toBeGreaterThan(0);expect(cssLoads).toBeGreaterThan(0);expect(blockedWrites).toEqual([]);expect(writes(state)).toEqual([]);
  expect(state.errors).toEqual([]);expect(state.unexpected).toEqual([]);
  expect(await readFile(sourcePath,'utf8')).toBe(original);expect(await readFile(cssPath,'utf8')).toBe(css);
  await writeFile(join(evidence,`integrity-reference-capture-${width}.json`),JSON.stringify({baseline_sha:'ffd637fac6c1fdf1581112e728f21ec29a94c67c',
    source_sha256:createHash('sha256').update(original).digest('hex'),css_sha256:createHash('sha256').update(css).digest('hex'),source_loads:sourceLoads,css_loads:cssLoads,
    preparation:'Synthetic server draft populated with historicalDraft; no adoption flow exists in baseline.',records,write_requests:0,blocked_write_requests:blockedWrites,errors:[]},null,2));
});
