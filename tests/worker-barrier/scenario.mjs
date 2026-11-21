import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from '/app/node_modules/pg/lib/index.js';
import { WorkerRuntime } from './runtime-impl.js';
import { isolatedTestDatabase } from './test-database.js';
import { spawn, initializeTaskExecution } from './task-execution.js';
import {
  executionCapacityControl, configureExecutionCapacity, bindExecutionRegistration,
  registerExecutionRuntime, heartbeatExecutionRuntime,
} from '/app/apps/api/dist/execution-capacity.js';
import { inputManifestHash } from '/app/apps/api/dist/production-rule-pin.js';

const { Pool } = pg;
const group = JSON.parse(await readFile(new URL('./selected-group.json', import.meta.url), 'utf8'));
const hash = 'a'.repeat(64);
const events = [], samples = [];

async function until(check, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error('SCENARIO_STATE_TIMEOUT');
    await delay(20);
  }
}

async function enroll(admin, worker) {
  const context = JSON.parse(process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT);
  const control = executionCapacityControl(admin);
  await configureExecutionCapacity(admin, 0, {
    managed_nodes: true, global_model_limit: Math.max(4, group.slots),
    max_nodes: 2, budget_available: true,
    node_model_limit: Math.max(4, group.slots),
    provider_concurrency_limit: Math.max(4, group.slots),
    provider_policy_sha256: hash, expense_policy_sha256: hash,
  });
  let operation = await control.reserveStart({
    ...context.identity, instance_id: null, instance_count: 1,
    source_sha256: hash, image_sha256: hash, launch_manifest_sha256: hash,
    capabilities: ['authoring'], services: [{ service_id: 'author', capabilities: ['authoring'] }],
  }, randomUUID(), (await control.snapshot()).policy.revision);
  operation = await control.claimCloudDispatch(operation.operation_id, operation.revision);
  const ack = randomUUID(), identity = context.identity;
  operation = await control.recordCloudResult(operation.operation_id, operation.revision, {
    state: 'submitted', identity, provider_request_id: ack, observation: null,
    run_acceptance: {
      operation_id: operation.operation_id, identity, provider_request_id: ack,
      instance_ids: [identity.instance_id], client_token: operation.client_token,
      launch_manifest_sha256: hash, launch_binding_sha256: hash,
      evidence_ref: 'synthetic-barrier-matrix', evidence_sha256: hash,
    },
  });
  await control.recordCloudResult(operation.operation_id, operation.revision, {
    state: 'completed', identity, provider_request_id: ack,
    observation: {
      instance_state: 'RUNNING', latest_operation: 'RunInstances',
      latest_operation_state: 'SUCCESS', latest_operation_request_id: ack,
      stop_charging_mode: null, observed_at: new Date().toISOString(),
      evidence_ref: 'synthetic-barrier-matrix', evidence_sha256: hash,
      run_creation: {
        operation_id: operation.operation_id, identity,
        launch_manifest_sha256: hash, launch_binding_sha256: hash,
        created_at: new Date().toISOString(), instance_status: 'RUNNING',
        status_request_id: 'synthetic',
      },
    },
  });
  const registration = 'synthetic-barrier-matrix-registration';
  await bindExecutionRegistration(admin, identity, operation.operation_id, registration);
  await registerExecutionRuntime(worker, context, {
    service_id: 'author', capabilities: ['authoring'],
    source_sha256: hash, image_sha256: hash, launch_manifest_sha256: hash,
    registration_token: registration, process_identity: { pid: String(process.pid) },
  });
  await heartbeatExecutionRuntime(worker, { native_processes: 0, unpersisted_results: 0, ready: true });
  await initializeTaskExecution(worker);
}

