import {expect,test,type Page} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertFixture,cacheBody,cacheKey,decisions,editor,fixture,install,mutations,owner,pending,projectId,runId,savedManual,secondId,secondTitle,setup,title} from './review-flow-editor-fixtures';
import {captureReviewFlow,installReviewFlowReference} from './review-flow-editor-reference';

test.afterEach(({page})=>assertFixture(page));
const dialog=(page:Page)=>page.getByRole('dialog',{name:'准备下一轮复核',exact:true});
const key=cacheKey();
async function rawCache(page:Page){return page.evaluate(key=>localStorage.getItem(key),key);}
async function manual(page:Page,text:string){const host=await editor(page);await host.getByRole('radio',{name:'手动修改',exact:true}).check();await host.locator('#review-manual-text').fill(text);return host;}

// Six desktop user journeys. Existing recovery suites cover the wider schema/storage matrix.
test('review flow: discard restores viewed V1, clears only its cache and unlocks followup/history without export',async({page})=>{
  const state=await setup(page),host=await manual(page,'本页尝试的现金流处理，尚未保存。');
  const foreignKeys=[cacheKey(runId(2)),cacheKey(runId(1),'another-owner'),cacheKey(runId(1),owner,'another-project')];
  await page.evaluate(keys=>keys.forEach((key,index)=>localStorage.setItem(key,'scope-sentinel-'+index)),foreignKeys);
  await expect(host.locator('[data-editor-followup]')).toBeDisabled();await expect(host.locator('[data-editor-current]')).toBeDisabled();
  await host.locator('[data-editor-discard]').click();await expect(host.locator('[data-editor-history]')).toHaveValue(runId(1));
  await expect(host.getByRole('radio',{name:'保留原文',exact:true})).toBeChecked();await expect(host.locator('[data-editor-document]')).not.toContainText('本页尝试的现金流处理');
  await expect(host.locator('[data-editor-state]')).toHaveText('当前查看已保存版本');await expect(host.locator('[data-editor-save]')).toBeDisabled();
  await expect(host.locator('[data-editor-followup]')).toBeEnabled();await expect(host.locator('[data-editor-current]')).toBeEnabled();expect(await rawCache(page)).toBeNull();
  expect(await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),foreignKeys)).toEqual(foreignKeys.map((_key,index)=>'scope-sentinel-'+index));
  await host.locator('[data-editor-followup]').click();await expect(dialog(page)).toContainText('来源成果 V1');await expect(dialog(page)).toContainText(title(1));
  await dialog(page).getByRole('button',{name:'返回',exact:true}).click();
  const completed=page.waitForEvent('download');await host.getByRole('button',{name:'下载清洁版',exact:true}).click();const download=await completed;
  expect(download.suggestedFilename()).toBe('合成复核成果V1-clean.docx');expect(await readFile((await download.path())!)).toEqual(state.wordBytes.get('followup-1-clean'));
  // Remove the unrelated synthetic V2 sentinel only to allow that edition to open normally.
  await page.evaluate(key=>localStorage.removeItem(key),foreignKeys[0]);
  await host.locator('[data-editor-history]').selectOption(runId(2));await editor(page,2);await expect(page).toHaveURL(new RegExp('run='+runId(2)));
  expect(state.catalog.current_version_id).toBe('followup-clean-version-2');expect(state.catalog.selection_revision).toBe(9);expect(mutations(state)).toEqual([]);expect(state.exports).toEqual([]);
});

