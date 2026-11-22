// Synthetic issuer/model only; real API, queue, durable journal, Python Word
// rendering, private storage, accounting and authenticated ZIP download.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest, transaction, type PrivateBlobs } from '@bondbuddy/api/data';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { advanceWorkpaperBatch } from '@bondbuddy/api/workpapers';
import { renew, action as runAction } from '@bondbuddy/api/queue';
import {
  WORKPAPER_PRICE,
  workpaperChapters,
  type WorkpaperBatch,
  type WorkpaperSharedPlan,
} from '@bondbuddy/contracts';
import { grantCredits } from '../../api/dist/billing.js';
import { headerlessCatalogueXlsx } from '../../api/dist/workpaper-catalogue-fixture.js';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedTestDatabase } from './test-database.js';
import {
  inputLockStage,
  materialsReadyStage,
  runPipelineOnce,
  type codexModelStage,
  type RunStage,
} from './run-pipeline.js';
import { m4DocumentStage, m4DocumentDeliveryStage } from './m4-document-stage.js';
import { loadM4WorkerInput } from './m4-input.js';
import { sharedWorkpaperDocument, stoppedWorkpaperFailure } from './workpaper-shared-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { CodexDurableJournal } from './durable-probe-journal.js';
import { projectFilesRoot } from './project-file-tools.js';
const database = await isolatedTestDatabase(undefined, 'workpaper-progressive-groups');

