import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Material } from '@bondbuddy/contracts';
import { TARGET_DOCUMENT_STAGE, materialParseSnapshotId, selectedReference, userReferenceChoice } from './reference.js';

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
