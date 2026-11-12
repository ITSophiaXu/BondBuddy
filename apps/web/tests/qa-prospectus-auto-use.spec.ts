import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ProspectusVersions} from '@bondbuddy/contracts';
import {fixture,install,route,historical} from './qa-result-next-fixtures';
import {oldArtifact,newMaterial,projectId,now,assertFixture} from './project-qa-continuation-fixtures';

// Real QA page and upload client, synthetic HTTP only; no model, database or billing.
const filename='合成本项目募集说明书.docx';
async function setup(page:Page,options:{first?:boolean;dropSelection?:boolean;conflict?:boolean;failUpload?:boolean}={}){
 const s=fixture();s.allowUploads=true;
 const old=structuredClone(s.workspace.prospectus!);
 s.workspace.draft.materials=options.first?[structuredClone(newMaterial)]:[structuredClone(oldArtifact),structuredClone(newMaterial)];
 if(options.first)s.workspace.prospectus=null;
 const before=structuredClone(s.workspace.runs);
 const versions:ProspectusVersions={project_id:projectId,current_version_id:options.first?null:old.version_id,selection_revision:options.first?0:4,inactive_material_ids:[],versions:options.first?[]:[{version_id:old.version_id,sequence:4,origin:'generated',filename:old.filename,sha256:oldArtifact.pin.sha256,created_at:now,material_id:null,material_version:null,artifact_id:oldArtifact.kind==='artifact'?oldArtifact.pin.artifact_id:null,artifact_version:4,revision_artifact_id:null,run_id:historical(s).run_id}]};
 const selections:Record<string,unknown>[]=[],receipts=new Map<string,ProspectusVersions>();
 let drop=!!options.dropSelection,conflict=!!options.conflict,failUpload=!!options.failUpload;
 await install(page,s);
 await page.route('**/materials/uploads/*/complete',async r=>{
  if(failUpload){return r.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});}
  return r.fallback();
 });
 await page.route(`**/api/v1/projects/${projectId}/prospectus-versions**`,async r=>{
  const m=s.uploadMaterial;
  if(m&&!versions.versions.some(v=>v.material_id===m.material_id))versions.versions.unshift({version_id:'prospectus-new',sequence:5,origin:'upload',filename:m.filename,sha256:m.sha256,created_at:now,material_id:m.material_id,material_version:m.material_version,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null});
  if(r.request().method()==='POST'){
   const request=r.request().postDataJSON();selections.push(request);
   const receipt=receipts.get(request.request_id);if(receipt)return r.fulfill({json:receipt});
   if(conflict){conflict=false;versions.selection_revision++;return r.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});}
   expect(request).toMatchObject({expected_selection_revision:versions.selection_revision,version_id:'prospectus-new'});
   versions.current_version_id=request.version_id;versions.selection_revision++;
   const asset=s.workspace.materials.find(row=>row.asset.kind==='material'&&row.asset.pin.material_id===m!.material_id)!.asset;
   s.workspace.prospectus={project_id:projectId,version_id:request.version_id,selection_revision:versions.selection_revision,sequence:5,filename:m!.filename,asset:structuredClone(asset)};
   receipts.set(request.request_id,structuredClone(versions));
   if(drop){drop=false;return r.abort('connectionreset');}
  }
  return r.fulfill({json:versions});
 });
 await page.goto(route(null));await page.locator('#qa-manage-prospectus').click();
 await expect(page.locator('#qa-prospectus-panel')).toContainText('上传成功后自动用于本轮问答');
 return {s,before,selections,versions,resumeUpload:()=>{failUpload=false;}};
}
async function upload(page:Page){await page.locator('#prospectus-version-file').setInputFiles({name:filename,mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('Synthetic prospectus only.')});}
async function selected(page:Page){
 await expect(page.locator('#qa-prospectus-panel')).toHaveCount(0);
 await expect(page.locator('.qa-prospectus-row')).toContainText(filename);
 await expect(page.locator('.qa-prospectus-row')).toContainText('已纳入本轮材料');
 await expect(page.locator('#qa-select-prospectus')).toHaveCount(0);
 await expect(page.locator('#qa-start')).toBeEnabled();
}
test.afterEach(async({page})=>assertFixture(page));

