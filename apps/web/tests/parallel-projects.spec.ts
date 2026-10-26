import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactId, assertFixture, boundaryFixture, fixture, ids, install, now, runId, setup, type State } from './parallel-projects-fixtures';

test.afterEach(({ page }) => assertFixture(page));
const panel = (page: Page, id = ids.a) => page.locator(`[data-task-panel="${id}"]`);
const task = (page: Page, run: string, id = ids.a) => panel(page, id).locator(`[data-run-id="${run}"]`);
const sync = (page: Page) => page.locator('#collection-sync');
async function ready(page: Page) {
  await expect(page.locator('.collection-project')).toHaveCount(3);
  await expect(page.locator('#refresh-projects')).toBeEnabled(); await expect(sync(page)).toHaveAttribute('role', 'status');
}
async function expand(page: Page, id = ids.a) {
  const button = page.locator(`[data-tasks="${id}"]`);
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await expect(panel(page, id).locator('[data-run-id]')).toHaveCount(id === ids.a ? 20 : 3);
}
async function older(page: Page) {
  await expand(page); await panel(page).locator(`[data-task-more="${ids.a}"]`).click();
  await expect(panel(page).locator('[data-run-id]')).toHaveCount(40);
  await expect(task(page, runId('a', 6))).toBeVisible();
}
async function signalRefresh(page: Page, state: State) {
  const reads = state.projectReads.length; await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => state.projectReads.length).toBeGreaterThan(reads);
}
async function refreshed(page: Page, state: State) { await signalRefresh(page, state); await expect(page.locator('#refresh-projects')).toBeEnabled(); }
const runIds = (page: Page, id = ids.a) => panel(page, id).locator('[data-run-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-run-id')));
async function viewportAnchor(page: Page, run = runId('a', 7)) {
  const anchor = task(page, run).locator('a'); await anchor.focus();
  await anchor.evaluate(element => element.scrollIntoView({ block: 'center' }));
  return (await anchor.boundingBox())!.y;
}
async function screenshots(page: Page, name: string) {
  const output = process.env.BB_UX_EVIDENCE_DIR; if (!output) return;
  await mkdir(output, { recursive: true });
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 1440 || width === 390) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(output, `parallel-projects-${name}-${width}.png`), fullPage: true });
      await page.screenshot({ path: join(output, `parallel-projects-${name}-${width}-viewport.png`), fullPage: false });
    }
  }
}
async function viewportScreenshot(page: Page, name: string) {
  const output = process.env.BB_UX_EVIDENCE_DIR; if (!output) return;
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, `parallel-projects-${name}-viewport.png`), fullPage: false });
}

test('parallel project summaries show synchronization and exact linked task destinations without writes', async ({ page }) => {
  const state = await setup(page); await ready(page); await older(page);
  await expect(sync(page)).toContainText('2026');
  await expect(panel(page).locator(`[data-task-sync="${ids.a}"]`)).toContainText('同步');
  const old = task(page, runId('a', 7)).locator('a'); await expect(old).toHaveAttribute('href', `#/artifacts/${artifactId('a', 7)}`);
  await expect(old).toHaveAttribute('data-collection-focus', /.+/);
  await expect(task(page, runId('a', 8)).locator('a')).toHaveAttribute('href', `#/projects/${ids.aReview}/review?from=projects&run=${runId('a', 8)}&tab=results&report_id=parallel-exact-review-report-8`);
  expect(state.taskReads.filter(r => r.projectId === ids.a)).toHaveLength(2);
});

