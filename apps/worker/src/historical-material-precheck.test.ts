import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Recognition } from '@bondbuddy/contracts';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { parsePersistAndRecognizeHistoricalMaterial, precheckHistoricalMaterial } from './historical-material-precheck.js';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';
import type { MaterialParserDependencies } from './material-parser.js';
import type { HistoricalProfileDependencies, HistoricalProfileClient } from './historical-profile-repository.js';
import { parseAndPersistAuthorizedMaterial, type ParseEvidenceClient, type ParseEvidenceDependencies } from './parse-evidence-repository.js';

const bytes = Buffer.from('synthetic historical prospectus text\n', 'utf8');
const row = {
  owner_user_id: 'owner-alice',
  project_id: 'project-history',
  id: 'material-history',
  version: 4,
  role: 'historical',
  media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  byte_size: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  object_key: 'private/users/owner-alice/project-history/material-history/v4',
};
const input = {
  ownerUserId: row.owner_user_id,
  projectId: row.project_id,
  materialId: row.id,
  version: row.version,
  requestId: 'precheck-history-v4',
  profileVersion: 9,
};

function recognizedParse(request: DocumentParseRequest, status: DocumentParseResponse['status'] = 'parsed'): DocumentParseResponse {
  const material = request.material;
  const snippets = [
    ['venue-cover', '本期债券发行场所：上海证券交易所。', '募集说明书封面'],
    ['venue-overview', '本期债券在上海证券交易所发行。', '本次发行概况'],
    ['offering-cover', '本期债券采取非公开发行方式。', '募集说明书封面'],
    ['offering-overview', '本期公司债券采用私募发行。', '本次发行概况'],
    ['financial-period', '合并财务报表报告期：2022年度、2023年度、2024年度。', '财务会计信息'],
  ] as const;
  return {
    schema_version: 'document-parse-response-v1',
    request_id: request.request_id,
    parser_version: 'synthetic-parser-1',
    status,
    material: {
      material_id: material.material_id,
      material_version: material.material_version,
      media_type: material.media_type,
      sha256: material.sha256,
    },
    records: status === 'failed' ? [] : snippets.map(([id, quote, context], index) => ({
      record_id: id,
      material_id: material.material_id,
      material_version: material.material_version,
      content_hash: material.sha256,
      locator_type: 'docx_block' as const,
      locator: { path: [{ paragraph: index + 1 }], stable_ref: `docx:p${String(index + 1).padStart(4, '0')}` },
      literal_quote: quote,
      context,
      extraction_method: 'native_text' as const,
      extractor_version: 'synthetic-parser-1',
      confidence: 1,
      uncertainty: [],
      formatting: {},
    })),
    warnings: status === 'needs_confirmation' ? [{ code: 'SCAN_NOT_OCRD', message: '合成扫描页未执行OCR' }] : [],
    document: status === 'failed' ? { page_count: null } : { page_count: null, revision_summary: { insertions: 0, deletions: 0 } },
    error: status === 'failed' ? { code: 'SYNTHETIC_PARSE_FAILURE', message: 'synthetic failure' } : null,
  };
}

function dependencies(options: {
  material?: typeof row | null;
  bytes?: Uint8Array | null;
  parser?: MaterialParserDependencies['parser'];
  onBytes?: () => void;
} = {}): MaterialParserDependencies {
  return {
    pool: {
      async query(sql, values) {
        assert.match(sql, /owner_user_id\s*=\s*\$1/);
        assert.match(sql, /project_id\s*=\s*\$2/);
        assert.match(sql, /version\s*=\s*\$4/);
        assert.match(sql, /role\s*=\s*\$5/);
        const material = options.material === undefined ? row : options.material;
        const matches = material !== null && values[0] === material.owner_user_id &&
          values[1] === material.project_id && values[2] === material.id && values[3] === material.version &&
          values[4] === 'historical' && material.role === 'historical' &&
          (material.media_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            material.media_type === 'application/pdf');
        return { rows: matches ? [material] : [] };
      },
    },
    blobs: {
      async getPrivate() {
        options.onBytes?.();
        return options.bytes === undefined ? bytes : options.bytes;
      },
    },
    ...(options.parser === undefined ? {} : { parser: options.parser }),
  };
}

