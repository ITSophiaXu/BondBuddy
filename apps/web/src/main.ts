import './upload-progress.css';
import {uploadActivity,uploadProgressHtml,uploadTransfer} from './upload-progress';
import {configureBillingTaskRecovery, resumeBillingTask, cleanBillingReturn, cancelBillingTask, billingTaskRechargeHref, type BillingTask} from './billing-task-recovery';
import { ProjectQaWorkspace } from './project-qa-workspace';
import { IntegrityWorkspace } from './integrity-workspace';
import { ReviewEntry } from './review-entry';
import { UpdateEntry } from './update-entry';
import { ProspectusPanel } from './prospectus-panel';
import { duplicateUploadNotices } from './duplicate-upload';
import { UploadRecovery, UploadRecoveryNeedsFileError, UploadRecoveryStorageError, UploadRecoveryLockError, UploadRecoveryConflictError, UploadRecoveryReceiptError, validateUploadMaterial, type UploadRecoveryRecord } from './upload-recovery';
import { renderFinancialUploadGuidance } from './financial-upload-guidance';
import { OPTIONAL_MATERIAL_GUIDANCE, OPTIONAL_MATERIAL_FORMATS } from './optional-materials';
import { ProjectFiles, clearProjectFileViews } from './project-files';
import { BillingPage } from './billing-page';
import { BillingPriceAdminPage } from './billing-price-admin';
import { TaskRefundAdminPage } from './task-refund-admin-page';
import { CreditWallet } from './credit-wallet';
import { ProjectAssistant } from './project-assistant';
import { projectListContext, withProjectContext, projectBackLink, projectSection, navigationProjectContext, projectWorkHref, rechargeHref } from './project-navigation';
import { prototypeIcon, workspaceSteps } from './prototype-design';
import { renderRecoveryPage } from './recovery';
import { ProjectBrowser } from './project-browser';
import { ArtifactPage } from './artifact-page';
import { ProjectExecution } from './project-execution';
import { ProjectConversation } from './project-conversation';
import { ReviewWorkspace, renderNewReview, reviewProjectFields, bindReviewProjectFields } from './review-workspace';
import { FileWorkspace } from './file-workspace';
import { FileConsistency } from './file-consistency';
import { MaterialWorkspace } from './material-workspace';
import { carryHandoff, copyHandoffSource, mountBusinessHandoff } from './business-handoff';
import { renderOcrReview, canLeaveOcrReview, disposeOcrReview } from './ocr-review';
import './ocr-review.css';
import { ApiClient, ApiError, errorReference, friendlyError, type Dto } from './api';
import { UserFacingError } from './user-facing-error';
import { sourceFields, readSourceFields, sourcePeriodSummary, sourceRequiredMessage, clearSourceSelections } from './source-prospectus.js';
import { formatTemplateNotice, formatTemplatePin, selectedFormatTemplate, type SourceFormatContext } from './source-format-template.js';
import { retainUpdateDetails } from './update-form.js';
import { uploadErrorMessage, InvalidUploadFileError, uploadNeedsReplacement } from './upload-error';
import { Draft } from './draft';
import { blankDraft, validateDraft } from './form-model';
import { bindUpdateForm, readUpdateForm, updateFormFields, revealUpdateFormErrors } from './update-form';
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
import './authoring-onboarding.css';
import '../../../product-prototype/public/styles.css';
import '../../../product-prototype/public/project-workspace.css';
import './prototype-adapter.css';
import './quarter-controls.css';
import '../../../product-prototype/public/optional-materials.css';
import '../../../product-prototype/public/source-prospectus.css';
import './credit-wallet.css';
import './project-context.css';
import '../../../product-prototype/public/workspace-typography.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const folder = icon('M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z');
const plus = icon('M12 5v14M5 12h14');
const person = icon('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20a8 8 0 0 1 16 0');
let identity: string | undefined;
configureBillingTaskRecovery(()=>identity);
function billingNotice(message:string,task?:BillingTask,retryHash?:string){
  document.querySelector('#billing-task-notice')?.remove();
  const notice=document.createElement('aside');notice.id='billing-task-notice';notice.className='billing-task-notice';notice.setAttribute('role','status');
  const text=document.createElement('p');text.textContent=message;notice.append(text);
  if(task){const link=document.createElement('a');link.href=billingTaskRechargeHref(task);link.className='btn primary';link.textContent='订阅或充值，继续原任务';notice.append(link);
    const cancel=document.createElement('button');cancel.type='button';cancel.className='btn secondary';cancel.textContent='取消待执行任务';cancel.addEventListener('click',()=>{if(identity===task.owner)void cancelBillingTask(task.owner,task.id).then(()=>notice.remove());});notice.append(cancel);
  }else{if(retryHash){const retry=document.createElement('a');retry.href=retryHash;retry.className='btn secondary';retry.textContent='核对原任务提交';retry.addEventListener('click',event=>{if(location.hash===retryHash){event.preventDefault();void renderRoute();}});notice.append(retry);}const close=document.createElement('button');close.type='button';close.textContent='知道了';close.addEventListener('click',()=>notice.remove());notice.append(close);}
  document.body.append(notice);
}
window.addEventListener('bondbuddy:billing-task-needs-funds',event=>{const task=(event as CustomEvent<BillingTask>).detail;if(task.owner===identity)billingNotice(task.body.billing_resume===true?'本批底稿因积分不足暂停，已完成文件保留。完成订阅或充值并返回后，将自动继续这一批的剩余文件。':'积分不足，原任务尚未开始。完成订阅或充值并返回后，将自动继续这一个任务。',task);});
let accountIdentity: { owner: string; name?: string; request?: Promise<void> } | undefined;
let epoch = 0;
let currentRoute = '/';
let draft: Draft | undefined;
let newDirty = false;
let creating = false;
let projectBrowser: ProjectBrowser | undefined;
let reviewEntry:ReviewEntry|undefined;
let updateEntry:UpdateEntry|undefined;
let prospectusPanel:ProspectusPanel|undefined;
let projectFiles: ProjectFiles | undefined;
let billingPage: BillingPage | undefined;
let billingPriceAdmin: BillingPriceAdminPage | undefined;
let taskRefundAdmin: TaskRefundAdminPage | undefined;
let creditWallet: CreditWallet | undefined;
let globalAssistant: ProjectAssistant | undefined;
let artifactPage: ArtifactPage | undefined;
let projectExecution: ProjectExecution | undefined;
let staleInputNoticeProjectId: string | undefined;
let projectConversation: ProjectConversation | undefined;
let reviewWorkspace: ReviewWorkspace | undefined;
let materialWorkspace: MaterialWorkspace | undefined;
let fileWorkspace: FileWorkspace | undefined;
let integrityWorkspace: IntegrityWorkspace | undefined;
let qaWorkspace: ProjectQaWorkspace | undefined;
let fileConsistency: FileConsistency | undefined;
const projectNames=new Map<string,string>();
const projectNameRequests=new Map<string,Promise<void>>();

type UploadRole = Dto<'UploadCreateRequest'>['role'];
type UploadPhase = 'queued' | 'hashing' | 'checking' | 'uploading' | 'saving' | 'persisted' | 'failed' | 'cancelled' | 'uncertain';
type LocalUpload = { key: string; owner: string; projectId: string; role: UploadRole; file?: File; declaration?:Dto<'UploadCreateRequest'>; uploadId?:string; recoveryRecord?:UploadRecoveryRecord; explicitResume?:boolean; restored?:boolean; needsFile?:boolean; needsReplacement?:boolean; journalDone?:boolean; phase: UploadPhase; sentBytes: number; material?: Dto<'MaterialResponse'>; error?: string; controller?: AbortController; hash?: string };
let runningUploads = 0;
let preparingUploads=0;
type MaterialRecovery = { state: 'loading' | 'ready' | 'unavailable'; message?: string };
const localUploads = new Map<string, LocalUpload[]>();
const recoveredMaterials = new Map<string, Dto<'MaterialResponse'>[]>();
const recoveryStates = new Map<string, MaterialRecovery>();
const recoveryControllers = new Map<string, AbortController>();
const uploadRecoveries=new Map<string,UploadRecovery>();
const uploadJournalErrors=new Map<string,string>();
const uploadReselectInputs=new Map<string,HTMLInputElement>();
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
  projectNames.clear();projectNameRequests.clear();
  reviewEntry?.dispose();reviewEntry=undefined;updateEntry?.dispose();updateEntry=undefined;prospectusPanel?.dispose();prospectusPanel=undefined;
  globalAssistant?.dispose(); globalAssistant = undefined;
  accountIdentity = undefined;
  creditWallet?.dispose(); creditWallet = undefined;
  materialWorkspace?.dispose(); materialWorkspace = undefined;
  qaWorkspace?.dispose(); qaWorkspace=undefined;
  integrityWorkspace?.dispose(); integrityWorkspace=undefined;
  fileWorkspace?.dispose(); fileWorkspace=undefined; fileConsistency?.dispose(); fileConsistency=undefined;
  clearSourceSelections();
  reviewWorkspace?.dispose(); reviewWorkspace = undefined;
  projectFiles?.dispose(); projectFiles = undefined;
  clearProjectFileViews();
  billingPage?.dispose(); billingPage = undefined;
  billingPriceAdmin?.dispose(); billingPriceAdmin=undefined;
  taskRefundAdmin?.dispose(); taskRefundAdmin=undefined;
  artifactPage?.dispose(); artifactPage = undefined;
  projectExecution?.dispose(); projectExecution = undefined;
  projectConversation?.dispose(); projectConversation = undefined;
  staleInputNoticeProjectId = undefined;
  disposeOcrReview();
  materialProcessing?.dispose(); materialProcessing = undefined;
  for (const uploads of localUploads.values()) for (const upload of uploads) upload.controller?.abort();
  for (const controller of recoveryControllers.values()) controller.abort();
  localUploads.clear(); recoveredMaterials.clear(); recoveryStates.clear(); recoveryControllers.clear();uploadRecoveries.clear();uploadJournalErrors.clear();for(const input of uploadReselectInputs.values())input.remove();uploadReselectInputs.clear();
  epoch++; api.reset(); draft?.dispose(); draft = undefined; newDirty = false; creating = false;
  document.querySelector('#billing-task-notice')?.remove();
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
    if(link)link.innerHTML='<a href="#/recover">忘记密码？查看找回方式</a>';
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
      history.replaceState(null, '', `${location.pathname}${location.search}#tasks`);
      await renderRoute();
    } catch (error) {
      if (token !== epoch) return;
      feedback.textContent = error instanceof ApiError && error.status === 401 ? '用户名或密码不正确，请重试。' : friendlyError(error,'action');
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
      history.replaceState(null, '', `${location.pathname}${location.search}#tasks`);
      await renderRoute();
    } catch (error) {
      if (submit !== epoch) return;
      feedback.textContent = registerErrorMessage(error);
      button.disabled = false; button.textContent = '注册并进入工作区';
    }
  });
}

