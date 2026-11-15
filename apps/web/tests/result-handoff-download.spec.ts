import {expect,test,type Locator,type Page} from '@playwright/test';
import {assertFixture,downloadBytes,fixture,frozen,ids,install,openFiles,snapshot,type State,type Variant} from './result-handoff-download-fixtures';

// Desktop synthetic HTTP + minimal OOXML only. These native browser downloads
// verify archiving names and exact bytes; they do not claim live worker/API,
// PostgreSQL/Blob, model, Word layout, billing, or business-user acceptance.
test.beforeEach(async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.clock.setFixedTime(new Date('2026-10-26T04:00:00Z'));
});
test.afterEach(async({page})=>{await assertFixture(page);});

async function receive(page:Page,button:Locator,filename:string,bytes:Buffer){
  const event=page.waitForEvent('download');await button.click();const download=await event;
  expect(download.suggestedFilename()).toBe(filename);
  const received=await downloadBytes(download);expect(received).toEqual(bytes);
  return {filename:download.suggestedFilename(),bytes:received};
}
async function artifact(page:Page,s:State,button:Locator,id:string){
  const stored=s.task.artifacts.get(id)!;
  expect(stored.metadata.filename).toBe(frozen.names[id]);
  const metadataReads=s.task.metadataReads.length,byteReads=s.task.byteReads.length;
  const downloaded=await receive(page,button,frozen.names[id],stored.bytes);
  expect(s.task.metadataReads.slice(metadataReads)).toEqual([id]);
  expect(s.task.byteReads.slice(byteReads)).toEqual([id]);return downloaded;
}
const projectFileButton=(page:Page,id:string,variant:Variant,scope='#file-list')=>
  page.locator(scope).locator(`[data-file-download="${id}"]${variant==='revision'?'[data-revision]':':not([data-revision])'}`);
const familyHistory=(page:Page)=>page.locator(`#file-list [data-file-history="project-file:${ids.family}"]`);
async function openFamilyHistory(page:Page){await familyHistory(page).click();await expect(page.getByRole('dialog',{name:'文件版本记录'})).toBeVisible();}

test('result handoff: the current file-operation pair keeps canonical names and bytes across consistency and project files',async({page})=>{
  const s=fixture(),before=snapshot(s);await install(page,s);
  await page.goto(`/#consistency?project=${ids.root}&run=${ids.newCheck}`);
  await expect(page.locator('#fc-history')).toHaveValue(ids.newCheck);
  const output=s.task.files.find(v=>v.version_id===ids.v3)!;
  expect(output.sequence).toBe(3);expect(frozen.laterInputRevision).not.toBe(output.sequence);
  for(const variant of ['revision','clean'] as const){
    const id=variant==='revision'?ids.laterRevision:ids.laterClean;
    expect(s.task.artifacts.get(id)!.metadata).toMatchObject({version:1,display_version:10});
    expect(frozen.names[id]).not.toBe(output.filename);
    const fromCheck=await artifact(page,s,page.locator(`[data-fc-download="${ids.v3}"][data-variant="${variant}"]`),id);
    await openFiles(page);
    const fromFiles=await artifact(page,s,projectFileButton(page,ids.laterClean,variant),id);
    expect(fromFiles).toEqual(fromCheck);
    if(variant==='revision'){
      await page.goto(`/#consistency?project=${ids.root}&run=${ids.newCheck}`);
      await expect(page.locator('#fc-history')).toHaveValue(ids.newCheck);
    }
  }
  expect(snapshot(s)).toEqual(before);
});

