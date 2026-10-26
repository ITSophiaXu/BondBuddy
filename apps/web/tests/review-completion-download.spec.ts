import {expect,test,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {ReviewHistoryEntry} from '@bondbuddy/contracts';
import {assertFixture,fixture,install,marker,mime,projectId,runId} from './review-followup-fixtures';
import {docx} from './word-roundtrip-fixtures';

// Reuse the schema-checked followup service model and the real workspace UI.
// Add distinct real OOXML for each receipt, rather than the shared fixture's
// text-only transport bytes. This proves version/download wiring, not workers,
// professional review, actual billing or Word desktop rendering.
function completionFixture(){
  const state=fixture(),words=new Map<string,Buffer>();
  const register=(entry:ReviewHistoryEntry)=>{
    const snapshot=state.editors.get(entry.run.run_id)!.snapshot;
    const content=snapshot.issues.map(issue=>issue.decision==='manual'?issue.manual_text:issue.original).join('\n');
    for(const artifact of entry.artifacts){
      const bytes=docx(`合成复核成果 V${entry.version} ${artifact.kind}。\n${content}`);
      const sha256=createHash('sha256').update(bytes).digest('hex');
      words.set(artifact.artifact_id,bytes);state.metadata.get(artifact.artifact_id)!.sha256=sha256;
      const catalog=state.catalog.versions.find(item=>item.artifact_id===artifact.artifact_id);if(catalog)catalog.sha256=sha256;
    }
  };
  state.history.forEach(register);
  const addVersion=state.addVersion;
  state.addVersion=version=>{
    const entry=addVersion(version),request=state.exports.at(-1);
    if(request){
      const source=state.editors.get(request.source_run_id)!;
      expect(request.expected_editor_sha256).toBe(source.sha256);
      const saved=structuredClone(source);saved.run_id=entry.run.run_id;
      for(const decision of request.decisions){
        const issue=saved.snapshot.issues.find(issue=>issue.id===decision.id);expect(issue).toBeTruthy();
        Object.assign(issue!,{decision:decision.decision,manual_text:decision.manual_text,
          applied:decision.decision==='manual'&&decision.manual_text!==issue!.original});
      }
      saved.sha256=createHash('sha256').update(JSON.stringify(saved.snapshot)).digest('hex');
      state.editors.set(entry.run.run_id,saved);
      const origin=state.history.find(item=>item.run.run_id===request.source_run_id)!;
      entry.input=structuredClone(origin.input);entry.input_revision=origin.input_revision;
    }
    register(entry);return entry;
  };
  const completeActive=state.completeActive;
  state.completeActive=()=>{const entry=completeActive();register(entry);return entry;};
  return Object.assign(state,{words});
}
type State=ReturnType<typeof completionFixture>;
async function setup(page:Page){
  const state=completionFixture();await install(page,state);
  await page.route('**/api/v1/artifacts/*/download',async route=>{
    const url=new URL(route.request().url()),id=url.pathname.split('/').at(-2)!;
    const bytes=state.words.get(id);if(!bytes)return route.fallback();
    state.calls.push({method:'GET',path:url.pathname.slice('/api/v1'.length),search:url.search});
    return route.fulfill({status:200,contentType:mime,body:bytes});
  });
  await page.goto(`/#/projects/${projectId}/review?tab=results&run=${runId(1)}`);
  await expectEditor(page,1);return state;
}
async function expectEditor(page:Page,version:number,content=marker(version)){
  const host=page.locator('#review-results-panel');
  await expect(host.locator('[data-editor-history]')).toHaveValue(runId(version));
  await expect(host.locator('[data-editor-document]')).toContainText(content);return host;
}
async function downloadWord(page:Page,state:State,version:number,kind:'clean'|'revision'='clean'){
  const host=page.locator('#review-results-panel'),id=`followup-${version}-${kind}`;
  const button=kind==='clean'?host.getByRole('button',{name:'下载清洁版',exact:true})
    :host.getByRole('button',{name:/^下载(?:修订版|批注版)/});
  const [download]=await Promise.all([page.waitForEvent('download'),button.click()]);
  const bytes=await readFile((await download.path())!);
  expect(download.suggestedFilename()).toBe(`合成复核成果V${version}-${kind}.docx`);
  expect(bytes).toEqual(state.words.get(id));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(state.metadata.get(id)!.sha256);
  expect(bytes.subarray(0,2).toString()).toBe('PK');
  expect(bytes.includes(Buffer.from('word/document.xml'))).toBe(true);
  await expect(host.locator('[data-editor-status]')).toContainText('已提交浏览器下载');return bytes;
}
const downloads=(state:State)=>state.calls.filter(call=>/^\/artifacts\/[^/]+\/download$/.test(call.path)).map(call=>call.path);

test.use({viewport:{width:1440,height:960}});
test.afterEach(({page})=>assertFixture(page));

test('free manual export downloads the new V3 Word pair while historical V1 keeps its exact bytes and identity',async({page},testInfo)=>{
  const state=await setup(page),host=await expectEditor(page,1);
  const originalEditor=structuredClone(state.editors.get(runId(1))),originalMetadata=structuredClone(state.metadata.get('followup-1-clean'));
  const original=await downloadWord(page,state,1),manual='合成人工确认现金流为 130 万元；此文字只属于新导出的成果。';
  await host.getByRole('radio',{name:'手动修改',exact:true}).check();
  await host.getByLabel('替换原文的内容',{exact:true}).fill(manual);
  await expect(host.locator('[data-editor-document]')).toContainText(manual);
  await host.locator('[data-editor-save]').click();await expect.poll(()=>state.exports.length).toBe(1);
  expect(state.exports[0]).toMatchObject({source_run_id:runId(1),expected_editor_sha256:originalEditor!.sha256,
    decisions:[{id:'editor-item-1',decision:'manual',manual_text:manual}]});
  expect(state.quotes).toEqual([]);expect(state.executions).toEqual([]);
  await page.getByRole('tab',{name:'复核结果',exact:true}).click();await expectEditor(page,1);
  await page.getByRole('link',{name:'查看最新成果 V3',exact:true}).click();await expectEditor(page,3,manual);
  const clean=await downloadWord(page,state,3),revision=await downloadWord(page,state,3,'revision');
  expect(clean).not.toEqual(original);expect(clean).not.toEqual(revision);
  expect(clean.includes(Buffer.from(manual))).toBe(true);expect(revision.includes(Buffer.from(manual))).toBe(true);
  await page.screenshot({path:testInfo.outputPath('free-export-v3-1440.png'),fullPage:true});
  await page.reload();await expectEditor(page,3,manual);
  await page.locator('[data-editor-history]').selectOption(runId(1));await expectEditor(page,1);
  expect(await downloadWord(page,state,1)).toEqual(original);
  expect(state.editors.get(runId(1))).toEqual(originalEditor);expect(state.metadata.get('followup-1-clean')).toEqual(originalMetadata);
  expect(state.catalog.current_version_id).toBe('followup-clean-version-2');expect(state.catalog.selection_revision).toBe(9);
  expect(state.exports).toHaveLength(1);expect(state.quotes).toEqual([]);expect(state.executions).toEqual([]);
  expect(downloads(state)).toEqual(['/artifacts/followup-1-clean/download','/artifacts/followup-3-clean/download',
    '/artifacts/followup-3-revision/download','/artifacts/followup-1-clean/download']);
});

test('supplemented full review downloads its completed new V3 Word pair and still preserves the old V1 Word',async({page},testInfo)=>{
  const state=await setup(page),originalMetadata=structuredClone(state.metadata.get('followup-1-clean'));
  const original=await downloadWord(page,state,1);
  await page.locator('[data-editor-followup]').click();
  const dialog=page.getByRole('dialog',{name:'准备下一轮复核',exact:true});await expect(dialog).toBeVisible();
  const requirement=await dialog.locator('#review-followup-text').inputValue();
  await dialog.getByRole('button',{name:'保存要求并去补料',exact:true}).click();
  await expect(dialog).not.toBeVisible();await expect(page.locator('#review-requirements')).toHaveValue(['原已保存要求。',requirement].join('\n'));
  const financial=page.locator('.material-partition').filter({has:page.getByRole('heading',{name:'审计报告 / 财务报表及附注',exact:true})});
  await financial.locator('summary').click();
  await page.locator('#review-upload-financial').setInputFiles({name:'合成新一轮现金流补充.csv',mimeType:'text/csv',buffer:Buffer.from('期间,项目,金额\n2025,经营现金流,130\n')});
  await expect.poll(()=>state.supplement?.state).toBe('persisted');
  const supplement={material_id:state.supplement!.material_id,material_version:1,sha256:state.supplement!.sha256};
  await expect.poll(()=>state.draft.material_versions.some(item=>item.material_id===supplement.material_id&&item.sha256===supplement.sha256)).toBe(true);
  expect(state.executions).toEqual([]);expect(state.quotes).toEqual([]);
  await page.getByRole('button',{name:'开始复核',exact:true}).click();await expect.poll(()=>state.executions.length).toBe(1);
  const running=state.history[0],fixed=structuredClone(running.input),request=state.executions[0];
  expect(request).toMatchObject({operation:'full_review',source_report_id:null,finding_ids:[],expected_input_version:running.input_revision});
  expect(fixed.material_versions).toContainEqual(supplement);expect(fixed.requirements).toContain(requirement);
  const completed=state.completeActive();expect(completed.run.run_id).toBe(running.run.run_id);
  expect(completed.run.execution_request_id).toBe(request.execution_request_id);expect(completed.input).toEqual(fixed);
  const reads=state.workspaceReads;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect.poll(()=>state.workspaceReads).toBeGreaterThan(reads);
  await page.getByRole('tab',{name:'复核结果',exact:true}).click();await expectEditor(page,1);
  await page.getByRole('link',{name:'查看最新成果 V3',exact:true}).click();await expectEditor(page,3);
  const clean=await downloadWord(page,state,3),revision=await downloadWord(page,state,3,'revision');
  expect(clean).not.toEqual(original);expect(clean).not.toEqual(revision);expect(clean.includes(Buffer.from(marker(3)))).toBe(true);
  await page.screenshot({path:testInfo.outputPath('supplement-completed-v3-1440.png'),fullPage:true});
  await page.locator('[data-editor-history]').selectOption(runId(1));await expectEditor(page,1);
  expect(await downloadWord(page,state,1)).toEqual(original);expect(state.metadata.get('followup-1-clean')).toEqual(originalMetadata);
  expect(completed.input).toEqual(fixed);expect(state.executions).toHaveLength(1);expect(state.quotes).toHaveLength(1);expect(state.exports).toEqual([]);
  expect(downloads(state)).toEqual(['/artifacts/followup-1-clean/download','/artifacts/followup-3-clean/download',
    '/artifacts/followup-3-revision/download','/artifacts/followup-1-clean/download']);
});
