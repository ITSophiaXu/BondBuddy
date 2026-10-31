import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { fixtureJson } from './billing-fixture-wire';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Synthetic /api/v1 fixture: exercises the browser against the public account contract, not a live API.
const origin = process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const now = '2026-09-24T12:00:00Z';
type Session = { session_id: string; current: boolean; created_at: string; last_refreshed_at: string | null; refresh_expires_at: string };
type Run = { run_id: string; project_id: string; state: string };
type Fixture = {
  owner: string | null; closed: boolean; password: string; passwordUpdatedAt: string | null; supportContact: string | null;
  sessions: Session[]; activeRuns: Run[]; rateLimitNext: boolean; mutations: { method: string; path: string; body: unknown }[];
};
const retained = ['account_identifier', 'agreement_acceptances', 'registration_event', 'closure_record', 'operation_logs', 'model_usage_records', 'audit_outbox'];
const json = (route: Route, status: number, value?: unknown) => route.fulfill({ status, contentType: 'application/json', body: value === undefined ? '' : status < 400 ? fixtureJson(route, value) : JSON.stringify(value) });
const session = (id: string, current = false): Session => ({ session_id: id, current, created_at: now, last_refreshed_at: current ? now : null, refresh_expires_at: '2026-10-24T12:00:00Z' });

function fixture(): Fixture {
  return { owner: null, closed: false, password: 'Synthetic-password-123', passwordUpdatedAt: null, supportContact: null,
    sessions: [session('session-current', true), session('session-laptop'), session('session-phone')], activeRuns: [], rateLimitNext: false, mutations: [] };
}

