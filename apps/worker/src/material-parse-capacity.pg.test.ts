import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, digest } from '@bondbuddy/api/data';
import { renewMaterialParse, type MaterialParseLease } from '@bondbuddy/api/material-jobs';
import { isolatedTestDatabase } from './test-database.js';
import { createParseStaging } from './parse-staging.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
const database = await isolatedTestDatabase(undefined, 'parse-capacity-wait'),
  storage = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test(
  'real parser waits beyond max_attempts for staging, then another worker finishes identical material',
  { skip: !database || !storage || !process.env.BONDBUDDY_TEST_PYTHON, timeout: 60000 },
  async () => {
    const pool = new Pool({ connectionString: database }),
      owner = randomUUID(),
      container = 'bb-capacity-' + randomUUID().replaceAll('-', ''),
      blobs = azureBlobs(storage!, container);
    const root = await mkdtemp(join(tmpdir(), 'bb-capacity-')),
      held: Awaited<ReturnType<typeof createParseStaging>>[] = [],
      origin = 'http://bondbuddy.test';
    const app = createServer({
      pool,
      blobs,
      allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }),
    });
    const ok = async (method: string, url: string, payload?: any) => {
      const r = await app.inject({
        method: method as any,
        url,
        payload,
        headers: {
          origin,
          ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
        },
      });
      assert.ok(r.statusCode < 300, r.body);
      return r.body ? r.json() : null;
    };
    let prior: MaterialParseLease | undefined;
    const deps = (p: Pool) => ({
      pool: p,
      leaseSeconds: 30,
      material: {
        pool: p,
        blobs: { getPrivate: (key: string) => blobs.getIfExists(key) },
        tempRoot: root,
      },
      onLease: (l: MaterialParseLease | null) => {
        if (l) prior = l;
      },
    });
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [
        owner,
        'cw_' + owner.slice(0, 8),
      ]);
      const p = await ok('POST', '/api/v1/projects', {
          kind: 'update',
          name: 'Synthetic capacity wait',
          issuer_name: null,
          market: null,
          offering: null,
        }),
        base = '/api/v1/projects/' + p.project_id;
      const bytes = makeWorkerDocxFixture({ externalLink: false }),
        decl = { byte_size: bytes.length, sha256: digest(bytes) };
      const u = await ok('POST', base + '/materials/uploads', {
        ...decl,
        filename: 'capacity.docx',
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        role: 'other',
      });
      await ok('PUT', u.upload_url, bytes);
      const m = await ok('POST', base + '/materials/uploads/' + u.upload_id + '/complete', decl);
      const job = async () =>
        (await pool.query('SELECT * FROM bb_jobs WHERE material_id=$1', [m.material_id])).rows[0];
      held.push(await createParseStaging(root), await createParseStaging(root));
      for (let n = 0; n < 4; n++) {
        assert.equal(await runMaterialParseOnce(deps(pool)), 'waiting_capacity');
        const j = await job();
        assert.equal(j.state, 'queued');
        assert.equal(j.attempts, 0);
        assert.equal(j.error_code, null);
        assert.equal(j.lease_token, null);
        assert.equal(j.lease_until, null);
        assert.ok(Date.parse(j.checkpoint.capacity_wait.retry_at) > Date.now());
        assert.equal(await runMaterialParseOnce(deps(pool)), 'idle');
        await assert.rejects(renewMaterialParse(pool, prior!));
        await delay(2050);
      }
      const j = await job();
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM bb_observability_errors WHERE job_id=$1', [
            j.id,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='platform.processing_cost'",
            [j.id],
          )
        ).rows[0].n,
        0,
      );
      for (const s of held) await s.cleanup();
      held.length = 0;
      const restarted = new Pool({ connectionString: database });
      try {
        assert.equal(await runMaterialParseOnce(deps(restarted)), 'succeeded');
      } finally {
        await restarted.end();
      }
      const done = await job();
      assert.equal(done.attempts, 1);
      assert.equal(done.material_sha256.trim(), decl.sha256);
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM bb_parse_snapshots WHERE material_id=$1', [
            m.material_id,
          ])
        ).rows[0].n,
        1,
      );
    } finally {
      for (const s of held) await s.cleanup();
      await app.close();
      await pool.end();
      await BlobServiceClient.fromConnectionString(storage!)
        .getContainerClient(container)
        .deleteIfExists();
      await rm(root, { recursive: true, force: true });
    }
  },
);
