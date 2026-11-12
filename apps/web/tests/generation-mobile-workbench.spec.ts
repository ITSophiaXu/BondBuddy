import {documentChoice,clearRows,addDocuments,selectedRows} from './file-generation-rows';
import {expect,test,type Locator,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {M4_DOCUMENT_FIXED_PRICE,PROJECT_DOCUMENT_CATALOG,type M4DocumentType,type M4DraftRequest} from '@bondbuddy/contracts';
import {assertFixture,batches,choose,documents,drafts,entry,file,fixture,ids,note,open,query,raw,selected,templateWrites,writes} from './generation-entry-fixtures';
import {installGenerationMobileReference} from './generation-mobile-reference';

// A bounded R20 layout/interaction slice. The sealed R19 fixture, recovery
// protocol and pending/unknown matrix remain in their original test files.
const label=(type:M4DocumentType)=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name;
const cost=(count:number)=>(count*M4_DOCUMENT_FIXED_PRICE.points).toLocaleString();
const requirements=(page:Page)=>page.locator('#pf-requirements-details');
const support=(page:Page)=>page.locator('#pf-support-details');
async function isOpen(group:Locator){return group.evaluate(node=>(node as HTMLDetailsElement).open);}
async function disclosure(group:Locator,opened:boolean){
  // The exact R19 reference has the original expanded form and no new groups.
  if(!await group.count())return;
  if(await isOpen(group)!==opened)await group.locator(':scope > summary').click();
  await expect.poll(()=>isOpen(group)).toBe(opened);
}
async function chooseDocuments(page:Page,types:M4DocumentType[]){await choose(page,types);}
async function closeOptionalGroups(page:Page){for(const group of [requirements(page),support(page)])await disclosure(group,false);}
async function outsideDisclosure(locator:Locator){await expect(locator).toBeVisible();expect(await locator.evaluate(node=>node.closest('details')===null)).toBe(true);}
async function precedes(first:Locator,second:Locator){const a=await first.boundingBox(),b=await second.boundingBox();expect(a).not.toBeNull();expect(b).not.toBeNull();expect(a!.y+a!.height).toBeLessThanOrEqual(b!.y+1);}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual((await page.viewportSize())!.width+1);}
async function mobile(page:Page,width=390){await page.setViewportSize({width,height:900});}

test('generation mobile: a selected-document entry exposes its row, template and one next action',async({page})=>{
  await mobile(page);const s=await fixture(page),before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);
  await entry(page,'credit');expect(writes(s)).toEqual([]);await documents(page);
  expect(await selected(page)).toEqual(['credit']);await expect(documentChoice(page,'credit')).toHaveValue('credit');
  expect(await isOpen(requirements(page))).toBe(false);expect(await isOpen(support(page))).toBe(false);
  await expect(page.locator('#pf-prepared')).toHaveText('1 / 1 已准备');await expect(page.locator('#pf-price')).toContainText(cost(1));
  await expect(page.locator('#pf-generate')).toHaveCount(1);await expect(page.getByRole('button',{name:'开始生成文件包',exact:true})).toHaveCount(1);await expect(page.locator('#pf-generate')).toBeEnabled();
  await precedes(page.locator('.pf-file-builder'),requirements(page));await expect(page.locator('#pf-generate')).toBeVisible();await noOverflow(page);
  expect(writes(s).map(call=>call.path)).toEqual([`/projects/${ids.api}/project-files/source`]);expect(s.workspaces.get(ids.api)!.workspace.drafts).toEqual(before);
  await page.locator('#pf-generate').click();await expect(page.locator('#pf-confirm-generation')).toBeVisible();await expect(page.locator('.pf-confirm-files li')).toHaveCount(1);await expect(page.locator('.pf-confirm-files')).toContainText(label('credit'));
  const source=s.workspaces.get(ids.api)!.source!;await expect(page.locator('.pf-flow-confirm')).toContainText(source.filename);await expect(page.locator('.pf-confirm-total')).toContainText(cost(1));expect(batches(s)).toEqual([]);expect(drafts(s)).toEqual([]);
  await page.locator('#pf-confirm-generation').click();await expect(page.getByRole('heading',{name:'文件生成任务',exact:true})).toBeVisible();expect(batches(s)).toHaveLength(1);
  expect(batches(s)[0].body).toEqual({request_id:expect.any(String),source_version_id:source.version_id,expected_selection_revision:source.selection_revision,documents:[{document_type:'credit',draft_version:before.credit.version}]});expect(drafts(s)).toEqual([]);assertFixture(s);
});

