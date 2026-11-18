import {test,expect,type Page,type Route} from '@playwright/test';
import {fixture,href,ids,sha,now} from './generation-entry-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
import {AUTOMATIC_PRICE_VERSION,emptyFileGenerationPreparation,type FileGenerationWorkspace,type WorkpaperCatalogue} from '@bondbuddy/contracts';
import {resolve} from 'node:path';

// Real desktop controls and production component; identity, HTTP and catalogue
// are synthetic. No model, payment provider or account ledger is exercised.
const catalogue:WorkpaperCatalogue={catalogue_id:'save-feedback-cat',filename:'合成体验底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:['1','2'].map((code,i)=>({id:'entry-'+code,code,title:i?'关联方情况说明':'基本情况核查记录',folder:'',sheet:'尽职调查文件',row:i+2,instructions:'',kind:'file',path:code+'.docx'}))};
type Save={expected_revision:number;preparation:FileGenerationWorkspace['preparation']};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
async function setup(page:Page,active=false){
 const transport=await fixture(page);
 const preparation={...emptyFileGenerationPreparation(),workpaper_template_mode:'automatic' as const,catalogue_id:catalogue.catalogue_id,item_ids:['entry-1','entry-2']};
 const state={data:{revision:1,preparation,sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},pricing:{mode:'automatic',price_version:AUTOMATIC_PRICE_VERSION,workpaper_points:3458,document_points:7965},batches:[]} as FileGenerationWorkspace,saves:[] as Save[],quotes:[] as any[],submissions:[] as any[],transport};
 await page.route('**/api/v1/projects/*/file-generation**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='GET'?undefined:fixtureRequest(req);
  const reply=(value:unknown)=>route.fulfill({json:fixtureBody(route,value)});
  if(req.method()==='GET'&&path.endsWith('/progress'))return reply({revision:sha,active});
  if(req.method()==='GET'&&path.endsWith('/file-generation'))return reply(state.data);
  if(path.endsWith('/preparation')){
   state.saves.push(structuredClone(body));
   // Match the existing API's exact retry and revision-conflict semantics.
   if(state.data.revision===body.expected_revision+1&&same(state.data.preparation,body.preparation))return reply({revision:state.data.revision,preparation:state.data.preparation});
   if(state.data.revision!==body.expected_revision)return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});
   state.data.revision++;state.data.preparation=structuredClone(body.preparation);
   return reply({revision:state.data.revision,preparation:state.data.preparation});
  }
  if(path.endsWith('/quote')){
   state.quotes.push({...body,preparation:structuredClone(state.data.preparation)});
   expect(body.expected_revision).toBe(state.data.revision);
   expect(Number(body.expected_points)).toBe(state.data.preparation.item_ids.length*Number(state.data.pricing!.workpaper_points));
   return reply({count:state.data.preparation.item_ids.length,points:body.expected_points,price_version:state.data.pricing!.price_version,omitted:catalogue.entries.filter(e=>!state.data.preparation.item_ids.includes(e.id)),auto_charge:true,quote_status:'ready',documents:[]});
  }
  if(path.endsWith('/batches')){
   state.submissions.push(body);expect(body.expected_revision).toBe(state.data.revision);
   const batch={batch_id:'save-feedback-batch',created_at:now,points:body.expected_points,workpapers:null,documents:null};
   state.data.batches=[batch];
   return reply(batch);
  }
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 await page.route('**/api/v1/projects/*/workpapers/catalogues/*',route=>route.fulfill({json:catalogue}));
 if(active)state.data.batches=[{batch_id:'active-poll-batch',created_at:now,points:0,workpapers:null,documents:{batch_id:'active-docs',state:'running',items:[]}}];
 await page.goto('/'+href({step:'prepare'}).replace('#generate?', '#workpapers?'));
 await expect(page.locator('#fg-confirm')).toBeEnabled();
 // Advanced template/file mapping remains available; range adjustment now
 // focuses the chapter selector instead of opening this separate editor.
 await page.getByRole('button',{name:'查看本批清单',exact:true}).click();
 await page.getByText('补充资料与编制要求（选填）',{exact:true}).click();
 return state;
}
const first=(page:Page)=>page.locator('[data-fg-item="entry-1"]');
const second=(page:Page)=>page.locator('[data-fg-item="entry-2"]');
test.use({viewport:{width:1440,height:960}});

