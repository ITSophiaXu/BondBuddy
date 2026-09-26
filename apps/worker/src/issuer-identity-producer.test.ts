import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import type { IssuerIdentityObservationContext } from './material-parse-job.js';
import { createIssuerIdentityProducer, issuerNameKey } from './issuer-identity-producer.js';

const context: IssuerIdentityObservationContext = {
  ownerUserId: 'owner-a', projectId: 'project-a', materialId: 'material-a', materialVersion: 1,
  snapshotId: 'snapshot-a', materialSha256: 'a'.repeat(64), evidence: [
    { recordId: 'record-a', recordSha256: 'b'.repeat(64), locatorType: 'docx_block' },
    { recordId: 'record-b', recordSha256: 'c'.repeat(64), locatorType: 'docx_block' },
  ],
};
function snapshot(quotes: string[], warnings: string[] = []): StoredParseSnapshot {
  const evidence = quotes.map((literal_quote, i) => ({
    record_id: i ? 'record-b' : 'record-a', material_id: context.materialId, material_version: 1,
    content_hash: context.materialSha256, locator_type: 'docx_block' as const,
    locator: { paragraph: i + 1 }, literal_quote, context: '', extraction_method: 'native_text' as const,
    extractor_version: 'test', confidence: null, uncertainty: [], formatting: {},
  }));
  return {
    ownerUserId: context.ownerUserId, projectId: context.projectId, materialId: context.materialId,
    materialVersion: 1, snapshotId: context.snapshotId, contentSha256: context.materialSha256,
    parserVersion: 'test', requestId: 'parse-a', requestHash: 'd'.repeat(64), requestOptions: {},
    responseSha256: 'e'.repeat(64), evidence, evidenceComplete: true, evidenceRecordCount: evidence.length,
    response: { schema_version: 'document-parse-response-v1', request_id: 'parse-a', parser_version: 'test',
      status: 'parsed', material: { material_id: context.materialId, material_version: 1,
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: context.materialSha256 },
      records: evidence, warnings: warnings.map(code => ({ code, message: 'synthetic warning' })),
      document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 } }, error: null },
    createdAt: '2026-09-26T00:00:00Z', replayed: false,
  };
}
const producer = (source: StoredParseSnapshot, warnings: string[] = []) => createIssuerIdentityProducer({} as Pool, {
  loadSnapshot: async () => source, warn: code => warnings.push(code),
});

test('no candidate writes nothing, including failed coverage', async () => {
  assert.deepEqual(await producer(snapshot(['公司简介']))(context), []);
  const warnings: string[] = [];
  assert.deepEqual(await producer(snapshot(['发行人：合成甲有限公司。'], ['OUTPUT_TRUNCATED']), warnings)(context), []);
  assert.ok(warnings.some(code => code.startsWith('ISSUER_IDENTITY_COVERAGE_INCOMPLETE')));
});

test('needs_review and conflict retain each candidate with stable replay and name keys', async () => {
  const single = await producer(snapshot(['发行人：合成甲有限公司。']))(context);
  assert.equal(single.length, 1);
  assert.equal(single[0]?.entityId, issuerNameKey(' 合成甲有限公司 '));
  assert.equal(issuerNameKey('Ａ 　Ｂ'), issuerNameKey('A B'));
  const conflicting = producer(snapshot(['发行人：合成甲有限公司。', '发行人：合成乙有限公司。']));
  const first = await conflicting(context);
  assert.equal(first.length, 2);
  assert.deepEqual(await conflicting(context), first);
  assert.equal(new Set(first.map(item => item.observationId)).size, 2);
  assert.ok(first.every(item => item.observationId?.startsWith('issuer-observation:v1:')));
});

test('two anchors for one name yield separately reviewable stable observations', async () => {
  const produce = producer(snapshot(['发行人：合成甲有限公司。', '发行人名称：合成甲有限公司。']));
  const first = await produce(context);
  assert.deepEqual(first.map(item => item.sourceRecordId), ['record-a', 'record-b']);
  assert.equal(new Set(first.map(item => item.requestId)).size, 2);
  assert.deepEqual(await produce(context), first, 'parse replay keeps both observation and request IDs');
});

test('two names on one anchor have different replay keys', async () => {
  const selected = await producer(snapshot(['发行人：合成甲有限公司。 发行人名称：合成乙有限公司。']))(context);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(item => item.sourceRecordId), ['record-a', 'record-a']);
  assert.equal(new Set(selected.map(item => item.requestId)).size, 2);
  assert.equal(new Set(selected.map(item => item.observationId)).size, 2);
});

test('selector errors fail closed without rejecting parse work', async () => {
  const warnings: string[] = [];
  const invalid = { ...snapshot(['发行人：合成甲有限公司。']), ownerUserId: 'other-owner' };
  assert.deepEqual(await producer(invalid, warnings)(context), []);
  assert.ok(warnings.some(code => code.startsWith('ISSUER_IDENTITY_SELECTION_FAILED')));
});
