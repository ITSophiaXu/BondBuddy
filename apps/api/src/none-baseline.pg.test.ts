// SYNTHETIC metadata. Real API and PostgreSQL; no customer files, Blob or provider calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { emptyUpdateDetails, FIRST_DRAFT_EXCLUSION_SCOPE, type FirstDraftConfirmationRequest,
  type HistoricalExclusionPin, type UnifiedAuthoringInput } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { inputManifestHash } from './production-rule-pin.js';
import { historicalExclusions, lockNoneBaseline, NoneBaselineConflict, validateNoneBaseline } from './none-baseline.js';

const connection = await isolatedTestDatabase(undefined, 'none-baseline');
const origin = 'http://bondbuddy.test';
const stamp = '2026-11-03T00:00:00.000Z';
const authoring = (): UnifiedAuthoringInput => ({ version: 'unified_v1', source_prospectuses: [], requirements: [],
  knowledge: [], knowledge_status: 'authoring_reference_not_compliance_approval',
  format_policy: { version: 'source-format-v1', mode: 'new_document', template: null, selection: 'automatic' } });
const confirmation = (pins: HistoricalExclusionPin[]): FirstDraftConfirmationRequest => ({ decision: 'generate_first_draft',
  scope: FIRST_DRAFT_EXCLUSION_SCOPE, excluded_historical: pins });
const code = (expected: string) => (error: unknown) => error instanceof NoneBaselineConflict && error.code === expected;

async function fixture(kind: 'update' | 'generation' = 'generation', historical = true) {
  const pool = new Pool({ connectionString: connection }), owner = `synthetic-none-${randomUUID()}`;
  const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
  const close = async () => { await app.close(); await pool.end(); };
  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic omitted history', kind,
      issuer_name: 'Synthetic issuer', market: null, offering: null,
      update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', has_historical: false } });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project_id, base = `/api/v1/projects/${projectId}`, scope = { owner, projectId };
    async function add(id: string, version: number, role: 'historical' | 'financial' | 'reference', sha256: string, client: Pool | PoolClient = pool) {
      const upload = randomUUID();
      await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'synthetic-none.txt','text/plain',10,$4,$5,$6,now()+interval '1 hour','completed',$4,10)`,
      [upload, owner, projectId, sha256, role, `users/${owner}/projects/${projectId}/uploads/${upload}`]);
      await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,$2,$3,$4,$5,$6,'synthetic-none.txt','text/plain',10,$7,$8,'persisted')`,
      [id, version, owner, projectId, upload, role, sha256, `users/${owner}/projects/${projectId}/materials/${id}/${version}`]);
      return { material_id: id, material_version: version, sha256 };
    }
    const financial = await add(`financial-${randomUUID()}`, 1, 'financial', 'c'.repeat(64));
    const history = historical ? [await add(`history-${randomUUID()}`, 1, 'historical', 'a'.repeat(64))] : [];
    const payload = { draft_revision: created.json().draft_revision, material_versions: [
      { material_id: financial.material_id, material_version: financial.material_version }], requirement_message_ids: [] };
    const lock = (extra: Record<string, unknown> = {}) => send('POST', `${base}/input-revisions`, { ...payload, ...extra });
    const state = async () => ({ inputs: (await pool.query('SELECT revision,input_hash,manifest FROM bb_input_revisions WHERE project_id=$1 ORDER BY revision', [projectId])).rows,
      latest: (await pool.query('SELECT latest_input_revision FROM bb_projects WHERE id=$1', [projectId])).rows[0].latest_input_revision,
      events: (await pool.query("SELECT id FROM bb_outbox WHERE aggregate_id=$1 AND event_type='project.input_locked' ORDER BY id", [projectId])).rows });
    const manifest = () => ({ kind, materials: [{ ...financial, role: 'financial' }], authoring: authoring() });
    return { pool, app, owner, projectId, scope, base, send, close, add, financial, history, payload, lock, state, manifest };
  } catch (error) { await close(); throw error; }
}

