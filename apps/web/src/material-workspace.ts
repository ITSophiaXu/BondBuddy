import {uploadPickerContent} from './upload-picker';
import './upload-progress.css';
import {orderedUploadPipeline,UploadPreparationError} from './upload-scheduler';
import {uploadActivity,uploadTransfer,uploadProgressHtml,type FileUploadProgress} from './upload-progress';
import {int64} from '@bondbuddy/contracts';
import {formatPoints} from '@bondbuddy/contracts';
import {isAutomaticCharge} from './commerce';
import {UserFacingError} from './user-facing-error.js';
import { duplicateUploadNotices, isReusedUpload, type DuplicateUploadNotice } from './duplicate-upload';
import { MARKETS, MARKET_LABELS, MARKET_OFFERINGS, OFFERING_LABELS, M4_DOCUMENT_MARKETS, m4DocumentScopeSupported, M4_CASE_TEMPLATES, m4DocumentInputIssues, type M4InputIssue, type M4InputField, M4_DOCUMENT_LABELS, M4_DOCUMENT_TYPES, M4DraftInputSchema, M4ViewStateSchema, M4MessageRequestSchema, M4ExecuteRequestSchema,
  M1_UPLOAD_MIME_TYPES, M1_UPLOAD_LIMITS, type M4Topic, type M4Workspace, type M4DocumentType, type M4DraftInput,
  type M4MaterialPin, type M4ArtifactPin, type M4Artifact, type M4MessageContext, type M4ViewState,
  type M4MessageRequest, type M4ExecuteRequest, type M4QuoteResponse, type M4Task } from './billing-types.js';
import { Value } from '@sinclair/typebox/value';
import { projectListContext, projectBackLink, projectSection, withProjectContext, rechargeHref } from './project-navigation';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { M4Api } from './m4-api';
import { M4UploadRecovery, m4UploadRecordMatches, m4UploadSame, type M4UploadEnvelope, type M4UploadResult } from './m4-upload-recovery';
import { M4TemplateUploadRecovery, m4TemplateUploadRecordMatches, type M4TemplateUploadEnvelope, type M4TemplateUploadResult } from './m4-template-upload-recovery';
import { UploadRecoveryNeedsFileError, type UploadRecoveryRecord } from './upload-recovery';
import { ArtifactDownloads } from './artifact-download';
import { date, esc } from './ui';
import { taskProgress } from './task-progress';
import { materialLiveStatus, materialActivityLog, materialCreditReceipt } from './material-progress';
import {MaterialReferencePicker,type MaterialReferencePurpose,type MaterialReferenceChoice} from './material-reference-picker';
import {compareMaterialDraftInputs,sameMaterialDraftValue,type MaterialDraftComparisonMetadata,type MaterialDraftComparisonRow} from './material-draft-comparison';
import {materialPriorResult,materialPriorPinKey,materialPriorTime} from './material-prior-result';
import './material-prior-result.css';
import './material-draft-comparison.css';
import './material-task-draft.css';
import './artifact-page.css';
import '../../../product-prototype/public/material-results.css';
import { prototypeIcon } from './prototype-design';
import { isActiveRun, runStateLabel } from './review-state';
import { m4ProgressLabel, initialReading, openWorkspaceTab, selectWorkspaceTab, taskSubmitted, taskArtifactAvailable, prepareInput,
  type WorkspaceReading } from './m4-workspace-state';
import './m4-workspace.css';
import './m4-prototype.css';

const pinKey=(p:M4MaterialPin)=>`${p.source_project_id}:${p.material_id}:${p.material_version}:${p.sha256}`;
const artKey=(p:M4ArtifactPin)=>`${p.artifact_id}:${p.artifact_version}`;
const materialPin=(projectId:string,m:Dto<'MaterialResponse'>):M4MaterialPin=>({source_project_id:projectId,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256});
const artifactTitle=(a:M4Artifact)=>a.revision_number?`${a.filename}${a.filename.includes('第'+a.revision_number+'稿')?'':` · 第${a.revision_number}稿`}`:a.filename;
const artifactPin=(a:M4Artifact):M4ArtifactPin=>({source_project_id:a.source_project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256});
const emptyContext=():M4MessageContext=>({document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null});
type Upload={progress?:FileUploadProgress;file:File;purpose:'source'|'material'|'template'|'attachment';documentType:M4DocumentType|null;state:string;error?:string;hash?:string;session?:Dto<'UploadSessionResponse'>;bytesSaved?:boolean;material?:Dto<'MaterialResponse'>;requestId:string};
type LocalDraft={version:number;input:M4DraftInput;dirty:boolean;conflict:boolean};
type DraftComparisonDialog={dialog:HTMLDialogElement;topic:string;project:string;type:M4DocumentType;local:LocalDraft;originVersion:number;localMetadata:MaterialDraftComparisonMetadata;server?:{version:number;input:M4DraftInput;metadata:MaterialDraftComparisonMetadata};cacheDraft?:unknown;cacheReady:boolean;busy:boolean;saving:boolean;stale:boolean;status:string;error:boolean;opener?:HTMLElement};
type PendingMessage={request:M4MessageRequest;viewContent:string};
const draftTypeMismatchMessage='本机草稿的文件类型与保存位置不一致。原记录已保留且未加载；本页暂显示已保存内容，请先核对原草稿后重新读取。';
const mimeByExtension:Record<string,typeof M1_UPLOAD_MIME_TYPES[number]>={docx:M1_UPLOAD_MIME_TYPES[0],pdf:M1_UPLOAD_MIME_TYPES[1],xlsx:M1_UPLOAD_MIME_TYPES[2],csv:M1_UPLOAD_MIME_TYPES[3],txt:M1_UPLOAD_MIME_TYPES[4],png:M1_UPLOAD_MIME_TYPES[5],jpg:M1_UPLOAD_MIME_TYPES[6],jpeg:M1_UPLOAD_MIME_TYPES[6]};

/** Prototype material studio backed by the existing immutable M4 task pipeline. */
export class MaterialWorkspace {
  private controller=new AbortController();
  private m4:M4Api;
  private referencePicker?:MaterialReferencePicker;
  private referenceRegistration=false;
  private page?:HTMLElement;
  private workspace?:M4Workspace;
  private topics:M4Topic[]=[];
  private drafts=new Map<M4DocumentType,LocalDraft>();
  private reading:WorkspaceReading=initialReading();
  private view:M4ViewState={selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:emptyContext(),quotation:null};
  private viewVersion=0; private viewDirty=false; private viewConflict=false;
  private selected:M4DocumentType|null=null;
  private previews=new Map<string,string>(); private previewPending=new Set<string>(); private previewErrors=new Map<string,string>();
  private downloadStates=new Map<string,{pending:boolean;text:string;error?:boolean}>();
  private metadata=new Map<string,Dto<'MaterialResponse'>>(); private projectNames=new Map<string,string>();
  private deletingMaterial?:string;
  private duplicateUploads=new Map<string,DuplicateUploadNotice & {purpose:Upload['purpose'];documentType:M4DocumentType|null}>();
  private uploads=new Map<string,Upload>(); private uploading=false;
  private m4Uploads?:M4UploadRecovery;
  private m4TemplateUploads?:M4TemplateUploadRecovery;
  private recoveryEnvelopes:M4UploadEnvelope[]=[];
  private templateRecoveryEnvelopes:M4TemplateUploadEnvelope[]=[];
  private uploadRecordsPresent=false; private uploadRecoveryProblem=''; private uploadPreparing=false; private uploadReading=false;
  private uploadFiles=new Map<string,File>(); private uploadErrors=new Map<string,string>(); private uploadStatuses=new Map<string,string>(); private fileProgress=new Map<string,FileUploadProgress>(); private uploadNeedsFile=new Set<string>();
  private uploadOrphans:UploadRecoveryRecord[]=[];
  private templateUploadOrphans:UploadRecoveryRecord[]=[];
  private uploadOriginalIds=new Map<string,string>();
  private cacheBaseline:string|null=null; private cacheQueue:Promise<void>=Promise.resolve(); private cacheFailure=false; private cachePending=0; private cacheRequestConflict=false;
  private draftGeneration=0;
  private uploadStorageChanged=(event:StorageEvent)=>{if(!this.live())return;if(event.key===null||event.key===this.cacheKey||event.key.startsWith('bb-m4-upload-v1:')||event.key.startsWith('bb-m4-template-upload-v1:')||event.key.startsWith('bondbuddy:upload-recovery:v1:')){this.scanUploadRecovery();if(this.uploadRecordsPresent||this.uploadRecoveryProblem){clearTimeout(this.saveTimer);this.message('另一页面的材料或模板保存记录已有变化，请核对原文件；本页材料与要求保留。',true);}this.paint();}};
  private downloads=new ArtifactDownloads(); private dialog?:HTMLDialogElement;
  private draftComparison?:DraftComparisonDialog;
  private invalidDraftType=false;
  private saveTimer?:ReturnType<typeof setTimeout>; private pollTimer?:ReturnType<typeof setTimeout>; private saving?:Promise<boolean>; private refreshing?:Promise<void>;
  private docQuote?:{response:M4QuoteResponse;version:number;type:M4DocumentType};
  private qaQuote?:{response:M4QuoteResponse;signature:string};
  private pendingMessage?:PendingMessage; private pendingExecution?:M4ExecuteRequest;
  private seenDocumentRuns=new Set<string>();
  private taskReturnSequence=0;
  private taskDraftReadings=new Map<string,{token:string;manifest:M4Task['manifest'];draft:LocalDraft}>();
  private taskReturns=new Map<string,{token:string;topic:string;project:string;manifest:M4Task['manifest'];revision:number;hash:string;request:string}>();
  private sending=false; private executing=false; private creation?:Promise<boolean>; private disposed=false;
  private inputIssues:M4InputIssue[]=[]; private inputValidationAttempted=false;
  private referencePickerNotice?:string;
  private status=''; private statusError=false; private creditShortage=false; private saveFailed=false; private startedRunId?:string;
  private cacheKey=''; private pendingCreate?:{creation_request_id:string;name:string;source_project_id?:string};
  private syncOnReturn=()=>{if(this.live()&&document.visibilityState==='visible')void this.refresh();};
  constructor(private api:ApiClient,private owner:string,private shell:(html:string,section:string)=>void,private current:()=>boolean,
    private topicId?:string,private sourceProjectId?:string,private createNew=false,private entryRunId?:string) {this.m4=new M4Api(api,this.controller.signal);this.selected='init';
      for(const type of M4_DOCUMENT_TYPES)this.drafts.set(type,{version:0,input:{document_type:type,source_material:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{},requirements:[]},dirty:false,conflict:false});}