function mountAccountIdentity() {
  if (!identity) return;
  const state = accountIdentity ??= { owner: identity };
  const paint = () => {
    const label = document.querySelector<HTMLElement>('[data-account-name]');
    if (label && accountIdentity === state) {
      label.textContent = state.name ?? '当前账号';
      label.title = state.name ?? '';
    }
  };
  paint();
  if (state.name !== undefined || state.request) return;
  state.request = api.account().then(account => {
    if (accountIdentity !== state || account.user_id !== state.owner) return;
    state.name = account.username?.trim() || '当前账号';
    paint();
  }).catch(() => { /* Keep navigation and logout available; retry on the next page. */ })
    .finally(() => { state.request = undefined; });
}

function shell(content: string, section: string) {
  const context=navigationProjectContext(location.hash);
  const nav = (route: string, ico: string, label: string, active: boolean, pending = false) => `<a href="#${route}" class="nav-item ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${prototypeIcon(ico)}<span>${label}</span>${pending ? '<small class="nav-pending">未开放</small>' : ''}</a>`;
  root.innerHTML = `<div class="prototype-app"><aside class="sidebar" id="sidebar"><button class="mobile-menu-close icon-btn" id="close-menu" aria-label="关闭菜单">${prototypeIcon('close')}</button><a class="brand" href="#tasks"><img src="/favicon.svg" alt=""/>bondbuddy<small>BETA</small></a>
    <div class="workspace"><div class="workspace-icon">${prototypeIcon('building')}</div><div><strong>我的工作空间</strong><small>PERSONAL WORKSPACE</small></div></div>
    <nav aria-label="主导航">${nav('tasks','clock','任务进度与结果',section === 'projects')}<div class="nav-label">开始工作</div>${nav('update','update','更新募集书',section === 'new' || section === 'workspace')}${nav('review','review','复核募集书',section === 'review')}${nav('generate','spark','文件生成',section === 'generate')}${nav('integrity','shield','诚信核查',section === 'integrity')}${nav('qa','chat','项目问答',section === 'qa')}</nav>
    <div class="sidebar-bottom"><section class="credit-wallet" data-credit-wallet="sidebar" aria-label="积分余额"></section><nav aria-label="账号">${nav(rechargeHref().slice(1),'settings','我的账号',section === 'account')}</nav><div class="user account"><span class="avatar" aria-hidden="true">我</span><strong data-account-name aria-label="当前登录账号">当前账号</strong><button id="logout" class="text-button" type="button">退出</button></div></div></aside>
    <div class="shell"><header class="topbar"><div class="breadcrumb"><button class="mobile-menu icon-btn" id="toggle-menu" aria-label="打开菜单" aria-expanded="false">${prototypeIcon('menu')}</button><span>工作空间</span>${prototypeIcon('chevron')}<span>${section === 'new' || section === 'workspace' ? '更新募集书' : section === 'review' ? '复核募集书' : section === 'generate' ? '文件生成' : section === 'integrity' ? '诚信核查' : section === 'qa' ? '项目问答' : section === 'account' ? '我的账号' : section === 'policy' ? '数据说明' : section === 'billing' ? '账户与计费' : '任务进度与结果'}</span></div><div class="top-actions"><span class="top-plan-link">按任务使用积分</span><div class="mobile-credit-wallet" data-credit-wallet="compact"></div></div></header>
    <main id="main" tabindex="-1">${context?`<section class="project-context" aria-label="当前项目"><div><small>正在处理</small><strong data-project-context-name>${esc(projectNames.get(context.projectId)??'当前项目')}</strong></div><a href="${projectWorkHref('files',context.projectId)}">返回本项目文件</a></section>`:''}${content}</main></div></div>`;
  if(context&&!projectNames.has(context.projectId)&&!projectNameRequests.has(context.projectId)){
    const owner=identity,expectedProject=context.projectId;
    const request=api.project(expectedProject).then(project=>{
      if(owner!==identity||projectNameRequests.get(expectedProject)!==request)return;
      projectNames.set(expectedProject,project.name);
      if(navigationProjectContext(location.hash)?.projectId===expectedProject){const name=document.querySelector('[data-project-context-name]');if(name)name.textContent=project.name;}
    }).catch(()=>{/* Project content reports its own errors; navigation stays available. */}).finally(()=>{if(projectNameRequests.get(expectedProject)===request)projectNameRequests.delete(expectedProject);});
    projectNameRequests.set(expectedProject,request);
  }
  creditWallet ??= new CreditWallet(api);
  creditWallet.mount();
  if(identity){ globalAssistant ??= new ProjectAssistant(api,identity); globalAssistant.mount(); }
  mountAccountIdentity();
  document.querySelector('#logout')!.addEventListener('click', () => { void logout(); });
  const menu = document.querySelector<HTMLButtonElement>('#toggle-menu')!;
  document.querySelector('#close-menu')!.addEventListener('click', () => { document.querySelector('#sidebar')!.classList.remove('mobile-open'); menu.setAttribute('aria-expanded','false'); menu.setAttribute('aria-label','打开菜单'); menu.focus(); });
  menu.addEventListener('click', () => { const open = document.querySelector('#sidebar')!.classList.toggle('mobile-open'); menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单'); });
}

function showError(error: unknown, operation:'save'|'action'='action') {
  const target = document.querySelector<HTMLElement>('#page-error');
  if (target) { target.textContent = friendlyError(error,operation); target.hidden = false; }
}

async function logout() {
  const button = document.querySelector<HTMLButtonElement>('#logout');
  if (!button) return;
  if (creating) return;
  if (prospectusPanel && !await prospectusPanel.beforeLeave()) return;
  if (reviewWorkspace && !await reviewWorkspace.beforeLeave()) return;
  if (materialWorkspace && !await materialWorkspace.beforeLeave()) return;
  if (qaWorkspace && !await qaWorkspace.beforeLeave()) return;
  if (integrityWorkspace && !await integrityWorkspace.beforeLeave()) return;
  if (fileWorkspace && !await fileWorkspace.beforeLeave()) return;
  if (projectFiles && !await projectFiles.beforeLeave()) return;
  if (fileConsistency && !await fileConsistency.beforeLeave()) return;
  if (newDirty && !window.confirm('当前新项目尚未保存。退出会放弃这些填写内容，是否继续？')) return;
  if (projectConversation?.hasUnsent && !await projectConversation.flush() && !window.confirm('还有未发送或保存结果未确认的消息。退出后本页输入将无法恢复，是否继续？')) return;
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
  const legacyDashboard = /^(?:\/)?dashboard(?:\?|$)/.test(raw);
  const requested = !raw || legacyDashboard ? '/'+(raw.includes('?')?'?'+raw.split('?')[1]:'') : raw === 'update' || raw.startsWith('update?') ? '/update'+raw.slice(6) : raw.startsWith('tasks') ? '/' + raw.slice(5) : raw;
  const nextRoute = requested.replace(/\?step=(details|materials)$/, '');
  if (reviewWorkspace && !await reviewWorkspace.beforeLeave()) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${currentRoute}`); return;
  }
  if (qaWorkspace && !await qaWorkspace.beforeLeave()) {history.replaceState(null,'',location.pathname+location.search+'#'+currentRoute);return;}
  if (integrityWorkspace && !await integrityWorkspace.beforeLeave()) {history.replaceState(null,'',location.pathname+location.search+'#'+currentRoute);return;}
  if (fileWorkspace && !await fileWorkspace.beforeLeave()) {history.replaceState(null,'',location.pathname+location.search+'#'+currentRoute);return;}
  if (projectFiles && !await projectFiles.beforeLeave()) {history.replaceState(null,'',location.pathname+location.search+'#'+currentRoute);return;}
  if (fileConsistency && !await fileConsistency.beforeLeave()) {history.replaceState(null,'',location.pathname+location.search+'#'+currentRoute);return;}
  if (materialWorkspace && !await materialWorkspace.beforeLeave()) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${currentRoute}`); return;
  }
  if (!identity || location.hash.slice(1) !== raw) return;
  if (!canLeaveOcrReview() || creating || (newDirty && !window.confirm('当前新项目尚未保存，离开会放弃填写内容，是否继续？')) ||
      nextRoute !== currentRoute && projectConversation?.hasUnsent && !await projectConversation.flush() &&
      !window.confirm('还有未发送或保存结果未确认的消息。离开后本页输入将无法恢复，是否继续？')) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${currentRoute}`); return;
  }
  if(prospectusPanel && !await prospectusPanel.beforeLeave()){history.replaceState(null,'',`${location.pathname}${location.search}#${currentRoute}`);return;}
  newDirty = false;
  const token = ++epoch;
  if (draft && (draft.dirty || draft.state === 'saving')) {
    const saved = await draft.save();
    if (token !== epoch) return;
    if (!saved) {
      history.replaceState(null, '', `${location.pathname}${location.search}#${currentRoute}`);
      showError(draft.error ?? new ApiError(422, 'INPUT_REQUIRED'),'save'); return;
    }
  }
  draft?.dispose(); draft = undefined;
  billingPage?.dispose(); billingPage = undefined;
  projectBrowser?.dispose(); projectBrowser = undefined;
  projectFiles?.dispose(); projectFiles = undefined;
  artifactPage?.dispose(); artifactPage = undefined;
  projectExecution?.dispose(); projectExecution = undefined;
  projectConversation?.dispose(); projectConversation = undefined;
  reviewWorkspace?.dispose(); reviewWorkspace = undefined;
  materialWorkspace?.dispose(); materialWorkspace = undefined;
  qaWorkspace?.dispose(); qaWorkspace=undefined;
  integrityWorkspace?.dispose(); integrityWorkspace=undefined;
  fileWorkspace?.dispose(); fileWorkspace=undefined; fileConsistency?.dispose(); fileConsistency=undefined;
  disposeOcrReview();
  materialProcessing?.dispose(); materialProcessing = undefined;
  reviewEntry?.dispose();reviewEntry=undefined;updateEntry?.dispose();updateEntry=undefined;prospectusPanel?.dispose();prospectusPanel=undefined;
  currentRoute = nextRoute;
  const resumeId=new URLSearchParams(raw.split('?')[1]??'').get('resume_request');
  if(resumeId&&!/^\/?(?:account|billing|payment)(?:[/?]|$)/.test(raw)){
    const returnHash=cleanBillingReturn(location.hash),resumeOwner=identity;
    try{await resumeBillingTask(resumeOwner,resumeId,returnHash,(path,body,headers)=>api.request('POST',path,body,headers));if(identity!==resumeOwner||token!==epoch)return;history.replaceState(null,'',location.pathname+location.search+returnHash);currentRoute=returnHash.slice(1);document.querySelector('#billing-task-notice')?.remove();}
    catch(error){if(identity!==resumeOwner||token!==epoch)return;if(error instanceof ApiError&&error.code==='CREDITS_INSUFFICIENT'){/* The scoped payment notice remains visible. */}else if(error instanceof ApiError&&error.status>=400&&error.status<500&&![408,429].includes(error.status)){history.replaceState(null,'',location.pathname+location.search+returnHash);currentRoute=returnHash.slice(1);billingNotice(friendlyError(error,'submit')+' 原请求未受理，材料与输入保留，请在工作区按当前版本开始。');}else billingNotice(friendlyError(error,'submit')+' 原请求和范围保留，可核对原任务提交。',undefined,returnHash+(returnHash.includes('?')?'&':'?')+'resume_request='+encodeURIComponent(resumeId));}
  }
  if (!raw || legacyDashboard) history.replaceState(null,'',location.pathname+location.search+'#tasks'+(raw.includes('?')?'?'+raw.split('?')[1]:''));
  if (/^review(\?|$)/.test(requested)) { const query=new URLSearchParams(requested.split('?')[1]??''); if(query.has('new'))renderNewReview(api,shell,()=>token===epoch,query);else{reviewEntry=new ReviewEntry(api,shell,()=>token===epoch);await reviewEntry.render(query.get('project')??undefined);}return; }
  if(requested==='/billing/prices'){billingPriceAdmin=new BillingPriceAdminPage(api,shell,()=>token===epoch,identity);await billingPriceAdmin.render();return;}
  if(requested==='/billing/task-refunds'){taskRefundAdmin=new TaskRefundAdminPage(api,shell,()=>token===epoch,identity);await taskRefundAdmin.render();return;}
  if(requested==='/account'||requested.startsWith('/account?')||requested==='billing'||requested.startsWith('billing?')||requested.startsWith('payment/')||requested==='/data-policy'){
    const query=new URLSearchParams(requested.split('?')[1]??'');
    const project=query.get('project')??undefined;
    const order=requested.startsWith('payment/')?decodeURIComponent(requested.slice(8)):query.get('order')??undefined;
    await renderAccount(accountPage);
    if(token!==epoch)return;
    const host=document.querySelector<HTMLElement>('#account-credits');
    if(host){billingPage=new BillingPage(api,html=>{if(token===epoch)host.innerHTML=html;},()=>token===epoch,project,order,identity);await billingPage.render();}
    if(requested==='/data-policy'||query.get('section')==='data'){const details=document.querySelector<HTMLDetailsElement>('#account-data');if(details){document.querySelector<HTMLDialogElement>('#account-settings')?.showModal();details.open=true;details.scrollIntoView({block:'start'});}}
    return;
  }
  if (/^consistency(\?|$)/.test(requested)) {fileConsistency=new FileConsistency(api,shell,()=>token===epoch,new URLSearchParams(requested.split('?')[1]).get('project')??'',identity);await fileConsistency.render();return;}
  if (/^qa(\?|$)/.test(requested)) {const query=new URLSearchParams(requested.split('?')[1]??'');qaWorkspace=new ProjectQaWorkspace(api,shell,()=>token===epoch,query.get('project')??undefined,identity);await qaWorkspace.render();return;}
  if (/^integrity(\?|$)/.test(requested)) {const query=new URLSearchParams(requested.split('?')[1]??'');integrityWorkspace=new IntegrityWorkspace(api,shell,()=>token===epoch,query.get('project')??undefined,identity);await integrityWorkspace.render();return;}
  if (/^generate(\?|$)/.test(requested)) {
    const query=new URLSearchParams(requested.split('?')[1]??'');
    if(!query.get('topic')){fileWorkspace=new FileWorkspace(api,shell,()=>token===epoch,query.get('project')??undefined,identity);await fileWorkspace.render();return;}
    materialWorkspace=new MaterialWorkspace(api,identity,shell,()=>token===epoch,query.get('topic')??undefined,query.get('project')??undefined,query.has('new'),query.get('run')??undefined);
    await materialWorkspace.render(); return;
  }
  if (/^\/update(\?|$)/.test(requested)) {updateEntry=new UpdateEntry(api,shell,()=>token===epoch);await updateEntry.render(new URLSearchParams(requested.split('?')[1]).get('project')??undefined);return;}
  if (/^\/new(\?|$)/.test(requested)) { renderNew(new URLSearchParams(requested.split('?')[1]??'')); return; }
  if (requested === '/' || requested.startsWith('/?')) { projectBrowser = new ProjectBrowser(api,shell,() => token === epoch,identity); await projectBrowser.render(); return; }
  const filesMatch=requested.match(/^\/projects\/([^/?]+)\/files(?:\?.*)?$/);
  if(filesMatch){projectFiles=new ProjectFiles(api,shell,()=>token===epoch,decodeURIComponent(filesMatch[1]),identity,route=>{if(token===epoch)currentRoute=route;});await projectFiles.render();return;}
  const artifactMatch = requested.match(/^\/artifacts\/([^/?]+)(?:\?.*)?$/);
  if (artifactMatch) { artifactPage = new ArtifactPage(api, shell, () => token === epoch); await artifactPage.render(decodeURIComponent(artifactMatch[1])); return; }
  const ocrMatch = requested.match(/^\/projects\/([^/]+)\/materials\/([^/]+)\/ocr$/);
  if (ocrMatch) { await renderOcrReview({api,shell,epoch:()=>epoch},decodeURIComponent(ocrMatch[1]),decodeURIComponent(ocrMatch[2])); return; }
  const reviewMatch = requested.match(/^\/projects\/([^/?]+)\/review(?:\?(.*))?$/);
  if (reviewMatch) {
    const query = new URLSearchParams(reviewMatch[2]);
    reviewWorkspace = new ReviewWorkspace(api, identity, decodeURIComponent(reviewMatch[1]), shell, () => token === epoch, query.get('report_id') || undefined, query.get('tab') || undefined,query,hash=>{if(token===epoch)currentRoute=hash;});
    await reviewWorkspace.render(); return;
  }
  const match = requested.match(/^\/projects\/([^/?]+)(?:\?(.*))?$/);
  if (!match) { location.hash = '/'; return; }
  const projectShellSection = projectSection('workspace');
  shell('<p role="status">正在读取项目…</p><p id="page-error" role="alert" hidden></p>', projectShellSection);
  try {
    const project = await api.project(decodeURIComponent(match[1]));
    if (token !== epoch) return;
    const projectQuery = new URLSearchParams(match[2]);
    if (project.kind === 'review') {
      if (projectQuery.get('step') === 'details') { renderReviewProjectDetails(project, projectQuery); return; }
      reviewWorkspace = new ReviewWorkspace(api, identity!, project.project_id, shell, () => token === epoch,undefined,undefined,new URLSearchParams(),hash=>{if(token===epoch)currentRoute=hash;});
      await reviewWorkspace.render(); return;
    }
    if(project.kind==='generation'){
      const topics=await api.request<{topics:import('@bondbuddy/contracts').M4Topic[]}>('GET','/m4/topics');
      if(token!==epoch)return;
      const topic=topics.topics.find(t=>t.project_id===project.project_id);
      if(topic){materialWorkspace=new MaterialWorkspace(api,identity!,shell,()=>token===epoch,topic.topic_id,undefined,false,projectQuery.get('run')??undefined);await materialWorkspace.render();return;}
    }
    renderProject(project, projectQuery.get('step') === 'details' ? 'details' : 'materials',projectQuery);
  } catch (error) {
    if (token !== epoch) return;
    shell(`${projectBackLink()}<div class="empty-state"><h1>项目暂时无法打开</h1><p>${esc(friendlyError(error,'read'))}</p><button class="button secondary" id="retry-project">重新加载</button></div><p id="page-error" role="alert" hidden></p>`, projectShellSection);
    document.querySelector('#retry-project')!.addEventListener('click', () => { void renderRoute(); });
  }
}

