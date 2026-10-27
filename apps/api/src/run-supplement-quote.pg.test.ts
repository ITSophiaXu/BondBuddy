// Synthetic DOCX/provider history with real paused HTTP receipts, PostgreSQL,
// quote persistence and authentication. No worker, supplier or payment is run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_FIXED_PRICES, M4_DOCUMENT_FIXED_PRICE, reportingWindow,
  type BillingTask, type RunSupplementDraftResponse } from '@bondbuddy/contracts';
import { digest, Problem, transaction, uid } from './data.js';
import { publishPrices, reserveCredits } from './billing.js';
import { classifyFixedPrice } from './billing-classification.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementPreparationFixture } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';
import { loadRunSupplementProcessingBasis, type RunSupplementProcessingKind } from './run-supplement-preparation.js';
import { createRunSupplementQuote, readRunSupplementQuote, confirmRunSupplementQuote } from './run-supplement-quote.js';

const connection = await isolatedTestDatabase(undefined, 'run-supplement-quote');
const origin = 'http://bondbuddy.test';
const denied = (error: unknown) => error instanceof Problem && error.status === 409;
const hidden = (error: unknown) => error instanceof Problem && [403, 404].includes(error.status);
let priceSequence = 0;
async function prices(f: { pool: Parameters<typeof publishPrices>[0] }, changes: Partial<Record<BillingTask, number>> = {}) {
  const id = `synthetic-supplement-price-${uid()}`;
  await publishPrices(f.pool, { id, prices: { ...INITIAL_FIXED_PRICES, full_review: 2301, differential_review: 701,
    new_authoring: 6301, ...changes }, effectiveAt: new Date(Date.now() - 86400000 + ++priceSequence * 1000).toISOString(),
  actor: 'synthetic-test', reason: 'Isolated B1 quote test prices; not product pricing' });
  return id;
}
async function fixture(kind: RunSupplementProcessingKind, earlyPause?: 'before_prompt' | 'after_prompt', differential = false) {
  if (kind === 'authoring') return earlyPause
    ? createRunSupplementPreparationFixture(connection!, { earlyPause })
    : createRunSupplementPreparationFixture(connection!);
  const options = kind === 'review' ? { operation: differential ? 'differential_review' as const : 'full_review' as const } : {};
  return earlyPause ? createRunSupplementFilePreparationFixture(connection!, kind, { ...options, earlyPause })
    : createRunSupplementFilePreparationFixture(connection!, kind, options);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type QuoteRequest = Parameters<typeof createRunSupplementQuote>[0]['request'];
type ConfirmationRequest = Parameters<typeof confirmRunSupplementQuote>[0]['request'];
function quoteRequest(f: Fixture, saved: RunSupplementDraftResponse = f.saved, requestId = uid()): QuoteRequest {
  assert.equal(saved.input_preview.status, 'prepared');
  assert.equal(typeof saved.request_id, 'string');
  return { request_id: requestId, supplement_revision: saved.revision, saved_request_id: saved.request_id!,
    candidate_input_hash: saved.input_preview.candidate_input_hash! };
}
const create = (f: Fixture, request = quoteRequest(f), extra: { validForSeconds?: number } = {}) =>
  createRunSupplementQuote({ pool: f.pool, blobs: f.blobs, owner: f.owner, runId: f.runId, request, ...extra });
const read = (f: Fixture, quoteId: string) => readRunSupplementQuote({ pool: f.pool, owner: f.owner, runId: f.runId, quoteId });
const confirm = (f: Fixture, quoteId: string, request: ConfirmationRequest) =>
  confirmRunSupplementQuote({ pool: f.pool, blobs: f.blobs, owner: f.owner, runId: f.runId, quoteId, request });
function confirmationRequest(quote: Awaited<ReturnType<typeof create>>['quote']): ConfirmationRequest {
  return { request_id: uid(), quote_hash: quote.quote_hash };
}
async function originalEvidence(f: Fixture) {
  const state: Record<string, unknown> = {};
  for (const table of ['bb_runs', 'bb_jobs', 'bb_run_execution_heads', 'bb_run_execution_versions', 'bb_input_revisions',
    'bb_review_execution_snapshots', 'bb_m4_execution_snapshots', 'bb_run_test_successor_authorizations',
    'bb_model_call_attempts', 'bb_provider_result_refs', 'bb_credit_quotes', 'bb_m4_quotes', 'bb_credit_reservations',
    'bb_credit_accounts', 'bb_credit_lots', 'bb_credit_allocations', 'bb_credit_events', 'bb_artifact_versions']) {
    if (table === 'bb_credit_allocations') {
      state[table] = (await f.pool.query(`SELECT a.* FROM bb_credit_allocations a JOIN bb_credit_reservations r
        ON r.id=a.reservation_id WHERE r.owner_user_id=$1 ORDER BY to_jsonb(a)::text`, [f.owner])).rows;
    } else state[table] = (await f.pool.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`, [f.owner])).rows;
  }
  return state;
}
async function rows(f: Fixture, table: 'bb_run_supplement_quotes' | 'bb_run_supplement_quote_confirmations' | 'bb_run_supplement_processing_plans') {
  return (await f.pool.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`, [f.owner])).rows;
}
async function quoteOutbox(f: Fixture) {
  return (await f.pool.query(`SELECT * FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_type='run_supplement_quote'
    AND aggregate_id=$2 ORDER BY event_type,id`, [f.owner, f.runId])).rows;
}
async function assertQuoteOutbox(f: Fixture, result: Awaited<ReturnType<typeof create>>, confirmed: boolean) {
  const events = await quoteOutbox(f);
  assert.equal(events.length, confirmed ? 2 : 1);
  const created = events.filter(row => row.event_type === 'run.supplement_quote_created');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].payload, { quote_id: result.quote.quote_id, supplement_revision: result.quote.supplement_revision,
    quote_hash: result.quote.quote_hash, total_points: result.quote.total_points });
  if (confirmed) {
    const confirmations = events.filter(row => row.event_type === 'run.supplement_quote_confirmed');
    assert.equal(confirmations.length, 1); assert.ok(result.confirmation);
    assert.deepEqual(confirmations[0].payload, { quote_id: result.quote.quote_id, confirmation_id: result.confirmation.confirmation_id,
      quote_hash: result.quote.quote_hash, total_points: result.quote.total_points });
  }
  return events;
}
async function authenticated(f: Fixture, owner = f.owner) {
  const access = uid(), csrf = uid(), sessionId = uid();
  await f.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,
  [sessionId, owner, digest(access), digest(uid()), digest(csrf)]);
  const headers = { origin, cookie: `bb_session=${access}; bb_csrf=${csrf}`, 'x-bb-csrf': csrf };
  const send = (method: 'GET' | 'POST', url: string, payload?: unknown, override: Record<string, string> = {}) =>
    f.app.inject({ method, url, payload: payload as any, headers: { ...headers, ...override } });
  return { send, sessionId, headers };
}
const ok = (response: { statusCode: number; body: string; json(): any }) => {
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body); return response.json();
};

