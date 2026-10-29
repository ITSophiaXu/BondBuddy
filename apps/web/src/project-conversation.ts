import { validProjectMessageSetRef, type ProjectMessageSetRef } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { prototypeIcon as icon } from './prototype-design';
import type { ProjectCreate } from './form-model';
import { date, esc } from './ui';
import './project-conversation.css';

type Message = Dto<'ProjectMessage'>;
type Request = Dto<'ProjectMessageSaveRequest'>;
const sameRef = (a: ProjectMessageSetRef, b: ProjectMessageSetRef) =>
  a.version === b.version && a.content_sha256 === b.content_sha256 &&
  JSON.stringify(a.message_ids) === JSON.stringify(b.message_ids);
const invalid = () => new ApiError(0, 'DATA_UNAVAILABLE');
const readError = (error: unknown) => friendlyError(error, 'read');

/** The API is a save-only, owner-scoped user-message ledger, not an assistant conversation. */
export class ProjectConversation {
  private controller = new AbortController();
  private host!: HTMLElement;
  private items: Message[] = [];
  private ref?: ProjectMessageSetRef;
  private cursor: string | null = null;
  private loading = false;
  private saving = false;
  private status = '正在读取已保存补充要求…';
  private composer: string;
  private editingInitial = false;
  private edit?: { id: string; version: number };
  private pending?: Request;
  private history?: Message;
  private readGeneration = 0;
  private savedAwaitingRead = false;
  private savedComposer = '';
  private saveTimer?: ReturnType<typeof setTimeout>;
  private savePromise?: Promise<void>;
  private composing = false;
  private saveFailed = false;
  private rendering = false;
  private retryOnline = () => { if (this.hasUnsent) void this.flush(); };

