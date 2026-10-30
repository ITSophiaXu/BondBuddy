import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {sourceFixture} from './generation-source-fixtures';
import {href,ids,file,batches} from './generation-entry-fixtures';
import {emptyFileGenerationPreparation,PROJECT_DOCUMENT_CATALOG} from '@bondbuddy/contracts';

// Real controllers and rendered UI; HTTP, files and task outcomes are synthetic.
async function capture(page:Page,name:string){const dir=process.env.BB_FLOW_EVIDENCE;if(!dir)return;await mkdir(dir,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);await page.screenshot({path:join(dir,name+'.png'),fullPage:true});await page.screenshot({path:join(dir,name+'-viewport.png')});}
const mode=(page:Page,value:string)=>page.locator(`[name=generation-source-mode][value=${value}]`);

for(const width of [1440,390,320])test(`source first with PR787 radio choices, ${width}px`,async({page})=>{
 const s=await sourceFixture(page,true);
 await page.route('**/api/v1/projects/*/file-generation',route=>route.fulfill({json:{revision:0,preparation:emptyFileGenerationPreparation(),sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},batches:[]}}));
 await page.setViewportSize({width,height:960});await page.goto('/'+href());
 await expect(page.getByRole('heading',{name:'生成文件',exact:true})).toBeVisible();await expect(page.locator('[data-flow-step="1"]')).toHaveAttribute('aria-current','step');
 await expect(page.locator('#pf-prospectus')).toBeVisible();await expect(page.locator('.pf-flow-modes,#wp-upload,#pf-template-list')).toHaveCount(0);
 await expect(mode(page,'project')).toBeChecked();await expect(page.locator('.pf-source-modes label')).toHaveText(['上传新募集说明书','选择项目已有募集说明书']);
 await expect(page.locator('.pf-selected-source')).toContainText('募集说明书_V3.docx');await expect(page.locator('#pf-source-upload')).toBeHidden();expect(s.selections).toHaveLength(0);
 await capture(page,'source-existing-'+width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await mode(page,'upload').check();await expect(page.locator('#pf-source-existing')).toBeHidden();await expect(page.locator('.pf-selected-source')).toContainText('募集说明书_V3.docx');expect(s.selections).toHaveLength(0);
 await expect(mode(page,'upload')).toBeFocused();await mode(page,'upload').press('ArrowRight');await expect(mode(page,'project')).toBeChecked();
 await page.locator('#pf-source-next').click();await expect(page).toHaveURL(/step=prepare/);await expect(page.locator('[data-flow-step="2"]')).toHaveAttribute('aria-current','step');
 await expect(page.locator('.fg-types')).toHaveCount(1);
 await expect(page.locator('.fg-types [data-fg-type]')).toHaveCount(PROJECT_DOCUMENT_CATALOG.length+1);
 for(const type of ['workpaper',...PROJECT_DOCUMENT_CATALOG.map(t=>t.id)])await expect(page.locator(`[data-fg-type="${type}"]`)).toBeVisible();
 await expect(page.getByText('其他文件类型',{exact:true})).toHaveCount(0);
 await expect(page.locator('.fg-source-card')).toHaveCount(2);
 await capture(page,'file-options-'+width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await expect(page.getByRole('button',{name:'直接使用光大整套'})).toBeVisible();expect(batches(s.state)).toHaveLength(0);
 await page.locator('a[data-flow-step="1"]').click();await page.locator('#pf-source-next').click();await expect(page).toHaveURL(/step=prepare/);
});

for(const existing of [false,true])test(`upload adopts saved source and waits for explicit next, existing=${existing}`,async({page})=>{
 const s=await sourceFixture(page,existing);await page.goto('/'+href({step:'source',mode:'documents'},ids.api,ids.navigation));
 if(!existing){await expect(page.locator('.pf-source-modes')).toBeHidden();await expect(mode(page,'project')).toBeHidden();await expect(page.locator('#pf-source-existing')).toBeHidden();await expect(page.locator('#choose-prospectus-version')).toBeVisible();await expect(page.locator('#pf-source-next')).toBeDisabled();await capture(page,'source-empty');}else await mode(page,'upload').check();
 const chooser=page.waitForEvent('filechooser');await page.locator('#choose-prospectus-version').click();await(await chooser).setFiles(file);
 await expect(page.locator('.pf-selected-source')).toContainText(file.name);await expect(page.locator('#pf-source-next')).toBeEnabled();await expect(page).toHaveURL(/step=source/);
 await expect(mode(page,'project')).toBeVisible();await expect(mode(page,'upload')).toBeChecked();
 expect(s.state.puts).toBe(1);expect(s.selections).toHaveLength(1);await expect(page.locator('#pf-source-existing')).toBeHidden();expect(batches(s.state)).toHaveLength(0);
 await page.reload();await expect(page.locator('.pf-selected-source')).toContainText(file.name);await expect(mode(page,'project')).toBeVisible();await page.locator('#pf-source-next').click();await expect(page.locator('#pf-template-list')).toBeVisible();
 expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('return_project')).toBe(ids.navigation);expect(s.state.puts).toBe(1);expect(s.selections).toHaveLength(1);
});

