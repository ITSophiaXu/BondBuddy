import { Dashboard } from './dashboard';
import { BillingPage } from './billing-page';
import { projectListContext, withProjectContext, projectBackLink } from './project-navigation';
import { prototypeIcon, workspaceSteps } from './prototype-design';
import { renderRecoveryPage } from './recovery';
import { ProjectBrowser } from './project-browser';
import { ArtifactPage } from './artifact-page';
import { ProjectExecution } from './project-execution';
import { ProjectConversation } from './project-conversation';
import { ReviewWorkspace, renderNewReview, reviewProjectFields, bindReviewProjectFields } from './review-workspace';
import { renderOcrReview, canLeaveOcrReview, disposeOcrReview } from './ocr-review';
import './ocr-review.css';
import { ApiClient, ApiError, errorReference, friendlyError, type Dto } from './api';
import { sourceFields, readSourceFields, sourcePeriodSummary, sourceRequiredMessage, clearSourceSelections } from './source-prospectus.js';
import { retainUpdateDetails } from './update-form.js';
import { uploadErrorMessage } from './upload-error';
import { Draft } from './draft';
import { blankDraft, validateDraft } from './form-model';
import { bindUpdateForm, readUpdateForm, updateFormFields } from './update-form';
import { renderAccount, renderClosed, type AccountContext } from './account';
import { bindDeletionActions, renderDataPolicyPage, renderUploadPolicyNote } from './data-policy';
import { date, esc, icon } from './ui';
import { agreementHref, PASSWORD_HELP, registerErrorMessage, USERNAME_HELP, USERNAME_PATTERN, validateRegister } from './register';
import { referenceSnapshotResolver } from './reference';
import { MaterialProcessing, materialProcessingKey } from './material-processing';
import './material-processing.css';
import { M1_MATERIAL_PARTITIONS, M1_UPLOAD_MIME_TYPES, M1_UPLOAD_LIMITS, FUNDING_PURPOSES } from '@bondbuddy/contracts';
import './style.css';
import './update-form.css';
import '../../../product-prototype/public/styles.css';
import '../../../product-prototype/public/project-workspace.css';
import './prototype-adapter.css';
import './quarter-controls.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const folder = icon('M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z');
const plus = icon('M12 5v14M5 12h14');
const person = icon('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20a8 8 0 0 1 16 0');
let identity: string | undefined;
let epoch = 0;
let currentRoute = '/';
let draft: Draft | undefined;
let newDirty = false;
let creating = false;
let projectBrowser: ProjectBrowser | undefined;
let dashboard: Dashboard | undefined;
let billingPage: BillingPage | undefined;
let artifactPage: ArtifactPage | undefined;
let projectExecution: ProjectExecution | undefined;
let staleInputNoticeProjectId: string | undefined;
let projectConversation: ProjectConversation | undefined;
let reviewWorkspace: ReviewWorkspace | undefined;

type UploadRole = Dto<'UploadCreateRequest'>['role'];
type UploadPhase = 'queued' | 'hashing' | 'checking' | 'uploading' | 'saving' | 'persisted' | 'failed' | 'cancelled' | 'uncertain';
type LocalUpload = { key: string; owner: string; projectId: string; role: UploadRole; file: File; phase: UploadPhase; sentBytes: number; material?: Dto<'MaterialResponse'>; error?: string; controller?: AbortController; hash?: string; session?: Dto<'UploadSessionResponse'> };
let runningUploads = 0;
type MaterialRecovery = { state: 'loading' | 'ready' | 'unavailable'; message?: string };
const localUploads = new Map<string, LocalUpload[]>();
const recoveredMaterials = new Map<string, Dto<'MaterialResponse'>[]>();
const recoveryStates = new Map<string, MaterialRecovery>();
const recoveryControllers = new Map<string, AbortController>();
let materialProcessing: MaterialProcessing | undefined;
const mimeByExtension: Record<string, typeof M1_UPLOAD_MIME_TYPES[number]> = {
  docx: M1_UPLOAD_MIME_TYPES[0], pdf: M1_UPLOAD_MIME_TYPES[1], xlsx: M1_UPLOAD_MIME_TYPES[2],
  csv: M1_UPLOAD_MIME_TYPES[3], txt: M1_UPLOAD_MIME_TYPES[4], png: M1_UPLOAD_MIME_TYPES[5],
  jpg: M1_UPLOAD_MIME_TYPES[6], jpeg: M1_UPLOAD_MIME_TYPES[6]
};
const sessionChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('bondbuddy-session') : undefined;
const api = new ApiClient(() => signedOut(identity ? '登录已失效。已保存的项目会在重新登录后恢复。' : ''));
const accountPage: AccountContext = {
  api, shell, epoch: () => epoch, reload: () => { void renderRoute(); },
  closed: result => {
    clearPrivateState();
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    currentRoute = '/'; sessionChannel?.postMessage('changed');
    renderClosed(root, result, () => renderLogin());
  }
};

function clearPrivateState() {
  clearSourceSelections();
  reviewWorkspace?.dispose(); reviewWorkspace = undefined;
  dashboard?.dispose(); dashboard = undefined;
  billingPage?.dispose(); billingPage = undefined;
  artifactPage?.dispose(); artifactPage = undefined;
  projectExecution?.dispose(); projectExecution = undefined;
  projectConversation?.dispose(); projectConversation = undefined;
  staleInputNoticeProjectId = undefined;
  disposeOcrReview();
  materialProcessing?.dispose(); materialProcessing = undefined;
  for (const uploads of localUploads.values()) for (const upload of uploads) upload.controller?.abort();
  for (const controller of recoveryControllers.values()) controller.abort();
  localUploads.clear(); recoveredMaterials.clear(); recoveryStates.clear(); recoveryControllers.clear();
  epoch++; api.reset(); draft?.dispose(); draft = undefined; newDirty = false; creating = false;
  identity = undefined; projectBrowser?.dispose(); projectBrowser = undefined;
}

function signedOut(message = '') {
  const anonymous = !identity && !message, hash = location.hash;
  clearPrivateState();
  currentRoute = '/';
  if (anonymous) { routeSignedOut(hash); return; } // e.g. the first /me 401 on #/register or #/data-policy
  history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  renderLogin(message);
}
sessionChannel?.addEventListener('message', () => signedOut('账号会话已在其他页面更改，请重新登录。'));