// This test runs before publishing any prices and proves genuine zero work has
// no price-table dependency. The imported fixtures never clone/start a service.
test('all three genuine early pauses quote zero without any published price and preserve the original fee',
  { skip: !connection, timeout: 180000 }, async t => {
    for (const kind of ['authoring', 'review', 'm4'] as const) for (const early of ['before_prompt', 'after_prompt'] as const) {
      await t.test(`${kind}: ${early}`, async () => {
        const f = await fixture(kind, early);
        try {
          assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_credit_price_versions')).rows[0].n, 0);
          assert.equal(f.selected, null);
          const before = await originalEvidence(f), result = await create(f);
          assert.equal(result.confirmation, null); assert.equal(result.quote.total_points, 0);
          assert.equal(result.quote.items.length, 1);
          const item = result.quote.items[0]!;
          assert.equal(item.target_id, f.runId); assert.equal(item.needs_redo, false);
          assert.equal(item.task_type, null); assert.equal(item.price_version, null);
          assert.equal(item.full_price_points, null); assert.equal(item.points, 0);
          const request = confirmationRequest(result.quote), accepted = await confirm(f, result.quote.quote_id, request);
          assert.equal(accepted.confirmation?.total_points, 0);
          assert.deepEqual(await read(f, result.quote.quote_id), accepted);
          assert.deepEqual(await confirm(f, result.quote.quote_id, request), accepted);
          assert.deepEqual(await originalEvidence(f), before, 'zero confirmation neither replaces nor waives the original charge');
        } finally { await f.cleanup(); }
      });
    }
  });

