import {expect,test,type Locator,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {addHead,assertFixture,editedFile,fileKey,filesHash,filesRoute,fixture,gate,ids,latest,login,navigate,noBusiness,noExecution,
  open,otherProject,pageFor,ready,uploadJournal,type State} from './desktop-file-workflow-fixtures';
import {hash} from './word-roundtrip-fixtures';
import {captureDesktopFileWorkflow,installDesktopFileWorkflowReference} from './desktop-file-workflow-reference';

const reference=process.env.BB_DESKTOP_FILE_WORKFLOW_REFERENCE==='1';
const tasks=(page:Page)=>page.locator('#pw-task-summary [data-pw-task-run]');
const taskRow=(page:Page,run:string)=>page.locator('#pw-task-summary [data-pw-task-run="'+run+'"]');
const toggle=(page:Page)=>page.locator('[data-pw-task-history-toggle]');
const more=(page:Page)=>page.locator('[data-pw-task-more]');
const retry=(page:Page)=>page.locator('[data-pw-task-retry]');
const importDialog=(page:Page)=>page.getByRole('dialog',{name:'上传项目关联文件',exact:true});
const modifiedDialog=(page:Page)=>page.getByRole('dialog',{name:'上传此文件修改稿',exact:true});
async function topUpload(page:Page){await page.locator('#import-project-file').click();await expect(importDialog(page)).toBeVisible();return importDialog(page);}
async function expanded(page:Page,count:number){await expect(toggle(page)).toBeVisible();await toggle(page).click();await expect(tasks(page)).toHaveCount(count);}
async function showOlder(page:Page,count=25){await expanded(page,20);await more(page).click();await expect(tasks(page)).toHaveCount(count);}
async function refresh(page:Page){await page.locator('#refresh-files').click();await expect(page.locator('#refresh-files')).toBeEnabled();}
async function returnFiles(page:Page){await page.getByRole('link',{name:'返回本项目文件',exact:true}).click();await expect(page.locator('#file-list')).toBeVisible();await ready(page);}
async function enterTask(page:Page,s:State){
  const link=taskRow(page,ids.originalRun).getByRole('link');const href=await link.getAttribute('href'),q=new URLSearchParams(href!.split('?')[1]);
  expect(q.get('run')).toBe(ids.originalRun);expect(q.get('topic')).toBe(ids.topic);expect(q.get('return_project')).toBe(ids.root);
  expect(s.workflowTasks.find(t=>t.run_id===ids.originalRun)?.project_id).toBe(ids.execution);
  await link.click();await expect(page.locator('.m4-delivery')).toContainText('立项报告原稿_V1.docx');
  expect(s.quotes).toEqual([]);expect(s.executions).toEqual([]);
}
async function taskReading(row:Locator){await row.focus();await row.evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));return (await row.boundingBox())!.y;}
async function expectTaskY(row:Locator,y:number){await expect(row).toBeInViewport();await expect.poll(async()=>Math.abs((await row.boundingBox())!.y-y)).toBeLessThanOrEqual(8);}
async function assertUploaded(s:State,type:ReturnType<typeof latest>['document_type'],oldVersion:string,oldInit:string){
  expect(s.sessions.size).toBe(1);expect(s.puts).toBe(1);expect(s.imports).toHaveLength(1);
  const body=s.imports[0];expect(body.document_type).toBe(type);expect(body.expected_latest_version_id).toBe(oldVersion);
  const saved=latest(s,type);expect(saved.sequence).toBe(2);expect(saved.asset.kind).toBe('material');
  if(saved.asset.kind!=='material')throw new Error('Expected imported material');
  const stored=s.materials.get(saved.asset.pin.material_id)!;expect(stored.bytes).toEqual(editedFile.buffer);expect(stored.dto.sha256).toBe(hash(editedFile.buffer));
  expect(s.importReceipts.size).toBe(1);expect(latest(s,'init').version_id).toBe(oldInit);noExecution(s);
}

