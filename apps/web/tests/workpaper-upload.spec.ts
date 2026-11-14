import {UPLOAD_BYTES_PENDING_FIELD_ERROR} from '@bondbuddy/contracts';
import {hold,check} from './upload-progress-fixtures';
import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';
import type {WorkpaperCatalogue,WorkpaperWorkspace,WorkpaperCataloguePreview,WorkpaperImport} from '@bondbuddy/contracts';

const file={name:'合成无表头目录.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic directory upload bytes')};
const journalPrefix=`bondbuddy:upload-recovery:v1:${ids.owner}:${ids.api}:workpaper-catalogue:`;
async function setup(page:Page){
  const uploads=await fixture(page),data:WorkpaperWorkspace={catalogues:[],batches:[],assessments:[]};
  const state={uploads,data,imports:[] as WorkpaperImport[],previews:[] as any[],review:false,failure:null as null|'invalid'|'lost'};
  const entries=['1','1-1','1-1-1'].map((code,i)=>({id:'item-'+i,code,title:'合成核查 '+i,folder:'',kind:'file' as const,path:code+' 合成核查.docx',row:i+2,sheet:'目录',instructions:''}));
  const saved=new Map<string,WorkpaperCatalogue>();
  await page.route('**/api/v1/projects/*/workpapers**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(req.method()==='GET'&&path.endsWith('/workpapers'))return route.fulfill({json:data});
    if(req.method()==='POST'&&path.endsWith('/catalogue-preview')){
      const input=req.postDataJSON();state.previews.push(input);
      const preview:WorkpaperCataloguePreview={filename:file.name,entries,warnings:state.review?['部分有内容的列尚未使用，请核对。']:[],needs_review:state.review,
        mapping:input.mapping??[{sheet:'目录',first_row:2,last_row:4,title_column:1,code_column:0,folder_columns:[],instruction_columns:[],split_code:false}],
        sheets:[{name:'目录',last_row:4,columns:[{index:0,label:'A',sample:'1 / 1-1 / 1-1-1'},{index:1,label:'B',sample:'合成核查 0 / 合成核查 1'},{index:2,label:'C',sample:'核查要求'}],sample_rows:[{row:1,cells:['合成公司目录']},...entries.map(e=>({row:e.row,cells:[e.code,e.title,'核查要求']}))]}],unrecognized_rows:[],unrecognized_count:0};
      return route.fulfill({json:preview});
    }
    if(req.method()==='POST'&&path.endsWith('/catalogues')){
      const input=req.postDataJSON();state.imports.push(input);
      expect(uploads.materials.has(input.material.material_id)).toBe(true);
      if(state.failure==='invalid')return route.fulfill({status:422,json:{code:'VALIDATION_FAILED',retryable:false,correlation_id:'synthetic-catalogue-error'}});
      const cat=saved.get(input.request_id)??{catalogue_id:'catalogue-'+saved.size,filename:file.name,sha256:sha,created_at:now,warnings:[],
        entries};
      if(!saved.has(input.request_id)){saved.set(input.request_id,cat);data.catalogues.unshift(cat);}
      if(state.failure==='lost'){state.failure=null;return route.abort('failed');}
      return route.fulfill({json:cat});
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  // Exercise the retained compatibility screen; ordinary new entries use unified preparation.
  await page.goto('/'+href({step:'workpapers',legacy:'1'}));
  await expect(page.locator('#wp-upload')).toBeEnabled();return state;
}
const records=(page:Page)=>page.evaluate(prefix=>Object.entries(localStorage).filter(([key])=>key.startsWith(prefix)).map(([key,raw])=>({key,record:JSON.parse(raw)})),journalPrefix);

test('directory import succeeds automatically and enables the next step without starting generation',async({page})=>{
  const state=await setup(page);await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('.wp-directory-current')).toContainText(file.name);
  await expect(page.locator('[data-wp-item]')).toHaveCount(3);await expect(page.locator('#wp-start')).toBeEnabled();
  await expect(page.locator('#wp-change-directory')).toBeEnabled();
  await page.locator('#wp-none').click();await expect(page.locator('#wp-start')).toBeDisabled();
  await page.locator('[data-wp-item]').first().check();
  await page.locator('#wp-requirements').fill('合成范围回归：只编制所选一份');
  if(process.env.BB_UX_EVIDENCE){await mkdir(process.env.BB_UX_EVIDENCE,{recursive:true});await page.setViewportSize({width:1366,height:768});await page.locator('#wp-requirements').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(process.env.BB_UX_EVIDENCE,'workpaper-editable.png')});}
  expect(await records(page)).toEqual([]);expect(state.imports).toHaveLength(1);expect(state.uploads.puts).toBe(1);
  await page.locator('#wp-start').click();await expect(page.locator('#wp-confirmation-page')).toContainText('1 份文件');
  await expect(page.locator('#wp-confirmation-page')).toContainText('4,500');
  await expect(page.locator('#wp-confirmation-page')).toContainText('合成范围回归');
  if(process.env.BB_UX_EVIDENCE)await page.screenshot({path:resolve(process.env.BB_UX_EVIDENCE,'workpaper-selected-confirmation.png')});
  await page.locator('#wp-confirm-back').click();await page.reload();
  await expect(page.locator('[data-wp-item]:checked')).toHaveCount(1);
  await expect(page.locator('#wp-requirements')).toHaveValue('合成范围回归：只编制所选一份');
  expect(state.uploads.calls.some(c=>c.method==='POST'&&/batches|execute/.test(c.path))).toBe(false);
});