async function installApi(context: BrowserContext, state: Fixture) {
  await context.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    if (method !== 'GET') {
      state.mutations.push({ method, path, body });
      // Mirrors the API's CSRF gate so a client that forgets the echo fails here too.
      if (!['/auth/login'].includes(path) && (await request.headerValue('x-bb-csrf')) !== 'synthetic-csrf') return json(route, 403, { code: 'CSRF_DENIED' });
    }
    if (path === '/auth/login' && method === 'POST') {
      const login = body as { username: string; password: string };
      if (state.closed || login.password !== state.password) return json(route, 401, { code: 'UNAUTHENTICATED' });
      state.owner = 'user-owner-a';
      await context.addCookies([{ name: 'bb_session', value: 'synthetic', url: origin, httpOnly: true }, { name: 'bb_csrf', value: 'synthetic-csrf', url: origin }]);
      return json(route, 200, { user_id: state.owner, session_status: 'active', expires_at: now });
    }
    if (!state.owner) return json(route, 401, { code: 'UNAUTHENTICATED' });
    if (path === '/me') return json(route, 200, { user_id: state.owner, session_status: 'active' });
    if (path === '/auth/refresh') return json(route, 200, { user_id: state.owner, session_status: 'active', expires_at: now });
    if (path === '/auth/logout') { state.owner = null; return route.fulfill({ status: 204 }); }
    if (path === '/projects') return json(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    if (path === '/account') return json(route, 200, {
      user_id: state.owner, username: 'owner_a', phone_masked: '+86138****5678', status: 'active', created_at: '2026-09-01T08:00:00Z',
      accepted_terms_version: 'terms-2026-09', current_terms_version: 'terms-2026-10', password_updated_at: state.passwordUpdatedAt,
      self_service_recovery: 'unavailable', support_contact: state.supportContact
    });
    if(path==='/credits/balance')return json(route,200,{enabled:true,available:5000,frozen:300});
    if(path==='/credits/recharge-config')return json(route,200,{enabled:false,providers:[],packs:[{id:'cny200',amount_fen:20000,points:20000},{id:'cny500',amount_fen:50000,points:52500},{id:'cny2000',amount_fen:200000,points:220000},{id:'cny10000',amount_fen:1000000,points:1150000}],pack_version:'synthetic'});
    if (path === '/account/sessions') return json(route, 200, { items: state.sessions });
    const revoke = path.match(/^\/account\/sessions\/([^/]+)$/);
    if (revoke && method === 'DELETE') {
      const id = decodeURIComponent(revoke[1]);
      if (!state.sessions.some(item => item.session_id === id)) return json(route, 404, { code: 'NOT_FOUND' });
      state.sessions = state.sessions.filter(item => item.session_id !== id);
      return route.fulfill({ status: 204 });
    }
    if (path === '/account/sessions/revoke-others') {
      const revoked = state.sessions.filter(item => !item.current).length;
      state.sessions = state.sessions.filter(item => item.current);
      return json(route, 200, { revoked_sessions: revoked });
    }
    if (path === '/account/recovery') return json(route, 200, {enabled:false,support_operator:false,current:null,pending:null});
    if (path === '/account/password') {
      const change = body as { current_password: string; new_password: string };
      if (state.rateLimitNext) { state.rateLimitNext = false; return json(route, 429, { code: 'RATE_LIMITED' }); }
      if (change.new_password.length < 12) return json(route, 422, { code: 'VALIDATION_FAILED' });
      if (change.current_password !== state.password) return json(route, 403, { code: 'PASSWORD_INVALID' });
      const revoked = state.sessions.filter(item => !item.current).length;
      state.password = change.new_password; state.passwordUpdatedAt = now; state.sessions = state.sessions.filter(item => item.current);
      return json(route, 200, { revoked_sessions: revoked });
    }
    if (path === '/account/closure' && method === 'GET') return json(route, 200, {
      can_close: !state.activeRuns.length, active_runs: state.activeRuns, projects: 2, material_versions: 5, available_artifacts: 1,
      balance_status: 'not_applicable_m1', retained_records: retained, local_exports: 'not_affected'
    });
    if (path === '/account/closure' && method === 'POST') {
      const closure = body as { password: string; confirm_username: string };
      if (closure.confirm_username.toLowerCase() !== 'owner_a') return json(route, 422, { code: 'VALIDATION_FAILED' });
      if (closure.password !== state.password) return json(route, 403, { code: 'PASSWORD_INVALID' });
      if (state.activeRuns.length) return json(route, 409, { code: 'ACCOUNT_CLOSURE_BLOCKED' });
      const sessions = state.sessions.length;
      state.closed = true; state.owner = null; state.sessions = [];
      await context.clearCookies();
      return json(route, 200, {
        closure_id: 'closure-synthetic', status: 'closed', closed_at: now, projects_deleted: 2, material_versions_deleted: 5, artifacts_revoked: 1,
        sessions_revoked: sessions, cloud_content: 'access_removed_purge_scheduled', balance_status: 'not_applicable_m1', retained_records: retained, local_exports: 'not_affected'
      });
    }
    return json(route, 404, { code: 'NOT_FOUND' });
  });
}

async function openSettings(page: Page, state: Fixture) {
  await page.goto('/');
  await page.getByLabel('用户名').fill('owner_a');
  await page.getByLabel('密码').fill(state.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: '任务进度与结果', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '我的账号' }).click();
  await expect(page.getByRole('heading', { name: '我的账号', exact: true })).toBeVisible();
}
async function openSecurity(page: Page) {
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  for(const name of ['登录会话','修改密码','注销账号'])await page.locator('summary').filter({hasText:name}).click();
}
const calls = (state: Fixture, path: string) => state.mutations.filter(item => item.path === path);

