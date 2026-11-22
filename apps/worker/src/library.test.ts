import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import {
  classifyLibraryVersion,
  enqueueLibraryRecordRerun,
  enqueueLibrarySync,
  ingestLibraryVersion,
  invalidateLibraryCache,
  libraryAlerts,
  libraryCacheSize,
  libraryOverview,
  lockReferenceSelection,
  markLibraryVersionParsed,
  queryReferenceLibrary,
  readLockedReference,
  reclassifyPendingProfile,
  registerLibrarySource,
  reviewLibraryVersion,
  recordChapterMappingVersion,
  rollbackLibraryRelease,
  setLibrarySourceRights,
  syncRunSummary,
  withdrawChapterMappingVersion,
  type ProfileDraft,
  type ProfileLine,
  libraryProfileContentHash,
  persistLibraryRevenueRankProof,
} from '@bondbuddy/api/library';
import { Ajv } from 'ajv';
import {
  LibraryQueryResponseV1_1Schema,
  LibraryQueryResponseV1Schema,
  type LibraryCandidateV1_1,
  type LibraryQueryRequest,
  type LibraryQueryResponseV1_1,
  type LibraryRevenueRankProof,
} from '@bondbuddy/contracts';
import {
  conservativeClassifier,
  runLibraryOnce,
  type LibraryClassifier,
  type LibraryParser,
  type LibraryPipelineDependencies,
} from './library-pipeline.js';
import {
  OperatorImportAdapter,
  OPERATOR_IMPORT_SOURCE,
  SourceError,
  SseBondProjectAdapter,
  type DiscoveredItem,
  type LibrarySourceAdapter,
} from './library-sources.js';
import { isolatedTestDatabase } from './test-database.js';

// Everything here is synthetic: fake source, fake parser output, fake issuers and revenue lines.
// It proves the #78 library mechanics; it is not evidence about any real prospectus.
const connection = await isolatedTestDatabase();
const skip = !connection;
const ajv = new Ajv({ strict: false });
const validV1 = ajv.compile(LibraryQueryResponseV1Schema),
  validV11 = ajv.compile(LibraryQueryResponseV1_1Schema);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function memoryBlobs(): PrivateBlobs & { keys(): string[] } {
  const store = new Map<string, Buffer>();
  return {
    async put(key, bytes) {
      store.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const v = store.get(key);
      if (!v) throw new Error('missing');
      return v;
    },
    async getIfExists(key) {
      return store.get(key) ?? null;
    },
    async getIfExistsBounded(key, max) {
      const v = store.get(key);
      return v && v.length <= max ? v : null;
    },
    async exists(key) {
      return store.has(key);
    },
    async delete(key) {
      store.delete(key);
    },
    keys: () => [...store.keys()],
  };
}

const syntheticParser: LibraryParser = async (request) => ({
  schema_version: 'document-parse-response-v1',
  request_id: request.request_id,
  parser_version: 'synthetic-parser',
  status: 'parsed',
  material: {
    material_id: request.material.material_id,
    material_version: request.material.material_version,
    media_type: request.material.media_type,
    sha256: request.material.sha256,
  },
  records: [
    {
      record_id: 'r1',
      material_id: request.material.material_id,
      material_version: request.material.material_version,
      content_hash: request.material.sha256,
      locator_type: 'text_line',
      locator: { line: 1 },
      literal_quote: 'synthetic revenue table',
      context: 'synthetic',
      extraction_method: 'native_text',
      extractor_version: 'synthetic',
      confidence: 1,
      uncertainty: [],
      formatting: {},
    },
  ],
  warnings: [],
  document: { page_count: 1 },
  error: null,
});

const lines = (codes: string[]): ProfileLine[] =>
  codes.map((code, i) => ({
    code,
    label: code,
    rank: i + 1,
    revenue: String(300 - i * 100),
    evidence: [`p${10 + i}`],
  }));
const draft = (
  codes: string[],
  taxonomy: string,
  revenueBasis: NonNullable<ProfileDraft['revenueBasis']> = 'main_business_revenue',
): ProfileDraft => ({
  fiscalYear: 2025,
  taxonomyVersion: taxonomy,
  accountingScope: 'consolidated',
  top3: lines(codes),
  revenueBasis,
  currency: 'CNY',
  unit: 'ten_thousand_yuan',
});
const TOP3 = ['BIZ.WATER', 'BIZ.CONSTRUCTION', 'BIZ.PROPERTY'];
const syntheticClassifier =
  (
    taxonomy: string,
    codes = TOP3,
    revenueBasis: NonNullable<ProfileDraft['revenueBasis']> = 'main_business_revenue',
  ): LibraryClassifier =>
  () => ({
    classification: {
      market: 'sse',
      offering: 'public',
      instrument: 'corporate_bond',
      documentStage: 'registration',
    },
    profile: draft(codes, taxonomy, revenueBasis),
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
    const item: DiscoveredItem = {
      itemKey: `${externalKey}:v${revision}`,
      externalKey,
      issuerKey,
      issuerName: `Synthetic Issuer ${externalKey}`,
      title: `Synthetic ${externalKey} 面向专业投资者公开发行公司债券募集说明书`,
      sourceRevision: String(revision),
      sourceRevisionRank: revision,
      mediaType: 'application/pdf',
      sourceUrl: null,
      disclosedAt: '2026-09-20',
      market: 'sse',
      locator: `${externalKey}:${revision}`,
    };
    this.items.push(item);
    this.bytes.set(item.locator, Buffer.from(`%PDF-1.7 synthetic ${content}`));
    return item;
  }
  async discover() {
    if (this.discoverFails > 0) {
      this.discoverFails--;
      throw new SourceError('LIBRARY_SOURCE_UNREACHABLE', true);
    }
    return { items: [...this.items], cursorAfter: { seen: this.items.length } };
  }
  async fetch(item: DiscoveredItem) {
    this.fetches.push(item.itemKey);
    const left = this.failuresLeft.get(item.itemKey) ?? 0;
    if (left > 0) {
      this.failuresLeft.set(item.itemKey, left - 1);
      throw new SourceError('LIBRARY_FETCH_FAILED', true);
    }
    return this.bytes.get(item.locator)!;
  }
}

