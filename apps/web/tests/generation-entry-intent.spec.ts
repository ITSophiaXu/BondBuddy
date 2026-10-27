import {expect,test} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PROJECT_DOCUMENT_CATALOG,type M4DocumentType} from '@bondbuddy/contracts';
import type {FileGenerationBatchRequest} from '../src/file-generation-cache';
import {assertFixture,batches,checked,choose,clickEntry,confirm,documents,drafts,entry,fault,file,fixture,href,ids,installStorageControl,key,note,open,openFiles,query,raw,selected,templateWrites,trace,writes} from './generation-entry-fixtures';
import {installGenerationEntryReference} from './generation-entry-reference';

test('generation entry: the real missing-document row preserves its target through the source step without a business write',async({page})=>{
  const s=await fixture(page);s.workspaces.get(ids.api)!.batches=[{batch_id:'latest-annual',state:'complete',items:[{document_type:'annual',run_id:null,state:'succeeded',error:null}]}];
  const before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);
  await open(page);await choose(page,['init','underwriter']);
  const target=await entry(page,'credit'),link=new URLSearchParams(target.split('?')[1]);
  expect(link.get('prepare_document')).toBe('credit');expect(link.get('step')).toBe('source');expect(link.get('project')).toBe(ids.api);
  await expect(page.locator('#pf-source-next')).toBeVisible();
  await expect(page.getByRole('region',{name:'准备生成所选文种'})).toContainText(PROJECT_DOCUMENT_CATALOG.find(d=>d.id==='credit')!.name);
  expect(writes(s)).toEqual([]);expect(JSON.parse((await raw(page,'selection'))!).value).toEqual(['credit']);
  expect((await query(page)).prepare_document).toBeUndefined();expect((await query(page)).prepare_wait).toBeUndefined();
  await documents(page);expect(await selected(page)).toEqual(['credit']);
  expect(writes(s).map(c=>c.path)).toEqual([`/projects/${ids.api}/project-files/source`]);
  expect(s.workspaces.get(ids.api)!.workspace.drafts).toEqual(before);
  await page.reload();await expect(checked(page,'credit')).toBeChecked();expect(await selected(page)).toEqual(['credit']);assertFixture(s);
});

test('generation entry: invalid intent does not replace a cached choice and plain explicit empty selection still wins over the latest batch',async({page})=>{
  const s=await fixture(page);s.workspaces.get(ids.api)!.batches=[{batch_id:'latest-annual',state:'complete',items:[{document_type:'annual',run_id:null,state:'succeeded',error:null}]}];
  await open(page);await choose(page,['init']);await open(page,{prepare_document:'unknown-document'});
  expect(await selected(page)).toEqual(['init']);await expect(page.locator('#pf-entry-continue')).toHaveCount(0);
  await page.goto('/'+href({step:'documents',prepare_document:'credit'})+'&prepare_document=legal');await expect(page.locator('#pf-generate')).toBeVisible();expect(await selected(page)).toEqual(['init']);await expect(page.locator('#pf-entry-continue')).toHaveCount(0);
  await page.locator('#pf-select-none').click();await open(page);expect(await selected(page)).toEqual([]);await expect(page.locator('#pf-generate')).toBeDisabled();
  expect(writes(s)).toEqual([]);assertFixture(s);
});