test('settings show server account facts as text and revoke only other sessions', async ({ page, context }) => {
  const state = fixture(); state.supportContact = '<img src=x onerror=alert(1)> support@example.test'; await installApi(context, state);
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await openSettings(page, state);
  await expect(page.getByRole('link', { name: '我的账号' })).toHaveAttribute('aria-current', 'page');
  const info = page.locator('#account-info');
  await expect(info).toContainText('owner_a');
  await expect(info).toContainText('+86138****5678');
  await expect(info.locator('dt')).toHaveText(['账户名', '绑定手机号']);
  await expect(info).not.toContainText('注册时间');
  await expect(info).not.toContainText('服务协议');
  await expect(info.getByText(state.supportContact, { exact: true })).toHaveCount(0);
  await expect(info.locator('img')).toHaveCount(0);

  await openSecurity(page);
  const rows = page.locator('.session-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('当前会话');
  await expect(rows.first().getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^撤销 .+ 登录的会话$/ })).toHaveCount(2);
  await page.getByRole('button', { name: /^撤销 .+ 登录的会话$/ }).first().click();
  await expect(page.locator('#sessions-message')).toHaveText('已撤销该会话，它不能再访问账号。');
  await expect(rows).toHaveCount(2);
  expect(calls(state, '/account/sessions/session-laptop')).toHaveLength(1);

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-m1-03-settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-m1-03-settings-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: '退出其他全部会话' }).click();
  await expect(page.locator('#sessions-message')).toHaveText('已退出其他 1 个会话。');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('button', { name: '退出其他全部会话' })).toBeDisabled();
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('password change checks input locally, keeps the session on a wrong password and reports revoked sessions', async ({ page, context }) => {
  const state = fixture(); await installApi(context, state);
  await openSettings(page, state);
  await openSecurity(page);
  const current = page.getByLabel('当前密码', { exact: true });
  const next = page.getByLabel('新密码 12–128 个字符', { exact: true });
  const repeat = page.getByLabel('再次输入新密码', { exact: true });
  const submit = page.getByRole('button', { name: '修改密码' });
  const message = page.locator('#password-message');

  await current.fill(state.password); await next.fill('short'); await repeat.fill('short'); await submit.click();
  await expect(message).toHaveText('新密码需为 12–128 个字符，且不能包含控制字符。');
  await next.fill('Synthetic-new-password-456'); await repeat.fill('Synthetic-new-password-789'); await submit.click();
  await expect(message).toHaveText('两次输入的新密码不一致。');
  expect(calls(state, '/account/password')).toHaveLength(0);

  await current.fill('Wrong-password-000'); await repeat.fill('Synthetic-new-password-456'); await submit.click();
  await expect(message).toHaveText('当前密码不正确。');
  await expect(current).toHaveValue('');
  await expect(page.getByRole('dialog', { name: '账号设置' })).toBeVisible();

  state.rateLimitNext = true;
  await current.fill(state.password); await submit.click();
  await expect(message).toHaveText('尝试次数过多，请稍后再试。');

  await submit.click();
  await expect(message).toHaveText('密码已修改。已退出其他 2 个会话，当前页面保持登录。');
  await expect(current).toHaveValue(''); await expect(next).toHaveValue(''); await expect(repeat).toHaveValue('');
  await expect(page.locator('.session-row')).toHaveCount(1);
  expect(state.passwordUpdatedAt).toBe(now);
  expect(calls(state, '/account/password').at(-1)!.body).toEqual({ current_password: 'Synthetic-password-123', new_password: 'Synthetic-new-password-456' });
});

