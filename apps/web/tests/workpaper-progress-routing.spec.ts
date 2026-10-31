import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {WorkpaperBatch,WorkpaperWorkspace} from '@bondbuddy/contracts';
import {fixture,ids,now,sha} from './generation-entry-fixtures';
import {fixtureBody} from './billing-fixture-wire';

// Synthetic HTTP data, real project-list/file-page routes and WorkpaperPanel.
async function setup(page:Page){
  const original=await fixture(page),source=original.workspaces.get(ids.api)!.source!;
  const entries=Array.from({length:40},(_,i)=>({id:`item-${i}`,code:`1.${i+1}`,title:`合成核查 ${i+1}`,folder:'1 尽职调查文件',kind:'file' as const,sheet:'目录',row:i+2,instructions:'',path:`1.${i+1}.docx`}));
  const target:WorkpaperBatch={batch_id:'requested-batch',topic_id:'batch-topic',catalogue_id:'catalogue',revision:2,state:'running',start_mode:'direct',source:{...source,filename:'本批募集说明书.docx'},total_points:13500,charged_points:4500,created_at:now,error:null,
    items:entries.slice(0,3).map((entry,i)=>({entry,run_id:`item-run-${i}`,state:i===0?'succeeded':i===1?'running':'queued',stage:null,attempt:1,error:null,
      artifacts:i===0?[{kind:'document',filename:'合成已完成底稿.docx',pin:{source_project_id:'execution-project',artifact_id:'completed-workpaper',artifact_version:1,sha256:sha}}]:[]}))};
  const newer:WorkpaperBatch={...structuredClone(target),batch_id:'newer-batch',source:{...source,filename:'另一批募集说明书.docx'},items:[],state:'complete'};
  const data:WorkpaperWorkspace={catalogues:[{catalogue_id:'catalogue',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries}],assessments:[],batches:[newer,target]};
  const task={run_id:target.batch_id,project_id:ids.api,kind:'generation',state:'running',stage:null,created_at:now,updated_at:now,artifact_id:null,report_id:null,topic_id:'batch-topic',document_type:'workpaper',operation:'workpaper_batch',workpaper_batch:{batch_id:target.batch_id,project_id:ids.api,total:248,completed:120}};
  const calls:{path:string;method:string}[]=[],state={missing:false};
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');calls.push({path,method:request.method()});
    if(path==='/projects')return route.fulfill({json:{items:[{project_id:ids.api,name:'合成批量底稿项目',kind:'generation',draft_revision:1,updated_at:now,file_count:1,task_summary:{active:1,attention:0,completed:0,total:1,latest:task,recent_result:null}}],page:{has_more:false,next_cursor:null}}});
    if(path===`/projects/${ids.api}/tasks`)return route.fulfill({json:{project_id:ids.api,items:[task],page:{has_more:false,next_cursor:null}}});
    if(path===`/projects/${ids.api}/workpapers`)return route.fulfill({json:fixtureBody(route,data)});
    if(path===`/projects/${ids.api}/workpapers/batches/${target.batch_id}`)return route.fulfill(state.missing?{status:404,json:{code:'NOT_FOUND'}}:{json:fixtureBody(route,target)});
    await route.fallback();
  });
  return {original,target,newer,data,task,calls,state,href:`/#generate?project=${ids.api}&step=workpapers&view=results&batch=${target.batch_id}`};
}
const targetPanel=(page:Page)=>page.locator('[data-wp-batch-id="requested-batch"]');
test('ZIP preparation polls until ready, saves the file and keeps one active download',async({page})=>{
  const s=await setup(page);let reads=0;
  await page.route('**/workpapers/batches/requested-batch/download',route=>{
    expect(route.request().headers().prefer).toBe('respond-async');reads++;
    return reads<=2?route.fulfill({status:202,headers:{'retry-after':'1'},json:{status:'preparing'}})
      :route.fulfill({contentType:'application/zip',body:Buffer.concat([Buffer.from('PK'),Buffer.alloc(100)])});
  });
  await page.goto(s.href);const button=targetPanel(page).locator('[data-wp-zip]');
  const download=page.waitForEvent('download');await button.click();
  await expect(page.locator('#wp-download-feedback')).toContainText('正在准备下载');await expect(button).toBeDisabled();
  expect((await download).suggestedFilename()).toBe('底稿文件包.zip');expect(reads).toBe(3);
  await expect(button).toBeEnabled();expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('leaving during the polling delay cancels further download requests',async({page})=>{
  const s=await setup(page);let reads=0;
  await page.route('**/workpapers/batches/requested-batch/download',route=>{
    reads++;return route.fulfill({status:202,headers:{'retry-after':'1'},json:{status:'preparing'}});
  });
  await page.goto(s.href);await targetPanel(page).getByRole('button',{name:'下载已完成文件（ZIP）'}).click();
  await expect.poll(()=>reads).toBe(1);
  await page.getByRole('navigation',{name:'文件生成导航'}).getByRole('link',{name:'项目文件',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.api}/files`));
  await page.waitForTimeout(1200);expect(reads).toBe(1);
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

for(const streaming of [false,true])test(`leaving an unfinished ZIP download keeps navigation usable and cancels the read, streaming=${streaming}`,async({page})=>{
  const s=await setup(page);
  await page.addInitScript(({streaming})=>{
    const original=window.fetch;
    Object.assign(window,{zipReadAborted:false,zipReadCount:0});
    window.fetch=(...args)=>{
      if(!String(args[0]).endsWith('/workpapers/batches/requested-batch/download'))return original(...args);
      (window as any).zipReadCount++;
      return new Promise<Response>((resolve,reject)=>{
        let body:ReadableStreamDefaultController<Uint8Array>|undefined;
        const abort=()=>{(window as any).zipReadAborted=true;const error=new DOMException('Aborted','AbortError');body?.error(error);reject(error);};
        args[1]?.signal?.addEventListener('abort',abort,{once:true});
        if(streaming)resolve(new Response(new ReadableStream<Uint8Array>({start(controller){body=controller;controller.enqueue(new Uint8Array(1024));}}),{headers:{'content-type':'application/zip','content-length':'2048'}}));
      });
    };
  },{streaming});
  await page.goto(s.href);await targetPanel(page).getByRole('button',{name:'下载已完成文件（ZIP）'}).click();
  await expect(page.locator('#wp-download-feedback')).toContainText(streaming?'50%':'正在准备下载');
  await page.getByRole('navigation',{name:'文件生成导航'}).getByRole('link',{name:'项目文件',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.api}/files`));
  await expect.poll(()=>page.evaluate(()=>(window as any).zipReadAborted)).toBe(true);
  expect(await page.evaluate(()=>(window as any).zipReadCount)).toBe(1);
  await page.goBack();await expect(targetPanel(page)).toBeVisible();
  await expect(targetPanel(page).getByRole('button',{name:'下载已完成文件（ZIP）'})).toBeEnabled();
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);expect(s.original.errors).toEqual([]);
});

