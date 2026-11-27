// Usage (inside the api image): node deploy/m1/scripts/backup-offhost.mjs upload <dir> <backup-id>
//                                node deploy/m1/scripts/backup-offhost.mjs download <backup-id> <dir>
// The manifest marks a fully verified off-host backup complete.
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { downloadFile, hashFile, hashStream } from './backup-stream.mjs';
import { offhostStore } from './offhost-store.mjs';

const MANIFEST = 'offhost-manifest.json';
const idPattern = /^\d{8}T\d{6}Z-[A-Za-z0-9._-]{1,64}$/;
const [mode, a, b] = process.argv.slice(2);
if (!['upload', 'download'].includes(mode) || !a || !b) throw new Error('usage: backup-offhost.mjs upload <dir> <backup-id> | download <backup-id> <dir>');
const id = mode === 'upload' ? b : a, root = mode === 'upload' ? a : b;
if (!idPattern.test(id)) throw new Error(`invalid backup id ${id}`);
const store = offhostStore();
const safe = name => { if (name.split('/').some(p => p === '..' || p === '' || p === '.')) throw new Error(`unsafe path ${name}`); return name; };
const walk = dir => readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]);

if (mode === 'upload') {
  await store.ready();
  if (await store.exists(`${id}/${MANIFEST}`)) throw new Error(`backup ${id} already exists off-host`);
  const files = [];
  for (const file of walk(root)) {
    const name = safe(relative(root, file).split(sep).join('/'));
    if (name === MANIFEST) continue;
    const digest = await hashFile(file);
    await store.uploadFile(`${id}/${name}`, file, digest.sha256);
    const back = await hashStream(await store.readStream(`${id}/${name}`));
    if (back.bytes !== digest.bytes || back.sha256 !== digest.sha256) throw new Error(`verify failed for ${name}`);
    files.push({ name, ...digest });
  }
  if (!files.some(f => f.name === 'db.dump')) throw new Error('backup has no db.dump');
  const manifest = JSON.stringify({ backup_id: id, uploaded_at: new Date().toISOString(), files }, null, 1);
  await store.uploadData(`${id}/${MANIFEST}`, Buffer.from(manifest));
  console.log(JSON.stringify({ uploaded: files.length, verified: files.length, backup_id: id }));
} else {
  await store.ready();
  if (!(await store.exists(`${id}/${MANIFEST}`))) throw new Error(`backup ${id} not found or incomplete off-host`);
  const manifest = JSON.parse((await store.readBuffer(`${id}/${MANIFEST}`)).toString('utf8'));
  if (manifest.backup_id !== id) throw new Error('manifest does not match backup id');
  for (const f of manifest.files) {
    const name = safe(f.name);
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      const digest = await downloadFile(await store.readStream(`${id}/${name}`), file);
      if (digest.bytes !== f.bytes || digest.sha256 !== f.sha256) throw new Error(`hash mismatch for ${name}`);
    } catch (error) {
      try { unlinkSync(file); } catch { /* no partial file */ }
      throw error;
    }
  }
  console.log(JSON.stringify({ downloaded: manifest.files.length, verified: manifest.files.length, backup_id: id }));
}
