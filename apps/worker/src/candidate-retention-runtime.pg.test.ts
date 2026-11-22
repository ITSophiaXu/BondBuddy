import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { bindExecutionRegistration, configureExecutionCapacity, executionCapacityControl, registerExecutionRuntime } from '@bondbuddy/api/execution-capacity';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { WorkerRuntime, type WorkerRuntimeOptions } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';
import {initializeTaskExecution} from './task-execution.js';

const configured = !!process.env.BB_TEST_DATABASE_URL;
const selected=process.env.BB_RETENTION_NATIVE_CASE;
if(selected&&!['pending','unreadable','admission'].includes(selected))throw Error('RETENTION_NATIVE_CASE_INVALID');
// Each case has its own enrolled process: task identity cannot be reset or
// transferred to a different pool after a managed runtime has stopped.
function retentionTest(id:string,name:string,options:{skip:boolean;timeout:number},run:(t:TestContext)=>Promise<void>){
  if(!selected||selected===id)test(name,options,run);
}
type Retention = { pendingCount(): Promise<number> };

async function until(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail('Synthetic candidate retention state did not settle');
}

async function fixture(t: TestContext, label: string, retention: Retention, releaseInventory: () => void,
  overrides: Pick<WorkerRuntimeOptions, 'runStages' | 'heartbeatMs'> = {}) {
  const connection = await isolatedTestDatabase(undefined, `candidate-retention-${label}`);
  const pool = new Pool({ connectionString: connection, max: 4 });
  const control = executionCapacityControl(pool);
  const hash = 'a'.repeat(64);
  const native=process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT?JSON.parse(process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT):null;
  if(!native)throw Error('RETENTION_NATIVE_FIXTURE_REQUIRED');
  const identity = native.identity;
  await configureExecutionCapacity(pool, 0, { managed_nodes: true, global_model_limit: 4, max_nodes: 2, budget_available: true });
  let operation = await control.reserveStart({ ...identity, instance_id: null, instance_count: 1, source_sha256: hash,
    image_sha256: hash, launch_manifest_sha256: hash, capabilities: ['authoring'],
    services: [{ service_id: 'one', capabilities: ['authoring'] }] }, `retention-start-${label}`, 1);
  operation = await control.claimCloudDispatch(operation.operation_id, 0);
  operation = await control.recordCloudResult(operation.operation_id, operation.revision,
    { state: 'submitted', identity, provider_request_id: `retention-ack-${label}`, observation: null,
      run_acceptance: { operation_id: operation.operation_id, identity, provider_request_id: `retention-ack-${label}`,
        instance_ids: [identity.instance_id], client_token: operation.client_token, launch_manifest_sha256: hash,
        launch_binding_sha256: hash, evidence_ref: 'synthetic-retention-accepted.json', evidence_sha256: hash } });
  await control.recordCloudResult(operation.operation_id, operation.revision, { state: 'completed', identity,
    provider_request_id: `retention-ack-${label}`, observation: { instance_state: 'RUNNING', latest_operation: 'RunInstances',
      latest_operation_state: 'SUCCESS', latest_operation_request_id: `retention-ack-${label}`, stop_charging_mode: null,
      observed_at: new Date().toISOString(), evidence_ref: 'synthetic-retention-describe.json', evidence_sha256: hash,
      run_creation: { operation_id: operation.operation_id, identity, launch_manifest_sha256: hash, launch_binding_sha256: hash,
        created_at: new Date().toISOString(), instance_status: 'RUNNING', status_request_id: 'synthetic-retention-status' } } });
  const token = 'synthetic-retention-registration-012345';
  const sessionId = native.session_id;
  await bindExecutionRegistration(pool, identity, `retention-start-${label}`, token);
  await registerExecutionRuntime(pool, { identity, session_id: sessionId }, { source_sha256: hash, image_sha256: hash,
    launch_manifest_sha256: hash, registration_token: token, service_id: 'one', capabilities: ['authoring'],
    process_identity: { pid: String(process.pid) } });
  const logs: Record<string, unknown>[] = [];
  const blobs = new Proxy({}, { get: () => async () => { throw Error('No synthetic blob read expected'); } }) as PrivateBlobs;
  // The intersection intentionally compiles against the pre-fix runtime, which ignores
  // this dependency and incorrectly advertises zero unpersisted results.
  const options: WorkerRuntimeOptions & { candidateRetention: Retention } = {
    pool, blobs, candidateRetention: retention, kinds: ['run'], runKinds: ['generation'], concurrency: 1,
    interactiveSlots: 0, parseSlots: 0, heartbeatMs: 25, pollMs: 25, sweepMs: 25,
    executionTransport: { refresh: async () => {}, ready: () => true, close: () => {} }, log: event => logs.push(event),
    ...overrides
  };
  await initializeTaskExecution(pool);
  const runtime = new WorkerRuntime(options).start();
  t.after(async () => { releaseInventory(); await runtime.stop(); await pool.end(); });
  const session = async () => (await pool.query('SELECT state,ready,unpersisted_results FROM bb_execution_node_sessions WHERE session_id=$1', [sessionId])).rows[0];
  return { pool, control, identity, runtime, logs, session };
}