test('desktop selection stays immediate and editable while saves are serialized and merged',async({page},info)=>{
 const state=await setup(page),held:{body:Save;release:()=>void}[]=[];
 await page.route('**/file-generation/preparation',async route=>{
  const body=fixtureRequest(route.request());
  await new Promise<void>(release=>held.push({body:structuredClone(body),release}));
  return route.fallback();
 });
 await page.getByRole('button',{name:'取消全选',exact:true}).click();
 await expect.poll(()=>held.length).toBe(1);
 await page.screenshot({path:info.outputPath('first-save-pending.png')});
 await expect(first(page)).not.toBeChecked();
 await expect(page.locator('.fg-footer')).toContainText('本批 0 份文件');
 await expect(page.locator('#fg-controls')).toHaveJSProperty('inert',false);
 await first(page).click();await second(page).click();await first(page).click();
 await expect(first(page)).not.toBeChecked();await expect(second(page)).toBeChecked();
 await expect(page.locator('.fg-footer')).toContainText('本批 1 份文件');
 expect(held).toHaveLength(1);
 held[0].release();await expect.poll(()=>held.length).toBe(2);
 expect(held[1].body.preparation.item_ids).toEqual(['entry-2']);
 await expect(second(page)).toBeChecked();await expect(first(page)).not.toBeChecked();
 held[1].release();await expect.poll(()=>state.data.preparation.item_ids).toEqual(['entry-2']);
 await expect(page.locator('#fg-save-state')).toContainText('已保存');
 expect(state.saves.map(s=>s.expected_revision)).toEqual([1,2]);expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
 await page.screenshot({path:info.outputPath('latest-selection-saved.png')});
});

test('late save preserves requirements and caret and generation waits for the newest snapshot',async({page})=>{
 const state=await setup(page);let release!:()=>void,calls=0;
 await page.route('**/file-generation/preparation',async route=>{if(++calls===1)await new Promise<void>(r=>release=r);return route.fallback();});
 await first(page).click();await expect.poll(()=>calls).toBe(1);
 const note=page.locator('#fg-requirements');await note.fill('保留当前输入与金额单位');await note.focus();
 await note.evaluate((n:HTMLTextAreaElement)=>n.setSelectionRange(2,5));
 release();await expect.poll(()=>state.data.preparation.requirements).toBe('保留当前输入与金额单位');
 await expect(note).toBeFocused();expect(await note.evaluate((n:HTMLTextAreaElement)=>[n.selectionStart,n.selectionEnd])).toEqual([2,5]);
 let finish!:()=>void;await page.route('**/file-generation/preparation',async route=>{await new Promise<void>(r=>finish=r);return route.fallback();});
 await first(page).click();await expect.poll(()=>!!finish).toBe(true);
 await page.locator('#fg-confirm').click();expect(state.quotes).toHaveLength(0);expect(state.submissions).toHaveLength(0);
 finish();await expect.poll(()=>state.submissions.length).toBe(1);
 expect(state.quotes).toHaveLength(1);expect(state.quotes[0].preparation.item_ids).toEqual(['entry-2','entry-1']);
 expect(state.quotes[0].preparation.requirements).toBe('保留当前输入与金额单位');expect(Number(state.submissions[0].expected_points)).toBe(6916);
});

test('failed save keeps the local range across refresh and retries without quoting unsaved work',async({page})=>{
 const state=await setup(page);let failing=true;
 await page.route('**/file-generation/preparation',route=>failing?route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',retryable:true}}):route.fallback());
 await first(page).click();await expect(page.locator('#fg-save-retry')).toBeVisible();
 await expect(first(page)).not.toBeChecked();await page.locator('#fg-confirm').click();
 expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
 await page.reload();await page.getByRole('button',{name:'查看本批清单',exact:true}).click();await expect(first(page)).not.toBeChecked();await expect(second(page)).toBeChecked();
 failing=false;await page.locator('#fg-save-retry').click();await expect(page.locator('#fg-save-state')).toContainText('已保存');
 expect(state.data.preparation.item_ids).toEqual(['entry-2']);expect(state.quotes).toEqual([]);
});

for(const refresh of [false,true])test(`unknown save result preserves its original snapshot before newer edits, refresh=${refresh}`,async({page})=>{
 const state=await setup(page);let calls=0;
 await page.route('**/file-generation/preparation',async route=>{
  if(++calls!==1)return route.fallback();
  const body=fixtureRequest(route.request());state.data.revision++;state.data.preparation=structuredClone(body.preparation);return route.abort('failed');
 });
 await first(page).click();await expect(page.locator('#fg-save-retry')).toBeVisible();
 await second(page).click();await expect(second(page)).not.toBeChecked();
 if(refresh){
  await page.evaluate(key=>{const cached=JSON.parse(localStorage.getItem(key)!);cached.modeDrafts={custom:{...cached.preparation,requirements:'保留切换模式草稿'}};cached.custom=true;localStorage.setItem(key,JSON.stringify(cached));},`bb-file-generation-v2:${ids.owner}:${ids.api}`);
  await page.reload();await page.reload();await page.getByRole('button',{name:'查看本批清单',exact:true}).click();await expect(first(page)).not.toBeChecked();await expect(second(page)).not.toBeChecked();
  const cached=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),`bb-file-generation-v2:${ids.owner}:${ids.api}`);expect(cached.modeDrafts.custom.requirements).toBe('保留切换模式草稿');expect(cached.custom).toBe(true);
 }
 await page.locator('#fg-save-retry').click();await expect(page.locator('#fg-save-state')).toContainText('已保存');
 expect(state.data.revision).toBe(3);expect(state.data.preparation.item_ids).toEqual([]);expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
});

