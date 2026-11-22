import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, digest } from '@bondbuddy/api/data';
import { reservedSpoolBytes } from '@bondbuddy/api/upload-spool';
import { isolatedTestDatabase } from './test-database.js';
import { UploadConfirmationRuntime } from './upload-confirmation-runtime.js';

const connection = await isolatedTestDatabase(undefined, 'four-confirmation-duplicate');
const storage = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test(
  'four concurrent equal originals converge to one material without losing owner/fence/replay integrity',
  { skip: !connection || !storage, timeout: 40000 },
  async () => {
    const pool = new Pool({ connectionString: connection, max: 12 }),
      owner = 'four-' + randomUUID(),
      container = 'bb-four-' + randomUUID().replaceAll('-', '');
    const blobs = azureBlobs(storage!, container),
      origin = 'http://bondbuddy.test';
    const app = createServer({
      pool,
      blobs,
      allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }),
    });
    const send = (method: string, url: string, payload?: any) =>
      app.inject({
        method: method as any,
        url,
        payload,
        headers: {
          origin,
          ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
          ...(url.endsWith('/complete') ? { prefer: 'respond-async' } : {}),
        },
      });
    const root = await mkdtemp(join(tmpdir(), 'bb-four-confirm-'));
    const oldRoot = process.env.BB_UPLOAD_SPOOL_DIR,
      oldBudget = process.env.BB_UPLOAD_SPOOL_MAX_BYTES;
    process.env.BB_UPLOAD_SPOOL_DIR = root;
    process.env.BB_UPLOAD_SPOOL_MAX_BYTES = String(448 * 1024 * 1024);
    let runtime: UploadConfirmationRuntime | undefined, releaseGate: (() => void) | undefined;
    try {
      const project = await send('POST', '/api/v1/projects', {
        name: 'Synthetic equal originals',
        kind: 'update',
        issuer_name: null,
        market: null,
        offering: null,
      });
      assert.equal(project.statusCode, 201);
      const projectId = project.json().project_id,
        bytes = Buffer.alloc(17 * 1024 * 1024, 120),
        declaration = { byte_size: bytes.length, sha256: digest(bytes) },
        uploads: string[] = [];
      for (let i = 0; i < 4; i++) {
        const made = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
          filename: `synthetic-${i}.pdf`,
          role: 'other',
          media_type: 'application/pdf',
          ...declaration,
        });
        assert.equal(made.statusCode, 201, made.body);
        const u = made.json();
        assert.equal((await send('PUT', u.upload_url, bytes)).statusCode, 204);
        uploads.push(u.upload_id);
        assert.equal(
          (
            await send(
              'POST',
              `/api/v1/projects/${projectId}/materials/uploads/${u.upload_id}/complete`,
              declaration,
            )
          ).statusCode,
          202,
        );
      }
      // Hold the four real disk-read completions until all four leases are active.
      const original = blobs.readToFile!.bind(blobs);
      let release!: () => void,
        entered = 0;
      const gate = new Promise<void>((r) => {
        release = r;
        releaseGate = r;
      });
      blobs.readToFile = async (...args) => {
        const proof = await original(...args);
        if (args[1]) {
          entered++;
          if (entered === 4) release();
          await gate;
        }
        return proof;
      };
      // All four originals exceed 16 MiB, so the reserved small loop cannot
      // borrow them: this is a genuine four-general transaction race.
      runtime = new UploadConfirmationRuntime({
        pool,
        blobs,
        smallSlot: true,
        concurrency: 4,
        pollMs: 100,
      }).start();
      const deadline = Date.now() + 25000;
      while (
        (
          await pool.query(
            "SELECT count(*)::int n FROM bb_upload_confirmations WHERE upload_id=ANY($1::text[]) AND state='completed'",
            [uploads],
          )
        ).rows[0].n !== 4
      ) {
        assert.ok(Date.now() < deadline, 'four canonical races must converge');
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(entered >= 4, true);
      await runtime.stop();
      runtime = undefined;
      const materialIds = [];
      for (const id of uploads) {
        const path = `/api/v1/projects/${projectId}/materials/uploads/${id}/complete`;
        const saved = await send('POST', path, declaration);
        assert.equal(saved.statusCode, 200, saved.body);
        assert.equal(saved.json().sha256, declaration.sha256);
        assert.deepEqual((await send('POST', path, declaration)).json(), saved.json());
        materialIds.push(saved.json().material_id);
      }
      assert.equal(new Set(materialIds).size, 1);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',
            [owner],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM bb_upload_reuse_receipts WHERE owner_user_id=$1',
            [owner],
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=ANY($1::text[]) AND lease_token IS NOT NULL',
            [uploads],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(reservedSpoolBytes(), 0);
      assert.deepEqual(await readdir(root), []);
    } finally {
      releaseGate?.();
      await runtime?.stop();
      await app.close();
      await pool.end();
      await BlobServiceClient.fromConnectionString(storage!)
        .getContainerClient(container)
        .deleteIfExists();
      await rm(root, { recursive: true, force: true });
      oldRoot === undefined
        ? delete process.env.BB_UPLOAD_SPOOL_DIR
        : (process.env.BB_UPLOAD_SPOOL_DIR = oldRoot);
      oldBudget === undefined
        ? delete process.env.BB_UPLOAD_SPOOL_MAX_BYTES
        : (process.env.BB_UPLOAD_SPOOL_MAX_BYTES = oldBudget);
    }
  },
);
