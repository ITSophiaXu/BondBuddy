import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Problem, type PrivateBlobs } from '@bondbuddy/api/data';
import { libraryOverview, queryReferenceLibrary, registerLibrarySource, reviewLibraryVersion } from '@bondbuddy/api/library';
import type { LibraryParser, LibraryClassifier } from './library-pipeline.js';
import { checkStaleLibrarySources, claimDueLibrarySources, runLibrarySyncPass } from './library-scheduler.js';
import { SourceError, type DiscoveredItem, type LibrarySourceAdapter } from './library-sources.js';
import { OpsScheduler, tasksFromEnv } from './ops-scheduler.js';
import { isolatedTestDatabase } from './test-database.js';

// #78 scheduled sync on the ops scheduler. Everything is synthetic (fake source, parser, issuers, revenue);
// it proves scheduling/lease/resume/alert mechanics, not any real source's availability.
const connection = await isolatedTestDatabase();
const skip = !connection;

function memoryBlobs(): PrivateBlobs {
  const store = new Map<string, Buffer>();
  return {
    async put(key, bytes) { store.set(key, Buffer.from(bytes)); },
    async get(key) { const v = store.get(key); if (!v) throw new Error('missing'); return v; },
    async getIfExists(key) { return store.get(key) ?? null; },
    async getIfExistsBounded(key, max) { const v = store.get(key); return v && v.length <= max ? v : null; },
    async exists(key) { return store.has(key); },
    async delete(key) { store.delete(key); },
  };
}
const parser: LibraryParser = async request => ({
  schema_version: 'document-parse-response-v1', request_id: request.request_id, parser_version: 'synthetic-parser', status: 'parsed',
  material: { material_id: request.material.material_id, material_version: request.material.material_version, media_type: request.material.media_type, sha256: request.material.sha256 },
  records: [{ record_id: 'r1', material_id: request.material.material_id, material_version: request.material.material_version, content_hash: request.material.sha256, locator_type: 'text_line',
    locator: { line: 1 }, literal_quote: 'synthetic', context: 'synthetic', extraction_method: 'native_text', extractor_version: 'synthetic', confidence: 1, uncertainty: [], formatting: {} }],
  warnings: [], document: { page_count: 1 }, error: null,
});
const TOP3 = ['BIZ.WATER', 'BIZ.CONSTRUCTION', 'BIZ.PROPERTY'];
const classifier = (taxonomy: string): LibraryClassifier => () => ({
  classification: { market: 'sse', offering: 'public', instrument: 'corporate_bond', documentStage: 'registration' },
  profile: { fiscalYear: 2025, taxonomyVersion: taxonomy, accountingScope: 'consolidated', revenueBasis: 'operating_revenue', currency: 'CNY', unit: 'ten_thousand_yuan',
    top3: TOP3.map((code, i) => ({ code, label: code, rank: i + 1, revenue: String(300 - i * 100), evidence: [`p${i}`] })) },
});

class FakeSource implements LibrarySourceAdapter {
  readonly mode = 'scheduled' as const;
  items: DiscoveredItem[] = [];
  discovers = 0; fetches: string[] = []; discoverFails = 0;
  constructor(readonly sourceId: string) {}
  add(key: string) {
    this.items.push({ itemKey: `${key}:v1`, externalKey: key, issuerKey: `issuer-${key}`, issuerName: `Synthetic Issuer ${key}`, title: `Synthetic ${key} 公司债券募集说明书`,
      sourceRevision: '1', sourceRevisionRank: 1, mediaType: 'application/pdf', sourceUrl: null, disclosedAt: '2026-09-20', market: 'sse', locator: key });
  }
  async discover(cursor: Record<string, unknown>) {
    this.discovers++;
    if (this.discoverFails > 0) { this.discoverFails--; throw new SourceError('LIBRARY_SOURCE_UNREACHABLE', false); }
    const from = Number(cursor.seen ?? 0);
    return { items: this.items.slice(from), cursorAfter: { seen: this.items.length } };
  }
  async fetch(item: DiscoveredItem) { this.fetches.push(item.itemKey); return Buffer.from(`%PDF-1.7 synthetic ${item.locator}`); }
}

