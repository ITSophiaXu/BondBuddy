import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord,
} from '@bondbuddy/api/issuer-identity-source';
import { verifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import { listFactCandidates } from './fact-repository.js';
import { createFactEvidenceContextSet } from './fact-evidence-context-repository.js';
import { persistParseSnapshot } from './parse-evidence-repository.js';
import {
  produceParsedFactCandidates,
  SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
  type SemanticFactExtractionResult,
} from './fact-candidate-producer.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('FACT_CANDIDATE_PRODUCER_TEST_DATABASE_URL');
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

test(
  'semantic producer binds reviewed issuer and exact parse evidence, replays idempotently, and retains conflicts',
  {
    skip:
      !testDatabaseUrl &&
      'set FACT_CANDIDATE_PRODUCER_TEST_DATABASE_URL for migrated PostgreSQL 16',
  },
  async () => {
    // Match runtime's BB_WORKER_CONCURRENCY=4 => pool.max=8, so nested checkouts
    // cannot accidentally pass only because the default node-postgres pool is larger.
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `fact-ingest-owner-${suffix}`,
      reviewerId = `fact-ingest-reviewer-${suffix}`;
    const grantorId = `fact-ingest-grantor-${suffix}`,
      projectId = `fact-ingest-project-${suffix}`;
    const historical = `fact-ingest-history-${suffix}`,
      finance = `fact-ingest-finance-${suffix}`;
    const nonAuditFinance = `fact-ingest-non-audit-finance-${suffix}`;
    const historicalUpload = `fact-ingest-history-upload-${suffix}`,
      financeUpload = `fact-ingest-finance-upload-${suffix}`;
    const nonAuditFinanceUpload = `fact-ingest-non-audit-finance-upload-${suffix}`;
    const historicalV2Upload = `fact-ingest-history-v2-upload-${suffix}`;
    const historicalHash = sha(`synthetic historical issuer identity ${suffix}`);
    const historicalV2Hash = sha(`synthetic corrected issuer identity ${suffix}`);
    const financeHash = sha(`synthetic audited financial material ${suffix}`);
    const historicalSnapshotId = `fact-ingest-history-snapshot-${suffix}`;
    const historicalV2SnapshotId = `fact-ingest-history-v2-snapshot-${suffix}`;
    const financeSnapshotId = `fact-ingest-finance-snapshot-${suffix}`;
    const nonAuditFinanceSnapshotId = `fact-ingest-non-audit-finance-snapshot-${suffix}`;
    const historicalRecordId = `fact-ingest-history-evidence-${suffix}`;
    const historicalV2RecordId = `fact-ingest-history-v2-evidence-${suffix}`;
    const financeRecordId = `fact-ingest-finance-evidence-${suffix}`;
    const nonAuditFinanceRecordId = `fact-ingest-non-audit-finance-evidence-${suffix}`;
    const reviewerGrantId = `fact-ingest-grant-${suffix}`;
    const parserVersion = `synthetic-parser-${suffix}`;
    const inputHash = sha(`synthetic pinned input revision ${suffix}`);
    const inputHashV2 = sha(`synthetic corrected identity input revision ${suffix}`);
    const ownerScope = { ownerUserId: owner, projectId };
    const anchor = (
      recordId: string,
      materialId: string,
      hash: string,
      quote: string,
      version = 1,
    ) => ({
      record_id: recordId,
      material_id: materialId,
      material_version: version,
      content_hash: hash,
      locator_type: 'text_line',
      locator: { line: 1, stable_ref: 'text:l000001' },
      literal_quote: quote,
      context: 'synthetic fixture',
      extraction_method: 'native_text',
      extractor_version: parserVersion,
      confidence: 0.99,
      uncertainty: [],
      formatting: {},
    });
    const makeSnapshot = async (
      materialId: string,
      contentHash: string,
      snapshotId: string,
      recordId: string,
      quote: string,
      version = 1,
    ) => {
      const record = anchor(recordId, materialId, contentHash, quote, version);
      const requestId = `parse-${snapshotId}`;
      const response = {
        schema_version: 'document-parse-response-v1' as const,
        request_id: requestId,
        parser_version: parserVersion,
        status: 'parsed' as const,
        material: {
          material_id: materialId,
          material_version: version,
          media_type: 'text/plain' as const,
          sha256: contentHash,
        },
        records: [record],
        warnings: [],
        document: { page_count: null, encoding: 'utf-8' },
        error: null,
      };
      const saved = await persistParseSnapshot(
        { pool, newId: () => snapshotId },
        { ownerUserId: owner, projectId, materialId, materialVersion: version, requestId },
        { mediaType: 'text/plain', sha256: contentHash },
        response,
      );
      return { responseHash: saved.responseSha256, record };
    };
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4),($5,$6)', [
        owner,
        `factingestowner${suffix}`,
        reviewerId,
        `factingestreviewer${suffix}`,
        grantorId,
        `factingestgrantor${suffix}`,
      ]);
      await pool.query(
        `INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic fact ingestion','update')`,
        [projectId, owner],
      );
      for (const [uploadId, materialId, hash, role] of [
        [historicalUpload, historical, historicalHash, 'historical'],
        [financeUpload, finance, financeHash, 'audit'],
        [nonAuditFinanceUpload, nonAuditFinance, financeHash, 'financial'],
      ]) {
        await pool.query(
          `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
          VALUES($1,$2,$3,$4,'text/plain',32,$5,$6,$7,now()+interval '1 hour','completed',$5,32)`,
          [uploadId, owner, projectId, `${materialId}.txt`, hash, role, `synthetic/${uploadId}`],
        );
        await pool.query(
          `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,$5,$6,'text/plain',32,$7,$8,'parsed')`,
          [
            materialId,
            owner,
            projectId,
            uploadId,
            role,
            `${materialId}.txt`,
            hash,
            `synthetic/material/${materialId}`,
          ],
        );
      }
      await pool.query(
        `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'historical-v2.txt','text/plain',32,$4,'historical',$5,now()+interval '1 hour','completed',$4,32)`,
        [historicalV2Upload, owner, projectId, historicalV2Hash, `synthetic/${historicalV2Upload}`],
      );
      await pool.query(
        `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,2,$2,$3,$4,'historical','historical-v2.txt','text/plain',32,$5,$6,'parsed')`,
        [
          historical,
          owner,
          projectId,
          historicalV2Upload,
          historicalV2Hash,
          `synthetic/material/${historical}/v2`,
        ],
      );
      await makeSnapshot(
        historical,
        historicalHash,
        historicalSnapshotId,
        historicalRecordId,
        '合成发行人名称',
      );
      await makeSnapshot(
        historical,
        historicalV2Hash,
        historicalV2SnapshotId,
        historicalV2RecordId,
        '更正后的合成发行人名称',
        2,
      );
      const financeEvidence = await makeSnapshot(
        finance,
        financeHash,
        financeSnapshotId,
        financeRecordId,
        '营业收入 123.45 万元',
      );
      await makeSnapshot(
        nonAuditFinance,
        financeHash,
        nonAuditFinanceSnapshotId,
        nonAuditFinanceRecordId,
        '合成财务数据 123.45 万元',
      );
      const observation = await appendIssuerIdentitySourceRecord(
        { pool },
        {
          ownerUserId: owner,
          projectId,
          materialId: historical,
          materialVersion: 1,
          requestId: `identity-request-${suffix}`,
          sourceRecordId: historicalRecordId,
          issuerDisplayName: '合成发行人',
          entityId: `issuer-${suffix}`,
        },
      );
      await pool.query(
        `INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`,
        [reviewerGrantId, reviewerId, grantorId, owner, projectId],
      );
      const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerId);
      assert.ok(reviewer);
      await reviewIssuerIdentitySourceRecord(
        { pool },
        {
          ownerUserId: owner,
          projectId,
          materialId: historical,
          materialVersion: 1,
          sourceRecordRowId: observation.id,
          reviewer,
          decision: 'verified',
          verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
          entityBasisKind: 'manual_attestation',
          entityBasisRef: 'synthetic identity A',
          reasonCode: 'synthetic_verified',
        },
      );
      const identityRecord = await import('@bondbuddy/api/issuer-identity-source').then(
        ({ loadVerifiedIssuerIdentitySourceRecord }) =>
          loadVerifiedIssuerIdentitySourceRecord(pool, {
            ownerUserId: owner,
            projectId,
            materialId: historical,
            materialVersion: 1,
          }),
      );
      assert.ok(identityRecord);
      assert.equal(identityRecord.entityId, 'entity:11111111-1111-4111-8111-111111111111');
      assert.notEqual(
        identityRecord.entityId,
        observation.entityId,
        'fact identity must not reuse the observation candidate key',
      );
      const correctedObservation = await appendIssuerIdentitySourceRecord(
        { pool },
        {
          ownerUserId: owner,
          projectId,
          materialId: historical,
          materialVersion: 2,
          requestId: `identity-request-v2-${suffix}`,
          sourceRecordId: historicalV2RecordId,
          issuerDisplayName: '更正后的合成发行人',
          entityId: `issuer-corrected-${suffix}`,
        },
      );
      await reviewIssuerIdentitySourceRecord(
        { pool },
        {
          ownerUserId: owner,
          projectId,
          materialId: historical,
          materialVersion: 2,
          sourceRecordRowId: correctedObservation.id,
          reviewer,
          decision: 'verified',
          verifiedEntityId: 'entity:22222222-2222-4222-8222-222222222222',
          entityBasisKind: 'manual_attestation',
          entityBasisRef: 'synthetic identity B',
          reasonCode: 'synthetic_verified_correction',
        },
      );
      const correctedIdentityRecord = await import('@bondbuddy/api/issuer-identity-source').then(
        ({ loadVerifiedIssuerIdentitySourceRecord }) =>
          loadVerifiedIssuerIdentitySourceRecord(pool, {
            ownerUserId: owner,
            projectId,
            materialId: historical,
            materialVersion: 2,
          }),
      );
      assert.ok(correctedIdentityRecord);
      assert.notEqual(correctedIdentityRecord.entityId, identityRecord.entityId);
      const manifest = {
        issuer_identity: verifiedIssuerIdentityBinding(identityRecord),
        issuer_entity_id: identityRecord.entityId,
        materials: [
          {
            material_id: historical,
            material_version: 1,
            role: 'historical',
            sha256: historicalHash,
          },
          { material_id: finance, material_version: 1, role: 'audit', sha256: financeHash },
          {
            material_id: nonAuditFinance,
            material_version: 1,
            role: 'financial',
            sha256: financeHash,
          },
        ],
      };
      await pool.query(
        `INSERT INTO bb_input_revisions
        (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,
        [
          projectId,
          owner,
          inputHash,
          JSON.stringify(manifest),
          JSON.stringify([
            { material_id: historical, material_version: 1 },
            { material_id: finance, material_version: 1 },
            { material_id: nonAuditFinance, material_version: 1 },
          ]),
        ],
      );
      const correctedManifest = {
        issuer_identity: verifiedIssuerIdentityBinding(correctedIdentityRecord),
        issuer_entity_id: correctedIdentityRecord.entityId,
        materials: [
          {
            material_id: historical,
            material_version: 2,
            role: 'historical',
            sha256: historicalV2Hash,
          },
          { material_id: finance, material_version: 1, role: 'audit', sha256: financeHash },
          {
            material_id: nonAuditFinance,
            material_version: 1,
            role: 'financial',
            sha256: financeHash,
          },
        ],
      };
      await pool.query(
        `INSERT INTO bb_input_revisions
        (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,2,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,
        [
          projectId,
          owner,
          inputHashV2,
          JSON.stringify(correctedManifest),
          JSON.stringify([
            { material_id: historical, material_version: 2 },
            { material_id: finance, material_version: 1 },
            { material_id: nonAuditFinance, material_version: 1 },
          ]),
        ],
      );

      let extractionCalls = 0;
      let changedValue = '123.45';
      const extractor = {
        id: 'synthetic-financial-fields',
        version: '1.0.0',
        extract: async (
          request: Parameters<
            Parameters<typeof produceParsedFactCandidates>[0]['extractor']['extract']
          >[0],
        ) => {
          extractionCalls++;
          assert.ok(
            [identityRecord.entityId, correctedIdentityRecord.entityId].includes(request.entity_id),
          );
          assert.ok([1, 2].includes(request.input_revision));
          assert.equal(request.material_id, finance);
          const result: SemanticFactExtractionResult = {
            schema_version: SEMANTIC_FACT_EXTRACTION_RESULT_VERSION,
            extractor: { id: 'synthetic-financial-fields', version: '1.0.0' },
            parse_snapshot: {
              snapshot_id: financeSnapshotId,
              response_sha256: financeEvidence.responseHash,
              parser_version: parserVersion,
              material_id: finance,
              material_version: 1,
              content_sha256: financeHash,
            },
            facts: [
              {
                extraction_id: 'revenue-annual-2024-a',
                identity: {
                  scope: 'consolidated',
                  metric: 'operating_revenue',
                  period: { start: '2024-01-01', end: '2024-12-31' },
                  currency: 'CNY',
                  unit: 'ten_thousand',
                  basis: 'audited',
                },
                value: { kind: 'known', decimalOrText: changedValue },
                source_kind: 'audited',
                confidence: 0.99,
                uncertainty: [],
                evidence_refs: [financeRecordId],
              },
              {
                extraction_id: 'revenue-annual-2024-b',
                identity: {
                  scope: 'consolidated',
                  metric: 'operating_revenue',
                  period: { start: '2024-01-01', end: '2024-12-31' },
                  currency: 'CNY',
                  unit: 'ten_thousand',
                  basis: 'audited',
                },
                value: { kind: 'known', decimalOrText: '124.00' },
                source_kind: 'audited',
                confidence: 0.99,
                uncertainty: ['SYNTHETIC_CONFLICTING_VALUE'],
                evidence_refs: [financeRecordId],
              },
            ],
            needs_review: [
              { evidence_refs: [financeRecordId], reason_code: 'UNSUPPORTED_ADJACENT_LABEL' },
            ],
          };
          return result;
        },
      };
      const context = {
        ...ownerScope,
        inputRevision: 1,
        inputHash,
        materialId: finance,
        materialVersion: 1,
        snapshotId: financeSnapshotId,
      };
      const first = await produceParsedFactCandidates({ pool, extractor }, context);
      assert.equal(first.inserted.length, 2);
      assert.equal(first.replayed.length, 0);
      assert.equal(first.inserted[0]!.provenance.status, 'extracted');
      assert.equal(first.inserted[0]!.candidate.auditCheck, null);
      assert.equal(first.inserted[0]!.candidate.identity.entityId, identityRecord.entityId);
      assert.equal(
        first.inserted[0]!.provenance.evidence[0]!.literal_quote,
        '营业收入 123.45 万元',
      );
      assert.equal(
        first.inserted[0]!.candidate.identity.metric,
        first.inserted[1]!.candidate.identity.metric,
      );
      assert.notDeepEqual(first.inserted[0]!.candidate.value, first.inserted[1]!.candidate.value);
      assert.equal(first.needsReview[0]!.reason_code, 'UNSUPPORTED_ADJACENT_LABEL');

      const evidenceContext = await createFactEvidenceContextSet(
        { pool },
        {
          ownerUserId: owner,
          projectId,
          candidateId: first.inserted[0]!.candidate.candidateId,
        },
      );
      assert.equal(
        evidenceContext.replayed,
        true,
        'producer creates the immutable context set with its extraction ledger',
      );
      assert.equal(evidenceContext.completenessStatus, 'complete');
      assert.equal(
        evidenceContext.reviewable,
        true,
        'complete evidence inventory is not a fact approval',
      );
      assert.equal(evidenceContext.manifest.material_version, 1);
      assert.equal(evidenceContext.manifest.material_sha256, financeHash);
      assert.equal(evidenceContext.manifest.snapshot_id, financeSnapshotId);
      assert.equal(evidenceContext.manifest.parser_version, parserVersion);
      assert.equal(evidenceContext.manifest.parse_response_sha256, financeEvidence.responseHash);
      assert.deepEqual(
        evidenceContext.manifest.selected_body.map((item) => item.record_id),
        [financeRecordId],
      );
      const candidatesAfterContextCreation = await listFactCandidates({ pool }, ownerScope);
      const unchangedCandidate = candidatesAfterContextCreation.find(
        (item) => item.candidate.candidateId === first.inserted[0]!.candidate.candidateId,
      )!;
      assert.equal(unchangedCandidate.provenance.status, 'extracted');
      assert.equal(
        unchangedCandidate.candidate.confidence,
        first.inserted[0]!.candidate.confidence,
      );
      assert.deepEqual(
        unchangedCandidate.provenance.uncertainty,
        first.inserted[0]!.provenance.uncertainty,
      );
      const evidenceContextReplay = await createFactEvidenceContextSet(
        { pool },
        {
          ownerUserId: owner,
          projectId,
          candidateId: first.inserted[0]!.candidate.candidateId,
        },
      );
      assert.equal(evidenceContextReplay.id, evidenceContext.id);
      assert.equal(evidenceContextReplay.evidenceSetSha256, evidenceContext.evidenceSetSha256);
      assert.equal(evidenceContextReplay.replayed, true);
      await assert.rejects(
        createFactEvidenceContextSet(
          { pool },
          {
            ownerUserId: reviewerId,
            projectId,
            candidateId: first.inserted[0]!.candidate.candidateId,
          },
        ),
        /FACT_EVIDENCE_CONTEXT_SOURCE_NOT_FOUND/,
      );

      const replay = await produceParsedFactCandidates({ pool, extractor }, context);
      assert.equal(replay.inserted.length, 0);
      assert.equal(replay.replayed.length, 2);
      assert.equal(extractionCalls, 1);

      changedValue = '124.00';
      const replayAfterAdapterDrift = await produceParsedFactCandidates(
        { pool, extractor },
        context,
      );
      assert.equal(replayAfterAdapterDrift.replayed[0]!.candidate.value.kind, 'known');
      changedValue = '124.00';
      const concurrentExtractor = {
        id: 'synthetic-financial-fields',
        version: '1.0.4',
        extract: async (request: Parameters<typeof extractor.extract>[0]) => {
          const result = (await extractor.extract(request)) as SemanticFactExtractionResult;
          return {
            ...result,
            extractor: { id: 'synthetic-financial-fields', version: '1.0.4' },
            facts: result.facts.map((fact) => ({
              ...fact,
              extraction_id: `${fact.extraction_id}-concurrent`,
            })),
          };
        },
      };
      const simultaneous = await Promise.all([
        produceParsedFactCandidates({ pool, extractor: concurrentExtractor }, context),
        produceParsedFactCandidates({ pool, extractor: concurrentExtractor }, context),
      ]);
      assert.equal(
        simultaneous.reduce((sum, item) => sum + item.inserted.length, 0),
        2,
      );
      assert.equal(
        simultaneous.reduce((sum, item) => sum + item.replayed.length, 0),
        2,
      );
      const changedResult = {
        id: 'synthetic-financial-fields',
        version: '1.0.1',
        extract: async (request: Parameters<typeof extractor.extract>[0]) => {
          const result = (await extractor.extract(request)) as SemanticFactExtractionResult;
          return {
            ...result,
            extractor: { id: 'synthetic-financial-fields', version: '1.0.1' },
            facts: result.facts.map((fact) => ({
              ...fact,
              extraction_id: `${fact.extraction_id}-alternate`,
            })),
          };
        },
      };
      const conflict = await produceParsedFactCandidates(
        { pool, extractor: changedResult },
        context,
      );
      assert.equal(conflict.inserted.length, 2);
      assert.equal((await listFactCandidates({ pool }, ownerScope)).length, 6);
      const correctedContext = { ...context, inputRevision: 2, inputHash: inputHashV2 };
      const correctedIdentityCandidates = await produceParsedFactCandidates(
        { pool, extractor },
        correctedContext,
      );
      assert.equal(correctedIdentityCandidates.inserted.length, 2);
      assert.ok(
        correctedIdentityCandidates.inserted.every(
          (item) => item.candidate.identity.entityId === correctedIdentityRecord.entityId,
        ),
      );
      assert.ok(
        correctedIdentityCandidates.inserted.every(
          (item) =>
            !first.inserted.some(
              (original) => original.candidate.candidateId === item.candidate.candidateId,
            ),
        ),
      );
      const correctedIdentityReplay = await produceParsedFactCandidates(
        { pool, extractor },
        correctedContext,
      );
      assert.equal(correctedIdentityReplay.inserted.length, 0);
      assert.deepEqual(
        correctedIdentityReplay.replayed.map((item) => item.candidate.candidateId),
        correctedIdentityCandidates.inserted.map((item) => item.candidate.candidateId),
      );
      const preservedOriginalCandidates = await listFactCandidates({ pool }, ownerScope);
      assert.equal(preservedOriginalCandidates.length, 8);
      const oldCandidateIds = new Set(first.inserted.map((item) => item.candidate.candidateId));
      const revisedCandidateIds = new Set(
        correctedIdentityCandidates.inserted.map((item) => item.candidate.candidateId),
      );
      assert.ok(
        preservedOriginalCandidates
          .filter((item) => oldCandidateIds.has(item.candidate.candidateId))
          .every((item) => item.candidate.identity.entityId === identityRecord.entityId),
      );
      assert.ok(
        preservedOriginalCandidates
          .filter((item) => revisedCandidateIds.has(item.candidate.candidateId))
          .every((item) => item.candidate.identity.entityId === correctedIdentityRecord.entityId),
      );

      // Model four concurrent producers retaining their checked-out connection after
      // ledger commit, while four context operations run against the remaining slots.
      // The context parser read must reuse each context transaction connection. One
      // request deliberately fails after acquiring its connection; all other contexts
      // still complete, and the pool remains usable for a subsequent read.
      const producerConnections = await Promise.all(
        Array.from({ length: 4 }, () => pool.connect()),
      );
      const candidateIds = preservedOriginalCandidates
        .slice(0, 3)
        .map((item) => item.candidate.candidateId);
      const concurrentContexts = Promise.allSettled([
        ...candidateIds.map((candidateId) =>
          createFactEvidenceContextSet({ pool }, { ownerUserId: owner, projectId, candidateId }),
        ),
        createFactEvidenceContextSet(
          { pool },
          { ownerUserId: owner, projectId, candidateId: `missing-${suffix}` },
        ),
      ]);
      let finishedBeforeProducerRelease = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const boundedResult = await Promise.race([
        concurrentContexts.then((results) => ({ completed: true as const, results })),
        new Promise<{ completed: false }>((resolve) => {
          timeout = setTimeout(() => resolve({ completed: false }), 1500);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!boundedResult.completed) {
        producerConnections.forEach((connection) => connection.release());
        await concurrentContexts;
      } else {
        finishedBeforeProducerRelease = true;
        producerConnections.forEach((connection) => connection.release());
      }
      assert.equal(
        finishedBeforeProducerRelease,
        true,
        'context reads must finish with the bounded pool while producer connections remain checked out',
      );
      assert.equal(boundedResult.completed, true);
      if (!boundedResult.completed) throw new Error('bounded context concurrency did not complete');
      assert.deepEqual(
        boundedResult.results.map((result) => result.status),
        ['fulfilled', 'fulfilled', 'fulfilled', 'rejected'],
      );
      const failedContext = boundedResult.results[3];
      assert.equal(failedContext?.status, 'rejected');
      if (failedContext?.status === 'rejected')
        assert.match(String(failedContext.reason), /FACT_EVIDENCE_CONTEXT_SOURCE_NOT_FOUND/);
      assert.equal(
        (await pool.query('SELECT 1 AS recovered')).rows[0]?.recovered,
        1,
        'a failed context request must release its connection for recovery',
      );

      const extractionRun = await pool.query(
        `SELECT needs_review FROM bb_fact_extraction_runs
        WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=1 AND material_id=$3 AND snapshot_id=$4
          AND extractor_id='synthetic-financial-fields' AND extractor_version='1.0.0'`,
        [owner, projectId, finance, financeSnapshotId],
      );
      assert.equal(extractionRun.rowCount, 1);
      assert.deepEqual(extractionRun.rows[0]!.needs_review, [
        { evidence_refs: [financeRecordId], reason_code: 'UNSUPPORTED_ADJACENT_LABEL' },
      ]);
      const outbox = await pool.query(
        `SELECT event_type,payload FROM bb_outbox
        WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='fact.extraction.completed'`,
        [owner, projectId],
      );
      assert.equal(outbox.rowCount, 4);
      await assert.rejects(
        pool.query(`UPDATE bb_fact_evidence_context_sets SET reviewable=false WHERE id=$1`, [
          evidenceContext.id,
        ]),
        /fact evidence context sets are immutable/,
      );
      await assert.rejects(
        pool.query(
          `UPDATE bb_fact_extraction_runs SET result_sha256=$1 WHERE owner_user_id=$2 AND project_id=$3`,
          [sha('rewrite'), owner, projectId],
        ),
        /fact extraction runs are immutable/,
      );

      await assert.rejects(
        produceParsedFactCandidates(
          { pool, extractor },
          { ...context, inputHash: sha('wrong revision') },
        ),
        /FACT_EXTRACTION_INPUT_REVISION_MISMATCH/,
      );
      await assert.rejects(
        produceParsedFactCandidates(
          { pool, extractor },
          {
            ...context,
            materialId: historical,
            materialVersion: 1,
            snapshotId: historicalSnapshotId,
          },
        ),
        /FACT_EXTRACTION_MATERIAL_NOT_FINANCIAL/,
      );
      const externalFromAuditMaterial = {
        id: 'synthetic-financial-fields',
        version: '1.0.2',
        extract: async (request: Parameters<typeof extractor.extract>[0]) => {
          const result = (await extractor.extract(request)) as SemanticFactExtractionResult;
          return {
            ...result,
            extractor: { id: 'synthetic-financial-fields', version: '1.0.2' },
            facts: result.facts.map((fact) => ({
              ...fact,
              extraction_id: `${fact.extraction_id}-external`,
              source_kind: 'external' as const,
              uncertainty: ['SYNTHETIC_SOURCE_NOT_VERIFIED'],
              confidence: 0.5,
            })),
          };
        },
      };
      const external = await produceParsedFactCandidates(
        { pool, extractor: externalFromAuditMaterial },
        context,
      );
      assert.equal(external.inserted.length, 2);
      assert.deepEqual(external.needsReview, [
        { evidence_refs: [financeRecordId], reason_code: 'UNSUPPORTED_ADJACENT_LABEL' },
      ]);
      for (const item of external.inserted) {
        assert.equal(item.candidate.source.kind, 'external');
        assert.equal(item.provenance.status, 'needs_confirmation');
        assert.equal(item.candidate.auditCheck, null);
        assert.equal(item.candidate.confidence, 0.5);
        assert.deepEqual(item.provenance.uncertainty, ['SYNTHETIC_SOURCE_NOT_VERIFIED']);
        assert.deepEqual(
          item.provenance.evidence.map((evidence) => evidence.evidence_id),
          [financeRecordId],
        );
      }
      const externalLedger = await pool.query(
        `SELECT candidate_ids,needs_review FROM bb_fact_extraction_runs WHERE id=$1`,
        [external.extractionRunId],
      );
      assert.equal(externalLedger.rowCount, 1);
      assert.deepEqual(
        externalLedger.rows[0]!.candidate_ids,
        external.inserted.map((item) => item.candidate.candidateId),
      );
      assert.deepEqual(externalLedger.rows[0]!.needs_review, external.needsReview);
      const externalReplay = await produceParsedFactCandidates(
        { pool, extractor: externalFromAuditMaterial },
        context,
      );
      assert.equal(externalReplay.inserted.length, 0);
      assert.deepEqual(
        externalReplay.replayed.map((item) => item.candidate.candidateId),
        externalLedger.rows[0]!.candidate_ids,
      );
      assert.deepEqual(externalReplay.needsReview, external.needsReview);

      const auditedFromNonAuditMaterial = {
        id: 'synthetic-financial-fields',
        version: '1.0.6',
        extract: async (request: Parameters<typeof extractor.extract>[0]) => {
          const result = (await extractor.extract({
            ...request,
            material_id: finance,
            parse_snapshot_id: financeSnapshotId,
            parse_response_sha256: financeEvidence.responseHash,
          })) as SemanticFactExtractionResult;
          return {
            ...result,
            extractor: { id: 'synthetic-financial-fields', version: '1.0.6' },
            parse_snapshot: {
              ...result.parse_snapshot,
              snapshot_id: nonAuditFinanceSnapshotId,
              response_sha256: request.parse_response_sha256,
              material_id: nonAuditFinance,
            },
            facts: result.facts.map((fact) => ({
              ...fact,
              evidence_refs: [nonAuditFinanceRecordId],
            })),
            needs_review: [],
          };
        },
      };
      const nonAuditContext = {
        ...context,
        materialId: nonAuditFinance,
        snapshotId: nonAuditFinanceSnapshotId,
      };
      await assert.rejects(
        produceParsedFactCandidates(
          { pool, extractor: auditedFromNonAuditMaterial },
          nonAuditContext,
        ),
        /FACT_EXTRACTION_SOURCE_ROLE_MISMATCH/,
      );
      await pool.query(`CREATE FUNCTION bb_test_fail_fact_extraction_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type='fact.extraction.completed' THEN RAISE EXCEPTION 'forced fact outbox failure'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER bb_test_fail_fact_extraction_outbox BEFORE INSERT ON bb_outbox
        FOR EACH ROW EXECUTE FUNCTION bb_test_fail_fact_extraction_outbox()`);
      const forcedOutboxFailure = {
        id: 'synthetic-financial-fields',
        version: '1.0.5',
        extract: async (request: Parameters<typeof extractor.extract>[0]) => {
          const result = (await extractor.extract(request)) as SemanticFactExtractionResult;
          return {
            ...result,
            extractor: { id: 'synthetic-financial-fields', version: '1.0.5' },
            facts: result.facts.map((fact) => ({
              ...fact,
              extraction_id: `${fact.extraction_id}-outbox-failure`,
            })),
          };
        },
      };
      await assert.rejects(
        produceParsedFactCandidates({ pool, extractor: forcedOutboxFailure }, context),
        /forced fact outbox failure/,
      );
      await pool.query(`DROP TRIGGER bb_test_fail_fact_extraction_outbox ON bb_outbox`);
      await pool.query(`DROP FUNCTION bb_test_fail_fact_extraction_outbox()`);
      assert.equal((await listFactCandidates({ pool }, ownerScope)).length, 10);
      assert.equal(
        (
          await pool.query(
            `SELECT id FROM bb_fact_extraction_runs WHERE owner_user_id=$1 AND project_id=$2`,
            [owner, projectId],
          )
        ).rowCount,
        5,
      );
      await pool.query(
        `UPDATE bb_issuer_identity_reviewer_grants SET revoked_at=now(),revoked_by=$2,revocation_reason_code='synthetic_test',revocation_basis='synthetic test' WHERE id=$1`,
        [reviewerGrantId, grantorId],
      );
      await assert.rejects(
        produceParsedFactCandidates(
          { pool, extractor: { ...extractor, version: '1.0.3' } },
          context,
        ),
        /FACT_EXTRACTION_ISSUER_IDENTITY_STALE/,
      );
    } finally {
      await pool.end();
    }
  },
);