test('rejected interpretation opens review; identical bytes reuse the saved upload',async({page})=>{
  const state=await setup(page);state.failure='invalid';await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('#wp-status')).toContainText('目录未识别成功');
  await expect(page.locator('#wp-upload-recovery')).toContainText('已上传，目录待识别');
  await expect(page.locator('[data-wp-reselect]')).toHaveCount(0);
  const original=state.imports[0];await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('#wp-accept-mapping')).toBeEnabled();expect(state.imports).toHaveLength(1);
  expect(await records(page)).toHaveLength(1);expect(state.uploads.puts).toBe(1);
  state.failure=null;await page.locator('#wp-accept-mapping').click();
  await expect(page.locator('#wp-start')).toBeEnabled();expect(state.imports[1].request_id).toBe(original.request_id);expect(state.imports[1].mapping).toHaveLength(1);expect(state.uploads.puts).toBe(1);
});

test('lost catalogue response survives reload with the same request and no second upload',async({page})=>{
  const state=await setup(page);state.failure='lost';await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('[data-wp-upload]')).toHaveCount(1);const original=state.imports[0];
  await page.reload();await expect(page.getByRole('button',{name:'继续识别目录',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'继续识别目录',exact:true}).click();
  await expect(page.locator('[data-wp-upload]')).toHaveCount(0);expect(state.imports).toEqual([original,original]);
  expect(state.data.catalogues).toHaveLength(1);expect(state.uploads.puts).toBe(1);
});

test('unified entry resumes an old unresolved catalogue import without another upload or changed request',async({page})=>{
  const state=await setup(page);state.failure='lost';await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('[data-wp-upload]')).toHaveCount(1);const original=state.imports[0];
  await page.goto('/'+href({step:'prepare'}));await expect(page).toHaveURL(/step=workpapers/);
  await expect(page.getByRole('button',{name:'继续识别目录',exact:true})).toBeVisible();
  expect(state.imports).toEqual([original]);
  await page.getByRole('button',{name:'继续识别目录',exact:true}).click();
  await expect(page.locator('[data-wp-upload]')).toHaveCount(0);
  expect(state.imports).toEqual([original,original]);expect(state.uploads.puts).toBe(1);
  expect(await records(page)).toEqual([]);
  expect(state.uploads.calls.some(c=>c.method==='POST'&&/batches|execute/.test(c.path))).toBe(false);
});

