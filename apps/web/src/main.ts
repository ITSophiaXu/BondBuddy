import { ApiClient, ApiError, friendlyError, type Dto } from './api';
import { Draft } from './draft';
import './style.css';

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
let items: Dto<'ProjectListResponse'>['items'] = [];
let nextCursor: string | null = null;
let listBusy = false;
const sessionChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('bondbuddy-session') : undefined;
const api = new ApiClient(() => signedOut(identity ? '登录已失效。已保存的项目会在重新登录后恢复。' : ''));

function clearPrivateState() {
  epoch++; api.reset(); draft?.dispose(); draft = undefined;
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
  button.disabled = true;
  if (draft && (draft.dirty || draft.state === 'saving') && !await draft.save()) {
    if (!identity) return;
    if (!window.confirm('仍有未保存的修改。退出会放弃这些修改，是否退出？')) { button.disabled = false; return; }
  }
  try {
    await api.logout(); signedOut(); sessionChannel?.postMessage('changed');
  } catch (error) { showError(error); button.disabled = false; }
}

async function renderRoute() {
  if (!identity) return;
  const requested = location.hash.slice(1) || '/';
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
  shell(`<a class="back-link" href="#/">← 返回我的项目</a><div class="page-heading"><div><p class="eyebrow">募集书更新</p><h1>新建项目</h1><p class="muted">先保存基本资料，之后可以随时回来继续。</p></div></div>
    <div class="detail-layout"><section class="panel form-panel"><h2>项目基本信息</h2><form id="create-form"><label for="name">项目名称 <span class="required">必填</span></label><input id="name" name="name" required maxlength="120" placeholder="例如：发行人 2026 年募集书更新"/>
    <label for="issuer">发行人全称 <span class="optional">选填</span></label><input id="issuer" name="issuer" maxlength="500" placeholder="填写发行人完整名称"/>
    <p id="page-error" class="form-message" role="alert" hidden></p><div class="form-actions"><button class="button primary" type="submit">创建并保存项目</button><a class="button secondary" href="#/">取消</a></div></form></section>
    <aside class="context-panel"><h2>从资料准备开始</h2><p>项目按账号保存，重新登录后仍可访问。</p><p>创建项目只保存资料，不会启动全文更新。</p></aside></div>`, 'new');
  document.querySelector<HTMLFormElement>('#create-form')!.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const button = form.querySelector<HTMLButtonElement>('button')!;
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    if (!name) { showError(new ApiError(422, 'INPUT_REQUIRED')); return; }
    button.disabled = true; button.textContent = '正在保存…';
    const token = epoch;
    try {
      const project = await api.create({ name, kind: 'update', issuer_name: (form.elements.namedItem('issuer') as HTMLInputElement).value.trim() || null, market: null, offering: null });
      if (token !== epoch) return;
      location.hash = `/projects/${encodeURIComponent(project.project_id)}`;
    } catch (error) { if (token === epoch) showError(error); }
    finally { button.disabled = false; button.textContent = '创建并保存项目'; }
  });
}

function renderProject(project: Dto<'ProjectResponse'>) {
  shell(`<a class="back-link" href="#/">← 返回我的项目</a><div class="page-heading"><div><p class="eyebrow">项目工作区</p><h1 id="project-heading">${esc(project.name)}</h1><p class="muted">管理本次更新的基本资料。</p></div><span class="save-badge" id="save-state" role="status">已保存</span></div>
    <div class="detail-layout"><section class="panel form-panel"><div class="panel-heading"><h2>项目基本信息</h2><span class="muted">修改后自动保存</span></div><form id="draft-form">
    <label for="name">项目名称 <span class="required">必填</span></label><input id="name" name="name" value="${esc(project.name)}" required maxlength="120"/>
    <label for="issuer">发行人全称 <span class="optional">选填</span></label><input id="issuer" name="issuer" value="${esc(project.issuer_name)}" maxlength="500"/>
    <p id="page-error" class="form-message" role="alert" hidden></p><div id="conflict-panel" class="conflict-panel" hidden><p>当前输入未覆盖其他页面的修改。可以复制保留输入，再加载最新资料。</p><button class="button secondary" type="button" id="reload-draft">放弃当前输入并加载最新资料</button></div>
    <div class="form-actions"><button id="save-draft" class="button primary" type="submit" disabled>保存修改</button><span class="muted" id="saved-time">${esc(date(project.updated_at))} 保存</span></div></form></section>
    <aside class="context-panel"><h2>资料已留在这里</h2><p>刷新页面或重新登录，可以继续编辑已保存的资料。</p><p>这里的修改用于后续工作，不会改变已经开始的任务或已有成果。</p><div class="context-divider"></div><h3>下一步</h3><p>材料上传、完整编制表单与全文更新将在完成验证后开放。</p></aside></div>`, 'projects');
  draft = new Draft(project, api, updateSaveState);
  const form = document.querySelector<HTMLFormElement>('#draft-form')!;
  const updateFields = () => {
    draft?.edit({ name: (form.elements.namedItem('name') as HTMLInputElement).value, issuer_name: (form.elements.namedItem('issuer') as HTMLInputElement).value });
  };
  form.addEventListener('input', event => { if (!(event as InputEvent).isComposing) updateFields(); });
  form.addEventListener('compositionend', updateFields);
  form.addEventListener('submit', event => { event.preventDefault(); void draft?.save(); });
  document.querySelector('#reload-draft')!.addEventListener('click', () => {
    if (!window.confirm('加载最新资料会放弃当前未保存的输入，是否继续？')) return;
    draft?.dispose(); draft = undefined; void renderRoute();
  });
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
  error.hidden = !draft.error;
  error.textContent = draft.error ? friendlyError(draft.error) : '';
  if (draft.state === 'saved') {
    document.querySelector('#project-heading')!.textContent = draft.project.name;
    document.querySelector('#saved-time')!.textContent = `${date(draft.project.updated_at)} 保存`;
  }
}

window.addEventListener('hashchange', () => { void renderRoute(); });
document.querySelector('.skip-link')!.addEventListener('click', event => {
  event.preventDefault(); document.querySelector<HTMLElement>('#main')?.focus();
});
window.addEventListener('beforeunload', event => {
  if (draft?.dirty || draft?.state === 'saving') { event.preventDefault(); event.returnValue = ''; }
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
