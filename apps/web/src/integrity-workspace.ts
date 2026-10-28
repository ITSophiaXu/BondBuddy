import {displayPrice,isCnyPrice,cny,scopeReady,scopeLinesHtml,copyCommercePrice} from './commerce';
import {UserFacingError} from './user-facing-error.js';
import {integrityRecordPresentation,integrityFindingLabel,inferIntegrityRegion,INTEGRITY_SITES,INTEGRITY_PROVINCES,INTEGRITY_PRICE,IntegrityWorkspaceSchema,integritySchemas,schemas,resolveIntegritySite,MARKET_LABELS,OFFERING_LABELS,MARKET_OFFERINGS,type IntegrityWorkspace as Workspace,type IntegritySubject,type IntegrityRound,type IntegrityManual,type M4MaterialPin,type IntegrityDraft} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {ProjectEntry,projectFlowSteps} from './project-entry';
import {integritySitePicker,bindIntegritySitePicker} from './integrity-site-picker';
import {ArtifactDownloads,artifactFilename} from './artifact-download';
import {mountIntegrityBrowserEvidence} from './integrity-browser-evidence';
import {esc,date} from './ui';
import {runStateLabel} from './review-state';
import {withProjectContext,navigationProjectContext,projectWorkHref} from './project-navigation';
import {IntegrityRecoveryCache,IntegrityRecoveryJournal,type IntegrityRecoveryValue,type IntegrityRecoveryPending,type IntegrityEvidenceDraft} from './integrity-recovery';
import {UploadRecovery,UploadRecoveryNeedsFileError} from './upload-recovery';
import {beginIntegrityUpload,integrityUploadPurpose,integrityUploadPair,integrityUploadRecord,sameIntegrityUploadPair} from './integrity-upload';
import {integritySameDraft,integrityRoundFor,integrityWorkItems,integrityManualReadback} from './integrity-continuation';
import './file-workspace.css';
import './integrity-workspace.css';

