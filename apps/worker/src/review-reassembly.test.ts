// Synthetic provider evidence on an isolated PostgreSQL clone. No CLI/provider is invoked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { createServer } from '@bondbuddy/api';
import { digest, uid, type PrivateBlobs } from '@bondbuddy/api/data';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import {
  checkpointStage,
  claim,
  finish,
  recordPotentialCall,
  requeueFailedReviewAssembly,
} from '@bondbuddy/api/queue';
import {
  persistProviderResultObject,
  recordProviderCallObservation,
  type ProviderCallIntent,
} from '@bondbuddy/api/provider-results';
import { isolatedTestDatabase } from './test-database.js';
import { runReconcileCommand } from './reconcile-run.js';
import { CodexDurableJournal } from './durable-probe-journal.js';
import {
  DEFAULT_DISABLED_FEATURES,
  runContainedModelCall,
  type CodexAdapterConfig,
} from './codex-adapter.js';
import { CliReviewSchema, type ReviewAnalysisInput } from './review-model-stage.js';
import { isReviewModelEnvelope, type ReviewToolData } from './review-tools.js';
import { syntheticCliReview } from './review-cli-test-fixtures.js';

const connection = await isolatedTestDatabase(undefined, 'review-reassembly');
const actor = 'synthetic-reassembly-operator';
function memoryBlobs() {
  const objects = new Map<string, Buffer>();
  const blobs: PrivateBlobs = {
    put: async (k, b) => {
      objects.set(k, Buffer.from(b));
    },
    get: async (k) => {
      const b = objects.get(k);
      if (!b) throw Error('missing');
      return Buffer.from(b);
    },
    getIfExists: async (k) => (objects.has(k) ? Buffer.from(objects.get(k)!) : null),
    getIfExistsBounded: async (k, max) => {
      const b = objects.get(k);
      if (b && b.length > max) throw Error('oversize');
      return b ? Buffer.from(b) : null;
    },
    exists: async (k) => objects.has(k),
    delete: async (k) => {
      objects.delete(k);
    },
  };
  return { blobs, objects };
}

