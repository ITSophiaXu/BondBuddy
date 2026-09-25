import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openApiDocument } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import type { PrivateBlobs } from './data.js';
import { classifyLibraryVersion, ingestLibraryVersion, markLibraryVersionParsed, registerLibrarySource } from './library.js';

// Synthetic users, source and document. Proves the #78 operator surface is deny-by-default and that the
// user-facing API exposes no library list, candidate or score.
const connection = process.env.BB_TEST_DATABASE_URL;
const ORIGIN = 'http://bondbuddy.test';
function memoryBlobs(): PrivateBlobs {
  const store = new Map<string, Buffer>();
  return { async put(k, b) { store.set(k, b); }, async get(k) { const v = store.get(k); if (!v) throw new Error('missing'); return v; }, async getIfExists(k) { return store.get(k) ?? null; },
    async getIfExistsBounded(k, m) { const v = store.get(k); return v && v.length <= m ? v : null; }, async exists(k) { return store.has(k); }, async delete(k) { store.delete(k); } };
}

test('public contract has no library route, schema or candidate field', () => {
  const doc = JSON.stringify(openApiDocument());
  for (const needle of ['/admin/library', 'LibraryQuery', 'LibraryCandidate', 'top3_set_key', 'review_quality', 'reference-library-query',
    'LibraryComparability', 'LibraryChapterMapping', 'revenue_basis', 'accounting_scope', 'reviewed_by', 'mapping_version_id', 'chapter_mappings',
    'sync_interval_seconds', 'next_sync_due_at', 'consecutive_failures', 'library_source_stale', 'library_sync_failed']) assert.equal(doc.includes(needle), false, needle);
});

