import {expect,test,type Locator,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {
  installSupplementHttp,mountSupplementSurface,supplementFixture,supplementIds,
  supplementPin,supplementHash,type SupplementSurface,
} from './run-supplement-fixture';

const panel=(page:Page)=>page.locator(`[data-run-supplement="${supplementIds.run}"]`);
const file=(name='补充审计证据.txt',text='synthetic supplement evidence')=>({name,mimeType:'text/plain',buffer:Buffer.from(text)});
const action=(host:Locator,name:string)=>host.locator(`[data-supplement-action="${name}"]`);
async function ready(page:Page){
  const host=panel(page);await expect(host).toBeVisible();
  // A paused flow may initially keep preparation in its native expandable section.
  const summary=host.locator('summary').first();if(await summary.count()&&!await summary.isVisible())await host.scrollIntoViewIfNeeded();
  if(await summary.count()){const details=summary.locator('..');if(await details.evaluate(e=>e.tagName==='DETAILS'&&!(e as HTMLDetailsElement).open))await summary.click();}
  await expect(host.locator('[data-supplement-file]')).toBeVisible();return host;
}
async function add(page:Page,name='补充审计证据.txt',text='synthetic supplement evidence'){
  const host=await ready(page);await host.locator('[data-supplement-intent]').selectOption('');
  await host.locator('[data-supplement-role]').selectOption('audit');
  await host.locator('[data-supplement-file]').setInputFiles(file(name,text));
  await expect(host).toContainText(name);await expect(action(host,'save')).toBeEnabled();return host;
}
async function remount(page:Page,s:ReturnType<typeof supplementFixture>,surface:SupplementSurface){await page.reload();await mountSupplementSurface(page,s,surface);return ready(page);}

for(const surface of ['m1','m3','m4'] as const)test(`desktop ${surface}: paused preparation uploads, saves, reloads and explicitly excludes supplements on original resume`,async({page})=>{
  const s=supplementFixture(),frozen=structuredClone({run:s.run,input:s.input,project:s.project,reviewDraft:s.review.draft,m4Drafts:s.m4.drafts});
  await installSupplementHttp(page,s);await mountSupplementSurface(page,s,surface);
  const host=await add(page);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);expect(s.completions).toHaveLength(1);
  expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);await expect(host).toContainText('尚未采用');
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);await expect(host).toContainText('草稿已保存');
  await expect(host.locator('[data-supplement-saved-work]')).toContainText('已记录暂停位置。继续时核对已有进度。');
  await expect(host.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
  await host.locator('[data-supplement-result] summary').click();
  await expect(host.locator('[data-supplement-result]')).toContainText('原冻结募集书.docx');
  await expect(host.locator('[data-supplement-result]')).toContainText('补充审计证据.txt');
  expect(s.saves[0]).toMatchObject({expected_revision:0,base_input_revision:7,base_input_hash:frozen.run.input_hash,changes:[{replaces:null}]});
  expect(s.saves[0].changes[0].material.sha256).toBe(supplementHash('synthetic supplement evidence'));
  expect({run:s.run,input:s.input,project:s.project,reviewDraft:s.review.draft,m4Drafts:s.m4.drafts}).toEqual(frozen);
  const restored=await remount(page,s,surface);await expect(restored).toContainText('补充审计证据.txt');await expect(restored).toContainText('尚未采用');
  expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
  await expect(restored.locator('[data-supplement-file]')).toBeEnabled();await expect(action(restored,'save')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.BB_SUPPLEMENT_EVIDENCE_DIR){await mkdir(process.env.BB_SUPPLEMENT_EVIDENCE_DIR,{recursive:true});await restored.scrollIntoViewIfNeeded();await page.screenshot({path:join(process.env.BB_SUPPLEMENT_EVIDENCE_DIR,`${surface}-saved-preparation.png`),fullPage:true});await page.screenshot({path:join(process.env.BB_SUPPLEMENT_EVIDENCE_DIR,`${surface}-saved-preparation-viewport.png`)});}
  const continueButton=surface==='m1'?page.locator('#resume-run'):surface==='m3'?page.locator('#review-making-panel [data-review-action="resume"]'):page.locator(`[data-m4-action="resume"][data-run="${s.run.run_id}"]`);
  await expect(continueButton).toContainText('按原材料继续');
  await continueButton.click();const confirm=page.locator('.run-supplement-resume-dialog');await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('原材料');await expect(confirm).toContainText('补料');expect(s.controls).toEqual([]);
  await confirm.locator('[data-supplement-resume-cancel]').click();expect(s.controls).toEqual([]);
  await continueButton.click();await confirm.locator('[data-supplement-resume-confirm]').click();
  await expect.poll(()=>s.controls).toEqual(['resume']);expect(s.saves).toHaveLength(1);expect(s.unexpectedMutations).toEqual([]);
  expect(s.run).toMatchObject({run_id:frozen.run.run_id,input_revision:7,input_hash:frozen.run.input_hash,execution_request_id:frozen.run.execution_request_id});
});

