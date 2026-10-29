import {expect,test,type Page} from '@playwright/test';
import {PROJECT_QA_PRICE,type QaDraft,type QaQuestion} from '@bondbuddy/contracts';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {answerId,assertFixture,fixture,historicalRecords,install,newMaterial,oldArtifact,oldMaterial,otherAnswerId,otherOwnerId,otherProjectId,
  prepareId,projectId,qaWrites,questions,snapshot,workspaceReads,writes,type State} from './project-qa-continuation-fixtures';

// All HTTP responses and request bodies use public schemas. Browser recovery is
// exercised with synthetic records; no real Word, supplier, payment or worker runs.
const followup=(page:Page,id:string)=>page.locator(`[data-qa-followup][value="${id}"]`);
const selectedIds=(page:Page)=>page.locator('[data-remove-q]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.removeQ));
const missingQuestions=()=>[structuredClone(questions[0]),structuredClone(questions[2])];
const originalRequirements='保留历史要求：逐题说明依据与待补材料。';
const preparedDraft=(selected:QaQuestion[]=missingQuestions(),useKnowledge=false):QaDraft=>({preparation_id:prepareId,questions:structuredClone(selected),materials:[structuredClone(oldMaterial),structuredClone(oldArtifact)],requirements:originalRequirements,use_knowledge:useKnowledge});
const route=(run:string|null=answerId,project=projectId)=>`/#qa?project=${project}${run?`&run=${run}`:''}`;

test.beforeEach(async({page})=>{page.on('dialog',dialog=>void dialog.accept());});
test.afterEach(async({page})=>{await assertFixture(page);});
async function open(page:Page,state=fixture(),run:string|null=answerId){await install(page,state);await page.goto(route(run));await expect(page.locator('#qa-history')).toBeVisible();if(await page.locator('.qa-followup').count())await page.locator('.qa-followup>summary').click();return state;}
async function adopt(page:Page){if(await page.locator('.qa-followup').getAttribute('open')===null)await page.locator('.qa-followup>summary').click();await page.locator('#qa-continue').click();await expect(page.locator('#qa-requirements')).toBeVisible();}
async function expectLocal(page:Page,ids=['q2','q7'],requirements=originalRequirements){
  await expect.poll(()=>selectedIds(page)).toEqual(ids);await expect(page.locator('#qa-requirements')).toHaveValue(requirements);
  await expect(page.locator('#qa-word-scope')).toHaveText('保留完整原问题清单，仅回填本轮所选问题，不会自动合并历史答案。');
}
async function expectPending(page:Page,kind:'answer'|'prepare'|'draft'){
  await expect(page.locator(kind==='draft'?'#qa-refresh-pending':'#qa-retry-pending')).toBeVisible();
  await expect(page.locator(kind==='draft'?'#qa-refresh-pending':'#qa-retry-pending')).toBeEnabled();
  await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',true);await expect(page.locator('#qa-requirements')).toBeDisabled();await expect(page.locator('#qa-save')).toBeDisabled();await expect(page.locator('#qa-history')).toBeDisabled();await expect(page.locator('#qa-upload')).toBeDisabled();
}
async function start(page:Page){await page.locator('#qa-start').click();}
async function screenshotAtTop(page:Page,directory:string,filename:string){await mkdir(directory,{recursive:true});await page.evaluate(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));(document.activeElement as HTMLElement|null)?.blur();window.scrollTo(0,0);});await page.screenshot({path:join(directory,filename),fullPage:true});}