test('review flow: manual return to baseline keeps caret and controls in sync, while nonmanual hidden draft survives reload clean',async({page})=>{
  const state=await setup(page,fixture({manualBaseline:true})),host=await editor(page),area=host.locator('#review-manual-text');
  await expect(area).toHaveValue(savedManual);await area.focus();
  await area.evaluate(element=>{const area=element as HTMLTextAreaElement;(window as unknown as {flowArea:HTMLTextAreaElement}).flowArea=area;area.setSelectionRange(3,3);});
  await page.keyboard.type('试');await expect(area).toBeFocused();await expect(host.locator('[data-editor-state]')).toHaveText('有未保存的处理选择');
  await expect(host.locator('[data-editor-save]')).toBeEnabled();await expect(host.locator('[data-editor-discard]')).toBeEnabled();await expect(host.locator('[data-editor-followup]')).toBeDisabled();
  expect(await area.evaluate(element=>({same:element===(window as unknown as {flowArea:HTMLTextAreaElement}).flowArea,caret:(element as HTMLTextAreaElement).selectionStart}))).toEqual({same:true,caret:4});
  await page.keyboard.press('Backspace');await expect(area).toHaveValue(savedManual);await expect(area).toBeFocused();
  expect(await area.evaluate(element=>({same:element===(window as unknown as {flowArea:HTMLTextAreaElement}).flowArea,caret:(element as HTMLTextAreaElement).selectionStart}))).toEqual({same:true,caret:3});
  await expect(host.locator('[data-editor-state]')).toHaveText('当前查看已保存版本');await expect(host.locator('[data-editor-save]')).toBeDisabled();await expect(host.locator('[data-editor-discard]')).toBeDisabled();await expect(host.locator('[data-editor-current]')).toBeEnabled();await expect(host.locator('[data-editor-followup]')).toBeEnabled();await expect(host.locator('[data-editor-document]')).not.toContainText('尚未保存的文字预览');
  await host.locator('[data-editor-issue="'+secondId(1)+'"]').click();await host.getByRole('radio',{name:'手动修改',exact:true}).check();await area.fill('完整保留的隐藏条款草稿。');
  await host.getByRole('radio',{name:'采用建议',exact:true}).check();await expect(host.locator('[data-editor-save]')).toBeDisabled();await expect(host.locator('[data-editor-followup]')).toBeEnabled();
  const saved=JSON.parse((await rawCache(page))!);expect(saved.value.decisions.find((decision:{id:string})=>decision.id===secondId(1))).toMatchObject({decision:'suggested',manual_text:'完整保留的隐藏条款草稿。'});
  await page.reload();await editor(page);await expect(host.locator('[data-editor-state]')).toHaveText('当前查看已保存版本');await expect(host.locator('[data-editor-save]')).toBeDisabled();
  await host.locator('[data-editor-issue="'+secondId(1)+'"]').click();await host.getByRole('radio',{name:'手动修改',exact:true}).check();await expect(area).toHaveValue('完整保留的隐藏条款草稿。');
  await host.locator('[data-editor-discard]').click();expect(await rawCache(page)).toBeNull();expect(mutations(state)).toEqual([]);
});

test('review flow: category selects the visible finding and export retains every decision across category changes',async({page})=>{
  const state=await setup(page),host=await editor(page),first=structuredClone(decisions(state)[0]);
  await host.locator('#review-editor-category').selectOption('募集条款');await expect(host.locator('[data-editor-issue]')).toHaveCount(1);
  await expect(host.locator('.review-issue-detail h3')).toHaveText(secondTitle(1));await expect(host.locator('[data-editor-issue].active')).toHaveAttribute('data-editor-issue',secondId(1));
  await host.getByRole('radio',{name:'手动修改',exact:true}).check();await host.locator('#review-manual-text').fill('人工确认期限为三年。');
  await host.locator('#review-editor-category').selectOption('all');await expect(host.locator('.review-issue-detail h3')).toHaveText(secondTitle(1));await expect(host.locator('#review-manual-text')).toHaveValue('人工确认期限为三年。');
  await host.locator('#review-editor-category').selectOption('财务核对');await expect(host.locator('.review-issue-detail h3')).toHaveText(title(1));await expect(host.getByRole('radio',{name:'保留原文',exact:true})).toBeChecked();
  await host.locator('[data-editor-save]').click();await expect.poll(()=>state.exports.length).toBe(1);
  expect(state.exports[0].source_run_id).toBe(runId(1));expect(state.exports[0].decisions).toEqual([first,{id:secondId(1),decision:'manual',manual_text:'人工确认期限为三年。'}]);
  expect(state.quotes).toEqual([]);expect(state.executions).toEqual([]);expect(state.sources).toEqual([]);expect(state.catalog.current_version_id).toBe('followup-clean-version-2');
});

