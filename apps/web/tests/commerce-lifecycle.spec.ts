import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page,type Route} from '@playwright/test';
import {commerceMetadata,LEGACY_OUTCOME_PRICE_VERSION,OUTCOME_PRICE_VERSION,type PaymentRefund,type PaymentRefundEligibility,type ScopeLine,type ScopeQuoteStatus} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';

// Owner-scoped synthetic HTTP, never a real payment, refund, model call or financial ledger.
const now='2026-10-28T04:00:00Z',future='2030-01-01T00:00:00Z',past='2020-01-01T00:00:00Z';
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,json:fixtureBody(route,body)});
type Quotation=Dto<'CommerceScopeQuotationsResponse'>['items'][number];
type RequestCall={method:string;path:string;body:any};
const quote=(id:string,status:ScopeQuoteStatus,amount=12340,pricing?:ScopeLine['pricing']):Quotation=>({id,project_id:'synthetic-owned-project',action:'question_answer',input_hash:'a'.repeat(64),quote_status:status,price_version:LEGACY_OUTCOME_PRICE_VERSION,amount_fen:amount,scope_lines:[{key:'reply',label:'核对两项业务依据及关联披露',quantity:2,unit:'项',unit_price_fen:amount/2,amount_fen:amount,evidence:['锁定原问题和材料版本。'],pricing}],reason:status==='unavailable'?'当前要求超出可承接范围。':'按已确认的问题与材料范围报价。',created_at:now,published_at:status==='pending_scope'?null:now,expires_at:status==='expired'?past:future,closed_at:status==='declined'?now:null,decline_reason:status==='declined'?'当前范围过大':'',closure_reason:'',revision:1,previous_quote_id:null});
async function evidence(page:Page,name:string,selector:string){const directory=process.env.BB_UX_EVIDENCE_DIR;if(!directory)return;await mkdir(directory,{recursive:true});await page.locator(selector).scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,name),fullPage:false});}
test.beforeEach(async({page})=>page.setViewportSize({width:1440,height:960}));

