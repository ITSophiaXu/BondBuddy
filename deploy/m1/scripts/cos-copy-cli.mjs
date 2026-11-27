// Copy current Azure Blob objects into an exclusive COS migration bucket.
// Usage: node cos-copy-cli.mjs SOURCE_CONTAINER MANIFEST.jsonl [--keys-file FILE] [--expected-file FILE] [--allow-replace]
import { readFile } from 'node:fs/promises';
import { azureCurrentSource, cosMigrationTarget } from './cos-copy-adapters.mjs';
import { runCosCopy } from './cos-copy-runner.mjs';

const [container, manifestPath, ...flags] = process.argv.slice(2);
if (!container || !manifestPath || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container))
  throw new Error('usage: cos-copy-cli.mjs SOURCE_CONTAINER MANIFEST.jsonl [--keys-file FILE] [--expected-file FILE] [--allow-replace]');

let keysFile, expectedFile, allowReplace = false;
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === '--allow-replace') allowReplace = true;
  else if (flags[i] === '--keys-file' && flags[++i]) keysFile = flags[i];
  else if (flags[i] === '--expected-file' && flags[++i]) expectedFile = flags[i];
  else throw new Error('Invalid COS migration option');
}
if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('Azure source connection required');
const isBackup = container === (process.env.BB_BACKUP_CONTAINER || 'bb-backups');
const applicationContainer = process.env.BB_STORAGE_CONTAINER || 'bondbuddy-private';
if (!isBackup && container !== applicationContainer)
  throw new Error('Source container has no explicit COS bucket mapping');
const bucket = isBackup ? process.env.BB_COS_BACKUP_BUCKET : process.env.BB_COS_BUCKET;
const region = isBackup ? process.env.BB_COS_BACKUP_REGION || process.env.BB_COS_REGION : process.env.BB_COS_REGION;
const secretId = isBackup ? process.env.BB_COS_BACKUP_SECRET_ID || process.env.BB_COS_SECRET_ID : process.env.BB_COS_SECRET_ID;
const secretKey = isBackup ? process.env.BB_COS_BACKUP_SECRET_KEY || process.env.BB_COS_SECRET_KEY : process.env.BB_COS_SECRET_KEY;
if (isBackup && bucket === process.env.BB_COS_BUCKET) throw new Error('COS backup migration requires a separate target bucket');
if (isBackup && Boolean(process.env.BB_COS_BACKUP_SECRET_ID) !== Boolean(process.env.BB_COS_BACKUP_SECRET_KEY))
  throw new Error('COS backup credential pair is incomplete');
const source = azureCurrentSource(process.env.AZURE_STORAGE_CONNECTION_STRING, container);
const target = cosMigrationTarget({ secretId, secretKey, bucket, region });
const selected = keysFile ? new Set((await readFile(keysFile, 'utf8')).split(/\r?\n/).filter(Boolean)) : null;
const expected = new Map();
if (expectedFile) for (const line of (await readFile(expectedFile, 'utf8')).split('\n').filter(Boolean)) {
  const row = JSON.parse(line);
  if (typeof row.key !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid expected hash file');
  expected.set(row.key, row.sha256);
}
const result = await runCosCopy({ source, target, container, manifestPath, selected, expected, allowReplace,
  spoolRoot: process.env.BB_COS_MIGRATION_SPOOL_DIR });
process.stdout.write(`${JSON.stringify(result)}\n`);
