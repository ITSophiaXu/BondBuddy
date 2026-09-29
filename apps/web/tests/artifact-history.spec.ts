import { expect, test, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Dto } from '../src/api';

// Synthetic owner-scoped HTTP and file bytes exercise the browser, not Word generation.
const projectId = 'synthetic-history-project';
const otherProjectId = 'synthetic-other-project';
const when = '2026-09-29T12:00:00Z';
const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const bytes = Buffer.from('synthetic checked Word bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const project = (id = projectId): Dto<'ProjectResponse'> => ({
  project_id: id, draft_revision: 1, input_revision: null, input_hash: null,
  name: '合成历史项目', kind: 'update', issuer_name: '合成发行人',
  market: 'sse', offering: 'private', updated_at: when
});
type Entry = Dto<'ArtifactHistoryResponse'>['items'][number];
const entry = (version: number, channel: Entry['channel'] = 'production', trio = true): Entry => {
  const id = `run-${version}`;
  const primary = { artifact_id: `revision-${version}`, version };
  const base = { run_id: id, input_revision: version + 2, completed_at: when, primary_artifact: primary,
    word_delivery: trio ? { revision: primary, clean: { artifact_id: `clean-${version}`, version },
      baseline: { artifact_id: `baseline-${version}`, version } } : null };
  return channel === 'production' ? { ...base, state: 'succeeded', channel } : { ...base, state: 'test_completed', channel };
};
const initial = [entry(3), entry(2), entry(1, 'production', false)];
type Scenario = {
  entries: Entry[]; requests: { method: string; path: string; query: string }[]; reads: Map<string, number>; grants: string[];
  historyStatus: number; downloadStatus: number; metadataStatus: number; badBytes: boolean; foreignRun: boolean;
  loggedOut: boolean; latestRunState: 'failed' | 'running'; holdHistory?: Promise<void>; historyRequested?: () => void;
  malformedItems?: unknown[]; holdDownload?: Promise<void>; downloadRequested?: () => void;
};
const scenario = (): Scenario => ({ entries: [...initial], requests: [], reads: new Map(), grants: [],
  historyStatus: 200, downloadStatus: 200, metadataStatus: 200, badBytes: false, foreignRun: false, loggedOut: false, latestRunState: 'failed' });
const reply = (route: Route, status: number, data: unknown) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(data)
});

