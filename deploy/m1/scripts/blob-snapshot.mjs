// Usage (inside the api image): node deploy/m1/scripts/blob-snapshot.mjs export|import <dir>
// Export the configured application containers; never export the off-host backup container.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';
import { backupContainers, downloadFile, hashFile } from './backup-stream.mjs';

const [mode, root] = process.argv.slice(2);
if (!['export', 'import'].includes(mode) || !root) throw new Error('usage: blob-snapshot.mjs export|import <dir>');
if (process.env.BB_STORAGE_PROVIDER && process.env.BB_STORAGE_PROVIDER !== 'azure') throw new Error('Only Azure object snapshot is implemented');
if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING required');
const service = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const BACKUPS = process.env.BB_BACKUP_CONTAINER || 'bb-backups';
const safe = name => { if (name.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error(`unsafe blob name ${name}`); return name; };

if (mode === 'export') {
  const manifest = [];
  const names = backupContainers();
  for (const name of names) {
    const container = service.getContainerClient(name);
    if (!(await container.exists())) throw new Error(`configured backup container does not exist: ${name}`);
    for await (const blob of container.listBlobsFlat()) {
      const file = join(root, name, safe(blob.name));
      mkdirSync(dirname(file), { recursive: true });
      try {
        const response = await container.getBlobClient(blob.name).download();
        if (!response.readableStreamBody) throw new Error(`no download stream for ${name}/${blob.name}`);
        const digest = await downloadFile(response.readableStreamBody, file);
        manifest.push({ container: name, name: blob.name, ...digest, content_type: blob.properties.contentType ?? null });
      } catch (error) {
        try { unlinkSync(file); } catch { /* no partial file */ }
        throw error;
      }
    }
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ exported: manifest.length, containers: names.length }));
} else {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  let imported = 0;
  for (const entry of manifest) {
    if (entry.container === BACKUPS) continue;
    const file = join(root, safe(entry.container), safe(entry.name));
    const digest = await hashFile(file);
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256) throw new Error(`hash mismatch for ${entry.container}/${entry.name}`);
    const container = service.getContainerClient(entry.container);
    await container.createIfNotExists();
    await container.getBlockBlobClient(entry.name).uploadFile(file, {
      blockSize: 4 * 1024 * 1024, concurrency: 1,
      blobHTTPHeaders: entry.content_type ? { blobContentType: entry.content_type } : undefined
    });
    imported++;
  }
  console.log(JSON.stringify({ imported }));
}
