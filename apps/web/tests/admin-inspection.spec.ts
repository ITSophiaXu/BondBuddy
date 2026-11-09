import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page, type Request, type Route, type TestInfo } from '@playwright/test';
import { AdminInspectionSnapshotSchema, type AdminInspectionRow, type AdminInspectionSnapshot } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';

// These operator metadata fixtures are synthetic. Every API request is intercepted;
// this suite does not validate real authentication, payment, balances or settlement.
test.use({ viewport: { width: 1440, height: 960 } });

const fieldNames = ['search', 'kind', 'state', 'from', 'to', 'channel'] as const;
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function snapshot(count = 2, variant: 'original' | 'replacement' = 'original'): AdminInspectionSnapshot {
  const runs: AdminInspectionRow[] = Array.from({ length: count }, (_, index) => ({
    id: `synthetic_run_${index + 1}`, owner_user_id: 'synthetic_operator', project_id: 'synthetic_project',
    task_kind: variant === 'replacement' ? 'generation' : index === 1 && count === 2 ? 'review' : 'update',
    state: variant === 'replacement' ? 'succeeded' : index === 1 && count === 2 ? 'failed' : 'running',
    channel: variant === 'replacement' ? 'trial' : index === 1 && count === 2 ? 'trial' : 'production',
    stage: 'synthetic_stage', created_at: '2026-11-05T01:00:00Z', updated_at: '2026-11-05T03:55:00Z'
  }));
  const tables: Record<string, AdminInspectionRow[]> = {
    bb_runs: runs,
    bb_users: [{ id: 'synthetic_operator', username: '合成运营账号', phone_masked: '****0001', status: 'active', created_at: '2026-11-01T00:00:00Z' }],
    bb_projects: [{ id: 'synthetic_project', owner_user_id: 'synthetic_operator', name: '合成排障项目' }],
    bb_jobs: [], bb_model_call_attempts: [], bb_run_events: [], bb_observability_errors: [], bb_workpaper_batches: []
  };
  const value: AdminInspectionSnapshot = {
    schema_version: 1, source: 'synthetic_test', captured_at: variant === 'replacement' ? '2026-11-05T04:02:00Z' : '2026-11-05T04:00:00Z',
    release: 'synthetic-browser-fixture', scope: { run_limit: 1000, run_count: count, available_run_count: count, description: 'Synthetic UI recovery fixture only.' },
    tables: Object.entries(tables).map(([name, rows]) => ({ name, available: true, total: rows.length, truncated: false, rows })),
    warnings: ['合成浏览器测试数据，不代表真实客户使用、支付或账务验收。']
  };
  if (!Value.Check(AdminInspectionSnapshotSchema, value)) throw new Error('Invalid synthetic inspection fixture');
  return value;
}

