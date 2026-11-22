import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import type {ProspectusVersion} from '@bondbuddy/contracts';
import {fixture,open,ready,upload,reenter,history,version,review,projection,currentSource,writes,fixedSnapshot,fixedUnchanged,
  uploadJournal,verifyInstalled,noBusiness,hash,ids,oldBytes,newBytes,type State} from './prospectus-saved-reentry-fixtures';
import {captureProspectusSavedReentry,installProspectusSavedReentryReference} from './prospectus-saved-reentry-reference';

// Native main.ts routes with one synthetic HTTP state, real OOXML bytes and
// public schemas. No live service, worker, Word/WPS or ledger acceptance claim.
const reference=!!process.env.BB_PROSPECTUS_REFERENCE_DIR;
const notice=(page:Page)=>page.locator('[data-prospectus-saved-notice]');
const state=(page:Page,id:string)=>version(page,id).locator('[data-prospectus-selection-state]');
const panel=(page:Page)=>page.locator('.prospectus-panel');
async function exactReference(page:Page,v:ProspectusVersion){
  const ref=version(page,v.version_id).locator('details[data-prospectus-ref]');
  if(await ref.getAttribute('open')===null)await ref.locator(':scope > summary').click();
  await expect(ref).toHaveAttribute('open','');await expect(ref.locator('button,input,select,textarea')).toHaveCount(0);
  const fields=[['记录所属项目',ids.source],['版本记录',v.version_id],['版本序号','V'+v.sequence],['文件校验值 SHA-256',v.sha256],
    ...(v.material_id?[['材料编号',v.material_id],['材料版本',String(v.material_version)]]:[['成果编号',v.artifact_id!],['成果版本',String(v.artifact_version)]]),
    ...(v.run_id?[['来源任务',v.run_id]]:[])];
  for(const [label,value] of fields)await expect(ref.locator('dl > div').filter({has:page.getByText(label!,{exact:true})}).locator('dd')).toHaveText(value!);
  return ref;
}
async function cancelAdoption(page:Page,s:State){
  const before=structuredClone(writes(s)),source=projection(s),project=structuredClone(s.project);
  await version(page,s.candidate.version_id).locator('[data-use-version]').click();
  const dialog=page.getByRole('dialog',{name:'采用这版募集书？',exact:true});await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('V'+s.candidate.sequence+' · '+s.candidate.filename);await expect(dialog).toContainText('已有任务保留原依据');await expect(dialog).toContainText('不启动付费更新');
  expect(writes(s)).toEqual(before);await dialog.locator('#cancel-prospectus-selection').click();await expect(dialog).toHaveCount(0);
  expect(writes(s)).toEqual(before);expect(projection(s)).toEqual(source);expect(s.project).toEqual(project);
}
async function confirmAdoption(page:Page,s:State){
  const revision=s.versions.selection_revision,draftRevision=s.project.draft_revision;
  await version(page,s.candidate.version_id).locator('[data-use-version]').click();
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/projects/'+ids.source+'/prospectus-versions/current');
  await page.locator('#confirm-prospectus-selection').click();const result=await response;expect(result.ok()).toBe(true);expect(await result.finished()).toBeNull();
  await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(panel(page).locator('header')).toContainText('项目当前稿：V'+s.candidate.sequence+' · '+s.candidate.filename);
  expect(s.selections).toHaveLength(1);expect(s.selections[0]).toEqual({request_id:expect.any(String),expected_selection_revision:revision,version_id:s.candidate.version_id});expect(s.selections[0].request_id.length).toBeGreaterThan(0);
  expect(s.appliedSelections).toBe(1);expect(s.receipts.size).toBe(1);expect(s.versions.selection_revision).toBe(revision+1);expect(s.project.draft_revision).toBe(draftRevision+1);
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);}
async function downloadBytes(page:Page,id:string){const pending=page.waitForEvent('download');await version(page,id).locator('[data-download-version]').click();const file=await pending;expect(await file.failure()).toBeNull();const path=await file.path();expect(path).not.toBeNull();return readFile(path!);}
const audit=(s:State,action:string)=>({synthetic:true,action,source:currentSource(s),versions:projection(s),http:structuredClone(s.calls),writes:structuredClone(writes(s)),selections:structuredClone(s.selections),selection_applications:s.appliedSelections,original_fixed_input_sha256:hash(JSON.stringify(s.workspace.tasks)),balance:s.balance,
  limits:'Actual native main route and synthetic owner-scoped HTTP only. No real storage, model, fees, worker, Word/WPS or overall professional acceptance.'});
