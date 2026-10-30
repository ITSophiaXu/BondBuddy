import {test,expect,type Page,type Route} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DATA_POLICY_VERSION,DELETION_PURGED_CONTENT,DELETION_RETAINED_METADATA,AUTOMATIC_PRICE_VERSION,type TaskRefundRecord,type TaskRefundEligibility} from '@bondbuddy/contracts';

const now='2026-10-29T04:00:00Z';
const json=(r:Route,status:number,value:unknown)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const policy={policy_version:DATA_POLICY_VERSION,storage_location:'platform_private_cloud',server_side_processing:true,model_provider_processing:true,active_retention:'until_user_deletes',purge_enabled:false,deleted_content_purge_days:null,orphan_upload_purge_hours:null,log_content_retention_days:30,backup_retention_days:null,pinned_by_active_run:'retained_until_run_ends',purged_content:[...DELETION_PURGED_CONTENT],retained_metadata:[...DELETION_RETAINED_METADATA]};
const record=():TaskRefundRecord=>({refund_request_id:'quality-request-1',request_id:'customer-request-1',run_id:'qa-run',reason:'回复与原募集说明书不一致，需要核实原两题。',state:'requested',created_at:now,decided_at:null,decision_reason:null,requested_points:'2436',refunded_points:'0',items:[{item_id:'unit-q0',label:'问题 1：财务数据口径',points:'1218',approved:false},{item_id:'unit-q1',label:'问题 2：重大事项说明',points:'1218',approved:false}]});
async function setup(page:Page,options:{admin?:boolean;denied?:boolean;unknown?:boolean}={}){
  const calls:{path:string;method:string;body:any}[]=[],requests:TaskRefundRecord[]=options.admin?[record()]:[];let createAttempts=0,decisionAttempts=0;
  const units=record().items.map((i,index)=>({item_id:i.item_id,source_item_key:'q'+index,label:i.label,charged_points:i.points,refunded_points:'0',available_points:i.points,pending:false,evidence_kind:'automatic_scope' as const}));
  const eligibility=():TaskRefundEligibility=>({run_id:'qa-run',reservation_id:'qa-reservation',enabled:units.some(u=>u.available_points!=='0'),reason:'请选择原任务中存在质量问题的条目。',charged_points:'2436',refunded_points:requests.reduce((n,r)=>n+BigInt(r.refunded_points),0n).toString(),units,requests});
  await page.route('**/api/v1/**',async r=>{
    const q=r.request(),path=new URL(q.url()).pathname.replace('/api/v1',''),method=q.method(),body=q.postData()?q.postDataJSON():undefined;calls.push({path,method,body});
    if(path==='/me')return json(r,200,{user_id:options.admin?'refund-reviewer':'refund-customer',session_status:'active'});
    if(path==='/account')return json(r,200,{user_id:'refund-customer',username:'synthetic_refund',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/account/sessions')return json(r,200,{items:[]});
    if(path==='/account/recovery')return json(r,200,{enabled:false,support_operator:false,current:null,pending:null});
    if(path==='/data-policy')return json(r,200,policy);
    if(path==='/billing/permissions')return json(r,200,{permissions:options.admin&&!options.denied?['task_refund_approve']:[]});
    if(path==='/subscriptions/catalog')return json(r,200,{enabled:true,version:'bb-subscriptions-20261029-v1',providers:[],auto_renew_available:false,plans:[{id:'light',label:'轻量',amount_fen:'19900',points:'21000',period_months:1,credit_valid_days:90}]});
    if(path==='/subscriptions/account')return json(r,200,{subscription:null,available_points:'2000',held_points:'0',task_held_points:'0',refund_held_points:'0',subscription_available_points:'0',topup_available_points:'2000',other_available_points:'0',periods:[]});
    if(path==='/commerce/catalog')return json(r,200,{enabled:true,currency:'CNY',version:AUTOMATIC_PRICE_VERSION,model:'subscription_and_topup',items:[],rules:[]});
    if(path==='/commerce/quotations')return json(r,200,{items:[]});
    if(path==='/credits/consumption-history')return json(r,200,{items:[{reservation_id:'qa-reservation',run_id:'qa-run',project_id:'p1',project_name:'合成发债项目',task_name:'问题回复',created_at:now,finalized_at:now,state:'settled',reserved_points:'2436',charged_points:'2436',released_points:'0',corrected_points:eligibility().refunded_points,pricing_mode:'outcome_cny_v1',price_version:AUTOMATIC_PRICE_VERSION,currency:'CNY',amount_fen:'2436'}],page:{next_cursor:null,has_more:false}});
    if(path==='/credits/recharge-history')return json(r,200,{items:[],page:{next_cursor:null,has_more:false}});
    if(path==='/tasks/qa-run/refund-eligibility')return json(r,200,eligibility());
    if(path==='/tasks/qa-run/refund-requests'){
      createAttempts++;let existing=requests.find(x=>x.request_id===body.request_id);
      if(!existing){existing={...record(),request_id:body.request_id,reason:body.reason,items:record().items.filter(i=>body.item_ids.includes(i.item_id)),requested_points:(BigInt(body.item_ids.length)*1218n).toString()};requests.push(existing);for(const u of units)if(body.item_ids.includes(u.item_id)){u.pending=true;u.available_points='0';}}
      if(options.unknown&&createAttempts===1)return r.abort('failed');return json(r,200,existing);
    }
    if(path.startsWith('/admin/task-refunds')){
      if(options.denied)return json(r,404,{code:'NOT_FOUND'});
      if(path==='/admin/task-refunds')return json(r,200,{items:requests,next_cursor:null});
      if(method==='GET')return json(r,200,requests[0]);
      decisionAttempts++;const current=requests[0];if(current.state==='requested'){current.items=current.items.map(i=>({...i,approved:body.item_ids.includes(i.item_id)}));current.refunded_points=current.items.reduce((n,i)=>n+(i.approved?BigInt(i.points):0n),0n).toString();current.state=current.refunded_points==='0'?'rejected':current.refunded_points===current.requested_points?'approved':'partially_approved';current.decision_reason=body.reason;current.decided_at=now;}
      if(options.unknown&&decisionAttempts===1)return r.abort('failed');return json(r,200,current);
    }
    return json(r,404,{code:'NOT_FOUND'});
  });
  return{calls,requests,approve:()=>{const r=requests[0];r.state='approved';r.decided_at=now;r.decision_reason='核实属于原任务质量问题，返还原来源积分。';r.refunded_points=r.requested_points;r.items.forEach(i=>i.approved=true);for(const u of units)if(r.items.some(i=>i.item_id===u.item_id)){u.pending=false;u.refunded_points=u.charged_points;u.available_points='0';}}};
}
async function screenshot(page:Page,name:string,selector:string){if(!process.env.BB_UX_EVIDENCE_DIR)return;await mkdir(process.env.BB_UX_EVIDENCE_DIR,{recursive:true});const path=join(process.env.BB_UX_EVIDENCE_DIR,name);if(name.includes('-390')){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path,fullPage:true});}else await page.locator(selector).screenshot({path});}
test.beforeEach(async({page})=>page.setViewportSize({width:1440,height:960}));

