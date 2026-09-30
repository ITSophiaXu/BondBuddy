import { expect, test, type Page, type Route } from '@playwright/test';
import type { FactCandidate } from '@bondbuddy/contracts';
import { groupFactCandidates, decisionInput } from '../src/fact-review';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const projectId = 'project-fact-review-synthetic';
const hash = 'a'.repeat(64);
const now = '2026-09-25T00:00:00Z';
const policy = { policy_version: 'data_policy_m1_v1', storage_location: 'platform_private_cloud', server_side_processing: true,
  model_provider_processing: true, active_retention: 'until_user_deletes', purge_enabled: true, deleted_content_purge_days: 17,
  orphan_upload_purge_hours: 6, log_content_retention_days: 180, backup_retention_days: 21,
  pinned_by_active_run: 'retained_until_run_ends', purged_content: ['material_bytes'], retained_metadata: ['hashes_and_sizes'] };
const identity: FactCandidate['identity'] = { account_id: 'owner-1', entity_id: 'issuer-1', scope: 'consolidated',
  metric: '净资产', period: { start: null, end: null, as_of: '2025-09-30' }, currency: 'CNY', unit: '万元', basis: 'audited', data_version: 'v1' };
const evidence: FactCandidate['evidence'][number] = { evidence_id: 'evidence-1', material_id: 'audit-1', material_version: 1,
  content_hash: 'b'.repeat(64), locator_type: 'pdf_bbox', locator: { stable_ref: 'pdf:p2:r1' }, literal_quote: '合成原文：净资产 120 万元',
  extraction_method: 'ocr', extraction_version: 'synthetic-v1', confidence: 0.8, uncertainty: ['请核对原页数字'] };
const first: FactCandidate = { candidate_id: 'candidate-a', fact_key_hash: hash, identity, value_kind: 'decimal', value: '120',
  source_kind: 'audited', source_ref: 'audit-2025', observed_at: now, valid_as_of: '2025-09-30', status: 'extracted', verification: null,
  material_id: 'audit-1', material_version: 1, evidence: [evidence], uncertainty: [], created_at: now, latest_decision: null };
const second: FactCandidate = { ...first, candidate_id: 'candidate-b', value: '130', source_kind: 'user_statement', source_ref: 'message-1',
  status: 'user_asserted', evidence: [{ ...evidence, evidence_id: 'evidence-2', literal_quote: '合成用户陈述：130 万元' }],
  uncertainty: ['用户陈述不是审计事实'] };

