import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Material } from '@bondbuddy/contracts';
import { TARGET_DOCUMENT_STAGE, materialParseSnapshotId, referencePin, referenceSnapshotResolver, sameMaterialVersion, selectedReference, userReferenceChoice } from './reference.js';

const reference: Material = { material_id: 'synthetic-reference', material_version: 2, upload_id: 'synthetic-upload',
  role: 'reference', filename: 'reference.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  byte_size: 2048, sha256: 'b'.repeat(64), state: 'persisted', persisted_at: '2026-09-29T00:00:00Z', error: null };
const historical: Material = { ...reference, material_id: 'synthetic-historical', role: 'historical' };

test('a similar-issuer reference is only selected for a no-history generation project', () => {
  assert.equal(selectedReference([reference], false)?.material_id, 'synthetic-reference');
  assert.equal(selectedReference([historical, reference], false)?.material_id, 'synthetic-reference');
  assert.equal(selectedReference([reference], true), undefined);
  assert.equal(selectedReference([reference], null), undefined);
  assert.equal(selectedReference([historical], false), undefined);
});

test('user reference pins structure only: exact material identity, hash, snapshot and target', () => {
  const choice = userReferenceChoice(reference, 'synthetic-snapshot', 'private');
  assert.deepEqual(choice, { material_id: 'synthetic-reference', material_version: 2, material_sha256: 'b'.repeat(64),
    parse_snapshot_id: 'synthetic-snapshot', target_product: 'private', target_document_stage: TARGET_DOCUMENT_STAGE });
  assert.equal(choice.target_document_stage, 'issuance');
});

test('only a well-formed additive parse snapshot id is accepted; anything else stays unpinned', () => {
  assert.equal(materialParseSnapshotId({ ...reference, parse_snapshot_id: 'synthetic-snapshot' } as Material), 'synthetic-snapshot');
  assert.equal(materialParseSnapshotId(reference), undefined);
  assert.equal(materialParseSnapshotId({ ...reference, parse_snapshot_id: '' } as Material), undefined);
  assert.equal(materialParseSnapshotId({ ...reference, parse_snapshot_id: 'x'.repeat(129) } as Material), undefined);
  assert.equal(materialParseSnapshotId({ ...reference, parse_snapshot_id: 7 } as unknown as Material), undefined);
});

test('the reference resolver re-reads the owner-scoped material instead of trusting a stale list entry', async () => {
  const reads: Array<[string, string]> = [];
  const fresh: Material = { ...reference, material_version: 3, sha256: 'c'.repeat(64), parse_snapshot_id: 'fresh-snapshot' };
  const resolve = referenceSnapshotResolver(async (projectId, materialId) => {
    reads.push([projectId, materialId]);
    return fresh;
  });
  // The recovered list entry may predate a completed parse or a new version; the read is returned as-is.
  assert.deepEqual(await resolve('synthetic-project', reference), fresh);
  assert.deepEqual(reads, [['synthetic-project', 'synthetic-reference']]);
});

test('a failed owner-scoped read rejects so the caller keeps the run unpinned', async () => {
  const resolve = referenceSnapshotResolver(async () => { throw new Error('synthetic read failure'); });
  await assert.rejects(() => resolve('synthetic-project', reference));
});

test('a re-read only counts when id, version and hash are unchanged', () => {
  assert.equal(sameMaterialVersion(reference, { ...reference }), true);
  assert.equal(sameMaterialVersion(reference, { ...reference, material_version: 3 }), false);
  assert.equal(sameMaterialVersion(reference, { ...reference, sha256: 'c'.repeat(64) }), false);
  assert.equal(sameMaterialVersion(reference, { ...reference, material_id: 'synthetic-other' }), false);
});

test('list v1 -> GET v2 is a safe stop: no mixed pin is submitted', () => {
  const v2: Material = { ...reference, material_version: 3, sha256: 'c'.repeat(64), parse_snapshot_id: 'snapshot-v2' };
  assert.deepEqual(referencePin(reference, v2, 'private'),
    { note: '用户指定参考稿在提交前已更新为新的版本，请刷新已保存材料并重新选择参考稿后再开始更新。' });
});

test('the same version can be pinned, and a still-unparsed version stays unpinned', () => {
  const fresh: Material = { ...reference, parse_snapshot_id: 'fresh-snapshot' };
  assert.deepEqual(referencePin(reference, fresh, 'private'),
    { choice: userReferenceChoice(fresh, 'fresh-snapshot', 'private') });
  assert.deepEqual(referencePin(reference, reference, 'private'),
    { note: '用户指定参考稿的解析快照尚未就绪，请刷新已保存材料并重新选择参考稿后再开始更新。' });
});