async function captureCurrent(page:Page,s:State,name:string,action:string){const output=process.env.BB_PROSPECTUS_CAPTURE_DIR;if(output){await page.locator('#pw-prospectus').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));await captureProspectusSavedReentry(page,output,'prospectus-saved-reentry-current-'+name,audit(s,action));}}

test.afterEach(async({page})=>verifyInstalled(page));
test.describe('prospectus saved reentry native desktop journeys',()=>{
  test.skip(reference,'Exact R42 reference collects its available native actions separately.');

  test('saved prospectus reentry: upload V2, leave through all projects, return through the real project title, review and cancel without writes, then explicitly adopt once and reload',async({page})=>{
    const s=await open(page),fixed=fixedSnapshot(s),project=structuredClone(s.project),originalSource=currentSource(s);
    await expect(panel(page).locator('header')).toContainText('项目当前稿：V1');await expect(notice(page)).toHaveCount(0);
    await upload(page,s);const savedWrites=structuredClone(writes(s));expect(savedWrites.map(c=>c.method)).toEqual(['POST','PUT','POST']);expect(s.selections).toEqual([]);expect(s.project).toEqual(project);expect(currentSource(s)).toEqual(originalSource);expect(s.versions.selection_revision).toBe(7);expect(await uploadJournal(page)).toEqual({});
    await captureCurrent(page,s,'saved-1440','Upload completion and exact version registration are confirmed; V1 remains current and selection has not been requested.');
    await reenter(page);await expect(notice(page)).toBeVisible();await expect(history(page)).not.toHaveAttribute('open','');await expect(panel(page).locator('header')).toContainText('项目当前稿：V1');expect(currentSource(s)).toEqual(originalSource);expect(writes(s)).toEqual(savedWrites);expect(s.project).toEqual(project);expect(await uploadJournal(page)).toEqual({});
    await captureCurrent(page,s,'reentered-1440','Native all-projects title reopens the project; server-retained V2 is discoverable while V1 stays current, without an upload recovery envelope.');
    await review(page);await expect(state(page,s.candidate.version_id)).toHaveText('已保存，未设为项目当前稿');await expect(state(page,s.old.version_id)).toHaveText('项目当前稿');await exactReference(page,s.candidate);expect(writes(s)).toEqual(savedWrites);fixedUnchanged(s,fixed);
    await captureCurrent(page,s,'history-1440','Explicit read-only review opens version history and complete exact references.');await cancelAdoption(page,s);expect(s.selections).toEqual([]);fixedUnchanged(s,fixed);
    await confirmAdoption(page,s);await expect(notice(page)).toHaveCount(0);expect(s.files.every(f=>f.consistency.status==='stale')).toBe(true);expect(currentSource(s)).toEqual({project_id:ids.source,version_id:s.candidate.version_id,selection_revision:8,filename:s.candidate.filename,sequence:2,asset:{kind:'material',pin:{source_project_id:ids.source,material_id:s.candidate.material_id,material_version:s.candidate.material_version,sha256:s.candidate.sha256}}});
    const adoptedWrites=structuredClone(writes(s));expect(adoptedWrites).toHaveLength(4);await page.reload();await ready(page);await expect(panel(page).locator('header')).toContainText('项目当前稿：V2');await expect(notice(page)).toHaveCount(0);expect(writes(s)).toEqual(adoptedWrites);expect(s.selections).toHaveLength(1);fixedUnchanged(s,fixed);await noOverflow(page);
  });

  test('saved prospectus reentry: a first saved version remains without a current selection across native project reentry',async({page})=>{
    const s=await open(page,fixture({noCurrent:true})),fixed=fixedSnapshot(s),project=structuredClone(s.project);await upload(page,s);await reenter(page);
    await expect(notice(page)).toContainText('尚未设置项目当前稿');expect(currentSource(s)).toBeNull();expect(s.versions.current_version_id).toBeNull();expect(s.versions.selection_revision).toBe(0);expect(s.selections).toEqual([]);expect(s.project).toEqual(project);
    await review(page);await expect(state(page,s.candidate.version_id)).toHaveText('已保存，未设为项目当前稿');await exactReference(page,s.candidate);await cancelAdoption(page,s);expect(await uploadJournal(page)).toEqual({});fixedUnchanged(s,fixed);
  });

  test('saved prospectus reentry: a deliberate rollback keeps V1 current and describes later retained versions as not current without inferring they were never adopted',async({page})=>{
    const s=await open(page,fixture({rollback:true})),fixed=fixedSnapshot(s),project=structuredClone(s.project),before=projection(s);await reenter(page);
    await expect(panel(page).locator('header')).toContainText('项目当前稿：V1');await expect(notice(page)).toContainText('2 个之后保存的版本');await review(page);
    for(const v of s.versions.versions)await expect(state(page,v.version_id)).toHaveText(v.version_id===s.old.version_id?'项目当前稿':'已保存，未设为项目当前稿');
    expect(projection(s)).toEqual(before);expect(s.project).toEqual(project);expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  });

  test('saved prospectus reentry: retaining only earlier versions does not imply a newer saved candidate when the highest sequence is current',async({page})=>{
    const s=await open(page,fixture({currentLatest:true})),fixed=fixedSnapshot(s);await expect(notice(page)).toHaveCount(0);await reenter(page);await expect(notice(page)).toHaveCount(0);
    await page.locator('[data-prospectus-history-summary]').click();await expect(state(page,s.candidate.version_id)).toHaveText('项目当前稿');await expect(state(page,s.old.version_id)).toHaveText('已保存，未设为项目当前稿');expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  });

  test('saved prospectus reentry: equal filenames retain distinct version, material version and hash references and download the exact old and new OOXML bytes',async({page})=>{
    const s=await open(page,fixture({sameName:true})),fixed=fixedSnapshot(s);await upload(page,s);await reenter(page);await review(page);
    expect(s.old.filename).toBe(s.candidate.filename);expect(s.old.sha256).not.toBe(s.candidate.sha256);expect(s.old.material_version).not.toBe(s.candidate.material_version);
    await exactReference(page,s.old);await exactReference(page,s.candidate);expect(await downloadBytes(page,s.old.version_id)).toEqual(oldBytes);expect(await downloadBytes(page,s.candidate.version_id)).toEqual(newBytes);
    expect(s.selections).toEqual([]);expect(s.puts).toBe(1);fixedUnchanged(s,fixed);await noOverflow(page);
  });

  test('saved prospectus reentry: a generated saved version exposes its exact artifact version and hash without inventing a material identity',async({page})=>{
    const s=await open(page,fixture({generated:true})),fixed=fixedSnapshot(s);await reenter(page);await expect(notice(page)).toBeVisible();await review(page);const ref=await exactReference(page,s.candidate);
    await expect(ref).toContainText('成果编号');await expect(ref).toContainText('成果版本');await expect(ref).not.toContainText('材料编号');expect(await downloadBytes(page,s.candidate.version_id)).toEqual(newBytes);expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  });

  test('saved prospectus reentry: the native generation source step discovers the same retained candidate without preparing drafts or starting generation',async({page})=>{
    const s=await open(page,fixture({candidate:true})),fixed=fixedSnapshot(s),before=projection(s);await page.locator('.pw-actions').getByRole('link',{name:'生成文件',exact:true}).click();
    await expect(page.locator('#pf-prospectus .pf-source-picker')).toBeVisible();await expect(page.locator('.pf-workspace-heading h1')).toHaveText('生成文件');await expect(page.locator('#pf-source-next')).toBeVisible();
    await expect(page.locator('#pf-project-source option')).toContainText(['请选择募集说明书版本',s.candidate.filename,s.old.filename]);expect(writes(s)).toEqual([]);expect(projection(s)).toEqual(before);fixedUnchanged(s,fixed);
    await page.getByRole('link',{name:'项目文件',exact:true}).click();await ready(page);await expect(notice(page)).toBeVisible();expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  });

  test('saved prospectus reentry: unchanged native scheduled refresh retains history, exact reference disclosure and its keyboard focus',async({page})=>{
    const s=await open(page,fixture({candidate:true})),fixed=fixedSnapshot(s);await review(page);const ref=await exactReference(page,s.candidate),summary=ref.locator(':scope > summary');await summary.focus();
    const key=await ref.getAttribute('data-prospectus-key'),reads=s.versionReads;await page.clock.runFor(30_100);await expect.poll(()=>s.versionReads).toBeGreaterThan(reads);await expect(page.locator('#refresh-files')).toBeEnabled();
    await expect(history(page)).toHaveAttribute('open','');await expect(ref).toHaveAttribute('open','');await expect(ref).toHaveAttribute('data-prospectus-key',key!);await expect(summary).toBeFocused();expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  });

  for(const fault of ['foreign-project','duplicate-version'] as const)test(`saved prospectus reentry: a public-schema-valid ${fault} version projection does not claim a verified saved candidate or exact reference`,async({page})=>{
    const s=fixture({candidate:true});if(fault==='foreign-project')s.versions.project_id='saved-reentry-foreign-project';else s.versions.versions.push(structuredClone(s.candidate));
    const fixed=fixedSnapshot(s);await open(page,s);await expect(notice(page)).toHaveCount(0);await expect(panel(page).locator('header')).toContainText('版本记录尚待核对');await page.locator('[data-prospectus-history-summary]').click();
    await expect(panel(page).locator('[data-prospectus-ref]')).toHaveCount(0);await expect(panel(page).locator('[data-prospectus-selection-state]').first()).toHaveText('当前稿状态待核对');expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  });
});