function renderNew(handoffQuery=new URLSearchParams()) {
  const value = blankDraft();
  const creationRequestId=crypto.randomUUID();
  shell(`<div class="page-head"><div><div class="eyebrow">PROSPECTUS WORKSPACE</div><h1>更新募集说明书</h1><p>先保存项目，再添加材料。没有历史募集书，也可以编制首稿。</p></div><a class="btn secondary" href="#tasks">查看任务进度与结果</a></div>${workspaceSteps(1)}<div id="business-handoff"></div>
    <form id="create-form" class="update-form"><div class="workspace-layout authoring-workspace"><section class="panel form-panel form-card">${updateFormFields(value, true)}
    <p id="page-error" class="form-message" role="alert" hidden></p><div class="form-actions"><button class="button primary" type="submit">创建项目，继续提供材料</button><a class="button secondary" href="#/">取消</a></div><p class="field-hint">创建项目只保存信息；添加材料和补充要求后，由你明确开始任务。</p></section></div></form>`, 'new');
  const handoffEpoch=epoch;void mountBusinessHandoff(api,document.querySelector<HTMLElement>('#business-handoff')!,handoffQuery,()=>handoffEpoch===epoch);
  const form = document.querySelector<HTMLFormElement>('#create-form')!;
  bindUpdateForm(form, () => { newDirty = true; }, value.update_details);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (creating) return;
    const value = readUpdateForm(form); value.name = value.name.trim();
    const errors = value.issuer_name ? revealUpdateFormErrors(form,value) : ['请填写发行人全称。'];
    if (errors.length) { const target = document.querySelector<HTMLElement>('#page-error')!; target.textContent = errors.join(' '); target.hidden = false; return; }
    creating = true;
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')].map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    button.textContent = '正在保存…';
    const token = epoch;
    try {
      const project = await api.create({...value,creation_request_id:creationRequestId});
      if (token !== epoch) return;
      newDirty = false; location.hash = `/projects/${encodeURIComponent(project.project_id)}${handoffQuery.has('handoff_topic')?'?step=materials'+carryHandoff(handoffQuery):''}`;
    } catch (error) { if (token === epoch) showError(error,'save'); }
    finally { creating = false; controls.forEach(({ control, disabled }) => { control.disabled = disabled; }); button.textContent = '创建项目，继续提供材料'; }
  });
}

