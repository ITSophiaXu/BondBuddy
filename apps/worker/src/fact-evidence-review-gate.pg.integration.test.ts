import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { FactIdentity } from '@bondbuddy/domain/facts';
import {
  gateReviewedOfferableFacts,
  type FactEvidenceReviewGateScope,
} from './fact-evidence-review-gate.js';
import type { FactEvidenceReviewPin } from './fact-evidence-review-seam.js';
import type { StoredFactCandidate } from './fact-repository.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('FACT_EVIDENCE_REVIEW_GATE_TEST_DATABASE_URL');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test(
  'the review gate consumes only exact current reviewer decisions over real PostgreSQL 16 rows',
  {
    skip:
      !testDatabaseUrl &&
      'set FACT_EVIDENCE_REVIEW_GATE_TEST_DATABASE_URL (or BB_TEST_DATABASE_URL) to a migrated PostgreSQL 16 template',
  },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const suffix = randomUUID().replaceAll('-', '');
    const owner = `frg-owner-${suffix}`,
      reviewer = `frg-reviewer-${suffix}`,
      manager = `frg-manager-${suffix}`,
      project = `frg-project-${suffix}`;
    const inputHash = sha(`input-${suffix}`);
    const scope: FactEvidenceReviewGateScope = {
      ownerUserId: owner,
      projectId: project,
      issuerEntityId: 'synthetic-issuer',
    };
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
        factHash = sha(`identity-${name}-${suffix}`),
        contentHash = sha(`material-${name}-${suffix}`),
        responseHash = sha(`response-${name}-${suffix}`),
        requestHash = sha(`request-${name}-${suffix}`),
        evidenceHash = sha(`evidence-${name}-${suffix}`);
      const confidence = 0.9;
      const factKey = {
        accountId: owner,
        entityId: 'synthetic-issuer',
        scope: 'consolidated',
        metric: `assets_${name}`,
        period: { end: '2025-12-31' },
        currency: 'CNY',
        unit: 'yuan',
        basis: 'balance_sheet',
        dataVersion: 'synthetic-v1',
      };
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
        evidence_set_sha256: evidenceHash,
      };
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
        `INSERT INTO bb_fact_candidates(id,owner_user_id,project_id,entity_id,fact_key_hash,fact_key,value_decimal,value_kind,source_kind,source_ref,status,material_id,material_version,evidence,uncertainty)
      VALUES($1,$2,$3,'synthetic-issuer',$4,$5::jsonb,'100.00','decimal',$6,$7,$8,$9,1,$10::jsonb,$11::jsonb)`,
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
      return { pin, candidateId: candidate, factKey, factHash };
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

    const candidateOf = (
      id: string,
      metric: string,
      factKey: Record<string, unknown>,
    ): StoredFactCandidate => ({
      candidate: {
        candidateId: id,
        identity: factKey as unknown as FactIdentity,
        value: { kind: 'known', decimalOrText: '100' },
        source: { kind: 'audited', sourceId: 'synthetic', observedAt: '2026-01-01T00:00:00.000Z' },
        confidence: 0.9,
        uncertainty: null,
        auditCheck: null,
      },
      provenance: {
        status: 'extracted',
        evidence: [],
        uncertainty: [],
        materialId: `m-${metric}`,
        materialVersion: 1,
        sourceObservedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });

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
        [reviewer, 2],
        [manager, 3],
      ] as const) {
        await client.query('INSERT INTO bb_users(id,phone_e164,username) VALUES($1,$2,$3)', [
          id,
          `+1202555${phoneTail}${n}`,
          `frg${n}${suffix.slice(0, 10)}`,
        ]);
      }
      await client.query(
        "INSERT INTO bb_projects(id,owner_user_id,name,kind,draft_revision) VALUES($1,$2,'synthetic review gate','update',1)",
        [project, owner],
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

      const audited = await seed('audited-ok', 'audited', 'extracted', []);
      await insertReview(audited.pin, 'evidence_impact_reviewed', 'audited-ok', grantId);
      const external = await seed('external', 'external', 'needs_confirmation', [
        'EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED',
      ]);
      await insertReview(external.pin, 'external_evidence_impact_reviewed', 'external', grantId);
      const pending = await seed('incomplete', 'audited', 'extracted', [], 'incomplete');
      await insertReview(pending.pin, 'needs_more_evidence', 'incomplete', grantId);
      const withdrawn = await seed('withdrawn', 'audited', 'extracted', []);
      const withdrawnReviewId = await insertReview(
        withdrawn.pin,
        'evidence_impact_reviewed',
        'withdrawn',
        grantId,
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

      const facts = [
        candidateOf(audited.candidateId, 'audited-ok', audited.factKey),
        candidateOf(external.candidateId, 'external', external.factKey),
        candidateOf(pending.candidateId, 'incomplete', pending.factKey),
        candidateOf(withdrawn.candidateId, 'withdrawn', withdrawn.factKey),
        candidateOf(`c-missing-${suffix}`, 'missing', {
          accountId: owner,
          entityId: 'synthetic-issuer',
          scope: 'consolidated',
          metric: 'assets_missing',
          period: { end: '2025-12-31' },
          currency: 'CNY',
          unit: 'yuan',
          basis: 'balance_sheet',
          dataVersion: 'synthetic-v1',
        }),
      ];

      const outcome = await gateReviewedOfferableFacts({ pool }, scope, facts);
      assert.deepEqual(
        outcome.facts.map((f) => f.candidate.candidateId),
        [audited.candidateId],
        'only the exact audited review is offerable',
      );
      assert.deepEqual(
        [...outcome.excludedCandidateIds].sort(),
        [
          external.candidateId,
          pending.candidateId,
          withdrawn.candidateId,
          `c-missing-${suffix}`,
        ].sort(),
      );
      assert.equal(
        outcome.exclusionByCandidateId[external.candidateId],
        'external_impact_reviewed',
      );
      assert.equal(
        outcome.exclusionByCandidateId[pending.candidateId],
        'review_needs_more_evidence',
      );
      assert.equal(
        outcome.exclusionByCandidateId[withdrawn.candidateId],
        'no_current_exact_review',
      );
      assert.equal(
        outcome.exclusionByCandidateId[`c-missing-${suffix}`],
        'no_evidence_context_set',
      );

      // Read-only and idempotent: repeated reads return the same verdict and never append reviews.
      const before = Number(
        (
          await client.query(
            'SELECT count(*)::integer AS n FROM bb_fact_evidence_reviews WHERE owner_user_id=$1 AND project_id=$2',
            [owner, project],
          )
        ).rows[0]!.n,
      );
      assert.deepEqual(
        await gateReviewedOfferableFacts({ pool }, scope, facts),
        outcome,
        'gate reads are idempotent',
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
        before,
      );

      // Cross-account scope never matches and withholds the fact.
      const crossAccount = await gateReviewedOfferableFacts(
        { pool },
        { ...scope, ownerUserId: `other-${suffix}` },
        [
          candidateOf(audited.candidateId, 'audited-ok', {
            ...audited.factKey,
            accountId: `other-${suffix}`,
          }),
        ],
      );
      assert.deepEqual(crossAccount.facts, []);
      assert.equal(
        crossAccount.exclusionByCandidateId[audited.candidateId],
        'no_evidence_context_set',
      );
    } finally {
      client.release();
      await pool.end();
    }
  },
);
