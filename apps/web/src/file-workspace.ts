import {uploadPicker} from './upload-picker';
import './upload-progress.css';
import {uploadActivity,uploadTransfer,uploadProgressHtml,type FileUploadProgress,type UploadStatus} from './upload-progress';
import {billingRecoveryHeaders} from './billing-recovery-wire.js';
import {int64,formatPoints} from '@bondbuddy/contracts';
import {isOutcomePriceVersion} from './billing-types.js';
import {isAutomaticCharge} from './commerce';
import {UserFacingError} from './user-facing-error.js';
import { ProjectEntry } from './project-entry';
import {PROJECT_DOCUMENT_CATALOG,MARKET_LABELS,OFFERING_LABELS,MARKET_OFFERINGS,M1_UPLOAD_MIME_TYPES,M1_UPLOAD_LIMITS,M4_DOCUMENT_FIXED_PRICE,OUTCOME_PRICE_VERSION,
  ProjectFileBatchSchema,M4DraftRequestSchema,M4TemplateCreateRequestSchema,type M4DraftRequest,type M4TemplateCreateRequest,type ProjectDocumentType as M4DocumentType,type M4Template,type M4MaterialPin,type ProjectFileBatch} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {ArtifactDownloads} from './artifact-download';
import {M4Api} from './m4-api';
import {ProspectusPanel} from './prospectus-panel';
import {FileGenerationCache,type FileGenerationBatchRequest,type FileGenerationNoteOperation} from './file-generation-cache';
import {esc,date} from './ui';
import {prototypeIcon as ico} from './prototype-design';
import {runStateLabel} from './review-state';
import {withProjectContext,navigationProjectContext,projectWorkHref} from './project-navigation';
import {UploadRecovery,UploadRecoveryNeedsFileError,type UploadRecoveryJson,type UploadRecoveryRecord} from './upload-recovery';
import './file-workspace.css';
import {WorkpaperPanel} from './workpaper-panel';
import {WorkpaperTaskPanel} from './workpaper-task';
import {FileGenerationPanel} from './file-generation-panel';
import '../../../product-prototype/public/file-generation-ux.css';
import '../../../product-prototype/public/workpaper-entry.css';
import './generation-flow.css';
import {isCnyPrice,displayPrice,cny,scopeLinesHtml,scopeStatus,scopeStatusLabel,scopeLifecycleHtml,guardScopeExpiry} from './commerce';

