import {PROJECT_DOCUMENT_CATALOG,M1_UPLOAD_LIMITS,resultFilename,type ProjectFileVersion,type ProjectFileCheck,type ProjectDocumentType,type ProjectFileSource,type ProjectFileWorkspace,type M4Workspace,type M4MaterialPin} from '@bondbuddy/contracts';
import {uploadFileMaterial,type UploadFileMaterialState} from './file-workspace';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { UserFacingError } from './user-facing-error';
import { ArtifactDownloads, artifactError, artifactFilename } from './artifact-download';
import { esc, date } from './ui';
import { prototypeIcon as ico } from './prototype-design';
import { fileFolders, inFolder, taskLabel, taskView, taskHref, type ProjectFile } from './project-collection-model';
import { ProspectusPanel } from './prospectus-panel';
import {UploadRecovery,type UploadRecoveryRecord} from './upload-recovery';
import {withProjectContext} from './project-navigation';
import {refreshProjectTasks,type ProjectTaskRefreshBoundary} from './project-task-refresh';
import {fileStatusOptions,isFileStatusGroup,matchesProjectFileVersion,projectFileStatusRows,resolveProjectFileVersion,type FileStatusGroup,type ProjectFileStatusRow} from './project-file-status';
import './project-browser.css';
import './project-workbench.css';
import './consistency-originals.css';
import './project-file-status.css';

type FileCheckContext={family:string;version:string;check:string};
type FileViewReading={fileKey?:string;top?:number;focus?:string};
type FileViewSnapshot={reading:FileViewReading;active?:HTMLElement;action?:{fileKey:string;asset:string;key:string}};
type TaskHistoryReading={runId:string;top:number};
type TaskHistoryView={expanded:boolean;tail?:ProjectTaskRefreshBoundary;reading?:TaskHistoryReading};
type TaskHistorySnapshot={reading?:TaskHistoryReading;focus?:{kind:'row'|'link'|'heading'|'toggle'|'more'|'retry';runId?:string;href?:string}};
type ProjectFileView={folder:string;type?:ProjectDocumentType;q:string;status:FileStatusGroup;closed:string[];reading?:FileViewReading;taskHistory?:TaskHistoryView};
const projectFileViews=new Map<string,ProjectFileView>();
const fileSearchLimit=200;
const fileViewFocus=(kind:string,key?:string)=>JSON.stringify(key===undefined?[kind]:[kind,key]);
// Same-tab display preferences only. File identities, versions and authority are read again.
export function clearProjectFileViews(){projectFileViews.clear();}

