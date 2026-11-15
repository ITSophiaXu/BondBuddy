// Synthetic materials and model-capacity requests; real API, PostgreSQL, leases and credit ledger.
// No provider request, model intent, or real model call is made by this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID as uid} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {emptyUpdateDetails, INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {createServer} from '@bondbuddy/api';
import {claim, renew, checkpointStage, pauseAtCheckpoint, type Lease} from '@bondbuddy/api/queue';
import {digest, transaction, type PrivateBlobs} from '@bondbuddy/api/data';
import {emptyM4Draft} from '@bondbuddy/api/m4-workspace';
import {uploadSyntheticReference} from '@bondbuddy/api/test-authoring-source';
import {grantCredits, publishPrices} from '../../api/dist/billing.js';
import {readAuthoringProgress} from '../../api/dist/authoring-progress.js';
import {CodexDurableJournal} from './durable-probe-journal.js';
import {PgModelCallBudget, modelCallBudgetFor, type ModelCallPermit} from './model-call-budget.js';
import {isolatedTestDatabase} from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'capacity-wait-billing-regression');
const waitMs = 1500;
let priceSeed: Promise<void> | undefined;
type Kind = 'update' | 'generation' | 'review';
type Sample = {charged: bigint; active: bigint; publicActive: bigint; clockRunning: boolean; modelWaiting: boolean};
type Waiting = {
  controller: AbortController;
  granted: boolean;
  settled: boolean;
  result: Promise<{permit: ModelCallPermit | null; error: unknown}>;
};

async function until(check: () => Promise<boolean>, message: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(25);
  }
}
function assertFrozen(before: Sample, after: Sample) {
  assert.equal(after.charged, before.charged, 'capacity waiting must not debit credits');
  assert.equal(after.active, before.active, 'persisted active time must exclude capacity waiting');
  assert.equal(after.publicActive, before.publicActive, 'the public meter must also stay frozen');
  assert.equal(after.clockRunning, false, 'waiting must not show a running billing clock');
}

