import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { appendRuleApplicabilityFieldReview, getRuleApplicabilityFieldReview,
  getRuleApplicabilityFieldReviewTarget } from './rule-applicability-field-reviews.js';
import { createRuleApplicabilityContextDraft } from '@bondbuddy/rule-applicability-context';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer, reviewIssuerIdentitySourceRecord } from './issuer-identity-source.js';
import { createProductionServer, createServer } from './server.js';
import { loadTargetConfirmation } from './target-confirmation.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('RULE_APPLICABILITY_CONTEXT_TEST_DATABASE_URL');
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const migrated = async () => {
  if (!databaseUrl) return false;
  const pool = new Pool({ connectionString: databaseUrl });
  try { return (await pool.query("SELECT to_regclass('public.bb_rule_applicability_overall_reviews') AS name")).rows[0]?.name != null; }
  finally { await pool.end(); }
};
const hasSchema = await migrated();

test('owner applicability API derives a needs_review ref from locked evidence and remains fail-closed',
  { skip: !hasSchema && 'set RULE_APPLICABILITY_CONTEXT_TEST_DATABASE_URL to PostgreSQL 16 migrated through 0054' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `context-api-owner-${suffix}`, foreign = `context-api-foreign-${suffix}`;
    const reviewerId = `context-api-reviewer-${suffix}`, grantorId = `context-api-grantor-${suffix}`;
    const ruleReviewerId = `context-api-rule-reviewer-${suffix}`;
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
    const lockInput = async (targetConfirmation?: { market: 'sse'; offering: 'private'; document_purpose: 'registration';
      as_of: string; target_reporting_periods: [] }) => {
      const response = await send('POST', `${base}/input-revisions`, { draft_revision: 1,
        material_versions: [{ material_id: materialId, material_version: 1 },
          { material_id: auditMaterialId, material_version: 1 }], requirement_message_ids: [],
        ...(targetConfirmation ? { target_confirmation: targetConfirmation } : {}) });
      assert.equal(response.statusCode, 201, response.body);
      return response.json() as { input_revision: number; input_hash: string };
    };
    try {
      for (const [id, label] of [[owner, 'owner'], [foreign, 'foreign'], [reviewerId, 'reviewer'],
        [grantorId, 'grantor'], [ruleReviewerId, 'rvr']] as const) {
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

      // A separate internal candidate exercises the field ledger against a real immutable parse-evidence anchor.
      const reviewContext = await createRuleApplicabilityContextDraft(pool, {
        ownerUserId: owner, projectId, sourceInputRevision: input.input_revision, sourceInputHash: input.input_hash,
        selectedMaterial: { materialId, materialVersion: 1, sha256: materialHash, parseSnapshotId: snapshotId },
        issuerIdentityBinding: { recordId: identity.id, version: identity.identityVersion, contentHash: identity.contentSha256,
          entityId: 'entity:11111111-1111-4111-8111-111111111111', materialId, materialVersion: 1 },
        asOf: null, documentPurpose: null, requestId: `field-ledger-context-${suffix}`,
        fieldCandidates: [
          { fieldKey: 'asOf', value: null, sourceKind: 'unknown', sourceStatus: 'unknown' },
          { fieldKey: 'documentPurpose', value: null, sourceKind: 'unknown', sourceStatus: 'unknown' },
          { fieldKey: 'instrument', value: 'ordinary-company-bond', sourceKind: 'parse_evidence', sourceStatus: 'recognized',
            evidence: [{ materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId,
              recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }] },
          { fieldKey: 'instrumentConflict', value: 'ordinary-company-bond', sourceKind: 'parse_evidence', sourceStatus: 'recognized',
            conflictRefs: [evidenceId], evidence: [{ materialId, materialVersion: 1, materialSha256: materialHash,
              parseSnapshotId: snapshotId, recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }] },
          { fieldKey: 'industry', value: 'industry-unapproved', sourceKind: 'parse_evidence', sourceStatus: 'recognized',
            evidence: [{ materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId,
              recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }] },
          { fieldKey: 'specialFeatures', value: ['feature-unapproved'], sourceKind: 'parse_evidence', sourceStatus: 'recognized',
            evidence: [{ materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId,
              recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }] },
        ],
      });
      const reviewCandidates = (await pool.query(`SELECT field_key,candidate_id FROM bb_rule_applicability_context_candidates
        WHERE context_id=$1`, [reviewContext.contextId])).rows;
      await assert.rejects(pool.query(`INSERT INTO bb_rule_applicability_context_candidates
        (context_id,owner_user_id,project_id,context_version,candidate_id,field_key,ordinal,candidate_value,
         source_kind,source_status,conflict_refs,review_decision,review_status)
        VALUES($1,$2,$3,1,$4,'specialFeatures',99,'[]'::jsonb,'parse_evidence','recognized','[]'::jsonb,NULL,'needs_review')`,
      [reviewContext.contextId, owner, projectId, `empty-special-features-${suffix}`]), /empty specialFeatures requires/i,
      'an empty specialFeatures candidate cannot bypass the missing complete negative-evidence ledger');
      const candidate = reviewCandidates.find((row) => row.field_key === 'instrument')!;
      const candidateId = String(candidate.candidate_id);
      const ruleGrantId = `context-api-rule-grant-${suffix}`;
      await pool.query(`INSERT INTO bb_rule_applicability_reviewer_grants
        (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'rule_applicability_reviewer',$3,'synthetic_test','Synthetic PG regression only',$4,$5)`,
      [ruleGrantId, ruleReviewerId, grantorId, owner, projectId]);
      const reviewScope = { ownerUserId: owner, projectId };
      const overallReviewUrl = `${base}/rule-applicability-context-drafts/${createdDto.context_ref.context_id}/versions/1/reviews`;
      activeOwner = owner;
      const selfOverallReview = await send('POST', overallReviewUrl, { request_id: `overall-self-${suffix}`, action: 'withdraw', reason: 'self review' });
      assert.equal(selfOverallReview.statusCode, 404, 'review route does not reveal whether another owner has a context');
      activeOwner = ruleReviewerId;
      const requestMore = await send('POST', overallReviewUrl, { request_id: `overall-more-${suffix}`, action: 'request_more_evidence', reason: 'Need complete evidence' });
      assert.equal(requestMore.statusCode, 201, requestMore.body);
      const withdrawal = await send('POST', overallReviewUrl, { request_id: `overall-withdraw-${suffix}`, action: 'withdraw', reason: 'Synthetic withdrawal test' });
      assert.equal(withdrawal.statusCode, 201, withdrawal.body);
      const replayWithdrawal = await send('POST', overallReviewUrl, { request_id: `overall-withdraw-${suffix}`, action: 'withdraw', reason: 'Synthetic withdrawal test' });
      assert.equal(replayWithdrawal.json().review_id, withdrawal.json().review_id, 'withdrawal retries replay the same append-only row');
      assert.equal(replayWithdrawal.json().replayed, true);
      const denyOverallFunction = `deny_overall_review_outbox_${suffix}`, denyOverallTrigger = `deny_overall_review_event_${suffix}`;
      await pool.query(`CREATE FUNCTION ${denyOverallFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.aggregate_type='rule_applicability_overall_review' THEN RAISE EXCEPTION 'synthetic overall outbox failure'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER ${denyOverallTrigger} BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION ${denyOverallFunction}()`);
      try {
        const failedOutbox = await send('POST', overallReviewUrl, { request_id: `overall-outbox-failure-${suffix}`,
          action: 'request_more_evidence', reason: 'Atomic outbox test' });
        assert.equal(failedOutbox.statusCode, 500);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_rule_applicability_overall_reviews WHERE request_id=$1',
          [`overall-outbox-failure-${suffix}`])).rows[0]!.n, 0, 'overall decision rolls back if its outbox event fails');
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${denyOverallTrigger} ON bb_outbox`);
        await pool.query(`DROP FUNCTION IF EXISTS ${denyOverallFunction}()`);
      }
      const incompleteNegativeEvidence = await send('POST', overallReviewUrl, { request_id: `overall-incomplete-${suffix}`, action: 'approve',
        reason: 'Must enumerate every feature dimension', approved_values: { market: 'sse', offering: 'private', instrument: 'ordinary-company-bond',
          documentStage: 'registration', issuerScope: 'domestic-company', investorScope: 'professional', industry: 'industry-code-v1',
          specialFeatures: [], asOf: '2026-09-27' }, value_evidence: { instrument: [{ materialId, materialVersion: 1, materialSha256: materialHash,
          parseSnapshotId: snapshotId, recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }],
          issuerScope: [{ materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId, recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }],
          investorScope: [{ materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId, recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }],
          industry: [{ materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId, recordId: evidenceId, recordSha256: sha(`record-${suffix}`) }] },
        feature_evidence: [], taxonomy_version: 'bondbuddy-applicability-test-v1' });
      assert.equal(incompleteNegativeEvidence.statusCode, 422, 'an empty feature evidence vector cannot approve an empty specialFeatures value');
      activeOwner = owner;
      const reviewTarget = { contextId: reviewContext.contextId, contextVersion: 1, candidateId, fieldKey: 'instrument' };
      const trustedTarget = await getRuleApplicabilityFieldReviewTarget(pool, { userId: ruleReviewerId }, reviewScope, reviewTarget);
      assert.ok(trustedTarget);
      assert.equal(trustedTarget.sourceKind, 'parse_evidence');
      assert.equal(trustedTarget.evidenceRefs.length, 1);
      const intentOrUnknown = (await pool.query(`SELECT candidate_id,field_key FROM bb_rule_applicability_context_candidates
        WHERE context_id=$1 AND field_key=ANY($2::text[])`, [createdDto.context_ref.context_id,
        ['market','offering','industry','specialFeatures']])).rows;
      for (const row of intentOrUnknown) {
        const fieldKey = String(row.field_key);
        const target = { contextId: createdDto.context_ref.context_id, contextVersion: 1,
          candidateId: String(row.candidate_id), fieldKey };
        const current = await getRuleApplicabilityFieldReviewTarget(pool, { userId: ruleReviewerId }, reviewScope, target);
        assert.ok(current);
        await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: reviewScope,
          target: { ...target, candidateHash: current.candidateHash }, requestId: `intent-unknown-${fieldKey}-${suffix}`,
          action: 'adopt_candidate', reason: 'Target intent is not material evidence; unknown stays unresolved' }),
        /FIELD_REVIEW_CANDIDATE_NOT_ADOPTABLE/);
      }
      for (const fieldKey of ['industry','specialFeatures','instrumentConflict']) {
        const unapproved = reviewCandidates.find((row) => row.field_key === fieldKey)!;
        const unapprovedTarget = { contextId: reviewContext.contextId, contextVersion: 1,
          candidateId: String(unapproved.candidate_id), fieldKey };
        const unapprovedDigest = await getRuleApplicabilityFieldReviewTarget(pool, { userId: ruleReviewerId }, reviewScope, unapprovedTarget);
        assert.ok(unapprovedDigest);
        await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: reviewScope,
          target: { ...unapprovedTarget, candidateHash: unapprovedDigest.candidateHash },
          requestId: `unapproved-${fieldKey}-${suffix}`, action: 'adopt_candidate', reason: 'Taxonomy not approved' }),
        /FIELD_REVIEW_CANDIDATE_NOT_ADOPTABLE/);
      }
      assert.equal(await getRuleApplicabilityFieldReviewTarget(pool, { userId: owner }, reviewScope, reviewTarget), null,
        'owner cannot self-review');
      assert.equal(await getRuleApplicabilityFieldReviewTarget(pool, { userId: reviewerId }, reviewScope, reviewTarget), null,
        'issuer-identity reviewer grant does not authorize applicability review');
      const forgedTarget = { ...reviewTarget, candidateId: `forged-${suffix}` };
      assert.equal(await getRuleApplicabilityFieldReviewTarget(pool, { userId: ruleReviewerId }, reviewScope, forgedTarget), null,
        'a caller cannot claim a candidate that is absent from the immutable context');
      await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: reviewScope,
        target: { ...forgedTarget, candidateHash: trustedTarget.candidateHash }, requestId: `forged-candidate-${suffix}`,
        action: 'adopt_candidate', reason: 'forged candidate identifier' }), /FIELD_REVIEW_CANDIDATE_NOT_FOUND/);
      const requestReviewWithId = (requestId: string,
        action: 'adopt_candidate' | 'request_more_evidence' | 'out_of_scope' = 'adopt_candidate') => appendRuleApplicabilityFieldReview(pool, {
        principal: { userId: ruleReviewerId }, scope: reviewScope,
        target: { ...reviewTarget, candidateHash: trustedTarget.candidateHash },
        requestId, action, reason: 'Synthetic evidence review',
      });
      const requestReview = (action: 'adopt_candidate' | 'request_more_evidence' | 'out_of_scope' = 'adopt_candidate') =>
        requestReviewWithId(`field-review-${suffix}`, action);
      await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: owner }, scope: reviewScope,
        target: { ...reviewTarget, candidateHash: trustedTarget.candidateHash }, requestId: `owner-review-${suffix}`,
        action: 'adopt_candidate', reason: 'self review is forbidden' }), /FIELD_REVIEW_REVIEWER_NOT_AUTHORIZED/);
      await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: reviewScope,
        target: { ...reviewTarget, candidateHash: '0'.repeat(64) }, requestId: `forged-hash-${suffix}`,
        action: 'adopt_candidate', reason: 'forged hash' }), /FIELD_REVIEW_CANDIDATE_HASH_MISMATCH/);
      const fieldReview = await requestReview();
      assert.equal(fieldReview.action, 'adopt_candidate');
      assert.equal(fieldReview.sourceInputHash, input.input_hash);
      assert.equal(fieldReview.reviewerUserId, ruleReviewerId);
      assert.equal(fieldReview.reviewerGrantId, ruleGrantId);
      assert.equal(fieldReview.evidenceRefs[0]!.recordId, evidenceId);
      assert.equal((await getRuleApplicabilityFieldReview(pool, { userId: ruleReviewerId }, reviewScope, fieldReview.id))?.id, fieldReview.id);
      const unchangedCandidate = await pool.query(`SELECT review_decision,review_status FROM bb_rule_applicability_context_candidates
        WHERE context_id=$1 AND candidate_id=$2`, [reviewContext.contextId, candidateId]);
      assert.equal(unchangedCandidate.rows[0]!.review_decision, null);
      assert.equal(unchangedCandidate.rows[0]!.review_status, 'needs_review', 'field action never mutates or approves the candidate/context');
      const replayedReview = await requestReview();
      assert.equal(replayedReview.id, fieldReview.id);
      assert.equal(replayedReview.replayed, true, 'same request and content replay the immutable ledger row');
      await assert.rejects(requestReview('out_of_scope'), /FIELD_REVIEW_IDEMPOTENCY_CONFLICT/);
      const concurrentRequest = `field-review-concurrent-${suffix}`;
      const concurrentReviews = await Promise.all([requestReviewWithId(concurrentRequest), requestReviewWithId(concurrentRequest)]);
      assert.equal(concurrentReviews[0]!.id, concurrentReviews[1]!.id, 'concurrent same-key requests serialize to one immutable decision');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_rule_applicability_field_reviews WHERE request_id=$1',
        [concurrentRequest])).rows[0]!.n, 1);
      const beforeCounterfeit = await pool.query('SELECT * FROM bb_rule_applicability_field_reviews WHERE id=$1', [fieldReview.id]);
      const counterfeit = beforeCounterfeit.rows[0]!;
      await assert.rejects(pool.query(`INSERT INTO bb_rule_applicability_field_reviews
        (id,request_id,request_hash,owner_user_id,project_id,context_id,context_version,context_content_hash,
         source_input_revision,source_input_hash,candidate_id,field_key,candidate_ordinal,candidate_hash,candidate_snapshot,
         candidate_value,conflict_refs,source_kind,source_status,action,reason,evidence_refs,reviewer_user_id,reviewer_grant_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [`counterfeit-${suffix}`, `counterfeit-request-${suffix}`, '1'.repeat(64), counterfeit.owner_user_id, counterfeit.project_id,
        counterfeit.context_id, counterfeit.context_version, counterfeit.context_content_hash, counterfeit.source_input_revision,
        counterfeit.source_input_hash, counterfeit.candidate_id, counterfeit.field_key, counterfeit.candidate_ordinal,
        '0'.repeat(64), JSON.stringify(counterfeit.candidate_snapshot), JSON.stringify(counterfeit.candidate_value),
        JSON.stringify(counterfeit.conflict_refs), counterfeit.source_kind, counterfeit.source_status,
        'adopt_candidate', 'counterfeit hash', JSON.stringify(counterfeit.evidence_refs),
        counterfeit.reviewer_user_id, counterfeit.reviewer_grant_id]), /candidate hash mismatch/i,
      'DB guard recomputes snapshot hash; direct SQL cannot attach a forged digest');
      const projectB = `context-api-project-b-${suffix}`;
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details)
        VALUES($1,$2,'Synthetic other project','update','synthetic','sse','private','{}')`, [projectB, owner]);
      const wrongProjectScope = { ownerUserId: owner, projectId: projectB };
      assert.equal(await getRuleApplicabilityFieldReviewTarget(pool, { userId: ruleReviewerId }, wrongProjectScope, reviewTarget), null,
        'reviewer grant scope does not extend to another project');
      assert.equal(await getRuleApplicabilityFieldReview(pool, { userId: ruleReviewerId }, wrongProjectScope, fieldReview.id), null,
        'the ledger read is exact-project scoped');
      await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: wrongProjectScope,
        target: { ...reviewTarget, candidateHash: trustedTarget.candidateHash }, requestId: `cross-project-${suffix}`,
        action: 'adopt_candidate', reason: 'cross-project attempt' }), /FIELD_REVIEW_REVIEWER_NOT_AUTHORIZED/);
      const foreignScope = { ownerUserId: foreign, projectId };
      assert.equal(await getRuleApplicabilityFieldReviewTarget(pool, { userId: ruleReviewerId }, foreignScope, reviewTarget), null,
        'review authorization is bound to exact owner as well as project');
      await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: foreignScope,
        target: { ...reviewTarget, candidateHash: trustedTarget.candidateHash }, requestId: `cross-owner-${suffix}`,
        action: 'adopt_candidate', reason: 'cross-owner attempt' }), /FIELD_REVIEW_REVIEWER_NOT_AUTHORIZED/);
      const denyFunction = `deny_field_review_outbox_${suffix}`;
      const denyTrigger = `deny_field_review_event_${suffix}`;
      await pool.query(`CREATE FUNCTION ${denyFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.aggregate_type='rule_applicability_field_review' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER ${denyTrigger} BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION ${denyFunction}()`);
      try {
        await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: reviewScope,
          target: { ...reviewTarget, candidateHash: trustedTarget.candidateHash }, requestId: `atomic-outbox-${suffix}`,
          action: 'out_of_scope', reason: 'Atomic outbox failure check' }), /synthetic outbox failure/);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bb_rule_applicability_field_reviews WHERE request_id=$1`,
          [`atomic-outbox-${suffix}`])).rows[0]!.n, 0, 'ledger insert rolls back when same-transaction outbox write fails');
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${denyTrigger} ON bb_outbox`);
        await pool.query(`DROP FUNCTION IF EXISTS ${denyFunction}()`);
      }
      await pool.query(`UPDATE bb_rule_applicability_reviewer_grants SET revoked_at=now(),revoked_by=$2,
        revocation_reason_code='synthetic_test',revocation_basis='Synthetic revoke test' WHERE id=$1`, [ruleGrantId, grantorId]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_rule_applicability_field_reviews WHERE id=$1', [fieldReview.id])).rows[0]!.n, 1,
        'revoking the grant preserves immutable historical review evidence');
      assert.equal(await getRuleApplicabilityFieldReview(pool, { userId: ruleReviewerId }, reviewScope, fieldReview.id), null,
        'revoked reviewers cannot use the current-authority read helper; historical evidence remains stored');
      await assert.rejects(appendRuleApplicabilityFieldReview(pool, { principal: { userId: ruleReviewerId }, scope: reviewScope,
        target: { ...reviewTarget, candidateHash: trustedTarget.candidateHash }, requestId: `after-revoke-${suffix}`,
        action: 'out_of_scope', reason: 'revoked reviewer' }), /FIELD_REVIEW_REVIEWER_NOT_AUTHORIZED/);

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

      const secondInput = await lockInput({ market: 'sse', offering: 'private', document_purpose: 'registration',
        as_of: '2026-09-27', target_reporting_periods: [] });
      assert.equal(secondInput.input_revision, input.input_revision + 1);
      const confirmedManifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
        [owner, projectId, secondInput.input_revision])).rows[0]!.manifest;
      assert.deepEqual(await loadTargetConfirmation(pool, owner, projectId, secondInput.input_revision),
        confirmedManifest.target_confirmation);
      const confirmedDraft = await send('POST', `${base}/input-revisions/${secondInput.input_revision}/rule-applicability-context-drafts`,
        { request_id: `confirmed-draft-${suffix}` });
      assert.equal(confirmedDraft.statusCode, 201, confirmedDraft.body);
      assert.equal(confirmedDraft.json().status, 'needs_review', 'confirmed target intent never approves a context');
      const auditSnapshotId = `context-api-audit-snapshot-${suffix}`, auditEvidenceId = `context-api-audit-evidence-${suffix}`;
      const auditMeta = { schema_version: 'document-parse-response-v1', request_id: `audit-parse-${suffix}`, status: 'parsed',
        parser_version: `parser-${suffix}`, material: { material_id: auditMaterialId, material_version: 1, media_type: 'application/pdf', sha256: auditHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [auditSnapshotId, owner, projectId, auditMaterialId, auditHash, `parser-${suffix}`, sha(`audit-parse-request-${suffix}`),
        sha(`audit-parse-response-${suffix}`), JSON.stringify(auditMeta)]);
      await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
        locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'合成审计材料','synthetic negative evidence anchor','native_text',$8,0.99,'[]','{}',$9,0)`,
      [owner, projectId, auditMaterialId, auditSnapshotId, auditEvidenceId, auditHash,
        JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }), `parser-${suffix}`, sha(`audit-record-${suffix}`)]);
      const renewedRuleGrantId = `context-api-rule-grant-renewed-${suffix}`;
      await pool.query(`INSERT INTO bb_rule_applicability_reviewer_grants
        (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'rule_applicability_reviewer',$3,'synthetic_test','Synthetic PG regression only',$4,$5)`,
      [renewedRuleGrantId, ruleReviewerId, grantorId, owner, projectId]);
      const evidenceRefs = [
        { materialId, materialVersion: 1, materialSha256: materialHash, parseSnapshotId: snapshotId, recordId: evidenceId, recordSha256: sha(`record-${suffix}`) },
        { materialId: auditMaterialId, materialVersion: 1, materialSha256: auditHash, parseSnapshotId: auditSnapshotId, recordId: auditEvidenceId, recordSha256: sha(`audit-record-${suffix}`) },
      ];
      const completeFeatureEvidence = ['urban_construction','real_estate','group_operations','special_product_or_use','embedded_or_perpetual',
        'optimized_review','restructuring','special_issuer','transition_arrangement'].map(dimension => ({ dimension, outcome: 'absent',
          reason: 'Synthetic regression only; the complete locked material set is enumerated.', evidenceRefs }));
      const confirmedReviewUrl = `${base}/rule-applicability-context-drafts/${confirmedDraft.json().context_ref.context_id}/versions/1/reviews`;
      activeOwner = ruleReviewerId;
      const approvedReview = await send('POST', confirmedReviewUrl, { request_id: `overall-approve-${suffix}`, action: 'approve',
        reason: 'Synthetic regression only; no professional signoff is represented.', approved_values: { market: 'sse', offering: 'private',
          instrument: 'ordinary-company-bond', documentStage: 'registration', issuerScope: 'domestic-company', investorScope: 'professional',
          industry: 'industry-code-v1', specialFeatures: [], asOf: '2026-09-27' },
        value_evidence: { instrument: [evidenceRefs[0]], issuerScope: [evidenceRefs[0]], investorScope: [evidenceRefs[0]], industry: [evidenceRefs[0]] },
        feature_evidence: completeFeatureEvidence, taxonomy_version: 'bondbuddy-applicability-synthetic-test-v1' });
      assert.equal(approvedReview.statusCode, 201, approvedReview.body);
      assert.equal(approvedReview.json().action, 'approve');
      assert.equal(approvedReview.json().production_eligible, false, 'context review never claims rule release or industry compliance');
      activeOwner = owner;
      const approvedInput = await send('POST', `${base}/input-revisions`, { draft_revision: 1,
        material_versions: [{ material_id: materialId, material_version: 1 }, { material_id: auditMaterialId, material_version: 1 }],
        requirement_message_ids: [], rule_applicability_context_ref: confirmedDraft.json().context_ref });
      assert.equal(approvedInput.statusCode, 201, approvedInput.body);
      const approvedPin = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
        [owner, projectId, approvedInput.json().input_revision])).rows[0]!.manifest;
      assert.ok(approvedPin.rule_pack_block_reasons.includes('rule_applicability_taxonomy_not_published'),
        'a reviewer-provided synthetic version is not a server-published taxonomy and cannot reach selection');
      assert.ok(!approvedPin.rule_pack_block_reasons.includes('production_rule_pack_registry_empty'),
        'the loader stops before production selection while the real taxonomy mapping remains unpublished');
      activeOwner = ruleReviewerId;
      const withdrawApproved = await send('POST', confirmedReviewUrl, { request_id: `overall-withdraw-approved-${suffix}`,
        action: 'withdraw', reason: 'Synthetic regression withdrawal' });
      assert.equal(withdrawApproved.statusCode, 201, withdrawApproved.body);
      const replayOldApproval = await send('POST', confirmedReviewUrl, { request_id: `overall-approve-${suffix}`, action: 'approve',
        reason: 'Synthetic regression only; no professional signoff is represented.', approved_values: { market: 'sse', offering: 'private',
          instrument: 'ordinary-company-bond', documentStage: 'registration', issuerScope: 'domestic-company', investorScope: 'professional',
          industry: 'industry-code-v1', specialFeatures: [], asOf: '2026-09-27' },
        value_evidence: { instrument: [evidenceRefs[0]], issuerScope: [evidenceRefs[0]], investorScope: [evidenceRefs[0]], industry: [evidenceRefs[0]] },
        feature_evidence: completeFeatureEvidence, taxonomy_version: 'bondbuddy-applicability-synthetic-test-v1' });
      assert.equal(replayOldApproval.statusCode, 201, replayOldApproval.body);
      assert.equal(replayOldApproval.json().replayed, true, 'replaying an old approval does not append or supersede withdrawal');
      activeOwner = owner;
      const withdrawnInput = await send('POST', `${base}/input-revisions`, { draft_revision: 1,
        material_versions: [{ material_id: materialId, material_version: 1 }, { material_id: auditMaterialId, material_version: 1 }],
        requirement_message_ids: [], rule_applicability_context_ref: confirmedDraft.json().context_ref });
      assert.equal(withdrawnInput.statusCode, 201, withdrawnInput.body);
      const withdrawnPin = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
        [owner, projectId, withdrawnInput.json().input_revision])).rows[0]!.manifest;
      assert.ok(withdrawnPin.rule_pack_block_reasons.includes('rule_applicability_overall_review_withdrawn'));
      activeOwner = owner;
      const confirmedFields = await pool.query(`SELECT field_key,candidate_value,source_kind,source_status
        FROM bb_rule_applicability_context_candidates WHERE context_id=$1 AND field_key=ANY($2::text[])`,
      [confirmedDraft.json().context_ref.context_id, ['asOf', 'documentPurpose']]);
      const confirmedByKey = new Map(confirmedFields.rows.map(row => [row.field_key, row]));
      assert.deepEqual(confirmedByKey.get('asOf'), { field_key: 'asOf', candidate_value: '2026-09-27',
        source_kind: 'user_asserted', source_status: 'user_asserted' });
      assert.deepEqual(confirmedByKey.get('documentPurpose'), { field_key: 'documentPurpose', candidate_value: 'registration',
        source_kind: 'user_asserted', source_status: 'user_asserted' });
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
      assert.ok(pinnedInput.rows[0]!.manifest.rule_pack_block_reasons.includes('rule_applicability_overall_review_withdrawn'));
      assert.ok(!pinnedInput.rows[0]!.manifest.rule_pack_block_reasons.includes('rule_applicability_taxonomy_and_review_threshold_not_defined'));

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
