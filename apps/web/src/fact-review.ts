import type { FactCandidate, FactDecisionRequest } from '@bondbuddy/contracts';
import { ApiError, type ApiClient, friendlyError } from './api.js';
import { esc, date } from './ui.js';

type FactApi = Pick<ApiClient, 'factCandidates' | 'decideFact'>;
type Choice = { resolution: 'selected'; candidateId: string } | { resolution: 'unresolved'; candidateId: null };
type Pending = { signature: string; requestId: string; decisionId: string };
type Draft = { choice: Choice | null; reason: string; pending?: Pending; submitting: boolean; conflict: boolean; message: string };
export type FactGroup = { hash: string; identity: FactCandidate['identity']; candidates: FactCandidate[]; latest: FactCandidate['latest_decision'] };

const sourceLabels = { audited: '审计或财务材料', user_statement: '用户陈述', external: '外部来源' };
const statusLabels = { extracted: '已抽取，待核对', verified: '已有核验记录', user_asserted: '用户提供，未核验',
  conflicted: '来源冲突', needs_confirmation: '待确认', superseded: '已被更新版本替代' };
const scopeLabels: Record<string, string> = { consolidated: '合并口径', parent: '母公司口径' };
const basisLabels: Record<string, string> = { audited: '审计口径', unaudited: '未经审计' };
const MAX_PAGES = 100;

function exactIdentity(identity: FactCandidate['identity']): string {
  return JSON.stringify([identity.account_id, identity.entity_id, identity.scope, identity.metric,
    identity.period.start, identity.period.end, identity.period.as_of, identity.currency, identity.unit,
    identity.basis, identity.data_version]);
}

/** Refuse a partial or inconsistent group rather than presenting one candidate as the whole choice. */
export function groupFactCandidates(items: readonly FactCandidate[]): FactGroup[] {
  const grouped = new Map<string, FactGroup>();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.candidate_id)) throw new Error('FACT_CANDIDATE_DUPLICATE');
    seen.add(item.candidate_id);
    const current = grouped.get(item.fact_key_hash);
    if (!current) {
      grouped.set(item.fact_key_hash, { hash: item.fact_key_hash, identity: item.identity,
        candidates: [item], latest: item.latest_decision });
      continue;
    }
    if (exactIdentity(current.identity) !== exactIdentity(item.identity) ||
      current.latest?.decision_id !== item.latest_decision?.decision_id) throw new Error('FACT_CANDIDATE_GROUP_INCONSISTENT');
    current.candidates.push(item);
  }
  return [...grouped.values()].sort((a, b) => a.identity.metric.localeCompare(b.identity.metric, 'zh') ||
    (a.identity.period.as_of ?? a.identity.period.end ?? '').localeCompare(b.identity.period.as_of ?? b.identity.period.end ?? '') || a.hash.localeCompare(b.hash));
}

export function decisionInput(identity: FactCandidate['identity'], choice: Choice, reason: string,
  ids: { requestId: string; decisionId: string }): FactDecisionRequest {
  const period = Object.fromEntries(Object.entries(identity.period).filter(([, value]) => value !== null));
  return { decision_id: ids.decisionId, request_id: ids.requestId,
    identity: { entity_id: identity.entity_id, scope: identity.scope, metric: identity.metric,
      period, currency: identity.currency, unit: identity.unit, basis: identity.basis, data_version: identity.data_version },
    resolution: choice.resolution, ...(choice.resolution === 'selected' ? { selected_candidate_id: choice.candidateId } : {}),
    reason };
}

function periodLabel(identity: FactCandidate['identity']): string {
  return identity.period.as_of ?? ([identity.period.start, identity.period.end].filter(Boolean).join(' 至 ') || '期间待确认');
}
function candidateValue(candidate: FactCandidate): string {
  return candidate.value_kind === 'unknown' ? '未知' : candidate.value_kind === 'not_applicable' ? '不适用' : candidate.value ?? '未提供数值';
}
function selectable(candidate: FactCandidate): boolean {
  return candidate.status !== 'superseded' && !['unknown', 'not_applicable'].includes(candidate.value_kind);
}
function anchor(evidence: FactCandidate['evidence'][number]): string {
  const ref = typeof evidence.locator.stable_ref === 'string' ? evidence.locator.stable_ref : JSON.stringify(evidence.locator);
  return `${evidence.locator_type} · ${ref}`;
}