for(const width of [1440,390])test(`${width}: historical missing selection adopts exact local preparation and survives refresh without POST`,async({page})=>{
  await page.setViewportSize({width,height:width===390?844:960});const state=await open(page),old=historicalRecords(state),serverDraft=structuredClone(state.workspace.draft);
  await expect(followup(page,'q2')).toBeChecked();await expect(followup(page,'q4')).not.toBeChecked();await expect(followup(page,'q7')).toBeChecked();
  expect(writes(state)).toEqual([]);const evidence=process.env.BB_UX_EVIDENCE_DIR;
  if(evidence)await screenshotAtTop(page,evidence,`qa-continuation-completed-${width}.png`);
  await adopt(page);await expectLocal(page);expect(qaWrites(state)).toEqual([]);expect(state.workspace.draft).toEqual(serverDraft);
  await expect(page.locator('[data-qa-knowledge-choice]')).toHaveCount(0);await expect(page.locator('[data-qa-knowledge-choice]')).toHaveCount(0);await expect(page.locator('#qa-save')).toBeEnabled();await expect(page.locator('#qa-start')).toBeEnabled();
  await expect(page.locator('.qa-question-list')).toContainText(questions[0].question);await expect(page.locator('.qa-question-list')).toContainText(questions[2].question);await expect(page.locator('.qa-question-list')).not.toContainText(questions[1].question);
  await expect(page.locator('.qa-materials')).toContainText('合成业务报告_v2.pdf');await expect(page.locator('.qa-materials')).toContainText('合成募集书_清洁版_v4.docx');
  await page.reload();await expectLocal(page);await expect(page.locator('#qa-save')).toBeEnabled();await expect(page.locator('#qa-start')).toBeEnabled();
  expect(writes(state)).toEqual([]);expect(historicalRecords(state)).toEqual(old);expect(snapshot.spans).toHaveLength(9);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(evidence)await screenshotAtTop(page,evidence,`qa-continuation-preparation-${width}.png`);
});

test('all/missing shortcuts and an individual selection retain original question IDs and charge one selected question',async({page})=>{
  const state=await open(page);await page.locator('#qa-followup-all').click();for(const id of ['q2','q4','q7'])await expect(followup(page,id)).toBeChecked();
  await page.locator('#qa-followup-missing').click();await expect(followup(page,'q2')).toBeChecked();await expect(followup(page,'q4')).not.toBeChecked();await expect(followup(page,'q7')).toBeChecked();
  await followup(page,'q2').uncheck();await followup(page,'q7').uncheck();await followup(page,'q4').check();await adopt(page);await expectLocal(page,['q4']);
  await expect(page.locator('.qa-start-summary')).toContainText('60');expect(qaWrites(state)).toEqual([]);
  await page.locator('#qa-start').click();await expect.poll(()=>state.answers.length).toBe(1);
  expect(state.drafts).toHaveLength(1);expect(state.drafts[0].draft).toEqual(preparedDraft([questions[1]],false));expect(state.answers[0].expected_points).toBe(PROJECT_QA_PRICE.points);
  expect(state.prepares).toEqual([]);expect(state.uploads).toEqual([]);
});

test('zero selected questions cannot be adopted or submitted',async({page})=>{
  const state=await open(page);await followup(page,'q2').uncheck();await followup(page,'q7').uncheck();await expect(page.locator('#qa-continue')).toBeDisabled();
  await expect(page.locator('#qa-start')).toHaveCount(0);expect(writes(state)).toEqual([]);
});

test('defensive schema-only history selects an unanswered original question without borrowing another answer',async({page})=>{
  // This intentionally incomplete history satisfies the public DTO schema only;
  // it is not a claim that a worker can deliver a successful Word with missing answers.
  const state=fixture(),historical=state.workspace.runs.find(run=>run.run_id===answerId)!;
  historical.result!.answers=historical.result!.answers.filter(answer=>answer.question_id!=='q7').reverse();await open(page,state);
  await expect(followup(page,'q2')).toBeChecked();await expect(followup(page,'q4')).not.toBeChecked();await expect(followup(page,'q7')).toBeChecked();
  await adopt(page);await expectLocal(page);expect(writes(state)).toEqual([]);
});

