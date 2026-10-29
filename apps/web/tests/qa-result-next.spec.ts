import {expect,test,type Locator,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PROJECT_QA_PRICE} from '@bondbuddy/contracts';
import {answerId,historicalRecords,oldArtifact,oldMaterial,otherAnswerId,prepareId,projectId,qaWrites,questions,snapshot,workspaceReads,writes} from './project-qa-continuation-fixtures';
import {assertFixture,fixture,historical,install,mime,mixedMissingHistory,progress,registerWord,route,word,type State} from './qa-result-next-fixtures';
import {docx,downloadBytes,hash} from './word-roundtrip-fixtures';
import {installQaResultNextReference} from './qa-result-next-reference';

// Desktop only. These public HTTP/OOXML fixtures verify navigation and exact
// synthetic bytes, not real Word formatting, model output, storage or billing.
const overview=(page:Page)=>page.locator('.qa-result-overview');
const follow=(page:Page,id:string)=>page.locator(`[data-qa-followup][value="${id}"]`);
const answer=(page:Page,id:string)=>page.locator(`details[data-qa-answer-question="${id}"]`);
const selected=(page:Page)=>page.locator('[data-qa-followup]:checked').evaluateAll(nodes=>nodes.map(node=>(node as HTMLInputElement).value));
const preparedIds=(page:Page)=>page.locator('[data-remove-q]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.removeQ));
test.beforeEach(async({page})=>{await page.setViewportSize({width:1440,height:900});page.on('dialog',dialog=>void dialog.accept());});
test.afterEach(async({page})=>{await assertFixture(page);});

async function open(page:Page,s=fixture(),run=answerId){await install(page,s);await page.goto(route(run));await expect(page.locator('#qa-history')).toHaveValue(run);if(await page.locator('.qa-followup').count())await page.locator('.qa-followup>summary').click();return s;}
async function cache(page:Page){return page.evaluate(()=>({
  local:Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const key=localStorage.key(i)!;return [key,localStorage.getItem(key)];})),
  session:Object.fromEntries(Array.from({length:sessionStorage.length},(_,i)=>{const key=sessionStorage.key(i)!;return [key,sessionStorage.getItem(key)];}))
}));}
async function navigationSnapshot(page:Page,s:State){return {hash:await page.evaluate(()=>location.hash),selected:await selected(page),cache:await cache(page),
  draft:structuredClone(s.workspace.draft),revision:s.workspace.revision,writes:structuredClone(writes(s))};}