test('generation entry: cache adoption belongs to the owner and actual API project when a navigation project is shared',async({page})=>{
  const s=await fixture(page);await open(page);await choose(page,['init']);await page.locator('#pf-requirements').fill(note);
  const oldSelection=await raw(page,'selection'),oldNote=await raw(page,'note');
  await page.goto('/'+href({step:'documents',prepare_document:'credit'},ids.other,ids.navigation));
  await expect(checked(page,'credit')).toBeChecked();expect(await selected(page)).toEqual(['credit']);await expect(page.locator('#pf-requirements')).toHaveValue('');
  expect(await raw(page,'selection')).toBe(oldSelection);expect(await raw(page,'note')).toBe(oldNote);expect(await raw(page,'selection',ids.navigation)).toBeNull();
  s.owner='generation-entry-other-owner';await page.reload();await expect(page.locator('#pf-generate')).toBeVisible();await page.goto('/'+href({step:'documents',prepare_document:'legal'},ids.api,ids.navigation));
  await expect(checked(page,'legal')).toBeChecked();await expect(page.locator('#pf-requirements')).toHaveValue('');
  expect(await raw(page,'selection')).toBe(oldSelection);expect(await raw(page,'note')).toBe(oldNote);
  expect(JSON.parse((await raw(page,'selection',ids.api,s.owner))!).value).toEqual(['legal']);expect(writes(s)).toEqual([]);assertFixture(s);
});

for(const action of ['keep','transfer','clear'] as const)test(`generation entry: unsaved note has the explicit ${action} outcome`,async({page})=>{
  const s=await fixture(page),before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);
  await open(page);await choose(page,['init','underwriter']);await page.locator('#pf-requirements').fill(note);await entry(page,'credit');
  const card=page.getByRole('region',{name:'准备生成所选文种'});await expect(card).toContainText(note);
  await expect(card.getByRole('button')).toHaveCount(3);expect((await query(page)).prepare_document).toBe('credit');expect((await query(page)).prepare_wait).toBe('1');
  for(const anchor of await page.locator('.pf-workspace-actions a[href*="project="]').evaluateAll(nodes=>nodes.map(n=>(n as HTMLAnchorElement).getAttribute('href')!))){const q=new URLSearchParams(anchor.split('?')[1]);expect(q.get('prepare_document')).toBe('credit');expect(q.get('prepare_wait')).toBe('1');}
  expect(writes(s)).toEqual([]);await documents(page);expect(await selected(page)).toEqual(['init','underwriter']);
  await page.locator('#pf-entry-'+action).click();await expect(card.locator('#pf-entry-'+action)).toHaveCount(0);
  const expected=action==='keep'?['init','underwriter']:['credit'];
  expect(await selected(page)).toEqual(expected);await expect(page.locator('#pf-requirements')).toHaveValue(action==='clear'?'':note);
  expect(drafts(s)).toEqual([]);expect(batches(s)).toEqual([]);expect(s.workspaces.get(ids.api)!.workspace.drafts).toEqual(before);
  expect((await query(page)).prepare_document).toBeUndefined();expect((await query(page)).prepare_wait).toBeUndefined();
  await page.reload();await expect(page.locator('#pf-generate')).toBeVisible();expect(await selected(page)).toEqual(expected);await expect(page.locator('#pf-requirements')).toHaveValue(action==='clear'?'':note);
  if(action==='transfer'){
    await confirm(page);expect(drafts(s).map(c=>(c.body as {input:{document_type:string}}).input.document_type)).toEqual(['credit']);
    expect(s.workspaces.get(ids.api)!.workspace.drafts.credit.supplemental_requirements).toBe(before.credit.supplemental_requirements+'\n\n'+note);
    expect(s.workspaces.get(ids.api)!.workspace.drafts.init).toEqual(before.init);expect(s.workspaces.get(ids.api)!.workspace.drafts.underwriter).toEqual(before.underwriter);
  }
  assertFixture(s);
});

test('generation entry: an already identical single selection retains its unsaved note without a conflict card',async({page})=>{
  const s=await fixture(page);await open(page);await choose(page,['credit']);await page.locator('#pf-requirements').fill(note);await entry(page,'credit');
  await expect(page.locator('#pf-entry-transfer')).toHaveCount(0);await expect(page.locator('#pf-entry-clear')).toHaveCount(0);
  expect((await query(page)).prepare_document).toBeUndefined();await documents(page);expect(await selected(page)).toEqual(['credit']);await expect(page.locator('#pf-requirements')).toHaveValue(note);
  expect(drafts(s)).toEqual([]);expect(batches(s)).toEqual([]);assertFixture(s);
});