test(
  'confirmed chapter groups share one call, isolate invalid items, retry only failures, fall back safely and serialize with lease renewal',
  { skip: !database, timeout: 300000 },
  async (t) => {
    const pool = new Pool({ connectionString: database, max: 2 }),
      owner = randomUUID();
    let actor = owner,
      modelCalls = 0,
      modelReplays = 0,
      sourceReads = 0,
      groupCalls = 0,
      singleCalls = 0;
    let scenario:
      'mixed' | 'fallback' | 'author_failure' | 'author_cancel' | 'provider_rejection' | 'global' =
      'mixed';
    const renewals: Promise<unknown>[] = [];
    const directory = await mkdtemp(join(tmpdir(), 'bb-shared-test-'));
    const storage = new Map<string, Buffer>();
    const blobs: PrivateBlobs = {
      put: async (k, b) => {
        storage.set(k, Buffer.from(b));
      },
      get: async (k) => Buffer.from(storage.get(k)!),
      getIfExists: async (k) => storage.get(k) ?? null,
      getIfExistsBounded: async (k, max) => {
        const b = storage.get(k);
        if (b && b.length > max) throw Error('too large');
        return b ?? null;
      },
      exists: async (k) => storage.has(k),
      delete: async (k) => {
        storage.delete(k);
      },
    };
    const origin = 'http://bondbuddy.test',
      app = createServer({
        pool,
        blobs,
        historicalBillingFixture: true,
        allowedOrigin: origin,
        enableRunRuntime: true,
        principal: async () => ({ userId: actor, csrfVerified: true }),
      });
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
      const base = '/api/v1/projects/' + id,
        declaration = { byte_size: bytes.length, sha256: digest(bytes) };
      const u = await ok('POST', base + '/materials/uploads', {
        ...declaration,
        filename: name,
        media_type,
        role,
      });
      assert.equal((await send('PUT', u.upload_url, bytes)).statusCode, 204);
      const m = await ok(
        'POST',
        base + '/materials/uploads/' + u.upload_id + '/complete',
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
      promisify(execFile)(process.env.BONDBUDDY_TEST_PYTHON ?? 'python3', ['-B', ...args], {
        cwd: projectFilesRoot,
        env: { ...process.env, PYTHONPATH: join(projectFilesRoot, 'python') },
        maxBuffer: 1024 * 1024,
      });
    const config = {
      ...loadCodexAdapterConfig({}),
      model_id: 'synthetic-group-model',
      model_config_version: 'synthetic-group-v1',
    };
    const model: typeof codexModelStage = (options) => ({
      name: options.name,
      replay: true,
      run: async (ctx) => {
        const gate = await ctx.validateBeforeModelCall?.();
        if (gate) return gate;
        const group = options.name === 'workpaper_progressive_group_v1';
        // User cancellation before a provider intent: the queue can conclusively
        // terminate this file with no call or usage requiring reconciliation.
        if (group && scenario === 'author_cancel') {
          modelCalls++;
          groupCalls++;
          await runAction(pool, owner, ctx.run.id, 'cancel');
          return { kind: 'stopped' };
        }
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
          modelReplays++;
          return { kind: 'done', value: saved.value };
        }
        let snapshot = '';
        while (!snapshot) {
          const version = Number(
            (
              await pool.query(
                "SELECT COALESCE(max(version),0)+1 n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",
                [owner, ctx.run.project_id],
              )
            ).rows[0].n,
          );
          try {
            snapshot = await savePromptSnapshot(pool, blobs, {
              owner,
              projectId: ctx.run.project_id,
              runId: ctx.run.id,
              kind: 'model_request',
              version,
              body: await options.buildPrompt(ctx),
              inputRevision: ctx.run.input_revision,
              inputHash: ctx.run.input_hash,
              templateVersion: options.templateVersion,
            });
          } catch (error) {
            if ((error as { code?: string }).code !== '23505') throw error;
          }
        }
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
        modelCalls++;
        if (group) groupCalls++;
        else singleCalls++;
        const source = JSON.parse(await readFile(join(cwd, 'source-data.json'), 'utf8')),
          batch = JSON.parse(await readFile(join(cwd, 'batch-input.json'), 'utf8'));
        assert.ok(
          group
            ? batch.entries.length > 1 && batch.entries.length <= 8
            : batch.entries.length === 1,
        );
        const usage = {
          status: 'measured' as const,
          input_tokens: 1000,
          cached_input_tokens: 0,
          output_tokens: 100,
          reasoning_tokens: 0,
          total_tokens: 1100,
        };
        if (group && (scenario === 'author_failure' || scenario === 'provider_rejection')) {
          await journal.recordObservation({
            ...intent,
            provider_request_id: null,
            finish_reason: 'stop',
            outcome: 'failed',
            result_ref: null,
            result_sha256: null,
            result_schema_version: null,
            result_byte_size: null,
            usage,
            error_code:
              scenario === 'provider_rejection'
                ? 'MODEL_PROVIDER_REQUEST_REJECTED'
                : 'MODEL_OUTPUT_SCHEMA_INVALID',
          });
          return { kind: 'stopped' };
        }
        const facts = source.source.spans.filter((s: any) => s.text.trim()).map((s: any) => s.id);
        const plan: WorkpaperSharedPlan = {
          version: 'workpaper-shared-plan-v1',
          source_sha256: source.source.sha256,
          reviewed_span_ids: facts,
          excluded: [],
          image_reviews: source.images.map((image: any) => ({
            image_id: image.id,
            description: '合成图片已核对，与本次子公司清单相关。',
            verified: !(group && scenario === 'global'),
            item_ids: batch.entries.map((e: any) => e.id),
          })),
          items: batch.entries.map((entry: any) => ({
            item_id: entry.id,
            decision: {
              item_id: entry.id,
              status: 'generate',
              reason: '已有完整子公司财务披露数据，可形成对应财务核查清单。',
              missing_materials: [],
              citations: [{ span_id: 'p0', quote: source.source.spans[0].text }],
            },
            required_evidence: '子公司主体及完整财务数据清单',
            facts,
            searched_span_ids: ['p0'],
            narrative:
              group && scenario === 'mixed' && entry.code === '1-3'
                ? [{ text: '合成发行人的资产为999999万元。', sources: ['p0'] }]
                : [],
            calculations: [],
          })),
        };
        await writeFile(
          join(cwd, 'output/batch-plan.json'),
          group && scenario === 'fallback' ? 'not JSON' : JSON.stringify(plan),
        );
        let value: unknown;
        try {
          value = await options.fileWorkspace.collect(cwd, intent);
        } catch (error) {
          if (scenario !== 'global') throw error;
          await journal.recordObservation({
            ...intent,
            provider_request_id: null,
            finish_reason: null,
            outcome: 'pending_reconcile',
            result_ref: null,
            result_sha256: null,
            result_schema_version: null,
            result_byte_size: null,
            usage,
            error_code: 'MODEL_RESULT_STORE_FAILED',
          });
          return { kind: 'stopped' };
        }
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
          usage,
          error_code: null,
        });
        return { kind: 'done', value };
      },
    });
    const stage = m4DocumentStage({ model, config });
    const guarded: RunStage = {
      ...stage,
      run: async (ctx) => {
        const input = await loadM4WorkerInput(ctx);
        const source = input.materials.find(
          (m) => m.pin.sha256 === (input.manifest as any).input.source_material?.sha256,
        )!;
        const contentionPool = new Proxy(pool, {
          get(target, key) {
            if (key === 'connect')
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(c, key) {
                    if (key === 'query')
                      return async (...args: any[]) => {
                        const result = await (c.query as any)(...args);
                        if (
                          typeof args[0] === 'string' &&
                          args[0].includes('SELECT 1 FROM bb_jobs j JOIN bb_runs') &&
                          args[0].includes('FOR UPDATE OF j')
                        ) {
                          renewals.push(renew(pool, ctx.lease, 120));
                          await delay(60);
                        }
                        return result;
                      };
                    const v = Reflect.get(c, key);
                    return typeof v === 'function' ? v.bind(c) : v;
                  },
                });
              };
            const v = Reflect.get(target, key);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
        return stage.run({
          ...ctx,
          pool: contentionPool,
          blobs: {
            ...ctx.blobs,
            getIfExistsBounded: async (key: string, max: number) => {
              if (key === source.objectKey) sourceReads++;
              return ctx.blobs.getIfExistsBounded(key, max);
            },
          },
        });
      },
    };
    const execute = () =>
      runPipelineOnce({
        pool,
        blobs,
        runKinds: ['generation'],
        leaseSeconds: 120,
        stages: [inputLockStage, materialsReadyStage, guarded, m4DocumentDeliveryStage()],
        onUnexpectedError: (e) => assert.fail(JSON.stringify(e)),
      });
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [
        owner,
        'group_' + owner.slice(0, 8),
      ]);
      await transaction(pool, (c) =>
        grantCredits(c, {
          owner,
          source: 'purchase',
          key: randomUUID(),
          points: 100000,
          expiresAt: null,
          actor: 'synthetic',
          reason: 'isolated progressive group test',
        }),
      );
      const project = await ok('POST', '/api/v1/projects', {
          kind: 'generation',
          name: '合成小组底稿测试',
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
      await python([
        '-c',
        "from pathlib import Path; from PIL import Image; from docx import Document; import sys; p=Path(sys.argv[1]); Image.new('RGB',(200,80),'navy').save(p/'diagram.png'); d=Document(p/'source.docx'); d.add_picture(str(p/'diagram.png')); d.save(p/'source.docx')",
        directory,
      ]);
      await upload(
        id,
        'synthetic-prospectus.docx',
        await readFile(join(directory, 'source.docx')),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'historical',
      );
      const versions = await ok('GET', path + '/prospectus-versions'),
        adopted = await ok('POST', path + '/prospectus-versions/current', {
          request_id: randomUUID(),
          expected_selection_revision: 0,
          version_id: versions.versions[0].version_id,
        });
      const material = await upload(
        id,
        'catalogue.xlsx',
        await headerlessCatalogueXlsx([
          ['编号', '文件名称', '分类'],
          ...Array.from({ length: 5 }, (_, i) => [`1-${i + 1}`, `财务核查 ${i + 1}`, '第一章']),
        ]),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const cat = await ok('POST', base + '/catalogues', { request_id: randomUUID(), material });
      const request = {
        progressive: { chapter_order: workpaperChapters(cat.entries).map((c) => c.id) },
        start_mode: 'direct',
        catalogue_id: cat.catalogue_id,
        catalogue_sha256: cat.sha256,
        source_version_id: adopted.current_version_id,
        source_selection_revision: adopted.selection_revision,
        requirements: '完整核查所选条目。',
        price_version: WORKPAPER_PRICE.version,
      };
      const read = async (batch: WorkpaperBatch) =>
        (await ok('GET', base + `/batches/${batch.batch_id}`)) as WorkpaperBatch;
      const start = async (count: number) =>
        (await ok('POST', base + '/batches', {
          ...request,
          request_id: randomUUID(),
          item_ids: cat.entries.slice(0, count).map((e: any) => e.id),
          expected_points: String(count * WORKPAPER_PRICE.points),
        })) as WorkpaperBatch;
      const continueBatch = async (batch: WorkpaperBatch) =>
        (await ok('POST', base + `/batches/${batch.batch_id}/actions`, {
          action: 'continue_remaining',
          expected_revision: batch.revision,
          request_id: randomUUID(),
        })) as WorkpaperBatch;
      const drain = async (batch: WorkpaperBatch) => {
        for (let loops = 0; loops < 12; loops++) {
          await advanceWorkpaperBatch(pool);
          await advanceWorkpaperBatch(pool);
          await Promise.all([execute(), execute()]);
          await advanceWorkpaperBatch(pool);
          batch = await read(batch);
          if (['partial', 'complete', 'paused'].includes(batch.state)) return batch;
        }
        throw Error('SYNTHETIC_GROUP_DID_NOT_FINISH');
      };
      const startTime = performance.now();
      let batch = await start(5);
      await advanceWorkpaperBatch(pool);
      assert.equal(await execute(), 'succeeded');
      const firstMs = Math.round(performance.now() - startTime);
      await advanceWorkpaperBatch(pool);
      batch = await read(batch);
      assert.equal(batch.progressive?.phase, 'awaiting_confirmation');
      assert.equal(modelCalls, 1);
      assert.equal(groupCalls, 0);
      assert.equal(batch.items.filter((i) => i.artifacts.length).length, 1);
      assert.equal(
        (await pool.query('SELECT count(*) n FROM bb_workpaper_progressive_groups')).rows[0].n,
        '0',
        'remaining items are never planned before confirmation',
      );
      batch = await continueBatch(batch);
      batch = await drain(batch);
      assert.equal(batch.state, 'partial');
      assert.equal(batch.items.find((i) => i.entry.code === '1-3')?.state, 'failed');
      assert.equal(
        batch.items.filter((i) => i.state === 'succeeded').length,
        4,
        'a rejected item does not block later siblings',
      );
      assert.equal(modelCalls, 2);
      assert.equal(groupCalls, 1);
      assert.equal(sourceReads, 1);
      const savedRuns = batch.items.filter((i) => i.state === 'succeeded').map((i) => i.run_id),
        callsBeforeRetry = modelCalls;
      batch = await ok('POST', base + `/batches/${batch.batch_id}/actions`, {
        action: 'retry_failed',
        expected_revision: batch.revision,
      });
      batch = await drain(batch);
      assert.equal(batch.state, 'complete');
      assert.equal(modelCalls, callsBeforeRetry + 1);
      assert.equal(
        groupCalls,
        1,
        'failed item retries individually instead of replaying the immutable group error',
      );
      assert.ok(savedRuns.every((run) => batch.items.some((i) => i.run_id === run)));
      assert.equal(batch.charged_points, String(5 * WORKPAPER_PRICE.points));
      await Promise.all(renewals);
      assert.ok(renewals.length > 0, 'cache commit was interleaved with real queue lease renewal');
      await assert.rejects(pool.query('DELETE FROM bb_workpaper_progressive_groups'), {
        code: '23514',
      });
      t.diagnostic(
        JSON.stringify({
          boundary: 'synthetic model; real API/PG/Python/private storage',
          files: 5,
          first_delivery_from_submission_ms: firstMs,
          total_with_failed_item_retry_ms: Math.round(performance.now() - startTime),
          source_extractions: sourceReads,
          model_calls: modelCalls,
          group_calls: groupCalls,
          single_calls: singleCalls,
          renewal_interleavings: renewals.length,
        }),
      );
      for (const mode of [
        'fallback',
        'author_failure',
        'author_cancel',
        'provider_rejection',
        'global',
      ] as const) {
        scenario = mode;
        const previousGroups: number = groupCalls,
          previousCalls: number = modelCalls;
        batch = await start(3);
        await advanceWorkpaperBatch(pool);
        assert.equal(await execute(), 'succeeded');
        await advanceWorkpaperBatch(pool);
        batch = await read(batch);
        batch = await continueBatch(batch);
        batch = await drain(batch);
        assert.equal(
          groupCalls,
          previousGroups + 1,
          'a group is attempted once despite two workers',
        );
        const receipts = (
          await pool.query(
            'SELECT receipt FROM bb_workpaper_progressive_groups WHERE batch_id=$1',
            [batch.batch_id],
          )
        ).rows;
        if (mode === 'global') {
          assert.equal(batch.state, 'paused');
          assert.equal(
            receipts.length,
            0,
            'unverified images are not converted into a recoverable fallback',
          );
          assert.equal(batch.items.filter((i) => i.artifacts.length).length, 1);
          break;
        }
        if (mode === 'provider_rejection') {
          assert.equal(batch.state, 'paused');
          assert.equal(receipts.length, 0);
          assert.equal(batch.items.filter((i) => i.state === 'failed').length, 2);
          await advanceWorkpaperBatch(pool);
          assert.equal(
            modelCalls,
            previousCalls + 2,
            'a shared provider failure never automatically repeats a model call',
          );
          batch = await read(batch);
          batch = await ok('POST', base + `/batches/${batch.batch_id}/actions`, {
            action: 'retry_failed',
            expected_revision: batch.revision,
          });
          batch = await drain(batch);
          assert.equal(batch.state, 'complete');
          assert.equal(modelCalls - previousCalls, 4);
          continue;
        }
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].receipt.status, 'fallback');
        assert.deepEqual(receipts[0].receipt.items, []);
        if (mode === 'author_failure' || mode === 'author_cancel') {
          assert.equal(batch.state, 'partial');
          assert.equal(batch.items[1].state, mode === 'author_cancel' ? 'cancelled' : 'failed');
          assert.equal(batch.items[2].state, 'succeeded');
          batch = await ok('POST', base + `/batches/${batch.batch_id}/actions`, {
            action: 'retry_failed',
            expected_revision: batch.revision,
          });
          batch = await drain(batch);
        }
        assert.equal(batch.state, 'complete');
        assert.equal(
          modelCalls - previousCalls,
          4,
          'one trial, one group disposition and two independent item plans',
        );
      }
      await Promise.all(renewals);
      assert.equal(sourceReads, 6);
    } finally {
      await app.close();
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