async function fixture(kind: Kind) {
  const pool = new Pool({connectionString: connection, max: 6});
  const owner = uid();
  const files = new Map<string, Buffer>();
  const blobs: PrivateBlobs = {
    put: async (key, bytes) => { files.set(key, Buffer.from(bytes)); },
    get: async key => files.get(key)!,
    getIfExists: async key => files.get(key) ?? null,
    getIfExistsBounded: async (key, max) => { const bytes = files.get(key); return bytes && bytes.length <= max ? bytes : null; },
    exists: async key => files.has(key),
    delete: async key => { files.delete(key); }
  };
  const app = createServer({
    pool, blobs, enableSyntheticQueue: true, enablePaidAuthoring: true, enablePaidReview: true,
    principal: async () => ({userId: owner, csrfVerified: true}),
    allowedOrigin: 'http://bondbuddy.test', historicalBillingFixture: true
  });
  const send = (method: string, url: string, payload?: unknown) => app.inject({
    method: method as any, url, payload: payload as any, headers: {origin: 'http://bondbuddy.test'}
  });
  const ok = (response: Awaited<ReturnType<typeof send>>) => {
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
    return response.json();
  };
  const permits: ModelCallPermit[] = [];
  const pending: Waiting[] = [];
  const children: ChildProcess[] = [];
  let runId: string | undefined;
  const close = async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    pending.forEach(waiting => waiting.controller.abort(new Error('Synthetic test cleanup')));
    for (const waiting of pending) {
      const result = await waiting.result;
      if (result.permit) await result.permit.release();
    }
    await Promise.all(permits.map(permit => permit.release()));
    // A SIGKILL intentionally bypasses the child waiter finally. Remove only this
    // synthetic run's orphan queue entry; production recovery keeps its own TTL/fence.
    if (runId) await pool.query('DELETE FROM bb_model_capacity_waiters WHERE scope=$1', ['run:' + runId]);
    await app.close();
    await pool.end();
  };
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, 'capacity_' + owner.slice(0, 8)]);
    await transaction(pool, client => grantCredits(client, {
      owner, points: 100000, key: uid(), source: 'existing_grant', expiresAt: null,
      actor: 'synthetic', reason: 'Isolated model capacity billing regression'
    }));
    priceSeed ??= publishPrices(pool, {
      id: 'capacity-wait-regression',
      prices: {...INITIAL_FIXED_PRICES, new_authoring: 10000, full_review: 10000, differential_review: 1000, review_revision: 200},
      effectiveAt: '2020-01-01T00:00:00Z', actor: 'synthetic', reason: 'Isolated capacity billing test tariff'
    }).then(() => {});
    await priceSeed;
    let started: any;
    if (kind === 'update') {
      const project = ok(await send('POST', '/api/v1/projects', {
        kind, name: 'Synthetic capacity billing authoring', issuer_name: 'Synthetic issuer',
        market: 'sse', offering: 'private',
        update_details: {...emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2026-09-30'}
      }));
      const reference = await uploadSyntheticReference(app, project.project_id);
      const input = ok(await send('POST', '/api/v1/projects/' + project.project_id + '/input-revisions', reference));
      const quote = ok(await send('POST', '/api/v1/projects/' + project.project_id + '/credit-quote', {
        input_revision: input.input_revision, input_hash: input.input_hash
      }));
      started = ok(await send('POST', '/api/v1/runs/execute', {
        execution_request_id: uid(), project_id: project.project_id, input_revision: input.input_revision,
        input_hash: input.input_hash, task_kind: kind, input_manifest_ref: input.input_hash,
        storage_origin: 'cloud', workspace_id: project.project_id, quote_id: quote.quote.quote_id
      }));
    } else {
      const topic = kind === 'generation'
        ? ok(await send('POST', '/api/v1/m4/topics', {creation_request_id: uid(), name: 'Synthetic capacity billing document'})).topic
        : ok(await send('POST', '/api/v1/projects', {kind, name: 'Synthetic capacity billing review', issuer_name: null, market: null, offering: null}));
      const project = topic.project_id, upload = uid(), material = uid(), sha = digest('Synthetic capacity material');
      const role = kind === 'review' ? 'historical' : 'other';
      await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,$5,$6,now()+interval '1 hour','completed')",
        [upload, owner, project, sha, role, 'synthetic/' + upload]);
      await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',16,$6,$7,'persisted')",
        [material, owner, project, upload, role, sha, 'synthetic/' + material]);
      if (kind === 'generation') {
        const base = '/api/v1/m4/topics/' + topic.topic_id;
        const pin = {source_project_id: project, material_id: material, material_version: 1, sha256: sha};
        ok(await send('PUT', base + '/drafts/underwriter', {
          expected_version: 0,
          input: {...emptyM4Draft('underwriter'), materials: [pin], fields: {market: 'sse', issuer_name: 'Synthetic issuer'}}
        }));
        const quote = ok(await send('POST', base + '/quote', {kind: 'document', document_type: 'underwriter', expected_draft_version: 1}));
        started = ok(await send('POST', base + '/execute', {
          execution_request_id: uid(), document_type: 'underwriter', expected_draft_version: 1,
          quote_id: quote.quote.quote_id, entrypoint: 'workspace'
        })).run;
      } else {
        const base = '/api/v1/projects/' + project;
        const pin = {material_id: material, material_version: 1, sha256: sha};
        ok(await send('PUT', base + '/review-draft', {
          kind: 'input', expected_version: 0,
          input: {source_material_ref: pin, material_versions: [pin], requirements: ['Synthetic requirement'], as_of: null}
        }));
        const request = {execution_request_id: uid(), operation: 'full_review', expected_input_version: 1,
          source_report_id: null, expected_plan_version: null, finding_ids: []};
        const quote = ok(await send('POST', base + '/review-executions/quote', request));
        started = ok(await send('POST', base + '/review-executions', {...request, quote_id: quote.quote.quote_id}));
      }
    }
    runId = started.run_id;
    const lease = await claim(pool, 120, {runKinds: [kind]});
    assert.ok(lease);
    assert.equal(lease.runId, runId);
    await checkpointStage(pool, lease, 'materials_ready', {synthetic: true});
    const sample = async (): Promise<Sample> => {
      const row = (await pool.query('SELECT c.charged_points::text,m.active_ms::text,c.billing_policy FROM bb_credit_reservations c JOIN bb_authoring_progress m ON m.run_id=c.run_id WHERE c.run_id=$1', [runId])).rows[0];
      assert.equal(row.billing_policy, 'authoring_balance_v2', 'fixture must exercise historical dynamic billing');
      const publicMeter = await readAuthoringProgress(pool, owner, runId!);
      assert.ok(publicMeter);
      return {charged: BigInt(row.charged_points), active: BigInt(row.active_ms),
        publicActive: BigInt(publicMeter.active_ms), clockRunning: publicMeter.clock_running, modelWaiting: publicMeter.model_waiting === true};
    };
    const journal = (activeLease: Lease = lease) => new CodexDurableJournal({pool, blobs, lease: activeLease, validateResult: () => true});
    const block = async (count = 4, local = false) => {
      const budget = local ? modelCallBudgetFor(pool) : new PgModelCallBudget(pool);
      const held = await Promise.all(Array.from({length: count}, (_, i) => budget.acquire(undefined, 'fixture:' + owner + ':' + i)));
      permits.push(...held);
      return held;
    };
    const startWaiting = (activeLease: Lease = lease): Waiting => {
      const waiting = {controller: new AbortController(), granted: false, settled: false} as Waiting;
      waiting.result = journal(activeLease).acquireCallSlot(waiting.controller.signal).then(
        permit => { waiting.granted = true; waiting.settled = true; permits.push(permit); return {permit, error: null}; },
        error => { waiting.settled = true; return {permit: null, error}; }
      );
      pending.push(waiting);
      return waiting;
    };
    const waitRegistered = async (waiting: Waiting) => until(async () => {
      if (waiting.settled) throw new Error('Expected a blocked capacity waiter: ' + String((await waiting.result).error));
      return (await pool.query('SELECT 1 FROM bb_model_capacity_waiters WHERE scope=$1', ['run:' + runId])).rowCount! > 0;
    }, 'Run did not enter the shared model capacity queue');
    const attempts = async () => (await pool.query('SELECT count(*)::integer n FROM bb_model_call_attempts WHERE job_id=$1', [lease.jobId])).rows[0].n as number;
    const act = async (action: string) => ok(await send('POST', '/api/v1/runs/' + runId + '/' + action, {reason: 'synthetic-capacity-regression'}));
    return {pool, owner, runId: runId!, lease, sample, journal, block, startWaiting, waitRegistered, attempts, act, permits, children, close};
  } catch (error) { await close(); throw error; }
}

