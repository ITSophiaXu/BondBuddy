import { validProjectMessageSetRef, type ProjectMessageSetRef, MARKET_LABELS, OFFERING_LABELS } from '@bondbuddy/contracts';
import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { prototypeIcon as icon } from './prototype-design';
import type { ProjectCreate } from './form-model';
import { date, esc } from './ui';
import './project-conversation.css';

type Message = Dto<'ProjectMessage'>;
type Request = Dto<'ProjectMessageSaveRequest'>;
const prompts: Record<string, string> = {
  '授信情况': '请补充授信截至日、总额度、已使用和未使用额度，以及金额单位与依据。',
  '修改要求': '请说明希望调整的内容、原因和可参考的材料。',
  '补充信息': '可补充本次项目的业务变化、机构安排或其他已知情况。'
};
const sameRef = (a: ProjectMessageSetRef, b: ProjectMessageSetRef) =>
  a.version === b.version && a.content_sha256 === b.content_sha256 &&
  JSON.stringify(a.message_ids) === JSON.stringify(b.message_ids);
const invalid = () => new ApiError(0, 'DATA_UNAVAILABLE');
const readError = (error: unknown) => error instanceof ApiError ? friendlyError(error) : '连接中断，请检查网络后重试。';

export function newProjectConversation(value: ProjectCreate, text = '') {
  return `<aside class="panel project-cowork supplement-panel" aria-label="项目协作">
    <div class="cowork-heading">${icon('chat')}<div><h2>一起完成这个项目</h2><p>额外信息和修改要求，可以在这里补充。</p></div></div>
    <div class="cowork-context"><span id="cowork-issuer">${esc(value.issuer_name || '待填写发行人')}</span><strong id="cowork-scope">${esc(value.market ? MARKET_LABELS[value.market] : '发行市场待选择')} · ${esc(value.offering ? OFFERING_LABELS[value.offering] : '发行方式待选择')}</strong><small>先创建项目，再发送并保存消息</small></div>
    <div class="cowork-messages"><p class="cowork-guidance">项目创建后可连续发送补充要求；当前文字尚未发送。</p></div>
    <div class="cowork-prompts">${Object.keys(prompts).map(label => `<button type="button" data-note-example="${label}">${label}</button>`).join('')}</div>
    <div class="cowork-composer"><label for="project-message">补充说明与写作要求</label><textarea id="project-message" maxlength="12000" rows="4" placeholder="例如：截至2026年6月末，授信总额50亿元，已使用30亿元。">${esc(text)}</textarea><button class="btn primary cowork-save" type="button" disabled>创建项目后可发送 ${icon('send')}</button>
    <p class="cowork-footnote">输入仅在本页暂存；创建项目不会自动发送。助手回复和意图识别尚未接通。</p></div></aside>`;
}

export function bindConversationPrompts(host: HTMLElement) {
  host.querySelectorAll<HTMLButtonElement>('[data-note-example]').forEach(button => button.addEventListener('click', () => {
    const textarea = host.querySelector<HTMLTextAreaElement>('#project-message')!;
    textarea.placeholder = prompts[button.dataset.noteExample!] ?? textarea.placeholder;
    textarea.focus();
  }));
}

/** The API is a save-only, owner-scoped user-message ledger, not an assistant conversation. */
export class ProjectConversation {
  private controller = new AbortController();
  private host!: HTMLElement;
  private items: Message[] = [];
  private ref?: ProjectMessageSetRef;
  private cursor: string | null = null;
  private loading = false;
  private saving = false;
  private status = '正在读取已保存消息…';
  private composer: string;
  private edit?: { id: string; version: number };
  private pending?: Request;
  private history?: Message;
  private readGeneration = 0;
  private savedAwaitingRead = false;