async function setup(rights: 'commercial_licensed' | 'evaluation_only' = 'commercial_licensed') {
  const pool = new Pool({ connectionString: connection });
  const blobs = memoryBlobs();
  const sourceId = `syn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await registerLibrarySource(pool, {
    id: sourceId,
    kind: 'public_disclosure',
    displayName: 'Synthetic source',
    market: 'sse',
    authorizationBasis: 'synthetic test fixture',
    usageRights: rights,
  });
  const source = new FakeSource(sourceId);
  // A per-test taxonomy version keeps queries in this shared per-file database scoped to this test's rows.
  const taxonomy = `tax-${sourceId}`;
  const owner = `lib-owner-${randomUUID()}`,
    project = `lib-project-${randomUUID()}`;
  await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)', [
    project,
    owner,
    'Synthetic library consumer',
    'generation',
  ]);
  const deps: LibraryPipelineDependencies = {
    pool,
    blobs,
    adapters: { [sourceId]: source },
    parser: syntheticParser,
    classifier: syntheticClassifier(taxonomy),
    retryDelayMs: 1,
  };
  const query = (
    codes = TOP3,
    extra: Partial<LibraryQueryRequest['target']> = {},
    indexRelease: string | null = null,
    schemaVersion: LibraryQueryRequest['schema_version'] = 'reference-library-query-v1',
  ) =>
    queryReferenceLibrary(pool, {
      schema_version: schemaVersion,
      service_identity: 'task_service',
      audit: { owner_user_id: owner, project_id: project, run_id: null, trace_id: 'trace-syn' },
      target: {
        top3_codes: codes,
        taxonomy_version: taxonomy,
        fiscal_year: 2025,
        evidence_refs: ['fact-1'],
        market: 'sse',
        offering: 'public',
        instrument: 'corporate_bond',
        document_stage: 'registration',
        rule_version: 'rule-syn',
        ...extra,
      },
      index_release: indexRelease,
    });
  const drain = async () => {
    const outcomes = [];
    for (let i = 0; i < 10; i++) {
      const o = await runLibraryOnce(deps);
      if (o.outcome === 'idle') break;
      outcomes.push(o);
    }
    return outcomes;
  };
  const versionOf = async (externalKey: string, revision: number) =>
    (
      await pool.query(
        `SELECT v.* FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id
    WHERE d.source_id=$1 AND d.external_key=$2 AND v.source_revision=$3`,
        [sourceId, externalKey, String(revision)],
      )
    ).rows[0];
  const approve = (versionId: string) =>
    reviewLibraryVersion(
      pool,
      versionId,
      { action: 'approve', reason: 'synthetic_review_ok', review_quality: 80 },
      'operator-syn',
    );
  return {
    taxonomy,
    pool,
    blobs,
    sourceId,
    source,
    owner,
    project,
    deps,
    query,
    drain,
    versionOf,
    approve,
  };
}

test(
  'first sync and incremental sync record new, unchanged, new-version and failure/retry outcomes without duplicates',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.source.add('A', 1, 'a1');
      t.source.add('B', 1, 'b1');
      t.source.add('C', 1, 'c1');
      t.source.failuresLeft.set('B:v1', 1); // transient: succeeds on 2nd fetch try
      t.source.failuresLeft.set('C:v1', 5); // persistent in this run
      await enqueueLibrarySync(t.pool, t.sourceId);
      const first = await t.drain();
      assert.equal(first.length, 1);
      assert.equal(first[0]!.outcome, 'succeeded');
      assert.equal(first[0]!.partial, true);
      const s1 = await syncRunSummary(t.pool, first[0]!.syncRunId!);
      assert.deepEqual(s1.outcomes, { new_document: 2, failed: 1 });
      const bItem = (
        await t.pool.query(
          'SELECT attempts FROM bb_library_sync_items WHERE sync_run_id=$1 AND item_key=$2',
          [s1.sync_run_id, 'B:v1'],
        )
      ).rows[0];
      assert.equal(bItem.attempts, 2, 'retry is recorded per item');
      const src1 = (
        await t.pool.query(
          'SELECT last_success_at,last_error_code,cursor FROM bb_library_sources WHERE id=$1',
          [t.sourceId],
        )
      ).rows[0];
      assert.equal(src1.last_success_at, null, 'a partial sync is not a success');
      assert.equal(src1.last_error_code, 'LIBRARY_FETCH_FAILED');
      assert.ok(
        (await libraryAlerts(t.pool)).some(
          (a) => a.kind === 'source_sync_failed' && a.subject === t.sourceId,
        ),
      );

      t.source.add('A', 2, 'a2');
      t.source.failuresLeft.clear();
      await enqueueLibrarySync(t.pool, t.sourceId);
      const second = await t.drain();
      const s2 = await syncRunSummary(t.pool, second[0]!.syncRunId!);
      assert.deepEqual(s2.outcomes, { unchanged: 2, new_document: 1, new_version: 1 });
      const src2 = (
        await t.pool.query(
          'SELECT last_success_at,last_error_code FROM bb_library_sources WHERE id=$1',
          [t.sourceId],
        )
      ).rows[0];
      assert.ok(src2.last_success_at);
      assert.equal(src2.last_error_code, null);
      // Idempotent re-run: a third identical sync ingests nothing new.
      await enqueueLibrarySync(t.pool, t.sourceId);
      const third = await syncRunSummary(t.pool, (await t.drain())[0]!.syncRunId!);
      assert.deepEqual(third.outcomes, { unchanged: 4 });
      const count = (
        await t.pool.query(
          'SELECT count(*)::int n FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1',
          [t.sourceId],
        )
      ).rows[0].n;
      assert.equal(count, 4, 'A1, A2, B1, C1 once each');
      // A new revision retires the older unreviewed one from the queue; nothing was published by the pipeline.
      assert.equal((await t.versionOf('A', 1)).state, 'superseded');
      assert.equal((await t.versionOf('A', 2)).state, 'pending_review');
      assert.equal(
        (
          await t.pool.query(
            "SELECT count(*)::int n FROM bb_library_document_versions WHERE state='published' AND fetched_by_job_id IS NOT NULL AND document_id IN (SELECT id FROM bb_library_documents WHERE source_id=$1)",
            [t.sourceId],
          )
        ).rows[0].n,
        0,
      );
      // #79 rows exist for the library job under the system owner.
      const events = (
        await t.pool.query(
          "SELECT count(*)::int n FROM bb_observability_events WHERE owner_user_id='system-reference-library' AND job_id=$1",
          [first[0]!.jobId],
        )
      ).rows[0].n;
      assert.ok(events >= 3);
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'a crash half-way resumes after the last checkpointed item; discovery failure retries then fails with an alert',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.source.add('R1', 1, 'r1');
      t.source.add('R2', 1, 'r2');
      t.source.add('R3', 1, 'r3');
      await enqueueLibrarySync(t.pool, t.sourceId);
      let crashed = false;
      const crashing = {
        ...t.deps,
        leaseSeconds: 30,
        afterItem: async (index: number, _item: DiscoveredItem, lease: { jobId: string }) => {
          if (index === 0 && !crashed) {
            crashed = true;
            await t.pool.query(
              "UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
              [lease.jobId],
            );
            throw new Error('simulated process crash');
          }
        },
      };
      const lost = await runLibraryOnce(crashing);
      assert.equal(lost.outcome, 'lost');
      const resumed = await runLibraryOnce(crashing);
      assert.equal(resumed.outcome, 'succeeded');
      assert.deepEqual(
        t.source.fetches,
        ['R1:v1', 'R2:v1', 'R3:v1'],
        'R1 is not fetched twice after resume',
      );
      const s = await syncRunSummary(t.pool, resumed.syncRunId!);
      assert.deepEqual(s.outcomes, { new_document: 3 });
      assert.equal(lost.jobId, resumed.jobId, 'the same durable job resumed');

      t.source.discoverFails = 10;
      await enqueueLibrarySync(t.pool, t.sourceId, { maxAttempts: 2 });
      const outcomes = await t.drain();
      assert.deepEqual(
        outcomes.map((o) => o.outcome),
        ['retry_scheduled', 'failed'],
      );
      const job = (
        await t.pool.query('SELECT state,error_code FROM bb_jobs WHERE id=$1', [outcomes[0]!.jobId])
      ).rows[0];
      assert.deepEqual(job, { state: 'failed', error_code: 'LIBRARY_SOURCE_UNREACHABLE' });
      const errors = (
        await t.pool.query(
          'SELECT recovery_status FROM bb_observability_errors WHERE job_id=$1 ORDER BY created_at',
          [outcomes[0]!.jobId],
        )
      ).rows.map((r) => r.recovery_status);
      assert.deepEqual(errors, ['retry_scheduled', 'terminal']);
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'unreviewed or unlicensed data is never selectable; publish is atomic across body, profile and index',
  { skip },
  async () => {
    const t = await setup('evaluation_only');
    try {
      t.source.add('P', 1, 'p1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const v = await t.versionOf('P', 1);
      assert.equal(v.state, 'pending_review');
      assert.equal((await t.query()).status, 'no_match', 'pending review is not selectable');
      const before = (
        await t.pool.query('SELECT release_no FROM bb_library_index_releases WHERE active')
      ).rows[0].release_no;
      const published = await t.approve(v.id);
      assert.equal(published.status, 'published');
      const after = (
        await t.pool.query('SELECT id, release_no FROM bb_library_index_releases WHERE active')
      ).rows[0];
      assert.equal(Number(after.release_no), Number(before) + 1);
      const entry = (
        await t.pool.query(
          'SELECT e.*, p.state AS p_state FROM bb_library_index_entries e JOIN bb_library_profiles p ON p.id=e.profile_id WHERE e.release_id=$1 AND e.document_version_id=$2',
          [after.id, v.id],
        )
      ).rows[0];
      assert.equal(entry.p_state, 'published');
      assert.equal(
        (await t.query()).status,
        'no_match',
        'evaluation_only source rights are not usage rights',
      );
      await setLibrarySourceRights(
        t.pool,
        t.sourceId,
        'commercial_licensed',
        'licence_recorded',
        'operator-syn',
      );
      const hit = await t.query(['BIZ.PROPERTY', 'BIZ.WATER', 'BIZ.CONSTRUCTION']);
      assert.equal(hit.status, 'candidates', 'order-free set match');
      assert.equal(hit.candidates[0]!.document_version_id, v.id);
      assert.equal(
        JSON.stringify(hit).includes('Synthetic Issuer'),
        false,
        'no issuer facts in the query response',
      );
      assert.equal(
        JSON.stringify(hit).includes('"revenue"'),
        false,
        'no revenue values in the query response',
      );
      assert.equal(
        (await t.query(['BIZ.WATER', 'BIZ.CONSTRUCTION', 'BIZ.OTHER'])).status,
        'no_match',
        'two of three is not a match',
      );
      assert.equal((await t.query(TOP3, {}, 'some-old-release')).status, 'index_version_mismatch');

      // Body and index can never be one new and one old: direct state edits without a release fail at commit.
      const client = await t.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "UPDATE bb_library_document_versions SET state='withdrawn',state_reason='bypass_attempt',state_actor='x',state_changed_at=clock_timestamp() WHERE id=$1",
          [v.id],
        );
        await assert.rejects(client.query('COMMIT'), /inconsistent/);
      } finally {
        client.release();
      }
      await assert.rejects(
        t.pool.query(
          'UPDATE bb_library_index_entries SET review_quality=1 WHERE document_version_id=$1',
          [v.id],
        ),
        /append-only/,
      );
      await assert.rejects(
        t.pool.query("UPDATE bb_library_document_versions SET sha256=repeat('0',64) WHERE id=$1", [
          v.id,
        ]),
        /immutable/,
      );
      const audit = (
        await t.pool.query(
          "SELECT to_state, reason, actor FROM bb_library_audit WHERE subject_type='document_version' AND subject_id=$1 ORDER BY id",
          [v.id],
        )
      ).rows;
      assert.deepEqual(
        audit.map((a) => a.to_state),
        ['pending_parse', 'pending_classify', 'pending_review', 'published'],
      );
      assert.equal(audit.at(-1).actor, 'operator-syn');
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'conservative classifier leaves the business profile incomplete; approval needs an evidenced operator correction',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.deps.classifier = conservativeClassifier;
      t.source.add('K', 1, 'k1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const v = await t.versionOf('K', 1);
      assert.deepEqual(
        [v.market, v.offering, v.instrument, v.document_stage],
        ['sse', 'public', 'corporate_bond', 'registration'],
      );
      await assert.rejects(t.approve(v.id), /evidenced consolidated top-three/);
      // A correction without the reviewed comparability facts is still unpublishable.
      await reviewLibraryVersion(
        t.pool,
        v.id,
        {
          action: 'correct',
          reason: 'operator_profile_entry',
          correction: { fiscal_year: 2025, taxonomy_version: t.taxonomy, top3: lines(TOP3) },
        },
        'operator-syn',
      );
      await assert.rejects(t.approve(v.id), /revenue basis, currency and unit/);
      const corrected = await reviewLibraryVersion(
        t.pool,
        v.id,
        {
          action: 'correct',
          reason: 'operator_profile_entry',
          correction: {
            fiscal_year: 2025,
            taxonomy_version: t.taxonomy,
            top3: lines(TOP3),
            revenue_basis: 'main_business_revenue',
            currency: 'CNY',
            unit: 'ten_thousand_yuan',
          },
        },
        'operator-syn',
      );
      assert.equal(corrected.status, 'corrected');
      assert.equal((await t.approve(v.id)).status, 'published');
      const profiles = (
        await t.pool.query(
          'SELECT profile_version, origin, completeness, state FROM bb_library_profiles WHERE document_version_id=$1 ORDER BY profile_version',
          [v.id],
        )
      ).rows;
      assert.deepEqual(
        profiles.map((p) => [p.profile_version, p.origin, p.completeness, p.state]),
        [
          [1, 'classifier', 'incomplete', 'superseded'],
          [2, 'operator_correction', 'complete', 'superseded'],
          [3, 'operator_correction', 'complete', 'published'],
        ],
      );
      // Operator per-record re-run of a failed version goes through the same pipeline.
      t.source.add('F', 1, 'f1');
      const failingParser: LibraryParser = async () => {
        throw new Error('synthetic parser crash');
      };
      t.deps.parser = failingParser;
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      assert.equal((await t.versionOf('F', 1)).state, 'failed');
      assert.ok((await libraryAlerts(t.pool)).some((a) => a.kind === 'items_failed'));
      // Regression (found by the live SSE run): a newer revision must retire a failed older one.
      t.source.add('H', 1, 'h1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      assert.equal((await t.versionOf('H', 1)).state, 'failed');
      t.deps.parser = syntheticParser;
      t.deps.classifier = syntheticClassifier(t.taxonomy);
      t.source.add('H', 2, 'h2');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      assert.deepEqual(
        [(await t.versionOf('H', 1)).state, (await t.versionOf('H', 2)).state],
        ['superseded', 'pending_review'],
      );
      const sourceBeforeRerun = (
        await t.pool.query('SELECT cursor,last_success_at FROM bb_library_sources WHERE id=$1', [
          t.sourceId,
        ])
      ).rows[0];
      await enqueueLibraryRecordRerun(t.pool, (await t.versionOf('F', 1)).id, 'operator-syn');
      const rerun = (await t.drain())[0]!;
      assert.equal((await t.versionOf('F', 1)).state, 'pending_review');
      const rerunSummary = await syncRunSummary(t.pool, rerun.syncRunId!);
      assert.equal(rerunSummary.mode, 'record_rerun');
      assert.equal(rerunSummary.state, 'succeeded');
      assert.ok(rerunSummary.finished_at);
      assert.deepEqual(rerunSummary.outcomes, { unchanged: 1 });
      const sourceAfterRerun = (
        await t.pool.query('SELECT cursor,last_success_at FROM bb_library_sources WHERE id=$1', [
          t.sourceId,
        ])
      ).rows[0];
      assert.deepEqual(
        sourceAfterRerun,
        sourceBeforeRerun,
        'record reruns do not advance source sync state',
      );
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'a third-business ranking change appends a new profile version; an identical ranking does not',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.source.add('G', 1, 'g1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const v = await t.versionOf('G', 1);
      const same = await reclassifyPendingProfile(t.pool, v.id, draft(TOP3, t.taxonomy));
      assert.equal(same.created, false);
      const swapped = await reclassifyPendingProfile(
        t.pool,
        v.id,
        draft(['BIZ.WATER', 'BIZ.PROPERTY', 'BIZ.CONSTRUCTION'], t.taxonomy),
      );
      assert.equal(swapped.created, true);
      const profiles = (
        await t.pool.query(
          'SELECT profile_version, state, state_reason, set_key FROM bb_library_profiles WHERE document_version_id=$1 ORDER BY profile_version',
          [v.id],
        )
      ).rows;
      assert.deepEqual(
        profiles.map((p) => [p.profile_version, p.state]),
        [
          [1, 'superseded'],
          [2, 'pending_review'],
        ],
      );
      assert.equal(profiles[1].state_reason, 'ranking_changed');
      assert.equal(profiles[0].set_key, profiles[1].set_key, 'same set, different ranking');
      await assert.rejects(
        t.pool.query("UPDATE bb_library_profiles SET top3='[]'::jsonb WHERE id=$1", [
          swapped.profileId,
        ]),
        /immutable/,
      );
      const open = (
        await t.pool.query(
          "SELECT profile_id FROM bb_library_review_items WHERE document_version_id=$1 AND state='open'",
          [v.id],
        )
      ).rows;
      assert.deepEqual(
        open.map((r) => r.profile_id),
        [swapped.profileId],
        'review follows the newest profile',
      );
    } finally {
      await t.pool.end();
    }
  },
);

test('late old revisions never overwrite a newer published version', { skip }, async () => {
  const t = await setup();
  try {
    t.source.add('L', 1, 'l1');
    await enqueueLibrarySync(t.pool, t.sourceId);
    await t.drain();
    const v1 = await t.versionOf('L', 1);
    t.source.add('L', 2, 'l2');
    await enqueueLibrarySync(t.pool, t.sourceId);
    await t.drain();
    const v2 = await t.versionOf('L', 2);
    assert.equal((await t.versionOf('L', 1)).state, 'superseded');
    assert.equal((await t.approve(v2.id)).status, 'published');
    // A late job delivers a different byte stream for revision 1: kept for audit, immediately superseded.
    const late = await ingestLibraryVersion(t.pool, t.blobs, {
      sourceId: t.sourceId,
      externalKey: 'L',
      issuerKey: 'issuer-L',
      issuerName: 'x',
      title: 'x',
      sourceRevision: '1b',
      sourceRevisionRank: 1,
      bytes: Buffer.from('%PDF-1.7 late old bytes'),
      mediaType: 'application/pdf',
    });
    assert.equal(late.outcome, 'stale_ignored');
    assert.equal(
      (
        await t.pool.query(
          'SELECT state, state_reason FROM bb_library_document_versions WHERE id=$1',
          [late.versionId],
        )
      ).rows[0].state_reason,
      'stale_late_revision',
    );
    // Approving the old one late cannot win either (it is not pending anymore).
    await assert.rejects(t.approve(v1.id), /pending review/);
    const hit = await t.query();
    assert.deepEqual(
      hit.candidates.map((c) => c.document_version_id),
      [v2.id],
    );
  } finally {
    await t.pool.end();
  }
});

test(
  'v1.1 lock validation stays fail-closed while v1 replay stays unchanged',
  { skip },
  async () => {
    const t = await setup();
    const scope = {
      market: 'sse' as const,
      offering: 'public' as const,
      instrument: 'corporate_bond',
      document_stage: 'registration' as const,
      rule_version: 'lock-rule-v1',
    };
    const targetScope = {
      market: 'szse' as const,
      offering: 'private' as const,
      instrument: 'corporate_bond',
      document_stage: 'registration' as const,
      rule_version: 'lock-rule-v1',
    };
    const sharedInputHash = 'a'.repeat(64);
    let inputRevisionCreated = false;
    const createRun = async (suffix: string) => {
      const runId = `library-lock-run-${suffix}-${randomUUID()}`;
      const requestHash = 'b'.repeat(64);
      if (!inputRevisionCreated) {
        await t.pool.query(
          `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,'{}','[]','[]')`,
          [t.project, t.owner, sharedInputHash],
        );
        inputRevisionCreated = true;
      }
      await t.pool.query(
        `INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$5,'generation',$6,'preparing')`,
        [
          runId,
          t.owner,
          t.project,
          sharedInputHash,
          `library-lock-exec-${randomUUID()}`,
          requestHash,
        ],
      );
      return runId;
    };
    const lockRequest = (
      candidate: LibraryCandidateV1_1,
      releaseId: string,
      runId: string,
      mappingId: string | null,
      requestedTarget: {
        market: 'sse' | 'szse' | 'nafmii';
        offering: 'private' | 'public' | 'public_all' | 'ppn' | 'mtn' | 'cp' | 'scp' | 'dfi';
        instrument: string;
        document_stage: 'registration' | 'issuance';
        rule_version: string;
      } = targetScope,
    ) => {
      assert.ok(
        candidate.comparability,
        'v1.1 query must return reviewed comparability for lock revalidation',
      );
      return {
        ownerUserId: t.owner,
        projectId: t.project,
        runId,
        querySchemaVersion: 'reference-library-query-v1.1' as const,
        documentVersionId: candidate.document_version_id,
        documentVersion: candidate.document_version,
        profileId: candidate.profile_id,
        profileVersion: candidate.profile_version,
        taxonomyVersion: candidate.taxonomy_version,
        indexReleaseId: releaseId,
        candidateScope: {
          market: candidate.market,
          offering: candidate.offering,
          instrument: candidate.instrument,
        },
        targetScope: requestedTarget,
        comparability: candidate.comparability,
        chapterMappingVersionId: mappingId,
      };
    };
    const candidateFor = (
      hit: Awaited<ReturnType<typeof t.query>>,
      versionId: string,
    ): LibraryCandidateV1_1 => {
      assert.equal(hit.schema_version, 'reference-library-query-v1.1');
      const candidate = hit.candidates.find((item) => item.document_version_id === versionId);
      assert.ok(
        candidate && 'comparability' in candidate,
        'published profile should appear in the v1.1 query',
      );
      return candidate as LibraryCandidateV1_1;
    };
    try {
      t.source.add('LOCK', 1, 'lock-1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const firstVersion = await t.versionOf('LOCK', 1);
      await reviewLibraryVersion(
        t.pool,
        firstVersion.id,
        {
          action: 'approve',
          reason: 'synthetic_review_ok',
          review_quality: 80,
          applicable_scopes: [scope, targetScope],
        },
        'operator-syn',
      );

      const sameScopeHit = await t.query(
        TOP3,
        { ...scope, rule_version: scope.rule_version },
        null,
        'reference-library-query-v1.1',
      );
      const firstCandidate = candidateFor(sameScopeHit, firstVersion.id);
      const v1Run = await createRun('v1-replay');
      const v1Input = {
        ownerUserId: t.owner,
        projectId: t.project,
        runId: v1Run,
        documentVersionId: firstVersion.id,
        profileId: firstCandidate.profile_id,
        indexReleaseId: sameScopeHit.index_release!.release_id,
      };
      const v1Lock = await lockReferenceSelection(t.pool, v1Input);
      assert.equal(v1Lock.query_schema_version, 'reference-library-query-v1');
      assert.equal(
        (await lockReferenceSelection(t.pool, v1Input)).lock_id,
        v1Lock.lock_id,
        'existing v1 run replay returns the same lock',
      );

      const v11Run = await createRun('v11-same-scope');
      const v11Input = lockRequest(
        firstCandidate,
        sameScopeHit.index_release!.release_id,
        v11Run,
        null,
        {
          market: 'sse',
          offering: 'public',
          instrument: 'corporate_bond',
          document_stage: 'registration',
          rule_version: 'lock-rule-v1',
        },
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, v11Input),
        /Revenue rank proof insufficient: proof_missing/,
        'an otherwise eligible reviewed profile still cannot lock without independent completeness/tie evidence',
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, v11Input),
        /Revenue rank proof insufficient: proof_missing/,
        'retry remains fail-closed and creates no replayable lock',
      );
      assert.equal(
        Number(
          (
            await t.pool.query('SELECT count(*) FROM bb_library_selection_locks WHERE run_id=$1', [
              v11Run,
            ])
          ).rows[0].count,
        ),
        0,
      );

      const proofProfile = (
        await t.pool.query('SELECT * FROM bb_library_profiles WHERE id=$1', [
          firstCandidate.profile_id,
        ])
      ).rows[0];
      const profileHash = libraryProfileContentHash(proofProfile);
      const profileTop3 = proofProfile.top3 as Array<{
        code: string;
        label: string;
        revenue: string;
        rank: number;
      }>;
      const proof: LibraryRevenueRankProof = {
        profile_id: proofProfile.id,
        profile_version: proofProfile.profile_version,
        profile_hash: profileHash,
        document_version_id: firstVersion.id,
        fiscal_year: proofProfile.fiscal_year,
        accounting_scope: 'consolidated',
        revenue_basis: 'main_business_revenue',
        currency: 'CNY',
        unit: 'ten_thousand_yuan',
        denominator: '600',
        denominator_evidence: [
          {
            document_version_id: firstVersion.id,
            page: 1,
            quote: 'Synthetic annual business revenue total: 600',
          },
        ],
        rows: profileTop3.map((line, index) => ({
          code: line.code,
          label: line.label,
          amount: line.revenue,
          currency: 'CNY',
          unit: 'ten_thousand_yuan',
          evidence: [
            {
              document_version_id: firstVersion.id,
              page: index + 2,
              quote: `Synthetic ${line.code} revenue ${line.revenue}`,
            },
          ],
        })),
        ranking: {
          top3_codes: profileTop3.map((line) => line.code),
          third_place_tied_codes: [],
          tie_decision: null,
        },
        classification_review: {
          reviewer: 'reviewer-synthetic',
          reviewed_at: '2026-09-28T00:00:00Z',
          taxonomy_version: proofProfile.taxonomy_version,
          profile_id: proofProfile.id,
          profile_version: proofProfile.profile_version,
          profile_hash: profileHash,
          decision: 'approved',
          evidence_complete: true,
        },
      };
      const persistedProof = await persistLibraryRevenueRankProof(t.pool, proof);
      const proofHit = await t.query(
        TOP3,
        { ...scope, rule_version: scope.rule_version },
        null,
        'reference-library-query-v1.1',
      );
      const proofCandidate = candidateFor(proofHit, firstVersion.id);
      assert.deepEqual(
        proofCandidate.revenue_rank_proof,
        {
          profile_id: proofProfile.id,
          profile_version: proofProfile.profile_version,
          profile_hash: profileHash,
          proof_hash: persistedProof.proof_hash,
          sufficient: true,
          reasons: [],
        },
        'v1.1 query carries only the version-pinned proof decision, not evidence quotes or revenue rows',
      );
      const proofRun = await createRun('proof-sufficient-but-production-closed');
      const proofInput = lockRequest(
        proofCandidate,
        proofHit.index_release!.release_id,
        proofRun,
        null,
        {
          market: 'sse',
          offering: 'public',
          instrument: 'corporate_bond',
          document_stage: 'registration',
          rule_version: 'lock-rule-v1',
        },
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, proofInput),
        /v1\.1 reference selection awaits authorized data and business acceptance/,
        'the API revalidates a sufficient immutable proof but keeps the production lock disabled',
      );
      assert.equal(
        Number(
          (
            await t.pool.query('SELECT count(*) FROM bb_library_selection_locks WHERE run_id=$1', [
              proofRun,
            ])
          ).rows[0].count,
        ),
        0,
      );

      const wrongProfile = {
        ...v11Input,
        runId: await createRun('wrong-profile'),
        profileVersion: firstCandidate.profile_version + 1,
      };
      await assert.rejects(
        lockReferenceSelection(t.pool, wrongProfile),
        /changed since the v1\.1 query/,
      );
      const wrongAttestation = {
        ...v11Input,
        runId: await createRun('wrong-attestation'),
        comparability: {
          ...v11Input.comparability,
          attestation: { ...v11Input.comparability.attestation, review_id: 'other-review' },
        },
      };
      await assert.rejects(
        lockReferenceSelection(t.pool, wrongAttestation),
        /changed since the v1\.1 query/,
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, {
          ...v11Input,
          ownerUserId: 'other-owner',
          runId: undefined,
        }),
        /does not exist/,
      );

      const mapping = await recordChapterMappingVersion(
        t.pool,
        {
          mapping_key: 'synthetic.lock.scope',
          source: scope,
          target: {
            market: targetScope.market,
            offering: targetScope.offering,
            instrument: targetScope.instrument,
          },
          document_stage: targetScope.document_stage,
          rule_version: targetScope.rule_version,
          reason: 'synthetic_review_ok',
        },
        'operator-syn',
      );
      const wrongScopeMapping = await recordChapterMappingVersion(
        t.pool,
        {
          mapping_key: 'synthetic.lock.wrong-scope',
          source: scope,
          target: {
            market: targetScope.market,
            offering: 'public',
            instrument: targetScope.instrument,
          },
          document_stage: targetScope.document_stage,
          rule_version: targetScope.rule_version,
          reason: 'synthetic_review_ok',
        },
        'operator-syn',
      );
      const crossScopeHit = await t.query(
        TOP3,
        {
          market: targetScope.market,
          offering: targetScope.offering,
          instrument: targetScope.instrument,
          document_stage: targetScope.document_stage,
          rule_version: targetScope.rule_version,
        },
        null,
        'reference-library-query-v1.1',
      );
      const crossScopeCandidate = candidateFor(crossScopeHit, firstVersion.id);
      assert.deepEqual(
        crossScopeCandidate.chapter_mappings.map((item) => item.mapping_version_id),
        [mapping.mapping_version_id],
      );
      const wrongMappingRun = await createRun('wrong-mapping-scope');
      const wrongMapping = lockRequest(
        crossScopeCandidate,
        crossScopeHit.index_release!.release_id,
        wrongMappingRun,
        wrongScopeMapping.mapping_version_id,
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, wrongMapping),
        /accepted chapter mapping is no longer applicable/,
      );
      await withdrawChapterMappingVersion(
        t.pool,
        mapping.mapping_version_id,
        'mapping_scope_review',
        'operator-syn',
      );
      const withdrawnMappingRun = await createRun('withdrawn-mapping');
      await assert.rejects(
        lockReferenceSelection(
          t.pool,
          lockRequest(
            crossScopeCandidate,
            crossScopeHit.index_release!.release_id,
            withdrawnMappingRun,
            mapping.mapping_version_id,
          ),
        ),
        /accepted chapter mapping is no longer applicable/,
      );

      const replacementMapping = await recordChapterMappingVersion(
        t.pool,
        {
          mapping_key: 'synthetic.lock.scope',
          source: scope,
          target: {
            market: targetScope.market,
            offering: targetScope.offering,
            instrument: targetScope.instrument,
          },
          document_stage: targetScope.document_stage,
          rule_version: targetScope.rule_version,
          reason: 'mapping_corrected',
        },
        'operator-syn',
      );
      const refreshedHit = await t.query(
        TOP3,
        {
          market: targetScope.market,
          offering: targetScope.offering,
          instrument: targetScope.instrument,
          document_stage: targetScope.document_stage,
          rule_version: targetScope.rule_version,
        },
        null,
        'reference-library-query-v1.1',
      );
      const refreshedCandidate = candidateFor(refreshedHit, firstVersion.id);
      const validMappedRun = await createRun('mapped-lock');
      const validMappedRequest = lockRequest(
        refreshedCandidate,
        refreshedHit.index_release!.release_id,
        validMappedRun,
        replacementMapping.mapping_version_id,
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, validMappedRequest),
        /v1\.1 reference selection awaits authorized data and business acceptance/,
        'an accepted exact mapping and sufficient proof still cannot open production lock before #77 acceptance',
      );
      assert.equal(
        Number(
          (
            await t.pool.query('SELECT count(*) FROM bb_library_selection_locks WHERE run_id=$1', [
              validMappedRun,
            ])
          ).rows[0].count,
        ),
        0,
      );

      const staleReleaseRun = await createRun('stale-release');
      t.source.add('LOCK', 2, 'lock-2');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const secondVersion = await t.versionOf('LOCK', 2);
      await reviewLibraryVersion(
        t.pool,
        secondVersion.id,
        {
          action: 'approve',
          reason: 'synthetic_review_ok',
          review_quality: 80,
          applicable_scopes: [scope, targetScope],
        },
        'operator-syn',
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, { ...validMappedRequest, runId: staleReleaseRun }),
        /no longer selectable/,
      );

      const secondHit = await t.query(TOP3, { ...scope }, null, 'reference-library-query-v1.1');
      const secondCandidate = candidateFor(secondHit, secondVersion.id);
      const nonCommercialRun = await createRun('non-commercial-rights');
      const rightsInput = lockRequest(
        secondCandidate,
        secondHit.index_release!.release_id,
        nonCommercialRun,
        null,
        {
          market: 'sse',
          offering: 'public',
          instrument: 'corporate_bond',
          document_stage: 'registration',
          rule_version: 'lock-rule-v1',
        },
      );
      await setLibrarySourceRights(
        t.pool,
        t.sourceId,
        'evaluation_only',
        'license_scope_changed',
        'operator-syn',
      );
      await assert.rejects(lockReferenceSelection(t.pool, rightsInput), /no longer selectable/);
      const revokedRun = await createRun('revoked-rights');
      await setLibrarySourceRights(
        t.pool,
        t.sourceId,
        'revoked',
        'license_revoked',
        'operator-syn',
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, { ...rightsInput, runId: revokedRun }),
        /no longer selectable/,
      );
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'withdraw leaves new matching at once (cache invalidated); locks stay traceable; revoked rights re-checked on read',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.source.add('W', 1, 'w1');
      t.source.add('X', 1, 'x1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const w = await t.versionOf('W', 1),
        x = await t.versionOf('X', 1);
      await t.approve(w.id);
      await t.approve(x.id);
      const hit = await t.query();
      assert.equal(hit.candidates.length, 2);
      assert.ok(libraryCacheSize() > 0);
      const cand = hit.candidates.find((c) => c.document_version_id === w.id)!;
      const lock = await lockReferenceSelection(t.pool, {
        ownerUserId: t.owner,
        projectId: t.project,
        documentVersionId: w.id,
        profileId: cand.profile_id,
        indexReleaseId: hit.index_release!.release_id,
      });
      const read1 = await readLockedReference(t.pool, t.blobs, t.owner, t.project, lock.lock_id);
      assert.equal(read1.access, 'granted');
      assert.ok(read1.bytes?.toString().includes('w1'));
      await assert.rejects(
        readLockedReference(t.pool, t.blobs, 'someone-else', t.project, lock.lock_id),
        /does not exist/,
      );

      await reviewLibraryVersion(
        t.pool,
        w.id,
        { action: 'withdraw', reason: 'issuer_withdrew_filing' },
        'operator-syn',
      );
      const after = await t.query();
      assert.deepEqual(
        after.candidates.map((c) => c.document_version_id),
        [x.id],
        'withdrawn version leaves new matching immediately',
      );
      await assert.rejects(
        lockReferenceSelection(t.pool, {
          ownerUserId: t.owner,
          projectId: t.project,
          documentVersionId: w.id,
          profileId: cand.profile_id,
          indexReleaseId: hit.index_release!.release_id,
        }),
        /no longer selectable/,
      );
      const read2 = await readLockedReference(t.pool, t.blobs, t.owner, t.project, lock.lock_id);
      assert.equal(read2.access, 'denied');
      assert.equal(read2.lock.document_version_id, w.id, 'lock still traceable');
      assert.equal(read2.bytes, null);

      // Source licence revoked: remaining published versions leave the index; locked reads are refused.
      const xLock = await lockReferenceSelection(t.pool, {
        ownerUserId: t.owner,
        projectId: t.project,
        documentVersionId: x.id,
        profileId: after.candidates[0]!.profile_id,
        indexReleaseId: after.index_release!.release_id,
      });
      await setLibrarySourceRights(
        t.pool,
        t.sourceId,
        'revoked',
        'licence_terminated',
        'operator-syn',
      );
      assert.equal((await t.query()).status, 'no_match');
      assert.equal((await t.versionOf('X', 1)).state, 'license_revoked');
      const read3 = await readLockedReference(t.pool, t.blobs, t.owner, t.project, xLock.lock_id);
      assert.deepEqual([read3.access, read3.reason], ['denied', 'source_rights_not_current']);
      await assert.rejects(
        setLibrarySourceRights(
          t.pool,
          t.sourceId,
          'commercial_licensed',
          'try_again',
          'operator-syn',
        ),
        /new source registration/,
      );
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'a later expansion never rewrites a lock; rollback restores index and body together',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.source.add('Y', 1, 'y1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const y1 = await t.versionOf('Y', 1);
      const rel1 = (await t.approve(y1.id)) as { release_id: string };
      const hit = await t.query();
      const lock = await lockReferenceSelection(t.pool, {
        ownerUserId: t.owner,
        projectId: t.project,
        documentVersionId: y1.id,
        profileId: hit.candidates[0]!.profile_id,
        indexReleaseId: rel1.release_id,
      });
      t.source.add('Y', 2, 'y2');
      t.source.add('Z', 1, 'z1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const y2 = await t.versionOf('Y', 2),
        z1 = await t.versionOf('Z', 1);
      await t.approve(y2.id);
      await t.approve(z1.id);
      assert.equal((await t.versionOf('Y', 1)).state, 'superseded');
      const lockRow = (
        await t.pool.query(
          'SELECT document_version_id, index_release_id FROM bb_library_selection_locks WHERE id=$1',
          [lock.lock_id],
        )
      ).rows[0];
      assert.deepEqual(
        lockRow,
        { document_version_id: y1.id, index_release_id: rel1.release_id },
        'lock not rewritten',
      );
      const locked = await readLockedReference(t.pool, t.blobs, t.owner, t.project, lock.lock_id);
      assert.equal(locked.access, 'granted');
      assert.ok(
        locked.bytes?.toString().includes('y1'),
        'locked task keeps reading the version it selected',
      );

      const rolled = await rollbackLibraryRelease(
        t.pool,
        rel1.release_id,
        'bad_release_rollback',
        'operator-syn',
      );
      assert.equal(rolled.status, 'rolled_back');
      assert.equal((await t.versionOf('Y', 1)).state, 'published');
      assert.equal((await t.versionOf('Y', 2)).state, 'rolled_back');
      assert.equal((await t.versionOf('Z', 1)).state, 'rolled_back');
      const active = (await t.pool.query('SELECT id FROM bb_library_index_releases WHERE active'))
        .rows[0].id;
      const entries = (
        await t.pool.query(
          `SELECT e.document_version_id, v.state, p.state AS p_state FROM bb_library_index_entries e JOIN bb_library_document_versions v ON v.id=e.document_version_id
      JOIN bb_library_profiles p ON p.id=e.profile_id JOIN bb_library_documents d ON d.id=e.document_id WHERE e.release_id=$1 AND d.source_id=$2`,
          [active, t.sourceId],
        )
      ).rows;
      assert.deepEqual(
        entries,
        [{ document_version_id: y1.id, state: 'published', p_state: 'published' }],
        'index and body agree after rollback',
      );
      assert.deepEqual(
        (await t.query()).candidates.map((c) => c.document_version_id),
        [y1.id],
      );
      const overview = await libraryOverview(t.pool);
      assert.equal(overview.active_release.release_id, active);
      invalidateLibraryCache();
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'personal uploads cannot enter the library: blob keys must be library/ and nothing references user materials',
  { skip },
  async () => {
    const t = await setup();
    try {
      const doc = (
        await t.pool.query(
          "INSERT INTO bb_library_documents(id,source_id,external_key,issuer_key,issuer_name,title) VALUES($1,$2,'u','u','u','u') RETURNING id",
          [randomUUID(), t.sourceId],
        )
      ).rows[0].id;
      await assert.rejects(
        t.pool.query(
          `INSERT INTO bb_library_document_versions(id,document_id,version,source_revision,source_revision_rank,sha256,byte_size,media_type,blob_key,state_reason,state_actor)
      VALUES($1,$2,1,'1',1,$3,10,'application/pdf',$4,'ingested','x')`,
          [
            randomUUID(),
            doc,
            sha(Buffer.from('u')),
            `users/${t.owner}/projects/${t.project}/materials/m1`,
          ],
        ),
        /check constraint/,
      );
      const fks = (
        await t.pool
          .query(`SELECT count(*)::int n FROM information_schema.constraint_column_usage u JOIN information_schema.table_constraints c ON c.constraint_name=u.constraint_name
      WHERE c.table_name LIKE 'bb_library_%' AND u.table_name IN ('bb_material_versions','bb_uploads')`)
      ).rows[0].n;
      assert.equal(fks, 0);
      // Operator import shares the pipeline and reads only its own staging prefix.
      const importer = new OperatorImportAdapter(t.blobs);
      await assert.rejects(
        importer.fetch({ locator: `users/${t.owner}/x`, itemKey: 'i' } as DiscoveredItem),
        /LIBRARY_FETCH_FAILED/,
      );
      // A pending version cannot be approved into the index via reclassify/classify helpers.
      const ingested = await ingestLibraryVersion(t.pool, t.blobs, {
        sourceId: t.sourceId,
        externalKey: 'Q',
        issuerKey: 'q',
        issuerName: 'q',
        title: 'q',
        sourceRevision: '1',
        sourceRevisionRank: 1,
        bytes: Buffer.from('%PDF q'),
        mediaType: 'application/pdf',
      });
      await markLibraryVersionParsed(t.pool, ingested.versionId, { synthetic: true });
      await classifyLibraryVersion(
        t.pool,
        ingested.versionId,
        {
          market: 'sse',
          offering: 'public',
          instrument: 'corporate_bond',
          documentStage: 'registration',
        },
        draft(TOP3, t.taxonomy),
      );
      assert.equal(
        (
          await t.pool.query('SELECT state FROM bb_library_document_versions WHERE id=$1', [
            ingested.versionId,
          ])
        ).rows[0].state,
        'pending_review',
      );
      assert.ok(t.blobs.keys().every((k) => k.startsWith('library/')));
    } finally {
      await t.pool.end();
    }
  },
);

test('operator import rejects a staged SHA mismatch before parsing', { skip }, async () => {
  const t = await setup();
  try {
    await registerLibrarySource(t.pool, OPERATOR_IMPORT_SOURCE);
    const expected = Buffer.from('synthetic expected bytes');
    const key = `library/import-staging/${sha(expected)}`;
    await t.blobs.put(key, Buffer.from('synthetic changed bytes'), 'application/pdf');
    let parses = 0;
    t.deps.parser = async (request) => {
      parses++;
      return syntheticParser(request);
    };
    t.deps.adapters[OPERATOR_IMPORT_SOURCE.id] = new OperatorImportAdapter(t.blobs);
    await enqueueLibrarySync(t.pool, OPERATOR_IMPORT_SOURCE.id, {
      checkpoint: {
        import_items: [
          {
            external_key: 'tampered',
            issuer_key: 'synthetic',
            issuer_name: 'Synthetic',
            title: 'Synthetic',
            source_revision: '1',
            media_type: 'application/pdf',
            staged_key: key,
            sha256: sha(expected),
          },
        ],
      },
    });
    const outcome = await runLibraryOnce(t.deps);
    const summary = await syncRunSummary(t.pool, outcome.syncRunId!);
    assert.deepEqual(summary.outcomes, { failed: 1 });
    assert.equal(
      (
        await t.pool.query('SELECT error_code FROM bb_library_sync_items WHERE sync_run_id=$1', [
          summary.sync_run_id,
        ])
      ).rows[0].error_code,
      'LIBRARY_BYTES_INVALID',
    );
    assert.equal(parses, 0);
  } finally {
    await t.pool.end();
  }
});

test(
  'v1.1 query returns reviewed comparability facts and attestation; v1 shape is unchanged; the gate holds in the database',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.source.add('CMP', 1, 'cmp1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const v = await t.versionOf('CMP', 1);
      const published = await t.approve(v.id);
      assert.equal(published.status, 'published');
      const v1 = await t.query();
      assert.equal(v1.schema_version, 'reference-library-query-v1');
      assert.ok(validV1(v1), 'v1 response keeps the exact v1 shape');
      assert.equal('comparability' in v1.candidates[0]!, false);
      const v11 = (await t.query(
        TOP3,
        {},
        null,
        'reference-library-query-v1.1',
      )) as LibraryQueryResponseV1_1;
      assert.ok(validV11(v11), JSON.stringify(validV11.errors));
      const c = v11.candidates.find((x) => x.document_version_id === v.id)!;
      const profile = (
        await t.pool.query(
          'SELECT p.id, p.profile_version, r.id AS review_id, r.decided_by, r.decided_at FROM bb_library_profiles p JOIN bb_library_review_items r ON r.id=p.reviewed_review_id WHERE p.document_version_id=$1 AND p.state=$2',
          [v.id, 'published'],
        )
      ).rows[0];
      assert.deepEqual(c.comparability, {
        accounting_scope: 'consolidated',
        revenue_basis: 'main_business_revenue',
        currency: 'CNY',
        unit: 'ten_thousand_yuan',
        fiscal_year: 2025,
        attestation: {
          review_id: profile.review_id,
          reviewed_by: 'operator-syn',
          reviewed_at: new Date(profile.decided_at).toISOString(),
          profile_id: profile.id,
          profile_version: profile.profile_version,
        },
      });
      assert.equal(profile.decided_by, 'operator-syn');
      // Facts and attestation are immutable per profile version, even for a direct SQL writer.
      await assert.rejects(
        t.pool.query(
          "UPDATE bb_library_profiles SET revenue_basis='operating_revenue' WHERE id=$1",
          [profile.id],
        ),
        /immutable/,
      );
      await assert.rejects(
        t.pool.query("UPDATE bb_library_profiles SET reviewed_by='someone-else' WHERE id=$1", [
          profile.id,
        ]),
        /attestation is immutable/,
      );
      // Unreviewed data (no facts, or no attestation) cannot be published by any path.
      t.deps.classifier = conservativeClassifier;
      t.source.add('RAW', 1, 'raw1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const raw = await t.versionOf('RAW', 1);
      const rawProfile = (
        await t.pool.query('SELECT id FROM bb_library_profiles WHERE document_version_id=$1', [
          raw.id,
        ])
      ).rows[0].id;
      await assert.rejects(
        t.pool.query(
          "UPDATE bb_library_profiles SET state='published',state_reason='sql_bypass',state_actor='x' WHERE id=$1",
          [rawProfile],
        ),
        /reviewed comparability facts/,
      );
      t.deps.classifier = syntheticClassifier(t.taxonomy);
      t.source.add('NOATT', 1, 'noatt1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const noAtt = (
        await t.pool.query('SELECT id FROM bb_library_profiles WHERE document_version_id=$1', [
          (await t.versionOf('NOATT', 1)).id,
        ])
      ).rows[0].id;
      await assert.rejects(
        t.pool.query(
          "UPDATE bb_library_profiles SET state='published',state_reason='sql_bypass',state_actor='x' WHERE id=$1",
          [noAtt],
        ),
        /reviewed comparability facts/,
      );
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'v1.1 preserves operating-revenue comparability as raw data but rejects it for a lock',
  { skip },
  async () => {
    const t = await setup();
    const runId = `library-operating-lock-${randomUUID()}`;
    try {
      t.deps.classifier = syntheticClassifier(t.taxonomy, TOP3, 'operating_revenue');
      t.source.add('OPERATING', 1, 'operating profile');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const version = await t.versionOf('OPERATING', 1);
      await t.approve(version.id);
      const response = (await t.query(
        TOP3,
        {},
        null,
        'reference-library-query-v1.1',
      )) as LibraryQueryResponseV1_1;
      const candidate = response.candidates.find(
        (item) => item.document_version_id === version.id,
      )!;
      assert.equal(
        candidate.comparability?.revenue_basis,
        'operating_revenue',
        'published original profile remains unchanged',
      );

      const inputHash = 'b'.repeat(64);
      await t.pool.query(
        `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,
        [t.project, t.owner, inputHash],
      );
      await t.pool.query(
        `INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$5,'generation',$6,'preparing')`,
        [runId, t.owner, t.project, inputHash, `execution-${randomUUID()}`, 'c'.repeat(64)],
      );
      const lockInput = {
        ownerUserId: t.owner,
        projectId: t.project,
        runId,
        querySchemaVersion: 'reference-library-query-v1.1' as const,
        documentVersionId: candidate.document_version_id,
        documentVersion: candidate.document_version,
        profileId: candidate.profile_id,
        profileVersion: candidate.profile_version,
        taxonomyVersion: candidate.taxonomy_version,
        indexReleaseId: response.index_release!.release_id,
        candidateScope: {
          market: candidate.market,
          offering: candidate.offering,
          instrument: candidate.instrument,
        },
        targetScope: {
          market: 'sse',
          offering: 'public',
          instrument: 'corporate_bond',
          document_stage: 'registration',
          rule_version: 'rule-syn',
        },
        comparability: candidate.comparability!,
        chapterMappingVersionId: null,
      };
      await assert.rejects(
        lockReferenceSelection(t.pool, lockInput),
        /changed since the v1\.1 query/,
      );
      assert.equal(
        Number(
          (
            await t.pool.query('SELECT count(*) FROM bb_library_selection_locks WHERE run_id=$1', [
              runId,
            ])
          ).rows[0].count,
        ),
        0,
      );
    } finally {
      await t.pool.end();
    }
  },
);

