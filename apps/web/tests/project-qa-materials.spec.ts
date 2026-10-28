import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,install,route,historical} from './qa-result-next-fixtures';
import {oldArtifact,prepareId,projectId,writes} from './project-qa-continuation-fixtures';
const prospectus={project_id:projectId,version_id:'prospectus-v4',selection_revision:4,sequence:4,filename:'合成募集书_清洁版_v4.docx',asset:structuredClone(oldArtifact)};
test.use({viewport:{width:1440,height:960}});
async function expectConsistentType(page:import('@playwright/test').Page){
 const fonts=await page.locator('.qa-page').evaluate(node=>Array.from(node.querySelectorAll('h1,h2,h3,h4,p,button,a,label,summary')).map(e=>getComputedStyle(e).fontFamily));
 expect(new Set(fonts).size).toBe(1);expect(fonts[0]).toContain('Microsoft YaHei');
}

for(const width of [1440,390,320])test(`project materials and readable preparation at ${width}`,async({page})=>{
 const s=fixture();s.workspace.prospectus=null;s.workspace.draft={preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:false};s.workspace.runs=[];
 await install(page,s);await page.setViewportSize({width,height:960});await page.goto(route(null));
 await expect(page.getByRole('region',{name:'项目资料',exact:true})).toContainText('缺少募集说明书');
 await expect(page.getByRole('button',{name:'上传或选择募集说明书'})).toBeVisible();
 await expect(page.locator('.qa-page')).not.toContainText('转换为 Word');
 await expect(page.locator('#qa-download')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await expectConsistentType(page);
 const dir=process.env.BB_UX_EVIDENCE_DIR;
 if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`materials-${width}.png`),fullPage:true});
  if(width!==320){const bounds=await page.locator('.qa-page').boundingBox();await page.locator('.qa-page').screenshot({path:join(dir,`component-${width}.png`)});const ref=await page.context().newPage();await ref.setViewportSize({width,height:960});await ref.goto('/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/qa-materials.html',import.meta.url)).replaceAll('\\','/'));await ref.locator('main').evaluate((n,w)=>{n.style.width=w+'px';n.style.padding='0';},bounds!.width);await ref.locator('[data-view="upload"]').screenshot({path:join(dir,`prototype-${width}.png`)});await ref.close();}}
 expect(writes(s)).toEqual([]);expect(s.errors).toEqual([]);expect(s.unexpected).toEqual([]);
});

test('only an adopted, selected prospectus enables paid answer; fee confirmation names it',async({page})=>{
 const s=fixture();s.workspace.prospectus=prospectus;
 await install(page,s);await page.goto(route(null));
 await expect(page.locator('#qa-start')).toBeDisabled();await expect(page.locator('#qa-required-material')).toContainText('尚未选入');
 await page.locator('#qa-select-prospectus').click();await expect(page.locator('#qa-start')).toBeEnabled();
 await page.locator('#qa-start').click();await expect(page.locator('.qa-modal')).toContainText('合成募集书_清洁版_v4.docx · V4');
 expect(writes(s)).toEqual([]);await page.locator('.qa-modal [data-close]').click();
 s.workspace.prospectus=null;await page.locator('#qa-refresh-materials').click();await expect(page.locator('#qa-start')).toBeDisabled();
 expect(s.answers).toEqual([]);
});

test('prepared questions are previewed in-page; even old conversion artifacts have no download',async({page})=>{
 const s=fixture();s.workspace.prospectus=prospectus;const prep=s.workspace.runs.find(r=>r.run_id===prepareId)!;prep.artifact_id='legacy-conversion';
 await install(page,s);await page.goto(route(prepareId));await expect(page.locator('.qa-candidate-list li')).toHaveCount(prep.result!.questions.length);
 await expect(page.locator('#qa-download')).toHaveCount(0);await expect(page.locator('.qa-prepared')).toContainText('尚未开始回答');
 await expectConsistentType(page);
 const dir=process.env.BB_UX_EVIDENCE_DIR;if(dir)await page.screenshot({path:join(dir,'questions-1440.png'),fullPage:true});
 await page.locator('#qa-use-preparation').click();await expect(page.locator('#qa-start')).toBeEnabled();expect(s.answers).toEqual([]);
});

