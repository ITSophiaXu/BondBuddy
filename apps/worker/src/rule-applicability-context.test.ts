import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createServer } from '@bondbuddy/api';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { createRuleApplicabilityContextDraft, loadReviewedRuleApplicabilityContext,
  ruleApplicabilityContextHash, type CreateRuleApplicabilityContextDraftRequest, type ReviewedRuleApplicabilityContextArgs,
  type ReviewedRuleApplicabilityContextResult } from '@bondbuddy/rule-applicability-context';
import type { VerifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import type { ProductionRulePackRequest } from '@bondbuddy/rule-pack-registry';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('RULE_APPLICABILITY_CONTEXT_TEST_DATABASE_URL');
const schemaReady = async () => {
  if (!databaseUrl) return false;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query("SELECT to_regclass('public.bb_rule_applicability_context_drafts') AS table_name");
    return result.rows[0]?.table_name != null;
  } finally { await pool.end(); }
};
const hasSchema = await schemaReady();
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type ReviewedIssuerBinding = VerifiedIssuerIdentityBinding;
type FelixReviewedContextLoader = (db: Pick<PoolClient, 'query'>, args: ReviewedRuleApplicabilityContextArgs) => Promise<
  { request: ProductionRulePackRequest; contextPin: Record<string, unknown> } | { status: 'needs_review'; reasons: string[] }
>;
const felixLoaderContract: FelixReviewedContextLoader = loadReviewedRuleApplicabilityContext;
void felixLoaderContract;

async function loadInTransaction(pool: Pool, args: ReviewedRuleApplicabilityContextArgs): Promise<ReviewedRuleApplicabilityContextResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await loadReviewedRuleApplicabilityContext(client, args);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep primary error */ }
    throw error;
  } finally { client.release(); }
}

