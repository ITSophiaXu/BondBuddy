// Synthetic documents and sessions; real PostgreSQL, HTTP auth/CSRF and transactions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, transaction, uid } from './data.js';
import { creditBalance, grantCredits } from './billing.js';
import { inputManifestHash } from './production-rule-pin.js';
import { emptyM4Draft } from './m4-workspace.js';
import type { ReviewMaterialPin, RunSupplementChange } from '@bondbuddy/contracts';

const connection = await isolatedTestDatabase(undefined, 'run-supplement-draft');
const origin = 'http://bondbuddy.test';
const ok = (r: { statusCode: number; body: string; json(): any }) => {
  assert.ok(r.statusCode >= 200 && r.statusCode < 300, r.body); return r.json();
};
async function context() {
  const pool = new Pool({ connectionString: connection }), owner = `supplement-${uid()}`;
  const app = createServer({ pool, allowedOrigin: origin, enableSyntheticQueue: true });
  const session = async (user: string) => {
    const access = uid(), csrf = uid();
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [user, `supplement_${uid().replaceAll('-', '').slice(0, 20)}`]);
    await pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`, [uid(), user, digest(access), digest(uid()), digest(csrf)]);
    return { cookie: `bb_session=${access}; bb_csrf=${csrf}`, 'x-bb-csrf': csrf, origin };
  };
  const headers = await session(owner);
  await transaction(pool, db => grantCredits(db, { owner, points: 10000, key: `synthetic-${uid()}`,
    source: 'existing_grant', expiresAt: null, actor: 'synthetic-test', reason: 'Seed nonempty ledger before free supplement preparation' }));
  const send = (method: string, url: string, payload?: unknown, customHeaders: Record<string, string> = headers) => app.inject({ method: method as any, url, payload: payload as any, headers: customHeaders });
  const project = async (kind = 'update', user = owner) => {
    const id = uid();
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name) VALUES($1,$2,'Synthetic supplements',$3,'Frozen issuer')", [id, user, kind]);
    return id;
  };
  const material = async (projectId: string, role = 'other', user = owner, id = uid(), version = 1) => {
    const upload = uid(), sha = digest(`synthetic-${id}-${version}`);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,$5,$6,now()+interval '1 hour','completed')`, [upload, user, projectId, sha, role, `users/${user}/projects/${projectId}/synthetic/uploads/${upload}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,$2,$3,$4,$5,$6,'synthetic.pdf','application/pdf',16,$7,$8,'persisted')`, [id, version, user, projectId, upload, role, sha, `users/${user}/projects/${projectId}/synthetic/materials/${upload}`]);
    return { material_id: id, material_version: version, sha256: sha } satisfies ReviewMaterialPin;
  };
  const fixture = async (flow: 'm1' | 'm1_generation' | 'm3' | 'm4' = 'm1', reviewDrift?: 'version' | 'operation' | 'origin') => {
    const task = flow === 'm4' || flow === 'm1_generation' ? 'generation' : flow === 'm3' ? 'review' : 'update';
    const projectId = await project(task);
    const sourceProject = flow === 'm4' ? await project() : projectId;
    const basePin = await material(sourceProject), runId = uid(), jobId = uid();
    const normalPin = { ...basePin, role: 'other' };
    const reviewInput = { source_material_ref: basePin, material_versions: [basePin], requirements: [{ text: 'Frozen review requirement' }], as_of: '2026-09-30' };
    let manifest: any = { draft_revision: 1, issuer_name: 'Frozen issuer', market: 'sse', offering: 'private',
      update_details: { reporting_cutoff: '2026-09-30' }, goals: ['Frozen original goal'], requirements: ['Frozen original requirement'],
      materials: [normalPin], rule_pack_version: 'frozen-rules', template_version: 'frozen-template', reference_release: 'frozen-reference' };
    let topic: string | undefined;
    if (flow === 'm3') manifest.review = { version: 'review_v1', version_number: 1, operation: 'full_review', input: reviewInput, finding_ids: [], origin: { entrypoint: 'synthetic' } };
    if (flow === 'm4') {
      topic = uid();
      await pool.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash)
        VALUES($1,$2,$3,$4,'Synthetic frozen M4',$5,$6)`, [topic, owner, projectId, sourceProject, uid(), digest('synthetic-topic')]);
      const pin = { ...basePin, source_project_id: sourceProject };
      manifest = { version: 'm4-document-input-v1', kind: 'document', project_name: 'Frozen source', topic_id: topic,
        execution_scope_project_id: sourceProject, draft_version: 1, input: { ...emptyM4Draft('underwriter'), source_material: pin,
          materials: [pin], fields: { issuer_name: 'Frozen issuer', market: 'sse' }, requirements: [{ requirement_id: 'frozen', text: 'Frozen requirement', message_id: uid(), message_version: 1 }] },
        template_material: null, market: 'sse', offering: 'private', knowledge: [{ version: 'frozen-knowledge' }], billing_task: 'm4_G01' };
    }
    const hash = inputManifestHash(manifest), pins = flow === 'm4' ? [...manifest.input.materials, manifest.input.source_material] : manifest.materials;
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version,reference_release)
      VALUES($1,1,$2,1,$3,$4,$5,'[]','frozen-rules','frozen-template','frozen-reference')`, [projectId, owner, hash, manifest, JSON.stringify(pins)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'paused','user_paused')`, [runId, owner, projectId, hash, uid(), task, digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,user_pause_requested,checkpoint)
      VALUES($1,$2,$3,$4,$5,'paused','user_paused',true,$6)`, [jobId, owner, runId, task, flow === 'm4' ? 'm4_document_v1' : 'default', { saved_work: 'original checkpoint' }]);
    if (flow === 'm3') await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
      VALUES($1,$2,$3,$4,$5,$6)`, [runId, owner, projectId, reviewDrift === 'version' ? 2 : 1,
      reviewDrift === 'operation' ? 'differential_review' : 'full_review',
      { input: reviewInput, finding_ids: [], plan: null, origin: reviewDrift === 'origin' ? { entrypoint: 'different' } : manifest.review.origin }]);
    if (flow === 'm4') await pool.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)', [runId, owner, topic, manifest, hash]);
    const url = `/api/v1/runs/${runId}/supplement-draft`;
    const request = (changes: RunSupplementChange[] = [], expected_revision = 0) => ({ request_id: uid(), expected_revision, base_input_revision: 1, base_input_hash: hash, changes });
    return { flow, projectId, sourceProject, basePin, runId, jobId, topic, manifest, hash, url, request };
  };
  const evidence = async (f: Awaited<ReturnType<typeof fixture>>) => ({
    run: (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [f.runId])).rows,
    job: (await pool.query('SELECT * FROM bb_jobs WHERE run_id=$1', [f.runId])).rows,
    input: (await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 ORDER BY revision', [f.projectId])).rows,
    project: (await pool.query('SELECT * FROM bb_projects WHERE id=$1', [f.projectId])).rows,
    reviewDraft: (await pool.query('SELECT * FROM bb_review_drafts WHERE project_id=$1', [f.projectId])).rows,
    review: (await pool.query('SELECT * FROM bb_review_executions WHERE run_id=$1', [f.runId])).rows,
    m4Draft: (await pool.query('SELECT * FROM bb_m4_drafts WHERE topic_id=$1', [f.topic ?? ''])).rows,
    m4: (await pool.query('SELECT * FROM bb_m4_executions WHERE run_id=$1', [f.runId])).rows,
    attempts: (await pool.query('SELECT * FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY id', [f.jobId])).rows,
    events: (await pool.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq', [f.runId])).rows,
    creditEvents: (await pool.query('SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id', [owner])).rows,
    reservations: (await pool.query('SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id', [owner])).rows,
    lots: (await pool.query('SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id', [owner])).rows,
    creditAccount: (await pool.query('SELECT * FROM bb_credit_accounts WHERE owner_user_id=$1', [owner])).rows,
    balance: await creditBalance(pool, owner),
  });
  return { pool, app, owner, headers, send, session, project, material, fixture, evidence, close: async () => { await app.close(); await pool.end(); } };
}

test('supplement preparation persists on the original run without adopting, executing or charging', { skip: !connection }, async t => {
  const c = await context();
  try {
    const f = await c.fixture(), added = await c.material(f.projectId), replacement = await c.material(f.projectId, 'other', c.owner, f.basePin.material_id, 2);
    await c.pool.query("UPDATE bb_runs SET state='queued',stage='queued' WHERE id=$1", [f.runId]);
    await c.pool.query("UPDATE bb_jobs SET state='queued',stage='queued',user_pause_requested=false WHERE id=$1", [f.jobId]);
    assert.equal(ok(await c.send('GET', f.url)).can_save, false);
    ok(await c.send('POST', `/api/v1/runs/${f.runId}/pause`, { reason: 'synthetic preparation' }));
    const initial = ok(await c.send('GET', f.url));
    assert.equal(initial.revision, 0); assert.equal(initial.can_save, true); assert.equal(initial.adopted, false);
    assert.deepEqual(initial.base_materials.map((m: any) => m.material_id), [f.basePin.material_id]);
    // Unrelated current project edits must not become the preparation base.
    await c.pool.query("UPDATE bb_projects SET draft_revision=99,issuer_name='Later draft issuer',update_details=$2 WHERE id=$1", [f.projectId, { reporting_cutoff: '2027-12-31' }]);
    const before = await c.evidence(f), changes = [{ material: replacement, replaces: f.basePin }, { material: added, replaces: null }];
    assert.deepEqual(before.balance, { available: 10000, frozen: 0 });
    assert.equal(before.creditEvents.length, 1, 'preserve an existing nonempty ledger rather than only comparing empty tables');
    const body = f.request(changes), saved = ok(await c.send('PUT', f.url, body));
    assert.equal(saved.revision, 1); assert.equal(saved.latest_revision, 1); assert.equal(saved.base_input_hash, f.hash);
    assert.deepEqual(saved.changes, changes); assert.equal(saved.adopted, false);
    assert.deepEqual(saved.result_materials.map((m: any) => m.material_version), [2, 1]);
    assert.deepEqual(await c.evidence(f), before, 'only preparation receipt and explicit outbox may change');
    const outbox = (await c.pool.query("SELECT * FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.supplement_draft_saved'", [f.runId])).rows;
    assert.equal(outbox.length, 1); assert.equal(outbox[0].aggregate_type, 'run_supplement_draft'); assert.equal(outbox[0].payload.adopted, false);
    await t.test('saved revision survives reload and a same-request retry', async () => {
      assert.deepEqual(ok(await c.send('GET', f.url)), saved);
      assert.deepEqual(ok(await c.send('PUT', f.url, body)), saved);
      assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1', [f.runId])).rows[0].n, 1);
      assert.equal((await c.pool.query('SELECT bb_material_bytes_pinned($1,$2,$3,$4) pinned', [c.owner, f.projectId, added.material_id, added.material_version])).rows[0].pinned, false,
        'a draft-only supplement does not become a material retention pin');
    });
    await t.test('old request receipt survives a later save and explicit resume', async () => {
      const next = ok(await c.send('PUT', f.url, f.request([], 1))); assert.equal(next.revision, 2);
      const old = ok(await c.send('GET', `${f.url}?request_id=${body.request_id}`));
      assert.equal(old.revision, 1); assert.equal(old.latest_revision, 2); assert.deepEqual(old.changes, changes);
      ok(await c.send('POST', `/api/v1/runs/${f.runId}/resume`, { reason: 'synthetic' }));
      const replay = ok(await c.send('PUT', f.url, body));
      assert.equal(replay.revision, 1); assert.equal(replay.latest_revision, 2); assert.equal(replay.can_save, false); assert.deepEqual(replay.changes, changes);
      assert.equal((await c.send('PUT', f.url, { ...body, changes: [] })).statusCode, 409);
      assert.equal((await c.send('GET', `${f.url}?request_id=${uid()}`)).statusCode, 404);
    });
  } finally { await c.close(); }
});

test('supplement saves serialize CAS, idempotency and uncertain receipt recovery on the run lock', { skip: !connection }, async t => {
  const c = await context();
  try {
    const f = await c.fixture(), first = f.request(), second = f.request();
    const concurrent = await Promise.all([c.send('PUT', f.url, first), c.send('PUT', f.url, second)]);
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1', [f.runId])).rows[0].n, 1);
    assert.equal((await c.send('PUT', f.url, f.request())).statusCode, 409);
    await t.test('same request saves exactly one revision under concurrent retry', async () => {
      const next = f.request([], 1), retries = await Promise.all([c.send('PUT', f.url, next), c.send('PUT', f.url, next)]);
      assert.equal(ok(retries[0]).revision, 2); assert.deepEqual(ok(retries[1]), ok(retries[0]));
    });
    await t.test('request receipt GET waits for a committing PUT holding the run lock', async () => {
      const lock = await c.pool.connect(), key = 1182601;
      await lock.query('SELECT pg_advisory_lock($1)', [key]);
      await c.pool.query(`CREATE FUNCTION bb_test_supplement_receipt_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='run.supplement_draft_saved' THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END; $$`);
      await c.pool.query('CREATE TRIGGER bb_test_supplement_receipt_wait BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_test_supplement_receipt_wait()');
      const pending = f.request([], 2), put = c.send('PUT', f.url, pending);
      try {
        // Observe PostgreSQL's actual blocked advisory statement, without timing
        // assumptions about when Fastify reached its transaction.
        let waiting = false;
        for (let n = 0; n < 200 && !waiting; n++) {
          waiting = !!(await lock.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted`, [key])).rowCount;
          if (!waiting) await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(waiting, true, 'PUT reached its atomic outbox while holding run lock');
        const receipt = c.send('GET', `${f.url}?request_id=${pending.request_id}`);
        await lock.query('SELECT pg_advisory_unlock($1)', [key]);
        assert.equal(ok(await put).revision, 3); assert.equal(ok(await receipt).revision, 3);
      } finally {
        await lock.query('SELECT pg_advisory_unlock($1)', [key]); lock.release();
        await c.pool.query('DROP TRIGGER bb_test_supplement_receipt_wait ON bb_outbox');
        await c.pool.query('DROP FUNCTION bb_test_supplement_receipt_wait()');
      }
    });
  } finally { await c.close(); }
});

