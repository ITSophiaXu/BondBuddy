import {schemas} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {UserFacingError} from './user-facing-error';
import {date,esc} from './ui';

type Draft=Dto<'RunSupplementDraftResponse'>;
type QuoteRequest=Dto<'RunSupplementQuoteRequest'>;
type Quote=Dto<'RunSupplementQuoteResponse'>;
type Confirm=Dto<'RunSupplementQuoteConfirmRequest'>;
type Adopt=Dto<'RunSupplementAdoptRequest'>;
type Receipt=Dto<'RunSupplementAdoptionResponse'>;
type Journal={version:1;owner:string;project:string;run:string;request:QuoteRequest;quote:Quote|null;confirm:Confirm|null;adopt:Adopt|null;receipt:Receipt|null;stale:boolean};

/** Durable consent journal. Restore only reads; every confirmation/adoption POST needs a click. */
export class RunSupplementAdoptionFlow {
  readonly cacheKey:string;
  private journal?:Journal;
  private baseline:string|null=null;
  private restored=false;
  private restoring?:Promise<void>;
  private current?:Receipt;
  private currentKnown=false;
  private currentProblem=false;
  private conflict=false;
  private problem=false;
  busy=false;
  notice='';
  error=false;
  constructor(private api:ApiClient,private owner:string,private project:string,private run:string,
    private signal:AbortSignal,private live:()=>boolean,private changed:()=>void){
    this.cacheKey=`bondbuddy:run-supplement-adoption:v1:${encodeURIComponent(owner)}:${encodeURIComponent(project)}:${encodeURIComponent(run)}`;
  }
  get adopted(){return !!this.current;}
  get statusReady(){return this.currentKnown&&!this.currentProblem;}
  get pending(){return !!this.journal?.adopt&&!this.adopted&&!this.journal?.stale;}
  get blocksEditing(){return this.busy||!this.statusReady||this.pending||this.adopted;}
  get hasRecord(){return !!this.journal||this.adopted||this.currentProblem;}
  get blocksResume(){return this.busy||!this.statusReady||!this.adopted&&(this.pending||this.conflict||this.problem);}
  private parse(raw:string){
    const j=JSON.parse(raw) as Journal;
    if(!j||Object.keys(j).sort().join(',')!=='adopt,confirm,owner,project,quote,receipt,request,run,stale,version'||j.version!==1||
      j.owner!==this.owner||j.project!==this.project||j.run!==this.run||typeof j.stale!=='boolean'||
      !Value.Check(schemas.RunSupplementQuoteRequest,j.request)||j.quote!==null&&!Value.Check(schemas.RunSupplementQuoteResponse,j.quote)||
      j.confirm!==null&&!Value.Check(schemas.RunSupplementQuoteConfirmRequest,j.confirm)||j.adopt!==null&&!Value.Check(schemas.RunSupplementAdoptRequest,j.adopt)||
      j.receipt!==null&&!Value.Check(schemas.RunSupplementAdoptionResponse,j.receipt))throw new UserFacingError('本机追加费用记录无法核实，原记录已保留，请联系支持。');
    if(j.quote)this.checkedQuote(j.quote,j);
    if(j.confirm&&(!j.quote||j.confirm.quote_hash!==j.quote.quote.quote_hash)||j.adopt&&(!j.quote?.confirmation||
      j.adopt.quote_id!==j.quote.quote.quote_id||j.adopt.quote_hash!==j.quote.quote.quote_hash||j.adopt.confirmation_id!==j.quote.confirmation.confirmation_id))throw new UserFacingError('本机追加费用确认记录不一致，请保留记录联系支持。');
    if(j.receipt)this.checkedReceipt(j.receipt,j);
    return j;
  }
  private persist(){
    if(!this.live()||this.conflict||this.problem||!this.journal)return false;
    try{
      if(localStorage.getItem(this.cacheKey)!==this.baseline){this.conflict=true;throw new UserFacingError('另一页面已修改追加费用记录，请先载入另一页面记录。');}
      const raw=JSON.stringify(this.journal);this.parse(raw);localStorage.setItem(this.cacheKey,raw);
      if(localStorage.getItem(this.cacheKey)!==raw)throw new Error();this.baseline=raw;return true;
    }catch(error){this.problem=!this.conflict;this.notice=error instanceof UserFacingError?error.message:'追加费用请求未能可靠保存到本机，请保留本页后重试。';this.error=true;return false;}
  }
  storageChanged(event:StorageEvent){
    if(event.key!==null&&event.key!==this.cacheKey)return false;
    this.conflict=true;this.notice='另一页面的追加费用记录已有变化，请先载入记录核对；本页不会继续扣费。';this.error=true;this.changed();return true;
  }
  restore(reload=false):Promise<void>{
    if(this.restoring)return this.restoring;
    if(this.restored&&!reload)return Promise.resolve();
    this.restored=true;const task=this.restoreInner();this.restoring=task;
    void task.finally(()=>{if(this.restoring===task)this.restoring=undefined;});return task;
  }
  private async restoreInner(){
    try{const raw=localStorage.getItem(this.cacheKey);this.baseline=raw;this.journal=raw===null?undefined:this.parse(raw);this.conflict=false;this.problem=false;}
    catch(error){this.problem=true;this.notice=friendlyError(error,'read');this.error=true;}
    this.busy=true;this.changed();
    try{
      // Current authority is server-owned and remains recoverable without any local journal.
      if(!await this.readCurrent())return;
      if(this.adopted){this.notice='本轮补料采用已核实，可查看当前进度或继续当前任务。';this.error=false;return;}
      if(this.problem||!this.journal)return;
      if(this.journal.adopt){await this.readReceipt();if(this.adopted||this.pending)return;}
      if(this.journal.quote){this.journal.quote=this.checkedQuote(await this.api.runSupplementQuote(this.run,this.journal.quote.quote.quote_id,this.signal));this.persist();}
      this.notice=this.journal.quote?'已恢复追加费用报价；继续任务仍需明确点击确认。':'原报价请求已保留，请点击核对追加费用重试原请求。';this.error=false;
    }catch(error){this.handle(error);}
    finally{this.busy=false;if(this.live())this.changed();}
  }
  private checkedCurrent(value:Receipt){
    if(!Value.Check(schemas.RunSupplementAdoptionResponse,value)||value.adoption.project_id!==this.project||value.adoption.run_id!==this.run)
      throw new UserFacingError('当前补料采用记录与本轮任务不一致，请重新核对。');
    return value;
  }
  private async readCurrent(){
    try{const value=this.checkedCurrent(await this.api.currentRunSupplementAdoption(this.run,this.signal));if(!this.live())return false;
      this.current=value;this.currentKnown=true;this.currentProblem=false;return true;
    }catch(error){if(!this.live())return false;
      if(error instanceof ApiError&&error.status===404){this.current=undefined;this.currentKnown=true;this.currentProblem=false;return true;}
      this.currentProblem=true;this.notice=`当前补料采用状态尚未核实，请重新核对任务采用状态。${friendlyError(error,'read')}`;this.error=true;return false;
    }
  }
  /** Ordinary resume has no financial consent. The server alone selects the current execution. */
  async confirmCurrentResume(){
    if(this.busy||!this.adopted)return false;
    const receipt=this.current!;this.busy=true;this.changed();
    try{
      if(!await this.readCurrent())return false;
      if(!this.current||!Value.Equal(this.current,receipt))throw new UserFacingError('当前任务采用记录已有变化，请刷新任务进度后重试。');
      const [run,project]=await Promise.all([this.api.run(this.run,this.signal),this.api.project(this.project,this.signal)]);
      if(!this.live())return false;
      if(!Value.Check(schemas.RunResponse,run)||!Value.Check(schemas.ProjectResponse,project)||run.run_id!==this.run||
        run.project_id!==this.project||project.project_id!==this.project||run.channel!=='production')throw new UserFacingError('当前任务或项目状态无法核实，请刷新后重试。');
      if(!['paused','running'].includes(run.state))throw new UserFacingError('任务状态已有变化，请查看当前进度。');
      this.notice='已核对当前补料任务，将按当前任务继续。';this.error=false;return true;
    }catch(error){this.notice=friendlyError(error,'read');this.error=true;return false;}
    finally{this.busy=false;if(this.live())this.changed();}
  }
  private checkedQuote(value:Quote,j=this.journal!){
    const q=value.quote,c=value.confirmation;
    if(!Value.Check(schemas.RunSupplementQuoteResponse,value)||q.project_id!==this.project||q.run_id!==this.run||
      q.items.reduce((total,item)=>total+item.points,0)!==q.total_points||q.items.some(item=>item.needs_redo&&item.full_price_points!==item.points)||
      q.supplement_revision!==j.request.supplement_revision||q.saved_request_id!==j.request.saved_request_id||
      j.quote&&(q.quote_id!==j.quote.quote.quote_id||q.quote_hash!==j.quote.quote.quote_hash)||
      c&&(c.quote_id!==q.quote_id||c.project_id!==this.project||c.run_id!==this.run||c.quote_hash!==q.quote_hash||c.total_points!==q.total_points||
        !j.confirm||c.request_id!==j.confirm.request_id))throw new UserFacingError('追加费用报价与本次保存或确认请求不一致，请重新核对。');
    return value;
  }
  private checkedReceipt(value:Receipt,j=this.journal!){
    const a=value.adoption,r=j.adopt;
    if(!Value.Check(schemas.RunSupplementAdoptionResponse,value)||!r||a.project_id!==this.project||a.run_id!==this.run||
      a.request_id!==r.request_id||a.quote_id!==r.quote_id||a.confirmation_id!==r.confirmation_id||a.quote_hash!==r.quote_hash||
      a.additional_points!==j.quote?.quote.total_points)throw new UserFacingError('采用回执与原追加费用请求不一致，请保留本页核对。');
    return value;
  }
  private matches(draft:Draft){const r=this.journal?.request;return !!r&&r.supplement_revision===draft.revision&&r.saved_request_id===draft.request_id&&r.candidate_input_hash===draft.input_preview.candidate_input_hash;}
  private expired(){return !!this.journal?.quote&&Date.parse(this.journal.quote.quote.expires_at)<=Date.now();}
  private handle(error:unknown){
    if(!this.live())return;
    if(error instanceof ApiError&&['QUOTE_CHANGED','INPUT_REVISION_CONFLICT'].includes(error.code)){
      if(this.journal){this.journal.stale=true;this.persist();}
      this.notice='材料、暂停进度或报价已变化。请重新读取并保存补料，再核对新报价后确认。';
    }else if(error instanceof ApiError&&error.code==='CREDITS_INSUFFICIENT')this.notice='积分不足，补料尚未采用。充值后可重试原确认请求；报价过期时需重新核对。';
    else this.notice=friendlyError(error,'action');
    this.error=true;
  }
  async quote(draft:Draft,available:boolean){
    if(this.busy||!this.statusReady||this.conflict||this.problem||this.adopted||!available)return;
    this.busy=true;this.changed();
    try{
      // An uncertain adoption must be resolved before replacing its quote/request IDs.
      if(this.journal?.adopt){const found=await this.readReceipt();if(found===undefined||found)return;}
      if(!draft.request_id||draft.saved_work.status!=='captured'||draft.input_preview.status!=='prepared'||!draft.input_preview.candidate_input_hash)
        throw new UserFacingError('请先保存补料草稿，确认材料核对和暂停进度记录后再核对费用。');
      if(!this.journal||!this.matches(draft)||this.journal.stale||this.expired())this.journal={version:1,owner:this.owner,project:this.project,run:this.run,
        request:{request_id:crypto.randomUUID(),supplement_revision:draft.revision,saved_request_id:draft.request_id,candidate_input_hash:draft.input_preview.candidate_input_hash},
        quote:null,confirm:null,adopt:null,receipt:null,stale:false};
      if(!this.persist())return;
      this.journal.quote=this.checkedQuote(await this.api.createRunSupplementQuote(this.run,this.journal.request,this.signal));
      if(!this.live()||!this.persist())return;
      this.notice='请核对文档及追加积分，再明确确认采用补料并继续。';this.error=false;
    }catch(error){this.handle(error);}
    finally{this.busy=false;if(this.live())this.changed();}
  }
  async confirmAndAdopt(draft:Draft,available:boolean){
    const j=this.journal;
    if(this.busy||!this.statusReady||this.conflict||this.problem||this.adopted||!j?.quote||j.stale||!this.matches(draft)||!available)return;
    this.busy=true;this.changed();
    try{
      if(j.adopt){const found=await this.readReceipt();if(found===undefined||found)return;}
      if(this.expired())throw new ApiError(409,'QUOTE_CHANGED');
      j.confirm??={request_id:crypto.randomUUID(),quote_hash:j.quote.quote.quote_hash};
      if(!this.persist())return;
      if(!j.quote.confirmation){j.quote=this.checkedQuote(await this.api.confirmRunSupplementQuote(this.run,j.quote.quote.quote_id,j.confirm,this.signal));if(!this.live()||!this.persist())return;}
      if(!j.quote.confirmation)throw new UserFacingError('报价确认结果尚未核实，请重新核对原确认回执。');
      j.adopt??={request_id:crypto.randomUUID(),quote_id:j.quote.quote.quote_id,confirmation_id:j.quote.confirmation.confirmation_id,quote_hash:j.quote.quote.quote_hash};
      if(!this.persist())return;
      this.acceptReceipt(await this.api.adoptRunSupplement(this.run,j.adopt,this.signal));
    }catch(error){
      // A transport failure may conceal a committed adoption. GET never authorizes a charge.
      if(this.live()&&j.adopt){const found=await this.readReceipt();if(found!==false)return;}
      this.handle(error);
    }finally{this.busy=false;if(this.live())this.changed();}
  }
  private acceptReceipt(value:Receipt){
    const receipt=this.checkedReceipt(value);if(!this.live())return;
    this.current=receipt;this.currentKnown=true;this.currentProblem=false;
    this.journal!.receipt=receipt;this.journal!.stale=false;this.persist();
    this.notice=`补料已采用，追加费用 ${receipt.adoption.additional_points} 积分。请查看任务当前进度。`;this.error=false;
    window.dispatchEvent(new Event('bondbuddy:credits-changed'));
  }
  /** true=immutable receipt, false=known absent, undefined=unknown; never POST here. */
  private async readReceipt():Promise<boolean|undefined>{
    if(!this.journal?.adopt)return false;
    try{this.acceptReceipt(await this.api.runSupplementAdoption(this.run,this.journal.adopt.request_id,this.signal));return true;}
    catch(error){if(!this.live())return undefined;if(error instanceof ApiError&&error.status===404){this.notice='尚未找到采用回执，原请求已保留。可明确重试原确认请求，或重新核对费用。';this.error=true;return false;}
      this.notice=`原采用结果尚未确认，请核对采用回执。${friendlyError(error,'read')}`;this.error=true;return undefined;}
  }
  async recover(){if(this.busy||!this.journal?.adopt)return;this.busy=true;this.changed();try{await this.readReceipt();}finally{this.busy=false;if(this.live())this.changed();}}
  html(draft:Draft|undefined,available:boolean){
    const j=this.journal,disabled=this.busy||this.conflict||this.problem;
    if(this.current&&!this.currentProblem)return `<div data-supplement-adoption><h4>补料已采用</h4><p>采用记录已确认 · ${esc(date(this.current.adoption.adopted_at))} · 追加 ${this.current.adoption.additional_points} 积分。任务状态以当前进度为准。</p></div>`;
    if(!this.statusReady||!draft)return `<div data-supplement-adoption><p role="${this.error?'alert':'status'}">${esc(this.notice||'正在核对本轮补料采用状态…')}</p><button type="button" class="btn secondary" data-supplement-action="adoption-current-reload" ${this.busy?'disabled':''}>重新核对任务采用状态</button></div>`;
    const current=!!j?.quote&&this.matches(draft)&&available&&!j.stale;
    const quote=current?j!.quote!.quote:undefined;
    return `<div data-supplement-adoption><p class="run-supplement-note">需重做的文档按该文档当前完整价格追加计费；不受影响的文档不追加费用。先核对报价，明确确认后采用补料并继续。</p>${quote?`<h4>本次追加费用</h4><ul>${quote.items.map(i=>`<li>${esc(i.document_name)}：${i.needs_redo?'需要重做，按当前完整文档价格':'无需重做'} · ${i.points} 积分</li>`).join('')}</ul><p>合计追加 <strong>${quote.total_points} 积分</strong> · 报价有效至 ${esc(date(quote.expires_at))}</p>${quote.total_points===0?'<p>本次不追加重做费用；原任务尚未结算的费用仍按原规则继续累计。</p>':''}${this.expired()?'<p role="alert">报价已过期，请重新核对追加费用并确认。</p>':''}<button type="button" class="btn primary" data-supplement-action="adopt" ${disabled||this.expired()?'disabled':''}>${j?.adopt?'重试原确认请求':`确认追加 ${quote.total_points} 积分并继续`}</button>`:''}<button type="button" class="btn secondary" data-supplement-action="quote" ${disabled||!available?'disabled':''}>核对追加费用</button>${j?.adopt?`<button type="button" class="text-btn" data-supplement-action="adoption-receipt" ${this.busy?'disabled':''}>核对采用回执</button>`:''}${this.conflict?'<button type="button" class="btn secondary" data-supplement-action="adoption-local-reload">载入另一页面的追加费用记录</button>':''}<p class="run-supplement-status ${this.error?'error':''}" role="${this.error?'alert':'status'}">${esc(this.notice)}</p></div>`;
  }
}
