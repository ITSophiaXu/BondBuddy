import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,install,completed,prepareId,projectId,ownerId,oldArtifact,writes,questions} from './project-qa-continuation-fixtures';
import {QaRecoveryCache} from '../src/qa-recovery-cache';

const route=(run=prepareId)=>`/#qa?project=${projectId}&run=${run}`;
function fresh(){const s=fixture();s.workspace.draft={preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:false};return s;}
test.afterEach(async({page})=>{await expect(page.locator('#qa-knowledge,[data-qa-knowledge-choice],#qa-confirm')).toHaveCount(0);});

for(const width of [1440,390,320])test(`one preparation page with inline fees and one start at ${width}px`,async({page})=>{
 const s=fresh();await install(page,s);await page.setViewportSize({width,height:960});await page.goto(route());
 await expect(page.locator('.qa-question-list article')).toHaveCount(3);
 await expect(page.locator('#qa-requirements')).toBeVisible();await expect(page.locator('.qa-reference-panel')).toBeVisible();
 await expect(page.locator('#qa-use-preparation')).toHaveCount(0);await expect(page.locator('#qa-start')).toHaveText('开始回答 · 180 积分');
 await expect(page.locator('.qa-start-summary')).toContainText('交付后扣费');expect(writes(s)).toEqual([]);
 await expect(page.locator('#qa-ranges,[data-remove-q],#qa-reference-search')).toHaveCount(0);await page.locator('#qa-requirements').fill('请保留完整明细与期间。');
 await page.reload();await expect(page.locator('.qa-question-list article')).toHaveCount(3);await expect(page.locator('#qa-requirements')).toHaveValue('请保留完整明细与期间。');
 await expect(page.locator('#qa-start')).toHaveText('开始回答 · 180 积分');expect(writes(s)).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 const dir=process.env.BB_UX_EVIDENCE_DIR;if(dir){
  await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`single-start-${width}.png`),fullPage:true});
  const document=page.locator('.qa-document');await document.screenshot({path:join(dir,`preparation-component-${width}.png`)});
  const bounds=await page.locator('.qa-page').boundingBox(),ref=await page.context().newPage();await ref.setViewportSize({width,height:960});
  await ref.goto('/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/qa-materials.html',import.meta.url)).replaceAll('\\','/'));
  await ref.locator('main').evaluate((node,w)=>{node.style.width=w+'px';node.style.padding='0';},bounds!.width);
  await ref.locator('[data-show="questions"]').click();await ref.locator('[data-view="questions"] .qa-document').screenshot({path:join(dir,`preparation-prototype-${width}.png`)});await ref.close();
 }
 // Dispatch two clicks before the save receipt to exercise the busy guard.
 await page.locator('#qa-start').evaluate(button=>{(button as HTMLButtonElement).click();button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
 await expect.poll(()=>s.answers.length).toBe(1);expect(s.drafts).toHaveLength(1);expect(s.accepted.size).toBe(1);
 expect(s.answers[0].expected_points).toBe(180);expect(s.drafts[0].draft.requirements).toBe('请保留完整明细与期间。');expect(s.drafts[0].draft.use_knowledge).toBe(false);
 expect(s.calls.filter(call=>call.path.startsWith('/qa/cases'))).toEqual([]);
 expect(s.errors).toEqual([]);expect(s.unexpected).toEqual([]);
});

test('one-click start stops at an uncertain save receipt and resumes only after explicit recovery',async({page})=>{
 const s=fresh();s.dropDraft=true;await install(page,s);await page.goto(route());await page.locator('#qa-start').click();
 await expect(page.locator('#qa-refresh-pending')).toBeEnabled();expect(s.drafts).toHaveLength(1);expect(s.answers).toEqual([]);
 await page.reload();await expect(page.locator('#qa-start')).toBeDisabled();expect(s.answers).toEqual([]);
 await page.locator('#qa-refresh-pending').click();await expect(page.locator('#qa-start')).toBeEnabled();expect(s.answers).toEqual([]);
 await page.locator('#qa-start').click();await expect.poll(()=>s.answers.length).toBe(1);expect(s.drafts).toHaveLength(1);expect(s.answers[0].expected_points).toBe(180);
});

