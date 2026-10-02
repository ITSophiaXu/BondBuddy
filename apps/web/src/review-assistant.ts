import { Value } from '@sinclair/typebox/value';
import { ReviewMessageRequestSchema, type ReviewContext, type ReviewMessageDraft, type ReviewMessageRequest, type ReviewProposal, type ReviewWorkspace } from '@bondbuddy/contracts';
import { ReviewApi } from './review-api';
import { ApiError, friendlyError } from './api';
import { contextKey, readDraftCache, saveDraftCache } from './review-state';
import { date, esc } from './ui';

export class ReviewAssistant {
  private host?: HTMLElement;
  private context: ReviewContext;
  private drafts = new Map<string, ReviewMessageDraft>();
  private dirty = new Set<string>();
  private conflicts = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<boolean>;
  private sending = false;
  private status = '';
  private workspace?: ReviewWorkspace;
  private pending?: ReviewMessageRequest;
  private pendingDraft?: { updated_at: string; version: number };
  private disposed = false;
  private readonly pendingKey: string;

  constructor(private api: ReviewApi, private owner: string, private refresh: () => Promise<void>, private acceptProposal: (proposal: ReviewProposal) => void) {
    this.context = { project_id: api.projectId, report_id: null, finding_ids: [], material_refs: [] };
    this.pendingKey = `bb-review-message-request:${owner}:${api.projectId}`;
    for (const draft of readDraftCache(localStorage, owner, api.projectId)) this.drafts.set(contextKey(draft.context), draft);
    try {
      const cached = JSON.parse(localStorage.getItem(this.pendingKey) ?? 'null');
      const pending: unknown = cached?.request ?? cached;
      if (Value.Check(ReviewMessageRequestSchema, pending) && pending.context.project_id === api.projectId) {
        this.pending = pending;
        if(typeof cached?.draft?.updated_at==='string'&&Number.isInteger(cached?.draft?.version))this.pendingDraft=cached.draft;
      }
    } catch { /* A failed browser cache never implies a saved message. */ }
    const latest = [...this.drafts.values()].filter(d => d.content.trim()).sort((a,b)=>b.updated_at.localeCompare(a.updated_at))[0];
    if (latest) this.context = structuredClone(latest.context);
    if (this.pending) this.context = structuredClone(this.pending.context);
  }

