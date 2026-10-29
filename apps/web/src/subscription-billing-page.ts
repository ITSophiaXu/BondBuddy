import QRCode from 'qrcode';
import type {CommerceCatalog,SubscriptionCatalog,SubscriptionAccount,SubscriptionCheckoutRequest,Subscription} from './billing-types.js';
import {AUTOMATIC_PRICE_VERSION,isAutomaticPriceVersion,int64,formatPoints,formatFen,parseYuanToFen,BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION,subscriptionOrderDetailSchemas,type SubscriptionOrderPeriodDetail} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {CreditHistory} from './credit-history';
import {CommerceRefunds} from './commerce-refunds';
import {CommerceQuotations} from './commerce-quotations';
import {cny} from './commerce';
import {date,esc} from './ui';
import {rechargeHref,workReturnTo} from './project-navigation';
import {readBillingTask,billingTaskReturnTo,cancelBillingTask,type BillingTask} from './billing-task-recovery';
import {readCheckoutIntent,submitCheckoutIntent,observeCheckoutOrder,checkoutIntentKey,checkoutPending,type CheckoutIntent,type CheckoutChoice} from './checkout-intent';
import './subscription-billing-page.css';

const points=formatPoints;
const hasPoints=(value:unknown)=>value!==undefined&&value!==null&&int64(value)>0n;
const channels={wechat:'微信支付',alipay:'支付宝'};
type Provider=keyof typeof channels;
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
  private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;
  private account?:SubscriptionAccount;private commerce?:CommerceCatalog;private order?:Dto<'RechargeOrderResponse'>;
  private orderDetail?:SubscriptionOrderPeriodDetail;
  private busy=false;private loading=false;private error='';private message='';private topupAmount='';
  private subscriptionProvider?:Provider;private topupProvider?:Provider;
  private checkoutIntent?:CheckoutIntent;private checkoutBlocked=false;
  private authenticatedFinalCheckout?:{request_id:string;order_id:string};private displayedFinalCheckout?:string;private paymentResumeAllowed=true;
  private cancelRequest?:{id:string;request_id:string};private renewRequest?:{id:string;request_id:string;enabled:boolean};
  private authorizationUrl?:string;private qr?:{url:string;data:string};private qrPending?:string;
  private history:CreditHistory;private refunds:CommerceRefunds;private quotations:CommerceQuotations;
  private quotationsOpen=new URLSearchParams(location.hash.split('?')[1]).has('quotation');
  private taskPricesOpen=false;private openTaskScopes=new Set<string>();
  private resumeRequest=new URLSearchParams(location.hash.split('?')[1]).get('resume_request');
  private pendingTask?:BillingTask;private returnStarted=false;
  private returnTo=workReturnTo(new URLSearchParams(location.hash.split('?')[1]).get('return_to'));
  private onCredits=()=>{if(!document.hidden)void this.refreshAccount();};
  private onCheckoutStorage=(event:StorageEvent)=>{if(this.owner&&event.key===checkoutIntentKey(this.owner)){this.readIntent();if(this.live())this.draw();}};
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private active:()=>boolean,
    private catalog:SubscriptionCatalog,private projectId?:string,private orderId?:string,private owner?:string){
    this.history=new CreditHistory(api,active,()=>true,()=>true,owner);
    this.refunds=new CommerceRefunds(api,active,owner,()=>!!this.paymentPeriod());
    this.quotations=new CommerceQuotations(api,active,true);
    this.subscriptionProvider=catalog.providers[0];this.topupProvider=catalog.providers[0];
    window.addEventListener('bondbuddy:credits-changed',this.onCredits);window.addEventListener('focus',this.onCredits);
    window.addEventListener('storage',this.onCheckoutStorage);
    document.addEventListener('visibilitychange',this.onCredits);
  }
  dispose(){this.controller.abort();clearTimeout(this.timer);this.history.dispose();this.refunds.dispose();this.quotations.dispose();
    window.removeEventListener('bondbuddy:credits-changed',this.onCredits);window.removeEventListener('focus',this.onCredits);document.removeEventListener('visibilitychange',this.onCredits);window.removeEventListener('storage',this.onCheckoutStorage);}
  private live(){return this.active()&&!this.controller.signal.aborted;}
  async render(){
    this.shell('<p role="status">正在读取订阅与积分…</p>','billing');
    try{
      const [account,commerce]=await Promise.all([this.api.subscriptionAccount(this.controller.signal),this.api.commerceCatalog(this.controller.signal)]);
      if(!this.live())return;this.account=account;this.commerce=commerce;
      this.readIntent();
      if(this.owner&&this.resumeRequest){this.pendingTask=await readBillingTask(this.owner,this.resumeRequest);if(this.pendingTask&&!['needs_funds','resuming','unknown'].includes(this.pendingTask.state))this.pendingTask=undefined;}
      const required=this.pendingTask?.requiredPoints??this.pendingTask?.body.expected_points;
      if(required!==undefined){const shortage=int64(required)-int64(account.available_points);if(shortage>0n&&shortage<=1000000n)this.topupAmount=formatFen(shortage,'');}
      if(!this.orderId&&checkoutPending(this.checkoutIntent)&&this.checkoutIntent?.order){location.hash=this.originalOrderLink(this.checkoutIntent);return;}
      const orderId=this.orderId??this.checkoutIntent?.order?.order_id;
      if(!this.orderId&&orderId)this.paymentResumeAllowed=false;
      if(orderId){const [order,detail]=await Promise.all([this.api.commerceOrder(orderId,this.controller.signal),this.readOrderDetail(orderId)]);if(order.order_id!==orderId)throw new Error('Unexpected payment order');this.order=order;this.setOrderDetail(detail);await this.observeOrder();}
      if(await this.returnToPaidTask())return;
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
      this.checkoutIntent=await observeCheckoutOrder(this.owner,this.order);
      const intent=this.checkoutIntent;
      this.authenticatedFinalCheckout=intent&&!checkoutPending(intent)&&intent.order?.order_id===this.order.order_id?{request_id:intent.request_id,order_id:this.order.order_id}:undefined;
    }
  }
  private originalCheckout(){
    const intent=this.checkoutIntent;if(!checkoutPending(intent)||!intent)return '';
    const label=intent.choice.kind==='subscription'?planLabel(intent.choice.plan_id)+'月订阅':cny(intent.choice.amount_fen)+'充值';
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
        if(!await this.returnToPaidTask()&&this.live())this.draw();
      }
    }
    catch(error){if(this.live()){this.error=friendlyError(error,'read');this.draw();}}
    finally{this.loading=false;this.schedule();}
  }
  private providerSelect(id:string,selected:Provider|undefined){return `<label class="account-payment-method">支付方式<select id="${id}">${this.catalog.providers.map(provider=>`<option value="${provider}" ${provider===selected?'selected':''}>${channels[provider]}</option>`).join('')}</select></label>`;}
  private subscriptionSummary(){
    const subscription=this.account?.subscription;if(!subscription)return '<p class="subscription-plan-note">不订阅也能充值使用全部已开放功能。</p>';
    const open=this.currentPeriodOpen(subscription),cancelling=subscription.mandate_status==='cancel_pending';
    const status=subscription.mandate_status==='cancel_pending'?'正在停止续费':subscription.status==='pending'?'等待付款':subscription.status==='cancelled'?'已停止续费':open?'本期已开通':subscription.status==='past_due'?'本期续费未完成':'本期已结束';
    return `<section class="subscription-current" aria-label="当前订阅"><div><span class="subscription-status">${status}</span><h3>${esc(planLabel(subscription.plan_id))}订阅</h3><p>${subscription.current_period_end?`本期至 ${esc(date(subscription.current_period_end))}。`:''}已到账积分按各批次有效期保留。</p><p>${cancelling?'原支付渠道的解约结果仍在核对；完成前不能重新授权续费。':subscription.auto_renew?'已开通自动续费，下期按当前套餐续订。':this.catalog.auto_renew_available?'自动续费未开通，可选择授权。':'当前渠道支持单次开通，自动续费暂未开放。'}</p></div><div class="subscription-current-actions">${cancelling?`<button class="btn secondary" type="button" id="subscription-mandate-refresh" ${this.busy?'disabled':''}>刷新原解约状态</button>`:subscription.auto_renew||subscription.mandate_status==='pending'?`<button class="btn secondary" type="button" id="subscription-cancel" ${this.busy?'disabled':''}>停止下期续费</button>`:subscription.status!=='pending'&&this.catalog.auto_renew_available?`<button class="btn secondary" type="button" id="subscription-auto-renew" ${this.busy?'disabled':''}>授权自动续费</button>`:''}${subscription.mandate_status==='pending'?`<button class="text-button" type="button" id="subscription-mandate-refresh" ${this.busy?'disabled':''}>刷新续费授权状态</button>`:''}</div>${this.authorizationUrl&&subscription.mandate_status==='pending'?`<p class="subscription-authorization"><a class="btn primary" href="${esc(this.authorizationUrl)}" target="_blank" rel="noopener noreferrer">前往支付渠道授权</a><span>授权结果以支付渠道核实为准。</span></p>`:''}</section>`;
  }
  private plans(){
    const subscription=this.account?.subscription,open=this.currentPeriodOpen(subscription);
    return `<section class="subscription-plans" aria-labelledby="subscription-plans-title"><div class="section-head"><div><h2 id="subscription-plans-title">月订阅</h2><p>每期到账积分有效90天，可结转使用；所有档位开放相同业务能力。</p></div></div>${this.subscriptionSummary()}${this.catalog.providers.length?this.providerSelect('subscription-provider',this.subscriptionProvider):'<p class="account-recharge-status" role="status">支付渠道暂未开放，暂不能开通订阅或充值。</p>'}<div class="subscription-plan-grid">${this.catalog.plans.map(plan=>`<article class="credit-pack subscription-plan ${plan.id==='professional'?'recommended':''}" data-subscription-plan="${esc(plan.id)}"><div class="credit-pack-heading"><h3>${esc(plan.label)}</h3>${subscription?.plan_id===plan.id&&open?'<span class="credit-pack-badge">当前订阅</span>':''}</div><p class="plan-price">${cny(plan.amount_fen)}<small> / 月</small></p><p class="subscription-plan-points"><strong>${points(plan.points)}</strong> 积分 / 期</p><p class="subscription-plan-note">每批有效${plan.credit_valid_days}天<br>超出后按需充值</p><button class="btn ${plan.id==='professional'?'primary':'secondary'}" type="button" data-subscribe="${esc(plan.id)}" ${!this.canBuy()||open?'disabled':''}>${open?'本期已开通':subscription&&subscription.status!=='pending'?'续订'+plan.label:'开通'+plan.label}</button></article>`).join('')}</div><p class="subscription-plan-note">${open?'下个周期可更换档位；本期额度不足可直接充值。':'月费包含上方积分，不额外收取任务会员费。'} ${this.catalog.auto_renew_available?'自动续费需要单独授权。':'本次开通只收取一个月费用，不会自动扣取下一期月费。'}</p></section>`;
  }
  private payment(){
    const order=this.order!;const period=this.paymentPeriod();
    const title=period?.status==='refunded'?'本期已退款':{pending:'等待支付确认',paid:'积分已到账',expired:'订单已过期',failed:'支付未完成'}[order.state];
    const link=order.checkout_url;
    return `<section class="panel payment-card simple-payment subscription-payment"><h2>${title}</h2><p data-payment-kind>${period?esc(planLabel(period.plan_id))+'月订阅':period===null?'按需充值':'订单类型待核实'}</p><div class="payment-amount">${cny(order.amount_fen)}</div><p data-payment-validity>${points(order.points)} 积分${period?period.credits_expires_at?' · '+esc(date(period.credits_expires_at))+' 到期':' · 到账后有效90天':period===null?' · 永久有效':' · 有效期待核实'}</p>${period===undefined?'<p role="status" data-order-period-unavailable>暂无法核实本订单的原始类型、积分有效期与退款规则。请刷新本订单状态；核实前暂不开放退款申请。</p>':''}${order.state==='pending'&&link?.startsWith('https://')?`<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">前往${channels[order.provider]}</a>`:order.state==='pending'&&link?.startsWith('weixin://')?`<div class="commerce-native-payment">${this.qr?.url===link?`<img src="${this.qr.data}" width="240" height="240" alt="本订单微信支付二维码"/>`:'<p role="status">正在生成本订单支付二维码…</p>'}<p>请使用微信扫码支付。支付结果未确认时，刷新本订单即可。</p></div>`:order.state==='pending'?'<p role="status">尚未取得可用支付链接，请刷新本订单状态。</p>':''}<button class="btn secondary" type="button" id="refresh-subscription-payment" ${this.busy?'disabled':''}>刷新支付状态</button><a class="text-button" href="${esc(this.back())}">返回刚才的工作</a><p class="muted">订单号：${esc(order.order_id)}</p>${order.state==='paid'&&period!==undefined?'<div id="subscription-payment-refunds"></div>':''}</section>`;
  }
  private topup(){return `<section class="credit-recharge subscription-topup" aria-labelledby="subscription-topup-title"><div class="section-head"><div><h2 id="subscription-topup-title">按需充值</h2><p>¥1＝100积分，永久有效。可以单独充值，也可补充订阅额度。</p></div></div>${this.catalog.providers.length?`<form id="subscription-topup-form">${this.providerSelect('subscription-topup-provider',this.topupProvider)}<label>充值金额（元）<input id="subscription-topup-amount" inputmode="decimal" type="text" value="${esc(this.topupAmount)}" placeholder="例如 12.18" autocomplete="off" required aria-describedby="subscription-topup-help"></label><button class="btn primary" type="submit" ${!this.canBuy()?'disabled':''}>充值并前往支付</button><p id="subscription-topup-help">最低0.01元，单次最高10,000元；实付金额按1元100积分到账。</p><div class="subscription-topup-shortcuts" aria-label="快捷充值金额">${[50,200,500].map(amount=>`<button class="btn secondary" type="button" data-topup-shortcut="${amount}" ${this.busy?'disabled':''}>¥${amount}</button>`).join('')}</div></form>`:'<p class="account-recharge-status">充值渠道暂未开放。</p>'}</section>`;}
  private periods(){
    const rows=this.account?.periods??[];if(!rows.length)return '';
    return `<section class="subscription-periods" aria-labelledby="subscription-periods-title"><h2 id="subscription-periods-title">订阅额度明细</h2><ul>${rows.map(period=>`<li data-period="${esc(period.id)}"><div><strong>${esc(planLabel(period.plan_id))} · ${points(period.points)} 积分</strong><p>${period.starts_at?esc(date(period.starts_at))+' 到账':'等待本期付款'}${period.credits_expires_at?' · '+esc(date(period.credits_expires_at))+' 到期':''}</p><a class="text-button" href="${esc(this.orderLink(period.order_id))}">查看支付与退款</a></div><div><strong>可用 ${points(period.available_points)} 积分</strong><p>${period.status==='refunded'?'本期已退款':hasPoints(period.refund_held_points)?'退款冻结 '+points(period.refund_held_points)+' 积分':hasPoints(period.task_held_points)?'任务预留 '+points(period.task_held_points)+' 积分':period.status==='failed'?'付款未完成':period.credits_expires_at&&validDate(period.credits_expires_at)<=Date.now()?'本批额度已到期':'按有效期保留'}</p></div></li>`).join('')}</ul></section>`;
  }
  private taskPrices(){
    const protectedPrice=isAutomaticPriceVersion(this.commerce?.version)&&this.commerce?.version!==AUTOMATIC_PRICE_VERSION;
    return `<details class="subscription-price-list" ${this.taskPricesOpen?'open':''}><summary>查看任务价格与计费范围</summary><p>${protectedPrice?'下列为您本期锁定的任务积分价格；本期结束后的新任务使用届时价表。':'任务按受理时的价格锁定。'}必要检查、按任务约定的修正和平台重试包含在父任务中。</p><ul class="subscription-task-prices">${(this.commerce?.items??[]).map(item=>{const amount=item.price_points??item.price_fen;return `<li class="subscription-task-price"><div class="subscription-task-price-line" data-task-price="${esc(item.code)}"><span>${esc(item.label)} / ${esc(item.unit)}</span><strong>${amount===null?'暂未开放':points(amount)+' 积分'}</strong></div><details class="subscription-task-scope ${item.code==='full_review'?'subscription-review-scope':''}" data-task-scope="${esc(item.code)}" ${this.openTaskScopes.has(item.code)?'open':''}><summary>${esc(item.label)}的计费范围与包含内容</summary><div class="subscription-task-scope-body"><h4>本次计费范围</h4>${item.scope.length?`<ul>${item.scope.map(text=>`<li>${esc(text)}</li>`).join('')}</ul>`:'<p>范围待明确，暂不能启动付费任务。</p>'}<h4>本次价格已包含</h4>${item.included.length?`<ul>${item.included.map(text=>`<li>${esc(text)}</li>`).join('')}</ul>`:'<p>以本次明确的交付范围为准。</p>'}</div></details></li>`;}).join('')}</ul></details>`;
  }
  private draw(){
    if(!this.live())return;
    const priceList=document.querySelector<HTMLDetailsElement>('.subscription-price-list');if(priceList)this.taskPricesOpen=priceList.open;
    document.querySelectorAll<HTMLDetailsElement>('[data-task-scope]').forEach(detail=>{if(detail.open)this.openTaskScopes.add(detail.dataset.taskScope!);else this.openTaskScopes.delete(detail.dataset.taskScope!);});
    const focused=document.activeElement instanceof HTMLInputElement?{id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:undefined;
    const account=this.account;
    if(this.authenticatedFinalCheckout&&this.authenticatedFinalCheckout.order_id===this.order?.order_id&&this.authenticatedFinalCheckout.request_id===this.checkoutIntent?.request_id&&!checkoutPending(this.checkoutIntent))
      this.displayedFinalCheckout=this.authenticatedFinalCheckout!.request_id;
    const heading=document.querySelector('.account-page-heading p');if(heading)heading.textContent='账户信息、订阅与积分';
    this.shell(`<section class="credit-overview" aria-labelledby="account-balance-title"><h2 id="account-balance-title">可用积分</h2><p class="account-balance-value">${account?points(account.available_points):'—'}<span>积分</span></p><p class="account-balance-note">发起任务后自动预留，成功交付后自动扣费</p>${account&&hasPoints(account.task_held_points)?`<p class="credit-reservation" data-task-held>进行中任务预留 <strong>${points(account.task_held_points)}</strong> 积分</p>`:''}${account&&hasPoints(account.refund_held_points)?`<p class="credit-reservation" data-refund-held>原路退款冻结 <strong>${points(account.refund_held_points)}</strong> 积分，渠道结果仍在核对</p>`:''}${account?`<dl class="subscription-balance-sources"><div><dt>订阅额度</dt><dd>${points(account.subscription_available_points)} 积分</dd></div><div><dt>充值额度</dt><dd>${points(account.topup_available_points)} 积分</dd></div>${hasPoints(account.other_available_points)?`<div><dt>其他有效额度</dt><dd>${points(account.other_available_points)} 积分</dd></div>`:''}</dl>`:''}</section><div class="account-billing-content subscription-account">${this.error?`<p class="account-billing-error" role="alert">${esc(this.error)}</p>`:''}${this.message?`<p class="subscription-message" role="status">${esc(this.message)}</p>`:''}${this.returnTo||this.projectId?`<section class="notice"><p>${this.pendingTask?'已保存本次任务。当前页面确认到账后，将自动返回并继续同一任务；关闭页面不会在后台启动。':'已提交任务的材料与范围保留。到账后可返回原工作查看任务状态。'}</p><a class="btn secondary" href="${esc(this.back())}">返回刚才的工作</a>${this.pendingTask?'<button class="text-button" type="button" id="subscription-cancel-waiting">取消这次等待任务</button>':''}</section>`:''}${this.originalCheckout()}${this.order?this.payment():''}${this.plans()}${this.topup()}${this.periods()}${this.taskPrices()}<details id="subscription-quotation-details" ${this.quotationsOpen?'open':' '}><summary>任务范围与历史报价</summary><div id="subscription-quotations"></div></details><div id="subscription-credit-history"></div><details class="billing-faq"><summary>订阅、扣费与退款规则</summary><div class="billing-faq-body"><p>提出明确业务任务即可执行，后台锁价并预留积分，合格成果交付后自动扣费；失败或有效取消释放预留，不按模型重试追加费用。</p><p>订阅积分每批有效90天，优先使用符合任务权限且即将到期的额度；充值积分永久有效。停止续费不会提前清除已经到账的有效积分。</p><p>每期付款后7天内，该期积分完全未使用且无冻结时，可申请整期退款。已使用周期的普通停订只停止未来续费；平台责任及依法应退情形按对应规则处理。</p><p>充值退款只针对原订单可退实付；任务返分与现金退款分别记录。积分余额表示可用任务额度，不是可提现现金。</p></div></details></div>`,'billing');
    this.history.mount(document.querySelector<HTMLElement>('#subscription-credit-history')!);
    const quotations=document.querySelector<HTMLElement>('#subscription-quotations');if(quotations)this.quotations.mount(quotations);
    document.querySelector<HTMLDetailsElement>('#subscription-quotation-details')?.addEventListener('toggle',event=>{this.quotationsOpen=(event.currentTarget as HTMLDetailsElement).open;});
    const refundHost=document.querySelector<HTMLElement>('#subscription-payment-refunds');if(refundHost&&this.order)this.refunds.mount(refundHost,this.order.order_id);
    document.querySelector<HTMLSelectElement>('#subscription-provider')?.addEventListener('change',event=>{this.subscriptionProvider=(event.target as HTMLSelectElement).value as Provider;});
    document.querySelector<HTMLSelectElement>('#subscription-topup-provider')?.addEventListener('change',event=>{this.topupProvider=(event.target as HTMLSelectElement).value as Provider;});
    document.querySelector<HTMLInputElement>('#subscription-topup-amount')?.addEventListener('input',event=>{this.topupAmount=(event.target as HTMLInputElement).value;});
    document.querySelector('#subscription-topup-form')?.addEventListener('submit',event=>{event.preventDefault();void this.buyTopup();});
    document.querySelectorAll<HTMLButtonElement>('[data-subscribe]').forEach(button=>button.addEventListener('click',()=>void this.buySubscription(button.dataset.subscribe as SubscriptionCheckoutRequest['plan_id'])));
    document.querySelectorAll<HTMLButtonElement>('[data-topup-shortcut]').forEach(button=>button.addEventListener('click',()=>{this.topupAmount=button.dataset.topupShortcut!;this.draw();document.querySelector<HTMLInputElement>('#subscription-topup-amount')?.focus();}));
    document.querySelector('#refresh-subscription-payment')?.addEventListener('click',()=>void this.refreshPayment());
    document.querySelector('#subscription-continue-payment')?.addEventListener('click',()=>void this.purchase());
    document.querySelector('#subscription-cancel')?.addEventListener('click',()=>void this.cancel());
    document.querySelector('#subscription-cancel-waiting')?.addEventListener('click',()=>void this.cancelWaitingTask());
    document.querySelector('#subscription-auto-renew')?.addEventListener('click',()=>void this.authorizeRenewal());
    document.querySelector('#subscription-mandate-refresh')?.addEventListener('click',()=>void this.refreshMandate());
    if(this.order?.state==='pending'&&this.order.checkout_url?.startsWith('weixin://'))void this.paymentQr(this.order.checkout_url);
    if(focused){const input=document.getElementById(focused.id) as HTMLInputElement|null;input?.focus();if(input&&focused.start!==null&&focused.end!==null)input.setSelectionRange(focused.start,focused.end);}
  }
  private orderLink(id:string){const query=new URLSearchParams(rechargeHref(this.projectId).split('?')[1]);query.set('order',id);if(this.resumeRequest&&this.pendingTask)query.set('resume_request',this.resumeRequest);return '#/account?'+query;}
  private originalOrderLink(intent:CheckoutIntent){
    const query=new URLSearchParams();query.set('order',intent.order!.order_id);
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
    const provider=this.subscriptionProvider;if(!this.canBuy()||!provider||this.currentPeriodOpen(this.account?.subscription))return;
    if(!this.catalog.plans.some(plan=>plan.id===planId)||!this.catalog.providers.includes(provider))return;
    const previous=this.checkoutIntent,subscription=this.account?.subscription;
    const choice:CheckoutChoice=checkoutPending(previous)&&previous?.choice.kind==='subscription'&&previous.choice.plan_id===planId&&previous.choice.provider===provider
      ?previous.choice:{kind:'subscription',plan_id:planId,provider,...(subscription&&subscription.status!=='pending'?{subscription_id:subscription.id}:{})};
    await this.purchase(choice);
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
        if(!this.live()||this.owner!==owner)throw new Error('Checkout page is no longer active');
        if(intent.order)return this.api.commerceRefresh(intent.order.order_id,this.controller.signal);
        const c=intent.choice;
        if(intent.version===1){
          const headers={[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION};
          if(c.kind==='topup')return this.api.request<Dto<'RechargeOrderResponse'>>('POST','/commerce/topups',{request_id:intent.request_id,amount_fen:c.amount_fen,provider:c.provider,...(c.project_id?{project_id:c.project_id}:{})},headers,this.controller.signal);
          const result=await this.api.request<{order:Dto<'RechargeOrderResponse'>}>('POST',c.subscription_id?`/subscriptions/${encodeURIComponent(c.subscription_id)}/renew`:'/subscriptions',{request_id:intent.request_id,plan_id:c.plan_id,provider:c.provider},headers,this.controller.signal);return result.order;
        }
        if(c.kind==='topup')return this.api.commerceTopup({request_id:intent.request_id,amount_fen:int64(c.amount_fen).toString(),provider:c.provider,...(c.project_id?{project_id:c.project_id}:{})},this.controller.signal);
        const request={request_id:intent.request_id,plan_id:c.plan_id,provider:c.provider};
        const result=c.subscription_id?await this.api.renewSubscription(c.subscription_id,request,this.controller.signal):await this.api.createSubscription(request,this.controller.signal);
        return result.order;
      },undefined,{...(this.projectId?{project_id:this.projectId}:{}),...(this.returnTo?{return_to:this.returnTo}:{}),...(this.resumeRequest&&this.pendingTask?{resume_request:this.resumeRequest}:{})});
      this.checkoutIntent=saved;if(this.live())location.hash=this.originalOrderLink(saved);
    }catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;this.readIntent();if(this.live())this.draw();}
  }
  private async refreshPayment(){
    if(this.busy||!this.order)return;this.busy=true;this.error='';this.draw();
    try{const order=await this.api.commerceRefresh(this.order.order_id,this.controller.signal);if(this.live()){this.order=order;await this.observeOrder();const [account,commerce,detail]=await Promise.all([this.api.subscriptionAccount(this.controller.signal),this.api.commerceCatalog(this.controller.signal),this.readOrderDetail(order.order_id)]);this.account=account;this.commerce=commerce;this.setOrderDetail(detail);await this.history.refresh();window.dispatchEvent(new Event('bondbuddy:credits-changed'));await this.returnToPaidTask();}}
    catch(error){if(this.live())this.error=friendlyError(error,'read');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async cancel(){
    const subscription=this.account?.subscription;if(this.busy||!subscription||!subscription.auto_renew&&subscription.mandate_status!=='pending')return;
    if(this.cancelRequest?.id!==subscription.id)this.cancelRequest={id:subscription.id,request_id:crypto.randomUUID()};
    this.busy=true;this.error='';this.draw();
    try{const saved=await this.api.cancelSubscription(subscription.id,{request_id:this.cancelRequest.request_id},this.controller.signal);if(this.live()&&this.account){this.account.subscription=saved;this.authorizationUrl=undefined;this.message=saved.mandate_status==='cancel_pending'?'已提交停止续费，渠道结果仍在核对；已到账积分继续保留。':'已停止未来续费，已到账积分按原有效期继续使用。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async authorizeRenewal(){
    const subscription=this.account?.subscription;if(this.busy||!subscription||subscription.mandate_status==='cancel_pending'||!this.catalog.auto_renew_available)return;
    if(this.renewRequest?.id!==subscription.id)this.renewRequest={id:subscription.id,request_id:crypto.randomUUID(),enabled:true};
    this.busy=true;this.error='';this.draw();
    try{const response=await this.api.subscriptionAutoRenew(subscription.id,{request_id:this.renewRequest.request_id,enabled:true},this.controller.signal);if(this.live()&&this.account){this.account.subscription=response.subscription;this.authorizationUrl=response.authorization_url?.startsWith('https://')?response.authorization_url:undefined;this.message=response.subscription.auto_renew?'自动续费已开通。':'请在支付渠道完成授权后刷新状态。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async refreshMandate(){
    const subscription=this.account?.subscription;if(this.busy||!subscription)return;const cancelling=subscription.mandate_status==='cancel_pending';this.busy=true;this.error='';this.draw();
    try{const response=await this.api.refreshSubscriptionAutoRenew(subscription.id,this.controller.signal);if(this.live()&&this.account){this.account.subscription=response.subscription;this.authorizationUrl=response.subscription.mandate_status==='pending'&&response.authorization_url?.startsWith('https://')?response.authorization_url:undefined;if(cancelling)this.message=response.subscription.mandate_status==='cancel_pending'?'原解约结果仍在核对，可稍后刷新；已到账积分继续保留。':response.subscription.mandate_status==='cancelled'?'支付渠道已确认停止续费，已到账积分按原有效期继续使用。':'已刷新原解约状态，请查看当前订阅信息。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'read');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async paymentQr(url:string){
    if(this.qr?.url===url||this.qrPending===url)return;this.qrPending=url;
    try{const data=await QRCode.toDataURL(url,{width:240,margin:2,errorCorrectionLevel:'M'});if(this.live()&&this.order?.checkout_url===url){this.qr={url,data};this.draw();}}
    catch{if(this.live()){this.error='支付二维码暂未生成，请刷新本订单重试。';this.draw();}}
    finally{this.qrPending=undefined;}
  }
}
