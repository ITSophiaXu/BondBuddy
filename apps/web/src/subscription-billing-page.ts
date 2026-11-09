import QRCode from 'qrcode';
import {schemas,subscriptionSchemas,type CommerceCatalog,type SubscriptionCatalog,type SubscriptionAccount,type SubscriptionCheckoutRequest,type Subscription,type SubscriptionChangeQuote} from './billing-types.js';
import {int64,formatPoints,formatFen,parseYuanToFen,BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION,subscriptionOrderDetailSchemas,type SubscriptionOrderPeriodDetail} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {CreditHistory} from './credit-history';
import {CommerceRefunds} from './commerce-refunds';
import {CommerceQuotations} from './commerce-quotations';
import {cny} from './commerce';
import {date,esc} from './ui';
import {rechargeHref,workReturnTo} from './project-navigation';
import {readBillingTask,billingTaskReturnTo,cancelBillingTask,type BillingTask} from './billing-task-recovery';
import {readCheckoutIntent,submitCheckoutIntent,observeCheckoutOrder,checkoutIntentKey,checkoutPending,CheckoutQuoteStale,CheckoutSubscriptionRejected,type CheckoutIntent,type CheckoutChoice} from './checkout-intent';
import './subscription-billing-page.css';

const points=formatPoints;
const hasPoints=(value:unknown)=>value!==undefined&&value!==null&&int64(value)>0n;
const channels={wechat:'微信支付',alipay:'支付宝'};
type Provider=keyof typeof channels;
type BillingCycle='monthly'|'annual';
const cycleLabel=(cycle?:BillingCycle)=>cycle==='annual'?'年付':'月付';
const planLabel=(id:string)=>({light:'轻量',professional:'专业',intensive:'密集'}[id]??id);
const validDate=(value:string|null)=>value?Date.parse(value):NaN;

/** A 404 is an older deployment; an unavailable billing service must remain an error. */
export async function readSubscriptionCatalog(api:ApiClient,signal?:AbortSignal):Promise<SubscriptionCatalog|undefined>{
  try{return await api.subscriptionCatalog(signal);}catch(error){if(error instanceof ApiError&&error.status===404)return undefined;throw error;}
}

/** Convert entered CNY into integer fen without a floating-point multiplication. */
export function topupFen(input:string):string|null{
  try{const value=parseYuanToFen(input.trim());return int64(value)>=1n&&int64(value)<=1000000n?value:null;}catch{return null;}
}

