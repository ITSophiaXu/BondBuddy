import {test,expect,type Page} from '@playwright/test';
import type {ReviewEditorIssue} from '../src/billing-types';

// Long synthetic document: findings are deliberately below the cover and far apart.
async function setup(page:Page){
  const mutations:string[]=[];
  const issue=(id:string,paragraph_id:string,category:string):ReviewEditorIssue=>({id,paragraph_id,category,title:`合成发现 ${id}`,original:`原句 ${id}。`,replacement:`修改 ${id}。`,reason:'合成复核说明。',evidence:'合成测试材料',missing:'',uncertain:false,decision:'suggested',manual_text:'',applied:true,limitation:''});
  const snapshots=[1,2].map(version=>({version:'review-editor-v1',source_filename:'合成募集书.docx',source_sha256:'a'.repeat(64),source_format:'docx',warnings:[],
    paragraphs:Array.from({length:90},(_,n)=>({id:`v${version}-p${n}`,text:n===35?'原句 A。原句 C。':n===(version===1?60:75)?'原句 B。':`合成正文第 ${n+1} 段。`+'这里是合成上下文，仅用于检验长文档定位。'.repeat(5)})),
    issues:[issue('A',`v${version}-p35`,'财务核对'),issue('B',`v${version}-p${version===1?60:75}`,'财务核对'),issue('C',`v${version}-p35`,'合规'),issue('D','missing-paragraph','待确认')]}));
  await page.route('**/api/v1/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()!=='GET')mutations.push(path);
    if(path.endsWith('/review-history'))return route.fulfill({json:{items:[1,2].map(version=>({version,operation:'full_review',created_at:'2026-11-10T00:00:00Z',run:{run_id:`run-${version}`,project_id:'project',state:'succeeded'},artifacts:[{artifact_id:`clean-${version}`,artifact_version:version,kind:'clean',filename:'合成.docx'}]}))}});
    const match=path.match(/review-executions\/run-(\d)\/editor$/);
    if(match){const version=Number(match[1]);return route.fulfill({json:{run_id:`run-${version}`,sha256:String(version).repeat(64),snapshot:snapshots[version-1]}});}
    return route.fulfill({status:404,json:{}});
  });
  await page.route('**/__review_navigation',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/style.css"><style>body{display:block;margin:0}main{padding:24px;max-width:1600px;margin:auto}</style></head><body><main id="editor"></main><script type="module">import {ReviewEditor} from '/src/review-editor.ts';import {ApiClient} from '/src/api.ts';new ReviewEditor(new ApiClient(()=>{}),'project','owner',new AbortController().signal,()=>{},()=>{}).mount(document.querySelector('#editor'),'run-1',[]);</script></body></html>`}));
  await page.goto('/__review_navigation');
  await expect(page.locator('.review-issue-detail h3')).toHaveText('合成发现 A');
  return mutations;
}
async function aligned(page:Page,id:string){
  await expect.poll(()=>page.locator(`#review-paragraph-${id}`).evaluate(element=>{
    const pane=element.closest('[data-editor-document]')!;
    return Math.abs(element.getBoundingClientRect().top-pane.getBoundingClientRect().top-24);
  })).toBeLessThan(3);
  await expect(page.locator(`#review-paragraph-${id}`)).toHaveClass('selected');
}
const scrollTop=(page:Page)=>page.locator('[data-editor-document]').evaluate(element=>element.scrollTop);

test('opening, selecting, paging and changing views keep the linked paragraph in the document pane',async({page},info)=>{
  await page.setViewportSize({width:1440,height:1000});const mutations=await setup(page);
  await aligned(page,'v1-p35');await expect(page.getByRole('button',{name:'上一项',exact:true})).toBeDisabled();
  await page.locator('.review-editor-grid').scrollIntoViewIfNeeded();
  const outerTop=await page.evaluate(()=>window.scrollY);
  await page.getByRole('button',{name:'下一项',exact:true}).click();await aligned(page,'v1-p60');
  expect(await page.evaluate(()=>window.scrollY)).toBe(outerTop);
  for(const view of ['original','clean','tracked']){
    await page.locator(`[data-editor-view="${view}"]`).click();await aligned(page,'v1-p60');
    await expect(page.locator('[data-editor-location]')).toContainText('合成发现 B');
  }
  await page.locator('[data-editor-issue="A"]').click();await aligned(page,'v1-p35');
  await page.screenshot({path:info.outputPath('navigation-desktop.png'),fullPage:true});
  expect(mutations).toEqual([]);
});