test('history selection adopts the selected run requirements and exact material version instead of current draft',async({page})=>{
  const state=await open(page),old=historicalRecords(state);await page.locator('#qa-history').selectOption(otherAnswerId);
  await expect(page.locator('#qa-history')).toHaveValue(otherAnswerId);await expect(followup(page,'q2')).toBeChecked();await adopt(page);
  await expectLocal(page,['q2','q7'],'另一历史轮要求：核对业务报告第三版。');expect(qaWrites(state)).toEqual([]);
  await page.locator('#qa-save').click();await expect.poll(()=>state.drafts.length).toBe(1);
  expect(state.drafts[0].draft).toEqual({preparation_id:prepareId,questions:missingQuestions(),materials:[newMaterial],requirements:'另一历史轮要求：核对业务报告第三版。',use_knowledge:false});
  expect(historicalRecords(state)).toEqual(old);expect(state.prepares).toEqual([]);expect(state.uploads).toEqual([]);
});

test('a requested missing historical run never falls back to the current server draft',async({page})=>{
  const state=fixture();state.omitRequestedRun=true;await install(page,state);await page.goto(route('synthetic-missing-answer'));
  await expect(page.locator('#qa-document-body')).toBeVisible();
  await expect(page.locator('#qa-start')).toHaveCount(0);await expect(page.locator('#qa-save')).toHaveCount(0);await expect(page.locator('#qa-continue')).toHaveCount(0);
  await expect(page.locator('.qa-question-list')).toHaveCount(0);expect(workspaceReads(state).some(call=>new URLSearchParams(call.search).get('run_id')==='synthetic-missing-answer')).toBe(true);
  expect(writes(state)).toEqual([]);
});

test('opening the current preparation retains the selected draft without POST',async({page})=>{
  const state=await open(page,fixture(),prepareId),before=structuredClone(state.workspace.draft);
  await expect(page.locator('#qa-use-preparation')).toHaveCount(0);await expect.poll(()=>selectedIds(page)).toEqual(['q4']);
  await expect(page.locator('#qa-requirements')).toHaveValue(before.requirements);expect(state.workspace.draft).toEqual(before);expect(writes(state)).toEqual([]);
});

test('explicit confirmation sends only the exact selected draft and a 120-credit answer envelope, preserving history',async({page})=>{
  const state=await open(page),old=historicalRecords(state);await adopt(page);
  await expect(page.locator('.qa-start-summary')).toContainText('120');await expect(page.locator('.qa-start-summary')).toContainText('待补材料');expect(qaWrites(state)).toEqual([]);
  await page.locator('#qa-start').click();await expect.poll(()=>state.answers.length).toBe(1);
  expect(state.drafts).toEqual([{expected_revision:10,draft:preparedDraft()}]);expect(state.answers[0]).toEqual({request_id:expect.any(String),expected_revision:11,expected_points:2*PROJECT_QA_PRICE.points,price_version:PROJECT_QA_PRICE.version});
  expect(state.accepted.size).toBe(1);expect([...state.accepted.values()][0].run.manifest.questions).toEqual(missingQuestions());expect(historicalRecords(state)).toEqual(old);
  expect(state.prepares).toEqual([]);expect(state.uploads).toEqual([]);expect(state.calls.filter(call=>/\/download|\/bytes/.test(call.path))).toEqual([]);
});

test('all three selected questions, including missing answers, require a fresh 180-credit confirmation',async({page})=>{
  const state=await open(page);await page.locator('#qa-followup-all').click();await adopt(page);
  await expect(page.locator('.qa-start-summary')).toContainText('180');expect(qaWrites(state)).toEqual([]);
  await page.locator('#qa-start').click();await expect.poll(()=>state.answers.length).toBe(1);expect(state.answers[0].expected_points).toBe(3*PROJECT_QA_PRICE.points);
  expect(state.drafts[0].draft).toEqual(preparedDraft(questions,false));expect(state.prepares).toEqual([]);
});