async function assertResumed(f: Awaited<ReturnType<typeof fixture>>, waiting: Waiting, blocker: ModelCallPermit, before: Sample, lease = f.lease) {
  const releaseStarted = Date.now();
  await blocker.release();
  const result = await waiting.result;
  assert.ifError(result.error);
  assert.ok(result.permit);
  const resumed = await f.sample();
  assert.equal(resumed.clockRunning, true);
  assert.equal(resumed.modelWaiting, false);
  const holder = (await f.pool.query('SELECT admission_job_id FROM bb_model_capacity_holders WHERE scope=$1', ['run:' + f.runId])).rows;
  assert.ok(holder.some(row => row.admission_job_id === lease.jobId), 'journal must preserve the execution admission identity');
  assert.ok(Number(resumed.active - before.active) <= Date.now() - releaseStarted + 250,
    'resuming may count new work, but must not retroactively add the excluded wait');
  await delay(waitMs);
  await renew(f.pool, lease, 120);
  const working = await f.sample();
  assert.ok(working.active > resumed.active + BigInt(waitMs - 200), 'real active time must resume');
  assert.ok(working.charged > before.charged, 'resumed work must not become free');
}

for (const kind of ['update', 'generation', 'review'] as const) {
  test(kind + ': shared-capacity waiting freezes both credit debit and public time; grant resumes without backcharge',
    {skip: !connection, timeout: 90000}, async () => {
      const f = await fixture(kind);
      try {
        const held = await f.block();
        const waiting = f.startWaiting();
        await f.waitRegistered(waiting);
        await renew(f.pool, f.lease, 120);
        const before = await f.sample();
        assert.equal(before.clockRunning, false);
        assert.equal(before.modelWaiting, true);
        await delay(waitMs);
        await renew(f.pool, f.lease, 120);
        assertFrozen(before, await f.sample());
        await renew(f.pool, f.lease, 120);
        assertFrozen(before, await f.sample());
        assert.equal(waiting.granted, false);
        assert.equal(await f.attempts(), 0);
        await assertResumed(f, waiting, held[0]!, before);
        assert.equal(await f.attempts(), 0, 'permit bookkeeping does not invent provider usage');
      } finally { await f.close(); }
    });
}

