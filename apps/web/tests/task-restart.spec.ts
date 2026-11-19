import {test,expect,type Page} from '@playwright/test';
const original={run_id:'saved-run',project_id:'saved-project',state:'paused',stage:'user_paused',input_revision:7,input_hash:'a'.repeat(64),updated_at:'2026-11-19T02:00:00Z'};
async function mount(page:Page,kind='update',stage='user_paused',width=1000){
 await page.setViewportSize({width,height:900});
 await page.route('**/restart-test',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body></body></html>'}));
 await page.goto('/restart-test');
 await page.evaluate(async({kind,run})=>{
  const path='/src/task-restart.ts',progressPath='/src/task-progress.ts',styles='/src/task-restart.css',baseStyles='/src/style.css';
  const restart=await import(path),progress=await import(progressPath);await import(styles);await import(baseStyles);
  document.body.innerHTML='<main style="max-width:900px;margin:auto"><h1>更新募集书</h1><section class="panel execution-panel" id="task"></section></main>';
  document.getElementById('task')!.innerHTML=kind==='generic'?restart.taskRestartHtml(run):progress.taskProgress(run,kind,{summary:'材料与已有成果保留，从已保存进度继续。'});
  const api={run:async(id:string)=>{const r=await fetch('/api/v1/runs/'+id);if(!r.ok)throw new Error('read failed');return r.json();},runAction:async(id:string,action:string)=>{const r=await fetch('/api/v1/runs/'+id+'/'+action,{method:'POST'});if(!r.ok)throw new Error('restart response unknown');return r.json();}};
  restart.installTaskRestart(api,()=>sessionStorage.getItem('restart-owner')??'user-one');
 },{kind,run:{...original,stage}});
}
for(const kind of ['update','review','revision','material','export','generic'])test(kind+' pause has a restart which reads the original run then queues it once',async({page})=>{
 let posts=0,reads=0,queued=false;
 await page.route('**/api/v1/runs/saved-run',async r=>{reads++;await r.fulfill({json:{...original,...(queued?{state:'queued',stage:'queued'}:{})}});});
 await page.route('**/api/v1/runs/saved-run/resume',async r=>{posts++;await new Promise(ok=>setTimeout(ok,120));queued=true;await r.fulfill({json:{...original,state:'queued',stage:'queued'}});});
 await mount(page,kind);await expect(page.getByRole('button',{name:'重新启动',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'重新启动',exact:true}).click();
 await expect(page.getByRole('button',{name:'正在启动…'})).toBeDisabled();
 await expect(page.locator('.task-restart [role="status"]')).toContainText('正在排队');expect(posts).toBe(1);expect(reads).toBe(1);
});
test('lost response and another tab already resuming never create another task',async({page})=>{
 let reads=0,posts=0;await page.route('**/api/v1/runs/saved-run',r=>r.fulfill({json:{...original,...(++reads>1?{state:'queued',stage:'queued'}:{})}}));
 await page.route('**/api/v1/runs/saved-run/resume',r=>{posts++;return r.abort();});
 await mount(page);await page.getByRole('button',{name:'重新启动',exact:true}).click();await expect(page.locator('.task-restart [role="status"]')).toContainText('正在排队');expect(posts).toBe(1);expect(reads).toBe(2);
});
for(const stage of ['provider_reconcile','billing_reconcile','awaiting_materials','trial_limit'])test(stage+' remains inspectable without resume writes',async({page})=>{
 let posts=0;await page.route('**/api/v1/runs/**',r=>{if(r.request().method()==='POST')posts++;return r.fulfill({json:{...original,stage}});});
 await mount(page,'generic',stage);await expect(page.getByRole('button',{name:'重新启动',exact:true})).toBeDisabled();await page.getByRole('button',{name:'检查恢复状态'}).click();await expect(page.getByRole('button',{name:'检查恢复状态'})).toBeEnabled();expect(posts).toBe(0);
});
test('navigation or owner change during a read stops restart before writing',async({page})=>{
 let release:()=>void=()=>{},reads=0,posts=0;const gate=new Promise<void>(ok=>release=ok);
 await page.route('**/api/v1/runs/saved-run',async r=>{reads++;await gate;await r.fulfill({json:original});});
 await page.route('**/api/v1/runs/saved-run/resume',r=>{posts++;return r.fulfill({json:{...original,state:'queued'}});});
 await mount(page);await page.getByRole('button',{name:'重新启动',exact:true}).click();await expect.poll(()=>reads).toBe(1);
 await page.evaluate(()=>sessionStorage.setItem('restart-owner','user-two'));release();await expect.poll(()=>posts).toBe(0);
});
test('narrow screen retains restart, read-only status check and readable feedback',async({page},info)=>{
 await mount(page,'update','user_paused',390);
 await expect(page.getByRole('button',{name:'重新启动',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('paused-mobile.png'),fullPage:true});
});

test('restart refresh subscriptions end when the page is disposed',async({page})=>{
 await mount(page);
 const calls=await page.evaluate(async()=>{
  const path='/src/task-restart.ts',m=await import(path),controller=new AbortController();let calls=0;
  m.onTaskRestart(controller.signal,()=>{calls++;});window.dispatchEvent(new CustomEvent(m.TASK_RESTARTED_EVENT));await new Promise(ok=>setTimeout(ok,0));
  controller.abort();window.dispatchEvent(new CustomEvent(m.TASK_RESTARTED_EVENT));await new Promise(ok=>setTimeout(ok,0));return calls;
 });expect(calls).toBe(1);
});
test('desktop paused state retains the original page layout and visible primary action',async({page},info)=>{
 await mount(page,'update','user_paused',768);await expect(page.getByRole('button',{name:'重新启动',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('paused-desktop.png'),fullPage:true});
});

for(const placement of ['workpaper','file-check'])test(placement+' paused item controls wrap on narrow screens',async({page})=>{
 await mount(page,'generic','user_paused',390);
 await page.evaluate(async({placement,run})=>{
  const path='/src/task-restart.ts',m=await import(path),css=placement==='workpaper'?'/src/workpaper-progressive.css':'/src/project-file-check-batches.css';await import(css);
  const content='<span>1-2 关联交易专项核查记录及详细业务说明</span><a href="#original">查看任务</a>'+m.taskRestartHtml(run,{compact:true});
  document.getElementById('task')!.innerHTML=placement==='workpaper'?'<div class="wpg-attention-links"><div>'+content+'</div></div>':'<section class="file-check-batch"><ul><li>'+content+'</li></ul></section>';
 },{placement,run:original});
 await expect(page.getByRole('button',{name:'重新启动',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

for(const phase of ['read','resume'] as const)test('polling card replacement during '+phase+' preserves one restart and visible feedback',async({page})=>{
 let reads=0,posts=0,release!:()=>void;const gate=new Promise<void>(ok=>release=ok);
 await page.route('**/api/v1/runs/saved-run',async r=>{reads++;if(phase==='read')await gate;await r.fulfill({json:original});});
 await page.route('**/api/v1/runs/saved-run/resume',async r=>{posts++;if(phase==='resume')await gate;await r.fulfill({json:{...original,state:'queued',stage:'queued'}});});
 await mount(page);await page.getByRole('button',{name:'重新启动',exact:true}).click();await expect.poll(()=>phase==='read'?reads:posts).toBe(1);
 await page.evaluate(()=>{const card=document.querySelector<HTMLElement>('[data-task-restart]')!;card.outerHTML=card.outerHTML;});release();
 await expect.poll(()=>posts,{timeout:3000}).toBe(1);await expect(page.locator('.task-restart [role="status"]')).toContainText('正在排队',{timeout:3000});
 expect(reads).toBe(1);expect(posts).toBe(1);await expect(page.getByRole('button',{name:'重新启动',exact:true})).toBeHidden();
});

for(const change of ['route','remove'] as const)test('restart stops when '+change+' invalidates the task context',async({page})=>{
 let reads=0,posts=0,release!:()=>void;const gate=new Promise<void>(ok=>release=ok);
 await page.route('**/api/v1/runs/saved-run',async r=>{reads++;await gate;await r.fulfill({json:original});});
 await page.route('**/api/v1/runs/saved-run/resume',r=>{posts++;return r.fulfill({json:{...original,state:'queued'}});});
 await mount(page);await page.getByRole('button',{name:'重新启动',exact:true}).click();await expect.poll(()=>reads).toBe(1);
 await page.evaluate(change=>{if(change==='route')location.hash='#another-task';else document.querySelector('[data-task-restart]')!.remove();},change);
 const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/runs/saved-run'));release();await(await response).finished();await page.waitForTimeout(200);expect(posts).toBe(0);
});