function renderReviewProjectDetails(project: Dto<'ProjectResponse'>, query: URLSearchParams) {
  draft = new Draft(project, api, updateSaveState);
  const returnQuery = withProjectContext(new URLSearchParams({ tab: query.get('review_tab') === 'results' ? 'results' : 'materials' }));
  const reportId = query.get('review_report_id'); if (reportId) returnQuery.set('report_id', reportId);
  const returnHref = `#/projects/${encodeURIComponent(project.project_id)}/review?${returnQuery}`;
  shell(`<div class="review-workspace"><header class="review-header"><div><p class="review-kicker">PROSPECTUS REVIEW</p><h1 id="project-heading">${esc(project.name)}</h1><p>补充复核所需的项目信息，保存后用于下一次明确执行。</p></div><span class="save-badge" id="save-state" role="status">已保存</span></header>${workspaceSteps(1,'复核流程')}<form id="draft-form" class="review-panel review-create"><h2>编辑复核项目信息</h2><p class="review-muted">修改后自动保存，已开始的任务保持原输入。</p>${reviewProjectFields(project)}<p id="page-error" class="form-message" role="alert" hidden></p><div id="conflict-panel" class="conflict-panel" hidden><p>其他页面已修改项目信息；当前填写仍保留，请核对后加载最新资料。</p><button class="button secondary" type="button" id="reload-draft">放弃本页修改并加载最新资料</button></div><div class="form-actions"><button id="save-draft" class="button secondary" type="submit" disabled>保存修改</button><span class="muted" id="saved-time">${esc(date(project.updated_at))} 保存</span><a class="btn primary" href="${esc(returnHref)}">返回复核工作区</a></div></form></div>`, 'review');
  const form = document.querySelector<HTMLFormElement>('#draft-form')!;
  bindReviewProjectFields(form, value => draft?.edit({ ...value, issuer_name: value.issuer_name ?? '' }),project);
  form.addEventListener('submit', event => { event.preventDefault(); void draft?.save(); });
  document.querySelector('#reload-draft')!.addEventListener('click', () => {
    if (!window.confirm('加载最新资料会放弃当前未保存的项目信息，是否继续？')) return;
    draft?.dispose(); draft = undefined; void renderRoute();
  });
}

