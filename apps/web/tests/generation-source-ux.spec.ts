import {test,expect,type Page,type Locator} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {sourceFixture} from './generation-source-fixtures';
import {href,ids,file,writes} from './generation-entry-fixtures';

const name='合成发行人2026年度第一期公司债券募集说明书.docx';
async function seedRecovery(page:Page){
  await page.evaluate(async({owner,project,name,sha256,size,mime})=>{
    const module='/src/upload-recovery.ts',apiModule='/src/api.ts';
    const {UploadRecovery}=await import(module),{ApiClient}=await import(apiModule);
    new UploadRecovery(new ApiClient(()=>{}),owner,project,'prospectus-version').begin({filename:name,sha256,byte_size:size,media_type:mime,role:'historical'},{purpose:'generation'});
  },{owner:ids.owner,project:ids.api,name,sha256:createHash('sha256').update(file.buffer).digest('hex'),size:file.buffer.length,mime:file.mimeType});
  await page.reload();
}
async function visibleButton(button:Locator){
  await expect(button).toBeVisible();await expect(button).toBeEnabled();
  const style=await button.evaluate(element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return {height:box.height,border:parseFloat(style.borderTopWidth),background:style.backgroundColor,cursor:style.cursor};});
  expect(style.height).toBeGreaterThanOrEqual(40);expect(style.cursor).toBe('pointer');
  expect(style.border>=1||!['transparent','rgba(0, 0, 0, 0)'].includes(style.background)).toBe(true);
  await button.focus();await expect(button).toBeFocused();
}
async function capture(page:Page,name:string,selector='.pf-source-workspace'){
  const dir=process.env.BB_SOURCE_UX_EVIDENCE;if(!dir)return;await mkdir(dir,{recursive:true});
  await page.locator(selector).screenshot({path:join(dir,name+'.png')});
}
for(const width of [1440,390,320])test(`source actions are discoverable and cancellation is local, ${width}px`,async({page})=>{
  const fixture=await sourceFixture(page,false);await page.setViewportSize({width,height:1000});await page.goto('/'+href({step:'choose'}));
  await expect(page.getByRole('button',{name:'选择文件 或将文件拖到这里'})).toBeVisible();
  await expect(page.getByText('尚未选择本次生成依据。',{exact:true})).toHaveCount(0);
  await expect(page.locator('.pf-source-actions p')).toHaveCount(0);
  await capture(page,'actual-empty-'+width);
  await seedRecovery(page);
  const card=page.locator('.pf-source-upload-state');await expect(card).toContainText(name);
  await capture(page,'actual-recovery-'+width);
  await visibleButton(card.getByRole('button',{name:'重试上传',exact:true}));
  const cancel=card.getByRole('button',{name:'取消本次上传',exact:true});await visibleButton(cancel);
  await expect(page.getByRole('button',{name:'重新选择原文件'})).toBeHidden();
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  await expect(page.locator('[data-file-upload-progress]')).toBeEmpty();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await capture(page,'actual-recovery-'+width);
  const before=writes(fixture.state).length;
  await cancel.press('Enter');
  await expect(card).toHaveCount(0);await expect(page.locator('#prospectus-status')).toContainText('已保存的文件仍保留');
  expect(writes(fixture.state)).toHaveLength(before);expect(fixture.state.errors).toEqual([]);
  const reference=resolve(process.cwd(),'../../product-prototype/public/file-generation-source-actions.html').replaceAll('\\','/');
  for(const state of ['empty','recovery']){await page.goto('/@fs/'+reference+'?state='+state);await expect(page.locator('#reference h2')).toBeVisible();await capture(page,'reference-'+state+'-'+width,'#reference');}
});

test('only asks for original bytes when retry needs them, then resumes after selection',async({page})=>{
  const fixture=await sourceFixture(page,false);await page.goto('/'+href({step:'choose'}));await seedRecovery(page);
  await page.getByRole('button',{name:'重试上传',exact:true}).filter({visible:true}).click();
  await expect(page.locator('#prospectus-status')).toContainText('需要重新上传');
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'重新选择原文件'}).click();await(await chooser).setFiles({...file,name});
  await expect(page.locator('#pf-source-next')).toBeEnabled();await expect(page.locator('.pf-selected-source')).toContainText(name);
  expect(fixture.state.sessions.size).toBe(1);expect(fixture.state.puts).toBe(1);
});

test('active upload has one progress display and no idle recovery actions',async({page})=>{
  const fixture=await sourceFixture(page,false);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/materials/uploads/*/bytes',async route=>{await gate;await route.fallback();});
  await page.goto('/'+href({step:'choose'}));await page.locator('#prospectus-version-file').setInputFiles({...file,name});
  try{
    await expect.poll(()=>fixture.state.sessions.size).toBe(1);
    await expect(page.locator('.file-upload-progress')).toHaveCount(1);
    await expect(page.locator('.pf-upload-actions')).toBeHidden();
    await expect(page.locator('#prospectus-status')).toBeHidden();
    await capture(page,'actual-uploading-1440');
  }finally{release();}
  await expect(page.locator('#pf-source-next')).toBeEnabled();
  await expect(page.locator('.file-upload-progress')).toHaveCount(0);
  await expect(page.locator('.pf-selected-source')).toContainText(name);
  await expect(page.locator('#prospectus-status')).toBeEmpty();
  await capture(page,'actual-selected-1440');
});
