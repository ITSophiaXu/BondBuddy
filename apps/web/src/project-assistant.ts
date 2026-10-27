import { duplicateUploadMessage, isReusedUpload } from './duplicate-upload';
import { artifactFilename } from './artifact-download';
import { M4_DOCUMENT_TYPES,M4_DOCUMENT_LABELS,M4_DOCUMENT_MARKETS,MARKETS,MARKET_LABELS,MARKET_OFFERINGS,OFFERING_LABELS,emptyUpdateDetails,reportingWindow,
  sourceProspectusInputGaps,M1_UPLOAD_MIME_TYPES,M1_UPLOAD_LIMITS,
  type AssistantAction,type AssistantCard,type AssistantCardRequest,type AssistantResult,type M4Workspace,type M4Topic,
  type M4MessageContext,type M4ViewState,type M4QuoteResponse,type M4DocumentType,type M4MaterialPin,type Market,type Offering } from '@bondbuddy/contracts';
import { ApiClient,ApiError,friendlyError,type Dto } from './api';
import { UserFacingError, type ErrorOperation } from './user-facing-error';
import { M4Api } from './m4-api';
import { ReviewApi } from './review-api';
import { executionRequest } from './execution-request';
import { sourceFields,readSourceFields } from './source-prospectus';
import { cutoffSelection,quarterCutoff,QUARTER_ENDS } from './reporting-cutoff';
import { taskProgress } from './task-progress';
import { taskHref,taskView } from './project-collection-model';
import { esc } from './ui';
import { assistantIcon as icon } from './assistant-icons';
import { AssistantUploadRecovery, AssistantUploadRecoveryError, type AssistantUploadEntry } from './assistant-upload-recovery';
import { AssistantTemplateUploadRecovery, assistantTemplateUploadRecordMatches, type AssistantTemplateUploadEnvelope, type AssistantTemplateUploadResult } from './assistant-template-upload-recovery';
import { AssistantProjectCopyRecovery, assistantProjectCopyRecordMatches, type AssistantProjectCopyEnvelope, type AssistantProjectCopyResult } from './assistant-project-copy-recovery';
import { AssistantViewCache, AssistantViewCacheError, assistantSame, assertAssistantTemplateClear, withAssistantTopicWrite, type AssistantViewSnapshot, type AssistantViewCacheRecord } from './assistant-view-cache';
import { UploadRecoveryNeedsFileError, UploadRecoveryConflictError, UploadRecoveryStorageError, UploadRecoveryLockError, UploadRecoveryReceiptError, type UploadRecoveryRecord, type UploadRecoveryJson } from './upload-recovery';
import './project-assistant.css';

type ProjectData={project:Dto<'ProjectResponse'>;materials:Dto<'MaterialResponse'>[];results:AssistantResult[]};
type PreparationGuard={topic:string;project:string;snapshot:AssistantViewSnapshot;cache:AssistantViewCacheRecord;data:ProjectData|undefined};
type EnsureProjectResult={kind:'ready';data:ProjectData;guard:PreparationGuard}|{kind:'blocked';reason:string};
type Upload={id:string;topic:string;kind:'material'|'template'|'copy';filename:string;started?:boolean;file?:File;role:Dto<'UploadCreateRequest'>['role'];project:string;status:string;error?:string;hash?:string;session?:Dto<'UploadSessionResponse'>;requestUploadId?:string;bytesSaved?:boolean;material?:Dto<'MaterialResponse'>;associated?:boolean;templateSaved?:boolean;recovery?:UploadRecoveryRecord;preparation?:Promise<void>;needsFile?:boolean};
const uploadReady=(u:Upload)=>!!u.material&&u.associated===true&&(u.kind!=='template'||u.templateSaved===true);
const uploadReused=(u:Upload)=>!!u.material&&(u.kind==='material'?!!u.requestUploadId&&u.material.upload_id!==u.requestUploadId:isReusedUpload(u.material,u.session));
const emptyContext=():M4MessageContext=>({document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null});
const finished=(state:string)=>['succeeded','test_completed','failed','cancelled','rejected'].includes(state);
const businessName=(b:AssistantAction['business'])=>({update:'更新募集书',review:'复核募集书',generation:'材料生成'})[b];
const option=(v:string,label:string,selected?:unknown)=>`<option value="${esc(v)}"${v===selected?' selected':''}>${esc(label)}</option>`;
const pin=(project:string,m:Dto<'MaterialResponse'>):M4MaterialPin=>({source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256});
class AssistantInputError extends UserFacingError {}
const assistantError=(e:unknown,operation:ErrorOperation='action')=>e instanceof UploadRecoveryNeedsFileError?`“${e.record.declaration.filename}”还需重新选择原文件，请选择内容相同的文件再确认。`:e instanceof UploadRecoveryConflictError?'这个文件的保存记录与原操作不一致，请返回原对话核对。':e instanceof UploadRecoveryStorageError?'无法可靠保留文件的恢复信息，请保留原文件后重试。':e instanceof UploadRecoveryLockError?'另一页面正在处理此文件，或当前浏览器暂时无法继续，请稍后重试。':e instanceof UploadRecoveryReceiptError?'尚未确认这个文件已正确保存，请再次确认原文件。':e instanceof AssistantInputError||e instanceof AssistantUploadRecoveryError||e instanceof AssistantViewCacheError?e.message:friendlyError(e,operation);
const samePin=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const runLabel=(state:string)=>({queued:'排队等待处理',running:'正在处理',paused:'任务等待恢复',succeeded:'已完成',failed:'处理失败',cancelled:'已取消',rejected:'未能开始',test_completed:'测试任务已完成'}[state]??'正在读取进度');

