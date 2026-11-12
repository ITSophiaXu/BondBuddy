import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {fixture,install,projectId,sourceDeclaration,expectNoExecution,assertFixture} from './authoring-source-guide-fixtures';

// Real workspace and ApiClient; held synthetic HTTP replies, no private service or model.
const versions=`**/api/v1/projects/${projectId}/prospectus-versions`;
const workspace=`/#/projects/${projectId}?step=materials`;
const evidence=process.env.BB_FIRST_PAINT_EVIDENCE;
const prototype='/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/prospectus-reference.html',import.meta.url)).replaceAll('\\','/');
function gate(){let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});return{pending,release};}
async function capture(page:Page,name:string){
  if(!evidence)return;
  await mkdir(evidence,{recursive:true});
  await page.locator('.reference-prospectus').screenshot({path:`${evidence}/${name}.png`});
}
test.afterEach(async({page})=>{await assertFixture(page);});

for(const width of [1440,390])test(`reference region is visible before a slow first response at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:1000});
  const s=fixture();s.materials=s.materials.filter(m=>m.role==='audit');s.project.update_details!.source_prospectuses=[];
  await install(page,s);
  const held=gate();let reads=0;
  await page.route(versions,async route=>{reads++;await held.pending;await route.fallback();});
  try{
    await page.goto(workspace);
    await expect.poll(()=>reads).toBe(1);
    const region=page.locator('.reference-prospectus'),picker=page.getByRole('button',{name:'上传历史／参考稿',exact:true});
    await expect(region).toBeVisible();
    await expect(page.locator('[data-prospectus-heading]')).toHaveText('历史／参考募集书（必填）');
    await expect(picker).toBeVisible();await expect(picker).toBeDisabled();
    await expect(page.locator('#reference-read-status')).toContainText('正在读取');
    await expect(page.locator('[data-prospectus-files]')).toHaveAttribute('aria-busy','true');
    await expect(region.locator('.reference-file-count,[data-use-version],[data-delete-version]')).toHaveCount(0);
    await expect(page.locator('#execute-input')).toBeDisabled();
    const before=await picker.boundingBox();
    const files=await page.locator('[data-prospectus-files]').boundingBox();
    expect(before!.width).toBeCloseTo(files!.width,0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const material=await page.locator('.materials-panel').boundingBox(),panel=await region.boundingBox();
    expect(material!.y).toBeGreaterThanOrEqual(panel!.y+panel!.height);
    // Dropping while loading must not navigate away or enqueue an unverified upload.
    expect(await region.evaluate(el=>{
      const data=new DataTransfer();data.items.add(new File(['synthetic'],'合成募集书.docx'));
      const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});el.dispatchEvent(event);return event.defaultPrevented;
    })).toBe(true);
    await capture(page,`workspace-loading-${width}`);
    held.release();
    await expect(picker).toBeEnabled();await expect(page.locator('#reference-read-status')).toHaveCount(0);
    await expect(region.locator('.reference-file-count')).toHaveText('0');
    expect((await picker.boundingBox())!.y).toBeCloseTo(before!.y,0);
    await capture(page,`workspace-empty-${width}`);
    expectNoExecution(s);expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
  }finally{held.release();}
});

test('failed first read retains the upload region and retry recovers materials and execution readiness',async({page})=>{
  const s=fixture();s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
  await install(page,s);
  let reads=0;const retry=gate();
  await page.route(versions,async route=>{
    if(++reads===1)return route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});
    await retry.pending;await route.fallback();
  });
  try{
    await page.goto(workspace);
    const region=page.locator('.reference-prospectus'),picker=page.getByRole('button',{name:'上传历史／参考稿',exact:true});
    await expect(region.getByRole('alert')).toContainText('无法读取已保存的历史／参考募集书');
    await expect(picker).toBeVisible();await expect(picker).toBeDisabled();
    await expect(region.locator('.reference-file-count')).toHaveCount(0);
    await expect(page.locator('#execute-input')).toBeDisabled();
    for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await capture(page,`workspace-error-${width}`);}
    await page.getByRole('button',{name:'重新读取募集书',exact:true}).click();
    await expect.poll(()=>reads).toBe(2);
    await expect(page.locator('#reference-read-status')).toContainText('正在读取');
    await expect(page.getByRole('button',{name:'重新读取募集书',exact:true})).toHaveCount(0);
    retry.release();
    await expect(region.locator('.reference-file-count')).toHaveText('1');
    await expect(region).toContainText(s.materials.find(m=>m.role==='historical')!.filename);
    await expect(picker).toBeEnabled();
    await expect(page.locator('#workspace-material-count')).toContainText('3 份已保存材料');
    await expect(page.locator('#execute-input')).toBeEnabled();
    expectNoExecution(s);expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
  }finally{retry.release();}
});

test('leaving during the first read cannot repaint the destination',async({page})=>{
  const s=fixture();await install(page,s);
  const held=gate();let reads=0;
  await page.route(versions,async route=>{reads++;await held.pending;await route.fallback();});
  try{
    await page.goto(workspace);await expect.poll(()=>reads).toBe(1);
    await expect(page.locator('.reference-prospectus')).toBeVisible();
    await page.evaluate(()=>{location.hash='/';});
    await expect(page.locator('#workspace-materials')).toHaveCount(0);
    held.release();
    await expect(page.locator('.reference-prospectus')).toHaveCount(0);
    expectNoExecution(s);
  }finally{held.release();}
});

test('prototype loading and failure states retain the same upload region at desktop and narrow widths',async({page})=>{
  for(const width of [1440,390])for(const state of ['loading','error','empty']){
    await page.setViewportSize({width,height:1000});await page.goto(`${prototype}?state=${state}`);
    const picker=page.getByRole('button',{name:'上传历史／参考稿',exact:true});
    await expect(picker).toBeVisible();
    if(state==='empty')await expect(picker).toBeEnabled();else await expect(picker).toBeDisabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await capture(page,`prototype-${state}-${width}`);
  }
});