test('generation mobile: an empty package starts with a blank row and native edits persist at 320px',async({page})=>{
  await mobile(page,320);const s=await fixture(page);await open(page);expect(await selected(page)).toEqual([]);await expect(page.locator('#pf-generate')).toBeDisabled();
  await addDocuments(page,['init']);await addDocuments(page,['underwriter']);
  expect(await selected(page)).toEqual(['init','underwriter']);await expect(page.locator('#pf-price')).toContainText(cost(2));await expect(documentChoice(page,'underwriter')).toHaveValue('underwriter');
  await clearRows(page);expect(await selected(page)).toEqual([]);await expect(page.locator('#pf-generate')).toBeDisabled();
  await addDocuments(page,['legal']);await page.reload();await expect(page.locator('#pf-generate')).toBeVisible();expect(await selected(page)).toEqual(['legal']);
  await expect(documentChoice(page,'legal')).toHaveValue('legal');await clearRows(page);await expect(page.locator('#pf-generate')).toBeDisabled();
  await noOverflow(page);expect(writes(s)).toEqual([]);assertFixture(s);
});

test('generation mobile: a selected missing template stays actionable in its row and only its draft is prepared',async({page})=>{
  await mobile(page,320);const s=await fixture(page);s.workspaces.get(ids.api)!.workspace.drafts.legal.template=null;
  const before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);await entry(page,'legal');await documents(page);
  await expect(page.locator('#pf-package-readiness')).toContainText(/1.*模板|模板.*1/);await expect(page.locator('#pf-prepared')).toHaveText('0 / 1 已准备');await expect(page.locator('#pf-generate')).toBeDisabled();
  await page.locator('#pf-go-template').click();await expect(page.locator('#pf-template-list')).toBeFocused();const reused=page.locator('[data-pf-reused="legal"]');await disclosure(reused,true);
  const add=page.locator('[data-pf-template="legal"]');await outsideDisclosure(add);await add.click();await expect(page.locator('dialog')).toBeVisible();await page.locator('[data-use-template="template-legal"]').click();
  await expect(page.locator('dialog')).toHaveCount(0);await expect(page.locator('#pf-prepared')).toHaveText('1 / 1 已准备');await expect(page.locator('#pf-generate')).toBeEnabled();
  expect(await isOpen(reused)).toBe(true);await expect(reused).toContainText(before.legal.supplemental_requirements!);
  expect(drafts(s).map(call=>(call.body as M4DraftRequest).input.document_type)).toEqual(['legal']);expect((drafts(s)[0].body as M4DraftRequest).expected_version).toBe(1);expect(s.workspaces.get(ids.api)!.workspace.drafts.init).toEqual(before.init);
  expect(await isOpen(requirements(page))).toBe(false);expect(batches(s)).toEqual([]);await noOverflow(page);assertFixture(s);
});

test('generation mobile: unsaved requirements reopen after refresh and disclosure choices survive preparation repaint',async({page})=>{
  await mobile(page);const s=await fixture(page);await open(page);await chooseDocuments(page,['init']);await disclosure(requirements(page),true);await page.locator('#pf-requirements').fill(note);
  const saved=await raw(page,'note');await disclosure(requirements(page),false);await expect(page.locator('#pf-note-summary')).toContainText('未保存');expect(await raw(page,'note')).toBe(saved);expect(writes(s)).toEqual([]);
  await page.reload();await expect(page.locator('#pf-generate')).toBeVisible();expect(await isOpen(requirements(page))).toBe(true);await expect(page.locator('#pf-requirements')).toHaveValue(note);await expect(page.locator('#pf-note-summary')).toContainText('未保存');
  await disclosure(support(page),true);const reused=page.locator('[data-pf-reused="init"]');await disclosure(reused,true);await expect(reused).toContainText('已有专业要求');
  await addDocuments(page,['underwriter']);expect(await isOpen(requirements(page))).toBe(true);expect(await isOpen(support(page))).toBe(true);expect(await isOpen(reused)).toBe(true);
  await disclosure(requirements(page),false);await disclosure(support(page),false);await addDocuments(page,['legal']);expect(await isOpen(requirements(page))).toBe(false);expect(await isOpen(support(page))).toBe(false);expect(await isOpen(reused)).toBe(true);
  await expect(page.locator('#pf-note-summary')).toContainText('未保存');await disclosure(requirements(page),true);await expect(page.locator('#pf-requirements')).toHaveValue(note);
  expect(drafts(s)).toEqual([]);expect(batches(s)).toEqual([]);expect(await raw(page,'note')).toBe(saved);await noOverflow(page);assertFixture(s);
});