test('update none rejects omitted unadopted history; draft flags and ordinary target confirmation cannot override', { skip: !connection }, async () => {
  const f = await fixture('update');
  try {
    const before = await f.state();
    const rejected = await f.lock();
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().code, 'HISTORICAL_BASELINE_REQUIRED');
    assert.deepEqual(await f.state(), before);
    await assert.rejects(validateNoneBaseline(f.pool, f.scope, { ...f.manifest(),
      target_confirmation: { status: 'confirmed' } } as ReturnType<typeof f.manifest>), code('HISTORICAL_BASELINE_REQUIRED'));
  } finally { await f.close(); }
});

test('generation requires an independent exact confirmation and server stamps it into the immutable hash', { skip: !connection }, async () => {
  const f = await fixture();
  try {
    const before = await f.state(), rejected = await f.lock();
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().code, 'FIRST_DRAFT_CONFIRMATION_REQUIRED');
    assert.deepEqual(await f.state(), before);
    const preview = await f.send('GET', `${f.base}/first-draft-exclusions`);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.match(String(preview.headers['cache-control']), /no-store/);
    assert.deepEqual(preview.json(), { project_id: f.projectId, draft_revision: f.payload.draft_revision, project_kind: 'generation',
      scope: FIRST_DRAFT_EXCLUSION_SCOPE, excluded_historical: f.history.map(pin => ({ ...pin, filename: 'synthetic-none.txt' })) });
    const response = await f.lock({ first_draft_confirmation: confirmation(f.history) });
    assert.equal(response.statusCode, 201, response.body);
    const locked = (await f.state()).inputs[0], snapshot = locked.manifest.authoring.none_baseline;
    assert.equal(snapshot.owner_user_id, f.owner);
    assert.equal(snapshot.project_id, f.projectId);
    assert.equal(snapshot.first_draft_confirmation.confirmed_by, f.owner);
    assert.equal(snapshot.first_draft_confirmation.confirmed_at, snapshot.checked_at);
    assert.ok(Number.isFinite(Date.parse(snapshot.checked_at)));
    assert.deepEqual(snapshot.excluded_historical, f.history);
    assert.deepEqual(snapshot.first_draft_confirmation.excluded_historical, f.history);
    assert.equal(inputManifestHash(locked.manifest), String(locked.input_hash).trim());
    const changed = structuredClone(locked.manifest);
    changed.authoring.none_baseline.first_draft_confirmation.confirmed_by = 'someone-else';
    assert.notEqual(inputManifestHash(changed), String(locked.input_hash).trim());
    await validateNoneBaseline(f.pool, f.scope, locked.manifest);
  } finally { await f.close(); }
});

test('new none inputs with no omitted historical versions remain valid without a confirmation', { skip: !connection }, async () => {
  for (const kind of ['update', 'generation'] as const) {
    const f = await fixture(kind, false);
    try {
      const locked = await f.lock();
      assert.equal(locked.statusCode, 201, locked.body);
      const m = (await f.state()).inputs[0].manifest;
      assert.deepEqual(m.authoring.none_baseline.excluded_historical, []);
      assert.equal(m.authoring.none_baseline.first_draft_confirmation, null);
      await validateNoneBaseline(f.pool, f.scope, m);
    } finally { await f.close(); }
  }
});

test('missing, extra, duplicate, wrong version/hash/scope and client actor/time confirmations fail without writes', { skip: !connection }, async () => {
  const f = await fixture();
  try {
    const pin = f.history[0]!, before = await f.state();
    for (const pins of [[], [{ ...pin, material_version: 2 }], [{ ...pin, sha256: 'e'.repeat(64) }],
      [pin, { ...pin, material_id: 'unknown' }]]) {
      const rejected = await f.lock({ first_draft_confirmation: confirmation(pins) });
      assert.equal(rejected.statusCode, 409, rejected.body);
      assert.equal(rejected.json().code, 'FIRST_DRAFT_EXCLUSION_STALE');
      assert.deepEqual(await f.state(), before);
    }
    const duplicate = await f.lock({ first_draft_confirmation: confirmation([pin, pin]) });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(duplicate.json().code, 'INPUT_REVISION_CONFLICT');
    for (const bad of [{ ...confirmation([pin]), scope: 'latest_version_only' },
      { ...confirmation([pin]), confirmed_by: f.owner }, { ...confirmation([pin]), confirmed_at: stamp }]) {
      const rejected = await f.lock({ first_draft_confirmation: bad });
      assert.equal(rejected.statusCode, 422, rejected.body);
      assert.equal(rejected.json().code, 'VALIDATION_FAILED');
    }
    assert.deepEqual(await f.state(), before);
  } finally { await f.close(); }
});

