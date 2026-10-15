import { duplicateUploadMessage, isReusedUpload } from './duplicate-upload';
import { artifactFilename } from './artifact-download';
import { M4_DOCUMENT_TYPES,M4_DOCUMENT_LABELS,M4_DOCUMENT_MARKETS,MARKETS,MARKET_LABELS,MARKET_OFFERINGS,OFFERING_LABELS,emptyUpdateDetails,reportingWindow,
  sourceProspectusInputGaps,M1_UPLOAD_MIME_TYPES,M1_UPLOAD_LIMITS,
  type AssistantAction,type AssistantCard,type AssistantCardRequest,type AssistantResult,type M4Workspace,type M4Topic,
  type M4MessageContext,type M4ViewState,type M4QuoteResponse,type M4DocumentType,type M4MaterialPin,type Market,type Offering } from '@bondbuddy/contracts';
import { ApiClient,ApiError,friendlyError,type Dto } from './api';
import { M4Api } from './m4-api';
import { ReviewApi } from './review-api';
import { executionRequest } from './execution-request';
import { sourceFields,readSourceFields } from './source-prospectus';
import { cutoffSelection,quarterCutoff,QUARTER_ENDS } from './reporting-cutoff';
import { taskProgress } from './task-progress';
import { esc } from './ui';
import { assistantIcon as icon } from './assistant-icons';
import './project-assistant.css';

type ProjectData={project:Dto<'ProjectResponse'>;materials:Dto<'MaterialResponse'>[];results:AssistantResult[]};
type Upload={id:string;topic:string;started?:boolean;file:File;role:Dto<'UploadCreateRequest'>['role'];project:string;status:string;error?:string;hash?:string;session?:Dto<'UploadSessionResponse'>;bytesSaved?:boolean;material?:Dto<'MaterialResponse'>};
const emptyContext=():M4MessageContext=>({document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null});
const finished=(state:string)=>['succeeded','test_completed','failed','cancelled','rejected'].includes(state);
const businessName=(b:AssistantAction['business'])=>({update:'更新募集书',review:'复核募集书',generation:'材料生成'})[b];
const option=(v:string,label:string,selected?:unknown)=>`<option value="${esc(v)}"${v===selected?' selected':''}>${esc(label)}</option>`;
const pin=(project:string,m:Dto<'MaterialResponse'>):M4MaterialPin=>({source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256});
class AssistantInputError extends Error {}
const assistantError=(e:unknown)=>e instanceof AssistantInputError?e.message:friendlyError(e);
const samePin=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const runLabel=(state:string)=>({queued:'排队等待处理',running:'正在处理',paused:'任务等待恢复',succeeded:'已完成',failed:'处理失败',cancelled:'已取消',rejected:'未能开始',test_completed:'测试任务已完成'}[state]??'正在读取进度');

