import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const prototypeRoot='/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/',import.meta.url)).replaceAll('\\','/');

// Real component, synthetic API responses. No model calls, storage or billing.
async function setup(page:Page,{versions=false,purpose='update',retry=false}={}){
  await page.route('**/panel-harness',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main style="max-width:1160px;margin:0 auto;padding:32px 20px"><div id="panel"></div></main></body></html>`}));
  await page.goto('/panel-harness');
  await page.evaluate(async({versions,purpose,retry,prototypeRoot})=>{
    const load=(path:string)=>import(path);
    // Match the application's base styles; the component imports its own scoped CSS.
    await load('/src/style.css');
    await load('/src/update-entry.css');
    await load(prototypeRoot+'styles.css');
    await load(prototypeRoot+'project-workspace.css');
    await load('/src/prototype-adapter.css');
    const {ProspectusPanel}=await load('/src/prospectus-panel.ts');
    const {ApiError}=await load('/src/api.ts');
    const hash='a'.repeat(64),now='2026-10-25T02:00:00Z';
    const version=(sequence:number)=>({version_id:`v${sequence}`,sequence,filename:sequence===1?'合成历史募集书.docx':'合成发行人2026年度第一期公司债券募集说明书_提交审阅稿_含财务与风险披露_修订后清洁版.docx',origin:sequence===1?'upload':'generated',created_at:now,material_id:'m1',material_version:1,artifact_id:sequence===1?null:'clean',artifact_version:1,revision_artifact_id:sequence===1?null:'revision',sha256:hash});
    let state={selection_revision:2,current_version_id:versions?'v2':null,versions:versions?[version(1),version(2)]:[],inactive_material_ids:[]};
    const calls:any[]=[];let fail=retry;
    const api={
      prospectusVersions:async()=>structuredClone(state),
      createUpload:async(id:string,input:any)=>{calls.push(['create',input]);return{upload_id:'u1',upload_url:'synthetic',expires_at:'2099-01-01T00:00:00Z'};},
      uploadBytes:async(url:string,file:File,progress:any)=>{calls.push(['bytes',file.name]);progress(file.size,file.size);},
      completeUpload:async()=>{calls.push(['complete']);return{material_id:'m3',material_version:1};},
      saveProspectus:async(id:string,input:any)=>{calls.push(['save',input]);if(fail){fail=false;throw new ApiError(503,'DATA_UNAVAILABLE');}state={...state,current_version_id:'v3',selection_revision:3,versions:[...state.versions,{...version(3),filename:'合成新稿.docx',origin:'upload'}]};return state;},
      selectProspectus:async(id:string,input:any)=>{calls.push(['select',input]);state={...state,current_version_id:input.version_id,selection_revision:3};return state;},
      artifact:async(id:string)=>({artifact_id:id,version:1,sha256:hash}),
      artifactBytes:async()=>new Blob(['synthetic word']),
      material:async()=>({material_version:1,sha256:hash}),
      materialBytes:async()=>new Blob(['synthetic source'])
    };
    let panel:any;
    const mount=async()=>{panel?.dispose();panel=new ProspectusPanel(api,'synthetic-project',document.querySelector('#panel'),async()=>true,mount,()=>{},purpose);await panel.refresh();};
    await mount();
    Object.assign(window,{panelFixture:{calls,refresh:()=>panel.refresh()}});
  },{versions,purpose,retry,prototypeRoot});
  await expect(page.getByRole('heading',{name:'项目募集说明书'})).toBeVisible();
}

test('empty state exposes upload, hides empty history, and fits phone widths',async({page})=>{
  await setup(page);
  await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeVisible();
  await expect(page.locator('.prospectus-history')).toHaveCount(0);
  await expect(page.getByText('尚未保存募集说明书')).toBeVisible();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'上传募集说明书',exact:true}).click();await chooser;
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:960});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const card=await page.locator('.prospectus-panel').boundingBox(),heading=await page.getByRole('heading',{name:'项目募集说明书'}).boundingBox();
    expect(heading!.x-card!.x).toBeGreaterThanOrEqual(18);
  }
});

test('selection is explicit, survives refresh, and can be cancelled or corrected',async({page})=>{
  await setup(page);
  await page.getByLabel('募集书新版本文件').setInputFiles({name:'错误.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});
  await page.evaluate(()=>window.panelFixture.refresh());
  await expect(page.getByRole('alert')).toContainText('请上传不超过 100 MB');
  await expect(page.getByRole('button',{name:'保存为当前版本'})).toBeDisabled();
  await page.getByLabel('募集书新版本文件').setInputFiles({name:'合成新稿.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic')});
  await page.evaluate(()=>window.panelFixture.refresh());
  await expect(page.locator('.prospectus-selected-file')).toContainText('合成新稿.docx');
  expect(await page.evaluate(()=>window.panelFixture.calls)).toEqual([]);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.locator('.prospectus-upload')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'上传募集说明书',exact:true})).toBeFocused();
});

test('failed save keeps the file and retries the same version request without reupload',async({page})=>{
  await setup(page,{retry:true});
  await page.getByLabel('募集书新版本文件').setInputFiles({name:'合成新稿.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic')});
  await page.getByRole('button',{name:'保存为当前版本'}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.prospectus-selected-file')).toContainText('合成新稿.docx');
  await page.getByRole('button',{name:'保存为当前版本'}).click();
  await expect(page.locator('.prospectus-current-file')).toContainText('当前版本 · V3');
  await expect(page.locator('.prospectus-upload')).toHaveCount(0);
  const calls=await page.evaluate(()=>window.panelFixture.calls);
  expect(calls.filter(c=>c[0]==='bytes')).toHaveLength(1);
  const saves=calls.filter(c=>c[0]==='save');expect(saves).toHaveLength(2);expect(saves[0][1]).toEqual(saves[1][1]);
});

test('current version downloads directly, history switches versions and preserves disclosure on refresh',async({page})=>{
  await setup(page,{versions:true});
  const download=page.waitForEvent('download');await page.locator('.prospectus-current-file').getByRole('button',{name:'下载清洁版'}).click();
  expect((await download).suggestedFilename()).toBe('募集说明书_V2_清洁版.docx');
  await page.locator('.prospectus-history summary').focus();await page.keyboard.press('Enter');
  await expect(page.locator('.prospectus-history')).toHaveAttribute('open','');
  await page.evaluate(()=>window.panelFixture.refresh());await expect(page.locator('.prospectus-history')).toHaveAttribute('open','');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'设为当前版本'}).click();
  await expect(page.locator('.prospectus-current-file')).toContainText('当前版本 · V1');
  const calls=await page.evaluate(()=>window.panelFixture.calls);expect(calls.find(c=>c[0]==='select')[1]).toMatchObject({version_id:'v1',expected_selection_revision:2});
});

test('generation guidance and same-size visual evidence',async({page})=>{
  await setup(page,{purpose:'generation'});
  await expect(page.getByText('上传募集说明书后，即可选择需要生成的文件。')).toBeVisible();
  await expect(page.locator('.prospectus-upload-hint')).toContainText('不启动生成或扣费');
  const out=process.env.BB_PANEL_EVIDENCE;if(!out)return;
  await mkdir(out,{recursive:true});
  for(const state of ['empty','current'])for(const width of [1440,390]){
    await page.setViewportSize({width,height:960});await setup(page,{versions:state==='current'});
    await page.locator('.prospectus-panel').screenshot({path:`${out}/implementation-${state}-${width}.png`});
    await page.goto(prototypeRoot+'prospectus-panel.html?state='+state);
    await page.locator('.prospectus-panel').screenshot({path:`${out}/prototype-${state}-${width}.png`});
  }
});

declare global{interface Window{panelFixture:{calls:any[];refresh:()=>Promise<void>}}}