test('grouping refuses inconsistent identities and decision request omits server-owned account id', () => {
  expect(groupFactCandidates([first, second])[0].candidates).toHaveLength(2);
  expect(() => groupFactCandidates([first, { ...second, identity: { ...identity, entity_id: 'other' } }])).toThrow();
  const request = decisionInput(identity, { resolution: 'selected', candidateId: 'candidate-a' }, '核对原文',
    { requestId: 'request-1', decisionId: 'decision-1' }, 0);
  expect(request.identity).not.toHaveProperty('account_id');
  expect(request.expected_version).toBe(0);
  expect(request.identity.period).toEqual({ as_of: '2025-09-30' });
  expect(request.selected_candidate_id).toBe('candidate-a');
});

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function installApi(page: Page, state: { requests: any[]; fail: number; cursors: string[] }) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/me') return json(route, 200, { user_id: 'owner-1', session_status: 'active' });
    if (path === '/api/v1/data-policy') return json(route, 200, policy);
    // The surrounding project workspace also recovers the current run and old artifact.
    if (path === '/api/v1/projects') return json(route, 200, { items: [{ project_id: projectId, name: '合成事实审核项目',
      draft_revision: 1, updated_at: now, latest_run: null, latest_artifact: null }], page: { next_cursor: null, has_more: false } });
    if (path === `/api/v1/projects/${projectId}`) return json(route, 200, { project_id: projectId, draft_revision: 1, input_revision: null,
      input_hash: null, name: '合成事实审核项目', kind: 'update', issuer_name: null, market: null, offering: null, updated_at: now });
    if (path === `/api/v1/projects/${projectId}/messages`) return json(route, 200, {
      conversation_id: projectId, items: [], project_message_set_ref: { version: 1, content_sha256: hash, message_ids: [] },
      next_cursor: null, has_more: false
    });
    if (path === `/api/v1/projects/${projectId}/events`) return json(route, 200, { items: [], next_cursor: 0 });
    if (path === `/api/v1/projects/${projectId}/artifacts`) return json(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    if (path === `/api/v1/projects/${projectId}/facts/candidates`) {
      const cursor = url.searchParams.get('cursor') ?? '';
      state.cursors.push(cursor);
      return cursor ? json(route, 200, { items: [second], next_cursor: null, has_more: false })
        : json(route, 200, { items: [first], next_cursor: 'page-2', has_more: true });
    }
    if (path === `/api/v1/projects/${projectId}/facts/decisions`) {
      const body = route.request().postDataJSON();
      state.requests.push(body);
      if (state.fail) {
        const failure = state.fail; state.fail = 0;
        return json(route, failure, { code: failure === 409 ? 'FACT_CONFLICT' : 'DATA_UNAVAILABLE' });
      }
      return json(route, 201, { decision_id: body.decision_id, request_id: body.request_id, project_id: projectId,
        identity, fact_key_hash: hash, version: state.requests.length, resolution: body.resolution,
        selected_candidate_id: body.selected_candidate_id ?? null, reason: body.reason,
        actor_kind: 'user', created_at: now, replayed: false, verification_effect: 'none' });
    }
    return json(route, 404, { code: 'NOT_FOUND' });
  });
}

// The retained component is exercised only by this test harness; #384 removes it from
// the ordinary upload workspace. This creates no product route, panel or navigation.
async function mountIsolatedReview(page: Page) {
  await expect(page.getByRole('heading', { name: '合成事实审核项目' })).toBeVisible();
  await expect(page.locator('.workspace-evidence, .fact-review')).toHaveCount(0);
  await page.evaluate(async projectId => {
    const componentPath = '/src/fact-review.ts', apiPath = '/src/api.ts', cssPath = '/src/fact-review.css';
    const { FactReview } = await import(componentPath), { ApiClient } = await import(apiPath);
    await import(cssPath);
    const host = document.createElement('div'); document.querySelector('.workspace-main')!.append(host);
    new FactReview(new ApiClient(() => {}), projectId).mount(host);
  }, projectId);
}

test('ordinary upload workspace never offers or fetches a content fact review', async ({ page }) => {
  const state = { requests: [] as any[], fail: 0, cursors: [] as string[] };
  await installApi(page, state); await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: '合成事实审核项目' })).toBeVisible();
  await expect(page.locator('.workspace-evidence, .fact-review, #fact-review-root')).toHaveCount(0);
  await expect(page.getByText('核对材料事实与来源冲突')).toHaveCount(0);
  expect(state.requests).toEqual([]); expect(state.cursors).toEqual([]);
});