test('captured work discloses result references and hides old confirmation during local edits and unknown saves',async({page})=>{
  const s=supplementFixture();s.workStageCount=3;s.workResultCount=2;
  await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await ready(page);
  await expect(host.locator('[data-supplement-saved-work]')).toHaveCount(0);
  await add(page);await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);
  const work=host.locator('[data-supplement-saved-work]');
  await expect(work).toContainText('已关联 2 项已保存处理结果。继续前核对可复用文件。');
  await expect(action(host,'quote')).toBeEnabled();
  expect(s.receipts.get(s.saves[0].request_id)!.saved_work).toEqual({status:'captured',stage_count:3,result_count:2});
  await add(page,'新的待确认材料.txt','new synthetic evidence');
  await expect(work).toContainText('确认本次保存回执后再查看');await expect(work).not.toContainText('已关联 2 项');
  s.dropUnacceptedSaveOnce=true;await action(host,'save').click();await expect(action(host,'receipt')).toBeEnabled();
  await expect(work).toContainText('确认本次保存回执后再查看');await expect(work).not.toContainText('已关联 2 项');
  expect(s.revision).toBe(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
});

test('a changed pause boundary requires a new explicit save even when the material choices are unchanged',async({page})=>{
  const s=supplementFixture();s.workStageCount=2;s.workResultCount=1;
  await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const first=structuredClone(s.saves[0]);
  s.savedWork={status:'stale_boundary',stage_count:2,result_count:1};
  await action(host,'reload').click();const work=host.locator('[data-supplement-saved-work]');
  await expect(work).toContainText('暂停进度已有变化');await expect(work).toContainText('重新保存补料草稿，更新进度关联');
  await expect(work).not.toContainText('已关联 1 项');await expect(action(host,'save')).toBeEnabled();
  s.workStageCount=4;s.workResultCount=3;await action(host,'save').click();await expect.poll(()=>s.revision).toBe(2);
  await expect(work).toContainText('已关联 3 项已保存处理结果');await expect(work).not.toContainText('暂停进度已有变化');
  expect(s.saves).toHaveLength(2);expect(s.saves[1].request_id).not.toBe(first.request_id);
  expect(s.saves[1].expected_revision).toBe(1);expect(s.saves[1].changes).toEqual(first.changes);
  expect(s.uploads).toHaveLength(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
});

test('an old saved draft can capture work on a new save without changing its empty material selection',async({page})=>{
  const s=supplementFixture();s.revision=1;s.savedWork={status:'not_captured',stage_count:0,result_count:0};s.workStageCount=2;
  await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await ready(page),work=host.locator('[data-supplement-saved-work]');
  await expect(work).toContainText('旧补料草稿尚未记录进度');await expect(work).toContainText('请再次保存补料草稿');
  await expect(action(host,'save')).toBeEnabled();await action(host,'save').click();await expect.poll(()=>s.revision).toBe(2);
  await expect(work).toContainText('已记录暂停位置。继续时核对已有进度。');await expect(work).not.toContainText('尚未记录进度');
  expect(s.saves[0]).toMatchObject({expected_revision:1,changes:[]});
  expect(s.receipts.get(s.saves[0].request_id)!.saved_work).toEqual({status:'captured',stage_count:2,result_count:0});
  expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
});

test('saved material issues remain distinct from adoption, and local edits hide stale check results',async({page})=>{
  const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  const host=await add(page);await action(host,'save').click();await expect(host.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
  s.inputPreview={compiler_version:'run-supplement-input-v1',status:'needs_information',candidate_input_hash:null,
    issues:[{code:'source_information_required',material_id:null,message:'原稿信息需要重新填写。'}]};
  await action(host,'reload').click();await expect(host.locator('[data-supplement-input-preview]')).toContainText('原稿信息需要重新填写');
  await expect(host.locator('[data-supplement-input-preview]')).not.toContainText('材料关联已核对');
  await expect(host).toContainText('补料选择已保存');expect(s.controls).toEqual([]);expect(s.saves).toHaveLength(1);
  await add(page,'另一份补充证据.txt','Different synthetic bytes');
  await expect(host.locator('[data-supplement-input-preview]')).toContainText('请先保存并确认回执');
  await expect(host.locator('[data-supplement-input-preview]')).not.toContainText('原稿信息需要重新填写');
  expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
});

test('replacement source declarations start empty and survive source-only edits, an unknown receipt and refresh',async({page})=>{
  const s=supplementFixture(),old=s.materials[0];
  s.sourceContext={kind:'m1_authoring',previous_output_bound:true};
  s.project.update_details!.source_prospectuses=[{...supplementPin(old),issuer_name:'不得复制的旧原稿发行人',relation:'parent',market:'sse',offering:'private',
    reporting_periods:[{start:'2024-01-01',end:'2024-12-31',period_kind:'annual',scope:'parent',status:'user_asserted',evidence_refs:[]}],status:'user_asserted'}];
  const replacement={...old,material_version:2,upload_id:'synthetic-new-source-version',filename:'新版原稿.docx'};
  s.materials.push(replacement);s.changes=[{material:supplementPin(replacement),replaces:supplementPin(old)}];s.revision=1;
  await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  const host=await ready(page),source=host.locator('[data-supplement-source]');
  await expect(source.locator('[data-source-field="relation"]')).toHaveValue('');
  await expect(source.locator('[data-source-field="market"]')).toHaveValue('');
  await expect(source.locator('[data-source-field="quarter"]:checked')).toHaveCount(0);
  await expect(source).not.toContainText('不得复制的旧原稿发行人');
  await expect(source.locator('[data-supplement-discard-output]')).not.toBeChecked();
  const baseline=source.locator('.run-supplement-baseline-choice');
  const [labelBox,checkboxBox,textBox]=await Promise.all([baseline.boundingBox(),baseline.locator('input').boundingBox(),baseline.locator('span').boundingBox()]);
  expect(labelBox).not.toBeNull();expect(checkboxBox).not.toBeNull();expect(textBox).not.toBeNull();
  expect(checkboxBox!.width).toBeGreaterThanOrEqual(14);expect(checkboxBox!.width).toBeLessThanOrEqual(24);
  expect(checkboxBox!.height).toBeGreaterThanOrEqual(14);expect(checkboxBox!.height).toBeLessThanOrEqual(24);
  expect(textBox!.width).toBeGreaterThan(labelBox!.width/2);
  expect(textBox!.x).toBeGreaterThanOrEqual(checkboxBox!.x+checkboxBox!.width+4);
  await source.locator('[data-source-field="relation"]').selectOption('subsidiary');
  await source.locator('[data-source-field="market"]').selectOption('nafmii');
  await source.locator('[data-source-field="offering"]').selectOption('mtn');
  await source.locator('[data-source-field="year"]').selectOption('2025');
  // Source quarter radios are visually hidden; their visible labels are the user click targets.
  await source.locator('label.quarter').filter({hasText:'9月末'}).click();
  await expect(source.locator('[data-source-field="quarter"][value="09-30"]')).toBeChecked();
  await baseline.locator('span').click();await expect(source.locator('[data-supplement-discard-output]')).toBeChecked();
  await expect(source).toContainText('原稿信息已填写完整');await expect(action(host,'save')).toBeEnabled();
  expect(s.saves).toEqual([]);expect(s.changes[0].source_prospectus).toBeUndefined();
  const restored=await remount(page,s,'panel'),restoredSource=restored.locator('[data-supplement-source]');
  await expect(restoredSource.locator('[data-source-field="relation"]')).toHaveValue('subsidiary');
  await expect(restoredSource.locator('[data-source-field="offering"]')).toHaveValue('mtn');
  await expect(restoredSource.locator('[data-supplement-discard-output]')).toBeChecked();
  s.dropSaveOnce=true;s.failReceiptReads=true;await action(restored,'save').click();
  await expect(restored).toContainText('原保存结果尚未确认');await expect(restoredSource.locator('[data-source-field="relation"]')).toBeDisabled();
  expect(s.saves).toHaveLength(1);expect(s.saves[0].expected_revision).toBe(1);
  expect(s.saves[0].changes[0]).toMatchObject({material:supplementPin(replacement),replaces:supplementPin(old),discard_previous_output:true,
    source_prospectus:{...supplementPin(replacement),issuer_name:null,relation:'subsidiary',market:'nafmii',offering:'mtn',status:'user_asserted'}});
  expect(s.saves[0].changes[0].source_prospectus!.reporting_periods.map(p=>p.end)).toContain('2025-09-30');
  await remount(page,s,'panel');s.failReceiptReads=false;await action(panel(page),'receipt').click();
  await expect(panel(page)).toContainText('草稿已保存');expect(s.saves).toHaveLength(1);
  expect(s.changes).toEqual(s.saves[0].changes);expect(s.run.input_revision).toBe(7);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
});

test('new reference information edits retain their exact declaration through a CAS keep-local resolution',async({page})=>{
  const s=supplementFixture();s.sourceContext={kind:'m1_authoring',previous_output_bound:false};
  await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await ready(page);
  await host.locator('[data-supplement-role]').selectOption('reference');
  await host.locator('[data-supplement-file]').setInputFiles(file('新参考募集书.docx','Synthetic source bytes only'));
  const source=host.locator('[data-supplement-source]');await expect(source).toBeVisible();
  await expect(source.locator('[data-supplement-discard-output]')).toHaveCount(0);
  await source.locator('[data-source-field="relation"]').selectOption('similar_business');
  await source.locator('[data-source-field="market"]').selectOption('sse');
  await source.locator('[data-source-field="offering"]').selectOption('private');
  await source.locator('[data-source-field="year"]').selectOption('2024');
  await source.locator('label.quarter').filter({hasText:'年末'}).click();
  await expect(source.locator('[data-source-field="quarter"][value="12-31"]')).toBeChecked();
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);
  const first=structuredClone(s.saves[0]);
  await source.locator('[data-source-field="relation"]').selectOption('parent');await expect(action(host,'save')).toBeEnabled();
  s.revision=2;s.changes[0].source_prospectus!.relation='same_issuer';
  await action(host,'save').click();await expect(action(host,'keep-local')).toBeVisible();
  await action(host,'keep-local').click();
  await expect(source.locator('[data-source-field="relation"]')).toHaveValue('parent');
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(3);
  expect(s.saves[2].expected_revision).toBe(2);expect(s.saves[2].changes[0].material).toEqual(first.changes[0].material);
  expect(s.saves[2].changes[0].source_prospectus).toEqual({...first.changes[0].source_prospectus!,relation:'parent'});
  expect(s.saves[2].changes[0].discard_previous_output).toBeUndefined();expect(s.byteWrites).toBe(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
});

test('replacement intent keeps the frozen role, exact source pin and uploaded bytes separate from saving',async({page})=>{
  const s=supplementFixture();s.holdComplete=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  const host=await ready(page),audit=s.base[1],intent=host.locator('[data-supplement-intent]');
  const replacement=await intent.locator('option').filter({hasText:audit.filename}).getAttribute('value');expect(replacement).toBeTruthy();await intent.selectOption(replacement!);
  await expect(host.locator('[data-supplement-role]')).toHaveValue('audit');await expect(host.locator('[data-supplement-role]')).toBeDisabled();
  await host.locator('[data-supplement-file]').setInputFiles(file('替换审计报告.txt','synthetic replacement bytes'));
  await expect.poll(()=>s.byteWrites).toBe(1);await expect.poll(()=>s.completions.length).toBe(1);expect(s.materials).toHaveLength(2);expect(s.saves).toEqual([]);
  await expect(action(host,'save')).toBeDisabled();s.releaseComplete!();await expect(action(host,'save')).toBeEnabled();
  expect(s.uploads[0].role).toBe('audit');expect(s.controls).toEqual([]);expect(s.saves).toEqual([]);
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);
  expect(s.saves[0].changes).toEqual([{material:supplementPin(s.materials[2]),replaces:supplementPin(audit)}]);
  expect(s.receipts.get(s.saves[0].request_id)!.result_materials.map(m=>m.material_id)).toEqual([s.base[0].material_id,s.materials[2].material_id]);
  expect(s.input.material_versions).toEqual(s.base.map(supplementPin));expect(s.run.state).toBe('paused');expect(s.unexpectedMutations).toEqual([]);
});

test('unsaved completed upload and add intent survive reload without silently creating a draft revision',async({page})=>{
  const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);await add(page);
  const host=await remount(page,s,'panel');await expect(host).toContainText('补充审计证据.txt');expect(s.revision).toBe(0);expect(s.uploads).toHaveLength(1);expect(s.saves).toEqual([]);
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves[0].changes[0].replaces).toBeNull();expect(s.byteWrites).toBe(1);
});