test('precheck recognizes a synthetic historical-role version and returns no target project fields', async () => {
  let parserCalls = 0;
  const result = await precheckHistoricalMaterial(dependencies({
    parser: async (request) => { parserCalls += 1; return recognizedParse(request); },
  }), input);
  assert.equal(parserCalls, 1);
  assert.equal(result.state, 'ready');
  assert.equal(result.material_id, row.id);
  assert.equal(result.material_version, row.version);
  assert.equal(result.profile_version, input.profileVersion);
  assert.equal(result.source_market.value, 'sse');
  assert.equal(result.source_offering.value, 'private');
  assert.deepEqual(result.reporting_periods.map(period => period.end), ['2022-12-31', '2023-12-31', '2024-12-31']);
  assert.deepEqual(Object.keys(result).sort(), [
    'latest_reporting_cutoff', 'material_id', 'material_version', 'profile_version',
    'reporting_periods', 'source_market', 'source_offering', 'state',
  ].sort());
  assert.equal(JSON.stringify(result).includes('target_market'), false);
});

test('reference role and cross-owner material are denied before private bytes or Python parsing', async () => {
  let blobCalls = 0;
  let parserCalls = 0;
  const parser = async (request: DocumentParseRequest) => { parserCalls += 1; return recognizedParse(request); };
  await assert.rejects(precheckHistoricalMaterial(dependencies({
    material: { ...row, role: 'reference' }, onBytes: () => { blobCalls += 1; }, parser,
  }), input), /NOT_FOUND/);
  await assert.rejects(precheckHistoricalMaterial(dependencies({
    material: { ...row, owner_user_id: 'owner-bob' }, onBytes: () => { blobCalls += 1; }, parser,
  }), input), /NOT_FOUND/);
  assert.equal(blobCalls, 0);
  assert.equal(parserCalls, 0);
});

test('a mismatched database row role or non-prospectus media type fails before reading bytes', async () => {
  let blobCalls = 0;
  let parserCalls = 0;
  const deps = dependencies({ onBytes: () => { blobCalls += 1; }, parser: async (request) => {
    parserCalls += 1;
    return recognizedParse(request);
  } });
  // Simulate a faulty DB adapter that ignores the SQL predicate: the row-level
  // defense must still prevent reaching private storage.
  deps.pool.query = async () => ({ rows: [{ ...row, role: 'reference' }] });
  await assert.rejects(precheckHistoricalMaterial(deps, input), /MATERIAL_ROLE_MISMATCH/);

  await assert.rejects(precheckHistoricalMaterial(dependencies({
    material: { ...row, media_type: 'text/plain' }, onBytes: () => { blobCalls += 1; },
  }), input), /NOT_FOUND/);
  assert.equal(blobCalls, 0);
  assert.equal(parserCalls, 0);
});

test('failed and scan-pending parser states never become ready', async () => {
  for (const [status, expectedState] of [
    ['failed', 'failed'],
    ['needs_confirmation', 'needs_confirmation'],
  ] as const) {
    const result = await precheckHistoricalMaterial(dependencies({
      parser: async (request) => recognizedParse(request, status),
    }), input);
    assert.equal(result.state, expectedState);
  }
  const ambiguous = await precheckHistoricalMaterial(dependencies({
    parser: async (request) => ({ ...recognizedParse(request), records: recognizedParse(request).records.slice(0, 1) }),
  }), input);
  assert.equal(ambiguous.state, 'needs_confirmation');
});

test('invalid profile version fails before the authorized material lookup', async () => {
  let lookups = 0;
  const deps = dependencies({});
  deps.pool.query = async () => { lookups += 1; return { rows: [row] }; };
  await assert.rejects(precheckHistoricalMaterial(deps, { ...input, profileVersion: 0 }), /INVALID_PROFILE_VERSION/);
  assert.equal(lookups, 0);
});

