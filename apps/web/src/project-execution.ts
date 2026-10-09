import { ArtifactPage } from './artifact-page';
import { prototypeIcon as icon } from './prototype-design';
import { reportingWindow, sourceProspectusInputGaps, type RunState, type RUN_PAUSE_STAGES, type RUN_RUNTIME_REASONS, type ProjectMessageSetRef } from '@bondbuddy/contracts';
import { ApiClient, ApiError, errorReference, friendlyError, type Dto } from './api';
import type { Draft } from './draft';
import { executionRequest, executionTaskKind, type ExecutionTaskKind } from './execution-request';
import { referencePin, selectedReference, type ReferenceSnapshotResolver, type UserReferenceChoice } from './reference';
import type { ProjectConversation } from './project-conversation';
import { date, esc } from './ui';
import './project-execution.css';
import { taskProgress } from './task-progress';

type Input = Dto<'InputRevisionResponse'>;
type Material = Dto<'MaterialResponse'>;
const states: Record<RunState, string> = {
  preparing: '准备中', rejected: '未启动', queued: '排队中', running: '处理中', awaiting_input: '待补充信息',
  paused: '任务已暂停', validating: '检查成果中', delivering: '交付中', settlement_pending: '结算处理中',
  succeeded: '已生成', test_completed: '内部测试工作稿', failed: '任务失败', cancelled: '已取消'
};
const stages: Record<string, string> = { input_lock: '核对输入与规则', materials_ready: '读取材料',
  model_generation: '生成全文内容', provider_call: '正在编制募集书', word_delivery: '正在准备 Word 下载', capability_not_ready: '等待处理条件',
  queued: '等待处理', completed: '处理完成' };

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
  if (unified) return `本次输入尚未满足执行条件，请核对本次目标及已上传原稿的信息；历史／参考募集书选填，无需更改企业关系或重复上传。${reference}`;
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
export function readinessMessage(reason: string): string {
  if (reason === 'provider_result_pending' || reason === 'provider_reconciliation_required') return '编制服务暂未返回结果，正在核对并恢复；已完成内容会保留，无需补充材料。';
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
  return '仍有待处理条件，请查看材料信息或联系支持。';
}

/** Stable across tabs/reloads; a new input revision is required for an intentional new run. */
export class ProjectExecution {
  private controller = new AbortController();
  private host!: HTMLElement;
  private actions!: HTMLElement;
  private materialMessage = '';
  private restoring = false;
  private offerSavedInput = false;
  private input?: Input;
  private selectedMessages?: ProjectMessageSetRef;
  private starting = false;
  private nextRequested = false;
  private materialRun?: string;
  private delivery?: ArtifactPage;
  private deliveryId?: string;
  private events: Dto<'RunEvent'>[] = [];
  private selected = false;
  private preflight?: Dto<'PreflightResponse'>;
  private run?: Dto<'RunResponse'>;
  private latestArtifact?: string;
  private reason?: string;
  private eventCursor = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private runReadVersion = 0;
  private busy = false;
  private inputReadUncertain = false;
  private resumeVerified = false;
  private resumedPause?: { runId: string; stage: string | null; reason?: string };
  private lastPausedEvent?: Dto<'RunEvent'>;
  private pauseBeforeResume?: Dto<'RunEvent'>;
  private repeatedPauseEvent?: Dto<'RunEvent'>;
  private message = '';
  private progressMessage = '';
  private materials: Material[] = [];
  private sourceStamp = '';
  private materialReady = false;
  private generation = 0;
  private inputRejected = false;
  private quote?: Dto<'FixedQuoteResponse'>;
  private charge?: Dto<'RunCreditChargeResponse'>;
  private chargeRun?: string;
  private chargeLoading = false;
  private chargeRefreshPending = false;
  private chargeError = false;
  private paidEnabled?: boolean;
  private awaitingCredits = new URLSearchParams(location.hash.split('?')[1] ?? '').get('resume') === 'credits';

