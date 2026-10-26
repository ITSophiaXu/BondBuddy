import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {M4_DOCUMENT_TYPES} from '@bondbuddy/contracts';
import {fixture,open,chooseLegal,openTask,delivery,prepare,comparison,detail,row,side,selected,cache,seedCache,localDrafts,assertLocalDrafts,
  expand,returnToInit,snapshot,assertUnchanged,noExecution,draftWrites,viewWrites,verifyInstalled,
  frames,poll,refreshBehindSelection,taskRun,ids,hash,inputOf,artifactPin,requirement,writeCalls,type State} from './material-task-draft-fixtures';
import {captureMaterialTaskDraft,installMaterialTaskDraftReference} from './material-task-draft-reference';

// Actual main.ts desktop routes and native controls with closed synthetic HTTP.
// No model, real ledger, Word/WPS, external storage or business acceptance claim.
const reference=process.env.BB_MATERIAL_TASK_DRAFT_REFERENCE==='1';
const inputTab=(page:Page)=>page.locator('#m4-tabs [data-m4-action="tab"][data-key="input"]');
const same=(page:Page)=>page.locator('details[data-m4-detail="task-draft-same"]');
const references=(page:Page)=>comparison(page).locator('details[data-m4-detail^="task-draft-ref-"]');
async function setup(page:Page,s=fixture()){await open(page,s);await chooseLegal(page);await openTask(page);return s;}
async function expectInitForm(page:Page,s:State,requirements=s.workspace.drafts.init.supplemental_requirements??''){
  await expect(selected(page)).toHaveValue('init');await expect(inputTab(page)).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#m4-requirements')).toHaveValue(requirements);await expect(page.locator('[data-m4-action="execute"]')).toHaveText('生成立项报告');
  await expect(page.locator('.m4-source-name')).toContainText('同名募集说明书.docx');
  await expect(page.locator('.m4-accepted')).toContainText(s.currentBase.filename);
}
async function preservedDiscussion(page:Page,before:any){
  const after=await cache(page);expect(after.view.unsent_content).toBe(before.view.unsent_content);expect(after.view.unsent_context).toEqual(before.view.unsent_context);expect(after.view.quotation).toEqual(before.view.quotation);
  expect(after.pendingMessage).toEqual(before.pendingMessage);expect(after.pendingExecution).toEqual(before.pendingExecution);
}
async function settleViewSave(page:Page,s:State){
  const count=viewWrites(s).length;
  const pending=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/v1/m4/topics/'+ids.topic+'/view');
  await page.clock.runFor(700);const response=await pending;expect(response.ok()).toBe(true);expect(await response.finished()).toBeNull();
  expect(viewWrites(s).length).toBeGreaterThan(count);
  await expect.poll(async()=>{const saved=await cache(page);return{dirty:saved?.viewDirty,version:saved?.viewVersion};}).toEqual({dirty:false,version:s.workspace.view.version});
}

test.afterEach(async({page})=>verifyInstalled(page));