test('generation entry: failing to clear the local note never changes selection or consumes intent',async({page})=>{
  await installStorageControl(page);const s=await fixture(page);await open(page);await choose(page,['init']);await page.locator('#pf-requirements').fill(note);await entry(page,'credit');await documents(page);
  const selection=await raw(page,'selection'),savedNote=await raw(page,'note');await fault(page,{clearNote:true,trace:[]});await page.locator('#pf-entry-clear').click();
  await expect(page.locator('#pf-entry-intent')).toContainText(/清空|清除/);expect(await selected(page)).toEqual(['init']);await expect(page.locator('#pf-requirements')).toHaveValue(note);
  expect(await raw(page,'selection')).toBe(selection);expect(await raw(page,'note')).toBe(savedNote);expect(await trace(page)).toEqual(['remove:note']);
  expect((await query(page)).prepare_document).toBe('credit');await expect(page.locator('#pf-generate')).toBeDisabled();
  await fault(page,{clearNote:false});await page.locator('#pf-entry-clear').click();expect(await selected(page)).toEqual(['credit']);await expect(page.locator('#pf-requirements')).toHaveValue('');expect(drafts(s)).toEqual([]);assertFixture(s);
});

test('generation entry: note clear succeeds before a failed selection save, leaving a recoverable old selection and empty note',async({page})=>{
  await installStorageControl(page);const s=await fixture(page);await open(page);await choose(page,['init']);await page.locator('#pf-requirements').fill(note);await entry(page,'credit');await documents(page);
  const selection=await raw(page,'selection');await fault(page,{selection:true,trace:[]});await page.locator('#pf-entry-clear').click();
  await expect(page.locator('#pf-entry-intent')).toContainText(/清空|清除/);expect(await selected(page)).toEqual(['init']);await expect(page.locator('#pf-requirements')).toHaveValue('');
  expect(await raw(page,'selection')).toBe(selection);expect(await raw(page,'note')).toBeNull();expect(await trace(page)).toEqual(['remove:note','set:selection']);
  expect((await query(page)).prepare_document).toBe('credit');expect((await query(page)).prepare_wait).toBe('1');
  await page.reload();await expect(page.locator('#pf-entry-continue')).toBeVisible();expect(await selected(page)).toEqual(['init']);await expect(page.locator('#pf-requirements')).toHaveValue('');
  await page.locator('#pf-entry-continue').click();expect(await selected(page)).toEqual(['credit']);expect((await query(page)).prepare_document).toBeUndefined();expect(drafts(s)).toEqual([]);expect(batches(s)).toEqual([]);assertFixture(s);
});

test('generation entry: ordinary adoption saves first and a failed save retains intent through refresh and workspace navigation',async({page})=>{
  await installStorageControl(page);const s=await fixture(page);await open(page);await choose(page,['init']);const selection=await raw(page,'selection');
  await openFiles(page);await fault(page,{selection:true,trace:[]});await clickEntry(page,'credit');await expect(page.locator('#pf-entry-continue')).toBeVisible();
  expect(await raw(page,'selection')).toBe(selection);expect((await query(page)).prepare_document).toBe('credit');expect((await query(page)).prepare_wait).toBe('1');expect(writes(s)).toEqual([]);
  await page.getByRole('link',{name:/^生成记录/}).click();await page.getByRole('link',{name:'准备文件',exact:true}).click();await expect(page.locator('#pf-generate')).toBeDisabled();expect(await selected(page)).toEqual(['init']);
  await page.reload();await expect(page.locator('#pf-entry-continue')).toBeVisible();expect(await selected(page)).toEqual(['init']);expect(await raw(page,'selection')).toBe(selection);
  await page.locator('#pf-entry-continue').click();expect(await selected(page)).toEqual(['credit']);expect((await query(page)).prepare_document).toBeUndefined();expect((await query(page)).return_project).toBe(ids.api);expect(drafts(s)).toEqual([]);assertFixture(s);
});