retentionTest('pending','retained authoring candidates remain unpersisted work and prevent positive drain until preservation is acknowledged',
  { skip: !configured, timeout: 15_000 }, async t => {
    let pending = 0;
    const f = await fixture(t, 'pending', { pendingCount: async () => pending }, () => { pending = 0; });
    await until(async () => (await f.session()).ready);
    pending = 1;
    await f.runtime.heartbeat();
    const active = await f.session();
    assert.equal(active.unpersisted_results, 1, 'a released job lease does not erase its unacknowledged candidate');
    assert.equal(active.ready, false, 'a retained candidate prevents admitting another model call');
    const node = (await f.control.snapshot()).nodes[0]!;
    await f.control.beginDrain(f.identity, 'retention-drain-pending', node.revision);
    let stopped = false;
    const stopping = f.runtime.stop().then(() => { stopped = true; });
    await delay(125);
    assert.equal(stopped, false, 'stop must not certify a session while candidate bytes remain only local');
    assert.equal((await f.session()).state, 'active');
    assert.equal(await f.control.drainProof(f.identity, 'retention-drain-pending'), null);
    pending = 0;
    await stopping;
    assert.equal((await f.session()).state, 'finished');
    assert.ok(await f.control.drainProof(f.identity, 'retention-drain-pending'));
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n, 0);
  });

retentionTest('unreadable','an unreadable retained-candidate inventory is not interpreted as zero at startup',
  { skip: !configured, timeout: 15_000 }, async t => {
    let readable = false;
    const f = await fixture(t, 'unreadable', { pendingCount: async () => {
      if (!readable) throw Error('Synthetic candidate inventory unavailable');
      return 0;
    } }, () => { readable = true; });
    await f.runtime.heartbeat();
    const blocked = await f.session();
    assert.equal(blocked.ready, false, 'startup scan failure cannot advertise an empty ready worker');
    assert.ok(blocked.unpersisted_results >= 1, 'unknown inventory blocks positive zero-work evidence');
    assert.equal((await f.control.snapshot()).nodes[0]!.state, 'starting');
    readable = true;
    await until(async () => (await f.session()).ready);
    await f.runtime.stop();
    assert.equal((await f.session()).state, 'finished');
  });

retentionTest('admission','a newly retained candidate blocks job admission before the next database heartbeat',
  { skip: !configured, timeout: 15_000 }, async t => {
    let pending = 0, executions = 0;
    const f = await fixture(t, 'admission', {pendingCount: async () => pending}, () => {pending = 0;}, {
      heartbeatMs: 5_000,
      runStages: [{name: 'input_lock', run: async () => {
        executions++;
        return {kind: 'pause', stage: 'capability_not_ready', reason: 'synthetic_retention_admission'};
      }}]
    });
    await until(async () => (await f.session()).ready);
    pending = 1;
    // Let the already-started empty claim finish. No heartbeat refresh follows:
    // database readiness remains true, so the local guard is the tested fence.
    await delay(100);
    assert.equal((await f.session()).ready, true);
    const owner = randomUUID(), id = randomUUID(), manifest = {synthetic: true}, hash = inputManifestHash(manifest);
    await f.pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, 'synthetic_retention_' + owner.slice(0, 8)]);
    await f.pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic retention admission','generation')", [id, owner]);
    await f.pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')", [id, owner, hash, manifest]);
    await f.pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')", [id, owner, hash]);
    await f.pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')", [id, owner]);
    await delay(150);
    assert.equal(executions, 0, 'retained candidate bytes block the next model-capable job locally');
    assert.equal((await f.pool.query('SELECT state,lease_token FROM bb_jobs WHERE id=$1', [id])).rows[0].state, 'queued');
    pending = 0;
    await until(async () => executions === 1);
    await f.runtime.stop();
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n, 0);
  });
