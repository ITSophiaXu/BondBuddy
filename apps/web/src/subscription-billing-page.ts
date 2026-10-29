import QRCode from 'qrcode';
import type {CommerceCatalog,SubscriptionCatalog,SubscriptionAccount,SubscriptionCheckoutRequest,Subscription,SubscriptionPeriod} from '@bondbuddy/contracts';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {CreditHistory} from './credit-history';
import {CommerceRefunds} from './commerce-refunds';
import {cny} from './commerce';
import {date,esc} from './ui';
import {rechargeHref,workReturnTo} from './project-navigation';
import {readBillingTask,billingTaskReturnTo,cancelBillingTask,type BillingTask} from './billing-task-recovery';
import './subscription-billing-page.css';

const points=(value:number)=>value.toLocaleString('zh-CN');
const channels={wechat:'微信支付',alipay:'支付宝'};
type Provider=keyof typeof channels;
const planLabel=(id:string)=>({light:'轻量',professional:'专业',intensive:'密集'}[id]??id);
const validDate=(value:string|null)=>value?Date.parse(value):NaN;

/** A 404 is an older deployment; an unavailable billing service must remain an error. */
export async function readSubscriptionCatalog(api:ApiClient,signal?:AbortSignal):Promise<SubscriptionCatalog|undefined>{
  try{return await api.subscriptionCatalog(signal);}catch(error){if(error instanceof ApiError&&error.status===404)return undefined;throw error;}
}

/** Convert entered CNY into integer fen without a floating-point multiplication. */
export function topupFen(input:string):number|null{
  const match=/^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if(!match)return null;
  const value=Number(match[1])*100+Number((match[2]??'').padEnd(2,'0'));
  return Number.isSafeInteger(value)&&value>=1&&value<=1_000_000?value:null;
}