test(
  'v1.1 chapter mappings: only versions whose source->target scope covers the request are returned, with the mapping version id',
  { skip },
  async () => {
    const t = await setup();
    try {
      t.source.add('MAP', 1, 'map1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      await t.approve((await t.versionOf('MAP', 1)).id);
      const key = `m.${t.sourceId}`;
      const src = {
        market: 'sse' as const,
        offering: 'public' as const,
        instrument: 'corporate_bond',
      };
      const tgt = {
        market: 'szse' as const,
        offering: 'public' as const,
        instrument: 'corporate_bond',
      };
      // Mapping versions are global rows, so a per-test rule version keeps other suites' mappings out of scope.
      const rule = `rule-${t.sourceId}`;
      const base = {
        mapping_key: key,
        source: src,
        target: tgt,
        document_stage: 'registration' as const,
        rule_version: rule,
        reason: 'synthetic_mapping_ok',
      };
      const covering = await recordChapterMappingVersion(t.pool, base, 'operator-syn');
      const wrongStage = await recordChapterMappingVersion(
        t.pool,
        { ...base, mapping_key: `${key}.stage`, document_stage: 'issuance' },
        'operator-syn',
      );
      const wrongRule = await recordChapterMappingVersion(
        t.pool,
        { ...base, mapping_key: `${key}.rule`, rule_version: 'rule-other' },
        'operator-syn',
      );
      const wrongSource = await recordChapterMappingVersion(
        t.pool,
        { ...base, mapping_key: `${key}.src`, source: { ...src, offering: 'private' } },
        'operator-syn',
      );
      const otherTarget = await recordChapterMappingVersion(
        t.pool,
        { ...base, mapping_key: `${key}.tgt`, target: { ...tgt, offering: 'private' } },
        'operator-syn',
      );
      assert.equal(covering.version, 1);
      await assert.rejects(
        recordChapterMappingVersion(t.pool, { ...base, target: src }, 'operator-syn'),
        /cross market or offering/,
      );
      const ask = (target: Partial<LibraryQueryRequest['target']>) =>
        t.query(
          TOP3,
          { rule_version: rule, ...target },
          null,
          'reference-library-query-v1.1',
        ) as Promise<LibraryQueryResponseV1_1>;
      const szse = await ask({ market: 'szse', offering: 'public' });
      const cand = szse.candidates.find((c) => c.market === 'sse')!;
      assert.deepEqual(
        cand.chapter_mappings.map((m) => m.mapping_version_id),
        [covering.mapping_version_id],
      );
      assert.deepEqual(cand.chapter_mapping_versions, [covering.mapping_version_id]);
      assert.deepEqual(cand.chapter_mappings[0], {
        mapping_version_id: covering.mapping_version_id,
        mapping_key: key,
        version: 1,
        status: 'accepted',
        source: src,
        target: tgt,
        document_stage: 'registration',
        rule_version: rule,
      });
      for (const excluded of [wrongStage, wrongRule, wrongSource, otherTarget])
        assert.equal(
          cand.chapter_mapping_versions.includes(excluded.mapping_version_id),
          false,
          excluded.mapping_key,
        );
      // Same market/offering: no mapping needed and none returned; other target: only its own mapping.
      assert.deepEqual(
        (await ask({})).candidates.find((c) => c.market === 'sse')!.chapter_mappings,
        [],
      );
      assert.deepEqual(
        (await ask({ market: 'szse', offering: 'private' })).candidates.find(
          (c) => c.market === 'sse',
        )!.chapter_mapping_versions,
        [otherTarget.mapping_version_id],
      );
      // A withdrawn version leaves the response at once; a new version for the key takes its place.
      await withdrawChapterMappingVersion(
        t.pool,
        covering.mapping_version_id,
        'synthetic_withdraw',
        'operator-syn',
      );
      assert.deepEqual(
        (await ask({ market: 'szse', offering: 'public' })).candidates.find(
          (c) => c.market === 'sse',
        )!.chapter_mappings,
        [],
      );
      const v2 = await recordChapterMappingVersion(t.pool, base, 'operator-syn');
      assert.equal(v2.version, 2);
      assert.deepEqual(
        (await ask({ market: 'szse', offering: 'public' })).candidates.find(
          (c) => c.market === 'sse',
        )!.chapter_mapping_versions,
        [v2.mapping_version_id],
      );
      // Mapping versions are immutable apart from one withdrawal.
      await assert.rejects(
        t.pool.query(
          "UPDATE bb_library_chapter_mapping_versions SET target_offering='private' WHERE id=$1",
          [v2.mapping_version_id],
        ),
        /immutable/,
      );
      await assert.rejects(
        t.pool.query(
          "UPDATE bb_library_chapter_mapping_versions SET state='accepted',reason='x_again' WHERE id=$1",
          [covering.mapping_version_id],
        ),
        /immutable/,
      );
    } finally {
      await t.pool.end();
    }
  },
);

test('SSE adapter maps project list and prospectus files (recorded synthetic responses; no network)', async () => {
  const calls: string[] = [];
  const fake = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const json =
      u.searchParams.get('sqlId') === 'ZQ_XMLB'
        ? {
            pageHelp: {
              data:
                u.searchParams.get('pageHelp.pageNo') === '1'
                  ? [
                      {
                        BOND_NUM: 'p-new',
                        PUBLISH_DATE: '2026-09-24',
                        ISSUER_ID: '91000000000000000X',
                        FULL_NAME: '合成发行人A有限公司',
                        AUDIT_NAME: '合成发行人A有限公司2026年面向专业投资者公开发行公司债券',
                      },
                      {
                        BOND_NUM: 'p-old',
                        PUBLISH_DATE: '2026-09-01',
                        ISSUER_ID: '91000000000000001X',
                        FULL_NAME: '合成发行人B有限公司',
                        AUDIT_NAME: 'B',
                      },
                    ]
                  : [],
            },
          }
        : {
            result: [
              {
                FILE_TYPE: 11,
                FILE_VERSION: 2,
                FILE_TITLE: '1-1 合成募集说明书-2.pdf',
                FILE_PATH: '/bridge2/disclosure/announcement/c/202609/x2.pdf',
                FILE_TIME: '2026-09-24',
              },
              {
                FILE_TYPE: 11,
                FILE_VERSION: 1,
                FILE_TITLE: '1-1 合成募集说明书-1.pdf',
                FILE_PATH: '/bridge2/disclosure/announcement/c/202608/x1.pdf',
                FILE_TIME: '2026-08-01',
              },
              {
                FILE_TYPE: 31,
                FILE_VERSION: 1,
                FILE_TITLE: '3-1 主承销商核查意见.pdf',
                FILE_PATH: '/bridge2/y.pdf',
                FILE_TIME: '2026-08-01',
              },
            ],
          };
    return u.hostname === 'static.sse.com.cn'
      ? new Response('%PDF-1.4 synthetic', { status: 200 })
      : Response.json(json);
  };
  const adapter = new SseBondProjectAdapter({ fetch: fake, delayMs: 0, maxProjects: 5 });
  const d = await adapter.discover({ publish_date: '2026-09-10' }, {});
  assert.deepEqual(
    d.items.map((i) => i.itemKey),
    ['p-new:x1', 'p-new:x2'],
    'ordered by (FILE_TIME, FILE_VERSION); older-than-cursor projects and non-prospectus files skipped',
  );
  assert.deepEqual(d.cursorAfter, { publish_date: '2026-09-24' });
  assert.equal(
    d.items[0]!.issuerKey,
    '91000000000000000X',
    'issuer identity is the credit code, so same-name issuers are not merged',
  );
  assert.ok((await adapter.fetch(d.items[0]!)).subarray(0, 5).equals(Buffer.from('%PDF-')));
  await assert.rejects(
    adapter.fetch({ ...d.items[0]!, locator: 'https://evil.example/x.pdf' }),
    /LIBRARY_FETCH_FAILED/,
  );
  assert.ok(
    calls.every(
      (c) =>
        c.startsWith('https://query.sse.com.cn/') ||
        c.startsWith('https://static.sse.com.cn/bond/'),
    ),
  );
});

