import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { schemas } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';

// Synthetic public HTTP records exercise real collection/SPA UI. No generation,
// backend queue, professional review, private storage or credit settlement runs.
export const ids = { a: 'parallel-project-a', b: 'parallel-project-b', c: 'parallel-project-c', aReview: 'parallel-a-review-workspace' };
export const ownerId = 'parallel-owner-a', otherOwnerId = 'parallel-owner-b';
export const now = '2026-10-25T09:00:00Z';
export const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const runId = (root: 'a' | 'b', n: number) => `parallel-${root}-run-${n}`;
export const artifactId = (root: 'a' | 'b', n: number) => `parallel-${root}-artifact-${n}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
FormatRegistry.Set('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export type Task = Dto<'ProjectTasksResponse'>['items'][number];
export type Project = Dto<'ProjectListResponse'>['items'][number];
export type Call = { method: string; path: string; search: string; owner: string; body?: unknown };
type Read = { projectId: string; cursor?: string };
function checked<K extends keyof typeof schemas>(name: K, body: unknown): asserts body is Dto<K> {
  expect(Value.Check(schemas[name], body), `${name}: ${JSON.stringify([...Value.Errors(schemas[name], body)])}`).toBe(true);
}
export function task(root: 'a' | 'b', n: number, status: Task['state'] = 'succeeded'): Task {
  const linkedReview = root === 'a' && n === 8;
  const created_at = new Date(Date.UTC(2026, 9, 25, 0, n)).toISOString();
  return { run_id: runId(root, n), project_id: linkedReview ? ids.aReview : ids[root], kind: linkedReview ? 'review' : 'update',
    state: status, stage: status === 'running' ? 'materials_ready' : null, created_at, updated_at: created_at,
    artifact_id: status === 'succeeded' ? artifactId(root, n) : null, report_id: linkedReview ? 'parallel-exact-review-report-8' : null,
    topic_id: null, document_type: null, operation: linkedReview ? 'full_review' : null };
}
function project(id: string, label: string, updatedAt: string): Project {
  return { project_id: id, name: `合成并行${label}项目 · 募集说明书与关联核验文件`, issuer_name: `合成${label}发行人有限公司`,
    kind: 'update', draft_revision: 3, market: 'sse', offering: 'private', updated_at: updatedAt, archived_at: null,
    status: 'draft', file_count: 12, latest_run: null, latest_artifact: null };
}
export function fixture() {
  const projects: Project[] = [project(ids.a, '甲', now), project(ids.b, '乙', '2026-10-25T08:00:00Z'), project(ids.c, '丙', '2026-10-25T07:00:00Z')];
  const tasks = new Map<string, Task[]>([[ids.a, Array.from({ length: 45 }, (_, index) => task('a', 45 - index, index === 0 ? 'running' : index === 1 ? 'awaiting_input' : 'succeeded'))],
    [ids.b, [task('b', 3, 'running'), task('b', 2, 'failed'), task('b', 1)]], [ids.c, []]]);
  const state = { projects, tasks, owner: ownerId, authenticated: true, calls: [] as Call[], errors: [] as string[], unexpected: [] as string[],
    projectReads: [] as (string | undefined)[], taskReads: [] as Read[], artifactReads: [] as string[], runReads: [] as string[],
    failProjects: false, failTask: undefined as ((projectId: string, cursor?: string) => boolean) | undefined,
    projectGate: undefined as (() => Promise<void>) | undefined,
    taskGate: undefined as ((projectId: string, cursor?: string) => Promise<void>) | undefined,
    archiveIntent: undefined as { projectId: string; archived: boolean } | undefined,
    malformedTask: undefined as 'foreign-root' | 'duplicate-run' | undefined };
  const bumpB = () => {
    const p = projects.find(p => p.project_id === ids.b)!; p.updated_at = '2026-10-25T10:00:00Z';
    const latest = tasks.get(ids.b)![0]; latest.state = 'succeeded'; latest.stage = null; latest.artifact_id = artifactId('b', 3); latest.updated_at = p.updated_at;
  };
  const insertA = () => { const n = Math.max(...tasks.get(ids.a)!.map(t => Number(t.run_id.split('-').at(-1)))) + 1;
    tasks.get(ids.a)!.unshift(task('a', n, 'queued')); return runId('a', n); };
  return Object.assign(state, { bumpB, insertA });
}
export type State = ReturnType<typeof fixture>;
export function boundaryFixture() {
  const state = fixture();
  // Exactly 29 newer projects place A at the visible limit (30); B starts at 31.
  state.projects.unshift(...Array.from({ length: 29 }, (_, i) => project(`parallel-boundary-${i + 1}`, `边界${i + 1}`,
    new Date(Date.parse(now) + (i + 1) * 60000).toISOString())));
  return state;
}
const installed = new WeakMap<Page, State>();
export const mutations = (state: State) => state.calls.filter(call => call.method !== 'GET');
export function projectPage(state: State): Dto<'ProjectListResponse'> {
  if (state.owner !== ownerId) return { items: [], page: { has_more: false, next_cursor: null } };
  const items = state.projects.map(p => {
    const tasks = state.tasks.get(p.project_id) ?? [], latest = tasks[0] ?? null;
    const result = tasks.find(t => ['succeeded', 'failed', 'cancelled', 'rejected', 'test_completed'].includes(t.state)) ?? null;
    return { ...p, status: latest?.state ?? 'draft', latest_run: latest ? { run_id: latest.run_id, state: latest.state, updated_at: latest.updated_at } : null,
      task_summary: { active: tasks.filter(t => ['preparing', 'queued', 'running', 'validating', 'delivering', 'settlement_pending'].includes(t.state)).length,
        attention: tasks.length ? tasks.filter(t => ['awaiting_input', 'paused', 'failed', 'rejected', 'cancelled', 'test_completed'].includes(t.state)).length : 1,
        completed: tasks.filter(t => t.state === 'succeeded').length, total: tasks.length, latest, recent_result: result } };
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { items, page: { has_more: false, next_cursor: null } };
}
function taskPage(state: State, projectId: string, cursor?: string): Dto<'ProjectTasksResponse'> {
  const all = state.tasks.get(projectId) ?? [], prefix = `parallel-cursor:${projectId}:`;
  const start = cursor ? all.findIndex(t => t.run_id === cursor.slice(prefix.length)) + 1 : 0;
  if (cursor && (!cursor.startsWith(prefix) || start < 1)) throw new Error(`Unknown synthetic task cursor ${cursor}`);
  const items = all.slice(start, start + 20), has_more = start + items.length < all.length;
  return { project_id: projectId, items, page: { has_more, next_cursor: has_more ? prefix + items.at(-1)!.run_id : null } };
}
async function reply<K extends keyof typeof schemas>(route: Route, name: K, body: Dto<K>, status = 200) {
  checked(name, body); return route.fulfill({ status, json: fixtureBody(route,body) });
}
const problem = (route: Route, status: number, code: Dto<'Error'>['code']) => reply(route, 'Error', { code,
  message: `Synthetic ${code}`, retryable: status >= 500, field_errors: [], correlation_id: 'parallel-synthetic-correlation' }, status);
function runFor(t: Task): Dto<'RunResponse'> {
  return { run_id: t.run_id, execution_request_id: `request-${t.run_id}`, project_id: t.project_id,
    input_revision: 2, input_hash: hash(`input-${t.run_id}`), channel: 'production', test_grant_id: null, uncovered_items: [],
    state: t.state, stage: t.stage, event_cursor: 0, billing_mode: 'platform_trial', reservation_id: null,
    artifact_id: t.artifact_id, prompt_snapshot_ref: null, updated_at: t.updated_at };
}
function projectResponse(item: Project): Dto<'ProjectResponse'> {
  return { project_id: item.project_id, name: item.name, kind: item.kind ?? 'update', issuer_name: item.issuer_name ?? null,
    market: item.market ?? null, offering: item.offering ?? null, draft_revision: item.draft_revision,
    input_revision: 2, input_hash: hash(`project-${item.project_id}`), updated_at: item.updated_at, archived_at: item.archived_at ?? null };
}
export async function install(page: Page, state = fixture()) {
  installed.set(page, state); page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const req = route.request(), url = new URL(req.url()), path = url.pathname.slice('/api/v1'.length), method = req.method();
    const body = method !== 'GET' && req.postData() ? fixtureRequest(req) : undefined;
    state.calls.push({ method, path, search: url.search, owner: state.owner, ...(body ? { body } : {}) });
    if (method === 'GET') {
      if (path === '/me') return state.authenticated ? reply(route, 'MeResponse', { user_id: state.owner, session_status: 'active' }) : problem(route, 401, 'UNAUTHENTICATED');
      if (!state.authenticated && !path.startsWith('/auth/')) return problem(route, 401, 'UNAUTHENTICATED');
      if (path === '/account') return reply(route, 'AccountResponse', { user_id: state.owner, username: state.owner === ownerId ? 'parallel_owner_a' : 'parallel_owner_b',
        phone_masked: null, status: 'active', created_at: now, accepted_terms_version: 'v1', current_terms_version: 'v1',
        password_updated_at: null, self_service_recovery: 'unavailable', support_contact: null });
      if (path === '/credits/balance') return reply(route, 'CreditBalanceResponse', { enabled: true, available: 86000, frozen: 0 });
      if (path === '/auth/recovery/info') return reply(route, 'RecoveryInfoResponse', { enabled: false, support_contact: null, link_minutes: 30 });
      if (path === '/projects') {
        checked('ProjectListQuery', Object.fromEntries(url.searchParams)); state.projectReads.push(url.searchParams.get('cursor') ?? undefined);
        const snapshot = structuredClone(projectPage(state)); await state.projectGate?.();
        if (state.failProjects) return problem(route, 503, 'DATA_UNAVAILABLE');
        return reply(route, 'ProjectListResponse', snapshot);
      }
      const tasks = path.match(/^\/projects\/([^/]+)\/tasks$/);
      if (tasks && state.owner === ownerId && state.projects.some(p => p.project_id === tasks[1])) {
        checked('ProjectTasksQuery', Object.fromEntries(url.searchParams)); const cursor = url.searchParams.get('cursor') ?? undefined;
        state.taskReads.push({ projectId: tasks[1], ...(cursor ? { cursor } : {}) });
        const snapshot = structuredClone(taskPage(state, tasks[1], cursor)); await state.taskGate?.(tasks[1], cursor);
        if (state.failTask?.(tasks[1], cursor)) return problem(route, 503, 'DATA_UNAVAILABLE');
        if (state.malformedTask === 'foreign-root') snapshot.project_id = 'parallel-unowned-project';
        if (state.malformedTask === 'duplicate-run' && snapshot.items.length) snapshot.items.push(snapshot.items[0]);
        return reply(route, 'ProjectTasksResponse', snapshot);
      }
      const artifact = path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
      if (artifact) {
        const t = [...state.tasks.values()].flat().find(t => t.artifact_id === artifact[1]);
        if (t) {
          const payload = `Synthetic exact Word result ${t.project_id} ${t.run_id}.`;
          if (artifact[2]) return route.fulfill({ status: 200, contentType: mime, body: payload });
          state.artifactReads.push(artifact[1]); return reply(route, 'ArtifactResponse', { artifact_id: artifact[1], run_id: t.run_id, version: 3,
            filename: `合成准确成果-${t.run_id}.docx`, media_type: mime, sha256: hash(payload), quality_status: 'passed', delivery_status: 'available',
            download_url: `/api/v1/artifacts/${artifact[1]}/download`, expires_at: '2027-01-01T00:00:00Z' });
        }
      }
      const run = path.match(/^\/runs\/([^/]+)$/);
      if (run) { const t = [...state.tasks.values()].flat().find(t => t.run_id === run[1]); if (t) { state.runReads.push(t.run_id); return reply(route, 'RunResponse', runFor(t)); } }
      const p = path.match(/^\/projects\/([^/]+)$/);
      if (p) { const item = state.projects.find(item => item.project_id === p[1]); if (item) return reply(route, 'ProjectResponse', projectResponse(item)); }
    }
    // A single explicit user archive journey opts in; every other test remains zero-write.
    const archive = path.match(/^\/projects\/([^/]+)\/archive$/);
    if (method === 'POST' && archive && state.authenticated && state.owner === ownerId && state.archiveIntent?.projectId === archive[1]) {
      checked('ProjectArchiveRequest', body); expect(body).toEqual({ archived: state.archiveIntent.archived });
      const item = state.projects.find(item => item.project_id === archive[1]);
      if (item) { item.archived_at = body.archived ? now : null; item.updated_at = now; return reply(route, 'ProjectResponse', projectResponse(item)); }
    }
    state.unexpected.push(`${method} ${path}${url.search}`); return problem(route, 500, 'DATA_UNAVAILABLE');
  });
  return state;
}
export async function setup(page: Page, state = fixture(), route = '#tasks') {
  await install(page, state); await page.goto('/' + route); return state;
}
export function assertFixture(page: Page) {
  const state = installed.get(page); if (!state) return;
  expect(state.unexpected, 'Only the explicitly allowed public HTTP endpoints may be called.').toEqual([]);
  expect(state.errors, 'The actual browser UI must not throw.').toEqual([]);
  const expected = state.archiveIntent ? [{ method: 'POST', path: `/projects/${state.archiveIntent.projectId}/archive`, search: '',
    owner: ownerId, body: { archived: state.archiveIntent.archived } }] : [];
  expect(mutations(state), 'Only the one explicitly requested archive is allowed; synchronization itself remains zero-write.').toEqual(expected);
}