  get hasUnconfirmed(){return this.invalidDraftType||this.uploading||this.uploadPreparing||this.cachePending>0||this.cacheFailure||this.cacheRequestConflict||this.uploadRecordsPresent||!!this.uploadRecoveryProblem||this.viewDirty||[...this.drafts.values()].some(d=>d.dirty)||Boolean(this.pendingMessage||this.pendingExecution);}
  private live(){return !this.disposed&&this.current();}
  dispose(){this.disposed=true;clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);this.controller.abort();this.downloads.dispose();this.referencePicker?.dispose();this.dialog?.remove();document.removeEventListener('visibilitychange',this.syncOnReturn);window.removeEventListener('online',this.syncOnReturn);window.removeEventListener('storage',this.uploadStorageChanged);}
  async beforeLeave(){this.cache();await this.cacheQueue;if(this.uploading||this.uploadPreparing){this.message('材料正在保存，请等待保存结果后离开。',true);return false;}if(this.uploadInputBlocked(false))return !this.cacheFailure;return await this.flush();}
  private uploadInputBlocked(show=true){
    this.scanUploadRecovery();const blocked=this.uploadPreparing||this.uploadReading||this.uploadRecordsPresent||this.cacheRequestConflict||!!this.uploadRecoveryProblem;
    if(blocked){clearTimeout(this.saveTimer);if(show)this.message(this.uploadRecoveryProblem||(this.cacheRequestConflict?'另一页面保留了待确认的发送或制作请求。请重新读取并核对原请求，本页材料与要求保留。':this.templateRecoveryEnvelopes.length||this.templateUploadOrphans.length?'请先在原立项模板区继续核对模板保存或停止本机后续保存，再保存材料与要求或开始任务。':'请先在原材料区继续确认原文件或停止本机后续保存，再保存材料与要求或开始任务。'),true);}
    return blocked;
  }
  private uploadActionBlocked(show=true){if(this.invalidDraftType){if(show)this.message(draftTypeMismatchMessage,true);return true;}if(this.uploadInputBlocked(show))return true;if(this.uploading){if(show)this.message('请先完成原文件保存，再修改本轮材料选择。',true);return true;}return false;}
  private setupUploadRecovery(){
    if(!this.workspace||this.m4Uploads&&this.m4TemplateUploads)return;
    const topic=this.workspace.topic.topic_id,project=this.workspace.topic.project_id;
    const options={current:()=>this.live()&&this.workspace?.topic.topic_id===topic&&this.workspace.topic.project_id===project,snapshot:(type:M4DocumentType)=>{const d=this.drafts.get(type);return d?structuredClone(d):undefined;},signal:this.controller.signal};
    this.m4Uploads=new M4UploadRecovery(this.api,this.m4,this.owner,project,topic,{...options,coordinatePrepare:()=>{if(!this.m4TemplateUploads)throw new UserFacingError('模板保存记录尚未准备好，请重新读取。');if(this.m4TemplateUploads.list().length||this.m4TemplateUploads.transportRecords().length)throw new UserFacingError('原立项模板保存尚未确认，请先在原模板区核对或停止本机后续保存。');}});
    this.m4TemplateUploads=new M4TemplateUploadRecovery(this.api,this.m4,this.owner,project,topic,{...options,coordinatePrepare:()=>{if(!this.m4Uploads)throw new UserFacingError('材料保存记录尚未准备好，请重新读取。');if(this.m4Uploads.list().length||this.m4Uploads.transportRecords().length)throw new UserFacingError('原材料保存尚未确认，请先在原材料区核对或停止本机后续保存。');}});
    this.cacheBaseline=localStorage.getItem(this.cacheKey);this.scanUploadRecovery();
  }
  async render(){
    this.shell('<div class="m4-page m4-generate" id="m4-workspace"><p role="status">正在读取文件生成…</p></div>',projectSection('generate'));
    this.page=document.querySelector('#m4-workspace')!;
    try{
      this.topics=(await this.m4.topics()).topics.filter(t=>t.surface!=='assistant');if(!this.live())return;
      if(!this.topicId&&this.sourceProjectId)this.topicId=this.topics.find(t=>(t.source_project_id===this.sourceProjectId||t.project_id===this.sourceProjectId))?.topic_id;
      if(this.sourceProjectId){const source=await this.api.project(this.sourceProjectId,this.controller.signal);if(!this.live())return;this.projectNames.set(this.sourceProjectId,source.name);}

      if(this.topicId){this.workspace=await this.m4.workspace(this.topicId);if(!this.live())return;this.install(this.workspace,true);this.setupUploadRecovery();this.restore();this.scanUploadRecovery();this.openEntryTask();await this.loadNames();}
      this.page.innerHTML=this.frame();this.bindRecovery();this.bind();this.paint();this.schedulePoll();
      document.addEventListener('visibilitychange',this.syncOnReturn);window.addEventListener('online',this.syncOnReturn);
      window.addEventListener('storage',this.uploadStorageChanged);
      if(this.uploadRecordsPresent)void this.readUploadRecovery();
    }catch(error){if(!this.live())return;this.page.innerHTML=`<div class="m4-empty"><h1>文件生成</h1><p role="alert">${esc(friendlyError(error,'read'))}</p><button class="btn secondary" data-m4-reload>重新读取</button></div>`;this.page.querySelector('[data-m4-reload]')!.addEventListener('click',()=>void this.render());}
  }
  /** A task-list link opens that exact run, overriding only the reading tab. */
  private openEntryTask(){
    if(!this.entryRunId||!this.workspace)return;
    const task=this.workspace.tasks.find(t=>t.run.run_id===this.entryRunId&&t.manifest.kind==='document');
    if(!task){this.message('该任务暂不可读取，请刷新状态或查看已有记录。',true);return;}
    if(task.manifest.kind==='document')this.selected=task.manifest.input.document_type;
    this.reading=openWorkspaceTab(this.reading,{key:`run:${task.run.run_id}`,kind:'making',runId:task.run.run_id,title:'生成进度'});
    const artifact=task.artifacts.find(a=>a.kind==='document');
    if(artifact)this.reading=taskArtifactAvailable(this.reading,task.run.run_id,artifact.artifact_id,artifact.artifact_version,artifactTitle(artifact));
  }
  private frame(){return `${projectListContext()?projectBackLink():''}<header class="page-head"><div><div class="eyebrow">MATERIAL STUDIO</div><h1>文件生成</h1>${this.sourceProjectId?`<p>当前项目：${esc(this.projectNames.get(this.sourceProjectId)??this.sourceProjectId)}</p>`:""}<p>上传最新版募集书，或关联已有募集书项目，按对应模板生成材料。</p></div><button class="text-btn" data-m4-action="refresh">刷新状态</button></header><p id="m4-status" class="m4-status" role="status"></p><div id="m4-page-conflict"></div><div class="studio-layout m4-studio-layout"><section aria-label="材料与要求"><nav id="m4-tabs" class="m4-tabs" role="tablist" aria-label="任务与成果"></nav><div id="m4-content" class="m4-content"></div></section></div>`;}
  private install(w:M4Workspace,initial=false,preserveDrafts=false){
    // Read the authoritative wallet when a task starts or changes state, including
    // terminal changes discovered by polling after a reload or a lost response.
    if(!initial&&w.tasks.some(task=>this.workspace?.tasks.find(old=>old.run.run_id===task.run.run_id)?.run.state!==task.run.state||this.workspace?.tasks.find(old=>old.run.run_id===task.run.run_id)?.credit_charge?.progress?.charged_points!==task.credit_charge?.progress?.charged_points||this.workspace?.tasks.find(old=>old.run.run_id===task.run.run_id)?.credit_charge?.progress?.available_points!==task.credit_charge?.progress?.available_points)){
      window.dispatchEvent(new Event('bondbuddy:credits-changed'));
    }
    const protect=!initial&&(preserveDrafts||this.uploadPreparing||this.uploading||this.uploadReading||this.uploadRecordsPresent||this.cacheRequestConflict||!!this.uploadRecoveryProblem);
    if(protect&&this.workspace?.topic.topic_id===w.topic.topic_id){
      const previous=this.workspace;
      w={...w,drafts:previous.drafts,materials:[...new Map([...previous.materials,...w.materials].map(pin=>[pinKey(pin),pin])).values()],material_details:[...new Map([...(previous.material_details??[]),...(w.material_details??[])].map(detail=>[pinKey(detail),detail])).values()],templates:[...new Map([...previous.templates,...w.templates].map(template=>[`${template.template_id}:${template.template_version}`,template])).values()]};
    }
    this.workspace=w;this.topicId=w.topic.topic_id;this.cacheKey=`bb-m4:${this.owner}:${w.topic.topic_id}`;this.projectNames.set(w.project.project_id,w.project.name);
    for(const type of M4_DOCUMENT_TYPES){const old=this.drafts.get(type);if(protect&&old)continue;if(!old||!old.dirty)this.drafts.set(type,{version:w.drafts[type].version,input:this.inputOf(w.drafts[type]),dirty:false,conflict:false});else if(old.version!==w.drafts[type].version)old.conflict=true;}
    if(initial){const {version,...view}=w.view;this.view=structuredClone(view);this.viewVersion=version;this.selected=view.selected_document_type??'init';this.reading=this.readingFrom(view);}
    const started=w.tasks.find(t=>t.run.run_id===this.startedRunId);if(started&&!isActiveRun(started.run)){this.status=started.run.state==='succeeded'?'本次制作已完成，可在工作区查看和下载成果。':`本次制作${runStateLabel[started.run.state]}，原固定输入保留。`;this.statusError=started.run.state==='failed';this.creditShortage=false;this.startedRunId=undefined;}
    for(const task of w.tasks){if(task.manifest.kind==='document'&&!this.seenDocumentRuns.has(task.run.run_id)){this.seenDocumentRuns.add(task.run.run_id);if(!initial)this.reading=taskSubmitted(this.reading,task.run.run_id,'正在制作');}const document=task.artifacts.find(a=>a.kind==='document');if(document)this.reading=taskArtifactAvailable(this.reading,task.run.run_id,document.artifact_id,document.artifact_version,artifactTitle(document));}
  }
  private inputOf(draft:M4DraftInput):M4DraftInput{
    const {version:_version,sha256:_sha256,updated_at:_updatedAt,...input}=draft as M4DraftInput&{version?:number;sha256?:string;updated_at?:string|null};
    if(!Value.Check(M4DraftInputSchema,input))throw new ApiError(0,'DATA_UNAVAILABLE');
    return structuredClone(input);
  }
  private readingFrom(view:M4ViewState){let reading=initialReading();for(const id of view.making_run_ids??[])if(this.workspace?.tasks.some(t=>t.run.run_id===id&&t.manifest.kind==='document'))reading=openWorkspaceTab(reading,{key:`run:${id}`,kind:'making',runId:id,title:'正在制作'},false);for(const pin of view.open_tabs){const a=this.workspace?.artifacts.find(x=>x.kind!=='qa_text'&&artKey(x)===artKey(pin)&&x.sha256===pin.sha256);if(a)reading=openWorkspaceTab(reading,{key:view.workspace_tab===`run:${a.run_id}`||Object.hasOwn(view.tab_scroll??{},`run:${a.run_id}`)?`run:${a.run_id}`:`artifact:${artKey(a)}`,kind:'artifact',artifactId:a.artifact_id,version:a.artifact_version,title:artifactTitle(a)},false);}reading.selected=view.workspace_tab&&reading.tabs.some(t=>t.key===view.workspace_tab)?view.workspace_tab:view.active_tab?reading.tabs.find(t=>t.kind==='artifact'&&t.artifactId===view.active_tab!.artifact_id&&t.version===view.active_tab!.artifact_version)?.key??'input':'input';reading.scroll=view.tab_scroll??{};return reading;}
  private restore(){try{const c=JSON.parse(localStorage.getItem(this.cacheKey)??'null');if(!c||c.owner!==this.owner||c.topic!==this.topicId)return;for(const type of M4_DOCUMENT_TYPES){const cached=c.drafts?.[type];if(cached?.dirty&&Value.Check(M4DraftInputSchema,cached.input)&&Number.isInteger(cached.version)){if(cached.input.document_type!==type){this.invalidDraftType=true;this.cacheFailure=true;continue;}this.drafts.set(type,{version:cached.version,input:cached.input,dirty:true,conflict:cached.conflict===true||cached.version!==this.workspace!.drafts[type].version});this.status='已恢复未保存草稿；请核对后保存。';}}if(c.viewDirty&&Value.Check(M4ViewStateSchema,c.view)&&Number.isInteger(c.viewVersion)){this.view=c.view;this.viewVersion=c.viewVersion;this.viewDirty=true;this.viewConflict=c.viewVersion!==this.workspace!.view.version;this.selected=this.view.selected_document_type;this.reading=this.readingFrom(this.view);this.status=this.viewConflict?'其他页面修改了显示状态。本页材料和要求已保留，请核对后保存。':'已恢复页面状态与阅读位置。';}if(Value.Check(M4MessageRequestSchema,c.pendingMessage?.request))this.pendingMessage=c.pendingMessage;if(Value.Check(M4ExecuteRequestSchema,c.pendingExecution))this.pendingExecution=c.pendingExecution;}catch{/* Server history remains authoritative. */}}
  private snapshotView(){
    const artifacts=this.reading.tabs.flatMap(t=>t.kind==='artifact'?this.workspace?.artifacts.filter(a=>a.artifact_id===t.artifactId&&a.artifact_version===t.version).map(artifactPin)??[]:[]);
    const current=this.reading.tabs.find(t=>t.key===this.reading.selected);const active=current?.kind==='artifact'?artifacts.find(p=>p.artifact_id===current.artifactId&&p.artifact_version===current.version)??null:null;
    this.view={...this.view,selected_document_type:this.selected,open_tabs:artifacts,active_tab:active,workspace_tab:this.reading.selected,making_run_ids:this.reading.tabs.flatMap(t=>t.kind==='making'?[t.runId]:[]),tab_scroll:this.reading.scroll};return this.view;
  }
  private cache(comparison=false){
    if(!this.cacheKey||!this.m4Uploads||!this.live()||this.invalidDraftType||this.draftComparison?.dialog.open&&!comparison)return;
    const next=JSON.stringify({owner:this.owner,topic:this.topicId,drafts:Object.fromEntries(this.drafts),view:this.snapshotView(),viewVersion:this.viewVersion,viewDirty:this.viewDirty,pendingMessage:this.pendingMessage,pendingExecution:this.pendingExecution});
    this.cachePending++;
    this.cacheQueue=this.cacheQueue.then(async()=>{
      if(!this.live())return;
      try{
        const result=await this.m4Uploads!.mergeCache(this.cacheBaseline,next);if(!this.live())return;
        const baseline=this.cacheBaseline===null?{owner:this.owner,topic:this.topicId,drafts:{}}:JSON.parse(this.cacheBaseline),sent=JSON.parse(next);
        for(const path of result.accepted){if(path.startsWith('draft:')){const type=path.slice(6);baseline.drafts??={};baseline.drafts[type]=sent.drafts[type];}else if(Object.hasOwn(sent,path))baseline[path]=sent[path];else delete baseline[path];}
        const at=(value:Record<string,any>,path:string)=>path.startsWith('draft:')?value.drafts?.[path.slice(6)]:value[path];
        this.cacheFailure=result.rejected.some(path=>!m4UploadSame(at(baseline,path),at(sent,path)));
        this.cacheBaseline=JSON.stringify(baseline);
        if(this.cacheFailure){clearTimeout(this.saveTimer);this.message('另一页面已有新草稿。本页修改仍在，尚未安全缓存，请保持页面打开并核对。',true);}
        if(result.rejected.some(path=>path.startsWith('draft:')&& !m4UploadSame(JSON.parse(result.raw).drafts?.[path.slice(6)],sent.drafts?.[path.slice(6)]))){
          for(const path of result.rejected)if(path.startsWith('draft:')){const type=path.slice(6) as M4DocumentType,d=this.drafts.get(type);if(d&&d.dirty)d.conflict=true;}
        }
      }catch{this.cacheFailure=true;if(this.live())this.message('浏览器未能可靠保存本页草稿，请保持页面打开并核对原文件。',true);}
    }).finally(()=>{this.cachePending--;});
  }
  private acceptCacheBaseline(paths:string[]){
    try{const raw=localStorage.getItem(this.cacheKey),latest=raw===null?{owner:this.owner,topic:this.topicId,drafts:{}}:JSON.parse(raw);if(latest.owner!==this.owner||latest.topic!==this.topicId)throw new Error('invalid scope');const baseline=this.cacheBaseline===null?{owner:this.owner,topic:this.topicId,drafts:{}}:JSON.parse(this.cacheBaseline);for(const path of paths){if(path.startsWith('draft:')){const type=path.slice(6);if(Object.hasOwn(latest.drafts,type))baseline.drafts[type]=latest.drafts[type];else delete baseline.drafts[type];}else if(Object.hasOwn(latest,path))baseline[path]=latest[path];else delete baseline[path];}this.cacheBaseline=JSON.stringify(baseline);return true;}
    catch{this.cacheFailure=true;this.message('本机草稿暂时无法可靠读取，请保持页面打开后重试核对。',true);return false;}
  }
  private changed(type?:M4DocumentType){if(type&&type===this.selected&&this.inputValidationAttempted){this.inputIssues=this.currentInputIssues();this.paintSubmitStatus();this.paintInputIssues();}if(type){const d=this.drafts.get(type);if(d)d.dirty=true;this.docQuote=undefined;this.qaQuote=undefined;}this.viewDirty=true;if(this.qaQuote?.signature!==this.qaSignature())this.qaQuote=undefined;this.cache();clearTimeout(this.saveTimer);if(!this.uploadInputBlocked(false))this.saveTimer=setTimeout(()=>void this.flush(),550);}
  private flush():Promise<boolean>{clearTimeout(this.saveTimer);if(this.invalidDraftType){this.message(draftTypeMismatchMessage,true);return Promise.resolve(false);}if(this.draftComparison?.dialog.open||this.uploadInputBlocked())return Promise.resolve(false);if(this.saving)return this.saving;const p=this.save().then(saved=>{this.saveFailed=!saved&&this.statusError;this.paintSubmitStatus();return saved;});this.saving=p;void p.finally(()=>{if(this.saving===p)this.saving=undefined;});return p;}
  private async save(){
    if(this.uploadInputBlocked())return false;
    if(!this.workspace){if(![...this.drafts.values()].some(d=>d.dirty))return true;if(!await this.ensureWorkspace(this.selected?M4_DOCUMENT_LABELS[this.selected]:'文件生成')||this.uploadInputBlocked())return false;}
    this.cache();await this.cacheQueue;if(!this.live()||this.cacheFailure||this.uploadInputBlocked())return false;
    try{for(const [type,d] of this.drafts){if(!d.dirty)continue;if(this.uploadInputBlocked())return false;if(d.conflict){this.message('输入版本冲突。本页草稿已保留，请核对服务器版本。',true);return false;}const sent=structuredClone(d.input);const {draft}=await this.m4.draft(this.topicId!,{expected_version:d.version,input:sent});if(!this.live()||this.uploadInputBlocked(false))return false;this.draftGeneration++;const previousVersion=d.version;d.version=draft.version;this.workspace!.drafts[type]=draft;if(this.view.unsent_context.document_type===type&&this.view.unsent_context.draft_version===previousVersion){this.view.unsent_context={...this.view.unsent_context,draft_version:draft.version,source_material:structuredClone(draft.source_material)};this.viewDirty=true;}if(m4UploadSame(d.input,sent)){d.input=this.inputOf(draft);d.dirty=false;}}
      if(this.viewDirty){if(this.uploadInputBlocked())return false;if(this.viewConflict){this.message('页面状态版本冲突。本页材料和要求已保留，请核对后继续。',true);return false;}const sent=structuredClone(this.snapshotView());const {view}=await this.m4.view(this.topicId!,{expected_version:this.viewVersion,view:sent});if(!this.live()||this.uploadInputBlocked(false))return false;this.viewVersion=view.version;if(m4UploadSame(this.snapshotView(),sent))this.viewDirty=false;}
      this.cache();await this.cacheQueue;if(!this.live())return false;const remaining=this.cacheFailure||this.viewDirty||[...this.drafts.values()].some(d=>d.dirty);const savedMessage=remaining?'新的草稿修改等待同步，请保存完成后执行。':isActiveRun(this.workspace?.active_run)?'已保存下一任务草稿，当前任务输入保持不变。':'草稿已保存。';this.message(this.referencePickerNotice?this.referencePickerNotice+' '+savedMessage:savedMessage,!!this.referencePickerNotice);if(remaining&&!this.cacheFailure&&!this.uploadInputBlocked(false)){this.saveTimer=setTimeout(()=>void this.flush(),100);}return !remaining;
    }catch(error){if(!this.live())return false;if(error instanceof ApiError&&error.status===409){for(const d of this.drafts.values())if(d.dirty)d.conflict=true;if(this.viewDirty)this.viewConflict=true;}this.cache();this.message(`${friendlyError(error,'save')} 本页草稿已保留。`,true);return false;}}
  private message(text:string,error=false,recharge=false){this.status=text;this.statusError=error;this.creditShortage=recharge;const node=this.page?.querySelector<HTMLElement>('#m4-status');if(node){node.textContent=text;node.hidden=!error&&this.reading.selected!=='input';node.classList.toggle('error',error);}this.paintSubmitStatus();const conflict=this.page?.querySelector('#m4-page-conflict');if(conflict)conflict.innerHTML=this.viewConflict?'<p class="m4-warning" role="alert">另一个页面更改了显示状态。本页材料和要求已保留。<button class="text-btn" data-m4-action="resolve-view">核对页面状态</button></p>':'';}
  private currentInputIssues(){
    const input=this.selected?this.drafts.get(this.selected)?.input:undefined;
    if(!input)return [];
    const template=this.workspace?.templates.find(t=>t.template_id===input.template?.template_id&&t.template_version===input.template?.template_version&&t.status==='active');
    return m4DocumentInputIssues(input,template);
  }
  private inputTarget(field:string){
    const selectors:Record<M4InputField,string>={market:'#m4-market',offering:'#m4-offering',case_template_id:'#m4-case-template',broker:'#m4-broker',template:'#m4-template',source_material:'[data-m4-upload="source"], [data-m4-action="project-picker"]',materials:'[data-m4-upload="material"]'};
    return this.page?.querySelector<HTMLElement>(selectors[field as M4InputField]??'#m4-market');
  }
  private focusInput(field:string){const control=this.inputTarget(field);if(control){(control.closest('.field, .material-group')??control).scrollIntoView({block:'center'});control.focus({preventScroll:true});}}
  private paintInputIssues(){
    this.page?.querySelectorAll('[data-m4-input-error]').forEach(node=>node.remove());
    this.page?.querySelectorAll('[data-m4-input-invalid]').forEach(node=>{node.removeAttribute('aria-invalid');node.removeAttribute('aria-describedby');node.removeAttribute('data-m4-input-invalid');});
    for(const issue of this.inputIssues){
      const control=this.inputTarget(issue.field);if(!control)continue;
      const hint=document.createElement('p');hint.id='m4-input-'+issue.code;hint.className='m4-input-hint';hint.dataset.m4InputError='';hint.textContent=issue.message;
      control.setAttribute('aria-invalid','true');control.setAttribute('data-m4-input-invalid','');control.setAttribute('aria-describedby',[control.getAttribute('aria-describedby'),hint.id].filter(Boolean).join(' '));
      (control.closest('.field, .material-group')??control.parentElement)?.append(hint);
    }
  }
  private submitStatusHtml(){
    if(this.inputIssues.length){
      const labels:Record<M4InputField,string>={market:this.selected==='recommendation'?'选择市场':'选择交易所',offering:'选择品种',case_template_id:'选择案例版式',broker:'填写券商全称',template:'选择或上传模板',source_material:'补充募集书',materials:'补充材料'};
      return `<section class="m4-input-feedback" role="alert" tabindex="-1" aria-label="需要补充的信息"><p>请补充以下信息后，再点击“生成${esc(this.selected?M4_DOCUMENT_LABELS[this.selected]:'材料')}”：</p><ul>${this.inputIssues.map(issue=>`<li><span>${esc(issue.message)}</span><button class="text-btn" data-m4-action="fix-input" data-field="${issue.field}">${labels[issue.field]}</button></li>`).join('')}</ul></section>`;
    }
    return `<p class="m4-status ${this.statusError?'error':''}" role="${this.statusError?'alert':'status'}">${esc(this.status)}</p>${this.creditShortage?'<a class="btn secondary" href="'+esc(rechargeHref(this.workspace?.topic.project_id))+'">查看积分与支付状态</a>':''}${this.saveFailed?'<button class="text-btn" data-m4-action="save">重试保存草稿</button>':''}`;}
  private paintSubmitStatus(){const node=this.page?.querySelector('#m4-submit-status');if(node)node.innerHTML=this.submitStatusHtml();}
  private async loadNames(){if(!this.workspace)return;const projectIds=[...new Set([this.workspace.topic.source_project_id,...this.workspace.materials.map(p=>p.source_project_id)].filter((id):id is string=>Boolean(id)))];const results=await Promise.allSettled(projectIds.filter(id=>!this.projectNames.has(id)).map(async id=>{const p=await this.api.project(id,this.controller.signal);this.projectNames.set(id,p.name);}));for(const r of results)if(r.status==='rejected'&&this.live())this.message('部分来源项目名称暂不可读取，准确引用 ID 与版本保留。',true);}
  private artifactRefTitle(pin:M4ArtifactPin){const a=this.workspace?.artifacts.find(a=>artKey(a)===artKey(pin)&&a.sha256===pin.sha256);return a?artifactTitle(a):pin.artifact_id;}
  private materialName(pin:M4MaterialPin){return this.workspace?.material_details?.find(m=>pinKey(m)===pinKey(pin))?.filename??this.metadata.get(pinKey(pin))?.filename??pin.material_id;}
  private materialHtml(pin:M4MaterialPin,actions=false){return `<li class="m4-file"><header><strong>${esc(this.materialName(pin))}</strong><span>V${pin.material_version}</span></header><p>${esc(this.projectNames.get(pin.source_project_id)??pin.source_project_id)}</p><details><summary>准确引用</summary><p>项目 ${esc(pin.source_project_id)}<br>材料 ${esc(pin.material_id)} · V${pin.material_version}<br>SHA-256 ${esc(pin.sha256)}</p></details>${actions?`<div class="m4-file-actions"><button class="text-btn" data-m4-action="download-material" data-pin="${esc(pinKey(pin))}">下载原材料</button></div>`:''}</li>`;}
  private rememberScroll(){const preview=this.page?.querySelector<HTMLElement>('.m4-preview');if(preview)this.reading.scroll[this.reading.selected]=preview.scrollTop;}
  private paint(){if(!this.page||!this.live())return;this.message(this.invalidDraftType?draftTypeMismatchMessage:this.status,this.invalidDraftType||this.statusError,this.creditShortage);this.paintTabs();this.paintContent();this.paintAgent();this.paintUploadLocks();}
  private paintTabs(){const host=this.page?.querySelector('#m4-tabs');if(!host)return;host.innerHTML=this.reading.tabs.map(t=>{const task=t.kind==='making'?this.workspace?.tasks.find(task=>task.run.run_id===t.runId):undefined;const title=task?(isActiveRun(task.run)?'生成进度':runStateLabel[task.run.state]):t.title;return `<span class="m4-tab-wrap"><button role="tab" aria-selected="${t.key===this.reading.selected}" tabindex="${t.key===this.reading.selected?0:-1}" data-m4-action="tab" data-key="${esc(t.key)}" aria-controls="m4-content">${esc(title)}</button></span>`;}).join('');}
  private paintContent(){
    const host=this.page?.querySelector<HTMLElement>('#m4-content');if(!host)return;
    const active=document.activeElement;const editing=host.contains(active)&&(active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement)?{key:active.dataset.m4Field??active.id,value:active.value,start:active.selectionStart,end:active.selectionEnd}:undefined;
    // A poll must not disconnect the input while its native file chooser is open.
    if(host.contains(active)&&active instanceof HTMLInputElement&&active.type==='file')return;
    const tab=this.reading.tabs.find(t=>t.key===this.reading.selected)!;
    const priorControl=active instanceof HTMLElement&&host.contains(active)?active.closest<HTMLElement>('[data-material-prior-result]'):null;
    const priorHeading=host.dataset.tab===tab.key&&active instanceof HTMLElement&&active.matches('[data-prior-reader-focus]');
    const priorFocus=host.dataset.tab===tab.key&&priorControl&&active instanceof HTMLElement&&(active===priorControl||active.matches('summary')||active.matches('[data-m4-action=prior-artifact]'))?{identity:priorControl.dataset.priorIdentity,kind:active===priorControl?'card':active.matches('summary')?'summary':'button'}:priorHeading?{identity:undefined,kind:'heading'}:undefined;
    const taskFocus=host.dataset.tab===tab.key&&active instanceof HTMLElement&&host.contains(active)?active.matches('[data-task-return]')?{token:active.dataset.taskReturn}:active.matches('summary')&&active.closest('[data-material-task-draft],details[data-m4-detail="task-draft"]')?{detail:active.closest<HTMLElement>('details[data-m4-detail]')?.dataset.m4Detail,identity:active.closest<HTMLElement>('[data-task-draft-identity]')?.dataset.taskDraftIdentity}:undefined:undefined;
    const details=host.dataset.tab===tab.key?[...host.querySelectorAll<HTMLDetailsElement>('details[data-m4-detail]')].map(d=>({key:d.dataset.m4Detail!,open:d.open})):[];host.dataset.tab=tab.key;

    if(!this.workspace){host.innerHTML=this.inputHtml();this.paintInputIssues();return;}
    if(tab.kind==='input')host.innerHTML=this.inputHtml();
    else if(tab.kind==='making'){const task=this.workspace.tasks.find(t=>t.run.run_id===tab.runId);host.innerHTML=task?this.makingHtml(task):'<p class="m4-warning">本轮任务状态暂不可读取。请刷新状态。</p>';}
    else{const a=this.workspace.artifacts.find(a=>a.artifact_id===tab.artifactId&&a.artifact_version===tab.version);host.innerHTML=a?this.artifactHtml(a):'<p class="m4-warning">这份成果暂时无法读取。请刷新状态；原引用仍保留。</p>';if(a&&!this.previews.has(artKey(a))&&!this.previewPending.has(artKey(a))&&!this.previewErrors.has(artKey(a)))void this.loadPreview(a);const preview=host.querySelector<HTMLElement>('.m4-preview');if(preview){preview.scrollTop=this.reading.scroll[tab.key]??0;preview.addEventListener('scroll',()=>{this.reading.scroll[tab.key]=preview.scrollTop;this.changed();},{passive:true});}}
    this.paintInputIssues();
    for(const saved of details){const node=host.querySelector<HTMLDetailsElement>(`details[data-m4-detail="${CSS.escape(saved.key)}"]`);if(node)node.open=saved.open;}
    const restoredPreview=host.querySelector<HTMLElement>('.m4-preview');if(restoredPreview)restoredPreview.scrollTop=this.reading.scroll[tab.key]??0;
    if(editing?.key){const field=host.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[data-m4-field="${CSS.escape(editing.key)}"],#${CSS.escape(editing.key)}`);if(field){field.value=editing.value;field.focus({preventScroll:true});if((field instanceof HTMLTextAreaElement||field.type==='text')&&editing.start!==null)field.setSelectionRange(editing.start,editing.end);}}
    if(priorFocus&&!editing){const cards=[...host.querySelectorAll<HTMLElement>('[data-material-prior-result]')],card=cards.find(c=>c.dataset.priorIdentity===priorFocus.identity),heading=host.querySelector<HTMLElement>('h2');const target=priorFocus.kind==='heading'?heading:priorFocus.kind==='card'?card??cards[0]??heading:card?.querySelector<HTMLElement>(priorFocus.kind==='summary'?'summary':'[data-m4-action=prior-artifact]')??cards[0]??heading;if(target?.tagName==='H2'){target.setAttribute('tabindex','-1');target.dataset.priorReaderFocus='';}target?.focus({preventScroll:true});}
    if(taskFocus&&!editing){const target='token' in taskFocus?[...host.querySelectorAll<HTMLElement>('[data-task-return]')].find(b=>b.dataset.taskReturn===taskFocus.token):taskFocus.detail&&host.querySelector<HTMLElement>('[data-task-draft-identity]')?.dataset.taskDraftIdentity===taskFocus.identity?host.querySelector<HTMLElement>('details[data-m4-detail="'+CSS.escape(taskFocus.detail)+'"] > summary'):undefined;const fallback=host.querySelector<HTMLElement>('h2');if(!target&&fallback)fallback.tabIndex=-1;(target??fallback)?.focus({preventScroll:true});}
    this.paintUploadLocks();
  }
  private typeCards(){
    const descriptions:Record<M4DocumentType,string>={workpaper:'按上传目录编制底稿工作稿。',annual:'依照历史年度报告与募集书编制。',semiannual:'依照历史半年度报告与募集书编制。',issuer:'关联发行人概况与主营业务。',financial:'关联同期间与同口径财务数据。',credit:'关联授信额度和使用情况。',proceeds:'关联募集资金用途和分配金额。',init:'按立项券商的模板组织项目情况、尽调结论和立项申请。',underwriter:'按核查事项组织依据、发现和待落实事项。',legal:'根据项目事实和法律依据起草，逐项标注待核验事项。',private_summary:'按普通私募摘要结构提取募集书核心内容。',application:'按交易所申请书案例的章节和格式编写。',recommendation:'按交易商协会 PPN 或中期票据案例编写。'};
    const fallbackOutline=this.selected==='init'?['项目基本情况','发行人及业务情况','财务与偿债能力','募集资金用途与发行方案','尽职调查与立项条件','风险与立项申请']:this.selected==='underwriter'?['核查范围与依据','发行人主体与公司治理','发行条件与发行安排','财务状况与偿债能力','募集资金用途与信息披露','主要风险与核查意见']:this.selected==='legal'?['出具依据与核查范围','发行人主体资格','批准与授权','发行条件与条款','募集资金用途','重大法律事项','结论与待核实事项']:['重要提示','本次发行概况','发行人概况','财务状况与偿债能力','募集资金用途','增信、保护及信息披露','发行有关机构与备查文件'];
    const input=this.selected?this.drafts.get(this.selected)?.input:undefined;
    const templates=M4_CASE_TEMPLATES.filter(t=>t.document_type===this.selected&&t.market===input?.fields.market&&t.offering===(input?.fields.offering||(this.selected==='recommendation'?'':'private')));
    const caseTemplate=templates.find(t=>t.id===input?.fields.case_template_id)||templates.find(t=>t.default);
    const outline:readonly string[]=caseTemplate?.headings.filter(title=>!title.includes('{{事项标题_')).map(title=>title.replaceAll('{{主承销商}}','主承销商'))??(this.selected==='application'?['按所选交易所加载申请书章节']:this.selected==='recommendation'?['推荐人资质','发行人基本情况','尽调结论和推荐理由','批准与内部核查程序','结论']:fallbackOutline);
    return `<section class="panel form-card"><h2>要生成哪份材料</h2><div class="material-type-grid">${M4_DOCUMENT_TYPES.filter(t=>t!=='workpaper').map(t=>`<label class="material-type ${this.selected===t?'selected':''}"><input type="radio" name="document-type" data-m4-type value="${t}" ${this.selected===t?'checked':''}/><strong>${M4_DOCUMENT_LABELS[t]}</strong><span>${descriptions[t]}</span></label>`).join('')}</div><details class="studio-template-details"><summary>查看模板结构</summary><p>${this.selected==='init'?'实际采用该券商的模板章节与要求，以下为常见内容参考。':caseTemplate?'采用已固定的案例章节及 Word 格式，结合本次材料填写。':'按编制指引组织内容；当前范围尚未提供可复用的案例格式。'}</p><ol>${outline.map(title=>`<li>${esc(title)}</li>`).join('')}</ol><div class="studio-delivery"><strong>可编辑 Word + 编制说明</strong></div></details></section>`;
  }
  private inputHtml(){
    if(!this.selected)return this.typeCards()+this.templateRecoveryNotice()+this.recoveryHtml('source')+this.recoveryHtml('material')+this.artifactsListHtml();
    const draft=this.drafts.get(this.selected)!,input=draft.input,source=input.source_material;
    const applicable=(this.workspace?.templates??[]).filter(t=>t.document_type===this.selected&&t.status==='active'&&t.broker===input.fields.broker?.trim()&&t.market===input.fields.market);
    const busy=isActiveRun(this.workspace?.active_run),sourceMode=input.fields.source_mode??(this.sourceProjectId?'project':'upload');
    const materials=(this.workspace?.materials??[]).filter(p=>!(source&&pinKey(source)===pinKey(p))&&!(input.template&&(this.workspace?.templates??[]).some(t=>t.template_id===input.template!.template_id&&t.template_version===input.template!.template_version&&pinKey(t.material)===pinKey(p))));
    return this.typeCards()+this.templateRecoveryNotice()+`<section class="panel form-card">${this.marketFields(input)}${this.caseTemplatePicker(input)}<p class="authoring-help">按所选市场和品种采用对应材料的编制要求。</p>${draft.conflict?'<p class="m4-warning">其他页面修改了本任务输入。草稿已保留。<button class="text-btn" data-m4-action="resolve-draft">核对输入版本</button></p>':''}</section>
    <section class="panel form-card"><h2>这份材料依据哪份募集书</h2><p>会从募集书和关联资料中提取信息；已关联的材料无需重复上传。</p><div class="history-answer">${[['upload','上传最新版募集书'],['project','关联募集书项目']].map(([value,label])=>`<label class="choice"><input type="radio" name="source-mode" data-m4-source-mode value="${value}" ${sourceMode===value?'checked':''}>${label}</label>`).join('')}</div>${this.sourceHtml(source,sourceMode)}</section>
    ${this.selected==='init'?`<section class="panel form-card" id="m4-template-region"><h2>按立项券商的要求编写</h2><label class="field" for="m4-broker"><span>立项券商全称 <span class="required">*</span></span><input id="m4-broker" data-m4-field="broker" value="${esc(input.fields.broker??'')}" placeholder="例如：某某证券股份有限公司" maxlength="200"/></label><p class="authoring-help">首次使用该券商时，请提供模板或已完成的立项报告。模板仅在本账号使用。</p><label class="field"><span>已保存的模板</span><select id="m4-template"><option value="">选择对应私有模板</option>${applicable.map(t=>`<option value="${esc(t.template_id)}:${t.template_version}" ${input.template?.template_id===t.template_id&&input.template.template_version===t.template_version?'selected':''}>${esc(t.name)} · V${t.template_version}</option>`).join('')}</select></label>${applicable.filter(t=>t.template_id===input.template?.template_id&&t.template_version===input.template?.template_version).map(t=>this.deleteButton(t.material)).join('')}${this.uploadPicker('template','立项模板或已完成的立项报告','.docx')}${this.templateRecoveryHtml()}${this.uploadPicker('material','立项相关规则（选填）','.docx,.pdf,.txt')}</section>`:''}
    <section class="panel form-card"><h2>补充资料</h2><p>${this.selected==='underwriter'?'可补充尽调记录、内核意见、决议、财务资料及资金用途证明。':this.selected==='legal'?'可补充章程、决议授权、权属证明、合同、诉讼及律师核查记录。':'选填 · 发行安排、财务资料、授信、尽调资料等，可按现有情况补充。'}</p>${this.uploadPicker('material','其他支持材料','.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg')}<button type="button" class="btn secondary" data-m4-action="project-picker" data-picker-purpose="material">从已有项目添加补充资料</button>${materials.map(p=>`<div class="m4-material-row"><label class="m4-material-choice"><input type="checkbox" data-m4-material="${esc(pinKey(p))}" ${input.materials.some(m=>pinKey(m)===pinKey(p))?'checked':''}/><span>${esc(this.materialName(p))} · V${p.material_version}</span></label>${this.deleteButton(p)}</div>`).join('')}${this.uploadsHtml()}</section>
    <section class="panel form-card"><h2><label for="m4-requirements">文件生成要求与说明</label> <small class="material-optional">选填</small></h2><textarea id="m4-requirements" rows="5" maxlength="12000" placeholder="补充材料用途、写作重点、格式要求或其他需要说明的事项。">${esc(input.supplemental_requirements??'')}</textarea><p class="authoring-help">自动保存，点击生成时与本次材料一起提交。</p>${input.requirements.length?`<details class="m4-muted"><summary>此前已保存的要求（继续沿用）</summary><ul>${input.requirements.map(r=>`<li>${esc(r.text)}</li>`).join('')}</ul></details>`:''}</section>
    ${input.edit_base?`<p class="m4-accepted">本次全文改稿基于 ${esc(this.artifactRefTitle(input.edit_base))}；原成果保留。</p>`:''}<div class="form-footer"><span>生成可编辑 Word 和编制说明。</span><button class="btn primary" data-m4-action="execute" ${busy||this.uploading||this.executing?'disabled':''}>${this.executing?'正在提交…':busy?'当前项目有任务进行中':'生成'+M4_DOCUMENT_LABELS[this.selected]}</button></div><div id="m4-submit-status">${this.submitStatusHtml()}</div>${this.pendingExecution?'<button class="text-btn" data-m4-action="retry-execution">核对并重试原制作请求</button>':''}${this.artifactsListHtml()}`;
  }
  private marketFields(input:M4DraftInput){
    const markets=input.project_file?MARKETS:M4_DOCUMENT_MARKETS[input.document_type];
    const label=(markets as readonly string[]).includes('nafmii')?'市场':'交易所';
    const offerings=(MARKET_OFFERINGS[input.fields.market as keyof typeof MARKET_OFFERINGS]??[]).filter(offering=>m4DocumentScopeSupported(input.document_type,input.fields.market,offering,!!input.project_file));
    return `<h2>选择${label}与品种</h2><label class="field" for="m4-market"><span>${label} <span class="required">*</span></span><select id="m4-market" data-m4-field="market"><option value="">请选择${label}</option>${markets.map(value=>`<option value="${value}" ${input.fields.market===value?'selected':''}>${MARKET_LABELS[value]}</option>`).join('')}</select></label>${input.project_file||input.document_type==='recommendation'?`<label class="field" for="m4-offering"><span>债券品种 <span class="required">*</span></span><select id="m4-offering" data-m4-field="offering"><option value="">请选择品种</option>${offerings.map(value=>`<option value="${value}" ${input.fields.offering===value?'selected':''}>${OFFERING_LABELS[value]}</option>`).join('')}</select></label>`:''}`;
  }
  private caseTemplatePicker(input:M4DraftInput){
    const templates=M4_CASE_TEMPLATES.filter(t=>t.document_type===input.document_type&&t.market===input.fields.market&&t.offering===(input.fields.offering||(input.document_type==='recommendation'?'':'private')));
    if(!templates.length)return '';
    return `<label class="field" for="m4-case-template"><span>案例版式</span><select id="m4-case-template" data-m4-field="case_template_id"><option value="">自动采用基础版</option>${templates.map(t=>`<option value="${t.id}" ${input.fields.case_template_id===t.id?'selected':''}>${t.label}</option>`).join('')}</select></label><p class="authoring-help">保留案例的章节、标题、字体和表格格式；原项目事实与签署不沿用。</p>`;
  }
  private sourceHtml(source:M4MaterialPin|null,mode:string){
    const projectButton=`<button class="btn secondary" data-m4-action="project-picker" data-picker-purpose="source">${source?'更换募集书项目':'选择募集书项目'}</button>`;
    if(!source)return (mode==='upload'?this.uploadPicker('source','最新版募集说明书','.docx,.pdf'):projectButton)+this.recoveryHtml('source');
    return `<div class="m4-source-file" ${mode==='upload'?'data-m4-drop="source"':''}><div class="m4-source-name"><strong>${esc(this.materialName(source))}</strong><small>本次生成使用此文件</small></div><div class="m4-source-actions"><button class="text-btn" data-m4-action="download-material" data-pin="${esc(pinKey(source))}">下载</button>${this.deleteButton(source)}${mode==='upload'?'<label class="bb-upload-picker bb-upload-picker--compact btn secondary m4-source-replace">替换文件<input type="file" data-m4-upload="source" accept=".docx,.pdf" aria-label="上传最新版募集说明书"/></label>':projectButton}</div></div>${this.duplicateNotices('source')}${this.recoveryHtml('source')}`;
  }
  private uploadPicker(purpose:Upload['purpose'],label:string,accept:string){return `<section class="material-group"><h3>${label}</h3><label class="dropzone compact-dropzone bb-upload-picker bb-upload-picker--standard" data-m4-drop="${purpose}">${uploadPickerContent()}<input type="file" data-m4-upload="${purpose}" accept="${accept}" ${purpose==='material'?'multiple':''} aria-label="上传${label}"/></label><p class="authoring-help">${esc(accept.replaceAll('.','').replaceAll(',',' / ').toUpperCase())}</p>${purpose==='material'?'':this.duplicateNotices(purpose)}</section>`;}
  private duplicateNotices(purpose:Upload['purpose']){const notices=[...this.duplicateUploads.values()].filter(n=>n.purpose===purpose&&(purpose==='attachment'||n.documentType===this.selected));return `<ul class="duplicate-upload-notices">${duplicateUploadNotices(notices)}</ul>`;}
  private uploadsHtml(){return [...this.uploads.entries()].map(([id,u])=>`<p class="m4-status ${u.error?'error':''}">${esc(u.file.name)}${uploadProgressHtml(u.progress??uploadActivity(u.state),u.file.name,{error:u.error,paused:!this.uploading&&!this.uploadPreparing})} ${u.error?`<button class="text-btn" data-m4-action="retry-upload" data-upload-id="${id}">重试此文件</button>${u.material&&this.workspace?this.deleteButton(materialPin(this.workspace.topic.project_id,u.material)):''}`:''}</p>`).join('')+this.recoveryHtml('material')+this.duplicateNotices('material')+this.duplicateNotices('attachment');}
  private scanUploadRecovery(){
    if(!this.m4Uploads)return;
    try{const raw=localStorage.getItem(this.cacheKey);this.cacheRequestConflict=false;if(raw!==null){const cached=JSON.parse(raw);if(!cached||cached.owner!==this.owner||cached.topic!==this.topicId)throw new Error('invalid scope');this.cacheRequestConflict=!!(cached.pendingMessage&&!m4UploadSame(cached.pendingMessage,this.pendingMessage)||cached.pendingExecution&&!m4UploadSame(cached.pendingExecution,this.pendingExecution));}if(!this.m4TemplateUploads)throw new Error('template recovery unavailable');const envelopes=this.m4Uploads.list(),records=this.m4Uploads.transportRecords(),templates=this.m4TemplateUploads.list(),templateRecords=this.m4TemplateUploads.transportRecords();this.recoveryEnvelopes=envelopes;this.templateRecoveryEnvelopes=templates;this.uploadOrphans=records.filter(r=>!envelopes.some(e=>e.items.some(item=>m4UploadRecordMatches(e,item.index,r))));this.templateUploadOrphans=templateRecords.filter(r=>!templates.some(e=>e.items.some(item=>m4TemplateUploadRecordMatches(e,item.index,r))));this.uploadRecordsPresent=!!(envelopes.length||this.uploadOrphans.length||templates.length||this.templateUploadOrphans.length);this.uploadRecoveryProblem='';}
    catch{this.uploadRecordsPresent=true;this.uploadRecoveryProblem='本机文件保存记录暂时无法可靠读取。请恢复本站存储后重新读取；当前不会自动保存或开始任务。';}
  }
  private recoveryHtml(purpose:'source'|'material'){
    const rows=this.recoveryEnvelopes.filter(e=>e.purpose===purpose).flatMap(envelope=>envelope.items.map(item=>{
      if(item.stage==='complete'&&item.localCacheResult==='patched'&&!envelope.items.every(i=>i.stage==='complete'))return '';
      const previous=item.index>0?envelope.items[item.index-1]:undefined,disabled=this.uploading||this.uploadPreparing||this.uploadReading||!!(previous&&(previous.stage!=='complete'||previous.localCacheResult!=='patched'));
      const cleanup=['draft_confirmed','cleanup_pending','complete'].includes(item.stage),error=this.uploadErrors.get(item.id),preserved=item.localCacheResult==='preserved';
      const state=error||this.uploadStatuses.get(item.id)||(preserved?'原材料已保存，本页或另一页面另有修改；后续文件尚未加入。':item.stage==='content_satisfied_pending_unknown'?'原材料内容已核实，另有待处理要求，请核对。':cleanup?'原材料已保存，仅需清理本机待办。':item.draftRequest?'文件已保存，原材料选择待确认。':item.stage==='library_registration_unknown'?'文件已保存，资料库登记待确认。':item.material?'文件已保存，原材料选择待确认。':'原文件保存结果待确认。刷新不会自动上传或保存材料选择。');
      return `<li class="m4-upload-recovery bb-upload-file" data-m4-recovery-id="${esc(item.id)}" data-m4-recovery-envelope="${esc(envelope.id)}"><div><strong>${esc(item.declaration.filename)}</strong><p class="m4-upload-target">${esc(M4_DOCUMENT_LABELS[envelope.documentType])} · ${purpose==='source'?'来源募集书':'补充资料'}</p>${uploadProgressHtml(this.uploading?this.fileProgress.get(item.id)??uploadActivity(state):uploadActivity(state),item.declaration.filename,{error:error||undefined,paused:!this.uploading})}</div><div class="m4-upload-recovery-actions"><button type="button" class="bb-upload-action bb-upload-action--primary text-btn" data-m4-recovery-action="resume" data-operation-id="${esc(item.id)}" ${disabled?'disabled':''}>${cleanup?'清理本机待办':'继续保存原文件'}</button>${this.uploadNeedsFile.has(item.id)&&!item.material?`<label class="bb-upload-picker bb-upload-picker--compact text-btn m4-upload-reselect">重新选择原文件<input type="file" data-m4-recovery-reselect="${esc(item.id)}" accept="${purpose==='source'?'.docx,.pdf':'.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg'}" aria-label="重新选择原文件 ${esc(item.declaration.filename)}" ${disabled?'disabled':''}/></label>`:''}${envelope.documentType!==this.selected?`<button type="button" class="text-btn" data-m4-recovery-target="${esc(envelope.id)}">查看原材料类型</button>`:''}<button type="button" class="bb-upload-action text-btn" data-m4-recovery-remove="${esc(envelope.id)}" ${this.uploading||this.uploadPreparing?'disabled':''}>取消本次上传</button></div><small>停止本机待办不会删除服务器文件或撤销已保存内容。</small></li>`;
    }));
    if(purpose==='material')for(const record of this.uploadOrphans)rows.push(`<li class="m4-upload-recovery bb-upload-file" data-m4-recovery-id="${esc(record.id)}"><strong>${esc(record.declaration.filename)}</strong><p class="m4-status error">原材料选择无法核实，只能移除本机待办。服务器已保存的文件保留。</p><button type="button" class="bb-upload-action text-btn" data-m4-recovery-remove="orphan:${esc(record.id)}" ${this.uploading?'disabled':''}>移除本机待办</button></li>`);
    return rows.some(Boolean)?`<ul class="m4-upload-recovery-list" aria-label="原文件保存待办">${rows.join('')}</ul>`:'';
  }
  private templateRecoveryNotice(){
    if(this.selected==='init'||!this.templateRecoveryEnvelopes.length&&!this.templateUploadOrphans.length)return '';
    const target=this.templateRecoveryEnvelopes[0]?.id??`orphan:${this.templateUploadOrphans[0].id}`;
    return `<p class="m4-warning">原立项模板保存尚待核对，本页材料与要求保留。<button type="button" class="text-btn" data-m4-template-recovery-target="${esc(target)}">查看原立项模板</button></p>`;
  }
  private templateRecoveryHtml(){
    const disabled=this.uploading||this.uploadPreparing||this.uploadReading;
    const rows=this.templateRecoveryEnvelopes.map(envelope=>{
      const item=envelope.items[0],cleanup=['draft_confirmed','cleanup_pending','complete'].includes(item.stage),preserved=item.localCacheResult==='preserved',error=this.uploadErrors.get(item.id);
      const savedState=item.templateReceipt?(cleanup?'模板与服务器原立项草稿已保存。':item.templateAvailability==='unavailable'?'模板已保存，目前不可采用，尚未确认用于原立项草稿。':'模板已保存，尚未确认用于原立项草稿。'):undefined;
      const state=error||this.uploadStatuses.get(item.id)||(item.stage==='content_satisfied_pending_unknown'?'原草稿内容已核实，另有待处理要求，请继续核对。':preserved?'本页或另一页面另有修改，请核对后继续。':cleanup?'仅需清理本机待办。':item.templateReceipt?(item.templateAvailability==='unavailable'?'请核对原模板的当前状态和原文件。':'请继续核对原模板保存与草稿采用。'):item.stage==='template_create_unknown'?'文件已保存，模板创建结果待确认。请继续核对原创建请求。':item.templateRequest?'文件已保存，原模板创建待继续。':item.stage==='library_registration_unknown'?'文件已保存，资料库登记待确认。':item.material?'文件已保存，原模板尚待创建。':'原模板文件保存结果待确认。刷新不会自动上传或创建模板。');
      return `<li class="m4-upload-recovery bb-upload-file" data-m4-template-recovery-id="${esc(item.id)}" data-m4-template-recovery-envelope="${esc(envelope.id)}"><strong>${esc(item.declaration.filename)}</strong><p class="m4-upload-target">立项报告 · 私有模板 · ${esc(envelope.templateIntent.broker)}</p>${savedState?`<p class="m4-status" role="status" data-m4-template-saved-status>${esc(savedState)}</p>`:''}${uploadProgressHtml(this.uploading?this.fileProgress.get(item.id)??uploadActivity(state):uploadActivity(state),item.declaration.filename,{error:error||undefined,paused:!this.uploading})}<div class="m4-upload-recovery-actions"><button type="button" class="bb-upload-action bb-upload-action--primary text-btn" data-m4-template-recovery-action="resume" data-operation-id="${esc(item.id)}" ${disabled?'disabled':''}>${cleanup?'清理本机待办':'继续原模板保存'}</button>${this.uploadNeedsFile.has(item.id)&&!item.material?`<label class="bb-upload-picker bb-upload-picker--compact text-btn m4-upload-reselect">重新选择原文件<input type="file" data-m4-template-recovery-reselect="${esc(item.id)}" accept=".docx" aria-label="重新选择原模板文件 ${esc(item.declaration.filename)}" ${disabled?'disabled':''}/></label>`:''}<button type="button" class="text-btn" data-m4-template-recovery-target="${esc(envelope.id)}">查看原立项模板</button><button type="button" class="bb-upload-action text-btn" data-m4-template-recovery-remove="${esc(envelope.id)}" ${disabled?'disabled':''}>取消本次上传</button></div><small>停止本机待办不会删除服务器文件、资料库成员或模板，也不会撤销已保存草稿。</small></li>`;
    });
    for(const record of this.templateUploadOrphans)rows.push(`<li class="m4-upload-recovery bb-upload-file" data-m4-template-recovery-id="${esc(record.id)}"><strong>${esc(record.declaration.filename)}</strong><p class="m4-status error">原立项模板操作无法核实，只能移除本机待办。服务器已保存的文件和模板保留。</p><button type="button" class="bb-upload-action text-btn" data-m4-template-recovery-remove="orphan:${esc(record.id)}" ${disabled?'disabled':''}>移除本机待办</button></li>`);
    return rows.length?`<ul class="m4-upload-recovery-list" aria-label="原立项模板保存待办">${rows.join('')}</ul>`:'';
  }
  private templateUploadErrorText(error:unknown,operationId?:string){
    if(operationId&&(error instanceof TypeError||error instanceof ApiError&&error.code==='DATA_UNAVAILABLE'&&(error.status===0||error.status>=500))){
      let saved=false,known=false;try{const item=this.m4TemplateUploads?.list().flatMap(e=>e.items).find(i=>i.id===operationId);saved=!!item?.material;known=!!item?.templateReceipt;}catch{}
      return known?'模板已保存，尚未确认用于原立项草稿。请点击“继续原模板保存”核对。':saved?'文件已保存，原模板创建或采用待确认。请点击“继续原模板保存”核对原请求。':'原模板文件保存结果待确认。请检查网络后点击“继续原模板保存”核对原上传。';
    }
    return this.uploadErrorText(error).replace(/原键与完整请求已保留/g,'原模板保存请求已保留').replace(/原模板创建键的完整请求冲突/g,'原模板保存请求与服务器记录不一致').replace(/刷新不会按名称或内容猜测原回执/g,'刷新不会自动重新创建模板');
  }
  private uploadErrorText(error:unknown,operationId?:string){
    if(operationId&&(error instanceof TypeError||error instanceof ApiError&&error.code==='DATA_UNAVAILABLE'&&(error.status===0||error.status>=500))){
      let saved=false;try{saved=!!operationId&&!!this.m4Uploads?.list().some(e=>e.items.some(i=>i.id===operationId&&!!i.material));}catch{}
      return saved?'文件已保存，原材料选择待确认。请点击“继续保存原文件”核对原保存。':'原文件保存结果待确认。请检查网络后点击“继续保存原文件”核对原上传。';
    }
    return (friendlyError(error,'save')).replace(/原文种/g,'原材料类型').replace(/原采用/g,'原材料选择').replace(/原话题/g,'原工作区').replace(/未重基或覆盖后续内容/g,'未覆盖后续修改');
  }
  private uploadCallbacks(id:string){return {status:(text:string)=>{if(!this.live())return;try{const record=this.m4Uploads?.transportRecords().find(r=>r.id===id);if(record?.uploadId)this.uploadOriginalIds.set(id,record.uploadId);}catch{}this.uploadStatuses.set(id,text);this.fileProgress.set(id,uploadActivity(text));this.scanUploadRecovery();this.paint();},progress:(loaded:number,total:number)=>{if(!this.live())return;this.fileProgress.set(id,uploadTransfer(loaded,total));this.uploadStatuses.set(id,loaded>=total?'传输完成，正在确认文件保存…':`正在上传 ${Math.min(100,Math.round(loaded/Math.max(1,total)*100))}%…`);this.paint();}};}
  private templateUploadCallbacks(id:string){return {status:(text:string)=>{if(!this.live())return;try{const record=this.m4TemplateUploads?.transportRecords().find(r=>r.id===id);if(record?.uploadId)this.uploadOriginalIds.set(id,record.uploadId);}catch{}this.uploadStatuses.set(id,text);this.fileProgress.set(id,uploadActivity(text));this.scanUploadRecovery();this.paint();},progress:(loaded:number,total:number)=>{if(!this.live())return;this.fileProgress.set(id,uploadTransfer(loaded,total));this.uploadStatuses.set(id,loaded>=total?'传输完成，正在确认模板文件保存…':`正在上传 ${Math.min(100,Math.round(loaded/Math.max(1,total)*100))}%…`);this.paint();}};}
  private canApplyUploadResult(result:M4UploadResult|M4TemplateUploadResult,index:number){
    if(!result.applyToPage||!result.draft||this.pendingMessage||this.pendingExecution||result.envelope.owner!==this.owner||result.envelope.topicId!==this.workspace?.topic.topic_id||result.envelope.projectId!==this.workspace.topic.project_id)return false;
    const envelope=result.envelope,item=envelope.items[index],observed={version:result.draft.version,input:this.inputOf(result.draft),dirty:false,conflict:false},current=this.drafts.get(envelope.documentType);
    if(!m4UploadSame(current,item.adoptionBase)&&!m4UploadSame(current,observed))return false;
    try{const cached=JSON.parse(localStorage.getItem(this.cacheKey)??'null');return cached?.owner===this.owner&&cached.topic===envelope.topicId&&!cached.pendingMessage&&!cached.pendingExecution&&m4UploadSame(cached.drafts?.[envelope.documentType],observed);}
    catch{return false;}
  }
  private preserveLocalUploadEdit(result:M4UploadResult|M4TemplateUploadResult,index:number){
    if(!result.draft||!result.applyToPage)return;
    const envelope=structuredClone(result.envelope),draft=structuredClone(result.draft),item=envelope.items[index],observed={version:draft.version,input:this.inputOf(draft),dirty:false,conflict:false};
    this.cachePending++;
    this.cacheQueue=this.cacheQueue.then(()=>{
      if(!this.live()||this.pendingMessage||this.pendingExecution||envelope.owner!==this.owner||envelope.topicId!==this.workspace?.topic.topic_id||envelope.projectId!==this.workspace.topic.project_id)return;
      const current=this.drafts.get(envelope.documentType);
      if(!current?.dirty||!item.adoptionBase||current.version!==item.adoptionBase.version||m4UploadSame(current.input,item.adoptionBase.input)||!m4UploadSame(item.observedDraft,draft))return;
      try{
        const latest=JSON.parse(localStorage.getItem(this.cacheKey)??'null'),baseline=this.cacheBaseline===null?{owner:this.owner,topic:this.topicId,drafts:{}}:JSON.parse(this.cacheBaseline),before=baseline.drafts?.[envelope.documentType];
        if(latest?.owner!==this.owner||latest.topic!==envelope.topicId||latest.pendingMessage||latest.pendingExecution||baseline.owner!==this.owner||baseline.topic!==envelope.topicId||!m4UploadSame(latest.drafts?.[envelope.documentType],observed)||before!==undefined&&!m4UploadSame(before,item.adoptionBase)&&!m4UploadSame(before,observed))return;
        // Earlier snapshots must settle before this child's proof advances the comparison baseline.
        // A later queued merge rechecks durable state before writing the current local edit.
        baseline.drafts??={};baseline.drafts[envelope.documentType]=observed;this.cacheBaseline=JSON.stringify(baseline);
      }catch{/* The guarded cache queue preserves the durable value if it cannot be verified. */}
    }).finally(()=>{this.cachePending--;});
  }
  private applyUploadResult(result:M4UploadResult,index:number):boolean{
    if(!this.live()||!this.workspace)return false;const envelope=result.envelope,item=envelope.items[index];this.uploadStatuses.delete(item.id);if(result.draft)this.draftGeneration++;
    if(item.material){const pin=materialPin(envelope.projectId,item.material);this.metadata.set(pinKey(pin),item.material);if(['library_registered','draft_prepared','draft_unknown','draft_confirmed','content_satisfied_pending_unknown','cleanup_pending','complete'].includes(item.stage)&&!this.workspace.materials.some(p=>pinKey(p)===pinKey(pin)))this.workspace.materials.push(pin);
      if(item.material.filename!==item.declaration.filename||this.uploadOriginalIds.has(item.id)&&this.uploadOriginalIds.get(item.id)!==item.material.upload_id)this.duplicateUploads.set(item.id,{filename:item.declaration.filename,material:item.material,purpose:envelope.purpose,documentType:envelope.documentType});}
    const applied=this.canApplyUploadResult(result,index);
    if(result.draft&&applied){this.workspace.drafts[envelope.documentType]=structuredClone(result.draft);this.drafts.set(envelope.documentType,{version:result.draft.version,input:this.inputOf(result.draft),dirty:false,conflict:false});this.docQuote=undefined;this.qaQuote=undefined;}
    else if(result.draft){if(result.state!=='pending_unknown'){const d=this.drafts.get(envelope.documentType);if(d)d.conflict=true;this.preserveLocalUploadEdit(result,index);}clearTimeout(this.saveTimer);}
    const reason=result.reason||(result.draft&&result.applyToPage&&!applied?'原文件已保存，本页或另一页面另有修改，请核对材料与要求。':undefined);
    if(reason)this.uploadErrors.set(item.id,this.uploadErrorText(new UserFacingError(reason)));else this.uploadErrors.delete(item.id);
    if(result.state==='complete'||result.state==='content_confirmed'){this.uploadFiles.delete(item.id);this.uploadNeedsFile.delete(item.id);}
    this.scanUploadRecovery();this.paint();this.message(reason?this.uploadErrorText(new UserFacingError(reason)):result.state==='complete'||result.state==='content_confirmed'?'原文件和材料选择已保存，尚未开始生成。':'原文件保存结果尚未确认，请继续核对。',!!reason||result.state==='conflict');return applied;
  }
  private applyTemplateUploadResult(result:M4TemplateUploadResult,index:number):boolean{
    if(!this.live()||!this.workspace||result.envelope.owner!==this.owner||result.envelope.topicId!==this.workspace.topic.topic_id||result.envelope.projectId!==this.workspace.topic.project_id)return false;
    const envelope=result.envelope,item=envelope.items[index];this.uploadStatuses.delete(item.id);if(result.draft)this.draftGeneration++;
    if(item.material){const pin=materialPin(envelope.projectId,item.material);this.metadata.set(pinKey(pin),item.material);if(result.draft&&item.templateAvailability==='active'&&!this.workspace.materials.some(p=>pinKey(p)===pinKey(pin)))this.workspace.materials.push(pin);
      if(item.material.filename!==item.declaration.filename||this.uploadOriginalIds.has(item.id)&&this.uploadOriginalIds.get(item.id)!==item.material.upload_id)this.duplicateUploads.set(item.id,{filename:item.declaration.filename,material:item.material,purpose:'template',documentType:'init'});}
    if(item.templateReceipt){const receipt=structuredClone(item.templateReceipt);if(item.templateAvailability==='unavailable')this.workspace.templates=this.workspace.templates.filter(t=>t.template_id!==receipt.template_id||t.template_version!==receipt.template_version);else if(item.templateAvailability==='active'){const at=this.workspace.templates.findIndex(t=>t.template_id===receipt.template_id&&t.template_version===receipt.template_version);if(at<0)this.workspace.templates.push(receipt);else this.workspace.templates[at]=receipt;}}
    const applied=this.canApplyUploadResult(result,index);
    if(result.draft&&applied){this.workspace.drafts.init=structuredClone(result.draft);this.drafts.set('init',{version:result.draft.version,input:this.inputOf(result.draft),dirty:false,conflict:false});this.docQuote=undefined;this.qaQuote=undefined;}
    else if(result.draft){if(result.state!=='pending_unknown'){const draft=this.drafts.get('init');if(draft)draft.conflict=true;this.preserveLocalUploadEdit(result,index);}clearTimeout(this.saveTimer);}
    const reason=result.reason||(result.draft&&result.applyToPage&&!applied?'模板已保存，本页或另一页面另有修改，尚未确认用于原立项草稿。':undefined);
    if(reason)this.uploadErrors.set(item.id,this.templateUploadErrorText(new UserFacingError(reason)));else this.uploadErrors.delete(item.id);
    if(result.state==='complete'||result.state==='content_confirmed'){this.uploadFiles.delete(item.id);this.uploadNeedsFile.delete(item.id);}
    this.scanUploadRecovery();this.paint();this.message(reason?this.templateUploadErrorText(new UserFacingError(reason)):result.state==='complete'||result.state==='content_confirmed'?'模板与原立项草稿已保存，尚未开始生成。':item.templateReceipt?'模板已保存，尚未确认用于原立项草稿，请继续核对。':'原模板保存结果尚未确认，请继续核对。',!!reason||result.state==='conflict'||result.state==='unavailable');return applied;
  }
  private async resumeTemplateUploadRecovery(id:string,file?:File){
    if(this.uploading||this.uploadPreparing||this.uploadReading||!this.m4TemplateUploads||!this.live())return;
    this.scanUploadRecovery();if(this.uploadRecoveryProblem||this.recoveryEnvelopes.length||this.uploadOrphans.length){this.message(this.uploadRecoveryProblem||'另有原材料保存待办，请先核对原材料；模板操作保留。',true);return;}
    const envelope=this.templateRecoveryEnvelopes.find(e=>e.items.some(i=>i.id===id)),item=envelope?.items.find(i=>i.id===id);if(!envelope||!item)return;
    this.uploading=true;clearTimeout(this.saveTimer);if(file)this.uploadFiles.set(id,file);this.uploadErrors.delete(id);this.paint();
    try{this.cache();await this.cacheQueue;if(!this.live()||this.cacheFailure)return;const result=await this.m4TemplateUploads.resume(envelope.id,item.index,{file:file??this.uploadFiles.get(id),retryMembership:true,retryTemplate:true,retryDraft:true,...this.templateUploadCallbacks(id)});if(!this.live())return;this.applyTemplateUploadResult(result,item.index);}
    catch(error){if(this.live()){if(error instanceof UploadRecoveryNeedsFileError)this.uploadNeedsFile.add(id);this.uploadStatuses.delete(id);this.uploadErrors.set(id,this.templateUploadErrorText(error,id));this.message(this.templateUploadErrorText(error,id),true);}}
    finally{this.uploading=false;if(this.live()){this.scanUploadRecovery();this.cache();this.paint();}}
  }
  private async removeTemplateUploadRecovery(id:string){
    if(this.uploading||this.uploadPreparing||this.uploadReading||!this.m4TemplateUploads)return;this.uploading=true;this.paint();
    try{await this.cacheQueue;if(!this.live())return;if(id.startsWith('orphan:'))await this.m4TemplateUploads.removeOrphan(id.slice(7));else await this.m4TemplateUploads.stop(id);if(!this.live())return;this.message('本机模板待办已停止。服务器已保存的文件、资料库成员、模板和草稿保留；本页新修改仍需明确保存。');}
    catch(error){if(this.live())this.message(this.templateUploadErrorText(error),true);}
    finally{this.uploading=false;if(this.live()){this.scanUploadRecovery();this.cache();this.paint();}}
  }
  private async resumeUploadRecovery(id:string,file?:File){
    if(this.uploading||this.uploadPreparing||this.uploadReading||!this.m4Uploads||!this.live())return;this.scanUploadRecovery();if(this.uploadRecoveryProblem||this.templateRecoveryEnvelopes.length||this.templateUploadOrphans.length){this.message(this.uploadRecoveryProblem||'另有原立项模板保存待办，请先核对原模板；材料操作保留。',true);return;}const envelope=this.recoveryEnvelopes.find(e=>e.items.some(i=>i.id===id)),item=envelope?.items.find(i=>i.id===id);if(!envelope||!item)return;
    this.uploading=true;clearTimeout(this.saveTimer);if(file)this.uploadFiles.set(id,file);this.uploadErrors.delete(id);this.paint();
    try{this.cache();await this.cacheQueue;if(!this.live()||this.cacheFailure)return;const result=await this.m4Uploads.resume(envelope.id,item.index,{file:file??this.uploadFiles.get(id),retryDraft:true,retryMembership:true,...this.uploadCallbacks(id)});if(!this.live())return;this.applyUploadResult(result,item.index);}
    catch(error){if(this.live()){if(error instanceof UploadRecoveryNeedsFileError)this.uploadNeedsFile.add(id);this.uploadErrors.set(id,this.uploadErrorText(error,id));this.message(this.uploadErrorText(error,id),true);}}
    finally{this.uploading=false;if(this.live()){this.scanUploadRecovery();this.cache();this.paint();}}
  }
  private async removeUploadRecovery(id:string){
    if(this.uploading||this.uploadPreparing||!this.m4Uploads)return;this.uploading=true;this.paint();
    try{await this.cacheQueue;if(!this.live())return;if(id.startsWith('orphan:'))await this.m4Uploads.removeOrphan(id.slice(7));else await this.m4Uploads.stop(id);if(!this.live())return;this.message('本机待办已移除，服务器文件和已有保存保留；本页新修改仍需明确保存。');}
    catch(error){if(this.live())this.message(this.uploadErrorText(error),true);}
    finally{this.uploading=false;if(this.live()){this.scanUploadRecovery();this.paint();}}
  }
  private async readUploadRecovery(){
    if(this.uploadReading||this.uploading||this.uploadPreparing||!this.m4Uploads||!this.m4TemplateUploads)return;this.uploadReading=true;clearTimeout(this.saveTimer);this.paint();
    try{await this.cacheQueue;for(const envelope of [...this.recoveryEnvelopes])for(const item of envelope.items){if(!this.live())return;if(item.index>0&&(envelope.items[item.index-1].stage!=='complete'||envelope.items[item.index-1].localCacheResult!=='patched'))break;try{const result=await this.m4Uploads.reconcile(envelope.id,item.index);if(!this.live())return;this.applyUploadResult(result,item.index);}catch(error){if(this.live())this.uploadErrors.set(item.id,this.uploadErrorText(error,item.id));}}for(const envelope of [...this.templateRecoveryEnvelopes]){if(!this.live())return;const item=envelope.items[0];try{const result=await this.m4TemplateUploads.reconcile(envelope.id,item.index);if(!this.live())return;this.applyTemplateUploadResult(result,item.index);}catch(error){if(this.live())this.uploadErrors.set(item.id,this.templateUploadErrorText(error,item.id));}}}
    finally{this.uploadReading=false;if(this.live()){this.scanUploadRecovery();this.cache();this.paint();}}
  }
  private bindRecovery(){
    this.page!.addEventListener('click',event=>{
      const templateTarget=event.target as HTMLElement,templateResume=templateTarget.closest<HTMLElement>('[data-m4-template-recovery-action="resume"]'),templateRemove=templateTarget.closest<HTMLElement>('[data-m4-template-recovery-remove]'),templateOriginal=templateTarget.closest<HTMLElement>('[data-m4-template-recovery-target]');
      if(templateResume||templateRemove||templateOriginal){event.preventDefault();event.stopImmediatePropagation();if(templateResume)void this.resumeTemplateUploadRecovery(templateResume.dataset.operationId!);else if(templateRemove)void this.removeTemplateUploadRecovery(templateRemove.dataset.m4TemplateRecoveryRemove!);else {this.selectType('init');const id=templateOriginal!.dataset.m4TemplateRecoveryTarget!,row=this.page?.querySelector<HTMLElement>(`[data-m4-template-recovery-envelope="${CSS.escape(id)}"]`)??this.page?.querySelector<HTMLElement>('#m4-template-region');row?.scrollIntoView({block:'center'});const control=row?.querySelector<HTMLButtonElement>('[data-m4-template-recovery-action="resume"],[data-m4-template-recovery-remove]');if(control)control.focus({preventScroll:true});else if(row){row.tabIndex=-1;row.focus({preventScroll:true});}}return;}
      const target=event.target as HTMLElement,resume=target.closest<HTMLElement>('[data-m4-recovery-action="resume"]'),remove=target.closest<HTMLElement>('[data-m4-recovery-remove]'),original=target.closest<HTMLElement>('[data-m4-recovery-target]');
      if(resume||remove||original){event.preventDefault();event.stopImmediatePropagation();if(resume)void this.resumeUploadRecovery(resume.dataset.operationId!);else if(remove)void this.removeUploadRecovery(remove.dataset.m4RecoveryRemove!);else {const envelope=this.recoveryEnvelopes.find(e=>e.id===original!.dataset.m4RecoveryTarget);if(envelope){this.selectType(envelope.documentType);const row=this.page?.querySelector<HTMLElement>(`[data-m4-recovery-envelope="${CSS.escape(envelope.id)}"]`);row?.scrollIntoView({block:'center'});row?.querySelector<HTMLButtonElement>('[data-m4-recovery-action="resume"]')?.focus({preventScroll:true});}}return;}
      const action=target.closest<HTMLElement>('[data-m4-action]')?.dataset.m4Action;
      if(action&&['execute','send','save','retry-execution','resolve-draft','resolve-view','delete-material','continue','project-picker','adopt-project-material','retry-upload'].includes(action)&&this.uploadActionBlocked()){event.preventDefault();event.stopImmediatePropagation();}
    },true);
    this.page!.addEventListener('change',event=>{
      const target=event.target;if(!(target instanceof HTMLInputElement||target instanceof HTMLSelectElement))return;
      if(target instanceof HTMLInputElement&&target.dataset.m4TemplateRecoveryReselect){event.preventDefault();event.stopImmediatePropagation();const file=target.files?.[0],id=target.dataset.m4TemplateRecoveryReselect;target.value='';target.blur();if(file)void this.resumeTemplateUploadRecovery(id,file);return;}
      if(target instanceof HTMLInputElement&&target.dataset.m4RecoveryReselect){event.preventDefault();event.stopImmediatePropagation();const file=target.files?.[0],id=target.dataset.m4RecoveryReselect;target.value='';target.blur();if(file)void this.resumeUploadRecovery(id,file);return;}
      const protectedChoice=target.hasAttribute('data-m4-source-mode')||target.hasAttribute('data-m4-material')||target.id==='m4-template'||target.hasAttribute('data-m4-agent-upload')||target.hasAttribute('data-m4-upload');
      if(protectedChoice&&this.uploadActionBlocked()){event.preventDefault();event.stopImmediatePropagation();if(target instanceof HTMLInputElement&&target.type==='file')target.value='';this.paintContent();this.paintUploadLocks();}
    },true);
  }
  private paintUploadLocks(){
    const blocked=this.uploadPreparing||this.uploading||this.uploadReading||this.uploadRecordsPresent||this.cacheRequestConflict||!!this.uploadRecoveryProblem;
    for(const control of this.page?.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('[data-m4-source-mode],[data-m4-material],#m4-template,[data-m4-upload],[data-m4-agent-upload],[data-m4-action="project-picker"],[data-m4-action="delete-material"],[data-m4-action="continue"],[data-m4-action="save"],[data-m4-action="resolve-draft"],[data-m4-action="resolve-view"],[data-m4-action="retry-execution"],[data-m4-action="send"]')??[]){const action=control.dataset.m4Action,busy=action==='delete-material'?!!this.deletingMaterial||isActiveRun(this.workspace?.active_run):action==='send'?this.sending||!this.view.unsent_content.trim()&&!this.pendingMessage:false;control.disabled=blocked||busy;}
    for(const button of this.page?.querySelectorAll<HTMLButtonElement>('[data-m4-action="execute"]')??[])button.disabled=blocked||this.executing||isActiveRun(this.workspace?.active_run);
    const host=this.page?.querySelector('#m4-page-conflict');if(host&&this.uploadRecoveryProblem)host.innerHTML=`<p class="m4-warning" role="alert">${esc(this.uploadRecoveryProblem)}</p>`;
  }
  private libraryHtml(){return `<section class="m4-section"><h3>工作区材料</h3><p class="m4-muted">可引用已保存材料提问；选择材料类型后出现对应上传区。</p><ul class="m4-file-list">${(this.workspace?.materials??[]).map(p=>this.materialHtml(p,true)).join('')||'<li class="m4-muted">暂未添加材料。可直接向助手提问，或选择制作材料。</li>'}</ul><button class="btn secondary" data-m4-action="project-picker" data-picker-purpose="material">从已有项目选择材料</button></section>`;}
  private artifactsListHtml(){const latest=[...(this.workspace?.tasks??[])].reverse().find(t=>t.manifest.kind==='document'&&!t.artifacts.some(a=>a.kind==='document'));return (latest?`<p class="m4-recent-run"><span>${latest.manifest.kind==='document'?M4_DOCUMENT_LABELS[latest.manifest.input.document_type]:''} · ${runStateLabel[latest.run.state]}</span><button class="text-btn" data-m4-action="task" data-run="${esc(latest.run.run_id)}">${isActiveRun(latest.run)?'查看生成进度':'查看本轮任务'}</button></p>`:'')+(this.workspace?.artifacts.some(a=>a.kind!=='qa_text')?`<section class="m4-section m4-results"><h3>已有成果</h3><ul class="m4-history">${[...this.workspace!.artifacts].filter(a=>a.kind!=='qa_text').reverse().map(a=>`<li><button class="text-btn" data-m4-action="artifact" data-artifact="${esc(artKey(a))}">${esc(artifactTitle(a))}</button><p class="m4-muted">${a.kind==='document'?'可编辑 Word':a.kind==='preparation_note'?'独立制作说明':'对话文本'}${a.base_artifact?` · 基于 ${esc(this.artifactRefTitle(a.base_artifact))}`:''}</p></li>`).join('')}</ul></section>`:'');}
  private quoteHtml(response:M4QuoteResponse){const fixed=response.quote.billing_method==='fixed';return `<div class="m4-price"><strong>${formatPoints(response.quote.points)}</strong> 积分${fixed?' · 固定价':int64(response.quote.points)>0n?'预留上限 B':' · 免费'}<p>可用 ${response.balance.available} 积分。${esc(response.quote.reason)}</p>${int64(response.quote.points)>0n?`<p>${response.quote.billing_policy==='authoring_balance_v2'?'有积分即可开始；排队和暂停不扣积分，重复下载不另收费。':fixed?'确认后冻结本次积分；内部重试和重复下载不另收费。':'按实际用量结算，上限为本次预留积分；未使用部分释放。'}</p>`:''}${int64(response.shortage)>0n?`<p class="m4-warning">还缺 ${response.shortage} 积分。请到账号页查看积分与支付渠道状态；积分充足后需重新确认，不会自动执行。</p><a class="text-btn" href="${esc(rechargeHref(this.workspace?.topic.project_id))}">查看积分与支付状态</a>`:''}</div>`;}
  /** Resolve only an unambiguous task in this workspace; a run's billing scope may be its linked root project. */
  private currentDocumentTask(runId:string){
    const w=this.workspace,matches=w?.tasks.filter(t=>t.run.run_id===runId)??[];
    if(!w||w.topic.topic_id!==this.topicId||w.project.project_id!==w.topic.project_id||matches.length!==1)return;
    const task=matches[0]!;
    if(task.manifest.kind!=='document'||task.manifest.topic_id!==w.topic.topic_id||task.run.project_id!==w.topic.project_id)return;
    const draft=this.drafts.get(task.manifest.input.document_type);
    if(!draft||draft.input.document_type!==task.manifest.input.document_type)return;
    return {task,draft};
  }
  private taskReturnHtml(task:M4Task){
    if(task.manifest.kind!=='document')return '';
    const current=this.currentDocumentTask(task.run.run_id),w=this.workspace;
    if(!current||!w||!sameMaterialDraftValue(current.task.manifest,task.manifest))return '<p class="m4-warning">当前任务引用暂不可核实，请刷新状态后再返回材料与要求。</p>';
    let identity=this.taskReturns.get(task.run.run_id);
    if(!identity||identity.topic!==w.topic.topic_id||identity.project!==w.topic.project_id||!sameMaterialDraftValue(identity.manifest,task.manifest)||identity.revision!==task.run.input_revision||identity.hash!==task.run.input_hash||identity.request!==task.run.execution_request_id){
      identity={token:String(++this.taskReturnSequence),topic:w.topic.topic_id,project:w.topic.project_id,manifest:structuredClone(task.manifest),revision:task.run.input_revision,hash:task.run.input_hash,request:task.run.execution_request_id};this.taskReturns.set(task.run.run_id,identity);
    }
    return '<button class="btn secondary" data-m4-action="prepare" data-run="'+esc(task.run.run_id)+'" data-task-return="'+identity.token+'">返回'+esc(M4_DOCUMENT_LABELS[task.manifest.input.document_type])+'材料与要求</button>';
  }
  private returnToTaskDraft(runId:string,token:string){
    const current=this.currentDocumentTask(runId),identity=this.taskReturns.get(runId),w=this.workspace;
    if(!this.live()||this.invalidDraftType||!current||!identity||identity.token!==token||!w||identity.topic!==w.topic.topic_id||identity.project!==w.topic.project_id||!sameMaterialDraftValue(identity.manifest,current.task.manifest)||identity.revision!==current.task.run.input_revision||identity.hash!==current.task.run.input_hash||identity.request!==current.task.run.execution_request_id){this.message('该任务引用已有变化或暂不可核实。请刷新状态，核对任务后再返回材料与要求。',true);return;}
    const type=current.draft.input.document_type;
    this.rememberScroll();this.selected=type;this.reading=prepareInput(this.reading,type);this.inputIssues=[];this.inputValidationAttempted=false;this.docQuote=undefined;
    // Navigation keeps complete local drafts and discussion context; selecting a type would adopt pending requirements.
    this.changed();this.paint();this.message('已返回'+M4_DOCUMENT_LABELS[type]+'当前草稿，现有材料与要求已保留。');
    this.page?.querySelector<HTMLElement>('[data-m4-type]:checked')?.focus({preventScroll:false});
  }
  private taskDraftHtml(task:M4Task){
    if(task.manifest.kind!=='document'||!this.workspace)return '';
    const current=this.currentDocumentTask(task.run.run_id);
    if(!current||!sameMaterialDraftValue(current.task.manifest,task.manifest))return '<p class="m4-warning">当前同文种草稿暂不可可靠对应，请刷新状态后核对。</p>';
    const input=task.manifest.input,draft=current.draft,label=M4_DOCUMENT_LABELS[input.document_type];
    let reading=this.taskDraftReadings.get(task.run.run_id);
    if(!reading||!sameMaterialDraftValue(reading.manifest,task.manifest)||!sameMaterialDraftValue(reading.draft,draft)){reading={token:String(++this.taskReturnSequence),manifest:structuredClone(task.manifest),draft:structuredClone(draft)};this.taskDraftReadings.set(task.run.run_id,reading);}
    const comparison=compareMaterialDraftInputs(input,draft.input,this.comparisonMetadata(this.workspace,input,true),this.comparisonMetadata(this.workspace,draft.input,true));
    return '<details data-m4-detail="task-draft" data-task-draft-identity="'+reading.token+'"><summary>核对本次提交内容与当前'+esc(label)+'草稿</summary><section data-material-task-draft aria-label="本次提交内容与当前草稿"><p>左侧为本次任务提交时的固定内容；右侧为本页当前准备的'+esc(label)+'草稿，返回后可继续编辑，用于下一轮。</p><p data-task-draft-state>本次提交时草稿 V'+task.manifest.draft_version+'；当前草稿基于已保存 V'+draft.version+'。'+(draft.dirty?'本页有未保存修改。':'本页无未保存修改。')+(draft.conflict?'已保存版本已有变化，需核对版本冲突。':'')+'</p><p class="m4-muted">以下为输入记录的差异；提交时自动补全的信息也可能产生差异，不能据此判断内容正确与否。</p><section data-task-draft-changed aria-label="不同内容"><h3>不同内容（'+comparison.changed.length+'项）</h3>'+(comparison.changed.length?this.comparisonRows(comparison.changed,true):'<p>两份材料与要求相同。</p>')+'</section><details data-m4-detail="task-draft-same"><summary>相同内容（'+comparison.unchanged.length+'项）</summary>'+this.comparisonRows(comparison.unchanged,true)+'</details></section></details>';
  }
  private taskDetailsHtml(task:M4Task){
    const input=task.manifest.kind==='document'?task.manifest.input:null;
    const metadata=input&&this.workspace?this.comparisonMetadata(this.workspace,input,true):undefined;
    const rows=input?compareMaterialDraftInputs(input,input,metadata,metadata).unchanged:[];
    const fixed=(key:string)=>rows.find(row=>row.key===key)?.local.map(block=>'<p'+(block.unverified?' class="m4-muted" data-task-input-unverified':'')+'>'+esc(block.text).replaceAll('\n','<br>')+'</p>').join('')??'暂不可核实';
    return `<section class="panel m4-delivery-details"><details data-m4-detail="input" class="m4-fixed-input"><summary>查看本次材料与要求</summary>${input?`<dl><dt>材料类型</dt><dd>${M4_DOCUMENT_LABELS[input.document_type]}</dd><dt>发行人</dt><dd>${esc(input.fields.issuer_name??'未指定')}</dd><dt>来源募集书</dt><dd>${fixed('source_material')}</dd><dt>修改基于</dt><dd>${fixed('edit_base')}</dd></dl>${input.materials.length?`<h3>补充材料</h3>${fixed('materials')}`:''}<h3>补充要求</h3><ul>${[...input.requirements.map(r=>r.text),...(input.supplemental_requirements?[input.supplemental_requirements]:[])].map(r=>`<li>${esc(r)}</li>`).join('')||'<li>无特别要求</li>'}</ul>`:''}</details>${this.taskDraftHtml(task)}</section>`;
  }
  private makingHtml(task:M4Task){
    const {run}=task,active=isActiveRun(run),input=task.manifest.kind==='document'?task.manifest.input:null;
    const latest=task.events.at(-1);
    const problem=latest?.state===run.state&&['paused','awaiting_input','failed','rejected'].includes(run.state)&&latest.payload.error_code?friendlyError(new ApiError(0,latest.payload.error_code)):'';
    const observed=materialLiveStatus(task),p=task.credit_charge?.progress;
    const canPause=active&&['queued','running'].includes(run.state)&&!p?.pause_requested&&!p?.credit_exhausted;
    const canResume=active&&!p?.credit_exhausted&&(p?.pause_requested||run.state==='paused'&&['user_paused','credits_exhausted'].includes(run.stage??''));
    return `<section class="panel m4-delivery" data-run-id="${esc(run.run_id)}"><header class="m4-delivery-head"><div><h2>${input?M4_DOCUMENT_LABELS[input.document_type]:'文件生成'}</h2><p class="m4-muted">${esc(input?.fields.issuer_name??'')} · ${materialPriorTime(task.created_at)!==null?esc(date(task.created_at))+' 提交':'提交时间暂不可核实'}</p></div></header>${taskProgress(run,'material',observed)}${materialCreditReceipt(task)}${problem?`<p class="m4-warning" role="alert">${esc(problem)}</p>`:''}<div class="m4-delivery-actions">${canPause?`<button class="btn secondary" data-m4-action="pause" data-run="${esc(run.run_id)}">暂停生成</button>`:''}${canResume?`<button class="btn primary" data-m4-action="resume" data-run="${esc(run.run_id)}">继续生成</button>`:''}${p?.credit_exhausted?`<a class="btn primary" href="${esc(rechargeHref(this.workspace!.topic.project_id))}">查看积分与支付状态</a>`:''}${this.taskReturnHtml(task)}${active?`<button class="text-btn" data-m4-action="cancel" data-run="${esc(run.run_id)}">结束本次生成</button>`:''}</div>${this.priorResultHtml(task)}<p class="m4-muted">本次任务使用提交时的固定内容；返回后可继续编辑当前同文种草稿，后续修改用于下一轮。</p>${materialActivityLog(task)}</section>${this.taskDetailsHtml(task)}`;
  }
  private priorResultHtml(task:M4Task){
    if(task.manifest.kind!=='document'||!this.workspace)return '';
    const result=materialPriorResult(task,this.workspace),a=result.artifact,pin=result.pin,label=result.mode==='base'?'本次修改基于':'此前同类成果';
    const identity=JSON.stringify([task.run.run_id,result.mode,pin?materialPriorPinKey(pin):null]);
    const reference=pin?'<details data-m4-detail="'+esc('prior:'+identity)+'"><summary>查看准确引用</summary><p>项目 '+esc(pin.source_project_id)+'<br>成果 '+esc(pin.artifact_id)+' · V'+pin.artifact_version+'<br>SHA-256 '+esc(pin.sha256)+'</p></details>':'';
    return '<section data-material-prior-result data-prior-mode="'+result.mode+'" data-prior-identity="'+esc(identity)+'" tabindex="-1" aria-label="与本任务关联的已有成果"><h3>'+label+'</h3>'+(a?'<p class="m4-prior-name">'+esc(a.filename)+'</p><p>'+esc(M4_DOCUMENT_LABELS[task.manifest.input.document_type])+' · '+(a.revision_number?'第 '+a.revision_number+' 稿':'保存版本 V'+a.artifact_version)+' · '+(materialPriorTime(a.created_at)!==null?'登记于 '+esc(date(a.created_at)):'登记时间暂不可核实')+'</p><p class="m4-muted">'+(result.mode==='base'?'这是本任务提交时固定的修改底稿；较新的稿件不会替换此引用。':'按本任务提交前的记录定位同类成果；它不是本任务的生成结果或修改底稿。')+'</p>':'<p class="m4-warning">'+esc(result.reason??'此前成果暂不可定位。')+'</p>')+reference+(a&&pin?'<button type="button" class="text-btn" data-m4-action="prior-artifact" data-run="'+esc(task.run.run_id)+'" data-prior-pin="'+esc(materialPriorPinKey(pin))+'">'+(result.mode==='base'?'查看本次修改底稿':'查看此前同类成果')+'</button>':'')+'</section>';
  }
  private openPriorResult(runId:string,key:string){
    const task=this.workspace?.tasks.find(t=>t.run.run_id===runId);
    if(!task||!this.workspace){this.message('原任务暂不可读取，请重新核对任务记录。',true);return;}
    const result=materialPriorResult(task,this.workspace);
    if(!result.artifact||!result.pin||materialPriorPinKey(result.pin)!==key){this.message('此前成果记录已有变化，未打开其他稿件。请刷新状态后核对本任务的文件与版本。',true);return;}
    this.openArtifact(result.artifact);
  }
  private artifactHtml(a:M4Artifact){
    const key=artKey(a),text=this.previews.get(key),error=this.previewErrors.get(key),task=this.workspace?.tasks.find(t=>t.run.run_id===a.run_id);
    // Pair only artifacts from this exact run; an older preparation note is never substituted.
    const files=(this.workspace?.artifacts??[a]).filter(file=>file.run_id===a.run_id&&file.kind!=='qa_text').sort((x,y)=>Number(y.kind==='document')-Number(x.kind==='document'));
    const document=files.find(file=>file.kind==='document'),title=a.document_type?M4_DOCUMENT_LABELS[a.document_type]:a.filename;
    return `<section class="panel m4-delivery"><header class="m4-delivery-head"><div><h2>${esc(title)}</h2><p class="m4-muted">${a.revision_number?`第 ${a.revision_number} 稿 · `:''}${materialPriorTime(a.created_at)!==null?esc(date(a.created_at)):'登记时间暂不可核实'}</p></div>${document?`<button class="btn secondary" data-m4-action="continue" data-artifact="${esc(artKey(document))}">继续修改</button>`:''}</header>${task?taskProgress(task.run,'material'):'<p class="m4-delivery-success" role="status">材料已生成，可以下载。</p>'}<h3>成果与下载</h3><p class="m4-muted">下载已有文件不会发起新任务或重复扣费。</p><div class="artifact-files">${files.map(file=>{const state=this.downloadStates.get(artKey(file));return `<article class="artifact-file"><div class="m4-file-kind">${prototypeIcon('file')}<h3>${file.kind==='document'?'正文 Word':'编制说明'}</h3></div><p>${file.kind==='document'?'可编辑的材料正文，供审阅和后续修改。':'查看编制依据、材料缺口和需人工确认的事项。'}</p><p class="m4-muted">${esc(file.filename)}</p><button class="btn ${file.kind==='document'?'primary':'secondary'}" data-m4-action="download" data-artifact="${esc(artKey(file))}" ${state?.pending?'disabled':''}>${state?.pending?'正在下载…':file.kind==='document'?'下载正文 Word':'下载编制说明'}</button><p class="artifact-download-status ${state?.error?'m4-warning':''}" role="${state?.error?'alert':'status'}">${esc(state?.text??'')}</p></article>`;}).join('')}</div>${document&&!files.some(file=>file.kind==='preparation_note')?'<p class="m4-muted">本轮暂无可下载的编制说明。</p>':''}</section><section class="panel m4-delivery-details"><details data-m4-detail="preview"><summary>${a.kind==='preparation_note'?'查看编制说明预览':'查看正文预览'}</summary><div class="m4-preview" aria-label="${esc(a.filename)}正文">${error?`<p role="alert">${esc(error)}</p><button class="text-btn" data-m4-action="retry-preview" data-artifact="${esc(key)}">重试预览</button>`:text===undefined?'<p role="status">正在读取成果正文…</p>':text.split(/\n\s*\n/).map((p,index)=>`<p data-m4-anchor="p${index+1}">${esc(p)}</p>`).join('')}</div></details></section>${task?`<section class="panel">${materialCreditReceipt(task)}${materialActivityLog(task)}</section>${this.taskDetailsHtml(task)}`:''}`;
  }
  private async loadPreview(a:M4Artifact){const key=artKey(a);this.previewPending.add(key);try{const p=await this.m4.preview(a);if(!this.live())return;this.previews.set(key,p.content);this.previewErrors.delete(key);}catch(error){if(this.live())this.previewErrors.set(key,`正文预览暂不可用。${friendlyError(error,'read')} 可下载原成果查看。`);}finally{this.previewPending.delete(key);if(this.live()&&this.reading.tabs.find(t=>t.key===this.reading.selected)?.kind==='artifact')this.paintContent();}}
  private contextLabel(c:M4MessageContext){const draft=c.document_type?M4_DOCUMENT_LABELS[c.document_type]:null;return [draft,c.draft_version?`输入 V${c.draft_version}`:null,c.reading_artifact?`阅读 ${this.artifactRefTitle(c.reading_artifact)}`:null,...c.citations.map(r=>r.kind==='material'?`${this.materialName(r.ref)} · V${r.ref.material_version}`:this.artifactRefTitle(r.ref))].filter(Boolean).join(' · ')||'当前工作区讨论';}
  private paintAgent(){
    const contextHost=this.page?.querySelector('#m4-context'),messages=this.page?.querySelector<HTMLElement>('#m4-messages'),composer=this.page?.querySelector('#m4-composer');if(!contextHost||!messages||!composer)return;
    contextHost.innerHTML=`<p>${esc(this.workspace?.topic.name??'可直接提问，也可以先添加材料')}</p><p>${esc(this.contextLabel(this.view.unsent_context))}</p>${this.workspace?.materials.length?`<details><summary>已添加 ${this.workspace.materials.length} 份材料</summary><ul class="m4-file-list">${this.workspace.materials.map(p=>this.materialHtml(p,true)).join('')}</ul></details>`:''}${this.view.quotation?`<blockquote class="m4-quote">${esc(this.view.quotation.original_text)}<small> ${esc(this.view.quotation.anchor??'原文引用')}</small></blockquote><button class="text-btn" data-m4-action="clear-quote">移除引用</button>`:''}${this.view.unsent_context.document_type&&this.drafts.get(this.view.unsent_context.document_type)?.version!==this.view.unsent_context.draft_version?'<p class="m4-warning">左侧任务输入已有新版本，原讨论与引用保留。<button class="text-btn" data-m4-action="discuss">采用当前任务上下文</button></p>':''}${this.viewConflict?'<p class="m4-warning">其他页面已有新讨论草稿。<button class="text-btn" data-m4-action="resolve-view">核对草稿</button></p>':''}`;
    const previousTop=messages.scrollTop,atBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<32;const focused=this.page?.querySelector<HTMLTextAreaElement>('#m4-message')===document.activeElement;const oldInput=this.page?.querySelector<HTMLTextAreaElement>('#m4-message');const selection=focused&&oldInput?[oldInput.selectionStart,oldInput.selectionEnd]:null;
    const timeline=[...(this.workspace?.messages??[]).map(m=>({at:m.created_at,html:`<article class="m4-message ${m.role}" data-message-id="${esc(m.message_id)}"><header>${m.role==='user'?'你':'BondBuddy'}</header><p>${esc(m.content)}</p><footer>${esc(this.contextLabel(m.context))}</footer>${['queued','running'].includes(m.reply_status)?'<p class="m4-muted" role="status">正在回答…</p>':''}${['failed','unknown'].includes(m.reply_status)?`<p class="m4-warning">回复未完成，原消息已保存。${esc(m.error??'请刷新状态核对。')}</p>`:''}${m.reply?.intent==='execute'&&m.reply.document_type?`<button class="btn secondary" data-m4-action="agent-document" data-type="${m.reply.document_type}">核对${M4_DOCUMENT_LABELS[m.reply.document_type]}并制作</button>`:''}${m.reply?.intent==='cross_business'&&m.reply.target_business?`<p><a class="text-btn" href="${m.reply.target_business==='update'?'#update':m.reply.target_business==='review'?'#review':'#generate'}?handoff_topic=${encodeURIComponent(this.topicId!)}&amp;handoff_message=${encodeURIComponent(m.reply_to??m.message_id)}">前往${m.reply.target_business==='update'?'募集书更新':m.reply.target_business==='review'?'复核募集书':'文件生成'}核对并执行</a></p><p class="m4-muted">当前讨论已保留，请在目标业务核对材料与执行范围。</p>`:''}${m.role==='assistant'?`<button class="text-btn" data-m4-action="export-message" data-message-id="${esc(m.message_id)}">免费导出这段文本</button>`:''}</article>`})),...(this.workspace?.tasks??[]).map(t=>({at:t.created_at,html:this.taskHtml(t)}))].sort((a,b)=>a.at.localeCompare(b.at));
    const html=timeline.map(x=>x.html).join('')||'<div class="m4-empty"><p class="m4-muted">有什么项目问题想了解？可以解读材料、分析财务，或继续追问。</p><div class="m4-example-chips"><button data-m4-action="example" data-example="请说明普通私募立项需要准备哪些资料">准备清单</button><button data-m4-action="example" data-example="请根据已提供材料分析发行人的偿债能力">分析偿债能力</button></div></div>';
    if(messages.innerHTML!==html)messages.innerHTML=html;messages.scrollTop=atBottom?messages.scrollHeight:previousTop;
    const signature=this.qaSignature(),docDraft=this.selected?this.drafts.get(this.selected):undefined,quote=this.isExecutionCommand(this.view.unsent_content)&&this.docQuote?.type===this.selected&&this.docQuote.version===docDraft?.version?this.docQuote.response:this.qaQuote?.signature===signature?this.qaQuote.response:undefined;
    if(composer.contains(document.activeElement)&&document.activeElement instanceof HTMLInputElement&&document.activeElement.type==='file')return;
    composer.innerHTML=`<label for="m4-message">你的问题</label><textarea id="m4-message" rows="3" maxlength="12000" placeholder="输入问题，可添加相关材料后继续追问…" >${esc(this.view.unsent_content)}</textarea>${quote?this.quoteHtml(quote):''}<div class="m4-compose-actions"><span class="m4-muted">${this.pendingMessage?'原发送请求待确认，重试沿用同一请求。':'讨论要求进入草稿，制作需明确执行。'}</span><button class="btn primary small" data-m4-action="send" ${this.sending||!this.view.unsent_content.trim()&&!this.pendingMessage?'disabled':''}>${this.sending?'正在提交…':this.pendingMessage?'重试原请求':quote?'确认并发送':'发送'}</button><label class="bb-upload-picker bb-upload-picker--compact btn secondary small m4-file-picker">${prototypeIcon('upload')} 添加附件<input type="file" data-m4-agent-upload accept=".docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg" multiple aria-label="向助手添加附件" /></label></div>${this.uploadsHtml()}${this.pendingExecution?'<button class="text-btn" data-m4-action="retry-execution">核对并重试原制作请求</button>':''}${this.statusError?'<button class="text-btn" data-m4-action="save">重试保存草稿</button>':''}`;
    if(selection){const input=this.page!.querySelector<HTMLTextAreaElement>('#m4-message')!;input.focus({preventScroll:true});input.setSelectionRange(selection[0],selection[1]);}
  }
  private taskHtml(t:M4Task){const title=t.manifest.kind==='document'?M4_DOCUMENT_LABELS[t.manifest.input.document_type]:'问答与讨论';return `<article class="m4-task" data-run-id="${esc(t.run.run_id)}"><h3>${title} · ${runStateLabel[t.run.state]}</h3><p>${esc(isActiveRun(t.run)?m4ProgressLabel(t.run.stage,t.events.at(-1)?.payload.reason):runStateLabel[t.run.state])}</p><details><summary>查看实际执行过程</summary><ol>${t.events.map(e=>`<li>${esc(m4ProgressLabel(e.stage,e.payload.reason))} · ${runStateLabel[e.state]}${e.payload.error_code?` · ${esc(e.payload.error_code)}`:''}</li>`).join('')||'<li>暂无已保存事件，等待状态同步。</li>'}</ol></details><div class="m4-task-buttons">${t.manifest.kind==='document'?`<button class="text-btn" data-m4-action="task" data-run="${esc(t.run.run_id)}">${isActiveRun(t.run)?'查看正在制作':'查看固定输入'}</button>`:''}${t.artifacts.filter(a=>a.kind!=='qa_text').map(a=>`<button class="text-btn" data-m4-action="artifact" data-artifact="${esc(artKey(a))}">打开${a.kind==='document'?'成果':a.kind==='preparation_note'?'制作说明':'文本'}</button>`).join('')}${isActiveRun(t.run)?`<button class="text-btn" data-m4-action="cancel" data-run="${esc(t.run.run_id)}">停止本次任务</button>`:''}</div></article>`;}
  private bind(){this.page!.addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLElement>('[data-m4-action]');if(!b)return;const action=b.dataset.m4Action;const artifact=this.workspace?.artifacts.find(a=>artKey(a)===b.dataset.artifact);switch(action){case 'fix-input':this.focusInput(b.dataset.field!);break;case 'delete-material':{const p=this.workspace?.materials.find(p=>pinKey(p)===b.dataset.pin)??[...this.uploads.values()].flatMap(u=>u.material&&this.workspace?[materialPin(this.workspace.topic.project_id,u.material)]:[]).find(p=>pinKey(p)===b.dataset.pin);if(p)void this.deleteMaterial(p);}break;case 'refresh':void this.refresh();break;case 'select-type':void this.chooseType(b.dataset.type as M4DocumentType);break;case 'tab':this.rememberScroll();this.reading=selectWorkspaceTab(this.reading,b.dataset.key!);this.changed();this.paint();break;case 'prepare':this.returnToTaskDraft(b.dataset.run??'',b.dataset.taskReturn??'');break;case 'discuss':this.discuss();break;case 'execute':void this.execute('workspace');break;case 'agent-document':location.hash='generate?'+withProjectContext(new URLSearchParams({topic:this.topicId!}));break;case 'retry-execution':void this.execute('workspace',true);break;case 'send':void this.send();break;case 'save':void this.flush();break;case 'prior-artifact':this.openPriorResult(b.dataset.run??'',b.dataset.priorPin??'');break;case 'artifact':if(artifact)this.openArtifact(artifact);break;case 'download':if(artifact)void this.download(artifact);break;case 'retry-preview':if(artifact){this.previewErrors.delete(artKey(artifact));void this.loadPreview(artifact);}break;case 'quote-selection':if(artifact)this.quoteSelection(artifact);break;case 'continue':if(artifact)this.continueDraft(artifact);break;case 'task':{const t=this.workspace?.tasks.find(t=>t.run.run_id===b.dataset.run);if(t){this.rememberScroll();this.reading=openWorkspaceTab(this.reading,{key:`run:${t.run.run_id}`,kind:'making',runId:t.run.run_id,title:isActiveRun(t.run)?'正在制作':'固定输入'});this.changed();this.paint();}}break;case 'cancel':if(b.dataset.run)void this.cancel(b.dataset.run);break;case 'pause':case 'resume':void this.controlRun(b.dataset.run!,b.dataset.m4Action as 'pause'|'resume');break;case 'clear-quote':{const old=this.view.quotation;this.view.quotation=null;if(old)this.view.unsent_context.citations=this.view.unsent_context.citations.filter(c=>JSON.stringify(c)!==JSON.stringify(old.citation));this.changed();this.paintAgent();}break;case 'cite-material':{const p=this.workspace?.materials.find(p=>pinKey(p)===b.dataset.pin);if(p){if(!this.view.unsent_context.citations.some(c=>c.kind==='material'&&pinKey(c.ref)===pinKey(p)))this.view.unsent_context.citations.push({kind:'material',ref:structuredClone(p),locator:null});this.changed();this.paintAgent();this.focusComposer();}}break;case 'download-material':{const p=this.workspace?.materials.find(p=>pinKey(p)===b.dataset.pin);if(p)void this.downloadMaterial(p);}break;case 'project-picker':void this.openProjectPicker(b.dataset.pickerPurpose==='material'?'material':'source',b);break;case 'retry-upload':{const u=this.uploads.get(b.dataset.uploadId!);if(u)void this.processUpload(b.dataset.uploadId!,u);}break;case 'example':this.view.unsent_content=this.view.unsent_content?`${this.view.unsent_content}\n${b.dataset.example}`:b.dataset.example!;this.changed();this.paintAgent();this.focusComposer();break;case 'export-message':{const m=this.workspace?.messages.find(m=>m.message_id===b.dataset.messageId&&m.role==='assistant');if(m)this.downloads.save(new Blob([m.content],{type:'text/plain;charset=utf-8'}),'助手文本.txt');}break;case 'resolve-draft':void this.resolveDraft();break;case 'resolve-view':void this.resolveView();break;}});
    this.page!.addEventListener('input',e=>{const target=e.target;if(target instanceof HTMLTextAreaElement&&target.id==='m4-requirements'&&this.selected){this.drafts.get(this.selected)!.input.supplemental_requirements=target.value;this.changed(this.selected);return;}if(target instanceof HTMLTextAreaElement&&target.id==='m4-message'){this.view.unsent_content=target.value;this.changed();this.qaQuote=undefined;const b=this.page?.querySelector<HTMLButtonElement>('[data-m4-action="send"]');if(b)b.disabled=!target.value.trim()||this.sending||this.uploadInputBlocked(false);return;}if(target instanceof HTMLInputElement&&target.dataset.m4Field&&this.selected){this.drafts.get(this.selected)!.input.fields[target.dataset.m4Field]=target.value;this.changed(this.selected);}});
    this.page!.addEventListener('change',e=>{const target=e.target;if(target instanceof HTMLInputElement&&target.hasAttribute('data-m4-type')){void this.chooseType(target.value as M4DocumentType);return;}if(target instanceof HTMLInputElement&&target.hasAttribute('data-m4-source-mode')&&this.selected){this.drafts.get(this.selected)!.input.fields.source_mode=target.value;this.changed(this.selected);this.paintContent();return;}if(target instanceof HTMLSelectElement&&target.id==='m4-document-type'){this.selectType(target.value as M4DocumentType||null);return;}if(target instanceof HTMLSelectElement&&target.dataset.m4Field&&this.selected){const fields=this.drafts.get(this.selected)!.input.fields;fields[target.dataset.m4Field]=target.value;if(['market','offering'].includes(target.dataset.m4Field))delete fields.case_template_id;this.changed(this.selected);this.paintContent();return;}if(target instanceof HTMLSelectElement&&target.id==='m4-template'&&this.selected){const t=(this.workspace?.templates??[]).find(t=>`${t.template_id}:${t.template_version}`===target.value);this.drafts.get(this.selected)!.input.template=t?{template_id:t.template_id,template_version:t.template_version,sha256:t.sha256}:null;this.changed(this.selected);return;}if(target instanceof HTMLInputElement&&target.dataset.m4Material&&this.selected){const input=this.drafts.get(this.selected)!.input,p=(this.workspace?.materials??[]).find(p=>pinKey(p)===target.dataset.m4Material);if(p){input.materials=target.checked?[...input.materials.filter(m=>pinKey(m)!==pinKey(p)),p]:input.materials.filter(m=>pinKey(m)!==pinKey(p));this.changed(this.selected);}return;}if(target instanceof HTMLInputElement&&target.hasAttribute('data-m4-agent-upload')){const files=[...(target.files??[])];target.value='';target.blur();void this.ensureWorkspace(this.selected?M4_DOCUMENT_LABELS[this.selected]:'文件生成').then(ok=>{if(ok)void this.upload(files,'attachment',null);});return;}if(target instanceof HTMLInputElement&&target.dataset.m4Upload&&this.selected){const files=[...(target.files??[])];target.value='';target.blur();void this.upload(files,target.dataset.m4Upload as Upload['purpose'],this.selected);}});
    this.page!.addEventListener('dragover',e=>{if((e.target as HTMLElement).closest('[data-m4-drop]'))e.preventDefault();});
    this.page!.addEventListener('drop',e=>{const zone=(e.target as HTMLElement).closest<HTMLElement>('[data-m4-drop]');if(zone&&this.selected){e.preventDefault();const files=[...(e.dataTransfer?.files??[])];void this.upload(zone.dataset.m4Drop==='material'?files:files.slice(0,1),zone.dataset.m4Drop as Upload['purpose'],this.selected);}});
    this.page!.addEventListener('focusout',e=>{if(e.target instanceof HTMLInputElement&&e.target.dataset.m4Field==='broker')this.paintContent();});
    this.page!.addEventListener('keydown',e=>{if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&(e.target as HTMLElement).matches('[role=tab]')){e.preventDefault();const index=this.reading.tabs.findIndex(t=>t.key===this.reading.selected),next=(index+(e.key==='ArrowRight'?1:-1)+this.reading.tabs.length)%this.reading.tabs.length;this.rememberScroll();this.reading=selectWorkspaceTab(this.reading,this.reading.tabs[next].key);this.changed();this.paint();this.page?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();}});
  }
  private selectType(type:M4DocumentType|null){if(type&&!M4_DOCUMENT_TYPES.includes(type))return;this.selected=type;this.inputIssues=[];this.inputValidationAttempted=false;const draft=type?this.drafts.get(type):undefined;this.view.unsent_context={...this.view.unsent_context,document_type:type,draft_version:draft?.version??0,source_material:structuredClone(draft?.input.source_material??null)};this.reading=prepareInput(this.reading,type);this.docQuote=undefined;const pending=Boolean(type&&this.workspace?.pending_requirements?.length&&!this.uploadInputBlocked(false));this.changed(pending?type!:undefined);this.paint();}
  private discuss(){if(!this.workspace)return;const d=this.selected?this.drafts.get(this.selected):undefined;this.view.unsent_context={...this.view.unsent_context,document_type:this.selected,draft_version:d?.version??0,source_material:structuredClone(d?.input.source_material??null)};this.changed();this.paintAgent();this.focusComposer();}
  private focusComposer(){this.page?.querySelector<HTMLTextAreaElement>('#m4-message')?.focus({preventScroll:false});}
  private openArtifact(a:M4Artifact){if(a.kind==='qa_text')return;this.rememberScroll();this.reading=openWorkspaceTab(this.reading,{key:`artifact:${artKey(a)}`,kind:'artifact',artifactId:a.artifact_id,version:a.artifact_version,title:artifactTitle(a)});this.changed();this.paint();}
  private quoteSelection(a:M4Artifact){const s=getSelection(),preview=this.page?.querySelector('.m4-preview');if(!s||s.isCollapsed||!preview?.contains(s.anchorNode)||!preview.contains(s.focusNode)){this.message('请先在成果正文选中要讨论的文字。',true);return;}const original=s.toString().trim().slice(0,12000);if(!original)return;const anchor=(s.anchorNode?.parentElement?.closest<HTMLElement>('[data-m4-anchor]'))?.dataset.m4Anchor??null;const citation={kind:'artifact' as const,ref:artifactPin(a),locator:anchor};this.view.quotation={citation,original_text:original,anchor};this.view.unsent_context.reading_artifact=artifactPin(a);this.view.unsent_context.citations=[...this.view.unsent_context.citations.filter(c=>c.kind!=='artifact'||artKey(c.ref)!==artKey(a)),citation];this.changed();this.paintAgent();this.focusComposer();this.message('原文与准确成果版本已引用。当前可讨论段落；定点执行修订将在 M5 提供。');}
  private continueDraft(a:M4Artifact){if(this.uploadActionBlocked())return;if(!a.document_type||a.kind!=='document')return;const d=this.drafts.get(a.document_type)!;if(d.dirty&&d.input.edit_base&&artKey(d.input.edit_base)!==artKey(a)){this.message('已有另一版本的未保存改稿草稿，请先核对保存再切换基线。',true);return;}d.input.edit_base=artifactPin(a);d.input.scope='whole';this.selected=a.document_type;this.reading=prepareInput(this.reading,a.document_type);this.changed(a.document_type);this.paint();this.message(`已选择 ${artifactTitle(a)} 作为全文改稿基线。将制作新文件，原成果和现有要求保留。`);}
  private qaSignature(){return JSON.stringify([this.view.unsent_content.trim(),this.view.unsent_context,this.view.quotation]);}
  private isExecutionCommand(content:string){return /^(开始制作|开始执行|按当前任务制作|按当前任务执行)[。！!\s]*$/.test(content.trim());}
  private async send(){
    if(this.uploadActionBlocked())return;
    if(this.sending)return;
    const content=this.view.unsent_content.trim();if(!content&&!this.pendingMessage)return;
    this.sending=true;this.paintAgent();
    try{
      if(!await this.ensureWorkspace(content.slice(0,60))||this.uploadActionBlocked())return;
      if(!this.pendingMessage){
        if(!await this.flush()||!this.live()||this.uploadInputBlocked())return;
        let quoteId:string,execute=false;
        const shownQuote=this.selected&&this.docQuote?.type===this.selected&&this.docQuote.version===this.drafts.get(this.selected)?.version&&Date.parse(this.docQuote.response.quote.expires_at)>Date.now()?this.docQuote:null;
        if(this.isExecutionCommand(content)||shownQuote){
          const type=this.selected;if(!type){this.message('请先选择材料类型并核对工作区完整任务，再明确制作。原消息保留。',true);return;}
          const draft=this.drafts.get(type)!;
          this.view.unsent_context={...this.view.unsent_context,document_type:type,draft_version:draft.version,source_material:structuredClone(draft.input.source_material)};
          if(!this.docQuote||this.docQuote.type!==type||this.docQuote.version!==draft.version||Date.parse(this.docQuote.response.quote.expires_at)<=Date.now()){
            this.docQuote={response:await this.m4.quote(this.topicId!,{kind:'document',document_type:type,expected_draft_version:draft.version}),version:draft.version,type};
            if(!this.live()||this.uploadInputBlocked(false))return;if(!isAutomaticCharge(this.docQuote.response.quote)){this.message('本轮材料制作报价已显示。确认当前输入后，在助手发送相同开始命令即可执行。');return;}
          }
          if(int64(this.docQuote.response.shortage)>0n&&!isAutomaticCharge(this.docQuote.response.quote)){this.message('积分不足，制作任务尚未开始。原命令保留。',true);return;}
          quoteId=this.docQuote.response.quote.quote_id;execute=true;
        }else{
          const signature=this.qaSignature();
          if(!this.qaQuote||this.qaQuote.signature!==signature||Date.parse(this.qaQuote.response.quote.expires_at)<=Date.now()){
            this.qaQuote={response:await this.m4.quote(this.topicId!,{kind:'qa',content,context:this.view.unsent_context}),signature};
            if(!this.live()||this.uploadInputBlocked(false))return;if(int64(this.qaQuote.response.shortage)>0n&&!isAutomaticCharge(this.qaQuote.response.quote)){this.message('积分不足，原问题与引用已保留。',true);return;}
            if(int64(this.qaQuote.response.quote.points)>0n&&!isAutomaticCharge(this.qaQuote.response.quote)){this.message('本次问答报价已显示，请确认并发送。');return;}
          }
          if(int64(this.qaQuote.response.shortage)>0n&&!isAutomaticCharge(this.qaQuote.response.quote))return;quoteId=this.qaQuote.response.quote.quote_id;
        }
        const request:M4MessageRequest={submission_request_id:crypto.randomUUID(),content,context:structuredClone(this.view.unsent_context),quote_id:quoteId,...(execute?{execute:true}:{})};
        this.pendingMessage={request,viewContent:this.view.unsent_content};this.cache();
      }
      await this.cacheQueue;if(!this.live()||this.cacheFailure||this.uploadInputBlocked())return;const pending=this.pendingMessage;if(!pending)return;const result=await this.m4.message(this.topicId!,pending.request);if(!this.live()||this.uploadInputBlocked(false))return;
      if(result.message.content!==pending.request.content||result.message.role!=='user')throw new ApiError(0,'DATA_UNAVAILABLE');
      this.pendingMessage=undefined;
      if(this.view.unsent_content===pending.viewContent&&JSON.stringify(this.view.unsent_context)===JSON.stringify(pending.request.context)){this.view.unsent_content='';this.view.quotation=null;this.changed();}
      this.qaQuote=undefined;this.cache();this.message(pending.request.execute?'助手正在核对本条意图与当前报价；只有明确制作且输入未变化才会启动材料任务。':'问题已提交，助手执行过程将显示在此处。');await this.refresh();
    }catch(error){
      if(this.live()){
        if(error instanceof ApiError&&[402,409,422].includes(error.status)&&['QUOTE_CHANGED','INPUT_REQUIRED','INPUT_REVISION_CONFLICT','CREDITS_INSUFFICIENT'].includes(error.code)){this.pendingMessage=undefined;this.docQuote=undefined;this.qaQuote=undefined;this.cache();}
        this.message(`${friendlyError(error,'submit')} ${this.pendingMessage?'原请求已保留，重试沿用同一请求，不重复计费。':'原问题与引用已保留。'}`,true);
      }
    }finally{this.sending=false;if(this.live())this.paint();}
  }
  private async execute(entrypoint:'workspace'|'assistant',retry=false){
    if(this.uploadActionBlocked())return;
    if(this.deletingMaterial){this.message('正在删除材料，请稍候。');return;}
    if(this.executing||!this.selected&&!retry)return;
    const type=this.selected;
    if(!retry){this.inputValidationAttempted=true;this.inputIssues=this.currentInputIssues();if(this.inputIssues.length){this.message('');this.paintContent();this.page?.querySelector<HTMLElement>('.m4-input-feedback')?.focus();return;}}
    this.executing=true;this.paintContent();
    try{
      if(!await this.ensureWorkspace(type?M4_DOCUMENT_LABELS[type]:'文件生成')||this.uploadActionBlocked())return;
      if(!retry){
        if(this.pendingExecution){this.message('原制作请求结果尚未确认，请先重试原请求核对任务状态。',true);return;}
        if(!await this.flush()||!type||!this.live()||this.uploadInputBlocked())return;
        const draft=this.drafts.get(type)!,version=draft.version;
        // Quote and execute are one user action. Keep the version and quote ID
        // pinned internally; never pause for a second price confirmation.
        const {quote,shortage}=await this.m4.quote(this.topicId!,{kind:'document',document_type:type,expected_draft_version:version});
        if(!this.live()||this.uploadInputBlocked(false))return;
        const current=this.drafts.get(type)!;
        if(this.selected!==type||current.version!==version||current.dirty){
          this.message('材料或要求已修改，请保存后重新点击生成。',true);return;
        }
        if(int64(shortage)>0n&&!isAutomaticCharge(quote)){this.message('积分不足，本次未开始生成、未扣费，草稿已保留。请到账号页查看积分与支付渠道状态；积分充足后请返回重新点击生成。',true,true);return;}
        this.pendingExecution={execution_request_id:crypto.randomUUID(),document_type:type,expected_draft_version:version,quote_id:quote.quote_id,entrypoint};
        this.cache();
      }
      await this.cacheQueue;if(!this.live()||this.cacheFailure||this.uploadInputBlocked())return;const request=this.pendingExecution;if(!request)return;
      const {run}=await this.m4.execute(this.topicId!,request);
      if(!this.live()||this.uploadInputBlocked(false))return;
      this.pendingExecution=undefined;this.docQuote=undefined;
      this.reading=taskSubmitted(this.reading,run.run_id,'正在制作');this.changed();this.startedRunId=run.run_id;
      this.message('制作任务已开始，本轮输入已固定。');await this.refresh();
    }catch(error){
      if(this.live()){
        if(error instanceof ApiError&&[409,422,402,503].includes(error.status)&&error.code!=='DATA_UNAVAILABLE'){
          this.pendingExecution=undefined;this.docQuote=undefined;
        }
        this.cache();
        if(error instanceof ApiError&&error.code==='INPUT_REQUIRED'){
          this.inputValidationAttempted=true;this.inputIssues=error.details.materialInputIssues?.length?error.details.materialInputIssues:this.currentInputIssues();
          this.message(this.inputIssues.length?'':'请返回材料与要求，补充交易所、生成依据及立项模板（仅立项报告需要），保存后重新点击生成。',!this.inputIssues.length);
        }else this.message(`${friendlyError(error,'submit')}${this.pendingExecution?' 原制作请求已保留，请核对并重试。':''}`,true,error instanceof ApiError&&error.code==='CREDITS_INSUFFICIENT');
      }
    }finally{this.executing=false;if(this.live()){
      this.paint();
      if((this.statusError||this.inputIssues.length)&&this.reading.selected==='input')this.page?.querySelector('#m4-submit-status')?.scrollIntoView({block:'nearest'});
    }}
  }
  private async refresh(){if(!this.workspace||!this.live())return;if(this.refreshing)return this.refreshing;const generation=this.draftGeneration;const p=(async()=>{try{const w=await this.m4.workspace(this.topicId!);if(!this.live()||this.deletingMaterial)return;this.rememberScroll();this.scanUploadRecovery();this.install(w,false,generation!==this.draftGeneration);await this.loadNames();if(!this.live())return;this.cache();if(this.uploadRecordsPresent)void this.readUploadRecovery();const selection=getSelection();if(selection&&!selection.isCollapsed&&this.page?.contains(selection.anchorNode)){this.paintAgent();this.paintTabs();}else this.paint();}catch(error){if(this.live())this.message(`状态暂未同步。${friendlyError(error,'read')} 原输入与阅读位置保留。`,true);}finally{this.schedulePoll();}})();this.refreshing=p;void p.finally(()=>{if(this.refreshing===p)this.refreshing=undefined;});return p;}
  private schedulePoll(){clearTimeout(this.pollTimer);if(!this.live()||!this.workspace)return;const active=isActiveRun(this.workspace.active_run)||this.workspace.messages.some(m=>['queued','running'].includes(m.reply_status));if(active)this.pollTimer=setTimeout(()=>void this.refresh(),2200);}
  private async controlRun(id:string,action:'pause'|'resume'){
    try{await this.api.runAction(id,action,this.controller.signal);await this.refresh();}
    catch(error){if(this.live())this.message(friendlyError(error),true,error instanceof ApiError&&error.code==='CREDITS_INSUFFICIENT');}
  }
  private async cancel(id:string){try{await this.api.runAction(id,'cancel',this.controller.signal);await this.refresh();}catch(error){if(this.live())this.message(friendlyError(error),true);}}
  private async download(a:M4Artifact){const key=artKey(a);if(this.downloadStates.get(key)?.pending)return;this.downloadStates.set(key,{pending:true,text:'正在读取文件…'});this.paintContent();try{const bytes=await this.api.m4ArtifactBytes(a,this.controller.signal);if(this.live()){this.downloads.save(bytes,a.filename);this.downloadStates.set(key,{pending:false,text:'文件已交给浏览器下载，可在下载列表中查看。'});}}catch(error){if(this.live())this.downloadStates.set(key,{pending:false,error:true,text:`下载未完成。${friendlyError(error,'download')} 请重试下载。`});}finally{if(this.live())this.paintContent();}}
  private deleteButton(pin:M4MaterialPin){
    if(pin.source_project_id!==this.workspace?.topic.project_id)return '';
    const busy=this.deletingMaterial||this.uploading||isActiveRun(this.workspace.active_run);
    return `<button type="button" class="text-btn" data-m4-action="delete-material" data-pin="${esc(pinKey(pin))}" aria-label="删除 ${esc(this.materialName(pin))}" ${busy?'disabled':''}>${this.deletingMaterial===pin.material_id?'正在删除…':'删除'}</button>${isActiveRun(this.workspace.active_run)?'<small>停止任务后可删除材料</small>':''}`;
  }
  private async deleteMaterial(pin:M4MaterialPin){
    if(this.uploadActionBlocked())return;
    if(!this.workspace||pin.source_project_id!==this.workspace.topic.project_id||this.deletingMaterial||this.uploading)return;
    if(isActiveRun(this.workspace.active_run)||this.executing||this.pendingExecution){this.message('请先停止或确认当前任务，停止完成后可删除材料。',true);return;}
    if(!window.confirm(`确定删除“${this.materialName(pin)}”？删除后可重新上传正确文件。已提交任务的输入与历史成果保持不变。`))return;
    this.deletingMaterial=pin.material_id;this.paintContent();
    try{
      if(this.saving)await this.saving;
      if(!this.live()||this.uploadInputBlocked(false))return;
      await this.api.deleteMaterial(pin.source_project_id,pin.material_id);
      if(!this.live()||this.uploadInputBlocked(false))return;
      const matches=(p:M4MaterialPin|null)=>p?.source_project_id===pin.source_project_id&&p.material_id===pin.material_id;
      const removedTemplates=this.workspace.templates.filter(t=>matches(t.material));
      this.workspace.materials=this.workspace.materials.filter(p=>!matches(p));
      this.workspace.material_details=this.workspace.material_details?.filter(p=>!matches(p));
      this.workspace.templates=this.workspace.templates.filter(t=>!matches(t.material));
      for(const [type,d] of this.drafts){
        const before=JSON.stringify(d.input);
        if(matches(d.input.source_material))d.input.source_material=null;
        d.input.materials=d.input.materials.filter(p=>!matches(p));
        if(removedTemplates.some(t=>t.template_id===d.input.template?.template_id&&t.template_version===d.input.template.template_version))d.input.template=null;
        if(before!==JSON.stringify(d.input))this.changed(type);
      }
      if(matches(this.view.unsent_context.source_material))this.view.unsent_context.source_material=null;
      this.view.unsent_context.citations=this.view.unsent_context.citations.filter(c=>c.kind!=='material'||!matches(c.ref));
      if(this.view.quotation?.citation.kind==='material'&&matches(this.view.quotation.citation.ref))this.view.quotation=null;
      for(const [id,u] of this.uploads)if(u.material?.material_id===pin.material_id)this.uploads.delete(id);
      for(const [id,n] of this.duplicateUploads)if(n.material.material_id===pin.material_id)this.duplicateUploads.delete(id);
      this.changed();this.paintContent();
      if(await this.flush())this.message('材料已删除，可以重新上传正确文件。');
      else this.message('材料已删除，草稿尚未保存。请处理保存提示后重试保存。',true);
    }catch(error){if(this.live())this.message(`删除结果暂未确认。${friendlyError(error,'action')} 请先重新读取材料列表，核对后再继续。`,true);}
    finally{this.deletingMaterial=undefined;if(this.live())this.paintContent();}
  }
  private async downloadMaterial(pin:M4MaterialPin){try{const m=await this.api.material(pin.source_project_id,pin.material_id,this.controller.signal,pin.material_version);if(m.material_version!==pin.material_version||m.sha256!==pin.sha256)throw new ApiError(409,'INPUT_REVISION_CONFLICT');const bytes=await this.api.materialBytes(pin.source_project_id,m,this.controller.signal);if(this.live())this.downloads.save(bytes,m.filename);}catch(error){if(this.live())this.message(`原材料未下载。${friendlyError(error,'download')}`,true);}}
  private ensureWorkspace(name:string):Promise<boolean>{
    if(this.workspace)return Promise.resolve(true);if(this.creation)return this.creation;
    const pending=this.createWorkspace(name);this.creation=pending;
    void pending.finally(()=>{if(this.creation===pending)this.creation=undefined;});return pending;
  }
  private async createWorkspace(name:string){
    const key=`bb-m4-create:${this.owner}:generate:${this.sourceProjectId??'standalone'}`;
    try{
      if(!this.pendingCreate){try{const saved=JSON.parse(localStorage.getItem(key)??'null');if(saved?.creation_request_id)this.pendingCreate=saved;}catch{}this.pendingCreate??={creation_request_id:crypto.randomUUID(),name,...(this.sourceProjectId?{source_project_id:this.sourceProjectId}:{})};localStorage.setItem(key,JSON.stringify(this.pendingCreate));}
      const {topic}=await this.m4.create(this.pendingCreate);if(!this.live())return false;
      const w=await this.m4.workspace(topic.topic_id);if(!this.live())return false;
      this.install(w);this.setupUploadRecovery();this.topics=[topic,...this.topics.filter(t=>t.topic_id!==topic.topic_id)];
      localStorage.removeItem(key);this.pendingCreate=undefined;
      const query=withProjectContext(new URLSearchParams({topic:topic.topic_id}));if(this.sourceProjectId)query.set('project',this.sourceProjectId);
      history.replaceState(null,'',`#generate?${query}`);this.changed();return true;
    }catch(error){this.message(`${friendlyError(error,'submit')} 创建请求已保留，重试沿用同一请求。`,true);return false;}
  }
  private async chooseType(type:M4DocumentType){if(!M4_DOCUMENT_TYPES.includes(type))return;this.selectType(type);}
  private async uploadTemplateRecoverable(files:File[],type:M4DocumentType|null){
    if(type!=='init'){this.message('请在立项报告的原模板区上传 DOCX 模板。',true);return;}
    const file=files[0];if(!file||this.deletingMaterial||this.executing||this.sending||this.uploadActionBlocked())return;
    if(!await this.ensureWorkspace(M4_DOCUMENT_LABELS.init)||!this.live()||this.uploadActionBlocked())return;
    if(this.pendingMessage||this.pendingExecution){this.message('原发送或制作请求尚未确认，请先核对原请求再上传模板。',true);return;}
    if(!await this.flush()||!this.live()||this.uploadActionBlocked())return;
    await this.cacheQueue;if(!this.live()||this.cacheFailure||!this.m4TemplateUploads||this.uploadActionBlocked())return;
    const base=structuredClone(this.drafts.get('init')!),fields=base.input.fields,broker=fields.broker??'';
    if(!broker.trim()||!['sse','szse'].includes(fields.market)){this.message('请先填写立项券商全称并选择交易所，再上传对应的私有模板。',true);this.focusInput(!broker.trim()?'broker':'market');return;}
    if(broker!==broker.trim()){this.message('券商全称首尾有空格，请核对修改并保存后再上传模板。',true);this.focusInput('broker');return;}
    if((fields.offering||'private')!=='private'){this.message('当前上传入口只保存普通私募立项模板，请核对原材料范围。',true);return;}
    const topic=this.workspace!.topic.topic_id,project=this.workspace!.topic.project_id,id=crypto.randomUUID(),row:Upload={file,purpose:'template',documentType:'init',state:'正在校验模板文件',requestId:crypto.randomUUID()};
    this.uploads.set(id,row);this.uploadPreparing=true;clearTimeout(this.saveTimer);this.paint();let envelope:M4TemplateUploadEnvelope|undefined,currentId:string|undefined;
    const validPage=()=>this.live()&&this.workspace?.topic.topic_id===topic&&this.workspace.topic.project_id===project;
    try{
      if(file.name.split('.').pop()?.toLowerCase()!=='docx'||file.size===0||file.size>M1_UPLOAD_LIMITS.fileBytes)throw new ApiError(422,'VALIDATION_FAILED');
      const bytes=await file.arrayBuffer();if(!validPage())return;const digest=await crypto.subtle.digest('SHA-256',bytes);if(!validPage())return;
      const declaration:Dto<'UploadCreateRequest'>={filename:file.name,media_type:M1_UPLOAD_MIME_TYPES[0],byte_size:file.size,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),role:'other'};
      await this.cacheQueue;if(!validPage()||this.cacheFailure)return;if(!m4UploadSame(this.drafts.get('init'),base))throw new UserFacingError('原立项材料与要求已有修改，请核对保存后重新选择模板文件。');
      envelope=await this.m4TemplateUploads.prepare(declaration);if(!validPage())return;const item=envelope.items[0];currentId=item.id;this.uploadFiles.set(item.id,file);this.uploads.delete(id);
      this.uploadPreparing=false;this.uploading=true;this.scanUploadRecovery();this.paint();
      const result=await this.m4TemplateUploads.resume(envelope.id,item.index,{file,...this.templateUploadCallbacks(item.id)});if(!validPage())return;this.applyTemplateUploadResult(result,item.index);this.cache();await this.cacheQueue;
    }catch(error){if(validPage()){const text=this.templateUploadErrorText(error,currentId);if(currentId){this.uploadStatuses.delete(currentId);if(error instanceof UploadRecoveryNeedsFileError)this.uploadNeedsFile.add(currentId);this.uploadErrors.set(currentId,text);}else if(envelope){for(const item of envelope.items)this.uploadErrors.set(item.id,text);}else row.error=text;this.message(text,true);}}
    finally{this.uploadPreparing=false;this.uploading=false;if(validPage()){this.scanUploadRecovery();this.cache();this.paint();}}
  }
  private async uploadRecoverable(files:File[],purpose:'source'|'material',type:M4DocumentType){
    if(!files.length||this.deletingMaterial||this.executing||this.sending||this.uploadActionBlocked())return;
    if(!await this.ensureWorkspace(M4_DOCUMENT_LABELS[type])||!this.live()||this.uploadActionBlocked())return;
    if(this.pendingMessage||this.pendingExecution){this.message('原发送或制作请求尚未确认，请先核对原请求再上传新材料。',true);return;}
    if(!await this.flush()||!this.live()||this.uploadActionBlocked())return;
    await this.cacheQueue;if(!this.live()||this.cacheFailure||!this.m4Uploads||this.uploadActionBlocked())return;
    const topic=this.workspace!.topic.topic_id,project=this.workspace!.topic.project_id,selectedFiles=purpose==='source'?files.slice(0,1):files;
    const rows=selectedFiles.map(file=>({id:crypto.randomUUID(),row:{file,purpose,documentType:type,state:'正在校验文件',requestId:crypto.randomUUID()} as Upload}));
    for(const entry of rows)this.uploads.set(entry.id,entry.row);
    this.uploadPreparing=true;clearTimeout(this.saveTimer);this.paint();let envelope:M4UploadEnvelope|undefined,currentId:string|undefined;
    const validPage=()=>this.live()&&this.workspace?.topic.topic_id===topic&&this.workspace.topic.project_id===project;
    try{
      const declarations:Dto<'UploadCreateRequest'>[]=[];
      for(const {row} of rows){const extension=row.file.name.split('.').pop()?.toLowerCase()??'',mime=mimeByExtension[extension];if(!mime||purpose==='source'&&!['docx','pdf'].includes(extension)||row.file.size===0||row.file.size>M1_UPLOAD_LIMITS.fileBytes)throw new ApiError(422,'VALIDATION_FAILED');const bytes=await row.file.arrayBuffer();if(!validPage())return;const digest=await crypto.subtle.digest('SHA-256',bytes);if(!validPage())return;declarations.push({filename:row.file.name,media_type:mime,byte_size:row.file.size,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),role:purpose==='source'?'historical':'other'});}
      await this.cacheQueue;if(!validPage()||this.cacheFailure)return;
      envelope=await this.m4Uploads.prepare(declarations,purpose,type);if(!validPage())return;
      for(const [index,item] of envelope.items.entries()){this.uploadFiles.set(item.id,selectedFiles[index]);this.uploads.delete(rows[index].id);}
      this.uploadPreparing=false;this.uploading=true;this.scanUploadRecovery();this.paint();
      const original=envelope;
      await orderedUploadPipeline(original.items,
        (item,_index,signal)=>this.m4Uploads!.transfer(original.id,item.index,{file:this.uploadFiles.get(item.id),signal,...this.uploadCallbacks(item.id)}),
        async(_material,item)=>{currentId=item.id;this.uploadErrors.delete(item.id);const result=await this.m4Uploads!.resume(original.id,item.index,{...this.uploadCallbacks(item.id)});if(!validPage())return false;const applied=this.applyUploadResult(result,item.index);this.cache();await this.cacheQueue;return validPage()&&!this.cacheFailure&&['complete','content_confirmed'].includes(result.state)&&applied;},this.controller.signal);
    }catch(error){if(error instanceof UploadPreparationError){currentId=envelope?.items[error.index]?.id;error=error.original;}if(validPage()){const text=this.uploadErrorText(error,currentId);if(currentId){this.uploadStatuses.delete(currentId);if(error instanceof UploadRecoveryNeedsFileError)this.uploadNeedsFile.add(currentId);this.uploadErrors.set(currentId,text);}else if(envelope){for(const item of envelope.items)this.uploadErrors.set(item.id,text);}else for(const {row} of rows)row.error=text;this.message(text,true);}}
    finally{this.uploadPreparing=false;this.uploading=false;if(validPage()){this.scanUploadRecovery();this.cache();this.paint();}}
  }
  private async upload(files:File[],purpose:Upload['purpose'],type:M4DocumentType|null){if(purpose==='template'){await this.uploadTemplateRecoverable(files,type);return;}if((purpose==='source'||purpose==='material')&&type){await this.uploadRecoverable(files,purpose,type);return;}if(this.uploadActionBlocked())return;if(this.deletingMaterial){this.message('正在删除材料，请稍候再上传。');return;}if(!files.length)return;if(!await this.ensureWorkspace(type?M4_DOCUMENT_LABELS[type]:'文件生成')||this.uploadActionBlocked())return;for(const file of files){const id=crypto.randomUUID();const row:Upload={file,purpose,documentType:type,state:'等待上传',requestId:crypto.randomUUID()};this.uploads.set(id,row);}for(const [id,row] of this.uploads)if(!row.error&&!row.material)await this.processUpload(id,row);}
  private async processUpload(id:string,row:Upload){if(row.purpose==='template'){if(this.uploadActionBlocked())return;this.uploads.delete(id);await this.uploadTemplateRecoverable([row.file],row.documentType);return;}if((row.purpose==='source'||row.purpose==='material')&&row.documentType){if(this.uploadActionBlocked())return;this.uploads.delete(id);await this.uploadRecoverable([row.file],row.purpose,row.documentType);return;}if(this.uploadActionBlocked())return;await this.processLegacyUpload(id,row);}
  private async processLegacyUpload(id:string,row:Upload){if(!this.workspace||this.uploading||this.uploadInputBlocked())return;row.error=undefined;if(row.purpose==='template'){const fields=row.documentType?this.drafts.get(row.documentType)?.input.fields:undefined;if(!fields?.broker?.trim()||!['sse','szse'].includes(fields.market)){row.error='请先填写主承销商并选择交易所，再上传对应的私有立项模板。';this.message(row.error,true);this.paintContent();return;}}this.uploading=true;const projectId=this.workspace.topic.project_id;const state=(s:string,p?:FileUploadProgress)=>{row.state=s;row.progress=p??uploadActivity(s);if(this.live()){this.paintContent();this.paintAgent();}};try{const extension=row.file.name.split('.').pop()?.toLowerCase()??'',mime=mimeByExtension[extension];if(!mime||row.purpose==='template'&&extension!=='docx'||row.purpose==='source'&&!['docx','pdf'].includes(extension)||row.file.size===0||row.file.size>M1_UPLOAD_LIMITS.fileBytes)throw new ApiError(422,'VALIDATION_FAILED');if(!row.hash){state('正在校验文件');const digest=await crypto.subtle.digest('SHA-256',await row.file.arrayBuffer());row.hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}if(!this.live()||this.uploadInputBlocked(false))return;if(!row.material){if(!row.session){row.session=await this.api.createUpload(projectId,{filename:row.file.name,media_type:mime,byte_size:row.file.size,sha256:row.hash,role:row.purpose==='source'?'historical':'other'},this.controller.signal);if(!this.live()||this.uploadInputBlocked(false))return;}if(!row.bytesSaved){state('正在上传');await this.api.uploadBytes(row.session.upload_url,row.file,(loaded,total)=>{const p=uploadTransfer(loaded,total);state(p.message,p);},this.controller.signal);if(!this.live()||this.uploadInputBlocked(false))return;row.bytesSaved=true;}state('正在确认保存');row.material=await this.api.completeUpload(projectId,row.session.upload_id,{byte_size:row.file.size,sha256:row.hash},this.controller.signal);if(!this.live()||this.uploadInputBlocked(false))return;}const pin=materialPin(projectId,row.material);this.metadata.set(pinKey(pin),row.material);state('正在加入工作区');if(this.uploadInputBlocked())return;await this.m4.material(this.topicId!,pin);if(!this.live()||this.uploadInputBlocked(false))return;const draft=row.documentType?this.drafts.get(row.documentType):undefined;if(row.purpose==='source'&&draft)draft.input.source_material=pin;else if(row.purpose==='material'&&draft&&!draft.input.materials.some(m=>pinKey(m)===pinKey(pin)))draft.input.materials.push(pin);else if(row.purpose==='template'&&draft&&row.documentType){const broker=draft.input.fields.broker?.trim();if(!broker)throw new ApiError(422,'INPUT_REQUIRED');const {template}=await this.m4.template({creation_request_id:row.requestId,name:row.file.name,broker,document_type:row.documentType,material:pin,market:draft.input.fields.market as 'sse'|'szse'});if(!this.live()||this.uploadInputBlocked(false))return;draft.input.template={template_id:template.template_id,template_version:template.template_version,sha256:template.sha256};}if(row.documentType)this.changed(row.documentType);if(!await this.flush())return;if(isReusedUpload(row.material,row.session))this.duplicateUploads.set(id,{filename:row.file.name,material:row.material,purpose:row.purpose,documentType:row.documentType});this.uploads.delete(id);await this.refresh();this.message(row.purpose==='attachment'?'附件已保存到工作区资料库，可向助手提问；正式制作需勾选本次采用材料。':'');}catch(error){if(this.live()){row.error=`${friendlyError(error,'save')} ${row.bytesSaved?'文件字节已上传，重试会先恢复保存登记。':''}`;this.message(row.error,true);}}finally{this.uploading=false;if(this.live()){this.paintContent();this.paintAgent();}}}
  private referencePickerProblem(type:M4DocumentType|null){
    if(this.invalidDraftType)return draftTypeMismatchMessage;
    if(this.uploadActionBlocked(false))return '请先核对原材料或模板保存，本页材料与要求保留。';
    if(this.pendingMessage||this.pendingExecution||this.sending||this.executing)return '原发送或制作请求尚待确认，请先核对原请求，再选择其他材料。';
    if(this.deletingMaterial)return '正在删除材料，请等待原操作完成后再选择。';
    if(this.cacheFailure)return '本机草稿尚未可靠保存，请先核对原保存问题，再选择已有材料。';
    if(this.draftComparison?.dialog.open||this.viewConflict)return '请先核对当前版本冲突，再选择已有材料。';
    const draft=type?this.drafts.get(type):undefined;
    if(!type||!draft||draft.input.document_type!==type)return '请先选择要编制的文件类型，再添加材料。';
    if(draft.conflict)return '本页材料与要求存在版本冲突，请先核对输入版本。';
    return '';
  }
  private async openProjectPicker(purpose:MaterialReferencePurpose,opener?:HTMLElement){
    const type=this.selected,problem=this.referencePickerProblem(type);
    if(problem){this.message(problem,true);return;}
    const input=structuredClone(this.drafts.get(type!)!.input);
    if(!await this.ensureWorkspace(M4_DOCUMENT_LABELS[type!])||!this.live())return;
    if(this.selected!==type||!sameMaterialDraftValue(this.drafts.get(type!)?.input,input)){this.message('本页材料类型或内容已有变化，请从当前页面重新选择。',true);return;}
    const after=this.referencePickerProblem(type);if(after){this.message(after,true);return;}
    const topic=this.topicId!,project=this.workspace!.topic.project_id;
    const scope=()=>this.live()&&this.topicId===topic&&this.workspace?.topic.topic_id===topic&&this.workspace.topic.project_id===project;
    const target=()=>scope()&&this.selected===type&&this.reading.selected==='input'&&this.drafts.get(type!)?.input.document_type===type&&sameMaterialDraftValue(this.drafts.get(type!)!.input,input)&&!this.referencePickerProblem(type);
    this.referencePickerNotice=undefined;this.referencePicker?.dispose();this.dialog?.remove();
    let picker:MaterialReferencePicker;
    picker=new MaterialReferencePicker({api:this.api,signal:this.controller.signal,purpose,targetLabel:M4_DOCUMENT_LABELS[type!],opener,
      initialProjectId:input.source_material?.source_project_id??this.sourceProjectId??this.workspace!.topic.source_project_id??undefined,
      notice:purpose==='source'&&input.project_file?'这份关联文件已固定募集书依据；如需更换，请从项目文件入口重新选择。补充资料仍可添加。':undefined,
      current:()=>scope()&&this.referencePicker===picker,targetCurrent:target,busy:()=>this.referenceRegistration,
      unavailable:pin=>purpose==='source'&&input.source_material&&pinKey(pin)===pinKey(input.source_material)?'本页已采用此募集书版本。':purpose==='source'&&input.project_file?'关联文件的募集书依据已固定，请从项目文件入口重新选择。':purpose==='material'&&(input.materials.some(p=>pinKey(p)===pinKey(pin))||input.source_material&&pinKey(input.source_material)===pinKey(pin))?'本页已采用此准确版本，无需重复添加。':undefined,
      choose:(pin,record,stillChosen)=>this.adoptReferenceMaterial({topic,project,type:type!,purpose,input,scope,target},pin,record,stillChosen),
      report:(text,error)=>{if(scope()&&this.referencePicker===picker){const preserve=this.statusError&&(this.saveFailed||this.cacheFailure||this.viewConflict||!!this.saving||[...this.drafts.values()].some(d=>d.conflict));this.referencePickerNotice=error?text:undefined;this.message(preserve?this.status+' '+text:text,error||preserve);}},
      fallbackFocus:()=>this.page?.querySelector<HTMLElement>('[data-m4-action="project-picker"][data-picker-purpose="'+purpose+'"]')??this.page?.querySelector<HTMLElement>('h1')??undefined});
    this.referencePicker=picker;this.dialog=picker.dialog;picker.open();
  }
  private async adoptReferenceMaterial(context:{topic:string;project:string;type:M4DocumentType;purpose:MaterialReferencePurpose;input:M4DraftInput;scope:()=>boolean;target:()=>boolean},pin:M4MaterialPin,record:Dto<'MaterialResponse'>,stillChosen:()=>boolean):Promise<MaterialReferenceChoice>{
    const label=M4_DOCUMENT_LABELS[context.type],file=record.filename+' · V'+pin.material_version;
    if(this.referenceRegistration)return {applied:false,message:'上一份文件仍在登记，请等待原结果，再明确选择。'};
    const valid=()=>context.target()&&stillChosen();
    if(!valid())return {applied:false,message:'原材料、文种或待确认状态已有变化。本页内容保留，请关闭后重新选择。'};
    if(context.purpose==='source'&&context.input.project_file&&(!context.input.source_material||pinKey(context.input.source_material)!==pinKey(pin)))return {applied:false,message:'这份关联文件已固定募集书依据，未登记或更换；请从项目文件入口重新选择。'};
    if(record.material_id!==pin.material_id||record.material_version!==pin.material_version||record.sha256!==pin.sha256||record.state!=='persisted'||context.purpose==='source'&&!M1_UPLOAD_MIME_TYPES.slice(0,2).some(m=>m===record.media_type))return {applied:false,message:'所选文件的准确版本或用途无法核实，未登记或采用。'};
    try{
      const raw=localStorage.getItem(this.cacheKey),cached=raw?JSON.parse(raw):null,child=cached?.drafts?.[context.type];
      if(cached&&(cached.owner!==this.owner||cached.topic!==context.topic)||child&&child.input?.document_type!==context.type)throw new Error('Mismatched cached draft scope');
    }catch{this.cacheFailure=true;return {applied:false,message:'本机原草稿的位置或文件类型无法核实，原记录保留，未登记或采用。'};}
    this.cache();await this.cacheQueue;if(!valid())return {applied:false,message:'本页或另一页面的原草稿已有变化，未登记或采用。本页完整内容保留。'};
    if(this.referenceRegistration)return {applied:false,message:'上一份文件仍在登记，请等待原结果，再明确选择。'};
    this.referenceRegistration=true;
    try{
      await this.m4.material(context.topic,pin);
      if(context.scope()){
        this.metadata.set(pinKey(pin),record);
        if(!this.workspace!.materials.some(p=>pinKey(p)===pinKey(pin)))this.workspace!.materials.push(structuredClone(pin));
        if(!this.workspace!.material_details.some(p=>pinKey(p)===pinKey(pin)))this.workspace!.material_details.push({...structuredClone(pin),filename:record.filename,state:record.state,media_type:record.media_type});
      }
      // A registration receipt does not authorize adopting into a later draft.
      if(valid()){this.cache();await this.cacheQueue;}
      if(!valid()){
        // Keep the later draft and its active control intact; shared membership is already recorded above.
        return {applied:false,message:file+' 已加入原工作区，但原选择或 '+label+' 的内容已有变化，未用于任何新草稿。请核对后重新选择。'};
      }
      const draft=this.drafts.get(context.type)!;
      if(context.purpose==='source')draft.input.source_material=structuredClone(pin);
      else if(!draft.input.materials.some(p=>pinKey(p)===pinKey(pin)))draft.input.materials.push(structuredClone(pin));
      this.changed(context.type);this.paint();
      return {applied:true,message:'已将 '+file+' '+(context.purpose==='source'?'选作 '+label+' 的募集书依据':'加入 '+label+' 的补充资料')+'；本页材料与要求按原流程保存，尚未开始生成。'};
    }finally{this.referenceRegistration=false;this.referencePicker?.refreshAvailability();}
  }
  private comparisonMetadata(w:M4Workspace,input:M4DraftInput,local=false):MaterialDraftComparisonMetadata{
    const materials=(w.material_details??[]).map(m=>({pin:{source_project_id:m.source_project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256},filename:m.filename}));
    if(local)for(const pin of [input.source_material,...input.materials].filter((p):p is M4MaterialPin=>!!p)){
      if(materials.some(m=>pinKey(m.pin)===pinKey(pin)))continue;const known=this.metadata.get(pinKey(pin));
      if(known&&known.material_id===pin.material_id&&known.material_version===pin.material_version&&known.sha256===pin.sha256)materials.push({pin:structuredClone(pin),filename:known.filename});
    }
    return structuredClone({materials,templates:w.templates,artifacts:w.artifacts,projects:local?[...this.projectNames].map(([id,name])=>({id,name})):[{id:w.project.project_id,name:w.project.name}]});
  }
  private comparisonCurrent(state:DraftComparisonDialog,input=true){
    const current=this.drafts.get(state.type);
    return this.live()&&!this.invalidDraftType&&this.draftComparison===state&&state.dialog.open&&this.topicId===state.topic&&this.workspace?.topic.project_id===state.project&&this.selected===state.type&&state.local.input.document_type===state.type&&current?.input.document_type===state.type&&(!input||current.version===state.local.version&&sameMaterialDraftValue(current.input,state.local.input));
  }
  private comparisonCache(state:DraftComparisonDialog):{raw:string|null;value:Record<string,any>;draft:unknown}{
    const raw=localStorage.getItem(this.cacheKey),value=raw===null?{owner:this.owner,topic:state.topic,drafts:{}}:JSON.parse(raw);
    if(!value||value.owner!==this.owner||value.topic!==state.topic||!value.drafts||typeof value.drafts!=='object'||Array.isArray(value.drafts))throw new UserFacingError('本机草稿暂时无法可靠读取，请保持页面打开后重试。');
    return {raw,value,draft:Object.hasOwn(value.drafts,state.type)?value.drafts[state.type]:undefined};
  }
  private comparisonProblem(state:DraftComparisonDialog,message:string,stale=false){
    if(this.draftComparison!==state||!state.dialog.open)return;state.busy=false;state.saving=false;state.status=message;state.error=true;state.stale=stale;this.paintDraftComparison(state);
  }
  private comparisonRows(rows:MaterialDraftComparisonRow[],task=false){
    if(task)return rows.map(row=>'<article class="m4-comparison-row" data-task-draft-row="'+esc(row.key)+'" data-comparison-change="'+row.change+'"><h4>'+esc(row.label)+(row.change==='same'?'':'<small>'+(row.change==='reference'?'引用不同':'内容不同')+'</small>')+'</h4><div class="m4-comparison-sides">'+(['local','server'] as const).map(side=>'<section data-task-draft-side="'+(side==='local'?'submitted':'current')+'"><strong>'+(side==='local'?'本次提交内容':'当前草稿')+'</strong>'+row[side].map((block,index)=>'<div class="m4-comparison-block"><p'+(block.unverified?' data-comparison-unverified':'')+'>'+esc(block.text)+'</p>'+(block.reference?'<details data-comparison-reference data-m4-detail="'+esc('task-draft-ref-'+row.key+'-'+side+'-'+index+'-'+encodeURIComponent(JSON.stringify(block.reference)))+'"><summary>查看准确引用</summary><dl>'+block.reference.map(ref=>'<dt>'+esc(ref.label)+'</dt><dd>'+esc(ref.value)+'</dd>').join('')+'</dl></details>':'')+'</div>').join('')+'</section>').join('')+'</div></article>').join('');
    return rows.map(row=>'<article class="m4-comparison-row" data-draft-comparison-row="'+esc(row.key)+'" data-comparison-change="'+row.change+'"><h4>'+esc(row.label)+(row.change==='same'?'':'<small>'+ (row.change==='reference'?'引用已变化':'内容有变化')+'</small>')+'</h4><div class="m4-comparison-sides">'+(['local','server'] as const).map(side=>'<section data-comparison-side="'+side+'"><strong>'+(side==='local'?'本页未保存内容':'已保存版本')+'</strong>'+row[side].map((block,index)=>'<div class="m4-comparison-block"><p'+(block.unverified?' data-comparison-unverified':'')+'>'+esc(block.text)+'</p>'+(block.reference?'<details data-comparison-reference data-comparison-open="'+esc(row.key+':'+side+':'+index)+'"><summary>查看准确引用</summary><dl>'+block.reference.map(ref=>'<dt>'+esc(ref.label)+'</dt><dd>'+esc(ref.value)+'</dd>').join('')+'</dl></details>':'')+'</div>').join('')+'</section>').join('')+'</div></article>').join('');
  }
  private paintDraftComparison(state:DraftComparisonDialog){
    if(this.draftComparison!==state)return;
    const active=document.activeElement as HTMLElement|null,opened=[...state.dialog.querySelectorAll<HTMLDetailsElement>('details[data-comparison-open]')].filter(d=>d.open).map(d=>d.dataset.comparisonOpen!),focused=active?.dataset.draftComparisonAction,topCloseFocused=active?.matches('[data-draft-comparison-top-close]'),contentFocused=active?.matches('[data-draft-comparison-content]'),hadFocus=state.dialog.contains(active),scrollTop=state.dialog.querySelector<HTMLElement>('[data-draft-comparison-content]')?.scrollTop??0;
    const comparison=state.server?compareMaterialDraftInputs(state.local.input,state.server.input,state.localMetadata,state.server.metadata):undefined;
    const noChanges=comparison?.changed.length===0,status=noChanges&&!state.error&&state.status==='请先核对变化，再选择保留哪一份完整材料与要求。'?'两份完整材料与要求相同。使用已保存版本即可继续，无需重复保存新版。':state.status;
    const consequence=noChanges?'使用已保存版本会保留相同的完整材料与要求，不重复保存新版，也不会开始生成。暂不处理会保留本页草稿和版本冲突，处理前不能开始新任务。正在运行的任务继续使用原固定输入。':'保留本页内容会完整保存为新版；使用已保存版本会替换本页该文件的未保存内容。暂不处理会保留两侧内容和版本冲突，处理前不能开始新任务。正在运行的任务继续使用原固定输入。';
    const disabled=state.busy||state.stale||!state.server||!state.cacheReady||!!this.pendingMessage||!!this.pendingExecution||this.cacheFailure;
    state.dialog.setAttribute('aria-busy',String(state.busy));
    state.dialog.innerHTML='<header data-draft-comparison-header><div class="m4-comparison-heading"><h2 id="m4-draft-comparison-title" tabindex="-1">核对材料与要求</h2><button type="button" class="text-btn" data-draft-comparison-top-close aria-label="暂不处理并关闭比较"'+(state.saving?' disabled':'')+'>关闭</button></div><p id="m4-draft-comparison-intro" class="m4-comparison-intro">'+esc(M4_DOCUMENT_LABELS[state.type])+' · 本页草稿基于 V'+state.originVersion+(state.server?'；已保存版本 V'+state.server.version:'')+(noChanges?'。采用相同的已保存版本即可继续；不会开始生成或扣费。':'。请选择保留哪一份完整输入；不会逐项合并，也不会开始生成或扣费。')+'</p></header><div data-draft-comparison-content role="region" aria-label="完整材料与要求比较" tabindex="0">'+(comparison?'<section data-draft-comparison-changed aria-label="变化内容"><h3>需要核对的变化（'+comparison.changed.length+'项）</h3>'+(comparison.changed.length?this.comparisonRows(comparison.changed):'<p>两份完整材料与要求相同。使用已保存版本即可继续，无需重复保存新版。</p>')+'</section><details data-draft-comparison-same data-comparison-open="same"><summary>相同内容（'+comparison.unchanged.length+'项）</summary>'+this.comparisonRows(comparison.unchanged)+'</details>':'<p>正在读取已保存版本；本页完整草稿保持。</p>')+'</div><footer data-draft-comparison-footer><p data-draft-comparison-status role="'+(state.error?'alert':'status')+'" data-error="'+state.error+'">'+esc(status)+'</p><div class="m4-comparison-actions">'+(noChanges?'':'<button type="button" class="btn primary" data-draft-comparison-action="keep"'+(disabled?' disabled':'')+'>保留本页内容并保存新版</button>')+'<button type="button" class="btn '+(noChanges?'primary':'secondary')+'" data-draft-comparison-action="server"'+(disabled?' disabled':'')+'>使用已保存版本</button><button type="button" class="text-btn" data-draft-comparison-action="reload"'+(state.busy?' disabled':'')+'>重新读取比较</button><button type="button" class="text-btn" data-draft-comparison-action="close"'+(state.saving?' disabled':'')+'>暂不处理</button></div><p class="m4-comparison-intro">'+esc(consequence)+'</p></footer>';
    for(const key of opened)state.dialog.querySelector<HTMLDetailsElement>('details[data-comparison-open="'+CSS.escape(key)+'"]')?.setAttribute('open','');
    const content=state.dialog.querySelector<HTMLElement>('[data-draft-comparison-content]')!;content.scrollTop=scrollTop;
    const nextFocus=focused?state.dialog.querySelector<HTMLButtonElement>('[data-draft-comparison-action="'+CSS.escape(focused)+'"]:not(:disabled)'):topCloseFocused?state.dialog.querySelector<HTMLButtonElement>('[data-draft-comparison-top-close]:not(:disabled)'):contentFocused?content:undefined;
    if(nextFocus)nextFocus.focus({preventScroll:true});else if(hadFocus){const status=state.dialog.querySelector<HTMLElement>('[data-draft-comparison-status]')!;status.tabIndex=-1;status.focus({preventScroll:true});}
  }
  private closeDraftComparison(state:DraftComparisonDialog,message?:string){
    if(this.draftComparison!==state)return;if(state.saving)return;
    this.draftComparison=undefined;if(this.dialog===state.dialog)this.dialog=undefined;state.dialog.close();state.dialog.remove();
    if(message)this.message(message);this.cache();this.paint();
    if(!this.live())return;const target=state.opener?.isConnected?state.opener:this.page?.querySelector<HTMLElement>('[data-m4-action="resolve-draft"]')??this.page?.querySelector<HTMLElement>('.page-head h1');
    if(target){if(!target.matches('button,a,input,select,textarea,[tabindex]'))target.tabIndex=-1;target.focus({preventScroll:true});}
  }
  private async readDraftComparison(state:DraftComparisonDialog,recapture=false){
    if(!this.comparisonCurrent(state,false)){this.comparisonProblem(state,'当前项目或文件类型已变化，请关闭此比较后，从当前文件重新核对。',true);return;}
    if(recapture){state.local=structuredClone(this.drafts.get(state.type)!);state.originVersion=state.local.version;state.localMetadata=this.comparisonMetadata(this.workspace!,state.local.input,true);state.cacheReady=false;state.stale=false;}
    state.busy=true;state.status='正在读取已保存版本，请稍候。';state.error=false;this.paintDraftComparison(state);
    try{
      if(this.saving)await this.saving;await this.cacheQueue;
      if(!this.comparisonCurrent(state))throw new UserFacingError('本页材料或要求已有变化，请重新读取比较后选择。');
      if(this.uploadActionBlocked(false))throw new UserFacingError('请先处理原文件或模板保存待办；当前比较和完整草稿仍保留。');
      const cached=this.comparisonCache(state);state.cacheDraft=structuredClone(cached.draft);state.cacheReady=true;
      if(cached.draft!==undefined){const stored=cached.draft as Partial<LocalDraft>;
        if(!stored||!Number.isSafeInteger(stored.version)||!Value.Check(M4DraftInputSchema,stored.input)||stored.input.document_type!==state.type){state.cacheReady=false;throw new UserFacingError('本机此文件的完整草稿或文件类型暂不可核实，请保留原记录并核对后重读。');}
        if(stored.version!==state.local.version||!sameMaterialDraftValue(stored.input,state.local.input)){state.cacheReady=false;throw new UserFacingError('另一页面在此浏览器中保留了不同的材料与要求。本页草稿保留；请先在该页面核对原草稿，再回来重新读取，当前不会覆盖未看过的内容。');}
      }
      const fresh=await this.m4.workspace(state.topic);
      if(!this.comparisonCurrent(state))throw new UserFacingError('本页材料、要求或文件类型已有变化，请重新读取比较后选择。');
      if(fresh.topic.project_id!==state.project||fresh.drafts[state.type]?.document_type!==state.type||!Number.isSafeInteger(fresh.drafts[state.type].version)||fresh.drafts[state.type].version<0)throw new UserFacingError('已保存版本的项目或文件类型暂不可核实，请重新读取。');
      if(!sameMaterialDraftValue(this.comparisonCache(state).draft,state.cacheDraft))throw new UserFacingError('另一页面修改了本机草稿，请重新读取比较后选择。');
      const input=this.inputOf(fresh.drafts[state.type]);state.server={version:fresh.drafts[state.type].version,input,metadata:this.comparisonMetadata(fresh,input)};
      state.busy=false;state.stale=false;state.status=this.pendingMessage||this.pendingExecution?'原发送或制作请求仍待确认。请先核对原请求，当前比较不改变其范围或版本。':this.cacheFailure?'本机完整草稿仍有保存问题，请处理原保存提示后重新读取比较。':'请先核对变化，再选择保留哪一份完整材料与要求。';this.paintDraftComparison(state);
    }catch(error){this.comparisonProblem(state,friendlyError(error,'read'),!this.comparisonCurrent(state)||state.cacheReady&&!sameMaterialDraftValue(this.comparisonCacheSafe(state),state.cacheDraft));}
  }
  private comparisonCacheSafe(state:DraftComparisonDialog){try{return this.comparisonCache(state).draft;}catch{return {comparisonCacheUnreadable:true};}}
  private async storeComparisonDraft(state:DraftComparisonDialog,next:LocalDraft){
    await this.cacheQueue;
    if(next.input.document_type!==state.type)throw new UserFacingError('所选完整输入的文件类型不一致，未保存或采用，请重新核对。');
    if(!this.comparisonCurrent(state)||this.uploadActionBlocked(false)||this.pendingMessage||this.pendingExecution||this.cacheFailure)throw new UserFacingError('当前完整输入或原请求待办已有变化，请保留草稿并重新核对。');
    if(!this.m4Uploads)throw new UserFacingError('本机草稿保存尚未准备好，请重新读取。');
    const expected=structuredClone(state.cacheDraft);this.cachePending++;
    const operation=this.cacheQueue.then(async()=>{
      if(!this.comparisonCurrent(state))throw new UserFacingError('本页完整输入已有变化，未采用旧比较。');
      const current=this.comparisonCache(state);if(!sameMaterialDraftValue(current.draft,expected))throw new UserFacingError('另一页面修改了本机草稿，未覆盖该内容。请重新读取比较。');
      const changed=structuredClone(current.value);changed.drafts[state.type]=structuredClone(next);
      const result=await this.m4Uploads!.mergeCache(current.raw,JSON.stringify(changed));
      if(!result.accepted.includes('draft:'+state.type))throw new UserFacingError('另一页面修改了此文件的草稿，未覆盖该内容。请重新读取比较。');
      const baseline=this.cacheBaseline===null?{owner:this.owner,topic:state.topic,drafts:{}}:JSON.parse(this.cacheBaseline);baseline.drafts??={};baseline.drafts[state.type]=structuredClone(next);this.cacheBaseline=JSON.stringify(baseline);
      if(!this.comparisonCurrent(state)||this.uploadActionBlocked(false)||this.pendingMessage||this.pendingExecution)throw new UserFacingError('本机所选内容已保留，当前输入或原请求又有变化，请重新读取核对。');
      this.drafts.set(state.type,structuredClone(next));state.local=structuredClone(next);state.cacheDraft=structuredClone(next);this.draftGeneration++;
    });
    this.cacheQueue=operation.then(()=>{},()=>{}).finally(()=>{this.cachePending--;});await operation;
  }
  private comparisonContextSaved(state:DraftComparisonDialog,version:number,input:M4DraftInput){
    this.docQuote=undefined;this.qaQuote=undefined;
    if(this.view.unsent_context.document_type===state.type&&this.view.unsent_context.draft_version===state.originVersion){this.view.unsent_context={...this.view.unsent_context,draft_version:version,source_material:structuredClone(input.source_material)};this.viewDirty=true;}
    this.cache(true);
  }
  private async chooseDraftComparison(state:DraftComparisonDialog,choice:'keep'|'server'){
    if(state.busy||state.stale||!state.server||!state.cacheReady)return;
    if(!this.comparisonCurrent(state)){this.comparisonProblem(state,'本页完整输入已有变化，请重新读取比较。',true);return;}
    state.busy=true;state.error=false;state.status='正在再次核对已保存版本；尚未采用或保存。';this.paintDraftComparison(state);
    try{
      await this.cacheQueue;
      if(!this.comparisonCurrent(state)||this.uploadActionBlocked(false)||this.pendingMessage||this.pendingExecution||this.cacheFailure)throw new UserFacingError('本页输入、原请求或保存状态待核对，请重新读取比较。');
      if(!sameMaterialDraftValue(this.comparisonCache(state).draft,state.cacheDraft))throw new UserFacingError('另一页面修改了本机草稿，请重新读取比较后选择。');
      const fresh=await this.m4.workspace(state.topic);
      if(!this.comparisonCurrent(state))throw new UserFacingError('本页材料、要求或文件类型已有变化，未采用旧比较。');
      const saved=fresh.drafts[state.type],input=this.inputOf(saved);
      if(fresh.topic.project_id!==state.project||input.document_type!==state.type||!Number.isSafeInteger(saved.version)||saved.version<0)throw new UserFacingError('已保存版本的项目或文件类型暂不可核实，请重新读取。');
      if(saved.version!==state.server.version||!sameMaterialDraftValue(input,state.server.input)){
        state.server={version:saved.version,input,metadata:this.comparisonMetadata(fresh,input)};state.busy=false;state.status='已保存版本又有变化。比较已更新，请重新核对并再次选择；尚未保存或采用。';this.paintDraftComparison(state);return;
      }
      await this.cacheQueue;if(!this.comparisonCurrent(state))throw new UserFacingError('本页完整输入已有变化，未采用旧比较。');
      if(choice==='server'||sameMaterialDraftValue(state.local.input,input)){
        await this.storeComparisonDraft(state,{version:saved.version,input,dirty:false,conflict:false});this.workspace!.drafts[state.type]=structuredClone(saved);this.comparisonContextSaved(state,saved.version,input);await this.cacheQueue;
        if(this.cacheFailure)throw new UserFacingError('已使用所选已保存内容，本机其他输入仍有保存问题，请保留页面并核对原保存提示。');
        state.busy=false;this.closeDraftComparison(state,choice==='server'?'已使用核对过的已保存版本；本页该文件的未保存内容已替换。':'已保存版本已有相同内容，已采用该版本，无需重复保存。');return;
      }
      const intended=structuredClone(state.local.input),expected=saved.version;
      await this.storeComparisonDraft(state,{version:expected,input:intended,dirty:true,conflict:true});
      this.comparisonContextSaved(state,expected,intended);state.originVersion=expected;await this.cacheQueue;
      if(this.cacheFailure)throw new UserFacingError('原完整草稿已保留，本机状态尚未可靠保存；新版保存尚未发送，请核对后重新读取。');
      if(!this.comparisonCurrent(state)||intended.document_type!==state.type||this.uploadActionBlocked(false)||this.pendingMessage||this.pendingExecution)throw new UserFacingError('本次完整草稿已保留，文件类型、原保存待办或发送请求已有变化，尚未发送新版保存。');
      state.saving=true;state.status='正在保存本页完整内容。请等待结果；不会开始生成任务。';this.paintDraftComparison(state);
      const reply=await this.m4.draft(state.topic,{expected_version:expected,input:intended});
      if(!this.comparisonCurrent(state))throw new UserFacingError('保存结果已返回，当前完整输入又有变化，请重新读取核对。');
      const actual=this.inputOf(reply.draft);
      if(reply.draft.version!==expected+1||!sameMaterialDraftValue(actual,intended))throw new UserFacingError('保存回执暂不可核实，原完整草稿及保存版本条件已保留。请重新读取核对。');
      await this.storeComparisonDraft(state,{version:reply.draft.version,input:actual,dirty:false,conflict:false});this.workspace!.drafts[state.type]=structuredClone(reply.draft);this.comparisonContextSaved(state,reply.draft.version,actual);await this.cacheQueue;
      if(this.cacheFailure)throw new UserFacingError('本页内容已保存为新版，本机其他输入仍有保存问题，请保留页面并核对原保存提示。');
      state.busy=false;state.saving=false;this.closeDraftComparison(state,'已将核对过的本页材料与要求保存为 V'+reply.draft.version+'；尚未开始生成。');
    }catch(error){
      if(this.draftComparison!==state||!state.dialog.open)return;
      this.comparisonProblem(state,(friendlyError(error,state.saving?'save':'read'))+(state.saving?' 保存结果仍需核对。原完整草稿和版本条件保留；重新读取不会自动重试保存。':''),!this.comparisonCurrent(state)||!sameMaterialDraftValue(this.comparisonCacheSafe(state),state.cacheDraft));
    }
  }
  private async resolveDraft(){
    if(this.invalidDraftType){this.message(draftTypeMismatchMessage,true);return;}
    if(this.uploadActionBlocked()||!this.selected||!this.workspace||!this.topicId)return;
    if(this.drafts.get(this.selected)?.input.document_type!==this.selected){this.message('本页草稿的文件类型与当前所选文件不一致，原内容保留，请核对后重新读取。',true);return;}
    this.dialog?.remove();const dialog=document.createElement('dialog');this.dialog=dialog;dialog.className='m4-picker-dialog';dialog.dataset.materialDraftComparison='';dialog.setAttribute('aria-labelledby','m4-draft-comparison-title');dialog.setAttribute('aria-describedby','m4-draft-comparison-intro');
    const local=structuredClone(this.drafts.get(this.selected)!);const state:DraftComparisonDialog={dialog,topic:this.topicId,project:this.workspace.topic.project_id,type:this.selected,local,originVersion:local.version,localMetadata:this.comparisonMetadata(this.workspace,local.input,true),cacheReady:false,busy:true,saving:false,stale:false,status:'正在读取已保存版本，请稍候。',error:false,opener:document.activeElement instanceof HTMLElement?document.activeElement:undefined};
    this.draftComparison=state;clearTimeout(this.saveTimer);this.paintDraftComparison(state);document.body.append(dialog);
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(!state.saving)this.closeDraftComparison(state,'暂未处理版本冲突。本页完整草稿仍保留，请核对后再开始任务。');});
    dialog.addEventListener('click',event=>{const target=event.target as HTMLElement,action=target.closest<HTMLElement>('[data-draft-comparison-action]')?.dataset.draftComparisonAction;if(action==='close'||target.closest('[data-draft-comparison-top-close]'))this.closeDraftComparison(state,'暂未处理版本冲突。本页完整草稿仍保留，请核对后再开始任务。');else if(action==='reload'&&!state.busy)void this.readDraftComparison(state,true);else if(action==='keep'||action==='server')void this.chooseDraftComparison(state,action);});
    dialog.showModal();dialog.querySelector<HTMLElement>('#m4-draft-comparison-title')!.focus({preventScroll:true});await this.readDraftComparison(state);
  }
  private async resolveView(){
    if(this.uploadActionBlocked())return;
    try{
      const fresh=await this.m4.workspace(this.topicId!);if(!this.live()||this.uploadInputBlocked(false))return;
      this.dialog?.remove();this.dialog=document.createElement('dialog');this.dialog.className='m4-picker-dialog';
      const label=(type:M4DocumentType|null)=>type?M4_DOCUMENT_LABELS[type]:'尚未选择';
      this.dialog.innerHTML=`<h2>核对页面状态</h2><p>本页选择：${esc(label(this.selected))}</p><p>另一页面选择：${esc(label(fresh.view.selected_document_type))}</p><p>请选择要保留的材料类型和阅读位置。已保存的材料与要求、正在运行的任务不会改变。</p><button class="btn primary" data-keep>保留本页显示</button> <button class="btn secondary" data-server>采用另一页面显示</button> <button class="text-btn" data-close>暂不处理</button>`;
      document.body.append(this.dialog);
      this.dialog.querySelector('[data-keep]')!.addEventListener('click',async()=>{await this.cacheQueue;if(!this.live()||this.uploadActionBlocked()||!this.acceptCacheBaseline(['view','viewVersion','viewDirty']))return;this.viewVersion=fresh.view.version;this.viewConflict=false;this.viewDirty=true;this.dialog?.close();void this.flush().then(()=>this.paint());});
      this.dialog.querySelector('[data-server]')!.addEventListener('click',async()=>{await this.cacheQueue;if(!this.live()||this.uploadActionBlocked()||!this.acceptCacheBaseline(['view','viewVersion','viewDirty']))return;const {version,...view}=fresh.view;this.view=structuredClone(view);this.viewVersion=version;this.viewConflict=false;this.viewDirty=false;this.selected=view.selected_document_type??'init';this.reading=this.readingFrom(view);this.dialog?.close();this.cache();this.paint();});
      this.dialog.querySelector('[data-close]')!.addEventListener('click',()=>this.dialog?.close());this.dialog.showModal();
    }catch(error){if(this.live())this.message(friendlyError(error,'read'),true);}
  }

}
