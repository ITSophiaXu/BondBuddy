import type { ApiClient, Dto } from './api';
import {isAutomaticPriceVersion} from '@bondbuddy/contracts';
import { friendlyError } from './api';
import { date, esc } from './ui';
import {cny,isCnyPrice} from './commerce';
import './credit-history.css';

type Consumption=Dto<'CreditConsumptionHistoryResponse'>['items'][number];
type Recharge=Dto<'RechargeHistoryResponse'>['items'][number];
type Kind='consumption'|'recharge';
type State<T>={items:T[];loaded:boolean;loading:boolean;cursor:string|null;error:string;appendFailed:boolean;refreshPending:boolean};
const empty=<T>():State<T>=>({items:[],loaded:false,loading:false,cursor:null,error:'',appendFailed:false,refreshPending:false});
const number=(n:number)=>n.toLocaleString('zh-CN');
const orderLabels:Record<string,string>={pending:'待支付／确认中',paid:'已到账',expired:'已关闭／过期',failed:'支付未完成'};

/** A read-only view over server history; no local ledger or payment status inference. */
export class CreditHistory {
  private controller=new AbortController();private host?:HTMLElement;private selected:Kind='consumption';
  private expanded=new Set<string>();
  private consumption=empty<Consumption>();private recharge=empty<Recharge>();
  private feedback=new Map<string,{request:Dto<'CommerceFeedbackRequest'>;busy:boolean;message:string;sent:boolean}>();
  constructor(private api:ApiClient,private active:()=>boolean,private commerceMode:()=>boolean=()=>false,private pointsMode:()=>boolean=()=>false){}
  private rememberDetails(){this.host?.querySelectorAll<HTMLElement>('[data-record]').forEach(row=>{if(row.querySelector('details')?.open)this.expanded.add(row.dataset.record!);else this.expanded.delete(row.dataset.record!);});}
  mount(host:HTMLElement){this.rememberDetails();this.host=host;this.draw();if(!this[this.selected].loaded)void this.load(this.selected);}
  dispose(){this.controller.abort();this.host=undefined;}
  async refresh(){
    const other=this.selected==='consumption'?'recharge':'consumption';this[other].loaded=false;
    if(this[other].loading)this[other].refreshPending=true;
    await this.load(this.selected);
  }
  private live(){return this.active()&&!this.controller.signal.aborted;}
  private async load(kind:Kind,append=false){
    const state=this[kind];if(state.loading){if(!append)state.refreshPending=true;return;}
    state.loading=true;state.error='';state.appendFailed=append;this.draw();
    try{
      const cursor=append?state.cursor??undefined:undefined;
      const read=(next?:string)=>kind==='consumption'?this.api.consumptionHistory(next,this.controller.signal):this.api.rechargeHistory(next,this.controller.signal);
      let result=await read(cursor);
      const fetched:Array<Consumption|Recharge>=[...result.items],seen=new Set<string>();
      // Refresh the range already opened, so auto-refresh does not collapse older pages.
      while(!append&&fetched.length<state.items.length&&result.page.next_cursor){
        if(seen.has(result.page.next_cursor))throw new Error('Repeated history cursor');
        seen.add(result.page.next_cursor);result=await read(result.page.next_cursor);fetched.push(...result.items);
      }
      if(!this.live())return;
      const key=(v:Consumption|Recharge)=>'reservation_id' in v?v.reservation_id:v.order_id;
      const items=new Map((append?state.items:[]).map(v=>[key(v),v]));for(const item of fetched)items.set(key(item),item);
      if(kind==='consumption')this.consumption.items=[...items.values()] as Consumption[];else this.recharge.items=[...items.values()] as Recharge[];state.cursor=result.page.next_cursor;state.loaded=true;
    }catch(error){if(this.live())state.error=friendlyError(error,'read');}
    finally{state.loading=false;if(this.live()){this.draw();if(state.refreshPending){state.refreshPending=false;void this.load(kind);}}}
  }
  private consumptionRow(r:Consumption){
    const commercial=isCnyPrice(r),creditPriced=isAutomaticPriceVersion(r.price_version),amount=(n:number)=>commercial&&!creditPriced?cny(n):number(n)+' 积分';
    const dynamic=!commercial&&r.billing_policy==='authoring_balance_v2';
    const status=dynamic?(r.state==='held'?'按进度扣费中':r.corrected_points?'已退回扣费':'已结算'):r.state==='held'?'预留中 · 未扣费':r.state==='released'?'已释放 · 未扣费':r.corrected_points?'已扣费 · 有冲正返还':'已扣费';
    const feedback=this.feedback.get(r.run_id);
    return `<li class="credit-history-row" data-record="${esc(r.reservation_id)}"><div><strong>${esc(r.project_name)} · ${esc(r.task_name)}</strong><p>提交 ${esc(date(r.created_at))}${r.finalized_at?` · 结算 ${esc(date(r.finalized_at))}`:''}${!commercial?' · 历史积分任务':''}</p><details ${this.expanded.has(r.reservation_id)?'open':''}><summary>任务详情</summary><p>任务编号：${esc(r.run_id)}</p>${r.project_id?`<a href="#/projects/${encodeURIComponent(r.project_id)}">查看项目</a>`:''}</details>${commercial&&r.state==='settled'&&r.charged_points>0?`<div class="commerce-feedback" data-feedback-run="${esc(r.run_id)}"><p>这次成果是否采用？</p><div>${([['adopted','已采用'],['needs_changes','原范围问题／需要修改'],['not_used','未采用']] as const).map(([outcome,label])=>`<button class="text-button" type="button" data-feedback="${outcome}" ${feedback?.busy||feedback?.sent?'disabled':''}>${label}</button>`).join('')}</div><p role="status">${esc(feedback?.message??'原范围问题可补充说明，提交后按原单核实处理。')}</p></div>`:''}</div><div class="credit-history-amount"><strong>${r.state==='held'&&!dynamic?`预留 ${amount(r.reserved_points)}`:`消耗 ${amount(r.charged_points)}`}</strong><span>${status}</span>${r.released_points?`<small>已释放 ${amount(r.released_points)}</small>`:''}${r.corrected_points?`<small>已冲正返还 ${amount(r.corrected_points)}</small>`:''}</div></li>`;
  }
  private rechargeRow(r:Recharge){
    const units=this.pointsMode()?number(r.points)+' 积分':isCnyPrice(r)?cny(r.points)+' 服务余额':number(r.points)+' 历史积分';
    return `<li class="credit-history-row" data-record="${esc(r.order_id)}"><div><strong>${r.provider==='wechat'?'微信支付':'支付宝'} · ${units}</strong><p>创建 ${esc(date(r.created_at))}${r.credited_at?` · 到账 ${esc(date(r.credited_at))}`:''}</p><p class="credit-history-order">订单号：${esc(r.order_id)}</p><a href="#/account?order=${encodeURIComponent(r.order_id)}">查看订单</a>${this.commerceMode()&&isCnyPrice(r)&&r.state==='paid'?` <a href="#/account?order=${encodeURIComponent(r.order_id)}&refund=1">原路退款与状态</a>`:''}</div><div class="credit-history-amount"><strong>${cny(r.amount_fen)}</strong><span>${orderLabels[r.state]}</span></div></li>`;
  }
  private async submitFeedback(runId:string,outcome:Dto<'CommerceFeedbackRequest'>['outcome']){
    const previous=this.feedback.get(runId);if(previous?.busy||previous?.sent)return;
    const reason=outcome==='needs_changes'?window.prompt('请说明原已确认范围内需要修正或补充的内容。提交后按原单核实处理。',''):undefined;
    if(reason===null)return;
    const request=previous?.request.outcome===outcome?previous.request:{request_id:crypto.randomUUID(),run_id:runId,outcome,...(reason?.trim()?{reason:reason.trim().slice(0,1000)}:{})};
    const state={request,busy:true,message:'正在提交反馈…',sent:false};this.feedback.set(runId,state);this.draw();
    try{await this.api.commerceFeedback(request,this.controller.signal);state.sent=true;state.message=outcome==='needs_changes'?'已收到，将按原单核实处理。':'感谢反馈，已记录。';}
    catch(error){state.message=friendlyError(error,'save')+' 可再次点击重试原反馈。';}
    finally{state.busy=false;if(this.live())this.draw();}
  }
  private draw(){
    if(!this.live()||!this.host?.isConnected)return;
    this.rememberDetails();
    const s=this[this.selected],commercial=this.commerceMode()||this.consumption.items.some(isCnyPrice)||this.recharge.items.some(isCnyPrice),title=this.pointsMode()?'任务与支付记录':commercial?'任务与充值记录':'积分记录';
    this.host.innerHTML=`<section class="credit-history" aria-label="${title}"><header><h2>${title}</h2><button class="text-button" type="button" data-history-refresh ${s.loading?'disabled':''}>刷新记录与余额</button></header><div class="credit-history-tabs" role="tablist" aria-label="积分记录类型">${(['consumption','recharge'] as const).map(k=>`<button type="button" role="tab" id="credit-tab-${k}" aria-selected="${k===this.selected}" aria-controls="credit-history-panel" data-history-tab="${k}">${k==='consumption'?(this.pointsMode()?'积分消耗记录':commercial?'任务费用记录':'积分消耗记录'):this.pointsMode()?'订阅与充值记录':'充值记录'}</button>`).join('')}</div><div role="tabpanel" id="credit-history-panel" aria-labelledby="credit-tab-${this.selected}" aria-busy="${s.loading}"><p class="credit-history-help">${this.pointsMode()?'任务消耗以积分记录；订阅及充值按实付金额展示，历史任务保留原规则。':this.selected==='consumption'?(commercial?'按任务提交时间倒序。人民币任务与历史积分任务分别按各自提交时的规则展示和结算。':'按任务提交时间倒序。动态任务按进度扣减；其他任务按提交时的计费规则结算。'):'按订单创建时间倒序。仅展示支付充值订单；各笔到账单位依该订单原规则保留。'}</p>${s.error?`<p role="alert">记录加载失败。${esc(s.error)}${s.items.length?' 以下为上次读取的记录。':''} <button type="button" class="text-button" data-history-retry>重试</button></p>`:''}${s.loading?'<p role="status">正在读取记录…</p>':''}${s.items.length?`<ul class="credit-history-list">${this.selected==='consumption'?this.consumption.items.map(r=>this.consumptionRow(r)).join(''):this.recharge.items.map(r=>this.rechargeRow(r)).join('')}</ul>`:s.loaded&&!s.loading&&!s.error?`<p class="credit-history-empty">${this.selected==='consumption'?'暂无任务消耗或预留记录':'暂无充值记录'}</p>`:''}${s.cursor?`<button type="button" class="btn secondary" data-history-more ${s.loading?'disabled':''}>加载更多记录</button>`:''}</div></section>`;
    this.host.querySelectorAll<HTMLButtonElement>('[data-history-tab]').forEach(b=>b.addEventListener('click',()=>{this.selected=b.dataset.historyTab as Kind;this.draw();if(!this[this.selected].loaded)void this.load(this.selected);}));
    this.host.querySelector('[data-history-refresh]')?.addEventListener('click',()=>window.dispatchEvent(new Event('bondbuddy:credits-changed')));
    this.host.querySelector('[data-history-retry]')?.addEventListener('click',()=>{void this.load(this.selected,this[this.selected].appendFailed);});
    this.host.querySelectorAll<HTMLButtonElement>('[data-feedback]').forEach(button=>button.addEventListener('click',()=>{const run=button.closest<HTMLElement>('[data-feedback-run]')!.dataset.feedbackRun!;void this.submitFeedback(run,button.dataset.feedback as Dto<'CommerceFeedbackRequest'>['outcome']);}));
    this.host.querySelector('[data-history-more]')?.addEventListener('click',()=>{void this.load(this.selected,true);});
  }
}
