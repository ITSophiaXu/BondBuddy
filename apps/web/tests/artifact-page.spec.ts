import { expect, test, type Page, type Route } from '@playwright/test';
import type { Dto } from '../src/api';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Synthetic HTTP fixtures test browser behavior, not DOCX generation or Office compatibility.
const now = '2026-09-26T02:00:00Z';
const projectId = 'synthetic-word-project';
const runId = 'synthetic-successful-run';
const ids = { revision: 'word-revision', clean: 'word-clean', baseline: 'word-baseline' };
const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const bytes = Buffer.from('synthetic Word download bytes');
const project: Dto<'ProjectResponse'> = { project_id: projectId, draft_revision: 4, input_revision: 3, input_hash: 'a'.repeat(64),
  name: '合成成果项目', kind: 'update', issuer_name: '合成发行人', market: 'sse', offering: 'private', updated_at: now };
const run: Dto<'RunResponse'> = { run_id: runId, execution_request_id: 'synthetic-execution', project_id: projectId,
  input_revision: 2, input_hash: 'b'.repeat(64), channel: 'production', test_grant_id: null, uncovered_items: [], state: 'succeeded', stage: 'completed', event_cursor: 5,
  billing_mode: 'platform_trial', reservation_id: null, artifact_id: ids.revision, prompt_snapshot_ref: 'private-snapshot', updated_at: now };
const summary: NonNullable<Dto<'ArtifactResponse'>['word_delivery']> = {
  variant: 'revision', revision_artifact_id: ids.revision, clean_artifact_id: ids.clean, baseline_artifact_id: ids.baseline,
  writer_version: 'bondbuddy-word-delivery-1.0.0', source_sha256: 'c'.repeat(64), baseline_hash: 'd'.repeat(64),
  effective_baseline_sha256: 'e'.repeat(64), plan_hash: 'f'.repeat(64), replacements: 2, columns: 1,
  pending_review_count: 1, pending_review: [{ record_id: 'paragraph-42', message: '待人工确认：请补充授信截至日 <img src=x onerror="window.bad=true">' }]
};
type State = {
  calls: { method: string; path: string }[]; metadataReads: Record<string, number>; grants: string[];
  metadataStatus: number; downloadStatus: number; loggedOut: boolean; missingSummary: boolean;
  changedRun: boolean; runState: Dto<'RunResponse'>['state']; urlOverride?: string; wrongMediaType: boolean;
  pendingCount?: number; pendingItems?: typeof summary.pending_review;
  downloadBody?: Buffer;
  moreProjects?: boolean;
};
const state = (): State => ({ calls: [], metadataReads: {}, grants: [], metadataStatus: 200, downloadStatus: 200,
  loggedOut: false, missingSummary: false, changedRun: false, runState: 'succeeded', wrongMediaType: false });
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function installApi(page: Page, data: State) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    data.calls.push({ method: route.request().method(), path });
    if (path === '/auth/logout') { data.loggedOut = true; return route.fulfill({ status: 204 }); }
    if (path === '/auth/refresh' || data.loggedOut) return json(route, 401, { code: 'UNAUTHENTICATED' });
    if (path === '/me') return json(route, 200, { user_id: 'synthetic-owner', session_status: 'active' });
    if (path === '/projects') return json(route, 200, { items: [{ ...project, status: 'failed', latest_run: { run_id: 'newer-failed-run', state: 'failed', updated_at: now },
      latest_artifact: { artifact_id: ids.revision, run_id: runId, version: 1, created_at: now } }],
      page: { next_cursor: data.moreProjects && !url.searchParams.has('cursor') ? 'synthetic-next' : null, has_more: !!data.moreProjects && !url.searchParams.has('cursor') } });
    if (path === `/projects/${projectId}`) return json(route, 200, project);
    if (path === `/runs/${runId}`) return json(route, 200, { ...run, state: data.runState });
    const match = path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
    if (match) {
      const id = match[1];
      const variant = (Object.keys(ids) as (keyof typeof ids)[]).find(key => ids[key] === id);
      if (!variant) return json(route, 404, { code: 'NOT_FOUND' });
      if (match[2]) {
        data.grants.push(url.searchParams.get('grant') ?? '');
        if (![200, 206].includes(data.downloadStatus)) return json(route, data.downloadStatus, { code: data.downloadStatus === 404 ? 'NOT_FOUND' : 'DATA_UNAVAILABLE' });
        return route.fulfill({ status: data.downloadStatus, contentType: data.wrongMediaType ? 'text/html' : mediaType, body: data.downloadBody ?? bytes });
      }
      data.metadataReads[id] = (data.metadataReads[id] ?? 0) + 1;
      if (data.metadataStatus !== 200) return json(route, data.metadataStatus, { code: data.metadataStatus === 404 ? 'NOT_FOUND' : 'DATA_UNAVAILABLE' });
      const artifact: Dto<'ArtifactResponse'> = { artifact_id: id, run_id: data.changedRun ? 'other-run' : runId, version: 1,
        media_type: mediaType, sha256: createHash('sha256').update(bytes).digest('hex'), quality_status: 'passed', delivery_status: 'available',
        download_url: data.urlOverride ?? `/api/v1/artifacts/${id}/download?grant=fresh-${data.metadataReads[id]}`,
        expires_at: '2026-09-26T02:05:00Z',
        ...(data.missingSummary ? {} : { word_delivery: { ...summary, variant,
          pending_review_count: data.pendingCount ?? summary.pending_review_count, pending_review: data.pendingItems ?? summary.pending_review } }) };
      return json(route, 200, artifact);
    }
    return json(route, 404, { code: 'NOT_FOUND' });
  });
}

