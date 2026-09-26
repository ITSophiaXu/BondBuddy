import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { ApiError, type ApiClient, type Dto } from './api.js';
import { Draft } from './draft.js';

const project: Dto<'ProjectResponse'> = { project_id: 'synthetic', draft_revision: 1, input_revision: null, input_hash: null, name: '合成测试', kind: 'update', issuer_name: null, market: 'nafmii', offering: 'dfi', update_details: emptyUpdateDetails(), updated_at: '2026-09-24T00:00:00Z' };
test('JSONB object key order does not trigger repeated autosaves, while funding row order remains meaningful', async () => {
  let calls = 0;
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])])) : value;
  const draft = new Draft(project, { patch: async (_id: string, revision: number, fields: Dto<'ProjectPatchRequest'>) => {
    if (++calls > 2) throw new Error('unexpected repeated save');
    return reorder({ ...project, ...fields, draft_revision: revision + 1 });
  } } as unknown as ApiClient, () => {});
  draft.edit({ update_details: { ...emptyUpdateDetails(), funding_uses: [
    { purpose: 'construction', amount: { value: '1.000001', unit: 'hundred_million' }, details: '合成项目', target: null },
    { purpose: 'working_capital', amount: null, details: '金额待定', target: null }
  ] } });
  assert.equal(await draft.save(), true); assert.equal(calls, 1); assert.equal(draft.dirty, false);
  draft.edit({ update_details: { ...draft.fields.update_details, funding_uses: [...draft.fields.update_details.funding_uses].reverse() } });
  assert.equal(draft.dirty, true); assert.equal(await draft.save(), true); assert.equal(calls, 2); draft.dispose();
});
test('nested edits during a pending save use the returned revision and immutable sent data', async () => {
  let release!: (value: Dto<'ProjectResponse'>) => void;
  const calls: Array<{ revision: number; fields: Dto<'ProjectPatchRequest'> }> = [];
  const api = { patch: async (_id: string, revision: number, fields: Dto<'ProjectPatchRequest'>) => {
    calls.push({ revision, fields });
    if (calls.length === 1) return new Promise<Dto<'ProjectResponse'>>(resolve => { release = resolve; });
    return { ...project, ...fields, draft_revision: revision + 1 };
  } } as ApiClient;
  const draft = new Draft(project, api, () => {});
  draft.edit({ update_details: { ...emptyUpdateDetails(), supplementary_notes: '第一次补充' } });
  const saving = draft.save();
  draft.edit({ update_details: { ...draft.fields.update_details, supplementary_notes: '请求期间补充', funding_uses: [{ purpose: 'construction', amount: null, target: '合成项目', details: null }] } });
  release({ ...project, ...calls[0].fields, draft_revision: 2 });
  assert.equal(await saving, true);
  assert.deepEqual(calls.map(c => c.revision), [1, 2]);
  assert.equal(calls[0].fields.update_details!.supplementary_notes, '第一次补充');
  assert.equal(calls[0].fields.update_details!.funding_uses.length, 0);
  assert.equal(draft.project.update_details!.funding_uses[0].target, '合成项目');
  assert.equal(draft.dirty, false); draft.dispose();
});
test('409 retains every field and does not auto-overwrite; unchanged DFI drafts create no revision', async () => {
  let calls = 0;
  const draft = new Draft(project, { patch: async () => { calls++; throw new ApiError(409, 'INPUT_REVISION_CONFLICT'); } } as unknown as ApiClient, () => {});
  assert.equal(await draft.save(), true); assert.equal(calls, 0);
  draft.edit({ market: 'sse', offering: null, update_details: { ...emptyUpdateDetails(), underwriting: '合成单承销商' } });
  assert.equal(await draft.save(), false);
  draft.edit({ update_details: { ...draft.fields.update_details, supplementary_notes: '仍应保留' } });
  assert.equal(await draft.save(), false); assert.equal(calls, 1);
  assert.equal(draft.fields.market, 'sse'); assert.equal(draft.fields.update_details.underwriting, '合成单承销商');
  assert.equal(draft.fields.update_details.supplementary_notes, '仍应保留'); draft.dispose();
});
test('invalid date/amount never saves, and a disposed draft ignores late responses', async () => {
  let release!: (value: Dto<'ProjectResponse'>) => void; let calls = 0;
  const draft = new Draft(project, { patch: async () => { calls++; return new Promise(resolve => { release = resolve; }); } } as unknown as ApiClient, () => {});
  draft.edit({ update_details: { ...emptyUpdateDetails(), reporting_cutoff: '2025-02-29' } });
  assert.equal(await draft.save(), false); assert.equal(calls, 0);
  draft.edit({ update_details: { ...emptyUpdateDetails(), reporting_cutoff: '2024-02-29' } });
  const saving = draft.save(); draft.dispose();
  release({ ...project, draft_revision: 2 });
  assert.equal(await saving, false); assert.equal(draft.project.draft_revision, 1);
});