test('rule applicability context drafts pin exact source evidence, replay idempotently, and remain needs_review',
  { skip: !hasSchema && 'set RULE_APPLICABILITY_CONTEXT_TEST_DATABASE_URL to PostgreSQL 16 migrated through 0039' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `rule-context-owner-${suffix}`, reviewerId = `rule-context-reviewer-${suffix}`;
    const grantorId = `rule-context-grantor-${suffix}`, projectId = `rule-context-project-${suffix}`;
    const materialId = `rule-context-material-${suffix}`, uploadId = `rule-context-upload-${suffix}`;
    const snapshotId = `rule-context-snapshot-${suffix}`, evidenceId = `rule-context-evidence-${suffix}`;
    const reviewerGrantId = `rule-context-grant-${suffix}`, materialHash = sha(`material-${suffix}`);
    const poolLike = pool;
    const app = createServer({ pool: poolLike, allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }) });
    try {
      for (const [id, label] of [[owner, 'owner'], [reviewerId, 'reviewer'], [grantorId, 'grantor']] as const) {
        await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `rulecontext${label}${suffix}`]);
      }
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details)
        VALUES($1,$2,'Synthetic rule context project','update','untrusted draft name','sse','private','{}')`, [projectId, owner]);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'source.pdf','application/pdf',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
      [uploadId, owner, projectId, materialHash, `synthetic/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','source.pdf','application/pdf',10,$5,$6,'parsed')`,
      [materialId, owner, projectId, uploadId, materialHash, `users/${owner}/projects/${projectId}/materials/${materialId}`]);
      const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${suffix}`, status: 'parsed',
        parser_version: `parser-${suffix}`, material: { material_id: materialId, material_version: 1, media_type: 'application/pdf', sha256: materialHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [snapshotId, owner, projectId, materialId, materialHash, `parser-${suffix}`, sha(`request-${suffix}`), sha(`response-${suffix}`), JSON.stringify(meta)]);
      const recordHash = sha(`record-${suffix}`);
      await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
        locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'合成原文证据','synthetic evidence','native_text',$8,0.99,'[]','{}',$9,0)`,
      [owner, projectId, materialId, snapshotId, evidenceId, materialHash, JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }), `parser-${suffix}`, recordHash]);
      const identitySource = await appendIssuerIdentitySourceRecord({ pool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1, requestId: `identity-request-${suffix}`,
        sourceRecordId: evidenceId, issuerDisplayName: '合成发行人', entityId: `entity-${suffix}` });
      await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test')`, [reviewerGrantId, reviewerId, grantorId]);
      const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerId);
      assert.ok(reviewer);
      const reviewedIdentity = await reviewIssuerIdentitySourceRecord({ pool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: identitySource.id,
        reviewer, decision: 'verified', reasonCode: 'synthetic_identity_verified' });
      assert.equal(reviewedIdentity.decision, 'verified');

      const inputResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`, headers: { origin },
        payload: { draft_revision: 1, material_versions: [{ material_id: materialId, material_version: 1 }], requirement_message_ids: [] } });
      assert.equal(inputResponse.statusCode, 201, inputResponse.body);
      const input = inputResponse.json() as { input_revision: number; input_hash: string };
      const lockedInput = await pool.query(`SELECT manifest FROM bb_input_revisions
        WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`, [owner, projectId, input.input_revision]);
      const expectedIssuerBinding = (lockedInput.rows[0]!.manifest as { issuer_identity: ReviewedIssuerBinding }).issuer_identity;
      const currentMaterialVersions = (lockedInput.rows[0]!.manifest as { materials: { material_id: string; material_version: number; sha256: string }[] }).materials
        .map(({ material_id, material_version, sha256 }) => ({ materialId: material_id, materialVersion: material_version, sha256 }));
      const request: CreateRuleApplicabilityContextDraftRequest = {
        ownerUserId: owner, projectId, sourceInputRevision: input.input_revision, sourceInputHash: input.input_hash,
        selectedMaterial: { materialId, materialVersion: 1, sha256: materialHash, parseSnapshotId: snapshotId },
        issuerIdentityBinding: { recordId: identitySource.id, version: identitySource.identityVersion,
          contentHash: identitySource.contentSha256, entityId: `entity-${suffix}`, materialId, materialVersion: 1 },
        asOf: '2025-09-26', documentPurpose: 'registration', requestId: `draft-request-${suffix}`,
        fieldCandidates: [
          { fieldKey: 'market', value: 'sse', sourceKind: 'parse_evidence', sourceStatus: 'recognized',
            evidence: [{ materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId,
              recordId: evidenceId, recordSha256: recordHash }] },
          { fieldKey: 'asOf', value: '2025-09-26', sourceKind: 'user_asserted', sourceStatus: 'user_asserted' },
          { fieldKey: 'documentPurpose', value: 'registration', sourceKind: 'user_asserted', sourceStatus: 'user_asserted' },
          { fieldKey: 'specialFeatures', value: null, sourceKind: 'unknown', sourceStatus: 'unknown' },
        ],
      };
      const created = await createRuleApplicabilityContextDraft(pool, request);
      assert.equal(created.status, 'needs_review');
      assert.equal(ruleApplicabilityContextHash(created.contextPin), created.contentHash,
        'the input manifest reference hash covers the serialized context payload without a self-hash field');
      assert.ok(!('contentHash' in created.contextPin));
      assert.equal(created.contextPin.issuerIdentityBinding.recordId, identitySource.id);
      assert.deepEqual(created.contextPin.sourceMaterials, [{ materialId, materialVersion: 1, sha256: materialHash }],
        'the pin locks the whole input material set, not only selectedMaterial');
      assert.equal(created.contextPin.fieldCandidates.find((candidate) => candidate.fieldKey === 'market')?.evidence?.[0]?.recordSha256, recordHash);
      const exact = { ownerUserId: owner, projectId, contextId: created.contextId, version: created.version,
        contentHash: created.contentHash, expectedSourceInputRevision: input.input_revision,
        expectedSourceInputHash: input.input_hash, expectedIssuerBinding, currentDraftRevision: 1, currentMaterialVersions };
      const loaded = await loadInTransaction(pool, exact);
      if (loaded.status !== 'needs_review') assert.fail('draft unexpectedly became production-ready');
      assert.ok(loaded.reasons.includes('rule_applicability_taxonomy_and_review_threshold_not_defined'));
      assert.equal('request' in loaded, false, 'draft must never return a production rule request');

      await pool.query('UPDATE bb_projects SET draft_revision=2 WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);
      const staleSelection = await loadInTransaction(pool, { ...exact, mode: 'selection' });
      assert.ok(staleSelection.reasons.includes('rule_applicability_current_draft_stale'),
        'a new selection must reject an old project draft');
      const historicalReplay = await loadInTransaction(pool, { ...exact, mode: 'replay' });
      assert.ok(!historicalReplay.reasons.includes('rule_applicability_current_draft_stale'),
        'editing the project draft must not invalidate an immutable source pin');
      await pool.query('UPDATE bb_projects SET draft_revision=1 WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);

      const replay = await createRuleApplicabilityContextDraft(pool, request);
      assert.equal(replay.contextId, created.contextId);
      assert.equal(replay.replayed, true);
      const outbox = await pool.query(`SELECT count(*)::int AS n FROM bb_outbox
        WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='rule_applicability_context.draft_created'`, [owner, created.contextId]);
      assert.equal(outbox.rows[0]!.n, 1, 'replay must not duplicate the outbox event');

      const wrongEvidence = { ...request, requestId: `wrong-anchor-${suffix}`, fieldCandidates: request.fieldCandidates.map((candidate) =>
        candidate.fieldKey === 'market' ? { ...candidate, evidence: [{ ...candidate.evidence![0]!, recordSha256: sha('wrong') }] } : candidate) };
      await assert.rejects(createRuleApplicabilityContextDraft(pool, wrongEvidence), /RULE_CONTEXT_EVIDENCE_ANCHOR_MISMATCH/);
      const otherOwner = await loadInTransaction(pool, { ...exact, ownerUserId: reviewerId });
      assert.deepEqual(otherOwner, { status: 'needs_review', reasons: ['rule_applicability_context_pin_mismatch'] });
      await assert.rejects(pool.query('UPDATE bb_rule_applicability_context_drafts SET status=\'needs_review\' WHERE id=$1', [created.contextId]), /immutable/);
      await assert.rejects(createRuleApplicabilityContextDraft(pool, { ...request,
        fieldCandidates: request.fieldCandidates.map((candidate) => candidate.fieldKey === 'market' ? { ...candidate, value: 'szse' } : candidate) }),
      /RULE_CONTEXT_IDEMPOTENCY_CONFLICT/);

      const nextInputResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`, headers: { origin },
        payload: { draft_revision: 1, material_versions: [{ material_id: materialId, material_version: 1 }], requirement_message_ids: [] } });
      assert.equal(nextInputResponse.statusCode, 201, nextInputResponse.body);
      assert.equal(nextInputResponse.json().input_revision, input.input_revision + 1);
      await assert.rejects(createRuleApplicabilityContextDraft(pool, { ...request, requestId: `stale-source-${suffix}` }),
        /current source revision is unavailable/);
      const historicalPin = await loadInTransaction(pool, exact);
      assert.ok(historicalPin.contextPin, 'old context remains readable against its exact old source pin');

      // Prepare one added material and one replacement version for independent material-set cases.
      const addedMaterialId = `rule-context-added-material-${suffix}`;
      const addedUploadId = `rule-context-added-upload-${suffix}`;
      const addedHash = sha(`added-material-${suffix}`);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'added.pdf','application/pdf',11,$4,'audit',$5,now()+interval '1 hour','completed',$4,11)`,
      [addedUploadId, owner, projectId, addedHash, `synthetic/${addedUploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'audit','added.pdf','application/pdf',11,$5,$6,'parsed')`,
      [addedMaterialId, owner, projectId, addedUploadId, addedHash, `users/${owner}/projects/${projectId}/materials/${addedMaterialId}`]);
      const replacementUploadId = `rule-context-replacement-upload-${suffix}`;
      const replacementHash = sha(`replacement-material-${suffix}`);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'source-v2.pdf','application/pdf',12,$4,'historical',$5,now()+interval '1 hour','completed',$4,12)`,
      [replacementUploadId, owner, projectId, replacementHash, `synthetic/${replacementUploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,2,$2,$3,$4,'historical','source-v2.pdf','application/pdf',12,$5,$6,'parsed')`,
      [materialId, owner, projectId, replacementUploadId, replacementHash, `users/${owner}/projects/${projectId}/materials/${materialId}/2`]);

      const changedInputResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`, headers: { origin },
        payload: { draft_revision: 1, material_versions: [
          { material_id: materialId, material_version: 1 }, { material_id: addedMaterialId, material_version: 1 },
        ], requirement_message_ids: [] } });
      assert.equal(changedInputResponse.statusCode, 201, changedInputResponse.body);
      const changedInput = changedInputResponse.json() as { input_revision: number; input_hash: string };
      assert.equal(changedInput.input_revision, input.input_revision + 2);
      const addedCase = await loadInTransaction(pool, { ...exact, currentMaterialVersions: [
        { materialId, materialVersion: 1, sha256: materialHash }, { materialId: addedMaterialId, materialVersion: 1, sha256: addedHash },
      ] });
      if (addedCase.status !== 'needs_review') assert.fail('adding B unexpectedly reused A context');
      assert.ok(addedCase.reasons.includes('rule_applicability_current_material_set_mismatch'), 'A→A+B is needs_review');
      const replacementCase = await loadInTransaction(pool, { ...exact,
        currentMaterialVersions: [{ materialId, materialVersion: 2, sha256: replacementHash }] });
      if (replacementCase.status !== 'needs_review') assert.fail('replacement A version unexpectedly reused A context');
      assert.ok(replacementCase.reasons.includes('rule_applicability_current_material_set_mismatch'), 'A→A\' is needs_review');

      const addedSource = await pool.query(`SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
        [owner, projectId, changedInput.input_revision]);
      const addedIdentityBinding = (addedSource.rows[0]!.manifest as { issuer_identity: ReviewedIssuerBinding }).issuer_identity;
      assert.equal(addedIdentityBinding.status, 'verified');
      assert.equal(Number.isSafeInteger(addedIdentityBinding.version), true);
      assert.equal(typeof addedIdentityBinding.content_hash, 'string');
      const addedSourceMaterials = (addedSource.rows[0]!.manifest as { materials: { material_id: string; material_version: number; sha256: string }[] }).materials
        .map(({ material_id, material_version, sha256 }) => ({ materialId: material_id, materialVersion: material_version, sha256 }));
      const addedContext = await createRuleApplicabilityContextDraft(pool, { ...request,
        sourceInputRevision: changedInput.input_revision, sourceInputHash: changedInput.input_hash,
        issuerIdentityBinding: { recordId: addedIdentityBinding.record_id, version: addedIdentityBinding.version,
          contentHash: addedIdentityBinding.content_hash, entityId: addedIdentityBinding.entity_id,
          materialId: addedIdentityBinding.material_id, materialVersion: addedIdentityBinding.material_version },
        requestId: `added-source-context-${suffix}` });
      assert.deepEqual(addedContext.contextPin.sourceMaterials, addedSourceMaterials);
      const removedCase = await loadInTransaction(pool, { ownerUserId: owner, projectId, contextId: addedContext.contextId,
        version: addedContext.version, contentHash: addedContext.contentHash, expectedSourceInputRevision: changedInput.input_revision,
        expectedSourceInputHash: changedInput.input_hash, expectedIssuerBinding: addedIdentityBinding, currentDraftRevision: 1,
        currentMaterialVersions: [{ materialId, materialVersion: 1, sha256: materialHash }] });
      if (removedCase.status !== 'needs_review') assert.fail('removing B unexpectedly reused A+B context');
      assert.ok(removedCase.reasons.includes('rule_applicability_current_material_set_mismatch'), 'A+B→A is needs_review');

      const nextSnapshotId = `rule-context-snapshot-new-${suffix}`;
      const nextEvidenceId = `rule-context-evidence-new-${suffix}`;
      const nextMeta = { schema_version: 'document-parse-response-v1', request_id: `parse-new-${suffix}`, status: 'parsed',
        parser_version: `parser-new-${suffix}`, material: { material_id: materialId, material_version: 1, media_type: 'application/pdf', sha256: materialHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [nextSnapshotId, owner, projectId, materialId, materialHash, `parser-new-${suffix}`, sha(`request-new-${suffix}`), sha(`response-new-${suffix}`), JSON.stringify(nextMeta)]);
      await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
        locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'后续版本原文证据','synthetic evidence','native_text',$8,0.99,'[]','{}',$9,0)`,
      [owner, projectId, materialId, nextSnapshotId, nextEvidenceId, materialHash, JSON.stringify({ page: 1, bbox: [0, 1, 1, 2] }),
        `parser-new-${suffix}`, sha(`record-new-${suffix}`)]);
      await appendIssuerIdentitySourceRecord({ pool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1, requestId: `identity-request-new-${suffix}`,
        sourceRecordId: nextEvidenceId, issuerDisplayName: '合成发行人修订候选', entityId: `entity-new-${suffix}` });
      const superseded = await loadInTransaction(pool, exact);
      if (superseded.status !== 'needs_review') assert.fail('superseded identity unexpectedly became production-ready');
      assert.ok(superseded.reasons.includes('rule_applicability_issuer_identity_stale'));
      assert.equal(superseded.contextPin?.id, created.contextId, 'superseded context remains inspectable by its immutable pin');

      await pool.query('UPDATE bb_issuer_identity_reviewer_grants SET revoked_at=now() WHERE id=$1', [reviewerGrantId]);
      await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
        [owner, projectId, materialId]);
      const stale = await loadInTransaction(pool, exact);
      if (stale.status !== 'needs_review') assert.fail('revoked sources unexpectedly became production-ready');
      assert.ok(stale.reasons.includes('rule_applicability_issuer_identity_stale'));
      assert.ok(stale.reasons.includes(`rule_applicability_material_stale:${materialId}:1`));
      const replacedReplay = await loadInTransaction(pool, { ...exact, mode: 'replay' });
      assert.ok(replacedReplay.reasons.includes(`rule_applicability_material_stale:${materialId}:1`),
        'replay must still reject a replaced or deleted pinned material');
      await pool.query('UPDATE bb_projects SET draft_revision=2 WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);
      const draftDrift = await loadInTransaction(pool, { ...exact, currentDraftRevision: 2 });
      assert.deepEqual(draftDrift, { status: 'needs_review', reasons: ['rule_applicability_context_pin_mismatch'] },
        'a changed project draft revision cannot pass an old context pin');
    } finally {
      await app.close();
      await pool.end();
    }
  });

test('producer rejects unknown values represented as facts and empty specialFeatures without reviewed absence', async () => {
  const fakeDb = { connect: async () => { throw new Error('database should not be opened'); } } as never;
  const base = { ownerUserId: 'owner', projectId: 'project', sourceInputRevision: 1, sourceInputHash: 'a'.repeat(64),
    selectedMaterial: { materialId: 'material', materialVersion: 1, sha256: 'b'.repeat(64), parseSnapshotId: 'snapshot' },
    issuerIdentityBinding: { recordId: 'identity', version: 1, contentHash: 'c'.repeat(64), entityId: 'entity', materialId: 'material', materialVersion: 1 },
    asOf: null, documentPurpose: null, requestId: 'request', fieldCandidates: [
      { fieldKey: 'asOf', value: null, sourceKind: 'unknown', sourceStatus: 'unknown' },
      { fieldKey: 'documentPurpose', value: null, sourceKind: 'unknown', sourceStatus: 'unknown' },
    ] } satisfies CreateRuleApplicabilityContextDraftRequest;
  await assert.rejects(createRuleApplicabilityContextDraft(fakeDb, { ...base,
    fieldCandidates: [...base.fieldCandidates, { fieldKey: 'market', value: 'sse', sourceKind: 'unknown', sourceStatus: 'unknown' }] }),
  /RULE_CONTEXT_UNKNOWN_MUST_BE_NULL/);
  await assert.rejects(createRuleApplicabilityContextDraft(fakeDb, { ...base,
    fieldCandidates: [...base.fieldCandidates, { fieldKey: 'specialFeatures', value: [], sourceKind: 'user_asserted', sourceStatus: 'user_asserted' }] }),
  /RULE_CONTEXT_EMPTY_SPECIAL_FEATURES_REQUIRES_REVIEW_RECORD/);
});