test('switching a saved version stays on source and retry reuses selection identity',async({page})=>{
 const s=await sourceFixture(page,true);s.versions.versions.push({...s.versions.versions[0],version_id:'old-source',sequence:2,filename:'第二稿.docx',material_id:'old-material'});s.control.dropSelection=true;
 await page.goto('/'+href({step:'source'}));await page.locator('#pf-project-source').selectOption('old-source');
 await expect(page.locator('#retry-prospectus-selection')).toBeVisible();await expect(page.locator('#pf-source-next')).toBeDisabled();await expect(mode(page,'upload')).toBeDisabled();
 await page.locator('#retry-prospectus-selection').click();await expect(page.locator('.pf-selected-source')).toContainText('第二稿.docx');await expect(page.locator('#pf-source-next')).toBeEnabled();await expect(page).toHaveURL(/step=source/);
 expect(s.selections).toHaveLength(2);expect(s.selections[1]).toEqual(s.selections[0]);
});

test('source conflict retains prior source and asks user to choose again',async({page})=>{
 const s=await sourceFixture(page,true);s.versions.versions.push({...s.versions.versions[0],version_id:'old-source',sequence:2,filename:'第二稿.docx',material_id:'old-material'});s.control.conflict=true;
 await page.goto('/'+href({step:'source'}));await page.locator('#pf-project-source').selectOption('old-source');await expect(page.locator('#prospectus-status')).toContainText('采用未完成');await expect(page.locator('.pf-selected-source')).toContainText('募集说明书_V3.docx');
 expect(s.selections).toHaveLength(1);expect(batches(s.state)).toHaveLength(0);
});

for(const reload of [false,true])test(`upload in flight locks source mode and next, failed transfer can be retried, reload=${reload}`,async({page})=>{
 const s=await sourceFixture(page,true);let fail=true;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('**/materials/uploads/*/bytes',async route=>{if(fail){await gate;fail=false;const id=new URL(route.request().url()).pathname.split('/').at(-2)!;s.state.sessions.get(id)!.received=true;s.state.puts++;return route.abort('failed');}return route.fallback();});
 await page.goto('/'+href({step:'source'}));await mode(page,'upload').check();await page.locator('#prospectus-version-file').setInputFiles(file);
 await expect(mode(page,'project')).toBeDisabled();await expect(page.locator('#pf-source-next')).toBeDisabled();await expect(page.locator('.pf-selected-source')).toContainText('募集说明书_V3.docx');release();
 await expect(page.locator('#save-prospectus-version')).toBeVisible();await expect(page.locator('#save-prospectus-version')).toBeEnabled();await expect(page.locator('#pf-source-next')).toBeDisabled();await capture(page,'source-upload-failed');
 if(reload){await page.reload();await expect(mode(page,'upload')).toBeChecked();await expect(page.locator('#pf-source-next')).toBeDisabled();await page.locator('[data-resume-prospectus]').click();}else await page.locator('#save-prospectus-version').click();
 await expect(page.locator('.pf-selected-source')).toContainText(file.name);await expect(page.locator('#pf-source-next')).toBeEnabled();expect(s.selections).toHaveLength(1);expect(s.state.puts).toBe(1);
});

