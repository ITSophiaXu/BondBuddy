import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { createContext } from 'node:vm';
import test from 'node:test';

// Execute the complete, unmodified helper source with a synthetic SDK. All blobs
// and credentials exist only in this VM; no production SDK or network is loaded.
const root = resolve(process.env.DIAGNOSTICS_ROOT ?? import.meta.dirname);
const source = readFileSync(resolve(root, 'read-content.mjs'), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const secret = 'synthetic-provider-secret-12345';
const operations = Buffer.from(JSON.stringify({ version: 'word-edit-operations-v1', operations: [{ text: `中文 ${secret}` }] }));
const childHash = sha(operations);
const childKey = `owners/owner/projects/project/runs/run/file-authoring/attempt/${childHash}/operations.json`;

function fixture(change = {}) {
  const descriptor = { key: childKey, sha256: childHash, byte_size: operations.length, ...change.descriptor };
  const result = { version: 'codex-file-word-v1', input_hash: 'a'.repeat(64), files: { 'operations.json': descriptor }, ...change.result };
  const parent = Buffer.from(JSON.stringify(result));
  const parentHash = sha(parent);
  const parentKey = `users/owner/projects/project/provider-results/attempt-${parentHash}.json`;
  const row = { kind: 'result', owner_user_id: 'owner', project_id: 'project', run_id: 'run', attempt_id: 'attempt', object_key: parentKey, sha256: parentHash, byte_size: parent.length, file: 'operations.json', ...change.row };
  const blobs = new Map([
    [parentKey, { bytes: parent, etag: 'parent-etag' }],
    [childKey, { bytes: operations, etag: 'child-etag' }],
  ]);
  return { row, blobs, parent, parentHash, parentKey, descriptor };
}

async function execute(row, blobs) {
  const calls = [];
  let stdout = '', stderr = '';
  const fakeProcess = { argv: ['node', '-', JSON.stringify(row)], env: { AZURE_STORAGE_CONNECTION_STRING: 'synthetic-isolated-storage', API_KEY: secret }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, exitCode: 0 };
  class BlobServiceClient {
    static fromConnectionString(connection) {
      assert.equal(connection, 'synthetic-isolated-storage');
      return new BlobServiceClient();
    }
    getContainerClient(name) {
      assert.equal(name, 'bondbuddy-private');
      return { getBlockBlobClient: key => ({
        getProperties: async () => {
          calls.push({ operation: 'properties', key });
          const value = blobs.get(key);
          if (!value || value.propertiesError) throw Error('synthetic storage unavailable');
          return { contentLength: value.length ?? value.bytes.length, etag: value.etag };
        },
        download: async (offset, length, options) => {
          calls.push({ operation: 'download', key, offset, length, ifMatch: options.conditions.ifMatch });
          const value = blobs.get(key);
          if (!value || value.downloadError || options.conditions.ifMatch !== value.etag) throw Error('synthetic etag mismatch');
          const bytes = value.downloadBytes ?? value.bytes;
          return { readableStreamBody: (async function* () { yield bytes.subarray(0, 7); yield bytes.subarray(7); })() };
        },
      }) };
    }
  }
  const context = createContext({ Buffer, process: fakeProcess, setTimeout, clearTimeout, AbortController, TextDecoder });
  const module = new SourceTextModule(source, { context });
  await module.link(async specifier => {
    if (specifier === 'node:module') {
      return new SyntheticModule(['createRequire'], function () { this.setExport('createRequire', () => name => {
        assert.equal(name, '@azure/storage-blob'); return { BlobServiceClient };
      }); }, { context });
    }
    if (specifier === 'node:crypto') return new SyntheticModule(['createHash'], function () { this.setExport('createHash', createHash); }, { context });
    throw Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return { stdout, stderr, exitCode: fakeProcess.exitCode, calls };
}

async function rejected(value) {
  const observed = await execute(value.row, value.blobs);
  assert.equal(observed.exitCode, 2);
  assert.equal(observed.stdout, '', 'failure must never leak partial content');
  assert.equal(observed.stderr, 'CONTENT_UNAVAILABLE_OR_INTEGRITY_FAILED\n');
  assert(!observed.stderr.includes(secret));
  return observed;
}

test('registered result selection returns only operations and both verified hashes', async () => {
  const value = fixture();
  const observed = await execute(value.row, value.blobs);
  assert.equal(observed.exitCode, 0);
  const envelope = JSON.parse(observed.stdout);
  assert.equal(envelope.verified_parent_sha256, value.parentHash);
  assert.equal(envelope.verified_child_sha256, childHash);
  assert.equal(envelope.verified_child_byte_size, operations.length);
  assert.equal(Buffer.from(envelope.redacted_content_base64, 'base64').toString(), operations.toString().replace(secret, '[redacted]'));
  assert(!observed.stdout.includes('input_hash'));
  assert.deepEqual(observed.calls.map(x => [x.operation, x.key]), [['properties', value.parentKey], ['download', value.parentKey], ['properties', childKey], ['download', childKey]]);
  assert.equal(observed.calls[1].ifMatch, 'parent-etag');
  assert.equal(observed.calls[3].ifMatch, 'child-etag');
});

test('legacy result read preserves plaintext response without child fetch', async () => {
  const value = fixture(); delete value.row.file;
  const observed = await execute(value.row, value.blobs);
  assert.equal(observed.exitCode, 0);
  assert.equal(observed.stdout, value.parent.toString());
  assert.equal(observed.calls.length, 2);
});

for (const kind of ['prompt', 'exec']) {
  test(`selection is rejected for ${kind} before any storage access`, async () => {
    const value = fixture({ row: { kind } });
    const observed = await rejected(value); assert.equal(observed.calls.length, 0);
  });
}

for (const selected of ['input.json', 'template-manifest.json', '../operations.json', '', null]) {
  test(`reject unsupported selector ${JSON.stringify(selected)}`, async () => {
    const observed = await rejected(fixture({ row: { file: selected } })); assert.equal(observed.calls.length, 0);
  });
}

for (const field of ['owner_user_id', 'project_id', 'run_id', 'attempt_id']) {
  test(`child key is bound to registered ${field}`, async () => {
    const value = fixture({ row: { [field]: 'other' } });
    const observed = await rejected(value);
    assert(!observed.calls.some(x => x.key === childKey));
  });
}

for (const key of [childKey.replace('/attempt/', '/other/'), childKey.replace('/run/', '/other/'), childKey.replace('/operations.json', '/input.json'), childKey.replace('/operations.json', '/../operations.json')]) {
  test(`reject child key outside exact fixed binding: ${key.slice(-100)}`, async () => {
    const observed = await rejected(fixture({ descriptor: { key } }));
    assert.equal(observed.calls.length, 2);
  });
}

for (const change of [{ sha256: '0'.repeat(64) }, { sha256: childHash.toUpperCase() }, { byte_size: 0 }, { byte_size: -1 }, { byte_size: 1.5 }, { byte_size: 1024 * 1024 + 1 }, { byte_size: '83' }]) {
  test(`reject invalid child descriptor ${JSON.stringify(change)}`, async () => {
    const observed = await rejected(fixture({ descriptor: change }));
    assert.equal(observed.calls.length, 2);
  });
}

test('parent integrity failure never fetches child', async () => {
  const value = fixture(); value.blobs.get(value.parentKey).downloadBytes = Buffer.from('corrupt');
  const observed = await rejected(value); assert.equal(observed.calls.length, 2);
});

test('parent expected size mismatch fails before download', async () => {
  const value = fixture({ row: { byte_size: 1 } });
  const observed = await rejected(value); assert.equal(observed.calls.length, 1);
});

test('selected parent must have a registered size', async () => {
  const observed = await rejected(fixture({ row: { byte_size: null } }));
  assert(!observed.calls.some(x => x.key === childKey));
});

for (const where of ['parent', 'child']) {
  test(`${where} missing ETag fails closed`, async () => {
    const value = fixture(); value.blobs.get(where === 'parent' ? value.parentKey : childKey).etag = undefined;
    await rejected(value);
  });
  test(`${where} ETag race fails closed`, async () => {
    const value = fixture(); value.blobs.get(where === 'parent' ? value.parentKey : childKey).downloadError = true;
    await rejected(value);
  });
}

test('parent missing file descriptor fails before child fetch', async () => {
  const observed = await rejected(fixture({ result: { files: {} } })); assert.equal(observed.calls.length, 2);
});

test('parent wrong result version fails before child fetch', async () => {
  const observed = await rejected(fixture({ result: { version: 'unknown' } })); assert.equal(observed.calls.length, 2);
});

test('missing child reports no plaintext', async () => {
  const value = fixture(); value.blobs.delete(childKey); await rejected(value);
});

test('child property size mismatch fails before its download', async () => {
  const value = fixture(); value.blobs.get(childKey).length = operations.length + 1;
  const observed = await rejected(value); assert.equal(observed.calls.length, 3);
});

test('child streaming size and hash mismatch fail closed', async () => {
  const value = fixture(); value.blobs.get(childKey).downloadBytes = Buffer.from('x'.repeat(operations.length));
  await rejected(value);
});

for (const bytes of [Buffer.from('not-json'), Buffer.from([0xff, 0xfe])]) {
  test(`child must be valid UTF-8 JSON (${bytes.toString('hex')})`, async () => {
    const hash = sha(bytes), key = `owners/owner/projects/project/runs/run/file-authoring/attempt/${hash}/operations.json`;
    const value = fixture({ descriptor: { key, sha256: hash, byte_size: bytes.length } });
    value.blobs.set(key, { bytes, etag: 'invalid-json-etag' }); await rejected(value);
  });
}

test('a valid JSON file at exactly one MiB is readable', async () => {
  const bytes = Buffer.from('"' + 'x'.repeat(1024 * 1024 - 2) + '"');
  const hash = sha(bytes), key = `owners/owner/projects/project/runs/run/file-authoring/attempt/${hash}/operations.json`;
  const value = fixture({ descriptor: { key, sha256: hash, byte_size: bytes.length } });
  value.blobs.set(key, { bytes, etag: 'max-etag' });
  const observed = await execute(value.row, value.blobs); assert.equal(observed.exitCode, 0);
  assert.equal(Buffer.from(JSON.parse(observed.stdout).redacted_content_base64, 'base64').length, 1024 * 1024);
});