test(
  'Azurite-backed ingest stores bytes under library/ and verifies the hash on read',
  { skip: skip || !process.env.BB_TEST_AZURITE_CONNECTION_STRING },
  async () => {
    const pool = new Pool({ connectionString: connection });
    try {
      const blobs = azureBlobs(
        process.env.BB_TEST_AZURITE_CONNECTION_STRING!,
        `bb-library-${randomUUID()}`,
      );
      const sourceId = `syn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await registerLibrarySource(pool, {
        id: sourceId,
        kind: 'public_disclosure',
        displayName: 's',
        market: 'sse',
        authorizationBasis: 'synthetic',
        usageRights: 'evaluation_only',
      });
      const bytes = Buffer.from('%PDF-1.7 azurite synthetic');
      const first = await ingestLibraryVersion(pool, blobs, {
        sourceId,
        externalKey: 'az',
        issuerKey: 'az',
        issuerName: 'az',
        title: 'az',
        sourceRevision: '1',
        sourceRevisionRank: 1,
        bytes,
        mediaType: 'application/pdf',
      });
      const again = await ingestLibraryVersion(pool, blobs, {
        sourceId,
        externalKey: 'az',
        issuerKey: 'az',
        issuerName: 'az',
        title: 'az',
        sourceRevision: '1',
        sourceRevisionRank: 1,
        bytes,
        mediaType: 'application/pdf',
      });
      assert.equal(first.outcome, 'new_document');
      assert.equal(again.outcome, 'unchanged');
      assert.equal(again.versionId, first.versionId);
      const row = (
        await pool.query('SELECT blob_key, sha256 FROM bb_library_document_versions WHERE id=$1', [
          first.versionId,
        ])
      ).rows[0];
      assert.equal(
        row.blob_key,
        `library/${sourceId}/${createHash('sha256').update(`${sourceId}\u0000az`).digest('hex').slice(0, 32)}/${sha(bytes)}`,
      );
      assert.ok((await blobs.get(row.blob_key)).equals(bytes));
    } finally {
      await pool.end();
    }
  },
);

test(
  'harmless parser stderr no longer fails a version; the redacted diagnostic stays in the parse summary',
  { skip },
  async () => {
    const t = await setup();
    try {
      const diagnostic = {
        bytes: 42,
        truncated: false,
        classes: ['PDF_WRONG_POINTING_OBJECT' as const],
        unclassified_lines: 0,
        excerpt: 'Ignoring wrong pointing object 7 0 (offset 0)',
      };
      const logged: unknown[] = [];
      t.deps.log = (line) => {
        logged.push(line);
      };
      t.deps.parser = async (request, hooks) => {
        hooks?.onDiagnostic?.(diagnostic);
        return syntheticParser(request);
      };
      t.source.add('W', 1, 'w1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      const v = await t.versionOf('W', 1);
      assert.notEqual(v.state, 'failed');
      const summary = (
        await t.pool.query('SELECT parse_summary FROM bb_library_document_versions WHERE id=$1', [
          v.id,
        ])
      ).rows[0].parse_summary;
      assert.deepEqual(summary.parser_stderr, diagnostic);
      // A real failure still fails closed and the diagnostic rides along in the pipeline log.
      t.deps.parser = async (_request, hooks) => {
        hooks?.onDiagnostic?.(diagnostic);
        throw Object.assign(new Error('INVALID_PARSE_RESPONSE'), { name: 'DocumentParserError' });
      };
      t.source.add('X', 1, 'x1');
      await enqueueLibrarySync(t.pool, t.sourceId);
      await t.drain();
      assert.equal((await t.versionOf('X', 1)).state, 'failed');
      assert.ok(
        logged.some(
          (line) =>
            JSON.stringify(line).includes('"error":"INVALID_PARSE_RESPONSE"') &&
            JSON.stringify(line).includes('PDF_WRONG_POINTING_OBJECT'),
        ),
      );
    } finally {
      await t.pool.end();
    }
  },
);