async function fixture(pool: Pool, failedStage = 'model_generation') {
  const owner = uid(),
    origin = 'http://bondbuddy.test',
    { blobs, objects } = memoryBlobs();
  const app = createServer({
    pool,
    blobs,
    allowedOrigin: origin,
    principal: async () => ({ userId: owner, csrfVerified: true }),
    enableRunRuntime: true,
  });
  const send = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
  const good = (r: { statusCode: number; body: string }) =>
    assert.ok(r.statusCode >= 200 && r.statusCode < 300, r.body);
  try {
    const created = await send('POST', '/api/v1/projects', {
      name: 'Synthetic failed review',
      kind: 'review',
      issuer_name: null,
      market: null,
      offering: null,
    });
    good(created);
    const project = created.json().project_id,
      material = uid(),
      upload = uid(),
      sha = digest('synthetic source');
    await pool.query(
      `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')`,
      [upload, owner, project, sha, `synthetic/${upload}`],
    );
    await pool.query(
      `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')`,
      [material, owner, project, upload, sha, `synthetic/${material}`],
    );
    const pin = { material_id: material, material_version: 1, sha256: sha };
    good(
      await send('PUT', `/api/v1/projects/${project}/review-draft`, {
        kind: 'input',
        expected_version: 0,
        input: {
          source_material_ref: pin,
          material_versions: [pin],
          requirements: [],
          as_of: null,
          evidence_links: [],
        },
      }),
    );
    const start = await send('POST', `/api/v1/projects/${project}/review-executions`, {
      execution_request_id: uid(),
      operation: 'full_review',
      expected_input_version: 1,
      source_report_id: null,
      expected_plan_version: null,
      finding_ids: [],
    });
    good(start);
    const runId = start.json().run_id,
      lease = await claim(pool, 120);
    assert.ok(lease);
    assert.equal(lease.runId, runId);
    const r = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [runId])).rows[0];
    const prompt = 'Synthetic review prompt with immutable context',
      callKey = digest(prompt).slice(0, 24),
      logical = `review-cli-v3-${callKey}`,
      promptStage = `review_cli_v3_${callKey}_prompt`;
    const snapshot = await savePromptSnapshot(pool, blobs, {
      owner,
      projectId: project,
      runId,
      kind: 'model_request',
      version: 1,
      body: prompt,
      inputRevision: r.input_revision,
      inputHash: r.input_hash.trim(),
      templateVersion: 'synthetic-review-v1',
    });
    await checkpointStage(pool, lease, promptStage, { snapshot_id: snapshot });
    await checkpointStage(pool, lease, 'review_sources', {
      snapshots: [
        {
          material_id: material,
          material_version: 1,
          snapshot_id: null,
          response_sha256: null,
          gap: 'synthetic fixture',
        },
      ],
    });
    const input: ReviewAnalysisInput = {
      input_hash: r.input_hash.trim(),
      evidence: {
        owner_user_id: owner,
        project_id: project,
        report_id: uid(),
        source_material: pin,
        records: [],
        rules: [],
      },
      rule_context: null,
      rule_packs: [],
      formatting_requirements: [],
      requirements: [],
      scope: { mode: 'full_review', finding_ids: [] },
      report_version: 1,
      created_at: new Date(r.created_at).toISOString(),
      limitations: [],
    };
    const markdown = 'Synthetic method knowledge; no real review acceptance.';
    const data: ReviewToolData = {
      input,
      knowledge: {
        id: 'synthetic-knowledge',
        version: 'synthetic-v1',
        sourceSHA: digest('synthetic knowledge source'),
        contentSHA: digest(markdown),
        markdown,
      },
      allowed_target_ids: [],
    };
    const envelope = { version: 'review-model-envelope-v1', ...syntheticCliReview(data) };
    const validate = (v: unknown) =>
      isReviewModelEnvelope(v, data) && Value.Check(CliReviewSchema, v.output);
    const intent: ProviderCallIntent = {
      owner_user_id: owner,
      project_id: project,
      run_id: runId,
      trace_id: runId,
      job_id: lease.jobId,
      logical_call_id: logical,
      call_id: uid(),
      attempt_no: 1,
      model_id: 'synthetic-model',
      model_config_version: 'synthetic-v1',
      prompt_snapshot_ref: snapshot,
    };
    await recordPotentialCall(pool, lease, logical, 1, {
      callId: intent.call_id,
      modelId: intent.model_id,
      promptSnapshotId: snapshot,
    });
    const bytes = Buffer.from(JSON.stringify(envelope));
    const result = await persistProviderResultObject({
      blobs,
      intent,
      bytes,
      resultSchemaVersion: 'review-cli-v3',
      validate,
    });
    await recordProviderCallObservation(
      pool,
      blobs,
      {
        ...intent,
        ...result,
        provider_request_id: null,
        finish_reason: 'stop',
        outcome: 'completed',
        error_code: null,
        usage: {
          status: 'measured',
          input_tokens: 123,
          cached_input_tokens: 12,
          output_tokens: 17,
          reasoning_tokens: 0,
          total_tokens: 140,
        },
      },
      validate,
      { lease, source: 'provider' },
    );
    await finish(pool, lease, 'failed', { errorCode: 'VALIDATION_FAILED', failedStage });
    const promptRef = (
      await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [snapshot])
    ).rows[0].object_key;
    return {
      owner,
      project,
      runId,
      lease,
      prompt,
      promptStage,
      promptRef,
      intent,
      bytes,
      result,
      data,
      envelope,
      validate,
      blobs,
      objects,
      recover: () =>
        runReconcileCommand(
          pool,
          ['reassemble-review', runId, intent.call_id, result.result_sha256],
          actor,
          blobs,
        ),
    };
  } finally {
    await app.close();
  }
}

