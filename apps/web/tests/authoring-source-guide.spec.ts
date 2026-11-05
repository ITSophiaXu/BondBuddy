import {expect,test,type Locator,type Page} from '@playwright/test';
import {sourceProspectusInputGaps} from '@bondbuddy/contracts';
import {addActiveRun,assertFixture,auditId,expectNoExecution,fixture,historicalId,install,projectId,referenceId,sourceDeclaration,writes,type State} from './authoring-source-guide-fixtures';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {captureAuthoringPreparation,installAuthoringSourceGuideReference} from './authoring-source-guide-reference';

// Desktop only. Pure navigation is checked independently of user-entered fields
// and their legitimate project PATCHes. No real parsing/worker/ledger executes.
const guide=(page:Page)=>page.locator('#complete-source-information');
const unavailable='这份原稿的信息位置或材料版本暂时无法核实，请点击“刷新已保存材料”后再试。';
export const sourceFieldset=(page:Page,id:string)=>page.locator(`fieldset[data-source-material="${id}"]`);
const field=(page:Page,id:string,name:string)=>sourceFieldset(page,id).locator(`[data-source-field="${name}"]`);
test.beforeEach(async({page})=>{await page.setViewportSize({width:1440,height:900});});
test.afterEach(async({page})=>{await assertFixture(page);});

export async function openSourceGuide(page:Page,s=fixture()){
  await freshFixtureDocument(page);await install(page,s);await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('#workspace-materials')).toBeVisible();await expect(page.locator('#workspace-material-count')).toContainText(`${s.materials.length} 份已保存材料`);return s;
}
async function freshFixtureDocument(page:Page){
  // A different fixture needs a fresh document even if its project hash is the same.
  await page.goto('about:blank');
}
async function ancestors(control:Locator,open:boolean){await control.evaluate((node,value)=>{for(let p=node.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement)p.open=value;},open);}
async function allAncestorsOpen(control:Locator){expect(await control.evaluate(node=>{for(let p=node.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement&&!p.open)return false;return true;})).toBe(true);}
async function inViewport(control:Locator){const bounds=await control.boundingBox();expect(bounds).not.toBeNull();expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(900);}
export async function readonlySnapshot(page:Page,s:State){
  const ui=await page.evaluate(()=>{
    const controls=[...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('main input,main select,main textarea')];
    const containers=new Set<HTMLElement>(),editing=document.querySelector<HTMLElement>('#material-editing');
    if(editing)containers.add(editing);
    for(const control of controls)for(let parent=control.parentElement;parent;parent=parent.parentElement)containers.add(parent);
    return {hash:location.hash,
      forms:[...document.forms].map(form=>({id:form.id,action:form.action,method:form.method,noValidate:form.noValidate})),
      controls:controls.map(node=>({tag:node.tagName,id:node.id,name:node.name,type:node.type,value:node.value,disabled:node.disabled,effectiveDisabled:node.matches(':disabled'),required:node.required,
        checked:node instanceof HTMLInputElement?node.checked:null,readOnly:node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement?node.readOnly:null,
        selected:node instanceof HTMLSelectElement?[...node.selectedOptions].map(option=>option.value):null,files:node instanceof HTMLInputElement&&node.type==='file'?[...node.files??[]].map(file=>({name:file.name,size:file.size,type:file.type})):null})),
      // Opening details is permitted navigation; editing locks and visibility are not.
      containers:[...containers].map(node=>({tag:node.tagName,id:node.id,disabled:node instanceof HTMLFieldSetElement?node.disabled:null,disabledAttribute:node.hasAttribute('disabled'),inert:node.inert,inertAttribute:node.hasAttribute('inert'),hidden:node.getAttribute('hidden')})),
      sourcePins:[...document.querySelectorAll<HTMLElement>('[data-source-material]')].map(node=>({...node.dataset})),
      storage:{local:Object.fromEntries(Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)])),session:Object.fromEntries(Object.keys(sessionStorage).sort().map(key=>[key,sessionStorage.getItem(key)]))}};
  });
  return {...ui,project:structuredClone(s.project),materials:structuredClone(s.materials),writes:structuredClone(writes(s)),patches:structuredClone(s.patches),locked:structuredClone(s.locked),preflights:structuredClone(s.preflights),quotes:structuredClone(s.quotes),executes:structuredClone(s.executes)};
}
async function pureLocate(page:Page,s:State,target:Locator){
  const before=await readonlySnapshot(page,s);await guide(page).click();await expect(target).toBeFocused();await allAncestorsOpen(target);await inViewport(target);expect(await readonlySnapshot(page,s)).toEqual(before);
}
async function select(page:Page,id:string,name:string,value:string){const control=field(page,id,name);await ancestors(control,true);await control.selectOption(value);}
async function quarter(page:Page,id:string,value:string){const control=sourceFieldset(page,id).locator(`[data-source-field="quarter"][value="${value}"]`);await ancestors(control,true);await control.check();}
async function saved(page:Page,s:State,previous:number){await expect.poll(()=>s.patches.length).toBeGreaterThan(previous);await expect(page.locator('#save-state')).toHaveText('已保存');}
async function noSourceFocus(page:Page){expect(await page.evaluate(()=>document.activeElement?.closest('[data-source-material]')?.getAttribute('data-source-material')??null)).toBeNull();}
async function forceGuide(page:Page){await guide(page).evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));}

