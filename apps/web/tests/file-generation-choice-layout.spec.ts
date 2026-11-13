import {test,expect,type Page} from '@playwright/test';
import {emptyFileGenerationPreparation,type FileGenerationWorkspace,PROJECT_DOCUMENT_CATALOG} from '@bondbuddy/contracts';
import {fixture,href,ids,batches} from './generation-entry-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
import {sourceFixture} from './generation-source-fixtures';

// Production route and component with synthetic HTTP. No generation, model or billing writes.
async function setup(page:Page){
 const transport=await fixture(page);
 transport.workspaces.get(ids.api)!.source!.filename='合成交通发展集团有限公司2026年度第一期债务融资工具定向募集说明书_完整采用版本.docx';
 const data:FileGenerationWorkspace={revision:1,preparation:{...emptyFileGenerationPreparation(),document_types:[],requirements:'保留已填编制要求',target_year:'2026'},sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},batches:[]};
 const saves:any[]=[],otherWrites:string[]=[];
 await page.route('**/api/v1/projects/*/file-generation**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  const reply=(value:unknown)=>route.fulfill({json:fixtureBody(route,value)});
  if(request.method()==='GET'&&path.endsWith('/file-generation'))return reply(data);
  if(path.endsWith('/preparation')){
   const body=fixtureRequest(request);saves.push(structuredClone(body));
   if(body.expected_revision!==data.revision)return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});
   data.revision++;data.preparation=structuredClone(body.preparation);return reply({revision:data.revision,preparation:data.preparation});
  }
  if(request.method()!=='GET')otherWrites.push(path);
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 await page.goto('/'+href({step:'prepare'}));await expect(page.locator('.fg-file-choices')).toBeVisible();
 return {data,saves,otherWrites,transport};
}

test('all choices stay visible; group toggles, clear and reload preserve the saved preparation',async({page})=>{
 const state=await setup(page);
 await expect(page.locator('.fg-choice-group-heading h3')).toHaveText(['尽调与内核','申报文件','定期报告','专项说明']);
 await expect(page.locator('[data-fg-type]')).toHaveCount(PROJECT_DOCUMENT_CATALOG.length+1);
 await expect(page.locator('#fg-more-types')).toHaveCount(0);
 for(const type of ['workpaper',...PROJECT_DOCUMENT_CATALOG.map(t=>t.id)])await expect(page.locator(`[data-fg-type="${type}"]`)).toBeVisible();
 await expect(page.locator('#fg-clear-types')).toBeDisabled();
 const diligence=page.locator('#fg-group-toggle-diligence'),filing=page.locator('#fg-group-toggle-filing');
 await diligence.focus();await diligence.press('Enter');
 await expect(diligence).toBeFocused();await expect(diligence).toHaveAccessibleName('取消全选尽调与内核');
 await expect(page.locator('.fg-choice-count').first()).toHaveText('2/2');
 await expect.poll(()=>state.data.preparation.document_types).toEqual(['init','underwriter']);
 await page.locator('[data-fg-type="init"]').uncheck();await expect(diligence).toHaveAccessibleName('全选尽调与内核');
 await diligence.click();await filing.click();
 await expect.poll(()=>state.data.preparation.document_types.length).toBe(6);
 expect(new Set(state.data.preparation.document_types).size).toBe(6);
 await filing.click();await expect.poll(()=>state.data.preparation.document_types.length).toBe(2);
 await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('[data-fg-type="init"]')).toBeChecked();await expect(page.locator('[data-fg-type="underwriter"]')).toBeChecked();
 await expect(page.locator('#fg-requirements')).toHaveValue('保留已填编制要求');
 await page.locator('#fg-clear-types').focus();await page.locator('#fg-clear-types').press('Enter');
 await expect(page.locator('[data-fg-type="workpaper"]')).toBeFocused();await expect(page.locator('#fg-confirm')).toBeDisabled();
 await expect(page.locator('#fg-confirm')).toHaveAccessibleDescription('请至少选择一份文件。');
 await expect(page.locator('#fg-empty-selection')).toBeVisible();
 await expect.poll(()=>state.data.preparation.document_types.length).toBe(0);
 expect(state.data.preparation.target_year).toBe('2026');expect(state.data.preparation.requirements).toBe('保留已填编制要求');
 await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('[data-fg-type]:checked')).toHaveCount(0);await expect(page.locator('[data-fg-type]')).toHaveCount(13);
 await diligence.click();await expect(page.locator('#fg-empty-selection')).toBeHidden();
 expect(state.otherWrites).toEqual([]);expect(state.transport.errors).toEqual([]);
});

test('support upload is keyboard reachable and opens the native file chooser',async({page})=>{
 await setup(page);
 const note=page.locator('#fg-requirements'),upload=page.locator('#fg-support');
 await note.focus();await note.press('Tab');await expect(upload).toBeFocused();
 const chooser=page.waitForEvent('filechooser');await upload.press('Enter');
 expect((await chooser).isMultiple()).toBe(true);
 await upload.press('Tab');await expect(page.locator('#fg-save')).toBeFocused();
});

test('editing the report year does not consume the next group or clear click',async({page})=>{
 const state=await setup(page);
 await page.locator('[data-fg-type="annual"]').check();
 await page.locator('#fg-year').fill('2027');
 await page.locator('#fg-group-toggle-diligence').click();
 await expect(page.locator('[data-fg-type="init"]')).toBeChecked();
 await expect(page.locator('[data-fg-type="underwriter"]')).toBeChecked();
 await expect.poll(()=>state.data.preparation.target_year).toBe('2027');
 await page.locator('#fg-year').fill('2028');
 await page.locator('#fg-clear-types').click();
 await expect(page.locator('[data-fg-type]:checked')).toHaveCount(0);
 await expect.poll(()=>state.data.preparation.document_types).toEqual([]);
 expect(state.data.preparation.target_year).toBe('2028');
 expect(state.otherWrites).toEqual([]);
});

