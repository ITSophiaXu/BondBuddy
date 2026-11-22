// Real isolated PostgreSQL; in-memory private Blob substitute and synthetic Codex process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { claim } from '@bondbuddy/api/queue';
import { codexModelStage, type StageContext } from './run-pipeline.js';
import { DEFAULT_DISABLED_FEATURES, type CodexAdapterConfig } from './codex-adapter.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_CODEX_DATABASE_URL');
test(
  'image and prompt pin survive worker restart; corrupt or swapped image cannot send another call',
  { skip: !connection },
  async () => {
    const pool = new Pool({ connectionString: connection });
    const data = new Map<string, Buffer>();
    const blobs: PrivateBlobs = {
      put: async (k, b) => {
        data.set(k, b);
      },
      get: async (k) => data.get(k)!,
      getIfExists: async (k) => data.get(k) ?? null,
      getIfExistsBounded: async (k, max) => {
        const b = data.get(k);
        if (b && b.length > max) throw Error('too large');
        return b ?? null;
      },
      exists: async (k) => data.has(k),
      delete: async (k) => {
        data.delete(k);
      },
    };
    const owner = 'image-owner-' + randomUUID();
    const app = createServer({
      pool,
      blobs,
      allowedOrigin: 'http://bondbuddy.test',
      principal: async () => ({ userId: owner, csrfVerified: true }),
      enableSyntheticQueue: true,
    });
    const root = await mkdtemp(join(tmpdir(), 'bb-image-stage-'));
    const config: CodexAdapterConfig = {
      command: [
        process.execPath,
        fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url)),
      ],
      model_id: 'deepseek-flash',
      model_provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      wire_api: 'responses',
      model_config_version: 'synthetic-image-v1',
      reasoning_effort: null,
      credential: { kind: 'env', name: 'BB_SYNTHETIC_KEY' },
      work_root: root,
      timeout_ms: 5000,
      kill_grace_ms: 100,
      max_output_bytes: 1048576,
      max_schema_reasks: 0,
      disabled_features: DEFAULT_DISABLED_FEATURES,
      path_env: '/usr/bin:/bin',
    };
    const send = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: { origin: 'http://bondbuddy.test' },
        payload: payload as any,
      });
    try {
      const p = await send('/api/v1/projects', {
        name: 'Synthetic image input',
        kind: 'update',
        issuer_name: null,
        market: null,
        offering: null,
      });
      assert.equal(p.statusCode, 201, p.body);
      const projectId = p.json().project_id;
      const input = await send('/api/v1/projects/' + projectId + '/input-revisions', {
        draft_revision: 1,
        material_versions: [],
        requirement_message_ids: [],
      });
      const submitted = await send('/api/v1/runs/execute', {
        execution_request_id: 'image-' + randomUUID(),
        project_id: projectId,
        input_revision: 1,
        input_hash: input.json().input_hash,
        task_kind: 'update',
        input_manifest_ref: 'synthetic-manifest',
        storage_origin: 'cloud',
        workspace_id: 'synthetic-worker',
      });
      assert.equal(submitted.statusCode, 202, submitted.body);
      const lease = await claim(pool, 120);
      assert.ok(lease);
      assert.equal(lease.runId, submitted.json().run_id);
      const run = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [lease.runId])).rows[0];
      const ctx: StageContext = {
        pool,
        blobs,
        lease,
        run,
        checkpoint: {},
        values: new Map(),
        signal: new AbortController().signal,
      };
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
        'base64',
      );
      const imageInput = { png, sha256: createHash('sha256').update(png).digest('hex') };
      const stage = (image: typeof imageInput | null = imageInput) =>
        codexModelStage({
          name: 'image_read',
          logicalCallId: 'image_read',
          config,
          imageInput: image ?? undefined,
          buildPrompt: async () => 'SCENARIO:structured',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['answer', 'n'],
            properties: { answer: { type: 'string' }, n: { type: 'integer' } },
          },
          validate: (v) =>
            !!v && typeof v === 'object' && (v as { answer: string }).answer === 'OK',
          resultSchemaVersion: 'image-test-v1',
        });
      const first = await stage().run(ctx);
      assert.equal(first.kind, 'done');
      const stored = (await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [lease.jobId]))
        .rows[0].checkpoint.stages;
      assert.equal(stored.image_read_prompt.image_input.sha256, imageInput.sha256);
      const restarted = { ...ctx, checkpoint: stored };
      assert.equal(
        (await stage(null).run(restarted)).kind,
        'done',
        'replay reads the original private image without caller bytes',
      );
      const attempts = () =>
        pool.query('SELECT count(*)::int AS n FROM bb_model_call_attempts WHERE job_id=$1', [
          lease.jobId,
        ]);
      assert.equal((await attempts()).rows[0].n, 1);
      assert.deepEqual(await stage({ ...imageInput, sha256: '0'.repeat(64) }).run(restarted), {
        kind: 'fail',
        code: 'DATA_UNAVAILABLE',
      });
      const imageKey = [...data.keys()].find((k) => k.endsWith('.png'))!;
      assert.ok(imageKey.includes(owner));
      data.set(imageKey, Buffer.alloc(png.length));
      await assert.rejects(stage().run(restarted), /MODEL_IMAGE_INPUT_INVALID/);
      assert.equal((await attempts()).rows[0].n, 1);
      const observed = (
        await pool.query('SELECT usage_status FROM bb_model_call_attempts WHERE job_id=$1', [
          lease.jobId,
        ])
      ).rows[0];
      assert.equal(observed.usage_status, 'measured');
    } finally {
      await app.close();
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
