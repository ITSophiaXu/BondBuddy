import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { DocumentParseRecord, DocumentParseResponse } from './document-parser.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import { createIssuerIdentityObservationProducer, type IssuerIdentityObservationProducerDependencies } from './issuer-identity-observation-producer.js';
import type { IssuerIdentityObservationContext } from './material-parse-job.js';

const context: IssuerIdentityObservationContext = {
  ownerUserId: 'identity-owner-a', projectId: 'identity-project-a', materialId: 'identity-material-a',
  materialVersion: 2, snapshotId: 'identity-snapshot-a', materialSha256: 'a'.repeat(64), evidence: [],
};
const responseHash = 'b'.repeat(64);

function record(recordId: string, quote: string, overrides: Partial<DocumentParseRecord> = {}): DocumentParseRecord {
  return {
    record_id: recordId, material_id: context.materialId, material_version: context.materialVersion,
    content_hash: context.materialSha256, locator_type: 'docx_block', locator: { path: [{ paragraph: Number(recordId.slice(-1)) || 1 }] },
    literal_quote: quote, context: '', extraction_method: 'native_text', extractor_version: 'test-parser-1',
    confidence: null, uncertainty: [], formatting: {}, ...overrides,
  };
}

function snapshot(records: DocumentParseRecord[], overrides: Partial<StoredParseSnapshot> = {}): StoredParseSnapshot {
  const response: DocumentParseResponse = {
    schema_version: 'document-parse-response-v1', request_id: 'parse-request-a', parser_version: 'test-parser-1',
    status: 'parsed', material: { material_id: context.materialId, material_version: context.materialVersion,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: context.materialSha256 },
    records, warnings: [], document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 } }, error: null,
  };
  return {
    snapshotId: context.snapshotId, ownerUserId: context.ownerUserId, projectId: context.projectId, materialId: context.materialId,
    materialVersion: context.materialVersion, contentSha256: context.materialSha256, parserVersion: 'test-parser-1',
    requestId: 'parse-request-a', requestHash: 'c'.repeat(64), requestOptions: {}, responseSha256: responseHash,
    response, evidence: records, evidenceComplete: true, evidenceRecordCount: records.length,
    createdAt: '2026-09-26T00:00:00.000Z', replayed: false, ...overrides,
  };
}

function recordHash(value: DocumentParseRecord): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (typeof input === 'object' && input !== null) {
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(input);
  };
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function inputContext(records: DocumentParseRecord[], overrides: Partial<IssuerIdentityObservationContext> = {}): IssuerIdentityObservationContext {
  return { ...context, evidence: records.map(item => ({ recordId: item.record_id, recordSha256: recordHash(item), locatorType: item.locator_type })), ...overrides };
}

type ResolverInput = Parameters<IssuerIdentityObservationProducerDependencies['resolveEntityId']>[0];

function producer(source: StoredParseSnapshot, resolved: string | null | ((input: ResolverInput) => Promise<string | null>) = 'entity-registry-1') {
  const loadCalls: unknown[] = [];
  const resolverCalls: unknown[] = [];
  const run = createIssuerIdentityObservationProducer({
    pool: { connect: async () => { throw new Error('unexpected production DB access in synthetic test'); } },
    loadSnapshot: async (_dependencies, scope, snapshotId) => {
      loadCalls.push({ scope, snapshotId });
      return source;
    },
    resolveEntityId: async input => {
      resolverCalls.push(input);
      return typeof resolved === 'function' ? resolved(input) : resolved;
    },
  });
  return { run, loadCalls, resolverCalls };
}

test('loads exact full snapshot and preserves every anchor for the same issuer name', async () => {
  const records = [record('evidence-1', '发行人名称：合成债券有限公司。'), record('evidence-2', '发行人全称为“合成债券有限公司”。')];
  const { run, loadCalls, resolverCalls } = producer(snapshot(records));
  const result = await run(inputContext(records));
  assert.deepEqual(loadCalls, [{ scope: { ownerUserId: context.ownerUserId, projectId: context.projectId,
    materialId: context.materialId, materialVersion: context.materialVersion }, snapshotId: context.snapshotId }]);
  assert.deepEqual(result.map(item => item.sourceRecordId), ['evidence-1', 'evidence-2']);
  assert.ok(result.every(item => item.issuerDisplayName === '合成债券有限公司' && item.entityId === 'entity-registry-1'));
  assert.equal(resolverCalls.length, 1, 'resolve one registered identity per normalized candidate, then preserve its anchors');
  const resolution = resolverCalls[0] as Record<string, unknown>;
  assert.equal(resolution.snapshotId, context.snapshotId);
  assert.equal(resolution.responseSha256, responseHash);
  assert.equal(resolution.parserVersion, 'test-parser-1');
  assert.equal(resolution.selectionStatus, 'needs_review');
  assert.equal(resolution.coverage, 'complete');
  assert.deepEqual(resolution.warningCodes, []);
  assert.deepEqual((resolution.evidence as Array<Record<string, unknown>>).map(anchor => [anchor.sourceRecordId, anchor.sourceQuote]), [
    ['evidence-1', '发行人名称：合成债券有限公司。'], ['evidence-2', '发行人全称为“合成债券有限公司”。'],
  ]);
});