for(const width of [1440,768,390,320])test(`grouped choices and supporting actions fit and align at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:960});const state=await setup(page);
 const dimensions=await page.locator('.fg-preparation').evaluate(root=>{
  const rect=(selector:string)=>{const r=root.querySelector(selector)!.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const choices=[...root.querySelectorAll<HTMLElement>('.fg-type')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height,margin:getComputedStyle(e).marginTop};});
  const textarea=root.querySelector('textarea')!,style=getComputedStyle(textarea);
  return {choices,first:rect('[data-fg-type="init"]'),second:rect('[data-fg-type="underwriter"]'),pack:rect('.fg-workpaper-choice'),selection:rect('.fg-file-choices'),support:rect('.fg-support-panel'),upload:rect('.fg-support-actions label'),save:rect('#fg-save'),textarea:rect('textarea'),textareaPadding:parseFloat(style.paddingLeft),scrollWidth:document.documentElement.scrollWidth,innerWidth};
 });
 expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth+1);
 expect(dimensions.support.y-dimensions.selection.bottom).toBeGreaterThanOrEqual(19);
 for(const choice of dimensions.choices){expect(choice.height).toBeGreaterThanOrEqual(44);expect(choice.margin).toBe('0px');expect(choice.x).toBeGreaterThanOrEqual(0);expect(choice.right).toBeLessThanOrEqual(width);}
 expect(dimensions.upload.height).toBeGreaterThanOrEqual(44);expect(dimensions.save.height).toBeGreaterThanOrEqual(44);
 expect(Math.abs(dimensions.upload.height-dimensions.save.height)).toBeLessThanOrEqual(1);
 expect(dimensions.textareaPadding).toBeGreaterThanOrEqual(12);
 expect(dimensions.upload.y-dimensions.textarea.bottom).toBeGreaterThanOrEqual(19);
 if(width>500){expect(Math.abs(dimensions.first.y-dimensions.second.y)).toBeLessThanOrEqual(1);expect(Math.abs(dimensions.upload.y-dimensions.save.y)).toBeLessThanOrEqual(1);expect(dimensions.save.x-dimensions.upload.right).toBeGreaterThanOrEqual(11);}
 else {expect(dimensions.second.y).toBeGreaterThan(dimensions.first.y);expect(dimensions.save.y-dimensions.upload.bottom).toBeGreaterThanOrEqual(11);expect(Math.abs(dimensions.save.x-dimensions.upload.x)).toBeLessThanOrEqual(1);}
 await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});
 await page.screenshot({path:info.outputPath(`grouped-choices-${width}.png`),fullPage:true});
 expect(state.otherWrites).toEqual([]);expect(state.transport.errors).toEqual([]);
});

for(const width of [1440,390])test(`template and catalogue action rows share upload target height at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:960});const state=await setup(page);
 await page.locator('[data-fg-type="workpaper"]').check();
 await page.locator('[data-fg-type="annual"]').check();
 const sizes=await page.locator('.fg-preparation').evaluate(root=>{
  const box=(selector:string)=>{const r=root.querySelector(selector)!.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  return {catalogueUpload:box('label:has(#fg-catalogue-upload)'),catalogueDefault:box('#fg-load-builtin'),templateUpload:box('.fg-general-row label'),templatePreview:box('[data-fg-general-preview="annual"]'),templateSelect:box('[data-fg-general="annual"]'),scrollWidth:document.documentElement.scrollWidth,innerWidth};
 });
 for(const [upload,button] of [[sizes.catalogueUpload,sizes.catalogueDefault],[sizes.templateUpload,sizes.templatePreview]]){
  expect(upload.height).toBeGreaterThanOrEqual(44);expect(button.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs(upload.height-button.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(upload.y-button.y)).toBeLessThanOrEqual(1);
  expect(upload.right).toBeLessThanOrEqual(width);expect(button.right).toBeLessThanOrEqual(width);
 }
 expect(sizes.templateSelect.height).toBeGreaterThanOrEqual(44);
 if(width<850){expect(sizes.templateSelect.bottom).toBeLessThan(sizes.templatePreview.y);expect(sizes.templateSelect.width).toBeGreaterThan(sizes.templatePreview.width);}
 else {expect(Math.abs(sizes.templateSelect.y-sizes.templatePreview.y)).toBeLessThanOrEqual(1);expect(Math.abs(sizes.templateSelect.bottom-sizes.templatePreview.bottom)).toBeLessThanOrEqual(1);}
 expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.innerWidth+1);
 await expect(page.locator('#fg-general-builtin')).toHaveText('添加内置文种模板');
 await expect(page.locator('#fg-template-setup')).toContainText('光大模板');
 await page.screenshot({path:info.outputPath(`template-actions-${width}.png`),fullPage:true});
 expect(state.otherWrites).toEqual([]);expect(state.transport.errors).toEqual([]);
});

for(const width of [1440,390])test(`legacy file rows keep template action targets at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:960});const state=await sourceFixture(page,true);
 await page.goto('/'+href({step:'source',mode:'documents'}));await page.locator('#pf-source-next').click();
 await page.locator('[data-pf-document=""]').selectOption('init');await page.locator('#pf-add-row').click();
 await page.locator('[data-pf-document=""]').selectOption('underwriter');
 const buttons=page.locator('.pf-row-actions [data-pf-template]');await expect(buttons).toHaveCount(2);
 for(const button of await buttons.all()){const box=(await button.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 expect(batches(state.state)).toHaveLength(0);
 await page.screenshot({path:info.outputPath(`legacy-template-actions-${width}.png`),fullPage:true});
});
