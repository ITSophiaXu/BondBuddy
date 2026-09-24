import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { Draft } from './draft';
import { blankDraft, validateDraft } from './form-model';
import { bindUpdateForm, readUpdateForm, supplementaryPanel, updateFormFields } from './update-form';
import { M1_MATERIAL_PARTITIONS, M1_UPLOAD_MIME_TYPES } from '@bondbuddy/contracts';
import './style.css';
import './update-form.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const folder = icon('M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z');
const plus = icon('M12 5v14M5 12h14');
let identity: string | undefined;
let epoch = 0;
let currentRoute = '/';
let draft: Draft | undefined;
let newDirty = false;
let creating = false;
let items: Dto<'ProjectListResponse'>['items'] = [];
let nextCursor: string | null = null;
let listBusy = false;
type UploadRole = Dto<'UploadCreateRequest'>['role'];
type UploadPhase = 'hashing' | 'uploading' | 'saving' | 'persisted' | 'failed' | 'cancelled' | 'uncertain';
type LocalUpload = { key: string; owner: string; projectId: string; role: UploadRole; file: File; phase: UploadPhase; sentBytes: number; material?: Dto<'MaterialResponse'>; error?: string; controller?: AbortController };
type MaterialRecovery = { state: 'loading' | 'ready' | 'unavailable'; message?: string };
const localUploads = new Map<string, LocalUpload[]>();
const recoveredMaterials = new Map<string, Dto<'MaterialResponse'>[]>();
const recoveryStates = new Map<string, MaterialRecovery>();
const recoveryControllers = new Set<AbortController>();
const mimeByExtension: Record<string, typeof M1_UPLOAD_MIME_TYPES[number]> = {
  docx: M1_UPLOAD_MIME_TYPES[0], pdf: M1_UPLOAD_MIME_TYPES[1], xlsx: M1_UPLOAD_MIME_TYPES[2],
  csv: M1_UPLOAD_MIME_TYPES[3], txt: M1_UPLOAD_MIME_TYPES[4], png: M1_UPLOAD_MIME_TYPES[5],
  jpg: M1_UPLOAD_MIME_TYPES[6], jpeg: M1_UPLOAD_MIME_TYPES[6]
};
const sessionChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('bondbuddy-session') : undefined;
const api = new ApiClient(() => signedOut(identity ? '登录已失效。已保存的项目会在重新登录后恢复。' : ''));

function clearPrivateState() {
  for (const uploads of localUploads.values()) for (const upload of uploads) upload.controller?.abort();
  for (const controller of recoveryControllers) controller.abort();
  localUploads.clear(); recoveredMaterials.clear(); recoveryStates.clear(); recoveryControllers.clear();
  epoch++; api.reset(); draft?.dispose(); draft = undefined; newDirty = false; creating = false;
  identity = undefined; items = []; nextCursor = null; listBusy = false;
}

function signedOut(message = '') {
  clearPrivateState();
  history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  currentRoute = '/'; renderLogin(message);
}
sessionChannel?.addEventListener('message', () => signedOut('账号会话已在其他页面更改，请重新登录。'));

function renderLogin(message = '') {
  root.innerHTML = `<main id="main" class="login-layout" tabindex="-1">
    <div class="login-intro"><a class="brand" href="#/"><img src="/favicon.svg" alt=""/>BondBuddy</a>
      <div><p class="eyebrow">债券项目工作空间</p><h1>把每一次准备，<br/>接着做下去。</h1><p>项目资料按账号保存。重新登录，<br/>继续上次的工作。</p></div>
      <p class="intro-foot">有据可查 · 有序协作</p></div>
    <section class="login-panel" aria-labelledby="login-title"><p class="eyebrow">欢迎回来</p><h2 id="login-title">登录工作区</h2><p class="muted">使用已有的用户名和密码登录。</p>
      <form id="login-form"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" autocapitalize="none" spellcheck="false"/>
      <label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="512"/>
      <p id="login-message" class="form-message" role="status">${esc(message)}</p><button class="button primary" type="submit">登录</button></form>
      <p class="privacy-note">项目资料保存在平台工作区，仅限当前账号访问。</p></section></main>`;
  document.querySelector<HTMLFormElement>('#login-form')!.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const button = form.querySelector<HTMLButtonElement>('button')!;
    const feedback = form.querySelector<HTMLElement>('#login-message')!;
    button.disabled = true; button.textContent = '正在登录…'; feedback.textContent = '';
    api.reset();
    const token = ++epoch;
    try {
      const result = await api.login({ username: (form.elements.namedItem('username') as HTMLInputElement).value.trim(), password: (form.elements.namedItem('password') as HTMLInputElement).value });
      if (token !== epoch) return;
      (form.elements.namedItem('password') as HTMLInputElement).value = '';
      identity = result.user_id; sessionChannel?.postMessage('changed');
      await renderRoute();
    } catch (error) {
      if (token !== epoch) return;
      feedback.textContent = error instanceof ApiError && error.status === 401 ? '用户名或密码不正确，请重试。' : friendlyError(error);
    } finally { button.disabled = false; button.textContent = '登录'; }
  });
}

