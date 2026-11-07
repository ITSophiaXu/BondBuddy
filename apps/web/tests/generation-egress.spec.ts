import {test,expect} from '@playwright/test';
import {emptyFileGenerationPreparation,type WorkpaperBatch} from '@bondbuddy/contracts';
import {workspace,ids,now,sha} from './generation-entry-fixtures';
import {fixtureBody} from './billing-fixture-wire';

for(const kind of ['workpapers','file-generation'] as const){
 test(kind+': stable progress stays tiny, hidden/terminal pages stop, foreground refreshes once',async({page})=>{
  const source=workspace().source!,entry={id:'item',code:'1',title:'合成文件',folder:'1 尽职调查',kind:'file' as const,sheet:'目录',row:2,instructions:'',path:'1.docx'};
  const batch:WorkpaperBatch={batch_id:'batch',topic_id:'topic',catalogue_id:'catalogue',revision:1,state:'running',source,total_points:0,charged_points:0,created_at:now,error:null,
   items:[{entry,run_id:'run',state:'running',stage:'writing',attempt:1,error:null,artifacts:[]}]};
  const data={catalogues:[{catalogue_id:'catalogue',filename:'目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:[entry]}],batches:[batch],assessments:[]};
  const generation={revision:1,preparation:{...emptyFileGenerationPreparation(),document_types:[]},sets:[],builtin:{name:'光大模板',version:'',available:false},batches:[{batch_id:'g',created_at:now,points:0,workpapers:batch,documents:null}]};
  let details=0,progress=0,revision='a'.repeat(64),active=true;
  await page.route('**/egress-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="test-host"></div>'}));
  await page.route('**/api/v1/projects/*/'+kind+'**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/progress')){progress++;return route.fulfill({json:{revision,active}});}
   details++;return route.fulfill({json:fixtureBody(route,kind==='workpapers'?data:generation)});
  });
  await page.clock.install();
  await page.goto('/egress-test#generate?view=results&batch=batch');
  await page.evaluate(async({kind,workspace,project,owner})=>{
   const apiModule='/src/api.ts',panelModule='/src/'+(kind==='workpapers'?'workpaper-panel':'file-generation-panel')+'.ts';
   const {ApiClient}=await import(apiModule),module=await import(panelModule),host=document.querySelector<HTMLElement>('#test-host')!;
   const Constructor=kind==='workpapers'?module.WorkpaperPanel:module.FileGenerationPanel;
   const panel=new Constructor(new ApiClient(()=>{}),host,project,owner,kind==='workpapers'?workspace.source:workspace,()=>true);
   (window as any).egressPanel=panel;await panel.render();
  },{kind,workspace:workspace(),project:ids.api,owner:ids.owner});
  await expect(page.locator(kind==='workpapers'?'.wp-batch':'.fg-batch')).toBeVisible();
  expect(details).toBe(1);const interval=kind==='workpapers'?10_000:15_000;
  await page.clock.fastForward(interval);await expect.poll(()=>details).toBe(2);expect(progress).toBe(1);
  await page.clock.fastForward(interval);await expect.poll(()=>progress).toBe(2);expect(details).toBe(2);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.clock.fastForward(86_400_000);expect(progress).toBe(2);expect(details).toBe(2);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>details).toBe(3);expect(progress).toBe(3);
  batch.state='complete';batch.items[0].state='succeeded';batch.revision++;revision='b'.repeat(64);active=false;
  await page.clock.fastForward(interval);await expect.poll(()=>details).toBe(4);
  await expect(page.locator(kind==='workpapers'?'.wp-batch':'.fg-batch')).toContainText('已完成');
  const settled=progress;await page.clock.fastForward(86_400_000);expect(progress).toBe(settled);expect(details).toBe(4);
  // A foreground visit can discover a task started elsewhere without polling idle pages.
  batch.state='running';batch.items[0].state='running';active=true;revision='c'.repeat(64);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>details).toBe(5);
  await page.evaluate(()=>{(window as any).egressPanel.dispose();});const disposed=progress;
  await page.clock.fastForward(86_400_000);expect(progress).toBe(disposed);
 });
}


test('library: idle and hidden pages stop, activity and manual refresh still work',async({page})=>{
 let calls=0;const data={items:[],total:0,offset:0,limit:50,source:null,checks:[],paid_checks:[],active:false};
 await page.route('**/egress-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="test-host"></div>'}));
 await page.route('**/api/v1/projects/p/workpapers/library?*',route=>{calls++;return route.fulfill({json:data});});
 await page.clock.install();await page.goto('/egress-test');
 await page.evaluate(async()=>{
  const api='/src/api.ts',panel='/src/workpaper-library.ts';const {ApiClient}=await import(api),{WorkpaperLibraryPanel}=await import(panel);
  const instance=new WorkpaperLibraryPanel(new ApiClient(()=>{}),document.querySelector('#test-host'),'p');
  (window as any).egressPanel=instance;await instance.render();
 });
 expect(calls).toBe(1);await page.clock.fastForward(86_400_000);expect(calls).toBe(1);
 data.active=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect.poll(()=>calls).toBe(2);
 await page.clock.fastForward(10_000);await expect.poll(()=>calls).toBe(3);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 await page.clock.fastForward(86_400_000);expect(calls).toBe(3);data.active=false;
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
 await expect.poll(()=>calls).toBe(4);await page.clock.fastForward(86_400_000);expect(calls).toBe(4);
 await page.evaluate(()=>(window as any).egressPanel.dispose());
});
