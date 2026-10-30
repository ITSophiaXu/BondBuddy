import {test,expect,type Page} from '@playwright/test';
import type {Dto} from '../src/api';
const now='2026-10-20T06:30:00Z';
const sample=(id:string,kind:Dto<'ProjectTasksResponse'>['items'][number]['kind'],state:Dto<'ProjectTasksResponse'>['items'][number]['state']|null):Dto<'ProjectListResponse'>['items'][number]=>{
 const task=state?{run_id:'run-'+id,project_id:id,kind,state,stage:'model_generation',created_at:now,updated_at:now,artifact_id:null,report_id:null,topic_id:null,document_type:null,operation:null}:null;
 return {project_id:id,name:'合成项目 '+id,kind,status:state??'draft',draft_revision:1,issuer_name:'合成发行人',market:'sse',offering:'private',updated_at:now,file_count:state==='succeeded'?2:0,latest_run:task?{run_id:task.run_id,state:task.state,updated_at:now}:null,task_summary:{active:['running','queued'].includes(state??'')?1:0,attention:state===null||state==='failed'?1:0,completed:state==='succeeded'?1:0,total:task?1:0,latest:task,recent_result:state==='succeeded'||state==='failed'?task:null}};
};
const rows=[sample('gen','generation','succeeded'),sample('review','review','queued'),sample('update','update','running'),sample('failed','update','failed'),sample('done','review','succeeded'),sample('draft','update',null)];
async function setup(page:Page,{failPage=0,extra=0}={}){
 const items=[...rows,...Array.from({length:extra},(_,i)=>sample('extra-'+i,'update',null))];let broken=failPage;const writes:string[]=[];
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace('/api/v1','');if(req.method()!=='GET')writes.push(path);
  let body:unknown={},status=200;
  if(path==='/me')body={user_id:'synthetic-owner',session_status:'active'};
  else if(path==='/account')body={user_id:'synthetic-owner',username:'sample_user'};
  else if(path==='/credits/balance')body={enabled:true,available:86000,frozen:0};
  else if(path==='/projects'){
   const second=url.searchParams.get('cursor')==='page-2';
   if(broken===(second?2:1)){status=503;body={code:'DATA_UNAVAILABLE'};}
   else body={items:second?items.slice(4):items.slice(0,4),page:{has_more:!second,next_cursor:second?null:'page-2'}};
  }else if(path.endsWith('/tasks')){const p=items.find(p=>p.project_id===path.split('/')[2])!;body={project_id:p.project_id,items:p.task_summary?.latest?[p.task_summary.latest]:[],page:{has_more:false,next_cursor:null}};}
  else{status=404;body={code:'NOT_FOUND'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });await page.goto('/#dashboard');return{writes,setBroken:(n:number)=>broken=n};
}
test('old workbench redirects to projects; totals include every page and filters survive reload',async({page})=>{
 const s=await setup(page,{extra:29});await expect(page).toHaveURL(/#tasks$/);
 await expect(page.locator('[data-count=attention]')).toHaveText('31');await expect(page.locator('[data-count=active]')).toHaveText('2');await expect(page.locator('[data-count=done]')).toHaveText('2');
 await expect(page.locator('.collection-project')).toHaveCount(30);await page.getByRole('button',{name:'加载更多项目'}).click();await expect(page.locator('.collection-project')).toHaveCount(35);
 await page.locator('[data-group=active]').click();await expect(page.locator('.collection-project')).toHaveCount(2);await page.reload();await expect(page.locator('[data-group=active]')).toHaveAttribute('aria-pressed','true');
 await page.locator('[data-tasks=review]').click();await expect(page.locator('[data-run-id=run-review] a')).toHaveAttribute('href',/from=projects&run=run-review&tab=making/);
 expect(s.writes).toEqual([]);
});
test('failed later page never becomes partial totals and refresh errors preserve prior data',async({page})=>{
 const s=await setup(page,{failPage:2});await expect(page.locator('#collection-error')).toContainText('项目与任务未能同步');await expect(page.locator('[data-count=done]')).toHaveText('—');
 s.setBroken(0);await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(page.locator('[data-count=done]')).toHaveText('2');
 s.setBroken(1);await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(page.locator('#collection-error')).toContainText('上次同步结果');await expect(page.locator('[data-count=done]')).toHaveText('2');
});
test('inline tasks, scoped menu, project consistency link and responsive layout',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);
 await expect(page.getByRole('navigation',{name:'主导航'}).getByRole('link').first()).toHaveText('任务进度与结果');await expect(page.getByRole('link',{name:'工作台',exact:true})).toHaveCount(0);
 await expect(page.locator('[data-tasks=update]')).toHaveAttribute('aria-expanded','false');await page.locator('[data-tasks=update]').click();await expect(page.locator('[data-run-id=run-update]')).toContainText('正在更新募集书');
 await page.locator('[data-work=update]').click(); const consistency=page.getByRole('menuitem',{name:'检查文件一致性'});await expect(consistency).toHaveAttribute('href','#consistency?project=update');await expect(consistency).toHaveText('检查文件一致性');
 await expect(page.getByRole('menuitem',{name:'复核募集书'})).toHaveAttribute('href','#review?project=update&from=projects');await page.getByRole('menuitem',{name:'更新募集书'}).press('Escape');
 await page.getByRole('searchbox').fill('没有这个发行人');await expect(page.getByText('没有找到匹配的项目')).toBeVisible();await page.getByRole('button',{name:'清除筛选'}).click();await expect(page.locator('.collection-project')).toHaveCount(6);
 for(const width of [1440,1024,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 expect(errors).toEqual([]);
});
