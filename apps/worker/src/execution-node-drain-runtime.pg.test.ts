import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import {
  configureExecutionCapacity,
  executionCapacityControl,
  bindExecutionRegistration,
  registerExecutionRuntime,
} from '@bondbuddy/api/execution-capacity';
import { tripEvidenceGate, gateState } from '@bondbuddy/api/evidence-gate';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase(undefined, 'execution-drain-runtime');
test(
  'actual runtime finishes an empty draining session under persistent global pause and retries its positive receipt',
  { skip: !connection, timeout: 10000 },
  async (t) => {
    const pool = new Pool({ connectionString: connection, max: 4 });
    t.after(() => pool.end());
    const hash = 'a'.repeat(64),
      identity = {
        account_id: 'synthetic',
        region: 'synthetic',
        instance_id: 'drain-runtime',
        epoch: randomUUID(),
      },
      control = executionCapacityControl(pool);
    await configureExecutionCapacity(pool, 0, {
      managed_nodes: true,
      global_model_limit: 4,
      max_nodes: 2,
      budget_available: true,
    });
    let op = await control.reserveStart(
      {
        ...identity,
        instance_id: null,
        instance_count: 1,
        source_sha256: hash,
        image_sha256: hash,
        launch_manifest_sha256: hash,
        capabilities: ['authoring'],
        services: [{ service_id: 'one', capabilities: ['authoring'] }],
      },
      'runtime-run',
      1,
    );
    op = await control.claimCloudDispatch(op.operation_id, 0);
    op = await control.recordCloudResult(op.operation_id, op.revision, {
      state: 'submitted',
      identity,
      provider_request_id: 'runtime-ack',
      observation: null,
    });
    await control.recordCloudResult(op.operation_id, op.revision, {
      state: 'completed',
      identity,
      provider_request_id: 'runtime-ack',
      observation: {
        instance_state: 'RUNNING',
        latest_operation: 'RunInstances',
        latest_operation_state: 'SUCCESS',
        latest_operation_request_id: 'runtime-ack',
        stop_charging_mode: null,
        observed_at: new Date().toISOString(),
        evidence_ref: 'synthetic-runtime-describe.json',
        evidence_sha256: hash,
      },
    });
    const token = 'synthetic-runtime-registration-012345';
    await bindExecutionRegistration(pool, identity, 'runtime-run', token);
    await registerExecutionRuntime(
      pool,
      { identity, session_id: randomUUID() },
      {
        source_sha256: hash,
        image_sha256: hash,
        launch_manifest_sha256: hash,
        registration_token: token,
        service_id: 'one',
        capabilities: ['authoring'],
        process_identity: { pid: String(process.pid) },
      },
    );
    await tripEvidenceGate(pool, 'synthetic_other_session_pause');
    // nextval survives rollback, so exactly the first finished write fails.
    await pool.query(`CREATE SEQUENCE synthetic_finish_attempt;
 CREATE FUNCTION synthetic_fail_first_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='finished' AND nextval('synthetic_finish_attempt')=1 THEN RAISE EXCEPTION 'synthetic transient finish failure' USING ERRCODE='08006'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER synthetic_finish_failure BEFORE UPDATE ON bb_execution_node_sessions FOR EACH ROW EXECUTE FUNCTION synthetic_fail_first_finish()`);
    const logs: Record<string, unknown>[] = [];
    const blobs = new Proxy(
      {},
      {
        get: () => async () => {
          throw Error('no blob expected');
        },
      },
    ) as PrivateBlobs;
    const runtime = new WorkerRuntime({
      pool,
      blobs,
      kinds: ['run'],
      runKinds: ['generation'],
      concurrency: 1,
      interactiveSlots: 0,
      parseSlots: 0,
      heartbeatMs: 25,
      pollMs: 25,
      sweepMs: 25,
      executionTransport: { refresh: async () => {}, ready: () => true, close: () => {} },
      log: (e) => logs.push(e),
    }).start();
    t.after(() => runtime.stop());
    for (let n = 0; ; n++) {
      if ((await control.snapshot()).nodes[0]?.state === 'ready') break;
      assert.ok(n < 100);
      await delay(10);
    }
    const node = (await control.snapshot()).nodes[0]!;
    await control.beginDrain(identity, 'runtime-drain', node.revision);
    await runtime.stop();
    assert.ok(logs.some((l) => l.kind === 'execution_session_finish_retry'));
    assert.ok(logs.some((l) => l.kind === 'execution_session_finished'));
    assert.equal((await gateState(pool)).state, 'paused');
    assert.ok(await control.drainProof(identity, 'runtime-drain'));
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n,
      0,
    );
  },
);
