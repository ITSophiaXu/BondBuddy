import type { CLOSURE_RETAINED_RECORDS, RUN_STATES } from '@bondbuddy/contracts';
import { ApiError, friendlyError, type ApiClient, type Dto } from './api';
import { date, esc } from './ui';

type Account = Dto<'AccountResponse'>;
type Session = Dto<'AccountSessionListResponse'>['items'][number];
type Preview = Dto<'AccountClosurePreviewResponse'>;
type Closure = Dto<'AccountClosureResponse'>;
export type AccountContext = {
  api: ApiClient;
  shell: (content: string, section: string) => void;
  /** Route epoch; results that arrive after the user left the page must not paint over it. */
  epoch: () => number;
  reload: () => void;
  closed: (result: Closure) => void;
};

const retainedLabels: Record<typeof CLOSURE_RETAINED_RECORDS[number], string> = {
  account_identifier: '账号标识（用户名保留，不能再次注册）', agreement_acceptances: '服务协议接受记录', registration_event: '注册记录',
  closure_record: '本次注销记录', operation_logs: '任务与操作日志', model_usage_records: '模型调用用量记录', audit_outbox: '安全审计事件'
};
const runStateLabels: Record<typeof RUN_STATES[number], string> = {
  preparing: '准备中', rejected: '未通过检查', queued: '排队中', running: '执行中', awaiting_input: '等待补充信息', paused: '已暂停',
  validating: '正在检查成果', delivering: '正在交付', settlement_pending: '等待结算', succeeded: '已完成', failed: '已失败', cancelled: '已取消'
};
// DTO enums infer as string; the Record keys above still make the label tables track the contract values.
const labelOf = (labels: Record<string, string>, code: string) => labels[code] ?? code;
const purgeNote = '注销后以上内容立即无法访问，原件和衍生内容按“数据保存与删除”说明中的时限从平台存储中清理。';
const exportsNote = '你已下载或导出到本机的文件不在平台管理范围内，注销不会删除它们，平台也不会将其视为已远程删除。';
// Same rule as the API (apps/api/src/auth.ts) so the form can explain it before submitting.
const passwordValid = (value: string) => value.length >= 12 && value.length <= 128 && new TextEncoder().encode(value).length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

function say(selector: string, text: string, tone: 'ok' | 'error' = 'error') {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return;
  target.textContent = text; target.dataset.tone = tone; target.hidden = !text;
}

const passwordForm = (username: string) => `<p class="muted">修改后会退出其他全部登录会话，当前页面保持登录。</p><form id="password-form" novalidate>
  <input type="text" name="username" autocomplete="username" value="${esc(username)}" hidden readonly/>
  <label for="current-password">当前密码</label><input id="current-password" type="password" autocomplete="current-password" maxlength="512" required/>
  <label for="new-password">新密码 <span class="optional">12–128 个字符</span></label><input id="new-password" type="password" autocomplete="new-password" maxlength="128" required/>
  <label for="confirm-password">再次输入新密码</label><input id="confirm-password" type="password" autocomplete="new-password" maxlength="128" required/>
  <p id="password-message" class="form-message" role="status" hidden></p><div class="form-actions"><button class="button primary" type="submit">修改密码</button></div></form>`;
const closureStart = '<div class="form-actions"><button class="button secondary" id="closure-preview" type="button">查看注销影响</button></div>';
const legacyNote = '<p class="muted">这是旧手机号账号，没有可验证的密码，因此不能在网页修改密码或注销。</p>';

