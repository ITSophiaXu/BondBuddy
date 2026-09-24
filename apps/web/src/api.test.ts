import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '@bondbuddy/contracts';
import { ApiClient, ApiError } from './api.js';
import { blankDraft } from './form-model.js';

const response = (status = 200, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
test('save uses owner cookies, CSRF and If-Match; no browser identity header', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = new ApiClient(async (path, init) => { calls.push({ path: String(path), init }); return response(); }, () => 'other=x; bb_csrf=synthetic-csrf');
  const draft = { ...blankDraft(), name: '测试' };
  await api.save(draft, null);
  await api.save(draft, { project_id: 'synthetic', draft_revision: 7 } as Project);
  assert.equal(calls[0].path, '/api/v1/projects'); assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[1].init?.credentials, 'same-origin');
  assert.deepEqual(calls[1].init?.headers, { 'Content-Type': 'application/json', 'X-BB-CSRF': 'synthetic-csrf', 'If-Match': '7' });
  assert.equal(JSON.parse(String(calls[1].init?.body)).kind, undefined);
  assert.equal(JSON.parse(String(calls[1].init?.body)).update_details.registration_amount, null);
  await assert.rejects(api.request('https://external.test/api/v1/projects'));
});
test('parallel expired requests share one refresh and retry once with new CSRF', async () => {
  const calls: string[] = []; let refreshed = false;
  const api = new ApiClient(async path => {
    calls.push(String(path));
    if (path === '/api/v1/auth/refresh') { await new Promise(resolve => setTimeout(resolve, 10)); refreshed = true; return response(); }
    return refreshed ? response() : response(401, { code: 'UNAUTHENTICATED' });
  }, () => refreshed ? 'bb_csrf=new' : 'bb_csrf=old');
  await Promise.all([api.me(), api.list()]);
  assert.equal(calls.filter(path => path.endsWith('/auth/refresh')).length, 1);
  assert.equal(calls.length, 5);
});
test('failed refresh, conflict and lost network response never create an automatic write retry', async () => {
  for (const status of [401, 409, 500]) {
    let calls = 0;
    const api = new ApiClient(async () => { calls++; return response(status, { code: status === 409 ? 'INPUT_REVISION_CONFLICT' : 'DATA_UNAVAILABLE' }); }, () => '');
    await assert.rejects(api.save({ ...blankDraft(), name: '测试' }, null), ApiError);
    assert.equal(calls, status === 401 ? 2 : 1);
  }
  let calls = 0;
  const api = new ApiClient(async () => { calls++; throw new TypeError('Network unavailable'); }, () => '');
  await assert.rejects(api.save({ ...blankDraft(), name: '测试' }, null)); assert.equal(calls, 1);
});