const steps=['选择项目','名单与网站范围','核查结果与底稿'];
const terminal=new Set(['succeeded','failed','cancelled','rejected','test_completed']);
const links=(site:{links:{url:string;label:string}[]})=>site.links.map(l=>`<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join(' · ');
const statusChip=(view:ReturnType<typeof integrityRecordPresentation>)=>`<span class="pf-chip integrity-status-${view.tone}">${esc(view.label)}</span>`;
const provinces=(value:string)=>`<option value="">请选择注册地</option>${INTEGRITY_PROVINCES.map(p=>`<option ${p===value?'selected':''}>${esc(p)}</option>`).join('')}`;
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(value)??'null';
const sameRecovery=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export class IntegrityWorkspace {
 private controller=new AbortController();private entry?:ProjectEntry;private state?:Workspace;private server?:Workspace;private project?:Dto<'ProjectResponse'>;private busy=false;private dirty=false;private dialog?:HTMLDialogElement;private timer?:ReturnType<typeof setTimeout>;private downloads=new ArtifactDownloads();
 private cache?:IntegrityRecoveryCache;private journal?:IntegrityRecoveryJournal;private cached:IntegrityRecoveryValue|null=null;private pending?:IntegrityRecoveryPending;private evidenceDraft?:IntegrityEvidenceDraft;private sourceRun?:string;private problem='';private message='';private conflict=false;private detached=false;private journalChoices:IntegrityRecoveryValue[]=[];private filter='all';private expanded=new Set<string>();private openedRound?:string;private focusPair?:string;
 private confirmed?:{previous:IntegrityRecoveryValue;next:IntegrityRecoveryValue;runId?:string;draft?:Workspace};private foreignCompleted=false;private selectedFile?:{key:string;file:File};private pendingDraftMismatch=false;
 private evidenceUploads?:UploadRecovery;
 constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id?:string,private owner?:string){window.addEventListener('storage',this.storageChanged);}
 private storageChanged=()=>{if(!this.state||!this.live()||this.cacheMatches())return;this.problem='另一页面已更改本机准备。原请求仍保存在独立记录中，请重新读取并核对。';this.dialog?.close();this.paint();};
 private live(){return this.current()&&!this.controller.signal.aborted;}
 private uploads(){if(!this.owner||!this.id)throw new UserFacingError('当前账号或项目尚未确认，请返回原项目继续。');return this.evidenceUploads??=new UploadRecovery(this.api,this.owner,this.id,integrityUploadPurpose,()=>this.live()&&this.cacheMatches()&&!this.problem&&!this.foreignCompleted);}
 private href(extra:Record<string,string>={}){return '#integrity?'+withProjectContext(new URLSearchParams({project:this.id!,...extra}));}
 private filesHref(){return projectWorkHref('files',navigationProjectContext(location.hash)?.projectId??this.id!);}
 get hasUnconfirmed(){return this.busy||!!this.problem||!!this.confirmed||!!this.selectedFile||!!this.state&&(this.dirty||!!this.pending||!!this.evidenceDraft)&&!this.cacheMatches();}
 async beforeLeave(){if(this.busy)return false;if(this.selectedFile){this.status('所选文件尚未完成上传，请先保存补证；文件字节不能跨刷新保留。');return false;}if(this.foreignCompleted)return true;if(this.confirmed)return false;return !this.state||this.persist();}
 dispose(){window.removeEventListener('storage',this.storageChanged);this.entry?.dispose();this.controller.abort();this.dialog?.remove();clearTimeout(this.timer);this.downloads.dispose();}
 private request<T>(method:'GET'|'POST',suffix:string,body?:unknown){const run=new URLSearchParams(location.hash.split('?')[1]).get('run');if(method==='GET'&&!suffix&&run)suffix='?run_id='+encodeURIComponent(run);return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id!)}/integrity${suffix}`,body,{},this.controller.signal);}
 private error(e:unknown,operation:'read'|'save'|'download'|'submit'|'action'='action'){return e instanceof UploadRecoveryNeedsFileError?'需要重新上传，请选择相同内容的文件后继续。':friendlyError(e,operation);}
 private async read(suffix=''){const fresh=await this.request<Workspace>('GET',suffix);if(!Value.Check(IntegrityWorkspaceSchema,fresh))throw new ApiError(0,'DATA_UNAVAILABLE');return fresh;}
 private currentPrice(){return displayPrice(this.state?.price,this.state?.price.points??INTEGRITY_PRICE.points);}
 private locked(){return !!this.pending||!!this.confirmed||this.foreignCompleted||!!this.problem||this.conflict||!!this.journalChoices.length;}
 private snapshot():IntegrityRecoveryValue{return {revision:this.state!.revision,draft:structuredClone(this.state!.draft),...(this.sourceRun?{sourceRun:this.sourceRun}:{}),...(this.pending?{pending:structuredClone(this.pending)}:{}),...(this.evidenceDraft?{evidenceDraft:structuredClone(this.evidenceDraft)}:{})};}
 private cacheMatches(){const read=this.cache?.read();return read?.status==='empty'?this.cached===null:read?.status==='valid'&&sameRecovery(read.value,this.cached);}
 private cacheError(status:string){this.problem=status==='conflict'?'另一页面已更改本机准备。请重新读取并核对；当前输入和原请求仍保留。':status==='invalid'?'本机恢复记录无法核实，请保留本页内容并联系支持。':'本机保存暂不可用，请允许浏览器保存本站数据后重试。确认写入前无法提交。';this.status(this.problem);}
 private persist(){
  if(!this.state||!this.cache)return false;const value=this.snapshot();
  if(value.pending){const retained=this.journal?.retain(value);if(retained?.status!=='valid'){this.cacheError(retained?.status??'unavailable');return false;}}
  if(this.detached&&this.pending){this.problem='';return true;}
  const saved=this.cache.save(value,this.cached);if(saved.status!=='valid'){this.cacheError(saved.status);return false;}this.cached=saved.value;this.problem='';return true;
 }
 private adopt(value:IntegrityRecoveryValue){this.state!.draft=structuredClone(value.draft);this.state!.revision=value.revision;this.sourceRun=value.sourceRun;this.pending=value.pending?structuredClone(value.pending):undefined;this.evidenceDraft=value.evidenceDraft?structuredClone(value.evidenceDraft):undefined;this.dirty=!integritySameDraft(value.draft,this.server!.draft)||value.revision!==this.server!.revision;}
 private restore(fresh:Workspace){
  this.state=structuredClone(fresh);this.server=structuredClone(fresh);const saved=this.cache!.read();
  if(saved.status==='empty'){this.cached=null;return;}if(saved.status!=='valid'){this.cacheError(saved.status);return;}
  this.cached=saved.value;this.adopt(saved.value);this.conflict=!this.pending&&saved.value.revision!==fresh.revision;
  if(this.conflict)this.message='本机准备与服务器版本不同，请核对两份名单后选择。';else if(this.dirty)this.message='已恢复本机准备，尚未保存到服务器或开始新核查。';
 }
 private scanJournal(){const read=this.journal!.readAll();if(read.status!=='valid'){this.cacheError(read.status);return;}this.journalChoices=read.values.filter(v=>!this.pending||!sameRecovery(v,this.snapshot()));}
 private summary(d:IntegrityDraft){return `<p>${d.subjects.length} 个对象 · ${d.site_ids.length} 个网站</p><ul>${d.subjects.map(s=>`<li>${s.kind==='company'?'企业':'人员'}：${esc(s.name)} · ${esc(s.role)} · ${esc(s.province)} ${esc(s.city)}</li>`).join('')}</ul><p>网站：${d.site_ids.map(id=>esc(INTEGRITY_SITES.find(s=>s.id===id)?.name??id)).join('、')}</p><p>说明：${esc(d.notes||'未填写')}</p>`;}
 private historyLabel(runId:string){const r=this.state!.rounds.find(r=>r.run_id===runId);return r?`${date(r.created_at)} · 第 ${r.sequence} 次${r.operation==='export'?'底稿导出':'核查'}`:'已保存的历史核查';}
 private recoveryHtml(){
  if(this.confirmed)return `<section class="panel integrity-recovery" id="integrity-recovery"><h2>服务器已确认，本机保存待恢复</h2><p>本次请求已确认，无需再次提交。${esc(this.problem)}</p>${this.confirmed.runId?`<p>已确认任务：${esc(this.confirmed.runId)}</p>`:''}<button class="btn secondary" id="integrity-finish-confirmed">重试本机记录保存</button></section>`;
  if(this.foreignCompleted)return '<section class="panel integrity-recovery" id="integrity-recovery"><h2>原请求已确认，另一页面的准备已保留</h2><button class="btn secondary" id="integrity-recheck-cache">读取当前本机准备</button></section>';
  const pending=this.pending;
  if(pending?.kind==='draft'&&this.pendingDraftMismatch)return `<section class="panel integrity-recovery" id="integrity-recovery"><h2>原名单保存尚未确认，请选择后续准备</h2><p>服务器修订 ${this.server!.revision}，原请求修订 ${pending.request.expected_revision}。不会重发原保存。</p><details open><summary>原本机名单</summary>${this.summary(pending.request.draft)}</details><details><summary>服务器当前名单</summary>${this.summary(this.server!.draft)}</details><button class="btn secondary" id="integrity-refresh-pending">只读重新核对</button><button class="btn secondary" id="integrity-rebase-pending-draft">保留本机准备，重新确认保存</button><button class="text-button" id="integrity-server-pending-draft">采用服务器当前准备</button></section>`;
  if(pending)return `<section class="panel integrity-recovery" id="integrity-recovery"><h2>原${{draft:'名单保存',check:'收费核查',export:'免费导出',evidence:'补充证据'}[pending.kind]}结果待确认</h2><p>原请求已保存在本机。刷新或打开历史不会自动提交。请核对后继续。</p>${pending.kind==='check'?`<p>重试可能首次开始核查并预留 <strong>${displayPrice(pending.price,pending.request.expected_points)}</strong>；已受理时返回原任务。</p>`:pending.kind==='export'?`<p>原核查轮：${esc(pending.roundId)} · 原证据 ${pending.request.expected_evidence_ids.length} 份 · 免费，不重新查询。</p>`:pending.kind==='evidence'?`<p>原核查轮：${esc(pending.roundId)} · ${esc(pending.request.subject_id)} / ${esc(pending.request.site_id)}</p><p>${esc(pending.request.queried_at)} · ${esc(pending.request.url)}</p><p>${esc(pending.request.note)}</p>`:''}<details><summary>核对原名单与范围</summary>${this.summary(this.state!.draft)}</details><p>${esc(this.problem)}</p>${pending.kind==='draft'?'<button class="btn secondary" id="integrity-refresh-pending">只读核对原保存结果</button>':`<button class="btn primary" id="integrity-retry-pending">${pending.kind==='check'?'确认重试原核查 · '+displayPrice(pending.price,pending.request.expected_points)+'':pending.kind==='export'?'重试原免费导出':'重试原证据保存 · 免费'}</button>${pending.kind==='evidence'?'<button class="btn secondary" id="integrity-refresh-pending">只读核对证据回执</button>':''}`}${this.problem?'<button class="btn secondary" id="integrity-recheck-cache">重新读取恢复记录</button>':''}</section>`;
  if(this.journalChoices.length)return `<section class="panel integrity-recovery" id="integrity-recovery"><h2>发现独立保存的原请求</h2><p>请先核对原请求。选择后仍需明确重试，不会自动执行。</p>${this.journalChoices.map((v,i)=>`<article><p>${esc(v.pending!.kind)} · 原修订 ${v.revision}</p><details><summary>原名单与范围</summary>${this.summary(v.draft)}</details><button class="btn secondary" data-integrity-journal="${i}">采用此原请求，继续核对</button></article>`).join('')}</section>`;
  if(this.conflict)return `<section class="panel integrity-recovery" id="integrity-recovery"><h2>核对本机与服务器名单</h2><details open><summary>本机准备</summary>${this.summary(this.state!.draft)}</details><details><summary>服务器准备 · 修订 ${this.server!.revision}</summary>${this.summary(this.server!.draft)}</details><button class="btn secondary" id="integrity-keep-local">保留本机准备，在最新修订上继续</button><button class="text-button" id="integrity-use-server">使用服务器准备</button></section>`;
  if(this.problem)return `<section class="panel integrity-recovery" id="integrity-recovery"><h2>请先核对本机保存</h2><p>${esc(this.problem)}</p><button class="btn secondary" id="integrity-recheck-cache">重新读取恢复记录</button></section>`;
  if(this.selectedFile)return '<p class="integrity-notice">本页有尚未上传的证据文件。保存补证后可离开；刷新无法恢复文件字节。<button class="text-button" id="integrity-discard-file">取消选择此本地文件</button></p>';
  return '';
 }
 private bindRecovery(){
  document.querySelector('#integrity-discard-file')?.addEventListener('click',()=>{this.selectedFile=undefined;this.paint();});
  for(const [id,useServer] of [['integrity-rebase-pending-draft',false],['integrity-server-pending-draft',true]] as const)document.getElementById(id)?.addEventListener('click',()=>{if(this.pending?.kind!=='draft'||!this.pendingDraftMismatch)return;const previous=this.snapshot(),{pending:removed,...next}=previous;next.revision=this.server!.revision;if(useServer)next.draft=structuredClone(this.server!.draft);if(this.finish(previous,next)){this.pending=undefined;this.pendingDraftMismatch=false;this.state!.revision=next.revision;this.state!.draft=structuredClone(next.draft);this.dirty=!useServer;this.status('已核对并保留所选准备，尚未再次保存或执行。后续保存仍由服务器版本校验。');}this.paint();});
  document.querySelector('#integrity-finish-confirmed')?.addEventListener('click',()=>{const c=this.confirmed!;if(this.finish(c.previous,c.next)){this.confirmed=undefined;this.adopt(c.next);if(c.draft)this.dirty=false;if(c.runId)location.hash=this.href({run:c.runId});else this.paint();}else this.paint();});
  document.querySelector('#integrity-retry-pending')?.addEventListener('click',()=>void this.act(async()=>{if(!this.cacheMatches())this.detached=true;await this.sendPending();},this.pending&&['draft','evidence'].includes(this.pending.kind)?'save':'submit'));
  document.querySelector('#integrity-refresh-pending')?.addEventListener('click',()=>void this.act(()=>this.readPending(),'read'));
  document.querySelector('#integrity-recheck-cache')?.addEventListener('click',()=>void this.act(async()=>{const fresh=await this.read();if(!this.live())return;this.server=structuredClone(fresh);const stored=this.cache!.read();if(stored.status!=='valid'&&stored.status!=='empty'){this.cacheError(stored.status);this.paint();return;}if(this.pending){this.detached=!this.cacheMatches();this.problem='';}else if(stored.status==='valid'){this.cached=stored.value;this.adopt(stored.value);this.conflict=stored.value.revision!==fresh.revision;this.problem='';this.foreignCompleted=false;}else{this.cached=null;this.problem='';this.foreignCompleted=false;this.persist();}this.scanJournal();this.paint();},'read'));
  for(const [id,useServer] of [['integrity-keep-local',false],['integrity-use-server',true]] as const)document.getElementById(id)?.addEventListener('click',()=>{if(useServer){this.state!.draft=structuredClone(this.server!.draft);this.sourceRun=undefined;this.dirty=false;}else this.dirty=true;this.state!.revision=this.server!.revision;if(this.persist())this.conflict=false;this.paint();});
  document.querySelectorAll<HTMLButtonElement>('[data-integrity-journal]').forEach(b=>b.addEventListener('click',()=>{if(this.pending)return;const value=this.journalChoices[Number(b.dataset.integrityJournal)],read=this.journal!.readAll();if(read.status!=='valid'||!read.values.some(v=>JSON.stringify(v)===JSON.stringify(value))){this.cacheError(read.status);this.paint();return;}this.adopt(value);this.detached=true;this.journalChoices=[];this.problem='';this.paint();}));
 }
 private finish(previous:IntegrityRecoveryValue,next:IntegrityRecoveryValue){
  const stored=this.cache!.read();if(stored.status!=='valid'&&stored.status!=='empty'){this.cacheError(stored.status);return false;}
  const matches=stored.status==='valid'&&sameRecovery(stored.value,previous);
  if(!this.detached||matches){const saved=this.cache!.save(next,this.detached?stored.status==='valid'?stored.value:null:this.cached);if(saved.status!=='valid'){this.detached=true;this.cacheError(saved.status);return false;}this.cached=saved.value;}else this.foreignCompleted=true;
  const confirmed=this.journal!.confirm(previous);this.detached=false;this.problem='';this.journalChoices=[];if(confirmed.status!=='empty')this.message='服务器已确认，本机原请求清理尚待核对。';return true;
 }
 private async readPending(){
  const p=this.pending;if(!p)return;const fresh=await this.read(p.kind==='evidence'?'?run_id='+encodeURIComponent(p.roundId):'');if(!this.live())return;this.server=structuredClone(fresh);this.state!.rounds=fresh.rounds;
  if(p.kind==='draft'&&fresh.revision===p.request.expected_revision+1&&integritySameDraft(fresh.draft,p.request.draft)){this.completeDraft(fresh);this.status('已核对服务器：原名单与范围已完整保存。');}
  else if(p.kind==='evidence'){if(this.completeEvidence(fresh,p))this.status('已核对原证据回执，无需再次上传或保存。');else this.status('尚未找到与原请求完全一致的证据，原请求仍保留；可明确重试。');}
  else {this.pendingDraftMismatch=p.kind==='draft';this.status('尚无法确认原保存。原请求及本机内容仍保留，不自动重发。');}this.paint();
 }
 private completeDraft(fresh:Workspace){const previous=this.snapshot(),{pending:removed,...next}=previous;next.revision=fresh.revision;next.draft=structuredClone(fresh.draft);this.confirmed={previous,next,draft:fresh};if(!this.finish(previous,next))return false;this.confirmed=undefined;this.pending=undefined;this.pendingDraftMismatch=false;this.state!.revision=fresh.revision;this.state!.draft=structuredClone(fresh.draft);this.state!.rounds=fresh.rounds;this.server=structuredClone(fresh);this.dirty=false;return true;}
 private completeEvidence(fresh:Workspace,p:Extract<IntegrityRecoveryPending,{kind:'evidence'}>){const r=fresh.rounds.find(r=>r.run_id===p.roundId&&r.operation==='check'),found=r&&integrityManualReadback(p.request,r.evidence);if(found?.error)throw new UserFacingError(found.error);if(!found?.evidence)return false;const previous=this.snapshot(),{pending:removed,evidenceDraft:form,...next}=previous;this.confirmed={previous,next};if(!this.finish(previous,next))return false;this.confirmed=undefined;this.pending=undefined;this.evidenceDraft=undefined;return true;}
 private async sendPending(){
  const p=this.pending;if(!p||!this.persist()){this.paint();return;}
  try{
   if(p.kind==='draft'){const fresh=await this.request<Workspace>('POST','/draft',p.request);if(!Value.Check(IntegrityWorkspaceSchema,fresh)||fresh.revision!==p.request.expected_revision+1||!integritySameDraft(fresh.draft,p.request.draft))throw new ApiError(0,'DATA_UNAVAILABLE');if(this.live()&&!this.completeDraft(fresh))throw new UserFacingError(this.problem);return;}
   if(p.kind==='evidence'){const fresh=await this.request<Workspace>('POST',`/runs/${encodeURIComponent(p.roundId)}/evidence`,p.request);if(!Value.Check(IntegrityWorkspaceSchema,fresh))throw new ApiError(0,'DATA_UNAVAILABLE');if(!this.live())return;this.state!.rounds=fresh.rounds;if(!this.completeEvidence(fresh,p)&&!this.confirmed)await this.readPending();if(this.pending&&!this.confirmed)throw new ApiError(0,'DATA_UNAVAILABLE');this.dialog?.close();this.paint();if(!this.confirmed)this.status('证据已保存；此版底稿不变，免费重新导出后可包含新增证据。');return;}
   const result=await this.request<Dto<'IntegrityRunResponse'>>('POST',p.kind==='check'?'/runs':`/runs/${encodeURIComponent(p.roundId)}/exports`,p.request);if(!Value.Check(integritySchemas.IntegrityRunResponse,result))throw new ApiError(0,'DATA_UNAVAILABLE');if(!this.live())return;
   const previous=this.snapshot(),{pending:removed,...next}=previous;this.confirmed={previous,next,runId:result.run_id};if(!this.finish(previous,next)){this.dialog?.close();this.paint();return;}this.confirmed=undefined;this.pending=undefined;this.dialog?.close();location.hash=this.href({run:result.run_id});
  }catch(error){
   if(!this.live())throw error;
   const rejected=error instanceof ApiError&&error.status>=400&&error.status<500&&['INPUT_REVISION_CONFLICT','PROJECT_RUN_ACTIVE','CREDITS_INSUFFICIENT','QUOTE_CHANGED','INPUT_REQUIRED','VALIDATION_FAILED','MATERIAL_UNREADABLE'].includes(error.code);
   if(rejected){const previous=this.snapshot(),{pending:removed,...next}=previous;this.confirmed={previous,next};if(this.finish(previous,next)){this.confirmed=undefined;this.pending=undefined;this.dialog?.close();this.status(this.error(error,['draft','evidence'].includes(p.kind)?'save':'submit'));this.paint();try{const fresh=await this.read();if(this.live()){this.server=structuredClone(fresh);this.state!.rounds=fresh.rounds;this.conflict=this.state!.revision!==fresh.revision;}}catch{/* The known rejection remains authoritative if refreshing fails. */}}}
   this.dialog?.close();this.status(this.error(error,['draft','evidence'].includes(p.kind)?'save':'submit'));this.paint();throw error;
  }
 }
 private status(s:string){this.message=s;const n=document.querySelector<HTMLElement>('#integrity-status');if(n){n.textContent=s;n.hidden=!s;}}
 private async act(fn:()=>Promise<void>,operation:'read'|'save'|'download'|'submit'|'action'='action'){if(this.busy)return;this.busy=true;const fields=[...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement>('main input,main select,main textarea,main button,dialog input,dialog select,dialog textarea,dialog button')].map(n=>({n,disabled:n.disabled}));fields.forEach(f=>f.n.disabled=true);try{await fn();}catch(e){if(this.live()){this.status(this.error(e,operation==='read'||operation==='download'?operation:this.pending?['draft','evidence'].includes(this.pending.kind)?'save':'submit':operation));const n=this.dialog?.querySelector('[role=status]');if(n)n.textContent=this.error(e,operation==='read'||operation==='download'?operation:this.pending?['draft','evidence'].includes(this.pending.kind)?'save':'submit':operation);}}finally{this.busy=false;fields.forEach(f=>{if(f.n.isConnected)f.n.disabled=f.disabled;});}}
 async render(){
  if(!this.id){this.entry=new ProjectEntry(this.api,this.shell,()=>this.live(),{section:'integrity',title:'诚信核查',eyebrow:'INTEGRITY CHECK',description:'选择项目，准备企业与人员名单，查询公开记录并形成核查底稿。',steps,next:'下一步：名单与网站范围',onNew:()=>this.newProject(),open:async id=>{if(this.live())location.hash='integrity?project='+encodeURIComponent(id);}});await this.entry.render();return;}
  this.shell('<p role="status">正在读取诚信核查…</p>','integrity');
  try{const [project,fresh]=await Promise.all([this.api.project(this.id,this.controller.signal),this.read()]);if(this.live()){this.project=project;this.cache=new IntegrityRecoveryCache(this.owner??'',this.id);this.journal=new IntegrityRecoveryJournal(this.owner??'',this.id);this.restore(fresh);this.scanJournal();this.paint();}}
  catch(e){if(this.live())this.shell(`<h1>诚信核查暂时无法打开</h1><p role="alert">${esc(this.error(e,'read'))}</p><a class="btn secondary" href="#integrity">重新选择项目</a>`,'integrity');}
 }
 private header(step:number){return `<a class="back-link" href="#tasks">← 返回全部项目</a><header class="page-head"><div><p class="eyebrow">INTEGRITY CHECK</p><h1>诚信核查</h1><p>按项目准备名单与网站范围，保留查询记录与核查底稿。</p></div></header>${projectFlowSteps(steps,step,'诚信核查流程')}<div class="pf-source-strip pf-project-strip"><div><strong>${esc(this.project!.name)}</strong><small>${esc(this.project!.issuer_name??'')}</small></div><a class="text-button" href="#integrity">更换项目</a><a class="text-button" href="${esc(this.filesHref())}">项目文件 →</a></div>`;}
 private paint(){
  clearTimeout(this.timer);if(!this.live()||!this.state)return;
  const runId=new URLSearchParams(location.hash.split('?')[1]).get('run'),round=this.state.rounds.find(r=>r.run_id===runId);
  if(runId&&!round){this.shell(`${this.header(3)}<p role="alert">本项目没有此核查记录，或记录已超出本页历史范围。</p><a href="${esc(this.href())}">返回名单</a>`,'integrity');return;}
  if(round)this.paintRound(round);else this.paintDraft();
  const main=document.querySelector('main');if(main){const content=document.createElement('div');content.innerHTML=this.recoveryHtml();const anchor=main.querySelector('.pf-project-strip');if(anchor)anchor.after(...content.childNodes);else main.prepend(...content.childNodes);}this.bindRecovery();
  this.status(this.message);
 }
 private paintDraft(){
  for(const subject of this.state!.draft.subjects){const region=inferIntegrityRegion(subject);if(region.province!==subject.province){Object.assign(subject,region);this.changed();}}
  const d=this.state!.draft;
  this.shell(`${this.header(2)}${this.sourceRun?`<p class="integrity-notice">已采用历史名单与网站范围，来源：${esc(this.historyLabel(this.sourceRun))}。请核对后保存；尚未开始新核查。</p>`:""}<fieldset id="integrity-preparation-controls" ${this.locked()?"disabled":""}><legend class="sr-only">名单与网站范围准备</legend><section class="panel integrity-panel integrity-roster-panel"><div class="pf-section-head"><div><h2>核查对象名单 <small id="integrity-subject-count">${d.subjects.length}</small></h2><p>直接在行内编辑企业与人员，保存后可在本项目继续使用。</p></div><div class="integrity-actions"><button class="btn secondary" id="integrity-issuer">带入发行人</button><button class="btn secondary" id="integrity-add">＋ 添加企业</button><button class="btn secondary" id="integrity-person">＋ 添加人员</button></div></div><div class="integrity-roster" id="integrity-roster">${this.subjectRows()}</div><p class="integrity-roster-help">人员识别信息用于内部核对，不会传入公开搜索，底稿仅显示尾号。</p><details class="integrity-batch"><summary>批量添加名单</summary><p>每行一个对象，使用制表符分隔：类型（企业或人员）、名称、关系或职务、身份标识（选填）。最多 100 个对象。</p><label>批量名单<textarea id="integrity-batch" rows="4" placeholder="企业&#9;企业全称&#9;子公司&#10;人员&#9;姓名&#9;董事"></textarea></label><button class="btn secondary" id="integrity-import">添加到名单</button><p id="integrity-batch-status" role="status"></p></details></section>
  <section class="panel integrity-panel integrity-sites-panel">${integritySitePicker(d.site_ids)}
   <div class="integrity-registration"><h3>企业注册地 · 自动识别与匹配</h3><p>优先使用已有注册地；企业名称含明确省份时自动带入，可直接修改。深圳、大连、宁波、厦门、青岛单独匹配。</p><div id="integrity-regions">${this.regionRows()}</div></div>
   <p class="integrity-contact">网站还在持续补充，找不到所需网站？<button class="text-button" id="integrity-contact">联系我们加网站 →</button></p></section>
  <section class="panel integrity-panel"><label>本轮核查说明<textarea id="integrity-notes" rows="3" maxlength="12000" placeholder="选填：补充核查范围与需要关注的事项">${esc(d.notes)}</textarea></label></section><section class="panel integrity-panel"><h2>生成核查底稿文件</h2><p>包含核查汇总、各网站查询记录、取证索引、待办说明与签字页。</p><ul><li>3-1-1 发行人诚信信息汇总清单及查询记录</li><li>1-5-3-4 董事及高级管理人员诚信信息汇总清单及查询记录</li></ul><p>按名单分别生成企业、人员底稿，归档至 4 底稿文件 / 4.3 诚信核查。</p></section><p id="integrity-status" role="status" hidden></p>
  <footer class="pf-footer"><button class="btn secondary" id="integrity-save">保存名单与范围</button><div><span>本轮 <strong>${this.currentPrice()}</strong> · 同轮重新导出免费</span><button class="btn primary" id="integrity-start" ${d.subjects.length&&d.site_ids.length?'':'disabled'}>开始诚信核查</button></div></footer>
  </fieldset>${this.state!.rounds.length?`<section class="panel integrity-panel"><h2>核查历史与底稿</h2>${this.state!.rounds.map(r=>`<a class="integrity-history" href="${esc(this.href({run:r.run_id}))}"><span><strong>${r.operation==='check'?'诚信核查':'核查底稿导出'} · 第 ${r.sequence} 次任务</strong><small>${esc(date(r.created_at))} · ${r.manifest.draft.subjects.length} 个对象 · ${r.manifest.draft.site_ids.length} 个网站</small></span><span>${esc((runStateLabel[r.state as keyof typeof runStateLabel]??r.state))} →</span></a>`).join('')}</section>`:''}`,'integrity');
  document.querySelector('#integrity-add')!.addEventListener('click',()=>this.addSubject('company'));
  document.querySelector('#integrity-person')!.addEventListener('click',()=>this.addSubject('person'));
  document.querySelector('#integrity-issuer')!.addEventListener('click',()=>{const name=this.project!.issuer_name?.trim()??'',existing=d.subjects.find(s=>s.kind==='company'&&(name?s.name.trim()===name:s.role==='发行人'));if(existing){this.subjectField(existing.id,'name')?.focus();this.status('发行人已在名单中，可直接在该行编辑。');return;}this.addSubject('company',name,'发行人');});
  document.querySelector('#integrity-import')!.addEventListener('click',()=>this.importSubjects());
  document.querySelector('#integrity-roster')!.addEventListener('input',e=>{
   const n=e.target;if(!(n instanceof HTMLInputElement||n instanceof HTMLSelectElement)||!n.dataset.subject)return;
   const s=d.subjects.find(s=>s.id===n.dataset.subject);if(!s)return;const field=n.dataset.field;
   if(field==='kind'){if(n.value!=='company'&&n.value!=='person')return;s.kind=n.value;this.changed();this.paintSubjects(s.id,'kind');return;}
   if(field!=='name'&&field!=='role'&&field!=='identifier')return;s[field]=n.value;this.changed();this.subjectError(s.id);
   if(field==='name'){const label=document.getElementById('integrity-region-name-'+s.id);if(label)label.textContent=s.name.trim()||'未填写企业名称';}
  });
  document.querySelector('#integrity-roster')!.addEventListener('focusout',e=>{const n=e.target;if(!(n instanceof HTMLInputElement)||n.dataset.field!=='name')return;const subject=d.subjects.find(s=>s.id===n.dataset.subject);if(!subject||subject.province)return;const region=inferIntegrityRegion(subject);if(region.province){Object.assign(subject,region);this.changed();document.querySelector('#integrity-regions')!.innerHTML=this.regionRows();}});
  document.querySelector('#integrity-roster')!.addEventListener('click',e=>{
   const b=(e.target as Element).closest<HTMLButtonElement>('[data-remove]');if(!b||this.busy)return;const index=d.subjects.findIndex(s=>s.id===b.dataset.remove);if(index<0)return;
   d.subjects.splice(index,1);this.changed();this.paintSubjects(d.subjects[Math.min(index,d.subjects.length-1)]?.id);if(!d.subjects.length)document.querySelector<HTMLButtonElement>('#integrity-add')!.focus();
  });
  bindIntegritySitePicker(()=>d.site_ids,ids=>{d.site_ids=ids;this.changed();this.updateCount();});
  document.querySelector('#integrity-regions')!.addEventListener('input',e=>{const n=e.target;if(!(n instanceof HTMLInputElement||n instanceof HTMLSelectElement)||!n.dataset.region)return;const s=d.subjects.find(s=>s.id===n.dataset.region);if(!s||(n.dataset.field!=='province'&&n.dataset.field!=='city'))return;s[n.dataset.field]=n.value;this.changed();document.getElementById('integrity-region-'+s.id)!.innerHTML=this.regional(s);});
  document.querySelector('#integrity-notes')!.addEventListener('input',e=>{d.notes=(e.target as HTMLTextAreaElement).value;this.changed();});
  document.querySelector('#integrity-save')!.addEventListener('click',()=>{if(this.validateSubjects())void this.act(async()=>{await this.save();this.status('名单与网站范围已保存。');},'save');});
  document.querySelector('#integrity-start')!.addEventListener('click',()=>this.confirmStart());
  document.querySelector('#integrity-contact')!.addEventListener('click',()=>void this.act(async()=>{const a=await this.api.agreement();if(this.live())this.modal('联系我们加网站',`<p>请提供网站名称、官网网址和需要查询的事项。</p><p>${esc(a.support_contact||'请通过账号帮助渠道联系 BondBuddy 服务团队。')}</p>`);},'read'));
 }
 private regional(s:IntegritySubject){return ['local-csrc','local-tax'].map(id=>{const site=resolveIntegritySite(INTEGRITY_SITES.find(s=>s.id===id)!,s);return site.links.length?`<div>${links({...site,links:site.links.map(l=>({...l,label:site.name}))})}</div>`:'<small>待补注册地 / 网站</small>';}).join('');}
 private changed(){if(this.pending)return;this.dirty=true;this.persist();const controls=document.querySelector<HTMLFieldSetElement>('#integrity-preparation-controls');if(controls)controls.disabled=this.locked();}
 private updateCount(){document.querySelector('#integrity-site-count')!.textContent=`（已选 ${this.state!.draft.site_ids.length} 个）`;document.querySelector<HTMLButtonElement>('#integrity-start')!.disabled=!this.state!.draft.subjects.length||!this.state!.draft.site_ids.length;}
 private async save(){if(this.locked())throw new UserFacingError('请先核对未确认的请求或名单版本。');if(!this.validateSubjects())throw new UserFacingError('请先修正名单中标出的内容，或移除不需要的行。');this.state!.draft={...this.state!.draft,subjects:this.state!.draft.subjects.map(s=>({...s,name:s.name.trim(),role:s.role.trim(),identifier:s.identifier.trim()}))};this.pendingDraftMismatch=false;this.pending={kind:'draft',request:{expected_revision:this.state!.revision,draft:structuredClone(this.state!.draft)}};if(!this.persist()){this.paint();throw new UserFacingError(this.problem);}await this.sendPending();if(this.pending)throw new UserFacingError('原名单保存结果尚未确认。');}
 private modal(title:string,body:string){this.dialog?.remove();const d=document.createElement('dialog');d.className='pf-modal integrity-modal';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="关闭">×</button></header>${body}<p role="status"></p>`;document.body.append(d);d.showModal();d.querySelector('[data-close]')!.addEventListener('click',()=>{if(!this.busy)d.close();});d.addEventListener('cancel',e=>{if(this.busy)e.preventDefault();});d.addEventListener('close',()=>d.remove());this.dialog=d;return d;}
 private newProject(){
  const d=this.modal('新建项目',`<form><label>项目名称<input name="name" required maxlength="200"></label><label>发行人全称<input name="issuer_name" required maxlength="200"></label><label>市场<select name="market">${Object.entries(MARKET_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>品种<select name="offering"></select></label><button class="btn primary">创建项目并准备核查</button></form>`);
  const market=d.querySelector<HTMLSelectElement>('[name=market]')!,offering=d.querySelector<HTMLSelectElement>('[name=offering]')!,key=crypto.randomUUID();const sync=()=>{offering.innerHTML=MARKET_OFFERINGS[market.value as keyof typeof MARKET_OFFERINGS].map(v=>`<option value="${v}">${OFFERING_LABELS[v]}</option>`).join('');};sync();market.addEventListener('change',sync);
  d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement);void this.act(async()=>{const p=await this.api.request<Dto<'ProjectResponse'>>('POST','/projects',{creation_request_id:key,kind:'generation',name:f.get('name'),issuer_name:f.get('issuer_name'),market:market.value,offering:offering.value},{},this.controller.signal);if(this.live()){d.close();location.hash='integrity?project='+encodeURIComponent(p.project_id);}},'submit');});
 }
 private subjectRows(){
  return this.state!.draft.subjects.map((s,i)=>`<div class="integrity-subject" data-subject-row="${esc(s.id)}"><span class="integrity-row-number">${String(i+1).padStart(2,'0')}</span>
   <label>对象类型<select data-subject="${esc(s.id)}" data-field="kind" aria-label="对象 ${i+1} 类型"><option value="company" ${s.kind==='company'?'selected':''}>企业</option><option value="person" ${s.kind==='person'?'selected':''}>人员</option></select></label>
   <label>名称 / 姓名<input data-subject="${esc(s.id)}" data-field="name" aria-label="对象 ${i+1} 名称" aria-describedby="integrity-subject-error-${esc(s.id)}" value="${esc(s.name)}" required maxlength="200" placeholder="填写完整名称"></label>
   <label>关系 / 职务<input data-subject="${esc(s.id)}" data-field="role" aria-label="对象 ${i+1} 关系" value="${esc(s.role)}" maxlength="200" placeholder="如发行人、董事"></label>
   <label>${s.kind==='company'?'统一社会信用代码':'识别信息'} <span class="muted">选填</span><input data-subject="${esc(s.id)}" data-field="identifier" aria-label="对象 ${i+1} 识别信息" aria-describedby="integrity-subject-error-${esc(s.id)}" value="${esc(s.identifier)}" maxlength="${s.kind==='company'?18:200}" placeholder="${s.kind==='company'?'18 位信用代码':'任职公司等消歧信息'}"></label>
   <button type="button" class="icon-btn" data-remove="${esc(s.id)}" aria-label="移除对象 ${i+1}" title="移除此行">×</button><p class="integrity-subject-error" id="integrity-subject-error-${esc(s.id)}" role="alert" hidden></p></div>`).join('')||'<div class="collection-empty"><h3>添加本轮需要核查的对象</h3><p>可先带入发行人，再补充相关企业与人员。</p></div>';
 }
 private regionRows(){return this.state!.draft.subjects.filter(s=>s.kind==='company').map(s=>`<div class="integrity-region"><strong id="integrity-region-name-${esc(s.id)}">${esc(s.name.trim()||'未填写企业名称')}</strong><label>省 / 自治区 / 直辖市<select data-region="${esc(s.id)}" data-field="province">${provinces(s.province)}</select></label><label>城市<input data-region="${esc(s.id)}" data-field="city" value="${esc(s.city)}" placeholder="如：深圳市" maxlength="60"></label><div id="integrity-region-${esc(s.id)}">${this.regional(s)}</div></div>`).join('')||'<p>添加企业后在这里填写注册地。</p>';}
 private subjectField(id:string,field:string){return document.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-subject="${CSS.escape(id)}"][data-field="${field}"]`);}
 private paintSubjects(focusId?:string,field='name'){
  // Replace only the roster and registration rows: pending batch text, notes and scope stay intact.
  document.querySelector('#integrity-roster')!.innerHTML=this.subjectRows();document.querySelector('#integrity-regions')!.innerHTML=this.regionRows();document.querySelector('#integrity-subject-count')!.textContent=String(this.state!.draft.subjects.length);this.updateCount();
  if(focusId)this.subjectField(focusId,field)?.focus();
 }
 private addSubject(kind:IntegritySubject['kind'],name='',role=''){
  if(this.busy)return;if(this.state!.draft.subjects.length>=100){this.status('每轮最多 100 个对象。');return;}
  const s={id:crypto.randomUUID(),kind,name,role,identifier:'',province:'',city:''};Object.assign(s,inferIntegrityRegion(s));this.state!.draft.subjects.push(s);this.changed();this.paintSubjects(s.id);
 }
 private subjectError(id:string,message='',field='name'){
  const error=document.getElementById('integrity-subject-error-'+id);if(error){error.textContent=message;error.hidden=!message;}
  for(const name of ['name','identifier']){const input=this.subjectField(id,name);if(message&&name===field)input?.setAttribute('aria-invalid','true');else input?.removeAttribute('aria-invalid');}
 }
 private validateSubjects(){
  const seen=new Map<string,number>();let first:HTMLInputElement|HTMLSelectElement|undefined;
  for(const [i,s] of this.state!.draft.subjects.entries()){
   const key=JSON.stringify([s.kind,s.name.trim(),s.identifier.trim()]);let error='',field='name';
   if(!s.name.trim())error='请填写名称 / 姓名，或移除此行。';
   else if(s.kind==='company'&&s.identifier.trim()&&!/^[0-9A-Z]{18}$/.test(s.identifier.trim())){error='统一社会信用代码应为 18 位大写字母或数字，也可暂不填写。';field='identifier';}
   else if(seen.has(key))error=`与第 ${seen.get(key)!+1} 行重复，请核对名称和识别信息，或移除重复行。`;
   seen.set(key,i);this.subjectError(s.id,error,field);if(error&&!first)first=this.subjectField(s.id,field)??undefined;
  }
  if(first){first.focus();this.status('请先修正名单中标出的内容，或移除不需要的行。');return false;}return true;
 }
 private importSubjects(){
  const input=document.querySelector<HTMLTextAreaElement>('#integrity-batch')!,status=document.querySelector('#integrity-batch-status')!,existing=this.state!.draft.subjects;
  const rows=input.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),added:IntegritySubject[]=[];
  if(!rows.length){status.textContent='请先粘贴名单。';return;}
  if(existing.length+rows.length>100){status.textContent='每轮最多 100 个对象，请减少名单后重试。';return;}
  for(const [index,line] of rows.entries()){
   const [type,name='',role='',identifier='',...extra]=line.split('\t').map(s=>s.trim()),kind=type==='企业'?'company':['人员','个人'].includes(type)?'person':null;
   if(!kind||!name||extra.length||[name,role,identifier].some(s=>s.length>200)||(kind==='company'&&identifier&&!/^[0-9A-Z]{18}$/.test(identifier))){status.textContent=`第 ${index+1} 行格式不正确，请按“类型、名称、关系、身份标识”四列核对。`;return;}
   if([...existing,...added].some(s=>s.kind===kind&&s.name===name&&s.identifier===identifier)){status.textContent=`第 ${index+1} 行与已有对象重复，请核对名称和身份标识。`;return;}
   added.push({id:crypto.randomUUID(),kind,name,role,identifier,province:'',city:''});
  }
  existing.push(...added);this.changed();input.value='';status.textContent=`已添加 ${added.length} 个对象，请核对名单后保存。`;this.paintSubjects(added[0]?.id);this.status(status.textContent);
 }
 private confirmStart(){
  if(this.busy||this.locked()||!this.validateSubjects())return;
  void this.act(async()=>{
   await this.save();if(!this.live()||this.locked())return;
   const revision=this.state!.revision,draft=structuredClone(this.state!.draft),commercial=isCnyPrice(this.state!.price);
   const quote=commercial?await this.request<Dto<'IntegrityQuoteResponse'>>('POST','/quote',{expected_revision:revision}):undefined;
   if(!this.live()||this.state!.revision!==revision||canonical(this.state!.draft)!==canonical(draft))throw new ApiError(409,'QUOTE_CHANGED');
   if(quote&&!scopeReady(quote)){const pending=this.modal('本次范围报价待确认','<p>本次范围报价待确认，尚未收费。主体名单、网站范围和要求保留；待核实工作项后确认总价。</p><button class="btn primary" id="integrity-refresh-scope">刷新范围报价</button>');pending.querySelector('#integrity-refresh-scope')!.addEventListener('click',()=>{pending.close();this.confirmStart();});return;}
   const price=quote??this.state!.price,points=quote?.points??this.state!.price.points,priceVersion=quote?.price_version??this.state!.price.version,total=displayPrice(price,points);
   const d=this.modal('开始本轮诚信核查',`${this.summary(draft)}<p>本轮费用 <strong>${total}</strong>，开始时预留，底稿交付后结算。未完成交付将释放预留。</p>${scopeLinesHtml(price)}<p>新轮重新查询全部所列对象和网站，不沿用旧查询时间、结论或人工证据。部分网站受限仍可能交付并收取本轮费用；注册地缺失与人员不适用项会如实记录。同轮重新导出免费。</p><button class="btn primary" id="integrity-confirm">确认并开始 · ${total}</button>`);
   d.querySelector('#integrity-confirm')!.addEventListener('click',()=>void this.act(async()=>{
    if(this.state!.revision!==revision||canonical(this.state!.draft)!==canonical(draft))throw new ApiError(409,'QUOTE_CHANGED');
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode([this.owner,this.id,revision].join('\0'))),request_id='integrity-check-'+[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
    this.pending={kind:'check',...(commercial?{price:copyCommercePrice(price)}:{}),request:{request_id,expected_revision:revision,price_version:priceVersion,expected_points:points,...(quote?.scope_quote_id?{scope_quote_id:quote.scope_quote_id}:{})}};await this.sendPending();
   },'submit'));
  },'save');
 }
 private paintRound(r:IntegrityRound){
  const done=terminal.has(r.state),work=integrityWorkItems(r),bound=integrityRoundFor(r,this.state!.rounds),writable=!bound.error&&!bound.originalMissing&&!work.error&&!this.locked();
  const pending=work.items.filter(i=>i.pending),total=work.items.length,attached=work.items.filter(i=>i.pending&&i.evidence.length).length,included=r.manifest.evidence_ids.length,newEvidence=r.evidence.length-included;
  if(this.openedRound!==r.run_id){this.openedRound=r.run_id;this.expanded=new Set(r.manifest.draft.subjects.slice(0,1).map(s=>s.id));}
  this.shell(`${this.header(3)}<section class="panel integrity-panel"><div class="pf-section-head"><div><h2>${r.operation==='export'?'核查底稿导出':'本轮诚信核查'} · ${esc(runStateLabel[r.state as keyof typeof runStateLabel]??r.state)}</h2><p>${esc(date(r.created_at))} · ${r.manifest.draft.subjects.length} 个对象 · ${r.manifest.draft.site_ids.length} 个网站</p></div><div class="integrity-actions">${r.artifacts.map(a=>`<button class="btn primary" data-integrity-download="${esc(a.artifact_id)}">下载${a.kind==='company'?'企业':'人员'}核查底稿</button>`).join('')}<a class="btn secondary" href="${esc(this.href())}">返回名单与历史</a></div></div><p id="integrity-status" role="status" hidden></p><p>${r.charged_points?`本轮已结算 ${isCnyPrice(r.manifest)?cny(r.charged_points):r.charged_points.toLocaleString()+' 积分'}`:r.reserved_points?`已预留 ${isCnyPrice(r.manifest)?cny(r.reserved_points):r.reserved_points.toLocaleString()+' 积分'}，交付后结算`:r.operation==='export'?'同轮重新导出 · 包含在原任务内':'本轮未结算费用'}</p>
   ${bound.error||work.error?`<p role="alert">${esc(bound.error??work.error)}</p>`:''}${bound.originalMissing?`<p role="alert">原核查轮不在当前历史范围，请先打开原轮核对后查看或导出。</p><a href="${esc(this.href({run:r.round_id}))}">打开原核查轮 →</a>`:''}
   <div class="integrity-progress"><progress value="${work.items.filter(i=>i.record).length}" max="${total||1}"></progress><span>${work.items.filter(i=>i.record).length} / ${total} 项已有原查询记录 · ${pending.length} 项原查询待核实</span></div><p class="muted">人工证据不覆盖原查询状态，也不代表事项已解决。${attached} 项待核实事项已附人工证据；结论仍需人工核对。</p><p>${included} 份人工证据已进入此版底稿 · ${Math.max(0,newEvidence)} 份新增证据尚未包含。${newEvidence>0?'免费重新导出后可生成包含新增证据的版本。':''}</p>
   <div class="integrity-actions">${!done?`<button class="btn secondary" data-run-action="${r.state==='paused'||r.state==='awaiting_input'?'resume':'pause'}" ${this.locked()?'disabled':''}>${r.state==='paused'||r.state==='awaiting_input'?'继续任务':'暂停任务'}</button><button class="text-button" data-run-action="cancel" ${this.locked()?'disabled':''}>停止本轮</button>`:''}${done?`<button class="btn secondary" id="integrity-export" ${writable?'':'disabled'}>重新导出底稿 · 免费</button>`:''}<button class="btn secondary" id="integrity-use-round" ${writable?'':'disabled'}>采用此轮名单准备新核查</button></div><p class="muted">查看和导出沿用本轮记录，不重新查询。采用名单后可修改准备内容，新核查仍需单独确认本次范围与费用。</p>${['failed','cancelled'].includes(r.state)?'<p role="alert">本轮未完成交付，预留费用会释放。已有记录仍保留，可免费导出。</p>':''}</section>
   <section class="integrity-workbar"><label>查看事项<select id="integrity-filter"><option value="all" ${this.filter==='all'?'selected':''}>全部 ${total} 项</option><option value="pending" ${this.filter==='pending'?'selected':''}>原查询待核实 ${pending.length} 项</option></select></label><button class="btn secondary" id="integrity-next-pending" ${pending.length?'':'disabled'}>下一项未完成查询</button>${this.evidenceDraft&&!this.pending?'<button class="text-button" id="integrity-resume-evidence">继续未保存的补证</button>':''}</section>
   <div id="integrity-records">${r.manifest.draft.subjects.map((s,index)=>{const items=work.items.filter(i=>i.subject.id===s.id&&(this.filter!=='pending'||i.pending));if(!items.length)return '';return `<details class="panel integrity-query" data-integrity-subject="${esc(s.id)}" ${this.expanded.has(s.id)?'open':''}><summary><strong>${esc(s.name)}</strong><span>${s.kind==='company'?'企业':'人员'} · ${esc(s.role||'角色待补充')}</span></summary><div class="integrity-table-wrap"><table><thead><tr><th>核查网站 / 查询条件</th><th>查询状态</th><th>取证记录</th></tr></thead><tbody>${items.map(item=>{const site=resolveIntegritySite(INTEGRITY_SITES.find(x=>x.id===item.siteId)!,s),record=item.record;return `<tr><td><strong>${esc(site.name)}</strong><small>${esc(s.name)}</small>${links(site)}</td><td>${record?statusChip(integrityRecordPresentation(record)):`<span class="pf-chip">${s.kind==='person'&&site.companyOnly?'网站仅适用企业 · 无查询记录':done?'未执行':'等待查询'}</span>`}<small>${esc(record?integrityRecordPresentation(record).description:'本轮尚无该项查询记录。')}</small></td><td>${record?.browser?.captures.length?`<small>${record.browser.captures.length} 张官网截图</small>`:''}${record?.sources.length?`<small>${record.sources.length} 条公开来源</small>`:''}<small>${item.evidence.length} 份人工证据（未独立核验）</small>${this.evidenceDraft?.uploadOperationId&&!this.evidenceDraft.material&&sameIntegrityUploadPair(this.evidenceDraft,{roundId:r.round_id,subjectId:s.id,siteId:item.siteId})?'<small>原文件上传尚待确认</small>':''}<small>此版已包含 ${item.includedEvidenceCount} 份 · 新增 ${item.newEvidenceCount} 份</small><button class="text-button" data-evidence="${index}:${item.siteId}">查看查询记录</button></td></tr>`;}).join('')}</tbody></table></div></details>`;}).join('')||'<p class="panel integrity-panel">当前筛选下没有待处理事项。</p>'}</div>`,'integrity');
  document.querySelectorAll<HTMLDetailsElement>('[data-integrity-subject]').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)this.expanded.add(d.dataset.integritySubject!);else this.expanded.delete(d.dataset.integritySubject!);}));
  document.querySelector<HTMLSelectElement>('#integrity-filter')!.addEventListener('change',e=>{this.filter=(e.target as HTMLSelectElement).value;this.paint();});
  document.querySelector('#integrity-next-pending')!.addEventListener('click',()=>{const eligible=pending.filter(i=>!(i.subject.kind==='person'&&INTEGRITY_SITES.find(s=>s.id===i.siteId)?.companyOnly)),index=eligible.findIndex(i=>i.key===this.focusPair),next=eligible[(index+1)%eligible.length];if(next){this.expanded.add(next.subject.id);this.evidenceModal(r,next.subject,next.siteId);}});
  document.querySelector('#integrity-resume-evidence')?.addEventListener('click',()=>{const f=this.evidenceDraft!,source=this.state!.rounds.find(x=>x.run_id===f.roundId&&x.operation==='check'),subject=source?.manifest.draft.subjects.find(s=>s.id===f.subjectId);if(source&&subject)this.resumeEvidenceModal(source,subject,f.siteId);else this.status('未找到原核查轮，请打开原轮继续补证。');});
  document.querySelectorAll<HTMLButtonElement>('[data-integrity-download]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
   const matches=r.artifacts.filter(pin=>pin.artifact_id===b.dataset.integrityDownload);
   if(matches.length!==1)throw new UserFacingError('所选底稿的任务或版本无法核实，未下载。请重新读取本轮底稿后再试。');
   const expected=matches[0],a=await this.api.artifact(expected.artifact_id,this.controller.signal);
   if(a.artifact_id!==expected.artifact_id||a.version!==expected.artifact_version||a.run_id!==r.run_id)throw new UserFacingError('所选底稿的任务或版本无法核实，未下载。请重新读取本轮底稿后再试。');
   const bytes=await this.api.artifactBytes(a,this.controller.signal);if(this.live()){this.downloads.save(bytes,artifactFilename(a));this.status('底稿已交给浏览器下载。');}
  },'download')));
  document.querySelectorAll<HTMLButtonElement>('[data-run-action]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{if(this.locked())return;await this.api.runAction(r.run_id,b.dataset.runAction as 'pause'|'resume'|'cancel',this.controller.signal);await this.refresh();})));
  document.querySelector('#integrity-use-round')?.addEventListener('click',()=>{if(!writable)return;const d=this.modal('采用此轮名单准备新核查',`${this.summary(r.manifest.draft)}<p>将替换当前准备名单、网站范围和说明，原核查记录及底稿保留。采用只保存到本机，不查询网站。新一轮仍需确认本次范围与费用。</p>${this.dirty?'<details><summary>当前尚未保存的名单将被替换</summary>'+this.summary(this.state!.draft)+'</details>':''}<button class="btn primary" id="integrity-adopt-confirm">采用到本轮准备</button>`);d.querySelector('#integrity-adopt-confirm')!.addEventListener('click',()=>{this.state!.draft=structuredClone(r.manifest.draft);this.sourceRun=r.run_id;this.dirty=true;if(this.persist()){d.close();location.hash=this.href();}else d.querySelector('[role=status]')!.textContent=this.problem;});});
  document.querySelector('#integrity-export')?.addEventListener('click',()=>{if(!writable||!bound.original||!terminal.has(bound.original.state))return;const evidenceIds=bound.original.evidence.map(e=>e.id),d=this.modal('免费重新导出本轮底稿',`<p>沿用原核查轮的完整名单和查询记录，包含当前 ${evidenceIds.length} 份人工证据。本次导出包含在原任务内，不重新查询官网，旧版底稿仍保留。</p><p>企业、人员分别生成底稿；PDF / Word 原件列入证据索引，不合并正文。</p><button class="btn primary" id="integrity-export-free-confirm">确认导出新版本 · 免费</button>`);d.querySelector('#integrity-export-free-confirm')!.addEventListener('click',()=>void this.act(async()=>{this.pending={kind:'export',roundId:bound.roundId!,request:{request_id:crypto.randomUUID(),expected_evidence_ids:evidenceIds}};await this.sendPending();},'submit'));});
  document.querySelectorAll<HTMLButtonElement>('[data-evidence]').forEach(b=>b.addEventListener('click',()=>{const [index,siteId]=b.dataset.evidence!.split(':');this.evidenceModal(r,r.manifest.draft.subjects[Number(index)],siteId);}));
  if(!done)this.poll();
 }
 private poll(){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.live())return;if(this.dialog?.open||this.busy)this.poll();else void this.refresh();},3000);}
 private async refresh(){try{const fresh=await this.read();if(this.live()){this.server=structuredClone(fresh);this.state!.rounds=fresh.rounds;const y=scrollY;this.paint();window.scrollTo(0,y);}}catch(e){if(this.live()){this.status(this.error(e,'read'));this.poll();}}}
 private evidenceModal(r:IntegrityRound,s:IntegritySubject,siteId:string){
  const work=integrityWorkItems(r);if(work.error){this.status(work.error);return;}
  const item=work.items.find(x=>x.subject.id===s.id&&x.siteId===siteId);
  const site=resolveIntegritySite(INTEGRITY_SITES.find(x=>x.id===siteId)!,s),record=item?.record,evidence=item?.evidence??[];
  this.focusPair=JSON.stringify([s.id,siteId]);this.expanded.add(s.id);
  const view=record?integrityRecordPresentation(record):undefined;
  const d=this.modal(`${s.name} · ${site.name}`,`<p>${links(site)}</p>${view?statusChip(view):''}<p class="integrity-result-description">${esc(record?.findings?.length?'具体事项、主体匹配情况及官网原文如下。':view?.description??'尚无查询记录。')}</p>${record?`<p>查询时间：${esc(date(record.checked_at))}</p><p>实际查询：${esc(record.query||'未记录')}</p>`:''}${record?.findings?.map(f=>{const source=record.sources.find(s=>s.tool_call_id===f.capture_id&&s.quote===f.quote);return `<article class="integrity-finding"><h3>${esc(f.title)}</h3><small>${esc(integrityFindingLabel(f))}</small><p>${esc(f.explanation)}</p><blockquote><p>${esc(f.quote)}</p>${source?`<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title||'官网记录')} ↗</a><small>${esc(date(source.retrieved_at))}</small>`:''}</blockquote></article>`;}).join('')??''}${(record?.findings?.length?[]:record?.sources)?.map(source=>`<blockquote><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a><p>${esc(source.quote)}</p><small>${esc(date(source.retrieved_at))} · 公开来源，需核对主体与事项</small></blockquote>`).join('')??''}<div data-auto-evidence></div>${evidence.length?`<h3>历史补充证据</h3>${evidence.map((e,i)=>`<div class="integrity-evidence"><strong>${e.conclusion==='records_found'?'发现记录':e.conclusion==='no_records'?'该次查询未发现记录':'仍待核实'}（用户提交）</strong><p>${esc(e.note)}</p><small>${esc(date(e.queried_at))}</small><button class="text-button" data-download-evidence="${i}">下载原始证据</button></div>`).join('')}`:''}`);
  mountIntegrityBrowserEvidence(d,record,this.api,this.id!,r.round_id,this.controller.signal);
  d.querySelectorAll<HTMLButtonElement>('[data-download-evidence]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{const pin=evidence[Number(b.dataset.downloadEvidence)].material,m=await this.api.material(this.id!,pin.material_id,this.controller.signal,pin.material_version);if(!Value.Check(schemas.MaterialResponse,m)||m.material_id!==pin.material_id||m.sha256!==pin.sha256||m.material_version!==pin.material_version)throw new UserFacingError('证据内容已变化，请刷新后核对。');const bytes=await this.api.materialBytes(this.id!,m,this.controller.signal);if(this.live())this.downloads.save(bytes,m.filename);} )));
 }
 private resumeEvidenceModal(r:IntegrityRound,s:IntegritySubject,siteId:string){
  // Complete only a form already retained before the upload entry was removed.
  if(!this.evidenceDraft||!sameIntegrityUploadPair(this.evidenceDraft,{roundId:r.round_id,subjectId:s.id,siteId})){this.status('未找到本事项已保留的旧补证草稿。');return;}
  const bound=integrityRoundFor(r,this.state!.rounds),work=integrityWorkItems(r),item=work.items.find(i=>i.subject.id===s.id&&i.siteId===siteId);if(bound.error||work.error||!item){this.status(bound.error??work.error??'未找到对应事项。');return;}
  const site=resolveIntegritySite(INTEGRITY_SITES.find(x=>x.id===siteId)!,s),record=item.record,evidence=item.evidence,applicable=!(s.kind==='person'&&site.companyOnly),editable=applicable&&!bound.originalMissing&&!this.locked();
  this.focusPair=item.key;this.expanded.add(s.id);
  const old=this.evidenceDraft,matching=old&&old.roundId===r.round_id&&old.subjectId===s.id&&old.siteId===siteId;
  if(old?.uploadOperationId&&!old.material&&!matching){this.status('另一项补证的原文件尚待确认，请先继续未保存的补证，或明确停止跟踪原上传。');return;}
  const form:IntegrityEvidenceDraft=matching?structuredClone(old):{roundId:r.round_id,subjectId:s.id,siteId,url:site.links[0]?.url??'',time:'',note:'',conclusion:'unresolved',...(siteId.startsWith('local-')?{registration:{province:s.province,city:s.city}}:{})};
  if(this.selectedFile&&this.selectedFile.key!==JSON.stringify([r.round_id,s.id,siteId])){this.status('另一项补证的文件尚未上传，请先继续未保存的补证。');return;}
  const d=this.modal(`${s.name} · ${site.name}`,`<p>${links(site)}</p><p>${esc(record?.reason??'尚无查询记录。')}</p>${record?`<p>原查询时间：${esc(date(record.checked_at))}</p><p>实际查询：${esc(record.query||'未记录')}</p>`:''}${record?.sources.map(source=>`<blockquote><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a><p>${esc(source.quote)}</p><small>${esc(date(source.retrieved_at))} · 公开来源，需核对主体与事项</small></blockquote>`).join('')??''}<h3>人工补充证据</h3>${evidence.map((e,i)=>`<div class="integrity-evidence"><strong>${e.conclusion==='records_found'?'发现记录':e.conclusion==='no_records'?'该次查询未发现记录':'仍待核实'}（用户提交）</strong><p>${esc(e.note)}</p><small>${esc(date(e.queried_at))} · ${r.manifest.evidence_ids.includes(e.id)?'已包含在此版底稿':'尚未包含在此版底稿'}</small><button class="text-button" data-download-evidence="${i}">下载原始证据</button></div>`).join('')||'<p class="muted">尚无人工证据。补证不覆盖原查询记录。</p>'}
   ${editable?`<form id="integrity-evidence-form"><label>实际查询网址<input name="url" type="url" required value="${esc(form.url)}" maxlength="4096"></label>${form.registration?`<div class="integrity-form-grid"><label>证据对应省份<select name="province">${provinces(form.registration.province)}</select></label><label>证据对应城市<input name="city" value="${esc(form.registration.city)}" maxlength="60"></label></div>`:''}<label>实际查询时间<input name="time" type="datetime-local" required value="${esc(form.time)}"></label><label>查询结果<select name="conclusion">${[['unresolved','仍待核实'],['records_found','发现记录'],['no_records','该次查询未发现记录']].map(([v,label])=>`<option value="${v}" ${form.conclusion===v?'selected':''}>${label}</option>`).join('')}</select></label><label>证据说明<textarea name="note" required maxlength="12000" rows="3" placeholder="写明查询条件、身份匹配和结论依据">${esc(form.note)}</textarea></label><label>从本项目已上传文件选择<select id="integrity-existing-materials"><option value="">正在读取文件…</option></select></label><label>或上传新的查询截图 / 原始证据<input name="file" type="file" accept=".png,.jpg,.jpeg,.pdf,.docx"></label><p id="integrity-selected-evidence">${form.material?'已保留材料 '+esc(form.material.material_id)+' · 版本 '+form.material.material_version:''}</p><div id="integrity-upload-recovery"></div><p class="muted">图片会显示在底稿；PDF / Word 保留原件并列入证据索引，不合并正文。最大 100 MB，人工提交内容仍需核验。保存免费，不会自动导出或查询。</p><button class="btn primary" id="integrity-evidence-save">保存补充证据 · 免费</button></form>`:!applicable?'<p>此网站仅适用企业，不为人员添加补证。</p>':'<p>请先核对原核查轮或未确认请求，再补充证据。</p>'}`);
  mountIntegrityBrowserEvidence(d,record,this.api,this.id!,r.round_id,this.controller.signal);
  d.querySelectorAll<HTMLButtonElement>('[data-download-evidence]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{const pin=evidence[Number(b.dataset.downloadEvidence)].material,m=await this.api.material(this.id!,pin.material_id,this.controller.signal,pin.material_version);if(!Value.Check(schemas.MaterialResponse,m)||m.material_id!==pin.material_id||m.sha256!==pin.sha256||m.material_version!==pin.material_version)throw new UserFacingError('证据内容已变化，请刷新后核对。');const bytes=await this.api.materialBytes(this.id!,m,this.controller.signal);if(this.live())this.downloads.save(bytes,m.filename);} ,'download')));
  if(!editable)return;
  const collect=()=>{const value=(name:string)=>d.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('[name='+name+']')!.value;form.url=value('url');form.time=value('time');form.note=value('note');form.conclusion=value('conclusion') as IntegrityManual['conclusion'];if(form.registration)form.registration={province:value('province'),city:value('city')};this.evidenceDraft=structuredClone(form);return this.persist();};
  d.querySelector('form')!.addEventListener('input',()=>{collect();});
  let files:Dto<'ProjectFilesResponse'>['items']=[];
  const select=d.querySelector<HTMLSelectElement>('#integrity-existing-materials')!;
  void this.api.projectFiles(this.id!,this.controller.signal).then(result=>{if(!this.live()||!d.open)return;if(!Value.Check(schemas.ProjectFilesResponse,result)||result.project_id!==this.id)throw new UserFacingError('文件清单无法核实。');files=result.items.filter(f=>f.project_id===this.id&&f.source==='material'&&/\.(png|jpe?g|pdf|docx)$/i.test(f.filename));select.innerHTML='<option value="">选择本项目文件（不重新上传）</option>'+files.map((f,i)=>`<option value="${i}">${esc(f.filename)} · 版本 ${f.version}</option>`).join('');const index=files.findIndex(f=>form.material&&f.file_id===form.material.material_id&&f.version===form.material.material_version&&f.sha256===form.material.sha256);if(index>=0)select.value=String(index);}).catch(e=>{if(d.open){select.innerHTML='<option value="">文件读取失败，可重开或上传新文件</option>';d.querySelector('[role=status]')!.textContent=this.error(e,'read');}});
  const fileInput=d.querySelector<HTMLInputElement>('[name=file]')!,saveButton=d.querySelector<HTMLButtonElement>('#integrity-evidence-save')!;
  const uploadStatus=(text:string)=>{d.querySelector('[role=status]')!.textContent=text;};
  const runUpload=(fn:()=>Promise<void>)=>this.act(fn,'save').finally(()=>{if(this.live()&&d.isConnected)paintUpload();});
  const paintUpload=()=>{
   const host=d.querySelector<HTMLElement>('#integrity-upload-recovery')!;
   d.querySelector('#integrity-selected-evidence')!.textContent=form.material?`文件已保存 · 材料版本 ${form.material.material_version}。核对后保存补充证据。`:'';
   saveButton.disabled=!!form.uploadOperationId&&!form.material;select.disabled=!!form.uploadOperationId&&!form.material;
   if(!form.uploadOperationId){
    try{
     const orphaned=this.uploads().list().filter(record=>sameIntegrityUploadPair(integrityUploadPair(record),form));
     if(!orphaned.length){host.replaceChildren();return;}
     if(!form.material)saveButton.disabled=true;
     host.innerHTML=orphaned.map(record=>`<div class="integrity-notice"><strong>${esc(record.declaration.filename)}</strong><p>此文件的待处理记录与当前补证表单未关联。原表单未恢复，也不会采用文件。可移除本机记录，再重新选择文件。</p><button type="button" class="text-button" data-integrity-stop-orphan="${esc(record.id)}">移除本机待处理记录</button></div>`).join('');
     host.querySelectorAll<HTMLButtonElement>('[data-integrity-stop-orphan]').forEach(button=>button.addEventListener('click',()=>void runUpload(async()=>{
      if(this.locked()||!collect())throw new UserFacingError(this.problem||'请先核对原补证记录。');
      const recovery=this.uploads(),id=button.dataset.integrityStopOrphan!,record=recovery.list().find(record=>record.id===id);
      if(record&&!sameIntegrityUploadPair(integrityUploadPair(record),form))throw new UserFacingError('原上传所属事项已变化，请重新读取。');
      await recovery.forget(id);if(!this.live()||!this.cacheMatches())throw new UserFacingError('本机准备已在其他页面变化，请重新读取。');
      this.selectedFile=undefined;fileInput.value='';paintUpload();uploadStatus('已移除本机待处理记录。服务器此前保存的文件保留；如需上传，请重新选择文件。');
     })));
    }catch(error){host.innerHTML=`<p role="alert">${esc(this.error(error,'read'))}</p>`;if(!form.material)saveButton.disabled=true;}
    return;
   }
   if(form.material){host.replaceChildren();return;}
   let name='原文件',problem='';
   try{name=integrityUploadRecord(this.uploads(),form).declaration.filename;}catch(error){problem=this.error(error,'read');}
   host.innerHTML=`<div class="integrity-notice"><strong>${esc(name)}</strong><p>先确认文件是否已保存；如需重新上传，再选择同一份文件。确认后返回本项补证，保存证据仍需单独点击。</p>${problem?`<p role="alert">${esc(problem)}</p>`:''}<button type="button" class="btn secondary" id="integrity-confirm-upload">确认原上传</button><button type="button" class="text-button" id="integrity-stop-upload">停止跟踪原上传</button></div>`;
   host.querySelector('#integrity-confirm-upload')!.addEventListener('click',()=>void runUpload(async()=>{await transfer(fileInput.files?.[0]??this.selectedFile?.file);uploadStatus('原文件已确认并保留到此项补证。请核对实际查询时间、说明和结论，再点击“保存补充证据”。');}));
   host.querySelector('#integrity-stop-upload')!.addEventListener('click',()=>void runUpload(async()=>{
    if(this.locked()||!collect())throw new UserFacingError(this.problem||'请先核对原补证记录。');
    await this.uploads().forget(form.uploadOperationId!);
    if(!this.live()||!this.cacheMatches())throw new UserFacingError('本机准备已在其他页面变化，请重新读取。');
    delete form.uploadOperationId;this.selectedFile=undefined;fileInput.value='';if(!collect())throw new UserFacingError(this.problem);paintUpload();uploadStatus('已移除本机待处理记录。服务器此前收到或保存的文件保留，此操作不删除材料或证据。');
   }));
  };
  const transfer=async(file?:File)=>{
   if(this.locked()||!collect())throw new UserFacingError(this.problem||'请先核对原补证记录。');
   const current=()=>this.live()&&d.isConnected&&d.open&&this.cacheMatches()&&!this.locked()&&!!this.evidenceDraft&&sameIntegrityUploadPair(this.evidenceDraft,form);
   const recovery=this.uploads();
   try{
    if(!form.uploadOperationId){
     if(!file)throw new UserFacingError('请选择本项目文件，或上传新的证据。');
     if(recovery.list().some(record=>sameIntegrityUploadPair(integrityUploadPair(record),form)))throw new UserFacingError('本事项仍有原上传记录，请先核对原记录，不能另建上传。');
     const record=await beginIntegrityUpload(recovery,form,file,this.controller.signal,current);
     form.uploadOperationId=record.id;if(!collect())throw new UserFacingError(this.problem);
    }
    const original=integrityUploadRecord(recovery,form),operationId=original.id;
    const material=await recovery.resume(operationId,{file,signal:this.controller.signal,status:message=>uploadStatus(message.includes('会话')?'正在准备保存原文件…':message.includes('原上传')?'正在确认文件是否已保存…':message),progress:(loaded,total)=>uploadStatus(loaded>=total?'文件传输完成，正在确认保存…':`正在上传 ${Math.floor(loaded/total*100)}%…`)});
    this.controller.signal.throwIfAborted();if(!current()||form.uploadOperationId!==operationId||this.evidenceDraft?.uploadOperationId!==operationId)throw new UserFacingError('原补证记录已变化，材料尚未写入本页。请重新读取并核对。');
    form.material={source_project_id:this.id!,material_id:material.material_id,material_version:material.material_version,sha256:material.sha256};
    this.selectedFile=undefined;fileInput.value='';if(!collect())throw new UserFacingError(this.problem);
    // First retain the exact pin in the original CAS form; cleanup proves no business result.
    await recovery.forget(operationId);
   }finally{if(this.live()&&d.isConnected)paintUpload();}
  };
  select.addEventListener('change',()=>{
   if(form.uploadOperationId&&!form.material){uploadStatus('请先确认原上传，或明确停止跟踪，再改选材料。');return;}
   const selected=files[Number(select.value)];
   if(select.value!==''&&selected){this.selectedFile=undefined;delete form.uploadOperationId;form.material={source_project_id:this.id!,material_id:selected.file_id,material_version:selected.version,sha256:selected.sha256};fileInput.value='';}else delete form.material;
   collect();paintUpload();d.querySelector('#integrity-selected-evidence')!.textContent=form.material?'已选择材料版本 '+form.material.material_version:'';
  });
  fileInput.addEventListener('change',()=>{
   const file=fileInput.files?.[0];this.selectedFile=file?{key:JSON.stringify([r.round_id,s.id,siteId]),file}:undefined;
   if(form.material)delete form.uploadOperationId;delete form.material;select.value='';collect();paintUpload();
  });
  paintUpload();
  d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();void runUpload(async()=>{
   if(this.locked()||!collect()){uploadStatus(this.problem||'请先核对原请求。');return;}
   if(!form.material){
    if(form.uploadOperationId)throw new UserFacingError('请先点击“确认原上传”，核对文件后再保存本项补证。');
    const file=fileInput.files?.[0]??(this.selectedFile?.key===JSON.stringify([r.round_id,s.id,siteId])?this.selectedFile.file:undefined);
    await transfer(file);if(!this.live())return;
   }
   const pin=form.material!,material=await this.api.material(this.id!,pin.material_id,this.controller.signal,pin.material_version);
   if(!Value.Check(schemas.MaterialResponse,material)||material.material_id!==pin.material_id||material.material_version!==pin.material_version||material.sha256!==pin.sha256||!['image/png','image/jpeg','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(material.media_type))throw new UserFacingError('所选证据的版本或内容已变化，请重新核对。');
   this.controller.signal.throwIfAborted();if(!this.live()||!this.cacheMatches()||this.locked())throw new UserFacingError('原补证记录已变化，请重新读取。');
   const time=new Date(form.time);if(!Number.isFinite(time.getTime()))throw new UserFacingError('请填写实际查询时间。');this.pending={kind:'evidence',roundId:r.round_id,request:{request_id:crypto.randomUUID(),subject_id:s.id,site_id:siteId,queried_at:time.toISOString(),url:form.url.trim(),note:form.note.trim(),conclusion:form.conclusion,material:structuredClone(pin),...(form.registration?{registration:structuredClone(form.registration)}:{})}};await this.sendPending();
  });});
 }

}