async function setup(rights: 'commercial_licensed' | 'evaluation_only' = 'commercial_licensed', intervalSeconds = 3600) {
  const pool = new Pool({ connectionString: connection, max: 4 });
  const sourceId = `sched_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await registerLibrarySource(pool, { id: sourceId, kind: 'public_disclosure', displayName: 'Synthetic scheduled source', market: 'sse', authorizationBasis: 'synthetic test fixture',
    usageRights: rights, syncIntervalSeconds: intervalSeconds });
  const source = new FakeSource(sourceId);
  const taxonomy = `tax-${sourceId}`;
  const deps = { pool, blobs: memoryBlobs(), adapters: { [sourceId]: source } as Record<string, LibrarySourceAdapter>, parser, classifier: classifier(taxonomy), retryDelayMs: 1, jitter: 0 };
  const row = async () => (await pool.query('SELECT * FROM bb_library_sources WHERE id=$1', [sourceId])).rows[0];
  const alerts = async (kind: string) => (await pool.query('SELECT * FROM bb_ops_alerts WHERE kind=$1 AND detail->>\'source_id\'=$2', [kind, sourceId])).rows;
  return { pool, sourceId, source, taxonomy, deps, row, alerts };
}

test('env wiring: library_sync is opt-in and needs blob storage', () => {
  const pool = {} as Pool;
  const base = { BB_TRIAL_GUARD: 'off', BB_OPS_LOG_HEALTH: 'off', BB_OPS_TRIAL_HEALTH: 'off', BB_OPS_WORKER_HEARTBEAT: 'off', BB_OPS_BACKUP_RETENTION: 'off' } as NodeJS.ProcessEnv;
  assert.deepEqual(tasksFromEnv(pool, base).map(t => t.name), []);
  assert.throws(() => tasksFromEnv(pool, { ...base, BB_OPS_LIBRARY_SYNC: 'on' }), /AZURE_STORAGE_CONNECTION_STRING/);
  const tasks = tasksFromEnv(pool, { ...base, BB_OPS_LIBRARY_SYNC: 'on', AZURE_STORAGE_CONNECTION_STRING: 'synthetic' }, () => memoryBlobs(), undefined, () => ({}));
  assert.deepEqual(tasks.map(t => [t.name, t.intervalMs, t.leaseMs]), [['library_sync', 60_000, 1_800_000]]);
});

test('two scheduler instances sync a due source exactly once, then wait for the per-source interval', { skip }, async () => {
  const t = await setup();
  const other = new Pool({ connectionString: connection, max: 4 });
  try {
    t.source.add('A'); t.source.add('B');
    // Source claim is exclusive even when both instances race on the same due row.
    const [x, y] = await Promise.all([claimDueLibrarySources(t.pool, 'inst-a'), claimDueLibrarySources(other, 'inst-b')]);
    assert.equal([...x, ...y].filter(r => r.id === t.sourceId).length, 1);
    await t.pool.query('UPDATE bb_library_sources SET sync_lease_owner=NULL,sync_lease_until=NULL WHERE id=$1', [t.sourceId]);
    await t.pool.query("DELETE FROM bb_ops_schedule WHERE task='library_sync'");

    const task = (pool: Pool, owner: string) => ({ name: 'library_sync' as const, intervalMs: 60_000, leaseMs: 60_000,
      run: async () => ({ ok: true, detail: { ...(await runLibrarySyncPass({ ...t.deps, pool, owner })) } }) });
    const a = new OpsScheduler({ pool: t.pool, tasks: [task(t.pool, 'inst-a')], owner: 'inst-a', jitter: 0 });
    const b = new OpsScheduler({ pool: other, tasks: [task(other, 'inst-b')], owner: 'inst-b', jitter: 0 });
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    const jobs = (await t.pool.query("SELECT state FROM bb_jobs WHERE job_type='library' AND library_source_id=$1", [t.sourceId])).rows;
    assert.deepEqual(jobs.map(j => j.state), ['succeeded']);
    assert.equal(t.source.discovers, 1);
    assert.deepEqual(t.source.fetches.sort(), ['A:v1', 'B:v1']);
    const src = await t.row();
    assert.ok(src.last_success_at); assert.equal(src.consecutive_failures, 0); assert.equal(src.sync_lease_owner, null);
    assert.ok(new Date(src.next_sync_due_at).getTime() > Date.now() + 3500_000, 'next run is one interval out');

    // Not yet due: even with the ops task due again nothing is enqueued.
    const again = await runLibrarySyncPass({ ...t.deps, owner: 'inst-a' });
    assert.equal(again.claimed, 0);
    // Due again: the incremental cursor means only the new item is fetched; the unchanged ones are not re-ingested.
    t.source.add('C');
    await t.pool.query("UPDATE bb_library_sources SET next_sync_due_at=now()-interval '1 second' WHERE id=$1", [t.sourceId]);
    const third = await runLibrarySyncPass({ ...t.deps, owner: 'inst-b' });
    assert.equal(third.enqueued, 1);
    assert.deepEqual(t.source.fetches.sort(), ['A:v1', 'B:v1', 'C:v1']);
    assert.equal((await t.pool.query('SELECT count(*)::int n FROM bb_library_documents WHERE source_id=$1', [t.sourceId])).rows[0].n, 3);

    const overview = (await libraryOverview(t.pool)).sources.find(s => s.source_id === t.sourceId)!;
    assert.equal(overview.sync_interval_seconds, 3600); assert.equal(overview.consecutive_failures, 0); assert.ok(overview.next_sync_due_at); assert.ok(overview.last_success_at);
  } finally { await other.end(); await t.pool.end(); }
});

test('a crashed sync is re-claimed after its lease expires and resumes after the last checkpointed item', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('A'); t.source.add('B'); t.source.add('C');
    // Instance A "crashes" after the first item: its job stays running with an expired lease and no further writes.
    const crashed = await runLibrarySyncPass({ ...t.deps, owner: 'inst-a', maxJobs: 1, afterItem: async (index, _item, lease) => {
      if (index !== 0) return;
      await t.pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.jobId]);
      throw new Problem(409, 'ALREADY_TERMINAL', 'simulated crash');
    } });
    assert.equal(crashed.lost, 1);
    assert.deepEqual(t.source.fetches, ['A:v1']);
    assert.equal((await t.pool.query("SELECT state FROM bb_jobs WHERE job_type='library' AND library_source_id=$1", [t.sourceId])).rows[0].state, 'running');
    assert.equal((await t.row()).last_success_at, null);

    const resumed = await runLibrarySyncPass({ ...t.deps, owner: 'inst-b' });
    assert.equal(resumed.claimed, 0, 'the source is not due again; only the orphaned job is recovered');
    assert.equal(resumed.jobs, 1);
    assert.deepEqual(t.source.fetches, ['A:v1', 'B:v1', 'C:v1'], 'item A is not fetched twice');
    assert.equal(t.source.discovers, 1, 'discovery is checkpointed too');
    assert.ok((await t.row()).last_success_at);
    assert.equal((await t.pool.query('SELECT count(*)::int n FROM bb_library_documents WHERE source_id=$1', [t.sourceId])).rows[0].n, 3);
  } finally { await t.pool.end(); }
});

test('failures raise deduplicated library_sync_failed; no success for N x interval raises one library_source_stale', { skip }, async () => {
  const t = await setup('commercial_licensed', 600);
  try {
    t.source.discoverFails = 2;
    await runLibrarySyncPass({ ...t.deps, owner: 'inst-a' });
    let src = await t.row();
    assert.equal(src.consecutive_failures, 1); assert.equal(src.last_error_code, 'LIBRARY_SOURCE_UNREACHABLE');
    await t.pool.query("UPDATE bb_library_sources SET next_sync_due_at=now()-interval '1 second' WHERE id=$1", [t.sourceId]);
    await runLibrarySyncPass({ ...t.deps, owner: 'inst-a' });
    src = await t.row();
    assert.equal(src.consecutive_failures, 2);
    const failed = await t.alerts('library_sync_failed');
    assert.equal(failed.length, 1, 'repeat failures within the bucket keep one alert');
    assert.equal(failed[0].severity, 'critical');

    assert.deepEqual(await t.alerts('library_source_stale'), [], 'a freshly registered source is not stale yet');
    await t.pool.query("UPDATE bb_library_sources SET created_at=now()-interval '21 minutes' WHERE id=$1", [t.sourceId]);
    assert.ok((await checkStaleLibrarySources(t.pool, 2)).includes(t.sourceId));
    await checkStaleLibrarySources(t.pool, 2);
    const stale = await t.alerts('library_source_stale');
    assert.equal(stale.length, 1, 'stale alert is deduplicated');
    assert.equal(stale[0].detail.threshold_seconds, 1200); assert.equal(stale[0].detail.never_succeeded, 1);

    // Recovery: a full success resets the failure counter and clears staleness.
    await t.pool.query("UPDATE bb_library_sources SET next_sync_due_at=now()-interval '1 second' WHERE id=$1", [t.sourceId]);
    t.source.add('A');
    await runLibrarySyncPass({ ...t.deps, owner: 'inst-a' });
    src = await t.row();
    assert.equal(src.consecutive_failures, 0); assert.equal(src.last_error_code, null);
    assert.equal((await checkStaleLibrarySources(t.pool, 2)).includes(t.sourceId), false);
  } finally { await t.pool.end(); }
});

test('evaluation_only sources sync and can be reviewed for evaluation, but nothing from them becomes selectable', { skip }, async () => {
  const t = await setup('evaluation_only');
  try {
    t.source.add('E');
    const pass = await runLibrarySyncPass({ ...t.deps, owner: 'inst-a' });
    assert.equal(pass.enqueued, 1);
    const v = (await t.pool.query(`SELECT v.id, v.state FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1`, [t.sourceId])).rows[0];
    assert.equal(v.state, 'pending_review');
    await reviewLibraryVersion(t.pool, v.id, { action: 'approve', reason: 'synthetic_review_ok', review_quality: 80 }, 'operator-syn');
    const owner = `sched-owner-${randomUUID()}`, project = `sched-project-${randomUUID()}`;
    await t.pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)', [project, owner, 'Synthetic consumer', 'generation']);
    const result = await queryReferenceLibrary(t.pool, { schema_version: 'reference-library-query-v1', service_identity: 'task_service',
      audit: { owner_user_id: owner, project_id: project, run_id: null, trace_id: 'trace-sched' },
      target: { top3_codes: TOP3, taxonomy_version: t.taxonomy, fiscal_year: 2025, evidence_refs: ['fact-1'], market: 'sse', offering: 'public', instrument: 'corporate_bond', document_stage: 'registration', rule_version: 'rule-syn' },
      index_release: null });
    assert.equal(result.status, 'no_match', 'evaluation_only rights never reach task selection');
    assert.equal(JSON.stringify(result).includes(v.id), false);
  } finally { await t.pool.end(); }
});