test('latest failed run preserves access to successful Word summary and three variants', async ({ page }) => {
  const data = state(); await installApi(page, data);
  await page.goto('/');
  await expect(page.locator('.project-state')).toHaveText('失败');
  await page.getByRole('link', { name: '查看成果与下载' }).click();
  await expect(page.getByRole('heading', { name: '工作稿已生成，含待人工确认事项' })).toBeVisible();
  await expect(page.locator('.artifact-review')).toContainText(summary.pending_review[0].message);
  await expect(page.locator('.artifact-review img')).toHaveCount(0);
  await expect(page.locator('.page-heading')).toContainText('输入版本 2');
  await expect(page.getByRole('button', { name: /^下载/ })).toHaveCount(3);
  for (const [variant, label] of [['revision', '修订版'], ['clean', '清洁版'], ['baseline', '有效基线']] as const) {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: `下载${label}`, exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`合成成果项目-v1-${label}.docx`);
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(data.calls.some(call => call.path === `/artifacts/${ids[variant]}/download`)).toBe(true);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: '待人工确认（1 项）' })).toBeVisible();
  expect(data.calls.every(call => call.method === 'GET')).toBe(true);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-word-results-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-word-results-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

for (const status of [404, 503]) {
  test(`download ${status} stays retryable and obtains a fresh grant`, async ({ page }) => {
    const data = state(); await installApi(page, data);
    await page.goto('/#/artifacts/word-revision');
    await expect(page.getByRole('button', { name: '下载修订版', exact: true })).toBeVisible();
    data.downloadStatus = status;
    await page.getByRole('button', { name: '下载修订版', exact: true }).click();
    await expect(page.locator('[data-download-status="0"]')).toContainText(status === 404 ? '成果或下载授权不可用' : '校验未通过');
    await expect(page.getByRole('button', { name: '下载修订版', exact: true })).toBeEnabled();
    data.downloadStatus = 200;
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载修订版', exact: true }).click(); await downloaded;
    expect(data.grants).toEqual(['fresh-2', 'fresh-3']);
    expect(data.calls.every(call => call.method === 'GET')).toBe(true);
  });
  test(`metadata ${status} hides summary until re-read succeeds`, async ({ page }) => {
    const data = state(); data.metadataStatus = status; await installApi(page, data);
    await page.goto('/#/artifacts/word-revision');
    await expect(page.getByRole('heading', { name: '成果暂时无法打开' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^下载/ })).toHaveCount(0);
    data.metadataStatus = 200;
    await page.getByRole('button', { name: '重新读取成果' }).click();
    await expect(page.getByRole('button', { name: '下载清洁版', exact: true })).toBeVisible();
  });
}

test('legacy metadata has a generic download and never invents a clean version or verified facts', async ({ page }) => {
  const data = state(); data.missingSummary = true; await installApi(page, data);
  await page.goto('/#/artifacts/word-revision');
  await expect(page.getByRole('button', { name: '下载Word 成果' })).toBeVisible();
  await expect(page.getByText('此历史成果未提供变更摘要或待确认清单，请核对文档内容。')).toBeVisible();
  await expect(page.getByRole('button', { name: /^下载/ })).toHaveCount(1);
});