test('cancellation while waiting keeps the frozen charge and late capacity cleanup cannot reopen its clock',
  {skip: !connection, timeout: 90000}, async () => {
    const f = await fixture('generation');
    try {
      await f.block();
      const waiting = f.startWaiting();
      await f.waitRegistered(waiting);
      await renew(f.pool, f.lease, 120);
      const before = await f.sample();
      await f.act('cancel');
      waiting.controller.abort(new Error('Synthetic user cancellation'));
      assert.ok((await waiting.result).error);
      await delay(200);
      assertFrozen(before, await f.sample());
      await assert.rejects(renew(f.pool, f.lease, 120));
      assert.equal((await f.pool.query('SELECT state FROM bb_runs WHERE id=$1', [f.runId])).rows[0].state, 'cancelled');
      assert.equal(await f.attempts(), 0);
    } finally { await f.close(); }
  });

test('manual pause during capacity waiting stays free; user resume with a new lease restarts billing',
  {skip: !connection, timeout: 90000}, async () => {
    const f = await fixture('generation');
    try {
      const held = await f.block();
      const oldWaiting = f.startWaiting();
      await f.waitRegistered(oldWaiting);
      await renew(f.pool, f.lease, 120);
      const before = await f.sample();
      await f.act('pause');
      assert.equal(await pauseAtCheckpoint(f.pool, f.lease), true);
      oldWaiting.controller.abort(new Error('Synthetic user pause'));
      assert.ok((await oldWaiting.result).error);
      assertFrozen(before, await f.sample());
      await f.act('resume');
      const resumed = await claim(f.pool, 120, {runKinds: ['generation']});
      assert.ok(resumed);
      assert.notEqual(resumed.token, f.lease.token);
      const waiting = f.startWaiting(resumed);
      await f.waitRegistered(waiting);
      await renew(f.pool, resumed, 120);
      const frozen = await f.sample();
      await delay(waitMs);
      await renew(f.pool, resumed, 120);
      assertFrozen(frozen, await f.sample());
      await assertResumed(f, waiting, held[0]!, frozen, resumed);
    } finally { await f.close(); }
  });

test('a stale waiter callback after lease recovery cannot freeze or reopen the replacement lease clock',
  {skip: !connection, timeout: 90000}, async () => {
    const f = await fixture('generation');
    try {
      const held = await f.block();
      const oldWaiting = f.startWaiting();
      await f.waitRegistered(oldWaiting);
      await renew(f.pool, f.lease, 120);
      // Simulate lease expiry without altering the billing cursor or request state.
      await f.pool.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [f.lease.jobId]);
      const recovered = await claim(f.pool, 120, {runKinds: ['generation']});
      assert.ok(recovered);
      assert.notEqual(recovered.token, f.lease.token);
      oldWaiting.controller.abort(new Error('Synthetic late old-lease abort'));
      assert.ok((await oldWaiting.result).error);
      const replacement = await f.sample();
      assert.equal(replacement.clockRunning, true, 'old wait must not remain attached to replacement work');
      await assert.rejects(renew(f.pool, f.lease, 120));
      const waiting = f.startWaiting(recovered);
      await f.waitRegistered(waiting);
      await renew(f.pool, recovered, 120);
      const frozen = await f.sample();
      await delay(waitMs);
      await renew(f.pool, recovered, 120);
      assertFrozen(frozen, await f.sample());
      await assertResumed(f, waiting, held[0]!, frozen, recovered);
    } finally { await f.close(); }
  });

