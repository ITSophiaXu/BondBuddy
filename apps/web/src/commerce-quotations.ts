import {int64,formatPoints} from '@bondbuddy/contracts';
import {ApiClient,friendlyError,type Dto} from './api';
import {cny,scopeStatus,scopeStatusLabel,scopeLinesHtml} from './commerce';
import {date,esc} from './ui';
import {schemas,isAutomaticPriceVersion} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';

type Quotation=Dto<'CommerceScopeQuotationsResponse'>['items'][number];
type Intent={request_id:string;reason?:string};
const actionLabels:Record<string,string>={authoring:'募集书编制／更新',review:'募集书复核／修订',m4_document:'关联文件编制',m4_qa:'问题回复',project_qa_answer:'问题回复',project_file_check:'一致性检查',project_file_patch:'关联文件修订',integrity_round:'诚信核查',prospectus_first_draft:'募集书首稿',prospectus_period_update:'募集书更新',prospectus_local_revision:'局部修订',linked_document_generation:'关联文件编制',linked_consistency_check:'一致性检查',linked_document_sync:'关联文件同步',substantive_review:'独立实质复核',question_answer:'问题回复',integrity_check:'诚信核查'};

/** Quotations are account-owned server records; this view never starts a task or reserves money. */
export class CommerceQuotations{
  private controller=new AbortController();private host?:HTMLElement;private items:Quotation[]=[];private loaded=false;private loading=false;private error='';private busy?:string;
  private expanded=new Set<string>();private feedback=new Map<string,string>();private intents=new Map<string,Intent>();private dialog?:HTMLDialogElement;
  private selected=new URLSearchParams(location.hash.split('?')[1]).get('quotation');
  constructor(private api:ApiClient,private active:()=>boolean,private readOnly=false){}
  private amount(q:Quotation){return isAutomaticPriceVersion(q.price_version)?formatPoints(q.amount_fen)+' 积分':cny(q.amount_fen);}
  dispose(){this.controller.abort();this.dialog?.close();this.dialog?.remove();this.host=undefined;}
  mount(host:HTMLElement){this.remember();this.host=host;this.draw();if(!this.loaded&&!this.loading)void this.refresh();}
  private live(){return this.active()&&!this.controller.signal.aborted;}
  private remember(){this.host?.querySelectorAll<HTMLDetailsElement>('[data-quotation-details]').forEach(detail=>{if(detail.open)this.expanded.add(detail.dataset.quotationDetails!);else this.expanded.delete(detail.dataset.quotationDetails!);});}
  async refresh(){
    if(this.loading||!this.live())return;this.loading=true;this.error='';this.draw();
    try{
      const result=await this.api.request<Dto<'CommerceScopeQuotationsResponse'>>('GET','/commerce/quotations',undefined,{},this.controller.signal);
      if(!Value.Check(schemas.CommerceScopeQuotationsResponse,result))throw new Error('Invalid quotation list');
      if(this.live()){this.items=result.items;this.loaded=true;}
    }catch(error){if(this.live())this.error=friendlyError(error,'read');}
    finally{this.loading=false;if(this.live())this.draw();}
  }
  private row(q:Quotation){
    const status=scopeStatus(q),included=status==='ready'&&int64(q.amount_fen)===0n,closed=['expired','unavailable','declined'].includes(status??'');
    return `<article class="commerce-quotation" data-quotation="${esc(q.id)}"><header><div><h3>${esc(actionLabels[q.action]??'项目范围报价')}</h3><span class="commerce-state" data-quote-state="${esc(status)}">${esc(scopeStatusLabel(q))}</span></div><strong>${included?'原范围包含／已购覆盖':q.published_at?this.amount(q):'金额待核'}</strong></header><p>项目 ${esc(q.project_id)} · 报价版本 ${q.revision} · 创建 ${esc(date(q.created_at))}</p>${q.expires_at?`<p>有效至 ${esc(date(q.expires_at))}</p>`:''}${q.reason?`<p>${esc(q.reason)}</p>`:''}${q.closure_reason?`<p>${esc(q.closure_reason)}</p>`:''}<p>${this.readOnly?'此处保留任务范围与报价历史；是否已执行或结算，请查看任务记录和积分明细。':status==='pending_scope'?'待报价不收费，准备材料与要求保留。':status==='ready'?included?'本次为原范围包含／已购覆盖，无需充值或新增预留。请返回原工作核对范围后继续。':'尚未开始、尚未扣费。请返回原工作核对材料版本后明确开始。':status==='unavailable'?'当前范围暂无法承接，未开始、未扣费；可保留准备退出，或重新申请报价。':status==='declined'?'已拒绝本报价，未开始、未扣费；原准备仍保留。':'本报价已过期，不能开始；原准备仍保留。'}</p><details data-quotation-details="${esc(q.id)}" ${this.expanded.has(q.id)?'open':''}><summary>查看报价范围与明细</summary>${scopeLinesHtml(q)}<p>报价编号：${esc(q.id)}</p>${q.price_version?`<p>计价规则版本：${esc(q.price_version)}</p>`:''}<p>固定范围标识：${esc(q.input_hash)}</p>${q.previous_quote_id?`<p>上一报价：${esc(q.previous_quote_id)}</p>`:''}${q.decline_reason?`<p>拒价反馈：${esc(q.decline_reason)}</p>`:''}</details><div class="form-actions">${!this.readOnly&&status==='ready'?`<button class="btn secondary" data-decline-quote="${esc(q.id)}" ${this.busy?'disabled':''}>不接受报价／反馈</button>`:''}${!this.readOnly&&closed?`<button class="btn secondary" data-requote="${esc(q.id)}" ${this.busy?'disabled':''}>重新申请范围报价</button>`:''}<a class="text-button" href="#/projects/${encodeURIComponent(q.project_id)}">返回项目</a></div><p role="status">${esc(this.feedback.get(q.id)??'')}</p></article>`;
  }
  private draw(){
    if(!this.live()||!this.host?.isConnected)return;this.remember();if(this.selected&&this.items.some(q=>q.id===this.selected)){this.expanded.add(this.selected);this.selected=null;}
    this.host.innerHTML=`<section class="commerce-quotations" aria-labelledby="commerce-quotations-title"><header><div><h2 id="commerce-quotations-title">我的范围报价</h2><p>查看状态、工作项和历史版本。不接受报价不扣钱，退出后准备材料保留。</p></div><button class="text-button" data-quotations-refresh ${this.loading?'disabled':''}>刷新报价</button></header>${this.error?`<p role="alert">报价读取失败。${esc(this.error)}${this.items.length?' 以下为上次读取的记录。':''}</p>`:''}${this.loading?'<p role="status">正在读取范围报价…</p>':''}${this.items.map(q=>this.row(q)).join('')}${this.loaded&&!this.items.length?'<p>暂无范围报价。请从项目准备材料并申请核实本次范围。</p>':''}</section>`;
    this.host.querySelector('[data-quotations-refresh]')?.addEventListener('click',()=>void this.refresh());
    this.host.querySelectorAll<HTMLButtonElement>('[data-decline-quote]').forEach(button=>button.addEventListener('click',()=>this.decline(this.items.find(q=>q.id===button.dataset.declineQuote)!)));
    this.host.querySelectorAll<HTMLButtonElement>('[data-requote]').forEach(button=>button.addEventListener('click',()=>void this.requote(this.items.find(q=>q.id===button.dataset.requote)!)));
  }
  private decline(q:Quotation){
    if(this.busy||scopeStatus(q)!=='ready')return;this.dialog?.remove();const d=document.createElement('dialog');this.dialog=d;d.className='commerce-confirm';d.innerHTML=`<h2>不接受本报价</h2><p>报价 ${esc(q.id)} · ${this.amount(q)}。拒绝后不会开始或扣费，项目准备保留。</p><form><label>反馈原因<textarea name="reason" required maxlength="1000" rows="4" placeholder="例如：当前范围过大，希望缩小工作项"></textarea></label><p role="status" data-decline-status></p><div class="form-actions"><button class="btn secondary" type="button" data-cancel>保留报价并返回</button><button class="btn primary" type="submit">提交反馈并退出报价</button></div></form>`;document.body.append(d);d.showModal();d.querySelector('[data-cancel]')!.addEventListener('click',()=>d.close());
    d.querySelector('form')!.addEventListener('submit',event=>{event.preventDefault();const reason=d.querySelector<HTMLTextAreaElement>('textarea')!.value.trim();if(!reason)return;void this.submitDecline(q,reason,d);});
  }
  private async submitDecline(q:Quotation,reason:string,d:HTMLDialogElement){
    if(this.busy||scopeStatus(q)!=='ready')return;
    const key='decline:'+q.id,existing=this.intents.get(key);if(existing&&existing.reason!==reason){d.querySelector('[data-decline-status]')!.textContent='上次反馈结果尚未确认，请沿用原内容重试。';return;}
    const request=existing??{request_id:crypto.randomUUID(),reason};this.intents.set(key,request);this.busy=key;d.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=true);d.querySelector<HTMLTextAreaElement>('textarea')!.readOnly=true;
    try{const result=await this.api.request<Dto<'CommerceScopeQuotationResponse'>>('POST','/commerce/quotations/'+encodeURIComponent(q.id)+'/decline',request,{},this.controller.signal);if(!Value.Check(schemas.CommerceScopeQuotationResponse,result)||result.quotation.id!==q.id||result.quotation.project_id!==q.project_id||result.quotation.input_hash!==q.input_hash||result.quotation.quote_status!=='declined')throw new Error('Invalid original quotation');if(this.live()){this.items=this.items.map(item=>item.id===q.id?result.quotation:item);this.intents.delete(key);this.feedback.set(q.id,'已记录拒价反馈。本报价未开始、未扣费，准备材料保留。');d.close();}}
    catch(error){if(this.live()){d.querySelector('[data-decline-status]')!.textContent=friendlyError(error,'save')+' 结果尚未确认，可沿用原内容重试。';}}
    finally{this.busy=undefined;if(this.live()){d.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=false);this.draw();}}
  }
  private async requote(q:Quotation){
    if(this.busy||!['expired','unavailable','declined'].includes(scopeStatus(q)??''))return;
    const key='requote:'+q.id,request=this.intents.get(key)??{request_id:crypto.randomUUID()};this.intents.set(key,request);this.busy=key;this.draw();
    try{const result=await this.api.request<Dto<'CommerceScopeQuotationResponse'>>('POST','/commerce/quotations/'+encodeURIComponent(q.id)+'/requote',request,{},this.controller.signal);if(!Value.Check(schemas.CommerceScopeQuotationResponse,result)||result.quotation.project_id!==q.project_id||result.quotation.previous_quote_id!==q.id)throw new Error('Invalid new quotation');if(this.live()){this.intents.delete(key);this.feedback.set(q.id,'已保留原报价并申请新版本，核实期间不收费。');this.expanded.add(result.quotation.id);await this.refresh();}}
    catch(error){if(this.live())this.feedback.set(q.id,friendlyError(error,'save')+' 可重试同一申请。');}
    finally{this.busy=undefined;if(this.live())this.draw();}
  }
}
