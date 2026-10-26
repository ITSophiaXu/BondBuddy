import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,open,assertFixture,writes,serverSnapshot,fileIds} from './consistency-confirmation-fixtures';
import {installConsistencyConfirmationReference,captureConsistencyConfirmation} from './consistency-confirmation-reference';

const reference=process.env.BB_CONSISTENCY_CONFIRMATION_REFERENCE==='1';
test('confirmation component comparison: exact R43 and current share the original two same-name files and 9,000-point request at 1440',async({page})=>{
  const verify=reference?await installConsistencyConfirmationReference(page):undefined;
  const s=await open(page,fixture()),before=serverSnapshot(s);
  for(const id of [fileIds.issuer,fileIds.financial])await page.locator(`[data-fc-select="${id}"]`).check();
  await page.locator('#fc-accept-top').click();const dialog=page.locator('dialog.fc-confirm[open]');await expect(dialog).toBeVisible();
  const names=[fileIds.issuer,fileIds.financial].map(id=>s.checks[0].files.find(file=>file.file_version_id===id)!.filename);
  await expect(dialog.locator(reference?'li':'.fc-confirm-filename')).toHaveText(names);await expect(dialog).toContainText('9,000 积分');
  expect(writes(s)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);
  const directory=process.env.BB_CONSISTENCY_CONFIRMATION_EVIDENCE_DIR??test.info().outputPath(reference?'reference':'current');
  const facts=await captureConsistencyConfirmation(page,directory,'consistency-confirmation-'+(reference?'reference':'current')+'-same-name-1440',
    {reference,synthetic:true,source:s.checks[0].source,files:s.checks[0].files.filter(file=>[fileIds.issuer,fileIds.financial].includes(file.file_version_id)),writes:writes(s)});
  expect(facts.rows).toHaveLength(2);
  if(reference){expect(facts.source).toBeNull();expect(facts.details).toHaveLength(0);}
  else{expect(facts.source).toContain('V'+s.checks[0].source.sequence);expect(facts.details.map(detail=>detail.open)).toEqual([false]);expect(facts.footer?.inViewport).toBe(true);}
  if(verify){await mkdir(directory,{recursive:true});await writeFile(join(directory,'consistency-confirmation-reference-identity.json'),JSON.stringify(await verify(),null,2)+'\n');}
  await assertFixture(page);
});
