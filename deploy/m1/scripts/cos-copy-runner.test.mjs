import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runCosCopy } from './cos-copy-runner.mjs';

test('migration receipt resumes, detects source changes and requires explicit replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-cos-copy-'));
  const manifestPath = join(dir, 'receipt.jsonl');
  const objects = new Map();
  let sourceReads = 0;
  let data = Buffer.from('one'), etag = 'v1';
  const source = {
    async *list() { yield { key: 'users/a/proof', bytes: data.length, etag, contentType: 'text/plain' }; },
    async open() { sourceReads++; return Readable.from([data]); },
  };
  const target = {
    bucket: 'app-123', async ready() {},
    async head(key) { return objects.has(key) ? {} : null; },
    async open(key) { return Readable.from([objects.get(key)]); },
    async put(key, body) {
      const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
  };
  const options = { source, target, container: 'bondbuddy-private', manifestPath };
  try {
    assert.equal((await runCosCopy(options)).copied, 1);
    assert.equal((await runCosCopy(options)).verified_existing, 1);
    assert.equal(sourceReads, 1);
    data = Buffer.from('two'); etag = 'v2';
    await assert.rejects(runCosCopy(options), /explicit incremental replacement/);
    assert.equal((await runCosCopy({ ...options, allowReplace: true })).replaced, 1);
    assert.equal(objects.get('users/a/proof').toString(), 'two');
    const rows = (await readFile(manifestPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].sourceEtag, 'v2');
    await assert.rejects(runCosCopy({ ...options, container: 'wrong-container' }), /manifest does not match/);
    const missingSource = { ...source, async *list() {} };
    await assert.rejects(runCosCopy({ ...options, source: missingSource }), /reconcile deletion tombstones/);
    const duplicateSource = { ...source, async *list() {
      yield { key: 'users/a/proof', bytes: data.length, etag, contentType: 'text/plain' };
      yield { key: 'users/a/proof', bytes: data.length, etag, contentType: 'text/plain' };
    } };
    await assert.rejects(runCosCopy({ ...options, source: duplicateSource }), /duplicate object key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