  constructor(private api: ApiClient, private projectId: string, private onChange: () => void, initial = '', private saveInitialNote?: (text: string) => Promise<boolean>) {
    this.composer = initial;
  }
  private get dirty() { return this.composer.trim() !== this.savedComposer; }
  get hasUnsent() { return this.dirty || Boolean(this.pending || this.saving); }
  get hasMessages() { return Boolean(this.ref?.message_ids.length); }
  get ready() { return !!this.ref && !this.loading; }
  get blockReason() {
    if (this.saveFailed || this.pending && !this.saving) return '补充说明自动保存失败，内容已保留，请重试。';
    if (this.dirty && !this.composer.trim()) return '补充说明不能为空，请填写内容。';
    if (!this.ready) return '项目补充要求尚未读取，请在材料页末尾重新读取。';
    return '';
  }
  mount(host: HTMLElement, value: ProjectCreate) {
    this.host = host;
    this.render(value);
    host.addEventListener('input', event => {
      if ((event.target as HTMLElement).id !== 'project-message') return;
      this.composer = (event.target as HTMLTextAreaElement).value;
      this.status = '正在自动保存…';
      this.saveFailed = false;
      this.onChange();
      this.controls();
      this.scheduleSave();
    });
    host.addEventListener('compositionstart', () => { this.composing = true; clearTimeout(this.saveTimer); });
    host.addEventListener('compositionend', () => { this.composing = false; this.scheduleSave(); });
    host.addEventListener('focusout', event => { if ((event.target as HTMLElement).id === 'project-message' && !this.composing && !this.rendering) void this.flush(); });
    window.addEventListener('online', this.retryOnline);
    host.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.id === 'edit-initial-note' && !this.saving && !this.pending) {
        if (this.dirty && !window.confirm('替换尚未保存的说明？')) return;
        clearTimeout(this.saveTimer); this.edit = undefined; this.editingInitial = true; this.composer = this.host.dataset.legacy ?? ''; this.savedComposer = this.composer.trim(); this.status = ''; this.render(); this.onChange();
      } else if (button.id === 'send-project-message') void this.send();
      else if (button.id === 'reload-project-messages') void this.refresh();
      else if (button.id === 'more-project-messages') void this.more();
      else if (button.dataset.editMessage) this.selectEdit(button.dataset.editMessage);
      else if (button.id === 'new-project-message' && !this.hasUnsent) { this.edit = undefined; this.editingInitial = false; this.composer = ''; this.savedComposer = ''; this.status = ''; this.render(); this.host.querySelector<HTMLTextAreaElement>('#project-message')?.focus(); }
      else if (button.id === 'restore-message-request' && this.pending &&
        window.confirm('当前输入会被待确认请求的原文替换，以便按同一请求重试。是否继续？')) {
        this.composer = this.pending.body; this.render();
      }
      else if (button.dataset.messageVersion) void this.showVersion(button.dataset.messageVersion, Number(button.dataset.version));
      else if (button.id === 'close-message-history') { this.history = undefined; this.render(); }
    });
    void this.refresh();
  }
  private render(value?: ProjectCreate) {
    if (this.controller.signal.aborted) return;
    this.rendering = true;
    const active = this.host.querySelector<HTMLTextAreaElement>('#project-message');
    const selection = active && active === document.activeElement ? { start: active.selectionStart, end: active.selectionEnd } : undefined;
    const legacy = value?.update_details?.supplementary_notes ?? this.host.dataset.legacy ?? '';
    this.host.dataset.legacy = legacy;
    this.host.innerHTML = `<section class="panel project-cowork supplement-panel" aria-label="补充要求"><div class="cowork-heading">${icon('file')}<h2>募集书更新补充说明 <span class="optional">选填</span></h2></div>
      <div class="cowork-messages" aria-live="polite">${this.items.length ? this.items.filter(item => item.message_id !== this.edit?.id || item.message_version !== this.edit.version || this.saveFailed).map(item => `<article class="cowork-message" data-message-id="${esc(item.message_id)}"><p>${esc(item.body).replaceAll('\n', '<br>')}</p><small>已保存 · 版本 ${item.message_version} · ${esc(date(item.created_at))}</small><div class="cowork-message-actions"><button type="button" data-edit-message="${esc(item.message_id)}">修改</button>${item.message_version > 1 ? `<button type="button" data-message-version="${esc(item.message_id)}" data-version="${item.message_version - 1}">查看旧版本</button>` : ''}</div></article>`).join('') : `<p class="cowork-guidance">${this.loading ? '正在读取项目补充要求…' : this.ref ? '' : '补充要求尚未读取，请重试。'}</p>`}</div>
      ${this.cursor ? '<button id="more-project-messages" class="text-button" type="button">加载更多补充要求</button>' : ''}
      ${this.history ? `<section class="message-history" aria-label="补充要求历史版本"><h3>历史版本 ${this.history.message_version} · 用户提供（未核验）</h3><p>${esc(this.history.body).replaceAll('\n', '<br>')}</p><small>${esc(date(this.history.created_at))} · ${this.history.material_versions.length} 份精确材料引用</small><div class="cowork-message-actions">${this.history.message_version > 1 ? `<button type="button" data-message-version="${esc(this.history.message_id)}" data-version="${this.history.message_version - 1}">更早版本</button>` : ''}<button type="button" id="close-message-history">关闭</button></div></section>` : ''}
      ${legacy && !this.editingInitial ? `<article class="cowork-message cowork-initial"><p>${esc(legacy).replaceAll('\n', '<br>')}</p><small>已保存</small><div class="cowork-message-actions"><button id="edit-initial-note" type="button">修改创建时的补充说明</button></div></article>` : ''}
      <div class="cowork-composer"><textarea id="project-message" aria-label="补充募集书更新说明" maxlength="${this.editingInitial ? 6000 : 12000}" rows="3" placeholder="如有额外的募集书更新要求，可在此补充">${esc(this.composer)}</textarea><div class="supplement-footer"><div class="supplement-feedback"><p id="conversation-status" role="status"></p><button id="reload-project-messages" class="text-button" type="button">重新读取补充要求</button></div><div class="supplement-save-actions">${(this.edit || this.editingInitial) && !this.hasUnsent ? '<button class="text-button" id="new-project-message" type="button">添加另一条说明</button>' : ''}${this.pending ? '<button class="text-button" id="restore-message-request" type="button">恢复原请求以重试</button>' : ''}<button class="text-button" id="send-project-message" type="button" hidden>重试</button></div></div></div></section>`;
    this.controls();
    if (selection) { const field = this.host.querySelector<HTMLTextAreaElement>('#project-message')!; field.focus({ preventScroll: true }); field.setSelectionRange(selection.start, selection.end); }
    this.rendering = false;
  }
  setEditingVisible(visible: boolean) { if (this.host) this.host.hidden = !visible; }
  setContext(value: ProjectCreate) {
    if (!this.host?.isConnected) return;
    this.host.dataset.legacy = value.update_details!.supplementary_notes ?? '';
    const legacy = this.host.querySelector('.cowork-initial');
    if (legacy) legacy.querySelector('p')!.textContent = this.host.dataset.legacy;
  }
  private controls() {
    if (!this.host?.isConnected) return;
    const send = this.host.querySelector<HTMLButtonElement>('#send-project-message')!;
    const stale = this.ref && this.edit && this.items.find(item => item.message_id === this.edit?.id)?.message_version !== this.edit.version;
    send.hidden = !this.saveFailed;
    send.disabled = this.saving || this.loading || !!stale || !this.ref && !this.pending;
    send.textContent = '重试';
    this.host.querySelector('#conversation-status')!.textContent = stale ? '这条补充要求已有新版本。请重新选择最新版本后再编辑；原文仍保留在输入框。' : this.status;
    this.host.querySelector<HTMLTextAreaElement>('#project-message')!.disabled = false;
    this.host.querySelector<HTMLButtonElement>('#restore-message-request')?.toggleAttribute('disabled', this.saving);
    this.host.querySelector<HTMLButtonElement>('#restore-message-request')?.toggleAttribute('hidden', this.composer.trim() === this.pending?.body);
    this.host.querySelector<HTMLButtonElement>('#more-project-messages')?.toggleAttribute('disabled', this.loading);
    const reload = this.host.querySelector<HTMLButtonElement>('#reload-project-messages')!;
    reload.disabled = this.loading || this.saving;
    reload.hidden = !!this.ref && !this.pending && !this.items.length && !this.status.includes('失败');
  }
  private async page(cursor?: string) {
    const page = await this.api.projectMessages(this.projectId, cursor, this.controller.signal);
    if (page.conversation_id !== this.projectId || !validProjectMessageSetRef(page.project_message_set_ref) ||
        page.has_more !== Boolean(page.next_cursor) || page.items.some(item =>
          item.role !== 'user' || item.source_status !== 'user_asserted' || item.intent_status !== 'not_classified' || item.route !== 'save_only' ||
          !page.project_message_set_ref.message_ids.includes(item.message_id))) throw invalid();
    return page;
  }
  async refresh() {
    if (this.loading || this.saving || this.controller.signal.aborted) return;
    this.loading = true; this.controls();
    const generation = ++this.readGeneration;
    try {
      const result = await this.page();
      if (this.controller.signal.aborted || generation !== this.readGeneration) return;
      if (this.ref && !sameRef(this.ref, result.project_message_set_ref)) this.onChange();
      this.items = result.items; this.cursor = result.next_cursor;
      this.ref = result.project_message_set_ref;
      this.savedAwaitingRead = false;
      this.status = this.pending ? '自动保存未完成，内容已保留。' : this.dirty ? '正在自动保存…' : this.savedComposer ? '已自动保存' : '输入后自动保存';
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.ref = undefined; this.items = []; this.cursor = null;
      this.status = this.savedAwaitingRead
        ? `补充要求已保存，但列表读取失败：${readError(error)} 请重新读取；无需重复保存。`
        : `补充要求读取失败：${readError(error)} 请重新读取。`;
    } finally { if (!this.controller.signal.aborted) { this.loading = false; this.render(); this.onChange(); if (!this.saveFailed && !this.pending) this.scheduleSave(); } }
  }
  private async more() {
    if (!this.cursor || this.loading || !this.ref) return;
    const cursor = this.cursor, ref = this.ref;
    this.loading = true; this.controls();
    try {
      const page = await this.page(cursor);
      if (!sameRef(ref, page.project_message_set_ref) || page.items.some(item => this.items.some(previous => previous.message_id === item.message_id))) throw invalid();
      this.items.push(...page.items); this.cursor = page.next_cursor;
      this.status = `已读取 ${this.items.length} 条用户补充要求。`;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.loading = false; this.status = '补充要求列表已变化，正在重新读取第一页；输入框未改动。';
        await this.refresh(); return;
      }
      this.status = `加载更多失败：${readError(error)} 可重试。`;
    } finally { this.loading = false; this.render(); }
  }
  private selectEdit(id: string) {
    const message = this.items.find(item => item.message_id === id);
    if (!message || this.pending || this.saving) return;
    if (this.dirty && !window.confirm('当前尚未保存的文字会被这条补充要求的内容替换，是否继续？')) return;
    clearTimeout(this.saveTimer);
    this.editingInitial = false;
    this.edit = { id, version: message.message_version };
    this.composer = message.body; this.savedComposer = message.body.trim(); this.saveFailed = false; this.status = '修改后自动保存';
    this.onChange(); this.render();
    this.host.querySelector<HTMLTextAreaElement>('#project-message')?.focus();
  }
  private async showVersion(id: string, version: number) {
    try {
      const message = await this.api.projectMessageVersion(this.projectId, id, version, this.controller.signal);
      if (message.message_id !== id || message.message_version !== version || message.role !== 'user' ||
          message.source_status !== 'user_asserted' || message.intent_status !== 'not_classified' || message.route !== 'save_only') throw invalid();
      this.history = message; this.render();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.status = `旧版本读取失败：${readError(error)}`; this.controls();
    }
  }
  private scheduleSave() {
    clearTimeout(this.saveTimer);
    if (!this.dirty || this.composing || this.saveFailed || this.controller.signal.aborted) return;
    this.saveTimer = setTimeout(() => void this.flush(), 650);
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.saveTimer);
    if (this.composing) return false;
    if (this.savePromise) await this.savePromise;
    if (this.controller.signal.aborted || this.loading || !this.ref && !this.pending) return false;
    while (this.dirty || this.pending) {
      await this.send();
      if (this.saveFailed || this.loading || this.controller.signal.aborted) break;
      if (this.edit && this.items.find(item => item.message_id === this.edit?.id)?.message_version !== this.edit.version) break;
    }
    return !this.hasUnsent && !this.saveFailed;
  }
  private send(): Promise<void> {
    if (this.savePromise) return this.savePromise;
    const promise = this.persist(); this.savePromise = promise;
    void promise.finally(() => { if (this.savePromise === promise) this.savePromise = undefined; });
    return promise;
  }
  private async persist() {
    if (this.saving || this.loading || !this.ref && !this.pending || !this.dirty && !this.pending) return;
    if (!this.composer.trim() && !this.pending) { this.saveFailed = true; this.status = '补充说明不能为空，已保存的内容仍保留。'; this.controls(); return; }
    this.saveFailed = false;
    const sent = this.composer.trim();
    if (this.editingInitial && this.saveInitialNote) {
      this.saving = true; this.status = '正在保存补充说明…'; this.controls();
      try {
        if (await this.saveInitialNote(sent)) {
          this.host.dataset.legacy = sent; this.savedComposer = sent; this.status = '已自动保存';
        } else { this.saveFailed = true; this.status = '自动保存失败，内容已保留。'; }
      } catch { this.saveFailed = true; this.status = '自动保存失败，内容已保留。'; }
      finally { this.saving = false; this.render(); this.onChange(); if (!this.saveFailed) this.scheduleSave(); }
      return;
    }
    const stale = this.edit && this.items.find(item => item.message_id === this.edit?.id)?.message_version !== this.edit.version;
    if (stale) { this.controls(); return; }
    if (!this.pending) this.pending = {
      message_id: this.edit?.id ?? crypto.randomUUID(), submission_request_id: crypto.randomUUID(),
      expected_message_version: this.edit?.version ?? null, body: this.composer.trim(), material_versions: []
    };
    const request = this.pending;
    this.saving = true; this.status = '正在保存用户补充要求…'; this.controls(); this.onChange();
    try {
      const saved = await this.api.saveProjectMessage(this.projectId, request, this.controller.signal);
      if (saved.conversation_id !== this.projectId || saved.message_id !== request.message_id ||
          saved.message_version !== (request.expected_message_version ?? 0) + 1 ||
          !validProjectMessageSetRef(saved.project_message_set_ref) ||
          saved.is_current && !saved.project_message_set_ref.message_ids.includes(request.message_id) ||
          saved.role !== 'user' || saved.route !== 'save_only' ||
          saved.source_status !== 'user_asserted' || saved.intent_status !== 'not_classified') throw invalid();
      if (!saved.is_current) throw new ApiError(409, 'INPUT_REVISION_CONFLICT');
      this.ref = saved.project_message_set_ref;
      this.pending = undefined; this.edit = { id: saved.message_id, version: saved.message_version }; this.savedComposer = request.body;
      this.savedAwaitingRead = true;
      this.status = '已自动保存';
      this.onChange();
      this.saving = false;
      await this.refresh();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.saveFailed = true;
      if (error instanceof ApiError && error.status === 409) {
        this.pending = undefined;
        this.status = '补充要求版本或请求冲突。正在重新读取服务器版本；输入原文保留，不会覆盖。';
        this.saving = false; await this.refresh();
        if (this.ref) this.status = '服务器版本已重新读取；请检查差异，再选择最新补充要求修改。';
      } else {
        this.status = `保存结果尚未确认：${friendlyError(error, 'save')} 原文保留，可按同一请求重试。`;
      }
    } finally { this.saving = false; this.render(); this.onChange(); if (!this.saveFailed) this.scheduleSave(); }
  }
  async currentRef(): Promise<ProjectMessageSetRef> {
    if (!await this.flush()) throw new ApiError(409, 'INPUT_REVISION_CONFLICT');
    if (this.blockReason) throw new ApiError(409, 'INPUT_REVISION_CONFLICT');
    const page = await this.page();
    const ref = page.project_message_set_ref;
    if (!this.ref || !sameRef(this.ref, ref)) {
      this.items = page.items; this.cursor = page.next_cursor; this.ref = ref;
      this.status = '服务器补充要求列表已更新，请核对最新补充要求。';
      this.render(); this.onChange();
    }
    return ref;
  }
  dispose() { clearTimeout(this.saveTimer); window.removeEventListener('online', this.retryOnline); this.controller.abort(); this.readGeneration++; this.items = []; this.ref = undefined; this.pending = undefined; this.composer = ''; }
}