test('isolated fact review component loads all pages, keeps a retry ID, and never labels a choice verified', async ({ page }) => {
  const state = { requests: [] as any[], fail: 503, cursors: [] as string[] };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} @${message.location().url}`); });
  await installApi(page, state);
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: '合成事实审核项目' })).toBeVisible();
  await mountIsolatedReview(page);
  await page.getByRole('button', { name: '读取事实候选' }).click();
  await expect(page.locator('.fact-candidate')).toHaveCount(2);
  expect(state.cursors).toEqual(['', 'page-2']);
  await expect(page.locator('.fact-review')).toContainText('用户提供，未核验');
  await page.locator('input[value="candidate:candidate-a"]').check();
  await page.getByLabel('决定原因').fill('核对合成原文后选择候选 A');
  await page.getByRole('button', { name: '保存决定' }).click();
  await expect(page.locator('.fact-result')).toContainText('暂时无法完成操作');
  await expect(page.getByLabel('决定原因')).toHaveValue('核对合成原文后选择候选 A');
  await page.getByRole('button', { name: '保存决定' }).click();
  await expect(page.locator('.fact-result')).toContainText('来源核验状态未改变');
  expect(state.requests).toHaveLength(2);
  expect(state.requests[0].request_id).toBe(state.requests[1].request_id);
  expect(state.requests[0].decision_id).toBe(state.requests[1].decision_id);
  expect(state.requests[0].expected_version).toBe(0);
  expect(state.requests[0].selected_candidate_id).toBe('candidate-a');
  await expect(page.locator('.fact-review')).toContainText('用户提供，未核验');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-fact-review-desktop.png'), fullPage: true });
  await page.locator('.fact-review').screenshot({ path: join(tmpdir(), 'bondbuddy-fact-review-panel-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-fact-review-mobile.png'), fullPage: true });
  await page.locator('.fact-review').screenshot({ path: join(tmpdir(), 'bondbuddy-fact-review-panel-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('input[value="unresolved"]').check();
  await page.getByLabel('决定原因').fill('重新核对后保留待确认');
  await page.getByRole('button', { name: '保存决定' }).click();
  await expect(page.locator('.fact-result')).toContainText('来源核验状态未改变');
  expect(state.requests[2].expected_version).toBe(2);
  expect(errors.filter(message => !message.includes(`/api/v1/projects/${projectId}/facts/decisions`) || !message.includes('503'))).toEqual([]);
});

test('409 keeps input, disables stale submission, and allows deliberate refresh', async ({ page }) => {
  const state = { requests: [] as any[], fail: 409, cursors: [] as string[] };
  await installApi(page, state);
  await page.goto(`/#/projects/${projectId}`);
  await mountIsolatedReview(page);
  await page.getByRole('button', { name: '读取事实候选' }).click();
  await expect(page.locator('.fact-candidate')).toHaveCount(2);
  await page.locator('input[value="unresolved"]').check();
  await page.getByLabel('决定原因').fill('两项来源冲突，先保留待确认');
  await page.getByRole('button', { name: '保存决定' }).click();
  await expect(page.locator('.fact-result')).toContainText('输入已保留');
  await expect(page.getByRole('button', { name: '保存决定' })).toBeDisabled();
  await expect(page.getByLabel('决定原因')).toHaveValue('两项来源冲突，先保留待确认');
  await page.getByRole('button', { name: '刷新事实候选' }).click();
  await expect(page.locator('.fact-candidate')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '保存决定' })).toBeEnabled();
  await page.getByRole('button', { name: '保存决定' }).click();
  await expect(page.locator('.fact-result')).toContainText('来源核验状态未改变');
  expect(state.requests[0].request_id).not.toBe(state.requests[1].request_id);
  expect(state.requests[0].expected_version).toBe(0);
});

test('incomplete candidate pagination never opens the decision form', async ({ page }) => {
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me') return json(route, 200, { user_id: 'owner-1', session_status: 'active' });
    if (path === '/api/v1/data-policy') return json(route, 200, policy);
    if (path === `/api/v1/projects/${projectId}`) return json(route, 200, { project_id: projectId, draft_revision: 1,
      input_revision: null, input_hash: null, name: '合成事实审核项目', kind: 'update', issuer_name: null,
      market: null, offering: null, updated_at: now });
    if (path === `/api/v1/projects/${projectId}/events`) return json(route, 200, { items: [], next_cursor: 0 });
    if (path === `/api/v1/projects/${projectId}/facts/candidates`) return json(route, 200, { items: [first], next_cursor: null, has_more: true });
    return json(route, 404, { code: 'NOT_FOUND' });
  });
  await page.goto(`/#/projects/${projectId}`);
  await mountIsolatedReview(page);
  await page.getByRole('button', { name: '读取事实候选' }).click();
  await expect(page.locator('[data-fact-load-status]')).toContainText('候选集合未完整读取');
  await expect(page.locator('[data-fact-form]')).toHaveCount(0);
});
