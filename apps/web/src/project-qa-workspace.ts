import {uploadFileDigest} from './upload-file-digest.js';
import './upload-ux.css';
import {orderedUploadPipeline,UploadPreparationError} from './upload-scheduler';
import './upload-progress.css';
import {uploadActivity,uploadTransfer,uploadProgressHtml,type FileUploadProgress} from './upload-progress';
import {billingRecoveryHeaders} from './billing-recovery-wire.js';
import {serializeInt64} from '@bondbuddy/contracts';
import {int64} from '@bondbuddy/contracts';
import {formatPoints} from '@bondbuddy/contracts';
import {isAutomaticCharge,displayCharge} from './commerce';
import {UserFacingError} from './user-facing-error.js';
import {reportBlocks,reportBlockHtml} from './review-report-document';

import {QA_HISTORY_CAPABILITY,PROJECT_QA_PRICE,OUTCOME_PRICE_VERSION,isOutcomePriceVersion,isAutomaticPriceVersion,qaProspectusIssue,MARKET_LABELS,MARKET_OFFERINGS,OFFERING_LABELS,QaWorkspaceSchema,qaSchemas,type QaWorkspace,type QaDraft,type QaRun,type ProjectFileAsset} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {ProspectusPanel} from './prospectus-panel';
import {ProjectEntry} from './project-entry';
import {prototypeIcon} from './prototype-design';
import {ArtifactDownloads,artifactFilename} from './artifact-download';
import {esc,date} from './ui';
import {runStateLabel} from './review-state';
import {withProjectContext,navigationProjectContext,projectWorkHref} from './project-navigation';
import {QaRecoveryJournal} from './qa-recovery-journal';
import {QaRecoveryCache,type QaRecoveryValue,type QaRecoveryPending} from './qa-recovery-cache';
import {qaAssetKey as key,qaSameDraft,qaPreparationFor,qaFollowupFor} from './qa-continuation';
import {UploadRecovery,UploadRecoveryNeedsFileError} from './upload-recovery';
import {QaUploadJournal,qaUploadEnvelope,qaUploadContext,qaUploadRecordMatches,qaUploadAsset,qaUploadMaterialMatches,qaUploadExpected,qaUploadSame,qaUploadMedia,type QaUploadEnvelope,type QaUploadKind} from './qa-upload-recovery';
import {QaReferenceMaterials,qaReferenceSummary} from './qa-reference-materials';
import './file-workspace.css';
import './project-qa-workspace.css';
import {cny,isCnyPrice,displayPrice,scopeReady,scopeLinesHtml,scopeLifecycleHtml,scopeStatusLabel,guardScopeExpiry} from './commerce';

const preparationWarning=(warning:string)=>warning==='没有找到明确的问题编号或问句。请根据原文选择问题段落后开始。'?'暂未能整理出可回答的问题，请检查清单正文或更换文件后重试。':warning==='识别到超过 200 个候选问题，请分批处理或调整范围。'?'清单超过本轮 200 题上限，请拆分文件后重新上传。':warning;
const steps=['上传资料','生成回复','回答与补件'];
const terminal=new Set(['succeeded','failed','cancelled','rejected','test_completed']);
const wordScope='保留完整原问题清单，仅回填本轮所选问题，不会自动合并历史答案。';
const noAcceptance=new Set(['INPUT_REVISION_CONFLICT','PROJECT_RUN_ACTIVE','CREDITS_INSUFFICIENT','QUOTE_CHANGED','INPUT_REQUIRED','MATERIAL_UNREADABLE']);

export class ProjectQaWorkspace {
 private fileProgress=new Map<string,FileUploadProgress>();private preparingUpload?:File;
 private get unitPoints(){return this.state?.price.points??PROJECT_QA_PRICE.points;}
 private priceText(points:string|number|bigint){return displayCharge(this.state?.price,points);}
 private pendingPrice(pending:QaRecoveryPending|undefined){return pending?.kind==='answer'?isOutcomePriceVersion(pending.request.price_version)&&!isAutomaticPriceVersion(pending.request.price_version)?cny(pending.request.expected_points):formatPoints(pending.request.expected_points)+' 积分':'包含在回复任务内';}
 private controller=new AbortController();
 private entry?:ProjectEntry;
 private state?:QaWorkspace;
 private server?:QaWorkspace;
 private project?:Dto<'ProjectResponse'>;
 private busy=false;
 private dirty=false;
 private timer?:ReturnType<typeof setTimeout>;
 private dialog?:HTMLDialogElement;
 private downloads=new ArtifactDownloads();
 private cache?:QaRecoveryCache;
 private journal?:QaRecoveryJournal;
 private journalChoices:QaRecoveryValue[]=[];
 private detachedPending=false;
 private cached:QaRecoveryValue|null=null;
 private pending?:QaRecoveryPending;
 private needsKnowledgeChoice=false;
 private sourceRun?:string;
 private cacheProblem='';
 private foreign?:QaRecoveryValue;
 private conflict=false;
 private message='';
 private readProblem='';
 private followup=new Map<string,Set<string>>();
 private followupOpen=new Set<string>();
 private answerDisclosures=new Map<string,Map<string,boolean>>();
 private uploadJournal?:QaUploadJournal;
 private uploadCore=new Map<QaUploadKind,UploadRecovery>();
 private uploadEnvelopes:QaUploadEnvelope[]=[];
 private uploadFiles=new Map<string,File>();
 private uploadErrors=new Map<string,string>();
 private uploadNeedsFile=new Set<string>();
 private uploadProblem='';
 private uploadSelections:{kind:QaUploadKind;name:string;message:string}[]=[];
 private references=new QaReferenceMaterials();
 private questionsOpen=false;
 private prospectusPanel?:ProspectusPanel;

 private storageChanged=()=>{
  if(!this.cache||!this.state||!this.live())return;
  if(this.cacheMatches()){this.scanUploads();this.paint();return;}
  this.cacheProblem='恢复记录已在其他页面更改。当前问题、材料与原请求仍留在本页，请重新读取并核对已有记录。';
  if(this.pending)this.detachedPending=true;
  this.message=this.cacheProblem;this.dialog?.close();this.paint();
 };
 private cacheMatches(){
  const stored=this.cache?.read();
  return stored?.status==='empty'?this.cached===null:stored?.status==='valid'&&JSON.stringify(stored.value)===JSON.stringify(this.cached);
 }
 private async loadLocalPreparation(){
  const id=this.state!.draft.preparation_id;
  if(!id||this.state!.runs.some(run=>run.run_id===id))return;
  const extra=await this.request<QaWorkspace>('GET','?run_id='+encodeURIComponent(id));
  if(!Value.Check(QaWorkspaceSchema,extra))throw new ApiError(0,'DATA_UNAVAILABLE');
  this.state!.runs=[...this.state!.runs,...extra.runs.filter(run=>!this.state!.runs.some(old=>old.run_id===run.run_id))];
 }

 constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id?:string,private owner?:string){window.addEventListener('storage',this.storageChanged);}
 private live(){return this.current()&&!this.controller.signal.aborted;}
 private href(extra:Record<string,string>={}){return '#qa?'+withProjectContext(new URLSearchParams({project:this.id!,...extra}));}
 private filesHref(){return projectWorkHref('files',navigationProjectContext(location.hash)?.projectId??this.id!)+'?folder=4.2';}
 private selectedRun(){return new URLSearchParams(location.hash.split('?')[1]).get('run');}
 private currentRun(){const id=this.selectedRun();return this.state?.runs.find(r=>r.run_id===id);}
 private query(){const run=this.selectedRun();return run?'?run_id='+encodeURIComponent(run):'';}
 private locked(){return !!this.pending||this.conflict||!!this.cacheProblem||!!this.journalChoices.length;}
 get hasUnconfirmed(){return !!this.prospectusPanel?.hasUnconfirmed||this.busy||!!this.uploadSelections.length||!!this.cacheProblem||!!this.state&&(this.dirty||!!this.pending)&&!this.cacheMatches();}
 async beforeLeave(){
  if(this.prospectusPanel&&!await this.prospectusPanel.beforeLeave())return false;
  if(this.busy)return false;
  if(this.uploadSelections.length){
   const leave=await new Promise<boolean>(resolve=>{
    const d=this.modal('离开前核对本机选择','<p>这些本机文件选择尚未保存，离开后需要重新选择。服务器已收到的文件和可恢复的原请求会保留。</p><button class="btn secondary" data-stay>留在本页</button><button class="btn primary" data-leave>移除本机选择并离开</button>');
    let confirmed=false;d.querySelector('[data-stay]')!.addEventListener('click',()=>d.close());
    d.querySelector('[data-leave]')!.addEventListener('click',()=>{confirmed=true;d.close();});
    d.addEventListener('close',()=>resolve(confirmed),{once:true});
   });
   if(!leave)return false;this.uploadSelections=[];
  }
  if(!this.state||!this.id)return true;
  if(this.pending)return this.verifyCache();
  if(this.dirty)return this.persist();
  return true;
 }
 dispose(){window.removeEventListener('storage',this.storageChanged);this.controller.abort();this.entry?.dispose();this.prospectusPanel?.dispose();clearTimeout(this.timer);this.dialog?.remove();this.downloads.dispose();}
 private error(e:unknown,operation:'read'|'save'|'download'|'submit'|'action'='action'){return friendlyError(e,operation);}
 private statusText(){return [this.message,this.readProblem].filter(Boolean).join(' ');}
 private syncStatus(){const node=document.querySelector('#project-qa-status');if(node)node.textContent=this.statusText();}
 private status(text:string){this.message=text;this.syncStatus();}
 private request<T>(method:'GET'|'POST',suffix:string,body?:unknown,headers:Record<string,string>={}){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id!)}/qa${suffix}`,body,{...headers,[QA_HISTORY_CAPABILITY.header]:QA_HISTORY_CAPABILITY.value},this.controller.signal);}
 private async read(){const value=await this.request<QaWorkspace>('GET',this.query());if(!Value.Check(QaWorkspaceSchema,value))throw new ApiError(0,'DATA_UNAVAILABLE');return value;}
 private snapshot():QaRecoveryValue{return {revision:this.state!.revision,draft:structuredClone(this.state!.draft),...(this.needsKnowledgeChoice?{needsKnowledgeChoice:true}:{}),...(this.sourceRun?{sourceRun:this.sourceRun}:{}),...(this.pending?{pending:structuredClone(this.pending)}:{})};}
 private cacheError(status:string){
  this.cacheProblem=status==='conflict'?'另一页面已更改本机准备记录。请重新读取并核对两份内容，当前输入仍留在页面。':status==='invalid'?'本机恢复记录无法核实。当前输入仍留在页面，请保留内容并联系支持。':'本机恢复记录暂时无法保存。请允许浏览器保存本站数据后重试；确认保存前无法提交任务。';
  this.status(this.cacheProblem);
 }
 private persist(){
  const value=this.snapshot();
  const retained=value.pending?this.journal?.retain(value):undefined;
  if(retained&&retained.status!=='valid'){this.cacheError(retained.status);if(this.live()&&this.project)this.paint();return false;}
  if(this.detachedPending&&this.pending){this.cacheProblem='';return retained?.status==='valid';}
  const result=this.cache?.save(value,this.cached);
  if(result?.status==='valid'){this.cached=result.value;this.cacheProblem='';return true;}
  this.cacheError(result?.status??'unavailable');if(this.live()&&this.project)this.paint();return false;
 }
 private verifyCache(){
  // Compare and read back the complete immutable pending body before any retry.
  return this.persist();
 }
 private changed(){
  if(this.pending)return;
  this.dirty=true;this.persist();
  this.syncActions();
 }
 private syncActions(){
  const blocked=this.busy||this.locked()||this.hasUploads();
  const controls=document.querySelector<HTMLFieldSetElement>('#qa-preparation-controls');
  if(controls)controls.disabled=this.busy||this.locked();
  const upload=document.querySelector<HTMLInputElement>('#qa-upload'),history=document.querySelector<HTMLSelectElement>('#qa-history');
  if(upload)upload.disabled=blocked;
  if(history)history.disabled=this.busy||this.locked();
   document.querySelectorAll<HTMLButtonElement>('[data-qa-upload-action]').forEach(button=>{const envelope=this.uploadEnvelopes.find(e=>e.items.some(i=>i.id===button.dataset.operation)),index=envelope?.items.findIndex(i=>i.id===button.dataset.operation)??-1;button.disabled=this.busy||!!this.pending||!envelope||index<0||index>0&&!envelope.items[index-1].applied;});
   document.querySelectorAll<HTMLInputElement|HTMLButtonElement>('[data-qa-upload-reselect],[data-qa-upload-stop]').forEach(control=>control.disabled=this.busy||!!this.pending);
  const run=this.currentRun(),follow=run?.operation==='answer'?qaFollowupFor(run,this.state!.runs,this.id!):undefined;
  document.querySelectorAll<HTMLButtonElement>('#qa-view-missing,#qa-prepare-next').forEach(button=>button.disabled=this.busy||this.locked()||!follow||!!follow.error);
  const unavailable=this.state!.draft.materials.some(a=>!this.state!.materials.some(m=>key(a)===key(m.asset)));
  const save=document.querySelector<HTMLButtonElement>('#qa-save'),start=document.querySelector<HTMLButtonElement>('#qa-start');
  if(save)save.disabled=blocked;
  if(start)start.disabled=blocked||!!this.prospectusIssue()||unavailable||!this.state!.draft.questions.length||!!qaPreparationFor(this.state!.draft,this.state!.runs,this.id!).error;
 }
 private adoptLocal(value:QaRecoveryValue){
  this.state!.draft=structuredClone(value.draft);this.state!.revision=value.revision;
  this.pending=value.pending?structuredClone(value.pending):undefined;
  // Retain legacy flags only on immutable requests awaiting acknowledgement.
  this.needsKnowledgeChoice=!!value.pending&&value.needsKnowledgeChoice===true;this.sourceRun=value.sourceRun;
  this.dirty=!!value.sourceRun||!qaSameDraft(value.draft,this.server!.draft)||value.revision!==this.server!.revision;
 }
 private restore(fresh:QaWorkspace){
  this.state=structuredClone(fresh);this.server=structuredClone(fresh);
  const saved=this.cache!.read();
  if(saved.status==='empty'){this.cached=null;return;}
  if(saved.status!=='valid'){this.cacheError(saved.status);return;}
  this.cached=saved.value;this.adoptLocal(saved.value);
  if(!this.pending&&saved.value.revision!==fresh.revision){
   this.conflict=true;this.message='本机准备与服务器版本不同。两份内容均已保留，请选择本轮采用哪一份。';
  }else if(!this.pending&&this.dirty)this.message='已恢复本机准备内容；尚未提交服务器或开始回答。';
 }
 private async act(fn:()=>Promise<void>,operation:'read'|'save'|'download'|'submit'|'action'='action'){
  if(this.busy)return;
  this.busy=true;
  const fields=[...document.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement|HTMLTextAreaElement>('.qa-page input,.qa-page button,.qa-page select,.qa-page textarea,.qa-modal input,.qa-modal button,.qa-modal select,.qa-modal textarea')].filter(n=>!n.closest('.bb-assistant')).map(n=>({n,disabled:n.disabled}));
  fields.forEach(x=>x.n.disabled=true);
  try{await fn();}catch(e){if(this.live()){this.status(this.error(e,operation==='read'||operation==='download'?operation:this.pending?this.pending.kind==='draft'?'save':'submit':operation));const status=this.dialog?.querySelector('[role=status]');if(status)status.textContent=this.error(e,operation==='read'||operation==='download'?operation:this.pending?this.pending.kind==='draft'?'save':'submit':operation);}}
  finally{this.busy=false;fields.forEach(x=>{if(x.n.isConnected)x.n.disabled=x.disabled;});if(this.live())this.syncActions();}
 }
 async render(){
  if(!this.id){
   this.entry=new ProjectEntry(this.api,this.shell,()=>this.live(),{section:'qa',title:'项目问答',eyebrow:'PROJECT Q&A',description:'先确认本项目募集说明书，再上传问题清单。结合项目资料逐题回答，缺少的材料会逐项列明。',steps,next:'下一步：确认项目资料',onNew:()=>this.newProject(),open:async id=>{if(this.live())location.hash='qa?project='+encodeURIComponent(id);}});
   await this.entry.render();return;
  }
  this.shell('<p role="status">正在读取项目问答…</p>','qa');
  try{
   const [project,fresh]=await Promise.all([this.api.project(this.id,this.controller.signal),this.read()]);
   if(!this.live())return;
   this.readProblem='';
   this.project=project;this.cache=new QaRecoveryCache(this.owner??'',this.id);this.journal=new QaRecoveryJournal(this.owner??'',this.id);this.restore(fresh);await this.loadLocalPreparation();this.scanJournal();
   this.uploadJournal=new QaUploadJournal(this.owner??'',this.id);
   if(this.owner)for(const kind of ['source','supplement'] as const)this.uploadCore.set(kind,new UploadRecovery(this.api,this.owner,this.id,`qa-${kind}`,()=>this.live()));
   this.scanUploads();this.prepareCurrentRun();if(this.live())this.paint();
  }catch(e){if(this.live()){
   this.shell(`<h1>项目问答暂时无法打开</h1><p role="alert">${esc(this.error(e,'read'))}</p><button class="btn primary" id="qa-retry-read">重新读取</button> <a href="#qa">重新选择项目</a>`,'qa');
   document.querySelector('#qa-retry-read')?.addEventListener('click',()=>{if(this.live())void this.render();},{once:true});
  }}
 }
 private header(){return `<header class="page-head"><div><p class="eyebrow">PROJECT Q&amp;A</p><h1>项目问答</h1><p>基于募集说明书和项目资料逐题回答，资料不足时明确列出补充要求。</p></div><a class="text-button" href="#qa">更换项目</a></header>${navigationProjectContext(location.hash)?.projectId===this.id?'':`<div class="pf-source-strip"><strong>${esc(this.project!.name)}</strong><a href="${esc(this.filesHref())}">项目文件 →</a></div>`}`;}


 private prospectusIssue(){
  const d=this.state!.draft,source=this.state!.runs.find(r=>r.run_id===d.preparation_id)?.manifest.source.asset;
  return qaProspectusIssue(this.state!.prospectus,d.materials,source);
 }
 private defaultMaterials(r:QaRun){
  const items=this.state!.materials.filter(m=>key(m.asset)!==key(r.manifest.source.asset));
  const prospectus=this.state!.prospectus;
  if(prospectus)items.sort((a,b)=>Number(key(b.asset)===key(prospectus.asset))-Number(key(a.asset)===key(prospectus.asset)));
  return items.slice(0,50).map(m=>structuredClone(m.asset));
 }
 private selectProspectus(){
  if(this.locked()||this.busy||!this.state!.prospectus)return;
  const d=this.state!.draft,p=this.state!.prospectus;
  const source=this.state!.runs.find(r=>r.run_id===d.preparation_id)?.manifest.source.asset;
  if(source&&key(source)===key(p.asset)){this.status('问题清单不能作为募集说明书，请重新选择。');return;}
  if(!d.materials.some(a=>key(a)===key(p.asset))){
   if(d.materials.length>=50){this.status('本轮材料已达 50 份，请先移除一份补充材料，再选入募集说明书。');return;}
   d.materials=[structuredClone(p.asset),...d.materials];this.changed();
  }
  this.paint();
 }
 private workflow(run:QaRun|undefined,prepared:QaRun|undefined){
  const active=run?.operation==='answer'?2:prepared||run?.operation==='prepare'?1:0;
  return `<ol class="qa-workflow" aria-label="项目问答流程">${steps.map((label,i)=>`<li ${i===active?'aria-current="step"':''}><span>${i+1}</span>${label}</li>`).join('')}</ol>`;
 }
 private projectMaterials(run?:QaRun){
  const historical=run?.operation==='answer',p=historical?run.manifest.prospectus:this.state!.prospectus;
  const selected=p&&(historical||this.state!.draft.materials.some(a=>key(a)===key(p.asset)));
  return `<section class="panel qa-project-materials" aria-label="项目资料"><header><div><h2>${historical?'本轮项目资料':'项目资料'}</h2><p>${historical?'回答使用提交时固定的材料版本。':'募集说明书是回答的必需资料，可补充财务报告、业务明细等材料。'}</p></div><span class="qa-material-badge ${p?'':'is-missing'}">${p?'募集说明书已就绪':historical?'历史依据待核对':'缺少募集说明书'}</span></header><div class="qa-prospectus-row"><span class="qa-upload-icon" aria-hidden="true">${prototypeIcon('file')}</span><div><strong>${p?esc(p.filename):historical?'此历史任务未单独记录募集说明书版本':'先提供本项目募集说明书'}</strong><p>${p?`采用版本 V${p.sequence}${run?.operation==='prepare'?' · 用于本轮回答':selected?' · 已纳入本轮材料':' · 回答前需选入本轮材料'}`:historical?'请在逐题回答中核对当时引用的材料。':'问题清单可以先上传整理；补齐募集说明书后才能开始回答。'}</p></div>${!historical?`<button class="btn ${p?'secondary':'primary'}" id="qa-manage-prospectus" ${this.locked()?'disabled':''}>${p?'管理募集说明书':'上传或选择募集说明书'}</button>`:''}</div>${!historical?`<footer>${p&&!run&&!selected&&this.state!.draft.preparation_id?`<button class="btn secondary" id="qa-select-prospectus" ${this.locked()?'disabled':''}>用于本轮回答</button>`:''}<button class="text-button" id="qa-refresh-materials" ${this.locked()?'disabled':''}>刷新项目资料</button></footer>`:''}</section>`;
 }
 private async manageProspectus(){
  if(this.locked()||this.busy)return;
  this.prospectusPanel?.dispose();
  const d=this.modal('本项目募集说明书','<p>上传成功后自动用于本轮问答，无需再次确认。</p><div id="qa-prospectus-panel"></div>');
  const panel=this.prospectusPanel=new ProspectusPanel(this.api,this.state!.prospectus?.project_id??this.id!,d.querySelector('#qa-prospectus-panel')!,async()=>!this.busy&&!this.locked(),async()=>{
   const fresh=await this.read();if(!this.live())return;
   const previous=this.state!.prospectus;
   this.state!.prospectus=fresh.prospectus;this.state!.materials=fresh.materials;
   // A deliberate upload or version choice also updates the editable answer inputs.
   // Historical runs retain their immutable manifests.
   if(fresh.prospectus){
    const draft=this.state!.draft,next=structuredClone(fresh.prospectus.asset);
    const materials=draft.materials.filter(a=>key(a)!==key(next)&&(!previous||key(a)!==key(previous.asset)));
    if(materials.length<50){draft.materials=[next,...materials];this.changed();}
    else this.status('募集说明书已选用。本轮材料已达 50 份，请移除一份补充材料后选入募集说明书。');
   }
   d.close();this.paint();
  },()=>{},'qa',this.owner);
  const guard=(e:Event)=>{if(panel.hasUnconfirmed){e.preventDefault();e.stopImmediatePropagation();void panel.beforeLeave();}};
  d.querySelector('[data-close]')!.addEventListener('click',guard,true);d.addEventListener('cancel',guard,true);
  d.addEventListener('close',()=>{panel.dispose();if(this.prospectusPanel===panel)this.prospectusPanel=undefined;});
  try{await panel.refresh();}catch(e){if(d.isConnected)d.querySelector('[role=status]')!.textContent=this.error(e,'read');}
 }
 private preparationResult(r:QaRun){
  const questions=r.result?.questions??[];
  return `<div class="qa-prepared"><div class="qa-prepared-heading"><span class="qa-material-badge ${questions.length?'':'is-missing'}">${questions.length?'问题清单已就绪':'需要重新上传'}</span><h3>${questions.length?`问题清单 · ${questions.length} 题`:'暂未能整理出可回答的问题'}</h3><p>${questions.length?'这是另一份历史问题清单，可用于新一轮回答。':'请检查问题清单正文，或更换可读取的 Word / PDF 后重试。'}</p></div>${questions.length?`<ol class="qa-candidate-list">${questions.map(q=>`<li><p>${esc(q.question)}</p><small>原文段落 ${q.start+1}${q.end>q.start?'–'+(q.end+1):''}</small></li>`).join('')}</ol>`:''}${r.result?.warnings.map(w=>`<p class="qa-warning">${esc(preparationWarning(w))}</p>`).join('')??''}<footer class="qa-actions"><p>尚未开始回答</p><button class="btn primary" id="qa-use-preparation" ${this.locked()||!r.result?'disabled':''}>将此清单用于新一轮</button></footer></div>`;
 }
 private usePreparation(r:QaRun){
  if(this.locked()||!r.result)return;
  const draft:QaDraft={preparation_id:r.run_id,questions:structuredClone(r.result.questions),materials:this.defaultMaterials(r),requirements:'',use_knowledge:false};
  const check=qaPreparationFor(draft,this.state!.runs,this.id!);if(check.error){this.status(check.error);return;}
  this.state!.draft=draft;this.needsKnowledgeChoice=false;this.sourceRun=r.run_id;this.dirty=true;this.persist();
 }
 private prepareCurrentRun(){
  const run=this.currentRun();
  if(!run||run.operation!=='prepare'||run.state!=='succeeded'||this.locked()||this.state!.draft.preparation_id===run.run_id)return;
  // Only a newly requested preparation, or an empty workspace, adopts itself.
  // Merely visiting an older run must not replace another round's edits.
  if(this.sourceRun===run.run_id||(!this.state!.draft.preparation_id&&!this.dirty))this.usePreparation(run);
 }
 private activeTasks(){
  const active=this.state!.runs.filter(run=>!terminal.has(run.state)&&run.run_id!==this.selectedRun());
  if(!active.length)return '';
  return `<section class="qa-recovery" aria-label="进行中的问答任务"><h2>进行中的问答任务</h2>${active.map(run=>`<p>${run.operation==='prepare'?'处理问题清单':'回答问题'} · ${esc(runStateLabel[run.state as keyof typeof runStateLabel]??'状态待核对')}</p><a class="btn secondary" href="${esc(this.href({run:run.run_id}))}">查看进度与操作</a>`).join('')}</section>`;
 }

 private scanJournal(){
  const read=this.journal!.readAll();
  if(read.status!=='valid'){this.cacheError(read.status);return;}
  const own=this.pending?this.snapshot():undefined;
  if(own){
   const retained=this.journal!.retain(own);
   if(retained.status!=='valid'){this.cacheError(retained.status);return;}
  }
  this.journalChoices=read.values.filter(value=>!own||JSON.stringify(value)!==JSON.stringify(own));
 }
 private chooseJournal(index:number){
  const value=this.journalChoices[index];if(!value||this.pending)return;
  const read=this.journal!.readAll();
  if(read.status!=='valid'||!read.values.some(item=>JSON.stringify(item)===JSON.stringify(value))){this.cacheError(read.status);this.paint();return;}
  const parent=this.cache!.read();
  if(parent.status!=='valid'&&parent.status!=='empty'){this.cacheError(parent.status);this.paint();return;}
  this.adoptLocal(value);this.detachedPending=true;this.journalChoices=[];this.cacheProblem='';
  if(parent.status==='empty'){const restored=this.cache!.save(value,null);if(restored.status!=='valid'){this.cacheError(restored.status);this.paint();return;}this.cached=restored.value;}
  else this.cached=parent.value!;
  this.message='已恢复独立保存的原请求。尚未重新提交，请核对原范围与费用后明确恢复。';this.paint();
 }
 private finishRecovery(previous:QaRecoveryValue,next:QaRecoveryValue):{ok:boolean;foreign:boolean}{
  const stored=this.cache!.read();let foreign=false;
  if(stored.status!=='valid'&&stored.status!=='empty'){this.cacheError(stored.status);return {ok:false,foreign:false};}
  const matches=stored.status==='valid'&&JSON.stringify(stored.value)===JSON.stringify(previous);
  if(!this.detachedPending||matches){
   const saved=this.cache!.save(next,this.detachedPending?stored.status==='valid'?stored.value:null:this.cached);
   if(saved.status!=='valid'){this.detachedPending=true;this.cacheError(saved.status);return {ok:false,foreign:false};}
   this.cached=saved.value;
  }else{
   // Another page owns this draft slot. Only our independent original envelope
   // may be confirmed; its acknowledgement never replaces the other preparation.
   this.cached=stored.status==='valid'?stored.value:null;foreign=true;
  }
  const confirmed=this.journal!.confirm(previous);
  if(confirmed.status!=='empty'){
   // The API receipt (or exact draft GET) is already authoritative and the
   // main draft is safe. A delete/readback failure is local cleanup uncertainty,
   // not an unknown server request. Keep its exact task navigation available.
   this.detachedPending=false;this.cacheProblem='';this.message='服务器已确认本次请求。本机恢复记录清理尚待核对。';return {ok:true,foreign};
  }
  this.detachedPending=false;this.cacheProblem='';return {ok:true,foreign};
 }
 private async retryOriginalConflict(){
  if(!this.pending)return;
  const read=this.cache!.read();
  if(read.status!=='valid'&&read.status!=='empty'){this.cacheError(read.status);this.paint();return;}
  const retained=this.journal!.retain(this.snapshot());
  if(retained.status!=='valid'){this.cacheError(retained.status);this.paint();return;}
  this.detachedPending=true;this.cacheProblem='';
  if(this.pending.kind==='draft')await this.refreshPendingDraft();else await this.sendPending();
 }
 private draftSummary(draft:QaDraft,label:string,context:unknown){
  return '<h3>'+esc(label)+'</h3><p>'+draft.questions.length+' 题 · '+draft.materials.length+' 份材料</p><p>'+esc(draft.requirements)+'</p><ul>'+draft.questions.map(q=>'<li>原文段落 '+(q.start+1)+'：'+esc(q.question)+'</li>').join('')+'</ul>'+qaReferenceSummary(draft.materials,this.state!.materials,this.references.reviewScope([this.id,label,draft,context]));
 }
 private recheckCache(){
  const stored=this.cache!.read();
  if(stored.status==='valid'&&JSON.stringify(stored.value)!==JSON.stringify(this.cached)){
   this.foreign=stored.value;this.cacheProblem='本机已有另一页面保存的恢复记录。两份内容已列出，请核对后明确选择；不会覆盖另一页面的原请求。';this.paint();return;
  }
  if(stored.status==='invalid'||stored.status==='unavailable'){this.cacheError(stored.status);this.paint();return;}
  if(stored.status==='empty'&&this.cached!==null){this.cacheProblem='本机恢复记录已被其他页面移除。当前输入仍保留，请先复制内容并核对其他页面。';this.paint();return;}
  this.persist();this.paint();
 }
 private useStored(){
  if(this.pending){this.status('本页原请求尚未核实，不能用另一份准备替换。');return;}
  const stored=this.cache!.read();
  if(stored.status!=='valid'||JSON.stringify(stored.value)!==JSON.stringify(this.foreign)){this.recheckCache();return;}
  this.cached=stored.value;this.adoptLocal(stored.value);this.foreign=undefined;this.cacheProblem='';
  this.conflict=!this.pending&&stored.value.revision!==this.server!.revision;
  this.message='已采用所选本机恢复记录。尚未提交新请求。';this.paint();
 }
 private recovery(){
  if(!this.pending&&this.journalChoices.length)return `<section class="qa-recovery"><h2>发现独立保存的原请求</h2><p>另一页面的准备记录没有覆盖这些原请求。重新打开页面不会自动提交，请先选择要核对的一项。</p>${this.journalChoices.map((value,index)=>`<article><h3>${{draft:'准备内容保存',prepare:'问题清单整理',answer:'回答任务'}[value.pending!.kind]}</h3><p>原修订 ${value.revision} · ${value.draft.questions.length} 题 · ${this.pendingPrice(value.pending)}</p>${this.references.reviewDetails(['journal',this.id,value],'原问题、材料和要求',this.draftSummary(value.draft,'原请求准备',value))}<button class="btn secondary" ${index===0?'id="qa-restore-journal"':''} data-qa-journal="${index}">采用此原请求，继续核对</button></article>`).join('')}</section>`;

  if(this.cacheProblem)return `<section class="qa-recovery"><h2>请先恢复本机保存</h2><p>${esc(this.cacheProblem)}</p><p>${this.pending?'原'+({draft:'保存',prepare:'问题整理',answer:'回答'}[this.pending.kind])+'请求仍保留，当前不会重新提交。':''}</p>${this.foreign?`${this.references.reviewDetails(['stored',this.id,this.state!.revision,this.state!.draft,this.pending,this.foreign],'对照当前页面与已有恢复记录',this.draftSummary(this.state!.draft,'当前页面准备',[this.state!.revision,this.pending])+this.draftSummary(this.foreign.draft,'已有恢复记录',this.foreign)+'<p>已有记录'+(this.foreign.pending?'包含待核实的原请求':'尚未提交新任务')+'。采用会替换当前页准备，可先复制上方内容。</p>',true)}<button class="btn secondary" id="qa-use-stored" ${this.pending?'disabled':''}>采用已有恢复记录</button>`:''}${this.pending?`<p>原请求仍按 ${this.state!.draft.questions.length} 题、${this.pendingPrice(this.pending)} 核对；尚未受理时会首次提交原请求。不会改写另一页面准备。</p><button class="btn secondary" id="qa-retry-original-conflict">${this.pending.kind==='draft'?'只读核对本页原保存':'恢复或提交本页原请求'}</button>`:''}<button class="btn secondary" id="qa-recheck-cache">重新读取恢复记录</button></section>`;

  if(this.pending){
   const kind=this.pending.kind,points=BigInt(this.state!.draft.questions.length)*int64(this.unitPoints);
   return `<section class="qa-recovery" role="region" aria-label="恢复原请求"><h2>${kind==='draft'?'准备内容保存结果待核实':kind==='prepare'?'问题清单处理请求待核实':'回答请求待核实'}</h2>${this.references.reviewDetails(['pending',this.id,this.state!.revision,this.state!.draft,this.pending],'核对原问题、材料和要求',this.draftSummary(this.state!.draft,'原请求准备',[this.state!.revision,this.pending]))}<p>${kind==='draft'?'原问题、材料和要求已保留。只读取服务器版本，完整一致后才解除冻结；不会再次保存。':kind==='prepare'?'原问题清单和请求已保留。重新打开页面不会自动提交。':'原 '+this.state!.draft.questions.length+' 题、'+this.state!.draft.materials.length+' 份材料和 '+this.pendingPrice(this.pending)+' 费用确认已保留。重新打开页面不会自动提交。'}</p><p>${kind==='draft'?'如果服务器已有其他修改，将保留双方内容，不覆盖最新版本。':kind==='answer'?'“恢复或提交原请求”会查询原提交回执；若原请求未被接收，会首次开始原任务并预留上述费用。':'“恢复或提交原请求”会恢复原回执；若原请求未被接收，会首次开始问题整理。'}</p>${kind==='draft'?'<button class="btn secondary" id="qa-refresh-pending">只读核对保存结果</button>':'<button class="btn secondary" id="qa-retry-pending">恢复或提交原请求</button>'}</section>`;
  }
  if(this.conflict&&this.server)return `<section class="qa-recovery"><h2>选择要继续的准备内容</h2><p>本机：${this.state!.draft.questions.length} 题，${this.state!.draft.materials.length} 份材料，修订 ${this.state!.revision}。服务器：${this.server.draft.questions.length} 题，${this.server.draft.materials.length} 份材料，修订 ${this.server.revision}。</p>${this.references.reviewDetails(['conflict',this.id,this.state!.revision,this.state!.draft,this.server.revision,this.server.draft],'对照两份回答要求、问题与材料',this.draftSummary(this.state!.draft,'本机准备',this.state!.revision)+this.draftSummary(this.server.draft,'服务器准备',this.server.revision))}<p>选择仅更新本机准备。之后仍需确认保存和费用，才会开始回答。</p><button class="btn secondary" id="qa-keep-local">保留本机准备，在最新修订上继续</button><button class="text-button" id="qa-use-server">使用服务器准备</button></section>`;
  if(this.cacheProblem)return `<section class="qa-recovery"><h2>请先恢复本机保存</h2><p>${esc(this.cacheProblem)}</p><button class="btn secondary" id="qa-recheck-cache">重新读取恢复记录</button></section>`;
  return '';
 }
 private paint(){
  if(!this.live()||!this.state)return;
  clearTimeout(this.timer);
  this.references.capture();
  const preview=document.querySelector<HTMLDetailsElement>('[data-qa-questions-preview]');if(preview)this.questionsOpen=preview.open;
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-answer-run][data-qa-answer-question]').forEach(row=>{
   const run=row.dataset.qaAnswerRun!,question=row.dataset.qaAnswerQuestion!;let saved=this.answerDisclosures.get(run);if(!saved){saved=new Map();this.answerDisclosures.set(run,saved);}saved.set(question,row.open);
  });
  const run=this.currentRun(),requested=this.selectedRun(),check=qaPreparationFor(this.state.draft,this.state.runs,this.id!),prepared=check.preparation,locked=this.locked()||this.busy;
  const editing=prepared&&(this.pending||!requested||run?.run_id===prepared.run_id);
  let content=editing?this.draft(prepared):requested&&!run?`<div class="collection-empty"><h3>无法读取指定的问答版本</h3><p>此版本可能已移除或暂不可用。没有改用其他版本。</p><a href="${esc(this.href())}">返回本项目准备内容与历史</a></div>`:run?this.result(run):`<div class="collection-empty"><h3>让回答留在问题旁边</h3><p>上传问题清单和项目材料 → 生成回复 → 下载 Word</p>${this.state.draft.preparation_id?`<p role="alert">${esc(check.error??'当前准备依据无法核实，请重新读取。')} 现有输入仍保留。</p>`:''}</div>`;
  if(!editing&&(run||!prepared)&&this.uploadEnvelopes.some(e=>e.kind==='supplement'))content+=`<details class="qa-materials" open><summary>原准备的补充材料</summary>${this.uploadRows('supplement')}</details>`;
  const empty=!run&&!requested&&!prepared;
  const history=this.state.runs.filter(r=>r.operation==='answer').sort((a,b)=>b.sequence-a.sequence);
  const sourceName=run?.manifest.source.filename??prepared?.manifest.source.filename;
  const upload=`<section class="panel qa-upload ${empty?'qa-upload-empty':'qa-upload-compact'}" aria-label="问题清单上传">
   <div class="qa-upload-icon" aria-hidden="true">${prototypeIcon('file')}</div><div class="qa-upload-copy"><h2>${empty?'上传问题清单':'问题清单'}</h2><p>${sourceName?esc(sourceName):'选择 Word 或 PDF，结合本项目材料逐题回答。'}</p></div>
   <label class="bb-upload-picker bb-upload-picker--compact btn ${empty?'primary':'secondary'}">${empty?'选择问题清单':'更换问题清单'}<input id="qa-upload" type="file" accept=".docx,.doc,.pdf" aria-label="上传问题清单" ${locked||this.hasUploads()?'disabled':''}></label>
   ${empty?`<small>支持 DOCX、DOC、PDF · 单份不超过 100 MB<br>${isCnyPrice(this.state!.price)?'上传后自动处理，开始回答前展示费用':'上传后自动处理，开始回答后生成文档 · 每题 '+this.priceText(this.unitPoints)}</small>`:''}
   ${this.uploadRows('source')}
   ${empty?'<p class="qa-format-note">支持可检索的 PDF；扫描页请补充可提取文字的文件。</p>':''}
  </section>`;
  const resultFirst=run?.operation==='answer'&&!editing;
  const supporting=this.projectMaterials(run)+upload;
  const documentPanel=empty?`<div class="qa-deliverables"><div><span aria-hidden="true">${prototypeIcon('file')}</span><div><h3>回答完成后下载 Word</h3><p>先在页面审阅回答，再下载包含回答和补件要求的文件。</p></div></div><div><span aria-hidden="true">${prototypeIcon('check')}</span><div><h3>待补材料清单</h3><p>逐题列出缺少的材料，补齐后可继续生成新版本。</p></div></div></div>${this.state.draft.preparation_id||this.uploadEnvelopes.some(e=>e.kind==='supplement')?content:''}`:`<section class="panel qa-document"><h2>${editing?'生成回复':run?.operation==='prepare'?'处理问题清单':'回答文档'}</h2>${resultFirst?`<p class="qa-result-context ${run!.manifest.prospectus?'':'qa-warning'}">${run!.manifest.prospectus?'本轮依据：'+esc(run!.manifest.prospectus.filename)+' · V'+run!.manifest.prospectus.sequence:'此历史任务未单独记录募集说明书版本，请核对逐题引用。'}</p>`:''}<div id="qa-document-body">${content}</div></section>`;
  this.shell(`<div class="qa-page" data-view="${resultFirst?'result':'preparation'}">${this.header()}<p id="project-qa-status" role="status">${esc(this.statusText())}</p>${this.preparingUpload?uploadProgressHtml(uploadActivity(),this.preparingUpload.name):''}${this.recovery()}${this.activeTasks()}
   <div class="qa-toolbar" ${!history.length?'hidden':''}><label for="qa-history">历史记录</label><select id="qa-history" aria-label="问答历史版本" ${locked?'disabled':''}><option value="">准备下一轮</option>${history.map(r=>`<option value="${esc(r.run_id)}" ${r.run_id===run?.run_id?'selected':''}>${r.answer_sequence?`第 ${r.answer_sequence} 次 · `:''}回答问题 · ${esc(runStateLabel[r.state as keyof typeof runStateLabel]??'状态待核对')} · ${esc(date(r.created_at))}</option>`).join('')}</select></div>
   ${this.workflow(run,prepared)}<div class="qa-layout">${resultFirst?documentPanel+supporting:supporting+documentPanel}</div></div>`,'qa');
  document.querySelector('#qa-manage-prospectus')?.addEventListener('click',()=>void this.manageProspectus());
  document.querySelector('#qa-select-prospectus')?.addEventListener('click',()=>this.selectProspectus());
  document.querySelector('#qa-refresh-materials')?.addEventListener('click',()=>void this.act(async()=>{const fresh=await this.read();if(!this.live())return;this.state!.prospectus=fresh.prospectus;this.state!.materials=fresh.materials;this.paint();},'read'));
  document.querySelector<HTMLInputElement>('#qa-upload')!.addEventListener('change',e=>{
   const file=(e.target as HTMLInputElement).files?.[0];
   if(file)void this.act(()=>this.startUploads([file],'source'),'save');
  });
  document.querySelector('#qa-history')!.addEventListener('change',e=>{if(!this.locked())location.hash=this.href((e.target as HTMLSelectElement).value?{run:(e.target as HTMLSelectElement).value}:{});});
  document.querySelector('#qa-retry-pending')?.addEventListener('click',()=>void this.act(()=>this.sendPending(),this.pending?.kind==='draft'?'save':'submit'));
  document.querySelector('#qa-refresh-pending')?.addEventListener('click',()=>void this.act(()=>this.refreshPendingDraft(),'read'));
  document.querySelector('#qa-keep-local')?.addEventListener('click',()=>this.resolveConflict(false));
  document.querySelector('#qa-use-server')?.addEventListener('click',()=>this.resolveConflict(true));
  document.querySelector('#qa-recheck-cache')?.addEventListener('click',()=>this.recheckCache());
  document.querySelector('#qa-use-stored')?.addEventListener('click',()=>this.useStored());
  document.querySelector('#qa-retry-original-conflict')?.addEventListener('click',()=>void this.act(()=>this.retryOriginalConflict(),this.pending?.kind==='draft'?'read':'submit'));
  document.querySelectorAll<HTMLElement>('[data-qa-journal]').forEach(button=>button.addEventListener('click',()=>this.chooseJournal(Number(button.dataset.qaJournal))));
  if(editing)this.bindDraft(prepared);else if(run)this.bindResult(run);
  this.bindUploads();this.syncActions();this.references.bind();
  if(this.state.runs.some(r=>!terminal.has(r.state)))this.poll();
 }
 private resolveConflict(useServer:boolean){
  if(this.pending||!this.server)return;
  if(useServer){this.state!.draft=structuredClone(this.server.draft);this.needsKnowledgeChoice=false;this.sourceRun=undefined;this.dirty=false;}
  else this.dirty=true;
  this.state!.revision=this.server.revision;
  if(this.persist()){this.conflict=false;this.message=useServer?'已采用服务器准备；尚未开始回答。':'本机准备已放在最新修订上，请核对后保存；尚未覆盖服务器。';}
  this.paint();
 }
 private draft(prepared:QaRun){
  const d=this.state!.draft,points=BigInt(d.questions.length)*int64(this.unitPoints),pendingQuote=isCnyPrice(this.state!.price);
  const available=this.state!.materials.filter(m=>key(m.asset)!==key(prepared.manifest.source.asset));
  const missing=d.materials.filter(a=>!available.some(m=>key(a)===key(m.asset)));
  return `<p class="qa-round-summary">本轮 <strong>${d.questions.length} 个问题</strong> ${pendingQuote?' · 本次费用依问题与材料范围报价':`· 每题 ${this.priceText(this.unitPoints)} · 本轮 <strong>${this.priceText(points)}</strong>`}</p>${this.sourceRun&&this.state!.runs.find(r=>r.run_id===this.sourceRun)?.operation==='answer'?'<p class="qa-warning">已从指定历史任务准备下一轮，尚未提交。可补充材料和回答要求。</p>':''}<p id="qa-word-scope" class="muted">${wordScope}</p>${this.prospectusIssue()?`<p class="qa-warning" id="qa-required-material">${esc(this.prospectusIssue()!)}</p>`:''}<fieldset id="qa-preparation-controls" ${this.locked()||this.busy?'disabled':''}><legend class="sr-only">本轮准备内容</legend>${prepared.result!.warnings.map(w=>`<p class="qa-warning">${esc(preparationWarning(w))}</p>`).join('')}<details class="qa-question-preview" data-qa-questions-preview ${this.questionsOpen||!d.questions.length?'open':''}><summary>查看问题内容 · ${d.questions.length} 题</summary><div class="qa-question-list">${d.questions.map((q,i)=>`<article data-qa-question-id="${q.id}"><div><strong>问题 ${i+1}</strong></div><p>${esc(q.question)}</p></article>`).join('')||'<div class="qa-prepared-heading"><h3>暂未能整理出可回答的问题</h3><p>请检查问题清单正文，或更换可读取的 Word / PDF 后重试。</p></div>'}</div></details>${this.references.render(JSON.stringify([this.id,d.preparation_id]),available,d.materials,'<label class="bb-upload-picker bb-upload-picker--compact btn secondary">补充项目材料<input id="qa-supplement" type="file" accept=".docx,.doc,.pdf,.xlsx" multiple aria-label="补充项目材料" '+(this.hasUploads()?'disabled':'')+'></label>'+this.uploadRows('supplement'))}<label class="qa-field">本轮回答要求<textarea id="qa-requirements" ${d.included_followup_of?'readonly':''} rows="3" maxlength="16000" placeholder="例如：逐项解释报告期变化，保留待补材料提示">${esc(d.requirements)}</textarea></label>${d.included_followup_of?'<section class="qa-warning"><p>本轮沿用原题与原要求，按原单核实补料／修正，不新增收费。</p><button class="text-button" id="qa-new-scope">改为新事实／独立范围，重新报价</button></section>':''}<section class="qa-start-summary" aria-label="本轮费用"><h3>${pendingQuote?'本轮任务范围':'本轮费用 · '+this.priceText(points)}</h3>${this.state!.prospectus?`<p>本轮使用：${esc(this.state!.prospectus.filename)} · V${this.state!.prospectus.sequence}，以及 ${Math.max(0,d.materials.length-1)} 份补充材料。</p>`:''}<p>${pendingQuote?'按本轮实际范围计费；原范围内补料与平台纠错包含。':'开始时冻结积分，回答文档交付后扣费；包含待补材料建议。失败或取消释放冻结积分，补充材料后重新回答按新一轮所选问题数计费。'}</p></section><footer class="qa-actions"><button class="btn secondary" id="qa-save">保存准备内容</button><button class="btn primary" id="qa-start" ${!d.questions.length||missing.length||this.prospectusIssue()?'disabled':''}>${pendingQuote?'开始回答':'开始回答 · '+this.priceText(points)}</button></footer></fieldset>`;
 }
 private bindDraft(prepared:QaRun){
  const d=this.state!.draft;
  const materialPool=[...this.state!.materials.map(m=>m.asset),...d.materials];
  document.querySelectorAll<HTMLInputElement>('[data-qa-material]').forEach(c=>c.addEventListener('change',()=>{
   if(!c.isConnected)return;
   const selected=d.materials.some(a=>key(a)===c.dataset.materialKey);
   if(this.locked()){c.checked=selected;return;}
   if(c.checked){
    if(selected)return;
    const asset=materialPool.find(a=>key(a)===c.dataset.materialKey);
    if(!asset||c.dataset.qaMaterial==='missing'||key(asset)===key(prepared.manifest.source.asset)){c.checked=false;this.status('当前参考版本暂不可核实，原选择仍保留。');return;}
    if(d.materials.length>=50){c.checked=false;this.status('每轮最多参考 50 份材料，请先取消一份再添加。原选择已保留。');return;}
    d.materials=[...d.materials,structuredClone(asset)];
   }else d.materials=d.materials.filter(a=>key(a)!==c.dataset.materialKey);
   this.changed();this.paint();
  }));
  document.querySelector('#qa-requirements')!.addEventListener('input',e=>{if(!this.locked()){d.requirements=(e.target as HTMLTextAreaElement).value;this.changed();}});
  document.querySelector('#qa-new-scope')?.addEventListener('click',()=>{if(this.locked())return;delete d.included_followup_of;this.changed();void this.act(async()=>{await this.save();this.paint();},'save');});
  document.querySelector('#qa-save')!.addEventListener('click',()=>void this.act(async()=>{await this.save();this.status('本轮问题、材料与要求已保存。');},'save'));
  document.querySelector('#qa-start')!.addEventListener('click',()=>void this.act(()=>this.startAnswer(),'submit'));
  document.querySelector('#qa-supplement')!.addEventListener('change',e=>{
   const files=[...((e.target as HTMLInputElement).files??[])];
   if(!files.length)return;
   void this.act(async()=>{
    await this.startUploads(files,'supplement');
   },'save');
  });
 }
 private async save(){
  if(this.hasUploads())throw new UserFacingError('请先确认原上传或停止本机后续保存，再保存准备内容。');
  if(this.pending)throw new UserFacingError('请先核对原保存或提交请求。');
  if(this.conflict||this.cacheProblem)throw new UserFacingError('请先核对恢复记录。');
  if(this.state!.draft.preparation_id){
   const check=qaPreparationFor(this.state!.draft,this.state!.runs,this.id!);
   if(check.error)throw new UserFacingError(check.error);
  }
  if(!this.dirty){if(!this.persist())throw new UserFacingError(this.cacheProblem);return;}
  this.pending={kind:'draft',request:{expected_revision:this.state!.revision,draft:structuredClone(this.state!.draft)}};
  if(!this.persist()){this.paint();throw new UserFacingError(this.cacheProblem);}
  await this.sendPending();
 }

 private completeDraft(saved:QaWorkspace){
  const previous=this.snapshot(),next:QaRecoveryValue={revision:saved.revision,draft:structuredClone(saved.draft)};
  const finish=this.finishRecovery(previous,next);if(!finish.ok)return false;
  this.server=structuredClone(saved);this.state=structuredClone(saved);this.pending=undefined;this.sourceRun=undefined;this.dirty=false;this.needsKnowledgeChoice=false;
  if(finish.foreign){this.restore(saved);this.scanJournal();}
  return true;
 }
 private async refreshPendingDraft(){
  if(this.pending?.kind!=='draft')return;
  const pending=this.pending,fresh=await this.read();if(!this.live())return;this.server=structuredClone(fresh);
  this.state!.runs=fresh.runs;this.state!.materials=fresh.materials;this.state!.prospectus=fresh.prospectus;
  if(fresh.revision===pending.request.expected_revision+1&&qaSameDraft(fresh.draft,pending.request.draft)){
   if(this.completeDraft(fresh))this.message='已核对服务器：原准备内容已完整保存。';
  }else this.message='尚无法确认原保存。服务器修订或完整内容不一致，原请求与双方内容继续保留；不会覆盖服务器或再次保存。';
  this.paint();
 }
 private async sendPending(){
  const pending=this.pending;if(!pending||!this.verifyCache())return;
  try{
   if(pending.kind==='draft'){
    const saved=await this.request<QaWorkspace>('POST','/draft',pending.request);
    if(!Value.Check(QaWorkspaceSchema,saved)||saved.revision!==pending.request.expected_revision+1||!qaSameDraft(saved.draft,pending.request.draft))throw new ApiError(0,'DATA_UNAVAILABLE');
    if(!this.live())return;
    if(!this.completeDraft(saved))throw new UserFacingError(this.cacheProblem);
    this.message='本轮问题、材料与要求已保存。';this.paint();return;
   }
   const ack=await this.request<Dto<'QaRunResponse'>>('POST',pending.kind==='prepare'?'/prepare':'/runs',pending.request,pending.kind==='answer'?billingRecoveryHeaders('QaAnswerRequest',pending.request):{});
   if(!Value.Check(qaSchemas.QaRunResponse,ack))throw new ApiError(0,'DATA_UNAVAILABLE');
   if(!this.live())return;
   const previous=this.snapshot(),{pending:removed,...next}=previous;
   if(pending.kind==='prepare')next.sourceRun=ack.run_id;
   const finish=this.finishRecovery(previous,next);
   if(!finish.ok){this.paint();return;}
   this.pending=undefined;this.sourceRun=next.sourceRun;this.dirty=false;this.dialog?.close();
   location.hash=this.href({run:ack.run_id});
  }catch(error){
   if(!this.live())throw error;
   if(error instanceof ApiError&&error.status>=400&&error.status<500&&noAcceptance.has(error.code)){
    if(pending.kind==='prepare'&&error.code==='PROJECT_RUN_ACTIVE'){
     // The upload already handed its exact source to this durable request. Keep
     // that handoff retryable when another project task temporarily owns the slot.
     this.message=this.error(error,'submit')+' 原问题清单已保留，可先查看项目任务，结束后返回恢复原问题整理请求。';
     this.dialog?.close();this.paint();throw error;
    }
    const previous=this.snapshot(),{pending:removed,...next}=previous;
    const finish=this.finishRecovery(previous,next);
    if(!finish.ok){this.paint();throw error;}
    this.pending=undefined;
    if(finish.foreign){const fresh=await this.read();if(!this.live())return;this.restore(fresh);this.scanJournal();}
    if(error.code==='INPUT_REVISION_CONFLICT'||error.code==='INPUT_REQUIRED'){
     const fresh=await this.read();this.server=structuredClone(fresh);this.state!.runs=fresh.runs;this.state!.materials=fresh.materials;this.state!.prospectus=fresh.prospectus;this.conflict=fresh.revision!==this.state!.revision||!qaSameDraft(fresh.draft,this.state!.draft);
    }
    this.message=this.error(error,pending.kind==='draft'?'save':'submit');this.dialog?.close();this.paint();throw error;
   }
   // Unknown responses and idempotency conflicts retain the complete original request.
   this.pending=pending;this.message=this.error(error,pending.kind==='draft'?'save':'submit');this.dialog?.close();this.paint();throw error;
  }
 }
 private async answerRequestId(){
  // One immutable draft revision has one intent across pages. A deliberate next
  // round first saves a new revision, rather than rotating an uncertain key.
  const bytes=new TextEncoder().encode([this.owner,this.id,this.state!.revision].join('\0'));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return 'qa-answer-'+[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
 }
 private async startAnswer(){
  if(!isCnyPrice(this.state!.price)){
  if(this.locked()||this.hasUploads()||!this.state!.draft.questions.length)return;
  const issue=this.prospectusIssue();if(issue){this.status(issue);return;}
  const points=this.state!.draft.questions.length*PROJECT_QA_PRICE.points;
   await this.save();
   if(!this.live()||this.locked())return;
   const request_id=await this.answerRequestId();if(!this.live()||this.locked())return;
   this.pending={kind:'answer',request:{request_id,expected_revision:this.state!.revision,expected_points:serializeInt64(points),price_version:PROJECT_QA_PRICE.version}};
   if(!this.persist()){this.paint();return;}
   await this.sendPending();
   return;
  }
  if(this.locked()||this.hasUploads()||!this.state!.draft.questions.length)return;
  const issue=this.prospectusIssue();if(issue){this.status(issue);return;}
   const commercial=isCnyPrice(this.state!.price);
   if(commercial){await this.save();if(!this.live()||this.locked())return;}
   const count=this.state!.draft.questions.length,revision=this.state!.revision,draft=structuredClone(this.state!.draft);
   const quote=commercial?await this.request<Dto<'QaQuoteResponse'>>('POST','/quote',{expected_revision:revision,...(draft.included_followup_of?{included_followup_of:draft.included_followup_of}:{})}):undefined;
   if(!this.live()||this.state!.revision!==revision||!qaSameDraft(this.state!.draft,draft))throw new ApiError(409,'QUOTE_CHANGED');
   if(quote&&!scopeReady(quote)){const pending=this.modal(scopeStatusLabel(quote),scopeLifecycleHtml(quote)+'<button class="btn primary" id="qa-refresh-scope">刷新范围报价</button>');pending.querySelector('#qa-refresh-scope')!.addEventListener('click',()=>{pending.close();void this.act(()=>this.startAnswer(),'submit');});return;}
   const points=quote?.points??serializeInt64(BigInt(count)*int64(this.unitPoints)),priceVersion=quote?.price_version??this.state!.price.version,total=quote?displayPrice(quote,points):this.priceText(points);
   const submit=async()=>{
    if(quote&&!scopeReady(quote))throw new ApiError(409,'QUOTE_EXPIRED');
    if(this.state!.revision!==revision||!qaSameDraft(this.state!.draft,draft))throw new ApiError(409,'QUOTE_CHANGED');
    if(!commercial){await this.save();if(!this.live()||this.locked())return;}
    const request_id=await this.answerRequestId();if(!this.live()||this.locked())return;
    this.pending={kind:'answer',request:{request_id,expected_revision:this.state!.revision,expected_points:points,price_version:priceVersion,...(quote?.scope_quote_id?{scope_quote_id:quote.scope_quote_id}:{}),...(draft.included_followup_of?{included_followup_of:draft.included_followup_of}:{})}};
    if(!this.persist()){this.paint();return;}await this.sendPending();
   };
   if(isAutomaticCharge(quote)){await submit();return;}
   const d=this.modal('确认回填问题清单',`<p>本轮 <strong>${count} 个问题 · 总价 ${total}</strong>。</p>${scopeLinesHtml(quote)}<p>${wordScope}</p><p>${commercial?draft.included_followup_of?'本次为原单范围内补料或修正，服务端已核对原题和原要求，不新增收费。':'问题整理、资料引用、回复Word与待补清单包含；原要求内补证和平台纠错不重复收费。只有新事实或新范围才另行确认。开始时预留总价，按约定交付结算；未交付部分释放。':'开始时冻结积分；回答和待补材料清单写入Word并交付后扣费。失败或取消释放冻结积分。'}</p><button class="btn primary" id="qa-confirm">确认并开始 · ${total}</button>`);
   d.querySelector('#qa-confirm')!.addEventListener('click',()=>void this.act(submit,'submit'));
   if(quote){d.querySelector('#qa-confirm')!.before(document.createRange().createContextualFragment(scopeLifecycleHtml(quote)));guardScopeExpiry(d,[quote],'#qa-confirm');}
 }
 private result(r:QaRun){
  if(r.operation==='prepare'&&r.state==='succeeded')return this.preparationResult(r);
  const active=!terminal.has(r.state),follow=r.operation==='answer'?qaFollowupFor(r,this.state!.runs,this.id!):undefined;
  if(follow&&!this.followup.has(r.run_id))this.followup.set(r.run_id,new Set(follow.missingIds.length?follow.missingIds:r.manifest.questions.map(q=>q.id)));
  const selected=this.followup.get(r.run_id)??new Set<string>();
  const answers=r.result?.answers??[];
  const overview=!active&&follow?follow.error?`<section class="qa-result-overview" aria-label="本轮结果与下一步" data-qa-result-run="${esc(r.run_id)}"><h3>本轮结果与下一步</h3><p class="qa-warning">待补范围无法核实。${esc(follow.error)}</p><button class="btn secondary" id="qa-prepare-next" disabled>准备下一轮</button></section>`:`<section class="qa-result-overview" aria-label="本轮结果与下一步" data-qa-result-run="${esc(r.run_id)}"><h3>本轮结果与下一步</h3><p>原题 ${r.manifest.questions.length} 个 · 已有处理结果 ${answers.length} 个 · 待补材料 / 未回答 ${follow.missingIds.length} 个</p><div class="qa-result-navigation">${follow.missingIds.length?'<button class="btn secondary" id="qa-view-missing" '+(this.locked()||this.busy?'disabled':'')+'>查看待补问题</button>':''}<button class="btn secondary" id="qa-prepare-next" ${this.locked()||this.busy?'disabled':''}>${isCnyPrice(r.manifest)?'补充材料／原范围修正':'准备下一轮'}</button></div><p class="muted">${isCnyPrice(r.manifest)?'原已付范围补料或纠错不新增收费；新事实、独立新增范围另行报价。':'先查看原题与待补材料；准备下一轮时仍需采用选题、核对参考方式和费用。'}</p></section>`:'';
  return `${r.operation==='answer'&&r.artifact_id&&r.result?.answers.length?`<section class="qa-download-card" aria-label="下载回答文档"><div><h3>回答文档已生成</h3><p>${esc(r.manifest.source.filename)} · 含本轮回答及待补材料</p><a href="${esc(this.filesHref())}">查看项目文件</a></div><button class="btn primary" id="qa-download">下载回答文档（Word）</button></section>`:''}<div class="qa-run-head"><h3>${r.operation==='prepare'?'处理问题清单':'回填回复文件'} · ${esc(runStateLabel[r.state as keyof typeof runStateLabel]??r.state)}</h3><p>${esc(date(r.created_at))}${r.operation==='prepare'?' · 问题整理，包含在回复任务内':` · ${r.manifest.questions.length} 题 · ${displayPrice(r.manifest,r.manifest.points)}`}</p><p>${int64(r.reserved_points)>0n?'已预留 '+(displayCharge(r.manifest,r.reserved_points))+'，交付后结算':int64(r.charged_points)>0n?'已结算 '+(displayCharge(r.manifest,r.charged_points)):'本次尚未扣费'}</p>${active?`<progress></progress><p>关闭页面后任务继续，原件与历史成果保留。</p><button class="btn secondary" data-run-action="${['paused','awaiting_input'].includes(r.state)?'resume':'pause'}" ${this.pending?'disabled':''}>${['paused','awaiting_input'].includes(r.state)?'继续任务':'暂停任务'}</button><button class="text-button" data-run-action="cancel" ${this.pending?'disabled':''}>停止本轮</button>`:''}</div><p id="qa-word-scope" class="muted">${wordScope}</p>${r.result?.warnings.map(w=>`<p class="qa-warning">${esc(preparationWarning(w))}</p>`).join('')??''}${r.operation==='prepare'&&r.state==='succeeded'?`<p>已识别 ${r.result?.questions.length??0} 个候选问题。查看此版本不会改写当前准备。</p><button class="btn primary" id="qa-use-preparation" ${this.locked()||!r.result?'disabled':''}>采用识别问题，准备回答</button>`:''}${r.error_code==='MATERIAL_UNREADABLE'?`<section class="qa-missing-list" aria-label="需要补充可读募集说明书"><h3>请补充可读取的募集说明书</h3><p>未能从“${esc(r.manifest.prospectus?.filename??'募集说明书')}”提取可引用正文。请上传可检索 PDF 或 Word；扫描文件请先完成文字识别，再在项目资料中采用新版本并重新回答。</p><p>本轮未生成回答文件，冻结积分将释放。</p><a class="btn secondary" href="${esc(this.href())}">返回准备，补充募集说明书</a></section>`:''}${this.missingMaterials(r)}${overview}${answers.length?`<p class="muted">回答草稿仍需人工审阅。</p>${answers.map(a=>`<details class="qa-answer" data-qa-answer-question="${esc(a.question_id)}" data-qa-answer-run="${esc(r.run_id)}" ${(this.answerDisclosures.get(r.run_id)?.get(a.question_id)??false)?'open':''}><summary><b>原文段落 ${(r.manifest.questions.find(q=>q.id===a.question_id)?.start??0)+1}</b><span>${esc(r.manifest.questions.find(q=>q.id===a.question_id)?.question??'无法核实题目对应关系')}</span><small>${a.status==='missing'?'待补材料':'回答草稿'}</small></summary><div class="qa-answer-body">${reportBlocks(a.answer).map(reportBlockHtml).join('')}</div>${a.missing_materials.length?`<div class="qa-warning"><strong>需要补充</strong><ul>${a.missing_materials.map(m=>`<li>${esc(m)}</li>`).join('')}</ul></div>`:''}${a.approach?`<p>回答思路：${esc(a.approach)}</p>`:''}</details>`).join('')}`:''}${['failed','cancelled','rejected'].includes(r.state)?'<p role="alert">本轮未完成交付，未交付部分的预留将释放。原件和历次成果保留。</p>':''}${!active&&follow?`<details class="qa-followup" data-qa-followup-run="${esc(r.run_id)}" ${this.followupOpen.has(r.run_id)?'open':''}><summary>补充材料后重新回答</summary><h3 id="qa-followup-heading" tabindex="-1">补充材料，准备下一轮</h3><p>优先选择待补材料或未回答的问题。可调整选题；采用后仍需核对材料、参考方式和费用。</p>${follow.error?`<p role="alert">${esc(follow.error)}</p>`:''}<fieldset ${this.locked()||follow.error?'disabled':''}><legend>本轮要重新回答的问题</legend><div class="qa-followup-tools"><button class="text-button" id="qa-followup-missing">只选待补材料 / 未回答</button><button class="text-button" id="qa-followup-all">选择全部问题</button></div>${r.manifest.questions.map(q=>`<label><input type="checkbox" data-qa-followup value="${esc(q.id)}" ${selected.has(q.id)?'checked':''}><span><b>原文段落 ${q.start+1}${q.end>q.start?'–'+(q.end+1):''}</b> · ${follow.missingIds.includes(q.id)?'待补材料 / 未回答':'已有回答草稿'}<br>${esc(q.question)}</span></label>`).join('')}<p id="qa-followup-price">已选 ${selected.size} 题 · ${isCnyPrice(r.manifest)&&(int64(r.charged_points)>0n||r.manifest.included_followup_of)?'原单范围补料／修正 '+displayCharge(r.manifest,0)+'（服务端核对）':isCnyPrice(this.state!.price)?'下一轮依实际范围报价':'下一轮 '+this.priceText(BigInt(selected.size)*int64(this.unitPoints))}</p><button class="btn secondary" id="qa-continue" ${!selected.size?'disabled':''}>采用选中问题，准备下一轮</button></fieldset></details>`:''}`;
 }
 private missingMaterials(r:QaRun){
  if(r.operation!=='answer'||!terminal.has(r.state))return '';
  const follow=qaFollowupFor(r,this.state!.runs,this.id!);
  if(follow.error)return '<section class="qa-missing-list"><h3>待补材料清单</h3><p>题目与回答的对应关系暂无法核实，请重新读取此版本。</p></section>';
  const answers=r.result?.answers??[];
  const missing=r.manifest.questions.filter(q=>follow.missingIds.includes(q.id));
  if(!terminal.has(r.state))return '';
  return `<section class="qa-missing-list" aria-label="待补材料清单"><header><h3>待补材料清单</h3><span>${missing.length?missing.length+' 个问题待补充':'暂无待补材料'}</span></header>${missing.length?`<p>补齐以下材料后，可选择对应问题生成新版本。</p><ol>${missing.map(q=>{const a=answers.find(a=>a.question_id===q.id);return `<li><h4>问题 ${r.manifest.questions.indexOf(q)+1} · ${esc(q.question)}</h4><ul>${a?.missing_materials.length?a.missing_materials.map(m=>`<li>${esc(m)}</li>`).join(''):'<li>本题尚未形成具体材料建议，请核对问题及现有材料后重新回答。</li>'}</ul></li>`;}).join('')}</ol>`:'<p>本轮未列出材料缺口，请下载文档核对回答及依据。</p>'}</section>`;
 }
 private bindResult(r:QaRun){
  document.querySelector('#qa-download')?.addEventListener('click',()=>void this.act(async()=>{const a=await this.api.artifact(r.artifact_id!,this.controller.signal);if(a.artifact_id!==r.artifact_id||a.run_id!==r.run_id)throw new UserFacingError('当前回填 Word 与所选问答任务的对应关系无法核实，请重新读取后再下载。');const bytes=await this.api.artifactBytes(a,this.controller.signal);if(this.live())this.downloads.save(bytes,artifactFilename(a));},'download'));
  document.querySelectorAll<HTMLElement>('[data-run-action]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{if(this.pending)return;await this.api.runAction(r.run_id,b.dataset.runAction as 'pause'|'resume'|'cancel',this.controller.signal);await this.refresh(true);})));
  document.querySelector('#qa-use-preparation')?.addEventListener('click',()=>{
   this.usePreparation(r);this.paint();
  });
  const follow=r.operation==='answer'?qaFollowupFor(r,this.state!.runs,this.id!):undefined;
  const followupDetails=document.querySelector<HTMLDetailsElement>('[data-qa-followup-run]');
  const openFollowup=()=>{if(followupDetails){this.followupOpen.add(r.run_id);followupDetails.open=true;}};
  followupDetails?.addEventListener('toggle',()=>{if(followupDetails.isConnected){if(followupDetails.open)this.followupOpen.add(r.run_id);else this.followupOpen.delete(r.run_id);}});
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-answer-question]').forEach(row=>row.addEventListener('toggle',()=>{
   if(!this.live()||!row.isConnected||row.dataset.qaAnswerRun!==r.run_id)return;
   let saved=this.answerDisclosures.get(r.run_id);if(!saved){saved=new Map();this.answerDisclosures.set(r.run_id,saved);}saved.set(row.dataset.qaAnswerQuestion!,row.open);
  }));
  document.querySelector('#qa-prepare-next')?.addEventListener('click',()=>{
   if(!this.live()||this.busy||this.locked()||!follow||follow.error)return;
   openFollowup();
   const heading=document.querySelector<HTMLElement>('#qa-followup-heading');heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start'});
  });
  document.querySelector('#qa-view-missing')?.addEventListener('click',()=>{
   if(!this.live()||this.busy||this.locked()||!follow||follow.error||!follow.missingIds.length)return;
   const candidates=r.manifest.questions.filter(q=>follow.missingIds.includes(q.id)),rows=[...document.querySelectorAll<HTMLDetailsElement>('[data-qa-answer-question]')].filter(row=>row.dataset.qaAnswerRun===r.run_id);
   let saved=this.answerDisclosures.get(r.run_id);if(!saved){saved=new Map();this.answerDisclosures.set(r.run_id,saved);}
   rows.filter(row=>follow.missingIds.includes(row.dataset.qaAnswerQuestion!)).forEach(row=>{saved!.set(row.dataset.qaAnswerQuestion!,true);row.open=true;});
   const first=candidates[0];if(!first)return;
   const target=rows.find(row=>row.dataset.qaAnswerQuestion===first.id)?.querySelector<HTMLElement>('summary')??[...document.querySelectorAll<HTMLInputElement>('[data-qa-followup]')].find(input=>input.value===first.id);
   if(target?.matches('[data-qa-followup]'))openFollowup();
   target?.focus({preventScroll:true});target?.scrollIntoView({block:'start'});
  });
  const updatePrice=()=>{
   const selected=this.followup.get(r.run_id)??new Set<string>();
   const label=document.querySelector('#qa-followup-price');if(label)label.textContent=`已选 ${selected.size} 题 · ${isCnyPrice(r.manifest)&&(int64(r.charged_points)>0n||r.manifest.included_followup_of)?'原单范围补料／修正 '+displayCharge(r.manifest,0)+'（服务端核对）':isCnyPrice(this.state!.price)?'下一轮依实际范围报价':'下一轮 '+this.priceText(BigInt(selected.size)*int64(this.unitPoints))}`;
   const button=document.querySelector<HTMLButtonElement>('#qa-continue');if(button)button.disabled=this.locked()||!!follow?.error||!selected.size;
  };
  document.querySelectorAll<HTMLInputElement>('[data-qa-followup]').forEach(input=>input.addEventListener('change',()=>{
   if(this.locked())return;
   const selected=this.followup.get(r.run_id)!;if(input.checked)selected.add(input.value);else selected.delete(input.value);updatePrice();
  }));
  const choose=(ids:string[])=>{if(this.locked())return;this.followup.set(r.run_id,new Set(ids));document.querySelectorAll<HTMLInputElement>('[data-qa-followup]').forEach(input=>input.checked=ids.includes(input.value));updatePrice();};
  document.querySelector('#qa-followup-missing')?.addEventListener('click',()=>choose(follow?.missingIds??[]));
  document.querySelector('#qa-followup-all')?.addEventListener('click',()=>choose(r.manifest.questions.map(q=>q.id)));
  document.querySelector('#qa-continue')?.addEventListener('click',()=>{
   if(this.busy||this.locked()||!follow||follow.error)return;
   const selected=this.followup.get(r.run_id)!,questions=r.manifest.questions.filter(q=>selected.has(q.id));
   if(!questions.length)return;
   this.state!.draft={...(isCnyPrice(r.manifest)&&r.state==='succeeded'&&(int64(r.charged_points)>0n||r.manifest.included_followup_of)?{included_followup_of:r.manifest.included_followup_of??r.run_id}:{}),preparation_id:r.manifest.preparation_id,questions:structuredClone(questions),materials:r.manifest.materials.map(m=>structuredClone(m.asset)),requirements:r.manifest.requirements,use_knowledge:false};
   this.needsKnowledgeChoice=false;this.sourceRun=r.run_id;this.changed();
   if(!this.cacheProblem)location.hash=this.href();else this.paint();
  });
 }
 private async refresh(owned=false){
  try{
   const fresh=await this.read();if(!this.live())return;
   if(!owned&&(this.busy||this.dialog?.open)){this.poll();return;}
   // A valid read resolves only the polling error, not unconfirmed saves or submissions.
   this.readProblem='';
   this.server=structuredClone(fresh);
   if(!this.dirty&&!this.pending&&!this.conflict&&!this.cacheProblem)this.restore(fresh);
   else{this.state!.runs=fresh.runs;this.state!.materials=fresh.materials;this.state!.prospectus=fresh.prospectus;}
   this.prepareCurrentRun();this.paint();
  }catch(e){if(this.live()){this.readProblem=this.error(e,'read');this.syncStatus();this.poll();}}
 }
 private poll(){this.timer=setTimeout(()=>{if(this.live()&&!this.busy&&!this.dialog?.open)void this.refresh();else if(this.live())this.poll();},3000);}
 private modal(title:string,body:string){
  this.dialog?.remove();const d=document.createElement('dialog');d.className='pf-modal qa-modal';
  d.innerHTML=`<header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="关闭">×</button></header>${body}<p role="status"></p>`;
  document.body.append(d);d.showModal();
  d.querySelector('[data-close]')!.addEventListener('click',()=>{if(!this.busy)d.close();});
  d.addEventListener('cancel',e=>{if(this.busy)e.preventDefault();});
  d.addEventListener('close',()=>d.remove());this.dialog=d;return d;
 }
 private newProject(){const d=this.modal('新建项目',`<form><label>项目名称<input name="name" required maxlength="200"></label><label>发行人全称<input name="issuer_name" required maxlength="200"></label><label>市场<select name="market">${Object.entries(MARKET_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>品种<select name="offering"></select></label><button class="btn primary">创建项目并开始问答</button></form>`),market=d.querySelector<HTMLSelectElement>('[name=market]')!,offering=d.querySelector<HTMLSelectElement>('[name=offering]')!,id=crypto.randomUUID();const sync=()=>{offering.innerHTML=MARKET_OFFERINGS[market.value as keyof typeof MARKET_OFFERINGS].map(v=>`<option value="${v}">${OFFERING_LABELS[v]}</option>`).join('');};sync();market.addEventListener('change',sync);d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement);void this.act(async()=>{const p=await this.api.request<Dto<'ProjectResponse'>>('POST','/projects',{creation_request_id:id,kind:'generation',name:f.get('name'),issuer_name:f.get('issuer_name'),market:f.get('market'),offering:f.get('offering')},{},this.controller.signal);if(this.live()){d.close();location.hash='qa?project='+p.project_id;}},'submit');});}
 private hasUploads(){return !!this.uploadProblem||!!this.uploadEnvelopes.length||!!this.uploadSelections.length;}
 private scanUploads(){
  if(!this.uploadJournal)return;
  const saved=this.uploadJournal.readAll();if(saved.status!=='valid'){this.uploadProblem='原问答上传记录无法可靠读取。请保留文件，恢复浏览器本机存储后重新打开。';return;}
  this.uploadEnvelopes=saved.value;this.uploadProblem='';
  try{
   for(const kind of ['source','supplement'] as const){
    const records=this.uploadCore.get(kind)?.list();if(!records){this.uploadProblem='尚未核实当前账号，不能开始或恢复问答上传。';return;}
    for(const record of records){const e=saved.value.find(e=>e.kind===kind&&e.items.some(i=>i.id===record.id));
     if(!e||!qaUploadRecordMatches(e,e.items.findIndex(i=>i.id===record.id),record)){this.uploadProblem='上传原文件与问答准备的关联无法核实。材料尚未加入任何新一轮，请保留记录并联系支持。';return;}
    }
   }
  }catch(error){this.uploadProblem=this.error(error,'read');}
 }
 private originalEnvelope(id:string){
  const saved=this.uploadJournal?.readAll();if(saved?.status!=='valid')throw new UserFacingError('无法可靠读取原问答上传准备，未继续保存。');
  const e=saved.value.find(e=>e.id===id);if(!e)throw new UserFacingError('原问答上传准备已在其他页面移除，未重新上传或加入当前轮。');return e;
 }
 private retainUpload(e:QaUploadEnvelope,previous:QaUploadEnvelope|null){
  const result=this.uploadJournal?.save(e,previous);if(result?.status!=='valid')throw new UserFacingError(result?.status==='conflict'?'另一页面已改变原上传准备，当前材料未加入其他轮。':'无法可靠保存原问答上传记录，请保留原文件后重试确认。');
  this.scanUploads();return result.value;
 }
 private uploadRows(kind:QaUploadKind){
  const errors=this.uploadSelections.map((s,index)=>({s,index})).filter(({s})=>s.kind===kind).map(({s,index})=>`<article class="qa-upload-recovery bb-upload-file"><strong>${esc(s.name)}</strong><p role="alert">${esc(s.message)}</p><button class="bb-upload-action text-button" data-qa-selection="${index}">移除此本机选择</button></article>`).join('');
  return `${kind==='source'&&this.uploadProblem?`<p class="qa-warning" role="alert">${esc(this.uploadProblem)}</p>`:''}${errors}${this.uploadEnvelopes.filter(e=>e.kind===kind).map(e=>`<div class="qa-upload-recovery bb-upload-file" data-qa-upload-batch="${esc(e.id)}"><p>${kind==='source'?'问题清单上传待确认。':'补充材料上传待确认。'}</p>${e.items.map((item,index)=>`<article data-qa-upload-id="${esc(item.id)}"><strong>${esc(item.declaration.filename)}</strong>${uploadProgressHtml(this.fileProgress.get(item.id),item.declaration.filename,{error:this.uploadErrors.get(item.id),paused:!this.busy&&!item.material,complete:!!item.material})}<p>${item.applied?'已加入原准备，待清理本机上传记录':e.handedOff?'已移交原文件处理请求，请在上方恢复原请求':item.material?'服务器已确认保存原文件；'+(kind==='source'?'尚未开始文件处理':'尚需确认加入原准备'):'重试会先确认保存结果，需要原文件时再重新选择。'}</p>${item.applied||e.handedOff?'':`<button class="bb-upload-action bb-upload-action--primary btn secondary" data-qa-upload-action="resume" data-operation="${esc(item.id)}" ${index>0&&!e.items[index-1].applied||!!this.pending?'disabled':''}>确认原上传${kind==='supplement'?'并加入原准备':''}</button>${this.uploadNeedsFile.has(item.id)?`<label class="bb-upload-picker bb-upload-picker--compact btn secondary">重新选择原文件<input type="file" data-qa-upload-reselect="${esc(item.id)}" accept="${kind==='source'?'.doc,.docx,.pdf':'.doc,.docx,.pdf,.xlsx'}" aria-label="重新选择原文件 ${esc(item.declaration.filename)}"></label>`:''}${kind==='source'&&item.material?`<button class="bb-upload-action bb-upload-action--primary btn primary" data-qa-upload-action="prepare" data-operation="${esc(item.id)}" ${this.pending?'disabled':''}>继续文件处理</button>`:''}`}</article>`).join('')}<button class="bb-upload-action text-button" data-qa-upload-stop="${esc(e.id)}">${e.handedOff||e.items.every(i=>i.applied)?'完成':'取消本次上传'}</button><small>取消不会删除已保存文件或撤销已提交的识别。</small></div>`).join('')}`;
 }
 private bindUploads(){
  document.querySelectorAll<HTMLElement>('[data-qa-upload-action]').forEach(button=>button.addEventListener('click',()=>void this.act(async()=>{
   const id=button.dataset.operation!,e=this.uploadEnvelopes.find(e=>e.items.some(i=>i.id===id));if(!e)return;
   try{if(button.dataset.qaUploadAction==='prepare')await this.continueSource(e.id);else await this.resumeUpload(e.id,e.items.findIndex(i=>i.id===id));}
   catch(error){if(this.live()){this.uploadErrors.set(id,this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save'));this.message=this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save');}}
   if(this.live()){this.scanUploads();this.paint();}
  },button.dataset.qaUploadAction==='prepare'?'submit':'save')));
  document.querySelectorAll<HTMLInputElement>('[data-qa-upload-reselect]').forEach(input=>input.addEventListener('change',()=>{const file=input.files?.[0],id=input.dataset.qaUploadReselect!,e=this.uploadEnvelopes.find(e=>e.items.some(i=>i.id===id));if(!file||!e)return;this.uploadFiles.set(id,file);void this.act(async()=>{
   try{await this.resumeUpload(e.id,e.items.findIndex(i=>i.id===id),file);}catch(error){if(this.live()){this.uploadErrors.set(id,this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save'));this.message=this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save');}}
   if(this.live()){this.scanUploads();this.paint();}
  },'save');}));
  document.querySelectorAll<HTMLElement>('[data-qa-upload-stop]').forEach(button=>button.addEventListener('click',()=>void this.act(async()=>{await this.stopUploads(button.dataset.qaUploadStop!);if(this.live())this.paint();})));
  document.querySelectorAll<HTMLElement>('[data-qa-selection]').forEach(button=>button.addEventListener('click',()=>{this.uploadSelections.splice(Number(button.dataset.qaSelection),1);this.paint();}));
 }
 private async startUploads(files:File[],kind:QaUploadKind){
  let envelope:QaUploadEnvelope|undefined;
  try{
   if(this.locked()||this.hasUploads())throw new UserFacingError('请先确认原上传或停止本机后续保存，再选择新文件。');
   if(!this.owner||!this.uploadCore.has(kind))throw new UserFacingError('尚未核实当前账号，未建立上传会话。');
   if(kind==='supplement'&&(!this.state!.draft.preparation_id||this.state!.draft.materials.length+files.length>50))throw new UserFacingError('每轮最多参考 50 份材料，请先核对原问题清单和材料数量。');
   if(!this.persist())throw new UserFacingError(this.cacheProblem);
   this.preparingUpload=files[0];this.paint();
   const base=this.snapshot(),declarations:Dto<'UploadCreateRequest'>[]=[];
   for(const file of files){const media=qaUploadMedia(file.name,kind);if(!media||!file.size||file.size>100*1024*1024)throw new UserFacingError('请上传不超过 100 MB 的'+(kind==='source'?' DOC/DOCX 或 PDF 问题清单。':' DOC/DOCX、PDF 或 Excel 材料。'));
    const sha256=[...new Uint8Array(await uploadFileDigest(file,this.controller.signal))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(!this.live())return;declarations.push({filename:file.name,media_type:media,role:'other',sha256,byte_size:file.size});
   }
   if(!this.cacheMatches()||!qaUploadSame(base,this.snapshot()))throw new UserFacingError('准备内容已在文件核对期间改变，未开始上传。');
   envelope=qaUploadEnvelope(this.owner,this.id!,kind,base,declarations);envelope=this.retainUpload(envelope,null);
   for(const [index,item] of envelope.items.entries()){this.uploadFiles.set(item.id,files[index]);this.uploadCore.get(kind)!.begin(item.declaration,qaUploadContext(envelope,index),item.id);}
   this.preparingUpload=undefined;this.scanUploads();this.paint();
   const original=envelope;
   await orderedUploadPipeline(original.items,
    (item,index,signal)=>this.transferUpload(original.id,index,files[index],signal),
    async(_material,_item,index)=>{await this.resumeUpload(original.id,index);return this.live();},this.controller.signal);
   // Initial file selection retains the existing upload-and-free-identification
   // intent. Reload/retry only confirms the upload; its next task is explicit.
   if(kind==='source'){await this.continueSource(envelope.id);return;}
   if(this.live())this.message='已补充材料并保留原准备选择。可直接开始回答。';
   }catch(error){if(error instanceof UploadPreparationError)error=error.original;if(this.live()){
   this.message=this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save');
   this.preparingUpload=undefined;
    if(!envelope)this.uploadSelections.push(...files.map(file=>({kind,name:file.name,message:this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save')})));
   else if(kind==='source'&&this.pending?.kind==='prepare'&&this.pending.request.request_id===envelope.prepareRequestId){/* Original prepare journal owns this uncertainty. */}
   else{try{const unresolved=this.originalEnvelope(envelope.id).items.find(i=>!i.applied);if(unresolved)this.uploadErrors.set(unresolved.id,this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save'));}
    catch{this.uploadSelections.push(...files.map(file=>({kind,name:file.name,message:this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save')})));}}
  }}
  if(this.live()){this.scanUploads();this.paint();}
 }
  private async transferUpload(envelopeId:string,index:number,file?:File,signal=this.controller.signal){
   const e=this.originalEnvelope(envelopeId),item=e.items[index];if(!item)throw new UserFacingError('无法核实原上传文件。');
   const core=this.uploadCore.get(e.kind)!,record=core.list().find(r=>r.id===item.id);
   if(!record||!qaUploadRecordMatches(e,index,record))throw new UserFacingError('原上传记录已丢失或关联不一致，已停止；不会重新建立上传或套用当前准备。');
   const report=(p:FileUploadProgress)=>{if(!this.live()||signal.aborted)return;this.fileProgress.set(item.id,p);this.scanUploads();this.paint();};
   try{return await core.resume(item.id,{file:file??this.uploadFiles.get(item.id),signal,requireDurableRecord:true,status:message=>report(uploadActivity(message)),progress:(loaded,total)=>report(uploadTransfer(loaded,total))});}
   catch(error){if(error instanceof UploadRecoveryNeedsFileError)this.uploadNeedsFile.add(item.id);throw error;}
  }
  private async resumeUpload(envelopeId:string,index:number,file?:File){
  if(this.pending)throw new UserFacingError('原问答请求尚未核实，请先通过原请求恢复入口继续。');
  let e=this.originalEnvelope(envelopeId),item=e.items[index];if(!item)throw new UserFacingError('无法核实原上传文件。');
  if(item.applied||e.handedOff){await this.cleanUploads(e);return;}
  if(index>0&&!e.items[index-1].applied)throw new UserFacingError('请先完成这一批中的前一份原材料。');
  const core=this.uploadCore.get(e.kind)!;const record=core.list().find(r=>r.id===item.id);
  if(!record||!qaUploadRecordMatches(e,index,record))throw new UserFacingError('原上传记录已丢失或关联不一致，已停止；不会重新建立上传或套用当前准备。');
  let material:Dto<'MaterialResponse'>;
  this.uploadErrors.delete(item.id);
  const report=(p:FileUploadProgress)=>{if(!this.live())return;this.fileProgress.set(item.id,p);this.scanUploads();this.paint();};
  try{material=await core.resume(item.id,{file:file??this.uploadFiles.get(item.id),signal:this.controller.signal,status:message=>report(uploadActivity(message)),progress:(loaded,total)=>report(uploadTransfer(loaded,total))});}
  catch(error){if(error instanceof UploadRecoveryNeedsFileError)this.uploadNeedsFile.add(item.id);throw error;}
  if(!this.live())return;
  e=this.originalEnvelope(envelopeId);item=e.items[index];
  if(item.material&&!qaUploadMaterialMatches(item.material,material))throw new UserFacingError('原文件的已保存版本发生变化，未替换引用。');
  if(!item.material){const next=structuredClone(e);next.items[index].material=material;e=this.retainUpload(next,e);item=e.items[index];}
  this.uploadErrors.delete(item.id);this.uploadNeedsFile.delete(item.id);this.uploadFiles.delete(item.id);
  if(e.kind==='source')return;
  const expected=qaUploadExpected(e),next=qaUploadExpected(e,index),fresh=await this.read();if(!this.live())return;
  if(fresh.revision!==e.base.revision)throw new UserFacingError('服务器中的原准备内容已变化。文件已保存，但没有加入当前另一轮；请核对原轮次或停止本机后续保存。');
  const local=this.cache!.read(),snapshot=this.snapshot();
  if(local.status!=='valid'||(!qaUploadSame(local.value,expected)&&!qaUploadSame(local.value,next))||(!qaUploadSame(snapshot,expected)&&!qaUploadSame(snapshot,next)))throw new UserFacingError('原问题、材料或回答要求已在其他页面改变。文件已保存，但没有覆盖当前准备。');
  const saved=this.cache!.save(next,local.value);if(saved.status!=='valid')throw new UserFacingError('材料已保存，但原准备的本机保存尚未确认；请保留记录后重试。');
  this.cached=saved.value;this.adoptLocal(saved.value);this.dirty=true;this.server=structuredClone(fresh);
  const asset=qaUploadAsset(this.id!,material);if(!this.state!.materials.some(m=>key(m.asset)===key(asset)))this.state!.materials.push({filename:material.filename,asset});
  const accepted=structuredClone(e);accepted.items[index].applied=true;e=this.retainUpload(accepted,e);
  await core.forget(item.id);if(!this.live())return;
  await this.cleanUploads(e);
 }
 private async cleanUploads(e:QaUploadEnvelope){
  if(!e.handedOff&&!e.items.every(i=>i.applied)){this.scanUploads();return;}
  for(const item of e.items)await this.uploadCore.get(e.kind)!.forget(item.id);
  if(!this.live())return;const result=this.uploadJournal!.remove(e);if(result.status!=='valid')throw new UserFacingError('原材料或识别请求已可靠保存，本机记录清理尚待核对。');this.scanUploads();
 }
 private async stopUploads(id:string){
  const e=this.originalEnvelope(id);for(const item of e.items)await this.uploadCore.get(e.kind)!.forget(item.id);
  if(!this.live())return;const result=this.uploadJournal!.remove(e);if(result.status!=='valid')throw new UserFacingError('本机原上传记录清理尚未确认，请重新读取后核对。');
  for(const item of e.items){this.uploadFiles.delete(item.id);this.uploadErrors.delete(item.id);this.uploadNeedsFile.delete(item.id);}
  this.scanUploads();this.message='已停止本机后续保存。服务器已收到的文件、已保存准备和已提交请求继续保留。';
 }
 private async continueSource(id:string){
  let e=this.originalEnvelope(id);if(e.kind!=='source')return;
  if(e.handedOff){await this.cleanUploads(e);this.paint();return;}
  const item=e.items[0];if(!item.material)throw new UserFacingError('请先确认原问题清单文件已保存。');
  const request={request_id:e.prepareRequestId!,source:qaUploadAsset(this.id!,item.material)};
  const originals=this.journal!.readAll();if(originals.status!=='valid')throw new UserFacingError('无法核实原文件处理请求记录，未重新提交。');
  const retained=originals.values.find(v=>v.pending?.kind==='prepare'&&v.pending.request.request_id===request.request_id);
  if(retained){
   if(retained.pending?.kind!=='prepare'||!qaUploadSame(retained,{...e.base,pending:{kind:'prepare',request}}))throw new UserFacingError('原识别请求与已保存文件或原准备内容不一致，未替换请求。');
   if(this.pending&&JSON.stringify(this.pending)!==JSON.stringify(retained.pending))throw new UserFacingError('请先核对当前原请求，不能替换为另一项识别。');
   this.adoptLocal(retained);this.detachedPending=true;this.journalChoices=[];this.cacheProblem='';
   const handed=structuredClone(e);handed.handedOff=true;e=this.retainUpload(handed,e);await this.cleanUploads(e);
   this.message='原文件处理请求已恢复。请使用“恢复或提交原请求”核对同一请求，尚未自动提交。';this.paint();return;
  }
  if(this.locked()||!this.cacheMatches()||!qaUploadSame(this.snapshot(),e.base))throw new UserFacingError('原问答准备已改变。文件已保存，但没有开始另一轮识别。');
  await this.resumeUpload(e.id,0);if(!this.live())return;e=this.originalEnvelope(id);
  const fresh=await this.read();if(!this.live())return;if(fresh.revision!==e.base.revision)throw new UserFacingError('原问答准备的服务器版本已变化，请核对后重新准备；未开始识别。');
  this.pending={kind:'prepare',request};if(!this.persist()){this.paint();return;}
  const handed=structuredClone(e);handed.handedOff=true;e=this.retainUpload(handed,e);await this.cleanUploads(e);
  if(this.live())await this.sendPending();
 }
}
