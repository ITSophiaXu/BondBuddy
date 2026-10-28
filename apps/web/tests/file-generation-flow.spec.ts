import {test,expect,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {ProspectusVersions} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha,file,batches} from './generation-entry-fixtures';

// Real page/controller with synthetic HTTP, no real model, storage or billing calls.
async function sourceFixture(page:Page,current:boolean){
  const state=await fixture(page),workspace=state.workspaces.get(ids.api)!;
  const sourceProject=current?ids.source:ids.api;
  const versions:ProspectusVersions={project_id:sourceProject,selection_revision:current?7:0,current_version_id:current?'source-v3':null,inactive_material_ids:[],versions:current?[{
    version_id:'source-v3',sequence:3,filename:'募集说明书_V3.docx',origin:'upload',sha256:sha,created_at:now,material_id:'source-material',material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null,
  }]:[]};
  if(!current)workspace.source=null;
  const selections:any[]=[],receipts=new Map<string,ProspectusVersions>();
  const control={dropSelection:false,conflict:false};
  await page.route('**/api/v1/projects/*/prospectus-versions**',async route=>{
    for(const material of state.materials.values())if(material.role==='historical'&&!versions.versions.some(v=>v.material_id===material.material_id))versions.versions.unshift({
      version_id:'new-source',sequence:4,origin:'upload',filename:material.filename,sha256:material.sha256,created_at:now,material_id:material.material_id,material_version:material.material_version,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null,
    });
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();selections.push(body);
      if(control.conflict){control.conflict=false;return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});}
      if(!receipts.has(body.request_id)){
        expect(body.expected_selection_revision).toBe(versions.selection_revision);versions.current_version_id=body.version_id;versions.selection_revision++;
        const v=versions.versions.find(v=>v.version_id===body.version_id)!;
        workspace.source={project_id:sourceProject,version_id:v.version_id,sequence:v.sequence,filename:v.filename,selection_revision:versions.selection_revision,
          asset:{kind:'material',pin:{source_project_id:sourceProject,material_id:v.material_id!,material_version:v.material_version!,sha256:v.sha256}}};
        receipts.set(body.request_id,structuredClone(versions));
      }
      if(control.dropSelection){control.dropSelection=false;return route.abort('connectionreset');}
      return route.fulfill({json:receipts.get(body.request_id)});
    }
    return route.fulfill({json:versions});
  });
  await page.route('**/project-files/source',async route=>{
    const body=route.request().postDataJSON(),source=workspace.source!;
    expect(body).toEqual({source_version_id:source.version_id,expected_selection_revision:source.selection_revision});
    for(const draft of Object.values(workspace.workspace.drafts))draft.project_file={project_id:ids.api,source_version_id:source.version_id,source_selection_revision:source.selection_revision};
    state.calls.push({method:'POST',path:`/projects/${ids.api}/project-files/source`,body});
    return route.fulfill({json:workspace});
  });
  await page.route('**/workpapers',route=>route.fulfill({json:{catalogues:[],batches:[],assessments:[]}}));
  return {state,versions,selections,control};
}
async function evidence(page:Page,name:string,selector?:string){
  const dir=process.env.BB_FLOW_EVIDENCE;if(!dir)return;
  await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,name+'.png'),fullPage:true});
  if(selector)await writeFile(join(dir,name+'.html'),await page.locator(selector).evaluate(node=>node.outerHTML));
  if(name.startsWith('entry-'))await writeFile(join(dir,name+'.html'),await page.locator('.pf-workspace-heading').evaluate(node=>node.outerHTML+document.querySelector('.pf-home-source')!.outerHTML+document.querySelector('.pf-generation-choices')!.outerHTML));
}

