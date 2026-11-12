import { lockSyntheticAuthoringInput, quoteSyntheticAuthoringRun } from './test-authoring-source.js';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openApiDocument } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { DOCX, PDF, docxSample, externalRelationshipDocxSample, pdfSample } from './upload-safety.samples.js';
import { UPLOAD_REJECTION_REASONS } from './upload-safety.js';
import type { PrivateBlobs } from './data.js';
import { classifyLibraryVersion, ingestLibraryVersion, markLibraryVersionParsed, registerLibrarySource } from './library.js';

// Synthetic users, source and document. Proves the #78 operator surface is deny-by-default and that the
// user-facing API exposes no library list, candidate or score.
import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase();
const ORIGIN = 'http://bondbuddy.test';
function memoryBlobs(): PrivateBlobs & { keys(): string[] } {
  const store = new Map<string, Buffer>();
  return { async put(k, b) { store.set(k, b); }, async get(k) { const v = store.get(k); if (!v) throw new Error('missing'); return v; }, async getIfExists(k) { return store.get(k) ?? null; },
    async getIfExistsBounded(k, m) { const v = store.get(k); return v && v.length <= m ? v : null; }, async exists(k) { return store.has(k); }, async delete(k) { store.delete(k); }, keys: () => [...store.keys()] };
}