function shell(content: string, section: string) {
  root.innerHTML = `<aside class="sidebar"><a class="brand" href="#/"><img src="/favicon.svg" alt=""/>BondBuddy</a>
    <div class="workspace-tag"><span class="workspace-symbol">B</span><div><strong>我的工作区</strong><small>募集书项目管理</small></div></div>
    <p class="nav-label">工作空间</p><nav aria-label="主导航"><a class="nav-item ${section === 'projects' ? 'active' : ''}" href="#/" ${section === 'projects' ? 'aria-current="page"' : ''}>${folder}我的项目</a>
    <a class="nav-item ${section === 'new' ? 'active' : ''}" href="#/new" ${section === 'new' ? 'aria-current="page"' : ''}>${plus}新建更新项目</a></nav>
    <div class="sidebar-bottom"><p class="sidebar-note">从项目出发，<br/>让准备工作井然有序。</p><div class="account"><span class="avatar">我</span><div><strong>个人工作区</strong><small>已登录</small></div><button id="logout" class="text-button" type="button">退出</button></div></div></aside>
    <div class="shell"><header class="topbar"><span>工作空间 <span class="divider">/</span> ${section === 'new' ? '新建项目' : '我的项目'}</span><span class="trial">受控试用</span></header>
    <main id="main" tabindex="-1">${content}</main></div>`;
  document.querySelector('#logout')!.addEventListener('click', () => { void logout(); });
}

function showError(error: unknown) {
  const target = document.querySelector<HTMLElement>('#page-error');
  if (target) { target.textContent = friendlyError(error); target.hidden = false; }
}

async function logout() {
  const button = document.querySelector<HTMLButtonElement>('#logout');
  if (!button) return;
  if (creating) return;
  if (newDirty && !window.confirm('当前新项目尚未保存。退出会放弃这些填写内容，是否继续？')) return;
  button.disabled = true;
  if (draft && (draft.dirty || draft.state === 'saving') && !await draft.save()) {
    if (!identity) return;
    if (!window.confirm('仍有未保存的修改。退出会放弃这些修改，是否退出？')) { button.disabled = false; return; }
  }
  const activeUploads = [...localUploads.values()].flat().filter(upload => ['hashing', 'uploading', 'saving'].includes(upload.phase)).length;
  if (activeUploads && !window.confirm(`还有 ${activeUploads} 个文件正在传输或保存。退出会结束本页未完成的传输；结果未确认的文件需要重新读取服务器记录后再决定是否重传。仍要退出？`)) {
    button.disabled = false; return;
  }
  try {
    await api.logout(); signedOut(); sessionChannel?.postMessage('changed');
  } catch (error) { showError(error); button.disabled = false; }
}

async function renderRoute() {
  if (!identity) return;
  const requested = location.hash.slice(1) || '/';
  if (creating || (newDirty && !window.confirm('当前新项目尚未保存，离开会放弃填写内容，是否继续？'))) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${currentRoute}`); return;
  }
  newDirty = false;
  const token = ++epoch;
  if (draft && (draft.dirty || draft.state === 'saving')) {
    const saved = await draft.save();
    if (token !== epoch) return;
    if (!saved) {
      history.replaceState(null, '', `${location.pathname}${location.search}#${currentRoute}`);
      showError(draft.error ?? new ApiError(422, 'INPUT_REQUIRED')); return;
    }
  }
  draft?.dispose(); draft = undefined;
  items = []; nextCursor = null; listBusy = false;
  currentRoute = requested;
  if (requested === '/new') { renderNew(); return; }
  if (requested === '/') { renderProjects(); await loadProjects(token); return; }
  const match = requested.match(/^\/projects\/([^/]+)$/);
  if (!match) { location.hash = '/'; return; }
  shell('<p role="status">正在读取项目…</p><p id="page-error" role="alert" hidden></p>', 'projects');
  try {
    const project = await api.project(decodeURIComponent(match[1]));
    if (token !== epoch) return;
    renderProject(project);
  } catch (error) {
    if (token !== epoch) return;
    shell(`<a class="back-link" href="#/">← 返回我的项目</a><div class="empty-state"><h1>项目暂时无法打开</h1><p>${esc(friendlyError(error))}</p><button class="button secondary" id="retry-project">重新加载</button></div><p id="page-error" role="alert" hidden></p>`, 'projects');
    document.querySelector('#retry-project')!.addEventListener('click', () => { void renderRoute(); });
  }
}