function renderProject(project: Dto<'ProjectResponse'>, step: 'details' | 'materials' = 'materials',handoffQuery=new URLSearchParams()) {
  draft = new Draft(project, api, updateSaveState);
  restoreUploadRows(project.project_id);
  if (project.update_details?.authoring_mode !== 'unified_v1') {
    materialProcessing = new MaterialProcessing(api, project.project_id, () => updateProcessingRows(project.project_id));
    materialProcessing.setVisible(document.visibilityState === 'visible');
  }
  const value = { ...draft.fields, kind: project.kind, issuer_name: draft.fields.issuer_name || null };
  shell(`${projectListContext()?projectBackLink():''}<div class="page-head"><div><div class="eyebrow">PROSPECTUS WORKSPACE</div><h1 id="project-heading">${esc(project.name)}</h1><p>提供项目材料和要求，在同一个工作区完成募集书更新。</p></div><div class="heading-actions"><span class="save-badge" id="save-state" role="status">已保存</span>${project.source_project_id?`<a class="text-button" href="#/projects/${encodeURIComponent(project.source_project_id)}">返回原项目</a>`:'<button class="text-button" type="button" id="delete-project">删除项目</button>'}</div></div>
    <div id="workspace-steps">${workspaceSteps(step === 'details' ? 1 : 2)}</div>
    <p id="page-error" class="form-message" role="alert" hidden></p><div id="conflict-panel" class="conflict-panel" hidden><p>当前输入未覆盖其他页面的修改。可以复制保留输入，再加载最新资料。</p><button class="button secondary" type="button" id="reload-draft">放弃当前输入并加载最新资料</button></div>
    <div class="workspace-layout authoring-workspace"><div class="workspace-main">
      <form id="draft-form" class="update-form" ${step === 'materials' ? 'hidden' : ''}><section class="panel form-card"><p class="field-hint">修改后自动保存；未确定的选填内容可留空。</p>${updateFormFields(value)}
      <div class="form-actions"><button id="save-draft" class="button secondary" type="submit" disabled>保存修改</button><span class="muted" id="saved-time">${esc(date(project.updated_at))} 保存</span></div></section><div class="form-footer"><a href="#tasks">查看任务进度与结果</a><button id="continue-materials" type="button" class="btn primary">保存并继续 ${prototypeIcon('arrow')}</button></div></form>
      <div id="workspace-materials" ${step === 'details' ? 'hidden' : ''}><div id="business-handoff"></div>
        <div class="project-strip"><span>${prototypeIcon('file')}全文更新</span><button id="edit-project-details" class="text-btn" type="button">编辑项目信息</button><span id="workspace-material-count">正在读取材料…</span></div>
        <div id="workspace-progress"></div><div id="prospectus-panel"></div>
    <details id="project-materials-details" class="project-materials-details" open><summary>项目信息与材料 <span id="materials-state-label">开始编制前可补充</span></summary><section class="panel materials-panel" aria-labelledby="materials-title"><div class="panel-heading materials-heading"><div><h2 id="materials-title">提供项目材料</h2><p class="muted" id="materials-state-description">请在开始编制前补齐材料；开始后材料锁定，仅可查看。</p><p class="muted material-upload-guidance">按分区添加材料。单份不超过 100 MB，每个项目最多 60 份、合计 500 MB。相同分区重复上传相同内容会复用已保存版本。</p></div><button class="button secondary" type="button" data-refresh-materials>刷新已保存材料</button></div>
    <aside class="authoring-preparation-guide" data-authoring-preparation-guide hidden aria-label="准备本轮材料与要求"><strong data-authoring-preparation-title hidden>准备下一轮募集书</strong><p data-authoring-preparation-intro>优先提供审计报告，或财务报表及附注；已保存的材料不用重复上传。历史／参考募集书选填，没有原稿也可编制首稿。</p><div data-next-authoring-summary hidden></div><div class="authoring-preparation-actions"><button type="button" class="text-btn" data-authoring-requirements>填写补充要求（选填）</button></div><p class="authoring-execution-note" data-authoring-execution-note>保存项目、材料或要求不会开始任务；准备好后点击页末“开始更新”。</p></aside>
    <p id="material-recovery-status" class="material-recovery-status" role="status"></p><fieldset id="material-editing" aria-label="项目材料" disabled><div id="material-partitions">${renderMaterialPartitions(project.project_id)}</div></fieldset>
    <p class="material-policy-note" id="upload-policy-note"></p><p class="material-footnote material-upload-guidance">选中文件后立即上传；未成功的文件可单独重试。</p></section><div id="project-conversation-root" hidden></div></details>
        <div id="execution-root"></div>
        <div class="form-footer authoring-actions"><button type="button" class="btn secondary" id="previous-details">上一步</button><div id="execution-actions"></div></div>
      </div></div></div>`, projectSection('workspace'));
  const prospectusEpoch=epoch;
  prospectusPanel=new ProspectusPanel(api,project.project_id,document.querySelector<HTMLElement>('#prospectus-panel')!,async()=>{
    if(projectExecution?.hasUnconfirmedRequest||!draft)return false;
    const saved=await draft.save();return saved&&!projectExecution?.hasUnconfirmedRequest;
  },async()=>{
    if(prospectusEpoch!==epoch)return;
    prospectusPanel?.dispose();prospectusPanel=undefined;
    await renderRoute();
  },()=>syncProjectExecution(project.project_id),'update',identity);
  document.querySelector('#prospectus-panel')!.addEventListener('prospectus:deleted',event=>{
    const materialId=(event as CustomEvent<{materialId:string}>).detail.materialId;
    for(const upload of localUploads.get(project.project_id)??[])if(upload.material?.material_id===materialId&&!upload.journalDone){
      const recovery=uploadRecovery(project.project_id,upload.owner);
      void recovery.forget(upload.key).catch(()=>{uploadJournalErrors.set(project.project_id,'文件已删除，本机上传恢复记录暂未清除，请刷新后核对。');});
    }
    localUploads.set(project.project_id,(localUploads.get(project.project_id)??[]).filter(upload=>upload.material?.material_id!==materialId));
    recoveredMaterials.set(project.project_id,(recoveredMaterials.get(project.project_id)??[]).filter(material=>material.material_id!==materialId));
  });
  document.querySelector('#prospectus-panel')!.addEventListener('prospectus:skip',()=>{
    const details=document.querySelector<HTMLDetailsElement>('#project-materials-details');if(details)details.open=true;
    const financial=document.querySelector<HTMLElement>('[data-material-role="audit"]');
    financial?.scrollIntoView({block:'start',behavior:'smooth'});
    financial?.querySelector<HTMLInputElement>('input[type="file"]')?.focus({preventScroll:true});
  });
  projectConversation = new ProjectConversation(api, project.project_id, () => projectExecution?.conversationChanged(), '', async text => {
    if (!draft) return false;
    const details = { ...draft.fields.update_details, supplementary_notes: text || null };
    draft.edit({ update_details: details });
    retainUpdateDetails(document.querySelector<HTMLFormElement>('#draft-form')!, details);
    return draft.save();
  });
  projectConversation.mount(document.querySelector<HTMLElement>('#project-conversation-root')!, value);
  const setStep = async (next: 'details' | 'materials') => {
    if(next==='materials'){
      const form=document.querySelector<HTMLFormElement>('#draft-form');
      if(form){const errors=revealUpdateFormErrors(form,readUpdateForm(form));if(errors.length){const error=document.querySelector<HTMLElement>('#page-error')!;error.hidden=false;error.textContent=errors.join(' ');return;}}
      if(!await draft?.save())return;
    }
    if (!document.querySelector('#draft-form')) return;
    document.querySelector<HTMLElement>('#draft-form')!.hidden = next !== 'details';
    document.querySelector<HTMLElement>('#workspace-materials')!.hidden = next !== 'materials';
    document.querySelector('#workspace-steps')!.innerHTML = workspaceSteps(next === 'details' ? 1 : 2);
    const stepQuery=new URLSearchParams({step:next}),intent=new URLSearchParams(location.hash.split('?')[1]);
    if(intent.get('run'))stepQuery.set('run',intent.get('run')!);
    if(intent.get('prepare')==='next'&&intent.get('run'))for(const key of ['prepare','basis','prepare_after']){const value=intent.get(key);if(value)stepQuery.set(key,value);}
    history.replaceState(null, '', `${location.pathname}${location.search}#/projects/${encodeURIComponent(project.project_id)}?${withProjectContext(stepQuery)}`);
    document.querySelector('#workspace-steps')!.scrollIntoView({ block: 'start' });
  };
  document.querySelector('#continue-materials')!.addEventListener('click', () => { void setStep('materials'); });
  for (const id of ['edit-project-details','previous-details']) document.querySelector(`#${id}`)!.addEventListener('click', () => { void setStep('details'); });
  document.querySelector('[data-authoring-requirements]')!.addEventListener('click',()=>{
    if(projectExecution&&!projectExecution.materialsEditable)return;
    const details=document.querySelector<HTMLDetailsElement>('#project-materials-details');if(details)details.open=true;
    const input=document.querySelector<HTMLTextAreaElement>('#project-message');if(input&&!input.disabled){input.scrollIntoView({block:'center'});input.focus({preventScroll:true});}
  });
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
      staleInputNoticeProjectId === project.project_id ? '项目已保存更新的输入版本，请核对最新材料与目标后重新开始。' : '',
      ()=>{void (async()=>{
        await prospectusPanel?.refresh();
        const fresh=await api.project(project.project_id);
        if(prospectusEpoch===epoch)draft?.adoptUnchanged(fresh);
      })().catch(()=>{});},async()=>{
        await refreshProjectMaterials(project.project_id,prospectusEpoch);
        const fresh=await api.project(project.project_id);
        return prospectusEpoch===epoch&&!!draft&&draft.adoptUnchanged(fresh);
      },()=>projectMaterialReadiness(project.project_id).message);
    if (staleInputNoticeProjectId === project.project_id) staleInputNoticeProjectId = undefined;
    projectExecution.mount(document.querySelector<HTMLElement>('#execution-root')!, document.querySelector<HTMLElement>('#execution-actions')!);
  }
  const handoffEpoch=epoch;void mountBusinessHandoff(api,document.querySelector<HTMLElement>('#business-handoff')!,handoffQuery,()=>handoffEpoch===epoch,async handoff=>{const targetDraft=draft;if(!targetDraft||!await targetDraft.save())throw new ApiError(409,'INPUT_REVISION_CONFLICT');const source=await copyHandoffSource(api,handoff,project.project_id,new AbortController().signal);if(handoffEpoch!==epoch||draft!==targetDraft)return;const previous=targetDraft.fields.update_details.supplementary_notes?.trim()??'';const details={...targetDraft.fields.update_details,supplementary_notes:previous.includes(handoff.intent)?previous:[previous,handoff.intent].filter(Boolean).join('\n')};targetDraft.edit({...(source?{has_historical_prospectus:true}:{}),update_details:details});retainUpdateDetails(document.querySelector<HTMLFormElement>('#draft-form')!,details);if(!await targetDraft.save())throw new ApiError(409,'INPUT_REVISION_CONFLICT');await refreshProjectMaterials(project.project_id,handoffEpoch);});
  const form = document.querySelector<HTMLFormElement>('#draft-form')!;
  bindUpdateForm(form, value => { draft?.edit({ name: value.name, issuer_name: value.issuer_name ?? '', market: value.market, offering: value.offering, update_details: value.update_details! }); projectConversation?.setContext(value); updateMaterialWorkspace(project.project_id); }, value.update_details);
  form.addEventListener('submit', event => { event.preventDefault();const errors=revealUpdateFormErrors(form,readUpdateForm(form));if(errors.length){const error=document.querySelector<HTMLElement>('#page-error')!;error.hidden=false;error.textContent=errors.join(' ');return;} void draft?.save(); });
  document.querySelector('#reload-draft')!.addEventListener('click', () => {
    if (!window.confirm('加载最新资料会放弃当前未保存的输入，是否继续？')) return;
    draft?.dispose(); draft = undefined; void renderRoute();
  });
  bindMaterialWorkspace(project.project_id);
  void renderUploadPolicyNote(api, document.querySelector('#upload-policy-note'));
  const deletionEpoch = epoch;
  bindDeletionActions(api, project.project_id, {
    canEdit: () => deletionEpoch === epoch && (!projectExecution || projectExecution.materialsEditable),
    material: materialId => {
      if (deletionEpoch !== epoch) return;
      for(const upload of localUploads.get(project.project_id)??[])if(upload.material?.material_id===materialId&&!upload.journalDone){
        const owner=upload.owner;
        void (async()=>{const recovery=uploadRecovery(project.project_id,owner);if(recovery.list().some(item=>item.id===upload.key))await recovery.forget(upload.key);})().catch(error=>{if(identity===owner){uploadJournalErrors.set(project.project_id,'文件已删除，本机恢复记录尚未清除。'+uploadRecoveryMessage(error));updateMaterialWorkspace(project.project_id);}});
      }
      localUploads.set(project.project_id, (localUploads.get(project.project_id) ?? []).filter(upload => upload.material?.material_id !== materialId));
      recoveredMaterials.set(project.project_id, (recoveredMaterials.get(project.project_id) ?? []).filter(material => material.material_id !== materialId));
      if (draft?.project.project_id === project.project_id) {
        const details = draft.fields.update_details;
        const sources = (details.source_prospectuses ?? []).filter(source => source.material_id !== materialId);
        if (sources.length !== (details.source_prospectuses ?? []).length) {
          draft.edit({ update_details: { ...details, source_prospectuses: sources } });
          retainUpdateDetails(form, draft.fields.update_details);
          void draft.save();
        }
      }
      void refreshProjectMaterials(project.project_id, deletionEpoch);
    },
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
  error.textContent = draft.error ? friendlyError(draft.error,'save') : draft.dirty ? draft.validationErrors.join(' ') : '';
  if (draft.state === 'saved') {
    document.querySelector('#project-heading')!.textContent = draft.project.name;
    document.querySelector('#saved-time')!.textContent = `${date(draft.project.updated_at)} 保存`;
  }
}

function roleLabel(role: UploadRole) {
  const label = OPTIONAL_MATERIAL_GUIDANCE[role]?.label;
  if (label) return label;
  for (const partition of M1_MATERIAL_PARTITIONS as readonly { roles: readonly { code: string; label: string }[] }[]) {
    const match = partition.roles.find(item => item.code === role);
    if (match) return match.label;
  }
  return role;
}

function roleGuidance(role: UploadRole) {
  const guidance = OPTIONAL_MATERIAL_GUIDANCE[role];
  if (guidance) return `选填 · ${guidance.hint}`;
  if (role === 'historical') return '选填：同企业、母公司、子公司或相似业务企业原稿。优先 Word；PDF 重建后需核对排版。';
  if (role === 'reference') return '无历史稿时可选，可提供你希望参考的募集书';
  if (role === 'audit') return '必需提供审计报告，或财务报表及附注；报表和附注已包含在报告中时无需重复上传';
  if (role === 'financial') return '按所需年度提供；已包含在审计报告中时无需另传';
  if (role === 'interimFinancial') return '需要更新最近一期数据时提供对应报表';
  if (role === 'notes') return '报表附注已包含在审计报告中时无需另传';
  if (role === 'fundUse') {
    const purposes = new Set(draft?.fields.update_details.funding_uses.map(use => use.purpose));
    const hints = FUNDING_PURPOSES.filter(purpose => purposes.has(purpose.code)).map(purpose => purpose.materials);
    return `选填 · ${hints.length ? [...new Set(hints)].join(' ') : '按用途提供项目备案、土地及建设许可、基金备案许可或子公司股权投资相关材料'}`;
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
  const percent = uploadSize(upload) ? Math.min(100, Math.floor(upload.sentBytes / uploadSize(upload) * 100)) : 0;
  switch (upload.phase) {
    case 'queued': return upload.declaration?'上传准备已保留，等待传输…':'等待准备，所选文件暂留在本页…';
    case 'hashing': return '正在准备上传和恢复记录…';
    case 'checking': return '正在确认保存结果…';
    case 'uploading': return percent >= 100 ? '已发送 100%，正在保存…' : `正在传输 ${percent}%（${formatBytes(upload.sentBytes)} / ${formatBytes(uploadSize(upload))}）`;
    case 'saving': return '已发送 100%，正在保存…';
    case 'persisted': return `服务器已确认保存 · 材料版本 ${upload.material?.material_version ?? '—'}${upload.uploadId && upload.material?.upload_id !== upload.uploadId ? ' · 已复用相同内容' : ''}`;
    case 'failed': return upload.error ?? '文件未保存。可以单独重试。';
    case 'cancelled': return '已停止本页等待；所选文件仍在此页面，重试时会先确认原上传。';
    case 'uncertain': return upload.error ?? (upload.restored?'上次上传尚未确认。先确认原上传，需要时再重新选择原文件。':'保存结果尚未确认。重试保存时会先确认原上传。');
  }
}

function confirmedMaterials(projectId: string) {
  const materials = new Map((recoveredMaterials.get(projectId) ?? []).map(material => [material.material_id, material]));
  for (const upload of localUploads.get(projectId) ?? []) if (upload.phase === 'persisted' && upload.material && !materials.has(upload.material.material_id)) materials.set(upload.material.material_id, upload.material);
  return [...materials.values()].filter(m=>!prospectusPanel?.inactive.has(m.material_id));
}

function sourceFormatContext(projectId: string): SourceFormatContext | undefined {
  if (!draft || !['update', 'generation'].includes(draft.project.kind)) return undefined;
  return { materials: confirmedMaterials(projectId), sources: draft.fields.update_details.source_prospectuses,
    template: draft.fields.update_details.format_template, inheritedFromResult: projectExecution?.inheritsResultFormat,
    group: `source-format-${projectId}` };
}

function isCurrentProjectWorkspace(projectId: string) {
  // Navigation context (from, step, run, handoff) does not change the project.
  // Keep the full route for navigation, but compare the path when accepting material updates.
  return currentRoute.split('?')[0] === `/projects/${projectId}`;
}

function updateProcessingRows(projectId: string) {
  if (!isCurrentProjectWorkspace(projectId) || !materialProcessing) return;
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

function materialDeleteControl(id:string) {
  return prospectusPanel?.state?.versions.some(v=>v.material_id===id)
    ? '<span class="muted">已保留在版本历史</span>'
    : `<button type="button" class="text-button" data-delete-material="${esc(id)}">删除</button>`;
}

function renderUploadRow(upload: LocalUpload) {
  const active = ['queued', 'hashing', 'checking', 'uploading', 'saving'].includes(upload.phase);
  const showProgress = upload.phase !== 'persisted';
  const progress = Math.min(uploadSize(upload), upload.sentBytes);
  const confirmation=(upload.restored||!upload.file)&&['failed','cancelled','uncertain'].includes(upload.phase);
  const controls = upload.needsReplacement
    ? `<button type="button" class="text-button" data-upload-action="replace" data-upload-key="${esc(upload.key)}">选择其他文件</button>`
    : confirmation
    ? `<button type="button" class="text-button" data-upload-action="retry" data-upload-key="${esc(upload.key)}">确认原上传</button>${upload.needsFile?`<button type="button" class="text-button" data-upload-action="reselect" data-upload-key="${esc(upload.key)}" aria-label="为${esc(uploadName(upload))}重新选择原文件">重新选择原文件继续</button>`:''}`
    : upload.phase === 'failed' || upload.phase === 'cancelled'
    ? `<button type="button" class="text-button" data-upload-action="retry" data-upload-key="${esc(upload.key)}">重试此文件</button>`
    : upload.phase === 'uncertain'
      ? `<button type="button" class="text-button" data-upload-action="retry" data-upload-key="${esc(upload.key)}">重试保存</button>`
      : active
        ? `<button type="button" class="text-button" data-upload-action="cancel" data-upload-key="${esc(upload.key)}">${upload.sentBytes >= uploadSize(upload) ? '停止等待' : '取消此文件'}</button>`
        : '';
  const canRemove = upload.phase === 'persisted' && upload.material
    ? materialDeleteControl(upload.material.material_id)
    : ['failed', 'cancelled', 'uncertain'].includes(upload.phase)
    ? `<button type="button" class="text-button" data-upload-action="remove" data-upload-key="${esc(upload.key)}">移除此行</button>`
    : '';
  const processing = upload.phase === 'persisted' && upload.material ? (materialProcessing?.render(upload.material) ?? '') : '';
  return `<li class="material-file-row" data-upload-phase="${upload.phase}" data-upload-id="${esc(upload.key)}"><div class="material-file-main"><strong>${esc(upload.phase === 'persisted' && upload.material ? upload.material.filename : uploadName(upload))}</strong><span>${esc(roleLabel(upload.role))} · ${formatBytes(uploadSize(upload))}</span>${showProgress ? uploadProgressHtml(upload.phase==='uploading'?uploadTransfer(progress,uploadSize(upload)):uploadActivity(uploadStatus(upload)),uploadName(upload),{showMessage:false,error:upload.phase==='failed'?uploadStatus(upload):undefined,paused:['cancelled','uncertain'].includes(upload.phase)}) : ''}<p class="material-file-status${upload.phase === 'failed' ? ' material-file-error' : ''}" role="${upload.phase === 'failed' ? 'alert' : 'status'}">${esc(uploadStatus(upload))}</p>${processing}${upload.material ? sourceFields(upload.material, draft?.fields.update_details.source_prospectuses, draft ? sourceFormatContext(draft.project.project_id) : undefined) : ''}</div>${controls || canRemove ? `<div class="material-file-actions">${controls}${canRemove}</div>` : ''}</li>`;
}

function renderMaterialPartitions(projectId: string) {
  const seen = new Set<string>();
  const uploads = (localUploads.get(projectId) ?? []).filter(upload => {
    if(upload.material&&prospectusPanel?.inactive.has(upload.material.material_id))return false;
    if (upload.phase !== 'persisted' || !upload.material) return true;
    if (seen.has(upload.material.material_id)) return false;
    seen.add(upload.material.material_id); return true;
  });
  const materials = (recoveredMaterials.get(projectId) ?? []).filter(m=>!prospectusPanel?.inactive.has(m.material_id));
  const localMaterialIds = new Set(uploads.flatMap(upload => upload.material ? [upload.material.material_id] : []));
  // Optional-materials.html extends the workspace prototype; role values still come from contracts.
  const partitions: { label: string; roles: readonly {code: UploadRole; label: string}[]; primary: readonly UploadRole[]; optional?: boolean }[] = [
    {label:'审计报告 / 财务报表及附注',roles:M1_MATERIAL_PARTITIONS[1].roles,primary:['audit']},
    {label:'原稿信息与格式',roles:M1_MATERIAL_PARTITIONS[0].roles,primary:[]},
    {label:'募投项目与权证材料（选填）',roles:M1_MATERIAL_PARTITIONS[2].roles,primary:['fundUse']},
    {label:'债务、授信与担保（选填）',roles:M1_MATERIAL_PARTITIONS[4].roles,primary:['debt','bankFacilities','guarantee','collateralMaterials'],optional:true},
    {label:'公司、经营与信用（选填）',roles:[...M1_MATERIAL_PARTITIONS[5].roles,...M1_MATERIAL_PARTITIONS[3].roles].filter(role=>role.code!=='other'),primary:['governance','corporate','business','rating'],optional:true},
    {label:'其他补充材料（选填）',roles:M1_MATERIAL_PARTITIONS[5].roles.filter(role=>role.code==='other'),primary:['other'],optional:true}
  ];
  const groups = partitions.map((partition, index) => {
    // Keep saved secondary-role files and source declarations accessible without
    // exposing duplicate upload pickers or empty subtype sections.
    const roles = partition.roles.filter(role => partition.primary.includes(role.code) || uploads.some(upload => upload.role === role.code) || materials.some(material => material.role === role.code));
    return `<section class="material-partition${partition.optional ? ' optional-material-partition' : ''}" aria-labelledby="material-partition-${index}"${roles.length ? '' : ' hidden'}><h3 id="material-partition-${index}">${esc(partition.label)}</h3>${index === 1 && sourceFormatContext(projectId) ? formatTemplateNotice(sourceFormatContext(projectId)!) : ''}${partition.optional ? `<p class="optional-material-help">按实际情况提供，未上传这些可选材料也可继续编制。</p><p class="optional-material-formats" id="material-formats-${index}">${OPTIONAL_MATERIAL_FORMATS}</p>` : ''}<ul class="material-role-list">${roles.map(rawRole => {
    const role = {...rawRole,label:OPTIONAL_MATERIAL_GUIDANCE[rawRole.code]?.label ?? rawRole.label};
    const canAdd = partition.primary.includes(role.code);
    const roleUploads = uploads.filter(upload => upload.role === role.code);
    const duplicates = (localUploads.get(projectId) ?? []).filter(upload => upload.role === role.code && upload.phase === 'persisted' && upload.material && upload.uploadId && upload.material.upload_id!==upload.uploadId).map(upload => ({filename: uploadName(upload), material: upload.material!}));
    const roleMaterials = materials.filter(material => material.role === role.code && !localMaterialIds.has(material.material_id));
    const accept = role.code === 'historical' || role.code === 'reference'
      ? '.docx,.pdf'
      : '.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg';
    const saved = roleMaterials.map(material => `<li class="material-file-row persisted-material"><div class="material-file-main"><strong>${esc(material.filename)}</strong><span>${esc(role.label)} · ${formatBytes(material.byte_size)} · 版本 ${material.material_version}</span><p class="material-file-status">服务器已确认保存</p>${materialProcessing?.render(material) ?? ''}${sourceFields(material, draft?.fields.update_details.source_prospectuses, sourceFormatContext(projectId))}</div><div class="material-file-actions">${materialDeleteControl(material.material_id)}</div></li>`).join('');
    const picker = canAdd ? `<label class="button secondary material-picker" for="upload-${esc(role.code)}">${prototypeIcon('upload')}<span>点击或拖入文件</span><input id="upload-${esc(role.code)}" type="file" multiple accept="${accept}" aria-label="为${esc(role.label)}选择文件" ${partition.optional ? `aria-describedby="material-formats-${index}"` : ''} data-upload-role="${esc(role.code)}"/></label>` : '';
    return `<li class="material-role" data-material-role="${esc(role.code)}"><div class="material-role-heading"><div><strong>${esc(role.label)}</strong>${canAdd ? `<span>${esc(roleGuidance(role.code))}</span>` : ''}</div>${picker}</div>${role.code==='audit'?renderFinancialUploadGuidance(draft?.fields.market??null,draft?.fields.offering??null,draft?.fields.update_details.reporting_cutoff??null):''}<ul class="material-file-list">${saved}${roleUploads.map(renderUploadRow).join('')}${duplicateUploadNotices(duplicates)}</ul></li>`;
  }).join('')}</ul></section>`;
  }).join('');
  return groups;
}

function projectMaterialReadiness(projectId: string) {
  const recovery = recoveryStates.get(projectId);
  const pending = (localUploads.get(projectId) ?? []).find(upload => upload.phase !== 'persisted');
  const message = prospectusPanel?.hasUnconfirmed ? '募集书保存或采用结果尚未确认，请先确认后再开始更新。' : recovery?.state === 'unavailable' ? '材料记录读取失败，请点击“刷新已保存材料”重试。'
    : pending ? `${uploadName(pending)}：${uploadStatus(pending)}`
    : recovery?.state !== 'ready' ? '正在读取已保存材料…' : '';
  return {ready: !message, message};
}

function syncProjectExecution(projectId: string) {
  if (!isCurrentProjectWorkspace(projectId)) return;
  const materials = confirmedMaterials(projectId), readiness = projectMaterialReadiness(projectId);
  const count = document.querySelector('#workspace-material-count'); if (count) count.textContent = `${materials.length} 份已保存材料`;
  projectExecution?.sync(materials, readiness.ready, readiness.message);
}

function updateMaterialWorkspace(projectId: string) {
  syncProjectExecution(projectId);
  if (isCurrentProjectWorkspace(projectId)) materialProcessing?.sync(confirmedMaterials(projectId));
  const list = document.querySelector<HTMLElement>('#material-partitions');
  if (list && isCurrentProjectWorkspace(projectId)) {
    // Keep file input nodes attached: rebuilding them during recovery/progress can swallow
    // the native file chooser's change event. Only partition changes add/remove pickers.
    const template = document.createElement('template'); template.innerHTML = renderMaterialPartitions(projectId);
    template.content.querySelectorAll('.material-partition').forEach((fresh, index) => {
      const partition = list.querySelectorAll('.material-partition')[index];
      if (!partition) return;
      partition.toggleAttribute('hidden', fresh.hasAttribute('hidden'));
      const notice = fresh.querySelector(':scope > .source-format-notice'), previous = partition.querySelector(':scope > .source-format-notice');
      if (!notice) previous?.remove();
      else if (previous) previous.replaceWith(notice.cloneNode(true));
      else partition.querySelector('h3')?.after(notice.cloneNode(true));
    });
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
          const guidance = fresh.querySelector('[data-financial-upload-guidance]');
          const oldGuidance = old.querySelector('[data-financial-upload-guidance]');
          if (guidance && oldGuidance?.outerHTML !== guidance.outerHTML) {
            if (oldGuidance) oldGuidance.replaceWith(guidance); else heading.after(guidance);
          }
          const fileList = old.querySelector('.material-file-list')!;
          if (!fileList.querySelector('[data-source-field]:focus')) fileList.innerHTML = fresh.querySelector('.material-file-list')!.innerHTML;
        }
        const next: Element | null = previous ? previous.nextElementSibling : group.firstElementChild;
        if (next !== role) group.insertBefore(role, next);
        previous = role;
      }
      existing.forEach(role => role.remove());
    });
    const context = sourceFormatContext(projectId), selected = context ? selectedFormatTemplate(context) : null;
    list.querySelectorAll<HTMLInputElement>('[data-format-template]').forEach(control => {
      const row = control.closest<HTMLElement>('[data-source-material]');
      control.checked = Boolean(selected && row?.dataset.sourceMaterial === selected.material_id &&
        Number(row.dataset.sourceMaterialVersion) === selected.material_version && row.dataset.sourceSha256 === selected.sha256);
      const label = control.parentElement?.querySelector('span');
      if (label) label.textContent = `沿用此稿格式${control.checked && !context?.template ? '（自动选择）' : ''}`;
    });
  }
  const status = document.querySelector<HTMLElement>('#material-recovery-status');
  if (!status || !isCurrentProjectWorkspace(projectId)) return;
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
    const reused = (localUploads.get(projectId) ?? []).filter(upload => upload.phase === 'persisted' && upload.uploadId && upload.material?.upload_id !== upload.uploadId).length;
    if (reused) status.textContent += ` 本次 ${reused} 份重复上传已复用原材料版本。`;
  }
  if(uploadJournalErrors.has(projectId))status.textContent+=' '+uploadJournalErrors.get(projectId);
}

