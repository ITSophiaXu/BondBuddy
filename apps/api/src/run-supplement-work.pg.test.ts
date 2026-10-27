// Synthetic private bytes; real PostgreSQL, HTTP sessions/CSRF and durable call history.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { creditBalance, grantCredits } from './billing.js';
import { inputManifestHash } from './production-rule-pin.js';
import { saveSnapshotRef } from './observability.js';
import { checkpointStage, claim, pauseAtCheckpoint, recordPotentialCall } from './queue.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import { readCapturedSupplementResult } from './run-supplement-work.js';

const connection = await isolatedTestDatabase(undefined, 'run-supplement-work');
const origin = 'http://bondbuddy.test';
const resultSchema = 'synthetic-supplement-work-v1';
const ok = (response: { statusCode: number; body: string; json(): any }) => {
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  return response.json();
};
const conflict = (error: unknown) => error instanceof Problem && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT';

async function context() {
  const pool = new Pool({ connectionString: connection }), owner = `saved-work-${uid()}`;
  const objects = new Map<string, Buffer>(), boundedReads: Array<{ key: string; limit: number }> = [];
  let writes = 0, deletes = 0;
  const blobs: PrivateBlobs = {
    put: async (key, bytes) => { writes++; objects.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes = objects.get(key); assert.ok(bytes, `Missing synthetic object ${key}`); return Buffer.from(bytes); },
    getIfExists: async key => { const bytes = objects.get(key); return bytes ? Buffer.from(bytes) : null; },
    getIfExistsBounded: async (key, limit) => {
      boundedReads.push({ key, limit });
      const bytes = objects.get(key);
      if (bytes && bytes.length > limit) throw new Error('Synthetic bounded read refused');
      return bytes ? Buffer.from(bytes) : null;
    },
    exists: async key => objects.has(key),
    delete: async key => { deletes++; objects.delete(key); },
  };
  const app = createServer({ pool, blobs, allowedOrigin: origin, enableSyntheticQueue: true });
  const session = async (user: string) => {
    const access = uid(), csrf = uid();
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [user, `saved_work_${uid().replaceAll('-', '').slice(0, 20)}`]);
    await pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`, [uid(), user, digest(access), digest(uid()), digest(csrf)]);
    return { cookie: `bb_session=${access}; bb_csrf=${csrf}`, 'x-bb-csrf': csrf, origin };
  };
  const headers = await session(owner);
  await transaction(pool, db => grantCredits(db, { owner, points: 10000, key: `synthetic-${uid()}`,
    source: 'existing_grant', expiresAt: null, actor: 'synthetic-test', reason: 'Seed ledger before free saved-work preparation' }));
  const send = (method: string, url: string, payload?: unknown, customHeaders: Record<string, string> = headers) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: customHeaders });

  const fixture = async () => {
    const projectId = uid(), runId = uid(), jobId = uid();
    const manifest = { draft_revision: 1, issuer_name: 'Synthetic frozen issuer', market: 'sse', offering: 'private',
      update_details: { reporting_cutoff: '2026-09-30' }, goals: ['Frozen original goal'], requirements: ['Frozen original requirement'],
      materials: [], rule_pack_version: 'frozen-rules', template_version: 'frozen-template', reference_release: 'frozen-reference' };
    const hash = inputManifestHash(manifest);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name) VALUES($1,$2,'Synthetic saved work','update','Synthetic frozen issuer')", [projectId, owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,
      requirement_message_ids,rule_pack_version,template_version,reference_release)
      VALUES($1,1,$2,1,$3,$4,'[]','[]','frozen-rules','frozen-template','frozen-reference')`, [projectId, owner, hash, manifest]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued')`, [runId, owner, projectId, hash, uid(), digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,'update','default','queued','queued')`, [jobId, owner, runId]);
    const lease = await claim(pool, 300, { runKinds: ['update'] });
    assert.ok(lease); assert.equal(lease.runId, runId); assert.equal(lease.jobId, jobId);
    const promptBytes = Buffer.from(JSON.stringify({ version: 'synthetic-model-request-v1', input_hash: hash, message: 'Synthetic frozen prompt' }));
    const promptKey = `users/${owner}/projects/${projectId}/snapshots/${uid()}`;
    await blobs.put(promptKey, promptBytes, 'application/json');
    const promptId = await saveSnapshotRef(pool, { owner, projectId, runId, kind: 'model_request', version: 1,
      objectKey: promptKey, sha256: digest(promptBytes), redactionVersion: 'synthetic_v1', inputRevision: 1, inputHash: hash, blobs });
    await checkpointStage(pool, lease, 'synthetic_prompt', { snapshot_id: promptId });
    const value = { version: resultSchema, input_hash: hash, marker: uid(), text: 'Private unfinished model work' };
    const validate = (candidate: unknown) => !!candidate && typeof candidate === 'object'
      && (candidate as typeof value).version === resultSchema && (candidate as typeof value).input_hash === hash
      && (candidate as typeof value).marker === value.marker && (candidate as typeof value).text === value.text;
    const intent: ProviderCallIntent = { owner_user_id: owner, project_id: projectId, run_id: runId, trace_id: runId,
      job_id: jobId, logical_call_id: 'synthetic-saved-work', call_id: uid(), attempt_no: 1,
      model_id: 'synthetic-model', model_config_version: 'synthetic-v1', prompt_snapshot_ref: promptId };
    await recordPotentialCall(pool, lease, intent.logical_call_id, intent.attempt_no,
      { callId: intent.call_id, modelId: intent.model_id, promptSnapshotId: promptId });
    const bytes = Buffer.from(JSON.stringify(value));
    const reference = await persistProviderResultObject({ blobs, intent, bytes, resultSchemaVersion: resultSchema, validate });
    const observed = await recordProviderCallObservation(pool, blobs, { ...intent, ...reference,
      provider_request_id: null, finish_reason: 'stop', outcome: 'completed', error_code: null,
      usage: { status: 'measured', input_tokens: 13, cached_input_tokens: 0, output_tokens: 7, reasoning_tokens: 0, total_tokens: 20 },
    }, validate, { lease, source: 'provider' });
    assert.equal(observed.attempt_status, 'completed');
    const result = (await pool.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1', [intent.call_id])).rows[0];
    assert.ok(result); assert.equal(result.result_sha256.trim(), digest(bytes));
    await checkpointStage(pool, lease, 'synthetic_finished_work', { result_id: result.id });
    ok(await send('POST', `/api/v1/runs/${runId}/pause`, { reason: 'Synthetic supplement boundary' }));
    assert.equal(await pauseAtCheckpoint(pool, lease), true);
    const checkpoint = (await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [jobId])).rows[0].checkpoint;
    const url = `/api/v1/runs/${runId}/supplement-draft`;
    const request = (expected_revision = 0) => ({ request_id: uid(), expected_revision, base_input_revision: 1, base_input_hash: hash, changes: [] });
    return { projectId, runId, jobId, hash, intent, promptId, promptKey, result, value, bytes, reference, validate, checkpoint, url, request };
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const read = (f: Fixture, overrides: Partial<Parameters<typeof readCapturedSupplementResult>[0]> = {}) =>
    readCapturedSupplementResult({ db: pool, blobs, owner, projectId: f.projectId, runId: f.runId,
      revision: 1, resultId: f.result.id, resultSchemaVersion: resultSchema, validate: f.validate, ...overrides });
  const history = async (f: Fixture) => {
    const evidence: Record<string, unknown> = {};
    for (const table of ['bb_model_call_attempts', 'bb_model_call_execution_bindings', 'bb_provider_result_refs',
      'bb_provider_call_observations', 'bb_usage_observations', 'bb_snapshot_refs', 'bb_credit_events',
      'bb_credit_reservations', 'bb_credit_lots', 'bb_credit_accounts']) {
      evidence[table] = (await pool.query(`SELECT * FROM ${table} WHERE owner_user_id=$1 ORDER BY 1`, [owner])).rows;
    }
    evidence.usage = (await pool.query(`SELECT u.* FROM bb_call_usage u JOIN bb_model_call_attempts a ON a.id=u.attempt_id
      WHERE a.owner_user_id=$1 ORDER BY a.id`, [owner])).rows;
    evidence.run = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows;
    evidence.job = (await pool.query('SELECT * FROM bb_jobs WHERE id=$1', [f.jobId])).rows;
    evidence.input = (await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 ORDER BY revision', [f.projectId])).rows;
    evidence.events = (await pool.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq', [f.runId])).rows;
    evidence.balance = await creditBalance(pool, owner);
    return evidence;
  };
  const captures = async (f: Fixture) => ({
    receipts: (await pool.query('SELECT * FROM bb_run_supplement_drafts WHERE run_id=$1 ORDER BY revision', [f.runId])).rows,
    work: (await pool.query('SELECT * FROM bb_run_supplement_saved_work WHERE run_id=$1 ORDER BY supplement_revision', [f.runId])).rows,
    results: (await pool.query('SELECT * FROM bb_run_supplement_saved_results WHERE run_id=$1 ORDER BY supplement_revision,attempt_id', [f.runId])).rows,
    outbox: (await pool.query("SELECT * FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.supplement_draft_saved' ORDER BY id", [f.runId])).rows,
  });
  const storageEvidence = () => ({ writes, deletes, objects: [...objects].map(([key, bytes]) => [key, digest(bytes)]).sort() });
  return { pool, app, owner, headers, objects, blobs, boundedReads, session, send, fixture, read, history, captures, storageEvidence,
    close: async () => { await app.close(); await pool.end(); } };
}

test('safe HTTP supplement capture freezes exact work independently for each receipt and replays without charges', { skip: !connection }, async () => {
  const c = await context();
  try {
    const f = await c.fixture(), before = await c.history(f), request = f.request();
    const saved = ok(await c.send('PUT', f.url, request));
    assert.deepEqual(saved.saved_work, { status: 'captured', stage_count: 2, result_count: 1 });
    assert.equal(saved.adopted, false);
    const first = await c.captures(f);
    assert.equal(first.work.length, 1); assert.equal(first.results.length, 1);
    assert.equal(first.work[0].execution_version, 1); assert.equal(first.work[0].input_revision, 1);
    assert.equal(first.work[0].input_hash.trim(), f.hash); assert.equal(first.work[0].job_id, f.jobId);
    assert.deepEqual(first.work[0].source_checkpoint, f.checkpoint);
    assert.equal(first.work[0].checkpoint_hash.trim(), inputManifestHash(f.checkpoint));
    assert.equal(first.results[0].attempt_id, f.intent.call_id); assert.equal(first.results[0].result_id, f.result.id);
    assert.deepEqual(await c.history(f), before);
    assert.deepEqual(ok(await c.send('GET', f.url)), saved);
    assert.deepEqual(ok(await c.send('PUT', f.url, request)), saved);
    assert.deepEqual(await c.captures(f), first);
    const publicSummary = JSON.stringify(saved.saved_work);
    for (const secret of [f.result.id, f.reference.result_ref, f.value.text, f.promptKey]) assert.equal(publicSummary.includes(secret), false);
    assert.equal((await c.send('GET', `/api/v1/artifacts/${f.result.id}`)).statusCode, 404);
    assert.deepEqual(await c.read(f), f.value);
    assert.deepEqual(c.boundedReads.at(-1), { key: f.reference.result_ref, limit: f.bytes.length });

    const nextCheckpoint = { ...f.checkpoint, stages: { ...f.checkpoint.stages, synthetic_later_boundary: { saved: true } } };
    await c.pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1', [f.jobId, nextCheckpoint]);
    const laterBoundary = await c.history(f);
    assert.deepEqual(ok(await c.send('GET', `${f.url}?request_id=${request.request_id}`)).saved_work,
      { status: 'stale_boundary', stage_count: 2, result_count: 1 });
    const replay = ok(await c.send('PUT', f.url, request));
    assert.equal(replay.revision, 1); assert.equal(replay.saved_work.status, 'stale_boundary');
    assert.deepEqual(await c.captures(f), first, 'an old request does not recapture a later checkpoint');
    const second = ok(await c.send('PUT', f.url, f.request(1)));
    assert.equal(second.revision, 2);
    assert.deepEqual(second.saved_work, { status: 'captured', stage_count: 3, result_count: 1 });
    const both = await c.captures(f);
    assert.equal(both.work.length, 2); assert.equal(both.results.length, 2);
    assert.deepEqual(both.work[0], first.work[0]); assert.deepEqual(both.work[1].source_checkpoint, nextCheckpoint);
    assert.deepEqual(both.results.map(row => row.result_id), [f.result.id, f.result.id]);
    assert.deepEqual(await c.history(f), laterBoundary);
    assert.deepEqual(await c.read(f), f.value, 'frozen old work remains readable when the current checkpoint changes');
    await assert.rejects(c.pool.query('UPDATE bb_run_supplement_saved_work SET checkpoint_hash=$2 WHERE run_id=$1', [f.runId, digest('rewrite')]),
      (error: any) => error.code === '23514');
    await assert.rejects(c.pool.query('DELETE FROM bb_run_supplement_saved_results WHERE run_id=$1', [f.runId]),
      (error: any) => error.code === '23514');
  } finally { await c.close(); }
});

test('invalid, duplicate and missing checkpoint references reject capture atomically without changing call or billing history', { skip: !connection }, async t => {
  const c = await context();
  try {
    const f = await c.fixture(), entry = f.checkpoint.provider_results[0];
    for (const [name, checkpoint] of [
      ['missing completed result', { ...f.checkpoint, provider_results: [] }],
      ['duplicate result', { ...f.checkpoint, provider_results: [entry, entry] }],
      ['wrong result id', { ...f.checkpoint, provider_results: [{ ...entry, result_id: uid() }] }],
      ['wrong result hash', { ...f.checkpoint, provider_results: [{ ...entry, result_sha256: digest('wrong bytes') }] }],
      ['wrong attempt', { ...f.checkpoint, provider_results: [{ ...entry, call_id: uid() }] }],
      ['wrong schema', { ...f.checkpoint, provider_results: [{ ...entry, result_schema_version: 'different-schema-v1' }] }],
      ['unmatched extra reference', { ...f.checkpoint, provider_results: [entry, { ...entry, logical_call_id: 'foreign-call' }] }],
      ['malformed stages', { ...f.checkpoint, stages: [] }],
    ] as Array<[string, unknown]>) await t.test(name, async () => {
      await c.pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1', [f.jobId, checkpoint]);
      const before = await c.history(f), captures = await c.captures(f), storage = c.storageEvidence();
      assert.equal((await c.send('PUT', f.url, f.request())).statusCode, 409);
      assert.deepEqual(await c.captures(f), captures, 'draft, capture rows and outbox roll back together');
      assert.deepEqual(await c.history(f), before);
      assert.deepEqual(c.storageEvidence(), storage);
    });
    await c.pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1', [f.jobId, f.checkpoint]);
    assert.equal(ok(await c.send('PUT', f.url, f.request())).revision, 1, 'failed captures consume no receipt revision');
  } finally { await c.close(); }
});

test('captured-result reads enforce exact private bytes, schema and ownership without reconciliation or writes', { skip: !connection }, async t => {
  const c = await context();
  try {
    const f = await c.fixture(); ok(await c.send('PUT', f.url, f.request()));
    const other = await c.fixture(); ok(await c.send('PUT', other.url, other.request()));
    const foreign = `foreign-${uid()}`, foreignHeaders = await c.session(foreign);
    assert.equal((await c.send('GET', f.url, undefined, foreignHeaders)).statusCode, 404);
    assert.equal((await c.send('PUT', f.url, f.request(1), { ...c.headers, 'x-bb-csrf': '' })).statusCode, 403);
    assert.equal((await c.app.inject({ method: 'GET', url: f.url })).statusCode, 401);
    const unchangedRead = async (operation: () => Promise<unknown>, rejects = true, target = f) => {
      const before = await c.history(target), captures = await c.captures(target), storage = c.storageEvidence();
      if (rejects) await assert.rejects(operation(), conflict); else assert.deepEqual(await operation(), f.value);
      assert.deepEqual(await c.history(target), before, 'reading cannot alter attempts, reconciliation, run or billing');
      assert.deepEqual(await c.captures(target), captures);
      assert.deepEqual(c.storageEvidence(), storage);
    };
    await t.test('an async exact schema validator reads the original value', () => unchangedRead(() => c.read(f, {
      validate: async value => { await Promise.resolve(); return f.validate(value); },
    }), false));
    await t.test('a schema rejection cannot trigger another call', () => unchangedRead(() => c.read(f, { validate: async () => false })));
    await t.test('a different expected schema never reaches Blob reads', async () => {
      const reads = c.boundedReads.length;
      await unchangedRead(() => c.read(f, { resultSchemaVersion: 'different-expected-schema-v1' }));
      assert.equal(c.boundedReads.length, reads);
    });
    await t.test('foreign owner and uncaptured result references never reach Blob reads', async () => {
      const reads = c.boundedReads.length;
      await unchangedRead(() => c.read(f, { owner: foreign }));
      await unchangedRead(() => c.read(f, { projectId: other.projectId }));
      await unchangedRead(() => c.read(f, { resultId: other.result.id }));
      await unchangedRead(() => c.read(f, { revision: 99 }));
      assert.equal(c.boundedReads.length, reads);
    });
    await t.test('same-size corruption, oversized bytes and missing Blob remain read-only failures', async () => {
      const original = Buffer.from(f.bytes), corrupted = Buffer.from(original); corrupted[corrupted.length - 2] ^= 1;
      c.objects.set(f.reference.result_ref, corrupted);
      await unchangedRead(() => c.read(f));
      c.objects.set(f.reference.result_ref, Buffer.concat([original, Buffer.from('extra')]));
      await unchangedRead(() => c.read(f));
      c.objects.delete(f.reference.result_ref);
      await unchangedRead(() => c.read(f));
      c.objects.set(f.reference.result_ref, original);
      await unchangedRead(() => c.read(f), false);
    });
    for (const kind of ['provider_result', 'prompt_snapshot'] as const) await t.test(`${kind} purge receipt denies existing bytes`, async () => {
      const target = kind === 'provider_result' ? f : other;
      await c.pool.query(`INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version)
        VALUES($1,$2,$3,$4,$5,'retention_expired','synthetic-v1')`,
      [uid(), c.owner, kind, kind === 'provider_result' ? target.result.id : target.promptId,
        kind === 'provider_result' ? target.reference.result_ref : target.promptKey]);
      assert.equal(c.objects.has(target.reference.result_ref), true, 'a retained test Blob cannot bypass its purge receipt');
      const reads = c.boundedReads.length;
      await unchangedRead(() => c.read(target), true, target);
      assert.equal(c.boundedReads.length, reads);
    });
  } finally { await c.close(); }
});

test('legacy supplement receipts report not_captured and grant no access to later durable work', { skip: !connection }, async () => {
  const c = await context();
  try {
    const f = await c.fixture(), request = f.request();
    await c.pool.query(`INSERT INTO bb_run_supplement_drafts(owner_user_id,project_id,run_id,revision,request_id,request_hash,
      base_input_revision,base_input_hash,changes) VALUES($1,$2,$3,1,$4,$5,1,$6,'[]')`,
    [c.owner, f.projectId, f.runId, request.request_id, inputManifestHash(request), f.hash]);
    const before = await c.history(f), capture = await c.captures(f), storage = c.storageEvidence();
    const legacy = ok(await c.send('GET', f.url));
    assert.deepEqual(legacy.saved_work, { status: 'not_captured', stage_count: 0, result_count: 0 });
    assert.deepEqual(ok(await c.send('PUT', f.url, request)).saved_work, legacy.saved_work,
      'replaying a legacy receipt cannot silently attach the current checkpoint');
    await assert.rejects(c.read(f), conflict);
    assert.deepEqual(await c.captures(f), capture); assert.deepEqual(await c.history(f), before);
    assert.deepEqual(c.storageEvidence(), storage);
  } finally { await c.close(); }
});