test('result handoff: an old task and file history retain their frozen pair after project rename and a later download date',async({page})=>{
  const s=fixture(),before=snapshot(s);await install(page,s);
  await page.goto(`/#consistency?project=${ids.root}&update_run=${ids.oldRun}`);
  const task=page.locator('#fc-update-task');await expect(task).toHaveAttribute('data-fc-update-run',ids.oldRun);
  await expect(task).toContainText('本次交付 V2');
  const original=new Map<Variant,Awaited<ReturnType<typeof artifact>>>();
  for(const variant of ['revision','clean'] as const){
    const id=variant==='revision'?ids.oldRevision:ids.oldClean;
    expect(s.task.artifacts.get(id)!.metadata.display_version).toBe(8);
    expect(frozen.names[id]).not.toBe(s.task.files.find(v=>v.version_id===ids.v2)!.filename);
    original.set(variant,await artifact(page,s,task.locator(`[data-fc-update-download="${ids.oldRun}"][data-variant="${variant}"]`),id));
  }
  await openFiles(page);await openFamilyHistory(page);
  for(const variant of ['revision','clean'] as const){
    const id=variant==='revision'?ids.oldRevision:ids.oldClean;
    expect(await artifact(page,s,projectFileButton(page,ids.oldClean,variant,'dialog[open]'),id)).toEqual(original.get(variant));
  }
  await page.getByRole('button',{name:'关闭版本记录'}).click();
  // Only the synthetic server's current project label changes. Delivered
  // metadata and immutable registered versions are retained exactly as before.
  s.task.rootProject.name='合成项目已改名_2027';
  await page.clock.setFixedTime(new Date('2027-01-02T04:00:00Z'));
  await page.reload();await expect(page.getByRole('heading',{level:1})).toHaveText(s.task.rootProject.name);
  await openFamilyHistory(page);
  for(const variant of ['revision','clean'] as const){
    const id=variant==='revision'?ids.oldRevision:ids.oldClean;
    expect(await artifact(page,s,projectFileButton(page,ids.oldClean,variant,'dialog[open]'),id)).toEqual(original.get(variant));
  }
  expect(snapshot(s)).toEqual(before);
});

test('result handoff: generated prospectus variants share canonical downloads with project files and uploads keep their original name',async({page})=>{
  const s=fixture(),before=snapshot(s);await install(page,s);await openFiles(page);
  const catalog=s.prospectus.versions.find(v=>v.version_id===ids.prospectusVersion)!;
  expect(catalog.sequence).toBe(9);expect(frozen.prospectusInputRevision).not.toBe(catalog.sequence);
  expect(s.task.rootProject.name).not.toBe(frozen.prospectusProject);
  await page.locator('.prospectus-panel summary').filter({hasText:'版本历史'}).click();
  const delivered=new Map<Variant,Awaited<ReturnType<typeof artifact>>>();
  for(const variant of ['revision','clean'] as const){
    const id=variant==='revision'?ids.prospectusRevision:ids.prospectusClean;
    expect(s.task.artifacts.get(id)!.metadata).toMatchObject({version:2,display_version:6});
    expect(frozen.names[id]).not.toBe(catalog.filename);
    const button=page.locator(`[data-download-${variant==='revision'?'revision':'version'}="${ids.prospectusVersion}"]`);
    const fromVersions=await artifact(page,s,button,id);delivered.set(variant,fromVersions);
    expect(await artifact(page,s,projectFileButton(page,id,'clean'),id)).toEqual(fromVersions);
  }
  const uploaded=await receive(page,page.locator(`[data-prospectus-history] [data-download-version="${s.task.source.version_id}"]`),s.material.filename,s.originalBytes);
  expect(await receive(page,projectFileButton(page,s.material.material_id,'clean'),s.material.filename,s.originalBytes)).toEqual(uploaded);
  expect(s.materialReads).toEqual([s.material.material_id,s.material.material_id]);
  expect(s.materialByteReads).toEqual([s.material.material_id,s.material.material_id]);
  s.task.rootProject.name='合成募集书项目再次改名';await page.clock.setFixedTime(new Date('2027-03-04T04:00:00Z'));
  await page.reload();await expect(page.getByRole('heading',{level:1})).toHaveText(s.task.rootProject.name);
  await page.locator('.prospectus-panel summary').filter({hasText:'版本历史'}).click();
  for(const variant of ['revision','clean'] as const){
    const id=variant==='revision'?ids.prospectusRevision:ids.prospectusClean;
    expect(await artifact(page,s,page.locator(`[data-download-${variant==='revision'?'revision':'version'}="${ids.prospectusVersion}"]`),id)).toEqual(delivered.get(variant));
  }
  expect(snapshot(s)).toEqual(before);
});