test('another page revision keeps the local draft and blocks save and generation',async({page})=>{
 const state=await setup(page);let release!:()=>void;
 await page.route('**/file-generation/preparation',async route=>{await new Promise<void>(r=>release=r);return route.fallback();});
 await first(page).click();await expect.poll(()=>!!release).toBe(true);
 state.data.revision++;state.data.preparation={...state.data.preparation,requirements:'另一页面已保存的要求'};release();
 await expect(page.locator('#fg-save-state')).toContainText('另一页面');await expect(first(page)).not.toBeChecked();
 await expect(page.locator('#fg-confirm')).toBeDisabled();
 await page.reload();await expect(page.locator('#fg-save-state')).toContainText('另一页面');await expect(page.locator('#fg-confirm')).toBeDisabled();
 expect(state.data.preparation.item_ids).toEqual(['entry-1','entry-2']);expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
});

test('keyboard Space and Tab retain focus through immediate selection renders',async({page})=>{
 const state=await setup(page);let release!:()=>void,calls=0;
 await page.route('**/file-generation/preparation',async route=>{if(++calls===1)await new Promise<void>(r=>release=r);return route.fallback();});
 await first(page).focus();await page.keyboard.press('Space');await expect(first(page)).not.toBeChecked();await expect(first(page)).toBeFocused();
 await expect.poll(()=>calls).toBe(1);await page.keyboard.press('Tab');await expect(second(page)).toBeFocused();
 await page.keyboard.press('Space');await expect(second(page)).not.toBeChecked();await expect(second(page)).toBeFocused();
 release();await expect(page.locator('#fg-save-state')).toContainText('已保存');expect(state.data.preparation.item_ids).toEqual([]);
});

test('the explicit save action also leaves later range edits available',async({page})=>{
 const state=await setup(page);let release!:()=>void,calls=0;
 await page.route('**/file-generation/preparation',async route=>{if(++calls===1)await new Promise<void>(r=>release=r);return route.fallback();});
 await page.locator('#fg-requirements').fill('合成手动保存要求');await page.locator('#fg-save').click();await expect.poll(()=>calls).toBe(1);
 await expect(page.locator('#fg-controls')).toHaveJSProperty('inert',false);await first(page).click();await expect(first(page)).not.toBeChecked();
 release();await expect(page.locator('#fg-save-state')).toContainText('已保存');expect(state.data.preparation.item_ids).toEqual(['entry-2']);expect(state.data.preparation.requirements).toBe('合成手动保存要求');
});

test('document type, year, template and requirements join the latest save snapshot',async({page})=>{
 const state=await setup(page);await page.goto('/'+href({step:'prepare'}));await expect(page.locator('.fg-file-choices')).toBeVisible();
 await page.getByText('补充资料与编制要求（选填）',{exact:true}).click();
 const savedBeforeEdits=state.saves.length;let release!:()=>void,calls=0;
 await page.route('**/file-generation/preparation',async route=>{if(++calls===1)await new Promise<void>(r=>release=r);return route.fallback();});
 await page.locator('[data-fg-type="annual"]').check();await expect.poll(()=>calls).toBe(1);
 await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 await page.locator('[data-fg-general="annual"]').selectOption('private|template-annual');
 await page.locator('#fg-requirements').fill('保留合成年度要求');release();
 await expect(page.locator('#fg-save-state')).toContainText('已保存');
 expect(state.data.preparation).toMatchObject({item_ids:['entry-1','entry-2'],document_types:['annual'],target_year:'2026',requirements:'保留合成年度要求',document_templates:{annual:{private_template:{template_id:'template-annual',template_version:1}}}});
 expect(state.saves).toHaveLength(savedBeforeEdits+2);expect(state.quotes).toEqual([]);
});