function renderProjects() {
  shell(`<div class="page-heading"><div><p class="eyebrow">从上次停下的地方继续</p><h1>我的项目</h1><p class="muted">查找已保存的资料，继续准备下一次更新。</p></div><a class="button primary" href="#/new">${plus}新建更新项目</a></div>
    <section class="panel" aria-labelledby="projects-title"><div class="panel-heading"><h2 id="projects-title">项目列表</h2><button class="text-button" id="refresh-projects">刷新列表</button></div>
    <div class="list-toolbar"><div class="search-field"><label for="project-search">搜索已加载的项目名称</label><input id="project-search" type="search" placeholder="输入项目名称" autocomplete="off"/></div><p class="muted" id="list-count" role="status">正在加载…</p></div>
    <p id="page-error" class="form-message" role="alert" hidden></p><div id="project-list" aria-live="polite"></div><div class="list-footer"><button class="button secondary" id="load-more" hidden>加载更多项目</button></div></section>
    <p class="page-footnote">当前可保存和恢复项目基本资料。材料上传与全文更新将在完成验证后开放。</p>`, 'projects');
  document.querySelector('#project-search')!.addEventListener('input', renderItems);
  document.querySelector('#load-more')!.addEventListener('click', () => { void loadProjects(epoch); });
  document.querySelector('#refresh-projects')!.addEventListener('click', () => { void renderRoute(); });
}

async function loadProjects(token: number) {
  if (listBusy || token !== epoch) return;
  listBusy = true;
  const button = document.querySelector<HTMLButtonElement>('#load-more')!;
  const error = document.querySelector<HTMLElement>('#page-error')!;
  button.disabled = true; error.hidden = true;
  try {
    const result = await api.projects(nextCursor ?? undefined);
    if (token !== epoch) return;
    const seen = new Map(items.map(item => [item.project_id, item]));
    result.items.forEach(item => seen.set(item.project_id, item));
    items = [...seen.values()];
    nextCursor = result.page.has_more ? result.page.next_cursor : null;
    renderItems();
  } catch (error) {
    if (token !== epoch) return;
    showError(error);
    document.querySelector('#list-count')!.textContent = '列表未能同步，请刷新重试。';
  } finally {
    if (token === epoch) { listBusy = false; button.disabled = false; button.hidden = !nextCursor; }
  }
}

function renderItems() {
  const query = document.querySelector<HTMLInputElement>('#project-search')!.value.trim().toLocaleLowerCase();
  const shown = items.filter(item => item.name.toLocaleLowerCase().includes(query)).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.project_id.localeCompare(b.project_id));
  document.querySelector('#list-count')!.textContent = `${query ? `匹配 ${shown.length} 个 · ` : ''}已加载 ${items.length} 个项目${nextCursor ? '，可继续加载' : ''}`;
  document.querySelector('#project-list')!.innerHTML = shown.length ? `<ul class="project-list">${shown.map(item => `<li><a class="project-row" href="#/projects/${encodeURIComponent(item.project_id)}"><span class="project-icon">${folder}</span><div class="project-info"><h3>${esc(item.name)}</h3><p>项目资料已保存</p></div><time datetime="${esc(item.updated_at)}">${esc(date(item.updated_at))}</time><span class="row-arrow" aria-hidden="true">↗</span></a></li>`).join('')}</ul>` : `<div class="empty-state"><div class="empty-icon">${folder}</div><h3>${query ? '没有找到匹配的项目' : '还没有项目'}</h3><p>${query ? '试试其他名称，或加载更多项目。' : '创建第一个更新项目，先把基本资料保存下来。'}</p>${query ? '' : '<a class="button secondary" href="#/new">新建更新项目</a>'}</div>`;
}