test('saved prospectus reentry component comparison: exact R42 and current save the same V2 then leave and reenter through native all-projects navigation at 1440',async({page})=>{
  const verify=reference?await installProspectusSavedReentryReference(page):undefined,s=await open(page),fixed=fixedSnapshot(s),kind=reference?'reference':'current';
  const output=(reference?process.env.BB_PROSPECTUS_REFERENCE_DIR:process.env.BB_PROSPECTUS_CAPTURE_DIR)??test.info().outputPath(kind);
  await upload(page,s);const before=structuredClone(writes(s));await reenter(page);await page.locator('#pw-prospectus').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  await captureProspectusSavedReentry(page,output,'prospectus-saved-reentry-'+kind+'-comparison-reentered-1440',{...audit(s,'Both implementations saved the same new V2, navigated to all projects and clicked the real same-project title to reenter. The old V1 remains selected.'),reference});
  if(reference){await expect(page.locator('[data-prospectus-saved-notice]')).toHaveCount(0);await panel(page).locator('details').first().locator(':scope > summary').click();}
  else{await expect(notice(page)).toBeVisible();await review(page);}
  const target=reference?panel(page).locator('details').first():history(page);await target.locator(':scope > summary').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  await captureProspectusSavedReentry(page,output,'prospectus-saved-reentry-'+kind+'-comparison-history-1440',{...audit(s,reference?'R42 has no persistent saved-version notice. This screenshot uses its existing history summary, opened explicitly after native reentry.':'Current uses the saved-version review action to open history and focus its summary after native reentry.'),reference});
  expect(writes(s)).toEqual(before);expect(s.selections).toEqual([]);expect(await uploadJournal(page)).toEqual({});fixedUnchanged(s,fixed);await noOverflow(page);
  if(verify){await mkdir(output,{recursive:true});await writeFile(join(output,'prospectus-saved-reentry-reference-provenance.json'),JSON.stringify(await verify(),null,2)+'\n');}
});
