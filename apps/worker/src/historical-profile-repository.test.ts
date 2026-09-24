import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { Recognition } from '@bondbuddy/contracts';
import {
  appendHistoricalRecognition,
  correctHistoricalRecognition,
  getLatestHistoricalProfile,
  listHistoricalProfileHistory,
  type HistoricalProfileClient,
  type HistoricalProfileDependencies,
  type HistoricalProfilePool,
  type TrustedHistoricalCorrectionContext,
} from './historical-profile-repository.js';

const owner = 'owner-synthetic';
const project = 'project-synthetic';
const material = 'material-synthetic';
const request = 'recognition-job-synthetic';
const context: TrustedHistoricalCorrectionContext = {
  ownerUserId: owner, projectId: project, materialId: material, materialVersion: 2,
  requestId: request, actorId: 'user-synthetic',
};

function makeRecognition(overrides: Partial<Recognition> = {}): Recognition {
  const provenance = { material_id: overrides.material_id ?? material, material_version: overrides.material_version ?? 2, method: 'native_text' as const,
    extractor_version: 'historical-native-recognition-v1/parser-synthetic-1', evidence_refs: ['evidence-market', 'evidence-offering', 'evidence-period'] };
  const periodProvenance = { ...provenance, extractor_version: 'historical-native-recognition-v1/parser-synthetic-1', evidence_refs: ['evidence-period'] };
  const recognized = <T extends string>(value: T) => ({ value, raw_value: value, provenance,
    uncertainty: [], status: 'recognized' as const });
  return {
    material_id: material,
    material_version: 2,
    profile_version: 1,
    state: 'ready',
    source_market: recognized('sse'),
    source_offering: recognized('private'),
    reporting_periods: [{ start: '2022-01-01', end: '2022-12-31', period_kind: 'annual', scope: 'consolidated',
      raw_value: '2022 年度', provenance: periodProvenance, uncertainty: [], status: 'recognized' }],
    latest_reporting_cutoff: recognized('2022-12-31'),
    ...overrides,
  } as Recognition;
}

class ProfileMock implements HistoricalProfileClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly rows: Record<string, unknown>[] = [];
  readonly outbox: Record<string, unknown>[] = [];
  failOutbox = false;
  released = false;
  private before: { rows: Record<string, unknown>[]; outbox: Record<string, unknown>[] } | null = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') { this.before = { rows: structuredClone(this.rows), outbox: structuredClone(this.outbox) }; return { rows: [] }; }
    if (sql === 'COMMIT') { this.before = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      if (this.before) {
        this.rows.splice(0, this.rows.length, ...this.before.rows);
        this.outbox.splice(0, this.outbox.length, ...this.before.outbox);
      }
      this.before = null; return { rows: [] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM bb_parse_snapshots')) {
      if (values[4] === 'parser-failed-1') return { rows: [{ parser_version: 'parser-failed-1',
        response_status: 'failed', record_count: 0, record_id: null, extractor_version: null, extraction_method: null }] };
      if (values[4] !== 'parser-synthetic-1') return { rows: [] };
      const evidenceRefs = ['evidence-market', 'evidence-offering', 'evidence-period',
        'period-2022', 'period-2023', 'period-2024', 'period-2025q1'];
      const selected = values[5] as string[];
      const filtered = selected.length ? evidenceRefs.filter(ref => selected.includes(ref)) : [];
      if (selected.length && filtered.length !== selected.length) return { rows: [] };
      return { rows: (filtered.length ? filtered : [null]).map(record_id => ({ parser_version: 'parser-synthetic-1',
        response_status: 'parsed', record_count: 3, record_id,
        extractor_version: 'parser-synthetic-1', extraction_method: 'native_text' })) };
    }
    if (sql.includes('SELECT DISTINCT e.record_id FROM bb_parse_evidence')) {
      const available = new Set(['evidence-market', 'evidence-offering', 'evidence-period',
        'period-2022', 'period-2023', 'period-2024', 'period-2025q1']);
      return { rows: (values[5] as string[]).filter(ref => available.has(ref)).map(record_id => ({ record_id })) };
    }
    if (sql.includes('FROM bb_material_versions')) {
      return { rows: values[0] === owner && values[1] === project && values[2] === material && values[3] === 2 ? [{ ok: 1 }] : [] };
    }
    if (sql.includes('FROM bb_historical_profiles') && sql.includes('request_id = $5')) {
      return { rows: this.rows.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3] && row.request_id === values[4]) };
    }
    if (sql.includes("write_kind='recognition'")) {
      return { rows: this.rows.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3] && row.write_kind === 'recognition' &&
        (row.recognition as Recognition).source_market.provenance.extractor_version === values[4]) };
    }
    if (sql.includes('FROM bb_historical_profiles') && sql.includes('COALESCE(max(profile_version)')) {
      const matching = this.rows.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3]);
      return { rows: [{ profile_version: matching.reduce((max, row) => Math.max(max, Number(row.profile_version)), 0),
        has_correction: matching.some(row => row.write_kind === 'correction') }] };
    }
    if (sql.includes('FROM bb_historical_profiles') && sql.includes('ORDER BY profile_version DESC LIMIT 1 FOR UPDATE')) {
      const matching = this.rows.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3]).sort((a, b) => Number(b.profile_version) - Number(a.profile_version));
      return { rows: matching.slice(0, 1) };
    }
    if (sql.startsWith('INSERT INTO bb_historical_profiles')) {
      const row = {
        owner_user_id: values[0], project_id: values[1], material_id: values[2], material_version: values[3],
        profile_version: values[4], request_id: values[5], request_hash: values[6], write_kind: values[7],
        recognition: JSON.parse(String(values[8])) as Recognition, actor_id: values[9], correction_reason: values[10],
        correction_evidence_refs: JSON.parse(String(values[11])) as string[], created_at: new Date('2026-09-24T00:00:00Z'),
      };
      this.rows.push(row); return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.outbox.push({ id: values[0], owner_user_id: values[1], aggregate_id: values[2], event_type: 'historical_profile.updated',
        payload: JSON.parse(String(values[3])) }); return { rows: [] };
    }
    if (sql.includes('JOIN bb_material_versions')) {
      const matching = this.rows.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3]);
      if (sql.includes('ORDER BY p.profile_version DESC LIMIT 1')) return { rows: matching.slice(-1).reverse() };
      return { rows: matching };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  release(): void { this.released = true; }
}