test.describe('desktop file daily workflow journeys',()=>{
  test.skip(reference,'The exact R31 component is used only for its explicit comparison.');
  test.use({viewport:{width:1440,height:960}});

  test('a non-init leaf presets the top upload; changing the type keeps the same File and saves only the real selected family with its CAS',async({page})=>{
    const s=await open(page),oldFinancial=latest(s,'financial').version_id,oldInit=latest(s,'init').version_id;
    await page.locator('[data-file-type="issuer"]').click();const d=await topUpload(page),type=d.locator('[name=type]'),file=d.locator('[name=file]');
    await expect(type).toHaveValue('issuer');await expect(type).toBeEnabled();await file.setInputFiles(editedFile);
    await file.evaluate(e=>{(window as unknown as {desktopChosenFile?:File}).desktopChosenFile=(e as HTMLInputElement).files![0];});
    await type.selectOption('financial');expect(await file.evaluate(e=>(e as HTMLInputElement).files![0]===(window as unknown as {desktopChosenFile?:File}).desktopChosenFile)).toBe(true);
    await d.getByRole('button',{name:'保存项目文件',exact:true}).click();await expect(d).toHaveCount(0);await expect(page.locator('#pw-import-result')).toContainText('V2');
    await assertUploaded(s,'financial',oldFinancial,oldInit);expect(await uploadJournal(page)).toEqual({});
  });

  test('without a selected document type native validation and an explicit synthetic submit both stop before upload; the same File can then be saved after selection',async({page})=>{
    const s=await open(page),oldIssuer=latest(s,'issuer').version_id,oldInit=latest(s,'init').version_id;
    await page.locator('[data-folder="4.1"]').click();const d=await topUpload(page),type=d.locator('[name=type]'),file=d.locator('[name=file]');
    await expect(type).toHaveValue('');await expect(type).toHaveAttribute('required','');await file.setInputFiles(editedFile);
    await file.evaluate(e=>{(window as unknown as {desktopBlankTypeFile?:File}).desktopBlankTypeFile=(e as HTMLInputElement).files![0];});
    expect(await type.evaluate(e=>(e as HTMLSelectElement).checkValidity())).toBe(false);
    await d.getByRole('button',{name:'保存项目文件',exact:true}).click();expect(s.sessions.size).toBe(0);expect(s.imports).toEqual([]);expect(await uploadJournal(page)).toEqual({});
    await d.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    await expect(d.locator('[role=status]')).toContainText('请选择有效的文件类型');await expect(type).toBeFocused();expect(s.sessions.size).toBe(0);expect(s.puts).toBe(0);expect(s.imports).toEqual([]);
    await expect(page.locator('[data-resume-project-file]')).toHaveCount(0);expect(await uploadJournal(page)).toEqual({});
    expect(await file.evaluate(e=>(e as HTMLInputElement).files![0]===(window as unknown as {desktopBlankTypeFile?:File}).desktopBlankTypeFile)).toBe(true);
    expect(await file.evaluate(e=>(e as HTMLInputElement).files![0].name)).toBe(editedFile.name);
    await type.selectOption('issuer');await d.getByRole('button',{name:'保存项目文件',exact:true}).click();await expect(d).toHaveCount(0);
    await assertUploaded(s,'issuer',oldIssuer,oldInit);expect(await uploadJournal(page)).toEqual({});
  });

  test('a row upload remains locked to its family and an unknown receipt survives a new leaf, expanded history and a blocked task navigation with the original envelope',async({page})=>{
    const s=await open(page);s.dropImportOnce=true;const original=latest(s,'issuer');
    await expanded(page,4);await page.locator('[data-file-type="issuer"]').click();
    await page.locator('[data-file-family="'+original.file_id+'"]').getByRole('button',{name:'上传此文件修改稿',exact:true}).click();
    const d=modifiedDialog(page);await expect(d.locator('[name=type]')).toHaveValue('issuer');await expect(d.locator('[name=type]')).toBeDisabled();
    await d.locator('[name=file]').setInputFiles(editedFile);await d.getByRole('button',{name:'保存项目文件',exact:true}).click();await expect(d.locator('[role=status]')).toContainText('尚未确认');
    const first=structuredClone(s.imports[0]),journal=await uploadJournal(page);expect(first.expected_latest_version_id).toBe(original.version_id);
    await d.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('[data-file-type="financial"]').click();
    const route=await page.evaluate(()=>location.hash);await taskRow(page,ids.originalRun).getByRole('link').click();await expect.poll(()=>page.evaluate(()=>location.hash)).toBe(route);
    await expect(page.locator('#file-action-status')).toContainText('保存结果尚未确认');await expect(tasks(page)).toHaveCount(4);
    await page.locator('#logout').click();expect(s.authPosts).toEqual([]);expect(s.imports).toEqual([first]);expect(await uploadJournal(page)).toEqual(journal);
    await page.locator('[data-resume-project-file]').click();const recovery=modifiedDialog(page);await expect(recovery.locator('[name=type]')).toHaveValue('issuer');await expect(recovery.locator('[name=type]')).toBeDisabled();
    await recovery.getByRole('button',{name:'保存项目文件',exact:true}).click();await expect(recovery).toHaveCount(0);
    expect(s.imports).toEqual([first,first]);expect(s.puts).toBe(1);expect(s.importReceipts.size).toBe(1);expect(latest(s,'issuer').sequence).toBe(2);expect(await uploadJournal(page)).toEqual({});noExecution(s);
  });

  test('four loaded tasks with no server continuation expose the fourth inside this project and can be collapsed without a request',async({page})=>{
    const s=await open(page);await expect(tasks(page)).toHaveCount(3);expect(pageFor(s,null).page.has_more).toBe(false);
    const reads=s.taskPageCalls.length;await expanded(page,4);await expect(taskRow(page,ids.originalRun)).toBeVisible();await expect(more(page)).toHaveCount(0);
    expect(s.taskPageCalls.length).toBe(reads);await toggle(page).click();await expect(tasks(page)).toHaveCount(3);await toggle(page).click();await expect(tasks(page)).toHaveCount(4);noBusiness(s);
  });

  test('twenty-five tasks load an actual twenty-item head and its cursor page without losing or duplicating the older five',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await showOlder(page);
    expect(await tasks(page).evaluateAll(rows=>rows.map(e=>(e as HTMLElement).dataset.pwTaskRun))).toEqual(s.workflowTasks.map(t=>t.run_id));
    expect(s.taskPageCalls.map(c=>c.cursor)).toEqual([null,'desktop-after:'+s.workflowTasks[19].run_id]);await expect(more(page)).toHaveCount(0);noBusiness(s);
  });

  test('refresh follows the fresh cursor chain through a new head to the previously read tail and refreshes every retained task',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await showOlder(page);const oldTail=s.workflowTasks.at(-1)!.run_id,oldCursor=s.taskPageCalls.at(-1)!.cursor;
    const head=addHead(s);s.workflowTasks.at(-1)!.state='paused';s.workflowTasks.at(-1)!.stage='awaiting_input';const start=s.taskPageCalls.length;
    await refresh(page);await expect(tasks(page)).toHaveCount(26);await expect(taskRow(page,head.run_id)).toContainText('执行中');await expect(taskRow(page,oldTail)).toContainText('已暂停');
    const calls=s.taskPageCalls.slice(start);expect(calls.map(c=>c.cursor)).toEqual([null,'desktop-after:'+s.workflowTasks[19].run_id]);expect(calls[1].cursor).not.toBe(oldCursor);
    expect(await tasks(page).evaluateAll(rows=>rows.map(e=>(e as HTMLElement).dataset.pwTaskRun))).toEqual(s.workflowTasks.map(t=>t.run_id));noBusiness(s);
  });

  test('a failed older page and a later failed full-range refresh retain the entire readable history and retry only reads',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await expanded(page,20);const cursor=pageFor(s,null).page.next_cursor!;s.taskPageFailures.add(cursor);
    await more(page).click();await expect(retry(page)).toBeVisible();await expect(tasks(page)).toHaveCount(20);expect(s.taskPageCalls.at(-1)!.cursor).toBe(cursor);
    s.taskPageFailures.delete(cursor);await retry(page).click();await expect(tasks(page)).toHaveCount(25);
    const runs=await tasks(page).evaluateAll(rows=>rows.map(e=>(e as HTMLElement).dataset.pwTaskRun));s.taskPageFailures.add('');await refresh(page);
    await expect(retry(page)).toBeVisible();expect(await tasks(page).evaluateAll(rows=>rows.map(e=>(e as HTMLElement).dataset.pwTaskRun))).toEqual(runs);
    s.taskPageFailures.clear();await retry(page).click();await expect(retry(page)).toHaveCount(0);await expect(tasks(page)).toHaveCount(25);noBusiness(s);
  });

  test('a schema-valid continuation that duplicates a newer head is rejected atomically and the original cursor remains retryable',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await expanded(page,20);s.taskPageFault='duplicate';const before=await tasks(page).evaluateAll(rows=>rows.map(e=>(e as HTMLElement).dataset.pwTaskRun));
    await more(page).click();await expect(retry(page)).toBeVisible();expect(await tasks(page).evaluateAll(rows=>rows.map(e=>(e as HTMLElement).dataset.pwTaskRun))).toEqual(before);
    const cursor=s.taskPageCalls.at(-1)!.cursor;s.taskPageFault=null;await retry(page).click();await expect(tasks(page)).toHaveCount(25);expect(s.taskPageCalls.at(-1)!.cursor).toBe(cursor);noBusiness(s);
  });

  test('an older child execution task opens its exact native result and shell return rereads the loaded range and restores a non-executing history row',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await showOlder(page);const y=await taskReading(taskRow(page,ids.originalRun)),reads=s.taskPageCalls.length;
    await enterTask(page,s);await returnFiles(page);await expect(tasks(page)).toHaveCount(25);await expect(taskRow(page,ids.originalRun)).toBeFocused();await expectTaskY(taskRow(page,ids.originalRun),y);
    expect(await page.evaluate(()=>document.activeElement?.tagName)).toBe('ARTICLE');expect(s.taskPageCalls.length).toBeGreaterThan(reads);expect(s.workspace.drafts.init.edit_base).toBeNull();noBusiness(s);
  });

  test('the real thirty-second refresh preserves a task row while a new head arrives, and a missing remembered run returns to the history heading instead of a substitute',async({page})=>{
    await page.clock.install();const s=await open(page,fixture({tasks:25}));await showOlder(page);const original=taskRow(page,ids.originalRun),y=await taskReading(original),reads=s.taskPageCalls.length;
    const head=addHead(s);await page.clock.fastForward(30_001);await expect.poll(()=>s.taskPageCalls.length).toBeGreaterThan(reads);
    await expect(tasks(page)).toHaveCount(26);await expect(taskRow(page,head.run_id)).toBeVisible();await expect(original).toBeFocused();await expectTaskY(original,y);
    await enterTask(page,s);const index=s.workflowTasks.findIndex(t=>t.run_id===ids.originalRun),substitute={...structuredClone(s.workflowTasks[index]),run_id:'desktop-file-same-name-substitute'};
    s.workflowTasks.splice(index,1,substitute);await returnFiles(page);await expect(tasks(page)).toHaveCount(26);await expect(taskRow(page,ids.originalRun)).toHaveCount(0);
    await expect(page.locator('#pw-task-history-heading')).toBeFocused();await expect(taskRow(page,substitute.run_id)).not.toBeFocused();
    expect(await page.evaluate(()=>document.activeElement?.closest('[data-pw-task-run]')?.getAttribute('data-pw-task-run')??null)).toBeNull();noBusiness(s);
  });

  test('optional initial and returning task reads never delay files or take focus from a newer Chinese search',async({page})=>{
    const s=fixture({tasks:25}),initial=gate();s.taskPageGates.set('',initial.promise);await open(page,s);
    await expect(page.locator('#file-list')).toBeVisible();await page.locator('#file-search').fill('立项');await expect(page.locator('#file-search')).toBeFocused();initial.release();s.taskPageGates.clear();
    await expect(tasks(page)).toHaveCount(3);await expect(page.locator('#file-search')).toBeFocused();await showOlder(page);await taskReading(taskRow(page,ids.originalRun));await enterTask(page,s);
    const returning=gate();s.taskPageGates.set('',returning.promise);await returnFiles(page);await page.locator('#file-search').fill('新的中文查找');await expect(page.locator('#file-search')).toBeFocused();
    returning.release();s.taskPageGates.clear();await expect(tasks(page)).toHaveCount(25);await expect(page.locator('#file-search')).toHaveValue('新的中文查找');await expect(page.locator('#file-search')).toBeFocused();noBusiness(s);
  });

  test('expanded task memory is isolated by project and owner and a real logout clears the same owner’s old loaded boundary',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await showOlder(page);await navigate(page,'#/projects/'+otherProject+'/files');await ready(page);
    await expect(tasks(page)).toHaveCount(0);await navigate(page,filesHash);await ready(page);await expect(tasks(page)).toHaveCount(25);
    await page.locator('#logout').click();await login(page,'return_b');await navigate(page,'#/projects/'+ids.otherRoot+'/files');await ready(page);await expect(tasks(page)).toHaveCount(0);
    await page.locator('#logout').click();await login(page);const reads=s.taskPageCalls.length;await navigate(page,filesHash);await ready(page);await expect(tasks(page)).toHaveCount(3);
    expect(s.taskPageCalls.slice(reads).map(c=>c.cursor)).toEqual([null]);await toggle(page).click();await expect(tasks(page)).toHaveCount(20);expect(s.authPosts.map(p=>p.path)).toEqual(['/auth/logout','/auth/login','/auth/logout','/auth/login']);noBusiness(s);
  });

  test('an exact R30 file context overrides ordinary task reading memory and focuses its verified current family',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await showOlder(page);await taskReading(taskRow(page,ids.originalRun));await enterTask(page,s);
    await navigate(page,filesRoute('&folder=4.1&type=issuer&q='+encodeURIComponent('发行人')).slice(1));await ready(page);
    const target=page.locator('#file-list [data-file-key="'+fileKey+'"]');await expect(page.locator('#pw-file-context')).toContainText('检查时原文件');await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('data-file-context-target','true');await expect(page.locator('#file-search')).toHaveValue('');await expect(page.locator('[data-file-type="init"]')).toHaveAttribute('aria-current','page');
    expect(await page.evaluate(()=>document.activeElement?.closest('[data-pw-task-run]')?.getAttribute('data-pw-task-run')??null)).toBeNull();noBusiness(s);
  });

  test('an explicit new file type and Chinese query keep the expanded task range but never restore its old task focus or scroll',async({page})=>{
    const s=await open(page,fixture({tasks:25}));await showOlder(page);await taskReading(taskRow(page,ids.originalRun));await enterTask(page,s);
    await page.evaluate(()=>{
      const record={scrollBy:[] as unknown[][],taskScroll:[] as string[],taskFocus:[] as string[]};
      (window as unknown as {desktopExplicitTaskRestore:typeof record}).desktopExplicitTaskRestore=record;
      const scrollBy=window.scrollBy,scrollIntoView=Element.prototype.scrollIntoView;
      window.scrollBy=((...args:unknown[])=>{record.scrollBy.push(args);return Reflect.apply(scrollBy,window,args);}) as typeof window.scrollBy;
      Element.prototype.scrollIntoView=function(options?:boolean|ScrollIntoViewOptions){
        const element=this as HTMLElement;if(element.dataset.pwTaskRun||element.id==='pw-task-history-heading')record.taskScroll.push(element.dataset.pwTaskRun??element.id);
        return scrollIntoView.call(this,options);
      };
      document.addEventListener('focusin',event=>{
        if(!(event.target instanceof HTMLElement))return;const row=event.target.closest<HTMLElement>('[data-pw-task-run]');
        if(row||event.target.id==='pw-task-history-heading')record.taskFocus.push(row?.dataset.pwTaskRun??event.target.id);
      });
    });
    await navigate(page,filesHash+'?type=issuer&q='+encodeURIComponent('发行人'));await ready(page);await expect(tasks(page)).toHaveCount(25);
    await expect(page.locator('#file-search')).toHaveValue('发行人');await expect(page.locator('[data-file-type="issuer"]')).toHaveAttribute('aria-current','page');
    const query=await page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
    expect(query).toMatchObject({folder:'4.1',type:'issuer',q:'发行人'});await expect(page.locator('#file-list>.collection-file')).toHaveCount(1);
    await expect(page.locator('#file-list')).toContainText('发行人基本情况.docx');await expect(taskRow(page,ids.originalRun)).not.toBeFocused();
    expect(await page.evaluate(()=>(window as unknown as {desktopExplicitTaskRestore:{scrollBy:unknown[][];taskScroll:string[];taskFocus:string[]}}).desktopExplicitTaskRestore))
      .toEqual({scrollBy:[],taskScroll:[],taskFocus:[]});
    expect(await tasks(page).evaluateAll(rows=>rows.map(e=>(e as HTMLElement).dataset.pwTaskRun))).toEqual(s.workflowTasks.map(t=>t.run_id));noBusiness(s);
  });
});