function candidateCard(candidate: FactCandidate, group: FactGroup, draft: Draft): string {
  const allowed = selectable(candidate);
  const selected = draft.choice?.resolution === 'selected' && draft.choice.candidateId === candidate.candidate_id;
  const evidence = candidate.evidence.length ? candidate.evidence.map(item => `<li><p>${esc(anchor(item))}${item.ocr_source ? ` · 扫描第 ${item.ocr_source.page} 页` : ''}</p>
    <blockquote>${esc(item.literal_quote)}</blockquote>${item.uncertainty.length ? `<p class="fact-warning">证据疑点：${esc(item.uncertainty.join('；'))}</p>` : ''}</li>`).join('')
    : '<li>暂无可定位原文证据</li>';
  return `<article class="fact-candidate"><label class="fact-choice"><input type="radio" name="fact-choice-${group.hash}" data-fact-choice="${group.hash}" value="candidate:${esc(candidate.candidate_id)}" ${selected ? 'checked' : ''} ${allowed ? '' : 'disabled'}><span><strong>${esc(candidateValue(candidate))}</strong><small>${esc(sourceLabels[candidate.source_kind])} · ${esc(statusLabels[candidate.status])}</small></span></label>
    <p class="fact-meta">候选 ${esc(candidate.candidate_id)} · ${esc(candidate.source_ref)}${candidate.material_id ? ` · 材料 ${esc(candidate.material_id)} 第 ${candidate.material_version} 版` : ''}</p>
    ${candidate.uncertainty.length ? `<p class="fact-warning">待核对：${esc(candidate.uncertainty.join('；'))}</p>` : ''}
    ${allowed ? '' : '<p class="fact-warning">此候选不可直接选入更新稿；可选择“暂不解决”。</p>'}
    <details class="fact-evidence"><summary>查看原文证据（${candidate.evidence.length}）</summary><ul>${evidence}</ul></details></article>`;
}

function groupView(group: FactGroup, draft: Draft): string {
  const unresolved = draft.choice?.resolution === 'unresolved';
  const latest = group.latest ? `<p class="fact-latest">最新决定：第 ${group.latest.version} 版 · ${group.latest.resolution === 'selected' ? `选中 ${esc(group.latest.selected_candidate_id ?? '')}` : '暂不解决'} · ${esc(date(group.latest.created_at))}。${esc(group.latest.reason)}</p>`
    : '<p class="fact-latest">尚无冲突决定。</p>';
  return `<article class="fact-group"><div class="fact-group-head"><div><h3>${esc(group.identity.metric)} · ${esc(periodLabel(group.identity))}</h3><p>${esc(scopeLabels[group.identity.scope] ?? group.identity.scope)} · ${esc(group.identity.unit)}${group.identity.currency ? ` · ${esc(group.identity.currency)}` : ''} · ${esc(basisLabels[group.identity.basis] ?? group.identity.basis)} · 数据版本 ${esc(group.identity.data_version)}</p></div><span>${group.candidates.length} 个候选</span></div>
    <p class="fact-entity">主体 ID：${esc(group.identity.entity_id)}。请先对照原稿确认主体与报表口径。</p>${latest}
    <form data-fact-form="${group.hash}"><fieldset><legend>选择这组事实的处理方式</legend>
      <div class="fact-candidates">${group.candidates.map(candidate => candidateCard(candidate, group, draft)).join('')}</div>
      <label class="fact-unresolved"><input type="radio" name="fact-choice-${group.hash}" data-fact-choice="${group.hash}" value="unresolved" ${unresolved ? 'checked' : ''}>暂不解决，继续保留冲突或缺口</label>
      <label class="fact-reason" for="fact-reason-${group.hash}">决定原因<textarea id="fact-reason-${group.hash}" data-fact-reason="${group.hash}" maxlength="2000" rows="3" required>${esc(draft.reason)}</textarea></label>
      <p class="fact-note">选择候选只记录冲突决定，不会核验来源或把 OCR、用户陈述提升为审计事实。</p>
      <p class="fact-result" data-fact-message="${group.hash}" role="status">${esc(draft.message)}</p>
      <div class="fact-actions"><button class="button secondary" type="submit" data-fact-submit="${group.hash}" ${draft.submitting || draft.conflict || !draft.choice || !draft.reason.trim() ? 'disabled' : ''}>${draft.submitting ? '正在保存…' : '保存决定'}</button>${draft.conflict ? '<span class="fact-warning">请先刷新全部候选，再核对当前决定。</span>' : ''}</div>
    </fieldset></form></article>`;
}