test('B completion and a slow B receipt preserve A older tasks, focused exact link and reading position', async ({ page }) => {
  const state = await setup(page); await ready(page); await expand(page, ids.b); await older(page);
  const y = await viewportAnchor(page), old = task(page, runId('a', 7)).locator('a');
  let release!: () => void; state.taskGate = async (id, cursor) => { if (id === ids.b && !cursor) await new Promise<void>(resolve => { release = resolve; }); };
  state.bumpB(); const inserted = state.insertA(); const bReads = state.taskReads.filter(r => r.projectId === ids.b).length;
  await signalRefresh(page, state); await expect.poll(() => state.taskReads.filter(r => r.projectId === ids.b).length).toBeGreaterThan(bReads);
  await expect(old).toBeFocused(); await expect(task(page, runId('a', 6))).toBeVisible(); release();
  await expect(page.locator('#refresh-projects')).toBeEnabled(); await expect(old).toBeFocused();
  expect(Math.abs((await old.boundingBox())!.y - y)).toBeLessThanOrEqual(5);
  await expect(task(page, inserted)).toBeAttached(); await expect(task(page, runId('a', 6))).toBeAttached();
  const all = await runIds(page); expect(new Set(all).size).toBe(all.length);
  await expect(page.locator('.collection-project').first()).toHaveAttribute('data-project-id', ids.b);
  await expect(task(page, runId('b', 3), ids.b)).toContainText('已完成');
  await expect(old).toHaveAttribute('href', `#/artifacts/${artifactId('a', 7)}`);
});

test('the 30-second visible poll preserves the loaded older range and keyboard focus', async ({ page }) => {
  await page.clock.install({ time: new Date(now) }); const state = await setup(page); await ready(page); await older(page);
  const old = task(page, runId('a', 7)).locator('a'); await old.focus(); const reads = state.projectReads.length;
  state.bumpB(); await page.clock.fastForward(30000);
  await expect.poll(() => state.projectReads.length).toBeGreaterThan(reads); await expect(page.locator('#refresh-projects')).toBeEnabled();
  await expect(task(page, runId('a', 6))).toBeAttached(); await expect(old).toBeFocused();
  await expect(sync(page)).toHaveAttribute('aria-live', 'off');
});

test('a failed middle task page keeps the complete prior range and the next successful refresh adopts a complete new range', async ({ page }) => {
  const state = await setup(page); await ready(page); await older(page); const previous = await runIds(page), inserted = state.insertA(); state.bumpB();
  state.failTask = (id, cursor) => id === ids.a && Boolean(cursor);
  await refreshed(page, state); expect(await runIds(page)).toEqual(previous);
  await expect(task(page, inserted)).toHaveCount(0);
  await expect(panel(page).locator(`[data-task-sync="${ids.a}"]`)).toContainText(/未成功|未更新|失败|上次/);
  await expect(page.locator('.collection-project').first()).toHaveAttribute('data-project-id', ids.b);
  state.failTask = undefined; await refreshed(page, state);
  await expect(task(page, inserted)).toBeAttached(); await expect(task(page, runId('a', 6))).toBeAttached();
  const all = await runIds(page); expect(new Set(all).size).toBe(all.length);
});

test('an open project menu reanchors after reorder and Escape returns to the current trigger', async ({ page }) => {
  const state = await setup(page); await ready(page); await page.locator(`[data-work="${ids.a}"]`).click();
  let menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '更新募集书', exact: true }).press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '复核募集书', exact: true })).toBeFocused();
  state.bumpB(); await refreshed(page, state); menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  const trigger = page.locator(`[data-work="${ids.a}"]`); await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem', { name: '复核募集书', exact: true })).toBeFocused();
  await expect(menu.getByRole('menuitem', { name: '复核募集书', exact: true })).toHaveAttribute('href', `#review?project=${ids.a}&from=projects`);
  const rect = await menu.boundingBox(); expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual((await page.viewportSize())!.width + 1);
  await menu.getByRole('menuitem', { name: '复核募集书', exact: true }).press('End');
  await expect(menu.getByRole('menuitem', { name: '归档项目', exact: true })).toBeFocused();
  await menu.getByRole('menuitem', { name: '归档项目', exact: true }).press('Home');
  await menu.getByRole('menuitem', { name: '更新募集书', exact: true }).press('Escape');
  await expect(menu).not.toBeVisible(); await expect(trigger).toBeFocused();
});