test('an active sibling keeps billing while another call waits; releasing the last active sibling freezes the run',
  {skip: !connection, timeout: 90000}, async () => {
    const f = await fixture('generation');
    try {
      // Reserve three foreign slots, then one actual slot for this run.
      const held = await f.block(3);
      const active = await f.journal().acquireCallSlot();
      f.permits.push(active);
      const waiting = f.startWaiting();
      await f.waitRegistered(waiting);
      await renew(f.pool, f.lease, 120);
      const before = await f.sample();
      assert.equal(before.clockRunning, true);
      await delay(waitMs);
      await renew(f.pool, f.lease, 120);
      const working = await f.sample();
      assert.ok(working.active > before.active + BigInt(waitMs - 200));
      assert.ok(working.charged > before.charged, 'waiting sibling must not make the active sibling free');
      // Hold the grant boundary to observe the all-waiting interval deterministically.
      // Hold the capacity transaction lock so the current waiter cannot be granted
      // in the interval after releasing the last active permit.
      const guard = await f.pool.connect();
      try {
        await guard.query('BEGIN');
        await guard.query('SELECT pg_advisory_xact_lock($1::integer,0)', [0x42424d43]);
        await active.release();
        await renew(f.pool, f.lease, 120);
        const frozen = await f.sample();
        assert.equal(frozen.clockRunning, false, 'only waiting work remains');
        await delay(waitMs);
        await renew(f.pool, f.lease, 120);
        assertFrozen(frozen, await f.sample());
      } finally { await guard.query('ROLLBACK'); guard.release(); }
      const result = await waiting.result;
      assert.ifError(result.error);
      assert.ok(result.permit);
      assert.equal(await f.attempts(), 0);
      await Promise.all(held.map(permit => permit.release()));
    } finally { await f.close(); }
  });

test('SIGKILL during capacity wait leaves no billable waiting interval and a fresh lease is not permanently frozen',
  {skip: !connection, timeout: 120000}, async () => {
    const f = await fixture('generation');
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    let childError = '';
    let childReady = false;
    const childStarted = Date.now();
    try {
      await f.block();
      const source = [
        "import {Pool} from 'pg';",
        "import {CodexDurableJournal} from './apps/worker/dist/durable-probe-journal.js';",
        "console.log('capacity-child-ready');",
        "const pool=new Pool({connectionString:process.env.BB_CAPACITY_TEST_DATABASE_URL});",
        "const lease=JSON.parse(process.env.BB_CAPACITY_TEST_LEASE);",
        "const blobs={put:async()=>{},get:async()=>Buffer.alloc(0),getIfExists:async()=>null,getIfExistsBounded:async()=>null,exists:async()=>false,delete:async()=>{}};",
        "await new CodexDurableJournal({pool,blobs,lease,validateResult:()=>true}).acquireCallSlot();",
        "throw Error('Synthetic crash waiter unexpectedly obtained capacity');"
      ].join('\n');
      child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        cwd: process.cwd(),
        env: {...process.env, BB_CAPACITY_TEST_DATABASE_URL: connection!, BB_CAPACITY_TEST_LEASE: JSON.stringify(f.lease)},
        stdio: ['ignore', 'pipe', 'pipe']
      });
      f.children.push(child);
      child.stdout?.on('data', bytes => { if (String(bytes).includes('capacity-child-ready')) childReady = true; });
      child.stderr?.on('data', bytes => { childError = (childError + String(bytes)).slice(-4000); });
      exited = new Promise<void>(resolve => child!.once('close', () => resolve()));
      await until(async () => {
        if (child!.exitCode !== null || child!.signalCode !== null) throw new Error('Synthetic child exited during imports: ' + childError);
        return childReady;
      }, 'Synthetic child journal imports did not become ready', 60000);
      console.log(JSON.stringify({kind: 'synthetic_crash_child_ready', startup_ms: Date.now() - childStarted}));
      await until(async () => {
        if (child!.exitCode !== null || child!.signalCode !== null) throw new Error('Synthetic child exited: ' + childError);
        return (await f.pool.query('SELECT 1 FROM bb_model_capacity_waiters WHERE scope=$1', ['run:' + f.runId])).rowCount! > 0;
      }, 'Child did not register its capacity waiter');
      await renew(f.pool, f.lease, 120);
      const before = await f.sample();
      await delay(waitMs);
      await renew(f.pool, f.lease, 120);
      assertFrozen(before, await f.sample());
      child.kill('SIGKILL');
      await exited;
      await f.pool.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [f.lease.jobId]);
      const recovered = await claim(f.pool, 120, {runKinds: ['generation']});
      assert.ok(recovered);
      assert.notEqual(recovered.token, f.lease.token);
      const resumed = await f.sample();
      assert.equal(resumed.clockRunning, true);
      assert.equal(resumed.active, before.active, 'restart must not backcharge the excluded wait');
      await delay(waitMs);
      await renew(f.pool, recovered, 120);
      const working = await f.sample();
      assert.ok(working.active > resumed.active + BigInt(waitMs - 200));
      assert.ok(working.charged > resumed.charged, 'replacement lease may bill its new active work');
      assert.equal(await f.attempts(), 0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (exited) await exited;
      await f.close();
    }
  });