test('authoring source guide: first exact source opens every user-collapsed ancestor and only moves focus',async({page})=>{
  const s=await openSourceGuide(page);await expect(guide(page)).toBeVisible();await expect(page.locator('#start-disabled-reason')).toContainText(s.materials[0].filename);
  const target=field(page,historicalId,'relation');await ancestors(target,false);await expect(target).toBeHidden();await expect(page.locator('#project-materials-details')).toHaveJSProperty('open',false);
  await pureLocate(page,s,target);await expect(target).toHaveValue('');await expect(field(page,referenceId,'relation')).toHaveValue('parent');
  await expect(sourceFieldset(page,historicalId)).toHaveAttribute('data-source-material-version','2');await expect(sourceFieldset(page,historicalId)).toHaveAttribute('data-source-sha256',s.materials[0].sha256);
  expect(writes(s)).toEqual([]);expectNoExecution(s);
});

test('authoring source guide: user fills each saved source without subtype upload groups, then explicit start pins the declarations',async({page})=>{
  test.setTimeout(40000);const s=await openSourceGuide(page);await expect(guide(page)).toBeVisible();const initial=s.patches.length;
  await pureLocate(page,s,field(page,historicalId,'relation'));await select(page,historicalId,'relation','same_issuer');await select(page,historicalId,'market','sse');await select(page,historicalId,'offering','private');await select(page,historicalId,'year','2024');await quarter(page,historicalId,'12-31');await saved(page,s,initial);
  await expect(page.locator('#start-disabled-reason')).toContainText(s.materials[1].filename);const next=field(page,referenceId,'market');
  await expect(page.locator('#material-partitions .material-subtypes')).toHaveCount(0);await ancestors(next,false);await expect(next).toBeHidden();
  await pureLocate(page,s,next);await expect(field(page,referenceId,'relation')).toHaveValue('parent');
  const previous=s.patches.length;await select(page,referenceId,'market','szse');await select(page,referenceId,'offering','private');await select(page,referenceId,'year','2023');await quarter(page,referenceId,'06-30');await saved(page,s,previous);
  await expect(guide(page)).toBeHidden();await expect(page.locator('#execute-input')).toBeEnabled();expectNoExecution(s);expect(sourceProspectusInputGaps(s.materials,s.project.update_details?.source_prospectuses)).toEqual([]);
  const declarations=structuredClone(s.project.update_details!.source_prospectuses),patches=structuredClone(s.patches),expectedMaterials=s.materials.map(m=>({material_id:m.material_id,material_version:m.material_version}));
  expect(writes(s).every(call=>call.method==='PATCH'&&call.path===`/projects/${projectId}`)).toBe(true);
  await page.locator('#execute-input').click();await expect.poll(()=>s.executes.length).toBe(1);await expect(page.locator('#execute-input')).toBeDisabled();await expect(guide(page)).toBeHidden();
  expect(s.locked).toHaveLength(1);expect(s.preflights).toHaveLength(1);expect(s.quotes).toHaveLength(1);expect(s.runs.size).toBe(1);expect(s.patches).toEqual(patches);
  expect(s.locked[0].request.material_versions).toEqual(expectedMaterials);expect(s.locked[0].request.prospectus_selection_revision).toBe(5);expect(s.locked[0].project.update_details!.source_prospectuses).toEqual(declarations);
  for(const m of s.materials.filter(value=>['historical','reference'].includes(value.role)))expect(declarations!.find(source=>source.material_id===m.material_id)).toMatchObject({material_id:m.material_id,material_version:m.material_version,sha256:m.sha256});
  expect(s.executes[0]).toMatchObject({project_id:projectId,input_revision:s.locked[0].response.input_revision,input_hash:s.locked[0].response.input_hash,quote_id:s.quote!.quote_id});
  expect(writes(s).slice(patches.length).map(call=>call.path)).toEqual([`/projects/${projectId}/input-revisions`,`/projects/${projectId}/preflight`,`/projects/${projectId}/credit-quote`,'/runs/execute']);
});

