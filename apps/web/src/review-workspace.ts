import { MARKET_LABELS, MARKET_OFFERINGS, OFFERING_LABELS, M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, ReviewDraftInputSchema, ReviewExecutionRequestSchema,
  type ReviewWorkspace as Workspace, type ReviewContext, type ReviewDraftInput, type ReviewExecutionRequest,
  ReviewProposalAdoptionRequestSchema, type ReviewMaterialPin, type ReviewFinding, type ReviewProposal, type ReviewProposalV2, type ReviewProposalAdoptionRequest, type ReviewAcceptedProposal, type ReviewPlanRequest, type Run, type Market, type Offering } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { ArtifactDownloads, artifactError } from './artifact-download';
import { ReviewApi } from './review-api';
import { carryHandoff, copyHandoffSource, mountBusinessHandoff, type BusinessHandoff } from './business-handoff';
import { ReadableReview } from './review-readable';
import { taskProgress } from './task-progress';
import { reviewLiveStatus, reviewProgressPage } from './review-progress';
import { DYNAMIC_REVIEW_BILLING_TASKS } from '@bondbuddy/contracts';
import { projectListContext, withProjectContext, projectBackLink, projectSection } from './project-navigation';
import { prototypeIcon, workspaceSteps } from './prototype-design';
import { QUARTER_ENDS, cutoffSelection, quarterCutoff } from './reporting-cutoff';
import { blankDraft, generatedProjectName, validateDraft } from './form-model';
import { RevisionHandlingDialog } from './review-revision-handling';
import { dimensionLabels, conclusionLabels, findingHtml, reportSummary, followUpHtml, evidenceHtml, rulesHtml, sourceLocator } from './review-presentation';
import { executionIdentity, isActiveRun, runStateLabel } from './review-state';
import { esc } from './ui';
import { isTypedReviewProposal, reviewTaskNotice, reviewTaskProgress, reviewRunProgress, reviewEmptyResultText, uniqueReviewTimeline, reviewTaskHtml } from './review-timeline';
import { Value } from '@sinclair/typebox/value';
import './review-workspace.css';
import { reviewScope, reviewRuleScope } from './review-scope';

type Operation = ReviewExecutionRequest['operation'];
type UploadRow = {file:File;role:Dto<'MaterialResponse'>['role'];state:string;error:boolean;target?:ReviewContext;material?:Dto<'MaterialResponse'>};
const operationLabels: Record<Operation, string> = {full_review:'完整三维复核',differential_review:'差异复核',revision:'按已选问题修订'};
const materialPin = (material: Dto<'MaterialResponse'>): ReviewMaterialPin => ({material_id:material.material_id,material_version:material.material_version,sha256:material.sha256});
const sameMaterial = (a: ReviewMaterialPin, b: ReviewMaterialPin) => a.material_id===b.material_id&&a.material_version===b.material_version&&a.sha256===b.sha256;
const mimeTypes: Record<string, typeof M1_UPLOAD_MIME_TYPES[number]> = {docx:M1_UPLOAD_MIME_TYPES[0],pdf:M1_UPLOAD_MIME_TYPES[1],xlsx:M1_UPLOAD_MIME_TYPES[2],csv:M1_UPLOAD_MIME_TYPES[3],txt:M1_UPLOAD_MIME_TYPES[4],png:M1_UPLOAD_MIME_TYPES[5],jpg:M1_UPLOAD_MIME_TYPES[6],jpeg:M1_UPLOAD_MIME_TYPES[6]};
const roleLabels: Partial<Record<Dto<'MaterialResponse'>['role'],string>> = {historical:'待复核募集书',reference:'参考募集书',audit:'审计报告',financial:'年度财务报表',interimFinancial:'最近一期报表',notes:'财务附注',other:'其他证据'};

/** Production M3 screen. Model responses, findings, task state and downloads come only from the API. */
export class ReviewWorkspace {
  private controller = new AbortController();
  private reviewApi: ReviewApi;
  private readable: ReadableReview;
  private fromList = projectListContext();
  private deletingMaterial?: string;
  private uploadRows = new Map<string,UploadRow>();
  private uploadQueue: {key:string;row:UploadRow;done:(saved:boolean)=>void}[] = [];
  private workspace?: Workspace;
  private page?: HTMLElement;
  private dialog?: HTMLDialogElement;
  private downloads = new ArtifactDownloads();
  private handling: RevisionHandlingDialog;
  private tab: 'materials'|'results'|'making' = 'materials';
  private syncOnReturn = () => { if(this.live()&&document.visibilityState==='visible')void this.refresh(); };
  private filters = {dimension:'all',conclusion:'all'};
  private selections = new Set<string>();
  private draftInput?: ReviewDraftInput;
  private inputDirty = false;
  private inputSaving?: Promise<boolean>;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private planSaving = false;
  private uploading = false;
  private uploadAttempts = new Map<string,{session:Dto<'UploadSessionResponse'>;bytesSaved:boolean;material?:Dto<'MaterialResponse'>}>();
  private executionPending?: ReviewExecutionRequest;
  private run?: Run;
  private charge?: Dto<'RunCreditChargeResponse'>;
  private chargeKey='';
  private chargeLoading=false;
  private chargeFetchedAt=0;
  private chargeError=false;
  private starting=false;
  private eventStream?:EventSource;
  private streamRun?:string;
  private creditPromptRun?:string;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private status = '';
  private statusError = false;
  private disposed = false;
  private readGeneration = 0;
  private localInputKey: string;
  private requestedTab?: 'materials'|'results'|'making';
  private openFindings = new Set<string>();
  private renderedReport?: string;
  private renderedResults?: string;
  private executionKey: string;
  private adoptionKey: string;
  private adoptionPending?: ReviewProposalAdoptionRequest;
  private focusedTaskRunId?:string;

  constructor(private api: ApiClient, private owner: string, private projectId: string,
    private shell: (html: string, section: string) => void, private current: () => boolean, private reportId?: string, tab?: string,private handoffQuery=new URLSearchParams()) {
    this.reviewApi = new ReviewApi(api,projectId,this.controller.signal);
    this.readable = new ReadableReview(api,projectId,this.controller.signal);
    this.handling = new RevisionHandlingDialog(api);
    this.localInputKey = `bb-review-input:${owner}:${projectId}`;
    this.executionKey = `bb-review-execution:${owner}:${projectId}`;
    this.adoptionKey = `bb-review-adoption:${owner}:${projectId}`;
    try{const pending:unknown=JSON.parse(localStorage.getItem(this.executionKey)??'null');if(Value.Check(ReviewExecutionRequestSchema,pending))this.executionPending=pending;}catch{/* Keep server state authoritative. */}
    try{const pending:unknown=JSON.parse(localStorage.getItem(this.adoptionKey)??'null');if(Value.Check(ReviewProposalAdoptionRequestSchema,pending))this.adoptionPending=pending;}catch{/* Preserve server proposal decisions. */}
    this.requestedTab = tab==='materials'||tab==='results'||tab==='making'?tab:undefined;
    this.tab = this.requestedTab ?? (reportId ? 'results' : 'materials');
  }
  get hasUnconfirmed() { return this.uploadRows.size>0||this.inputDirty||Boolean(this.executionPending)||Boolean(this.adoptionPending); }
  dispose() {
    this.disposed=true; this.readGeneration++; clearTimeout(this.pollTimer);clearTimeout(this.inputTimer);
    document.removeEventListener('visibilitychange',this.syncOnReturn);window.removeEventListener('online',this.syncOnReturn);
    this.eventStream?.close();this.controller.abort();this.downloads.dispose();this.handling.dispose();this.dialog?.remove();
  }
  async beforeLeave() {
    if(this.uploading){this.message('材料正在上传，请等待保存结果后离开。',true);return false;}
    this.cacheInput(); if(this.inputDirty) await this.saveInput();
    return true;
  }
  private live() { return !this.disposed&&this.current(); }

