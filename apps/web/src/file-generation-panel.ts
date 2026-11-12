import './upload-ux.css';
import './upload-progress.css';
import {GenerationProgressSchema,generationBatchActive,type GenerationProgress} from '@bondbuddy/contracts';
import {TaskPoller} from './task-poller.js';
import {uploadActivity,uploadTransfer,uploadProgressHtml,type FileUploadProgress,type UploadStatus} from './upload-progress';
import {BILLING_WIRE_HEADER,BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION,formatPoints,int64,serializeInt64,FileGenerationSubmitSchema as LegacyFileGenerationSubmitSchema,type BillingWireVersion,type FileGenerationSubmit as LegacyFileGenerationSubmit} from '@bondbuddy/contracts';
import {PROJECT_DOCUMENT_CATALOG,M4_DOCUMENT_FIXED_PRICE,FileGenerationPreparationSchema,FileGenerationSubmitSchema,emptyFileGenerationPreparation,defaultWorkpaperIds,
 type SystemWorkpaperTemplates,type FileGenerationWorkspace,type FileGenerationPreparation,type FileGenerationSubmit,type FileGenerationQuote,type FileTemplateSet,type FileTemplateRecord,type FileTemplatePin,type FileTemplatePreview,type FileTemplateMatch,type FileGenerationBatch,type WorkpaperCatalogue,type WorkpaperCataloguePreview,type WorkpaperColumnMapping,type ProjectFileWorkspace,type M4DocumentType,type M4MaterialPin} from './billing-types';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError} from './api';