function declaredMediaType(file: File, role: UploadRole): typeof M1_UPLOAD_MIME_TYPES[number] {
  const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
  const mediaType = mimeByExtension[extension];
  if (!mediaType || !M1_UPLOAD_MIME_TYPES.includes(mediaType)) throw new InvalidUploadFileError('此分区暂不支持该文件扩展名。请选择支持格式的文件，或移除此未保存行。');
  if ((role === 'historical' || role === 'reference') && extension !== 'docx' && extension !== 'pdf') {
    throw new InvalidUploadFileError('募集说明书分区仅接受 DOCX 或 PDF。请选择其他文件，或移除此未保存行。');
  }
  return mediaType;
}

function sha256(bytes: ArrayBuffer) {
  return crypto.subtle.digest('SHA-256', bytes).then(digest => [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''));
}

function uploadName(upload:LocalUpload){return upload.declaration?.filename??upload.file?.name??'待确认材料';}
function uploadSize(upload:LocalUpload){return upload.declaration?.byte_size??upload.file?.size??0;}
function uploadRecovery(projectId:string,owner=identity){
  if(!owner)throw new UserFacingError('请重新登录后确认原上传。');const key=JSON.stringify([owner,projectId]);
  let recovery=uploadRecoveries.get(key);if(!recovery){recovery=new UploadRecovery(api,owner,projectId,'authoring-material',()=>identity===owner);uploadRecoveries.set(key,recovery);}return recovery;
}
function uploadRecoveryMessage(error:unknown){
  return error instanceof UploadRecoveryNeedsFileError||error instanceof UploadRecoveryStorageError||error instanceof UploadRecoveryLockError||error instanceof UploadRecoveryConflictError||error instanceof UploadRecoveryReceiptError?error.message:uploadErrorMessage(error);
}
function restoreUploadRows(projectId:string){
  if(!identity)return;
  try{
    const rows=localUploads.get(projectId)??[],known=new Set(rows.map(row=>row.key));
    for(const record of uploadRecovery(projectId).list()){
      if(known.has(record.id))continue;
      rows.push({key:record.id,owner:identity,projectId,role:record.declaration.role,declaration:record.declaration,hash:record.declaration.sha256,uploadId:record.uploadId,recoveryRecord:record,phase:'uncertain',sentBytes:0,restored:true});
    }
    localUploads.set(projectId,rows);uploadJournalErrors.delete(projectId);
  }catch(error){uploadJournalErrors.set(projectId,uploadRecoveryMessage(error));}
}
function reselectUploadFile(upload:LocalUpload,replace=false){
  if(uploadReselectInputs.has(upload.key))return;
  const input=document.createElement('input');input.type='file';input.hidden=true;input.dataset.uploadReselect=upload.key;input.accept=upload.role==='historical'||upload.role==='reference'?'.docx,.pdf':'.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg';
  const clear=()=>{input.remove();if(uploadReselectInputs.get(upload.key)===input)uploadReselectInputs.delete(upload.key);};
  input.addEventListener('cancel',clear,{once:true});
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];clear();if(!file||identity!==upload.owner||!(localUploads.get(upload.projectId)??[]).includes(upload))return;
    if(replace){await removeUploadRow(upload);if(identity===upload.owner&&!(localUploads.get(upload.projectId)??[]).includes(upload))addUpload(upload.projectId,upload.role,file);return;}
    upload.file=file;upload.explicitResume=true;upload.phase='queued';upload.error=undefined;updateMaterialWorkspace(upload.projectId);pumpUploads();
  },{once:true});
  document.body.append(input);uploadReselectInputs.set(upload.key,input);input.click();
}
async function removeUploadRow(upload:LocalUpload){
  upload.controller?.abort();
  try{
    if(!upload.journalDone){const recovery=uploadRecovery(upload.projectId,upload.owner);if(recovery.list().some(item=>item.id===upload.key))await recovery.forget(upload.key);}
    if(identity!==upload.owner)return;
    localUploads.set(upload.projectId,(localUploads.get(upload.projectId)??[]).filter(item=>item!==upload));uploadReselectInputs.get(upload.key)?.remove();uploadReselectInputs.delete(upload.key);updateMaterialWorkspace(upload.projectId);
    if(upload.phase==='uncertain')void refreshProjectMaterials(upload.projectId,epoch);
  }catch(error){if(identity===upload.owner){upload.phase='failed';upload.error='本机恢复记录尚未移除。'+uploadRecoveryMessage(error);updateMaterialWorkspace(upload.projectId);}}
}