test('desktop file workflow component comparison: unselected upload, non-init preset, expanded task history and real task return at the same desktop size',async({page})=>{
  const directory=process.env.BB_DESKTOP_FILE_WORKFLOW_EVIDENCE_DIR,finalize=reference?await installDesktopFileWorkflowReference(page):undefined;
  const s=await open(page,fixture({tasks:4,originalIndex:2})),prefix=reference?'reference':'implementation';
  const audit=()=>({scope:'Exact R31 ProjectFiles or current ProjectFiles; same synthetic collection, immutable bytes and native M4 task in the current surrounding application.',
    expected_original_run:ids.originalRun,expected_root:ids.root,http:s.calls,unexpected:s.unexpected,browser_errors:s.errors,operations:{imports:s.imports,checks:s.checkRequests,updates:s.updatePosts,quotes:s.quotes,executions:s.executions}});
  let d=await topUpload(page);await expect(d.locator('[name=type]')).toHaveValue(reference?'init':'');
  if(directory)await captureDesktopFileWorkflow(page,directory,prefix+'-unselected-upload-1440',audit());await d.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('[data-file-type="issuer"]').click();d=await topUpload(page);await expect(d.locator('[name=type]')).toHaveValue(reference?'init':'issuer');
  if(directory)await captureDesktopFileWorkflow(page,directory,prefix+'-issuer-upload-1440',audit());await d.getByRole('button',{name:'关闭',exact:true}).click();
  if(!reference){await expanded(page,4);await taskRow(page,ids.originalRun).focus();}
  else await expect(page.locator('#pw-task-summary article')).toHaveCount(3);
  await page.locator('#pw-task-summary').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  if(directory)await captureDesktopFileWorkflow(page,directory,prefix+'-expanded-history-1440',audit());
  if(reference){await expect(page.locator('#pw-task-summary a[href*="run='+ids.originalRun+'"]').first()).toBeVisible();await page.locator('#pw-task-summary a[href*="run='+ids.originalRun+'"]').first().click();await expect(page.locator('.m4-delivery')).toContainText('立项报告原稿_V1.docx');}
  else await enterTask(page,s);
  await returnFiles(page);if(!reference){await expect(tasks(page)).toHaveCount(4);await expect(taskRow(page,ids.originalRun)).toBeFocused();}else await expect(page.locator('#pw-task-summary article')).toHaveCount(3);
  if(directory)await captureDesktopFileWorkflow(page,directory,prefix+'-returned-history-1440',audit());
  if(finalize){const provenance=await finalize();if(directory)await writeFile(join(directory,'reference-provenance-1440.json'),JSON.stringify(provenance,null,2));}
  noBusiness(s);assertFixture(s);
});
