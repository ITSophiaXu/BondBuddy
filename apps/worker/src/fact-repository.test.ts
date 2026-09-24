import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { FactCandidate, FactIdentity } from '@bondbuddy/domain/facts';
import {
  insertFactCandidate,
  listFactCandidates,
  type FactEvidenceAnchor,
  type FactRepositoryContext,
  type FactRepositoryPool,
} from './fact-repository.js';

const scope: FactRepositoryContext = { ownerUserId: 'owner-a', projectId: 'project-a' };
const identity: FactIdentity = {
  accountId: 'owner-a', entityId: 'issuer-1', scope: 'consolidated', metric: 'revenue',
  period: { start: '2024-01-01', end: '2024-12-31' }, currency: 'CNY', unit: 'yuan', basis: 'audited', dataVersion: 'v1',
};
const evidence: FactEvidenceAnchor[] = [{
  evidence_id: 'evidence-1', material_id: 'material-1', material_version: 2, content_hash: 'a'.repeat(64),
  locator_type: 'text_line', locator: { line: 12 }, literal_quote: '营业收入 123.00 元',
  extraction_method: 'native_text', extraction_version: 'parser-1', confidence: 0.99, uncertainty: [],
}];
const material = { id: 'material-1', version: 2 };

function candidate(overrides: Partial<FactCandidate> = {}): FactCandidate {
  return {
    candidateId: 'candidate-input', identity, value: { kind: 'known', decimalOrText: '123.00' },
    source: { kind: 'audited', sourceId: 'audit-report-1', observedAt: '2025-03-20T10:00:00.000Z', validAsOf: '2024-12-31' },
    confidence: 0.99,
    ...overrides,
  };
}

function returnedRow(values: unknown[], id = String(values[0])): Record<string, unknown> {
  const storedEvidence = JSON.parse(String(values[19])) as FactEvidenceAnchor[];
  return {
    id, owner_user_id: values[1], project_id: values[2], entity_id: values[3], fact_key_hash: values[4],
    fact_key: JSON.parse(String(values[5])), value_decimal: values[6], value_text: values[7], value_kind: values[8],
    source_kind: values[9], source_ref: values[10], status: values[11], source_observed_at: new Date(String(values[12])),
    source_valid_as_of: values[13] ? new Date(`${String(values[13])}T00:00:00.000Z`) : null,
    verification_actor_kind: values[14], verification_actor_id: values[15],
    verification_at: values[16] ? new Date(String(values[16])) : null,
    material_id: values[17], material_version: values[18], evidence: storedEvidence,
    uncertainty: JSON.parse(String(values[20])), created_at: new Date('2025-03-20T10:00:00.000Z'),
  };
}

class MockPool implements FactRepositoryPool {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  rows: Record<string, unknown>[] = [];
  persistedAnchorCount = 1;
  persistedAnchor: FactEvidenceAnchor = evidence[0]!;
  async query(sql: string, values: unknown[]) {
    this.calls.push({ sql, values });
    if (sql.includes('FROM bb_parse_evidence e')) {
      const actual = this.persistedAnchor;
      const anchorMatches = values[0] === scope.ownerUserId && values[1] === scope.projectId && values[2] === material.id &&
        values[3] === material.version && values[4] === actual.evidence_id && values[5] === actual.content_hash &&
        values[6] === actual.locator_type && values[7] === JSON.stringify(actual.locator) &&
        values[8] === actual.literal_quote && values[9] === actual.extraction_method &&
        values[10] === actual.extraction_version && values[11] === actual.confidence &&
        values[12] === JSON.stringify(actual.uncertainty);
      return { rows: [{ match_count: anchorMatches ? this.persistedAnchorCount : 0 }] };
    }
    if (sql.startsWith('INSERT')) return { rows: [returnedRow(values)] };
    return { rows: this.rows };
  }
}

function insertCall(pool: MockPool) {
  return pool.calls.find((call) => call.sql.startsWith('INSERT INTO bb_fact_candidates'))!;
}

