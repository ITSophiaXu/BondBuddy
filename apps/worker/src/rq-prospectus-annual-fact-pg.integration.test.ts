import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import { projectRunExecution } from '@bondbuddy/api/run-execution';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  loadVerifiedIssuerIdentitySourceRecord,
  reviewIssuerIdentitySourceRecord,
} from '@bondbuddy/api/issuer-identity-source';
import { verifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import { enqueueMaterialParse, documentParserVersion } from '@bondbuddy/api/material-jobs';
import type { DocumentParseRequest } from './document-parser.js';
import { runDocumentParser } from './document-parser.js';
import { createControlledNativeFactCandidateProducer } from './controlled-native-fact-candidate-producer.js';
import { listFactCandidates } from './fact-repository.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { createMaterialsReadyStage } from './run-pipeline.js';
import { RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID, RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION,
  RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256 } from './rq-prospectus-annual-fact-constants.js';
import { isolatedTestDatabase } from './test-database.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sampleRoot = join(repositoryRoot, 'tests/samples/2026-09-25');
const manifestPath = join(sampleRoot, 'manifest.json');
const authorizedOptIn = process.env.BB_RUN_AUTHORIZED_RQ_ANNUAL_FACT_PG_TESTS === '1';
const testDatabaseUrl = authorizedOptIn ? await isolatedTestDatabase('RQ_ANNUAL_FACT_PG_TEST_DATABASE_URL') : undefined;
const localPython = join(repositoryRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const parserPython = process.env.BB_PYTHON?.trim() || (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EXPECTED_FACTS = 16;

type AuthorizedManifest = { cases: Array<{ case_id: string; files: Array<{
  file_id: string; path: string; original_filename: string; upload_role: string; media_type: string; bytes: number; sha256: string;
}> }> };

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const identifier = (value: string) => value.replaceAll('-', '');
function phone(seed: string): string {
  const digits = seed.replace(/\D/g, '').padEnd(10, '0').slice(0, 10);
  return `+1${digits}`;
}

test('authorized rq-202509 DOCX persists 16 fail-closed annual candidates through PostgreSQL material readiness and controlled producer', {
  skip: !authorizedOptIn ? 'set BB_RUN_AUTHORIZED_RQ_ANNUAL_FACT_PG_TESTS=1 to run the authorized PostgreSQL 16 integration'
    : !testDatabaseUrl ? 'set RQ_ANNUAL_FACT_PG_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template' : false,
}, async () => {
  assert.ok(testDatabaseUrl);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
  const sampleCase = manifest.cases.find((item) => item.case_id === 'rq-202509');
  assert.ok(sampleCase, 'rq-202509 must remain registered in the authorized sample index');
  const file = sampleCase.files.find((item) => item.file_id === 'rq-202509-01');
  assert.ok(file, 'rq-202509-01 must remain registered in the authorized sample index');
  const authorizedFile = file;
  assert.equal(authorizedFile.upload_role, 'historical');
  assert.equal(authorizedFile.media_type, DOCX);
  assert.equal(authorizedFile.sha256, RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256);

  const filePath = resolve(sampleRoot, authorizedFile.path);
  const bytesBefore = await readFile(filePath);
  assert.equal(bytesBefore.byteLength, authorizedFile.bytes, 'sample byte count must match the authorized index');
  assert.equal(sha256(bytesBefore), authorizedFile.sha256, 'sample SHA-256 must match the authorized index before parsing');

  const suffix = randomUUID();
  const shortSuffix = identifier(suffix).slice(0, 10);
  const owner = randomUUID();
  const foreignOwner = randomUUID();
  const reviewerId = randomUUID();
  const grantorId = randomUUID();
  const projectId = randomUUID();
  const generatedMaterialId = randomUUID();
  assert.notEqual(generatedMaterialId, file.file_id, 'the DB material ID must not be assumed equal to the manifest file ID');
  const uploadId = randomUUID();
  const reviewerGrantId = randomUUID();
  const jobId = randomUUID();
  const inputHash = sha256(`authorized rq annual facts integration input ${suffix}`);
  const requestId = `rq-annual-parse-${identifier(suffix)}`;
  const objectKey = `authorized-test/${projectId}/${generatedMaterialId}/v1`;
  const pool = new Pool({ connectionString: testDatabaseUrl });

  try {
    await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2),($3,$4),($5,$6),($7,$8)', [
      owner, phone(`1${shortSuffix}`), foreignOwner, phone(`2${shortSuffix}`),
      reviewerId, phone(`3${shortSuffix}`), grantorId, phone(`4${shortSuffix}`),
    ]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Authorized RQ annual fact integration','update')",
      [projectId, owner]);
    await pool.query(`INSERT INTO bb_uploads
      (id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,'historical',$8,now()+interval '1 day','completed',$7,$6)`,
    [uploadId, owner, projectId, basename(authorizedFile.path), authorizedFile.media_type, authorizedFile.bytes, authorizedFile.sha256, `${objectKey}/upload`]);
    await pool.query(`INSERT INTO bb_material_versions
      (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical',$5,$6,$7,$8,$9,'persisted')`,
    [generatedMaterialId, owner, projectId, uploadId, basename(authorizedFile.path), authorizedFile.media_type, authorizedFile.bytes, authorizedFile.sha256, objectKey]);

    const parseJobClient = await pool.connect();
    let job: Awaited<ReturnType<typeof enqueueMaterialParse>>;
    try {
      job = await enqueueMaterialParse(parseJobClient, { owner, projectId, materialId: generatedMaterialId, materialVersion: 1,
        sha256: authorizedFile.sha256, traceId: `rq-annual-${identifier(suffix)}`, parserVersion: documentParserVersion() });
    } finally { parseJobClient.release(); }
    assert.equal(job.created, true);
    assert.equal(job.jobId.length > 0, true);
    const parser = (request: DocumentParseRequest) => runDocumentParser(request, { pythonExecutable: parserPython, repoRoot: repositoryRoot });
    const parseOutcome = await runMaterialParseOnce({ pool, leaseSeconds: 300, material: {
      pool, blobs: { getPrivate: async (key: string) => key === objectKey ? bytesBefore : null }, parser,
    } });
    assert.equal(parseOutcome, 'succeeded', 'the authorized DOCX should be parsed and snapshotted through the durable material job');
    const completedJob = (await pool.query('SELECT state,parser_version,checkpoint FROM bb_jobs WHERE id=$1 AND owner_user_id=$2', [job.jobId, owner])).rows[0];
    assert.equal(completedJob?.state, 'succeeded');
    assert.equal(completedJob?.parser_version, 'bondbuddy-document-parser-1.0.8');
    const snapshotId = completedJob?.checkpoint?.stages?.parse_evidence?.snapshot_id;
    assert.equal(typeof snapshotId, 'string');
    const evidenceCount = Number((await pool.query('SELECT count(*)::int AS count FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1 AND snapshot_id=$4',
      [owner, projectId, generatedMaterialId, snapshotId])).rows[0]?.count);
    assert.ok(evidenceCount > EXPECTED_FACTS, 'full authorized parser evidence must be durable; mapper consumes actual source anchors');

    const identityEvidence = (await pool.query(`SELECT record_id,literal_quote,uncertainty FROM bb_parse_evidence
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1 AND snapshot_id=$4
        AND literal_quote LIKE '%任丘市建设投资集团有限公司%' ORDER BY ordinal LIMIT 1`,
    [owner, projectId, generatedMaterialId, snapshotId])).rows[0];
    assert.ok(identityEvidence, 'real parser evidence must identify the issuer for the review fixture');
    assert.deepEqual(identityEvidence.uncertainty, [], 'reviewed issuer identity may use only an unambiguous source record');

    await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants
      (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'authorized_test','authorized sample integration fixture',$4,$5)`,
    [reviewerGrantId, reviewerId, grantorId, owner, projectId]);
    const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerId, { ownerUserId: owner, projectId });
    assert.ok(reviewer);
    const observation = await appendIssuerIdentitySourceRecord({ pool }, {
      ownerUserId: owner, projectId, materialId: generatedMaterialId, materialVersion: 1,
      requestId: `rq-identity-${identifier(suffix)}`, sourceRecordId: String(identityEvidence.record_id),
      issuerDisplayName: '任丘市建设投资集团有限公司', entityId: `rq-observed-${identifier(suffix)}`,
    });
    await reviewIssuerIdentitySourceRecord({ pool }, {
      ownerUserId: owner, projectId, materialId: generatedMaterialId, materialVersion: 1,
      sourceRecordRowId: observation.id, reviewer, decision: 'verified',
      verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
      entityBasisKind: 'manual_attestation', entityBasisRef: 'authorized integration fixture', reasonCode: 'authorized_test_fixture',
    });
    const verifiedIdentity = await loadVerifiedIssuerIdentitySourceRecord(pool, {
      ownerUserId: owner, projectId, materialId: generatedMaterialId, materialVersion: 1,
    });
    assert.ok(verifiedIdentity);
    const manifestMaterials = [{ material_id: generatedMaterialId, material_version: 1, role: 'historical', sha256: authorizedFile.sha256 }];
    await pool.query(`INSERT INTO bb_input_revisions
      (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`, [
      projectId, owner, inputHash,
      JSON.stringify({ issuer_identity: verifiedIssuerIdentityBinding(verifiedIdentity), issuer_entity_id: verifiedIdentity.entityId,
        materials: manifestMaterials }),
      JSON.stringify([{ material_id: generatedMaterialId, material_version: 1 }]),
    ]);

    const run = { id: randomUUID(), owner_user_id: owner, project_id: projectId, input_revision: 1, input_hash: inputHash,
      task_kind: 'update' } as const;
    const producer = createControlledNativeFactCandidateProducer({ pool });
    const stage = createMaterialsReadyStage(producer);
    const stageContext = (checkpoint: Record<string, Record<string, unknown>>) => ({
      pool, blobs: {} as never, lease: {} as never, signal: new AbortController().signal,
      run: projectRunExecution(run, { executionVersion: 1, inputRevision: run.input_revision, inputHash: run.input_hash }), checkpoint, values: new Map(),
    });
    const first = await stage.run(stageContext({}));
    assert.equal(first.kind, 'done');
    if (first.kind !== 'done' || !first.checkpoint) throw new Error('authorized material readiness stage did not persist extraction');
    assert.equal((first.checkpoint.extractions as Array<{ candidate_count: number }>)[0]?.candidate_count, EXPECTED_FACTS);

    const candidates = await listFactCandidates({ pool }, { ownerUserId: owner, projectId });
    const annual = candidates.filter((item) => item.candidate.source.sourceId === generatedMaterialId);
    assert.equal(annual.length, EXPECTED_FACTS);
    assert.ok(annual.every((item) => item.candidate.source.kind === 'external'));
    assert.ok(annual.every((item) => item.candidate.identity.entityId === verifiedIdentity.entityId));
    assert.ok(annual.every((item) => item.provenance.evidence.length >= 6 && item.provenance.evidence.every((anchor) => anchor.material_id === generatedMaterialId && anchor.material_version === 1)));
    const dbCandidates = await pool.query(`SELECT status,source_kind,source_ref,evidence,uncertainty,fact_key,verification_actor_id FROM bb_fact_candidates
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1`, [owner, projectId, generatedMaterialId]);
    assert.equal(dbCandidates.rowCount, EXPECTED_FACTS);
    const parseState = (await pool.query('SELECT response_status,response_meta->\'warnings\' AS warnings FROM bb_parse_snapshots WHERE id=$1', [snapshotId])).rows[0];
    assert.equal(parseState?.response_status, 'needs_confirmation');
    assert.deepEqual((parseState?.warnings as Array<{ code: string }> | undefined)?.map(warning => warning.code),
      ['DOCX_DRAWINGS', 'DOCX_AUXILIARY_PARTS']);
    assert.ok(dbCandidates.rows.every((row) => row.status === 'needs_confirmation' && row.source_kind === 'external' &&
      row.source_ref === generatedMaterialId && row.verification_actor_id === null));
    assert.ok(dbCandidates.rows.every((row) => JSON.stringify(row.uncertainty) ===
      JSON.stringify(['PARSE_SNAPSHOT_NEEDS_CONFIRMATION; SOURCE_CONFIDENCE_MISSING'])));
    for (const candidate of dbCandidates.rows) {
      const anchors = candidate.evidence as Array<{ evidence_id?: string; material_id?: string; material_version?: number;
        locator?: { path?: Array<{ table?: number; row?: number; column?: number }> } }>;
      assert.ok(anchors.length >= 6);
      assert.ok(anchors.every((anchor) => typeof anchor.evidence_id === 'string' && anchor.material_id === generatedMaterialId && anchor.material_version === 1));
      const key = candidate.fact_key as { metric?: string; scope?: string };
      const target = key.metric === 'total_assets'
        ? { table: key.scope === 'consolidated' ? 44 : 47, row: key.scope === 'consolidated' ? 26 : 24 }
        : key.metric === 'operating_revenue'
          ? { table: key.scope === 'consolidated' ? 45 : 48, row: key.scope === 'consolidated' ? 3 : 2 }
          : key.metric === 'net_profit'
            ? { table: key.scope === 'consolidated' ? 45 : 48, row: key.scope === 'consolidated' ? 25 : 24 }
            : key.metric === 'net_cash_from_operating_activities'
              ? { table: key.scope === 'consolidated' ? 46 : 49, row: 12 }
              : null;
      assert.ok(target, 'persisted identity must name one of the allowlisted annual metrics');
      assert.ok(anchors.some((anchor) => anchor.locator?.path?.some((part) => part.table === target.table && part.row === target.row &&
        (part.column === 3 || part.column === 4))), 'each candidate must retain its exact original annual statement value-cell anchor');
    }
    const ledger = await pool.query(`SELECT input_hash,parse_response_sha256,extractor_id,extractor_version,candidate_ids,needs_review
      FROM bb_fact_extraction_runs WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=1 AND material_id=$3`,
    [owner, projectId, generatedMaterialId]);
    assert.equal(ledger.rowCount, 1);
    assert.equal(ledger.rows[0]!.extractor_id, RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID);
    assert.equal(ledger.rows[0]!.extractor_version, RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION);
    assert.equal((ledger.rows[0]!.candidate_ids as unknown[]).length, EXPECTED_FACTS);
    assert.deepEqual(ledger.rows[0]!.needs_review, []);
    const extractionOutbox = await pool.query(`SELECT payload FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2
      AND event_type='fact.extraction.completed'`, [owner, projectId]);
    assert.equal(extractionOutbox.rowCount, 1, 'the extraction ledger and one completion outbox event commit atomically');
    assert.equal((extractionOutbox.rows[0]!.payload as { candidate_ids: unknown[] }).candidate_ids.length, EXPECTED_FACTS);

    const replay = await stage.run(stageContext({ materials_ready: first.checkpoint }));
    assert.deepEqual(replay, first, 'replaying the persisted readiness checkpoint must be idempotent');
    assert.equal((await listFactCandidates({ pool }, { ownerUserId: owner, projectId })).length, EXPECTED_FACTS);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bb_fact_extraction_runs WHERE owner_user_id=$1 AND project_id=$2`,
      [owner, projectId])).rows[0]?.count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2
      AND event_type='fact.extraction.completed'`, [owner, projectId])).rows[0]?.count, 1);

    assert.deepEqual(await listFactCandidates({ pool }, { ownerUserId: foreignOwner, projectId }), [], 'a different account cannot read the owner-scoped candidates');
    await assert.rejects(producer({ ownerUserId: foreignOwner, projectId, inputRevision: 1, inputHash,
      materialId: generatedMaterialId, materialVersion: 1, snapshotId: String(snapshotId) }), /FACT_EXTRACTION_INPUT_REVISION_MISMATCH/);

    async function addPinnedVariant(input: { role: string; mediaType: string; hash: string; revision: number }) {
      const variantId = randomUUID(), variantUploadId = randomUUID();
      const variantInputHash = sha256(`authorized negative variant ${suffix} ${input.revision}`);
      const variantKey = `authorized-test/${projectId}/${variantId}/v1`;
      await pool.query(`INSERT INTO bb_uploads
        (id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 day','completed',$7,$6)`,
      [variantUploadId, owner, projectId, `variant-${input.revision}`, input.mediaType, authorizedFile.bytes, input.hash, input.role, `${variantKey}/upload`]);
      await pool.query(`INSERT INTO bb_material_versions
        (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted')`,
      [variantId, owner, projectId, variantUploadId, input.role, `variant-${input.revision}`, input.mediaType, authorizedFile.bytes, input.hash, variantKey]);
      await pool.query(`INSERT INTO bb_input_revisions
        (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,'[]'::jsonb)`, [
        projectId, input.revision, owner, variantInputHash,
        JSON.stringify({ issuer_identity: verifiedIssuerIdentityBinding(verifiedIdentity!), issuer_entity_id: verifiedIdentity!.entityId,
          materials: [{ material_id: variantId, material_version: 1, role: input.role, sha256: input.hash }] }),
        JSON.stringify([{ material_id: variantId, material_version: 1 }]),
      ]);
      const client = await pool.connect();
      let parseJob: Awaited<ReturnType<typeof enqueueMaterialParse>>;
      try {
        parseJob = await enqueueMaterialParse(client, { owner, projectId, materialId: variantId, materialVersion: 1,
          sha256: input.hash, traceId: `rq-negative-${identifier(suffix)}-${input.revision}`, parserVersion: documentParserVersion() });
      } finally { client.release(); }
      await pool.query(`UPDATE bb_jobs SET state='succeeded',stage='succeeded',result=$2::jsonb
        WHERE id=$1 AND state='queued'`, [parseJob.jobId, JSON.stringify({ outcome: 'parsed' })]);
      return { variantId, variantInputHash };
    }

    for (const [index, variant] of [
      { role: 'historical', mediaType: DOCX, hash: sha256('not the authorized rq prospectus'), expected: /FACT_EXTRACTION_MATERIAL_NOT_FINANCIAL/ },
      { role: 'historical', mediaType: 'text/plain', hash: authorizedFile.sha256, expected: /FACT_EXTRACTION_MATERIAL_NOT_FINANCIAL/ },
      { role: 'reference', mediaType: DOCX, hash: authorizedFile.sha256, expected: /FACT_EXTRACTION_MATERIAL_NOT_FINANCIAL/ },
    ].entries()) {
      const revision = index + 2;
      const pinned = await addPinnedVariant({ ...variant, revision });
      await assert.rejects(producer({ ownerUserId: owner, projectId, inputRevision: revision, inputHash: pinned.variantInputHash,
        materialId: pinned.variantId, materialVersion: 1, snapshotId: String(snapshotId) }), variant.expected);
      const variantRun = { ...run, input_revision: revision, input_hash: pinned.variantInputHash };
      const variantStage = await createMaterialsReadyStage(producer).run({
        pool, blobs: {} as never, lease: {} as never, signal: new AbortController().signal,
        run: projectRunExecution(variantRun, { executionVersion: 1, inputRevision: variantRun.input_revision, inputHash: variantRun.input_hash }), checkpoint: {}, values: new Map(),
      });
      assert.equal(variantStage.kind, 'done', 'nonallowlisted historical/reference variants must not be selected for fact extraction');
      if (variantStage.kind === 'done') assert.deepEqual(variantStage.checkpoint?.extractions, []);
    }

    const bytesAfter = await readFile(filePath);
    assert.equal(sha256(bytesAfter), authorizedFile.sha256, 'authorized source SHA-256 must remain unchanged after the test');
  } finally {
    await pool.end();
  }
});