test('admin library routes: 404 for ordinary users, read-only for readers, actions for operators; user routes never leak library data', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const blobs = memoryBlobs();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const plain = `lib_user_${suffix}`, reader = `lib_reader_${suffix}`, operator = `lib_op_${suffix}`;
  let current = plain;
  const app = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: current, csrfVerified: true }) });
  try {
    for (const id of [plain, reader, operator]) await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, id.toLowerCase().slice(0, 32)]);
    await pool.query("INSERT INTO bb_library_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,'library_reader','test','synthetic_grant'),($3,$4,'library_operator','test','synthetic_grant')", [randomUUID(), reader, randomUUID(), operator]);
    const sourceId = `syn_admin_${suffix}`;
    await registerLibrarySource(pool, { id: sourceId, kind: 'public_disclosure', displayName: 'Synthetic', market: 'sse', authorizationBasis: 'synthetic test', usageRights: 'evaluation_only' });
    const ingested = await ingestLibraryVersion(pool, blobs, { sourceId, externalKey: 'adm', issuerKey: 'adm', issuerName: 'Synthetic Admin Issuer', title: 't', sourceRevision: '1', sourceRevisionRank: 1, bytes: Buffer.from('%PDF admin'), mediaType: 'application/pdf' });
    await markLibraryVersionParsed(pool, ingested.versionId, { synthetic: true });
    await classifyLibraryVersion(pool, ingested.versionId, { market: 'sse', offering: 'public', instrument: 'corporate_bond', documentStage: 'registration' },
      { fiscalYear: 2025, taxonomyVersion: `tax-${suffix}`, accountingScope: 'consolidated', top3: ['A', 'B', 'C'].map((code, i) => ({ code, label: code, rank: i + 1, revenue: String(9 - i), evidence: ['p1'] })),
        revenueBasis: 'operating_revenue', currency: 'CNY', unit: 'ten_thousand_yuan' });
    const headers = { origin: ORIGIN, 'content-type': 'application/json' };
    const mappingBody = { mapping_key: `adm.${suffix}`, source: { market: 'sse', offering: 'public', instrument: 'corporate_bond' }, target: { market: 'szse', offering: 'public', instrument: 'corporate_bond' },
      document_stage: 'registration', rule_version: `rule-adm-${suffix}`, reason: 'synthetic_mapping_ok' };
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/v1/admin/library/overview'], ['GET', '/api/v1/admin/library/alerts'], ['GET', '/api/v1/admin/library/misses'], ['GET', '/api/v1/admin/library/reviews'],
      ['GET', `/api/v1/admin/library/versions/${ingested.versionId}`],
      ['POST', `/api/v1/admin/library/versions/${ingested.versionId}/review`, { action: 'approve', reason: 'synthetic_ok' }],
      ['POST', `/api/v1/admin/library/versions/${ingested.versionId}/rerun`, {}], ['POST', `/api/v1/admin/library/sources/${sourceId}/sync`, {}],
      ['POST', `/api/v1/admin/library/sources/${sourceId}/rights`, { usage_rights: 'commercial_licensed', reason: 'x' }], ['POST', '/api/v1/admin/library/imports', { items: [] }],
      ['POST', '/api/v1/admin/library/releases/library-release-genesis/rollback', { reason: 'x' }],
      ['POST', '/api/v1/admin/library/chapter-mappings', mappingBody], ['POST', '/api/v1/admin/library/chapter-mappings/unknown-mapping/withdraw', { reason: 'x' }],
    ];
    current = plain;
    for (const [method, url, body] of routes) {
      const r = await app.inject({ method: method as 'GET', url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(r.statusCode, 404, `${method} ${url} must be indistinguishable from a missing route`);
      assert.equal(r.body.includes('Synthetic Admin Issuer'), false);
    }
    current = reader;
    const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/library/overview', headers });
    assert.equal(overview.statusCode, 200);
    assert.ok(overview.json().counts.open_reviews >= 1);
    // #78 scheduled-sync operator fields: cadence, next due, failures since last full success.
    const syncRow = overview.json().sources.find((s: { source_id: string }) => s.source_id === sourceId);
    assert.deepEqual([syncRow.sync_interval_seconds, syncRow.consecutive_failures, typeof syncRow.next_sync_due_at], [86400, 0, 'string']);
    for (const key of ['new_24h', 'pending', 'failed', 'stale_sources']) assert.equal(typeof overview.json().counts[key], 'number');
    const reviews = await app.inject({ method: 'GET', url: '/api/v1/admin/library/reviews', headers });
    assert.ok(reviews.json().items.some((i: { document_version_id: string }) => i.document_version_id === ingested.versionId));
    for (const [method, url, body] of routes.filter(r => r[0] === 'POST')) {
      const r = await app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });
      assert.equal(r.statusCode, 404, `reader cannot ${url}`);
    }
    current = operator;
    const approved = await app.inject({ method: 'POST', url: `/api/v1/admin/library/versions/${ingested.versionId}/review`, headers, payload: JSON.stringify({ action: 'approve', reason: 'synthetic_review_ok', review_quality: 70 }) });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, 'published');
    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/library/versions/${ingested.versionId}`, headers });
    assert.deepEqual(detail.json().audit.filter((a: { subject_type: string }) => a.subject_type === 'document_version').map((a: { to_state: string }) => a.to_state), ['pending_parse', 'pending_classify', 'pending_review', 'published']);
    const mapped = await app.inject({ method: 'POST', url: '/api/v1/admin/library/chapter-mappings', headers, payload: JSON.stringify(mappingBody) });
    assert.equal(mapped.statusCode, 201, mapped.body);
    assert.equal(mapped.json().version, 1);
    const badMapping = await app.inject({ method: 'POST', url: '/api/v1/admin/library/chapter-mappings', headers, payload: JSON.stringify({ ...mappingBody, target: mappingBody.source }) });
    assert.equal(badMapping.statusCode, 422);
    const pubProfile = detail.json().profiles.find((p: { state: string }) => p.state === 'published');
    assert.deepEqual([pubProfile.revenue_basis, pubProfile.currency, pubProfile.unit, pubProfile.reviewed_by], ['operating_revenue', 'CNY', 'ten_thousand_yuan', operator]);
    const bad = await app.inject({ method: 'POST', url: `/api/v1/admin/library/versions/${ingested.versionId}/review`, headers, payload: JSON.stringify({ action: 'approve', reason: 'Not A Code' }) });
    assert.equal(bad.statusCode, 422);
    const audited = (await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE actor_id=$1 AND purpose='library_operate'", [operator])).rows[0].n;
    assert.ok(audited >= 2, 'operator access is audited');

    // Ordinary user-facing routes: a project listing and detail carry no library data.
    current = plain;
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers }, payload: JSON.stringify({ name: 'Synthetic', kind: 'generation', issuer_name: null, market: 'sse', offering: 'public' }) });
    assert.equal(created.statusCode, 201, created.body);
    for (const url of ['/api/v1/projects', `/api/v1/projects/${created.json().project_id}`]) {
      const r = await app.inject({ method: 'GET', url, headers });
      for (const needle of [ingested.versionId, ingested.documentId, mapped.json().mapping_version_id, 'top3_set_key', 'review_quality', 'candidates', 'Synthetic Admin Issuer',
        'revenue_basis', 'reviewed_by', 'ten_thousand_yuan', 'chapter_mappings', 'reference-library-query',
        sourceId, 'sync_interval_seconds', 'next_sync_due_at', 'consecutive_failures', 'last_success_at', 'library_source_stale', 'library_sync_failed']) assert.equal(r.body.includes(needle), false, `${url} leaks ${needle}`);
    }
    const guess = await app.inject({ method: 'GET', url: `/api/v1/library/versions/${ingested.versionId}`, headers });
    assert.equal(guess.statusCode, 404);
  } finally { await app.close(); await pool.end(); }
});