for (const change of ['removed', 'archived'] as const) {
  test(`a ${change} project closes its stale menu safely after background refresh`, async ({ page }) => {
    const state = await setup(page); await ready(page); await page.locator(`[data-work="${ids.a}"]`).click(); await expect(page.getByRole('menu')).toBeVisible();
    if (change === 'removed') state.projects.splice(state.projects.findIndex(p => p.project_id === ids.a), 1);
    else state.projects.find(p => p.project_id === ids.a)!.archived_at = now;
    await refreshed(page, state); await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator(`[data-project-id="${ids.a}"]`)).toHaveCount(0);
    await expect(page.locator('#collection-status')).not.toBeEmpty();
  });
}

test('an explicit archive during an older pending collection read queues a fresh read and updates the exact counts', async ({ page }) => {
  const state = fixture(); state.archiveIntent = { projectId: ids.b, archived: true };
  await setup(page, state); await ready(page); await older(page);
  let release!: () => void;
  state.taskGate = async (id, cursor) => { if (id === ids.a && !cursor) await new Promise<void>(resolve => { release = resolve; }); };
  await signalRefresh(page, state); await expect.poll(() => Boolean(release)).toBe(true);
  const busyReads = state.projectReads.length; await expect(page.locator('#project-list')).toHaveAttribute('aria-busy', 'true');
  await page.locator(`[data-work="${ids.b}"]`).click();
  await page.getByRole('menuitem', { name: '归档项目', exact: true }).click();
  await expect(page.locator('#collection-status')).toContainText('项目已归档');
  expect(state.projectReads.length, 'The requested archive refresh must wait for the existing task read.').toBe(busyReads);
  state.taskGate = undefined; release();
  await expect.poll(() => state.projectReads.length).toBeGreaterThan(busyReads);
  await expect(page.locator('#refresh-projects')).toBeEnabled();
  await expect(page.locator(`[data-project-id="${ids.b}"]`)).toHaveCount(0);
  await expect(page.locator('.collection-project')).toHaveCount(2);
  await expect(page.locator('#project-count')).toHaveText('2');
  for (const [group, count] of [['all', '2'], ['attention', '2'], ['active', '1'], ['done', '1']]) {
    await expect(page.locator(`[data-count="${group}"]`)).toHaveText(count);
  }
  await expect(task(page, runId('a', 6))).toBeAttached();
  await page.locator('#project-archive').selectOption('archived');
  await expect(page.locator('.collection-project')).toHaveCount(1);
  await expect(page.locator(`[data-project-id="${ids.b}"]`)).toBeVisible();
  await expect(page.locator('#project-count')).toHaveText('1');
});

for (const journey of ['background refresh', 'same-tab result return'] as const) {
  test(`a project moving from position 30 to 31 retains its older task range and reading position on ${journey}`, async ({ page }) => {
    const state = await setup(page, boundaryFixture(), '#tasks?q=%E5%90%88%E6%88%90');
    await expect(page.locator('#project-count')).toHaveText('32');
    await expect(page.locator('.collection-project')).toHaveCount(30);
    await expect(page.locator('.collection-project').nth(29)).toHaveAttribute('data-project-id', ids.a);
    await expect(page.locator(`[data-project-id="${ids.b}"]`)).toHaveCount(0);
    await older(page); const previous = await runIds(page), y = await viewportAnchor(page);
    if (journey === 'same-tab result return') {
      await task(page, runId('a', 7)).locator('a').click();
      await expect(page.getByRole('heading', { name: '下载募集书', exact: true })).toBeVisible();
      expect(state.artifactReads).toEqual([artifactId('a', 7)]); expect(state.runReads).toEqual([runId('a', 7)]);
    }
    const projectReads = state.projectReads.length; state.bumpB(); const inserted = state.insertA();
    if (journey === 'background refresh') await refreshed(page, state);
    else { await page.goBack(); await expect.poll(() => state.projectReads.length).toBeGreaterThan(projectReads); }
    await expect(page.locator('#refresh-projects')).toBeEnabled();
    await expect(page.locator('.collection-project')).toHaveCount(32);
    await expect(page.locator('.collection-project').first()).toHaveAttribute('data-project-id', ids.b);
    await expect(page.locator('.collection-project').nth(30)).toHaveAttribute('data-project-id', ids.a);
    await expect(page.locator('#list-count')).toContainText('32 / 32');
    await expect(page.getByRole('searchbox')).toHaveValue('合成');
    await expect(task(page, runId('a', 6))).toBeAttached(); await expect(task(page, inserted)).toBeAttached();
    const current = await runIds(page);
    // Completing the page containing the old boundary may also reveal older tasks.
    expect(current.slice(0, previous.length + 1)).toEqual([inserted, ...previous]);
    expect(new Set(current).size).toBe(current.length);
    const old = task(page, runId('a', 7)).locator('a'); await expect(old).toBeInViewport();
    if (journey === 'background refresh') await expect(old).toBeFocused();
    expect(Math.abs((await old.boundingBox())!.y - y)).toBeLessThanOrEqual(8);
    await expect(old).toHaveAttribute('href', `#/artifacts/${artifactId('a', 7)}`);
  });
}