test('different names from distinct anchors remain separate review observations', async () => {
  const records = [record('evidence-1', '发行人：合成甲有限公司。'), record('evidence-2', '发行人：合成乙有限公司。')];
  const { run } = producer(snapshot(records));
  const result = await run(inputContext(records));
  assert.deepEqual(result.map(item => [item.sourceRecordId, item.issuerDisplayName]), [
    ['evidence-2', '合成乙有限公司'], ['evidence-1', '合成甲有限公司'],
  ]);
});

test('one unresolved member of a conflict suppresses all otherwise resolved observations', async () => {
  const records = [record('evidence-1', '发行人：合成甲有限公司。'), record('evidence-2', '发行人：合成乙有限公司。')];
  let calls = 0;
  const { run, resolverCalls } = producer(snapshot(records), async () => ++calls === 1 ? 'entity-registry-1' : null);
  assert.deepEqual(await run(inputContext(records)), []);
  assert.equal(resolverCalls.length, 2, 'both conflicting candidate names must be resolved before any output is returned');
});

test('one anchor naming conflicting entities suppresses the whole selection', async () => {
  const records = [record('evidence-1', '发行人：合成甲有限公司；发行人：合成乙有限公司。'),
    record('evidence-2', '发行人名称：合成甲有限公司。')];
  const { run, resolverCalls } = producer(snapshot(records));
  const result = await run(inputContext(records));
  assert.deepEqual(result, []);
  assert.deepEqual(resolverCalls, [], 'do not create a partial review set that would hide the second name');
});

test('omitting a certain conflicting anchor from trusted context fails closed', async () => {
  const records = [record('evidence-1', '发行人名称：合成甲有限公司。'), record('evidence-2', '发行人名称：合成乙有限公司。')];
  const { run, resolverCalls } = producer(snapshot(records));
  await assert.rejects(run(inputContext(records, { evidence: inputContext([records[0]!]).evidence })), /EVIDENCE_SET_MISMATCH/);
  assert.deepEqual(resolverCalls, []);
});

test('foreign owner, wrong snapshot, and material hash mismatch fail closed', async () => {
  const records = [record('evidence-1', '发行人：合成有限公司。')];
  const loaded = snapshot(records);
  await assert.rejects(producer(loaded).run(inputContext(records, { ownerUserId: 'identity-owner-b' })), /SNAPSHOT_SCOPE_MISMATCH/);
  await assert.rejects(producer(loaded).run(inputContext(records, { snapshotId: 'identity-snapshot-b' })), /SNAPSHOT_SCOPE_MISMATCH/);
  await assert.rejects(producer(loaded).run(inputContext(records, { materialSha256: 'd'.repeat(64) })), /MATERIAL_HASH_MISMATCH/);
});

test('evidence hash and locator type must match the provided trusted context', async () => {
  const item = record('evidence-1', '发行人：合成有限公司。');
  const loaded = snapshot([item]);
  await assert.rejects(producer(loaded).run(inputContext([item], { evidence: [{ recordId: item.record_id,
    recordSha256: 'd'.repeat(64), locatorType: item.locator_type }] })), /EVIDENCE_MISMATCH/);
  await assert.rejects(producer(loaded).run(inputContext([item], { evidence: [{ recordId: item.record_id,
    recordSha256: recordHash(item), locatorType: 'pdf_page' }] })), /EVIDENCE_MISMATCH/);
});

test('known incomplete parser coverage remains review-only and all direct anchors are retained', async () => {
  const records = [record('evidence-1', '发行人名称：合成有限公司。')];
  const parsed = snapshot(records);
  const incomplete = { ...parsed, response: { ...parsed.response, status: 'needs_confirmation' as const,
    warnings: [{ code: 'DOCX_DRAWINGS', message: 'synthetic omitted drawing content' }] } };
  const { run, resolverCalls } = producer(incomplete);
  const result = await run(inputContext(records));
  assert.deepEqual(result.map(item => item.sourceRecordId), ['evidence-1']);
  assert.ok(result.every(item => item.entityId === 'entity-registry-1'));
  const resolution = resolverCalls[0] as Record<string, unknown>;
  assert.equal(resolution.coverage, 'incomplete');
  assert.deepEqual(resolution.warningCodes, ['DOCX_DRAWINGS']);
});

test('blocked parser warning returns no observation and does not call entity resolver', async () => {
  const records = [record('evidence-1', '发行人名称：合成有限公司。')];
  const parsed = snapshot(records);
  const warned = { ...parsed, response: { ...parsed.response, status: 'needs_confirmation' as const,
    warnings: [{ code: 'OUTPUT_TRUNCATED', message: 'synthetic output is incomplete' }] } };
  const { run, resolverCalls } = producer(warned);
  assert.deepEqual(await run(inputContext(records)), []);
  assert.deepEqual(resolverCalls, []);
});

test('unresolved entity registry lookup skips candidates without manufacturing an ID', async () => {
  const records = [record('evidence-1', '发行人名称：合成有限公司。')];
  const { run, resolverCalls } = producer(snapshot(records), null);
  assert.deepEqual(await run(inputContext(records)), []);
  assert.equal(resolverCalls.length, 1);
});

test('entity resolver is a required factory dependency', () => {
  assert.throws(() => createIssuerIdentityObservationProducer({ pool: { connect: async () => { throw new Error('unused'); } } } as never),
    /ENTITY_RESOLVER_REQUIRED/);
});