export class ProjectFiles {
  private controller=new AbortController();private downloads=new ArtifactDownloads();private files:ProjectFile[]=[];private disposed=false;
  private dialog?:HTMLDialogElement;private q='';private folder='all';private name='';private statusFilter:FileStatusGroup='all';
  private timer?:ReturnType<typeof setTimeout>;private refreshing=false;
  private pendingDownloads=new Set<string>();private registry:ProjectFileVersion[]=[];private typeFilter:ProjectDocumentType|undefined;private uploading=false;
  private panel?:ProspectusPanel;private sourceProject?:string;private source?:ProjectFileSource|null;
  private fileWorkspace?:M4Workspace;
  private tasks?:Dto<'ProjectTasksResponse'>;private taskError=false;private tasksLoading=false;private registryLoaded=false;private sourceChanged=false;private sourceKey?:string;
  private taskExpanded=false;private taskRead?:Promise<void>;private taskRefreshQueued=false;private taskRetryReset=true;private taskPaging=false;private taskCursors=new Set<string>();
  private initialTaskHistory?:TaskHistoryView;private taskHistoryRestorePending=false;private taskHistoryLoaded=false;
  private loadRevision=0;private sourceNotice='';
  private fileContext?:FileCheckContext;private fileContextInvalid=false;private fileContextParsed=false;
  private fileContextChecks:ProjectFileCheck[]=[];private fileContextRead:'idle'|'loading'|'ready'|'failed'='idle';
  private fileContextChecksRevision=0;private fileContextDataRevision=0;private fileContextDataError=false;
  private fileContextUiReady=false;private fileContextAutoPending=true;private fileContextInteracted=false;private fileContextTarget?:string;
  private fileViewInitialized=false;private fileViewHost?:HTMLElement;private filesLoaded=false;private closedFileGroups=new Set<string>();
  private initialFileReading?:FileViewReading;private initialFileViewSignature='';private initialFileInteraction=0;private fileViewRestorePending=false;
  private fileViewInteraction=0;private fileViewScrollY=scrollY;private restoringFileReading=false;private searchComposing=false;
  private pendingAdoption=false;
  private pendingImport?:{file?:File;type:ProjectDocumentType;request:string;latest:string|null;pin?:Awaited<ReturnType<typeof uploadFileMaterial>>;upload:UploadFileMaterialState;uncertain:boolean;allowReselect?:boolean};
  private savedImport?:{type:ProjectDocumentType;pin:M4MaterialPin;fileId?:string;previous?:number};
  private folderMedia=matchMedia('(max-width:760px)');
  private syncFolderLayout=()=>{const picker=document.querySelector<HTMLDetailsElement>('#pw-folder-picker');if(this.live()&&picker)picker.open=!this.folderMedia.matches;};
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id:string,private owner?:string,private routeChanged:(route:string)=>void=()=>{}){}
  private imports(){if(!this.owner)throw new UserFacingError('当前账号身份尚未确认，不能建立可恢复的上传记录。');return new UploadRecovery(this.api,this.owner,this.id,'project-file-import',()=>this.live());}
  private restoreImport(record:UploadRecoveryRecord){
    const c=record.context;
    if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.request_id!=='string'||!c.request_id||typeof c.document_type!=='string'||!PROJECT_DOCUMENT_CATALOG.some(d=>d.id===c.document_type)||!(c.expected_latest_version_id===null||typeof c.expected_latest_version_id==='string'))throw new UserFacingError('原关联文件的保存范围无法核实，请保留原记录并核对项目文件。');
    this.pendingImport={type:c.document_type as ProjectDocumentType,request:c.request_id,latest:c.expected_latest_version_id as string|null,upload:{operationId:record.id,projectId:this.id},uncertain:true,allowReselect:true};
  }
  private live(){return !this.disposed&&this.current();}
  get hasUnconfirmed(){return !this.disposed&&(this.uploading||!!this.pendingImport?.uncertain||!!this.panel?.hasUnconfirmed);}
  async beforeLeave(){
    if(!this.hasUnconfirmed)return true;
    const message=this.uploading||this.panel?.busy?'正在上传、保存或确认采用，请等待本次操作确认后再离开。':this.pendingImport?.uncertain?'关联文件保存结果尚未确认。请先重试保存，或关闭窗口后点击“继续确认关联文件”，确认后再离开。':'本次上传或采用结果尚未确认。请先在募集书版本中重试确认，再离开。';
    this.status(message);
    for(const status of [this.dialog?.querySelector('[role=status]'),document.querySelector('#pw-prospectus [role=status]'),document.querySelector('dialog[open] [role=status]')])if(status)status.textContent=message;
    return false;
  }
  dispose(){if(!this.disposed)this.rememberFileView();this.disposed=true;this.loadRevision++;clearTimeout(this.timer);this.folderMedia.removeEventListener('change',this.syncFolderLayout);this.controller.abort();this.panel?.dispose();this.downloads.dispose();this.dialog?.remove();}
  private href(section:string,extra:Record<string,string>={}){return '#'+section+'?'+new URLSearchParams({project:this.id,return_project:this.id,...extra});}
  private status(message:string){const node=document.querySelector('#file-action-status');if(node)node.textContent=message;}
  private parseFileContext(query:URLSearchParams){
    if(this.fileContextParsed)return;this.fileContextParsed=true;
    const keys=['file','version','check'] as const;if(!keys.some(key=>query.has(key)))return;
    if(keys.some(key=>{const values=query.getAll(key);return values.length!==1||!values[0].trim()||values[0].length>128;})){this.fileContextInvalid=true;return;}
    this.fileContext={family:query.get('file')!,version:query.get('version')!,check:query.get('check')!};
    const interacted=()=>{if(this.live())this.fileContextInteracted=true;};
    for(const name of ['pointerdown','keydown','input','wheel'])document.addEventListener(name,interacted,{capture:true,passive:true,signal:this.controller.signal});
  }
  private ordinaryFileView(){return !this.fileContext&&!this.fileContextInvalid;}
  private fileViewKey(){return JSON.stringify([this.owner,this.id]);}
  private fileViewSignature(){return JSON.stringify([this.folder,this.typeFilter??null,this.q,this.statusFilter]);}
  private ownFilesRoute(){try{const match=location.hash.match(/^#\/projects\/([^/?]+)\/files(?:\?|$)/);return !!match&&decodeURIComponent(match[1])===this.id;}catch{return false;}}
  private initializeFileView(query:URLSearchParams){
    if(this.fileViewInitialized)return;this.fileViewInitialized=true;
    if(!this.ordinaryFileView()){
      this.folder=query.get('folder')==='prospectus'||fileFolders.some(f=>f.id===query.get('folder'))?query.get('folder')!:'all';this.statusFilter='all';
      if(this.live()&&this.ownFilesRoute()&&query.has('file_status')){query.delete('file_status');const route='/projects/'+encodeURIComponent(this.id)+'/files'+(query.size?'?'+query:'');history.replaceState(null,'',location.pathname+location.search+'#'+route);this.routeChanged(route);}
      return;
    }
    const keys=['folder','type','q','file_status'] as const,explicit=keys.some(key=>query.has(key));
    const valid=keys.every(key=>{const values=query.getAll(key);if(!values.length)return true;if(values.length!==1||/[\u0000-\u001f\u007f]/.test(values[0]))return false;return key==='q'?values[0].length<=fileSearchLimit:key==='folder'?values[0]==='prospectus'||fileFolders.some(f=>f.id===values[0]):key==='file_status'?isFileStatusGroup(values[0]):PROJECT_DOCUMENT_CATALOG.some(d=>d.id===values[0]);});
    const saved=valid&&this.owner?projectFileViews.get(this.fileViewKey()):undefined;
    if(saved?.taskHistory){this.initialTaskHistory=structuredClone(saved.taskHistory);this.taskExpanded=saved.taskHistory.expanded;}
    if(explicit){
      if(valid){this.folder=query.get('folder')??'all';this.typeFilter=(query.get('type')??undefined) as ProjectDocumentType|undefined;this.q=query.get('q')??'';this.statusFilter=(query.get('file_status')??'all') as FileStatusGroup;if(this.typeFilter)this.folder=PROJECT_DOCUMENT_CATALOG.find(d=>d.id===this.typeFilter)!.folder;}
    }else if(saved){this.folder=saved.folder;this.typeFilter=saved.type;this.q=saved.q;this.statusFilter=saved.status;}
    if(saved&&JSON.stringify([saved.folder,saved.type??null,saved.q,saved.status])===this.fileViewSignature()){this.closedFileGroups=new Set(saved.closed);this.initialFileReading=saved.reading;this.fileViewRestorePending=!!saved.reading;this.taskHistoryRestorePending=!!this.initialTaskHistory?.reading;}
    else if(this.initialTaskHistory)this.initialTaskHistory.reading=undefined;
    if(this.taskHistoryRestorePending)this.fileViewRestorePending=false;
    this.initialFileViewSignature=this.fileViewSignature();this.initialFileInteraction=this.fileViewInteraction;
    const interacted=()=>{if(this.live()&&this.ownFilesRoute()&&!this.restoringFileReading)this.fileViewInteraction++;};
    for(const name of ['pointerdown','keydown','input','wheel','touchstart','focusin'])document.addEventListener(name,interacted,{capture:true,passive:true,signal:this.controller.signal});
    window.addEventListener('scroll',()=>{const y=scrollY;if(y===this.fileViewScrollY)return;this.fileViewScrollY=y;if(this.fileViewHost?.isConnected)interacted();},{passive:true,signal:this.controller.signal});
    this.writeFileViewUrl();
  }
  private writeFileViewUrl(){
    if(!this.ordinaryFileView()||!this.live()||!this.ownFilesRoute())return;
    const query=new URLSearchParams(location.hash.split('?')[1]);for(const key of ['folder','type','q','file_status'])query.delete(key);
    if(this.folder!=='all')query.set('folder',this.folder);if(this.typeFilter)query.set('type',this.typeFilter);if(this.q)query.set('q',this.q);if(this.statusFilter!=='all')query.set('file_status',this.statusFilter);
    const route='/projects/'+encodeURIComponent(this.id)+'/files'+(query.size?'?'+query:'');history.replaceState(null,'',location.pathname+location.search+'#'+route);this.routeChanged(route);
  }
  private captureFileGroups(){if(!this.ordinaryFileView())return;this.fileViewHost?.querySelectorAll<HTMLDetailsElement>('[data-file-tree]').forEach(node=>{if(node.open)this.closedFileGroups.delete(node.dataset.fileTree!);else this.closedFileGroups.add(node.dataset.fileTree!);});}
  private rememberFileView(){
    if(!this.owner||!this.fileViewInitialized||!this.ordinaryFileView())return;this.captureFileGroups();
    const taskReading=this.taskHistoryRestorePending&&this.fileViewInteraction===this.initialFileInteraction?this.initialTaskHistory?.reading:this.captureTaskHistory()?.reading;
    const reading=taskReading?undefined:this.captureFileReading()?.reading??(!this.filesLoaded&&this.fileViewSignature()===this.initialFileViewSignature?this.initialFileReading:undefined);
    const tail=this.tasks?this.tasks.items.at(-1):this.initialTaskHistory?.tail;
    const taskHistory:TaskHistoryView={expanded:this.taskExpanded,tail:tail?{run_id:tail.run_id,created_at:tail.created_at}:undefined,reading:taskReading};
    const key=this.fileViewKey();projectFileViews.delete(key);projectFileViews.set(key,{folder:this.folder,type:this.typeFilter,q:this.q,status:this.statusFilter,closed:[...this.closedFileGroups],reading,taskHistory});
    if(projectFileViews.size>50)projectFileViews.delete(projectFileViews.keys().next().value!);
  }
  private uniqueFileRow(key:string){
    if(!this.fileViewHost?.isConnected||this.files.filter(f=>f.latest&&f.file_key===key).length!==1)return;
    const rows=[...this.fileViewHost.querySelectorAll<HTMLElement>('#file-list [data-file-key]')].filter(row=>row.dataset.fileKey===key);return rows.length===1?rows[0]:undefined;
  }
  private fileActionKey(node:HTMLElement){
    if(!node.matches('a,button'))return;
    return JSON.stringify([node.tagName,...['href','data-file-edit-upload','data-file-history','data-file-download','data-version','data-revision'].map(name=>[name,node.getAttribute(name)])]);
  }
  private fileViewAsset(f:ProjectFile){return JSON.stringify([f.source,f.project_id,f.file_id,f.version,f.sha256,f.run_id,this.registered(f)?.version_id??null]);}
  private captureFileReading():FileViewSnapshot|undefined{
    if(!this.ordinaryFileView()||!this.filesLoaded||!this.fileViewHost?.isConnected||document.querySelector('dialog[open]'))return;
    const active=document.activeElement instanceof HTMLElement&&this.fileViewHost.contains(document.activeElement)?document.activeElement:undefined;
    const focus=active?.closest<HTMLElement>('[data-file-view-focus]'),activeRow=active?.closest<HTMLElement>('#file-list [data-file-key]');
    const visible=(row:HTMLElement)=>{const rect=row.getBoundingClientRect();return rect.height>0&&rect.bottom>0&&rect.top<innerHeight;};
    const row=activeRow&&visible(activeRow)?activeRow:[...this.fileViewHost.querySelectorAll<HTMLElement>('#file-list [data-file-key]')].find(visible);
    const fileKey=row?.dataset.fileKey,reading:FileViewReading={focus:focus?.dataset.fileViewFocus};
    if(fileKey&&this.uniqueFileRow(fileKey)===row){reading.fileKey=fileKey;reading.top=row.getBoundingClientRect().top;}
    const key=active&&this.fileActionKey(active),action=key&&activeRow?.dataset.fileKey&&activeRow.dataset.fileViewAsset?{fileKey:activeRow.dataset.fileKey,asset:activeRow.dataset.fileViewAsset,key}:undefined;
    return reading.fileKey||reading.focus?{reading,active,action}:undefined;
  }
  private canRestoreFileReading(){
    if(!this.ordinaryFileView()||!this.live()||!this.ownFilesRoute()||!this.filesLoaded||this.folderMedia.matches||this.hasUnconfirmed||document.querySelector('dialog[open], [data-resume-project-file], [data-resume-prospectus]')||document.querySelector<HTMLInputElement>('#prospectus-version-file')?.files?.length)return false;
    try{return !this.owner||!(this.imports().list().length||this.sourceProject&&new UploadRecovery(this.api,this.owner,this.sourceProject,'prospectus-version',()=>this.live()).list().length);}catch{return false;}
  }
  private restoreFileReading(snapshot:FileViewSnapshot|undefined){
    if(!snapshot||!this.canRestoreFileReading())return;const {reading}=snapshot,row=reading.fileKey?this.uniqueFileRow(reading.fileKey):undefined;
    this.restoringFileReading=true;
    try{
      if(row&&Number.isFinite(reading.top)){const delta=row.getBoundingClientRect().top-reading.top!;if(delta!==0)window.scrollBy(0,delta);}
      let focus=snapshot.active?.isConnected?snapshot.active:undefined;
      if(!focus&&snapshot.action){const target=this.uniqueFileRow(snapshot.action.fileKey);focus=target&&target.dataset.fileViewAsset===snapshot.action.asset?[...target.querySelectorAll<HTMLElement>('a,button')].find(node=>this.fileActionKey(node)===snapshot.action!.key)??target:target;}
      if(!focus&&reading.focus){if(reading.focus.startsWith('["row",')){const key=JSON.parse(reading.focus)[1];if(typeof key==='string')focus=this.uniqueFileRow(key);}else focus=[...this.fileViewHost!.querySelectorAll<HTMLElement>('[data-file-view-focus]')].find(node=>node.dataset.fileViewFocus===reading.focus);}
      if(!focus&&reading.focus?.startsWith('["row",'))focus=this.fileViewHost?.querySelector<HTMLElement>('#folder-title')??undefined;
      if(focus&&!focus.matches(':disabled')&&document.activeElement!==focus)focus.focus({preventScroll:true});
    }finally{this.fileViewScrollY=scrollY;this.restoringFileReading=false;}
  }
  private restoreInitialFileView(){
    if(!this.fileViewRestorePending)return;this.fileViewRestorePending=false;
    if(this.fileViewInteraction===this.initialFileInteraction&&this.fileViewSignature()===this.initialFileViewSignature&&this.initialFileReading)this.restoreFileReading({reading:this.initialFileReading});
  }
  async render(){
    const query=new URLSearchParams(location.hash.split('?')[1]);this.parseFileContext(query);this.initializeFileView(query);this.fileContextUiReady=false;
    this.shell('<p role="status">正在读取项目文件…</p>','projects');this.fileViewScrollY=scrollY;
    try{
      const [project]=await Promise.all([this.api.project(this.id,this.controller.signal),this.loadData()]);
      if(!this.live())return;this.name=project.name;
      this.shell(`<div class="project-workbench"><a class="back-link" href="#tasks">← 返回全部项目</a><div class="page-head"><div><div class="eyebrow">项目工作台</div><h1>${esc(project.name)}</h1><p>${esc(project.issuer_name??'发行人待填写')} · 募集书、项目文件与任务归在一起</p></div></div>
        <nav class="pw-actions" aria-label="本项目业务"><a class="btn secondary" href="${this.href('update',{from:'projects'})}">更新募集书</a><a class="btn secondary" href="${this.href('review',{from:'projects'})}">复核募集书</a><a class="btn secondary" href="${this.href('generate')}">生成文件</a><a class="btn secondary" href="${this.href('integrity')}">诚信核查</a><a class="btn secondary" href="${this.href('qa')}">项目问答</a></nav>
        <section class="pw-source" aria-labelledby="pw-source-heading"><div class="pw-section-title"><div><h2 id="pw-source-heading">当前募集说明书</h2><p>关联文件检查与生成以明确采用的募集书为依据。</p></div><span class="pw-saved">旧版本保留</span></div><div id="pw-current-source" role="status"></div><div id="pw-prospectus"><p>正在读取募集书版本…</p></div></section>
        <section class="pw-check" aria-labelledby="pw-check-heading"><div><h2 id="pw-check-heading">先检查，再决定更新哪些文件</h2><p id="pw-check-note"></p><small>检查免费。更新关联文件每份 4,500 积分，确认后执行，交付修订版和清洁版。</small></div><a class="btn primary" id="pw-check-link" href="${this.href('consistency')}">免费检查文件一致性</a></section>
        <section id="pw-task-summary" class="pw-tasks" aria-label="本项目最近任务"></section>
        <div class="pw-files-head"><div><h2>项目文件</h2><p>先查看已有文件，需要时再准备其他文件。</p></div><button class="btn secondary" id="import-project-file">上传关联文件</button></div><div id="pw-import-recovery" role="status"></div><div id="pw-import-result"></div><section id="pw-file-context" class="pw-file-context" aria-labelledby="pw-file-context-heading" hidden></section><p id="file-action-status" role="status"></p><div class="collection-file-workspace"><details class="pw-folder-picker" id="pw-folder-picker" ${this.folderMedia.matches?'':'open'}><summary><span>查看文件目录 / 筛选</span><small id="pw-folder-selection"></small></summary><nav id="file-folders" class="collection-folders" aria-label="项目文件目录"></nav></details><section class="collection-panel collection-file-panel"><header class="collection-heading"><h2 id="folder-title" tabindex="-1" data-file-view-focus="${esc(fileViewFocus('title'))}"></h2><div><span id="folder-count"></span><button class="text-button" id="refresh-files" data-file-view-focus="${esc(fileViewFocus('refresh'))}">刷新文件</button></div></header>
        <div class="collection-search">${ico('search')}<input id="file-search" type="search" maxlength="${fileSearchLimit}" data-file-view-focus="${esc(fileViewFocus('search'))}" aria-label="搜索项目文件" placeholder="搜索文件名称" value="${esc(this.q)}"/></div><div id="pw-file-status" class="collection-filters" role="group" aria-label="按处理状态筛选文件" aria-describedby="pw-file-status-note"></div><div id="pw-file-status-note" class="collection-muted" role="status"></div><div id="file-list"></div></section></div></div>`,'projects');
      this.fileViewHost=document.querySelector<HTMLElement>('.project-workbench')??undefined;
      const search=document.querySelector<HTMLInputElement>('#file-search')!,filter=()=>{this.q=search.value.slice(0,fileSearchLimit);this.writeFileViewUrl();this.paintFiles();this.rememberFileView();};
      search.addEventListener('compositionstart',()=>{this.searchComposing=true;});search.addEventListener('compositionend',()=>{this.searchComposing=false;filter();});search.addEventListener('input',event=>{if(!this.searchComposing&&!(event as InputEvent).isComposing)filter();});
      document.querySelector('#import-project-file')!.addEventListener('click',()=>this.importFile(this.typeFilter));
      this.folderMedia.removeEventListener('change',this.syncFolderLayout);this.folderMedia.addEventListener('change',this.syncFolderLayout);
      document.querySelector('#refresh-files')!.addEventListener('click',()=>void this.refresh());this.paint(false);this.paintSummary();this.paintImportRecovery();this.paintFileContext();this.fileViewScrollY=scrollY;if(!this.registryLoaded)this.status('文件检查状态暂未同步，已有文件仍可下载。');this.schedule();await this.syncPanel();if(this.live()){this.fileContextUiReady=true;this.maybeLocateFileContext();this.restoreInitialFileView();this.maybeRestoreTaskHistory();this.rememberFileView();}
    }catch(error){if(this.live()){this.shell(`<a class="back-link" href="#tasks">← 返回全部项目</a><div class="collection-empty"><h1>项目文件暂时无法打开</h1><p role="alert">${esc(friendlyError(error,'read'))}</p><button class="btn secondary" id="retry-files">重新读取</button></div>`,'projects');document.querySelector('#retry-files')!.addEventListener('click',()=>void this.render());}}
  }
  private async loadData(){
    const revision=++this.loadRevision;
    this.fileContextDataError=false;
    if(this.fileContext){
      this.fileContextRead='loading';this.paintFileContext();
      // Context is optional: checking its provenance must never delay file access.
      void this.api.request<{checks:ProjectFileCheck[]}>('GET','/projects/'+encodeURIComponent(this.id)+'/project-files/checks',undefined,{},AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)])).then(value=>{
        if(!this.live()||revision!==this.loadRevision)return;
        this.fileContextChecks=Array.isArray(value?.checks)?value.checks:[];this.fileContextRead=Array.isArray(value?.checks)?'ready':'failed';this.fileContextChecksRevision=revision;this.paintFileContext();this.maybeLocateFileContext();
      },()=>{if(this.live()&&revision===this.loadRevision){this.fileContextRead='failed';this.fileContextChecksRevision=revision;this.paintFileContext();}});
    }
    // Task summaries are optional: a slow or failed task read cannot hold file access.
    void this.loadProjectTasks(true);
    const [result,registry,workspace]=await Promise.all([
      this.api.projectFiles(this.id,this.controller.signal),
      this.readRegistry().then(value=>({value,error:false}),()=>({value:{files:[] as ProjectFileVersion[]},error:true})),
      this.api.request<Pick<ProjectFileWorkspace,'project_id'|'source'|'workspace'>>('GET','/projects/'+encodeURIComponent(this.id)+'/project-files/workspace',undefined,{},AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)])).then(value=>({value,error:false}),error=>({value:undefined,error:!(error instanceof ApiError&&error.status===404)}))
    ]).catch(error=>{if(this.live()&&revision===this.loadRevision){this.fileContextDataError=true;this.paintFileContext();}throw error;});
    if(!this.live()||revision!==this.loadRevision)return;
    this.files=result.items;this.filesLoaded=result.project_id===this.id;this.registry=registry.value.files;this.registryLoaded=!registry.error;
    this.source=workspace.value?.source;
    this.fileWorkspace=workspace.value?.project_id===this.id?workspace.value.workspace:undefined;
    // The collection root may retain an update workspace. Resolve its selected source
    // from read-only data; opening this page must never prepare a new workspace.
    const selected=this.files.filter(f=>f.current),childIds=[...new Set(selected.filter(f=>f.project_id!==this.id).map(f=>f.project_id))];
    this.sourceProject=workspace.value?(this.source?.project_id??this.id):(childIds.length===1?childIds[0]:childIds.length===0?selected[0]?.project_id:undefined);
    this.sourceNotice=workspace.error?'募集书来源暂未完整同步，请刷新后确认。':childIds.length>1&&!this.source?'当前存在多处募集书来源，请进入更新募集书确认本次使用的版本。':'';
    if(!this.sourceProject&&!this.sourceNotice)this.sourceProject=this.id;
    this.trackSource(this.source?this.source.project_id+':'+this.source.version_id:undefined);
    this.fileContextDataRevision=revision;this.paintFileContext();this.maybeLocateFileContext();
  }
  private resolvedFileContext(){
    const request=this.fileContext;
    if(!request||!this.registryLoaded||this.fileContextRead!=='ready'||this.fileContextChecksRevision!==this.loadRevision||this.fileContextDataRevision!==this.loadRevision||this.fileContextDataError)return;
    try{
      const checks=this.fileContextChecks.filter(c=>c.run_id===request.check);if(checks.length!==1||!Array.isArray(checks[0].files))return;
      const byVersion=checks[0].files.filter(f=>f.file_version_id===request.version),byFamily=checks[0].files.filter(f=>f.file_id===request.family);
      if(byVersion.length!==1||byFamily.length!==1||byVersion[0]!==byFamily[0])return;
      const originals=this.registry.filter(v=>v.version_id===request.version);if(originals.length!==1)return;const original=originals[0],checked=byVersion[0];
      if(original.file_id!==request.family||original.sequence!==checked.sequence||typeof original.filename!=='string'||!original.filename||original.filename!==checked.filename||!Number.isInteger(original.sequence)||original.sequence<1||this.registry.filter(v=>v.file_id===request.family&&v.sequence===original.sequence).length!==1)return;
      const latest=this.registry.filter(v=>v.file_id===request.family&&v.latest===true);if(latest.length!==1)return;const current=latest[0];
      const catalog=PROJECT_DOCUMENT_CATALOG.find(d=>d.id===current.document_type);
      if(!catalog||current.document_type!==original.document_type||typeof current.filename!=='string'||!current.filename||!Number.isInteger(current.sequence)||current.sequence<original.sequence||this.registry.filter(v=>v.version_id===current.version_id).length!==1||this.registry.filter(v=>v.file_id===request.family&&v.sequence===current.sequence).length!==1)return;
      const rows=this.files.filter(f=>f.latest===true&&f.file_key==='project-file:'+request.family);if(rows.length!==1)return;const row=rows[0];
      const matches=this.registry.filter(v=>this.matchesRegistered(row,v));
      if(matches.length!==1||matches[0]!==current||row.filename!==current.filename||!inFolder(row,catalog.folder)||this.files.filter(f=>this.matchesRegistered(f,current)).length!==1)return;
      return {request,original,current};
    }catch{return;}
  }
  private paintFileContext(){
    const host=document.querySelector<HTMLElement>('#pw-file-context');if(!host||!this.live())return;
    host.hidden=!this.fileContext&&!this.fileContextInvalid;if(host.hidden){host.innerHTML='';return;}
    const context=this.resolvedFileContext();
    document.querySelectorAll('#file-list [data-file-context-target]').forEach(row=>row.removeAttribute('data-file-context-target'));
    if(context&&context.current.version_id===this.fileContextTarget)for(const row of document.querySelectorAll<HTMLElement>('#file-list [data-file-family]'))if(row.dataset.fileFamily===context.request.family&&row.dataset.fileVersion===context.current.version_id)row.setAttribute('data-file-context-target','true');
    if(!context){
      const pending=!this.fileContextInvalid&&!this.fileContextDataError&&this.fileContextRead!=='failed'&&(this.fileContextRead==='loading'||this.fileContextDataRevision!==this.loadRevision);
      host.innerHTML='<h2 id="pw-file-context-heading">原检查中的文件</h2><p role="status">'+(pending?'正在核对原检查与文件版本。文件列表仍可继续使用。':this.fileContextInvalid?'原检查的文件定位信息不完整或无效。请从原检查重新打开；仍可继续浏览项目文件。':'暂时无法核实原检查与这份文件的对应关系。请刷新后重试，或从原检查重新打开；仍可继续浏览项目文件。')+'</p>';return;
    }
    const {request,original,current}=context,changed=original.version_id!==current.version_id;
    host.innerHTML='<h2 id="pw-file-context-heading">原检查中的文件</h2><dl><div><dt>检查时原文件</dt><dd>'+esc(original.filename)+' · V'+original.sequence+'</dd></div><div><dt>当前文件</dt><dd>'+esc(current.filename)+' · V'+current.sequence+'</dd></div></dl><p>'+(changed?'文件已从检查时 V'+original.sequence+' 换为当前 V'+current.sequence+'。原检查仍对应旧版，请先核对当前稿再修改。':'当前文件仍为检查时的 V'+original.sequence+'。可下载后修改，再上传此文件修改稿；原版本保留。')+'</p><div class="pw-file-context-actions"><button type="button" class="text-button" data-file-context-locate>定位这份文件</button><a class="text-button" href="'+esc(this.href('consistency',{run:request.check,file:request.family}))+'">返回原检查</a></div>';
    host.querySelector<HTMLButtonElement>('[data-file-context-locate]')!.addEventListener('click',()=>this.locateFileContext());
  }
  private maybeLocateFileContext(){
    if(!this.live()||!this.fileContextUiReady||!this.fileContextAutoPending||!this.resolvedFileContext())return;
    this.fileContextAutoPending=false;
    if(this.fileContextInteracted||this.hasUnconfirmed||document.querySelector('dialog[open], [data-resume-project-file], [data-resume-prospectus]')||document.querySelector<HTMLInputElement>('#prospectus-version-file')?.files?.length)return;
    try{if(this.owner&&(this.imports().list().length||this.sourceProject&&new UploadRecovery(this.api,this.owner,this.sourceProject,'prospectus-version',()=>this.live()).list().length))return;}catch{return;}
    const active=document.activeElement;if(active instanceof HTMLElement&&active!==document.body&&active.closest('.project-workbench'))return;
    this.locateFileContext();
  }
  private locateFileContext(){
    this.fileContextAutoPending=false;const context=this.resolvedFileContext();if(!context){this.paintFileContext();return;}
    if(this.hasUnconfirmed||document.querySelector('dialog[open]')){this.status('请先确认当前上传或保存结果，再定位文件。');return;}
    this.folder=PROJECT_DOCUMENT_CATALOG.find(d=>d.id===context.current.document_type)!.folder;this.q='';this.typeFilter=context.current.document_type;this.statusFilter='all';this.fileContextTarget=context.current.version_id;
    const search=document.querySelector<HTMLInputElement>('#file-search');if(search)search.value='';this.paint();
    const rows=Array.from(document.querySelectorAll<HTMLElement>('#file-list [data-file-family]')).filter(row=>row.dataset.fileFamily===context.request.family&&row.dataset.fileVersion===context.current.version_id);
    if(rows.length!==1){this.status('当前文件行暂未定位，请刷新后重试。');return;}
    rows[0].focus({preventScroll:true});document.querySelector('#pw-file-context')!.scrollIntoView({block:'start'});
  }
  private trackSource(key:string|undefined){if(key&&this.sourceKey&&key!==this.sourceKey)this.sourceChanged=true;if(key)this.sourceKey=key;}
  private async syncPanel(replace=false){
    if(!this.live())return;const host=document.querySelector<HTMLElement>('#pw-prospectus');if(!host)return;
    const id=this.sourceProject;
    if(!id){this.panel?.dispose();this.panel=undefined;host.innerHTML='<p>请先确认当前募集书来源，再管理版本。</p>';return;}
    if(replace){this.panel?.dispose();this.panel=undefined;}
    if(!this.panel){
      const panel=new ProspectusPanel(this.api,id,host,async()=>!this.uploading&&!this.pendingImport?.uncertain,async()=>{
        this.sourceChanged=true;await this.refresh(true);
      },()=>{if(this.live())this.paintSummary();},'update',this.owner);this.panel=panel;
    }
    const panel=this.panel;
    try{await panel.refresh();if(!this.live()||this.panel!==panel)return;
      const state=panel.state;this.trackSource(state?.current_version_id?id+':'+state.current_version_id:undefined);this.paintSummary();
    }catch{if(this.live()&&this.panel===panel){host.innerHTML='<p class="collection-error">募集书版本暂未读取，已有项目文件仍可查看和下载。</p><button class="text-button" id="pw-retry-source">重新读取募集书</button>';host.querySelector('#pw-retry-source')!.addEventListener('click',()=>void this.syncPanel(true));}}
  }
  private uniqueTaskRow(runId:string){
    if(!this.fileViewHost?.isConnected||this.tasks?.items.filter(t=>t.run_id===runId).length!==1)return;
    const rows=[...this.fileViewHost.querySelectorAll<HTMLElement>('[data-pw-task-run]')].filter(row=>row.dataset.pwTaskRun===runId);return rows.length===1?rows[0]:undefined;
  }
  private captureTaskHistory():TaskHistorySnapshot|undefined{
    if(!this.ordinaryFileView()||!this.fileViewHost?.isConnected||document.querySelector('dialog[open]'))return;
    const host=this.fileViewHost.querySelector<HTMLElement>('#pw-task-summary');if(!host)return;
    const active=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    const visible=(node:HTMLElement)=>{const rect=node.getBoundingClientRect();return rect.height>0&&rect.bottom>0&&rect.top<innerHeight;};
    if(active&&active!==document.body&&!host.contains(active)&&visible(active))return;
    const activeRow=active?.closest<HTMLElement>('[data-pw-task-run]');
    const row=activeRow&&host.contains(activeRow)?activeRow:!host.contains(active??document.body)&&[...this.fileViewHost.querySelectorAll<HTMLElement>('#file-list [data-file-key]')].some(visible)?undefined:[...host.querySelectorAll<HTMLElement>('[data-pw-task-run]')].find(visible);
    const reading=row&&this.uniqueTaskRow(row.dataset.pwTaskRun!)===row?{runId:row.dataset.pwTaskRun!,top:row.getBoundingClientRect().top}:undefined;
    let focus:TaskHistorySnapshot['focus'];
    if(active&&host.contains(active)){
      if(activeRow)focus={kind:active.matches('a')?'link':'row',runId:activeRow.dataset.pwTaskRun,href:active.matches('a')?active.getAttribute('href')??undefined:undefined};
      else if(active.matches('[data-pw-task-history-toggle]'))focus={kind:'toggle'};
      else if(active.matches('[data-pw-task-more]'))focus={kind:'more'};
      else if(active.matches('[data-pw-task-retry]'))focus={kind:'retry'};
      else if(active.id==='pw-task-history-heading')focus={kind:'heading'};
    }
    return reading||focus?{reading,focus}:undefined;
  }
  private restoreTaskHistory(snapshot:TaskHistorySnapshot|undefined){
    if(!snapshot||!this.canRestoreFileReading())return;
    const host=this.fileViewHost!.querySelector<HTMLElement>('#pw-task-summary');if(!host)return;
    const row=snapshot.reading?this.uniqueTaskRow(snapshot.reading.runId):undefined,heading=host.querySelector<HTMLElement>('#pw-task-history-heading');
    this.restoringFileReading=true;
    try{
      if(row&&Number.isFinite(snapshot.reading?.top)){const delta=row.getBoundingClientRect().top-snapshot.reading!.top;if(delta!==0)window.scrollBy(0,delta);}
      else if(snapshot.reading&&snapshot.focus)heading?.scrollIntoView({block:'start'});
      let target:HTMLElement|undefined;
      const focus=snapshot.focus;
      if(focus?.kind==='row'||focus?.kind==='link'){
        const exact=focus.runId?this.uniqueTaskRow(focus.runId):undefined;
        target=focus.kind==='link'&&exact?[...exact.querySelectorAll<HTMLAnchorElement>('a')].find(a=>a.getAttribute('href')===focus.href)??exact:exact;
      }else if(focus){const selector={heading:'#pw-task-history-heading',toggle:'[data-pw-task-history-toggle]',more:'[data-pw-task-more]',retry:'[data-pw-task-retry]'}[focus.kind];target=host.querySelector<HTMLElement>(selector)??undefined;}
      if(focus){target??=heading??undefined;if(target&&!target.matches(':disabled')&&document.activeElement!==target)target.focus({preventScroll:true});}
    }finally{this.fileViewScrollY=scrollY;this.restoringFileReading=false;}
  }
  private maybeRestoreTaskHistory(){
    if(!this.taskHistoryRestorePending)return;
    if(this.fileViewInteraction!==this.initialFileInteraction){this.taskHistoryRestorePending=false;return;}
    if(!this.taskHistoryLoaded||!this.fileContextUiReady)return;
    this.taskHistoryRestorePending=false;
    if(this.initialTaskHistory?.reading)this.restoreTaskHistory({reading:this.initialTaskHistory.reading,focus:{kind:'row',runId:this.initialTaskHistory.reading.runId}});
  }
  private async loadProjectTasks(reset:boolean){
    if(!this.live())return;
    if(this.taskRead){if(reset)this.taskRefreshQueued=true;return this.taskRead;}
    if(!reset&&!this.tasks?.page.has_more)return;
    const promise=(async()=>{let refresh=reset;do{this.taskRefreshQueued=false;await this.readProjectTasks(refresh);refresh=true;}while(this.taskRefreshQueued&&this.live());})();
    this.taskRead=promise;
    try{await promise;}finally{if(this.taskRead===promise)this.taskRead=undefined;}
  }
  private async readProjectTasks(reset:boolean){
    const existing=this.tasks,cursor=!reset?existing?.page.next_cursor:undefined;
    if(!reset&&!cursor)return;
    this.tasksLoading=true;this.taskPaging=!reset;this.taskError=false;this.paintTaskHistory();
    const consumed=new Set<string>();
    try{
      if(!reset&&this.taskCursors.has(cursor!))throw new UserFacingError('任务分页位置已变化，请刷新任务后重试。');
      const data=await refreshProjectTasks(this.id,reset?existing:undefined,next=>{
        const requested=reset?next:cursor!;if(requested)consumed.add(requested);
        return this.api.projectTasks(this.id,requested,AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)]));
      },()=>!this.live(),reset&&!existing?this.initialTaskHistory?.tail:undefined);
      if(!data||!this.live())return;
      const nextCursors=reset?consumed:new Set([...this.taskCursors,...consumed]);
      if(data.page.next_cursor&&nextCursors.has(data.page.next_cursor))throw new UserFacingError('任务分页位置未前进，请刷新任务后重试。');
      if(!reset&&existing){
        const seen=new Map(existing.items.map(task=>[task.run_id,task]));let lastTime=existing.items.length?Date.parse(existing.items.at(-1)!.created_at):Infinity;
        for(const task of data.items){
          const prior=seen.get(task.run_id),time=Date.parse(task.created_at);
          if(prior){if(prior.project_id!==task.project_id||Date.parse(prior.created_at)!==time)throw new UserFacingError('任务身份发生变化，请刷新任务后重试。');throw new UserFacingError('任务分页出现重复记录，请重试同步。');}
          if(time>lastTime)throw new UserFacingError('任务分页顺序发生变化，请重试同步。');
          seen.set(task.run_id,task);lastTime=time;
        }
        this.tasks={...data,items:[...existing.items,...data.items]};
      }else this.tasks=data;
      this.taskCursors=nextCursors;this.taskHistoryLoaded=true;this.taskError=false;
    }catch{if(this.live()){this.taskError=true;this.taskRetryReset=reset;}}
    finally{this.tasksLoading=false;this.taskPaging=false;if(this.live()){this.paintTaskHistory();this.maybeRestoreTaskHistory();if(this.fileViewHost?.isConnected)this.rememberFileView();}}
  }
  private paintTaskHistory(){
    const host=document.querySelector<HTMLElement>('#pw-task-summary');if(!host)return;
    if(this.taskHistoryRestorePending&&this.fileViewInteraction!==this.initialFileInteraction)this.taskHistoryRestorePending=false;
    const taskReading=this.taskHistoryRestorePending?undefined:this.captureTaskHistory(),fileReading=this.taskHistoryRestorePending||taskReading?undefined:this.captureFileReading();
    const all=this.tasks?.items??[],tasks=this.taskExpanded?all:all.slice(0,3),canExpand=all.length>3||!!this.tasks?.page.has_more;
    host.setAttribute('aria-label','本项目任务历史');
    if(!all.length&&!this.tasksLoading&&!this.taskError&&!this.taskExpanded&&!this.initialTaskHistory?.reading){host.innerHTML='';return;}
    host.innerHTML='<h2 id="pw-task-history-heading" tabindex="-1">'+(this.taskExpanded?'本项目任务历史':'最近任务')+'</h2>'+
      (this.tasksLoading?'<p class="pw-task-note" role="status">'+(this.taskPaging?'正在读取更早任务，已加载任务保持可读。':'正在同步最近任务，已加载任务保持可读。')+'</p>':'')+
      (this.taskError?'<p class="pw-task-note" role="status">最近任务暂未同步。'+(this.tasks?'已加载任务保持可读。':'项目文件仍可查看和下载。')+' <button type="button" class="text-button" data-pw-task-retry>重试同步任务</button></p>':'')+
      tasks.map(t=>{const v=taskView(t),href=taskHref(t)+(taskHref(t).includes('?')?'&':'?')+'return_project='+encodeURIComponent(this.id);return '<article tabindex="-1" data-pw-task-run="'+esc(t.run_id)+'"><div><strong>'+esc(taskLabel(t))+'</strong><small>'+esc(date(t.created_at))+'</small></div><div><span class="collection-state '+v.tone+'">'+esc(v.label??t.state)+'</span><small>'+esc(v.detail??'请打开任务查看状态')+'</small></div><a class="text-button" href="'+esc(href)+'">'+esc(v.action)+'</a></article>';}).join('')+
      (!tasks.length&&!this.tasksLoading&&!this.taskError?'<p class="pw-task-note">本项目尚无任务记录。</p>':'')+
      (canExpand||this.taskExpanded?'<button type="button" class="text-button" data-pw-task-history-toggle aria-expanded="'+this.taskExpanded+'">'+(this.taskExpanded?'收起任务历史':'查看本项目全部任务')+'</button>':'')+
      (this.taskExpanded&&this.tasks?.page.has_more?' <button type="button" class="text-button" data-pw-task-more aria-disabled="'+this.tasksLoading+'">加载更早任务</button>':'');
    host.querySelector('[data-pw-task-history-toggle]')?.addEventListener('click',()=>{this.taskExpanded=!this.taskExpanded;this.paintTaskHistory();this.rememberFileView();});
    host.querySelector('[data-pw-task-more]')?.addEventListener('click',()=>{if(!this.tasksLoading)void this.loadProjectTasks(false);});
    host.querySelector('[data-pw-task-retry]')?.addEventListener('click',()=>{if(!this.tasksLoading)void this.loadProjectTasks(this.taskRetryReset);});
    if(taskReading)this.restoreTaskHistory(taskReading);else this.restoreFileReading(fileReading);
    this.maybeRestoreTaskHistory();
  }
  private paintSummary(){
    const source=document.querySelector('#pw-current-source');if(!source)return;
    const version=this.panel?.state?.versions.find(v=>v.version_id===this.panel!.state!.current_version_id);
    const file=this.files.find(f=>f.current&&f.project_id===this.sourceProject);
    source.innerHTML=this.sourceNotice?'<p class="collection-error">'+esc(this.sourceNotice)+'</p>':version?'<strong>已采用 V'+version.sequence+' · '+esc(version.filename)+'</strong>':this.source?'<strong>已采用 V'+this.source.sequence+' · '+esc(this.source.filename)+'</strong>':file?'<strong>当前募集书 · '+esc(file.filename)+'</strong>':'<p>尚未采用募集书。可保存新稿，再明确采用为当前版本。</p>';
    document.querySelector('#pw-check-note')!.textContent=this.sourceChanged||this.registry.some(v=>v.latest&&v.consistency.status==='stale')?'当前募集书或文件版本已变化。请先免费检查，再查看哪些文件需要更新。':'检查已有文件与当前募集书的内容差异；查看结果后，由你选择是否更新。';
    this.paintTaskHistory();
  }
  private schedule(){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(this.live()&&document.visibilityState==='visible')void this.refresh();else if(this.live())this.schedule();},30000);}
  private async refresh(adopted=false){
    if(!this.live())return;this.fileContextAutoPending=false;if(this.refreshing){if(adopted)this.pendingAdoption=true;return;}if(!adopted&&this.hasUnconfirmed){this.schedule();return;}this.refreshing=true;
    let taskReading=this.captureTaskHistory(),reading=taskReading?undefined:this.captureFileReading(),interaction=this.fileViewInteraction;
    const button=document.querySelector<HTMLButtonElement>('#refresh-files')!;button.disabled=true;
    try{const previous=this.sourceProject;await this.loadData();if(this.live()){
      taskReading=this.captureTaskHistory();const latest=taskReading?undefined:this.captureFileReading();
      if(taskReading)reading=undefined;
      else if(interaction===this.fileViewInteraction&&reading?.reading.focus&&!latest?.reading.focus)reading=latest?{...latest,active:reading.active,action:reading.action,reading:{...latest.reading,focus:reading.reading.focus}}:reading;
      else reading=latest;
      interaction=this.fileViewInteraction;this.paint(false);this.paintSummary();this.paintSavedImport();this.status(this.savedImport?this.savedImportMessage():this.registryLoaded?'':'文件检查状态暂未同步，已有文件仍可下载。');this.fileViewScrollY=scrollY;await this.syncPanel(adopted||previous!==this.sourceProject);
    }}
    catch(error){if(this.live()){this.paintSavedImport(true);this.status(this.savedImport?'文件已保存，列表暂未同步。请刷新文件查看新版本。':'刷新未成功，当前显示上次同步结果。'+friendlyError(error,'read'));}}
    finally{this.refreshing=false;if(this.live()){button.disabled=false;if(interaction===this.fileViewInteraction){if(taskReading)this.restoreTaskHistory(taskReading);else this.restoreFileReading(reading);}this.rememberFileView();if(this.pendingAdoption){this.pendingAdoption=false;void this.refresh(true);}else this.schedule();}}
  }
  private paint(preserve=true){
    const reading=preserve?this.captureFileReading():undefined;this.captureFileGroups();
    const nav=document.querySelector('#file-folders')!;
    const node=(id:string,name:string)=>'<button data-folder="'+id+'" data-file-view-focus="'+esc(fileViewFocus('folder',id))+'" '+(id===this.folder&&!this.typeFilter?'aria-current="page"':'')+'>'+ico('folder')+'<span>'+name+'</span><small>'+this.files.filter(x=>x.latest&&inFolder(x,id)).length+'</small></button>';
    const leaves=(folder:string)=>PROJECT_DOCUMENT_CATALOG.filter(d=>d.folder===folder).map(d=>'<button class="pf-tree-file" data-file-type="'+d.id+'" data-file-view-focus="'+esc(fileViewFocus('type',d.id))+'" '+(this.typeFilter===d.id?'aria-current="page"':'')+'><span>'+d.code+'</span>'+d.name+'</button>').join('');
    nav.innerHTML=fileFolders.filter(f=>!f.parent).map(f=>{
      if(['all','sources'].includes(f.id))return node(f.id,f.name);
      const children=fileFolders.filter(c=>c.parent===f.id);
      return '<details data-file-tree="'+f.id+'" '+(!this.ordinaryFileView()||!this.closedFileGroups.has(f.id)?'open':'')+'><summary data-file-view-focus="'+esc(fileViewFocus('tree',f.id))+'">'+f.name+'</summary>'+(f.id==='2'?node('prospectus','2.1 募集说明书'):'')+leaves(f.id)+children.map(c=>node(c.id,c.name)+leaves(c.id)).join('')+'</details>';
    }).join('');
    nav.querySelectorAll<HTMLDetailsElement>('[data-file-tree]').forEach(node=>node.addEventListener('toggle',()=>{if(node.isConnected&&this.live()&&this.ordinaryFileView()){this.captureFileGroups();this.rememberFileView();}}));
    nav.querySelectorAll<HTMLButtonElement>('[data-folder]').forEach(b=>b.addEventListener('click',()=>{this.folder=b.dataset.folder!;this.typeFilter=undefined;if(this.ordinaryFileView())this.writeFileViewUrl();else if(this.live()&&this.ownFilesRoute()){const query=new URLSearchParams(location.hash.split('?')[1]);query.set('folder',this.folder);const route='/projects/'+encodeURIComponent(this.id)+'/files?'+query;history.replaceState(null,'',location.pathname+location.search+'#'+route);this.routeChanged(route);}this.paint();this.finishFolderSelection();this.rememberFileView();}));
    nav.querySelectorAll<HTMLButtonElement>('[data-file-type]').forEach(b=>b.addEventListener('click',()=>{this.typeFilter=b.dataset.fileType as ProjectDocumentType;this.folder=PROJECT_DOCUMENT_CATALOG.find(d=>d.id===this.typeFilter)!.folder;this.writeFileViewUrl();this.paint();this.finishFolderSelection();this.rememberFileView();}));
    this.paintFiles(false);this.paintFileContext();this.restoreFileReading(reading);
  }
  private finishFolderSelection(){
    if(!this.folderMedia.matches)return;
    const picker=document.querySelector<HTMLDetailsElement>('#pw-folder-picker');if(picker)picker.open=false;
    const title=document.querySelector<HTMLElement>('#folder-title');if(title){title.focus({preventScroll:true});title.scrollIntoView({block:'start'});}
  }
  private readRegistry(){return this.api.request<{files:ProjectFileVersion[]}>('GET','/projects/'+encodeURIComponent(this.id)+'/project-files',undefined,{},AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)]));}
  private matchesRegistered(f:ProjectFile,v:ProjectFileVersion){return matchesProjectFileVersion(f,v);}
  private registered(f:ProjectFile){return resolveProjectFileVersion(f,this.registry);}
  private continuationHref(v:ProjectFileVersion){
    const w=this.fileWorkspace;if(v.asset.kind!=='artifact'||!v.run_id||!w?.topic||w.topic.surface==='assistant'||w.project?.project_id!==w.topic.project_id||!Array.isArray(w.tasks)||!Array.isArray(w.artifacts)||w.drafts?.[v.document_type]?.project_file?.project_id!==this.id)return;
    const task=w.tasks.find(t=>t.run.run_id===v.run_id);if(!task||task.run.state!=='succeeded'||task.run.project_id!==w.topic.project_id||task.manifest.kind!=='document'||task.manifest.topic_id!==w.topic.topic_id||task.manifest.input.document_type!==v.document_type)return;
    const a=task.artifacts.find(a=>a.kind==='document'),pin=v.asset.pin;
    if(!a||a.topic_id!==w.topic.topic_id||a.run_id!==v.run_id||a.document_type!==v.document_type||a.source_project_id!==w.topic.project_id||a.source_project_id!==pin.source_project_id||a.artifact_id!==pin.artifact_id||a.artifact_version!==pin.artifact_version||a.sha256!==pin.sha256||!w.artifacts.some(item=>item.kind==='document'&&item.run_id===a.run_id&&item.artifact_id===a.artifact_id&&item.artifact_version===a.artifact_version&&item.sha256===a.sha256&&item.source_project_id===a.source_project_id&&item.topic_id===a.topic_id&&item.document_type===a.document_type))return;
    return '#generate?'+withProjectContext(new URLSearchParams({topic:w.topic.topic_id,run:v.run_id,return_project:this.id}));
  }
  private fileEditActions(f:ProjectFile,v?:ProjectFileVersion){
    if(!v?.latest)return f.file_key.startsWith('project-file:')?'<small class="pw-file-note">文件版本暂未核对，请刷新后再修改。</small>':'';
    const href=this.continuationHref(v);
    return (href?'<a class="text-button" href="'+esc(href)+'">打开此稿继续修改</a>':'<small class="pw-file-note">此稿暂不能直接接续，可上传修改稿。</small>')+'<button class="text-button" data-file-edit-upload="'+esc(v.version_id)+'">上传此文件修改稿</button>';
  }
  private savedImportVersion(){const s=this.savedImport;if(!s||!this.registryLoaded)return;const matches=this.registry.filter(v=>v.document_type===s.type&&(!s.fileId||v.file_id===s.fileId)&&(!s.previous||v.sequence>s.previous)&&v.asset.kind==='material'&&v.asset.pin.source_project_id===s.pin.source_project_id&&v.asset.pin.material_id===s.pin.material_id&&v.asset.pin.material_version===s.pin.material_version&&v.asset.pin.sha256===s.pin.sha256);return matches.length===1?matches[0]:undefined;}
  private savedImportMessage(){
    const s=this.savedImport;if(!s)return '';const v=this.savedImportVersion(),row=v&&this.files.find(f=>this.registered(f)?.version_id===v.version_id);
    if(!v||!row)return '文件已保存，列表暂未同步。请刷新文件查看新版本。';
    return (s.previous?'修改稿已保存为 V'+v.sequence+'，原 V'+s.previous+' 保留。':'项目文件已保存为 V'+v.sequence+'，旧版本保留。')+(!v.latest?'当前文件已有后续版本。':'')+'可免费检查全部项目文件与当前募集书的一致性。';
  }
  private paintSavedImport(readFailed=false){
    const host=document.querySelector('#pw-import-result');if(!host)return;const s=this.savedImport;if(!s){host.innerHTML='';return;}
    const v=this.savedImportVersion(),available=v&&this.files.some(f=>this.registered(f)?.version_id===v.version_id);
    host.innerHTML='<section class="pw-import-result" aria-label="项目文件保存结果" tabindex="-1"><p>'+esc(readFailed?'文件已保存，列表暂未同步。请刷新文件查看新版本。':this.savedImportMessage())+'</p><div>'+(available?'<button class="text-button" data-saved-history="'+esc('project-file:'+v.file_id)+'">查看新旧版本</button>':'')+'<a class="text-button" href="'+esc(this.href('consistency'))+'">免费检查全部项目文件</a></div><small>检查本项目全部当前文件；保存修改稿不会自动检查或更新。</small></section>';
    host.querySelector<HTMLButtonElement>('[data-saved-history]')?.addEventListener('click',()=>this.history('project-file:'+v!.file_id));
  }
  private badge(row:ProjectFileStatusRow){
    const v=row.version;if(!v)return row.group==='unsynced'?'<span class="pf-chip attention">状态待同步</span>':'';
    const labels:Record<ProjectFileVersion['consistency']['status'],string>={unchecked:'待检查',checking:'正在检查',conflict:'发现差异 · '+v.consistency.count+' 处',manual:'需人工确认',consistent:'本轮未发现差异',stale:'版本已变化 · 请重查',updated:'已生成新版本 · 建议复查'};
    const action=v.consistency.status==='conflict'?'查看差异 / 更新':v.consistency.status==='manual'?'查看需确认事项':v.consistency.status==='checking'?'查看检查进度':undefined;
    return '<span class="pf-chip '+(['conflict','manual','stale'].includes(v.consistency.status)?'attention':'')+'">'+labels[v.consistency.status]+'</span>'+(action?(v.consistency.check_run_id?'<a class="text-button" href="'+esc(this.href('consistency',{run:v.consistency.check_run_id,file:v.file_id}))+'">'+action+'</a>':'<small class="pw-file-note">原检查暂未同步，请刷新后核对。</small>'):'');
  }
  private chooseFileStatus(group:FileStatusGroup,clearType=false){
    this.statusFilter=group;if(clearType)this.typeFilter=undefined;this.writeFileViewUrl();
    if(clearType)this.paint(false);else this.paintFiles(false);this.rememberFileView();
    if(!document.querySelector('dialog[open]'))document.querySelector<HTMLElement>('#pw-file-status [data-file-status="'+group+'"]')?.focus({preventScroll:true});
  }
  private paintFileStatus(rows:ProjectFileStatusRow[],untyped:ProjectFileStatusRow[]){
    const counts=new Map(fileStatusOptions.map(option=>[option.key,option.key==='all'?rows.length:rows.filter(row=>row.group===option.key).length]));
    const host=document.querySelector('#pw-file-status')!;
    host.innerHTML='<div>'+fileStatusOptions.map(option=>'<button type="button" class="collection-filter" data-file-status="'+option.key+'" data-file-view-focus="'+esc(fileViewFocus('status',option.key))+'" aria-pressed="'+(this.statusFilter===option.key)+'">'+option.label+' <span data-file-status-count>'+(!this.registryLoaded&&option.key!=='all'?'—':counts.get(option.key))+'</span></button>').join('')+'</div>';
    host.querySelectorAll<HTMLButtonElement>('[data-file-status]').forEach(button=>button.addEventListener('click',()=>{const group=button.dataset.fileStatus;if(group&&isFileStatusGroup(group))this.chooseFileStatus(group);}));
    const unsynced=untyped.filter(row=>row.group==='unsynced').length;
    let note:string;
    if(!this.registryLoaded)note='文件检查状态暂未同步，当前按目录和名称显示全部匹配文件。'+(this.typeFilter?'所选文种和处理状态':'所选处理状态')+'将在刷新成功后恢复。';
    else {
      const descriptions:Record<FileStatusGroup,string>={
        all:'按本次同步结果归类；目录、文种和名称筛选同时生效。',
        check:'包括尚无当前有效检查、版本已变化和已生成新版本的关联文件。生成新稿不代表复查完成。',
        review:'发现差异与需人工确认的文件均在此组；一份文件可能两者都有，请进入原检查逐项核实。',
        checking:'文件一致性检查正在进行，尚无本轮结论。',
        consistent:'仅表示本轮已核对内容未发现差异，不代表全文一致或人工事项全部解决。',
        unsynced:'这些关联文件的当前版本与检查状态尚未准确同步，已有文件仍可下载，请刷新后核实。',
        other:'募集书、原始材料及其他项目成果不按关联文件检查状态归类。'
      };
      note=descriptions[this.statusFilter];
      if(this.statusFilter==='check')note+=' <a class="text-button" href="'+esc(this.href('consistency'))+'">免费检查全部当前关联文件</a>。检查范围为本项目全部当前关联文件，当前筛选只影响显示。';
      if(unsynced&&(this.statusFilter!=='unsynced'||this.typeFilter))note+='<br>'+ (this.typeFilter?'当前目录和名称范围内另有 '+unsynced+' 份关联文件的类型与状态待同步，未纳入当前文种筛选。':'其中 '+unsynced+' 份关联文件状态待同步，未归入差异、检查中或未发现差异等业务分组。')+' <button type="button" class="text-button" data-show-unsynced data-file-view-focus="'+esc(fileViewFocus('status-unsynced'))+'">查看状态待同步文件</button>';
    }
    if(!this.registryLoaded||unsynced)note+=' <button type="button" class="text-button" data-status-refresh data-file-view-focus="'+esc(fileViewFocus('status-refresh'))+'">刷新文件状态</button>';
    document.querySelector('#pw-file-status-note')!.innerHTML=note;
    document.querySelector<HTMLButtonElement>('[data-show-unsynced]')?.addEventListener('click',()=>this.chooseFileStatus('unsynced',!!this.typeFilter));
    document.querySelector<HTMLButtonElement>('[data-status-refresh]')?.addEventListener('click',()=>void this.refresh());
  }
  private paintFiles(preserve=true){
    const reading=preserve?this.captureFileReading():undefined;
    const rows=projectFileStatusRows(this.files,this.registry,this.registryLoaded);
    const untyped=rows.filter(({file})=>inFolder(file,this.folder)&&file.filename.toLocaleLowerCase().includes(this.q.trim().toLocaleLowerCase()));
    // An unreadable registry cannot establish the selected type either. Keep the
    // choice for retry, but expose directory/name matches for existing downloads.
    const scoped=untyped.filter(row=>!this.registryLoaded||!this.typeFilter||row.version?.document_type===this.typeFilter);
    const visible=!this.registryLoaded||this.statusFilter==='all'?scoped:scoped.filter(row=>row.group===this.statusFilter);
    document.querySelector('#folder-title')!.textContent=this.typeFilter?PROJECT_DOCUMENT_CATALOG.find(d=>d.id===this.typeFilter)!.name:this.folder==='prospectus'?'募集说明书':fileFolders.find(f=>f.id===this.folder)!.name;
    document.querySelector('#pw-folder-selection')!.textContent=document.querySelector('#folder-title')!.textContent;
    document.querySelector('#folder-count')!.textContent=visible.length+' 份已有文件'+(this.registryLoaded&&this.statusFilter!=='all'?' / 当前范围 '+scoped.length+' 份':'');
    this.paintFileStatus(scoped,untyped);
    document.querySelector('#file-list')!.innerHTML=visible.length?visible.map(row=>{
      const f=row.file,v=row.version;
      return '<article class="collection-file" tabindex="-1" data-file-key="'+esc(f.file_key)+'" data-file-view-focus="'+esc(fileViewFocus('row',f.file_key))+'" data-file-view-asset="'+esc(this.fileViewAsset(f))+'" data-file-status-group="'+row.group+'" data-file-version="'+esc(v?.version_id??'')+'"'+(v?' data-file-family="'+esc(v.file_id)+'"':'')+(this.fileContextTarget&&v?.version_id===this.fileContextTarget?' data-file-context-target="true"':'')+'><span class="collection-file-icon">'+ico('file')+'</span><div class="collection-file-info"><strong>'+esc(f.filename)+'</strong><small>'+(f.source==='material'?'已上传文件':'生成成果')+' · V'+f.display_version+' · '+esc(date(f.created_at))+(f.current?' · 当前募集书':'')+'</small></div>'+this.badge(row)+'<div class="pw-file-actions">'+this.fileEditActions(f,v)+'<button class="text-button" data-file-history="'+esc(f.file_key)+'">版本记录 ('+f.version_count+')</button>'+(v?.revision_asset?'<button class="btn secondary small" data-file-download="'+esc(f.file_id)+'" data-version="'+f.version+'" data-revision>下载修订版</button>':'')+'<button class="btn secondary small" data-file-download="'+esc(f.file_id)+'" data-version="'+f.version+'">'+ico('download')+(v?.revision_asset?'下载清洁版':'下载')+'</button></div></article>';
    }).join(''):'<div class="collection-empty"><h3>'+ (this.statusFilter!=='all'||this.q||this.typeFilter?'没有符合当前筛选的文件':'此目录尚无文件')+'</h3><p>'+(this.statusFilter!=='all'?'已有文件可能在其他分组，或尚待同步。':'已有文件会在上传或相关任务完成后显示。')+'</p>'+(this.statusFilter!=='all'?'<button type="button" class="text-button" data-clear-file-status>清除状态筛选</button>':'')+'</div>';
    const catalog=this.statusFilter==='all'&&this.registryLoaded?PROJECT_DOCUMENT_CATALOG.filter(d=>(!this.typeFilter||d.id===this.typeFilter)&&(this.folder==='all'||d.folder===this.folder||d.folder.startsWith(this.folder+'.'))&&!this.registry.some(v=>v.latest&&v.document_type===d.id)&&d.name.includes(this.q.trim())):[];
    if(catalog.length)document.querySelector('#file-list')!.insertAdjacentHTML('beforeend','<details class="pw-prepare"><summary>准备其他文件 <span>'+catalog.length+' 类</span></summary><p>首次生成需要对应历史文件或模板，也可以上传已有文件。</p>'+catalog.map(d=>'<article class="collection-file"><span class="collection-file-icon">'+ico('file')+'</span><div class="collection-file-info"><strong>'+d.code+' '+d.name+'</strong><small>尚无项目文件</small></div><div class="pw-file-actions"><button class="btn secondary small" data-import-type="'+d.id+'">上传已有文件</button><a class="text-button" href="'+this.href('generate',{step:'source',prepare_document:d.id})+'">准备生成</a></div></article>').join('')+'</details>');
    document.querySelector<HTMLButtonElement>('[data-clear-file-status]')?.addEventListener('click',()=>this.chooseFileStatus('all'));
    document.querySelectorAll<HTMLButtonElement>('[data-import-type]').forEach(b=>b.addEventListener('click',()=>this.importFile(b.dataset.importType as ProjectDocumentType)));
    document.querySelectorAll<HTMLButtonElement>('[data-file-edit-upload]').forEach(b=>b.addEventListener('click',()=>{
      const targets=projectFileStatusRows(this.files,this.registry,this.registryLoaded).filter(row=>row.version?.version_id===b.dataset.fileEditUpload),v=targets.length===1?targets[0].version:undefined;
      if(!v?.latest){this.status('文件版本已变化，请刷新后重新选择。');return;}this.importFile(v.document_type,undefined,structuredClone(v));
    }));
    this.bindDownloads(document.querySelector('#file-list')!);
    document.querySelectorAll<HTMLButtonElement>('[data-file-history]').forEach(b=>b.addEventListener('click',()=>this.history(b.dataset.fileHistory!)));
    this.restoreFileReading(reading);
  }
  private paintImportRecovery(){
    const host=document.querySelector('#pw-import-recovery');if(!host)return;
    try{
      const records=this.owner?this.imports().list():[];
      host.innerHTML=records.map(r=>'<p class="collection-error">'+esc(r.declaration.filename)+' 的原保存待确认。继续会沿用原文件类型、操作编号和版本条件；尚未执行更新。 <button type="button" class="text-button" data-resume-project-file="'+esc(r.id)+'">继续确认关联文件</button></p>').join('');
      host.querySelectorAll<HTMLButtonElement>('[data-resume-project-file]').forEach(b=>b.addEventListener('click',()=>this.importFile(undefined,b.dataset.resumeProjectFile)));
    }catch(e){host.textContent=friendlyError(e,'read');}
  }
  private importFile(type?:ProjectDocumentType,operationId?:string,clickedTarget?:ProjectFileVersion){
    if(operationId){try{const record=this.imports().list().find(r=>r.id===operationId);if(!record)throw new UserFacingError('原上传记录已变化，请重新读取。');if(this.pendingImport?.upload.operationId!==operationId)this.restoreImport(record);}catch(e){this.status(friendlyError(e,'read'));return;}}
    if(this.uploading||this.panel?.hasUnconfirmed){this.status('请先确认当前上传或采用操作的结果，再上传关联文件。');return;}const opener=document.activeElement instanceof HTMLElement?document.activeElement:undefined;this.dialog?.remove();const d=document.createElement('dialog');this.dialog=d;d.className='pf-modal pw-file-import';
    const restoring=this.pendingImport;if(restoring)type=restoring.type;
    const target=restoring?this.registry.find(v=>v.version_id===restoring.latest&&v.document_type===restoring.type):clickedTarget;
    if(target)type=target.document_type;
    let targetConflict=false;
    d.setAttribute('aria-labelledby','pw-import-heading');
    d.innerHTML='<header><h2 id="pw-import-heading">'+(target?'上传此文件修改稿':'上传项目关联文件')+'</h2><button class="icon-btn" data-close aria-label="关闭">'+ico('close')+'</button></header><p class="pw-import-target" id="pw-import-target">'+esc(this.name)+(target?' · '+esc(PROJECT_DOCUMENT_CATALOG.find(c=>c.id===target.document_type)!.name)+'<br><strong>原文件：'+esc(target.filename)+' · V'+target.sequence+'</strong>':restoring?.latest?'<br>原目标版本暂不可读取，将沿原文件类型与版本条件确认。':'')+'</p><form><label>文件类型<select name="type" required><option value="">请选择文件类型</option>'+PROJECT_DOCUMENT_CATALOG.map(c=>'<option value="'+c.id+'" '+(type===c.id?'selected':'')+'>'+c.name+'</option>').join('')+'</select></label><label>Word 或 PDF<input name="file" type="file" accept=".docx,.pdf" '+(restoring?'':'required')+'/></label><p>'+(restoring?'先确认原上传；已收到字节时无需重选。若需要字节，请选择原文件。':target?'保存为此类文件的新版本，原 V'+target.sequence+' 保留。本次不生成、不合并、不检查。':'保存为此类文件的新版本，保留旧版。上传后可检查与当前募集书的一致性。')+'</p><button class="btn primary">保存项目文件</button></form><p role="status"></p>';
    if(restoring?.file){const transfer=new DataTransfer();transfer.items.add(restoring.file);d.querySelector<HTMLInputElement>('[name=file]')!.files=transfer.files;}
    const controls=()=>{d.querySelector<HTMLInputElement>('input')!.disabled=this.uploading||!!this.pendingImport?.uncertain&&!!this.pendingImport.file&&!this.pendingImport.allowReselect;d.querySelector<HTMLSelectElement>('select')!.disabled=this.uploading||!!this.pendingImport||!!target||!!restoring;d.querySelector<HTMLButtonElement>('form button')!.disabled=this.uploading||targetConflict;};
    const status=(text:string)=>{d.querySelector('[role=status]')!.textContent=text;};
    d.querySelector<HTMLSelectElement>('[name=type]')!.addEventListener('invalid',()=>status('请选择有效的文件类型，再保存项目文件。所选文件仍保留。'));
    if(restoring?.uncertain)status('本次保存结果尚未确认。请重试保存项目文件，沿用同一次操作。'+(restoring.pin?'已上传文件不会重复上传。':'请重试确认上传与保存结果。'));controls();
    document.body.append(d);d.showModal();d.querySelector('[data-close]')!.addEventListener('click',()=>{if(!this.uploading)d.close();});d.addEventListener('cancel',e=>{if(this.uploading)e.preventDefault();});
    d.addEventListener('close',()=>{d.remove();if(this.dialog===d)this.dialog=undefined;this.paintImportRecovery();if(opener?.isConnected)opener.focus();});
    d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();if(this.uploading||targetConflict)return;
      const select=d.querySelector<HTMLSelectElement>('[name=type]')!,selected=select.value;
      if(!PROJECT_DOCUMENT_CATALOG.some(c=>c.id===selected)){status('请选择有效的文件类型，再保存项目文件。所选文件仍保留。');select.focus();return;}
      this.uploading=true;controls();let confirmed=false;
      void(async()=>{const file=d.querySelector<HTMLInputElement>('[name=file]')!.files![0],type=selected as ProjectDocumentType;
        if(!file&&!this.pendingImport||file&&!/[.](docx|pdf)$/i.test(file.name))throw new UserFacingError('请选择 DOCX 或 PDF。');
        if(file&&(!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes))throw new UserFacingError('请上传不超过 100 MB 的 DOCX 或 PDF 文件。');
        if(!this.pendingImport&&target&&!this.registry.some(v=>v.version_id===target.version_id&&v.file_id===target.file_id&&v.document_type===target.document_type&&v.latest)){targetConflict=true;throw new UserFacingError('项目文件已有新版本，请关闭窗口并刷新后重新选择。所选文件仍保留在此窗口。');}
        if(!this.pendingImport){this.savedImport=undefined;this.paintSavedImport();}
        const pending=this.pendingImport??={file,type:target?.document_type??type,request:crypto.randomUUID(),latest:target?.version_id??this.registry.find(v=>v.latest&&v.document_type===type)?.version_id??null,upload:{},uncertain:false};
        if(file)pending.file=file;
        pending.pin=await uploadFileMaterial(this.api,this.id,pending.file,this.controller.signal,status,pending.upload,this.owner,'project-file-import',{request_id:pending.request,document_type:pending.type,expected_latest_version_id:pending.latest},()=>this.live());
        const result=await this.api.request<{files?:ProjectFileVersion[]}>('POST','/projects/'+encodeURIComponent(this.id)+'/project-files/imports',{request_id:pending.request,document_type:pending.type,material:pending.pin,expected_latest_version_id:pending.latest},{},AbortSignal.any([this.controller.signal,AbortSignal.timeout(30000)]));
        confirmed=true;this.savedImport={type:pending.type,pin:structuredClone(pending.pin),fileId:target?.file_id,previous:target?.sequence};
        if(Array.isArray(result.files)){this.registry=result.files;this.registryLoaded=true;}
        this.controller.signal.throwIfAborted();await this.imports().forget(pending.upload.operationId!);this.pendingImport=undefined;
        if(this.live()){this.paintImportRecovery();this.paintSavedImport();d.close();this.uploading=false;await this.refresh();document.querySelector<HTMLElement>('.pw-import-result')?.focus();}
      })().catch(async e=>{if(!this.live())return;
        if(confirmed){if(this.pendingImport)this.pendingImport.uncertain=true;status('文件已保存，原保存记录暂未清理。请继续确认原保存，保持原操作编号。');this.paintSavedImport();this.paintImportRecovery();return;}
        const rejected=e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status);
        if(this.pendingImport)this.pendingImport.uncertain=true;
        if(rejected&&this.pendingImport?.pin&&this.pendingImport.upload.operationId){try{await this.imports().forget(this.pendingImport.upload.operationId);this.pendingImport=undefined;}catch(storageError){status(friendlyError(storageError,'action'));this.paintImportRecovery();return;}}
        const detail=friendlyError(e,'save');
        if((target||restoring)&&e instanceof ApiError&&e.status===409){targetConflict=true;status(detail+' 请关闭窗口并刷新后重新选择目标；所选文件仍保留在此窗口。');}
        else status(rejected||!this.pendingImport?detail:'关联文件保存结果尚未确认。'+detail+' 请继续确认原保存；本次操作编号和版本条件已保留。');this.paintImportRecovery();
      }).finally(()=>{this.uploading=false;if(d.isConnected)controls();});
    });
  }
  private history(key:string){
    this.dialog?.remove();const rows=this.files.filter(f=>f.file_key===key);const dialog=document.createElement('dialog');this.dialog=dialog;dialog.className='collection-file-dialog';dialog.setAttribute('aria-label','文件版本记录');
    dialog.innerHTML=`<header><h2>版本记录</h2><button class="icon-btn" data-close aria-label="关闭版本记录">${ico('close')}</button></header><p>${esc(this.name)} · 旧版本保留</p>${rows.map(f=>`<article><div><strong>V${f.display_version} · ${esc(f.filename)}</strong><small>${esc(date(f.created_at))}${f.current?' · 当前募集书':''}${f.latest?' · 当前文件':''}</small></div>${this.registered(f)?.revision_asset?`<button class="btn secondary small" data-file-download="${esc(f.file_id)}" data-version="${f.version}" data-revision>下载修订版</button>`:''}<button class="btn secondary small" data-file-download="${esc(f.file_id)}" data-version="${f.version}">${this.registered(f)?.revision_asset?'下载清洁版':'下载'}</button></article>`).join('')}<p id="file-dialog-status" role="status"></p>`;
    document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-close]')!.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>dialog.remove());this.bindDownloads(dialog);
  }
  private bindDownloads(host:Element){
    host.querySelectorAll<HTMLButtonElement>('[data-file-download]').forEach(b=>{b.disabled=this.pendingDownloads.has(b.dataset.fileDownload!+':'+b.dataset.version);b.addEventListener('click',()=>void this.download(b));});
  }
  private async download(button:HTMLButtonElement){
    const f=this.files.find(f=>f.file_id===button.dataset.fileDownload&&f.version===Number(button.dataset.version));if(!f)return;
    const key=f.file_id+':'+f.version;if(this.pendingDownloads.has(key))return;this.pendingDownloads.add(key);button.disabled=true;
    const status=this.dialog?.open?this.dialog.querySelector('#file-dialog-status'):document.querySelector('#file-action-status');
    if(status)status.textContent='正在读取并核验文件…';
    try{
      let bytes:Blob,filename=f.filename;
      if(f.source==='artifact'){
        const revision=button.hasAttribute('data-revision')?this.registered(f)?.revision_asset:null;
        if(revision&&revision.kind!=='artifact')throw new ApiError(0,'DATA_UNAVAILABLE');
        const pin=revision?.pin;
        const a=await this.api.artifact(pin?.artifact_id??f.file_id,this.controller.signal);
        if(a.version!==(pin?.artifact_version??f.version)||a.run_id!==f.run_id||a.sha256!==(pin?.sha256??f.sha256))throw new ApiError(0,'DATA_UNAVAILABLE');
        const run=await this.api.run(a.run_id,this.controller.signal);
        if(run.project_id!==f.project_id||run.state!=='succeeded')throw new ApiError(0,'DATA_UNAVAILABLE');
        bytes=await this.api.artifactBytes(a,this.controller.signal);
        const registered=this.registered(f);
        filename=registered?.revision_asset?resultFilename({project:registered.filename.replace(/\.[^.]+$/,''),kind:revision?'修订版':'清洁版',version:registered.sequence,createdAt:f.created_at,mediaType:a.media_type}):artifactFilename(a);
      }
      else{const m=await this.api.material(f.project_id,f.file_id,this.controller.signal,f.version);if(m.material_version!==f.version||m.sha256!==f.sha256)throw new ApiError(409,'INPUT_REVISION_CONFLICT');bytes=await this.api.materialBytes(f.project_id,m,this.controller.signal);}
      if(!this.live())return;this.downloads.save(bytes,filename);if(status)status.textContent='文件已交给浏览器下载。';
    }catch(error){if(this.live()&&status)status.textContent=artifactError(error);}finally{this.pendingDownloads.delete(key);if(this.live())document.querySelectorAll<HTMLButtonElement>('[data-file-download]').forEach(b=>{b.disabled=this.pendingDownloads.has(b.dataset.fileDownload!+':'+b.dataset.version);});}
  }
}