  constructor(private api: ApiClient, private draft: Draft, private conversation: ProjectConversation,
    private referenceSnapshots?: ReferenceSnapshotResolver, private onStaleInput?: () => void,
    private initialNotice = '') {}
  private get active() { return !this.controller.signal.aborted; }
  private get id() { return this.draft.project.project_id; }
  get materialsEditable() {
    return this.active && !this.restoring && !this.inputReadUncertain && !this.starting && !this.busy && (!this.run || this.nextRequested);
  }
  /** The persisted project kind decides the task kind, including an explicit server-side conversion. */
  private get taskKind(): ExecutionTaskKind { return executionTaskKind(this.draft.project.kind); }
  mount(host: HTMLElement, actions: HTMLElement) {
    this.host = host; this.actions = actions;
    host.innerHTML = '<section class="panel execution-panel" id="run-panel" hidden><div id="execution-progress" aria-live="polite"></div></section><div id="execution-delivery" class="embedded-artifact"></div>';
    actions.innerHTML = `<div id="execution-preflight" hidden></div><p id="execution-message" role="status"></p><p id="start-disabled-reason" role="status"></p><div class="start-buttons"><button class="text-button" type="button" id="refresh-execution" hidden>重新读取</button><button class="text-button" type="button" id="select-saved-input" hidden>继续上次提交</button><button class="text-button" type="button" id="recheck-input" hidden>重新检查处理条件</button><button class="btn primary" type="button" id="execute-input" aria-describedby="start-disabled-reason execution-message">开始编制 ${icon('arrow')}</button></div>`;
    this.button('execute-input').addEventListener('click', () => { void this.start(); });
    this.button('refresh-execution').addEventListener('click', () => { void this.restore(); });
    this.button('select-saved-input').addEventListener('click', () => {
      if (this.busy) return;
      void (async () => {
        this.busy = true; this.render();
        try {
          const ref = await this.conversation.currentRef();
          if (!this.active) return;
          if (ref.message_ids.length) {
            this.offerSavedInput = false;
            this.message = '已有已保存补充要求，不能继续未证明包含这些消息的旧输入；请重新开始以锁定新版本。';
            return;
          }
          this.selectedMessages = ref; this.selected = true; this.offerSavedInput = false; this.message = '';
        } catch (error) {
          if (this.active) this.message = friendlyError(error);
        } finally {
          this.busy = false; this.render();
        }
        if (this.selected) void this.start();
      })();
    });
    this.button('recheck-input').addEventListener('click', () => { void this.recheck(); });
    this.sync([], false, '正在读取已保存材料…');
    void this.restore();
    void this.api.creditBalance(this.controller.signal).then(balance => {
      if (this.active) { this.paidEnabled = balance.enabled; this.render(); }
    }).catch(() => {});
  }
  private node(selector: string) { return this.host.querySelector<HTMLElement>(selector) ?? this.actions.querySelector<HTMLElement>(selector)!; }
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
      return { status: 'blocked', message: '用户指定参考稿的目标市场与发行方式尚未保存，请刷新项目信息并重新选择参考稿后再开始编制。' };
    }
    let fresh: Material;
    try {
      fresh = this.referenceSnapshots ? await this.referenceSnapshots(this.id, reference) : reference;
    } catch {
      return { status: 'blocked', message: '用户指定参考稿信息暂时无法读取，请刷新已保存材料并重新选择参考稿后再开始编制。' };
    }
    const resolved = referencePin(reference, fresh, project.offering);
    return 'note' in resolved ? { status: 'blocked', message: resolved.note } : { status: 'pinned', choice: resolved.choice };
  }
  private startBlockReason(): string {
    if (this.run && !['succeeded','test_completed','failed','cancelled','rejected'].includes(this.run.state)) return '已有任务正在处理，请查看上方进度。';
    if (this.restoring) return '正在读取项目状态…';
    if (this.busy || this.starting) return '正在提交，请稍候。';
    if (this.inputReadUncertain) return '上次操作结果尚未确认，请重新读取。';
    if (this.inputRejected) return '本次输入已被拒绝；请按上方提示处理，输入不变时无需重复提交。';
    if (this.preflight?.status === 'blocked' && this.selected) return '当前处理条件尚未就绪，请重新检查；条件未变时无需重复提交。';
    if (!this.materialReady) return this.materialMessage || '材料尚未保存完成，请查看文件进度。';
    if (!this.eligibleMaterials().length) return '请先添加本次需要的项目材料。';
    if (this.draft.state === 'conflict' || this.draft.state === 'error' || !this.draft.valid) return '项目信息尚未保存，请返回上一步处理。';
    if (!this.draft.fields.market || !this.draft.fields.offering) return '请在上一步选择发行市场和发行方式。';
    if (this.run && !this.nextRequested) return '需要再次修改时，请点击上方“继续修改”。';
    const sourceGaps = sourceProspectusInputGaps(this.eligibleMaterials(), this.draft.fields.update_details.source_prospectuses);
    if (sourceGaps.length) {
      const first = sourceGaps[0], material = this.materials.find(m => m.material_id === first.material_id);
      return `请补齐“${material?.filename ?? '历史／参考募集书'}”的${first.missing.join('、')}后继续${sourceGaps.length > 1 ? `（共 ${sourceGaps.length} 份原稿待补充）` : ''}。`;
    }
    if (this.conversation.blockReason) return this.conversation.blockReason;
    return '';
  }
  private invalidate() {
    this.generation++; this.selected = false; this.selectedMessages = undefined; this.preflight = undefined;
    this.resumeVerified = false;
    this.quote = undefined;
    this.inputRejected = false;
    this.render();
  }
  conversationChanged() { if (this.active) this.invalidate(); }
  sync(materials: Material[], ready: boolean, materialMessage = '') {
    if (!this.active) return;
    const stamp = JSON.stringify([this.draft.fields, materials.map(m => [m.material_id, m.material_version]).sort()]);
    if (stamp !== this.sourceStamp || (this.materialReady && !ready)) {
      this.sourceStamp = stamp;
      this.invalidate();
    }
    this.materials = materials; this.materialReady = ready; this.materialMessage = materialMessage;
    this.render();
  }
  private button(id: string) { return this.node(`#${id}`) as HTMLButtonElement; }
  private samePauseAfterResume(run: Dto<'RunResponse'>) {
    if (this.resumedPause?.runId === run.run_id && this.resumedPause.stage === run.stage && this.resumedPause.reason === this.reason) return true;
    return this.repeatedPauseEvent?.stage === run.stage && this.repeatedPauseEvent.payload.reason === this.reason;
  }
  private render() {
    if (!this.active) return;
    const activeRun = this.run && !['succeeded','test_completed','failed','cancelled','rejected'].includes(this.run.state);
    const materialsLocked = Boolean(this.run && !this.nextRequested);
    const materialDetails = document.querySelector<HTMLElement>('#project-materials-details');
    if (materialDetails) {
      materialDetails.classList.toggle('materials-readonly', materialsLocked);
      materialDetails.querySelector<HTMLFieldSetElement>('#material-editing')!.disabled = !this.materialsEditable;
      materialDetails.querySelector('#materials-state-label')!.textContent = materialsLocked ? '材料已锁定，仅可查看' : this.nextRequested ? '为下一轮补充材料' : '开始编制前可补充';
      materialDetails.querySelector('#materials-title')!.textContent = materialsLocked ? '查看项目材料' : '提供项目材料';
      materialDetails.querySelector('#materials-state-description')!.textContent = materialsLocked
        ? activeRun ? '本次编制已开始，材料已锁定，无法新增、替换或删除。' : '本次编制材料已锁定。需要补充材料时，请点击“继续修改”，用于下一轮编制。'
        : this.nextRequested ? '补充材料将用于下一轮编制，已开始的任务和已有成果保持不变。' : '请在开始编制前补齐材料；开始后材料锁定，仅可查看。';
      materialDetails.querySelectorAll('.material-subtypes>summary').forEach(summary => {
        summary.textContent = materialsLocked ? '按细分类别查看材料' : '按细分类别补充材料（选填）';
      });
    }
    this.conversation.setEditingVisible(!this.restoring && !activeRun && (!this.run || this.nextRequested));
    this.actions.closest('.authoring-actions')?.classList.toggle('is-preparing', !this.restoring && !activeRun && (!this.run || this.nextRequested));
    const blocked = this.startBlockReason();
    this.button('execute-input').disabled = Boolean(blocked) || Boolean(this.quote?.shortage);
    this.button('execute-input').textContent = this.busy || this.starting ? (this.restoring ? '开始编制' : '正在提交…')
      : this.awaitingCredits ? '继续更新'
      : this.nextRequested ? '生成新版' : '开始编制';
    let quoteHost=this.actions.querySelector<HTMLElement>('#fixed-quote');
    if(!quoteHost){quoteHost=document.createElement('div');quoteHost.id='fixed-quote';quoteHost.setAttribute('aria-live','polite');this.actions.prepend(quoteHost);}
    const q=this.quote;
    quoteHost.hidden=!q?.shortage||Boolean(activeRun)||Boolean(this.run&&!this.nextRequested);
    quoteHost.innerHTML=q?.shortage?`<div class="fixed-quote"><h3>积分不足，请充值后继续更新</h3><p>项目材料与补充要求已保留，当前没有启动更新任务。</p><a class="btn primary" href="#/account?project=${encodeURIComponent(this.id)}">充值积分</a><button type="button" class="text-button" id="refresh-quote">刷新余额</button></div>`:'';
    quoteHost.querySelector<HTMLButtonElement>('#refresh-quote')?.addEventListener('click',()=>{void this.action(()=>this.loadQuote());});
    let billingHint = this.actions.querySelector<HTMLElement>('#execution-credit-hint');
    if (!billingHint) { billingHint = document.createElement('p'); billingHint.id = 'execution-credit-hint'; billingHint.className = 'muted'; this.actions.querySelector('.start-buttons')!.before(billingHint); }
    billingHint.hidden = Boolean(activeRun || this.run && !this.nextRequested || q?.shortage);
    billingHint.textContent = this.paidEnabled === false ? '当前为试用编制，本次不扣积分。'
      : '成功交付成果后扣除积分；失败或取消不扣费。';
    this.node('#start-disabled-reason').textContent = blocked;
    this.node('#execution-message').textContent = this.message;
    this.button('refresh-execution').disabled = this.busy || this.starting;
    this.button('refresh-execution').hidden = !this.inputReadUncertain && !this.run && !this.progressMessage;
    this.button('select-saved-input').hidden = !this.offerSavedInput || this.inputReadUncertain || !this.conversation.ready || this.conversation.hasMessages;
    this.button('select-saved-input').disabled = Boolean(blocked);
    const check = this.preflight;
    this.node('#execution-preflight').hidden = !check || check.status !== 'blocked' || Boolean(activeRun);
    this.node('#execution-preflight').textContent = check?.status === 'blocked' && !activeRun ? blockedMessage(check) : '';
    this.button('recheck-input').hidden = !(check?.status === 'blocked' || this.inputRejected && this.selected && this.input) || Boolean(activeRun);
    this.button('recheck-input').disabled = this.busy || this.starting || !this.selected || this.inputReadUncertain;
    const run = this.run;
    this.node('#run-panel').hidden = !run;
    const progressHost = document.querySelector('#workspace-progress');
    if (run && progressHost && this.host.parentElement !== progressHost) progressHost.append(this.host);
    if (run && this.materialRun !== run.run_id) { const details = document.querySelector<HTMLDetailsElement>('#project-materials-details'); if (details) { details.classList.add('has-run'); details.open = false; } this.materialRun = run.run_id; }
    const testRun = run?.channel === 'non_production_test';
    const testCompleted = run?.state === 'test_completed' && testRun;
    const automaticPause = automaticPauseMessage(run);
    const repeatedPause = run?.state === 'paused' && this.samePauseAfterResume(run);
    const needsAttention = run && ['paused', 'awaiting_input', 'failed', 'rejected', 'cancelled'].includes(run.state);
    // The current run stage is authoritative even when event history is late or unavailable.
    const summary = automaticPause
      ? (this.reason !== 'trial_limit_cleared' && runtimeMessage(this.reason)) || automaticPause
      : repeatedPause ? '任务再次停在相同条件，重复继续不会推进。请联系支持核对恢复条件。'
      : needsAttention && this.reason ? readinessMessage(this.reason)
        : !needsAttention && this.reason === 'trial_limit_cleared' ? runtimeMessage(this.reason)
        : run?.state === 'paused' ? run.stage === 'awaiting_materials'
          ? '等待材料处理完成，条件满足后后台会继续。'
          : run.stage === 'provider_reconcile' ? '正在核对编制服务响应；已保存材料会保留，无需重新上传。'
          : '处理条件尚未就绪，请联系支持核对。' : undefined;
    this.host.querySelector('#execution-progress')!.innerHTML = `${run ? `<div class="run-status-card"><div class="eyebrow">募集书全文更新</div>${taskProgress(run,'update')}${summary ? `<div class="execution-summary">${esc(summary)}</div>` : ''}${testCompleted ? '<p>仅供内部测试，仍有规则和内容待核，不可用于正式申报。</p>' : testRun && run.state === 'failed' ? '<p>这是内部测试任务；请先联系支持核对失败原因。正式更新需保存新输入版本后重新开始，不会自动重试此任务。</p>' : testRun ? '<p>这是内部测试任务，不代表正式更新。</p>' : ''}
      ${this.events.length ? `<ol class="execution-events">${this.events.slice(-6).map(event => `<li><time>${esc(date(event.occurred_at))}</time><span>${esc(stages[event.stage ?? ''] ?? states[event.state])}${event.payload.completed_items !== undefined ? ` · 已处理 ${event.payload.completed_items}${event.payload.total_items != null ? ` / ${event.payload.total_items}` : ''} 项` : ''}</span></li>`).join('')}</ol>` : ''}
      <p class="task-credit-receipt" role="status">${run.billing_mode==='fixed_credits'
        ? this.charge?.quote && this.charge.state ? `本次 ${this.charge.quote.points.toLocaleString('zh-CN')} 积分 · ${{held:'已预留，交付后扣费',settled:'已扣费',released:'已返还，本次不扣费'}[this.charge.state]}`
          : this.chargeError ? '本次积分状态暂未同步。' : '正在读取本次积分状态…'
        : '本次任务按提交时的试用规则执行，不扣积分。'}${run.billing_mode==='fixed_credits' ? '<button type="button" class="text-button" id="refresh-run-charge">刷新积分状态</button>' : ''}</p>
      <p class="muted">${activeRun ? '关闭页面不会取消任务。编制开始后材料已锁定，仅可查看。' : this.nextRequested ? '补充材料或修改要求将用于下一轮编制，旧成果仍会保留。' : '本次材料已锁定。点击“继续修改”后可为下一轮补充材料或修改要求，旧成果仍会保留。'}</p>
      <div class="form-actions">${activeRun ? '<button class="button secondary" type="button" id="cancel-run">停止本次任务</button>' : ''}${run.state === 'paused' && run.stage === 'capability_not_ready' && !repeatedPause
        ? this.resumeVerified ? '<button class="button secondary" type="button" id="resume-run">继续更新</button>'
          : '<button class="text-button" type="button" id="recheck-paused">重新检查处理条件</button>' : ''}${!activeRun ? '<button class="button secondary" type="button" id="prepare-next-version">继续修改</button>' : ''}<button class="text-button" type="button" id="show-project-materials">查看材料</button></div></div>` : ''}
      ${this.latestArtifact && this.latestArtifact !== run?.artifact_id ? `<a class="text-button" href="#/artifacts/${encodeURIComponent(this.latestArtifact)}">查看此前成功成果</a>` : ''}<p>${esc(this.progressMessage)}</p>`;
    this.host.querySelector('#refresh-run-charge')?.addEventListener('click', () => { void this.loadCharge(); });
    for (const [id, action] of [['cancel-run','cancel'],['resume-run','resume']] as const) {
      const button = this.host.querySelector<HTMLButtonElement>(`#${id}`);
      if (button) { button.disabled = this.busy; button.addEventListener('click', () => { void this.changeRun(action); }); }
    }
    const recheckPaused = this.host.querySelector<HTMLButtonElement>('#recheck-paused');
    if (recheckPaused) { recheckPaused.disabled = this.busy; recheckPaused.addEventListener('click', () => { void this.recheckPaused(); }); }
    this.host.querySelector('#prepare-next-version')?.addEventListener('click', () => { this.nextRequested = true; this.invalidate(); const details=document.querySelector<HTMLDetailsElement>('#project-materials-details'); if(details)details.open=true; document.querySelector('#project-conversation-root')?.scrollIntoView({block:'center'}); });
    this.host.querySelector('#show-project-materials')?.addEventListener('click', () => { const details=document.querySelector<HTMLDetailsElement>('#project-materials-details'); if(details)details.open=true; document.querySelector('#materials-title')?.scrollIntoView({block:'start'}); });
    const artifactId = (run?.state === 'succeeded' || testCompleted) ? run?.artifact_id : undefined;
    if (artifactId && artifactId !== this.deliveryId) {
      this.delivery?.dispose(); this.deliveryId = artifactId;
      const host = this.host.querySelector<HTMLElement>('#execution-delivery')!;
      this.delivery = new ArtifactPage(this.api, html => { host.innerHTML = html; }, () => this.active && this.deliveryId === artifactId);
      void this.delivery.render(artifactId);
    } else if (!artifactId && this.deliveryId) { this.delivery?.dispose(); this.deliveryId = undefined; this.host.querySelector('#execution-delivery')!.innerHTML = ''; }
  }
  private async start() {
    if (!this.active || this.startBlockReason()) return;
    this.starting = true; this.render();
    try {
      if (!this.selected) await this.save();
      if (!this.active || !this.selected || !this.input) return;
      if (!this.preflight) await this.check();
      if (!this.active || !this.selected || !this.preflight) return;
      // Backend admission is authoritative; uncertainty alone does not add an upload review step.
      if (this.preflight.status === 'blocked') return;
      if(this.preflight.billing_mode==='fixed_credits'){
        if(!this.quote || this.quote.shortage)await this.action(()=>this.loadQuote());
        if(!this.quote?.enabled || !this.quote.quote || this.quote.shortage)return;
      }
      await this.execute();
    } finally { this.starting = false; this.render(); }
  }
  private async loadQuote() {
    if(!this.input||!this.selected)return;
    const generation=this.generation,input=this.input;
    const quote=await this.api.creditQuote(this.id,{input_revision:input.input_revision,input_hash:input.input_hash},this.controller.signal);
    if(!quote.enabled||!quote.quote)throw new ApiError(409,'QUOTE_REQUIRED');
    if(this.active&&generation===this.generation){this.quote=quote;if(quote.shortage)this.awaitingCredits=true;this.render();}
  }
  private async changeRun(action: 'cancel' | 'resume') {
    if (!this.run || action === 'resume' && (!this.resumeVerified || this.run.stage !== 'capability_not_ready')) return;
    const runId = this.run.run_id;
    const pause = { runId, stage: this.run.stage, reason: this.reason };
    if (action === 'resume') this.resumeVerified = false;
    await this.action(async () => {
      const run = await this.api.runAction(runId, action, this.controller.signal);
      if (!this.active) return;
      if (run.run_id !== runId || run.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      if (action === 'resume') this.resumedPause = pause;
      this.acceptRun(run); void this.poll();
    });
  }

  private async action(work: () => Promise<void>, operation: 'preflight' | 'execute' | 'other' = 'other') {
    if (this.busy || !this.active) return;
    this.busy = true; this.message = ''; this.render();
    try { await work(); }
    catch (error) {
      if (this.active) {
        if(error instanceof ApiError&&['QUOTE_CHANGED','QUOTE_REQUIRED','CREDITS_INSUFFICIENT'].includes(error.code)) {
          this.quote=undefined;this.awaitingCredits=true;
          if(error.code==='QUOTE_REQUIRED')this.preflight=undefined;
          else {try{await this.loadQuote();}catch{/* Explicit retry keeps the task unstarted. */}}
        }
        const inputMessage = operation !== 'other'
          ? executionInputError(error, this.draft.project.kind, this.draft.fields.update_details.has_historical, this.materials, this.draft.fields.update_details.authoring_mode === 'unified_v1') : undefined;
        this.inputRejected = operation !== 'other' && error instanceof ApiError && error.status === 409 &&
          (error.code === 'INPUT_REQUIRED' || operation === 'preflight' && error.code === 'CAPABILITY_NOT_READY');
        this.message = inputMessage ?? (error instanceof ApiError && error.code==='CREDITS_INSUFFICIENT' ? '积分不足，请充值后继续更新。' : error instanceof ApiError && error.code==='QUOTE_CHANGED' ? '计费条件已更新，请点击继续更新。' : error instanceof ApiError && error.code==='QUOTE_REQUIRED' ? '积分核验暂不可用，请稍后重新开始。' : undefined) ??
          (error instanceof ApiError && error.code === 'CAPABILITY_NOT_READY'
            ? operation === 'preflight' && error.status === 409
              ? `材料或处理条件尚未就绪，请稍后重新检查；持续未恢复时联系支持。${errorReference(error)}`
              : `当前环境尚未开放全文更新，请联系支持。${errorReference(error)}` : friendlyError(error));
      }
    }
    finally { this.busy = false; this.render(); }
  }
  private async save() {
    await this.action(async () => {
      if (!this.materialReady || this.inputReadUncertain) return;
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
      try {
        result = await this.api.createInputRevision(this.id, { draft_revision: p.draft_revision,
          material_versions: selected.map(m => ({ material_id: m.material_id, material_version: m.material_version })),
          requirement_message_ids: messages.message_ids, project_message_set_ref: messages,
          ...(reference.status === 'pinned' ? { user_reference: reference.choice } : {}),
          ...(this.input?.credit_facility_supplements?.length ? { credit_facility_supplements: this.input.credit_facility_supplements } : {}),

        }, this.controller.signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          this.invalidate();
          await this.conversation.refresh();
          this.message = '消息或项目版本已变化；已重新读取消息，请核对后再次开始。';
          return;
        }
        // This POST has no idempotency key. Never blindly replay after a lost response.
        if (!(error instanceof ApiError) || error.status >= 500) {
          this.inputReadUncertain = true;
          this.message = '保存结果尚未确认，请重新读取后继续上次提交。';
          return;
        }
        throw error;
      }
      if (!this.active) return;
      if (result.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.input = result;
      this.selectedMessages = messages;
      this.selected = generation === this.generation;
      this.message = this.selected ? '' : '保存期间有新的修改，请重新开始。';
    });
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
        this.offerSavedInput = false;
        this.invalidate();
        this.message = '项目已保存更新的输入版本，请核对最新材料与目标后重新开始。';
        this.onStaleInput?.();
      }
    });
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
    });
  }
  private async execute() {
    if (!this.input || !this.preflight || !this.selected || this.draft.dirty || !this.selectedMessages) return;
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
      if (!this.active || generation !== this.generation) return;
      const run = await this.api.execute(request, this.controller.signal);
      if (!this.active) return;
      if (run.project_id !== this.id || run.input_revision !== input.input_revision || run.input_hash !== input.input_hash || run.execution_request_id !== request.execution_request_id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.acceptRun(run); this.message = '任务已提交；重复提交此版本会返回同一任务。';
      void this.poll();
    }, 'execute');
  }
  private acceptRun(run: Dto<'RunResponse'>) {
    this.runReadVersion++;
    if (this.run?.state === 'succeeded' && this.run.artifact_id) this.latestArtifact = this.run.artifact_id;
    if (this.run?.state !== run.state || this.run?.stage !== run.stage) this.reason = undefined;
    if (this.run?.run_id !== run.run_id) {
      this.eventCursor = 0; this.reason = undefined; this.events = [];
      this.lastPausedEvent = undefined; this.pauseBeforeResume = undefined; this.repeatedPauseEvent = undefined;
    }
    if (this.run?.run_id !== run.run_id) this.resumedPause = undefined;
    if (this.run?.run_id !== run.run_id || this.run?.state !== run.state || this.run?.stage !== run.stage) this.resumeVerified = false;
    this.run = run; this.nextRequested = false;
    void this.loadCharge();
  }
  private async loadCharge() {
    const run = this.run;
    if (!this.active || !run || run.billing_mode !== 'fixed_credits') return;
    if (this.chargeLoading) { this.chargeRefreshPending = true; return; }
    if (this.chargeRun !== run.run_id) { this.charge = undefined; this.chargeRun = run.run_id; }
    this.chargeLoading = true;
    try {
      const charge = await this.api.runCharge(run.run_id, this.controller.signal);
      if (this.active && this.run?.run_id === run.run_id) {
        this.charge = charge; this.chargeError = !charge.quote || !charge.state;
      }
    } catch { if (this.active && this.run?.run_id === run.run_id) { this.charge = undefined; this.chargeError = true; } }
    finally {
      this.chargeLoading = false;
      if (this.active) {
        this.render();
        if (this.chargeRefreshPending) { this.chargeRefreshPending = false; void this.loadCharge(); }
      }
    }
  }
  private async restore() {
    if (this.busy) return;
    this.runReadVersion++;
    clearTimeout(this.timer);
    this.restoring = true;
    await this.action(async () => {
      this.inputReadUncertain = true;
      this.selected = false; this.preflight = undefined;
      this.resumeVerified = false;
      const project = await this.api.project(this.id, this.controller.signal);
      const input = project.input_revision ? await this.api.inputRevision(this.id, project.input_revision, this.controller.signal) : undefined;
      if (!this.active) return;
      if (input && (input.project_id !== this.id || input.input_revision !== project.input_revision || input.input_hash !== project.input_hash)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.input = input;
      const staleNotice = Boolean(this.initialNotice);
      this.message = this.initialNotice;
      this.initialNotice = '';
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.api.projects(cursor, { q: project.name, archive: 'all', limit: '100' }, this.controller.signal);
        if (!this.active) return;
        const found = page.items.find(item => item.project_id === this.id);
        if (found) {
          this.latestArtifact = found.latest_artifact?.artifact_id;
          if (found.latest_run) {
            const run = await this.api.run(found.latest_run.run_id, this.controller.signal);
            if (!this.active) return;
            if (run.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
            this.acceptRun(run); void this.poll();
          }
          break;
        }
        cursor = page.page.next_cursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new ApiError(0, 'DATA_UNAVAILABLE');
        if (cursor) seen.add(cursor);
      } while (cursor);
      this.inputReadUncertain = false;
      // InputRevisionResponse does not expose the message pin. Never execute a
      // recovered snapshot when a nonempty message set could have changed since it was locked.
      this.offerSavedInput = Boolean(input && !this.run && !staleNotice);
    });
    this.restoring = false; this.render();
    if (this.active && this.run) void this.poll();
  }
  private async poll() {
    clearTimeout(this.timer);
    if (!this.run || !this.active || this.polling) return;
    this.polling = true;
    const id = this.run.run_id;
    const readVersion = this.runReadVersion;
    try {
      const run = await this.api.run(id, this.controller.signal);
      if (!this.active || readVersion !== this.runReadVersion || this.run?.run_id !== id) return;
      if (run.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      if (this.run.state !== run.state || this.run.stage !== run.stage) this.reason = undefined;
      if (this.run.state !== run.state || this.run.stage !== run.stage) this.resumeVerified = false;
      this.run = run;
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
          this.events.push(event); this.events = this.events.slice(-12);
          if (event.payload.reason === 'user_resumed') this.pauseBeforeResume = this.lastPausedEvent;
          if (event.state === 'paused') {
            this.repeatedPauseEvent = this.pauseBeforeResume?.stage === event.stage &&
              this.pauseBeforeResume.payload.reason === event.payload.reason ? event : undefined;
            this.lastPausedEvent = event;
          }
          const reason = event.state === run.state && event.stage === run.stage
            ? event.payload.reason ?? event.payload.error_code : undefined;
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
      const reason = currentEvent?.payload.reason ?? currentEvent?.payload.error_code;
      if (this.reason !== reason) this.resumeVerified = false;
      this.reason = reason;
      this.progressMessage = '';
    } catch (error) {
      if (this.active && readVersion === this.runReadVersion) this.progressMessage = `任务状态暂未更新。${friendlyError(error)}`;
    } finally {
      this.polling = false; this.render();
      if (this.active && this.run && !['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'].includes(this.run.state)) {
        if (readVersion !== this.runReadVersion) {
          if (!this.restoring) void this.poll();
        } else this.timer = setTimeout(() => { void this.poll(); }, 5000);
      }
    }
  }
  dispose() { this.controller.abort(); clearTimeout(this.timer); this.delivery?.dispose(); }
}