test('closure lists blockers and retained records, needs confirmation, then leaves no private data in any tab', async ({ page, context }) => {
  const state = fixture(); state.activeRuns = [{ run_id: 'run-active', project_id: 'project-synthetic', state: 'running' }]; await installApi(context, state);
  await openSettings(page, state);
  await openSecurity(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('link', { name: '任务进度与结果', exact: true }).first().click();
  await expect(other.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '查看注销影响' }).click();
  const body = page.locator('#closure-body');
  await expect(body).toContainText('还有 1 个任务尚未结束');
  await expect(body.getByRole('link', { name: '查看所属项目' })).toHaveAttribute('href', '#/projects/project-synthetic');
  await expect(body).toContainText('执行中');
  await expect(body).toContainText('2 个项目');
  await expect(body).toContainText('5 个材料版本');
  await expect(body.locator('.closure-summary ul').nth(1).locator('li')).toHaveCount(retained.length);
  await expect(body).toContainText('注销不会删除它们');
  await expect(page.locator('#closure-form')).toHaveCount(0);
  await page.locator('.danger-panel').screenshot({ path: join(tmpdir(), 'bondbuddy-m1-03-closure-blocked.png') });

  state.activeRuns = [];
  await page.getByRole('button', { name: '刷新注销影响' }).click();
  const confirmName = page.getByLabel(/输入用户名/);
  const password = page.getByLabel('输入密码以确认', { exact: true });
  const submit = page.getByRole('button', { name: '永久注销账号' });
  const message = page.locator('#closure-message');
  await page.locator('.danger-panel').screenshot({ path: join(tmpdir(), 'bondbuddy-m1-03-closure-form.png') });
  await confirmName.fill('owner_b'); await password.fill(state.password); await page.getByLabel(/我了解注销后无法恢复/).check(); await submit.click();
  await expect(message).toHaveText('输入的用户名与当前账号不一致。');
  await confirmName.fill('OWNER_A'); await page.getByLabel(/我了解注销后无法恢复/).uncheck(); await submit.click();
  await expect(message).toHaveText('请先勾选确认已了解注销影响。');
  expect(calls(state, '/account/closure')).toHaveLength(0);

  await page.getByLabel(/我了解注销后无法恢复/).check(); await password.fill('Wrong-password-000'); await submit.click();
  await expect(message).toHaveText('密码不正确，账号未注销。');
  await expect(password).toHaveValue('');

  state.activeRuns = [{ run_id: 'run-late', project_id: 'project-synthetic', state: 'queued' }];
  await password.fill(state.password); await submit.click();
  await expect(body).toContainText('注销未执行：仍有任务尚未结束。');
  await expect(body).toContainText('排队中');

  state.activeRuns = [];
  await page.getByRole('button', { name: '刷新注销影响' }).click();
  await page.getByLabel(/输入用户名/).fill('owner_a'); await page.getByLabel('输入密码以确认', { exact: true }).fill(state.password);
  await page.getByLabel(/我了解注销后无法恢复/).check(); await page.getByRole('button', { name: '永久注销账号' }).click();

  await expect(page.getByRole('heading', { name: '账号已注销', exact: true })).toBeVisible();
  await expect(page.locator('.closure-result')).toContainText('已删除 2 个项目、5 个材料版本');
  await expect(page.locator('.closure-result')).toContainText('已撤销 1 份成果的下载权限');
  await expect(page.locator('.closure-result')).toContainText('已结束 3 个登录会话');
  await expect(page.getByText(/平台也不会将其视为已远程删除/)).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-m1-03-closed.png'), fullPage: true });
  await expect(page.getByText('+86138****5678')).toHaveCount(0);
  expect(calls(state, '/account/closure').at(-1)!.body).toEqual({ confirm_username: 'owner_a', password: 'Synthetic-password-123' });
  await expect(other.getByRole('heading', { name: '登录工作区' })).toBeVisible();

  await page.getByRole('button', { name: '返回登录页' }).click();
  await page.getByLabel('用户名').fill('owner_a'); await page.getByLabel('密码').fill(state.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('用户名或密码不正确，请重试。')).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('a session revoked elsewhere returns to login instead of showing account data', async ({ page, context }) => {
  const state = fixture(); await installApi(context, state);
  await openSettings(page, state);
  await page.getByRole('link', { name: '任务进度与结果', exact: true }).first().click();
  await page.getByRole('link', { name: '任务进度与结果', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  state.owner = null;
  await page.getByRole('link', { name: '我的账号' }).click();
  await expect(page.getByRole('heading', { name: '登录工作区' })).toBeVisible();
  await expect(page.getByText('登录已失效。已保存的项目会在重新登录后恢复。')).toBeVisible();
  await expect(page.getByText('+86138****5678')).toHaveCount(0);
});

test('unified account keeps two basic fields and opens security settings only on request',async({page,context})=>{
 const state=fixture();await installApi(context,state);await openSettings(page,state);
 await expect(page.getByRole('navigation',{name:'账号'}).getByRole('link')).toHaveCount(1);
 await expect(page.getByRole('link',{name:'积分与充值',exact:true})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'数据保存与删除',exact:true})).toHaveCount(0);
 await expect(page.locator('#account-credits')).toContainText('5,000');
 await expect(page.locator('#account-credits')).toContainText('300');
 await expect(page.locator('#account-credits')).toContainText('充值渠道暂未开放');
 await expect(page.locator('.credit-pack').first()).toContainText('20,000');
 await expect(page.locator('.credit-pack').first().getByRole('button')).toHaveText('充值 ¥200.00');
 await expect(page.locator('[data-pack="cny50"]')).toHaveCount(0);
 await expect(page.locator('#account-info dt')).toHaveText(['账户名','绑定手机号']);
 for(const name of ['登录会话','修改密码','账号找回','数据说明','注销账号'])await expect(page.locator('summary').filter({hasText:name})).not.toBeVisible();
 await expect(page.locator('.credit-reservation')).toContainText('进行中任务预留 300 积分');
 await expect(page.locator('.credit-reservation')).toContainText('成功后扣除，失败或取消后返还');
 await expect(page.locator('#account-credits')).not.toContainText('任务占用');
 const settingsButton=page.getByRole('button',{name:'账号设置',exact:true});
 await settingsButton.focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('dialog',{name:'账号设置'})).toBeVisible();
 await page.keyboard.press('Escape');await expect(settingsButton).toBeFocused();
 await settingsButton.click();await page.getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.locator('#account-settings')).not.toBeVisible();
 const output=process.env.BB_ACCOUNT_EVIDENCE;
 if(output){await mkdir(output,{recursive:true});for(const width of [1360,390]){await page.setViewportSize({width,height:width===1360?900:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:output+`/implementation-account-${width}.png`,fullPage:true});}
   const html=await page.locator('#app').innerHTML(),css=await page.evaluate(()=>[...document.querySelectorAll('style')].map(n=>n.textContent).join('\n'));
   await writeFile(output+'/account-preview.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的账号 · 合成设计原型</title><style>${css}</style><body><div id="app">${html}</div><script>const settings=document.querySelector('#account-settings');document.querySelector('#open-account-settings').onclick=()=>settings.showModal();document.querySelector('#close-account-settings').onclick=()=>settings.close();</script></body></html>`);
   await settingsButton.click();await page.screenshot({path:output+'/settings-mobile.png'});await page.keyboard.press('Escape');
 }
 await context.route('**/api/v1/credits/balance',route=>json(route,200,{enabled:true,available:5300,frozen:0}));
 await page.goto('/#billing');await expect(page.getByRole('heading',{name:'我的账号',exact:true})).toBeVisible();
 await expect(page.locator('#account-credits')).toContainText('5,300');
 await expect(page.locator('.credit-reservation')).toHaveCount(0);
 if(output){await page.setViewportSize({width:1360,height:900});await page.screenshot({path:output+'/implementation-account-zero-1360.png',fullPage:true});}
});

test('a review payment order returns to the original review workspace',async({page,context})=>{
 const state=fixture();await installApi(context,state);await openSettings(page,state);
 await page.route('**/api/v1/credits/recharge-orders/synthetic-review-order',route=>json(route,200,{order_id:'synthetic-review-order',project_id:'synthetic-review',state:'paid',points:5000,amount_fen:5000,provider:'alipay'}));
 await page.route('**/api/v1/projects/synthetic-review',route=>json(route,200,{project_id:'synthetic-review',kind:'review'}));
 await page.goto('/#/account?order=synthetic-review-order');
 await expect(page.getByRole('heading',{name:'积分已到账'})).toBeVisible();
 for(const link of await page.getByRole('link',{name:'返回项目确认开始'}).all())await expect(link).toHaveAttribute('href','#/projects/synthetic-review/review?tab=materials');
 expect(calls(state,'/review-executions')).toHaveLength(0);
});


test('balance lives in my account, refreshes there and stops polling after leaving',async({page,context})=>{
  await page.clock.install();
  const state=fixture();await installApi(context,state);
  let available=82100,frozen=17900,fail=false,balanceReads=0;
  await context.route('**/api/v1/credits/balance',route=>{balanceReads++;return json(route,fail?503:200,fail?{code:'DATA_UNAVAILABLE'}:{enabled:false,available,frozen});});
  for(const kind of ['consumption','recharge'])await context.route('**/api/v1/credits/'+kind+'-history*',route=>json(route,200,{items:[],page:{has_more:false,next_cursor:null}}));
  await page.setViewportSize({width:1440,height:960});await openSettings(page,state);
  const balance=page.locator('.account-balance-value'),total=page.locator('.account-balance-total');
  await expect(balance).toHaveText('82,100积分');await expect(total).toContainText('100,000');await expect(page.locator('.credit-reservation')).toContainText('17,900');
  await expect(page.locator('.sidebar [data-credit-wallet],.topbar [data-credit-wallet]')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await expect(balance).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.setViewportSize({width:1440,height:960});
  available=0;frozen=0;await page.getByRole('button',{name:'刷新记录与余额'}).click();await expect(balance).toHaveText('0积分');await expect(total).toContainText('余额 0');
  fail=true;await page.getByRole('button',{name:'刷新记录与余额'}).click();await expect(balance).toHaveText('—积分');await expect(total).toContainText('—');
  fail=false;available=80000;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(balance).toHaveText('80,000积分');
  available=70000;await page.clock.fastForward(31000);await expect(balance).toHaveText('70,000积分');
  await page.getByRole('link',{name:'更新募集书',exact:true}).click();await expect(page.locator('.account-balance-value')).toHaveCount(0);
  const reads=balanceReads;await page.clock.fastForward(31000);expect(balanceReads).toBe(reads);
  available=60000;await page.getByRole('link',{name:'我的账号',exact:true}).click();await expect(balance).toHaveText('60,000积分');
  await page.locator('#logout').click();await expect(balance).toHaveCount(0);const logoutReads=balanceReads;
  await page.clock.fastForward(31000);expect(balanceReads).toBe(logoutReads);await expect(page.getByRole('button',{name:'登录',exact:true})).toBeVisible();
});

for(const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[1093,614],[1024,600],[960,600],[853,480],[800,600],[768,1024],[390,844],[320,568],[844,390],[1024,400]]){
 test('responsive navigation and account at '+width+'x'+height,async({page,context})=>{
  const state=fixture();await installApi(context,state);await page.setViewportSize({width:1440,height:960});await openSettings(page,state);
  await page.setViewportSize({width,height});
  await expect(page.locator('.account-balance-value')).toContainText('5,000');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const sidebar=page.locator('#sidebar');
  if(width<=960){await expect(sidebar).toBeHidden();await page.getByRole('button',{name:'打开菜单',exact:true}).click();}
  await expect(sidebar).toBeVisible();await expect(sidebar.locator('[data-credit-wallet]')).toHaveCount(0);
  const integrity=sidebar.getByRole('link',{name:'诚信核查',exact:true});
  // Check the real hit target: visibility alone also passes for clipped links.
  if(height<540)await integrity.scrollIntoViewIfNeeded();
  expect(await integrity.evaluate(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.top>=0&&r.bottom<=innerHeight&&!!hit&&el.contains(hit);})).toBe(true);
  if(height>=540)await expect(sidebar.getByRole('link',{name:'项目问答',exact:true})).toBeInViewport({ratio:1});
  const evidence=process.env.BB_NAV_EVIDENCE_DIR;
  if(evidence&&[1366,1093,390,844].includes(width)){
   await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'implementation-navigation-'+width+'x'+height+'.png')});
   const prototype=await context.newPage();await prototype.setViewportSize({width,height});
   await prototype.goto('/@fs/'+resolve('../../product-prototype/public/navigation-responsive.html').replaceAll('\\','/'));
   if(width<=960)await prototype.getByRole('button',{name:'打开菜单',exact:true}).click();
   await expect(prototype.getByRole('link',{name:'诚信核查',exact:true})).toBeVisible();
   await prototype.screenshot({path:join(evidence,'prototype-navigation-'+width+'x'+height+'.png')});await prototype.close();
  }
  await integrity.click();await expect(page).toHaveURL(/#integrity$/);await expect(sidebar.locator('a[href="#integrity"]')).toHaveAttribute('aria-current','page');
  if(width<=960)await page.getByRole('button',{name:'打开菜单',exact:true}).click();
  const account=sidebar.getByRole('link',{name:'我的账号',exact:true});await account.scrollIntoViewIfNeeded();await account.click();await expect(page.locator('.account-balance-value')).toContainText('5,000');
  if(width<=960){await page.getByRole('button',{name:'打开菜单',exact:true}).click();await sidebar.getByRole('button',{name:'关闭菜单',exact:true}).click();await expect(sidebar).toBeHidden();}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
}


