import { MARKET_LABELS, MARKET_OFFERINGS, OFFERING_LABELS, M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, ReviewDraftInputSchema, ReviewExecutionRequestSchema,
  type ReviewWorkspace as Workspace, type ReviewContext, type ReviewDraftInput, type ReviewExecutionRequest,
  type ReviewMaterialPin, type ReviewFinding, type ReviewProposal, type ReviewPlanRequest, type Run, type Market, type Offering } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { ArtifactDownloads, artifactError } from './artifact-download';
import { ReviewApi } from './review-api';
import { ReviewAssistant } from './review-assistant';
import { dimensionLabels, conclusionLabels, findingHtml, reportSummary, evidenceHtml, rulesHtml, sourceLocator } from './review-presentation';
import { executionIdentity, isActiveRun, runStateLabel } from './review-state';
import { date, esc } from './ui';
import { Value } from '@sinclair/typebox/value';
import './review-workspace.css';

type Operation = ReviewExecutionRequest['operation'];
const operationLabels: Record<Operation, string> = {full_review:'完整三维复核',differential_review:'差异复核',revision:'按已选问题修订'};
const materialPin = (material: Dto<'MaterialResponse'>): ReviewMaterialPin => ({material_id:material.material_id,material_version:material.material_version,sha256:material.sha256});
const sameMaterial = (a: ReviewMaterialPin, b: ReviewMaterialPin) => a.material_id===b.material_id&&a.material_version===b.material_version&&a.sha256===b.sha256;
const mimeTypes: Record<string, typeof M1_UPLOAD_MIME_TYPES[number]> = {docx:M1_UPLOAD_MIME_TYPES[0],pdf:M1_UPLOAD_MIME_TYPES[1],xlsx:M1_UPLOAD_MIME_TYPES[2],csv:M1_UPLOAD_MIME_TYPES[3],txt:M1_UPLOAD_MIME_TYPES[4],png:M1_UPLOAD_MIME_TYPES[5],jpg:M1_UPLOAD_MIME_TYPES[6],jpeg:M1_UPLOAD_MIME_TYPES[6]};
const roleLabels: Partial<Record<Dto<'MaterialResponse'>['role'],string>> = {historical:'待复核募集书',audit:'审计报告',financial:'年度财务报表',interimFinancial:'最近一期报表',notes:'财务附注',other:'其他证据'};

/** Production M3 screen. Model responses, findings, task state and downloads come only from the API. */
export class ReviewWorkspace {
  private controller = new AbortController();
  private reviewApi: ReviewApi;
  private assistant: ReviewAssistant;
  private workspace?: Workspace;
  private page?: HTMLElement;
  private dialog?: HTMLDialogElement;
  private downloads = new ArtifactDownloads();
  private tab: 'materials'|'results' = 'materials';
  private agentOpen = false;
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
  private pollTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private status = '';
  private statusError = false;
  private disposed = false;
  private readGeneration = 0;
  private localInputKey: string;
  private requestedTab?: string;
  private openFindings = new Set<string>();
  private renderedReport?: string;
  private renderedResults?: string;
  private executionKey: string;

  constructor(private api: ApiClient, private owner: string, private projectId: string,
    private shell: (html: string, section: string) => void, private current: () => boolean, private reportId?: string, tab?: string) {
    this.reviewApi = new ReviewApi(api,projectId,this.controller.signal);
    this.assistant = new ReviewAssistant(this.reviewApi,owner,()=>this.refresh(),proposal=>this.previewPlan(proposal));
    this.localInputKey = `bb-review-input:${owner}:${projectId}`;
    this.executionKey = `bb-review-execution:${owner}:${projectId}`;
    try{const pending:unknown=JSON.parse(localStorage.getItem(this.executionKey)??'null');if(Value.Check(ReviewExecutionRequestSchema,pending))this.executionPending=pending;}catch{/* Keep server state authoritative. */}
    this.requestedTab = tab;
    this.tab = tab==='results' || reportId ? 'results' : 'materials';
  }
  get hasUnconfirmed() { return this.uploading||this.inputDirty||this.assistant.hasUnconfirmed||Boolean(this.executionPending); }
  dispose() {
    this.disposed=true; this.readGeneration++; clearTimeout(this.pollTimer);clearTimeout(this.inputTimer);
    this.assistant.dispose();this.controller.abort();this.downloads.dispose();this.dialog?.remove();
  }
  async beforeLeave() {
    if(this.uploading){this.message('材料正在上传，请等待保存结果后离开。',true);return false;}
    this.cacheInput(); await this.assistant.flush(); if(this.inputDirty) await this.saveInput();
    return true;
  }
  private live() { return !this.disposed&&this.current(); }

