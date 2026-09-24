import { expect, test } from '@playwright/test';
import { Draft } from '../src/draft';
import { ApiClient, ApiError, type Dto } from '../src/api';

const project: Dto<'ProjectResponse'> = {
  project_id: 'synthetic-project', name: '原名称', kind: 'update', issuer_name: null,
  market: null, offering: null, draft_revision: 1, input_revision: null,
  input_hash: null, updated_at: '2026-09-24T00:00:00Z'
};
function client(patch: ApiClient['patch']) { return { patch } as ApiClient; }

test('edits made while saving use the returned revision, not the stale version', async () => {
  let release!: (value: Dto<'ProjectResponse'>) => void;
  const calls: { revision: number; name?: string }[] = [];
  const api = client(async (_id, revision, fields) => {
    calls.push({ revision, name: fields.name });
    if (calls.length === 1) return new Promise(resolve => { release = resolve; });
    return { ...project, ...fields, draft_revision: revision + 1 };
  });
  const draft = new Draft(project, api, () => {});
  draft.edit({ name: '第一次修改', issuer_name: '' });
  const save = draft.save();
  draft.edit({ name: '请求期间继续输入', issuer_name: '' });
  release({ ...project, name: '第一次修改', draft_revision: 2 });
  expect(await save).toBe(true);
  expect(calls).toEqual([{ revision: 1, name: '第一次修改' }, { revision: 2, name: '请求期间继续输入' }]);
  expect(draft.state).toBe('saved'); expect(draft.dirty).toBe(false);
  draft.dispose();
});

test('409 keeps local input and never retries against another writer automatically', async () => {
  let calls = 0;
  const draft = new Draft(project, client(async () => { calls++; throw new ApiError(409, 'INPUT_REVISION_CONFLICT'); }), () => {});
  draft.edit({ name: '本地未保存输入', issuer_name: '' });
  expect(await draft.save()).toBe(false);
  draft.edit({ name: '继续保留的输入', issuer_name: '' });
  expect(await draft.save()).toBe(false);
  expect(calls).toBe(1); expect(draft.fields.name).toBe('继续保留的输入'); expect(draft.project.draft_revision).toBe(1);
  draft.dispose();
});

test('network failure retains the draft for explicit retry', async () => {
  let calls = 0;
  const draft = new Draft(project, client(async (_id, revision, fields) => {
    if (++calls === 1) throw new TypeError('Synthetic connection loss');
    return { ...project, ...fields, draft_revision: revision + 1 };
  }), () => {});
  draft.edit({ name: '重试内容', issuer_name: '' });
  expect(await draft.save()).toBe(false); expect(draft.state).toBe('error');
  expect(await draft.save()).toBe(true); expect(draft.project.name).toBe('重试内容');
  draft.dispose();
});

test('disposing on account or route change ignores late responses', async () => {
  let release!: (value: Dto<'ProjectResponse'>) => void;
  let renders = 0;
  const draft = new Draft(project, client(async () => new Promise(resolve => { release = resolve; })), () => { renders++; });
  draft.edit({ name: '旧账号的输入', issuer_name: '' }); const saving = draft.save();
  draft.dispose(); const before = renders;
  release({ ...project, name: '旧账号的输入', draft_revision: 2 });
  expect(await saving).toBe(false); expect(renders).toBe(before); expect(draft.project.name).toBe('原名称');
});

test('empty names cannot be auto-saved and unchanged fields do not create revisions', async () => {
  let calls = 0;
  const draft = new Draft(project, client(async () => { calls++; return project; }), () => {});
  expect(await draft.save()).toBe(true);
  draft.edit({ name: '   ', issuer_name: '' }); expect(await draft.save()).toBe(false);
  expect(calls).toBe(0); draft.dispose();
});