import {scopeLinesHtml,scopeLifecycleHtml} from './commerce';
import {UserFacingError} from './user-facing-error';
import {esc,date} from './ui';
import {uploadFileMaterial,type UploadFileMaterialState} from './file-workspace';
import {WorkpaperImportReview} from './workpaper-import-review';
import {UploadRecovery,UploadRecoveryNeedsFileError} from './upload-recovery';
import './file-generation-panel.css';
import {applyTemplateSuggestions} from './file-generation-template-matching';
const label=(type:string)=>type==='workpaper'?'尽职调查底稿包':PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)?.name??type;
const pin=(r:FileTemplateRecord):FileTemplatePin=>({set_id:r.set_id,record_id:r.record_id,sha256:r.sha256});
type UploadReceipt={request_id:string;sha256:string;filename:string;document_type:M4DocumentType;set_id?:string};
type PreparationSave={expected_revision:number;preparation:FileGenerationPreparation};
const preparationKey=(value:FileGenerationPreparation)=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const samePreparation=(a:FileGenerationPreparation,b:FileGenerationPreparation)=>preparationKey(a)===preparationKey(b);
export class FileGenerationPanel {
 private reselectUploads=new Set<string>();
 private uploadProgress?:FileUploadProgress; private uploadName="文件";
 private reportUpload:UploadStatus=(s,p)=>{if(!this.live())return;this.status=s;this.uploadProgress=p??uploadActivity(s);this.paint();};
 private controller=new AbortController();private data?:FileGenerationWorkspace;private prep=emptyFileGenerationPreparation();private cat?:WorkpaperCatalogue;
 private activeStep=2;private busy=false;private status='';private dirty=false;private storageError=false;private custom=false;private showMatches=false;private matches:FileTemplateMatch[]=[];
 private pending?:FileGenerationSubmit|LegacyFileGenerationSubmit;private pendingWire:BillingWireVersion=BILLING_WIRE_VERSION;private receipts:UploadReceipt[]=[];private dialog?:HTMLDialogElement;
 private progressRevision='';
 private poller=new TaskPoller({interval:15_000,active:()=>this.data?.batches.some(b=>!!b.workpapers&&generationBatchActive(b.workpapers)||!!b.documents&&generationBatchActive(b.documents))??false,
  live:()=>this.live(),blocked:()=>this.busy||!!this.modeController,refresh:(signal,force)=>this.refreshProgress(signal,force),
  failed:stopped=>{if(stopped){this.status='自动刷新已暂停，请刷新页面重试；后台任务继续。';if(!this.dirty&&!this.dialog?.open)this.paint();}}});
 private catalogueUpload:UploadFileMaterialState={};private cataloguePin?:M4MaterialPin;private review?:WorkpaperImportReview;private scope:'due_diligence'|'all'='due_diligence';
 private filter='';private onlyUnmapped=false;private matchPage=0;private showTemplateChoices=false;private showDocumentChoices=false;private focused?:string;private source:ProjectFileWorkspace['source'];
 private modeController?:AbortController;private modeStatus='';private modeDrafts:Partial<Record<'builtin'|'custom'|'automatic',FileGenerationPreparation>>={};
 private saving?:Promise<void>;private refreshing?:Promise<boolean>;private autosaveTimer?:ReturnType<typeof setTimeout>;private preparationSave?:PreparationSave;private saveNeedsRead=false;private saveFailure='';private revisionConflict=false;
 private historyRevision=0;private historyRead=0;
 constructor(private api:ApiClient,private host:HTMLElement,private project:string,private owner:string,private workspace:ProjectFileWorkspace,private current:()=>boolean,private stepChanged:(n:number)=>void=()=>{}){this.source=workspace.source;}
 private get key(){return `bb-file-generation-v2:${this.owner}:${this.project}`;}
 get hasUnconfirmed(){return this.busy||this.dirty||!!this.saving||!!this.preparationSave||!!this.pending||this.storageError||this.revisionConflict||!!this.modeController;}
 async beforeLeave(){if(this.busy||this.storageError||this.revisionConflict)return false;if(this.dirty||this.saving||this.preparationSave){try{await this.save();}catch{return false;}}return true;}
 dispose(){this.controller.abort();this.modeController?.abort();this.poller.dispose();clearTimeout(this.autosaveTimer);this.dialog?.remove();}
 private live(){return !this.controller.signal.aborted&&this.current()&&this.host.isConnected;}
 private request<T>(method:string,path='',body?:unknown,headers:Record<string,string>={},signal?:AbortSignal){if(body===this.pending&&this.pending)headers={...headers,[BILLING_WIRE_HEADER]:this.pendingWire};const bounded=method==='GET'||path==='/preparation'||path.startsWith('/template-preview');return this.api.request<T>(method,`/projects/${encodeURIComponent(this.project)}/file-generation${path}`,body,headers,signal??(bounded?AbortSignal.any([this.controller.signal,AbortSignal.timeout(30_000)]):this.controller.signal));}
 private wp<T>(method:string,path:string,body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.project)}/workpapers${path}`,body,{},this.controller.signal);}
 private persist(){try{localStorage.setItem(this.key,JSON.stringify({revision:this.data?.revision,preparation:this.prep,dirty:this.dirty,preparation_save:this.preparationSave,pending:this.pending,pending_wire:this.pendingWire,receipts:this.receipts,custom:this.custom,modeDrafts:this.modeDrafts}));this.storageError=false;}catch{this.storageError=true;throw new UserFacingError('本浏览器无法保存恢复记录，请恢复存储后重试；尚未提交生成任务。');}}
 async render(){
  this.host.innerHTML='<p role="status">正在读取目录与模板…</p>';
  try{
   this.data=await this.request<FileGenerationWorkspace>('GET');this.prep=structuredClone(this.data.preparation);
   const cached=JSON.parse(localStorage.getItem(this.key)??'null');let cacheMatchesRevision=cached?.revision===this.data.revision,recoveredSave=false;
   if(cached?.pending){this.pendingWire=cached.pending_wire??LEGACY_BILLING_WIRE_VERSION;if(![BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION].includes(this.pendingWire)||!Value.Check(this.pendingWire===LEGACY_BILLING_WIRE_VERSION?LegacyFileGenerationSubmitSchema:FileGenerationSubmitSchema,cached.pending))throw new UserFacingError('原提交记录无法核实，请保留记录并联系支持。');this.pending=cached.pending;}
   if(cached?.receipts)this.receipts=cached.receipts;
   if(cached?.dirty&&Value.Check(FileGenerationPreparationSchema,cached.preparation)){
    this.prep=cached.preparation;this.dirty=true;
    const attempt=cached.preparation_save;let recovered=false;
    if(Number.isInteger(attempt?.expected_revision)&&attempt.expected_revision>=0&&attempt.expected_revision===cached.revision&&Value.Check(FileGenerationPreparationSchema,attempt.preparation)){
     this.preparationSave=attempt;this.saveNeedsRead=true;
     if(this.data.revision===attempt.expected_revision+1&&samePreparation(this.data.preparation,attempt.preparation)){this.preparationSave=undefined;this.saveNeedsRead=false;this.dirty=!samePreparation(this.prep,this.data.preparation);recovered=true;cacheMatchesRevision=true;recoveredSave=true;}
    }
    if(cached.revision!==this.data.revision&&!recovered)this.revisionConflict=true;
    if(this.preparationSave||this.dirty)this.saveFailure='上次修改尚未确认保存，本地选择已保留。';
   }
   if(this.data.revision===0&&!cached?.dirty&&!this.pending){
    this.prep.workpaper_template_mode='automatic';
    const legacy=JSON.parse(localStorage.getItem(`bb-workpapers-v1:${this.owner}:${this.project}`)??'null');
    if(legacy?.catalogue&&!legacy.pending){this.prep.catalogue_id=legacy.catalogue;this.prep.item_ids=Array.isArray(legacy.selected)?legacy.selected:[];this.prep.requirements=typeof legacy.requirements==='string'?legacy.requirements:'';this.dirty=true;}
    const intended=new URLSearchParams(location.hash.split('?')[1]).get('prepare_document');
    if(intended&&PROJECT_DOCUMENT_CATALOG.some(t=>t.id===intended))this.prep.document_types=[intended as M4DocumentType];
    for(const d of PROJECT_DOCUMENT_CATALOG){const template=this.workspace.workspace.drafts[d.id].template;if(template)this.prep.document_templates[d.id]={private_template:template};}
   }
   if(this.prep.catalogue_id)this.cat=await this.wp<WorkpaperCatalogue>('GET','/catalogues/'+encodeURIComponent(this.prep.catalogue_id));
   this.custom=!this.automatic()&&this.set()?.origin==='private';
   if(cacheMatchesRevision){
    if(typeof cached.custom==='boolean')this.custom=cached.custom;
    for(const mode of ['builtin','custom','automatic'] as const)if(Value.Check(FileGenerationPreparationSchema,cached.modeDrafts?.[mode]))this.modeDrafts[mode]=cached.modeDrafts[mode];
   }
   if(recoveredSave)this.persist();
   if(this.cat){const valid=new Set(this.cat.entries.filter(e=>e.kind==='file').map(e=>e.id));this.prep.item_ids=this.prep.item_ids.filter(id=>valid.has(id));}
   this.showMatches=!this.automatic()&&!!this.cat&&!!this.missingTemplates().length;this.onlyUnmapped=this.showMatches;
   this.paint();this.poll();
   if(!this.cat&&this.prep.document_types.includes('workpaper')&&this.data.builtin.available&&!this.pending&&!this.storageError&&!this.revisionConflict)void this.loadDefaultCatalogue();
   else try{await this.readMatches();this.paint();}catch{this.status='目录和模板已保留，匹配暂不可用，可稍后重试。';this.paint();}
  }catch(e){if(this.live())this.host.innerHTML=`<p role="alert">${esc(friendlyError(e,'read'))}</p>`;}
 }
 private async save(){
  clearTimeout(this.autosaveTimer);
  if(this.storageError||this.revisionConflict)throw new UserFacingError('原准备清单与当前版本需要核对，请先重新载入。');
  try{this.dirty=!!this.preparationSave||!this.data!.revision||!samePreparation(this.prep,this.data!.preparation);this.persist();}catch(e){this.saveFailure=friendlyError(e,'save');this.paintSaveState();throw e;}
  if(this.saving)return this.saving;
  this.saveFailure='';const flight=this.drainSaves();this.saving=flight;this.paintSaveState();
  try{await flight;}catch(e){if(e instanceof ApiError&&e.code==='INPUT_REVISION_CONFLICT')this.revisionConflict=true;this.saveFailure=friendlyError(e,'save');throw e;}
  finally{this.saving=undefined;this.paintSaveState();}
 }
 private async drainSaves(){
  while(this.dirty||this.preparationSave||!this.data!.revision){
   if(this.saveNeedsRead&&this.preparationSave){
    const latest=await this.request<FileGenerationWorkspace>('GET'),attempt=this.preparationSave;
    if(latest.revision===attempt.expected_revision+1&&samePreparation(latest.preparation,attempt.preparation)){this.acceptSave(latest);continue;}
    if(latest.revision!==attempt.expected_revision){this.revisionConflict=true;throw new UserFacingError('另一页面已修改准备清单。本地选择已保留，请核对后重新载入。');}
    this.saveNeedsRead=false;
   }
   const attempt=this.preparationSave??{expected_revision:this.data!.revision,preparation:structuredClone(this.prep)};
   this.preparationSave=attempt;this.persist();
   try{
    const result=await this.request<{revision:number;preparation:FileGenerationPreparation}>('PUT','/preparation',attempt);
    if(result.revision!==attempt.expected_revision+1||!samePreparation(result.preparation,attempt.preparation))throw new UserFacingError('保存结果尚未核实，本地选择已保留，请重试。');
    this.acceptSave(result);
   }catch(e){this.saveNeedsRead=true;throw e;}
  }
 }
 private acceptSave(result:{revision:number;preparation:FileGenerationPreparation}){
  this.data!.revision=result.revision;this.data!.preparation=structuredClone(result.preparation);this.preparationSave=undefined;this.saveNeedsRead=false;
  this.dirty=!samePreparation(this.prep,result.preparation);this.persist();
 }
 private queueSave(){clearTimeout(this.autosaveTimer);if(!this.saveFailure&&!this.revisionConflict)this.autosaveTimer=setTimeout(()=>void this.save().catch(()=>{}),180);}
 private paintSaveState(){
  if(!this.live())return;
  const state=this.host.querySelector<HTMLElement>('#fg-save-state');
  if(state)state.textContent=this.revisionConflict?'另一页面已修改准备清单。本地选择已保留，请核对后重新载入。':this.storageError?'本浏览器无法保存恢复记录，请恢复存储后重试。':this.saveFailure?'保存尚未确认，本地选择已保留。'+this.saveFailure:this.saving?'正在保存，可继续调整选择；生成前将核对最新清单与费用。':this.dirty?'本地修改待保存；生成前将核对最新清单与费用。':'准备清单已保存。';
  const retry=this.host.querySelector<HTMLButtonElement>('#fg-save-retry');if(retry){retry.hidden=!this.saveFailure||this.revisionConflict||this.storageError;retry.disabled=!!this.saving||this.busy;}
  const reload=this.host.querySelector<HTMLButtonElement>('#fg-reload');if(reload){reload.hidden=!this.storageError&&!this.revisionConflict;reload.disabled=!!this.saving||this.busy;}
  const controls=this.host.querySelector<HTMLElement>('#fg-controls');if(controls)controls.inert=this.busy||!!this.pending||this.storageError||this.revisionConflict;
  const confirm=this.host.querySelector<HTMLButtonElement>('#fg-confirm');if(confirm&&(this.revisionConflict||this.storageError))confirm.disabled=true;
 }
 private async act(fn:()=>Promise<void>){if(this.busy)return;this.poller.pause();this.busy=true;this.paint();try{await fn();}catch(e){this.status=friendlyError(e,'save');}finally{this.busy=false;this.progressRevision='';this.poll();this.uploadProgress=undefined;if(this.live())this.paint();}}
 private change(fn:()=>void){if(this.busy||this.pending||this.storageError||this.revisionConflict)return;try{fn();this.dirty=true;this.persist();this.paint();this.queueSave();}catch(e){this.status=friendlyError(e,'save');this.paintSaveState();}}
 private set(){return this.data?.sets.find(s=>s.set_id===this.prep.template_set_id);}
 private record(p:FileTemplatePin|undefined){return p?this.data?.sets.find(s=>s.set_id===p.set_id)?.records.find(r=>r.record_id===p.record_id):undefined;}
 private automatic(){return this.prep.workpaper_template_mode==='automatic';}
 private missingTemplates(){return !this.automatic()&&this.prep.document_types.includes('workpaper')?this.prep.item_ids.filter(id=>!this.prep.mappings[id]):[];}
 private templateLabel(){return this.automatic()?'光大模板':this.set()?.origin==='builtin'?'光大模板（逐项指定）':this.set()?.name??'尚未选择 Word 模板包';}
 private async readMatches(adopt=false){
  const catalogueId=this.prep.catalogue_id,setId=this.prep.template_set_id;
  const matches=!this.automatic()&&catalogueId&&setId?(await this.request<{matches:FileTemplateMatch[]}>('GET',`/matches?catalogue_id=${encodeURIComponent(catalogueId)}&set_id=${encodeURIComponent(setId)}`)).matches:[];
  if(this.live()&&this.prep.catalogue_id===catalogueId&&this.prep.template_set_id===setId){this.matches=matches;
   if(adopt&&!this.automatic()){applyTemplateSuggestions(this.prep,this.matches,this.set());this.showMatches=!!this.missingTemplates().length;this.onlyUnmapped=true;this.matchPage=0;}
  }
 }
 private reviewTemplates(){this.showMatches=true;this.onlyUnmapped=true;this.filter='';this.matchPage=0;this.focused='#fg-matches';}
 private async matchTemplates(){await this.readMatches(true);await this.save();const missing=this.missingTemplates().length;this.status=missing?`还有 ${missing} 项需要选择模板，请在下方处理。`:'所选底稿均已匹配模板，可以继续生成。';if(missing)this.focused='#fg-matches';}
 private cancelModeLoad(){this.modeController?.abort();this.modeController=undefined;this.modeStatus='已取消加载，原选择保留。';this.paint();}
 private async loadDefaultCatalogue(){
  if(this.busy||this.pending||this.storageError||this.revisionConflict)return;
  this.modeController?.abort();const controller=new AbortController();this.modeController=controller;
  const signal=AbortSignal.any([this.controller.signal,controller.signal,AbortSignal.timeout(60_000)]);
  this.modeStatus='正在读取底稿目录…';this.paint();
  try{
   const result=await this.request<{catalogue:WorkpaperCatalogue}>('POST','/builtin',{request_id:crypto.randomUUID(),version:this.data!.builtin.version,part:'catalogue'},{},signal);
   signal.throwIfAborted();if(this.modeController!==controller)return;
   this.cat=result.catalogue;this.prep.catalogue_id=this.cat.catalogue_id;this.prep.item_ids=defaultWorkpaperIds(this.cat.entries);this.prep.mappings={};
   this.modeController=undefined;this.modeStatus='';await this.act(async()=>{await this.readMatches(true);await this.save();});
  }catch(e){if(this.modeController!==controller||!this.live())return;this.modeController=undefined;this.modeStatus=signal.aborted?'目录加载超时，请重试。':friendlyError(e,'read');this.paint();}
 }
 private async selectMode(mode:'automatic'|'builtin'|'custom'){
  if(this.busy||this.pending||this.storageError||this.revisionConflict)return;
  const current=this.automatic()?'automatic':this.custom?'custom':'builtin';
  this.modeDrafts[current]=structuredClone(this.prep);
  this.modeController?.abort();const controller=new AbortController();this.modeController=controller;
  const signal=AbortSignal.any([this.controller.signal,controller.signal,AbortSignal.timeout(60_000)]);
  const previous=this.modeDrafts[mode];let chosen=previous?.template_set_id??null;
  this.modeStatus=mode==='builtin'?'正在读取光大 Word 模板…':'正在切换模板…';this.paint();
  try{
   if(mode==='builtin'){
    let set=this.data!.sets.find(s=>s.set_id===chosen&&s.origin==='builtin'&&s.version===this.data!.builtin.version);
    if(!set){const result=await this.request<{set:FileTemplateSet}>('POST','/builtin',{request_id:crypto.randomUUID(),version:this.data!.builtin.version,part:'templates'},{},signal);signal.throwIfAborted();set=result.set;if(!set)throw new UserFacingError('模板未完整返回，请重试。');this.data!.sets=this.data!.sets.filter(s=>s.set_id!==set!.set_id);this.data!.sets.unshift(set);}
    chosen=set.set_id;
    for(const r of set.records.filter(r=>r.document_type!=='workpaper'))if(!this.prep.document_templates[r.document_type])this.prep.document_templates[r.document_type]=pin(r);
   }
   signal.throwIfAborted();if(this.modeController!==controller)return;
   this.custom=mode==='custom';this.prep.workpaper_template_mode=mode==='automatic'?'automatic':'selected';
   this.prep.template_set_id=mode==='automatic'?null:chosen;
   this.prep.mappings=mode!=='automatic'&&previous?.catalogue_id===this.prep.catalogue_id&&previous?.template_set_id===chosen?structuredClone(previous.mappings):{};
   this.matches=[];this.modeController=undefined;this.modeStatus='';this.matchPage=0;
   await this.act(async()=>{
    try{await this.readMatches(true);}catch{this.status='模板已选择，自动匹配暂不可用，可重试或手动选择。';}
    await this.save();this.showMatches=!!this.missingTemplates().length;this.onlyUnmapped=this.showMatches;
    this.status=this.automatic()?'已采用光大模板，目录和生成范围保留。':this.missingTemplates().length?`模板包已选择，还有 ${this.missingTemplates().length} 项需要处理。`:'模板已匹配，可以继续生成。';
   });
  }catch(e){if(this.modeController!==controller||!this.live())return;this.modeController=undefined;this.modeStatus=signal.aborted?'模板加载超时，原选择保留，请重试。':friendlyError(e,'read');this.paint();}
 }
 private async builtinTemplates(){
  const result=await this.request<{set:FileTemplateSet}>('POST','/builtin',{request_id:crypto.randomUUID(),version:this.data!.builtin.version,part:'templates'},{},AbortSignal.any([this.controller.signal,AbortSignal.timeout(60_000)]));
  if(!this.data!.sets.some(s=>s.set_id===result.set.set_id))this.data!.sets.unshift(result.set);
  for(const r of result.set.records.filter(r=>r.document_type!=='workpaper'))if(!this.prep.document_templates[r.document_type])this.prep.document_templates[r.document_type]=pin(r);
  await this.save();this.status='已添加光大证券文件模板。';
 }
 private workpaperCards(){
  const cat=this.cat,set=this.set(),automatic=this.automatic(),saved=this.data!.sets.filter(s=>s.origin==='private'&&s.records.some(r=>r.document_type==='workpaper'));
  return `<div class="fg-two-cards"><article class="fg-source-card"><header><span class="fg-card-number">01</span><h3>生成范围</h3>${cat?'<span class="fg-ready">已选择目录</span>':''}</header><p>目录决定生成哪些文件，更换模板会保留本次勾选。</p>
   ${cat?`<div class="fg-selected-file"><strong>${esc(cat.filename)}</strong><small>已选 ${this.prep.item_ids.length} / ${cat.entries.filter(e=>e.kind==='file').length} 项</small></div><div class="fg-actions"><button class="btn secondary" id="fg-preview-catalogue">预览目录</button><button class="btn secondary" id="fg-edit-scope">调整生成范围</button></div>`:'<div class="fg-upload-hint">选择底稿目录后即可生成。</div>'}
   <div class="fg-upload-actions"><label class="bb-upload-picker bb-upload-picker--compact btn secondary">${cat?'更换目录':'上传目录'}<input id="fg-catalogue-upload" type="file" accept=".xlsx" hidden></label>${!cat?`<button class="btn secondary" id="fg-load-builtin" ${!this.data!.builtin.available?'disabled':''}>使用光大目录</button>`:''}</div></article>
   <article class="fg-source-card"><header><span class="fg-card-number">02</span><h3>本次采用的模板</h3><span class="fg-ready">${automatic?'默认':set?'已选择':'待选择'}</span></header><p>${automatic?'按事项匹配核查记录、专项核查、说明等样式。':'每份所选底稿需对应一个 Word 模板。'}</p>
   <div class="fg-selected-file"><strong>${esc(this.templateLabel())}</strong><small>${automatic?'无需逐项指定；资料不足的事项形成相应说明。':set?set.records.filter(r=>r.document_type==='workpaper').length+' 份 Word · '+this.missingTemplates().length+' 项待处理':'请上传模板或选择已保存的模板包。'}</small></div>
   <div class="fg-actions"><button class="btn secondary" id="fg-preview-set" ${!automatic&&!set?'disabled':''}>预览模板</button><button class="btn secondary" id="fg-change-templates" aria-expanded="${this.showTemplateChoices}">${this.showTemplateChoices?'收起模板选择':'更换模板'}</button></div>
   </article></div>
   <div class="fg-template-choices" ${this.showTemplateChoices?'':'hidden'}><p>为本批底稿选择模板来源</p><div class="fg-source-choices" role="group" aria-label="模板来源"><button class="fg-option ${automatic?'is-selected':''}" id="fg-automatic" aria-pressed="${automatic}"><strong>光大模板（默认）</strong><small>按底稿事项自动匹配，可直接生成</small></button><button class="fg-option ${this.custom&&!automatic?'is-selected':''}" id="fg-custom" aria-pressed="${this.custom&&!automatic}"><strong>我的模板</strong><small>上传模板包或选择已保存的模板</small></button></div><button class="btn secondary" id="fg-builtin-all" aria-pressed="${!automatic&&!this.custom}" ${!this.data!.builtin.available?'disabled':''}>从光大模板库逐项选择</button></div>
   ${this.custom&&!automatic?`<div class="fg-custom-controls"><label class="bb-upload-picker bb-upload-picker--compact btn secondary">上传模板<input id="fg-template-upload" type="file" accept=".docx,.zip" multiple hidden></label><label class="bb-upload-picker bb-upload-picker--compact btn secondary">选择文件夹<input id="fg-folder-upload" type="file" webkitdirectory multiple hidden></label>${saved.length?`<label class="fg-saved-label">已保存的模板<select id="fg-saved-set" aria-label="选择已保存模板包"><option value="">选择我的模板包</option>${saved.map(s=>`<option value="${esc(s.set_id)}" ${s.set_id===this.prep.template_set_id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>`:''}</div>`:''}`;
 }
 private paint(){
  if(!this.live()||!this.data)return;this.stepChanged(this.activeStep);
  const active=this.host.contains(document.activeElement)?document.activeElement as HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement:null;
  const focusSelector=active?.id?'#'+CSS.escape(active.id):active?['data-fg-item','data-fg-type','data-fg-mapping','data-fg-general'].filter(attr=>active.hasAttribute(attr)).map(attr=>`[${attr}="${CSS.escape(active.getAttribute(attr)!)}"]`)[0]:undefined;
  const selection=active instanceof HTMLTextAreaElement||active instanceof HTMLInputElement&&['text','search'].includes(active.type)?[active.selectionStart,active.selectionEnd,active.selectionDirection] as const:undefined;
  const restoreFocus=!this.focused;
  const requirementsOpen=this.host.querySelector<HTMLDetailsElement>('#fg-supporting-details')?.open;
  const p=this.prep,set=this.set(),wp=p.document_types.includes('workpaper'),unmapped=this.missingTemplates().length,count=(wp?p.item_ids.length:0)+p.document_types.filter(t=>t!=='workpaper').length;
  const automaticWorkpaperFee=wp&&this.data.pricing?.mode==='automatic';
  const actionDescription=[!count?'fg-action-hint':'',automaticWorkpaperFee?'fg-fee-note':''].filter(Boolean).join(' ');
  const card=(type:string,hint:string)=>`<label class="fg-type ${p.document_types.includes(type as M4DocumentType)?'is-selected':''}"><input type="checkbox" data-fg-type="${type}" ${p.document_types.includes(type as M4DocumentType)?'checked':''}><span><strong>${esc(label(type))}</strong><small>${esc(hint)}</small></span></label>`;
  this.host.innerHTML=`<div class="fg-preparation"><div class="fg-source"><div><small>本次生成依据</small><strong>${esc(this.source?.filename??'尚未选择募集说明书')} ${this.source?'· V'+this.source.sequence:''}</strong></div><a class="btn secondary" href="#generate?project=${encodeURIComponent(this.project)}&step=source">更换募集说明书</a></div>
   <p role="status" class="fg-status" ${this.uploadProgress?'hidden':''}>${esc(this.status)}</p>${this.uploadProgress?'<div class="fg-upload-progress"><strong>'+esc(this.uploadName)+'</strong>'+uploadProgressHtml(this.uploadProgress,this.uploadName)+'</div>':''}
   ${this.pending?'<section class="panel fg-recovery"><h2>上次提交的结果待确认</h2><p>将用原提交编号核实结果，不会重复创建文件包。目录、模板和要求暂时锁定。</p><button class="btn primary" id="fg-resolve">确认上次提交结果</button><button class="btn secondary" id="fg-stop-submission">停止尚未提交的请求</button></section>':''}
   <div id="fg-controls"><section class="panel"><h2>这次要生成哪些文件？</h2><p class="muted">可以同时选择多种文件，使用同一份募集说明书。</p><div class="fg-types">${card('workpaper','按目录逐项编制，打包交付')}${PROJECT_DOCUMENT_CATALOG.filter(t=>this.showDocumentChoices||p.document_types.includes(t.id)).map(t=>card(t.id,t.hint)).join('')}</div><button class="btn secondary" id="fg-more-types" aria-expanded="${this.showDocumentChoices}">${this.showDocumentChoices?'收起其他文件类型':'添加其他文件类型（选填）'}</button></section>
   <section class="panel fg-template-panel" id="fg-template-setup" tabindex="-1" ${wp?'':'hidden'}><div class="fg-section-heading"><div><h2>底稿目录与文件模板</h2><p class="muted">默认采用光大模板，也可以更换为自己的模板。</p></div></div>
   ${this.modeStatus?`<div class="fg-load-status" role="status" aria-live="polite"><span>${this.modeController?'<span class="fg-spinner" aria-hidden="true"></span>':''}${esc(this.modeStatus)}</span>${this.modeController?'<button class="btn secondary" id="fg-cancel-builtin">取消加载</button>':''}</div>`:''}
   ${this.workpaperCards()}
   ${this.cat?`<div class="fg-combination"><div><strong class="fg-match-summary">${this.automatic()?`已选 ${p.item_ids.length} 项 · 采用光大模板`:`已匹配 ${p.item_ids.length-unmapped} / ${p.item_ids.length} 项${unmapped?'，还有 '+unmapped+' 项需要选择模板':'，可继续生成'}`}</strong><small>${this.automatic()?'按目录逐项编制，生成前可调整本批范围。':'唯一候选已自动匹配，请核对事项和角色；待处理项不会被悄悄略过。'}</small></div><div class="fg-actions">${!this.automatic()?`<button class="btn secondary" id="fg-auto-match" ${!set?'disabled':''}>自动匹配模板</button>`:''}<button class="btn ${unmapped?'primary':'secondary'}" id="fg-match-toggle" aria-expanded="${this.showMatches}">${this.showMatches?'收起清单':unmapped?'处理 '+unmapped+' 项模板':'查看本批清单'}</button></div></div><div id="fg-matches" tabindex="-1" ${this.showMatches?'':'hidden'}>${this.showMatches?this.matchTable():''}</div>`:''}
   ${set?.warnings.length?`<details class="fg-notice"><summary>模板导入提示（${set.warnings.length}）</summary>${set.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}<div id="fg-import-review"></div><div id="fg-upload-recovery"></div></section>
   ${p.document_types.filter(t=>t!=='workpaper').length?`<section class="panel"><h2>其他文件的模板</h2><p class="muted">光大证券是模板库来源；文件由对应发行人、承销商或律师事务所等主体出具。</p>${p.document_types.filter(t=>t!=='workpaper').map(t=>this.generalRow(t)).join('')}${p.document_types.includes('annual')?`<label class="fg-year">年度报告目标年度<input id="fg-year" type="number" min="2000" max="2099" placeholder="例如 2026" value="${esc(p.target_year)}"></label>`:''}<button class="btn secondary" id="fg-general-builtin" ${!this.data.builtin.available?'disabled':''}>添加光大证券内置模板</button></section>`:''}
   <section class="panel"><details id="fg-supporting-details" ${(requirementsOpen??Boolean(p.requirements||p.materials.length))?'open':''}><summary>补充资料与编制要求（选填）</summary><label class="fg-requirements">编制要求<textarea id="fg-requirements" rows="3" maxlength="12000" placeholder="例如目标期间、需重点核查的事项">${esc(p.requirements)}</textarea></label><label class="bb-upload-picker bb-upload-picker--compact btn secondary">上传补充资料<input id="fg-support" type="file" multiple accept=".docx,.pdf,.xlsx" hidden></label>${p.materials.length?'<span> 已采用 '+p.materials.length+' 份补充资料</span>':''}<button class="btn secondary" id="fg-save">保存准备清单</button></details></section></div>
    <footer class="fg-footer"><div><strong>本批 ${count} 份文件</strong><small>${wp&&unmapped?unmapped+' 项底稿待选择模板':wp?esc(this.templateLabel()):'采用所选 Word 模板'} · 预计 <span id="fg-estimate">${formatPoints(this.estimate())}</span> 积分</small>${automaticWorkpaperFee?`<small id="fg-fee-note">每份底稿 ${formatPoints(this.data.pricing!.workpaper_points)} 积分，成功交付后扣费；仅形成资料不足或不适用说明不收费。</small>`:''}${!count?'<small id="fg-action-hint" role="status">请至少选择一份文件。</small>':''}<p class="fg-save-status"><span id="fg-save-state" role="status" aria-live="polite"></span> <button class="text-button" id="fg-save-retry" hidden>重试保存</button><button class="text-button" id="fg-reload" hidden>重新载入服务端清单</button></p></div><button class="btn primary" id="fg-confirm" ${actionDescription?`aria-describedby="${actionDescription}"`:''} ${!count||!this.source||!!this.pending||this.storageError||this.revisionConflict||!!this.modeController?'disabled':''}>${unmapped?'处理模板后生成':this.data.pricing?.mode==='automatic'?'生成本批文件':'核对清单与费用'}</button></footer>
   <section class="panel fg-history">${this.historyContent()}</section></div>`;
  this.bind();if(this.review)this.review.render(this.host.querySelector('#fg-import-review')!,this.busy);
  this.paintCatalogueRecovery();this.paintSupportRecovery();
  const controls=this.host.querySelector<HTMLElement>('#fg-controls');if(controls)controls.inert=this.busy||!!this.pending||this.storageError||this.revisionConflict;
  if(this.busy)this.host.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);
  else if(this.focused){const target=this.host.querySelector<HTMLElement>(this.focused);this.focused=undefined;target?.scrollIntoView({block:'center'});target?.focus({preventScroll:true});}
  if(this.modeController)this.host.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement|HTMLTextAreaElement>('#fg-controls button,#fg-controls input,#fg-controls select,#fg-controls textarea').forEach(n=>{if(!['fg-custom','fg-builtin-all','fg-automatic','fg-cancel-builtin'].includes(n.id))n.disabled=true;});
  if(restoreFocus&&!this.busy&&focusSelector){const target=this.host.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(focusSelector);target?.focus({preventScroll:true});if(selection&&target&&(target instanceof HTMLTextAreaElement||target instanceof HTMLInputElement)&&selection[0]!==null&&selection[1]!==null)target.setSelectionRange(selection[0],selection[1],selection[2]??undefined);}
  this.paintSaveState();
 }
 private matchTable(){
  if(!this.cat)return '<p>请先选择底稿目录。</p>';
  const selected=new Set(this.prep.item_ids),records=this.set()?.records.filter(r=>r.document_type==='workpaper')??[];
  const entries=this.cat.entries.filter(e=>e.kind==='file'&&(!this.onlyUnmapped||(selected.has(e.id)&&!this.prep.mappings[e.id]))&&(!this.filter||(e.code+e.title).includes(this.filter)));
  const pages=Math.max(1,Math.ceil(entries.length/20));this.matchPage=Math.min(this.matchPage,pages-1);
  return `<div class="fg-match-toolbar"><input id="fg-filter" placeholder="搜索编号或名称" aria-label="搜索目录" value="${esc(this.filter)}"><button class="btn secondary" id="fg-select-all">全选目录</button><button class="btn secondary" id="fg-select-none">取消全选</button>${!this.automatic()?`<label><input id="fg-only-unmapped" type="checkbox" ${this.onlyUnmapped?'checked':''}>只看待处理条目</label>`:''}</div><p class="muted">未勾选的条目会在确认清单中列出。</p><div class="fg-table-scroll"><table><thead><tr><th>生成</th><th>编号与事项</th><th>采用的模板</th><th>预览</th></tr></thead><tbody>${entries.slice(this.matchPage*20,(this.matchPage+1)*20).map(e=>{const current=this.prep.mappings[e.id],match=this.matches.find(m=>m.item_id===e.id);return `<tr><td><input type="checkbox" data-fg-item="${esc(e.id)}" aria-label="生成 ${esc(e.code+' '+e.title)}" ${selected.has(e.id)?'checked':''}></td><td><strong>${esc(e.code)}</strong> ${esc(e.title)}</td><td>${this.automatic()?'光大模板（自动匹配）':`<select data-fg-mapping="${esc(e.id)}" aria-label="${esc(e.code+' '+e.title)} 的模板"><option value="">${match?.candidates.length?'有 '+match.candidates.length+' 个候选，请选择':'暂无候选，请选择模板'}</option>${records.filter(r=>r.record_id===current?.record_id||match?.candidates.some(c=>c.record_id===r.record_id)).map(r=>`<option value="${esc(r.record_id)}" ${current?.record_id===r.record_id?'selected':''}>${match?.candidates.some(c=>c.record_id===r.record_id)?'建议 · ':''}${esc(r.name)}</option>`).join('')}${current&&!records.some(r=>r.record_id===current.record_id)?`<option value="${esc(current.record_id)}" selected>${esc(this.record(current)?.name??'此前指定模板')}</option>`:''}</select>`}</td><td><button class="btn secondary" data-fg-preview-item="${esc(e.id)}" ${this.automatic()||!current?'disabled':''}>预览</button></td></tr>`;}).join('')}</tbody></table>${!entries.length?'<p class="muted">'+(this.filter?'没有找到对应条目。':this.onlyUnmapped?'所选底稿没有待处理条目，可继续生成。':'暂无文件条目。')+'</p>':''}</div><div class="fg-match-pages"><span>共 ${entries.length} 项 · 第 ${this.matchPage+1} / ${pages} 页</span><button class="btn secondary" id="fg-prev-page" ${!this.matchPage?'disabled':''}>上一页</button><button class="btn secondary" id="fg-next-page" ${this.matchPage+1>=pages?'disabled':''}>下一页</button></div>`;
 }
 private generalRow(type:M4DocumentType){
  const chosen=this.prep.document_templates[type],records=this.data!.sets.flatMap(s=>s.records).filter(r=>r.document_type===type),privates=this.workspace.workspace.templates.filter(t=>t.document_type===type&&t.status==='active');
  return `<div class="fg-general-row"><strong>${esc(label(type))}</strong><select data-fg-general="${type}" aria-label="${esc(label(type))}模板"><option value="">请选择模板</option>${records.map(r=>`<option value="${esc(r.set_id+'|'+r.record_id)}" ${chosen&&'record_id' in chosen&&chosen.record_id===r.record_id&&chosen.set_id===r.set_id?'selected':''}>${esc(r.name)} · ${this.data!.sets.find(s=>s.set_id===r.set_id)?.origin==='builtin'?'光大证券':'我的模板'}</option>`).join('')}${privates.map(t=>`<option value="private|${esc(t.template_id)}" ${chosen&&'private_template' in chosen&&chosen.private_template.template_id===t.template_id?'selected':''}>${esc(t.name)} · 已保存</option>`).join('')}</select><button class="btn secondary" data-fg-general-preview="${type}" ${!chosen||!('record_id' in chosen)?'disabled':''}>预览</button><label class="bb-upload-picker bb-upload-picker--compact btn secondary">上传 Word<input type="file" data-fg-general-upload="${type}" accept=".docx" hidden></label></div>`;
 }
 private bind(){
  const click=(id:string,fn:()=>void)=>this.host.querySelector<HTMLButtonElement>('#'+id)?.addEventListener('click',fn);
  click('fg-more-types',()=>{this.showDocumentChoices=!this.showDocumentChoices;this.paint();});
  click('fg-custom',()=>void this.selectMode('custom'));
  click('fg-automatic',()=>void this.selectMode('automatic'));
  click('fg-change-templates',()=>{this.showTemplateChoices=!this.showTemplateChoices;this.paint();});
  click('fg-edit-scope',()=>{this.showMatches=true;this.onlyUnmapped=false;this.matchPage=0;this.focused='#fg-matches';this.paint();});
  click('fg-builtin-all',()=>void this.selectMode('builtin'));click('fg-load-builtin',()=>void this.loadDefaultCatalogue());
  click('fg-cancel-builtin',()=>this.cancelModeLoad());
  click('fg-general-builtin',()=>void this.act(()=>this.builtinTemplates()));
  click('fg-preview-catalogue',()=>this.cataloguePreview());click('fg-preview-set',()=>{if(this.automatic())void this.systemPreview();else this.templateLibrary();});
  click('fg-match-toggle',()=>{this.showMatches=!this.showMatches;this.onlyUnmapped=!!this.missingTemplates().length;this.matchPage=0;this.paint();if(this.showMatches&&!this.matches.length)void this.readMatches().then(()=>{if(this.showMatches)this.paint();}).catch(()=>{this.status='匹配建议暂不可用，仍可手动选择模板。';this.paint();});});
  click('fg-select-all',()=>void this.change(()=>{this.prep.item_ids=this.cat!.entries.filter(e=>e.kind==='file').map(e=>e.id);}));click('fg-select-none',()=>void this.change(()=>{this.prep.item_ids=[];}));
  click('fg-auto-match',()=>void this.act(()=>this.matchTemplates()));
  click('fg-prev-page',()=>{this.matchPage--;this.paint();});click('fg-next-page',()=>{this.matchPage++;this.paint();});
  const onlyUnmapped=this.host.querySelector<HTMLInputElement>('#fg-only-unmapped');if(onlyUnmapped)onlyUnmapped.onchange=()=>{this.onlyUnmapped=onlyUnmapped.checked;this.matchPage=0;this.paint();};
  click('fg-save',()=>void this.save().then(()=>{if(!this.live())return;this.status='准备清单已保存，可关闭页面后继续。';const status=this.host.querySelector<HTMLElement>('.fg-status');if(status)status.textContent=this.status;}).catch(()=>{}));
  click('fg-save-retry',()=>void this.save().catch(()=>{}));
  click('fg-stop-submission',()=>void this.act(async()=>{if(!this.pending)return;const result=await this.request<{batch:FileGenerationBatch|null}>('POST','/stop-submission',this.pending);this.pending=undefined;this.persist();if(result.batch){this.historyRevision++;this.data!.batches=[result.batch,...this.data!.batches.filter(b=>b.batch_id!==result.batch!.batch_id)];}this.status=result.batch?'原请求已经创建任务，可在生成记录中查看或暂停。':'尚未创建任务，原请求已停止，可以继续修改准备清单。';}));
  click('fg-confirm',()=>void this.act(()=>this.confirm()));click('fg-resolve',()=>void this.act(()=>this.submit()));
  click('fg-refresh',()=>void this.refreshHistory());click('fg-reload',()=>{if(this.saving)return;void this.act(async()=>{clearTimeout(this.autosaveTimer);const latest=await this.request<FileGenerationWorkspace>('GET');this.data=latest;this.prep=structuredClone(latest.preparation);this.dirty=false;this.storageError=false;this.revisionConflict=false;this.preparationSave=undefined;this.saveNeedsRead=false;this.saveFailure='';this.modeDrafts={};this.custom=this.set()?.origin==='private';this.persist();if(this.prep.catalogue_id)this.cat=await this.wp<WorkpaperCatalogue>('GET','/catalogues/'+encodeURIComponent(this.prep.catalogue_id));else this.cat=undefined;await this.readMatches();this.status='已载入服务端清单。';});});
  this.host.querySelectorAll<HTMLInputElement>('[data-fg-type]').forEach(n=>n.onchange=()=>void this.change(()=>{const type=n.dataset.fgType as M4DocumentType;this.prep.document_types=n.checked?[...this.prep.document_types,type]:this.prep.document_types.filter(t=>t!==type);}));
  this.host.querySelectorAll<HTMLInputElement>('[data-fg-item]').forEach(n=>n.onchange=()=>void this.change(()=>{const id=n.dataset.fgItem!;this.prep.item_ids=n.checked?[...this.prep.item_ids,id]:this.prep.item_ids.filter(v=>v!==id);}));
  this.host.querySelectorAll<HTMLSelectElement>('[data-fg-mapping]').forEach(n=>{
   // Populate the complete list only for the select being used, avoiding tens
   // of thousands of hidden options in a large catalogue. Keyboard focus also
   // loads it before native select navigation begins.
   const populate=()=>{if(n.dataset.loaded)return;n.dataset.loaded='true';const value=n.value,existing=new Set(Array.from(n.options,o=>o.value));
    for(const r of this.set()?.records.filter(r=>r.document_type==='workpaper')??[])if(!existing.has(r.record_id))n.add(new Option(r.name,r.record_id));n.value=value;};
   n.onfocus=populate;n.onpointerdown=populate;
   n.onchange=()=>void this.change(()=>{const r=this.set()?.records.find(r=>r.record_id===n.value);if(r)this.prep.mappings[n.dataset.fgMapping!]=pin(r);else delete this.prep.mappings[n.dataset.fgMapping!];});
  });
  this.host.querySelectorAll<HTMLButtonElement>('[data-fg-preview-item]').forEach(n=>n.onclick=()=>void this.preview(this.prep.mappings[n.dataset.fgPreviewItem!]));
  this.host.querySelectorAll<HTMLSelectElement>('[data-fg-general]').forEach(n=>n.onchange=()=>void this.change(()=>{const type=n.dataset.fgGeneral!,[set,id]=n.value.split('|');if(set==='private'){const t=this.workspace.workspace.templates.find(t=>t.template_id===id)!;this.prep.document_templates[type]={private_template:{template_id:t.template_id,template_version:t.template_version,sha256:t.sha256}};}else{const r=this.data!.sets.find(s=>s.set_id===set)?.records.find(r=>r.record_id===id);if(r)this.prep.document_templates[type]=pin(r);else delete this.prep.document_templates[type];}}));
  this.host.querySelectorAll<HTMLButtonElement>('[data-fg-general-preview]').forEach(n=>n.onclick=()=>{const p=this.prep.document_templates[n.dataset.fgGeneralPreview!];if(p&&'record_id' in p)void this.preview(p);});
  this.host.querySelectorAll<HTMLInputElement>('[data-fg-general-upload]').forEach(n=>n.onchange=()=>{if(n.files?.length)void this.act(()=>this.uploadTemplates([...n.files!],n.dataset.fgGeneralUpload as M4DocumentType));});
  for(const id of ['fg-template-upload','fg-folder-upload']){const n=this.host.querySelector<HTMLInputElement>('#'+id);if(n)n.onchange=()=>{if(n.files?.length)void this.act(()=>this.uploadTemplates([...n.files!],'workpaper'));};}
  const saved=this.host.querySelector<HTMLSelectElement>('#fg-saved-set');if(saved)saved.onchange=()=>void this.act(async()=>{if(!saved.value)return;if(this.prep.template_set_id!==saved.value){this.prep.template_set_id=saved.value;this.prep.mappings={};}await this.readMatches(true);await this.save();this.status='已更换模板包，底稿目录保留。';});
  const catalogue=this.host.querySelector<HTMLInputElement>('#fg-catalogue-upload');if(catalogue)catalogue.onchange=()=>{if(catalogue.files?.[0])void this.act(()=>this.uploadCatalogue(catalogue.files![0]));};
  const note=this.host.querySelector<HTMLTextAreaElement>('#fg-requirements');if(note)note.oninput=()=>{this.prep.requirements=note.value;this.dirty=true;try{this.persist();this.paintSaveState();}catch(e){this.status=friendlyError(e,'save');this.paintSaveState();}};
  const year=this.host.querySelector<HTMLInputElement>('#fg-year');if(year)year.onchange=()=>void this.change(()=>{this.prep.target_year=year.value;});
  const filter=this.host.querySelector<HTMLInputElement>('#fg-filter');if(filter)filter.onchange=()=>{this.filter=filter.value;this.matchPage=0;this.paint();};
  const support=this.host.querySelector<HTMLInputElement>('#fg-support');if(support)support.onchange=()=>{if(support.files?.length)void this.act(async()=>{for(const f of [...support.files!])await this.resumeSupport(f);this.status='补充资料已保存。';});};
 }
 private async uploadTemplates(files:File[],type:M4DocumentType){
  const words=files.filter(f=>/\.(docx|zip)$/i.test(f.name)&&!f.name.startsWith('~$'));if(!words.length)throw new UserFacingError('请上传 DOCX 或 ZIP。PDF 和旧版 DOC 请先转换为 Word。');if(words.length>500)throw new UserFacingError('一次最多上传 500 份 Word。');
  const sets:FileTemplateSet[]=[];let skipped=files.length-words.length;
  for(const [index,file] of words.entries()){
   if(file.size>64*1024*1024)throw new UserFacingError('单个模板文件或 ZIP 不可超过 64 MB。');
   this.uploadName=file.webkitRelativePath||file.name;this.reportUpload(`正在准备模板 ${index+1}/${words.length}：${this.uploadName}`);
   const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join(''),filename=file.webkitRelativePath||file.name;
   let receipt=this.receipts.find(r=>r.sha256===sha256&&r.filename===filename&&r.document_type===type);
   if(!receipt){receipt={request_id:crypto.randomUUID(),sha256,filename,document_type:type};this.receipts.push(receipt);this.persist();}
   let set=this.data!.sets.find(s=>s.set_id===receipt!.set_id);
   if(!set){const query=new URLSearchParams({request_id:receipt.request_id,sha256,filename,document_type:type,format:/\.zip$/i.test(file.name)?'zip':'docx'});set=await this.api.uploadRequest<FileTemplateSet>(`/projects/${encodeURIComponent(this.project)}/file-generation/templates/import?`+query,file,(loaded,total)=>{const p=uploadTransfer(loaded,total);this.reportUpload(p.message,p);},this.controller.signal,()=>this.reportUpload('文件传输完成，正在解析并保存模板…'));receipt.set_id=set.set_id;this.data!.sets.unshift(set);this.persist();}sets.push(set);
  }
  this.reportUpload('模板已保存，正在整理模板包…');
  let combined=sets[0];if(sets.length>1){const request='combine-'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sets.map(s=>s.set_id).sort().join('|'))))].map(x=>x.toString(16).padStart(2,'0')).join('');combined=await this.request<FileTemplateSet>('POST','/templates/combine',{request_id:request,set_ids:sets.map(s=>s.set_id)});this.data!.sets.unshift(combined);}
  if(type==='workpaper'){this.prep.workpaper_template_mode='selected';this.prep.template_set_id=combined.set_id;this.prep.mappings={};await this.readMatches(true);}else this.prep.document_templates[type]=pin(combined.records[0]);
  await this.save();this.status=`已保存 ${combined.records.length} 份 Word 模板。${skipped?'已忽略 '+skipped+' 个 PDF 或其他文件；请核对是否有仅提供 PDF 的事项。':''}`;
 }
 private async uploadCatalogue(file?:File,operationId?:string){
  if(file&&!/\.xlsx$/i.test(file.name))throw new UserFacingError('底稿目录支持 XLSX，旧版 XLS 请另存为 XLSX。');
  if(operationId)this.catalogueUpload={operationId,recovery:new UploadRecovery(this.api,this.owner,this.project,'file-generation-catalogue',()=>this.live())};
  this.uploadName=file?.name??"底稿目录";
  this.cataloguePin=await uploadFileMaterial(this.api,this.project,file,this.controller.signal,this.reportUpload,this.catalogueUpload,this.owner,'file-generation-catalogue').catch(error=>{if(error instanceof UploadRecoveryNeedsFileError&&this.catalogueUpload.operationId)this.reselectUploads.add(this.catalogueUpload.operationId);throw error;});if(this.catalogueUpload.operationId)this.reselectUploads.delete(this.catalogueUpload.operationId);
  const context=this.catalogueUpload.recovery?.list().find(r=>r.id===this.catalogueUpload.operationId)?.context as {mapping?:WorkpaperColumnMapping[];scope?:'due_diligence'|'all'}|undefined;
  if(context?.mapping)await this.acceptCatalogue(context.mapping,context.scope??'due_diligence');else await this.previewCatalogueImport();
 }
 private async previewCatalogueImport(mapping?:WorkpaperColumnMapping[],scope:'due_diligence'|'all'='due_diligence'){
  this.scope=scope;const preview=await this.wp<WorkpaperCataloguePreview>('POST','/catalogue-preview',{material:this.cataloguePin,scope,...(mapping?{mapping}:{})});
  this.review=new WorkpaperImportReview(preview,scope,(m,s)=>void this.act(()=>this.previewCatalogueImport(m,s)),(m,s)=>void this.act(()=>this.acceptCatalogue(m,s)));
  this.status=preview.needs_review?'目录已上传，请核对读取结果；无需重新上传。':'目录已识别，请核对条目后采用。';
 }
 private async acceptCatalogue(mapping:WorkpaperColumnMapping[],scope:'due_diligence'|'all'){
  const requestId='catalogue-'+this.catalogueUpload.operationId;
  if(this.catalogueUpload.operationId)await this.catalogueUpload.recovery?.updateContext(this.catalogueUpload.operationId,JSON.parse(JSON.stringify({mapping,scope})));

  this.cat=await this.wp<WorkpaperCatalogue>('POST','/catalogues',{request_id:requestId,material:this.cataloguePin,scope,mapping});
  this.prep.catalogue_id=this.cat.catalogue_id;this.prep.item_ids=defaultWorkpaperIds(this.cat.entries);this.prep.mappings={};await this.readMatches(true);await this.save();
  if(this.catalogueUpload.operationId)await this.catalogueUpload.recovery?.forget(this.catalogueUpload.operationId);this.catalogueUpload={};this.review=undefined;this.status='已采用新的底稿目录；模板包保留。';
 }
 private paintCatalogueRecovery(){
  if(this.review)return;const host=this.host.querySelector<HTMLElement>('#fg-upload-recovery');if(!host)return;
  try{const recovery=new UploadRecovery(this.api,this.owner,this.project,'file-generation-catalogue',()=>this.live()),records=recovery.list();host.innerHTML=records.map(r=>`<div class="fg-notice bb-upload-file"><strong>${esc(r.declaration.filename)}</strong><p>上次目录上传待确认，完成部分已保留。</p><button class="bb-upload-action bb-upload-action--primary btn secondary" data-fg-resume="${esc(r.id)}">继续识别</button><label class="bb-upload-picker bb-upload-picker--compact btn secondary" ${this.reselectUploads.has(r.id)?'':'hidden'}>重新选择原文件<input type="file" data-fg-reselect="${esc(r.id)}" accept=".xlsx" hidden></label></div>`).join('');host.querySelectorAll<HTMLButtonElement>('[data-fg-resume]').forEach(b=>b.onclick=()=>void this.act(()=>this.uploadCatalogue(undefined,b.dataset.fgResume)));host.querySelectorAll<HTMLInputElement>('[data-fg-reselect]').forEach(n=>n.onchange=()=>{if(n.files?.[0])void this.act(()=>this.uploadCatalogue(n.files![0],n.dataset.fgReselect));});}catch{host.textContent='原上传记录暂不可读取，请刷新后重试。';}
 }
 private modal(title:string,html:string){this.dialog?.remove();const d=document.createElement('dialog');d.className='fg-modal';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="btn secondary" data-close>关闭</button></header>${html}`;document.body.append(d);d.showModal();d.querySelector('[data-close]')!.addEventListener('click',()=>d.close());d.addEventListener('close',()=>d.remove());this.dialog=d;return d;}
 private cataloguePreview(){if(!this.cat)return;this.modal('底稿目录',`<p>${esc(this.cat.filename)} · ${this.cat.entries.length} 项</p><div class="fg-table-scroll"><table><thead><tr><th>编号</th><th>文件名称</th><th>编制要求</th></tr></thead><tbody>${this.cat.entries.map(e=>`<tr><td>${esc(e.code)}</td><td>${esc(e.title)}</td><td>${esc(e.instructions)}</td></tr>`).join('')}</tbody></table></div>`);}
 private async systemPreview(){
  const d=this.modal('光大模板预览','<p role="status">正在读取光大模板…</p>');
  try{const result=await this.request<SystemWorkpaperTemplates>('GET','/system-templates');if(!d.isConnected)return;
   d.querySelector('[role=status]')?.remove();d.insertAdjacentHTML('beforeend',`<p>以下为各类光大模板的脱敏结构示例。生成时按具体事项匹配；资料不足或业务不适用时采用相应说明样式。</p>${result.templates.map(t=>`<details><summary>${esc(t.family)}</summary><article class="fg-word-preview">${t.preview.blocks.map(b=>b.kind==='paragraph'?`<p>${esc(b.text)}</p>`:`<div class="fg-table-scroll"><table>${b.rows.map(row=>`<tr>${row.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`).join('')}</article></details>`).join('')}`);
  }catch(e){if(d.isConnected)d.querySelector('[role=status]')!.textContent=friendlyError(e,'read');}
 }
 private templateLibrary(){const records=this.set()?.records.filter(r=>r.document_type==='workpaper')??[];const d=this.modal('模板库 · 脱敏预览',`<p>企业、人员和历史已填内容已清空。请选择一份模板查看结构。</p><input id="fg-library-search" placeholder="搜索编号或文件角色" aria-label="搜索模板"><div class="fg-library-list">${records.map(r=>`<button class="fg-library-item" data-record="${esc(r.record_id)}"><strong>${esc(r.name)}</strong><span>${esc(r.role)}</span></button>`).join('')}</div>`);d.querySelectorAll<HTMLButtonElement>('[data-record]').forEach(b=>b.onclick=()=>void this.preview(pin(records.find(r=>r.record_id===b.dataset.record)!)));d.querySelector<HTMLInputElement>('#fg-library-search')!.oninput=e=>{const v=(e.target as HTMLInputElement).value;d.querySelectorAll<HTMLElement>('[data-record]').forEach(n=>n.hidden=!n.textContent?.includes(v));};}
 private async preview(p:FileTemplatePin){
  const d=this.modal('模板预览','<p role="status">正在读取脱敏预览…</p>');try{const preview=await this.request<FileTemplatePreview>('POST','/template-preview',p);if(!d.isConnected)return;d.insertAdjacentHTML('beforeend',`<p class="fg-notice">企业、人员及历史已填内容已清空。以下为脱敏结构预览，实际生成采用所选 Word 原稿。</p><div class="fg-actions"><button class="btn secondary" id="fg-layout-preview">查看版式预览</button><span id="fg-layout-status" role="status"></span></div><div id="fg-layout-view"></div><article class="fg-word-preview"><h3>${esc(preview.title)}</h3>${preview.blocks.map(b=>b.kind==='paragraph'?`<p class="${b.bold?'is-bold':''}">${esc(b.text)}</p>`:`<div class="fg-table-scroll"><table>${b.rows.map(row=>`<tr>${row.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`).join('')}</article>`);d.querySelector('[role=status]')?.remove();d.querySelector<HTMLButtonElement>('#fg-layout-preview')!.onclick=()=>void this.layoutPreview(d,p);}catch(e){d.querySelector('[role=status]')!.textContent=friendlyError(e,'read');}
 }
 private async layoutPreview(d:HTMLDialogElement,p:FileTemplatePin){
  const button=d.querySelector<HTMLButtonElement>('#fg-layout-preview')!,status=d.querySelector('#fg-layout-status')!;button.disabled=true;status.textContent='正在转换脱敏版式…';
  try{const response=await this.request<{pdf_base64:string}>('POST','/template-preview-pdf',p);if(!d.isConnected)return;const bytes=Uint8Array.from(atob(response.pdf_base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));d.addEventListener('close',()=>URL.revokeObjectURL(url),{once:true});const frame=document.createElement('iframe');frame.title='脱敏模板版式预览';frame.src=url;frame.style.cssText='width:100%;height:65vh;border:1px solid #dce3ed;margin-top:20px';d.querySelector('#fg-layout-view')!.replaceChildren(frame);status.textContent='已转换为脱敏版式预览';}
  catch{status.textContent='版式转换暂不可用，结构预览已保留，可稍后重试。';}finally{button.disabled=false;}
 }
 private async resumeSupport(file?:File,operationId?:string){
  if(this.prep.materials.length>=50&&!operationId)throw new UserFacingError('本批最多补充 50 份资料。');
  const recovery=new UploadRecovery(this.api,this.owner,this.project,'file-generation-support',()=>this.live()),state:UploadFileMaterialState={recovery,...(operationId?{operationId}:{})};
  this.uploadName=file?.name??recovery.list().find(r=>r.id===operationId)?.declaration.filename??"补充资料";
  const m=await uploadFileMaterial(this.api,this.project,file,this.controller.signal,this.reportUpload,state,this.owner,'file-generation-support').catch(error=>{if(error instanceof UploadRecoveryNeedsFileError&&state.operationId)this.reselectUploads.add(state.operationId);throw error;});if(state.operationId)this.reselectUploads.delete(state.operationId);
  if(!this.prep.materials.some(p=>p.material_id===m.material_id&&p.material_version===m.material_version))this.prep.materials.push(m);await this.save();if(state.operationId)await recovery.forget(state.operationId);
 }
 private paintSupportRecovery(){
  const host=this.host.querySelector('#fg-controls > section:last-child');if(!host)return;
  try{const recovery=new UploadRecovery(this.api,this.owner,this.project,'file-generation-support',()=>this.live());for(const r of recovery.list()){
   const row=document.createElement('div');row.className='fg-notice bb-upload-file';row.innerHTML=`<strong>${esc(r.declaration.filename)}</strong><p>补充资料上传待确认。</p><button class="btn secondary bb-upload-action bb-upload-action--primary" data-resume>继续保存</button><label class="bb-upload-picker bb-upload-picker--compact btn secondary" ${this.reselectUploads.has(r.id)?'':'hidden'}>重新选择原文件<input type="file" accept=".docx,.pdf,.xlsx" hidden></label><button class="btn secondary bb-upload-action" data-forget>停止这次补充</button>`;host.append(row);
   row.querySelector<HTMLButtonElement>('[data-resume]')!.onclick=()=>void this.act(()=>this.resumeSupport(undefined,r.id));row.querySelector<HTMLInputElement>('input')!.onchange=e=>{const f=(e.target as HTMLInputElement).files?.[0];if(f)void this.act(()=>this.resumeSupport(f,r.id));};row.querySelector<HTMLButtonElement>('[data-forget]')!.onclick=()=>void this.act(async()=>{await recovery.forget(r.id);this.status='已停止这次补充，已保存资料保留。';});
  }}catch{this.status='补充资料恢复记录暂不可读取，请刷新后重试。';}
 }
 private estimate(){const p=this.data?.pricing;return serializeInt64((this.prep.document_types.includes('workpaper')?BigInt(this.prep.item_ids.length)*int64(p?.workpaper_points??M4_DOCUMENT_FIXED_PRICE.points):0n)+BigInt(this.prep.document_types.filter(t=>t!=='workpaper').length)*int64(p?p.document_points??'0':M4_DOCUMENT_FIXED_PRICE.points));}
 private async confirm(){
  if(this.prep.document_types.includes('workpaper')){
   if(!this.cat||!this.automatic()&&!this.set()){this.focused='#fg-template-setup';throw new UserFacingError('请先选好底稿目录；使用 Word 模板时还需选择模板包。');}
   const missing=this.missingTemplates().length;
   if(missing){this.reviewTemplates();throw new UserFacingError('还有 '+missing+' 项底稿需要选择 Word 模板。已展开待处理条目，可先点击“自动匹配模板”，再处理剩余条目；本次尚未提交生成。');}
  }
  const missingType=this.prep.document_types.find(t=>t!=='workpaper'&&!this.prep.document_templates[t]);
  if(missingType){this.focused='[data-fg-general="'+missingType+'"]';throw new UserFacingError('请为'+label(missingType)+'选择 Word 模板。');}
  if(this.prep.document_types.includes('annual')&&!this.prep.target_year){this.focused='#fg-year';throw new UserFacingError('请选择年度报告的目标年度。');}

  if(this.review||['file-generation-catalogue','file-generation-support'].some(purpose=>new UploadRecovery(this.api,this.owner,this.project,purpose,()=>this.live()).list().length))throw new UserFacingError('还有目录或补充资料上传待确认，请先在相应卡片完成恢复，再确认生成。');
  if(this.dirty||this.saving||this.preparationSave||!this.data!.revision)await this.save();
  if(this.revisionConflict||this.storageError||!samePreparation(this.prep,this.data!.preparation))throw new UserFacingError('最新准备清单尚未保存，本次尚未提交生成。请先重试保存。');
  const count=(this.prep.document_types.includes('workpaper')?this.prep.item_ids.length:0)+this.prep.document_types.filter(t=>t!=='workpaper').length;
  const request:FileGenerationSubmit={request_id:crypto.randomUUID(),expected_revision:this.data!.revision,source_version_id:this.source!.version_id,source_selection_revision:this.source!.selection_revision,expected_points:this.estimate(),price_version:this.data!.pricing?.price_version??M4_DOCUMENT_FIXED_PRICE.version};
  const q=await this.request<FileGenerationQuote>('POST','/quote',request);
  request.expected_points=q.points;request.price_version=q.price_version;
  if(q.quote_id)request.quote_id=q.quote_id;
  if(q.documents)request.document_quotes=q.documents.filter(d=>d.scope_quote_id).map(d=>({document_type:d.document_type,draft_version:d.draft_version,scope_quote_id:d.scope_quote_id!}));
  if(q.auto_charge&&q.quote_status==='ready'){this.pending=request;this.pendingWire=BILLING_WIRE_VERSION;this.persist();await this.submit();return;}
  this.activeStep=3;this.stepChanged(3);
  const selected=this.cat?.entries.filter(e=>this.prep.item_ids.includes(e.id))??[],d=this.modal('确认本批文件',`<p>募集说明书：${esc(this.source!.filename)} · V${this.source!.sequence}</p><p><strong>${q.count} 份文件 · ${formatPoints(q.points)} 积分</strong></p>${this.prep.document_types.includes('workpaper')?`<p>本次底稿模板：${esc(this.templateLabel())}</p>`:''}<p>按现有规则逐份编制与计费，说明文件沿用不收费规则。目录、模板与资料版本将在确认时固定。</p>${this.prep.target_year&&this.prep.document_types.includes('annual')?`<p>年度报告：${esc(this.prep.target_year)} 年</p>`:''}<details><summary>本批文件与采用模板</summary><ul>${this.prep.document_types.includes('workpaper')?selected.map(e=>`<li>${esc(e.code+' '+e.title)} → ${esc(this.automatic()?'光大模板（自动匹配）':this.record(this.prep.mappings[e.id])?.name??'')}</li>`).join(''):''}${this.prep.document_types.filter(t=>t!=='workpaper').map(t=>`<li>${esc(label(t))}</li>`).join('')}</ul></details>${q.omitted.length?`<details open><summary>本次未纳入 ${q.omitted.length} 项</summary><ul>${q.omitted.map(e=>`<li>${esc(e.code+' '+e.title)}</li>`).join('')}</ul></details>`:''}${q.documents?.map(d=>scopeLinesHtml(d)+scopeLifecycleHtml(d)).join('')??''}<div class="fg-actions"><button class="btn primary" id="fg-submit" ${q.quote_status==='pending_scope'?'disabled':''}>确认生成 ${q.count} 份文件</button></div><p id="fg-submit-status" role="status"></p>`);
  d.addEventListener('close',()=>{if(this.activeStep===3){this.activeStep=2;this.stepChanged(2);}});
  d.querySelector<HTMLButtonElement>('#fg-submit')!.onclick=()=>void this.act(async()=>{this.pending=request;this.pendingWire=BILLING_WIRE_VERSION;this.persist();d.querySelector<HTMLButtonElement>('#fg-submit')!.disabled=true;try{await this.submit();d.close();}catch(e){d.querySelector('#fg-submit-status')!.textContent=friendlyError(e,'submit');throw e;}});
 }
 private async submit(){if(!this.pending)return;const batch=await this.request<FileGenerationBatch>('POST','/batches',this.pending);this.pending=undefined;this.persist();this.historyRevision++;this.data!.batches=[batch,...this.data!.batches.filter(b=>b.batch_id!==batch.batch_id)];this.status='本批文件已提交。关闭页面后任务仍会继续，成果保存在下方生成记录中。';this.activeStep=4;this.stepChanged(4);}
 private batchCard(b:FileGenerationBatch){const wp=b.workpapers,docs=b.documents;return `<article class="fg-batch"><div><strong>${date(b.created_at)} · ${formatPoints(b.points)} 积分</strong><small>${wp?'底稿 '+wp.items.filter(i=>i.state==='succeeded').length+'/'+wp.items.length+' · '+({queued:'等待生成',running:'正在生成',paused:'已暂停',complete:'已完成',partial:'部分完成',cancelled:'已结束排队'}[wp.state]):''}${wp?.template_mode?'<small>本批模板：'+({automatic:'光大模板',selected:'所选 Word 模板',mixed:'混合模板'}[wp.template_mode])+'</small>':''}${docs?'　其他文件 '+docs.items.filter(i=>i.state==='succeeded').length+'/'+docs.items.length:''}</small></div><div class="fg-actions">${wp?`<a class="btn secondary" href="#generate?project=${encodeURIComponent(this.project)}&step=workpapers&view=results&batch=${encodeURIComponent(wp.batch_id)}">底稿进度与下载</a>`:''}${docs?`<a class="btn secondary" href="#generate?project=${encodeURIComponent(this.project)}&step=results">其他文件进度与下载</a>`:''}</div></article>`;}
 private async refreshBatches(signal?:AbortSignal){
  const revision=this.historyRevision,read=++this.historyRead,fresh=()=>this.live()&&revision===this.historyRevision&&read===this.historyRead;
  try{const data=await this.request<FileGenerationWorkspace>('GET','',undefined,{},signal);signal?.throwIfAborted();if(!fresh())return false;this.data!.batches=data.batches;this.data!.pricing=data.pricing;const estimate=this.host.querySelector<HTMLElement>('#fg-estimate');if(estimate)estimate.textContent=formatPoints(this.estimate());this.status='生成状态已刷新。';return true;}
  catch(e){if(!fresh())return false;throw e;}
 }
 private historyContent(){return `<div class="fg-section-heading"><h2>生成记录</h2><button class="btn secondary" id="fg-refresh">刷新进度</button></div>${this.data!.batches.length?this.data!.batches.map(b=>this.batchCard(b)).join(''):'<p class="muted">确认生成后，进度和成果会保存在这里。</p>'}<div class="fg-actions"><a href="#generate?project=${encodeURIComponent(this.project)}&step=workpapers&view=results">全部底稿记录</a><a href="#generate?project=${encodeURIComponent(this.project)}&step=results">全部其他文件成果</a><a href="#generate?project=${encodeURIComponent(this.project)}&step=documents&legacy=1">原模板及上传恢复记录</a></div>`;}
 private async refreshHistory(){
  if(this.refreshing)return this.refreshing;
  const flight=this.refreshBatches();this.refreshing=flight;
  try{const applied=await flight;if(!this.live()||!applied)return;const history=this.host.querySelector<HTMLElement>('.fg-history');if(history){history.innerHTML=this.historyContent();history.querySelector<HTMLButtonElement>('#fg-refresh')!.onclick=()=>void this.refreshHistory();}}
  catch(e){this.status=friendlyError(e,'read');}
  finally{this.refreshing=undefined;if(this.live()){const status=this.host.querySelector<HTMLElement>('.fg-status');if(status)status.textContent=this.status;}}
 }
 private poll(){this.poller.start();}
 private async refreshProgress(signal:AbortSignal,force:boolean){
  const progress=await this.request<GenerationProgress>('GET','/progress',undefined,{},signal);
  if(!Value.Check(GenerationProgressSchema,progress))throw new ApiError(503,'DATA_UNAVAILABLE');
  if(!force&&progress.revision===this.progressRevision)return;
  const applied=await this.refreshBatches(signal);signal.throwIfAborted();if(!applied)return;this.progressRevision=progress.revision;
  if(this.live()){const history=this.host.querySelector<HTMLElement>('.fg-history');if(history){history.innerHTML=this.historyContent();history.querySelector<HTMLButtonElement>('#fg-refresh')!.onclick=()=>void this.refreshHistory();}}
 }
}