for(const width of [1440,390,320])test(`generation starts with two equal choices and no implicit mode at ${width}px`,async({page})=>{
  const {state}=await sourceFixture(page,true);await page.setViewportSize({width,height:960});await page.goto('/'+href());
  await expect(page.getByRole('heading',{name:'文件生成',exact:true})).toBeVisible();
  const choices=page.locator('.pf-generation-choice');await expect(choices).toHaveCount(2);
  await expect(page.locator('.pf-generation-choice[aria-current],#pf-generate')).toHaveCount(0);
  await expect(page.locator('#pf-prospectus')).toBeVisible();await expect(choices.nth(1)).toBeDisabled();
  await expect(page.locator('#pf-confirm-source')).toBeEnabled();
  const colors=await choices.evaluateAll(nodes=>nodes.map(n=>[getComputedStyle(n).backgroundColor,getComputedStyle(n).borderColor]));expect(colors[0]).toEqual(colors[1]);
  expect(state.calls.filter(c=>c.method!=='GET')).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await evidence(page,'entry-'+width);
  await page.locator('#pf-confirm-source').click();await expect(choices.nth(1)).toBeEnabled();
  await choices.nth(1).focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'按模板生成文件',exact:true})).toBeVisible();
  await expect(page.locator('#pf-generate')).toBeVisible();await expect(choices).toHaveCount(0);
  await page.getByRole('link',{name:'← 选择生成方式',exact:true}).click();await expect(choices).toHaveCount(2);
});

for(const current of [false,true])for(const mode of ['documents','workpapers'])test(`automatic source upload and one continue: ${mode}, existing=${current}`,async({page})=>{
  const s=await sourceFixture(page,current);await page.goto('/'+href({step:'source',...(mode==='workpapers'?{mode}: {})},ids.api,ids.navigation));
  await expect(page.getByRole('heading',{name:mode==='workpapers'?'批量生成底稿':'按模板生成文件',exact:true})).toBeVisible();
  const chooser=page.waitForEvent('filechooser');await page.locator('#choose-prospectus-version').click();await(await chooser).setFiles(file);
  await expect(page.locator('.pf-upload-ready')).toContainText(file.name);
  await expect(page.locator('#save-prospectus-version')).toBeHidden();await expect(page.locator('#pf-source-next')).toBeHidden();
  expect(s.state.puts).toBe(1);expect(s.selections).toHaveLength(0);expect(s.versions.current_version_id).toBe(current?'source-v3':null);
  await page.reload();await expect(page.locator('[data-use-saved]')).toBeVisible();
  await page.locator('[data-use-saved]').click();
  await expect(page.locator(mode==='workpapers'?'#wp-upload':'#pf-generate')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`step=${mode}`));await expect(page).toHaveURL(new RegExp(`return_project=${ids.navigation}`));
  expect(s.selections).toHaveLength(1);expect(s.versions.current_version_id).toBe('new-source');expect(s.state.puts).toBe(1);
  await expect(page.locator(mode==='workpapers'?'.wp-source-file':'#pf-source-summary')).toContainText(file.name);
  expect(batches(s.state)).toHaveLength(0);expect(s.state.errors).toEqual([]);
});

test('batch source management returns to batch preparation without touching template drafts',async({page})=>{
  const s=await sourceFixture(page,true);await page.goto('/'+href({step:'workpapers'}));
  await page.locator('.wp-source-context a').click();await expect(page).toHaveURL(/mode=workpapers/);
  await page.locator('#pf-source-next').click();await expect(page.locator('#wp-upload')).toBeVisible();
  await page.getByRole('link',{name:'生成记录',exact:true}).click();await expect(page).toHaveURL(/step=workpapers/);await expect(page).toHaveURL(/view=results/);
  await expect(page.locator('#wp-batches')).toBeFocused();
  expect(s.state.calls.filter(c=>c.path.endsWith('/project-files/source'))).toHaveLength(0);
});

test('generation version switch retries the same selection receipt without navigation until confirmed',async({page})=>{
  const s=await sourceFixture(page,true);s.control.dropSelection=true;
  await page.goto('/'+href({step:'source'}));await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect(page.locator('[data-use-saved]')).toBeVisible();await page.locator('[data-use-saved]').click();
  await expect(page.locator('#retry-prospectus-selection')).toBeVisible();await expect(page.locator('#pf-generate')).toHaveCount(0);
  await page.locator('#retry-prospectus-selection').click();await expect(page.locator('#pf-generate')).toBeVisible();
  expect(s.selections).toHaveLength(2);expect(s.selections[0]).toEqual(s.selections[1]);expect(s.state.puts).toBe(1);
});

