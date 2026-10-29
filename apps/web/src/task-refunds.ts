import {Value} from '@sinclair/typebox/value';
import {taskRefundSchemas,type TaskRefundCreate,type TaskRefundRecord,type TaskRefundEligibility} from '@bondbuddy/contracts';
import {ApiClient,friendlyError} from './api';
import {date,esc} from './ui';
import './task-refunds.css';

export const taskRefundState:Record<string,string>={requested:'待售后审核',approved:'已全部返还积分',partially_approved:'已部分返还积分',rejected:'申请未通过'};
export const taskRefundPoints=(value:string)=>BigInt(value).toLocaleString('zh-CN')+' 积分';
export function taskRefundRecordHtml(r:TaskRefundRecord){return `<article class="task-refund-record" data-task-refund-record="${esc(r.refund_request_id)}"><strong>${taskRefundState[r.state]}</strong><p>申请 ${esc(date(r.created_at))} · ${taskRefundPoints(r.requested_points)}${r.decided_at?' · 处理 '+esc(date(r.decided_at)):''}</p><p>原因：${esc(r.reason)}</p><ul>${r.items.map(i=>`<li>${esc(i.label)} · ${taskRefundPoints(i.points)}${r.state==='requested'?'':i.approved?' · 已返还':' · 未批准返还'}</li>`).join('')}</ul>${r.decision_reason?`<p>处理说明：${esc(r.decision_reason)}</p>`:''}<p>本申请已返还 ${taskRefundPoints(r.refunded_points)} · 申请编号 ${esc(r.refund_request_id)}</p></article>`;}