async function setup(page:Page,options:{uncertainDecline?:boolean;uncertainRefund?:boolean;noCashEvidence?:boolean;foreignOrder?:boolean;legacy?:boolean;legacyBonus?:boolean;scopePricing?:ScopeLine['pricing']}={}){
  const calls:RequestCall[]=[],quotes=[quote('owned-ready','ready',options.scopePricing?.due_fen??12340,options.scopePricing),quote('owned-pending','pending_scope',0),quote('owned-unavailable','unavailable'),quote('owned-declined','declined'),quote('owned-expired','expired')];
  const order={order_id:'owned-order',provider:'wechat',state:'paid',amount_fen:options.legacyBonus?50000:10000,points:options.legacyBonus?52500:10000,currency:'CNY',checkout_url:null,project_id:null,expires_at:future,credited_at:now};
  const refunds:PaymentRefund[]=[];let declineAttempts=0,refundAttempts=0;
  const eligibility=():PaymentRefundEligibility=>({order_id:'owned-order',currency:'CNY',order_amount_fen:order.amount_fen,paid_amount_fen:options.noCashEvidence?null:order.amount_fen,original_points:order.points,request_unit:options.legacyBonus?'points':'amount_fen',refundable_points:options.noCashEvidence?0:(options.legacyBonus?42000:6000)-refunds.filter(r=>r.state!=='failed').reduce((n,r)=>n+r.credit_points,0),refunded_points:refunds.filter(r=>r.state==='succeeded').reduce((n,r)=>n+r.credit_points,0),refundable_fen:options.noCashEvidence?0:(options.legacyBonus?40000:6000)-refunds.filter(r=>r.state!=='failed').reduce((n,r)=>n+r.amount_fen,0),held_refund_fen:refunds.filter(r=>['requested','processing'].includes(r.state)).reduce((n,r)=>n+r.amount_fen,0),refunded_fen:refunds.filter(r=>r.state==='succeeded').reduce((n,r)=>n+r.amount_fen,0),enabled:!options.noCashEvidence,reason:options.noCashEvidence?'历史实付证据待核实，暂不支持自助原路退款。':'仅本单未消费现金余额可申请。',refunds});
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method(),body=request.postData()?fixtureRequest(request):undefined;calls.push({method,path,body});
    if(path==='/me')return json(route,200,{user_id:'lifecycle-owner',session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:'lifecycle-owner',username:'sample_user',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/account/sessions')return json(route,200,{items:[]});
    if(path==='/account/recovery')return json(route,200,{enabled:false,support_operator:false,current:null,pending:null});
    if(path==='/commerce/catalog')return options.legacy?json(route,404,{code:'NOT_FOUND'}):json(route,200,{enabled:true,currency:'CNY',version:'synthetic-lifecycle',model:'pay_as_you_go',items:[],rules:[]});
    if(path==='/commerce/account')return json(route,200,{available_fen:6000,held_fen:4000,payment_enabled:false,providers:[],legacy_balance_notice:'旧积分保留原规则。'});
    if(path==='/credits/balance')return json(route,200,{available:4500,frozen:0,total:4500,expiring:0,expiring_at:null});
    if(path==='/credits/recharge-config')return json(route,200,{enabled:false,providers:[],packs:[]});
    if(path==='/credits/consumption-history')return json(route,200,{items:[],page:{next_cursor:null,has_more:false}});
    if(path==='/credits/recharge-history')return json(route,200,{items:[{...order,created_at:now,...commerceMetadata(10000)}],page:{next_cursor:null,has_more:false}});
    if(path==='/commerce/quotations')return json(route,200,{items:quotes});
    if(path==='/commerce/quotations/owned-ready/decline'){
      declineAttempts++;if(options.uncertainDecline&&declineAttempts===1)return json(route,500,{code:'INTERNAL_ERROR'});
      quotes[0]={...quotes[0],quote_status:'declined',closed_at:now,decline_reason:body.reason};return json(route,200,{quotation:quotes[0]});
    }
    if(path==='/commerce/quotations/owned-expired/requote'){
      const next={...quote('owned-requoted','pending_scope'),revision:2,previous_quote_id:'owned-expired'};quotes.unshift(next);return json(route,200,{quotation:next});
    }
    if(path==='/commerce/topups/owned-order')return json(route,200,order);
    if(path==='/commerce/topups/foreign-order')return json(route,404,{code:'NOT_FOUND'});
    if(path==='/commerce/topups/owned-order/refund-eligibility')return json(route,200,eligibility());
    if(path==='/commerce/topups/owned-order/refunds'){
      refundAttempts++;if(options.uncertainRefund&&refundAttempts===1)return json(route,500,{code:'INTERNAL_ERROR'});
      if(!refunds.length)refunds.push({refund_id:'owned-refund',order_id:'owned-order',currency:'CNY',amount_fen:body.expected_amount_fen??body.amount_fen,credit_points:body.points??body.amount_fen,state:'requested',created_at:now,updated_at:now,completed_at:null,failure_code:null});
      return json(route,202,refunds[0]);
    }
    if(path==='/commerce/refunds/owned-refund/refresh'){
      refunds[0].state=refunds[0].state==='requested'?'processing':'succeeded';refunds[0].completed_at=refunds[0].state==='succeeded'?now:null;return json(route,200,refunds[0]);
    }
    return json(route,404,{code:'NOT_FOUND'});
  });
  return {calls,quotes,refunds};
}
const mutations=(calls:RequestCall[])=>calls.filter(c=>c.method!=='GET');

test('owned quotation states preserve details and decline/requote never submit a financial or task event',async({page})=>{
  const {calls}=await setup(page);await page.goto('/#/account?quotation=foreign-quote');
  await expect(page.locator('[data-quotation="owned-ready"]')).toContainText('已报价');
  await expect(page.locator('[data-quotation="owned-pending"]')).toContainText('待报价不收费，准备材料与要求保留');
  await expect(page.locator('[data-quotation="owned-unavailable"]')).toContainText('暂无法承接');
  await expect(page.locator('[data-quotation="owned-declined"]')).toContainText('已拒绝报价');
  await expect(page.locator('[data-quotation="owned-expired"]')).toContainText('报价已过期');
  await expect(page.locator('[data-quotation="owned-expired"] [data-decline-quote]')).toHaveCount(0);
  await page.locator('[data-quotation="owned-ready"] summary').click();await expect(page.locator('[data-quotation="owned-ready"] details')).toContainText('¥123.40');
  expect(mutations(calls)).toEqual([]);expect(calls.some(c=>c.path.includes('foreign-quote'))).toBe(false);
  await page.locator('[data-decline-quote="owned-ready"]').click();await page.locator('dialog[open] textarea').fill('请缩小本次工作项');await page.getByRole('button',{name:'提交反馈并退出报价',exact:true}).click();
  await expect(page.locator('[data-quotation="owned-ready"]')).toContainText('已记录拒价反馈。本报价未开始、未扣费');
  await page.locator('[data-requote="owned-expired"]').click();await expect(page.locator('[data-quotation="owned-requoted"]')).toContainText('范围报价待确认');
  await expect(page.locator('[data-quotation="owned-expired"]')).toContainText('¥123.40');
  expect(mutations(calls).map(c=>c.path)).toEqual(['/commerce/quotations/owned-ready/decline','/commerce/quotations/owned-expired/requote']);
  await evidence(page,'quotation-lifecycle-1440.png','#commerce-quotations');
});

