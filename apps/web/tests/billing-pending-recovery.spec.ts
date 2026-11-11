import {expect,test} from '@playwright/test';
import {INTEGRITY_PRICE} from '@bondbuddy/contracts';
import {assertFixture,fixture,install,ownerId,projectId,writes} from './integrity-continuation-fixtures';

// Synthetic browser protocol/recovery tests. The matching PG tests prove that
// BILLING_REQUEST_REJECTED is emitted only after its rejection receipt commits.
for(const numeric of [true,false])test(`an old ${numeric?'numeric':'string'} 5000 integrity pending unlocks only after durable rejection and never auto-starts`,async({page})=>{
 const state=fixture(),request={request_id:'synthetic-old-integrity-pending',expected_revision:state.workspace.revision,expected_points:numeric?5000:'5000',price_version:INTEGRITY_PRICE.version};
 const value={revision:state.workspace.revision,draft:state.workspace.draft,pending:{kind:'check',request}};
 await page.addInitScript(({owner,project,value})=>{
  if(sessionStorage.getItem('synthetic-seeded-integrity'))return;
  localStorage.setItem(`bb-integrity-recovery:${owner}:${project}`,JSON.stringify({version:'integrity-recovery-cache-v1',owner,project,value}));sessionStorage.setItem('synthetic-seeded-integrity','1');
 },{owner:ownerId,project:projectId,value});
 await install(page,state);await page.goto(`/#integrity?project=${projectId}`);
 await expect(page.locator('#integrity-retry-pending')).toBeEnabled();await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',true);expect(writes(state)).toEqual([]);
 state.rejectCheck='BILLING_REQUEST_REJECTED';await page.locator('#integrity-retry-pending').click();
 await expect(page.locator('#integrity-retry-pending')).toHaveCount(0);await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',false);
 expect(state.checks).toEqual([{...request,expected_points:5000}]);expect(state.accepted.size).toBe(0);
 const saved=await page.evaluate(({owner,project})=>{
  const raw=localStorage.getItem(`bb-integrity-recovery:${owner}:${project}`)!;
  return{value:JSON.parse(raw).value,journal:Object.keys(localStorage).filter(key=>key.startsWith(`bb-integrity-recovery-journal-v1:${owner}:${project}:`))};
 },{owner:ownerId,project:projectId});
 expect(saved.value.pending).toBeUndefined();expect(saved.value.draft).toEqual(value.draft);expect(saved.journal).toEqual([]);
 await page.reload();await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',false);expect(state.checks).toHaveLength(1);expect(state.drafts).toEqual([]);
 await assertFixture(page);
});

for(const code of ['BILLING_PROTOCOL_REPLAY_ONLY','QUOTE_CHANGED','INPUT_REVISION_CONFLICT','CREDITS_INSUFFICIENT'] as const)test(`an unconfirmed ${code} error and a lost response keep the exact old integrity key, amount and pending after reload`,async({page})=>{
 const state=fixture(),request={request_id:'synthetic-still-unknown-integrity',expected_revision:state.workspace.revision,expected_points:5000,price_version:INTEGRITY_PRICE.version};
 await page.addInitScript(({owner,project,workspace,request})=>{
  if(sessionStorage.getItem('synthetic-seeded-integrity'))return;
  localStorage.setItem(`bb-integrity-recovery:${owner}:${project}`,JSON.stringify({version:'integrity-recovery-cache-v1',owner,project,value:{revision:workspace.revision,draft:workspace.draft,pending:{kind:'check',request}}}));sessionStorage.setItem('synthetic-seeded-integrity','1');
 },{owner:ownerId,project:projectId,workspace:state.workspace,request});
 await install(page,state);await page.goto(`/#integrity?project=${projectId}`);state.rejectCheck=code;
 await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.checks.length).toBe(1);await expect(page.locator('#integrity-retry-pending')).toBeEnabled();
 state.dropCheck='before';await page.locator('#integrity-retry-pending').click();await expect.poll(()=>state.checks.length).toBe(2);
 page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.locator('#integrity-retry-pending')).toBeEnabled();await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',true);
 expect(state.checks).toEqual([request,request]);expect(state.accepted.size).toBe(0);
 const original=await page.evaluate(({owner,project})=>JSON.parse(localStorage.getItem(`bb-integrity-recovery:${owner}:${project}`)!).value.pending.request,{owner:ownerId,project:projectId});expect(original).toEqual(request);
 await assertFixture(page);
});

test('the whole annual refund component submits every eligible cent above the former cash cap',async({page})=>{
 await page.route('**/api/v1/**',route=>route.fulfill({status:401,json:{code:'UNAUTHENTICATED'}}));await page.goto('/');
 await page.evaluate(async()=>{
  const module='/src/commerce-refunds.ts', {CommerceRefunds}=await import(module),requests:unknown[]=[];
  const eligibility={order_id:'synthetic-annual-order',currency:'CNY',order_amount_fen:'1078920',paid_amount_fen:'1078920',original_points:'1368000',request_unit:'amount_fen',refundable_points:'114000',refunded_points:'0',refundable_fen:'1078920',held_refund_fen:'0',refunded_fen:'0',enabled:true,reason:'',refunds:[]};
  const api={request:async(method:string,_path:string,body:unknown)=>{if(method==='GET')return eligibility;requests.push(body);return{refund_id:'synthetic-annual-refund',order_id:'synthetic-annual-order',currency:'CNY',amount_fen:'1078920',credit_points:'114000',state:'requested',created_at:'2026-11-11T00:00:00Z',updated_at:'2026-11-11T00:00:00Z',completed_at:null,failure_code:null};}};
  document.body.innerHTML='<main><div id="synthetic-refund"></div></main>';const component=new CommerceRefunds(api,()=>true,'synthetic-owner',()=>true);component.mount(document.getElementById('synthetic-refund'),'synthetic-annual-order');Object.assign(window,{syntheticRefundRequests:requests});
 });
 await expect(page.locator('[data-refund-amount]')).toHaveValue('10789.20');await expect(page.locator('[data-refund-amount]')).toHaveAttribute('readonly','');
 await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await page.locator('[data-refund-submit]').click();
 await expect.poll(()=>page.evaluate(()=>(window as any).syntheticRefundRequests.length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).syntheticRefundRequests[0])).toEqual({request_id:expect.any(String),amount_fen:'1078920'});
});