async function setup(page: Page, initial = snapshot(), logoutFailures = 0) {
  const calls: { path: string; method: string }[] = [];
  const unexpected: { path: string; method: string }[] = [];
  const pageErrors: string[] = [];
  const routeOutcomes: { path: string; status: number; failure?: string }[] = [];
  const networks = new Map<Request, ReturnType<typeof deferred<void>>>();
  type Reply = { status: number; body: unknown };
  type Hold = {
    requested: ReturnType<typeof deferred<Request>>;
    released: ReturnType<typeof deferred<void>>;
    routed: ReturnType<typeof deferred<void>>;
    reply: Reply;
  };
  const holds: Hold[] = [];
  let current = initial;
  let authenticated = true;
  let logoutAttempts = 0;
  page.on('pageerror', error => { pageErrors.push(error.message); });
  page.on('requestfinished', request => { networks.get(request)?.resolve(undefined); });
  page.on('requestfailed', request => { networks.get(request)?.resolve(undefined); });
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/, '');
    const method = request.method();
    const network = deferred<void>();
    networks.set(request, network);
    calls.push({ path, method });
    let hold: Hold | undefined;
    let reply: Reply;
    if (path === '/admin/inspection/snapshot' && method === 'GET') {
      hold = holds.shift();
      // Capture a response at request time so logout cannot rewrite the deliberately
      // delayed, formerly authorized response into a different fixture.
      reply = authenticated ? { status: 200, body: current } : { status: 401, body: { code: 'UNAUTHENTICATED' } };
      if (hold) {
        hold.requested.resolve(request);
        await hold.released.promise;
        reply = hold.reply;
      }
    } else if (path === '/auth/logout' && method === 'POST') {
      logoutAttempts++;
      if (logoutAttempts <= logoutFailures) reply = { status: 503, body: { code: 'DATA_UNAVAILABLE' } };
      else { authenticated = false; reply = { status: 204, body: null }; }
    } else {
      unexpected.push({ path, method });
      reply = { status: 501, body: { code: 'DATA_UNAVAILABLE' } };
    }
    try {
      if (reply.status === 204) await route.fulfill({ status: 204 });
      else await json(route, reply.status, reply.body);
      routeOutcomes.push({ path, status: reply.status });
    } catch (error) {
      const failure = request.failure()?.errorText;
      routeOutcomes.push({ path, status: reply.status, failure: failure ?? String(error) });
      // Aborting an obsolete read is an expected logout outcome. Other route errors
      // remain harness failures rather than silently turning into passing evidence.
      if (!failure && !page.isClosed()) throw error;
    } finally {
      hold?.routed.resolve(undefined);
    }
  });
  function holdNextSnapshot(status = 200, body: unknown = current) {
    const hold: Hold = { requested: deferred<Request>(), released: deferred<void>(), routed: deferred<void>(), reply: { status, body } };
    holds.push(hold);
    return {
      requested: hold.requested.promise,
      async release() {
        hold.released.resolve(undefined);
        await hold.routed.promise;
        const request = await hold.requested.promise;
        await networks.get(request)!.promise;
      }
    };
  }
  await page.goto('/admin/');
  await page.locator('.workspace').waitFor();
  await readIdle(page);
  return { calls, unexpected, pageErrors, routeOutcomes, holdNextSnapshot };
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function readIdle(page: Page) {
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-refresh]');
    return button ? !button.disabled : Boolean(document.querySelector('[data-login]'));
  });
  await settle(page);
}