test('missing pending details remain explicitly unresolved', async ({ page }) => {
  const data = state(); data.pendingCount = 2; data.pendingItems = []; await installApi(page, data);
  await page.goto('/#/artifacts/word-revision');
  await expect(page.getByRole('heading', { name: '待人工确认（2 项）' })).toBeVisible();
  await expect(page.getByText('部分待确认详情尚未提供，请核对 Word 内的标记与批注。')).toBeVisible();
});

test('a run that is not succeeded cannot display delivery success', async ({ page }) => {
  const data = state(); data.runState = 'delivering'; await installApi(page, data);
  await page.goto('/#/artifacts/word-revision');
  await expect(page.getByRole('heading', { name: '成果暂时无法打开' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^下载/ })).toHaveCount(0);
});

test('session expiry during download clears private content', async ({ page }) => {
  const data = state(); await installApi(page, data);
  await page.goto('/#/artifacts/word-revision');
  await expect(page.getByRole('button', { name: '下载修订版', exact: true })).toBeVisible();
  data.loggedOut = true;
  await page.getByRole('button', { name: '下载修订版', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByText('合成成果项目')).toHaveCount(0);
  await expect(page.locator('.artifact-review')).toHaveCount(0);
  expect(data.grants).toEqual([]);
});

for (const scenario of ['external URL', 'wrong artifact URL', 'HTML bytes', 'changed run'] as const) {
  test(`refuses ${scenario} without starting a download`, async ({ page }) => {
    const data = state(); await installApi(page, data);
    let downloads = 0; page.on('download', () => downloads++);
    await page.goto('/#/artifacts/word-revision');
    await expect(page.getByRole('button', { name: '下载修订版', exact: true })).toBeVisible();
    if (scenario === 'external URL') data.urlOverride = 'https://example.invalid/file.docx';
    if (scenario === 'wrong artifact URL') data.urlOverride = '/api/v1/artifacts/other/download?grant=wrong';
    if (scenario === 'HTML bytes') data.wrongMediaType = true;
    if (scenario === 'changed run') data.changedRun = true;
    await page.getByRole('button', { name: '下载修订版', exact: true }).click();
    await expect(page.locator('[data-download-status="0"]')).toContainText('校验未通过');
    expect(downloads).toBe(0);
    if (scenario !== 'HTML bytes') expect(data.grants).toEqual([]);
  });
}

test('navigation cancels an in-flight download and suppresses late completion', async ({ page }) => {
  const data = state(); await installApi(page, data);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/artifacts/word-revision/download?*', async route => {
    started(); await pending;
    await route.fulfill({ status: 200, contentType: mediaType, body: bytes }).catch(() => {});
  });
  let downloads = 0; page.on('download', () => downloads++);
  await page.goto('/#/artifacts/word-revision');
  await page.getByRole('button', { name: '下载修订版', exact: true }).click(); await requested;
  await expect(page.getByRole('button', { name: '下载修订版', exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = '/'; });
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  release();
  await expect(page.locator('.artifact-review')).toHaveCount(0);
  expect(downloads).toBe(0);
});

for (const scenario of ['same-length corruption', 'truncated body', 'partial response'] as const) {
  test(`refuses ${scenario} and retries the same artifact without a new task`, async ({ page }) => {
    const data = state(); await installApi(page, data);
    let downloads = 0; page.on('download', () => downloads++);
    await page.goto('/#/artifacts/word-revision');
    await expect(page.getByRole('button', { name: '下载修订版', exact: true })).toBeVisible();
    if (scenario === 'same-length corruption') {
      data.downloadBody = Buffer.from(bytes);
      data.downloadBody[0] ^= 1;
    }
    if (scenario === 'truncated body') data.downloadBody = bytes.subarray(0, bytes.length - 1);
    // Even a 206 carrying the expected bytes is not a complete-download response.
    if (scenario === 'partial response') data.downloadStatus = 206;
    await page.getByRole('button', { name: '下载修订版', exact: true }).click();
    await expect(page.locator('[data-download-status="0"]')).toContainText('校验未通过');
    expect(downloads).toBe(0);
    await expect(page.getByRole('button', { name: '下载修订版', exact: true })).toBeEnabled();
    data.downloadBody = undefined; data.downloadStatus = 200;
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载修订版', exact: true }).click();
    expect(await (await downloaded).failure()).toBeNull();
    expect(data.grants).toEqual(['fresh-2', 'fresh-3']);
    expect(data.calls.every(call => call.method === 'GET')).toBe(true);
  });
}

