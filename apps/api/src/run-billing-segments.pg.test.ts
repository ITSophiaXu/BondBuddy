// Real reserve/queue/delivery and append-only credits in a private PostgreSQL
// clone. Synthetic Word/material bytes only; no provider or payment is called.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { INITIAL_FIXED_PRICES, emptyUpdateDetails } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { creditBalance, grantCredits, publishPrices } from './billing.js';
import { auditCredits, correctSettlement } from './billing-ops.js';
import { debitAuthoringCredits, DYNAMIC_AUTHORING_POLICY } from './authoring-credit-debit.js';
import { readAuthoringProgress, syncAuthoringProgress } from './authoring-progress.js';
import { readRunBillingSegment } from './run-billing-segment.js';
import { claim, renew, checkpointStage, pauseAtCheckpoint, resumePausedRun, recordAuthoringActivity,
  recordReviewAction, finish, promoteWordArtifact, type Lease } from './queue.js';
import { registerM4Artifacts, emptyM4Draft } from './m4-workspace.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { syntheticReviewPair } from './review-delivery-test-fixture.js';
import { createRunSupplementPreparationFixture } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';
import { digest, Problem, transaction, uid, type PrivateBlobs } from './data.js';

const connection = await isolatedTestDatabase(undefined, 'run-billing-segments');
const origin = 'http://bondbuddy.test';
type Kind = 'authoring' | 'review' | 'm4';
const kinds: Kind[] = ['authoring', 'review', 'm4'];
const oldTier = process.env.BB_DEPLOYMENT_TIER, oldChannel = process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
before(() => { process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled'; });
after(() => {
  if (oldTier === undefined) delete process.env.BB_DEPLOYMENT_TIER; else process.env.BB_DEPLOYMENT_TIER = oldTier;
  if (oldChannel === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL; else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = oldChannel;
});
const ok = (response: { statusCode: number; body: string; json(): any }) => {
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body); return response.json();
};
let priceSequence = 0;
async function prices(pool: Pool, points = 10000) {
  await publishPrices(pool, { id: `segment-functional-${uid()}`, prices: { ...INITIAL_FIXED_PRICES,
    new_authoring: points, full_review: points, differential_review: 1000 },
  effectiveAt: new Date(Date.now() - 86400000 + ++priceSequence * 1000).toISOString(),
  actor: 'synthetic', reason: 'Isolated canonical V1 segment tests' });
}
async function fixture(paid = true) {
  const pool = new Pool({ connectionString: connection }), owner = `segment-${uid()}`;
  const files = new Map<string, Buffer>();
  const blobs: PrivateBlobs = { put: async (key, bytes) => { files.set(key, Buffer.from(bytes)); },
    get: async key => files.get(key)!, getIfExists: async key => files.get(key) ?? null,
    getIfExistsBounded: async key => files.get(key) ?? null, exists: async key => files.has(key),
    delete: async key => { files.delete(key); } };
  let actor = owner;
  const app = createServer({ pool, blobs, allowedOrigin: origin, enableSyntheticQueue: true,
    enablePaidAuthoring: paid, enablePaidReview: paid, principal: async () => ({ userId: actor, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: any, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload, headers: { origin, ...headers } });
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `seg_${uid().replaceAll('-', '').slice(0, 20)}`]);
  if (paid) await prices(pool);
  const fund = (points: number, key: string = uid()) => transaction(pool, c => grantCredits(c, { owner, points, key,
    source: 'existing_grant', expiresAt: null, actor: 'synthetic', reason: 'Isolated segment fixture' }));
  const material = async (projectId: string, role: 'historical' | 'other') => {
    const upload = uid(), id = uid(), sha = digest('Synthetic segment source material'), objectKey = `synthetic/${id}`;
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,$5,$6,now()+interval '1 hour','completed')`,
    [upload, owner, projectId, sha, role, objectKey]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',16,$6,$7,'persisted')`,
    [id, owner, projectId, upload, role, sha, objectKey]);
    return { material_id: id, material_version: 1, sha256: sha };
  };
  const prepare = async (kind: Kind) => {
    if (kind === 'authoring') {
      const p = ok(await send('POST', '/api/v1/projects', { kind: 'update', name: 'Synthetic canonical authoring',
        issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private', update_details: {
          ...emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2026-09-30' } }));
      const bytes = Buffer.from('Synthetic source for canonical billing'), metadata = { byte_size: bytes.length, sha256: digest(bytes) };
      const upload = ok(await send('POST', `/api/v1/projects/${p.project_id}/materials/uploads`, {
        ...metadata, filename: 'synthetic.txt', media_type: 'text/plain', role: 'audit' }));
      assert.equal((await send('PUT', upload.upload_url, bytes, { 'content-type': 'application/octet-stream' })).statusCode, 204);
      const m = ok(await send('POST', `/api/v1/projects/${p.project_id}/materials/uploads/${upload.upload_id}/complete`, metadata));
      const input = ok(await send('POST', `/api/v1/projects/${p.project_id}/input-revisions`, {
        draft_revision: 1, material_versions: [{ material_id: m.material_id, material_version: 1 }], requirement_message_ids: [] }));
      const quote = paid ? ok(await send('POST', `/api/v1/projects/${p.project_id}/credit-quote`, {
        input_revision: input.input_revision, input_hash: input.input_hash })).quote : null;
      const request = { execution_request_id: uid(), project_id: p.project_id, input_revision: input.input_revision,
        input_hash: input.input_hash, task_kind: 'update', input_manifest_ref: input.input_hash,
        storage_origin: 'cloud', workspace_id: p.project_id, ...(quote ? { quote_id: quote.quote_id } : {}) };
      return { quote, start: () => send('POST', '/api/v1/runs/execute', request) };
    }
    if (kind === 'review') {
      const project = ok(await send('POST', '/api/v1/projects', { kind: 'review', name: 'Synthetic canonical review',
        issuer_name: null, market: null, offering: null })), base = `/api/v1/projects/${project.project_id}`;
      const pin = await material(project.project_id, 'historical');
      ok(await send('PUT', `${base}/review-draft`, { kind: 'input', expected_version: 0,
        input: { source_material_ref: pin, material_versions: [pin], requirements: ['Synthetic requirement'], as_of: null } }));
      const request = { execution_request_id: uid(), operation: 'full_review', expected_input_version: 1,
        source_report_id: null, expected_plan_version: null, finding_ids: [] };
      const quote = ok(await send('POST', `${base}/review-executions/quote`, request)).quote;
      return { quote, start: () => send('POST', `${base}/review-executions`, { ...request, quote_id: quote.quote_id }) };
    }
    const topic = ok(await send('POST', '/api/v1/m4/topics', { creation_request_id: uid(), name: 'Synthetic canonical M4' })).topic;
    const base = `/api/v1/m4/topics/${topic.topic_id}`, pin = await material(topic.project_id, 'other');
    ok(await send('PUT', `${base}/drafts/underwriter`, { expected_version: 0, input: { ...emptyM4Draft('underwriter'),
      materials: [{ ...pin, source_project_id: topic.project_id }], fields: { market: 'sse', issuer_name: 'Synthetic issuer' } } }));
    const quote = ok(await send('POST', `${base}/quote`, { kind: 'document', document_type: 'underwriter', expected_draft_version: 1 })).quote;
    const request = { execution_request_id: uid(), document_type: 'underwriter', expected_draft_version: 1,
      quote_id: quote.quote_id, entrypoint: 'workspace' };
    return { quote, start: () => send('POST', `${base}/execute`, request) };
  };
  return { pool, owner, app, blobs, send, fund, prepare, setActor: (value: string) => { actor = value; },
    act: (id: string, action: string) => send('POST', `/api/v1/runs/${id}/${action}`, { reason: 'synthetic-test' }),
    close: async () => {
      try {
        // A failed assertion must not leave a queued run for the next fixture's
        // real global queue claim. Terminate only this fixture owner's tasks.
        const unfinished = (await pool.query(`SELECT id FROM bb_runs WHERE owner_user_id=$1
          AND state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')`, [owner])).rows;
        for (const run of unfinished) await send('POST', `/api/v1/runs/${run.id}/cancel`, { reason: 'synthetic-fixture-cleanup' });
      } finally { await app.close(); await pool.end(); }
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const runDto = (response: Parameters<typeof ok>[0]) => { const dto = ok(response); return dto.run ?? dto; };
const rawRun = async (pool: Pool | PoolClient, id: string) => (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [id])).rows[0];
async function lockedRawRun(c: PoolClient, id: string) {
  const run = (await c.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
  await c.query('SELECT id FROM bb_jobs WHERE run_id=$1 FOR UPDATE', [id]);
  return run;
}
async function assertMirror(pool: Pool | PoolClient, runId: string) {
  const fields = ['active_ms', 'work_bps', 'accrued_points', 'clock_at', 'lease_until', 'last_activity_at'];
  const row = (await pool.query(`SELECT to_jsonb(p) AS canonical,to_jsonb(a) AS legacy FROM bb_run_billing_progress p
    JOIN bb_authoring_progress a ON a.run_id=p.run_id AND a.owner_user_id=p.owner_user_id WHERE p.run_id=$1`, [runId])).rows;
  assert.equal(row.length, 1, 'one canonical and legacy meter must be present');
  for (const field of fields) assert.deepEqual(row[0].canonical[field], row[0].legacy[field], `meter mirrors ${field}`);
  return row[0].canonical;
}
async function assertCaptured(f: Fixture, runId: string, quote: any) {
  const run = await rawRun(f.pool, runId);
  const segments = (await f.pool.query('SELECT * FROM bb_run_billing_segments WHERE run_id=$1', [runId])).rows;
  assert.equal(segments.length, 1);
  const segment = segments[0];
  assert.equal(segment.id, run.reservation_id); assert.equal(segment.reservation_id, run.reservation_id);
  assert.equal(segment.owner_user_id, f.owner); assert.equal(segment.project_id, run.project_id);
  assert.equal(segment.segment_number, 1); assert.equal(segment.origin_execution_version, 1);
  assert.equal(segment.origin_input_revision, run.input_revision); assert.equal(segment.origin_input_hash.trim(), run.input_hash.trim());
  assert.equal(segment.source_quote_id, quote.quote_id); assert.equal(Number(segment.points), quote.points);
  const reservation = (await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1', [run.reservation_id])).rows[0];
  assert.equal(reservation.billing_policy, DYNAMIC_AUTHORING_POLICY);
  assert.equal(segment.billing_policy, reservation.billing_policy);
  assert.equal(Number(segment.points), Number(reservation.points));
  // FixedQuote for M1/M3 deliberately omits this internal policy field; M4's
  // quote exposes it. All these real current V1 reservations are dynamic.
  if (quote.billing_policy !== undefined) assert.equal(segment.billing_policy, quote.billing_policy);
  const binding = (await f.pool.query('SELECT * FROM bb_run_execution_billing_bindings WHERE run_id=$1', [runId])).rows;
  assert.equal(binding.length, 1); assert.equal(binding[0].billing_segment_id, segment.id);
  assert.equal(binding[0].execution_version, 1); assert.equal(binding[0].input_revision, run.input_revision);
  assert.equal(binding[0].input_hash.trim(), run.input_hash.trim()); assert.equal(binding[0].assignment_kind, 'original');
  const selected = await readRunBillingSegment(f.pool, run); assert.ok(selected);
  assert.equal(selected.id, segment.id); assert.equal(selected.points, quote.points);
  const meter = await assertMirror(f.pool, runId);
  assert.equal(Number(meter.active_ms), 0); assert.equal(Number(meter.accrued_points), 0);
  assert.equal(Number((await f.pool.query(`SELECT COALESCE(sum(points),0) AS n FROM bb_credit_events
    WHERE run_id=$1 AND kind='settle'`, [runId])).rows[0].n), 0);
  return segment;
}
async function age(pool: Pool, runId: string) {
  // Exercise the compatibility writer too: the mirror must route this exact
  // historical timestamp and amount to the authoritative canonical meter.
  await pool.query(`UPDATE bb_authoring_progress SET clock_at=now()-interval '30 seconds',
    lease_until=now()+interval '30 seconds' WHERE run_id=$1`, [runId]);
  await assertMirror(pool, runId);
}
async function activity(f: Fixture, lease: Lease, kind: Kind) {
  if (kind === 'review') {
    const event = { version: 'review-action-v1' as const, action_id: digest('canonical-review-action'),
      code: 'check_financial' as const, state: 'started' as const };
    assert.equal(await recordReviewAction(f.pool, lease, event), true);
    assert.equal(await recordReviewAction(f.pool, lease, event), false);
  } else {
    const event = { activity_id: digest('canonical-authoring-activity'), code: 'read_materials' as const,
      state: 'started' as const, summary: '正在读取合成材料' };
    assert.equal(await recordAuthoringActivity(f.pool, lease, event), true);
    assert.equal(await recordAuthoringActivity(f.pool, lease, event), false);
  }
  assert.ok((await assertMirror(f.pool, lease.runId)).last_activity_at);
}
async function delivery(f: Fixture, lease: Lease, kind: Kind) {
  if (kind === 'review') return syntheticReviewPair(f.pool, lease, f.blobs);
  const bytes = makeSyntheticDocxFixture({ text: `Synthetic ${kind} delivery` });
  const document = await promoteWordArtifact(f.pool, lease, bytes, f.blobs, kind === 'authoring' ? 'generated_pair_v1' : undefined);
  assert.equal(document.status, 'available');
  if (kind === 'authoring') {
    const clean = await promoteWordArtifact(f.pool, lease, makeSyntheticDocxFixture({ text: 'Synthetic clean delivery' }), f.blobs, 'generated_pair_v1');
    await checkpointStage(f.pool, lease, 'word_delivery_pair', { revision_artifact_id: document.artifactId, clean_artifact_id: clean.artifactId });
  } else {
    const noteBytes = makeSyntheticDocxFixture({ text: 'Synthetic preparation note' });
    const note = await promoteWordArtifact(f.pool, lease, noteBytes, f.blobs);
    await transaction(f.pool, c => registerM4Artifacts(c, f.owner, lease.runId, [
      { kind: 'document', artifact_id: document.artifactId, artifact_version: 1, filename: 'document.docx', byte_size: bytes.length },
      { kind: 'preparation_note', artifact_id: note.artifactId, artifact_version: 1, filename: 'note.docx', byte_size: noteBytes.length } ]));
    await checkpointStage(f.pool, lease, 'word_delivery', { artifact: document.artifactId });
  }
  return document;
}
async function gross(pool: Pool, runId: string) {
  return Number((await pool.query(`SELECT COALESCE(sum(points),0) AS n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'`, [runId])).rows[0].n);
}

for (const kind of kinds) test(`${kind}: reserve immediately captures exact V1 terms; queue, activity, progress and verified delivery use the original cap`,
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture();
    try {
      await f.fund(50000);
      const prepared = await f.prepare(kind), first = runDto(await prepared.start()), replay = runDto(await prepared.start());
      assert.equal(replay.run_id, first.run_id);
      const segment = await assertCaptured(f, first.run_id, prepared.quote);
      const before = await creditBalance(f.pool, f.owner);
      assert.equal((await readAuthoringProgress(f.pool, f.owner, first.run_id))!.charged_points, 0);
      await prices(f.pool, 20000);
      assert.deepEqual(await readRunBillingSegment(f.pool, await rawRun(f.pool, first.run_id)), {
        id: segment.id, owner: f.owner, projectId: segment.project_id, runId: first.run_id,
        reservationId: segment.reservation_id, sourceQuoteId: segment.source_quote_id,
        points: prepared.quote.points, billingPolicy: segment.billing_policy,
        execution: { executionVersion: 1, inputRevision: segment.origin_input_revision, inputHash: segment.origin_input_hash.trim() } });
      const lease = await claim(f.pool); assert.ok(lease); assert.equal(lease.runId, first.run_id);
      await activity(f, lease, kind); await age(f.pool, first.run_id); await renew(f.pool, lease);
      await checkpointStage(f.pool, lease, 'materials_ready', { synthetic_saved: true });
      const meter = await assertMirror(f.pool, first.run_id), consumed = await gross(f.pool, first.run_id);
      assert.ok(consumed > 0 && consumed < prepared.quote.points); assert.equal(Number(meter.accrued_points), consumed);
      // Replaying the same cumulative debit cannot create a second settlement.
      await transaction(f.pool, async c => {
        const run = await lockedRawRun(c, first.run_id); const result = await debitAuthoringCredits(c, run, consumed);
        assert.ok(result); assert.equal(result.charged, consumed);
      });
      assert.equal(await gross(f.pool, first.run_id), consumed);
      const artifact = await delivery(f, lease, kind);
      assert.equal((await finish(f.pool, lease, 'succeeded', { artifactId: artifact.artifactId, artifactVersion: 1, blobs: f.blobs })).state, 'succeeded');
      assert.equal(await gross(f.pool, first.run_id), prepared.quote.points);
      assert.equal((await readAuthoringProgress(f.pool, f.owner, first.run_id))!.charged_points, prepared.quote.points);
      assert.equal((await creditBalance(f.pool, f.owner)).available, before.available - prepared.quote.points);
      await assertMirror(f.pool, first.run_id);
      assert.equal((await f.act(first.run_id, 'cancel')).statusCode, 409);
      assert.equal(await gross(f.pool, first.run_id), prepared.quote.points);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_run_billing_segments WHERE run_id=$1', [first.run_id])).rows[0].n, 1);
      assert.equal((await auditCredits(f.pool)).consistent, true);
      const beforeCorrection = await creditBalance(f.pool, f.owner);
      const correction = { runId: first.run_id, reservationId: segment.reservation_id,
        actor: 'synthetic', reason: 'Idempotent correction of the selected original V1 reservation' };
      const lots = await correctSettlement(f.pool, correction);
      assert.deepEqual(await correctSettlement(f.pool, correction), lots);
      assert.equal((await creditBalance(f.pool, f.owner)).available, beforeCorrection.available + prepared.quote.points);
      assert.equal(await gross(f.pool, first.run_id), prepared.quote.points, 'operator correction does not rewrite gross debits');
      assert.equal((await auditCredits(f.pool)).consistent, true);
    } finally { await f.close(); }
  });

test('canonical V1: one point exhausts, saved work and manual pause survive topup, unfunded elapsed time is discarded, delivery finishes at the original cap',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture();
    try {
      const rejected = await f.prepare('authoring');
      assert.equal((await rejected.start()).statusCode, 402);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_run_billing_segments WHERE owner_user_id=$1', [f.owner])).rows[0].n, 0);
      await f.fund(1); const prepared = await f.prepare('authoring'), run = runDto(await prepared.start());
      await assertCaptured(f, run.run_id, prepared.quote);
      const lease = await claim(f.pool); assert.ok(lease);
      await age(f.pool, run.run_id); await renew(f.pool, lease);
      await checkpointStage(f.pool, lease, 'model_generation', { durable_result: 'original-v1-model' });
      assert.equal(await pauseAtCheckpoint(f.pool, lease), true);
      assert.equal(await gross(f.pool, run.run_id), 1); assert.equal((await creditBalance(f.pool, f.owner)).available, 0);
      assert.equal((await readAuthoringProgress(f.pool, f.owner, run.run_id))!.clock_running, false);
      const frozen = await assertMirror(f.pool, run.run_id);
      assert.equal((await f.act(run.run_id, 'resume')).statusCode, 402);
      ok(await f.act(run.run_id, 'pause')); await f.fund(7, 'canonical-topup-once'); await f.fund(7, 'canonical-topup-once');
      assert.equal(await resumePausedRun(f.pool, f.owner, run.run_id, 'credits_recharged'), false);
      assert.equal((await creditBalance(f.pool, f.owner)).available, 7);
      ok(await f.act(run.run_id, 'resume'));
      assert.equal((await creditBalance(f.pool, f.owner)).available, 7, 'queued topup does not collect the unfunded pre-pause interval');
      const queued = await assertMirror(f.pool, run.run_id);
      assert.equal(queued.active_ms, frozen.active_ms); assert.equal(queued.accrued_points, frozen.accrued_points);
      const resumed = await claim(f.pool); assert.ok(resumed);
      assert.equal((resumed.checkpoint.stages as any).model_generation.durable_result, 'original-v1-model');
      await age(f.pool, run.run_id); await renew(f.pool, resumed); assert.equal(await pauseAtCheckpoint(f.pool, resumed), true);
      assert.equal(await gross(f.pool, run.run_id), 8);
      await f.fund(20000); assert.equal(await resumePausedRun(f.pool, f.owner, run.run_id, 'credits_recharged'), true);
      const deliveryLease = await claim(f.pool); assert.ok(deliveryLease);
      const artifact = await delivery(f, deliveryLease, 'authoring');
      await finish(f.pool, deliveryLease, 'succeeded', { artifactId: artifact.artifactId, artifactVersion: 1, blobs: f.blobs });
      assert.equal(await gross(f.pool, run.run_id), prepared.quote.points); await assertMirror(f.pool, run.run_id);
      assert.equal((await auditCredits(f.pool)).consistent, true);
    } finally { await f.close(); }
  });

for (const kind of kinds) test(`${kind}: cancellation retains consumed V1 points; platform failure appends one compensating correction without rewriting gross debits`,
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture();
    try {
      await f.fund(50000);
      const cancelled = runDto(await (await f.prepare(kind)).start()), cancelLease = await claim(f.pool); assert.ok(cancelLease);
      await checkpointStage(f.pool, cancelLease, 'materials_ready', { saved: true }); await age(f.pool, cancelled.run_id); await renew(f.pool, cancelLease);
      const beforeCancel = await gross(f.pool, cancelled.run_id); assert.ok(beforeCancel > 0);
      ok(await f.act(cancelled.run_id, 'cancel'));
      const consumed = await gross(f.pool, cancelled.run_id); assert.ok(consumed >= beforeCancel);
      assert.equal((await readAuthoringProgress(f.pool, f.owner, cancelled.run_id))!.charged_points, consumed);
      assert.equal((await f.act(cancelled.run_id, 'cancel')).statusCode, 409); assert.equal(await gross(f.pool, cancelled.run_id), consumed);
      await assertMirror(f.pool, cancelled.run_id);
      const beforeFailure = await creditBalance(f.pool, f.owner), failed = runDto(await (await f.prepare(kind)).start());
      const lease = await claim(f.pool); assert.ok(lease); assert.equal(lease.runId, failed.run_id);
      await checkpointStage(f.pool, lease, 'materials_ready', { saved: true }); await age(f.pool, failed.run_id); await renew(f.pool, lease);
      const debitRows = (await f.pool.query("SELECT * FROM bb_credit_events WHERE run_id=$1 AND kind='settle' ORDER BY id", [failed.run_id])).rows;
      assert.ok(debitRows.length > 0); const charged = await gross(f.pool, failed.run_id); assert.ok(charged > 0);
      await finish(f.pool, lease, 'failed', { errorCode: 'DATA_UNAVAILABLE' });
      assert.deepEqual(await creditBalance(f.pool, f.owner), beforeFailure);
      assert.equal((await readAuthoringProgress(f.pool, f.owner, failed.run_id))!.charged_points, 0);
      const afterFailure = (await f.pool.query("SELECT * FROM bb_credit_events WHERE run_id=$1 AND kind='settle' ORDER BY id", [failed.run_id])).rows;
      for (const row of debitRows) assert.deepEqual(afterFailure.find(event => event.id === row.id), row, 'gross history remains append-only');
      const corrected = await f.pool.query("SELECT * FROM bb_credit_events WHERE run_id=$1 AND kind='correction'", [failed.run_id]);
      assert.equal(corrected.rows.length, 1);
      assert.equal(Number(corrected.rows[0].points), await gross(f.pool, failed.run_id));
      const refundBalance = await creditBalance(f.pool, f.owner);
      await assert.rejects(finish(f.pool, lease, 'failed', { errorCode: 'DATA_UNAVAILABLE' }),
        error => error instanceof Problem && error.status === 409 && error.code === 'ALREADY_TERMINAL');
      assert.deepEqual(await creditBalance(f.pool, f.owner), refundBalance);
      assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM bb_credit_events WHERE run_id=$1 AND kind='correction'", [failed.run_id])).rows[0].n, 1);
      await assertMirror(f.pool, failed.run_id); assert.equal((await auditCredits(f.pool)).consistent, true);
    } finally { await f.close(); }
  });

test('real paid V1: missing or inconsistent canonical query results fail closed before debit; a different execution cannot reuse the original reservation',
  { skip: !connection, timeout: 120000 }, async t => {
    const f = await fixture();
    try {
      await f.fund(50000); const prepared = await f.prepare('authoring'), run = runDto(await prepared.start());
      await assertCaptured(f, run.run_id, prepared.quote); const raw = await rawRun(f.pool, run.run_id);
      const beforeBalance = await creditBalance(f.pool, f.owner), beforeGross = await gross(f.pool, run.run_id);
      const mutations: Array<[string, (rows: any[]) => any[]]> = [ ['missing binding', () => []],
        ['cap mismatch', rows => rows.map(row => ({ ...row, points: Number(row.points) + 1 }))],
        ['source mismatch', rows => rows.map(row => ({ ...row, source_quote_id: uid() }))],
        ['policy mismatch', rows => rows.map(row => ({ ...row, billing_policy: 'on_delivery' }))],
        ['wrong input', rows => rows.map(row => ({ ...row, origin_input_hash: digest('wrong input') }))],
        ['duplicate binding', rows => [...rows, ...rows]] ];
      for (const [label, mutate] of mutations) await t.test(label, async () => {
        await transaction(f.pool, async c => {
          await lockedRawRun(c, run.run_id);
          // A read seam models unavailable/corrupt authority without altering
          // immutable SQL records or disabling any production guard.
          const query = c.query.bind(c);
          const seam = new Proxy(c, { get(target, key) {
            if (key === 'query') return async (sql: string, values?: any[]) => {
              const result = await query(sql, values);
              return sql.includes('FROM bb_run_execution_billing_bindings b') ? { ...result, rows: mutate(result.rows) } : result;
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
          } });
          const unavailable = (error: unknown) => error instanceof Problem && error.status === 503 && error.code === 'BILLING_NOT_READY';
          await assert.rejects(readRunBillingSegment(seam, raw), unavailable);
          await assert.rejects(debitAuthoringCredits(seam, raw, 1000), unavailable);
        });
        assert.deepEqual(await creditBalance(f.pool, f.owner), beforeBalance); assert.equal(await gross(f.pool, run.run_id), beforeGross);
      });
      await t.test('missing canonical meter cannot fall back to the existing legacy meter', async () => {
        await transaction(f.pool, async c => {
          const current = await lockedRawRun(c, run.run_id), query = c.query.bind(c);
          const seam = new Proxy(c, { get(target, key) {
            if (key === 'query') return async (sql: string, values?: any[]) => {
              const result = await query(sql, values);
              return sql.includes('FROM bb_run_billing_progress') ? { ...result, rows: [] } : result;
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
          } });
          const unavailable = (error: unknown) => error instanceof Problem && error.status === 503 && error.code === 'BILLING_NOT_READY';
          await assert.rejects(readAuthoringProgress(seam, f.owner, run.run_id), unavailable);
          await assert.rejects(syncAuthoringProgress(seam, current), unavailable);
        });
        assert.deepEqual(await creditBalance(f.pool, f.owner), beforeBalance); assert.equal(await gross(f.pool, run.run_id), beforeGross);
      });
      await assert.rejects(readRunBillingSegment(f.pool, raw, { executionVersion: 2, inputRevision: raw.input_revision, inputHash: raw.input_hash.trim() }),
        error => error instanceof Problem && error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT');
      await assertCaptured(f, run.run_id, prepared.quote); ok(await f.act(run.run_id, 'cancel'));
    } finally { await f.close(); }
  });

test('platform trial V1 keeps its nonmonetary legacy meter and creates no canonical segment, reservation or debit',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture(false);
    try {
      const run = runDto(await (await f.prepare('authoring')).start()); assert.equal(run.billing_mode, 'platform_trial');
      const raw = await rawRun(f.pool, run.run_id); assert.equal(await readRunBillingSegment(f.pool, raw), null);
      const lease = await claim(f.pool); assert.ok(lease); await checkpointStage(f.pool, lease, 'materials_ready', { saved: true });
      await f.pool.query("UPDATE bb_authoring_progress SET clock_at=now()-interval '30 seconds',lease_until=now()+interval '30 seconds' WHERE run_id=$1", [run.run_id]);
      await renew(f.pool, lease); assert.ok((await readAuthoringProgress(f.pool, f.owner, run.run_id))!.active_ms > 0);
      assert.equal((await readAuthoringProgress(f.pool, f.owner, run.run_id))!.charged_points, 0);
      await transaction(f.pool, async c => assert.equal(await debitAuthoringCredits(c, await lockedRawRun(c, run.run_id), 10000), null));
      for (const table of ['bb_run_billing_segments', 'bb_run_execution_billing_bindings', 'bb_run_billing_progress', 'bb_credit_reservations', 'bb_credit_events'])
        assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE run_id=$1`, [run.run_id])).rows[0].n, 0, table);
      ok(await f.act(run.run_id, 'cancel')); assert.deepEqual(await creditBalance(f.pool, f.owner), { available: 0, frozen: 0 });
    } finally { await f.close(); }
  });

for (const kind of kinds) test(`${kind}: an actual nonproduction V1 fixture never acquires a monetary segment or charges its funded owner`,
  { skip: !connection, timeout: 120000 }, async () => {
    const f = kind === 'authoring'
      ? await createRunSupplementPreparationFixture(connection!, { nonProduction: true, earlyPause: 'before_prompt' })
      : await createRunSupplementFilePreparationFixture(connection!, kind, { nonProduction: true, earlyPause: 'before_prompt' });
    try {
      const raw = await rawRun(f.pool, f.runId), balance = await creditBalance(f.pool, f.owner);
      assert.equal(raw.channel, 'non_production_test'); assert.equal(raw.reservation_id, null);
      assert.equal(await readRunBillingSegment(f.pool, raw), null);
      await transaction(f.pool, async c => assert.equal(await debitAuthoringCredits(c, await lockedRawRun(c, f.runId), 10000), null));
      for (const table of ['bb_run_billing_segments', 'bb_run_execution_billing_bindings', 'bb_run_billing_progress', 'bb_credit_reservations', 'bb_credit_events'])
        assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE run_id=$1`, [f.runId])).rows[0].n, 0, table);
      assert.deepEqual(await creditBalance(f.pool, f.owner), balance);
      assert.equal((await readAuthoringProgress(f.pool, f.owner, f.runId))!.charged_points, 0);
    } finally { await f.cleanup(); }
  });
