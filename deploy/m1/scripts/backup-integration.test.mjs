// Run explicitly: node deploy/m1/scripts/backup-integration.test.mjs
// Requires Docker and the root npm dependencies. Uses disposable Azurite and synthetic bytes only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { hashFile, hashStream } from './backup-stream.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = mkdtempSync(join(tmpdir(), 'bb-blob-backup-test-'));
const image = 'mcr.microsoft.com/azure-storage/azurite:3.35.0';
const containerName = `bb-blob-backup-test-${process.pid}`;
const connection = 'UseDevelopmentStorage=true';
const service = BlobServiceClient.fromConnectionString(connection);
const app = ['bondbuddy-private', 'bb-test-logs'];
const unrelated = 'bb-test-unrelated';
const backups = 'bb-test-backups';
const id = '20260927T000000Z-stream-test';
const big = join(root, 'big.bin');
const exportDir = join(root, 'export');
const offhostDir = join(root, 'offhost');
const downloadDir = join(root, 'download');

const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const runLimited = (script, args, vars = {}) => {
  const env = Object.entries(vars).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const command = `node --max-old-space-size=128 deploy/m1/scripts/${script} ${args.map(x => `'${x}'`).join(' ')} & pid=$!; peak=0; while kill -0 "$pid" 2>/dev/null; do rss=$(awk '/^VmRSS:/ {print $2 * 1024}' /proc/"$pid"/status 2>/dev/null || true); if [ -n "$rss" ] && [ "$rss" -gt "$peak" ]; then peak=$rss; fi; sleep 0.05; done; wait "$pid"; result=$?; printf 'peak_rss_bytes=%s cgroup_memory_peak_bytes=' "$peak"; cat /sys/fs/cgroup/memory.peak; exit "$result"`;
  const output = docker(['run', '--rm', '--network', 'host', '--memory', '512m', '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${repo}:/app:ro`, '-v', `${root}:/backup`, '-w', '/app',
    '-e', `AZURE_STORAGE_CONNECTION_STRING=${connection}`, '-e', `BB_BACKUP_CONTAINER=${backups}`, ...env,
    'node:22-bookworm-slim', 'sh', '-c', command]);
  console.log(`${script} ${args.join(' ')}: ${output}`);
};

try {
  docker(['run', '--rm', '-d', '--name', containerName, '-p', '127.0.0.1:10000:10000', image,
    'azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--disableProductStyleUrl']);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await service.getContainerClient(app[0]).exists(); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(ready, 'Azurite did not become ready');
  for (const name of [...app, unrelated, backups]) await service.getContainerClient(name).create();
  assert.throws(
    () => runLimited('blob-snapshot.mjs', ['export', '/backup/missing'], { BB_BLOB_BACKUP_CONTAINERS: 'bb-test-missing' }),
    error => error.stderr?.includes('configured backup container does not exist: bb-test-missing')
  );
  assert.throws(() => readFileSync(join(root, 'missing', 'manifest.json')), /ENOENT/);
  const fd = openSync(big, 'w', 0o600);
  ftruncateSync(fd, 320 * 1024 * 1024);
  closeSync(fd);
  const bigHash = createHash('sha256').update(Buffer.alloc(1024 * 1024));
  // A sparse 320 MiB file is all zero bytes; hash in bounded chunks.
  for (let i = 1; i < 320; i++) bigHash.update(Buffer.alloc(1024 * 1024));
  const expected = bigHash.digest('hex');
  await service.getContainerClient(app[0]).getBlockBlobClient('large/blob.bin').uploadFile(big, { blockSize: 4 * 1024 * 1024, concurrency: 1 });
  await service.getContainerClient(app[1]).getBlockBlobClient('logs/one.txt').uploadData(Buffer.from('application log'));
  await service.getContainerClient(unrelated).getBlockBlobClient('keep.txt').uploadData(Buffer.from('unrelated'));
  await service.getContainerClient(backups).getBlockBlobClient('keep.txt').uploadData(Buffer.from('backup container'));
  runLimited('blob-snapshot.mjs', ['export', '/backup/export'], { BB_BLOB_BACKUP_CONTAINERS: `${app[0]},${app[1]},${backups}` });
  const manifest = JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 2);
  assert.deepEqual(Object.keys(manifest[0]).sort(), ['bytes', 'container', 'content_type', 'name', 'sha256']);
  assert.deepEqual(manifest.map(item => item.container).sort(), [...app].sort());
  assert.equal(manifest.find(item => item.name === 'large/blob.bin').sha256, expected);
  assert.equal(manifest.find(item => item.name === 'large/blob.bin').bytes, 320 * 1024 * 1024);
  assert.throws(() => readFileSync(join(exportDir, unrelated, 'keep.txt')), /ENOENT/);
  await service.getContainerClient(app[0]).getBlobClient('large/blob.bin').delete();
  await service.getContainerClient(app[1]).getBlobClient('logs/one.txt').delete();
  runLimited('blob-snapshot.mjs', ['import', '/backup/export']);
  const restored = service.getContainerClient(app[0]).getBlobClient('large/blob.bin');
  assert.deepEqual(await hashStream((await restored.download()).readableStreamBody), { bytes: 320 * 1024 * 1024, sha256: expected });
  assert.equal((await service.getContainerClient(unrelated).getBlobClient('keep.txt').downloadToBuffer()).toString(), 'unrelated');
  mkdirSync(offhostDir);
  writeFileSync(join(offhostDir, 'db.dump'), Buffer.from('synthetic database dump'));
  mkdirSync(join(offhostDir, 'blobs'));
  linkSync(big, join(offhostDir, 'blobs', 'large.bin'));
  runLimited('backup-offhost.mjs', ['upload', '/backup/offhost', id]);
  runLimited('backup-offhost.mjs', ['download', id, '/backup/download']);
  assert.equal(readFileSync(join(downloadDir, 'db.dump')).toString(), 'synthetic database dump');
  assert.deepEqual(await hashStream((await service.getContainerClient(backups).getBlobClient(`${id}/blobs/large.bin`).download()).readableStreamBody), { bytes: 320 * 1024 * 1024, sha256: expected });
  assert.deepEqual(await hashFile(join(downloadDir, 'blobs', 'large.bin')), { bytes: 320 * 1024 * 1024, sha256: expected });
  console.log('PASS: 2 application containers, 1 unrelated container, 320 MiB blob, snapshot and off-host round trips');
} finally {
  try { docker(['stop', containerName]); } catch { /* already gone */ }
  rmSync(root, { recursive: true, force: true });
}
