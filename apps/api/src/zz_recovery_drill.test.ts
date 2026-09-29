import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { azureBlobs, transaction, uid } from './data.js';
import { claimMaterialParse, enqueueMaterialParse, succeedMaterialParse } from './material-jobs.js';
import { emitInternal, internalEvent, observeUsage } from './observability.js';
import { gateState, guardEvidenceWrite, resumeEvidenceGate } from './evidence-gate.js';
import { forwardLogs, ndjsonFileSink } from './log-ops.js';
import { isolatedTestDatabase } from './test-database.js';

// This suite always clones an already migrated test database. It never connects to the template for writes.
const databaseUrl = await isolatedTestDatabase('BB_RECOVERY_DRILL_TEST_DATABASE_URL');
const blobUrl = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const enabled = !!databaseUrl && !!blobUrl;
const hash = 'a'.repeat(64);
const terminal = { outcome: 'parsed' as const, parse_status: 'parsed' as const, profile_version: null, pending_capabilities: [] as 'ocr'[] };

function phase(name: string, values: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ drill: 'synthetic_79_recovery', phase: name, ...values })}\n`);
}

async function snapshot(pool: Pool, jobId: string, sink: string) {
  const [job, events, outbox, receipts, terminalEvents] = await Promise.all([
    pool.query('SELECT state,attempts FROM bb_jobs WHERE id=$1', [jobId]),
    pool.query('SELECT id,type,state FROM bb_job_events WHERE job_id=$1 ORDER BY seq', [jobId]),
    pool.query("SELECT id,delivered_at,last_delivery_error FROM bb_outbox WHERE aggregate_type='observability' AND aggregate_id IN (SELECT id FROM bb_observability_events WHERE job_id=$1) ORDER BY id", [jobId]),
    pool.query('SELECT d.outbox_id,d.delivery_key FROM bb_log_deliveries d JOIN bb_outbox o ON o.id=d.outbox_id WHERE d.sink=$1 AND o.aggregate_id IN (SELECT id FROM bb_observability_events WHERE job_id=$2) ORDER BY d.outbox_id', [sink, jobId]),
    pool.query("SELECT count(*)::int n FROM bb_job_events WHERE job_id=$1 AND state IN ('succeeded','failed','cancelled')", [jobId]),
  ]);
  return { job_id: jobId, state: job.rows[0]?.state, attempts: job.rows[0]?.attempts,
    event_ids: events.rows.map(row => row.id), event_types: events.rows.map(row => row.type),
    outbox_ids: outbox.rows.map(row => row.id), pending: outbox.rows.filter(row => !row.delivered_at).length,
    sink_errors: outbox.rows.filter(row => row.last_delivery_error === 'sink_unavailable').length,
    receipt_ids: receipts.rows.map(row => row.outbox_id), terminal_count: terminalEvents.rows[0].n };
}

async function killedParseClaim(database: string, jobId: string): Promise<void> {
  const source = `import { Pool } from 'pg';
    const { claimMaterialParse, completeMaterialParseStage } = await import(process.env.BB_DRILL_MATERIAL_MODULE);
    const pool = new Pool({ connectionString: process.env.BB_DRILL_DATABASE_URL });
    const lease = await claimMaterialParse(pool, 5);
    if (!lease || lease.jobId !== process.env.BB_DRILL_JOB_ID) process.exit(12);
    await completeMaterialParseStage(pool, lease, 'parse_evidence', { synthetic_checkpoint: true });
    process.stdout.write(lease.jobId + '\\n');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('../../../', import.meta.url).pathname,
    env: { ...process.env, BB_DRILL_DATABASE_URL: database, BB_DRILL_JOB_ID: jobId,
      BB_DRILL_MATERIAL_MODULE: new URL('./material-jobs.js', import.meta.url).href },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('parse claimant timed out')), 10000);
      child.stdout.once('data', data => { clearTimeout(timeout); data.toString().trim() === jobId ? resolve() : reject(new Error('unexpected claimed job')); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`parse claimant exited before claim (${code})`)); });
    });
  } finally {
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
  }
}