for(const mode of ['corrupt','throw'] as const)test(`generation entry: ${mode} cache read preserves original state and blocks an empty replacement until reread`,async({page})=>{
  await installStorageControl(page);const s=await fixture(page);await open(page);await choose(page,['init']);const selection=await raw(page,'selection');
  await openFiles(page);if(mode==='corrupt')await page.evaluate(k=>sessionStorage.setItem(k,'{synthetic-broken'),key('selection'));else await fault(page,{read:true});
  await clickEntry(page,'credit');await expect(page.locator('#pf-entry-retry')).toBeVisible();await expect(page.locator('#pf-entry-intent')).toContainText('原记录保留');
  expect((await query(page)).prepare_document).toBe('credit');expect(writes(s)).toEqual([]);await expect(page.locator('#pf-source-next')).toHaveCount(0);await expect(page.locator('#pf-generate')).toHaveCount(0);
  if(mode==='throw')await fault(page,{read:false});else expect(await raw(page,'selection')).toBe('{synthetic-broken');
  if(mode==='corrupt')await page.evaluate(({k,v})=>sessionStorage.setItem(k,v!),{k:key('selection'),v:selection});
  await page.locator('#pf-entry-retry').click();if(await page.locator('#pf-entry-continue').isVisible())await page.locator('#pf-entry-continue').click();
  await documents(page);expect(await selected(page)).toEqual(['credit']);expect((await query(page)).prepare_document).toBeUndefined();expect(drafts(s)).toEqual([]);expect(batches(s)).toEqual([]);assertFixture(s);
});

for(const action of ['checkbox','all','none'] as const)test(`generation entry: a manual ${action} choice cancels waiting intent and survives refresh`,async({page})=>{
  const s=await fixture(page);await open(page);await choose(page,['init']);await page.locator('#pf-requirements').fill(note);await entry(page,'credit');await documents(page);
  if(action==='checkbox')await checked(page,'legal').check();else await page.locator(action==='all'?'#pf-select-all':'#pf-select-none').click();
  const choice=await selected(page);expect(choice).toEqual(action==='checkbox'?['init','legal']:action==='all'?PROJECT_DOCUMENT_CATALOG.map(d=>d.id):[]);
  expect((await query(page)).prepare_document).toBeUndefined();expect((await query(page)).prepare_wait).toBeUndefined();
  await page.reload();await expect(page.locator('#pf-generate')).toBeVisible();expect(await selected(page)).toEqual(choice);await expect(page.locator('#pf-requirements')).toHaveValue(note);expect(drafts(s)).toEqual([]);assertFixture(s);
});

