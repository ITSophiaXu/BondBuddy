import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
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
 await page.locator('[data-remove-q]').last().click();await page.locator('#qa-requirements').fill('请保留完整明细与期间。');
 await page.reload();await expect(page.locator('.qa-question-list article')).toHaveCount(2);await expect(page.locator('#qa-requirements')).toHaveValue('请保留完整明细与期间。');
 await expect(page.locator('#qa-start')).toHaveText('开始回答 · 120 积分');expect(writes(s)).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 const dir=process.env.BB_UX_EVIDENCE_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`single-start-${width}.png`),fullPage:true});}
 // Dispatch two clicks before the save receipt to exercise the busy guard.
 await page.locator('#qa-start').evaluate(button=>{(button as HTMLButtonElement).click();button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
 await expect.poll(()=>s.answers.length).toBe(1);expect(s.drafts).toHaveLength(1);expect(s.accepted.size).toBe(1);
 expect(s.answers[0].expected_points).toBe(120);expect(s.drafts[0].draft.requirements).toBe('请保留完整明细与期间。');expect(s.drafts[0].draft.use_knowledge).toBe(false);
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

test('zero candidates can be selected and merged on the same page before starting',async({page})=>{
 const s=fresh();s.workspace.runs.find(r=>r.run_id===prepareId)!.result!.questions=[];await install(page,s);await page.goto(route());
 await expect(page.locator('#qa-start')).toBeDisabled();await page.locator('#qa-ranges').click();
 await page.locator('[data-start="2"]').check();await page.locator('[data-end="2"]').fill('4');await page.locator('#qa-ranges-save').click();
 await expect(page.locator('.qa-question-list')).toContainText(questions[0].question);await expect(page.locator('#qa-start')).toHaveText('开始回答 · 60 积分');expect(writes(s)).toEqual([]);
 await page.locator('#qa-start').click();await expect.poll(()=>s.answers.length).toBe(1);expect(s.drafts[0].draft.questions).toEqual([questions[0]]);expect(s.answers[0].expected_points).toBe(60);
});
