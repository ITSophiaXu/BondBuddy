import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import { canonicalTargetPeriodCandidateSnapshotContent, type TargetPeriodCandidateSnapshot } from '@bondbuddy/contracts';
import { appendTargetPeriodCandidateSnapshot, type TargetPeriodCandidateSnapshotClient, type TargetPeriodCandidateSnapshotPool } from './target-period-candidate-snapshot-repository.js';
import { buildTargetPeriodCandidateSnapshot } from './target-period-candidate-snapshot-builder.js';
import { proposeTargetReportingPeriods, type NativePeriodEvidenceSnapshot } from './target-period-candidates.js';
import type { DocumentParseRecord } from './document-parser.js';
import { createHash } from 'node:crypto';

const testDatabaseUrl = process.env.TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

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
  let ids = 0;
  const dependencies = { pool: { connect: async () => wrapped, query: (sql: string, values?: unknown[]) => wrapped.query(sql, values) } as TargetPeriodCandidateSnapshotPool,
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
  await assert.rejects(appendTargetPeriodCandidateSnapshot({ pool: { connect: async () => { throw new Error('must fail before DB'); }, query: async () => ({ rows: [] }) } }, request),
    /REQUIREMENTS_STORE_REQUIRED/);
});
