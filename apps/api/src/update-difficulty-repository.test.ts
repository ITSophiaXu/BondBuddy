import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  createUpdateDifficultySnapshotWithClient,
  classifyUpdateDifficultyFailure,
  ensureCurrentUpdateDifficultySnapshotWithClient,
  getCurrentUpdateDifficultySnapshotWithClient,
  getUpdateDifficultySnapshotWithClient,
  loadLockedUpdateDifficultyInputWithClient,
  type UpdateDifficultyClient,
  type TrustedUpdateDifficultyInput,
} from './update-difficulty-repository.js';

const input: TrustedUpdateDifficultyInput = {
  ownerUserId: 'api-difficulty-owner',
  projectId: 'api-difficulty-project',
  source: { materialId: 'api-historical-material', materialVersion: 1, profileVersion: 1 },
  targetRevision: 4,
  financialMaterialVersions: [{ materialId: 'api-financial-material', materialVersion: 1 }],
  targetReportingPeriods: [],
  replacements: [],
  restatements: [],
  requestId: 'api-difficulty-request',
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value: TrustedUpdateDifficultyInput): string {
  const financialMaterialVersions = [...value.financialMaterialVersions]
    .map(item => ({ materialId: item.materialId, materialVersion: item.materialVersion }))
    .sort((left, right) => left.materialId.localeCompare(right.materialId) || left.materialVersion - right.materialVersion);
  return createHash('sha256').update(canonical({ ...value, financialMaterialVersions }), 'utf8').digest('hex');
}

test('API transaction-client entry point replays idempotently without owning transaction or connection', async () => {
  const hash = requestHash(input);
  const prior = {
    id: 'difficulty-snapshot-existing', owner_user_id: input.ownerUserId, project_id: input.projectId,
    request_id: input.requestId, request_hash: hash, source_material_id: input.source.materialId,
    source_material_version: input.source.materialVersion, source_profile_version: input.source.profileVersion,
    target_revision: input.targetRevision, source_market: null, source_offering: null,
    target_market: 'sse', target_offering: 'private', input_revision: null, input_hash: null,
    financial_material_versions: [{ materialId: 'api-financial-material', materialVersion: 1 }],
    comparison_input: { targetReportingPeriods: [], replacements: [], restatements: [] },
    old_profile_completeness: 'undetermined',
    estimate: { status: 'needs_confirmation', estimatedN: null, structureAdaptationRequired: null, confirmationReasons: [] },
    created_at: '2026-09-26T00:00:00.000Z',
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  let released = false;
  const client: UpdateDifficultyClient = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM bb_projects') && sql.includes('FOR UPDATE')) return { rows: [{ id: input.projectId }] };
      if (sql.includes('FROM bb_update_difficulty_snapshots') && sql.includes('request_id=$3')) return { rows: [prior] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { released = true; },
  };

  const result = await createUpdateDifficultySnapshotWithClient(client, input);

  assert.equal(result.id, prior.id);
  assert.equal(result.replayed, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.sql !== 'BEGIN' && call.sql !== 'COMMIT' && call.sql !== 'ROLLBACK'));
  assert.equal(calls[0]!.values[0], input.ownerUserId);
  assert.equal(calls[0]!.values[1], input.projectId);
  assert.equal(released, false);
});

test('preflight failures distinguish pending inputs from stale locks and persisted data corruption', () => {
  assert.deepEqual(classifyUpdateDifficultyFailure(new Error('FINANCIAL_MATERIALS_REQUIRED')),
    { category: 'pending_input', code: 'FINANCIAL_MATERIALS_REQUIRED' });
  assert.deepEqual(classifyUpdateDifficultyFailure(new Error('HISTORICAL_PROFILE_NOT_FOUND')),
    { category: 'pending_input', code: 'HISTORICAL_PROFILE_NOT_FOUND' });
  assert.deepEqual(classifyUpdateDifficultyFailure(new Error('TARGET_INPUT_REVISION_STALE')),
    { category: 'stale_input', code: 'TARGET_INPUT_REVISION_STALE' });
  assert.deepEqual(classifyUpdateDifficultyFailure(new Error('TARGET_INPUT_MANIFEST_INVALID')),
    { category: 'data_integrity', code: 'TARGET_INPUT_MANIFEST_INVALID' });
  assert.deepEqual(classifyUpdateDifficultyFailure(new Error('INVALID_HISTORICAL_PROFILE_ROW')),
    { category: 'data_integrity', code: 'INVALID_HISTORICAL_PROFILE_ROW' });
});

