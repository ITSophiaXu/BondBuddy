import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { backupContainers, downloadFile, hashFile, hashStream } from './backup-stream.mjs';

test('default container scope includes app, log archive and library only once', () => {
  assert.deepEqual(backupContainers({ BB_LOG_ARCHIVE_CONTAINER: 'logs', BB_LIBRARY_CONTAINER: 'library' }), ['bondbuddy-private', 'logs', 'library']);
  assert.deepEqual(backupContainers({ BB_LOG_ARCHIVE_CONTAINER: 'bondbuddy-private' }), ['bondbuddy-private']);
  assert.deepEqual(backupContainers({ BB_BLOB_BACKUP_CONTAINERS: ' app-one, app-two,app-one,bb-backups ', BB_BACKUP_CONTAINER: 'bb-backups' }), ['app-one', 'app-two']);
  assert.throws(() => backupContainers({ BB_BLOB_BACKUP_CONTAINERS: 'bb-backups' }), /no application containers/);
  assert.throws(() => backupContainers({ BB_BLOB_BACKUP_CONTAINERS: 'app-one,,app-two' }), /invalid or empty/);
});

test('streaming hash counts chunks and writes identical bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-backup-hash-'));
  const file = join(dir, 'payload');
  const chunks = [Buffer.alloc(65537, 0x31), Buffer.from('end')];
  const expected = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
  try {
    assert.deepEqual(await downloadFile(Readable.from(chunks), file), { bytes: 65540, sha256: expected });
    assert.deepEqual(await hashFile(file), { bytes: 65540, sha256: expected });
    assert.deepEqual(readFileSync(file), Buffer.concat(chunks));
    assert.deepEqual(await hashStream(Readable.from(chunks)), { bytes: 65540, sha256: expected });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