test('document annotations select the exact issue and reveal it across category filters in every view',async({page})=>{
  const mutations=await setup(page);
  for(const view of ['tracked','original','clean']){
    await page.locator('#review-editor-category').selectOption('财务核对');
    await page.locator('[data-editor-issue="A"]').click();
    await page.locator(`[data-editor-view="${view}"]`).click();
    await page.locator('[data-editor-reference="C"]').focus();await page.keyboard.press('Enter');
    await expect(page.locator('.review-issue-detail h3')).toHaveText('合成发现 C');
    await expect(page.locator('.review-issue-detail h3')).toBeFocused();
    await expect(page.locator('#review-editor-category')).toHaveValue('all');
    await expect(page.locator('[data-editor-issue="C"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('[data-editor-reference="C"]')).toHaveAttribute('aria-pressed','true');
  }
  // The text itself also leads back to its finding, without intercepting text selection.
  await page.locator('[data-editor-issue="B"]').click();
  await page.locator('#review-paragraph-v1-p35>p').click();
  await expect(page.locator('.review-issue-detail h3')).toHaveText('合成发现 A');
  await page.locator('[data-editor-view="tracked"]').click();
  await page.locator('[data-editor-comment="C"] p').first().click();
  await expect(page.locator('.review-issue-detail h3')).toHaveText('合成发现 C');
  expect(mutations).toEqual([]);
});

test('manual editing retains the caret and document position, and re-locate recovers after free scrolling',async({page})=>{
  await setup(page);await page.locator('[data-editor-issue="B"]').click();
  await page.getByRole('radio',{name:'手动修改',exact:true}).check();await aligned(page,'v1-p60');
  const area=page.locator('#review-manual-text');await area.fill('人工确认。');
  const top=await scrollTop(page);await page.keyboard.type('新增');
  await expect(area).toBeFocused();await expect(area).toHaveValue('人工确认。新增');expect(await scrollTop(page)).toBe(top);
  await page.locator('[data-editor-document]').evaluate(element=>element.scrollTop=0);
  await page.locator('[data-editor-locate]').click();await aligned(page,'v1-p60');
  await page.locator('[data-editor-view="clean"]').click();await aligned(page,'v1-p60');
  await expect(page.locator('#review-paragraph-v1-p60>p')).toHaveText('人工确认。新增');
  await page.locator('[data-editor-discard]').click();await aligned(page,'v1-p60');
  await expect(page.locator('#review-paragraph-v1-p60>p')).toHaveText('修改 B。');
});

test('unmapped findings never claim a match and historical versions resolve their own paragraph ids',async({page})=>{
  await setup(page);await page.locator('#review-editor-category').selectOption('待确认');
  await expect(page.locator('[data-editor-locate]')).toBeDisabled();
  await expect(page.locator('[data-editor-location]')).toContainText('无法自动定位');
  await expect(page.locator('.review-paper section.selected')).toHaveCount(0);
  await expect(page.locator('.review-issue-detail')).toContainText('人工核对');
  await expect(page.getByRole('button',{name:'下一项',exact:true})).toBeDisabled();
  await page.locator('#review-editor-category').selectOption('财务核对');
  await page.locator('[data-editor-issue="B"]').click();await aligned(page,'v1-p60');
  await page.locator('[data-editor-history]').selectOption('run-2');await aligned(page,'v2-p75');
  await expect(page.locator('[data-editor-location]')).toContainText('第 76 段');
  await expect(page.locator('#review-paragraph-v1-p60')).toHaveCount(0);
});

test('mobile offers explicit forward and return navigation without horizontal overflow',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await setup(page);
  await page.locator('[data-editor-locate]').click();await aligned(page,'v1-p35');
  await expect(page.locator('.review-preview-toolbar')).toBeInViewport();
  await page.locator('[data-editor-reference="C"]').click();
  await expect(page.locator('.review-issue-detail h3')).toHaveText('合成发现 C');
  await expect(page.locator('.review-issue-detail h3')).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:info.outputPath('navigation-mobile.png'),fullPage:true});
});
