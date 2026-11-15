import {test,expect,type Page} from '@playwright/test';
import {emptyFileGenerationPreparation,type FileGenerationWorkspace} from '@bondbuddy/contracts';
import {fixtureBody} from './billing-fixture-wire';
import {sourceFixture} from './generation-source-fixtures';
import {href,ids,sha,assertFixture} from './generation-entry-fixtures';

// Real source/navigation controllers with synthetic HTTP. These tests do not
// execute a model or claim to verify backend persistence or Blob performance.
async function existingGeneratedSource(page:Page,extra:Record<string,string>={}){
  const fixture=await sourceFixture(page,true),workspace=fixture.state.workspaces.get(ids.api)!;
  const version=fixture.versions.versions[0];
  Object.assign(version,{origin:'generated',filename:'募集说明书清洁版.docx',material_id:null,material_version:null,
    artifact_id:'generated-clean-v3',artifact_version:1,revision_artifact_id:'generated-revision-v3',run_id:'generated-run-v3'});
  workspace.source={...workspace.source!,filename:version.filename,
    asset:{kind:'artifact',pin:{source_project_id:ids.source,artifact_id:version.artifact_id!,artifact_version:1,sha256:sha}}};
  const preparation:FileGenerationWorkspace={revision:1,preparation:emptyFileGenerationPreparation(),sets:[],
    builtin:{name:'光大证券模板',version:'',available:false},batches:[]};
  const writes:{method:string;path:string}[]=[];
  page.on('request',request=>{
    const path=new URL(request.url()).pathname;
    if(path.startsWith('/api/v1/')&&request.method()!=='GET')writes.push({method:request.method(),path});
  });
  await page.route('**/api/v1/projects/*/file-generation',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');
    fixture.state.calls.push({method:request.method(),path,body:undefined});
    if(request.method()!=='GET'){
      fixture.state.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({status:500,json:{code:'DATA_UNAVAILABLE'}});
    }
    return route.fulfill({json:fixtureBody(route,preparation)});
  });
  await page.goto('/'+href({step:'source',...extra}));
  await expect(page.locator('#pf-source-next')).toBeEnabled();
  await expect(page.locator('.pf-selected-source')).toContainText('募集说明书清洁版.docx');
  await expect(page.locator('.pf-selected-source')).toContainText('V3');
  return {...fixture,workspace,writes};
}

test('existing generated V3 enters unified preparation without copying a source, uploading or saving document drafts',async({page})=>{
  const fixture=await existingGeneratedSource(page),drafts=structuredClone(fixture.workspace.workspace.drafts);
  await page.locator('#pf-source-next').click();
  await expect(page).toHaveURL(/step=prepare(?:&|$)/);
  await expect(page.getByRole('heading',{name:'底稿目录与文件模板'})).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.selections).toEqual([]);
  expect(fixture.state.sessions.size).toBe(0);
  expect(fixture.state.puts).toBe(0);
  expect(fixture.workspace.workspace.drafts).toEqual(drafts);
  expect(fixture.workspace.source!.version_id).toBe('source-v3');
  expect(fixture.workspace.source!.asset.kind).toBe('artifact');
  assertFixture(fixture.state);
});

test('a different server source still blocks continuation without overwriting the displayed selection',async({page})=>{
  const fixture=await existingGeneratedSource(page),drafts=structuredClone(fixture.workspace.workspace.drafts);
  fixture.workspace.source={...fixture.workspace.source!,version_id:'source-v4',sequence:4,selection_revision:8};
  await page.locator('#pf-source-next').click();
  await expect(page.locator('#pf-status')).toContainText('项目募集说明书已变化');
  await expect(page).toHaveURL(/step=source(?:&|$)/);
  await expect(page.locator('#pf-source-next')).toBeEnabled();
  await expect(page.locator('.pf-selected-source')).toContainText('V3');
  expect(fixture.writes).toEqual([]);
  expect(fixture.selections).toEqual([]);
  expect(fixture.workspace.workspace.drafts).toEqual(drafts);
  assertFixture(fixture.state);
});

test('a removed current source blocks continuation without a write',async({page})=>{
  const fixture=await existingGeneratedSource(page);
  fixture.workspace.source=null;
  await page.locator('#pf-source-next').click();
  await expect(page.locator('#pf-status')).toContainText('项目当前募集说明书已变化');
  await expect(page).toHaveURL(/step=source(?:&|$)/);
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  assertFixture(fixture.state);
});

test('legacy document preparation retains its exact source adoption request',async({page})=>{
  const fixture=await existingGeneratedSource(page,{mode:'documents'});
  await page.locator('#pf-source-next').click();
  await expect(page).toHaveURL(/step=documents(?:&|$)/);
  await expect(page.locator('#pf-generate')).toBeVisible();
  expect(fixture.writes).toEqual([{method:'POST',path:`/api/v1/projects/${ids.api}/project-files/source`}]);
  expect(fixture.state.calls.filter(call=>call.path.endsWith('/project-files/source')).map(call=>call.body))
    .toEqual([{source_version_id:'source-v3',expected_selection_revision:7}]);
  expect(fixture.state.sessions.size).toBe(0);
  expect(fixture.selections).toEqual([]);
  assertFixture(fixture.state);
});

test('source status read timeout restores the next button and permits a read-only retry',async({page})=>{
  const fixture=await existingGeneratedSource(page);
  await page.evaluate(()=>{
    const original=AbortSignal.timeout.bind(AbortSignal);let first=true;
    AbortSignal.timeout=milliseconds=>{
      if(milliseconds!==15_000||!first)return original(milliseconds);
      first=false;const controller=new AbortController();
      Object.assign(window,{expireSourceRead:()=>controller.abort(new DOMException('Synthetic source read deadline','TimeoutError'))});
      return controller.signal;
    };
  });
  let reads=0;
  await page.route(`**/api/v1/projects/${ids.api}/project-files/workspace`,async route=>{
    if(route.request().method()==='GET'&&++reads===1)return;
    return route.fallback();
  });
  await page.locator('#pf-source-next').click();
  await expect.poll(()=>reads).toBe(1);
  await expect(page.locator('#pf-source-next')).toBeDisabled();
  await expect(page.locator('#pf-status')).toHaveText('正在核对募集说明书…');
  await page.evaluate(()=>{(window as unknown as {expireSourceRead:()=>void}).expireSourceRead();});
  await expect(page.locator('#pf-status')).toHaveText('募集说明书状态读取超时，请重试。已保存的文件不受影响。');
  await expect(page.locator('#pf-source-next')).toBeEnabled();
  await expect(page).toHaveURL(/step=source(?:&|$)/);
  expect(fixture.writes).toEqual([]);
  await page.locator('#pf-source-next').click();
  await expect(page).toHaveURL(/step=prepare(?:&|$)/);
  await expect(page.getByRole('heading',{name:'底稿目录与文件模板'})).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(fixture.writes).toEqual([]);
  expect(fixture.state.sessions.size).toBe(0);
  expect(fixture.selections).toEqual([]);
  assertFixture(fixture.state);
});
