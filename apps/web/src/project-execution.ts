import { canReviewFirstDraft, checkedFirstDraftExclusions, sameFirstDraftExclusions } from './first-draft-confirmation';
import type { FirstDraftConfirmationRequest, FirstDraftExclusionsResponse, ProspectusVersions } from '@bondbuddy/contracts';
import {int64} from '@bondbuddy/contracts';
import {isAutomaticCharge} from './commerce';
import {billingTaskRechargeHrefForRequest} from './billing-task-recovery';
import {UserFacingError} from './user-facing-error.js';
import { ArtifactPage } from './artifact-page';
import { authoringTasks,taskHref,type ProjectTask } from './project-collection-model';
import { prototypeIcon as icon } from './prototype-design';
import { reportingWindow, sourceProspectusInputGaps, type RunState, type RUN_PAUSE_STAGES, type RUN_RUNTIME_REASONS, type ProjectMessageSetRef, type ProspectusVersion } from '@bondbuddy/contracts';
import { ApiClient, ApiError, errorReference, friendlyError, type Dto } from './api';
import type { Draft } from './draft';
import { executionRequest, executionTaskKind, type ExecutionTaskKind } from './execution-request';
import { referencePin, selectedReference, type ReferenceSnapshotResolver, type UserReferenceChoice } from './reference';
import type { ProjectConversation } from './project-conversation';
import { date, esc } from './ui';
import './project-execution.css';
import { retainAuthoringEvents } from './authoring-progress';
import {authoringStatusCard,authoringStatusRecords,authoringStatusReceipt,retryExplanation} from './authoring-status';
import '../../../product-prototype/public/authoring-status.css';
import { rechargeHref, withProjectContext } from './project-navigation';
import { readContinuationBasis, renderContinuationSummary, type ContinuationBasis, type ContinuationChoice } from './authoring-continuation';
import { syncFormatTemplateMode } from './source-format-template';
import {isCnyPrice,displayPrice,confirmCnyTask,readCommerce,scopePending,scopeLinesHtml,scopeLifecycleHtml,scopeStatusLabel} from './commerce';

type Input = Dto<'InputRevisionResponse'>;
type Material = Dto<'MaterialResponse'>;
const states: Record<RunState, string> = {
  preparing: '准备中', rejected: '未启动', queued: '排队中', running: '处理中', awaiting_input: '待补充信息',
  paused: '任务已暂停', validating: '检查成果中', delivering: '交付中', settlement_pending: '结算处理中',
  succeeded: '已生成', test_completed: '内部测试工作稿', failed: '任务失败', cancelled: '已取消'
};
const stages: Record<string, string> = { input_lock: '核对输入与规则', materials_ready: '读取材料',
  model_generation: '生成全文内容', provider_call: '正在编制募集书', word_delivery: '正在准备 Word 下载', capability_not_ready: '等待处理条件',
  queued: '任务已提交，正在排队', claimed: '已接单，正在准备材料', completed: '处理完成' };

type PauseStage = (typeof RUN_PAUSE_STAGES)[number];
type RuntimeReason = (typeof RUN_RUNTIME_REASONS)[number];
const automaticPauseMessages: Partial<Record<PauseStage, string>> = {
  trial_limit: '当前更新暂受试用限制，限制解除后自动继续。'
};
const runtimeMessages: Partial<Record<RuntimeReason, string>> = {
  model_tokens_per_user_per_day: '今日试用额度已用完，额度恢复后自动继续。',
  kill_switch: '更新服务暂时停用，服务恢复后自动继续。',
  trial_limit_cleared: '试用限制已解除，任务继续处理。'
};

function automaticPauseMessage(run: Dto<'RunResponse'> | undefined) {
  return run?.state === 'paused' && run.stage && Object.hasOwn(automaticPauseMessages, run.stage)
    ? automaticPauseMessages[run.stage as PauseStage] : undefined;
}
function runtimeMessage(reason: string | undefined) {
  return reason && Object.hasOwn(runtimeMessages, reason) ? runtimeMessages[reason as RuntimeReason] : undefined;
}
const pendingConditions = '当前处理条件尚未就绪；已保存资料不会丢失。请稍后重新检查，持续未恢复时请联系支持。';
function blockedMessage(check: Dto<'PreflightResponse'>): string {
  const reasons = check.blocking_inputs;
  if (reasons.length !== 1) return pendingConditions;
  const reason = reasons[0];
  if (reason === 'target_market_offering_required') return '请在项目信息中选择本次目标市场和发行方式。';
  if (reason === 'material_versions') return '请先添加并保存本次需要的材料。';
  if (reason.startsWith('material_parse_failed:') || reason.startsWith('material_parse_cancelled:')) return '有文件处理未完成，请查看材料区的失败原因。';
  if (reason.startsWith('material_parse_') || reason.startsWith('ocr_pending:')) return '材料正在处理，请稍后重新检查。';
  if (reason.startsWith('issuer_identity_') || reason.startsWith('issuer_material_')) return '发行人身份核验尚未完成，请联系支持核对已保存的发行人材料；核验完成后重新检查。无需重复上传或反复继续。';
  if (reason.startsWith('user_reference_') || reason.startsWith('reference_selection_') || reason === 'reference_structure_unavailable') return readinessMessage(reason);
  return pendingConditions;
}

export function executionInputError(error: unknown, kind: Dto<'ProjectResponse'>['kind'], hasHistorical: boolean | null, materials: readonly Material[], unified = false): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'INPUT_REQUIRED' || error.status !== 409) return undefined;
  const reference = errorReference(error);
  if (unified) return `本次输入尚未满足执行条件，请核对本次目标及已上传原稿的信息；历史／参考募集书为必填，已保存稿件无需重复上传。${reference}`;
  if (kind === 'update' && !materials.some(material => material.role === 'historical') &&
      materials.some(material => material.role === 'reference'))
    return `已上传募集书被登记为参考稿。更新需本发行人历史稿及身份核验；若该文件是本发行人的历史募集书，请联系支持保留原文件并更正分类后重新锁定输入。若确实没有本发行人历史稿，请联系支持转为新稿；无需重传。${reference}`;
  if (hasHistorical === true && !materials.some(material => material.role === 'historical'))
    return `本项目选择了有历史稿，但尚未添加本发行人历史募集书。请在历史稿分区添加对应文件。${reference}`;
  if (hasHistorical === true && !materials.some(material => ['audit', 'financial', 'interimFinancial', 'notes'].includes(material.role)))
    return `本项目还没有已保存的审计报告或财务报表，请在现有财务材料分区添加。${reference}`;
  if (hasHistorical === false && materials.some(material => material.role === 'reference') &&
      materials.some(material => ['audit', 'financial', 'interimFinancial', 'notes'].includes(material.role)))
    return `新稿尚未满足执行条件。请联系支持核对已保存财务材料的发行人身份核验及新稿处理条件；相似稿仅作参考，不要把相似稿改作本发行人历史稿。无需重传。${reference}`;
  return undefined;
}

/** Presentation only: the server remains authoritative about readiness and run transitions. */
export function executionEventReason(payload: Dto<'RunEvent'>['payload'] | undefined): string | undefined {
  return ['WORD_FORMAT_OPERATIONS_MISSING','MATERIAL_UNREADABLE'].includes(payload?.error_code ?? '') && payload?.reason === 'processor_failed'
    ? payload.error_code : payload?.reason ?? payload?.error_code;
}

export function readinessMessage(reason: string, lastProcessingStage?: string): string {
  if (reason === 'word_size_repair_exhausted') return '募集说明书篇幅异常，自动修复两轮后仍未通过检查，任务已暂停。原始材料、草稿和检查记录已保留，请联系支持继续处理，无需重新上传材料。';
  if (reason === 'MATERIAL_UNREADABLE') return '有材料无法读取，本轮未能交付。请点击“继续修改”，检查本轮文件并重新导出不可读材料，上传可读副本后重新开始；原任务和已保存材料会保留。';
  if (reason === 'WORD_FORMAT_OPERATIONS_MISSING') return '本轮编制未保存必需的修订记录，尚未生成可交付的 Word。已保存材料会保留，无需重新上传；请联系支持核对本轮结果。';
  if (reason === 'processor_failed') return lastProcessingStage === 'word_delivery'
    ? 'Word 文件生成或保存失败，本轮未能交付。已保存材料会保留，无需重新上传；请联系支持核对并恢复。'
    : '系统处理失败，本轮未能完成。已保存材料会保留；请联系支持核对原因，无需因本提示补充材料。';
  if (reason === 'provider_result_pending' || reason === 'provider_reconciliation_required') return '本次模型处理尚未确认结果，系统正在核对。已保存材料会保留；若持续未恢复，请联系支持。';
  if (reason === 'file_authoring_payload_recovery_pending') return '本次处理内容超过模型接口的单次容量，正在核对已保存的工作进度，随后自动调整并继续；无需重新提交。';
  if (reason === 'file_authoring_payload_retry_scheduled') return '工作进度已保存，系统已安排使用较小的请求自动续跑，仍是本次任务。';
  if (reason === 'file_authoring_payload_retries_exhausted') return '系统已自动调整并尝试恢复，但处理内容仍超过接口容量，本次未能完成。已保存材料和工作文件会保留，请联系支持继续处理。';
  if (reason === 'file_authoring_payload_recovery_unavailable') return '本次请求内容过大，且未能保存完整的续跑进度，系统已停止自动重试。已保存材料会保留，请联系支持核对。';
  if (reason === 'file_authoring_output_limit_recovery_pending') return '处理输出超过安全上限，正在核对可恢复进度和调用记录；符合条件时自动继续本次任务。';
  if (reason === 'file_authoring_output_limit_retry_scheduled') return '工作进度已保存，系统已安排接续已有工作，仍是本次任务。';
  if (reason === 'file_authoring_output_limit_recovery_unavailable') return '处理输出超过安全上限，恢复进度未通过核验，系统已停止自动重试。请联系支持核对。';
  if (reason === 'file_authoring_output_limit_retries_exhausted') return '系统已尝试恢复，但自动恢复次数已用完，本次未能完成。请联系支持处理。';
  if (reason === 'provider_timeout_retries_exhausted') return '编制服务多次响应超时，本次未能完成。已保存材料和已完成内容仍保留，请联系支持继续处理。';
  if (reason === 'authoring_target_information_required') return '请补齐目标发行人、市场、品种和报告年度／一期。保存后停止本次任务，再点继续修改，以新输入重新编制。';
  if (reason === 'authoring_source_information_required') return '旧任务保留原输入，请联系支持恢复；新一轮编制前需补齐上传原稿的信息。';
  if (reason === 'authoring_issuer_materials_required') return '请先停止本次任务并点击“继续修改”，补充目标发行人的材料后重新编制；其他企业的参考稿不能代替目标企业事实。';
  if (reason === 'authoring_ocr_incomplete') return '扫描材料仍有页面未能读取，请查看材料或联系支持；任务没有跳过这些页面。';
  if (reason === 'authoring_material_unreadable') return '有材料无法读取，请先停止本次任务并点击“继续修改”，替换文件后重新编制。';
  if (reason === 'authoring_no_verified_changes') return '本轮未形成有依据的正文修改，尚未交付新成果。请核对本次材料和更新要求。';
  if (runtimeMessage(reason)) return runtimeMessage(reason)!;
  if (reason === 'TRIAL_ACCESS_DENIED') return '当前账号的试用权限已停用，请联系支持。';
  if (reason.startsWith('rule_pack:') || reason.startsWith('rule_applicability_')) return '适用规则的处理条件尚未就绪，请联系支持核对。';
  if (reason.startsWith('issuer_identity_') || reason.startsWith('issuer_material_')) return '发行人资料的后台绑定尚未完成，请联系支持确认是否需要补充材料。';
  if (reason === 'material_versions') return '尚未选择已保存的材料。';
  if (reason.startsWith('material_parse_failed:')) return '有材料解析失败，请查看材料区。';
  if (reason.startsWith('material_parse_cancelled:')) return '有材料解析已取消，请查看材料区。';
  if (reason.startsWith('material_parse_')) return '等待材料解析完成。';
  if (reason.startsWith('ocr_')) return '文件处理尚未完成，请稍后重试。';
  if (reason.startsWith('source_profile_')) return '历史稿处理暂未就绪，请稍后重试；持续未恢复时请联系支持。';
  if (reason.startsWith('material_needs_confirmation:')) return '材料内容尚有待核部分，请联系支持核对任务状态。';
  if (reason.startsWith('credit_facility_')) return '授信补充仍属用户提供，需核对日期、单位、口径或冲突。';
  if (reason.startsWith('update_difficulty_')) return '报告期与更新难度仍需核对。';
  if (reason.startsWith('user_reference_')) return '用户指定参考稿尚未通过结构参考审核，暂不能作为新稿依据。';
  if (reason.startsWith('reference_selection_') || reason === 'reference_structure_unavailable') return '尚未匹配到可用作结构参考的相似募集书。';
  if (reason.includes('provider_reconcil')) return '正在核对先前模型调用，暂不重复调用。';
  if (reason.includes('capability_not_ready')) return '所需处理能力尚未就绪。';
  if (reason === 'user_cancelled') return '用户已取消任务。';
  return '本次处理未能继续，具体原因尚未确认。已保存材料会保留，请联系支持核对。';
}