test.describe('material task draft desktop journeys',()=>{
  test.skip(reference,'Reference mode collects only the exact historical component comparison.');

  test('material task draft: legal input to the native latest failed init task returns to the complete current init draft without restoring its old manifest',async({page})=>{
    const s=await setup(page),before=snapshot(s),discussion=await cache(page),drafts=await localDrafts(page);
    await expect(delivery(page).locator('h2')).toHaveText('立项报告');await expect(prepare(page)).toHaveText('返回立项报告材料与要求');
    await expect(prepare(page)).toHaveAttribute('data-run',taskRun);await expect(prepare(page)).toHaveAttribute('data-task-return',/\S+/);await expand(page);
    await expect(side(page,'supplemental_requirements','submitted')).toContainText('历史任务冻结补充要求。');
    await expect(side(page,'supplemental_requirements','current')).toContainText(s.workspace.drafts.init.supplemental_requirements!);
    await returnToInit(page);await expectInitForm(page,s);await settleViewSave(page,s);await preservedDiscussion(page,discussion);await assertLocalDrafts(page,drafts);
    expect(Object.keys(s.workspace.drafts).sort()).toEqual([...M4_DOCUMENT_TYPES].sort());await assertUnchanged(page,s,before);
  });

  test('material task draft: pending requirements and original unknown discussion/execution envelopes survive a read-only return without implicit adoption',async({page})=>{
    const s=fixture();s.workspace.view.selected_document_type='legal';s.workspace.pending_requirements=[requirement('material-task-pending','合成尚未采用要求；返回材料不得自动采用。')];
    const seeded=await seedCache(page,s,{pending:true});await open(page,s);await expect(selected(page)).toHaveValue('legal');await openTask(page);
    const before=snapshot(s),drafts=await localDrafts(page);expect(drafts).toEqual(seeded.drafts);await expand(page);await returnToInit(page);await expectInitForm(page,s);await settleViewSave(page,s);
    await expect.poll(async()=>({message:(await cache(page)).pendingMessage,execution:(await cache(page)).pendingExecution})).toEqual({message:seeded.pendingMessage,execution:seeded.pendingExecution});
    expect(s.workspace.pending_requirements).toEqual(before.pending_requirements);await preservedDiscussion(page,{...seeded,view:seeded.view});await assertLocalDrafts(page,drafts);await assertUnchanged(page,s,before);
  });

  test('material task draft: a recovered dirty init draft is compared and returned intact while legal remains a separate complete draft',async({page})=>{
    const s=fixture();s.workspace.view.selected_document_type='legal';const seeded=await seedCache(page,s,{dirtyInit:true});await open(page,s);await openTask(page);const before=snapshot(s),drafts=await localDrafts(page);expect(drafts).toEqual(seeded.drafts);
    await expand(page);await expect(side(page,'supplemental_requirements','current')).toContainText(seeded.drafts.init.input.supplemental_requirements!);
    await returnToInit(page);await expectInitForm(page,s,seeded.drafts.init.input.supplemental_requirements);
    // The paused clock keeps this observation before the normal autosave delay;
    // the clean/pending journeys separately cross that delay and await view PUT.
    await assertLocalDrafts(page,drafts);await assertUnchanged(page,s,before);
  });

  for(const state of ['cancelled','rejected'] as const)test(`material task draft: a ${state} init task without an output returns from legal to current init without creating work`,async({page})=>{
    const s=await setup(page,fixture(state)),before=snapshot(s);await returnToInit(page);await expectInitForm(page,s);await assertUnchanged(page,s,before);
  });

  for(const state of ['running','paused'] as const)test(`material task draft: the ${state} task returns to its own current input while keeping the original project active guard`,async({page})=>{
    const s=await setup(page,fixture(state)),before=snapshot(s);await returnToInit(page);await expect(selected(page)).toHaveValue('init');
    await expect(page.locator('#m4-requirements')).toHaveValue(s.workspace.drafts.init.supplemental_requirements!);await expect(page.locator('[data-m4-action="execute"]')).toBeDisabled();
    expect(s.workspace.active_run?.run_id).toBe(taskRun);await assertUnchanged(page,s,before);
  });

  test('material task draft: exact deep-link and reload display the historical task but retain the current twelve draft inputs',async({page})=>{
    const s=fixture(),before=snapshot(s);await open(page,s,taskRun);await expect(delivery(page)).toBeVisible();await expand(page);
    await expect(side(page,'source_material','current')).toContainText(s.currentSource.sha256);await expect(side(page,'source_material','submitted')).toContainText(s.oldSource.sha256);
    await returnToInit(page);await expectInitForm(page,s);await frames(page);await page.reload();await expect(delivery(page)).toBeVisible();await returnToInit(page);await expectInitForm(page,s);await assertUnchanged(page,s,before);
  });

  test('material task draft: identical filenames with changed material versions and artifact hashes stay visibly different through complete exact references',async({page})=>{
    const s=await setup(page),before=snapshot(s);await expand(page);
    for(const key of ['source_material','materials','edit_base','requirements','supplemental_requirements','template','project_file'])await expect(comparison(page).locator('[data-task-draft-changed] [data-task-draft-row="'+key+'"]').first()).toHaveCount(1);
    for(const [key,oldPin,currentPin]of [['source_material',s.oldSource,s.currentSource],['edit_base',artifactPin(s.artifact),artifactPin(s.currentBase)]] as const){
      await expect(side(page,key,'submitted')).toContainText(oldPin.sha256);await expect(side(page,key,'current')).toContainText(currentPin.sha256);
      await expect(side(page,key,'submitted')).toContainText(oldPin.source_project_id);await expect(side(page,key,'current')).toContainText(currentPin.source_project_id);
    }
    await expect(side(page,'source_material','submitted')).toContainText('同名募集说明书.docx');await expect(side(page,'source_material','current')).toContainText('同名募集说明书.docx');
    await expect(same(page)).toBeVisible();await same(page).locator(':scope > summary').click();await expect(same(page)).toHaveAttribute('open','');
    await expect(row(page,'scope')).toBeVisible();await expect(row(page,'fields.market')).toBeVisible();await assertUnchanged(page,s,before);
  });

  test('material task draft: equal requirement text with different message provenance remains a changed current input rather than an unchanged requirement',async({page})=>{
    const s=fixture();if(s.task.manifest.kind!=='document')throw new Error('Synthetic document task required');
    s.task.manifest.input.requirements=s.workspace.drafts.init.requirements.map((req,index)=>({...structuredClone(req),requirement_id:'material-task-different-requirement-'+index,message_id:'material-task-different-message-'+index,message_version:req.message_version+5}));
    expect(s.task.manifest.input.requirements.map(req=>req.text)).toEqual(s.workspace.drafts.init.requirements.map(req=>req.text));
    await setup(page,s);const before=snapshot(s);await expand(page);await expect(comparison(page).locator('[data-task-draft-changed] [data-task-draft-row="requirements"]')).toHaveCount(1);
    await expect(row(page,'requirements')).toHaveAttribute('data-comparison-change','reference');await expect(side(page,'requirements','submitted')).toContainText('material-task-different-message-0');await expect(side(page,'requirements','current')).toContainText(s.workspace.drafts.init.requirements[0].message_id);await assertUnchanged(page,s,before);
  });

  test('material task draft: selected historical text can keep a stale return control visible but a changed manifest cannot redirect it to another current draft',async({page})=>{
    const s=await setup(page),button=await prepare(page).elementHandle();if(s.task.manifest.kind!=='document')throw new Error('Synthetic document task required');
    s.task.manifest.input.document_type='legal';s.task.manifest.billing_task='m4_G03';s.task.run.state='cancelled';
    s.projectionFaults.push('R42 defensive changed immutable manifest behind a selected-text refresh; not normal producer output');const before=snapshot(s);
    await refreshBehindSelection(page,s);await expect(page.locator('[data-m4-action="tab"][data-key="run:'+taskRun+'"]')).toHaveText('已停止');
    expect(await button!.evaluate(e=>e.isConnected)).toBe(true);await prepare(page).click();
    await expect(page.locator('#m4-content')).toHaveAttribute('data-tab','run:'+taskRun);await expect(page.locator('#m4-status')).toContainText(/变化|重新|核对/);await assertUnchanged(page,s,before);
  });

  test('material task draft: duplicate task IDs do not choose a manifest or return target by array order',async({page})=>{
    const s=fixture(),duplicate=structuredClone(s.task);if(duplicate.manifest.kind!=='document')throw new Error('Synthetic document task required');
    duplicate.manifest.input.document_type='legal';duplicate.manifest.billing_task='m4_G03';s.workspace.tasks.push(duplicate);s.projectionFaults.push('R42 defensive duplicate run identity; not normal producer output');
    await setup(page,s);const before=snapshot(s);await expect(prepare(page)).toHaveCount(0);await expect(delivery(page)).toContainText('当前任务引用暂不可核实');
    await expect(page.locator('#m4-content')).toHaveAttribute('data-tab','run:'+taskRun);await assertUnchanged(page,s,before);
  });

  test('material task draft: a task run from another execution project has no enabled current-draft return',async({page})=>{
    const s=fixture();s.task.run.project_id=ids.otherRoot;s.projectionFaults.push('R42 defensive foreign execution-project run; not normal owner-scoped producer output');
    await setup(page,s);const before=snapshot(s);await expect(prepare(page)).toHaveCount(0);await expect(delivery(page)).toContainText('当前任务引用暂不可核实');await expect(page.locator('#m4-content')).toHaveAttribute('data-tab','run:'+taskRun);await assertUnchanged(page,s,before);
  });

  test('material task draft: scheduled native polling preserves comparison, unchanged/ref disclosures, keyboard focus and actual desktop reading position',async({page})=>{
    const s=await setup(page,fixture('paused')),before=snapshot(s);await expand(page);await same(page).locator(':scope > summary').click();
    const reference=references(page).first();await reference.locator(':scope > summary').click();const summary=detail(page).locator(':scope > summary');await summary.focus();await summary.evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));await frames(page);
    const at=await summary.evaluate(e=>e.getBoundingClientRect().top);await poll(page,s);await expect(detail(page)).toHaveAttribute('open','');await expect(same(page)).toHaveAttribute('open','');await expect(reference).toHaveAttribute('open','');await expect(summary).toBeFocused();
    expect(Math.abs(await summary.evaluate(e=>e.getBoundingClientRect().top)-at)).toBeLessThanOrEqual(2);await assertUnchanged(page,s,before);
  });

  test('material task draft: a polled same-name new source pin does not inherit the old reference disclosure or its keyboard focus',async({page})=>{
    const s=await setup(page,fixture('paused'));await expand(page);
    const oldRef=side(page,'source_material','current').locator('details[data-m4-detail^="task-draft-ref-"]').first();await oldRef.locator(':scope > summary').click();await oldRef.locator(':scope > summary').focus();
    const next={...s.currentSource,material_version:s.currentSource.material_version+1,sha256:hash('Synthetic newer same-name source pin')};
    s.workspace.drafts.init={...s.workspace.drafts.init,version:s.workspace.drafts.init.version+1,source_material:next};
    s.workspace.materials.push(next);s.workspace.material_details.push({...next,filename:'同名募集说明书.docx',state:'persisted',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
    const before=snapshot(s);await poll(page,s);await expect(delivery(page).locator('h2')).toBeFocused();await expand(page);
    const newRef=side(page,'source_material','current').locator('details[data-m4-detail^="task-draft-ref-"]').first();await expect(newRef).not.toHaveAttribute('open','');await expect(newRef.locator(':scope > summary')).not.toBeFocused();
    await expect(side(page,'source_material','current')).toContainText(next.sha256);await assertUnchanged(page,s,before);
  });

  test('material task draft: artifact continuation still changes only the target edit base and retains every current input and the unrelated legal draft',async({page})=>{
    const s=fixture();s.workspace.drafts.init.edit_base=null;await open(page,s);await chooseLegal(page);const before=snapshot(s);
    await page.locator('[data-m4-action="artifact"][data-artifact="'+s.artifact.artifact_id+':'+s.artifact.artifact_version+'"]').click();
    await page.locator('[data-m4-action="continue"]').click();await expect(selected(page)).toHaveValue('init');await expect(page.locator('#m4-requirements')).toHaveValue(before.drafts.init.supplemental_requirements!);
    await page.clock.runFor(800);await expect.poll(()=>draftWrites(s).length).toBe(1);
    expect(draftWrites(s)[0].body).toEqual({expected_version:before.drafts.init.version,input:{...inputOf(before.drafts.init),edit_base:artifactPin(s.artifact),scope:'whole'}});
    for(const type of M4_DOCUMENT_TYPES)if(type!=='init')expect(s.workspace.drafts[type]).toEqual(before.drafts[type]);
    expect(s.workspace.tasks.map(t=>({id:t.run.run_id,manifest:t.manifest}))).toEqual(before.manifests);noExecution(s);
  });

  test('material task draft: read-only comparison retains complete long requirement DOM text without page horizontal overflow at desktop widths',async({page})=>{
    const s=fixture();s.workspace.drafts.init.supplemental_requirements+='\n'+'合成完整长行'.repeat(150);await setup(page,s);const before=snapshot(s);await expand(page);
    await expect(comparison(page).locator('button,input,textarea,select')).toHaveCount(0);await expect(side(page,'supplemental_requirements','current')).toContainText('合成完整长行'.repeat(150));
    for(const width of [1440,1024]){await page.setViewportSize({width,height:960});await frames(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);}
    await assertUnchanged(page,s,before);
  });
});