type Workspace=import('./billing-types.js').ProjectFileWorkspace;
export type UploadFileMaterialState={
  file?:File;projectId?:string;operationId?:string;recovery?:UploadRecovery;
  progress?:FileUploadProgress;
  material?:Awaited<ReturnType<ApiClient['completeUpload']>>;
};
function fileMaterialMime(file:File){const ext=file.name.split('.').at(-1)?.toLowerCase(),mime=ext==='docx'?M1_UPLOAD_MIME_TYPES[0]:ext==='pdf'?M1_UPLOAD_MIME_TYPES[1]:ext==='xlsx'?M1_UPLOAD_MIME_TYPES[2]:null;if(!mime||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)throw new UserFacingError('请上传不超过 100 MB 的 DOCX、PDF 或 XLSX 文件。');return mime;}
async function prepareFileMaterial(api:ApiClient,id:string,file:File|undefined,signal:AbortSignal,state:UploadFileMaterialState,owner:string,purpose:string,context?:UploadRecoveryJson,current:()=>boolean=()=>true){
  if(!owner)throw new UserFacingError('当前账号身份尚未确认，不能建立可恢复的上传记录。');
  if(state.projectId&&state.projectId!==id)throw new UserFacingError('原上传属于其他项目，请返回原项目确认。');
  const recovery=state.recovery??=new UploadRecovery(api,owner,id,purpose,current);
  if(file){fileMaterialMime(file);state.file=file;}
  state.projectId=id;
  if(!state.operationId){
    if(!file)throw new UserFacingError('请重新选择原文件后继续。');
    const mime=fileMaterialMime(file),sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
    signal.throwIfAborted();if(!current())throw new UserFacingError('页面已切换，请返回原项目继续。');
    state.operationId=recovery.begin({filename:file.name,media_type:mime,role:'other',sha256,byte_size:file.size},context).id;
  }
  const record=recovery.list().find(r=>r.id===state.operationId);
  if(!record||record.declaration.role!=='other'||![M1_UPLOAD_MIME_TYPES[0],M1_UPLOAD_MIME_TYPES[1],M1_UPLOAD_MIME_TYPES[2]].includes(record.declaration.media_type as typeof M1_UPLOAD_MIME_TYPES[0]))throw new UserFacingError('原上传不符合此入口的文件类型和角色，请保留记录并核对。');
  return recovery;
}
type GenerationUploadContext={
  kind:'support'|'template';topic:string;types:M4DocumentType[];
  templateRequest?:Omit<M4TemplateCreateRequest,'material'>;
  templateBase?:M4DraftRequest;
  supportBases?:Partial<Record<M4DocumentType,M4DraftRequest>>;
  apply?:M4DraftRequest;
};
const uploadJson=(value:unknown):UploadRecoveryJson=>JSON.parse(JSON.stringify(value)) as UploadRecoveryJson;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export async function uploadFileMaterial(api:ApiClient,id:string,file:File|undefined,signal:AbortSignal,status:UploadStatus=()=>{},state:UploadFileMaterialState={},owner='',purpose='file-material',context?:UploadRecoveryJson,current:()=>boolean=()=>true):Promise<M4MaterialPin>{
  const report=(p:FileUploadProgress)=>{state.progress=p;status(p.message,p);};
  report(uploadActivity());
  const recovery=await prepareFileMaterial(api,id,file,signal,state,owner,purpose,context,current);
  const m=state.material=await recovery.resume(state.operationId!,{file:state.file,signal,status:s=>report(uploadActivity(s)),progress:(loaded,total)=>report(uploadTransfer(loaded,total))});
  report(uploadActivity("文件已保存，正在完成后续处理…"));
  signal.throwIfAborted();
  return {source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
}

export class FileWorkspace {
  private reselectUploads=new Set<string>();
  private fileUnitPrice(){return this.state?.price?.points??M4_DOCUMENT_FIXED_PRICE.points;}
  private filePrice(count=1){return isCnyPrice(this.state?.price)?'依本次范围报价':formatPoints(BigInt(count)*int64(this.fileUnitPrice()))+' 积分';}

  private workpapers?:WorkpaperPanel|WorkpaperTaskPanel|FileGenerationPanel;
  private downloads=new ArtifactDownloads();private controller=new AbortController();private m4:M4Api;private panel?:ProspectusPanel;private dialog?:HTMLDialogElement;
  private state?:Workspace;private project?:Dto<'ProjectResponse'>;private selected=new Set<M4DocumentType>();private busy=false;
  private timer?:ReturnType<typeof setTimeout>;private pendingBatch?:Readonly<FileGenerationBatchRequest>;private pendingUncertain=false;private pendingStored=false;private pendingExpired=false;
  private resultsRequest=0;private resultsReading?:number;private resultsSettleReads=3;
  private cache?:FileGenerationCache;private note='';private noteStored=true;private message='';private noteOperation?:FileGenerationNoteOperation;private noteOperationStored=true;
  private support?:{files:{file:File;state:UploadFileMaterialState;pin?:M4MaterialPin}[];types:M4DocumentType[]};
  private cachedSelection?:readonly M4DocumentType[];private cacheUnknown=false;
  private entryIntent?:M4DocumentType;private entryWaiting=false;private entryAdopted?:M4DocumentType;private entryError='';
  private blankRow=false;private requirementsExpanded?:boolean;private supportExpanded?:boolean;private reusedExpanded=new Set<M4DocumentType>();
  private entry?:ProjectEntry;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id?:string,private owner?:string){
    this.m4=new M4Api(api,this.controller.signal);
    const params=new URLSearchParams(location.hash.split('?')[1]),requested=params.getAll('prepare_document');
    if(owner&&id&&params.get('project')===id&&!params.has('topic')&&requested.length===1&&PROJECT_DOCUMENT_CATALOG.some(d=>d.id===requested[0])){this.entryIntent=requested[0] as M4DocumentType;this.entryWaiting=params.get('prepare_wait')==='1';}
    if(owner&&id){this.cache=new FileGenerationCache(owner,id);this.restoreCachedPreparation();}else if(id)this.cacheUnknown=true;
  }
  private restoreCachedPreparation(){
    const saved=this.cache?.readForEntry();this.cacheUnknown=saved?.status!=='ok';if(!saved||saved.status!=='ok')return false;
    this.cachedSelection=saved.selection;this.pendingBatch=saved.pending;this.pendingUncertain=!!saved.pending;this.pendingStored=!!saved.pending;this.pendingExpired=false;
    this.noteOperation=saved.noteOperation;this.noteOperationStored=true;this.note=saved.noteOperation?.note??saved.note??'';this.noteStored=true;return true;
  }
  private live(){return this.current()&&!this.controller.signal.aborted;}
  private uploadRecovery(purpose:string){if(!this.owner||!this.id)throw new UserFacingError('当前账号和项目尚未确认，不能建立可恢复的上传记录。');return new UploadRecovery(this.api,this.owner,this.id,purpose,()=>this.live());}
  private hasPendingUploads(){try{return !!this.owner&&['generation-support','generation-template'].some(purpose=>this.uploadRecovery(purpose).list().length>0);}catch{return true;}}
  private generationContext(record:UploadRecoveryRecord):GenerationUploadContext{
    const c=record.context;
    if(!c||typeof c!=='object'||Array.isArray(c)||!['support','template'].includes(String(c.kind))||typeof c.topic!=='string'||!c.topic||!Array.isArray(c.types)||!c.types.length||c.types.some(t=>!PROJECT_DOCUMENT_CATALOG.some(d=>d.id===t))||new Set(c.types).size!==c.types.length||c.kind==='template'&&(!c.templateRequest||c.types.length!==1))throw new UserFacingError('原上传的文件范围无法核实，请保留记录并核对。');
    if(c.apply!==undefined&&!Value.Check(M4DraftRequestSchema,c.apply)||c.kind==='template'&&!Value.Check(M4DraftRequestSchema,c.templateBase))throw new UserFacingError('原草稿保存条件无法核实，请保留记录并核对。');
    const context=c as unknown as GenerationUploadContext;
    if(context.apply&&(context.apply.input.document_type==='workpaper'||!context.types.includes(context.apply.input.document_type)))throw new UserFacingError('原草稿保存范围不一致，请核对。');
    if(context.templateBase&&context.templateBase.input.document_type!==context.types[0])throw new UserFacingError('原模板采用范围不一致，请核对。');
    if(context.kind==='support'&&context.types.some(type=>!Value.Check(M4DraftRequestSchema,context.supportBases?.[type])||context.supportBases?.[type]?.input.document_type!==type))throw new UserFacingError('原补料草稿依据无法核实，请保留记录并核对。');
    return context;
  }
  private href(extra:Record<string,string>={}){return '#generate?'+withProjectContext(new URLSearchParams({project:this.id!,...(this.entryIntent?{prepare_document:this.entryIntent,...(this.entryWaiting?{prepare_wait:'1'}:{})}:{}),...extra}));}
  private syncEntryUrl(){
    if(!this.live())return;const params=new URLSearchParams(location.hash.split('?')[1]);if(params.get('project')!==this.id||params.has('topic'))return;
    params.delete('prepare_document');params.delete('prepare_wait');if(this.entryIntent){params.set('prepare_document',this.entryIntent);if(this.entryWaiting)params.set('prepare_wait','1');}
    history.replaceState(history.state,'','#generate?'+params.toString());
    document.querySelectorAll<HTMLAnchorElement>('a[href^="#generate?"]').forEach(a=>{const query=new URLSearchParams(a.getAttribute('href')!.split('?')[1]);if(query.get('project')!==this.id||query.has('topic'))return;query.delete('prepare_document');query.delete('prepare_wait');if(this.entryIntent){query.set('prepare_document',this.entryIntent);if(this.entryWaiting)query.set('prepare_wait','1');}a.setAttribute('href','#generate?'+query.toString());});
  }
  private waitForEntry(){if(this.entryIntent&&!this.entryWaiting){this.entryWaiting=true;this.syncEntryUrl();}}
  private dismissEntry(){this.entryIntent=undefined;this.entryWaiting=false;this.entryError='';this.syncEntryUrl();}
  private entryNoteConflict(){return !!this.entryIntent&&!!this.note.trim()&&(this.selected.size!==1||!this.selected.has(this.entryIntent));}
  private entryHasOriginalOperation(){return !!this.pendingBatch||!!this.noteOperation||!!this.support||this.hasPendingUploads();}
  private adoptEntry(mode:'plain'|'transfer'|'clear'='plain'){
    const target=this.entryIntent;if(!target)return false;
    const saved=this.cache?.readForEntry();
    if(!saved||saved.status!=='ok'){this.cacheUnknown=true;this.entryError='本浏览器的原准备记录暂不可读取，尚未切换文种。';this.waitForEntry();return false;}
    if(saved.pending&&!this.pendingBatch){this.pendingBatch=saved.pending;this.pendingUncertain=true;this.pendingStored=true;}
    if(saved.noteOperation&&!this.noteOperation){this.noteOperation=saved.noteOperation;this.note=saved.noteOperation.note;this.noteOperationStored=true;this.noteStored=true;}
    if(this.entryHasOriginalOperation()){this.waitForEntry();return false;}
    if(this.noteStored&&(saved.note??'')!==this.note){this.note=saved.note??'';this.selected=new Set(saved.selection??this.selected);this.entryError='浏览器中的补充要求已变化，请重新核对这段未保存要求。';this.waitForEntry();return false;}
    if(mode==='plain'&&this.entryNoteConflict()){this.waitForEntry();return false;}
    if(mode==='clear'){
      if(!this.cache!.clearNote()){this.entryError='未能清空本浏览器的补充要求，旧要求与原选择均保留，尚未切换文种。';this.waitForEntry();return false;}
      this.note='';this.noteStored=true;
    }else if(this.note&&!this.noteStored){
      this.noteStored=this.cache!.saveNote(this.note);if(!this.noteStored){this.entryError='这段补充要求尚未保存在浏览器，原选择保留，请重试。';this.waitForEntry();return false;}
    }
    if(!this.cache!.saveSelection([target])){this.entryError=mode==='clear'?'补充要求已清空，文种尚未切换；原选择保留，请重试准备所选文种。':'所选文种暂未保存到浏览器，原选择保留，请重试准备。';this.waitForEntry();return false;}
    this.selected=new Set([target]);this.cachedSelection=[target];this.entryAdopted=target;this.dismissEntry();this.status('已按项目文件入口选择《'+PROJECT_DOCUMENT_CATALOG.find(d=>d.id===target)!.name+'》。');return true;
  }
  private prepareEntry(){
    if(!this.entryIntent)return;
    if(this.cacheUnknown||this.entryWaiting||this.entryHasOriginalOperation()||new URLSearchParams(location.hash.split('?')[1]).get('step')==='results'){this.waitForEntry();return;}
    this.adoptEntry();
  }
  private async adoptEntryFromCard(mode:'plain'|'transfer'|'clear'){
    await this.act(async()=>{const results=new URLSearchParams(location.hash.split('?')[1]).get('step')==='results';if(this.adoptEntry(mode)&&results)location.hash=this.href({step:'source',mode:'documents'});else await this.paint();},'read');
  }
  private paintEntryIntent(){
    const host=document.querySelector<HTMLElement>('#pf-entry-intent');if(!host)return;
    host.hidden=!this.cacheUnknown&&!this.entryIntent&&!this.entryAdopted;host.className='pf-entry-card';if(host.hidden){host.innerHTML='';return;}
    const name=this.entryIntent?PROJECT_DOCUMENT_CATALOG.find(d=>d.id===this.entryIntent)!.name:undefined;
    if(this.cacheUnknown){
      host.innerHTML=`<h2>本浏览器的准备记录暂不可读取</h2><p>${name?'你刚选择了《'+esc(name)+'》。':''}尚不能确认上次文件包或补充要求，原记录保留，暂不切换文种或提交生成。</p><button class="btn secondary" id="pf-entry-retry" ${this.busy?'disabled':''}>重新读取准备记录</button>`;
      host.querySelector('#pf-entry-retry')!.addEventListener('click',()=>void this.act(async()=>{if(!this.restoreCachedPreparation()){this.status('准备记录仍暂不可读取，请稍后重试。');await this.paint();return;}this.selected=new Set(this.cachedSelection??this.state?.batches[0]?.items.map(i=>i.document_type)??[]);this.entryError='';this.status('原准备记录已读取，请核对后继续。');await this.paint();},'read'));return;
    }
    if(!this.entryIntent){host.innerHTML='<p role="status">已按项目文件入口选择《'+esc(PROJECT_DOCUMENT_CATALOG.find(d=>d.id===this.entryAdopted)!.name)+'》，各文件已保存的要求与依据保留。</p>';return;}
    const blocked=this.entryHasOriginalOperation(),conflict=!blocked&&this.entryNoteConflict();
    let body='';
    if(this.pendingBatch)body='<p>先确认上次文件包是否已提交；原文件范围和版本保持不变。确认后可继续准备这次所选文种。</p>';
    else if(this.noteOperation)body='<p>上次补充要求仍需处理，原保存范围为：'+esc(this.noteOperation.documents.map(d=>PROJECT_DOCUMENT_CATALOG.find(c=>c.id===d.document_type)!.name).join('、'))+'。先继续或停止原保存，再准备这次所选文种。</p>';
    else if(blocked)body='<p>上次模板或补充资料仍需处理。先在原范围继续或停止保存，再准备这次所选文种；已保存的内容保留。</p>';
    else if(conflict)body='<p>浏览器恢复了上次文件包和一段未保存的补充要求。'+(this.selected.size?'上次选择：'+esc([...this.selected].map(type=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name).join('、'))+'。':'上次尚未选择文件。')+'请明确这段要求是否用于这次所选文种。</p><pre class="pf-entry-note">'+esc(this.note)+'</pre>';
    else body='<p>已保留这次所选文种；点击下方继续准备，不会自动生成文件或保存要求。</p>';
    const disabled=this.busy?'disabled':'';
    host.innerHTML='<h2>准备《'+esc(name!)+'》</h2>'+body+(this.entryError?'<p class="pf-entry-error" role="alert">'+esc(this.entryError)+'</p>':'')+'<div class="pf-entry-actions"><button class="text-button" id="pf-entry-keep" '+disabled+'>继续上次准备</button>'+(conflict?'<button class="btn secondary" id="pf-entry-transfer" '+disabled+'>保留这段要求并改选《'+esc(name!)+'》</button><button class="btn secondary" id="pf-entry-clear" '+disabled+'>清空这段要求并改选《'+esc(name!)+'》</button>':blocked?(!this.pendingBatch?'<a class="text-button" href="'+esc(this.href({step:'documents'}))+'">先处理原保存 →</a>':''):'<button class="btn primary" id="pf-entry-continue" '+disabled+'>准备《'+esc(name!)+'》</button>')+'</div>';
    host.querySelector('#pf-entry-keep')!.addEventListener('click',()=>{if(this.busy)return;this.entryAdopted=undefined;this.dismissEntry();this.status('已继续上次准备，原文件选择和未保存要求保留。');this.paintEntryIntent();if(document.querySelector('#pf-template-list'))this.paintTemplates();});
    host.querySelector('#pf-entry-transfer')?.addEventListener('click',()=>void this.adoptEntryFromCard('transfer'));
    host.querySelector('#pf-entry-clear')?.addEventListener('click',()=>void this.adoptEntryFromCard('clear'));
    host.querySelector('#pf-entry-continue')?.addEventListener('click',()=>void this.adoptEntryFromCard('plain'));
  }
  private filesHref(){return projectWorkHref('files',navigationProjectContext(location.hash)?.projectId??this.id!);}
  get hasUnconfirmed(){
    return !!this.workpapers?.hasUnconfirmed||this.busy||!!this.panel?.blocksNavigation||!!this.support||!!this.pendingBatch&&!this.pendingStored||!!this.noteOperation&&!this.noteOperationStored||!!this.note&&!this.noteStored;
  }
  async beforeLeave(){
    if(this.workpapers&&!await this.workpapers.beforeLeave())return false;
    if(this.busy)return false;
    if(this.panel&&!await this.panel.beforeLeave())return false;
    if(this.support){this.status('补充资料尚未全部保存，请先重试保存。');return false;}
    if(this.pendingBatch&&!this.pendingStored){this.status('本次提交记录尚未保存，请先确认提交结果。');return false;}
    if(this.noteOperation&&!this.noteOperationStored){this.status('补充要求的保存范围尚未保留，请先继续保存或停止后续保存。');return false;}
    if(this.note&&!this.noteStored){this.noteStored=this.cache?.saveNote(this.note)??false;if(!this.noteStored){this.status('补充要求尚未保存，请先保存到所选文件。');return false;}}
    return true;
  }
  dispose(){this.workpapers?.dispose();this.entry?.dispose();this.controller.abort();this.downloads.dispose();clearTimeout(this.timer);this.panel?.dispose();this.dialog?.remove();}
  private request<T>(method:'GET'|'POST',suffix:string,body?:unknown,headers:Record<string,string>={},signal=this.controller.signal){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id!)}/project-files${suffix}`,body,headers,signal);}
  async render(){
    this.shell('<p role="status">正在读取文件生成…</p>','generate');
    if(!this.id){await this.chooseProject();return;}
    try{
      this.project=await this.api.project(this.id,this.controller.signal);
      const taskQuery=new URLSearchParams(location.hash.split('?')[1]),operation=taskQuery.get('operation');
      if(taskQuery.get('run')&&(operation==='workpaper_assessment'||operation==='workpaper_check')){
        if(!this.live())return;
        this.shell(`${this.header('workpapers')}<div id="pf-workpapers"></div>`,'generate');
        this.workpapers=new WorkpaperTaskPanel(this.api,document.querySelector('#pf-workpapers')!,this.id,taskQuery.get('run')!,operation,()=>this.live());
        await this.workpapers.render();return;
      }
      try{this.state=await this.request<Workspace>('GET','/workspace');}
      catch(e){if(!(e instanceof ApiError)||e.status!==404)throw e;this.state=await this.request<Workspace>('POST','/workspace',{request_id:crypto.randomUUID()});}
      if(this.live()){
        this.selected=new Set(this.cachedSelection??this.state.batches[0]?.items.map(i=>i.document_type)??[]);this.prepareEntry();
        await this.paint();
      }
    }
    catch(e){if(this.live())this.shell(`<div class="collection-empty"><h1>文件生成暂时无法打开</h1><p role="alert">${esc(friendlyError(e,'read'))}</p><a class="btn secondary" href="#generate">重新选择项目</a></div>`,'generate');}
  }
  private status(s:string){this.message=s;if(!this.live())return;const node=document.querySelector('#pf-status');if(node)node.textContent=s;}
  private syncSourceAction(){
    const button=document.querySelector<HTMLButtonElement>('#pf-source-next');
    if(button)button.disabled=this.busy||!!this.panel?.hasUnconfirmed||!this.state?.source;
  }
  private sourceDestination():string{const mode=new URLSearchParams(location.hash.split('?')[1]).get('mode');return this.entryHasOriginalOperation()||this.entryIntent||this.entryAdopted?'documents':mode==='documents'?'documents':'prepare';}
  private async continueFromSource(){
    this.status('正在核对募集说明书…');
    const deadline=AbortSignal.timeout(15_000);
    try{this.state=await this.request<Workspace>('GET','/workspace',undefined,{},AbortSignal.any([this.controller.signal,deadline]));}
    catch(error){if(deadline.aborted&&!this.controller.signal.aborted)throw new UserFacingError('募集说明书状态读取超时，请重试。已保存的文件不受影响。');throw error;}
    const source=this.state.source;if(!source)throw new UserFacingError('项目当前募集说明书已变化，请刷新页面后重新选择。');
    if(source.version_id!==this.panel?.selectedVersionId)throw new UserFacingError('项目募集说明书已变化，请刷新页面，核对本次生成依据后继续。');
    const destination=this.sourceDestination();
    // Unified preparation pins the source when quoting/submitting selected files.
    // The legacy endpoint imports the whole document and saves every M4 draft.
    if(destination==='documents'){
      this.status('正在准备文件清单…');
      this.state=await this.request<Workspace>('POST','/source',{source_version_id:source.version_id,expected_selection_revision:source.selection_revision});
    }
    if(this.live())location.hash=this.href({step:destination});
  }
  private lockPreparation(){this.syncSourceAction();this.paintSupportUpload();document.querySelectorAll<HTMLElement>('.pf-generation-grid,.pf-optional-grid,.pf-original-operations').forEach(n=>n.inert=this.busy);const b=document.querySelector<HTMLButtonElement>('#pf-generate');if(b&&this.busy)b.disabled=true;document.querySelectorAll<HTMLButtonElement>('[data-batch-retry],[data-batch-cancel],[data-pf-download]').forEach(button=>button.disabled=this.busy);const refresh=document.querySelector<HTMLButtonElement>('#pf-refresh-results');if(refresh){refresh.disabled=this.busy||this.resultsReading!==undefined;refresh.textContent=this.resultsReading!==undefined?'正在刷新…':'刷新生成状态';}}
  private async act(fn:()=>Promise<void>,operation:'read'|'save'|'download'|'submit'|'action'='save'){if(this.busy)return;if(this.panel&&!await this.panel.requireConfirmed())return;this.busy=true;clearTimeout(this.timer);this.resultsRequest++;this.resultsReading=undefined;this.lockPreparation();this.paintEntryIntent();this.status('正在保存…');try{await fn();}catch(e){if(this.live())this.status(friendlyError(e,operation));}finally{this.busy=false;if(this.live()){for(const n of document.querySelectorAll('#pf-support-feedback'))if(n.querySelector('.file-upload-progress'))n.textContent=this.message;if(document.querySelector('#pf-template-list'))this.paintTemplates();this.lockPreparation();this.paintEntryIntent();this.scheduleResults();}}}
  private prepared(){const source=this.state?.source;if(!source)return false;const matches=(id:M4DocumentType)=>{const pin=this.state!.workspace.drafts[id].project_file;return !!pin&&pin.project_id===this.id&&pin.source_version_id===source.version_id&&pin.source_selection_revision===source.selection_revision;};return this.selected.size?[...this.selected].every(matches):PROJECT_DOCUMENT_CATALOG.some(d=>matches(d.id));}
  private saveSelection(){if(this.cache&&!this.cache.saveSelection([...this.selected]))this.status('本次文件选择暂未保存到浏览器会话，刷新后请重新核对。');}
  private header(step:string){
    const unified=step==='prepare'||step==='source'&&this.sourceDestination()==='prepare';
    const workpapers=step==='workpapers'||step==='source'&&this.sourceDestination()==='workpapers',results=step==='results'||workpapers&&new URLSearchParams(location.hash.split('?')[1]).get('view')==='results';
    const active=step==='source'||step==='choose'?1:step==='confirm'?3:results?4:2;
    return `<header class="pf-workspace-heading pf-generation-heading"><div class="pf-title-row"><div><h1>生成文件</h1></div><nav class="pf-workspace-actions" aria-label="文件生成导航"><a class="btn secondary" href="${esc(this.href(workpapers?{step:'workpapers',view:'results'}:{step:'results'}))}">生成记录</a>${results?`<a class="btn secondary" href="${esc(this.href(workpapers?{step:'results'}:{step:'workpapers',view:'results'}))}">${workpapers?'模板文件生成记录':'底稿生成记录'}</a>`:''}</nav></div></header>
      <nav class="pf-flow-steps" aria-label="文件生成步骤">${['选择募集说明书','选择生成内容','确认并生成','查看成果'].map((label,i)=>{const n=i+1,href=unified?this.href({step:n===1?'source':'prepare'}):n===1?this.href({step:'source',mode:workpapers?'workpapers':'documents'}):this.href({step:workpapers?'workpapers':'documents'});return `<${n<active&&n<3?'a':'span'} ${n<active&&n<3?`href="${esc(href)}"`:''} data-flow-step="${n}" class="${n===active?'is-current':n<active?'is-complete':''}" ${n===active?'aria-current="step"':''}><b>${n<active?'✓':n}</b>${label}</${n<active&&n<3?'a':'span'}>`;}).join('')}</nav>
      ${active===2&&step!=='prepare'?this.generationModes(workpapers?'workpapers':'documents'):''}<section id="pf-entry-intent" aria-label="准备生成所选文种" hidden></section>`;
  }
  private generationModes(_mode:'workpapers'|'documents'){return `<nav class="pf-flow-modes" aria-label="文件生成导航"><a href="${esc(this.href({step:'prepare'}))}"><strong>准备生成文件</strong><span>选择目录、模板和本批文件</span></a></nav>`;}
  private setWorkpaperStep(step:number){document.querySelectorAll<HTMLElement>('[data-flow-step]').forEach((el,i)=>{const n=i+1;el.classList.toggle('is-current',n===step);el.classList.toggle('is-complete',n<step);if(n===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');el.querySelector('b')!.textContent=n<step?'✓':String(n);});const modes=document.querySelector<HTMLElement>('.pf-flow-modes');if(modes)modes.hidden=step!==2;}
  private async chooseProject(){
    this.entry=new ProjectEntry(this.api,this.shell,()=>this.live(),{section:'generate',title:'文件生成',eyebrow:'FILE GENERATION',
      description:'选择募集说明书、所需文件和模板，统一生成本批成果。',
      steps:[],next:'打开文件生成',onNew:()=>this.newProject(),
      open:async(id)=>{if(this.live())location.hash='generate?project='+encodeURIComponent(id);}});
    await this.entry.render();
  }
  private modal(title:string,body:string){this.dialog?.remove();const d=document.createElement('dialog');d.className='pf-modal';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="关闭">${ico('close')}</button></header>${body}<p id="pf-modal-status" role="status"></p>`;document.body.append(d);d.showModal();d.querySelector('[data-close]')!.addEventListener('click',()=>{if(!this.busy)d.close();});d.addEventListener('cancel',e=>{if(this.busy)e.preventDefault();});d.addEventListener('close',()=>d.remove());this.dialog=d;return d;}
  private newProject(){
    const d=this.modal('新建项目',`<form id="pf-new-form"><label>项目名称<input name="name" required maxlength="200"/></label><label>发行人全称<input name="issuer_name" required maxlength="200"/></label><label>市场<select name="market">${Object.entries(MARKET_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>品种<select name="offering"></select></label><button class="btn primary">创建项目，选择募集说明书</button></form>`);
    const market=d.querySelector<HTMLSelectElement>('[name=market]')!,offering=d.querySelector<HTMLSelectElement>('[name=offering]')!;
    const sync=()=>{offering.innerHTML=MARKET_OFFERINGS[market.value as keyof typeof MARKET_OFFERINGS].map(v=>`<option value="${v}">${OFFERING_LABELS[v]}</option>`).join('');};market.addEventListener('change',sync);sync();
    const key=crypto.randomUUID();d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();if(this.busy)return;this.busy=true;const data=new FormData(e.target as HTMLFormElement);
      void this.api.request<Dto<'ProjectResponse'>>('POST','/projects',{creation_request_id:key,kind:'generation',name:data.get('name'),issuer_name:data.get('issuer_name'),market:market.value,offering:offering.value}, {},this.controller.signal)
        .then(p=>{if(this.live()){d.close();location.hash=`generate?project=${p.project_id}&step=choose`;}}).catch(e=>{d.querySelector('#pf-modal-status')!.textContent=friendlyError(e,'submit');}).finally(()=>{this.busy=false;});});
  }
  private async paint(){
    this.workpapers?.dispose();this.workpapers=undefined;
    if(!this.state||!this.live())return;this.capturePreparationView();this.panel?.dispose();this.panel=undefined;
    const requested=new URLSearchParams(location.hash.split('?')[1]).get('step');
    const step=!requested||requested==='choose'?'source':requested;
    if(this.cacheUnknown){clearTimeout(this.timer);this.waitForEntry();this.shell(`${this.header(step)}<p id="pf-status" role="status">${esc(this.message)}</p><a class="text-button" href="${esc(this.filesHref())}">返回项目文件</a>`,'generate');this.paintEntryIntent();return;}
    if(this.pendingBatch){this.paintRecovery();return;}
    const query=new URLSearchParams(location.hash.split('?')[1]);
    let legacyWorkpaperPending=query.get('legacy')==='1';
    try{
      legacyWorkpaperPending ||= !!JSON.parse(localStorage.getItem(`bb-workpapers-v1:${this.owner}:${this.id}`)??'null')?.pending;
      // Old catalogue uploads retain their original scope, import request and column mapping.
      // Resolve them on their existing screen before moving to the unified preparation.
      legacyWorkpaperPending ||= this.uploadRecovery('workpaper-catalogue').list().length>0;
    }catch{legacyWorkpaperPending=true;}
    if((step==='prepare'||step==='workpapers'&&query.get('view')!=='results'&&!query.has('workpaper_batch'))&&legacyWorkpaperPending){
      if(step==='prepare'){location.hash=this.href({step:'workpapers'});return;}
      this.shell(`${this.header('workpapers')}<div id="pf-workpapers"></div>`,'generate');
      this.workpapers=new WorkpaperPanel(this.api,document.querySelector('#pf-workpapers')!,this.id!,this.owner!,this.state.source,()=>this.live(),step=>this.setWorkpaperStep(step));await this.workpapers.render();return;
    }
    if(step==='workpapers'&&query.get('view')!=='results'&&!query.has('workpaper_batch')){location.hash=this.href({step:'prepare'});return;}
    if(step==='prepare'){
      if(!this.state.source){location.hash=this.href({step:'source'});return;}
      this.shell(`${this.header('prepare')}<div id="pf-unified-generation"></div>`,'generate');
      this.workpapers=new FileGenerationPanel(this.api,document.querySelector('#pf-unified-generation')!,this.id!,this.owner!,this.state,()=>this.live(),step=>this.setWorkpaperStep(step));await this.workpapers.render();return;
    }
    if(step==='workpapers'){
      if(!this.state.source&&new URLSearchParams(location.hash.split('?')[1]).get('view')!=='results'){location.hash=this.href({step:'source',mode:'workpapers'});return;}
      this.shell(`${this.header(step)}<div id="pf-workpapers"></div>`,'generate');
      this.workpapers=new WorkpaperPanel(this.api,document.querySelector('#pf-workpapers')!,this.id!,this.owner!,this.state.source,()=>this.live(),step=>this.setWorkpaperStep(step));await this.workpapers.render();return;
    }
    if(step==='source'){
      const nextLabel='下一步：选择生成内容';
      this.shell(`${this.header(step)}<div class="pf-source-workspace"><div id="pf-prospectus"></div><p id="pf-status" role="status">${esc(this.message)}</p><footer class="pf-source-actions"><button class="btn primary" id="pf-source-next" ${this.state.source?'':'disabled'}>${nextLabel} ${ico('arrow')}</button></footer></div>`,'generate');this.paintEntryIntent();
      const sourceProject=this.state.source?.project_id??this.id!;
      this.panel=new ProspectusPanel(this.api,sourceProject,document.querySelector('#pf-prospectus')!,async()=>!this.busy,async()=>{this.state=await this.request<Workspace>('GET','/workspace');if(this.live())this.syncSourceAction();},()=>this.syncSourceAction(),'generation',this.owner);await this.panel.refresh();this.syncSourceAction();
      document.querySelector('#pf-source-next')!.addEventListener('click',()=>void this.act(async()=>{
        await this.continueFromSource();
      }));return;
    }
    if(step==='results'){this.paintResults();return;}
    if(!this.state.source){location.hash=this.href({step:'source',mode:'documents'});return;}
    if(!this.prepared()){location.hash=this.href({step:'source',mode:'documents'});return;}
    const current=this.state.source;
    const requirementsOpen=this.requirementsExpanded??!!this.note.trim(),supportOpen=this.supportExpanded??false;
    this.shell(`${this.header('documents')}<div class="pf-source-strip pf-generation-source">${ico('file')}<div id="pf-source-summary"><strong>${esc(current.filename)}</strong><small>本次生成依据 · V${current.sequence} · ${esc(this.project!.name)}</small></div><a class="btn secondary" href="${esc(this.href({step:'source',mode:'documents'}))}">更换</a></div>
      <div class="pf-documents-layout"><p id="pf-status" role="status">${esc(this.message)}</p>
      <section class="panel pf-original-operations" id="pf-original-operations" aria-label="原保存与需要处理的事项" hidden><h2>先处理原保存</h2><div id="pf-note-recovery" hidden><p id="pf-note-recovery-label"></p><pre id="pf-note-recovery-preview" class="pf-entry-note" hidden></pre><div id="pf-note-recovery-actions"></div></div><div id="pf-live-support-recovery" hidden></div><div id="pf-support-recovery" hidden></div><div id="pf-template-recovery" hidden></div></section>
      <div class="pf-generation-grid"><section class="panel pf-file-builder" id="pf-package-overview" aria-label="本次文件清单"><div class="pf-builder-heading"><div><h2>要生成的文件 <span id="pf-count"></span></h2><p>每行选择一种文件，并添加对应模板。已保存的模板自动复用。</p></div><span class="pf-chip" id="pf-prepared"></span></div>
      <div class="pf-file-table-wrap"><table class="pf-file-table" aria-label="文件与模板清单"><thead><tr><th scope="col">序号</th><th scope="col">文件类型</th><th scope="col">采用的模板 / 已保存依据</th><th scope="col">操作</th></tr></thead><tbody id="pf-template-list"></tbody></table></div>
      <div class="pf-builder-bottom"><button class="btn secondary" id="pf-add-row">添加一行</button><div id="pf-package-readiness" role="status"></div></div><p class="pf-builder-note">完成后自动归入项目，旧版本保留。诚信核查底稿请<a href="${esc('#integrity?'+withProjectContext(new URLSearchParams({project:this.id!})))}">前往诚信核查</a>准备。</p></section></div>
      <div class="pf-optional-grid"><details class="panel pf-optional" id="pf-requirements-details" ${requirementsOpen?'open':''}><summary>补充要求（选填） <span id="pf-note-summary"></span></summary><div class="pf-optional-content"><label for="pf-requirements">本轮统一补充要求</label><textarea id="pf-requirements" rows="4" maxlength="12000" placeholder="例如保留待补充标记，供项目组逐项核实">${esc(this.note)}</textarea><p>保存时只追加到当前所选文件；各文件已有要求保留。</p><div id="pf-note-actions-slot"><div id="pf-note-actions"><button class="btn secondary" id="pf-save-requirements">保存到所选文件</button><p id="pf-note-status" role="status">${this.note?'未保存的补充要求已从本浏览器会话恢复。':''}</p></div></div></div></details>
      <details class="panel pf-optional" id="pf-support-details" ${supportOpen?'open':''}><summary>补充依据（选填） <span id="pf-support-summary"></span></summary><div class="pf-optional-content"><input id="pf-support" type="file" multiple accept=".docx,.pdf,.xlsx" aria-label="为所选文件补充依据" hidden/><button type="button" class="pf-support-dropzone bb-upload-picker bb-upload-picker--standard" id="pf-support-upload" aria-label="上传补充依据" aria-describedby="pf-support-upload-hint pf-support-formats"><span class="pf-support-upload-icon" aria-hidden="true">${ico('upload')}</span><span class="pf-support-upload-copy"><strong>上传补充依据</strong><span id="pf-support-upload-hint">点击选择，或将文件拖到此处</span></span></button><p class="pf-support-formats" id="pf-support-formats"><span>DOCX、PDF、XLSX</span><span>支持多选 · 单份不超过 100 MB</span></p><p class="pf-support-purpose">可补充财务报告、核查依据或履职材料，用于当前所选文件。</p><p id="pf-support-feedback" role="status" aria-live="polite"></p><div id="pf-support-actions-slot"><div id="pf-support-actions"><div id="pf-support-list"></div><button class="bb-upload-action bb-upload-action--primary btn secondary" id="pf-retry-support" hidden>重试保存补充资料</button></div></div></div></details></div><footer class="pf-footer pf-documents-next"><a class="btn secondary" href="${esc(this.filesHref())}">返回项目文件</a><div><span id="pf-price"></span><button class="btn primary" id="pf-generate" disabled>开始生成文件包</button></div></footer></div>`,'generate');
    this.bindPreparationView();
    document.querySelector('#pf-add-row')!.addEventListener('click',()=>{if(this.busy||this.selected.size===PROJECT_DOCUMENT_CATALOG.length)return;this.blankRow=true;this.paintTemplates();document.querySelector<HTMLSelectElement>('[data-pf-document=""]')?.focus();});
    document.querySelector<HTMLTextAreaElement>('#pf-requirements')!.addEventListener('input',e=>{this.note=(e.target as HTMLTextAreaElement).value;this.noteStored=this.cache?.saveNote(this.note)??false;document.querySelector('#pf-note-status')!.textContent=this.noteStored?'补充要求草稿已保存在当前浏览器会话，保存或核对文件包时加入所选文件。':'草稿暂未保存在浏览器，请先保存到所选文件。';document.querySelector<HTMLButtonElement>('#pf-save-requirements')!.disabled=!this.selected.size||!this.note.trim()||this.busy;this.paintPreparationView();this.paintEntryIntent();});
    document.querySelector('#pf-save-requirements')!.addEventListener('click',()=>void this.act(async()=>{await this.saveRequirements();this.status('补充要求已加入所选文件，各文件原有要求保留。');}));
    document.querySelector('#pf-save-requirements')!.insertAdjacentHTML('afterend','<button class="text-button" id="pf-stop-note" hidden>停止继续保存要求</button>');
    document.querySelector('#pf-stop-note')!.addEventListener('click',()=>{if(this.busy)return;this.noteOperation=undefined;this.noteOperationStored=true;this.note='';this.noteStored=true;this.cache?.clearNoteOperation();this.cache?.clearNote();document.querySelector<HTMLTextAreaElement>('#pf-requirements')!.value='';document.querySelector('#pf-note-status')!.textContent='已停止继续保存。此前已保存的要求会保留。';this.status('已停止本次补充要求的后续保存，各文件原有和已保存内容保留。');this.paintTemplates();});
    const supportInput=document.querySelector<HTMLInputElement>('#pf-support')!,supportUpload=document.querySelector<HTMLButtonElement>('#pf-support-upload')!;
    supportInput.addEventListener('change',()=>{const files=[...(supportInput.files??[])];supportInput.value='';if(files.length)void this.addSupport(files);});
    supportUpload.addEventListener('click',()=>{if(!supportInput.disabled)supportInput.click();});
    supportUpload.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect=supportInput.disabled?'none':'copy';if(!supportInput.disabled)supportUpload.classList.add('is-dragging');});
    supportUpload.addEventListener('dragleave',e=>{if(!(e.relatedTarget instanceof Node)||!supportUpload.contains(e.relatedTarget))supportUpload.classList.remove('is-dragging');});
    supportUpload.addEventListener('drop',e=>{e.preventDefault();supportUpload.classList.remove('is-dragging');if(!supportInput.disabled&&e.dataTransfer?.files.length)void this.addSupport([...e.dataTransfer.files]);});
    document.querySelector('#pf-retry-support')!.addEventListener('click',()=>void this.addSupport([]));
    document.querySelector('#pf-retry-support')!.insertAdjacentHTML('afterend','<button class="text-button" id="pf-stop-support" hidden>停止继续补充</button>');
    document.querySelector('#pf-stop-support')!.addEventListener('click',()=>{void this.act(async()=>{const recovery=this.uploadRecovery('generation-support'),ids=new Set(this.support?.files.map(item=>item.state.operationId));for(const r of recovery.list())if(ids.has(r.id))await recovery.forget(r.id);this.support=undefined;this.status('已停止继续补充。已上传或已保存的资料会保留，下一次读取项目时可核对。');this.paintSupport();},'action');});
    document.querySelector('#pf-generate')!.addEventListener('click',()=>void this.prepareGeneration());this.paintTemplates();this.paintSupport();this.paintUploadRecovery();
  }
  private capturePreparationView(){
    const requirements=document.querySelector<HTMLDetailsElement>('#pf-requirements-details'),support=document.querySelector<HTMLDetailsElement>('#pf-support-details');
    if(requirements)this.requirementsExpanded=requirements.open;if(support)this.supportExpanded=support.open;
    document.querySelectorAll<HTMLDetailsElement>('[data-pf-reused]').forEach(node=>{const type=node.dataset.pfReused as M4DocumentType;if(node.open)this.reusedExpanded.add(type);else this.reusedExpanded.delete(type);});
  }
  private bindPreparationView(){
    for(const id of ['pf-requirements-details','pf-support-details']){const node=document.getElementById(id) as HTMLDetailsElement;node.addEventListener('toggle',()=>{if(node.isConnected&&this.live())this.capturePreparationView();});}
  }
  private movePreparationControls(id:string,targetId:string){
    const node=document.getElementById(id),target=document.getElementById(targetId);if(!node||!target||node.parentElement===target)return;
    const focused=document.activeElement,active=focused instanceof HTMLElement&&node.contains(focused)?focused:undefined;target.append(node);
    if(active){const closed=target.closest<HTMLDetailsElement>('details:not([open])');if(closed)closed.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});else if(!active.hidden)active.focus({preventScroll:true});}
  }
  private paintOriginalOperationsVisibility(){
    const host=document.getElementById('pf-original-operations');if(host)host.hidden=!['pf-note-recovery','pf-live-support-recovery','pf-support-recovery','pf-template-recovery'].some(id=>{const node=document.getElementById(id);return node&&!node.hidden;});
  }
  private paintPreparationView(){
    if(!this.live()||!document.querySelector('#pf-package-overview'))return;
    const selected=PROJECT_DOCUMENT_CATALOG.filter(d=>this.selected.has(d.id));
    document.querySelector('#pf-note-summary')!.textContent=this.noteOperation?'原要求保存待确认':!this.noteStored?'有未保存要求 · 本机未保留':this.note.trim()?'有未保存要求':'尚未填写';
    const noteAttention=!!this.noteOperation||!this.noteStored,noteRecovery=document.getElementById('pf-note-recovery')!,preview=document.getElementById('pf-note-recovery-preview')!;
    noteRecovery.hidden=!noteAttention;document.querySelector('#pf-note-recovery-label')!.textContent=this.noteOperation?'上次补充要求尚需确认，继续或停止只处理原保存范围。':'补充要求草稿暂未保存在本浏览器，请先确认保存结果。';
    preview.hidden=!this.noteOperation;preview.textContent=this.noteOperation?.note??'';
    this.movePreparationControls('pf-note-actions',noteAttention?'pf-note-recovery-actions':'pf-note-actions-slot');
    const supportRecovery=document.getElementById('pf-live-support-recovery')!;supportRecovery.hidden=!this.support;this.movePreparationControls('pf-support-actions',this.support?'pf-live-support-recovery':'pf-support-actions-slot');
    const materials=new Set(selected.flatMap(d=>this.state!.workspace.drafts[d.id].materials).map(m=>[m.source_project_id,m.material_id,m.material_version,m.sha256].join(':')));
    document.querySelector('#pf-support-summary')!.textContent=this.support?'原补充资料待确认':materials.size?`所选文件已采用 ${materials.size} 份`:'可按需补充';
    this.paintOriginalOperationsVisibility();
  }
  private template(type:M4DocumentType){const draft=this.state!.workspace.drafts[type],pin=draft.template;return this.state!.workspace.templates.find(t=>t.template_id===pin?.template_id&&t.template_version===pin.template_version&&t.sha256===pin.sha256&&t.status==='active'&&t.document_type===type&&t.market===draft.fields.market&&t.offering===draft.fields.offering);}
  private paintTemplates(){
    if(!this.live())return;this.capturePreparationView();
    const selected=[...this.selected].map(id=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===id)!),ready=selected.filter(d=>this.template(d.id));
    document.querySelector('#pf-count')!.textContent=this.selected.size+' 份';document.querySelector('#pf-prepared')!.textContent=`${ready.length} / ${selected.length} 已准备`;
    const rows:(M4DocumentType|'')[]=[...this.selected];if(this.blankRow||!rows.length)rows.push('');
    document.querySelector('#pf-template-list')!.innerHTML=rows.map((type,index)=>{
      const t=type?this.template(type):undefined,draft=type?this.state!.workspace.drafts[type]:undefined;
      const requirements=draft?[...draft.requirements.map(r=>r.text),draft.supplemental_requirements??''].filter(Boolean).join('\n\n'):'';
      return `<tr data-pf-row="${type}"><td class="pf-row-number">${String(index+1).padStart(2,'0')}</td><td class="pf-row-type"><select data-pf-document="${type}" aria-label="第 ${index+1} 行文件类型" ${this.busy?'disabled':''}><option value="" disabled ${type?'':'selected'}>选择要生成的文件</option>${PROJECT_DOCUMENT_CATALOG.map(d=>`<option value="${d.id}" ${d.id===type?'selected':this.selected.has(d.id)?'disabled':''}>${d.name}${d.id!==type&&this.selected.has(d.id)?'（已添加）':''}</option>`).join('')}</select></td><td class="pf-row-template">${type?`<div class="pf-row-template-name">${t?ico('file'):''}<span>${t?esc(t.name)+' <small>V'+t.template_version+'</small>':'<span class="pf-template-missing">待添加模板</span>'}</span></div>${draft?`<details class="pf-reused-inputs" data-pf-reused="${type}" ${this.reusedExpanded.has(type)?'open':''}><summary>已保存的要求与依据 · ${draft.materials.length} 份资料${requirements?' · 有要求':''}</summary><p data-pf-saved-requirements="${type}">${requirements?esc(requirements):'尚无个别要求。'}</p><ul>${draft.materials.map(m=>`<li>${esc(this.materialName(m))}</li>`).join('')||'<li>直接使用募集书和模板，可按需补充依据。</li>'}</ul></details>`:''}`:'<span class="pf-row-placeholder">选择文件类型后添加模板</span>'}</td><td class="pf-row-actions">${type?`<button class="btn secondary" data-pf-template="${type}">${t?'更换模板':'添加模板'}</button>`:''}<button class="text-button" data-pf-remove="${type}" aria-label="移除第 ${index+1} 行" ${!type&&!this.selected.size?'disabled':''}>移除</button></td></tr>`;
    }).join('');
    const updateRows=(types:M4DocumentType[],focusIndex:number)=>{this.entryAdopted=undefined;this.dismissEntry();this.selected=new Set(types);this.saveSelection();this.paintTemplates();this.paintSupport();const controls=document.querySelectorAll<HTMLSelectElement>('[data-pf-document]');(controls[Math.min(focusIndex,controls.length-1)]??document.querySelector<HTMLButtonElement>('#pf-add-row'))?.focus();};
    document.querySelectorAll<HTMLSelectElement>('[data-pf-document]').forEach((select,index)=>select.addEventListener('change',()=>{if(this.busy)return;const type=select.value as M4DocumentType,old=select.dataset.pfDocument;if(!PROJECT_DOCUMENT_CATALOG.some(d=>d.id===type)||this.selected.has(type)){select.value=old??'';return;}const types=[...this.selected];if(old)types[index]=type;else{types.push(type);this.blankRow=false;}updateRows(types,index);}));
    document.querySelectorAll<HTMLButtonElement>('[data-pf-remove]').forEach((button,index)=>button.addEventListener('click',()=>{if(this.busy)return;const type=button.dataset.pfRemove;if(!type)this.blankRow=false;updateRows([...this.selected].filter(t=>t!==type),index);}));
    document.querySelector<HTMLButtonElement>('#pf-add-row')!.disabled=this.busy||this.selected.size===PROJECT_DOCUMENT_CATALOG.length;
    document.querySelectorAll<HTMLDetailsElement>('[data-pf-reused]').forEach(node=>node.addEventListener('toggle',()=>{if(node.isConnected&&this.live()){const type=node.dataset.pfReused as M4DocumentType;if(node.open)this.reusedExpanded.add(type);else this.reusedExpanded.delete(type);}}));
    document.querySelector('#pf-package-readiness')!.innerHTML=!selected.length?'<p>选择文件类型，开始准备本次清单。</p>':!this.prepared()?`<p>募集书依据已变化。<a href="${esc(this.href({step:'source',mode:'documents'}))}">先确认本轮募集书 →</a></p>`:ready.length===selected.length?`<p>已复用 ${ready.length} 份模板，可以核对文件包。</p>`:`<p>还需为 ${selected.length-ready.length} 份文件添加模板。<button class="text-button" id="pf-go-template">前往准备 ↓</button></p>`;
    document.querySelector('#pf-go-template')?.addEventListener('click',()=>{const list=document.querySelector<HTMLElement>('#pf-template-list')!;list.tabIndex=-1;list.scrollIntoView({block:'start'});list.focus({preventScroll:true});});
    document.querySelector('#pf-price')!.textContent=selected.length?`${selected.length} 份全部完成共 ${this.filePrice(selected.length)}`:'请选择需要生成的文件';
    document.querySelector<HTMLButtonElement>('#pf-generate')!.disabled=!selected.length||ready.length!==selected.length||!this.prepared()||this.busy||!!this.support||!!this.noteOperation||this.hasPendingUploads()||!!this.entryIntent||this.cacheUnknown;
    const saveNote=document.querySelector<HTMLButtonElement>('#pf-save-requirements')!;saveNote.disabled=(!this.noteOperation&&!selected.length)||!this.note.trim()||this.busy;saveNote.textContent=this.noteOperation?'继续保存原范围':'保存到所选文件';
    document.querySelector<HTMLButtonElement>('#pf-stop-note')!.hidden=!this.noteOperation;
    document.querySelector<HTMLTextAreaElement>('#pf-requirements')!.disabled=!!this.noteOperation;
    if(this.noteOperation)document.querySelector('#pf-note-status')!.textContent='仍需确认上次补充要求，保存范围固定为：'+this.noteOperation.documents.map(item=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===item.document_type)!.name).join('、')+'。';
    this.paintSupportUpload();
    document.querySelector<HTMLButtonElement>('#pf-retry-support')!.hidden=!this.support;
    document.querySelector<HTMLButtonElement>('#pf-stop-support')!.hidden=!this.support;
    const source=this.state!.source;if(source)document.querySelector('#pf-source-summary')!.innerHTML=`<strong>${esc(source.filename)}</strong><small>本次生成依据 · V${source.sequence} · ${esc(this.project!.name)}</small>`;
    document.querySelectorAll<HTMLButtonElement>('[data-pf-template]').forEach(b=>b.addEventListener('click',()=>this.templateModal(b.dataset.pfTemplate as M4DocumentType)));
    this.paintUploadRecovery();this.paintPreparationView();this.paintEntryIntent();
  }
  private templateModal(type:M4DocumentType){
    const d=this.state!.workspace.drafts[type],selected=this.template(type),candidates=this.state!.workspace.templates.filter(t=>t.document_type===type&&t.market===d.fields.market&&t.offering===d.fields.offering&&t.status==='active');
    const dialog=this.modal(PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name+' · 历史文件 / 模板',`<p>添加一次，后续生成自动复用。新版本不会删除旧模板。</p><form id="pf-template-form">${type==='init'?`<label>立项券商全称<input name="broker" value="${esc(d.fields.broker??'')}" required maxlength="200"/></label>`:''}<label>上传历史文件 / 模板${uploadPicker('<input type="file" name="file" accept=".docx" required/>')}</label><p class="muted">Word（DOCX）· 单份不超过 100 MB</p><p>选择文件后自动上传并用于此类文件。${type==='init'?'请先填写立项券商全称。':''}</p><button class="btn primary" hidden>重试保存模板</button></form><h3>从已保存模板库选用</h3>${candidates.map(t=>`<div class="pf-template-row"><div><strong>${esc(t.name)}</strong><small>V${t.template_version} · ${esc(date(t.created_at))}</small></div><button class="btn secondary" data-use-template="${esc(t.template_id)}" data-version="${t.template_version}" ${selected?.template_id===t.template_id&&selected.template_version===t.template_version?'disabled':''}>选用</button></div>`).join('')||'<p class="muted">尚无此类型和市场品种的模板。</p>'}`);
    const apply=async(t:M4Template)=>{const fresh=await this.request<Workspace>('GET','/workspace');this.state=fresh;const {version,sha256:_sha,updated_at:_at,...input}=structuredClone(this.state.workspace.drafts[type]);input.template={template_id:t.template_id,template_version:t.template_version,sha256:t.sha256};input.fields.broker=t.broker;
      const saved=await this.m4.draft(this.state!.workspace.topic.topic_id,{expected_version:version,input});this.state!.workspace.drafts[type]=saved.draft;if(!this.state!.workspace.templates.some(x=>x.template_id===t.template_id&&x.template_version===t.template_version))this.state!.workspace.templates.push(t);dialog.close();this.paintTemplates();};
    let uploadFailed=false;
    const input=dialog.querySelector<HTMLInputElement>('[name=file]')!,broker=dialog.querySelector<HTMLInputElement>('[name=broker]'),retry=dialog.querySelector<HTMLButtonElement>('form button')!;
    const controls=()=>{input.disabled=this.busy||!!pending?.upload.operationId||!!broker&&!broker.value.trim();if(broker)broker.disabled=this.busy||!!pending?.upload.operationId;retry.hidden=this.busy||!uploadFailed;for(const b of dialog.querySelectorAll<HTMLButtonElement>('[data-use-template]'))b.disabled=this.busy||!!pending?.upload.operationId||!!selected&&selected.template_id===b.dataset.useTemplate&&selected.template_version===Number(b.dataset.version);};
    const execute=async(fn:()=>Promise<void>)=>{if(this.busy)return;this.busy=true;uploadFailed=false;controls();const status=dialog.querySelector('#pf-modal-status')!;status.innerHTML=uploadProgressHtml(uploadActivity('正在准备文件…'),'文件',{announce:false}); try{await fn();}catch(e){uploadFailed=true;if(this.live())status.textContent=friendlyError(e,'save');}finally{this.busy=false;controls();if(this.live())this.paintTemplates();}};
    let pending:{file:File;upload:UploadFileMaterialState}|undefined;
    dialog.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();void execute(async()=>{
      const file=dialog.querySelector<HTMLInputElement>('[name=file]')!.files![0];if(!file||!file.name.toLowerCase().endsWith('.docx'))throw new UserFacingError('历史文件 / 模板请选择 DOCX。');
      pending??={file,upload:{}};
      const {version,sha256:_sha,updated_at:_at,...input}=structuredClone(d);
      const context:GenerationUploadContext={kind:'template',topic:this.state!.workspace.topic.topic_id,types:[type],templateBase:{expected_version:version,input},templateRequest:{creation_request_id:crypto.randomUUID(),name:file.name,broker:dialog.querySelector<HTMLInputElement>('[name=broker]')?.value.trim()??'',document_type:type,market:d.fields.market as M4Template['market'],offering:d.fields.offering as M4Template['offering'],...(selected?{replaces_template_id:selected.template_id}:{})}};
      await prepareFileMaterial(this.api,this.id!,file,this.controller.signal,pending.upload,this.owner??'','generation-template',uploadJson(context),()=>this.live());
      await this.continueGenerationUpload('generation-template',pending.upload.operationId!,file,s=>{dialog.querySelector('#pf-modal-status')!.textContent=s;},pending.upload);dialog.close();this.paintTemplates();
    });});
    controls();broker?.addEventListener('input',controls);
    input.addEventListener('change',()=>{if(input.files?.length&&!this.busy)dialog.querySelector('form')!.requestSubmit();});
    dialog.querySelectorAll<HTMLButtonElement>('[data-use-template]').forEach(b=>b.addEventListener('click',()=>void execute(()=>apply(candidates.find(t=>t.template_id===b.dataset.useTemplate&&t.template_version===Number(b.dataset.version))!))));
  }
  private materialName(pin:M4MaterialPin){return this.state!.workspace.material_details.find(m=>m.source_project_id===pin.source_project_id&&m.material_id===pin.material_id&&m.material_version===pin.material_version&&m.sha256===pin.sha256)?.filename??'已保存的补充资料';}
  private paintSupport(){if(!this.live())return;const node=document.querySelector('#pf-support-list');if(!node)return;const types=this.support?.types??[...this.selected],materials=[...new Map(types.flatMap(type=>this.state!.workspace.drafts[type].materials).map(m=>[[m.source_project_id,m.material_id,m.material_version,m.sha256].join(':'),m])).values()];node.textContent=this.support?`仍需确认 ${this.support.files.length} 份补充资料，保存范围固定为：${this.support.types.map(type=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name).join('、')}。`:types.length?`所选文件已采用 ${materials.length} 份补充资料；各文件的具体依据可展开对应行查看。`:'先选择文件，再按需补充依据。';this.paintPreparationView();}
  private paintSupportUpload(){
    const input=document.querySelector<HTMLInputElement>('#pf-support'),button=document.querySelector<HTMLButtonElement>('#pf-support-upload'),hint=document.querySelector('#pf-support-upload-hint');if(!input||!button||!hint)return;
    input.disabled=button.disabled=!this.selected.size||!!this.support||this.busy;
    if(this.busy){const feedback=document.querySelector('#pf-support-feedback');if(feedback)feedback.textContent='';}
    button.setAttribute('aria-busy',String(this.busy&&!!this.support));if(button.disabled)button.classList.remove('is-dragging');
    hint.textContent=this.busy?'正在处理，请稍候':this.support?'请先处理上方待确认的资料':!this.selected.size?'先在上方添加要生成的文件':'点击选择，或将文件拖到此处';
  }
  private async addSupport(files:File[]){
    if(this.busy||this.pendingBatch)return;
    const report=(message:string,isError=false)=>{this.status(message);if(!this.live())return;const feedback=document.querySelector('#pf-support-feedback');if(feedback){feedback.textContent=message;feedback.classList.toggle('is-error',isError);}};
    if(files.length){if(this.support){report('请先确认上次补充资料的保存结果。',true);return;}if(!this.selected.size)return;try{files.forEach(fileMaterialMime);}catch(e){report(friendlyError(e,'save'),true);return;}this.support={files:files.map(file=>({file,state:{}})),types:[...this.selected]};}
    if(!this.support)return;
    await this.act(async()=>{
      report(`正在上传并保存 ${this.support!.files.length} 份补充依据…`);
      this.state=await this.request<Workspace>('GET','/workspace');
      const supportBases:GenerationUploadContext['supportBases']={};for(const type of this.support!.types){const {version,sha256:_sha,updated_at:_at,...input}=structuredClone(this.state.workspace.drafts[type]);supportBases[type]={expected_version:version,input};}
      const context:GenerationUploadContext={kind:'support',topic:this.state.workspace.topic.topic_id,types:[...this.support!.types],supportBases};
      // Keep the whole selected batch discoverable before the first network upload.
      for(const item of this.support!.files)await prepareFileMaterial(this.api,this.id!,item.file,this.controller.signal,item.state,this.owner??'','generation-support',uploadJson(context),()=>this.live());
      for(const item of this.support!.files){
        if(item.pin)continue;
        item.pin=await this.continueGenerationUpload('generation-support',item.state.operationId!,item.file,report,item.state);
      }
      this.support=undefined;report('补充依据已保存，可在上方对应文件行查看。');
    });report(this.message,!!this.support);this.paintSupport();this.paintUploadRecovery();
  }
  private paintUploadRecovery(){
    if(!this.live()||!document.querySelector('#pf-template-list'))return;
    for(const purpose of ['generation-support','generation-template']){
      const hostId=purpose==='generation-support'?'pf-support-recovery':'pf-template-recovery';
      let host=document.getElementById(hostId);if(!host){host=document.createElement('div');host.id=hostId;document.querySelector(purpose==='generation-support'?'#pf-support-list':'#pf-template-list')!.insertAdjacentElement('afterend',host);}
      try{
        const records=this.owner?this.uploadRecovery(purpose).list():[];
        host.hidden=!records.length;
        host.innerHTML=records.map(r=>{const c=this.generationContext(r);return `<article class="pf-prepared-file bb-upload-file"><strong>${esc(r.declaration.filename)}</strong><p>原${c.kind==='template'?'模板':'补充资料'}保存范围：${c.types.map(t=>PROJECT_DOCUMENT_CATALOG.find(d=>d.id===t)!.name).join('、')}。确认后只继续原保存，尚未生成文件。</p><label ${this.reselectUploads.has(r.id)?'':'hidden'}>${uploadPicker(`<input type="file" data-generation-file="${esc(r.id)}" accept="${c.kind==='template'?'.docx':'.docx,.pdf,.xlsx'}"/>`,{size:'compact',label:'重新选择原文件'})}</label><button type="button" class="bb-upload-action bb-upload-action--primary text-button" data-generation-resume="${esc(r.id)}">继续确认原保存</button><button type="button" class="bb-upload-action text-button" data-generation-forget="${esc(r.id)}">取消本次上传</button></article>`;}).join('');
        host.querySelectorAll<HTMLButtonElement>('[data-generation-resume]').forEach(b=>b.addEventListener('click',()=>{const file=[...host!.querySelectorAll<HTMLInputElement>('[data-generation-file]')].find(input=>input.dataset.generationFile===b.dataset.generationResume)?.files?.[0];void this.act(async()=>{const pin=await this.continueGenerationUpload(purpose,b.dataset.generationResume!,file,s=>this.status(s));const item=this.support?.files.find(item=>item.state.operationId===b.dataset.generationResume);if(item)item.pin=pin;if(this.support?.files.every(item=>!!item.pin))this.support=undefined;this.paintSupport();this.status('原范围的保存已确认，尚未生成文件。');});}));
        host.querySelectorAll<HTMLInputElement>('[data-generation-file]').forEach(input=>input.addEventListener('change',()=>{if(input.files?.length)input.closest('article')?.querySelector<HTMLButtonElement>('[data-generation-resume]')?.click();}));
        host.querySelectorAll<HTMLButtonElement>('[data-generation-forget]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.uploadRecovery(purpose).forget(b.dataset.generationForget!);if(this.support){this.support.files=this.support.files.filter(item=>item.state.operationId!==b.dataset.generationForget);if(!this.support.files.length)this.support=undefined;}this.paintSupport();this.status('已停止本机记录的后续保存。服务器此前收到或保存的材料保留，此操作不删除材料。');},'action')));
      }catch(e){host.hidden=false;host.textContent=friendlyError(e,'read');}
    }
    this.paintOriginalOperationsVisibility();
  }
  private async continueGenerationUpload(purpose:string,id:string,file:File|undefined,status:(message:string)=>void,state:UploadFileMaterialState={operationId:id}){
    const recovery=state.recovery??this.uploadRecovery(purpose);
    const record=recovery.list().find(r=>r.id===id);if(!record)throw new UserFacingError('原上传记录已变化，请重新读取。');
    let context=this.generationContext(record);
    if(context.kind==='template'&&file&&!file.name.toLowerCase().endsWith('.docx'))throw new UserFacingError('历史文件 / 模板请选择原 DOCX。');
    const report:UploadStatus=(s,p)=>{status(s);if(!this.live())return;const host=this.dialog?.open?this.dialog.querySelector('#pf-modal-status'):document.querySelector(purpose==='generation-template'?'#pf-status':'#pf-support-feedback')??document.querySelector('#pf-status');if(host)host.innerHTML='<strong>'+esc(record.declaration.filename)+'</strong>'+uploadProgressHtml(p??uploadActivity(s),record.declaration.filename,{announce:false});};
    const pin=await uploadFileMaterial(this.api,this.id!,file,this.controller.signal,report,state,this.owner,purpose,undefined,()=>this.live()).catch(error=>{if(error instanceof UploadRecoveryNeedsFileError)this.reselectUploads.add(id);throw error;});this.reselectUploads.delete(id);
    this.state=await this.request<Workspace>('GET','/workspace');
    if(this.state.workspace.topic.topic_id!==context.topic)throw new UserFacingError('原资料所属工作区已变化，请保留原记录并核对。');
    await this.m4.material(context.topic,pin);
    let template:M4Template|undefined;
    if(context.kind==='template'){
      const request={...context.templateRequest!,material:pin};
      if(!Value.Check(M4TemplateCreateRequestSchema,request)||request.document_type!==context.types[0])throw new UserFacingError('原模板创建条件无法核实，请保留原记录。');
      template=(await this.m4.template(request)).template;
      if(template.document_type!==request.document_type||template.broker!==request.broker||request.market&&template.market!==request.market||request.offering&&template.offering!==request.offering||canonical(template.material)!==canonical(pin)||!Number.isSafeInteger(template.template_version)||template.template_version<1)throw new UserFacingError('模板保存回执与原请求不一致，请保留原记录。');
    }
    const saveContext=async(next:GenerationUploadContext)=>{await recovery.updateContext(id,uploadJson(next));context=next;};
    const apply=async(request:M4DraftRequest)=>{
      const draft=this.state!.workspace.drafts[request.input.document_type],{version,sha256:_hash,updated_at:_at,...currentInput}=structuredClone(draft);
      if(canonical(currentInput)!==canonical(request.input)){
        if(version!==request.expected_version)throw new UserFacingError('原保存范围已在其他页面修改。请核对当前内容；原请求保留，尚未覆盖。');
        this.state!.workspace.drafts[request.input.document_type]=(await this.m4.draft(context.topic,request)).draft;
      }
      const {apply:_applied,...rest}=context;await saveContext(rest);
    };
    if(context.apply)await apply(context.apply);
    for(const type of context.types){
      const draft=context.kind==='template'?context.templateBase!:undefined;
      const {version,sha256:_sha,updated_at:_at,...currentInput}=structuredClone(this.state.workspace.drafts[type]);
      const input=structuredClone(draft?.input??currentInput);
      if(context.kind==='support'){
        const {materials:_currentMaterials,...currentBasis}=currentInput,{materials:_originalMaterials,...originalBasis}=context.supportBases![type]!.input;
        if(canonical(currentBasis)!==canonical(originalBasis))throw new UserFacingError('原保存范围已在其他页面修改。请核对当前内容；原请求保留，尚未覆盖。');
        if(input.materials.some(m=>canonical(m)===canonical(pin)))continue;
        if(input.materials.length>=60)throw new UserFacingError('原范围的补充资料已达 60 份，请整理后再继续。');
        input.materials.push(pin);
      }else{
        const t=template!;if(canonical(input.template)===canonical({template_id:t.template_id,template_version:t.template_version,sha256:t.sha256})&&input.fields.broker===t.broker)continue;
        input.template={template_id:t.template_id,template_version:t.template_version,sha256:t.sha256};input.fields.broker=t.broker;
      }
      const request={expected_version:draft?.expected_version??version,input};await saveContext({...context,apply:request});await apply(request);
    }
    if(template){
      // The workspace was read before template creation. Update the catalog as well
      // as the saved draft so readiness and the picker agree without a reload.
      this.state.workspace.templates=this.state.workspace.templates.filter(t=>t.template_id!==template!.template_id||t.template_version!==template!.template_version);
      this.state.workspace.templates.push(template);
    }
    await recovery.forget(id);status('文件已保存，原材料选择已确认。');const progressHost=this.dialog?.open?this.dialog.querySelector('#pf-modal-status'):document.querySelector(purpose==='generation-template'?'#pf-status':'#pf-support-feedback');if(progressHost)progressHost.textContent='文件已保存，原材料选择已确认。';return pin;
  }
  private async prepareGeneration(){await this.act(async()=>{
    if(this.cacheUnknown)throw new UserFacingError('原准备记录暂不可读取，请先重新读取。');
    if(this.entryIntent)throw new UserFacingError('请先确认这次所选文种与上次准备的处理方式。');
    if(this.pendingBatch){this.paintRecovery();return;}
    if(this.hasPendingUploads())throw new UserFacingError('请先确认原上传保存，或明确停止继续保存，再核对文件包。');
    if(!this.selected.size||this.support)return;
    await this.saveRequirements();
    this.state=await this.request<Workspace>('GET','/workspace');
    if(!this.live())return;
    if(!this.prepared()||[...this.selected].some(type=>!this.template(type)))throw new UserFacingError('募集书依据或模板已变化，请核对当前准备状态后再生成。');
    if(this.state.batches.some(b=>['queued','running','paused'].includes(b.state)))throw new UserFacingError('已有文件包尚未结束，请先在生成任务中处理。');
    const s=this.state.source!,documents=PROJECT_DOCUMENT_CATALOG.filter(d=>this.selected.has(d.id)).map(d=>({document_type:d.id,draft_version:this.state!.workspace.drafts[d.id].version}));
    let body:FileGenerationBatchRequest={request_id:crypto.randomUUID(),source_version_id:s.version_id,expected_selection_revision:s.selection_revision,documents};
    const quote=isCnyPrice(this.state.price)?await this.request<Dto<'ProjectFileBatchQuoteResponse'>>('POST','/batches/quote',body):undefined;
    if(!this.live())return;
    if(quote){
      if(quote.documents.length!==documents.length||documents.some(doc=>!quote.documents.some(item=>item.document_type===doc.document_type&&item.draft_version===doc.draft_version)))throw new ApiError(0,'DATA_UNAVAILABLE');
      if(scopeStatus(quote)!=='ready'||quote.documents.some(item=>scopeStatus(item)!=='ready')){const blocked=quote.documents.find(item=>scopeStatus(item)!=='ready')??quote;const pending=this.modal(scopeStatusLabel(blocked),scopeLifecycleHtml(blocked)+'<button class="btn primary" id="pf-refresh-scope">刷新范围报价</button>');pending.querySelector('#pf-refresh-scope')!.addEventListener('click',()=>{pending.close();void this.prepareGeneration();});return;}
      if(quote.documents.some(item=>!item.scope_quote_id)||quote.documents.reduce((n,item)=>n+int64(item.points),0n)!==int64(quote.points))throw new ApiError(0,'DATA_UNAVAILABLE');
      const priceVersion=quote.documents[0]?.price_version??OUTCOME_PRICE_VERSION;
      if(!isOutcomePriceVersion(priceVersion))throw new ApiError(0,'DATA_UNAVAILABLE');
      body={...body,price_version:priceVersion,expected_points:quote.points,documents:documents.map(doc=>({...doc,scope_quote_id:quote.documents.find(item=>item.document_type===doc.document_type)!.scope_quote_id!}))};
    }
    if(quote&&quote.documents.every(isAutomaticCharge)){await this.submitGeneration(body);return;}
    this.capturePreparationView();
    this.shell(`${this.header('confirm')}<section class="panel pf-flow-confirm"><h2>确认本次生成</h2><p>核对募集说明书、生成范围及预计积分。</p><div class="pf-confirm-section"><h3>募集说明书</h3><p>${esc(s.filename)} · V${s.sequence}</p></div><div class="pf-confirm-section"><h3>生成内容 · ${documents.length} 份文件</h3><ul class="pf-confirm-files">${documents.map(({document_type})=>{const template=this.template(document_type)!;return `<li><strong>${PROJECT_DOCUMENT_CATALOG.find(d=>d.id===document_type)!.name}</strong><span>${esc(template.name)} · V${template.template_version}</span>${quote?'<span>'+displayPrice(quote.documents.find(item=>item.document_type===document_type))+'</span>'+scopeLinesHtml(quote.documents.find(item=>item.document_type===document_type))+scopeLifecycleHtml(quote.documents.find(item=>item.document_type===document_type)):''}</li>`;}).join('')}</ul></div><p class="pf-confirm-total">${documents.length} 份全部完成共 <strong>${quote?cny(quote.points):this.filePrice(documents.length)}</strong></p>${isCnyPrice(this.state.price)?'<p>每份包含正文Word和编制说明，按所选模板及固定募集书生成工作稿，待确认内容明确列示。确认后预留总价，各份按约定交付结算；未交付部分释放。原范围修正和平台重试包含，新范围另行确认。</p>':'<p>每份包含正文 Word 和编制说明。按顺序逐份处理，按有效处理时间和已完成工作扣减；排队和暂停不扣积分。</p><p>有积分即可开始；余额用完保存后暂停。主动结束保留已扣部分，平台失败退回已扣积分。后续新增要求用于下一轮。</p>'}<p id="pf-status" role="status"></p><footer class="pf-footer"><button class="btn secondary" id="pf-back-to-prepare">上一步：调整文件</button><button class="btn primary" id="pf-confirm-generation">确认并开始生成</button></footer></section>`,'generate');
    document.querySelector('#pf-back-to-prepare')!.addEventListener('click',()=>{if(!this.busy)void this.paint();});
    document.querySelector('#pf-confirm-generation')!.addEventListener('click',()=>{if(this.busy)return;if(quote&&quote.documents.some(item=>scopeStatus(item)!=='ready')){this.status('报价已过期，未开始；准备内容保留，请返回重新核对。');return;}void this.generate(body);});this.status('文件包已准备，请核对范围和费用。');
  });}
  private async generate(body=this.pendingBatch){if(!body)return;await this.act(()=>this.submitGeneration(body),'submit');}
  private async submitGeneration(body:FileGenerationBatchRequest){
    const replay=!!this.pendingBatch&&this.pendingUncertain;
    if(!this.pendingBatch){this.pendingBatch=body;this.pendingStored=this.cache?.savePending(body)??false;if(!this.pendingStored){this.pendingBatch=undefined;throw new UserFacingError('浏览器暂无法保存本次提交记录，请允许会话存储后重试。任务尚未提交。');}}
    try{
      const batch=await this.request<ProjectFileBatch>('POST','/batches',this.pendingBatch,billingRecoveryHeaders('ProjectFileBatchRequest',this.pendingBatch));
      if(!Value.Check(ProjectFileBatchSchema,batch)||batch.items.length!==this.pendingBatch.documents.length||batch.items.some((item,i)=>item.document_type!==this.pendingBatch!.documents[i].document_type))throw new ApiError(0,'DATA_UNAVAILABLE');
      this.cache?.clearPending();this.pendingBatch=undefined;this.pendingUncertain=false;this.pendingStored=false;
      if(!this.live())return;
      const next=this.href({step:'results'});if(location.hash===next){this.state!.batches=[batch,...this.state!.batches.filter(b=>b.batch_id!==batch.batch_id)];this.paintResults();}else location.hash=next;
    }catch(e){
      if(e instanceof ApiError&&e.status===409&&e.code==='PROJECT_FILE_BATCH_INPUT_EXPIRED'){
        this.pendingExpired=true;this.status('服务已确认原文件包未提交，募集书或文件准备版本已变化。请返回准备，按当前版本重新核对。');this.paintRecovery();return;
      }
      // A rejection of the first attempt proves only that attempt did not create a batch.
      // After any uncertain response, even a 4xx may precede lookup of an older receipt.
      if(!replay&&e instanceof ApiError&&[400,402,403,404,409,422].includes(e.status)){
        this.cache?.clearPending();this.pendingBatch=undefined;this.pendingStored=false;throw e;
      }
      this.pendingUncertain=true;this.status('上次提交结果尚未确认，原文件范围和版本已保留。请确认同一次提交后再准备下一轮。');this.paintRecovery();
    }
  }
  private paintRecovery(){
    if(!this.live()||!this.pendingBatch||!this.state)return;const pending=this.pendingBatch,source=this.state.source;
    this.shell(`${this.header('documents')}<section class="panel pf-generation-recovery"><h2>${this.pendingExpired?'原文件包未提交，请按当前版本重新准备':'确认上次文件包是否已提交'}</h2><p>已保留上次确认的 ${pending.documents.length} 份文件和募集书依据。重新打开页面不会自动生成。</p><p>本次仍核对${source?.version_id===pending.source_version_id?esc(source.filename)+'（V'+source.sequence+'）':'此前确认的募集书版本'}；现在更换的募集书、模板或要求不会带入这次提交。</p><ul>${pending.documents.map(d=>`<li>${PROJECT_DOCUMENT_CATALOG.find(c=>c.id===d.document_type)!.name}</li>`).join('')}</ul><p>同一次提交只创建一个文件包。若原请求未被接收且依据已变化，服务会拒绝这次提交。</p>${this.pendingExpired?'<button class="btn primary" id="pf-reprepare">返回准备，重新核对</button>':'<button class="btn primary" id="pf-retry-batch">确认上次提交</button>'}<p id="pf-status" role="status">${esc(this.message)}</p><a class="text-button" href="${esc(this.filesHref())}">先返回项目文件，稍后继续确认 →</a></section>`,'generate');
    this.paintEntryIntent();document.querySelector('#pf-retry-batch')?.addEventListener('click',()=>void this.generate());
    document.querySelector('#pf-reprepare')?.addEventListener('click',()=>void this.act(async()=>{this.state=await this.request<Workspace>('GET','/workspace');this.cache?.clearPending();this.pendingBatch=undefined;this.pendingStored=false;this.pendingUncertain=false;this.pendingExpired=false;this.status('原文件包未提交，请按当前募集书和文件要求重新核对。');const next=this.href({step:'documents'});if(location.hash===next)await this.paint();else location.hash=next;},'read'));
  }
  private async saveRequirements(){
    const note=this.noteOperation?.note??this.note.trim(),types=[...this.selected];if(!note)return;if(!this.noteOperation&&!types.length)throw new UserFacingError('请先选择要使用这份补充要求的文件。');if(this.pendingBatch)throw new UserFacingError('请先确认上次提交。');
    this.state=await this.request<Workspace>('GET','/workspace');
    if(!this.noteOperation){
      const documents=types.map(document_type=>{const before=this.state!.workspace.drafts[document_type].supplemental_requirements??'';return {document_type,before,after:before===note||before.endsWith('\n\n'+note)?before:before?before+'\n\n'+note:note};});
      if(documents.some(item=>item.after.length>12000))throw new UserFacingError('部分文件的已有要求与本次补充合计超过 12,000 字，请缩短补充要求后再保存。');
      this.noteOperation={note,documents};
    }
    this.noteOperationStored=this.cache?.saveNoteOperation(this.noteOperation)??false;if(!this.noteOperationStored)throw new UserFacingError('浏览器暂无法保留本次补充要求的保存范围，尚未写入文件，请稍后重试。');
    for(const {document_type:type,before,after:text} of this.noteOperation.documents){
      const {version,sha256:_sha,updated_at:_at,...input}=structuredClone(this.state.workspace.drafts[type]);
      const current=input.supplemental_requirements??'';
      if(current===text||current.startsWith(text+'\n\n'))continue;
      if(current!==before)throw new UserFacingError('原保存范围中的文件要求已在其他页面修改。请核对后停止本次后续保存，再按新要求补充。');
      input.supplemental_requirements=text;
      this.state.workspace.drafts[type]=(await this.m4.draft(this.state.workspace.topic.topic_id,{expected_version:version,input})).draft;
    }
    this.noteOperation=undefined;this.noteOperationStored=true;this.cache?.clearNoteOperation();this.note='';this.noteStored=true;if(this.cache&&!this.cache.clearNote())this.cache.saveNote('');const field=document.querySelector<HTMLTextAreaElement>('#pf-requirements');if(field)field.value='';const status=document.querySelector('#pf-note-status');if(status)status.textContent='补充要求已保存到原先选定的文件。';
  }
  private paintResults(){
    if(!this.live())return;
    if(this.cacheUnknown){clearTimeout(this.timer);void this.paint();return;}
    const s=this.state!,w=s.workspace;
    this.shell(`${this.header('results')}<section class="panel pf-results"><div class="pf-section-head"><div><h2>文件生成任务</h2><p>按每份文件的任务状态查看进度与成果，完成后归入项目文件，旧版本保留。</p></div><div class="pf-results-actions"><button class="btn secondary" id="pf-refresh-results">刷新生成状态</button><a class="btn secondary" href="${esc(this.href({step:'documents'}))}">准备下一轮文件</a></div></div>${s.batches.map(b=>`<section class="pf-batch" data-pf-batch="${esc(b.batch_id)}" data-pf-batch-state="${b.state}"><div class="pf-batch-heading"><h3>${{queued:'等待处理',running:'正在生成',paused:'需要处理',complete:'已完成',cancelled:'已停止后续生成'}[b.state]}</h3><div>${b.state==='paused'?'<button class="text-button" data-batch-retry="'+esc(b.batch_id)+'">重试未完成文件</button>':''}${['queued','running','paused'].includes(b.state)?'<button class="text-button" data-batch-cancel="'+esc(b.batch_id)+'">停止后续生成</button>':''}</div></div>${b.state==='cancelled'?'<p class="pf-batch-note">本轮尚未启动的文件不会继续生成。已启动的任务仍按各自状态处理，可在下方查看进度、下载成果或打开原任务。</p>':b.state==='paused'?'<p class="pf-batch-note">请先查看需要处理的文件。已启动的任务仍按各自状态显示，可刷新查看进度。</p>':''}${b.items.map(i=>{
      const task=w.tasks.find(t=>t.run.run_id===i.run_id),artifacts=task?.run.state==='succeeded'?task.artifacts.filter(a=>a.run_id===i.run_id&&a.document_type===i.document_type&&['document','preparation_note'].includes(a.kind)):[];
      const incomplete=!!i.run_id&&['succeeded','test_completed','failed','cancelled','rejected'].includes(i.state)&&(!task||task.run.state!==i.state||i.state==='succeeded'&&!['document','preparation_note'].every(kind=>artifacts.some(a=>a.kind===kind)));
      const label=i.run_id?(runStateLabel[i.state as keyof typeof runStateLabel]??i.state):b.state==='cancelled'?'本轮未启动，不会继续生成':b.state==='paused'?'本轮未启动，请先处理此文件包':'本轮尚未启动，等待前一份文件完成';
      return `<div class="pf-template-row pf-result-row" data-pf-document="${i.document_type}" data-pf-run="${esc(i.run_id??'')}" data-pf-item-state="${esc(i.state)}"><div><strong>${PROJECT_DOCUMENT_CATALOG.find(d=>d.id===i.document_type)?.name??''}</strong><small>${esc(label)}</small>${i.error?'<small class="pf-result-error">'+esc(i.error)+'</small>':''}${incomplete?'<small class="pf-result-sync">任务与成果尚未读取完整，可刷新生成状态或查看原任务。</small>':''}</div><div class="pf-result-actions">${artifacts.map(a=>`<button class="btn secondary" data-pf-download="${a.artifact_id}">${a.kind==='document'?'下载文件':'编制说明'}</button>`).join('')}${i.run_id?`<a class="btn secondary" href="${esc('#generate?'+withProjectContext(new URLSearchParams({topic:w.topic.topic_id,run:i.run_id})))}">查看任务</a>`:''}</div></div>`;
    }).join('')}</section>`).join('')||'<p>暂无文件生成任务。</p>'}</section><footer class="pf-footer"><p id="pf-status" role="status">${esc(this.message)}</p><div><a class="btn secondary" href="${esc(this.filesHref())}">查看项目文件</a><a class="btn primary" href="${esc('#consistency?'+withProjectContext(new URLSearchParams({project:this.id!})))}">检查文件一致性</a></div></footer>`,'generate');
    this.paintEntryIntent();document.querySelectorAll<HTMLButtonElement>('[data-batch-retry],[data-batch-cancel]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      if(b.dataset.batchRetry&&!window.confirm('重试仅处理原文件包未完成的文件，沿用原已确认范围与计费规则。是否继续？')){this.status('未重试，原任务状态保留。');return;}
      const state=await this.request<Workspace>('POST','/batches/'+(b.dataset.batchRetry??b.dataset.batchCancel)+'/actions',{action:b.dataset.batchRetry?'retry':'cancel'});if(!this.live())return;this.state=state;this.resultsSettleReads=3;this.status(b.dataset.batchRetry?'已提交重试，请按每份文件的任务状态核对。':'已停止后续生成；已启动任务仍按各自状态处理。');this.paintResults();
    },b.dataset.batchRetry?'submit':'action')));
    document.querySelector('#pf-refresh-results')!.addEventListener('click',()=>void this.refreshResults(true));
    document.querySelectorAll<HTMLButtonElement>('[data-pf-download]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      const expected=w.tasks.flatMap(t=>t.artifacts).find(a=>a.artifact_id===b.dataset.pfDownload)!;
      const meta=await this.api.artifact(expected.artifact_id,this.controller.signal);if(meta.sha256!==expected.sha256||meta.version!==expected.artifact_version)throw new UserFacingError('文件版本已变化，请刷新后下载。');
      this.downloads.save(await this.api.artifactBytes(meta,this.controller.signal),expected.filename);this.status('文件已交给浏览器下载。');
    },'download')));
    this.lockPreparation();this.scheduleResults();
  }
  private resultsProgress(){
    const terminal=['succeeded','test_completed','failed','cancelled','rejected'],state=this.state;
    if(!state)return {active:false,incomplete:false};
    const active=state.batches.some(b=>['queued','running'].includes(b.state)||b.items.some(i=>i.run_id&&!terminal.includes(i.state)));
    const incomplete=state.batches.some(b=>b.items.some(i=>{
      if(!i.run_id||!terminal.includes(i.state))return false;const task=state.workspace.tasks.find(t=>t.run.run_id===i.run_id);
      return !task||task.run.state!==i.state||i.state==='succeeded'&&!['document','preparation_note'].every(kind=>task.artifacts.some(a=>a.run_id===i.run_id&&a.document_type===i.document_type&&a.kind===kind));
    }));
    return {active,incomplete};
  }
  private async refreshResults(manual=false){
    if(!this.live()||this.busy||this.cacheUnknown||this.pendingBatch||this.resultsReading!==undefined||new URLSearchParams(location.hash.split('?')[1]).get('step')!=='results'||!document.querySelector('#pf-refresh-results'))return;
    clearTimeout(this.timer);if(manual)this.resultsSettleReads=3;else if(!this.resultsProgress().active)this.resultsSettleReads=Math.max(0,this.resultsSettleReads-1);
    const request=++this.resultsRequest;this.resultsReading=request;this.lockPreparation();if(manual)this.status('正在刷新生成状态…');
    try{
      const state=await this.request<Workspace>('GET','/workspace');
      if(request!==this.resultsRequest||!this.live()||this.busy||this.cacheUnknown||this.pendingBatch||new URLSearchParams(location.hash.split('?')[1]).get('step')!=='results'||!document.querySelector('#pf-refresh-results'))return;
      this.state=state;if(this.resultsProgress().active)this.resultsSettleReads=3;this.resultsReading=undefined;this.status(manual?'生成状态已刷新。':'');this.paintResults();
    }catch(e){if(request===this.resultsRequest&&this.live()&&!this.cacheUnknown&&!this.pendingBatch&&document.querySelector('#pf-refresh-results'))this.status('刷新未成功，已保留上次读取的状态与成果。可手动刷新重试。'+friendlyError(e,'read'));}
    finally{if(this.resultsReading===request)this.resultsReading=undefined;if(request===this.resultsRequest&&this.live()){this.lockPreparation();this.scheduleResults();}}
  }
  private scheduleResults(){
    clearTimeout(this.timer);if(!this.live()||this.busy||this.cacheUnknown||this.pendingBatch||this.resultsReading!==undefined||new URLSearchParams(location.hash.split('?')[1]).get('step')!=='results'||!document.querySelector('#pf-refresh-results'))return;
    const progress=this.resultsProgress();if(!progress.active&&(!progress.incomplete||!this.resultsSettleReads))return;
    this.timer=setTimeout(()=>void this.refreshResults(),3000);
  }
}