/** Stable across tabs/reloads; a new input revision is required for an intentional new run. */
export class ProjectExecution {
  private controller = new AbortController();
  private host!: HTMLElement;
  private actions!: HTMLElement;
  private materialMessage = '';
  private restoring = false;
  private recoveredInputMessages?: ProjectMessageSetRef;
  private uncertainInputSave?: { generation: number; draftRevision: number; afterRevision: number;
    materialVersions: Input['material_versions']; messages: ProjectMessageSetRef };
  private input?: Input;
  private selectedMessages?: ProjectMessageSetRef;
  private starting = false;
  private nextRequested = false;
  private previousResultMode?: string;
  private nextChoice: ContinuationChoice = 'current';
  private nextBasis?: ContinuationBasis;
  private nextBasisLoading = false;
  private nextBasisRead = 0;
  private nextBasisError = '';
  private nextNeedsProjectRefresh = false;
  private otherActiveRun?: string;
  private preparationAfter = 0;
  private knownLatestInput = 0;
  private materialRun?: string;
  private delivery?: ArtifactPage;
  private deliveryId?: string;
  private locateResult?: (returning?: boolean) => void;
  private events: Dto<'RunEvent'>[] = [];
  private firstDraftReview?: { exclusions: FirstDraftExclusionsResponse; context: string; generation: number; selectionRevision: number };
  private firstDraftConfirmation?: { request: FirstDraftConfirmationRequest; context: string; generation: number; selectionRevision: number };
  private selected = false;
  private preflight?: Dto<'PreflightResponse'>;
  private run?: Dto<'RunResponse'>;
  private retryOffer?:Dto<'RunRetryResponse'>;
  private retryReadKey?:string;
  private retryFeedback='';
  private retryDialog?:HTMLDialogElement;
  private pendingRunRetry?:{runId:string;request:Dto<'RunRetryRequest'>};
  private runMaterialsKey?:string;
  private runMaterialPins?:Input['material_versions'];
  private runMaterials:Material[]=[];
  private runMaterialsError='';
  private viewingProjectMaterials=false;
  private latestArtifact?: string;
  private reason?: string;
  private eventCursor = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private runReadVersion = 0;
  private eventStream?: EventSource;
  private streamRun?: string;
  private streamDirty = false;
  private busy = false;
  private inputReadUncertain = false;
  private inputWriteUncertain = false;
  // Keep the complete sent envelope until its own receipt or a definitive rejection.
  // A retry must not pick up a new quote, baseline, draft or message selection.
  private pendingExecution?: Dto<'ExecuteRequest'>;
  private pendingExecutionConflict = false;
  private resumeVerified = false;
  private resumedPause?: { runId: string; stage: string | null; reason?: string };
  private lastPausedEvent?: Dto<'RunEvent'>;
  private pauseBeforeResume?: Dto<'RunEvent'>;
  private repeatedPauseEvent?: Dto<'RunEvent'>;
  private message = '';
  private creditDialog?: HTMLDialogElement;
  private creditPromptShown = false;
  private progressMessage = '';
  private materials: Material[] = [];
  private sourceStamp = '';
  private materialReady = false;
  private generation = 0;
  private inputRejected = false;
  private quote?: Dto<'FixedQuoteResponse'>;
  private commerceEnabled=false;private automaticBilling=false;
  private charge?: Dto<'RunCreditChargeResponse'>;
  private chargeRun?: string;
  private chargeRetryTimer?: ReturnType<typeof setTimeout>;
  private chargeLoading = false;
  private chargeRefreshPending = false;
  private chargeError = false;
  private paidEnabled?: boolean;
  private awaitingCredits = new URLSearchParams(location.hash.split('?')[1] ?? '').get('resume') === 'credits';
  private fundingHref?:string;

