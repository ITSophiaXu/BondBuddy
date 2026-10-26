import {expect,test} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertFixture,fixture,ids,openProjects,serverSnapshot,writes} from './consistency-task-fixtures';
import {captureConsistencyTask,installConsistencyTaskReference} from './consistency-task-reference';

test.afterEach(async({page})=>{await assertFixture(page);});

test('consistency task desktop component comparison follows the same historical task to its recorded delivery',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  const reference=process.env.BB_CONSISTENCY_TASK_REFERENCE==='1',verify=reference?await installConsistencyTaskReference(page):undefined;
  const s=fixture(),before=serverSnapshot(s),directory=process.env.BB_CONSISTENCY_TASK_EVIDENCE_DIR??test.info().outputPath('component-capture');
  await openProjects(page,s);
  const link=page.locator(`[data-run-id="${ids.oldRun}"] a`),href=await link.getAttribute('href');
  if(reference)expect(href).toBe('#consistency?project='+ids.root);
  else expect(href).toBe('#consistency?project='+ids.root+'&update_run='+ids.oldRun);
  await link.focus();await link.evaluate(element=>element.scrollIntoView({block:'center'}));await expect(link).toBeInViewport();
  await captureConsistencyTask(page,directory!,'consistency-task-entry-1440',{reference,action:'same historical file-update task in the real project task list',href,entry_box:await link.boundingBox(),writes:writes(s)});
  await link.click();await expect(page.locator('#fc-history')).toHaveValue(reference?ids.newCheck:ids.oldCheck);
  if(reference){
    await expect(page.locator('#fc-update-task')).toHaveCount(0);
    await expect(page.locator(`[data-fc-select="${ids.v2}"]`)).toBeVisible();
    await expect(page.locator(`[data-fc-download="${ids.v3}"]`)).toHaveCount(2);
  }else{
    await expect(page.locator('#fc-update-task')).toHaveAttribute('data-fc-update-run',ids.oldRun);
    await expect(page.locator('#fc-update-task')).toContainText('本次交付 V2');
    await expect(page.locator('#fc-update-task [data-fc-download]')).toHaveCount(2);
    for(const variant of ['revision','clean'])await expect(page.locator(`#fc-update-task [data-fc-download][data-variant="${variant}"]`)).toHaveAttribute('data-fc-download',ids.v2);
  }
  await page.evaluate(()=>scrollTo(0,0));
  await captureConsistencyTask(page,directory!,'consistency-task-arrival-1440',{reference,action:'native click from the same task entry',href,writes:writes(s),selected_check:reference?ids.newCheck:ids.oldCheck,original_run:ids.oldRun,original_output:ids.v2,later_output:ids.v3});
  expect(writes(s)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);expect(s.metadataReads).toEqual([]);expect(s.byteReads).toEqual([]);
  if(verify)await writeFile(join(directory!,'consistency-task-reference-1440.json'),JSON.stringify(await verify(),null,2));
});
