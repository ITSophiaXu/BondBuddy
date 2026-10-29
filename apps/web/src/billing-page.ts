import QRCode from 'qrcode';
import './commerce.css';
import { CreditHistory } from './credit-history';
import { ApiClient, friendlyError, type Dto } from './api';
import { esc } from './ui';
import { navigationProjectContext, rechargeHref, workReturnTo } from './project-navigation';
import {readCommerce,cny} from './commerce';
import {CommerceQuotations} from './commerce-quotations';
import {CommerceRefunds} from './commerce-refunds';
import {SubscriptionBillingPage,readSubscriptionCatalog} from './subscription-billing-page';
import type {CommerceCatalog,CommerceAccount} from '@bondbuddy/contracts';
import '../../../product-prototype/public/credits.css';

const number=(n:number)=>n.toLocaleString('zh-CN');
const money=(n:number)=>(n/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
const channel={wechat:'微信支付',alipay:'支付宝'};
/** Reuses the prototype credit overview, pack grid and single-order payment card. */
export class BillingPage {
  private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;
  private busy=false;private balance?:Dto<'CreditBalanceResponse'>;private config?:Dto<'RechargeConfigResponse'>;
  private quote?:Dto<'FixedQuoteResponse'>;private order?:Dto<'RechargeOrderResponse'>;private error='';
  private history:CreditHistory;private updatingHistory=false;private historyTimer?:ReturnType<typeof setTimeout>;
  private onCredits=()=>{if(!this.subscriptionPage&&!document.hidden)void this.refreshHistory();};
  private request?:Dto<'RechargeOrderRequest'>;private reviewProject=false;
  private commerce?:CommerceCatalog;private commerceBalance?:CommerceAccount;private topupRequest?:Dto<'CommerceTopupRequest'>;private topupAmount='';
  private qr?:{url:string;data:string};private qrPending?:string;
  private quotations:CommerceQuotations;private refunds:CommerceRefunds;
  private subscriptionPage?:SubscriptionBillingPage;
  private returnTo=workReturnTo(new URLSearchParams(location.hash.split('?')[1]).get('return_to'));
  private returnProject=navigationProjectContext(location.hash)?.projectId;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private active:()=>boolean,
    private projectId?:string,private orderId?:string,private owner?:string){this.history=new CreditHistory(api,active,()=>!!this.commerce?.enabled);this.quotations=new CommerceQuotations(api,active);this.refunds=new CommerceRefunds(api,active,owner);window.addEventListener('bondbuddy:credits-changed',this.onCredits);window.addEventListener('focus',this.onCredits);document.addEventListener('visibilitychange',this.onCredits);}
  dispose(){this.controller.abort();clearTimeout(this.timer);clearTimeout(this.historyTimer);this.history.dispose();this.quotations.dispose();this.refunds.dispose();this.subscriptionPage?.dispose();window.removeEventListener('bondbuddy:credits-changed',this.onCredits);window.removeEventListener('focus',this.onCredits);document.removeEventListener('visibilitychange',this.onCredits);}
  async render(){
    this.shell('<p role="status">正在读取账户与计费方式…</p>','billing');
    try{
      const subscriptions=await readSubscriptionCatalog(this.api,this.controller.signal);
      if(!this.active())return;
      if(subscriptions?.enabled){this.subscriptionPage=new SubscriptionBillingPage(this.api,this.shell,this.active,subscriptions,this.projectId,this.orderId,this.owner);await this.subscriptionPage.render();return;}
      this.commerce=await readCommerce(this.api,this.controller.signal);
      if(this.commerce?.enabled)this.commerceBalance=await this.api.commerceAccount(this.controller.signal);
      else [this.balance,this.config]=await Promise.all([this.api.creditBalance(this.controller.signal),this.api.rechargeConfig(this.controller.signal)]);
      if(this.orderId){this.order=await (this.commerce?.enabled?this.api.commerceOrder(this.orderId,this.controller.signal):this.api.rechargeOrder(this.orderId,this.controller.signal));this.projectId=this.order.project_id??this.projectId;}
      if(this.projectId){const p=await this.api.project(this.projectId,this.controller.signal);
        this.reviewProject=p.kind==='review';
        if(!this.commerce?.enabled&&!this.reviewProject&&(!this.returnTo||/^#\/projects\/[^/?]+(?:\?|$)/.test(this.returnTo))&&p.input_revision&&p.input_hash)this.quote=await this.api.creditQuote(p.project_id,{input_revision:p.input_revision,input_hash:p.input_hash},this.controller.signal);}
    }catch(e){this.error=friendlyError(e,'read');}
    if(this.active()){this.draw();this.schedule();this.scheduleHistory();}
  }
  private back(){
    if(this.returnTo)return this.returnTo;
    if(!this.projectId)return '#tasks';
    const query=new URLSearchParams(this.reviewProject?{tab:'materials'}:{step:'materials',resume:'credits'});
    if(this.returnProject)query.set('return_project',this.returnProject);
    return `#/projects/${encodeURIComponent(this.projectId)}${this.reviewProject?'/review':''}?${query}`;
  }
  private continuity(){
    if(this.commerce?.enabled)return '已保存的材料、版本与范围保留。充值只增加服务余额，不会自动开始新任务；请返回原工作核对服务端报价并确认。';
    const path=this.returnTo?.split('?')[0]??'';
    if(path==='#consistency'||path==='#generate'&&!new URLSearchParams(this.returnTo?.split('?')[1]).has('topic'))return '已有文件、模板与检查记录保留。充值到账不会自动提交文件更新或生成，请返回原页面选择范围并重新确认费用。';
    if(path==='#integrity'||path==='#qa')return '已保存的材料、名单和历史记录保留。充值到账不会自动开始新一轮，请返回原页面核对范围与费用后开始。';
    if(this.reviewProject||path==='#generate')return '已保存的材料与要求保留。充值到账不会自动开始新任务；已暂停任务请返回原页面查看恢复状态。';
    if(!this.returnTo||/^#\/projects\/[^/?]+(?:\?|$)/.test(this.returnTo))return '因积分用完而暂停的募集书更新任务将在到账后自动继续；未开始的新任务仍需返回项目点击开始。';
    return '已保存的项目文件与历史记录保留。充值到账不会自动开始新任务，请返回刚才的工作继续处理。';
  }
  private draw(){
    if(!this.active())return;
    if(this.commerce?.enabled){this.drawCommerce();return;}
    const provider=document.querySelector<HTMLSelectElement>('#payment-provider')?.value;
    const faqOpen=document.querySelector<HTMLDetailsElement>('.billing-faq')?.open;
    const b=this.balance,c=this.config,o=this.order;
    const shortage=this.reviewProject?Math.max(0,(this.quote?.quote?.points??0)-(b?.available??0)):(b?.available??0)===0;
    const returnLink=`<a class="btn secondary" href="${esc(this.back())}">${this.returnTo?'返回刚才的工作':this.projectId?(this.reviewProject?'返回项目确认开始':'返回项目继续更新'):'返回全部项目'}</a>`;
    const context=this.projectId||this.returnTo?`<section class="notice"><span>${this.quote?.quote?shortage?'可用积分为 0，请充值后继续更新。':'已有可用积分，可返回项目继续更新。':''}${this.continuity()}</span>${returnLink}</section>`:'';
    this.shell(`<section class="credit-overview" aria-labelledby="account-balance-title"><h2 id="account-balance-title">可用积分</h2><p class="account-balance-value">${b?number(b.available):'—'}<span>积分</span></p><p class="account-balance-note">上传、保存项目和下载已有成果免费</p>${b && b.frozen > 0 ? `<p class="credit-reservation">进行中任务预留 <strong>${number(b.frozen)}</strong> 积分<span>已从可用积分中预留，成功后扣除，失败或取消后返还。</span></p>` : ''}</section>
      <div class="account-billing-content">${this.error?`<p class="account-billing-error" role="alert">${esc(this.error)}</p>`:''}${context}
      ${o?`<div class="simple-payment-wrap"><section class="panel payment-card simple-payment"><span class="eyebrow">CREDIT RECHARGE</span><h2>${{pending:'等待支付确认',paid:'积分已到账',expired:'订单已过期',failed:'支付未完成'}[o.state]}</h2><p>${number(o.points)} 积分</p><div class="payment-amount">¥${money(o.amount_fen)}</div>
        ${o.state==='pending'&&o.checkout_url?.startsWith('https://')?`<a class="btn primary" href="${esc(o.checkout_url)}" target="_blank" rel="noopener noreferrer">前往${channel[o.provider]}</a>`:''}
        ${o.state==='pending'&&o.checkout_url?.startsWith('weixin://')?`<p>微信支付链接</p><a href="${esc(o.checkout_url)}" class="btn primary">打开微信支付</a>`:''}
        <button class="btn secondary" type="button" id="refresh-payment" ${this.busy?'disabled':''}>刷新支付状态</button>${returnLink}
        <p>到账后请返回原项目继续任务。若支付结果暂未确认，请刷新状态，无需重复付款。</p><p class="muted">订单号：${esc(o.order_id)}</p><p>需要发票或支付差错处理时，请联系客服并提供订单号。</p></section></div>`:
      `<section class="credit-recharge"><div class="section-head"><div><h2>按需充值</h2><p>购入积分长期有效 · 不自动续费或充值</p></div></div>
      ${c?.enabled?`<label class="account-payment-method">支付方式 <select id="payment-provider">${c.providers.map(p=>`<option value="${p}">${channel[p]}</option>`).join('')}</select></label>`:'<p class="account-recharge-status" role="status"><span aria-hidden="true"></span>充值渠道暂未开放</p>'}
      <div class="credit-pack-grid">${(c?.packs??[]).map((p,i)=>`<article class="credit-pack ${i===1?'recommended':''}"><div class="credit-pack-heading"><span>${['轻量体验','日常项目','高频使用','团队储备'][i]}</span>${i===1?'<span class="credit-pack-badge">推荐</span>':''}</div><h3>${number(p.points)}<small> 积分</small></h3><p class="plan-price"><span>¥</span>${money(p.amount_fen)}</p><button class="btn ${i===1?'primary':'secondary'}" data-pack="${esc(p.id)}" type="button" ${!c?.enabled||this.busy?'disabled':''}>充值 ¥${money(p.amount_fen)}</button></article>`).join('')}</div></section>`}
      <div id="account-credit-history"></div><details class="billing-faq"><summary><span>积分使用说明</span><span class="billing-faq-hint">扣费、有效期与退款</span></summary><div class="billing-faq-body"><p>点击开始时核验余额并预留积分，成果可下载后扣费；失败或有效取消自动返还预留积分。任务开始后不因调价或模型用量变化补扣。</p><p>充值积分不设有效期，赠送积分按原批次有效期保留。活动积分优先使用，余额不提供现金退款。</p></div></details></div>`,'billing');
    const select=document.querySelector<HTMLSelectElement>('#payment-provider');if(provider&&select)select.value=provider;const faq=document.querySelector<HTMLDetailsElement>('.billing-faq');if(faq&&faqOpen)faq.open=true;
    const historyHost=document.querySelector<HTMLElement>('#account-credit-history');if(historyHost)this.history.mount(historyHost);
    document.querySelectorAll<HTMLButtonElement>('[data-pack]').forEach(button=>button.addEventListener('click',()=>{void this.buy(button.dataset.pack!);}));
    document.querySelector('#refresh-payment')?.addEventListener('click',()=>{void this.refresh();});
  }
  private drawCommerce(){
    const b=this.commerceBalance,c=this.commerce!,o=this.order;
    const selected=document.querySelector<HTMLSelectElement>('#payment-provider')?.value;
    const back=`<a class="btn secondary" href="${esc(this.back())}">${this.returnTo?'返回刚才的工作':this.projectId?'返回项目确认开始':'返回全部项目'}</a>`;
    const usable=!!b?.payment_enabled&&!!b.providers.length;
    this.shell(`<section class="credit-overview" aria-labelledby="account-balance-title"><h2 id="account-balance-title">服务余额</h2><p class="account-balance-value">${b?cny(b.available_fen):'—'}</p><p class="account-balance-note">可用于已确认的成果任务 · 无月费，无最低消费</p>${b?.held_fen?`<p class="credit-reservation">进行中任务已预留 ${cny(b.held_fen)}，交付结算；未交付部分释放。</p>`:''}</section><div class="account-billing-content commerce-account">${this.error?`<p class="account-billing-error" role="alert">${esc(this.error)}</p>`:''}${this.projectId||this.returnTo?`<section class="notice"><p>${this.continuity()}</p>${back}</section>`:''}${b?.legacy_balance_notice?`<p class="notice">${esc(b.legacy_balance_notice)}</p>`:''}
      ${o?`<section class="panel payment-card simple-payment"><h2>${{pending:'等待支付确认',paid:'服务余额已到账',expired:'订单已过期',failed:'支付未完成'}[o.state]}</h2><div class="payment-amount">${cny(o.amount_fen)}</div><p>实付与到账金额相同，无赠额。</p>${o.state==='pending'&&o.checkout_url?.startsWith('https://')?`<a class="btn primary" href="${esc(o.checkout_url)}" target="_blank" rel="noopener noreferrer">前往${channel[o.provider]}</a>`:o.state==='pending'&&o.checkout_url?.startsWith('weixin://')?this.nativePayment(o.checkout_url):o.state==='pending'?'<p role="status">尚未取得可用支付链接，请刷新订单状态；无需重复创建订单。</p>':''}<button class="btn secondary" type="button" id="refresh-payment" ${this.busy?'disabled':''}>刷新支付状态</button>${back}<p>订单号：${esc(o.order_id)}</p><p>需要发票或支付差错处理时，请联系客服并提供订单号。</p></section>`:`<section class="credit-recharge"><div class="section-head"><div><h2>按需充值</h2><p>输入本次所需金额，到账金额与实付相同。</p></div></div>${usable?`<form id="commerce-topup"><label class="account-payment-method">支付方式<select id="payment-provider">${b!.providers.map(p=>`<option value="${p}">${channel[p]}</option>`).join('')}</select></label><label>充值金额（元）<input id="commerce-topup-amount" inputmode="decimal" type="text" autocomplete="off" value="${esc(this.topupAmount)}" placeholder="例如 9.90" required aria-describedby="commerce-topup-help"/></label><p id="commerce-topup-help">最低0.01元，单次最高10,000元；不自动续费或充值。</p><button class="btn primary" ${this.busy?'disabled':''}>确认金额并前往支付</button></form>`:'<p class="account-recharge-status" role="status">充值渠道暂未开放。已有成果可查看下载；不会模拟支付或自动充值。</p>'}</section>`}
      ${o?.state==='paid'?'<div id="commerce-refunds"></div>':'<p class="muted">原路退款仅针对已实付且未消费的可退现金；请从充值记录查看原订单。</p>'}<div id="commerce-quotations"></div><section class="commerce-price-list" aria-labelledby="commerce-price-heading"><div class="section-head"><div><h2 id="commerce-price-heading">按成果付费</h2><p>以下为设计参考金额，不是统一成交价或最低价；当前范围报价待核实。执行前核对锁定材料、复杂度与总价，不按内部步骤加收。</p></div></div><div class="credit-pack-grid">${c.items.map(item=>`<article class="credit-pack"><div class="credit-pack-heading"><h3>${esc(item.label)}</h3><span>${item.capability==='unavailable'?'暂未开放':item.capability==='limited'?'范围受限':'标准范围'}</span></div><p class="plan-price">${item.price_fen===null?'待定':cny(item.price_fen)}<small>${item.price_fen===null?' / ':' 参考 / '}${esc(item.unit)}</small></p><details><summary>范围与包含服务</summary><ul>${item.scope.map(s=>`<li>${esc(s)}</li>`).join('')}</ul><p>包含：</p><ul>${item.included.map(s=>`<li>${esc(s)}</li>`).join('')}</ul></details></article>`).join('')}</div></section><div id="account-credit-history"></div><details class="billing-faq"><summary>收费、修正与交付规则</summary><div class="billing-faq-body">${c.rules.map(rule=>`<p>${esc(rule)}</p>`).join('')}<p>价格目录表示可报价范围，不表示全部文种、市场或真实业务内容均已完成专业验收。成果展示实际覆盖及待确认项。</p></div></details></div>`,'billing');
    const historyHost=document.querySelector<HTMLElement>('#account-credit-history');if(historyHost)this.history.mount(historyHost);
    const quotationsHost=document.querySelector<HTMLElement>('#commerce-quotations');if(quotationsHost)this.quotations.mount(quotationsHost);
    const refundsHost=document.querySelector<HTMLElement>('#commerce-refunds');if(refundsHost&&o?.state==='paid')this.refunds.mount(refundsHost,o.order_id);
    if(o?.state==='pending'&&o.checkout_url?.startsWith('weixin://'))void this.paymentQr(o.checkout_url);
    const select=document.querySelector<HTMLSelectElement>('#payment-provider');if(select&&selected&&b?.providers.includes(selected as 'wechat'|'alipay'))select.value=selected;
    document.querySelector<HTMLInputElement>('#commerce-topup-amount')?.addEventListener('input',e=>{this.topupAmount=(e.target as HTMLInputElement).value;});
    document.querySelector('#commerce-topup')?.addEventListener('submit',e=>{e.preventDefault();void this.buyCommerce();});
    document.querySelector('#refresh-payment')?.addEventListener('click',()=>void this.refresh());
  }
  private nativePayment(url:string){
    return `<div class="commerce-native-payment">${this.qr?.url===url?`<img src="${this.qr.data}" width="240" height="240" alt="本订单微信支付二维码"/>`:'<p role="status">正在生成本订单支付二维码…</p>'}<p>请使用手机微信扫一扫支付。付款后刷新本订单状态，无需重复付款。</p></div>`;
  }
  private async paymentQr(url:string){
    if(this.qr?.url===url||this.qrPending===url)return;this.qrPending=url;
    try{const data=await QRCode.toDataURL(url,{width:240,margin:2,errorCorrectionLevel:'M'});if(this.active()&&this.order?.checkout_url===url){this.qr={url,data};this.draw();}}
    catch{if(this.active()){this.error='本地支付二维码生成失败，请刷新本订单重试。';this.draw();}}
    finally{this.qrPending=undefined;}
  }
  private async buyCommerce(){
    if(this.busy||!this.commerceBalance?.payment_enabled||!this.commerceBalance.providers.length)return;
    const value=this.topupAmount.trim(),provider=document.querySelector<HTMLSelectElement>('#payment-provider')?.value as 'wechat'|'alipay';
    if(!/^\d{1,5}(?:\.\d{1,2})?$/.test(value)){this.error='请输入最多两位小数的人民币金额。';this.draw();return;}
    const amount=Math.round(Number(value)*100);if(!Number.isSafeInteger(amount)||amount<1||amount>1000000||!this.commerceBalance.providers.includes(provider)){this.error='请核对充值金额与已开放支付方式。';this.draw();return;}
    if(!this.topupRequest||this.topupRequest.amount_fen!==amount||this.topupRequest.provider!==provider)this.topupRequest={request_id:crypto.randomUUID(),amount_fen:amount,provider,...(this.projectId?{project_id:this.projectId}:{})};
    this.busy=true;this.error='';this.draw();
    try{const order=await this.api.commerceTopup(this.topupRequest,this.controller.signal);if(this.active()){const query=new URLSearchParams(rechargeHref(this.projectId).split('?')[1]);query.set('order',order.order_id);location.hash='/account?'+query;}}
    catch(error){this.error=friendlyError(error,'submit');}finally{this.busy=false;this.draw();}
  }
  private async buy(packId:string){
    if(this.busy||!this.config?.enabled)return;this.busy=true;this.error='';
    const provider=(document.querySelector<HTMLSelectElement>('#payment-provider')?.value??this.config.providers[0]) as Dto<'RechargeOrderRequest'>['provider'];
    if(!this.request||this.request.pack_id!==packId||this.request.provider!==provider)this.request={request_id:crypto.randomUUID(),pack_id:packId as Dto<'RechargeOrderRequest'>['pack_id'],provider,...(this.projectId?{project_id:this.projectId}:{})};
    this.draw();
    try{const order=await this.api.createRecharge(this.request,this.controller.signal);
      if(this.active()){const query=new URLSearchParams(rechargeHref(this.projectId).split('?')[1]);query.set('order',order.order_id);location.hash='/account?'+query;}
    }catch(e){this.error=friendlyError(e,'submit');}finally{this.busy=false;this.draw();}
  }
  private async refresh(){
    if(this.busy||!this.order)return;this.busy=true;this.error='';this.draw();
    try{if(this.commerce?.enabled){this.order=await this.api.commerceRefresh(this.order.order_id,this.controller.signal);this.commerceBalance=await this.api.commerceAccount(this.controller.signal);await this.history.refresh();}else{this.order=await this.api.refreshRecharge(this.order.order_id,this.controller.signal);this.balance=await this.api.creditBalance(this.controller.signal);await this.history.refresh();}window.dispatchEvent(new Event('bondbuddy:credits-changed'));}
    catch(e){this.error=friendlyError(e,'read');}finally{this.busy=false;this.draw();this.schedule();}
  }
  private async refreshHistory(){if(this.updatingHistory||!this.active())return;this.updatingHistory=true;try{if(this.commerce?.enabled)await Promise.all([this.history.refresh(),this.api.commerceAccount(this.controller.signal).then(b=>{this.commerceBalance=b;})]);else await Promise.all([this.history.refresh(),this.api.creditBalance(this.controller.signal).then(b=>{this.balance=b;})]);if(this.active())this.draw();}catch(e){if(this.active()){this.balance=undefined;this.commerceBalance=undefined;this.error=friendlyError(e,'read');this.draw();}}finally{this.updatingHistory=false;this.scheduleHistory();}}
  private scheduleHistory(){clearTimeout(this.historyTimer);if(this.active())this.historyTimer=setTimeout(this.onCredits,30000);}
  private schedule(){clearTimeout(this.timer);if(this.active()&&this.order?.state==='pending')this.timer=setTimeout(()=>{void this.refresh();},10000);}
}
