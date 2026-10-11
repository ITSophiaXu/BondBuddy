import type { ApiClient, Dto } from './api';
import { friendlyError } from './api';
import { date, esc } from './ui';
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
  constructor(private api:ApiClient,private active:()=>boolean){}
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
    }catch(error){if(this.live())state.error=friendlyError(error);}
    finally{state.loading=false;if(this.live()){this.draw();if(state.refreshPending){state.refreshPending=false;void this.load(kind);}}}
  }
  private consumptionRow(r:Consumption){
    const dynamic=r.billing_policy==='authoring_balance_v2';
    const status=dynamic?(r.state==='held'?'按进度扣费中':r.corrected_points?'已退回扣费':'已结算'):r.state==='held'?'预留中 · 未扣费':r.state==='released'?'已释放 · 未扣费':r.corrected_points?'已扣费 · 有冲正返还':'已扣费';
    return `<li class="credit-history-row" data-record="${esc(r.reservation_id)}"><div><strong>${esc(r.project_name)} · ${esc(r.task_name)}</strong><p>提交 ${esc(date(r.created_at))}${r.finalized_at?` · 结算 ${esc(date(r.finalized_at))}`:''}</p><details ${this.expanded.has(r.reservation_id)?'open':''}><summary>任务详情</summary><p>任务编号：${esc(r.run_id)}</p>${r.project_id?`<a href="#/projects/${encodeURIComponent(r.project_id)}">查看项目</a>`:''}</details></div><div class="credit-history-amount"><strong>${r.state==='held'&&!dynamic?`预留 ${number(r.reserved_points)}`:`消耗 ${number(r.charged_points)}`} 积分</strong><span>${status}</span>${r.released_points?`<small>已释放 ${number(r.released_points)} 积分</small>`:''}${r.corrected_points?`<small>已冲正返还 ${number(r.corrected_points)} 积分</small>`:''}</div></li>`;
  }
  private rechargeRow(r:Recharge){
    return `<li class="credit-history-row" data-record="${esc(r.order_id)}"><div><strong>${r.provider==='wechat'?'微信支付':'支付宝'} · ${number(r.points)} 积分</strong><p>创建 ${esc(date(r.created_at))}${r.credited_at?` · 到账 ${esc(date(r.credited_at))}`:''}</p><p class="credit-history-order">订单号：${esc(r.order_id)}</p><a href="#/account?order=${encodeURIComponent(r.order_id)}">查看订单</a></div><div class="credit-history-amount"><strong>¥${(r.amount_fen/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong><span>${orderLabels[r.state]}</span></div></li>`;
  }
  private draw(){
    if(!this.live()||!this.host?.isConnected)return;
    this.rememberDetails();
    const s=this[this.selected];
    this.host.innerHTML=`<section class="credit-history" aria-label="积分记录"><header><h2>积分记录</h2><button class="text-button" type="button" data-history-refresh ${s.loading?'disabled':''}>刷新记录与余额</button></header><div class="credit-history-tabs" role="tablist" aria-label="积分记录类型">${(['consumption','recharge'] as const).map(k=>`<button type="button" role="tab" id="credit-tab-${k}" aria-selected="${k===this.selected}" aria-controls="credit-history-panel" data-history-tab="${k}">${k==='consumption'?'积分消耗记录':'充值记录'}</button>`).join('')}</div><div role="tabpanel" id="credit-history-panel" aria-labelledby="credit-tab-${this.selected}" aria-busy="${s.loading}"><p class="credit-history-help">${this.selected==='consumption'?'按任务提交时间倒序。动态任务按进度扣减；其他任务按提交时的计费规则结算。':'按订单创建时间倒序。仅展示支付充值订单，赠送及人工调整积分不属于充值。'}</p>${s.error?`<p role="alert">记录加载失败。${esc(s.error)}${s.items.length?' 以下为上次读取的记录。':''} <button type="button" class="text-button" data-history-retry>重试</button></p>`:''}${s.loading?'<p role="status">正在读取记录…</p>':''}${s.items.length?`<ul class="credit-history-list">${this.selected==='consumption'?this.consumption.items.map(r=>this.consumptionRow(r)).join(''):this.recharge.items.map(r=>this.rechargeRow(r)).join('')}</ul>`:s.loaded&&!s.loading&&!s.error?`<p class="credit-history-empty">${this.selected==='consumption'?'暂无积分消耗或预留记录':'暂无充值记录'}</p>`:''}${s.cursor?`<button type="button" class="btn secondary" data-history-more ${s.loading?'disabled':''}>加载更多记录</button>`:''}</div></section>`;
    this.host.querySelectorAll<HTMLButtonElement>('[data-history-tab]').forEach(b=>b.addEventListener('click',()=>{this.selected=b.dataset.historyTab as Kind;this.draw();if(!this[this.selected].loaded)void this.load(this.selected);}));
    this.host.querySelector('[data-history-refresh]')?.addEventListener('click',()=>window.dispatchEvent(new Event('bondbuddy:credits-changed')));
    this.host.querySelector('[data-history-retry]')?.addEventListener('click',()=>{void this.load(this.selected,this[this.selected].appendFailed);});
    this.host.querySelector('[data-history-more]')?.addEventListener('click',()=>{void this.load(this.selected,true);});
  }
}