async function install(page: Page, data: Scenario) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice('/api/v1'.length);
    const method = route.request().method();
    data.requests.push({ method, path, query: url.search });
    if (path === '/me') return reply(route, 200, { user_id: 'synthetic-owner', session_status: 'active' });
    if (path === '/auth/refresh' || data.loggedOut) return reply(route, 401, { code: 'UNAUTHENTICATED' });
    if (path === `/projects/${otherProjectId}`) return reply(route, 200, project(otherProjectId));
    if (path === `/projects/${projectId}`) return reply(route, 200, project());
    if (path === '/projects') return reply(route, 200, { items: [{ ...project(), latest_run: { run_id: 'latest-failed',
      state: data.latestRunState, updated_at: when }, latest_artifact: { artifact_id: 'revision-3', run_id: 'run-3', version: 3, created_at: when } }],
      page: { has_more: false, next_cursor: null } });
    if (path.endsWith('/events')) return reply(route, 200, { items: [], next_cursor: null });
    if (path === `/projects/${projectId}/artifacts` || path === `/projects/${otherProjectId}/artifacts`) {
      data.historyRequested?.();
      if (data.holdHistory) await data.holdHistory;
      if (data.historyStatus !== 200) return reply(route, data.historyStatus, { code: data.historyStatus === 404 ? 'NOT_FOUND' :
        data.historyStatus === 422 ? 'VALIDATION_FAILED' : data.historyStatus === 401 ? 'UNAUTHENTICATED' : 'DATA_UNAVAILABLE' });
      const cursor = url.searchParams.get('cursor');
      const items = path.includes(otherProjectId) ? [] : cursor ? data.entries.slice(2) : data.entries.slice(0, 2);
      return reply(route, 200, { items: data.malformedItems ?? items, page: { has_more: !cursor && data.entries.length > 2,
        next_cursor: !cursor && data.entries.length > 2 ? 'after/+=' : null } });
    }
    if (path === '/runs/latest-failed') return reply(route, 200, { run_id: 'latest-failed', project_id: projectId,
      execution_request_id: 'synthetic-latest-execution', input_revision: 6, input_hash: digest,
      state: data.latestRunState, stage: 'model_generation',
      event_cursor: 0, channel: 'production', test_grant_id: null, uncovered_items: [], billing_mode: 'platform_trial',
      reservation_id: null, artifact_id: null, prompt_snapshot_ref: null, updated_at: when });
    const matchRun = path.match(/^\/runs\/(run-\d+)$/);
    if (matchRun) {
      const found = data.entries.find(item => item.run_id === matchRun[1]);
      if (!found) return reply(route, 404, { code: 'NOT_FOUND' });
      return reply(route, 200, { run_id: found.run_id, project_id: data.foreignRun ? otherProjectId : projectId,
        input_revision: found.input_revision, state: found.state, channel: found.channel,
        artifact_id: found.primary_artifact.artifact_id, updated_at: when });
    }
    const matchFile = path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
    if (matchFile) {
      const artifactId = matchFile[1];
      const found = data.entries.find(item => [item.primary_artifact.artifact_id, item.word_delivery?.clean.artifact_id,
        item.word_delivery?.baseline.artifact_id].includes(artifactId));
      if (!found) return reply(route, 404, { code: 'NOT_FOUND' });
      if (matchFile[2]) {
        data.grants.push(url.searchParams.get('grant') ?? '');
        data.downloadRequested?.();
        if (data.holdDownload) await data.holdDownload;
        if (data.downloadStatus !== 200) return reply(route, data.downloadStatus, { code: 'DATA_UNAVAILABLE' });
        return route.fulfill({ status: 200, contentType: mediaType, body: data.badBytes ? Buffer.from('broken file') : bytes }).catch(() => {});
      }
      if (data.metadataStatus !== 200) return reply(route, data.metadataStatus, { code: data.metadataStatus === 404 ? 'NOT_FOUND' : 'DATA_UNAVAILABLE' });
      const count = (data.reads.get(artifactId) ?? 0) + 1; data.reads.set(artifactId, count);
      const variant = artifactId.startsWith('clean') ? 'clean' : artifactId.startsWith('baseline') ? 'baseline' : 'revision';
      return reply(route, 200, { artifact_id: artifactId, run_id: found.run_id,
        version: found.primary_artifact.version, media_type: mediaType, sha256: digest, quality_status: 'passed',
        delivery_status: found.channel === 'production' ? 'available' : 'test_only',
        download_url: `/api/v1/artifacts/${artifactId}/download?grant=fresh-${count}`, expires_at: when,
        ...(found.word_delivery ? { word_delivery: { variant, revision_artifact_id: found.word_delivery.revision.artifact_id,
          clean_artifact_id: found.word_delivery.clean.artifact_id, baseline_artifact_id: found.word_delivery.baseline.artifact_id,
          writer_version: 'synthetic', source_sha256: digest, baseline_hash: digest, effective_baseline_sha256: digest,
          plan_hash: digest, replacements: 0, columns: 0, pending_review_count: 0, pending_review: [] } } : {}) });
    }
    if (path.endsWith('/facts/candidates')) return reply(route, 200, { items: [], page: { has_more: false, next_cursor: null } });
    return reply(route, 404, { code: 'NOT_FOUND' });
  });
}
async function open(page: Page, data: Scenario) {
  await install(page, data);
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.locator('#word-history-title')).toBeVisible();
  await expect(page.locator('.word-history-item')).toHaveCount(Math.min(data.entries.length, 2));
}