test('supplement upload stays local until save or start and reuses prior material pins',async({page})=>{
  const state=await open(page);state.allowUploads=true;await adopt(page);await page.locator('#qa-supplement').setInputFiles({name:'合成补充说明.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic supplement, not a real PDF')});
  await expect.poll(()=>state.uploads.length).toBe(1);await expect.poll(()=>state.uploadBytes).toBe(1);await expect(page.locator('.qa-materials')).toContainText('合成补充说明.pdf');
  expect(qaWrites(state)).toEqual([]);await expect(page.locator('#qa-save')).toBeEnabled();await expect(page.locator('#qa-start')).toBeEnabled();
  await page.locator('#qa-save').click();await expect.poll(()=>state.drafts.length).toBe(1);
  const material=state.uploadMaterial!;expect(state.drafts[0].draft).toEqual({...preparedDraft(),materials:[oldMaterial,oldArtifact,{kind:'material',pin:{source_project_id:projectId,material_id:material.material_id,material_version:material.material_version,sha256:material.sha256}}]});
  expect(state.prepares).toEqual([]);expect(state.answers).toEqual([]);
});

test('cache persistence failure prevents sending a draft or answer POST',async({page})=>{
  const state=await open(page);await adopt(page);
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('Synthetic local storage failure','QuotaExceededError');};});
  await page.locator('#qa-save').click();await expect(page.locator('#project-qa-status')).not.toHaveText('');expect(qaWrites(state)).toEqual([]);expect(state.accepted.size).toBe(0);
});

for(const acceptance of ['before','after'] as const)test(`unknown answer ${acceptance} acceptance survives reopening and retries the complete original body with the same key`,async({page})=>{
  const state=await open(page),old=historicalRecords(state);await adopt(page);state.dropAnswer=acceptance;await start(page);
  await expect.poll(()=>state.answers.length).toBe(1);await expectPending(page,'answer');const envelope=structuredClone(state.answers[0]);
  expect(state.drafts).toHaveLength(1);expect(state.accepted.size).toBe(acceptance==='after'?1:0);await page.reload();await expectPending(page,'answer');
  expect(state.answers).toEqual([envelope]);expect(state.drafts).toHaveLength(1);await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.answers.length).toBe(2);
  await expect(page.locator('#qa-retry-pending')).toHaveCount(0);expect(state.answers).toEqual([envelope,envelope]);expect(state.accepted.size).toBe(1);expect(state.drafts).toHaveLength(1);
  expect(historicalRecords(state)).toEqual(old);expect(state.prepares).toEqual([]);expect(state.uploads).toEqual([]);
});

for(const acceptance of ['before','after'] as const)test(`unknown free preparation ${acceptance} acceptance reopens without upload or POST and retries the exact source body`,async({page})=>{
  const state=await open(page);state.allowUploads=true;state.dropPrepare=acceptance;await page.locator('#qa-upload').setInputFiles({name:'合成新问题清单.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic upload, not a real Word file')});
  await expect.poll(()=>state.prepares.length).toBe(1);await expectPending(page,'prepare');const envelope=structuredClone(state.prepares[0]);
  expect(envelope).toEqual({request_id:expect.any(String),source:{kind:'material',pin:{source_project_id:projectId,material_id:state.uploadMaterial!.material_id,material_version:1,sha256:state.uploadMaterial!.sha256}}});
  expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);await page.reload();await expectPending(page,'prepare');expect(state.prepares).toEqual([envelope]);expect(state.uploads).toHaveLength(1);
  await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.prepares.length).toBe(2);await expect(page.locator('#qa-retry-pending')).toHaveCount(0);
  expect(state.prepares).toEqual([envelope,envelope]);expect(state.accepted.size).toBe(1);expect(state.uploads).toHaveLength(1);expect(state.uploadBytes).toBe(1);expect(state.answers).toEqual([]);expect(state.drafts).toEqual([]);
});