function creditHistoryFixture(){
 const base={project_id:'project-synthetic',project_name:'合成项目',task_name:'完整三维复核',created_at:'2026-10-09T02:00:00Z',finalized_at:'2026-10-09T03:00:00Z',reserved_points:13900,charged_points:13900,released_points:0,corrected_points:0};
 return {fail:false,moreFail:false,available:50000,reads:0,
  consumption:[{...base,reservation_id:'settled',run_id:'run-settled',state:'settled'},{...base,reservation_id:'held',run_id:'run-held',state:'held',charged_points:0,finalized_at:null},{...base,reservation_id:'released',run_id:'run-released',state:'released',charged_points:0,released_points:13900}],
  orders:['paid','pending','expired','failed'].map((state,i)=>({order_id:'order-'+i,provider:'alipay',state,amount_fen:50000,points:52500,created_at:'2026-10-09T02:00:00Z',credited_at:state==='paid'?'2026-10-09T03:00:00Z':null}))};
}
async function installCreditHistory(context:BrowserContext,data:ReturnType<typeof creditHistoryFixture>){
 await context.route('**/api/v1/credits/balance',route=>json(route,200,{enabled:true,available:data.available,frozen:13900}));
 await context.route('**/api/v1/credits/consumption-history*',route=>{data.reads++;const next=new URL(route.request().url()).searchParams.has('cursor');if(data.fail||next&&data.moreFail)return json(route,503,{code:'DATA_UNAVAILABLE'});return json(route,200,{items:next?data.consumption.slice(2):data.consumption.slice(0,2),page:{has_more:!next&&data.consumption.length>2,next_cursor:!next&&data.consumption.length>2?'synthetic-next':null}});});
 await context.route('**/api/v1/credits/recharge-history*',route=>json(route,200,{items:data.orders,page:{has_more:false,next_cursor:null}}));
}
test('credit history separates settlement, reservation and release; paginates and persists after reload',async({page,context})=>{
 const state=fixture(),data=creditHistoryFixture();data.consumption[0].project_name='<img src=x onerror=alert(1)>合成项目';await installApi(context,state);await installCreditHistory(context,data);await openSettings(page,state);
 const history=page.getByRole('region',{name:'积分记录'});
 await expect(history.locator('[data-record=settled]')).toContainText('消耗 13,900 积分');await expect(history.locator('[data-record=held]')).toContainText('预留中 · 未扣费');await expect(history.locator('img')).toHaveCount(0);
 await history.getByRole('button',{name:'加载更多记录'}).click();await expect(history.locator('[data-record=released]')).toContainText('消耗 0 积分');await expect(history.locator('[data-record=released]')).toContainText('已释放 13,900 积分');
 await history.locator('[data-record=settled] summary').click();await expect(history).toContainText('run-settled');await expect(history.getByRole('link',{name:'查看项目'})).toHaveAttribute('href','#/projects/project-synthetic');
 await history.getByRole('button',{name:'刷新记录与余额'}).click();await expect(history.locator('[data-record]')).toHaveCount(3);await expect(history.locator('[data-record=settled] details')).toHaveAttribute('open','');
 await page.reload();await expect(page.locator('[data-record=settled]')).toHaveCount(1);expect(calls(state,'/runs/execute')).toHaveLength(0);
});
test('credit history retries failures without claiming an empty ledger or discarding loaded rows',async({page,context})=>{
 const state=fixture(),data=creditHistoryFixture();data.fail=true;await installApi(context,state);await installCreditHistory(context,data);await openSettings(page,state);
 const history=page.getByRole('region',{name:'积分记录'});await expect(history.getByRole('alert')).toContainText('记录加载失败');await expect(history).not.toContainText('暂无积分消耗');
 data.fail=false;await history.getByRole('button',{name:'重试',exact:true}).click();await expect(history.locator('[data-record=settled]')).toHaveCount(1);
 data.moreFail=true;await history.getByRole('button',{name:'加载更多记录'}).click();await expect(history.getByRole('alert')).toBeVisible();await expect(history.locator('[data-record=settled]')).toHaveCount(1);
 data.moreFail=false;await history.getByRole('button',{name:'重试',exact:true}).click();await expect(history.locator('[data-record]')).toHaveCount(3);
 data.orders=[];await history.getByRole('tab',{name:'充值记录',exact:true}).click();await expect(history).toContainText('暂无充值记录');
});
test('credit history shows actual order states and refreshes arrival and balance without executing tasks',async({page,context})=>{
 const state=fixture(),data=creditHistoryFixture();await installApi(context,state);await installCreditHistory(context,data);await openSettings(page,state);
 const history=page.getByRole('region',{name:'积分记录'});await history.getByRole('tab',{name:'充值记录',exact:true}).click();
 for(const text of ['已到账','待支付／确认中','已关闭／过期','支付未完成'])await expect(history).toContainText(text);
 await expect(history.locator('[data-record=order-0]')).toContainText('¥500.00');await expect(history.locator('[data-record=order-0]')).toContainText('52,500 历史积分');
 data.orders[1].state='paid';data.orders[1].credited_at='2026-10-09T04:00:00Z';data.available+=52500;
 await history.getByRole('button',{name:'刷新记录与余额'}).click();await expect(history.locator('[data-record=order-1]')).toContainText('已到账');await expect(page.locator('.account-balance-value')).toContainText('102,500');
 await expect(history.locator('[data-record]')).toHaveCount(4);expect(state.mutations.filter(x=>x.path.includes('execute')||x.path.includes('recharge-orders'))).toHaveLength(0);
});
test('credit history aborts pending pages and clears private records on logout',async({page,context})=>{
 const state=fixture(),data=creditHistoryFixture();await installApi(context,state);await installCreditHistory(context,data);await openSettings(page,state);await expect(page.locator('[data-record=settled]')).toHaveCount(1);
 let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});let started!:()=>void;const requested=new Promise<void>(r=>{started=r;});
 await context.route('**/api/v1/credits/consumption-history?cursor=*',async route=>{started();await pending;await json(route,200,{items:data.consumption.slice(2),page:{next_cursor:null,has_more:false}}).catch(()=>{});});
 await page.getByRole('button',{name:'加载更多记录'}).click();await requested;await page.locator('#logout').click();release();await expect(page.getByRole('button',{name:'登录',exact:true})).toBeVisible();await expect(page.locator('.credit-history')).toHaveCount(0);await expect(page.getByText('合成项目')).toHaveCount(0);
});
test('credit history matches updated account prototype at desktop and narrow widths',async({page,context})=>{
 const evidence=process.env.BB_HISTORY_EVIDENCE_DIR;test.skip(!evidence,'Screenshot evidence is opt-in');const state=fixture(),data=creditHistoryFixture();await installApi(context,state);await installCreditHistory(context,data);await openSettings(page,state);
 for(const viewport of [{width:1440,height:960},{width:390,height:844}]){
  await page.setViewportSize(viewport);
  for(const kind of ['consumption','recharge']){
   await page.goto('/?history='+viewport.width+kind+'#/account');await page.getByRole('tab',{name:kind==='consumption'?'积分消耗记录':'充值记录',exact:true}).click();await expect(page.locator('.credit-history [data-record]').first()).toBeVisible();await page.locator('.credit-history').evaluate(el=>el.scrollIntoView({block:'start'}));
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await mkdir(evidence!,{recursive:true});await page.screenshot({path:join(evidence!,`implementation-${kind}-${viewport.width}.png`)});
   await page.setContent(await readFile('../../product-prototype/public/account-credits.html','utf8'));if(kind==='recharge')await page.locator('[data-prototype-tab=recharge]').click();await page.locator('.credit-history').evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:join(evidence!,`prototype-${kind}-${viewport.width}.png`)});
  }
 }
});