test('API client paginates checked versions in the same project, keeps old successes after a newer failed run, and downloads each variant with a fresh grant', async ({ page }) => {
  const data = scenario(); await open(page, data);
  await expect(page.locator('#execution-progress')).toContainText('任务失败');
  await expect(page.locator('.word-history-item')).toHaveCount(2);
  await page.getByRole('button', { name: '加载更多版本' }).click();
  await expect(page.locator('.word-history-item')).toHaveCount(3);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#word-history-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), 'bb34-history-implementation-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#word-history-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), 'bb34-history-implementation-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const cursors = data.requests.filter(request => request.path.endsWith('/artifacts'))
    .map(request => new URLSearchParams(request.query).get('cursor'));
  expect(cursors.at(-1)).toBe('after/+=');
  expect(cursors.slice(0, -1).every(cursor => cursor === null)).toBe(true);
  expect(data.requests.filter(request => request.path.endsWith('/artifacts')).every(request => new URLSearchParams(request.query).get('limit') === '20')).toBe(true);
  for (const [index, name] of [[0, '修订版'], [1, '清洁版'], [2, '有效基线']] as const) {
    const downloaded = page.waitForEvent('download');
    await page.locator('.word-history-item').first().getByRole('button', { name: `下载${name}` }).click();
    expect((await downloaded).suggestedFilename()).toBe(`合成历史项目-v3-${name}.docx`);
    expect(data.reads.get(['revision-3','clean-3','baseline-3'][index])).toBe(1);
  }
  const again = page.waitForEvent('download');
  await page.locator('.word-history-item').first().getByRole('button', { name: '下载修订版' }).click(); await again;
  expect(data.grants).toEqual(['fresh-1','fresh-1','fresh-1','fresh-2']);
  await expect(page.locator('.word-history-item').last()).toContainText('此历史成果未提供修订、清洁版和有效基线');
  await expect(page.locator('.word-history-item').last().getByRole('button', { name: /^下载/ })).toHaveCount(1);
  expect(data.requests.every(request => request.method === 'GET')).toBe(true);
});

test('empty project and foreign/deleted history are not shown as successful results', async ({ page }) => {
  const data = scenario(); data.entries = [];
  await open(page, data);
  await expect(page.locator('.word-history-empty')).toContainText('暂无可下载');
  data.historyStatus = 404;
  await page.getByRole('button', { name: '重新读取历史成果' }).click();
  await expect(page.locator('.word-history [role=alert]')).toContainText('不可用');
  await expect(page.locator('.word-history-empty')).toHaveCount(0);
  await expect(page.locator('.word-history [data-history-file]')).toHaveCount(0);
  await page.goto('/#/projects/foreign-project');
  await expect(page.getByRole('heading', { name: '项目暂时无法打开' })).toBeVisible();
  await expect(page.locator('.word-history')).toHaveCount(0);
  expect(data.requests.some(request => request.path === '/projects/foreign-project/artifacts')).toBe(false);
});

test('an active newer run leaves older checked versions downloadable on reload', async ({ page }) => {
  const data = scenario(); data.latestRunState = 'running';
  await open(page, data);
  await expect(page.locator('#execution-progress')).toContainText('处理中');
  await page.reload();
  await expect(page.locator('.word-history-item')).toHaveCount(2);
  const downloaded = page.waitForEvent('download');
  await page.locator('.word-history-item').first().getByRole('button', { name: '下载清洁版' }).click();
  expect((await downloaded).suggestedFilename()).toBe('合成历史项目-v3-清洁版.docx');
  expect(data.requests.some(request => request.path === '/runs/execute')).toBe(false);
});

test('pagination errors retain only the already loaded page, report incomplete history, and retry the same cursor', async ({ page }) => {
  const data = scenario(); await open(page, data);
  data.historyStatus = 422;
  await page.getByRole('button', { name: '加载更多版本' }).click();
  await expect(page.locator('.word-history [role=alert]')).toContainText('目录可能不完整');
  await expect(page.locator('.word-history-item')).toHaveCount(2);
  data.historyStatus = 200;
  await page.getByRole('button', { name: '加载更多版本' }).click();
  await expect(page.locator('.word-history-item')).toHaveCount(3);
  data.historyStatus = 503;
  await page.getByRole('button', { name: '重新读取历史成果' }).click();
  await expect(page.locator('.word-history [role=alert]')).toContainText('无法读取或校验未通过');
  await expect(page.locator('.word-history-item')).toHaveCount(0);
});