test('zero candidates directs to manual selection and cannot answer',async({page})=>{
 const s=fixture();s.workspace.prospectus=prospectus;const prep=s.workspace.runs.find(r=>r.run_id===prepareId)!;prep.result!.questions=[];
 await install(page,s);await page.goto(route(prepareId));await expect(page.getByRole('heading',{name:'未识别到明确的问题'})).toBeVisible();
 await page.getByRole('button',{name:'从原文选择问题'}).click();await expect(page.locator('#qa-start')).toBeDisabled();await page.locator('#qa-ranges').click();await expect(page.locator('.qa-range-list')).toBeVisible();
 expect(writes(s)).toEqual([]);
});

test('answered document and question-specific missing materials remain available',async({page})=>{
 const s=fixture();s.workspace.prospectus=prospectus;historical(s).manifest.prospectus=prospectus;
 await install(page,s);await page.goto(route());await expect(page.locator('#qa-download')).toBeVisible();
 await expect(page.getByRole('region',{name:'待补材料清单'})).toContainText('关联交易明细及定价依据');
 await expect(page.getByRole('region',{name:'项目资料',exact:true})).toContainText('V4');
 await expectConsistentType(page);
 const dir=process.env.BB_UX_EVIDENCE_DIR;if(dir)await page.screenshot({path:join(dir,'answers-1440.png'),fullPage:true});
 expect(writes(s)).toEqual([]);
});

test('adopt a saved prospectus inside QA, then explicitly include it in the answer',async({page})=>{
 const s=fixture();s.workspace.prospectus=null;await install(page,s);
 const versions={project_id:projectId,current_version_id:null as string|null,selection_revision:0,inactive_material_ids:[],versions:[{version_id:prospectus.version_id,sequence:4,origin:'generated',filename:prospectus.filename,sha256:oldArtifact.pin.sha256,created_at:'2026-10-28T06:00:00Z',material_id:null,material_version:null,artifact_id:oldArtifact.kind==='artifact'?oldArtifact.pin.artifact_id:null,artifact_version:4,revision_artifact_id:null,run_id:'synthetic-run'}]};let selections=0;
 await page.route('**/api/v1/projects/**/prospectus-versions**',async r=>{if(r.request().method()==='POST'){expect(r.request().postDataJSON().version_id).toBe(prospectus.version_id);selections++;versions.current_version_id=prospectus.version_id;versions.selection_revision=1;s.workspace.prospectus=prospectus;}await r.fulfill({json:versions});});
 await page.goto(route(null));await page.getByRole('button',{name:'上传或选择募集说明书'}).click();await expect(page.locator('#qa-prospectus-panel')).toContainText('合成募集书_清洁版_v4.docx');
 await page.locator('[data-use-saved]').click();await expect(page.locator('#qa-prospectus-panel')).toHaveCount(0);expect(selections).toBe(1);
 await expect(page.locator('#qa-start')).toBeDisabled();await page.locator('#qa-select-prospectus').click();await expect(page.locator('#qa-start')).toBeEnabled();expect(s.answers).toEqual([]);
});

test('unreadable mandatory prospectus gives a specific replacement request and no download',async({page})=>{
 const s=fixture(),run=historical(s);run.manifest.prospectus=prospectus;run.state='failed';run.error_code='MATERIAL_UNREADABLE';run.result=null;run.artifact_id=null;run.charged_points=0;
 await install(page,s);await page.goto(route());await expect(page.getByRole('region',{name:'需要补充可读募集说明书'})).toContainText('可检索 PDF 或 Word');
 await expect(page.getByRole('region',{name:'需要补充可读募集说明书'})).toContainText(prospectus.filename);await expect(page.locator('#qa-download')).toHaveCount(0);
});
