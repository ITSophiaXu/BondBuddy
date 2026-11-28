import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { downloadFile, hashFile, hashStream } from './backup-stream.mjs';

const safe = name => {
  if (typeof name !== 'string' || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name) ||
      name.split('/').some(part => part === '..' || part === '.' || part === ''))
    throw new Error(`unsafe blob name ${name}`);
  return name;
};

export async function exportApplicationSnapshot(root, names, storeFor) {
  const manifest = [];
  for (const name of names) {
    const store = storeFor(name);
    if (!(await store.exists())) throw new Error(`configured backup container does not exist: ${name}`);
    for await (const item of store.list()) {
      const file = join(root, safe(name), safe(item.key));
      mkdirSync(dirname(file), { recursive: true });
      try {
        const digest = await downloadFile(await store.readStream(item.key, item.etag), file);
        manifest.push({ container: name, name: item.key, ...digest, content_type: item.contentType });
      } catch (error) {
        try { unlinkSync(file); } catch { /* no partial file */ }
        throw error;
      }
    }
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { exported: manifest.length, containers: names.length };
}

export async function importApplicationSnapshot(root, backupContainer, storeFor) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest)) throw new Error('Invalid object snapshot manifest');
  let imported = 0;
  const seen = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.content_type !== null && typeof entry.content_type !== 'string')
      throw new Error('Invalid object snapshot manifest entry');
    if (entry.container === backupContainer) continue;
    const container = safe(entry.container), name = safe(entry.name);
    const identity = `${container}\0${name}`;
    if (seen.has(identity)) throw new Error('Duplicate object snapshot manifest entry');
    seen.add(identity);
    const file = join(root, container, name);
    const digest = await hashFile(file);
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256)
      throw new Error(`hash mismatch for ${entry.container}/${entry.name}`);
    const store = storeFor(entry.container);
    await store.ready();
    await store.putFile(entry.name, file, entry.content_type);
    const restored = await hashStream(await store.readStream(entry.name));
    if (restored.bytes !== digest.bytes || restored.sha256 !== digest.sha256)
      throw new Error(`restore readback mismatch for ${entry.container}/${entry.name}`);
    imported++;
  }
  return { imported };
}