/** Monthly entitlement and permanent topups share the existing server wallet. */
export class SubscriptionBillingPage{
  private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;private successTimer?:ReturnType<typeof setTimeout>;
  private account?:SubscriptionAccount;private commerce?:CommerceCatalog;private order?:Dto<'RechargeOrderResponse'>;
  private orderDetail?:SubscriptionOrderPeriodDetail;
  private busy=false;private loading=false;private error='';private message='';private topupAmount='';
  private subscriptionProvider?:Provider;private topupProvider?:Provider;
  private billingCycle:BillingCycle='monthly';
  private managing=new URLSearchParams(location.hash.split('?')[1]).get('view')==='subscription';
  private confirmingCancellation=false;
  private changeQuote?:SubscriptionChangeQuote;private changeQuoteStale=false;
  private checkoutIntent?:CheckoutIntent;private checkoutBlocked=false;
  private authenticatedFinalCheckout?:{request_id:string;order_id:string};private displayedFinalCheckout?:string;private paymentResumeAllowed=true;
  private observedPendingOrder?:string;
  private cancelRequest?:{id:string;request_id:string};private renewRequest?:{id:string;request_id:string;enabled:boolean};
  private authorizationUrl?:string;private qr?:{url:string;data:string};private qrPending?:string;
  private history:CreditHistory;private refunds:CommerceRefunds;private quotations:CommerceQuotations;
  private quotationsOpen=new URLSearchParams(location.hash.split('?')[1]).has('quotation');
  private checkoutFlow=new URLSearchParams(location.hash.split('?')[1]).get('checkout')==='1';
  private resumeRequest=new URLSearchParams(location.hash.split('?')[1]).get('resume_request');
  private pendingTask?:BillingTask;private returnStarted=false;
  private composing=false;
  private returnTo=workReturnTo(new URLSearchParams(location.hash.split('?')[1]).get('return_to'));
  private onCredits=()=>{if(!document.hidden)void this.refreshAccount();};
  private onCompositionStart=(event:CompositionEvent)=>{if(event.target instanceof Element&&event.target.closest('.subscription-account'))this.composing=true;};
  private onCompositionEnd=()=>{this.composing=false;};
  private onCheckoutStorage=(event:StorageEvent)=>{if(this.owner&&event.key===checkoutIntentKey(this.owner)){this.readIntent();if(this.live())this.draw(true);}};
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private active:()=>boolean,
    private catalog:SubscriptionCatalog,private projectId?:string,private orderId?:string,private owner?:string){
    this.history=new CreditHistory(api,active,()=>true,()=>true,owner);
    this.refunds=new CommerceRefunds(api,active,owner,()=>!!this.paymentPeriod());
    this.quotations=new CommerceQuotations(api,active,true);
    this.subscriptionProvider=catalog.providers[0];this.topupProvider=catalog.providers[0];
    window.addEventListener('bondbuddy:credits-changed',this.onCredits);window.addEventListener('focus',this.onCredits);window.addEventListener('online',this.onCredits);
    window.addEventListener('storage',this.onCheckoutStorage);
    document.addEventListener('visibilitychange',this.onCredits);
    document.addEventListener('compositionstart',this.onCompositionStart);document.addEventListener('compositionend',this.onCompositionEnd);
  }
  dispose(){this.controller.abort();clearTimeout(this.timer);clearTimeout(this.successTimer);this.history.dispose();this.refunds.dispose();this.quotations.dispose();
    window.removeEventListener('bondbuddy:credits-changed',this.onCredits);window.removeEventListener('focus',this.onCredits);window.removeEventListener('online',this.onCredits);document.removeEventListener('visibilitychange',this.onCredits);window.removeEventListener('storage',this.onCheckoutStorage);document.removeEventListener('compositionstart',this.onCompositionStart);document.removeEventListener('compositionend',this.onCompositionEnd);}
  private live(){return this.active()&&!this.controller.signal.aborted;}
  async render(){
    this.shell('<p role="status">正在读取订阅与积分…</p>','billing');
    try{
      const [account,commerce]=await Promise.all([this.api.subscriptionAccount(this.controller.signal),this.api.commerceCatalog(this.controller.signal)]);
      if(!this.live())return;this.account=account;this.commerce=commerce;
      this.readIntent();
      this.billingCycle=checkoutPending(this.checkoutIntent)&&this.checkoutIntent?.choice.kind!=='topup'?this.checkoutIntent?.choice.billing_cycle??'monthly':account.subscription?.billing_cycle??'monthly';
      if(this.owner&&this.resumeRequest){this.pendingTask=await readBillingTask(this.owner,this.resumeRequest);if(this.pendingTask&&!['needs_funds','resuming','unknown'].includes(this.pendingTask.state))this.pendingTask=undefined;}
      const required=this.pendingTask?.requiredPoints??this.pendingTask?.body.expected_points;
      if(required!==undefined){const shortage=int64(required)-int64(account.available_points);if(shortage>0n&&shortage<=1000000n)this.topupAmount=formatFen(shortage,'');}
      if(!this.orderId&&checkoutPending(this.checkoutIntent)&&this.checkoutIntent?.order){location.hash=this.originalOrderLink(this.checkoutIntent);return;}
      const orderId=this.orderId??this.checkoutIntent?.order?.order_id;
      if(!this.orderId&&orderId)this.paymentResumeAllowed=false;
      if(orderId){const [order,detail]=await Promise.all([this.api.commerceOrder(orderId,this.controller.signal),this.readOrderDetail(orderId)]);if(order.order_id!==orderId)throw new Error('Unexpected payment order');this.order=order;this.setOrderDetail(detail);await this.observeOrder();}
      if(await this.returnToPaidTask())return;
      this.finishPaidCheckout();
    }catch(error){if(this.live())this.error=friendlyError(error,'read');}
    if(this.live()){this.draw();this.schedule();}
  }
  private back(){return this.returnTo??(this.projectId?'#/projects/'+encodeURIComponent(this.projectId):'#tasks');}
  private currentPeriodOpen(subscription:Subscription|null|undefined){return !!subscription&&validDate(subscription.current_period_end)>Date.now();}
  private paymentPeriod(){return this.orderDetail?.order_id===this.order?.order_id?this.orderDetail?.period:undefined;}
  private setOrderDetail(detail:SubscriptionOrderPeriodDetail|undefined){
    this.orderDetail=detail;
    if(!detail){this.refunds.dispose();this.refunds=new CommerceRefunds(this.api,this.active,this.owner,()=>!!this.paymentPeriod());}
  }
  private async readOrderDetail(orderId:string):Promise<SubscriptionOrderPeriodDetail|undefined>{
    try{
      const detail=await this.api.request<SubscriptionOrderPeriodDetail>('GET','/subscriptions/orders/'+encodeURIComponent(orderId)+'/period',undefined,{},this.controller.signal);
      if(!Value.Check(subscriptionOrderDetailSchemas.SubscriptionOrderPeriodResponse,detail)||detail.order_id!==orderId||detail.period&&detail.period.order_id!==orderId)throw new Error('Unexpected original order period');
      return detail;
    }catch{return undefined; /* Older deployments and failed reads both leave type/expiry unknown. */}
  }
  private canBuy(){return !!this.owner&&!!this.account&&!this.checkoutBlocked&&this.catalog.enabled&&this.catalog.providers.length>0&&!this.busy&&this.order?.state!=='pending';}
  private readIntent(){
    if(!this.owner){this.checkoutBlocked=true;return;}
    try{this.checkoutIntent=readCheckoutIntent(this.owner);this.checkoutBlocked=false;}
    catch(error){this.checkoutBlocked=true;this.error=friendlyError(error,'read');}
  }
  private async observeOrder(){
    if(this.owner&&this.order){
      if(this.order.state==='pending'||checkoutPending(this.checkoutIntent)&&this.checkoutIntent?.order?.order_id===this.order.order_id)this.observedPendingOrder=this.order.order_id;
      this.checkoutIntent=await observeCheckoutOrder(this.owner,this.order);
      const intent=this.checkoutIntent;
      this.authenticatedFinalCheckout=intent&&!checkoutPending(intent)&&intent.order?.order_id===this.order.order_id?{request_id:intent.request_id,order_id:this.order.order_id}:undefined;
    }
  }
  private finishPaidCheckout(){
    if(this.order?.state!=='paid'||this.orderId&&!this.checkoutFlow)return;
    // Keep the authenticated terminal intent: stale tabs must still replay the
    // original order until they have observed it, rather than create a new charge.
    if(this.authenticatedFinalCheckout?.order_id===this.order.order_id)
      this.displayedFinalCheckout=this.authenticatedFinalCheckout.request_id;
    if(this.observedPendingOrder===this.order.order_id||this.checkoutFlow&&this.authenticatedFinalCheckout?.order_id===this.order.order_id){
      const notice=this.paymentPeriod()?.billing_cycle==='annual'?'付款成功，本月积分已到账，剩余额度按月发放。':'付款成功，积分已到账。';
      this.message=notice;clearTimeout(this.successTimer);
      this.successTimer=setTimeout(()=>{if(this.live()&&this.message===notice){this.message='';this.draw(true);}},5000);
    }
    this.observedPendingOrder=undefined;
    this.order=undefined;this.orderId=undefined;this.orderDetail=undefined;this.checkoutFlow=false;this.qr=undefined;
    const query=new URLSearchParams(location.hash.split('?')[1]);query.delete('order');query.delete('checkout');query.delete('refund');
    history.replaceState(history.state,'','#/account'+(query.size?'?'+query:''));
  }
  private originalCheckout(){
    const intent=this.checkoutIntent;
    if(intent?.rejection&&this.displayedFinalCheckout!==intent.request_id)return `<section class="notice subscription-original-checkout"><p>${intent.rejection==='subscription_checkout_rejected'?'原付款请求已结束且未创建订单，请核对后重新选择。':'原付款摘要已失效，请核对原请求后重新选择套餐。'}</p><button class="btn secondary" type="button" id="subscription-continue-payment">核对原付款请求</button></section>`;
    if(!checkoutPending(intent)||!intent)return '';
    const label=intent.choice.kind!=='topup'?planLabel(intent.choice.plan_id)+cycleLabel(intent.choice.billing_cycle)+(intent.choice.kind==='subscription_change'?'套餐切换':'订阅'):cny(intent.choice.amount_fen)+'充值';
    return `<section class="notice subscription-original-checkout"><p>原${esc(label)}付款仍待核对，继续时沿用同一订单，不会另建付款。</p><button class="btn secondary" type="button" id="subscription-continue-payment" ${this.busy||this.checkoutBlocked||!this.catalog.providers.includes(intent.choice.provider)?'disabled':''}>继续原付款</button></section>`;
  }
  private schedule(){clearTimeout(this.timer);if(this.live())this.timer=setTimeout(()=>void this.refreshAccount(),15_000);}
  private async refreshAccount(){
    if(!this.live()||this.loading||this.busy){this.schedule();return;}this.loading=true;
    const orderId=this.order?.order_id;
    try{
      const [account,commerce,order,detail]=await Promise.all([this.api.subscriptionAccount(this.controller.signal),this.api.commerceCatalog(this.controller.signal),orderId?this.api.commerceOrder(orderId,this.controller.signal):Promise.resolve(undefined),orderId?this.readOrderDetail(orderId):Promise.resolve(undefined)]);
      if(this.live()){
        this.account=account;this.commerce=commerce;
        if(order&&orderId===this.order?.order_id){if(order.order_id!==orderId)throw new Error('Unexpected payment order');this.order=order;this.setOrderDetail(detail);await this.observeOrder();}
        else this.readIntent();
        if(!await this.returnToPaidTask()&&this.live()){this.finishPaidCheckout();this.draw(true);}
      }
    }
    catch(error){if(this.live()){this.error=friendlyError(error,'read');this.draw(true);}}
    finally{this.loading=false;this.schedule();}
  }
  private providerSelect(id:string,selected:Provider|undefined){return `<label class="account-payment-method">支付方式<select id="${id}">${this.catalog.providers.map(provider=>`<option value="${provider}" ${provider===selected?'selected':''}>${channels[provider]}</option>`).join('')}</select></label>`;}
  private subscriptionSummary(){
    const subscription=this.account?.subscription;if(!subscription)return '<p class="subscription-plan-note">不订阅也能充值使用全部已开放功能。</p>';
    const open=this.currentPeriodOpen(subscription),plan=this.catalog.plans.find(p=>p.id===subscription.plan_id);
    return `<section class="subscription-current" aria-label="当前订阅"><div class="subscription-current-copy"><span class="subscription-status">${open?'当前套餐 · 本期有效':subscription.status==='pending'?'当前套餐 · 等待付款':'当前套餐 · 本期已结束'}</span><h3>${esc(planLabel(subscription.plan_id))} · ${cycleLabel(subscription.billing_cycle)}订阅</h3><p>${plan?`每月 ${points(plan.points)} 积分。`:''}${subscription.current_period_end?`本期至 ${esc(date(subscription.current_period_end))}。`:''}</p>${this.annualEntitlement()}</div><div class="subscription-current-actions"><button class="btn primary" type="button" id="subscription-upgrade">${open?'升级套餐':'选择套餐'}</button><button class="btn secondary" type="button" id="subscription-manage">管理订阅</button></div></section>`;
  }
  private annualEntitlement(){
    const subscription=this.account?.subscription;
    const period=this.account?.periods.find(p=>p.billing_cycle==='annual'&&p.status==='active'&&p.starts_at===subscription?.current_period_start&&p.ends_at===subscription?.current_period_end);
    if(!period)return '';
    const remaining=period.release_count!==undefined&&period.released_count!==undefined?Math.max(0,period.release_count-period.released_count):undefined;
    return `<p class="subscription-annual-releases">已发放 ${period.released_count??0}/${period.release_count??12} 个月额度${remaining!==undefined?`，剩余 ${remaining} 个月`:''}；每月 ${points(period.monthly_points??'0')} 积分。${period.next_release_at?'下次到账 '+esc(date(period.next_release_at))+'。':''}每批到账后有效90天。</p>`;
  }
  private subscriptionManagement(){
    const subscription=this.account?.subscription;if(!subscription)return this.subscriptionSummary();
    const open=this.currentPeriodOpen(subscription),cancelling=subscription.mandate_status==='cancel_pending',authorizing=subscription.mandate_status==='pending';
    const renewalText=cancelling?'原支付渠道的解约结果仍在核对；完成前不能重新授权续费。':authorizing?'请在支付渠道完成授权；尚未开启自动续费。':subscription.auto_renew?
      subscription.next_charge_at&&subscription.next_charge_amount_fen!=null?`已开通自动续费，下次于 ${date(subscription.next_charge_at)} 扣款 ${cny(subscription.next_charge_amount_fen)}（${cycleLabel(subscription.billing_cycle)}）。`:'已开通自动续费，下次扣款时间和金额正在核实。':
      this.catalog.auto_renew_available?'自动续费未开通。开启后需在支付渠道授权，可随时停止下期续费。':'当前渠道支持单次开通，自动续费暂未开放。';
    return `<section class="subscription-management" aria-labelledby="subscription-management-title"><button class="text-button subscription-back" type="button" id="subscription-management-back">← 返回账户概览</button><div class="section-head"><div><h2 id="subscription-management-title">管理订阅</h2><p>查看本期权益、续费安排和订阅记录。</p></div></div><div class="subscription-management-plan"><div><span class="subscription-status">${open?'本期有效':subscription.status==='pending'?'等待付款':'本期已结束'}</span><h3>${esc(planLabel(subscription.plan_id))} · ${cycleLabel(subscription.billing_cycle)}订阅</h3><p>${subscription.current_period_end?`本期至 ${esc(date(subscription.current_period_end))}。`:''}已到账积分按各批次有效期保留。</p>${this.annualEntitlement()}</div><button class="btn secondary" type="button" id="subscription-upgrade">升级套餐</button></div><div class="subscription-management-renewal"><div><h3>自动续费</h3><p data-renewal-schedule>${esc(renewalText)}</p></div><button type="button" class="subscription-renewal-switch" role="switch" aria-label="自动续费" aria-checked="${subscription.auto_renew}" id="subscription-renewal-switch" ${this.busy||cancelling||authorizing||subscription.status==='pending'||!this.catalog.auto_renew_available&&!subscription.auto_renew?'disabled':''}><span aria-hidden="true"></span>${subscription.auto_renew?'已开启':'未开启'}</button></div>${this.authorizationUrl&&authorizing?`<p class="subscription-authorization"><a class="btn primary" href="${esc(this.authorizationUrl)}" target="_blank" rel="noopener noreferrer">前往支付渠道授权</a><span>授权结果以支付渠道核实为准。</span></p>`:''}${cancelling?`<p class="subscription-management-pending" role="status">正在停止续费。已到账积分及已付年期的剩余额度不受影响。</p><button class="btn secondary" type="button" id="subscription-mandate-refresh" ${this.busy?'disabled':''}>刷新原解约状态</button>`:''}${authorizing?`<button class="text-button" type="button" id="subscription-mandate-refresh" ${this.busy?'disabled':''}>刷新续费授权状态</button>`:''}${subscription.auto_renew||authorizing?`<div class="subscription-management-cancel"><div><h3>停止未来续费</h3><p>保留本期已付权益，停止下期自动扣款。${subscription.billing_cycle==='annual'?'本年剩余额度继续按月到账。':''}</p></div><button class="btn secondary" type="button" id="subscription-cancel" ${this.busy||cancelling?'disabled':''}>${authorizing?'取消续费授权':'停止自动续费'}</button></div>`:!cancelling?'<p class="subscription-management-note">未开启自动续费，到期不会自动扣款；仍可使用有效积分或按需充值。</p>':''}</section>`;
  }
  private cancellationDialog(){
    const subscription=this.account?.subscription;if(!this.confirmingCancellation||!subscription)return '';
    return `<dialog id="subscription-cancel-dialog" class="subscription-confirm-dialog" aria-labelledby="subscription-cancel-title"><h2 id="subscription-cancel-title">确认停止自动续费</h2><p>停止后不再自动扣取下一期费用。</p><ul><li>${subscription.current_period_end?`本期 ${esc(planLabel(subscription.plan_id))}订阅保留至 ${esc(date(subscription.current_period_end))}。`:'已支付的本期权益继续保留。'}</li><li>已经到账的有效积分继续使用，不会立即清零。</li>${subscription.billing_cycle==='annual'?'<li>已付年期的剩余额度仍按月到账，每批有效90天。</li>':''}</ul><p class="subscription-plan-note">这是停止未来续费，不会自动申请本期退款。</p><div class="subscription-confirm-actions"><button type="button" class="btn secondary" id="subscription-cancel-back">返回管理</button><button type="button" class="btn primary" id="subscription-cancel-confirm" ${this.busy?'disabled':''}>确认停止续费</button></div></dialog>`;
  }
  private setManagement(managing:boolean,plans=false){
    this.managing=managing;this.confirmingCancellation=false;
    const query=new URLSearchParams(location.hash.split('?')[1]);if(managing)query.set('view','subscription');else query.delete('view');
    history.replaceState(history.state,'','#/account'+(query.size?'?'+query:''));this.draw();
    (managing?document.getElementById('subscription-management-title'):plans?document.getElementById('subscription-plans-title'):document.querySelector('.subscription-current'))?.scrollIntoView({block:'start'});
  }
  private plans(){
    const subscription=this.account?.subscription,open=this.currentPeriodOpen(subscription),annual=this.billingCycle==='annual';
    const purpose={light:'适合偶尔推进项目',professional:'适合日常承做工作',intensive:'适合多个项目并行'};
    const cards=this.catalog.plans.map(plan=>{
      const amount=annual?plan.annual_amount_fen:plan.amount_fen;
      const current=subscription?.plan_id===plan.id&&open&&(subscription.billing_cycle??'monthly')===this.billingCycle,change=this.canChangePlan(plan.id);
      const equivalent=annual&&amount!==undefined?`折合 ${cny((int64(amount)+6n)/12n)} / 月 · 省10%`:'按月付费，灵活安排用量';
      return `<article class="credit-pack subscription-plan ${plan.id==='professional'?'recommended':''}" data-subscription-plan="${esc(plan.id)}">
        <div class="credit-pack-heading"><h3>${esc(plan.label)}</h3>${current?'<span class="credit-pack-badge">当前订阅</span>':''}</div>
        <p class="subscription-plan-purpose">${purpose[plan.id]}</p><p class="plan-price">${amount===undefined?'暂未开放':cny(amount)}<small> / ${annual?'年':'月'}</small></p>
        <p class="subscription-price-context">${equivalent}</p><p class="subscription-plan-points"><strong>${points(plan.points)}</strong> 积分 / 月</p>
        <p class="subscription-plan-note">${annual?'一次支付全年费用，分12个月到账<br>':'每月到账所列积分<br>'}每批有效${plan.credit_valid_days}天，超出后按需充值</p>
        <button class="btn ${plan.id==='professional'?'primary':'secondary'}" type="button" data-subscribe="${esc(plan.id)}" ${!this.canBuy()||open&&!change||amount===undefined?'disabled':''}>${open?current?'当前订阅':change?annual?'转为年付':'升级为'+plan.label:'到期后可选':subscription&&subscription.status!=='pending'?'续订'+plan.label:'开通'+plan.label}</button></article>`;
    }).join('');
    return `<section class="subscription-plans" aria-labelledby="subscription-plans-title"><div class="section-head"><div><h2 id="subscription-plans-title">订阅</h2><p>选择适合工作节奏的用量，所有档位开放相同业务能力。</p></div></div>
      <div class="subscription-purchase-options"><div class="subscription-cycle" role="radiogroup" aria-label="订阅付款周期"><button type="button" role="radio" aria-checked="${!annual}" data-billing-cycle="monthly">月付</button><button type="button" role="radio" aria-checked="${annual}" data-billing-cycle="annual">年付 · 9折</button></div>
      ${this.catalog.providers.length?this.providerSelect('subscription-provider',this.subscriptionProvider):'<p class="account-recharge-status" role="status">支付渠道暂未开放，暂不能开通订阅或充值。</p>'}</div>
      <div class="subscription-plan-grid">${cards}</div><p class="subscription-plan-note">${open?(subscription?.billing_cycle==='annual'?'本年已付权益继续按月发放，年期内暂不支持改档；本期额度不足可按需充值。':'当前月付可即时升档或转同档、更高档年付，未用订阅积分按原实付对价抵扣。'):annual?'年费为月价×12×9折，包含每月所列积分。':'月费包含上方积分，不额外收取任务会员费。'} ${this.catalog.auto_renew_available?'本次付款不会自动开启续费；需另行授权。':`本次开通只收取一个${annual?'年度':'月'}费用，不会自动扣取下一期费用。`}</p></section>`;
  }
  private canChangePlan(planId:SubscriptionCheckoutRequest['plan_id']){
    const subscription=this.account?.subscription;if(!this.currentPeriodOpen(subscription)||subscription?.billing_cycle==='annual')return false;
    const current=this.catalog.plans.findIndex(plan=>plan.id===subscription?.plan_id),target=this.catalog.plans.findIndex(plan=>plan.id===planId);
    return current>=0&&target>=current&&(this.billingCycle==='annual'||target>current);
  }
  private changeDialog(){
    const quote=this.changeQuote;if(!quote)return '';
    return `<dialog id="subscription-change-dialog" class="subscription-confirm-dialog" aria-labelledby="subscription-change-title"><h2 id="subscription-change-title">${quote.billing_cycle==='annual'?'转为年付':'升级套餐'}</h2><p>${esc(planLabel(quote.target_plan_id))} · ${cycleLabel(quote.billing_cycle)}订阅</p><dl class="subscription-change-breakdown"><div><dt>新套餐总价</dt><dd>${cny(quote.face_amount_fen)}</dd></div><div><dt>原订阅抵扣（${points(quote.transfer_points)}积分）</dt><dd>−${cny(quote.credit_offset_fen)}</dd></div><div class="subscription-change-total"><dt>本次实付</dt><dd data-change-pay-now>${cny(quote.pay_now_fen)}</dd></div></dl><p>付款成功即开始新的${quote.billing_cycle==='annual'?'12个月':'1个月'}周期，每月 ${points(quote.monthly_points)} 积分，每批有效90天。</p><p class="subscription-plan-note">未用积分按原实付对价抵扣，已用与预留中的积分不抵扣。${hasPoints(quote.excluded_held_points)?`本期 ${points(quote.excluded_held_points)} 积分正在预留或冻结，继续按原规则处理。`:''}原续费会停止，新套餐续费需重新授权。</p>${this.changeQuoteStale?'<p class="account-billing-error" role="alert">可抵扣积分已变化或摘要已过期，请刷新付款摘要后查看本次实付。</p>':''}<div class="subscription-confirm-actions"><button type="button" class="btn secondary" id="subscription-change-back" ${this.busy?'disabled':''}>返回套餐</button>${this.changeQuoteStale?`<button type="button" class="btn primary" id="subscription-change-refresh" ${this.busy?'disabled':''}>刷新付款摘要</button>`:`<button type="button" class="btn primary" id="subscription-change-pay" ${this.busy||!this.canBuy()?'disabled':''}>支付 ${cny(quote.pay_now_fen)} 并切换</button>`}</div></dialog>`;
  }
  private payment(){
    const order=this.order!;const period=this.paymentPeriod();
    const title=period?.status==='refunded'?'本期已退款':{pending:'等待支付确认',paid:'积分已到账',expired:'订单已过期',failed:'支付未完成'}[order.state];
    const link=order.checkout_url;
    const canClose=order.state==='pending'&&checkoutPending(this.checkoutIntent)&&this.checkoutIntent?.order?.order_id===order.order_id;
    const entitlement=period?.billing_cycle==='annual'?`全年 ${points(order.points)} 积分，按月到账 ${points(period.monthly_points??'0')} 积分，每批有效90天`:
      `${points(order.points)} 积分${period?period.credits_expires_at?' · '+date(period.credits_expires_at)+' 到期':' · 到账后有效90天':period===null?' · 永久有效':' · 有效期待核实'}`;
    return `<section class="panel payment-card simple-payment subscription-payment"><h2>${title}</h2><p data-payment-kind>${period?esc(planLabel(period.plan_id))+cycleLabel(period.billing_cycle)+'订阅':period===null?'按需充值':'订单类型待核实'}</p>${period?.funding_kind==='mixed'?'<p>本次实付</p>':''}<div class="payment-amount">${cny(order.amount_fen)}</div>${this.paymentBreakdown(period)}${period?.funding_kind==='mixed'?'<p class="subscription-plan-note">符合未使用整期退款条件时，可退还本次实付并按规则恢复原积分；不会重启原订阅周期或自动续费。</p>':''}<p data-payment-validity>${esc(entitlement)}</p>${period===undefined?'<p role="status" data-order-period-unavailable>暂无法核实本订单的原始类型、积分有效期与退款规则。请刷新本订单状态；核实前暂不开放退款申请。</p>':''}${order.state==='pending'&&link?.startsWith('https://')?`<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">前往${channels[order.provider]}</a>`:order.state==='pending'&&link?.startsWith('weixin://')?`<div class="commerce-native-payment">${this.qr?.url===link?`<img src="${this.qr.data}" width="240" height="240" alt="本订单微信支付二维码"/>`:'<p role="status">正在生成本订单支付二维码…</p>'}<p>请使用微信扫码支付。支付结果未确认时，刷新本订单即可。</p></div>`:order.state==='pending'?'<p role="status">尚未取得可用支付链接，请刷新本订单状态。</p>':''}${canClose?`<button class="btn secondary" type="button" id="close-subscription-payment" ${this.busy?'disabled':''}>取消本次付款并重新选择</button><p class="muted">确认原单已关闭后才能重新选择；若已付款，将核对到账结果。</p>`:''}<button class="btn secondary" type="button" id="refresh-subscription-payment" ${this.busy?'disabled':''}>刷新支付状态</button><a class="text-button" href="${esc(this.back())}">返回刚才的工作</a><p class="muted">订单号：${esc(order.order_id)}</p>${order.state==='paid'&&period!==undefined?'<div id="subscription-payment-refunds"></div>':''}</section>`;
  }
  private paymentBreakdown(period:{funding_kind?:'cash'|'mixed';face_amount_fen?:string;amount_fen:string}|null|undefined){
    if(period?.funding_kind!=='mixed'||period.face_amount_fen===undefined)return '';
    const offset=int64(period.face_amount_fen)-int64(period.amount_fen);if(offset<0n)return '<p>原额度抵扣金额待核实。</p>';
    return `<p class="subscription-plan-note" data-change-funding>方案原价 ${cny(period.face_amount_fen)} · 原额度抵扣 ${cny(offset)} · 本次实付 ${cny(period.amount_fen)}</p>`;
  }
  private periodStatus(period:SubscriptionAccount['periods'][number]){
    const status=period.status==='refunded'?'本期已退款':period.status==='superseded'?'已转换至新套餐':period.status==='failed'?'付款未完成':period.billing_cycle==='annual'&&period.next_release_at?'按月发放中':period.credits_expires_at&&validDate(period.credits_expires_at)<=Date.now()?'本批额度已到期':'按有效期保留';
    return `<p>${status}</p>${hasPoints(period.task_held_points)?`<p>任务预留 ${points(period.task_held_points)} 积分，继续按原任务结算</p>`:''}${hasPoints(period.refund_held_points)?`<p>退款冻结 ${points(period.refund_held_points)} 积分</p>`:''}${hasPoints(period.change_held_points)?`<p>套餐切换预留 ${points(period.change_held_points??'0')} 积分</p>`:''}`;
  }
  private topupPreview(){const amount=topupFen(this.topupAmount);return amount!==null?`将到账 ${points(amount)} 积分`:
    this.topupAmount.trim()?'请输入0.01至10,000元之间、最多两位小数的金额。':'输入金额后显示将到账的积分。';}
  private updateTopupPreview(){
    const input=document.querySelector<HTMLInputElement>('#subscription-topup-amount'),preview=document.querySelector<HTMLElement>('#subscription-topup-preview');
    const invalid=!!this.topupAmount.trim()&&topupFen(this.topupAmount)===null;
    if(input){input.setAttribute('aria-invalid',String(invalid));input.setCustomValidity(invalid?'请输入0.01至10,000元之间、最多两位小数的金额。':'');}
    if(preview){preview.textContent=this.topupPreview();preview.classList.toggle('invalid',invalid);}
  }
  private topup(){return `<section class="credit-recharge subscription-topup" aria-labelledby="subscription-topup-title"><div class="section-head"><div><h2 id="subscription-topup-title">按需充值</h2><p>灵活补足用量，无须开通订阅。</p></div></div>${this.catalog.providers.length?`<form id="subscription-topup-form">${this.providerSelect('subscription-topup-provider',this.topupProvider)}<div class="subscription-topup-entry"><label>充值金额（元）<input id="subscription-topup-amount" inputmode="decimal" type="text" value="${esc(this.topupAmount)}" placeholder="例如 12.18" autocomplete="off" required aria-describedby="subscription-topup-preview subscription-topup-help"></label><p id="subscription-topup-preview" class="subscription-topup-preview" role="status" aria-live="polite">${this.topupPreview()}</p><p class="subscription-topup-conversion">¥1＝100积分，永久有效。</p></div><button class="btn primary subscription-topup-submit" type="submit" ${!this.canBuy()?'disabled':''}>充值并前往支付</button><p id="subscription-topup-help">最低0.01元，单次最高10,000元。</p><div class="subscription-topup-shortcuts" aria-label="快捷充值金额">${[50,200,500].map(amount=>`<button class="btn secondary" type="button" data-topup-shortcut="${amount}" ${this.busy?'disabled':''}>¥${amount}</button>`).join('')}</div></form>`:'<p class="account-recharge-status">充值渠道暂未开放。</p><p class="subscription-topup-conversion">¥1＝100积分，永久有效。</p>'}</section>`;}
  private periods(){
    const rows=this.account?.periods??[];if(!rows.length)return '';
    return `<section class="subscription-periods" aria-labelledby="subscription-periods-title"><h2 id="subscription-periods-title">订阅额度明细</h2><ul>${rows.map(period=>`<li data-period="${esc(period.id)}"><div><strong>${esc(planLabel(period.plan_id))} · ${period.billing_cycle==='annual'?'年付，每月 '+points(period.monthly_points??'0'):points(period.points)} 积分</strong><p>${period.billing_cycle==='annual'?`已发放 ${period.released_count??0}/${period.release_count??12} 个月，每批到账后有效90天${period.next_release_at?' · 下次 '+esc(date(period.next_release_at))+' 到账':''}`:`${period.starts_at?esc(date(period.starts_at))+' 到账':'等待本期付款'}${period.credits_expires_at?' · '+esc(date(period.credits_expires_at))+' 到期':''}`}</p>${this.paymentBreakdown(period)}<a class="text-button" href="${esc(this.orderLink(period.order_id))}">查看支付与退款</a></div><div><strong>可用 ${points(period.available_points)} 积分</strong>${this.periodStatus(period)}</div></li>`).join('')}</ul></section>`;
  }
  private draw(background=false){
    if(!this.live())return;
    const active=document.activeElement;
    const editing=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement||active instanceof HTMLSelectElement;
    // Keep the actual control alive while editing, including an open native
    // select or an IME composition. Polling still reads the latest account; the
    // next idle refresh or explicit action renders it without interrupting input.
    if(background&&(this.composing||editing&&active.closest('.subscription-account')||document.querySelector('dialog[open]')))return;
    const selector=editing?(active.id?'#'+CSS.escape(active.id):['data-refund-amount','data-task-refund-reason','data-task-refund-item'].find(name=>active.hasAttribute(name))):undefined;
    const focused=editing&&selector?{selector:selector.startsWith('#')?selector:`[${selector}="${CSS.escape(active.getAttribute(selector)!)}"]`,element:active,start:active instanceof HTMLSelectElement?null:active.selectionStart,end:active instanceof HTMLSelectElement?null:active.selectionEnd}:undefined;
    const faqOpen=document.querySelector<HTMLDetailsElement>('.subscription-account .billing-faq')?.open;
    const account=this.account;
    if(this.authenticatedFinalCheckout&&this.authenticatedFinalCheckout.order_id===this.order?.order_id&&this.authenticatedFinalCheckout.request_id===this.checkoutIntent?.request_id&&!checkoutPending(this.checkoutIntent))
      this.displayedFinalCheckout=this.authenticatedFinalCheckout!.request_id;
    const heading=document.querySelector('.account-page-heading p');if(heading)heading.textContent='账户信息、订阅与积分';
    this.shell(`<section class="credit-overview" aria-labelledby="account-balance-title"><h2 id="account-balance-title">可用积分</h2><p class="account-balance-value">${account?points(account.available_points):'—'}<span>积分</span></p><p class="account-balance-note account-balance-total">积分余额 ${account?points(int64(account.available_points)+int64(account.held_points)):'—'} 积分（含预留）</p><p class="account-balance-note">发起任务后自动预留，成功交付后自动扣费</p>${account&&hasPoints(account.task_held_points)?`<p class="credit-reservation" data-task-held>进行中任务预留 <strong>${points(account.task_held_points)}</strong> 积分</p>`:''}${account&&hasPoints(account.refund_held_points)?`<p class="credit-reservation" data-refund-held>原路退款冻结 <strong>${points(account.refund_held_points)}</strong> 积分，渠道结果仍在核对</p>`:''}${account&&hasPoints(account.change_held_points)?`<p class="credit-reservation" data-change-held>套餐切换预留 <strong>${points(account.change_held_points??'0')}</strong> 积分，待原订单核实</p>`:''}${account?`<dl class="subscription-balance-sources"><div><dt>订阅额度</dt><dd>${points(account.subscription_available_points)} 积分</dd></div><div><dt>充值额度</dt><dd>${points(account.topup_available_points)} 积分</dd></div>${hasPoints(account.other_available_points)?`<div><dt>其他有效额度</dt><dd>${points(account.other_available_points)} 积分</dd></div>`:''}</dl>`:''}</section><div class="account-billing-content subscription-account">${this.error?`<p class="account-billing-error" role="alert">${esc(this.error)}</p>`:''}${this.message?`<p class="subscription-message" role="status">${esc(this.message)}</p>`:''}${this.returnTo||this.projectId?`<section class="notice"><p>${this.pendingTask?'已保存本次任务。当前页面确认到账后，将自动返回并继续同一任务；关闭页面不会在后台启动。':'已提交任务的材料与范围保留。到账后可返回原工作查看任务状态。'}</p><a class="btn secondary" href="${esc(this.back())}">返回刚才的工作</a>${this.pendingTask?'<button class="text-button" type="button" id="subscription-cancel-waiting">取消这次等待任务</button>':''}</section>`:''}${this.originalCheckout()}${this.order?this.payment():''}${this.managing?this.subscriptionManagement():this.subscriptionSummary()+this.plans()+this.topup()}${this.periods()}<details id="subscription-quotation-details" ${this.quotationsOpen?'open':' '}><summary>任务范围与历史报价</summary><div id="subscription-quotations"></div></details><div id="subscription-credit-history"></div><details class="billing-faq" ${faqOpen?'open':' '}><summary>订阅、扣费与退款规则</summary><div class="billing-faq-body"><p>提出明确业务任务即可执行，后台锁价并预留积分，合格成果交付后自动扣费；失败或有效取消释放预留，不按模型重试追加费用。</p><p>订阅积分每批有效90天，优先使用符合任务权限且即将到期的额度；充值积分永久有效。停止续费不会提前清除已经到账的有效积分；年付合同的剩余额度仍按月发放。</p><p>每期付款后7天内，该期积分完全未使用且无冻结时，可申请整期退款。已使用周期的普通停订只停止未来续费；平台责任及依法应退情形按对应规则处理。</p><p>充值退款只针对原订单可退实付；任务返分与现金退款分别记录。积分余额表示可用任务额度，不是可提现现金。</p></div></details>${this.cancellationDialog()}${this.changeDialog()}</div>`,'billing');
    this.history.mount(document.querySelector<HTMLElement>('#subscription-credit-history')!);
    const quotations=document.querySelector<HTMLElement>('#subscription-quotations');if(quotations)this.quotations.mount(quotations);
    document.querySelector<HTMLDetailsElement>('#subscription-quotation-details')?.addEventListener('toggle',event=>{this.quotationsOpen=(event.currentTarget as HTMLDetailsElement).open;});
    const refundHost=document.querySelector<HTMLElement>('#subscription-payment-refunds');if(refundHost&&this.order)this.refunds.mount(refundHost,this.order.order_id);
    document.querySelector<HTMLSelectElement>('#subscription-provider')?.addEventListener('change',event=>{this.subscriptionProvider=(event.target as HTMLSelectElement).value as Provider;});
    document.querySelectorAll<HTMLButtonElement>('[data-billing-cycle]').forEach(button=>button.addEventListener('click',()=>{this.billingCycle=button.dataset.billingCycle as BillingCycle;this.draw();}));
    document.querySelector<HTMLSelectElement>('#subscription-topup-provider')?.addEventListener('change',event=>{this.topupProvider=(event.target as HTMLSelectElement).value as Provider;});
    document.querySelector<HTMLInputElement>('#subscription-topup-amount')?.addEventListener('input',event=>{this.topupAmount=(event.target as HTMLInputElement).value;this.updateTopupPreview();});
    this.updateTopupPreview();
    document.querySelector('#subscription-topup-form')?.addEventListener('submit',event=>{event.preventDefault();void this.buyTopup();});
    document.querySelectorAll<HTMLButtonElement>('[data-subscribe]').forEach(button=>button.addEventListener('click',()=>void this.buySubscription(button.dataset.subscribe as SubscriptionCheckoutRequest['plan_id'])));
    document.querySelectorAll<HTMLButtonElement>('[data-topup-shortcut]').forEach(button=>button.addEventListener('click',()=>{this.topupAmount=button.dataset.topupShortcut!;this.draw();document.querySelector<HTMLInputElement>('#subscription-topup-amount')?.focus();}));
    document.querySelector('#refresh-subscription-payment')?.addEventListener('click',()=>void this.refreshPayment());
    document.querySelector('#close-subscription-payment')?.addEventListener('click',()=>void this.closePayment());
    document.querySelector('#subscription-continue-payment')?.addEventListener('click',()=>void this.purchase());
    document.querySelector('#subscription-manage')?.addEventListener('click',()=>this.setManagement(true));
    document.querySelector('#subscription-management-back')?.addEventListener('click',()=>this.setManagement(false));
    document.querySelector('#subscription-upgrade')?.addEventListener('click',()=>this.setManagement(false,true));
    document.querySelector('#subscription-cancel')?.addEventListener('click',()=>{this.confirmingCancellation=true;this.draw();});
    document.querySelector('#subscription-renewal-switch')?.addEventListener('click',()=>{if(this.account?.subscription?.auto_renew){this.confirmingCancellation=true;this.draw();}else void this.authorizeRenewal();});
    const cancellation=document.querySelector<HTMLDialogElement>('#subscription-cancel-dialog');
    if(cancellation){cancellation.showModal();cancellation.addEventListener('cancel',event=>{event.preventDefault();this.confirmingCancellation=false;this.draw();});}
    document.querySelector('#subscription-cancel-back')?.addEventListener('click',()=>{this.confirmingCancellation=false;this.draw();document.getElementById('subscription-cancel')?.focus();});
    document.querySelector('#subscription-cancel-confirm')?.addEventListener('click',()=>{this.confirmingCancellation=false;void this.cancel();});
    const changeDialog=document.querySelector<HTMLDialogElement>('#subscription-change-dialog');
    if(changeDialog){changeDialog.showModal();changeDialog.addEventListener('cancel',event=>{event.preventDefault();if(!this.busy){this.changeQuote=undefined;this.draw();}});}
    document.querySelector('#subscription-change-back')?.addEventListener('click',()=>{this.changeQuote=undefined;this.draw();});
    document.querySelector('#subscription-change-refresh')?.addEventListener('click',()=>{if(this.changeQuote)void this.prepareChange(this.changeQuote.target_plan_id);});
    document.querySelector('#subscription-change-pay')?.addEventListener('click',()=>{const quote=this.changeQuote,provider=this.subscriptionProvider;if(quote&&provider)void this.purchase({kind:'subscription_change',quote_id:quote.quote_id,plan_id:quote.target_plan_id,billing_cycle:quote.billing_cycle,provider});});
    document.querySelector('#subscription-cancel-waiting')?.addEventListener('click',()=>void this.cancelWaitingTask());
    document.querySelector('#subscription-mandate-refresh')?.addEventListener('click',()=>void this.refreshMandate());
    if(this.order?.state==='pending'&&this.order.checkout_url?.startsWith('weixin://'))void this.paymentQr(this.order.checkout_url);
    if(focused){
      const input=focused.element.isConnected?focused.element:document.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(focused.selector);
      input?.focus({preventScroll:true});
      if(input&&!(input instanceof HTMLSelectElement)&&focused.start!==null&&focused.end!==null)input.setSelectionRange(focused.start,focused.end);
    }
  }
  private orderLink(id:string){const query=new URLSearchParams(rechargeHref(this.projectId).split('?')[1]);query.set('order',id);if(this.resumeRequest&&this.pendingTask)query.set('resume_request',this.resumeRequest);return '#/account?'+query;}
  private originalOrderLink(intent:CheckoutIntent){
    const query=new URLSearchParams();query.set('order',intent.order!.order_id);query.set('checkout','1');
    for(const [key,value] of Object.entries(intent.context??{}))if(value)query.set(key==='project_id'?'project':key,value);
    return '#/account?'+query;
  }
  private async returnToPaidTask(){
    if(!this.live()||!this.paymentResumeAllowed||this.returnStarted||this.order?.state!=='paid'||!this.owner||!this.resumeRequest||!this.pendingTask)return false;
    const owner=this.owner,request=this.resumeRequest,orderId=this.order.order_id;
    const target=await billingTaskReturnTo(owner,request);
    if(!target||!this.live()||this.returnStarted||!this.pendingTask||this.resumeRequest!==request||this.owner!==owner||this.order?.order_id!==orderId||this.order.state!=='paid')return false;
    this.returnStarted=true;location.hash=target;return true;
  }
  private async cancelWaitingTask(){
    if(!this.owner||!this.resumeRequest||!this.pendingTask)return;
    const owner=this.owner,request=this.resumeRequest;this.pendingTask=undefined;this.resumeRequest=null;
    await cancelBillingTask(owner,request);if(this.live()){this.message='已取消这次等待补款的任务，不影响已有积分或支付订单。';this.draw();}
  }
  private async buySubscription(planId:SubscriptionCheckoutRequest['plan_id']){
    const provider=this.subscriptionProvider;if(!this.canBuy()||!provider)return;
    if(!this.catalog.plans.some(plan=>plan.id===planId)||!this.catalog.providers.includes(provider))return;
    if(this.currentPeriodOpen(this.account?.subscription)){if(this.canChangePlan(planId))await this.prepareChange(planId);return;}
    const previous=this.checkoutIntent,subscription=this.account?.subscription;
    const choice:CheckoutChoice=checkoutPending(previous)&&previous?.choice.kind==='subscription'&&previous.choice.plan_id===planId&&previous.choice.provider===provider&&(previous.choice.billing_cycle??'monthly')===this.billingCycle
      ?previous.choice:{kind:'subscription',plan_id:planId,provider,billing_cycle:this.billingCycle,...(subscription&&subscription.status!=='pending'?{subscription_id:subscription.id}:{})};
    await this.purchase(choice);
  }
  private async prepareChange(planId:SubscriptionCheckoutRequest['plan_id']){
    if(!this.canBuy()||!this.canChangePlan(planId))return;
    if(this.checkoutIntent?.rejection&&this.displayedFinalCheckout!==this.checkoutIntent.request_id){this.error='请先核对原付款摘要，再选择新套餐。';this.draw();return;}
    if(checkoutPending(this.checkoutIntent)){this.error='已有原付款待核对，请先继续原付款。';this.draw();return;}
    this.busy=true;this.error='';this.draw();
    try{
      const result=await this.api.subscriptionChangeQuote({request_id:crypto.randomUUID(),plan_id:planId,billing_cycle:this.billingCycle},this.controller.signal);
      if(!Value.Check(subscriptionSchemas.SubscriptionChangeQuoteResponse,result)||result.quote.target_plan_id!==planId||result.quote.billing_cycle!==this.billingCycle)throw new Error('Unexpected subscription change quote');
      if(this.live()){this.changeQuote=result.quote;this.changeQuoteStale=false;}
    }catch(error){if(this.live())this.error=friendlyError(error,'read');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async buyTopup(){
    const amount=topupFen(this.topupAmount),provider=this.topupProvider;if(!this.canBuy()||!provider)return;
    if(amount===null||!this.catalog.providers.includes(provider)){this.error='请输入0.01至10,000元之间、最多两位小数的充值金额。';this.draw();return;}
    await this.purchase({kind:'topup',amount_fen:amount,provider,...(this.projectId?{project_id:this.projectId}:{})});
  }
  private async purchase(choice?:CheckoutChoice){
    if(this.busy||!this.owner||this.checkoutBlocked||!this.catalog.enabled)return;
    const owner=this.owner,observedFinal=this.displayedFinalCheckout;
    this.busy=true;this.error='';this.draw();
    try{
      const saved=await submitCheckoutIntent(owner,choice,observedFinal,async intent=>{
        try{
        if(!this.live()||this.owner!==owner)throw new Error('Checkout page is no longer active');
        if(intent.order)return this.api.commerceRefresh(intent.order.order_id,this.controller.signal);
        const c=intent.choice;
        if(intent.version===1){
          const headers={[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION},legacy=intent.choice;
          if(legacy.kind==='topup')return this.api.request<Dto<'RechargeOrderResponse'>>('POST','/commerce/topups',{request_id:intent.request_id,amount_fen:legacy.amount_fen,provider:legacy.provider,...(legacy.project_id?{project_id:legacy.project_id}:{})},headers,this.controller.signal);
          const result=await this.api.request<{order:Dto<'RechargeOrderResponse'>}>('POST',legacy.subscription_id?`/subscriptions/${encodeURIComponent(legacy.subscription_id)}/renew`:'/subscriptions',{request_id:intent.request_id,plan_id:legacy.plan_id,provider:legacy.provider},headers,this.controller.signal);return result.order;
        }
        if(c.kind==='topup')return this.api.commerceTopup({request_id:intent.request_id,amount_fen:int64(c.amount_fen).toString(),provider:c.provider,...(c.project_id?{project_id:c.project_id}:{})},this.controller.signal);
        if(c.kind==='subscription_change'){
          try{return (await this.api.subscriptionChangeCheckout({request_id:intent.request_id,quote_id:c.quote_id,provider:c.provider},this.controller.signal)).order;}
          catch(error){if(error instanceof ApiError&&error.status===409&&error.code==='SUBSCRIPTION_CHANGE_QUOTE_STALE')throw new CheckoutQuoteStale();throw error;}
        }
        const request={request_id:intent.request_id,plan_id:c.plan_id,provider:c.provider,...(c.billing_cycle?{billing_cycle:c.billing_cycle}:{})};
        const result=c.subscription_id?await this.api.renewSubscription(c.subscription_id,request,this.controller.signal):await this.api.createSubscription(request,this.controller.signal);
        return result.order;
        }catch(error){
          if(intent.choice.kind==='subscription'&&!intent.order&&error instanceof ApiError&&error.status===409&&error.code==='SUBSCRIPTION_CHECKOUT_REJECTED')throw new CheckoutSubscriptionRejected();
          throw error;
        }
      },undefined,{...(this.projectId?{project_id:this.projectId}:{}),...(this.returnTo?{return_to:this.returnTo}:{}),...(this.resumeRequest&&this.pendingTask?{resume_request:this.resumeRequest}:{})});
      this.checkoutIntent=saved;if(this.live()){this.changeQuote=undefined;location.hash=this.originalOrderLink(saved);}
    }catch(error){if(this.live()){this.error=friendlyError(error,'submit');if(error instanceof CheckoutQuoteStale||error instanceof CheckoutSubscriptionRejected){this.readIntent();if(this.checkoutIntent?.rejection)this.displayedFinalCheckout=this.checkoutIntent.request_id;if(error instanceof CheckoutQuoteStale)this.changeQuoteStale=true;else{try{const account=await this.api.subscriptionAccount(this.controller.signal);if(this.live())this.account=account;}catch{/* The exact rejected key stays final even if the account refresh fails. */}}}else if(choice?.kind==='subscription_change'){this.changeQuote=undefined;}}}
    finally{this.busy=false;this.readIntent();if(this.live())this.draw();}
  }
  private async closePayment(){
    const orderId=this.order?.order_id;
    if(this.busy||this.order?.state!=='pending'||!orderId||!checkoutPending(this.checkoutIntent)||this.checkoutIntent?.order?.order_id!==orderId)return;
    this.busy=true;this.error='';this.message='';this.draw();
    let confirmed:'paid'|'expired'|'failed'|undefined;
    try{
      const order=await this.api.request<Dto<'RechargeOrderResponse'>>('POST','/credits/recharge-orders/'+encodeURIComponent(orderId)+'/close',{}, {},this.controller.signal);
      if(!Value.Check(schemas.RechargeOrderResponse,order)||order.order_id!==orderId)throw new Error('Unexpected closed payment order');
      if(this.live()){
        this.order=order;await this.observeOrder();
        if(order.state!=='pending')confirmed=order.state;
        const [account,commerce,detail]=await Promise.all([this.api.subscriptionAccount(this.controller.signal),this.api.commerceCatalog(this.controller.signal),this.readOrderDetail(orderId)]);
        if(!this.live())return;
        this.account=account;this.commerce=commerce;this.setOrderDetail(detail);
        await this.history.refresh();
        if(!this.live())return;
        if(order.state==='pending')this.message='原订单关闭结果仍在核对。请刷新同一订单，确认结束后再重新选择。';
        else if(order.state==='paid'){if(!await this.returnToPaidTask())this.finishPaidCheckout();}
        else this.message='原付款已结束，可以重新选择套餐、金额或支付方式。';
      }
    }catch(error){if(this.live())this.error=confirmed?`${confirmed==='paid'?'已确认付款成功':'原付款已结束'}，账户信息暂未刷新，请刷新本订单状态。`:'原付款关闭结果尚未确认，请刷新原订单状态；核实前请勿另行付款。 '+friendlyError(error,'read');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async refreshPayment(){
    if(this.busy||!this.order)return;this.busy=true;this.error='';this.draw();
    try{const order=await this.api.commerceRefresh(this.order.order_id,this.controller.signal);if(this.live()){this.order=order;await this.observeOrder();const [account,commerce,detail]=await Promise.all([this.api.subscriptionAccount(this.controller.signal),this.api.commerceCatalog(this.controller.signal),this.readOrderDetail(order.order_id)]);this.account=account;this.commerce=commerce;this.setOrderDetail(detail);await this.history.refresh();if(!this.live())return;window.dispatchEvent(new Event('bondbuddy:credits-changed'));if(!await this.returnToPaidTask())this.finishPaidCheckout();}}
    catch(error){if(this.live())this.error=friendlyError(error,'read');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async cancel(){
    const subscription=this.account?.subscription;if(this.busy||!subscription||!subscription.auto_renew&&subscription.mandate_status!=='pending')return;
    if(this.cancelRequest?.id!==subscription.id)this.cancelRequest={id:subscription.id,request_id:crypto.randomUUID()};
    this.busy=true;this.error='';this.draw();
    try{const saved=await this.api.cancelSubscription(subscription.id,{request_id:this.cancelRequest.request_id},this.controller.signal);if(this.live()&&this.account){this.account.subscription=saved;this.authorizationUrl=undefined;if(saved.mandate_status==='cancelled')this.renewRequest=undefined;this.message=saved.mandate_status==='cancel_pending'?'已提交停止续费，渠道结果仍在核对；已到账积分继续保留。':'已停止未来续费，已到账积分按原有效期继续使用。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async authorizeRenewal(){
    const subscription=this.account?.subscription;if(this.busy||!subscription||subscription.mandate_status==='cancel_pending'||!this.catalog.auto_renew_available)return;
    if(this.renewRequest?.id!==subscription.id)this.renewRequest={id:subscription.id,request_id:crypto.randomUUID(),enabled:true};
    this.busy=true;this.error='';this.draw();
    try{const response=await this.api.subscriptionAutoRenew(subscription.id,{request_id:this.renewRequest.request_id,enabled:true},this.controller.signal);if(this.live()&&this.account){this.account.subscription=response.subscription;if(response.subscription.mandate_status==='pending'||response.subscription.auto_renew)this.cancelRequest=undefined;this.authorizationUrl=response.authorization_url?.startsWith('https://')?response.authorization_url:undefined;this.message=response.subscription.auto_renew?'自动续费已开通。':'请在支付渠道完成授权后刷新状态。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async refreshMandate(){
    const subscription=this.account?.subscription;if(this.busy||!subscription)return;const cancelling=subscription.mandate_status==='cancel_pending';this.busy=true;this.error='';this.draw();
    try{const response=await this.api.refreshSubscriptionAutoRenew(subscription.id,this.controller.signal);if(this.live()&&this.account){this.account.subscription=response.subscription;if(response.subscription.mandate_status==='cancelled')this.renewRequest=undefined;if(response.subscription.auto_renew)this.cancelRequest=undefined;this.authorizationUrl=response.subscription.mandate_status==='pending'&&response.authorization_url?.startsWith('https://')?response.authorization_url:undefined;if(!cancelling&&response.subscription.auto_renew)this.message='自动续费已开通。';if(cancelling)this.message=response.subscription.mandate_status==='cancel_pending'?'原解约结果仍在核对，可稍后刷新；已到账积分继续保留。':response.subscription.mandate_status==='cancelled'?'支付渠道已确认停止续费，已到账积分按原有效期继续使用。':'已刷新原解约状态，请查看当前订阅信息。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'read');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async paymentQr(url:string){
    if(this.qr?.url===url||this.qrPending===url)return;this.qrPending=url;
    try{const data=await QRCode.toDataURL(url,{width:240,margin:2,errorCorrectionLevel:'M'});if(this.live()&&this.order?.checkout_url===url){this.qr={url,data};this.draw(true);}}
    catch{if(this.live()){this.error='支付二维码暂未生成，请刷新本订单重试。';this.draw(true);}}
    finally{this.qrPending=undefined;}
  }
}
