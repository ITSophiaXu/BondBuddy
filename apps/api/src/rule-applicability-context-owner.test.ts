import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer, reviewIssuerIdentitySourceRecord } from './issuer-identity-source.js';
import { createProductionServer, createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('RULE_APPLICABILITY_CONTEXT_TEST_DATABASE_URL');
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const migrated = async () => {
  if (!databaseUrl) return false;
  const pool = new Pool({ connectionString: databaseUrl });
  try { return (await pool.query("SELECT to_regclass('public.bb_rule_applicability_context_drafts') AS name")).rows[0]?.name != null; }
  finally { await pool.end(); }
};
const hasSchema = await migrated();

test('owner applicability API derives a needs_review ref from locked evidence and remains fail-closed',
  { skip: !hasSchema && 'set RULE_APPLICABILITY_CONTEXT_TEST_DATABASE_URL to PostgreSQL 16 migrated through 0039' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `context-api-owner-${suffix}`, foreign = `context-api-foreign-${suffix}`;
    const reviewerId = `context-api-reviewer-${suffix}`, grantorId = `context-api-grantor-${suffix}`;
    const projectId = `context-api-project-${suffix}`, materialId = `context-api-material-${suffix}`;
    const auditMaterialId = `context-api-audit-${suffix}`, auditUploadId = `context-api-audit-upload-${suffix}`;
    const uploadId = `context-api-upload-${suffix}`, snapshotId = `context-api-snapshot-${suffix}`;
    const evidenceId = `context-api-evidence-${suffix}`, grantId = `context-api-grant-${suffix}`;
    const materialHash = sha(`material-${suffix}`);
    const auditHash = sha(`audit-${suffix}`);
    let activeOwner = owner;
    const app = createProductionServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: activeOwner, csrfVerified: true }) });
    const appWithoutProductionLoader = createServer({ pool, allowedOrigin: origin,
      principal: async () => ({ userId: activeOwner, csrfVerified: true }) });
    const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url,
      headers: { origin }, payload: payload as any });
    const sendWithoutProductionLoader = (method: string, url: string, payload?: unknown) => appWithoutProductionLoader.inject({ method: method as any, url,
      headers: { origin }, payload: payload as any });
    const base = `/api/v1/projects/${projectId}`;
    const lockInput = async () => {
      const response = await send('POST', `${base}/input-revisions`, { draft_revision: 1,
        material_versions: [{ material_id: materialId, material_version: 1 },
          { material_id: auditMaterialId, material_version: 1 }], requirement_message_ids: [] });
      assert.equal(response.statusCode, 201, response.body);
      return response.json() as { input_revision: number; input_hash: string };
    };
    try {
      for (const [id, label] of [[owner, 'owner'], [foreign, 'foreign'], [reviewerId, 'reviewer'], [grantorId, 'grantor']] as const) {
        await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `contextapi${label}${suffix}`]);
      }
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details)
        VALUES($1,$2,'Synthetic context API','update','untrusted draft name','sse','private','{}')`, [projectId, owner]);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'source.pdf','application/pdf',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
      [uploadId, owner, projectId, materialHash, `synthetic/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','source.pdf','application/pdf',10,$5,$6,'parsed')`,
      [materialId, owner, projectId, uploadId, materialHash, `users/${owner}/projects/${projectId}/materials/${materialId}`]);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'audit.pdf','application/pdf',11,$4,'audit',$5,now()+interval '1 hour','completed',$4,11)`,
      [auditUploadId, owner, projectId, auditHash, `synthetic/${auditUploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'audit','audit.pdf','application/pdf',11,$5,$6,'parsed')`,
      [auditMaterialId, owner, projectId, auditUploadId, auditHash, `users/${owner}/projects/${projectId}/materials/${auditMaterialId}`]);
      const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${suffix}`, status: 'parsed',
        parser_version: `parser-${suffix}`, material: { material_id: materialId, material_version: 1, media_type: 'application/pdf', sha256: materialHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [snapshotId, owner, projectId, materialId, materialHash, `parser-${suffix}`, sha(`parse-request-${suffix}`),
        sha(`parse-response-${suffix}`), JSON.stringify(meta)]);
      await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
        locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'合成发行人','synthetic evidence','native_text',$8,0.99,'[]','{}',$9,0)`,
      [owner, projectId, materialId, snapshotId, evidenceId, materialHash, JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }),
        `parser-${suffix}`, sha(`record-${suffix}`)]);
      const identity = await appendIssuerIdentitySourceRecord({ pool, newId: randomUUID }, { ownerUserId: owner, projectId,
        materialId, materialVersion: 1, requestId: `identity-request-${suffix}`, sourceRecordId: evidenceId,
        issuerDisplayName: '合成发行人', entityId: `identity-candidate-${suffix}` });
      await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [grantId, reviewerId, grantorId, owner, projectId]);
      const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerId);
      assert.ok(reviewer);
      await reviewIssuerIdentitySourceRecord({ pool, newId: randomUUID }, { ownerUserId: owner, projectId, materialId, materialVersion: 1,
        sourceRecordRowId: identity.id, reviewer, decision: 'verified', verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
        entityBasisKind: 'manual_attestation', entityBasisRef: 'synthetic identity evidence', reasonCode: 'synthetic_verified' });

      const input = await lockInput();
      const path = `${base}/input-revisions/${input.input_revision}/rule-applicability-context-drafts`;
      const assertedByClient = await send('POST', path, { request_id: `extra-field-${suffix}`, market: 'szse' });
      assert.equal(assertedByClient.statusCode, 422, 'client cannot assert market or any other business field');
      const created = await send('POST', path, { request_id: `draft-request-${suffix}` });
      assert.equal(created.statusCode, 201, created.body);
      const createdDto = created.json();
      assert.equal(createdDto.status, 'needs_review');
      assert.equal(createdDto.production_eligible, false);
      assert.deepEqual(Object.keys(createdDto.context_ref).sort(), ['content_hash','context_id','source_input_hash','source_input_revision','version']);
      assert.equal(createdDto.context_ref.source_input_revision, input.input_revision);
      assert.equal(createdDto.context_ref.source_input_hash, input.input_hash);
      const draftRow = await pool.query('SELECT * FROM bb_rule_applicability_context_drafts WHERE id=$1', [createdDto.context_ref.context_id]);
      assert.equal(draftRow.rows[0]!.selected_parse_snapshot_id, snapshotId);
      assert.equal(draftRow.rows[0]!.selected_material_id, materialId);
      assert.equal(draftRow.rows[0]!.source_input_hash.trim(), input.input_hash);
      assert.deepEqual(draftRow.rows[0]!.source_materials, [
        { materialId, materialVersion: 1, sha256: materialHash }, { materialId: auditMaterialId, materialVersion: 1, sha256: auditHash },
      ].sort((a,b)=>a.materialId.localeCompare(b.materialId)), 'the stored pin includes every material in the source revision');
      const candidates = await pool.query(`SELECT field_key,candidate_value,source_kind,source_status FROM bb_rule_applicability_context_candidates
        WHERE context_id=$1 ORDER BY ordinal`, [createdDto.context_ref.context_id]);
      const fields = new Map(candidates.rows.map(row => [row.field_key, row]));
      assert.equal(fields.get('market')!.candidate_value, 'sse');
      assert.equal(fields.get('market')!.source_kind, 'user_asserted');
      assert.equal(fields.get('offering')!.candidate_value, 'private');
      assert.equal(fields.get('offering')!.source_kind, 'user_asserted');
      for (const field of ['asOf','documentPurpose','industry','specialFeatures']) {
        assert.equal(fields.get(field)!.candidate_value, null);
        assert.equal(fields.get(field)!.source_status, 'unknown');
      }

      const getUrl = `${base}/rule-applicability-context-drafts/${createdDto.context_ref.context_id}/versions/${createdDto.context_ref.version}`;
      const read = await send('GET', getUrl);
      assert.equal(read.headers['cache-control'], 'private, no-store');
      assert.deepEqual(read.json(), createdDto);
      const replay = await send('POST', path, { request_id: `draft-request-${suffix}` });
      assert.equal(replay.statusCode, 201, replay.body);
      assert.deepEqual(replay.json(), createdDto, 'same owner/project/request returns the exact persisted ref');
      activeOwner = foreign;
      assert.equal((await send('GET', getUrl)).statusCode, 404, 'foreign account cannot read the ref');
      assert.equal((await send('POST', path, { request_id: `draft-request-${suffix}` })).statusCode, 404,
        'foreign account cannot produce against the project');
      activeOwner = owner;
      assert.equal((await send('GET', `${base}/rule-applicability-context-drafts/unknown/versions/1`)).statusCode, 404);

      const secondInput = await lockInput();
      assert.equal(secondInput.input_revision, input.input_revision + 1);
      const reusedKey = await send('POST', `${base}/input-revisions/${secondInput.input_revision}/rule-applicability-context-drafts`,
        { request_id: `draft-request-${suffix}` });
      assert.equal(reusedKey.statusCode, 409);
      assert.equal(reusedKey.json().code, 'IDEMPOTENCY_CONFLICT');

      const pinned = await send('POST', `${base}/input-revisions`, { draft_revision: 1,
        material_versions: [{ material_id: materialId, material_version: 1 }, { material_id: auditMaterialId, material_version: 1 }], requirement_message_ids: [],
        rule_applicability_context_ref: createdDto.context_ref });
      assert.equal(pinned.statusCode, 201, pinned.body);
      const pinnedInput = await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [projectId, pinned.json().input_revision]);
      assert.equal(pinnedInput.rows[0]!.manifest.rule_pack_selection, 'blocked');
      assert.ok(pinnedInput.rows[0]!.manifest.rule_pack_block_reasons.includes('rule_applicability_taxonomy_and_review_threshold_not_defined'));
      assert.ok(pinnedInput.rows[0]!.manifest.rule_pack_block_reasons.some((reason: string) => reason.startsWith('rule_applicability_field_needs_review:')));

      // The production factory reaches the real needs_review branch, while bare createServer()
      // preserves the explicit test semantic of an unavailable loader.
      const missingLoaderPin = await sendWithoutProductionLoader('POST', `${base}/input-revisions`, {
        draft_revision: 1,
        material_versions: [{ material_id: materialId, material_version: 1 }, { material_id: auditMaterialId, material_version: 1 }],
        requirement_message_ids: [], rule_applicability_context_ref: createdDto.context_ref,
      });
      assert.equal(missingLoaderPin.statusCode, 201, missingLoaderPin.body);
      const missingLoaderManifest = await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [projectId, missingLoaderPin.json().input_revision]);
      assert.ok(missingLoaderManifest.rows[0]!.manifest.rule_pack_block_reasons.includes('rule_applicability_loader_unavailable'));

      await assert.rejects(pool.query("UPDATE bb_rule_applicability_context_drafts SET status='needs_review' WHERE id=$1",
        [createdDto.context_ref.context_id]), /immutable/i);
      await pool.query('UPDATE bb_projects SET draft_revision=2 WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);
      const staleDraft = await send('POST', path, { request_id: `after-draft-drift-${suffix}` });
      assert.equal(staleDraft.statusCode, 409);
      const historicalRead = await send('GET', getUrl);
      assert.equal(historicalRead.statusCode, 200, 'an existing immutable ref remains auditable after later draft drift');
      assert.equal(historicalRead.json().status, 'needs_review');
      assert.equal(historicalRead.json().production_eligible, false);
      await pool.query('UPDATE bb_projects SET draft_revision=1 WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);
      await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
        [owner, projectId, auditMaterialId]);
      const staleMaterial = await send('POST', path, { request_id: `after-material-drift-${suffix}` });
      assert.equal(staleMaterial.statusCode, 409, 'deleting a nonselected source material still invalidates the complete material set');
      await appendIssuerIdentitySourceRecord({ pool, newId: randomUUID }, { ownerUserId: owner, projectId, materialId, materialVersion: 1,
        requestId: `identity-drift-${suffix}`, sourceRecordId: evidenceId, issuerDisplayName: '合成发行人（新观察）',
        entityId: `identity-candidate-new-${suffix}` });
      const staleIdentity = await send('POST', path, { request_id: `after-identity-drift-${suffix}` });
      assert.equal(staleIdentity.statusCode, 409, 'a newer unreviewed identity source invalidates new context selection');
      await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);
      assert.equal((await send('GET', getUrl)).statusCode, 404, 'deleted project scopes are hidden');
    } finally { await app.close(); await appWithoutProductionLoader.close(); await pool.end(); }
  });