test('uncertain decline retries the same owned quote and feedback intent without an amount or task mutation',async({page})=>{
  const {calls}=await setup(page,{uncertainDecline:true});await page.goto('/#/account');await page.locator('[data-decline-quote="owned-ready"]').click();await page.locator('dialog[open] textarea').fill('当前预算不适合');
  await page.getByRole('button',{name:'提交反馈并退出报价',exact:true}).click();await expect(page.locator('[data-decline-status]')).toContainText('结果尚未确认');await expect(page.locator('dialog[open] textarea')).toHaveJSProperty('readOnly',true);
  await page.getByRole('button',{name:'提交反馈并退出报价',exact:true}).click();await expect(page.locator('[data-quotation="owned-ready"]')).toContainText('已拒绝报价');
  const posts=mutations(calls);expect(posts).toHaveLength(2);expect(posts[0].body).toEqual(posts[1].body);expect(Object.keys(posts[0].body).sort()).toEqual(['reason','request_id']);
});

test('ready zero coverage keeps stored pricing details distinct from a pending zero quote',async({page})=>{
  const reason='同版本已购覆盖；保留原题 <img data-unsafe-pricing src=x onerror=alert(1)>。';
  const {calls}=await setup(page,{scopePricing:{base_amount_fen:9900,owned_coverage_fen:9900,due_fen:0,reason}});await page.goto('/#/account');
  const ready=page.locator('[data-quotation="owned-ready"]'),pending=page.locator('[data-quotation="owned-pending"]');
  await expect(ready.locator('header>strong')).toHaveText('原范围包含／已购覆盖');await expect(ready).toContainText('无需充值或新增预留');
  await ready.locator('summary').click();await expect(ready.locator('details')).toContainText('原价 ¥99.00 · 已购覆盖 ¥99.00 · 本次应付 ¥0.00');await expect(ready.locator('details')).toContainText(reason);
  await expect(ready.locator('[data-unsafe-pricing]')).toHaveCount(0);await expect(ready.locator('details')).toContainText(`计价规则版本：${LEGACY_OUTCOME_PRICE_VERSION}`);await expect(ready.locator('details')).not.toContainText(OUTCOME_PRICE_VERSION);
  await expect(pending.locator('header>strong')).toHaveText('金额待核');await expect(pending).toContainText('待报价不收费');await expect(pending).not.toContainText('原范围包含／已购覆盖');await expect(pending.locator('[data-decline-quote],[data-commerce-accept],form')).toHaveCount(0);
  expect(mutations(calls)).toEqual([]);
});

test('a positive upgrade renders the server quoted base, owned coverage and due without recomputing',async({page})=>{
  const {calls}=await setup(page,{scopePricing:{base_amount_fen:9900,owned_coverage_fen:3900,due_fen:6000,reason:'同一事项升级，只补已购范围与本次目标之间的差额。'}});await page.goto('/#/account');
  const ready=page.locator('[data-quotation="owned-ready"]');await expect(ready.locator('header>strong')).toHaveText('¥60.00');await ready.locator('summary').click();
  await expect(ready.locator('details')).toContainText('原价 ¥99.00 · 已购覆盖 ¥39.00 · 本次应付 ¥60.00');await expect(ready.locator('details')).toContainText('同一事项升级，只补已购范围与本次目标之间的差额。');expect(mutations(calls)).toEqual([]);
});