/** Owned by the login session, outside the route root: navigation never tears down a conversation or upload. */
export class ProjectAssistant {
  private controller=new AbortController();
  private m4:M4Api;
  private host=document.createElement('div');
  private dock=document.createElement('button');
  private narrow=window.matchMedia('(max-width:960px)');
  private resize=()=>this.syncLayout();
  private open=false;
  private active=false;
  private wide=false;
  private history=false;
  private projectPicker=false;
  private busy=false;
  private topics:M4Topic[]=[];
  private workspace?:M4Workspace;
  private cards:AssistantCard[]=[];
  private data?:ProjectData;
  private text='';
  private error='';
  private status='';
  private qaQuote?:{content:string;value:M4QuoteResponse;key:string};
  private timer?:ReturnType<typeof setTimeout>;
  private saveTimer?:ReturnType<typeof setTimeout>;
  private saving:Promise<void>=Promise.resolve();
  private viewDirty=false;
  private epoch=0;
  private uploads:Upload[]=[];
  private formOpen=false;
  private viewConflict=false;
  private conversationRequest?:{projectId?:string;key:string};
  private projects:Dto<'ProjectListResponse'>['items']=[];
  private event=(event:Event)=>{const d=(event as CustomEvent<{projectId:string;artifactId?:string}>).detail;void this.work(async()=>{await this.newConversation(d.projectId);if(d.artifactId){const result=this.data?.results.find(r=>r.pin.artifact_id===d.artifactId);if(result)this.workspace!.view.unsent_context.reading_artifact=result.pin;}
    this.open=true;this.formOpen=false;this.changed();});};
  constructor(private api:ApiClient,private owner:string){
    this.m4=new M4Api(api,this.controller.signal);this.host.className='bb-assistant';document.body.append(this.host);
    this.dock.type='button';this.dock.className='ba-dock';this.dock.dataset.assistantDock='';
    this.dock.setAttribute('aria-controls','ba-panel');
    this.dock.innerHTML=icon('buddy')+'<i data-active-dot aria-hidden="true"></i>';
    this.dock.addEventListener('click',()=>void this.setOpen(true));document.body.append(this.dock);
    this.narrow.addEventListener('change',this.resize);
    this.host.addEventListener('click',e=>void this.click(e));
    this.host.addEventListener('input',e=>this.input(e));
    this.host.addEventListener('change',e=>void this.change(e));
    this.host.addEventListener('keydown',e=>{if(e.key==='Escape'&&this.open){e.preventDefault();void this.setOpen(false);}
      if(e.key==='Tab'&&this.narrow.matches){const items=[...this.host.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')].filter(el=>el.getClientRects().length);
        const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
      if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&(e.target as HTMLElement).matches('[data-composer]')){e.preventDefault();void this.work(()=>this.send());}});
    window.addEventListener('bondbuddy:assistant',this.event);this.paint();
  }
  dispose(){this.controller.abort();clearTimeout(this.timer);clearTimeout(this.saveTimer);window.removeEventListener('bondbuddy:assistant',this.event);this.narrow.removeEventListener('change',this.resize);this.open=false;this.syncLayout();this.host.remove();this.dock.remove();}
  mount(){
    if(!this.host.isConnected)document.body.append(this.host);
    if(!this.dock.isConnected)document.body.append(this.dock);
    const navigation=document.querySelector('.sidebar nav[aria-label="账号"]');
    if(navigation&&!navigation.querySelector('[data-assistant-restore]')){
      const button=document.createElement('button');button.type='button';button.className='nav-item assistant-restore';button.dataset.assistantRestore='';
      button.innerHTML=icon('buddy')+'<span>BondBuddy 助手</span>';
      button.title='打开或恢复项目助手';
      button.addEventListener('click',()=>{
        const menu=document.querySelector<HTMLButtonElement>('#toggle-menu');if(menu?.getAttribute('aria-expanded')==='true')menu.click();
        void this.setOpen(true);
      });
      navigation.prepend(button);
    }
    this.paintDock();this.syncLayout();
  }
  private async setOpen(open:boolean){
    this.open=open;this.paint();
    if(open&&!this.workspace)await this.work(()=>this.init());
    // Recheck the current state: the user may collapse while initialization is pending.
    if(this.open)this.host.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus();
    else document.querySelector<HTMLButtonElement>('[data-assistant-dock]')?.focus();
  }
  private paintDock(){
    const dock=this.dock;dock.hidden=this.open;
    dock.setAttribute('aria-label','打开项目助手');
    dock.setAttribute('aria-expanded',String(this.open));
    dock.title='BondBuddy · 打开项目助手';
    dock.querySelector('[data-active-dot]')?.classList.toggle('is-active',this.active);
  }
  private syncLayout(){
    const app=document.querySelector<HTMLElement>('.prototype-app');if(app)app.inert=this.open&&this.narrow.matches;
    this.host.querySelector('.ba-panel')?.setAttribute('aria-modal',String(this.narrow.matches));
  }
  private get live(){return !this.controller.signal.aborted;}
  private get view(){return this.workspace!.view;}
  private get action(){return this.workspace?.view.assistant?.action??null;}
  private async work(fn:()=>Promise<unknown>){
    if(this.busy||!this.live)return;this.busy=true;this.error='';this.paint();
    try{await fn();}catch(e){if(this.live){this.error=assistantError(e);if(e instanceof ApiError&&['QUOTE_CHANGED','QUOTE_REQUIRED'].includes(e.code)){this.qaQuote=undefined;this.invalidateTask();}}}
    finally{this.busy=false;if(this.live){this.paint();void this.drainUploads();}}
  }
  private invalidateTask(){if(!this.workspace)return;this.view.assistant!.draft_token=crypto.randomUUID();this.qaQuote=undefined;this.changed();this.paintTimeline();}
  private currentUploads(){return this.uploads.filter(u=>u.topic===this.workspace?.topic.topic_id);}
  private async drainUploads(){
    if(this.busy||!this.live||!this.uploads.some(u=>!u.started&&!u.error))return;
    await this.work(async()=>{for(const u of this.uploads.filter(u=>!u.started&&!u.error)){
      u.started=true;try{await this.upload(u);}catch{/* individual retry is available */}
    }if(this.data)this.data=await this.projectData(this.data.project.project_id);await this.poll();});
  }
  private async init(){
    this.topics=(await this.m4.topics()).topics.filter(t=>t.surface==='assistant');
    const selected=sessionStorage.getItem(`bb-assistant:${this.owner}`),last=this.topics.find(t=>t.topic_id===selected)??this.topics[0];
    if(last)await this.select(last.topic_id);else await this.newConversation();
  }
  private async newConversation(projectId?:string){
    await this.flush();const source=projectId?await this.api.project(projectId,this.controller.signal):null;
    if(!this.conversationRequest||this.conversationRequest.projectId!==projectId)this.conversationRequest={projectId,key:crypto.randomUUID()};
    const result=await this.m4.create({creation_request_id:this.conversationRequest.key,name:source?`${source.name} · 项目助手`:'新对话',surface:'assistant',...(source?{source_project_id:source.project_id}:{})});
    this.conversationRequest=undefined;this.topics.unshift(result.topic);await this.select(result.topic.topic_id);
    this.view.assistant={project_id:source?.project_id??null,action:null};
    if(source){this.data=await this.projectData(source.project_id);for(const m of this.data.materials.filter(m=>m.state==='persisted'))await this.m4.material(this.workspace!.topic.topic_id,pin(source.project_id,m));}
    this.changed();await this.flush();this.history=false;this.formOpen=false;this.projectPicker=false;
  }
  private async select(id:string){
    await this.flush();const token=++this.epoch;const w=await this.m4.workspace(id);if(!this.live||token!==this.epoch)return;
    this.workspace=w;this.viewConflict=false;this.text=w.view.unsent_content;this.qaQuote=undefined;this.data=undefined;this.formOpen=false;this.status='';
    this.view.assistant??={project_id:w.topic.source_project_id,action:null};
    sessionStorage.setItem(`bb-assistant:${this.owner}`,id);
    if(this.view.assistant.project_id){this.data=await this.projectData(this.view.assistant.project_id);if(this.view.assistant.source_prospectuses)this.data.project.update_details!.source_prospectuses=this.view.assistant.source_prospectuses;}
    this.cards=(await this.api.request<{cards:AssistantCard[]}>('GET',`/assistant/topics/${id}/cards`,undefined,{},this.controller.signal)).cards;
    this.history=false;this.projectPicker=false;this.poll();
  }
  private projectData(id:string){return this.api.request<ProjectData>('GET',`/assistant/projects/${encodeURIComponent(id)}`,undefined,{},this.controller.signal);}
  private changed(){this.viewDirty=true;clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>void this.flush().catch(e=>{this.error=assistantError(e);this.paint();}),500);}
  private async flush(){
    clearTimeout(this.saveTimer);
    this.saving=this.saving.catch(()=>{}).then(async()=>{
      if(!this.workspace||!this.viewDirty||!this.live)return;
      if(this.viewConflict)throw new AssistantInputError('此对话已在其他页面修改。请先恢复最新会话；本页未发送文字会保留。');
      const w=this.workspace;this.view.unsent_content=this.text;const {version,...view}=structuredClone(this.view);
      this.viewDirty=false;
      try{const result=await this.m4.view(w.topic.topic_id,{expected_version:version,view});
        // Polling replaces the workspace while retaining the same editable view.
        // A save receipt still advances that view, but never a switched conversation.
        if(this.workspace?.topic.topic_id===w.topic.topic_id && this.workspace.view===w.view)this.workspace.view.version=result.view.version;}
      catch(e){this.viewDirty=true;if(e instanceof ApiError&&e.code==='INPUT_REVISION_CONFLICT')this.viewConflict=true;throw e;}
    });return this.saving;
  }
  private async poll(){
    clearTimeout(this.timer);if(!this.live||!this.workspace)return;const id=this.workspace.topic.topic_id,token=this.epoch;
    try{const [w,c]=await Promise.all([this.m4.workspace(id),this.api.request<{cards:AssistantCard[]}>('GET',`/assistant/topics/${id}/cards`,undefined,{},this.controller.signal)]);
      if(!this.live||token!==this.epoch)return;
      // Keep local typing and explicit draft choices. Server replies are immutable.
      this.workspace={...w,view:this.workspace.view};this.cards=c.cards;
      if(this.open&&!this.busy)this.paintTimeline();
      const active=w.messages.some(m=>m.role==='user'&&!['completed','failed'].includes(m.reply_status))||c.cards.some(c=>c.run&&!finished(c.run.state));
      this.active=active;this.paintDock();
    }catch(e){if(this.live&&this.open){this.status='连接暂时中断，已提交任务继续运行。';this.paintStatus();}}
    if(this.live&&token===this.epoch)this.timer=setTimeout(()=>void this.poll(),this.open?4000:12000);
  }
  private context():M4MessageContext{return {...this.view.unsent_context,document_type:null,draft_version:0};}
  private async send(){
    if(!this.text.trim()||!this.workspace)return;
    if(this.workspace.messages.some(m=>m.role==='user'&&!['completed','failed'].includes(m.reply_status)))throw new AssistantInputError('请等待本轮回复后继续。');
    if(this.currentUploads().some(u=>u.status!=='已保存'))throw new AssistantInputError('请等待附件保存完成，或先处理失败的上传。');
    await this.flush();const id=this.workspace.topic.topic_id,content=this.text.trim(),context=this.context();
    if(!this.qaQuote||this.qaQuote.content!==content){const value=await this.m4.quote(id,{kind:'qa',content,context});this.qaQuote={value,content,key:crypto.randomUUID()};if(value.quote.points>0)return;}
    const q=this.qaQuote;if(q.value.shortage>0)throw new AssistantInputError('积分不足，请充值后重新发送。');
    await this.m4.message(id,{submission_request_id:q.key,content,context,quote_id:q.value.quote.quote_id});
    this.text='';this.qaQuote=undefined;this.changed();await this.flush();await this.poll();
  }
  private async useAction(action:AssistantAction){
    if(!this.workspace)return;
    this.view.assistant!.action=structuredClone(action);this.formOpen=true;
    if(this.data){action.fields={...{name:this.data.project.name,issuer_name:this.data.project.issuer_name??'',market:this.data.project.market??undefined,offering:this.data.project.offering??undefined,
      reporting_cutoff:this.data.project.update_details?.reporting_cutoff??undefined},...action.fields};this.view.assistant!.action=action;}
    this.invalidateTask();await this.flush();
  }
  private projectInput():Dto<'ProjectCreateRequest'>{
    const a=this.action!,f=a.fields,d=this.data?.project.update_details??emptyUpdateDetails();
    return {name:f.name?.trim()||`${f.issuer_name||'新项目'} · ${businessName(a.business)}`,kind:a.business==='review'?'review':'update',issuer_name:f.issuer_name||null,market:f.market??null,offering:f.offering??null,
      update_details:{...d,source_prospectuses:this.view.assistant?.source_prospectuses??d.source_prospectuses,authoring_mode:'unified_v1',reporting_cutoff:f.reporting_cutoff??d.reporting_cutoff,target_reporting_periods:reportingWindow(f.market??null,f.offering??null,f.reporting_cutoff??d.reporting_cutoff),supplementary_notes:a.requirements}};
  }
  private async ensureProject(){
    if(!this.action||!this.workspace)return;
    if(this.action.business==='generation')return;
    const input=this.projectInput();
    if(!input.issuer_name||!input.market||!input.offering||!input.update_details?.reporting_cutoff)throw new AssistantInputError('请先填写发行人、市场、品种和最新报告期。');
    const view=this.view.assistant!;
    if(this.data&&this.data.project.kind===input.kind&&!view.copy_source_project_id){const {kind,...patch}=input;this.data.project=await this.api.patch(this.data.project.project_id,this.data.project.draft_revision,patch);return;}
    let p=this.data?.project;
    if(!view.copy_source_project_id){
      const source=this.data?.project.project_id??this.workspace.topic.project_id;
      view.project_creation_request_id??=crypto.randomUUID();this.changed();await this.flush();
      p=await this.api.create({...input,update_details:{...input.update_details!,source_prospectuses:[]},creation_request_id:view.project_creation_request_id});
      view.project_id=p.project_id;view.copy_source_project_id=source;view.source_prospectuses=input.update_details?.source_prospectuses??[];this.changed();await this.flush();
    }
    this.data=await this.projectData(p!.project_id);
    // Persist the source until every selected file has been copied; refresh can resume.
    const sources=(await this.projectData(view.copy_source_project_id!)).materials.filter(m=>m.state==='persisted').map(material=>({project:view.copy_source_project_id!,material}));
    const mapped:NonNullable<typeof input.update_details>['source_prospectuses']=[];
    for(const source of sources){const m=source.material;
      let material=this.data.materials.find(v=>v.sha256===m.sha256&&v.filename===m.filename&&v.role===m.role);
      if(!material){const bytes=await this.api.materialBytes(source.project,m,this.controller.signal);
        const u:Upload={id:crypto.randomUUID(),topic:this.workspace.topic.topic_id,started:true,file:new File([bytes],m.filename,{type:m.media_type}),role:m.role,project:p!.project_id,status:'正在复用材料',hash:m.sha256};this.uploads.push(u);await this.upload(u);material=u.material!;this.data.materials.push(material);}
      const info=view.source_prospectuses?.find(s=>s.material_id===m.material_id||s.material_id===material.material_id);
      if(info)mapped.push({...info,material_id:material.material_id,material_version:material.material_version,sha256:material.sha256});
    }
    this.data=await this.projectData(p!.project_id);const {kind,...patch}=input;
    this.data.project=await this.api.patch(p!.project_id,this.data.project.draft_revision,{...patch,update_details:{...input.update_details!,source_prospectuses:mapped}});
    view.source_prospectuses=mapped;delete view.copy_source_project_id;delete view.project_creation_request_id;this.invalidateTask();await this.flush();
  }
  private async prepare(){
    if(!this.action||!this.workspace)return;await this.flush();
    if(this.currentUploads().some(u=>u.status!=='已保存'))throw new AssistantInputError('附件尚未保存完成，请处理后继续。');
    let b:AssistantCardRequest={card_id:crypto.randomUUID(),execution_request_id:crypto.randomUUID(),operation:this.action.business,project_id:''};
    if(this.action.business==='generation'){
      const type=this.action.fields.document_type as M4DocumentType|undefined;if(!type||!M4_DOCUMENT_TYPES.includes(type))throw new AssistantInputError('请选择材料类型。');
      const w=await this.m4.workspace(this.workspace.topic.topic_id),old=w.drafts[type];
      const {version,sha256,updated_at,...input}=old;input.materials=[...w.materials];
      const sources=w.materials.filter(m=>w.material_details.find(d=>d.material_id===m.material_id)?.role==='historical');
      input.source_material=sources.find(m=>m.material_id===this.view.unsent_context.source_material?.material_id)??(sources.length===1?sources[0]:null);
      if(sources.length>1&&!input.source_material)throw new AssistantInputError('请选择本次采用的募集说明书，其他文件仍作为补充材料。');
      input.fields={...input.fields,...this.action.fields,market:this.action.fields.market??'',offering:type==='recommendation'?(this.action.fields.offering??''):'private'};
      if(type==='init'){const t=w.templates.find(t=>`${t.template_id}/${t.template_version}`===this.view.assistant?.template_key);if(!t)throw new AssistantInputError('请选择或上传本账号的券商立项报告模板。');input.template={template_id:t.template_id,template_version:t.template_version,sha256:t.sha256};input.fields.broker=t.broker;}input.supplemental_requirements=this.action.requirements;
      input.edit_base=this.view.unsent_context.reading_artifact??null;
      const result=await this.m4.draft(w.topic.topic_id,{expected_version:version,input});
      const q=await this.m4.quote(w.topic.topic_id,{kind:'document',document_type:type,expected_draft_version:result.draft.version});
      b={...b,project_id:w.topic.project_id,document_type:type,expected_draft_version:result.draft.version,quote_id:q.quote.quote_id};
    }else{
      await this.ensureProject();const data=await this.projectData(this.view.assistant!.project_id!);this.data=data;const p=data.project,materials=data.materials.filter(m=>m.state==='persisted');
      if(!materials.length)throw new AssistantInputError('请先上传本次任务的材料。');
      if(this.action.business==='update'){
        const gaps=sourceProspectusInputGaps(materials,p.update_details?.source_prospectuses);if(gaps.length)throw new AssistantInputError('请补齐历史募集书下的原稿信息后继续。');
        const messages=(await this.api.projectMessages(p.project_id,undefined,this.controller.signal)).project_message_set_ref;
        const base=this.view.unsent_context.reading_artifact;
        const locked=await this.api.createInputRevision(p.project_id,{draft_revision:p.draft_revision,material_versions:materials.map(m=>({material_id:m.material_id,material_version:m.material_version})),
          requirement_message_ids:messages.message_ids,project_message_set_ref:messages,edit_base:base?{artifact_id:base.artifact_id,artifact_version:base.artifact_version,sha256:base.sha256}:null},this.controller.signal);
        const request=await executionRequest(locked,'update'),q=await this.api.creditQuote(p.project_id,{input_revision:locked.input_revision,input_hash:locked.input_hash},this.controller.signal);
        b={...b,project_id:p.project_id,execution_request_id:request.execution_request_id,input_revision:locked.input_revision,input_hash:locked.input_hash,...(q.quote?{quote_id:q.quote.quote_id}:{})};
      }else{
        const review=new ReviewApi(this.api,p.project_id,this.controller.signal),saved=await review.drafts(),sources=materials.filter(m=>m.role==='historical');
        const source=sources.find(m=>m.material_id===this.view.unsent_context.source_material?.material_id)??(sources.length===1?sources[0]:undefined);
        if(!source)throw new AssistantInputError(sources.length?'请选择本次待复核的募集说明书。':'请上传待复核的募集说明书。');
        await review.saveDraft({kind:'input',expected_version:saved.draft.version,input:{source_material_ref:{material_id:source.material_id,material_version:source.material_version,sha256:source.sha256},material_versions:materials.map(m=>({material_id:m.material_id,material_version:m.material_version,sha256:m.sha256})),requirements:this.action.requirements?[this.action.requirements]:[],as_of:p.update_details?.reporting_cutoff??null}});
        const d=await review.drafts();b={...b,project_id:p.project_id,expected_input_version:d.draft.version};const q=await review.quoteExecution(this.reviewRequest(b));if(q.quote)b.quote_id=q.quote.quote_id;
      }
    }
    await this.flush();
    const {card}=await this.api.request<{card:AssistantCard}>('POST',`/assistant/topics/${this.workspace.topic.topic_id}/cards`,b,{},this.controller.signal);
    this.view.assistant!.prepared_card_id=card.card_id;this.changed();await this.flush();
    this.cards.push(card);this.formOpen=false;this.status=b.operation==='update'?'请核对材料与要求后开始更新。':'请核对材料、要求和积分后开始。';
  }
  private reviewRequest(c:AssistantCardRequest){return {execution_request_id:c.execution_request_id,operation:'full_review' as const,expected_input_version:c.expected_input_version!,source_report_id:null,expected_plan_version:null,finding_ids:[],...(c.quote_id?{quote_id:c.quote_id}:{})};}
  private async execute(c:AssistantCard){
    if(!this.workspace||c.run)return;await this.flush();
    if(this.staleCard(c))throw new AssistantInputError('要求或材料已变化，请重新核对本次任务和积分。');
    if(c.operation==='update'){
      const req=await executionRequest({project_id:c.project_id,input_revision:c.input_revision!,input_hash:c.input_hash!},'update');
      if(req.execution_request_id!==c.execution_request_id)throw new ApiError(409,'INPUT_REVISION_CONFLICT');if(c.quote_id)req.quote_id=c.quote_id;await this.api.execute(req,this.controller.signal);
    }else if(c.operation==='review')await new ReviewApi(this.api,c.project_id,this.controller.signal).execute(this.reviewRequest(c));
    else await this.m4.execute(this.workspace.topic.topic_id,{execution_request_id:c.execution_request_id,document_type:c.document_type as M4DocumentType,expected_draft_version:c.expected_draft_version!,quote_id:c.quote_id!,entrypoint:'assistant'});
    this.status='已开始处理。可以收起助手，任务会继续运行。';this.view.assistant!.action=null;this.changed();await this.flush();await this.poll();
  }
  private async upload(u:Upload){
    const state=(s:string)=>{u.status=s;this.paintStatus();};u.error=undefined;
    try{const ext=u.file.name.split('.').pop()?.toLowerCase(),mime=({docx:M1_UPLOAD_MIME_TYPES[0],pdf:M1_UPLOAD_MIME_TYPES[1],xlsx:M1_UPLOAD_MIME_TYPES[2],csv:M1_UPLOAD_MIME_TYPES[3],txt:M1_UPLOAD_MIME_TYPES[4],png:M1_UPLOAD_MIME_TYPES[5],jpg:M1_UPLOAD_MIME_TYPES[6],jpeg:M1_UPLOAD_MIME_TYPES[6]} as Record<string,typeof M1_UPLOAD_MIME_TYPES[number]>)[ext??''];
      if(!mime||!u.file.size||u.file.size>M1_UPLOAD_LIMITS.fileBytes)throw new AssistantInputError('文件格式或大小不符合上传要求。');
      if(!u.hash){state('正在校验文件');const digest=await crypto.subtle.digest('SHA-256',await u.file.arrayBuffer());u.hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
      u.session??=await this.api.createUpload(u.project,{filename:u.file.name,media_type:mime,byte_size:u.file.size,sha256:u.hash,role:u.role},this.controller.signal);
      if(!u.bytesSaved){await this.api.uploadBytes(u.session.upload_url,u.file,(n,total)=>state(`上传 ${Math.round(n/total*100)}%`),this.controller.signal);u.bytesSaved=true;}
      state('正在确认保存');u.material??=await this.api.completeUpload(u.project,u.session.upload_id,{byte_size:u.file.size,sha256:u.hash},this.controller.signal);
      await this.m4.material(u.topic,pin(u.project,u.material));state(isReusedUpload(u.material,u.session)?duplicateUploadMessage(u.file.name,u.material.filename):'已保存');
    }catch(e){u.error=assistantError(e);state('上传未完成');throw e;}
  }
  private addFiles(files:File[],role:Upload['role']){
    if(!this.workspace)return;
    const project=this.data?.project.project_id??this.workspace.topic.project_id,topic=this.workspace.topic.topic_id;
    for(const file of files)this.uploads.push({id:crypto.randomUUID(),file,role,project,topic,status:'等待上传'});
    this.invalidateTask();this.paintStatus();void this.drainUploads();
  }
  private async download(id:string){const a=await this.api.artifact(id,this.controller.signal),bytes=await this.api.artifactBytes(a,this.controller.signal),url=URL.createObjectURL(bytes),link=document.createElement('a');link.href=url;link.download=artifactFilename(a);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  private async click(event:Event){const el=(event.target as HTMLElement).closest<HTMLElement>('[data-a]');if(!el)return;const a=el.dataset.a;
    if(a==='toggle'){await this.setOpen(!this.open);return;}
    if(a==='wide'){this.wide=!this.wide;this.paint();return;}
    if(a==='history'){this.history=!this.history;this.projectPicker=false;this.paint();return;}
    if(a==='close-project'||a==='project'&&this.projectPicker){this.projectPicker=false;this.paint();this.host.querySelector<HTMLElement>('[data-a="project"]')?.focus();return;}
    if(a==='hide-form'){this.formOpen=false;this.paint();return;}
    await this.work(async()=>{
      if(a==='recover-view'&&this.workspace){const text=this.text;this.viewDirty=false;this.viewConflict=false;await this.select(this.workspace.topic.topic_id);this.text=text;this.changed();await this.flush();this.status='已载入最新会话，本页未发送文字已保留。';}
      if(a==='new')await this.newConversation();
      if(a==='select')await this.select(el.dataset.id!);
      if(a==='send')await this.send();
      if(a==='current-project'){const id=location.hash.match(/#\/projects\/([^/?]+)/)?.[1];if(id)await this.newConversation(decodeURIComponent(id));}
      if(a==='project'){let cursor:string|undefined;this.projects=[];do{const page=await this.api.projects(cursor,{limit:'100'},this.controller.signal);this.projects.push(...page.items.filter(p=>p.kind!=='qa'));cursor=page.page.next_cursor??undefined;}while(cursor);this.status='';this.history=false;this.projectPicker=true;}
      if(a==='action'){const message=this.workspace?.messages.find(m=>m.message_id===el.dataset.id);if(message?.reply?.assistant_action)await this.useAction(message.reply.assistant_action);}
      if(a==='shortcut')await this.useAction({business:el.dataset.kind as AssistantAction['business'],requirements:'',fields:{}});
      if(a==='edit'){this.formOpen=true;}
      if(a==='prepare')await this.prepare();
      if(a==='execute'){const c=this.cards.find(c=>c.card_id===el.dataset.id);if(c)await this.execute(c);}
      if(a==='download')await this.download(el.dataset.id!);
      if(a==='retry-upload'){const u=this.uploads.find(u=>u.id===el.dataset.id);if(u){await this.upload(u);if(this.data)this.data=await this.projectData(this.data.project.project_id);}}
      if(a==='remove-upload'){this.uploads=this.uploads.filter(u=>u.id!==el.dataset.id);this.invalidateTask();}
      if(a==='continue'){const c=this.cards.find(c=>c.card_id===el.dataset.id);if(c?.run){this.data=await this.projectData(c.project_id);const result=this.data.results.find(r=>r.run_id===c.run!.run_id);if(result)this.view.unsent_context.reading_artifact=result.pin;
        await this.useAction({business:c.operation,requirements:'',fields:c.document_type?{document_type:c.document_type}:{}});}}
    });
  }
  private input(event:Event){const el=event.target as HTMLInputElement;
    if(el.matches('[data-composer]')){this.text=el.value;this.qaQuote=undefined;this.changed();this.paintStatus();this.sizeComposer();}
    if(el.matches('[data-field]')&&this.action){(this.action.fields as Record<string,string>)[el.dataset.field!]=el.value;this.invalidateTask();}
    if(el.matches('[data-requirements]')&&this.action){this.action.requirements=el.value;this.invalidateTask();}
    if(el.dataset.sourceField&&this.data){const container=el.closest<HTMLElement>('[data-source-material]')!,m=this.data.materials.find(m=>m.material_id===container.dataset.sourceMaterial)!;
      const sources=this.data.project.update_details!.source_prospectuses??=[],old=sources.find(s=>s.material_id===m.material_id),next=readSourceFields(container,m,old,el.dataset.sourceField);
      this.data.project.update_details!.source_prospectuses=[...sources.filter(s=>s.material_id!==m.material_id),next];
      this.view.assistant!.source_prospectuses=this.data.project.update_details!.source_prospectuses;this.invalidateTask();}
  }
  private async change(event:Event){const el=event.target as HTMLInputElement;
    if(el.matches('[data-primary-source]')){this.view.unsent_context.source_material=this.workspace?.materials.find(m=>m.material_id===el.value)??null;this.invalidateTask();return;}
    if(el.matches('[data-project-select]')){const id=el.value;if(id)await this.work(async()=>{this.projects=[];await this.newConversation(id);});return;}
    if(el.matches('[data-template]')){this.view.assistant!.template_key=el.value;this.invalidateTask();return;}
    if(el.matches('[data-template-upload]')){const file=el.files?.[0];el.value='';if(file)await this.work(async()=>{if(!this.action?.fields.broker)throw new AssistantInputError('请先填写模板所属券商。');const u:Upload={id:crypto.randomUUID(),topic:this.workspace!.topic.topic_id,started:true,file,role:'other',project:this.workspace!.topic.project_id,status:'等待上传'};this.uploads.push(u);await this.upload(u);const {template}=await this.m4.template({creation_request_id:u.id,name:file.name,broker:this.action.fields.broker,document_type:'init',material:pin(u.project,u.material!),market:this.action.fields.market as 'sse'|'szse'});this.view.assistant!.template_key=`${template.template_id}/${template.template_version}`;this.changed();await this.flush();await this.poll();});return;}
    if(el.matches('[data-file]')){const files=Array.from(el.files??[]);el.value='';if(files.length)this.addFiles(files,el.dataset.file as Upload['role']);return;}
    if(el.matches('[data-baseline]')){this.view.unsent_context.reading_artifact=this.data?.results.find(r=>r.pin.artifact_id===el.value)?.pin??null;this.qaQuote=undefined;this.invalidateTask();return;}
    if(el.matches('[data-year],[data-quarter]')&&this.action){const year=this.host.querySelector<HTMLSelectElement>('[data-year]')!.value,q=this.host.querySelector<HTMLSelectElement>('[data-quarter]')!.value;const date=quarterCutoff(year,q);if(date)this.action.fields.reporting_cutoff=date;this.invalidateTask();}
    if(el.matches('[data-field="document_type"]')){this.paint();}
    if(el.matches('[data-field="market"]')&&this.action){delete this.action.fields.offering;this.paint();}
    if(el.dataset.sourceField==='market'&&this.data)this.paint();
  }
  private form(){const a=this.action;if(!a)return '';const f=a.fields,s=cutoffSelection(f.reporting_cutoff??null),materials=this.data?.materials??[],sources=(this.workspace?.material_details??[]).filter(m=>m.role==='historical'&&(!this.data||m.source_project_id===this.data.project.project_id));
    return `<section class="ba-form"><div class="ba-card-head"><strong>${businessName(a.business)} · 核对信息</strong><button class="ba-icon-button" data-a="hide-form" title="收起任务信息" aria-label="收起任务信息">${icon('minus')}</button></div>
      <div class="ba-fields">${a.business==='generation'?`<label>材料类型<select data-field="document_type"><option value="">请选择</option>${M4_DOCUMENT_TYPES.map(t=>option(t,M4_DOCUMENT_LABELS[t],f.document_type)).join('')}</select></label>`:`<label>项目名称<input data-field="name" maxlength="120" value="${esc(f.name??'')}"></label><label>发行人全称<input data-field="issuer_name" maxlength="200" value="${esc(f.issuer_name??'')}"></label>`}
      <label>发行市场<select data-field="market"><option value="">请选择</option>${(a.business==='generation'?(f.document_type?M4_DOCUMENT_MARKETS[f.document_type]:MARKETS):MARKETS).map(m=>option(m,MARKET_LABELS[m],f.market)).join('')}</select></label>
      ${a.business==='generation'&&f.document_type==='recommendation'?`<label>品种<select data-field="offering"><option value="">请选择</option>${(['ppn','mtn'] as const).map(o=>option(o,OFFERING_LABELS[o],f.offering)).join('')}</select></label>`:''}
      ${a.business!=='generation'?`<label>品种<select data-field="offering"><option value="">请选择</option>${(f.market?MARKET_OFFERINGS[f.market]:[]).map(o=>option(o,OFFERING_LABELS[o],f.offering)).join('')}</select></label>
      <label>最新报告期<select data-year>${s.years.map(y=>option(y,`${y}年`,s.year)).join('')}</select></label><label>期末<select data-quarter><option value="">请选择</option>${QUARTER_ENDS.map(([q,l])=>option(q,l,s.quarter)).join('')}</select></label>`:''}</div>
      ${a.business==='generation'&&f.document_type==='init'?`<label>券商立项模板<select data-template><option value="">请选择</option>${(this.workspace?.templates??[]).filter(t=>t.status==='active'&&t.document_type==='init'&&t.market===f.market).map(t=>option(`${t.template_id}/${t.template_version}`,`${t.broker} · ${t.name}`,this.view.assistant?.template_key)).join('')}</select></label><label>模板所属券商<input data-field="broker" value="${esc(f.broker??'')}"></label><label class="ba-attach">＋ 上传券商模板<input type="file" data-template-upload accept=".docx"></label>`:''}
      <div class="ba-upload-actions"><label>＋ ${a.business==='review'?'待复核募集书':'历史／参考募集书'}<input type="file" data-file="historical" accept=".docx,.pdf" multiple></label><label>＋ 财务／审计材料<input type="file" data-file="audit" multiple></label><label>＋ 其他材料<input type="file" data-file="other" multiple></label></div>
      ${a.business!=='update'&&sources.length>1?`<label>本次采用的募集说明书<select data-primary-source><option value="">请选择</option>${sources.map(m=>option(m.material_id,m.filename,this.view.unsent_context.source_material?.material_id)).join('')}</select></label>`:''}
      <ul class="ba-files">${!this.data?(this.workspace?.material_details??[]).map(m=>`<li>${esc(m.filename)} <small>已保存</small></li>`).join(''):''}${materials.map(m=>`<li>${esc(m.filename)} <small>已保存</small>${a.business==='update'?sourceFields(m,this.data?.project.update_details?.source_prospectuses):''}</li>`).join('')}</ul>
      <label>补充要求 <small>选填</small><textarea data-requirements maxlength="12000" rows="3" placeholder="例如：只修改偿债能力分析，保留财务数据与表格。">${esc(a.requirements)}</textarea></label>
      <button class="ba-primary" data-a="prepare"${this.busy?' disabled':''}>核对本次任务</button></section>`;
  }
  private staleCard(c:AssistantCard){return c.draft_token!==(this.view.assistant?.draft_token??null)||this.view.assistant?.prepared_card_id!==c.card_id;}
  private card(c:AssistantCard){const stale=!c.run&&this.staleCard(c),r=c.run,price=c.quote?.points??0,insufficient=c.balance.available<price;
    return `<section class="ba-task ${r?'ba-committed':''}" data-card="${esc(c.card_id)}"><div class="ba-card-head"><strong>${businessName(c.operation)}</strong><span>${r?runLabel(r.state):stale?'已保留旧方案':'待确认'}</span></div><p>${esc(c.project_name)}</p><p>${esc([c.target?.issuer_name,MARKET_LABELS[c.target?.market as Market],OFFERING_LABELS[c.target?.offering as Offering],c.document_type?M4_DOCUMENT_LABELS[c.document_type as M4DocumentType]:null,c.target?.reporting_cutoff?`最新报告期 ${c.target.reporting_cutoff}`:null].filter(Boolean).join(' · '))}</p>
      <details${!r?' open':''}><summary>${c.baseline?'基于已选成果继续修改':'任务材料与要求'}</summary><p>${c.baseline?'保留旧成果，生成新的文件版本。':''}</p><ul>${c.material_names.map(n=>`<li>${esc(n)}</li>`).join('')}</ul><p class="ba-text">${esc(c.requirements||'按所选材料和对应编制要求处理。')}</p></details>
      ${c.operation==='update'&&!r?'':`<div class="ba-credits">${r?'本次任务积分':'本次消耗积分'} <strong>${price.toLocaleString()}</strong>${!r?`<small>可用 ${c.balance.available.toLocaleString()} 积分</small>`:''}</div>`}
      ${r&&!finished(r.state)?taskProgress(r,c.operation==='generation'?'material':c.operation):''}
      ${r?`<a href="#/projects/${encodeURIComponent(c.project_id)}${c.operation==='review'?'/review?tab=results':'?from=projects'}">查看项目${finished(r.state)?'结果':'进度'}</a>${r.state==='succeeded'?` <button data-a="continue" data-id="${esc(c.card_id)}">继续修改</button><div data-delivery="${esc(r.run_id)}"></div>`:''}${['failed','paused'].includes(r.state)?'<p>原材料和要求已保留，可在项目页查看原因与恢复状态。</p>':''}`:
        `<div class="ba-card-actions"><button data-a="edit">修改信息</button>${stale?'<span>输入已变化，请重新核对任务。</span>':insufficient?`<a href="#/account?project=${encodeURIComponent(c.project_id)}" class="ba-primary">积分不足，去充值</a>`:`<button class="ba-primary" data-a="execute" data-id="${esc(c.card_id)}"${this.busy?' disabled':''}>${c.operation==='update'?'开始更新':'确认并开始'}</button>`}</div><small>成功交付后扣费；失败或取消释放预留积分。</small>`}</section>`;
  }
  private paintTimeline(){const box=this.host.querySelector<HTMLElement>('[data-timeline]');if(!box)return;const atEnd=box.scrollHeight-box.scrollTop-box.clientHeight<80,scroll=box.scrollTop;
    const selection=window.getSelection();if(selection&&!selection.isCollapsed&&box.contains(selection.anchorNode))return;
    const messages=this.workspace?.messages??[];const entries=[...messages.map(m=>({time:m.created_at,html:`<article class="ba-message ${m.role}"><small>${m.role==='user'?'你':'BondBuddy'}</small><div class="ba-text">${esc(m.content)}</div>${m.error?`<p role="alert">${esc(m.error)}</p>`:''}${m.role==='user'&&!['completed','failed'].includes(m.reply_status)?`<p class="ba-thinking">${m.reply_status==='running'?'正在阅读并整理回复…':'已收到，等待处理…'}</p>`:''}${m.reply?.assistant_action?`<button class="ba-suggestion" data-a="action" data-id="${esc(m.message_id)}">核对${businessName(m.reply.assistant_action.business)}的信息与要求 →</button>`:''}</article>`})),...this.cards.map(c=>({time:c.created_at,html:this.card(c)}))].sort((a,b)=>a.time.localeCompare(b.time));
    box.hidden=this.formOpen&&!entries.length;
    box.classList.toggle('ba-empty',!entries.length);
    box.innerHTML=entries.map(e=>e.html).join('')||`<div class="ba-welcome"><span class="ba-welcome-mark">${icon('buddy')}</span><h2>有什么可以帮你？</h2><p>讨论项目、完善文稿，或开始一项新任务。</p><div class="ba-shortcuts"><button data-a="shortcut" data-kind="update"><span class="ba-shortcut-icon">${icon('update')}</span><span><strong>更新募集书</strong><small>更新内容，或继续修改已有成果</small></span>${icon('arrow')}</button><button data-a="shortcut" data-kind="review"><span class="ba-shortcut-icon">${icon('review')}</span><span><strong>复核募集书</strong><small>检查内容，梳理需要完善的地方</small></span>${icon('arrow')}</button><button data-a="shortcut" data-kind="generation"><span class="ba-shortcut-icon">${icon('generation')}</span><span><strong>生成项目材料</strong><small>根据材料和要求，编制所需文书</small></span>${icon('arrow')}</button></div></div>`;
    if(atEnd)box.scrollTop=box.scrollHeight;else box.scrollTop=scroll;
    for(const c of this.cards.filter(c=>c.run?.state==='succeeded'))void this.delivery(c);
  }
  private async delivery(c:AssistantCard){const r=c.run!,topic=this.workspace?.topic.topic_id;
    try{if(!r.artifact_id)return;const a=await this.api.artifact(r.artifact_id,this.controller.signal);if(!this.live||topic!==this.workspace?.topic.topic_id)return;
      const host=this.host.querySelector<HTMLElement>(`[data-delivery="${CSS.escape(r.run_id)}"]`);if(!host)return;
      const pair=a.word_delivery;if(pair){host.innerHTML=`<button data-a="download" data-id="${esc(pair.revision_artifact_id)}">下载修订版</button><button data-a="download" data-id="${esc(pair.clean_artifact_id)}">下载清洁版</button>`;}
      else host.innerHTML=`<button data-a="download" data-id="${esc(a.artifact_id)}">下载成果</button>`;
    }catch{/* project result remains available for a fresh authorized read */}
  }
  private paintStatus(){const status=this.host.querySelector<HTMLElement>('[data-status]');if(status)status.textContent=this.error||this.status;
    const uploads=this.host.querySelector<HTMLElement>('[data-uploads]');if(uploads)uploads.innerHTML=this.currentUploads().map(u=>`<div role="status" class="${!u.error&&u.material&&isReusedUpload(u.material,u.session)?'duplicate-upload-notice':''}">${!u.error&&u.material&&isReusedUpload(u.material,u.session)?'':esc(u.file.name)+' · '}${esc(u.status)}${u.error?`<p>${esc(u.error)}</p><button data-a="retry-upload" data-id="${esc(u.id)}">重试保存</button><button data-a="remove-upload" data-id="${esc(u.id)}">移除</button>`:''}</div>`).join('');
    const quote=this.host.querySelector<HTMLElement>('[data-qa-price]');if(quote){const q=this.qaQuote?.value.quote;
      quote.textContent=q?.points?(q.billing_method==='fixed'?`本次回答 ${q.points.toLocaleString()} 积分，回答成功后扣费，失败不扣费。再次点击发送确认。`:`本次回答最多 ${q.points.toLocaleString()} 积分，按实际用量结算。再次点击发送确认。`):'';}
    const send=this.host.querySelector<HTMLButtonElement>('[data-a="send"]');if(send)send.disabled=this.busy||!this.workspace||!this.text.trim();
  }
  private sizeComposer(){const input=this.host.querySelector<HTMLTextAreaElement>('[data-composer]');if(input){input.style.height='auto';input.style.height=`${Math.min(160,input.scrollHeight)}px`;}}
  private paint(){
    if(!this.live)return;
    const uploadContext=`${this.workspace?.topic.topic_id??''}:${this.data?.project.project_id??this.workspace?.topic.project_id??''}`;
    const pickerKey=(input:HTMLInputElement)=>`${input.closest('.ba-composer')?'composer':'form'}:${input.dataset.file??'template'}`;
    const pickers=new Map([...this.host.querySelectorAll<HTMLInputElement>('input[type="file"]')]
      .filter(input=>input.dataset.uploadContext===uploadContext).map(input=>[pickerKey(input),input]));
    this.host.hidden=!this.open;this.paintDock();
    this.host.classList.toggle('ba-wide',this.wide);this.host.classList.toggle('ba-open',this.open);
    const project=this.data?.project,base=this.viewSafe()?.unsent_context.reading_artifact;
    const currentProject=location.hash.match(/#\/projects\/([^/?]+)/)?.[1];
    this.host.innerHTML=this.open?`
      <section id="ba-panel" class="ba-panel" role="dialog" aria-label="BondBuddy 项目助手"><header class="ba-header"><div class="ba-identity"><span class="ba-mark">${icon('buddy')}</span><div><strong>BondBuddy</strong><small>项目助手</small></div></div><div class="ba-toolbar"><button class="ba-icon-button" data-a="new" title="新对话" aria-label="新对话">${icon('new')}</button><button class="ba-icon-button" data-a="history" title="最近对话" aria-label="最近对话" aria-pressed="${this.history}">${icon('history')}</button><button class="ba-icon-button" data-a="wide" title="${this.wide?'还原宽度':'加宽侧栏'}" aria-label="${this.wide?'还原宽度':'加宽侧栏'}">${icon(this.wide?'contract':'expand')}</button><button class="ba-icon-button" data-a="toggle" title="收起助手，回到右下角图标" aria-label="收起助手">${icon('collapse')}</button></div></header>
      <div class="ba-context"><div class="ba-context-row"><button class="ba-project-button" data-a="project" aria-expanded="${this.projectPicker}" title="${esc(project?.name??'关联项目以使用已有材料和成果')}">${icon('folder')}<span>${esc(project?.name??'关联项目')}</span>${icon('chevron')}</button>${currentProject&&currentProject!==project?.project_id?'<button class="ba-current-project" data-a="current-project">使用当前项目</button>':''}
      ${this.workspace?.material_details.length?`<details class="ba-context-files"><summary>${icon('paperclip')}${this.workspace.material_details.length} 份材料</summary><ul>${this.workspace.material_details.map(m=>`<li>${esc(m.filename)}</li>`).join('')}</ul></details>`:''}</div>
      ${this.projectPicker?`<div class="ba-project-picker"><div><strong>关联已有项目</strong><button class="ba-icon-button" data-a="close-project" aria-label="关闭项目选择" title="关闭项目选择">${icon('close')}</button></div>${this.projects.length?`<label class="ba-sr-only" for="ba-project-select">选择项目</label><select id="ba-project-select" data-project-select ${this.busy?'disabled':''}><option value="">选择项目</option>${this.projects.map(p=>option(p.project_id,p.name)).join('')}</select><p>选择后开启新对话，已有对话可在“最近对话”找回。</p>`:'<p>还没有项目，可直接在对话中开始一项任务。</p>'}</div>`:''}
      ${this.data?.results.length?`<label class="ba-baseline">讨论／修改的成果<select data-baseline ${this.busy?'disabled':''}><option value="">仅使用项目材料</option>${this.data.results.map(r=>option(r.pin.artifact_id,r.label,base?.artifact_id)).join('')}</select></label>`:''}</div>
      ${this.history?`<div class="ba-history"><div class="ba-history-heading"><h3>最近对话</h3><button class="ba-icon-button" data-a="history" aria-label="返回当前对话" title="返回当前对话">${icon('close')}</button></div>${this.topics.map(t=>`<button data-a="select" data-id="${esc(t.topic_id)}">${icon('history')}<span>${esc(t.name)}<small>${new Date(t.updated_at).toLocaleDateString()}</small></span>${icon('arrow')}</button>`).join('')}</div>`:`<div class="ba-body"><div data-timeline class="ba-timeline" aria-live="polite"></div>${this.formOpen?this.form():''}</div>`}
      <footer class="ba-composer"><div data-uploads class="ba-uploads"></div><p data-status role="status"></p>${this.viewConflict?'<button data-a="recover-view">恢复最新会话并保留未发送文字</button>':''}<small data-qa-price></small><div class="ba-input-shell"><textarea data-composer ${this.busy?'disabled':''} rows="2" maxlength="12000" placeholder="说说你的问题或任务要求…" aria-label="发送给项目助手">${esc(this.text)}</textarea><div class="ba-send-row"><label class="ba-attach" title="添加附件">${icon('paperclip')}<span>添加附件</span><input type="file" data-file="other" multiple></label><button class="ba-send" data-a="send" title="${this.busy?'正在处理':'发送消息'}" aria-label="${this.busy?'正在处理':'发送消息'}"${this.busy||!this.workspace||!this.text.trim()?' disabled':''}>${icon(this.busy?'loading':'send')}</button></div></div><div class="ba-composer-hint">Enter 发送<span> · </span>Shift + Enter 换行</div></footer></section>`:'';
    // Keep the selected native input alive while upload completion redraws the panel.
    // Only reuse it within the same conversation/project, never across contexts.
    for(const fresh of this.host.querySelectorAll<HTMLInputElement>('input[type="file"]')){
      const old=pickers.get(pickerKey(fresh));
      if(old)fresh.replaceWith(old);else fresh.dataset.uploadContext=uploadContext;
    }
    this.syncLayout();
    if(this.open){this.paintTimeline();this.paintStatus();this.sizeComposer();
      if(this.busy)this.host.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('.ba-form input:not([type=file]),.ba-form select,.ba-form textarea').forEach(el=>el.disabled=true);
    }
  }
  private viewSafe():M4ViewState|undefined{return this.workspace?.view;}
}