test('generation entry: pending recovery retains the exact original envelope through generic conflict, acceptance, polling and refresh',async({page})=>{
  const s=await fixture(page);s.batchFailure='network';await open(page);await choose(page,['init','underwriter']);await confirm(page);await page.locator('#pf-confirm-generation').click();await expect(page.locator('#pf-retry-batch')).toBeVisible();
  const original=structuredClone(batches(s)[0].body) as FileGenerationBatchRequest;await entry(page,'credit');await expect(page.locator('#pf-retry-batch')).toBeVisible();
  expect((await query(page)).prepare_document).toBe('credit');expect((await query(page)).prepare_wait).toBe('1');await expect(page.locator('#pf-entry-continue')).toHaveCount(0);
  const w=s.workspaces.get(ids.api)!;w.source={...w.source!,version_id:'source-v4',selection_revision:8,sequence:4};for(const d of Object.values(w.workspace.drafts)){d.version=9;d.project_file={project_id:ids.api,source_version_id:'source-v4',source_selection_revision:8};}
  s.batchFailure={status:409,code:'INPUT_REVISION_CONFLICT'};await page.locator('#pf-retry-batch').click();await expect(page.locator('#pf-retry-batch')).toBeEnabled();expect(batches(s).map(c=>c.body)).toEqual([original,original]);await expect(page.locator('#pf-reprepare')).toHaveCount(0);
  await page.reload();await expect(page.locator('#pf-retry-batch')).toBeVisible();expect(batches(s)).toHaveLength(2);s.batchState='running';await page.locator('#pf-retry-batch').click();await expect(page.getByRole('heading',{name:'文件生成任务',exact:true})).toBeVisible();
  expect(batches(s).map(c=>c.body)).toEqual([original,original,original]);expect(drafts(s)).toEqual([]);await expect(page.locator('#pf-entry-continue')).toBeVisible();
  const reads=s.calls.filter(c=>c.method==='GET'&&c.path.endsWith('/workspace')).length;await expect.poll(()=>s.calls.filter(c=>c.method==='GET'&&c.path.endsWith('/workspace')).length,{timeout:7000}).toBeGreaterThan(reads);
  expect((await query(page)).prepare_document).toBe('credit');expect((await query(page)).prepare_wait).toBe('1');expect(batches(s)).toHaveLength(3);
  await page.reload();await expect(page.getByRole('heading',{name:'文件生成任务',exact:true})).toBeVisible();await expect(page.locator('#pf-entry-continue')).toBeVisible();
  expect(JSON.parse((await raw(page,'selection'))!).value).toEqual(['init','underwriter']);await page.locator('#pf-entry-continue').click();await documents(page);expect(await selected(page)).toEqual(['credit']);expect(batches(s)).toHaveLength(3);assertFixture(s);
});

test('generation entry: only a trusted expired-input receipt unlocks explicit reprepare without silently adopting the new type',async({page})=>{
  const s=await fixture(page);s.batchFailure='network';await open(page);await choose(page,['init']);await confirm(page);await page.locator('#pf-confirm-generation').click();await expect(page.locator('#pf-retry-batch')).toBeVisible();
  const original=structuredClone(batches(s)[0].body);await entry(page,'credit');await expect(page.locator('#pf-retry-batch')).toBeVisible();s.batchFailure={status:409,code:'PROJECT_FILE_BATCH_INPUT_EXPIRED'};
  await page.locator('#pf-retry-batch').click();await expect(page.locator('#pf-reprepare')).toBeVisible();expect(batches(s).map(c=>c.body)).toEqual([original,original]);
  const count=writes(s).length;await page.locator('#pf-reprepare').click();await expect(page.locator('#pf-generate')).toBeVisible();expect(await selected(page)).toEqual(['init']);expect(writes(s)).toHaveLength(count);expect((await query(page)).prepare_document).toBe('credit');await expect(page.locator('#pf-entry-continue')).toBeVisible();
  await page.locator('#pf-entry-continue').click();expect(await selected(page)).toEqual(['credit']);expect(batches(s)).toHaveLength(2);assertFixture(s);
});