test('supplement HTTP endpoints enforce real session/CSRF, owner isolation and exact material pins', { skip: !connection }, async t => {
  const c = await context();
  try {
    const f = await c.fixture(), valid = await c.material(f.projectId), roleMismatch = await c.material(f.projectId, 'audit');
    const foreign = `foreign-${uid()}`, foreignHeaders = await c.session(foreign), foreignProject = await c.project('update', foreign);
    const foreignPin = await c.material(foreignProject, 'other', foreign), otherProject = await c.project(), otherPin = await c.material(otherProject);
    await t.test('unauthenticated, CSRF and cross-owner access are refused', async () => {
      assert.equal((await c.app.inject({ method: 'GET', url: f.url })).statusCode, 401);
      assert.equal((await c.send('PUT', f.url, f.request(), { ...c.headers, 'x-bb-csrf': '' })).statusCode, 403);
      assert.equal((await c.send('GET', f.url, undefined, foreignHeaders)).statusCode, 404);
      assert.equal((await c.send('PUT', f.url, f.request(), foreignHeaders)).statusCode, 404);
    });
    for (const [name, changes] of [
      ['wrong hash', [{ material: { ...valid, sha256: 'e'.repeat(64) }, replaces: null }]],
      ['wrong owner', [{ material: foreignPin, replaces: null }]],
      ['wrong project', [{ material: otherPin, replaces: null }]],
      ['duplicate additions', [{ material: valid, replaces: null }, { material: valid, replaces: null }]],
      ['unknown replacement', [{ material: valid, replaces: otherPin }]],
      ['duplicate replacements', [{ material: valid, replaces: f.basePin }, { material: roleMismatch, replaces: f.basePin }]],
      ['different role', [{ material: roleMismatch, replaces: f.basePin }]],
    ] as Array<[string, RunSupplementChange[]]>) await t.test(name, async () => {
      const result = await c.send('PUT', f.url, f.request(changes)); assert.ok([409, 422].includes(result.statusCode), result.body);
    });
    await c.pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1', [valid.material_id]);
    assert.equal((await c.send('PUT', f.url, f.request([{ material: valid, replaces: null }]))).statusCode, 409);
    assert.equal((await c.send('PUT', f.url, { ...f.request(), base_input_hash: 'a'.repeat(64) })).statusCode, 409);
    assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1', [f.runId])).rows[0].n, 0);
  } finally { await c.close(); }
});