for (const [kind, differential, task, points] of [
  ['authoring', false, 'new_authoring', 6301], ['review', false, 'full_review', 2301],
  ['review', true, 'differential_review', 701], ['m4', false, 'm4_G02', M4_DOCUMENT_FIXED_PRICE.points],
] as const) {
  test(`${kind}${differential ? ' differential' : ''}: captured work quotes and confirms one exact document package`,
    { skip: !connection, timeout: 120000 }, async () => {
      const f = await fixture(kind, undefined, differential);
      try {
        const version = kind === 'm4' ? M4_DOCUMENT_FIXED_PRICE.version : await prices(f);
        assert.ok(Object.keys(f.files).length > 1, 'multiple saved/output members must not multiply the price');
        const before = await originalEvidence(f), request = quoteRequest(f), result = await create(f, request), quote = result.quote;
        assert.equal(result.confirmation, null);
        assert.equal(quote.project_id, f.projectId); assert.equal(quote.run_id, f.runId);
        assert.equal(quote.supplement_revision, f.saved.revision); assert.equal(quote.saved_request_id, f.saved.request_id);
        assert.equal(quote.pricing_rule, 'b1_full_document_v1'); assert.match(quote.quote_hash, /^[a-f0-9]{64}$/);
        assert.ok(Date.parse(quote.expires_at) > Date.parse(quote.created_at));
        assert.equal(quote.items.length, 1); assert.equal(quote.total_points, points);
        assert.deepEqual({ ...quote.items[0], document_name: '(name)' }, { target_id: f.runId, document_name: '(name)',
          needs_redo: true, task_type: task, price_version: version, full_price_points: points, points });
        assert.ok(quote.items[0]!.document_name.trim());
        assert.equal((await rows(f, 'bb_run_supplement_processing_plans')).length, 1, 'the service prepares the exact plan internally');
        assert.deepEqual(await create(f, request), result); assert.deepEqual(await read(f, quote.quote_id), result);
        const confirmation = confirmationRequest(quote), accepted = await confirm(f, quote.quote_id, confirmation);
        assert.deepEqual(accepted.quote, quote); assert.ok(accepted.confirmation);
        assert.equal(accepted.confirmation.quote_id, quote.quote_id); assert.equal(accepted.confirmation.quote_hash, quote.quote_hash);
        assert.equal(accepted.confirmation.project_id, f.projectId); assert.equal(accepted.confirmation.run_id, f.runId);
        assert.equal(accepted.confirmation.request_id, confirmation.request_id); assert.equal(accepted.confirmation.total_points, points);
        assert.ok(Number.isFinite(Date.parse(accepted.confirmation.confirmed_at)));
        assert.deepEqual(await read(f, quote.quote_id), accepted);
        assert.deepEqual(await confirm(f, quote.quote_id, confirmation), accepted);
        assert.equal((await rows(f, 'bb_run_supplement_quotes')).length, 1);
        assert.equal((await rows(f, 'bb_run_supplement_quote_confirmations')).length, 1);
        assert.deepEqual(await originalEvidence(f), before, 'quote and confirmation do not adopt, execute or change original accounting');
      } finally { await f.cleanup(); }
    });
}

async function originalPaidAuthoring(f: Fixture, priceVersion: string, points: number, invalidHash = false) {
  const run = (await f.pool.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND id=$2', [f.owner, f.runId])).rows[0];
  const project = (await f.pool.query('SELECT * FROM bb_projects WHERE owner_user_id=$1 AND id=$2', [f.owner, f.projectId])).rows[0];
  const quoteId = uid();
  await transaction(f.pool, async db => {
    await db.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
      VALUES($1,$2,$3,$4,$5,$6,'new_authoring',$7,'Synthetic original paid task')`,
    [quoteId, f.owner, f.projectId, run.input_revision, invalidHash ? 'f'.repeat(64) : run.input_hash, priceVersion, points]);
    if (!invalidHash) await reserveCredits(db, f.owner, run, quoteId, { revision: run.input_revision, manifest: f.manifest }, project);
    else {
      // Negative persisted authority: the reservation is owned, but its source
      // quote names a different input. No actual credit debit is constructed.
      const reservationId = uid();
      await db.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points)
        VALUES($1,$2,$3,$4,$5,'authoring_balance_v2',0)`, [reservationId, f.owner, f.runId, quoteId, points]);
      await db.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1", [f.runId, reservationId]);
    }
  });
  return quoteId;
}

