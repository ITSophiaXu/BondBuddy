import {expect,test,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {artifactId,assertFixture,downloadBytes,failedRunId,fixture,gate,ids,oldSnapshot,open,prepare,selectedPin,writes,type State} from './authoring-next-layout-fixtures';
import {captureAuthoringNext,installAuthoringNextReference} from './authoring-next-layout-reference';

test.afterEach(async({page})=>assertFixture(page));
const previous=(page:Page)=>page.locator('#previous-execution');
const previousSummary=(page:Page)=>page.locator('#previous-execution-summary');
const guide=(page:Page)=>page.locator('[data-authoring-preparation-guide]');
const nextSummary=(page:Page)=>page.locator('[data-next-authoring-summary]');
async function historicalDownload(page:Page,state:State,variant:'clean'|'revision'){
 const event=page.waitForEvent('download');await page.locator('#execution-delivery').getByRole('button',{name:variant==='clean'?'下载清洁版':'下载修订版',exact:true}).click();const file=await event,saved=state.artifacts.get(artifactId(2,variant))!;
 expect(file.suggestedFilename()).toBe(saved.metadata.filename);expect(await downloadBytes(file)).toEqual(saved.bytes);expect(state.byteReads.at(-1)).toBe(saved.metadata.artifact_id);expect(saved.metadata.run_id).toBe(ids.oldRun);expect(saved.metadata.version).toBe(7);
}
async function assertNoStart(state:State){expect(state.inputAttempts).toEqual([]);expect(state.preflights).toEqual([]);expect(state.quotes).toEqual([]);expect(state.executions).toEqual([]);}
async function trackResultNavigation(page:Page){await page.evaluate(()=>{const scroll=Element.prototype.scrollIntoView,focus=HTMLElement.prototype.focus,events:{kind:string;id:string}[]=[];Object.assign(window,{authoringResultNavigation:events});Element.prototype.scrollIntoView=function(options?:boolean|ScrollIntoViewOptions){if(['artifact-downloads','run-panel'].includes(this.id))events.push({kind:'scroll',id:this.id});return scroll.call(this,options);};HTMLElement.prototype.focus=function(options?:FocusOptions){if(['artifact-downloads','run-panel'].includes(this.id))events.push({kind:'focus',id:this.id});return focus.call(this,options);};});}
const resultNavigation=(page:Page)=>page.evaluate(()=>(window as unknown as {authoringResultNavigation:{kind:string;id:string}[]}).authoringResultNavigation);

// Six desktop user paths. Existing continuation tests own the wider CAS, credit,
// owner and receipt matrix; these assertions target the changed layout boundary.
test('authoring next layout: historical prepare brings materials forward and keyboard-opened previous Word stays exactly V2',async({page})=>{
 const state=await open(page),before=oldSnapshot(state);await expect(page.locator('#artifact-downloads')).toBeVisible();await expect(page.locator('#execution-delivery .authoring-summary')).toContainText('合成待核事项 10');await prepare(page);
 await expect(guide(page)).toBeFocused();await expect(guide(page)).toHaveAttribute('tabindex','-1');await expect(previousSummary(page)).toBeVisible();await expect(previous(page)).toHaveJSProperty('open',false);await expect(page.locator('#artifact-downloads')).toBeHidden();
 await expect(page.locator('[data-next-basis-choice]')).toHaveValue('result');await expect(nextSummary(page)).toContainText('合成第2轮清洁版.docx');await expect(nextSummary(page)).not.toContainText('合成第3轮清洁版.docx');await expect(nextSummary(page)).toContainText('2024');await expect(nextSummary(page)).toContainText('2025');await expect(nextSummary(page)).toContainText('合成审计报告.pdf');await expect(page.locator('#materials-title')).toBeInViewport();
 await previousSummary(page).focus();await page.keyboard.press('Enter');await expect(previous(page)).toHaveJSProperty('open',true);await expect(page.locator('#artifact-downloads')).toBeVisible();
 await expect(page.locator('[data-artifact-result-context]')).toContainText('第 2 版');await historicalDownload(page,state,'clean');await historicalDownload(page,state,'revision');
 await previousSummary(page).focus();await page.keyboard.press('Space');await expect(previous(page)).toHaveJSProperty('open',false);await expect(previousSummary(page)).toBeFocused();
 expect(state.versions.current_version_id).toBe('result-handoff-version-3');expect(oldSnapshot(state)).toEqual(before);expect(writes(state)).toEqual([]);await assertNoStart(state);
});

test('authoring next layout: user expansion survives delayed artifact render, basis refresh and material synchronization',async({page})=>{
 const state=fixture(),metadataGate=gate();state.metadataGate={id:artifactId(2,'revision'),gate:metadataGate};await open(page,state);await expect.poll(()=>metadataGate.entered).toBe(true);await prepare(page);await expect(previous(page)).toHaveJSProperty('open',false);
 const node=await previous(page).elementHandle();expect(node).not.toBeNull();await previousSummary(page).focus();await page.keyboard.press('Enter');await expect(previous(page)).toHaveJSProperty('open',true);
 metadataGate.release();await expect(page.locator('#artifact-downloads')).toBeVisible();await expect(previousSummary(page)).toBeFocused();expect(await node!.evaluate(element=>element.isConnected)).toBe(true);await expect(previous(page)).toHaveJSProperty('open',true);
 const versionsGate=gate();state.versionsGate=versionsGate;await page.locator('[data-next-refresh-basis]').click();await expect.poll(()=>versionsGate.entered).toBe(true);await expect(previous(page)).toHaveJSProperty('open',true);expect(await node!.evaluate(element=>element.isConnected)).toBe(true);
 versionsGate.release();await expect(page.locator('#execute-input')).toBeEnabled();await expect(previous(page)).toHaveJSProperty('open',true);
 await trackResultNavigation(page);const tasksGate=gate();state.tasksGate=tasksGate;await page.locator('#refresh-execution').click();await expect.poll(()=>tasksGate.entered).toBe(true);await expect(previous(page)).toHaveJSProperty('open',true);expect(await node!.evaluate(element=>element.isConnected)).toBe(true);expect(await resultNavigation(page)).toEqual([]);
 tasksGate.release();await expect(nextSummary(page)).toBeVisible();await expect(page.locator('#execute-input')).toBeEnabled();await expect(previous(page)).toHaveJSProperty('open',true);expect(await node!.evaluate(element=>element.isConnected)).toBe(true);expect(await resultNavigation(page)).toEqual([]);
 await previousSummary(page).focus();await page.keyboard.press('Enter');await expect(previous(page)).toHaveJSProperty('open',false);await page.locator('[data-refresh-materials]').click();await expect(page.locator('#workspace-material-count')).toContainText('2');await expect(page.locator('#execute-input')).toBeEnabled();await expect(previous(page)).toHaveJSProperty('open',false);expect(await node!.evaluate(element=>element.isConnected)).toBe(true);
 expect(writes(state)).toEqual([]);await assertNoStart(state);
});

test('authoring next layout: current choice survives preparation reload and returning locates the old result once without creating a round',async({page})=>{
 const state=await open(page),before=oldSnapshot(state);await expect(page.locator('#artifact-downloads')).toBeVisible();await prepare(page);await page.locator('[data-next-basis-choice]').selectOption('current');await expect(nextSummary(page)).toContainText('合成第3轮清洁版.docx');await expect(page).toHaveURL(/basis=current/);
 const metadataGate=gate();state.metadataGate={id:artifactId(2,'revision'),gate:metadataGate};await page.reload();await expect.poll(()=>metadataGate.entered).toBe(true);await expect(nextSummary(page)).toContainText('合成第3轮清洁版.docx');await expect(page.locator('[data-next-basis-choice]')).toHaveValue('current');await expect(previous(page)).toHaveJSProperty('open',false);await expect(page.locator('#execute-input')).toBeEnabled();
 await trackResultNavigation(page);await page.locator('[data-next-leave]').click();await expect(page).not.toHaveURL(/prepare=next/);await expect(page).toHaveURL(new RegExp('run='+ids.oldRun));await expect(previous(page)).toHaveJSProperty('open',true);await expect(previousSummary(page)).toBeHidden();expect(await resultNavigation(page)).toEqual([]);
 metadataGate.release();await expect(page.locator('#artifact-downloads')).toBeFocused();await expect(page.locator('#artifact-downloads')).toBeInViewport();await expect.poll(()=>resultNavigation(page)).toEqual([{kind:'focus',id:'artifact-downloads'},{kind:'scroll',id:'artifact-downloads'}]);
 await page.locator('#refresh-execution').click();await expect(page.locator('#prepare-next-version')).toBeVisible();await expect(page.locator('#artifact-downloads')).toBeVisible();expect(await resultNavigation(page)).toEqual([{kind:'focus',id:'artifact-downloads'},{kind:'scroll',id:'artifact-downloads'}]);
 expect(oldSnapshot(state)).toEqual(before);expect(state.versions.current_version_id).toBe('result-handoff-version-3');expect(writes(state)).toEqual([]);await assertNoStart(state);
});

test('authoring next layout: a failed terminal round can be folded without borrowing the newer successful Word',async({page})=>{
 const state=await open(page,fixture({failed:true}),failedRunId),before=oldSnapshot(state);await expect(page.locator('#execution-progress')).toContainText('本轮未完成');await expect(page.locator('#execution-delivery .artifact-download-panel')).toHaveCount(0);await prepare(page);
 await expect(previous(page)).toHaveJSProperty('open',false);await expect(previousSummary(page)).toContainText('任务失败');await expect(page.locator('[data-next-basis-choice]')).toHaveValue('current');await expect(page.locator('[data-next-basis-choice] option[value=result]')).toHaveJSProperty('disabled',true);await expect(nextSummary(page)).toContainText('合成第3轮清洁版.docx');
 await previousSummary(page).click();await expect(previous(page)).toHaveJSProperty('open',true);await expect(previous(page).locator('#execution-progress')).toContainText('本轮未完成');await expect(previous(page).locator('.artifact-download-panel')).toHaveCount(0);await expect(previous(page)).not.toContainText('第 3 版');
 await trackResultNavigation(page);await page.locator('[data-next-leave]').click();await expect(page.locator('#run-panel')).toBeFocused();await expect.poll(()=>resultNavigation(page)).toEqual([{kind:'focus',id:'run-panel'},{kind:'scroll',id:'run-panel'}]);
 expect(state.versions.current_version_id).toBe('result-handoff-version-3');expect(oldSnapshot(state)).toEqual(before);expect(writes(state)).toEqual([]);await assertNoStart(state);
});

test('authoring next layout: pending receipt controls remain outside the folded result and retry uses the identical next-input envelope',async({page})=>{
 const state=await open(page),before=oldSnapshot(state);await prepare(page);state.dropExecute='before';await page.locator('#execute-input').click();await expect(page.locator('#retry-execution')).toBeVisible();await expect(page.locator('#retry-execution')).toBeEnabled();await expect(page.locator('#execution-message')).toContainText('提交结果尚未确认');
 await expect(previous(page)).toHaveJSProperty('open',false);await expect(previous(page).locator('#retry-execution,#refresh-execution,#execution-message')).toHaveCount(0);await expect(page.locator('#refresh-execution')).toBeVisible();await expect(page.locator('#execute-input')).toBeDisabled();await expect(page.locator('[data-upload-role=audit]')).toBeDisabled();
 expect(state.inputAttempts).toHaveLength(1);expect(state.preflights).toHaveLength(1);expect(state.quotes).toHaveLength(1);expect(state.executions).toHaveLength(1);expect(state.locked[0].request.edit_base).toEqual(selectedPin(state,2));const envelope=structuredClone(state.executions[0]);
 await page.locator('#retry-execution').click();await expect(page.locator('#retry-execution')).toBeHidden();await expect(previous(page)).toHaveJSProperty('open',true);await expect(previousSummary(page)).toBeHidden();await expect(page.locator('#cancel-run')).toBeVisible();
 expect(state.executions).toEqual([envelope,envelope]);expect(state.inputAttempts).toHaveLength(1);expect(state.preflights).toHaveLength(1);expect(state.quotes).toHaveLength(1);expect(oldSnapshot(state)).toEqual(before);expect(state.versions.current_version_id).toBe('result-handoff-version-3');
 const active=[...state.runs.values()].filter(run=>!['succeeded','test_completed','failed','cancelled','rejected'].includes(run.state));expect(active).toHaveLength(1);expect(state.project.input_revision).toBe(active[0].input_revision);expect(state.project.input_hash).toBe(active[0].input_hash);
});

test('authoring next layout: a newly accepted active round exposes pause, resume and stop instead of archived controls',async({page})=>{
 const state=await open(page),before=oldSnapshot(state);await prepare(page);await page.locator('[data-next-basis-choice]').selectOption('current');await expect(nextSummary(page)).toContainText('合成第3轮清洁版.docx');await page.locator('#execute-input').click();await expect(page.locator('#cancel-run')).toBeVisible();
 await expect(previous(page)).toHaveJSProperty('open',true);await expect(previousSummary(page)).toBeHidden();await expect(page.locator('#prepare-next-version')).toHaveCount(0);await expect(page.locator('#execution-delivery .artifact-download-panel')).toHaveCount(0);expect(state.locked[0].request.edit_base).toEqual(selectedPin(state,3));
 await page.locator('#pause-run').click();await expect(page.locator('#resume-run')).toBeVisible();await expect(previous(page)).toHaveJSProperty('open',true);await expect(previousSummary(page)).toBeHidden();await page.locator('#resume-run').click();await expect(page.locator('#pause-run')).toBeVisible();await expect(page.locator('#cancel-run')).toBeVisible();
 await page.locator('#cancel-run').click();await expect(page.locator('#prepare-next-version')).toBeVisible();await expect(previous(page)).toHaveJSProperty('open',true);await expect(previousSummary(page)).toBeHidden();expect(state.runActions.map(item=>item.action)).toEqual(['pause','resume','cancel']);expect(state.inputAttempts).toHaveLength(1);expect(state.executions).toHaveLength(1);expect(oldSnapshot(state)).toEqual(before);expect(state.versions.current_version_id).toBe('result-handoff-version-3');
});

test('authoring next layout desktop component comparison keeps the same historical Word while bringing next-round materials forward against exact R27',async({page})=>{
 const reference=process.env.BB_AUTHORING_NEXT_LAYOUT_REFERENCE==='1',verify=reference?await installAuthoringNextReference(page):undefined,directory=process.env.BB_AUTHORING_NEXT_LAYOUT_EVIDENCE_DIR??test.info().outputPath('component-capture');const state=await open(page),before=oldSnapshot(state);await expect(page.locator('#artifact-downloads')).toBeVisible();await prepare(page);
 if(reference){await expect(previous(page)).toHaveCount(0);await expect(page.locator('#artifact-downloads')).toBeVisible();}else{await expect(previous(page)).toHaveJSProperty('open',false);await expect(previousSummary(page)).toBeVisible();await expect(guide(page)).toBeFocused();await expect(page.locator('#artifact-downloads')).toBeHidden();await expect(page.locator('#execution-delivery .authoring-summary')).toBeHidden();}
 const prepared=await captureAuthoringNext(page,directory!,'authoring-next-prepared-1440',{reference,action:'same exact historical V2 prepare; project current stays V3',writes:writes(state)});expect(prepared.basis).toBe('result');expect(prepared.hash).toContain('run='+ids.oldRun);
 expect(prepared.notesParagraphs).toBeGreaterThanOrEqual(10);if(reference){expect(prepared.notes!.height).toBeGreaterThan(500);expect(prepared.notesTail!.bottom).toBeGreaterThan(prepared.height);expect(prepared.materials!.top).toBeGreaterThan(prepared.height+400);}else expect(prepared.notes).toBeNull();
 if(!reference){expect(prepared.materials!.top).toBeLessThan(prepared.height);await previousSummary(page).focus();await page.keyboard.press('Enter');await expect(previous(page)).toHaveJSProperty('open',true);}
 await expect(page.locator('[data-artifact-result-context]')).toContainText('第 2 版');await captureAuthoringNext(page,directory!,'authoring-next-opened-1440',{reference,action:'same original historical Word, explicit native disclosure in current',writes:writes(state)});
 await page.locator('[data-next-leave]').click();await expect(page).not.toHaveURL(/prepare=next/);await expect(page.locator('#artifact-downloads')).toBeVisible();if(!reference){await expect(previous(page)).toHaveJSProperty('open',true);await expect(previousSummary(page)).toBeHidden();await expect(page.locator('#artifact-downloads')).toBeFocused();}
 await captureAuthoringNext(page,directory!,'authoring-next-returned-1440',{reference,action:'same return action retains V2 with no new input or task',writes:writes(state)},false);expect(oldSnapshot(state)).toEqual(before);expect(writes(state)).toEqual([]);await assertNoStart(state);if(verify)await writeFile(join(directory!,'authoring-next-layout-reference-1440.json'),JSON.stringify(await verify(),null,2));
});