test('original-payment refund checks cap, cancellation, exact retry and distinct requested/processing/succeeded states',async({page})=>{
  const {calls}=await setup(page,{uncertainRefund:true});await page.goto('/#/account?order=owned-order');await expect(page.locator('[data-refundable]')).toHaveText('¥60.00');
  expect(mutations(calls)).toEqual([]);
  await page.locator('[data-refund-amount]').fill('60.01');await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await expect(page.locator('.commerce-refunds [role="alert"]')).toContainText('可退金额');expect(mutations(calls)).toEqual([]);
  await page.locator('[data-refund-amount]').fill('20.00');await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await page.locator('[data-refund-cancel]').click();expect(mutations(calls)).toEqual([]);
  await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await page.locator('[data-refund-submit]').click();await expect(page.locator('[data-refund-submit-status]')).toContainText('原申请结果尚未确认');
  await page.locator('[data-refund-submit]').click();await expect(page.locator('[data-refund="owned-refund"] strong')).toHaveText('¥20.00 · 申请已受理');
  const requests=mutations(calls).filter(c=>c.path.endsWith('/refunds'));expect(requests).toHaveLength(2);expect(requests[0].body).toEqual(requests[1].body);expect(Object.keys(requests[0].body).sort()).toEqual(['amount_fen','request_id']);expect(requests[0].body.amount_fen).toBe(2000);
  await page.locator('[data-refund-refresh="owned-refund"]').click();await expect(page.locator('[data-refund="owned-refund"] strong')).toHaveText('¥20.00 · 原路退款处理中');
  await expect(page.locator('.commerce-refunds')).toContainText('任务预留释放是恢复服务余额，不是现金退款');await evidence(page,'original-refund-processing-1440.png','#commerce-refunds');
  await page.locator('[data-refund-refresh="owned-refund"]').click();await expect(page.locator('[data-refund="owned-refund"] strong')).toHaveText('¥20.00 · 已原路退款');
  expect(mutations(calls).map(c=>c.path)).toEqual(['/commerce/topups/owned-order/refunds','/commerce/topups/owned-order/refunds','/commerce/refunds/owned-refund/refresh','/commerce/refunds/owned-refund/refresh']);
});

test('missing verified cash evidence exposes no refund command and a foreign order cannot load eligibility',async({page})=>{
  const {calls}=await setup(page,{noCashEvidence:true});await page.goto('/#/account?order=owned-order');await expect(page.locator('.commerce-refunds')).toContainText('实付证据待核实');await expect(page.locator('[data-refund-form]')).toHaveCount(0);expect(mutations(calls)).toEqual([]);
  await page.goto('/#/account?order=foreign-order');await expect(page.locator('.account-billing-error')).toBeVisible();await expect(page.locator('#commerce-refunds')).toHaveCount(0);expect(calls.some(c=>c.path==='/commerce/topups/foreign-order/refund-eligibility')).toBe(false);expect(mutations(calls)).toEqual([]);
});

test('legacy mode has no quotation or cash-refund traffic',async({page})=>{
  const {calls}=await setup(page,{legacy:true});await page.goto('/#/account');await expect(page.locator('#account-balance-title')).toHaveText('可用积分');await expect(page.locator('.account-balance-value')).toContainText('4,500');await expect(page.locator('#commerce-quotations')).toHaveCount(0);await expect(page.locator('#commerce-refunds')).toHaveCount(0);
  expect(calls.filter(c=>c.path.startsWith('/commerce/')&&c.path!=='/commerce/catalog')).toEqual([]);expect(mutations(calls)).toEqual([]);
});

test('legacy bonus credits refund original cash proportion and retain the exact points request across reload',async({page})=>{
  const {calls}=await setup(page,{legacyBonus:true,uncertainRefund:true});await page.goto('/#/account?order=owned-order');
  await expect(page.locator('[data-refundable]')).toHaveText('¥400.00');
  await page.locator('[data-refund-amount]').fill('42000');await expect(page.locator('[data-refund-preview]')).toContainText('预计原路退回 ¥400.00');
  await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await expect(page.locator('dialog[open]')).toContainText('42,000 积分，对应 ¥400.00');
  await page.locator('[data-refund-submit]').click();await expect(page.locator('[data-refund-submit-status]')).toContainText('原申请结果尚未确认');
  await page.reload();await expect(page.locator('[data-refund-amount]')).toHaveValue('42000');await expect(page.locator('[data-refund-amount]')).toHaveAttribute('readonly','');
  await page.getByRole('button',{name:'重试确认原退款申请',exact:true}).click();await page.locator('[data-refund-submit]').click();
  await expect(page.locator('[data-refund="owned-refund"]')).toContainText('¥400.00 · 申请已受理');await expect(page.locator('[data-refund="owned-refund"]')).toContainText('对应 42,000 积分');
  const requests=mutations(calls).filter(c=>c.path.endsWith('/refunds'));expect(requests).toHaveLength(2);expect(requests[0].body).toEqual(requests[1].body);
  expect(requests[0].body).toEqual({request_id:expect.any(String),points:42000,expected_amount_fen:40000});
  await evidence(page,'legacy-proportional-refund-1440.png','#commerce-refunds');
});

