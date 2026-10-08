import {test,expect,type Page} from '@playwright/test';
import type {Dto} from '../src/api';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const now='2026-10-08T06:30:00Z';
const sample=(id:string,kind:Dto<'ProjectListQuery'>['kind'],status:Dto<'ProjectListQuery'>['status'],name:string):Dto<'ProjectListResponse'>['items'][number]=>({project_id:id,name,kind,status,draft_revision:1,issuer_name:'合成发行人',market:'sse',offering:'private',updated_at:now,latest_run:status==='draft'?null:{run_id:'run-'+id,state:status as NonNullable<Dto<'ProjectListResponse'>['items'][number]['latest_run']>['state'],updated_at:now}});
const rows=[sample('gen','generation','succeeded','主承销商核查意见'),sample('review-run','review','queued','澄川实业 · 募集说明书复核'),sample('update-run','update','running','云岚科技 · 2026 年公司债'),sample('failed','update','failed','启源实业 · 三季度更新'),sample('review','review','succeeded','云岚科技 · 募集说明书复核'),sample('updated','update','succeeded','澄川实业 · 三季度更新'),sample('draft','generation','draft','法律意见书')];
async function setup(page:Page,{failPage=0,extra=0}={}){
 const items=[...rows,...Array.from({length:extra},(_,i)=>sample('extra-'+i,'update','draft','额外合成项目 '+i))];let broken=failPage;const reads:string[]=[];const writes:string[]=[];
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace('/api/v1','');reads.push(path);if(req.method()!=='GET')writes.push(path);
  let body:unknown={},status=200;
  if(path==='/me')body={user_id:'synthetic-dashboard-owner',session_status:'active'};
  else if(path==='/account')body={user_id:'synthetic-dashboard-owner',username:'sample_user'};
  else if(path==='/credits/balance')body={enabled:true,available:86000,frozen:0};
  else if(path==='/projects'){
   const second=url.searchParams.get('cursor')==='page-2';
   if(broken===(second?2:1)){status=503;body={code:'DATA_UNAVAILABLE'};}
   else body={items:second?items.slice(4):items.slice(0,4),page:{has_more:!second,next_cursor:second?null:'page-2'}};
  }else if(path.startsWith('/runs/'))body={run_id:path.split('/')[2],project_id:path.split('/')[2].replace('run-',''),state:path.includes('review')?'queued':'running',stage:'model_generation',updated_at:now};
  else{status=404;body={code:'NOT_FOUND'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });await page.goto('/#dashboard');return{reads,writes,setBroken:(n:number)=>broken=n};
}
test('totals include every page and all three types; filters survive reload and never start tasks',async({page})=>{
 const state=await setup(page,{extra:9});await expect(page.locator('[data-dashboard-count=attention]')).toHaveText('11');await expect(page.locator('[data-dashboard-count=active]')).toHaveText('2');await expect(page.locator('[data-dashboard-count=done]')).toHaveText('3');
 await expect(page.locator('.dashboard-task')).toHaveCount(8);await page.getByRole('button',{name:'显示更多'}).click();await expect(page.locator('.dashboard-task')).toHaveCount(16);
 await page.locator('[data-dashboard-group=done]').click();await expect(page.locator('.dashboard-task')).toHaveCount(3);await page.locator('[data-dashboard-kind=generation]').click();await expect(page.locator('.dashboard-task')).toHaveCount(1);
 await page.reload();await expect(page.locator('.dashboard-task')).toHaveCount(1);await expect(page.locator('[data-dashboard-kind=generation]')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.dashboard-primary-action')).toHaveAttribute('href',/#\/projects\/gen\?.*from=dashboard.*run=run-gen/);expect(state.writes).toEqual([]);
});
test('a failed later page never becomes partial totals; retry and refresh errors preserve honest status',async({page})=>{
 const state=await setup(page,{failPage:2});await expect(page.locator('#dashboard-error')).toContainText('统计暂不可用');await expect(page.locator('[data-dashboard-count=done]')).toHaveText('—');
 state.setBroken(0);await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(page.locator('[data-dashboard-count=done]')).toHaveText('3');
 state.setBroken(1);await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(page.locator('#dashboard-error')).toContainText('上次同步结果');await expect(page.locator('[data-dashboard-count=done]')).toHaveText('3');
});
test('task state actions, new entries, narrow layouts and credit visibility match the approved workbench',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);await expect(page.locator('.dashboard-task')).toHaveCount(7);
 await expect(page.locator('[data-project-id=update-run] .dashboard-task-stage')).toHaveText('正在编制募集书');
 await expect(page.locator('[data-project-id=draft] .dashboard-primary-action')).toHaveText('继续填写');
 await expect(page.locator('[data-project-id=failed] .dashboard-primary-action')).toHaveText('查看原因');
 await expect(page.locator('[data-project-id=review-run] .dashboard-primary-action')).toHaveAttribute('href',/tab=making/);
 await expect(page.locator('.dashboard-start a')).toHaveCount(3);await expect(page.locator('.workflow-card')).toHaveCount(0);
 for(const width of [1440,1024,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator(width>760?'.credit-wallet':'.mobile-credit-wallet')).toBeVisible();if(process.env.DASHBOARD_EVIDENCE&&[1440,390].includes(width)){const dir=resolve('test-evidence/dashboard-status-20261008');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,`implementation-${width}.png`),fullPage:true});}}
 expect(errors).toEqual([]);
});
