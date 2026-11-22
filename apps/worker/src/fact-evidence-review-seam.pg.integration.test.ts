import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  readFactEvidenceReviewDetermination,
  type FactEvidenceReviewPin,
} from './fact-evidence-review-seam.js';
import {
  readHistoricalFactReviews,
  historicalReviewAllowsExistingFact,
} from './historical-fact-reviews.js';
import { listFactCandidates } from './fact-repository.js';
import { factIdentityKey } from '@bondbuddy/domain/facts';
import { updateContentHash } from '@bondbuddy/domain/historical-update';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('FACT_EVIDENCE_REVIEW_SEAM_TEST_DATABASE_URL');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test(
  'fact evidence review seam reads only exact, current reviewer decisions and fails closed on drift (PostgreSQL 16)',
  {
    skip:
      !testDatabaseUrl &&
      'set FACT_EVIDENCE_REVIEW_SEAM_TEST_DATABASE_URL (or BB_TEST_DATABASE_URL) to a migrated PostgreSQL 16 template',
  },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const suffix = randomUUID().replaceAll('-', '');
    const owner = `frs-owner-${suffix}`,
      otherOwner = `frs-other-${suffix}`,
      reviewer = `frs-reviewer-${suffix}`,
      manager = `frs-manager-${suffix}`,
      project = `frs-project-${suffix}`,
      otherProject = `frs-project-b-${suffix}`;
    const inputHash = sha(`input-${suffix}`);
    const scope = { ownerUserId: owner, projectId: project };
    const client = await pool.connect();

    const seed = async (
      name: string,
      sourceKind: 'audited' | 'external',
      status: string,
      uncertainty: string[],
      completeness: 'complete' | 'incomplete' = 'complete',
    ) => {
      const material = `m-${name}-${suffix}`,
        upload = `u-${name}-${suffix}`,
        snapshot = `p-${name}-${suffix}`,
        candidate = `c-${name}-${suffix}`,
        context = `x-${name}-${suffix}`,
        contentHash = sha(`material-${name}-${suffix}`),
        responseHash = sha(`response-${name}-${suffix}`),
        requestHash = sha(`request-${name}-${suffix}`);
      const confidence = 0.9;
      const factKey = {
        accountId: owner,
        entityId: 'synthetic-issuer',
        scope: 'consolidated',
        metric: 'assets',
        period: { end: '2025-12-31' },
        currency: 'CNY',
        unit: 'yuan',
        basis: 'balance_sheet',
        dataVersion: 'synthetic-v1',
      };
      const factHash = sha(factIdentityKey(factKey));
      const manifest = {
        schema_version: 'fact-evidence-context-v1',
        owner_user_id: owner,
        project_id: project,
        candidate_id: candidate,
        input_revision: 1,
        input_hash: inputHash,
        candidate_identity_sha256: factHash,
        fact_identity: factKey,
        candidate_value: { value_kind: 'decimal', value_decimal: '100', value_text: null },
        source_kind: sourceKind,
        candidate_status: status,
        candidate_uncertainty: uncertainty,
        candidate_confidence: confidence,
        material_id: material,
        material_version: 1,
        material_sha256: contentHash,
        snapshot_id: snapshot,
        parser_version: 'synthetic-parser-1',
        parse_request_hash: requestHash,
        parse_response_sha256: responseHash,
        parse_status: 'needs_confirmation',
        original_warnings: [],
        selected_body: [
          {
            record_id: 'body-anchor',
            content_sha256: sha('cell'),
            locator_type: 'xlsx_cell',
            locator: { sheet: 'Synthetic', cell: 'A1' },
            confidence: null,
            uncertainty: [],
          },
        ],
        auxiliary_targets: [],
        completeness_status: completeness,
        completeness_reasons: completeness === 'complete' ? [] : ['AUXILIARY_SCOPE_UNKNOWN'],
        reviewable: completeness === 'complete',
        evidence_set_sha256: '',
      };
      const { evidence_set_sha256: _priorHash, ...contextBody } = manifest;
      const evidenceHash = updateContentHash(contextBody);
      manifest.evidence_set_sha256 = evidenceHash;
      await client.query(
        `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',20,$5,'financial',$6,now()+interval '1 hour','completed')`,
        [upload, owner, project, `${name}.xlsx`, contentHash, `synthetic/${suffix}/${upload}`],
      );
      await client.query(
        `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'financial',$5,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',20,$6,$7,'parsed')`,
        [
          material,
          owner,
          project,
          upload,
          `${name}.xlsx`,
          contentHash,
          `synthetic/${suffix}/${material}`,
        ],
      );
      await client.query(
        `INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-1',$6,'needs_confirmation','document-parse-response-v1',$7,1,$8::jsonb)`,
        [
          snapshot,
          owner,
          project,
          material,
          contentHash,
          requestHash,
          responseHash,
          JSON.stringify({
            schema_version: 'document-parse-response-v1',
            request_id: `parse-${name}-${suffix}`,
            status: 'needs_confirmation',
            parser_version: 'synthetic-parser-1',
            material: {
              material_id: material,
              material_version: 1,
              media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              sha256: contentHash,
            },
            warnings: [],
            document: {},
            error: null,
          }),
        ],
      );
      await client.query(
        `INSERT INTO bb_fact_candidates(id,owner_user_id,project_id,entity_id,fact_key_hash,fact_key,value_decimal,value_kind,source_kind,source_ref,status,material_id,material_version,evidence,uncertainty,source_observed_at)
      VALUES($1,$2,$3,'synthetic-issuer',$4,$5::jsonb,'100.00','decimal',$6,$7,$8,$9,1,$10::jsonb,$11::jsonb,'2026-09-29T00:00:00Z')`,
        [
          candidate,
          owner,
          project,
          factHash,
          JSON.stringify(factKey),
          sourceKind,
          `${sourceKind}-cache`,
          status,
          material,
          JSON.stringify([
            {
              evidence_id: 'body-anchor',
              material_id: material,
              material_version: 1,
              candidate_confidence: confidence,
              content_hash: contentHash,
              locator_type: 'xlsx_cell',
              locator: { sheet: 'Synthetic', cell: 'A1' },
              literal_quote: '100.00',
              extraction_method: 'native_text',
              extraction_version: 'synthetic-parser-1',
              confidence,
              uncertainty: [],
            },
          ]),
          JSON.stringify(uncertainty),
        ],
      );
      await client.query(
        `INSERT INTO bb_fact_evidence_context_sets(id,owner_user_id,project_id,candidate_id,input_revision,input_hash,material_id,material_version,snapshot_id,parser_version,parse_response_sha256,content_sha256,schema_version,evidence_set_sha256,completeness_status,reviewable,manifest)
      VALUES($1,$2,$3,$4,1,$5,$6,1,$7,'synthetic-parser-1',$8,$9,'fact-evidence-context-v1',$10,$11,$12,$13::jsonb)`,
        [
          context,
          owner,
          project,
          candidate,
          inputHash,
          material,
          snapshot,
          responseHash,
          contentHash,
          evidenceHash,
          completeness,
          completeness === 'complete',
          JSON.stringify(manifest),
        ],
      );
      const pin: FactEvidenceReviewPin = {
        candidateId: candidate,
        evidenceContextSetId: context,
        evidenceSetSha256: evidenceHash,
        candidateIdentitySha256: factHash,
        sourceKind,
        inputRevision: 1,
        inputHash,
        materialId: material,
        materialVersion: 1,
        materialSha256: contentHash,
        snapshotId: snapshot,
        parserVersion: 'synthetic-parser-1',
        parseResponseSha256: responseHash,
      };
      return { pin, ids: { material, upload, snapshot, candidate, context, contentHash } };
    };

    const insertReview = async (
      pin: FactEvidenceReviewPin,
      outcome: string,
      requestId: string,
      grantId: string,
    ): Promise<string> => {
      const pinned = (
        await client.query(
          'SELECT bb_fact_evidence_candidate_snapshot(c) AS snapshot FROM bb_fact_candidates c WHERE c.id=$1',
          [pin.candidateId],
        )
      ).rows[0]!.snapshot;
      const reviewId = `r-${requestId}-${suffix}`;
      await client.query(
        `INSERT INTO bb_fact_evidence_reviews
      (id,request_id,request_hash,owner_user_id,project_id,candidate_id,candidate_identity_sha256,candidate_snapshot,evidence_context_set_id,evidence_set_sha256,
       input_revision,input_hash,material_id,material_version,material_sha256,snapshot_id,parser_version,parse_response_sha256,source_kind,assessments,outcome,
       reviewer_user_id,reviewer_grant_id,authority,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,1,$11,$12,1,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,'fact_evidence_reviewer','Synthetic exact evidence and impact reviewed')`,
        [
          reviewId,
          `req-${requestId}-${suffix}`,
          sha(`request-${requestId}-${suffix}`),
          owner,
          project,
          pin.candidateId,
          pin.candidateIdentitySha256,
          JSON.stringify(pinned),
          pin.evidenceContextSetId,
          pin.evidenceSetSha256,
          inputHash,
          pin.materialId,
          pin.materialSha256,
          pin.snapshotId,
          pin.parserVersion,
          pin.parseResponseSha256,
          pin.sourceKind,
          JSON.stringify([
            {
              target_id: 'body-anchor',
              assessment: 'supports_candidate',
              reason: 'Synthetic exact evidence inspected',
            },
          ]),
          outcome,
          reviewer,
          grantId,
        ],
      );
      return reviewId;
    };

    try {
      const version = await client.query(
        "SELECT current_setting('server_version_num')::integer AS v",
      );
      assert.ok(Number(version.rows[0]!.v) >= 160000, 'requires PostgreSQL 16+');
      const phoneTail = (Number.parseInt(suffix.slice(-6), 16) % 1000000)
        .toString()
        .padStart(6, '0');
      for (const [id, n] of [
        [owner, 1],
        [otherOwner, 2],
        [reviewer, 3],
        [manager, 4],
      ] as const) {
        await client.query('INSERT INTO bb_users(id,phone_e164,username) VALUES($1,$2,$3)', [
          id,
          `+1202555${phoneTail}${n}`,
          `frs${n}${suffix.slice(0, 10)}`,
        ]);
      }
      await client.query(
        "INSERT INTO bb_projects(id,owner_user_id,name,kind,draft_revision) VALUES($1,$2,'synthetic review seam','update',1)",
        [project, owner],
      );
      await client.query(
        "INSERT INTO bb_projects(id,owner_user_id,name,kind,draft_revision) VALUES($1,$2,'synthetic review seam b','update',1)",
        [otherProject, owner],
      );
      await client.query(
        `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,
        [project, owner, inputHash],
      );
      await client.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [project]);
      await client.query(
        `INSERT INTO bb_fact_evidence_reviewer_grants(id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'fact_evidence_reviewer',$3,'authorized_review','Synthetic test-only authorization',$4,$5)`,
        [`grant-${suffix}`, reviewer, manager, owner, project],
      );
      const grantId = `grant-${suffix}`;

      // Positive: audited, complete context, all supports -> evidence_impact_reviewed is offerable.
      const audited = await seed('audited-ok', 'audited', 'extracted', []);
      await insertReview(audited.pin, 'evidence_impact_reviewed', 'audited-ok', grantId);
      const reviewed = await readFactEvidenceReviewDetermination({ pool }, scope, audited.pin);
      assert.equal(reviewed.reviewedAndCurrent, true);
      assert.equal(reviewed.offerable, true);
      assert.equal(reviewed.reason, 'review_current');
      // Replay idempotency: repeated reads return the same verdict and never append.
      assert.deepEqual(
        await readFactEvidenceReviewDetermination({ pool }, scope, audited.pin),
        reviewed,
        'seam read is idempotent',
      );
      assert.equal(
        Number(
          (
            await client.query(
              'SELECT count(*)::integer AS n FROM bb_fact_evidence_reviews WHERE owner_user_id=$1 AND project_id=$2',
              [owner, project],
            )
          ).rows[0]!.n,
        ),
        1,
      );

      // External: evidence and impact reviewed only; source kind and original fields remain untouched.
      const external = await seed('external', 'external', 'needs_confirmation', [
        'EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED',
      ]);
      await insertReview(external.pin, 'external_evidence_impact_reviewed', 'external', grantId);
      const externalResult = await readFactEvidenceReviewDetermination(
        { pool },
        scope,
        external.pin,
      );
      assert.equal(externalResult.reviewedAndCurrent, true);
      assert.equal(externalResult.externalImpactReviewed, true);
      assert.equal(
        externalResult.offerable,
        false,
        'external review never promotes a candidate to an audited offerable fact',
      );
      assert.equal(externalResult.sourceKind, 'external');
      const externalCandidate = await client.query(
        'SELECT status,source_kind,uncertainty FROM bb_fact_candidates WHERE id=$1',
        [external.pin.candidateId],
      );
      assert.equal(externalCandidate.rows[0]!.status, 'needs_confirmation');
      assert.equal(externalCandidate.rows[0]!.source_kind, 'external');
      assert.deepEqual(
        externalCandidate.rows[0]!.uncertainty,
        ['EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED'],
        'original uncertainty is preserved',
      );

      // Unresolved: incomplete context records needs_more_evidence and is never reviewed/offerable.
      const incomplete = await seed('incomplete', 'audited', 'extracted', [], 'incomplete');
      await insertReview(incomplete.pin, 'needs_more_evidence', 'incomplete', grantId);
      const incompleteResult = await readFactEvidenceReviewDetermination(
        { pool },
        scope,
        incomplete.pin,
      );
      assert.equal(incompleteResult.reviewedAndCurrent, false);
      assert.equal(incompleteResult.offerable, false);
      assert.equal(incompleteResult.reason, 'review_needs_more_evidence');

      // An unresolved source conflict is recorded as needs_more_evidence and never offered.
      const conflicted = await seed('conflicted', 'audited', 'conflicted', []);
      await insertReview(conflicted.pin, 'needs_more_evidence', 'conflicted', grantId);
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, conflicted.pin)).reason,
        'review_needs_more_evidence',
      );

      // Cross-account and cross-project isolation: the same pin in another scope is never matched.
      const crossAccount = await readFactEvidenceReviewDetermination(
        { pool },
        { ownerUserId: otherOwner, projectId: project },
        audited.pin,
      );
      assert.equal(crossAccount.reason, 'no_current_exact_review');
      const crossProject = await readFactEvidenceReviewDetermination(
        { pool },
        { ownerUserId: owner, projectId: otherProject },
        audited.pin,
      );
      assert.equal(crossProject.reason, 'no_current_exact_review');

      // Exercise the #31 consumer's real SQL, canonical set hash and frozen review binding.
      const consumerScope = { ...scope, inputRevision: 1, inputHash };
      const consumerFacts = async (candidateId: string) =>
        (await listFactCandidates({ pool }, scope)).filter(
          (f) => f.candidate.candidateId === candidateId,
        );
      const auditedFacts = await consumerFacts(audited.pin.candidateId);
      const consumerPin = await readHistoricalFactReviews({ pool }, consumerScope, auditedFacts);
      assert.equal(consumerPin.entries[0]!.determination!.offerable, true);
      assert.deepEqual(
        await readHistoricalFactReviews({ pool }, consumerScope, auditedFacts, consumerPin),
        consumerPin,
      );
      const negative = await readHistoricalFactReviews(
        { pool },
        consumerScope,
        await consumerFacts(incomplete.pin.candidateId),
      );
      assert.equal(historicalReviewAllowsExistingFact(negative, incomplete.pin.candidateId), false);

      // Withdrawal removes the decision from the current projection.
      const withdrawn = await seed('withdrawn', 'audited', 'extracted', []);
      const withdrawnReviewId = await insertReview(
        withdrawn.pin,
        'evidence_impact_reviewed',
        'withdrawn',
        grantId,
      );
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, withdrawn.pin)).offerable,
        true,
      );
      const withdrawnFacts = await consumerFacts(withdrawn.pin.candidateId);
      const beforeWithdrawal = await readHistoricalFactReviews(
        { pool },
        consumerScope,
        withdrawnFacts,
      );
      await client.query(
        `INSERT INTO bb_fact_evidence_review_withdrawals(id,request_id,request_hash,review_id,owner_user_id,project_id,reviewer_user_id,reviewer_grant_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Synthetic withdrawal')`,
        [
          `wd-${suffix}`,
          `wd-request-${suffix}`,
          sha(`wd-${suffix}`),
          withdrawnReviewId,
          owner,
          project,
          reviewer,
          grantId,
        ],
      );
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, withdrawn.pin)).reason,
        'no_current_exact_review',
      );

      await assert.rejects(
        readHistoricalFactReviews({ pool }, consumerScope, withdrawnFacts, beforeWithdrawal),
        /UPDATE_FACT_EVIDENCE_REVIEW_CHANGED/,
      );
      const afterWithdrawal = await readHistoricalFactReviews(
        { pool },
        consumerScope,
        withdrawnFacts,
      );
      assert.equal(
        historicalReviewAllowsExistingFact(afterWithdrawal, withdrawn.pin.candidateId),
        false,
        'withdrawn review cannot silently fall back to no-review eligibility',
      );

      // A newer material version invalidates the reviewed pin.
      const materialDrift = await seed('material-drift', 'audited', 'extracted', []);
      await insertReview(materialDrift.pin, 'evidence_impact_reviewed', 'material-drift', grantId);
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, materialDrift.pin)).offerable,
        true,
      );
      const newerUpload = `u2-${suffix}`,
        newerMaterialHash = sha(`material v2 ${suffix}`);
      await client.query(
        `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'v2.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',21,$4,'financial',$5,now()+interval '1 hour','completed')`,
        [newerUpload, owner, project, newerMaterialHash, `synthetic/${suffix}/${newerUpload}`],
      );
      await client.query(
        `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,2,$2,$3,$4,'financial','v2.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',21,$5,$6,'parsed')`,
        [
          materialDrift.pin.materialId,
          owner,
          project,
          newerUpload,
          newerMaterialHash,
          `synthetic/${suffix}/${materialDrift.pin.materialId}-v2`,
        ],
      );
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, materialDrift.pin)).reason,
        'no_current_exact_review',
        'a newer material version fails closed',
      );

      // A newer parse snapshot invalidates the reviewed pin.
      const parseDrift = await seed('parse-drift', 'audited', 'extracted', []);
      await insertReview(parseDrift.pin, 'evidence_impact_reviewed', 'parse-drift', grantId);
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, parseDrift.pin)).offerable,
        true,
      );
      const newerSnapshot = `p2-${suffix}`,
        newerResponse = sha(`response v2 ${suffix}`),
        newerRequest = sha(`request v2 ${suffix}`);
      await client.query(
        `INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-2',$6,'needs_confirmation','document-parse-response-v1',$7,1,$8::jsonb,now()+interval '1 second')`,
        [
          newerSnapshot,
          owner,
          project,
          parseDrift.pin.materialId,
          parseDrift.ids.contentHash,
          newerRequest,
          newerResponse,
          JSON.stringify({
            schema_version: 'document-parse-response-v1',
            request_id: `parse-v2-${suffix}`,
            status: 'needs_confirmation',
            parser_version: 'synthetic-parser-2',
            material: {
              material_id: parseDrift.pin.materialId,
              material_version: 1,
              media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              sha256: parseDrift.ids.contentHash,
            },
            warnings: [],
            document: {},
            error: null,
          }),
        ],
      );
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, parseDrift.pin)).reason,
        'no_current_exact_review',
        'a newer parse snapshot fails closed',
      );

      // A newer evidence context set for the same candidate invalidates the reviewed pin.
      const evidenceDrift = await seed('evidence-drift', 'audited', 'extracted', []);
      await insertReview(evidenceDrift.pin, 'evidence_impact_reviewed', 'evidence-drift', grantId);
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, evidenceDrift.pin)).offerable,
        true,
      );
      const priorEvidenceFacts = await consumerFacts(evidenceDrift.pin.candidateId);
      const beforeEvidenceChange = await readHistoricalFactReviews(
        { pool },
        consumerScope,
        priorEvidenceFacts,
      );
      const newerContext = `x2-${suffix}`;
      const priorManifest = (
        await client.query('SELECT manifest FROM bb_fact_evidence_context_sets WHERE id=$1', [
          evidenceDrift.pin.evidenceContextSetId,
        ])
      ).rows[0]!.manifest;
      const { evidence_set_sha256: _oldEvidenceHash, ...priorBody } = priorManifest as Record<
        string,
        unknown
      >;
      const newerBody = {
        ...priorBody,
        original_warnings: [
          { code: 'SYNTHETIC_CONTEXT_CHANGE', message: 'Synthetic later evidence inventory' },
        ],
      };
      const newerEvidenceHash = updateContentHash(newerBody);
      const newerManifest = { ...newerBody, evidence_set_sha256: newerEvidenceHash };
      await client.query(
        `INSERT INTO bb_fact_evidence_context_sets(id,owner_user_id,project_id,candidate_id,input_revision,input_hash,material_id,material_version,snapshot_id,parser_version,parse_response_sha256,content_sha256,schema_version,evidence_set_sha256,completeness_status,reviewable,manifest)
      VALUES($1,$2,$3,$4,1,$5,$6,1,$7,'synthetic-parser-1',$8,$9,'fact-evidence-context-v1',$10,'complete',true,$11::jsonb)`,
        [
          newerContext,
          owner,
          project,
          evidenceDrift.pin.candidateId,
          inputHash,
          evidenceDrift.pin.materialId,
          evidenceDrift.pin.snapshotId,
          evidenceDrift.pin.parseResponseSha256,
          evidenceDrift.ids.contentHash,
          newerEvidenceHash,
          JSON.stringify(newerManifest),
        ],
      );
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, evidenceDrift.pin)).reason,
        'no_current_exact_review',
        'a newer evidence context set fails closed',
      );

      await assert.rejects(
        readHistoricalFactReviews(
          { pool },
          consumerScope,
          priorEvidenceFacts,
          beforeEvidenceChange,
        ),
        /UPDATE_FACT_EVIDENCE_REVIEW_CHANGED/,
      );
      const unreviewedNewContext = await readHistoricalFactReviews(
        { pool },
        consumerScope,
        priorEvidenceFacts,
      );
      assert.equal(unreviewedNewContext.entries[0]!.hasRecordedReview, true);
      assert.equal(
        historicalReviewAllowsExistingFact(unreviewedNewContext, evidenceDrift.pin.candidateId),
        false,
        'new context must not erase an existing review and fall back to unreviewed eligibility',
      );

      // A revoked reviewer grant removes every decision it authorized from the current projection.
      await client.query(
        `UPDATE bb_fact_evidence_reviewer_grants SET revoked_at=now(),revoked_by=$2,revocation_reason='Synthetic revocation' WHERE id=$1 AND revoked_at IS NULL`,
        [grantId, manager],
      );
      assert.equal(
        (await readFactEvidenceReviewDetermination({ pool }, scope, audited.pin)).reason,
        'no_current_exact_review',
        'grant revocation fails closed',
      );

      await assert.rejects(
        readHistoricalFactReviews({ pool }, consumerScope, auditedFacts, consumerPin),
        /UPDATE_FACT_EVIDENCE_REVIEW_CHANGED/,
      );

      // Malformed seam input is rejected instead of silently widening scope.
      await assert.rejects(
        readFactEvidenceReviewDetermination(
          { pool },
          { ownerUserId: '', projectId: project },
          audited.pin,
        ),
        /FACT_EVIDENCE_REVIEW_SEAM_INVALID_SCOPE/,
      );
      await assert.rejects(
        readFactEvidenceReviewDetermination({ pool }, scope, {
          ...audited.pin,
          evidenceSetSha256: 'not-a-hash',
        }),
        /FACT_EVIDENCE_REVIEW_SEAM_INVALID_PIN/,
      );
    } finally {
      client.release();
      await pool.end();
    }
  },
);