test('generation mobile: a partial note save and its error stay visible outside optional disclosures and resume the original scope',async({page})=>{
  await mobile(page);const s=await fixture(page),before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);s.failDraft='underwriter';
  await open(page);await chooseDocuments(page,['init','underwriter']);await disclosure(requirements(page),true);await page.locator('#pf-requirements').fill(note);await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeVisible();
  await closeOptionalGroups(page);const recovery=page.locator('#pf-note-recovery');await outsideDisclosure(recovery);await outsideDisclosure(page.locator('#pf-save-requirements'));await outsideDisclosure(page.locator('#pf-stop-note'));await outsideDisclosure(page.locator('#pf-status'));await expect(page.locator('#pf-status')).toHaveText(/\S/);
  await expect(recovery).toContainText(label('init'));await expect(recovery).toContainText(label('underwriter'));await expect(page.locator('#pf-save-requirements')).toHaveCount(1);await expect(page.locator('#pf-generate')).toBeDisabled();
  await page.locator('#pf-save-requirements').click();await expect(page.locator('#pf-stop-note')).toBeHidden();expect(drafts(s).map(call=>(call.body as M4DraftRequest).input.document_type)).toEqual(['init','underwriter','underwriter']);
  expect(s.workspaces.get(ids.api)!.workspace.drafts.init.supplemental_requirements).toBe(before.init.supplemental_requirements+'\n\n'+note);expect(s.workspaces.get(ids.api)!.workspace.drafts.credit).toEqual(before.credit);expect(await selected(page)).toEqual(['init','underwriter']);expect(batches(s)).toEqual([]);await noOverflow(page);assertFixture(s);
});

for(const kind of ['support','template'] as const)test(`generation mobile: original ${kind} recovery remains visible and usable outside folded optional inputs`,async({page})=>{
  await mobile(page,kind==='support'?320:390);const s=await fixture(page),before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);await open(page);await chooseDocuments(page,kind==='support'?['init','underwriter']:['init']);
  if(kind==='support'){s.dropDraft='init';await disclosure(support(page),true);await page.locator('#pf-support').setInputFiles(file);}
  else {s.dropTemplate=true;await page.locator('[data-pf-template="init"]').click();await page.locator('dialog input[name="broker"]').fill('原模板券商');await page.locator('dialog input[type="file"]').setInputFiles(file);}
  const recovery=page.locator(`#pf-${kind}-recovery`),resume=recovery.locator('[data-generation-resume]');await expect(resume).toBeVisible();const original=kind==='template'?structuredClone(templateWrites(s)[0].body):undefined;
  if(kind==='template'){await outsideDisclosure(page.locator('#pf-modal-status'));await expect(page.locator('#pf-modal-status')).toHaveText(/\S/);await page.locator('dialog [data-close]').click();await expect(page.locator('dialog')).toHaveCount(0);}
  await closeOptionalGroups(page);await outsideDisclosure(recovery);await outsideDisclosure(resume);await expect(recovery).toContainText(label('init'));
  if(kind==='support'){await outsideDisclosure(page.locator('#pf-live-support-recovery'));await outsideDisclosure(page.locator('#pf-status'));await expect(page.locator('#pf-status')).toHaveText(/\S/);await expect(recovery).toContainText(label('underwriter'));}
  const count=writes(s).length;await page.reload();await expect(resume).toBeVisible();expect(writes(s)).toHaveLength(count);await closeOptionalGroups(page);await outsideDisclosure(recovery);await outsideDisclosure(resume);await expect(page.locator('#pf-generate')).toBeDisabled();
  await resume.click();await expect(resume).toHaveCount(0);expect(s.puts).toBe(1);expect(s.sessions.size).toBe(1);expect(s.workspaces.get(ids.api)!.workspace.drafts.credit).toEqual(before.credit);
  expect(drafts(s).map(call=>(call.body as M4DraftRequest).input.document_type)).toEqual(kind==='support'?['init','underwriter']:['init']);
  if(kind==='template'){expect(templateWrites(s).map(call=>call.body)).toEqual([original,original]);expect(s.workspaces.get(ids.api)!.workspace.drafts.init.fields.broker).toBe('原模板券商');}
  else {expect(s.workspaces.get(ids.api)!.workspace.drafts.init.materials).toHaveLength(1);expect(s.workspaces.get(ids.api)!.workspace.drafts.underwriter.materials).toHaveLength(1);}
  expect(batches(s)).toEqual([]);await noOverflow(page);assertFixture(s);
});