test('authoring source guide: a source missing only its period focuses an unchecked quarter without choosing a date or copying the target period',async({page})=>{
  const s=fixture();s.materials=s.materials.filter(m=>m.material_id!==referenceId);s.project.update_details!.source_prospectuses=[sourceDeclaration(s.materials[0],{reporting_periods:[]})];
  await openSourceGuide(page,s);await expect(guide(page)).toBeVisible();const target=sourceFieldset(page,historicalId).locator('[data-source-field="quarter"]').first();await ancestors(target,false);
  await expect(field(page,historicalId,'year')).not.toHaveValue('');await expect(sourceFieldset(page,historicalId).locator('[data-source-field="quarter"]:checked')).toHaveCount(0);
  await pureLocate(page,s,target);await expect(target).not.toBeChecked();await expect(sourceFieldset(page,historicalId).locator('[data-source-field="quarter"]:checked')).toHaveCount(0);
  expect(s.project.update_details!.source_prospectuses![0].reporting_periods).toEqual([]);expect(s.project.update_details!.reporting_cutoff).toBe('2026-06-30');expectNoExecution(s);expect(writes(s)).toEqual([]);
});

for(const fault of ['id','version','hash'] as const)test(`authoring source guide: mismatched DOM ${fault} refuses another source and reports refresh without changing inputs`,async({page})=>{
  const s=await openSourceGuide(page);await expect(guide(page)).toBeVisible();const source=sourceFieldset(page,historicalId);await ancestors(source,false);
  await source.evaluate((node,kind)=>{const element=node as HTMLElement;if(kind==='id')element.dataset.sourceMaterial='synthetic-guide-reference';if(kind==='version')element.dataset.sourceMaterialVersion='99';if(kind==='hash')element.dataset.sourceSha256='0'.repeat(64);},fault);
  const before=await readonlySnapshot(page,s);await guide(page).click();await expect(page.locator('#execution-message')).toHaveText(unavailable);await noSourceFocus(page);expect(await readonlySnapshot(page,s)).toEqual(before);expectNoExecution(s);expect(writes(s)).toEqual([]);
});

test('authoring source guide: duplicate exact source fieldsets are ambiguous and never pick the first matching copy',async({page})=>{
  // Defensive DOM correspondence case; normal material rendering is unique.
  const s=await openSourceGuide(page);await expect(guide(page)).toBeVisible();const source=sourceFieldset(page,historicalId);await ancestors(source,false);await source.evaluate(node=>node.after(node.cloneNode(true)));
  await expect(sourceFieldset(page,historicalId)).toHaveCount(2);const before=await readonlySnapshot(page,s);await guide(page).click();await expect(page.locator('#execution-message')).toHaveText(unavailable);await noSourceFocus(page);
  expect(await readonlySnapshot(page,s)).toEqual(before);expectNoExecution(s);expect(writes(s)).toEqual([]);
});

