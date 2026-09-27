import { DOCUMENT_PURPOSES, MARKET_LABELS, OFFERING_LABELS, type RunState } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import type { Draft } from './draft';
import { date, esc } from './ui';
import './project-execution.css';

type Input = Dto<'InputRevisionResponse'>;
type Material = Dto<'MaterialResponse'>;
const purposes: Record<typeof DOCUMENT_PURPOSES[number], string> = { registration: '申报 / 注册文件', issuance: '本期发行文件' };
const states: Record<RunState, string> = {
  preparing: '准备中', rejected: '未启动', queued: '排队中', running: '处理中', awaiting_input: '待补充信息',
  paused: '任务已暂停', validating: '检查成果中', delivering: '交付中', settlement_pending: '结算处理中',
  succeeded: '已生成', test_completed: '内部测试工作稿', failed: '任务失败', cancelled: '已取消'
};
const stages: Record<string, string> = { input_lock: '核对输入与规则', materials_ready: '读取材料',
  model_generation: '生成全文内容', word_delivery: '生成并检查 Word', capability_not_ready: '等待处理条件',
  queued: '等待处理', completed: '处理完成' };

/** Presentation only: the server remains authoritative about readiness and run transitions. */
export function readinessMessage(reason: string): string {
  if (reason.includes('rule_applicability_overall_review_required')) return '等待规则适用性审核。';
  if (reason.startsWith('rule_pack:') || reason.startsWith('rule_applicability_')) return '等待适用规则核对或发布。';
  if (reason.startsWith('issuer_identity_') || reason.startsWith('issuer_material_')) return '发行人身份与历史材料的绑定尚需核对。';
  if (reason === 'material_versions') return '尚未选择已保存的材料。';
  if (reason.startsWith('material_parse_failed:')) return '有材料解析失败，请查看材料区。';
  if (reason.startsWith('material_parse_cancelled:')) return '有材料解析已取消，请查看材料区。';
  if (reason.startsWith('material_parse_')) return '等待材料解析完成。';
  if (reason.startsWith('ocr_')) return '等待文字识别或存疑数字核对。';
  if (reason.startsWith('source_profile_')) return '历史稿识别信息仍需确认。';
  if (reason.startsWith('material_needs_confirmation:')) return '材料存在待确认内容；不会作为已核实事实。';
  if (reason.startsWith('credit_facility_')) return '授信补充仍属用户提供，需核对日期、单位、口径或冲突。';
  if (reason.startsWith('update_difficulty_')) return '报告期与更新难度仍需核对。';
  if (reason.includes('provider_reconcil')) return '正在核对先前模型调用，暂不重复调用。';
  if (reason.includes('capability_not_ready')) return '所需处理能力尚未就绪。';
  if (reason === 'user_cancelled') return '用户已取消任务。';
  return '仍有待处理条件，请查看材料信息或联系支持。';
}

function targetSummary(target: Input['target_confirmation']): string {
  if (target.status !== 'confirmed') return '目标尚未确认';
  const periods = target.target_reporting_periods.map(p => `${p.start ?? '起始日待定'} 至 ${p.end ?? '截止日待定'}（${p.period_kind === 'annual' ? '年度' : p.period_kind === 'interim' ? '中期' : '期间类型待定'}，${p.scope === 'parent' ? '母公司' : p.scope === 'consolidated' ? '合并' : '口径待定'}，${p.status === 'needs_confirmation' ? '待确认' : '用户提供'}）`);
  return `${MARKET_LABELS[target.market]} · ${OFFERING_LABELS[target.offering]} · ${target.document_purpose ? purposes[target.document_purpose] : '文书用途待定'}；法规适用日：${target.as_of ?? '待确认'}；目标报告期：${periods.join('；') || '待补充'}`;
}