async function logout(page: Page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/auth/logout' && value.request().method() === 'POST');
  await page.locator('[data-logout]').click();
  await response;
  await settle(page);
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function evidence(page: Page, info: TestInfo, fixture: Fixture, stage: string) {
  const directory = process.env.BB_ADMIN_INSPECTION_EVIDENCE_DIR ?? info.outputPath('inspection-evidence');
  await mkdir(directory, { recursive: true });
  const state = await page.evaluate(() => {
    const names = ['search', 'kind', 'state', 'from', 'to', 'channel'];
    const fields = Object.fromEntries(names.map(name => [name, document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-filters] [name="${name}"]`)?.value ?? null]));
    const active = document.activeElement as HTMLInputElement | null;
    return {
      fields,
      options: Object.fromEntries(['kind', 'state', 'channel'].map(name => [name, [...(document.querySelector<HTMLSelectElement>(`[name="${name}"]`)?.options ?? [])].map(option => ({ value: option.value, selected: option.selected }))])),
      focus: { tag: active?.tagName ?? null, name: active?.getAttribute('name') ?? null, start: active?.selectionStart ?? null, end: active?.selectionEnd ?? null, direction: active?.selectionDirection ?? null },
      workspace: Boolean(document.querySelector('.workspace')), login: Boolean(document.querySelector('[data-login]')),
      loading: document.querySelector<HTMLButtonElement>('[data-refresh]')?.disabled ?? null,
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent?.trim() ?? ''),
      taskIds: [...document.querySelectorAll<HTMLButtonElement>('.tasks tbody [data-detail]')].map(button => button.dataset.detail!).filter((id, index, all) => all.indexOf(id) === index),
      taskRows: [...document.querySelectorAll('.tasks tbody tr')].map(row => row.textContent?.trim() ?? ''),
      pagination: document.querySelector('.pagination')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      source: document.querySelector('.source-line')?.textContent?.trim() ?? null
    };
  });
  const name = info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 120) + '-' + stage;
  await writeFile(join(directory, name + '.json'), JSON.stringify({ fixture: 'synthetic operator metadata; all API routes intercepted; no real financial validation', state, calls: fixture.calls, unexpected: fixture.unexpected, pageErrors: fixture.pageErrors, routeOutcomes: fixture.routeOutcomes }, null, 2) + '\n', { flag: 'wx' });
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: true });
  return state;
}

function clean(fixture: Fixture) {
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
}

test('inspection refresh preserves six unsent fields and pending input focus', async ({ page }, info) => {
  const fixture = await setup(page);
  const before = { search: 'before-refresh', kind: 'review', state: 'failed', from: '2026-11-04', to: '2026-11-06', channel: 'trial' };
  const during = { search: 'during-refresh', kind: 'update', state: 'running', from: '2026-11-03', to: '2026-11-07', channel: 'production' };
  async function fill(values: typeof before) {
    for (const name of fieldNames) {
      const control = page.locator(`[data-filters] [name="${name}"]`);
      if (['kind', 'state', 'channel'].includes(name)) await control.selectOption(values[name]);
      else await control.fill(values[name]);
    }
  }
  await fill(before);
  await evidence(page, info, fixture, '00-before');
  const held = fixture.holdNextSnapshot();
  await page.locator('[data-refresh]').click();
  await held.requested;
  const started = await evidence(page, info, fixture, '01-started');
  await fill(during);
  await page.locator('[name="search"]').focus();
  await page.locator('[name="search"]').evaluate(element => (element as HTMLInputElement).setSelectionRange(2, 8, 'forward'));
  const pending = await evidence(page, info, fixture, '02-pending');
  await held.release();
  await readIdle(page);
  const completed = await evidence(page, info, fixture, '03-completed');
  expect(started.fields).toEqual(before);
  expect(started.loading).toBe(true);
  expect(pending.fields).toEqual(during);
  expect(completed.fields).toEqual(during);
  expect(completed.focus).toEqual(pending.focus);
  expect(completed.focus).toMatchObject({ name: 'search', start: 2, end: 8, direction: 'forward' });
  clean(fixture);
});

test('inspection failed refresh retains snapshot draft and actionable read feedback', async ({ page }, info) => {
  const fixture = await setup(page);
  await page.locator('nav [data-view="tasks"]').click();
  await page.locator('[name="search"]').fill('unsent-search');
  const before = await evidence(page, info, fixture, '00-before');
  const held = fixture.holdNextSnapshot(503, { code: 'DATA_UNAVAILABLE' });
  await page.locator('[data-refresh]').click();
  await held.requested;
  await held.release();
  await readIdle(page);
  const failed = await evidence(page, info, fixture, '01-failed');
  expect(failed.workspace).toBe(true);
  expect(failed.fields.search).toBe('unsent-search');
  expect(failed.taskIds).toEqual(before.taskIds);
  expect(failed.source).toEqual(before.source);
  expect(failed.alerts.join(' ')).toMatch(/读取.*(?:失败|未完成|暂不可用)/);
  expect(failed.alerts.join(' ')).toMatch(/上次|已有|快照/);
  clean(fixture);
});

test('inspection failed logout keeps the page reports failure and permits one retry', async ({ page }, info) => {
  const fixture = await setup(page, snapshot(), 1);
  await page.locator('nav [data-view="tasks"]').click();
  const before = await evidence(page, info, fixture, '00-before');
  await logout(page);
  const failed = await evidence(page, info, fixture, '01-failed');
  expect(failed.workspace).toBe(true);
  expect(failed.login).toBe(false);
  expect(failed.taskIds).toEqual(before.taskIds);
  expect(failed.alerts.join(' ')).toMatch(/退出.*(?:未完成|失败|未确认)/);
  clean(fixture);
  await logout(page);
  const retried = await evidence(page, info, fixture, '02-retried');
  expect(retried.workspace).toBe(false);
  expect(retried.login).toBe(true);
  expect(fixture.calls.filter(call => call.path === '/auth/logout')).toHaveLength(2);
  clean(fixture);
});

test('inspection logout prevents a delayed snapshot from restoring the dashboard', async ({ page }, info) => {
  const fixture = await setup(page);
  const held = fixture.holdNextSnapshot(200, snapshot(5, 'replacement'));
  await page.locator('[data-refresh]').click();
  await held.requested;
  await evidence(page, info, fixture, '00-pending');
  await logout(page);
  const signedOut = await evidence(page, info, fixture, '01-signed-out');
  await held.release();
  await readIdle(page);
  const late = await evidence(page, info, fixture, '02-late-response');
  expect(signedOut.workspace).toBe(false);
  expect(signedOut.login).toBe(true);
  expect(late.workspace).toBe(false);
  expect(late.login).toBe(true);
  expect(late.taskIds).toEqual([]);
  expect(fixture.calls.filter(call => call.path === '/auth/logout')).toHaveLength(1);
  clean(fixture);
});

test('inspection permission loss clears the previous snapshot instead of displaying it', async ({ page }, info) => {
  const fixture = await setup(page);
  await page.locator('nav [data-view="tasks"]').click();
  await evidence(page, info, fixture, '00-before');
  const held = fixture.holdNextSnapshot(404, { code: 'NOT_FOUND' });
  await page.locator('[data-refresh]').click();
  await held.requested;
  await held.release();
  await readIdle(page);
  const denied = await evidence(page, info, fixture, '01-denied');
  expect(denied.workspace).toBe(false);
  expect(denied.taskIds).toEqual([]);
  expect(denied.source).toBe(null);
  expect(denied.alerts.join(' ')).toMatch(/权限|未部署/);
  clean(fixture);
});

test('inspection refresh clamps page three when fifty one tasks become five', async ({ page }, info) => {
  const fixture = await setup(page, snapshot(51));
  await page.locator('nav [data-view="tasks"]').click();
  await page.locator('[data-next]').click();
  await page.locator('[data-next]').click();
  const before = await evidence(page, info, fixture, '00-page-three');
  const held = fixture.holdNextSnapshot(200, snapshot(5));
  await page.locator('[data-refresh]').click();
  await held.requested;
  await held.release();
  await readIdle(page);
  const updated = await evidence(page, info, fixture, '01-five-tasks');
  expect(before.pagination).toContain('第 3 / 3 页');
  expect(before.taskIds).toEqual(['synthetic_run_51']);
  expect(updated.pagination).toContain('第 1 / 1 页');
  expect(updated.taskIds).toHaveLength(5);
  expect(updated.taskRows.join(' ')).not.toContain('没有符合条件');
  clean(fixture);
});

test('inspection refresh retains selected state kind and channel when their options disappear', async ({ page }, info) => {
  const fixture = await setup(page, snapshot(5));
  await page.locator('nav [data-view="tasks"]').click();
  await page.locator('[name="state"]').selectOption('running');
  await page.locator('[name="kind"]').selectOption('update');
  await page.locator('[name="channel"]').selectOption('production');
  await page.locator('[data-filters] button[type="submit"], [data-filters] button.primary').click();
  const before = await evidence(page, info, fixture, '00-applied');
  const held = fixture.holdNextSnapshot(200, snapshot(5, 'replacement'));
  await page.locator('[data-refresh]').click();
  await held.requested;
  await held.release();
  await readIdle(page);
  const changed = await evidence(page, info, fixture, '01-options-disappeared');
  expect(changed.fields).toEqual(before.fields);
  expect(changed.fields).toMatchObject({ state: 'running', kind: 'update', channel: 'production' });
  expect(changed.taskIds).toEqual([]);
  clean(fixture);
  await page.locator('[data-reset]').click();
  const reset = await evidence(page, info, fixture, '02-reset');
  expect(reset.fields).toMatchObject({ state: '', kind: '', channel: '' });
  expect(reset.taskIds).toHaveLength(5);
  clean(fixture);
});
