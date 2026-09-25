import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import {
  classifyLibraryVersion, enqueueLibraryRecordRerun, enqueueLibrarySync, ingestLibraryVersion, invalidateLibraryCache, libraryAlerts, libraryCacheSize, libraryOverview,
  lockReferenceSelection, markLibraryVersionParsed, queryReferenceLibrary, readLockedReference, reclassifyPendingProfile, registerLibrarySource, reviewLibraryVersion,
  rollbackLibraryRelease, setLibrarySourceRights, syncRunSummary, type ProfileDraft, type ProfileLine,
} from '@bondbuddy/api/library';
import type { LibraryQueryRequest } from '@bondbuddy/contracts';
import { conservativeClassifier, runLibraryOnce, type LibraryClassifier, type LibraryParser, type LibraryPipelineDependencies } from './library-pipeline.js';
import { OperatorImportAdapter, SourceError, SseBondProjectAdapter, type DiscoveredItem, type LibrarySourceAdapter } from './library-sources.js';
import { isolatedTestDatabase } from './test-database.js';

// Everything here is synthetic: fake source, fake parser output, fake issuers and revenue lines.
// It proves the #78 library mechanics; it is not evidence about any real prospectus.
const connection = await isolatedTestDatabase();
const skip = !connection;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function memoryBlobs(): PrivateBlobs & { keys(): string[] } {
  const store = new Map<string, Buffer>();
  return {
    async put(key, bytes) { store.set(key, Buffer.from(bytes)); },
    async get(key) { const v = store.get(key); if (!v) throw new Error('missing'); return v; },
    async getIfExists(key) { return store.get(key) ?? null; },
    async getIfExistsBounded(key, max) { const v = store.get(key); return v && v.length <= max ? v : null; },
    async exists(key) { return store.has(key); },
    async delete(key) { store.delete(key); },
    keys: () => [...store.keys()],
  };
}

const syntheticParser: LibraryParser = async request => ({
  schema_version: 'document-parse-response-v1', request_id: request.request_id, parser_version: 'synthetic-parser', status: 'parsed',
  material: { material_id: request.material.material_id, material_version: request.material.material_version, media_type: request.material.media_type, sha256: request.material.sha256 },
  records: [{ record_id: 'r1', material_id: request.material.material_id, material_version: request.material.material_version, content_hash: request.material.sha256, locator_type: 'text_line',
    locator: { line: 1 }, literal_quote: 'synthetic revenue table', context: 'synthetic', extraction_method: 'native_text', extractor_version: 'synthetic', confidence: 1, uncertainty: [], formatting: {} }],
  warnings: [], document: { page_count: 1 }, error: null,
});

const lines = (codes: string[]): ProfileLine[] => codes.map((code, i) => ({ code, label: code, rank: i + 1, revenue: String(300 - i * 100), evidence: [`p${10 + i}`] }));
const draft = (codes: string[], taxonomy: string): ProfileDraft => ({ fiscalYear: 2025, taxonomyVersion: taxonomy, accountingScope: 'consolidated', top3: lines(codes) });
const TOP3 = ['BIZ.WATER', 'BIZ.CONSTRUCTION', 'BIZ.PROPERTY'];
const syntheticClassifier = (taxonomy: string, codes = TOP3): LibraryClassifier => () => ({
  classification: { market: 'sse', offering: 'public', instrument: 'corporate_bond', documentStage: 'registration' },
  profile: draft(codes, taxonomy),
});

class FakeSource implements LibrarySourceAdapter {
  readonly mode = 'scheduled' as const;
  items: DiscoveredItem[] = [];
  bytes = new Map<string, Buffer>();
  failuresLeft = new Map<string, number>();
  fetches: string[] = [];
  discoverFails = 0;
  constructor(readonly sourceId: string) {}
  add(externalKey: string, revision: number, content: string, issuerKey = `issuer-${externalKey}`) {
    const item: DiscoveredItem = { itemKey: `${externalKey}:v${revision}`, externalKey, issuerKey, issuerName: `Synthetic Issuer ${externalKey}`, title: `Synthetic ${externalKey} 面向专业投资者公开发行公司债券募集说明书`,
      sourceRevision: String(revision), sourceRevisionRank: revision, mediaType: 'application/pdf', sourceUrl: null, disclosedAt: '2026-09-20', market: 'sse', locator: `${externalKey}:${revision}` };
    this.items.push(item); this.bytes.set(item.locator, Buffer.from(`%PDF-1.7 synthetic ${content}`));
    return item;
  }
  async discover() {
    if (this.discoverFails > 0) { this.discoverFails--; throw new SourceError('LIBRARY_SOURCE_UNREACHABLE', true); }
    return { items: [...this.items], cursorAfter: { seen: this.items.length } };
  }
  async fetch(item: DiscoveredItem) {
    this.fetches.push(item.itemKey);
    const left = this.failuresLeft.get(item.itemKey) ?? 0;
    if (left > 0) { this.failuresLeft.set(item.itemKey, left - 1); throw new SourceError('LIBRARY_FETCH_FAILED', true); }
    return this.bytes.get(item.locator)!;
  }
}