test('the exclusion query includes all undeleted versions and isolates owner/project', { skip: !connection }, async () => {
  const f = await fixture(), other = await fixture();
  try {
    const v2 = await f.add(f.history[0]!.material_id, 2, 'historical', 'b'.repeat(64));
    const deleted = await f.add(`deleted-${randomUUID()}`, 1, 'historical', 'd'.repeat(64));
    await f.pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1', [deleted.material_id]);
    const preview = await f.send('GET', `${f.base}/first-draft-exclusions`);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().excluded_historical.map(({ filename, ...p }: any) => p), [...f.history, v2]);
    assert.equal((await f.send('GET', `${other.base}/first-draft-exclusions`)).statusCode, 404);
    assert.deepEqual(await historicalExclusions(f.pool, { owner: other.owner, projectId: f.projectId }, []), []);
    const selected = await historicalExclusions(f.pool, f.scope, [{ ...v2, role: 'historical' }]);
    assert.deepEqual(selected.map(({ filename, ...p }) => p), f.history, 'only exact selected version is excluded from omission');
    const rejected = await f.lock({ first_draft_confirmation: confirmation([v2]) });
    assert.equal(rejected.json().code, 'FIRST_DRAFT_EXCLUSION_STALE');
    assert.equal((await f.lock({ first_draft_confirmation: confirmation([v2, ...f.history]) })).statusCode, 201, 'input order is normalized');
  } finally { await f.close(); await other.close(); }
});

test('worker/recovery invalidates later additions, deletion, version, role and project-kind changes without backfill', { skip: !connection }, async () => {
  for (const change of ['addition', 'deletion', 'version', 'role', 'kind'] as const) {
    const f = await fixture();
    try {
      assert.equal((await f.lock({ first_draft_confirmation: confirmation(f.history) })).statusCode, 201);
      const before = await f.state(), manifest = before.inputs[0].manifest;
      await validateNoneBaseline(f.pool, f.scope, manifest);
      if (change === 'addition') await f.add(`new-${randomUUID()}`, 1, 'historical', 'b'.repeat(64));
      if (change === 'version') await f.add(f.history[0]!.material_id, 2, 'historical', 'b'.repeat(64));
      if (change === 'deletion') await f.pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1', [f.history[0]!.material_id]);
      if (change === 'role') await f.pool.query("UPDATE bb_material_versions SET role='reference' WHERE id=$1", [f.history[0]!.material_id]);
      if (change === 'kind') await f.pool.query("UPDATE bb_projects SET kind='update' WHERE id=$1", [f.projectId]);
      await assert.rejects(validateNoneBaseline(f.pool, f.scope, manifest), code(change === 'kind' ? 'INPUT_REVISION_CONFLICT' : 'FIRST_DRAFT_EXCLUSION_STALE'));
      assert.deepEqual(await f.state(), before, 'old input/hash/confirmation and outbox remain byte-equivalent');
    } finally { await f.close(); }
  }
});

test('legacy empty exclusion is safe; old target confirmation and malformed snapshots do not authorize omitted history', { skip: !connection }, async () => {
  const empty = await fixture('generation', false), f = await fixture();
  try {
    await validateNoneBaseline(empty.pool, empty.scope, empty.manifest());
    await assert.rejects(validateNoneBaseline(f.pool, f.scope, { ...f.manifest(), target_confirmation: { status: 'confirmed' } } as ReturnType<typeof f.manifest>),
      code('FIRST_DRAFT_CONFIRMATION_REQUIRED'));
    const m = f.manifest();
    m.authoring.none_baseline = await lockNoneBaseline(f.pool, f.scope, 'generation', m.materials, m.authoring, confirmation(f.history), stamp);
    for (const mutate of [
      (v: any) => { v.owner_user_id = empty.owner; }, (v: any) => { v.project_id = empty.projectId; },
      (v: any) => { v.checked_at = 'invalid'; }, (v: any) => { v.first_draft_confirmation.confirmed_by = empty.owner; },
      (v: any) => { v.first_draft_confirmation.confirmed_at = '2026-11-02T00:00:00.000Z'; },
      (v: any) => { v.first_draft_confirmation.scope = 'latest_version_only'; },
      (v: any) => { v.first_draft_confirmation.excluded_historical = []; }
    ]) {
      const changed = structuredClone(m); mutate(changed.authoring.none_baseline);
      await assert.rejects(validateNoneBaseline(f.pool, f.scope, changed), code('INPUT_REVISION_CONFLICT'));
    }
    const absent = structuredClone(m); absent.authoring.none_baseline!.first_draft_confirmation = null;
    await assert.rejects(validateNoneBaseline(f.pool, f.scope, absent), code('FIRST_DRAFT_CONFIRMATION_REQUIRED'));
  } finally { await empty.close(); await f.close(); }
});

