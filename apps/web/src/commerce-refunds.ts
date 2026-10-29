import {ApiClient,friendlyError} from './api';
import {cny} from './commerce';
import {date,esc} from './ui';
import {schemas,type PaymentRefund as Refund,type PaymentRefundEligibility as Eligibility,type PaymentRefundRequest} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';

const labels={requested:'申请已受理',processing:'原路退款处理中',succeeded:'已原路退款',failed:'原路退款失败'};

/** Refunds belong to an original paid cash order. Task holds/releases never enter this view. */
export class CommerceRefunds{
  private controller=new AbortController();private host?:HTMLElement;private orderId?:string;private eligibility?:Eligibility;private loading=false;private busy=false;private error='';private amount='';private request?:PaymentRefundRequest;private dialog?:HTMLDialogElement;
  private storageBlocked=false;
  constructor(private api:ApiClient,private active:()=>boolean,private owner?:string,private wholePeriod:()=>boolean=()=>false){}
  dispose(){this.controller.abort();this.dialog?.close();this.dialog?.remove();this.host=undefined;}
  private live(){return this.active()&&!this.controller.signal.aborted;}
  mount(host:HTMLElement,orderId:string){const changed=this.orderId!==orderId;this.host=host;if(changed){this.orderId=orderId;this.eligibility=undefined;this.request=undefined;this.amount='';this.error='';this.restoreIntent();}this.draw();if(!this.eligibility&&!this.loading)void this.refresh();}
  private storageKey(){if(!this.owner||!this.orderId)throw new Error('Unverified owner');return 'bb-commerce-refund-v1:'+JSON.stringify([this.owner,this.orderId]);}
  private restoreIntent(){
    try{const raw=sessionStorage.getItem(this.storageKey());if(raw!==null){const request=JSON.parse(raw);if(!Value.Check(schemas.PaymentRefundRequest,request))throw new Error('Invalid original request');this.request=request;this.amount=(request.amount_fen/100).toFixed(2);}this.storageBlocked=false;}
    catch{this.storageBlocked=true;this.error='原退款申请记录无法可靠读取，未允许另建申请。请保留当前页面并联系支持核对原订单。';}
  }
  private retainIntent(request:PaymentRefundRequest){const key=this.storageKey(),raw=JSON.stringify(request),current=sessionStorage.getItem(key);if(current!==null&&current!==raw)throw new Error('Original refund request changed');sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw new Error('Refund request not durable');}
  async refresh(){
    if(this.loading||!this.orderId||!this.live())return;this.loading=true;if(!this.storageBlocked)this.error='';this.draw();
    try{const eligibility=await this.api.request<Eligibility>('GET','/commerce/topups/'+encodeURIComponent(this.orderId)+'/refund-eligibility',undefined,{},this.controller.signal);if(!Value.Check(schemas.PaymentRefundEligibilityResponse,eligibility)||eligibility.order_id!==this.orderId||eligibility.refunds.some(refund=>refund.order_id!==this.orderId))throw new Error('Invalid original order');if(this.live()){this.eligibility=eligibility;if(this.wholePeriod()&&!this.request)this.amount=(eligibility.refundable_fen/100).toFixed(2);}}
    catch(error){if(this.live()){this.eligibility=undefined;this.error=friendlyError(error,'read');}}
    finally{this.loading=false;if(this.live())this.draw();}
  }
  private draw(){
    if(!this.live()||!this.host?.isConnected)return;const e=this.eligibility;
    this.host.innerHTML=`<section class="commerce-refunds" aria-labelledby="commerce-refund-title"><header><h2 id="commerce-refund-title">${this.wholePeriod()?'本期订阅退款':'本充值单原路退款'}</h2><button class="text-button" data-refund-eligibility-refresh ${this.loading||this.busy?'disabled':''}>刷新可退金额</button></header><p>${this.wholePeriod()?'每期付款后7天内，该期额度完全未使用且无冻结时，可申请整期退款。退款资格与结果以服务端和支付渠道核实为准。':'仅退本单已实付且尚未消费、未预留的现金余额，退回本单原支付渠道。任务预留释放是恢复服务余额，不是现金退款。'}</p>${this.loading?'<p role="status">正在核实原实付订单可退金额…</p>':''}${this.error?`<p role="alert">${esc(this.error)}</p>`:''}${e?`<dl class="commerce-money-details"><div><dt>原单金额</dt><dd>${cny(e.order_amount_fen)}</dd></div><div><dt>已核实原单实付</dt><dd>${e.paid_amount_fen===null?'实付证据待核实':cny(e.paid_amount_fen)}</dd></div><div><dt>当前可申请原路退款</dt><dd data-refundable>${cny(e.refundable_fen)}</dd></div><div><dt>退款申请中／处理中</dt><dd>${cny(e.held_refund_fen)}</dd></div><div><dt>已原路退回</dt><dd>${cny(e.refunded_fen)}</dd></div></dl>${!this.storageBlocked&&(e.enabled&&e.paid_amount_fen!==null&&e.paid_amount_fen===e.order_amount_fen&&e.refundable_fen>0||this.request)?`<form data-refund-form><label>申请退款金额（元）<input data-refund-amount inputmode="decimal" value="${esc(this.amount)}" ${this.request||this.wholePeriod()?'readonly':''} required aria-describedby="refund-amount-help"></label><p id="refund-amount-help">最多 ${cny(e.refundable_fen)}；申请受理后冻结本次退款金额，渠道确认成功后才显示已退款。</p><button class="btn secondary" ${this.busy?'disabled':''}>${this.request?'重试确认原退款申请':'核对原路退款申请'}</button></form>`:`<p role="status">${esc(e.reason||(!e.enabled?'当前原路退款渠道尚未开放。':'本单当前没有可申请原路退款的金额。'))}</p>`}${e.refunds.length?`<ul class="commerce-refund-list">${e.refunds.map(refund=>`<li data-refund="${esc(refund.refund_id)}"><strong>${cny(refund.amount_fen)} · ${labels[refund.state]}</strong><p>申请 ${esc(date(refund.created_at))}${refund.completed_at?' · 完成 '+esc(date(refund.completed_at)):''}</p><p>退款单号：${esc(refund.refund_id)}</p><p>${refund.state==='requested'?'本次申请已受理并冻结退款金额，尚未确认原路退回。':refund.state==='processing'?'正在核对原渠道结果，金额保持冻结。请刷新本退款单，不要重复申请。':refund.state==='succeeded'?'支付渠道已确认退回原支付路径。': '支付渠道已明确退款失败，退款预留会释放至服务余额；没有显示为已退款。'}</p>${refund.state==='requested'||refund.state==='processing'?`<button class="text-button" data-refund-refresh="${esc(refund.refund_id)}" ${this.busy?'disabled':''}>刷新本退款单状态</button>`:''}</li>`).join('')}</ul>`:''}`:''}</section>`;
    this.host.querySelector('[data-refund-eligibility-refresh]')?.addEventListener('click',()=>void this.refresh());
    this.host.querySelector<HTMLInputElement>('[data-refund-amount]')?.addEventListener('input',event=>this.amount=(event.target as HTMLInputElement).value);
    this.host.querySelector('[data-refund-form]')?.addEventListener('submit',event=>{event.preventDefault();this.confirm();});
    this.host.querySelectorAll<HTMLButtonElement>('[data-refund-refresh]').forEach(button=>button.addEventListener('click',()=>void this.refreshRefund(button.dataset.refundRefresh!)));
  }
  private confirm(){
    const e=this.eligibility;if(this.busy||!e||this.storageBlocked)return;
    const input=this.amount.trim(),amount=Number.isFinite(Number(input))?Math.round(Number(input)*100):NaN;
    if(!this.request&&(!e.enabled||e.paid_amount_fen===null||e.paid_amount_fen!==e.order_amount_fen||!/^\d{1,8}(?:\.\d{1,2})?$/.test(input)||!Number.isSafeInteger(amount)||amount<1||amount>1000000||amount>e.refundable_fen)){this.error='请核对已认证实付和可退金额，并输入最多两位小数的退款金额。';this.draw();return;}
    const request=this.request??{request_id:crypto.randomUUID(),amount_fen:amount};this.dialog?.remove();const d=document.createElement('dialog');this.dialog=d;d.className='commerce-confirm';d.innerHTML=`<h2>${this.request?'重试确认原退款申请':'确认原路退款申请'}</h2><p>原充值单 ${esc(e.order_id)}</p><p>本次申请 <strong>${cny(request.amount_fen)}</strong>，退回本单原支付渠道。申请受理和处理中均不表示已退款。</p><p role="status" data-refund-submit-status></p><div class="form-actions"><button class="btn secondary" data-refund-cancel>返回</button><button class="btn primary" data-refund-submit>提交本单原路退款申请</button></div>`;document.body.append(d);d.showModal();d.querySelector('[data-refund-cancel]')!.addEventListener('click',()=>d.close());d.querySelector('[data-refund-submit]')!.addEventListener('click',()=>void this.submit(request,d));
  }
  private async submit(request:PaymentRefundRequest,dialog:HTMLDialogElement){
    if(this.busy||!this.orderId||this.storageBlocked)return;
    try{this.retainIntent(request);}catch{this.storageBlocked=true;dialog.querySelector('[data-refund-submit-status]')!.textContent='无法可靠保存原退款申请，未提交。请保留页面并恢复本机存储后核对。';return;}
    this.busy=true;this.request=request;this.error='';dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=true);
    try{const refund=await this.api.request<Refund>('POST','/commerce/topups/'+encodeURIComponent(this.orderId)+'/refunds',request,{},this.controller.signal);if(!Value.Check(schemas.PaymentRefundResponse,refund)||refund.order_id!==this.orderId||refund.amount_fen!==request.amount_fen)throw new Error('Invalid refund acknowledgement');if(this.live()){try{sessionStorage.removeItem(this.storageKey());if(sessionStorage.getItem(this.storageKey())!==null)throw new Error('Cleanup not confirmed');this.request=undefined;this.amount='';}catch{this.storageBlocked=true;this.error='原退款申请已受理，但本机重试记录清理尚未确认，请核对原退款单。';}dialog.close();await this.refresh();window.dispatchEvent(new Event('bondbuddy:credits-changed'));}}
    catch(error){if(this.live()){this.error=friendlyError(error,'submit')+' 原申请结果尚未确认；请沿用同一金额和请求重试，不要另建申请。';dialog.querySelector('[data-refund-submit-status]')!.textContent=this.error;}}
    finally{this.busy=false;if(this.live()){dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=false);this.draw();}}
  }
  private async refreshRefund(refundId:string){
    if(this.busy||!this.eligibility?.refunds.some(refund=>refund.refund_id===refundId))return;this.busy=true;this.error='';this.draw();
    try{const refund=await this.api.request<Refund>('POST','/commerce/refunds/'+encodeURIComponent(refundId)+'/refresh',{}, {},this.controller.signal);if(!Value.Check(schemas.PaymentRefundResponse,refund)||refund.order_id!==this.orderId||refund.refund_id!==refundId)throw new Error('Invalid original refund');if(this.live()){await this.refresh();window.dispatchEvent(new Event('bondbuddy:credits-changed'));}}
    catch(error){if(this.live())this.error=friendlyError(error,'read')+' 保留原退款单，稍后刷新同一退款状态。';}
    finally{this.busy=false;if(this.live())this.draw();}
  }
}