  constructor(private api: ApiClient, private projectId: string, private onChange: () => void, initial = '') {
    this.composer = initial;
  }
  get hasUnsent() { return Boolean(this.composer.trim() || this.pending || this.saving); }
  get hasMessages() { return Boolean(this.ref?.message_ids.length); }
  get ready() { return !!this.ref && !this.loading; }
  get blockReason() {
    if (this.saving || this.pending) return '补充消息尚未确认保存，请先重试或重新读取。';
    if (this.composer.trim()) return '有尚未发送的补充，请先发送或清空。';
    if (!this.ready) return '项目消息尚未读取，请在右侧重新读取。';
    return '';
  }
  mount(host: HTMLElement, value: ProjectCreate) {
    this.host = host;
    this.render(value);
    host.addEventListener('input', event => {
      if ((event.target as HTMLElement).id !== 'project-message') return;
      this.composer = (event.target as HTMLTextAreaElement).value;
      this.onChange();
      this.controls();
    });
    host.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.dataset.noteExample) {
        this.host.querySelector<HTMLTextAreaElement>('#project-message')!.placeholder = prompts[button.dataset.noteExample]!;
        this.host.querySelector<HTMLTextAreaElement>('#project-message')!.focus();
      } else if (button.id === 'send-project-message') void this.send();
      else if (button.id === 'reload-project-messages') void this.refresh();
      else if (button.id === 'more-project-messages') void this.more();
      else if (button.dataset.editMessage) this.selectEdit(button.dataset.editMessage);
      else if (button.id === 'cancel-message-edit' && !this.pending) { this.edit = undefined; this.composer = ''; this.status = '编辑已取消；服务器上的版本未更改。'; this.onChange(); this.render(); }
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
    const prior = this.host.querySelector('#cowork-context');
    const issuer = value?.issuer_name ?? prior?.getAttribute('data-issuer') ?? '';
    const scope = value
      ? `${value.market ? MARKET_LABELS[value.market] : '发行市场待选择'} · ${value.offering ? OFFERING_LABELS[value.offering] : '发行方式待选择'}`
      : prior?.getAttribute('data-scope') ?? '';
    const legacy = value?.update_details?.supplementary_notes ?? this.host.dataset.legacy ?? '';
    this.host.dataset.legacy = legacy;
    this.host.innerHTML = `<aside class="panel project-cowork supplement-panel" aria-label="项目协作"><div class="cowork-heading">${icon('chat')}<div><h2>一起完成这个项目</h2><p>额外信息和修改要求，可以在这里补充。</p></div></div>
      <div class="cowork-context" id="cowork-context" data-issuer="${esc(issuer)}" data-scope="${esc(scope)}"><span id="cowork-issuer">${esc(issuer || '待填写发行人')}</span><strong id="cowork-scope">${esc(scope)}</strong><small>消息按账号与项目保存 · 开始更新需单独点击</small></div>
      <div class="cowork-messages" aria-live="polite">${this.items.length ? this.items.map(item => `<article class="cowork-message" data-message-id="${esc(item.message_id)}"><p>${esc(item.body).replaceAll('\n', '<br>')}</p><small>已记录 · 用户提供（未核验） · 版本 ${item.message_version} · ${esc(date(item.created_at))}</small><div class="cowork-message-actions"><button type="button" data-edit-message="${esc(item.message_id)}">修改</button>${item.message_version > 1 ? `<button type="button" data-message-version="${esc(item.message_id)}" data-version="${item.message_version - 1}">查看旧版本</button>` : ''}</div></article>`).join('') : `<p class="cowork-guidance">${this.loading ? '正在读取项目消息…' : this.ref ? '还没有已发送的项目补充。' : '消息尚未读取，请重试。'}</p>`}</div>
      ${this.cursor ? '<button id="more-project-messages" class="text-button" type="button">加载更多消息</button>' : ''}
      ${this.history ? `<section class="message-history" aria-label="消息历史版本"><h3>历史版本 ${this.history.message_version} · 用户提供（未核验）</h3><p>${esc(this.history.body).replaceAll('\n', '<br>')}</p><small>${esc(date(this.history.created_at))} · ${this.history.material_versions.length} 份精确材料引用</small><div class="cowork-message-actions">${this.history.message_version > 1 ? `<button type="button" data-message-version="${esc(this.history.message_id)}" data-version="${this.history.message_version - 1}">更早版本</button>` : ''}<button type="button" id="close-message-history">关闭</button></div></section>` : ''}
      ${legacy ? `<details class="cowork-legacy"><summary>旧版补充说明（未作为消息发送）</summary><p>${esc(legacy).replaceAll('\n', '<br>')}</p><small>此内容仍保存在原项目草稿及下一版输入中，可在“项目信息”中修改。</small></details>` : ''}
      <div class="cowork-prompts">${Object.keys(prompts).map(label => `<button type="button" data-note-example="${label}">${label}</button>`).join('')}</div>
      <div class="cowork-composer"><label for="project-message">补充说明与写作要求</label><textarea id="project-message" maxlength="12000" rows="4" placeholder="例如：截至2026年6月末，授信总额50亿元，已使用30亿元。">${esc(this.composer)}</textarea><button class="btn primary cowork-save" id="send-project-message" type="button">${this.edit ? '保存修改' : '发送并保存'} ${icon('send')}</button>${this.edit && !this.pending ? '<button class="text-button" id="cancel-message-edit" type="button">取消编辑</button>' : ''}${this.pending ? '<button class="text-button" id="restore-message-request" type="button">恢复原请求以重试</button>' : ''}
      <p class="cowork-footnote">发送仅保存用户原话，不会收到助手回复或自动开始更新。执行中的新消息只用于下一次输入版本。</p><p id="conversation-status" role="status"></p><button id="reload-project-messages" class="text-button" type="button">重新读取消息</button></div></aside>`;
    this.controls();
  }
  setContext(value: ProjectCreate) {
    if (!this.host?.isConnected) return;
    const issuer = this.host.querySelector('#cowork-issuer');
    if (issuer) issuer.textContent = value.issuer_name || '待填写发行人';
    const context = this.host.querySelector('#cowork-context');
    context?.setAttribute('data-issuer', value.issuer_name || '');
    const scope = `${value.market ? MARKET_LABELS[value.market] : '发行市场待选择'} · ${value.offering ? OFFERING_LABELS[value.offering] : '发行方式待选择'}`;
    if (this.host.querySelector('#cowork-scope')) this.host.querySelector('#cowork-scope')!.textContent = scope;
    context?.setAttribute('data-scope', scope);
    this.host.dataset.legacy = value.update_details!.supplementary_notes ?? '';
    const legacy = this.host.querySelector('.cowork-legacy');
    if (legacy) legacy.querySelector('p')!.textContent = this.host.dataset.legacy;
  }
  private controls() {
    if (!this.host?.isConnected) return;
    const send = this.host.querySelector<HTMLButtonElement>('#send-project-message')!;
    const stale = this.ref && this.edit && this.items.find(item => item.message_id === this.edit?.id)?.message_version !== this.edit.version;
    send.disabled = this.saving || this.loading || !this.composer.trim() || !!stale || !this.ref && !this.pending ||
      !!this.pending && this.composer.trim() !== this.pending.body;
    send.textContent = this.saving ? '正在保存…' : this.pending ? '按同一请求重试保存' : this.edit ? '保存修改' : '发送并保存';
    this.host.querySelector('#conversation-status')!.textContent = stale ? '这条消息已有新版本。请重新选择最新版本后再编辑；原文仍保留在输入框。' : this.status;
    this.host.querySelector<HTMLTextAreaElement>('#project-message')!.disabled = this.saving;
    this.host.querySelector<HTMLButtonElement>('#restore-message-request')?.toggleAttribute('disabled', this.saving);
    this.host.querySelector<HTMLButtonElement>('#restore-message-request')?.toggleAttribute('hidden', this.composer.trim() === this.pending?.body);
    this.host.querySelector<HTMLButtonElement>('#more-project-messages')?.toggleAttribute('disabled', this.loading);
    this.host.querySelector<HTMLButtonElement>('#reload-project-messages')!.disabled = this.loading || this.saving;
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
      this.status = this.pending ? '此前保存结果未确认；可按同一请求重试，或确认当前列表后再操作。' : `已读取 ${this.items.length} 条用户消息。`;
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.ref = undefined; this.items = []; this.cursor = null;
      this.status = this.savedAwaitingRead
        ? `消息已保存，但列表读取失败：${readError(error)} 请重新读取；无需重复发送。`
        : `消息读取失败：${readError(error)} 请重新读取。`;
    } finally { if (!this.controller.signal.aborted) { this.loading = false; this.render(); this.onChange(); } }
  }
  private async more() {
    if (!this.cursor || this.loading || !this.ref) return;
    const cursor = this.cursor, ref = this.ref;
    this.loading = true; this.controls();
    try {
      const page = await this.page(cursor);
      if (!sameRef(ref, page.project_message_set_ref) || page.items.some(item => this.items.some(previous => previous.message_id === item.message_id))) throw invalid();
      this.items.push(...page.items); this.cursor = page.next_cursor;
      this.status = `已读取 ${this.items.length} 条用户消息。`;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.loading = false; this.status = '消息列表已变化，正在重新读取第一页；输入框未改动。';
        await this.refresh(); return;
      }
      this.status = `加载更多失败：${readError(error)} 可重试。`;
    } finally { this.loading = false; this.render(); }
  }
  private selectEdit(id: string) {
    const message = this.items.find(item => item.message_id === id);
    if (!message || this.pending || this.saving) return;
    if (this.composer.trim() && !window.confirm('当前尚未发送的文字会被这条消息的内容替换，是否继续？')) return;
    this.edit = { id, version: message.message_version };
    this.composer = message.body; this.status = `正在编辑版本 ${message.message_version}；原版本将保留可查。`;
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
  private async send() {
    if (this.saving || this.loading || !this.composer.trim() || !this.ref && !this.pending) return;
    const stale = this.edit && this.items.find(item => item.message_id === this.edit?.id)?.message_version !== this.edit.version;
    if (stale) { this.controls(); return; }
    if (!this.pending) this.pending = {
      message_id: this.edit?.id ?? crypto.randomUUID(), submission_request_id: crypto.randomUUID(),
      expected_message_version: this.edit?.version ?? null, body: this.composer.trim(), material_versions: []
    };
    if (this.composer.trim() !== this.pending.body) { this.controls(); return; }
    const request = this.pending;
    this.saving = true; this.status = '正在保存用户消息…'; this.controls(); this.onChange();
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
      this.pending = undefined; this.edit = undefined; this.composer = '';
      this.savedAwaitingRead = true;
      this.status = '已保存用户补充；未核验，不会自动开始更新。';
      this.onChange();
      this.saving = false;
      await this.refresh();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409) {
        this.pending = undefined;
        this.status = '消息版本或请求冲突。正在重新读取服务器版本；输入原文保留，不会覆盖。';
        this.saving = false; await this.refresh();
        if (this.ref) this.status = '服务器版本已重新读取；请检查差异，再选择最新消息修改。';
      } else {
        this.status = `保存结果尚未确认：${friendlyError(error)} 原文保留，可按同一请求重试。`;
      }
    } finally { this.saving = false; this.render(); this.onChange(); }
  }
  async currentRef(): Promise<ProjectMessageSetRef> {
    if (this.blockReason) throw new ApiError(409, 'INPUT_REVISION_CONFLICT');
    const page = await this.page();
    const ref = page.project_message_set_ref;
    if (!this.ref || !sameRef(this.ref, ref)) {
      this.items = page.items; this.cursor = page.next_cursor; this.ref = ref;
      this.status = '服务器消息列表已更新，请核对最新消息。';
      this.render(); this.onChange();
    }
    return ref;
  }
  dispose() { this.controller.abort(); this.readGeneration++; this.items = []; this.ref = undefined; this.pending = undefined; this.composer = ''; }
}