test('CAS conflict preserves the local selection until the user chooses how to resolve it',async({page})=>{
  const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  s.revision=1;s.changes=[];await action(host,'save').click();await expect(action(host,'keep-local')).toBeVisible();
  await expect(host).toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);expect(s.saves[0].expected_revision).toBe(0);expect(s.revision).toBe(1);
  await action(host,'keep-local').click();expect(s.saves).toHaveLength(1);await expect(host).toContainText('补充审计证据.txt');
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(2);expect(s.saves).toHaveLength(2);
  expect(s.saves[1].expected_revision).toBe(1);expect(s.saves[1].request_id).not.toBe(s.saves[0].request_id);expect(s.saves[1].changes).toEqual(s.saves[0].changes);
  expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
});

test('CAS use-latest choice discards local choices only after explicit selection',async({page})=>{
  const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  s.revision=1;s.changes=[];await action(host,'save').click();await expect(action(host,'use-latest')).toBeVisible();await expect(host).toContainText('补充审计证据.txt');
  await action(host,'use-latest').click();await expect(host).not.toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);expect(s.revision).toBe(1);expect(s.materials).toHaveLength(3);
  const restored=await remount(page,s,'panel');await expect(restored).not.toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);
});

test('accepted PUT with a lost response is recovered by its exact receipt without a second save',async({page})=>{
  const s=supplementFixture();s.dropSaveOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const id=s.saves[0].request_id;
  await expect.poll(()=>s.reads.includes(id)).toBe(true);await expect(host).toContainText('草稿已保存');expect(s.saves).toHaveLength(1);
  expect(s.receipts.get(id)!.changes).toEqual(s.saves[0].changes);expect(s.run.state).toBe('paused');expect(s.controls).toEqual([]);
});

