import {test,expect,type Page} from '@playwright/test';
import {emptyFileGenerationPreparation,type FileGenerationWorkspace,PROJECT_DOCUMENT_CATALOG} from '@bondbuddy/contracts';
import {fixture,href,ids} from './generation-entry-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';

// Production route and component with synthetic HTTP. No model or billing execution.
async function setup(page:Page){
 const transport=await fixture(page);
 transport.workspaces.get(ids.api)!.source!.filename='合成交通发展集团有限公司2026年度第一期债务融资工具定向募集说明书_完整采用版本.docx';
 const data:FileGenerationWorkspace={revision:1,preparation:{...emptyFileGenerationPreparation(),document_types:[],requirements:'保留已填编制要求',target_year:'2026'},sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},batches:[]};
 const otherWrites:string[]=[];
 await page.route('**/api/v1/projects/*/file-generation**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  const reply=(value:unknown)=>route.fulfill({json:fixtureBody(route,value)});
  if(request.method()==='GET'&&path.endsWith('/file-generation'))return reply(data);
  if(path.endsWith('/preparation')){
   const body=fixtureRequest(request);
   if(body.expected_revision!==data.revision)return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});
   data.revision++;data.preparation=structuredClone(body.preparation);return reply({revision:data.revision,preparation:data.preparation});
  }
  if(request.method()!=='GET')otherWrites.push(path);
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 await page.goto('/'+href({step:'prepare'}));await expect(page.locator('.fg-file-choices')).toBeVisible();
 return {data,otherWrites,transport};
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
 await expect.poll(()=>state.data.preparation.document_types.length).toBe(0);
 expect(state.data.preparation.target_year).toBe('2026');expect(state.data.preparation.requirements).toBe('保留已填编制要求');
 await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('[data-fg-type]:checked')).toHaveCount(0);await expect(page.locator('[data-fg-type]')).toHaveCount(13);
 expect(state.otherWrites).toEqual([]);expect(state.transport.errors).toEqual([]);
});

test('editing the report year does not consume the next group or clear click',async({page})=>{
 const state=await setup(page);
 await page.locator('[data-fg-type="annual"]').check();
 await page.locator('#fg-year').fill('2027');
 await page.locator('#fg-group-toggle-diligence').click();
 await expect(page.locator('[data-fg-type="init"]')).toBeChecked();
 await expect(page.locator('[data-fg-type="underwriter"]')).toBeChecked();
 await expect.poll(()=>state.data.preparation.target_year).toBe('2027');
 await page.locator('#fg-year').fill('2028');await page.locator('#fg-clear-types').click();
 await expect(page.locator('[data-fg-type]:checked')).toHaveCount(0);
 await expect.poll(()=>state.data.preparation.document_types).toEqual([]);
 expect(state.data.preparation.target_year).toBe('2028');expect(state.otherWrites).toEqual([]);
});

for(const width of [1440,768,390,320])test(`all file types use compact category rows without clipping at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:960});const state=await setup(page);
 const dimensions=await page.locator('.fg-file-choices').evaluate(root=>{
  const rect=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const filing=root.querySelector('#fg-group-options-filing')!;
  return {choices:[...root.querySelectorAll('.fg-type')].map(rect),filing:[...filing.children].map(rect),heading:rect(root.querySelector('#fg-group-title-filing')!),pack:rect(root.querySelector('.fg-workpaper-choice')!),selection:rect(root),scrollWidth:document.documentElement.scrollWidth,innerWidth};
 });
 expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth+1);
 for(const choice of dimensions.choices){expect(choice.height).toBeGreaterThanOrEqual(44);expect(choice.x).toBeGreaterThanOrEqual(0);expect(choice.right).toBeLessThanOrEqual(width);}
 if(width>=1200){
  expect(dimensions.pack.width).toBeGreaterThan(dimensions.filing[0].width);
  expect(new Set(dimensions.filing.map(r=>Math.round(r.y))).size).toBe(1);
  expect(dimensions.heading.right).toBeLessThan(dimensions.filing[0].x);
  expect(dimensions.selection.height).toBeLessThan(700);
 }else if(width<=500){
  for(let i=1;i<dimensions.filing.length;i++)expect(dimensions.filing[i].y).toBeGreaterThanOrEqual(dimensions.filing[i-1].bottom);
 }
 await page.screenshot({path:info.outputPath(`grouped-choices-${width}.png`),fullPage:true});
 expect(state.otherWrites).toEqual([]);expect(state.transport.errors).toEqual([]);
});
