// SYNTHETIC PostgreSQL/Azurite test for the Codex adapter journal. It claims jobs globally,
// so it runs in its own clone of the migrated template (BB_TEST_CODEX_DATABASE_URL, else
// BB_TEST_DATABASE_URL; see test-database.ts). The fake codex replays synthetic JSONL; no provider is called.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, uid } from '@bondbuddy/api/data';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { claim, jobSnapshot, pauseRun } from '@bondbuddy/api/queue';
import { DEFAULT_DISABLED_FEATURES, runContainedModelCall, type CodexAdapterConfig } from './codex-adapter.js';
import { CodexDurableJournal } from './durable-probe-journal.js';
import { runReconcileCommand } from './reconcile-run.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('BB_TEST_CODEX_DATABASE_URL');

const connection = testDatabaseUrl;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const fake = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));
const isAnswer = (v: unknown) => typeof v === 'object' && v !== null && typeof (v as { answer?: unknown }).answer === 'string';
const schema = { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'integer' } }, required: ['answer', 'n'], additionalProperties: false };

test('synthetic durable Codex attempts write #79 rows, re-ask under lease, pause on timeout and never resend after a crash', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const blobs = azureBlobs(blobConnection!, 'bondbuddy-m1-11-codex');
  const owner = `synthetic-codex-owner-${uid()}`;
  const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test', principal: async () => ({ userId: owner, csrfVerified: true }), enableSyntheticQueue: true });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin: 'http://bondbuddy.test' }, payload: payload as any });
  const root = await mkdtemp(join(tmpdir(), 'bb-codex-durable-'));
  const config: CodexAdapterConfig = { command: [process.execPath, fake], model_id: 'deepseek-flash', model_provider: 'deepseek', base_url: 'https://api.deepseek.com', wire_api: 'responses', model_config_version: 'codex-deepseek-flash-test', reasoning_effort: null, credential: { kind: 'env', name: 'BB_SYNTHETIC_DEEPSEEK_KEY' }, work_root: join(root, 'work'), timeout_ms: 400, kill_grace_ms: 100, max_output_bytes: 1 << 20, max_schema_reasks: 1, disabled_features: DEFAULT_DISABLED_FEATURES, path_env: '/usr/bin:/bin' };
  async function fixture(label: string) {
    const p = await send('POST', '/api/v1/projects', { name: `Synthetic codex ${label}`, kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(p.statusCode, 201, p.body);
    const projectId = p.json().project_id;
    const input = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: 1, material_versions: [], requirement_message_ids: [] });
    const submitted = await send('POST', '/api/v1/runs/execute', { execution_request_id: `synthetic-codex-${label}-${uid()}`, project_id: projectId, input_revision: 1, input_hash: input.json().input_hash, task_kind: 'update', input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-worker' });
    assert.equal(submitted.statusCode, 202, submitted.body);
    const runId = submitted.json().run_id;
    const prompt = Buffer.from(`synthetic codex prompt ${label}`);
    const objectKey = `users/${owner}/projects/${projectId}/snapshots/prompt-${runId}`;
    await blobs.put(objectKey, prompt, 'text/plain');
    const promptRef = await saveSnapshotRef(pool, { owner, projectId, runId, kind: 'model_request', version: 1, objectKey, sha256: createHash('sha256').update(prompt).digest('hex'), redactionVersion: 'synthetic_redaction_v1', inputRevision: 1, inputHash: input.json().input_hash, blobs });
    const lease = await claim(pool, 30);
    assert.ok(lease); assert.equal(lease.runId, runId);
    return { projectId, runId, promptRef, lease };
  }
  const callFor = (f: Awaited<ReturnType<typeof fixture>>, prompt: string) => ({ owner_user_id: owner, project_id: f.projectId, job_id: f.lease.jobId, run_id: f.runId, trace_id: f.runId, logical_call_id: 'synthetic-codex-call', prompt_snapshot_ref: f.promptRef, prompt, result_schema_version: 'answer-v1', output: { kind: 'json' as const, schema, validate: isAnswer } });
  const journalFor = (f: Awaited<ReturnType<typeof fixture>>) => new CodexDurableJournal({ pool, blobs, lease: f.lease, validateResult: isAnswer });
  try {
    const active = await pool.query("SELECT count(*)::int AS count FROM bb_jobs WHERE state IN ('queued','running')");
    assert.equal(active.rows[0].count, 0, 'requires a dedicated database');

    const web=await fixture('web-evidence'),webJournal=journalFor(web);
    let webIntent!: Parameters<CodexDurableJournal['recordIntent']>[0];
    const recordIntent=webJournal.recordIntent.bind(webJournal);
    webJournal.recordIntent=async intent=>{webIntent=intent;await recordIntent(intent);};
    const searched=await runContainedModelCall(callFor(web,'SCENARIO:web_search'),webJournal,{...config,web_search:'live'});
    assert.equal(searched.status,'completed');
    const stored=(await pool.query('SELECT events,content_sha256 FROM bb_model_web_search_evidence WHERE call_id=$1',[webIntent.call_id])).rows[0];
    assert.equal(stored.events.length,1);assert.equal(stored.events[0].item.id,'search-1');
    await webJournal.recordWebSearchEvents(webIntent,stored.events);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_web_search_evidence WHERE call_id=$1',[webIntent.call_id])).rows[0].n,1);
    await assert.rejects(webJournal.recordWebSearchEvents(webIntent,[]),{code:'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(webJournal.recordWebSearchEvents({...webIntent,project_id:'another-project'},stored.events),{code:'CAPABILITY_NOT_READY'});
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[web.lease.jobId]);
    await assert.rejects(webJournal.recordWebSearchEvents(webIntent,stored.events),{code:'CAPABILITY_NOT_READY'});
    await pool.query("UPDATE bb_jobs SET lease_until=now()+interval '30 seconds' WHERE id=$1",[web.lease.jobId]);
    await pauseRun(pool,web.lease,'awaiting_materials','synthetic_test_complete');

    // Schema-invalid first answer is re-asked under the same lease; both attempts are durable.
    const ok = await fixture('reask');
    const r = await runContainedModelCall(callFor(ok, 'SCENARIO:invalid_json REASK_SCENARIO:structured'), journalFor(ok), config);
    assert.equal(r.status, 'completed', JSON.stringify(r.attempts));
    const rows = (await pool.query(`SELECT a.attempt_no,a.status,a.usage_status,a.model_id,a.prompt_snapshot_id,o.outcome,o.error_code,o.finish_reason,o.input_tokens,o.cached_input_tokens,o.output_tokens,o.reasoning_tokens,o.total_tokens,o.model_config_version,
        t.duration_ms,t.framework_thread_id,t.provider_request_id_status,t.pricing_status,t.adapter_version,t.trace_id
      FROM bb_model_call_attempts a JOIN bb_provider_call_observations o ON o.attempt_id=a.id JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id
      WHERE a.job_id=$1 ORDER BY a.attempt_no`, [ok.lease.jobId])).rows;
    assert.deepEqual(rows.map(x => [x.attempt_no, x.status, x.outcome, x.error_code]), [[1, 'failed', 'failed', 'MODEL_OUTPUT_SCHEMA_INVALID'], [2, 'completed', 'completed', null]]);
    assert.deepEqual([rows[1].input_tokens, rows[1].cached_input_tokens, rows[1].output_tokens, rows[1].reasoning_tokens, rows[1].total_tokens], [8418, 6784, 46, 33, 8464]);
    assert.ok(rows.every(x => x.usage_status === 'measured' && x.model_id === 'deepseek-flash' && x.prompt_snapshot_id === ok.promptRef && x.provider_request_id_status === 'unknown' && x.pricing_status === 'unknown' && x.trace_id === ok.runId && x.framework_thread_id && x.duration_ms >= 0 && x.model_config_version === 'codex-deepseek-flash-test'));
    assert.equal((await jobSnapshot(pool, owner, ok.runId)).state, 'running', 'a retryable failure keeps the job running');
    const events = (await pool.query("SELECT event->>'kind' AS kind FROM bb_observability_events WHERE job_id=$1 AND event->>'kind' LIKE 'model.%' ORDER BY created_at,id", [ok.lease.jobId])).rows.map(x => x.kind);
    assert.deepEqual(events.filter(k => k === 'model.call_started').length, 2);
    assert.ok(events.includes('model.usage_observed') && events.includes('model.call_finished'));
    // A second invocation with the same logical call reuses the checkpointed result.
    const again = await runContainedModelCall(callFor(ok, 'SCENARIO:structured'), journalFor(ok), config);
    assert.equal(again.status, 'reused'); assert.deepEqual(again.value, { answer: 'OK', n: 16 });
    await pauseRun(pool,ok.lease,'awaiting_materials','synthetic_test_complete');

    // Timeout: recorded with unknown usage and the job pauses for reconciliation.
    const slow = await fixture('timeout');
    const t = await runContainedModelCall(callFor(slow, 'SCENARIO:hang'), journalFor(slow), config);
    assert.equal(t.error_code, 'MODEL_TIMEOUT');
    const tr = (await pool.query('SELECT a.status,a.usage_status,o.input_tokens,t.error_code,t.exit_signal FROM bb_model_call_attempts a JOIN bb_provider_call_observations o ON o.attempt_id=a.id JOIN bb_model_call_attempt_runtime t ON t.attempt_id=a.id WHERE a.job_id=$1', [slow.lease.jobId])).rows[0];
    assert.deepEqual([tr.status, tr.usage_status, tr.input_tokens, tr.error_code], ['pending_reconcile', 'unknown', null, 'MODEL_TIMEOUT']);
    if(process.platform==='win32')assert.ok(tr.exit_signal===null||tr.exit_signal==='SIGKILL');
    else assert.equal(tr.exit_signal,'SIGKILL');
    assert.equal((await jobSnapshot(pool, owner, slow.runId)).state, 'paused');

    // Exercise the real journal boundary beyond the ordinary JSON re-ask budget.
    // A second locally terminated timeout still has an explicit durable retry disposition.
    let recovered = slow;
    for (const attemptNo of [2, 3]) {
      const prior = (await pool.query('SELECT id AS call_id FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY attempt_no DESC LIMIT 1', [slow.lease.jobId])).rows[0];
      assert.ok(prior);
      await runReconcileCommand(pool, ['resolve', slow.runId, prior.call_id, 'retry_unknown_usage', 'synthetic_timeout_recovery'], 'synthetic-operator');
      const lease = await claim(pool, 30); assert.ok(lease); assert.equal(lease.runId, slow.runId);
      recovered = { ...slow, lease };
      const retry = await runContainedModelCall(callFor(recovered, attemptNo === 2 ? 'SCENARIO:hang' : 'SCENARIO:structured'), journalFor(recovered), config);
      assert.equal(retry.status, attemptNo === 2 ? 'needs_reconcile' : 'completed');
      assert.deepEqual(retry.attempts.map(a => a.attempt_no), [attemptNo]);
    }
    const recoveredRows = (await pool.query('SELECT attempt_no,status,usage_status FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY attempt_no', [slow.lease.jobId])).rows;
    assert.deepEqual(recoveredRows.map(a => [a.attempt_no, a.status, a.usage_status]), [[1, 'failed', 'unknown'], [2, 'failed', 'unknown'], [3, 'completed', 'measured']]);
    const retryReplay = await runContainedModelCall(callFor(recovered, 'SCENARIO:structured'), journalFor(recovered), config);
    assert.equal(retryReplay.status, 'reused'); assert.equal(retryReplay.attempts.length, 0);
    await pauseRun(pool,recovered.lease,'awaiting_materials','synthetic_test_complete');

    // A typed provider request rejection has no generated result or measured usage.
    // It must fail durably rather than enter the no-lookup reconciliation loop.
    const rejected = await fixture('rejected');
    const rejectedCall = await runContainedModelCall(callFor(rejected, 'SCENARIO:request_rejected'), journalFor(rejected), config);
    assert.equal(rejectedCall.status, 'failed');
    assert.equal(rejectedCall.error_code, 'MODEL_PROVIDER_REQUEST_REJECTED');
    assert.equal(rejectedCall.attempts[0].tool_attempts, 0);
    const rejectedRow = (await pool.query('SELECT a.status,a.usage_status,o.outcome,o.error_code,o.input_tokens FROM bb_model_call_attempts a JOIN bb_provider_call_observations o ON o.attempt_id=a.id WHERE a.job_id=$1', [rejected.lease.jobId])).rows[0];
    assert.deepEqual([rejectedRow.status, rejectedRow.usage_status, rejectedRow.outcome, rejectedRow.error_code, rejectedRow.input_tokens], ['failed', 'unknown', 'failed', 'MODEL_PROVIDER_REQUEST_REJECTED', null]);
    assert.equal((await jobSnapshot(pool, owner, rejected.runId)).state, 'failed');
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [rejected.runId])).rows[0].state, 'failed');

    // A synthetic HTTP 402 is visible as a specific paused reason. No supplier result
    // or usage measurement exists, so an operator must authorize retry.
    const depleted = await fixture('balance');
    const depletedCall = await runContainedModelCall(callFor(depleted, 'SCENARIO:balance_402'), journalFor(depleted), config);
    assert.equal(depletedCall.error_code, 'MODEL_PROVIDER_BALANCE_EXHAUSTED');
    const balanceState = (await pool.query(`SELECT r.state,r.stage,a.status,a.usage_status,u.input_tokens,u.output_tokens,
      (SELECT payload->>'reason' FROM bb_run_events WHERE run_id=r.id ORDER BY seq DESC LIMIT 1) reason
      FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id JOIN bb_model_call_attempts a ON a.job_id=j.id
      LEFT JOIN bb_call_usage u ON u.attempt_id=a.id WHERE r.id=$1`,[depleted.runId])).rows[0];
    assert.deepEqual(balanceState,{state:'paused',stage:'provider_reconcile',status:'pending_reconcile',usage_status:'unknown',input_tokens:null,output_tokens:null,reason:'provider_balance_exhausted'});
    const diagnosis = (await pool.query('SELECT code,category,provider_error_type,provider_status,safe_message FROM bb_observability_errors WHERE job_id=$1',[depleted.lease.jobId])).rows;
    assert.deepEqual(diagnosis,[{code:'MODEL_PROVIDER_BALANCE_EXHAUSTED',category:'model_provider',provider_error_type:'provider_balance_exhausted',provider_status:null,safe_message:'Error MODEL_PROVIDER_BALANCE_EXHAUSTED'}]);
    const depletedAttempt = (await pool.query('SELECT id FROM bb_model_call_attempts WHERE job_id=$1',[depleted.lease.jobId])).rows[0].id;
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[depleted.lease.jobId])).rows[0].n,1,
      'a paused balance attempt has not been resent');
    await runReconcileCommand(pool,['resolve',depleted.runId,depletedAttempt,'retry_unknown_usage','balance_restored'],'synthetic-operator');
    const resumedLease = await claim(pool,30);
    assert.ok(resumedLease); assert.equal(resumedLease.runId,depleted.runId);
    const resumedFixture = { ...depleted, lease: resumedLease };
    const resumedCall = await runContainedModelCall(callFor(resumedFixture,'SCENARIO:structured'),journalFor(resumedFixture),config);
    assert.equal(resumedCall.status,'completed');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[depleted.lease.jobId])).rows[0].n,2);
    await pauseRun(pool,resumedLease,'awaiting_materials','synthetic_test_complete');

    // Crash after intent, before any observation: the next lease must not resend.
    const crash = await fixture('crash');
    await journalFor(crash).recordIntent({ owner_user_id: owner, project_id: crash.projectId, job_id: crash.lease.jobId, run_id: crash.runId, trace_id: crash.runId, logical_call_id: 'synthetic-codex-call', call_id: `call-${uid()}`, attempt_no: 1, model_id: 'deepseek-flash', model_config_version: 'codex-deepseek-flash-test', prompt_snapshot_ref: crash.promptRef });
    const c = await runContainedModelCall(callFor(crash, 'SCENARIO:structured'), journalFor(crash), config);
    assert.equal(c.status, 'needs_reconcile'); assert.equal(c.error_code, 'MODEL_PRIOR_ATTEMPT_UNRESOLVED'); assert.equal(c.attempts.length, 0);
    const cr = (await pool.query('SELECT count(*)::int AS attempts, (SELECT count(*)::int FROM bb_provider_call_observations WHERE job_id=$1) AS observations FROM bb_model_call_attempts WHERE job_id=$1', [crash.lease.jobId])).rows[0];
    assert.deepEqual([cr.attempts, cr.observations], [1, 1]);
    assert.equal((await jobSnapshot(pool, owner, crash.runId)).state, 'paused');

    // Runtime rows are append-only.
    await assert.rejects(pool.query('UPDATE bb_model_call_attempt_runtime SET duration_ms=0 WHERE job_id=$1', [ok.lease.jobId]));
  } finally {
    await app.close(); await pool.end(); await rm(root, { recursive: true, force: true });
  }
});