  constructor(private api: ApiClient, private draft: Draft, private conversation: ProjectConversation,
    private referenceSnapshots?: ReferenceSnapshotResolver, private onStaleInput?: () => void,
    private initialNotice = '', private onDelivered?:()=>void,
    private refreshPreparation?:()=>Promise<boolean>, private readMaterialBlock?:()=>string,
    private onMaterialsEditable?:(editable:boolean)=>void,
    private readAdoptedVersion?:()=>ProspectusVersion|null) {}
  private get active() { return !this.controller.signal.aborted; }
  private get id() { return this.draft.project.project_id; }
  get hasUnconfirmedRequest() { return Boolean(this.pendingExecution || this.inputWriteUncertain); }
  get inheritsResultFormat() {
    if (this.nextRequested) return Boolean(this.nextBasis?.editBase || this.nextChoice === 'result');
    return this.readAdoptedVersion?.()?.origin === 'generated';
  }
  get materialsEditable() {
    return this.active && !this.restoring && !this.inputReadUncertain && !this.pendingExecution && !this.starting && !this.busy && (!this.run || this.nextRequested);
  }
  /** The persisted project kind decides the task kind, including an explicit server-side conversion. */
  private get taskKind(): ExecutionTaskKind { return executionTaskKind(this.draft.project.kind); }
  mount(host: HTMLElement, actions: HTMLElement) {
    this.host = host; this.actions = actions;
    host.innerHTML = '<p id="execution-read-message" class="muted" role="status" hidden></p><details id="previous-execution" class="previous-execution" open><summary id="previous-execution-summary" hidden><span>上一轮任务与成果</span><small data-previous-execution-state></small></summary><section class="panel execution-panel" id="run-panel" hidden><div id="execution-progress" aria-live="polite"></div></section><div id="execution-delivery" class="embedded-artifact"></div></details>';
    actions.innerHTML = `<div id="execution-preflight" hidden></div><section id="execution-first-draft" class="fixed-quote" aria-labelledby="first-draft-title" hidden><h3 id="first-draft-title">确认按首稿编制</h3><p>以下历史募集书未包含在本次材料中。按首稿执行将根据当前材料编制新稿。</p><ul id="first-draft-exclusions"></ul><button class="btn primary" type="button" id="confirm-first-draft">按首稿执行</button></section><p id="execution-message" role="status"></p><p id="start-disabled-reason" role="status"></p><div class="execution-submit-row"><div class="start-buttons"><button class="text-button" type="button" id="refresh-execution" hidden>重新读取</button><button class="text-button" type="button" id="recheck-input" hidden>重新检查处理条件</button><button class="text-button" type="button" id="complete-source-information" aria-describedby="start-disabled-reason" hidden>补齐这份原稿信息</button><button class="btn primary" type="button" id="execute-input" aria-describedby="start-disabled-reason execution-message execution-credit-hint">开始更新 ${icon('arrow')}</button></div></div>`;
    this.button('execute-input').addEventListener('click', () => { void this.start(); });
    this.button('confirm-first-draft').addEventListener('click', () => { void this.confirmFirstDraft(); });
    this.button('complete-source-information').addEventListener('click', () => { this.focusMissingSourceInformation(); });
    this.button('refresh-execution').addEventListener('click', () => { void this.restore(); });
    const retry=document.createElement('button');retry.type='button';retry.className='text-button';retry.id='retry-execution';retry.hidden=true;retry.textContent='核对上次提交';
    this.button('refresh-execution').after(retry);
    retry.addEventListener('click',()=>{void this.retryExecution();});
    this.button('recheck-input').addEventListener('click', () => { void this.recheck(); });
    this.sync([], false, '正在读取已保存材料…');
    void this.restore();
    void readCommerce(this.api,this.controller.signal).then(c=>{if(this.active){this.commerceEnabled=c?.enabled===true;this.automaticBilling=c?.model==='subscription_and_topup';this.render();}}).catch(()=>{});
    void this.api.creditBalance(this.controller.signal).then(balance => {
      if (this.active) { this.paidEnabled = balance.enabled; this.render(); }
    }).catch(() => {});
  }
  private node(selector: string) { return this.host.querySelector<HTMLElement>(selector) ?? this.actions.querySelector<HTMLElement>(selector)!; }
  private rechargeLink(){if(this.fundingHref)return this.fundingHref;const [path,search='']=location.hash.split('?'),query=new URLSearchParams(search);query.set('resume','credits');return rechargeHref(this.id,path+'?'+query);}
  private eligibleMaterials() {
    return this.materials;
  }
  /**
   * Resolves the structural reference for a no-history generation project. The parse snapshot id is
   * owner-visible only through a backend seam, and the selected version is re-checked against the
   * fresh read first. When the user *did* select a reference, a version change, a missing snapshot or
   * a failed read is a hard stop: the caller must not create a reference-less input or run, and tells
   * the user to refresh saved materials and re-select. A project with no selected reference keeps the
   * optional path.
   */
  private async referenceFor(project: Dto<'ProjectResponse'>, selected: readonly Material[]): Promise<
    { status: 'none' } | { status: 'pinned'; choice: UserReferenceChoice } | { status: 'blocked'; message: string }> {
    if (this.draft.fields.update_details.authoring_mode === 'unified_v1') return { status: 'none' };
    if (project.kind !== 'generation' || this.draft.fields.update_details.has_historical !== false) return { status: 'none' };
    const reference = selectedReference(selected, this.draft.fields.update_details.has_historical);
    if (!reference) return { status: 'none' };
    if (!project.market || !project.offering) {
      return { status: 'blocked', message: '用户指定参考稿的目标市场与发行方式尚未保存，请刷新项目信息并重新选择参考稿后再开始更新。' };
    }
    let fresh: Material;
    try {
      fresh = this.referenceSnapshots ? await this.referenceSnapshots(this.id, reference) : reference;
    } catch {
      return { status: 'blocked', message: '用户指定参考稿信息暂时无法读取，请刷新已保存材料并重新选择参考稿后再开始更新。' };
    }
    const resolved = referencePin(reference, fresh, project.offering);
    return 'note' in resolved ? { status: 'blocked', message: resolved.note } : { status: 'pinned', choice: resolved.choice };
  }
  private firstDraftContext() {
    return JSON.stringify([this.id,this.draft.project.kind,this.draft.project.draft_revision,this.draft.fields,
      this.materials.map(m=>[m.material_id,m.material_version,m.role,m.sha256]).sort(),this.readAdoptedVersion?.()??null,
      this.nextRequested,this.nextChoice,this.nextBasis?.key??null]);
  }
  private clearFirstDraft() { this.firstDraftReview=undefined;this.firstDraftConfirmation=undefined; }
  private expireFirstDraft() {
    const decision=this.firstDraftReview??this.firstDraftConfirmation;
    if(decision&&(decision.generation!==this.generation||decision.context!==this.firstDraftContext()))this.clearFirstDraft();
  }
  private firstDraftAvailable(versions:ProspectusVersions) {
    return !this.readAdoptedVersion?.() && !this.nextBasis?.editBase && (!this.nextRequested||this.nextChoice!=='result') &&
      canReviewFirstDraft(this.id,this.draft.project.kind,this.eligibleMaterials(),versions);
  }
  private async readFirstDraftReview() {
    if(this.draft.project.kind!=='generation')return undefined;
    const context=this.firstDraftContext(),generation=this.generation;
    const [preview,versions]=await Promise.all([this.api.firstDraftExclusions(this.id,this.controller.signal),this.api.prospectusVersions(this.id,this.controller.signal)]);
    if(!this.active||context!==this.firstDraftContext()||generation!==this.generation||this.materialBlock())return undefined;
    const exclusions=checkedFirstDraftExclusions(preview,this.id,this.draft.project.draft_revision);
    if(!exclusions||!this.firstDraftAvailable(versions))return undefined;
    return {exclusions,context,generation,selectionRevision:versions.selection_revision};
  }
  private async offerFirstDraftReview() {
    this.clearFirstDraft();
    const review=await this.readFirstDraftReview();
    if(!review){this.message='项目材料或底稿状态已变化，请刷新已保存材料后重新开始。';return;}
    this.firstDraftReview=review;
    this.message='项目中仍有历史募集书未包含在本次材料中，请核对上方列表后决定是否按首稿执行。';
  }
  private async confirmFirstDraft() {
    this.expireFirstDraft();
    const reviewed=this.firstDraftReview;
    if(!this.active||!reviewed||this.busy||this.starting||this.restoring||this.pendingExecution||this.inputReadUncertain||this.materialBlock())return;
    let confirmed=false;
    await this.action(async()=>{
      const fresh=await this.readFirstDraftReview();
      if(!fresh||reviewed.context!==this.firstDraftContext()||reviewed.generation!==this.generation){this.clearFirstDraft();this.message='项目材料或底稿状态已变化，请重新开始并核对。';return;}
      if(fresh.selectionRevision!==reviewed.selectionRevision||!sameFirstDraftExclusions(reviewed.exclusions,fresh.exclusions)){
        this.firstDraftReview=fresh;this.firstDraftConfirmation=undefined;this.message='历史稿列表已变化，请重新核对后再点击“按首稿执行”。';return;
      }
      this.firstDraftConfirmation={context:fresh.context,generation:fresh.generation,selectionRevision:fresh.selectionRevision,
        request:{decision:'generate_first_draft',scope:fresh.exclusions.scope,excluded_historical:fresh.exclusions.excluded_historical.map(({material_id,material_version,sha256})=>({material_id,material_version,sha256}))}};
      this.firstDraftReview=undefined;this.message='';confirmed=true;
    },'other','read');
    if(confirmed)await this.start();
  }
  private startBlock(): { reason: string; sourceGap?: ReturnType<typeof sourceProspectusInputGaps>[number] } {
    this.expireFirstDraft();
    if(this.firstDraftReview)return {reason:'请先核对历史稿列表，并明确选择是否按首稿执行。'};
    if (this.run && !['succeeded','test_completed','failed','cancelled','rejected'].includes(this.run.state)) return { reason: '已有任务正在处理，请查看上方进度。' };
    if (this.restoring) return { reason: '正在读取项目状态…' };
    if (this.busy || this.starting) return { reason: '正在提交，请稍候。' };
    if (this.pendingExecution) return { reason: this.pendingExecutionConflict?'上次提交的记录存在冲突，请重新读取并联系支持核对。':'上次提交结果尚未确认，请重新读取或点击“核对上次提交”。' };
    if (this.inputReadUncertain) return { reason: '上次操作结果尚未确认，请重新读取。' };
    if (this.otherActiveRun) return { reason: '项目已有另一轮任务正在处理，请重新读取任务状态后继续。' };
    if (this.nextRequested && (this.nextBasisLoading || !this.nextBasis || this.nextBasisError)) return { reason: this.nextBasisError || '正在核对下一轮采用稿与已保存材料…' };
    if (this.inputRejected) return { reason: '本次输入已被拒绝；请按上方提示处理，输入不变时无需重复提交。' };
    if (this.preflight?.status === 'blocked' && this.selected) return { reason: '当前处理条件尚未就绪，请重新检查；条件未变时无需重复提交。' };
    const materialBlock = this.materialBlock();
    if (materialBlock) return { reason: materialBlock };
    if (!this.eligibleMaterials().length) return { reason: '请先添加本次需要的项目材料。' };
    if (this.draft.state === 'conflict' || this.draft.state === 'error' || !this.draft.valid) return { reason: '项目信息尚未保存，请返回上一步处理。' };
    if (!this.draft.fields.market || !this.draft.fields.offering) return { reason: '请在上一步选择发行市场和发行方式。' };
    if (this.run && !this.nextRequested) return { reason: '需要再次修改时，请点击上方“继续修改”。' };
    const sourceGaps = sourceProspectusInputGaps(this.eligibleMaterials(), this.draft.fields.update_details.source_prospectuses);
    if (sourceGaps.length) {
      const first = sourceGaps[0], material = this.materials.find(m => m.material_id === first.material_id);
      return { reason: `请补齐“${material?.filename ?? '历史／参考募集书'}”的${first.missing.join('、')}后继续${sourceGaps.length > 1 ? `（共 ${sourceGaps.length} 份原稿待补充）` : ''}。`, sourceGap: first };
    }
    if (this.conversation.blockReason) return { reason: this.conversation.blockReason };
    return { reason: '' };
  }
  private materialBlock() {
    // Read the live upload queue as well as the last rendered snapshot. A stale
    // enabled button must never lock an input that omits an unfinished file.
    return this.readMaterialBlock?.() || (!this.materialReady ? this.materialMessage || '材料尚未保存完成，请查看文件进度。' : '');
  }
  private focusMissingSourceInformation() {
    if (!this.materialsEditable) return;
    const gap = this.startBlock().sourceGap;
    if (!gap) return;
    const unavailable = () => {
      this.message = '这份原稿的信息位置或材料版本暂时无法核实，请点击“刷新已保存材料”后再试。';
      this.render();
    };
    const materials = this.eligibleMaterials().filter(material => material.material_id === gap.material_id);
    if (materials.length !== 1) { unavailable(); return; }
    const material = materials[0];
    const editors = document.querySelectorAll<HTMLFieldSetElement>('#material-editing');
    if (editors.length !== 1) { unavailable(); return; }
    const fields = [...editors[0].querySelectorAll<HTMLFieldSetElement>('fieldset[data-source-material]')].filter(field => field.dataset.sourceMaterial === material.material_id);
    if (fields.length !== 1) { unavailable(); return; }
    const source = fields[0];
    if (source.dataset.sourceMaterialVersion !== String(material.material_version) || source.dataset.sourceSha256 !== material.sha256) { unavailable(); return; }
    const editable = (control: HTMLInputElement | HTMLSelectElement) => control.isConnected && !control.matches(':disabled') && !control.closest('[hidden],[inert]') && control.getAttribute('aria-disabled') !== 'true' && !(control instanceof HTMLInputElement && control.readOnly);
    const select = (field: string) => {
      const controls = source.querySelectorAll<HTMLSelectElement>(`select[data-source-field="${field}"]`);
      return controls.length === 1 ? controls[0] : undefined;
    };
    const field = ({ 企业关系: 'relation', 原发行市场: 'market', 原品种: 'offering' } as Record<string, string>)[gap.missing[0]];
    let control: HTMLInputElement | HTMLSelectElement | undefined;
    if (field) control = select(field);
    else if (gap.missing[0] === '原稿最新报告期') {
      const year = select('year');
      const quarters = [...source.querySelectorAll<HTMLInputElement>('input[type="radio"][data-source-field="quarter"]')];
      if (!year || !editable(year) || !quarters.length || new Set(quarters.map(quarter => quarter.value)).size !== quarters.length) { unavailable(); return; }
      control = year.value && !quarters.some(quarter => quarter.checked) ? quarters.find(editable) : year;
    }
    if (!control || !editable(control)) { unavailable(); return; }
    const details: HTMLDetailsElement[] = [];
    for (let parent = control.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) details.push(parent);
    details.reverse().forEach(detail => { detail.open = true; });
    control.scrollIntoView({ block: 'center' });
    control.focus({ preventScroll: true });
    if (document.activeElement !== control) unavailable();
  }
  private invalidate() {
    if (this.recoveredInputMessages) this.message = '内容已修改，将按当前材料与要求开始更新。';
    this.recoveredInputMessages = undefined;
    this.clearFirstDraft();
    this.generation++; this.selected = false; this.selectedMessages = undefined; this.preflight = undefined;
    this.resumeVerified = false;
    this.quote = undefined;
    this.inputRejected = false;
    this.render();
  }
  conversationChanged() { if (this.active) this.invalidate(); }
  sync(materials: Material[], ready: boolean, materialMessage = '') {
    if (!this.active) return;
    const stamp = JSON.stringify([this.draft.fields, materials.map(m => [m.material_id, m.material_version,m.role,m.sha256]).sort(),this.readAdoptedVersion?.()??null]);
    const changed = stamp !== this.sourceStamp || (this.materialReady && !ready);
    this.materials = materials; this.materialReady = ready; this.materialMessage = materialMessage;
    if (changed) {
      this.sourceStamp = stamp;
      this.invalidate();
    }
    this.render();
  }
  private button(id: string) { return this.node(`#${id}`) as HTMLButtonElement; }
  private samePauseAfterResume(run: Dto<'RunResponse'>) {
    if (this.resumedPause?.runId === run.run_id && this.resumedPause.stage === run.stage && this.resumedPause.reason === this.reason) return true;
    return this.repeatedPauseEvent?.stage === run.stage && this.repeatedPauseEvent.payload.reason === this.reason;
  }
  private render() {
    if (!this.active) return;
    syncFormatTemplateMode(document.querySelector('#material-partitions') ?? this.host, this.inheritsResultFormat);
    const activeRun = this.run && !['succeeded','test_completed','failed','cancelled','rejected'].includes(this.run.state);
    const materialsLocked = Boolean(this.pendingExecution || this.run && !this.nextRequested);
    this.onMaterialsEditable?.(this.materialsEditable&&!this.hasUnconfirmedRequest);
    const editsFrozen=Boolean(this.pendingExecution || this.inputWriteUncertain);
    const form=document.querySelector<HTMLElement>('#draft-form');if(form)form.inert=editsFrozen;
    const versionPanel=document.querySelector<HTMLElement>('#prospectus-panel');if(versionPanel)versionPanel.inert=editsFrozen;
    for(const id of ['edit-project-details','previous-details']){const button=document.querySelector<HTMLButtonElement>('#'+id);if(button)button.disabled=editsFrozen;}
    const preparationGuide=document.querySelector<HTMLElement>('[data-authoring-preparation-guide]');
    if(preparationGuide){
      preparationGuide.hidden=!this.materialsEditable||!this.nextRequested;
      preparationGuide.setAttribute('aria-label',this.nextRequested?'准备下一轮募集书':'准备本轮材料与要求');
      const title=preparationGuide.querySelector<HTMLElement>('[data-authoring-preparation-title]');
      if(title)title.hidden=!this.nextRequested;
      const summary=preparationGuide.querySelector<HTMLElement>('[data-next-authoring-summary]');
      if(summary){
        summary.hidden=!this.nextRequested;
        if(this.nextRequested){
          const resultAvailable=this.run?.state==='succeeded'&&this.run.channel==='production';
          summary.innerHTML=`<label class="continuation-basis-choice">本轮底稿<select data-next-basis-choice ${this.nextBasisLoading?'disabled':''}><option value="result" ${this.nextChoice==='result'?'selected':''} ${resultAvailable?'':'disabled'}>正在查看的这轮成功成果</option><option value="current" ${this.nextChoice==='current'?'selected':''}>项目当前采用稿</option></select></label>${this.nextBasis?renderContinuationSummary(this.nextBasis,this.draft.fields,this.eligibleMaterials()):''}<p role="status" class="continuation-status">${esc(this.nextBasisLoading?'正在核对采用稿与已保存材料…':this.nextBasisError)}</p><div class="authoring-preparation-actions"><button type="button" class="text-btn" data-next-edit-details>编辑目标期间与项目信息</button><button type="button" class="text-btn" data-next-refresh-basis ${this.nextBasisLoading?'disabled':''}>${this.nextNeedsProjectRefresh?'重新载入项目资料':'重新读取本轮依据'}</button><button type="button" class="text-btn" data-next-leave>返回查看上一轮</button></div>`;
          summary.querySelector<HTMLSelectElement>('[data-next-basis-choice]')!.addEventListener('change',event=>{
            if(this.pendingExecution||this.inputReadUncertain||this.busy||this.starting)return;
            this.nextChoice=(event.target as HTMLSelectElement).value==='result'?'result':'current';
            this.nextBasis=undefined;this.nextBasisError='';this.writePreparationRoute(true);this.invalidate();void this.loadContinuationBasis(false);
          });
          summary.querySelector('[data-next-edit-details]')!.addEventListener('click',()=>{document.querySelector<HTMLButtonElement>('#edit-project-details')?.click();document.querySelector<HTMLElement>('#reporting-year')?.focus();});
          summary.querySelector('[data-next-refresh-basis]')!.addEventListener('click',()=>{
            if(this.pendingExecution||this.inputReadUncertain||this.busy||this.starting)return;
            if(this.nextNeedsProjectRefresh&&this.onStaleInput)this.onStaleInput();else void this.loadContinuationBasis(true);
          });
          summary.querySelector('[data-next-leave]')!.addEventListener('click',()=>this.returnToPreviousResult());
        }
      }
    }
    const materialDetails = document.querySelector<HTMLElement>('#project-materials-details');
    if (materialDetails) {
      materialDetails.hidden=!!this.run&&!this.nextRequested&&!this.viewingProjectMaterials;
      materialDetails.classList.toggle('materials-readonly', materialsLocked);
      materialDetails.querySelector<HTMLFieldSetElement>('#material-editing')!.disabled = !this.materialsEditable;
      materialDetails.querySelector('#materials-state-label')!.textContent = materialsLocked ? '材料已锁定，仅可查看' : this.nextRequested ? '为下一轮补充材料' : '开始更新前可补充';
      materialDetails.querySelector('#materials-title')!.textContent = materialsLocked ? '查看项目材料' : '提供项目材料';
      materialDetails.querySelector('#materials-state-description')!.textContent = materialsLocked
        ? activeRun ? '本次编制已开始，材料已锁定，无法新增、替换或删除。' : '本次编制材料已锁定。需要补充材料时，请点击“继续修改”，用于下一轮编制。'
        : this.nextRequested ? '补充材料将用于下一轮编制，已开始的任务和已有成果保持不变。' : '请在开始更新前补齐材料；开始后材料锁定，仅可查看。';
    }
    const sourcePanel=document.querySelector<HTMLElement>('#prospectus-panel');
    if(sourcePanel)sourcePanel.hidden=!!this.run&&!this.nextRequested&&!this.viewingProjectMaterials;
    this.conversation.setEditingVisible(!editsFrozen && !this.restoring && !activeRun && (!this.run || this.nextRequested));
    this.actions.closest('.authoring-actions')?.classList.toggle('is-preparing', !this.restoring && !activeRun && (!this.run || this.nextRequested));
    const block = this.startBlock(), blocked = block.reason;
    this.button('complete-source-information').hidden = !block.sourceGap || !this.materialsEditable;
    this.button('execute-input').disabled = Boolean(blocked) || scopePending(this.quote?.quote) || Boolean(this.quote && (!isAutomaticCharge(this.quote.quote)&&(isCnyPrice(this.quote.quote)?int64(this.quote.shortage)>0n:int64(this.quote.balance.available)===0n)));
    this.button('execute-input').textContent = this.busy || this.starting ? (this.restoring ? '开始更新' : '正在提交…')
      : this.materialsEditable && this.materialBlock() ? '请先处理材料状态'
      : this.awaitingCredits ? '继续更新'
      : this.nextRequested ? '生成新版' : '开始更新';
    let quoteHost=this.actions.querySelector<HTMLElement>('#fixed-quote');
    if(!quoteHost){quoteHost=document.createElement('div');quoteHost.id='fixed-quote';quoteHost.setAttribute('aria-live','polite');this.actions.prepend(quoteHost);}
    const q=this.quote;
    const insufficient=!!q&&(isCnyPrice(q.quote)?int64(q.shortage)>0n:int64(q.balance.available)===0n);
    quoteHost.hidden=(!insufficient&&!scopePending(q?.quote))||Boolean(activeRun)||Boolean(this.run&&!this.nextRequested);
    quoteHost.innerHTML=scopePending(q?.quote)?`<div class="fixed-quote"><h3>${esc(scopeStatusLabel(q?.quote))}</h3>${scopeLifecycleHtml(q?.quote)}<button type="button" class="text-button" id="refresh-quote">刷新范围报价</button></div>`:insufficient?`<div class="fixed-quote"><h3>${isCnyPrice(q?.quote)?'服务余额不足':'积分不足'}</h3><p>${isCnyPrice(q?.quote)?'本次总价 '+displayPrice(q?.quote)+'。':''}项目材料与补充要求已保留，当前没有启动更新任务。请到账号页查看余额与支付渠道状态；余额充足后返回项目点击继续更新。</p><a class="btn primary" href="${esc(this.rechargeLink())}">查看余额与支付状态</a><button type="button" class="text-button" id="refresh-quote">刷新余额</button></div>`:'';
    quoteHost.querySelector<HTMLButtonElement>('#refresh-quote')?.addEventListener('click',()=>{void this.action(()=>this.loadQuote(),'other','read');});
    let billingHint = this.actions.querySelector<HTMLElement>('#execution-credit-hint');
    if (!billingHint) { billingHint = document.createElement('p'); billingHint.id = 'execution-credit-hint'; billingHint.className = 'muted'; this.actions.querySelector('.start-buttons')!.before(billingHint); }
    billingHint.hidden = Boolean(activeRun || this.run && !this.nextRequested || q && int64(q.balance.available)===0n);
    billingHint.textContent = this.automaticBilling?'发起任务后自动锁价并预留积分，成功交付后扣费；平台重试不重复收费。':this.commerceEnabled?'按成果付费；开始前显示本次范围与人民币总价，确认后预留，交付结算。':this.paidEnabled === false ? '当前为试用编制，本次不扣积分。'
      : '有积分即可开始，处理时按进度扣减；积分用完暂停，充值到账后继续。';
    this.node('#start-disabled-reason').textContent = blocked;
    this.node('#execution-message').textContent = this.message;
    this.button('refresh-execution').disabled = this.busy || this.starting;
    this.button('refresh-execution').hidden = !this.pendingExecution && !this.inputReadUncertain && !this.run && !this.progressMessage;
    this.button('retry-execution').hidden = !this.pendingExecution;
    this.button('retry-execution').disabled = this.busy || this.starting || this.restoring || this.pendingExecutionConflict;
    const firstDraft=this.firstDraftReview;
    this.node('#execution-first-draft').hidden=!firstDraft||Boolean(activeRun);
    this.node('#first-draft-exclusions').innerHTML=firstDraft?firstDraft.exclusions.excluded_historical.map(pin=>`<li><strong>${esc(pin.filename)}</strong> · 版本 ${pin.material_version}<details><summary>核对文件版本</summary><code>${esc(pin.sha256)}</code></details></li>`).join(''):'';
    this.button('confirm-first-draft').disabled=this.busy||this.starting||this.restoring||Boolean(this.materialBlock());
    const check = this.preflight;
    this.node('#execution-preflight').hidden = !check || check.status !== 'blocked' || Boolean(activeRun);
    this.node('#execution-preflight').textContent = check?.status === 'blocked' && !activeRun ? blockedMessage(check) : '';
    this.button('recheck-input').hidden = !(check?.status === 'blocked' || this.inputRejected && this.selected && this.input) || Boolean(activeRun);
    this.button('recheck-input').disabled = this.busy || this.starting || !this.selected || this.inputReadUncertain;
    const run = this.run;
    const previous = this.host.querySelector<HTMLDetailsElement>('#previous-execution')!;
    // A fresh restore must first verify the run; re-reading the same prepared run
    // must retain its existing native open state while the response is pending.
    const archived = Boolean(run && this.nextRequested && (!this.restoring || this.previousResultMode === run.run_id) && ['succeeded','test_completed','failed','cancelled','rejected'].includes(run.state));
    const previousMode = archived ? run!.run_id : undefined;
    if (!archived || previousMode !== this.previousResultMode) previous.open = !archived;
    this.previousResultMode = previousMode;
    previous.classList.toggle('is-archived', archived);
    previous.querySelector<HTMLElement>('#previous-execution-summary')!.hidden = !archived;
    previous.querySelector('[data-previous-execution-state]')!.textContent = run ? ` · ${states[run.state]}` : '';
    const readMessage = this.host.querySelector<HTMLElement>('#execution-read-message')!;
    readMessage.textContent = this.progressMessage; readMessage.hidden = !this.progressMessage;
    this.node('#run-panel').hidden = !run;
    const progressHost = document.querySelector('#workspace-progress');
    if (run && progressHost && this.host.parentElement !== progressHost) progressHost.append(this.host);
    if (run && this.materialRun !== run.run_id) { const details = document.querySelector<HTMLDetailsElement>('#project-materials-details'); if (details) { details.classList.add('has-run'); details.open = this.nextRequested; } this.materialRun = run.run_id; }
    const testRun = run?.channel === 'non_production_test';
    const testCompleted = run?.state === 'test_completed' && testRun;
    const automaticPause = automaticPauseMessage(run);
    const repeatedPause = run?.state === 'paused' && this.samePauseAfterResume(run);
    const needsAttention = run && ['paused', 'awaiting_input', 'failed', 'rejected', 'cancelled'].includes(run.state);
    const lastProcessingStage = run ? [...this.events].reverse().find(event => event.run_id === run.run_id
      && event.type === 'run.progress' && event.seq <= (run.event_cursor ?? Infinity) && event.stage)?.stage ?? undefined : undefined;
    const failedWordProgress = run?.state !== 'failed' ? undefined : lastProcessingStage === 'word_delivery' ? {phase: 3 as const}
      : lastProcessingStage === 'input_lock' || lastProcessingStage === 'materials_ready' ? {phase: 1 as const} : undefined;
    // The current run stage is authoritative even when event history is late or unavailable.
    const summary = run?.stage === 'user_paused' ? undefined : automaticPause
      ? (this.reason !== 'trial_limit_cleared' && runtimeMessage(this.reason)) || automaticPause
      : repeatedPause ? '任务再次停在相同条件，重复继续不会推进。请联系支持核对恢复条件。'
      : needsAttention && this.reason ? readinessMessage(this.reason, lastProcessingStage)
        : !needsAttention && this.reason === 'trial_limit_cleared' ? runtimeMessage(this.reason)
        : run?.state === 'paused' ? run.stage === 'awaiting_materials'
          ? '等待材料处理完成，条件满足后后台会继续。'
          : run.stage === 'provider_reconcile' ? '正在核对编制服务响应；已保存材料会保留，无需重新上传。'
          : run.stage === 'billing_reconcile' ? '正在核对积分账务，已保存进度和已有成果；核对完成后继续，已请求停止的任务会优先结束。'
          : '处理条件尚未就绪，请联系支持核对。' : undefined;
    const needsRecharge = !!this.charge?.progress?.credit_exhausted && !!activeRun;
    if (!needsRecharge) { this.creditPromptShown = false; this.creditDialog?.close(); }
    if (needsRecharge && !this.creditPromptShown) {
      this.creditPromptShown = true;
      this.creditDialog?.remove();
      const dialog = document.createElement('dialog');
      dialog.className = 'credit-recharge-dialog';
      dialog.setAttribute('aria-labelledby', 'credit-recharge-title');
      dialog.innerHTML = `<h2 id="credit-recharge-title">积分已用完</h2><p>已完成的工作会保留，积分已停止扣减。当前处理保存后暂停。请到账号页查看积分与支付渠道状态；积分充足后自动继续本次任务。</p><div class="form-actions"><a class="button primary" href="${esc(this.rechargeLink())}">查看积分与支付状态</a><button type="button" class="button secondary">稍后处理</button></div>`;
      dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
      document.body.append(dialog); this.creditDialog = dialog; dialog.showModal();
    }
    const executionProgressHost = this.host.querySelector<HTMLElement>('#execution-progress')!;
    const creditDetailsOpen = executionProgressHost.querySelector<HTMLDetailsElement>('.authoring-credit-meter details')?.open ?? false;
    const recordsOpen=executionProgressHost.querySelector<HTMLDetailsElement>('#authoring-records')?.open??true;
    const materialsOpen=executionProgressHost.querySelector<HTMLDetailsElement>('#authoring-locked-materials')?.open??false;
    const focusedDisclosure=['authoring-records','authoring-locked-materials'].find(id=>document.activeElement===executionProgressHost.querySelector('#'+id+' > summary'));
    const focusedId = executionProgressHost.contains(document.activeElement) ? document.activeElement?.id : undefined;
    const creditSummaryFocused = document.activeElement === executionProgressHost.querySelector('.authoring-credit-meter summary');
    const primaryAction=!run?'':run.state==='paused'&&run.stage==='provider_reconcile'?(this.retryOffer?.mode==='resume'&&!this.pendingRunRetry
      ?'<button class="authoring-status-button primary" type="button" id="resume-run">继续本次任务</button>'
      :`<button class="authoring-status-button primary" type="button" id="retry-run" ${this.busy||this.retryOffer?.mode==='blocked'&&!this.pendingRunRetry?'disabled':''}>${this.pendingRunRetry?'核对重试结果':this.busy?'正在处理…':'立即重试'}</button>${this.retryOffer?.mode==='blocked'?'<button class="authoring-status-button secondary" type="button" id="refresh-run-retry">刷新状态</button>':''}`)
      :run.state==='running'&&this.charge?.progress?.pause_requested||run.stage==='user_paused'||run.stage==='credits_exhausted'?'<button class="authoring-status-button primary" type="button" id="resume-run">继续本次任务</button>'
      :['queued','running'].includes(run.state)?'<button class="authoring-status-button primary" type="button" id="pause-run">暂停任务</button>'
      :run.state==='paused'&&run.stage==='capability_not_ready'&&!repeatedPause?this.resumeVerified?'<button class="authoring-status-button primary" type="button" id="resume-run">继续更新</button>':'<button class="authoring-status-button primary" type="button" id="recheck-paused">重新检查处理条件</button>':'';
    const runActions=primaryAction+(activeRun?'<button class="authoring-status-button secondary" type="button" id="cancel-run" aria-label="停止本次任务">停止任务</button>':'');
    this.node('#run-panel').classList.add('authoring-status-panel');
    executionProgressHost.innerHTML = `${run ? `<div class="run-status-card authoring-status-shell"><h2 class="authoring-status-heading">募集书全文更新</h2>${authoringStatusCard(run,this.events,{progress:this.charge?.progress,summary,phase:failedWordProgress?.phase,actions:runActions,feedback:this.retryFeedback||this.message,retry:this.retryOffer})}${testCompleted ? '<p>仅供内部测试，仍有规则和内容待核，不可用于正式申报。</p>' : testRun && run.state === 'failed' ? '<p>这是内部测试任务；请先联系支持核对失败原因。正式更新需保存新输入版本后重新开始，不会自动重试此任务。</p>' : testRun ? '<p>这是内部测试任务，不代表正式更新。</p>' : ''}
      ${authoringStatusReceipt(run,this.charge?.progress,this.charge?.quote&&this.charge.state?{...this.charge.quote,state:this.charge.state}:undefined,this.chargeError)}
      ${needsRecharge ? `<p class="authoring-status-retry-note"><a class="text-button" href="${esc(this.rechargeLink())}">查看积分与支付状态</a>，积分充足后继续本次任务。</p>` : ''}
      ${authoringStatusRecords(run,this.events)}
      <details class="authoring-status-materials" id="authoring-locked-materials"><summary>本次使用的材料（${this.runMaterialPins?this.runMaterialPins.length+' 份':'正在读取'}，已锁定）</summary>${this.runMaterialsError?`<p role="status">${esc(this.runMaterialsError)} <button class="text-button" type="button" id="reload-run-materials">重新读取</button></p>`:''}${this.runMaterialPins?`<ul class="authoring-status-material-list">${this.runMaterialPins.map(pin=>{const material=this.runMaterials.find(m=>m.material_id===pin.material_id&&m.material_version===pin.material_version);return `<li><span>${esc(material?.filename??'材料名称暂未读取')}<small> · 版本 ${pin.material_version}</small></span></li>`;}).join('')}</ul>`:'<p>正在读取本次任务锁定的材料版本…</p>'}<p class="authoring-status-material-note">本次材料已锁定。<button class="text-button" type="button" id="show-project-materials">查看项目材料</button></p></details>
      ${!activeRun&&!this.nextRequested?'<div class="authoring-status-followup"><button class="button secondary" type="button" id="prepare-next-version">继续修改</button><span>为下一轮补充材料或修改要求，旧成果仍会保留。</span></div>':''}</div>` : ''}
      ${this.latestArtifact && this.latestArtifact !== run?.artifact_id ? `<a class="text-button" href="#/artifacts/${encodeURIComponent(this.latestArtifact)}?${esc(withProjectContext(new URLSearchParams()).toString())}">查看此前成功成果</a>` : ''}`;
    const creditDetails = executionProgressHost.querySelector<HTMLDetailsElement>('.authoring-credit-meter details');
    if (creditDetails) creditDetails.open = creditDetailsOpen;
    const records=executionProgressHost.querySelector<HTMLDetailsElement>('#authoring-records');if(records)records.open=recordsOpen;
    const lockedMaterials=executionProgressHost.querySelector<HTMLDetailsElement>('#authoring-locked-materials');if(lockedMaterials)lockedMaterials.open=materialsOpen;
    if (creditSummaryFocused) executionProgressHost.querySelector<HTMLElement>('.authoring-credit-meter summary')?.focus({preventScroll:true});
    else if(focusedDisclosure)executionProgressHost.querySelector<HTMLElement>('#'+focusedDisclosure+' > summary')?.focus({preventScroll:true});
    else if (focusedId) executionProgressHost.querySelector<HTMLElement>('#'+CSS.escape(focusedId))?.focus({preventScroll:true});
    for (const [id, action] of [['cancel-run','cancel'],['resume-run','resume'],['pause-run','pause']] as const) {
      const button = this.host.querySelector<HTMLButtonElement>(`#${id}`);
      if (button) { button.disabled = this.busy; button.addEventListener('click', () => { void this.changeRun(action); }); }
    }
    this.host.querySelector('#retry-run')?.addEventListener('click',()=>{void this.requestRunRetry();});
    this.host.querySelector('#refresh-run-retry')?.addEventListener('click',()=>{this.retryReadKey=undefined;void this.loadRetryOptions();void this.poll();});
    this.host.querySelector('#reload-run-materials')?.addEventListener('click',()=>{this.runMaterialsKey=undefined;if(this.run)void this.loadRunMaterials(this.run);});
    const recheckPaused = this.host.querySelector<HTMLButtonElement>('#recheck-paused');
    if (recheckPaused) { recheckPaused.disabled = this.busy; recheckPaused.addEventListener('click', () => { void this.recheckPaused(); }); }
    const prepare=this.host.querySelector<HTMLButtonElement>('#prepare-next-version');
    if(prepare){prepare.disabled=editsFrozen||this.busy||this.starting;prepare.addEventListener('click',()=>{void this.prepareNextVersion();});}
    this.host.querySelector('#show-project-materials')?.addEventListener('click', () => { this.viewingProjectMaterials=true;this.render();const details=document.querySelector<HTMLDetailsElement>('#project-materials-details'); if(details)details.open=true; document.querySelector('#materials-title')?.scrollIntoView({block:'start'}); });
    const artifactId = (run?.state === 'succeeded' || testCompleted) ? run?.artifact_id : undefined;
    if (artifactId && artifactId !== this.deliveryId) {
      this.delivery?.dispose(); this.deliveryId = artifactId;
      const host = this.host.querySelector<HTMLElement>('#execution-delivery')!;
      let located = false, returning = false, queued = false;
      const locate = (explicitReturn = false) => {
        if (explicitReturn) returning = true;
        if (queued || located && !returning) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          if (!this.active || this.deliveryId !== artifactId || this.nextRequested) return;
          const target = host.querySelector<HTMLElement>('#artifact-downloads') ?? (returning ? host.querySelector<HTMLElement>('[role="alert"]') : null);
          if (!target?.isConnected) return;
          located = true; returning = false;
          target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start', behavior: 'instant' });
        });
      };
      this.locateResult = locate;
      this.delivery = new ArtifactPage(this.api, html => { host.innerHTML = html; locate(); }, () => this.active && this.deliveryId === artifactId);
      void this.delivery.render(artifactId);
    } else if (!artifactId && this.deliveryId) { this.delivery?.dispose(); this.deliveryId = undefined; this.locateResult = undefined; this.host.querySelector('#execution-delivery')!.innerHTML = ''; }
  }
  private returnToPreviousResult() {
    if (this.pendingExecution || this.inputReadUncertain || this.busy || this.starting) return;
    const runId = this.run?.run_id;
    this.writePreparationRoute(false); this.nextRequested = false; this.nextBasisRead++; this.nextBasisLoading = false; this.nextBasis = undefined; this.nextBasisError = ''; this.invalidate();
    if (this.locateResult) { this.locateResult(true); return; }
    requestAnimationFrame(() => {
      if (!this.active || this.nextRequested || this.run?.run_id !== runId) return;
      const target = this.host.querySelector<HTMLElement>('#run-panel');
      if (!target?.isConnected || target.hidden) return;
      target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }
  /** The URL stores only UI intent, never a cached execution envelope or source pin. */
  private writePreparationRoute(preparing:boolean, runId=this.run?.run_id) {
    if(!this.active)return;
    const [path,search='']=location.hash.split('?'),query=new URLSearchParams(search);
    if(preparing&&runId){query.set('prepare','next');query.set('basis',this.nextChoice);query.set('prepare_after',String(this.preparationAfter));query.set('run',runId);}
    else if(query.get('prepare')==='next'){query.delete('prepare');query.delete('basis');query.delete('prepare_after');if(runId)query.set('run',runId);}
    history.replaceState(null,'',location.pathname+location.search+path+(query.size?'?'+query:''));
  }
  private async prepareNextVersion() {
    if(this.nextRequested||!this.run||this.pendingExecution||this.inputReadUncertain||this.busy||this.starting||this.otherActiveRun||!['succeeded','test_completed','failed','cancelled','rejected'].includes(this.run.state))return;
    this.nextRequested=true;
    this.nextBasisRead++;this.nextBasisLoading=false;
    this.preparationAfter=Math.max(this.knownLatestInput,this.input?.input_revision??0,this.draft.project.input_revision??0,this.run.input_revision);
    this.nextChoice=this.run.state==='succeeded'&&this.run.channel==='production'?'result':'current';
    this.nextBasis=undefined;this.nextBasisError='';this.nextNeedsProjectRefresh=false;
    this.writePreparationRoute(true);this.invalidate();
    const details=document.querySelector<HTMLDetailsElement>('#project-materials-details');if(details)details.open=true;
    const guide = document.querySelector<HTMLElement>('[data-authoring-preparation-guide]');
    if (guide) { guide.tabIndex = -1; guide.focus({ preventScroll: true }); guide.scrollIntoView({ block: 'start' }); }
    await this.loadContinuationBasis(true);
  }
  private async loadContinuationBasis(explicit:boolean) {
    if(!this.active||this.pendingExecution||this.inputReadUncertain||!this.nextRequested||!this.run||this.nextBasisLoading)return;
    const runId=this.run.run_id,choice=this.nextChoice,read=++this.nextBasisRead;
    this.nextBasisLoading=true;this.nextBasis=undefined;this.nextBasisError='';this.nextNeedsProjectRefresh=false;this.render();
    try {
      if(explicit&&!await this.draft.save())throw new UserFacingError('项目信息尚未保存，请先处理保存提示。');
      if(this.refreshPreparation&&!await this.refreshPreparation()){
        this.nextNeedsProjectRefresh=true;throw new UserFacingError('项目资料已变化，请重新载入；本页未保存内容会保留供你处理。');
      }
      const versions=await this.api.prospectusVersions(this.id,this.controller.signal);
      if(!this.active||!this.nextRequested||this.run?.run_id!==runId||this.nextChoice!==choice||read!==this.nextBasisRead)return;
      const basis=await readContinuationBasis(versions,this.id,this.run,choice,id=>this.api.artifact(id,this.controller.signal));
      if(!this.active||!this.nextRequested||this.run?.run_id!==runId||this.nextChoice!==choice||read!==this.nextBasisRead)return;
      this.nextBasis=basis;
    }catch(error){if(this.active&&this.nextRequested&&read===this.nextBasisRead)this.nextBasisError=friendlyError(error,'read');}
    finally{if(read===this.nextBasisRead){this.nextBasisLoading=false;if(this.active)this.render();}}
  }
  private async start() {
    if (!this.active) return;
    if (this.startBlock().reason) { this.render(); return; }
    this.starting = true; this.render();
    try {
      if (!this.selected && this.recoveredInputMessages) {
        const messages = this.recoveredInputMessages, generation = this.generation;
        await this.action(async () => {
          const current = await this.conversation.currentRef();
          if (!this.active || generation !== this.generation) return;
          if (current.version !== messages.version || current.content_sha256 !== messages.content_sha256 ||
              JSON.stringify(current.message_ids) !== JSON.stringify(messages.message_ids)) {
            this.invalidate(); this.message = '补充要求已变化，请按当前内容重新开始。'; return;
          }
          this.selectedMessages = current; this.selected = true; this.recoveredInputMessages = undefined;
        }, 'other', 'read');
        if (!this.selected) return;
      }
      if (!this.selected) await this.save();
      if (!this.active || !this.selected || !this.input) return;
      if (!this.preflight) await this.check();
      if (!this.active || !this.selected || !this.preflight) return;
      // Backend admission is authoritative; uncertainty alone does not add an upload review step.
      if (this.preflight.status === 'blocked') return;
      if(this.preflight.billing_mode==='fixed_credits'||this.commerceEnabled){
        if(!this.quote || scopePending(this.quote.quote) || int64(this.quote.balance.available)===0n)await this.action(()=>this.loadQuote(),'other','read');
        if(!this.quote?.enabled || !this.quote.quote || scopePending(this.quote.quote) || (!isAutomaticCharge(this.quote.quote)&&(isCnyPrice(this.quote.quote)?int64(this.quote.shortage)>0n:int64(this.quote.balance.available)===0n)))return;
        if(isCnyPrice(this.quote.quote)){
          const input=this.input,quote=this.quote;
          if(!await confirmCnyTask('确认募集书任务费用',quote.quote!,`按已保存材料与要求执行，输入版本 ${input.input_revision}。本次仅处理所确认的目标和范围，生成工作稿。`))return;
          if(!this.active||this.input?.input_hash!==input.input_hash||this.quote!==quote){this.message='材料或报价已变化，请重新核对。';return;}
        }
      }
      await this.execute();
    } finally { this.starting = false; this.render(); }
  }
  private async loadQuote() {
    if(!this.input||!this.selected)return;
    const generation=this.generation,input=this.input;
    const quote=await this.api.creditQuote(this.id,{input_revision:input.input_revision,input_hash:input.input_hash},this.controller.signal);
    if(!quote.enabled||!quote.quote)throw new ApiError(409,'QUOTE_REQUIRED');
    if(this.active&&generation===this.generation){this.quote=quote;if(int64(quote.balance.available)===0n)this.awaitingCredits=true;this.render();}
  }
  private async changeRun(action: 'cancel' | 'resume' | 'pause') {
    const legacyUserPause=this.run?.state==='paused'&&this.run.stage==='provider_reconcile'&&this.retryOffer?.mode==='resume'&&this.retryOffer.reason_code==='user_paused'&&!this.pendingRunRetry;
    if (!this.run || action === 'resume' && !legacyUserPause && !(this.run.state === 'running' && this.charge?.progress?.pause_requested) && this.run.stage !== 'user_paused' && this.run.stage !== 'credits_exhausted' && (!this.resumeVerified || this.run.stage !== 'capability_not_ready')) return;
    const runId = this.run.run_id;
    const pause = { runId, stage: this.run.stage, reason: this.reason };
    if (action === 'resume') this.resumeVerified = false;
    await this.action(async () => {
      const run = await this.api.runAction(runId, action, this.controller.signal);
      if (!this.active) return;
      if (run.run_id !== runId || run.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      if (action === 'resume') this.resumedPause = pause;
      this.acceptRun(run);
      if(action==='resume'&&legacyUserPause){
        // This only clears the owner's pause. A material restart still needs a
        // fresh server offer and its separate explicit confirmation.
        this.retryOffer=undefined;this.retryReadKey=undefined;this.retryFeedback='';
        await this.loadRetryOptions();
      }
      void this.poll();
    });
  }

  private async loadRunMaterials(run:Dto<'RunResponse'>) {
    const key=`${run.run_id}:${run.input_hash}`;
    if(this.runMaterialsKey===key)return;
    this.runMaterialsKey=key;this.runMaterialPins=undefined;this.runMaterials=[];this.runMaterialsError='';
    try{
      const input=this.input?.input_hash===run.input_hash&&this.input.input_revision===run.input_revision?this.input:
        await this.api.inputRevision(this.id,run.input_revision,this.controller.signal);
      if(!this.active||this.runMaterialsKey!==key)return;
      if(input.project_id!==this.id||input.input_hash!==run.input_hash||input.input_revision!==run.input_revision)throw new ApiError(0,'DATA_UNAVAILABLE');
      this.runMaterialPins=input.material_versions;
      const values:Material[]=[];let missing=false;
      for(let offset=0;offset<input.material_versions.length;offset+=6){
        const batch=await Promise.allSettled(input.material_versions.slice(offset,offset+6).map(async pin=>{
          const value=await this.api.material(this.id,pin.material_id,this.controller.signal,pin.material_version);
          if(value.material_id!==pin.material_id||value.material_version!==pin.material_version)throw new ApiError(0,'DATA_UNAVAILABLE');
          return value;
        }));
        if(!this.active||this.runMaterialsKey!==key)return;
        for(const result of batch)if(result.status==='fulfilled')values.push(result.value);else missing=true;
      }
      this.runMaterials=values;this.runMaterialsError=missing?'部分材料名称暂未读取，锁定的版本没有变化。':'';
    }catch{if(this.active&&this.runMaterialsKey===key)this.runMaterialsError='本次材料清单暂未读取，请重新读取。';}
    finally{if(this.active&&this.runMaterialsKey===key)this.render();}
  }

  private async loadRetryOptions() {
    const run=this.run;
    if(!run||run.state!=='paused'||run.stage!=='provider_reconcile'){
      this.retryOffer=undefined;this.retryReadKey=undefined;return;
    }
    const key=`${run.run_id}:${run.event_cursor}`;
    if(this.retryReadKey===key)return;
    this.retryReadKey=key;
    try{
      const offer=await this.api.runRetryOptions(run.run_id,this.controller.signal);
      if(!this.active||this.retryReadKey!==key||this.run?.state!=='paused'||this.run.stage!=='provider_reconcile')return;
      if(offer.run_id!==run.run_id)throw new ApiError(0,'DATA_UNAVAILABLE');
      this.retryOffer=offer;
      if(this.retryFeedback==='重试条件暂未同步，可点击“立即重试”重新核对。')this.retryFeedback='';
    }catch{
      if(this.active&&this.retryReadKey===key){this.retryOffer=undefined;this.retryFeedback='重试条件暂未同步，可点击“立即重试”重新核对。';}
    }finally{if(this.active&&this.retryReadKey===key)this.render();}
  }

  private async requestRunRetry() {
    const run=this.run;if(!run||run.state!=='paused'||run.stage!=='provider_reconcile'||this.busy)return;
    await this.action(async()=>{
      this.retryFeedback='';
      if(this.pendingRunRetry?.runId===run.run_id){await this.submitRunRetry();return;}
      try{
        const offer=await this.api.runRetryOptions(run.run_id,this.controller.signal);
        if(!this.active||this.run?.run_id!==run.run_id||this.run.state!=='paused'||this.run.stage!=='provider_reconcile')return;
        if(offer.run_id!==run.run_id)throw new ApiError(0,'DATA_UNAVAILABLE');
        this.retryOffer=offer;
        if(offer.mode==='restore_checkpoint'&&offer.attempt_id){
          this.pendingRunRetry={runId:run.run_id,request:{request_id:crypto.randomUUID(),attempt_id:offer.attempt_id,mode:'restore_checkpoint'}};
          await this.submitRunRetry();
        }else if(offer.mode==='restart_materials'&&offer.attempt_id){
          this.showRestartConfirmation(run.run_id,offer.attempt_id);
        }else{this.retryFeedback=retryExplanation(offer);void this.poll();}
      }catch(error){this.retryFeedback=`暂未取得重试条件，请稍后再试。${friendlyError(error,'read')}`;}
    });
  }

  private showRestartConfirmation(runId:string,attemptId:string) {
    this.retryDialog?.remove();
    const dialog=document.createElement('dialog');dialog.className='authoring-retry-dialog';
    dialog.setAttribute('aria-labelledby','authoring-retry-title');
    dialog.innerHTML='<h2 id="authoring-retry-title">使用原材料重新处理？</h2><p>上次模型处理已结束，但没有可续跑的工作快照。未保存的中间进度无法恢复，本次会从锁定的原材料重新处理。</p><p>仍使用本次任务和原积分预留，不新增任务预留；已记录的历史用量及账务保留。</p><div class="form-actions"><button class="button secondary" type="button" data-dismiss>暂不重试</button><button class="button primary" type="button" id="confirm-run-restart">确认重新处理</button></div>';
    dialog.querySelector('[data-dismiss]')!.addEventListener('click',()=>dialog.close());
    dialog.querySelector('#confirm-run-restart')!.addEventListener('click',()=>{
      if(this.busy||!this.active)return;
      if(this.run?.run_id!==runId||this.run.state!=='paused'||this.run.stage!=='provider_reconcile'){dialog.close();return;}
      this.pendingRunRetry={runId,request:{request_id:crypto.randomUUID(),attempt_id:attemptId,mode:'restart_materials',confirmed_restart:true}};
      dialog.close();void this.action(()=>this.submitRunRetry());
    });
    document.body.append(dialog);this.retryDialog=dialog;dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-dismiss]')!.focus();
  }

  private async submitRunRetry() {
    const pending=this.pendingRunRetry;if(!pending)return;
    const readVersion=this.runReadVersion;
    try{
      const run=await this.api.retryRun(pending.runId,pending.request,this.controller.signal);
      if(!this.active||this.run?.run_id!==pending.runId)return;
      if(run.run_id!==pending.runId||run.project_id!==this.id||run.input_hash!==this.run.input_hash)throw new ApiError(0,'DATA_UNAVAILABLE');
      this.pendingRunRetry=undefined;this.retryOffer=undefined;this.retryReadKey=undefined;
      // A newer poll may already have delivered this attempt while its POST receipt was in flight.
      const currentCursor=this.run.event_cursor??-1,responseCursor=run.event_cursor??-1;
      const stale=currentCursor>responseCursor||this.runReadVersion!==readVersion&&currentCursor>=responseCursor;
      const latest=stale?this.run:run;
      this.retryFeedback=latest.state==='paused'?'已核对原重试请求，任务当前处于暂停状态。请查看最新原因后重试。'
        :stale?'':latest.state==='queued'||latest.state==='running'?(pending.request.mode==='restore_checkpoint'?'已安排从保存进度继续，仍是本次任务。':'已安排使用本次原材料重新处理，仍是本次任务。'):'重试请求已核对，任务已更新为最新状态。';
      if(stale){void this.loadRetryOptions();void this.poll();return;}
      this.acceptRun(run);void this.poll();
    }catch(error){
      if(!this.active)return;
      if(this.run?.run_id!==pending.runId||this.pendingRunRetry!==pending)return;
      if(!(error instanceof ApiError)||error.status===0){
        this.retryFeedback='重试回执尚未确认，请核对重试结果；核对会沿用原请求，不重复创建任务。';
      }else{
        this.pendingRunRetry=undefined;this.retryReadKey=undefined;
        this.retryFeedback=error.code==='INPUT_REVISION_CONFLICT'||error.code==='IDEMPOTENCY_CONFLICT'?'任务状态或处理尝试已变化，正在刷新，请核对后重试。'
          :error.code==='BILLING_NOT_READY'?'积分账务正在核对，暂不能重试。'
          :error.code==='CREDITS_INSUFFICIENT'?'积分不足，请查看余额与支付状态后继续本次任务。'
          :error.code==='CAPABILITY_NOT_READY'?'当前重试条件尚未满足，正在刷新具体原因。':friendlyError(error,'action');
        void this.loadRetryOptions();
      }
      void this.poll();
    }
  }

  private async action(work: () => Promise<void>, operation: 'preflight' | 'execute' | 'other' = 'other', feedback: 'read'|'save'|'download'|'submit'|'action' = operation === 'other' ? 'action' : 'submit') {
    if (this.busy || !this.active) return;
    this.busy = true; this.message = ''; this.render();
    try { await work(); }
    catch (error) {
      if (this.active) {
        const staleInput = error instanceof ApiError && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT' &&
          !this.pendingExecution && !this.inputWriteUncertain;
        if (staleInput) this.invalidate();
        if((!this.run||this.nextRequested) && error instanceof ApiError&&['QUOTE_CHANGED','QUOTE_REQUIRED','CREDITS_INSUFFICIENT'].includes(error.code)) {
          this.quote=undefined;this.awaitingCredits=true;
          if(error.code==='QUOTE_REQUIRED')this.preflight=undefined;
          else {try{await this.loadQuote();}catch{/* Explicit retry keeps the task unstarted. */}}
        }
        const inputMessage = operation !== 'other'
          ? executionInputError(error, this.draft.project.kind, this.draft.fields.update_details.has_historical, this.materials, this.draft.fields.update_details.authoring_mode === 'unified_v1') : undefined;
        this.inputRejected = operation !== 'other' && error instanceof ApiError && error.status === 409 &&
          (error.code === 'INPUT_REQUIRED' || operation === 'preflight' && error.code === 'CAPABILITY_NOT_READY');
        this.message = inputMessage ?? (staleInput && !error.details.prospectusSelectionRequired ? '输入依据已变化，请按当前材料与要求重新开始。' : error instanceof ApiError && error.code==='CREDITS_INSUFFICIENT' ? '积分不足，项目材料与要求已保留。请到账号页查看积分与支付渠道状态；积分充足后返回原任务入口继续。' : error instanceof ApiError && error.code==='QUOTE_CHANGED' ? '计费条件已更新，请点击继续更新。' : error instanceof ApiError && error.code==='QUOTE_REQUIRED' ? '积分核验暂不可用，请稍后重新开始。' : undefined) ??
          (error instanceof ApiError && error.code === 'CAPABILITY_NOT_READY'
            ? operation === 'preflight' && error.status === 409
              ? `材料或处理条件尚未就绪，请稍后重新检查；持续未恢复时联系支持。${errorReference(error)}`
              : `当前环境尚未开放全文更新，请联系支持。${errorReference(error)}` : friendlyError(error,feedback));
        if(this.pendingExecution)this.message=this.pendingExecutionConflict?`上次提交的记录存在冲突，请重新读取并联系支持核对。${error instanceof ApiError?errorReference(error):''}`:`${friendlyError(error,'submit')} 提交结果尚未确认，请重新读取或点击“核对上次提交”；核对会沿用原请求。`;
      }
    }
    finally { this.busy = false; this.render(); }
  }
  private async save() {
    await this.action(async () => {
      const expectedFirstDraft=this.firstDraftConfirmation;
      if (!await this.conversation.flush()) { this.message = '补充说明尚未保存，内容已保留，请稍后重试。'; return; }
      if (this.materialBlock() || this.inputReadUncertain || this.pendingExecution) return;
      const selected = this.eligibleMaterials();
      if (!selected.length) { this.message = '请先添加本次需要的项目材料。'; return; }
      const details = this.draft.fields.update_details;
      const periods = details.target_reporting_periods?.length ? details.target_reporting_periods
        : reportingWindow(this.draft.fields.market, this.draft.fields.offering, details.reporting_cutoff);
      // Derive missing legacy targets only on an explicit new execution, never on read or resume.
      if (details.authoring_mode !== 'unified_v1' || !details.target_reporting_periods?.length && periods.length) {
        this.draft.edit({ update_details: { ...details, authoring_mode: 'unified_v1', has_historical: null,
          ...(periods.length ? { target_reporting_periods: periods } : {}) } });
      }
      const confirmedGeneration = this.generation;
      if (!await this.draft.save() || !this.active) { this.message = '项目修改尚未保存，请先处理上方保存提示。'; return; }
      if (this.materialBlock()) return;
      if (confirmedGeneration !== this.generation) { this.message = '保存期间目标或材料有变化，请重新核对目标。'; return; }
      const p = this.draft.project;
      if (!p.market || !p.offering) { this.message = '请先在项目表单选择目标市场和发行方式。'; return; }
      const beforeMessages = this.generation;
      const messages = await this.conversation.currentRef();
      if (beforeMessages !== this.generation) { this.message = '补充要求列表已变化，请核对最新内容后再次开始。'; return; }
      const generation = this.generation;
      this.selected = false; this.preflight = undefined;
      const reference = await this.referenceFor(p, selected);
      if (reference.status === 'blocked') {
        // A selected reference that cannot be pinned is a hard stop: never lock or run a
        // reference-less input the user did not ask for.
        this.message = reference.message;
        return;
      }
      let result: Input;
      let submitted=false;
      const sent = { generation, draftRevision: p.draft_revision,
        afterRevision: Math.max(this.knownLatestInput, this.input?.input_revision ?? 0, p.input_revision ?? 0),
        materialVersions: selected.map(m => ({ material_id: m.material_id, material_version: m.material_version })), messages };
      try {
        const versions=await this.api.prospectusVersions(this.id,this.controller.signal);
        if(this.nextRequested){
          const basis=this.nextBasis;
          const fresh=this.run?await readContinuationBasis(versions,this.id,this.run,this.nextChoice,id=>this.api.artifact(id,this.controller.signal)):undefined;
          if(!basis||!fresh||basis.key!==fresh.key){
            this.nextBasisError='项目当前稿或所选底稿已变化，请重新载入项目资料并核对后再生成。';
            this.nextNeedsProjectRefresh=true;this.message=this.nextBasisError;return;
          }
        }
        if (!this.active || generation !== this.generation || this.materialBlock()) return;
        this.expireFirstDraft();
        if(expectedFirstDraft&&expectedFirstDraft!==this.firstDraftConfirmation){this.message='材料或目标已变化，请重新开始并核对首稿确认。';return;}
        const firstDraft=this.firstDraftConfirmation;
        if(firstDraft&&(!this.firstDraftAvailable(versions)||firstDraft.selectionRevision!==versions.selection_revision)){
          this.clearFirstDraft();this.message='项目底稿状态已变化，请重新开始并核对。';return;
        }
        submitted=true;
        result = await this.api.createInputRevision(this.id, { prospectus_selection_revision:versions.selection_revision,draft_revision: p.draft_revision,
          ...(this.nextRequested?{edit_base:this.nextBasis!.editBase}:{}),
          ...(firstDraft?{first_draft_confirmation:firstDraft.request}:{}),
          material_versions: selected.map(m => ({ material_id: m.material_id, material_version: m.material_version })),
          requirement_message_ids: messages.message_ids, project_message_set_ref: messages,
          ...(reference.status === 'pinned' ? { user_reference: reference.choice } : {}),
          ...(this.input?.credit_facility_supplements?.length ? { credit_facility_supplements: this.input.credit_facility_supplements } : {}),

        }, this.controller.signal);
      } catch (error) {
        if(!submitted){
          if(this.nextRequested){this.nextBasisError=friendlyError(error,'read');this.message=this.nextBasisError;return;}
          throw error;
        }
        if (error instanceof ApiError && error.status === 409 && ['FIRST_DRAFT_CONFIRMATION_REQUIRED','FIRST_DRAFT_EXCLUSION_STALE'].includes(error.code)) {
          this.invalidate();
          if(this.draft.project.kind==='generation')await this.offerFirstDraftReview();
          else this.message='项目中仍有历史募集书未包含在本次材料中，请刷新材料并纳入准确原稿后重新开始。';
          return;
        }
        if(error instanceof ApiError&&error.status===409&&error.code==='HISTORICAL_BASELINE_REQUIRED'){
          this.invalidate();this.message='项目中仍有历史募集书未包含在本次材料中，请刷新材料并纳入准确原稿后重新开始。';return;
        }
        if (error instanceof ApiError && error.status === 409) {
          this.invalidate();
          await this.conversation.refresh();
          this.message = error.details.prospectusSelectionRequired ? friendlyError(error)
            : this.nextRequested?'项目、材料或底稿版本已变化，请重新载入项目资料后再生成。':'消息或项目版本已变化；已重新读取消息，请核对后再次开始。';
          if(this.nextRequested){this.nextBasisError=this.message;this.nextNeedsProjectRefresh=true;}
          return;
        }
        // This POST has no idempotency key. Never blindly replay after a lost response.
        if (!(error instanceof ApiError) || error.status === 0 || error.status === 408 || error.status >= 500) {
          this.uncertainInputSave = sent;
          this.inputReadUncertain = true;
          this.inputWriteUncertain = true;
          this.message = '保存结果尚未确认，请重新读取并核对输入与任务记录；不会自动再次保存或启动。';
          return;
        }
        throw error;
      }
      if (!this.active) return;
      if (result.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.clearFirstDraft();
      this.input = result;
      this.selectedMessages = messages;
      this.selected = generation === this.generation;
      this.message = this.selected ? '' : '保存期间有新的修改，请重新开始。';
    },'other','save');
  }
  private async check() {
    if (!this.input || !this.selected) return;
    const input = this.input, generation = this.generation;
    await this.action(async () => {
      this.preflight = undefined;
      const result = await this.api.preflight(this.id, { input_revision: input.input_revision, input_hash: input.input_hash }, this.controller.signal);
      if (!this.active || generation !== this.generation) return;
      if (result.project_id !== this.id || result.input_revision !== input.input_revision || result.input_hash !== input.input_hash) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.preflight = result;
      this.inputRejected = false;
      this.message = '';
    }, 'preflight');
  }
  private async recheck() {
    if (!this.input || !this.selected || !(this.inputRejected || this.preflight?.status === 'blocked')) return;
    const selected = this.input;
    const wasRejected = this.inputRejected;
    let verified = false;
    let stale = false;
    await this.action(async () => {
      const project = await this.api.project(this.id, this.controller.signal);
      if (!this.active) return;
      if (project.project_id !== this.id || !project.input_revision || !project.input_hash) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const latest = await this.api.inputRevision(this.id, project.input_revision, this.controller.signal);
      if (!this.active) return;
      if (latest.project_id !== this.id || latest.input_revision !== project.input_revision ||
          latest.input_hash !== project.input_hash) throw new ApiError(0, 'DATA_UNAVAILABLE');
      verified = true;
      stale = latest.input_revision !== selected.input_revision || latest.input_hash !== selected.input_hash;
      if (stale) {
        this.input = undefined;
        this.recoveredInputMessages = undefined;
        this.invalidate();
        this.message = '项目已保存更新的输入版本，请核对最新材料与目标后重新开始。';
        this.onStaleInput?.();
      }
    },'other','read');
    if (!verified) {
      this.inputRejected = wasRejected;
      this.render();
      return;
    }
    if (stale || !this.active) return;
    await this.check();
    if (this.active && this.preflight?.status === 'blocked') this.message = blockedMessage(this.preflight);
  }
  private async recheckPaused() {
    const run = this.run;
    if (!run || run.state !== 'paused' || run.stage !== 'capability_not_ready' || this.samePauseAfterResume(run)) return;
    this.resumeVerified = false;
    await this.action(async () => {
      const input = await this.api.inputRevision(this.id, run.input_revision, this.controller.signal);
      if (!this.active || this.run?.run_id !== run.run_id || this.run.state !== 'paused' || this.run.stage !== run.stage) return;
      if (input.project_id !== this.id || input.input_hash !== run.input_hash) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const check = await this.api.preflight(this.id, { input_revision: run.input_revision, input_hash: run.input_hash }, this.controller.signal);
      if (!this.active || this.run?.run_id !== run.run_id || this.run.state !== 'paused' || this.run.stage !== run.stage) return;
      if (check.project_id !== this.id || check.input_revision !== run.input_revision || check.input_hash !== run.input_hash) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.resumeVerified = check.status !== 'blocked';
      this.message = this.resumeVerified ? '预检未报告阻断条件，可继续同一任务；再次暂停时请联系支持。' : blockedMessage(check);
    },'other','submit');
  }
  private async execute() {
    if (!this.input || !this.preflight || !this.selected || this.draft.dirty || !this.selectedMessages || this.materialBlock()) return;
    const input = this.input, generation = this.generation;
    await this.action(async () => {
      const latestMessages = await this.conversation.currentRef();
      const pinned = this.selectedMessages;
      if (!pinned || pinned.version !== latestMessages.version || pinned.content_sha256 !== latestMessages.content_sha256 ||
          JSON.stringify(pinned.message_ids) !== JSON.stringify(latestMessages.message_ids) || generation !== this.generation) {
        this.invalidate(); this.message = '已保存的项目补充要求有变化，请核对后重新开始，新消息不会写入旧任务。'; return;
      }
      const request = await executionRequest(input, this.taskKind);
      if(this.quote?.quote)request.quote_id=this.quote.quote.quote_id;
      if (!this.active || generation !== this.generation || this.materialBlock()) return;
      this.pendingExecution={...request};this.pendingExecutionConflict=false;this.render();
      await this.submitExecution(this.pendingExecution);
    }, 'execute');
  }
  private matchesExecution(run:Dto<'RunResponse'>, request:Dto<'ExecuteRequest'>) {
    return run.project_id===this.id&&run.project_id===request.project_id&&run.input_revision===request.input_revision&&
      run.input_hash===request.input_hash&&run.execution_request_id===request.execution_request_id;
  }
  private async submitExecution(request:Dto<'ExecuteRequest'>) {
    try {
      const run=await this.api.execute(request,this.controller.signal);
      if(!this.active)return;
      if(!this.matchesExecution(run,request))throw new ApiError(0,'DATA_UNAVAILABLE');
      this.acceptRun(run);this.message='任务已提交；重复提交此版本会返回同一任务。';void this.poll();
    }catch(error){
      if(error instanceof ApiError&&error.status===402&&error.code==='CREDITS_INSUFFICIENT')this.fundingHref=await billingTaskRechargeHrefForRequest(undefined,'/runs/execute',request);
      if(error instanceof ApiError&&error.code==='IDEMPOTENCY_CONFLICT')this.pendingExecutionConflict=true;
      else if(error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==408&&(error.status!==429||error.code==='TRIAL_QUOTA_EXCEEDED')){
        // A definitive rejection has no accepted run; billing can now obtain a new quote.
        this.pendingExecution=undefined;this.pendingExecutionConflict=false;
      }
      throw error;
    }
  }
  private async retryExecution() {
    const request=this.pendingExecution;
    if(!request||this.pendingExecutionConflict||this.restoring)return;
    await this.action(()=>this.submitExecution(request),'execute');
  }
  private acceptRun(run: Dto<'RunResponse'>) {
    this.fundingHref=undefined;
    if(this.pendingExecution&&this.matchesExecution(run,this.pendingExecution)){
      this.pendingExecution=undefined;this.pendingExecutionConflict=false;
    }
    const delivered=run.state==='succeeded'&&(this.run?.run_id!==run.run_id||this.run?.state!=='succeeded');
    this.runReadVersion++;
    if (this.run?.state === 'succeeded' && this.run.artifact_id) this.latestArtifact = this.run.artifact_id;
    if (this.run?.state !== run.state || this.run?.stage !== run.stage) this.reason = undefined;
    if (this.run?.run_id !== run.run_id) {
      this.eventCursor = 0; this.reason = undefined; this.events = [];
      this.lastPausedEvent = undefined; this.pauseBeforeResume = undefined; this.repeatedPauseEvent = undefined;
      this.retryOffer=undefined;this.retryReadKey=undefined;this.retryFeedback='';this.pendingRunRetry=undefined;this.viewingProjectMaterials=false;
      this.retryDialog?.remove();
    }
    if (this.run?.run_id !== run.run_id) this.resumedPause = undefined;
    if (this.run?.run_id !== run.run_id || this.run?.state !== run.state || this.run?.stage !== run.stage) this.resumeVerified = false;
    if(!this.restoring&&this.nextRequested)this.writePreparationRoute(false,run.run_id);
    this.run = run; this.nextRequested = false;this.nextBasis=undefined;this.nextBasisError='';
    if(delivered)this.onDelivered?.();
    this.watchRun(run);
    void this.loadRunMaterials(run);void this.loadRetryOptions();
    void this.loadCharge();
  }
  private watchRun(run:Dto<'RunResponse'>) {
    if(['succeeded','test_completed','failed','cancelled','rejected'].includes(run.state)){
      this.eventStream?.close();this.eventStream=undefined;this.streamRun=undefined;return;
    }
    if(this.streamRun===run.run_id||typeof EventSource==='undefined')return;
    this.eventStream?.close();this.streamRun=run.run_id;
    const stream=this.eventStream=new EventSource('/api/v1/runs/'+encodeURIComponent(run.run_id)+'/stream');
    const changed=()=>{if(!this.active||this.run?.run_id!==run.run_id)return;this.streamDirty=true;if(!this.polling)void this.poll();};
    stream.addEventListener('run.progress',changed);stream.addEventListener('run.state_changed',changed);
    stream.addEventListener('artifact.ready',changed);
    // Regular authenticated polling remains the fallback, including after session refresh.
  }
  private async loadCharge() {
    const run = this.run;
    if (!this.active || !run) return;
    if (this.chargeLoading) { this.chargeRefreshPending = true; return; }
    if (this.chargeRun !== run.run_id) { this.charge = undefined; this.chargeRun = run.run_id; }
    const readVersion = this.runReadVersion;
    clearTimeout(this.chargeRetryTimer);
    this.chargeLoading = true;
    try {
      const charge = await this.api.runCharge(run.run_id, this.controller.signal);
      if (this.active && this.run?.run_id === run.run_id && readVersion === this.runReadVersion && this.run.state === run.state) {
        const balanceChanged = charge.progress?.policy === 'authoring_balance_v2' &&
          (charge.progress.charged_points !== this.charge?.progress?.charged_points || charge.progress.available_points !== this.charge?.progress?.available_points);
        this.charge = charge; this.chargeError = run.billing_mode === 'fixed_credits' && (!charge.quote || !charge.state);
        if (balanceChanged) window.dispatchEvent(new Event('bondbuddy:credits-changed'));
      } else if(this.active && this.run) this.chargeRefreshPending = true;
    } catch { if (this.active && this.run?.run_id === run.run_id && readVersion === this.runReadVersion && this.run.state === run.state) { this.charge = undefined; this.chargeError = true; } else if(this.active && this.run) this.chargeRefreshPending = true; }
    finally {
      this.chargeLoading = false;
      if (this.active) {
        this.render();
        if (this.chargeRefreshPending) { this.chargeRefreshPending = false; void this.loadCharge(); }
        else if(this.run && (this.chargeError || ['succeeded','failed','cancelled','rejected'].includes(this.run.state) && this.charge?.state==='held')) this.chargeRetryTimer=setTimeout(()=>{void this.loadCharge();},2000);
      }
    }
  }
  private async restore() {
    if (this.busy) return;
    this.clearFirstDraft();
    if(this.pendingExecution){await this.restorePendingExecution();return;}
    this.nextBasisRead++;this.nextBasisLoading=false;this.nextBasis=undefined;
    this.runReadVersion++;
    clearTimeout(this.timer);
    this.restoring = true;
    await this.action(async () => {
      const uncertain = this.uncertainInputSave;
      this.recoveredInputMessages = undefined;
      this.inputReadUncertain = true;
      this.selected = false; this.selectedMessages = undefined; this.preflight = undefined; this.quote = undefined;
      this.resumeVerified = false;
      const project = await this.api.project(this.id, this.controller.signal);
      const input = project.input_revision ? await this.api.inputRevision(this.id, project.input_revision, this.controller.signal) : undefined;
      if (!this.active) return;
      if (input && (input.project_id !== this.id || input.input_revision !== project.input_revision || input.input_hash !== project.input_hash)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.input = input;
      const staleNotice = Boolean(this.initialNotice);
      this.message = this.initialNotice;
      this.initialNotice = '';
      const requestedRun=new URLSearchParams(location.hash.split('?')[1]).get('run');
      let workpaperTask:ProjectTask|undefined;
      const own=await authoringTasks(c=>this.api.projectTasks(this.id,c,this.controller.signal),this.id,()=>!this.active,task=>{
        if(task.run_id===requestedRun&&(task.operation==='workpaper_assessment'||task.operation==='workpaper_check'))workpaperTask=task;
      });
      if(!this.active)return;
      // Older project links used the authoring route for checks without a topic.
      // Resolve them during the normal asynchronous restore, without blocking draft editing.
      if(workpaperTask){const returnProject=new URLSearchParams(location.hash.split('?')[1]).get('return_project');location.replace(taskHref(workpaperTask)+(returnProject?'&return_project='+encodeURIComponent(returnProject):''));return;}
      this.knownLatestInput=project.input_revision??0;
      const preparationIntent=new URLSearchParams(location.hash.split('?')[1]);
      const afterValue=preparationIntent.get('prepare_after');
      const after=afterValue&&/^\d+$/.test(afterValue)&&Number.isSafeInteger(Number(afterValue))?Number(afterValue):null;
      const advanced=preparationIntent.get('prepare')==='next'&&after!==null&&(project.input_revision??0)>after;
      let newer:Dto<'RunResponse'>|undefined;
      if(advanced){
        // Task projections do not expose input pins. Read actual runs; never add
        // private fields to a public DTO or assume task ordering proves lineage.
        for(const task of own.slice(0,50)){
          const candidate=await this.api.run(task.run_id,this.controller.signal);
          if(!this.active)return;
          if(candidate.run_id!==task.run_id||candidate.project_id!==this.id)throw new ApiError(0,'DATA_UNAVAILABLE');
          if(candidate.input_revision===project.input_revision&&candidate.input_hash===project.input_hash){newer=candidate;break;}
        }
      }
      const activeTask=own.find(t=>!['succeeded','test_completed','failed','cancelled','rejected'].includes(t.state));
      this.otherActiveRun=activeTask?.run_id!==requestedRun?activeTask?.run_id:undefined;
      this.latestArtifact=own.find(t=>t.state==='succeeded'&&t.artifact_id)?.artifact_id??undefined;
      const selected=(preparationIntent.get('prepare')==='next'?(activeTask?.run_id??newer?.run_id):undefined)??requestedRun??activeTask?.run_id??own[0]?.run_id;
      if(selected){
        const run=newer?.run_id===selected?newer:await this.api.run(selected,this.controller.signal);if(!this.active)return;
        if(run.project_id!==this.id||run.run_id!==selected)throw new ApiError(0,'DATA_UNAVAILABLE');
        this.acceptRun(run);void this.poll();
      }
      if(this.otherActiveRun===this.run?.run_id)this.otherActiveRun=undefined;
      const intent=new URLSearchParams(location.hash.split('?')[1]);
      const unassignedInput=advanced&&!newer;
      if(intent.get('prepare')==='next'&&requestedRun===this.run?.run_id&&this.run&&after!==null&&!newer&&!unassignedInput&&
        !this.otherActiveRun&&['succeeded','test_completed','failed','cancelled','rejected'].includes(this.run.state)){
        this.preparationAfter=after;this.nextRequested=true;this.nextChoice=intent.get('basis')==='current'?'current':this.run.state==='succeeded'&&this.run.channel==='production'?'result':'current';
        const details=document.querySelector<HTMLDetailsElement>('#project-materials-details');if(details)details.open=true;
      }else if(intent.get('prepare')==='next'){
        this.writePreparationRoute(false);
        if(newer||activeTask)this.message='项目已有新一轮任务，已恢复对应任务。准备不会自动启动新任务。';
        else if(unassignedInput)this.message='已读取到更新的输入版本，最近任务尚未核对到对应回执，准备状态未自动恢复。请先核对任务记录；确认需要新一轮时再点击“继续修改”。';
      }
      this.inputReadUncertain = false;
      this.inputWriteUncertain = false;
      // Only a readback after this page's lost save can reuse an input. An ordinary
      // reload starts from current fields; edits invalidate the explicit recovery.
      if (uncertain && input && !this.run && !staleNotice && uncertain.generation === this.generation && !this.draft.dirty &&
          project.draft_revision === uncertain.draftRevision && input.input_revision === uncertain.afterRevision + 1 &&
          input.material_versions.length === uncertain.materialVersions.length &&
          input.material_versions.every(pin => uncertain.materialVersions.some(sent => pin.material_id === sent.material_id && pin.material_version === sent.material_version))) {
        this.recoveredInputMessages = uncertain.messages;
        this.message = '已找回保存内容，点击“开始更新”继续；不会重复保存或自动启动。';
      }
      this.uncertainInputSave = undefined;
      if(this.pendingExecution)this.message=this.pendingExecutionConflict?'上次提交的记录存在冲突，请联系支持核对；尚未获得对应任务回执。':'最近任务尚未核对到上次提交的准确回执。可点击“核对上次提交”，沿用原请求继续核对。';
    },'other','read');
    this.restoring = false; this.render();
    if(this.active&&this.nextRequested)void this.loadContinuationBasis(false);
    if (this.active && this.run) void this.poll();
  }
  private async restorePendingExecution() {
    const request=this.pendingExecution;if(!request)return;
    this.restoring=true;
    try{await this.action(async()=>{
      const project=await this.api.project(this.id,this.controller.signal);
      if(project.project_id!==this.id)throw new ApiError(0,'DATA_UNAVAILABLE');
      const own=await authoringTasks(c=>this.api.projectTasks(this.id,c,this.controller.signal),this.id,()=>!this.active);
      for(const task of own.slice(0,50)){
        const run=await this.api.run(task.run_id,this.controller.signal);
        if(!this.active)return;
        if(run.run_id!==task.run_id||run.project_id!==this.id)throw new ApiError(0,'DATA_UNAVAILABLE');
        if(this.matchesExecution(run,request)){
          this.acceptRun(run);this.writePreparationRoute(false,run.run_id);
          this.message='已核对到上次提交的任务，未创建新输入或新任务。';void this.poll();return;
        }
      }
      this.message=this.pendingExecutionConflict?'上次提交的记录存在冲突，请联系支持核对；尚未获得对应任务回执。':'最近任务尚未核对到上次提交的准确回执。可点击“核对上次提交”，沿用原请求继续核对。';
    },'other','read');}finally{this.restoring=false;if(this.active)this.render();}
  }
  private async poll() {
    clearTimeout(this.timer);
    if (!this.run || !this.active || this.polling) return;
    this.polling = true;this.streamDirty = false;
    const id = this.run.run_id;
    const readVersion = this.runReadVersion;
    try {
      const run = await this.api.run(id, this.controller.signal);
      if (!this.active || readVersion !== this.runReadVersion || this.run?.run_id !== id) return;
      if (run.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      const delivered=run.state==='succeeded'&&this.run.state!=='succeeded';
      if (this.run.state !== run.state || this.run.stage !== run.stage) this.reason = undefined;
      if (this.run.state !== run.state || this.run.stage !== run.stage) this.resumeVerified = false;
      this.run = run;this.watchRun(run);
      if(run.state!=='paused'||run.stage!=='provider_reconcile'){this.retryOffer=undefined;this.retryReadKey=undefined;this.pendingRunRetry=undefined;this.retryDialog?.close();}
      if(delivered)this.onDelivered?.();
      // Billing may settle/release independently of the run state; refresh on every poll.
      void this.loadCharge();
      // Read all new pages: a reconnect must not lose the actual pause/error reason.
      let cursor = this.eventCursor;
      for (;;) {
        const page = await this.api.runEvents(id, cursor, this.controller.signal);
        if (!this.active || readVersion !== this.runReadVersion || this.run?.run_id !== id) return;
        for (const event of page.items) {
          if (event.run_id !== id || event.seq <= this.eventCursor) continue;
          this.eventCursor = event.seq;
          this.events = retainAuthoringEvents([...this.events,event]);
          if (event.payload.reason === 'user_resumed') this.pauseBeforeResume = this.lastPausedEvent;
          if (event.state === 'paused') {
            this.repeatedPauseEvent = this.pauseBeforeResume?.stage === event.stage &&
              this.pauseBeforeResume.payload.reason === event.payload.reason ? event : undefined;
            this.lastPausedEvent = event;
          }
          const reason = event.state === run.state && event.stage === run.stage
            ? executionEventReason(event.payload) : undefined;
          if (this.reason !== reason) this.resumeVerified = false;
          this.reason = reason;
        }
        if (page.next_cursor === null || page.next_cursor <= cursor) break;
        cursor = page.next_cursor;
      }
      // An event can arrive while the run read still describes its preceding state.
      // Reuse the matching cached event once a newer run read reaches that cursor.
      const currentCursor = run.event_cursor ?? 0;
      const currentEvent = this.events.slice().reverse().find(event => event.seq <= currentCursor &&
        event.state === run.state && event.stage === run.stage);
      const reason = executionEventReason(currentEvent?.payload);
      if (this.reason !== reason) this.resumeVerified = false;
      this.reason = reason;
      void this.loadRetryOptions();
      this.progressMessage = '';
    } catch (error) {
      if (this.active && readVersion === this.runReadVersion) this.progressMessage = `任务状态暂未更新。${friendlyError(error,'read')}`;
    } finally {
      this.polling = false; this.render();
      if (this.active && this.run && !['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'].includes(this.run.state)) {
        if (readVersion !== this.runReadVersion || this.streamDirty) {
          if (!this.restoring) void this.poll();
        } else this.timer = setTimeout(() => { void this.poll(); }, 2000);
      }
    }
  }
  dispose() { this.retryDialog?.remove();this.creditDialog?.remove(); clearTimeout(this.chargeRetryTimer); this.eventStream?.close(); this.controller.abort(); clearTimeout(this.timer); this.delivery?.dispose(); }
}
