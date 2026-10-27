import {UserFacingError} from './user-facing-error.js';

import {PROJECT_QA_PRICE,MARKET_LABELS,MARKET_OFFERINGS,OFFERING_LABELS,QaWorkspaceSchema,qaSchemas,type QaWorkspace,type QaDraft,type QaRun,type QaCase,type QaQuestion,type ProjectFileAsset} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {ProjectEntry,projectFlowSteps} from './project-entry';
import {ProjectAssistant} from './project-assistant';
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

const steps=['选择项目','Word 问题清单','回答与待补材料'];
const terminal=new Set(['succeeded','failed','cancelled','rejected','test_completed']);
const wordScope='保留完整原问题清单，仅回填本轮所选问题，不会自动合并历史答案。';
const noAcceptance=new Set(['INPUT_REVISION_CONFLICT','PROJECT_RUN_ACTIVE','CREDITS_INSUFFICIENT','QUOTE_CHANGED','INPUT_REQUIRED','MATERIAL_UNREADABLE']);

export class ProjectQaWorkspace {
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
 private followup=new Map<string,Set<string>>();
 private answerDisclosures=new Map<string,Map<string,boolean>>();
 private assistantOpen=false;
 private uploadJournal?:QaUploadJournal;
 private uploadCore=new Map<QaUploadKind,UploadRecovery>();
 private uploadEnvelopes:QaUploadEnvelope[]=[];
 private uploadFiles=new Map<string,File>();
 private uploadErrors=new Map<string,string>();
 private uploadNeedsFile=new Set<string>();
 private uploadProblem='';
 private uploadSelections:{kind:QaUploadKind;name:string;message:string}[]=[];
 private references=new QaReferenceMaterials();

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

 constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private assistant:()=>ProjectAssistant|undefined,private id?:string,private owner?:string){window.addEventListener('storage',this.storageChanged);}
 private live(){return this.current()&&!this.controller.signal.aborted;}
 private href(extra:Record<string,string>={}){return '#qa?'+withProjectContext(new URLSearchParams({project:this.id!,...extra}));}
 private filesHref(){return projectWorkHref('files',navigationProjectContext(location.hash)?.projectId??this.id!)+'?folder=4.2';}
 private selectedRun(){return new URLSearchParams(location.hash.split('?')[1]).get('run');}
 private currentRun(){const id=this.selectedRun();return this.state?.runs.find(r=>r.run_id===id);}
 private query(){const run=this.selectedRun();return run?'?run_id='+encodeURIComponent(run):'';}
 private locked(){return !!this.pending||this.conflict||!!this.cacheProblem||!!this.journalChoices.length;}
 get hasUnconfirmed(){return this.busy||!!this.uploadSelections.length||!!this.cacheProblem||!!this.state&&(this.dirty||!!this.pending)&&!this.cacheMatches();}
 async beforeLeave(){
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
 dispose(){window.removeEventListener('storage',this.storageChanged);this.assistant()?.detachProject();this.controller.abort();this.entry?.dispose();clearTimeout(this.timer);this.dialog?.remove();this.downloads.dispose();}
 private error(e:unknown,operation:'read'|'save'|'download'|'submit'|'action'='action'){return friendlyError(e,operation);}
 private status(text:string){this.message=text;const node=document.querySelector('#project-qa-status');if(node)node.textContent=text;}
 private request<T>(method:'GET'|'POST',suffix:string,body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id!)}/qa${suffix}`,body,{},this.controller.signal);}
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
  const blocked=this.locked()||this.needsKnowledgeChoice||this.hasUploads();
  const run=this.currentRun(),follow=run?.operation==='answer'?qaFollowupFor(run,this.state!.runs,this.id!):undefined;
  document.querySelectorAll<HTMLButtonElement>('#qa-view-missing,#qa-prepare-next').forEach(button=>button.disabled=this.busy||this.locked()||!follow||!!follow.error);
  const unavailable=this.state!.draft.materials.some(a=>!this.state!.materials.some(m=>key(a)===key(m.asset)));
  const save=document.querySelector<HTMLButtonElement>('#qa-save'),start=document.querySelector<HTMLButtonElement>('#qa-start');
  if(save)save.disabled=blocked;
  if(start)start.disabled=blocked||unavailable||!this.state!.draft.questions.length||!!qaPreparationFor(this.state!.draft,this.state!.runs,this.id!).error;
 }
 private adoptLocal(value:QaRecoveryValue){
  this.state!.draft=structuredClone(value.draft);this.state!.revision=value.revision;
  this.pending=value.pending?structuredClone(value.pending):undefined;
  this.needsKnowledgeChoice=value.needsKnowledgeChoice===true;this.sourceRun=value.sourceRun;
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
   this.entry=new ProjectEntry(this.api,this.shell,()=>this.live(),{section:'qa',title:'项目问答',eyebrow:'BONDBUDDY AGENT',description:'上传 Word 问题清单，结合项目材料回答，并把回答与待补材料写回文档。',steps,next:'下一步：Word 问题清单',onNew:()=>this.newProject(),open:async id=>{if(this.live())location.hash='qa?project='+encodeURIComponent(id);}});
   await this.entry.render();return;
  }
  this.shell('<p role="status">正在读取项目问答…</p>','qa');
  try{
   const [project,fresh]=await Promise.all([this.api.project(this.id,this.controller.signal),this.read()]);
   if(!this.live())return;
   this.project=project;this.cache=new QaRecoveryCache(this.owner??'',this.id);this.journal=new QaRecoveryJournal(this.owner??'',this.id);this.restore(fresh);await this.loadLocalPreparation();this.scanJournal();
   this.uploadJournal=new QaUploadJournal(this.owner??'',this.id);
   if(this.owner)for(const kind of ['source','supplement'] as const)this.uploadCore.set(kind,new UploadRecovery(this.api,this.owner,this.id,`qa-${kind}`,()=>this.live()));
   this.scanUploads();if(this.live())this.paint();
  }catch(e){if(this.live())this.shell(`<h1>项目问答暂时无法打开</h1><p role="alert">${esc(this.error(e,'read'))}</p><a href="#qa">重新选择项目</a>`,'qa');}
 }
 private header(){return `<header class="page-head"><div><p class="eyebrow">BONDBUDDY AGENT</p><h1>项目问答</h1><p>核对本轮问题，补齐依据，把回复留在 Word 里。</p></div><button class="btn secondary" id="qa-knowledge" ${this.pending?'disabled':''}>公募问答知识库</button></header>${projectFlowSteps(steps,this.currentRun()?.operation==='answer'?3:2,'项目问答流程')}<div class="pf-source-strip"><strong>${esc(this.project!.name)}</strong><a class="text-button" href="#qa">更换项目</a><a class="text-button" href="${esc(this.filesHref())}">项目文件 →</a></div>`;}


 private activeTasks(){
  const active=this.state!.runs.filter(run=>!terminal.has(run.state)&&run.run_id!==this.selectedRun());
  if(!active.length)return '';
  return `<section class="qa-recovery" aria-label="进行中的问答任务"><h2>进行中的问答任务</h2>${active.map(run=>`<p>${run.operation==='prepare'?'识别 Word 问题清单':'回答问题'} · ${esc(runStateLabel[run.state as keyof typeof runStateLabel]??'状态待核对')}</p><a class="btn secondary" href="${esc(this.href({run:run.run_id}))}">查看进度与操作</a>`).join('')}</section>`;
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
  if(!this.pending&&this.journalChoices.length)return `<section class="qa-recovery"><h2>发现独立保存的原请求</h2><p>另一页面的准备记录没有覆盖这些原请求。重新打开页面不会自动提交，请先选择要核对的一项。</p>${this.journalChoices.map((value,index)=>`<article><h3>${{draft:'准备内容保存',prepare:'免费问题清单识别',answer:'回答任务'}[value.pending!.kind]}</h3><p>原修订 ${value.revision} · ${value.draft.questions.length} 题 · ${value.pending!.kind==='answer'?value.draft.questions.length*60+' 积分':'不产生回答费用'}</p>${this.references.reviewDetails(['journal',this.id,value],'原问题、材料和要求',this.draftSummary(value.draft,'原请求准备',value))}<button class="btn secondary" ${index===0?'id="qa-restore-journal"':''} data-qa-journal="${index}">采用此原请求，继续核对</button></article>`).join('')}</section>`;

  if(this.cacheProblem)return `<section class="qa-recovery"><h2>请先恢复本机保存</h2><p>${esc(this.cacheProblem)}</p><p>${this.pending?'原'+({draft:'保存',prepare:'免费识别',answer:'回答'}[this.pending.kind])+'请求仍保留，当前不会重新提交。':''}</p>${this.foreign?`${this.references.reviewDetails(['stored',this.id,this.state!.revision,this.state!.draft,this.pending,this.foreign],'对照当前页面与已有恢复记录',this.draftSummary(this.state!.draft,'当前页面准备',[this.state!.revision,this.pending])+this.draftSummary(this.foreign.draft,'已有恢复记录',this.foreign)+'<p>已有记录'+(this.foreign.pending?'包含待核实的原请求':'尚未提交新任务')+'。采用会替换当前页准备，可先复制上方内容。</p>',true)}<button class="btn secondary" id="qa-use-stored" ${this.pending?'disabled':''}>采用已有恢复记录</button>`:''}${this.pending?`<p>原请求仍按 ${this.state!.draft.questions.length} 题、${this.pending.kind==='answer'?this.state!.draft.questions.length*60+' 积分':'免费识别/保存'} 核对；尚未受理时会首次提交原请求。不会改写另一页面准备。</p><button class="btn secondary" id="qa-retry-original-conflict">${this.pending.kind==='draft'?'只读核对本页原保存':'恢复或提交本页原请求'}</button>`:''}<button class="btn secondary" id="qa-recheck-cache">重新读取恢复记录</button></section>`;

  if(this.pending){
   const kind=this.pending.kind,points=this.state!.draft.questions.length*60;
   return `<section class="qa-recovery" role="region" aria-label="恢复原请求"><h2>${kind==='draft'?'准备内容保存结果待核实':kind==='prepare'?'问题清单识别请求待核实':'回答请求待核实'}</h2>${this.references.reviewDetails(['pending',this.id,this.state!.revision,this.state!.draft,this.pending],'核对原问题、材料和要求',this.draftSummary(this.state!.draft,'原请求准备',[this.state!.revision,this.pending]))}<p>${kind==='draft'?'原问题、材料和要求已保留。只读取服务器版本，完整一致后才解除冻结；不会再次保存。':kind==='prepare'?'原 Word 来源和请求已保留。重新打开页面不会自动提交。':'原 '+this.state!.draft.questions.length+' 题、'+this.state!.draft.materials.length+' 份材料和 '+points+' 积分确认已保留。重新打开页面不会自动提交。'}</p><p>${kind==='draft'?'如果服务器已有其他修改，将保留双方内容，不覆盖最新版本。':kind==='answer'?'“恢复或提交原请求”会查询原提交回执；若原请求未被接收，会首次开始原任务并冻结上述积分。':'“恢复或提交原请求”会恢复原回执；若原请求未被接收，会首次开始免费识别。'}</p>${kind==='draft'?'<button class="btn secondary" id="qa-refresh-pending">只读核对保存结果</button>':'<button class="btn secondary" id="qa-retry-pending">恢复或提交原请求</button>'}</section>`;
  }
  if(this.conflict&&this.server)return `<section class="qa-recovery"><h2>选择要继续的准备内容</h2><p>本机：${this.state!.draft.questions.length} 题，${this.state!.draft.materials.length} 份材料，修订 ${this.state!.revision}。服务器：${this.server.draft.questions.length} 题，${this.server.draft.materials.length} 份材料，修订 ${this.server.revision}。</p>${this.references.reviewDetails(['conflict',this.id,this.state!.revision,this.state!.draft,this.server.revision,this.server.draft],'对照两份回答要求、问题与材料',this.draftSummary(this.state!.draft,'本机准备',this.state!.revision)+this.draftSummary(this.server.draft,'服务器准备',this.server.revision))}<p>选择仅更新本机准备。之后仍需确认保存和费用，才会开始回答。</p><button class="btn secondary" id="qa-keep-local">保留本机准备，在最新修订上继续</button><button class="text-button" id="qa-use-server">使用服务器准备</button></section>`;
  if(this.cacheProblem)return `<section class="qa-recovery"><h2>请先恢复本机保存</h2><p>${esc(this.cacheProblem)}</p><button class="btn secondary" id="qa-recheck-cache">重新读取恢复记录</button></section>`;
  return '';
 }
 private paint(){
  if(!this.live()||!this.state)return;
  clearTimeout(this.timer);
  this.references.capture();
  if(this.references.composing){this.poll();return;}
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-answer-run][data-qa-answer-question]').forEach(row=>{
   const run=row.dataset.qaAnswerRun!,question=row.dataset.qaAnswerQuestion!;let saved=this.answerDisclosures.get(run);if(!saved){saved=new Map();this.answerDisclosures.set(run,saved);}saved.set(question,row.open);
  });
  const run=this.currentRun(),requested=this.selectedRun(),check=qaPreparationFor(this.state.draft,this.state.runs,this.id!),prepared=check.preparation,locked=this.locked();
  let content=this.pending&&prepared?this.draft(prepared):requested&&!run?`<div class="collection-empty"><h3>无法读取指定的问答版本</h3><p>此版本可能已移除或暂不可用。没有改用其他版本。</p><a href="${esc(this.href())}">返回本项目准备内容与历史</a></div>`:run?this.result(run):prepared?this.draft(prepared):`<div class="collection-empty"><h3>让回答留在问题旁边</h3><p>上传问题清单 → 核对问题与费用 → 回填回答与待补材料 → 下载 Word</p>${this.state.draft.preparation_id?`<p role="alert">${esc(check.error??'当前准备依据无法核实，请重新读取。')} 现有输入仍保留。</p>`:''}</div>`;
  if((run||!prepared)&&this.uploadEnvelopes.some(e=>e.kind==='supplement'))content+=`<details class="qa-materials" open><summary>原准备的补充材料</summary>${this.uploadRows('supplement')}</details>`;
  this.shell(`<div class="qa-page">${this.header()}<p id="project-qa-status" role="status">${esc(this.message)}</p>${this.recovery()}${this.activeTasks()}<div class="qa-layout"><aside class="qa-left"><section class="panel qa-upload"><h2>Word 问题清单</h2><p>${prepared?esc(prepared.manifest.source.filename):'保留原问题与上下文，将回答写在问题旁边。'}</p><label class="btn secondary">${prepared?'更换问题清单':'上传 Word 问题清单'}<input id="qa-upload" type="file" accept=".docx,.doc" aria-label="上传 Word 问题清单" ${locked||this.hasUploads()?'disabled':''}></label><small>DOCX / DOC，单份不超过 100 MB。上传后免费识别；上传中断时，先确认原文件再明确继续识别。确认问题和费用后开始回答。</small>${this.uploadRows('source')}</section><details class="panel qa-assistant" id="qa-assistant" ${this.assistantOpen?'open':''}><summary>需要梳理材料？与 BondBuddy 讨论</summary><p class="muted">对话单独按普通问答计费。写入 Word 的要求请填在“本轮回答要求”。</p><div id="qa-agent"></div></details></aside><section class="panel qa-document"><header class="pf-section-head"><h2>${run?'问题与文档':'本轮问题与材料'}</h2><select id="qa-history" aria-label="问答历史版本" ${locked?'disabled':''}><option value="">准备下一轮</option>${this.state.runs.map(r=>`<option value="${esc(r.run_id)}" ${r.run_id===run?.run_id?'selected':''}>第 ${r.sequence} 次 · ${r.operation==='prepare'?'识别问题':'回答问题'} · ${esc(runStateLabel[r.state as keyof typeof runStateLabel]??'状态待核对')} · ${esc(date(r.created_at))}</option>`).join('')}</select></header><div id="qa-document-body">${content}</div></section></div></div>`,'qa');
  document.querySelector('#qa-knowledge')!.addEventListener('click',()=>void this.act(()=>this.knowledge(),'read'));
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
  const assistantDetails=document.querySelector<HTMLDetailsElement>('#qa-assistant')!;
  const mountAssistant=()=>{if(assistantDetails.open&&!document.querySelector('#qa-agent .bb-assistant'))void this.assistant()?.embedProject(document.querySelector<HTMLElement>('#qa-agent')!,this.id!);};
  assistantDetails.addEventListener('toggle',()=>{if(!assistantDetails.isConnected)return;this.assistantOpen=assistantDetails.open;if(this.assistantOpen)mountAssistant();else this.assistant()?.detachProject();});
  if(this.assistantOpen)mountAssistant();
  if(run)this.bindResult(run);else if(!requested&&prepared)this.bindDraft(prepared);
  this.bindUploads();this.syncActions();this.references.bind(()=>this.paint());
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
  const d=this.state!.draft,points=d.questions.length*60;
  const available=this.state!.materials.filter(m=>key(m.asset)!==key(prepared.manifest.source.asset));
  const missing=d.materials.filter(a=>!available.some(m=>key(a)===key(m.asset)));
  return `<p class="qa-round-summary">已选择 <strong>${d.questions.length} 个问题</strong> · 每题 60 积分 · 本轮 <strong>${points.toLocaleString()} 积分</strong></p>${this.sourceRun?'<p class="qa-warning">已从指定历史任务准备下一轮，尚未提交。请核对选题、材料和参考方式。</p>':''}<p id="qa-word-scope" class="muted">${wordScope}</p><fieldset id="qa-preparation-controls" ${this.locked()?'disabled':''}><legend class="sr-only">本轮准备内容</legend><p class="muted">保留原文段落编号；同一完整问题的多个小问可合并。移除问题只影响本轮。</p>${prepared.result!.warnings.map(w=>`<p class="qa-warning">${esc(w)}</p>`).join('')}<div class="qa-question-list">${d.questions.map((q,i)=>`<article><div><strong>问题 ${i+1}</strong><small>原文段落 ${q.start+1}${q.end>q.start?'–'+(q.end+1):''}</small><button class="text-button" data-remove-q="${q.id}">移除</button></div><p>${esc(q.question)}</p></article>`).join('')||'<p>请从原文段落选择本轮问题。</p>'}</div><button class="btn secondary" id="qa-ranges">调整问题范围</button>${this.references.render(JSON.stringify([this.id,d.preparation_id]),available,d.materials,'<label class="btn secondary">补充项目材料<input id="qa-supplement" type="file" accept=".docx,.doc,.pdf,.xlsx" multiple aria-label="补充项目材料" '+(this.hasUploads()?'disabled':'')+'></label>'+this.uploadRows('supplement'))}<label class="qa-field">本轮回答要求<textarea id="qa-requirements" rows="3" maxlength="16000" placeholder="例如：逐项解释报告期变化，保留待补材料提示">${esc(d.requirements)}</textarea></label><div class="qa-knowledge-choice"><h3>本轮参考方式</h3>${this.needsKnowledgeChoice?'<p>历史记录没有保存当时的知识库开关。请选择本轮是否参考公开案例思路。</p>':''}<label><input type="radio" name="qa-knowledge-choice" data-qa-knowledge-choice value="true" ${!this.needsKnowledgeChoice&&d.use_knowledge?'checked':''}>项目材料 + 已审核公募问答思路</label><label><input type="radio" name="qa-knowledge-choice" data-qa-knowledge-choice value="false" ${!this.needsKnowledgeChoice&&!d.use_knowledge?'checked':''}>仅项目材料</label><p class="muted">公开案例用于回答结构和核对思路，不代替本项目事实。</p></div><footer class="qa-actions"><button class="btn secondary" id="qa-save" ${this.needsKnowledgeChoice?'disabled':''}>保存准备内容</button><button class="btn primary" id="qa-start" ${!d.questions.length||this.needsKnowledgeChoice||missing.length?'disabled':''}>生成回复文件 · ${points.toLocaleString()} 积分</button></footer></fieldset>`;
 }
 private bindDraft(prepared:QaRun){
  const d=this.state!.draft;
  document.querySelectorAll<HTMLElement>('[data-remove-q]').forEach(b=>b.addEventListener('click',()=>{if(this.locked())return;d.questions=d.questions.filter(q=>q.id!==b.dataset.removeQ);this.changed();this.paint();}));
  document.querySelector('#qa-ranges')!.addEventListener('click',()=>{if(!this.locked())this.ranges(prepared);});
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
  document.querySelectorAll<HTMLInputElement>('[data-qa-knowledge-choice]').forEach(r=>r.addEventListener('change',()=>{if(this.locked())return;d.use_knowledge=r.value==='true';this.needsKnowledgeChoice=false;this.changed();}));
  document.querySelector('#qa-save')!.addEventListener('click',()=>void this.act(async()=>{await this.save();this.status('本轮问题、材料与要求已保存。');},'save'));
  document.querySelector('#qa-start')!.addEventListener('click',()=>this.confirm());
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
  if(this.conflict||this.cacheProblem||this.needsKnowledgeChoice)throw new UserFacingError('请先核对恢复记录与本轮参考方式。');
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
  this.state!.runs=fresh.runs;this.state!.materials=fresh.materials;
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
   const ack=await this.request<Dto<'QaRunResponse'>>('POST',pending.kind==='prepare'?'/prepare':'/runs',pending.request);
   if(!Value.Check(qaSchemas.QaRunResponse,ack))throw new ApiError(0,'DATA_UNAVAILABLE');
   if(!this.live())return;
   const previous=this.snapshot(),{pending:removed,...next}=previous;
   const finish=this.finishRecovery(previous,next);
   if(!finish.ok){this.paint();return;}
   this.pending=undefined;this.dirty=false;this.dialog?.close();
   location.hash=this.href({run:ack.run_id});
  }catch(error){
   if(!this.live())throw error;
   if(error instanceof ApiError&&error.status>=400&&error.status<500&&noAcceptance.has(error.code)){
    if(pending.kind==='prepare'&&error.code==='PROJECT_RUN_ACTIVE'){
     // The upload already handed its exact source to this durable request. Keep
     // that handoff retryable when another project task temporarily owns the slot.
     this.message=this.error(error,'submit')+' 原问题清单已保留，可先查看项目任务，结束后返回恢复原免费识别请求。';
     this.dialog?.close();this.paint();throw error;
    }
    const previous=this.snapshot(),{pending:removed,...next}=previous;
    const finish=this.finishRecovery(previous,next);
    if(!finish.ok){this.paint();throw error;}
    this.pending=undefined;
    if(finish.foreign){const fresh=await this.read();if(!this.live())return;this.restore(fresh);this.scanJournal();}
    if(error.code==='INPUT_REVISION_CONFLICT'){
     const fresh=await this.read();this.server=structuredClone(fresh);this.state!.runs=fresh.runs;this.state!.materials=fresh.materials;this.conflict=fresh.revision!==this.state!.revision||!qaSameDraft(fresh.draft,this.state!.draft);
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
 private confirm(){
  if(this.locked()||this.needsKnowledgeChoice||!this.state!.draft.questions.length)return;
  const count=this.state!.draft.questions.length,points=count*60;
  const d=this.modal('确认回填问题清单',`<p>本轮 <strong>${count} 个问题 × 60 = ${points.toLocaleString()} 积分</strong>。</p><p>${wordScope}</p><p>开始时冻结积分；回答、依据和待补材料清单写入 Word 并交付后扣费。包含暂无法作答但已给出待补材料建议的问题。失败或取消释放冻结积分。补充材料后重新回答按新一轮所选问题数计费。</p><button class="btn primary" id="qa-confirm">确认并开始 · ${points.toLocaleString()} 积分</button>`);
  d.querySelector('#qa-confirm')!.addEventListener('click',()=>void this.act(async()=>{
   await this.save();
   if(!this.live()||this.locked())return;
   const request_id=await this.answerRequestId();if(!this.live()||this.locked())return;
   this.pending={kind:'answer',request:{request_id,expected_revision:this.state!.revision,expected_points:points,price_version:PROJECT_QA_PRICE.version}};
   if(!this.persist()){this.paint();return;}
   await this.sendPending();
  },'submit'));
 }
 private result(r:QaRun){
  const active=!terminal.has(r.state),follow=r.operation==='answer'?qaFollowupFor(r,this.state!.runs,this.id!):undefined;
  if(follow&&!this.followup.has(r.run_id))this.followup.set(r.run_id,new Set(follow.missingIds.length?follow.missingIds:r.manifest.questions.map(q=>q.id)));
  const selected=this.followup.get(r.run_id)??new Set<string>();
  const answers=r.result?.answers??[];
  const overview=!active&&follow?follow.error?`<section class="qa-result-overview" aria-label="本轮结果与下一步" data-qa-result-run="${esc(r.run_id)}"><h3>本轮结果与下一步</h3><p class="qa-warning">待补范围无法核实。${esc(follow.error)}</p><button class="btn secondary" id="qa-prepare-next" disabled>准备下一轮</button></section>`:`<section class="qa-result-overview" aria-label="本轮结果与下一步" data-qa-result-run="${esc(r.run_id)}"><h3>本轮结果与下一步</h3><p>原题 ${r.manifest.questions.length} 个 · 已有处理结果 ${answers.length} 个 · 待补材料 / 未回答 ${follow.missingIds.length} 个</p><div class="qa-result-navigation">${follow.missingIds.length?'<button class="btn secondary" id="qa-view-missing" '+(this.locked()||this.busy?'disabled':'')+'>查看待补问题</button>':''}<button class="btn secondary" id="qa-prepare-next" ${this.locked()||this.busy?'disabled':''}>准备下一轮</button></div><p class="muted">先查看原题与待补材料；准备下一轮时仍需采用选题、核对参考方式并确认每题 60 积分。</p></section>`:'';
  return `<div class="qa-run-head"><h3>${r.operation==='prepare'?'识别 Word 问题清单':'回填回复文件'} · ${esc(runStateLabel[r.state as keyof typeof runStateLabel]??r.state)}</h3><p>${esc(date(r.created_at))}${r.operation==='prepare'?' · 免费':` · ${r.manifest.questions.length} 题 × 60 积分`}</p><p>${r.reserved_points?'已冻结 '+r.reserved_points+' 积分，交付后扣除':r.charged_points?'已扣除 '+r.charged_points+' 积分':'本次尚未扣费'}</p>${active?`<progress></progress><p>关闭页面后任务继续，原件与历史成果保留。</p><button class="btn secondary" data-run-action="${['paused','awaiting_input'].includes(r.state)?'resume':'pause'}" ${this.pending?'disabled':''}>${['paused','awaiting_input'].includes(r.state)?'继续任务':'暂停任务'}</button><button class="text-button" data-run-action="cancel" ${this.pending?'disabled':''}>停止本轮</button>`:''}</div>${r.artifact_id?'<button class="btn primary" id="qa-download">下载回填 Word</button><p>已归入项目文件 · 4.2 核查记录</p>':''}<p id="qa-word-scope" class="muted">${wordScope}</p>${r.result?.warnings.map(w=>`<p class="qa-warning">${esc(w)}</p>`).join('')??''}${r.operation==='prepare'&&r.state==='succeeded'?`<p>已识别 ${r.result?.questions.length??0} 个候选问题。查看此版本不会改写当前准备。</p><button class="btn primary" id="qa-use-preparation" ${this.locked()||!r.result?'disabled':''}>采用识别问题，准备回答</button>`:''}${overview}${answers.length?`<p class="muted">回答草稿仍需人工审阅。</p>${answers.map(a=>`<details class="qa-answer" data-qa-answer-question="${esc(a.question_id)}" data-qa-answer-run="${esc(r.run_id)}" ${(this.answerDisclosures.get(r.run_id)?.get(a.question_id)??a.status==='missing')?'open':''}><summary><b>原文段落 ${(r.manifest.questions.find(q=>q.id===a.question_id)?.start??0)+1}</b><span>${esc(r.manifest.questions.find(q=>q.id===a.question_id)?.question??'无法核实题目对应关系')}</span><small>${a.status==='missing'?'待补材料':'回答草稿'}</small></summary><p>${esc(a.answer)}</p>${a.missing_materials.length?`<div class="qa-warning"><strong>需要补充</strong><ul>${a.missing_materials.map(m=>`<li>${esc(m)}</li>`).join('')}</ul></div>`:''}${a.citations.map(c=>`<p class="qa-citation">依据：${esc(r.result!.evidence[c.asset_index]?.filename??'')} · ${esc(r.result!.evidence[c.asset_index]?.snapshot.spans.find(s=>s.id===c.span_id)?.location??c.span_id)}<br>${esc(c.quote)}</p>`).join('')}${a.approach?`<p>回答思路：${esc(a.approach)}</p>`:''}</details>`).join('')}`:''}${['failed','cancelled','rejected'].includes(r.state)?'<p role="alert">本轮未完成交付，冻结积分将释放。原件和历次成果保留。</p>':''}${!active&&follow?`<section class="qa-followup"><h3 id="qa-followup-heading" tabindex="-1">补充材料，准备下一轮</h3><p>优先选择待补材料或未回答的问题。可调整选题；采用后仍需核对材料、参考方式和费用。</p>${follow.error?`<p role="alert">${esc(follow.error)}</p>`:''}<fieldset ${this.locked()||follow.error?'disabled':''}><legend>本轮要重新回答的问题</legend><div class="qa-followup-tools"><button class="text-button" id="qa-followup-missing">只选待补材料 / 未回答</button><button class="text-button" id="qa-followup-all">选择全部问题</button></div>${r.manifest.questions.map(q=>`<label><input type="checkbox" data-qa-followup value="${esc(q.id)}" ${selected.has(q.id)?'checked':''}><span><b>原文段落 ${q.start+1}${q.end>q.start?'–'+(q.end+1):''}</b> · ${follow.missingIds.includes(q.id)?'待补材料 / 未回答':'已有回答草稿'}<br>${esc(q.question)}</span></label>`).join('')}<p id="qa-followup-price">已选 ${selected.size} 题 · 下一轮 ${(selected.size*60).toLocaleString()} 积分</p><button class="btn secondary" id="qa-continue" ${!selected.size?'disabled':''}>采用选中问题，准备下一轮</button></fieldset></section>`:''}`;
 }
 private bindResult(r:QaRun){
  document.querySelector('#qa-download')?.addEventListener('click',()=>void this.act(async()=>{const a=await this.api.artifact(r.artifact_id!,this.controller.signal);if(a.artifact_id!==r.artifact_id||a.run_id!==r.run_id)throw new UserFacingError('当前回填 Word 与所选问答任务的对应关系无法核实，请重新读取后再下载。');const bytes=await this.api.artifactBytes(a,this.controller.signal);if(this.live())this.downloads.save(bytes,artifactFilename(a));},'download'));
  document.querySelectorAll<HTMLElement>('[data-run-action]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{if(this.pending)return;await this.api.runAction(r.run_id,b.dataset.runAction as 'pause'|'resume'|'cancel',this.controller.signal);await this.refresh(true);})));
  document.querySelector('#qa-use-preparation')?.addEventListener('click',()=>{
   if(this.locked()||!r.result)return;
   const d:QaDraft={preparation_id:r.run_id,questions:structuredClone(r.result.questions),materials:this.state!.materials.filter(m=>key(m.asset)!==key(r.manifest.source.asset)).slice(0,50).map(m=>m.asset),requirements:'',use_knowledge:false};
   const check=qaPreparationFor(d,this.state!.runs,this.id!);if(check.error){this.status(check.error);return;}
   this.state!.draft=d;this.needsKnowledgeChoice=true;this.sourceRun=r.run_id;this.changed();
   if(!this.cacheProblem)location.hash=this.href();else this.paint();
  });
  const follow=r.operation==='answer'?qaFollowupFor(r,this.state!.runs,this.id!):undefined;
  document.querySelectorAll<HTMLDetailsElement>('[data-qa-answer-question]').forEach(row=>row.addEventListener('toggle',()=>{
   if(!this.live()||!row.isConnected||row.dataset.qaAnswerRun!==r.run_id)return;
   let saved=this.answerDisclosures.get(r.run_id);if(!saved){saved=new Map();this.answerDisclosures.set(r.run_id,saved);}saved.set(row.dataset.qaAnswerQuestion!,row.open);
  }));
  document.querySelector('#qa-prepare-next')?.addEventListener('click',()=>{
   if(!this.live()||this.busy||this.locked()||!follow||follow.error)return;
   const heading=document.querySelector<HTMLElement>('#qa-followup-heading');heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start'});
  });
  document.querySelector('#qa-view-missing')?.addEventListener('click',()=>{
   if(!this.live()||this.busy||this.locked()||!follow||follow.error||!follow.missingIds.length)return;
   const candidates=r.manifest.questions.filter(q=>follow.missingIds.includes(q.id)),rows=[...document.querySelectorAll<HTMLDetailsElement>('[data-qa-answer-question]')].filter(row=>row.dataset.qaAnswerRun===r.run_id);
   let saved=this.answerDisclosures.get(r.run_id);if(!saved){saved=new Map();this.answerDisclosures.set(r.run_id,saved);}
   rows.filter(row=>follow.missingIds.includes(row.dataset.qaAnswerQuestion!)).forEach(row=>{saved!.set(row.dataset.qaAnswerQuestion!,true);row.open=true;});
   const first=candidates[0];if(!first)return;
   const target=rows.find(row=>row.dataset.qaAnswerQuestion===first.id)?.querySelector<HTMLElement>('summary')??[...document.querySelectorAll<HTMLInputElement>('[data-qa-followup]')].find(input=>input.value===first.id);
   target?.focus({preventScroll:true});target?.scrollIntoView({block:'start'});
  });
  const updatePrice=()=>{
   const selected=this.followup.get(r.run_id)??new Set<string>();
   const label=document.querySelector('#qa-followup-price');if(label)label.textContent=`已选 ${selected.size} 题 · 下一轮 ${(selected.size*60).toLocaleString()} 积分`;
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
   this.state!.draft={preparation_id:r.manifest.preparation_id,questions:structuredClone(questions),materials:r.manifest.materials.map(m=>structuredClone(m.asset)),requirements:r.manifest.requirements,use_knowledge:false};
   this.needsKnowledgeChoice=true;this.sourceRun=r.run_id;this.changed();
   if(!this.cacheProblem)location.hash=this.href();else this.paint();
  });
 }
 private async refresh(owned=false){
  try{
   const fresh=await this.read();if(!this.live())return;
   if(!owned&&(this.busy||this.dialog?.open)){this.poll();return;}
   this.server=structuredClone(fresh);
   if(!this.dirty&&!this.pending&&!this.conflict&&!this.cacheProblem)this.restore(fresh);
   else{this.state!.runs=fresh.runs;this.state!.materials=fresh.materials;}
   this.paint();
  }catch(e){if(this.live()){this.status(this.error(e,'read'));this.poll();}}
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
 private ranges(prepared:QaRun){const spans=prepared.result!.snapshot.spans,selected=structuredClone(this.state!.draft.questions);const modal=this.modal('核对问题范围',`<p>每行是原文的一个段落。选中问题起点，再填写结束段落；多个小问可按同一完整问题合并。费用按最终选中的问题数计算。</p><div class="qa-range-list">${spans.map((s,i)=>`<label><input type="checkbox" data-start="${i}" ${selected.some(q=>q.start===i)?'checked':''}><span><b>段落 ${i+1}</b> ${esc(s.text||'（空段落）')}</span><span>结束段落<input type="number" aria-label="段落 ${i+1} 的问题结束位置" data-end="${i}" min="${i+1}" max="${spans.length}" value="${(selected.find(q=>q.start===i)?.end??i)+1}"></span></label>`).join('')}</div><button class="btn primary" id="qa-ranges-save">确认问题范围</button>`);
  modal.querySelector('#qa-ranges-save')!.addEventListener('click',()=>{const questions:QaQuestion[]=[];let last=-1;try{for(const node of modal.querySelectorAll<HTMLInputElement>('[data-start]:checked')){const start=Number(node.dataset.start),end=Number(modal.querySelector<HTMLInputElement>(`[data-end="${start}"]`)!.value)-1,question=spans.slice(start,end+1).map(s=>s.text).join('\n').trim();if(!Number.isInteger(end)||start<=last||end<start||end>=spans.length||!question||question.length>16000)throw new UserFacingError('问题范围不能重叠或为空，每题不超过 16,000 字。');questions.push({id:'q'+start,start,end,question});last=end;}if(questions.length>200)throw new UserFacingError('每轮最多 200 个问题。');this.state!.draft.questions=questions;this.changed();modal.close();this.paint();}catch(e){modal.querySelector('[role=status]')!.textContent=this.error(e);}});
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
  const errors=this.uploadSelections.map((s,index)=>({s,index})).filter(({s})=>s.kind===kind).map(({s,index})=>`<article class="qa-upload-recovery"><strong>${esc(s.name)}</strong><p role="alert">${esc(s.message)}</p><button class="text-button" data-qa-selection="${index}">移除此本机选择</button></article>`).join('');
  return `${kind==='source'&&this.uploadProblem?`<p class="qa-warning" role="alert">${esc(this.uploadProblem)}</p>`:''}${errors}${this.uploadEnvelopes.filter(e=>e.kind===kind).map(e=>`<div class="qa-upload-recovery" data-qa-upload-batch="${esc(e.id)}"><p>${kind==='source'?'原问题清单文件；保存文件与免费识别分开。':'这些文件仅补充到开始上传时的原问题、材料及回答要求；其他页面修改后会停止。'} 刷新不会自动确认上传或提交任务。</p>${e.items.map((item,index)=>`<article data-qa-upload-id="${esc(item.id)}"><strong>${esc(item.declaration.filename)}</strong><p>${item.applied?'已加入原准备，待清理本机上传记录':e.handedOff?'已移交原免费识别请求，请在上方恢复原请求':item.material?'服务器已确认保存原文件；'+(kind==='source'?'尚未开始免费识别':'尚需确认加入原准备'):'原上传保存结果待确认；先查看文件是否已保存；如需重新上传，再选择同一份文件。'}</p>${this.uploadErrors.has(item.id)?`<p class="qa-warning" role="alert">${esc(this.uploadErrors.get(item.id)!)}</p>`:''}${item.applied||e.handedOff?'':`<button class="btn secondary" data-qa-upload-action="resume" data-operation="${esc(item.id)}" ${index>0&&!e.items[index-1].applied||!!this.pending?'disabled':''}>确认原上传${kind==='supplement'?'并加入原准备':''}</button>${this.uploadNeedsFile.has(item.id)?`<label class="btn secondary">重新选择原文件<input type="file" data-qa-upload-reselect="${esc(item.id)}" accept="${kind==='source'?'.doc,.docx':'.doc,.docx,.pdf,.xlsx'}" aria-label="重新选择原文件 ${esc(item.declaration.filename)}"></label>`:''}${kind==='source'&&item.material?`<button class="btn primary" data-qa-upload-action="prepare" data-operation="${esc(item.id)}" ${this.pending?'disabled':''}>继续免费识别</button>`:''}`}</article>`).join('')}<button class="text-button" data-qa-upload-stop="${esc(e.id)}">${e.handedOff||e.items.every(i=>i.applied)?'清理本机上传记录':'停止本机后续保存'}</button><small>服务器已收到的文件、已保存的原准备及已提交的识别请求仍会保留。</small></div>`).join('')}`;
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
   const base=this.snapshot(),declarations:Dto<'UploadCreateRequest'>[]=[];
   for(const file of files){const media=qaUploadMedia(file.name,kind);if(!media||!file.size||file.size>100*1024*1024)throw new UserFacingError('请上传不超过 100 MB 的'+(kind==='source'?' DOC/DOCX 问题清单。':' DOC/DOCX、PDF 或 Excel 材料。'));
    const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(!this.live())return;declarations.push({filename:file.name,media_type:media,role:'other',sha256,byte_size:file.size});
   }
   if(!this.cacheMatches()||!qaUploadSame(base,this.snapshot()))throw new UserFacingError('准备内容已在文件核对期间改变，未开始上传。');
   envelope=qaUploadEnvelope(this.owner,this.id!,kind,base,declarations);envelope=this.retainUpload(envelope,null);
   for(const [index,item] of envelope.items.entries()){this.uploadFiles.set(item.id,files[index]);this.uploadCore.get(kind)!.begin(item.declaration,qaUploadContext(envelope,index),item.id);}
   for(let index=0;index<envelope.items.length;index++)await this.resumeUpload(envelope.id,index,files[index]);
   // Initial file selection retains the existing upload-and-free-identification
   // intent. Reload/retry only confirms the upload; its next task is explicit.
   if(kind==='source'){await this.continueSource(envelope.id);return;}
   if(this.live())this.message='已补充材料并保留原准备选择。核对参考方式后保存并确认回答费用。';
  }catch(error){if(this.live()){
   this.message=this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save');
   if(!envelope)this.uploadSelections.push(...files.map(file=>({kind,name:file.name,message:this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save')})));
   else if(kind==='source'&&this.pending?.kind==='prepare'&&this.pending.request.request_id===envelope.prepareRequestId){/* Original prepare journal owns this uncertainty. */}
   else{try{const unresolved=this.originalEnvelope(envelope.id).items.find(i=>!i.applied);if(unresolved)this.uploadErrors.set(unresolved.id,this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save'));}
    catch{this.uploadSelections.push(...files.map(file=>({kind,name:file.name,message:this.error(error,this.pending&&this.pending.kind!=='draft'?'submit':'save')})));}}
  }}
  if(this.live()){this.scanUploads();this.paint();}
 }
 private async resumeUpload(envelopeId:string,index:number,file?:File){
  if(this.pending)throw new UserFacingError('原问答请求尚未核实，请先通过原请求恢复入口继续。');
  let e=this.originalEnvelope(envelopeId),item=e.items[index];if(!item)throw new UserFacingError('无法核实原上传文件。');
  if(item.applied||e.handedOff){await this.cleanUploads(e);return;}
  if(index>0&&!e.items[index-1].applied)throw new UserFacingError('请先完成这一批中的前一份原材料。');
  const core=this.uploadCore.get(e.kind)!;const record=core.list().find(r=>r.id===item.id);
  if(!record||!qaUploadRecordMatches(e,index,record))throw new UserFacingError('原上传记录已丢失或关联不一致，已停止；不会重新建立上传或套用当前准备。');
  let material:Dto<'MaterialResponse'>;
  try{material=await core.resume(item.id,{file:file??this.uploadFiles.get(item.id),signal:this.controller.signal,status:message=>this.status(message.replaceAll('上传会话','文件').replaceAll('原文件字节','原文件'))});}
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
  const originals=this.journal!.readAll();if(originals.status!=='valid')throw new UserFacingError('无法核实原免费识别请求记录，未重新提交。');
  const retained=originals.values.find(v=>v.pending?.kind==='prepare'&&v.pending.request.request_id===request.request_id);
  if(retained){
   if(retained.pending?.kind!=='prepare'||!qaUploadSame(retained,{...e.base,pending:{kind:'prepare',request}}))throw new UserFacingError('原识别请求与已保存文件或原准备内容不一致，未替换请求。');
   if(this.pending&&JSON.stringify(this.pending)!==JSON.stringify(retained.pending))throw new UserFacingError('请先核对当前原请求，不能替换为另一项识别。');
   this.adoptLocal(retained);this.detachedPending=true;this.journalChoices=[];this.cacheProblem='';
   const handed=structuredClone(e);handed.handedOff=true;e=this.retainUpload(handed,e);await this.cleanUploads(e);
   this.message='原免费识别请求已恢复。请使用“恢复或提交原请求”核对同一请求，尚未自动提交。';this.paint();return;
  }
  if(this.locked()||!this.cacheMatches()||!qaUploadSame(this.snapshot(),e.base))throw new UserFacingError('原问答准备已改变。文件已保存，但没有开始另一轮识别。');
  await this.resumeUpload(e.id,0);if(!this.live())return;e=this.originalEnvelope(id);
  const fresh=await this.read();if(!this.live())return;if(fresh.revision!==e.base.revision)throw new UserFacingError('原问答准备的服务器版本已变化，请核对后重新准备；未开始识别。');
  this.pending={kind:'prepare',request};if(!this.persist()){this.paint();return;}
  const handed=structuredClone(e);handed.handedOff=true;e=this.retainUpload(handed,e);await this.cleanUploads(e);
  if(this.live())await this.sendPending();
 }
 private async knowledge(q=''){
  const data=await this.api.request<{cases:QaCase[];can_review:boolean}>('GET','/qa/cases'+(q?'?q='+encodeURIComponent(q):''),undefined,{},this.controller.signal);if(!this.live())return;
  const d=this.modal('公募问答知识库',`<p>公开问答案例经人工核对后，供 BondBuddy 检索回答结构、证据要求和核对思路。项目私有材料不会自动进入知识库。</p><form id="qa-case-search"><input name="q" aria-label="搜索公募案例" placeholder="搜索问题或主题" value="${esc(q)}"><button class="btn secondary">搜索</button></form><div class="qa-case-list">${data.cases.map(c=>`<article><h3>${esc(c.content.title)}</h3><small>${esc(c.content.topic)} · ${{pending:'待审核',approved:'可供参考',withdrawn:'已撤回'}[c.status]}</small><p>${esc(c.content.question)}</p><details><summary>公开回答与答复思路</summary><p>${esc(c.content.answer)}</p><p>${esc(c.content.approach)}</p><p>证据要求：${esc(c.content.evidence_requirements)}</p></details><a href="${esc(c.content.url)}" target="_blank" rel="noopener noreferrer">公开来源 ↗</a>${data.can_review?`<button class="text-button" data-review-case="${c.id}">审核 / 撤回</button>`:''}</article>`).join('')||'<p>暂无匹配的已审核案例。添加公开来源后进入人工审核；当前不会引用合成案例。</p>'}</div><details><summary>录入公开问答案例</summary><p>仅录入已公开披露的内容；私有项目材料请在项目内上传。</p><form id="qa-case-create">${[['title','案例标题'],['url','公开来源 URL'],['topic','问题分类'],['question','公开问题'],['answer','公开回复'],['approach','回答思路'],['evidence_requirements','证据要求']].map(([name,label])=>`<label>${label}${['question','answer','approach','evidence_requirements'].includes(name)?`<textarea name="${name}" rows="3" maxlength="16000" ${name==='evidence_requirements'?'':'required'}></textarea>`:`<input name="${name}" type="${name==='url'?'url':'text'}" maxlength="${name==='url'?4096:250}" required>`}</label>`).join('')}<button class="btn primary">保存并提交审核</button></form></details>`);
  d.querySelector('#qa-case-search')!.addEventListener('submit',e=>{e.preventDefault();const q=String(new FormData(e.target as HTMLFormElement).get('q')??'');void this.act(()=>this.knowledge(q),'read');});
  const request_id=crypto.randomUUID();d.querySelector('#qa-case-create')!.addEventListener('submit',e=>{e.preventDefault();const content=Object.fromEntries(new FormData(e.target as HTMLFormElement));void this.act(async()=>{await this.api.request('POST','/qa/cases',{request_id,content},{},this.controller.signal);await this.knowledge();},'submit');});
  d.querySelectorAll<HTMLElement>('[data-review-case]').forEach(b=>b.addEventListener('click',()=>{const c=data.cases.find(c=>c.id===b.dataset.reviewCase)!;const modal=this.modal('审核公开问答案例',`<p>${esc(c.content.title)}</p><p>核对公开来源、问答正文与适用范围后填写审核记录。</p><form><label>审核结论<select name="status"><option value="approved">批准用于回答思路</option><option value="withdrawn">撤回 / 不予使用</option></select></label><label>来源核对与适用范围<textarea name="review_note" required rows="4" maxlength="16000"></textarea></label><button class="btn primary">保存审核</button></form>`);modal.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();const fields=Object.fromEntries(new FormData(e.target as HTMLFormElement));void this.act(async()=>{await this.api.request('POST','/qa/cases/'+c.id+'/review',{expected_revision:c.revision,...fields},{},this.controller.signal);await this.knowledge();},'save');});}));
 }
}