test('unaccepted PUT with a lost response retries the identical request only after receipt says not found',async({page})=>{
  const s=supplementFixture();s.dropUnacceptedSaveOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  await action(host,'save').click();await expect(action(host,'retry-save')).toBeVisible();
  // The pending controls render before fetch dispatch. Wait for the actual HTTP
  // boundary before asserting that the intentionally unaccepted PUT was sent.
  await expect.poll(()=>s.saves).toHaveLength(1);expect(s.revision).toBe(0);
  const original=structuredClone(s.saves[0]);await expect.poll(()=>s.reads.includes(original.request_id)).toBe(true);await expect(action(host,'retry-save')).toBeEnabled();
  await action(host,'retry-save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves).toEqual([original,original]);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
});

test('unknown save persists through refresh and reads the original receipt even when a newer revision exists',async({page})=>{
  const s=supplementFixture();s.dropSaveOnce=true;s.failReceiptReads=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const sent=structuredClone(s.saves[0]);await expect.poll(()=>s.reads.includes(sent.request_id)).toBe(true);
  s.revision=2;s.changes=[];s.failReceiptReads=false;const restored=await remount(page,s,'panel');
  await expect.poll(()=>s.reads.filter(id=>id===sent.request_id).length).toBeGreaterThan(1);expect(s.saves).toEqual([sent]);expect(s.revision).toBe(2);
  await expect(restored).toContainText('补充审计证据.txt');expect(s.receipts.get(sent.request_id)!.revision).toBe(1);expect(s.controls).toEqual([]);
});

test('server can_save prevents a save while still showing the exact frozen base and explicit blocked reason',async({page})=>{
  const s=supplementFixture();s.canSave=false;s.blockedReason='正在核对上次模型调用，暂停完成后才能保存补料。';
  await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=panel(page);await expect(host).toBeVisible();await expect(host).toContainText(s.blockedReason);
  await expect(action(host,'save')).toBeDisabled();expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);
});