test('successful retry clears duplicate saved receipts left by the old screen',async({page})=>{
  const state=await setup(page);state.failure='invalid';await page.locator('#wp-upload').setInputFiles(file);
  await expect.poll(()=>state.imports.length).toBe(1);await expect(page.locator('[data-wp-upload]')).toHaveCount(1);
  await page.evaluate(prefix=>{
    const [key,raw]=Object.entries(localStorage).find(([key])=>key.startsWith(prefix))!;
    const original=JSON.parse(raw);
    for(let i=1;i<=2;i++){const id='old-duplicate-'+i;localStorage.setItem(prefix+id+':slot',JSON.stringify({...original,id,context:undefined}));}
  },journalPrefix);
  await page.reload();await expect(page.locator('[data-wp-upload]')).toHaveCount(3);state.failure=null;
  await page.locator(`[data-wp-upload="${state.imports[0].request_id}"]`).click();await expect(page.locator('#wp-accept-mapping')).toBeEnabled();await page.locator('#wp-accept-mapping').click();await expect(page.locator('#wp-start')).toBeEnabled();
  expect(await records(page)).toEqual([]);expect(state.uploads.puts).toBe(1);expect(state.data.catalogues).toHaveLength(1);
});

test('same filename with changed content remains a separate upload',async({page})=>{
  const state=await setup(page);state.failure='invalid';await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('[data-wp-upload]')).toHaveCount(1);
  await page.locator('#wp-upload').setInputFiles({...file,buffer:Buffer.from('different directory upload bytes')});
  await expect(page.locator('[data-wp-upload]')).toHaveCount(2);
  expect(state.uploads.puts).toBe(2);expect(state.imports[1].request_id).not.toBe(state.imports[0].request_id);
});

test('missing bytes after reload request the original file and preserve the original operation',async({page})=>{
  await page.clock.install();const state=await setup(page);state.uploads.sessionLifetimeMs=10_000;let loseBytes=true;
  await page.route('**/materials/uploads/*/bytes',async route=>{if(loseBytes){loseBytes=false;return route.abort('failed');}return route.fallback();});
  await page.route('**/materials/uploads/*/complete',async route=>{
    const id=new URL(route.request().url()).pathname.split('/').at(-2)!;
    if(!state.uploads.sessions.get(id)?.received)return route.fulfill({status:422,json:{code:'MATERIAL_UNREADABLE',message:'Synthetic original bytes have not arrived',retryable:false,correlation_id:'workpaper-bytes-pending',field_errors:[{...UPLOAD_BYTES_PENDING_FIELD_ERROR,message:'Upload bytes not received'}]}});
    return route.fallback();
  });
  const missingReply=page.waitForResponse(r=>r.url().endsWith('/complete')&&r.status()===422);await page.locator('#wp-upload').setInputFiles(file);await missingReply;await page.clock.fastForward(600_001);await expect(page.locator('[data-wp-upload]')).toBeEnabled();await expect(page.locator('[data-wp-upload]')).toHaveCount(1);
  const original=(await records(page))[0].record.id;
  await page.reload();await expect(page.locator('[data-wp-reselect]')).toBeVisible();const beforeReselect=state.uploads.calls.filter(c=>c.method!=='GET').length;
  await page.locator('[data-wp-reselect]').setInputFiles({...file,buffer:Buffer.alloc(file.buffer.length,88)});
  await expect(page.locator('#wp-status')).toContainText('冲突');expect(state.imports).toHaveLength(0);expect(state.uploads.calls.filter(c=>c.method!=='GET')).toHaveLength(beforeReselect);
  await page.locator('[data-wp-reselect]').setInputFiles(file);await expect(page.locator('#wp-start')).toBeEnabled();
  expect(state.imports[0].request_id).toBe(original);expect(state.uploads.puts).toBe(1);expect(await records(page)).toEqual([]);
});

test('removing a failed import only removes its local reminder',async({page})=>{
  const state=await setup(page);state.failure='invalid';await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.getByRole('button',{name:'移除待办',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'移除待办',exact:true}).click();await expect(page.locator('[data-wp-upload]')).toHaveCount(0);
  expect(state.uploads.materials.size).toBe(1);expect(state.uploads.calls.some(c=>c.method==='DELETE')).toBe(false);
});