test('review flow: switching historical editions resets an absent category and editing never targets a filtered-out finding',async({page})=>{
  const state=await setup(page),host=await editor(page);
  await host.locator('#review-editor-category').selectOption('募集条款');await expect(host.locator('.review-issue-detail h3')).toHaveText(secondTitle(1));
  await host.locator('[data-editor-history]').selectOption(runId(2));await editor(page,2);await expect(host.locator('#review-editor-category')).toHaveValue('all');
  await expect(host.locator('[data-editor-issue]')).toHaveCount(2);await expect(host.locator('.review-issue-detail h3')).toHaveText(title(2));await expect(host.locator('[data-editor-state]')).toHaveText('当前查看已保存版本');
  await host.locator('#review-editor-category').selectOption('信息披露');await expect(host.locator('.review-issue-detail h3')).toHaveText(secondTitle(2));
  await host.getByRole('radio',{name:'保留原文',exact:true}).check();const cached=JSON.parse((await page.evaluate(key=>localStorage.getItem(key),cacheKey(runId(2))))!);
  expect(cached.value.decisions).toEqual([decisions(state,runId(2))[0],{id:secondId(2),decision:'original',manual_text:''}]);
  await host.locator('[data-editor-discard]').click();await expect(host.locator('#review-editor-category')).toHaveValue('信息披露');await expect(host.locator('.review-issue-detail h3')).toHaveText(secondTitle(2));await expect(host.getByRole('radio',{name:'采用建议',exact:true})).toBeChecked();
  expect(mutations(state)).toEqual([]);
});

test('review flow: own baseline-equivalent pending stays locked and another page pending is recovered instead of discarded',async({page,context})=>{
  const state=await setup(page),envelope=pending(state),seed=cacheBody(state,envelope.decisions,envelope);
  await page.evaluate(({key,seed})=>localStorage.setItem(key,seed),{key,seed});await page.reload();const host=await editor(page);
  await expect(host.locator('[data-editor-state]')).toHaveText('新版导出回执待确认');await expect(host.locator('[data-editor-discard]')).toBeDisabled();await expect(host.locator('[data-editor-followup]')).toBeDisabled();await expect(host.locator('[data-editor-history]')).toBeDisabled();await expect(host.locator('[data-editor-current]')).toBeDisabled();await expect(host.locator('[data-editor-save]')).toHaveText('重试确认新版导出');expect(state.exports).toEqual([]);expect(await rawCache(page)).toBe(seed);
  await page.evaluate(key=>localStorage.removeItem(key),key);await page.reload();await manual(page,'本页先尝试的处理。');
  const other=await context.newPage();await install(other,state);await other.goto('/#/projects/'+projectId+'/review?tab=results&run='+runId(1));await editor(other);
  const typing=await context.newPage();await install(typing,state);await typing.goto('/#/projects/'+projectId+'/review?tab=results&run='+runId(1));await editor(typing);
  await other.getByRole('radio',{name:'保留待确认批注',exact:true}).check();
  state.dropExport=true;await other.locator('[data-editor-save]').click();await expect(other.locator('[data-editor-status]')).toContainText('处理选择已保留并锁定');expect(state.exports).toHaveLength(1);
  const before=await rawCache(page);await typing.locator('#review-manual-text').fill('迟到的本页键入。');await expect(typing.locator('#review-manual-text')).toHaveCount(0);await expect(typing.getByRole('radio',{name:'保留待确认批注',exact:true})).toBeChecked();await expect(typing.locator('[data-editor-discard]')).toBeDisabled();expect(await rawCache(typing)).toBe(before);
  await host.locator('[data-editor-discard]').click();await expect(host.locator('[data-editor-status]')).toContainText('另一页面存在尚未确认');
  await expect(host.locator('[data-editor-discard]')).toBeDisabled();await expect(host.locator('#review-manual-text')).toHaveCount(0);await expect(host.getByRole('radio',{name:'保留待确认批注',exact:true})).toBeChecked();await expect(host.locator('[data-editor-save]')).toHaveText('重试确认新版导出');
  expect(await rawCache(page)).toBe(before);expect(state.exports).toHaveLength(1);expect(state.executions).toEqual([]);expect(state.quotes).toEqual([]);await other.close();await typing.close();
});

