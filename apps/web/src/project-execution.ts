import { ArtifactPage } from './artifact-page';
import { prototypeIcon as icon } from './prototype-design';
import { type RunState, type RUN_PAUSE_STAGES, type RUN_RUNTIME_REASONS, type ProjectMessageSetRef } from '@bondbuddy/contracts';
import { ApiClient, ApiError, errorReference, friendlyError, type Dto } from './api';
import type { Draft } from './draft';
import { executionRequest, executionTaskKind, type ExecutionTaskKind } from './execution-request';
import { referencePin, selectedReference, type ReferenceSnapshotResolver, type UserReferenceChoice } from './reference';
import type { ProjectConversation } from './project-conversation';
import { date, esc } from './ui';
import './project-execution.css';

type Input = Dto<'InputRevisionResponse'>;
type Material = Dto<'MaterialResponse'>;
const states: Record<RunState, string> = {
  preparing: '准备中', rejected: '未启动', queued: '排队中', running: '处理中', awaiting_input: '待补充信息',
  paused: '任务已暂停', validating: '检查成果中', delivering: '交付中', settlement_pending: '结算处理中',
  succeeded: '已生成', test_completed: '内部测试工作稿', failed: '任务失败', cancelled: '已取消'
};
const stages: Record<string, string> = { input_lock: '核对输入与规则', materials_ready: '读取材料',
  model_generation: '生成全文内容', word_delivery: '生成并检查 Word', capability_not_ready: '等待处理条件',
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
  if (reason.startsWith('user_reference_') || reason.startsWith('reference_selection_') || reason === 'reference_structure_unavailable') return readinessMessage(reason);
  return pendingConditions;
}

export function executionInputError(error: unknown, hasHistorical: boolean | null, materials: readonly Material[]): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'INPUT_REQUIRED' || error.status !== 409) return undefined;
  const reference = errorReference(error);
  if (hasHistorical === true && !materials.some(material => material.role === 'historical'))
    return `本项目选择了有历史稿，但尚未添加本发行人历史募集书。请在历史稿分区添加对应文件。${reference}`;
  if (hasHistorical === true && !materials.some(material => ['audit', 'financial', 'interimFinancial', 'notes'].includes(material.role)))
    return `本项目还没有已保存的审计报告或财务报表，请在现有财务材料分区添加。${reference}`;
  if (hasHistorical === false && materials.some(material => material.role === 'reference') &&
      materials.some(material => ['audit', 'financial', 'interimFinancial', 'notes'].includes(material.role)))
    return `无本发行人历史稿、已有相似稿及财务材料，但当前新稿入口未能处理这组输入。请保留材料并联系支持，不要把相似稿改作本发行人历史稿。${reference}`;
  return undefined;
}