function renderNew() {
  const value = blankDraft();
  shell(`<a class="back-link" href="#/">← 返回我的项目</a><div class="page-heading"><div><p class="eyebrow">募集书更新</p><h1>新建项目</h1><p class="muted">先填写已知信息，未确定的内容可以保存后再补充。</p></div></div>
    <form id="create-form" class="update-form"><div class="detail-layout"><section class="panel form-panel">${updateFormFields(value)}
    <p id="page-error" class="form-message" role="alert" hidden></p><div class="form-actions"><button class="button primary" type="submit">创建并保存项目</button><a class="button secondary" href="#/">取消</a></div></section>${supplementaryPanel(value)}</div></form>`, 'new');
  const form = document.querySelector<HTMLFormElement>('#create-form')!;
  bindUpdateForm(form, () => { newDirty = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (creating) return;
    const value = readUpdateForm(form); value.name = value.name.trim();
    const errors = validateDraft(value);
    if (errors.length) { const target = document.querySelector<HTMLElement>('#page-error')!; target.textContent = errors.join(' '); target.hidden = false; return; }
    creating = true;
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')].map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    button.textContent = '正在保存…';
    const token = epoch;
    try {
      const project = await api.create(value);
      if (token !== epoch) return;
      newDirty = false; location.hash = `/projects/${encodeURIComponent(project.project_id)}`;
    } catch (error) { if (token === epoch) showError(error); }
    finally { creating = false; controls.forEach(({ control, disabled }) => { control.disabled = disabled; }); button.textContent = '创建并保存项目'; }
  });
}

function renderProject(project: Dto<'ProjectResponse'>) {
  draft = new Draft(project, api, updateSaveState);
  const value = { ...draft.fields, kind: 'update' as const, issuer_name: draft.fields.issuer_name || null };
  shell(`<a class="back-link" href="#/">← 返回我的项目</a><div class="page-heading"><div><p class="eyebrow">项目工作区</p><h1 id="project-heading">${esc(project.name)}</h1><p class="muted">填写本次更新的目标，已保存的资料可以随时回来继续。</p></div><span class="save-badge" id="save-state" role="status">已保存</span></div>
    <form id="draft-form" class="update-form"><div class="detail-layout"><section class="panel form-panel"><p class="field-hint">修改后自动保存；未确定的选填内容可留空。</p>${updateFormFields(value)}
    <p id="page-error" class="form-message" role="alert" hidden></p><div id="conflict-panel" class="conflict-panel" hidden><p>当前输入未覆盖其他页面的修改。可以复制保留输入，再加载最新资料。</p><button class="button secondary" type="button" id="reload-draft">放弃当前输入并加载最新资料</button></div>
    <div class="form-actions"><button id="save-draft" class="button primary" type="submit" disabled>保存修改</button><span class="muted" id="saved-time">${esc(date(project.updated_at))} 保存</span></div></section>${supplementaryPanel(value)}</div></form>
    <section class="panel materials-panel" aria-labelledby="materials-title"><div class="panel-heading materials-heading"><div><h2 id="materials-title">项目材料</h2><p class="muted">按固定分区添加 DOCX、PDF、XLSX、CSV、TXT、PNG 或 JPEG。文件内容与哈希由服务器核验。</p></div><button class="button secondary" type="button" data-refresh-materials>刷新已保存材料</button></div>
    <p id="material-recovery-status" class="material-recovery-status" role="status"></p><div id="material-partitions">${renderMaterialPartitions(project.project_id)}</div>
    <p class="material-footnote">上传进度按文件字节显示。传输到 100% 后，仍需等待服务端保存和校验；文件准备完成不代表财务数据已核验。</p></section>`, 'projects');
  const form = document.querySelector<HTMLFormElement>('#draft-form')!;
  bindUpdateForm(form, value => { draft?.edit({ name: value.name, issuer_name: value.issuer_name ?? '', market: value.market, offering: value.offering, update_details: value.update_details! }); });
  form.addEventListener('submit', event => { event.preventDefault(); void draft?.save(); });
  document.querySelector('#reload-draft')!.addEventListener('click', () => {
    if (!window.confirm('加载最新资料会放弃当前未保存的输入，是否继续？')) return;
    draft?.dispose(); draft = undefined; void renderRoute();
  });
  bindMaterialWorkspace(project.project_id);
  void refreshProjectMaterials(project.project_id, epoch);
}