async function withinViewport(locator:Locator){await expect.poll(()=>locator.evaluate(node=>{const r=node.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);}
async function isOpen(locator:Locator){return locator.evaluate(node=>(node as HTMLDetailsElement).open);}
async function adopt(page:Page){if(await page.locator('.qa-followup').getAttribute('open')===null)await page.locator('.qa-followup>summary').click();await page.locator('#qa-continue').click();await expect(page.locator('#qa-requirements')).toBeVisible();}
async function start(page:Page){await page.locator('#qa-start').click();}
async function download(page:Page){const pending=page.waitForEvent('download');await page.locator('#qa-download').click();const receipt=await pending;return {filename:receipt.suggestedFilename(),bytes:await downloadBytes(receipt)};}
async function exactWord(page:Page,s:State,runId:string){
  const expected=word(s,runId),receipt=await download(page);expect(receipt.filename).toBe(expected.metadata.filename);expect(receipt.bytes).toEqual(expected.bytes);
  expect(hash(receipt.bytes)).toBe(expected.metadata.sha256);expect(receipt.bytes.subarray(0,4)).toEqual(Buffer.from([0x50,0x4b,0x03,0x04]));
  expect(receipt.bytes.toString('utf8')).toContain(expected.payload);expect(expected.metadata.run_id).toBe(runId);expect(expected.metadata.artifact_id).toBe(historical(s,runId).artifact_id);
  return receipt;
}

test('qa result next: valid missing summary follows original order and both long-result navigations preserve preparation through live polling',async({page})=>{
  test.setTimeout(30000);const s=fixture();mixedMissingHistory(s);const active=structuredClone(historical(s,otherAnswerId));
  active.run_id='synthetic-qa-background-active-12';active.sequence=12;active.state='running';active.stage='model_generation';active.result=null;active.artifact_id=null;active.reserved_points=active.manifest.points;active.charged_points=0;s.workspace.runs.unshift(active);
  await open(page,s);await expect(overview(page)).toHaveAttribute('data-qa-result-run',answerId);await expect(overview(page)).toContainText('原题 3 个');
  await expect(overview(page)).toContainText('已有处理结果 2 个');await expect(overview(page)).toContainText('待补材料 / 未回答 3 个');
  expect((await overview(page).boundingBox())!.y).toBeLessThan((await answer(page,'q4').boundingBox())!.y);
  // Answer rows are deliberately reversed. A draft with missing materials and
  // an unanswered original question both belong to valid missingIds.
  expect(await answer(page,'q4').getAttribute('data-qa-answer-run')).toBe(answerId);await follow(page,'q4').uncheck();
  if(await isOpen(answer(page,'q2')))await answer(page,'q2').locator('summary').click();
  const alignmentReads=workspaceReads(s).length;await expect.poll(()=>workspaceReads(s).length,{timeout:7500}).toBeGreaterThan(alignmentReads);
  const before=await navigationSnapshot(page,s);await page.locator('#qa-view-missing').click();await expect(answer(page,'q2').locator('summary')).toBeFocused();
  await expect(answer(page,'q2').locator('summary')).not.toHaveAttribute('tabindex','-1');await withinViewport(answer(page,'q2').locator('summary'));
  expect(await isOpen(answer(page,'q2'))).toBe(true);expect(await isOpen(answer(page,'q4'))).toBe(true);expect(await navigationSnapshot(page,s)).toEqual(before);
  await page.locator('#qa-prepare-next').click();await expect(page.locator('#qa-followup-heading')).toBeFocused();await expect(page.locator('#qa-followup-heading')).toHaveAttribute('tabindex','-1');await withinViewport(page.locator('#qa-followup-heading'));
  expect(await navigationSnapshot(page,s)).toEqual(before);const firstReads=workspaceReads(s).length;await page.waitForTimeout(3400);expect(workspaceReads(s).length).toBeGreaterThan(firstReads);expect(await isOpen(answer(page,'q4'))).toBe(true);
  await page.locator('#qa-prepare-next').focus();await page.keyboard.press('Tab');await expect(answer(page,'q4').locator('summary')).toBeFocused();await page.keyboard.press('Enter');
  expect(await isOpen(answer(page,'q4'))).toBe(false);const nextReads=workspaceReads(s).length;await page.waitForTimeout(3400);
  expect(workspaceReads(s).length).toBeGreaterThan(nextReads);expect(await isOpen(answer(page,'q4'))).toBe(false);expect(await navigationSnapshot(page,s)).toEqual(before);expect(writes(s)).toEqual([]);
});

test('qa result next: first unanswered original question focuses its own selection row without selecting it or borrowing a later answer',async({page})=>{
  const s=fixture();mixedMissingHistory(s,true);await open(page,s);await expect(answer(page,'q2')).toHaveCount(0);await follow(page,'q2').uncheck();const before=await navigationSnapshot(page,s);
  await page.locator('#qa-view-missing').click();await expect(follow(page,'q2')).toBeFocused();await withinViewport(follow(page,'q2'));await expect(follow(page,'q2')).not.toBeChecked();
  expect(await isOpen(answer(page,'q4'))).toBe(true);expect(await isOpen(answer(page,'q7'))).toBe(true);expect(await navigationSnapshot(page,s)).toEqual(before);
  await expect(page.locator('#qa-history')).toHaveValue(answerId);expect(writes(s)).toEqual([]);
});

test('qa result next: no missing work has no missing shortcut, while invalid follow-up reports unverifiable scope and blocks navigation or adoption',async({page})=>{
  const s=fixture(),r=historical(s);for(const item of r.result!.answers){item.status='draft';item.missing_materials=[];}registerWord(s);await open(page,s);
  await expect(overview(page)).toContainText('待补材料 / 未回答 0 个');await expect(page.locator('#qa-view-missing')).toHaveCount(0);await expect(page.locator('#qa-prepare-next')).toBeEnabled();
  const before=await navigationSnapshot(page,s);await page.locator('#qa-prepare-next').click();await expect(page.locator('#qa-followup-heading')).toBeFocused();expect(await navigationSnapshot(page,s)).toEqual(before);
  // A duplicate answer ID is schema-valid but fails the existing follow-up
  // correspondence guard; it must not be described as zero pending work.
  r.result!.answers.push(structuredClone(r.result!.answers[0]));registerWord(s);await page.reload();await expect(page.locator('#qa-history')).toHaveValue(answerId);
  await expect(overview(page)).toContainText('待补范围无法核实');await expect(overview(page)).not.toContainText('待补材料 / 未回答 0 个');await expect(overview(page)).not.toContainText('原题 3 个');
  await expect(page.locator('#qa-view-missing')).toHaveCount(0);await expect(page.locator('#qa-prepare-next')).toBeDisabled();await expect(page.locator('.qa-followup fieldset')).toHaveJSProperty('disabled',true);await expect(page.locator('#qa-continue')).toBeDisabled();
  const invalid=await navigationSnapshot(page,s);await page.locator('#qa-prepare-next').dispatchEvent('click');await page.locator('#qa-continue').dispatchEvent('click');
  expect(await navigationSnapshot(page,s)).toEqual(invalid);await expect(page.locator('#qa-requirements')).toHaveCount(0);expect(writes(s)).toEqual([]);
});

test('qa result next: exact historical questions, supplement and 120-credit confirmation progress to new and old synthetic Word without merging rounds',async({page})=>{
  test.setTimeout(45000);const s=await open(page),old=historicalRecords(s),serverDraft=structuredClone(s.workspace.draft),originalWord=word(s).bytes;
  await page.locator('#qa-view-missing').click();await page.locator('#qa-prepare-next').click();await expect.poll(()=>selected(page)).toEqual(['q2','q7']);expect(writes(s)).toEqual([]);
  await adopt(page);expect(await preparedIds(page)).toEqual(['q2','q7']);expect(s.workspace.draft).toEqual(serverDraft);await expect(page.locator('[data-qa-knowledge-choice]')).toHaveCount(0);await expect(page.locator('[data-qa-knowledge-choice]')).toHaveCount(0);
  const requirements=historical(s).manifest.requirements;await expect(page.locator('#qa-requirements')).toHaveValue(requirements);s.allowUploads=true;
  const supplement=docx('合成补充材料：本轮仍需人工核对偿债资金和关联交易依据。');
  await page.locator('#qa-supplement').setInputFiles({name:'合成问答续轮补充.docx',mimeType:mime,buffer:supplement});await expect.poll(()=>s.uploads.length).toBe(1);await expect.poll(()=>s.uploadBytes).toBe(1);await expect(page.locator('.qa-materials')).toContainText('合成问答续轮补充.docx');
  expect(qaWrites(s)).toEqual([]);await expect(page.locator('#qa-start')).toBeEnabled();
  await expect(page.locator('.qa-start-summary')).toContainText('120');expect(qaWrites(s)).toEqual([]);await page.locator('#qa-start').click();await expect.poll(()=>s.answers.length).toBe(1);
  const uploaded=s.uploadMaterial!,material={kind:'material' as const,pin:{source_project_id:projectId,material_id:uploaded.material_id,material_version:uploaded.material_version,sha256:uploaded.sha256}};
  expect(s.drafts).toEqual([{expected_revision:10,draft:{preparation_id:prepareId,questions:[questions[0],questions[2]],materials:[oldMaterial,oldArtifact,material],requirements,use_knowledge:false}}]);
  expect(s.answers[0]).toEqual({request_id:expect.any(String),expected_revision:11,expected_points:2*PROJECT_QA_PRICE.points,price_version:PROJECT_QA_PRICE.version});
  const accepted=[...s.accepted.values()][0],newRun=accepted.run.run_id;await expect(page.locator('#qa-history')).toHaveValue(newRun);await expect(page.locator('.qa-run-head')).toContainText('排队中');await expect(page.locator('#qa-download')).toHaveCount(0);await expect(page.locator('#qa-prepare-next')).toHaveCount(0);
  progress(s,'running');await expect(page.locator('.qa-run-head')).toContainText('处理中',{timeout:7500});expect(s.words.downloads).toEqual([]);expect(s.answers).toHaveLength(1);
  progress(s,'succeeded');await expect(page.locator('#qa-download')).toBeVisible({timeout:7500});const generated=await exactWord(page,s,newRun),newWord=word(s,newRun);
  expect(newWord.payload).toContain(accepted.generic.input_hash);expect(newWord.payload).toContain(uploaded.sha256);expect(newWord.payload).toContain(requirements);
  for(const span of snapshot.spans)expect(newWord.payload).toContain(span.text.replaceAll('\n','\\n'));
  expect(JSON.parse(newWord.payload).selected_questions).toEqual([questions[0],questions[2]]);expect(JSON.parse(newWord.payload).original_question_list).toHaveLength(snapshot.spans.length);
  expect(hash(generated.bytes)).not.toBe(hash(originalWord));await page.locator('#qa-history').selectOption(answerId);await expect(page.locator('#qa-history')).toHaveValue(answerId);const prior=await exactWord(page,s,answerId);expect(prior.bytes).toEqual(originalWord);
  expect(s.words.metadata).toEqual([newWord.artifact_id,word(s).artifact_id]);expect(s.words.downloads).toEqual([newWord.artifact_id,word(s).artifact_id]);expect(historicalRecords(s)).toEqual(old);expect(s.prepares).toEqual([]);expect(s.answers).toHaveLength(1);
  const writesBefore=writes(s).length;await page.locator('#qa-prepare-next').click();await expect(page.locator('#qa-followup-heading')).toBeFocused();expect(writes(s)).toHaveLength(writesBefore);
});

test('qa result next: mismatched artifact ID and run ID both reject bytes for the selected old round, and an explicit history change downloads its own Word',async({page})=>{
  const s=await open(page),downloads:string[]=[];page.on('download',item=>downloads.push(item.suggestedFilename()));
  for(const fault of ['artifact_id','run_id'] as const){
    s.words.fault=fault;const metadata=s.words.metadata.length;await page.locator('#qa-download').click();await expect.poll(()=>s.words.metadata.length).toBe(metadata+1);await expect(page.locator('#qa-download')).toBeEnabled();
    await expect(page.locator('#project-qa-status')).toContainText('当前回填 Word 与所选问答任务的对应关系无法核实');
    expect(s.words.downloads).toEqual([]);expect(downloads).toEqual([]);await expect(page.locator('#qa-history')).toHaveValue(answerId);
  }
  s.words.fault=undefined;const old=await exactWord(page,s,answerId);await page.locator('#qa-history').selectOption(otherAnswerId);await expect(page.locator('#qa-history')).toHaveValue(otherAnswerId);const latest=await exactWord(page,s,otherAnswerId);
  expect(hash(old.bytes)).not.toBe(hash(latest.bytes));expect(s.words.metadata).toEqual([word(s).artifact_id,word(s).artifact_id,word(s).artifact_id,word(s,otherAnswerId).artifact_id]);
  expect(s.words.downloads).toEqual([word(s).artifact_id,word(s,otherAnswerId).artifact_id]);expect(writes(s)).toEqual([]);
});

test('qa result next: busy navigation cannot adopt or move, and an unknown answer receipt retains the original locked preparation',async({page})=>{
  const s=await open(page);s.words.holdMetadata=true;const pending=page.waitForEvent('download');await page.locator('#qa-download').click();await expect.poll(()=>s.words.held.length).toBe(1);
  const held=s.words.held[0];try{
    await expect(page.locator('#qa-view-missing')).toBeDisabled();await expect(page.locator('#qa-prepare-next')).toBeDisabled();await expect(page.locator('#qa-continue')).toBeDisabled();const before=await navigationSnapshot(page,s),scroll=await page.evaluate(()=>scrollY);
    await page.locator('#qa-view-missing').dispatchEvent('click');await page.locator('#qa-prepare-next').dispatchEvent('click');await page.locator('#qa-continue').dispatchEvent('click');
    expect(await navigationSnapshot(page,s)).toEqual(before);expect(await page.evaluate(()=>scrollY)).toBe(scroll);await expect(page.locator('#qa-requirements')).toHaveCount(0);held.release();expect(await downloadBytes(await pending)).toEqual(word(s).bytes);
  }finally{held.release();}
  await expect(page.locator('#qa-prepare-next')).toBeEnabled();await adopt(page);s.dropAnswer='after';await start(page);await expect(page.locator('#qa-retry-pending')).toBeVisible();
  const body=structuredClone(s.answers[0]),draft=structuredClone(s.drafts[0]);await page.goto(route(answerId));await expect(page.locator('#qa-retry-pending')).toBeVisible();
  await expect(page.locator('#qa-history')).toBeDisabled();await expect(page.locator('#qa-start')).toBeDisabled();await expect(page.locator('#qa-prepare-next')).toHaveCount(0);await expect(page.locator('#qa-view-missing')).toHaveCount(0);await expect(page.locator('#qa-continue')).toHaveCount(0);
  await expect(page.locator('#qa-preparation-controls')).toHaveJSProperty('disabled',true);await page.waitForTimeout(3400);expect(s.answers).toEqual([body]);expect(s.drafts).toEqual([draft]);expect(s.accepted.size).toBe(1);expect(s.prepares).toEqual([]);
});

test('qa result next desktop component comparison at 1440px uses identical long results and next-preparation position',async({page})=>{
  const reference=process.env.BB_QA_RESULT_REFERENCE==='1',verify=reference?await installQaResultNextReference(page):undefined,s=await open(page),dir=process.env.BB_QA_RESULT_EVIDENCE_DIR??process.env.BB_UX_EVIDENCE_DIR??test.info().outputPath('component-capture');
  await mkdir(dir,{recursive:true});const before=await navigationSnapshot(page,s);
  const capture=async(name:string,action:string)=>{
    const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollY,scrollWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,
      text:document.body.innerText,activeId:(document.activeElement as HTMLElement|null)?.id??null,overview:document.querySelector('.qa-result-overview')?.textContent??null,
      nextButtons:document.querySelectorAll('#qa-prepare-next').length}));
    expect(layout.scrollWidth).toBeLessThanOrEqual(1441);await page.screenshot({path:join(dir!,`qa-result-next-${name}-1440.png`),fullPage:name==='long-result'});
    await writeFile(join(dir!,`qa-result-next-${name}-1440.json`),JSON.stringify({...layout,reference,action,run:answerId,selection:await selected(page),writes:writes(s)},null,2));
  };
  await page.evaluate(()=>scrollTo(0,0));await capture('long-result','initial selected historical result');
  if(reference)await page.locator('.qa-followup>h3').evaluate(node=>node.scrollIntoView({block:'start'}));
  else{await page.locator('#qa-prepare-next').click();await expect(page.locator('#qa-followup-heading')).toBeFocused();await withinViewport(page.locator('#qa-followup-heading'));}
  await capture('next-preparation',reference?'manual scroll to existing follow-up heading':'click read-only prepare-next navigation');expect(await navigationSnapshot(page,s)).toEqual(before);expect(writes(s)).toEqual([]);
  if(verify)await writeFile(join(dir!,`qa-result-next-reference-1440.json`),JSON.stringify(await verify(),null,2));
});
