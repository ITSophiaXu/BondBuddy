import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { test } from 'node:test';
import { prepareUserSubmission } from '../../api/dist/user-submissions.js';
import type { DocumentParseResponse } from './document-parser.js';
import { persistParseSnapshot } from './parse-evidence-repository.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadProjectMessageSetPin, normalizeProjectMessageSet, projectMessageSetRequirementsPin } from './project-message-set-pin.js';
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
  const notesProject = `producer-notes-project-${suffix}`, otherInformationProject = `producer-other-information-project-${suffix}`;
  const nativeId = `producer-native-${suffix}`, ocrId = `producer-ocr-${suffix}`;
  const noEvidenceId = `producer-no-evidence-${suffix}`, nonfinancialId = `producer-nonfinancial-${suffix}`;
  const messageProject = `producer-message-project-${suffix}`, raceProject = `producer-race-project-${suffix}`;
  const messageMaterial = `producer-message-material-${suffix}`, raceMaterial = `producer-race-material-${suffix}`;
  const nativeBytes = Buffer.from(`synthetic native source ${suffix}`), ocrBytes = Buffer.from(`synthetic OCR source ${suffix}`);
  const nativeHash = hash(nativeBytes), ocrHash = hash(ocrBytes);
  const blobs = new Map<string, Buffer>();

  const addMaterial = async (materialId: string, uploadId: string, mediaType: string, sha: string,
    version = 1, role = 'financial', projectId = project) => {
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour','completed')`,
    [uploadId, owner, projectId, `${materialId}.source`, mediaType, 16, sha, role, `synthetic-upload/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,16,$9,$10,'parsed')`,
    [materialId, version, owner, projectId, uploadId, role, `${materialId}.source`, mediaType, sha, `synthetic-material/${materialId}/${version}`]);
  };

  try {
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details)
      VALUES($1,$2,'synthetic producer test','update',$3::jsonb),($4,$5,'synthetic foreign project','update',$3::jsonb),
        ($6,$2,'synthetic notes project','update',$7::jsonb),($8,$2,'synthetic other-information project','update',$9::jsonb),
        ($10,$2,'synthetic prior-message project','update',$3::jsonb),($11,$2,'synthetic lock-race project','update',$3::jsonb)`,
    [project, owner, JSON.stringify({ reporting_cutoff: '2025-06-30', supplementary_notes: null, other_information: '   ' }),
      otherProject, otherOwner, notesProject, JSON.stringify({ reporting_cutoff: '2025-06-30', supplementary_notes: '要求采用其他口径', other_information: null }),
      otherInformationProject, JSON.stringify({ reporting_cutoff: '2025-06-30', supplementary_notes: null, other_information: '请补充某事项' }),
      messageProject, raceProject]);
    await addMaterial(nativeId, `producer-upload-native-${suffix}`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', nativeHash);
    await addMaterial(ocrId, `producer-upload-ocr-${suffix}`, 'application/pdf', ocrHash);
    await addMaterial(noEvidenceId, `producer-upload-no-evidence-${suffix}`, 'application/pdf', hash('no evidence source'));
    await addMaterial(nonfinancialId, `producer-upload-nonfinancial-${suffix}`, 'application/pdf', hash('nonfinancial source'), 1, 'business');
    await addMaterial(messageMaterial, `producer-upload-message-${suffix}`, 'application/pdf', hash('message project source'), 1, 'financial', messageProject);
    await addMaterial(raceMaterial, `producer-upload-race-${suffix}`, 'application/pdf', hash('race project source'), 1, 'financial', raceProject);

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
    const emptyRequirements = projectMessageSetRequirementsPin(normalizeProjectMessageSet([]));
    assert.deepEqual(envelope.supplemental_requirements.message_ids, []);
    assert.equal(envelope.supplemental_requirements.version, emptyRequirements.version);
    assert.equal(envelope.supplemental_requirements.content_sha256, emptyRequirements.content_sha256);
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
    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, { ...request, projectId: notesProject }),
      /TARGET_PERIOD_CANDIDATE_REQUIREMENTS_STORE_REQUIRED/);
    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, { ...request, projectId: otherInformationProject }),
      /TARGET_PERIOD_CANDIDATE_REQUIREMENTS_STORE_REQUIRED/);

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
    await pool.query(`UPDATE bb_projects SET draft_revision=draft_revision+1 WHERE owner_user_id=$1 AND id=$2`, [owner, project]);
    await assert.rejects(produceTargetPeriodCandidateSnapshot(dependencies, request), /TARGET_PERIOD_CANDIDATE_DRAFT_STALE/);

    const privateObjects = new Map<string, Buffer>();
    const privateBlobs = {
      put: async (key: string, value: Buffer) => { privateObjects.set(key, Buffer.from(value)); },
      get: async (key: string) => {
        const value = privateObjects.get(key);
        if (!value) throw new Error('synthetic private object not found');
        return Buffer.from(value);
      },
      delete: async (key: string) => { privateObjects.delete(key); },
    } as never;
    const registerMessage = async (targetProject: string, messageId: string) => {
      const prepared = await prepareUserSubmission(pool, privateBlobs, `synthetic test message ${messageId}`);
      const handle = await prepared.write(owner, targetProject);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`${owner}:${targetProject}:user_submission`]);
        const saved = await handle.register(client, { kind: 'project_message', messageId,
          submissionRequestId: `submission-${messageId}`, materialVersions: [] });
        await client.query('COMMIT');
        await handle.discard();
        return { handle, submissionId: saved.submissionId };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        await handle.discard().catch(() => undefined);
        throw error;
      } finally { client.release(); }
    };

    const priorMessage = await registerMessage(messageProject, `prior-${suffix}`);
    assert.ok(priorMessage.submissionId);
    const priorMessageId = `prior-${suffix}`;
    const boundRef = await produceTargetPeriodCandidateSnapshot(dependencies, { ownerUserId: owner, projectId: messageProject,
      selectedFinancialMaterials: [{ materialId: messageMaterial, materialVersion: 1 }],
      projectDraftRevision: 1, reportingCutoff: '2025-06-30' });
    const expectedPriorSet = projectMessageSetRequirementsPin(
      await loadProjectMessageSetPin({ query: (sql: string, values: unknown[] = []) => pool.query(sql, values as never) as never },
        { ownerUserId: owner, projectId: messageProject }));
    const boundRow = await pool.query(`SELECT content FROM bb_target_period_candidate_snapshots
      WHERE owner_user_id=$1 AND project_id=$2 AND candidate_set_id=$3 AND candidate_set_version=$4`,
    [owner, messageProject, boundRef.candidate_set_id, boundRef.candidate_set_version]);
    const boundContent = typeof boundRow.rows[0]!.content === 'string'
      ? JSON.parse(String(boundRow.rows[0]!.content)) : boundRow.rows[0]!.content;
    assert.deepEqual(boundContent.supplemental_requirements, expectedPriorSet,
      'a previously committed project_message is bound as an exact normalized set pin, never dropped as []');
    assert.deepEqual(boundContent.supplemental_requirements.message_ids, [priorMessageId]);
    assert.deepEqual(await produceTargetPeriodCandidateSnapshot(dependencies, { ownerUserId: owner, projectId: messageProject,
      selectedFinancialMaterials: [{ materialId: messageMaterial, materialVersion: 1 }],
      projectDraftRevision: 1, reportingCutoff: '2025-06-30' }), boundRef,
    'an exact producer replay with the same bound message set is idempotent');

    // Pause the real producer after it owns the project FOR UPDATE lock, then let the real
    // #397 registration helper take its advisory lock and reach the FK KEY SHARE boundary.
    const raceRequest = { ownerUserId: owner, projectId: raceProject,
      selectedFinancialMaterials: [{ materialId: raceMaterial, materialVersion: 1 }],
      projectDraftRevision: 1, reportingCutoff: '2025-06-30' };
    const preparedRaceMessage = await prepareUserSubmission(pool, privateBlobs, `synthetic race message ${suffix}`);
    const raceMessageHandle = await preparedRaceMessage.write(owner, raceProject);

    let projectLockObserved!: () => void;
    const projectLocked = new Promise<void>(resolve => { projectLockObserved = resolve; });
    let producerResume: () => void = () => undefined;
    const producerResumePromise = new Promise<void>(resolve => { producerResume = () => resolve(); });
    let pauseOnce = true;
    const racePool = {
      query: (sql: string, values?: unknown[]) => pool.query(sql, values as never),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values as never);
            if (pauseOnce && sql.includes('FROM bb_projects') && sql.includes('FOR UPDATE')) {
              pauseOnce = false;
              projectLockObserved();
              await producerResumePromise;
            }
            return result as never;
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    const timeout = async <T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    let messageClient: PoolClient | undefined;
    let registration: ReturnType<typeof raceMessageHandle.register> | undefined;
    let candidatePromise: ReturnType<typeof produceTargetPeriodCandidateSnapshot> | undefined;
    try {
      candidatePromise = produceTargetPeriodCandidateSnapshot({ ...dependencies, pool: racePool }, raceRequest);
      await timeout(projectLocked, 5000, 'producer project-row lock acquisition');

      messageClient = await pool.connect();
      await messageClient.query('BEGIN');
      await messageClient.query("SET LOCAL statement_timeout = '5000ms'");
      await messageClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${owner}:${raceProject}:user_submission`]);
      const pid = Number((await messageClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
      registration = raceMessageHandle.register(messageClient, { kind: 'project_message', messageId: `race-${suffix}`,
        submissionRequestId: `submission-race-${suffix}`, materialVersions: [] });
      const waitDeadline = Date.now() + 3000;
      let observedFkBlock = false;
      while (Date.now() < waitDeadline) {
        const blocked = await pool.query<{ blocked: boolean; query: string }>(
          'SELECT cardinality(pg_blocking_pids(pid)) > 0 AS blocked, query FROM pg_stat_activity WHERE pid=$1::int', [pid]);
        if (blocked.rows[0]?.blocked && blocked.rows[0].query.includes('INSERT INTO bb_snapshot_refs')) {
          observedFkBlock = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(observedFkBlock, true, 'registration must reach and block at its project FK while producer owns FOR UPDATE');

      producerResume();
      const candidateRef = await timeout(candidatePromise, 5000, 'candidate append while message waits on the project FK');
      assert.ok(candidateRef.candidate_set_id);
      const savedRaceMessage = await timeout(registration, 5000, 'project-message registration after candidate commit');
      await messageClient.query('COMMIT');
      const messageCount = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM bb_user_submission_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message'`, [owner, raceProject]);
      assert.equal(messageCount.rows[0]!.count, 1, 'the registration waiting at FK completes exactly once after candidate commit');
      assert.ok(savedRaceMessage.submissionId);
      const raceSnapshot = await pool.query<{ content: Record<string, unknown> }>(`SELECT content FROM bb_target_period_candidate_snapshots
        WHERE owner_user_id=$1 AND project_id=$2 AND candidate_set_id=$3 AND candidate_set_version=$4`,
      [owner, raceProject, candidateRef.candidate_set_id, candidateRef.candidate_set_version]);
      assert.equal(raceSnapshot.rowCount, 1);
      assert.deepEqual((raceSnapshot.rows[0]!.content as { supplemental_requirements: { message_ids: string[] } })
        .supplemental_requirements.message_ids, [], 'the candidate was serialized before the waiting message registration');
      // The stored snapshot is intentionally earlier project-message state and keeps its old empty pin.
      // A fresh request observes the committed message and binds the exact nonempty set.
      const afterRaceRef = await produceTargetPeriodCandidateSnapshot(dependencies, raceRequest);
      assert.notEqual(afterRaceRef.candidate_set_id, candidateRef.candidate_set_id);
      const afterRaceSnapshot = await pool.query<{ content: { supplemental_requirements: { message_ids: string[] } } }>(
        `SELECT content FROM bb_target_period_candidate_snapshots
          WHERE owner_user_id=$1 AND project_id=$2 AND candidate_set_id=$3 AND candidate_set_version=$4`,
        [owner, raceProject, afterRaceRef.candidate_set_id, afterRaceRef.candidate_set_version]);
      assert.equal(afterRaceSnapshot.rowCount, 1);
      assert.deepEqual((raceSnapshot.rows[0]!.content as { supplemental_requirements: { message_ids: string[] } })
        .supplemental_requirements.message_ids, [], 'the old snapshot keeps its original empty pin');
      assert.deepEqual(afterRaceSnapshot.rows[0]!.content.supplemental_requirements.message_ids, [`race-${suffix}`]);
      // This remains intentionally later project-message state than the stored snapshot. The future
      // input-lock consumer must revalidate metadata; producer idempotency is not that consumer.
    } finally {
      producerResume();
      if (candidatePromise) await timeout(candidatePromise, 5000, 'candidate cleanup').catch(() => undefined);
      if (messageClient) {
        await messageClient.query('ROLLBACK').catch(() => undefined);
        messageClient.release();
      }
      if (registration) await registration.catch(() => undefined);
      await raceMessageHandle.discard().catch(() => undefined);
    }
  } finally {
    await pool.end();
  }
});
