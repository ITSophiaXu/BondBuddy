import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadTargetConfirmation } from './target-confirmation.js';

const database = await isolatedTestDatabase('TARGET_CONFIRMATION_TEST_DATABASE_URL');
const origin = 'http://bondbuddy.test';
const period = (year: number) => ({ start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual',
  scope: 'consolidated', status: 'user_asserted', evidence_refs: [] });

test('target intent is an immutable owner-scoped part of the input revision and run replay', { skip: !database }, async () => {
  const pool = new Pool({ connectionString: database });
  const ownerA = `target-a-${randomUUID()}`;
  const ownerB = `target-b-${randomUUID()}`;
  let active = ownerA;
  const app = createServer({ pool, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin, enableRunStaging: true });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url,
    headers: { origin }, ...(payload === undefined ? {} : { payload: payload as any }) });
  try {
    const details = { has_historical: false, reporting_cutoff: null, target_reporting_periods: [period(2024), period(2025)],
      registration_amount: null, issuance_amount: null, bond_terms: null, underwriting: null, other_agencies: null,
      rating_enhancement: null, funding_uses: [], other_information: null, supplementary_notes: null };
    const projectResponse = await send('POST', '/api/v1/projects', { name: 'Synthetic target', kind: 'update', issuer_name: null,
      market: 'sse', offering: 'private', update_details: details });
    assert.equal(projectResponse.statusCode, 201, projectResponse.body);
    const project = projectResponse.json().project_id as string;
    const path = `/api/v1/projects/${project}/input-revisions`;
    const lock = (confirmation?: unknown) => send('POST', path, { draft_revision: 1, material_versions: [],
      requirement_message_ids: [], ...(confirmation === undefined ? {} : { target_confirmation: confirmation }) });
    const request = { market: 'sse', offering: 'private', document_purpose: 'issuance', as_of: '2026-09-26',
      target_reporting_periods: [period(2025), period(2024), period(2025)] };
    const unconfirmedResponse = await lock();
    assert.equal(unconfirmedResponse.statusCode, 201, unconfirmedResponse.body);
    const unconfirmed = unconfirmedResponse.json();
    assert.equal(unconfirmed.target_confirmation.status, 'unconfirmed');
    assert.equal((await send('GET', `${path}/1`)).json().target_confirmation.status, 'unconfirmed');
    assert.equal(await loadTargetConfirmation(pool, ownerA, project, 1), null);
    assert.equal((await lock({ ...request, market: 'szse' })).statusCode, 422);
    assert.equal((await lock({ ...request, offering: 'public' })).statusCode, 422);
    assert.equal((await lock({ ...request, target_reporting_periods: [period(2025)] })).statusCode, 422);
    assert.equal((await lock({ ...request, as_of: '2026-02-30' })).statusCode, 422);
    assert.equal((await lock({ ...request, confirmed_by: ownerB })).statusCode, 422);

    const confirmedResponse = await lock(request);
    assert.equal(confirmedResponse.statusCode, 201, confirmedResponse.body);
    const confirmed = confirmedResponse.json();
    assert.notEqual(confirmed.input_hash, unconfirmed.input_hash);
    const alternative = await lock({ ...request, document_purpose: 'registration' });
    assert.equal(alternative.statusCode, 201, alternative.body);
    assert.notEqual(alternative.json().input_hash, confirmed.input_hash, 'a changed target declaration changes the locked hash');
    assert.equal(confirmed.target_confirmation.status, 'confirmed');
    assert.equal(confirmed.target_confirmation.confirmed_by, ownerA);
    assert.deepEqual(confirmed.target_confirmation.target_reporting_periods, [period(2024), period(2025)]);
    const stored = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=2',
      [ownerA, project])).rows[0];
    assert.deepEqual(stored.manifest.target_confirmation, confirmed.target_confirmation);
    assert.equal(stored.input_hash.trim(), confirmed.input_hash);
    assert.deepEqual(await loadTargetConfirmation(pool, ownerA, project, 2), confirmed.target_confirmation);
    assert.equal(await loadTargetConfirmation(pool, ownerB, project, 2), null);
    const read = await send('GET', `${path}/2`);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json().target_confirmation, confirmed.target_confirmation);
    active = ownerB;
    assert.equal((await send('GET', `${path}/2`)).statusCode, 404);
    active = ownerA;

    const row = [ownerA, project, 2, 'sse', 'private', 'issuance', '2026-09-26', '[]', ownerA, new Date().toISOString()];
    await assert.rejects(pool.query(`INSERT INTO bb_input_revision_target_confirmations
      (owner_user_id,project_id,input_revision,market,offering,document_purpose,as_of,target_reporting_periods,confirmed_by,confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, row), { code: '23505' });
    await assert.rejects(pool.query('UPDATE bb_input_revision_target_confirmations SET market=$1 WHERE owner_user_id=$2 AND project_id=$3 AND input_revision=2',
      ['szse', ownerA, project]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM bb_input_revision_target_confirmations WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=2',
      [ownerA, project]), { code: '23514' });

    const execution = { execution_request_id: randomUUID(), project_id: project, input_revision: 2,
      input_hash: confirmed.input_hash, task_kind: 'update', input_manifest_ref: 'synthetic', storage_origin: 'cloud', workspace_id: 'synthetic' };
    const firstRun = await send('POST', '/api/v1/runs/execute', execution);
    assert.equal(firstRun.statusCode, 202, firstRun.body);
    const replay = await send('POST', '/api/v1/runs/execute', execution);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().run_id, firstRun.json().run_id);
  } finally { await app.close(); await pool.end(); }
});
