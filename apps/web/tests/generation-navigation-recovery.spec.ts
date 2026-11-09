import {test,expect,type Page} from '@playwright/test';
import {sourceFixture} from './generation-source-fixtures';
import {href,file,batches,writes} from './generation-entry-fixtures';

// Real routing and upload recovery with synthetic HTTP; no production or model calls.
async function recoveryRows(page:Page){
  return page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('bondbuddy:upload-recovery:v1:'))));
}
async function blocksUnload(page:Page){
  return page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
}

async function failedUpload(page:Page,existing=false){
  const fixture=await sourceFixture(page,existing);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/materials/uploads/*/bytes',async route=>{
    await gate;
    const id=new URL(route.request().url()).pathname.split('/').at(-2)!;
    fixture.state.sessions.get(id)!.received=true;fixture.state.puts++;
    await route.abort('failed');
  });
  await page.goto('/'+href({step:'choose'}));
  if(existing)await page.locator('[name=generation-source-mode][value=upload]').check();
  await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect.poll(()=>fixture.state.sessions.size).toBe(1);
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  return {...fixture,release,settle:async()=>{
    release();
    await expect(page.locator('#save-prospectus-version')).toBeVisible();
    await expect(page.locator('#save-prospectus-version')).toBeEnabled();
  }};
}

for(const label of ['任务进度与结果','更新募集书','复核募集书','诚信核查','项目问答'])test(`restored upload permits sidebar navigation to ${label}`,async({page})=>{
  const fixture=await failedUpload(page);await fixture.settle();await page.reload();
  await expect(page.locator('[data-resume-prospectus]')).toBeVisible();
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  const saved=await recoveryRows(page),before=writes(fixture.state).length;
  expect(Object.keys(saved)).toHaveLength(1);
  expect(await blocksUnload(page)).toBe(false);
  await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:label,exact:true}).click();
  await expect(page.locator('#pf-prospectus')).toHaveCount(0);
  await expect(page.locator('nav [aria-current=page]')).toHaveText(label);
  expect(await recoveryRows(page)).toEqual(saved);
  expect(writes(fixture.state)).toHaveLength(before);
  await page.goBack();
  await expect(page.locator('[data-resume-prospectus]')).toBeVisible();
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  expect(await recoveryRows(page)).toEqual(saved);
  await page.locator('[data-resume-prospectus]').click();
  await expect(page.locator('#pf-source-next')).toBeEnabled();
  await expect(page.locator('.pf-selected-source')).toContainText(file.name);
  expect(fixture.state.sessions.size).toBe(1);expect(fixture.state.puts).toBe(1);
  expect(fixture.selections).toHaveLength(1);expect(batches(fixture.state)).toHaveLength(0);
  expect(await recoveryRows(page)).toEqual({});expect(fixture.state.errors).toEqual([]);
});

test('active upload blocks leaving, failed upload can leave without reloading',async({page})=>{
  const fixture=await failedUpload(page,true);
  try{
    expect(await blocksUnload(page)).toBe(true);
    await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();
    await expect(page.locator('#prospectus-status')).toContainText('正在上传或保存');
    await expect(page).toHaveURL(/#generate\?/);
  }finally{fixture.release();}
  await fixture.settle();
  expect(await blocksUnload(page)).toBe(false);
  // A queued click must still be rejected even after navigation becomes available.
  await page.locator('#pf-source-next').dispatchEvent('click');
  await expect(page.locator('#prospectus-status')).toContainText('尚未确认');
  await expect(page).toHaveURL(/step=choose/);
  expect(fixture.state.calls.filter(call=>call.path.endsWith('/project-files/source'))).toEqual([]);
  const saved=await recoveryRows(page);
  await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();
  await expect(page.locator('#pf-prospectus')).toHaveCount(0);
  expect(await recoveryRows(page)).toEqual(saved);
  await page.goBack();await expect(page.locator('[data-resume-prospectus]')).toBeVisible();
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  expect(fixture.selections).toHaveLength(0);expect(batches(fixture.state)).toHaveLength(0);
});

test('failed upload without a durable recovery record still protects navigation',async({page})=>{
  const fixture=await failedUpload(page);await fixture.settle();
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('bondbuddy:upload-recovery:v1:'))localStorage.removeItem(key);});
  expect(await blocksUnload(page)).toBe(true);
  await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();
  await expect(page.locator('#prospectus-status')).toContainText('尚未确认');
  await expect(page).toHaveURL(/#generate\?/);await expect(page.locator('#pf-source-next')).toBeDisabled();
});

test('unconfirmed adoption stays protected and retries the same selection request',async({page})=>{
  const fixture=await sourceFixture(page,true);
  fixture.versions.versions.push({...fixture.versions.versions[0],version_id:'old-source',sequence:2,filename:'第二稿.docx',material_id:'old-material'});
  fixture.control.dropSelection=true;
  await page.goto('/'+href({step:'choose'}));await page.locator('#pf-project-source').selectOption('old-source');
  await expect(page.locator('#retry-prospectus-selection')).toBeVisible();
  expect(await blocksUnload(page)).toBe(true);
  await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();
  await expect(page.locator('#prospectus-status')).toContainText('尚未确认');
  await expect(page).toHaveURL(/#generate\?/);await expect(page.locator('#pf-source-next')).toBeDisabled();
  await page.locator('#retry-prospectus-selection').click();await expect(page.locator('#pf-source-next')).toBeEnabled();
  expect(fixture.selections).toHaveLength(2);expect(fixture.selections[1]).toEqual(fixture.selections[0]);
  await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();await expect(page.locator('#pf-prospectus')).toHaveCount(0);
});