for(const width of [1440,390,320])test(`table retains add/remove, template reuse and full-page confirmation, ${width}px`,async({page})=>{
 const s=await sourceFixture(page,true);await page.setViewportSize({width,height:960});await page.goto('/'+href({step:'source',mode:'documents'}));await page.locator('#pf-source-next').click();
 await page.locator('[data-pf-document=""]').selectOption('init');await page.locator('#pf-add-row').click();await expect(page.locator('[data-pf-document=""]')).toBeFocused();await page.locator('#pf-add-row').click();await expect(page.locator('[data-pf-document=""]')).toHaveCount(1);
 await expect(page.locator('[data-pf-document=""] option[value=init]')).toBeDisabled();await page.locator('[data-pf-document=""]').selectOption('underwriter');
 await expect(page.locator('#pf-prepared')).toContainText('2 / 2');await capture(page,'template-table-'+width);await page.locator('#pf-generate').click();
 await expect(page.locator('[data-flow-step="3"]')).toHaveAttribute('aria-current','step');await expect(page.locator('.pf-flow-confirm')).toContainText('立项报告');await expect(page.locator('.pf-flow-confirm')).toContainText('主承销商核查意见');await expect(page.locator('.pf-confirm-total')).toContainText('9,000');
 await expect(page.locator('dialog[open]')).toHaveCount(0);expect(batches(s.state)).toHaveLength(0);await capture(page,'template-confirm-'+width);
 await page.locator('#pf-back-to-prepare').click();await expect(page.locator('[data-pf-document]')).toHaveCount(2);await page.locator('[data-pf-remove=underwriter]').click();await expect(page.locator('#pf-count')).toHaveText('1 份');
 await page.locator('#pf-generate').click();await page.locator('#pf-confirm-generation').click();await expect(page.locator('[data-flow-step="4"]')).toHaveAttribute('aria-current','step');expect(batches(s.state)).toHaveLength(1);expect(s.state.workspaces.get(ids.api)!.batches[0].items).toHaveLength(1);
});

test('missing template still blocks newly added file',async({page})=>{
 const s=await sourceFixture(page,true);s.state.workspaces.get(ids.api)!.workspace.templates=[];await page.goto('/'+href({step:'source',mode:'documents'}));await page.locator('#pf-source-next').click();
 await page.locator('[data-pf-document=""]').selectOption('legal');await expect(page.locator('#pf-template-list')).toContainText('待添加模板');await expect(page.locator('#pf-generate')).toBeDisabled();expect(batches(s.state)).toHaveLength(0);
});

test('next rereads the adopted source after a temporary workspace refresh failure',async({page})=>{
 const s=await sourceFixture(page,true);s.versions.versions.push({...s.versions.versions[0],version_id:'old-source',sequence:2,filename:'第二稿.docx',material_id:'old-material'});
 let fail=false;await page.route('**/project-files/workspace',route=>fail&&route.request().method()==='GET'?route.abort('failed'):route.fallback());
 await page.goto('/'+href({step:'source',mode:'documents'}));await expect(page.locator('#pf-source-next')).toBeEnabled();fail=true;
 await page.locator('#pf-project-source').selectOption('old-source');await expect(page.locator('#prospectus-status')).toContainText('暂未打开');await expect(page.locator('.pf-selected-source')).toContainText('第二稿.docx');
 fail=false;await page.locator('#pf-source-next').click();await expect(page.locator('#pf-template-list')).toBeVisible();await expect(page.locator('#pf-source-summary')).toContainText('第二稿.docx');expect(s.state.workspaces.get(ids.api)!.workspace.drafts.init.project_file?.source_version_id).toBe('old-source');expect(batches(s.state)).toHaveLength(0);
});

for(const width of [1440,390,320])test(`approved prototype reference screens, ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:960});const file=resolve(process.cwd(),'../../product-prototype/public/file-generation-flow-approved.html').replaceAll('\\','/');
 await page.goto('/@fs/'+file);await expect(page.locator('[data-mode=single]')).toHaveAttribute('aria-pressed','true');await capture(page,'prototype-template-'+width);
 await page.locator('[data-action=back]').click();await expect(page.locator('#bb-project-source')).toBeVisible();await capture(page,'prototype-source-'+width);
 await page.locator('[data-action=next]').click();await page.locator('[data-mode=batch]').click();await capture(page,'prototype-directory-'+width);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.goto('/@fs/'+file+'?empty=1');await expect(page.getByRole('radio',{name:'选择项目已有募集说明书',exact:true})).toBeHidden();
 await expect(page.locator('#bb-source-existing')).toBeHidden();await expect(page.locator('[data-action=upload-source]')).toBeVisible();
 await expect(page.locator('[data-action=next]')).toBeDisabled();await capture(page,'prototype-empty-'+width);
});