class CompositionDatabase implements ParseEvidenceClient, HistoricalProfileClient {
  snapshots: Record<string, unknown>[] = [];
  evidence: Record<string, unknown>[] = [];
  requests: Record<string, unknown>[] = [];
  profiles: Record<string, unknown>[] = [];
  outbox: Record<string, unknown>[] = [];
  materialPresent = true;
  private rollbackState: unknown = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql === 'BEGIN') {
      this.rollbackState = structuredClone({ snapshots: this.snapshots, evidence: this.evidence, requests: this.requests, profiles: this.profiles, outbox: this.outbox });
      return { rows: [] };
    }
    if (sql === 'COMMIT') { this.rollbackState = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      if (this.rollbackState !== null) Object.assign(this, this.rollbackState);
      this.rollbackState = null; return { rows: [] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM bb_material_versions') && !sql.includes('JOIN bb_material_versions')) {
      const valid = this.materialPresent && values[0] === row.owner_user_id && values[1] === row.project_id &&
        values[2] === row.id && values[3] === row.version && (values[4] == null || values[4] === 'historical');
      return { rows: valid ? [row] : [] };
    }
    if (sql.includes('FROM bb_parse_snapshot_requests')) {
      return { rows: this.requests.filter(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
        item.material_id === values[2] && item.material_version === values[3] && item.request_id === values[4]) };
    }
    if (sql.startsWith('SELECT response_sha256 FROM bb_parse_snapshots')) {
      const found = this.snapshots.find(item => item.id === values[4]);
      return { rows: found ? [{ response_sha256: found.response_sha256 }] : [] };
    }
    if (sql.includes('SELECT s.parser_version, s.response_status')) {
      const snapshot = this.snapshots.find(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
        item.material_id === values[2] && item.material_version === values[3] && item.parser_version === values[4]);
      if (!snapshot) return { rows: [] };
      const refs = values[5] as string[];
      const entries = this.evidence.filter(item => item.snapshot_id === snapshot.id && (refs.length === 0 || refs.includes(String(item.record_id))));
      return { rows: (entries.length ? entries : [null]).map(item => ({ parser_version: snapshot.parser_version,
        response_status: snapshot.response_status, record_count: snapshot.record_count, record_id: item?.record_id ?? null,
        extractor_version: item?.extractor_version ?? null, extraction_method: item?.extraction_method ?? null })) };
    }
    if (sql.includes('FROM bb_parse_snapshots')) {
      if (!this.materialPresent) return { rows: [] };
      if (sql.includes('SELECT id, request_hash, response_sha256')) {
        const found = this.snapshots.filter(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
          item.material_id === values[2] && item.material_version === values[3] && item.parser_version === values[4]);
        return { rows: found };
      }
      const found = this.snapshots.filter(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
        item.material_id === values[2] && item.material_version === values[3] &&
        (sql.includes('parser_version=$5') || sql.includes('parser_version = $5') ? item.parser_version === values[4] : item.id === values[4]));
      return { rows: found };
    }
    if (sql.includes('FROM bb_parse_evidence')) {
      const selected = this.evidence.filter(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
        item.material_id === values[2] && item.material_version === values[3] && item.snapshot_id === values[4]);
      return { rows: selected.sort((a, b) => Number(a.ordinal) - Number(b.ordinal)) };
    }
    if (sql.startsWith('INSERT INTO bb_parse_snapshots')) {
      const saved = { id: values[0], owner_user_id: values[1], project_id: values[2], material_id: values[3], material_version: values[4],
        content_sha256: values[5], parser_version: values[6], request_hash: values[7], request_options: JSON.parse(String(values[8])),
        response_status: values[9], response_schema_version: values[10], response_sha256: values[11], record_count: values[12],
        response_meta: JSON.parse(String(values[13])), created_at: new Date('2026-09-24T00:00:00Z') };
      this.snapshots.push(saved); return { rows: [saved] };
    }
    if (sql.startsWith('INSERT INTO bb_parse_evidence')) {
      this.evidence.push({ owner_user_id: values[0], project_id: values[1], material_id: values[2], material_version: values[3],
        snapshot_id: values[4], record_id: values[5], content_sha256: values[6], locator_type: values[7], locator: JSON.parse(String(values[8])),
        literal_quote: values[9], context: values[10], extraction_method: values[11], extractor_version: values[12], confidence: values[13],
        uncertainty: JSON.parse(String(values[14])), formatting: JSON.parse(String(values[15])), record_sha256: values[16], ordinal: values[17] });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO bb_parse_snapshot_requests')) {
      this.requests.push({ owner_user_id: values[0], project_id: values[1], material_id: values[2], material_version: values[3],
        request_id: values[4], request_hash: values[5], snapshot_id: values[6] }); return { rows: [] };
    }
    if (sql.includes('FROM bb_historical_profiles') && sql.includes('request_id = $5')) {
      return { rows: this.profiles.filter(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
        item.material_id === values[2] && item.material_version === values[3] && item.request_id === values[4]) };
    }
    if (sql.includes("write_kind='recognition'")) {
      return { rows: this.profiles.filter(item => item.write_kind === 'recognition' && item.owner_user_id === values[0] &&
        item.project_id === values[1] && item.material_id === values[2] && item.material_version === values[3] &&
        (item.recognition as Record<string, any>).source_market.provenance.extractor_version === values[4]) };
    }
    if (sql.includes('COALESCE(max(profile_version)')) {
      const selected = this.profiles.filter(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
        item.material_id === values[2] && item.material_version === values[3]);
      return { rows: [{ profile_version: selected.length ? Math.max(...selected.map(item => Number(item.profile_version))) : 0,
        has_correction: selected.some(item => item.write_kind === 'correction') }] };
    }
    if (sql.startsWith('INSERT INTO bb_historical_profiles')) {
      const saved = { owner_user_id: values[0], project_id: values[1], material_id: values[2], material_version: values[3],
        profile_version: values[4], request_id: values[5], request_hash: values[6], write_kind: values[7],
        recognition: JSON.parse(String(values[8])), actor_id: values[9], correction_reason: values[10],
        correction_evidence_refs: JSON.parse(String(values[11])), created_at: new Date('2026-09-24T00:00:00Z') };
      this.profiles.push(saved); return { rows: [saved] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) { this.outbox.push({ id: values[0], owner_user_id: values[1], aggregate_id: values[2] }); return { rows: [] }; }
    if (sql.includes('JOIN bb_material_versions')) {
      const selected = this.profiles.filter(item => item.owner_user_id === values[0] && item.project_id === values[1] &&
        item.material_id === values[2] && item.material_version === values[3]);
      return { rows: sql.includes('ORDER BY p.profile_version DESC LIMIT 1') ? selected.slice(-1) : selected };
    }
    throw new Error(`unexpected composition SQL: ${sql}`);
  }
  release(): void {}
}