test('unknown draft readback requires exactly expected revision plus one and every draft field before unfreezing',async({page})=>{
  const state=await open(page);await adopt(page);state.workspaceRead=structuredClone(state.workspace);state.dropDraft=true;await page.locator('#qa-save').click();
  await expect.poll(()=>state.drafts.length).toBe(1);await expectPending(page,'draft');const original=structuredClone(state.drafts[0]),accepted=structuredClone(state.workspace);
  state.workspaceRead={...structuredClone(accepted),revision:accepted.revision+1};await page.reload();await expectPending(page,'draft');expect(state.drafts).toEqual([original]);
  let reads=workspaceReads(state).length;await page.locator('#qa-refresh-pending').click();await expect.poll(()=>workspaceReads(state).length).toBeGreaterThan(reads);await expectPending(page,'draft');
  state.workspaceRead={...structuredClone(accepted),draft:{...structuredClone(accepted.draft),requirements:'另一个标签保存的不同完整草稿。'}};
  reads=workspaceReads(state).length;await page.locator('#qa-refresh-pending').click();await expect.poll(()=>workspaceReads(state).length).toBeGreaterThan(reads);await expectPending(page,'draft');
  await expect(page.locator('#qa-requirements')).toHaveValue(original.draft.requirements);state.workspaceRead=structuredClone(accepted);
  reads=workspaceReads(state).length;await page.locator('#qa-refresh-pending').click();await expect.poll(()=>workspaceReads(state).length).toBeGreaterThan(reads);await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',false);
  await expect(page.locator('#qa-save')).toBeEnabled();expect(state.drafts).toEqual([original]);expect(state.answers).toEqual([]);expect(state.prepares).toEqual([]);
});

test('local continuation recovery is isolated by project',async({page})=>{
  const state=await open(page);await adopt(page);await expectLocal(page);await page.goto(route(null,otherProjectId));await expect(page.getByRole('heading',{name:'上传问题清单',exact:true})).toBeVisible();await expect(page.locator('#qa-history')).toBeHidden();
  await expect(page.locator('#qa-requirements')).toHaveCount(0);await expect(page.locator('#qa-retry-pending')).toHaveCount(0);expect(writes(state)).toEqual([]);
  await page.goto(route(null));await expectLocal(page);expect(writes(state)).toEqual([]);
});

test('another account never receives the prior owner local draft or pending request',async({page})=>{
  const state=await open(page);await adopt(page);state.dropAnswer='after';await start(page);await expect.poll(()=>state.answers.length).toBe(1);await expectPending(page,'answer');
  state.owner=otherOwnerId;await page.reload();await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('#qa-requirements')).toHaveCount(0);await expect(page.locator('#qa-retry-pending')).toHaveCount(0);
  expect(state.answers).toHaveLength(1);expect(state.drafts).toHaveLength(1);
});

for(const code of ['CREDITS_INSUFFICIENT','INPUT_REVISION_CONFLICT','QUOTE_CHANGED'] as const)test(`definitive ${code} rejection preserves preparation and requires another explicit confirmation`,async({page})=>{
  const state=await open(page);await adopt(page);state.rejectAnswer=code;await start(page);await expect.poll(()=>state.answers.length).toBe(1);
  await expect(page.locator('#qa-retry-pending')).toHaveCount(0);await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',false);await expectLocal(page);expect(state.accepted.size).toBe(0);
  const modal=page.locator('.qa-modal[open]');if(await modal.isVisible())await modal.locator('[data-close]').click();
  await expect(page.locator('#qa-start')).toBeEnabled();expect(state.answers).toHaveLength(1);await expect(page.locator('.qa-start-summary')).toContainText('120');expect(state.answers).toHaveLength(1);
  await page.locator('#qa-start').click();await expect.poll(()=>state.answers.length).toBe(2);expect(state.accepted.size).toBe(1);expect(state.answers[1].expected_points).toBe(2*PROJECT_QA_PRICE.points);
});