export async function renderAccount(ctx: AccountContext) {
  const token = ctx.epoch();
  const live = () => token === ctx.epoch();
  ctx.shell('<p role="status">正在读取账号设置…</p>', 'account');
  let account: Account, sessions: Session[];
  try {
    const [accountResult, sessionResult] = await Promise.all([ctx.api.account(), ctx.api.sessions()]);
    account = accountResult; sessions = sessionResult.items;
  } catch (error) {
    if (!live()) return;
    ctx.shell(`<div class="empty-state"><h1>账号设置暂时无法打开</h1><p>${esc(friendlyError(error))}</p><button class="button secondary" id="retry-account" type="button">重新加载</button></div>`, 'account');
    document.querySelector('#retry-account')!.addEventListener('click', ctx.reload);
    return;
  }
  if (!live()) return;
  const username = account.username;
  ctx.shell(`<div class="page-heading"><div><p class="eyebrow">账号与安全</p><h1>账号设置</h1><p class="muted">查看账号信息，管理登录会话、密码和账号数据。</p></div></div>
    <div class="detail-layout"><div class="settings-stack">
    <section class="panel" aria-labelledby="account-info-title"><div class="panel-heading"><h2 id="account-info-title">账号信息</h2></div><dl class="settings-list" id="account-info"></dl></section>
    <section class="panel" aria-labelledby="sessions-title"><div class="panel-heading sessions-heading"><div><h2 id="sessions-title">登录会话</h2><p class="muted">每次登录会创建一个会话。撤销后，该会话立即无法继续访问账号。</p></div><button class="button secondary" id="revoke-others" type="button">退出其他全部会话</button></div>
    <p id="sessions-message" class="form-message session-message" role="status" hidden></p><ul class="session-list" id="session-list"></ul></section>
    <section class="panel form-panel" aria-labelledby="password-title"><h2 id="password-title">修改密码</h2>${username ? passwordForm(username) : legacyNote}</section>
    <section class="panel form-panel danger-panel" aria-labelledby="closure-title"><h2 id="closure-title">注销账号</h2><p class="muted">注销会关闭账号，并停止访问账号下的全部项目、材料和成果。完成后无法恢复。</p><div id="closure-body">${username ? closureStart : legacyNote}</div></section>
    </div><aside class="context-panel"><h2>数据服务说明</h2><p>上传的材料会在平台服务器保存一份账号隔离的副本，用于核验和你发起的处理；浏览器中的文件不是唯一副本。</p><p>注销账号后，项目、材料和成果会立即停止访问。保存期限、删除时限与备份清理规则见<a href="#/data-policy">数据保存与删除说明</a>。</p><p>下载到本机的 Word 或其他文件由你自行保管，不受平台删除影响。</p>
    <div class="context-divider"></div><h3>当前为受控试用</h3><p>试用期间不涉及积分、充值或退款。</p></aside></div>`, 'account');

  const paintInfo = () => {
    const accepted = account.accepted_terms_version ? `已接受版本 ${esc(account.accepted_terms_version)}` : '暂无接受记录';
    const current = account.current_terms_version && account.current_terms_version !== account.accepted_terms_version
      ? `<span class="settings-note">当前版本 ${esc(account.current_terms_version)}</span>` : '';
    document.querySelector('#account-info')!.innerHTML = [
      ['用户名', esc(account.username ?? '未设置（旧手机号账号）')],
      ['绑定手机号', esc(account.phone_masked ?? '未绑定')],
      ['注册时间', esc(date(account.created_at))],
      ['密码最近修改', esc(account.password_updated_at ? date(account.password_updated_at) : '—')],
      ['服务协议', accepted + current],
      ['找回账号', '目前没有可靠的身份核验渠道，暂不提供自助找回，也不提供客服重置密码。请妥善保管密码；人工找回流程确定后会在这里说明。'],
      ['联系客服', esc(account.support_contact ?? '客服入口尚未公布')]
    ].map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('');
  };

  let sessionBusy = false;
  const revokeOthers = document.querySelector<HTMLButtonElement>('#revoke-others')!;
  const paintSessions = () => {
    document.querySelector('#session-list')!.innerHTML = sessions.map(session => `<li class="session-row"><div class="session-main"><strong>${session.current ? '当前会话' : '其他会话'}</strong>${session.current ? '<span class="session-badge">本页面正在使用</span>' : ''}<span class="session-meta">登录于 ${esc(date(session.created_at))} · ${session.last_refreshed_at ? `最近续期 ${esc(date(session.last_refreshed_at))}` : '尚未续期'} · 最迟 ${esc(date(session.refresh_expires_at))} 失效</span></div>${session.current
      ? '<span class="session-hint">使用“退出”结束当前会话</span>'
      : `<button class="button secondary" type="button" data-revoke-session="${esc(session.session_id)}" aria-label="撤销 ${esc(date(session.created_at))} 登录的会话" ${sessionBusy ? 'disabled' : ''}>撤销</button>`}</li>`).join('');
    revokeOthers.disabled = sessionBusy || !sessions.some(session => !session.current);
  };
  const syncSessions = async () => {
    try { const result = await ctx.api.sessions(); if (live()) sessions = result.items; }
    catch (error) { if (live()) say('#sessions-message', `会话列表未能刷新。${friendlyError(error)}`); }
    finally { if (live()) paintSessions(); }
  };
  const syncAccount = async () => {
    try { const result = await ctx.api.account(); if (live()) { account = result; paintInfo(); } }
    catch { /* The shown values stay; the next visit reloads them. */ }
  };
  paintInfo(); paintSessions();

  document.querySelector('#session-list')!.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-revoke-session]');
    if (!button || sessionBusy) return;
    const sessionId = button.dataset.revokeSession!;
    sessionBusy = true; paintSessions(); say('#sessions-message', '');
    try {
      await ctx.api.revokeSession(sessionId);
      if (live()) say('#sessions-message', '已撤销该会话，它不能再访问账号。', 'ok');
    } catch (error) {
      if (live()) say('#sessions-message', error instanceof ApiError && error.status === 404 ? '该会话已失效，列表已更新。' : friendlyError(error));
    } finally { if (live()) { sessionBusy = false; await syncSessions(); } }
  });
  revokeOthers.addEventListener('click', async () => {
    if (sessionBusy) return;
    sessionBusy = true; paintSessions(); say('#sessions-message', '');
    try {
      const result = await ctx.api.revokeOtherSessions();
      if (live()) say('#sessions-message', result.revoked_sessions ? `已退出其他 ${result.revoked_sessions} 个会话。` : '没有其他需要退出的会话。', 'ok');
    } catch (error) { if (live()) say('#sessions-message', friendlyError(error)); }
    finally { if (live()) { sessionBusy = false; await syncSessions(); } }
  });

  document.querySelector<HTMLFormElement>('#password-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const field = (id: string) => form.querySelector<HTMLInputElement>(`#${id}`)!;
    const currentPassword = field('current-password').value, newPassword = field('new-password').value;
    if (!currentPassword) { say('#password-message', '请输入当前密码。'); return; }
    if (!passwordValid(newPassword)) { say('#password-message', '新密码需为 12–128 个字符，且不能包含控制字符。'); return; }
    if (newPassword !== field('confirm-password').value) { say('#password-message', '两次输入的新密码不一致。'); return; }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true; button.textContent = '正在修改…'; say('#password-message', '');
    try {
      const result = await ctx.api.changePassword({ current_password: currentPassword, new_password: newPassword });
      if (!live()) return;
      form.reset();
      say('#password-message', `密码已修改。${result.revoked_sessions ? `已退出其他 ${result.revoked_sessions} 个会话，` : ''}当前页面保持登录。`, 'ok');
      await Promise.all([syncSessions(), syncAccount()]);
    } catch (error) {
      if (!live()) return;
      if (error instanceof ApiError && error.code === 'PASSWORD_INVALID') { field('current-password').value = ''; field('current-password').focus(); }
      say('#password-message', !(error instanceof ApiError)
        ? '连接中断，无法确认密码是否已修改。下次登录时如旧密码无效，请使用刚设置的新密码。'
        : error.code === 'VALIDATION_FAILED' ? '新密码需为 12–128 个字符，且不能包含控制字符。' : friendlyError(error));
    } finally { if (live()) { button.disabled = false; button.textContent = '修改密码'; } }
  });

  const closureBody = document.querySelector<HTMLElement>('#closure-body')!;
  const paintClosure = (preview: Preview, message: string) => {
    closureBody.innerHTML = `${message ? `<p class="form-message" role="alert">${esc(message)}</p>` : ''}<div class="closure-summary">
      <h3>将被删除或停止访问</h3><ul><li>${preview.projects} 个项目</li><li>${preview.material_versions} 个材料版本</li><li>${preview.available_artifacts} 份可下载成果（下载权限同时撤销）</li><li>全部登录会话，包括当前页面</li></ul><p>${purgeNote}</p>
      <h3>依规保留的记录</h3><ul>${preview.retained_records.map(record => `<li>${esc(labelOf(retainedLabels, record))}</li>`).join('')}</ul>
      <h3>本机文件与余额</h3><p>${exportsNote}M1 受控试用不涉及积分余额或退款。</p></div>
      ${preview.can_close ? `<form id="closure-form" novalidate><label for="closure-username">输入用户名 <strong>${esc(username)}</strong> 以确认</label><input id="closure-username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" required/>
      <label for="closure-password">输入密码以确认</label><input id="closure-password" type="password" autocomplete="current-password" maxlength="512" required/>
      <label class="check-row" for="closure-ack"><input id="closure-ack" type="checkbox"/><span>我了解注销后无法恢复：项目、材料和成果将无法访问，用户名也不能再次注册。</span></label>
      <p id="closure-message" class="form-message" role="status" hidden></p><div class="form-actions"><button class="button danger" type="submit">永久注销账号</button><button class="button secondary" id="closure-cancel" type="button">暂不注销</button></div></form>`
      : `<div class="conflict-panel" role="alert"><p>还有 ${preview.active_runs.length} 个任务尚未结束，结束前不能注销账号。请等待这些任务结束后再刷新。</p><ul class="closure-runs">${preview.active_runs.map(run => `<li><a href="#/projects/${encodeURIComponent(run.project_id)}">查看所属项目</a> · ${esc(labelOf(runStateLabels, run.state))}</li>`).join('')}</ul><button class="button secondary" id="closure-preview" type="button">刷新注销影响</button></div>`}`;
  };
  const loadPreview = async (message = '') => {
    closureBody.innerHTML = '<p class="muted" role="status">正在读取注销影响…</p>';
    try {
      const preview = await ctx.api.closurePreview();
      if (live()) paintClosure(preview, message);
    } catch (error) {
      if (live()) closureBody.innerHTML = `<p class="form-message" role="alert">无法读取注销影响。${esc(friendlyError(error))}</p><div class="form-actions"><button class="button secondary" id="closure-preview" type="button">重新读取</button></div>`;
    }
  };
  closureBody.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest('button');
    if (target?.id === 'closure-preview') void loadPreview();
    if (target?.id === 'closure-cancel') closureBody.innerHTML = closureStart;
  });
  closureBody.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const confirmName = form.querySelector<HTMLInputElement>('#closure-username')!.value.trim();
    const passwordField = form.querySelector<HTMLInputElement>('#closure-password')!;
    if (confirmName.toLowerCase() !== username!.toLowerCase()) { say('#closure-message', '输入的用户名与当前账号不一致。'); return; }
    if (!passwordField.value) { say('#closure-message', '请输入密码。'); return; }
    if (!form.querySelector<HTMLInputElement>('#closure-ack')!.checked) { say('#closure-message', '请先勾选确认已了解注销影响。'); return; }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true; button.textContent = '正在注销…'; say('#closure-message', '');
    try {
      const result = await ctx.api.closeAccount({ confirm_username: confirmName, password: passwordField.value });
      if (live()) ctx.closed(result);
    } catch (error) {
      if (!live()) return;
      if (error instanceof ApiError && error.code === 'ACCOUNT_CLOSURE_BLOCKED') { await loadPreview('注销未执行：仍有任务尚未结束。'); return; }
      passwordField.value = '';
      say('#closure-message', !(error instanceof ApiError)
        ? '连接中断，无法确认账号是否已注销。请刷新页面查看当前状态，再决定是否重试。'
        : error.code === 'PASSWORD_INVALID' ? '密码不正确，账号未注销。'
          : error.code === 'VALIDATION_FAILED' ? '输入的用户名与当前账号不一致，账号未注销。' : `${friendlyError(error)}账号未注销。`);
    } finally { if (live() && button.isConnected) { button.disabled = false; button.textContent = '永久注销账号'; } }
  });
}

export function renderClosed(root: HTMLElement, result: Closure, done: () => void) {
  root.innerHTML = `<main id="main" class="closed-layout" tabindex="-1"><section class="panel closed-panel" aria-labelledby="closed-title">
    <p class="brand"><img src="/favicon.svg" alt=""/>BondBuddy</p><p class="eyebrow">注销完成</p><h1 id="closed-title">账号已注销</h1><p class="muted">注销时间：${esc(date(result.closed_at))}</p>
    <ul class="closure-result"><li>已删除 ${result.projects_deleted} 个项目、${result.material_versions_deleted} 个材料版本</li><li>已撤销 ${result.artifacts_revoked} 份成果的下载权限</li><li>已结束 ${result.sessions_revoked} 个登录会话</li></ul>
    <p>${purgeNote}</p><p>依规保留：${result.retained_records.map(record => esc(labelOf(retainedLabels, record))).join('、')}。</p><p>${exportsNote}</p>
    <div class="form-actions"><button class="button primary" id="closed-done" type="button">返回登录页</button></div></section></main>`;
  document.querySelector('#closed-done')!.addEventListener('click', done);
  document.querySelector<HTMLElement>('#main')!.focus();
}