test('new uploaded checklist opens combined preparation after polling, with no paid request',async({page})=>{
 const s=fixture();s.allowUploads=true;await install(page,s);await page.goto('/#qa?project='+projectId);
 await page.locator('#qa-upload').setInputFiles({name:'合成新清单.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic upload')});
 await expect.poll(()=>s.prepares.length).toBe(1);const run=s.workspace.runs[0];await expect(page).toHaveURL(new RegExp('run='+run.run_id));
 Object.assign(run,completed(run.manifest,run.run_id,run.sequence));run.result!.snapshot.sha256=run.manifest.source.asset.pin.sha256;
 await expect(page.locator('#qa-start')).toBeEnabled({timeout:10000});await expect(page.locator('.qa-question-list article')).toHaveCount(3);
 await expect(page.locator('#qa-requirements')).toHaveValue('');await expect(page.locator('#qa-use-preparation')).toHaveCount(0);
 expect(s.answers).toEqual([]);expect(s.drafts).toEqual([]);await page.reload();await expect(page.locator('#qa-start')).toBeEnabled();expect(s.prepares).toHaveLength(1);
 expect(s.errors).toEqual([]);expect(s.unexpected).toEqual([]);
});

test('legacy local knowledge-choice flag no longer blocks an editable round',async({page})=>{
 const s=fixture();s.workspace.draft.materials.push(oldArtifact);await install(page,s);
 const memory=new Map<string,string>();const cache=new QaRecoveryCache(ownerId,projectId,{getItem:key=>memory.get(key)??null,setItem:(key,value)=>{memory.set(key,value);},removeItem:key=>{memory.delete(key);}});
 expect(cache.save({revision:s.workspace.revision,draft:s.workspace.draft,needsKnowledgeChoice:true}).status).toBe('valid');
 await page.addInitScript(entries=>{for(const [key,value] of entries)localStorage.setItem(key,value);},[...memory]);await page.goto(route());
 await expect(page.locator('#qa-start')).toBeEnabled();await expect(page.locator('#qa-requirements')).toHaveValue(s.workspace.draft.requirements);expect(writes(s)).toEqual([]);
});

test('viewing another historical checklist preserves the current edited round until adopted',async({page})=>{
 const s=fixture(),old=structuredClone(s.workspace.runs.find(r=>r.run_id===prepareId)!);old.run_id='synthetic-other-preparation';old.sequence=2;s.workspace.runs.push(old);
 const before=structuredClone(s.workspace.draft);await install(page,s);await page.goto(route(old.run_id));
 await expect(page.locator('#qa-use-preparation')).toHaveText('将此清单用于新一轮');await expect(page.locator('#qa-start')).toHaveCount(0);expect(s.workspace.draft).toEqual(before);expect(writes(s)).toEqual([]);
 await page.locator('#qa-use-preparation').click();await expect(page.locator('#qa-start')).toBeEnabled();await expect(page).toHaveURL(new RegExp('run='+old.run_id));expect(writes(s)).toEqual([]);
});

test('an unparsed checklist cannot start and never asks for manual paragraph selection',async({page})=>{
 const s=fresh();s.workspace.runs.find(r=>r.run_id===prepareId)!.result!.questions=[];s.workspace.runs.find(r=>r.run_id===prepareId)!.result!.warnings=['没有找到明确的问题编号或问句。请根据原文选择问题段落后开始。'];await install(page,s);await page.goto(route());
 await expect(page.locator('#qa-start')).toBeDisabled();await expect(page.locator('#qa-ranges,.qa-range-list')).toHaveCount(0);await expect(page.locator('.qa-document')).not.toContainText('选择问题段落');
 await expect(page.getByText('暂未能整理出可回答的问题',{exact:true})).toBeVisible();expect(writes(s)).toEqual([]);
});

test('ready materials and questions stay collapsed while supplementary upload and start remain available',async({page})=>{
 const s=fresh();await install(page,s);await page.goto(route());
 await expect(page.locator('[data-qa-questions-preview]')).toHaveJSProperty('open',false);
 await expect(page.locator('[data-qa-reference-panel]')).toHaveJSProperty('open',false);
 await expect(page.locator('[data-qa-reference-selected],#qa-reference-search,[data-qa-reference-detail]')).toHaveCount(0);
 await expect(page.getByText('补充项目材料',{exact:true})).toBeVisible();await expect(page.locator('#qa-start')).toBeEnabled();
 await page.locator('[data-qa-questions-preview]>summary').click();await expect(page.locator('.qa-question-list article').first()).toBeVisible();
 await page.locator('[data-qa-reference-panel]>summary').click();await expect(page.locator('[data-qa-reference-row]').first()).toBeVisible();
 expect(writes(s)).toEqual([]);
});