for(const mismatch of ['amount','points'])test(`refund acknowledgement with mismatched ${mismatch} remains unconfirmed with its original durable request`,async({page})=>{
  await setup(page,{legacyBonus:true});const requests:any[]=[];
  await page.route('**/api/v1/commerce/topups/owned-order/refunds',route=>{
    const body=fixtureRequest(route.request());requests.push(body);
    return json(route,202,{refund_id:'wrong-refund',order_id:'owned-order',currency:'CNY',amount_fen:mismatch==='amount'?40001:40000,credit_points:mismatch==='points'?42001:42000,state:'requested',created_at:now,updated_at:now,completed_at:null,failure_code:null});
  });
  await page.goto('/#/account?order=owned-order');await page.locator('[data-refund-amount]').fill('42000');await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();
  await page.locator('[data-refund-submit]').click();await expect(page.locator('[data-refund-submit-status]')).toContainText('原申请结果尚未确认');
  await page.locator('[data-refund-submit]').click();await expect.poll(()=>requests.length).toBe(2);expect(requests[1]).toEqual(requests[0]);
  await expect(page.locator('[data-refund="wrong-refund"]')).toHaveCount(0);
});

test('a durable pre-admission refund rejection permits a fresh request while uncertain failures do not',async({page})=>{
  await setup(page,{legacyBonus:true});const requests:any[]=[];
  await page.route('**/api/v1/commerce/topups/owned-order/refunds',route=>{
    const body=fixtureRequest(route.request());requests.push(body);
    if(requests.length===1)return json(route,409,{code:'BILLING_REQUEST_REJECTED'});
    return json(route,202,{refund_id:'requote-refund',order_id:'owned-order',currency:'CNY',amount_fen:40000,credit_points:42000,state:'requested',created_at:now,updated_at:now,completed_at:null,failure_code:null});
  });
  await page.goto('/#/account?order=owned-order');await page.locator('[data-refund-amount]').fill('42000');await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await page.locator('[data-refund-submit]').click();
  await expect(page.locator('.commerce-refunds [role="alert"]')).toContainText('本次申请未受理、未冻结积分');await expect(page.locator('[data-refund-amount]')).not.toHaveAttribute('readonly','');
  await page.locator('[data-refund-amount]').fill('42000');await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await page.locator('[data-refund-submit]').click();await expect.poll(()=>requests.length).toBe(2);
  expect(requests[0].request_id).not.toBe(requests[1].request_id);expect(requests[1].points).toBe(42000);expect(requests[1].expected_amount_fen).toBe(40000);
});

for(const code of ['PAYMENT_INVALID','QUOTE_CHANGED','BILLING_PROTOCOL_REPLAY_ONLY'])test(`unconfirmed refund ${code} preserves the original immutable intent across reload`,async({page})=>{
  await setup(page,{legacyBonus:true});const requests:any[]=[];
  await page.route('**/api/v1/commerce/topups/owned-order/refunds',route=>{
    const body=fixtureRequest(route.request());requests.push(body);
    if(requests.length===1)return json(route,409,{code});
    return json(route,202,{refund_id:'recovered-original',order_id:'owned-order',currency:'CNY',amount_fen:40000,credit_points:42000,state:'requested',created_at:now,updated_at:now,completed_at:null,failure_code:null});
  });
  await page.goto('/#/account?order=owned-order');await page.locator('[data-refund-amount]').fill('42000');await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();await page.locator('[data-refund-submit]').click();
  await expect(page.locator('[data-refund-submit-status]')).toContainText('原申请结果尚未确认');
  await page.reload();await expect(page.locator('[data-refund-amount]')).toHaveValue('42000');await expect(page.locator('[data-refund-amount]')).toHaveAttribute('readonly','');expect(requests).toHaveLength(1);
  await page.getByRole('button',{name:'重试确认原退款申请',exact:true}).click();await page.locator('[data-refund-submit]').click();await expect.poll(()=>requests.length).toBe(2);expect(requests[1]).toEqual(requests[0]);
});
