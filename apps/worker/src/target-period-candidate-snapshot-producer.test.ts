import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import type { DocumentParseResponse } from './document-parser.js';
import { persistParseSnapshot } from './parse-evidence-repository.js';
import { isolatedTestDatabase } from './test-database.js';
import { produceTargetPeriodCandidateSnapshot } from './target-period-candidate-snapshot-producer.js';

const testDatabaseUrl = await isolatedTestDatabase('TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL', 'producer');
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);

test('PG16 producer derives native and OCR sources, returns only pending reference, and rejects stale/cross-owner input', {
  skip: !testDatabaseUrl && 'set TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL to migrated PostgreSQL 16',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID();
  const owner = `producer-owner-${suffix}`, project = `producer-project-${suffix}`;
  const otherOwner = `producer-other-owner-${suffix}`, otherProject = `producer-other-project-${suffix}`;
  const nativeId = `producer-native-${suffix}`, ocrId = `producer-ocr-${suffix}`;
  const noEvidenceId = `producer-no-evidence-${suffix}`, nonfinancialId = `producer-nonfinancial-${suffix}`;
  const nativeBytes = Buffer.from(`synthetic native source ${suffix}`), ocrBytes = Buffer.from(`synthetic OCR source ${suffix}`);
  const nativeHash = hash(nativeBytes), ocrHash = hash(ocrBytes);
  const blobs = new Map<string, Buffer>();

  const addMaterial = async (materialId: string, uploadId: string, mediaType: string, sha: string, version = 1, role = 'financial') => {
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour','completed')`,
    [uploadId, owner, project, `${materialId}.source`, mediaType, 16, sha, role, `synthetic-upload/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,16,$9,$10,'parsed')`,
    [materialId, version, owner, project, uploadId, role, `${materialId}.source`, mediaType, sha, `synthetic-material/${materialId}/${version}`]);
  };

  try {
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details)
      VALUES($1,$2,'synthetic producer test','update',$3::jsonb),($4,$5,'synthetic foreign project','update',$3::jsonb)`,
    [project, owner, JSON.stringify({ reporting_cutoff: '2025-06-30' }), otherProject, otherOwner]);
    await addMaterial(nativeId, `producer-upload-native-${suffix}`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', nativeHash);
    await addMaterial(ocrId, `producer-upload-ocr-${suffix}`, 'application/pdf', ocrHash);
    await addMaterial(noEvidenceId, `producer-upload-no-evidence-${suffix}`, 'application/pdf', hash('no evidence source'));
    await addMaterial(nonfinancialId, `producer-upload-nonfinancial-${suffix}`, 'application/pdf', hash('nonfinancial source'), 1, 'business');

    const parseRequestId = `producer-parse-request-${suffix}`;
    const parseResponse: DocumentParseResponse = {
      schema_version: 'document-parse-response-v1', request_id: parseRequestId, parser_version: 'synthetic-native-1', status: 'parsed',
      material: { material_id: nativeId, material_version: 1,
        media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: nativeHash },
      records: [{ record_id: 'native-period', material_id: nativeId, material_version: 1, content_hash: nativeHash,
        locator_type: 'xlsx_cell', locator: { sheet: '利润表', cell: 'B1', merged_range: null, stable_ref: 'xlsx:%E5%88%A9%E6%B6%A6%E8%A1%A8:cell:B1' },
        literal_quote: '财务报表报告期 2024年度', context: '财务会计信息 / 合并财务报表报告期', extraction_method: 'native_text',
        extractor_version: 'synthetic-native-1', confidence: 1, uncertainty: [], formatting: { sheet_state: 'visible' } }],
      warnings: [], document: { page_count: null, worksheet_count: 1, missing_formula_results: 0, cached_formula_results: 0 }, error: null,
    };
    await persistParseSnapshot({ pool }, { ownerUserId: owner, projectId: project, materialId: nativeId,
      materialVersion: 1, requestId: parseRequestId },
    { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: nativeHash }, parseResponse);

    const pageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=', 'base64');
    const pageHash = hash(pageBytes);
    const pageKey = `users/${owner}/projects/${project}/ocr/${ocrId}/1/${pageHash}.png`;
    const resultKeyPrefix = `users/${owner}/projects/${project}/ocr/results/`;
    const ocrRequestId = `producer-ocr-request-${suffix}`;
    const ocrResponse = {
      schema_version: 'ocr-response-v1', request_id: ocrRequestId, processor_version: 'synthetic-ocr-1',
      engine_version: 'synthetic-engine-1', language_data_sha256: { chi_sim: 'c'.repeat(64) }, language: 'chi_sim',
      purpose: 'source_preflight', status: 'needs_confirmation',
      material: { material_id: ocrId, material_version: 1, media_type: 'application/pdf', sha256: ocrHash },
      page_count: 1, coverage: 'complete', pages: [{ page: 1, width: 1, height: 1, rotation_clockwise: 0,
        coordinate_system: 'rendered_pixels_top_left', image_sha256: pageHash, image_base64: '', warnings: [] }],
      records: [{ record_id: 'ocr-period', page: 1, bbox: [0, 0, 1, 1], text: '合并财务报表报告期 2024年度 发行人名称：示例公司',
        confidence: 0.8, numeric: { kind: 'unparsed', decimal: null, unit: null }, cell: null,
        uncertainty: ['OCR存疑数字'], eligible_for_manuscript: false }],
      warnings: [], error: null, eligible_for_manuscript: false,
    };
    blobs.set(pageKey, pageBytes);
    const storedOcr = Buffer.from(JSON.stringify({ response: ocrResponse, page_objects: { '1': { key: pageKey, sha256: pageHash } } }));
    const ocrResultHash = hash(storedOcr);
    blobs.set(`${resultKeyPrefix}${ocrResultHash}.json`, storedOcr);
    await pool.query(`INSERT INTO bb_ocr_snapshots(id,owner_user_id,project_id,material_id,material_version,request_id,request_hash,result_hash,result_key,purpose,run_id)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'source_preflight',NULL)`,
    [`producer-ocr-snapshot-${suffix}`, owner, project, ocrId, ocrRequestId, hash('synthetic OCR request'), ocrResultHash,
      `${resultKeyPrefix}${ocrResultHash}.json`]);

    const dependencies = { pool, blobs: { getIfExistsBounded: async (key: string, maxBytes: number) => {
      const value = blobs.get(key);
      return value && value.length <= maxBytes ? value : null;
    } } as never };
    const request = { ownerUserId: owner, projectId: project,
      selectedFinancialMaterials: [{ materialId: nativeId, materialVersion: 1 }, { materialId: ocrId, materialVersion: 1 }],
      projectDraftRevision: 1, reportingCutoff: '2025-06-30' };
    const reference = await produceTargetPeriodCandidateSnapshot(dependencies, request);
    const replay = await produceTargetPeriodCandidateSnapshot(dependencies, request);
    assert.deepEqual(replay, reference, 'same exact producer request replays the same immutable reference');
    assert.deepEqual(Object.keys(reference).sort(), ['candidate_set_id', 'candidate_set_version', 'content_sha256']);
    const stored = await pool.query(`SELECT content FROM bb_target_period_candidate_snapshots WHERE owner_user_id=$1 AND project_id=$2
      AND candidate_set_id=$3 AND candidate_set_version=$4`, [owner, project, reference.candidate_set_id, reference.candidate_set_version]);
    assert.equal(stored.rows.length, 1);
    const envelope = typeof stored.rows[0]!.content === 'string' ? JSON.parse(String(stored.rows[0]!.content)) : stored.rows[0]!.content;
    assert.equal(envelope.status, 'needs_confirmation');
    assert.equal(envelope.candidates.every((candidate: { status: string }) => candidate.status === 'needs_confirmation'), true);
    assert.deepEqual(envelope.source_snapshots.map((source: { evidence_method: string }) => source.evidence_method).sort(), ['native_text', 'ocr']);
    assert.deepEqual(envelope.supplemental_requirements.message_ids, []);
    assert.equal(envelope.supplemental_requirements.content_sha256, hash('[]'));
    assert.equal(hash(canonical(envelope)), reference.content_sha256);
    const replayCounts = await pool.query(`SELECT count(DISTINCT s.id)::int AS snapshots, count(o.id)::int AS events
      FROM bb_target_period_candidate_snapshots s LEFT JOIN bb_outbox o ON o.aggregate_id=s.id
        AND o.event_type='project.target_period_candidates_snapshotted'
      WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.candidate_set_id=$3`, [owner, project, reference.candidate_set_id]);
    assert.deepEqual(replayCounts.rows[0], { snapshots: 1, events: 1 }, 'exact replay persists only one snapshot and outbox event');

    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, { ...request, projectDraftRevision: 2 }),
      /TARGET_PERIOD_CANDIDATE_DRAFT_STALE/);
    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, { ...request, reportingCutoff: '2025-03-31' }),
      /TARGET_PERIOD_CANDIDATE_DRAFT_STALE/);
    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, { ...request,
      selectedFinancialMaterials: [{ materialId: nonfinancialId, materialVersion: 1 }] }), /TARGET_PERIOD_CANDIDATE_LOCK_INVALID/);

    const noEvidenceRequest = { ...request, selectedFinancialMaterials: [{ materialId: noEvidenceId, materialVersion: 1 }] };
    const noEvidenceRef = await produceTargetPeriodCandidateSnapshot(dependencies, noEvidenceRequest);
    const noEvidenceRow = await pool.query(`SELECT content FROM bb_target_period_candidate_snapshots
      WHERE owner_user_id=$1 AND project_id=$2 AND candidate_set_id=$3`, [owner, project, noEvidenceRef.candidate_set_id]);
    const noEvidenceContent = typeof noEvidenceRow.rows[0]!.content === 'string'
      ? JSON.parse(String(noEvidenceRow.rows[0]!.content)) : noEvidenceRow.rows[0]!.content;
    assert.equal(noEvidenceContent.status, 'needs_confirmation');
    assert.deepEqual(noEvidenceContent.candidates, []);
    assert.deepEqual(noEvidenceContent.source_snapshots, []);
    assert.ok(noEvidenceContent.pending_reasons.includes('no_evidenced_reporting_period_candidates'));
    assert.ok(noEvidenceContent.pending_reasons.includes('period_evidence_snapshots_missing'));

    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, { ...request,
      ownerUserId: `${owner}-wrong`, projectId: otherProject }), /TARGET_PERIOD_CANDIDATE_PROJECT_NOT_FOUND/);
    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, { ...request,
      selectedFinancialMaterials: [{ materialId: nativeId, materialVersion: 2 }] }), /TARGET_PERIOD_CANDIDATE_MATERIAL_NOT_FOUND/);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'replacement.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',16,$4,'financial',$5,now()+interval '1 hour','completed')`,
    [`producer-upload-native-v2-${suffix}`, owner, project, hash('replacement source'), `synthetic-upload/native-v2/${suffix}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,2,$2,$3,$4,'financial','replacement.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',16,$5,$6,'parsed')`,
    [nativeId, owner, project, `producer-upload-native-v2-${suffix}`, hash('replacement source'), `synthetic-material/${nativeId}/2`]);
    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, request), /TARGET_PERIOD_CANDIDATE_MATERIAL_STALE/);
  } finally {
    await pool.end();
  }
});