test('a lost upload completion receipt is recovered before saving the preparation without resending bytes',async({page})=>{
  const s=supplementFixture();s.dropCompleteOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  const host=await ready(page);await host.locator('[data-supplement-role]').selectOption('audit');await host.locator('[data-supplement-file]').setInputFiles(file());
  await expect.poll(()=>s.completions.length).toBe(1);await expect(action(host,'upload-resume')).toBeEnabled();expect(s.saves).toEqual([]);await expect(action(host,'save')).toBeDisabled();
  await action(host,'upload-resume').click();await expect(action(host,'save')).toBeEnabled();expect(s.completions).toHaveLength(2);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
});

test('an upload completion after leaving its owner/run surface cannot attach or save to the new view',async({page})=>{
  const s=supplementFixture();s.holdComplete=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  const host=await ready(page);await host.locator('[data-supplement-role]').selectOption('audit');await host.locator('[data-supplement-file]').setInputFiles(file());
  await expect.poll(()=>typeof s.releaseComplete).toBe('function');
  await page.evaluate(()=>{const holder=window as unknown as {supplementActive:boolean;supplementComponent:{dispose():void}};holder.supplementActive=false;holder.supplementComponent.dispose();document.querySelector('.shell')!.innerHTML='<h1>另一账号的任务</h1>';});
  s.releaseComplete!();await expect(page.getByRole('heading',{name:'另一账号的任务'})).toBeVisible();await expect(panel(page)).toHaveCount(0);
  expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);expect(s.revision).toBe(0);
});