function updateSaveState() {
  if (!draft) return;
  const labels = { saved: '已保存', dirty: '尚未保存', saving: '正在保存…', conflict: '有版本冲突', error: '保存未确认' };
  const badge = document.querySelector<HTMLElement>('#save-state');
  if (!badge) return;
  badge.textContent = labels[draft.state]; badge.dataset.state = draft.state;
  const button = document.querySelector<HTMLButtonElement>('#save-draft')!;
  button.disabled = draft.state === 'saving' || draft.state === 'conflict' || !draft.dirty || !draft.valid;
  button.textContent = draft.state === 'error' ? '重试保存' : '保存修改';
  document.querySelector<HTMLElement>('#conflict-panel')!.hidden = draft.state !== 'conflict';
  const error = document.querySelector<HTMLElement>('#page-error')!;
  error.hidden = !draft.error && (!draft.dirty || draft.valid);
  error.textContent = draft.error ? friendlyError(draft.error) : draft.dirty ? draft.validationErrors.join(' ') : '';
  if (draft.state === 'saved') {
    document.querySelector('#project-heading')!.textContent = draft.project.name;
    document.querySelector('#saved-time')!.textContent = `${date(draft.project.updated_at)} 保存`;
  }
}

function roleLabel(role: UploadRole) {
  for (const partition of M1_MATERIAL_PARTITIONS as readonly { roles: readonly { code: string; label: string }[] }[]) {
    const match = partition.roles.find(item => item.code === role);
    if (match) return match.label;
  }
  return role;
}