test('the process-local admission queue freezes billing before any PostgreSQL waiter is registered',
  {skip: !connection, timeout: 90000}, async () => {
    const f = await fixture('generation');
    try {
      // These occupy the journal's exact in-process budget, so acquire() blocks
      // in enter() and has not yet created a global capacity waiter row.
      const held = await f.block(4, true);
      const waiting = f.startWaiting();
      await until(async () => {
        if (waiting.settled) throw new Error('Expected process-local wait: ' + String((await waiting.result).error));
        return (await f.pool.query("SELECT 1 FROM bb_run_model_activity WHERE job_id=$1 AND lease_token=$2 AND state='waiting'", [f.lease.jobId, f.lease.token])).rowCount! > 0;
      }, 'Journal did not register the process-local capacity wait');
      assert.equal((await f.pool.query('SELECT count(*)::integer n FROM bb_model_capacity_waiters WHERE scope=$1', ['run:' + f.runId])).rows[0].n, 0);
      await renew(f.pool, f.lease, 120);
      const before = await f.sample();
      await delay(waitMs);
      await renew(f.pool, f.lease, 120);
      assertFrozen(before, await f.sample());
      await assertResumed(f, waiting, held[0]!, before);
      assert.equal(await f.attempts(), 0);
    } finally { await f.close(); }
  });

test('an aborted acquisition stays frozen while termination is pending and cannot charge the cleanup gap',
  {skip: !connection, timeout: 90000}, async () => {
    const f = await fixture('generation');
    try {
      await f.block();
      const waiting = f.startWaiting();
      await f.waitRegistered(waiting);
      await renew(f.pool, f.lease, 120);
      const before = await f.sample();
      waiting.controller.abort(new Error('Synthetic acquisition failure before terminal handling'));
      assert.ok((await waiting.result).error);
      // Deliberately leave the task running while outer error handling is delayed.
      // A naive finally() that simply resumes the meter would charge this interval.
      await delay(waitMs);
      await renew(f.pool, f.lease, 120);
      assertFrozen(before, await f.sample());
      assert.equal((await f.pool.query('SELECT state FROM bb_runs WHERE id=$1', [f.runId])).rows[0].state, 'running');
      await f.act('cancel');
      assertFrozen(before, await f.sample());
      assert.equal(await f.attempts(), 0);
    } finally { await f.close(); }
  });


test('an abandoned sibling stays frozen after a later active sibling completes',
  {skip: !connection, timeout: 90000}, async () => {
    const f = await fixture('generation');
    try {
      const held = await f.block();
      const abandoned = f.startWaiting();
      await f.waitRegistered(abandoned);
      const survivor = f.startWaiting();
      await until(async () => (await f.pool.query(
        "SELECT count(*)::integer n FROM bb_run_model_activity WHERE job_id=$1 AND lease_token=$2 AND state='waiting'",
        [f.lease.jobId, f.lease.token])).rows[0].n === 2, 'Both sibling requests did not enter waiting');
      abandoned.controller.abort(new Error('Synthetic sibling failure before terminal handling'));
      assert.ok((await abandoned.result).error);
      await renew(f.pool, f.lease, 120);
      const before = await f.sample();
      assert.equal(before.clockRunning, false);
      await assertResumed(f, survivor, held[0]!, before);
      const active = (await survivor.result).permit;
      assert.ok(active);
      await active.release();
      const frozen = await f.sample();
      assert.equal(frozen.clockRunning, false, 'the earlier abandoned sibling is still awaiting durable handling');
      await delay(waitMs);
      await renew(f.pool, f.lease, 120);
      assertFrozen(frozen, await f.sample());
      await f.act('cancel');
      assertFrozen(frozen, await f.sample());
      assert.equal(await f.attempts(), 0);
    } finally { await f.close(); }
  });