async function evidence(pool: Pool, f: Awaited<ReturnType<typeof fixture>>) {
  const output: Record<string, unknown> = {};
  for (const table of [
    'bb_model_call_attempts',
    'bb_provider_result_refs',
    'bb_provider_call_observations',
    'bb_usage_observations',
    'bb_call_usage',
  ]) {
    const key = table === 'bb_model_call_attempts' ? 'id' : 'attempt_id';
    output[table] = (
      await pool.query(`SELECT * FROM ${table} WHERE ${key}=$1`, [f.intent.call_id])
    ).rows;
  }
  output.errors = (
    await pool.query(
      'SELECT * FROM bb_observability_errors WHERE job_id=$1 ORDER BY created_at,id',
      [f.lease.jobId],
    )
  ).rows;
  return output;
}

test('review reassembly requires Blob evidence and an explicit exact identity', async () => {
  await assert.rejects(
    runReconcileCommand({} as Pool, ['reassemble-review', 'run', 'attempt', 'a'.repeat(64)], actor),
    /requires private Blob evidence/,
  );
  await assert.rejects(
    requeueFailedReviewAssembly({} as Pool, memoryBlobs().blobs, {
      runId: 'run',
      attemptId: 'attempt',
      resultSha256: 'bad',
      actor,
    }),
    /Invalid review recovery identity/,
  );
  await assert.rejects(
    runReconcileCommand({} as Pool, ['reassemble-review', 'run'], actor),
    /usage:/,
  );
});