test('generation entry: a live results poll cannot repaint through an unknown cache after explicit preparation fails',async({page})=>{
  await installStorageControl(page);const s=await fixture(page),original={batch_id:'existing-running-batch',state:'running' as const,items:[{document_type:'init' as const,run_id:null,state:'queued' as const,error:null}]};
  s.workspaces.get(ids.api)!.batches=[structuredClone(original)];await page.goto('/'+href({step:'results',prepare_document:'credit',prepare_wait:'1'}));
  await expect(page.locator('.pf-batch')).toContainText('正在生成');await expect(page.locator('#pf-entry-continue')).toBeVisible();
  await fault(page,{read:true});await page.locator('#pf-entry-continue').click();await expect(page.locator('#pf-entry-retry')).toBeVisible();await expect(page.locator('.pf-batch')).toHaveCount(0);
  const reads=s.calls.filter(c=>c.method==='GET'&&c.path.endsWith('/workspace')).length;
  // Cross the production 3-second results timer after the dynamic read failure.
  await page.waitForTimeout(3400);await expect(page.locator('#pf-entry-retry')).toBeVisible();await expect(page.locator('.pf-batch')).toHaveCount(0);
  await expect(page.locator('#pf-entry-continue')).toHaveCount(0);await expect(page.locator('#pf-generate')).toHaveCount(0);await expect(page.locator('#pf-source-next')).toHaveCount(0);
  expect(s.calls.filter(c=>c.method==='GET'&&c.path.endsWith('/workspace'))).toHaveLength(reads);expect((await query(page)).prepare_document).toBe('credit');expect((await query(page)).prepare_wait).toBe('1');expect(s.workspaces.get(ids.api)!.batches).toEqual([original]);expect(writes(s)).toEqual([]);
  await fault(page,{read:false});await page.locator('#pf-entry-retry').click();await expect(page.locator('.pf-batch')).toContainText('正在生成');await expect(page.locator('#pf-entry-continue')).toBeVisible();expect(writes(s)).toEqual([]);assertFixture(s);
});

for(const outcome of ['continue','stop'] as const)test(`generation entry: a partial note operation keeps its original scope when explicitly ${outcome==='continue'?'continued':'stopped'}`,async({page})=>{
  const s=await fixture(page),before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);s.failDraft='underwriter';
  await open(page);await choose(page,['init','underwriter']);await page.locator('#pf-requirements').fill(note);await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeVisible();
  const operation=await raw(page,'note-operation');await entry(page,'credit');await expect(page.locator('#pf-entry-intent')).toContainText('原');expect(await raw(page,'note-operation')).toBe(operation);await documents(page);
  expect(await selected(page)).toEqual(['init','underwriter']);await expect(page.locator('#pf-entry-transfer')).toHaveCount(0);await expect(page.locator('#pf-entry-continue')).toHaveCount(0);
  if(outcome==='continue')await page.locator('#pf-save-requirements').click();else await page.locator('#pf-stop-note').click();await expect(page.locator('#pf-stop-note')).toBeHidden();await expect(page.locator('#pf-entry-continue')).toBeVisible();
  const expected=outcome==='continue'?['init','underwriter','underwriter']:['init','underwriter'];expect(drafts(s).map(c=>(c.body as {input:{document_type:string}}).input.document_type)).toEqual(expected);
  expect(s.workspaces.get(ids.api)!.workspace.drafts.credit).toEqual(before.credit);expect(s.workspaces.get(ids.api)!.workspace.drafts.init.supplemental_requirements).toBe(before.init.supplemental_requirements+'\n\n'+note);
  await page.reload();await expect(page.locator('#pf-entry-continue')).toBeVisible();expect(await selected(page)).toEqual(['init','underwriter']);await page.locator('#pf-entry-continue').click();expect(await selected(page)).toEqual(['credit']);expect(batches(s)).toEqual([]);assertFixture(s);
});

