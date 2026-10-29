import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { install, mount, file, secondFile, recovery, draftWrites, noBusiness } from './review-upload-twelfth-fixtures';

for (const width of [1440, 390]) test(`upload progress survives repaint and keeps recovery actions out of normal uploads at ${width}`, async ({page}) => {
  await page.setViewportSize({width,height:960});
  const state=await install(page);await mount(page);
  let finish!:()=>void;state.completeGate=()=>new Promise<void>(resolve=>{finish=resolve;});
  await page.evaluate(async()=>{
    const path='/src/api.ts', {ApiClient}=await import(path), original=ApiClient.prototype.uploadBytes;
    ApiClient.prototype.uploadBytes=async function(url:string, file:File, progress:(loaded:number,total:number)=>void, signal:AbortSignal){
      progress(Math.floor(file.size*.4),file.size);
      await new Promise<void>(resolve=>{(window as any).continueBytes=resolve;});
      return original.call(this,url,file,progress,signal);
    };
  });
  await page.locator('[data-review-upload-role=audit]').setInputFiles([file,secondFile]);
  const first=recovery(page), second=recovery(page,secondFile.name);
  await expect(first.getByRole('progressbar')).toHaveAttribute('value',String(Math.floor(Math.floor(file.buffer.length*.4)/file.buffer.length*100)));
  await expect(second.getByRole('progressbar')).toHaveAttribute('value','0');
  await expect(first.locator('.material-file-actions')).toBeHidden();
  await expect(page.getByText('确认原上传并保存材料选择',{exact:true})).toHaveCount(0);
  await expect(page.getByText('停止本机后续保存',{exact:true})).toHaveCount(0);
  await first.scrollIntoViewIfNeeded();await mkdir('test-evidence/upload-autosave',{recursive:true});
  await page.screenshot({path:`test-evidence/upload-autosave/upload-${width}.png`});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>(window as any).continueBytes());
  await expect(first.getByRole('progressbar')).toHaveAttribute('value','100');
  await expect(first).toContainText('正在保存');
  await expect.poll(()=>typeof finish).toBe('function');state.completeGate=undefined;finish();
  await expect(first).toHaveCount(0);
  await expect(second.getByRole('progressbar')).toHaveAttribute('value',String(Math.floor(Math.floor(secondFile.buffer.length*.4)/secondFile.buffer.length*100)));
  await page.evaluate(()=>(window as any).continueBytes());
  await expect(second).toHaveCount(0);expect(state.draft.material_versions).toHaveLength(4);noBusiness(state);
});

test('review requirements autosave with no save button and restore after reload', async({page})=>{
  const state=await install(page);await mount(page);
  await page.locator('#review-requirements').fill('重点复核授信金额\n保持单位一致');
  await page.clock.runFor(700);
  await expect.poll(()=>state.draft.requirements).toEqual(['重点复核授信金额','保持单位一致']);
  await expect(page.locator('#review-requirements-status')).toHaveText('要求已保存');
  await expect(page.getByRole('button',{name:'保存要求',exact:true})).toHaveCount(0);
  await mount(page,{navigation:'reload'});
  await expect(page.locator('#review-requirements')).toHaveValue('重点复核授信金额\n保持单位一致');noBusiness(state);
});

test('review IME input waits for composition and saves edits made during an in-flight save', async({page})=>{
  const state=await install(page);await mount(page);const input=page.locator('#review-requirements');
  await input.dispatchEvent('compositionstart');await input.fill('拼音输入中');await page.clock.runFor(1000);expect(draftWrites(state)).toHaveLength(0);
  await input.fill('最终中文要求');await input.dispatchEvent('compositionend');
  let finish!:()=>void;state.draftGate=()=>new Promise<void>(resolve=>{finish=resolve;});await page.clock.runFor(700);
  await expect.poll(()=>draftWrites(state).length).toBe(1);await input.fill('保存时继续补充的最新要求');
  state.draftGate=undefined;finish();await expect.poll(()=>state.draft.requirements).toEqual(['保存时继续补充的最新要求']);
  await expect(input).toHaveValue('保存时继续补充的最新要求');await expect(page.locator('#review-requirements-status')).toHaveText('要求已保存');noBusiness(state);
});