test('replacement can keep the original version without discarding the uploaded file',async({page})=>{
  const s=await sourceFixture(page,true);await page.goto('/'+href({step:'source'}));await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect(page.locator('[data-keep-current]')).toBeVisible();await page.locator('[data-keep-current]').click();
  await expect(page.locator('#pf-source-next')).toBeVisible();await page.locator('#pf-source-next').click();await expect(page.locator('#pf-generate')).toBeVisible();
  expect(s.versions.versions).toHaveLength(2);expect(s.versions.current_version_id).toBe('source-v3');expect(s.selections).toEqual([]);
});

test('a concurrent version conflict keeps the user on source preparation until a fresh explicit choice',async({page})=>{
  const s=await sourceFixture(page,true);s.control.conflict=true;await page.goto('/'+href({step:'source'}));
  await page.locator('#prospectus-version-file').setInputFiles(file);await expect(page.locator('[data-use-saved]')).toBeVisible();await page.locator('[data-use-saved]').click();
  await expect(page.locator('#prospectus-status')).toContainText('采用未完成');await expect(page.locator('#pf-generate')).toHaveCount(0);
  await page.locator('[data-use-saved]').click();await expect(page.locator('#pf-generate')).toBeVisible();
  expect(s.selections).toHaveLength(2);expect(s.selections[0].request_id).not.toBe(s.selections[1].request_id);
});

test('an active upload blocks old-source continuation and exposes progress without an upload confirmation',async({page})=>{
  const s=await sourceFixture(page,true);let release!:()=>void;const hold=new Promise<void>(r=>release=r);
  await page.route('**/api/v1/projects/*/materials/uploads/*/complete',async route=>{await hold;await route.fallback();});
  await page.goto('/'+href({step:'source'}));await page.locator('#prospectus-version-file').setInputFiles(file);
  try{
    await expect(page.locator('.prospectus-panel')).toHaveAttribute('aria-busy','true');await expect(page.locator('#pf-source-next')).toBeDisabled();
    await expect(page.locator('#choose-prospectus-version')).toBeDisabled();await expect(page.locator('#save-prospectus-version')).toBeHidden();
    expect(s.selections).toHaveLength(0);
  }finally{release();}
  await expect(page.locator('[data-use-saved]')).toBeEnabled();expect(s.state.puts).toBe(1);
});

test('source preparation evidence includes empty, uploaded and current states',async({page})=>{
  const s=await sourceFixture(page,false);await page.setViewportSize({width:1440,height:1000});await page.goto('/'+href({step:'source'}));
  await expect(page.locator('.pf-prospectus-dropzone')).toBeVisible();await evidence(page,'source-empty-1440');
  await page.locator('#prospectus-version-file').setInputFiles(file);await expect(page.locator('[data-use-saved]')).toBeVisible();
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await evidence(page,'source-uploaded-'+width);
  }
  expect(batches(s.state)).toHaveLength(0);
});

for(const mode of ['documents','workpapers'] as const)test(`home confirms an unprepared current source and opens ${mode} directly`,async({page})=>{
  const s=await sourceFixture(page,true),workspace=s.state.workspaces.get(ids.api)!;
  for(const draft of Object.values(workspace.workspace.drafts))delete draft.project_file;
  await page.goto('/'+href({},ids.api,ids.navigation));
  await expect(page.locator('#pf-confirm-source')).toBeEnabled();
  expect(s.state.calls.filter(c=>c.method!=='GET')).toEqual([]);
  await page.locator('#pf-confirm-source').click();
  await expect(page.locator(`[data-generation-mode="${mode}"]`)).toBeEnabled();
  await page.locator(`[data-generation-mode="${mode}"]`).click();
  await expect(page.locator(mode==='documents'?'#pf-generate':'#wp-upload')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`step=${mode}`));await expect(page).toHaveURL(new RegExp(`return_project=${ids.navigation}`));
  await expect(page.locator('#pf-source-next,#pf-prospectus')).toHaveCount(0);
  expect(s.state.calls.filter(c=>c.path.endsWith('/project-files/source'))).toHaveLength(mode==='documents'?1:0);
  expect(s.selections).toEqual([]);expect(batches(s.state)).toEqual([]);expect(s.state.errors).toEqual([]);
});