export class FactReview {
  private root: HTMLElement | null = null;
  private controller = new AbortController();
  private groups: FactGroup[] = [];
  private drafts = new Map<string, Draft>();
  private loading = false;
  private loaded = false;
  private disposed = false;
  constructor(private api: FactApi, private projectId: string) {}

  mount(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `<section class="panel fact-review" aria-labelledby="fact-review-title"><div class="panel-heading fact-review-heading"><div><h2 id="fact-review-title">事实候选与冲突决定</h2><p class="muted">逐一核对同一事实的全部来源和原文位置。决定不会改变来源的核验状态。</p></div><button class="button secondary" type="button" data-fact-load>读取事实候选</button></div><p class="fact-load-status" data-fact-load-status role="status">按需读取当前项目的候选；材料尚未完成事实抽取时这里可能为空。</p><div class="fact-groups" data-fact-groups></div></section>`;
    root.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-fact-load]')) void this.load();
    });
    root.addEventListener('change', event => this.readForm(event));
    root.addEventListener('input', event => this.readForm(event));
    root.addEventListener('submit', event => {
      const target = event.target instanceof HTMLFormElement ? event.target : null;
      const hash = target?.dataset.factForm;
      if (!hash) return;
      event.preventDefault();
      void this.submit(hash);
    });
  }

  dispose() { this.disposed = true; this.controller.abort(); this.root = null; this.groups = []; this.drafts.clear(); }
  private status(text: string) { const status = this.root?.querySelector<HTMLElement>('[data-fact-load-status]'); if (status) status.textContent = text; }
  private draft(hash: string): Draft {
    let value = this.drafts.get(hash);
    if (!value) { value = { choice: null, reason: '', submitting: false, conflict: false, message: '' }; this.drafts.set(hash, value); }
    return value;
  }
  private renderGroups() {
    const target = this.root?.querySelector<HTMLElement>('[data-fact-groups]');
    if (!target) return;
    target.innerHTML = this.groups.length ? this.groups.map(group => groupView(group, this.draft(group.hash))).join('')
      : this.loaded ? '<p class="fact-empty">当前项目尚无事实候选。请先检查材料解析和事实抽取状态。</p>' : '';
  }

  async load() {
    if (this.disposed || this.loading) return;
    this.loading = true;
    this.loaded = false;
    const button = this.root?.querySelector<HTMLButtonElement>('[data-fact-load]');
    if (button) { button.disabled = true; button.textContent = '正在读取…'; }
    this.root?.querySelectorAll<HTMLButtonElement>('[data-fact-submit]').forEach(control => { control.disabled = true; });
    this.status('正在读取完整候选集合；完成前不能提交决定。');
    try {
      const items: FactCandidate[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
        const page = await this.api.factCandidates(this.projectId, cursor, this.controller.signal);
        items.push(...page.items);
        if (!page.has_more) {
          const groups = groupFactCandidates(items);
          if (this.disposed) return;
          this.groups = groups;
          this.loaded = true;
          for (const hash of [...this.drafts.keys()]) if (!groups.some(group => group.hash === hash)) this.drafts.delete(hash);
          for (const draft of this.drafts.values()) if (draft.conflict) { draft.conflict = false; draft.pending = undefined; draft.message = '候选已刷新。请核对最新决定后再次提交。'; }
          this.renderGroups();
          this.status(`已读取 ${items.length} 个候选、${groups.length} 组事实。决定前请核对来源和期间。`);
          return;
        }
        if (!page.next_cursor || cursors.has(page.next_cursor)) throw new Error('FACT_CANDIDATE_PAGINATION_INCOMPLETE');
        cursors.add(page.next_cursor);
        cursor = page.next_cursor;
      }
      throw new Error('FACT_CANDIDATE_PAGINATION_LIMIT');
    } catch (error) {
      if (this.disposed || this.controller.signal.aborted) return;
      this.status(error instanceof ApiError ? friendlyError(error) : '候选集合未完整读取，决定入口保持关闭。请稍后重新读取。');
    } finally {
      this.loading = false;
      if (button && !this.disposed) { button.disabled = false; button.textContent = this.loaded ? '刷新事实候选' : '重新读取事实候选'; }
    }
  }

  private readForm(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const hash = target.dataset.factChoice ?? target.dataset.factReason;
    if (!hash || !this.groups.some(group => group.hash === hash)) return;
    const draft = this.draft(hash);
    if (target instanceof HTMLInputElement && target.dataset.factChoice) {
      if (!target.checked) return;
      draft.choice = target.value === 'unresolved' ? { resolution: 'unresolved', candidateId: null }
        : { resolution: 'selected', candidateId: target.value.slice('candidate:'.length) };
    } else if (target instanceof HTMLTextAreaElement) draft.reason = target.value;
    draft.pending = undefined;
    const form = target.closest<HTMLFormElement>('form[data-fact-form]');
    const submit = form?.querySelector<HTMLButtonElement>('[data-fact-submit]');
    if (submit) submit.disabled = !this.loaded || draft.submitting || draft.conflict || !draft.choice || !draft.reason.trim();
  }

  private async submit(hash: string) {
    const group = this.groups.find(item => item.hash === hash);
    const draft = this.draft(hash);
    if (!group || this.disposed || this.loading || !this.loaded || draft.submitting || draft.conflict || !draft.choice || !draft.reason.trim()) return;
    if (draft.choice.resolution === 'selected' && !group.candidates.some(item => item.candidate_id === draft.choice?.candidateId && selectable(item))) return;
    const reason = draft.reason.trim();
    const signature = JSON.stringify([draft.choice, reason]);
    if (draft.pending?.signature !== signature) draft.pending = { signature, requestId: crypto.randomUUID(), decisionId: crypto.randomUUID() };
    const request = decisionInput(group.identity, draft.choice, reason, draft.pending);
    draft.submitting = true;
    const form = this.root?.querySelector<HTMLFormElement>(`[data-fact-form="${hash}"]`);
    const submit = form?.querySelector<HTMLButtonElement>('[data-fact-submit]');
    if (submit) { submit.disabled = true; submit.textContent = '正在保存…'; }
    this.message(hash, '正在保存决定…');
    try {
      const response = await this.api.decideFact(this.projectId, request, this.controller.signal);
      if (this.disposed) return;
      for (const candidate of group.candidates) candidate.latest_decision = {
        decision_id: response.decision_id, version: response.version, resolution: response.resolution,
        selected_candidate_id: response.selected_candidate_id, reason: response.reason, created_at: response.created_at,
      };
      group.latest = group.candidates[0]!.latest_decision;
      draft.choice = null; draft.reason = ''; draft.pending = undefined; draft.submitting = false;
      draft.message = `决定第 ${response.version} 版已保存；来源核验状态未改变。`;
      this.renderGroups();
    } catch (error) {
      if (this.disposed || this.controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409) {
        draft.conflict = true;
        draft.message = '决定未保存：候选或请求发生冲突。输入已保留，请刷新候选后核对。';
      } else draft.message = error instanceof ApiError ? friendlyError(error) : '保存结果未确认。输入已保留；重试会沿用同一请求 ID。';
      this.message(hash, draft.message);
    } finally {
      draft.submitting = false;
      if (submit && !this.disposed) { submit.disabled = !this.loaded || draft.conflict || !draft.choice || !draft.reason.trim(); submit.textContent = '保存决定'; }
    }
  }

  private message(hash: string, text: string) {
    const message = this.root?.querySelector<HTMLElement>(`[data-fact-message="${hash}"]`);
    if (message) message.textContent = text;
  }
}
