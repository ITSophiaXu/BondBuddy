import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import { canonicalTargetPeriodCandidateSnapshotContent, type OcrReview, type TargetPeriodCandidateSnapshot } from '@bondbuddy/contracts';
import { appendTargetPeriodCandidateSnapshot, type TargetPeriodCandidateSnapshotClient, type TargetPeriodCandidateSnapshotPool } from './target-period-candidate-snapshot-repository.js';
import { buildTargetPeriodCandidateSnapshot } from './target-period-candidate-snapshot-builder.js';
import { proposeTargetReportingPeriods, type NativePeriodEvidenceSnapshot } from './target-period-candidates.js';
import type { DocumentParseRecord } from './document-parser.js';
import { createHash } from 'node:crypto';

const testDatabaseUrl = process.env.TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonicalTest = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalTest).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalTest(item)}`).join(',')}}` : JSON.stringify(value);

function fixture(owner: string, project: string, material: string, snapshotId: string, cutoff: string, draftRevision: number,
  requirements: TargetPeriodCandidateSnapshot['content']['supplemental_requirements'] = {
    version: 1, content_sha256: digest('empty-requirements'), message_ids: [],
  }): TargetPeriodCandidateSnapshot {
  const materialHash = 'a'.repeat(64);
  const record: DocumentParseRecord & { record_sha256: string } = {
    record_id: 'annual-header', material_id: material, material_version: 1, content_hash: materialHash,
    locator_type: 'xlsx_cell', locator: { path: [{ sheet: '合并利润表', table: 1, row: 1, column: 2 }] },
    literal_quote: '2024年度', context: '财务会计信息 / 合并财务报表报告期', extraction_method: 'native_text',
    extractor_version: 'synthetic-parser-1', confidence: 1, uncertainty: [], formatting: { sheet_state: 'visible' }, record_sha256: 'b'.repeat(64),
  };
  const source: NativePeriodEvidenceSnapshot = {
    method: 'native_text', snapshot_id: snapshotId, response_sha256: 'c'.repeat(64), material_id: material,
    material_version: 1, material_sha256: materialHash, media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parser_version: 'synthetic-parser-1', status: 'parsed', warnings: [], records: [record],
  };
  const candidateSet = proposeTargetReportingPeriods({ reporting_cutoff: cutoff,
    locked_materials: [{ material_id: material, material_version: 1, material_sha256: materialHash, role: 'financial' }], snapshots: [source] });
  return buildTargetPeriodCandidateSnapshot({ candidate_set: candidateSet, candidate_set_id: `candidate-set-${project}`,
    candidate_set_version: 1, owner_user_id: owner, project_id: project, project_draft_revision: draftRevision,
    reporting_cutoff: cutoff, locked_materials: [{ material_id: material, material_version: 1, material_sha256: materialHash, role: 'financial' }],
    supplemental_requirements: requirements });
}