test('a zero-work supplement does not replace or waive an existing paid source reservation',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture('authoring', 'before_prompt');
    try {
      const version = await prices(f, { new_authoring: 523 });
      const originalQuoteId = await originalPaidAuthoring(f, version, 523), before = await originalEvidence(f);
      const result = await create(f);
      assert.equal(result.quote.total_points, 0); assert.equal(result.quote.items[0]!.needs_redo, false);
      assert.equal(result.quote.items[0]!.task_type, null); assert.equal(result.quote.items[0]!.price_version, null);
      const accepted = await confirm(f, result.quote.quote_id, confirmationRequest(result.quote));
      assert.equal(accepted.confirmation?.total_points, 0);
      assert.deepEqual(await originalEvidence(f), before);
      const fee = (await f.pool.query(`SELECT r.billing_mode,c.quote_id,c.points,c.state FROM bb_runs r
        JOIN bb_credit_reservations c ON c.id=r.reservation_id AND c.run_id=r.id AND c.owner_user_id=r.owner_user_id
        WHERE r.owner_user_id=$1 AND r.id=$2`, [f.owner, f.runId])).rows[0];
      assert.equal(fee.billing_mode, 'fixed_credits'); assert.equal(fee.quote_id, originalQuoteId);
      assert.equal(Number(fee.points), 523); assert.equal(fee.state, 'held');
    } finally { await f.cleanup(); }
  });

test('an original paid category uses its current price even when candidate source information would classify differently',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await createRunSupplementPreparationFixture(connection!);
    try {
      const oldVersion = await prices(f, { new_authoring: 111 });
      const originalQuoteId = await originalPaidAuthoring(f, oldVersion, 111);
      const materialId = uid(), uploadId = uid(), bytes = makeSyntheticDocxFixture({ text: 'Synthetic newly supplied same-issuer source' });
      const sha256 = digest(bytes), media = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const key = `users/${f.owner}/projects/${f.projectId}/materials/${materialId}/1`;
      await f.blobs.put(key, bytes, media);
      await f.pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'new-source.docx',$4,$5,$6,'historical',$7,now()+interval '1 hour','completed')`,
      [uploadId, f.owner, f.projectId, media, bytes.length, sha256, `${key}/upload`]);
      await f.pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','new-source.docx',$5,$6,$7,$8,'persisted')`,
      [materialId, f.owner, f.projectId, uploadId, media, bytes.length, sha256, key]);
      f.changes.push({ material: { material_id: materialId, material_version: 1, sha256 }, replaces: null,
        source_prospectus: { material_id: materialId, material_version: 1, sha256, issuer_name: 'Frozen issuer', relation: 'same_issuer',
          market: 'sse', offering: 'private', reporting_periods: reportingWindow('sse', 'private', '2026-09-30'), status: 'user_asserted' } });
      const saved = await f.save(1);
      const basis = await loadRunSupplementProcessingBasis({ ...f.preparationInput, revision: saved.revision,
        expectedCandidateInputHash: saved.input_preview.candidate_input_hash! }, 'authoring');
      assert.equal(classifyFixedPrice(f.manifest).task, 'new_authoring');
      assert.notEqual(classifyFixedPrice(basis.manifest).task, 'new_authoring', 'candidate classification is not the original paid category');
      const newVersion = await prices(f, { new_authoring: 8891 }), before = await originalEvidence(f);
      const result = await create(f, quoteRequest(f, saved));
      assert.equal(result.quote.items[0]!.task_type, 'new_authoring');
      assert.equal(result.quote.items[0]!.price_version, newVersion);
      assert.equal(result.quote.items[0]!.full_price_points, 8891); assert.equal(result.quote.total_points, 8891);
      const accepted = await confirm(f, result.quote.quote_id, confirmationRequest(result.quote));
      assert.equal(accepted.confirmation?.total_points, 8891);
      assert.deepEqual(await originalEvidence(f), before);
      const original = (await f.pool.query('SELECT points,price_version FROM bb_credit_quotes WHERE id=$1', [originalQuoteId])).rows[0];
      assert.equal(Number(original.points), 111); assert.equal(original.price_version, oldVersion);
    } finally { await f.cleanup(); }
  });