for(const current of [false,true])for(const mode of ['documents','workpapers'])test(`home uploads and adopts once before ${mode}, existing=${current}`,async({page})=>{
  const s=await sourceFixture(page,current);await page.goto('/'+href());
  await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect(page.locator('[data-use-saved]')).toBeVisible();expect(s.selections).toEqual([]);expect(s.state.puts).toBe(1);
  await page.reload();await expect(page.locator('[data-use-saved]')).toBeVisible();
  await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  await page.locator('[data-use-saved]').click();await expect(page.locator(`[data-generation-mode="${mode}"]`)).toBeEnabled();
  await expect(page.getByRole('heading',{name:'文件生成',exact:true})).toBeVisible();
  await page.locator(`[data-generation-mode="${mode}"]`).click();
  await expect(page.locator(mode==='documents'?'#pf-generate':'#wp-upload')).toBeVisible();
  await expect(page.locator(mode==='documents'?'#pf-source-summary':'.wp-source-file')).toContainText(file.name);
  expect(s.selections).toHaveLength(1);expect(s.state.puts).toBe(1);expect(batches(s.state)).toEqual([]);expect(s.state.errors).toEqual([]);
});

test('home invalidates confirmation during replacement and can explicitly keep the old version',async({page})=>{
  const s=await sourceFixture(page,true);let release!:()=>void;const hold=new Promise<void>(r=>release=r);
  await page.route('**/api/v1/projects/*/materials/uploads/*/complete',async route=>{await hold;await route.fallback();});
  await page.goto('/'+href());await page.locator('#pf-confirm-source').click();await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  await page.locator('#prospectus-version-file').setInputFiles(file);
  try{
    await expect(page.locator('.prospectus-panel')).toHaveAttribute('aria-busy','true');
    await expect(page.locator('#pf-confirm-source')).toBeDisabled();await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  }finally{release();}
  await expect(page.locator('[data-use-saved]')).toBeVisible();await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  await page.locator('[data-keep-current]').click();await page.locator('#pf-confirm-source').click();
  await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  await page.locator('[data-generation-mode="documents"]').click();await expect(page.locator('#pf-source-summary')).toContainText('募集说明书_V3.docx');
  expect(s.versions.versions).toHaveLength(2);expect(s.selections).toEqual([]);
});

test('home keeps selection recovery on the first page until the same receipt is confirmed',async({page})=>{
  const s=await sourceFixture(page,true);s.control.dropSelection=true;
  await page.goto('/'+href());await page.locator('#prospectus-version-file').setInputFiles(file);await page.locator('[data-use-saved]').click();
  await expect(page.locator('#retry-prospectus-selection')).toBeVisible();await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  await page.locator('#retry-prospectus-selection').click();await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  await expect(page.getByRole('heading',{name:'文件生成',exact:true})).toBeVisible();expect(s.selections).toHaveLength(2);expect(s.selections[0]).toEqual(s.selections[1]);
});

test('home detects a changed source after confirmation before opening either workflow',async({page})=>{
  const s=await sourceFixture(page,true);await page.goto('/'+href());await page.locator('#pf-confirm-source').click();
  await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  s.versions.selection_revision++;s.state.workspaces.get(ids.api)!.source!.selection_revision++;
  await page.locator('[data-generation-mode="workpapers"]').click();
  await expect(page.locator('#pf-status')).toContainText('已变化');await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  await expect(page.locator('#wp-upload')).toHaveCount(0);await page.locator('#pf-confirm-source').click();await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  expect(batches(s.state)).toEqual([]);
});

test('home rejects an invalid replacement without silently continuing with the previously confirmed file',async({page})=>{
  const s=await sourceFixture(page,true);await page.goto('/'+href());await page.locator('#pf-confirm-source').click();
  await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  await page.locator('#prospectus-version-file').setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')});
  await expect(page.locator('#prospectus-status')).toContainText('DOCX 或 PDF');await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  await page.locator('#cancel-prospectus-version').click();await expect(page.locator('#pf-confirm-source')).toBeEnabled();
  expect(s.state.puts).toBe(0);expect(s.selections).toEqual([]);
});

test('home can confirm when the version list was read after the workspace snapshot changed',async({page})=>{
  const s=await sourceFixture(page,true);s.versions.selection_revision++;
  await page.goto('/'+href());await expect(page.locator('#pf-confirm-source')).toBeEnabled();
  s.state.workspaces.get(ids.api)!.source!.selection_revision=s.versions.selection_revision;
  await page.locator('#pf-confirm-source').click();await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  expect(s.selections).toEqual([]);
});