for(const first of [true,false])test(`${first?'first upload':'replacement upload'} becomes the QA input without a second click`,async({page})=>{
 const {s,before,selections}=await setup(page,{first});
 const original=structuredClone(s.workspace.draft);
 await upload(page);await selected(page);
 expect(selections).toHaveLength(1);expect(s.uploads).toHaveLength(1);expect(s.uploadBytes).toBe(1);
 expect(s.answers).toEqual([]);expect(s.prepares).toEqual([]);expect(s.workspace.runs).toEqual(before);
 await page.locator('#qa-save').click();
 await expect.poll(()=>s.drafts.length).toBe(1);
 expect(s.drafts[0].draft).toEqual({...original,materials:[s.workspace.prospectus!.asset,newMaterial]});
 await page.reload();await expect(page.locator('.qa-prospectus-row')).toContainText('已纳入本轮材料');
 expect(s.workspace.runs).toEqual(before);expect(s.answers).toEqual([]);
});

test('lost selection receipt is retried once with the same request and no second upload',async({page})=>{
 const {s,selections}=await setup(page,{dropSelection:true});await upload(page);
 await expect(page.locator('#retry-prospectus-selection')).toBeEnabled();
 await expect(page.getByRole('button',{name:'使用此版继续',exact:true})).toHaveCount(0);
 await page.locator('.qa-modal [data-close]').click();await expect(page.locator('#qa-prospectus-panel')).toBeVisible();
 await page.locator('#retry-prospectus-selection').click();await selected(page);
 expect(selections).toHaveLength(2);expect(selections[0]).toEqual(selections[1]);
 expect(s.uploads).toHaveLength(1);expect(s.uploadBytes).toBe(1);expect(s.answers).toEqual([]);
});

test('a failed QA refresh can synchronize the selected upload without selecting again',async({page})=>{
 const {s,selections}=await setup(page,{first:true});let failRead=true;
 await page.route(url=>url.pathname===`/api/v1/projects/${projectId}/qa`,async r=>{
  if(failRead&&selections.length){failRead=false;return r.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});}
  return r.fallback();
 });
 await upload(page);await expect(page.locator('#retry-qa-prospectus-sync')).toBeVisible();
 await expect(page.locator('#prospectus-status')).toContainText('问答资料暂未同步');
 await page.locator('#retry-qa-prospectus-sync').click();await selected(page);
 expect(selections).toHaveLength(1);expect(s.uploadBytes).toBe(1);expect(s.answers).toEqual([]);
});

test('failed upload leaves the old input selected until the upload retry completes',async({page})=>{
 const {s,selections,versions,resumeUpload}=await setup(page,{failUpload:true});await upload(page);
 await expect(page.locator('#save-prospectus-version')).toBeEnabled({timeout:15000});
 expect(selections).toEqual([]);expect(versions.current_version_id).toBe('prospectus-v4');
 resumeUpload();await page.locator('#save-prospectus-version').click();await selected(page);
 expect(s.uploads).toHaveLength(1);expect(s.uploadBytes).toBe(1);expect(selections).toHaveLength(1);
});

test('a concurrent selection is surfaced instead of silently overriding it',async({page})=>{
 const {s,selections,versions}=await setup(page,{conflict:true});await upload(page);
 await expect(page.locator('#prospectus-status')).toContainText('采用未完成');
 await expect(page.locator('#qa-prospectus-panel')).toBeVisible();expect(versions.current_version_id).toBe('prospectus-v4');
 expect(selections).toHaveLength(1);expect(s.answers).toEqual([]);
 await page.locator('[data-prospectus-history-summary]').click();
 await page.locator('[data-use-version="prospectus-new"]').click();await selected(page);
 expect(selections).toHaveLength(2);expect(s.uploadBytes).toBe(1);
});

for(const width of [1440,390])test(`selected prospectus modal remains readable at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});await setup(page,{first:true});await upload(page);await selected(page);
 await page.locator('#qa-manage-prospectus').click();await expect(page.locator('.prospectus-current-file')).toContainText(filename);
 await expect(page.getByRole('button',{name:'使用此版继续',exact:true})).toHaveCount(0);
 expect(await page.locator('.qa-modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 const dir=process.env.BB_UX_EVIDENCE_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`implementation-${width}.png`)});await page.locator('.qa-modal').screenshot({path:join(dir,`implementation-modal-${width}.png`)});
  const reference=await page.context().newPage();await reference.setViewportSize({width,height:960});await reference.goto('/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/qa-prospectus.html',import.meta.url)).replaceAll('\\','/'));await reference.locator('.qa-modal').screenshot({path:join(dir,`prototype-modal-${width}.png`)});await reference.close();}
});