for(const width of [1440,390])test(`saved directory recovery is readable without file reselection ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});const state=await setup(page);state.failure='invalid';
  await page.locator('#wp-upload').setInputFiles(file);await expect(page.locator('.wp-upload-recovery-item')).toContainText('已上传，目录待识别');
  await expect(page.locator('[data-wp-upload]')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await mkdir('test-evidence/workpaper-upload-20261029',{recursive:true});
  await page.screenshot({path:`test-evidence/workpaper-upload-20261029/recovery-${width}.png`,fullPage:true});
  await page.locator('.wp-upload-recovery-item').screenshot({path:`test-evidence/workpaper-upload-20261029/recovery-card-${width}.png`});
});

test('ambiguous directory previews before import; adjustments survive reload and lost save replays exactly',async({page})=>{
  const state=await setup(page);state.review=true;await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('#wp-accept-mapping')).toBeEnabled();expect(state.imports).toHaveLength(0);
  await page.getByText('分类、编制要求与编号设置',{exact:true}).click();
  await page.locator('[data-list=instruction_columns][value="2"]').check();
  await expect(page.locator('#wp-accept-mapping')).toBeDisabled();
  await page.locator('#wp-preview-again').click();await expect(page.locator('#wp-accept-mapping')).toBeEnabled();
  expect(state.previews.at(-1).mapping[0].instruction_columns).toEqual([2]);
  await page.reload();await page.getByRole('button',{name:'继续识别目录',exact:true}).click();
  await expect(page.locator('#wp-accept-mapping')).toBeEnabled();expect(state.previews.at(-1).mapping[0].instruction_columns).toEqual([2]);
  state.failure='lost';await page.locator('#wp-accept-mapping').click();await expect(page.locator('#wp-status')).toContainText('保存结果尚未确认');
  const confirmed=state.imports[0];expect(confirmed.mapping![0].instruction_columns).toEqual([2]);
  await page.reload();await page.getByRole('button',{name:'继续识别目录',exact:true}).click();await expect(page.locator('#wp-start')).toBeEnabled();
  expect(state.imports).toEqual([confirmed,confirmed]);expect(state.uploads.puts).toBe(1);expect(state.data.catalogues).toHaveLength(1);
});

test('invalid mappings are corrected in place without upload or import',async({page})=>{
  const state=await setup(page);state.review=true;await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('#wp-accept-mapping')).toBeEnabled();await page.locator('[data-field=code_column]').selectOption('1');
  await page.locator('#wp-preview-again').click();await expect(page.locator('#wp-status')).toContainText('每一列只能用于一种用途');
  expect(state.imports).toHaveLength(0);expect(state.previews).toHaveLength(1);expect(state.uploads.puts).toBe(1);
});

for(const width of [1440,390])test(`directory interpretation preview remains usable ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});const state=await setup(page);state.review=true;await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('#wp-accept-mapping')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:`test-evidence/workpaper-upload-20261029/interpretation-${width}.png`,fullPage:true});
  await page.locator('#wp-import-review').screenshot({path:`test-evidence/workpaper-upload-20261029/interpretation-card-${width}.png`});
});

for(const width of [1440,390])test(`directory interpretation prototype ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});const prototype=resolve(process.cwd(),'../../product-prototype/public/workpaper-batch.html').replaceAll('\\','/');await page.goto('/@fs/'+prototype+'?upload=review');
  await expect(page.locator('#wp-accept-mapping')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:`test-evidence/workpaper-upload-20261029/prototype-interpretation-${width}.png`,fullPage:true});
  await page.locator('#wp-import-review').screenshot({path:`test-evidence/workpaper-upload-20261029/prototype-interpretation-card-${width}.png`});
  await page.locator('.wp-mapping-fields select').first().selectOption('2');await expect(page.locator('#wp-accept-mapping')).toBeDisabled();
  await page.locator('#wp-preview-again').click();await expect(page.locator('#wp-accept-mapping')).toBeEnabled();
  await page.locator('#wp-accept-mapping').click();await expect(page.locator('#wp-import-review')).toHaveCount(0);
});

test('directory upload shows transfer progress then recognition without a fake percentage',async({page})=>{
 await setup(page);await hold(page);await page.locator('#wp-upload').setInputFiles(file);
 await check(page,page.locator('#wp-status progress'),'workpaper-directory',1440);await expect(page.locator('#wp-status progress')).toHaveCount(0);
});