/** Owned by the login session, outside the route root: navigation never tears down a conversation or upload. */
export class ProjectAssistant {
  private controller=new AbortController();
  private m4:M4Api;
  private materialUploads:AssistantUploadRecovery;
  private viewCache:AssistantViewCache;
  private assistantTemplateUploads?:AssistantTemplateUploadRecovery;
  private templateHelpers=new Map<string,AssistantTemplateUploadRecovery>();
  private templateEnvelopes:AssistantTemplateUploadEnvelope[]=[];
  private templateOrphans:UploadRecoveryRecord[]=[];
  private templateProblem='';private templatePreparing=false;private templateReading=false;
  private templateFiles=new Map<string,File>();private templateErrors=new Map<string,string>();private templateStatuses=new Map<string,string>();private templateNeedsFile=new Set<string>();
  private cacheQueue:Promise<void>=Promise.resolve();private cachePending=0;private cacheProblem='';
  private cacheBaselines=new Map<string,AssistantViewCacheRecord|null>();
  private editGeneration=0;private runtimeGeneration=0;private actionPending=0;private actionUncertain=false;
  private readingGeneration=0;
  private templateGeneration=0;
  private templateSaved=new Map<string,AssistantTemplateUploadEnvelope>();
  private assistantProjectCopies?:AssistantProjectCopyRecovery;
  private copyHelpers=new Map<string,AssistantProjectCopyRecovery>();
  private copyEnvelopes:AssistantProjectCopyEnvelope[]=[];
  private copyOrphans:UploadRecoveryRecord[]=[];
  private copyProblem='';private copyPreparing=false;private copyReading=false;
  private copyStatuses=new Map<string,string>();private copyErrors=new Map<string,string>();
  private copySaved=new Map<string,AssistantProjectCopyEnvelope>();
  private copyReadingGeneration=0;
  private conflictServer?:M4Workspace['view'];
  private storageChanged=(event:StorageEvent)=>{if(!this.live||!this.workspace)return;if(event.key===null||event.key.startsWith('bb-assistant-template-upload-v1:')||event.key.startsWith('bb-assistant-project-copy-v1:')||event.key.startsWith('bb-assistant-view-v1:')||event.key.startsWith('bondbuddy:upload-recovery:v1:')){this.scanCopies();this.scanTemplates();clearTimeout(this.saveTimer);this.paint();if(this.templateEnvelopes.length)void this.readTemplates();if(this.copyEnvelopes.length)void this.readCopies();}};
  private host=document.createElement('div');
  private dock=document.createElement('button');
  private narrow=window.matchMedia('(max-width:960px)');
  private resize=()=>this.syncLayout();
  private open=false;
  private embeddedProject?:string;
  private embedPending=false;
  async embedProject(container:HTMLElement,projectId:string){
    this.embeddedProject=projectId;container.append(this.host);this.host.classList.add('ba-embedded');this.open=true;
    if(this.workspace?.topic.source_project_id!==projectId){
      if(this.busy){this.embedPending=true;this.paint();return;}
      await this.work(async()=>{this.topics=(await this.m4.topics()).topics.filter(t=>t.surface==='assistant');
        if(this.embeddedProject!==projectId)return;
        const topic=this.topics.find(t=>t.source_project_id===projectId);
        if(topic)await this.select(topic.topic_id);else await this.newConversation(projectId);
      });
    }
    this.paint();
  }
  detachProject(){if(!this.embeddedProject)return;this.embeddedProject=undefined;this.embedPending=false;document.body.append(this.host);this.host.classList.remove('ba-embedded');this.open=false;this.paint();}
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
  private uploadRecoveryBlocked=false;
  private formOpen=false;
  private viewConflict=false;
  private conversationRequest?:{projectId?:string;key:string};
  private projects:Dto<'ProjectListResponse'>['items']=[];
  private event=(event:Event)=>{const d=(event as CustomEvent<{projectId:string;artifactId?:string}>).detail;void this.work(async()=>{await this.newConversation(d.projectId);if(d.artifactId){const result=this.data?.results.find(r=>r.pin.artifact_id===d.artifactId);if(result)this.workspace!.view.unsent_context.reading_artifact=result.pin;}
    this.open=true;this.formOpen=false;this.changed();},'submit');};
  constructor(private api:ApiClient,private owner:string){
    this.m4=new M4Api(api,this.controller.signal);this.materialUploads=new AssistantUploadRecovery(api,this.m4,owner,()=>this.live,{coordinatePrepare:topic=>{if(this.workspace?.topic.topic_id===topic&&(this.templatePreparing||this.copyPreparing||this.copyReading||this.copyProblem||this.viewConflict||this.cacheProblem||this.actionUncertain))throw new AssistantInputError('请先核对原模板、材料复用及完整会话草稿，再添加材料。');}});this.viewCache=new AssistantViewCache(api,owner,()=>this.live);this.host.className='bb-assistant';document.body.append(this.host);
    this.dock.type='button';this.dock.className='ba-dock';this.dock.dataset.assistantDock='';
    this.dock.setAttribute('aria-controls','ba-panel');
    this.dock.innerHTML=icon('buddy')+'<i data-active-dot aria-hidden="true"></i>';
    this.dock.addEventListener('click',()=>void this.setOpen(true));document.body.append(this.dock);
    this.narrow.addEventListener('change',this.resize);
    this.host.addEventListener('click',e=>void this.click(e));
    this.host.addEventListener('input',e=>this.input(e));
    this.host.addEventListener('change',e=>void this.change(e));
    this.host.addEventListener('keydown',e=>{if(e.key==='Escape'&&this.open&&!this.embeddedProject){e.preventDefault();void this.setOpen(false);}
      if(e.key==='Tab'&&this.narrow.matches&&!this.embeddedProject){const items=[...this.host.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')].filter(el=>el.getClientRects().length);
        const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
      if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&(e.target as HTMLElement).matches('[data-composer]')){e.preventDefault();void this.work(()=>this.send(),'submit');}});
    window.addEventListener('bondbuddy:assistant',this.event);window.addEventListener('storage',this.storageChanged);this.paint();
  }
  dispose(){this.controller.abort();clearTimeout(this.timer);clearTimeout(this.saveTimer);window.removeEventListener('bondbuddy:assistant',this.event);window.removeEventListener('storage',this.storageChanged);this.narrow.removeEventListener('change',this.resize);this.open=false;this.syncLayout();this.host.remove();this.dock.remove();}
  mount(){
    if(!this.host.isConnected)document.body.append(this.host);
    if(!this.dock.isConnected)document.body.append(this.dock);
    const navigation=document.querySelector('.sidebar nav[aria-label="账号"]');
    if(navigation&&!navigation.querySelector('[data-assistant-restore]')){
      const button=document.createElement('button');button.type='button';button.className='nav-item assistant-restore';button.dataset.assistantRestore='';
      button.innerHTML=icon('buddy')+'<span>BondBuddy</span>';
      button.title='打开或恢复 BondBuddy';
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
    dock.setAttribute('aria-label','打开 BondBuddy');
    dock.setAttribute('aria-expanded',String(this.open));
    dock.title='打开 BondBuddy';
    dock.querySelector('[data-active-dot]')?.classList.toggle('is-active',this.active);
  }
  private syncLayout(){
    const app=document.querySelector<HTMLElement>('.prototype-app');if(app)app.inert=this.open&&this.narrow.matches&&!this.embeddedProject;
    this.host.querySelector('.ba-panel')?.setAttribute('aria-modal',String(this.narrow.matches&&!this.embeddedProject));
    if(this.embeddedProject)this.host.querySelector('.ba-panel')?.setAttribute('role','region');
  }
  private get live(){return !this.controller.signal.aborted;}
  private get view(){return this.workspace!.view;}
  private get action(){return this.workspace?.view.assistant?.action??null;}
  private scopeCurrent(topic:string,project:string){return this.live&&this.workspace?.topic.topic_id===topic&&this.workspace.topic.project_id===project;}
  private runtimeSnapshot():AssistantViewSnapshot['runtime']{
    const identity=JSON.parse(JSON.stringify({quote:this.qaQuote?{content:this.qaQuote.content,key:this.qaQuote.key,quote_id:this.qaQuote.value.quote.quote_id}:null,messages:(this.workspace?.messages??[]).map(m=>({id:m.message_id,version:m.version,role:m.role,status:m.reply_status,run:m.run_id})),cards:this.cards.map(c=>({id:c.card_id,token:c.draft_token,execution:c.execution_request_id,run:c.run?{id:c.run.run_id,state:c.run.state}:null})),active_run:this.workspace?.active_run?{id:this.workspace.active_run.run_id,state:this.workspace.active_run.state}:null,project:this.data?{id:this.data.project.project_id,revision:this.data.project.draft_revision}:null})) as UploadRecoveryJson;
    return {generation:this.runtimeGeneration,pending:this.actionPending>0,uncertain:this.actionUncertain,identity};
  }
  private viewSnapshot():AssistantViewSnapshot|undefined{
    if(!this.workspace)return;const {version,...view}=structuredClone(this.view);view.unsent_content=this.text;
    return {version,view,dirty:this.viewDirty,conflict:this.viewConflict,generation:this.editGeneration,runtime:this.runtimeSnapshot()};
  }
  private localEditingAllowed(){return this.templatePreparing||this.templateEnvelopes.length>0||this.copyPreparing||this.copyReading||this.copyEnvelopes.length>0||this.copyOrphans.length>0;}
  private preparationGuard():PreparationGuard{
    if(!this.workspace||this.cacheProblem)throw new AssistantInputError(this.cacheProblem||'原会话尚未可靠读取。');const snapshot=this.viewSnapshot()!,topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id,cache=this.viewCache.read(topic,project);
    if(!cache||!assistantSame(cache.snapshot,snapshot)||snapshot.dirty||snapshot.conflict||snapshot.runtime.pending||snapshot.runtime.uncertain)throw new AssistantInputError('请先可靠保存完整输入，再核对本次任务。');
    return {topic,project,snapshot:structuredClone(snapshot),cache:structuredClone(cache),data:this.data?structuredClone(this.data):undefined};
  }
  private assertPreparation(guard:PreparationGuard){
    if(!this.scopeCurrent(guard.topic,guard.project)||this.cacheProblem||!assistantSame(this.viewSnapshot(),guard.snapshot)||!assistantSame(this.data,guard.data)||!assistantSame(this.viewCache.read(guard.topic,guard.project),guard.cache))throw new AssistantInputError('完整输入或任务状态已改变，已保留本页输入，请重新核对本次任务。');
  }
  private async preparationRead<T>(guard:PreparationGuard,read:()=>Promise<T>):Promise<T>{this.assertPreparation(guard);const result=await read();this.assertPreparation(guard);return result;}
  private async preparationWrite<T>(guard:PreparationGuard,write:()=>Promise<T>):Promise<T>{
    this.assertPreparation(guard);const result=await this.businessWrite(guard.topic,write,()=>this.assertPreparation(guard));await this.cacheQueue;
    const current=this.viewSnapshot();if(!current||!this.scopeCurrent(guard.topic,guard.project)||current.version!==guard.snapshot.version||current.generation!==guard.snapshot.generation||current.dirty!==guard.snapshot.dirty||current.conflict!==guard.snapshot.conflict||!assistantSame(current.view,guard.snapshot.view)||current.runtime.generation!==guard.snapshot.runtime.generation+2||current.runtime.pending||current.runtime.uncertain||!assistantSame(current.runtime.identity,guard.snapshot.runtime.identity)||!assistantSame(this.data,guard.data))throw new AssistantInputError('本页完整输入或任务状态已变化，请核对后再继续；已提交的步骤保留。');
    const next=this.preparationGuard();Object.assign(guard,next);return result;
  }
  private cache(){if(!this.workspace)return;this.queueViewCache(this.workspace.topic.topic_id,this.workspace.topic.project_id,this.viewSnapshot()!);}
  private queueViewCache(topic:string,project:string,next:AssistantViewSnapshot){
    const sent=structuredClone(next),key=`${project}:${topic}`;this.cachePending++;
    this.cacheQueue=this.cacheQueue.then(async()=>{if(!this.live)return;try{const baseline=this.cacheBaselines.get(key)??null,p=baseline?.proof;if(p&&sent.dirty&&sent.version===p.base.version&&!assistantSame(sent.view,p.base.view))sent.conflict=true;const result=await this.viewCache.merge(topic,project,baseline,sent);if(!this.live)return;if(result.accepted)this.cacheBaselines.set(key,result.record);if(this.scopeCurrent(topic,project)){this.cacheProblem=result.accepted?'':'另一页面已有不同的完整会话草稿。本页输入仍在，尚未安全缓存，请保持页面打开后核对。';const current=this.viewSnapshot();if(result.accepted&&result.record.snapshot.conflict&&current?.version===sent.version&&current.generation===sent.generation&&assistantSame(current.view,sent.view))this.viewConflict=true;if(this.cacheProblem){clearTimeout(this.saveTimer);this.error=this.cacheProblem;this.paintStatus();}}}catch(e){if(this.scopeCurrent(topic,project)){this.cacheProblem=assistantError(e,'save');clearTimeout(this.saveTimer);this.error=this.cacheProblem;this.paintStatus();}}}).finally(()=>{this.cachePending--;});
  }
  private setupTemplateRecovery(){
    if(!this.workspace)return;const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id,key=`${project}:${topic}`;let helper=this.templateHelpers.get(key);
    if(!helper){helper=new AssistantTemplateUploadRecovery(this.api,this.m4,this.owner,project,topic,{current:()=>this.scopeCurrent(topic,project),snapshot:()=>this.scopeCurrent(topic,project)?this.viewSnapshot():undefined,signal:this.controller.signal});this.templateHelpers.set(key,helper);}this.assistantTemplateUploads=helper;this.scanTemplates();
  }
  private scanTemplates(){
    if(!this.assistantTemplateUploads)return;try{const envelopes=this.assistantTemplateUploads.list(),records=this.assistantTemplateUploads.transportRecords();this.templateEnvelopes=envelopes;this.templateOrphans=records.filter(r=>!envelopes.some(e=>e.items.some(i=>assistantTemplateUploadRecordMatches(e,i.index,r))));if(this.workspace&&!envelopes.length&&!this.templateOrphans.length&&!this.copyEnvelopes.length&&!this.copyOrphans.length&&!this.copyPreparing)assertAssistantTemplateClear(this.api,this.owner,this.workspace.topic.topic_id,()=>this.live);this.templateProblem='';for(const e of envelopes)if(e.items[0].templateReceipt)this.templateSaved.set(e.id,e);}catch(e){this.templateProblem=assistantError(e,'read');}
  }
  private templateBlocked(show=true){
    this.scanCopies();this.scanTemplates();const blocked=this.templatePreparing||this.templateReading||this.copyPreparing||this.copyReading||!!this.copyProblem||!!this.copyEnvelopes.length||!!this.copyOrphans.length||!!this.templateProblem||!!this.templateEnvelopes.length||!!this.templateOrphans.length||!!this.cacheProblem||this.viewConflict||this.actionUncertain;
    if(blocked){clearTimeout(this.saveTimer);if(show){this.error=this.cacheProblem||this.copyProblem||this.templateProblem||(this.actionUncertain?'原业务请求结果尚未确认，请先在原会话核对消息与任务。本页完整输入已保留。':this.viewConflict?'本页完整会话与服务器不同，请先核对两份输入。':this.copyPreparing||this.copyReading||this.copyEnvelopes.length||this.copyOrphans.length?'请先核对原材料复用待办，完整输入会保留。':'请先继续核对原券商模板保存或停止本机后续保存。本页完整输入会保留。');this.paintStatus();}}return blocked;
  }
  private async ordinaryWrite<T>(topic:string,action:()=>Promise<T>):Promise<T>{
    const current=()=>this.live&&this.workspace?.topic.topic_id===topic;return withAssistantTopicWrite(this.owner,topic,current,{},async()=>{assertAssistantTemplateClear(this.api,this.owner,topic,current);if(this.templatePreparing||this.templateReading||this.copyPreparing||this.copyReading||this.copyProblem||this.viewConflict||this.cacheProblem||this.actionUncertain)throw new AssistantInputError('原模板、材料复用或完整会话仍待核对，当前未提交新的业务请求。');return action();},this.controller.signal);
  }
  private async businessWrite<T>(topic:string,action:()=>Promise<T>,before?:()=>void):Promise<T>{
    return this.ordinaryWrite(topic,async()=>{before?.();const original=this.viewSnapshot();this.actionPending++;this.runtimeGeneration++;let sent=false;try{this.cache();await this.cacheQueue;if(this.cacheProblem||!this.live||this.workspace?.topic.topic_id!==topic)throw new AssistantInputError(this.cacheProblem||'原会话已变化，尚未提交业务请求。');if(before){const current=this.viewSnapshot();if(!original||!current||current.version!==original.version||current.generation!==original.generation||!assistantSame(current.view,original.view)||current.runtime.generation!==original.runtime.generation+1||!assistantSame(current.runtime.identity,original.runtime.identity))throw new AssistantInputError('等待保存时完整输入已变化，当前未提交新的业务请求。');}assertAssistantTemplateClear(this.api,this.owner,topic,()=>this.live&&this.workspace?.topic.topic_id===topic);sent=true;return await action();}catch(e){if(sent&&!(e instanceof ApiError&&e.status>=400&&e.status<500))this.actionUncertain=true;throw e;}finally{this.actionPending--;this.runtimeGeneration++;this.cache();}});
  }
  private setupCopyRecovery(){
    if(!this.workspace)return;const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id,key=`${project}:${topic}`;let helper=this.copyHelpers.get(key);
    if(!helper){helper=new AssistantProjectCopyRecovery(this.api,this.m4,this.owner,project,topic,{current:()=>this.scopeCurrent(topic,project),snapshot:()=>this.scopeCurrent(topic,project)?this.viewSnapshot():undefined,projectData:id=>this.projectData(id),signal:this.controller.signal});this.copyHelpers.set(key,helper);}this.assistantProjectCopies=helper;this.scanCopies();
  }
  private scanCopies(){
    if(!this.assistantProjectCopies)return;try{const envelopes=this.assistantProjectCopies.list(),records=this.assistantProjectCopies.transportRecords();this.copyEnvelopes=envelopes;this.copyOrphans=records.filter(r=>!envelopes.some(e=>e.items.some(i=>assistantProjectCopyRecordMatches(e,i.index,r))));this.copyProblem=!envelopes.length&&(this.viewSafe()?.assistant?.copy_source_project_id||this.viewSafe()?.assistant?.project_creation_request_id)?'原材料复用缺少完整恢复记录，请保留当前输入并核对原项目，暂不能继续原操作。':'';for(const e of envelopes)if(e.targetProjectId)this.copySaved.set(e.id,e);}catch(error){this.copyProblem=assistantError(error,'read');}
  }
  private applyAssistantProjectCopyResult(result:AssistantProjectCopyResult):boolean{
    const e=result.envelope;if(e.targetProjectId)this.copySaved.set(e.id,structuredClone(e));if(e.owner!==this.owner||!this.scopeCurrent(e.topicId,e.scopeProjectId))return false;
    const current=this.viewSnapshot(),saved:AssistantViewSnapshot={...structuredClone(e.basePage),version:e.basePage.version+1,view:structuredClone(e.expectedView??e.basePage.view),dirty:false,conflict:false};let cached:AssistantViewCacheRecord|null=null;try{cached=this.viewCache.read(e.topicId,e.scopeProjectId);}catch(error){this.cacheProblem=assistantError(error,'read');}
    const matches=!!current&&(assistantSame(current,e.basePage)||assistantSame(current,saved));
    const apply=result.state==='complete'&&result.applyToPage&&!!result.view&&!!result.targetData&&!!e.expectedView&&e.localCacheResult==='patched'&&matches&&!this.cacheProblem&&!!cached&&assistantSame(cached.snapshot,saved)&&result.view.version===saved.version&&assistantSame(this.fullView(result.view),saved.view)&&result.targetData.project.project_id===e.targetProjectId&&!!e.observedTarget&&assistantSame(result.targetData.project,e.observedTarget);
    if(apply){this.workspace!.view=structuredClone(result.view!);this.text=saved.view.unsent_content;this.viewDirty=false;this.viewConflict=false;this.conflictServer=undefined;this.queueViewCache(e.topicId,e.scopeProjectId,saved);this.data=structuredClone(result.targetData!);this.qaQuote=undefined;this.runtimeGeneration++;this.cache();for(const item of e.items)if(item.targetPin&&item.material&&item.membership==='confirmed'&&!this.workspace!.materials.some(p=>assistantSame(p,item.targetPin))){this.workspace!.materials.push(structuredClone(item.targetPin));this.workspace!.material_details.push({...structuredClone(item.targetPin),filename:item.material.filename,state:item.material.state,media_type:item.material.media_type,role:item.material.role});}this.status='原材料已复用到目标项目，完整会话已保存。请核对本次任务后开始。';}
    else{const alreadyRead=!!current&&!current.dirty&&!current.conflict&&!!result.view&&current.version===result.view.version&&assistantSame(current.view,this.fullView(result.view))&&this.data?.project.project_id===e.targetProjectId;if(result.view&&!alreadyRead||current?.dirty&&current.version===e.basePage.version&&!assistantSame(current.view,e.basePage.view)){this.viewConflict=true;this.cache();}else if(alreadyRead)this.cache();this.status=result.reason||(e.observedTarget?'目标项目信息已保存，尚未用于当前完整输入。':e.targetProjectId?'目标项目已建立，原材料复用仍待核对。':'原材料复用结果待核对，完整输入已保留。');}
    this.templateGeneration++;return apply;
  }
  private clearCopyProgress(id:string){for(const key of this.copyStatuses.keys())if(key===id||key.startsWith(`${id}:`))this.copyStatuses.delete(key);}
  private async readCopies(){
    if(!this.assistantProjectCopies||this.copyReading||!this.workspace||!this.live)return;const helper=this.assistantProjectCopies,topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id,read=++this.copyReadingGeneration;this.copyReading=true;
    try{this.scanCopies();for(const envelope of [...this.copyEnvelopes]){try{const result=await helper.reconcile(envelope.id);if(!this.scopeCurrent(topic,project)||read!==this.copyReadingGeneration)return;this.applyAssistantProjectCopyResult(result);this.clearCopyProgress(envelope.id);this.copyStatuses.set(envelope.id,result.reason??this.status);}catch(error){if(this.scopeCurrent(topic,project)&&read===this.copyReadingGeneration){this.clearCopyProgress(envelope.id);this.copyErrors.set(envelope.id,assistantError(error,'read'));}}}}finally{if(this.scopeCurrent(topic,project)&&read===this.copyReadingGeneration){this.copyReading=false;this.scanCopies();this.paint();}}
  }
  private async resumeCopy(id:string,explicit=true):Promise<{result:AssistantProjectCopyResult;applied:boolean}|undefined>{
    const helper=this.assistantProjectCopies;if(!helper||!this.workspace)return;this.scanCopies();const e=this.copyEnvelopes.find(e=>e.id===id);if(!e)throw new AssistantInputError('原材料复用记录已变化，请重新读取。');const topic=e.topicId,project=e.scopeProjectId,wasPreparing=this.copyPreparing;this.copyPreparing=true;this.templateGeneration++;this.copyErrors.delete(id);await this.cacheQueue;
    try{const result=await helper.resume(id,{retryTargetCreate:explicit,retryMembership:explicit,retryTargetPatch:explicit,retryView:explicit,status:(message,index)=>{if(this.scopeCurrent(topic,project)){this.copyStatuses.set(index===undefined?id:`${id}:${index}`,message);this.paintStatus();}},progress:(loaded,total,index)=>{if(this.scopeCurrent(topic,project)){this.copyStatuses.set(`${id}:${index}`,`正在保存文件 ${Math.round(loaded/total*100)}%`);this.paintStatus();}}});if(!this.scopeCurrent(topic,project))return;const applied=this.applyAssistantProjectCopyResult(result);this.clearCopyProgress(id);this.copyStatuses.set(id,result.reason??this.status);await this.cacheQueue;return {result,applied};}
    catch(error){if(this.scopeCurrent(topic,project)){this.clearCopyProgress(id);this.copyErrors.set(id,assistantError(error,'save'));const current=this.viewSnapshot();if(current?.dirty&&current.version===e.basePage.version&&!assistantSame(current.view,e.basePage.view)){this.viewConflict=true;this.cache();}this.error=assistantError(error,'save');}throw error;}
    finally{if(this.scopeCurrent(topic,project)){this.copyPreparing=wasPreparing;this.scanCopies();this.paint();}}
  }
  private applyAssistantTemplateUploadResult(result:AssistantTemplateUploadResult):boolean{
    const e=result.envelope,item=e.items[0];if(item.templateReceipt)this.templateSaved.set(e.id,structuredClone(e));
    if(!this.scopeCurrent(e.topicId,e.projectId)||e.owner!==this.owner)return false;
    const saved:AssistantViewSnapshot={...structuredClone(e.basePage),version:e.basePage.version+1,view:structuredClone(item.expectedView??e.basePage.view),dirty:false,conflict:false};
    const current=this.viewSnapshot();let cached:AssistantViewCacheRecord|null=null;try{cached=this.viewCache.read(e.topicId,e.projectId);}catch(error){this.cacheProblem=assistantError(error,'read');}
    const matches=!!current&&(assistantSame(current,e.basePage)||assistantSame(current,saved));
    const apply=result.applyToPage&&!!result.view&&item.templateAvailability==='active'&&item.localCacheResult==='patched'&&matches&&!this.cacheProblem&&!!cached&&assistantSame(cached.snapshot,saved)&&result.view.version===saved.version&&assistantSame(this.fullView(result.view),saved.view);
    if(apply){this.workspace!.view=structuredClone(result.view!);this.text=saved.view.unsent_content;this.viewDirty=false;this.viewConflict=false;this.conflictServer=undefined;this.queueViewCache(e.topicId,e.projectId,saved);if(assistantSame(this.runtimeSnapshot(),e.basePage.runtime)){this.qaQuote=undefined;this.runtimeGeneration++;}this.cache();this.status='券商模板已保存并用于原立项任务，请重新核对任务后开始。';}
    else{if(result.view&&!assistantSame(current,saved)||current?.dirty&&current.version===e.basePage.version&&!assistantSame(current.view,e.basePage.view)){this.viewConflict=true;this.cache();}else if(result.view&&assistantSame(current,saved))this.cache();this.status=result.reason||(item.templateReceipt?'券商模板已保存，尚未用于当前完整输入。':'原模板保存结果待核对，当前完整输入已保留。');}
    if(item.templateReceipt&&item.templateAvailability==='active'){
      if(!this.workspace!.templates.some(t=>t.template_id===item.templateReceipt!.template_id&&t.template_version===item.templateReceipt!.template_version))this.workspace!.templates.push(structuredClone(item.templateReceipt));
      if(item.material&&!this.workspace!.materials.some(p=>samePin(p,pin(e.projectId,item.material!)))){const p=pin(e.projectId,item.material);this.workspace!.materials.push(p);this.workspace!.material_details.push({...p,filename:item.material.filename,state:item.material.state,media_type:item.material.media_type,role:item.material.role});}
    }
    this.templateGeneration++;
    return apply;
  }
  private async readTemplates(){
    if(!this.assistantTemplateUploads||this.templateReading||!this.live)return;const helper=this.assistantTemplateUploads,topic=this.workspace!.topic.topic_id,project=this.workspace!.topic.project_id,read=++this.readingGeneration;this.templateReading=true;
    try{this.scanTemplates();for(const envelope of [...this.templateEnvelopes]){try{const result=await helper.reconcile(envelope.id);if(!this.scopeCurrent(topic,project)||read!==this.readingGeneration)return;this.applyAssistantTemplateUploadResult(result);this.templateStatuses.set(envelope.items[0].id,result.reason??(result.state==='template_unknown'?'模板创建结果待确认，请继续原保存。':'已读取原保存状态，尚未提交新的请求。'));}catch(error){if(this.scopeCurrent(topic,project)){this.templateStatuses.delete(envelope.items[0].id);this.templateErrors.set(envelope.items[0].id,assistantError(error,'read'));}}}}finally{if(this.scopeCurrent(topic,project)&&read===this.readingGeneration){this.templateReading=false;this.scanTemplates();this.paint();}}
  }
  private async beginTemplate(file:File){
    if(!this.workspace)return;if(this.templateBlocked())throw new AssistantInputError(this.error);
    if(this.action?.business!=='generation'||this.action.fields.document_type!=='init')throw new AssistantInputError('请先选择券商立项报告。');
    if(!this.action.fields.broker?.trim()){this.host.querySelector<HTMLInputElement>('[data-field="broker"]')?.focus();throw new AssistantInputError('请填写模板所属券商全称。');}
    if(!['sse','szse'].includes(this.action.fields.market??''))throw new AssistantInputError('请选择立项报告的发行市场。');
    if(!/\.docx$/i.test(file.name)||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes||file.name.length>200)throw new AssistantInputError('券商模板请选择一份非空 DOCX 文件，并符合文件大小限制。');
    await this.flush();await this.saving;await Promise.all(this.currentUploads().filter(u=>u.kind==='material').map(u=>u.preparation));await this.cacheQueue;if(this.currentUploads().some(u=>u.kind==='material'&&!uploadReady(u)))throw new AssistantInputError('请先完成或停止原附件保存，再上传券商模板。');if(this.templateBlocked())throw new AssistantInputError(this.error);
    const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id;this.templatePreparing=true;this.templateGeneration++;this.runtimeGeneration++;clearTimeout(this.saveTimer);this.paint();
    try{const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());if(!this.scopeCurrent(topic,project))return;this.cache();await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);const e=await this.assistantTemplateUploads!.prepare({filename:file.name,media_type:M1_UPLOAD_MIME_TYPES[0],byte_size:file.size,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),role:'other'});this.templateFiles.set(e.items[0].id,file);this.scanTemplates();await this.resumeTemplate(e.id,false);}finally{if(this.scopeCurrent(topic,project)){this.templatePreparing=false;this.scanTemplates();this.paint();}}
  }
  private async resumeTemplate(id:string,explicit=true){
    const helper=this.assistantTemplateUploads;if(!helper||!this.workspace)return;this.scanTemplates();const e=this.templateEnvelopes.find(e=>e.id===id);if(!e)throw new AssistantInputError('原模板保存待办已变化，请重新读取。');const item=e.items[0],topic=e.topicId,project=e.projectId,wasPreparing=this.templatePreparing;this.templatePreparing=true;this.templateGeneration++;this.templateErrors.delete(item.id);await this.cacheQueue;
    try{const result=await helper.resume(id,0,{file:this.templateFiles.get(item.id),retryMembership:explicit,retryTemplate:explicit,retryView:explicit,status:message=>{if(this.scopeCurrent(topic,project)){this.templateStatuses.set(item.id,message);this.paintStatus();}},progress:(loaded,total)=>{if(this.scopeCurrent(topic,project)){this.templateStatuses.set(item.id,`正在上传 ${Math.round(loaded/total*100)}%`);this.paintStatus();}}});if(this.scopeCurrent(topic,project)){this.templateNeedsFile.delete(item.id);this.applyAssistantTemplateUploadResult(result);this.templateStatuses.set(item.id,result.reason??(result.state==='template_unknown'?'模板创建结果待确认，请继续原保存。':result.state==='retryable'?'原会话尚未保存，请明确继续原保存。':this.status));}}
    catch(error){if(this.scopeCurrent(topic,project)){this.templateStatuses.delete(item.id);this.templateErrors.set(item.id,assistantError(error,'save'));if(error instanceof UploadRecoveryNeedsFileError)this.templateNeedsFile.add(item.id);const now=this.viewSnapshot();if(now?.dirty&&now.version===e.basePage.version&&!assistantSame(now.view,e.basePage.view)){this.viewConflict=true;this.cache();}this.error=assistantError(error,'save');}throw error;}
    finally{if(this.scopeCurrent(topic,project)){this.templatePreparing=wasPreparing;this.scanTemplates();this.paint();}}
  }
  private async resolveView(keepLocal:boolean){
    if(!this.workspace)return;this.scanCopies();this.scanTemplates();if(this.templatePreparing||this.templateReading||this.templateEnvelopes.length||this.templateOrphans.length||this.templateProblem||this.copyPreparing||this.copyReading||this.copyEnvelopes.length||this.copyOrphans.length||this.copyProblem)throw new AssistantInputError('请先核对或停止原模板及材料复用待办，再处理完整会话差异。');
    this.cache();await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id,original=this.viewSnapshot()!,server=await this.m4.workspace(topic);if(!this.scopeCurrent(topic,project)||!assistantSame(original,this.viewSnapshot()))throw new AssistantInputError('本页输入已变化，请重新核对两份完整会话。');
    const next:AssistantViewSnapshot={...structuredClone(original),version:server.view.version,view:keepLocal?structuredClone(original.view):this.fullView(server.view),dirty:keepLocal,conflict:false,generation:original.generation+1,runtime:{...original.runtime,pending:false,uncertain:original.runtime.uncertain||original.runtime.pending}};
    if(keepLocal&&next.view.assistant)next.view.assistant.draft_token=crypto.randomUUID();
    const result=await this.viewCache.resolve(topic,project,this.cacheBaselines.get(`${project}:${topic}`)??null,next);if(!this.scopeCurrent(topic,project)||!assistantSame(original,this.viewSnapshot()))throw new AssistantInputError('本页输入已变化，尚未替换当前输入。');this.cacheBaselines.set(`${project}:${topic}`,result.record);this.workspace.view={...structuredClone(next.view),version:next.version};this.text=next.view.unsent_content;this.editGeneration=next.generation;this.viewDirty=next.dirty;this.viewConflict=false;this.actionUncertain=next.runtime.uncertain;this.conflictServer=undefined;this.qaQuote=undefined;this.runtimeGeneration++;this.cache();this.status=keepLocal?'已将本机完整输入保留为新的待保存意图，请核对后再保存。':'已采用服务器完整会话。';
  }
  private async work(fn:()=>Promise<unknown>,operation:ErrorOperation='action'){
    if(this.busy||!this.live)return;this.busy=true;this.error='';this.paint();
    try{await fn();}catch(e){if(this.live){this.error=assistantError(e,operation);if(e instanceof ApiError&&['QUOTE_CHANGED','QUOTE_REQUIRED'].includes(e.code)){this.qaQuote=undefined;this.invalidateTask();}}}
    finally{this.busy=false;if(this.live){this.paint();if(this.error==='请填写模板所属券商全称。')this.host.querySelector<HTMLInputElement>('[data-field="broker"]')?.focus();if(this.error==='请选择立项报告的发行市场。')this.host.querySelector<HTMLSelectElement>('[data-field="market"]')?.focus();if(this.embedPending&&this.embeddedProject&&this.host.parentElement){this.embedPending=false;void this.embedProject(this.host.parentElement,this.embeddedProject);}else void this.drainUploads();}}
  }
  private invalidateTask(){if(!this.workspace)return;this.view.assistant!.draft_token=crypto.randomUUID();this.qaQuote=undefined;this.changed();this.paintTimeline();}
  private currentUploads(){return this.uploads.filter(u=>u.topic===this.workspace?.topic.topic_id);}
  private restoreUploads(topic:string){
    this.uploadRecoveryBlocked=true;
    for(const record of this.materialUploads.list(topic))if(!this.uploads.some(u=>u.id===record.id&&u.project===record.projectId))this.uploads.push({id:record.id,topic,kind:'material',filename:record.declaration.filename,role:record.declaration.role,project:record.projectId,status:record.material?'材料已保存，待确认加入原对话':'文件保存待确认',started:true,recovery:record});
    this.uploadRecoveryBlocked=false;
  }
  private async drainUploads(){
    if(this.busy||!this.live||!this.uploads.some(u=>!u.started&&!u.error))return;
    await this.work(async()=>{await Promise.all(this.uploads.filter(u=>!u.started&&!u.error).map(u=>u.preparation));for(const u of this.uploads.filter(u=>!u.started&&!u.error)){
      try{assertAssistantTemplateClear(this.api,this.owner,u.topic,()=>this.live);if(this.workspace?.topic.topic_id===u.topic&&this.templateBlocked(false))throw new AssistantInputError('原模板或完整会话待核对，请处理后明确继续原附件。');u.started=true;await this.upload(u);}catch(e){u.error=assistantError(e,'save');u.status='原模板或附件保存待核对';}
    }if(!this.live)return;if(this.data)this.data=await this.projectData(this.data.project.project_id);await this.poll();},'save');
  }
  private async init(){
    this.topics=(await this.m4.topics()).topics.filter(t=>t.surface==='assistant');
    const selected=sessionStorage.getItem(`bb-assistant:${this.owner}`),last=this.topics.find(t=>t.topic_id===selected)??this.topics[0];
    if(last)await this.select(last.topic_id);else await this.newConversation();
  }
  private async newConversation(projectId?:string){
    await this.flush();const source=projectId?await this.api.project(projectId,this.controller.signal):null;
    if(!this.conversationRequest||this.conversationRequest.projectId!==projectId)this.conversationRequest={projectId,key:crypto.randomUUID()};
    const result=await this.m4.create({creation_request_id:this.conversationRequest.key,name:source?`${source.name} · BondBuddy`:'新对话',surface:'assistant',...(source?{source_project_id:source.project_id}:{})});
    this.conversationRequest=undefined;this.topics.unshift(result.topic);await this.select(result.topic.topic_id);
    this.view.assistant={project_id:source?.project_id??null,action:null};
    if(source){this.data=await this.projectData(source.project_id);for(const m of this.data.materials.filter(m=>m.state==='persisted'))await this.businessWrite(this.workspace!.topic.topic_id,()=>this.m4.material(this.workspace!.topic.topic_id,pin(source.project_id,m)));}
    this.changed();await this.flush();this.history=false;this.formOpen=false;this.projectPicker=false;
  }
  private async select(id:string){
    await this.flush();await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);const token=++this.epoch;const w=await this.m4.workspace(id);if(!this.live||token!==this.epoch)return;
    this.workspace=w;this.templatePreparing=false;this.templateReading=false;this.copyPreparing=false;this.copyReading=false;this.readingGeneration++;this.copyReadingGeneration++;this.viewConflict=false;this.viewDirty=false;this.conflictServer=undefined;this.text=w.view.unsent_content;this.qaQuote=undefined;this.data=undefined;this.formOpen=false;this.status='';this.cacheProblem='';this.editGeneration=0;this.runtimeGeneration=0;this.actionUncertain=false;
    this.view.assistant??={project_id:w.topic.source_project_id,action:null};
    sessionStorage.setItem(`bb-assistant:${this.owner}`,id);
    if(this.view.assistant.project_id){this.data=await this.projectData(this.view.assistant.project_id);if(this.view.assistant.source_prospectuses)(this.data.project.update_details??=emptyUpdateDetails()).source_prospectuses=structuredClone(this.view.assistant.source_prospectuses);}
    this.cards=(await this.api.request<{cards:AssistantCard[]}>('GET',`/assistant/topics/${id}/cards`,undefined,{},this.controller.signal)).cards;
    if(!this.live||token!==this.epoch)return;
    try{const record=this.viewCache.read(id,w.topic.project_id);this.cacheBaselines.set(`${w.topic.project_id}:${id}`,record);if(record){const saved=record.snapshot;this.editGeneration=saved.generation;this.runtimeGeneration=saved.runtime.generation;this.actionUncertain=saved.runtime.uncertain||saved.runtime.pending;if(saved.dirty||saved.conflict){const serverView=structuredClone(w.view);this.conflictServer=serverView;this.workspace.view={...structuredClone(saved.view),version:saved.version};this.text=saved.view.unsent_content;this.viewDirty=saved.dirty;this.viewConflict=saved.conflict||serverView.version!==saved.version||!assistantSame(this.fullView(serverView),saved.view);this.formOpen=!!this.action;this.status='已恢复本机完整输入，请核对后继续。';}}}catch(e){this.cacheProblem=assistantError(e,'read');this.error=this.cacheProblem;}
    const restoredProject=this.view.assistant?.project_id;if(restoredProject&&this.data?.project.project_id!==restoredProject){this.data=await this.projectData(restoredProject);if(!this.live||token!==this.epoch)return;}if(this.data&&this.view.assistant?.source_prospectuses)(this.data.project.update_details??=emptyUpdateDetails()).source_prospectuses=structuredClone(this.view.assistant.source_prospectuses);
    this.setupCopyRecovery();this.setupTemplateRecovery();this.restoreUploads(id);this.history=false;this.projectPicker=false;
    if(this.templateEnvelopes.length||this.copyEnvelopes.length){if(this.viewDirty||this.viewConflict){this.cache();await this.cacheQueue;}if(this.templateEnvelopes.length)await this.readTemplates();if(this.copyEnvelopes.length)await this.readCopies();}else if(!this.cacheProblem&&!this.viewDirty&&!this.viewConflict)this.cache();
    void this.poll();
  }
  private projectData(id:string){return this.api.request<ProjectData>('GET',`/assistant/projects/${encodeURIComponent(id)}`,undefined,{},this.controller.signal);}
  private fullView(view:M4Workspace['view']){const {version:_version,...full}=structuredClone(view);return full;}
  private changed(){this.viewDirty=true;this.editGeneration++;this.cache();clearTimeout(this.saveTimer);if(!this.templateBlocked(false))this.saveTimer=setTimeout(()=>void this.flush().catch(e=>{this.error=assistantError(e,'save');this.paint();}),500);}
  private async flush(){
    clearTimeout(this.saveTimer);
    this.saving=this.saving.catch(()=>{}).then(async()=>{
      if(!this.workspace||!this.viewDirty||!this.live)return;
      this.cache();await this.cacheQueue;if(this.templateBlocked(false))return;
      const w=this.workspace,snapshot=this.viewSnapshot()!,generation=this.editGeneration;this.view.unsent_content=this.text;
      try{const result=await this.ordinaryWrite(w.topic.topic_id,async()=>{if(!assistantSame(this.viewSnapshot(),snapshot))throw new AssistantInputError('本页输入已更新，稍后保存完整输入。');return this.m4.view(w.topic.topic_id,{expected_version:snapshot.version,view:snapshot.view});});
        if(this.scopeCurrent(w.topic.topic_id,w.topic.project_id)&&this.workspace!.view===w.view){this.view.version=result.view.version;if(this.editGeneration===generation&&assistantSame(this.fullView(this.view),snapshot.view))this.viewDirty=false;this.cache();}}
      catch(e){if(this.scopeCurrent(w.topic.topic_id,w.topic.project_id)){this.viewDirty=true;if(e instanceof ApiError&&e.code==='INPUT_REVISION_CONFLICT')this.viewConflict=true;this.cache();}throw e;}
    });return this.saving;
  }
  private async poll(){
    clearTimeout(this.timer);if(!this.live||!this.workspace)return;const id=this.workspace.topic.topic_id,token=this.epoch,templateGeneration=this.templateGeneration;
    try{const [w,c]=await Promise.all([this.m4.workspace(id),this.api.request<{cards:AssistantCard[]}>('GET',`/assistant/topics/${id}/cards`,undefined,{},this.controller.signal)]);
      if(!this.live||token!==this.epoch)return;
      // Keep local typing and explicit draft choices. Server replies are immutable.
      const protectedLists=this.templatePreparing||this.templateReading||this.templateEnvelopes.length>0||this.copyPreparing||this.copyReading||this.copyEnvelopes.length>0||templateGeneration!==this.templateGeneration;this.workspace={...w,...(protectedLists?{templates:this.workspace.templates,materials:this.workspace.materials,material_details:this.workspace.material_details}:{}),view:this.workspace.view};if(templateGeneration===this.templateGeneration)this.cards=c.cards;if(this.viewConflict)this.conflictServer=structuredClone(w.view);
      if(this.open&&!this.busy)this.paintTimeline();
      const active=w.messages.some(m=>m.role==='user'&&!['completed','failed'].includes(m.reply_status))||c.cards.some(c=>c.run&&!finished(c.run.state));
      this.active=active;this.paintDock();
    }catch(e){if(this.live&&this.open){this.status='连接暂时中断，已提交任务继续运行。';this.paintStatus();}}
    if(this.live&&token===this.epoch)this.timer=setTimeout(()=>void this.poll(),this.open?4000:12000);
  }
  private context():M4MessageContext{return {...this.view.unsent_context,document_type:null,draft_version:0};}
  private async send(){
    if(!this.text.trim()||!this.workspace)return;
    if(this.templateBlocked())throw new AssistantInputError(this.error);
    if(this.uploadRecoveryBlocked)throw new AssistantInputError('本机附件记录未能可靠读取，请保留文件并重新打开原对话后再继续。');
    if(this.workspace.messages.some(m=>m.role==='user'&&!['completed','failed'].includes(m.reply_status)))throw new AssistantInputError('请等待本轮回复后继续。');
    if(this.currentUploads().some(u=>!uploadReady(u)))throw new AssistantInputError('请先确认附件已保存并加入原对话，或停止本机追踪。');
    await this.flush();const id=this.workspace.topic.topic_id,content=this.text.trim(),context=this.context();
    if(!this.qaQuote||this.qaQuote.content!==content){const value=await this.businessWrite(id,()=>this.m4.quote(id,{kind:'qa',content,context}));this.qaQuote={value,content,key:crypto.randomUUID()};this.runtimeGeneration++;this.cache();if(value.quote.points>0)return;}
    const q=this.qaQuote;if(q.value.shortage>0)throw new AssistantInputError('积分不足，请充值后重新发送。');
    await this.businessWrite(id,()=>this.m4.message(id,{submission_request_id:q.key,content,context,quote_id:q.value.quote.quote_id}));
    this.text='';this.qaQuote=undefined;this.changed();await this.flush();await this.poll();
  }
  private async useAction(action:AssistantAction){
    if(!this.workspace)return;
    if(this.templateBlocked())throw new AssistantInputError(this.error);
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
  private async ensureProject():Promise<EnsureProjectResult>{
    if(!this.action||!this.workspace||this.action.business==='generation')return {kind:'blocked',reason:'请先选择更新或复核任务。'};
    if(this.templateBlocked())return {kind:'blocked',reason:this.error};const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id;
    await this.flush();await this.saving;await Promise.all(this.currentUploads().filter(u=>u.kind==='material').map(u=>u.preparation));await this.cacheQueue;
    if(!this.scopeCurrent(topic,project))return {kind:'blocked',reason:'原会话已变化，当前输入已保留。'};if(this.templateBlocked())return {kind:'blocked',reason:this.error};
    if(this.currentUploads().some(u=>!uploadReady(u)))return {kind:'blocked',reason:'请先完成或停止原附件保存，再核对本次任务。'};
    const guard=this.preparationGuard(),input=structuredClone(this.projectInput());if(!input.issuer_name||!input.market||!input.offering||!input.update_details?.reporting_cutoff)throw new AssistantInputError('请先填写发行人、市场、品种和最新报告期。');
    const sourceProjectId=this.data?.project.project_id??project,source=await this.preparationRead(guard,()=>this.projectData(sourceProjectId));
    if(source.project.kind===input.kind){
      if(this.data&&source.project.draft_revision!==this.data.project.draft_revision)throw new AssistantInputError('原项目已在其他页面改变，请核对项目信息后继续。');const {kind,...patch}=input;
      const updated=await this.preparationWrite(guard,()=>this.api.patch(sourceProjectId,source.project.draft_revision,patch));this.data={...structuredClone(source),project:updated};this.runtimeGeneration++;const expected=this.viewSnapshot()!,data=structuredClone(this.data);this.cache();await this.cacheQueue;if(!this.scopeCurrent(topic,project)||!assistantSame(this.viewSnapshot(),expected)||!assistantSame(this.data,data))throw new AssistantInputError('本页完整输入已变化，请重新核对本次任务。');return {kind:'ready',data:this.data,guard:this.preparationGuard()};
    }
    this.copyPreparing=true;this.templateGeneration++;this.runtimeGeneration++;clearTimeout(this.saveTimer);this.paint();
    try{this.cache();await this.cacheQueue;if(!this.scopeCurrent(topic,project)||this.cacheProblem)throw new AssistantInputError(this.cacheProblem||'原会话已变化，当前输入已保留。');this.preparationGuard();const envelope=await this.assistantProjectCopies!.prepare({sourceProjectId,input});if(!this.scopeCurrent(topic,project))return {kind:'blocked',reason:'原会话已变化，原材料复用待办已保留。'};this.scanCopies();const outcome=await this.resumeCopy(envelope.id,false);if(!outcome||outcome.result.state!=='complete'||!outcome.result.applyToPage||!outcome.applied||!this.data)return {kind:'blocked',reason:outcome?.result.reason??(this.status||'原材料复用尚待核对。')};await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);const ready=this.preparationGuard();if(ready.snapshot.version!==envelope.basePage.version+1||!assistantSame(ready.snapshot.view,outcome.result.envelope.expectedView)||this.data.project.project_id!==outcome.result.envelope.targetProjectId)throw new AssistantInputError('目标材料已保存，当前完整输入已变化，请重新核对任务。');return {kind:'ready',data:this.data,guard:ready};}
    finally{if(this.scopeCurrent(topic,project)){this.copyPreparing=false;this.scanCopies();this.paint();}}
  }
  private async prepare(){
    if(!this.action||!this.workspace)return;if(this.templateBlocked())throw new AssistantInputError(this.error);const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id;await this.flush();await this.cacheQueue;if(!this.scopeCurrent(topic,project))return;
    if(this.uploadRecoveryBlocked)throw new AssistantInputError('本机附件记录未能可靠读取，请保留文件并重新打开原对话后再继续。');
    if(this.currentUploads().some(u=>!uploadReady(u)))throw new AssistantInputError('附件尚未确认保存并加入原对话，请处理后继续。');
    let guard=this.preparationGuard();let action=structuredClone(this.action);let b:AssistantCardRequest={card_id:crypto.randomUUID(),execution_request_id:crypto.randomUUID(),operation:action.business,project_id:''};
    if(this.action.business==='generation'){
      const type=action.fields.document_type as M4DocumentType|undefined;if(!type||!M4_DOCUMENT_TYPES.includes(type))throw new AssistantInputError('请选择材料类型。');
      const w=await this.preparationRead(guard,()=>this.m4.workspace(topic)),old=w.drafts[type];
      const {version,sha256,updated_at,...input}=old;input.materials=[...w.materials];
      const sources=w.materials.filter(m=>w.material_details.find(d=>d.material_id===m.material_id)?.role==='historical');
      input.source_material=sources.find(m=>m.material_id===this.view.unsent_context.source_material?.material_id)??(sources.length===1?sources[0]:null);
      if(sources.length>1&&!input.source_material)throw new AssistantInputError('请选择本次采用的募集说明书，其他文件仍作为补充材料。');
      input.fields={...input.fields,...action.fields,market:action.fields.market??'',offering:type==='recommendation'?(action.fields.offering??''):'private'};
      if(type==='init'){const t=w.templates.find(t=>`${t.template_id}/${t.template_version}`===this.view.assistant?.template_key);if(!t)throw new AssistantInputError('请选择或上传本账号的券商立项报告模板。');input.template={template_id:t.template_id,template_version:t.template_version,sha256:t.sha256};input.fields.broker=t.broker;}input.supplemental_requirements=action.requirements;
      input.edit_base=this.view.unsent_context.reading_artifact??null;
      const result=await this.preparationWrite(guard,()=>this.m4.draft(w.topic.topic_id,{expected_version:version,input}));
      const q=await this.preparationWrite(guard,()=>this.m4.quote(w.topic.topic_id,{kind:'document',document_type:type,expected_draft_version:result.draft.version}));
      b={...b,project_id:w.topic.project_id,document_type:type,expected_draft_version:result.draft.version,quote_id:q.quote.quote_id};
    }else{
      const ensured=await this.ensureProject();if(ensured.kind!=='ready'){this.status=ensured.reason;return;}guard=ensured.guard;this.assertPreparation(guard);action=structuredClone(this.action!);const data=ensured.data,p=data.project,materials=data.materials.filter(m=>m.state==='persisted');
      if(!materials.length)throw new AssistantInputError('请先上传本次任务的材料。');
      if(action.business==='update'){
        const gaps=sourceProspectusInputGaps(materials,p.update_details?.source_prospectuses);if(gaps.length)throw new AssistantInputError('请补齐历史募集书下的原稿信息后继续。');
        const messages=(await this.preparationRead(guard,()=>this.api.projectMessages(p.project_id,undefined,this.controller.signal))).project_message_set_ref;
        const base=this.view.unsent_context.reading_artifact;
        const locked=await this.preparationWrite(guard,()=>this.api.createInputRevision(p.project_id,{draft_revision:p.draft_revision,material_versions:materials.map(m=>({material_id:m.material_id,material_version:m.material_version})),
          requirement_message_ids:messages.message_ids,project_message_set_ref:messages,edit_base:base?{artifact_id:base.artifact_id,artifact_version:base.artifact_version,sha256:base.sha256}:null},this.controller.signal));
        const request=await this.preparationRead(guard,()=>executionRequest(locked,'update')),q=await this.preparationWrite(guard,()=>this.api.creditQuote(p.project_id,{input_revision:locked.input_revision,input_hash:locked.input_hash},this.controller.signal));
        b={...b,project_id:p.project_id,execution_request_id:request.execution_request_id,input_revision:locked.input_revision,input_hash:locked.input_hash,...(q.quote?{quote_id:q.quote.quote_id}:{})};
      }else{
        const review=new ReviewApi(this.api,p.project_id,this.controller.signal),saved=await this.preparationRead(guard,()=>review.drafts()),sources=materials.filter(m=>m.role==='historical');
        const source=sources.find(m=>m.material_id===this.view.unsent_context.source_material?.material_id)??(sources.length===1?sources[0]:undefined);
        if(!source)throw new AssistantInputError(sources.length?'请选择本次待复核的募集说明书。':'请上传待复核的募集说明书。');
        await this.preparationWrite(guard,()=>review.saveDraft({kind:'input',expected_version:saved.draft.version,input:{source_material_ref:{material_id:source.material_id,material_version:source.material_version,sha256:source.sha256},material_versions:materials.map(m=>({material_id:m.material_id,material_version:m.material_version,sha256:m.sha256})),requirements:action.requirements?[action.requirements]:[],as_of:p.update_details?.reporting_cutoff??null}}));
        const d=await this.preparationRead(guard,()=>review.drafts());b={...b,project_id:p.project_id,expected_input_version:d.draft.version};const q=await this.preparationWrite(guard,()=>review.quoteExecution(this.reviewRequest(b)));if(q.quote)b.quote_id=q.quote.quote_id;
      }
    }
    this.assertPreparation(guard);await this.flush();this.assertPreparation(guard);
    const {card}=await this.preparationWrite(guard,()=>this.api.request<{card:AssistantCard}>('POST',`/assistant/topics/${topic}/cards`,b,{},this.controller.signal));
    this.view.assistant!.prepared_card_id=card.card_id;this.changed();const expected=this.viewSnapshot()!;await this.flush();await this.cacheQueue;if(!this.scopeCurrent(topic,project)||this.viewDirty||this.viewConflict||this.view.version!==expected.version+1||this.editGeneration!==expected.generation||!assistantSame(this.fullView(this.view),expected.view))throw new AssistantInputError('确认卡已保存，本页完整输入又有变化，请重新核对。');
    this.cards.push(card);this.runtimeGeneration++;this.cache();this.formOpen=false;this.status=b.operation==='update'?'请核对材料与要求后开始更新。':'请核对材料、要求和积分后开始。';
  }
  private reviewRequest(c:AssistantCardRequest){return {execution_request_id:c.execution_request_id,operation:'full_review' as const,expected_input_version:c.expected_input_version!,source_report_id:null,expected_plan_version:null,finding_ids:[],...(c.quote_id?{quote_id:c.quote_id}:{})};}
  private async execute(c:AssistantCard){
    if(!this.workspace||c.run)return;
    if(this.templateBlocked())throw new AssistantInputError(this.error);const topic=this.workspace.topic.topic_id;
    if(this.uploadRecoveryBlocked||this.currentUploads().some(u=>!uploadReady(u)))throw new AssistantInputError('请先确认附件已保存并加入此对话，或移除待办后再开始任务。');
    await this.flush();
    if(this.staleCard(c))throw new AssistantInputError('要求或材料已变化，请重新核对本次任务和积分。');
    if(c.operation==='update'){
      const req=await executionRequest({project_id:c.project_id,input_revision:c.input_revision!,input_hash:c.input_hash!},'update');
      if(req.execution_request_id!==c.execution_request_id)throw new ApiError(409,'INPUT_REVISION_CONFLICT');if(c.quote_id)req.quote_id=c.quote_id;await this.businessWrite(topic,()=>this.api.execute(req,this.controller.signal));
    }else if(c.operation==='review')await this.businessWrite(topic,()=>new ReviewApi(this.api,c.project_id,this.controller.signal).execute(this.reviewRequest(c)));
    else await this.businessWrite(topic,()=>this.m4.execute(topic,{execution_request_id:c.execution_request_id,document_type:c.document_type as M4DocumentType,expected_draft_version:c.expected_draft_version!,quote_id:c.quote_id!,entrypoint:'assistant'}));
    this.status='已开始处理。可以收起助手，任务会继续运行。';this.view.assistant!.action=null;this.changed();await this.flush();await this.poll();
  }
  private async upload(u:Upload){
    if(u.kind!=='material')return this.uploadLegacy(u);
    if(this.workspace?.topic.topic_id===u.topic&&this.templateBlocked())throw new AssistantInputError(this.error);
    const state=(value:string)=>{if(this.live){u.status=value;this.paintStatus();}};u.error=undefined;u.needsFile=false;
    try{
      await u.preparation;if(!this.live)return;
      if(!u.recovery)throw new AssistantInputError('原上传记录尚未可靠保存，请保留文件并重新选择。');
      const result=await this.materialUploads.resume(u.recovery,{file:u.file,signal:this.controller.signal,status:message=>state(message.includes('加入原对话')?'材料已保存，正在加入原对话…':message.includes('核对重新选择')?'正在核对所选文件是否与原文件相同…':message.includes('正在上传')?'正在上传文件…':message.includes('确认')?'正在确认文件是否已保存…':'正在准备保存文件…'),progress:(loaded,total)=>state(`上传 ${Math.round(loaded/total*100)}%`)});
      if(!this.live)return;u.material=result.material;u.associated=result.associated;
      u.requestUploadId=result.uploadId;
      state(uploadReused(u)?duplicateUploadMessage(u.filename,u.material.filename):'已保存并加入原对话');
    }catch(e){if(this.live){try{u.recovery=this.materialUploads.list(u.topic).find(record=>record.id===u.id&&record.projectId===u.project)??u.recovery;}catch{/* retain the last known identity and the original failure */}u.error=assistantError(e,'save');u.needsFile=e instanceof UploadRecoveryNeedsFileError;state(u.recovery?.material?'材料已保存，尚未确认加入原对话':'上传待确认');}throw e;}
  }
  /** Legacy in-memory items cannot reconstruct the fixed original copy operation. */
  private async uploadLegacy(u:Upload){
    throw new AssistantInputError(u.kind==='copy'?'原材料复用缺少完整恢复记录，请在原任务中核对这批材料。':'券商模板请使用原立项任务的模板保存入口。');
  }
  private addFiles(files:File[],role:Upload['role'],entrypoint:AssistantUploadEntry){
    if(!this.workspace)return;
    if(this.templateBlocked())return;
    const project=this.data?.project.project_id??this.workspace.topic.project_id,topic=this.workspace.topic.topic_id;
    for(const file of files){const u:Upload={id:crypto.randomUUID(),kind:'material',filename:file.name,file,role,project,topic,status:'正在保留原上传'};this.uploads.push(u);
      u.preparation=this.materialUploads.begin(file,role,project,topic,entrypoint,u.id).then(record=>{if(this.live){u.recovery=record;u.status='等待上传';}}).catch(e=>{if(this.live){u.error=assistantError(e,'save');u.status='尚未建立上传记录';}});
    }
    this.invalidateTask();this.paintStatus();void this.drainUploads();
  }
  private async download(id:string){const a=await this.api.artifact(id,this.controller.signal),bytes=await this.api.artifactBytes(a,this.controller.signal),url=URL.createObjectURL(bytes),link=document.createElement('a');link.href=url;link.download=artifactFilename(a);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  private async click(event:Event){const el=(event.target as HTMLElement).closest<HTMLElement>('[data-a]');if(!el)return;const a=el.dataset.a;if(this.embeddedProject&&['toggle','wide','project','current-project'].includes(a??''))return;
    if(a==='embed-retry'&&this.embeddedProject&&this.host.parentElement){await this.embedProject(this.host.parentElement,this.embeddedProject);return;}
    if(a==='toggle'){await this.setOpen(!this.open);return;}
    if(a==='wide'){this.wide=!this.wide;this.paint();return;}
    if(a==='history'){this.history=!this.history;this.projectPicker=false;this.paint();return;}
    if(a==='close-project'||a==='project'&&this.projectPicker){this.projectPicker=false;this.paint();this.host.querySelector<HTMLElement>('[data-a="project"]')?.focus();return;}
    if(a==='hide-form'){this.formOpen=false;this.paint();return;}
    const operation:ErrorOperation=a==='download'?'download':['send','execute','new','current-project','prepare'].includes(a??'')?'submit':['template-read','copy-read','project'].includes(a??'')?'read':['recover-view','keep-local-view','template-resume','template-remove','template-orphan-remove','copy-resume','copy-stop','copy-orphan-remove','action','shortcut','retry-upload','remove-upload','continue'].includes(a??'')?'save':'action';
    await this.work(async()=>{
      if(a==='recover-view')await this.resolveView(false);
      if(a==='keep-local-view')await this.resolveView(true);
      if(a==='template-resume')await this.resumeTemplate(el.dataset.operationId!);
      if(a==='template-read')await this.readTemplates();
      if(a==='template-target'){this.status='原任务信息保留在模板待办的“查看原任务信息”中，当前输入未替换。';if(this.action?.business==='generation'&&this.action.fields.document_type==='init'){this.formOpen=true;this.history=false;}}
      if(a==='template-remove'&&this.assistantTemplateUploads){this.scanTemplates();const e=this.templateEnvelopes.find(e=>e.id===el.dataset.operationId);if(e){this.viewConflict=true;this.cache();await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);await this.assistantTemplateUploads.stop(e.id);this.conflictServer=(await this.m4.workspace(e.topicId)).view;this.templateSaved.delete(e.id);this.status='已停止本机后续保存，服务器已保存的文件、模板和会话仍保留。请核对完整会话后再开始任务。';this.scanTemplates();}}
      if(a==='template-orphan-remove'&&this.assistantTemplateUploads&&this.workspace){const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id;this.viewConflict=true;this.cache();await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);await this.assistantTemplateUploads.removeOrphan(el.dataset.operationId!);const latest=await this.m4.workspace(topic);if(this.scopeCurrent(topic,project)){this.conflictServer=latest.view;this.status='已移除本机待办，服务器已保存内容保留。请核对完整会话后再开始任务。';this.scanTemplates();}}
      if(a==='copy-resume')await this.resumeCopy(el.dataset.operationId!);
      if(a==='copy-read')await this.readCopies();
      if(a==='copy-target'){const e=this.copyEnvelopes.find(e=>e.id===el.dataset.operationId)??this.copySaved.get(el.dataset.operationId!);this.status='原来源、目标和任务要求保留在复用详情中，当前输入未替换。';if(e&&this.action?.business===e.targetKind){this.formOpen=true;this.history=false;}}
      if(a==='copy-stop'&&this.assistantProjectCopies&&this.workspace){const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id,id=el.dataset.operationId!;this.viewConflict=true;this.cache();await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);await this.assistantProjectCopies.stop(id);const latest=await this.m4.workspace(topic);if(this.scopeCurrent(topic,project)){this.conflictServer=structuredClone(latest.view);this.status='已停止本机后续复用，服务器已建立的项目、材料和会话保留。请核对完整输入后继续。';this.scanCopies();}}
      if(a==='copy-orphan-remove'&&this.assistantProjectCopies&&this.workspace){const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id;this.viewConflict=true;this.cache();await this.cacheQueue;if(this.cacheProblem)throw new AssistantInputError(this.cacheProblem);await this.assistantProjectCopies.removeOrphan(el.dataset.targetProject!,el.dataset.operationId!);const latest=await this.m4.workspace(topic);if(this.scopeCurrent(topic,project)){this.conflictServer=structuredClone(latest.view);this.status='已移除本机待办，服务器已保存内容保留。请核对完整输入后继续。';this.scanCopies();}}
      if(a==='new')await this.newConversation(this.embeddedProject);
      if(a==='select'&&(!this.embeddedProject||this.topics.some(t=>t.topic_id===el.dataset.id&&t.source_project_id===this.embeddedProject)))await this.select(el.dataset.id!);
      if(a==='send')await this.send();
      if(a==='current-project'){const id=location.hash.match(/#\/projects\/([^/?]+)/)?.[1];if(id)await this.newConversation(decodeURIComponent(id));}
      if(a==='project'){let cursor:string|undefined;this.projects=[];do{const page=await this.api.projects(cursor,{limit:'100'},this.controller.signal);this.projects.push(...page.items.filter(p=>p.kind!=='qa'));cursor=page.page.next_cursor??undefined;}while(cursor);this.status='';this.history=false;this.projectPicker=true;}
      if(a==='action'){const message=this.workspace?.messages.find(m=>m.message_id===el.dataset.id);if(message?.reply?.assistant_action)await this.useAction(message.reply.assistant_action);}
      if(a==='shortcut')await this.useAction({business:el.dataset.kind as AssistantAction['business'],requirements:'',fields:{}});
      if(a==='edit'){this.formOpen=true;}
      if(a==='prepare')await this.prepare();
      if(a==='execute'){const c=this.cards.find(c=>c.card_id===el.dataset.id);if(c)await this.execute(c);}
      if(a==='download')await this.download(el.dataset.id!);
      if(a==='retry-upload'){const u=this.currentUploads().find(u=>u.id===el.dataset.id);if(u&&u.kind!=='template'){await this.upload(u);if(this.data&&this.workspace?.topic.topic_id===u.topic&&this.data.project.project_id===u.project)this.data=await this.projectData(u.project);await this.poll();}}
      if(a==='remove-upload'){const u=this.currentUploads().find(u=>u.id===el.dataset.id);if(u?.kind==='material'&&u.recovery)await this.materialUploads.forget(u.recovery);this.uploads=this.uploads.filter(item=>item!==u);this.invalidateTask();}
      if(a==='continue'){const c=this.cards.find(c=>c.card_id===el.dataset.id);if(c?.run){this.data=await this.projectData(c.project_id);const result=this.data.results.find(r=>r.run_id===c.run!.run_id);if(result)this.view.unsent_context.reading_artifact=result.pin;
        await this.useAction({business:c.operation,requirements:'',fields:c.document_type?{document_type:c.document_type}:{}});}}
    },operation);
  }
  private input(event:Event){const el=event.target as HTMLInputElement;
    if(el.matches('[data-composer]')){this.text=el.value;this.qaQuote=undefined;this.changed();this.paintStatus();this.sizeComposer();}
    if(el.matches('[data-field]')&&this.action){(this.action.fields as Record<string,string>)[el.dataset.field!]=el.value;this.invalidateTask();}
    if(el.matches('[data-requirements]')&&this.action){this.action.requirements=el.value;this.invalidateTask();}
    if(el.dataset.sourceField&&this.data){const container=el.closest<HTMLElement>('[data-source-material]')!,m=this.data.materials.find(m=>m.material_id===container.dataset.sourceMaterial)!;
      const details=this.data.project.update_details??=emptyUpdateDetails(),sources=details.source_prospectuses??=[],old=sources.find(s=>s.material_id===m.material_id),next=readSourceFields(container,m,old,el.dataset.sourceField);
      details.source_prospectuses=[...sources.filter(s=>s.material_id!==m.material_id),next];
      this.view.assistant!.source_prospectuses=details.source_prospectuses;this.invalidateTask();}
  }
  private async change(event:Event){const el=event.target as HTMLInputElement;
    if(el.matches('[data-assistant-template-recovery-reselect]')){const file=el.files?.[0],id=el.dataset.assistantTemplateRecoveryReselect!;el.value='';if(file){this.templateFiles.set(id,file);this.templateStatuses.set(id,'已选择文件，请点击继续原保存，核对内容相同后再继续。');this.templateErrors.delete(id);this.paintStatus();}return;}
    if(el.matches('[data-primary-source]')){this.view.unsent_context.source_material=this.workspace?.materials.find(m=>m.material_id===el.value)??null;this.invalidateTask();return;}
    if(el.matches('[data-project-select]')){const id=el.value;if(id)await this.work(async()=>{this.projects=[];await this.newConversation(id);},'submit');return;}
    if(el.matches('[data-template]')){this.view.assistant!.template_key=el.value;this.invalidateTask();return;}
    if(el.matches('[data-assistant-reselect]')){const u=this.currentUploads().find(u=>u.id===el.dataset.assistantReselect),file=el.files?.[0];el.value='';if(u&&file){u.file=file;u.status='已重新选择原文件，点击确认原上传';this.paintStatus();}return;}
    if(el.matches('[data-template-upload]')){const file=el.files?.[0];el.value='';if(file)await this.work(()=>this.beginTemplate(file),'save');return;}
    if(el.matches('[data-file]')){const files=Array.from(el.files??[]);el.value='';if(files.length)this.addFiles(files,el.dataset.file as Upload['role'],el.closest('.ba-composer')?'attachment':'business');return;}
    if(el.matches('[data-baseline]')){this.view.unsent_context.reading_artifact=this.data?.results.find(r=>r.pin.artifact_id===el.value)?.pin??null;this.qaQuote=undefined;this.invalidateTask();return;}
    if(el.matches('[data-year],[data-quarter]')&&this.action){const year=this.host.querySelector<HTMLSelectElement>('[data-year]')!.value,q=this.host.querySelector<HTMLSelectElement>('[data-quarter]')!.value;const date=quarterCutoff(year,q);if(date)this.action.fields.reporting_cutoff=date;this.invalidateTask();}
    if(el.matches('[data-field="document_type"]')){this.paint();}
    if(el.matches('[data-field="market"]')&&this.action){delete this.action.fields.offering;this.paint();}
    if(el.dataset.sourceField==='market'&&this.data)this.paint();
  }
  private templateRecovery(){
    const topic=this.workspace?.topic.topic_id,active=new Set(this.templateEnvelopes.map(e=>e.id));
    const rows=this.templateEnvelopes.map(e=>{const i=e.items[0],a=e.basePage.view.assistant?.action,known=!!i.templateReceipt,unavailable=i.templateAvailability==='unavailable',saved=known?`<p data-assistant-template-saved-status>模板已保存${unavailable?'，当前不可采用':i.observedView&&i.localCacheResult==='patched'?'，原会话保存已确认':'，尚未用于当前完整输入'}。</p>`:'';return `<section class="ba-template-recovery" data-assistant-template-recovery-id="${esc(i.id)}" data-assistant-template-recovery-envelope="${esc(e.id)}"><strong>${esc(i.declaration.filename)}</strong>${saved}<p role="status">${esc(e.stopRequested?'本机后续保存已停止，待完成本机清理。':this.templateStatuses.get(i.id)??(i.stage==='template_create_unknown'?'模板创建结果待确认，请继续同一次原保存。':i.stage==='view_unknown'?'模板已保存，原会话采用结果待确认。':'原模板保存待核对。'))}</p>${this.templateErrors.has(i.id)?`<p role="alert">${esc(this.templateErrors.get(i.id)!)}</p>`:''}<details><summary>查看原任务信息</summary><p>${esc(MARKET_LABELS[e.templateIntent.market])} · ${esc(e.templateIntent.rawBroker)}</p><p class="ba-text">${esc(a?.requirements||'未填写补充要求')}</p><p>原对话：${esc(this.workspace?.topic.name??'BondBuddy')}</p></details><div class="ba-template-actions"><button data-a="template-resume" data-assistant-template-recovery-action="resume" data-operation-id="${esc(e.id)}"${this.busy?' disabled':''}>${e.stopRequested?'完成本机清理':'继续原保存'}</button><button data-a="template-read"${this.busy?' disabled':''}>重新读取状态</button><button data-a="template-target" data-assistant-template-recovery-target="${esc(e.id)}">查看原任务</button><button data-a="template-remove" data-assistant-template-recovery-remove="${esc(e.id)}" data-operation-id="${esc(e.id)}"${this.busy?' disabled':''}>停止本机后续保存</button></div>${this.templateNeedsFile.has(i.id)?`<label class="ba-template-picker">重新选择原文件<input type="file" accept=".docx" data-assistant-template-recovery-reselect="${esc(i.id)}" aria-label="重新选择原券商模板"></label>`:''}<small>继续会核对原文件、模板与完整会话，不会发送消息或开始任务。停止仅移除本机待办，服务器已保存的内容仍保留。</small></section>`;});
    for(const e of this.templateSaved.values())if(e.topicId===topic&&!active.has(e.id)){const i=e.items[0];rows.push(`<p class="ba-template-saved" data-assistant-template-saved-status>模板已保存：${esc(i.declaration.filename)}${i.templateAvailability==='unavailable'?'，当前不可采用':i.observedView&&i.localCacheResult==='patched'&&!this.viewConflict?'，已用于原立项任务':'，尚未用于当前完整输入'}。</p>`);}
    for(const r of this.templateOrphans)rows.push(`<section class="ba-template-recovery" data-assistant-template-recovery-id="${esc(r.id)}"><strong>${esc(r.declaration.filename)}</strong><p>原模板业务记录缺失，不能重新创建或采用。服务器文件仍保留。</p><button data-a="template-orphan-remove" data-assistant-template-recovery-remove="${esc(r.id)}" data-operation-id="${esc(r.id)}"${this.busy?' disabled':''}>移除此本机待办</button></section>`);
    if(this.templateProblem)rows.push(`<p role="alert">${esc(this.templateProblem)} 当前未提交新的请求，请保留原文件及完整输入。</p>`);return rows.join('');
  }
  private copyRecovery(){
    const topic=this.workspace?.topic.topic_id,active=new Set(this.copyEnvelopes.map(e=>e.id)),entries=[...this.copyEnvelopes,...[...this.copySaved.values()].filter(e=>e.topicId===topic&&!active.has(e.id))];
    const rows=entries.map(e=>{const pending=active.has(e.id),targetName=e.createdTarget?.name??e.createRequest.name,action=e.basePage.view.assistant?.action,adopted=!!e.observedView&&e.localCacheResult==='patched'&&this.view.assistant?.project_id===e.targetProjectId&&!this.viewConflict;return `<section class="ba-copy-recovery" data-assistant-copy-recovery-id="${esc(e.id)}"><div class="ba-copy-heading"><strong>复用原项目材料</strong><span>${e.items.length} 份材料</span></div><p>来源：${esc(e.sourceProject.name)}</p><p>目标：${esc(targetName)}</p>${e.targetProjectId?'<p data-assistant-copy-target-saved-status>目标项目已建立。</p>':''}${e.observedTarget?'<p data-assistant-copy-project-applied-status>目标项目信息已保存。</p>':''}<p data-assistant-copy-view-status>${adopted?'完整会话已保存，材料已用于本次任务。':e.observedView?'原会话已保存，尚未用于当前完整输入。':'材料尚未用于本次任务。'}</p>${pending?`<p role="status">${esc(e.stopRequested?'本机后续处理已停止，待完成本机清理。':this.copyStatuses.get(e.id)??'请核对原材料处理状态。')}</p>`:''}${this.copyErrors.has(e.id)?`<p role="alert">${esc(this.copyErrors.get(e.id)!)}</p>`:''}<ul class="ba-copy-items">${e.items.map(item=>`<li data-assistant-copy-item-id="${esc(item.id)}" data-assistant-copy-item-index="${item.index}"><strong>${esc(item.sourceMaterial.filename)}</strong>${item.material?'<span data-assistant-copy-material-saved-status>文件已保存。</span>':'<span>文件保存待核对。</span>'}<span>${item.membership==='confirmed'?'已加入原对话。':item.membership==='unavailable'?'原对话中的材料当前不可用。':'加入原对话的结果待核对。'}</span>${item.sourceMaterial.role==='historical'&&!item.sourceProspectus?'<span>原稿信息待补。</span>':item.mapping==='conflict'?'<span>原稿信息存在差异，请核对。</span>':''}${pending&&this.copyStatuses.has(`${e.id}:${item.index}`)?`<span role="status">${esc(this.copyStatuses.get(`${e.id}:${item.index}`)!)}</span>`:''}</li>`).join('')}</ul><details><summary>查看原任务信息</summary><p>${esc(businessName(e.targetKind))} · ${esc(e.input.issuer_name??'未填写发行人')}</p><p>${esc([e.input.market?MARKET_LABELS[e.input.market]:null,e.input.offering?OFFERING_LABELS[e.input.offering]:null,e.input.update_details?.reporting_cutoff].filter(Boolean).join(' · '))}</p><p class="ba-text">${esc(action?.requirements||'未填写补充要求')}</p><p>这里保留原项目与这批材料，后来输入的内容会另行保留。</p></details>${pending?`<div class="ba-copy-actions"><button data-a="copy-resume" data-assistant-copy-recovery-action="resume" data-operation-id="${esc(e.id)}"${this.busy?' disabled':''}>${e.stopRequested?'完成本机清理':'继续处理这批材料'}</button><button data-a="copy-read" data-assistant-copy-recovery-action="read" data-operation-id="${esc(e.id)}"${this.busy?' disabled':''}>重新读取状态</button><button data-a="copy-target" data-assistant-copy-recovery-action="target" data-operation-id="${esc(e.id)}">查看原任务</button><button data-a="copy-stop" data-assistant-copy-recovery-action="stop" data-operation-id="${esc(e.id)}"${this.busy?' disabled':''}>停止本机后续处理</button></div><small>继续处理只核对这批原材料和保存结果，不会报价、生成确认卡、发送消息或开始任务。停止后，服务器已保存的项目和文件仍保留。</small>`:''}</section>`;});
    for(const record of this.copyOrphans)rows.push(`<section class="ba-copy-recovery" data-assistant-copy-orphan-id="${esc(record.id)}" data-target-project="${esc(record.projectId)}"><strong>${esc(record.declaration.filename)}</strong><p>缺少原材料处理信息，当前不能继续原操作。服务器已保存的内容仍保留。</p><button data-a="copy-orphan-remove" data-assistant-copy-recovery-action="stop" data-target-project="${esc(record.projectId)}" data-operation-id="${esc(record.id)}"${this.busy?' disabled':''}>移除此本机待办</button></section>`);
    if(this.copyPreparing&&!entries.length)rows.push('<p role="status" class="ba-copy-summary">正在核对原项目与这批材料…</p>');if(this.copyProblem)rows.push(`<p role="alert" class="ba-copy-summary">${esc(this.copyProblem)}</p>`);return rows.join('');
  }
  private viewComparison(){
    if(!this.viewConflict||!this.workspace)return '';const describe=(view:M4ViewState)=>{const a=view.assistant?.action,f=a?.fields;return `<p>未发送文字</p><div class="ba-text">${esc(view.unsent_content||'空')}</div><p>任务：${a?esc(businessName(a.business)):'未选择'}${f?.document_type?` · ${esc(M4_DOCUMENT_LABELS[f.document_type])}`:''}</p><p>${esc([f?.name,f?.issuer_name,f?.broker,f?.market?MARKET_LABELS[f.market]:null,f?.offering?OFFERING_LABELS[f.offering]:null,f?.reporting_cutoff].filter(Boolean).join(' · '))}</p><p class="ba-text">${esc(a?.requirements||'未填写补充要求')}</p><p>来源信息 ${view.assistant?.source_prospectuses?.length??0} 份 · 引用 ${view.unsent_context.citations.length} 处 · ${view.unsent_context.reading_artifact?'已选择续改成果':'未选择续改成果'} · ${view.unsent_context.source_material?'已选择原稿':'未选择原稿'}</p>${view.quotation?.original_text?`<p class="ba-text">引用原文：${esc(view.quotation.original_text)}</p>`:''}<p>已同时保留模板选择、原任务卡、页签、阅读位置及项目复用信息。</p>`;};return `<details class="ba-view-conflict"><summary>完整会话存在差异，请核对两份输入</summary><h4>本机完整输入</h4>${describe(this.viewSnapshot()!.view)}<h4>服务器完整会话</h4>${this.conflictServer?describe(this.fullView(this.conflictServer)):'正在读取，请稍后重新核对。'}<p>采用服务器会替换本机完整输入；保留本机输入会明确建立新的待保存意图。请先处理原模板或材料复用待办。</p><button data-a="recover-view">采用服务器完整会话</button><button data-a="keep-local-view">保留本机完整输入作为新意图</button></details>`;
  }
  private form(){const a=this.action;if(!a)return '';const f=a.fields,s=cutoffSelection(f.reporting_cutoff??null),materials=this.data?.materials??[],sources=(this.workspace?.material_details??[]).filter(m=>m.role==='historical'&&(!this.data||m.source_project_id===this.data.project.project_id));
    return `<section class="ba-form"><div class="ba-card-head"><strong>${businessName(a.business)} · 核对信息</strong><button class="ba-icon-button" data-a="hide-form" title="收起任务信息" aria-label="收起任务信息">${icon('minus')}</button></div>
      <div class="ba-fields">${a.business==='generation'?`<label>材料类型<select data-field="document_type"><option value="">请选择</option>${M4_DOCUMENT_TYPES.filter(t=>t!=='workpaper').map(t=>option(t,M4_DOCUMENT_LABELS[t],f.document_type)).join('')}</select></label>`:`<label>项目名称<input data-field="name" maxlength="120" value="${esc(f.name??'')}"></label><label>发行人全称<input data-field="issuer_name" maxlength="200" value="${esc(f.issuer_name??'')}"></label>`}
      <label>发行市场<select data-field="market"><option value="">请选择</option>${(a.business==='generation'?(f.document_type?M4_DOCUMENT_MARKETS[f.document_type]:MARKETS):MARKETS).map(m=>option(m,MARKET_LABELS[m],f.market)).join('')}</select></label>
      ${a.business==='generation'&&f.document_type==='recommendation'?`<label>品种<select data-field="offering"><option value="">请选择</option>${(['ppn','mtn'] as const).map(o=>option(o,OFFERING_LABELS[o],f.offering)).join('')}</select></label>`:''}
      ${a.business!=='generation'?`<label>品种<select data-field="offering"><option value="">请选择</option>${(f.market?MARKET_OFFERINGS[f.market]:[]).map(o=>option(o,OFFERING_LABELS[o],f.offering)).join('')}</select></label>
      <label>最新报告期<select data-year>${s.years.map(y=>option(y,`${y}年`,s.year)).join('')}</select></label><label>期末<select data-quarter><option value="">请选择</option>${QUARTER_ENDS.map(([q,l])=>option(q,l,s.quarter)).join('')}</select></label>`:''}</div>
      ${a.business==='generation'&&f.document_type==='init'?`<label>券商立项模板<select data-template><option value="">请选择</option>${(this.workspace?.templates??[]).filter(t=>t.status==='active'&&t.document_type==='init'&&t.market===f.market).map(t=>option(`${t.template_id}/${t.template_version}`,`${t.broker} · ${t.name}`,this.view.assistant?.template_key)).join('')}</select></label><label>模板所属券商<input data-field="broker" value="${esc(f.broker??'')}"></label><label class="ba-attach ba-template-picker">＋ 上传券商模板<input type="file" data-template-upload accept=".docx" aria-label="上传券商模板"></label><div data-template-recovery>${this.templateRecovery()}</div>`:''}
      <div class="ba-upload-actions"><label>＋ ${a.business==='review'?'待复核募集书':'历史／参考募集书'}<input type="file" data-file="historical" accept=".docx,.pdf" multiple></label><label>＋ 财务／审计材料<input type="file" data-file="audit" multiple></label><label>＋ 其他材料<input type="file" data-file="other" multiple></label></div>
      ${a.business!=='update'&&sources.length>1?`<label>本次采用的募集说明书<select data-primary-source><option value="">请选择</option>${sources.map(m=>option(m.material_id,m.filename,this.view.unsent_context.source_material?.material_id)).join('')}</select></label>`:''}
      <ul class="ba-files">${!this.data?(this.workspace?.material_details??[]).map(m=>`<li>${esc(m.filename)} <small>已保存</small></li>`).join(''):''}${materials.map(m=>`<li>${esc(m.filename)} <small>已保存</small>${a.business==='update'?sourceFields(m,this.data?.project.update_details?.source_prospectuses):''}</li>`).join('')}</ul>
      <label>补充要求 <small>选填</small><textarea data-requirements maxlength="12000" rows="3" placeholder="例如：只修改偿债能力分析，保留财务数据与表格。">${esc(a.requirements)}</textarea></label>
      ${a.business!=='generation'?`<div data-copy-recovery>${this.copyRecovery()}</div>`:''}<button class="ba-primary" data-a="prepare"${this.busy?' disabled':''}>核对本次任务</button></section>`;
  }
  private staleCard(c:AssistantCard){return c.draft_token!==(this.view.assistant?.draft_token??null)||this.view.assistant?.prepared_card_id!==c.card_id;}
  private taskLink(c:AssistantCard){
    const r=c.run;if(!r)return '';
    const task={run_id:r.run_id,project_id:c.project_id,kind:c.operation,state:r.state,stage:r.stage,artifact_id:r.artifact_id,
      created_at:c.created_at,updated_at:r.updated_at,report_id:null,topic_id:c.operation==='generation'?this.workspace!.topic.topic_id:null,
      document_type:c.document_type??null,operation:null};
    return `<a data-assistant-task-run="${esc(r.run_id)}" href="${esc(taskHref(task))}">${esc(taskView(task).action)}</a>`;
  }
  private card(c:AssistantCard){const stale=!c.run&&this.staleCard(c),r=c.run,price=c.quote?.points??0,insufficient=c.balance.available<price;
    return `<section class="ba-task ${r?'ba-committed':''}" data-card="${esc(c.card_id)}"><div class="ba-card-head"><strong>${businessName(c.operation)}</strong><span>${r?runLabel(r.state):stale?'已保留旧方案':'待确认'}</span></div><p>${esc(c.project_name)}</p><p>${esc([c.target?.issuer_name,MARKET_LABELS[c.target?.market as Market],OFFERING_LABELS[c.target?.offering as Offering],c.document_type?M4_DOCUMENT_LABELS[c.document_type as M4DocumentType]:null,c.target?.reporting_cutoff?`最新报告期 ${c.target.reporting_cutoff}`:null].filter(Boolean).join(' · '))}</p>
      <details${!r?' open':''}><summary>${c.baseline?'基于已选成果继续修改':'任务材料与要求'}</summary><p>${c.baseline?'保留旧成果，生成新的文件版本。':''}</p><ul>${c.material_names.map(n=>`<li>${esc(n)}</li>`).join('')}</ul><p class="ba-text">${esc(c.requirements||'按所选材料和对应编制要求处理。')}</p></details>
      ${c.operation==='update'&&!r?'':`<div class="ba-credits">${r?'本次任务积分':'本次消耗积分'} <strong>${price.toLocaleString()}</strong>${!r?`<small>可用 ${c.balance.available.toLocaleString()} 积分</small>`:''}</div>`}
      ${r&&!finished(r.state)?taskProgress(r,c.operation==='generation'?'material':c.operation):''}
      ${r?`${this.taskLink(c)}${r.state==='succeeded'?` <button data-a="continue" data-id="${esc(c.card_id)}">继续修改</button><div data-delivery="${esc(r.run_id)}"></div>`:''}${['failed','paused'].includes(r.state)?'<p>原材料和要求已保留，可在原任务中查看原因与恢复状态。</p>':''}`:
        `<div class="ba-card-actions"><button data-a="edit">修改信息</button>${stale?'<span>输入已变化，请重新核对任务。</span>':insufficient?`<a href="#/account?project=${encodeURIComponent(c.project_id)}" class="ba-primary">积分不足，去充值</a>`:`<button class="ba-primary" data-a="execute" data-id="${esc(c.card_id)}"${this.busy?' disabled':''}>${c.operation==='update'?'开始更新':'确认并开始'}</button>`}</div><small>成功交付后扣费；失败或取消释放预留积分。</small>`}</section>`;
  }
  private paintTimeline(){const box=this.host.querySelector<HTMLElement>('[data-timeline]');if(!box)return;const atEnd=box.scrollHeight-box.scrollTop-box.clientHeight<80,scroll=box.scrollTop;
    const selection=window.getSelection();if(selection&&!selection.isCollapsed&&box.contains(selection.anchorNode))return;
    const messages=this.workspace?.messages??[];const entries=[...messages.map(m=>({time:m.created_at,html:`<article class="ba-message ${m.role}"><small>${m.role==='user'?'你':'BondBuddy'}</small><div class="ba-text">${esc(m.content)}</div>${m.error?`<p role="alert">${esc(m.error)}</p>`:''}${m.role==='user'&&!['completed','failed'].includes(m.reply_status)?`<p class="ba-thinking">${m.reply_status==='running'?'正在阅读并整理回复…':'已收到，等待处理…'}</p>`:''}${m.reply?.assistant_action?`<button class="ba-suggestion" data-a="action" data-id="${esc(m.message_id)}">核对${businessName(m.reply.assistant_action.business)}的信息与要求 →</button>`:''}</article>`})),...this.cards.map(c=>({time:c.created_at,html:this.card(c)}))].sort((a,b)=>a.time.localeCompare(b.time));
    box.hidden=this.formOpen&&!entries.length;
    box.classList.toggle('ba-empty',!entries.length);
    box.innerHTML=entries.map(e=>e.html).join('')||`<div class="ba-welcome"><span class="ba-welcome-mark">${icon('buddy')}</span><h2>有什么可以帮你？</h2><p>讨论项目、完善文稿，或开始一项新任务。</p><div class="ba-shortcuts"><button data-a="shortcut" data-kind="update"${this.busy||!this.workspace?' disabled':''}><span class="ba-shortcut-icon">${icon('update')}</span><span><strong>更新募集书</strong><small>更新内容，或继续修改已有成果</small></span>${icon('arrow')}</button><button data-a="shortcut" data-kind="review"${this.busy||!this.workspace?' disabled':''}><span class="ba-shortcut-icon">${icon('review')}</span><span><strong>复核募集书</strong><small>检查内容，梳理需要完善的地方</small></span>${icon('arrow')}</button><button data-a="shortcut" data-kind="generation"${this.busy||!this.workspace?' disabled':''}><span class="ba-shortcut-icon">${icon('generation')}</span><span><strong>生成项目材料</strong><small>根据材料和要求，编制所需文书</small></span>${icon('arrow')}</button></div></div>`;
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
    this.host.querySelectorAll<HTMLElement>('[data-template-recovery]').forEach(el=>el.innerHTML=this.templateRecovery());
    this.host.querySelectorAll<HTMLElement>('[data-copy-recovery]').forEach(el=>el.innerHTML=this.copyRecovery());
    const uploads=this.host.querySelector<HTMLElement>('[data-uploads]');if(uploads)uploads.innerHTML=this.currentUploads().map(u=>{const reused=uploadReady(u)&&uploadReused(u),recoverable=u.kind==='material'&&!!u.recovery&&!uploadReady(u);return `<div role="status" data-assistant-upload="${esc(u.id)}" data-upload-kind="${u.kind}" data-associated="${u.associated===true}" class="${reused?'duplicate-upload-notice':''}">${reused?'':esc(u.filename)+' · '}${esc(u.status)}${u.error?`<p>${esc(u.error)}</p>`:''}${recoverable?`<button data-a="retry-upload" data-id="${esc(u.id)}"${this.busy?' disabled':''}>确认保存并加入对话</button>${u.needsFile?`<label class="ba-attach">重新选择原文件<input type="file" data-assistant-reselect="${esc(u.id)}"></label>`:''}<button data-a="remove-upload" data-id="${esc(u.id)}"${this.busy?' disabled':''}>移除此待办</button><small>将加入“${esc(this.workspace?.topic.name??'原对话')}”。确认不会发送消息或开始任务；移除待办会保留服务器已收到的文件。</small>`:u.error?`${u.kind==='template'?'<small>模板创建与采用尚不支持跨刷新恢复，请核对原模板；此处不能只重试上传后显示模板成功。</small>':`<button data-a="retry-upload" data-id="${esc(u.id)}">重试保存</button>`}<button data-a="remove-upload" data-id="${esc(u.id)}">移除本机项</button>`:''}</div>`;}).join('');
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
    if(this.embeddedProject&&this.workspace?.topic.source_project_id!==this.embeddedProject){this.host.innerHTML=`<section class="ba-panel" role="region" aria-label="BondBuddy 项目对话"><p role="status" style="padding:24px">${this.error?esc(this.error):'正在打开本项目的 BondBuddy 对话…'}</p>${!this.busy?'<button data-a="embed-retry">重新打开对话</button>':''}</section>`;this.syncLayout();return;}
    const project=this.data?.project,base=this.viewSafe()?.unsent_context.reading_artifact;
    const currentProject=location.hash.match(/#\/projects\/([^/?]+)/)?.[1];
    this.host.innerHTML=this.open?`
      <section id="ba-panel" class="ba-panel" role="dialog" aria-label="BondBuddy"><header class="ba-header"><div class="ba-identity"><span class="ba-mark">${icon('buddy')}</span><div><strong>BondBuddy</strong><small>券商助手</small></div></div><div class="ba-toolbar"><button class="ba-icon-button" data-a="new" title="新对话" aria-label="新对话">${icon('new')}</button><button class="ba-icon-button" data-a="history" title="最近对话" aria-label="最近对话" aria-pressed="${this.history}">${icon('history')}</button><button class="ba-icon-button" data-a="wide" title="${this.wide?'还原宽度':'加宽侧栏'}" aria-label="${this.wide?'还原宽度':'加宽侧栏'}">${icon(this.wide?'contract':'expand')}</button><button class="ba-icon-button" data-a="toggle" title="收起助手，回到右下角图标" aria-label="收起助手">${icon('collapse')}</button></div></header>
      <div class="ba-context"><div class="ba-context-row"><button class="ba-project-button" data-a="project" aria-expanded="${this.projectPicker}" title="${esc(project?.name??'关联项目以使用已有材料和成果')}">${icon('folder')}<span>${esc(project?.name??'关联项目')}</span>${icon('chevron')}</button>${currentProject&&currentProject!==project?.project_id?'<button class="ba-current-project" data-a="current-project">使用当前项目</button>':''}
      ${this.workspace?.material_details.length?`<details class="ba-context-files"><summary>${icon('paperclip')}${this.workspace.material_details.length} 份材料</summary><ul>${this.workspace.material_details.map(m=>`<li>${esc(m.filename)}</li>`).join('')}</ul></details>`:''}</div>
      ${this.projectPicker?`<div class="ba-project-picker"><div><strong>关联已有项目</strong><button class="ba-icon-button" data-a="close-project" aria-label="关闭项目选择" title="关闭项目选择">${icon('close')}</button></div>${this.projects.length?`<label class="ba-sr-only" for="ba-project-select">选择项目</label><select id="ba-project-select" data-project-select ${this.busy?'disabled':''}><option value="">选择项目</option>${this.projects.map(p=>option(p.project_id,p.name)).join('')}</select><p>选择后开启新对话，已有对话可在“最近对话”找回。</p>`:'<p>还没有项目，可直接在对话中开始一项任务。</p>'}</div>`:''}
      ${this.data?.results.length?`<label class="ba-baseline">讨论／修改的成果<select data-baseline ${this.busy&&!this.localEditingAllowed()?'disabled':''}><option value="">仅使用项目材料</option>${this.data.results.map(r=>option(r.pin.artifact_id,r.label,base?.artifact_id)).join('')}</select></label>`:''}</div>
      ${this.history?`<div class="ba-history"><div class="ba-history-heading"><h3>最近对话</h3><button class="ba-icon-button" data-a="history" aria-label="返回当前对话" title="返回当前对话">${icon('close')}</button></div>${this.topics.filter(t=>!this.embeddedProject||t.source_project_id===this.embeddedProject).map(t=>`<button data-a="select" data-id="${esc(t.topic_id)}">${icon('history')}<span>${esc(t.name)}<small>${new Date(t.updated_at).toLocaleDateString()}</small></span>${icon('arrow')}</button>`).join('')}</div>`:`<div class="ba-body"><div data-timeline class="ba-timeline" aria-live="polite"></div>${this.formOpen?this.form():''}</div>`}
      <footer class="ba-composer"><div data-uploads class="ba-uploads"></div>${this.history||!this.formOpen||this.action?.business!=='generation'||this.action.fields.document_type!=='init'?`<div data-template-recovery>${this.templateRecovery()}</div>`:''}${this.history||!this.formOpen||this.action?.business==='generation'?`<div data-copy-recovery>${this.copyRecovery()}</div>`:''}<p data-status role="status"></p>${this.viewComparison()}<small data-qa-price></small><div class="ba-input-shell"><textarea data-composer ${this.busy&&!this.localEditingAllowed()?'disabled':''} rows="2" maxlength="12000" placeholder="说说你的问题或任务要求…" aria-label="发送给 BondBuddy">${esc(this.text)}</textarea><div class="ba-send-row"><label class="ba-attach" title="添加附件">${icon('paperclip')}<span>添加附件</span><input type="file" data-file="other" multiple></label><button class="ba-send" data-a="send" title="${this.busy?'正在处理':'发送消息'}" aria-label="${this.busy?'正在处理':'发送消息'}"${this.busy||!this.workspace||!this.text.trim()?' disabled':''}>${icon(this.busy?'loading':'send')}</button></div></div><div class="ba-composer-hint">Enter 发送<span> · </span>Shift + Enter 换行</div></footer></section>`:'';
    // Keep the selected native input alive while upload completion redraws the panel.
    // Only reuse it within the same conversation/project, never across contexts.
    for(const fresh of this.host.querySelectorAll<HTMLInputElement>('input[type="file"]')){
      const old=pickers.get(pickerKey(fresh));
      if(old)fresh.replaceWith(old);else fresh.dataset.uploadContext=uploadContext;
    }
    this.syncLayout();
    if(this.open){this.paintTimeline();this.paintStatus();this.sizeComposer();
      if(this.busy&&!this.localEditingAllowed())this.host.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('.ba-form input:not([type=file]),.ba-form select,.ba-form textarea').forEach(el=>el.disabled=true);
    }
  }
  private viewSafe():M4ViewState|undefined{return this.workspace?.view;}
}