test('a failed ZIP can retry successfully and then leave the result page',async({page})=>{
  const s=await setup(page);let reads=0;
  await page.route('**/workpapers/batches/requested-batch/download',route=>++reads===1
    ?route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}})
    :route.fulfill({contentType:'application/zip',body:Buffer.concat([Buffer.from('PK'),Buffer.alloc(100)])}));
  await page.goto(s.href);const button=targetPanel(page).getByRole('button',{name:'下载已完成文件（ZIP）'});
  await button.click();await expect(page.locator('#wp-download-feedback')).toContainText('暂时无法读取');await expect(button).toBeEnabled();
  const download=page.waitForEvent('download');await button.click();await download;
  await page.getByRole('navigation',{name:'文件生成导航'}).getByRole('link',{name:'项目文件',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.api}/files`));expect(reads).toBe(2);
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);expect(s.original.errors).toEqual([]);
});

async function assertTarget(page:Page){
  const panel=targetPanel(page);
  await expect(panel).toContainText('本批募集说明书.docx');await expect(panel).toContainText('1 / 3 份完成');
  await expect(panel.locator('details')).toHaveAttribute('open','');
  await expect(panel.getByRole('button',{name:'下载底稿',exact:true})).toBeVisible();
  await expect(panel.getByRole('button',{name:'下载已完成文件（ZIP）'})).toBeVisible();
  await expect(panel).toBeInViewport();
  await expect.poll(()=>panel.locator('.wp-batch-heading').evaluate(el=>el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(80);
}

for(const width of [1440,390])test(`project list opens and expands the exact batch progress ${width}`,async({page})=>{
  const s=await setup(page);await page.setViewportSize({width,height:960});await page.goto('/#tasks');
  await page.locator(`[data-tasks="${ids.api}"]`).click();
  await expect(page.locator('[data-run-id]')).toHaveCount(1);
  await expect(page.locator(`[data-run-id="${s.task.run_id}"]`)).toContainText('批量生成底稿');
  await expect(page.locator(`[data-run-id="${s.task.run_id}"]`)).toContainText('120 / 248 份完成');
  await mkdir('test-evidence/workpaper-download-batch-20261029',{recursive:true});
  await page.screenshot({path:`test-evidence/workpaper-download-batch-20261029/task-${width}.png`,fullPage:true});
  await page.locator(`[data-run-id="${s.task.run_id}"]`).getByRole('link',{name:'查看结果'}).click();
  await expect(page).toHaveURL(new RegExp(`project=${ids.api}.*step=workpapers&view=results&batch=requested-batch`));
  await assertTarget(page);await expect(page.locator('[data-wp-batch-id="newer-batch"] details')).not.toHaveAttribute('open','');
  await mkdir('test-evidence/workpaper-progress-routing',{recursive:true});
  await page.screenshot({path:`test-evidence/workpaper-progress-routing/implementation-${width}.png`});
  await page.reload();await assertTarget(page);
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);expect(s.original.errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('ZIP download shows waiting state and a usable save link if automatic download is suppressed',async({page})=>{
  const s=await setup(page);
  await page.addInitScript(()=>{
    const click=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){if(!this.download)click.call(this);};
  });
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let reads=0;
  await page.route('**/workpapers/batches/requested-batch/download',async route=>{reads++;await gate;await route.fulfill({contentType:'application/zip',body:Buffer.concat([Buffer.from('PK'),Buffer.alloc(100)])});});
  await page.goto(s.href);await page.getByRole('button',{name:'下载已完成文件（ZIP）'}).first().click();
  await expect(page.getByRole('button',{name:'正在准备下载…'})).toBeDisabled();
  await expect(page.locator('#wp-download-feedback')).toContainText('正在准备下载');release();
  const save=targetPanel(page).locator('#wp-download-feedback').getByRole('link',{name:'保存文件'});await expect(save).toBeInViewport();
  await mkdir('test-evidence/workpaper-download-batch-20261029',{recursive:true});
  await page.screenshot({path:'test-evidence/workpaper-download-batch-20261029/download-ready.png'});
  await page.clock.install();await page.clock.fastForward(6000);await expect(save).toBeVisible();
  const download=page.waitForEvent('download');await save.click();expect((await download).suggestedFilename()).toBe('底稿文件包.zip');
  expect(reads).toBe(1);expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

for(const knownLength of [true,false])test(`streamed ZIP updates the button and byte progress, known length=${knownLength}`,async({page})=>{
  const s=await setup(page);
  await page.addInitScript(({knownLength})=>{
    const original=window.fetch;
    window.fetch=(...args)=>{
      if(!String(args[0]).endsWith('/workpapers/batches/requested-batch/download'))return original(...args);
      return new Promise<Response>(resolve=>{
        let stream!:ReadableStreamDefaultController<Uint8Array>;
        const body=new ReadableStream<Uint8Array>({start(c){stream=c;}});
        Object.assign(window,{zipChunk:()=>{resolve(new Response(body,{headers:{'content-type':'application/zip',...(knownLength?{'content-length':'2097152'}:{})}}));stream.enqueue(new Uint8Array(1048576));},zipFinish:()=>{stream.enqueue(new Uint8Array(1048576));stream.close();}});
      });
    };
  },{knownLength});
  await page.goto(s.href);await page.getByRole('button',{name:'下载已完成文件（ZIP）'}).first().click();
  await expect(page.getByRole('button',{name:'正在准备下载…'})).toBeDisabled();
  await page.evaluate(()=> (window as any).zipChunk());
  await expect(page.getByRole('button',{name:'正在下载…',exact:true})).toBeDisabled();
  const feedback=page.locator('#wp-download-feedback');await expect(feedback).toContainText('正在下载');
  if(knownLength)await expect(feedback).toContainText('50%');else await expect(feedback).not.toContainText('%');
  await mkdir('test-evidence/workpaper-download-speed',{recursive:true});
  await page.screenshot({path:`test-evidence/workpaper-download-speed/streaming-${knownLength}.png`});
  await page.evaluate(()=> (window as any).zipFinish());await expect(feedback.getByRole('link',{name:'保存文件'})).toBeVisible();
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('a hanging ZIP request ends visibly and the same batch can retry without resubmitting generation',async({page})=>{
  const s=await setup(page);await page.clock.install();
  let reads=0;
  await page.route('**/workpapers/batches/requested-batch/download',async route=>{reads++;if(reads===1)return;await route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});});
  await page.goto(s.href);await page.getByRole('button',{name:'下载已完成文件（ZIP）'}).first().click();
  await expect.poll(()=>reads).toBe(1);await page.clock.fastForward(20*60_000+1);
  await expect(page.locator('#wp-download-feedback')).toContainText('下载准备超时');
  await page.getByRole('button',{name:'下载已完成文件（ZIP）'}).first().click();
  await expect(page.locator('#wp-download-feedback')).toContainText('文件');
  expect(reads).toBe(2);expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

test('project files recent task opens the source batch and retains return navigation',async({page})=>{
  const s=await setup(page);await page.goto(`/#/projects/${ids.api}/files`);
  await page.locator(`[data-pw-task-run="${s.task.run_id}"]`).getByRole('link',{name:'查看进度'}).click();
  await assertTarget(page);await expect(page).toHaveURL(new RegExp(`batch=requested-batch&return_project=${ids.api}`));
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);expect(s.original.errors).toEqual([]);
});