let signedOutView = false;
let recoveryToken: string | undefined;
function captureResetToken() {
  const match=location.hash.match(/^#\/reset\/([A-Za-z0-9_-]{43})$/);
  if(!match)return false;
  recoveryToken=match[1];
  history.replaceState(null,'',`${location.pathname}${location.search}#/reset`);
  return true;
}
function publicRecovery(mode: 'request' | 'reset') {
  signedOutView=true;
  const token=++epoch;
  void renderRecoveryPage(api,root,mode,recoveryToken,()=>token===epoch,()=>{
    recoveryToken=undefined;signedOut('密码已重置，请使用新密码重新登录。');sessionChannel?.postMessage('changed');
  });
}
function routeSignedOut(hash = location.hash) {
  epoch++;
  const route = ['#/data-policy', '#/register', '#/recover', '#/reset'].includes(hash) ? hash : '#/';
  if(route!=='#/reset')recoveryToken=undefined;
  if (location.hash !== route) history.replaceState(null, '', `${location.pathname}${location.search}${route}`);
  if (route === '#/recover') publicRecovery('request');
  else if (route === '#/reset') publicRecovery('reset');
  else if (route === '#/data-policy') renderPublicPolicy();
  else if (route === '#/register') renderLogin('', 'register');
  else renderLogin();
}

// The agreement links here, so the data-policy page is also readable before an account exists.
function renderPublicPolicy() {
  signedOutView = true;
  const token = ++epoch;
  void renderDataPolicyPage(api, content => {
    root.innerHTML = `<main id="main" class="closed-layout" tabindex="-1"><div class="panel closed-panel"><a class="brand" href="#/"><img src="/favicon.svg" alt=""/>BondBuddy</a>${content.replace('← 返回我的项目', '← 返回登录')}</div></main>`;
  }, () => token === epoch && !identity);
}

function renderLogin(message = '', mode: 'login' | 'register' = 'login') {
  signedOutView = true;
  const registering = mode === 'register';
  const form = registering
    ? `<form id="register-form" novalidate><label for="reg-username">用户名</label><input id="reg-username" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="${USERNAME_PATTERN}" autocapitalize="none" spellcheck="false" aria-describedby="reg-username-help"/>
      <p id="reg-username-help" class="settings-note">${esc(USERNAME_HELP)}</p>
      <label for="reg-password">密码</label><input id="reg-password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128" aria-describedby="reg-password-help"/>
      <p id="reg-password-help" class="settings-note">${esc(PASSWORD_HELP)}</p>
      <label for="reg-confirm">确认密码</label><input id="reg-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="128"/>
      <div id="agreement" class="check-row agreement-row"><span class="muted">正在读取用户协议…</span></div>
      <p id="login-message" class="form-message" role="status">${esc(message)}</p><button class="button primary" type="submit" disabled>注册并进入工作区</button></form>
      <p class="switch-note">已有账号？<a id="to-login" href="#/">登录</a></p>`
    : `<form id="login-form"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" autocapitalize="none" spellcheck="false"/>
      <label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="512"/>
      <p id="login-message" class="form-message" role="status">${esc(message)}</p><button class="button primary" type="submit">登录</button></form>
      <p class="switch-note">没有账号？<a id="to-register" href="#/register">注册</a></p><p id="login-recovery" class="switch-note"></p>`;
  root.innerHTML = `<main id="main" class="login-layout" tabindex="-1">
    <div class="login-intro"><a class="brand" href="#/"><img src="/favicon.svg" alt=""/>BondBuddy</a>
      <div><p class="eyebrow">债券项目工作空间</p><h1>把每一次准备，<br/>接着做下去。</h1><p>项目资料按账号保存。重新登录，<br/>继续上次的工作。</p></div>
      <p class="intro-foot">有据可查 · 有序协作</p></div>
    <section class="login-panel" aria-labelledby="login-title">${registering
      ? '<p class="eyebrow">创建账号</p><h2 id="login-title">注册工作区账号</h2><p class="muted">设置用户名和密码，注册后直接进入工作区。</p>'
      : '<p class="eyebrow">欢迎回来</p><h2 id="login-title">登录工作区</h2><p class="muted">使用已有的用户名和密码登录。</p>'}
      ${form}
      <p class="privacy-note">项目资料保存在平台工作区，仅限当前账号访问。</p></section></main>`;
  if (registering) bindRegister(); else {
    bindLogin();
    const link=document.querySelector<HTMLElement>('#login-recovery');
    void api.recoveryInfo().then(info=>{if(link?.isConnected && info.enabled)link.innerHTML='<a href="#/recover">忘记密码？联系客服找回</a>';}).catch(()=>{});
  }
}

function bindLogin() {
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
      identity = result.user_id; signedOutView = false; sessionChannel?.postMessage('changed');
      history.replaceState(null, '', `${location.pathname}${location.search}#dashboard`);
      await renderRoute();
    } catch (error) {
      if (token !== epoch) return;
      feedback.textContent = error instanceof ApiError && error.status === 401 ? '用户名或密码不正确，请重试。' : friendlyError(error);
    } finally { button.disabled = false; button.textContent = '登录'; }
  });
}

function bindRegister() {
  const form = document.querySelector<HTMLFormElement>('#register-form')!;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const feedback = form.querySelector<HTMLElement>('#login-message')!;
  const agreementBox = form.querySelector<HTMLElement>('#agreement')!;
  let termsVersion: string | undefined;
  const token = ++epoch;
  api.agreement().then(agreement => {
    if (token !== epoch) return;
    termsVersion = agreement.terms_version;
    agreementBox.innerHTML = `<input id="reg-agree" name="agree" type="checkbox" required/><label for="reg-agree">我已阅读并同意<a href="${esc(agreementHref(agreement.summary_url_or_path))}" target="_blank" rel="noopener">《${esc(agreement.title)}》</a>（版本 <span id="terms-version">${esc(agreement.terms_version)}</span>）${agreement.support_contact ? `，如有疑问请联系 ${esc(agreement.support_contact)}` : ''}。</label>`;
    button.disabled = false;
  }, error => {
    if (token !== epoch) return;
    agreementBox.innerHTML = `<span class="form-message">${esc(registerErrorMessage(error instanceof ApiError ? error : new ApiError(0, 'DATA_UNAVAILABLE')))}</span>`;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!termsVersion) return;
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    const input = { username: value('username').trim(), password: value('password'), confirm: value('confirm'), agreed: (form.elements.namedItem('agree') as HTMLInputElement).checked };
    const invalid = validateRegister(input);
    if (invalid) { feedback.textContent = invalid; return; }
    button.disabled = true; button.textContent = '正在注册…'; feedback.textContent = '';
    api.reset();
    const submit = ++epoch;
    try {
      const result = await api.register({ username: input.username, password: input.password, accepted_terms_version: termsVersion });
      if (submit !== epoch) return;
      identity = result.user_id; signedOutView = false; sessionChannel?.postMessage('changed');
      history.replaceState(null, '', `${location.pathname}${location.search}#dashboard`);
      await renderRoute();
    } catch (error) {
      if (submit !== epoch) return;
      feedback.textContent = registerErrorMessage(error);
      button.disabled = false; button.textContent = '注册并进入工作区';
    }
  });
}