test(
  'private review reassembly preserves original evidence, rolls back, is idempotent and reuses CLI result without a new call',
  { skip: !connection },
  async () => {
    const pool = new Pool({ connectionString: connection });
    try {
      const f = await fixture(pool),
        before = await evidence(pool, f);
      const oldJob = (
        await pool.query('SELECT checkpoint,error_code FROM bb_jobs WHERE id=$1', [f.lease.jobId])
      ).rows[0];
      const oldEvents = (
        await pool.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq', [f.runId])
      ).rows;
      const outbox = async () =>
        Number(
          (await pool.query('SELECT count(*) AS n FROM bb_outbox WHERE aggregate_id=$1', [f.runId]))
            .rows[0].n,
        );
      const count = await outbox();
      await pool.query(
        `ALTER TABLE bb_outbox ADD CONSTRAINT synthetic_reassembly_rollback CHECK (aggregate_id <> '${f.runId}') NOT VALID`,
      );
      await assert.rejects(f.recover(), /synthetic_reassembly_rollback/);
      assert.deepEqual(
        (await pool.query('SELECT checkpoint,error_code FROM bb_jobs WHERE id=$1', [f.lease.jobId]))
          .rows[0],
        oldJob,
      );
      assert.equal(
        (await pool.query('SELECT state FROM bb_runs WHERE id=$1', [f.runId])).rows[0].state,
        'failed',
      );
      await pool.query('ALTER TABLE bb_outbox DROP CONSTRAINT synthetic_reassembly_rollback');
      const expected = {
        run_id: f.runId,
        attempt_id: f.intent.call_id,
        result_sha256: f.result.result_sha256,
      };
      assert.deepEqual(await f.recover(), { ...expected, idempotent: false });
      assert.deepEqual(await f.recover(), { ...expected, idempotent: true });
      assert.equal(await outbox(), count + 1);
      assert.deepEqual(await evidence(pool, f), before);
      const events = (
        await pool.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq', [f.runId])
      ).rows;
      assert.deepEqual(events.slice(0, oldEvents.length), oldEvents);
      assert.equal(events.at(-1).payload.reason, 'review_assembly_requeued');
      assert.equal(events.at(-1).payload.reuse_only, 'true');
      const current = (
        await pool.query('SELECT checkpoint,error_code FROM bb_jobs WHERE id=$1', [f.lease.jobId])
      ).rows[0];
      assert.equal(current.error_code, null);
      assert.deepEqual(current.checkpoint.stages, oldJob.checkpoint.stages);
      assert.deepEqual(current.checkpoint.provider_results, oldJob.checkpoint.provider_results);
      assert.equal(current.checkpoint.review_assembly_recovery.reuse_only, true);
      assert.equal(
        current.checkpoint.review_assembly_recovery.failure_event_seq,
        String(oldEvents.at(-1).seq),
      );
      await assert.rejects(
        requeueFailedReviewAssembly(pool, f.blobs, {
          runId: f.runId,
          attemptId: f.intent.call_id,
          resultSha256: 'f'.repeat(64),
          actor,
        }),
        /another identity/,
      );
      const lease = await claim(pool, 120);
      assert.ok(lease);
      assert.equal(lease.runId, f.runId);
      const work = join(tmpdir(), `bb-no-reassembly-spawn-${uid()}`);
      const config: CodexAdapterConfig = {
        command: [join(work, 'MUST_NOT_SPAWN')],
        model_id: f.intent.model_id,
        model_provider: 'synthetic',
        base_url: 'https://example.invalid',
        wire_api: 'responses',
        model_config_version: f.intent.model_config_version,
        reasoning_effort: null,
        credential: { kind: 'env', name: 'BB_SYNTHETIC_REPLAY_KEY' },
        work_root: work,
        timeout_ms: 1000,
        kill_grace_ms: 100,
        max_output_bytes: 1048576,
        max_schema_reasks: 0,
        disabled_features: DEFAULT_DISABLED_FEATURES,
        path_env: process.env.PATH ?? 'synthetic',
      };
      const journal = new CodexDurableJournal({
        pool,
        blobs: f.blobs,
        lease,
        validateResult: f.validate,
      });
      const call = {
        ...f.intent,
        prompt: f.prompt,
        result_schema_version: 'review-cli-v3',
        output: {
          kind: 'json' as const,
          schema: CliReviewSchema,
          validate: (v: unknown) => Value.Check(CliReviewSchema, v),
        },
        reviewTools: f.data,
      };
      const reused = await runContainedModelCall(call, journal, config);
      assert.equal(reused.status, 'reused');
      assert.deepEqual(reused.attempts, []);
      assert.deepEqual(reused.value, f.envelope.output);
      assert.deepEqual(reused.reviewToolTrace, f.envelope.tool_trace);
      await assert.rejects(access(work), { code: 'ENOENT' });
      // A changed tool snapshot cannot convert a completed result into a new send.
      const changed = structuredClone(f.data);
      changed.input.requirements = ['changed input'];
      const mismatch = await runContainedModelCall(
        { ...call, reviewTools: changed },
        journal,
        config,
      );
      assert.equal(mismatch.status, 'needs_reconcile');
      assert.deepEqual(mismatch.attempts, []);
      lease.checkpoint = {};
      await assert.rejects(
        recordPotentialCall(pool, lease, f.intent.logical_call_id, 2),
        /reuse-only/,
      );
      await assert.rejects(recordPotentialCall(pool, lease, 'new-logical-call', 1), /reuse-only/);
      assert.deepEqual(await evidence(pool, f), before);
      assert.equal(digest(await f.blobs.get(f.result.result_ref)), f.result.result_sha256);
      await finish(pool, lease, 'failed', {
        errorCode: 'VALIDATION_FAILED',
        failedStage: 'synthetic_cleanup',
      });
    } finally {
      await pool.end();
    }
  },
);