test(`worker-barrier: ${group.id}`, { timeout: 60000 }, async t => {
  const database = await isolatedTestDatabase(undefined, group.id);
  assert.ok(database, 'An isolated, migrated fixture database is required.');
  const admin = new Pool({ connectionString: database });
  const worker = new Pool({ connectionString: database });
  const children = new Set();
  let runtime, evidence;
  t.after(async () => {
    try {
      for (const child of children) child.kill('SIGTERM');
      if (runtime) await runtime.stop();
    } finally {
      await worker.end();
      await admin.end();
      console.log(JSON.stringify({ barrier_evidence: evidence ?? {
        group: group.id, status: 'failed', events, samples,
      } }));
    }
  });
  await enroll(admin, worker);
  const owner = randomUUID(), names = new Map();
  await admin.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, 'matrix_' + owner.slice(0, 8)]);
  async function add(label) {
    const id = randomUUID(), manifest = { synthetic: true }, inputHash = inputManifestHash(manifest);
    await admin.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,'generation')", [id, owner, label]);
    await admin.query(`INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,1,1,$3,$4,'[]','[]')`, [id, owner, inputHash, manifest]);
    await admin.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')`, [id, owner, inputHash]);
    await admin.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,checkpoint)
      VALUES($1,$2,$1,'generation','default','queued',$3)`, [id, owner, { stages: { input_lock: { synthetic: true } } }]);
    names.set(id, label);
    return id;
  }
  const a = await add('A'), peers = [];
  for (let i = 0; i < group.peer_seconds.length; i++) peers.push(await add(`B${i + 1}`));
  const started = performance.now(), startedPeers = new Set();
  const now = () => Math.round(performance.now() - started);
  function record(event, fields = {}) {
    const row = { ms: now(), event, ...fields };
    events.push(row);
    console.log(JSON.stringify({ group: group.id, ...row }));
  }
  function childExit(child) {
    children.add(child);
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        children.delete(child);
        code === 0 ? resolve() : reject(new Error(`SYNTHETIC_CHILD_EXIT:${code}:${signal}`));
      });
    });
  }
  async function fakeCodex(label, seconds, signal, attempt) {
    const child = spawn('sleep', [String(seconds)], { stdio: 'ignore' });
    const done = childExit(child), abort = () => child.kill('SIGTERM');
    record('fake_codex_spawn', { job: label, attempt, pid: child.pid, sleep_seconds: seconds });
    signal.addEventListener('abort', abort, { once: true });
    try { if (signal.aborted) abort(); await done; }
    finally { signal.removeEventListener('abort', abort); }
    record('fake_codex_exit', { job: label, attempt, pid: child.pid });
  }
  let tailDone, tailFailure;
  async function startTail() {
    const child = spawn('/usr/bin/python3', ['-c',
      `import time;print("ready",flush=True);time.sleep(${group.native_tail_seconds})`],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    tailDone = childExit(child).then(() => record('native_tail_exit', { job: 'A', pid: child.pid }),
      error => { tailFailure = error; });
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('close', () => reject(new Error('NATIVE_TAIL_NOT_READY')));
    });
    record('native_tail_ready', { job: 'A', pid: child.pid });
  }
  runtime = new WorkerRuntime({
    pool: worker, blobs: {}, kinds: ['run'], runKinds: ['generation'],
    concurrency: group.slots, interactiveSlots: 0, parseSlots: 0,
    pollMs: 20, heartbeatMs: 100, sweepMs: 1000, leaseSeconds: 60,
    executionTransport: { refresh: async () => {}, ready: () => true, close: () => {} },
    log: event => {
      if (event.kind === 'run' && event.outcome === 'retry') record('worker_retry');
      if (event.kind === 'run' && event.outcome === 'error') record('worker_error', { error: event.error });
    },
    runStages: [{
      name: 'model_generation',
      run: async ctx => {
        const label = names.get(ctx.lease.jobId), attempt = ctx.lease.attempts;
        record('stage_start', { job: label, attempt });
        if (label.startsWith('B')) {
          startedPeers.add(label);
          await fakeCodex(label, group.peer_seconds[Number(label.slice(1)) - 1], ctx.signal, attempt);
        } else if (label === 'A') {
          await until(async () => startedPeers.size === peers.length);
          await fakeCodex(label, attempt === 1 ? group.a_seconds : group.retry_seconds, ctx.signal, attempt);
          if (attempt === 1 && group.native_tail_seconds) await startTail();
          if (group.retry) throw new Error('Synthetic retryable failure after fake Codex exit.');
        } else {
          await fakeCodex(label, group.c_seconds, ctx.signal, attempt);
        }
        // sleep is not a Word deliverable; synthetic jobs terminate explicitly failed.
        return { kind: 'fail', code: 'DATA_UNAVAILABLE' };
      },
    }],
  }).start();
  await until(async () => events.some(e => e.event === 'fake_codex_exit' && e.job === 'A'));
  if (group.retry) await until(async () => events.some(e => e.event === 'worker_retry'));
  const c = await add('C'), ids = [a, ...peers, c];
  record('queue_insert', { job: 'C' });
  while (!events.some(e => e.event === 'stage_start' && e.job === 'C')) {
    samples.push({ ms: now(), jobs: (await admin.query(
      'SELECT id,state,attempts FROM bb_jobs WHERE id=ANY($1::text[])', [ids])).rows.map(j => ({ job: names.get(j.id), state: j.state, attempts: j.attempts })) });
    if (now() > 20000) throw new Error('C_ADMISSION_TIMEOUT');
    await delay(50);
  }
  await until(async () => (await admin.query(
    "SELECT count(*)::int n FROM bb_jobs WHERE id=ANY($1::text[]) AND state='failed'", [ids])).rows[0].n === ids.length);
  if (tailDone) await tailDone;
  if (tailFailure) throw tailFailure;
  const cStarted = events.find(e => e.event === 'stage_start' && e.job === 'C').ms;
  const cQueued = events.find(e => e.event === 'queue_insert').ms;
  const peerExits = events.filter(e => e.event === 'fake_codex_exit' && e.job.startsWith('B'));
  assert.equal(peerExits.length, peers.length);
  assert.ok(peerExits.every(e => cStarted < e.ms), 'C must start before every sleeping peer exits.');
  const aStarts = events.filter(e => e.event === 'stage_start' && e.job === 'A');
  assert.equal(aStarts.length, group.retry ? 3 : 1);
  assert.ok(events.filter(e => e.event === 'fake_codex_exit' && e.job === 'A')
    .every(e => e.ms < Math.min(...peerExits.map(p => p.ms))), 'A must finish its attempts before the long peers exit.');
  if (group.native_tail_seconds) {
    const tailExit = events.find(e => e.event === 'native_tail_exit');
    assert.ok(tailExit);
    assert.ok(cStarted < tailExit.ms, 'A native tail must not block C.');
    assert.ok(aStarts.filter(e => e.attempt > 1).every(e => e.ms >= tailExit.ms),
      'A must not retry while its own native tail remains alive.');
  }
  const finalJobs = (await admin.query(
    'SELECT id,state,attempts,lease_token FROM bb_jobs WHERE id=ANY($1::text[])', [ids])).rows;
  assert.ok(finalJobs.every(j => j.state === 'failed' && j.lease_token === null));
  assert.ok(finalJobs.filter(j => j.id !== a).every(j => j.attempts === 1));
  evidence = {
    group: group.id, status: 'passed', synthetic: true, slots: group.slots,
    c_queued_ms: cQueued, c_started_ms: cStarted, c_wait_ms: cStarted - cQueued,
    earliest_peer_exit_ms: Math.min(...peerExits.map(e => e.ms)),
    a_attempts: aStarts.length, c_started_while_peers_running: true,
    native_tail_checked: group.native_tail_seconds > 0, events, samples,
    final_jobs: finalJobs.map(j => ({ ...j, job: names.get(j.id) })),
  };
  await runtime.stop();
});