  get hasUnconfirmed() { return this.dirty.size > 0 || this.sending || Boolean(this.pending); }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.persistCache(); }
  mount(host: HTMLElement, workspace: ReviewWorkspace) {
    this.host = host;
    this.update(workspace);
    host.addEventListener('input', event => {
      if (!(event.target instanceof HTMLTextAreaElement) || event.target.id !== 'review-message-input') return;
      const key = contextKey(this.context), previous = this.current();
      this.drafts.set(key, { ...previous, content: event.target.value, updated_at: new Date().toISOString() });
      this.dirty.add(key); this.persistCache(); this.status = '草稿已保留，正在同步…'; this.updateStatus();
      clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, 500);
    });
    host.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-assistant-action]');
      if (!target) return;
      const action = target.dataset.assistantAction;
      if (action === 'send') void this.send();
      else if (action === 'retry-save') void this.flush();
      else if (action === 'project') this.focus({ project_id: this.api.projectId, report_id: null, finding_ids: [], material_refs: [] });
      else if (action === 'draft') {
        const saved = this.drafts.get(target.dataset.draftKey ?? '');
        if (saved) this.focus(saved.context);
      } else if (action === 'restore-pending' && this.pending) {
        void this.send(true);
      } else if (action === 'proposal') {
        const proposal = this.workspace?.messages.find(message => message.proposal?.proposal_id === target.dataset.proposalId)?.proposal;
        if (proposal) this.acceptProposal(structuredClone(proposal));
      }
    });
  }

  update(workspace: ReviewWorkspace) {
    this.workspace = workspace;
    for (const saved of workspace.message_drafts) {
      const key = contextKey(saved.context), local = this.drafts.get(key);
      if (!local) this.drafts.set(key, structuredClone(saved));
      else if (!this.dirty.has(key) && !this.saving) {
        if (local.content !== saved.content && local.content.trim() && local.version <= saved.version) {
          this.dirty.add(key);
          if (local.version < saved.version) this.conflicts.add(key);
        } else this.drafts.set(key, structuredClone(saved));
      }
    }
    for (const [key,draft] of this.drafts) if (!workspace.message_drafts.some(d=>contextKey(d.context)===key) && draft.content) this.dirty.add(key);
    this.persistCache(); this.render();
    if(!this.saving&&[...this.dirty].some(key=>!this.conflicts.has(key))){clearTimeout(this.timer);this.timer=setTimeout(()=>void this.flush(),500);}
  }

  focus(context: ReviewContext, initial = '') {
    if (context.project_id !== this.api.projectId) return;
    this.context = structuredClone(context);
    const key = contextKey(context);
    if (!this.drafts.has(key)) this.drafts.set(key, { context: structuredClone(context), content: initial, version: 0, updated_at: new Date().toISOString() });
    else if (initial && !this.current().content.trim()) this.drafts.set(key, { ...this.current(), content: initial, updated_at: new Date().toISOString() });
    if (initial) { this.dirty.add(key); this.persistCache(); clearTimeout(this.timer); this.timer = setTimeout(()=>void this.flush(),500); }
    this.status = this.pending ? '有一条发送结果尚未确认的说明，可恢复原请求重试。' : '不同问题的草稿分别保留，切换不会改变引用。';
    this.render(); this.host?.querySelector<HTMLTextAreaElement>('#review-message-input')?.focus({preventScroll:true});
  }

  private current(): ReviewMessageDraft {
    return this.drafts.get(contextKey(this.context)) ?? { context: structuredClone(this.context), content: '', version: 0, updated_at: new Date().toISOString() };
  }
  private persistCache() {
    if (!saveDraftCache(localStorage, this.owner, this.api.projectId, this.drafts.values())) this.status = '浏览器无法保存草稿，请保持页面打开直至服务器同步完成。';
  }
  private updateStatus() {
    const status = this.host?.querySelector<HTMLElement>('#review-assistant-status');
    if (status) status.textContent = this.status;
    const send = this.host?.querySelector<HTMLButtonElement>('[data-assistant-action="send"]');
    if (send) { send.disabled = this.sending || !this.current().content.trim(); send.textContent = this.sending ? '正在保存…' : '发送说明'; }
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    const saving = this.saveDrafts(); this.saving = saving;
    void saving.finally(() => { if (this.saving === saving) this.saving = undefined; });
    return saving;
  }
  private async saveDrafts(): Promise<boolean> {
    for (const key of [...this.dirty]) {
      if (this.disposed || this.conflicts.has(key)) continue;
      const sent = structuredClone(this.drafts.get(key)!);
      try {
        await this.api.saveDraft({ kind: 'message', expected_version: sent.version, context: sent.context, content: sent.content });
        const response = await this.api.drafts();
        const saved = response.message_drafts.find(d => contextKey(d.context) === key);
        if (!saved || saved.content !== sent.content) throw new ApiError(409, 'INPUT_REVISION_CONFLICT');
        const current = this.drafts.get(key)!;
        this.drafts.set(key, { ...current, version: saved.version });
        if (current.content === sent.content) this.dirty.delete(key);
        this.status = this.dirty.size ? '新的草稿修改等待同步。' : '草稿已同步；发送说明不会启动任务。';
      } catch (error) {
        if (this.disposed) return false;
        if (error instanceof ApiError && error.status === 409) {
          this.conflicts.add(key); this.status = '另一个页面修改了这条草稿。本页内容与原引用已保留；可将本页说明发送为新消息，不会覆盖原消息。';
        } else this.status = `${friendlyError(error)} 本页草稿已保留，可重试同步。`;
        this.persistCache(); this.updateStatus(); return false;
      }
    }
    this.persistCache(); this.updateStatus();
    if (this.dirty.size && !this.disposed && [...this.dirty].some(key=>!this.conflicts.has(key))) this.timer = setTimeout(()=>void this.flush(),500);
    return this.dirty.size === 0;
  }

  private async send(retryPending=false) {
    if (this.sending || !(retryPending?this.pending?.content:this.current().content.trim())) return;
    const original=structuredClone(this.current());
    const content = retryPending?this.pending!.content:original.content.trim(), context = structuredClone(retryPending?this.pending!.context:this.context);
    if (this.pending && (this.pending.content !== content || contextKey(this.pending.context) !== contextKey(context))) {
      this.status = '先恢复并重试尚未确认的原请求，再发送新说明；各问题草稿均已保留。'; this.render(); return;
    }
    this.sending = true; this.updateStatus();
    if(!this.pending){
      await this.flush();
      const saved=this.drafts.get(contextKey(context));
      this.pendingDraft={updated_at:original.updated_at,version:saved?.version??original.version};
    }
    if(this.disposed){this.sending=false;return;}
    const request = this.pending ?? { submission_request_id: crypto.randomUUID(), content, context };
    const sentDraft=this.pendingDraft;
    this.pending = request;
    try { localStorage.setItem(this.pendingKey, JSON.stringify({request,draft:sentDraft})); } catch { this.status = '浏览器无法保留重试凭据，请勿关闭页面。'; }
    try {
      const { message } = await this.api.send(request);
      if (message.context.project_id !== this.api.projectId || message.role !== 'user' || message.content !== request.content || contextKey(message.context) !== contextKey(request.context)) throw new ApiError(0, 'DATA_UNAVAILABLE');
      this.pending = undefined;
      this.pendingDraft = undefined;
      try { localStorage.removeItem(this.pendingKey); } catch { /* Server acknowledgement is authoritative. */ }
      const key = contextKey(request.context), draft = this.drafts.get(key);
      if (draft?.content.trim() === request.content && sentDraft?.updated_at===draft.updated_at) {
        this.drafts.set(key,{ ...draft, content:'', updated_at:new Date().toISOString() }); this.dirty.delete(key); this.conflicts.delete(key); this.persistCache();
        // Clear only the exact draft sent, never a newer draft written by another tab.
        const saved = (await this.api.drafts()).message_drafts.find(d=>contextKey(d.context)===key);
        if (saved && saved.version===sentDraft.version && saved.content.trim() === request.content) {
          await this.api.saveDraft({kind:'message',expected_version:saved.version,context:saved.context,content:''});
          const cleared = (await this.api.drafts()).message_drafts.find(d=>contextKey(d.context)===key);
          if (cleared && !this.drafts.get(key)?.content) this.drafts.set(key,cleared);
        }
      }
      this.status = '消息已保存；下轮可参考这段讨论，执行范围仍需确认。'; this.persistCache(); await this.refresh();
    } catch (error) {
      if (!this.disposed) this.status = this.pending ? `${friendlyError(error)} 原请求已保留，再次发送会沿用同一请求。` : '消息已保存，草稿或回复状态尚未同步，请重新读取项目；不要重复发送。';
    } finally { this.sending = false; if (!this.disposed) this.render(); }
  }

  private render() {
    if (!this.host || this.disposed) return;
    const textarea = this.host.querySelector<HTMLTextAreaElement>('#review-message-input');
    const focused = textarea === document.activeElement;
    const selection = focused ? [textarea!.selectionStart,textarea!.selectionEnd] : undefined;
    const chat=this.host.querySelector<HTMLElement>('.review-chat');
    const scroll=chat?{top:chat.scrollTop,bottom:chat.scrollHeight-chat.scrollTop-chat.clientHeight<32}:undefined;
    const context = this.context, draft = this.current();
    const otherDrafts = [...this.drafts.entries()].filter(([key,d])=>key!==contextKey(context)&&d.content.trim());
    this.host.innerHTML = `<div class="review-agent-header"><span class="review-agent-icon" aria-hidden="true">✦</span><div><h2 id="review-agent-title">项目助手</h2><p>补充背景 · 澄清口径 · 讨论异议</p></div><button class="review-agent-close" data-review-action="close-agent" aria-label="收起项目助手">×</button></div><p class="review-agent-purpose">常规处理直接在复核结果中完成。有特殊情况或不同意见，再补充说明。</p><div class="review-agent-context"><span class="review-tag">${context.report_id ? `${esc(context.report_id)}${context.finding_ids.length ? ` · ${context.finding_ids.map(esc).join('、')}` : ''}` : '项目级说明'}</span>${context.material_refs.length ? `<span>${context.material_refs.length} 份材料引用</span>` : ''}<button class="text-btn" data-assistant-action="project">项目级说明</button></div>
      <div class="review-chat" role="log" aria-label="项目对话" aria-live="polite">${this.workspace?.messages.length ? this.workspace.messages.map(message=>`<article class="review-message ${message.role}"><header>${message.role==='user'?'你':'项目助手'} · ${esc(date(message.created_at))}</header><p>${esc(message.content)}</p><small>${message.context.report_id ? `${esc(message.context.report_id)} · ${message.context.finding_ids.map(esc).join('、') || '报告说明'}` : '项目级说明'}</small>${message.role==='user'&&['queued','running'].includes(message.reply_status)?'<small role="status">说明已保存，等待助手回复…</small>':''}${['failed','unknown'].includes(message.reply_status)?`<p class="review-warning">${message.error ? esc(message.error) : '助手回复未完成。说明已保存，任务未启动。'}</p>`:''}${message.proposal?`<div class="review-proposal"><p><strong>待核对的修订提议</strong><br>${esc(message.proposal.explanation)}<br>${message.proposal.finding_ids.map(esc).join('、')}</p><button class="btn secondary small" data-assistant-action="proposal" data-proposal-id="${esc(message.proposal.proposal_id)}">查看并采纳计划</button><small>采纳仅调整计划，执行仍需单独点击。</small></div>`:''}</article>`).join(''):'<p class="review-muted">在这里补充业务口径、解释材料或讨论某项结果。发送说明不会直接执行任务。</p>'}</div>
      <div class="review-composer">${otherDrafts.length?`<details><summary class="review-muted">另有 ${otherDrafts.length} 份未发送草稿</summary>${otherDrafts.map(([key,d])=>`<button class="text-btn" data-assistant-action="draft" data-draft-key="${esc(key)}">继续 ${esc(d.context.report_id??'项目')} ${d.context.finding_ids.map(esc).join('、')} 的草稿</button>`).join('')}</details>`:''}<label for="review-message-input">${context.finding_ids.length?'补充此项说明':'补充项目说明'}</label><textarea id="review-message-input" maxlength="12000" rows="4" placeholder="例如：旧名称属于历史沿革，请保留当时名称。">${esc(draft.content)}</textarea><div class="review-composer-actions"><span class="review-muted">保存说明 · 不自动执行</span><button class="btn primary small" data-assistant-action="send">发送说明</button></div><p id="review-assistant-status" class="review-status" role="status">${esc(this.status)}</p>${this.pending?'<button class="text-btn" data-assistant-action="restore-pending">重试待确认原请求</button>':''}${this.dirty.size?'<button class="text-btn" data-assistant-action="retry-save">重试同步草稿</button>':''}</div>`;
    this.updateStatus();
    if (focused && selection) { const next=this.host.querySelector<HTMLTextAreaElement>('#review-message-input')!; next.focus({preventScroll:true});next.setSelectionRange(selection[0],selection[1]); }
    const nextChat=this.host.querySelector<HTMLElement>('.review-chat');if(nextChat&&scroll)nextChat.scrollTop=scroll.bottom?nextChat.scrollHeight:scroll.top;
  }
}
