import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';
import type {WorkpaperCatalogue,WorkpaperWorkspace} from '@bondbuddy/contracts';

const file={name:'合成无表头目录.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic directory upload bytes')};
const journalPrefix=`bondbuddy:upload-recovery:v1:${ids.owner}:${ids.api}:workpaper-catalogue:`;
async function setup(page:Page){
  const uploads=await fixture(page),data:WorkpaperWorkspace={catalogues:[],batches:[],assessments:[]};
  const state={uploads,data,imports:[] as {request_id:string;material:{material_id:string}}[],failure:null as null|'invalid'|'lost'};
  const saved=new Map<string,WorkpaperCatalogue>();
  await page.route('**/api/v1/projects/*/workpapers**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(req.method()==='GET'&&path.endsWith('/workpapers'))return route.fulfill({json:data});
    if(req.method()==='POST'&&path.endsWith('/catalogues')){
      const input=req.postDataJSON();state.imports.push(input);
      expect(uploads.materials.has(input.material.material_id)).toBe(true);
      if(state.failure==='invalid')return route.fulfill({status:422,json:{code:'VALIDATION_FAILED',retryable:false,correlation_id:'synthetic-catalogue-error'}});
      const cat=saved.get(input.request_id)??{catalogue_id:'catalogue-'+saved.size,filename:file.name,sha256:sha,created_at:now,warnings:[],
        entries:['1','1-1','1-1-1'].map((code,i)=>({id:'item-'+i,code,title:'合成核查 '+i,folder:'',kind:'file' as const,path:code+' 合成核查.docx',row:i+2,sheet:'目录',instructions:''}))};
      if(!saved.has(input.request_id)){saved.set(input.request_id,cat);data.catalogues.unshift(cat);}
      if(state.failure==='lost'){state.failure=null;return route.abort('failed');}
      return route.fulfill({json:cat});
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  await page.goto('/'+href({step:'workpapers'}));
  await expect(page.locator('#wp-upload')).toBeEnabled();return state;
}
const records=(page:Page)=>page.evaluate(prefix=>Object.entries(localStorage).filter(([key])=>key.startsWith(prefix)).map(([key,raw])=>({key,record:JSON.parse(raw)})),journalPrefix);

test('directory import succeeds automatically and enables the next step without starting generation',async({page})=>{
  const state=await setup(page);await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('.wp-directory-current')).toContainText(file.name);
  await expect(page.locator('[data-wp-item]')).toHaveCount(3);await expect(page.locator('#wp-start')).toBeEnabled();
  expect(await records(page)).toEqual([]);expect(state.imports).toHaveLength(1);expect(state.uploads.puts).toBe(1);
  await page.locator('#wp-start').click();await expect(page.locator('#wp-confirmation-page')).toContainText('3 份文件');
  expect(state.uploads.calls.some(c=>c.method==='POST'&&/batches|execute/.test(c.path))).toBe(false);
});

test('parse failure is distinct from upload failure; reselecting identical bytes reuses the saved request',async({page})=>{
  const state=await setup(page);state.failure='invalid';await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('#wp-status')).toContainText('目录未识别成功');
  await expect(page.locator('#wp-upload-recovery')).toContainText('已上传，目录待识别');
  await expect(page.locator('[data-wp-reselect]')).toHaveCount(0);
  const original=state.imports[0];await page.locator('#wp-upload').setInputFiles(file);
  await expect.poll(()=>state.imports.length).toBe(2);expect(state.imports[1]).toEqual(original);
  expect(await records(page)).toHaveLength(1);expect(state.uploads.puts).toBe(1);
  state.failure=null;await page.getByRole('button',{name:'继续识别目录',exact:true}).click();
  await expect(page.locator('#wp-start')).toBeEnabled();expect(state.imports[2]).toEqual(original);expect(state.uploads.puts).toBe(1);
});

test('lost catalogue response survives reload with the same request and no second upload',async({page})=>{
  const state=await setup(page);state.failure='lost';await page.locator('#wp-upload').setInputFiles(file);
  await expect(page.locator('[data-wp-upload]')).toHaveCount(1);const original=state.imports[0];
  await page.reload();await expect(page.getByRole('button',{name:'继续识别目录',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'继续识别目录',exact:true}).click();
  await expect(page.locator('[data-wp-upload]')).toHaveCount(0);expect(state.imports).toEqual([original,original]);
  expect(state.data.catalogues).toHaveLength(1);expect(state.uploads.puts).toBe(1);
});

test('successful retry clears duplicate saved receipts left by the old screen',async({page})=>{
  const state=await setup(page);state.failure='invalid';await page.locator('#wp-upload').setInputFiles(file);
  await expect.poll(()=>state.imports.length).toBe(1);await expect(page.locator('[data-wp-upload]')).toHaveCount(1);
  await page.evaluate(prefix=>{
    const [key,raw]=Object.entries(localStorage).find(([key])=>key.startsWith(prefix))!;
    const original=JSON.parse(raw);
    for(let i=1;i<=2;i++){const id='old-duplicate-'+i;localStorage.setItem(prefix+id+':slot',JSON.stringify({...original,id}));}
  },journalPrefix);
  await page.reload();await expect(page.locator('[data-wp-upload]')).toHaveCount(3);state.failure=null;
  await page.locator('[data-wp-upload]').first().click();await expect(page.locator('#wp-start')).toBeEnabled();
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
  const state=await setup(page);let loseBytes=true;
  await page.route('**/materials/uploads/*/bytes',async route=>{if(loseBytes){loseBytes=false;return route.abort('failed');}return route.fallback();});
  await page.route('**/materials/uploads/*/complete',async route=>{
    const id=new URL(route.request().url()).pathname.split('/').at(-2)!;
    if(!state.uploads.sessions.get(id)?.received)return route.fulfill({status:422,json:{code:'MATERIAL_UNREADABLE'}});
    return route.fallback();
  });
  await page.locator('#wp-upload').setInputFiles(file);await expect(page.locator('[data-wp-upload]')).toHaveCount(1);
  const original=(await records(page))[0].record.id;
  await page.reload();await page.getByRole('button',{name:'确认上传状态',exact:true}).click();
  await expect(page.locator('[data-wp-reselect]')).toBeVisible();
  await page.locator('[data-wp-reselect]').setInputFiles({...file,buffer:Buffer.alloc(file.buffer.length,88)});
  await expect(page.locator('#wp-status')).toContainText('冲突');expect(state.imports).toHaveLength(0);
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