  async render() {
    this.shell(`<div class="review-workspace" id="review-workspace"><p role="status">正在读取复核项目…</p></div>`,projectSection('review'));
    this.page=document.querySelector<HTMLElement>('#review-workspace')!;
    const generation=++this.readGeneration;
    try {
      const workspace = await this.reviewApi.workspace(this.reportId);
      if(!this.live()||generation!==this.readGeneration)return;
      this.workspace=workspace;this.draftInput=this.inputFrom(workspace);this.run=workspace.active_run??undefined;
      if(!this.reportId&&!this.requestedTab&&(workspace.selected_report||workspace.artifacts.length))this.tab='results';
      if(workspace.active_run&&!this.requestedTab)this.tab='making';
      this.restoreInput();this.syncSelections();
      this.page.innerHTML = `${this.fromList?projectBackLink():''}<header class="page-head review-header"><div><p class="review-kicker">PROSPECTUS REVIEW</p><div class="review-project-title"><h1>${esc(workspace.project.name)}</h1><span class="review-tag" id="review-phase-badge"></span></div><div class="review-project-meta" id="review-project-meta"></div></div></header><div id="review-workspace-steps" hidden>${workspaceSteps(2,'复核流程')}</div><p class="review-status" id="review-status" role="status"></p><p class="task-credit-receipt" id="review-credit-receipt" role="status" hidden></p><div class="review-progress-bar" id="review-progress-bar" tabindex="-1" hidden></div><div id="business-handoff"></div><div class="review-grid review-single-column" id="review-grid"><section class="review-panel"><nav class="review-tabs" role="tablist" aria-label="复核内容"><button id="review-tab-materials" role="tab" data-review-tab="materials" aria-controls="review-materials-panel">材料与要求<span class="review-tab-count" aria-hidden="true"></span></button><button id="review-tab-results" role="tab" data-review-tab="results" aria-controls="review-results-panel">复核结果<span class="review-tab-count" aria-hidden="true"></span></button><button id="review-tab-making" role="tab" data-review-tab="making" aria-controls="review-making-panel" hidden>正在制作</button></nav><div class="review-tab-panel" id="review-materials-panel" role="tabpanel" aria-labelledby="review-tab-materials"></div><div class="review-tab-panel" id="review-results-panel" role="tabpanel" aria-labelledby="review-tab-results"></div><div class="review-tab-panel" id="review-making-panel" role="tabpanel" aria-labelledby="review-tab-making" hidden></div></section></div>`;
      document.removeEventListener('visibilitychange',this.syncOnReturn);window.removeEventListener('online',this.syncOnReturn);
      document.addEventListener('visibilitychange',this.syncOnReturn);window.addEventListener('online',this.syncOnReturn);
      this.bind();this.renderBody();this.schedulePoll();void mountBusinessHandoff(this.api,this.page.querySelector<HTMLElement>('#business-handoff')!,this.handoffQuery,()=>this.live(),handoff=>this.adoptExternalHandoff(handoff));
      if(this.inputDirty&&this.inputConflictVersion===undefined)void this.saveInput();
      if(!this.run){
        try {
        const history=await this.reviewApi.history();
        if(!this.live()||generation!==this.readGeneration)return;
        const latest=this.reportId?history.items.find(item=>item.report_id===this.reportId):[...history.items].sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
        if(latest){this.run=latest.run;this.renderResults();this.renderMeta();this.renderMaking();}
        } catch(error) { if(this.live())this.message(`本轮状态暂未同步。${friendlyError(error)}`,true); }
      }
    }catch(error){
      if(!this.live())return;
      this.page.innerHTML=`<div class="review-empty"><h2>项目暂时无法读取</h2><p role="alert">${esc(friendlyError(error))}</p><button class="btn secondary" data-review-retry>重新读取</button></div>`;
      this.page.querySelector('[data-review-retry]')!.addEventListener('click',()=>void this.render());
    }
  }
  private inputFrom(workspace: Workspace): ReviewDraftInput {
    const {version,...input}=workspace.draft;return structuredClone({...input,as_of:version===0?workspace.project.update_details?.reporting_cutoff??input.as_of:input.as_of});
  }
  private restoreInput() {
    try{
      const cached=JSON.parse(localStorage.getItem(this.localInputKey)??'null');
      if(cached&&cached.project_id===this.projectId&&cached.owner===this.owner&&Number.isInteger(cached.version)&&Value.Check(ReviewDraftInputSchema,cached.input)){
        this.draftInput=cached.input;this.inputDirty=true;
        this.status=cached.version===this.workspace!.draft.version?'已恢复未保存的材料与要求草稿，请保存后执行。':'服务器输入已有新版本。已保留本页草稿，请核对后保存；不会自动覆盖。';
        if(cached.version!==this.workspace!.draft.version)this.inputConflictVersion=cached.version;
      }
    }catch{/* The server copy remains available when browser storage is unavailable. */}
  }
  private inputConflictVersion?:number;
  private cacheInput() {
    try{if(this.inputDirty&&this.draftInput)localStorage.setItem(this.localInputKey,JSON.stringify({owner:this.owner,project_id:this.projectId,version:this.inputConflictVersion??this.workspace?.draft.version,input:this.draftInput}));else localStorage.removeItem(this.localInputKey);}catch{if(this.inputDirty)this.message('浏览器无法缓存输入，请保持页面打开并保存材料与要求。',true);}
  }
  private message(text:string,error=false){this.status=text;this.statusError=error;const node=this.page?.querySelector<HTMLElement>('#review-status');if(node){node.textContent=text;node.classList.toggle('review-warning',error);}const fieldStatus=this.page?.querySelector<HTMLElement>('#review-requirements-status');if(fieldStatus){fieldStatus.textContent=this.inputDirty?(error?text:'正在保存要求…'):'要求已保存';fieldStatus.classList.toggle('review-warning',this.inputDirty&&error);}}
  private syncSelections(){
    const report=this.workspace?.selected_report,plan=this.workspace?.plan;
    this.selections=new Set(report&&plan&&plan.source_report_id===report.report_id?plan.finding_ids:[]);
  }
  private renderBody(){this.renderMeta();this.renderMaterials();this.renderResults();this.renderMaking();this.setTab(this.tab,false);this.message(this.status,this.statusError);}
  private progressTask(){
    const id=this.focusedTaskRunId??this.workspace?.active_run?.run_id??this.run?.run_id;
    const entry=this.workspace?.timeline?.find(item=>item.kind==='task'&&item.task.run.run_id===id);
    return entry?.kind==='task'?entry.task:undefined;
  }
  private renderMaking(){
    const host=this.page?.querySelector<HTMLElement>('#review-making-panel'),tab=this.page?.querySelector<HTMLButtonElement>('#review-tab-making');if(!host||!tab)return;
    const task=this.progressTask(),run=task?.run??this.workspace?.active_run??this.run;
    tab.hidden=!run;tab.textContent=run&&isActiveRun(run)?'正在复核':'本轮任务';
    if(!run){host.innerHTML='<p class="review-muted">暂无本轮任务。</p>';return;}
    const charge=this.chargeKey.startsWith(run.run_id+':')?this.charge:undefined;
    const html=reviewProgressPage(run,task,charge,{chargeError:this.chargeError});
    if(host.dataset.rendered!==html){host.innerHTML=html;host.dataset.rendered=html;}
  }
  private renderMeta(){
    this.renderCharge();
    if(!this.workspace)return;
    const run=this.workspace.active_run??this.run,bar=this.page?.querySelector<HTMLElement>('#review-progress-bar');
    const steps=this.page?.querySelector<HTMLElement>('#review-workspace-steps');
    if(steps)steps.hidden=this.tab!=='materials'||isActiveRun(this.workspace.active_run);
    const badge=this.page?.querySelector('#review-phase-badge'),meta=this.page?.querySelector('#review-project-meta');
    if(badge)badge.textContent=run?runStateLabel[run.state]:'准备复核';
    if(meta){const project=this.workspace.project,cutoff=this.draftInput?.as_of??project.update_details?.reporting_cutoff;
      const period=cutoff?.match(/^(\d{4})-(\d{2})-\d{2}$/);
      const summary=[project.issuer_name,project.market?MARKET_LABELS[project.market]:null,project.offering?OFFERING_LABELS[project.offering]:null,period?`报告期 ${period[1]}年${period[2]==='12'?'末':Number(period[2])+'月末'}`:null];
      meta.innerHTML=summary.filter(Boolean).map(text=>`<span>${esc(text)}</span>`).join('');
    }
    if(bar){
      bar.hidden=!run||this.tab==='making';
      if(run){
        const entry=this.workspace.timeline?.find(item=>item.kind==='task'&&item.task.run.run_id===run.run_id);
        const progress=reviewLiveStatus(run,entry?.kind==='task'?entry.task:undefined,this.chargeKey.startsWith(run.run_id+':')?this.charge?.progress:undefined);
        const updating=entry?.kind==='task'&&entry.task.operation==='revision';
        const html=taskProgress(run,updating?'update':'review',updating?undefined:progress)+(isActiveRun(run)?'<button class="text-btn" data-review-action="cancel">停止本次任务</button>':'');
        if(bar.innerHTML!==html)bar.innerHTML=html;
      }
    }
    const report=this.workspace.selected_report;
    for(const [name,count,unit] of [['materials',this.workspace.materials.length,'份材料'],['results',report?report.findings.length:this.workspace.artifacts.filter(a=>a.kind==='report').length,report?'项发现':'份报告']] as const){
      const tab=this.page?.querySelector(`[data-review-tab="${name}"]`),badge=tab?.querySelector('.review-tab-count');
      if(badge)badge.textContent=String(count);tab?.setAttribute('aria-description',`${count} ${unit}`);
    }
  }
  private setTab(tab:'materials'|'results'|'making',write=true){this.tab=tab;this.page?.querySelectorAll<HTMLButtonElement>('[data-review-tab]').forEach(b=>{const selected=b.dataset.reviewTab===tab;b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;});for(const name of ['materials','results','making']){const panel=this.page?.querySelector<HTMLElement>(`#review-${name}-panel`);if(panel)panel.hidden=name!==tab;}this.renderMeta();if(write){const query=withProjectContext(new URLSearchParams({tab}),this.fromList);if(this.reportId)query.set('report_id',this.reportId);history.replaceState(null,'',`${location.pathname}${location.search}#/projects/${encodeURIComponent(this.projectId)}/review?${query}${carryHandoff(this.handoffQuery)}`);}}
  private materialNames(){return Object.fromEntries((this.workspace?.materials??[]).map(m=>[m.material_id,m.filename]));}
  private projectInfo(){
    if(!this.workspace)return '';
    const p=this.workspace.project,report=this.workspace.selected_report;
    const query=withProjectContext(new URLSearchParams({step:'details',review_tab:'materials'}),this.fromList);if(report)query.set('review_report_id',report.report_id);
    const summary=[p.issuer_name,p.market?MARKET_LABELS[p.market]:null,p.offering?OFFERING_LABELS[p.offering]:null].filter(Boolean).map(value=>esc(value!)).join(' · ');
    return `<div class="review-project-info" id="review-project-info"><div><strong>项目信息</strong>${summary?`<p>${summary}</p>`:''}</div><a class="text-btn" href="#/projects/${encodeURIComponent(this.projectId)}?${esc(query.toString())}">${p.issuer_name&&p.market&&p.offering?'编辑项目信息':'补充项目信息'}</a></div>`;
  }
  private context(finding?:ReviewFinding):ReviewContext {return {project_id:this.projectId,report_id:finding?.report_id??this.workspace?.selected_report?.report_id??null,finding_ids:finding?[finding.finding_id]:[],material_refs:finding?[...finding.target_refs,...finding.evidence_refs].reduce<ReviewMaterialPin[]>((refs,ref)=>{const pin={material_id:ref.material_id,material_version:ref.material_version,sha256:ref.material_sha256};if(!refs.some(item=>sameMaterial(item,pin)))refs.push(pin);return refs;},[]):[]};}

  private async viewReport(reportId:string,findingId?:string){
    if(!this.workspace?.reports.some(report=>report.report_id===reportId)){this.message('该报告暂未登记，请重新读取任务结果。',true);return;}
    const previous=this.reportId;this.reportId=reportId;const generation=++this.readGeneration;
    try{
      const workspace=this.mergeWorkspace(await this.reviewApi.workspace(reportId));if(!this.live()||generation!==this.readGeneration)return;
      if(workspace.selected_report?.report_id!==reportId)throw new ApiError(0,'DATA_UNAVAILABLE');
      this.workspace=workspace;if(!this.inputDirty)this.draftInput=this.inputFrom(workspace);this.syncSelections();this.renderBody();this.setTab('results');
      if(findingId){
        if(!workspace.selected_report.findings.some(f=>f.finding_id===findingId)){this.message('该引用在来源报告中无法定位，未跳转到其他同名问题。',true);return;}
        this.filters={dimension:'all',conclusion:'all'};this.openFindings.add(findingId);this.renderResults();
        const finding=this.page?.querySelector<HTMLDetailsElement>(`[data-finding-id="${CSS.escape(findingId)}"]`);if(finding){finding.open=true;finding.tabIndex=-1;finding.scrollIntoView({block:'center',behavior:'smooth'});finding.focus({preventScroll:true});}
      }else{this.page?.querySelector<HTMLElement>('#review-result-task-link')?.scrollIntoView({block:'start',behavior:'smooth'});}
    }catch(error){if(!this.live()||generation!==this.readGeneration)return;this.reportId=previous;this.message(`原报告已保留。${friendlyError(error)}`,true);}
  }

  private taskFocus(runId:string){this.focusedTaskRunId=runId;this.renderMaking();this.setTab('making');this.page?.querySelector<HTMLElement>('#review-making-panel')?.scrollIntoView({block:'start',behavior:'smooth'});}

  private focusRequirements(finding?:ReviewFinding){
    this.setTab('materials');
    const field=this.page?.querySelector<HTMLTextAreaElement>('#review-requirements');
    field?.scrollIntoView({block:'center',behavior:'smooth'});field?.focus({preventScroll:true});
    if(finding)this.message(`请补充关于「${finding.title}」的复核要求，保存后用于下一次复核。`);
  }