test('operator imports inspect every item before staging or enqueueing', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const blobs = memoryBlobs();
  const actor = `import_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const app = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: actor, csrfVerified: true }) });
  const item = (key: string, mediaType: string, bytes: Buffer) => ({ external_key: key, issuer_key: 'synthetic', issuer_name: 'Synthetic', title: 'Synthetic filing', source_revision: '1', media_type: mediaType, content_base64: bytes.toString('base64') });
  const send = (items: unknown[]) => app.inject({ method: 'POST', url: '/api/v1/admin/library/imports', headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify({ items }) });
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$1)', [actor]);
    await pool.query("INSERT INTO bb_library_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,'library_operator','test','synthetic_grant')", [randomUUID(), actor]);
    const pdf = pdfSample(), docx = await docxSample();
    const bad: Array<[string, ReturnType<typeof item>]> = [
      ['mismatch', item('mismatch', PDF, docx)],
      ['encrypted', item('encrypted', PDF, pdfSample({ encrypted: true }))],
      ['javascript', item('javascript', PDF, pdfSample({ javascript: true }))],
      ['external', item('external', DOCX, await externalRelationshipDocxSample('https://example.test/file', 'attachedTemplate'))],
      ['zip', item('zip', DOCX, Buffer.from('PK\x03\x04broken'))],
    ];
    const jobsBefore = (await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE job_type='library'")).rows[0].n;
    for (const [key, invalid] of bad) {
      const response = await send([invalid]);
      assert.equal(response.statusCode, 422, `${key}: ${response.body}`);
      assert.equal(response.json().field_errors[0].field, 'items[0].content_base64');
      assert.match(response.json().field_errors[0].message, new RegExp(`external_key=${key}: MATERIAL_`));
      assert.ok(UPLOAD_REJECTION_REASONS.includes(response.json().field_errors[0].code));
      assert.deepEqual(blobs.keys(), []);
    }
    const mixed = await send([item('valid', PDF, pdf), bad[1]![1]]);
    assert.equal(mixed.statusCode, 422, mixed.body);
    assert.equal(mixed.json().field_errors[0].field, 'items[1].content_base64');
    assert.deepEqual(blobs.keys(), []);
    const malformed = { ...item('malformed', PDF, pdf), content_base64: '%%%' };
    const multiple = await send([malformed, bad[1]![1]]);
    assert.equal(multiple.statusCode, 422, multiple.body);
    assert.deepEqual(multiple.json().field_errors.map((e: { field: string }) => e.field), ['items[0].content_base64', 'items[1].content_base64']);
    assert.deepEqual(blobs.keys(), []);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE job_type='library'")).rows[0].n, jobsBefore);
    const fiveMib = item('over-limit', PDF, Buffer.alloc(5 * 1024 * 1024));
    const oversized = await send(Array.from({ length: 41 }, (_, index) => ({ ...fiveMib, external_key: `over-${index}` })));
    assert.equal(oversized.statusCode, 422, oversized.body.slice(0, 500));
    assert.equal(oversized.json().field_errors[0].code, 'size_limit');
    assert.deepEqual(blobs.keys(), []);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE job_type='library'")).rows[0].n, jobsBefore);
    const valid = await send([item('valid-pdf', PDF, pdf), item('valid-docx', DOCX, docx)]);
    assert.equal(valid.statusCode, 202, valid.body);
    assert.equal(valid.json().items, 2);
    assert.equal(blobs.keys().length, 2);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE job_type='library'")).rows[0].n, jobsBefore + 1);
  } finally { await app.close(); await pool.end(); }
});

test('public contract has no library route, schema or candidate field', () => {
  const doc = JSON.stringify(openApiDocument());
  for (const needle of ['/admin/library', 'LibraryQuery', 'LibraryCandidate', 'top3_set_key', 'review_quality', 'reference-library-query',
    // accounting_scope is now a legitimate public generation-issuer-binding field (#33);
    // library exposure is still guarded by the library-only schema names and fields below.
    'LibraryComparability', 'LibraryChapterMapping', 'reviewed_by', 'mapping_version_id', 'chapter_mappings',
    // Alert kind names appear in the admin alerts enum; only the per-source sync fields must stay out.
    'sync_interval_seconds', 'next_sync_due_at', 'consecutive_failures']) assert.equal(doc.includes(needle), false, needle);
});

test('admin library routes: 404 for ordinary users, read-only for readers, actions for operators; user routes never leak library data', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const blobs = memoryBlobs();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const plain = `lib_user_${suffix}`, reader = `lib_reader_${suffix}`, operator = `lib_op_${suffix}`;
  let current = plain;
  const app = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: current, csrfVerified: true }), enableSyntheticQueue: true });
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
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers }, payload: JSON.stringify({ name: 'Synthetic', kind: 'update', issuer_name: null, market: 'sse', offering: 'public' }) });
    assert.equal(created.statusCode, 201, created.body);
    for (const url of ['/api/v1/projects', `/api/v1/projects/${created.json().project_id}`]) {
      const r = await app.inject({ method: 'GET', url, headers });
      for (const needle of [ingested.versionId, ingested.documentId, mapped.json().mapping_version_id, 'top3_set_key', 'review_quality', 'candidates', 'Synthetic Admin Issuer',
        'revenue_basis', 'reviewed_by', 'ten_thousand_yuan', 'chapter_mappings', 'reference-library-query',
        sourceId, 'sync_interval_seconds', 'next_sync_due_at', 'consecutive_failures', 'last_success_at', 'library_source_stale', 'library_sync_failed']) assert.equal(r.body.includes(needle), false, `${url} leaks ${needle}`);
    }
    // Use a staged update run here: generation submission requires an approved issuer binding.
    // A selection trace may contain private library identifiers and review details. It belongs only
    // in the durable job checkpoint, never in run polling, SSE, or Word delivery metadata.
    const projectId = created.json().project_id as string;
    const input = await lockSyntheticAuthoringInput(app,projectId,headers);
    assert.equal(input.statusCode, 201, input.body);
    const quoteId = await quoteSyntheticAuthoringRun(app,pool,plain,projectId,input.json(),headers);
    const runRequest = { execution_request_id: `library-output-${suffix}`, project_id: projectId, input_revision: 1,
      input_hash: input.json().input_hash, quote_id: quoteId, task_kind: 'update', input_manifest_ref: 'synthetic-manifest',
      storage_origin: 'cloud', workspace_id: 'synthetic-workspace' };
    const started = await app.inject({ method: 'POST', url: '/api/v1/runs/execute', headers, payload: JSON.stringify(runRequest) });
    assert.equal(started.statusCode, 202, started.body);
    const runId = started.json().run_id as string;
    const privateValues = [sourceId, ingested.versionId, ingested.documentId, mapped.json().mapping_version_id,
      'https://source.example/private-filing', 'licence-secret-reference', 'withdrawn-draft-marker',
      'other-user-project-marker', 'reviewer-private-marker', 'candidate-score-marker'];
    const trace = { source_url: privateValues[4], credential_ref: privateValues[5], withdrawn_version: privateValues[6],
      foreign_project: privateValues[7], reviewed_by: privateValues[8], match_score: privateValues[9],
      source_id: sourceId, document_version_id: ingested.versionId, candidate_decisions: [{ score: privateValues[9] }] };
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_build_object('stages',jsonb_build_object('reference_selection',$2::jsonb)) WHERE run_id=$1",
      [runId, JSON.stringify(trace)]);
    const artifactId = `synthetic-word-${suffix}`, wordBytes = makeSyntheticDocxFixture();
    const wordHash = createHash('sha256').update(wordBytes).digest('hex');
    const wordKey = `users/${plain}/runs/${runId}/artifacts/${artifactId}/v1.docx`;
    const evidenceId = randomUUID();
    await blobs.put(wordKey, wordBytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO bb_word_delivery_evidence
        (id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,
         quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
        VALUES($1,$2,$3,$4,1,$5,$6,'synthetic-validator','passed','available','readback_verified',$5,$6,$7)`,
        [evidenceId, plain, runId, artifactId, wordHash, wordBytes.length,
          { sha256: wordHash, byte_size: wordBytes.length, validator_version: 'synthetic-validator', quality_status: 'passed' }]);
      await client.query(`INSERT INTO bb_artifact_versions
        (id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
        VALUES($1,1,$2,$3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'passed','available',$6)`,
        [artifactId, plain, runId, wordHash, wordKey, evidenceId]);
      await client.query("UPDATE bb_runs SET state='succeeded',artifact_id=$2,artifact_version=1 WHERE id=$1", [runId, artifactId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    for (const url of [`/api/v1/runs/${runId}`, `/api/v1/runs/${runId}/events`,
      `/api/v1/runs/${runId}/stream`, `/api/v1/artifacts/${artifactId}`]) {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      for (const value of privateValues) assert.equal(response.body.includes(value), false, `${url} leaks ${value}`);
    }
    const metadata = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifactId}`, headers });
    const download = await app.inject({ method: 'GET', url: metadata.json().download_url, headers });
    assert.equal(download.statusCode, 200, download.body);
    assert.deepEqual(download.rawPayload, wordBytes, 'owned Word bytes are the synthetic fixture, not the private selection trace');
    current = reader;
    for (const url of [`/api/v1/runs/${runId}`, `/api/v1/runs/${runId}/events`, `/api/v1/artifacts/${artifactId}`]) {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 404, `${url} must be owner-scoped`);
    }
    current = plain;
    const guess = await app.inject({ method: 'GET', url: `/api/v1/library/versions/${ingested.versionId}`, headers });
    assert.equal(guess.statusCode, 404);
  } finally { await app.close(); await pool.end(); }
});
