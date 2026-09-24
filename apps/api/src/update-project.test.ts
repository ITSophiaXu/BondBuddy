import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails, type UpdateDetails } from '@bondbuddy/contracts';
import { createServer } from './server.js';

const origin = 'http://bondbuddy.test';
const connection = process.env.BB_TEST_DATABASE_URL;

test('project HTTP schema rejects invented fields, string booleans and extra DFI questionnaire', async () => {
  const app = createServer({ allowedOrigin: origin });
  try {
    for (const details of [{ ...emptyUpdateDetails(), has_historical: 'false' }, { ...emptyUpdateDetails(), registration_mode: 'dfi' }]) {
      const result = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { origin }, payload: { name: '合成测试', kind: 'update', issuer_name: null, market: 'nafmii', offering: 'dfi', update_details: details } });
      assert.equal(result.statusCode, 422, result.body);
    }
  } finally { await app.close(); }
});

test('saved details round-trip, old clients preserve them, snapshots are immutable, conflicts and owners are enforced', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = `synthetic-form-${randomUUID()}`;
  let active = owner;
  const app = createServer({ pool, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown, revision?: number) => app.inject({ method: method as any, url, headers: { origin, ...(revision ? { 'if-match': String(revision) } : {}) }, payload: payload as any });
  const details: UpdateDetails = { ...emptyUpdateDetails(), has_historical: false, reporting_cutoff: '2026-06-30', bond_terms: '统一注册，覆盖 MTN、CP、SCP；本期金额待定。', underwriting: '合成证券', supplementary_notes: '合成样本：授信50亿元。', funding_uses: [{ purpose: 'construction', amount: { value: '1.000001', unit: 'hundred_million' }, details: '用途待核实，相关许可后补', target: '合成项目' }] };
  try {
    const created = await send('POST', '/api/v1/projects', { name: '合成 DFI 项目', kind: 'update', issuer_name: '合成发行人', market: 'nafmii', offering: 'dfi', update_details: details });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().project_id; const path = `/api/v1/projects/${id}`;
    assert.deepEqual(created.json().update_details, details);
    const get = await send('GET', path); assert.equal(get.json().offering, 'dfi'); assert.deepEqual(get.json().update_details, details);
    const patch = await send('PATCH', path, { name: '合成 DFI 改名' }, 1);
    assert.equal(patch.statusCode, 200, patch.body); assert.deepEqual(patch.json().update_details, details);
    const locked = await send('POST', `${path}/input-revisions`, { draft_revision: 2, material_versions: [], requirement_message_ids: [] });
    assert.equal(locked.statusCode, 201, locked.body);
    const initialSnapshot = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=1', [id])).rows[0];
    assert.deepEqual(initialSnapshot.manifest.update_details, details);
    const next = { ...details, has_historical: true, supplementary_notes: '已补充合成说明', registration_amount: { value: '0', unit: 'yuan' as const } };
    assert.equal((await send('PATCH', path, { update_details: next }, 2)).statusCode, 200);
    const stale = await send('PATCH', path, { update_details: details }, 2); assert.equal(stale.statusCode, 409);
    for (const bad of [
      { ...next, reporting_cutoff: '2025-02-29' },
      { ...next, registration_amount: { value: '1', unit: 'hundred_million' }, issuance_amount: { value: '10000.000001', unit: 'ten_thousand' } },
      { ...next, issuance_amount: { value: '-1', unit: 'yuan' } },
      { ...next, issuance_amount: { value: '1.0000001', unit: 'yuan' } }
    ]) assert.equal((await send('PATCH', path, { update_details: bad }, 3)).statusCode, 422);
    assert.equal((await send('PATCH', path, { market: 'sse' }, 3)).statusCode, 422);
    const unchanged = (await send('GET', path)).json(); assert.equal(unchanged.draft_revision, 3); assert.deepEqual(unchanged.update_details, next);
    const second = await send('POST', `${path}/input-revisions`, { draft_revision: 3, material_versions: [], requirement_message_ids: [] });
    assert.equal(second.statusCode, 201); assert.notEqual(second.json().input_hash, locked.json().input_hash);
    assert.deepEqual((await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=1', [id])).rows[0], initialSnapshot);
    active = `${owner}-other`;
    assert.equal((await send('GET', path)).statusCode, 404); assert.equal((await send('PATCH', path, { name: 'Cross-owner' }, 3)).statusCode, 404);
    assert.equal((await send('GET', `${path}/input-revisions/1`)).statusCode, 404);
    assert.ok(!(await send('GET', '/api/v1/projects')).json().items.some((p: any) => p.project_id === id));
    active = owner;
    const reset = await send('PATCH', path, { market: 'sse', offering: null, update_details: emptyUpdateDetails() }, 3);
    assert.equal(reset.statusCode, 200); assert.deepEqual(reset.json().update_details, emptyUpdateDetails());
    assert.equal((await pool.query("SELECT count(*) FROM bb_outbox WHERE owner_user_id=$1 AND event_type='project.draft_updated'", [owner])).rows[0].count, '3');
    const legacy = await send('POST', '/api/v1/projects', { name: '合成旧客户端草稿', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.deepEqual(legacy.json().update_details, emptyUpdateDetails());
  } finally {
    await app.close();
    // Input revisions are append-only. Unique synthetic owners remain in the disposable test DB.
    await pool.end();
  }
});