/** Presentation only: the server remains authoritative about readiness and run transitions. */
export function readinessMessage(reason: string): string {
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

  constructor(private api: ApiClient, private draft: Draft, private conversation: ProjectConversation, private referenceSnapshots?: ReferenceSnapshotResolver) {}
  private get active() { return !this.controller.signal.aborted; }
  private get id() { return this.draft.project.project_id; }
  /** The persisted project kind decides the execution task kind; it is fixed at creation. */
  private get taskKind(): ExecutionTaskKind { return executionTaskKind(this.draft.project.kind); }
  mount(host: HTMLElement, actions: HTMLElement) {
    this.host = host; this.actions = actions;
    host.innerHTML = '<section class="panel execution-panel" id="run-panel" hidden><div id="execution-progress" aria-live="polite"></div></section><div id="execution-delivery" class="embedded-artifact"></div>';
    actions.innerHTML = `<div id="execution-preflight" hidden></div><p id="execution-message" role="status"></p><p id="start-disabled-reason" role="status"></p><div class="start-buttons"><button class="text-button" type="button" id="refresh-execution" hidden>重新读取</button><button class="text-button" type="button" id="select-saved-input" hidden>继续上次提交</button><button class="text-button" type="button" id="recheck-input" hidden>重新检查处理条件</button><button class="btn primary" type="button" id="execute-input" aria-describedby="start-disabled-reason execution-message">开始更新 ${icon('arrow')}</button></div>`;
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
            this.message = '已有已保存消息，不能继续未证明包含这些消息的旧输入；请重新开始以锁定新版本。';
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
  }
  private node(selector: string) { return this.host.querySelector<HTMLElement>(selector) ?? this.actions.querySelector<HTMLElement>(selector)!; }
  private eligibleMaterials() {
    const historical = this.draft.fields.update_details.has_historical;
    return this.materials.filter(m => m.role === 'historical' ? historical !== false : m.role === 'reference' ? historical !== true : true);
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
    if (this.conversation.blockReason) return this.conversation.blockReason;
    return '';
  }
  private invalidate() {
    this.generation++; this.selected = false; this.selectedMessages = undefined; this.preflight = undefined;
    this.resumeVerified = false;
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
    const blocked = this.startBlockReason();
    this.button('execute-input').disabled = Boolean(blocked);
    this.button('execute-input').textContent = this.busy || this.starting ? (this.restoring ? '开始更新' : '正在提交…') : this.nextRequested ? '生成新版' : '开始更新';
    this.node('#start-disabled-reason').textContent = blocked;
    this.node('#execution-message').textContent = this.message;
    this.button('refresh-execution').disabled = this.busy || this.starting;
    this.button('refresh-execution').hidden = !this.inputReadUncertain && !this.run && !this.progressMessage;
    this.button('select-saved-input').hidden = !this.offerSavedInput || this.inputReadUncertain || !this.conversation.ready || this.conversation.hasMessages;
    this.button('select-saved-input').disabled = Boolean(blocked);
    const check = this.preflight;
    this.node('#execution-preflight').hidden = !check || check.status !== 'blocked' || Boolean(activeRun);
    this.node('#execution-preflight').textContent = check?.status === 'blocked' && !activeRun ? blockedMessage(check) : '';
    this.button('recheck-input').hidden = !check || check.status !== 'blocked' || Boolean(activeRun);
    this.button('recheck-input').disabled = this.busy || this.starting || !this.selected || this.inputReadUncertain;
    const run = this.run;
    this.node('#run-panel').hidden = !run;
    const progressHost = document.querySelector('#workspace-progress');
    if (run && progressHost && this.host.parentElement !== progressHost) progressHost.append(this.host);
    if (run && this.materialRun !== run.run_id) { const details = document.querySelector<HTMLDetailsElement>('#project-materials-details'); if (details) { details.classList.add('has-run'); details.open = false; } this.materialRun = run.run_id; }
    const testCompleted = run?.state === 'test_completed' && run.channel === 'non_production_test';
    const automaticPause = automaticPauseMessage(run);
    const repeatedPause = run?.state === 'paused' && this.samePauseAfterResume(run);
    // The current run stage is authoritative even when event history is late or unavailable.
    const summary = automaticPause
      ? (this.reason !== 'trial_limit_cleared' && runtimeMessage(this.reason)) || automaticPause
      : repeatedPause ? '任务再次停在相同条件，重复继续不会推进。请联系支持核对恢复条件。'
      : this.reason ? readinessMessage(this.reason)
        : run?.state === 'paused' ? run.stage === 'awaiting_materials'
          ? '等待材料处理完成，条件满足后后台会继续。'
          : run.stage === 'provider_reconcile' ? '正在核对先前模型调用，请联系支持处理。'
          : '处理条件尚未就绪，请联系支持核对。' : undefined;
    this.host.querySelector('#execution-progress')!.innerHTML = `${run ? `<div class="run-status-card"><div class="eyebrow">募集书全文更新</div><h2>任务状态：${esc(states[run.state] ?? '等待处理')}</h2><p class="muted">使用材料版本 ${run.input_revision} · ${esc(date(run.updated_at))}</p>${run.stage && stages[run.stage] ? `<h3>${esc(stages[run.stage])}</h3>` : ''}${summary ? `<div class="execution-summary">${esc(summary)}</div>` : ''}${testCompleted ? '<p>仅供内部测试，仍有规则和内容待核，不可用于正式申报。</p>' : ''}
      ${this.events.length ? `<ol class="execution-events">${this.events.slice(-6).map(event => `<li><time>${esc(date(event.occurred_at))}</time><span>${esc(stages[event.stage ?? ''] ?? states[event.state])}${event.payload.completed_items !== undefined ? ` · 已处理 ${event.payload.completed_items}${event.payload.total_items != null ? ` / ${event.payload.total_items}` : ''} 项` : ''}</span></li>`).join('')}</ol>` : ''}
      <p class="muted">关闭页面不会取消任务。补材料或修改要求用于下一轮，旧成果仍会保留。</p>
      <div class="form-actions">${activeRun && run.state !== 'paused' ? '<button class="button secondary" type="button" id="cancel-run">停止更新</button>' : run.state === 'paused' && run.stage === 'capability_not_ready' && !repeatedPause
        ? this.resumeVerified ? '<button class="button secondary" type="button" id="resume-run">继续更新</button>'
          : '<button class="text-button" type="button" id="recheck-paused">重新检查处理条件</button>' : ''}${!activeRun ? '<button class="button secondary" type="button" id="prepare-next-version">继续修改</button>' : ''}<button class="text-button" type="button" id="show-project-materials">查看与补充材料</button></div></div>` : ''}
      ${this.latestArtifact && this.latestArtifact !== run?.artifact_id ? `<a class="text-button" href="#/artifacts/${encodeURIComponent(this.latestArtifact)}">查看此前成功成果</a>` : ''}<p>${esc(this.progressMessage)}</p>`;
    for (const [id, action] of [['cancel-run','cancel'],['resume-run','resume']] as const) {
      const button = this.host.querySelector<HTMLButtonElement>(`#${id}`);
      if (button) { button.disabled = this.busy; button.addEventListener('click', () => { void this.changeRun(action); }); }
    }
    const recheckPaused = this.host.querySelector<HTMLButtonElement>('#recheck-paused');
    if (recheckPaused) { recheckPaused.disabled = this.busy; recheckPaused.addEventListener('click', () => { void this.recheckPaused(); }); }
    this.host.querySelector('#prepare-next-version')?.addEventListener('click', () => { this.nextRequested = true; this.invalidate(); this.actions.scrollIntoView({block:'center'}); });
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
      await this.execute();
    } finally { this.starting = false; this.render(); }
  }
  private async changeRun(action: 'cancel' | 'resume') {
    if (!this.run || action === 'resume' && (!this.resumeVerified || this.run.stage !== 'capability_not_ready')) return;
    const runId = this.run.run_id;
    if (action === 'resume') this.resumeVerified = false;
    await this.action(async () => {
      const run = await this.api.runAction(runId, action, this.controller.signal);
      if (!this.active) return;
      if (run.run_id !== runId || run.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      if (action === 'resume') this.resumedPause = { runId, stage: this.run?.stage ?? null, reason: this.reason };
      this.acceptRun(run); void this.poll();
    });
  }

  private async action(work: () => Promise<void>, operation: 'execute' | 'other' = 'other') {
    if (this.busy || !this.active) return;
    this.busy = true; this.message = ''; this.render();
    try { await work(); }
    catch (error) {
      if (this.active) {
        const inputMessage = operation === 'execute'
          ? executionInputError(error, this.draft.fields.update_details.has_historical, this.eligibleMaterials()) : undefined;
        this.inputRejected = Boolean(inputMessage);
        this.message = inputMessage ??
          (error instanceof ApiError && error.code === 'CAPABILITY_NOT_READY'
            ? `当前环境尚未开放全文更新，请联系支持。${errorReference(error)}` : friendlyError(error));
      }
    }
    finally { this.busy = false; this.render(); }
  }
  private async save() {
    await this.action(async () => {
      if (!this.materialReady || this.inputReadUncertain) return;
      const selected = this.eligibleMaterials();
      if (!selected.length) { this.message = '请先添加本次需要的项目材料。'; return; }
      const confirmedGeneration = this.generation;
      if (!await this.draft.save() || !this.active) { this.message = '项目修改尚未保存，请先处理上方保存提示。'; return; }
      if (confirmedGeneration !== this.generation) { this.message = '保存期间目标或材料有变化，请重新核对目标。'; return; }
      const p = this.draft.project;
      if (!p.market || !p.offering) { this.message = '请先在项目表单选择目标市场和发行方式。'; return; }
      const beforeMessages = this.generation;
      const messages = await this.conversation.currentRef();
      if (beforeMessages !== this.generation) { this.message = '消息列表已变化，请核对最新内容后再次开始。'; return; }
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
    });
  }
  private async recheck() {
    if (!this.input || !this.selected || this.preflight?.status !== 'blocked') return;
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
        this.invalidate(); this.message = '已保存的项目消息有变化，请核对后重新开始，新消息不会写入旧任务。'; return;
      }
      const request = await executionRequest(input, this.taskKind);
      if (!this.active || generation !== this.generation) return;
      const run = await this.api.execute(request, this.controller.signal);
      if (!this.active) return;
      if (run.project_id !== this.id || run.input_revision !== input.input_revision || run.input_hash !== input.input_hash || run.execution_request_id !== request.execution_request_id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.acceptRun(run); this.message = '任务已提交；重复提交此版本会返回同一任务。';
      void this.poll();
    }, 'execute');
  }
  private acceptRun(run: Dto<'RunResponse'>) {
    if (this.run?.state === 'succeeded' && this.run.artifact_id) this.latestArtifact = this.run.artifact_id;
    if (this.run?.state !== run.state || this.run?.stage !== run.stage) this.reason = undefined;
    if (this.run?.run_id !== run.run_id) {
      this.eventCursor = 0; this.reason = undefined; this.events = [];
      this.lastPausedEvent = undefined; this.pauseBeforeResume = undefined; this.repeatedPauseEvent = undefined;
    }
    if (this.run?.run_id !== run.run_id) this.resumedPause = undefined;
    if (this.run?.run_id !== run.run_id || this.run?.state !== run.state || this.run?.stage !== run.stage) this.resumeVerified = false;
    this.run = run; this.nextRequested = false;
  }
  private async restore() {
    if (this.busy) return;
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
      this.message = '';
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
      this.offerSavedInput = Boolean(input && !this.run);
    });
    this.restoring = false; this.render();
  }
  private async poll() {
    clearTimeout(this.timer);
    if (!this.run || !this.active || this.polling) return;
    this.polling = true;
    const id = this.run.run_id;
    try {
      const run = await this.api.run(id, this.controller.signal);
      if (!this.active || this.run?.run_id !== id) return;
      if (run.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      if (this.run.state !== run.state || this.run.stage !== run.stage) this.reason = undefined;
      if (this.run.state !== run.state || this.run.stage !== run.stage) this.resumeVerified = false;
      this.run = run;
      // Read all new pages: a reconnect must not lose the actual pause/error reason.
      let cursor = this.eventCursor;
      for (;;) {
        const page = await this.api.runEvents(id, cursor, this.controller.signal);
        if (!this.active || this.run?.run_id !== id) return;
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
      this.progressMessage = '';
    } catch (error) {
      if (this.active) this.progressMessage = `任务状态暂未更新。${friendlyError(error)}`;
    } finally {
      this.polling = false; this.render();
      if (this.active && this.run && !['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'].includes(this.run.state))
        this.timer = setTimeout(() => { void this.poll(); }, 5000);
    }
  }
  dispose() { this.controller.abort(); clearTimeout(this.timer); this.delivery?.dispose(); }
}