function dependencies(client: ProfileMock): HistoricalProfileDependencies {
  let id = 0;
  return { pool: { connect: async () => client, query: (sql, values) => client.query(sql, values) },
    newId: () => `outbox-synthetic-${++id}` };
}

test('recognition is contracts-validated, evidence-bound, sequenced and idempotent by extractor version', async () => {
  const client = new ProfileMock();
  const deps = dependencies(client);
  const input = makeRecognition();
  const first = await appendHistoricalRecognition(deps, context, input);
  const replay = await appendHistoricalRecognition(deps, context, { ...input, profile_version: 99 });
  assert.equal(first.profileVersion, 1);
  assert.equal(replay.replayed, true);
  assert.equal(client.rows.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.equal(input.profile_version, 1, 'repository must not mutate the caller-owned recognition object');
  assert.match(client.calls.find(call => call.sql.includes('FROM bb_material_versions'))!.sql,
    /owner_user_id = \$1 AND project_id = \$2 AND id = \$3 AND version = \$4[\s\S]*role = 'historical'[\s\S]*deleted_at IS NULL/);

  const next = await appendHistoricalRecognition(deps, { ...context, requestId: 'recognition-retry-new-job' }, makeRecognition());
  assert.equal(next.profileVersion, 1);
  assert.equal(next.replayed, true);
  assert.equal(client.rows.length, 1);
  await assert.rejects(appendHistoricalRecognition(deps, { ...context, requestId: 'recognition-conflict-new-job' },
    makeRecognition({ source_market: { ...makeRecognition().source_market, raw_value: 'different' } })), /HISTORICAL_PROFILE_EXTRACTOR_RESULT_CONFLICT/);
});

test('cannot store a forged ready profile with unresolved or missing evidence', async () => {
  const client = new ProfileMock();
  const ambiguous = makeRecognition({ source_offering: { ...makeRecognition().source_offering,
    value: null, status: 'needs_confirmation', uncertainty: ['类型不确定'] } });
  await assert.rejects(appendHistoricalRecognition(dependencies(client), context, ambiguous), /UNSUPPORTED_READY_PROFILE/);
  assert.equal(client.calls.length, 0);
  const missingEvidence = makeRecognition({ latest_reporting_cutoff: { ...makeRecognition().latest_reporting_cutoff,
    provenance: { ...makeRecognition().latest_reporting_cutoff.provenance, evidence_refs: [] } } });
  await assert.rejects(appendHistoricalRecognition(dependencies(client), context, missingEvidence), /UNSUPPORTED_READY_PROFILE/);
  const nonLatestCutoff = makeRecognition({ latest_reporting_cutoff: { ...makeRecognition().latest_reporting_cutoff, value: '2021-12-31' } });
  await assert.rejects(appendHistoricalRecognition(dependencies(client), context, nonLatestCutoff), /UNSUPPORTED_READY_PROFILE/);
  const reversedPeriod = makeRecognition({ reporting_periods: [{ ...makeRecognition().reporting_periods[0]!,
    start: '2023-01-01', end: '2022-12-31' }] });
  await assert.rejects(appendHistoricalRecognition(dependencies(client), context, reversedPeriod), /UNSUPPORTED_READY_PROFILE/);
  const crossMaterialEvidence = makeRecognition({ source_market: { ...makeRecognition().source_market,
    provenance: { ...makeRecognition().source_market.provenance, material_id: 'foreign-material' } } });
  await assert.rejects(appendHistoricalRecognition(dependencies(client), context, crossMaterialEvidence), /HISTORICAL_PROFILE_EVIDENCE_MATERIAL_MISMATCH/);
  const mixedParser = makeRecognition({ reporting_periods: [{ ...makeRecognition().reporting_periods[0]!,
    provenance: { ...makeRecognition().reporting_periods[0]!.provenance,
      extractor_version: 'historical-native-recognition-v1/different-parser' } }] });
  await assert.rejects(appendHistoricalRecognition(dependencies(client), context, mixedParser), /HISTORICAL_PROFILE_PARSER_VERSION_UNRELIABLE/);
});

test('a failed parser snapshot with zero references remains a persisted failed profile', async () => {
  const client = new ProfileMock();
  const base = makeRecognition();
  const failedField = <T extends string>(field: Recognition['source_market' | 'source_offering' | 'latest_reporting_cutoff']) => ({ ...field, value: null as T | null,
    provenance: { ...field.provenance, extractor_version: 'historical-native-recognition-v1/parser-failed-1', evidence_refs: [] },
    uncertainty: ['解析失败'], status: 'unknown' as const });
  const failed = { ...base, state: 'failed' as const, source_market: failedField(base.source_market),
    source_offering: failedField(base.source_offering), reporting_periods: [],
    latest_reporting_cutoff: failedField(base.latest_reporting_cutoff) } as Recognition;
  const stored = await appendHistoricalRecognition(dependencies(client), context, failed);
  assert.equal(stored.recognition.state, 'failed');
  assert.equal(stored.profileVersion, 1);
});

test('source correction appends a user-asserted version and preserves the original snapshot', async () => {
  const client = new ProfileMock();
  const deps = dependencies(client);
  const original = await appendHistoricalRecognition(deps, context, makeRecognition());
  const patch = { profile_version: 1, source_market: 'szse', source_offering: 'public',
    reason: '合成测试：原稿封面与发行概况相互印证', evidence_refs: ['evidence-market'] };
  const correctionContext = { ...context, requestId: 'correction-request-1' };
  const corrected = await correctHistoricalRecognition(deps, correctionContext, patch);
  const replay = await correctHistoricalRecognition(deps, correctionContext, patch);
  assert.equal(corrected.profileVersion, 2);
  assert.equal(corrected.writeKind, 'correction');
  assert.equal(corrected.actorId, context.actorId);
  assert.equal(corrected.correctionReason, patch.reason);
  assert.deepEqual(corrected.correctionEvidenceRefs, patch.evidence_refs);
  assert.equal(corrected.recognition.source_market.value, 'szse');
  assert.equal(corrected.recognition.source_market.status, 'user_asserted');
  assert.equal(corrected.recognition.source_market.provenance.method, 'user_correction');
  assert.equal(corrected.recognition.source_market.provenance.extractor_version,
    'historical-native-recognition-v1/parser-synthetic-1', 'correction preserves the legacy algorithm/parser provenance');
  assert.deepEqual(corrected.recognition.source_market.provenance.evidence_refs, patch.evidence_refs);
  assert.equal(corrected.recognition.state, 'needs_confirmation', 'caller refs are not server-validated evidence');
  assert.equal(original.recognition.source_market.value, 'sse');
  assert.equal((client.rows[0]!.recognition as Recognition).source_market.value, 'sse');
  assert.equal(replay.replayed, true);
  assert.equal(client.rows.length, 2);
  assert.equal(client.outbox.length, 2);
  await assert.rejects(appendHistoricalRecognition(deps, { ...context, requestId: 'late-recognition-after-correction' },
    makeRecognition({ profile_version: 3 })), /HISTORICAL_PROFILE_ALREADY_CORRECTED/);
});

test('correction requires latest profile version and empty refs cannot create ready', async () => {
  const client = new ProfileMock();
  const deps = dependencies(client);
  await appendHistoricalRecognition(deps, context, makeRecognition());
  await correctHistoricalRecognition(deps, { ...context, requestId: 'correction-no-evidence' }, {
    profile_version: 1, source_market: 'szse', source_offering: 'public', reason: '用户提出的新说法', evidence_refs: [],
  });
  assert.equal((client.rows[1]!.recognition as Recognition).state, 'needs_confirmation');
  await assert.rejects(correctHistoricalRecognition(deps, { ...context, requestId: 'correction-stale' }, {
    profile_version: 1, source_market: 'sse', source_offering: 'private', reason: '过期版本', evidence_refs: ['evidence-market'],
  }), /HISTORICAL_PROFILE_VERSION_CONFLICT/);
  await assert.rejects(correctHistoricalRecognition(deps, { ...context, requestId: 'correction-forged-ref' }, {
    profile_version: 1, source_market: 'sse', source_offering: 'private', reason: '伪造引用', evidence_refs: ['arbitrary-id'],
  }), /HISTORICAL_PROFILE_CORRECTION_EVIDENCE_NOT_FOUND/);
});

test('period-only correction replaces 2022-2024 with 2022-2025 Q1 and keeps source recognition unchanged', async () => {
  const client = new ProfileMock();
  const deps = dependencies(client);
  const original = await appendHistoricalRecognition(deps, context, makeRecognition({
    reporting_periods: [2022, 2023, 2024].map(year => ({
      start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual' as const, scope: 'consolidated' as const,
      raw_value: `${year} 年度`, provenance: { ...makeRecognition().reporting_periods[0]!.provenance,
        evidence_refs: [`period-${year}`] }, uncertainty: [], status: 'recognized' as const,
    })),
    latest_reporting_cutoff: { ...makeRecognition().latest_reporting_cutoff, value: '2024-12-31' },
  }));
  const oldMarket = structuredClone(original.recognition.source_market);
  const oldOffering = structuredClone(original.recognition.source_offering);
  const patch = {
    profile_version: original.profileVersion,
    reporting_periods: [
      { start: '2022-01-01', end: '2022-12-31', period_kind: 'annual', scope: 'consolidated', evidence_refs: ['period-2022'] },
      { start: '2023-01-01', end: '2023-12-31', period_kind: 'annual', scope: 'consolidated', evidence_refs: ['period-2023'] },
      { start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated', evidence_refs: ['period-2024'] },
      { start: '2025-01-01', end: '2025-03-31', period_kind: 'interim', scope: 'consolidated', evidence_refs: ['period-2025q1'] },
    ],
    reason: 'synthetic correction: latest financial statement is 2025 Q1', evidence_refs: [],
  };
  const correctionContext = { ...context, requestId: 'correction-period-only-2025q1' };
  const corrected = await correctHistoricalRecognition(deps, correctionContext, patch);
  const replay = await correctHistoricalRecognition(deps, correctionContext, patch);
  assert.equal(corrected.profileVersion, 2);
  assert.equal(corrected.recognition.source_market.value, 'sse');
  assert.deepEqual(corrected.recognition.source_market, oldMarket);
  assert.deepEqual(corrected.recognition.source_offering, oldOffering);
  assert.deepEqual(corrected.recognition.reporting_periods.map(period => period.end),
    ['2022-12-31', '2023-12-31', '2024-12-31', '2025-03-31']);
  assert.equal(corrected.recognition.latest_reporting_cutoff.value, '2025-03-31');
  assert.equal(corrected.recognition.latest_reporting_cutoff.status, 'user_asserted');
  assert.deepEqual(corrected.recognition.latest_reporting_cutoff.provenance.evidence_refs.sort(),
    ['period-2022', 'period-2023', 'period-2024', 'period-2025q1']);
  assert.ok(corrected.recognition.reporting_periods.every(period => period.status === 'user_asserted' &&
    period.uncertainty.length > 0 && period.provenance.method === 'user_correction'));
  assert.ok(corrected.recognition.latest_reporting_cutoff.uncertainty.length > 0);
  assert.equal(corrected.recognition.state, 'needs_confirmation');
  assert.equal(replay.replayed, true);
  assert.equal(client.rows.length, 2);
  assert.equal(client.outbox.length, 2);
  await assert.rejects(correctHistoricalRecognition(deps, { ...context, requestId: 'correction-forged-period-ref' }, {
    ...patch, profile_version: 2, reporting_periods: [{ ...patch.reporting_periods[0]!, evidence_refs: ['forged-period-anchor'] }],
  }), /HISTORICAL_PROFILE_CORRECTION_EVIDENCE_NOT_FOUND/);
  await assert.rejects(correctHistoricalRecognition(deps, { ...context, requestId: 'correction-stale-period' }, {
    ...patch, profile_version: 1,
  }), /HISTORICAL_PROFILE_VERSION_CONFLICT/);
});

test('period correction with an incomplete period leaves latest cutoff unknown and marks uncertainty per period', async () => {
  const client = new ProfileMock();
  const deps = dependencies(client);
  await appendHistoricalRecognition(deps, context, makeRecognition());
  const corrected = await correctHistoricalRecognition(deps, { ...context, requestId: 'correction-incomplete-period' }, {
    profile_version: 1,
    reporting_periods: [
      { start: '2022-01-01', end: '2022-12-31', period_kind: 'annual', scope: 'consolidated', evidence_refs: [] },
      { start: '2025-01-01', end: null, period_kind: 'interim', scope: 'consolidated', evidence_refs: ['evidence-period'] },
    ],
    reason: 'synthetic incomplete period correction', evidence_refs: [],
  });
  assert.equal(corrected.recognition.latest_reporting_cutoff.value, null);
  assert.equal(corrected.recognition.latest_reporting_cutoff.status, 'user_asserted');
  assert.match(corrected.recognition.reporting_periods[0]!.uncertainty.join(' '), /缺少来源锚点/);
  assert.match(corrected.recognition.reporting_periods[1]!.uncertainty.join(' '), /尚未人工核验/);
  assert.doesNotMatch(corrected.recognition.reporting_periods[1]!.uncertainty.join(' '), /缺少来源锚点/);
  assert.equal(corrected.recognition.state, 'needs_confirmation');
});

test('writes profile and outbox atomically', async () => {
  const client = new ProfileMock();
  client.failOutbox = true;
  await assert.rejects(appendHistoricalRecognition(dependencies(client), context, makeRecognition()), /synthetic outbox failure/);
  assert.equal(client.rows.length, 0);
  assert.equal(client.outbox.length, 0);
  assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(client.released, true);
});

test('latest and history reads bind owner/project/material and hide deleted/non-historical material', async () => {
  const client = new ProfileMock();
  const deps = dependencies(client);
  await appendHistoricalRecognition(deps, context, makeRecognition());
  const latest = await getLatestHistoricalProfile(deps, context);
  const history = await listHistoricalProfileHistory(deps, context);
  assert.equal(latest?.profileVersion, 1);
  assert.equal(history.length, 1);
  for (const sql of client.calls.filter(call => call.sql.includes('JOIN bb_material_versions')).map(call => call.sql)) {
    assert.match(sql, /p\.owner_user_id = \$1 AND p\.project_id = \$2 AND p\.material_id = \$3 AND p\.material_version = \$4/);
    assert.match(sql, /m\.role = 'historical' AND m\.deleted_at IS NULL/);
  }
});

test('live PostgreSQL enforces immutable versioned snapshots and owner-scoped reads', {
  skip: !process.env.HISTORICAL_PROFILE_TEST_DATABASE_URL && 'set HISTORICAL_PROFILE_TEST_DATABASE_URL for migrated PostgreSQL 16',
}, async () => {
  const pool = new Pool({ connectionString: process.env.HISTORICAL_PROFILE_TEST_DATABASE_URL });
  const suffix = randomUUID();
  const liveOwner = `profile-owner-${suffix}`;
  const liveProject = `profile-project-${suffix}`;
  const liveUpload = `profile-upload-${suffix}`;
  const liveMaterial = `profile-material-${suffix}`;
  const hash = 'a'.repeat(64);
  const connection = await pool.connect();
  await connection.query('BEGIN');
  const savepointName = 'historical_profile_repository';
  const wrappedClient: HistoricalProfileClient = {
    query: async (sql, values = []) => {
      if (sql === 'BEGIN') return connection.query(`SAVEPOINT ${savepointName}`) as unknown as Promise<{ rows: Record<string, unknown>[] }>;
      if (sql === 'COMMIT') return connection.query(`RELEASE SAVEPOINT ${savepointName}`) as unknown as Promise<{ rows: Record<string, unknown>[] }>;
      if (sql === 'ROLLBACK') {
        await connection.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        return connection.query(`RELEASE SAVEPOINT ${savepointName}`) as unknown as Promise<{ rows: Record<string, unknown>[] }>;
      }
      return connection.query(sql, values) as unknown as Promise<{ rows: Record<string, unknown>[] }>;
    },
    release: () => undefined,
  };
  const scopedPool: HistoricalProfilePool = {
    connect: async () => wrappedClient,
    query: (sql, values = []) => wrappedClient.query(sql, values),
  };
  try {
    await connection.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES ($1,$2,$3,$4)',
      [liveProject, liveOwner, 'Synthetic historical profile project', 'update']);
    await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES ($1,$2,$3,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$4,'historical',$5,now()+interval '1 hour','completed')`,
    [liveUpload, liveOwner, liveProject, hash, `synthetic/${suffix}`]);
    await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES ($1,2,$2,$3,$4,'historical','synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$5,$6,'parsed')`,
    [liveMaterial, liveOwner, liveProject, liveUpload, hash, `users/${liveOwner}/projects/${liveProject}/materials/${liveMaterial}/2`]);
    const parserVersion = 'parser-synthetic-1';
    const snapshotId = `parse-snapshot-${suffix}`;
    await connection.query(`INSERT INTO bb_parse_snapshots
      (id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,
       response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,2,$5,$6,$7,'{}'::jsonb,'parsed','document-parse-response-v1',$8,7,$9::jsonb)`,
    [snapshotId, liveOwner, liveProject, liveMaterial, hash, parserVersion, 'd'.repeat(64), 'e'.repeat(64), JSON.stringify({
      schema_version: 'document-parse-response-v1', request_id: `parse-${suffix}`, parser_version: parserVersion, status: 'parsed',
      material: { material_id: liveMaterial, material_version: 2, media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: hash },
      warnings: [], document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 } }, error: null,
    })]);
    for (const [ordinal, recordId] of ['evidence-market', 'evidence-offering', 'evidence-period',
      'period-2022', 'period-2023', 'period-2024', 'period-2025q1'].entries()) {
      await connection.query(`INSERT INTO bb_parse_evidence
        (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,
         literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,2,$4,$5,$6,'docx_block',$7::jsonb,$8,'synthetic context','native_text','parser-synthetic-1',1,'[]'::jsonb,'{}'::jsonb,$9,$10)`,
      [liveOwner, liveProject, liveMaterial, snapshotId, recordId, hash,
        JSON.stringify({ path: [{ paragraph: ordinal + 1 }], stable_ref: `docx:p${ordinal + 1}` }), `synthetic ${recordId}`, 'f'.repeat(64), ordinal]);
    }
    const deps: HistoricalProfileDependencies = { pool: scopedPool };
    const liveContext = { ownerUserId: liveOwner, projectId: liveProject, materialId: liveMaterial,
      materialVersion: 2, requestId: `recognition-${suffix}`, actorId: `actor-${suffix}` };
    const first = await appendHistoricalRecognition(deps, liveContext, makeRecognition({ material_id: liveMaterial }));
    const replay = await appendHistoricalRecognition(deps, liveContext, makeRecognition({ material_id: liveMaterial }));
    assert.equal(replay.replayed, true);
    const second = await correctHistoricalRecognition(deps, { ...liveContext, requestId: `correction-${suffix}` }, {
      profile_version: 1, source_market: 'szse', source_offering: 'public', reason: 'synthetic correction', evidence_refs: ['evidence-market'],
    });
    assert.equal(first.profileVersion, 1);
    assert.equal(second.profileVersion, 2);
    const periodCorrectionContext = { ...liveContext, requestId: `period-correction-${suffix}` };
    const periodCorrectionPatch = {
      profile_version: 2,
      reporting_periods: [
        { start: '2022-01-01', end: '2022-12-31', period_kind: 'annual', scope: 'consolidated', evidence_refs: ['period-2022'] },
        { start: '2023-01-01', end: '2023-12-31', period_kind: 'annual', scope: 'consolidated', evidence_refs: ['period-2023'] },
        { start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated', evidence_refs: ['period-2024'] },
        { start: '2025-01-01', end: '2025-03-31', period_kind: 'interim', scope: 'consolidated', evidence_refs: ['period-2025q1'] },
      ],
      reason: 'synthetic live period correction', evidence_refs: [],
    };
    const periodCorrection = await correctHistoricalRecognition(deps, periodCorrectionContext, periodCorrectionPatch);
    const periodReplay = await correctHistoricalRecognition(deps, periodCorrectionContext, periodCorrectionPatch);
    assert.equal(periodCorrection.profileVersion, 3);
    assert.equal(periodReplay.replayed, true);
    assert.equal(periodCorrection.recognition.latest_reporting_cutoff.value, '2025-03-31');
    assert.equal(periodCorrection.recognition.source_market.value, 'szse');
    assert.equal(periodCorrection.recognition.source_offering.value, 'public');
    assert.ok(periodCorrection.recognition.reporting_periods.every(period => period.status === 'user_asserted'));
    await assert.rejects(correctHistoricalRecognition(deps, { ...liveContext, requestId: `forged-period-${suffix}` }, {
      ...periodCorrectionPatch, profile_version: 3,
      reporting_periods: [{ ...periodCorrectionPatch.reporting_periods[0]!, evidence_refs: [`forged-${suffix}`] }],
    }), /HISTORICAL_PROFILE_CORRECTION_EVIDENCE_NOT_FOUND/);
    await assert.rejects(correctHistoricalRecognition(deps, { ...liveContext, requestId: `stale-period-${suffix}` }, {
      ...periodCorrectionPatch, profile_version: 2,
    }), /HISTORICAL_PROFILE_VERSION_CONFLICT/);
    assert.equal((await listHistoricalProfileHistory(deps, liveContext)).length, 3);
    await connection.query('SAVEPOINT expected_immutable_failure');
    await assert.rejects(connection.query(`UPDATE bb_historical_profiles SET recognition = recognition
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3`, [liveOwner, liveProject, liveMaterial]), /immutable snapshots/);
    await connection.query('ROLLBACK TO SAVEPOINT expected_immutable_failure');
    await connection.query('RELEASE SAVEPOINT expected_immutable_failure');
    const forgedReady = makeRecognition({ material_id: liveMaterial, profile_version: 3,
      source_offering: { ...makeRecognition().source_offering, value: null, status: 'needs_confirmation', uncertainty: ['synthetic uncertainty'] } });
    await connection.query('SAVEPOINT expected_ready_constraint');
    await assert.rejects(connection.query(`INSERT INTO bb_historical_profiles
      (owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES ($1,$2,$3,2,3,$4,$5,'recognition',$6::jsonb)`,
    [liveOwner, liveProject, liveMaterial, `forged-${suffix}`, 'b'.repeat(64), JSON.stringify(forgedReady)]), /bb_historical_profiles_recognition_check/);
    await connection.query('ROLLBACK TO SAVEPOINT expected_ready_constraint');
    await connection.query('RELEASE SAVEPOINT expected_ready_constraint');
    const foreignProvenance = makeRecognition({ material_id: liveMaterial, profile_version: 3,
      source_market: { ...makeRecognition().source_market,
        provenance: { ...makeRecognition().source_market.provenance, material_id: 'foreign-material' } } });
    await connection.query('SAVEPOINT expected_provenance_constraint');
    await assert.rejects(connection.query(`INSERT INTO bb_historical_profiles
      (owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES ($1,$2,$3,2,3,$4,$5,'recognition',$6::jsonb)`,
    [liveOwner, liveProject, liveMaterial, `foreign-provenance-${suffix}`, 'c'.repeat(64), JSON.stringify(foreignProvenance)]),
    /bb_historical_profiles_recognition_check/);
    await connection.query('ROLLBACK TO SAVEPOINT expected_provenance_constraint');
    await connection.query('RELEASE SAVEPOINT expected_provenance_constraint');
    assert.equal((await getLatestHistoricalProfile(deps, { ...liveContext, ownerUserId: `foreign-${suffix}` })), null);
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
    await pool.end();
  }
});