test('authoring source guide: absent or complete sources, higher-priority restoration or invalid draft, and a locked task expose no actionable shortcut',async({page})=>{
  test.setTimeout(40000);
  for(const mode of ['absent','complete'] as const){
    const s=fixture();if(mode==='absent'){s.materials=s.materials.filter(m=>m.material_id===auditId);s.project.update_details!.source_prospectuses=[];}
    else s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
    await openSourceGuide(page,s);
    if(mode==='absent'){await expect(page.locator('#start-disabled-reason')).toContainText('请先上传并采用');await expect(page.locator('#execute-input')).toBeDisabled();}
    else{await expect(page.locator('#start-disabled-reason')).toHaveText('');await expect(page.locator('#execute-input')).toBeEnabled();}
    await expect(guide(page)).toBeHidden();const before=await readonlySnapshot(page,s);await forceGuide(page);expect(await readonlySnapshot(page,s)).toEqual(before);await noSourceFocus(page);expectNoExecution(s);await assertFixture(page);
  }
  const restoring=fixture();restoring.holdTasks=true;await freshFixtureDocument(page);await install(page,restoring);
  try{
    await page.goto(`/#/projects/${projectId}?step=materials`);await expect.poll(()=>restoring.heldTasks).toBe(true);await expect(page.locator('#workspace-material-count')).toContainText('3 份已保存材料');await expect(guide(page)).toBeHidden();await expect(page.locator('#start-disabled-reason')).toContainText('正在读取项目状态');
    const before=await readonlySnapshot(page,restoring);await forceGuide(page);await noSourceFocus(page);expect(await readonlySnapshot(page,restoring)).toEqual(before);expectNoExecution(restoring);
  }finally{restoring.releaseTasks?.();}
  await expect(guide(page)).toBeVisible();await assertFixture(page);
  const locked=fixture();addActiveRun(locked);await openSourceGuide(page,locked);await expect(page.locator('#start-disabled-reason')).toContainText('已有任务正在处理');await expect(guide(page)).toBeHidden();await expect(page.locator('[data-upload-role=audit]')).toBeDisabled();
  const lockedBefore=await readonlySnapshot(page,locked);await forceGuide(page);await noSourceFocus(page);await expect(page.locator('[data-upload-role=audit]')).toBeDisabled();expect(await readonlySnapshot(page,locked)).toEqual(lockedBefore);expectNoExecution(locked);await assertFixture(page);
  const invalid=await openSourceGuide(page);await expect(guide(page)).toBeVisible();const originalButton=await guide(page).elementHandle();expect(originalButton).not.toBeNull();await page.locator('#edit-project-details').click();await page.locator('#name').fill('');
  await expect(guide(page)).toBeHidden();await expect(page.locator('#start-disabled-reason')).toContainText('项目信息尚未保存');const invalidBefore=await readonlySnapshot(page,invalid);
  await originalButton!.evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));await expect(page.locator('#name')).toBeFocused();expect(await readonlySnapshot(page,invalid)).toEqual(invalidBefore);expectNoExecution(invalid);expect(writes(invalid)).toEqual([]);
});

test('authoring source guide desktop component comparison at 1440px shows the original blocker and accurate field location',async({page})=>{
  const reference=process.env.BB_AUTHORING_SOURCE_GUIDE_REFERENCE==='1',verify=reference?await installAuthoringSourceGuideReference(page):undefined;
  const s=await openSourceGuide(page),directory=process.env.BB_AUTHORING_SOURCE_GUIDE_EVIDENCE_DIR??test.info().outputPath('component-capture');
  await expect(page.locator('#start-disabled-reason')).toContainText(s.materials[0].filename);
  if(reference)await expect(guide(page)).toHaveCount(0);else await expect(guide(page)).toBeVisible();
  const target=field(page,historicalId,'relation');await ancestors(target,false);const before=await readonlySnapshot(page,s);
  await page.evaluate(()=>{(document.activeElement as HTMLElement|null)?.blur();scrollTo(0,document.documentElement.scrollHeight);});
  await captureAuthoringPreparation(page,directory!,'authoring-source-guide-blocked-1440',{reference,action:'same first source gap after user collapses material sections',writes:writes(s)});
  if(reference){
    // The previous component has no shortcut. Record explicit manual navigation
    // without pretending the old component implements the new button.
    await ancestors(target,true);await target.scrollIntoViewIfNeeded();await target.focus();
  }else{await guide(page).focus();await page.keyboard.press('Enter');}
  await expect(target).toBeFocused();await allAncestorsOpen(target);await inViewport(target);
  expect(await readonlySnapshot(page,s)).toEqual(before);expectNoExecution(s);expect(writes(s)).toEqual([]);
  await captureAuthoringPreparation(page,directory!,'authoring-source-guide-located-1440',{reference,action:reference?'manual expansion, scrolling and focus of the existing field':'native Enter on the source-gap shortcut',unchanged_snapshot:true,writes:writes(s)});
  if(verify)await writeFile(join(directory!,'authoring-source-guide-reference-1440.json'),JSON.stringify(await verify(),null,2));
});