async function setup(rights: 'commercial_licensed' | 'evaluation_only' = 'commercial_licensed') {
  const pool = new Pool({ connectionString: connection });
  const blobs = memoryBlobs();
  const sourceId = `syn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await registerLibrarySource(pool, { id: sourceId, kind: 'public_disclosure', displayName: 'Synthetic source', market: 'sse', authorizationBasis: 'synthetic test fixture', usageRights: rights });
  const source = new FakeSource(sourceId);
  // A per-test taxonomy version keeps queries in this shared per-file database scoped to this test's rows.
  const taxonomy = `tax-${sourceId}`;
  const owner = `lib-owner-${randomUUID()}`, project = `lib-project-${randomUUID()}`;
  await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)', [project, owner, 'Synthetic library consumer', 'generation']);
  const deps: LibraryPipelineDependencies = { pool, blobs, adapters: { [sourceId]: source }, parser: syntheticParser, classifier: syntheticClassifier(taxonomy), retryDelayMs: 1 };
  const query = (codes = TOP3, extra: Partial<LibraryQueryRequest['target']> = {}, indexRelease: string | null = null) => queryReferenceLibrary(pool, {
    schema_version: 'reference-library-query-v1', service_identity: 'task_service', audit: { owner_user_id: owner, project_id: project, run_id: null, trace_id: 'trace-syn' },
    target: { top3_codes: codes, taxonomy_version: taxonomy, fiscal_year: 2025, evidence_refs: ['fact-1'], market: 'sse', offering: 'public', instrument: 'corporate_bond', document_stage: 'registration', rule_version: 'rule-syn', ...extra },
    index_release: indexRelease,
  });
  const drain = async () => { const outcomes = []; for (let i = 0; i < 10; i++) { const o = await runLibraryOnce(deps); if (o.outcome === 'idle') break; outcomes.push(o); } return outcomes; };
  const versionOf = async (externalKey: string, revision: number) => (await pool.query(`SELECT v.* FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id
    WHERE d.source_id=$1 AND d.external_key=$2 AND v.source_revision=$3`, [sourceId, externalKey, String(revision)])).rows[0];
  const approve = (versionId: string) => reviewLibraryVersion(pool, versionId, { action: 'approve', reason: 'synthetic_review_ok', review_quality: 80 }, 'operator-syn');
  return { taxonomy, pool, blobs, sourceId, source, owner, project, deps, query, drain, versionOf, approve };
}

test('first sync and incremental sync record new, unchanged, new-version and failure/retry outcomes without duplicates', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('A', 1, 'a1'); t.source.add('B', 1, 'b1'); t.source.add('C', 1, 'c1');
    t.source.failuresLeft.set('B:v1', 1);   // transient: succeeds on 2nd fetch try
    t.source.failuresLeft.set('C:v1', 5);   // persistent in this run
    await enqueueLibrarySync(t.pool, t.sourceId);
    const first = await t.drain();
    assert.equal(first.length, 1); assert.equal(first[0]!.outcome, 'succeeded'); assert.equal(first[0]!.partial, true);
    const s1 = await syncRunSummary(t.pool, first[0]!.syncRunId!);
    assert.deepEqual(s1.outcomes, { new_document: 2, failed: 1 });
    const bItem = (await t.pool.query('SELECT attempts FROM bb_library_sync_items WHERE sync_run_id=$1 AND item_key=$2', [s1.sync_run_id, 'B:v1'])).rows[0];
    assert.equal(bItem.attempts, 2, 'retry is recorded per item');
    const src1 = (await t.pool.query('SELECT last_success_at,last_error_code,cursor FROM bb_library_sources WHERE id=$1', [t.sourceId])).rows[0];
    assert.equal(src1.last_success_at, null, 'a partial sync is not a success'); assert.equal(src1.last_error_code, 'LIBRARY_FETCH_FAILED');
    assert.ok((await libraryAlerts(t.pool)).some(a => a.kind === 'source_sync_failed' && a.subject === t.sourceId));

    t.source.add('A', 2, 'a2');
    t.source.failuresLeft.clear();
    await enqueueLibrarySync(t.pool, t.sourceId);
    const second = await t.drain();
    const s2 = await syncRunSummary(t.pool, second[0]!.syncRunId!);
    assert.deepEqual(s2.outcomes, { unchanged: 2, new_document: 1, new_version: 1 });
    const src2 = (await t.pool.query('SELECT last_success_at,last_error_code FROM bb_library_sources WHERE id=$1', [t.sourceId])).rows[0];
    assert.ok(src2.last_success_at); assert.equal(src2.last_error_code, null);
    // Idempotent re-run: a third identical sync ingests nothing new.
    await enqueueLibrarySync(t.pool, t.sourceId);
    const third = await syncRunSummary(t.pool, (await t.drain())[0]!.syncRunId!);
    assert.deepEqual(third.outcomes, { unchanged: 4 });
    const count = (await t.pool.query('SELECT count(*)::int n FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1', [t.sourceId])).rows[0].n;
    assert.equal(count, 4, 'A1, A2, B1, C1 once each');
    // A new revision retires the older unreviewed one from the queue; nothing was published by the pipeline.
    assert.equal((await t.versionOf('A', 1)).state, 'superseded');
    assert.equal((await t.versionOf('A', 2)).state, 'pending_review');
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM bb_library_document_versions WHERE state='published' AND fetched_by_job_id IS NOT NULL AND document_id IN (SELECT id FROM bb_library_documents WHERE source_id=$1)", [t.sourceId])).rows[0].n, 0);
    // #79 rows exist for the library job under the system owner.
    const events = (await t.pool.query("SELECT count(*)::int n FROM bb_observability_events WHERE owner_user_id='system-reference-library' AND job_id=$1", [first[0]!.jobId])).rows[0].n;
    assert.ok(events >= 3);
  } finally { await t.pool.end(); }
});

test('a crash half-way resumes after the last checkpointed item; discovery failure retries then fails with an alert', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('R1', 1, 'r1'); t.source.add('R2', 1, 'r2'); t.source.add('R3', 1, 'r3');
    await enqueueLibrarySync(t.pool, t.sourceId);
    let crashed = false;
    const crashing = { ...t.deps, leaseSeconds: 30, afterItem: async (index: number, _item: DiscoveredItem, lease: { jobId: string }) => {
      if (index === 0 && !crashed) { crashed = true; await t.pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.jobId]); throw new Error('simulated process crash'); }
    } };
    const lost = await runLibraryOnce(crashing);
    assert.equal(lost.outcome, 'lost');
    const resumed = await runLibraryOnce(crashing);
    assert.equal(resumed.outcome, 'succeeded');
    assert.deepEqual(t.source.fetches, ['R1:v1', 'R2:v1', 'R3:v1'], 'R1 is not fetched twice after resume');
    const s = await syncRunSummary(t.pool, resumed.syncRunId!);
    assert.deepEqual(s.outcomes, { new_document: 3 });
    assert.equal(lost.jobId, resumed.jobId, 'the same durable job resumed');

    t.source.discoverFails = 10;
    await enqueueLibrarySync(t.pool, t.sourceId, { maxAttempts: 2 });
    const outcomes = await t.drain();
    assert.deepEqual(outcomes.map(o => o.outcome), ['retry_scheduled', 'failed']);
    const job = (await t.pool.query('SELECT state,error_code FROM bb_jobs WHERE id=$1', [outcomes[0]!.jobId])).rows[0];
    assert.deepEqual(job, { state: 'failed', error_code: 'LIBRARY_SOURCE_UNREACHABLE' });
    const errors = (await t.pool.query("SELECT recovery_status FROM bb_observability_errors WHERE job_id=$1 ORDER BY created_at", [outcomes[0]!.jobId])).rows.map(r => r.recovery_status);
    assert.deepEqual(errors, ['retry_scheduled', 'terminal']);
  } finally { await t.pool.end(); }
});

test('unreviewed or unlicensed data is never selectable; publish is atomic across body, profile and index', { skip }, async () => {
  const t = await setup('evaluation_only');
  try {
    t.source.add('P', 1, 'p1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const v = await t.versionOf('P', 1);
    assert.equal(v.state, 'pending_review');
    assert.equal((await t.query()).status, 'no_match', 'pending review is not selectable');
    const before = (await t.pool.query('SELECT release_no FROM bb_library_index_releases WHERE active')).rows[0].release_no;
    const published = await t.approve(v.id);
    assert.equal(published.status, 'published');
    const after = (await t.pool.query('SELECT id, release_no FROM bb_library_index_releases WHERE active')).rows[0];
    assert.equal(Number(after.release_no), Number(before) + 1);
    const entry = (await t.pool.query('SELECT e.*, p.state AS p_state FROM bb_library_index_entries e JOIN bb_library_profiles p ON p.id=e.profile_id WHERE e.release_id=$1 AND e.document_version_id=$2', [after.id, v.id])).rows[0];
    assert.equal(entry.p_state, 'published');
    assert.equal((await t.query()).status, 'no_match', 'evaluation_only source rights are not usage rights');
    await setLibrarySourceRights(t.pool, t.sourceId, 'commercial_licensed', 'licence_recorded', 'operator-syn');
    const hit = await t.query(['BIZ.PROPERTY', 'BIZ.WATER', 'BIZ.CONSTRUCTION']);
    assert.equal(hit.status, 'candidates', 'order-free set match');
    assert.equal(hit.candidates[0]!.document_version_id, v.id);
    assert.equal(JSON.stringify(hit).includes('Synthetic Issuer'), false, 'no issuer facts in the query response');
    assert.equal(JSON.stringify(hit).includes('"revenue"'), false, 'no revenue values in the query response');
    assert.equal((await t.query(['BIZ.WATER', 'BIZ.CONSTRUCTION', 'BIZ.OTHER'])).status, 'no_match', 'two of three is not a match');
    assert.equal((await t.query(TOP3, {}, 'some-old-release')).status, 'index_version_mismatch');

    // Body and index can never be one new and one old: direct state edits without a release fail at commit.
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE bb_library_document_versions SET state='withdrawn',state_reason='bypass_attempt',state_actor='x',state_changed_at=clock_timestamp() WHERE id=$1", [v.id]);
      await assert.rejects(client.query('COMMIT'), /inconsistent/);
    } finally { client.release(); }
    await assert.rejects(t.pool.query("UPDATE bb_library_index_entries SET review_quality=1 WHERE document_version_id=$1", [v.id]), /append-only/);
    await assert.rejects(t.pool.query("UPDATE bb_library_document_versions SET sha256=repeat('0',64) WHERE id=$1", [v.id]), /immutable/);
    const audit = (await t.pool.query("SELECT to_state, reason, actor FROM bb_library_audit WHERE subject_type='document_version' AND subject_id=$1 ORDER BY id", [v.id])).rows;
    assert.deepEqual(audit.map(a => a.to_state), ['pending_parse', 'pending_classify', 'pending_review', 'published']);
    assert.equal(audit.at(-1).actor, 'operator-syn');
  } finally { await t.pool.end(); }
});

test('conservative classifier leaves the business profile incomplete; approval needs an evidenced operator correction', { skip }, async () => {
  const t = await setup();
  try {
    t.deps.classifier = conservativeClassifier;
    t.source.add('K', 1, 'k1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const v = await t.versionOf('K', 1);
    assert.deepEqual([v.market, v.offering, v.instrument, v.document_stage], ['sse', 'public', 'corporate_bond', 'registration']);
    await assert.rejects(t.approve(v.id), /evidenced consolidated top-three/);
    const corrected = await reviewLibraryVersion(t.pool, v.id, { action: 'correct', reason: 'operator_profile_entry', correction: { fiscal_year: 2025, taxonomy_version: t.taxonomy, top3: lines(TOP3) } }, 'operator-syn');
    assert.equal(corrected.status, 'corrected');
    assert.equal((await t.approve(v.id)).status, 'published');
    const profiles = (await t.pool.query('SELECT profile_version, origin, completeness, state FROM bb_library_profiles WHERE document_version_id=$1 ORDER BY profile_version', [v.id])).rows;
    assert.deepEqual(profiles.map(p => [p.profile_version, p.origin, p.completeness, p.state]), [[1, 'classifier', 'incomplete', 'superseded'], [2, 'operator_correction', 'complete', 'published']]);
    // Operator per-record re-run of a failed version goes through the same pipeline.
    t.source.add('F', 1, 'f1');
    const failingParser: LibraryParser = async () => { throw new Error('synthetic parser crash'); };
    t.deps.parser = failingParser;
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    assert.equal((await t.versionOf('F', 1)).state, 'failed');
    assert.ok((await libraryAlerts(t.pool)).some(a => a.kind === 'items_failed'));
    // Regression (found by the live SSE run): a newer revision must retire a failed older one.
    t.source.add('H', 1, 'h1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    assert.equal((await t.versionOf('H', 1)).state, 'failed');
    t.deps.parser = syntheticParser; t.deps.classifier = syntheticClassifier(t.taxonomy);
    t.source.add('H', 2, 'h2');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    assert.deepEqual([(await t.versionOf('H', 1)).state, (await t.versionOf('H', 2)).state], ['superseded', 'pending_review']);
    await enqueueLibraryRecordRerun(t.pool, (await t.versionOf('F', 1)).id, 'operator-syn');
    await t.drain();
    assert.equal((await t.versionOf('F', 1)).state, 'pending_review');
  } finally { await t.pool.end(); }
});

test('a third-business ranking change appends a new profile version; an identical ranking does not', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('G', 1, 'g1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const v = await t.versionOf('G', 1);
    const same = await reclassifyPendingProfile(t.pool, v.id, draft(TOP3, t.taxonomy));
    assert.equal(same.created, false);
    const swapped = await reclassifyPendingProfile(t.pool, v.id, draft(['BIZ.WATER', 'BIZ.PROPERTY', 'BIZ.CONSTRUCTION'], t.taxonomy));
    assert.equal(swapped.created, true);
    const profiles = (await t.pool.query('SELECT profile_version, state, state_reason, set_key FROM bb_library_profiles WHERE document_version_id=$1 ORDER BY profile_version', [v.id])).rows;
    assert.deepEqual(profiles.map(p => [p.profile_version, p.state]), [[1, 'superseded'], [2, 'pending_review']]);
    assert.equal(profiles[1].state_reason, 'ranking_changed');
    assert.equal(profiles[0].set_key, profiles[1].set_key, 'same set, different ranking');
    await assert.rejects(t.pool.query("UPDATE bb_library_profiles SET top3='[]'::jsonb WHERE id=$1", [swapped.profileId]), /immutable/);
    const open = (await t.pool.query("SELECT profile_id FROM bb_library_review_items WHERE document_version_id=$1 AND state='open'", [v.id])).rows;
    assert.deepEqual(open.map(r => r.profile_id), [swapped.profileId], 'review follows the newest profile');
  } finally { await t.pool.end(); }
});

test('late old revisions never overwrite a newer published version', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('L', 1, 'l1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const v1 = await t.versionOf('L', 1);
    t.source.add('L', 2, 'l2');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const v2 = await t.versionOf('L', 2);
    assert.equal((await t.versionOf('L', 1)).state, 'superseded');
    assert.equal((await t.approve(v2.id)).status, 'published');
    // A late job delivers a different byte stream for revision 1: kept for audit, immediately superseded.
    const late = await ingestLibraryVersion(t.pool, t.blobs, { sourceId: t.sourceId, externalKey: 'L', issuerKey: 'issuer-L', issuerName: 'x', title: 'x', sourceRevision: '1b',
      sourceRevisionRank: 1, bytes: Buffer.from('%PDF-1.7 late old bytes'), mediaType: 'application/pdf' });
    assert.equal(late.outcome, 'stale_ignored');
    assert.equal((await t.pool.query('SELECT state, state_reason FROM bb_library_document_versions WHERE id=$1', [late.versionId])).rows[0].state_reason, 'stale_late_revision');
    // Approving the old one late cannot win either (it is not pending anymore).
    await assert.rejects(t.approve(v1.id), /pending review/);
    const hit = await t.query();
    assert.deepEqual(hit.candidates.map(c => c.document_version_id), [v2.id]);
  } finally { await t.pool.end(); }
});

test('withdraw leaves new matching at once (cache invalidated); locks stay traceable; revoked rights re-checked on read', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('W', 1, 'w1'); t.source.add('X', 1, 'x1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const w = await t.versionOf('W', 1), x = await t.versionOf('X', 1);
    await t.approve(w.id); await t.approve(x.id);
    const hit = await t.query();
    assert.equal(hit.candidates.length, 2);
    assert.ok(libraryCacheSize() > 0);
    const cand = hit.candidates.find(c => c.document_version_id === w.id)!;
    const lock = await lockReferenceSelection(t.pool, { ownerUserId: t.owner, projectId: t.project, documentVersionId: w.id, profileId: cand.profile_id, indexReleaseId: hit.index_release!.release_id });
    const read1 = await readLockedReference(t.pool, t.blobs, t.owner, t.project, lock.lock_id);
    assert.equal(read1.access, 'granted'); assert.ok(read1.bytes?.toString().includes('w1'));
    await assert.rejects(readLockedReference(t.pool, t.blobs, 'someone-else', t.project, lock.lock_id), /does not exist/);

    await reviewLibraryVersion(t.pool, w.id, { action: 'withdraw', reason: 'issuer_withdrew_filing' }, 'operator-syn');
    const after = await t.query();
    assert.deepEqual(after.candidates.map(c => c.document_version_id), [x.id], 'withdrawn version leaves new matching immediately');
    await assert.rejects(lockReferenceSelection(t.pool, { ownerUserId: t.owner, projectId: t.project, documentVersionId: w.id, profileId: cand.profile_id, indexReleaseId: hit.index_release!.release_id }), /no longer selectable/);
    const read2 = await readLockedReference(t.pool, t.blobs, t.owner, t.project, lock.lock_id);
    assert.equal(read2.access, 'denied'); assert.equal(read2.lock.document_version_id, w.id, 'lock still traceable'); assert.equal(read2.bytes, null);

    // Source licence revoked: remaining published versions leave the index; locked reads are refused.
    const xLock = await lockReferenceSelection(t.pool, { ownerUserId: t.owner, projectId: t.project, documentVersionId: x.id, profileId: after.candidates[0]!.profile_id, indexReleaseId: after.index_release!.release_id });
    await setLibrarySourceRights(t.pool, t.sourceId, 'revoked', 'licence_terminated', 'operator-syn');
    assert.equal((await t.query()).status, 'no_match');
    assert.equal((await t.versionOf('X', 1)).state, 'license_revoked');
    const read3 = await readLockedReference(t.pool, t.blobs, t.owner, t.project, xLock.lock_id);
    assert.deepEqual([read3.access, read3.reason], ['denied', 'source_rights_not_current']);
    await assert.rejects(setLibrarySourceRights(t.pool, t.sourceId, 'commercial_licensed', 'try_again', 'operator-syn'), /new source registration/);
  } finally { await t.pool.end(); }
});

test('a later expansion never rewrites a lock; rollback restores index and body together', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('Y', 1, 'y1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const y1 = await t.versionOf('Y', 1);
    const rel1 = await t.approve(y1.id) as { release_id: string };
    const hit = await t.query();
    const lock = await lockReferenceSelection(t.pool, { ownerUserId: t.owner, projectId: t.project, documentVersionId: y1.id, profileId: hit.candidates[0]!.profile_id, indexReleaseId: rel1.release_id });
    t.source.add('Y', 2, 'y2'); t.source.add('Z', 1, 'z1');
    await enqueueLibrarySync(t.pool, t.sourceId); await t.drain();
    const y2 = await t.versionOf('Y', 2), z1 = await t.versionOf('Z', 1);
    await t.approve(y2.id); await t.approve(z1.id);
    assert.equal((await t.versionOf('Y', 1)).state, 'superseded');
    const lockRow = (await t.pool.query('SELECT document_version_id, index_release_id FROM bb_library_selection_locks WHERE id=$1', [lock.lock_id])).rows[0];
    assert.deepEqual(lockRow, { document_version_id: y1.id, index_release_id: rel1.release_id }, 'lock not rewritten');
    const locked = await readLockedReference(t.pool, t.blobs, t.owner, t.project, lock.lock_id);
    assert.equal(locked.access, 'granted'); assert.ok(locked.bytes?.toString().includes('y1'), 'locked task keeps reading the version it selected');

    const rolled = await rollbackLibraryRelease(t.pool, rel1.release_id, 'bad_release_rollback', 'operator-syn');
    assert.equal(rolled.status, 'rolled_back');
    assert.equal((await t.versionOf('Y', 1)).state, 'published');
    assert.equal((await t.versionOf('Y', 2)).state, 'rolled_back');
    assert.equal((await t.versionOf('Z', 1)).state, 'rolled_back');
    const active = (await t.pool.query('SELECT id FROM bb_library_index_releases WHERE active')).rows[0].id;
    const entries = (await t.pool.query(`SELECT e.document_version_id, v.state, p.state AS p_state FROM bb_library_index_entries e JOIN bb_library_document_versions v ON v.id=e.document_version_id
      JOIN bb_library_profiles p ON p.id=e.profile_id JOIN bb_library_documents d ON d.id=e.document_id WHERE e.release_id=$1 AND d.source_id=$2`, [active, t.sourceId])).rows;
    assert.deepEqual(entries, [{ document_version_id: y1.id, state: 'published', p_state: 'published' }], 'index and body agree after rollback');
    assert.deepEqual((await t.query()).candidates.map(c => c.document_version_id), [y1.id]);
    const overview = await libraryOverview(t.pool);
    assert.equal(overview.active_release.release_id, active);
    invalidateLibraryCache();
  } finally { await t.pool.end(); }
});

test('personal uploads cannot enter the library: blob keys must be library/ and nothing references user materials', { skip }, async () => {
  const t = await setup();
  try {
    const doc = (await t.pool.query("INSERT INTO bb_library_documents(id,source_id,external_key,issuer_key,issuer_name,title) VALUES($1,$2,'u','u','u','u') RETURNING id", [randomUUID(), t.sourceId])).rows[0].id;
    await assert.rejects(t.pool.query(`INSERT INTO bb_library_document_versions(id,document_id,version,source_revision,source_revision_rank,sha256,byte_size,media_type,blob_key,state_reason,state_actor)
      VALUES($1,$2,1,'1',1,$3,10,'application/pdf',$4,'ingested','x')`, [randomUUID(), doc, sha(Buffer.from('u')), `users/${t.owner}/projects/${t.project}/materials/m1`]), /check constraint/);
    const fks = (await t.pool.query(`SELECT count(*)::int n FROM information_schema.constraint_column_usage u JOIN information_schema.table_constraints c ON c.constraint_name=u.constraint_name
      WHERE c.table_name LIKE 'bb_library_%' AND u.table_name IN ('bb_material_versions','bb_uploads')`)).rows[0].n;
    assert.equal(fks, 0);
    // Operator import shares the pipeline and reads only its own staging prefix.
    const importer = new OperatorImportAdapter(t.blobs);
    await assert.rejects(importer.fetch({ locator: `users/${t.owner}/x`, itemKey: 'i' } as DiscoveredItem), /LIBRARY_FETCH_FAILED/);
    // A pending version cannot be approved into the index via reclassify/classify helpers.
    const ingested = await ingestLibraryVersion(t.pool, t.blobs, { sourceId: t.sourceId, externalKey: 'Q', issuerKey: 'q', issuerName: 'q', title: 'q', sourceRevision: '1', sourceRevisionRank: 1, bytes: Buffer.from('%PDF q'), mediaType: 'application/pdf' });
    await markLibraryVersionParsed(t.pool, ingested.versionId, { synthetic: true });
    await classifyLibraryVersion(t.pool, ingested.versionId, { market: 'sse', offering: 'public', instrument: 'corporate_bond', documentStage: 'registration' }, draft(TOP3, t.taxonomy));
    assert.equal((await t.pool.query('SELECT state FROM bb_library_document_versions WHERE id=$1', [ingested.versionId])).rows[0].state, 'pending_review');
    assert.ok(t.blobs.keys().every(k => k.startsWith('library/')));
  } finally { await t.pool.end(); }
});

test('SSE adapter maps project list and prospectus files (recorded synthetic responses; no network)', async () => {
  const calls: string[] = [];
  const fake = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const json = u.searchParams.get('sqlId') === 'ZQ_XMLB'
      ? { pageHelp: { data: u.searchParams.get('pageHelp.pageNo') === '1' ? [
        { BOND_NUM: 'p-new', PUBLISH_DATE: '2026-09-24', ISSUER_ID: '91000000000000000X', FULL_NAME: '合成发行人A有限公司', AUDIT_NAME: '合成发行人A有限公司2026年面向专业投资者公开发行公司债券' },
        { BOND_NUM: 'p-old', PUBLISH_DATE: '2026-09-01', ISSUER_ID: '91000000000000001X', FULL_NAME: '合成发行人B有限公司', AUDIT_NAME: 'B' }] : [] } }
      : { result: [
        { FILE_TYPE: 11, FILE_VERSION: 2, FILE_TITLE: '1-1 合成募集说明书-2.pdf', FILE_PATH: '/bridge2/disclosure/announcement/c/202609/x2.pdf', FILE_TIME: '2026-09-24' },
        { FILE_TYPE: 11, FILE_VERSION: 1, FILE_TITLE: '1-1 合成募集说明书-1.pdf', FILE_PATH: '/bridge2/disclosure/announcement/c/202608/x1.pdf', FILE_TIME: '2026-08-01' },
        { FILE_TYPE: 31, FILE_VERSION: 1, FILE_TITLE: '3-1 主承销商核查意见.pdf', FILE_PATH: '/bridge2/y.pdf', FILE_TIME: '2026-08-01' }] };
    return { ok: true, status: 200, json: async () => json, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 synthetic').buffer as ArrayBuffer };
  };
  const adapter = new SseBondProjectAdapter({ fetch: fake, delayMs: 0, maxProjects: 5 });
  const d = await adapter.discover({ publish_date: '2026-09-10' }, {});
  assert.deepEqual(d.items.map(i => i.itemKey), ['p-new:x1', 'p-new:x2'], 'ordered by (FILE_TIME, FILE_VERSION); older-than-cursor projects and non-prospectus files skipped');
  assert.deepEqual(d.cursorAfter, { publish_date: '2026-09-24' });
  assert.equal(d.items[0]!.issuerKey, '91000000000000000X', 'issuer identity is the credit code, so same-name issuers are not merged');
  assert.ok((await adapter.fetch(d.items[0]!)).subarray(0, 5).equals(Buffer.from('%PDF-')));
  await assert.rejects(adapter.fetch({ ...d.items[0]!, locator: 'https://evil.example/x.pdf' }), /LIBRARY_FETCH_FAILED/);
  assert.ok(calls.every(c => c.startsWith('https://query.sse.com.cn/') || c.startsWith('https://static.sse.com.cn/bond/')));
});

test('Azurite-backed ingest stores bytes under library/ and verifies the hash on read', { skip: skip || !process.env.BB_TEST_AZURITE_CONNECTION_STRING }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    const blobs = azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING!, `bb-library-${randomUUID()}`);
    const sourceId = `syn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await registerLibrarySource(pool, { id: sourceId, kind: 'public_disclosure', displayName: 's', market: 'sse', authorizationBasis: 'synthetic', usageRights: 'evaluation_only' });
    const bytes = Buffer.from('%PDF-1.7 azurite synthetic');
    const first = await ingestLibraryVersion(pool, blobs, { sourceId, externalKey: 'az', issuerKey: 'az', issuerName: 'az', title: 'az', sourceRevision: '1', sourceRevisionRank: 1, bytes, mediaType: 'application/pdf' });
    const again = await ingestLibraryVersion(pool, blobs, { sourceId, externalKey: 'az', issuerKey: 'az', issuerName: 'az', title: 'az', sourceRevision: '1', sourceRevisionRank: 1, bytes, mediaType: 'application/pdf' });
    assert.equal(first.outcome, 'new_document'); assert.equal(again.outcome, 'unchanged'); assert.equal(again.versionId, first.versionId);
    const row = (await pool.query('SELECT blob_key, sha256 FROM bb_library_document_versions WHERE id=$1', [first.versionId])).rows[0];
    assert.equal(row.blob_key, `library/${sourceId}/${createHash('sha256').update(`${sourceId}\u0000az`).digest('hex').slice(0, 32)}/${sha(bytes)}`);
    assert.ok((await blobs.get(row.blob_key)).equals(bytes));
  } finally { await pool.end(); }
});
