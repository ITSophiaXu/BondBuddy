import {test,expect,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DATA_POLICY_VERSION,DELETION_PURGED_CONTENT,DELETION_RETAINED_METADATA,SUBSCRIPTION_PLANS,SUBSCRIPTION_CATALOG_VERSION,AUTOMATIC_PRICE_VERSION} from '@bondbuddy/contracts';
import {fixtureBody} from './billing-fixture-wire';

// Read-only synthetic fixture shapes reused from register.spec, account.spec,
// all-projects.spec and subscription-account.spec. Never connects to a merchant.
const directory=process.env.BB_UX_AUDIT_DIR;
const now='2026-11-13T04:00:00Z',future='2030-01-01T00:00:00Z';
const policy={policy_version:DATA_POLICY_VERSION,storage_location:'platform_private_cloud',server_side_processing:true,model_provider_processing:true,active_retention:'until_user_deletes',purge_enabled:false,deleted_content_purge_days:null,orphan_upload_purge_hours:null,log_content_retention_days:30,backup_retention_days:null,pinned_by_active_run:'retained_until_run_ends',purged_content:[...DELETION_PURGED_CONTENT],retained_metadata:[...DELETION_RETAINED_METADATA]};
function project(id:string,kind:string,state:string|null){
 const task=state?{run_id:'run-'+id,project_id:id,kind,state,stage:'model_generation',created_at:now,updated_at:now,artifact_id:null,report_id:null,topic_id:null,document_type:null,operation:null}:null;
 return {project_id:id,name:'合成交通建设发展集团有限公司2026年度债券项目 '+id,kind,status:state??'draft',draft_revision:1,issuer_name:'合成交通建设发展集团有限公司',market:'sse',offering:'private',updated_at:now,file_count:state==='succeeded'?2:0,latest_run:task?{run_id:task.run_id,state:task.state,updated_at:now}:null,task_summary:{active:['running','queued'].includes(state??'')?1:0,attention:state===null||state==='failed'?1:0,completed:state==='succeeded'?1:0,total:task?1:0,latest:task,recent_result:state==='succeeded'||state==='failed'?task:null}};
}
const projects=[project('gen','generation','succeeded'),project('review','review','queued'),project('update','update','running'),project('failed','update','failed'),project('done','review','succeeded'),project('draft','update',null)];
async function install(page:Page,anonymous=false){
 const writes:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method();
  if(method!=='GET'&&!path.endsWith('/refresh')){writes.push(path);return route.fulfill({status:405,json:{code:'AUDIT_READ_ONLY'}});}
  const reply=(body:unknown,status=200)=>route.fulfill({status,json:status<400?fixtureBody(route,body):body});
  if(path==='/auth/agreement')return reply({terms_version:'synthetic-terms-20261113',title:'BondBuddy 用户协议与数据保存说明',summary_url_or_path:'/#/data-policy',support_contact:null});
  if(path==='/data-policy')return reply(policy);
  if(anonymous)return reply({code:'UNAUTHENTICATED'},401);
  if(path==='/me')return reply({user_id:'ux-audit-owner',session_status:'active'});
  if(path==='/account')return reply({user_id:'ux-audit-owner',username:'synthetic_ux_audit',phone_masked:'+86138****5678',status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
  if(path==='/account/sessions')return reply({items:[{session_id:'current-session',current:true,created_at:now,last_refreshed_at:now,refresh_expires_at:future},{session_id:'other-session',current:false,created_at:now,last_refreshed_at:now,refresh_expires_at:future}]});
  if(path==='/account/recovery')return reply({enabled:false,support_operator:false,current:null,pending:null});
  if(path==='/billing/permissions')return reply({permissions:[]});
  if(path==='/admin/inspection/access')return reply({allowed:false});
  if(path==='/subscriptions/catalog')return reply({enabled:true,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,providers:['wechat','alipay'],auto_renew_available:false});
  if(path==='/subscriptions/account')return reply({subscription:null,available_points:19782,held_points:1218,task_held_points:1218,refund_held_points:0,subscription_available_points:0,topup_available_points:19782,other_available_points:0,periods:[]});
  if(path==='/commerce/catalog')return reply({enabled:true,currency:'CNY',version:AUTOMATIC_PRICE_VERSION,model:'subscription_and_topup',items:[],rules:[]});
  if(path==='/commerce/quotations')return reply({items:[]});
  if(path==='/credits/balance')return reply({enabled:true,available:19782,frozen:1218});
  if(path==='/credits/consumption-history'||path==='/credits/recharge-history')return reply({items:[],page:{next_cursor:null,has_more:false}});
  if(path==='/commerce/topups/audit-pending-order'||path==='/commerce/topups/audit-pending-order/refresh')return reply({order_id:'audit-pending-order',provider:'wechat',state:'pending',amount_fen:5000,points:5000,currency:'CNY',checkout_url:'weixin://wxpay/bizpayurl?pr=synthetic-local-audit',project_id:null,expires_at:future,credited_at:null});
  if(path==='/subscriptions/orders/audit-pending-order/period')return reply({order_id:'audit-pending-order',period:null});
  if(path==='/projects')return reply({items:projects,page:{next_cursor:null,has_more:false}});
  if(path.endsWith('/tasks')){const p=projects.find(p=>p.project_id===path.split('/')[2])!;return reply({project_id:p.project_id,items:p.task_summary.latest?[p.task_summary.latest]:[],page:{next_cursor:null,has_more:false}});}
  return reply({code:'NOT_FOUND'},404);
 });return{writes,errors};
}
async function capture(page:Page,name:string){
 await page.evaluate(()=>document.fonts.ready);
 const data=await page.evaluate(()=>{
  const visible=(e:Element)=>{const r=e.getBoundingClientRect();return e.checkVisibility()&&r.width>0&&r.height>0;};
  const desc=(e:Element)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,id:e.id,classes:e.className,text:(e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,100),x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom,gap:s.gap,padding:s.padding,margin:s.margin};};
  // An open menu/modal intentionally covers the background; audit active-layer controls.
  const overlay=[...document.querySelectorAll('dialog[open],[role=menu]')].find(visible);
  const controls=[...document.querySelectorAll('main button,main a.btn,main a.button,main label.btn,main select,main input:not([type=hidden]),main textarea,main summary,dialog[open] button,dialog[open] input')].filter(e=>visible(e)&&(!overlay||overlay.contains(e)));
  return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('main *,dialog[open] *')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left< -1;}).slice(0,40).map(desc),small:controls.filter(e=>{const r=e.getBoundingClientRect();return r.height<40&&r.width>20;}).map(desc),controls:controls.map(desc),occluded:controls.filter(e=>e.matches('button.primary,button[type=submit]')).filter(e=>{const r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)return false;const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&!e.contains(hit);}).map(desc)};
 });
 if(directory){await mkdir(directory,{recursive:true});await writeFile(join(directory,name+'.json'),JSON.stringify(data,null,2));await page.screenshot({path:join(directory,name+'.png'),fullPage:true});}
 console.log(JSON.stringify({name,scrollWidth:data.scrollWidth,viewport:data.viewport,overflow:data.overflow.map(e=>({id:e.id,classes:e.classes,text:e.text,x:e.x,w:e.w})),small:data.small.map(e=>({id:e.id,text:e.text,h:e.h})),occluded:data.occluded}));
 expect(data.scrollWidth).toBeLessThanOrEqual(data.viewport+1);expect(data.occluded).toEqual([]);
}
for(const width of [1440,390,320]){
 for(const scene of ['login','register','projects'])test(`secondary ${scene} ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:960});const state=await install(page,scene!=='projects');
  await page.goto(scene==='projects'?'/#tasks':scene==='register'?'/#/register':'/');
  if(scene==='projects'){await expect(page.locator('.collection-project')).toHaveCount(6);await page.locator('[data-tasks=update]').click();await expect(page.locator('[data-run-id=run-update]')).toBeVisible();}
  else await expect(page.getByRole('heading',{name:scene==='register'?'注册工作区账号':'登录工作区'})).toBeVisible();
  await capture(page,`${scene}-${width}`);
  if(scene==='projects'){await page.locator('[data-work=update]').click();await expect(page.getByRole('menuitem',{name:'检查文件一致性'})).toBeVisible();await capture(page,`projects-menu-${width}`);}
  expect(state.writes).toEqual([]);expect(state.errors).toEqual([]);
 });
}
for(const scene of ['account','payment','settings'])test(`secondary ${scene} 320px`,async({page})=>{
 await page.setViewportSize({width:320,height:960});const state=await install(page);
 await page.goto(scene==='payment'?'/#/account?order=audit-pending-order':'/#/account');
 await expect(page.locator('.account-page')).toBeVisible();
 if(scene==='payment')await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
 else {await expect(page.locator('.subscription-topup')).toBeVisible();if(scene==='settings'){await page.locator('#open-account-settings').click();await page.locator('summary').filter({hasText:'登录会话'}).click();await page.locator('summary').filter({hasText:'修改密码'}).click();}}
 await capture(page,`${scene}-320`);expect(state.writes).toEqual([]);expect(state.errors).toEqual([]);
});