function shell(content: string, section: string) {
  const nav = (route: string, ico: string, label: string, active: boolean, pending = false) => `<a href="#${route}" class="nav-item ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${prototypeIcon(ico)}<span>${label}</span>${pending ? '<small class="nav-pending">未开放</small>' : ''}</a>`;
  root.innerHTML = `<div class="prototype-app"><aside class="sidebar" id="sidebar"><button class="mobile-menu-close icon-btn" id="close-menu" aria-label="关闭菜单">${prototypeIcon('close')}</button><a class="brand" href="#dashboard"><img src="/favicon.svg" alt=""/>bondbuddy<small>BETA</small></a>
    <div class="workspace"><div class="workspace-icon">${prototypeIcon('building')}</div><div><strong>我的工作空间</strong><small>PERSONAL WORKSPACE</small></div></div>
    <nav aria-label="主导航">${nav('dashboard','grid','工作台',section === 'dashboard')}<div class="nav-label">开始工作</div>${nav('update','update','更新募集书',section === 'new' || section === 'workspace')}${nav('review','review','复核募集书',section === 'review')}${nav('generate','spark','材料生成',section === 'generate',true)}${nav('qa','chat','项目问答',section === 'qa',true)}<div class="nav-label">工作空间</div>${nav('tasks','folder','全部项目',section === 'projects')}${section==='review'?'':nav('billing','shield','积分与充值',section === 'billing')}</nav>
    <div class="sidebar-bottom"><nav aria-label="账号">${nav('/account','settings','账号设置',section === 'account')}<a class="nav-item" href="#/data-policy">${prototypeIcon('lock')}数据保存与删除</a></nav><div class="user account"><span class="avatar">我</span><div><strong>我的工作空间</strong><small>已登录</small></div><button id="logout" class="text-button" type="button">退出</button></div></div></aside>
    <div class="shell"><header class="topbar"><div class="breadcrumb"><button class="mobile-menu icon-btn" id="toggle-menu" aria-label="打开菜单" aria-expanded="false">${prototypeIcon('menu')}</button><span>工作空间</span>${prototypeIcon('chevron')}<span>${section === 'dashboard' ? '工作台' : section === 'new' || section === 'workspace' ? '更新募集书' : section === 'review' ? '复核募集书' : section === 'account' ? '账号设置' : section === 'policy' ? '数据说明' : section === 'billing' ? '积分与充值' : '全部项目'}</span></div><div class="top-actions">${section==='review'?'<span class="trial">复核免费</span>':'<a class="top-plan-link" href="#billing">积分与充值</a>'}<a href="#/data-policy">${prototypeIcon('help')}使用说明</a></div></header>
    <main id="main" tabindex="-1">${content}</main></div></div>`;
  document.querySelector('#logout')!.addEventListener('click', () => { void logout(); });
  const menu = document.querySelector<HTMLButtonElement>('#toggle-menu')!;
  document.querySelector('#close-menu')!.addEventListener('click', () => { document.querySelector('#sidebar')!.classList.remove('mobile-open'); menu.setAttribute('aria-expanded','false'); menu.setAttribute('aria-label','打开菜单'); menu.focus(); });
  menu.addEventListener('click', () => { const open = document.querySelector('#sidebar')!.classList.toggle('mobile-open'); menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单'); });
}

function showError(error: unknown) {
  const target = document.querySelector<HTMLElement>('#page-error');
  if (target) { target.textContent = friendlyError(error); target.hidden = false; }
}

async function logout() {
  const button = document.querySelector<HTMLButtonElement>('#logout');
  if (!button) return;
  if (creating) return;
  if (reviewWorkspace && !await reviewWorkspace.beforeLeave()) return;
  if (newDirty && !window.confirm('当前新项目尚未保存。退出会放弃这些填写内容，是否继续？')) return;
  if (projectConversation?.hasUnsent && !window.confirm('还有未发送或保存结果未确认的消息。退出后本页输入将无法恢复，是否继续？')) return;
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
  const raw = location.hash.slice(1);
  const requested = !raw || raw === 'dashboard' ? '/dashboard' : raw === 'update' ? '/new' : raw.startsWith('tasks') ? '/' + raw.slice(5) : raw;
  const nextRoute = requested.replace(/\?step=(details|materials)$/, '');
  if (reviewWorkspace && !await reviewWorkspace.beforeLeave()) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${currentRoute}`); return;
  }
  if (!identity || location.hash.slice(1) !== raw) return;
  if (!canLeaveOcrReview() || creating || (newDirty && !window.confirm('当前新项目尚未保存，离开会放弃填写内容，是否继续？')) ||
      nextRoute !== currentRoute && projectConversation?.hasUnsent &&
      !window.confirm('还有未发送或保存结果未确认的消息。离开后本页输入将无法恢复，是否继续？')) {
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
  projectBrowser?.dispose(); projectBrowser = undefined;
  dashboard?.dispose(); dashboard = undefined;
  artifactPage?.dispose(); artifactPage = undefined;
  projectExecution?.dispose(); projectExecution = undefined;
  projectConversation?.dispose(); projectConversation = undefined;
  reviewWorkspace?.dispose(); reviewWorkspace = undefined;
  disposeOcrReview();
  materialProcessing?.dispose(); materialProcessing = undefined;
  currentRoute = nextRoute;
  if (requested === '/dashboard') { dashboard = new Dashboard(api, shell, () => token === epoch); await dashboard.render(); return; }
  if (requested === 'review') { renderNewReview(api, shell, () => token === epoch); return; }
  if(requested==='billing'||requested.startsWith('billing?')||requested.startsWith('payment/')){
    const project=new URLSearchParams(requested.split('?')[1]??'').get('project')??undefined;
    billingPage=new BillingPage(api,shell,()=>token===epoch,project,requested.startsWith('payment/')?decodeURIComponent(requested.slice(8)):undefined);
    await billingPage.render();return;
  }
  if (['generate','qa'].includes(requested)) {
    const labels: Record<string,string> = { review:'复核募集书',generate:'材料生成',qa:'项目问答',billing:'积分与充值' };
    shell(`<div class="page-head"><div class="eyebrow">BOND WORKSPACE</div><h1>${labels[requested]}</h1></div><section class="panel unavailable-panel"><h2>这项功能尚未开放</h2><p>你可以先创建募集书更新项目，准备材料和发行安排。</p><a class="btn primary" href="#update">更新募集书</a><a class="btn secondary" href="#dashboard">返回工作台</a></section>`, requested); return;
  }
  if (requested === '/new') { renderNew(); return; }
  if (requested === '/account') { await renderAccount(accountPage); return; }
  if (requested === '/data-policy') { await renderDataPolicyPage(api, shell, () => token === epoch); return; }
  if (requested === '/' || requested.startsWith('/?')) { projectBrowser = new ProjectBrowser(api,shell,() => token === epoch); await projectBrowser.render(); return; }
  const artifactMatch = requested.match(/^\/artifacts\/([^/]+)$/);
  if (artifactMatch) { artifactPage = new ArtifactPage(api, shell, () => token === epoch); await artifactPage.render(decodeURIComponent(artifactMatch[1])); return; }
  const ocrMatch = requested.match(/^\/projects\/([^/]+)\/materials\/([^/]+)\/ocr$/);
  if (ocrMatch) { await renderOcrReview({api,shell,epoch:()=>epoch},decodeURIComponent(ocrMatch[1]),decodeURIComponent(ocrMatch[2])); return; }
  const reviewMatch = requested.match(/^\/projects\/([^/?]+)\/review(?:\?(.*))?$/);
  if (reviewMatch) {
    const query = new URLSearchParams(reviewMatch[2]);
    reviewWorkspace = new ReviewWorkspace(api, identity, decodeURIComponent(reviewMatch[1]), shell, () => token === epoch, query.get('report_id') || undefined, query.get('tab') || undefined);
    await reviewWorkspace.render(); return;
  }
  const match = requested.match(/^\/projects\/([^/?]+)(?:\?(.*))?$/);
  if (!match) { location.hash = '/'; return; }
  shell('<p role="status">正在读取项目…</p><p id="page-error" role="alert" hidden></p>', 'projects');
  try {
    const project = await api.project(decodeURIComponent(match[1]));
    if (token !== epoch) return;
    const projectQuery = new URLSearchParams(match[2]);
    if (project.kind === 'review') {
      if (projectQuery.get('step') === 'details') { renderReviewProjectDetails(project, projectQuery); return; }
      reviewWorkspace = new ReviewWorkspace(api, identity!, project.project_id, shell, () => token === epoch);
      await reviewWorkspace.render(); return;
    }
    renderProject(project, projectQuery.get('step') === 'details' ? 'details' : 'materials');
  } catch (error) {
    if (token !== epoch) return;
    shell(`<a class="back-link" href="#/">← 返回我的项目</a><div class="empty-state"><h1>项目暂时无法打开</h1><p>${esc(friendlyError(error))}</p><button class="button secondary" id="retry-project">重新加载</button></div><p id="page-error" role="alert" hidden></p>`, 'projects');
    document.querySelector('#retry-project')!.addEventListener('click', () => { void renderRoute(); });
  }
}

function renderNew() {
  const value = blankDraft();
  shell(`<div class="page-head"><div><div class="eyebrow">PROSPECTUS WORKSPACE</div><h1>更新募集说明书</h1><p>提供项目材料和要求，点击开始即可执行。</p></div><a class="btn secondary" href="#tasks">查看全部项目</a></div>${workspaceSteps(1)}
    <form id="create-form" class="update-form"><div class="workspace-layout authoring-workspace"><section class="panel form-panel form-card">${updateFormFields(value)}
    <p id="page-error" class="form-message" role="alert" hidden></p><div class="form-actions"><button class="button primary" type="submit">创建项目，继续提供材料</button><a class="button secondary" href="#/">取消</a></div></section></div></form>`, 'new');
  const form = document.querySelector<HTMLFormElement>('#create-form')!;
  bindUpdateForm(form, () => { newDirty = true; }, value.update_details);
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
    finally { creating = false; controls.forEach(({ control, disabled }) => { control.disabled = disabled; }); button.textContent = '创建项目，继续提供材料'; }
  });
}

function renderReviewProjectDetails(project: Dto<'ProjectResponse'>, query: URLSearchParams) {
  draft = new Draft(project, api, updateSaveState);
  const returnQuery = withProjectContext(new URLSearchParams({ tab: query.get('review_tab') === 'results' ? 'results' : 'materials' }));
  const reportId = query.get('review_report_id'); if (reportId) returnQuery.set('report_id', reportId);
  const returnHref = `#/projects/${encodeURIComponent(project.project_id)}/review?${returnQuery}`;
  shell(`<div class="review-workspace"><header class="review-header"><div><p class="review-kicker">PROSPECTUS REVIEW</p><h1 id="project-heading">${esc(project.name)}</h1><p>补充复核所需的项目信息，保存后用于下一次明确执行。</p></div><span class="save-badge" id="save-state" role="status">已保存</span></header><form id="draft-form" class="review-panel review-create"><h2>编辑复核项目信息</h2><p class="review-muted">修改后自动保存，已开始的任务保持原输入。</p>${reviewProjectFields(project)}<p id="page-error" class="form-message" role="alert" hidden></p><div id="conflict-panel" class="conflict-panel" hidden><p>其他页面已修改项目信息；当前填写仍保留，请核对后加载最新资料。</p><button class="button secondary" type="button" id="reload-draft">放弃本页修改并加载最新资料</button></div><div class="form-actions"><button id="save-draft" class="button secondary" type="submit" disabled>保存修改</button><span class="muted" id="saved-time">${esc(date(project.updated_at))} 保存</span><a class="btn primary" href="${esc(returnHref)}">返回复核工作区</a></div></form></div>`, projectListContext()?'projects':'review');
  const form = document.querySelector<HTMLFormElement>('#draft-form')!;
  bindReviewProjectFields(form, value => draft?.edit({ ...value, issuer_name: value.issuer_name ?? '' }),project);
  form.addEventListener('submit', event => { event.preventDefault(); void draft?.save(); });
  document.querySelector('#reload-draft')!.addEventListener('click', () => {
    if (!window.confirm('加载最新资料会放弃当前未保存的项目信息，是否继续？')) return;
    draft?.dispose(); draft = undefined; void renderRoute();
  });
}

function renderProject(project: Dto<'ProjectResponse'>, step: 'details' | 'materials' = 'materials') {
  draft = new Draft(project, api, updateSaveState);
  materialProcessing = new MaterialProcessing(api, project.project_id, () => updateProcessingRows(project.project_id));
  materialProcessing.setVisible(document.visibilityState === 'visible');
  const value = { ...draft.fields, kind: project.kind, issuer_name: draft.fields.issuer_name || null };
  shell(`${projectListContext()?projectBackLink:''}<div class="page-head"><div><div class="eyebrow">PROSPECTUS WORKSPACE</div><h1 id="project-heading">${esc(project.name)}</h1><p>提供项目材料和要求，在同一个工作区完成募集书更新。</p></div><div class="heading-actions"><span class="save-badge" id="save-state" role="status">已保存</span><button class="text-button" type="button" id="delete-project">删除项目</button></div></div>
    <div id="workspace-steps">${workspaceSteps(step === 'details' ? 1 : 2)}</div>
    <p id="page-error" class="form-message" role="alert" hidden></p><div id="conflict-panel" class="conflict-panel" hidden><p>当前输入未覆盖其他页面的修改。可以复制保留输入，再加载最新资料。</p><button class="button secondary" type="button" id="reload-draft">放弃当前输入并加载最新资料</button></div>
    <div class="workspace-layout authoring-workspace"><div class="workspace-main">
      <form id="draft-form" class="update-form" ${step === 'materials' ? 'hidden' : ''}><section class="panel form-card"><p class="field-hint">修改后自动保存；未确定的选填内容可留空。</p>${updateFormFields(value)}
      <div class="form-actions"><button id="save-draft" class="button secondary" type="submit" disabled>保存修改</button><span class="muted" id="saved-time">${esc(date(project.updated_at))} 保存</span></div></section><div class="form-footer"><a href="#tasks">查看全部项目</a><button id="continue-materials" type="button" class="btn primary">保存并继续 ${prototypeIcon('arrow')}</button></div></form>
      <div id="workspace-materials" ${step === 'details' ? 'hidden' : ''}>
        <div class="project-strip"><span>${prototypeIcon('file')}全文更新</span><button id="edit-project-details" class="text-btn" type="button">编辑项目信息</button><span id="workspace-material-count">正在读取材料…</span></div>
        <div id="workspace-progress"></div>
    <details id="project-materials-details" class="project-materials-details" open><summary>项目信息与材料 <span>随时查看与补充</span></summary><section class="panel materials-panel" aria-labelledby="materials-title"><div class="panel-heading materials-heading"><div><h2 id="materials-title">提供项目材料</h2><p class="muted">按分区添加材料。单份不超过 100 MB，每个项目最多 60 份、合计 500 MB。相同分区重复上传相同内容会复用已保存版本。</p></div><button class="button secondary" type="button" data-refresh-materials>刷新已保存材料</button></div>
    <p id="material-recovery-status" class="material-recovery-status" role="status"></p><div id="material-partitions">${renderMaterialPartitions(project.project_id)}</div>
    <p class="material-policy-note" id="upload-policy-note"></p><p class="material-footnote">选中文件后立即上传；未成功的文件可单独重试。</p></section><div id="project-conversation-root" hidden></div></details>
        <div id="execution-root"></div>
        <div class="form-footer authoring-actions"><button type="button" class="btn secondary" id="previous-details">上一步</button><div id="execution-actions"></div></div>
      </div></div></div>`, projectListContext()?'projects':'workspace');
  projectConversation = new ProjectConversation(api, project.project_id, () => projectExecution?.conversationChanged(), '', async text => {
    if (!draft) return false;
    const details = { ...draft.fields.update_details, supplementary_notes: text || null };
    draft.edit({ update_details: details });
    retainUpdateDetails(document.querySelector<HTMLFormElement>('#draft-form')!, details);
    return draft.save();
  });
  projectConversation.mount(document.querySelector<HTMLElement>('#project-conversation-root')!, value);
  const setStep = async (next: 'details' | 'materials') => {
    if (next === 'materials' && !await draft?.save()) return;
    if (!document.querySelector('#draft-form')) return;
    document.querySelector<HTMLElement>('#draft-form')!.hidden = next !== 'details';
    document.querySelector<HTMLElement>('#workspace-materials')!.hidden = next !== 'materials';
    document.querySelector('#workspace-steps')!.innerHTML = workspaceSteps(next === 'details' ? 1 : 2);
    history.replaceState(null, '', `${location.pathname}${location.search}#/projects/${encodeURIComponent(project.project_id)}?${withProjectContext(new URLSearchParams({step:next}))}`);
    document.querySelector('#workspace-steps')!.scrollIntoView({ block: 'start' });
  };
  document.querySelector('#continue-materials')!.addEventListener('click', () => { void setStep('materials'); });
  for (const id of ['edit-project-details','previous-details']) document.querySelector(`#${id}`)!.addEventListener('click', () => { void setStep('details'); });
  // No-history projects enter the controlled generation path with the same execution surface.
  if (project.kind === 'update' || project.kind === 'generation') {
    projectExecution = new ProjectExecution(api, draft, projectConversation,
      referenceSnapshotResolver((projectId, materialId) => api.material(projectId, materialId)),
      () => {
        staleInputNoticeProjectId = project.project_id;
        if (draft?.dirty || draft?.state === 'saving') {
          // The ordinary route refresh saves dirty drafts. A stale input must never
          // turn that old local draft into a write against the refreshed project.
          draft.dispose();
          draft.state = 'conflict';
          updateSaveState();
          document.querySelector('#conflict-panel p')!.textContent =
            '项目已保存更新的版本，当前未保存内容不会自动写回。请复制需要保留的文字，再加载最新资料。';
          return;
        }
        void renderRoute();
      },
      staleInputNoticeProjectId === project.project_id ? '项目已保存更新的输入版本，请核对最新材料与目标后重新开始。' : '');
    if (staleInputNoticeProjectId === project.project_id) staleInputNoticeProjectId = undefined;
    projectExecution.mount(document.querySelector<HTMLElement>('#execution-root')!, document.querySelector<HTMLElement>('#execution-actions')!);
  }
  const form = document.querySelector<HTMLFormElement>('#draft-form')!;
  bindUpdateForm(form, value => { draft?.edit({ name: value.name, issuer_name: value.issuer_name ?? '', market: value.market, offering: value.offering, update_details: value.update_details! }); projectConversation?.setContext(value); updateMaterialWorkspace(project.project_id); }, value.update_details);
  form.addEventListener('submit', event => { event.preventDefault(); void draft?.save(); });
  document.querySelector('#reload-draft')!.addEventListener('click', () => {
    if (!window.confirm('加载最新资料会放弃当前未保存的输入，是否继续？')) return;
    draft?.dispose(); draft = undefined; void renderRoute();
  });
  bindMaterialWorkspace(project.project_id);
  void renderUploadPolicyNote(api, document.querySelector('#upload-policy-note'));
  bindDeletionActions(api, project.project_id, {
    material: () => { void refreshProjectMaterials(project.project_id, epoch); },
    project: () => { draft?.dispose(); draft = undefined; location.hash = '/'; },
    error: showError
  });
  void refreshProjectMaterials(project.project_id, epoch);
}

function updateSaveState() {
  if (!draft) return;
  syncProjectExecution(draft.project.project_id);
  const context = document.querySelector('#cowork-issuer'); if (context) context.textContent = draft.fields.issuer_name || '待填写发行人';
  projectConversation?.setContext({ ...draft.fields, kind: draft.project.kind, issuer_name: draft.fields.issuer_name || null });
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
  if (role === 'historical') return '选填：同企业、母公司、子公司或相似业务企业原稿。优先 Word；PDF 重建后需核对排版。';
  if (role === 'reference') return '无历史稿时可选，可提供你希望参考的募集书';
  if (role === 'audit') return '必需提供审计报告，或财务报表及附注；报表和附注已包含在报告中时无需重复上传';
  if (role === 'financial') return '按所需年度提供；已包含在审计报告中时无需另传';
  if (role === 'interimFinancial') return '需要更新最近一期数据时提供对应报表';
  if (role === 'notes') return '报表附注已包含在审计报告中时无需另传';
  if (role === 'fundUse') {
    const purposes = new Set(draft?.fields.update_details.funding_uses.map(use => use.purpose));
    const hints = FUNDING_PURPOSES.filter(purpose => purposes.has(purpose.code)).map(purpose => purpose.materials);
    return hints.length ? [...new Set(hints)].join(' ') : '按用途提供项目备案、土地及建设许可、基金备案许可或子公司股权投资相关材料';
  }
  if (role === 'feasibility') return '用于项目建设时，建议提供募投项目可行性研究报告';
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
    case 'queued': return '等待上传，已选文件将依次处理…';
    case 'hashing': return '正在检查文件…';
    case 'checking': return '正在核对上次保存结果…';
    case 'uploading': return percent >= 100 ? '已发送 100%，正在保存和核验…' : `正在传输 ${percent}%（${formatBytes(upload.sentBytes)} / ${formatBytes(upload.file.size)}）`;
    case 'saving': return '已发送 100%，正在保存和核验…';
    case 'persisted': return `服务器已确认保存 · 材料版本 ${upload.material?.material_version ?? '—'}${upload.session && upload.material?.upload_id !== upload.session.upload_id ? ' · 已复用相同内容' : ''}`;
    case 'failed': return upload.error ?? '文件未保存。可以单独重试。';
    case 'cancelled': return '本次传输已取消；所选文件仍在此页面，可单独重试。';
    case 'uncertain': return upload.error ?? '保存结果尚未确认。可核对并继续保存，将优先查询原上传记录。';
  }
}

function confirmedMaterials(projectId: string) {
  const materials = new Map((recoveredMaterials.get(projectId) ?? []).map(material => [material.material_id, material]));
  for (const upload of localUploads.get(projectId) ?? []) if (upload.phase === 'persisted' && upload.material && !materials.has(upload.material.material_id)) materials.set(upload.material.material_id, upload.material);
  return [...materials.values()];
}

function updateProcessingRows(projectId: string) {
  if (currentRoute !== `/projects/${projectId}` || !materialProcessing) return;
  const materials = new Map(confirmedMaterials(projectId).map(material => [materialProcessingKey(material), material]));
  for (const element of document.querySelectorAll<HTMLElement>('[data-material-processing]')) {
    const material = materials.get(element.dataset.materialProcessing!);
    if (!material) continue;
    const focused = element.contains(document.activeElement);
    const template = document.createElement('template');
    template.innerHTML = materialProcessing.render(material);
    const replacement = template.content.firstElementChild!;
    if (element.outerHTML !== replacement.outerHTML) {
      element.replaceWith(replacement);
      if (focused) replacement.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    }
  }
}

function renderUploadRow(upload: LocalUpload) {
  const active = ['queued', 'hashing', 'checking', 'uploading', 'saving'].includes(upload.phase);
  const showProgress = ['uploading', 'saving'].includes(upload.phase);
  const progress = Math.min(upload.file.size, upload.sentBytes);
  const controls = upload.phase === 'failed' || upload.phase === 'cancelled'
    ? `<button type="button" class="text-button" data-upload-action="retry" data-upload-key="${esc(upload.key)}">重试此文件</button>`
    : upload.phase === 'uncertain'
      ? `<button type="button" class="text-button" data-upload-action="retry" data-upload-key="${esc(upload.key)}">核对并继续保存</button>`
      : active
        ? `<button type="button" class="text-button" data-upload-action="cancel" data-upload-key="${esc(upload.key)}">${upload.sentBytes >= upload.file.size ? '停止等待并核对' : '取消此文件'}</button>`
        : '';
  const canRemove = ['failed', 'cancelled', 'uncertain'].includes(upload.phase)
    ? `<button type="button" class="text-button" data-upload-action="remove" data-upload-key="${esc(upload.key)}">移除此行</button>`
    : '';
  const processing = upload.phase === 'persisted' && upload.material ? (materialProcessing?.render(upload.material) ?? '') : '';
  return `<li class="material-file-row" data-upload-phase="${upload.phase}"><div class="material-file-main"><strong>${esc(upload.file.name)}</strong><span>${esc(roleLabel(upload.role))} · ${formatBytes(upload.file.size)}</span>${showProgress ? `<progress max="${upload.file.size}" value="${progress}" aria-label="${esc(upload.file.name)} 字节传输进度"></progress>` : ''}<p class="material-file-status${upload.phase === 'failed' ? ' material-file-error' : ''}" role="${upload.phase === 'failed' ? 'alert' : 'status'}">${esc(uploadStatus(upload))}</p>${processing}${upload.material ? sourceFields(upload.material, draft?.fields.update_details.source_prospectuses) : ''}</div>${controls || canRemove ? `<div class="material-file-actions">${controls}${canRemove}</div>` : ''}</li>`;
}

function renderMaterialPartitions(projectId: string) {
  const seen = new Set<string>();
  const uploads = (localUploads.get(projectId) ?? []).filter(upload => {
    if (upload.phase !== 'persisted' || !upload.material) return true;
    if (seen.has(upload.material.material_id)) return false;
    seen.add(upload.material.material_id); return true;
  });
  const materials = recoveredMaterials.get(projectId) ?? [];
  const history = null;
  const localMaterialIds = new Set(uploads.flatMap(upload => upload.material ? [upload.material.material_id] : []));
  // Product partitions from project-workspace.js; detailed role values still come from contracts.
  const partitions: { label: string; roles: readonly {code: UploadRole; label: string}[]; primary: UploadRole }[] = [
    {label:'历史／参考募集书（选填）',roles:M1_MATERIAL_PARTITIONS[0].roles.filter(role => role.code === 'historical' || materials.some(m => m.role === role.code)).map(role => ({...role,label:role.code === 'historical' ? '历史／参考募集书' : '已保存参考稿'})),primary:'historical'},
    {label:'审计报告 / 财务报表及附注',roles:M1_MATERIAL_PARTITIONS[1].roles,primary:'audit'},
    {label:'募投项目与权证材料',roles:M1_MATERIAL_PARTITIONS[2].roles,primary:'fundUse'},
    {label:'其他项目材料',roles:M1_MATERIAL_PARTITIONS.slice(3).flatMap(p => [...p.roles]),primary:'other'}
  ];
  const groups = partitions.map((partition, index) => `<section class="material-partition" aria-labelledby="material-partition-${index}"><h3 id="material-partition-${index}">${esc(partition.label)}</h3>${[true,false].map(primary => `${primary ? '' : '<details class="material-subtypes"><summary>按细分类别补充材料（选填）</summary>'}<ul class="material-role-list">${partition.roles.filter(role => (role.code === partition.primary) === primary).filter(role => {
    const relevant = role.code === 'historical' ? history !== false : role.code === 'reference' ? history !== true : true;
    return relevant || uploads.some(upload => upload.role === role.code) || materials.some(material => material.role === role.code);
  }).map(role => {
    const canAdd = role.code === 'historical' ? history !== false : role.code === 'reference' ? history !== true : true;
    const roleUploads = uploads.filter(upload => upload.role === role.code);
    const roleMaterials = materials.filter(material => material.role === role.code && !localMaterialIds.has(material.material_id));
    const accept = role.code === 'historical' || role.code === 'reference'
      ? '.docx,.pdf'
      : '.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg';
    const saved = roleMaterials.map(material => `<li class="material-file-row persisted-material"><div class="material-file-main"><strong>${esc(material.filename)}</strong><span>${esc(role.label)} · ${formatBytes(material.byte_size)} · 版本 ${material.material_version}</span><p class="material-file-status">服务器已确认保存</p>${materialProcessing?.render(material) ?? ''}${sourceFields(material, draft?.fields.update_details.source_prospectuses)}<button type="button" class="text-button" data-delete-material="${esc(material.material_id)}">删除</button></div></li>`).join('');
    const picker = canAdd ? `<label class="button secondary material-picker" for="upload-${esc(role.code)}">${prototypeIcon('upload')}<span>点击或拖入文件</span><input id="upload-${esc(role.code)}" type="file" multiple accept="${accept}" aria-label="为${esc(role.label)}选择文件" data-upload-role="${esc(role.code)}"/></label>` : '';
    return `<li class="material-role" data-material-role="${esc(role.code)}"><div class="material-role-heading"><div><strong>${esc(role.label)}</strong><span>${esc(canAdd ? roleGuidance(role.code) : '先前添加的材料仍保留；当前历史稿选项下无需继续添加此类文件')}</span></div>${picker}</div><ul class="material-file-list">${saved}${roleUploads.map(renderUploadRow).join('')}</ul></li>`;
  }).join('')}</ul>${primary ? '' : '</details>'}`).join('')}</section>`).join('');
  return groups;
}

function syncProjectExecution(projectId: string) {
  if (currentRoute !== `/projects/${projectId}`) return;
  const unsettled = (localUploads.get(projectId) ?? []).some(upload => upload.phase !== 'persisted');
  const count = document.querySelector('#workspace-material-count'); if (count) count.textContent = `${confirmedMaterials(projectId).length} 份已保存材料`;
  const recovery = recoveryStates.get(projectId);
  const pending = (localUploads.get(projectId) ?? []).find(upload => upload.phase !== 'persisted');
  const message = recovery?.state === 'unavailable' ? '材料记录读取失败，请点击“刷新已保存材料”重试。'
    : pending ? `${pending.file.name}：${uploadStatus(pending)}`
    : recovery?.state !== 'ready' ? '正在读取已保存材料…' : '';
  projectExecution?.sync(confirmedMaterials(projectId), recovery?.state === 'ready' && !unsettled, message);
}

function updateMaterialWorkspace(projectId: string) {
  syncProjectExecution(projectId);
  if (currentRoute === `/projects/${projectId}`) materialProcessing?.sync(confirmedMaterials(projectId));
  const list = document.querySelector<HTMLElement>('#material-partitions');
  if (list && currentRoute === `/projects/${projectId}`) {
    // Keep file input nodes attached: rebuilding them during recovery/progress can swallow
    // the native file chooser's change event. Only partition changes add/remove pickers.
    const template = document.createElement('template'); template.innerHTML = renderMaterialPartitions(projectId);
    const groups = list.querySelectorAll('.material-role-list');
    template.content.querySelectorAll('.material-role-list').forEach((desired, index) => {
      const group = groups[index]; if (!group) return;
      const existing = new Map([...group.querySelectorAll<HTMLElement>(':scope > .material-role')].map(role => [role.dataset.materialRole!, role]));
      let previous: Element | null = null;
      for (const fresh of [...desired.children] as HTMLElement[]) {
        const old = existing.get(fresh.dataset.materialRole!);
        const role = old ?? fresh;
        if (old) {
          existing.delete(fresh.dataset.materialRole!);
          const heading = old.querySelector('.material-role-heading')!;
          heading.querySelector('div')!.innerHTML = fresh.querySelector('.material-role-heading > div')!.innerHTML;
          const picker = fresh.querySelector('.material-picker'), oldPicker = heading.querySelector('.material-picker');
          if (!picker) oldPicker?.remove(); else if (!oldPicker) heading.append(picker);
          const fileList = old.querySelector('.material-file-list')!;
          if (!fileList.querySelector('[data-source-field]:focus')) fileList.innerHTML = fresh.querySelector('.material-file-list')!.innerHTML;
        }
        const next: Element | null = previous ? previous.nextElementSibling : group.firstElementChild;
        if (next !== role) group.insertBefore(role, next);
        previous = role;
      }
      existing.forEach(role => role.remove());
      const details = group.closest<HTMLDetailsElement>('.material-subtypes');
      const visibleFiles = [...group.querySelectorAll('.material-file-main strong')].map(el => el.textContent).join('\n');
      if (details && visibleFiles && details.dataset.shownFiles !== visibleFiles) { details.open = true; details.dataset.shownFiles = visibleFiles; }
    });
  }
  const status = document.querySelector<HTMLElement>('#material-recovery-status');
  if (!status || currentRoute !== `/projects/${projectId}`) return;
  const state = recoveryStates.get(projectId);
  if (state?.state === 'loading') status.textContent = '正在读取已保存材料…';
  else if (state?.state === 'unavailable') status.textContent = state.message ?? '材料记录读取失败，请刷新重试。';
  else {
    const savedIds = new Set((recoveredMaterials.get(projectId) ?? []).map(material => material.material_id));
    const count = savedIds.size;
    const sessionCount = new Set((localUploads.get(projectId) ?? []).filter(upload => upload.phase === 'persisted' && upload.material && !savedIds.has(upload.material.material_id)).map(upload => upload.material!.material_id)).size;
    status.textContent = count
      ? `已恢复 ${count} 份材料。${sessionCount ? `本次会话另有 ${sessionCount} 份材料已获服务端保存确认。` : ''}`
      : sessionCount
        ? `已保存 ${sessionCount} 份材料。`
        : '尚未添加材料。';
    const reused = (localUploads.get(projectId) ?? []).filter(upload => upload.phase === 'persisted' && upload.session && upload.material?.upload_id !== upload.session.upload_id).length;
    if (reused) status.textContent += ` 本次 ${reused} 份重复上传已复用原材料版本。`;
  }
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
  const upload: LocalUpload = { key: crypto.randomUUID(), owner: identity, projectId, role, file, phase: 'queued', sentBytes: 0 };
  const uploads = localUploads.get(projectId) ?? [];
  uploads.push(upload); localUploads.set(projectId, uploads);
  updateMaterialWorkspace(projectId);
  pumpUploads();
}

function pumpUploads() {
  for (const uploads of localUploads.values()) for (const upload of uploads) {
    if (runningUploads >= 2) return;
    if (upload.phase !== 'queued' || upload.controller || upload.owner !== identity) continue;
    runningUploads++; upload.phase = 'hashing';
    void performUpload(upload).finally(() => { runningUploads--; pumpUploads(); });
  }
}

async function performUpload(upload: LocalUpload) {
  const controller = new AbortController(); upload.controller = controller;
  let acceptedByByteEndpoint = false;
  const isCurrentOwner = () => identity === upload.owner && (localUploads.get(upload.projectId) ?? []).includes(upload);
  try {
    const mediaType = declaredMediaType(upload.file, upload.role);
    if (!upload.file.size) throw new Error('空文件不能上传。');
    if (upload.file.size > M1_UPLOAD_LIMITS.fileBytes) throw new Error('单份文件不能超过 100 MB，请拆分后上传。');
    updateMaterialWorkspace(upload.projectId);
    const hash = upload.hash ?? await sha256(await upload.file.arrayBuffer());
    upload.hash = hash;
    if (controller.signal.aborted || !isCurrentOwner()) return;
    const complete = () => api.completeUpload(upload.projectId, upload.session!.upload_id, { byte_size: upload.file.size, sha256: hash }, controller.signal);
    let material: Dto<'MaterialResponse'> | undefined;
    // A lost completion response must be reconciled before sending bytes again.
    if (upload.session) {
      upload.phase = 'checking'; updateMaterialWorkspace(upload.projectId);
      try { material = await complete(); }
      catch (error) {
        if (!(error instanceof ApiError) || ![404, 422].includes(error.status)) throw error;
        if (error.status !== 404 && error.code !== 'MATERIAL_UNREADABLE') throw error;
        if (error.status === 404 || Date.parse(upload.session.expires_at) <= Date.now()) upload.session = undefined;
      }
    }
    if (controller.signal.aborted || !isCurrentOwner()) return;
    if (!material) {
      const session = upload.session ?? await api.createUpload(upload.projectId, { filename: upload.file.name, media_type: mediaType, byte_size: upload.file.size, sha256: hash, role: upload.role }, controller.signal);
      if (!isCurrentOwner() || controller.signal.aborted) return;
      upload.session = session;
      upload.phase = 'uploading'; upload.sentBytes = 0; updateMaterialWorkspace(upload.projectId);
      await api.uploadBytes(session.upload_url, upload.file, loaded => {
        if (!isCurrentOwner() || controller.signal.aborted) return;
        upload.sentBytes = Math.min(upload.file.size, Math.max(0, loaded));
        upload.phase = upload.sentBytes >= upload.file.size ? 'saving' : 'uploading';
        updateMaterialWorkspace(upload.projectId);
      }, controller.signal);
      if (controller.signal.aborted || !isCurrentOwner()) return;
      acceptedByByteEndpoint = true; upload.phase = 'saving'; upload.sentBytes = upload.file.size; updateMaterialWorkspace(upload.projectId);
      material = await complete();
    }
    if (controller.signal.aborted || !isCurrentOwner()) return;
    upload.material = material; upload.phase = 'persisted'; upload.error = undefined;
    recoveryStates.set(upload.projectId, { state: 'ready' });
    updateMaterialWorkspace(upload.projectId);
    void refreshProjectMaterials(upload.projectId, epoch);
  } catch (error) {
    if (!isCurrentOwner()) return;
    // A quick retry waits in the queue until the aborted attempt releases its slot.
    if (controller.signal.aborted && upload.phase === 'queued') return;
    if (upload.phase === 'cancelled' || upload.phase === 'uncertain') return;
    const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const explicitServerFailure = error instanceof ApiError && error.status > 0;
    const uncertain = (!explicitServerFailure || error instanceof ApiError && error.status >= 500) && (upload.sentBytes >= upload.file.size || acceptedByByteEndpoint);
    upload.phase = aborted && !uncertain ? 'cancelled' : uncertain ? 'uncertain' : 'failed';
    upload.error = aborted && !uncertain ? undefined : uncertain
      ? `保存结果尚未确认。服务器可能已收到文件，但当前会话未取得保存凭证。请刷新服务器记录；请勿盲目重传。${error instanceof ApiError ? errorReference(error) : ''}`
      : uploadErrorMessage(error);
    updateMaterialWorkspace(upload.projectId);
    // A completion response can be lost after the server commits the material.
    // Re-read metadata once; this never resends bytes or starts a run.
    if (uncertain) void refreshProjectMaterials(upload.projectId, epoch);
  } finally {
    if (upload.controller === controller) upload.controller = undefined;
  }
}

async function refreshProjectMaterials(projectId: string, token: number) {
  if (!identity) return;
  const owner = identity;
  recoveryControllers.get(projectId)?.abort();
  const controller = new AbortController(); recoveryControllers.set(projectId, controller);
  recoveredMaterials.delete(projectId);
  recoveryStates.set(projectId, { state: 'loading' }); updateMaterialWorkspace(projectId);
  try {
    const ids = new Set<string>();
    let cursor = 0;
    while (!controller.signal.aborted) {
      const page = await api.projectEvents(projectId, cursor, controller.signal);
      for (const event of page.items) if (event.type === 'material.upload_progress' && event.payload.material_id) ids.add(event.payload.material_id);
      if (!page.items.length || page.next_cursor === null || page.next_cursor <= cursor) break;
      cursor = page.next_cursor;
    }
    const fetched: Dto<'MaterialResponse'>[] = [];
    const checkedIds = new Set<string>();
    while (!controller.signal.aborted) {
      for (const upload of localUploads.get(projectId) ?? []) {
        if (upload.phase === 'persisted' && upload.material) ids.add(upload.material.material_id);
      }
      const batch = [...ids].filter(id => !checkedIds.has(id));
      if (!batch.length) break;
      for (const id of batch) checkedIds.add(id);
      const records = await Promise.all(batch.map(async id => {
        try { return await api.material(projectId, id, controller.signal); }
        catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
      }));
      fetched.push(...records.filter((item): item is Dto<'MaterialResponse'> => item !== undefined));
    }
    if (controller.signal.aborted || token !== epoch || owner !== identity) return;
    const current = fetched.filter((item): item is Dto<'MaterialResponse'> => item !== undefined);
    recoveredMaterials.set(projectId, current);
    for (const upload of localUploads.get(projectId) ?? []) {
      if (upload.owner !== owner || upload.projectId !== projectId || upload.phase !== 'uncertain' || !upload.hash) continue;
      // Match the content and partition, including server-side duplicate reuse.
      // A matching filename or upload ID alone is not a persistence receipt.
      const matches = current.filter(material => material.state === 'persisted'
        && material.sha256 === upload.hash && material.byte_size === upload.file.size
        && material.role === upload.role && material.media_type === declaredMediaType(upload.file, upload.role));
      if (matches.length !== 1) continue;
      upload.material = matches[0]; upload.phase = 'persisted'; upload.error = undefined;
      upload.sentBytes = upload.file.size;
    }
    const currentIds = new Set(current.map(item => item.material_id));
    localUploads.set(projectId, (localUploads.get(projectId) ?? []).filter(upload => upload.phase !== 'persisted' || !!upload.material && currentIds.has(upload.material.material_id)));
    recoveryStates.set(projectId, { state: 'ready' });
  } catch (error) {
    if (controller.signal.aborted || token !== epoch || owner !== identity) return;
    recoveredMaterials.delete(projectId);
    localUploads.set(projectId, (localUploads.get(projectId) ?? []).filter(upload => upload.phase !== 'persisted'));
    const message = error instanceof ApiError && error.status === 501
      ? '材料事件恢复接口暂不可用；当前项目的服务器材料记录尚未确认。本地选择不会显示为已保存。'
      : `无法读取服务器材料记录。${friendlyError(error)}`;
    recoveryStates.set(projectId, { state: 'unavailable', message });
  } finally {
    if (recoveryControllers.get(projectId) === controller) recoveryControllers.delete(projectId);
    if (token === epoch && owner === identity) updateMaterialWorkspace(projectId);
  }
}

function bindMaterialWorkspace(projectId: string) {
  const host = document.querySelector<HTMLElement>('#material-partitions')!;
  host.addEventListener('change', event => {
    const target = event.target as HTMLElement;
    const source = target.closest<HTMLElement>('[data-source-material]');
    if (!source || !draft) return;
    const material = confirmedMaterials(projectId).find(m => m.material_id === source.dataset.sourceMaterial);
    if (!material) return;
    const previous = draft.fields.update_details.source_prospectuses?.find(s => s.material_id === material.material_id && s.material_version === material.material_version && s.sha256 === material.sha256);
    const value = readSourceFields(source, material, previous, target.dataset.sourceField);
    const sources = (draft.fields.update_details.source_prospectuses ?? []).filter(s => s.material_id !== material.material_id);
    const details = { ...draft.fields.update_details, authoring_mode: 'unified_v1' as const, source_prospectuses: [...sources, value] };
    draft.edit({ update_details: details });
    retainUpdateDetails(document.querySelector<HTMLFormElement>('#draft-form')!, details);
    if (target.dataset.sourceField === 'market') {
      const template = document.createElement('template'); template.innerHTML = sourceFields(material, details.source_prospectuses);
      source.querySelector('[data-source-field="offering"]')!.innerHTML = template.content.querySelector('[data-source-field="offering"]')!.innerHTML;
    }
    source.querySelector('[data-source-period-summary]')!.textContent = sourcePeriodSummary(value.reporting_periods);
    source.querySelector('[data-source-required-message]')!.textContent = sourceRequiredMessage(value);
    syncProjectExecution(projectId);
  });
  host.addEventListener('dragover', event => { if ((event.target as HTMLElement).closest('.material-picker')) event.preventDefault(); });
  host.addEventListener('drop', event => {
    const picker = (event.target as HTMLElement).closest('.material-picker'); if (!picker) return;
    event.preventDefault(); const role = picker.querySelector<HTMLInputElement>('[data-upload-role]')?.dataset.uploadRole as UploadRole;
    if (role) for (const file of Array.from(event.dataTransfer?.files ?? [])) addUpload(projectId, role, file);
  });
  host.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-upload-role]')) return;
    const role = input.dataset.uploadRole as UploadRole;
    for (const file of Array.from(input.files ?? [])) addUpload(projectId, role, file);
    input.value = '';
  });
  host.addEventListener('click', event => {
    const retry = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-processing-retry]');
    if (retry) { materialProcessing?.refresh(retry.dataset.processingRetry); return; }
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
      case 'retry': upload.phase = 'queued'; upload.error = undefined; updateMaterialWorkspace(projectId); pumpUploads(); break;
      case 'reconcile': void refreshProjectMaterials(projectId, epoch); break;
      case 'remove': {
        if (['queued', 'hashing', 'checking', 'uploading', 'saving'].includes(upload.phase)) upload.controller?.abort();
        localUploads.set(projectId, (localUploads.get(projectId) ?? []).filter(item => item !== upload));
        updateMaterialWorkspace(projectId);
        if (upload.phase === 'uncertain') void refreshProjectMaterials(projectId, epoch);
        break;
      }
    }
  });
  document.querySelector<HTMLButtonElement>('[data-refresh-materials]')!.addEventListener('click', () => {
    const token = epoch;
    void refreshProjectMaterials(projectId, token).then(() => { if (token === epoch) materialProcessing?.refresh(); });
  });
}

