// Opt-in 250-file acceptance. Synthetic mode validates orchestration only;
// real mode uses the configured contained adapter, without replacing the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, digest, transaction } from '@bondbuddy/api/data';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { advanceWorkpaperBatch } from '@bondbuddy/api/workpapers';
import {
  WORKPAPER_PRICE,
  type WorkpaperBatch,
  type WorkpaperSharedPlan,
} from '@bondbuddy/contracts';
import { grantCredits } from '../../api/dist/billing.js';
import { headerlessCatalogueXlsx } from '../../api/dist/workpaper-catalogue-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import {
  inputLockStage,
  materialsReadyStage,
  runPipelineOnce,
  codexModelStage,
  type RunStage,
} from './run-pipeline.js';
import { m4DocumentStage, m4DocumentDeliveryStage } from './m4-document-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { CodexDurableJournal } from './durable-probe-journal.js';
import { projectFilesRoot } from './project-file-tools.js';
const enabled = process.env.BB_TEST_BATCH_250 === '1',
  real = process.env.BB_TEST_REAL_MODELS === '1';
const database = enabled ? await isolatedTestDatabase(undefined, 'batch-four-250') : undefined,
  storage = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test(
  'same frozen 250-file catalogue: one versus four routes, coverage, unique authors, replay and accounting',
  {
    skip: !enabled || !database || !storage || !process.env.BONDBUDDY_TEST_PYTHON,
    timeout: 7200000,
  },
  async (t) => {
    if (real && !process.env.BB_BATCH_FOUR_RECEIPT_DIR)
      throw Error('REAL_BATCH_EVIDENCE_DIRECTORY_REQUIRED');
    const pool = new Pool({ connectionString: database, max: 10 }),
      owner = randomUUID(),
      container = 'bb-four-' + randomUUID().replaceAll('-', '');
    const blobs = azureBlobs(storage!, container),
      origin = 'http://bondbuddy.test';
    const app = createServer({
      pool,
      blobs,
      historicalBillingFixture: true,
      allowedOrigin: origin,
      enableRunRuntime: true,
      principal: async () => ({ userId: owner, csrfVerified: true }),
    });
    const directory = await mkdtemp(join(tmpdir(), 'bb-four-250-'));
    const config = real
      ? loadCodexAdapterConfig()
      : {
          ...loadCodexAdapterConfig({}),
          model_id: 'synthetic-four',
          model_config_version: 'synthetic-four-v1',
        };
    let syntheticCalls = 0,
      syntheticActive = 0,
      syntheticPeak = 0,
      sourceReads = 0,
      sourceKey = '';
    const send = (method: string, url: string, payload?: any) =>
      app.inject({
        method: method as any,
        url,
        payload,
        headers: {
          origin,
          ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
        },
      });
    const ok = async (method: string, url: string, payload?: any) => {
      const r = await send(method, url, payload);
      assert.ok(r.statusCode < 300, `${r.statusCode}: ${r.body}`);
      return r.json();
    };
    const upload = async (
      id: string,
      name: string,
      bytes: Buffer,
      media_type: string,
      role = 'other',
    ) => {
      const path = '/api/v1/projects/' + id,
        declaration = { byte_size: bytes.length, sha256: digest(bytes) };
      const u = await ok('POST', path + '/materials/uploads', {
        ...declaration,
        filename: name,
        media_type,
        role,
      });
      assert.equal((await send('PUT', u.upload_url, bytes)).statusCode, 204);
      const m = await ok(
        'POST',
        path + '/materials/uploads/' + u.upload_id + '/complete',
        declaration,
      );
      return {
        source_project_id: id,
        material_id: m.material_id,
        material_version: m.material_version,
        sha256: m.sha256,
      };
    };
    const python = async (args: string[]) =>
      promisify(execFile)(process.env.BONDBUDDY_TEST_PYTHON!, ['-B', ...args], {
        cwd: projectFilesRoot,
        env: { ...process.env, PYTHONPATH: join(projectFilesRoot, 'python') },
        maxBuffer: 1024 * 1024,
      });
    const synthetic: typeof codexModelStage = (options) => ({
      name: options.name,
      replay: true,
      run: async (ctx) => {
        const journal = new CodexDurableJournal({
          pool,
          blobs,
          lease: ctx.lease,
          validateResult: options.validate,
        });
        const prior = await journal.latestAttempt(options.logicalCallId);
        if (prior) {
          const saved = await journal.readCompleted(options.logicalCallId, prior.attempt_no);
          assert.ok(saved);
          return { kind: 'done', value: saved.value };
        }
        const snapshot = await savePromptSnapshot(pool, blobs, {
          owner,
          projectId: ctx.run.project_id,
          runId: ctx.run.id,
          kind: 'model_request',
          body: await options.buildPrompt(ctx),
          inputRevision: ctx.run.input_revision,
          inputHash: ctx.run.input_hash,
          templateVersion: options.templateVersion,
        });
        const intent = {
          owner_user_id: owner,
          project_id: ctx.run.project_id,
          job_id: ctx.lease.jobId,
          run_id: ctx.run.id,
          trace_id: ctx.run.id,
          logical_call_id: options.logicalCallId,
          call_id: randomUUID(),
          attempt_no: 1,
          model_id: config.model_id,
          model_config_version: config.model_config_version,
          prompt_snapshot_ref: snapshot,
        };
        const cwd = join(directory, intent.call_id);
        await mkdir(cwd);
        assert.ok(options.fileWorkspace);
        await options.fileWorkspace.prepare(cwd);
        await journal.recordIntent(intent);
        syntheticCalls++;
        syntheticPeak = Math.max(syntheticPeak, ++syntheticActive);
        try {
          // Delay only in the explicitly synthetic branch; never pad a real speed measurement.
          await delay(200);
          const source = JSON.parse(await readFile(join(cwd, 'source-data.json'), 'utf8')),
            batch = JSON.parse(await readFile(join(cwd, 'batch-input.json'), 'utf8'));
          const facts = source.source.spans.filter((s: any) => s.text.trim()).map((s: any) => s.id);
          const plan: WorkpaperSharedPlan = {
            version: 'workpaper-shared-plan-v1',
            source_sha256: source.source.sha256,
            reviewed_span_ids: facts,
            excluded: [],
            image_reviews: [],
            items: batch.entries.map((entry: any) => ({
              item_id: entry.id,
              decision: {
                item_id: entry.id,
                status: entry.code.endsWith('-8') ? 'external_evidence' : 'generate',
                reason: entry.code.endsWith('-8')
                  ? '已披露财务数据，但本项签章审计报告原件未提供。'
                  : '已有完整子公司财务披露，可形成对应核查清单。',
                missing_materials: entry.code.endsWith('-8') ? ['子公司签章审计报告原件'] : [],
                citations: [{ span_id: 'p0', quote: source.source.spans[0].text }],
              },
              required_evidence: '子公司财务及审计资料',
              facts,
              searched_span_ids: ['p0'],
              narrative: [],
              calculations: [],
            })),
          };
          await writeFile(join(cwd, 'output/batch-plan.json'), JSON.stringify(plan));
          const value = await options.fileWorkspace.collect(cwd, intent);
          assert.ok(options.validate(value));
          const ref = await journal.storeResult(
            intent,
            Buffer.from(JSON.stringify(value)),
            options.resultSchemaVersion,
          );
          await journal.recordObservation({
            ...intent,
            ...ref,
            provider_request_id: null,
            finish_reason: 'stop',
            outcome: 'completed',
            usage: {
              status: 'measured',
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: 100,
              reasoning_tokens: 0,
              total_tokens: 1100,
            },
            error_code: null,
          });
          return { kind: 'done', value };
        } finally {
          syntheticActive--;
        }
      },
    });
    const stage = m4DocumentStage({ model: real ? codexModelStage : synthetic, config });
    const counted: RunStage = {
      ...stage,
      run: async (ctx) =>
        stage.run({
          ...ctx,
          blobs: {
            ...ctx.blobs,
            getIfExistsBounded: async (key, n) => {
              if (key === sourceKey) sourceReads++;
              return ctx.blobs.getIfExistsBounded(key, n);
            },
          },
        }),
    };
    const execute = () =>
      runPipelineOnce({
        pool,
        blobs,
        runKinds: ['generation'],
        leaseSeconds: 180,
        stages: [inputLockStage, materialsReadyStage, counted, m4DocumentDeliveryStage()],
        onUnexpectedError: (e) => assert.fail(JSON.stringify(e)),
      });
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [
        owner,
        'four_' + owner.slice(0, 8),
      ]);
      await transaction(pool, (c) =>
        grantCredits(c, {
          owner,
          source: 'purchase',
          key: randomUUID(),
          points: 3000000,
          expiresAt: null,
          actor: 'synthetic',
          reason: 'Isolated batch acceptance',
        }),
      );
      const project = await ok('POST', '/api/v1/projects', {
          kind: 'generation',
          name: '合成250份底稿验收',
          issuer_name: '合成发行人集团',
          market: 'sse',
          offering: 'public',
        }),
        id = project.project_id,
        path = '/api/v1/projects/' + id,
        base = path + '/workpapers';
      await python([
        '-c',
        "from runpy import run_path; import sys; run_path('python/tests/test_workpaper_shared_batch.py')['fixture'](sys.argv[1], 3)",
        directory,
      ]);
      const sourcePin = await upload(
        id,
        'synthetic-prospectus.docx',
        await readFile(join(directory, 'source.docx')),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'historical',
      );
      sourceKey = (
        await pool.query(
          'SELECT object_key FROM bb_material_versions WHERE owner_user_id=$1 AND id=$2 AND version=$3',
          [owner, sourcePin.material_id, sourcePin.material_version],
        )
      ).rows[0].object_key;
      const versions = await ok('GET', path + '/prospectus-versions'),
        adopted = await ok('POST', path + '/prospectus-versions/current', {
          request_id: randomUUID(),
          expected_selection_revision: 0,
          version_id: versions.versions[0].version_id,
        });
      const catalogue = await headerlessCatalogueXlsx([
        ['编号', '文件名称', '分类'],
        ...Array.from({ length: 250 }, (_, i) => [`1-${i + 1}`, `财务核查 ${i + 1}`, '第一章']),
      ]);
      const material = await upload(
        id,
        'catalogue.xlsx',
        catalogue,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const cat = await ok('POST', base + '/catalogues', { request_id: randomUUID(), material });
      assert.equal(cat.entries.length, 250);
      const request = {
        start_mode: 'direct',
        catalogue_id: cat.catalogue_id,
        catalogue_sha256: cat.sha256,
        item_ids: cat.entries.map((e: any) => e.id),
        source_version_id: adopted.current_version_id,
        source_selection_revision: adopted.selection_revision,
        requirements:
          '逐份核查所选目录，不遗漏条目；需要未提供的原件时保留明确不适用/缺失材料说明。',
        price_version: WORKPAPER_PRICE.version,
        expected_points: String(250 * WORKPAPER_PRICE.points),
      };
      const receipts = [];
      for (const routes of [1, 4]) {
        const beforeCalls = syntheticCalls;
        syntheticPeak = 0;
        const batchRequest = { ...request, request_id: randomUUID() };
        let batch = (await ok('POST', base + '/batches', batchRequest)) as WorkpaperBatch;
        assert.equal((await ok('POST', base + '/batches', batchRequest)).batch_id, batch.batch_id);
        const started = performance.now();
        // Refill a free route immediately, as the actual independent run loops do;
        // waiting for the slowest member of a four-item wave understates throughput.
        const active = new Set<Promise<void>>(),
          failures: unknown[] = [];
        try {
          for (let completed = 0; completed < 600; completed++) {
            for (let slot = active.size; slot < routes; slot++) await advanceWorkpaperBatch(pool);
            batch = await ok('GET', base + `/batches/${batch.batch_id}`);
            if (['complete', 'partial', 'paused'].includes(batch.state)) break;
            while (active.size < routes) {
              const running = execute()
                .then((outcome) =>
                  assert.ok(outcome === 'succeeded' || outcome === 'idle', String(outcome)),
                )
                .catch((error) => {
                  failures.push(error);
                })
                .finally(() => {
                  active.delete(running);
                });
              active.add(running);
            }
            await Promise.race(active);
            if (failures.length) throw failures[0];
          }
        } finally {
          await Promise.all(active);
        }
        const elapsedMs = Math.round(performance.now() - started);
        assert.equal(batch.state, 'complete');
        assert.equal(batch.items.length, 250);
        assert.deepEqual(
          batch.items.map((i) => i.entry.id),
          request.item_ids,
        );
        assert.equal(batch.items.filter((i) => i.state === 'succeeded').length, 250);
        assert.ok(batch.items.every((i) => i.artifacts.length || i.explanation));
        const stats = (
          await pool.query(
            `SELECT a.id,a.logical_call_id,a.status,u.usage_status,rt.started_at,rt.duration_ms FROM bb_model_call_attempts a
    JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.id=a.job_id JOIN bb_workpaper_items i ON i.owner_user_id=j.owner_user_id AND i.run_id=j.run_id
    LEFT JOIN bb_call_usage u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id
    WHERE i.batch_id=$1 ORDER BY a.logical_call_id`,
            [batch.batch_id],
          )
        ).rows;
        const groups = (
          await pool.query(
            'SELECT group_id,author_run_id,receipt FROM bb_workpaper_progressive_groups WHERE owner_user_id=$1 AND batch_id=$2',
            [owner, batch.batch_id],
          )
        ).rows;
        assert.equal(groups.length, 32);
        assert.equal(stats.length, 32);
        assert.ok(stats.every((s) => s.status === 'completed'));
        assert.equal(new Set(groups.map((g) => g.group_id)).size, 32);
        assert.equal(new Set(groups.map((g) => g.author_run_id)).size, 32);
        let runtimePeak: number | null = null;
        if (real) {
          assert.ok(
            stats.every((s) => s.started_at && Number(s.duration_ms) > 0),
            'every actual call has durable process timing',
          );
          const events = stats
            .flatMap((s) => {
              const started = new Date(s.started_at).getTime();
              return [
                { at: started, delta: 1 },
                { at: started + Number(s.duration_ms), delta: -1 },
              ];
            })
            .sort((a, b) => a.at - b.at || a.delta - b.delta);
          let concurrent = 0;
          runtimePeak = 0;
          for (const event of events) {
            concurrent += event.delta;
            runtimePeak = Math.max(runtimePeak, concurrent);
          }
          assert.equal(
            runtimePeak,
            routes,
            'four routes must overlap actual calls, not only wait on one plan',
          );
        }
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM bb_workpaper_shared_sources WHERE owner_user_id=$1 AND batch_id=$2',
              [owner, batch.batch_id],
            )
          ).rows[0].n,
          1,
        );
        const zip = await send('GET', base + `/batches/${batch.batch_id}/download`);
        assert.equal(zip.statusCode, 200);
        const zipPath = join(directory, 'delivery-' + routes + '.zip');
        await writeFile(zipPath, zip.rawPayload);
        await python([
          '-c',
          "from zipfile import ZipFile; import sys; z=ZipFile(sys.argv[1]); names=z.namelist(); assert len(names)==250 and len(set(names))==250; assert all(n.endswith('.docx') for n in names); assert z.testzip() is None",
          zipPath,
        ]);
        if (process.env.BB_BATCH_FOUR_RECEIPT_DIR) {
          await mkdir(process.env.BB_BATCH_FOUR_RECEIPT_DIR, { recursive: true, mode: 0o700 });
          await writeFile(
            join(process.env.BB_BATCH_FOUR_RECEIPT_DIR, 'delivery-' + routes + '.zip'),
            zip.rawPayload,
            { mode: 0o600 },
          );
        }
        const charged = batch.charged_points;
        const intentsBefore = stats.length;
        for (let replay = 0; replay < 4; replay++) await execute();
        await advanceWorkpaperBatch(pool);
        const replayed = (await ok('GET', base + `/batches/${batch.batch_id}`)) as WorkpaperBatch;
        assert.equal(replayed.charged_points, charged);
        assert.deepEqual(
          replayed.items.map((i) => i.run_id),
          batch.items.map((i) => i.run_id),
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id JOIN bb_workpaper_items i ON i.run_id=j.run_id WHERE i.batch_id=$1',
              [batch.batch_id],
            )
          ).rows[0].n,
          intentsBefore,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM bb_jobs j JOIN bb_workpaper_items i ON i.run_id=j.run_id WHERE i.batch_id=$1 AND (j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL)',
              [batch.batch_id],
            )
          ).rows[0].n,
          0,
        );
        receipts.push({
          routes,
          batch_id: batch.batch_id,
          catalogue_sha256: cat.sha256,
          elapsed_ms: elapsedMs,
          files: 250,
          explanations: batch.items.filter((i) => i.explanation).length,
          model_calls: stats.length,
          group_authors: groups.length,
          synthetic_calls: real ? null : syntheticCalls - beforeCalls,
          synthetic_peak: real ? null : syntheticPeak,
          actual_runtime_peak: runtimePeak,
          charged_points: charged,
          zip_sha256: digest(zip.rawPayload),
          runtime: stats,
        });
      }
      assert.equal(sourceReads, 2, 'one source extraction per batch');
      const runtime_files: Record<string, string> = {};
      for (const name of [
        'batch-four-250.pg.test.js',
        'run-pipeline.js',
        'workpaper-shared-stage.js',
        'workpaper-progressive-groups.js',
        'codex-adapter.js',
        'durable-probe-journal.js',
      ])
        runtime_files[name] = digest(await readFile(fileURLToPath(new URL(name, import.meta.url))));
      const receipt = {
        mode: real ? 'real-model' : 'synthetic-model',
        model_id: config.model_id,
        model_config_version: config.model_config_version,
        runtime_files,
        catalogue_sha256: cat.sha256,
        source_sha256: sourcePin.sha256,
        receipts,
        ratio: receipts[0].elapsed_ms / receipts[1].elapsed_ms,
        node_max_rss_kib: process.resourceUsage().maxRSS,
        sourceReads,
      };
      t.diagnostic(JSON.stringify(receipt));
      if (process.env.BB_BATCH_FOUR_RECEIPT_DIR) {
        await mkdir(process.env.BB_BATCH_FOUR_RECEIPT_DIR, { recursive: true });
        await writeFile(
          join(process.env.BB_BATCH_FOUR_RECEIPT_DIR, 'batch-250-receipt.json'),
          JSON.stringify(receipt, null, 2),
          { mode: 0o600 },
        );
      }
    } finally {
      // Preserve known/unknown attempts, costs and original supplier evidence before
      // the test-only database/container cleanup, including when assertions fail.
      // Logs stay private on the execution host; never print or transport credentials.
      try {
        if (process.env.BB_BATCH_FOUR_RECEIPT_DIR) {
          await archiveBatchEvidence(
            pool,
            blobs,
            owner,
            process.env.BB_BATCH_FOUR_RECEIPT_DIR,
            real,
          );
        }
      } finally {
        await app.close();
        await pool.end();
      }
      await BlobServiceClient.fromConnectionString(storage!)
        .getContainerClient(container)
        .deleteIfExists();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

/** Test evidence only; original logs remain private on the execution host. */
export async function archiveBatchEvidence(
  pool: Pool,
  blobs: ReturnType<typeof azureBlobs>,
  owner: string,
  root: string,
  real: boolean,
) {
  const archive = join(root, 'fixture-evidence-' + owner);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const jobs = (
    await pool.query(
      `SELECT id,run_id,state,stage,error_code,attempts,
  lease_token IS NOT NULL AS has_lease,lease_until,user_pause_requested,credit_pause_requested
  FROM bb_jobs WHERE owner_user_id=$1 ORDER BY created_at,id`,
      [owner],
    )
  ).rows;
  const calls = (
    await pool.query(
      `SELECT a.*,row_to_json(u) AS usage,row_to_json(rt) AS runtime
  FROM bb_model_call_attempts a LEFT JOIN bb_call_usage u ON u.attempt_id=a.id
  LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id WHERE a.owner_user_id=$1 ORDER BY a.created_at,a.id`,
      [owner],
    )
  ).rows;
  const observations = (
    await pool.query(
      'SELECT * FROM bb_provider_call_observations WHERE owner_user_id=$1 ORDER BY observed_at,id',
      [owner],
    )
  ).rows;
  const reservations = (
    await pool.query('SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id', [
      owner,
    ])
  ).rows;
  const events = (
    await pool.query(
      'SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY created_at,id',
      [owner],
    )
  ).rows;
  const results = (
    await pool.query('SELECT * FROM bb_provider_result_refs WHERE owner_user_id=$1 ORDER BY id', [
      owner,
    ])
  ).rows;
  const logs = (
    await pool.query(
      'SELECT * FROM bb_codex_exec_logs WHERE owner_user_id=$1 ORDER BY attempt_id',
      [owner],
    )
  ).rows;
  const prompts = (
    await pool.query(
      "SELECT * FROM bb_snapshot_refs WHERE owner_user_id=$1 AND snapshot_kind='model_request' ORDER BY id",
      [owner],
    )
  ).rows;
  await writeFile(
    join(archive, 'ledger.json'),
    JSON.stringify(
      {
        mode: real ? 'real-model' : 'synthetic-model',
        jobs,
        calls,
        observations,
        reservations,
        events,
        results,
        logs,
        prompts,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  for (const ref of results) {
    const bytes = await blobs.getIfExistsBounded(ref.result_ref, 64 * 1024 * 1024);
    assert.ok(
      bytes && bytes.length === Number(ref.byte_size) && digest(bytes) === ref.result_sha256.trim(),
    );
    await writeFile(join(archive, 'result-' + ref.id + '.json'), bytes, { mode: 0o600 });
  }
  for (const ref of prompts) {
    const bytes = await blobs.getIfExistsBounded(ref.object_key, 64 * 1024 * 1024);
    assert.ok(bytes && digest(bytes) === ref.content_sha256.trim());
    await writeFile(join(archive, 'prompt-' + ref.id + '.txt'), bytes, { mode: 0o600 });
  }
  for (const ref of logs) {
    const bytes = await blobs.getIfExistsBounded(ref.object_key, 20 * 1024 * 1024);
    assert.ok(
      bytes && bytes.length === Number(ref.byte_size) && digest(bytes) === ref.sha256.trim(),
    );
    await writeFile(join(archive, 'exec-' + ref.attempt_id + '.log'), bytes, { mode: 0o600 });
  }
}