/** A customer selects original settled units, never an amount or a new lot. */
export class TaskRefunds{
  private controller=new AbortController();private host?:HTMLElement;private run?:string;private data?:TaskRefundEligibility;
  private selected=new Set<string>();private reason='';private error='';private message='';private loading=false;private busy=false;
  private intent?:TaskRefundCreate;private storageBlocked=false;
  constructor(private api:ApiClient,private active:()=>boolean,private owner?:string){}
  dispose(){this.controller.abort();this.host=undefined;}
  private live(run=this.run){return this.active()&&!this.controller.signal.aborted&&this.run===run;}
  private key(){if(!this.owner||!this.run)throw Error('Authenticated owner required');return 'bb-task-refund-v1:'+JSON.stringify([this.owner,this.run]);}
  private restore(){try{const raw=localStorage.getItem(this.key());this.intent=raw?JSON.parse(raw):undefined;if(this.intent&&!Value.Check(taskRefundSchemas.TaskRefundCreateRequest,this.intent))throw Error('Invalid stored task refund');if(this.intent){this.reason=this.intent.reason;this.selected=new Set(this.intent.item_ids);}this.storageBlocked=false;}catch{this.storageBlocked=true;this.error='原任务售后请求无法可靠读取，请保留任务编号并联系支持核实。';}}
  mount(host:HTMLElement,run:string){this.host=host;if(this.run!==run){this.run=run;this.data=undefined;this.loading=false;this.busy=false;this.selected.clear();this.reason='';this.message='';this.error='';this.intent=undefined;this.restore();}this.draw();if(!this.data&&!this.loading)void this.refresh();}
  async refresh(){
    if(this.loading||!this.run||!this.live())return;const run=this.run;this.loading=true;this.draw();
    try{const data=await this.api.request<TaskRefundEligibility>('GET',`/tasks/${encodeURIComponent(run)}/refund-eligibility`,undefined,{},this.controller.signal);
      if(!Value.Check(taskRefundSchemas.TaskRefundEligibilityResponse,data)||data.run_id!==run)throw Error('Invalid task refund response');
      if(this.live(run)){this.data=data;if(this.intent&&data.requests.some(r=>r.request_id===this.intent!.request_id)){this.clearIntent();this.message='原申请已受理，下方可查看处理进度。';}if(!this.storageBlocked)this.error='';}
    }catch(error){if(this.live(run))this.error=friendlyError(error,'read');}
    finally{if(this.live(run)){this.loading=false;this.draw();}}
  }
  private clearIntent(){if(!this.intent)return;const key=this.key(),raw=localStorage.getItem(key);if(raw!==JSON.stringify(this.intent))throw Error('Original task refund changed');localStorage.removeItem(key);if(localStorage.getItem(key)!==null)throw Error('Original task refund not cleared');this.intent=undefined;this.selected.clear();this.reason='';}
  private async submit(){
    if(this.busy||!this.run||this.storageBlocked)return;const run=this.run;
    const input=this.intent??{request_id:crypto.randomUUID(),item_ids:[...this.selected].sort(),reason:this.reason.trim()};
    if(!Value.Check(taskRefundSchemas.TaskRefundCreateRequest,input)||!input.reason.trim()){this.error='请选择至少一项原已结算成果，并说明质量问题。';this.draw();return;}
    try{const raw=JSON.stringify(input),key=this.key(),old=localStorage.getItem(key);if(old!==null&&old!==raw)throw Error('Existing original task refund');localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('Task refund not saved');this.intent=input;}
    catch{this.storageBlocked=true;this.error='无法保留原申请，尚未发送。请保留任务编号并联系支持。';this.draw();return;}
    this.busy=true;this.error='';this.message='正在提交原任务售后申请…';this.draw();
    try{const result=await this.api.request<TaskRefundRecord>('POST',`/tasks/${encodeURIComponent(run)}/refund-requests`,input,{},this.controller.signal);
      if(!Value.Check(taskRefundSchemas.TaskRefundRecordResponse,result)||result.run_id!==run||result.request_id!==input.request_id)throw Error('Original request mismatch');
      if(this.live(run)){this.clearIntent();this.message='已受理，审核通过后返还积分。可在本页查看进度。';await this.refresh();}
    }catch(error){if(this.live(run)){this.error=friendlyError(error,'save');this.message='结果未确认时保留原申请；可刷新核对，或重试同一申请。';}}
    finally{if(this.live(run)){this.busy=false;this.draw();}}
  }
  private draw(){
    if(!this.live()||!this.host?.isConnected)return;const d=this.data;
    this.host.innerHTML=`<section class="task-refunds" aria-label="任务质量售后"><header><h3>任务质量售后</h3><button type="button" class="text-button" data-task-refund-refresh ${this.loading||this.busy?'disabled':''}>刷新申请进度</button></header><p>按原任务已结算条目申请。审核通过后退回原来源积分，原付款对价和订阅属性保留；有限期积分至少保留 7 天可用期。此处不发起现金退款。</p>${this.loading?'<p role="status">正在核对原任务…</p>':''}${this.error?`<p role="alert">${esc(this.error)}</p>`:''}${this.message?`<p role="status">${esc(this.message)}</p>`:''}${d?`<p>${esc(d.reason)}</p><p>原扣费 ${taskRefundPoints(d.charged_points)} · 已返还 ${taskRefundPoints(d.refunded_points)}</p>${d.units.length?`<form data-task-refund-form><fieldset ${this.busy||!!this.intent||this.storageBlocked?'disabled':''}><legend>选择有质量问题的原成果</legend>${d.units.map(u=>`<label class="task-refund-unit"><input type="checkbox" data-task-refund-item="${esc(u.item_id)}" ${this.selected.has(u.item_id)?'checked':''} ${u.available_points==='0'?'disabled':''}><span>${esc(u.label)} · ${taskRefundPoints(u.charged_points)}${u.pending?' · 已有申请待审核':u.refunded_points!=='0'?' · 已返还':u.available_points==='0'?' · 暂不可申请':''}</span></label>`).join('')}<label>质量问题说明<textarea data-task-refund-reason maxlength="2000" required>${esc(this.reason)}</textarea></label></fieldset><button class="btn secondary" type="submit" ${this.busy||this.storageBlocked||(!d.enabled&&!this.intent)?'disabled':''}>${this.busy?'提交中…':this.intent?'重试原申请':'提交售后申请'}</button></form>`:''}${d.requests.length?`<h4>申请进度</h4>${d.requests.map(taskRefundRecordHtml).join('')}`:''}`:''}</section>`;
    this.host.querySelector('[data-task-refund-refresh]')?.addEventListener('click',()=>void this.refresh());
    this.host.querySelector('[data-task-refund-form]')?.addEventListener('submit',e=>{e.preventDefault();void this.submit();});
    this.host.querySelectorAll<HTMLInputElement>('[data-task-refund-item]').forEach(i=>i.addEventListener('change',()=>{if(i.checked)this.selected.add(i.dataset.taskRefundItem!);else this.selected.delete(i.dataset.taskRefundItem!);}));
    this.host.querySelector<HTMLTextAreaElement>('[data-task-refund-reason]')?.addEventListener('input',e=>{this.reason=(e.target as HTMLTextAreaElement).value;});
  }
}