test('changing the source waits for the full queue and stays put if its final save fails',async({page})=>{
 const state=await setup(page);let release!:()=>void,calls=0,failing=true;
 await page.route('**/file-generation/preparation',async route=>{
  if(++calls===1){await new Promise<void>(r=>release=r);return route.fallback();}
  return failing?route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',retryable:true}}):route.fallback();
 });
 await page.getByRole('button',{name:'取消全选',exact:true}).click();await expect.poll(()=>calls).toBe(1);await first(page).click();
 await page.locator('#fg-requirements').fill('切换募集书前必须保留');
 await page.getByRole('link',{name:'更换募集说明书',exact:true}).click();
 await expect(page.locator('#fg-controls')).toBeVisible();release();
 await expect(page.locator('#fg-save-retry')).toBeVisible();await expect(page).toHaveURL(/step=prepare/);
 await expect(first(page)).toBeChecked();await expect(second(page)).not.toBeChecked();await expect(page.locator('#fg-requirements')).toHaveValue('切换募集书前必须保留');
 expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
 failing=false;await page.getByRole('link',{name:'更换募集说明书',exact:true}).click();
 await expect(page).toHaveURL(/step=source/);await expect(page.locator('#fg-controls')).toHaveCount(0);
 expect(state.data.preparation.item_ids).toEqual(['entry-1']);expect(state.data.preparation.requirements).toBe('切换募集书前必须保留');
});

test('progress refresh and the polling reply preserve an active requirements draft and caret',async({page})=>{
 await page.clock.install();const state=await setup(page,true);let release!:()=>void,reads=0;
 await page.route('**/api/v1/projects/*/file-generation',async route=>{if(++reads===1)await new Promise<void>(r=>release=r);return route.fallback();});
 const note=page.locator('#fg-requirements');await note.fill('保留当前输入');await note.focus();await note.evaluate((n:HTMLTextAreaElement)=>n.setSelectionRange(1,3));
 // Trigger the real refresh handler while the editor keeps keyboard focus.
 await page.locator('#fg-refresh').evaluate((n:HTMLButtonElement)=>n.click());await expect.poll(()=>reads).toBe(1);
 await note.dispatchEvent('compositionstart');await note.fill('保留当前输入和中文组词');
 await note.evaluate((n:HTMLTextAreaElement)=>n.setSelectionRange(2,5));
 await page.clock.fastForward(15_001);await expect.poll(()=>reads).toBeGreaterThanOrEqual(2);release();
 await expect(page.locator('.fg-status')).toContainText('已刷新');await expect(note).toBeFocused();
 expect(await note.evaluate((n:HTMLTextAreaElement)=>[n.selectionStart,n.selectionEnd])).toEqual([2,5]);await expect(note).toHaveValue('保留当前输入和中文组词');await note.dispatchEvent('compositionend');
 const cached=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),`bb-file-generation-v2:${ids.owner}:${ids.api}`);
 expect(cached.dirty).toBe(true);expect(cached.preparation.requirements).toBe('保留当前输入和中文组词');expect(state.saves).toEqual([]);expect(state.quotes).toEqual([]);
});

test('a malformed in-flight cache cannot bypass a newer server revision',async({page})=>{
 const state=await setup(page);
 await page.evaluate(({key,preparation})=>localStorage.setItem(key,JSON.stringify({revision:0,dirty:true,preparation:{...preparation,item_ids:['entry-2']},preparation_save:{expected_revision:'invalid',preparation}})),{key:`bb-file-generation-v2:${ids.owner}:${ids.api}`,preparation:state.data.preparation});
 await page.reload();await expect(page.locator('#fg-save-state')).toContainText('另一页面');await expect(page.locator('#fg-controls')).toHaveJSProperty('inert',true);await expect(page.locator('#fg-confirm')).toBeDisabled();
 expect(state.saves).toEqual([]);expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
});

test('a conflicting draft without a catalogue is retained without loading defaults',async({page})=>{
 const state=await setup(page);let builtin=0;
 await page.route('**/file-generation/builtin',route=>{builtin++;return route.fulfill({json:fixtureBody(route,{catalogue})});});
 const local={...state.data.preparation,catalogue_id:null,item_ids:[],requirements:'冲突草稿原要求'};
 await page.evaluate(({key,preparation})=>localStorage.setItem(key,JSON.stringify({revision:0,dirty:true,preparation})),{key:`bb-file-generation-v2:${ids.owner}:${ids.api}`,preparation:local});
 await page.reload();await expect(page.locator('#fg-save-state')).toContainText('另一页面');await expect(page.locator('#fg-controls')).toHaveJSProperty('inert',true);
 await expect(page.locator('#fg-requirements')).toHaveValue(local.requirements);expect(builtin).toBe(0);expect(state.saves).toEqual([]);
 const cached=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),`bb-file-generation-v2:${ids.owner}:${ids.api}`);expect(cached.preparation).toEqual(local);
});