test('supplement preparation requires a durable manual pause and reconciled provider calls', { skip: !connection }, async t => {
  const c = await context();
  try {
    for (const scenario of ['running', 'saving', 'paused_lease', 'automatic_pause', 'pending_provider', 'completed_unknown', 'failed_unknown', 'terminal', 'archived', 'unsupported'] as const) await t.test(scenario, async () => {
      const f = await c.fixture();
      if (scenario === 'running' || scenario === 'saving') {
        await c.pool.query("UPDATE bb_runs SET state='running' WHERE id=$1", [f.runId]);
        await c.pool.query("UPDATE bb_jobs SET state='running',user_pause_requested=$2,lease_token='synthetic-lease',lease_until=now()+interval '1 hour' WHERE id=$1", [f.jobId, scenario === 'saving']);
      } else if (scenario === 'paused_lease') await c.pool.query("UPDATE bb_jobs SET lease_token='synthetic-stale-lease',lease_until=now()-interval '1 hour' WHERE id=$1", [f.jobId]);
      else if (scenario === 'automatic_pause') await c.pool.query('UPDATE bb_jobs SET user_pause_requested=false WHERE id=$1', [f.jobId]);
      else if (scenario === 'unsupported') await c.pool.query("UPDATE bb_runs SET task_kind='qa' WHERE id=$1", [f.runId]);
      else if (scenario === 'terminal') {
        await c.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [f.runId]);
        await c.pool.query("UPDATE bb_jobs SET state='cancelled' WHERE id=$1", [f.jobId]);
      } else if (scenario === 'archived') await c.pool.query('UPDATE bb_projects SET archived_at=now() WHERE id=$1', [f.projectId]);
      else await c.pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status)
        VALUES($1,$2,$3,$4,1,$5)`, [uid(), c.owner, f.jobId, uid(), scenario === 'pending_provider' ? 'pending_reconcile' : scenario === 'completed_unknown' ? 'completed' : 'failed']);
      const before = await c.evidence(f), read = ok(await c.send('GET', f.url));
      assert.equal(read.can_save, false); assert.ok(read.blocked_reason); assert.equal(read.adopted, false);
      assert.equal((await c.send('PUT', f.url, f.request())).statusCode, 409);
      assert.deepEqual(await c.evidence(f), before);
    });
    await t.test('manual pause while credits are exhausted remains usable without changing credits', async () => {
      const f = await c.fixture();
      await c.pool.query("UPDATE bb_runs SET stage='credits_exhausted' WHERE id=$1", [f.runId]);
      await c.pool.query("UPDATE bb_jobs SET stage='credits_exhausted',credit_pause_requested=true WHERE id=$1", [f.jobId]);
      const before = await c.evidence(f); assert.equal(ok(await c.send('PUT', f.url, f.request())).can_save, true);
      assert.deepEqual(await c.evidence(f), before);
    });
    await t.test('deleted project is owner-safe 404', async () => {
      const f = await c.fixture(); await c.pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [f.projectId]);
      assert.equal((await c.send('GET', f.url)).statusCode, 404); assert.equal((await c.send('PUT', f.url, f.request())).statusCode, 404);
    });
    await t.test('test-channel metadata obeys the deployment read gate', async () => {
      const f = await c.fixture();
      // A test-channel run is inserted under its immutable channel rather than
      // changing the existing production row.
      const id = uid(), grant = uid();
      await c.pool.query(`INSERT INTO bb_non_production_test_grants(grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
        VALUES($1,$2,$3,1,$4,$5,$5,$5,'synthetic','isolated read gate test',now()+interval '1 hour')`, [grant, c.owner, f.projectId, f.hash, digest('synthetic grant')]);
      await c.pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,channel,test_grant_id)
        VALUES($1,$2,$3,1,$4,$5,'qa',$6,'paused','non_production_test',$7)`, [id, c.owner, f.projectId, f.hash, uid(), digest(uid()), grant]);
      const previousTier = process.env.BB_DEPLOYMENT_TIER, previousGate = process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
      try {
        process.env.BB_DEPLOYMENT_TIER = 'production'; delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
        assert.equal((await c.send('GET', `/api/v1/runs/${id}/supplement-draft`)).statusCode, 404);
      } finally {
        if (previousTier === undefined) delete process.env.BB_DEPLOYMENT_TIER; else process.env.BB_DEPLOYMENT_TIER = previousTier;
        if (previousGate === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL; else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = previousGate;
      }
    });
  } finally { await c.close(); }
});