test('home can explicitly use a historical version without a newer saved version blocking continuation',async({page})=>{
  const s=await sourceFixture(page,true);
  s.versions.versions.push({...s.versions.versions[0],version_id:'source-v2',sequence:2,filename:'募集说明书_V2.docx',material_id:'source-material-v2'});
  await page.goto('/'+href());await page.locator('[data-prospectus-history-summary]').click();await page.locator('[data-use-version="source-v2"]').click();
  await expect(page.locator('[data-generation-mode="documents"]')).toBeEnabled();await expect(page.locator('.pf-upload-ready')).toHaveCount(0);
  await page.locator('[data-generation-mode="documents"]').click();await expect(page.locator('#pf-source-summary')).toContainText('募集说明书_V2.docx');
  expect(s.selections).toHaveLength(1);expect(s.versions.versions).toHaveLength(2);expect(batches(s.state)).toEqual([]);
});

test('home retries a failed upload without enabling either workflow or uploading the bytes twice',async({page})=>{
  const s=await sourceFixture(page,true);let fail=true;
  await page.route('**/api/v1/projects/*/materials/uploads/*/complete',async route=>{if(fail){fail=false;return route.abort('connectionreset');}await route.fallback();});
  await page.goto('/'+href());await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect(page.locator('#save-prospectus-version')).toBeVisible();await expect(page.locator('.pf-generation-choice').first()).toBeDisabled();
  await page.locator('#save-prospectus-version').click();await expect(page.locator('[data-use-saved]')).toBeVisible();
  await page.locator('[data-use-saved]').click();await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
  expect(s.state.puts).toBe(1);expect(s.selections).toHaveLength(1);
});

for(const width of [1440,390,320])test(`home keeps long prospectus filenames and actions usable at ${width}px`,async({page})=>{
  const s=await sourceFixture(page,true),filename='合成示例集团股份有限公司2026年面向专业投资者非公开发行科技创新公司债券募集说明书1025v1清洁版(1).docx';
  s.versions.versions[0].filename=filename;s.state.workspaces.get(ids.api)!.source!.filename=filename;
  await page.setViewportSize({width,height:960});await page.goto('/'+href());await expect(page.locator('#pf-confirm-source')).toBeEnabled();
  await expect(page.locator('.prospectus-current-file')).toContainText(filename);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await evidence(page,'home-long-name-'+width);await page.locator('#pf-confirm-source').click();await expect(page.locator('.pf-generation-choice').first()).toBeEnabled();
});

for(const width of [1440,390])test(`prototype matches entry and source controls at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await fixture(page);await page.goto('/'+href());
  const actual=page.locator('.pf-generation-choices');await expect(actual).toBeVisible();const actualWidth=(await actual.boundingBox())!.width;
  const dir=process.env.BB_FLOW_EVIDENCE??test.info().outputPath('comparison');await mkdir(dir,{recursive:true});
  await actual.screenshot({path:join(dir,`implementation-choices-${width}.png`)});
  await expect(page.locator('#pf-confirm-source')).toBeEnabled();await page.locator('.pf-home-source').screenshot({path:join(dir,`implementation-source-${width}.png`)});
  const preview='/@fs/'+resolve(process.cwd(),'../../product-prototype/public/file-generation.html').replaceAll('\\','/');
  await page.goto(preview);await expect(page.locator('.pf-generation-choice')).toHaveCount(2);
  expect(Math.abs((await page.locator('.pf-generation-choices').boundingBox())!.width-actualWidth)).toBeLessThan(3);
  await page.locator('.pf-generation-choices').screenshot({path:join(dir,`prototype-choices-${width}.png`)});
  await page.locator('.pf-home-source').screenshot({path:join(dir,`prototype-source-${width}.png`)});
  await page.getByRole('button',{name:'未上传',exact:true}).click();await page.locator('#prospectus-version-file').setInputFiles(file);
  await expect(page.locator('.pf-upload-ready')).toContainText(file.name);await expect(page.locator('#save-prospectus-version')).toBeHidden();
  await page.getByRole('button',{name:'使用此版继续 →',exact:true}).click();await expect(page.locator('[data-generation-mode="documents"]')).toBeEnabled();
  await page.locator('[data-generation-mode="documents"]').click();await expect(page.locator('.pf-file-builder')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