test('customer selects original items, retries unknown response with the same request and reads approved progress',async({page})=>{
  const f=await setup(page,{unknown:true});await page.goto('/#/account');
  await page.getByRole('button',{name:'申请任务售后／查看进度'}).click();
  await page.locator('[data-task-refund-item="unit-q1"]').check();await page.locator('[data-task-refund-reason]').fill('第 2 题的答复与原募集说明书披露不一致。');
  await page.getByRole('button',{name:'提交售后申请',exact:true}).click();await expect(page.getByRole('button',{name:'重试原申请',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'重试原申请',exact:true}).click();await expect(page.locator('.task-refunds')).toContainText('待售后审核');
  const posts=f.calls.filter(c=>c.path==='/tasks/qa-run/refund-requests');expect(posts).toHaveLength(2);expect(posts[0].body).toEqual(posts[1].body);expect(Object.keys(posts[0].body).sort()).toEqual(['item_ids','reason','request_id']);expect(posts[0].body.item_ids).toEqual(['unit-q1']);
  f.approve();await page.getByRole('button',{name:'刷新申请进度'}).click();await expect(page.locator('.task-refunds')).toContainText('已全部返还积分');await expect(page.locator('.task-refunds')).toContainText('1,218 积分');
  expect(f.calls.some(c=>c.method==='POST'&&c.path.startsWith('/commerce/topups'))).toBe(false);
  await screenshot(page,'task-quality-customer-1440.png','.task-refunds');
  await page.setViewportSize({width:390,height:844});await screenshot(page,'task-quality-customer-390.png','.task-refunds');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('independent reviewer approves selected subset; unknown response preserves the original decision',async({page})=>{
  const f=await setup(page,{admin:true,unknown:true});await page.goto('/#/billing/task-refunds');await page.getByRole('button',{name:'查看／处理申请'}).click();
  await page.locator('[data-task-admin-item="unit-q0"]').uncheck();await page.locator('[data-task-admin-reason]').fill('核实第 2 题为平台质量问题，批准该题；第 1 题未发现偏差。');
  await page.getByRole('button',{name:'批准所选并结案',exact:true}).click();await expect(page.getByRole('button',{name:'重试原审批',exact:true})).toBeEnabled();await page.getByRole('button',{name:'重试原审批',exact:true}).click();
  await expect(page.locator('[aria-label="审批详情"]')).toContainText('已部分返还积分');await expect(page.locator('[data-task-admin-form]')).toHaveCount(0);
  const posts=f.calls.filter(c=>c.method==='POST');expect(posts).toHaveLength(2);expect(posts[0].body).toEqual(posts[1].body);expect(posts[0].body.item_ids).toEqual(['unit-q1']);expect(posts[0].body).not.toHaveProperty('points');
  await screenshot(page,'task-quality-reviewer-1440.png','.task-refund-admin');
});
test('a reviewer without the separate permission cannot see or approve customer requests',async({page})=>{
  const f=await setup(page,{admin:true,denied:true});await page.goto('/#/billing/task-refunds');await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'批准所选并结案'})).toHaveCount(0);await expect(page.getByRole('button',{name:'查看／处理申请'})).toHaveCount(0);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(0);
});