test(
  'review reassembly rejects mismatched scope, non-replayable evidence and competing work before mutation',
  { skip: !connection },
  async (t) => {
    const pool = new Pool({ connectionString: connection });
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const cases: { name: string; change: (f: Fixture) => Promise<unknown> }[] = [
      {
        name: 'result Blob tamper',
        change: async (f) => f.objects.set(f.result.result_ref, Buffer.from('tampered')),
      },
      { name: 'missing result Blob', change: async (f) => f.objects.delete(f.result.result_ref) },
      {
        name: 'prompt Blob tamper',
        change: async (f) => f.objects.set(f.promptRef, Buffer.from('changed prompt')),
      },
      { name: 'missing prompt Blob', change: async (f) => f.objects.delete(f.promptRef) },
      {
        name: 'wrong run input hash',
        change: (f) =>
          pool.query('UPDATE bb_runs SET input_hash=$2 WHERE id=$1', [f.runId, 'f'.repeat(64)]),
      },
      {
        name: 'missing prompt checkpoint',
        change: (f) =>
          pool.query(
            "UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages}','{}') WHERE id=$1",
            [f.lease.jobId],
          ),
      },
      {
        name: 'duplicate result checkpoint',
        change: (f) =>
          pool.query(
            "UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{provider_results}',(checkpoint->'provider_results')||(checkpoint->'provider_results')) WHERE id=$1",
            [f.lease.jobId],
          ),
      },
      {
        name: 'live lease',
        change: (f) =>
          pool.query(
            "UPDATE bb_jobs SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
            [f.lease.jobId, uid()],
          ),
      },
      {
        name: 'wrong task kind',
        change: (f) => pool.query("UPDATE bb_runs SET task_kind='update' WHERE id=$1", [f.runId]),
      },
      {
        name: 'deleted project',
        change: (f) =>
          pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [f.project]),
      },
      {
        name: 'existing report',
        change: (f) =>
          pool.query(
            "INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report) VALUES($1,$2,$3,$4,1,$5,'{}')",
            [uid(), f.owner, f.project, f.runId, digest('{}')],
          ),
      },
      {
        name: 'conflicting usage',
        change: (f) =>
          pool.query(
            "INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status,input_tokens,output_tokens,evidence_ref) VALUES($1,$2,$3,'reconciliation',$4,'measured',999,17,$3)",
            [uid(), f.owner, f.intent.call_id, uid()],
          ),
      },
      {
        name: 'later unresolved attempt',
        change: (f) =>
          pool.query(
            "INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,$4,2,'pending_reconcile')",
            [uid(), f.owner, f.lease.jobId, f.intent.logical_call_id],
          ),
      },
      {
        name: 'active run in same project',
        change: (f) =>
          pool.query(
            `INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      SELECT $2,owner_user_id,project_id,input_revision,input_hash,$3,task_kind,request_hash,'queued' FROM bb_runs WHERE id=$1`,
            [f.runId, uid(), uid()],
          ),
      },
    ];
    try {
      for (const scenario of cases)
        await t.test(scenario.name, async () => {
          const f = await fixture(pool);
          await scenario.change(f);
          const before = await evidence(pool, f),
            job = (await pool.query('SELECT * FROM bb_jobs WHERE id=$1', [f.lease.jobId])).rows[0];
          const cursor = (
            await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1', [f.runId])
          ).rows[0].event_cursor;
          await assert.rejects(f.recover(), /No recoverable|Blob evidence/);
          assert.deepEqual(await evidence(pool, f), before);
          assert.deepEqual(
            (await pool.query('SELECT * FROM bb_jobs WHERE id=$1', [f.lease.jobId])).rows[0],
            job,
          );
          assert.equal(
            (await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1', [f.runId])).rows[0]
              .event_cursor,
            cursor,
          );
        });
      await t.test('foreign attempt and wrong expected hash', async () => {
        const a = await fixture(pool),
          b = await fixture(pool);
        await assert.rejects(
          requeueFailedReviewAssembly(pool, a.blobs, {
            runId: a.runId,
            attemptId: b.intent.call_id,
            resultSha256: b.result.result_sha256,
            actor,
          }),
          /No recoverable/,
        );
        await assert.rejects(
          requeueFailedReviewAssembly(pool, a.blobs, {
            runId: a.runId,
            attemptId: a.intent.call_id,
            resultSha256: 'e'.repeat(64),
            actor,
          }),
          /No recoverable/,
        );
      });
      await t.test('failure in another stage', async () => {
        const f = await fixture(pool, 'word_delivery');
        await assert.rejects(f.recover(), /No recoverable/);
      });
    } finally {
      await pool.end();
    }
  },
);