test('a test-only grant never shows as a production version and cannot download after authorization changes', async ({ page }) => {
  const data = scenario(); data.entries = [entry(3, 'non_production_test')]; await open(page, data);
  await expect(page.locator('.word-history-test')).toContainText('内部测试工作稿 · 未经专业审核 · 不得对外使用');
  await expect(page.locator('.word-history-test')).not.toContainText('正式成果');
  data.metadataStatus = 404;
  await page.locator('.word-history-test').getByRole('button', { name: '下载修订版' }).click();
  await expect(page.locator('.word-history-download-status')).toContainText('不可用');
  expect(data.grants).toHaveLength(0);
  data.entries = [];
  await page.getByRole('button', { name: '重新读取历史成果' }).click();
  await expect(page.locator('.word-history-item')).toHaveCount(0);
});

test('malformed channel/state claims fail closed rather than presenting a production success', async ({ page }) => {
  const data = scenario(); data.malformedItems = [{ ...entry(3), state: 'test_completed' }];
  await install(page, data); await page.goto(`/#/projects/${projectId}`);
  await expect(page.locator('.word-history [role=alert]')).toContainText('校验未通过');
  await expect(page.locator('.word-history-item')).toHaveCount(0);
  expect(data.grants).toHaveLength(0);
});

test('forbidden history is an error rather than an empty result', async ({ page }) => {
  const data = scenario(); data.historyStatus = 403; await install(page, data);
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.locator('.word-history [role=alert]')).toContainText('暂时无法');
  await expect(page.locator('.word-history-empty')).toHaveCount(0);
  await expect(page.locator('.word-history-item')).toHaveCount(0);
});

test('unauthenticated history read signs out and removes the private directory', async ({ page }) => {
  const data = scenario(); await open(page, data); data.historyStatus = 401;
  await page.getByRole('button', { name: '重新读取历史成果' }).click();
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
  await expect(page.locator('.word-history')).toHaveCount(0);
});

test('fresh run/project and byte integrity checks reject mismatches, with no execute on retry', async ({ page }) => {
  const data = scenario(); await open(page, data);
  let downloads = 0; page.on('download', () => downloads++);
  data.foreignRun = true;
  await page.locator('.word-history-item').first().getByRole('button', { name: '下载修订版' }).click();
  await expect(page.locator('.word-history-download-status').first()).toContainText('校验未通过');
  expect(data.reads.size).toBe(0);
  data.foreignRun = false; data.badBytes = true;
  await page.locator('.word-history-item').first().getByRole('button', { name: '下载修订版' }).click();
  await expect(page.locator('.word-history-download-status').first()).toContainText('校验未通过');
  expect(downloads).toBe(0);
  data.badBytes = false;
  const downloaded = page.waitForEvent('download');
  await page.locator('.word-history-item').first().getByRole('button', { name: '下载修订版' }).click(); await downloaded;
  expect(data.requests.every(request => request.method === 'GET')).toBe(true);
});

test('session loss and project switch cancel outstanding history reads and clear previous project content', async ({ page }) => {
  const data = scenario(); await open(page, data);
  let release!: () => void;
  data.holdHistory = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: '重新读取历史成果' }).click();
  await expect(page.locator('.word-history-item')).toHaveCount(0);
  await page.evaluate(id => { location.hash = `/projects/${id}`; }, otherProjectId);
  await expect.poll(() => data.requests.some(request => request.path === `/projects/${otherProjectId}/artifacts`)).toBe(true);
  release();
  await expect(page.locator('.word-history-item')).toHaveCount(0);
  data.loggedOut = true;
  await page.getByRole('button', { name: '重新读取历史成果' }).click();
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
  await expect(page.locator('.word-history')).toHaveCount(0);
});

test('switching projects cancels an in-flight authorized download before saving any bytes', async ({ page }) => {
  const data = scenario(); await open(page, data);
  let release!: () => void;
  data.holdDownload = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { data.downloadRequested = resolve; });
  let downloads = 0; page.on('download', () => downloads++);
  await page.locator('.word-history-item').first().getByRole('button', { name: '下载修订版' }).click();
  await requested;
  await page.evaluate(id => { location.hash = `/projects/${id}`; }, otherProjectId);
  await expect.poll(() => data.requests.some(request => request.path === `/projects/${otherProjectId}/artifacts`)).toBe(true);
  release();
  await expect(page.locator('.word-history-item')).toHaveCount(0);
  expect(downloads).toBe(0);
});