/** Stable across tabs/reloads; a new input revision is required for an intentional new run. */
async function executionRequest(input: Input): Promise<Dto<'ExecuteRequest'>> {
  const bytes = new TextEncoder().encode(JSON.stringify([input.project_id, input.input_revision, input.input_hash]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { execution_request_id: `web-update-${key}`, project_id: input.project_id, input_revision: input.input_revision,
    input_hash: input.input_hash, task_kind: 'update', storage_origin: 'cloud',
    input_manifest_ref: input.input_hash, workspace_id: input.project_id };
}

export class ProjectExecution {
  private controller = new AbortController();
  private host!: HTMLElement;
  private input?: Input;
  private selected = false;
  private savedCurrent = false;
  private preflight?: Dto<'PreflightResponse'>;
  private run?: Dto<'RunResponse'>;
  private latestArtifact?: string;
  private reason?: string;
  private eventCursor = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private busy = false;
  private inputReadUncertain = false;
  private message = '';
  private progressMessage = '';
  private materials: Material[] = [];
  private omitted = new Set<string>();
  private sourceStamp = '';
  private materialReady = false;
  private generation = 0;

  constructor(private api: ApiClient, private draft: Draft) {}
  private get active() { return !this.controller.signal.aborted; }
  private get id() { return this.draft.project.project_id; }
  mount(host: HTMLElement) {
    this.host = host;
    host.innerHTML = `<section class="panel execution-panel" aria-labelledby="execution-title"><h2 id="execution-title">保存版本与全文更新</h2>
      <p class="muted">保存版本会固定本次表单和所选材料。只有明确提交任务才开始全文处理；修改草稿、补材料不会覆盖旧任务或成果。</p>
      <div id="execution-target"></div><div id="execution-materials"></div>
      <form id="execution-form"><div class="execution-fields"><div><label for="execution-purpose">本次文书用途</label><select id="execution-purpose" name="document_purpose"><option value="">尚未确定</option>${DOCUMENT_PURPOSES.map(p => `<option value="${p}">${purposes[p]}</option>`).join('')}</select></div>
      <div><label for="execution-date">本次法规适用日</label><input id="execution-date" name="as_of" type="date" aria-describedby="execution-date-help"/></div></div>
      <p id="execution-date-help" class="muted">按本次申报或发行意图填写，未确定可留空；财务报告截止日不会自动代入。</p>
      <label class="execution-confirm"><input name="confirm_target" type="checkbox"/>确认以上目标为本次拟定安排；材料中的事实仍需核对</label>
      <button class="button secondary" type="submit" id="save-input">保存材料版本</button></form>
      <p id="execution-message" role="status"></p><div id="execution-snapshot"></div><div id="execution-preflight"></div>
      <div class="form-actions"><button class="button secondary" type="button" id="check-input" disabled>检查已保存版本</button><button class="button primary" type="button" id="execute-input" disabled>开始全文更新</button></div>
      <div id="execution-progress" aria-live="polite"></div><button class="text-button" type="button" id="refresh-execution">刷新版本与任务状态</button></section>`;
    this.host.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    this.host.querySelector('form')!.addEventListener('input', () => this.invalidate());
    this.host.querySelector('#execution-materials')!.addEventListener('change', event => {
      const box = event.target as HTMLInputElement;
      if (!box.dataset.material) return;
      box.checked ? this.omitted.delete(box.dataset.material) : this.omitted.add(box.dataset.material);
      this.invalidate();
    });
    this.host.querySelector('#check-input')!.addEventListener('click', () => { void this.check(); });
    this.host.querySelector('#execute-input')!.addEventListener('click', () => { void this.execute(); });
    this.host.querySelector('#refresh-execution')!.addEventListener('click', () => { void this.restore(); });
    this.sync([], false);
    void this.restore();
  }
  private invalidate() {
    this.generation++; this.selected = false; this.savedCurrent = false; this.preflight = undefined;
    this.render();
  }
  sync(materials: Material[], ready: boolean) {
    if (!this.active) return;
    const stamp = JSON.stringify([this.draft.fields, materials.map(m => [m.material_id, m.material_version]).sort()]);
    if (stamp !== this.sourceStamp || (this.materialReady && !ready)) {
      this.sourceStamp = stamp;
      this.host.querySelector<HTMLInputElement>('[name=confirm_target]')!.checked = false;
      this.invalidate();
    }
    this.materials = materials; this.materialReady = ready;
    const p = this.draft.fields;
    this.host.querySelector('#execution-target')!.textContent = `本次目标：${p.market ? MARKET_LABELS[p.market] : '市场待选'} · ${p.offering ? OFFERING_LABELS[p.offering] : '发行方式待选'}；目标报告期 ${p.update_details.target_reporting_periods?.length ?? 0} 组（见上方表单）。`;
    this.host.querySelector('#execution-materials')!.innerHTML = `<p>${ready ? '选择本次使用的已保存材料：' : '请先完成材料保存，并等待服务器记录读取完成。'}</p>${materials.map(m => `<label class="execution-confirm"><input type="checkbox" data-material="${esc(m.material_id)}" ${this.omitted.has(m.material_id) ? '' : 'checked'}/> ${esc(m.filename)} · 版本 ${m.material_version}</label>`).join('')}`;
    this.render();
  }
  private button(id: string) { return this.host.querySelector<HTMLButtonElement>(`#${id}`)!; }
  private render() {
    if (!this.active) return;
    const editable = !this.busy && this.draft.state === 'saved' && !this.draft.dirty;
    this.button('save-input').disabled = this.busy || this.savedCurrent || this.inputReadUncertain || !this.materialReady || !this.materials.length;
    this.button('check-input').disabled = !editable || !this.input || !this.selected;
    this.button('execute-input').disabled = !editable || !this.selected || !this.preflight;
    this.button('execute-input').textContent = this.preflight?.status === 'blocked' ? '提交任务并等待条件齐备' : '开始全文更新';
    this.button('refresh-execution').disabled = this.busy;
    this.host.querySelector('#execution-message')!.textContent = this.message;
    const input = this.input;
    this.host.querySelector('#execution-snapshot')!.innerHTML = input ? `<div class="execution-summary"><h3>已保存材料版本 ${input.input_revision}</h3><p>${esc(targetSummary(input.target_confirmation))}</p><p>固定 ${input.material_versions.length} 份材料 · ${esc(date(input.created_at))}</p><ul>${input.material_versions.map(ref => `<li>${esc(this.materials.find(m => m.material_id === ref.material_id)?.filename ?? '先前保存的材料')} · 版本 ${ref.material_version}</li>`).join('')}</ul>
      ${input.credit_facility_supplements?.length ? `<p>固定 ${input.credit_facility_supplements.length} 条授信补充版本（用户提供，仍需核对）；保存新版将沿用这些精确版本。</p>` : ''}<p class="muted">执行只使用此版本。上方后续修改不在其中；要采用新内容，请保存新版本。</p>${!this.selected ? '<button class="text-button" type="button" id="select-saved-input">使用这个已保存版本</button>' : ''}</div>` : '<p>尚未保存可执行的材料版本。</p>';
    const use = this.host.querySelector<HTMLButtonElement>('#select-saved-input');
    if (use) {
      use.disabled = !editable || this.inputReadUncertain;
      use.addEventListener('click', () => { this.selected = true; this.message = '已选用上面显示的固定版本；请先检查，再明确提交任务。'; this.render(); });
    }
    const check = this.preflight;
    this.host.querySelector('#execution-preflight')!.innerHTML = check ? `<div class="execution-summary"><h3>${check.status === 'blocked' ? '预检：仍有阻塞条件' : check.status === 'needs_confirmation' ? '预检：有待确认内容' : '预检：可提交'}</h3>
      <ul>${[...new Set([...check.missing_inputs, ...check.uncertainty].map(readinessMessage))].map(m => `<li>${esc(m)}</li>`).join('')}</ul>
      <p>${check.status === 'blocked' ? '提交后任务可能暂停等待，不代表条件已满足或已生成成果。' : '待核内容会保留明确标记；本次为平台承担成本的试用。'}</p></div>` : '';
    const run = this.run;
    const testCompleted = run?.state === 'test_completed' && run.channel === 'non_production_test';
    this.host.querySelector('#execution-progress')!.innerHTML = `${run ? `<div class="execution-summary"><h3>任务状态：${esc(states[run.state] ?? '等待处理')}</h3><p>使用材料版本 ${run.input_revision} · ${esc(date(run.updated_at))}</p>${run.stage && stages[run.stage] ? `<p>${esc(stages[run.stage])}</p>` : ''}${this.reason ? `<p>${esc(readinessMessage(this.reason))}</p>` : ''}${testCompleted ? '<p>仅供内部测试，仍有规则和内容待核，不可用于正式申报。</p>' : ''}<p class="muted">关闭页面不会取消任务，重新登录后可继续查看。</p>${(run.state === 'succeeded' || testCompleted) && run.artifact_id ? `<a class="button primary" href="#/artifacts/${encodeURIComponent(run.artifact_id)}">${testCompleted ? '查看测试工作稿' : '查看成果与下载'}</a>` : ''}</div>` : ''}
      ${this.latestArtifact && this.latestArtifact !== run?.artifact_id ? `<a class="text-button" href="#/artifacts/${encodeURIComponent(this.latestArtifact)}">查看此前成功成果</a>` : ''}<p>${esc(this.progressMessage)}</p>`;
  }
  private async action(work: () => Promise<void>) {
    if (this.busy || !this.active) return;
    this.busy = true; this.message = ''; this.render();
    try { await work(); }
    catch (error) { if (this.active) this.message = friendlyError(error); }
    finally { this.busy = false; this.render(); }
  }
  private async save() {
    await this.action(async () => {
      const form = this.host.querySelector<HTMLFormElement>('form')!;
      const data = new FormData(form);
      if (!data.has('confirm_target')) { this.message = '请先核对目标并勾选确认。'; return; }
      if (!this.materialReady || this.inputReadUncertain) return;
      const selected = this.materials.filter(m => !this.omitted.has(m.material_id));
      if (!selected.length) { this.message = '请选择至少一份已保存的材料。'; return; }
      const confirmedGeneration = this.generation;
      if (!await this.draft.save() || !this.active) { this.message = '项目修改尚未保存，请先处理上方保存提示。'; return; }
      if (confirmedGeneration !== this.generation) { this.message = '保存期间目标或材料有变化，请重新核对目标。'; return; }
      const p = this.draft.project;
      if (!p.market || !p.offering) { this.message = '请先在项目表单选择目标市场和发行方式。'; return; }
      const generation = this.generation;
      this.selected = false; this.preflight = undefined;
      let result: Input;
      try {
        result = await this.api.createInputRevision(this.id, { draft_revision: p.draft_revision,
          material_versions: selected.map(m => ({ material_id: m.material_id, material_version: m.material_version })), requirement_message_ids: [],
          ...(this.input?.credit_facility_supplements?.length ? { credit_facility_supplements: this.input.credit_facility_supplements } : {}),
          target_confirmation: { market: p.market, offering: p.offering,
            document_purpose: DOCUMENT_PURPOSES.find(purpose => purpose === data.get('document_purpose')) ?? null,
            as_of: String(data.get('as_of') || '') || null, target_reporting_periods: p.update_details?.target_reporting_periods ?? [] }
        }, this.controller.signal);
      } catch (error) {
        // This POST has no idempotency key. Never blindly replay after a lost response.
        if (!(error instanceof ApiError) || error.status >= 500) {
          this.inputReadUncertain = true;
          this.message = '保存结果尚未确认。请先刷新版本与任务状态，核对服务器记录后再继续。';
          return;
        }
        throw error;
      }
      if (!this.active) return;
      if (result.project_id !== this.id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.input = result;
      this.selected = generation === this.generation;
      this.savedCurrent = this.selected;
      this.message = this.selected ? '材料版本已保存；尚未提交任务。请检查已保存版本。' : '版本已保存，但期间输入有变化；请核对固定版本或保存新版。';
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
  private async execute() {
    if (!this.input || !this.preflight || !this.selected || this.draft.dirty) return;
    const input = this.input, generation = this.generation;
    await this.action(async () => {
      const request = await executionRequest(input);
      if (!this.active || generation !== this.generation) return;
      const run = await this.api.execute(request, this.controller.signal);
      if (!this.active) return;
      if (run.project_id !== this.id || run.input_revision !== input.input_revision || run.input_hash !== input.input_hash || run.execution_request_id !== request.execution_request_id) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.acceptRun(run); this.message = '任务已提交；重复提交此版本会返回同一任务。';
      void this.poll();
    });
  }
  private acceptRun(run: Dto<'RunResponse'>) {
    if (this.run?.run_id !== run.run_id) { this.eventCursor = 0; this.reason = undefined; }
    this.run = run;
  }
  private async restore() {
    await this.action(async () => {
      this.selected = false; this.preflight = undefined;
      const project = await this.api.project(this.id, this.controller.signal);
      const input = project.input_revision ? await this.api.inputRevision(this.id, project.input_revision, this.controller.signal) : undefined;
      if (!this.active) return;
      if (input && (input.project_id !== this.id || input.input_revision !== project.input_revision || input.input_hash !== project.input_hash)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.input = input; this.inputReadUncertain = false;
      this.message = input ? '已读取服务器保存版本；可选用该版本，或保存本次表单与材料的新版本。' : '';
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
    });
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
      if (this.run.state !== run.state) this.reason = undefined;
      this.run = run;
      // Read all new pages: a reconnect must not lose the actual pause/error reason.
      let cursor = this.eventCursor;
      for (;;) {
        const page = await this.api.runEvents(id, cursor, this.controller.signal);
        if (!this.active || this.run?.run_id !== id) return;
        for (const event of page.items) {
          if (event.run_id !== id || event.seq <= this.eventCursor) continue;
          this.eventCursor = event.seq;
          this.reason = event.state === run.state ? event.payload.reason : undefined;
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
  dispose() { this.controller.abort(); clearTimeout(this.timer); }
}
