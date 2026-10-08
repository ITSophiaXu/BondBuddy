import { ApiClient, friendlyError, type Dto } from './api';
import { esc } from './ui';
import '../../../product-prototype/public/credits.css';

const number=(n:number)=>n.toLocaleString('zh-CN');
const money=(n:number)=>(n/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
const channel={wechat:'微信支付',alipay:'支付宝'};
/** Reuses the prototype credit overview, pack grid and single-order payment card. */
export class BillingPage {
  private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;
  private busy=false;private balance?:Dto<'CreditBalanceResponse'>;private config?:Dto<'RechargeConfigResponse'>;
  private quote?:Dto<'FixedQuoteResponse'>;private order?:Dto<'RechargeOrderResponse'>;private error='';
  private request?:Dto<'RechargeOrderRequest'>;private reviewProject=false;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private active:()=>boolean,
    private projectId?:string,private orderId?:string){}
  dispose(){this.controller.abort();clearTimeout(this.timer);}
  async render(){
    this.shell('<p role="status">正在读取积分…</p>','billing');
    try{
      [this.balance,this.config]=await Promise.all([this.api.creditBalance(this.controller.signal),this.api.rechargeConfig(this.controller.signal)]);
      if(this.orderId){this.order=await this.api.rechargeOrder(this.orderId,this.controller.signal);this.projectId=this.order.project_id??this.projectId;}
      if(this.projectId){const p=await this.api.project(this.projectId,this.controller.signal);
        this.reviewProject=p.kind==='review';
        if(!this.reviewProject&&p.input_revision&&p.input_hash)this.quote=await this.api.creditQuote(p.project_id,{input_revision:p.input_revision,input_hash:p.input_hash},this.controller.signal);}
    }catch(e){this.error=friendlyError(e);}
    if(this.active()){this.draw();this.schedule();}
  }
  private back(){return this.projectId?`#/projects/${encodeURIComponent(this.projectId)}${this.reviewProject?'/review?tab=materials':'?step=materials'}`:'#dashboard';}
  private draw(){
    if(!this.active())return;
    const b=this.balance,c=this.config,o=this.order;
    const shortage=Math.max(0,(this.quote?.quote?.points??0)-(b?.available??0));
    const returnLink=`<a class="btn secondary" href="${this.back()}">${this.projectId?'返回项目确认开始':'返回工作台'}</a>`;
    const context=this.projectId?`<section class="notice"><span>${this.quote?.quote?`本次任务需要 ${number(this.quote.quote.points)} 积分，当前可用 ${number(b?.available??0)} 积分${shortage?`，还差 ${number(shortage)} 积分`:'，已足够开始'}。`:'项目材料与补充说明已保留。'}充值到账不会自动开始任务。</span>${returnLink}</section>`:'';
    this.shell(`<section class="credit-overview" aria-labelledby="account-balance-title"><h2 id="account-balance-title">可用积分</h2><p class="account-balance-value">${b?number(b.available):'—'}<span>积分</span></p><p class="account-balance-note">上传、保存项目和下载已有成果免费</p>${b && b.frozen > 0 ? `<p class="credit-reservation">进行中任务预留 <strong>${number(b.frozen)}</strong> 积分<span>已从可用积分中预留，成功后扣除，失败或取消后返还。</span></p>` : ''}</section>
      <div class="account-billing-content">${this.error?`<p class="account-billing-error" role="alert">${esc(this.error)}</p>`:''}${context}
      ${o?`<div class="simple-payment-wrap"><section class="panel payment-card simple-payment"><span class="eyebrow">CREDIT RECHARGE</span><h2>${{pending:'等待支付确认',paid:'积分已到账',expired:'订单已过期',failed:'支付未完成'}[o.state]}</h2><p>${number(o.points)} 积分</p><div class="payment-amount">¥${money(o.amount_fen)}</div>
        ${o.state==='pending'&&o.checkout_url?.startsWith('https://')?`<a class="btn primary" href="${esc(o.checkout_url)}" target="_blank" rel="noopener noreferrer">前往${channel[o.provider]}</a>`:''}
        ${o.state==='pending'&&o.checkout_url?.startsWith('weixin://')?`<p>微信支付链接</p><a href="${esc(o.checkout_url)}" class="btn primary">打开微信支付</a>`:''}
        <button class="btn secondary" type="button" id="refresh-payment" ${this.busy?'disabled':''}>刷新支付状态</button>${returnLink}
        <p>到账后请返回原项目确认开始。若支付结果暂未确认，请刷新状态，无需重复付款。</p><p class="muted">订单号：${esc(o.order_id)}</p><p>需要发票或支付差错处理时，请联系客服并提供订单号。</p></section></div>`:
      `<section class="credit-recharge"><div class="section-head"><div><h2>按需充值</h2><p>购入积分长期有效 · 不自动续费或充值</p></div></div>
      ${c?.enabled?`<label class="account-payment-method">支付方式 <select id="payment-provider">${c.providers.map(p=>`<option value="${p}">${channel[p]}</option>`).join('')}</select></label>`:'<p class="account-recharge-status" role="status"><span aria-hidden="true"></span>充值渠道暂未开放</p>'}
      <div class="credit-pack-grid">${(c?.packs??[]).map((p,i)=>`<article class="credit-pack ${i===1?'recommended':''}"><div class="credit-pack-heading"><span>${['轻量体验','日常项目','高频使用','团队储备'][i]}</span>${i===1?'<span class="credit-pack-badge">推荐</span>':''}</div><h3>${number(p.points)}<small> 积分</small></h3><p class="plan-price"><span>¥</span>${money(p.amount_fen)}</p><button class="btn ${i===1?'primary':'secondary'}" data-pack="${esc(p.id)}" type="button" ${!c?.enabled||this.busy?'disabled':''}>充值 ¥${money(p.amount_fen)}</button></article>`).join('')}</div></section>`}
      <details class="billing-faq"><summary><span>积分使用说明</span><span class="billing-faq-hint">扣费、有效期与退款</span></summary><div class="billing-faq-body"><p>开始前展示任务类型、固定积分价和可用余额。确认后预留本次积分，成果可下载后扣费；失败或有效取消自动返还预留积分。任务开始后不因调价或模型用量变化补扣。</p><p>充值积分不设有效期，赠送积分按原批次有效期保留。活动积分优先使用，余额不提供现金退款。</p></div></details></div>`,'billing');
    document.querySelectorAll<HTMLButtonElement>('[data-pack]').forEach(button=>button.addEventListener('click',()=>{void this.buy(button.dataset.pack!);}));
    document.querySelector('#refresh-payment')?.addEventListener('click',()=>{void this.refresh();});
  }
  private async buy(packId:string){
    if(this.busy||!this.config?.enabled)return;this.busy=true;this.error='';
    const provider=(document.querySelector<HTMLSelectElement>('#payment-provider')?.value??this.config.providers[0]) as Dto<'RechargeOrderRequest'>['provider'];
    if(!this.request||this.request.pack_id!==packId||this.request.provider!==provider)this.request={request_id:crypto.randomUUID(),pack_id:packId as Dto<'RechargeOrderRequest'>['pack_id'],provider,...(this.projectId?{project_id:this.projectId}:{})};
    this.draw();
    try{const order=await this.api.createRecharge(this.request,this.controller.signal);
      if(this.active())location.hash=`/account?order=${encodeURIComponent(order.order_id)}`;
    }catch(e){this.error=friendlyError(e);}finally{this.busy=false;this.draw();}
  }
  private async refresh(){
    if(this.busy||!this.order)return;this.busy=true;this.error='';this.draw();
    try{this.order=await this.api.refreshRecharge(this.order.order_id,this.controller.signal);this.balance=await this.api.creditBalance(this.controller.signal);}
    catch(e){this.error=friendlyError(e);}finally{this.busy=false;this.draw();this.schedule();}
  }
  private schedule(){clearTimeout(this.timer);if(this.active()&&this.order?.state==='pending')this.timer=setTimeout(()=>{void this.refresh();},10000);}
}
