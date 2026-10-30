import './upload-progress.css';
import {uploadActivity,uploadTransfer,uploadProgressHtml,type FileUploadProgress,type UploadStatus} from './upload-progress';
import {BILLING_WIRE_HEADER,BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION,formatPoints,int64,serializeInt64,FileGenerationSubmitSchema as LegacyFileGenerationSubmitSchema,type BillingWireVersion,type FileGenerationSubmit as LegacyFileGenerationSubmit} from '@bondbuddy/contracts';
import {PROJECT_DOCUMENT_CATALOG,M4_DOCUMENT_FIXED_PRICE,FileGenerationPreparationSchema,FileGenerationSubmitSchema,emptyFileGenerationPreparation,defaultWorkpaperIds,
 type FileGenerationWorkspace,type FileGenerationPreparation,type FileGenerationSubmit,type FileGenerationQuote,type FileTemplateSet,type FileTemplateRecord,type FileTemplatePin,type FileTemplatePreview,type FileTemplateMatch,type FileGenerationBatch,type WorkpaperCatalogue,type WorkpaperCataloguePreview,type WorkpaperColumnMapping,type ProjectFileWorkspace,type M4DocumentType,type M4MaterialPin} from './billing-types';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,friendlyError} from './api';
import {scopeLinesHtml,scopeLifecycleHtml} from './commerce';
import {UserFacingError} from './user-facing-error';
import {esc,date} from './ui';
import {uploadFileMaterial,type UploadFileMaterialState} from './file-workspace';
import {WorkpaperImportReview} from './workpaper-import-review';
import {UploadRecovery} from './upload-recovery';
import './file-generation-panel.css';
const label=(type:string)=>type==='workpaper'?'尽职调查底稿包':PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)?.name??type;
const pin=(r:FileTemplateRecord):FileTemplatePin=>({set_id:r.set_id,record_id:r.record_id,sha256:r.sha256});
type UploadReceipt={request_id:string;sha256:string;filename:string;document_type:M4DocumentType;set_id?:string};
export class FileGenerationPanel {
 private uploadProgress?:FileUploadProgress; private uploadName="文件";
 private reportUpload:UploadStatus=(s,p)=>{if(!this.live())return;this.status=s;this.uploadProgress=p??uploadActivity(s);this.paint();};
 private controller=new AbortController();private data?:FileGenerationWorkspace;private prep=emptyFileGenerationPreparation();private cat?:WorkpaperCatalogue;
 private activeStep=2;private busy=false;private status='';private dirty=false;private storageError=false;private custom=false;private showMatches=false;private matches:FileTemplateMatch[]=[];
 private pending?:FileGenerationSubmit|LegacyFileGenerationSubmit;private pendingWire:BillingWireVersion=BILLING_WIRE_VERSION;private receipts:UploadReceipt[]=[];private dialog?:HTMLDialogElement;private timer?:ReturnType<typeof setTimeout>;
 private catalogueUpload:UploadFileMaterialState={};private cataloguePin?:M4MaterialPin;private review?:WorkpaperImportReview;private scope:'due_diligence'|'all'='due_diligence';
 private filter='';private focused?:string;private source:ProjectFileWorkspace['source'];
 private modeController?:AbortController;private modeStatus='';private modeDrafts:Partial<Record<'builtin'|'custom',FileGenerationPreparation>>={};
 constructor(private api:ApiClient,private host:HTMLElement,private project:string,private owner:string,private workspace:ProjectFileWorkspace,private current:()=>boolean,private stepChanged:(n:number)=>void=()=>{}){this.source=workspace.source;}
 private get key(){return `bb-file-generation-v2:${this.owner}:${this.project}`;}
 get hasUnconfirmed(){return this.busy||this.dirty||!!this.pending||this.storageError||!!this.modeController;}
 async beforeLeave(){if(this.busy||this.storageError)return false;if(this.dirty){try{await this.save();}catch(e){this.status=friendlyError(e,'save');this.paint();return false;}}return true;}
 dispose(){this.controller.abort();this.modeController?.abort();clearTimeout(this.timer);this.dialog?.remove();}
 private live(){return !this.controller.signal.aborted&&this.current()&&this.host.isConnected;}
 private request<T>(method:string,path='',body?:unknown,headers:Record<string,string>={},signal?:AbortSignal){if(body===this.pending&&this.pending)headers={...headers,[BILLING_WIRE_HEADER]:this.pendingWire};const bounded=method==='GET'||path==='/preparation'||path.startsWith('/template-preview');return this.api.request<T>(method,`/projects/${encodeURIComponent(this.project)}/file-generation${path}`,body,headers,signal??(bounded?AbortSignal.any([this.controller.signal,AbortSignal.timeout(30_000)]):this.controller.signal));}
 private wp<T>(method:string,path:string,body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.project)}/workpapers${path}`,body,{},this.controller.signal);}
 private persist(){try{localStorage.setItem(this.key,JSON.stringify({revision:this.data?.revision,preparation:this.prep,dirty:this.dirty,pending:this.pending,pending_wire:this.pendingWire,receipts:this.receipts,custom:this.custom,modeDrafts:this.modeDrafts}));this.storageError=false;}catch{this.storageError=true;throw new UserFacingError('本浏览器无法保存恢复记录，请恢复存储后重试；尚未提交生成任务。');}}
 async render(){
  this.host.innerHTML='<p role="status">正在读取目录与模板…</p>';
  try{
   this.data=await this.request<FileGenerationWorkspace>('GET');this.prep=structuredClone(this.data.preparation);
   const cached=JSON.parse(localStorage.getItem(this.key)??'null');
   if(cached?.pending){this.pendingWire=cached.pending_wire??LEGACY_BILLING_WIRE_VERSION;if(![BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION].includes(this.pendingWire)||!Value.Check(this.pendingWire===LEGACY_BILLING_WIRE_VERSION?LegacyFileGenerationSubmitSchema:FileGenerationSubmitSchema,cached.pending))throw new UserFacingError('原提交记录无法核实，请保留记录并联系支持。');this.pending=cached.pending;}
   if(cached?.receipts)this.receipts=cached.receipts;
   if(cached?.dirty&&Value.Check(FileGenerationPreparationSchema,cached.preparation)){
    this.prep=cached.preparation;this.dirty=true;
    if(cached.revision!==this.data.revision){this.status='服务端准备清单已变化。你的本地修改仍保留，请重新载入服务端清单后继续。';this.storageError=true;}
   }
   if(this.data.revision===0&&!cached?.dirty){
    const intended=new URLSearchParams(location.hash.split('?')[1]).get('prepare_document');
    if(intended&&PROJECT_DOCUMENT_CATALOG.some(t=>t.id===intended))this.prep.document_types=[intended as M4DocumentType];
    for(const d of PROJECT_DOCUMENT_CATALOG){const template=this.workspace.workspace.drafts[d.id].template;if(template)this.prep.document_templates[d.id]={private_template:template};}
   }
   if(this.prep.catalogue_id)this.cat=await this.wp<WorkpaperCatalogue>('GET','/catalogues/'+encodeURIComponent(this.prep.catalogue_id));
   this.custom=this.set()?.origin==='private'||!!this.cat&&this.cat.filename!=='光大证券底稿目录.xlsx';
   if(cached?.revision===this.data.revision){
    if(typeof cached.custom==='boolean')this.custom=cached.custom;
    for(const mode of ['builtin','custom'] as const)if(Value.Check(FileGenerationPreparationSchema,cached.modeDrafts?.[mode]))this.modeDrafts[mode]=cached.modeDrafts[mode];
   }
   this.paint();this.poll();
   if(!this.custom&&!this.cat&&!this.prep.template_set_id&&this.prep.document_types.includes('workpaper')&&this.data.builtin.available&&!this.pending&&!this.storageError&&!this.dirty)void this.selectMode(false);
   else try{await this.readMatches();this.paint();}catch{this.status='目录和模板已保留，模板匹配暂不可用，请稍后重试。';this.paint();}
  }catch(e){if(this.live())this.host.innerHTML=`<p role="alert">${esc(friendlyError(e,'read'))}</p>`;}
 }
 private async save(){
  if(this.storageError)throw new UserFacingError('原准备清单与当前版本需要核对，请先重新载入。');
  this.dirty=true;this.persist();const result=await this.request<{revision:number;preparation:FileGenerationPreparation}>('PUT','/preparation',{expected_revision:this.data!.revision,preparation:this.prep});
  this.data!.revision=result.revision;this.data!.preparation=structuredClone(result.preparation);this.dirty=false;this.persist();
 }
 private async act(fn:()=>Promise<void>){if(this.busy)return;this.busy=true;this.paint();try{await fn();}catch(e){this.status=friendlyError(e,'save');}finally{this.busy=false;this.uploadProgress=undefined;if(this.live())this.paint();}}
 private async change(fn:()=>void){await this.act(async()=>{fn();this.dirty=true;this.persist();await this.save();});}
 private set(){return this.data?.sets.find(s=>s.set_id===this.prep.template_set_id);}
 private record(p:FileTemplatePin|undefined){return p?this.data?.sets.find(s=>s.set_id===p.set_id)?.records.find(r=>r.record_id===p.record_id):undefined;}
 private async readMatches(){
  const catalogueId=this.prep.catalogue_id,setId=this.prep.template_set_id;
  const matches=catalogueId&&setId?(await this.request<{matches:FileTemplateMatch[]}>('GET',`/matches?catalogue_id=${encodeURIComponent(catalogueId)}&set_id=${encodeURIComponent(setId)}`)).matches:[];
  if(this.live()&&this.prep.catalogue_id===catalogueId&&this.prep.template_set_id===setId)this.matches=matches;
 }
 private cancelModeLoad(){this.modeController?.abort();this.modeController=undefined;this.modeStatus='已取消加载，可以重试或选择自定义目录与模板。';this.paint();}
 private async selectMode(custom:boolean){
  if(this.busy||this.pending||this.storageError)return;
  if(!this.modeController)this.modeDrafts[this.custom?'custom':'builtin']=structuredClone(this.prep);
  this.modeController?.abort();const controller=new AbortController();this.modeController=controller;
  const signal=AbortSignal.any([this.controller.signal,controller.signal,AbortSignal.timeout(60_000)]);
  const previous=this.modeDrafts[custom?'custom':'builtin'];
  const selection=previous??emptyFileGenerationPreparation();
  this.custom=custom;this.cat=undefined;this.matches=[];this.showMatches=false;
  for(const key of ['catalogue_id','template_set_id','item_ids','mappings'] as const)Object.assign(this.prep,{[key]:structuredClone(selection[key])});
  // Old mixed selections remain available until the user explicitly changes mode.
  // A new custom choice never inherits either half of the built-in bundle.
  if(custom&&this.set()?.origin==='builtin'){this.prep.template_set_id=null;this.prep.mappings={};}
  this.modeStatus=custom?'正在读取自定义选择…':'正在加载光大目录与模板，首次加载可能需要一些时间…';this.paint();
  try{
   let cat:WorkpaperCatalogue|undefined;
   if(!custom&&(!this.prep.catalogue_id||!this.set()||this.set()?.version!==this.data!.builtin.version)){
    const result=await this.request<{set:FileTemplateSet;catalogue:WorkpaperCatalogue}>('POST','/builtin',{request_id:crypto.randomUUID(),version:this.data!.builtin.version,part:'all'},{},signal);
    signal.throwIfAborted();if(this.modeController!==controller)return;
    if(!result.set||!result.catalogue)throw new UserFacingError('目录或模板未完整返回，请重试。');
    cat=result.catalogue;this.data!.sets=this.data!.sets.filter(s=>s.set_id!==result.set.set_id);this.data!.sets.unshift(result.set);
    this.prep.catalogue_id=cat.catalogue_id;this.prep.item_ids=defaultWorkpaperIds(cat.entries);this.prep.template_set_id=result.set.set_id;this.prep.mappings={};
    for(const r of result.set.records.filter(r=>r.document_type!=='workpaper'))if(!this.prep.document_templates[r.document_type])this.prep.document_templates[r.document_type]=pin(r);
   }else if(this.prep.catalogue_id){
    cat=await this.api.request<WorkpaperCatalogue>('GET',`/projects/${encodeURIComponent(this.project)}/workpapers/catalogues/${encodeURIComponent(this.prep.catalogue_id)}`,undefined,{},signal);
   }
   signal.throwIfAborted();if(this.modeController!==controller)return;
   this.cat=cat;this.modeController=undefined;this.modeStatus='';
   // Preview becomes available independently of optional matching suggestions.
   await this.act(async()=>{await this.save();this.status=custom?'已切换为自定义目录与模板。':'已采用光大证券目录和模板，可预览内容。';});
   const catalogueId=this.prep.catalogue_id,setId=this.prep.template_set_id;
   if(catalogueId&&setId){
    try{const result=await this.request<{matches:FileTemplateMatch[]}>('GET',`/matches?catalogue_id=${encodeURIComponent(catalogueId)}&set_id=${encodeURIComponent(setId)}`,undefined,{},signal);
     if(!signal.aborted&&this.prep.catalogue_id===catalogueId&&this.prep.template_set_id===setId){this.matches=result.matches;if(!this.host.contains(document.activeElement))this.paint();}
    }catch{if(this.live()&&!signal.aborted&&this.prep.catalogue_id===catalogueId&&this.prep.template_set_id===setId){this.status='目录和模板可正常预览，匹配建议暂不可用，可稍后展开重试。';this.paint();}}
   }
  }catch(e){if(this.modeController!==controller||!this.live())return;this.modeController=undefined;this.modeStatus=signal.aborted?'加载超时，请重试或使用自定义目录与模板。':friendlyError(e,'read');this.paint();}
 }
 private async builtinTemplates(){
  const result=await this.request<{set:FileTemplateSet}>('POST','/builtin',{request_id:crypto.randomUUID(),version:this.data!.builtin.version,part:'templates'},{},AbortSignal.any([this.controller.signal,AbortSignal.timeout(60_000)]));
  if(!this.data!.sets.some(s=>s.set_id===result.set.set_id))this.data!.sets.unshift(result.set);
  for(const r of result.set.records.filter(r=>r.document_type!=='workpaper'))if(!this.prep.document_templates[r.document_type])this.prep.document_templates[r.document_type]=pin(r);
  await this.save();this.status='已添加光大证券文件模板。';
 }
 private workpaperCards(){
  const cat=this.cat,set=this.set(),custom=this.custom,saved=this.data!.sets.filter(s=>s.origin==='private'&&s.records.some(r=>r.document_type==='workpaper'));
  if(!custom&&!cat&&!set)return `<div class="fg-builtin-empty"><strong>光大证券底稿目录与 Word 模板</strong><p>${this.modeController?'正在准备目录与模板，加载完成后即可查看内容。':'加载整套目录与模板后，可预览并选择本次生成的文件。'}</p>${!this.modeController?`<button class="btn primary" id="fg-load-builtin" ${!this.data!.builtin.available?'disabled':''}>加载光大整套</button>`:''}</div>`;
  return `<div class="fg-two-cards ${custom?'fg-custom-cards':''}"><article class="fg-source-card"><header><span class="fg-card-number">01</span><h3>底稿目录</h3>${cat?'<span class="fg-ready">已选择</span>':''}</header><p>决定生成哪些文件</p>
   ${cat?`<div class="fg-selected-file"><strong>${esc(cat.filename)}</strong><small>${cat.entries.filter(e=>e.kind==='file').length} 项目录 · 已选 ${this.prep.item_ids.length} 项</small></div><div class="fg-actions"><button class="btn secondary" id="fg-preview-catalogue">预览目录</button></div>`:`<div class="fg-upload-hint"><strong>上传你的底稿目录</strong><small>Excel（.xlsx），包含编号、名称和编制要求</small></div>`}
   ${custom?`<div class="fg-upload-actions"><label class="btn ${cat?'secondary':'primary'}">${cat?'更换目录':'上传目录'}<input id="fg-catalogue-upload" type="file" accept=".xlsx" hidden></label></div>`:''}</article>
   <article class="fg-source-card"><header><span class="fg-card-number">02</span><h3>底稿文件模板</h3>${set?'<span class="fg-ready">已选择</span>':''}</header><p>决定每份文件的格式与样式</p>
   ${set?`<div class="fg-selected-file"><strong>${esc(set.name)}</strong><small>${set.records.filter(r=>r.document_type==='workpaper').length} 份 Word 模板</small></div><div class="fg-actions"><button class="btn secondary" id="fg-preview-set">预览模板</button></div>`:`<div class="fg-upload-hint"><strong>上传你的 Word 模板</strong><small>支持 DOCX、ZIP 或整个文件夹</small></div>`}
   ${custom?`<div class="fg-upload-actions"><label class="btn ${set?'secondary':'primary'}">${set?'更换模板包':'上传模板'}<input id="fg-template-upload" type="file" accept=".docx,.zip" multiple hidden></label><label class="btn secondary">选择文件夹<input id="fg-folder-upload" type="file" webkitdirectory multiple hidden></label></div>${saved.length?`<label class="fg-saved-label">或使用已保存的模板<select id="fg-saved-set" aria-label="选择已保存模板包"><option value="">选择我的模板包</option>${saved.map(s=>`<option value="${esc(s.set_id)}" ${s.set_id===this.prep.template_set_id?'selected':''}>${esc(s.name)} · ${s.records.filter(r=>r.document_type==='workpaper').length} 份</option>`).join('')}</select></label>`:''}`:''}</article></div>`;
 }
 private paint(){
  if(!this.live()||!this.data)return;this.stepChanged(this.activeStep);
  const p=this.prep,set=this.set(),wp=p.document_types.includes('workpaper'),unmapped=p.item_ids.filter(id=>!p.mappings[id]).length,count=(wp?p.item_ids.length:0)+p.document_types.filter(t=>t!=='workpaper').length;
  const card=(type:string,hint:string)=>`<label class="fg-type ${p.document_types.includes(type as M4DocumentType)?'is-selected':''}"><input type="checkbox" data-fg-type="${type}" ${p.document_types.includes(type as M4DocumentType)?'checked':''}><span><strong>${esc(label(type))}</strong><small>${esc(hint)}</small></span></label>`;
  this.host.innerHTML=`<div class="fg-preparation"><div class="fg-source"><div><small>本次生成依据</small><strong>${esc(this.source?.filename??'尚未选择募集说明书')} ${this.source?'· V'+this.source.sequence:''}</strong></div><a class="btn secondary" href="#generate?project=${encodeURIComponent(this.project)}&step=source">更换募集说明书</a></div>
   <p role="status" class="fg-status" ${this.uploadProgress?'hidden':''}>${esc(this.status)}</p>${this.uploadProgress?'<div class="fg-upload-progress"><strong>'+esc(this.uploadName)+'</strong>'+uploadProgressHtml(this.uploadProgress,this.uploadName)+'</div>':''}${this.storageError?'<button class="btn secondary" id="fg-reload">重新载入服务端清单</button>':''}
   ${this.pending?'<section class="panel fg-recovery"><h2>上次提交的结果待确认</h2><p>将用原提交编号核实结果，不会重复创建文件包。目录、模板和要求暂时锁定。</p><button class="btn primary" id="fg-resolve">确认上次提交结果</button><button class="btn secondary" id="fg-stop-submission">停止尚未提交的请求</button></section>':''}
   <div id="fg-controls"><section class="panel"><h2>这次要生成哪些文件？</h2><p class="muted">可以同时选择多种文件，使用同一份募集说明书。</p><div class="fg-types">${card('workpaper','按目录逐项编制，打包交付')}${PROJECT_DOCUMENT_CATALOG.map(t=>card(t.id,t.hint)).join('')}</div></section>
   <section class="panel fg-template-panel" ${wp?'':'hidden'}><div class="fg-section-heading"><div><h2>底稿目录与文件模板</h2><p class="muted">选择一套现成模板，或上传自己的目录与 Word 模板。</p></div></div><div class="fg-source-choices" role="group" aria-label="目录与模板来源"><button class="fg-option ${!this.custom?'is-selected':''}" id="fg-builtin-all" aria-pressed="${!this.custom}" ${!this.data.builtin.available||this.modeController&&!this.custom?'disabled':''}><strong>直接使用光大整套</strong><small>内置目录与配套 Word 模板，可预览内容</small></button><button class="fg-option ${this.custom?'is-selected':''}" id="fg-custom" aria-pressed="${this.custom}"><strong>自定义目录与模板</strong><small>上传自己的目录，搭配自有 Word 模板</small></button></div>${!this.data.builtin.available?'<p class="fg-notice">光大模板资产尚未安装，可先上传自己的模板。</p>':''}
   ${this.modeStatus?`<div class="fg-load-status" role="status" aria-live="polite"><span>${this.modeController?'<span class="fg-spinner" aria-hidden="true"></span>':''}${esc(this.modeStatus)}</span>${this.modeController?'<button class="text-button" id="fg-cancel-builtin">取消加载</button>':''}</div>`:''}
   ${this.workpaperCards()}
   ${this.cat&&set?`<div class="fg-combination"><span>已选 <b>${p.item_ids.length}</b> 项底稿 · <b>${set.records.filter(r=>r.document_type==='workpaper').length}</b> 份模板</span><button class="text-button" id="fg-match-toggle" aria-expanded="${this.showMatches}">${unmapped?unmapped+' 项待指定模板':'核对逐项模板'} ${this.showMatches?'收起':'展开'}</button></div><div id="fg-matches" ${this.showMatches?'':'hidden'}>${this.showMatches?this.matchTable():''}</div>`:''}
   ${set?.warnings.length?`<details class="fg-notice"><summary>模板导入提示（${set.warnings.length}）</summary>${set.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}<div id="fg-import-review"></div><div id="fg-upload-recovery"></div></section>
   ${p.document_types.filter(t=>t!=='workpaper').length?`<section class="panel"><h2>其他文件的模板</h2><p class="muted">光大证券是模板库来源；文件由对应发行人、承销商或律师事务所等主体出具。</p>${p.document_types.filter(t=>t!=='workpaper').map(t=>this.generalRow(t)).join('')}${p.document_types.includes('annual')?`<label class="fg-year">年度报告目标年度<input id="fg-year" type="number" min="2000" max="2099" placeholder="例如 2026" value="${esc(p.target_year)}"></label>`:''}<button class="text-button" id="fg-general-builtin" ${!this.data.builtin.available?'disabled':''}>添加光大证券内置模板</button></section>`:''}
   <section class="panel"><details open><summary>补充资料与编制要求（选填）</summary><label class="fg-requirements">编制要求<textarea id="fg-requirements" rows="3" maxlength="12000" placeholder="例如目标期间、需重点核查的事项">${esc(p.requirements)}</textarea></label><label class="btn secondary">上传补充资料<input id="fg-support" type="file" multiple accept=".docx,.pdf,.xlsx" hidden></label><span> 已采用 ${p.materials.length} 份补充资料</span><p class="muted">可补充本年财报、批复和履职资料。未披露信息不会被当成已取得的证据。</p><button class="text-button" id="fg-save">保存准备清单</button></details></section></div>
   <footer class="fg-footer"><div><strong>本批 ${count} 份文件</strong><small>${wp&&unmapped?unmapped+' 项底稿尚未指定模板':'采用所选 Word 原稿编制，保留模板格式'} · 预计 ${formatPoints(this.estimate())} 积分</small></div><button class="btn primary" id="fg-confirm" ${!count||!this.source||!!this.pending||this.storageError||!!this.modeController?'disabled':''}>${this.data.pricing?.mode==='automatic'?'开始生成':'核对清单与费用'}</button></footer>
   <section class="panel fg-history"><div class="fg-section-heading"><h2>生成记录</h2><button class="text-button" id="fg-refresh">刷新进度</button></div>${this.data.batches.length?this.data.batches.map(b=>this.batchCard(b)).join(''):'<p class="muted">确认生成后，进度和成果会保存在这里。</p>'}<div class="fg-actions"><a href="#generate?project=${encodeURIComponent(this.project)}&step=workpapers&view=results">全部底稿记录</a><a href="#generate?project=${encodeURIComponent(this.project)}&step=results">全部其他文件成果</a><a href="#generate?project=${encodeURIComponent(this.project)}&step=documents&legacy=1">原模板及上传恢复记录</a></div></section></div>`;
  this.bind();if(this.review&&this.custom)this.review.render(this.host.querySelector('#fg-import-review')!,this.busy);
  if(this.custom)this.paintCatalogueRecovery();this.paintSupportRecovery();
  const controls=this.host.querySelector<HTMLElement>('#fg-controls');if(controls)controls.inert=this.busy||!!this.pending||this.storageError;
  if(this.busy)this.host.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);
  if(this.modeController)this.host.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement|HTMLTextAreaElement>('#fg-controls button,#fg-controls input,#fg-controls select,#fg-controls textarea').forEach(n=>{if(!['fg-custom','fg-builtin-all','fg-cancel-builtin'].includes(n.id))n.disabled=true;});
 }
 private matchTable(){
  if(!this.cat)return '<p>请先选择底稿目录。</p>';
  const selected=new Set(this.prep.item_ids),records=this.set()?.records.filter(r=>r.document_type==='workpaper')??[];
  return `<div class="fg-match-toolbar"><input id="fg-filter" placeholder="搜索编号或名称" aria-label="搜索目录" value="${esc(this.filter)}"><button class="text-button" id="fg-select-all">全选目录</button><button class="text-button" id="fg-select-none">取消全选</button><button class="btn secondary" id="fg-accept-suggestions">采用单一候选建议</button></div><p class="muted">候选仅作建议，请核对事项和角色。未选条目会在确认清单中完整列出。</p><div class="fg-table-scroll"><table><thead><tr><th>生成</th><th>编号与事项</th><th>采用的模板</th><th>预览</th></tr></thead><tbody>${this.cat.entries.filter(e=>e.kind==='file'&&(!this.filter||(e.code+e.title).includes(this.filter))).map(e=>{const current=this.prep.mappings[e.id],match=this.matches.find(m=>m.item_id===e.id);return `<tr><td><input type="checkbox" data-fg-item="${esc(e.id)}" aria-label="生成 ${esc(e.code+' '+e.title)}" ${selected.has(e.id)?'checked':''}></td><td><strong>${esc(e.code)}</strong> ${esc(e.title)}</td><td><select data-fg-mapping="${esc(e.id)}" aria-label="${esc(e.code+' '+e.title)} 的模板"><option value="">${match?.candidates.length?'有 '+match.candidates.length+' 个候选，请指定':'请选择模板'}</option>${records.filter(r=>r.record_id===current?.record_id||match?.candidates.some(c=>c.record_id===r.record_id)).map(r=>`<option value="${esc(r.record_id)}" ${current?.record_id===r.record_id?'selected':''}>${match?.candidates.some(c=>c.record_id===r.record_id)?'建议 · ':''}${esc(r.name)}</option>`).join('')}${current&&!records.some(r=>r.record_id===current.record_id)?`<option value="${esc(current.record_id)}" selected>${esc(this.record(current)?.name??'此前指定模板')}</option>`:''}</select></td><td><button class="text-button" data-fg-preview-item="${esc(e.id)}" ${!current?'disabled':''}>预览</button></td></tr>`;}).join('')}</tbody></table></div>`;
 }
 private generalRow(type:M4DocumentType){
  const chosen=this.prep.document_templates[type],records=this.data!.sets.flatMap(s=>s.records).filter(r=>r.document_type===type),privates=this.workspace.workspace.templates.filter(t=>t.document_type===type&&t.status==='active');
  return `<div class="fg-general-row"><strong>${esc(label(type))}</strong><select data-fg-general="${type}" aria-label="${esc(label(type))}模板"><option value="">请选择模板</option>${records.map(r=>`<option value="${esc(r.set_id+'|'+r.record_id)}" ${chosen&&'record_id' in chosen&&chosen.record_id===r.record_id&&chosen.set_id===r.set_id?'selected':''}>${esc(r.name)} · ${this.data!.sets.find(s=>s.set_id===r.set_id)?.origin==='builtin'?'光大证券':'我的模板'}</option>`).join('')}${privates.map(t=>`<option value="private|${esc(t.template_id)}" ${chosen&&'private_template' in chosen&&chosen.private_template.template_id===t.template_id?'selected':''}>${esc(t.name)} · 已保存</option>`).join('')}</select><button class="text-button" data-fg-general-preview="${type}" ${!chosen||!('record_id' in chosen)?'disabled':''}>预览</button><label class="btn secondary">上传 Word<input type="file" data-fg-general-upload="${type}" accept=".docx" hidden></label></div>`;
 }
 private bind(){
  const click=(id:string,fn:()=>void)=>this.host.querySelector<HTMLButtonElement>('#'+id)?.addEventListener('click',fn);
  click('fg-custom',()=>void this.selectMode(true));
  click('fg-builtin-all',()=>void this.selectMode(false));click('fg-load-builtin',()=>void this.selectMode(false));
  click('fg-cancel-builtin',()=>this.cancelModeLoad());
  click('fg-general-builtin',()=>void this.act(()=>this.builtinTemplates()));
  click('fg-preview-catalogue',()=>this.cataloguePreview());click('fg-preview-set',()=>this.templateLibrary());
  click('fg-match-toggle',()=>{this.showMatches=!this.showMatches;this.paint();if(this.showMatches&&!this.matches.length)void this.readMatches().then(()=>{if(this.showMatches)this.paint();}).catch(()=>{this.status='匹配建议暂不可用，仍可手动选择模板。';this.paint();});});
  click('fg-select-all',()=>void this.change(()=>{this.prep.item_ids=this.cat!.entries.filter(e=>e.kind==='file').map(e=>e.id);}));click('fg-select-none',()=>void this.change(()=>{this.prep.item_ids=[];}));
  click('fg-accept-suggestions',()=>void this.change(()=>{let n=0;for(const m of this.matches)if(m.candidates.length===1&&!this.prep.mappings[m.item_id]){this.prep.mappings[m.item_id]=m.candidates[0];n++;}this.status=`已采用 ${n} 项单一候选。其他条目仍保留，请逐项指定或取消本次生成。`;}));
  click('fg-save',()=>void this.act(async()=>{await this.save();this.status='准备清单已保存，可关闭页面后继续。';}));
  click('fg-stop-submission',()=>void this.act(async()=>{if(!this.pending)return;const result=await this.request<{batch:FileGenerationBatch|null}>('POST','/stop-submission',this.pending);this.pending=undefined;this.persist();if(result.batch)this.data!.batches=[result.batch,...this.data!.batches.filter(b=>b.batch_id!==result.batch!.batch_id)];this.status=result.batch?'原请求已经创建任务，可在生成记录中查看或暂停。':'尚未创建任务，原请求已停止，可以继续修改准备清单。';}));
  click('fg-confirm',()=>void this.act(()=>this.confirm()));click('fg-resolve',()=>void this.act(()=>this.submit()));
  click('fg-refresh',()=>void this.act(()=>this.refreshBatches()));click('fg-reload',()=>void this.act(async()=>{const latest=await this.request<FileGenerationWorkspace>('GET');this.data=latest;this.prep=structuredClone(latest.preparation);this.dirty=false;this.storageError=false;this.modeDrafts={};this.custom=this.set()?.origin==='private';this.persist();if(this.prep.catalogue_id)this.cat=await this.wp<WorkpaperCatalogue>('GET','/catalogues/'+encodeURIComponent(this.prep.catalogue_id));else this.cat=undefined;await this.readMatches();this.status='已载入服务端清单。';}));
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
  const saved=this.host.querySelector<HTMLSelectElement>('#fg-saved-set');if(saved)saved.onchange=()=>void this.act(async()=>{if(!saved.value)return;this.prep.template_set_id=saved.value;this.prep.mappings={};await this.readMatches();await this.save();this.status='已更换模板包，底稿目录保留。';});
  const catalogue=this.host.querySelector<HTMLInputElement>('#fg-catalogue-upload');if(catalogue)catalogue.onchange=()=>{if(catalogue.files?.[0])void this.act(()=>this.uploadCatalogue(catalogue.files![0]));};
  const note=this.host.querySelector<HTMLTextAreaElement>('#fg-requirements');if(note)note.oninput=()=>{this.prep.requirements=note.value;this.dirty=true;try{this.persist();}catch(e){this.status=friendlyError(e,'save');}};
  const year=this.host.querySelector<HTMLInputElement>('#fg-year');if(year)year.onchange=()=>void this.change(()=>{this.prep.target_year=year.value;});
  const filter=this.host.querySelector<HTMLInputElement>('#fg-filter');if(filter)filter.onchange=()=>{this.filter=filter.value;this.paint();};
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
  if(type==='workpaper'){this.prep.template_set_id=combined.set_id;this.prep.mappings={};await this.readMatches();this.showMatches=true;}else this.prep.document_templates[type]=pin(combined.records[0]);
  await this.save();this.status=`已保存 ${combined.records.length} 份 Word 模板。${skipped?'已忽略 '+skipped+' 个 PDF 或其他文件；请核对是否有仅提供 PDF 的事项。':''}`;
 }
 private async uploadCatalogue(file?:File,operationId?:string){
  if(file&&!/\.xlsx$/i.test(file.name))throw new UserFacingError('底稿目录支持 XLSX，旧版 XLS 请另存为 XLSX。');
  if(operationId)this.catalogueUpload={operationId,recovery:new UploadRecovery(this.api,this.owner,this.project,'file-generation-catalogue',()=>this.live())};
  this.uploadName=file?.name??"底稿目录";
  this.cataloguePin=await uploadFileMaterial(this.api,this.project,file,this.controller.signal,this.reportUpload,this.catalogueUpload,this.owner,'file-generation-catalogue');
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
  this.prep.catalogue_id=this.cat.catalogue_id;this.prep.item_ids=defaultWorkpaperIds(this.cat.entries);this.prep.mappings={};await this.readMatches();await this.save();
  if(this.catalogueUpload.operationId)await this.catalogueUpload.recovery?.forget(this.catalogueUpload.operationId);this.catalogueUpload={};this.review=undefined;this.status='已采用新的底稿目录；模板包保留。';
 }
 private paintCatalogueRecovery(){
  if(this.review)return;const host=this.host.querySelector<HTMLElement>('#fg-upload-recovery');if(!host)return;
  try{const recovery=new UploadRecovery(this.api,this.owner,this.project,'file-generation-catalogue',()=>this.live()),records=recovery.list();host.innerHTML=records.map(r=>`<div class="fg-notice"><strong>${esc(r.declaration.filename)}</strong><p>上次目录上传待确认，完成部分已保留。</p><button class="btn secondary" data-fg-resume="${esc(r.id)}">继续识别</button><label class="text-button">重新选择原文件<input type="file" data-fg-reselect="${esc(r.id)}" accept=".xlsx" hidden></label></div>`).join('');host.querySelectorAll<HTMLButtonElement>('[data-fg-resume]').forEach(b=>b.onclick=()=>void this.act(()=>this.uploadCatalogue(undefined,b.dataset.fgResume)));host.querySelectorAll<HTMLInputElement>('[data-fg-reselect]').forEach(n=>n.onchange=()=>{if(n.files?.[0])void this.act(()=>this.uploadCatalogue(n.files![0],n.dataset.fgReselect));});}catch{host.textContent='原上传记录暂不可读取，请刷新后重试。';}
 }
 private modal(title:string,html:string){this.dialog?.remove();const d=document.createElement('dialog');d.className='fg-modal';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="btn secondary" data-close>关闭</button></header>${html}`;document.body.append(d);d.showModal();d.querySelector('[data-close]')!.addEventListener('click',()=>d.close());d.addEventListener('close',()=>d.remove());this.dialog=d;return d;}
 private cataloguePreview(){if(!this.cat)return;this.modal('底稿目录',`<p>${esc(this.cat.filename)} · ${this.cat.entries.length} 项</p><div class="fg-table-scroll"><table><thead><tr><th>编号</th><th>文件名称</th><th>编制要求</th></tr></thead><tbody>${this.cat.entries.map(e=>`<tr><td>${esc(e.code)}</td><td>${esc(e.title)}</td><td>${esc(e.instructions)}</td></tr>`).join('')}</tbody></table></div>`);}
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
  const m=await uploadFileMaterial(this.api,this.project,file,this.controller.signal,this.reportUpload,state,this.owner,'file-generation-support');
  if(!this.prep.materials.some(p=>p.material_id===m.material_id&&p.material_version===m.material_version))this.prep.materials.push(m);await this.save();if(state.operationId)await recovery.forget(state.operationId);
 }
 private paintSupportRecovery(){
  const host=this.host.querySelector('#fg-controls > section:last-child');if(!host)return;
  try{const recovery=new UploadRecovery(this.api,this.owner,this.project,'file-generation-support',()=>this.live());for(const r of recovery.list()){
   const row=document.createElement('div');row.className='fg-notice';row.innerHTML=`<strong>${esc(r.declaration.filename)}</strong><p>补充资料上传待确认。</p><button class="btn secondary" data-resume>继续保存</button><label class="text-button">重新选择原文件<input type="file" accept=".docx,.pdf,.xlsx" hidden></label><button class="text-button" data-forget>停止这次补充</button>`;host.append(row);
   row.querySelector<HTMLButtonElement>('[data-resume]')!.onclick=()=>void this.act(()=>this.resumeSupport(undefined,r.id));row.querySelector<HTMLInputElement>('input')!.onchange=e=>{const f=(e.target as HTMLInputElement).files?.[0];if(f)void this.act(()=>this.resumeSupport(f,r.id));};row.querySelector<HTMLButtonElement>('[data-forget]')!.onclick=()=>void this.act(async()=>{await recovery.forget(r.id);this.status='已停止这次补充，已保存资料保留。';});
  }}catch{this.status='补充资料恢复记录暂不可读取，请刷新后重试。';}
 }
 private estimate(){const p=this.data?.pricing;return serializeInt64((this.prep.document_types.includes('workpaper')?BigInt(this.prep.item_ids.length)*int64(p?.workpaper_points??M4_DOCUMENT_FIXED_PRICE.points):0n)+BigInt(this.prep.document_types.filter(t=>t!=='workpaper').length)*int64(p?p.document_points??'0':M4_DOCUMENT_FIXED_PRICE.points));}
 private async confirm(){
  if(this.review||['file-generation-catalogue','file-generation-support'].some(purpose=>new UploadRecovery(this.api,this.owner,this.project,purpose,()=>this.live()).list().length))throw new UserFacingError('还有目录或补充资料上传待确认，请先在相应卡片完成恢复，再确认生成。');
  if(this.dirty||!this.data!.revision)await this.save();const count=(this.prep.document_types.includes('workpaper')?this.prep.item_ids.length:0)+this.prep.document_types.filter(t=>t!=='workpaper').length;
  const request:FileGenerationSubmit={request_id:crypto.randomUUID(),expected_revision:this.data!.revision,source_version_id:this.source!.version_id,source_selection_revision:this.source!.selection_revision,expected_points:this.estimate(),price_version:this.data!.pricing?.price_version??M4_DOCUMENT_FIXED_PRICE.version};
  const q=await this.request<FileGenerationQuote>('POST','/quote',request);
  request.expected_points=q.points;request.price_version=q.price_version;
  if(q.documents)request.document_quotes=q.documents.filter(d=>d.scope_quote_id).map(d=>({document_type:d.document_type,draft_version:d.draft_version,scope_quote_id:d.scope_quote_id!}));
  if(q.auto_charge&&q.quote_status==='ready'){this.pending=request;this.pendingWire=BILLING_WIRE_VERSION;this.persist();await this.submit();return;}
  this.activeStep=3;this.stepChanged(3);
  const selected=this.cat?.entries.filter(e=>this.prep.item_ids.includes(e.id))??[],d=this.modal('确认本批文件',`<p>募集说明书：${esc(this.source!.filename)} · V${this.source!.sequence}</p><p><strong>${q.count} 份文件 · ${formatPoints(q.points)} 积分</strong></p><p>按现有规则逐份编制与计费，说明文件沿用不收费规则。目录、模板与资料版本将在确认时固定。</p>${this.prep.target_year&&this.prep.document_types.includes('annual')?`<p>年度报告：${esc(this.prep.target_year)} 年</p>`:''}<details><summary>本批文件与采用模板</summary><ul>${this.prep.document_types.includes('workpaper')?selected.map(e=>`<li>${esc(e.code+' '+e.title)} → ${esc(this.record(this.prep.mappings[e.id])?.name??'')}</li>`).join(''):''}${this.prep.document_types.filter(t=>t!=='workpaper').map(t=>`<li>${esc(label(t))}</li>`).join('')}</ul></details>${q.omitted.length?`<details open><summary>本次未纳入 ${q.omitted.length} 项</summary><ul>${q.omitted.map(e=>`<li>${esc(e.code+' '+e.title)}</li>`).join('')}</ul></details>`:''}${q.documents?.map(d=>scopeLinesHtml(d)+scopeLifecycleHtml(d)).join('')??''}<div class="fg-actions"><button class="btn primary" id="fg-submit" ${q.quote_status==='pending_scope'?'disabled':''}>确认生成 ${q.count} 份文件</button></div><p id="fg-submit-status" role="status"></p>`);
  d.addEventListener('close',()=>{if(this.activeStep===3){this.activeStep=2;this.stepChanged(2);}});
  d.querySelector<HTMLButtonElement>('#fg-submit')!.onclick=()=>void this.act(async()=>{this.pending=request;this.pendingWire=BILLING_WIRE_VERSION;this.persist();d.querySelector<HTMLButtonElement>('#fg-submit')!.disabled=true;try{await this.submit();d.close();}catch(e){d.querySelector('#fg-submit-status')!.textContent=friendlyError(e,'submit');throw e;}});
 }
 private async submit(){if(!this.pending)return;const batch=await this.request<FileGenerationBatch>('POST','/batches',this.pending);this.pending=undefined;this.persist();this.data!.batches=[batch,...this.data!.batches.filter(b=>b.batch_id!==batch.batch_id)];this.status='本批文件已提交。关闭页面后任务仍会继续，成果保存在下方生成记录中。';this.activeStep=4;this.stepChanged(4);}
 private batchCard(b:FileGenerationBatch){const wp=b.workpapers,docs=b.documents;return `<article class="fg-batch"><div><strong>${date(b.created_at)} · ${formatPoints(b.points)} 积分</strong><small>${wp?'底稿 '+wp.items.filter(i=>i.state==='succeeded').length+'/'+wp.items.length+' · '+({queued:'等待生成',running:'正在生成',paused:'已暂停',complete:'已完成',partial:'部分完成',cancelled:'已结束排队'}[wp.state]):''}${docs?'　其他文件 '+docs.items.filter(i=>i.state==='succeeded').length+'/'+docs.items.length:''}</small></div><div class="fg-actions">${wp?`<a class="btn secondary" href="#generate?project=${encodeURIComponent(this.project)}&step=workpapers&view=results&batch=${encodeURIComponent(wp.batch_id)}">底稿进度与下载</a>`:''}${docs?`<a class="btn secondary" href="#generate?project=${encodeURIComponent(this.project)}&step=results">其他文件进度与下载</a>`:''}</div></article>`;}
 private async refreshBatches(){const data=await this.request<FileGenerationWorkspace>('GET');this.data!.batches=data.batches;this.data!.pricing=data.pricing;this.status='生成状态已刷新。';}
 private poll(){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.live())return;if(!this.busy&&!this.modeController)void this.refreshBatches().then(()=>{if(this.live()&&!this.dirty&&!this.dialog?.open&&!this.host.contains(document.activeElement))this.paint();}).catch(()=>{}).finally(()=>this.poll());else this.poll();},15000);}
}