test('an owned reservation cannot make a quote for a different original input authoritative',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture('authoring');
    try {
      const version = await prices(f, { new_authoring: 333 });
      await originalPaidAuthoring(f, version, 333, true);
      const before = await originalEvidence(f);
      await assert.rejects(create(f), error => error instanceof Problem && error.status === 503 && error.code === 'BILLING_NOT_READY');
      assert.equal((await rows(f, 'bb_run_supplement_quotes')).length, 0);
      assert.deepEqual(await originalEvidence(f), before);
    } finally { await f.cleanup(); }
  });

test('concurrent exact quote and confirmation requests persist one receipt, while reused keys reject changed payloads',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture('review', undefined, true);
    try {
      await prices(f); const before = await originalEvidence(f), request = quoteRequest(f);
      const arbitraryAmount = { ...request, total_points: 1, task_type: 'interim' };
      await assert.rejects(create(f, arbitraryAmount), error => error instanceof Problem && [409, 422].includes(error.status));
      const results = await Promise.all([create(f, request), create(f, request), create(f, request)]), first = results[0]!;
      assert.deepEqual(results, [first, first, first]);
      assert.equal((await rows(f, 'bb_run_supplement_quotes')).length, 1);
      assert.equal((await rows(f, 'bb_run_supplement_processing_plans')).length, 1);
      const createdEvents = await assertQuoteOutbox(f, first, false);
      assert.deepEqual(await create(f, request), first);
      assert.deepEqual(await quoteOutbox(f), createdEvents, 'exact quote replay cannot duplicate its outbox event');
      await assert.rejects(create(f, { ...request, candidate_input_hash: 'e'.repeat(64) }), denied);
      const confirmation = confirmationRequest(first.quote);
      const confirmed = await Promise.all([confirm(f, first.quote.quote_id, confirmation), confirm(f, first.quote.quote_id, confirmation),
        confirm(f, first.quote.quote_id, confirmation)]);
      assert.deepEqual(confirmed, [confirmed[0], confirmed[0], confirmed[0]]);
      await assert.rejects(confirm(f, first.quote.quote_id, { ...confirmation, quote_hash: 'd'.repeat(64) }), denied);
      assert.equal((await rows(f, 'bb_run_supplement_quote_confirmations')).length, 1);
      const acceptedEvents = await assertQuoteOutbox(f, confirmed[0]!, true);
      assert.deepEqual(await confirm(f, first.quote.quote_id, confirmation), confirmed[0]);
      assert.deepEqual(await quoteOutbox(f), acceptedEvents, 'exact confirmation replay cannot duplicate its outbox event');
      assert.deepEqual(await originalEvidence(f), before);
    } finally { await f.cleanup(); }
  });