test('generation mobile: folding does not consume an unresolved entry conflict or hide its three explicit choices',async({page})=>{
  await mobile(page,320);const s=await fixture(page),before=structuredClone(s.workspaces.get(ids.api)!.workspace.drafts);await open(page);await chooseDocuments(page,['init']);await disclosure(requirements(page),true);await page.locator('#pf-requirements').fill(note);
  await entry(page,'credit');await documents(page);await closeOptionalGroups(page);const card=page.getByRole('region',{name:'准备生成所选文种'});await outsideDisclosure(card);await expect(card.getByRole('button')).toHaveCount(3);await expect(page.locator('#pf-entry-transfer')).toBeVisible();await expect(page.locator('#pf-generate')).toBeDisabled();
  expect((await query(page)).prepare_document).toBe('credit');expect((await query(page)).prepare_wait).toBe('1');expect(await selected(page)).toEqual(['init']);expect(drafts(s)).toEqual([]);
  await page.locator('#pf-entry-transfer').click();await expect(page.locator('#pf-entry-transfer')).toHaveCount(0);expect(await selected(page)).toEqual(['credit']);await expect(documentChoice(page,'credit')).toHaveValue('credit');expect((await query(page)).prepare_document).toBeUndefined();
  await expect(page.locator('#pf-note-summary')).toContainText('未保存');await disclosure(requirements(page),true);await expect(page.locator('#pf-requirements')).toHaveValue(note);expect(s.workspaces.get(ids.api)!.workspace.drafts).toEqual(before);expect(batches(s)).toEqual([]);await noOverflow(page);assertFixture(s);
});

for(const width of [1440,390,320])test(`generation mobile component comparison at ${width}px uses the same ready package and unsaved note with missing template`,async({page})=>{
  await mobile(page,width);const reference=process.env.BB_GENERATION_MOBILE_REFERENCE==='1',verify=reference?await installGenerationMobileReference(page):undefined,s=await fixture(page);s.workspaces.get(ids.api)!.workspace.drafts.legal.template=null;
  await entry(page,'credit');await documents(page);expect(await selected(page)).toEqual(['credit']);await expect(page.locator('#pf-generate')).toBeEnabled();
  const dir=process.env.BB_GENERATION_MOBILE_EVIDENCE_DIR??test.info().outputPath('component-capture');await mkdir(dir,{recursive:true});
  const capture=async(name:string)=>{
    await page.evaluate(()=>scrollTo(0,0));await noOverflow(page);
    const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText,
      disclosures:Object.fromEntries(['pf-requirements-details','pf-support-details'].map(id=>[id,(document.getElementById(id) as HTMLDetailsElement|null)?.open??null])),
      nextButtons:document.querySelectorAll('#pf-generate').length}));
    await page.screenshot({path:join(dir!,`generation-mobile-${name}-${width}.png`),fullPage:true});await writeFile(join(dir!,`generation-mobile-${name}-${width}.json`),JSON.stringify({...layout,reference,selection:await selected(page),query:await query(page)},null,2));
  };
  if(!reference){expect(await isOpen(requirements(page))).toBe(false);expect(await isOpen(support(page))).toBe(false);}
  await capture('ready');await chooseDocuments(page,['init','legal']);await disclosure(requirements(page),true);await page.locator('#pf-requirements').fill(note);await page.reload();await expect(page.locator('#pf-generate')).toBeVisible();
  expect(await selected(page)).toEqual(['init','legal']);await expect(page.locator('#pf-requirements')).toHaveValue(note);await expect(page.locator('#pf-generate')).toBeDisabled();await expect(page.locator('#pf-prepared')).toHaveText('1 / 2 已准备');
  if(!reference){expect(await isOpen(requirements(page))).toBe(true);expect(await isOpen(support(page))).toBe(false);}
  await capture('note-missing-template');expect(drafts(s)).toEqual([]);expect(batches(s)).toEqual([]);assertFixture(s);if(verify)await writeFile(join(dir!,`generation-mobile-reference-${width}.json`),JSON.stringify(await verify(),null,2));
});