  async render() {
    this.shell(`<div class="review-workspace" id="review-workspace"><p role="status">正在读取复核项目…</p></div>`,'review');
    this.page=document.querySelector<HTMLElement>('#review-workspace')!;
    try {
      const workspace = await this.reviewApi.workspace(this.reportId);
      if(!this.live())return;
      this.workspace=workspace;this.draftInput=this.inputFrom(workspace);this.run=workspace.active_run??undefined;
      if(!this.reportId&&!this.requestedTab&&workspace.selected_report)this.tab='results';
      this.restoreInput();this.syncSelections();
      this.page.innerHTML = `<header class="review-header"><div><p class="review-kicker">PROSPECTUS REVIEW</p><h1>${esc(workspace.project.name)}</h1><div class="review-meta" id="review-meta"></div></div><div class="review-header-actions"><button class="btn secondary small" data-review-action="refresh">刷新项目</button><button class="btn secondary small" data-review-action="toggle-agent" aria-controls="review-agent" aria-expanded="false">项目助手</button></div></header><p class="review-status" id="review-status" role="status"></p><div class="review-grid" id="review-grid"><section class="review-panel"><nav class="review-tabs" role="tablist" aria-label="复核内容"><button id="review-tab-materials" role="tab" data-review-tab="materials" aria-controls="review-materials-panel">材料与要求</button><button id="review-tab-results" role="tab" data-review-tab="results" aria-controls="review-results-panel">复核结果</button></nav><div class="review-tab-panel" id="review-materials-panel" role="tabpanel" aria-labelledby="review-tab-materials"></div><div class="review-tab-panel" id="review-results-panel" role="tabpanel" aria-labelledby="review-tab-results"></div></section><button class="review-backdrop" data-review-action="close-agent" aria-label="收起项目助手" hidden></button><aside class="review-agent" id="review-agent" aria-labelledby="review-agent-title" hidden></aside></div>`;
      this.assistant.mount(this.page.querySelector('#review-agent')!,workspace);
      this.bind();this.renderBody();this.setAgent(false);this.schedulePoll();
      if(this.inputDirty&&this.inputConflictVersion===undefined)void this.saveInput();
      if(!this.run){
        try {
        const history=await this.reviewApi.history();
        if(!this.live())return;
        const latest=this.reportId?history.items.find(item=>item.report_id===this.reportId):[...history.items].sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
        if(latest){this.run=latest.run;this.renderResults();this.renderMeta();}
        } catch(error) { if(this.live())this.message(`本轮状态暂未同步。${friendlyError(error)}`,true); }
      }
    }catch(error){
      if(!this.live())return;
      this.page.innerHTML=`<div class="review-empty"><h2>项目暂时无法读取</h2><p role="alert">${esc(friendlyError(error))}</p><button class="btn secondary" data-review-retry>重新读取</button></div>`;
      this.page.querySelector('[data-review-retry]')!.addEventListener('click',()=>void this.render());
    }
  }
  private inputFrom(workspace: Workspace): ReviewDraftInput {
    const {version,...input}=workspace.draft;return structuredClone(input);
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
  private message(text:string,error=false){this.status=text;this.statusError=error;const node=this.page?.querySelector<HTMLElement>('#review-status');if(node){node.textContent=text;node.classList.toggle('review-warning',error);}}
  private syncSelections(){const report=this.workspace?.selected_report;this.selections=new Set(this.workspace?.plan?.source_report_id===report?.report_id?this.workspace!.plan!.finding_ids:[]);}
  private renderBody(){this.renderMeta();this.renderMaterials();this.renderResults();this.setTab(this.tab,false);this.message(this.status,this.statusError);}
  private renderMeta(){if(!this.workspace)return;const p=this.workspace.project;const node=this.page?.querySelector('#review-meta');if(node)node.innerHTML=`<span>${p.issuer_name?esc(p.issuer_name):'发行人待识别'}</span><span>${p.market?MARKET_LABELS[p.market]:'市场待识别'}${p.offering?` · ${OFFERING_LABELS[p.offering]}`:''}</span><span>输入草稿 V${this.workspace.draft.version}</span>${this.workspace.selected_report?`<span>当前报告 ${esc(this.workspace.selected_report.report_id)} · V${this.workspace.selected_report.version}</span>`:''}${this.run?`<span class="review-tag">${runStateLabel[this.run.state]}</span>`:''}`;}
  private setTab(tab:'materials'|'results',write=true){this.tab=tab;this.page?.querySelectorAll<HTMLButtonElement>('[data-review-tab]').forEach(b=>{const selected=b.dataset.reviewTab===tab;b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;});for(const name of ['materials','results']){const panel=this.page?.querySelector<HTMLElement>(`#review-${name}-panel`);if(panel)panel.hidden=name!==tab;}if(write){const query=new URLSearchParams({tab});if(this.reportId)query.set('report_id',this.reportId);history.replaceState(null,'',`${location.pathname}${location.search}#/projects/${encodeURIComponent(this.projectId)}/review?${query}`);}}
  private setAgent(open:boolean){this.agentOpen=open;this.page?.querySelector('#review-grid')?.classList.toggle('agent-open',open);const panel=this.page?.querySelector<HTMLElement>('#review-agent');if(panel){panel.hidden=!open;const drawer=matchMedia('(max-width:1180px)').matches;panel.setAttribute('role',drawer?'dialog':'complementary');if(drawer)panel.setAttribute('aria-modal','true');else panel.removeAttribute('aria-modal');if(open)panel.querySelector<HTMLTextAreaElement>('textarea')?.focus({preventScroll:true});}const backdrop=this.page?.querySelector<HTMLElement>('.review-backdrop');if(backdrop)backdrop.hidden=!open;this.page?.querySelector('[data-review-action="toggle-agent"]')?.setAttribute('aria-expanded',String(open));}
  private materialNames(){return Object.fromEntries((this.workspace?.materials??[]).map(m=>[m.material_id,m.filename]));}
  private context(finding?:ReviewFinding):ReviewContext {return {project_id:this.projectId,report_id:finding?.report_id??this.workspace?.selected_report?.report_id??null,finding_ids:finding?[finding.finding_id]:[],material_refs:finding?[...finding.target_refs,...finding.evidence_refs].reduce<ReviewMaterialPin[]>((refs,ref)=>{const pin={material_id:ref.material_id,material_version:ref.material_version,sha256:ref.material_sha256};if(!refs.some(item=>sameMaterial(item,pin)))refs.push(pin);return refs;},[]):[]};}

  private bind(){
    this.page!.addEventListener('click',event=>{
      const target=(event.target as HTMLElement).closest<HTMLElement>('[data-review-action],[data-review-tab],[data-review-coverage]');if(!target)return;
      if(target.dataset.reviewTab){this.setTab(target.dataset.reviewTab as 'materials'|'results');return;}
      if(target.dataset.reviewCoverage){this.coverage(target.dataset.reviewCoverage);return;}
      const card=target.closest<HTMLElement>('[data-finding-id]');const finding=this.workspace?.selected_report?.findings.find(f=>f.finding_id===card?.dataset.findingId);
      switch(target.dataset.reviewAction){
        case 'toggle-agent':this.setAgent(!this.agentOpen);break;
        case 'close-agent':this.setAgent(false);this.page?.querySelector<HTMLButtonElement>('[data-review-action="toggle-agent"]')?.focus();break;
        case 'refresh':void this.refresh();break;
        case 'save-input':void this.saveInput();break;
        case 'review':void this.previewExecution('full_review',null,[]);break;
        case 'plan':this.previewPlan();break;
        case 'cancel':void this.cancelRun();break;
        case 'upload':this.uploadDialog();break;
        case 'evidence':if(finding)this.uploadDialog(this.context(finding));break;
        case 'explain':if(finding)this.explain(finding);break;
        case 'discuss':case 'dispute':this.setAgent(true);this.assistant.focus(!finding&&this.tab==='materials'?{project_id:this.projectId,report_id:null,finding_ids:[],material_refs:structuredClone(this.draftInput?.material_versions??[])}:this.context(finding),target.dataset.reviewAction==='dispute'?'我对此项结论有异议：':'');break;
        case 'download':if(target.dataset.artifactId)void this.download(target.dataset.artifactId);break;
        case 'reload-input':void this.resolveInput(false);break;
        case 'adopt-local-input':void this.resolveInput(true);break;
      }
    });
    this.page!.addEventListener('change',event=>{
      const target=event.target;
      if(target instanceof HTMLInputElement&&target.dataset.reviewSelect){void this.selectFinding(target.dataset.reviewSelect,target.checked);return;}
      if(target instanceof HTMLSelectElement&&target.dataset.reviewFilter){this.filters[target.dataset.reviewFilter as keyof typeof this.filters]=target.value;this.renderResults();return;}
      if(target instanceof HTMLSelectElement&&target.id==='review-source'){const source=this.workspace?.materials.find(m=>m.material_id===target.value);if(this.draftInput){this.draftInput.source_material_ref=source?materialPin(source):null;this.changedInput();}return;}
      if(target instanceof HTMLInputElement&&target.id==='review-as-of'&&this.draftInput){this.draftInput.as_of=target.value||null;this.changedInput();}
    });
    this.page!.addEventListener('input',event=>{if(event.target instanceof HTMLTextAreaElement&&event.target.id==='review-requirements'&&this.draftInput){this.draftInput.requirements=event.target.value.trim()?[event.target.value]:[];this.changedInput();}});
    this.page!.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.agentOpen&&!this.dialog?.open)this.setAgent(false);if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&(event.target as HTMLElement).matches('[data-review-tab]')){event.preventDefault();this.setTab(this.tab==='materials'?'results':'materials');this.page?.querySelector<HTMLButtonElement>(`[data-review-tab="${this.tab}"]`)?.focus();}});
    this.page!.addEventListener('keydown',event=>{if(event.key!=='Tab'||!this.agentOpen||!matchMedia('(max-width:1180px)').matches||this.dialog?.open)return;const panel=this.page!.querySelector<HTMLElement>('#review-agent')!;const controls=[...panel.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,a[href],summary')].filter(node=>node.getClientRects().length);const first=controls[0],last=controls.at(-1);if(event.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){event.preventDefault();first?.focus();}});
  }
  private changedInput(){this.inputDirty=true;this.cacheInput();this.message(isActiveRun(this.workspace?.active_run)?'补充内容进入下一版，当前任务输入保持不变。':'材料与要求草稿等待保存。');clearTimeout(this.inputTimer);this.inputTimer=setTimeout(()=>void this.saveInput(),650);}

  private renderMaterials(){
    const host=this.page?.querySelector('#review-materials-panel');if(!host||!this.workspace||!this.draftInput)return;
    const active=document.activeElement;
    const editing=host.contains(active)&&(active instanceof HTMLTextAreaElement||active instanceof HTMLInputElement||active instanceof HTMLSelectElement)?{id:active.id,value:active.value,start:active instanceof HTMLTextAreaElement?active.selectionStart:null,end:active instanceof HTMLTextAreaElement?active.selectionEnd:null}:undefined;
    const input=this.draftInput,materials=this.workspace.materials;const source=materials.filter(m=>['historical','reference'].includes(m.role)&&m.state==='persisted');
    host.innerHTML=`<p class="review-kicker">INPUT & REQUIREMENTS</p><h2>材料与要求，始终在一起。</h2><p class="review-muted">提供待复核稿和财务证据，明确开始后才执行。特别说明可以保存，也可向项目助手补充。</p>${isActiveRun(this.workspace.active_run)?`<div class="review-notice">当前任务已锁定输入 ${this.workspace.active_run!.input_revision}。新增材料与说明用于下一版。</div>`:''}${this.inputConflictVersion!==undefined?'<div class="review-notice error">服务器上的输入已有变化，本页草稿仍保留。<div class="review-finding-actions"><button class="btn secondary small" data-review-action="reload-input">采用服务器版本</button><button class="btn secondary small" data-review-action="adopt-local-input">核对并保存本页内容为新版</button></div></div>':''}
    <div class="review-section-heading"><h3>项目材料</h3><button class="text-btn" data-review-action="upload">＋ 上传材料</button></div><div class="review-material-list">${materials.length?materials.map(m=>`<div class="review-material"><div><strong>${esc(m.filename)}</strong><small>${esc(roleLabels[m.role]??m.role)} · V${m.material_version} · ${(m.byte_size/1024).toFixed(1)} KB</small></div><span class="review-tag">${m.state==='persisted'?'已保存':esc(m.state)}</span></div>`).join(''):'<div class="review-notice">还没有项目材料。上传待复核募集书、审计报告或财务报表及附注。</div>'}</div>
    <label class="review-section-heading" for="review-source"><h3>本次待复核稿</h3></label><select id="review-source" class="review-source-select"><option value="">选择已上传的募集书</option>${source.map(m=>`<option value="${esc(m.material_id)}" ${input.source_material_ref?.material_id===m.material_id?'selected':''}>${esc(m.filename)} · V${m.material_version}</option>`).join('')}</select><p class="review-muted">选择准确文稿版本；其他材料用作核验依据。</p>
    <div class="review-section-heading"><h3>本次复核范围</h3><span class="review-muted">默认完整三维</span></div><div class="review-scope"><span>财务数据核对</span><span>合规与格式</span><span>公开信息核验</span></div><label class="review-section-heading" for="review-as-of"><h3>披露截止日 <small class="review-muted">选填；可从材料识别</small></h3></label><input id="review-as-of" type="date" value="${esc(input.as_of??'')}">
    <div class="review-section-heading"><label for="review-requirements"><h3>复核要求 <small class="review-muted">选填</small></h3></label><button class="text-btn" data-review-action="discuss">向助手补充</button></div><textarea id="review-requirements" class="review-source-select" rows="4" maxlength="12000" placeholder="例如：关注新增借款的披露与摘要引用。">${esc(input.requirements.join('\n'))}</textarea><button class="text-btn" data-review-action="save-input">保存材料与要求</button>
    ${(input.evidence_links??[]).length?`<div class="review-section-heading"><h3>已关联的补证</h3></div><div class="review-requirements">${input.evidence_links!.map(link=>`<p>${esc(link.report_id)} · ${esc(link.finding_id)} ← ${esc(materials.find(m=>m.material_id===link.material_ref.material_id)?.filename??link.material_ref.material_id)} · V${link.material_ref.material_version}</p>`).join('')}</div>`:''}
    <div class="review-footer-actions"><div><strong>准备好了，就可以开始。</strong><p>开始后锁定材料与要求，后续补充保留到下一版。</p></div><button class="btn primary" data-review-action="review" ${isActiveRun(this.workspace.active_run)||this.uploading?'disabled':''}>${isActiveRun(this.workspace.active_run)?'已有任务进行中':'开始复核'}</button></div>`;
    if(editing){const field=host.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`#${CSS.escape(editing.id)}`);if(field){field.value=editing.value;field.focus({preventScroll:true});if(field instanceof HTMLTextAreaElement&&editing.start!==null&&editing.end!==null)field.setSelectionRange(editing.start,editing.end);}}
  }
  private renderResults(){
    const host=this.page?.querySelector('#review-results-panel');if(!host||!this.workspace)return;const report=this.workspace.selected_report;
    const run=this.workspace.active_run??this.run;
    const signature=JSON.stringify([report?.report_id,run?.run_id,run?.state,run?.stage,this.filters,[...this.selections].sort(),this.planSaving,this.workspace.artifacts,this.workspace.artifact_run,this.materialNames()]);
    if(this.renderedResults===signature&&host.childElementCount)return;
    this.renderedResults=signature;
    if(this.renderedReport===report?.report_id)host.querySelectorAll<HTMLDetailsElement>('.review-finding').forEach(d=>{if(d.open)this.openFindings.add(d.dataset.findingId!);else this.openFindings.delete(d.dataset.findingId!);});
    else this.openFindings.clear();
    this.renderedReport=report?.report_id;
    const progress=run?`<section class="review-run"><h3>任务状态：${runStateLabel[run.state]}</h3><p>输入版本 ${run.input_revision} · ${esc(run.run_id)}</p>${run.stage?`<p>${esc(run.stage)}</p>`:''}${['failed','cancelled','rejected','paused','awaiting_input'].includes(run.state)?'<p>本轮状态已保留。补充材料与要求后，可以明确开始下一轮；原报告保持不变。</p>':''}${isActiveRun(run)?'<p>当前输入已锁定。新增材料和说明进入下一版，关闭页面不会取消任务。</p><div class="review-run-actions"><button class="btn secondary small" data-review-action="cancel">停止本次任务</button></div>':''}</section>`:'';
    if(!report){host.innerHTML=progress+`<div class="review-empty"><h2>${isActiveRun(run)?'复核正在进行':'还没有复核报告'}</h2><p class="review-muted">${isActiveRun(run)?'结果就绪后会在这里显示，项目助手仍可记录下一版说明。':'提供材料并明确开始后，在这里查看问题、依据与成果。'}</p><button class="btn secondary" data-review-tab="materials">查看材料与要求</button></div>`;return;}
    const findings=report.findings.filter(f=>(this.filters.dimension==='all'||f.dimension===this.filters.dimension)&&(this.filters.conclusion==='all'||f.conclusion===this.filters.conclusion));
    host.innerHTML=progress+reportSummary(report)+`<div class="review-section-heading"><h3>复核发现</h3><span class="review-muted">${esc(this.materialNames()[report.source_material.material_id]??report.source_material.material_id)} · V${report.source_material.material_version} · ${esc(date(report.created_at))}</span></div><div class="review-filters"><label>检查维度<select data-review-filter="dimension"><option value="all">全部维度</option>${Object.entries(dimensionLabels).map(([value,label])=>`<option value="${value}" ${this.filters.dimension===value?'selected':''}>${label}</option>`).join('')}</select></label><label>结论<select data-review-filter="conclusion"><option value="all">全部结论</option>${Object.entries(conclusionLabels).map(([value,label])=>`<option value="${value}" ${this.filters.conclusion===value?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="review-findings">${findings.length?findings.map(f=>findingHtml(f,this.selections.has(f.finding_id),this.materialNames())).join(''):'<p class="review-muted">当前筛选没有发现；请结合检查覆盖与限制阅读结果。</p>'}</div><div class="review-plan-bar"><div><strong>已选择 ${this.selections.size} 项修订</strong><p>先核对修改范围，再明确执行。补证、异议与已修改都不自动代表复核通过。</p></div><button class="btn primary small" data-review-action="plan" ${this.planSaving?'disabled':''}>核对修订计划</button></div>${this.artifactHeading()}<div class="review-downloads">${this.workspace.artifacts.map(artifact=>`<button class="btn secondary small" data-review-action="download" data-artifact-id="${esc(artifact.artifact_id)}">下载${{report:'问题报告',comments:'批注稿',revision:'修订版',clean:'清洁版',baseline:'基线文稿'}[artifact.kind]}</button>`).join('')}</div><div class="review-footer-actions"><p>版本记录在工作台项目内保存。当前结果的来源与限制始终保留。</p><button class="btn secondary small" data-review-action="review" ${isActiveRun(this.workspace.active_run)?'disabled':''}>再次完整复核</button></div>`;
    host.querySelectorAll<HTMLInputElement>('[data-review-select]').forEach(input=>input.disabled=this.planSaving);
    host.querySelectorAll<HTMLDetailsElement>('.review-finding').forEach(d=>{d.open=this.openFindings.has(d.dataset.findingId!);});
  }
  private saveInput():Promise<boolean>{clearTimeout(this.inputTimer);if(this.inputSaving)return this.inputSaving;if(!this.inputDirty)return Promise.resolve(true);if(this.inputConflictVersion!==undefined){this.message('请先核对材料页上的输入版本冲突。',true);return Promise.resolve(false);}const promise=this.persistInput();this.inputSaving=promise;void promise.finally(()=>{if(this.inputSaving===promise)this.inputSaving=undefined;});return promise;}
  private artifactHeading(){
    const run=this.workspace?.artifact_run;if(!run||!this.workspace?.artifacts.length)return '';
    return `<div class="review-section-heading"><h3>执行版本 V${run.version} · ${operationLabels[run.operation]}成果</h3></div><p class="review-muted">${esc(run.run_id)}${run.source_report_id?` · 来源报告 ${esc(run.source_report_id)}`:''}。${run.operation==='revision'?'上方保留来源报告的发现；本轮已生成修改文稿，是否通过需要再次明确复核。':'下载对应这次执行的成果，来源与限制保留在报告中。'}</p>`;
  }
  private async persistInput(){
    while(this.inputDirty&&this.workspace&&this.draftInput&&this.live()){
      const sent=structuredClone(this.draftInput),version=this.workspace.draft.version;
      try{await this.reviewApi.saveDraft({kind:'input',expected_version:version,input:sent});const saved=await this.reviewApi.drafts();if(!this.live())return false;const {version:savedVersion,...savedInput}=saved.draft;if(!Value.Check(ReviewDraftInputSchema,savedInput)||!Value.Equal(savedInput,sent))throw new ApiError(409,'INPUT_REVISION_CONFLICT');this.workspace.draft=saved.draft;if(Value.Equal(this.draftInput,sent)){this.inputDirty=false;this.draftInput=this.inputFrom(this.workspace);}this.cacheInput();this.renderMeta();this.message('材料与要求已保存；任务尚未启动。');}
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
  private async persistPlan(ids:string[],proposal?:ReviewProposal,sourceReportId?:string):Promise<boolean>{
    const report=this.workspace?.selected_report;if(!report||!this.workspace||this.planSaving)return false;
    if(sourceReportId&&report.report_id!==sourceReportId){this.dialogStatus('报告已更新，请重新打开修订计划核对来源；当前计划未改变。');return false;}
    const plan=this.workspace.plan,previous=plan?.source_report_id===report.report_id?plan:null;
    const request:ReviewPlanRequest={expected_version:plan?.version??0,source_report_id:report.report_id,finding_ids:ids,excluded_findings:report.findings.filter(f=>f.repairability.can_revise&&!ids.includes(f.finding_id)).map(f=>({finding_id:f.finding_id,reason:previous?.excluded_findings.find(e=>e.finding_id===f.finding_id)?.reason??'用户本次未选择修订'})),requirements:proposal?.requirements??previous?.requirements??[],...(proposal?{proposal_id:proposal.proposal_id}:{})};
    this.planSaving=true;
    try{const saved=await this.reviewApi.plan(request);if(!this.live())return false;this.workspace.plan=saved;this.selections=new Set(saved.finding_ids);this.message('修订计划已保存；尚未执行。');return true;}catch(error){this.message(`${friendlyError(error)} 选择未确认，请刷新计划后重试。`,true);return false;}finally{this.planSaving=false;}
  }
  private previewPlan(proposal?:ReviewProposal){
    const report=this.workspace?.selected_report;if(!report)return;
    if(proposal&&proposal.source_report_id!==report.report_id){this.message(`该提议来自 ${proposal.source_report_id}，请从工作台打开对应报告后核对，当前选择未改变。`,true);return;}
    const selected=new Set(proposal?proposal.finding_ids:this.selections);
    const applicable=report.findings.filter(f=>f.repairability.can_revise);
    this.openDialog(proposal?'核对助手提议':'核对修订计划',`<p>来源报告 <strong>${esc(report.report_id)}</strong> · V${report.version}。${proposal?'采纳后才更新勾选，仍不会执行任务。':'仅修改选中且证据充分的内容。'}</p>${proposal?`<div class="review-notice">${esc(proposal.explanation)}${proposal.requirements.length?`<ul>${proposal.requirements.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}</div>`:''}${applicable.map(f=>`<label class="review-plan-item"><input type="checkbox" data-plan-finding="${esc(f.finding_id)}" ${selected.has(f.finding_id)?'checked':''}><span><strong>${esc(f.finding_id)} · ${esc(f.title)}</strong><small>${f.target_refs.map(ref=>esc(sourceLocator(ref))).join('；')}</small><small>${esc(f.suggested_change??f.repairability.reason)}</small></span></label>`).join('')||'<p>当前没有具备修订依据的问题，不能创建空修订任务。</p>'}<p class="review-muted">未选及待补证事项保留原结论。关联引用、章节和样式要求随计划一起核对。</p>`,[{label:proposal?'采纳计划':'保存计划',primary:true,action:async()=>{const ids=[...this.dialog!.querySelectorAll<HTMLInputElement>('[data-plan-finding]:checked')].map(i=>i.dataset.planFinding!);if(await this.persistPlan(ids,proposal,report.report_id)){this.dialog?.close();this.renderResults();}}},...(!proposal?[{label:'确认范围并执行修订',primary:false,action:async()=>{const ids=[...this.dialog!.querySelectorAll<HTMLInputElement>('[data-plan-finding]:checked')].map(i=>i.dataset.planFinding!);if(!ids.length){this.dialogStatus('请选择至少一项有依据的修改。');return;}if(await this.persistPlan(ids,undefined,report.report_id)){this.dialog?.close();await this.previewExecution('revision',report.report_id,ids);}}}]:[])]);
  }

  private async previewExecution(operation:Operation,sourceReport:string|null,findings:string[]){
    if(!this.workspace||!this.draftInput)return;
    if(isActiveRun(this.workspace.active_run)){this.message('同一项目已有任务进行中，请查看当前状态。',true);this.setTab('results');return;}
    if(this.uploading){this.message('材料仍在上传，请等待保存确认。',true);return;}
    if(!await this.saveInput())return;
    if(!this.draftInput.source_material_ref){this.message('请先选择已上传的待复核募集书。',true);this.setTab('materials');return;}
    if(operation!=='full_review'&&(!sourceReport||!findings.length)){this.message('请明确本轮问题范围，空任务不会执行。',true);return;}
    const requestBase:Omit<ReviewExecutionRequest,'execution_request_id'>={operation,expected_input_version:this.workspace.draft.version,source_report_id:sourceReport,expected_plan_version:operation==='revision'?this.workspace.plan?.version??null:null,finding_ids:[...findings]};
    if(this.executionPending&&executionIdentity(this.executionPending)!==executionIdentity(requestBase)){this.openDialog('核对待确认的原任务',`<p>有一项 ${operationLabels[this.executionPending.operation]} 的提交结果尚未确认。先重试原请求获取状态，再开始新的范围。</p>`,[{label:'核对原请求状态',primary:true,action:()=>this.execute(this.executionPending!)}]);return;}
    const source=this.workspace.materials.find(m=>sameMaterial(materialPin(m),this.draftInput!.source_material_ref!));
    this.openDialog('确认本次执行范围',`<p><strong>${operationLabels[operation]}</strong></p><dl><dt>输入草稿</dt><dd>V${requestBase.expected_input_version}</dd><dt>源稿</dt><dd>${esc(source?.filename??this.draftInput.source_material_ref.material_id)} · V${this.draftInput.source_material_ref.material_version}</dd><dt>来源报告</dt><dd>${esc(sourceReport??'首次／完整三维复核')}</dd><dt>范围</dt><dd>${operation==='full_review'?'财务数据、合规与格式、公开信息':findings.map(esc).join('、')}</dd></dl>${this.draftInput.requirements.length?`<h3>本次要求</h3><ul>${this.draftInput.requirements.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}<p>已保存讨论：${this.workspace.messages.length} 条。讨论仅供参考，执行范围以本次确认和已采纳计划为准。</p><p class="review-muted">开始后锁定本次输入。新的材料与说明进入下一版；${operation==='revision'?'修订完成不代表复核通过，再次复核需另行明确执行。':'如有未覆盖范围，报告会说明原因。'}</p>`,[{label:operation==='revision'?'执行修订':'开始复核',primary:true,action:()=>this.execute(requestBase)}]);
  }
  private async execute(base:Omit<ReviewExecutionRequest,'execution_request_id'>){
    if(!this.workspace||isActiveRun(this.workspace.active_run))return;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${this.owner}:${this.projectId}:${executionIdentity(base)}:${this.run&&!isActiveRun(this.run)?this.run.run_id:''}`));
    const execution_request_id=this.executionPending&&executionIdentity(this.executionPending)===executionIdentity(base)?this.executionPending.execution_request_id:'m3-'+[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
    const request:ReviewExecutionRequest={...base,execution_request_id};this.executionPending=request;
    try{localStorage.setItem(this.executionKey,JSON.stringify(request));}catch{this.dialogStatus('浏览器无法保存重试凭据，请保持页面打开直至提交确认。');}
    try{
      const run=await this.reviewApi.execute(request);if(!this.live())return;
      if(run.project_id!==this.projectId||run.execution_request_id!==execution_request_id)throw new ApiError(0,'DATA_UNAVAILABLE');
      this.executionPending=undefined;try{localStorage.removeItem(this.executionKey);}catch{}
      this.run=run;this.workspace.active_run=isActiveRun(run)?run:null;this.reportId=undefined;this.dialog?.close();this.setTab('results');this.message(isActiveRun(run)?'任务已提交，本次输入已锁定。':`原任务状态已确认：${runStateLabel[run.state]}。新一轮需要重新确认执行。`);this.renderBody();await this.refresh();
    }catch(error){
      if(error instanceof ApiError&&error.status>=400&&error.status<500&&![408,429].includes(error.status)){
        this.executionPending=undefined;try{localStorage.removeItem(this.executionKey);}catch{}this.dialog?.close();await this.refresh();this.message(`${friendlyError(error)} 请重新核对输入与范围后再执行。`,true);
      }else{this.dialogStatus(`${friendlyError(error)} 重试沿用同一请求，不会重复执行。`);this.message('执行结果尚未确认，请在确认窗口重试原请求或刷新状态。',true);}
    }
  }
  private async cancelRun(){const run=this.workspace?.active_run??this.run;if(!run||!isActiveRun(run))return;try{const saved=await this.api.runAction(run.run_id,'cancel',this.controller.signal);if(!this.live())return;this.run=saved;this.message('停止请求已提交；本轮版本记录会保留。');await this.refresh();}catch(error){this.message(friendlyError(error),true);}}

  private explain(finding:ReviewFinding){this.openDialog('问题解释',`<span class="review-tag">${esc(finding.report_id)} · ${esc(finding.finding_id)}</span><h3>${esc(finding.title)}</h3><p>${esc(finding.description)}</p><h4>核验依据</h4>${evidenceHtml(finding.evidence_refs,'尚无可核实的材料证据。',this.materialNames())}${rulesHtml(finding)}${finding.suggested_change?`<p><strong>建议</strong> ${esc(finding.suggested_change)}</p>`:''}<p>${esc(finding.repairability.reason)}</p>${finding.limitations.length?`<p class="review-warning">${finding.limitations.map(esc).join('；')}</p>`:''}`,[{label:'继续讨论此项',action:()=>{this.dialog?.close();this.setAgent(true);this.assistant.focus(this.context(finding));}}]);}
  private coverage(dimension:string){const report=this.workspace?.selected_report;if(!report)return;this.openDialog('检查覆盖',`<p>报告 ${esc(report.report_id)}。本轮核验与沿用记录分别列出。</p>${report.coverage.filter(c=>c.dimension===dimension).map(c=>`<article class="review-history-entry"><h3>${esc(c.check_id)}</h3><p>${{pass:'通过',issue:'发现问题',needs_evidence:'待补证',manual:'待人工判断',uncovered:'未覆盖',not_applicable:'不适用'}[c.outcome]} · ${c.check_status==='rechecked'?'本轮核验':`沿用 ${esc(c.origin_report_id)}`}</p><p>${esc(c.reason)}</p></article>`).join('')||'<p>没有可确认的检查执行记录，不能据此认定通过。</p>'}`,[]);}

  private uploadDialog(context?:ReviewContext){
    const target=context?structuredClone(context):undefined;
    this.openDialog(target?'为此问题补充材料':'上传项目材料',`${target?`<div class="review-notice">补证目标：${esc(target.report_id)} · ${target.finding_ids.map(esc).join('、')}。该目标不会随聊天切换而改变。</div>`:''}<label for="review-upload-role">材料类型</label><select id="review-upload-role" class="review-source-select">${Object.entries(roleLabels).filter(([role])=>!target||role!=='historical').map(([role,label])=>`<option value="${role}" ${target&&role==='other'?'selected':''}>${label}</option>`).join('')}</select><label for="review-upload-file">选择 DOCX／PDF／XLSX／CSV／TXT 或图片</label><input id="review-upload-file" type="file" multiple accept=".docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg"><p class="review-muted">文件会真实上传到当前项目。保存材料不自动开始复核。</p><div id="review-upload-progress" role="status"></div>`,[{label:'上传并保存',primary:true,action:async()=>{const input=this.dialog!.querySelector<HTMLInputElement>('#review-upload-file')!;if(!input.files?.length){this.dialogStatus('请选择文件。');return;}const role=this.dialog!.querySelector<HTMLSelectElement>('#review-upload-role')!.value as Dto<'MaterialResponse'>['role'];await this.upload([...input.files],role,target);}}]);
  }
  private async upload(files:File[],role:Dto<'MaterialResponse'>['role'],target?:ReviewContext){
    if(this.uploading||!this.workspace||!this.draftInput)return;this.uploading=true;
    try{
      if(!await this.saveInput())return;
      for(const file of files){
        const extension=file.name.toLowerCase().split('.').at(-1)??'',media=mimeTypes[extension];
        if(!media||(role==='historical'&&!['docx','pdf'].includes(extension)))throw new Error('待复核募集书只支持 DOCX 或 PDF；其他材料请选择支持的文件类型。');
        if(!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)throw new Error('单份文件须大于 0 且不超过 100 MB。');
        const progress=this.dialog?.querySelector<HTMLElement>('#review-upload-progress');if(progress)progress.textContent=`正在校验 ${file.name}…`;
        const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());const sha256=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
        const key=JSON.stringify([file.name,role,sha256]);let attempt=this.uploadAttempts.get(key);
        if(!attempt){const session=await this.api.createUpload(this.projectId,{filename:file.name,media_type:media,byte_size:file.size,sha256,role},this.controller.signal);attempt={session,bytesSaved:false};this.uploadAttempts.set(key,attempt);}
        if(!attempt.bytesSaved){await this.api.uploadBytes(attempt.session.upload_url,file,(loaded,total)=>{if(progress?.isConnected)progress.textContent=`${file.name} · 已上传 ${Math.round(100*loaded/Math.max(total,1))}%`;},this.controller.signal);attempt.bytesSaved=true;}
        const material=attempt.material??await this.api.completeUpload(this.projectId,attempt.session.upload_id,{byte_size:file.size,sha256},this.controller.signal);attempt.material=material;
        if(!this.live())return;if(material.sha256!==sha256||material.state!=='persisted')throw new ApiError(0,'DATA_UNAVAILABLE');
        const pin=materialPin(material);this.workspace.materials=this.workspace.materials.filter(m=>m.material_id!==material.material_id).concat(material);
        this.draftInput.material_versions=this.draftInput.material_versions.filter(m=>m.material_id!==pin.material_id).concat(pin);
        if(role==='historical'&&!this.draftInput.source_material_ref)this.draftInput.source_material_ref=pin;
        if(target?.report_id){const links=this.draftInput.evidence_links??[];for(const finding_id of target.finding_ids)if(!links.some(link=>link.report_id===target.report_id&&link.finding_id===finding_id&&sameMaterial(link.material_ref,pin)))links.push({report_id:target.report_id,finding_id,material_ref:pin});this.draftInput.evidence_links=links;}
        this.inputDirty=true;this.cacheInput();if(!await this.saveInput())throw new Error('文件已经上传，输入范围尚未保存。请在材料页核对，勿重复上传。');
      }
      this.dialog?.close();await this.refresh();this.message('材料已保存；复核尚未开始。');
      if(target?.report_id)this.openDialog('材料已补充，核对下一步',`<p>原补证对象：<strong>${esc(target.report_id)} · ${target.finding_ids.map(esc).join('、')}</strong></p><p>新材料用于下一轮。只重核已列问题；未触及问题仍沿用原结果。</p>`,[{label:'核对并重新核验',primary:true,action:async()=>{this.dialog?.close();await this.previewExecution('differential_review',target.report_id,target.finding_ids);}}]);
    }catch(error){const text=error instanceof ApiError||error instanceof TypeError||error instanceof DOMException?friendlyError(error)+' 可以重试原上传确认保存状态。':error instanceof Error?error.message:'上传未确认，请重新读取材料状态。';this.dialogStatus(text);this.message(text,true);}finally{this.uploading=false;this.renderMaterials();}
  }
  private async download(id:string){try{const artifact=this.workspace?.artifacts.find(a=>a.artifact_id===id);if(!artifact)return;const metadata=await this.api.artifact(id,this.controller.signal);if(metadata.artifact_id!==id||metadata.version!==artifact.artifact_version||metadata.quality_status!=='passed')throw new ApiError(0,'DATA_UNAVAILABLE');const bytes=await this.api.artifactBytes(metadata,this.controller.signal);if(!this.live())return;this.downloads.save(bytes,artifact.filename);this.message('文档已校验并开始下载。');}catch(error){this.message(artifactError(error),true);}}

  refresh():Promise<void>{if(this.refreshing)return this.refreshing;const promise=this.loadWorkspace();this.refreshing=promise;void promise.finally(()=>{if(this.refreshing===promise)this.refreshing=undefined;});return promise;}
  private async loadWorkspace(){const generation=++this.readGeneration;try{const workspace=await this.reviewApi.workspace(this.reportId);if(!this.live()||generation!==this.readGeneration)return;this.workspace=workspace;if(!this.inputDirty)this.draftInput=this.inputFrom(workspace);if(!this.planSaving)this.syncSelections();if(workspace.active_run)this.run=workspace.active_run;else if(this.run&&isActiveRun(this.run))this.run=await this.api.run(this.run.run_id,this.controller.signal);if(!this.live())return;this.renderBody();this.assistant.update(workspace);if(this.executionPending&&this.run?.execution_request_id===this.executionPending.execution_request_id)this.executionPending=undefined;if(!this.executionPending){try{localStorage.removeItem(this.executionKey);}catch{}}}catch(error){if(this.live())this.message(`状态暂未更新。${friendlyError(error)}`,true);}finally{this.schedulePoll();}}
  private schedulePoll(){clearTimeout(this.pollTimer);if(this.live()&&(isActiveRun(this.workspace?.active_run)||isActiveRun(this.run)||this.workspace?.messages.some(m=>m.role==='user'&&['queued','running'].includes(m.reply_status))))this.pollTimer=setTimeout(()=>void this.refresh(),2500);}
  private openDialog(title:string,content:string,actions:{label:string;primary?:boolean;action:()=>void|Promise<void>}[]){
    this.dialog?.remove();const dialog=document.createElement('dialog');dialog.className='review-dialog';dialog.setAttribute('aria-labelledby','review-dialog-title');dialog.innerHTML=`<header class="review-dialog-head"><h2 id="review-dialog-title">${esc(title)}</h2><button class="review-agent-close" aria-label="关闭">×</button></header><div class="review-dialog-content">${content}<p class="review-status review-warning" id="review-dialog-status" role="status"></p></div><footer class="review-dialog-actions"><button class="btn secondary" data-dialog-cancel>返回</button>${actions.map((action,i)=>`<button class="btn ${action.primary?'primary':'secondary'}" data-dialog-action="${i}">${esc(action.label)}</button>`).join('')}</footer>`;
    document.body.append(dialog);this.dialog=dialog;
    const close=()=>{if(this.uploading){this.dialogStatus('文件正在保存，请等待上传结果。');return;}dialog.close();};dialog.querySelector('.review-agent-close')!.addEventListener('click',close);dialog.querySelector('[data-dialog-cancel]')!.addEventListener('click',close);dialog.addEventListener('cancel',event=>{if(this.uploading){event.preventDefault();this.dialogStatus('文件正在保存，请等待上传结果。');}});
    dialog.querySelectorAll<HTMLButtonElement>('[data-dialog-action]').forEach(button=>button.addEventListener('click',async()=>{const buttons=[...dialog.querySelectorAll<HTMLButtonElement>('[data-dialog-action]')];buttons.forEach(b=>b.disabled=true);try{await actions[Number(button.dataset.dialogAction)].action();}catch(error){this.dialogStatus(friendlyError(error));}finally{buttons.forEach(b=>b.disabled=false);}}));dialog.showModal();
  }
  private dialogStatus(text:string){const target=this.dialog?.querySelector('#review-dialog-status');if(target)target.textContent=text;}
}