function addUpload(projectId: string, role: UploadRole, file: File) {
  if (!identity || projectExecution && !projectExecution.materialsEditable) return;
  const upload: LocalUpload = { key: crypto.randomUUID(), owner: identity, projectId, role, file, phase: 'queued', sentBytes: 0 };
  const uploads = localUploads.get(projectId) ?? [];
  uploads.push(upload); localUploads.set(projectId, uploads);
  updateMaterialWorkspace(projectId);
  pumpUploads();
}

function pumpUploads() {
  pumpUploadPreparation();
  for (const uploads of localUploads.values()) for (const upload of uploads) {
    if (runningUploads >= 2) return;
    if (upload.phase !== 'queued' || !upload.declaration || upload.controller || upload.owner !== identity) continue;
    runningUploads++; upload.phase = 'hashing';
    void performUpload(upload).finally(() => { runningUploads--; pumpUploads(); });
  }
}
function pumpUploadPreparation(){
  for(const uploads of localUploads.values())for(const upload of uploads){
    if(preparingUploads>=2)return;
    if(upload.phase!=='queued'||upload.declaration||upload.controller||upload.owner!==identity)continue;
    preparingUploads++;upload.phase='hashing';const controller=new AbortController();upload.controller=controller;
    void (async()=>{
      try{
        const file=upload.file;if(!file)throw new UserFacingError('请重新选择原文件。');const media_type=declaredMediaType(file,upload.role);
        if(!file.size)throw new InvalidUploadFileError('空文件不能上传。请选择有内容的文件，或移除此未保存行。');if(file.size>M1_UPLOAD_LIMITS.fileBytes)throw new InvalidUploadFileError('单份文件不能超过 100 MB，请拆分后选择新文件，或移除此未保存行。');
        updateMaterialWorkspace(upload.projectId);const hash=await sha256(await file.arrayBuffer());controller.signal.throwIfAborted();
        if(identity!==upload.owner||!(localUploads.get(upload.projectId)??[]).includes(upload))return;
        const declaration={filename:file.name,media_type,byte_size:file.size,sha256:hash,role:upload.role};
        upload.recoveryRecord=uploadRecovery(upload.projectId,upload.owner).begin(declaration,undefined,upload.key);upload.declaration=declaration;upload.hash=hash;upload.phase='queued';
      }catch(error){
        if(identity!==upload.owner||upload.phase==='cancelled'||upload.phase==='queued'&&controller.signal.aborted)return;
        upload.phase='failed';upload.needsReplacement=uploadNeedsReplacement(error);upload.error=uploadRecoveryMessage(error);
      }finally{
        if(upload.controller===controller)upload.controller=undefined;preparingUploads--;if(identity===upload.owner)updateMaterialWorkspace(upload.projectId);pumpUploads();
      }
    })();
  }
}