test('API and worker fail closed on a real PostgreSQL history-query timeout', { skip: !connection }, async () => {
  const f = await fixture(), blocker = await f.pool.connect();
  const timedPool = new Pool({ connectionString: connection, statement_timeout: 150 });
  const timedApp = createServer({ pool: timedPool, allowedOrigin: origin, principal: async () => ({ userId: f.owner, csrfVerified: true }) });
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM bb_material_versions WHERE id=$1 FOR UPDATE', [f.history[0]!.material_id]);
    const before = await f.state();
    for (const request of [{ method: 'GET' as const, url: `${f.base}/first-draft-exclusions` },
      { method: 'POST' as const, url: `${f.base}/input-revisions`, payload: { ...f.payload, first_draft_confirmation: confirmation(f.history) } }]) {
      const result = await timedApp.inject({ ...request, headers: { origin } });
      assert.equal(result.statusCode, 503, result.body);
      assert.equal(result.json().code, 'DATA_UNAVAILABLE');
    }
    await assert.rejects(validateNoneBaseline(timedPool, f.scope, f.manifest()), (error: any) => error.code === '57014');
    assert.deepEqual(await f.state(), before);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await timedApp.close(); await timedPool.end(); await f.close(); }
});

test('invalid historical hash data cannot issue a preview or lock an unchecked snapshot', { skip: !connection }, async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    await f.pool.query('UPDATE bb_material_versions SET sha256=$2 WHERE id=$1', [f.history[0]!.material_id, 'z'.repeat(64)]);
    for (const response of [await f.send('GET', `${f.base}/first-draft-exclusions`), await f.lock()]) {
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().code, 'DATA_UNAVAILABLE');
    }
    await assert.rejects(validateNoneBaseline(f.pool, f.scope, f.manifest()), /HISTORICAL_EXCLUSION_DATA_INVALID/);
    assert.deepEqual(await f.state(), before);
  } finally { await f.close(); }
});

test('input locking serializes with project-locked additions, deletion and version changes; old none snapshots never absorb them', { skip: !connection }, async () => {
  for (const change of ['addition', 'deletion', 'version'] as const) {
    const f = await fixture(), locker = await f.pool.connect(), writer = await f.pool.connect();
    try {
      await locker.query('BEGIN'); await locker.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE', [f.projectId]);
      const m = f.manifest();
      m.authoring.none_baseline = await lockNoneBaseline(locker, f.scope, 'generation', m.materials, m.authoring, confirmation(f.history), stamp);
      await writer.query('BEGIN');
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = writer.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE', [f.projectId]);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (await f.pool.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked === true;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'writer must be blocked by the project lock');
      await locker.query('COMMIT'); await pending;
      if (change === 'addition') await f.add(`later-${randomUUID()}`, 1, 'historical', 'b'.repeat(64), writer);
      if (change === 'version') await f.add(f.history[0]!.material_id, 2, 'historical', 'b'.repeat(64), writer);
      if (change === 'deletion') await writer.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1', [f.history[0]!.material_id]);
      await writer.query('COMMIT');
      assert.deepEqual(m.authoring.none_baseline!.excluded_historical, f.history);
      await assert.rejects(validateNoneBaseline(f.pool, f.scope, m), code('FIRST_DRAFT_EXCLUSION_STALE'));
    } finally { await locker.query('ROLLBACK'); await writer.query('ROLLBACK'); locker.release(); writer.release(); await f.close(); }
  }
});