function dependencies(pool = new MockPool()) {
  return { pool, newId: () => 'generated-id', now: () => new Date('2025-03-20T10:00:00.000Z') };
}

test('inserts scoped immutable candidate with bound values and round-trips decimal provenance', async () => {
  const pool = new MockPool();
  const inserted = await insertFactCandidate(dependencies(pool), scope, candidate(), material, evidence);

  assert.match(pool.calls[0]!.sql, /FROM bb_parse_evidence e/);
  assert.match(pool.calls[0]!.sql, /e\.locator = \$8::jsonb/);
  assert.match(pool.calls[0]!.sql, /e\.literal_quote = \$9/);
  assert.match(pool.calls[0]!.sql, /e\.extractor_version = \$11/);
  assert.match(pool.calls[0]!.sql, /s\.response_status IN \('parsed', 'needs_confirmation'\)/);
  assert.match(pool.calls[0]!.sql, /e\.extractor_version = s\.parser_version/);
  const insert = insertCall(pool);
  assert.match(insert.sql, /WHERE EXISTS\s*\(\s*SELECT 1 FROM bb_material_versions/);
  assert.match(insert.sql, /m\.owner_user_id = \$2 AND m\.project_id = \$3/);
  assert.doesNotMatch(insert.sql, /owner-a|project-a|material-1/);
  assert.equal(insert.values[1], 'owner-a');
  assert.equal(insert.values[2], 'project-a');
  assert.equal(insert.values[6], '123.00');
  assert.equal(insert.values[7], null);
  assert.equal(insert.values[8], 'decimal');
  assert.equal(inserted.candidate.value.kind, 'known');
  if (inserted.candidate.value.kind === 'known') assert.equal(inserted.candidate.value.decimalOrText, '123.00');
  assert.equal(inserted.candidate.candidateId, 'generated-id');
  assert.equal(inserted.provenance.materialVersion, 2);
  assert.equal(inserted.provenance.evidence[0]?.literal_quote, '营业收入 123.00 元');
});

test('unknown and not-applicable values remain distinct and text uses its own column', async () => {
  for (const [value, kind, decimal, text] of [
    [{ kind: 'unknown' }, 'unknown', null, null],
    [{ kind: 'not_applicable' }, 'not_applicable', null, null],
    [{ kind: 'known', decimalOrText: '未披露' }, 'text', null, '未披露'],
  ] as const) {
    const pool = new MockPool();
    await insertFactCandidate(dependencies(pool), scope, candidate({ value }), material, evidence);
    assert.equal(insertCall(pool).values[8], kind);
    assert.equal(insertCall(pool).values[6], decimal);
    assert.equal(insertCall(pool).values[7], text);
  }
});

test('a source-anchor review must point to original evidence and is persisted with the verifier', async () => {
  const pool = new MockPool();
  const verified = candidate({ auditCheck: {
    kind: 'source_anchor_review', evidenceId: 'evidence-1', verifierId: 'reviewer-7', verifierRole: 'internal_reviewer',
  } });
  const inserted = await insertFactCandidate(dependencies(pool), scope, verified, material, evidence);
  assert.equal(inserted.provenance.status, 'verified');
  assert.equal(inserted.candidate.auditCheck?.evidenceId, 'evidence-1');
  assert.equal(insertCall(pool).values[14], 'internal_reviewer');
  const savedEvidence = JSON.parse(String(insertCall(pool).values[19])) as FactEvidenceAnchor[];
  assert.equal(savedEvidence[0]?.source_anchor_review?.verifier_id, 'reviewer-7');
});

test('does not mark facts verified without review and fails closed for unsupported OCR anchors', async () => {
  const noReviewPool = new MockPool();
  await insertFactCandidate(dependencies(noReviewPool), scope, candidate(), material, evidence);
  assert.equal(insertCall(noReviewPool).values[11], 'extracted');

  const unreviewedOcr = [{ ...evidence[0]!, extraction_method: 'ocr' }];
  const ocrPool = new MockPool();
  await assert.rejects(insertFactCandidate(dependencies(ocrPool), scope, candidate(), material, unreviewedOcr),
    /FACT_SOURCE_EVIDENCE_NOT_FOUND/);
  assert.equal(ocrPool.calls.some((call) => call.sql.startsWith('INSERT INTO bb_fact_candidates')), false);

  const reviewedButUncertain = [{ ...evidence[0]!, uncertainty: ['ambiguous digit'] }];
  const heldPool = new MockPool();
  heldPool.persistedAnchor = reviewedButUncertain[0]!;
  await insertFactCandidate(dependencies(heldPool), scope, candidate({
    auditCheck: { kind: 'source_anchor_review', evidenceId: 'evidence-1', verifierId: 'reviewer', verifierRole: 'internal_reviewer' },
  }), material, reviewedButUncertain);
  assert.equal(insertCall(heldPool).values[11], 'needs_confirmation');
});

test('rejects cross-account identities, template/reference sources, and missing anchors before querying', async () => {
  for (const input of [
    candidate({ identity: { ...identity, accountId: 'owner-b' } }),
    candidate({ source: { ...candidate().source, kind: 'template' } }),
    candidate({ source: { ...candidate().source, kind: 'reference' } }),
  ]) {
    const pool = new MockPool();
    await assert.rejects(insertFactCandidate(dependencies(pool), scope, input, material, evidence));
    assert.equal(pool.calls.length, 0);
  }
  const pool = new MockPool();
  await assert.rejects(insertFactCandidate(dependencies(pool), scope, candidate(), material, []), /FACT_SOURCE_EVIDENCE_REQUIRED/);
  assert.equal(pool.calls.length, 0);
});

test('rejects forged, mismatched, or ambiguous persisted anchors before inserting a material-derived fact', async () => {
  for (const [label, alter, count] of [
    ['forged quote', { literal_quote: '营业收入 999.00 元' }, 1],
    ['forged locator', { locator: { line: 99 } }, 1],
    ['mismatched hash', { content_hash: 'b'.repeat(64) }, 1],
    ['mismatched extraction method', { extraction_method: 'ocr' }, 1],
    ['mismatched extraction version', { extraction_version: 'parser-2' }, 1],
    ['mismatched confidence', { confidence: 0.5 }, 1],
    ['mismatched uncertainty', { uncertainty: ['needs review'] }, 1],
    ['ambiguous record', {}, 2],
  ] as const) {
    const pool = new MockPool();
    pool.persistedAnchorCount = count;
    const supplied = [{ ...evidence[0]!, ...alter }];
    await assert.rejects(insertFactCandidate(dependencies(pool), scope, candidate(), material, supplied),
      label === 'ambiguous record' ? /FACT_SOURCE_EVIDENCE_AMBIGUOUS/ : /FACT_SOURCE_EVIDENCE_NOT_FOUND/);
    assert.equal(pool.calls.some((call) => call.sql.startsWith('INSERT INTO bb_fact_candidates')), false, label);
  }
});

test('user statements require a valid observed date and remain user asserted', async () => {
  const missingDate = candidate({ source: { kind: 'user_statement', sourceId: 'chat-message-1', observedAt: '' } });
  const emptyPool = new MockPool();
  await assert.rejects(insertFactCandidate(dependencies(emptyPool), scope, missingDate, material, evidence), /USER_STATEMENT_DATE_REQUIRED/);
  assert.equal(emptyPool.calls.length, 0);

  const pool = new MockPool();
  const valid = candidate({ source: { kind: 'user_statement', sourceId: 'chat-message-1', observedAt: '2025-09-23T01:02:03Z' } });
  const stored = await insertFactCandidate(dependencies(pool), scope, valid, material, evidence);
  assert.equal(pool.calls[0]!.values[11], 'user_asserted');
  assert.equal(stored.candidate.source.observedAt, '2025-09-23T01:02:03.000Z');
});

test('lists every candidate for exact owner/project/key and uses scoped parameter bindings', async () => {
  const pool = new MockPool();
  const first = await insertFactCandidate(dependencies(new MockPool()), scope, candidate(), material, evidence);
  await insertFactCandidate(dependencies(new MockPool()), scope, candidate({
    candidateId: 'other-source', value: { kind: 'known', decimalOrText: '124' },
    source: { kind: 'external', sourceId: 'announcement-1', observedAt: '2025-03-21T00:00:00Z' },
  }), material, evidence);
  // Supply well-formed rows directly; both disagreeing candidates must survive as separate records.
  const values = (sourceValue: string, id: string) => [id, scope.ownerUserId, scope.projectId, identity.entityId,
    '0'.repeat(64), JSON.stringify(identity), sourceValue, null, 'decimal', 'audited', 'audit-report', 'extracted',
    '2025-03-20T10:00:00.000Z', '2024-12-31', null, null, null, material.id, material.version,
    JSON.stringify(evidence), '[]'];
  pool.rows = [returnedRow(values('123', 'one')), returnedRow(values('124', 'two'))];

  const listed = await listFactCandidates(dependencies(pool), scope, identity);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((item) => item.candidate.candidateId), ['one', 'two']);
  assert.equal(listed[0]?.candidate.value.kind, 'known');
  assert.match(pool.calls[0]!.sql, /WHERE owner_user_id = \$1 AND project_id = \$2 AND fact_key_hash = \$3/);
  assert.deepEqual(pool.calls[0]!.values, ['owner-a', 'project-a', pool.calls[0]!.values[2]]);
  assert.equal(pool.calls[0]!.values[2]?.toString().length, 64);
});

