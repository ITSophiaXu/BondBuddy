// Usage (inside the api image): node deploy/m1/scripts/blob-snapshot.mjs export|import <dir>
// Exports every blob of every container in AZURE_STORAGE_CONNECTION_STRING to <dir>/<container>/<name>
// with a manifest (sha256, content type); import re-uploads and verifies the hashes.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';

const [mode, root] = process.argv.slice(2);
if (!['export', 'import'].includes(mode) || !root) throw new Error('usage: blob-snapshot.mjs export|import <dir>');
if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING required');
const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = name => { if (name.split('/').some(p => p === '..' || p === '')) throw new Error(`unsafe blob name ${name}`); return name; };

if (mode === 'export') {
  const manifest = [];
  for await (const c of service.listContainers()) {
    const container = service.getContainerClient(c.name);
    for await (const b of container.listBlobsFlat()) {
      const bytes = await container.getBlobClient(b.name).downloadToBuffer();
      const file = join(root, c.name, safe(b.name));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { mode: 0o600 });
      manifest.push({ container: c.name, name: b.name, bytes: bytes.length, sha256: sha(bytes), content_type: b.properties.contentType ?? null });
    }
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ exported: manifest.length }));
} else {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  for (const entry of manifest) {
    const bytes = readFileSync(join(root, entry.container, safe(entry.name)));
    if (sha(bytes) !== entry.sha256) throw new Error(`hash mismatch for ${entry.container}/${entry.name}`);
    const container = service.getContainerClient(entry.container);
    await container.createIfNotExists();
    await container.getBlockBlobClient(entry.name).uploadData(bytes, { blobHTTPHeaders: entry.content_type ? { blobContentType: entry.content_type } : undefined });
  }
  console.log(JSON.stringify({ imported: manifest.length }));
}