test('PG16 stores and replays verified native candidates, rejects stale/forged sources and keeps outbox atomic', {
  skip: !testDatabaseUrl && 'set TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL to migrated PostgreSQL 16',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID();
  const owner = `candidate-owner-${suffix}`, project = `candidate-project-${suffix}`;
  const upload = `candidate-upload-${suffix}`, material = `candidate-material-${suffix}`, parseId = `candidate-parse-${suffix}`;
  const hash = 'a'.repeat(64), responseHash = 'c'.repeat(64), recordHash = 'b'.repeat(64);
  const connection = await pool.connect();
  await connection.query('BEGIN');
  const savepoint = 'target_period_candidate_snapshot';
  const wrapped: TargetPeriodCandidateSnapshotClient = {
    query: async (sql, values = []) => {
      if (sql === 'BEGIN') return connection.query(`SAVEPOINT ${savepoint}`) as unknown as Promise<{ rows: Record<string, unknown>[] }>;
      if (sql === 'COMMIT') return connection.query(`RELEASE SAVEPOINT ${savepoint}`) as unknown as Promise<{ rows: Record<string, unknown>[] }>;
      if (sql === 'ROLLBACK') { await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); return connection.query(`RELEASE SAVEPOINT ${savepoint}`) as unknown as Promise<{ rows: Record<string, unknown>[] }>; }
      return connection.query(sql, values) as unknown as Promise<{ rows: Record<string, unknown>[] }>;
    }, release: () => undefined,
  };
  const blobObjects = new Map<string, Buffer>();
  let ids = 0;
  const dependencies = { pool: { connect: async () => wrapped, query: (sql: string, values?: unknown[]) => wrapped.query(sql, values) } as TargetPeriodCandidateSnapshotPool,
    blobs: { getIfExistsBounded: async (key: string, maxBytes: number) => {
      const value = blobObjects.get(key);
      return value && value.length <= maxBytes ? value : null;
    } } as never,
    newId: () => `candidate-row-${suffix}-${++ids}` };
  const save = (requestId: string, snapshot: TargetPeriodCandidateSnapshot) => appendTargetPeriodCandidateSnapshot(dependencies, {
    ownerUserId: owner, projectId: project, requestId,
    selectedFinancialMaterials: [{ materialId: material, materialVersion: 1 }], snapshot,
  });
  try {
    await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details) VALUES($1,$2,'synthetic candidate test','update',$3::jsonb)`,
      [project, owner, JSON.stringify({ reporting_cutoff: '2025-06-30' })]);
    await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'financial.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',10,$4,'financial',$5,now()+interval '1 hour','completed')`,
    [upload, owner, project, hash, `synthetic/${suffix}`]);
    await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'financial','financial.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',10,$5,$6,'parsed')`,
    [material, owner, project, upload, hash, `synthetic-material/${suffix}`]);
    await connection.query(`INSERT INTO bb_parse_snapshots
      (id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-1',$6,'{}'::jsonb,'parsed','document-parse-response-v1',$7,1,$8::jsonb)`,
    [parseId, owner, project, material, hash, digest('parse-request'), responseHash, JSON.stringify({ schema_version: 'document-parse-response-v1',
      request_id: `parse-request-${suffix}`, parser_version: 'synthetic-parser-1', status: 'parsed',
      material: { material_id: material, material_version: 1, media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: hash },
      warnings: [], document: { page_count: null }, error: null })]);
    await connection.query(`INSERT INTO bb_parse_evidence
      (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,
       extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,'annual-header',$5,'xlsx_cell',$6::jsonb,'2024年度','财务会计信息 / 合并财务报表报告期','native_text','synthetic-parser-1',1,'[]'::jsonb,'{"sheet_state":"visible"}'::jsonb,$7,0)`,
    [owner, project, material, parseId, hash, JSON.stringify({ path: [{ sheet: '合并利润表', table: 1, row: 1, column: 2 }] }), recordHash]);

    const snapshot = fixture(owner, project, material, parseId, '2025-06-30', 1);
    const first = await save('store-request-1', snapshot);
    assert.equal(first.replayed, false);
    assert.deepEqual(first.snapshot, snapshot);
    await connection.query('SAVEPOINT invalid_envelope_check');
    await assert.rejects(connection.query(`INSERT INTO bb_target_period_candidate_snapshots
      (id,owner_user_id,project_id,candidate_set_id,candidate_set_version,content_sha256,content,request_id,request_hash)
      VALUES($1,$2,$3,$4,1,$5,$6::jsonb,$7,$8)`,
    [`invalid-envelope-${suffix}`, owner, project, `invalid-set-${suffix}`, digest('invalid-content'), JSON.stringify({ owner_user_id: owner, project_id: project }),
      `invalid-request-${suffix}`, digest('invalid-request-hash')]), /check/i);
    await connection.query('ROLLBACK TO SAVEPOINT invalid_envelope_check');
    await assert.rejects(appendTargetPeriodCandidateSnapshot(dependencies, { ownerUserId: owner, projectId: project,
      requestId: 'store-request-selection-mismatch', selectedFinancialMaterials: [{ materialId: material, materialVersion: 2 }], snapshot }),
    /MATERIAL_SELECTION_MISMATCH/);
    const replay = await save('store-request-1', snapshot);
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, first.id);
    await assert.rejects(appendTargetPeriodCandidateSnapshot(dependencies, { ownerUserId: owner, projectId: project,
      requestId: 'store-request-1', selectedFinancialMaterials: [{ materialId: material, materialVersion: 2 }], snapshot }),
    /IDEMPOTENCY_CONFLICT/, 'same request ID cannot replay with a different selected material version');
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='project.target_period_candidates_snapshotted'`, [first.id])).rows[0]!.n, 1);
    const changedRequestBody = { ...snapshot, candidate_set_id: `candidate-set-other-${suffix}` };
    await assert.rejects(save('store-request-1', changedRequestBody), /IDEMPOTENCY_CONFLICT/);

    await assert.rejects(save('store-request-1', { ...snapshot, content_sha256: 'f'.repeat(64) }), /SNAPSHOT_INVALID/);
    const forged = structuredClone(snapshot) as TargetPeriodCandidateSnapshot;
    forged.content.evidence_records[0]!.context = 'caller-forged evidence context';
    const forgedHash = digest(canonicalTargetPeriodCandidateSnapshotContent(forged));
    const forgedEnvelope = { ...forged, content_sha256: forgedHash };
    await assert.rejects(save('store-request-forged', forgedEnvelope), /EVIDENCE_TEXT_MISMATCH/);

    await connection.query(`CREATE FUNCTION bb_test_fail_candidate_outbox_${suffix.replaceAll('-', '_')}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='project.target_period_candidates_snapshotted' THEN RAISE EXCEPTION 'synthetic candidate outbox failure'; END IF; RETURN NEW; END; $$`);
    await connection.query(`CREATE TRIGGER bb_test_fail_candidate_outbox_${suffix.replaceAll('-', '_')} BEFORE INSERT ON bb_outbox
      FOR EACH ROW EXECUTE FUNCTION bb_test_fail_candidate_outbox_${suffix.replaceAll('-', '_')}()`);
    const secondSet = { ...snapshot, candidate_set_id: `candidate-set-rollback-${suffix}` };
    await assert.rejects(save('store-request-outbox-failure', secondSet), /PERSIST_FAILED/);
    await connection.query(`DROP TRIGGER bb_test_fail_candidate_outbox_${suffix.replaceAll('-', '_')} ON bb_outbox`);
    await connection.query(`DROP FUNCTION bb_test_fail_candidate_outbox_${suffix.replaceAll('-', '_')}()`);
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM bb_target_period_candidate_snapshots WHERE owner_user_id=$1`, [owner])).rows[0]!.n, 1);

    await connection.query(`UPDATE bb_projects SET draft_revision=draft_revision+1 WHERE owner_user_id=$1 AND id=$2`, [owner, project]);
    const stale = fixture(owner, project, material, parseId, '2025-06-30', 1);
    assert.equal((await save('store-request-1', snapshot)).id, first.id, 'exact replay remains readable after draft changes');
    await assert.rejects(save('store-request-stale', stale), /DRAFT_STALE/);
    await connection.query('SAVEPOINT immutability_check');
    await assert.rejects(connection.query(`UPDATE bb_target_period_candidate_snapshots SET content=content WHERE id=$1`, [first.id]), /append-only/);
    await connection.query('ROLLBACK TO SAVEPOINT immutability_check');
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM bb_target_period_candidate_snapshots WHERE owner_user_id=$1`, [owner])).rows[0]!.n, 1);
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='project.target_period_candidates_snapshotted'`, [owner])).rows[0]!.n, 1);

    const ocrSnapshotId = `candidate-ocr-${suffix}`;
    const pageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=', 'base64');
    const pageHash = digest(pageBytes);
    const pageKey = `users/${owner}/projects/${project}/ocr/${material}/1/${pageHash}.png`;
    const ocrRecord = { record_id: 'ocr-annual-header', page: 1, bbox: [0, 0, 1, 1] as [number, number, number, number],
      text: '合并财务报表报告期 2024年度 发行人名称：示例公司', confidence: 0.8,
      numeric: { kind: 'unparsed' as const, decimal: null, unit: null }, cell: null, uncertainty: ['OCR存疑数字'], eligible_for_manuscript: false as const };
    const ocrResponse = { schema_version: 'ocr-response-v1' as const, request_id: `ocr-request-${suffix}`, processor_version: 'synthetic-ocr-1',
      engine_version: 'synthetic-engine-1', language_data_sha256: { chi_sim: 'c'.repeat(64) }, language: 'chi_sim',
      purpose: 'source_preflight' as const, status: 'needs_confirmation' as const,
      material: { material_id: material, material_version: 1, media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: hash }, page_count: 1,
      coverage: 'complete' as const, pages: [{ page: 1, width: 1, height: 1, rotation_clockwise: 0 as const,
        coordinate_system: 'rendered_pixels_top_left' as const, image_sha256: pageHash, image_base64: '', warnings: [] }],
      records: [ocrRecord], warnings: [], error: null, eligible_for_manuscript: false as const };
    const resultKey = `users/${owner}/projects/${project}/ocr/results/`;
    const storedOcrBytes = Buffer.from(JSON.stringify({ response: ocrResponse, page_objects: { '1': { key: pageKey, sha256: pageHash } } }));
    const resultHash = digest(storedOcrBytes);
    blobObjects.set(pageKey, pageBytes);
    blobObjects.set(`${resultKey}${resultHash}.json`, storedOcrBytes);
    await connection.query(`INSERT INTO bb_ocr_snapshots(id,owner_user_id,project_id,material_id,material_version,request_id,request_hash,result_hash,result_key,purpose,run_id)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'source_preflight',NULL)`,
    [ocrSnapshotId, owner, project, material, `ocr-request-${suffix}`, digest('synthetic-ocr-request'), resultHash, `${resultKey}${resultHash}.json`]);
    const ocrReview: OcrReview = { snapshot_id: ocrSnapshotId, result_sha256: resultHash, material_id: material, material_version: 1,
      purpose: 'source_preflight', coverage: 'complete', page_count: 1,
      pages: [{ page: 1, width: 1, height: 1, rotation_clockwise: 0, coordinate_system: 'rendered_pixels_top_left',
        image_sha256: pageHash, warnings: [], image_url: '/synthetic/ocr-page' }], records: [ocrRecord], corrections: [], warnings: [], eligible_for_manuscript: false };
    const ocrMaterials = [{ material_id: material, material_version: 1, material_sha256: hash, role: 'financial' }];
    const ocrCandidates = proposeTargetReportingPeriods({ reporting_cutoff: '2025-06-30', locked_materials: ocrMaterials,
      snapshots: [{ method: 'ocr', review: ocrReview, processor_version: ocrResponse.processor_version, material_sha256: hash,
        record_sha256_by_id: { [ocrRecord.record_id]: digest(canonicalTest(ocrRecord)) } }] });
    const ocrEnvelope = buildTargetPeriodCandidateSnapshot({ candidate_set: ocrCandidates, candidate_set_id: `candidate-ocr-set-${suffix}`,
      candidate_set_version: 1, owner_user_id: owner, project_id: project, project_draft_revision: 2, reporting_cutoff: '2025-06-30',
      locked_materials: ocrMaterials, supplemental_requirements: { version: 1, content_sha256: digest('empty-requirements'), message_ids: [] } });
    const persistedOcr = await save('store-ocr-candidate', ocrEnvelope);
    assert.deepEqual(persistedOcr.snapshot, ocrEnvelope);
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM bb_target_period_candidate_snapshots WHERE owner_user_id=$1`, [owner])).rows[0]!.n, 2);
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
    await pool.end();
  }
});

test('rejects non-empty requirement pins until their trusted immutable message store exists', async () => {
  const owner = 'owner-candidate-gate', project = 'project-candidate-gate', material = 'material-candidate-gate';
  const request = { ownerUserId: owner, projectId: project, requestId: 'candidate-gate-request',
    selectedFinancialMaterials: [{ materialId: material, materialVersion: 1 }],
    snapshot: fixture(owner, project, material, 'parse-gate', '2024-12-31', 1,
      { version: 1, content_sha256: 'e'.repeat(64), message_ids: ['message-1'] } as TargetPeriodCandidateSnapshot['content']['supplemental_requirements']) };
  await assert.rejects(appendTargetPeriodCandidateSnapshot({ pool: { connect: async () => { throw new Error('must fail before DB'); }, query: async () => ({ rows: [] }) }, blobs: {} as never }, request),
    /REQUIREMENTS_STORE_REQUIRED/);
});

test('OCR candidate snapshots are accepted only from current hash-verified owner scoped OCR objects', async () => {
  const owner = 'ocr-candidate-owner', project = 'ocr-candidate-project', material = 'ocr-candidate-material';
  const snapshotId = 'ocr-candidate-snapshot', materialHash = 'a'.repeat(64);
  const pageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=', 'base64');
  const pageHash = digest(pageBytes);
  const pageKey = `users/${owner}/projects/${project}/ocr/${material}/1/${pageHash}.png`;
  const resultKeyPrefix = `users/${owner}/projects/${project}/ocr/results/`;
  const record = { record_id: 'ocr-period', page: 1, bbox: [0, 0, 1, 1] as [number, number, number, number],
    text: '合并财务报表报告期 2024年度 发行人名称：示例公司', confidence: 0.8,
    numeric: { kind: 'unparsed' as const, decimal: null, unit: null }, cell: null,
    uncertainty: ['OCR存疑数字'], eligible_for_manuscript: false as const };
  const response = { schema_version: 'ocr-response-v1' as const, request_id: 'ocr-request', processor_version: 'ocr-worker-1',
    engine_version: 'synthetic-ocr-1', language_data_sha256: { chi_sim: 'c'.repeat(64) }, language: 'chi_sim',
    purpose: 'source_preflight' as const, status: 'needs_confirmation' as const,
    material: { material_id: material, material_version: 1, media_type: 'application/pdf', sha256: materialHash },
    page_count: 1, coverage: 'complete' as const, pages: [{ page: 1, width: 1, height: 1, rotation_clockwise: 0 as const,
      coordinate_system: 'rendered_pixels_top_left' as const, image_sha256: pageHash, image_base64: '', warnings: [] }],
    records: [record], warnings: [], error: null, eligible_for_manuscript: false as const };
  const canonicalStored = { response, page_objects: { '1': { key: pageKey, sha256: pageHash } } };
  const canonicalBytes = Buffer.from(JSON.stringify(canonicalStored));
  const resultHash = digest(canonicalBytes);
  const review: OcrReview = { snapshot_id: snapshotId, result_sha256: resultHash, material_id: material, material_version: 1,
    purpose: 'source_preflight', coverage: 'complete', page_count: 1,
    pages: [{ page: 1, width: 1, height: 1, rotation_clockwise: 0, coordinate_system: 'rendered_pixels_top_left',
      image_sha256: pageHash, warnings: [], image_url: '/synthetic/page/1' }], records: [record], corrections: [{
      correction_id: 'ocr-user-correction', record_id: record.record_id, revision: 1, original_text: record.text,
      corrected_text: '2024年度（人工确认）', reason: 'synthetic user assertion', period: '2024', scope: null, unit: null,
      actor_user_id: owner, created_at: '2026-09-28T00:00:00.000Z', status: 'user_asserted', eligible_for_manuscript: false,
    }], warnings: [], eligible_for_manuscript: false };
  const lockedMaterials = [{ material_id: material, material_version: 1, material_sha256: materialHash, role: 'financial' }];
  const candidateSet = proposeTargetReportingPeriods({ reporting_cutoff: '2025-06-30', locked_materials: lockedMaterials,
    snapshots: [{ method: 'ocr', review, processor_version: response.processor_version, material_sha256: materialHash,
      record_sha256_by_id: { [record.record_id]: digest(canonicalTest(record)) } }] });
  const baseSnapshot = buildTargetPeriodCandidateSnapshot({ candidate_set: candidateSet, candidate_set_id: 'ocr-candidate-set',
    candidate_set_version: 1, owner_user_id: owner, project_id: project, project_draft_revision: 1,
    reporting_cutoff: '2025-06-30', locked_materials: lockedMaterials,
    supplemental_requirements: { version: 1, content_sha256: digest('empty-requirements'), message_ids: [] } });

  type State = { resultHash: string; purpose: string; sourceOwner: string; latestSnapshotId: string; latestMaterialVersion: number;
    resultBytes: Buffer | null; pageBytes: Buffer | null };
  const run = async (caseName: string, mutate: (snapshot: TargetPeriodCandidateSnapshot, state: State) => void = () => undefined,
    expectedError?: RegExp) => {
    const snapshot = structuredClone(baseSnapshot);
    const state: State = { resultHash, purpose: 'source_preflight', sourceOwner: owner, latestSnapshotId: snapshotId,
      latestMaterialVersion: 1, resultBytes: canonicalBytes, pageBytes };
    mutate(snapshot, state);
    snapshot.content_sha256 = digest(canonicalTargetPeriodCandidateSnapshotContent(snapshot));
    const blobs = { getIfExistsBounded: async (key: string, maxBytes: number) => {
      const value = key === `${resultKeyPrefix}${resultHash}.json` ? state.resultBytes : key === pageKey ? state.pageBytes : null;
      return value && value.length <= maxBytes ? value : null;
    } } as never;
    const client: TargetPeriodCandidateSnapshotClient = {
      async query(sql, values = []) {
        const p = values;
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('FROM bb_projects')) return { rows: [{ draft_revision: 1, update_details: { reporting_cutoff: '2025-06-30' } }] };
        if (sql.includes('FROM bb_target_period_candidate_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3')) return { rows: [] };
        if (sql.includes('FROM bb_material_versions m') && sql.includes('jsonb_to_recordset')) return { rows: [{
          material_id: material, material_version: 1, material_sha256: materialHash, role: 'financial' }] };
        if (sql.includes('FROM bb_ocr_snapshots s') && sql.includes('JOIN bb_material_versions')) return { rows: state.sourceOwner === owner ? [{
          id: snapshotId, owner_user_id: state.sourceOwner, project_id: project, material_id: material, material_version: 1,
          request_id: 'ocr-request', result_hash: state.resultHash, result_key: `${resultKeyPrefix}${state.resultHash}.json`,
          purpose: state.purpose, run_id: null, material_sha256: materialHash, role: 'financial', media_type: 'application/pdf',
        }] : [] };
        if (sql.includes('FROM bb_material_versions') && sql.includes('ORDER BY version DESC')) return { rows: [{ version: state.latestMaterialVersion, sha256: materialHash }] };
        if (sql.includes('FROM bb_ocr_snapshots WHERE owner_user_id=$1')) return { rows: [{ id: state.latestSnapshotId }] };
        if (sql.includes('SELECT COALESCE(max(candidate_set_version)')) return { rows: [{ version: 0 }] };
        if (sql.includes('INSERT INTO bb_target_period_candidate_snapshots')) return { rows: [{ id: `stored-${caseName}`,
          owner_user_id: owner, project_id: project, candidate_set_id: snapshot.candidate_set_id,
          candidate_set_version: 1, content_sha256: snapshot.content_sha256, content: snapshot.content, request_id: caseName,
          request_hash: digest(caseName), created_at: new Date('2026-09-28T00:00:00.000Z') }] };
        return { rows: [] };
      }, release() {},
    };
    const pool: TargetPeriodCandidateSnapshotPool = { connect: async () => client, query: (sql, values) => client.query(sql, values) };
    const request = { ownerUserId: owner, projectId: project, requestId: caseName,
      selectedFinancialMaterials: [{ materialId: material, materialVersion: 1 }], snapshot };
    if (expectedError) await assert.rejects(appendTargetPeriodCandidateSnapshot({ pool, blobs, newId: () => `new-${caseName}` }, request), expectedError);
    else assert.equal((await appendTargetPeriodCandidateSnapshot({ pool, blobs, newId: () => `new-${caseName}` }, request)).snapshot.content_sha256, snapshot.content_sha256);
  };

  await run('ocr-positive');
  await run('ocr-result-tampered', (_snapshot, state) => { state.resultBytes = Buffer.from('tampered'); }, /OCR_RESULT_INTEGRITY_FAILED/);
  await run('ocr-result-missing', (_snapshot, state) => { state.resultBytes = null; }, /OCR_RESULT_INTEGRITY_FAILED/);
  await run('ocr-page-missing', (_snapshot, state) => { state.pageBytes = null; }, /OCR_PAGE_INTEGRITY_FAILED/);
  await run('ocr-page-tampered', (_snapshot, state) => { state.pageBytes = Buffer.from('tampered'); }, /OCR_PAGE_INTEGRITY_FAILED/);
  await run('ocr-snapshot-stale', (_snapshot, state) => { state.latestSnapshotId = 'newer-ocr'; }, /SOURCE_STALE/);
  await run('ocr-material-stale', (_snapshot, state) => { state.latestMaterialVersion = 2; }, /SOURCE_STALE/);
  await run('ocr-foreign-owner', (_snapshot, state) => { state.sourceOwner = 'different-owner'; }, /SOURCE_NOT_FOUND/);
  await run('ocr-purpose-forged', (_snapshot, state) => { state.purpose = 'full_ocr'; }, /SOURCE_STALE/);
  await run('ocr-forged-evidence-text', snapshot => { snapshot.content.evidence_records[0]!.context = 'caller forged this'; }, /EVIDENCE_TEXT_MISMATCH/);
  await run('ocr-tampered-page-pin', snapshot => {
    snapshot.content.source_snapshots[0]!.page_image_pins[0]!.image_sha256 = 'e'.repeat(64);
    snapshot.content.evidence_records[0]!.page_image_sha256 = 'e'.repeat(64);
  }, /OCR_PIN_MISMATCH/);
  await run('ocr-tampered-record-pin', snapshot => {
    snapshot.content.source_snapshots[0]!.record_pins[0]!.record_sha256 = 'd'.repeat(64);
    snapshot.content.evidence_records[0]!.record_sha256 = 'd'.repeat(64);
  }, /OCR_PIN_MISMATCH/);
});
