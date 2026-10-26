import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import { produceParsedFactCandidates, SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
  type FactCandidateProducerDependencies, type SemanticFactExtractionResult } from './fact-candidate-producer.js';

// Synthetic component evidence: these exercise the real pending-issuer and grant
// assertions without activating V2 in PostgreSQL, calling a model or charging credits.
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);

async function preprod(work: () => Promise<void>) {
  const keys = ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL'] as const;
  const before = keys.map(key => process.env[key]);
  process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
  try { await work(); } finally {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
}

function fixture() {
  const context = { ownerUserId: 'synthetic-owner', projectId: 'synthetic-project', testRunId: 'synthetic-run',
    inputRevision: 2, inputHash: 'b'.repeat(64), materialId: 'synthetic-finance', materialVersion: 1,
    snapshotId: 'synthetic-finance-snapshot' };
  const rawRun = { id: context.testRunId, owner_user_id: context.ownerUserId, project_id: context.projectId,
    input_revision: 1, input_hash: 'a'.repeat(64), channel: 'non_production_test', test_grant_id: 'original-grant' };
  const identity = { ownerUserId: context.ownerUserId, projectId: context.projectId, materialId: 'synthetic-history',
    materialVersion: 1, snapshotId: 'synthetic-history-snapshot', sourceRecordId: 'synthetic-identity-evidence',
    sourceRecordSha256: 'c'.repeat(64), sourceContentSha256: 'd'.repeat(64), sourceLocatorType: 'text_line',
    sourceLocator: { line: 1 }, sourceQuote: 'Synthetic issuer', issuerDisplayName: 'Synthetic issuer',
    entityId: 'issuer-name:synthetic', identityVersion: 1 };
  const identityHash = sha(canonical(identity));
  const sourceRow = { id: 'synthetic-observation', owner_user_id: identity.ownerUserId, project_id: identity.projectId,
    material_id: identity.materialId, material_version: 1, snapshot_id: identity.snapshotId,
    source_record_id: identity.sourceRecordId, source_record_sha256: identity.sourceRecordSha256,
    source_content_sha256: identity.sourceContentSha256, source_locator_type: identity.sourceLocatorType,
    source_locator: identity.sourceLocator, source_quote: identity.sourceQuote, issuer_display_name: identity.issuerDisplayName,
    entity_id: identity.entityId, identity_version: 1, request_id: 'synthetic-request', request_hash: 'e'.repeat(64),
    content_sha256: identityHash, state: 'needs_review', review_decision: null, active_grant_id: null,
    snapshot_sha256: 'f'.repeat(64), snapshot_meta: { warnings: [] }, created_at: new Date('2026-10-26T00:00:00Z') };
  const candidate = { status: 'pending_test_candidate', material_id: identity.materialId, material_version: 1,
    source_record_id: sourceRow.id, identity_version: 1, content_sha256: identityHash, snapshot_id: identity.snapshotId,
    snapshot_sha256: sourceRow.snapshot_sha256, source_content_sha256: identity.sourceContentSha256,
    candidate_key: identity.entityId, issuer_display_name: identity.issuerDisplayName };
  const material = { role: 'financial', media_type: 'text/plain', sha256: '1'.repeat(64) };
  const snapshot = { snapshotId: context.snapshotId, contentSha256: material.sha256, parserVersion: 'synthetic-parser',
    responseSha256: '2'.repeat(64), evidence: [{ record_id: 'synthetic-finance-record' }],
    response: { status: 'parsed', material: { material_id: context.materialId, material_version: 1 } } } as StoredParseSnapshot;
  const result: SemanticFactExtractionResult = { schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
    extractor: { id: 'synthetic-extractor', version: 'v1' }, parse_snapshot: { snapshot_id: snapshot.snapshotId,
      response_sha256: snapshot.responseSha256, parser_version: snapshot.parserVersion,
      material_id: context.materialId, material_version: 1, content_sha256: snapshot.contentSha256 },
    facts: [], needs_review: [{ evidence_refs: ['synthetic-finance-record'], reason_code: 'DIMENSIONS_UNCONFIRMED' }] };
  const grant = { user_id: context.ownerUserId, project_id: context.projectId, input_revision: 2,
    input_hash: context.inputHash, expires_at: new Date(Date.now() + 3600000), revoked_at: null as Date | null };
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const state = { headCount: 1, receiptCount: 1, extractCalls: 0, afterExtract: () => {} };
  const rows = (items: unknown[]) => ({ rows: items, rowCount: items.length });
  const query = async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return rows([]);
    if (sql.includes('pg_advisory_xact_lock')) return rows([{}]);
    if (sql.includes('SELECT input_hash, manifest, material_versions FROM bb_input_revisions')) return rows([
      { input_hash: context.inputHash, material_versions: [{ material_id: context.materialId, material_version: 1 }],
        manifest: { test_issuer_candidate: candidate } }]);
    if (sql.includes('SELECT h.execution_version FROM bb_runs r')) {
      assert.deepEqual(args, [context.testRunId, context.ownerUserId, context.projectId, 2, context.inputHash]);
      return rows(Array.from({ length: state.headCount }, () => ({ execution_version: 2 })));
    }
    if (sql.includes('SELECT r.* FROM bb_runs r')) return rows([rawRun]);
    if (sql.includes('FROM bb_run_execution_versions e')) return rows([{ execution_version: 2,
      input_revision: context.inputRevision, input_hash: context.inputHash, channel: rawRun.channel,
      successor_authorization_id: 'synthetic-successor-receipt' }]);
    if (sql.includes('FROM bb_run_test_successor_authorizations a')) return rows(Array.from({ length: state.receiptCount },
      () => ({ id: 'synthetic-successor-receipt', test_grant_id: 'successor-grant' })));
    if (sql.includes('FROM bb_non_production_test_grants')) {
      assert.deepEqual(args, ['successor-grant'], 'fact extraction must not reuse the original grant');
      return rows([grant]);
    }
    if (sql.includes('SELECT 1 FROM bb_material_versions m JOIN bb_projects p')) return rows([{}]);
    if (sql.includes('active_grant_id FROM bb_issuer_identity_source_records r')) return rows([sourceRow]);
    if (sql.includes('SELECT 1 FROM bb_issuer_identity_source_reviews')) return rows([]);
    if (sql.includes('SELECT role, media_type, sha256 FROM bb_material_versions')
      || sql.includes('SELECT role,media_type,sha256 FROM bb_material_versions')) return rows([material]);
    if (sql.includes('SELECT 1 FROM bb_input_revisions') || sql.includes('SELECT 1 FROM bb_parse_snapshots')
      || sql.includes('SELECT id FROM bb_issuer_identity_source_records')) return rows([{}]);
    if (sql.includes('FROM bb_fact_extraction_runs') || sql.includes('FROM bb_fact_candidates')) return rows([]);
    if (sql.startsWith('INSERT INTO bb_fact_extraction_runs') || sql.startsWith('INSERT INTO bb_outbox')) return rows([{}]);
    throw new Error(`Unexpected pending-issuer extraction query: ${sql}`);
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  const dependencies: FactCandidateProducerDependencies = { pool, loadSnapshot: async () => snapshot,
    extractor: { ...result.extractor, extract: async request => {
      state.extractCalls++; assert.equal(request.input_revision, 2); assert.equal(request.input_hash, context.inputHash);
      assert.equal(request.entity_id, identity.entityId); state.afterExtract(); return result;
    } } };
  return { context, rawRun, grant, state, calls, dependencies };
}

test('pending issuer successor extraction checks the exact successor grant at admission and persistence', async () => preprod(async () => {
  const f = fixture(), origin = structuredClone(f.rawRun);
  const result = await produceParsedFactCandidates(f.dependencies, f.context);
  assert.equal(result.needsReview.length, 1); assert.equal(f.state.extractCalls, 1);
  assert.equal(f.calls.filter(call => call.sql.includes('FROM bb_non_production_test_grants')).length, 2);
  assert.equal(f.calls.filter(call => call.sql.startsWith('INSERT INTO bb_fact_extraction_runs')).length, 1);
  assert.equal(f.calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.deepEqual(f.rawRun, origin);
}));

test('pending issuer extraction rejects absent or ambiguous active authority before extraction', async () => preprod(async () => {
  for (const kind of ['missing-head', 'ambiguous-head', 'missing-receipt', 'revoked'] as const) {
    const f = fixture();
    if (kind === 'missing-head') f.state.headCount = 0;
    if (kind === 'ambiguous-head') f.state.headCount = 2;
    if (kind === 'missing-receipt') f.state.receiptCount = 0;
    if (kind === 'revoked') f.grant.revoked_at = new Date();
    await assert.rejects(produceParsedFactCandidates(f.dependencies, f.context), error =>
      (error as Error).message === 'FACT_EXTRACTION_TEST_ISSUER_CANDIDATE_STALE'
      || ['TEST_GRANT_MISMATCH', 'TEST_GRANT_REVOKED'].includes((error as { code: string }).code), kind);
    assert.equal(f.state.extractCalls, 0, kind);
    assert.ok(f.calls.every(call => !call.sql.startsWith('INSERT ')), kind);
  }
}));

test('successor grant revoked during extraction blocks candidate-ledger persistence', async () => preprod(async () => {
  const f = fixture(); f.state.afterExtract = () => { f.grant.revoked_at = new Date(); };
  await assert.rejects(produceParsedFactCandidates(f.dependencies, f.context), error =>
    (error as { code?: string }).code === 'TEST_GRANT_REVOKED');
  assert.equal(f.state.extractCalls, 1);
  assert.ok(f.calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(f.calls.every(call => !call.sql.startsWith('INSERT ') && call.sql !== 'COMMIT'));
}));