test('material task draft component comparison: exact R41 and current use the same native legal-to-historical-init journey and preserve all draft inputs at 1440',async({page})=>{
  const verify=reference?await installMaterialTaskDraftReference(page):undefined,s=await setup(page),before=snapshot(s),drafts=await localDrafts(page),kind=reference?'reference':'current';
  const output=process.env.BB_MATERIAL_TASK_DRAFT_EVIDENCE??test.info().outputPath(kind);
  const audit=(action:string)=>({synthetic:true,reference,action,task:taskRun,selected_before_history:'legal',submitted_type:'init',
    source_project:ids.root,execution_project:ids.execution,topic:ids.topic,projection_faults:s.projectionFaults,http:s.calls,
    business_writes:writeCalls(s).filter(c=>!c.path.endsWith('/view')),drafts_sha256:hash(JSON.stringify(s.workspace.drafts)),local_twelve_drafts_sha256:hash(JSON.stringify(drafts)),
    limits:'Exact R41 component in the current surrounding app. Closed synthetic HTTP and immutable synthetic manifest only; no real worker, ledger, Word/WPS or overall UX acceptance.'});
  await delivery(page).evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));await frames(page);
  await captureMaterialTaskDraft(page,output,'material-task-draft-'+kind+'-task-initial-1440',audit('Both implementations selected legal through its native radio and opened the same latest failed init task without an artifact.'));
  if(reference){const fixed=page.locator('#m4-content details[data-m4-detail="input"]');await fixed.locator(':scope > summary').click();await expect(fixed).toHaveAttribute('open','');await fixed.locator(':scope > summary').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));}
  else{await expand(page);await detail(page).evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));}
  await captureMaterialTaskDraft(page,output,'material-task-draft-'+kind+'-comparison-expanded-1440',audit(reference?'R41 natively expands its existing fixed submitted-input disclosure. This is a different available action from the current submitted/current comparison; R41 has no comparison.':'Current explicitly expands its read-only submitted/current input comparison; current init draft differs from the immutable historical manifest.'));
  await prepare(page).click();await expect(selected(page)).toHaveValue(reference?'legal':'init');await expect(inputTab(page)).toHaveAttribute('aria-selected','true');
  await selected(page).evaluate(e=>e.closest('label')!.scrollIntoView({block:'center',behavior:'instant'}));await frames(page);
  await captureMaterialTaskDraft(page,output,'material-task-draft-'+kind+'-returned-draft-1440',audit(reference?'R41 returns to the previously selected legal draft; all twelve actual inputs still remain unchanged.':'Current returns to the historical task’s exact init type and its current complete draft, without restoring the old manifest or editing legal.'));
  await assertLocalDrafts(page,drafts);await assertUnchanged(page,s,before);expect(viewWrites(s).every(c=>c.method==='PUT')).toBe(true);
  if(verify){await mkdir(output,{recursive:true});await writeFile(join(output,'material-task-draft-reference-provenance.json'),JSON.stringify(await verify(),null,2)+'\n');}
});