test('historical target outside recent ten remains current across polling and honors manual collapse',async({page})=>{
  const s=await setup(page);s.data.batches=Array.from({length:10},(_,i)=>({...s.newer,batch_id:`recent-${i}`}));
  await page.clock.install();await page.goto(s.href);await assertTarget(page);
  const path=`/projects/${ids.api}/workpapers/batches/requested-batch`,reads=()=>s.calls.filter(c=>c.path===path).length;
  expect(reads()).toBe(1);await targetPanel(page).locator('summary').click();
  s.target.items[1].state='succeeded';await page.clock.fastForward(5100);
  await expect(targetPanel(page)).toContainText('2 / 3 份完成');await expect(targetPanel(page).locator('details')).not.toHaveAttribute('open','');expect(reads()).toBe(2);
  await page.reload();await expect(targetPanel(page).locator('details')).toHaveAttribute('open','');await expect(targetPanel(page)).toContainText('2 / 3 份完成');
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);expect(s.original.errors).toEqual([]);
});

test('a missing or inaccessible requested batch fails visibly instead of displaying another batch',async({page})=>{
  const s=await setup(page);s.data.batches=[s.newer];s.state.missing=true;await page.goto(s.href);
  await expect(page.getByText('底稿记录暂时无法读取。原记录已保留，请刷新重试。')).toBeVisible();
  await expect(page.locator('[data-wp-batch-id]')).toHaveCount(0);expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});

for(const width of [1440,390])test(`existing batch prototype comparison ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});
  await page.goto('/@fs/'+resolve(process.cwd(),'../../product-prototype/public/workpaper-batch.html').replaceAll('\\','/'));
  await page.locator('#wp-start').click();await page.locator('#wp-batches summary').click();
  await page.locator('#wp-batches .wp-batch').evaluate(el=>el.scrollIntoView({block:'start'}));
  await mkdir('test-evidence/workpaper-progress-routing',{recursive:true});
  await page.screenshot({path:`test-evidence/workpaper-progress-routing/prototype-${width}.png`});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