  private bind(){
    this.page!.addEventListener('click',event=>{
      const target=(event.target as HTMLElement).closest<HTMLElement>('[data-review-action],[data-review-tab],[data-review-coverage],[data-review-filter-value]');if(!target)return;
      if(target.dataset.reviewTab){this.setTab(target.dataset.reviewTab as 'materials'|'results'|'making');return;}
      if(target.dataset.reviewCoverage){this.coverage(target.dataset.reviewCoverage);return;}
      if(target.dataset.reviewFilterValue){this.filters.dimension=target.dataset.reviewFilterValue;this.renderResults();this.page?.querySelector<HTMLElement>(`[data-review-filter-value="${CSS.escape(this.filters.dimension)}"]`)?.focus({preventScroll:true});return;}
      const card=target.closest<HTMLElement>('[data-finding-id]');const finding=this.workspace?.selected_report?.findings.find(f=>f.finding_id===card?.dataset.findingId);
      switch(target.dataset.reviewAction){
        case 'save-input':void this.saveInput();break;
        case 'review':void this.previewExecution('full_review',null,[]);break;
        case 'plan':this.previewPlan();break;
        case 'cancel':void this.cancelRun();break;
        case 'pause':void this.controlRun('pause');break;
        case 'resume':void this.controlRun('resume');break;
        case 'recharge':this.rechargeDialog();break;
        case 'upload':this.setTab('materials');this.page?.querySelector<HTMLInputElement>('[data-review-upload-role]')?.click();break;
        case 'retry-upload':{const row=this.uploadRows.get(target.dataset.uploadKey??'');if(row?.error)void this.upload([row.file],row.role,row.target);break;}
        case 'delete-material':void this.deleteMaterial(target.dataset.materialId??'');break;
        case 'remove-upload':{const key=target.dataset.uploadKey??'',row=this.uploadRows.get(key);if(row?.error&&!row.material){this.uploadRows.delete(key);this.renderMaterials();}break;}
        case 'evidence':if(finding)this.uploadDialog(this.context(finding));break;
        case 'source':if(finding)this.showSource(finding,target);break;
        case 'explain':if(finding)this.explain(finding);break;
        case 'discuss':case 'dispute':this.focusRequirements(finding);break;
        case 'prepare':this.setTab('materials');break;
        case 'download':if(target.dataset.artifactId)void this.download(target.dataset.artifactId);break;
        case 'handling':this.showHandling();break;
        case 'task-focus':if(target.dataset.runId)this.taskFocus(target.dataset.runId);break;
        case 'task-status':{this.setTab('results');const target=this.page?.querySelector<HTMLElement>('.review-run')??this.page?.querySelector<HTMLElement>('#review-progress-bar');target?.scrollIntoView({block:'start'});target?.focus({preventScroll:true});break;}
        case 'report':if(target.dataset.reportId)void this.viewReport(target.dataset.reportId,target.dataset.findingId);break;
        case 'task-download':if(target.dataset.runId&&target.dataset.artifactId)void this.downloadTaskArtifact(target.dataset.runId,target.dataset.artifactId);break;
        case 'recheck':if(finding)void this.previewExecution('differential_review',finding.report_id,[finding.finding_id]);break;
        case 'reload-input':void this.resolveInput(false);break;
        case 'adopt-local-input':void this.resolveInput(true);break;
      }
    });
    this.page!.addEventListener('input',event=>{
      const target=event.target;
      if(target instanceof HTMLTextAreaElement&&target.id==='review-requirements'&&this.draftInput){
        this.draftInput.requirements=target.value.split('\n').map(text=>text.trim()).filter(Boolean);this.changedInput();
      }
    });
    this.page!.addEventListener('change',event=>{
      const target=event.target;
      if(target instanceof HTMLInputElement&&target.dataset.reviewUploadRole){const files=[...(target.files??[])];target.value='';if(files.length)void this.upload(files,target.dataset.reviewUploadRole as Dto<'MaterialResponse'>['role']);return;}
      if(target instanceof HTMLInputElement&&target.dataset.reviewSelect){void this.selectFinding(target.dataset.reviewSelect,target.checked);return;}
      if(target instanceof HTMLSelectElement&&target.dataset.reviewFilter){this.filters[target.dataset.reviewFilter as keyof typeof this.filters]=target.value;this.renderResults();return;}
      if(target instanceof HTMLSelectElement&&target.id==='review-source'){const source=this.workspace?.materials.find(m=>m.material_id===target.value);if(this.draftInput){this.draftInput.source_material_ref=source?materialPin(source):null;this.changedInput();}return;}
      if(target instanceof HTMLInputElement&&target.id==='review-as-of'&&this.draftInput){this.draftInput.as_of=target.value||null;this.changedInput();}
    });
    this.page!.addEventListener('dragover',event=>{if((event.target as HTMLElement).closest('[data-review-drop]'))event.preventDefault();});
    this.page!.addEventListener('drop',event=>{const zone=(event.target as HTMLElement).closest<HTMLElement>('[data-review-drop]');if(zone){event.preventDefault();if(event.dataTransfer?.files.length)void this.upload([...event.dataTransfer.files],zone.dataset.reviewDrop as Dto<'MaterialResponse'>['role']);}});
    this.page!.addEventListener('keydown',event=>{if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&(event.target as HTMLElement).matches('[data-review-tab]')){event.preventDefault();this.setTab(this.tab==='materials'?'results':'materials');this.page?.querySelector<HTMLButtonElement>(`[data-review-tab="${this.tab}"]`)?.focus();}});
  }
  private changedInput(){this.inputDirty=true;this.cacheInput();this.message(isActiveRun(this.workspace?.active_run)?'补充内容进入下一版，当前任务输入保持不变。':'材料与要求草稿等待保存。');clearTimeout(this.inputTimer);this.inputTimer=setTimeout(()=>void this.saveInput(),650);}

  private renderMaterials(){
    const host=this.page?.querySelector('#review-materials-panel');if(!host||!this.workspace||!this.draftInput)return;
    const active=document.activeElement;
    const editing=host.contains(active)&&(active instanceof HTMLTextAreaElement||(active instanceof HTMLInputElement&&active.type!=='file')||active instanceof HTMLSelectElement)?{id:active.id,value:active.value,start:active instanceof HTMLTextAreaElement?active.selectionStart:null,end:active instanceof HTMLTextAreaElement?active.selectionEnd:null}:undefined;
    const input=this.draftInput,materials=this.workspace.materials;const source=materials.filter(m=>['historical','reference'].includes(m.role)&&m.state==='persisted');
    const running=isActiveRun(this.workspace.active_run);
    const pending=[...this.uploadRows.values()].filter(row=>!row.error).length;
    const failed=this.uploadRows.size-pending;
    const uploadNotice=pending
      ? `还有 ${pending} 份材料正在上传或保存，可继续添加文件。请保持页面打开。`
      : failed ? `${failed} 份文件尚未保存，请重试或移除失败文件后开始。` : '';
    const pendingMaterialIds=new Set([...this.uploadRows.values()].flatMap(row=>row.material?[row.material.material_id]:[]));
    const groups=[{title:'待复核募集书',roles:['historical','reference'],primary:'historical'}, {title:'审计报告 / 财务报表及附注',roles:['audit','financial','interimFinancial','notes'],primary:'audit'}, {title:'其他核验材料',roles:Object.keys(roleLabels).filter(r=>!['historical','reference','audit','financial','interimFinancial','notes'].includes(r)),primary:'other'}];
    const fileRow=(m:Dto<'MaterialResponse'>)=>`<li class="material-file-row"><div class="material-file-main"><strong>${esc(m.filename)}</strong><span>${esc(roleLabels[m.role]??'其他材料')} · ${(m.byte_size/1024).toFixed(1)} KB</span><p class="material-file-status">已保存</p></div><div class="material-file-actions"><button type="button" class="text-button" data-review-action="delete-material" data-material-id="${esc(m.material_id)}" aria-label="删除 ${esc(m.filename)}" ${running||this.uploading||this.deletingMaterial?'disabled':''}>${this.deletingMaterial===m.material_id?'正在删除…':'删除'}</button></div></li>`;
    const role=(r:string,showTitle=true)=>`<li class="material-role" data-review-drop="${r}"><div class="material-role-heading"><div>${showTitle?`<strong>${esc(roleLabels[r as keyof typeof roleLabels]??'其他核验材料')}</strong>`:''}<span>${r==='historical'?'上传需要复核的募集书，支持 Word / PDF':'选中文件后立即上传，也可直接拖入文件'}</span></div><label class="button secondary material-picker" for="review-upload-${r}">${prototypeIcon('upload')}<span>点击或拖入文件</span><input id="review-upload-${r}" type="file" multiple accept="${r==='historical'||r==='reference'?'.docx,.pdf':'.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg'}" aria-label="为${esc(roleLabels[r as keyof typeof roleLabels]??'其他核验材料')}选择文件" data-review-upload-role="${r}"></label></div><ul class="material-file-list">${materials.filter(m=>m.role===r&&!pendingMaterialIds.has(m.material_id)).map(fileRow).join('')}${[...this.uploadRows].filter(([,row])=>row.role===r).map(([key,row])=>`<li class="material-file-row" data-review-upload-key="${esc(key)}"><div class="material-file-main"><strong>${esc(row.file.name)}</strong><p class="material-file-status ${row.error?'material-file-error':''}" role="status">${esc(row.state)}</p></div>${row.error?`<div class="material-file-actions"><button class="text-button" data-review-action="retry-upload" data-upload-key="${esc(key)}">重试此文件</button>${row.material?`<button type="button" class="text-button" data-review-action="delete-material" data-material-id="${esc(row.material.material_id)}" ${running||this.uploading||this.deletingMaterial?'disabled':''}>删除</button>`:``}${!row.material?`<button class="text-button" data-review-action="remove-upload" data-upload-key="${esc(key)}">移除此行</button>`:''}</div>`:''}</li>`).join('')}</ul></li>`;
    if(!host.querySelector('#review-upload-groups'))host.innerHTML='<div id="review-materials-before"></div><div id="review-upload-groups"></div><div id="review-materials-after"></div>';
    host.querySelector('#review-materials-before')!.innerHTML=`${this.projectInfo()}${this.inputConflictVersion!==undefined?'<div class="review-notice error">其他页面已修改材料与要求，本页内容已保留。<button class="text-btn" data-review-action="reload-input">采用服务器版本</button><button class="text-btn" data-review-action="adopt-local-input">核对本页内容</button></div>':''}<div class="panel-heading materials-heading"><div><h2>提供复核材料</h2><p class="muted">按分区添加材料。单份不超过 100 MB，每个项目最多 60 份、合计 500 MB。上传过程中可继续添加文件。</p></div></div><p class="review-upload-summary" role="status">${esc(uploadNotice)}</p>${running?'<p class="review-muted">当前任务使用的材料已锁定；请先停止任务，停止完成后可删除误传文件并重新上传。</p>':''}`;
    const groupsHost=host.querySelector('#review-upload-groups')!;
    const template=document.createElement('template');
    template.innerHTML=`${groups.map(g=>`<section class="material-partition"><h3>${g.title}</h3><ul class="material-role-list">${role(g.primary,false)}</ul>${g.roles.filter(r=>r!==g.primary).length?`<details class="material-subtypes"><summary>按细分类别补充材料（选填）</summary><ul class="material-role-list">${g.roles.filter(r=>r!==g.primary).map(r=>role(r)).join('')}</ul></details>`:''}</section>`).join('')}`;
    if(!groupsHost.childElementCount)groupsHost.append(template.content);
    else{
      // Keep file inputs connected while the native chooser is open.
      for(const fresh of template.content.querySelectorAll<HTMLElement>('[data-review-drop]')){
        const current=groupsHost.querySelector<HTMLElement>(`[data-review-drop="${fresh.dataset.reviewDrop}"]`)!;
        current.querySelector('.material-file-list')!.innerHTML=fresh.querySelector('.material-file-list')!.innerHTML;
      }
    }
    for(const details of groupsHost.querySelectorAll<HTMLDetailsElement>('.material-subtypes')){
      const names=[...details.querySelectorAll('.material-file-main strong')].map(el=>el.textContent).join('\n');
      if(names&&details.dataset.shownFiles!==names){details.open=true;details.dataset.shownFiles=names;}
    }
    host.querySelector('#review-materials-after')!.innerHTML=`
    ${materials.filter(m=>!groups.some(g=>g.roles.includes(m.role))).length?`<div class="review-section-heading"><h3>已保存的其他材料</h3></div><ul class="material-file-list">${materials.filter(m=>!groups.some(g=>g.roles.includes(m.role))).map(fileRow).join('')}</ul>`:''}
    ${source.length>1?`<label class="review-section-heading" for="review-source"><h3>本次待复核稿</h3></label><select id="review-source" class="review-source-select"><option value="">选择已上传的募集书</option>${source.map(m=>`<option value="${esc(m.material_id)}" ${input.source_material_ref?.material_id===m.material_id?'selected':''}>${esc(m.filename)}</option>`).join('')}</select>`:''}
    <section class="review-optional-requirements"><label for="review-requirements">补充复核要求（选填）</label><p class="review-muted" id="review-requirements-help">填写希望重点核对的内容、统计口径或特殊情况。要求自动保存，开始复核时一并采用。</p><textarea id="review-requirements" class="review-source-select" rows="4" aria-describedby="review-requirements-help" placeholder="例如：请重点核对法定代表人信息是否准确，并核对各处披露是否一致。">${esc(input.requirements.join('\n'))}</textarea><div class="review-requirements-save"><span id="review-requirements-status" class="review-muted" role="status">${this.inputDirty?'要求等待保存':'要求已保存'}</span><button type="button" class="text-btn" data-review-action="save-input">保存要求</button></div>${running?'<p class="review-muted">本次补充用于下一轮复核，当前任务仍使用开始时的要求。</p>':''}</section>
    <div class="review-footer-actions review-materials-footer"><div class="review-footer-copy"><strong>${running?'当前任务进行中':this.uploadRows.size?'材料保存完成后即可开始':'准备好了，就可以开始。'}</strong><p class="review-muted">${esc(uploadNotice||(running?'补充材料与要求将用于下一轮复核。':'确认材料与要求后，点击开始复核。'))}</p></div><div class="review-footer-buttons"><button type="button" class="btn primary" data-review-action="review" ${running||this.uploadRows.size||this.starting?'disabled':''}>${running?'当前任务进行中':this.starting?'正在开始复核…':'开始复核'}</button></div></div>`;
    if(editing){const field=host.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`#${CSS.escape(editing.id)}`);if(field){field.value=editing.value;field.focus({preventScroll:true});if(field instanceof HTMLTextAreaElement&&editing.start!==null&&editing.end!==null)field.setSelectionRange(editing.start,editing.end);}}
  }
  private async adoptExternalHandoff(handoff:BusinessHandoff){
    if(!this.workspace||!this.draftInput||!await this.saveInput())throw new ApiError(409,'INPUT_REVISION_CONFLICT');
    const source=await copyHandoffSource(this.api,handoff,this.projectId,this.controller.signal);if(!this.live())return;
    await this.refresh();if(!this.draftInput)return;
    if(source){const pin=materialPin(source);this.draftInput.source_material_ref=pin;if(!this.draftInput.material_versions.some(p=>sameMaterial(p,pin)))this.draftInput.material_versions.push(pin);}
    if(!this.draftInput.requirements.includes(handoff.intent))this.draftInput.requirements.push(handoff.intent);
    this.changedInput();if(!await this.saveInput())throw new ApiError(409,'INPUT_REVISION_CONFLICT');this.setTab('materials');this.renderMaterials();
  }
  private renderResults(){
    const host=this.page?.querySelector('#review-results-panel');if(!host||!this.workspace)return;const report=this.workspace.selected_report;
    const run=this.workspace.active_run??this.run;
    const taskEntries=(this.workspace.timeline??[]).filter(entry=>entry.kind==='task');
    const currentTask=taskEntries.find(entry=>entry.task.run.run_id===run?.run_id)?.task;
    const taskNotice=currentTask?reviewTaskNotice(currentTask):undefined;
    const taskRelations=taskEntries.map(entry=>({run_id:entry.task.run.run_id,state:entry.task.run.state,report_id:entry.task.report_id,operation:entry.task.operation,input_version:entry.task.input_version,source_report_id:entry.task.source_report_id,finding_ids:entry.task.finding_ids}));
    const signature=JSON.stringify([report?.report_id,run?.run_id,run?.state,run?.stage,taskNotice,this.filters,[...this.selections].sort(),this.planSaving,this.workspace.artifacts,this.workspace.artifact_run,this.materialNames(),taskRelations,this.reportId,this.workspace.reports]);
    if(this.renderedResults===signature&&host.childElementCount)return;
    this.renderedResults=signature;
    if(this.renderedReport===report?.report_id)host.querySelectorAll<HTMLDetailsElement>('.review-finding').forEach(d=>{if(d.open)this.openFindings.add(d.dataset.findingId!);else this.openFindings.delete(d.dataset.findingId!);});
    else this.openFindings.clear();
    this.renderedReport=report?.report_id;
    const completed=run&&['succeeded','test_completed'].includes(run.state);
    const nextStep=run?.state==='paused'?'<p>本轮输入和状态已保留，处理条件恢复后继续。需要更换本轮材料或要求时，请先停止本次任务。</p>':run?.state==='awaiting_input'?'<p>本轮仍等待补充信息，请先核对任务状态。需要更换本轮输入时，请先停止本次任务。</p>':run&&['failed','cancelled','rejected'].includes(run.state)?'<p>本轮状态已保留。补充材料与要求后，可以明确开始下一轮；原报告保持不变。</p>':'';
    const progress=run&&!completed&&(taskNotice||nextStep)?`<section class="review-run"><h3>任务状态：${runStateLabel[run.state]}</h3>${taskNotice?`<p class="review-warning">${esc(taskNotice)}</p>`:''}${nextStep}</section>`:'';
    if(!report&&this.workspace.artifact_run&&this.workspace.artifacts.some(a=>a.kind==='report')){
      host.innerHTML=progress+`<div class="review-readable-result"><div class="review-readable-heading"><div><p class="review-kicker">REVIEW RESULTS</p><h2>复核报告已生成</h2><p>第 ${this.workspace.artifact_run.version} 次复核 · 分别查看财务、合规与公开信息的核对结果。</p><p>${this.workspace.artifacts.some(a=>a.kind==='comments')?'原文批注保留上传版本正文；无法定位的事项请查看报告中的“原文批注与待确认定位”。':'这次历史成果仅有独立报告，未生成原文批注版。'}</p></div><div class="review-result-actions review-downloads" role="group" aria-label="复核成果">${this.workspace.artifacts.filter(a=>a.kind==='report'||a.kind==='comments').sort((a,b)=>Number(b.kind==='comments')-Number(a.kind==='comments')).map(a=>`<button class="btn ${a.kind==='comments'?'primary':'secondary'}" data-review-action="download" data-artifact-id="${esc(a.artifact_id)}">${a.kind==='comments'?'下载原文批注版':'下载复核报告（Word）'}</button>`).join('')}</div></div><div data-readable-report></div></div>`;
      this.readable.mount(host.querySelector<HTMLElement>('[data-readable-report]')!,this.workspace.artifact_run.run_id);return;
    }
    if(!report&&this.workspace.artifact_run?.operation==='revision'&&this.workspace.artifacts.some(a=>a.kind==='clean')){
      host.innerHTML=progress+`<div class="review-readable-heading"><div><h2>更新后的募集书已生成</h2><p>根据复核结果完成更新，内容仍需人工确认。</p></div><div class="review-downloads">${this.workspace.artifacts.filter(a=>['revision','clean'].includes(a.kind)).map(a=>`<button class="btn primary" data-review-action="download" data-artifact-id="${esc(a.artifact_id)}">下载${a.kind==='revision'?'修订版':'清洁版'} Word</button>`).join('')}</div></div>${this.workspace.artifact_run.source_run_id?'<h3>更新依据：原复核结果</h3><div data-readable-report></div>':''}`;
      if(this.workspace.artifact_run.source_run_id)this.readable.mount(host.querySelector<HTMLElement>('[data-readable-report]')!,this.workspace.artifact_run.source_run_id);return;
    }
    if(!report){const empty=reviewEmptyResultText(run);host.innerHTML=progress+`<div class="review-empty"><h2>${esc(empty.heading)}</h2><p class="review-muted">${esc(empty.message)}</p><button class="btn secondary" data-review-tab="materials">查看材料与要求</button></div>`;return;}
    const scoped=report.findings.filter(f=>this.filters.conclusion==='all'||f.conclusion===this.filters.conclusion);
    const matches=(finding:ReviewFinding,value:string)=>value==='all'||(value==='priority'?finding.severity!=='P3':finding.dimension===value);
    const findings=scoped.filter(f=>matches(f,this.filters.dimension));
    const filters=[['all','全部'],['priority','优先关注'],...Object.entries(dimensionLabels)];
    const downloads=this.workspace.artifacts.length?`<div class="review-result-actions review-downloads" role="group" aria-label="复核成果">${this.handlingButton()}${this.workspace.artifacts.map(artifact=>`<button class="btn secondary small" data-review-action="download" data-artifact-id="${esc(artifact.artifact_id)}">下载${{report:'问题报告',comments:'原文批注版',revision:'修订版',clean:'清洁版',baseline:'基线文稿'}[artifact.kind]}</button>`).join('')}</div>`:'';
    const revisionContext=this.workspace.artifact_run?.operation==='revision'?`<div class="review-revision-context">${this.artifactHeading()}</div>`:'';
    const reportNames=Object.fromEntries(this.workspace.reports.map(item=>[item.report_id,`R${item.version}`]));
    const linked=taskEntries.find(entry=>entry.task.run.run_id===this.workspace!.artifact_run?.run_id)??taskEntries.find(entry=>entry.task.report_id===report.report_id);
    const relation=linked?`<div class="review-result-task-link" id="review-result-task-link" tabindex="-1"><div><small>关联任务 · 固定输入 V${linked.task.input_version}</small><strong>${operationLabels[linked.task.operation]} · ${runStateLabel[linked.task.run.state]}</strong><p>当前报告 R${report.version}${linked.task.source_report_id?` · 来源 ${esc(reportNames[linked.task.source_report_id]??'原报告')}`:''}</p></div><button class="text-btn" data-review-action="task-focus" data-run-id="${esc(linked.task.run.run_id)}">查看任务进度</button></div>`:'';
    const latest=[...this.workspace.reports].sort((a,b)=>b.version-a.version)[0];
    const newResult=this.reportId&&latest&&latest.report_id!==report.report_id?`<div class="review-notice"><p>当前查看历史报告 R${report.version}；本轮有新结果 R${latest.version}。</p><button class="text-btn" data-review-action="report" data-report-id="${esc(latest.report_id)}">查看本轮新结果</button></div>`:'';
    const activeTask=taskEntries.find(entry=>entry.task.run.run_id===this.workspace!.active_run?.run_id)?.task;
    const running=(finding:ReviewFinding)=>Boolean(activeTask&&isActiveRun(activeTask.run)&&!['paused','awaiting_input'].includes(activeTask.run.state)&&activeTask.operation!=='revision'&&(activeTask.operation==='full_review'||activeTask.source_report_id===report.report_id&&activeTask.finding_ids.includes(finding.finding_id)));
    host.innerHTML=newResult+relation+progress+reportSummary(report)+followUpHtml(report,reportNames)+revisionContext+`<div class="review-section-heading review-findings-heading"><div class="review-findings-title"><h3>复核发现 <span class="review-tab-count">${report.findings.length}</span></h3><p class="review-muted">${esc(this.materialNames()[report.source_material.material_id]??'待复核稿')} · V${report.source_material.material_version}</p></div>${downloads}</div><div class="review-filters"><div class="review-filter-chips" role="group" aria-label="筛选复核发现">${filters.map(([value,label])=>`<button class="review-filter-chip" data-review-filter-value="${value}" aria-pressed="${this.filters.dimension===value}">${label}<span>${scoped.filter(f=>matches(f,value)).length}</span></button>`).join('')}</div><label class="review-filter-advanced">结论<select data-review-filter="conclusion" aria-label="结论"><option value="all">全部结论</option>${Object.entries(conclusionLabels).map(([value,label])=>`<option value="${value}" ${this.filters.conclusion===value?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="review-findings">${findings.length?findings.map(f=>findingHtml(f,this.selections.has(f.finding_id),this.materialNames(),running(f),reportNames[f.origin_report_id]??'原报告')).join(''):'<p class="review-muted">当前筛选没有发现；请结合检查覆盖与限制阅读结果。</p>'}</div><div class="review-plan-bar"><div><strong>已选择 ${this.selections.size} 项修订</strong><p>先核对修改范围，再明确执行。补证、异议与已修改都不自动代表复核通过。</p></div><button class="btn primary small" data-review-action="plan" ${this.planSaving?'disabled':''}>核对修订计划</button></div><div class="review-footer-actions"><p>版本记录在工作台项目内保存。当前结果的来源与限制始终保留。</p><button class="btn secondary small" data-review-action="review" ${isActiveRun(this.workspace.active_run)?'disabled':''}>再次完整复核</button></div>`;
    host.querySelectorAll<HTMLInputElement>('[data-review-select]').forEach(input=>input.disabled=this.planSaving);
    host.querySelectorAll<HTMLDetailsElement>('.review-finding').forEach(d=>{d.open=this.openFindings.has(d.dataset.findingId!);});
  }
  private saveInput():Promise<boolean>{clearTimeout(this.inputTimer);if(this.inputSaving)return this.inputSaving;if(!this.inputDirty)return Promise.resolve(true);if(this.inputConflictVersion!==undefined){this.message('请先核对材料页上的输入版本冲突。',true);return Promise.resolve(false);}const promise=this.persistInput();this.inputSaving=promise;void promise.finally(()=>{if(this.inputSaving===promise)this.inputSaving=undefined;});return promise;}
  private artifactHeading(){
    const run=this.workspace?.artifact_run;if(!run||!this.workspace?.artifacts.length)return '';
    const source=this.workspace?.reports.find(report=>report.report_id===run.source_report_id);
    return `<div class="review-section-heading"><h3>执行版本 V${run.version} · ${operationLabels[run.operation]}成果</h3></div><p class="review-muted">${source?`基于报告 V${source.version}。`:''}${run.operation==='revision'?'下方保留来源报告的发现；本轮已生成修改文稿，是否通过需要再次明确复核。':'下载对应这次执行的成果，来源与限制保留在报告中。'}</p>`;
  }
  private handlingButton(){return this.workspace?.artifact_run?.operation==='revision'&&this.workspace.artifacts.some(a=>a.kind==='revision')?'<button class="btn secondary small" data-review-action="handling">处理清单</button>':'';}
  private showHandling(){
    const run=this.workspace?.artifact_run,artifact=this.workspace?.artifacts.find(a=>a.kind==='revision');
    if(!run||run.operation!=='revision'||!artifact)return;
    const report=this.workspace?.selected_report;
    this.handling.open({artifact,runId:run.run_id,version:run.version,sourceReportId:run.source_report_id,
      sourceReport:report?.report_id===run.source_report_id?report:undefined,materialNames:this.materialNames()});
  }
  private async persistInput(){
    while(this.inputDirty&&this.workspace&&this.draftInput&&this.live()){
      const sent=structuredClone(this.draftInput),version=this.workspace.draft.version;
      if(!Value.Check(ReviewDraftInputSchema,sent)){this.message('要求每行不超过 12,000 字，最多 100 行。请缩短后保存；本页草稿已保留。',true);return false;}
      try{await this.reviewApi.saveDraft({kind:'input',expected_version:version,input:sent});const saved=await this.reviewApi.drafts();if(!this.live())return false;const {version:savedVersion,...savedInput}=saved.draft;if(!Value.Check(ReviewDraftInputSchema,savedInput)||!Value.Equal(savedInput,sent))throw new ApiError(409,'INPUT_REVISION_CONFLICT');this.workspace.draft=saved.draft;if(Value.Equal(this.draftInput,sent)){this.inputDirty=false;this.draftInput=this.inputFrom(this.workspace);}this.cacheInput();this.renderMeta();this.message(isActiveRun(this.workspace.active_run)?'补充要求已保存，将用于下一轮；当前任务输入保持不变。':'材料与要求已保存；任务尚未启动。');}
      catch(error){if(!this.live())return false;if(error instanceof ApiError&&error.status===409){this.inputConflictVersion=version;this.renderMaterials();}this.message(`${friendlyError(error)} 本页草稿已保留。`,true);return false;}
    }return !this.inputDirty;
  }
  private async resolveInput(keepLocal:boolean){
    try{
      const state=await this.reviewApi.drafts();if(!this.workspace||!this.draftInput||!this.live())return;
      if(!keepLocal){this.workspace.draft=state.draft;this.inputConflictVersion=undefined;this.draftInput=this.inputFrom(this.workspace);this.inputDirty=false;this.cacheInput();this.renderMaterials();return;}
      const local=structuredClone(this.draftInput);
      const describe=(input:ReviewDraftInput)=>`<p>待复核稿：${esc(input.source_material_ref?.material_id??'未选择')} · V${input.source_material_ref?.material_version??'—'}</p><p>材料：${input.material_versions.map(m=>`${esc(m.material_id)} V${m.material_version}`).join('、')||'无'}</p><p>截止日：${esc(input.as_of??'未指定')}</p><ul>${input.requirements.map(r=>`<li>${esc(r)}</li>`).join('')||'<li>无特别要求</li>'}</ul><p>补证关联：${(input.evidence_links??[]).map(l=>`${esc(l.report_id)} / ${esc(l.finding_id)} / ${esc(l.material_ref.material_id)}`).join('；')||'无'}</p>`;
      this.openDialog('核对输入版本冲突',`<h3>服务器版本 V${state.draft.version}</h3>${describe(state.draft)}<h3>本页草稿</h3>${describe(local)}<p>确认后将本页材料选择与要求保存为新输入草稿；已开始任务的输入保持不变。</p>`,[{label:'将本页内容保存为新版',primary:true,action:async()=>{this.workspace!.draft=state.draft;this.draftInput=local;this.inputConflictVersion=undefined;this.inputDirty=true;if(await this.saveInput()){this.dialog?.close();this.renderMaterials();}}}]);
    }catch(error){this.message(friendlyError(error),true);}
  }

  private async selectFinding(id:string,selected:boolean){if(this.planSaving){this.renderResults();return;}const old=new Set(this.selections);if(selected)this.selections.add(id);else this.selections.delete(id);const saving=this.persistPlan([...this.selections]);this.renderResults();if(!await saving)this.selections=old;this.renderResults();}
  private async persistPlan(ids:string[],proposal?:ReviewProposal,sourceReportId?:string):Promise<Workspace['plan']>{
    const report=this.workspace?.selected_report;if(!report||!this.workspace||this.planSaving)return null;
    if(sourceReportId&&report.report_id!==sourceReportId){this.dialogStatus('报告已更新，请重新打开修订计划核对来源；当前计划未改变。');return null;}
    const plan=this.workspace.plan,previous=plan?.source_report_id===report.report_id?plan:null;
    const candidateOrigin=proposal??previous?.proposal_origin?.proposal;
    // A new shortcut plan keeps adopted requirements, while V2 adoption remains its own explicit API path.
    const origin=candidateOrigin&&!isTypedReviewProposal(candidateOrigin)?candidateOrigin:undefined;
    const request:ReviewPlanRequest={expected_version:plan?.version??0,source_report_id:report.report_id,finding_ids:ids,excluded_findings:report.findings.filter(f=>!ids.includes(f.finding_id)&&(f.repairability.can_revise||origin?.finding_ids.includes(f.finding_id))).map(f=>({finding_id:f.finding_id,reason:previous?.excluded_findings.find(e=>e.finding_id===f.finding_id)?.reason??(f.repairability.can_revise?'用户本次未选择修订':f.repairability.reason)})),requirements:proposal?.requirements??previous?.requirements??[],...(origin?{proposal_id:origin.proposal_id}:{})};
    this.planSaving=true;
    try{const saved=await this.reviewApi.plan(request);if(!this.live())return null;this.workspace.plan=saved;this.selections=new Set(saved.finding_ids);this.message('修订计划已保存；尚未执行。');return saved;}catch(error){const text=`${friendlyError(error)} 选择未确认，请刷新计划后重试。`;this.message(text,true);if(this.dialog?.open)this.dialogStatus(text);return null;}finally{this.planSaving=false;}
  }
  private async previewProposal(proposal:ReviewProposalV2){
    if(!this.workspace||proposal.project_id!==this.projectId)return;
    if(this.inputDirty){this.message('材料与要求草稿尚未保存。请先核对并保存，再确认助手提议。',true);this.setTab('materials');return;}
    let source=this.workspace.selected_report;
    if(proposal.source_report_id&&source?.report_id!==proposal.source_report_id){
      try{source=(await this.reviewApi.workspace(proposal.source_report_id)).selected_report;}catch(error){this.message(friendlyError(error),true);return;}
    }
    if(!this.live())return;
    const accepted=this.workspace.accepted_proposals?.find(item=>item.proposal.proposal_id===proposal.proposal_id);
    const selected=new Set(accepted?.finding_ids??[...proposal.finding_ids,...proposal.related_finding_ids]);
    const sourceName=this.workspace.reports.find(report=>report.report_id===proposal.source_report_id);
    const findings=source?.report_id===proposal.source_report_id?source.findings:[];
    const stale=!accepted&&proposal.input_version!==this.workspace.draft.version||Boolean(accepted&&accepted.input_version!==this.workspace.draft.version);
    const scope=proposal.operation==='full_review'?reviewScope(this.workspace.project.market,this.workspace.project.offering):findings.map(f=>`<label class="review-plan-item"><input type="checkbox" data-proposal-finding="${esc(f.finding_id)}" ${selected.has(f.finding_id)?'checked':''} ${proposal.operation==='revision'&&!f.repairability.can_revise?'disabled':''}><span><strong>${esc(f.finding_id)} · ${esc(f.title)}</strong><small>${f.target_refs.map(ref=>esc(sourceLocator(ref))).join('；')}</small><small>${proposal.related_finding_ids.includes(f.finding_id)?'关联影响范围 · ':''}${esc(f.suggested_change??f.repairability.reason)}</small></span></label>`).join('');
    const materials=proposal.material_versions.map(pin=>{const material=this.workspace!.materials.find(item=>sameMaterial(materialPin(item),pin));return `<li>${esc(material?.filename??'固定材料')} · V${pin.material_version}</li>`;}).join('');
    const contextName=this.workspace.reports.find(r=>r.report_id===proposal.context_report_ref?.report_id);
    this.openDialog(`核对${operationLabels[proposal.operation]}提议`,`<div class="review-notice"><strong>${operationLabels[proposal.operation]}</strong><p>${esc(proposal.explanation)}</p></div><dl><dt>固定输入</dt><dd>V${proposal.input_version}${accepted?` · 已采纳为 V${accepted.input_version}`:''}</dd><dt>执行来源报告</dt><dd>${proposal.source_report_id?`R${sourceName?.version??'—'}`:'完整三维复核，不缩为问题范围'}</dd>${proposal.context_report_ref?`<dt>讨论引用</dt><dd>${contextName?`R${contextName.version}`:'原讨论报告'}</dd>`:''}</dl><h3>本次固定材料</h3><ul>${materials||'<li>尚无固定材料，请先准备材料再重新形成提议。</li>'}</ul><h3>核验／修订范围</h3>${scope}${proposal.excluded_findings.length?`<h3>原提议排除项</h3><ul>${proposal.excluded_findings.map(item=>`<li>${esc(item.finding_id)}：${esc(item.reason)}</li>`).join('')}</ul>`:''}<label for="review-proposal-requirements"><h3>拟采纳的新要求</h3></label><textarea id="review-proposal-requirements" class="review-source-select" rows="3" maxlength="12000">${esc((accepted?.requirements??proposal.requirements).join('\n'))}</textarea><p class="review-muted">${proposal.operation==='differential_review'?'未选择对象沿用来源报告；本轮未执行、材料不足或无法映射的对象明确列为未完成，不会自动解决。':proposal.operation==='revision'?'只修改有依据的对象，完成后显示已修改待复核；不会自动重核。':'讨论中的关注点不会缩小完整复核请求；结果仍说明实际三维覆盖。'}采纳要求只保存下一输入；确认并开始才创建任务。</p>${stale?'<p class="review-warning">材料或要求已有新版本。该提议已过期，请向助手重新核对输入和范围；不会静默更换来源执行。</p>':''}`,[
      {label:'仅采纳要求，暂不执行',action:()=>this.adoptProposal(proposal,false,findings)},
      {label:proposal.operation==='revision'?'确认并开始修订':'确认并开始重新核验',primary:true,action:()=>this.adoptProposal(proposal,true,findings)},
    ]);
    if(stale)this.dialog?.querySelectorAll<HTMLButtonElement>('[data-dialog-action]').forEach(button=>button.disabled=true);
  }

  private async adoptProposal(proposal:ReviewProposalV2,start:boolean,findings:ReviewFinding[]){
    if(!this.workspace)return;
    const ids=proposal.operation==='full_review'?[]:[...this.dialog!.querySelectorAll<HTMLInputElement>('[data-proposal-finding]:checked')].map(input=>input.dataset.proposalFinding!);
    if(proposal.operation!=='full_review'&&!ids.length){this.dialogStatus('请选择至少一项，空任务不会执行。');return;}
    const requirements=this.dialog!.querySelector<HTMLTextAreaElement>('#review-proposal-requirements')!.value.split('\n').map(text=>text.trim()).filter(Boolean);
    const exclusions=proposal.operation==='full_review'?[]:findings.filter(f=>!ids.includes(f.finding_id)).map(f=>({finding_id:f.finding_id,reason:proposal.excluded_findings.find(item=>item.finding_id===f.finding_id)?.reason??'用户确认本轮不处理，保留来源报告结论'}));
    let accepted=!this.adoptionPending?this.workspace.accepted_proposals?.find(item=>item.proposal.proposal_id===proposal.proposal_id&&Value.Equal([...item.finding_ids].sort(),[...ids].sort())&&Value.Equal(item.requirements,requirements)):undefined;
    if(!accepted){
      const base={proposal_id:proposal.proposal_id,expected_input_version:proposal.input_version,finding_ids:ids,excluded_findings:exclusions,requirements};
      if(this.adoptionPending){const {adoption_request_id,...previous}=this.adoptionPending;if(!Value.Equal(previous,base)){this.dialogStatus('先恢复原提议的采纳结果，再调整新范围。原请求已保留，未创建任务。');return;}}
      const request=this.adoptionPending??{...base,adoption_request_id:crypto.randomUUID()};this.adoptionPending=request;
      try{localStorage.setItem(this.adoptionKey,JSON.stringify(request));}catch{this.dialogStatus('浏览器无法保留采纳凭据，请保持页面打开直至结果确认。');}
      try{
        const result=await this.reviewApi.adopt(request);if(!this.live())return;
        if(result.accepted_proposal.proposal.project_id!==this.projectId||result.accepted_proposal.proposal.proposal_id!==proposal.proposal_id)throw new ApiError(0,'DATA_UNAVAILABLE');
        accepted=result.accepted_proposal;
        if(this.workspace.draft.version<=result.draft.version){this.workspace.draft=result.draft;this.draftInput=this.inputFrom(this.workspace);this.inputDirty=false;this.cacheInput();this.workspace.plan=result.plan;}
        this.workspace.accepted_proposals=[...(this.workspace.accepted_proposals??[]).filter(item=>item.acceptance_id!==accepted!.acceptance_id),accepted];this.syncSelections();this.adoptionPending=undefined;try{localStorage.removeItem(this.adoptionKey);}catch{}
      }catch(error){
        if(error instanceof ApiError&&error.status>=400&&error.status<500&&![408,429].includes(error.status)){this.adoptionPending=undefined;try{localStorage.removeItem(this.adoptionKey);}catch{}}
        this.dialogStatus(`${friendlyError(error)} ${this.adoptionPending?'采纳结果尚未确认，重试沿用同一请求；尚未执行任务。':'请重新核对提议的材料与来源版本。'}`);return;
      }
    }
    if(!start){this.dialog?.close();this.renderBody();this.message('要求已明确采纳到下一输入，任务尚未开始。');return;}
    if(this.workspace.draft.version!==accepted.input_version){this.dialogStatus('已采纳要求之后输入已有变化，请重新核对提议；尚未执行。');return;}
    const base:Omit<ReviewExecutionRequest,'execution_request_id'>={operation:proposal.operation,expected_input_version:accepted.input_version,source_report_id:proposal.operation==='full_review'?null:proposal.source_report_id,expected_plan_version:proposal.operation==='revision'?this.workspace.plan?.version??null:null,finding_ids:proposal.operation==='full_review'?[]:accepted.finding_ids,entrypoint:'assistant_proposal',accepted_proposal_id:accepted.acceptance_id,context_report_ref:proposal.context_report_ref};
    await this.execute(base);
  }

  private async previewPlan(proposal?:ReviewProposal){
    const report=this.workspace?.selected_report;if(!report)return;
    if(proposal&&proposal.source_report_id!==report.report_id){this.message(`该提议来自 ${proposal.source_report_id}，请从工作台打开对应报告后核对，当前选择未改变。`,true);return;}
    if(!proposal){
      if(this.executionPending){this.openDialog('核对待确认的原任务',`<p>有一项 ${operationLabels[this.executionPending.operation]} 的提交结果尚未确认。先重试原请求获取状态，再开始新的范围。</p>`,[{label:'核对原请求状态',primary:true,action:()=>this.execute(this.executionPending!)}]);return;}
      if(this.uploading){this.message('材料仍在上传，请等待保存确认。',true);return;}
      if(!await this.saveInput()||!this.live()||this.workspace?.selected_report?.report_id!==report.report_id)return;
    }
    if(!this.workspace||!this.draftInput)return;
    const input=structuredClone(this.draftInput),inputVersion=this.workspace.draft.version,planVersion=this.workspace.plan?.version??0;
    const previousPlan=this.workspace.plan?.source_report_id===report.report_id?this.workspace.plan:null;
    const planRequirements=proposal?.requirements??previousPlan?.requirements??[];
    const source=input.source_material_ref?this.workspace.materials.find(material=>sameMaterial(materialPin(material),input.source_material_ref!)):undefined;
    const selected=new Set(proposal?proposal.finding_ids:this.selections);
    const applicable=report.findings.filter(f=>f.repairability.can_revise);
    const origin=this.workspace?.plan?.source_report_id===report.report_id?this.workspace.plan.proposal_origin:undefined;
    const sourceProposal=proposal??origin?.proposal;
    const unavailable=sourceProposal?report.findings.filter(f=>sourceProposal.finding_ids.includes(f.finding_id)&&!f.repairability.can_revise):[];
    const proposalNotice=sourceProposal?`<div class="review-notice"><strong>助手原提议 · ${esc(sourceProposal.proposal_id)}</strong><p>${esc(sourceProposal.explanation)}</p><p>原提议问题：${sourceProposal.finding_ids.map(esc).join('、')||'无'}</p>${sourceProposal.requirements.length?`<ul>${sourceProposal.requirements.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}<p>${proposal?'可调整下方勾选；采纳以本次核对后的选择为准，原提议保留。':origin?.adoption==='user_adjusted'?'当前计划经用户调整，原提议未改变。':'当前计划沿用原提议，执行仍需单独确认。'}</p></div>${unavailable.length?`<div class="review-notice">以下提议事项缺少修订依据，不纳入本次修订，原结论保留：<ul>${unavailable.map(f=>`<li>${esc(f.finding_id)}：${esc(f.repairability.reason)}</li>`).join('')}</ul></div>`:''}`:'';
    let confirmedBase:Omit<ReviewExecutionRequest,'execution_request_id'>|undefined,planDialog:HTMLDialogElement|undefined;
    const inputUnchanged=()=>Boolean(this.workspace&&this.draftInput&&!this.inputDirty&&this.workspace.draft.version===inputVersion&&Value.Equal(this.draftInput,input)&&this.workspace.selected_report?.report_id===report.report_id&&this.workspace.selected_report.version===report.version);
    const executionDetails=!proposal?`<dl><dt>固定输入</dt><dd>V${inputVersion}</dd><dt>源稿</dt><dd>${source?`${esc(source.filename)} · V${source.material_version}`:'尚未选择待复核募集书'}</dd><dt>材料范围</dt><dd>${input.material_versions.length} 份固定材料</dd></dl><h3>本次输入要求</h3><ul>${input.requirements.map(requirement=>`<li>${esc(requirement)}</li>`).join('')||'<li>无特别要求</li>'}</ul>${planRequirements.length?`<h3>修订计划要求</h3><ul>${planRequirements.map(requirement=>`<li>${esc(requirement)}</li>`).join('')}</ul>`:''}`:'';
    this.openDialog(proposal?'核对助手提议':'核对修订计划',`<p>来源报告 <strong>${esc(report.report_id)}</strong> · R${report.version}。${proposal?'采纳后才更新勾选，仍不会执行任务。':'仅修改下方选中且证据充分的内容；确认后直接执行。'}</p>${executionDetails}${proposalNotice}${applicable.map(f=>`<label class="review-plan-item"><input type="checkbox" data-plan-finding="${esc(f.finding_id)}" ${selected.has(f.finding_id)?'checked':''}><span><strong>${esc(f.finding_id)} · ${esc(f.title)}</strong><small>${f.target_refs.map(ref=>esc(sourceLocator(ref))).join('；')}</small><small>${esc(f.suggested_change??f.repairability.reason)}</small></span></label>`).join('')||'<p>当前没有具备修订依据的问题，不能创建空修订任务。</p>'}<p class="review-muted">未选及待补证事项保留原结论。关联引用、章节和样式要求随计划一起核对。${!proposal?'开始后锁定本次输入，新的材料与说明进入下一版。修订完成不代表复核通过，再次复核需另行明确执行。':''}</p>`,[{label:proposal?'采纳计划':'保存计划',primary:true,action:async()=>{if(confirmedBase||this.executionPending){this.dialogStatus('原执行结果尚未确认，请重试原请求；不能改变已确认范围。');return;}const ids=[...planDialog!.querySelectorAll<HTMLInputElement>('[data-plan-finding]:checked')].map(i=>i.dataset.planFinding!);if(await this.persistPlan(ids,proposal,report.report_id)){planDialog?.close();this.renderResults();}}},...(!proposal?[{label:'确认范围并执行修订',primary:false,action:async()=>{
      if(confirmedBase){await this.execute(confirmedBase);return;}
      if(isActiveRun(this.workspace?.active_run)){this.dialogStatus('同一项目已有任务进行中，请先查看当前任务。');return;}
      if(this.uploading){this.dialogStatus('材料仍在上传，请等待保存确认。');return;}
      if(this.executionPending){this.dialogStatus('有一项提交结果尚未确认，请先恢复原请求。');return;}
      if(!inputUnchanged()||(this.workspace?.plan?.version??0)!==planVersion){this.dialogStatus('输入或修订计划已变化，请重新打开计划核对；本次尚未执行。');return;}
      if(!input.source_material_ref||!sameMaterial(input.source_material_ref,report.source_material)){this.dialogStatus('当前源稿与来源报告不一致，请先在材料页核对；本次尚未执行。');return;}
      const checkboxes=[...planDialog!.querySelectorAll<HTMLInputElement>('[data-plan-finding]')],ids=checkboxes.filter(checkbox=>checkbox.checked).map(checkbox=>checkbox.dataset.planFinding!);
      if(!ids.length){this.dialogStatus('请选择至少一项有依据的修改。');return;}
      checkboxes.forEach(checkbox=>checkbox.disabled=true);
      const saved=await this.persistPlan(ids,undefined,report.report_id);
      if(!saved){checkboxes.forEach(checkbox=>checkbox.disabled=false);return;}
      if(!planDialog?.open||this.dialog!==planDialog||!this.live())return;
      if(!inputUnchanged()||this.workspace?.plan?.version!==saved.version||saved.source_report_id!==report.report_id||!Value.Equal([...saved.finding_ids].sort(),[...ids].sort())||!Value.Equal(saved.requirements,planRequirements)){this.dialogStatus('输入或修订计划已变化，请重新打开计划核对；计划已保存，本次尚未执行。');return;}
      confirmedBase={operation:'revision',expected_input_version:inputVersion,source_report_id:report.report_id,expected_plan_version:saved.version,finding_ids:[...saved.finding_ids],entrypoint:'quick_action'};
      await this.execute(confirmedBase);
    }}]:[])]);
    planDialog=this.dialog;
  }

  private async previewExecution(operation:Operation,sourceReport:string|null,findings:string[]){
    if(this.starting)return;this.starting=true;this.renderMaterials();
    try{
    if(this.executionPending){await this.execute(this.executionPending);return;}
    if(!this.workspace||!this.draftInput)return;
    if(isActiveRun(this.workspace.active_run)){this.message('同一项目已有任务进行中，请查看当前状态。',true);this.setTab('results');return;}
    if(this.deletingMaterial){this.message('正在删除材料，请稍候。');return;}
    if(this.uploadRows.size){this.message(this.uploading?'材料仍在上传或保存，请等待全部保存确认。':'有文件尚未保存，请重试或移除失败文件后开始。',true);this.setTab('materials');return;}
    if(!await this.saveInput())return;
    if(!this.draftInput.source_material_ref){this.message('请先选择已上传的待复核募集书。',true);this.setTab('materials');return;}
    if(operation!=='full_review'&&(!sourceReport||!findings.length)){this.message('请明确本轮问题范围，空任务不会执行。',true);return;}
    const requestBase:Omit<ReviewExecutionRequest,'execution_request_id'>={operation,expected_input_version:this.workspace.draft.version,source_report_id:sourceReport,expected_plan_version:operation==='revision'?this.workspace.plan?.version??null:null,finding_ids:[...findings]};
    await this.execute(requestBase);
    }finally{this.starting=false;if(this.live()){this.renderMaterials();this.message(this.status,this.statusError);}}
  }
  private async execute(base:Omit<ReviewExecutionRequest,'execution_request_id'>,confirmed?:ReviewExecutionRequest){
    if(!this.workspace)return;
    if(isActiveRun(this.workspace.active_run)&&!(this.executionPending&&this.workspace.active_run?.execution_request_id===this.executionPending.execution_request_id&&executionIdentity(this.executionPending)===executionIdentity(base))){this.dialogStatus('同一项目已有任务进行中，请先查看当前任务。要求可以保留到下一版。');this.message('当前活动任务仍使用原固定输入，未创建第二项任务。',true);return;}
    if(this.executionPending&&executionIdentity(this.executionPending)!==executionIdentity(base)){this.dialogStatus('原执行提交结果尚未确认，请先恢复同一原请求，不能提交新的执行意图。');return;}
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${this.owner}:${this.projectId}:${executionIdentity(base)}:${this.run&&!isActiveRun(this.run)?this.run.run_id:''}`));
    const execution_request_id=this.executionPending&&executionIdentity(this.executionPending)===executionIdentity(base)?this.executionPending.execution_request_id:'m3-'+[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
    const request:ReviewExecutionRequest=confirmed??this.executionPending??{...base,execution_request_id};
    if(!confirmed&&!this.executionPending){
      try{const quote=await this.reviewApi.quoteExecution(request);if(!this.live())return;if(!this.applyCredits(quote,request))return;}
      catch(error){this.dialogStatus(friendlyError(error));this.message(friendlyError(error),true);return;}
    }
    this.executionPending=request;
    if(this.dialog?.open)this.dialog.dataset.executionRequestId=execution_request_id;
    try{localStorage.setItem(this.executionKey,JSON.stringify(request));}catch{this.dialogStatus('浏览器无法保存重试凭据，请保持页面打开直至提交确认。');}
    try{
      const run=await this.reviewApi.execute(request);if(!this.live())return;
      if(run.project_id!==this.projectId||run.execution_request_id!==execution_request_id)throw new ApiError(0,'DATA_UNAVAILABLE');
      this.executionPending=undefined;try{localStorage.removeItem(this.executionKey);}catch{}
      this.focusedTaskRunId=undefined;this.run=run;this.workspace.active_run=isActiveRun(run)?run:null;this.reportId=undefined;this.dialog?.close();if(this.tab==='materials')this.setTab('making');this.message(isActiveRun(run)?'任务已提交，本次输入已锁定。':`原任务状态已确认：${runStateLabel[run.state]}。新一轮需要重新确认执行。`);this.renderBody();await this.refresh();
    }catch(error){
      if(error instanceof ApiError&&error.status>=400&&error.status<500&&![408,429].includes(error.status)){
        this.executionPending=undefined;try{localStorage.removeItem(this.executionKey);}catch{}this.dialog?.close();await this.refresh();this.message(`${friendlyError(error)} 请重新核对输入与范围后再执行。`,true);
      }else{this.dialogStatus(`${friendlyError(error)} 重试沿用同一请求，不会重复执行。`);this.message('提交结果暂未确认。点击“开始复核”重试原请求，或刷新查看状态；不会重复创建任务。',true);}
    }
  }
  private applyCredits(quote:Dto<'FixedQuoteResponse'>,request:ReviewExecutionRequest):boolean {
    if(!quote.enabled)return true;
    if(!quote.quote)throw new ApiError(503,'BILLING_NOT_READY');
    if(quote.quote.task_type in DYNAMIC_REVIEW_BILLING_TASKS?quote.balance.available<1:quote.shortage>0){
      this.openDialog('积分不足',`<p>积分不足，请充值后继续任务。</p><p>本次材料、要求与问题范围已保留。充值到账后请返回项目明确开始，任务不会自动执行。</p><a class="btn primary" href="#/account?project=${encodeURIComponent(this.projectId)}" id="review-recharge-link">充值积分</a>`,[]);
      this.dialog?.querySelector('#review-recharge-link')?.addEventListener('click',()=>this.dialog?.close());
      return false;
    }
    request.quote_id=quote.quote.quote_id;
    return true;
  }
  private renderCharge(){
    const run=this.progressTask()?.run??this.workspace?.active_run??this.run,host=this.page?.querySelector<HTMLElement>('#review-credit-receipt');if(!host)return;
    host.hidden=true;if(!run)return;
    const key=run.run_id+':'+run.state;
    if(this.chargeLoading||this.chargeKey===key&&Date.now()-this.chargeFetchedAt<1500)return;
    this.chargeLoading=true;
    void this.api.runCharge(run.run_id,this.controller.signal).then(charge=>{
      const current=this.progressTask()?.run??this.workspace?.active_run??this.run;
      if(!this.live()||current?.run_id!==run.run_id||current?.state!==run.state)return;
      const changed=charge.progress?.policy==='authoring_balance_v2'&&(charge.progress.charged_points!==this.charge?.progress?.charged_points||charge.progress.available_points!==this.charge?.progress?.available_points);
      this.charge=charge;this.chargeKey=key;this.chargeError=false;
      if(changed)window.dispatchEvent(new Event('bondbuddy:credits-changed'));
      if(charge.progress?.credit_exhausted&&this.creditPromptRun!==run.run_id){this.creditPromptRun=run.run_id;this.rechargeDialog();}
      if(!charge.progress?.credit_exhausted)this.creditPromptRun=undefined;
    }).catch(()=>{if(this.live())this.chargeError=true;}).finally(()=>{this.chargeLoading=false;this.chargeFetchedAt=Date.now();if(this.live())this.renderMaking();});
  }
  private rechargeDialog(){
    this.openDialog('积分已用完','<p>当前复核会在保存进度后暂停，已完成的工作保留。充值到账后继续同一任务。</p><a class="btn primary" id="review-recharge-link" href="#/account?project='+encodeURIComponent(this.projectId)+'">充值积分</a>',[]);
    this.dialog?.querySelector('#review-recharge-link')?.addEventListener('click',()=>this.dialog?.close());
  }
  private async controlRun(action:'pause'|'resume'){
    const run=this.progressTask()?.run??this.workspace?.active_run??this.run;if(!run)return;
    try{await this.api.runAction(run.run_id,action,this.controller.signal);this.chargeFetchedAt=0;await this.refresh();this.message(action==='pause'?'暂停请求已提交，当前处理保存后暂停。':'已请求继续本轮复核。');}catch(error){this.message(friendlyError(error),true);}
  }
  private connectProgressStream(){
    const run=this.workspace?.active_run??this.run;
    if(!run||!isActiveRun(run)){this.eventStream?.close();this.eventStream=undefined;this.streamRun=undefined;return;}
    if(this.streamRun===run.run_id||typeof EventSource==='undefined')return;
    this.eventStream?.close();this.streamRun=run.run_id;
    const stream=this.eventStream=new EventSource('/api/v1/runs/'+encodeURIComponent(run.run_id)+'/stream');
    const changed=()=>{if(this.live())void this.refresh();};
    for(const type of ['run.progress','run.state_changed','artifact.ready'])stream.addEventListener(type,changed);
  }
  private async cancelRun(){const run=this.workspace?.active_run??this.run;if(!run||!isActiveRun(run))return;try{const saved=await this.api.runAction(run.run_id,'cancel',this.controller.signal);if(!this.live())return;this.run=saved;this.message('停止请求已提交；本轮版本记录会保留。');await this.refresh();}catch(error){this.message(friendlyError(error),true);}}

  private explain(finding:ReviewFinding){
    this.openDialog('问题解释',`<span class="review-tag">${esc(finding.finding_id)}</span><h3>${esc(finding.title)}</h3><p>${esc(finding.description)}</p><h4>核验依据</h4>${evidenceHtml(finding.evidence_refs,'尚无可核实的材料证据。',this.materialNames(),true)}${rulesHtml(finding)}${finding.suggested_change?`<p><strong>建议</strong> ${esc(finding.suggested_change)}</p>`:''}<p>${esc(finding.repairability.reason)}</p>${finding.limitations.length?`<p class="review-warning">${finding.limitations.map(esc).join('；')}</p>`:''}`,[{label:'补充复核要求',action:()=>{this.dialog?.close();this.focusRequirements(finding);}}]);
    this.dialog?.addEventListener('click',event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-review-action="source"]');if(target)this.showSource(finding,target);});
  }
  private showSource(finding:ReviewFinding,target:HTMLElement){
    const refs=[...finding.target_refs,...finding.evidence_refs].filter(ref=>ref.material_id===target.dataset.materialId&&String(ref.material_version)===target.dataset.materialVersion&&ref.material_sha256===target.dataset.materialSha);
    if(!refs.length){this.message('材料引用已变化，请刷新复核结果后重试。',true);return;}
    const pin=refs[0],name=this.materialNames()[pin.material_id]??'引用材料';
    const unique=refs.filter((ref,index)=>refs.findIndex(other=>Value.Equal(other,ref))===index);
    this.openDialog('依据定位',`<p class="review-tag">${esc(finding.finding_id)} · ${esc(name)} · V${pin.material_version}</p><h3>${esc(finding.title)}</h3>${unique.map(ref=>`<blockquote class="review-source"><p>${esc(ref.quote)}</p><footer>${esc(sourceLocator(ref))}</footer>${ref.uncertainty.length?`<p class="review-warning">${ref.uncertainty.map(esc).join('；')}</p>`:''}</blockquote>`).join('')}<p class="review-muted">以上是本次复核引用的材料摘录与定位。下载原材料后，可按所列位置核对全文。</p>`,[{label:'下载原材料',primary:true,action:async()=>{
      const material=await this.api.material(this.projectId,pin.material_id,this.controller.signal);
      if(material.material_id!==pin.material_id||material.material_version!==pin.material_version||material.sha256!==pin.material_sha256||material.state!=='persisted')throw new ApiError(409,'INPUT_REVISION_CONFLICT');
      const bytes=await this.api.materialBytes(this.projectId,material,this.controller.signal);if(!this.live())return;
      this.downloads.save(bytes,material.filename);this.dialogStatus('原材料已校验并开始下载。');
    }}]);
  }
  private coverage(dimension:string){const report=this.workspace?.selected_report;if(!report)return;this.openDialog('检查覆盖',`<p>报告 ${esc(report.report_id)}。本轮核验与沿用记录分别列出。</p>${report.coverage.filter(c=>c.dimension===dimension).map(c=>`<article class="review-history-entry"><h3>${esc(c.check_id)}</h3><p>${{pass:'通过',issue:'发现问题',needs_evidence:'待补证',manual:'待人工判断',uncovered:'未覆盖',not_applicable:'不适用'}[c.outcome]} · ${c.check_status==='rechecked'?'本轮核验':`沿用 ${esc(c.origin_report_id)}`}</p><p>${esc(c.reason)}</p></article>`).join('')||'<p>没有可确认的检查执行记录，不能据此认定通过。</p>'}`,[]);}

  private uploadDialog(context?:ReviewContext){
    const target=context?structuredClone(context):undefined;
    this.openDialog(target?'为此问题补充材料':'上传项目材料',`${target?`<div class="review-notice">补证目标：${esc(target.report_id)} · ${target.finding_ids.map(esc).join('、')}。该补证对象固定保留。</div>`:''}<label for="review-upload-role">材料类型</label><select id="review-upload-role" class="review-source-select">${Object.entries(roleLabels).filter(([role])=>!target||role!=='historical').map(([role,label])=>`<option value="${role}" ${target&&role==='other'?'selected':''}>${label}</option>`).join('')}</select><label for="review-upload-file">选择 DOCX／PDF／XLSX／CSV／TXT 或图片</label><input id="review-upload-file" type="file" multiple accept=".docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg"><p class="review-muted">文件会真实上传到当前项目。保存材料不自动开始复核。</p><div id="review-upload-progress" role="status"></div>`,[{label:'上传并保存',primary:true,action:async()=>{const input=this.dialog!.querySelector<HTMLInputElement>('#review-upload-file')!;if(!input.files?.length){this.dialogStatus('请选择文件。');return;}const role=this.dialog!.querySelector<HTMLSelectElement>('#review-upload-role')!.value as Dto<'MaterialResponse'>['role'];await this.upload([...input.files],role,target);}}]);
  }
  private async deleteMaterial(id:string){
    const material=this.workspace?.materials.find(m=>m.material_id===id);
    if(!material||!this.workspace||!this.draftInput||this.deletingMaterial||this.uploading)return;
    if(isActiveRun(this.workspace.active_run)||this.executionPending){this.message('请先停止或确认当前任务，停止完成后可删除材料。',true);return;}
    if(!window.confirm(`确定删除“${material.filename}”？删除后可重新上传正确文件。已提交任务的输入与历史成果保持不变。`))return;
    this.deletingMaterial=id;this.readGeneration++;this.renderMaterials();
    try{
      if(this.inputSaving)await this.inputSaving;
      if(!this.live())return;
      await this.api.deleteMaterial(this.projectId,id);
      if(!this.live())return;
      this.workspace.materials=this.workspace.materials.filter(m=>m.material_id!==id);
      this.draftInput.material_versions=this.draftInput.material_versions.filter(m=>m.material_id!==id);
      if(this.draftInput.source_material_ref?.material_id===id)this.draftInput.source_material_ref=null;
      if(this.draftInput.evidence_links)this.draftInput.evidence_links=this.draftInput.evidence_links.filter(link=>link.material_ref.material_id!==id);
      for(const [key,row] of this.uploadRows)if(row.material?.material_id===id)this.uploadRows.delete(key);
      for(const [key,attempt] of this.uploadAttempts)if(attempt.material?.material_id===id)this.uploadAttempts.delete(key);
      this.inputDirty=true;this.cacheInput();this.renderMaterials();
      if(await this.saveInput())this.message('材料已删除，可以重新上传正确文件。');
      else this.message('材料已删除，草稿选择尚未保存。请处理保存提示后重试保存。',true);
    }catch(error){if(this.live())this.message(`删除未完成。${friendlyError(error)} 请重试删除。`,true);}
    finally{this.deletingMaterial=undefined;if(this.live())this.renderMaterials();}
  }
  private async upload(files:File[],role:Dto<'MaterialResponse'>['role'],target?:ReviewContext){
    if(this.deletingMaterial){this.message('正在删除材料，请稍候再上传。');return false;}
    if(!this.workspace||!this.draftInput||!this.live())return;
    const dialog=this.dialog?.open?this.dialog:undefined;
    const pending:Promise<boolean>[]=[];
    for(const file of files){
      const key=JSON.stringify([file.name,role,file.size,file.lastModified,target?.report_id,target?.finding_ids]);
      const existing=this.uploadRows.get(key);
      if(existing&&!existing.error)continue;
      const row:UploadRow={file,role,target,material:existing?.material,state:'等待上传…',error:false};
      this.uploadRows.set(key,row);
      pending.push(new Promise<boolean>(done=>this.uploadQueue.push({key,row,done})));
    }
    if(!pending.length){this.message('这些文件已在上传队列中，无需重复选择。');return;}
    this.message('文件已加入队列，可继续选择其他材料。请保持页面打开，等待保存完成。');
    void this.drainUploads();
    this.renderMaterials();
    const saved=await Promise.all(pending);
    if(!this.live()||saved.some(value=>!value))return;
    if(dialog&&this.dialog===dialog)dialog.close();
    if(target?.report_id&&!this.uploading)this.openDialog('材料已补充，核对下一步',`<p>原补证对象：<strong>${esc(target.report_id)} · ${target.finding_ids.map(esc).join('、')}</strong></p><p>新材料用于下一轮。只重核已列问题；未触及问题仍沿用原结果。</p>`,[{label:'核对并重新核验',primary:true,action:async()=>{this.dialog?.close();await this.previewExecution('differential_review',target.report_id,target.finding_ids);}}]);
  }
  private async drainUploads(){
    if(this.uploading||!this.workspace||!this.draftInput)return;
    this.uploading=true;
    try{
      // Keep byte upload, completion and draft selection in one serial queue.
      // Another selection can be enqueued immediately without racing draft versions.
      while(this.uploadQueue.length&&this.live()){
        const {key:rowKey,row,done}=this.uploadQueue.shift()!;
        const {file,role,target}=row;
        const progress=this.dialog?.querySelector<HTMLElement>('#review-upload-progress');
        const state=(text:string)=>{row.state=text;if(progress?.isConnected)progress.textContent=`${file.name} · ${text}`;if(this.live())this.renderMaterials();};
        try{
        if(!await this.saveInput())throw new Error('材料与要求尚未保存，请核对后重试此文件。');
        const extension=file.name.toLowerCase().split('.').at(-1)??'',media=mimeTypes[extension];
        if(!media||(role==='historical'&&!['docx','pdf'].includes(extension)))throw new Error('待复核募集书只支持 DOCX 或 PDF；其他材料请选择支持的文件类型。');
        if(!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)throw new Error('单份文件须大于 0 且不超过 100 MB。');
        state('正在检查文件…');
        const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());const sha256=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
        if(!this.live()){done(false);break;}
        const key=JSON.stringify([file.name,role,sha256]);let attempt=this.uploadAttempts.get(key);
        if(!attempt){const session=await this.api.createUpload(this.projectId,{filename:file.name,media_type:media,byte_size:file.size,sha256,role},this.controller.signal);attempt={session,bytesSaved:false};this.uploadAttempts.set(key,attempt);}
        if(!attempt.bytesSaved){state('正在上传 0%…');await this.api.uploadBytes(attempt.session.upload_url,file,(loaded,total)=>{const percent=Math.min(100,Math.round(100*loaded/Math.max(total,1)));state(percent===100?'传输完成，正在保存到服务器…':`正在上传 ${percent}%…`);},this.controller.signal);attempt.bytesSaved=true;}
        state('传输完成，正在保存到服务器…');
        const material=attempt.material??await this.api.completeUpload(this.projectId,attempt.session.upload_id,{byte_size:file.size,sha256},this.controller.signal);attempt.material=material;
        if(!this.live()){done(false);break;}if(material.sha256!==sha256||material.state!=='persisted')throw new ApiError(0,'DATA_UNAVAILABLE');
        row.material=material;state('文件已保存，正在保存材料选择…');
        const pin=materialPin(material);this.workspace.materials=this.workspace.materials.filter(m=>m.material_id!==material.material_id).concat(material);
        this.draftInput.material_versions=this.draftInput.material_versions.filter(m=>m.material_id!==pin.material_id).concat(pin);
        if(['historical','reference'].includes(role)&&!this.draftInput.source_material_ref)this.draftInput.source_material_ref=pin;
        if(target?.report_id){const links=this.draftInput.evidence_links??[];for(const finding_id of target.finding_ids)if(!links.some(link=>link.report_id===target.report_id&&link.finding_id===finding_id&&sameMaterial(link.material_ref,pin)))links.push({report_id:target.report_id,finding_id,material_ref:pin});this.draftInput.evidence_links=links;}
        this.inputDirty=true;this.cacheInput();if(!await this.saveInput())throw new Error('文件已上传，材料选择尚未保存。重试此文件将继续保存，不重复上传。');
        this.uploadRows.delete(rowKey);done(true);
        }catch(error){
          const text=error instanceof ApiError||error instanceof TypeError||error instanceof DOMException?friendlyError(error)+' 可以重试原上传确认保存状态。':error instanceof Error?error.message:'上传未确认，请重新读取材料状态。';
          row.state=text;row.error=true;this.dialogStatus(text);if(this.live())this.message(text,true);done(false);
        }
        if(this.live())this.renderMaterials();
      }
    }finally{
      this.uploading=false;
      if(!this.live())this.uploadQueue.splice(0).forEach(item=>item.done(false));
      else{this.renderMaterials();this.renderMeta();if(!this.uploadRows.size)this.message('全部材料已保存，可以开始复核。');}
    }
  }
  private async downloadTaskArtifact(runId:string,id:string){
    const task=this.workspace?.timeline?.find(entry=>entry.kind==='task'&&entry.task.run.run_id===runId);
    if(task?.kind!=='task')return;
    const artifact=task.task.artifacts.find(item=>item.artifact_id===id);if(!artifact)return;
    try{const metadata=await this.api.artifact(id,this.controller.signal);if(metadata.run_id!==runId||metadata.artifact_id!==id||metadata.version!==artifact.artifact_version)throw new ApiError(0,'DATA_UNAVAILABLE');const bytes=await this.api.artifactBytes(metadata,this.controller.signal);if(!this.live())return;this.downloads.save(bytes,metadata.filename ?? artifact.filename);this.message('对应任务的文档已校验并开始下载。');}catch(error){this.message(artifactError(error),true);}
  }
  private async download(id:string){try{const artifact=this.workspace?.artifacts.find(a=>a.artifact_id===id);if(!artifact)return;const metadata=await this.api.artifact(id,this.controller.signal);if(metadata.artifact_id!==id||metadata.version!==artifact.artifact_version||metadata.quality_status!=='passed')throw new ApiError(0,'DATA_UNAVAILABLE');const bytes=await this.api.artifactBytes(metadata,this.controller.signal);if(!this.live())return;this.downloads.save(bytes,metadata.filename ?? artifact.filename);this.message('文档已校验并开始下载。');}catch(error){this.message(artifactError(error),true);}}

  refresh():Promise<void>{if(this.refreshing)return this.refreshing;const promise=this.loadWorkspace();this.refreshing=promise;void promise.finally(()=>{if(this.refreshing===promise)this.refreshing=undefined;});return promise;}
  private mergeWorkspace(workspace:Workspace):Workspace {
    if(!workspace.timeline)return workspace;
    const timeline=uniqueReviewTimeline([...(this.workspace?.timeline??[]),...workspace.timeline]);
    const activeTask=timeline.find(entry=>entry.kind==='task'&&entry.task.run.run_id===workspace.active_run?.run_id);
    return {...workspace,timeline,active_run:activeTask?.kind==='task'?(isActiveRun(activeTask.task.run)?activeTask.task.run:null):workspace.active_run};
  }
  private async loadWorkspace(){
    const generation=++this.readGeneration;
    try{
      const fresh=await this.reviewApi.workspace(this.reportId);if(!this.live()||generation!==this.readGeneration||this.uploading||this.deletingMaterial)return;
      const workspace=this.mergeWorkspace(fresh);this.workspace=workspace;
      if(!this.inputDirty)this.draftInput=this.inputFrom(workspace);if(!this.planSaving)this.syncSelections();
      if(workspace.active_run)this.run=workspace.active_run;
      else if(this.run&&isActiveRun(this.run)){
        const task=workspace.timeline?.find(entry=>entry.kind==='task'&&entry.task.run.run_id===this.run?.run_id);
        const observed=task?.kind==='task'?task.task.run:await this.api.run(this.run.run_id,this.controller.signal);
        if(!this.live()||generation!==this.readGeneration)return;this.run=observed;
      }
      if(!this.live()||generation!==this.readGeneration)return;this.renderBody();
      if(this.executionPending&&this.run?.execution_request_id===this.executionPending.execution_request_id){
        if(this.dialog?.dataset.executionRequestId===this.executionPending.execution_request_id)this.dialog.close();
        this.executionPending=undefined;
      }
      if(!this.executionPending){try{localStorage.removeItem(this.executionKey);}catch{}}
    }catch(error){if(this.live()&&generation===this.readGeneration)this.message(`状态暂未更新。${friendlyError(error)}`,true);}finally{this.schedulePoll();}
  }
  private schedulePoll(){this.connectProgressStream();clearTimeout(this.pollTimer);if(this.live()&&(isActiveRun(this.workspace?.active_run)||isActiveRun(this.run)||this.workspace?.messages.some(m=>m.role==='user'&&['queued','running'].includes(m.reply_status))))this.pollTimer=setTimeout(()=>void this.refresh(),2000);}
  private openDialog(title:string,content:string,actions:{label:string;primary?:boolean;action:()=>void|Promise<void>}[]){
    this.dialog?.remove();const dialog=document.createElement('dialog');dialog.className='review-dialog';dialog.setAttribute('aria-labelledby','review-dialog-title');dialog.innerHTML=`<header class="review-dialog-head"><h2 id="review-dialog-title">${esc(title)}</h2><button class="review-agent-close" aria-label="关闭">×</button></header><div class="review-dialog-content">${content}<p class="review-status review-warning" id="review-dialog-status" role="status"></p></div><footer class="review-dialog-actions"><button class="btn secondary" data-dialog-cancel>返回</button>${actions.map((action,i)=>`<button class="btn ${action.primary?'primary':'secondary'}" data-dialog-action="${i}">${esc(action.label)}</button>`).join('')}</footer>`;
    document.body.append(dialog);this.dialog=dialog;
    const close=()=>{if(this.uploading){this.dialogStatus('文件正在保存，请等待上传结果。');return;}dialog.close();};dialog.querySelector('.review-agent-close')!.addEventListener('click',close);dialog.querySelector('[data-dialog-cancel]')!.addEventListener('click',close);dialog.addEventListener('cancel',event=>{if(this.uploading){event.preventDefault();this.dialogStatus('文件正在保存，请等待上传结果。');}});
    dialog.querySelectorAll<HTMLButtonElement>('[data-dialog-action]').forEach(button=>button.addEventListener('click',async()=>{const buttons=[...dialog.querySelectorAll<HTMLButtonElement>('[data-dialog-action]')];buttons.forEach(b=>b.disabled=true);try{await actions[Number(button.dataset.dialogAction)].action();}catch(error){this.dialogStatus(friendlyError(error));}finally{buttons.forEach(b=>b.disabled=false);}}));dialog.showModal();
  }
  private dialogStatus(text:string){const target=this.dialog?.querySelector('#review-dialog-status');if(target)target.textContent=text;}
}

type ReviewProjectFields=Pick<Dto<'ProjectResponse'>,'name'|'issuer_name'|'market'|'offering'|'update_details'>;
export function reviewProjectFields(value:ReviewProjectFields,autoName=false){
  const period=cutoffSelection(value.update_details?.reporting_cutoff??null);
  const option=(key:string,label:string,selected:unknown)=>`<option value="${esc(key)}"${key===selected?' selected':''}>${esc(label)}</option>`;
  return `<div class="review-form-row"><div><label for="issuer">发行人全称</label><input id="issuer" name="issuer"${autoName?' required':''} maxlength="200" value="${esc(value.issuer_name??'')}" placeholder="填写待复核募集书的发行人" aria-describedby="review-issuer-note"><p id="review-issuer-note" class="review-field-note">填写法定全称，用于识别本次复核主体。</p></div>${autoName?`<div><label for="generated-review-name">项目名称 <span class="optional">自动生成</span></label><output id="generated-review-name" for="issuer market offering" aria-live="polite" aria-describedby="review-name-note">${esc(generatedProjectName(value.issuer_name,value.market,value.offering,'review'))||'填写发行人后自动生成'}</output><p id="review-name-note" class="review-field-note">无需填写，创建后可在项目信息中修改。</p></div>`:`<div><label for="name">项目名称</label><input id="name" name="name" required maxlength="160" value="${esc(value.name)}"></div>`}<div><label for="market">发行市场</label><select id="market" name="market"><option value="">请选择</option>${Object.entries(MARKET_LABELS).map(([key,label])=>option(key,label,value.market)).join('')}</select></div><div><label for="offering">品种</label><select id="offering" name="offering"${value.market?'':' disabled'}><option value="">${value.market?'请选择':'请先选择发行市场'}</option>${(value.market?MARKET_OFFERINGS[value.market]:[]).map(key=>option(key,OFFERING_LABELS[key],value.offering)).join('')}</select></div></div><div class="review-period"><label for="reporting-year">最新报告期</label><div class="period-row"><select id="reporting-year" name="reporting_year" aria-label="最新报告期年份">${period.years.map(year=>option(year,`${year} 年`,period.year)).join('')}</select><div class="quarter-grid">${QUARTER_ENDS.map(([q,label])=>`<label class="quarter"><input type="radio" name="reporting_quarter" value="${q}"${period.quarter===q?' checked':''}>${label}</label>`).join('')}</div></div>${period.legacy?`<p class="review-muted" id="legacy-cutoff">已保存报告期：${esc(value.update_details?.reporting_cutoff)}；选择期末后更新。</p>`:''}</div>`;
}
export function bindReviewProjectFields(form:HTMLFormElement,changed?:(value:ReviewProjectFields)=>void,initial?:ReviewProjectFields){
  const market=form.querySelector<HTMLSelectElement>('#market')!,offering=form.querySelector<HTMLSelectElement>('#offering')!;
  // Editing the compact review form must retain earlier project details that it does not display.
  const details=structuredClone(initial?.update_details??blankDraft().update_details!);
  let periodChanged=false;
  const preview=form.querySelector<HTMLOutputElement>('#generated-review-name');
  const read=()=>{const data=new FormData(form),issuer=String(data.get('issuer')??'').trim()||null;return {name:preview?generatedProjectName(issuer,market.value as Market||null,offering.value as Offering||null,'review'):String(data.get('name')??'').trim(),issuer_name:issuer,market:market.value as Market||null,offering:offering.value as Offering||null,kind:'review' as const,update_details:{...details,reporting_cutoff:periodChanged?quarterCutoff(String(data.get('reporting_year')),String(data.get('reporting_quarter'))):details.reporting_cutoff}};};
  const notify=()=>{const {kind,...fields}=read();if(preview)preview.textContent=fields.name||'填写发行人后自动生成';changed?.(fields);};
  market.addEventListener('change',()=>{const options=market.value?MARKET_OFFERINGS[market.value as Market]:[];offering.disabled=!market.value;offering.innerHTML='<option value="">请选择</option>'+options.map(value=>`<option value="${value}">${OFFERING_LABELS[value]}</option>`).join('');});
  form.addEventListener('input',event=>{const target=event.target as HTMLInputElement;if(target.name==='reporting_year'||target.name==='reporting_quarter'){periodChanged=true;form.querySelector('#legacy-cutoff')?.remove();}if(target instanceof HTMLInputElement)notify();});
  form.addEventListener('change',event=>{if((event.target as HTMLSelectElement).name==='reporting_year')periodChanged=true;notify();});
  return read;
}
export function renderNewReview(api:ApiClient,shell:(html:string,section:string)=>void,current:()=>boolean,handoffQuery=new URLSearchParams()){
  shell(`<div class="review-workspace"><div class="page-head"><div><div class="eyebrow">PROSPECTUS REVIEW</div><h1>复核募集说明书</h1><p>提供复核材料和要求，点击开始即可执行。</p></div><a class="btn secondary" href="#tasks">查看全部项目</a></div>${workspaceSteps(1,'复核流程')}<div id="business-handoff"></div><form id="review-create-form" class="review-panel review-create"><h2>准备复核项目</h2><p class="review-muted review-create-intro"><span>填写待复核募集书的基本信息，再上传募集书和核验材料。</span><span class="required">必填：发行人全称</span></p>${reviewScope()}${reviewProjectFields({...blankDraft(),kind:'review'} as ReviewProjectFields,true)}<p id="review-create-status" class="form-message" role="status"></p><div class="review-form-actions"><button class="btn primary" type="submit">创建项目，继续提供材料</button><a class="btn secondary" href="#dashboard">取消</a></div></form></div>`,'review');
  void mountBusinessHandoff(api,document.querySelector<HTMLElement>('#business-handoff')!,handoffQuery,current);const form=document.querySelector<HTMLFormElement>('#review-create-form')!,read=bindReviewProjectFields(form);
  const clearStatus=()=>{if(!form.querySelector<HTMLButtonElement>('[type=submit]')!.disabled)form.querySelector('#review-create-status')!.textContent='';};
  form.addEventListener('input',clearStatus);form.addEventListener('change',clearStatus);
  form.addEventListener('change',event=>{if(['market','offering'].includes((event.target as HTMLSelectElement).name)){const value=read();form.querySelector('[data-review-rule-scope]')!.innerHTML=reviewRuleScope(value.market,value.offering);}});
  form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector<HTMLButtonElement>('[type=submit]')!;if(button.disabled)return;const value=read(),status=form.querySelector('#review-create-status')!,errors=value.issuer_name?validateDraft(value):['请填写发行人全称。'];if(errors.length){status.textContent=errors.join(' ');return;}button.disabled=true;status.textContent='正在创建项目…';try{const project=await api.create(value);if(current())location.hash=`/projects/${encodeURIComponent(project.project_id)}/review?tab=materials${carryHandoff(handoffQuery)}`;}catch(error){if(current())status.textContent=friendlyError(error);}finally{button.disabled=false;}});
}