test('supplement base and business snapshots remain frozen across M3 and cross-project M4', { skip: !connection }, async t => {
  const c = await context();
  try {
    for (const flow of ['m1_generation', 'm3', 'm4'] as const) await t.test(flow, async () => {
      const f = await c.fixture(flow), added = await c.material(f.projectId);
      if (flow === 'm3') await c.pool.query('INSERT INTO bb_review_drafts(owner_user_id,project_id,version,input) VALUES($1,$2,99,$3)', [c.owner, f.projectId, { requirements: ['Unrelated current review draft'], material_versions: [] }]);
      else if (flow === 'm4') await c.pool.query('INSERT INTO bb_m4_drafts(owner_user_id,topic_id,document_type,version,input,sha256) VALUES($1,$2,$3,99,$4,$5)', [c.owner, f.topic, 'underwriter', emptyM4Draft('underwriter'), inputManifestHash(emptyM4Draft('underwriter'))]);
      const before = await c.evidence(f), read = ok(await c.send('GET', f.url));
      assert.equal(read.base_materials.length, 1); assert.equal(read.base_materials[0].source_project_id, f.sourceProject);
      const saved = ok(await c.send('PUT', f.url, f.request([{ material: added, replaces: f.basePin }])));
      assert.equal(saved.result_materials[0].source_project_id, f.projectId); assert.equal(saved.adopted, false);
      assert.deepEqual(await c.evidence(f), before, 'original snapshot and current editable draft are both preserved');
    });
    for (const drift of ['version', 'operation', 'origin'] as const) await t.test(`inconsistent M3 ${drift} is unavailable`, async () => {
      const f = await c.fixture('m3', drift), before = await c.evidence(f);
      assert.equal((await c.send('GET', f.url)).statusCode, 503);
      assert.equal((await c.send('PUT', f.url, f.request())).statusCode, 503);
      assert.deepEqual(await c.evidence(f), before);
    });
    await t.test('outbox failure rolls back the entire save and same request can retry', async () => {
      const f = await c.fixture(), before = await c.evidence(f), body = f.request();
      await c.pool.query(`CREATE FUNCTION bb_test_supplement_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='run.supplement_draft_saved' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END; $$`);
      await c.pool.query('CREATE TRIGGER bb_test_supplement_outbox_fail BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_test_supplement_outbox_fail()');
      try {
        assert.equal((await c.send('PUT', f.url, body)).statusCode, 500);
        assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1', [f.runId])).rows[0].n, 0);
        assert.deepEqual(await c.evidence(f), before);
      } finally {
        await c.pool.query('DROP TRIGGER bb_test_supplement_outbox_fail ON bb_outbox'); await c.pool.query('DROP FUNCTION bb_test_supplement_outbox_fail()');
      }
      assert.equal(ok(await c.send('PUT', f.url, body)).revision, 1);
      await assert.rejects(c.pool.query("UPDATE bb_run_supplement_drafts SET changes='[]' WHERE run_id=$1", [f.runId]), (error: unknown) => (error as { code?: string }).code === '23514');
    });
  } finally { await c.close(); }
});