test('#79 isolated recovery drill: sink outage, parse crash and transaction connection loss', { skip: !enabled, timeout: 90000 }, async () => {
  const pool = new Pool({ connectionString: databaseUrl!, max: 4 });
  // pg emits an error on the idle pool when the deliberately terminated client is released.
  const connectionErrors: string[] = [];
  pool.on('error', error => connectionErrors.push(error.message));
  pool.on('connect', client => client.on('error', error => connectionErrors.push(error.message)));
  const dir = await mkdtemp(join(tmpdir(), 'bb79-recovery-'));
  const file = join(dir, 'events.ndjson');
  const sinkName = `synthetic_drill_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const sink = ndjsonFileSink(file, sinkName);
  const owner = `synthetic79_${uid()}`;
  const project = `synthetic79_${uid()}`;
  const material = `synthetic79_${uid()}`;
  const upload = `synthetic79_${uid()}`;
  const trace = `synthetic79_${uid()}`;
  const blobKey = `users/${owner}/drill/${uid()}`;
  const blobs = azureBlobs(blobUrl!, `synthetic-drill-${randomUUID()}`);
  try {
    // A unique Azurite container proves the drill uses the isolated object store; delete only our key.
    await blobs.put(blobKey, Buffer.from('synthetic recovery drill'), 'text/plain');
    assert.equal((await blobs.get(blobKey)).toString(), 'synthetic recovery drill');
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `s${randomUUID().replaceAll('-', '').slice(0, 24)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'SYNTHETIC recovery drill','update')", [project, owner]);
    await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.txt','text/plain',1,$4,'audit',$5,now()+interval '1 hour','completed')", [upload, owner, project, hash, `users/${owner}/uploads/${upload}`]);
    await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'audit','synthetic.txt','text/plain',1,$5,$6,'persisted')", [material, owner, project, upload, hash, `users/${owner}/materials/${material}`]);
    const queued = await transaction(pool, client => enqueueMaterialParse(client, { owner, projectId: project, materialId: material, materialVersion: 1, sha256: hash, traceId: trace }));
    const jobId = queued.jobId;
    phase('before', await snapshot(pool, jobId, sinkName));

    // Kill only the claimant created here. The five second lease is allowed to expire naturally.
    await killedParseClaim(databaseUrl!, jobId);
    phase('during_parse_crash', await snapshot(pool, jobId, sinkName));
    await new Promise(resolve => setTimeout(resolve, 5500));
    const recovered = await claimMaterialParse(pool, 30);
    assert.equal(recovered?.jobId, jobId);
    assert.equal(recovered.attempts, 2);
    assert.deepEqual(recovered.checkpoint.stages?.parse_evidence, { synthetic_checkpoint: true });
    const beforeDb = await snapshot(pool, jobId, sinkName);
    phase('before_db_failure', beforeDb);
    // Scope the failure to this job's terminal outbox insert. The trigger terminates
    // only its own connection; the entire terminal transition must roll back.
    await pool.query(`CREATE FUNCTION bb_synthetic79_abort_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.aggregate_type='material_parse_job' AND NEW.aggregate_id='${jobId}' AND NEW.event_type='material_parse.succeeded'
        THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER bb_synthetic79_abort_terminal BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_synthetic79_abort_terminal()');
    try {
      await assert.rejects(guardEvidenceWrite(pool, 'synthetic_connection_lost', () => succeedMaterialParse(pool, recovered, terminal)));
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS bb_synthetic79_abort_terminal ON bb_outbox');
      await pool.query('DROP FUNCTION IF EXISTS bb_synthetic79_abort_terminal()');
    }
    const duringDb = await snapshot(pool, jobId, sinkName);
    assert.equal(duringDb.state, 'running');
    assert.equal(duringDb.terminal_count, 0);
    assert.deepEqual(duringDb.outbox_ids, beforeDb.outbox_ids);
    assert.equal((await gateState(pool)).state, 'paused');
    assert.ok(connectionErrors.length <= 1);
    phase('during_db_failure', { ...duringDb, gate: 'paused' });
    await resumeEvidenceGate(pool, owner, 'synthetic_db_recovered');
    await succeedMaterialParse(pool, recovered, terminal);
    await assert.rejects(succeedMaterialParse(pool, recovered, terminal), /Lease is no longer active/);
    const afterParse = await snapshot(pool, jobId, sinkName);
    assert.equal(afterParse.terminal_count, 1);
    phase('after_db_and_parse_recovery', { ...afterParse, gate: (await gateState(pool)).state });

    // An unsafe file mode makes the real file sink refuse the batch without ACK.
    await writeFile(file, '', { mode: 0o600 });
    await chmod(file, 0o644);
    const refused = await forwardLogs(pool, sink, { batchSize: 100, retrySeconds: 0 });
    assert.ok(refused.failed > 0);
    const duringSink = await snapshot(pool, jobId, sinkName);
    assert.ok(duringSink.pending > 0 && duringSink.sink_errors > 0);
    phase('during_sink_outage', duringSink);
    await chmod(file, 0o600);
    const replay = await forwardLogs(pool, sink, { batchSize: 100, retrySeconds: 0 });
    assert.equal(replay.failed, 0);
    const afterSink = await snapshot(pool, jobId, sinkName);
    assert.equal(afterSink.pending, 0);
    assert.equal(afterSink.receipt_ids.length, afterSink.outbox_ids.length);
    assert.equal((await forwardLogs(pool, sink)).delivered, 0);
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(new Set(lines.map(line => line.delivery_key)).size, lines.length);
    phase('after_sink_replay', { ...afterSink, file_lines: lines.length, unique_delivery_keys: new Set(lines.map(line => line.delivery_key)).size });

    // Duplicate measured observations keep one effective attempt, including cache/reasoning subsets.
    const attempt = `synthetic79_${uid()}`;
    const runId = `synthetic79_${uid()}`;
    const callJobId = `synthetic79_${uid()}`;
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')", [project, owner, hash]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'update',$4,'queued')", [runId, owner, project, hash, `synthetic79_${uid()}`]);
    await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,'update','default','queued','queued')", [callJobId, owner, runId]);
    await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,usage_status) VALUES($1,$2,$3,'synthetic_call',1,'failed','unknown')", [attempt, owner, callJobId]);
    await transaction(pool, client => emitInternal(client, internalEvent({ kind: 'model.call_started', owner, projectId: project,
      runId, jobId: callJobId, traceId: runId, logicalCallId: 'synthetic_call', attemptNo: 1 })));
    const usage = { owner, attemptId: attempt, status: 'measured' as const, inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 };
    await observeUsage(pool, { ...usage, source: 'gateway', sourceEventId: 'synthetic_usage_1' });
    await observeUsage(pool, { ...usage, source: 'gateway', sourceEventId: 'synthetic_usage_1' });
    await observeUsage(pool, { ...usage, source: 'framework', sourceEventId: 'synthetic_usage_2' });
    const effective = (await pool.query('SELECT usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens FROM bb_call_usage_effective WHERE attempt_id=$1', [attempt])).rows;
    assert.deepEqual(effective, [{ usage_status: 'measured', input_tokens: 7, output_tokens: 3, cached_input_tokens: 2, reasoning_tokens: 1 }]);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_usage_observations WHERE attempt_id=$1', [attempt])).rows[0].n, 2);
    const callOutbox = (await pool.query("SELECT o.id FROM bb_outbox o JOIN bb_observability_events e ON e.id=o.aggregate_id WHERE o.aggregate_type='observability' AND e.job_id=$1 ORDER BY o.id", [callJobId])).rows.map(row => row.id as string);
    assert.equal(callOutbox.length, 3);
    await forwardLogs(pool, sink, { batchSize: 100 });
    const callReceipts = (await pool.query('SELECT outbox_id FROM bb_log_deliveries WHERE sink=$1 AND outbox_id=ANY($2) ORDER BY outbox_id', [sinkName, callOutbox])).rows.map(row => row.outbox_id as string);
    assert.deepEqual(callReceipts, callOutbox);
    phase('synthetic_usage', { attempt_id: attempt, outbox_ids: callOutbox, receipt_ids: callReceipts,
      pending: 0, observations: 2, effective_rows: effective.length, input_tokens: 7, output_tokens: 3 });
  } finally {
    await blobs.delete(blobKey).catch(() => undefined);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
