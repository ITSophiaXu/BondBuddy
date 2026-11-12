import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {emptyFileGenerationPreparation,type FileGenerationBatch,type M4Task} from '@bondbuddy/contracts';
import {sourceFixture} from './generation-source-fixtures';
import {ids,href,now} from './generation-entry-fixtures';
import {fixtureBody} from './billing-fixture-wire';
const bytes=Buffer.from('synthetic original batch document'),sha=createHash('sha256').update(bytes).digest('hex');
const pin=(id:string)=>({source_project_id:'generation-entry-execution',artifact_id:id,artifact_version:1,sha256:sha});
async function setup(page:import('@playwright/test').Page){
 const s=await sourceFixture(page,true),w=s.state.workspaces.get(ids.api)!;
 const entry=(id:string,title:string)=>({id,code:'1.'+id,title,folder:'1',instructions:'',sheet:'目录',row:Number(id),kind:'file' as const,path:title});
 const task={run:{run_id:'doc-original',project_id:w.workspace.topic.project_id,state:'succeeded'},manifest:{kind:'document',topic_id:ids.topic,input:{document_type:'init',project_file:{project_id:ids.api,source_version_id:w.source!.version_id}}},artifacts:[{...pin('doc-artifact'),topic_id:ids.topic,run_id:'doc-original',kind:'document',document_type:'init',filename:'立项报告.docx'}]} as unknown as M4Task;
 w.workspace.tasks=[task,{...structuredClone(task),run:{...task.run,run_id:'later'},artifacts:[{...task.artifacts[0],artifact_id:'later-file',run_id:'later',filename:'后来的立项报告.docx'}]}];
 const batch:FileGenerationBatch={batch_id:'original-parent',created_at:now,points:0,workpapers:{batch_id:'original-wp',topic_id:'wp-topic',catalogue_id:'cat-original',state:'partial',revision:1,source:w.source!,created_at:now,total_points:0,charged_points:0,error:null,items:[
  {entry:entry('1','主体资格核查'),run_id:'wp-run',state:'succeeded',stage:null,attempt:1,error:null,artifacts:[{kind:'document',filename:'主体资格核查.docx',pin:pin('wp-artifact')}]},
  {entry:entry('2','授信核查'),run_id:null,state:'succeeded',stage:null,attempt:0,error:null,artifacts:[],explanation:{filename:'授信说明.docx',sha256:sha},decision:{item_id:'2',status:'missing_information',reason:'未提供本期授信材料。',missing_materials:['本期授信文件'],citations:[]}},
  {entry:entry('3','担保核查'),run_id:'failed',state:'failed',stage:null,attempt:1,error:'本次处理未完成；已保存材料保留。',artifacts:[]}
 ]},documents:{batch_id:'original-docs',state:'complete',items:[{document_type:'init',run_id:'doc-original',state:'succeeded',error:null},{document_type:'legal',run_id:'missing-run',state:'succeeded',error:null}]}};
 const control={list:[batch],mismatch:false,failWorkspace:false,downloads:[] as string[],writes:[] as string[]};
 await page.route('**/api/v1/projects/*/file-generation**',async route=>{const u=new URL(route.request().url());if(route.request().method()!=='GET'){control.writes.push(u.pathname);return route.fulfill({status:500,json:{code:'NOT_ALLOWED'}});}const data=u.pathname.includes('/batches/')?batch:{revision:1,preparation:{...emptyFileGenerationPreparation(),document_types:['init']},sets:[],builtin:{name:'合成',version:'v1',available:false},batches:control.list};return route.fulfill({json:fixtureBody(route,data)});});
 await page.route('**/api/v1/projects/*/project-files/workspace',route=>control.failWorkspace?route.abort():route.fulfill({json:fixtureBody(route,w)}));
 await page.route('**/api/v1/artifacts/*',route=>{const id=new URL(route.request().url()).pathname.split('/').at(-1)!;return route.fulfill({json:{artifact_id:id,version:control.mismatch?2:1,run_id:id==='wp-artifact'?'wp-run':'doc-original',sha256:sha,quality_status:'passed',delivery_status:'available',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',download_url:'/api/v1/artifacts/'+id+'/download'}});});
 await page.route('**/api/v1/artifacts/*/download',route=>{control.downloads.push(route.request().url());return route.fulfill({body:bytes,contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});});
 return {s,w,batch,control};
}
for(const width of [1440,390])test(`accurate mixed delivery list, download and reference comparison ${width}`,async({page})=>{
 const {control}=await setup(page);await page.setViewportSize({width,height:1000});await page.goto('/'+href({step:'prepare',delivery_batch:'original-parent'}));
 const list=page.locator('[data-delivery-batch="original-parent"]');await expect(list).toHaveAttribute('open','');await expect(list.locator('.fg-delivery-list>li')).toHaveCount(5);
 await expect(list.locator('.fg-delivery-stats dd')).toHaveText(['2','1','1','1']);await expect(list).toContainText('需补充：本期授信文件');await expect(list).not.toContainText('后来的立项报告');
 await expect(list.getByRole('link',{name:'查看原任务'}).first()).toHaveAttribute('href',/run=doc-original/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const evidence=process.env.BB_UX_964_EVIDENCE;if(evidence){await mkdir(evidence,{recursive:true});await list.evaluate(e=>window.scrollTo({top:e.getBoundingClientRect().top+scrollY-110,behavior:'instant'}));await page.screenshot({path:join(evidence,`implementation-${width}.png`)});}
 const download=page.waitForEvent('download');await list.getByRole('button',{name:'下载 立项报告.docx · V1',exact:true}).click();expect((await download).suggestedFilename()).toBe('立项报告.docx');expect(control.downloads).toHaveLength(1);
 await expect(list.locator('[data-delivery-status]')).toContainText('交给浏览器');await page.locator('#fg-refresh').click();await expect(list).toHaveAttribute('open','');await page.reload();await expect(list).toHaveAttribute('open','');expect(control.writes).toEqual([]);
 if(evidence){await page.goto('/@fs/'+resolve('../../product-prototype/public/file-delivery-checklist.html'));await page.locator('.fg-delivery').evaluate(e=>window.scrollTo({top:e.getBoundingClientRect().top+scrollY-110,behavior:'instant'}));await page.screenshot({path:join(evidence,`prototype-${width}.png`)});}
});
test('historical parent outside recent list is fetched exactly, not replaced',async({page})=>{const {control}=await setup(page);control.list=[];await page.goto('/'+href({step:'prepare',delivery_batch:'original-parent'}));await expect(page.locator('.fg-delivery-list>li')).toHaveCount(5);await page.locator('#fg-refresh').click();await expect(page.locator('.fg-delivery-list>li')).toHaveCount(5);expect(control.writes).toEqual([]);});
test('mismatching artifact version is not downloaded and button can retry',async({page})=>{const {control}=await setup(page);control.mismatch=true;await page.goto('/'+href({step:'prepare',delivery_batch:'original-parent'}));const b=page.getByRole('button',{name:'下载 立项报告.docx · V1',exact:true});await b.click();await expect(page.locator('[data-delivery-status]')).toContainText('版本无法核对');expect(control.downloads).toEqual([]);await expect(b).toBeEnabled();control.mismatch=false;const download=page.waitForEvent('download');await b.click();await download;expect(control.downloads).toHaveLength(1);});
test('metadata outage keeps scope and marks document output unknown',async({page})=>{const {control}=await setup(page);
 await page.goto('/'+href({step:'prepare',delivery_batch:'original-parent'}));await expect(page.locator('.fg-delivery-list>li')).toHaveCount(5);control.failWorkspace=true;await page.locator('#fg-refresh').click();await expect(page.locator('.fg-delivery-stats dd')).toHaveText(['1','1','1','2']);expect(control.writes).toEqual([]);
});
