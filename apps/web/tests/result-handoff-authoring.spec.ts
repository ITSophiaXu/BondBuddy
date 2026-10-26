import {expect,test,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {artifactId,assertFixture,downloadBytes,fixture,ids,immutableSnapshot,oldTime,open,writes,type State,type Variant} from './result-handoff-authoring-fixtures';
import {captureAuthoringHandoff,installAuthoringHandoffReference} from './result-handoff-authoring-reference';

test.afterEach(async({page})=>{await assertFixture(page);});
const context=(page:Page)=>page.locator('#execution-delivery [data-artifact-result-context]');
const selected=(page:Page,revision:number)=>expect(page.locator('#execution-progress .task-progress')).toHaveAttribute('data-input-revision',String(revision));
async function expectOriginal(page:Page){
  await selected(page,2);await expect(context(page)).toBeVisible();await expect(context(page)).toContainText('本轮成果 · 第 2 版');
  await expect(context(page)).toContainText('任务记录时间');await expect(context(page).locator('time')).toHaveAttribute('datetime',oldTime);
  await expect(context(page)).not.toContainText('第 7 版');await expect(context(page)).not.toContainText('第 3 版');
  await expect(page.locator('.prospectus-panel header')).toContainText('当前版本：V3');
  expect(await context(page).innerText()).not.toContain(ids.oldRun);
  expect(await page.locator('#execution-delivery .artifact-download-panel').innerText()).not.toContain('合成原项目_');
}
async function downloadOriginal(page:Page,s:State,variant:Variant){
  const event=page.waitForEvent('download');await page.getByRole('button',{name:variant==='clean'?'下载清洁版':'下载修订版',exact:true}).click();
  const download=await event,id=artifactId(2,variant),stored=s.artifacts.get(id)!;
  expect(download.suggestedFilename()).toBe(stored.metadata.filename);expect(await downloadBytes(download)).toEqual(stored.bytes);expect(s.byteReads.at(-1)).toBe(id);
}

test('authoring handoff: historical result survives saved project details, both step transitions and refresh with a newer result present',async({page})=>{
  const s=await open(page),before=immutableSnapshot(s);await expectOriginal(page);expect(writes(s)).toEqual([]);
  s.allowPatch=true;await page.locator('#edit-project-details').click();await expect(page.locator('#draft-form')).toBeVisible();await expect(page).toHaveURL(new RegExp('run='+ids.oldRun));
  await page.locator('#name').fill('合成更名后的同一项目');await page.locator('#save-draft').click();await expect(page.locator('#save-state')).toHaveText('已保存');
  expect(s.project.name).toBe('合成更名后的同一项目');expect(s.patches).toHaveLength(1);
  await page.reload();await expect(page.locator('#draft-form')).toBeVisible();await expect(page.locator('#name')).toHaveValue(s.project.name);await expect(page).toHaveURL(new RegExp('run='+ids.oldRun));
  await page.locator('#continue-materials').click();await expectOriginal(page);await page.reload();await expectOriginal(page);await expect(page).toHaveURL(new RegExp('run='+ids.oldRun));
  for(const variant of ['clean','revision'] as const)await downloadOriginal(page,s,variant);
  expect(writes(s)).toHaveLength(1);expect(writes(s)[0].method).toBe('PATCH');expect(immutableSnapshot(s)).toEqual(before);
  expect(s.metadataReads.filter(id=>id.startsWith('result-handoff-authoring-3-'))).toEqual([]);
});

test('authoring handoff: previous-details navigation preserves the explicit historical run without saving or execution',async({page})=>{
  const s=await open(page),before=immutableSnapshot(s);await expectOriginal(page);
  await page.locator('#previous-details').click();await expect(page.locator('#draft-form')).toBeVisible();await expect(page).toHaveURL(new RegExp('run='+ids.oldRun));
  await page.locator('#continue-materials').click();await page.reload();await expectOriginal(page);
  expect(writes(s)).toEqual([]);expect(immutableSnapshot(s)).toEqual(before);expect(s.byteReads).toEqual([]);
});

test('authoring handoff: a failed details save retains the historical selection and the explicit retry saves only project fields',async({page})=>{
  const s=await open(page),before=immutableSnapshot(s);s.allowPatch=true;s.failNextPatch=true;
  await page.locator('#edit-project-details').click();await page.locator('#name').fill('合成保存重试项目');await page.locator('#save-draft').click();
  await expect(page.locator('#save-state')).toHaveText('保存未确认');await expect(page.locator('#draft-form')).toBeVisible();await expect(page).toHaveURL(new RegExp('run='+ids.oldRun));
  expect(s.project.name).toBe('合成历史募集书找稿项目');await page.locator('#save-draft').click();await expect(page.locator('#save-state')).toHaveText('已保存');
  await page.locator('#continue-materials').click();await page.reload();await expectOriginal(page);expect(s.patches).toHaveLength(2);expect(s.patches[1]).toEqual(s.patches[0]);
  expect(writes(s).every(c=>c.method==='PATCH'&&c.path==='/projects/'+ids.project)).toBe(true);expect(immutableSnapshot(s)).toEqual(before);expect(s.byteReads).toEqual([]);
});

test('authoring handoff: missing display version stays explicit and never substitutes the technical artifact version or current draft',async({page})=>{
  const s=fixture();for(const variant of ['clean','revision'] as const)delete s.artifacts.get(artifactId(2,variant))!.metadata.display_version;
  await open(page,s);await selected(page,2);await expect(context(page)).toBeVisible();await expect(context(page)).toContainText('显示版本未提供');
  await expect(context(page)).not.toContainText('第 7 版');await expect(context(page)).not.toContainText('第 3 版');await expect(context(page).locator('time')).toHaveAttribute('datetime',oldTime);
  await downloadOriginal(page,s,'clean');expect(writes(s)).toEqual([]);
});

test('authoring handoff: standalone result retains its existing version heading and does not duplicate the embedded context',async({page})=>{
  const s=await open(page,fixture(),'/#/artifacts/'+artifactId(2,'revision'));
  await expect(page.locator('.page-heading')).toContainText('第 2 版');await expect(page.locator('[data-artifact-result-context]')).toBeHidden();
  await downloadOriginal(page,s,'revision');expect(writes(s)).toEqual([]);
});

test('authoring handoff desktop component comparison preserves the same historical result after editing and refreshing',async({page})=>{
  const reference=process.env.BB_RESULT_HANDOFF_REFERENCE==='1',verify=reference?await installAuthoringHandoffReference(page):undefined;
  const directory=process.env.BB_RESULT_HANDOFF_EVIDENCE_DIR??process.env.BB_UX_EVIDENCE_DIR??test.info().outputPath('component-capture');
  const s=await open(page),before=immutableSnapshot(s);await selected(page,2);
  if(reference)await expect(context(page)).toHaveCount(0);else await expectOriginal(page);
  await captureAuthoringHandoff(page,directory!,'authoring-handoff-original-1440',{reference,action:'same historical run in current surrounding app',writes:writes(s),metadataReads:s.metadataReads});
  s.allowPatch=true;await page.locator('#edit-project-details').click();await page.locator('#name').fill('合成更名后的同一项目');await page.locator('#continue-materials').click();await expect(page.locator('#workspace-materials')).toBeVisible();await page.reload();
  await expect(page.locator('#execution-delivery .artifact-download-panel')).toBeVisible();await selected(page,reference?3:2);
  if(reference){await expect(page).not.toHaveURL(new RegExp('run='+ids.oldRun));await expect(context(page)).toHaveCount(0);expect(s.metadataReads).toContain(artifactId(3,'revision'));}
  else{await expect(page).toHaveURL(new RegExp('run='+ids.oldRun));await expectOriginal(page);expect(s.metadataReads.filter(id=>id.startsWith('result-handoff-authoring-3-'))).toEqual([]);}
  await captureAuthoringHandoff(page,directory!,'authoring-handoff-return-1440',{reference,action:'same project rename, save, step return and refresh',writes:writes(s),metadataReads:s.metadataReads});
  expect(s.patches).toHaveLength(1);expect(writes(s)).toHaveLength(1);expect(immutableSnapshot(s)).toEqual(before);expect(s.byteReads).toEqual([]);
  if(verify)await writeFile(join(directory!,'authoring-handoff-reference-1440.json'),JSON.stringify(await verify(),null,2));
});