function parseWithHalfYear(request: DocumentParseRequest): DocumentParseResponse {
  const parsed = recognizedParse(request);
  const financial = parsed.records.find(record => record.record_id === 'financial-period')!;
  return { ...parsed, records: [...parsed.records, {
    ...financial, record_id: 'financial-half-year', literal_quote: '2025年半年度', context: '合并财务报表',
    locator: { path: [{ paragraph: 6 }], stable_ref: 'docx:p0006' },
  }] };
}

function legacyV1Recognition(response: DocumentParseResponse): Recognition {
  const current = recognizeHistoricalNativeText(response, { profileVersion: 1 });
  const periods = current.reporting_periods.filter(period => period.end !== '2025-06-30');
  const latestPeriod = periods.reduce((latest, period) => period.end! > latest.end! ? period : latest);
  const legacyVersion = (value: string | null) => {
    if (value === null) throw new Error('synthetic recognition must have native parser provenance');
    return value.replace(/^historical-native-recognition-v3\//, 'historical-native-recognition-v1/');
  };
  return {
    ...current,
    profile_version: 1,
    source_market: { ...current.source_market, provenance: { ...current.source_market.provenance,
      extractor_version: legacyVersion(current.source_market.provenance.extractor_version) } },
    source_offering: { ...current.source_offering, provenance: { ...current.source_offering.provenance,
      extractor_version: legacyVersion(current.source_offering.provenance.extractor_version) } },
    reporting_periods: periods.map(period => ({ ...period,
      provenance: { ...period.provenance, extractor_version: legacyVersion(period.provenance.extractor_version) } })),
    latest_reporting_cutoff: { ...current.latest_reporting_cutoff, value: latestPeriod.end, raw_value: latestPeriod.raw_value,
      provenance: { ...latestPeriod.provenance,
        extractor_version: legacyVersion(latestPeriod.provenance.extractor_version) } },
  } as Recognition;
}

function seedProfile(db: CompositionDatabase, recognition: Recognition, writeKind: 'recognition' | 'correction'): void {
  db.profiles.push({ owner_user_id: row.owner_user_id, project_id: row.project_id, material_id: row.id,
    material_version: row.version, profile_version: recognition.profile_version, request_id: `legacy-${writeKind}`,
    write_kind: writeKind, recognition, actor_id: writeKind === 'correction' ? 'user-synthetic' : null,
    correction_reason: writeKind === 'correction' ? 'synthetic legacy correction' : null,
    correction_evidence_refs: [], created_at: new Date('2026-09-24T00:00:00Z') });
}

test('reruns a v1 recognition under v3 and adds the newly recognized half-year period', async () => {
  const db = new CompositionDatabase();
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-history-v2-rerun-'));
  let parserCalls = 0;
  const deps: MaterialParserDependencies = {
    ...dependencies({ parser: async request => { parserCalls += 1; return parseWithHalfYear(request); } }),
    pool: { query: (sql, values) => db.query(sql, values) },
    blobs: { async getPrivate() { return bytes; } }, tempRoot: process.platform === 'win32' ? undefined : tempRoot,
  };
  const evidence: ParseEvidenceDependencies = { pool: { connect: async () => db, query: (sql, values) => db.query(sql, values) }, newId: () => 'legacy-snapshot' };
  const profiles: HistoricalProfileDependencies = { pool: { connect: async () => db, query: (sql, values) => db.query(sql, values) }, newId: () => 'v2-profile-event' };
  try {
    const oldSnapshot = await parseAndPersistAuthorizedMaterial(deps, evidence, { ...input, requestId: 'legacy-parse', requiredRole: 'historical' });
    seedProfile(db, legacyV1Recognition(oldSnapshot.response), 'recognition');
    assert.deepEqual((db.profiles[0]!.recognition as Recognition).reporting_periods.map(period => period.end),
      ['2022-12-31', '2023-12-31', '2024-12-31']);

    const upgraded = await parsePersistAndRecognizeHistoricalMaterial({ material: deps, evidence, profiles, parserVersion: 'synthetic-parser-1' },
      { ...input, requestId: 'v2-recognition-rerun' });
    assert.equal(upgraded.parseSnapshot.snapshotId, oldSnapshot.snapshotId);
    assert.equal(upgraded.profile.profileVersion, 2);
    assert.deepEqual(upgraded.profile.recognition.reporting_periods.map(period => period.end),
      ['2022-12-31', '2023-12-31', '2024-12-31', '2025-06-30']);
    assert.equal(upgraded.profile.recognition.latest_reporting_cutoff.value, '2025-06-30');
    assert.match(upgraded.profile.recognition.source_market.provenance.extractor_version!,
      /^historical-native-recognition-v3\//);
    assert.equal(parserCalls, 1, 'v2 can recognize the immutable parser snapshot without reparsing the same bytes');
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});

test('precheck recovers a corrected v1 profile without rerunning recognition or replacing the correction', async () => {
  const db = new CompositionDatabase();
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-history-v1-correction-'));
  let parserCalls = 0;
  const deps: MaterialParserDependencies = {
    ...dependencies({ parser: async request => { parserCalls += 1; return recognizedParse(request); } }),
    pool: { query: (sql, values) => db.query(sql, values) },
    blobs: { async getPrivate() { return bytes; } }, tempRoot: process.platform === 'win32' ? undefined : tempRoot,
  };
  const evidence: ParseEvidenceDependencies = { pool: { connect: async () => db, query: (sql, values) => db.query(sql, values) }, newId: () => 'corrected-legacy-snapshot' };
  const profiles: HistoricalProfileDependencies = { pool: { connect: async () => db, query: (sql, values) => db.query(sql, values) }, newId: () => 'legacy-correction-event' };
  try {
    const oldSnapshot = await parseAndPersistAuthorizedMaterial(deps, evidence, { ...input, requestId: 'corrected-legacy-parse', requiredRole: 'historical' });
    const recognition = legacyV1Recognition(oldSnapshot.response);
    recognition.state = 'needs_confirmation';
    recognition.source_market = { ...recognition.source_market, value: 'szse', status: 'user_asserted',
      provenance: { ...recognition.source_market.provenance, method: 'user_correction' },
      uncertainty: ['synthetic user correction'] };
    seedProfile(db, recognition, 'correction');

    const recovered = await parsePersistAndRecognizeHistoricalMaterial({ material: deps, evidence, profiles, parserVersion: 'synthetic-parser-1' },
      { ...input, requestId: 'corrected-profile-recovery', options: { max_pages: 2 } });
    assert.equal(recovered.parseSnapshot.snapshotId, oldSnapshot.snapshotId);
    assert.equal(recovered.profile.writeKind, 'correction');
    assert.equal(recovered.profile.profileVersion, 1);
    assert.equal(recovered.profile.recognition.source_market.value, 'szse');
    assert.equal(recovered.profile.recognition.source_market.status, 'user_asserted');
    assert.match(recovered.profile.recognition.source_market.provenance.extractor_version!,
      /^historical-native-recognition-v1\//);
    assert.equal(db.profiles.length, 1);
    assert.equal(parserCalls, 1, 'recovery reads original evidence and does not run recognition again');
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});

test('trusted composition persists the parse snapshot before profile, reuses exact-version snapshots and fails closed on version changes', async () => {
  const db = new CompositionDatabase();
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-history-composition-'));
  let parserCalls = 0;
  let blobReads = 0;
  const deps: MaterialParserDependencies = {
    ...dependencies({ parser: async request => { parserCalls += 1; return recognizedParse(request); } }),
    pool: { query: (sql, values) => db.query(sql, values) },
    blobs: { async getPrivate() { blobReads += 1; return bytes; } },
    // Managed flock-based staging is Linux-only; this test verifies composition, not flock.
    tempRoot: process.platform === 'win32' ? undefined : tempRoot,
  };
  const shared = {
    material: deps,
    evidence: { pool: { connect: async () => db, query: (sql, values) => db.query(sql, values) }, newId: () => 'snapshot-id-1' } satisfies ParseEvidenceDependencies,
    profiles: { pool: { connect: async () => db, query: (sql, values) => db.query(sql, values) }, newId: () => 'profile-event-1' } satisfies HistoricalProfileDependencies,
    parserVersion: 'synthetic-parser-1',
  };
  try {
    const first = await parsePersistAndRecognizeHistoricalMaterial(shared, input);
    assert.equal(first.parseSnapshot.snapshotId, 'snapshot-id-1');
    assert.equal(first.profile.recognition.state, 'ready');
    assert.equal(db.evidence.length, 5);
    assert.equal(parserCalls, 1);
    const replay = await parsePersistAndRecognizeHistoricalMaterial(shared, { ...input, requestId: 'new-job-same-version' });
    assert.equal(replay.profile.profileVersion, first.profile.profileVersion);
    assert.equal(replay.parseSnapshot.snapshotId, first.parseSnapshot.snapshotId);
    assert.equal(parserCalls, 1, 'a matching parser version and option set reuses the stored snapshot');
    assert.equal(blobReads, 1);
    await assert.rejects(parsePersistAndRecognizeHistoricalMaterial(shared, { ...input, ownerUserId: 'owner-bob', requestId: 'foreign-job' }), /NOT_FOUND/);
    assert.equal(parserCalls, 1, 'foreign owner is rejected before parsing');
    await assert.rejects(parsePersistAndRecognizeHistoricalMaterial({ ...shared, parserVersion: 'new-parser-version' },
      { ...input, requestId: 'new-parser-job' }), /PARSER_VERSION_MISMATCH/);
    assert.equal(parserCalls, 2, 'a deployment parser version change must parse again');
    await assert.rejects(parsePersistAndRecognizeHistoricalMaterial(shared,
      { ...input, requestId: 'different-options-job', options: { max_pages: 3 } }), /PARSE_SNAPSHOT_INPUT_MISMATCH/);
    assert.equal(parserCalls, 3, 'different parse options cannot reuse the old snapshot');

    for (const [status, expected] of [['needs_confirmation', 'needs_confirmation'], ['failed', 'failed']] as const) {
      const otherDb = new CompositionDatabase();
      const otherMaterialDeps: MaterialParserDependencies = {
        ...deps,
        pool: { query: (sql, values) => otherDb.query(sql, values) },
        parser: async request => { return recognizedParse(request, status); },
      };
      const other = await parsePersistAndRecognizeHistoricalMaterial({
        ...shared,
        material: otherMaterialDeps,
        evidence: { pool: { connect: async () => otherDb, query: (sql, values) => otherDb.query(sql, values) }, newId: () => `snapshot-${status}` },
        profiles: { pool: { connect: async () => otherDb, query: (sql, values) => otherDb.query(sql, values) }, newId: () => `profile-${status}` },
      }, { ...input, requestId: `status-${status}` });
      assert.equal(other.profile.recognition.state, expected);
      if (status === 'failed') assert.equal(otherDb.evidence.length, 0);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
