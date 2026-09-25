// Usage (inside the api image): node deploy/m1/scripts/backup-offhost.mjs upload <dir> <backup-id>
//                                node deploy/m1/scripts/backup-offhost.mjs download <backup-id> <dir>
// #35 off-host copy of a scripts/backup.sh directory into the private `bb-backups` container of the
// AZURE_STORAGE_CONNECTION_STRING account (production reaches it through the egress proxy via HTTPS_PROXY).
// upload: every file becomes `<backup-id>/<relative path>`; each blob is downloaded again and its sha256
// compared, and only then `<backup-id>/offhost-manifest.json` is written. That manifest marks the backup
// complete. download: refuses a backup without the manifest and verifies every file's sha256.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';

const CONTAINER = process.env.BB_BACKUP_CONTAINER || 'bb-backups';
const MANIFEST = 'offhost-manifest.json';
const idPattern = /^\d{8}T\d{6}Z-[A-Za-z0-9._-]{1,64}$/;
const [mode, a, b] = process.argv.slice(2);
if (!['upload', 'download'].includes(mode) || !a || !b) throw new Error('usage: backup-offhost.mjs upload <dir> <backup-id> | download <backup-id> <dir>');
if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING required');
const id = mode === 'upload' ? b : a, root = mode === 'upload' ? a : b;
if (!idPattern.test(id)) throw new Error(`invalid backup id ${id}`);
const container = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient(CONTAINER);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = name => { if (name.split('/').some(p => p === '..' || p === '' || p === '.')) throw new Error(`unsafe path ${name}`); return name; };
const walk = dir => readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]);

if (mode === 'upload') {
  // No `access` option: the container is private (no anonymous read).
  await container.createIfNotExists();
  if (await container.getBlobClient(`${id}/${MANIFEST}`).exists()) throw new Error(`backup ${id} already exists off-host`);
  const files = [];
  for (const file of walk(root)) {
    const name = safe(relative(root, file).split(sep).join('/'));
    if (name === MANIFEST) continue;
    const bytes = readFileSync(file), digest = sha(bytes);
    const blob = container.getBlockBlobClient(`${id}/${name}`);
    await blob.uploadData(bytes, { metadata: { sha256: digest } });
    const back = await blob.downloadToBuffer();
    if (back.length !== bytes.length || sha(back) !== digest) throw new Error(`verify failed for ${name}`);
    files.push({ name, bytes: bytes.length, sha256: digest });
  }
  if (!files.some(f => f.name === 'db.dump')) throw new Error('backup has no db.dump');
  const manifest = JSON.stringify({ backup_id: id, uploaded_at: new Date().toISOString(), files }, null, 1);
  await container.getBlockBlobClient(`${id}/${MANIFEST}`).uploadData(Buffer.from(manifest), { blobHTTPHeaders: { blobContentType: 'application/json' } });
  console.log(JSON.stringify({ uploaded: files.length, verified: files.length, backup_id: id }));
} else {
  const manifestBlob = container.getBlobClient(`${id}/${MANIFEST}`);
  if (!(await manifestBlob.exists())) throw new Error(`backup ${id} not found or incomplete off-host`);
  const manifest = JSON.parse((await manifestBlob.downloadToBuffer()).toString('utf8'));
  if (manifest.backup_id !== id) throw new Error('manifest does not match backup id');
  for (const f of manifest.files) {
    const bytes = await container.getBlobClient(`${id}/${safe(f.name)}`).downloadToBuffer();
    if (bytes.length !== f.bytes || sha(bytes) !== f.sha256) throw new Error(`hash mismatch for ${f.name}`);
    const file = join(root, f.name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
  }
  console.log(JSON.stringify({ downloaded: manifest.files.length, verified: manifest.files.length, backup_id: id }));
}