test('mismatched exact receipt keeps the original request pending and prevents original-material resume until verified',async({page})=>{
  const s=supplementFixture();s.dropSaveOnce=true;s.receiptMismatchOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s,'m1');
  const host=await add(page);await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const sent=structuredClone(s.saves[0]);
  await expect(host).toContainText('回执与本轮原始输入或原保存请求不一致');await expect(host.locator('[data-supplement-saved]')).not.toContainText('草稿已保存');
  await expect(action(host,'receipt')).toBeEnabled();expect(s.saves).toEqual([sent]);expect(s.reads).toContain(sent.request_id);
  await page.locator('#resume-run').click();await expect(host).toContainText('请先核对原补料保存回执');expect(s.controls).toEqual([]);await expect(page.locator('.run-supplement-resume-dialog')).toHaveCount(0);
  await action(host,'receipt').click();await expect(host.locator('[data-supplement-saved]')).toContainText('草稿已保存');await expect(action(host,'receipt')).toHaveCount(0);
  expect(s.saves).toEqual([sent]);expect(s.reads.filter(id=>id===sent.request_id)).toHaveLength(2);expect(s.controls).toEqual([]);
});

test('a delayed availability GET from V0 cannot offer an older draft after save confirms V1',async({page})=>{
  const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);s.holdDraftRead=true;
  await page.evaluate(run=>{const component=(window as unknown as {supplementComponent:{updateRun(run:unknown):void}}).supplementComponent;component.updateRun({...run,state:'running'});component.updateRun(run);},s.run);
  await expect.poll(()=>typeof s.releaseDraftRead).toBe('function');await action(host,'save').click();await expect(host.locator('[data-supplement-saved]')).toContainText('V1');
  const delayed=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/supplement-draft')&&!new URL(response.url()).search&&response.request().method()==='GET');
  s.releaseDraftRead!();await (await delayed).finished();await page.evaluate(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});
  await expect(host.locator('[data-supplement-saved]')).toContainText('V1');await expect(host.locator('.run-supplement-conflict')).toHaveCount(0);
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).expected_revision,`bondbuddy:run-supplement:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`)).toBe(1);
  expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
});

test('failure reading a newer draft does not turn an already verified original save receipt back into unknown',async({page})=>{
  const s=supplementFixture();s.dropSaveOnce=true;s.failReceiptReads=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const sent=s.saves[0];await expect.poll(()=>s.reads.includes(sent.request_id)).toBe(true);await expect(action(host,'receipt')).toBeEnabled();
  s.revision=2;s.changes=[];s.failReceiptReads=false;s.failLatestReads=true;await action(host,'receipt').click();
  await expect(host.locator('[data-supplement-saved]')).toContainText('V1');await expect(host.locator('[data-supplement-saved]')).toContainText('草稿已保存');
  await expect(action(host,'receipt')).toHaveCount(0);await expect(action(host,'retry-save')).toHaveCount(0);await expect(host).not.toContainText('原保存结果尚未确认');
  expect(s.saves).toEqual([sent]);expect(s.controls).toEqual([]);
});