for(const failure of [false,true])test(`a delayed progress reply cannot hide a submitted batch or its confirmation, failure=${failure}`,async({page})=>{
 const state=await setup(page);let release!:()=>void;
 await page.route('**/api/v1/projects/*/file-generation',async route=>{const snapshot=structuredClone(state.data);await new Promise<void>(r=>release=r);return failure?route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}}):route.fulfill({json:fixtureBody(route,snapshot)});});
 await page.locator('#fg-refresh').click();await expect.poll(()=>!!release).toBe(true);
 await page.locator('#fg-confirm').click();await expect(page.locator('.fg-status')).toContainText('已提交');expect(state.submissions).toHaveLength(1);
 await expect(page.locator('.fg-history article')).toHaveCount(1);const response=page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname.endsWith('/file-generation'));release();await response;
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(page.locator('.fg-history article')).toHaveCount(1);await expect(page.locator('.fg-status')).toContainText('已提交');expect(state.submissions).toHaveLength(1);
});

test('a later local-storage failure shows a locked recoverable draft before any save or quote',async({page})=>{
 const state=await setup(page);
 await page.evaluate(key=>{const original=Storage.prototype.setItem;let calls=0;Storage.prototype.setItem=function(k,v){if(k===key&&++calls===2)throw new DOMException('synthetic quota','QuotaExceededError');return original.call(this,k,v);};},`bb-file-generation-v2:${ids.owner}:${ids.api}`);
 await first(page).click();await expect(page.locator('#fg-save-state')).toContainText('无法保存');await expect(page.locator('#fg-reload')).toBeVisible();await expect(page.locator('#fg-controls')).toHaveJSProperty('inert',true);
 expect(state.saves).toEqual([]);expect(state.quotes).toEqual([]);
 await page.reload();await page.getByRole('button',{name:'查看本批清单',exact:true}).click();await expect(first(page)).not.toBeChecked();
 await page.locator('#fg-save-retry').click();await expect(page.locator('#fg-save-state')).toContainText('已保存');expect(state.data.preparation.item_ids).toEqual(['entry-2']);
});

test('refreshed prices update the visible estimate before the exact automatic quote',async({page})=>{
 const state=await setup(page);state.data.pricing={...state.data.pricing!,workpaper_points:4500,price_version:'synthetic-refreshed-tariff'};
 await page.locator('#fg-refresh').click();await expect(page.locator('.fg-footer')).toContainText('9,000 积分');
 await page.locator('#fg-confirm').click();await expect.poll(()=>state.submissions.length).toBe(1);
 expect(Number(state.quotes[0].expected_points)).toBe(9000);expect(state.submissions[0]).toMatchObject({expected_points:9000,price_version:'synthetic-refreshed-tariff'});
});

for(const width of [1440,1280])test(`save failure remains visible beside generation without covering the editor at ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:960});await setup(page);
 await page.route('**/file-generation/preparation',route=>route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',retryable:true}}));
 await first(page).click();await expect(page.locator('#fg-save-retry')).toBeVisible();
 const note=page.locator('#fg-requirements');await note.fill('合成桌面验收：失败后仍可继续编辑');await note.click();
 const footer=await page.locator('.fg-footer').boundingBox(),editor=await note.boundingBox(),controls=await page.locator('#fg-controls').boundingBox();
 expect(await page.locator('.fg-footer').evaluate(el=>getComputedStyle(el).position)).toBe('static');
 expect(footer!.y).toBeGreaterThanOrEqual(controls!.y+controls!.height);expect(footer!.height).toBeLessThan(180);expect(editor!.y+editor!.height).toBeLessThan(footer!.y);
 await page.locator('.fg-footer').scrollIntoViewIfNeeded();
 await expect(page.locator('.fg-footer #fg-save-state')).toContainText('保存尚未确认');await expect(page.locator('.fg-footer #fg-save-retry')).toBeInViewport();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath(`save-failure-${width}x960.png`)});
 const prototype=resolve('../../product-prototype/public/file-templates-v2.html').replaceAll('\\','/');await page.goto('/@fs/'+prototype);await expect(page.getByRole('heading',{name:'生成文件',exact:true})).toBeVisible();await page.screenshot({path:info.outputPath(`prototype-${width}x960.png`)});
});