test('search composition and the active search focus are not replaced by another project refresh', async ({ page }) => {
  const state = await setup(page); await ready(page); const search = page.getByRole('searchbox', { name: '搜索项目名称或发行人', exact: true });
  await search.fill('合成'); await search.dispatchEvent('compositionstart'); await search.fill('合成并行甲');
  state.bumpB(); await refreshed(page, state);
  await expect(search).toHaveValue('合成并行甲'); await expect(search).toBeFocused();
  await expect(page.locator('.collection-project')).toHaveCount(3); await search.dispatchEvent('compositionend');
  await expect(page.locator('.collection-project')).toHaveCount(1); await expect(page).toHaveURL(/q=/);
});

test('an initial offline visit without cached projects shows an idle offline state until a real online read succeeds', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }));
  const state = await setup(page);
  await expect(page.getByRole('heading', { name: '全部项目', exact: true })).toBeVisible();
  await expect(sync(page)).toContainText('离线');
  await expect(page.locator('#project-list')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#project-list')).toContainText('离线');
  await expect(page.locator('#project-list')).not.toContainText('正在同步');
  await expect(page.locator('.collection-project')).toHaveCount(0);
  await expect(page.locator('#project-count')).toHaveText('—');
  for (const group of ['all', 'attention', 'active', 'done']) await expect(page.locator(`[data-count="${group}"]`)).toHaveText('—');
  expect(state.projectReads).toEqual([]); expect(state.taskReads).toEqual([]);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
  await ready(page); await expect(page.locator('#project-list')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#project-count')).toHaveText('3'); await expect(sync(page)).not.toContainText('离线');
  expect(state.projectReads).toHaveLength(1);
});

test('offline keeps the last synchronized range and reconnect only becomes fresh after its response', async ({ page, context }) => {
  await page.clock.install({ time: new Date(now) }); const state = await setup(page); await ready(page); await older(page); const previous = await runIds(page);
  await context.setOffline(true); await expect(sync(page)).toContainText('离线'); await expect(sync(page)).toHaveAttribute('aria-live', 'polite'); const reads = state.projectReads.length;
  await page.clock.fastForward(60000); expect(state.projectReads.length).toBe(reads); expect(await runIds(page)).toEqual(previous);
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => scrollTo(0, 0)); await viewportScreenshot(page, 'offline-390');
  let release!: () => void; state.projectGate = () => new Promise<void>(resolve => { release = resolve; }); state.bumpB();
  await context.setOffline(false); await expect.poll(() => state.projectReads.length).toBeGreaterThan(reads);
  await expect(sync(page)).toContainText('同步'); await expect(page.locator('.collection-project').first()).toHaveAttribute('data-project-id', ids.a);
  state.projectGate = undefined; release(); await expect(page.locator('#refresh-projects')).toBeEnabled();
  await expect(page.locator('.collection-project').first()).toHaveAttribute('data-project-id', ids.b); await expect(sync(page)).not.toContainText('离线');
  await expect(sync(page)).toHaveAttribute('aria-live', 'polite');
  await expect(task(page, runId('a', 6))).toBeAttached();
});