function roleGuidance(role: UploadRole) {
  if (role === 'historical') return '有历史稿时请提供本发行人的历史募集书';
  if (role === 'reference') return '无历史稿时可选，可提供你希望参考的募集书';
  if (['audit', 'financial', 'interimFinancial', 'notes'].includes(role)) return '更新所需财务材料；可上传多份覆盖所需期间';
  if (['fundUse', 'feasibility', 'priorFundUse', 'resolutions'].includes(role)) return '按本期用途与项目情况提供相关材料';
  return '选填，按项目核验需要添加';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadStatus(upload: LocalUpload) {
  const percent = upload.file.size ? Math.min(100, Math.floor(upload.sentBytes / upload.file.size * 100)) : 0;
  switch (upload.phase) {
    case 'hashing': return '正在读取文件并计算 SHA-256…';
    case 'uploading': return percent >= 100 ? '已发送 100%，正在保存和核验…' : `正在传输 ${percent}%（${formatBytes(upload.sentBytes)} / ${formatBytes(upload.file.size)}）`;
    case 'saving': return '已发送 100%，正在保存和核验…';
    case 'persisted': return `服务器已确认保存 · 材料版本 ${upload.material?.material_version ?? '—'}`;
    case 'failed': return upload.error ?? '文件未保存。可以单独重试。';
    case 'cancelled': return '本次传输已取消；所选文件仍在此页面，可单独重试。';
    case 'uncertain': return '保存结果尚未确认。请先刷新服务器材料记录，再决定是否重新选择文件。';
  }
}

function materialStatus(material: Dto<'MaterialResponse'>) {
  switch (material.state) {
    case 'uploading': return '上传尚未完成';
    case 'persisted': return '服务器已保存，等待预检';
    case 'prechecking': return '服务器正在预检';
    case 'ready': return '预检状态已就绪；财务数字仍需核对';
    case 'parsing': return '服务器正在解析';
    case 'needs_confirmation': return '部分内容需要确认';
    case 'parsed': return '解析完成；解析结果仍需核对';
    case 'failed': return `服务器处理失败${material.error ? `：${material.error}` : ''}`;
  }
}

function renderUploadRow(upload: LocalUpload) {
  const active = ['hashing', 'uploading', 'saving'].includes(upload.phase);
  const showProgress = ['uploading', 'saving'].includes(upload.phase);
  const progress = Math.min(upload.file.size, upload.sentBytes);
  const controls = upload.phase === 'failed' || upload.phase === 'cancelled'
    ? `<button type="button" class="text-button" data-upload-action="retry" data-upload-key="${esc(upload.key)}">重试此文件</button>`
    : upload.phase === 'uncertain'
      ? `<button type="button" class="text-button" data-upload-action="reconcile" data-upload-key="${esc(upload.key)}">刷新服务器记录</button>`
      : active
        ? `<button type="button" class="text-button" data-upload-action="cancel" data-upload-key="${esc(upload.key)}">${upload.sentBytes >= upload.file.size ? '停止等待并核对' : '取消此文件'}</button>`
        : '';
  const canRemove = ['failed', 'cancelled', 'uncertain'].includes(upload.phase)
    ? `<button type="button" class="text-button" data-upload-action="remove" data-upload-key="${esc(upload.key)}">移除此行</button>`
    : '';
  return `<li class="material-file-row" data-upload-phase="${upload.phase}"><div class="material-file-main"><strong>${esc(upload.file.name)}</strong><span>${esc(roleLabel(upload.role))} · ${formatBytes(upload.file.size)}</span>${showProgress ? `<progress max="${upload.file.size}" value="${progress}" aria-label="${esc(upload.file.name)} 字节传输进度"></progress>` : ''}<p class="material-file-status" role="status">${esc(uploadStatus(upload))}</p>${upload.phase === 'failed' ? `<p class="material-file-error" role="alert">${esc(upload.error)}</p>` : ''}</div><div class="material-file-actions">${controls}${canRemove}</div></li>`;
}

function renderMaterialPartitions(projectId: string) {
  const uploads = localUploads.get(projectId) ?? [];
  const materials = recoveredMaterials.get(projectId) ?? [];
  const localMaterialIds = new Set(uploads.flatMap(upload => upload.material ? [upload.material.material_id] : []));
  const groups = M1_MATERIAL_PARTITIONS.map((partition, index) => `<section class="material-partition" aria-labelledby="material-partition-${index}"><h3 id="material-partition-${index}">${esc(partition.label)}</h3><ul class="material-role-list">${partition.roles.map(role => {
    const roleUploads = uploads.filter(upload => upload.role === role.code);
    const roleMaterials = materials.filter(material => material.role === role.code && !localMaterialIds.has(material.material_id));
    const accept = role.code === 'historical' || role.code === 'reference'
      ? '.docx,.pdf'
      : '.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg';
    const saved = roleMaterials.map(material => `<li class="material-file-row persisted-material"><div class="material-file-main"><strong>${esc(material.filename)}</strong><span>${esc(role.label)} · ${formatBytes(material.byte_size)} · 版本 ${material.material_version}</span><p class="material-file-status">${esc(materialStatus(material))}</p></div></li>`).join('');
    return `<li class="material-role"><div class="material-role-heading"><div><strong>${esc(role.label)}</strong><span>${esc(roleGuidance(role.code))}</span></div><label class="button secondary material-picker" for="upload-${esc(role.code)}">选择文件<input id="upload-${esc(role.code)}" type="file" multiple accept="${accept}" aria-label="为${esc(role.label)}选择文件" data-upload-role="${esc(role.code)}"/></label></div><ul class="material-file-list">${saved}${roleUploads.map(renderUploadRow).join('')}</ul></li>`;
  }).join('')}</ul></section>`).join('');
  return groups;
}

function updateMaterialWorkspace(projectId: string) {
  const list = document.querySelector<HTMLElement>('#material-partitions');
  if (list && currentRoute === `/projects/${projectId}`) list.innerHTML = renderMaterialPartitions(projectId);
  const status = document.querySelector<HTMLElement>('#material-recovery-status');
  if (!status || currentRoute !== `/projects/${projectId}`) return;
  const state = recoveryStates.get(projectId);
  if (state?.state === 'loading') status.textContent = '正在从服务器读取此项目已保存的材料记录…';
  else if (state?.state === 'unavailable') status.textContent = state.message ?? '暂时无法恢复已保存材料；当前页面不会把本地文件选择当作服务器保存记录。';
  else {
    const count = (recoveredMaterials.get(projectId) ?? []).length;
    const sessionCount = (localUploads.get(projectId) ?? []).filter(upload => upload.phase === 'persisted' && upload.material).length;
    status.textContent = count
      ? `已从服务器恢复 ${count} 份当前账号可访问的材料记录。${sessionCount ? `本次会话另有 ${sessionCount} 份材料已获服务端保存确认。` : ''}`
      : sessionCount
        ? `本次会话中 ${sessionCount} 份材料已获服务端保存确认；材料事件暂未列出其他可恢复记录。`
        : '材料事件中没有可恢复记录；重新选择本地文件不会代替服务器保存记录。';
  }
}

function uploadErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'MATERIAL_CONTENT_MISMATCH') return '服务器检测到文件内容与声明格式不符，材料未确认保存。请使用正确文件后重试。';
    if (error.code === 'MATERIAL_ENCRYPTED') return '服务器无法读取加密文件。请提供可读取的副本。';
    if (error.code === 'MATERIAL_UNREADABLE') return '服务器未收到完整文件内容。请单独重试此文件。';
    if (error.code === 'MATERIAL_FORMAT_UNSUPPORTED') return '服务器暂不支持此文件格式。';
    if (error.code === 'VALIDATION_FAILED') return '文件超出服务器限制或上传会话已过期。请检查文件后重试。';
  }
  return friendlyError(error);
}

