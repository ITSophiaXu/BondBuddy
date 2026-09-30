import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { inputManifestHash } from './production-rule-pin.js';

import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase();
const origin = 'https://synthetic.example';
const historyMedia = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('HTTP update preflight returns conservative, owner-scoped immutable difficulty summaries', {
  skip: !connection && 'set BB_TEST_DATABASE_URL to migrated PostgreSQL 16 (including migration 0038)',
}, async () => {
  const pool = new Pool({ connectionString: connection });
  const suffix = randomUUID();
  const owner = `preflight-owner-${suffix}`;
  const project = `preflight-project-${suffix}`;
  const history = `preflight-history-${suffix}`;
  const finance = `preflight-finance-${suffix}`;
  const digest = 'a'.repeat(64);
  let activeOwner = owner;
  const app = createServer({ pool, principal: async () => ({ userId: activeOwner, csrfVerified: true }), allowedOrigin: origin });
  const send = (inputRevision: number, inputHash: string) => app.inject({ method: 'POST', url: `/api/v1/projects/${project}/preflight`,
    headers: { origin }, payload: { input_revision: inputRevision, input_hash: inputHash } });
  const period = (year: number) => ({ start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] });

  const profile = (profileVersion: number) => {
    const provenance = { material_id: history, material_version: 1, method: 'native_text', extractor_version: 'synthetic', evidence_refs: [] };
    const pendingField = () => ({ value: null, raw_value: null, provenance, uncertainty: ['synthetic_unconfirmed'], status: 'needs_confirmation' });
    return { material_id: history, material_version: 1, profile_version: profileVersion, state: 'needs_confirmation',
      source_market: pendingField(), source_offering: pendingField(), reporting_periods: [], latest_reporting_cutoff: pendingField() };
  };

  const addMaterial = async (id: string, role: string, mediaType: string) => {
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,$5,10,$6,$7,$8,now()+interval '1 hour','completed')`,
    [`${id}-upload`, owner, project, `${id}.bin`, mediaType, digest, role, `synthetic/${suffix}/${id}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,$5,$6,$7,10,$8,$9,'parsed')`,
    [id, owner, project, `${id}-upload`, role, `${id}.bin`, mediaType, digest, `users/${owner}/projects/${project}/${id}`]);
  };
  const addLock = async (revision: number, draftRevision: number, periods: ReturnType<typeof period>[], includeFinance = true,
    invalid = false, confirmed = true) => {
    const materials = [{ material_id: history, material_version: 1, role: 'historical', sha256: digest },
      ...(includeFinance ? [{ material_id: finance, material_version: 1, role: 'financial', sha256: digest }] : [])];
    const targetConfirmation = { status: 'confirmed', market: 'sse', offering: 'private', document_purpose: null, as_of: null,
      target_reporting_periods: periods, confirmed_by: owner, confirmed_at: '2026-09-27T06:00:00.000Z' };
    const manifest = { kind: 'update', draft_revision: draftRevision, market: 'sse', offering: 'private', materials,
      update_details: invalid ? null : { target_reporting_periods: periods }, target_confirmation: confirmed ? targetConfirmation : {
        status: 'unconfirmed', market: null, offering: null, document_purpose: null, as_of: null,
        target_reporting_periods: [], confirmed_by: null, confirmed_at: null } };
    const inputHash = inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb)`,
    [project, revision, owner, draftRevision, inputHash, JSON.stringify(manifest),
      JSON.stringify(materials.map(({ material_id, material_version }) => ({ material_id, material_version })))]);
    if (confirmed) await pool.query(`INSERT INTO bb_input_revision_target_confirmations(owner_user_id,project_id,input_revision,market,offering,
      document_purpose,as_of,target_reporting_periods,confirmed_by,confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [owner, project, revision, targetConfirmation.market, targetConfirmation.offering, targetConfirmation.document_purpose,
      targetConfirmation.as_of, JSON.stringify(periods), targetConfirmation.confirmed_by, targetConfirmation.confirmed_at]);
    await pool.query('UPDATE bb_projects SET draft_revision=$3,latest_input_revision=$4 WHERE owner_user_id=$1 AND id=$2',
      [owner, project, draftRevision, revision]);
    return inputHash;
  };

  try {
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering) VALUES($1,$2,'synthetic update','update','sse','private')`, [project, owner]);
    await addMaterial(history, 'historical', historyMedia);
    await addMaterial(finance, 'financial', 'application/pdf');
    await pool.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES($1,$2,$3,1,1,$4,$5,'recognition',$6::jsonb)`,
    [owner, project, history, `profile-${suffix}-1`, digest, JSON.stringify(profile(1))]);

    const firstHash = await addLock(1, 1, [period(2025)]);
    const first = await send(1, firstHash);
    assert.equal(first.statusCode, 200, first.body);
    const summary1 = first.json().update_difficulty;
    assert.equal(summary1.status, 'needs_confirmation');
    assert.equal(summary1.estimated_n, null, 'user_asserted target periods never become a ready estimate');
    assert.equal(summary1.source_profile_version, 1);
    assert.ok(first.json().uncertainty.includes('update_difficulty_needs_confirmation'));
    assert.ok(first.json().missing_inputs.includes('execution_capability_not_ready'));
    assert.ok(summary1, 'free difficulty snapshot is returned even while execution capability remains unavailable');
    const replay = await send(1, firstHash);
    assert.equal(replay.json().update_difficulty.snapshot_id, summary1.snapshot_id, 'same lock reuses its snapshot');

    const changedTargetHash = await addLock(2, 2, [period(2026)]);
    const stale = await send(1, firstHash);
    assert.equal(stale.statusCode, 200, stale.body);
    assert.equal(stale.json().status, 'blocked');
    assert.ok(stale.json().missing_inputs.some((item: string) => item.startsWith('update_difficulty_stale:')),
      'an old immutable input remains inspectable but cannot create a current difficulty snapshot');
    assert.equal(stale.json().update_difficulty, undefined);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_update_difficulty_snapshots WHERE id=$1', [summary1.snapshot_id])).rows[0]!.n, 1,
      'stale target leaves the old snapshot intact');
    const changedTarget = await send(2, changedTargetHash);
    const summary2 = changedTarget.json().update_difficulty;
    assert.notEqual(summary2.snapshot_id, summary1.snapshot_id);

    await pool.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES($1,$2,$3,1,2,$4,$5,'recognition',$6::jsonb)`,
    [owner, project, history, `profile-${suffix}-2`, 'b'.repeat(64), JSON.stringify(profile(2))]);
    const changedProfile = await send(2, changedTargetHash);
    assert.notEqual(changedProfile.json().update_difficulty.snapshot_id, summary2.snapshot_id);
    assert.equal(changedProfile.json().update_difficulty.source_profile_version, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_update_difficulty_snapshots WHERE id=$1', [summary2.snapshot_id])).rows[0]!.n, 1,
      'profile refresh appends a snapshot and retains the previous one');

    const pendingHash = await addLock(3, 3, [period(2027)], false);
    const pending = await send(3, pendingHash);
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(pending.json().update_difficulty, undefined);
    assert.ok(pending.json().missing_inputs.includes('update_difficulty_pending:financial_materials_required'));

    const invalidHash = await addLock(4, 4, [period(2028)], true, true);
    const corrupt = await send(4, invalidHash);
    assert.equal(corrupt.statusCode, 503, corrupt.body);
    assert.equal(corrupt.json().code, 'DATA_UNAVAILABLE', 'persisted manifest corruption is not reported as an ordinary missing input');

    const unconfirmedHash = await addLock(5, 5, [period(2029)], true, false, false);
    const unconfirmed = await send(5, unconfirmedHash);
    assert.equal(unconfirmed.statusCode, 200, unconfirmed.body);
    assert.equal(unconfirmed.json().update_difficulty.status, 'needs_confirmation');
    assert.equal(unconfirmed.json().update_difficulty.estimated_n, null,
      'an ordinary project target can be estimated conservatively without forging an intent confirmation');
    assert.ok(unconfirmed.json().uncertainty.includes('update_difficulty_needs_confirmation'));

    activeOwner = `foreign-owner-${suffix}`;
    const foreign = await send(2, changedTargetHash);
    assert.equal(foreign.statusCode, 404);

    activeOwner = owner;
    const reviewProject = `preflight-review-${suffix}`;
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering) VALUES($1,$2,'synthetic review','review','sse','private')", [reviewProject, owner]);
    const reviewManifest = { kind: 'review', draft_revision: 1, materials: [] };
    const reviewHash = inputManifestHash(reviewManifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb)`, [reviewProject, owner, reviewHash, JSON.stringify(reviewManifest)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE owner_user_id=$1 AND id=$2', [owner, reviewProject]);
    const review = await app.inject({ method: 'POST', url: `/api/v1/projects/${reviewProject}/preflight`, headers: { origin },
      payload: { input_revision: 1, input_hash: reviewHash } });
    assert.equal(review.statusCode, 200, review.body);
    assert.equal(review.json().update_difficulty, undefined, 'non-update manifests never receive an update estimate');
  } finally {
    activeOwner = owner;
    // The exercised input/profile/difficulty rows are append-only by schema; use
    // a dedicated throwaway PostgreSQL database for this synthetic integration.
    await app.close();
    await pool.end();
  }
});
