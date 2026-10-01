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
import { testIssuerCandidateMatches, type TestIssuerCandidate } from './test-issuer-candidate.js';

import { isolatedTestDatabase } from './test-database.js';
const databaseUrl = await isolatedTestDatabase();
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const verifiedA = 'entity:11111111-1111-4111-8111-111111111111';
const verifiedB = 'entity:22222222-2222-4222-8222-222222222222';
const reviewBasis = (verifiedEntityId: string) => ({ verifiedEntityId, entityBasisKind: 'manual_attestation' as const,
  entityBasisRef: 'synthetic identity review' });

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
    const foreignProjectId = `input-foreign-project-${suffix}`;
    const historicalA = `input-historical-a-${suffix}`, historicalB = `input-historical-b-${suffix}`;
    const reviewProjectMaterial = `input-review-project-material-${suffix}`;
    const auditMaterial = `input-audit-${suffix}`;
    const grantId = `input-review-grant-${suffix}`;
    const secondProjectGrantId = `input-review-project-grant-${suffix}`;
    const legacyGrantId = `input-legacy-review-grant-${suffix}`;
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
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details)
        VALUES($1,$2,'Foreign review','review','{}')`, [foreignProjectId, foreignOwner]);

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

      const reviewProjectBytes = sha(`synthetic bytes ${reviewProjectMaterial}`);
      const reviewProjectUpload = `upload-${reviewProjectMaterial}`;
      const reviewProjectSnapshot = `snapshot-${reviewProjectMaterial}`;
      const reviewProjectEvidence = `evidence-${reviewProjectMaterial}`;
      await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
      [reviewProjectUpload, owner, reviewProjectId, reviewProjectBytes, `synthetic/${reviewProjectUpload}`]);
      await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',10,$5,$6,'parsed')`,
      [reviewProjectMaterial, owner, reviewProjectId, reviewProjectUpload, reviewProjectBytes, `users/${owner}/projects/${reviewProjectId}/${reviewProjectMaterial}`]);
      const reviewMeta = { schema_version: 'document-parse-response-v1', request_id: `parse-${reviewProjectSnapshot}`, status: 'parsed',
        parser_version: `parser-${suffix}`, material: { material_id: reviewProjectMaterial, material_version: 1, media_type: 'application/pdf', sha256: reviewProjectBytes },
        warnings: [], document: { page_count: 1 }, error: null };
      await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [reviewProjectSnapshot, owner, reviewProjectId, reviewProjectMaterial, reviewProjectBytes, `parser-${suffix}`,
        sha(`parse-request-${reviewProjectSnapshot}`), sha(`parse-response-${reviewProjectSnapshot}`), JSON.stringify(reviewMeta)]);
      await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
        locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'合成第二项目发行人','synthetic test evidence','native_text',$8,0.99,'[]','{}',$9,0)`,
      [owner, reviewProjectId, reviewProjectMaterial, reviewProjectSnapshot, reviewProjectEvidence, reviewProjectBytes,
        JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }), `parser-${suffix}`, sha(reviewProjectEvidence)]);

      const sourceA = grants[0]!;
      const sourceB = grants[1]!;
      const observationA = await addSource(historicalA, sourceA.evidenceA, '合成发行人甲', 'entity-synthetic-a');
      const observationB = await addSource(historicalB, sourceB.evidenceA, '合成发行人乙', 'entity-synthetic-b');
      const observationC = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId: reviewProjectId, materialId: reviewProjectMaterial, materialVersion: 1,
        requestId: `request-${reviewProjectEvidence}`, sourceRecordId: reviewProjectEvidence,
        issuerDisplayName: '合成第二项目发行人', entityId: 'entity-synthetic-c',
      });
      const observationsUrl = `/api/v1/projects/${projectId}/materials/${historicalA}/versions/1/issuer-identity/observations`;
      const listed = await send('GET', observationsUrl);
      assert.equal(listed.statusCode, 200, listed.body);
      assert.equal(listed.json().status, 'needs_review');
      assert.equal(listed.json().items[0].source_record_id, observationA.id);
      assert.equal(listed.json().items[0].locator, undefined, 'owner status excludes raw evidence');
      assert.equal(listed.json().items[0].quote, undefined);
      const reviewerUrl = `/api/v1/reviewer/projects/${projectId}/materials/${historicalA}/versions/1/issuer-identity/observations`;
      activeOwner = foreignOwner;
      assert.equal((await send('GET', observationsUrl)).statusCode, 404, 'another account cannot inspect evidence');
      assert.equal((await send('GET', reviewerUrl)).statusCode, 404, 'unrelated account cannot use reviewer read');
      activeOwner = reviewerId;
      const reviewUrl = `${observationsUrl}/${observationA.id}/review`;
      const observedHashes = {expected_content_sha256:observationA.contentSha256,
        expected_snapshot_sha256:sha(`parse-response-${sourceA.snapshotId}`)};
      let reviewBody = {decision:'verified',reason_code:'synthetic_identity_verified',verified_entity_id:verifiedA,
        ...observedHashes,
        entity_basis_kind:'manual_attestation',entity_basis_ref:'synthetic identity review'};
      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'legacy_test')`, [legacyGrantId, reviewerId, grantorId]);
      await connection.query(`INSERT INTO bb_issuer_identity_source_reviews
        (id,owner_user_id,project_id,material_id,material_version,source_record_id,identity_version,content_sha256,entity_id,
         reviewer_user_id,reviewer_grant_id,decision,reason_code,verified_entity_id,entity_basis_kind,entity_basis_ref)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,'verified','legacy_review', $11,'manual_attestation','synthetic legacy review')`,
      [`legacy-review-${suffix}`, owner, projectId, historicalB, observationB.id, observationB.identityVersion,
        observationB.contentSha256, observationB.entityId, reviewerId, legacyGrantId, verifiedB]);
      assert.equal((await loadVerifiedIssuerIdentitySourceRecord(scopedPool, { ownerUserId: owner, projectId, materialId: historicalB, materialVersion: 1 }))?.entityId,
        verifiedB, 'an existing verified review tied to an active legacy grant remains valid history');
      const secondProjectObservations = `/api/v1/projects/${reviewProjectId}/materials/${reviewProjectMaterial}/versions/1/issuer-identity/observations`;
      const secondProjectReviewUrl = `${secondProjectObservations}/${observationC.id}/review`;
      const legacyOnlyBody = {decision:'verified',reason_code:'synthetic_identity_verified',verified_entity_id:verifiedA,
        expected_content_sha256:observationC.contentSha256,expected_snapshot_sha256:sha(`parse-response-${reviewProjectSnapshot}`),
        entity_basis_kind:'manual_attestation',entity_basis_ref:'synthetic identity review'};
      assert.equal((await send('POST',reviewUrl,reviewBody)).statusCode,404,'legacy unscoped grant cannot authorize a new review');
      assert.equal((await send('POST',secondProjectReviewUrl,legacyOnlyBody)).statusCode,404,'legacy grant cannot authorize another project');
      assert.equal((await send('GET',reviewerUrl)).statusCode,404,'legacy unscoped grant cannot read reviewer observations');
      assert.equal((await send('GET',`/api/v1/reviewer/projects/${reviewProjectId}/materials/${reviewProjectMaterial}/versions/1/issuer-identity/observations`)).statusCode,404,
        'legacy unscoped grant cannot read another project');
      activeOwner = owner;
      const unreviewedInput = await lockInput(projectId, [{ material_id: historicalA, material_version: 1 }]);
      assert.deepEqual(unreviewedInput.manifest.issuer_identity, {
        status: 'pending', reason: 'issuer_identity_source_missing_unreviewed_or_conflicting',
        historical_materials: [{ material_id: historicalA, material_version: 1 }],
      });
      assert.equal(unreviewedInput.manifest.issuer_name, null, 'unreviewed browser label is not frozen as an issuer identity');
      const candidate=unreviewedInput.manifest.test_issuer_candidate as Record<string,unknown>;
      assert.equal(candidate.status,'pending_test_candidate');
      assert.equal(candidate.source_record_id,observationA.id);
      assert.equal(candidate.content_sha256,observationA.contentSha256);
      assert.equal(candidate.candidate_key,observationA.entityId);
      assert.equal(unreviewedInput.manifest.issuer_entity_id,null,'test evidence does not promote a verified issuer entity');
      assert.equal(await testIssuerCandidateMatches(scopedPool,{ownerUserId:owner,projectId},candidate as TestIssuerCandidate),true);
      const firstHash = unreviewedInput.input_hash as string;

      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants
        (id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [grantId, reviewerId, grantorId, owner, projectId]);
      const reviewer = await authorizeIssuerIdentityReviewer(scopedPool, reviewerId,{ownerUserId:owner,projectId});
      assert.ok(reviewer);
      activeOwner=reviewerId;
      const reviewerRead=await send('GET',reviewerUrl);
      assert.equal(reviewerRead.statusCode,200,reviewerRead.body);
      assert.equal(reviewerRead.json().items[0].quote,'合成发行人甲');
      assert.deepEqual(reviewerRead.json().items[0].locator,{page:1,bbox:[0,0,1,1]});
      assert.equal(reviewerRead.json().items[0].coverage,'complete');
      assert.deepEqual(reviewerRead.json().items[0].parse_warnings,[]);
      const secondProjectReviewerUrl = `/api/v1/reviewer/projects/${reviewProjectId}/materials/${reviewProjectMaterial}/versions/1/issuer-identity/observations`;
      assert.equal((await send('POST',secondProjectReviewUrl,legacyOnlyBody)).statusCode,404,
        'the first project grant cannot authorize a review POST for a second project');
      assert.equal((await send('GET',reviewerUrl.replace(projectId,foreignProjectId))).statusCode,404,'reviewer scope excludes another owner');
      const crossOwnerReviewUrl = `/api/v1/projects/${foreignProjectId}/materials/${reviewProjectMaterial}/versions/1/issuer-identity/observations/${observationC.id}/review`;
      assert.equal((await send('POST',crossOwnerReviewUrl,reviewBody)).statusCode,404,
        'a grant for another owner/project cannot authorize a review POST');
      await assert.rejects(reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId: reviewProjectId, materialId: reviewProjectMaterial, materialVersion: 1,
        sourceRecordRowId: observationC.id, reviewer, decision: 'verified', ...reviewBasis(verifiedA), reasonCode: 'cross_project_attempt',
      }), /REVIEWER_NOT_AUTHORIZED/);
      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants
        (id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [secondProjectGrantId, reviewerId, grantorId, owner, reviewProjectId]);
      await connection.query('SAVEPOINT duplicate_project_grant');
      await assert.rejects(connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants
        (id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`,
      [`duplicate-${suffix}`, reviewerId, grantorId, owner, projectId]), /unique|duplicate/i,
      'the database enforces one active grant per reviewer/owner/project');
      await connection.query('ROLLBACK TO SAVEPOINT duplicate_project_grant');
      const secondProjectReviewer = await authorizeIssuerIdentityReviewer(scopedPool, reviewerId,{ownerUserId:owner,projectId:reviewProjectId});
      assert.ok(secondProjectReviewer);
      assert.equal(await authorizeIssuerIdentityReviewer(scopedPool, reviewerId),null,
        'an unscoped resolver refuses to guess when multiple project grants exist');
      const secondProjectRead = await send('GET', secondProjectReviewerUrl);
      assert.equal(secondProjectRead.statusCode,200,secondProjectRead.body);
      assert.equal(secondProjectRead.json().items[0].quote,'合成第二项目发行人');
      const secondProjectReviewBody = {...legacyOnlyBody,
        expected_content_sha256:secondProjectRead.json().items[0].content_sha256,
        expected_snapshot_sha256:secondProjectRead.json().items[0].snapshot_sha256};
      assert.equal((await send('POST',secondProjectReviewUrl,secondProjectReviewBody)).statusCode,201,
        'the same reviewer can write through a second exact project grant');
      assert.equal((await loadVerifiedIssuerIdentitySourceRecord(scopedPool,{ownerUserId:owner,projectId:reviewProjectId,
        materialId:reviewProjectMaterial,materialVersion:1}))?.entityId,verifiedA);
      const readAudit=await connection.query(`SELECT payload FROM bb_outbox WHERE event_type='issuer.identity_source.reviewer_read'
        AND owner_user_id=$1 AND aggregate_id=$2`,[owner,projectId]);
      assert.equal(readAudit.rows.length,1);
      assert.equal(readAudit.rows[0].payload.reviewer_user_id,reviewerId);
      reviewBody={...reviewBody,expected_content_sha256:reviewerRead.json().items[0].content_sha256,
        expected_snapshot_sha256:reviewerRead.json().items[0].snapshot_sha256};
      const stale=await send('POST',reviewUrl,{...reviewBody,expected_snapshot_sha256:'a'.repeat(64)});
      assert.equal(stale.statusCode,409,stale.body);
      assert.equal(stale.json().code,'ISSUER_IDENTITY_SNAPSHOT_CONFLICT');
      assert.equal((await send('POST',reviewUrl,{...reviewBody,expected_content_sha256:'b'.repeat(64)})).statusCode,409,
        'review cannot attest a different observation content hash');
      for (const invalid of [
        { decision: 'verified', reason_code: 'synthetic_identity_verified' },
        { ...reviewBody, verified_entity_id: 'issuer-name:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { ...reviewBody, verified_entity_id: 'uscc:91310000MA1FL00008', entity_basis_kind: 'uscc', entity_basis_ref: '91310000MA1FL00009' },
      ]) {
        const rejected = await send('POST', reviewUrl, invalid);
        assert.equal(rejected.statusCode, 400, rejected.body);
        assert.equal(rejected.json().code, 'ISSUER_IDENTITY_VERIFICATION_INVALID');
      }
      assert.equal((await connection.query('SELECT count(*)::int n FROM bb_issuer_identity_source_reviews WHERE source_record_id=$1', [observationA.id])).rows[0].n, 0);
      const reviewed=await send('POST',reviewUrl,reviewBody);
      assert.equal(reviewed.statusCode,201,reviewed.body);
      const replay=await send('POST',reviewUrl,reviewBody);
      assert.equal(replay.statusCode,201,replay.body);assert.equal(replay.json().replayed,true);
      assert.equal(replay.json().review_id,reviewed.json().review_id);
      assert.equal((await send('POST',reviewUrl,{decision:'rejected',reason_code:'synthetic_identity_verified',
        expected_content_sha256:reviewBody.expected_content_sha256,expected_snapshot_sha256:reviewBody.expected_snapshot_sha256})).statusCode,409);
      activeOwner=owner;
      assert.equal((await send('GET',observationsUrl)).json().status,'verified');
      assert.equal((await send('GET',observationsUrl.replace(historicalA,historicalB))).json().status,'verified',
        'the active legacy grant continues to back an existing verified review');

      const oldInput=(await connection.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
        [owner,projectId,unreviewedInput.input_revision])).rows[0].manifest as Record<string,unknown>;
      assert.equal((oldInput.issuer_identity as Record<string,unknown>).status,'pending','review never rewrites a locked input revision');

      const verifiedInput = await lockInput(projectId, [{ material_id: historicalA, material_version: 1 }]);
      assert.equal(await testIssuerCandidateMatches(scopedPool,{ownerUserId:owner,projectId},candidate as TestIssuerCandidate),false,
        'a reviewer decision invalidates the old pending test candidate');
      assert.notEqual(verifiedInput.input_hash, firstHash, 'reviewed identity changes the canonical input hash');
      assert.equal(verifiedInput.manifest.issuer_entity_id, verifiedA, 'the submitted historical version selects its own source, even when another historical source exists');
      assert.equal(verifiedInput.manifest.issuer_name, '合成发行人甲', 'model input uses the reviewed source name, not the browser label');
      assert.equal(verifiedInput.manifest.issuer_identity && (verifiedInput.manifest.issuer_identity as Record<string, unknown>).record_id, observationA.id);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).version, observationA.identityVersion);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).content_hash, observationA.contentSha256);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).source_snapshot_id, sourceA.snapshotId);
      assert.equal((verifiedInput.manifest.issuer_identity as Record<string, unknown>).source_record_id, sourceA.evidenceA);
      assert.ok(!('issuer_identity' in verifiedInput), 'public input DTO does not expose the internal reviewer/source pin');
      const verifiedInputB = await lockInput(projectId, [{ material_id: historicalB, material_version: 1 }]);
      assert.equal(verifiedInputB.manifest.issuer_entity_id, verifiedB);
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
      await connection.query("UPDATE bb_issuer_identity_reviewer_grants SET revoked_at=now(),revoked_by=$2,revocation_reason_code='synthetic_test',revocation_basis='synthetic test' WHERE id=$1", [grantId, grantorId]);
      activeOwner=reviewerId;
      assert.equal((await send('POST',reviewUrl,reviewBody)).statusCode,404,'revoked grant cannot replay or review');
      assert.equal((await send('GET',reviewerUrl)).statusCode,404,'revoked grant cannot read');
      assert.equal((await send('GET',`/api/v1/reviewer/projects/${reviewProjectId}/materials/${reviewProjectMaterial}/versions/1/issuer-identity/observations`)).statusCode,200,
        'revoking one project grant does not revoke another project grant for the same reviewer');
      activeOwner=owner;
      assert.equal((await send('GET',observationsUrl)).json().status,'needs_review','revoked review cannot count as verified');
      assert.equal((await connection.query('SELECT count(*)::int n FROM bb_issuer_identity_source_reviews WHERE source_record_id=$1',[observationA.id])).rows[0].n,1,
        'revocation preserves the append-only review history');
      assert.equal((await loadVerifiedIssuerIdentitySourceRecord(scopedPool,{ownerUserId:owner,projectId,materialId:historicalA,materialVersion:1})),null,
        'revoking the scoped grant removes its review from the active verified binding');
      assert.equal((await connection.query('SELECT count(*)::int n FROM bb_issuer_identity_source_reviews WHERE source_record_id=$1',[observationB.id])).rows[0].n,1,
        'the legacy verified decision remains in historical storage');
      assert.equal((await loadVerifiedIssuerIdentitySourceRecord(scopedPool,{ownerUserId:owner,projectId,materialId:historicalB,materialVersion:1}))?.entityId,verifiedB,
        'an active legacy grant continues to support its existing verified review');
      const staleReview = await send('POST', '/api/v1/projects/' + projectId + '/preflight', {
        input_revision: verifiedInputB.input_revision, input_hash: verifiedInputB.input_hash,
      });
      assert.equal(staleReview.statusCode, 200, staleReview.body);
      assert.ok(!staleReview.json().missing_inputs.includes(`issuer_identity_stale:${historicalB}:1`), 'the active legacy review remains usable for the existing immutable revision');
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
      assert.equal(staleMaterial.statusCode, 409, staleMaterial.body);
      assert.equal(staleMaterial.json().code,'INPUT_REVISION_CONFLICT');

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