for (const scenario of ['corrupt bytes', 'partial response', 'unavailable bytes'] as const) {
  test(`project-list download refuses ${scenario} and retries with a fresh grant`, async ({ page }) => {
    const data = state(); await installApi(page, data);
    let downloads = 0; page.on('download', () => downloads++);
    await page.goto('/');
    if (scenario === 'corrupt bytes') data.downloadBody = Buffer.from('corrupt synthetic document');
    if (scenario === 'partial response') data.downloadStatus = 206;
    if (scenario === 'unavailable bytes') data.downloadStatus = 503;
    const button = page.getByRole('button', { name: '下载最近成果' });
    await button.click();
    await expect(page.locator('#project-action-status')).toContainText('校验未通过');
    expect(downloads).toBe(0);
    await expect(button).toBeEnabled();
    data.downloadBody = undefined; data.downloadStatus = 200;
    const downloaded = page.waitForEvent('download');
    await button.click();
    const download = await downloaded;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe('合成成果项目-v1.docx');
    expect(data.grants).toEqual(['fresh-1', 'fresh-2']);
    expect(data.calls.every(call => call.method === 'GET')).toBe(true);
    await expect(page).toHaveURL(/\/$/);
  });
}

for (const scenario of ['changed run', 'unfinished run'] as const) {
  test(`project-list download rejects ${scenario} before reading file bytes`, async ({ page }) => {
    const data = state(); await installApi(page, data);
    if (scenario === 'changed run') data.changedRun = true;
    if (scenario === 'unfinished run') data.runState = 'delivering';
    await page.goto('/');
    await page.getByRole('button', { name: '下载最近成果' }).click();
    await expect(page.locator('#project-action-status')).toContainText('校验未通过');
    expect(data.grants).toEqual([]);
  });
}

for (const action of ['navigate', 'refresh', 'switch account'] as const) {
  test(`project-list download is cancelled on ${action}`, async ({ page }) => {
    const data = state(); await installApi(page, data);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      Object.assign(window, { downloadAborted: false });
      window.fetch = (input, init) => {
        if (String(input).includes('/download?')) init?.signal?.addEventListener('abort', () => Object.assign(window, { downloadAborted: true }));
        return originalFetch(input, init);
      };
    });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    await page.route('**/api/v1/artifacts/word-revision/download?*', async route => {
      started(); await pending;
      await route.fulfill({ status: 200, contentType: mediaType, body: bytes }).catch(() => {});
    });
    let downloads = 0; page.on('download', () => downloads++);
    await page.goto('/');
    await page.getByRole('button', { name: '下载最近成果' }).click(); await requested;
    await expect(page.getByRole('button', { name: '下载最近成果' })).toBeDisabled();
    if (action === 'navigate') {
      await page.getByRole('link', { name: '查看成果与下载' }).click();
      await expect(page.locator('#artifact-summary')).toBeVisible();
    } else if (action === 'refresh') {
      await page.getByRole('button', { name: '刷新列表' }).click();
      await expect(page.getByRole('button', { name: '下载最近成果' })).toBeEnabled();
    } else {
      await page.evaluate(() => { const channel = new BroadcastChannel('bondbuddy-session'); channel.postMessage('changed'); channel.close(); });
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
      await expect(page.getByText('合成成果项目')).toHaveCount(0);
    }
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'downloadAborted'))).toBe(true);
    release();
    expect(downloads).toBe(0);
  });
}

test('project-list pagination keeps a pending download disabled and releases it once complete', async ({ page }) => {
  const data = state(); data.moreProjects = true; await installApi(page, data);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  let byteRequests = 0;
  await page.route('**/api/v1/artifacts/word-revision/download?*', async route => {
    byteRequests++; started(); await pending;
    await route.fulfill({ status: 200, contentType: mediaType, body: bytes });
  });
  await page.goto('/');
  const button = page.getByRole('button', { name: '下载最近成果' });
  await button.click(); await requested;
  await page.getByRole('button', { name: '加载更多项目' }).click();
  await expect(page.getByRole('button', { name: '加载更多项目' })).toBeHidden();
  await expect(button).toBeDisabled();
  const downloaded = page.waitForEvent('download');
  release();
  expect(await (await downloaded).failure()).toBeNull();
  await expect(button).toBeEnabled();
  expect(byteRequests).toBe(1);
  expect(data.metadataReads[ids.revision]).toBe(1);
});
