import {Value} from '@sinclair/typebox/value';
import {taskRefundSchemas,type TaskRefundDecision,type TaskRefundRecord,type TaskRefundAdminList} from '@bondbuddy/contracts';
import {ApiClient,friendlyError} from './api';
import {esc} from './ui';
import {taskRefundRecordHtml,taskRefundPoints} from './task-refunds';

/** Permission is rechecked server-side for every read and inside every approval. */
export class TaskRefundAdminPage{
  private controller=new AbortController();private records:TaskRefundRecord[]=[];private cursor:string|null=null;
  private activeRecord?:TaskRefundRecord;private selected=new Set<string>();private reason='';private intent?:TaskRefundDecision;
  private loading=false;private busy=false;private error='';private message='';private allowed=false;private storageBlocked=false;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private active:()=>boolean,private owner?:string){}
  dispose(){this.controller.abort();}
  private live(){return this.active()&&!this.controller.signal.aborted;}
  async render(){this.draw();await this.load();}
  private async load(append=false){if(this.loading)return;this.loading=true;this.draw();try{
    const query=append&&this.cursor?'?cursor='+encodeURIComponent(this.cursor):'';
    const result=await this.api.request<TaskRefundAdminList>('GET','/admin/task-refunds'+query,undefined,{},this.controller.signal);
    if(!Value.Check(taskRefundSchemas.TaskRefundAdminListResponse,result))throw Error('Invalid task refunds');
    if(this.live()){this.records=append?[...this.records,...result.items]:result.items;this.cursor=result.next_cursor;this.allowed=true;this.error='';}
  }catch(error){if(this.live()){this.allowed=false;this.error=friendlyError(error,'read');}}finally{this.loading=false;if(this.live())this.draw();}}
  private key(){if(!this.owner||!this.activeRecord)throw Error('Authenticated reviewer required');return 'bb-task-refund-decision-v1:'+JSON.stringify([this.owner,this.activeRecord.refund_request_id]);}
  private select(record:TaskRefundRecord){
    this.activeRecord=record;this.selected=new Set(record.items.map(i=>i.item_id));this.reason='';this.intent=undefined;this.storageBlocked=false;
    try{const raw=sessionStorage.getItem(this.key());if(raw){const intent=JSON.parse(raw);if(!Value.Check(taskRefundSchemas.TaskRefundDecisionRequest,intent))throw Error('Invalid original decision');this.intent=intent;this.reason=intent.reason;this.selected=new Set(intent.item_ids);}}
    catch{this.storageBlocked=true;this.error='无法可靠读取原审批请求，请保留申请编号并核对后台记录。';}
    this.draw();
  }
  private async refreshRecord(){
    if(!this.activeRecord||this.busy)return;this.busy=true;this.draw();try{
      const r=await this.api.request<TaskRefundRecord>('GET','/admin/task-refunds/'+encodeURIComponent(this.activeRecord.refund_request_id),undefined,{},this.controller.signal);
      if(!Value.Check(taskRefundSchemas.TaskRefundRecordResponse,r))throw Error('Invalid original decision');
      if(this.live()){this.activeRecord=r;if(r.state!=='requested'){sessionStorage.removeItem(this.key());this.intent=undefined;}this.error='';}
    }catch(error){this.error=friendlyError(error,'read');}finally{this.busy=false;if(this.live())this.draw();}
  }
  private async decide(reject=false){
    if(!this.activeRecord||this.busy||this.storageBlocked)return;
    const input=this.intent??{request_id:crypto.randomUUID(),item_ids:reject?[]:[...this.selected].sort(),reason:this.reason.trim()};
    if(!Value.Check(taskRefundSchemas.TaskRefundDecisionRequest,input)||!input.reason.trim()||!reject&&!this.intent&&!input.item_ids.length){this.error='请填写核实说明；批准时须选择至少一个原条目。';this.draw();return;}
    try{const raw=JSON.stringify(input),key=this.key(),old=sessionStorage.getItem(key);if(old!==null&&old!==raw)throw Error('Original decision exists');sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw Error('Decision not saved');this.intent=input;}
    catch{this.storageBlocked=true;this.error='无法保留原审批请求，尚未发送。';this.draw();return;}
    this.busy=true;this.error='';this.draw();
    try{const r=await this.api.request<TaskRefundRecord>('POST','/admin/task-refunds/'+encodeURIComponent(this.activeRecord.refund_request_id)+'/approve',input,{},this.controller.signal);
      if(!Value.Check(taskRefundSchemas.TaskRefundRecordResponse,r)||r.refund_request_id!==this.activeRecord.refund_request_id)throw Error('Original decision mismatch');
      if(this.live()){this.activeRecord=r;sessionStorage.removeItem(this.key());this.intent=undefined;this.message='审批结果和原片段返还已一并记账。';window.dispatchEvent(new Event('bondbuddy:credits-changed'));await this.load();}
    }catch(error){this.error=friendlyError(error,'save');this.message='结果未确认；刷新原申请或重试原审批，不另建扣返记录。';}
    finally{this.busy=false;if(this.live())this.draw();}
  }
  private draw(){
    if(!this.live())return;const r=this.activeRecord;
    this.shell(`<section class="task-refund-admin"><header><h1>任务售后审批</h1><a href="#/billing">返回订阅与积分</a><button type="button" class="text-button" data-task-admin-refresh ${this.loading||this.busy?'disabled':''}>刷新申请列表</button></header><p>需要独立售后审批权限。核对客户质量问题后选择批准条目；未选择的申请条目将一并拒绝。返还使用原扣费片段，不发起现金退款。</p>${this.error?`<p role="alert">${esc(this.error)}</p>`:''}${this.message?`<p role="status">${esc(this.message)}</p>`:''}${this.loading?'<p role="status">正在读取售后申请…</p>':''}${this.allowed?`<div class="task-refund-admin-columns"><section aria-label="申请列表">${this.records.length?this.records.map(x=>`<article>${taskRefundRecordHtml(x)}<button class="text-button" type="button" data-task-admin-open="${esc(x.refund_request_id)}" ${this.busy?'disabled':''}>查看／处理申请</button></article>`).join(''):'<p>暂无售后申请。</p>'}${this.cursor?`<button type="button" data-task-admin-more ${this.loading?'disabled':''}>加载更多</button>`:''}</section><section aria-label="审批详情">${r?`${taskRefundRecordHtml(r)}<button class="text-button" type="button" data-task-admin-detail-refresh ${this.busy?'disabled':''}>刷新本申请</button>${r.state==='requested'?`<form data-task-admin-form><fieldset ${this.busy||!!this.intent||this.storageBlocked?'disabled':''}><legend>批准返还的原条目</legend>${r.items.map(i=>`<label class="task-refund-unit"><input type="checkbox" data-task-admin-item="${esc(i.item_id)}" ${this.selected.has(i.item_id)?'checked':''}><span>${esc(i.label)} · ${taskRefundPoints(i.points)}</span></label>`).join('')}<label>核实及处理说明<textarea data-task-admin-reason required maxlength="2000">${esc(this.reason)}</textarea></label></fieldset><button type="submit" class="btn primary" ${this.busy||this.storageBlocked?'disabled':''}>${this.intent?'重试原审批':'批准所选并结案'}</button> <button type="button" class="btn secondary" data-task-admin-reject ${this.busy||!!this.intent||this.storageBlocked?'disabled':''}>拒绝本申请</button></form>`:''}`:'<p>请选择一份申请查看原条目及质量问题。</p>'}</section></div>`:''}</section>`,'billing');
    document.querySelector('[data-task-admin-refresh]')?.addEventListener('click',()=>void this.load());
    document.querySelector('[data-task-admin-more]')?.addEventListener('click',()=>void this.load(true));
    document.querySelectorAll<HTMLButtonElement>('[data-task-admin-open]').forEach(b=>b.addEventListener('click',()=>{const r=this.records.find(x=>x.refund_request_id===b.dataset.taskAdminOpen);if(r)this.select(r);}));
    document.querySelector('[data-task-admin-detail-refresh]')?.addEventListener('click',()=>void this.refreshRecord());
    document.querySelector('[data-task-admin-form]')?.addEventListener('submit',e=>{e.preventDefault();void this.decide();});
    document.querySelector('[data-task-admin-reject]')?.addEventListener('click',()=>void this.decide(true));
    document.querySelectorAll<HTMLInputElement>('[data-task-admin-item]').forEach(i=>i.addEventListener('change',()=>{if(i.checked)this.selected.add(i.dataset.taskAdminItem!);else this.selected.delete(i.dataset.taskAdminItem!);}));
    document.querySelector<HTMLTextAreaElement>('[data-task-admin-reason]')?.addEventListener('input',e=>{this.reason=(e.target as HTMLTextAreaElement).value;});
  }
}