function declaredMediaType(file: File, role: UploadRole): typeof M1_UPLOAD_MIME_TYPES[number] {
  const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
  const mediaType = mimeByExtension[extension];
  if (!mediaType || !M1_UPLOAD_MIME_TYPES.includes(mediaType)) throw new Error('此分区暂不支持该文件扩展名。');
  if ((role === 'historical' || role === 'reference') && extension !== 'docx' && extension !== 'pdf') {
    throw new Error('募集说明书分区仅接受 DOCX 或 PDF。');
  }
  return mediaType;
}

function sha256(bytes: ArrayBuffer) {
  return crypto.subtle.digest('SHA-256', bytes).then(digest => [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''));
}

function addUpload(projectId: string, role: UploadRole, file: File) {
  if (!identity) return;
  const upload: LocalUpload = { key: crypto.randomUUID(), owner: identity, projectId, role, file, phase: 'hashing', sentBytes: 0 };
  const uploads = localUploads.get(projectId) ?? [];
  uploads.push(upload); localUploads.set(projectId, uploads);
  updateMaterialWorkspace(projectId);
  void performUpload(upload);
}

async function performUpload(upload: LocalUpload) {
  const controller = new AbortController(); upload.controller = controller;
  let acceptedByByteEndpoint = false;
  const isCurrentOwner = () => identity === upload.owner && (localUploads.get(upload.projectId) ?? []).includes(upload);
  try {
    const mediaType = declaredMediaType(upload.file, upload.role);
    if (!upload.file.size) throw new Error('空文件不能上传。');
    const hash = await sha256(await upload.file.arrayBuffer());
    if (controller.signal.aborted || !isCurrentOwner()) return;
    const session = await api.createUpload(upload.projectId, { filename: upload.file.name, media_type: mediaType, byte_size: upload.file.size, sha256: hash, role: upload.role }, controller.signal);
    if (controller.signal.aborted || !isCurrentOwner()) return;
    upload.phase = 'uploading'; updateMaterialWorkspace(upload.projectId);
    await api.uploadBytes(session.upload_url, upload.file, loaded => {
      if (!isCurrentOwner() || controller.signal.aborted) return;
      upload.sentBytes = Math.min(upload.file.size, Math.max(0, loaded));
      upload.phase = upload.sentBytes >= upload.file.size ? 'saving' : 'uploading';
      updateMaterialWorkspace(upload.projectId);
    }, controller.signal);
    if (controller.signal.aborted || !isCurrentOwner()) return;
    acceptedByByteEndpoint = true; upload.phase = 'saving'; upload.sentBytes = upload.file.size; updateMaterialWorkspace(upload.projectId);
    const material = await api.completeUpload(upload.projectId, session.upload_id, { byte_size: upload.file.size, sha256: hash }, controller.signal);
    if (controller.signal.aborted || !isCurrentOwner()) return;
    upload.material = material; upload.phase = 'persisted'; upload.error = undefined;
    recoveryStates.set(upload.projectId, { state: 'ready' });
    updateMaterialWorkspace(upload.projectId);
    void refreshProjectMaterials(upload.projectId, epoch);
  } catch (error) {
    if (!isCurrentOwner()) return;
    if (upload.phase === 'cancelled' || upload.phase === 'uncertain') return;
    const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const explicitServerFailure = error instanceof ApiError && error.status > 0;
    const uncertain = !explicitServerFailure && (aborted || upload.sentBytes >= upload.file.size || acceptedByByteEndpoint);
    upload.phase = aborted && !uncertain ? 'cancelled' : uncertain ? 'uncertain' : 'failed';
    upload.error = aborted && !uncertain ? undefined : uncertain ? '服务器可能已收到文件，但当前会话未取得保存凭证。请刷新服务器记录；请勿盲目重传。' : uploadErrorMessage(error);
    updateMaterialWorkspace(upload.projectId);
  } finally {
    if (upload.controller === controller) upload.controller = undefined;
  }
}

