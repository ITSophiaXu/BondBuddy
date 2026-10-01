import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function backupContainers(env = process.env) {
  const names = !env.BB_BLOB_BACKUP_CONTAINERS
    ? ['bondbuddy-private', env.BB_LOG_ARCHIVE_CONTAINER, env.BB_LIBRARY_CONTAINER]
    : env.BB_BLOB_BACKUP_CONTAINERS.split(',');
  const backups = env.BB_BACKUP_CONTAINER || 'bb-backups';
  const selected = [...new Set(names.filter(name => name !== undefined).map(name => name.trim()))];
  if (selected.some(name => !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(name))) {
    throw new Error('invalid or empty BB_BLOB_BACKUP_CONTAINERS entry');
  }
  const result = selected.filter(name => name !== backups);
  if (!result.length) throw new Error('no application containers selected for backup');
  return result;
}

export async function hashStream(readable, writable) {
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    }
  });
  if (writable) await pipeline(readable, meter, writable);
  else await pipeline(readable, meter, new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
  return { bytes, sha256: hash.digest('hex') };
}

export const hashFile = file => hashStream(createReadStream(file));
export const downloadFile = (readable, file) => hashStream(readable, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
