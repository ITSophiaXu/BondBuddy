import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlobServiceClient } from '@azure/storage-blob';
import { backupContainer, backupTime, pruneOffhostBackups } from './backup-retention.js';

// #35 off-host backups against Azurite. Synthetic bytes only; each run uses its own container names.
const connection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '../../../deploy/m1/scripts');
const run = promisify(execFile);
const suffix = randomBytes(4).toString('hex');
const containerName = `bb-backups-t${suffix}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const env = () => ({ ...process.env, AZURE_STORAGE_CONNECTION_STRING: connection!, BB_BACKUP_CONTAINER: containerName });
const script = (name: string, ...args: string[]) => run(process.execPath, [join(scripts, name), ...args], { env: env() });
const service = () => BlobServiceClient.fromConnectionString(connection!);
const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (connection) for (const name of [containerName, `bbsnap${suffix}`]) await service().getContainerClient(name).deleteIfExists();
});

async function syntheticBackup() {
  const dir = await mkdtemp(join(tmpdir(), 'bb-backup-')); dirs.push(dir);
  await mkdir(join(dir, 'blobs', 'materials', 'u1'), { recursive: true });
  const dump = randomBytes(4096);
  await writeFile(join(dir, 'db.dump'), dump);
  await writeFile(join(dir, 'blobs', 'materials', 'u1', 'a.docx'), 'synthetic material');
  await writeFile(join(dir, 'blobs', 'manifest.json'), '[]');
  await writeFile(join(dir, 'manifest.txt'), `release=synthetic\ndb_sha256=${sha(dump)}\n`);
  return { dir, dump };
}

test('backup ids carry their UTC time; other names are ignored', () => {
  assert.equal(backupTime('20260925T010203Z-pre-deploy-abc')?.toISOString(), '2026-09-25T01:02:03.000Z');
  assert.equal(backupTime('restore-20260925T010203Z-x'), null);
  assert.equal(backupTime('20261399T000000Z-x'), null);
});

test('upload verifies, writes the completion manifest last, and download restores identical bytes', { skip: !connection }, async () => {
  const { dir, dump } = await syntheticBackup();
  const id = '20260925T010203Z-synthetic';
  const up = JSON.parse((await script('backup-offhost.mjs', 'upload', dir, id)).stdout);
  assert.deepEqual(up, { uploaded: 4, verified: 4, backup_id: id });
  const container = service().getContainerClient(containerName);
  assert.equal((await container.getProperties()).blobPublicAccess, undefined, 'container is private');
  const manifest = JSON.parse((await container.getBlobClient(`${id}/offhost-manifest.json`).downloadToBuffer()).toString());
  assert.equal(manifest.files.find((f: { name: string }) => f.name === 'db.dump').sha256, sha(dump));
  await assert.rejects(script('backup-offhost.mjs', 'upload', dir, id), /already exists/);

  const out = await mkdtemp(join(tmpdir(), 'bb-restore-')); dirs.push(out);
  const down = JSON.parse((await script('backup-offhost.mjs', 'download', id, out)).stdout);
  assert.equal(down.verified, 4);
  assert.deepEqual(await readFile(join(out, 'db.dump')), dump);
  assert.equal(await readFile(join(out, 'blobs', 'materials', 'u1', 'a.docx'), 'utf8'), 'synthetic material');
  assert.equal(await readFile(join(out, 'manifest.txt'), 'utf8'), await readFile(join(dir, 'manifest.txt'), 'utf8'));

  // A corrupted off-host copy is refused before anything is restored.
  await container.getBlockBlobClient(`${id}/db.dump`).uploadData(Buffer.from('tampered'));
  const bad = await mkdtemp(join(tmpdir(), 'bb-restore-')); dirs.push(bad);
  await assert.rejects(script('backup-offhost.mjs', 'download', id, bad), /hash mismatch for db\.dump/);
  // A backup without its completion manifest (interrupted upload) is refused too.
  await container.getBlockBlobClient('20260925T020000Z-partial/db.dump').uploadData(dump);
  await assert.rejects(script('backup-offhost.mjs', 'download', '20260925T020000Z-partial', bad), /not found or incomplete/);
  await assert.rejects(script('backup-offhost.mjs', 'download', '../etc', bad), /invalid backup id/);
});

test('blob-snapshot never exports the off-host backup container', { skip: !connection }, async () => {
  const snap = service().getContainerClient(`bbsnap${suffix}`);
  await snap.createIfNotExists();
  await snap.getBlockBlobClient('x.txt').uploadData(Buffer.from('synthetic'));
  await service().getContainerClient(containerName).createIfNotExists();
  await service().getContainerClient(containerName).getBlockBlobClient('20260925T030000Z-x/db.dump').uploadData(Buffer.from('dump'));
  const out = await mkdtemp(join(tmpdir(), 'bb-snap-')); dirs.push(out);
  await run(process.execPath, [join(scripts, 'blob-snapshot.mjs'), 'export', out], {
    env: { ...env(), BB_BLOB_BACKUP_CONTAINERS: `${snap.containerName},${containerName}` }
  });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { container: string }[];
  assert.ok(manifest.some(e => e.container === `bbsnap${suffix}`));
  assert.ok(!manifest.some(e => e.container === containerName));
});

test('retention deletes backups past the window, keeps the newest, and is idempotent', { skip: !connection }, async () => {
  const name = `bb-retention-t${suffix}`;
  const container = backupContainer(connection!, name);
  try {
    assert.deepEqual(await pruneOffhostBackups(container, 30), { backups: 0, deleted: 0, deletedBlobs: 0, kept: 0, failed: 0 }, 'missing container is a no-op');
    await container.create();
    const put = (n: string) => container.getBlockBlobClient(n).uploadData(Buffer.from('synthetic'));
    for (const id of ['20260701T000000Z-old', '20260801T000000Z-old2', '20260920T000000Z-recent'])
      for (const f of ['db.dump', 'blobs/manifest.json', 'offhost-manifest.json']) await put(`${id}/${f}`);
    await put('README-not-a-backup.txt');
    const now = new Date('2026-09-25T00:00:00Z');
    const r = await pruneOffhostBackups(container, 30, now);
    assert.deepEqual(r, { backups: 3, deleted: 2, deletedBlobs: 6, kept: 1, failed: 0 });
    const left: string[] = [];
    for await (const b of container.listBlobsFlat()) left.push(b.name);
    assert.deepEqual(left.sort(), ['20260920T000000Z-recent/blobs/manifest.json', '20260920T000000Z-recent/db.dump', '20260920T000000Z-recent/offhost-manifest.json', 'README-not-a-backup.txt']);
    assert.deepEqual(await pruneOffhostBackups(container, 30, now), { backups: 1, deleted: 0, deletedBlobs: 0, kept: 1, failed: 0 }, 'second run changes nothing');
    // Even when every backup is past the window, the newest one stays.
    assert.equal((await pruneOffhostBackups(container, 1, new Date('2027-01-01T00:00:00Z'))).kept, 1);
  } finally { await container.deleteIfExists(); }
});
