// Synthetic model proposals; real upload, database, private storage, queues, versioning and Word patching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PROJECT_FILE_UPDATE_PRICE } from '@bondbuddy/contracts';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, digest, transaction } from '@bondbuddy/api/data';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { checkpointStage } from '@bondbuddy/api/queue';
import { advanceProjectFileBatch } from '@bondbuddy/api/project-file-workspace';
import { advanceProjectFileUpdates } from '@bondbuddy/api/project-file-consistency';
import { grantCredits, creditBalance } from '../../api/dist/billing.js';
import { makeSyntheticDocxFixture } from '../../api/dist/docx-fixtures.js';
import { isolatedTestDatabase } from './test-database.js';
import { CodexDurableJournal } from './durable-probe-journal.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import {
  inputLockStage,
  materialsReadyStage,
  runPipelineOnce,
  type codexModelStage,
  type StageContext,
} from './run-pipeline.js';
import { m4DocumentStage } from './m4-document-stage.js';
import { projectFileModelStage, projectFileDeliveryStage } from './project-file-stage.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { inspectProjectFile } from './project-file-tools.js';

const database = await isolatedTestDatabase(undefined, 'project-files-four'),
  storage = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
test(
  'four distinct file generations and patches overlap while version CAS and charges remain isolated',
  { skip: !database || !storage || !process.env.BONDBUDDY_TEST_PYTHON, timeout: 300000 },
  async () => {
    const pool = new Pool({ connectionString: database }),
      owner = randomUUID(),
      container = 'bb-files-' + randomUUID().replaceAll('-', ''),
      dir = await mkdtemp(join(tmpdir(), 'bb-files-e2e-'));
    let actor = owner;
    const blobs = azureBlobs(storage!, container),
      origin = 'http://bondbuddy.test';
    const app = createServer({
      pool,
      blobs,
      historicalBillingFixture: true,
      allowedOrigin: origin,
      enableRunRuntime: true,
      principal: async () => ({ userId: actor, csrfVerified: true }),
    });
    const send = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as any,
        url,
        payload: payload as any,
        headers: {
          origin,
          ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
        },
      });
    const ok = async (method: string, url: string, payload?: unknown) => {
      const r = await send(method, url, payload);
      assert.ok(r.statusCode < 300, r.body);
      return r.body ? r.json() : null;
    };
    const oldText = 'Synthetic. 发行规模100万元。2025年总资产200万元。';
    const newText = 'Synthetic. 发行规模120万元。2025年总资产220万元。';
    const oldBytes = makeSyntheticDocxFixture({ text: oldText }),
      newBytes = makeSyntheticDocxFixture({ text: newText });
    const upload = async (project: string, name: string, bytes: Buffer, role = 'other') => {
      const p = '/api/v1/projects/' + project,
        declaration = { byte_size: bytes.length, sha256: digest(bytes) };
      const u = await ok('POST', p + '/materials/uploads', {
        ...declaration,
        filename: name,
        media_type: DOCX,
        role,
      });
      assert.equal((await send('PUT', u.upload_url, bytes)).statusCode, 204);
      const m = await ok(
        'POST',
        p + '/materials/uploads/' + u.upload_id + '/complete',
        declaration,
      );
      return {
        source_project_id: project,
        material_id: m.material_id,
        material_version: m.material_version,
        sha256: m.sha256,
      };
    };
    let calls = 0,
      active = 0,
      peak = 0;
    const model: typeof codexModelStage = (options) => ({
      name: options.name,
      replay: true,
      run: async (ctx: StageContext) => {
        const gate = await ctx.validateBeforeModelCall?.();
        if (gate) return gate;
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
        await checkpointStage(pool, ctx.lease, 'synthetic_file_prompt', {
          snapshot_id: snapshot,
          synthetic_model: true,
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
          model_id: 'synthetic-files-model',
          model_config_version: 'synthetic-v1',
          prompt_snapshot_ref: snapshot,
        };
        const cwd = join(dir, intent.call_id);
        await mkdir(cwd);
        await options.fileWorkspace!.prepare(cwd);
        await journal.recordIntent(intent);
        calls++;
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Reproduce the real adapter's required writable scratch boundary, even with a synthetic model.
        await writeFile(join(cwd, 'scratch/permission-result'), 'probe');
        assert.equal(await readFile(join(cwd, 'scratch/permission-result'), 'utf8'), 'probe');
        if (options.logicalCallId.startsWith('file-check-')) {
          const source = JSON.parse(await readFile(join(cwd, 'source-spans.json'), 'utf8')),
            target = JSON.parse(await readFile(join(cwd, 'target-spans.json'), 'utf8'));
          const sp = source.spans.find((p: any) => p.text.includes('发行规模')),
            tp = target.spans.find((p: any) => p.text.includes('发行规模'));
          const findings = [
            ['100万元', '120万元', '发行规模'],
            ['200万元', '220万元', '总资产'],
          ]
            .filter(([before]) => tp.text.includes(before))
            .map(([before, after, field]) => ({
              kind: 'conflict',
              target_span_id: tp.id,
              original: before,
              replacement: after,
              source_span_id: sp.id,
              source_quote: after,
              reason: 'Synthetic comparison of exact amounts',
              field,
              period: field === '总资产' ? '2025年' : '本期',
              unit: '万元',
            }));
          await writeFile(
            join(cwd, 'output/check.json'),
            JSON.stringify({
              coverage:
                'Synthetic proposals; exact source and target anchors are verified by host.',
              checked_span_ids: target.spans.map((p: any) => p.id),
              findings,
              links: [
                {
                  source_span_id: sp.id,
                  source_quote: 'Synthetic.',
                  target_span_id: tp.id,
                  target_quote: 'Synthetic.',
                  field: '标记',
                  period: '',
                  unit: '',
                },
              ],
            }),
          );
        } else {
          await writeFile(join(cwd, 'output/document.docx'), oldBytes);
          await writeFile(
            join(cwd, 'output/preparation-note.docx'),
            makeSyntheticDocxFixture({ text: 'Synthetic preparation note' }),
          );
          await writeFile(
            join(cwd, 'output/file-links.json'),
            JSON.stringify({
              links: [
                {
                  source_span_id: 'p0',
                  source_quote: '100万元',
                  target_span_id: 'p0',
                  target_quote: '100万元',
                  field: '发行规模',
                  period: '本期',
                  unit: '万元',
                },
              ],
            }),
          );
        }
        const value = await options.fileWorkspace!.collect(cwd, intent, {
          text: 'Synthetic file authoring; no supplier call',
        });
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
        active--;
        return { kind: 'done', value };
      },
    });
    const config = {
      ...loadCodexAdapterConfig({}),
      model_id: 'synthetic-files-model',
      model_config_version: 'synthetic-v1',
    };
    const fileStage = projectFileModelStage({ model });
    const replaySafeFileStage = {
      ...fileStage,
      run: async (ctx: StageContext) => {
        const result = await fileStage.run(ctx);
        const op = (
          await pool.query('SELECT operation FROM bb_project_file_operations WHERE run_id=$1', [
            ctx.run.id,
          ])
        ).rows[0];
        if (op.operation === 'patch' && result.kind === 'done') {
          // Simulate a process loss after durable output save but before stage checkpoint.
          const replay = await fileStage.run({ ...ctx, checkpoint: {} });
          assert.equal(replay.kind, 'done');
          if (replay.kind === 'done') assert.deepEqual(replay.value, result.value);
        }
        return result;
      },
    };
    const execute = (operation: boolean) =>
      runPipelineOnce({
        pool,
        blobs,
        leaseSeconds: 120,
        runKinds: ['generation'],
        stages: [
          inputLockStage,
          materialsReadyStage,
          operation ? replaySafeFileStage : m4DocumentStage({ config, model }),
          operation ? projectFileDeliveryStage() : historicalWordDeliveryStage(),
        ],
        onUnexpectedError: (e) => assert.fail(JSON.stringify(e)),
      });
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [
        owner,
        'files_' + randomUUID().slice(0, 8),
      ]);
      await transaction(pool, (c) =>
        grantCredits(c, {
          owner,
          source: 'purchase',
          key: randomUUID(),
          points: 100000,
          expiresAt: null,
          actor: 'synthetic',
          reason: 'file e2e',
        }),
      );
      const p = await ok('POST', '/api/v1/projects', {
          kind: 'generation',
          name: 'Synthetic files project',
          issuer_name: 'Synthetic issuer',
          market: 'sse',
          offering: 'private',
        }),
        id = p.project_id,
        path = '/api/v1/projects/' + id,
        base = path + '/project-files';
      // An existing self-owned materials topic is a supported workspace source.
      // Its source_project_id is NULL; no child scope is fabricated by this fixture.
      const selfTopic = randomUUID();
      await pool.query(
        "INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash,surface) VALUES($1,$2,$3,'Synthetic existing materials topic',$1,$4,'materials')",
        [selfTopic, owner, id, digest(selfTopic)],
      );
      const source = await upload(id, 'source-v1.docx', oldBytes, 'historical');
      let versions = await ok('GET', path + '/prospectus-versions');
      const selected = await ok('POST', path + '/prospectus-versions/current', {
        request_id: randomUUID(),
        expected_selection_revision: 0,
        version_id: versions.versions[0].version_id,
      });
      let w = await ok('POST', base + '/workspace', { request_id: randomUUID() });
      assert.equal(w.workspace.topic.topic_id, selfTopic);
      assert.equal(
        (await pool.query('SELECT source_project_id FROM bb_m4_topics WHERE id=$1', [selfTopic]))
          .rows[0].source_project_id,
        null,
      );
      assert.equal(Object.keys(w.workspace.drafts).length, 13);
      w = await ok('POST', base + '/source', {
        source_version_id: selected.current_version_id,
        expected_selection_revision: selected.selection_revision,
      });
      const batch = {
        request_id: randomUUID(),
        source_version_id: selected.current_version_id,
        expected_selection_revision: selected.selection_revision,
        documents: [{ document_type: 'issuer', draft_version: w.workspace.drafts.issuer.version }],
      };
      assert.equal(
        (await send('POST', base + '/batches', batch)).statusCode,
        422,
        'template required',
      );
      const templateMaterial = await upload(id, 'template.docx', oldBytes);
      for (const type of ['issuer', 'annual', 'financial', 'credit']) {
        const t = (
          await ok('POST', '/api/v1/m4/templates', {
            creation_request_id: randomUUID(),
            name: 'Synthetic ' + type,
            broker: '',
            document_type: type,
            material: templateMaterial,
            market: 'sse',
            offering: 'private',
          })
        ).template;
        const { version, sha256, updated_at, ...input } = w.workspace.drafts[type];
        input.template = {
          template_id: t.template_id,
          template_version: t.template_version,
          sha256: t.sha256,
        };
        const saved = await ok(
          'PUT',
          '/api/v1/m4/topics/' + w.workspace.topic.topic_id + '/drafts/' + type,
          { expected_version: version, input },
        );
        w.workspace.drafts[type] = saved.draft;
      }
      batch.documents = ['issuer', 'annual', 'financial', 'credit'].map((type) => ({
        document_type: type,
        draft_version: w.workspace.drafts[type].version,
      }));
      const submitted = await ok('POST', base + '/batches', batch);
      assert.equal((await ok('POST', base + '/batches', batch)).batch_id, submitted.batch_id);
      for (let i = 0; i < 4; i++) assert.equal(await advanceProjectFileBatch(pool), true);
      assert.equal(await advanceProjectFileBatch(pool), false);
      const admitted = (
        await pool.query('SELECT items FROM bb_project_file_batches WHERE id=$1', [
          submitted.batch_id,
        ])
      ).rows[0].items;
      assert.equal(new Set(admitted.map((i: any) => i.run_id)).size, 4);
      await assert.rejects(
        transaction(pool, async (c) => {
          const foreignRun = randomUUID(),
            hash = digest('unrelated');
          await c.query(
            "INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,9999,$2,1,$3,'{}','[]','[]')",
            [id, owner, hash],
          );
          await c.query(
            "INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,9999,$4,$1,'generation',$4,'queued')",
            [foreignRun, owner, id, hash],
          );
        }),
        { code: '23514' },
        'a self-owned topic still protects the canonical project from unrelated runs',
      );
      assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => execute(false))), [
        'succeeded',
        'succeeded',
        'succeeded',
        'succeeded',
      ]);
      assert.equal(peak, 4);
      assert.equal(active, 0);
      assert.equal(calls, 4);
      await advanceProjectFileBatch(pool);
      const generated = await ok('GET', base);
      assert.equal(generated.files.filter((f: any) => f.latest).length, 4);
      assert.equal(generated.files[0].links.length, 1);
      assert.equal(generated.files[0].source_version_id, selected.current_version_id);
      await upload(id, 'source-v2.docx', newBytes, 'historical');
      versions = await ok('GET', path + '/prospectus-versions');
      const changed = await ok('POST', path + '/prospectus-versions/current', {
        request_id: randomUUID(),
        expected_selection_revision: versions.selection_revision,
        version_id: versions.versions[0].version_id,
      });
      const check = await ok('POST', base + '/checks', {
        request_id: randomUUID(),
        expected_source_version_id: changed.current_version_id,
      });
      assert.equal(await execute(true), 'succeeded');
      const checked = (await ok('GET', base + '/checks')).checks[0];
      assert.equal(checked.result.files.length, 4);
      const accept = {
        request_id: randomUUID(),
        expected_check_sha256: checked.sha256,
        price_version: PROJECT_FILE_UPDATE_PRICE.version,
        expected_points: '18000',
        files: checked.files.map((f: any) => ({ file_version_id: f.file_version_id })),
      };
      const patchBatch = await ok('POST', base + '/checks/' + check.run_id + '/updates', accept);
      for (let i = 0; i < 4; i++) assert.equal(await advanceProjectFileUpdates(pool), true);
      assert.equal(await advanceProjectFileUpdates(pool), false);
      const patches = (
        await pool.query('SELECT items FROM bb_project_file_update_batches WHERE id=$1', [
          patchBatch.batch_id,
        ])
      ).rows[0].items;
      assert.equal(new Set(patches.map((i: any) => i.manifest.file_id)).size, 4);
      assert.ok(
        patches.every(
          (i: any) => i.manifest.expected_current_version_id === i.manifest.file_version_id,
        ),
      );
      await assert.rejects(
        pool.query(
          "UPDATE bb_project_file_update_batches SET items=jsonb_set(items,'{1,manifest,file_id}',to_jsonb($2::text)) WHERE id=$1",
          [patchBatch.batch_id, patches[0].manifest.file_id],
        ),
        { code: '23514' },
        'frozen membership cannot be rewritten to a shared Word target',
      );
      assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => execute(true))), [
        'succeeded',
        'succeeded',
        'succeeded',
        'succeeded',
      ]);
      await advanceProjectFileUpdates(pool);
      const files = (await ok('GET', base)).files;
      assert.equal(files.filter((f: any) => f.latest && f.sequence === 2).length, 4);
      const settled = (
        await pool.query(
          "SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=ANY($1::text[]) AND state='settled'",
          [patches.map((i: any) => i.run_id)],
        )
      ).rows[0].n;
      assert.equal(settled, 4);
      const balance = await creditBalance(pool, owner);
      assert.equal(balance.frozen, 0);
      assert.equal(await advanceProjectFileUpdates(pool), false);
      assert.equal(await execute(true), 'idle');
      assert.deepEqual(await creditBalance(pool, owner), balance);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM bb_jobs WHERE run_id=ANY($1::text[]) AND (lease_token IS NOT NULL OR lease_until IS NOT NULL)',
            [patches.map((i: any) => i.run_id)],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await app.close();
      await pool.end();
      await BlobServiceClient.fromConnectionString(storage!)
        .getContainerClient(container)
        .deleteIfExists();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