for (const failingEvent of ['run.supplement_quote_created', 'run.supplement_quote_confirmed'] as const) {
  test(`${failingEvent}: outbox failure rolls back the immutable receipt and the same request can retry`,
    { skip: !connection, timeout: 120000 }, async () => {
      const f = await fixture('authoring'), fault = `bb_test_b1_outbox_${uid().replaceAll('-', '')}`;
      let faultInstalled = false;
      try {
        await prices(f); const request = quoteRequest(f);
        let quoted = failingEvent === 'run.supplement_quote_confirmed' ? await create(f, request) : null;
        const confirmation = quoted ? confirmationRequest(quoted.quote) : null;
        await f.pool.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'synthetic B1 quote outbox failure'; END $$`);
        await f.pool.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON bb_outbox FOR EACH ROW
          WHEN (NEW.aggregate_type='run_supplement_quote' AND NEW.event_type='${failingEvent}') EXECUTE FUNCTION ${fault}()`);
        faultInstalled = true;
        const before = await originalEvidence(f), quotes = await rows(f, 'bb_run_supplement_quotes'),
          confirmations = await rows(f, 'bb_run_supplement_quote_confirmations'), events = await quoteOutbox(f);
        await assert.rejects(quoted ? confirm(f, quoted.quote.quote_id, confirmation!) : create(f, request), /synthetic B1 quote outbox failure/);
        assert.deepEqual(await rows(f, 'bb_run_supplement_quotes'), quotes, 'failed creation cannot leave a quote');
        assert.deepEqual(await rows(f, 'bb_run_supplement_quote_confirmations'), confirmations, 'failed confirmation cannot leave consent');
        assert.deepEqual(await quoteOutbox(f), events); assert.deepEqual(await originalEvidence(f), before);
        await f.pool.query(`DROP TRIGGER ${fault} ON bb_outbox`); faultInstalled = false;
        await f.pool.query(`DROP FUNCTION ${fault}()`);
        quoted ??= await create(f, request);
        const accepted = await confirm(f, quoted.quote.quote_id, confirmation ?? confirmationRequest(quoted.quote));
        assert.equal((await rows(f, 'bb_run_supplement_quotes')).length, 1);
        assert.equal((await rows(f, 'bb_run_supplement_quote_confirmations')).length, 1);
        await assertQuoteOutbox(f, accepted, true);
        assert.deepEqual(await originalEvidence(f), before, 'retry changes only the new quote/confirmation/outbox records');
      } finally {
        if (faultInstalled) await f.pool.query(`DROP TRIGGER IF EXISTS ${fault} ON bb_outbox`);
        await f.pool.query(`DROP FUNCTION IF EXISTS ${fault}()`);
        await f.cleanup();
      }
    });
}

for (const cause of ['new_draft', 'checkpoint', 'price_version', 'expired'] as const) {
  test(`unconfirmed quote rejects ${cause} changes without advancing the run or touching its fee`,
    { skip: !connection, timeout: 120000 }, async () => {
      const f = await fixture('authoring');
      try {
        await prices(f); const result = await create(f, quoteRequest(f), cause === 'expired' ? { validForSeconds: 1 } : {});
        if (cause === 'new_draft') await f.save(1);
        if (cause === 'checkpoint') await f.pool.query(`UPDATE bb_jobs SET checkpoint=checkpoint||'{"synthetic_boundary_changed":true}'::jsonb WHERE id=$1`, [f.jobId]);
        if (cause === 'price_version') await prices(f, { new_authoring: 9317 });
        if (cause === 'expired') await new Promise(resolve => setTimeout(resolve, 1250));
        const before = await originalEvidence(f);
        await assert.rejects(confirm(f, result.quote.quote_id, confirmationRequest(result.quote)), denied);
        assert.equal((await rows(f, 'bb_run_supplement_quote_confirmations')).length, 0);
        assert.deepEqual((await read(f, result.quote.quote_id)).quote, result.quote);
        assert.deepEqual(await originalEvidence(f), before);
      } finally { await f.cleanup(); }
    });
}

test('a confirmed historical receipt remains exact after a new draft, price update and quotation expiry',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture('review', undefined, true);
    try {
      await prices(f); const result = await create(f, quoteRequest(f), { validForSeconds: 10 });
      const request = confirmationRequest(result.quote), accepted = await confirm(f, result.quote.quote_id, request);
      await f.save(1); await prices(f, { differential_review: 917 });
      // Confirm while the short quote is live, then wait for its actual DB
      // expiry. Other private suites may be doing real Word/PG work in parallel.
      await new Promise(resolve => setTimeout(resolve, Math.max(0,Date.parse(result.quote.expires_at)-Date.now()+100)));
      const before = await originalEvidence(f);
      assert.deepEqual(await read(f, result.quote.quote_id), accepted);
      assert.deepEqual(await confirm(f, result.quote.quote_id, request), accepted);
      assert.equal((await rows(f, 'bb_run_supplement_quote_confirmations')).length, 1);
      assert.deepEqual(await originalEvidence(f), before);
    } finally { await f.cleanup(); }
  });