test('locked update loader verifies production-rule-pin v1 manifest digests and preserves legacy locks', async () => {
  const materials = [
    { material_id: input.source.materialId, material_version: 1, role: 'historical', sha256: 'a'.repeat(64) },
    { material_id: input.financialMaterialVersions[0]!.materialId, material_version: 1, role: 'financial', sha256: 'b'.repeat(64) },
  ];
  const confirmedAt = '2026-09-27T06:00:00.000Z';
  const confirmation = { status: 'confirmed', market: 'sse', offering: 'private', document_purpose: null, as_of: null,
    target_reporting_periods: [], confirmed_by: input.ownerUserId, confirmed_at: confirmedAt };
  const manifestFor = (schema?: string) => ({ kind: 'update', draft_revision: input.targetRevision, market: 'sse', offering: 'private',
    materials, update_details: { target_reporting_periods: [] }, target_confirmation: confirmation,
    ...(schema === undefined ? {} : { manifest_schema: schema }) });
  const run = async (manifest: Record<string, unknown>, storedHash: string, persisted: Record<string, unknown> | null = confirmation,
    projectTarget = { market: 'sse', offering: 'private' }, decisionRow?: Record<string, unknown>) => {
    let materialQueryCount = 0;
    const refs = materials.map(({ material_id, material_version }) => ({ material_id, material_version }));
    const client: UpdateDifficultyClient = {
      async query(sql) {
        if (sql.includes('FROM bb_projects')) return { rows: [{ draft_revision: input.targetRevision, latest_input_revision: 7, ...projectTarget }] };
        if (sql.includes('FROM bb_input_revisions')) return { rows: [{ input_hash: storedHash, draft_revision: input.targetRevision, manifest, material_versions: refs }] };
        if (sql.includes('FROM bb_input_revision_target_confirmations')) return { rows: persisted ? [{ market: persisted.market, offering: persisted.offering,
          document_purpose: persisted.document_purpose, as_of: null, target_reporting_periods: persisted.target_reporting_periods,
          confirmed_by: persisted.confirmed_by, confirmed_at: new Date(String(persisted.confirmed_at)) }] : [] };
        if (sql.includes('FROM bb_target_period_evidence_decisions')) return { rows: decisionRow ? [decisionRow] : [] };
        if (sql.includes('FROM bb_parse_snapshots s JOIN bb_parse_evidence e')) return { rows: [{ uncertainty: [] }] };
        if (sql.includes('FROM bb_material_versions')) {
          materialQueryCount++;
          return { rows: materials.map(item => ({ id: item.material_id, version: item.material_version, role: item.role, sha256: item.sha256 })) };
        }
        if (sql.includes('FROM bb_historical_profiles')) return { rows: [{ profile_version: 1 }] };
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    const loaded = await loadLockedUpdateDifficultyInputWithClient(client, {
      ownerUserId: input.ownerUserId, projectId: input.projectId, inputRevision: 7, inputHash: storedHash, requestId: input.requestId,
    });
    return { loaded, materialQueryCount };
  };

  const validV1 = manifestFor('production_rule_pin_v1');
  const validV1Hash = createHash('sha256').update(canonical(validV1), 'utf8').digest('hex');
  const valid = await run(validV1, validV1Hash);
  assert.equal(valid.loaded.inputHash, validV1Hash);
  assert.equal(valid.loaded.targetConfirmation?.status, 'confirmed');
  assert.deepEqual(valid.loaded.targetReportingPeriods, [], 'confirmation is user intent, not a synthesized financial evidence period');
  assert.equal(valid.materialQueryCount, 1);

  const nafmiiConfirmation = { ...confirmation, market: 'nafmii', offering: 'mtn' };
  const nafmiiManifest = { ...manifestFor(), market: 'nafmii', offering: 'mtn', target_confirmation: nafmiiConfirmation };
  const nafmii = await run(nafmiiManifest, 'd'.repeat(64), nafmiiConfirmation, { market: 'nafmii', offering: 'mtn' });
  assert.equal(nafmii.loaded.targetConfirmation?.offering, 'mtn', 'shared market/offering validation accepts an authorized NAfmII product tuple');

  const firstPeriod = { start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] };
  const secondPeriod = { start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', status: 'needs_confirmation', evidence_refs: [] };
  const orderedManifest = { ...manifestFor(), update_details: { target_reporting_periods: [firstPeriod, secondPeriod] },
    target_confirmation: { ...confirmation, target_reporting_periods: [secondPeriod, firstPeriod] } };
  const orderedLock = { ...orderedManifest, manifest_schema: 'production_rule_pin_v1' };
  const sortedComparison = await run(orderedLock, createHash('sha256').update(canonical(orderedLock), 'utf8').digest('hex'),
    { ...confirmation, target_reporting_periods: [secondPeriod, firstPeriod] });
  assert.equal(sortedComparison.loaded.targetReportingPeriods.length, 2, 'period order is normalized as a set, not treated as drift');

  const decisionRecognition = { material_id: input.source.materialId, material_version: 1, profile_version: 1 };
  const decisionPeriods = [
    { ...firstPeriod, outcome: 'confirmed', reason: 'Evidence aligns.', evidence: ['table_header','entity','scope','period_end'].map((anchor_kind,index) => ({
      evidence_method: 'native_text', material_id: input.financialMaterialVersions[0]!.materialId, material_version: 1, material_sha256: 'b'.repeat(64),
      parse_snapshot_id: 'parse-snapshot', parser_version: 'parser-v1', response_sha256: 'c'.repeat(64), record_id: `period-evidence-${index}`,
      record_sha256: `${index+1}`.repeat(64), anchor_kind })) },
    { ...secondPeriod, outcome: 'needs_confirmation', reason: 'Date/scope remain unclear.', evidence: [] },
  ];
  const decisionManifest = { ...manifestFor(), manifest_schema: 'production_rule_pin_v1', update_details: { target_reporting_periods: [firstPeriod,secondPeriod] },
    target_confirmation: { ...confirmation, target_reporting_periods: [firstPeriod,secondPeriod] } };
  const decisionManifestHash = createHash('sha256').update(canonical(decisionManifest), 'utf8').digest('hex');
  const reviewed = await run(decisionManifest, decisionManifestHash, { ...confirmation, target_reporting_periods: [firstPeriod,secondPeriod] },
    { market: 'sse', offering: 'private' }, { active_grant_id: 'grant', withdrawal_id: null, source_profile_version: 1,
      source_profile_material_id: input.source.materialId, source_profile_material_version: 1,
      source_profile_sha256: createHash('sha256').update(canonical(decisionRecognition), 'utf8').digest('hex'),
      source_recognition: decisionRecognition, locked_materials: [{ material_id: input.financialMaterialVersions[0]!.materialId, material_version: 1, material_sha256: 'b'.repeat(64) },
        { material_id: input.source.materialId, material_version: 1, material_sha256: 'a'.repeat(64) }], periods: decisionPeriods,
      reviewer_grant_id: 'grant', reviewer_user_id: 'reviewer' });
  assert.equal(reviewed.loaded.targetReportingPeriods[0]?.status, 'recognized', 'confirmed sibling remains available');
  assert.equal((reviewed.loaded.targetReportingPeriods[0] as { provenance?: { method?: string } }).provenance?.method, 'native_text');
  assert.equal(reviewed.loaded.targetReportingPeriods[1]?.status, 'needs_confirmation', 'pending sibling remains independently unresolved');

  const legacy = await run(manifestFor(), 'f'.repeat(64));
  assert.equal(legacy.loaded.inputHash, 'f'.repeat(64));
  assert.equal(legacy.materialQueryCount, 1);

  const unconfirmed = { ...manifestFor(), target_confirmation: { status: 'unconfirmed', market: null, offering: null,
    document_purpose: null, as_of: null, target_reporting_periods: [], confirmed_by: null, confirmed_at: null } };
  await assert.rejects(run(unconfirmed, 'e'.repeat(64)), /TARGET_CONFIRMATION_REQUIRED/);
  await assert.rejects(run(manifestFor(), 'e'.repeat(64), null), /TARGET_CONFIRMATION_INVALID/, 'a confirmed manifest without its exact DB row fails closed');
  const alteredRow = { ...confirmation, market: 'szse' };
  await assert.rejects(run(manifestFor(), 'e'.repeat(64), alteredRow), /TARGET_CONFIRMATION_INVALID/, 'a row for a different target cannot confirm this lock');

  const tamperedV1 = { ...validV1, market: 'szse' };
  let tamperedMaterialQueryCount = 0;
  const refs = materials.map(({ material_id, material_version }) => ({ material_id, material_version }));
  const tamperedClient: UpdateDifficultyClient = {
    async query(sql) {
      if (sql.includes('FROM bb_projects')) return { rows: [{ draft_revision: input.targetRevision, latest_input_revision: 7, market: 'sse', offering: 'private' }] };
      if (sql.includes('FROM bb_input_revisions')) return { rows: [{ input_hash: validV1Hash, draft_revision: input.targetRevision,
        manifest: tamperedV1, material_versions: refs }] };
      if (sql.includes('FROM bb_material_versions')) tamperedMaterialQueryCount++;
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  await assert.rejects(loadLockedUpdateDifficultyInputWithClient(tamperedClient, {
    ownerUserId: input.ownerUserId, projectId: input.projectId, inputRevision: 7, inputHash: validV1Hash, requestId: input.requestId,
  }), /TARGET_INPUT_MANIFEST_INVALID/);
  assert.equal(tamperedMaterialQueryCount, 0, 'tampering is rejected before the loader derives source or financial inputs');

  await assert.rejects(run(manifestFor('future_manifest_v2'), 'f'.repeat(64)), /TARGET_INPUT_MANIFEST_INVALID/);
});

test('ensure-current is idempotent under concurrent PG16 calls and refreshes only for a changed lock/profile', {
  skip: !process.env.BB_TEST_DATABASE_URL && 'set BB_TEST_DATABASE_URL to migrated PostgreSQL 16 (including migration 0038)',
}, async () => {
  const pool = new Pool({ connectionString: process.env.BB_TEST_DATABASE_URL });
  const suffix = randomUUID();
  const owner = `api-difficulty-owner-${suffix}`, project = `api-difficulty-project-${suffix}`;
  const historical = `api-difficulty-history-${suffix}`, finance1 = `api-difficulty-finance1-${suffix}`, finance2 = `api-difficulty-finance2-${suffix}`;
  const digest = 'a'.repeat(64);
  const sourceProvenance = { material_id: historical, material_version: 1, method: 'native_text',
    extractor_version: 'historical-native-recognition-v1/parser-synthetic-1', evidence_refs: ['synthetic-unpersisted-source-ref'] };
  const field = (value: string) => ({ value, raw_value: value, provenance: sourceProvenance, uncertainty: [], status: 'recognized' });
  const makeRecognition = (profileVersion: number) => ({ material_id: historical, material_version: 1, profile_version: profileVersion,
    state: 'needs_confirmation', source_market: field('sse'), source_offering: field('private'),
    reporting_periods: [{ start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated',
      raw_value: '2024 annual', provenance: sourceProvenance, uncertainty: [], status: 'recognized' }],
    latest_reporting_cutoff: field('2024-12-31') });
  const uploadAndMaterial = async (client: import('pg').PoolClient, id: string, role: string, mediaType: string, key: string) => {
    const uploadId = `${id}-upload`;
    await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,$5,10,$6,$7,$8,now()+interval '1 hour','completed')`,
    [uploadId, owner, project, `${id}.bin`, mediaType, digest, role, `synthetic/${suffix}/${key}`]);
    await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,$5,$6,$7,10,$8,$9,'parsed')`,
    [id, owner, project, uploadId, role, `${id}.bin`, mediaType, digest, `users/${owner}/projects/${project}/${key}`]);
  };
  const addInputLock = async (client: import('pg').PoolClient, revision: number, draftRevision: number, financeId: string, year: number,
    manifestSchema?: string, confirmed = true) => {
    const targetPeriod = { start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual', scope: 'consolidated',
      status: 'user_asserted', evidence_refs: [] };
    const targetConfirmation = confirmed ? { status: 'confirmed', market: 'sse', offering: 'private', document_purpose: null, as_of: null,
      target_reporting_periods: [targetPeriod], confirmed_by: owner, confirmed_at: '2026-09-27T06:00:00.000Z' } : {
      status: 'unconfirmed', market: null, offering: null, document_purpose: null, as_of: null,
      target_reporting_periods: [], confirmed_by: null, confirmed_at: null };
    const materials = [
      { material_id: historical, material_version: 1, role: 'historical', sha256: digest },
      { material_id: financeId, material_version: 1, role: 'financial', sha256: digest },
    ];
    const manifest = { kind: 'update', draft_revision: draftRevision, market: 'sse', offering: 'private', materials,
      update_details: { target_reporting_periods: [targetPeriod] }, target_confirmation: targetConfirmation,
      ...(manifestSchema === undefined ? {} : { manifest_schema: manifestSchema }) };
    const inputHash = manifestSchema === 'production_rule_pin_v1' ? createHash('sha256').update(canonical(manifest), 'utf8').digest('hex')
      : createHash('sha256').update(`${suffix}:${revision}:${year}:${financeId}`).digest('hex');
    await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb)`,
    [project, revision, owner, draftRevision, inputHash, JSON.stringify(manifest),
      JSON.stringify(materials.map(({ material_id, material_version }) => ({ material_id, material_version })))]);
    if (confirmed) await client.query(`INSERT INTO bb_input_revision_target_confirmations(owner_user_id,project_id,input_revision,market,offering,document_purpose,as_of,target_reporting_periods,confirmed_by,confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [owner, project, revision, targetConfirmation.market, targetConfirmation.offering, targetConfirmation.document_purpose,
      targetConfirmation.as_of, JSON.stringify(targetConfirmation.target_reporting_periods), targetConfirmation.confirmed_by, targetConfirmation.confirmed_at]);
    await client.query(`UPDATE bb_projects SET draft_revision=$3,latest_input_revision=$4 WHERE owner_user_id=$1 AND id=$2`,
      [owner, project, draftRevision, revision]);
    return inputHash;
  };
  const makeClient = (client: import('pg').PoolClient): UpdateDifficultyClient => ({
    query: async (sql, values = []) => client.query(sql, values as any) as unknown as Promise<{ rows: Record<string, unknown>[] }>,
  });
  const runEnsure = async (client: import('pg').PoolClient, inputRevision: number, inputHash: string) => {
    await client.query('BEGIN');
    try {
      const result = await ensureCurrentUpdateDifficultySnapshotWithClient(makeClient(client), { ownerUserId: owner, projectId: project, inputRevision, inputHash });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };
  const seed = await pool.connect();
  try {
    const migration = await seed.query(`SELECT to_regclass('public.bb_fact_extraction_runs') AS table_name`);
    assert.equal(migration.rows[0]!.table_name, 'bb_fact_extraction_runs', 'test database must have real migration 0038 applied');
    await seed.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering) VALUES($1,$2,'synthetic','update','sse','private')`, [project, owner]);
    await uploadAndMaterial(seed, historical, 'historical', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'history');
    await uploadAndMaterial(seed, finance1, 'financial', 'application/pdf', 'finance1');
    await seed.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES($1,$2,$3,1,1,$4,$5,'recognition',$6::jsonb)`,
    [owner, project, historical, `profile-${suffix}-1`, digest, JSON.stringify(makeRecognition(1))]);
    const inputHash1 = await addInputLock(seed, 1, 1, finance1, 2025);

    // Keep both transactions open while the second blocks on the owner-scoped project row.
    const firstClient = await pool.connect(), secondClient = await pool.connect();
    let snapshot1: Awaited<ReturnType<typeof runEnsure>>;
    try {
      await firstClient.query('BEGIN'); await secondClient.query('BEGIN');
      snapshot1 = await ensureCurrentUpdateDifficultySnapshotWithClient(makeClient(firstClient), { ownerUserId: owner, projectId: project, inputRevision: 1, inputHash: inputHash1 });
      const concurrentReplay = ensureCurrentUpdateDifficultySnapshotWithClient(makeClient(secondClient), { ownerUserId: owner, projectId: project, inputRevision: 1, inputHash: inputHash1 });
      await firstClient.query('COMMIT');
      const replayed = await concurrentReplay;
      assert.equal(replayed.id, snapshot1.id);
      assert.equal(replayed.replayed, true);
      await secondClient.query('COMMIT');
    } catch (error) {
      try { await firstClient.query('ROLLBACK'); } catch { /* preserve first error */ }
      try { await secondClient.query('ROLLBACK'); } catch { /* preserve first error */ }
      throw error;
    } finally { firstClient.release(); secondClient.release(); }
    assert.equal(snapshot1!.estimate.status, 'needs_confirmation');
    assert.equal(snapshot1!.estimate.estimatedN, null, 'user_asserted target periods and absent evidence cannot produce ready/N');
    assert.equal(snapshot1!.comparisonInput.targetConfirmation?.status, 'confirmed');
    assert.equal(snapshot1!.comparisonInput.targetReportingPeriods[0]?.status, 'user_asserted', 'confirmation never upgrades target intent into recognized finance evidence');
    assert.equal((await getCurrentUpdateDifficultySnapshotWithClient(makeClient(seed), { ownerUserId: owner, projectId: project, snapshotId: snapshot1!.id }))?.id, snapshot1!.id);

    await uploadAndMaterial(seed, finance2, 'financial', 'application/pdf', 'finance2');
    const inputHash2 = await addInputLock(seed, 2, 2, finance2, 2026);
    const snapshot2 = await runEnsure(seed, 2, inputHash2);
    assert.notEqual(snapshot2.id, snapshot1!.id, 'new target/input and finance material versions get a new immutable snapshot');
    assert.ok(await getUpdateDifficultySnapshotWithClient(makeClient(seed), { ownerUserId: owner, projectId: project, snapshotId: snapshot1!.id }),
      'old snapshot stays readable by ID');
    assert.equal(await getCurrentUpdateDifficultySnapshotWithClient(makeClient(seed), { ownerUserId: owner, projectId: project, snapshotId: snapshot1!.id }), null,
      'old target snapshot is no longer current');

    await seed.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES($1,$2,$3,1,2,$4,$5,'recognition',$6::jsonb)`,
    [owner, project, historical, `profile-${suffix}-2`, 'b'.repeat(64), JSON.stringify(makeRecognition(2))]);
    const snapshot3 = await runEnsure(seed, 2, inputHash2);
    assert.notEqual(snapshot3.id, snapshot2.id, 'a new source profile version gets a new immutable snapshot');
    assert.equal(snapshot3.sourceProfileVersion, 2);
    assert.equal(await getCurrentUpdateDifficultySnapshotWithClient(makeClient(seed), { ownerUserId: owner, projectId: project, snapshotId: snapshot2.id }), null,
      'prior profile snapshot is no longer current');
    assert.equal((await getCurrentUpdateDifficultySnapshotWithClient(makeClient(seed), { ownerUserId: owner, projectId: project, snapshotId: snapshot3.id }))?.id, snapshot3.id);

    const inputHash4 = await addInputLock(seed, 3, 3, finance2, 2026, 'production_rule_pin_v1');
    const snapshot4 = await runEnsure(seed, 3, inputHash4);
    assert.equal(snapshot4.inputHash, inputHash4, 'valid v1 manifests load when their canonical hash matches the input lock');

    const unconfirmedHash = await addInputLock(seed, 4, 4, finance2, 2026, undefined, false);
    await assert.rejects(runEnsure(seed, 4, unconfirmedHash), /TARGET_CONFIRMATION_REQUIRED/,
      'the PG16 loader does not treat absent 0053 confirmation rows as confirmed intent');

    await assert.rejects(ensureCurrentUpdateDifficultySnapshotWithClient(makeClient(seed), {
      ownerUserId: `foreign-owner-${suffix}`, projectId: project, inputRevision: 4, inputHash: unconfirmedHash,
    }), /PROJECT_NOT_FOUND/, 'a different owner cannot read or create a snapshot for this project');
  } finally {
    seed.release();
    await pool.end();
  }
});