test('hidden pages skip polling and becoming visible refreshes the same expanded project', async ({ page }) => {
  await page.clock.install({ time: new Date(now) }); const state = await setup(page); await ready(page); await older(page); const reads = state.projectReads.length;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(60000); expect(state.projectReads.length).toBe(reads);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => state.projectReads.length).toBeGreaterThan(reads); await expect(page.locator('#refresh-projects')).toBeEnabled();
  await expect(task(page, runId('a', 6))).toBeAttached();
});

test('a failed project refresh keeps the old rows and the last successful synchronization evidence', async ({ page }) => {
  const state = await setup(page); await ready(page); await older(page); const old = await runIds(page); state.failProjects = true;
  await refreshed(page, state); await expect(page.locator('#collection-error')).toContainText('上次同步结果');
  await expect(sync(page)).toContainText(/未成功|失败|上次/); await expect(sync(page)).toContainText('2026');
  expect(await runIds(page)).toEqual(old); state.failProjects = false; await refreshed(page, state);
  await expect(page.locator('#collection-error')).toBeHidden(); await expect(task(page, runId('a', 6))).toBeAttached();
});

test('a late owner project response cannot recreate private rows after a cross-tab session change', async ({ page }) => {
  const state = await setup(page); await ready(page); let release!: () => void;
  state.projectGate = () => new Promise<void>(resolve => { release = resolve; }); await signalRefresh(page, state);
  state.authenticated = false;
  await page.evaluate(() => { const otherTabSession = new BroadcastChannel('bondbuddy-session'); otherTabSession.postMessage('changed'); otherTabSession.close(); });
  await expect(page.getByRole('heading', { name: '登录工作区', exact: true })).toBeVisible(); release();
  await expect(page.locator('.collection-project')).toHaveCount(0); await expect(page.locator('#project-list')).toHaveCount(0);
  await expect(page.locator('#login-message')).toContainText('账号会话已在其他页面更改');
});

test('same-tab exact result navigation and browser back restore the older reading range from fresh project data', async ({ page }) => {
  const state = await setup(page, fixture(), '#tasks?q=%E5%90%88%E6%88%90'); await ready(page); await older(page);
  const y = await viewportAnchor(page), before = state.taskReads.length; await task(page, runId('a', 7)).locator('a').click();
  await expect(page).toHaveURL(new RegExp(`#/artifacts/${artifactId('a', 7)}$`));
  await expect(page.getByRole('heading', { name: '下载募集书', exact: true })).toBeVisible();
  expect(state.artifactReads).toEqual([artifactId('a', 7)]); expect(state.runReads).toEqual([runId('a', 7)]);
  state.bumpB(); state.insertA(); await page.goBack();
  await expect(page.getByRole('searchbox')).toHaveValue('合成'); await expect(task(page, runId('a', 7))).toBeVisible();
  await expect(task(page, runId('a', 6))).toBeAttached(); expect(state.taskReads.length).toBeGreaterThan(before);
  expect(Math.abs((await task(page, runId('a', 7)).locator('a').boundingBox())!.y - y)).toBeLessThanOrEqual(8);
  await expect(page.locator('.collection-project').first()).toHaveAttribute('data-project-id', ids.b);
});

test('four viewport layouts keep parallel projects and retained task range usable', async ({ page }) => {
  await setup(page); await ready(page); await screenshots(page, 'loaded'); await older(page); await expand(page, ids.b);
  await screenshots(page, 'expanded');
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 960 });
    await page.locator(`[data-work="${ids.b}"]`).scrollIntoViewIfNeeded(); await page.locator(`[data-work="${ids.b}"]`).click();
    const menu = page.getByRole('menu'); await expect(menu).toBeInViewport();
    if (width === 390 || width === 320) await viewportScreenshot(page, `menu-${width}`);
    await menu.getByRole('menuitem', { name: '更新募集书', exact: true }).press('Escape');
    await expect(page.locator(`[data-work="${ids.b}"]`)).toBeFocused();
    if (width === 390 || width === 320) {
      await panel(page).locator('header').evaluate(element => { element.scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); });
      await expect(panel(page).locator(`[data-task-sync="${ids.a}"]`)).toBeInViewport();
      await expect(task(page, runId('a', 45)).locator('a')).toBeInViewport();
      await viewportScreenshot(page, `tasks-${width}`);
    }
  }
});
