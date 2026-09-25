import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createServer } from './server.js';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  loadVerifiedIssuerIdentitySourceRecord,
  reviewIssuerIdentitySourceRecord,
} from './issuer-identity-source.js';
import type { IssuerIdentitySourcePool } from './issuer-identity-source.js';

const databaseUrl = process.env.BB_TEST_DATABASE_URL;
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function savepointPool(connection: PoolClient): Pool {
  let next = 0;
  const sourcePool: IssuerIdentitySourcePool = {
    query: (sql, values) => connection.query(sql, values),
    connect: async () => {
      const name = `issuer_identity_input_${++next}`;
      let active = false;
      return {
        release: () => undefined,
        query: async (sql, values) => {
          if (sql === 'BEGIN') { await connection.query(`SAVEPOINT ${name}`); active = true; return { rows: [] }; }
          if (sql === 'COMMIT') { if (active) await connection.query(`RELEASE SAVEPOINT ${name}`); active = false; return { rows: [] }; }
          if (sql === 'ROLLBACK') {
            if (active) { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); }
            active = false; return { rows: [] };
          }
          return connection.query(sql, values);
        },
      };
    },
  };
  return sourcePool as unknown as Pool;
}

test('synthetic PostgreSQL: update input revisions pin exact reviewed issuer sources and fail closed on replay/staleness',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const scopedPool = savepointPool(connection);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `input-owner-${suffix}`, foreignOwner = `input-foreign-${suffix}`;
    const reviewerId = `input-reviewer-${suffix}`, grantorId = `input-grantor-${suffix}`;
    const projectId = `input-project-${suffix}`, reviewProjectId = `input-review-project-${suffix}`;
    const historicalA = `input-historical-a-${suffix}`, historicalB = `input-historical-b-${suffix}`;
    const auditMaterial = `input-audit-${suffix}`;
    const grantId = `input-review-grant-${suffix}`;
    const grants = [historicalA, historicalB].map(id => ({
      materialId: id, materialVersion: 1, uploadId: `upload-${id}`, snapshotId: `snapshot-${id}`,
      contentHash: sha(`synthetic bytes ${id}`), evidenceA: `evidence-a-${id}`, evidenceB: `evidence-b-${id}`,
    }));
    let activeOwner = owner;
    const app = createServer({
      pool: scopedPool, allowedOrigin: origin,
      principal: async () => ({ userId: activeOwner, csrfVerified: true }),
      enableRunRuntime: true,
    });
    const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url,
      headers: { origin }, payload: payload as any });
    const lockInput = async (targetProject: string, materials: { material_id: string; material_version: number }[]) => {
      const response = await send('POST', `/api/v1/projects/${targetProject}/input-revisions`, {
        draft_revision: 1, material_versions: materials, requirement_message_ids: [],
      });
      assert.equal(response.statusCode, 201, response.body);
      const dto = response.json();
      const row = (await connection.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
        [activeOwner, targetProject, dto.input_revision])).rows[0];
      return { ...dto, manifest: row.manifest as Record<string, unknown> };
    };
    const addSource = async (materialId: string, sourceRecordId: string, quote: string, entityId: string) => {
      const record = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1,
        requestId: `request-${sourceRecordId}`, sourceRecordId, issuerDisplayName: quote, entityId,
      });
      return record;
    };

    try {
      await connection.query('BEGIN');
      for (const [id, username] of [[owner, 'inputowner'], [foreignOwner, 'inputforeign'], [reviewerId, 'inputreviewer'], [grantorId, 'inputgrantor']] as const) {
        await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `${username}${suffix}`]);
      }
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details)
        VALUES($1,$2,'Synthetic update','update','Browser supplied name','sse','private','{}')`, [projectId, owner]);
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details)
        VALUES($1,$2,'Synthetic review','review','{}')`, [reviewProjectId, owner]);

      for (const material of [...grants, { materialId: auditMaterial, materialVersion: 1, uploadId: `upload-${auditMaterial}`, snapshotId: `snapshot-${auditMaterial}`,
        contentHash: sha(`synthetic bytes ${auditMaterial}`), evidenceA: `evidence-a-${auditMaterial}`, evidenceB: `evidence-b-${auditMaterial}` }]) {
        const materialProject = material.materialId === auditMaterial ? reviewProjectId : projectId;
        const role = material.materialId === auditMaterial ? 'audit' : 'historical';
        await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
          state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',10,$4,$5,$6,now()+interval '1 hour','completed',$4,10)`,
        [material.uploadId, owner, materialProject, material.contentHash, role, `synthetic/${material.uploadId}`]);
        await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',10,$6,$7,'parsed')`,
        [material.materialId, owner, materialProject, material.uploadId, role, material.contentHash, `users/${owner}/projects/${materialProject}/materials/${material.materialId}`]);
        if (material.materialId === auditMaterial) continue;
        const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${material.snapshotId}`, status: 'parsed',
          parser_version: `parser-${suffix}`, material: { material_id: material.materialId, material_version: 1, media_type: 'application/pdf', sha256: material.contentHash },
          warnings: [], document: { page_count: 1 }, error: null };
        await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
          response_status,response_schema_version,response_sha256,record_count,response_meta)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,2,$9::jsonb)`,
        [material.snapshotId, owner, projectId, material.materialId, material.contentHash, `parser-${suffix}`, sha(`parse-request-${material.snapshotId}`),
          sha(`parse-response-${material.snapshotId}`), JSON.stringify(meta)]);
        const issuerQuote = material.materialId === historicalA ? '合成发行人甲' : '合成发行人乙';
        for (const [recordId, quote, ordinal] of [[material.evidenceA, issuerQuote, 0], [material.evidenceB, '合成冲突观察', 1]] as const) {
          await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
            locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
            VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic test evidence','native_text',$9,0.99,'[]','{}',$10,$11)`,
          [owner, projectId, material.materialId, material.snapshotId, recordId, material.contentHash,
            JSON.stringify({ page: ordinal + 1, bbox: [0, 0, 1, 1] }), quote, `parser-${suffix}`, sha(recordId), ordinal]);
        }
      }

      const sourceA = grants[0]!;
      const sourceB = grants[1]!;
      const observationA = await addSource(historicalA, sourceA.evidenceA, '合成发行人甲', 'entity-synthetic-a');
      const unreviewedInput = await lockInput(projectId, [{ material_id: historicalA, material_version: 1 }]);
      assert.deepEqual(unreviewedInput.manifest.issuer_identity, {
        status: 'pending', reason: 'issuer_identity_source_missing_unreviewed_or_conflicting',
        historical_materials: [{ material_id: historicalA, material_version: 1 }],
      });
      assert.equal(unreviewedInput.manifest.issuer_name, null, 'unreviewed browser label is not frozen as an issuer identity');
      const firstHash = unreviewedInput.input_hash as string;

      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test')`, [grantId, reviewerId, grantorId]);
      const reviewer = await authorizeIssuerIdentityReviewer(scopedPool, reviewerId);
      assert.ok(reviewer);
      await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId: historicalA, materialVersion: 1,
        sourceRecordRowId: observationA.id, reviewer, decision: 'verified', reasonCode: 'synthetic_identity_verified',
      });
      const observationB = await addSource(historicalB, sourceB.evidenceA, '合成发行人乙', 'entity-synthetic-b');
      await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId: historicalB, materialVersion: 1,
        sourceRecordRowId: observationB.id, reviewer, decision: 'verified', reasonCode: 'synthetic_identity_verified',
      });

      const verifiedInput = await lockInput(projectId, [{ material_id: historicalA, material_version: 1 }]);
      assert.notEqual(verifiedInput.input_hash, firstHash, 'reviewed identity changes the canonical input hash');
      assert.equal(verifiedInput.manifest.issuer_entity_id, 'entity-synthetic-a', 'the submitted historical version selects its own source, even when another historical source exists');
      assert.equal(verifiedInput.manifest.issuer_name, '合成发行人甲', 'model input uses the reviewed source name, not the browser label');
      assert.equal(verifiedInput.manifest.issuer_identity && (verifiedInput.manifest.issuer_identity as Record<string, unknown>).record_id, observationA.id);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).version, observationA.identityVersion);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).content_hash, observationA.contentSha256);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).source_snapshot_id, sourceA.snapshotId);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).source_record_id, sourceA.evidenceA);
      assert.ok(!('issuer_identity' in verifiedInput), 'public input DTO does not expose the internal reviewer/source pin');
      const verifiedInputB = await lockInput(projectId, [{ material_id: historicalB, material_version: 1 }]);
      assert.equal(verifiedInputB.manifest.issuer_entity_id, 'entity-synthetic-b');
      const wrongVersion = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, {
        draft_revision: 1, material_versions: [{ material_id: historicalA, material_version: 2 }], requirement_message_ids: [],
      });
      assert.equal(wrongVersion.statusCode, 404, 'a different version cannot inherit the reviewed identity for version one');

      const ambiguous = await lockInput(projectId, [
        { material_id: historicalA, material_version: 1 }, { material_id: historicalB, material_version: 1 },
      ]);
      assert.deepEqual(ambiguous.manifest.issuer_identity, {
        status: 'pending', reason: 'historical_material_selection_ambiguous',
        historical_materials: [{ material_id: historicalA, material_version: 1 }, { material_id: historicalB, material_version: 1 }],
      });
      const noneSelected = await lockInput(projectId, []);
      assert.equal((noneSelected.manifest.issuer_identity as Record<string, unknown>).reason, 'historical_material_not_selected');

      const replayRequest = { execution_request_id: `execution-${suffix}`, project_id: projectId,
        input_revision: verifiedInput.input_revision, input_hash: verifiedInput.input_hash, task_kind: 'update',
        input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-worker' };
      const runA = await send('POST', '/api/v1/runs/execute', replayRequest);
      const runReplay = await send('POST', '/api/v1/runs/execute', replayRequest);
      assert.equal(runA.statusCode, 202, runA.body); assert.equal(runReplay.statusCode, 202, runReplay.body);
      assert.equal(runReplay.json().run_id, runA.json().run_id, 'the same request replays the same identity-bound run');
      assert.equal((await connection.query('SELECT count(*)::int n FROM bb_jobs WHERE run_id=$1', [runA.json().run_id])).rows[0].n, 1);
      const changedReplay = await send('POST', '/api/v1/runs/execute', { ...replayRequest,
        input_revision: unreviewedInput.input_revision, input_hash: unreviewedInput.input_hash });
      assert.equal(changedReplay.statusCode, 409); assert.equal(changedReplay.json().code, 'IDEMPOTENCY_CONFLICT');

      const conflictObservation = await addSource(historicalA, sourceA.evidenceB, '合成冲突观察', 'entity-conflicting');
      const unreviewedConflict = await lockInput(projectId, [{ material_id: historicalA, material_version: 1 }]);
      assert.equal((unreviewedConflict.manifest.issuer_identity as Record<string, unknown>).reason,
        'issuer_identity_source_missing_unreviewed_or_conflicting', 'a new unreviewed source cannot inherit the previous verified pin');
      await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId: historicalA, materialVersion: 1,
        sourceRecordRowId: conflictObservation.id, reviewer, decision: 'conflict', reasonCode: 'synthetic_identity_conflict',
      });
      const conflicting = await lockInput(projectId, [{ material_id: historicalA, material_version: 1 }]);
      assert.equal((conflicting.manifest.issuer_identity as Record<string, unknown>).reason,
        'issuer_identity_source_missing_unreviewed_or_conflicting', 'a reviewed conflict remains pending');

      const beforeRevoke = await send('POST', '/api/v1/projects/' + projectId + '/preflight', {
        input_revision: verifiedInputB.input_revision, input_hash: verifiedInputB.input_hash,
      });
      assert.equal(beforeRevoke.statusCode, 200, beforeRevoke.body);
      assert.ok(!beforeRevoke.json().missing_inputs.some((value: string) => value.startsWith(`issuer_identity_stale:${historicalB}:`)));
      await connection.query('UPDATE bb_issuer_identity_reviewer_grants SET revoked_at=now() WHERE id=$1', [grantId]);
      const staleReview = await send('POST', '/api/v1/projects/' + projectId + '/preflight', {
        input_revision: verifiedInputB.input_revision, input_hash: verifiedInputB.input_hash,
      });
      assert.equal(staleReview.statusCode, 200, staleReview.body);
      assert.ok(staleReview.json().missing_inputs.includes(`issuer_identity_stale:${historicalB}:1`), 'revoking the grant invalidates preflight for the immutable old revision');
      const staleOriginal = await send('POST', '/api/v1/projects/' + projectId + '/preflight', {
        input_revision: verifiedInput.input_revision, input_hash: verifiedInput.input_hash,
      });
      assert.equal(staleOriginal.statusCode, 200, staleOriginal.body);
      assert.ok(staleOriginal.json().missing_inputs.includes(`issuer_identity_stale:${historicalA}:1`), 'revoking the grant invalidates preflight for the immutable old revision');
      await connection.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
        [owner, projectId, historicalB]);
      const staleMaterial = await send('POST', `/api/v1/projects/${projectId}/preflight`, {
        input_revision: verifiedInputB.input_revision, input_hash: verifiedInputB.input_hash,
      });
      assert.equal(staleMaterial.statusCode, 200, staleMaterial.body);
      assert.ok(staleMaterial.json().missing_inputs.includes(`issuer_material_stale:${historicalB}:1`));

      const nonUpdate = await lockInput(reviewProjectId, [{ material_id: auditMaterial, material_version: 1 }]);
      assert.equal(nonUpdate.manifest.kind, 'review');
      assert.ok(!('issuer_identity' in nonUpdate.manifest), 'non-update input format remains unchanged');
      const nonUpdatePreflight = await send('POST', `/api/v1/projects/${reviewProjectId}/preflight`, {
        input_revision: nonUpdate.input_revision, input_hash: nonUpdate.input_hash,
      });
      assert.equal(nonUpdatePreflight.statusCode, 200, nonUpdatePreflight.body);
      assert.ok(!nonUpdatePreflight.json().missing_inputs.some((value: string) => value.startsWith('issuer_identity_')));

      activeOwner = foreignOwner;
      const isolated = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, {
        draft_revision: 1, material_versions: [{ material_id: historicalA, material_version: 1 }], requirement_message_ids: [],
      });
      assert.equal(isolated.statusCode, 404, 'another owner cannot bind the verified material or identity source');
    } finally {
      await app.close();
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });
