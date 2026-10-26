import {test,expect,type Page} from '@playwright/test';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,open,seedSelection,pausedClock,detail,finding,fileIds,changeCurrentSource,assertFixture,assertReadOnly,writes,serverSnapshot,type State} from './consistency-reading-fixtures';
import {installConsistencyReadingReference,captureConsistencyReading} from './consistency-reading-reference';
const reference=process.env.BB_CONSISTENCY_READING_REFERENCE==='1';
async function poll(page:Page,s:State){const prior=s.readCounts.checks,before=await page.evaluate(()=>(window as any).comparisonPaints);await page.clock.runFor(4000);await expect.poll(()=>s.readCounts.checks).toBeGreaterThan(prior);await expect.poll(()=>page.evaluate(()=>(window as any).comparisonPaints)).toBeGreaterThan(before);await page.clock.runFor(100);}
test.afterEach(async({page})=>assertFixture(page));
test('component comparison: exact R32 and current long result reading, changed source, manual detail closure and scope record at 1440',async({page})=>{
  await pausedClock(page);const verify=reference?await installConsistencyReadingReference(page):undefined,s=fixture();await seedSelection(page,s);await open(page,s,fileIds.financial);
  const summary=detail(page).locator('summary');await summary.focus();await finding(page).evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await page.clock.runFor(80);
  await page.evaluate(()=>{(window as any).comparisonPaints=0;const root=document.querySelector('#app')!;new MutationObserver(records=>{if(records.some(r=>r.type==='childList'&&r.target===root))(window as any).comparisonPaints++;}).observe(root,{subtree:true,childList:true});});
  const directory=process.env.BB_CONSISTENCY_READING_EVIDENCE_DIR??test.info().outputPath('component-capture');const side=reference?'reference':'implementation';
  const audit=()=>({synthetic:true,scope:'Exact sealed R32 FileConsistency or current component in the same surrounding application; existing public-schema synthetic HTTP.',http:s.calls,business_writes:writes(s),unexpected:s.unexpected,browser_errors:s.errors});
  await captureConsistencyReading(page,directory!,side+'-long-reading-1440',audit());
  changeCurrentSource(s);const expectedServer=serverSnapshot(s);await poll(page,s);await captureConsistencyReading(page,directory!,side+'-changed-source-reading-1440',audit());
  await detail(page).locator('summary').focus();await page.keyboard.press('Enter');await expect(detail(page)).not.toHaveAttribute('open');await page.clock.runFor(80);await poll(page,s);await captureConsistencyReading(page,directory!,side+'-closed-detail-after-poll-1440',audit());
  if(await detail(page).getAttribute('open')===null){await detail(page).locator('summary').focus();await page.keyboard.press('Enter');}
  await detail(page).locator('summary').focus();await detail(page).evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));await page.clock.runFor(80);await captureConsistencyReading(page,directory!,side+'-scope-detail-1440',audit());
  assertReadOnly(s);expect(serverSnapshot(s)).toEqual(expectedServer);if(verify){await mkdir(directory!,{recursive:true});await writeFile(join(directory!,'reference-provenance-1440.json'),JSON.stringify(await verify(),null,2)+'\n');}
});