test('authenticated HTTP quote/read/confirm uses shared contracts and rejects CSRF, arbitrary prices and foreign owners',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture('m4');
    try {
      const auth = await authenticated(f), path = `/api/v1/runs/${f.runId}/supplement-quotes`, request = quoteRequest(f);
      const before = await originalEvidence(f);
      assert.equal((await f.app.inject({ method: 'POST', url: path, payload: request })).statusCode, 401);
      assert.equal((await auth.send('POST', path, request, { 'x-bb-csrf': '' })).statusCode, 403);
      assert.equal((await auth.send('POST', path, request, { origin: 'https://foreign.example' })).statusCode, 403);
      assert.equal((await auth.send('POST', path, { ...request, total_points: 1, task_type: 'interim' })).statusCode, 422);
      assert.equal((await auth.send('POST', path, { ...request, validForSeconds: 1 })).statusCode, 422, 'trusted expiry override is not public input');
      const result = ok(await auth.send('POST', path, request));
      assert.equal(result.quote.items.length, 1); assert.equal(result.quote.total_points, M4_DOCUMENT_FIXED_PRICE.points);
      const quotePath = `${path}/${result.quote.quote_id}`;
      assert.deepEqual(ok(await auth.send('GET', quotePath)), result);
      assert.equal((await f.app.inject({ method: 'GET', url: quotePath })).statusCode, 401);
      const confirmation = confirmationRequest(result.quote);
      assert.equal((await auth.send('POST', `${quotePath}/confirm`, { ...confirmation, total_points: 1 })).statusCode, 422);
      const foreign = `foreign-${uid()}`;
      await f.pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [foreign, `foreign_${uid().replaceAll('-', '').slice(0, 20)}`]);
      const other = await authenticated(f, foreign);
      assert.equal((await other.send('GET', quotePath)).statusCode, 404);
      assert.equal((await other.send('POST', `${quotePath}/confirm`, confirmation)).statusCode, 404);
      await assert.rejects(readRunSupplementQuote({ pool: f.pool, owner: foreign, runId: f.runId, quoteId: result.quote.quote_id }), hidden);
      const accepted = ok(await auth.send('POST', `${quotePath}/confirm`, confirmation));
      assert.deepEqual(ok(await auth.send('GET', quotePath)), accepted);
      await f.pool.query('DELETE FROM bb_auth_sessions WHERE id=$1', [auth.sessionId]);
      assert.equal((await auth.send('GET', quotePath)).statusCode, 401);
      assert.equal((await auth.send('POST', `${quotePath}/confirm`, confirmation)).statusCode, 401);
      assert.deepEqual(await originalEvidence(f), before);
    } finally { await f.cleanup(); }
  });

for (const revoked of ['archived', 'deleted', 'closed_account'] as const) {
  test(`revoked ${revoked} access cannot read or confirm a saved quote`,
    { skip: !connection, timeout: 120000 }, async () => {
      const f = await fixture('authoring', 'before_prompt');
      try {
        const result = await create(f), auth = await authenticated(f), quotePath = `/api/v1/runs/${f.runId}/supplement-quotes/${result.quote.quote_id}`;
        if (revoked === 'closed_account') await f.pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.owner]);
        else await f.pool.query(`UPDATE bb_projects SET ${revoked === 'archived' ? 'archived_at' : 'deleted_at'}=now() WHERE id=$1`, [f.projectId]);
        const before = await originalEvidence(f);
        const readResponse = await auth.send('GET', quotePath), confirmResponse = await auth.send('POST', `${quotePath}/confirm`, confirmationRequest(result.quote));
        assert.ok([401, 403, 404].includes(readResponse.statusCode), readResponse.body);
        assert.ok([401, 403, 404, 409].includes(confirmResponse.statusCode), confirmResponse.body);
        await assert.rejects(read(f, result.quote.quote_id), hidden);
        assert.equal((await rows(f, 'bb_run_supplement_quote_confirmations')).length, 0);
        assert.deepEqual(await originalEvidence(f), before);
      } finally { await f.cleanup(); }
    });
}