async function performUpload(upload: LocalUpload) {
  const controller=new AbortController();upload.controller=controller;
  const isCurrentOwner=()=>identity===upload.owner&&(localUploads.get(upload.projectId)??[]).includes(upload);
  const recovery=uploadRecovery(upload.projectId,upload.owner);
  const previousRecord=upload.explicitResume?upload.recoveryRecord:undefined;upload.explicitResume=false;
  const syncRecord=()=>{const record=recovery.list().find(item=>item.id===upload.key);if(record){upload.uploadId=record.uploadId;upload.recoveryRecord=record;}};
  const accept=(material:Dto<'MaterialResponse'>)=>{
    if(controller.signal.aborted||!isCurrentOwner())return;
    syncRecord();upload.material=material;upload.phase='persisted';upload.error=undefined;upload.restored=false;upload.needsFile=false;upload.sentBytes=uploadSize(upload);
    recoveryStates.set(upload.projectId,{state:'ready'});updateMaterialWorkspace(upload.projectId);void refreshProjectMaterials(upload.projectId,epoch);
  };
  const resume=(file?:File)=>recovery.resume(upload.key,{file,previousRecord,signal:controller.signal,status:()=>{
    if(!isCurrentOwner()||controller.signal.aborted)return;
    const record=recovery.list().find(item=>item.id===upload.key);if(record){upload.uploadId=record.uploadId;upload.recoveryRecord=record;}
    upload.phase=record?.stage==='confirming'?'saving':record?.stage==='bytes_unknown'?'uploading':'checking';updateMaterialWorkspace(upload.projectId);
  },progress:(loaded)=>{
    if(!isCurrentOwner()||controller.signal.aborted)return;upload.sentBytes=Math.min(uploadSize(upload),Math.max(0,loaded));upload.phase=upload.sentBytes>=uploadSize(upload)?'saving':'uploading';updateMaterialWorkspace(upload.projectId);
  }});
  try{
    if(!upload.declaration){
      const file=upload.file;if(!file)throw new UserFacingError('请重新选择原文件。');
      const media_type=declaredMediaType(file,upload.role);if(!file.size)throw new InvalidUploadFileError('空文件不能上传。请选择有内容的文件，或移除此未保存行。');if(file.size>M1_UPLOAD_LIMITS.fileBytes)throw new InvalidUploadFileError('单份文件不能超过 100 MB，请拆分后选择新文件，或移除此未保存行。');
      const hash=upload.hash??await sha256(await file.arrayBuffer());controller.signal.throwIfAborted();if(!isCurrentOwner())return;
      upload.hash=hash;upload.declaration={filename:file.name,media_type,byte_size:file.size,sha256:hash,role:upload.role};
    }
    // An existing page keeps its original identity after another tab clears a
    // completed checkpoint. Only an explicit retry may restore that snapshot;
    // never recreate the same operation as a new declaration without its U.
    if(!upload.recoveryRecord)upload.recoveryRecord=recovery.begin(upload.declaration,undefined,upload.key);
    uploadJournalErrors.delete(upload.projectId);
    upload.phase='checking';updateMaterialWorkspace(upload.projectId);
    if(previousRecord&&!previousRecord.uploadId&&!recovery.list().some(item=>item.id===upload.key)){
      // This page may have seen only the prepared declaration before another
      // tab uploaded and removed its checkpoint. Read scoped saved materials;
      // a missing original U is never permission to create a replacement.
      await refreshProjectMaterials(upload.projectId,epoch);controller.signal.throwIfAborted();if(!isCurrentOwner())return;
      if(recoveryStates.get(upload.projectId)?.state!=='ready')throw new UploadRecoveryConflictError();
      const matches=(recoveredMaterials.get(upload.projectId)??[]).filter(material=>{try{validateUploadMaterial(upload.declaration!,material);return true;}catch{return false;}});
      if(matches.length!==1)throw new UploadRecoveryConflictError();
      const pin=matches[0],material=validateUploadMaterial(upload.declaration,await api.material(upload.projectId,pin.material_id,controller.signal,pin.material_version));
      controller.signal.throwIfAborted();if(!isCurrentOwner())return;
      if(material.material_id!==pin.material_id||material.material_version!==pin.material_version||material.upload_id!==pin.upload_id)throw new UploadRecoveryReceiptError();
      accept(material);return;
    }
    const material=await resume(upload.file);if(controller.signal.aborted||!isCurrentOwner())return;accept(material);
  }catch(error){
    if(!isCurrentOwner())return;
    if(controller.signal.aborted&&upload.phase==='queued')return;
    if(upload.phase==='cancelled'||upload.phase==='uncertain'&&controller.signal.aborted)return;
    try{syncRecord();}catch{/* Keep the visible original file and the storage error. */}
    const aborted=controller.signal.aborted||error instanceof DOMException&&error.name==='AbortError';
    if(error instanceof UploadRecoveryNeedsFileError){upload.needsFile=true;upload.phase='failed';upload.error=error.message;updateMaterialWorkspace(upload.projectId);return;}
    const uncertain=!aborted&&Boolean(upload.uploadId)&&(!(error instanceof ApiError)||error.status===0||error.status>=500)
      &&!(error instanceof UploadRecoveryStorageError||error instanceof UploadRecoveryLockError||error instanceof UploadRecoveryConflictError||error instanceof UploadRecoveryReceiptError);
    upload.needsReplacement=!aborted&&!uncertain&&uploadNeedsReplacement(error);
    upload.phase=aborted?'cancelled':uncertain?'uncertain':'failed';upload.error=aborted?undefined:uploadRecoveryMessage(error);
    updateMaterialWorkspace(upload.projectId);
    if(uncertain){
      upload.error='正在确认原上传的保存结果，无需重复上传…';updateMaterialWorkspace(upload.projectId);
      await refreshProjectMaterials(upload.projectId,epoch);
      for(let attempt=0;attempt<3&&isCurrentOwner()&&!controller.signal.aborted&&upload.phase==='uncertain';attempt++){
        if(attempt)await new Promise(resolve=>setTimeout(resolve,2000));
        if(!isCurrentOwner()||controller.signal.aborted||upload.phase!=='uncertain')break;
        try{const material=await resume();if(controller.signal.aborted||!isCurrentOwner())return;accept(material);}
        catch(confirmationError){
          if(!isCurrentOwner()||controller.signal.aborted)return;upload.phase='uncertain';upload.error=uploadRecoveryMessage(confirmationError);
          if(confirmationError instanceof UploadRecoveryNeedsFileError){upload.needsFile=true;upload.phase='failed';break;}
          if(confirmationError instanceof ApiError&&confirmationError.status>0&&confirmationError.status<500||confirmationError instanceof UploadRecoveryStorageError||confirmationError instanceof UploadRecoveryLockError||confirmationError instanceof UploadRecoveryConflictError||confirmationError instanceof UploadRecoveryReceiptError)break;
        }
      }
      if(isCurrentOwner()&&!controller.signal.aborted&&!upload.material){if(upload.phase==='uncertain')upload.error='暂时无法确认保存结果。上传记录已保留，可稍后重试保存。'+(error instanceof ApiError?errorReference(error):'');else upload.error??='暂时无法确认保存结果，请稍后确认原上传。';updateMaterialWorkspace(upload.projectId);}
    }
  }finally{if(upload.controller===controller)upload.controller=undefined;}
}
async function refreshProjectMaterials(projectId: string, token: number) {
  if (!identity) return;
  const owner = identity;
  recoveryControllers.get(projectId)?.abort();
  const controller = new AbortController(); recoveryControllers.set(projectId, controller);
  recoveredMaterials.delete(projectId);
  recoveryStates.set(projectId, { state: 'loading' }); updateMaterialWorkspace(projectId);
  try {
    await prospectusPanel?.refresh();
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
      if (upload.owner !== owner || upload.projectId !== projectId || upload.phase !== 'uncertain' || !upload.declaration || upload.restored) continue;
      // Match the content and partition, including server-side duplicate reuse.
      // A matching filename or upload ID alone is not a persistence receipt.
      const matches = current.filter(material => {try{validateUploadMaterial(upload.declaration!,material);return true;}catch{return false;}});
      if (matches.length !== 1) continue;
      upload.material = matches[0]; upload.phase = 'persisted'; upload.error = undefined;
      upload.sentBytes = uploadSize(upload);
    }
    const currentIds = new Set(current.map(item => item.material_id));
    for(const upload of localUploads.get(projectId)??[]){
      if(upload.owner!==owner||upload.phase!=='persisted'||!upload.material||upload.journalDone||!upload.declaration)continue;
      const material=current.find(item=>item.material_id===upload.material!.material_id&&item.material_version===upload.material!.material_version);if(!material)continue;
      try{validateUploadMaterial(upload.declaration,material);}catch{continue;}
      try{const recovery=uploadRecovery(projectId,owner);if(recovery.list().some(item=>item.id===upload.key))await recovery.forget(upload.key);upload.journalDone=true;}
      catch(error){if(owner===identity)uploadJournalErrors.set(projectId,'材料已保存，本机恢复记录尚未清除。'+uploadRecoveryMessage(error));}
      if(controller.signal.aborted||token!==epoch||owner!==identity)return;
    }
    localUploads.set(projectId, (localUploads.get(projectId) ?? []).filter(upload => upload.phase !== 'persisted' || !!upload.material && currentIds.has(upload.material.material_id)));
    recoveryStates.set(projectId, { state: 'ready' });
  } catch (error) {
    if (controller.signal.aborted || token !== epoch || owner !== identity) return;
    recoveredMaterials.delete(projectId);
    localUploads.set(projectId, (localUploads.get(projectId) ?? []).filter(upload => upload.phase !== 'persisted'));
    const message = error instanceof ApiError && error.status === 501
      ? '材料事件恢复接口暂不可用；当前项目的服务器材料记录尚未确认。本地选择不会显示为已保存。'
      : `无法读取服务器材料记录。${friendlyError(error,'read')}`;
    recoveryStates.set(projectId, { state: 'unavailable', message });
  } finally {
    if (recoveryControllers.get(projectId) === controller) recoveryControllers.delete(projectId);
    if (token === epoch && owner === identity) updateMaterialWorkspace(projectId);
  }
}

function bindMaterialWorkspace(projectId: string) {
  const host = document.querySelector<HTMLElement>('#material-partitions')!;
  host.addEventListener('change', event => {
    if (projectExecution && !projectExecution.materialsEditable) return;
    const target = event.target as HTMLElement;
    const source = target.closest<HTMLElement>('[data-source-material]');
    if (!source || !draft) return;
    const material = confirmedMaterials(projectId).find(m => m.material_id === source.dataset.sourceMaterial &&
      m.material_version === Number(source.dataset.sourceMaterialVersion) && m.sha256 === source.dataset.sourceSha256);
    if (!material) return;
    if (target.matches('[data-format-template]')) {
      if (!(target instanceof HTMLInputElement) || !target.checked || target.disabled || projectExecution?.inheritsResultFormat) return;
      const details = { ...draft.fields.update_details, format_template: formatTemplatePin(material) };
      draft.edit({ update_details: details });
      retainUpdateDetails(document.querySelector<HTMLFormElement>('#draft-form')!, details);
      updateMaterialWorkspace(projectId);
      host.querySelector<HTMLInputElement>(`[data-format-template="${CSS.escape(material.material_id)}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (!target.dataset.sourceField) return;
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
    updateMaterialWorkspace(projectId);
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
    const resetTemplate = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-format-template-auto]');
    if (resetTemplate) {
      if (!draft || resetTemplate.disabled || projectExecution?.inheritsResultFormat || projectExecution && !projectExecution.materialsEditable) return;
      const details = { ...draft.fields.update_details, format_template: null };
      draft.edit({ update_details: details });
      retainUpdateDetails(document.querySelector<HTMLFormElement>('#draft-form')!, details);
      updateMaterialWorkspace(projectId);
      host.querySelector<HTMLInputElement>('[data-format-template]:checked')?.focus({ preventScroll: true });
      return;
    }
    const retry = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-processing-retry]');
    if (retry) { materialProcessing?.refresh(retry.dataset.processingRetry); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-upload-action]');
    if (!button || projectExecution && !projectExecution.materialsEditable) return;
    const upload = (localUploads.get(projectId) ?? []).find(item => item.key === button.dataset.uploadKey);
    if (!upload) return;
    switch (button.dataset.uploadAction) {
      case 'cancel': {
        const uncertain = upload.phase === 'saving' || upload.sentBytes >= uploadSize(upload);
        upload.phase = uncertain ? 'uncertain' : 'cancelled';
        upload.error = uncertain ? '已停止等待，可稍后重试保存。系统会先查询原记录。' : undefined;
        upload.controller?.abort(); updateMaterialWorkspace(projectId);
        if (uncertain) void refreshProjectMaterials(projectId, epoch);
        break;
      }
      case 'replace': reselectUploadFile(upload,true);break;
      case 'retry': if(upload.needsReplacement)return;upload.explicitResume=true; upload.phase = 'queued'; upload.error = undefined; updateMaterialWorkspace(projectId); pumpUploads(); break;
      case 'reselect': reselectUploadFile(upload);break;
      case 'reconcile': void refreshProjectMaterials(projectId, epoch); break;
      case 'remove': {
        void removeUploadRow(upload);
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
  if (newDirty || creating || draft?.dirty || draft?.state === 'saving' || prospectusPanel?.hasUnconfirmed || projectFiles?.hasUnconfirmed || fileConsistency?.hasUnconfirmed || projectConversation?.hasUnsent || reviewWorkspace?.hasUnconfirmed || materialWorkspace?.hasUnconfirmed || fileWorkspace?.hasUnconfirmed || integrityWorkspace?.hasUnconfirmed || qaWorkspace?.hasUnconfirmed || activeUploads) { event.preventDefault(); event.returnValue = ''; }
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
    if (error instanceof ApiError && error.status === 401) routeSignedOut(); else renderLogin(friendlyError(error,'read'));
  }
}
void start();