async function refreshProjectMaterials(projectId: string, token: number) {
  if (!identity) return;
  const owner = identity;
  const controller = new AbortController(); recoveryControllers.add(controller);
  recoveryStates.set(projectId, { state: 'loading' }); updateMaterialWorkspace(projectId);
  try {
    const ids = new Set<string>();
    let cursor = 0;
    while (!controller.signal.aborted) {
      const page = await api.projectEvents(projectId, cursor, controller.signal);
      for (const event of page.items) if (event.type === 'material.upload_progress' && event.payload.material_id) ids.add(event.payload.material_id);
      if (!page.items.length) break;
      const next = page.next_cursor ?? Math.max(...page.items.map(event => event.seq));
      if (next <= cursor) break;
      cursor = next;
    }
    const fetched = await Promise.all([...ids].map(async id => {
      try { return await api.material(projectId, id, controller.signal); }
      catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
    }));
    if (controller.signal.aborted || token !== epoch || owner !== identity) return;
    recoveredMaterials.set(projectId, fetched.filter((item): item is Dto<'MaterialResponse'> => item !== undefined));
    recoveryStates.set(projectId, { state: 'ready' });
  } catch (error) {
    if (controller.signal.aborted || token !== epoch || owner !== identity) return;
    const message = error instanceof ApiError && error.status === 501
      ? '材料事件恢复接口尚未开放。当前会话中服务器已确认保存的文件仍显示在本页；重新登录后不会把本地选择误报为已保存。'
      : `无法读取服务器材料记录。${friendlyError(error)}`;
    recoveryStates.set(projectId, { state: 'unavailable', message });
  } finally {
    recoveryControllers.delete(controller);
    if (token === epoch && owner === identity) updateMaterialWorkspace(projectId);
  }
}

function bindMaterialWorkspace(projectId: string) {
  const host = document.querySelector<HTMLElement>('#material-partitions')!;
  host.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-upload-role]')) return;
    const role = input.dataset.uploadRole as UploadRole;
    for (const file of Array.from(input.files ?? [])) addUpload(projectId, role, file);
    input.value = '';
  });
  host.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-upload-action]');
    if (!button) return;
    const upload = (localUploads.get(projectId) ?? []).find(item => item.key === button.dataset.uploadKey);
    if (!upload) return;
    switch (button.dataset.uploadAction) {
      case 'cancel': {
        const uncertain = upload.phase === 'saving' || upload.sentBytes >= upload.file.size;
        upload.phase = uncertain ? 'uncertain' : 'cancelled';
        upload.error = uncertain ? '已停止等待；服务器是否已完成保存尚未确认。请先核对服务器记录。' : undefined;
        upload.controller?.abort(); updateMaterialWorkspace(projectId);
        if (uncertain) void refreshProjectMaterials(projectId, epoch);
        break;
      }
      case 'retry': upload.phase = 'hashing'; upload.sentBytes = 0; upload.error = undefined; updateMaterialWorkspace(projectId); void performUpload(upload); break;
      case 'reconcile': void refreshProjectMaterials(projectId, epoch); break;
      case 'remove': {
        if (['hashing', 'uploading', 'saving'].includes(upload.phase)) upload.controller?.abort();
        localUploads.set(projectId, (localUploads.get(projectId) ?? []).filter(item => item !== upload));
        updateMaterialWorkspace(projectId);
        if (upload.phase === 'uncertain') void refreshProjectMaterials(projectId, epoch);
        break;
      }
    }
  });
  document.querySelector<HTMLButtonElement>('[data-refresh-materials]')!.addEventListener('click', () => { void refreshProjectMaterials(projectId, epoch); });
}

window.addEventListener('hashchange', () => { void renderRoute(); });
document.querySelector('.skip-link')!.addEventListener('click', event => {
  event.preventDefault(); document.querySelector<HTMLElement>('#main')?.focus();
});
window.addEventListener('beforeunload', event => {
  const activeUploads = [...localUploads.values()].some(uploads => uploads.some(upload => ['hashing', 'uploading', 'saving'].includes(upload.phase)));
  if (newDirty || creating || draft?.dirty || draft?.state === 'saving' || activeUploads) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !identity) return;
  const expected = identity;
  void api.me().then(me => { if (identity === expected && me.user_id !== expected) signedOut('账号已更改，请重新登录。'); }).catch(() => {});
});

async function start() {
  const token = ++epoch;
  try {
    const me = await api.me();
    if (token !== epoch) return;
    identity = me.user_id; await renderRoute();
  } catch (error) {
    if (token !== epoch) return;
    renderLogin(error instanceof ApiError && error.status === 401 ? '' : friendlyError(error));
  }
}
void start();