/** Monthly entitlement and permanent topups share the existing server wallet. */
export class SubscriptionBillingPage{
  private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;
  private account?:SubscriptionAccount;private commerce?:CommerceCatalog;private order?:Dto<'RechargeOrderResponse'>;
  private busy=false;private loading=false;private error='';private message='';private topupAmount='';
  private subscriptionProvider?:Provider;private topupProvider?:Provider;
  private checkoutRequest?:SubscriptionCheckoutRequest;private topupRequest?:Dto<'CommerceTopupRequest'>;
  private cancelRequest?:{id:string;request_id:string};private renewRequest?:{id:string;request_id:string;enabled:boolean};
  private authorizationUrl?:string;private qr?:{url:string;data:string};private qrPending?:string;
  private history:CreditHistory;private refunds:CommerceRefunds;
  private resumeRequest=new URLSearchParams(location.hash.split('?')[1]).get('resume_request');
  private pendingTask?:BillingTask;
  private returnTo=workReturnTo(new URLSearchParams(location.hash.split('?')[1]).get('return_to'));
  private onCredits=()=>{if(!document.hidden)void this.refreshAccount();};
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private active:()=>boolean,
    private catalog:SubscriptionCatalog,private projectId?:string,private orderId?:string,private owner?:string){
    this.history=new CreditHistory(api,active,()=>true,()=>true);
    this.refunds=new CommerceRefunds(api,active,owner,()=>!!this.paymentPeriod());
    this.subscriptionProvider=catalog.providers[0];this.topupProvider=catalog.providers[0];
    window.addEventListener('bondbuddy:credits-changed',this.onCredits);window.addEventListener('focus',this.onCredits);
    document.addEventListener('visibilitychange',this.onCredits);
  }
  dispose(){this.controller.abort();clearTimeout(this.timer);this.history.dispose();this.refunds.dispose();
    window.removeEventListener('bondbuddy:credits-changed',this.onCredits);window.removeEventListener('focus',this.onCredits);document.removeEventListener('visibilitychange',this.onCredits);}
  private live(){return this.active()&&!this.controller.signal.aborted;}
  async render(){
    this.shell('<p role="status">正在读取订阅与积分…</p>','billing');
    try{
      const [account,commerce]=await Promise.all([this.api.subscriptionAccount(this.controller.signal),this.api.commerceCatalog(this.controller.signal)]);
      if(!this.live())return;this.account=account;this.commerce=commerce;
      if(this.owner&&this.resumeRequest){this.pendingTask=await readBillingTask(this.owner,this.resumeRequest);if(this.pendingTask&&!['needs_funds','resuming','unknown'].includes(this.pendingTask.state))this.pendingTask=undefined;}
      const required=this.pendingTask?.requiredPoints??this.pendingTask?.body.expected_points;
      if(typeof required==='number'&&Number.isSafeInteger(required)&&required>account.available_points&&required-account.available_points<=1_000_000)this.topupAmount=((required-account.available_points)/100).toFixed(2);
      if(this.orderId)this.order=await this.api.commerceOrder(this.orderId,this.controller.signal);
      if(await this.returnToPaidTask())return;
    }catch(error){if(this.live())this.error=friendlyError(error,'read');}
    if(this.live()){this.draw();this.schedule();}
  }
  private back(){return this.returnTo??(this.projectId?'#/projects/'+encodeURIComponent(this.projectId):'#tasks');}
  private currentPeriodOpen(subscription:Subscription|null|undefined){return !!subscription&&validDate(subscription.current_period_end)>Date.now();}
  private paymentPeriod():SubscriptionPeriod|undefined{return this.account?.periods.find(period=>period.order_id===this.order?.order_id);}
  private canBuy(){return !!this.account&&this.catalog.enabled&&this.catalog.providers.length>0&&!this.busy&&this.order?.state!=='pending';}
  private schedule(){clearTimeout(this.timer);if(this.live())this.timer=setTimeout(()=>void this.refreshAccount(),15_000);}
  private async refreshAccount(){
    if(!this.live()||this.loading||this.busy){this.schedule();return;}this.loading=true;
    try{const account=await this.api.subscriptionAccount(this.controller.signal);if(this.live()){this.account=account;this.draw();}}
    catch(error){if(this.live()){this.error=friendlyError(error,'read');this.draw();}}
    finally{this.loading=false;this.schedule();}
  }
  private providerSelect(id:string,selected:Provider|undefined){return `<label class="account-payment-method">支付方式<select id="${id}">${this.catalog.providers.map(provider=>`<option value="${provider}" ${provider===selected?'selected':''}>${channels[provider]}</option>`).join('')}</select></label>`;}
  private subscriptionSummary(){
    const subscription=this.account?.subscription;if(!subscription)return '<p class="subscription-plan-note">不订阅也能充值使用全部已开放功能。</p>';
    const open=this.currentPeriodOpen(subscription);
    const status=subscription.mandate_status==='cancel_pending'?'正在停止续费':subscription.status==='pending'?'等待付款':subscription.status==='cancelled'?'已停止续费':open?'本期已开通':subscription.status==='past_due'?'本期续费未完成':'本期已结束';
    return `<section class="subscription-current" aria-label="当前订阅"><div><span class="subscription-status">${status}</span><h3>${esc(planLabel(subscription.plan_id))}订阅</h3><p>${subscription.current_period_end?`本期至 ${esc(date(subscription.current_period_end))}。`:''}已到账积分按各批次有效期保留。</p><p>${subscription.auto_renew?'已开通自动续费，下期按当前套餐续订。':this.catalog.auto_renew_available?'自动续费未开通，可选择授权。':'当前渠道支持单次开通，自动续费暂未开放。'}</p></div><div class="subscription-current-actions">${subscription.auto_renew||subscription.mandate_status==='pending'?`<button class="btn secondary" type="button" id="subscription-cancel" ${this.busy?'disabled':''}>停止下期续费</button>`:subscription.status!=='pending'&&this.catalog.auto_renew_available?`<button class="btn secondary" type="button" id="subscription-auto-renew" ${this.busy?'disabled':''}>授权自动续费</button>`:''}${subscription.mandate_status==='pending'?`<button class="text-button" type="button" id="subscription-mandate-refresh" ${this.busy?'disabled':''}>刷新续费授权状态</button>`:''}</div>${this.authorizationUrl?`<p class="subscription-authorization"><a class="btn primary" href="${esc(this.authorizationUrl)}" target="_blank" rel="noopener noreferrer">前往支付渠道授权</a><span>授权结果以支付渠道核实为准。</span></p>`:''}</section>`;
  }
  private plans(){
    const subscription=this.account?.subscription,open=this.currentPeriodOpen(subscription);
    return `<section class="subscription-plans" aria-labelledby="subscription-plans-title"><div class="section-head"><div><h2 id="subscription-plans-title">月订阅</h2><p>每期到账积分有效90天，可结转使用；所有档位开放相同业务能力。</p></div></div>${this.subscriptionSummary()}${this.catalog.providers.length?this.providerSelect('subscription-provider',this.subscriptionProvider):'<p class="account-recharge-status" role="status">支付渠道暂未开放，暂不能开通订阅或充值。</p>'}<div class="subscription-plan-grid">${this.catalog.plans.map(plan=>`<article class="credit-pack subscription-plan ${plan.id==='professional'?'recommended':''}" data-subscription-plan="${esc(plan.id)}"><div class="credit-pack-heading"><h3>${esc(plan.label)}</h3>${subscription?.plan_id===plan.id&&open?'<span class="credit-pack-badge">当前订阅</span>':''}</div><p class="plan-price">${cny(plan.amount_fen)}<small> / 月</small></p><p class="subscription-plan-points"><strong>${points(plan.points)}</strong> 积分 / 期</p><p class="subscription-plan-note">每批有效${plan.credit_valid_days}天<br>超出后按需充值</p><button class="btn ${plan.id==='professional'?'primary':'secondary'}" type="button" data-subscribe="${esc(plan.id)}" ${!this.canBuy()||open?'disabled':''}>${open?'本期已开通':subscription&&subscription.status!=='pending'?'续订'+plan.label:'开通'+plan.label}</button></article>`).join('')}</div><p class="subscription-plan-note">${open?'下个周期可更换档位；本期额度不足可直接充值。':'月费包含上方积分，不额外收取任务会员费。'} ${this.catalog.auto_renew_available?'自动续费需要单独授权。':'本次开通只收取一个月费用，不会自动扣取下一期月费。'}</p></section>`;
  }
  private payment(){
    const order=this.order!;const period=this.paymentPeriod();
    const title=period?.status==='refunded'?'本期已退款':{pending:'等待支付确认',paid:'积分已到账',expired:'订单已过期',failed:'支付未完成'}[order.state];
    const link=order.checkout_url;
    return `<section class="panel payment-card simple-payment subscription-payment"><h2>${title}</h2><p>${period?esc(planLabel(period.plan_id))+'月订阅':'按需充值'}</p><div class="payment-amount">${cny(order.amount_fen)}</div><p>${points(order.points)} 积分${period?' · 到账后有效90天':' · 永久有效'}</p>${order.state==='pending'&&link?.startsWith('https://')?`<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">前往${channels[order.provider]}</a>`:order.state==='pending'&&link?.startsWith('weixin://')?`<div class="commerce-native-payment">${this.qr?.url===link?`<img src="${this.qr.data}" width="240" height="240" alt="本订单微信支付二维码"/>`:'<p role="status">正在生成本订单支付二维码…</p>'}<p>请使用微信扫码支付。支付结果未确认时，刷新本订单即可。</p></div>`:order.state==='pending'?'<p role="status">尚未取得可用支付链接，请刷新本订单状态。</p>':''}<button class="btn secondary" type="button" id="refresh-subscription-payment" ${this.busy?'disabled':''}>刷新支付状态</button><a class="text-button" href="${esc(this.back())}">返回刚才的工作</a><p class="muted">订单号：${esc(order.order_id)}</p>${order.state==='paid'?'<div id="subscription-payment-refunds"></div>':''}</section>`;
  }
  private topup(){return `<section class="credit-recharge subscription-topup" aria-labelledby="subscription-topup-title"><div class="section-head"><div><h2 id="subscription-topup-title">按需充值</h2><p>¥1＝100积分，永久有效。可以单独充值，也可补充订阅额度。</p></div></div>${this.catalog.providers.length?`<form id="subscription-topup-form">${this.providerSelect('subscription-topup-provider',this.topupProvider)}<label>充值金额（元）<input id="subscription-topup-amount" inputmode="decimal" type="text" value="${esc(this.topupAmount)}" placeholder="例如 12.18" autocomplete="off" required aria-describedby="subscription-topup-help"></label><button class="btn primary" type="submit" ${!this.canBuy()?'disabled':''}>充值并前往支付</button><p id="subscription-topup-help">最低0.01元，单次最高10,000元；实付金额按1元100积分到账。</p><div class="subscription-topup-shortcuts" aria-label="快捷充值金额">${[50,200,500].map(amount=>`<button class="btn secondary" type="button" data-topup-shortcut="${amount}" ${this.busy?'disabled':''}>¥${amount}</button>`).join('')}</div></form>`:'<p class="account-recharge-status">充值渠道暂未开放。</p>'}</section>`;}
  private periods(){
    const rows=this.account?.periods??[];if(!rows.length)return '';
    return `<section class="subscription-periods" aria-labelledby="subscription-periods-title"><h2 id="subscription-periods-title">订阅额度明细</h2><ul>${rows.map(period=>`<li data-period="${esc(period.id)}"><div><strong>${esc(planLabel(period.plan_id))} · ${points(period.points)} 积分</strong><p>${period.starts_at?esc(date(period.starts_at))+' 到账':'等待本期付款'}${period.credits_expires_at?' · '+esc(date(period.credits_expires_at))+' 到期':''}</p><a class="text-button" href="${esc(this.orderLink(period.order_id))}">查看支付与退款</a></div><div><strong>可用 ${points(period.available_points)} 积分</strong><p>${period.status==='refunded'?'本期已退款':period.held_points?'任务预留 '+points(period.held_points)+' 积分':period.status==='failed'?'付款未完成':period.credits_expires_at&&validDate(period.credits_expires_at)<=Date.now()?'本批额度已到期':'按有效期保留'}</p></div></li>`).join('')}</ul></section>`;
  }
  private draw(){
    if(!this.live())return;
    const focused=document.activeElement instanceof HTMLInputElement?{id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:undefined;
    const account=this.account;
    const heading=document.querySelector('.account-page-heading p');if(heading)heading.textContent='账户信息、订阅与积分';
    this.shell(`<section class="credit-overview" aria-labelledby="account-balance-title"><h2 id="account-balance-title">可用积分</h2><p class="account-balance-value">${account?points(account.available_points):'—'}<span>积分</span></p><p class="account-balance-note">发起任务后自动预留，成功交付后自动扣费</p>${account?.held_points?`<p class="credit-reservation">进行中任务预留 <strong>${points(account.held_points)}</strong> 积分</p>`:''}${account?`<dl class="subscription-balance-sources"><div><dt>订阅额度</dt><dd>${points(account.subscription_available_points)} 积分</dd></div><div><dt>充值额度</dt><dd>${points(account.topup_available_points)} 积分</dd></div>${account.other_available_points?`<div><dt>其他有效额度</dt><dd>${points(account.other_available_points)} 积分</dd></div>`:''}</dl>`:''}</section><div class="account-billing-content subscription-account">${this.error?`<p class="account-billing-error" role="alert">${esc(this.error)}</p>`:''}${this.message?`<p class="subscription-message" role="status">${esc(this.message)}</p>`:''}${this.returnTo||this.projectId?`<section class="notice"><p>${this.pendingTask?'已保存本次任务。当前页面确认到账后，将自动返回并继续同一任务；关闭页面不会在后台启动。':'已提交任务的材料与范围保留。到账后可返回原工作查看任务状态。'}</p><a class="btn secondary" href="${esc(this.back())}">返回刚才的工作</a>${this.pendingTask?'<button class="text-button" type="button" id="subscription-cancel-waiting">取消这次等待任务</button>':''}</section>`:''}${this.order?this.payment():''}${this.plans()}${this.topup()}${this.periods()}<details class="subscription-price-list"><summary>查看任务价格与计费范围</summary><p>任务按受理时的价格锁定。必要检查、原范围修正和平台重试包含在父任务中。</p><ul>${(this.commerce?.items??[]).map(item=>`<li><span>${esc(item.label)} / ${esc(item.unit)}</span><strong>${item.price_fen===null?'暂未开放':points(item.price_fen)+' 积分'}</strong></li>`).join('')}</ul></details><div id="subscription-credit-history"></div><details class="billing-faq"><summary>订阅、扣费与退款规则</summary><div class="billing-faq-body"><p>提出明确业务任务即可执行，后台锁价并预留积分，合格成果交付后自动扣费；失败或有效取消释放预留，不按模型重试追加费用。</p><p>订阅积分每批有效90天，优先使用符合任务权限且即将到期的额度；充值积分永久有效。停止续费不会提前清除已经到账的有效积分。</p><p>每期付款后7天内，该期积分完全未使用且无冻结时，可申请整期退款。已使用周期的普通停订只停止未来续费；平台责任及依法应退情形按对应规则处理。</p><p>充值退款只针对原订单可退实付；任务返分与现金退款分别记录。积分余额表示可用任务额度，不是可提现现金。</p></div></details></div>`,'billing');
    this.history.mount(document.querySelector<HTMLElement>('#subscription-credit-history')!);
    const refundHost=document.querySelector<HTMLElement>('#subscription-payment-refunds');if(refundHost&&this.order)this.refunds.mount(refundHost,this.order.order_id);
    document.querySelector<HTMLSelectElement>('#subscription-provider')?.addEventListener('change',event=>{this.subscriptionProvider=(event.target as HTMLSelectElement).value as Provider;});
    document.querySelector<HTMLSelectElement>('#subscription-topup-provider')?.addEventListener('change',event=>{this.topupProvider=(event.target as HTMLSelectElement).value as Provider;});
    document.querySelector<HTMLInputElement>('#subscription-topup-amount')?.addEventListener('input',event=>{this.topupAmount=(event.target as HTMLInputElement).value;});
    document.querySelector('#subscription-topup-form')?.addEventListener('submit',event=>{event.preventDefault();void this.buyTopup();});
    document.querySelectorAll<HTMLButtonElement>('[data-subscribe]').forEach(button=>button.addEventListener('click',()=>void this.buySubscription(button.dataset.subscribe as SubscriptionCheckoutRequest['plan_id'])));
    document.querySelectorAll<HTMLButtonElement>('[data-topup-shortcut]').forEach(button=>button.addEventListener('click',()=>{this.topupAmount=button.dataset.topupShortcut!;this.draw();document.querySelector<HTMLInputElement>('#subscription-topup-amount')?.focus();}));
    document.querySelector('#refresh-subscription-payment')?.addEventListener('click',()=>void this.refreshPayment());
    document.querySelector('#subscription-cancel')?.addEventListener('click',()=>void this.cancel());
    document.querySelector('#subscription-cancel-waiting')?.addEventListener('click',()=>void this.cancelWaitingTask());
    document.querySelector('#subscription-auto-renew')?.addEventListener('click',()=>void this.authorizeRenewal());
    document.querySelector('#subscription-mandate-refresh')?.addEventListener('click',()=>void this.refreshMandate());
    if(this.order?.state==='pending'&&this.order.checkout_url?.startsWith('weixin://'))void this.paymentQr(this.order.checkout_url);
    if(focused){const input=document.getElementById(focused.id) as HTMLInputElement|null;input?.focus();if(input&&focused.start!==null&&focused.end!==null)input.setSelectionRange(focused.start,focused.end);}
  }
  private orderLink(id:string){const query=new URLSearchParams(rechargeHref(this.projectId).split('?')[1]);query.set('order',id);if(this.resumeRequest&&this.pendingTask)query.set('resume_request',this.resumeRequest);return '#/account?'+query;}
  private async returnToPaidTask(){
    if(!this.live()||this.order?.state!=='paid'||!this.owner||!this.resumeRequest||!this.pendingTask)return false;
    const target=await billingTaskReturnTo(this.owner,this.resumeRequest);
    if(!target||!this.live())return false;location.hash=target;return true;
  }
  private async cancelWaitingTask(){
    if(!this.owner||!this.resumeRequest||!this.pendingTask)return;
    await cancelBillingTask(this.owner,this.resumeRequest);this.pendingTask=undefined;this.message='已取消这次等待补款的任务，不影响已有积分或支付订单。';this.draw();
  }
  private async buySubscription(planId:SubscriptionCheckoutRequest['plan_id']){
    const provider=this.subscriptionProvider;if(!this.canBuy()||!provider||this.currentPeriodOpen(this.account?.subscription))return;
    if(!this.catalog.plans.some(plan=>plan.id===planId)||!this.catalog.providers.includes(provider))return;
    if(this.checkoutRequest?.plan_id!==planId||this.checkoutRequest.provider!==provider)this.checkoutRequest={request_id:crypto.randomUUID(),plan_id:planId,provider};
    const request=this.checkoutRequest,subscription=this.account?.subscription;this.busy=true;this.error='';this.draw();
    try{const result=subscription&&subscription.status!=='pending'?await this.api.renewSubscription(subscription.id,request,this.controller.signal):await this.api.createSubscription(request,this.controller.signal);if(this.live())location.hash=this.orderLink(result.order.order_id);}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async buyTopup(){
    const amount=topupFen(this.topupAmount),provider=this.topupProvider;if(!this.canBuy()||!provider)return;
    if(amount===null||!this.catalog.providers.includes(provider)){this.error='请输入0.01至10,000元之间、最多两位小数的充值金额。';this.draw();return;}
    if(this.topupRequest?.amount_fen!==amount||this.topupRequest.provider!==provider)this.topupRequest={request_id:crypto.randomUUID(),amount_fen:amount,provider,...(this.projectId?{project_id:this.projectId}:{})};
    this.busy=true;this.error='';this.draw();
    try{const order=await this.api.commerceTopup(this.topupRequest,this.controller.signal);if(this.live())location.hash=this.orderLink(order.order_id);}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async refreshPayment(){
    if(this.busy||!this.order)return;this.busy=true;this.error='';this.draw();
    try{const order=await this.api.commerceRefresh(this.order.order_id,this.controller.signal);if(this.live()){this.order=order;this.account=await this.api.subscriptionAccount(this.controller.signal);await this.history.refresh();window.dispatchEvent(new Event('bondbuddy:credits-changed'));await this.returnToPaidTask();}}
    catch(error){if(this.live())this.error=friendlyError(error,'read');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async cancel(){
    const subscription=this.account?.subscription;if(this.busy||!subscription||!subscription.auto_renew&&subscription.mandate_status!=='pending')return;
    if(this.cancelRequest?.id!==subscription.id)this.cancelRequest={id:subscription.id,request_id:crypto.randomUUID()};
    this.busy=true;this.error='';this.draw();
    try{const saved=await this.api.cancelSubscription(subscription.id,{request_id:this.cancelRequest.request_id},this.controller.signal);if(this.live()&&this.account){this.account.subscription=saved;this.message=saved.mandate_status==='cancel_pending'?'已提交停止续费，渠道结果仍在核对；已到账积分继续保留。':'已停止未来续费，已到账积分按原有效期继续使用。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async authorizeRenewal(){
    const subscription=this.account?.subscription;if(this.busy||!subscription||!this.catalog.auto_renew_available)return;
    if(this.renewRequest?.id!==subscription.id)this.renewRequest={id:subscription.id,request_id:crypto.randomUUID(),enabled:true};
    this.busy=true;this.error='';this.draw();
    try{const response=await this.api.subscriptionAutoRenew(subscription.id,{request_id:this.renewRequest.request_id,enabled:true},this.controller.signal);if(this.live()&&this.account){this.account.subscription=response.subscription;this.authorizationUrl=response.authorization_url?.startsWith('https://')?response.authorization_url:undefined;this.message=response.subscription.auto_renew?'自动续费已开通。':'请在支付渠道完成授权后刷新状态。';}}
    catch(error){if(this.live())this.error=friendlyError(error,'submit');}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private async refreshMandate(){
    const subscription=this.account?.subscription;if(this.busy||!subscription)return;this.busy=true;this.error='';this.draw();
    try{const response=await this.api.refreshSubscriptionAutoRenew(subscription.id,this.controller.signal);if(this.live()&&this.account){this.account.subscription=response.subscription;if(response.subscription.auto_renew)this.authorizationUrl=undefined;}}
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
