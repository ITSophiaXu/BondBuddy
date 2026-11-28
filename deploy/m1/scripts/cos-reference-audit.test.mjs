import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { auditCosReferences } from './cos-reference-audit.mjs';

test('deduplicates explicit references and reports only hashed missing keys', async () => {
  const rows = [
    { kind: 'upload', key: 'users/synthetic/a' },
    { kind: 'material', key: 'users/synthetic/a' },
    { kind: 'artifact', key: 'users/synthetic/b' },
  ];
  const seen = [];
  const result = await auditCosReferences(rows, async key => {
    seen.push(key);
    if (key.endsWith('/b')) throw { code: 'NoSuchKey', statusCode: 404 };
    return true;
  }, 2);
  assert.deepEqual(seen.sort(), ['users/synthetic/a', 'users/synthetic/b']);
  assert.deepEqual(result, {
    referenceRows: 3, uniqueKeys: 2, present: 1, missing: 1,
    missingKeySha256: [createHash('sha256').update('users/synthetic/b').digest('hex')],
    coverage: 'explicit_database_references_only',
  });
});

test('fails closed on bucket errors, unknown results and invalid rows', async () => {
  await assert.rejects(auditCosReferences([{ kind: 'upload', key: 'x' }], async () => {
    throw { code: 'NoSuchBucket', statusCode: 404 };
  }), error => error.code === 'NoSuchBucket');
  await assert.rejects(auditCosReferences([{ kind: 'upload', key: 'x' }], async () => undefined), /Invalid COS HEAD result/);
  await assert.rejects(auditCosReferences([{ kind: 'upload', key: '' }], async () => true), /Invalid database object reference/);
  await assert.rejects(auditCosReferences([], async () => true, 0), /Invalid COS audit concurrency/);
});