test('saved target period set survives unrelated edits, cross-market changes, and remains in PATCH payload', async () => {
  const period = { start: '2025-01-01', end: '2025-06-30', period_kind: 'interim' as const, scope: 'consolidated' as const, status: 'needs_confirmation' as const, evidence_refs: [] };
  const saved = { ...project, update_details: { ...emptyUpdateDetails(), target_reporting_periods: [period] } };
  let payload: Dto<'ProjectPatchRequest'> | undefined;
  const draft = new Draft(saved, { patch: async (_id, revision, fields) => {
    payload = structuredClone(fields);
    return { ...saved, ...fields, draft_revision: revision + 1 };
  } } as ApiClient, () => {});
  draft.edit({ market: 'sse', offering: null, update_details: { ...draft.fields.update_details, supplementary_notes: '仅修改其他信息' } });
  assert.equal(await draft.save(), true);
  assert.deepEqual(payload?.update_details?.target_reporting_periods, [period]);
  assert.equal(draft.project.update_details?.target_reporting_periods?.[0].status, 'needs_confirmation');
  draft.dispose();
});

test('explicitly removed final target period is sent as an empty list', async () => {
  const saved = { ...project, update_details: { ...emptyUpdateDetails(), target_reporting_periods: [
    { start: '2025-01-01', end: '2025-12-31', period_kind: 'annual' as const, scope: 'parent' as const, status: 'user_asserted' as const, evidence_refs: [] }
  ] } };
  let payload: Dto<'ProjectPatchRequest'> | undefined;
  const draft = new Draft(saved, { patch: async (_id, revision, fields) => {
    payload = structuredClone(fields);
    return { ...saved, ...fields, draft_revision: revision + 1 };
  } } as ApiClient, () => {});
  draft.edit({ update_details: { ...draft.fields.update_details, target_reporting_periods: [] } });
  assert.equal(await draft.save(), true);
  assert.deepEqual(payload?.update_details?.target_reporting_periods, []);
  draft.dispose();
});

test('invalid target calendar date and duplicate periods are rejected before PATCH', async () => {
  let calls = 0;
  const draft = new Draft(project, { patch: async () => { calls++; return project; } } as unknown as ApiClient, () => {});
  const period = { start: '2025-02-29', end: '2025-12-31', period_kind: 'annual' as const, scope: 'consolidated' as const, status: 'user_asserted' as const, evidence_refs: [] };
  draft.edit({ update_details: { ...emptyUpdateDetails(), target_reporting_periods: [period] } });
  assert.match(draft.validationErrors.join(), /有效的目标报告期日期/);
  assert.equal(await draft.save(), false);
  const valid = { ...period, start: '2024-01-01' };
  draft.edit({ update_details: { ...emptyUpdateDetails(), target_reporting_periods: [valid, { ...valid }] } });
  assert.match(draft.validationErrors.join(), /完全重复/);
  assert.equal(await draft.save(), false);
  assert.equal(calls, 0);
  draft.dispose();
});