test('list query is owner/project isolated and rejects unexpected rows from outside the scope', async () => {
  const pool = new MockPool();
  const values = ['bad', 'owner-b', 'project-a', identity.entityId, '0'.repeat(64), JSON.stringify(identity), null, null,
    'unknown', 'audited', 'audit-report', 'needs_confirmation', '2025-03-20T10:00:00.000Z', null, null, null, null,
    material.id, material.version, JSON.stringify(evidence), '[]'];
  pool.rows = [returnedRow(values)];
  await assert.rejects(listFactCandidates(dependencies(pool), scope), /FACT_SCOPE_MISMATCH/);
  assert.match(pool.calls[0]!.sql, /WHERE owner_user_id = \$1 AND project_id = \$2/);
  assert.deepEqual(pool.calls[0]!.values, ['owner-a', 'project-a']);
});

test('live PostgreSQL keeps conflicting candidates and owner/material boundaries',
  { skip: !process.env.FACT_REPOSITORY_TEST_DATABASE_URL && 'set FACT_REPOSITORY_TEST_DATABASE_URL for migrated PostgreSQL 16' },
  async () => {
    const pool = new Pool({ connectionString: process.env.FACT_REPOSITORY_TEST_DATABASE_URL });
    const client = await pool.connect();
    const suffix = randomUUID();
    const owner = `fact-owner-${suffix}`;
    const project = `fact-project-${suffix}`;
    const upload = `fact-upload-${suffix}`;
    const materialId = `fact-material-${suffix}`;
    const hash = 'a'.repeat(64);
    const liveScope = { ownerUserId: owner, projectId: project };
    const liveIdentity = { ...identity, accountId: owner };
    const liveEvidence = [{ ...evidence[0]!, material_id: materialId, extraction_version: 'fact-parser-synthetic-1' }];
    const liveCandidate = { ...candidate(), identity: liveIdentity };
    const db = { pool: { query: async (sql: string, values: unknown[]) => {
      const result = await client.query(sql, values);
      return { rows: result.rows as Record<string, unknown>[] };
    } } };
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES ($1,$2,$3,$4)',
        [project, owner, 'Synthetic fact test', 'update']);
      await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour',$10)`,
      [upload, owner, project, 'synthetic.txt', 'text/plain', 5, hash, 'audit', `fact-test/${suffix}`, 'completed']);
      await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [materialId, 2, owner, project, upload, 'audit', 'synthetic.txt', 'text/plain', 5, hash, `fact-material/${suffix}`, 'parsed']);
      const snapshotId = `fact-snapshot-${suffix}`;
      const parserVersion = 'fact-parser-synthetic-1';
      await client.query(`INSERT INTO bb_parse_snapshots
        (id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,
         response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,2,$5,$6,$7,'{}'::jsonb,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [snapshotId, owner, project, materialId, hash, parserVersion, 'b'.repeat(64), 'c'.repeat(64), JSON.stringify({
        schema_version: 'document-parse-response-v1', request_id: `fact-parse-${suffix}`, parser_version: parserVersion, status: 'parsed',
        material: { material_id: materialId, material_version: 2, media_type: 'text/plain', sha256: hash },
        warnings: [], document: { page_count: null }, error: null,
      })]);
      const liveAnchor = liveEvidence[0]!;
      await client.query(`INSERT INTO bb_parse_evidence
        (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,
         literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,2,$4,$5,$6,$7,$8::jsonb,$9,'synthetic context',$10,$11,$12,$13::jsonb,'{}'::jsonb,$14,0)`,
      [owner, project, materialId, snapshotId, liveAnchor.evidence_id, hash, liveAnchor.locator_type,
        JSON.stringify(liveAnchor.locator), liveAnchor.literal_quote, liveAnchor.extraction_method, parserVersion,
        liveAnchor.confidence, JSON.stringify(liveAnchor.uncertainty), 'd'.repeat(64)]);
      const first = await insertFactCandidate(db, liveScope, liveCandidate, { id: materialId, version: 2 }, liveEvidence);
      const second = await insertFactCandidate(db, liveScope,
        { ...liveCandidate, value: { kind: 'known', decimalOrText: '124.00' },
          source: { ...liveCandidate.source, sourceId: 'second-audit' } },
        { id: materialId, version: 2 }, liveEvidence);
      assert.notEqual(first.candidate.candidateId, second.candidate.candidateId);
      assert.deepEqual((await listFactCandidates(db, liveScope, liveIdentity)).map((row) => row.candidate.value)
        .sort((a, b) => ('decimalOrText' in a ? a.decimalOrText : '').localeCompare(
          'decimalOrText' in b ? b.decimalOrText : '')),
        [{ kind: 'known', decimalOrText: '123.00' }, { kind: 'known', decimalOrText: '124.00' }]);
      const verified = await insertFactCandidate(db, liveScope,
        { ...liveCandidate, auditCheck: { kind: 'source_anchor_review', evidenceId: liveEvidence[0]!.evidence_id,
          verifierId: `synthetic-reviewer-${suffix}`, verifierRole: 'internal_reviewer' } },
        { id: materialId, version: 2 }, liveEvidence);
      assert.equal(verified.provenance.status, 'verified');
      assert.equal((await listFactCandidates(db, { ownerUserId: 'other-owner', projectId: project })).length, 0);
      await assert.rejects(insertFactCandidate(db, liveScope, liveCandidate,
        { id: 'foreign-material', version: 2 }, [{ ...liveEvidence[0]!, material_id: 'foreign-material' }]),
      /FACT_SOURCE_EVIDENCE_NOT_FOUND/);
      await assert.rejects(insertFactCandidate(db, liveScope, { ...liveCandidate,
        auditCheck: { kind: 'source_anchor_review', evidenceId: liveEvidence[0]!.evidence_id,
          verifierId: `synthetic-reviewer-${suffix}`, verifierRole: 'internal_reviewer' } }, { id: materialId, version: 2 },
      [{ ...liveEvidence[0]!, literal_quote: 'forged quote' }]), /FACT_SOURCE_EVIDENCE_NOT_FOUND/);
      const foreignScope = { ownerUserId: `foreign-${owner}`, projectId: project };
      await assert.rejects(insertFactCandidate(db, foreignScope,
        { ...liveCandidate, identity: { ...liveIdentity, accountId: foreignScope.ownerUserId } },
        { id: materialId, version: 2 }, liveEvidence), /FACT_SOURCE_EVIDENCE_NOT_FOUND/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