for(const kind of ['support','template'] as const)for(const outcome of ['continue','stop'] as const)test(`generation entry: original ${kind} upload recovery can ${outcome} without redirecting its scope to the newly clicked type`,async({page})=>{
  const s=await fixture(page),before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);await open(page);await choose(page,kind==='support'?['init','underwriter']:['init']);
  if(kind==='support'){s.dropDraft='init';await page.locator('#pf-support').setInputFiles(file);}else{s.dropTemplate=true;await page.locator('[data-pf-template="init"]').click();await page.locator('dialog input[name="broker"]').fill('原模板券商');await page.locator('dialog input[type="file"]').setInputFiles(file);await page.locator('dialog form button').click();}
  const recovery=page.locator(`#pf-${kind}-recovery [data-generation-resume]`);await expect(recovery).toBeVisible();const originalTemplate=kind==='template'?structuredClone(templateWrites(s)[0].body):undefined;
  const count=writes(s).length;await page.reload();await expect(recovery).toBeVisible();expect(writes(s)).toHaveLength(count);
  await entry(page,'credit');await expect(page.locator('#pf-entry-intent')).toContainText('原');await documents(page);await expect(recovery).toBeVisible();
  await expect(page.locator('#pf-entry-continue')).toHaveCount(0);if(outcome==='continue')await recovery.click();else await page.locator(`#pf-${kind}-recovery [data-generation-forget]`).click();await expect(recovery).toHaveCount(0);await expect(page.locator('#pf-entry-continue')).toBeVisible();
  expect(s.puts).toBe(1);expect(s.sessions.size).toBe(1);expect(s.workspaces.get(ids.api)!.workspace.drafts.credit).toEqual(before.credit);
  if(kind==='support'){expect(s.workspaces.get(ids.api)!.workspace.drafts.init.materials).toHaveLength(1);expect(s.workspaces.get(ids.api)!.workspace.drafts.underwriter.materials).toHaveLength(outcome==='continue'?1:0);expect(drafts(s).map(c=>(c.body as {input:{document_type:string}}).input.document_type)).toEqual(outcome==='continue'?['init','underwriter']:['init']);}
  else {expect(templateWrites(s).map(c=>c.body)).toEqual(outcome==='continue'?[originalTemplate,originalTemplate]:[originalTemplate]);expect(s.templates.size).toBe(1);expect(s.workspaces.get(ids.api)!.workspace.drafts.init.fields.broker).toBe(outcome==='continue'?'原模板券商':before.init.fields.broker);expect(drafts(s).map(c=>(c.body as {input:{document_type:string}}).input.document_type)).toEqual(outcome==='continue'?['init']:[]);}
  await page.reload();await expect(page.locator('#pf-entry-continue')).toBeVisible();expect((await query(page)).prepare_wait).toBe('1');await page.locator('#pf-entry-continue').click();expect(await selected(page)).toEqual(['credit']);expect(batches(s)).toEqual([]);assertFixture(s);
});

for(const width of [1440,390])test(`generation entry component comparison at ${width}px uses the same ordinary and note-conflict selections`,async({page})=>{
  await page.setViewportSize({width,height:900});const reference=process.env.BB_GENERATION_ENTRY_REFERENCE==='1',verify=reference?await installGenerationEntryReference(page):undefined,s=await fixture(page);
  await open(page);await choose(page,['init','underwriter']);await entry(page,'credit');await documents(page);
  const ordinary=reference?['init','underwriter']:['credit'];expect(await selected(page)).toEqual(ordinary);
  const directory=process.env.BB_GENERATION_ENTRY_EVIDENCE_DIR??test.info().outputPath('component-capture');await mkdir(directory,{recursive:true});
  const capture=async(name:string)=>{await page.evaluate(()=>scrollTo(0,0));const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText}));expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width+1);await page.screenshot({path:join(directory!,`generation-entry-${name}-${width}.png`),fullPage:true});await writeFile(join(directory!,`generation-entry-${name}-${width}.json`),JSON.stringify({...layout,reference,selection:await selected(page),query:await query(page)},null,2));};
  await capture('ordinary');await choose(page,['init','underwriter']);if(!await page.locator('#pf-requirements').isVisible())await page.locator('#pf-requirements-details > summary').click();await page.locator('#pf-requirements').fill(note);await entry(page,'credit');await documents(page);expect(await selected(page)).toEqual(['init','underwriter']);
  if(reference)await expect(page.locator('#pf-entry-intent')).toHaveCount(0);else {await expect(page.locator('#pf-entry-transfer')).toBeVisible();await expect(page.locator('#pf-entry-intent')).toContainText(note);}
  await capture('note-conflict');expect(drafts(s)).toEqual([]);expect(batches(s)).toEqual([]);assertFixture(s);if(verify)await writeFile(join(directory!,`generation-entry-reference-${width}.json`),JSON.stringify(await verify(),null,2));
});
