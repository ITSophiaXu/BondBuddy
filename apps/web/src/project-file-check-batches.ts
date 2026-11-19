import {taskRestartHtml,onTaskRestart} from './task-restart.js';
import {Value} from '@sinclair/typebox/value';
import {projectFileCheckBatchSchemas,int64,serializeInt64,formatPoints,type FileCheckBatch,type FileCheckBatchCreate,type FileCheckBatchRetry,type FileCheckBatchQuote,type ProjectFileSource} from '@bondbuddy/contracts';
import {ApiClient,ApiError,friendlyError} from './api';
import {esc} from './ui';
import {runStateLabel} from './review-state';
import {billingTaskRechargeHrefForRequest} from './billing-task-recovery';
import {UserFacingError} from './user-facing-error';
import './project-file-check-batches.css';
type Pending={kind:'create';body:FileCheckBatchCreate;state:'attempting'|'needs_funds'|'unknown'}|{kind:'retry';batch_id:string;body:FileCheckBatchRetry;state:'attempting'|'needs_funds'|'unknown'};
const retryable=['failed','cancelled','rejected'];
export class FileCheckBatches{
  private abort=new AbortController();private host?:HTMLElement;private timer?:ReturnType<typeof setTimeout>;private batches:FileCheckBatch[]=[];
  private busy=false;private loading=false;private loaded=false;private error='';private pending?:Pending;private storageBlocked=false;
  private completed?:{request_id:string;batch_id:string};private observedCompletion?:string;
  private fundingHref?:string;
  constructor(private api:ApiClient,private active:()=>boolean,private project:string,private owner:string|undefined,private changed:()=>void){onTaskRestart(this.abort.signal,()=>this.refresh());
    this.restore();
  }
  get hasUnconfirmed(){return this.busy||!!this.pending&&this.pending.state!=='needs_funds';}
  get hasPending(){return !!this.pending;}
  dispose(){this.abort.abort();clearTimeout(this.timer);}
  private live(){return this.active()&&!this.abort.signal.aborted;}
  private key(){if(!this.owner)throw Error('Missing owner');return 'bondbuddy:file-check-batch:v1:'+JSON.stringify([this.owner,this.project]);}
  private base(){return '/projects/'+encodeURIComponent(this.project)+'/project-files/check-batches';}
  private async refreshFundingHref(){
    const pending=this.pending;
    const href=pending?.state==='needs_funds'?await billingTaskRechargeHrefForRequest(this.owner,this.base()+(pending.kind==='retry'?'/'+encodeURIComponent(pending.batch_id)+'/retry':''),pending.body):undefined;
    if(this.pending===pending)this.fundingHref=href;
  }
  private restore(){
    try{const raw=localStorage.getItem(this.key());this.pending=undefined;this.completed=undefined;
      if(raw){const saved=JSON.parse(raw);if(saved.owner!==this.owner||saved.project!==this.project||saved.pending&&(!['attempting','needs_funds','unknown'].includes(saved.pending.state)||
        !(saved.pending.kind==='create'&&Value.Check(projectFileCheckBatchSchemas.FileCheckBatchCreateRequest,saved.pending.body)||saved.pending.kind==='retry'&&typeof saved.pending.batch_id==='string'&&Value.Check(projectFileCheckBatchSchemas.FileCheckBatchRetryRequest,saved.pending.body)))||
        saved.completed&&(typeof saved.completed.request_id!=='string'||typeof saved.completed.batch_id!=='string'))throw Error('Invalid saved request');this.pending=saved.pending;this.completed=saved.completed;}
      this.storageBlocked=false;
    }catch{this.storageBlocked=true;this.error='无法可靠读取原逐份检查请求，请保留页面并联系支持核对。';}
  }
  private persist(){try{const key=this.key(),raw=JSON.stringify({owner:this.owner,project:this.project,pending:this.pending,completed:this.completed});localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('Not persisted');}catch{this.storageBlocked=true;throw new UserFacingError('无法可靠保存原请求，未创建新的检查或重试。');}}
  private async serialized(work:()=>Promise<void>){
    if(!navigator.locks)throw new UserFacingError('当前浏览器不支持防重复请求保护，请使用最新版 Edge、Chrome 或 Firefox 继续原检查。');
    const observed=this.observedCompletion;
    await navigator.locks.request(this.key(),async()=>{this.restore();if(this.storageBlocked)throw new UserFacingError(this.error);
      if(!this.pending&&this.completed?.request_id!==observed&&this.completed){await this.refresh();this.changed();return;}
      await work();
    });
  }
  mount(host:HTMLElement){this.host=host;this.draw();if(!this.loaded&&!this.loading)void this.refresh();}
  async refresh(){
    if(!this.live()||this.loading)return;this.loading=true;
    try{const result=await this.api.request<{batches:FileCheckBatch[]}>('GET',this.base(),undefined,{},this.abort.signal);
      if(!Value.Check(projectFileCheckBatchSchemas.FileCheckBatchListResponse,result))throw Error('Invalid file batch response');
      // A saved retry/receipt may refer to a batch older than the recent-30 list.
      // Load that exact owned batch instead of abandoning the original request.
      const originalIds=[this.pending?.kind==='retry'?this.pending.batch_id:undefined,this.completed?.batch_id].filter((id):id is string=>!!id);
      for(const batchId of new Set(originalIds))if(!result.batches.some(b=>b.batch_id===batchId)){
        const original=await this.api.request<FileCheckBatch>('GET',this.base()+'/'+encodeURIComponent(batchId),undefined,{},this.abort.signal);
        if(!Value.Check(projectFileCheckBatchSchemas.FileCheckBatchResponse,original)||original.batch_id!==batchId)throw Error('Invalid original batch');
        result.batches.unshift(original);
      }
      if(this.live()){
        const pending=this.pending;
        const accepted=pending?.kind==='create'?result.batches.find(b=>b.request_id===pending.body.request_id&&b.source.version_id===pending.body.expected_source_version_id&&b.source.selection_revision===pending.body.expected_source_selection_revision&&b.items.length===pending.body.file_version_ids.length&&b.items.every(i=>pending.body.file_version_ids.includes(i.file_version_id))):undefined;
        if(accepted&&pending){this.completed={request_id:pending.body.request_id,batch_id:accepted.batch_id};this.pending=undefined;this.persist();}
        this.batches=result.batches;this.loaded=true;if(this.completed&&result.batches.some(b=>b.batch_id===this.completed!.batch_id))this.observedCompletion=this.completed.request_id;if(!this.storageBlocked)this.error='';}}
    catch(e){if(this.live())this.error=friendlyError(e,'read');}
    finally{this.loading=false;await this.refreshFundingHref();this.draw();clearTimeout(this.timer);if(this.live())this.timer=setTimeout(()=>void this.refresh(),15000);}
  }
  async start(source:ProjectFileSource,versions:string[]){
    if(this.busy||this.storageBlocked||!this.owner)return;
    this.busy=true;this.error='';this.draw();
    try{await this.serialized(async()=>{
      if(!this.pending){const selection={request_id:crypto.randomUUID(),expected_source_version_id:source.version_id,expected_source_selection_revision:source.selection_revision,file_version_ids:versions};
        const quote=await this.api.request<FileCheckBatchQuote>('POST',this.base()+'/quote',selection,{},this.abort.signal);
        if(!Value.Check(projectFileCheckBatchSchemas.FileCheckBatchQuoteResponse,quote)||quote.source.version_id!==source.version_id||quote.source.selection_revision!==source.selection_revision||quote.items.length!==versions.length||quote.items.some(i=>!versions.includes(i.file_version_id)||i.quote_status!=='ready'))throw Error('逐份检查范围尚未确认，请刷新后重新查看。');
        this.pending={kind:'create',state:'attempting',body:{...selection,file_version_ids:quote.items.map(i=>i.file_version_id),expected_points:quote.points,price_version:quote.price_version,scopes:quote.items.map(i=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))}};
      }
      await this.submit();});
    }catch(e){if(this.live())this.error=friendlyError(e,'submit');}
    finally{this.busy=false;await this.refreshFundingHref();this.draw();}
  }
  private async retry(batch:FileCheckBatch){
    if(this.busy||this.storageBlocked)return;this.busy=true;this.error='';this.draw();
    try{await this.serialized(async()=>{if(!this.pending){const items=batch.items.filter(i=>retryable.includes(i.state));this.pending={kind:'retry',batch_id:batch.batch_id,state:'attempting',body:{request_id:crypto.randomUUID(),price_version:batch.price_version,expected_points:serializeInt64(items.reduce((sum,i)=>int64(sum+int64(i.points)),0n)),expected_attempts:items.map(i=>({file_version_id:i.file_version_id,run_id:i.run_id}))}};}await this.submit();});}
    catch(e){if(this.live())this.error=friendlyError(e,'submit');}finally{this.busy=false;await this.refreshFundingHref();this.draw();}
  }
  private async submit(){
    const request=this.pending!;request.state='attempting';this.persist();
    try{const result=await this.api.request<FileCheckBatch>('POST',this.base()+(request.kind==='retry'?'/'+encodeURIComponent(request.batch_id)+'/retry':''),request.body,{},this.abort.signal);
      if(!Value.Check(projectFileCheckBatchSchemas.FileCheckBatchResponse,result)||request.kind==='create'&&result.request_id!==request.body.request_id||request.kind==='retry'&&result.batch_id!==request.batch_id)throw Error('Invalid original batch receipt');
      this.completed={request_id:request.body.request_id,batch_id:result.batch_id};this.pending=undefined;this.persist();await this.refresh();this.changed();}
    catch(e){if(e instanceof ApiError&&(e.status>=400&&e.status<500&&![402,408,409,429].includes(e.status)||e.status===409&&['QUOTE_CHANGED','QUOTE_EXPIRED','INPUT_REVISION_CONFLICT','PROJECT_RUN_ACTIVE'].includes(e.code))){this.pending=undefined;this.persist();}else{request.state=e instanceof ApiError&&e.status===402?'needs_funds':'unknown';this.persist();}throw e;}
  }
  private draw(){
    if(!this.live()||!this.host?.isConnected)return;
    this.host.innerHTML=`${this.error?`<p role="alert">${esc(this.error)}</p>`:''}${this.pending?`<section class="notice"><p>${this.pending.state==='needs_funds'?'积分不足，原文件范围和价格已保存，尚未开始。':'原逐份检查请求仍待核对，继续时沿用原请求。'}</p><button class="btn secondary" data-file-check-pending ${this.busy||this.storageBlocked?'disabled':''}>继续原检查请求</button>${this.pending.state==='needs_funds'&&this.fundingHref?` <a class="text-button" data-file-check-funding href="${esc(this.fundingHref)}">查看积分与支付状态</a>`:''}</section>`:''}
      ${this.batches.map(batch=>`<section class="panel file-check-batch" data-file-check-batch="${esc(batch.batch_id)}"><header><h2>${{queued:'逐份检查已受理',running:'正在逐份检查',complete:'本批检查已完成',partial:'本批部分文件已完成',failed:'本批文件尚未完成'}[batch.state]}</h2><button class="text-button" data-file-check-refresh ${this.loading?'disabled':''}>刷新本批状态</button></header><p>已完成 ${batch.items.filter(i=>i.state==='succeeded').length} / ${batch.items.length} 份 · 已扣 ${formatPoints(batch.charged_points)} 积分。每份独立交付与结算，失败文件不扣费。</p><ul>${batch.items.map(item=>`<li data-check-file="${esc(item.file_version_id)}"><div><strong>${esc(item.filename)}</strong><span>${esc(runStateLabel[item.state as keyof typeof runStateLabel]??item.state)} · 已扣 ${formatPoints(item.charged_points)} 积分</span></div><a class="text-button" href="#consistency?${new URLSearchParams({project:this.project,run:item.run_id})}">${item.state==='succeeded'?'查看本份检查与修订':'查看本份任务'}</a>${taskRestartHtml(item,{compact:true})}</li>`).join('')}</ul>${['partial','failed'].includes(batch.state)?`<button class="btn secondary" data-file-check-retry="${esc(batch.batch_id)}" ${this.busy||this.storageBlocked?'disabled':''}>仅重试失败或已取消文件</button><p class="muted">沿用原文件与原价格，已成功文件不会再次执行或扣费。</p>`:''}</section>`).join('')}`;
    this.host.querySelectorAll('[data-file-check-refresh]').forEach(b=>b.addEventListener('click',()=>void this.refresh()));
    this.host.querySelectorAll<HTMLButtonElement>('[data-file-check-retry]').forEach(b=>b.addEventListener('click',()=>{const batch=this.batches.find(i=>i.batch_id===b.dataset.fileCheckRetry);if(batch)void this.retry(batch);}));
    this.host.querySelector('[data-file-check-pending]')?.addEventListener('click',()=>{const pending=this.pending;if(pending?.kind==='retry'){const batch=this.batches.find(b=>b.batch_id===pending.batch_id);if(batch)void this.retry(batch);}else if(pending?.kind==='create'){const source=this.batches[0]?.source??{version_id:pending.body.expected_source_version_id,selection_revision:pending.body.expected_source_selection_revision} as ProjectFileSource;void this.start(source,pending.body.file_version_ids);}});
  }
}