window.addEventListener('hashchange', () => { if(captureResetToken()){clearPrivateState();publicRecovery('reset');return;} if (!identity) { if (signedOutView) routeSignedOut(); return; } void renderRoute(); });
document.querySelector('.skip-link')!.addEventListener('click', event => {
  event.preventDefault(); document.querySelector<HTMLElement>('#main')?.focus();
});
window.addEventListener('beforeunload', event => {
  const activeUploads = [...localUploads.values()].some(uploads => uploads.some(upload => ['queued', 'hashing', 'checking', 'uploading', 'saving'].includes(upload.phase)));
  if (newDirty || creating || draft?.dirty || draft?.state === 'saving' || projectConversation?.hasUnsent || reviewWorkspace?.hasUnconfirmed || activeUploads) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { materialProcessing?.setVisible(false); return; }
  if (!identity) return;
  const expected = identity;
  const token = epoch;
  void api.me().then(me => {
    if (identity !== expected || token !== epoch) return;
    if (me.user_id !== expected) signedOut('账号已更改，请重新登录。');
    else materialProcessing?.setVisible(true);
  }).catch(() => {});
});

async function start() {
  if(captureResetToken() || location.hash==='#/reset'){publicRecovery('reset');return;}
  const token = ++epoch;
  try {
    const me = await api.me();
    if (token !== epoch) return;
    identity = me.user_id; await renderRoute();
  } catch (error) {
    if (token !== epoch) return;
    if (error instanceof ApiError && error.status === 401) routeSignedOut(); else renderLogin(friendlyError(error));
  }
}
void start();