export function renderNewReview(api:ApiClient,shell:(html:string,section:string)=>void,current:()=>boolean){
  shell(`<div class="review-workspace"><header class="review-header"><div><p class="review-kicker">PROSPECTUS REVIEW</p><h1>复核募集说明书</h1><p class="review-muted">财务数据、合规与格式、公开信息，三类依据交叉核验。</p></div></header><form id="review-create-form" class="review-panel review-create"><h2>准备复核项目</h2><p class="review-muted">先建立项目，再提供待复核稿和审计／财务材料。未确定的信息可从材料识别。</p><label for="review-name">项目名称 <small>选填</small></label><input id="review-name" name="name" maxlength="160" placeholder="例如：某公司募集书复核"><label for="review-issuer">发行人 <small>选填</small></label><input id="review-issuer" name="issuer" maxlength="200"><div class="review-form-row"><div><label for="review-market">市场 <small>选填</small></label><select id="review-market" name="market"><option value="">从材料识别</option>${Object.entries(MARKET_LABELS).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></div><div><label for="review-offering">品种 <small>选填</small></label><select id="review-offering" name="offering"><option value="">从材料识别</option></select></div></div><p id="review-create-status" class="review-status" role="status"></p><div class="review-form-actions"><button class="btn primary" type="submit">创建项目，提供材料</button><a class="btn secondary" href="#dashboard">返回工作台</a></div></form></div>`,'review');
  const form=document.querySelector<HTMLFormElement>('#review-create-form')!,market=form.querySelector<HTMLSelectElement>('#review-market')!,offering=form.querySelector<HTMLSelectElement>('#review-offering')!;
  market.addEventListener('change',()=>{const options=market.value?MARKET_OFFERINGS[market.value as Market]:[];offering.innerHTML='<option value="">从材料识别</option>'+options.map(value=>`<option value="${value}">${OFFERING_LABELS[value]}</option>`).join('');});
  form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector<HTMLButtonElement>('[type=submit]')!;if(button.disabled)return;button.disabled=true;const status=form.querySelector('#review-create-status')!;status.textContent='正在创建项目…';try{const issuer=(form.elements.namedItem('issuer') as HTMLInputElement).value.trim();const name=(form.elements.namedItem('name') as HTMLInputElement).value.trim()||`${issuer||'募集书'}复核`;const project=await api.create({name,kind:'review',issuer_name:issuer||null,market:market.value as Market||null,offering:offering.value as Offering||null});if(current())location.hash=`/projects/${encodeURIComponent(project.project_id)}/review?tab=materials`;}catch(error){if(current())status.textContent=friendlyError(error);}finally{button.disabled=false;}});
}