test('review flow: failed scoped cache clear keeps manual work and blocks continuation until storage recovery and explicit discard',async({page})=>{
  const state=await setup(page),host=await manual(page,'清除失败也必须保留的处理。'),before=await rawCache(page);
  await page.evaluate(key=>{const saved=Storage.prototype.removeItem;(window as unknown as {flowRemove:typeof saved}).flowRemove=saved;Storage.prototype.removeItem=function(item:string){if(item===key)throw new DOMException('Synthetic remove denied','SecurityError');return saved.call(this,item);};},key);
  await host.locator('[data-editor-discard]').click();await expect(host.locator('[data-editor-status]')).toContainText('未放弃本页处理');await expect(host.locator('#review-manual-text')).toHaveValue('清除失败也必须保留的处理。');
  await expect(host.locator('[data-editor-history]')).toBeDisabled();await expect(host.locator('[data-editor-current]')).toBeDisabled();await expect(host.locator('[data-editor-followup]')).toBeDisabled();await expect(host.locator('[data-editor-save]')).toBeDisabled();await expect(host.locator('[data-editor-discard]')).toBeDisabled();expect(await rawCache(page)).toBe(before);
  await page.evaluate(()=>{Storage.prototype.removeItem=(window as unknown as {flowRemove:typeof Storage.prototype.removeItem}).flowRemove;});await host.locator('[data-editor-recover]').click();
  await expect(host.locator('#review-manual-text')).toBeEditable();await expect(host.locator('#review-manual-text')).toHaveValue('清除失败也必须保留的处理。');await host.locator('[data-editor-discard]').click();
  await expect(host.getByRole('radio',{name:'保留原文',exact:true})).toBeChecked();await expect(host.locator('[data-editor-state]')).toHaveText('当前查看已保存版本');await expect(host.locator('[data-editor-followup]')).toBeEnabled();expect(await rawCache(page)).toBeNull();expect(mutations(state)).toEqual([]);
});

test('review flow desktop component comparison shows the same historical edition, filtered detail and trial exit against exact R26',async({page})=>{
  const reference=process.env.BB_REVIEW_FLOW_REFERENCE==='1',verify=reference?await installReviewFlowReference(page):undefined;
  const directory=process.env.BB_REVIEW_FLOW_EVIDENCE_DIR??test.info().outputPath('component-capture');await page.setViewportSize({width:1440,height:960});
  const state=await setup(page),host=await editor(page);await captureReviewFlow(page,directory!,'review-flow-saved-1440',{reference,mutations:mutations(state)});
  await host.locator('#review-editor-category').selectOption('募集条款');await expect(host.locator('[data-editor-issue]')).toHaveCount(1);
  await expect(host.locator('.review-issue-detail h3')).toHaveText(reference?title(1):secondTitle(1));
  if(reference)await expect(host.locator('[data-editor-discard]')).toHaveCount(0);else await expect(host.locator('[data-editor-discard]')).toBeDisabled();
  await captureReviewFlow(page,directory!,'review-flow-category-1440',{reference,expectedVisible:secondId(1),mutations:mutations(state)});
  await host.getByRole('radio',{name:'手动修改',exact:true}).check();await host.locator('#review-manual-text').fill('组件对比中的未保存尝试。');await expect(host.locator('[data-editor-followup]')).toBeDisabled();
  await captureReviewFlow(page,directory!,'review-flow-trial-1440',{reference,mutations:mutations(state)});
  if(!reference){await host.locator('[data-editor-discard]').click();await expect(host.locator('[data-editor-history]')).toHaveValue(runId(1));await expect(host.locator('[data-editor-followup]')).toBeEnabled();await expect(host.locator('[data-editor-state]')).toHaveText('当前查看已保存版本');expect(await rawCache(page)).toBeNull();}
  else await expect(host.locator('[data-editor-save]')).toBeEnabled();
  await captureReviewFlow(page,directory!,'review-flow-exit-1440',{reference,mutations:mutations(state),canDiscard:!reference});expect(mutations(state)).toEqual([]);
  if(verify)await writeFile(join(directory!,'review-flow-reference-1440.json'),JSON.stringify(await verify(),null,2));
});
