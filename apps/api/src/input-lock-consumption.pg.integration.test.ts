import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { PROJECT_MESSAGE_SET_EMPTY_VERSION, projectMessageSetRef, type GenerationIssuerBindingRef } from '@bondbuddy/contracts';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord,
} from './issuer-identity-source.js';
import {
  appendGenerationIssuerBinding,
  loadApprovedGenerationIssuerBindingForLock,
  reviewGenerationIssuerBinding,
  type GenerationIssuerBindingDecisionInput,
} from './generation-issuer-binding.js';
import { loadCurrentProjectMessageSetPin } from './project-message-set-lock.js';
import { isolatedTestDatabase } from './test-database.js';
import { azureBlobs, digest } from './data.js';
import { createServer } from './server.js';
import { documentParserVersion } from './material-jobs.js';
import { inputManifestHash } from './production-rule-pin.js';

const databaseUrl = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const connection = await isolatedTestDatabase(undefined, 'input-lock-consumption');
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ENTITY = 'entity:11111111-1111-4111-8111-111111111111';
const ENTITY_BASIS = { verifiedEntityId: ENTITY, entityBasisKind: 'manual_attestation' as const, entityBasisRef: 'synthetic identity review' };

interface EvidenceSpec { readonly recordId: string; readonly quote: string }

async function insertSyntheticMaterial(pool: Pool, args: {
  owner: string; projectId: string; material: { id: string; role: 'audit' | 'notes' | 'reference'; evidence: readonly EvidenceSpec[] }; parserVersion: string;
}): Promise<void> {
  const { owner, projectId, material, parserVersion } = args;
  const contentHash = sha(`material-bytes-${material.id}`), uploadId = `upload-${material.id}`, snapshotId = `snapshot-${material.id}`;
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
    state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',10,$4,$5,$6,now()+interval '1 hour','completed',$4,10)`,
  [uploadId, owner, projectId, contentHash, material.role, `synthetic/${uploadId}`]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',10,$6,$7,'parsed')`,
  [material.id, owner, projectId, uploadId, material.role, contentHash, `users/${owner}/projects/${projectId}/materials/${material.id}`]);
  const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${snapshotId}`, status: 'parsed',
    parser_version: parserVersion, material: { material_id: material.id, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
    warnings: [], document: { page_count: 1 }, error: null };
  await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
    response_status,response_schema_version,response_sha256,record_count,response_meta)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,$9,$10::jsonb)`,
  [snapshotId, owner, projectId, material.id, contentHash, parserVersion, sha(`parse-request-${snapshotId}`),
    sha(`parse-response-${snapshotId}`), material.evidence.length, JSON.stringify(meta)]);
  for (const [ordinal, evidence] of material.evidence.entries()) {
    await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
      locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic test evidence','native_text',$9,0.99,'[]','{}',$10,$11)`,
    [owner, projectId, material.id, snapshotId, evidence.recordId, contentHash,
      JSON.stringify({ page: ordinal + 1, bbox: [0, 0, 1, 1] }), evidence.quote, parserVersion, sha(evidence.recordId), ordinal]);
  }
}

/** Owner/project with two reviewed issuer-role materials and one approved binding pinned to input revision 1. */
async function provisionApprovedBinding(pool: Pool, suffix: string, label: string) {
  const owner = `${label}-owner-${suffix}`, reviewerId = `${label}-reviewer-${suffix}`, grantorId = `${label}-grantor-${suffix}`;
  const projectId = `${label}-project-${suffix}`, grantId = `${label}-grant-${suffix}`, parserVersion = `parser-${label}-${suffix}`;
  const auditId = `${label}-audit-${suffix}`, notesId = `${label}-notes-${suffix}`;
  const auditEvidence = `${label}-audit-evidence-${suffix}`, notesEvidence = `${label}-notes-evidence-${suffix}`;
  const inputHash = sha(`${label}-input-${suffix}`);
  for (const [id, username] of [[owner, `${label}owner`], [reviewerId, `${label}reviewer`], [grantorId, `${label}grantor`]] as const) {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `${username}${suffix}`]);
  }
  await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision,latest_input_revision)
    VALUES($1,$2,'Synthetic generation','generation','Browser supplied name','sse','private',1,null)`, [projectId, owner]);
  const manifest = { draft_revision: 1, kind: 'generation', materials: [
    { material_id: auditId, material_version: 1, role: 'audit', sha256: sha(`material-bytes-${auditId}`) },
    { material_id: notesId, material_version: 1, role: 'notes', sha256: sha(`material-bytes-${notesId}`) },
  ] };
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]')`,
  [projectId, owner, inputHash, JSON.stringify(manifest),
    JSON.stringify(manifest.materials.map(material => ({ material_id: material.material_id, material_version: material.material_version })))]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);
  await insertSyntheticMaterial(pool, { owner, projectId, parserVersion, material: { id: auditId, role: 'audit', evidence: [{ recordId: auditEvidence, quote: '合成发行人甲合并资产负债表' }] } });
  await insertSyntheticMaterial(pool, { owner, projectId, parserVersion, material: { id: notesId, role: 'notes', evidence: [{ recordId: notesEvidence, quote: '本公司为合成发行人甲有限公司' }] } });
  await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
    VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [grantId, reviewerId, grantorId, owner, projectId]);
  const reviewer = (await authorizeIssuerIdentityReviewer(pool, reviewerId, { ownerUserId: owner, projectId }))!;
  const addReview = async (materialId: string, recordId: string) => {
    const record = await appendIssuerIdentitySourceRecord({ pool, newId: randomUUID }, {
      ownerUserId: owner, projectId, materialId, materialVersion: 1, requestId: `request-${recordId}`,
      sourceRecordId: recordId, issuerDisplayName: '合成发行人甲', entityId: `issuer-name:v1:${sha('合成发行人甲').slice(0, 32)}`,
    });
    return (await reviewIssuerIdentitySourceRecord({ pool, newId: randomUUID }, {
      ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: record.id, reviewer,
      decision: 'verified', reasonCode: 'synthetic_verified', ...ENTITY_BASIS,
    })).reviewId;
  };
  const auditReview = await addReview(auditId, auditEvidence);
  const notesReview = await addReview(notesId, notesEvidence);
  const decisions: GenerationIssuerBindingDecisionInput[] = [
    { material_id: auditId, material_version: 1, disposition: 'classified', reason: '合并编制主体。',
      observations: [{ source_record_id: auditEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'financial_statement',
        subject_relation: 'issuer_compiler', accounting_scope: 'consolidated', relation_reason: '合并编制主体。', source_identity_review_id: auditReview }] },
    { material_id: notesId, material_version: 1, disposition: 'classified', reason: '附注主体说明。',
      observations: [{ source_record_id: notesEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'identity_relationship',
        subject_relation: 'issuer_compiler', accounting_scope: 'not_applicable', relation_reason: '附注主体说明。', source_identity_review_id: notesReview }] },
  ];
  const deps = { pool, newId: randomUUID };
  const appended = await appendGenerationIssuerBinding(deps, {
    ownerUserId: owner, projectId, inputRevision: 1, inputHash, requestId: `${label}-binding-${suffix}`, reviewer, materialDecisions: decisions,
  });
  const ref: GenerationIssuerBindingRef = { binding_id: appended.bindingId, version: appended.version, content_sha256: appended.contentSha256 };
  return {
    owner, projectId, reviewer, ref, auditId, notesId, parserVersion, deps,
    async approve() {
      await reviewGenerationIssuerBinding(deps, { ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version,
        contentSha256: ref.content_sha256, requestId: `${label}-approve-${suffix}`, action: 'approve', reason: '逐项核验。', reviewer });
    },
    async withdraw() {
      await reviewGenerationIssuerBinding(deps, { ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version,
        contentSha256: ref.content_sha256, requestId: `${label}-withdraw-${suffix}`, action: 'withdraw', reason: '材料撤回。', reviewer });
    },
  };
}

async function insertProjectMessage(pool: Pool, args: { owner: string; projectId: string; messageId: string; version: number; messageVersion: number; body: string }) {
  const { owner, projectId, messageId, version, messageVersion, body } = args;
  const snapshotId = `msg-snapshot-${messageId}-${version}`;
  await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,snapshot_kind,version,object_key,content_sha256,redaction_version)
    VALUES($1,$2,$3,'user_prompt',$4,$5,$6,'v1')`,
  [snapshotId, owner, projectId, version, `users/${owner}/projects/${projectId}/snapshots/${snapshotId}`, digest(body)]);
  await pool.query(`INSERT INTO bb_user_submission_versions(id,owner_user_id,project_id,snapshot_id,submission_kind,message_id,submission_request_id,message_version,version,content_sha256)
    VALUES($1,$2,$3,$4,'project_message',$5,$6,$7,$8,$9)`,
  [`msg-submission-${messageId}-${version}`, owner, projectId, snapshotId, messageId, `msg-request-${messageId}-${version}`, messageVersion, version, digest(body)]);
}

test('approved generation input with parsed audit enters the controlled channel without a historical draft',
  { skip: !databaseUrl || !blobConnection }, async () => {
    const names = ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL', 'BB_PREPROD_WORKING_DRAFT_EXPIRES_AT',
      'BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH', 'BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH',
      'BB_PREPROD_WORKING_DRAFT_STAGE', 'BB_PREPROD_WORKING_DRAFT_AS_OF'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.BB_DEPLOYMENT_TIER = 'preprod';
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
    process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
    process.env.BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH = 'a'.repeat(64);
    process.env.BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH = 'b'.repeat(64);
    process.env.BB_PREPROD_WORKING_DRAFT_STAGE = 'issuance';
    process.env.BB_PREPROD_WORKING_DRAFT_AS_OF = '2026-09-29';
    const pool = new Pool({ connectionString: connection });
    const blobs = azureBlobs(blobConnection!);
    const fixture = await provisionApprovedBinding(pool, randomUUID().replaceAll('-', '').slice(0, 10), 'admit');
    let activeOwner = fixture.owner;
    const app = createServer({ pool, blobs, principal: async () => ({ userId: activeOwner, csrfVerified: true }),
      allowedOrigin: origin, enableSyntheticQueue: true });
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { origin }, payload: payload as never });
    try {
      await fixture.approve();
      for (const materialId of [fixture.auditId, fixture.notesId]) {
        await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,project_id,material_id,material_version,
          material_sha256,parser_version,trace_id,max_attempts,result)
          VALUES($1,$2,NULL,'parse','material_parse','succeeded',$3,$4,1,$5,$6,$7,3,$8)`,
        [randomUUID(), fixture.owner, fixture.projectId, materialId, sha(`material-bytes-${materialId}`),
          documentParserVersion(), randomUUID(), { outcome: 'parsed', parse_status: 'parsed' }]);
      }
      const locked = await post(`/api/v1/projects/${fixture.projectId}/input-revisions`, {
        draft_revision: 1, material_versions: [fixture.auditId, fixture.notesId].map(material_id => ({ material_id, material_version: 1 })),
        requirement_message_ids: [], generation_issuer_binding_ref: fixture.ref,
      });
      assert.equal(locked.statusCode, 201, locked.body);
      const input = locked.json() as { input_revision: number; input_hash: string };
      const preflight = await post(`/api/v1/projects/${fixture.projectId}/preflight`,
        { input_revision: input.input_revision, input_hash: input.input_hash });
      assert.equal(preflight.statusCode, 200, preflight.body);
      const request = { input_revision: input.input_revision, input_hash: input.input_hash,
        project_id: fixture.projectId, execution_request_id: randomUUID(), task_kind: 'generation',
        input_manifest_ref: 'synthetic', storage_origin: 'cloud', workspace_id: 'synthetic' };
      const submitted = await post('/api/v1/runs/execute', request);
      assert.equal(submitted.statusCode, 202, submitted.body);
      assert.equal(submitted.json().channel, 'non_production_test');
      assert.equal((await post('/api/v1/runs/execute', request)).json().run_id, submitted.json().run_id);
      const count = await pool.query('SELECT count(*)::int AS n FROM bb_non_production_test_grants WHERE user_id=$1 AND project_id=$2',
        [fixture.owner, fixture.projectId]);
      assert.equal(count.rows[0].n, 1);
      // A reviewed reference may supply structure; the issuer binding still covers only audit/notes.
      const referenceId = `admit-reference-${randomUUID().replaceAll('-', '')}`, evidenceId = `reference-evidence-${referenceId}`;
      await insertSyntheticMaterial(pool, { owner: fixture.owner, projectId: fixture.projectId, parserVersion: documentParserVersion(),
        material: { id: referenceId, role: 'reference', evidence: [{ recordId: evidenceId, quote: '合成参考章节' }] } });
      const referenceHash = sha(`material-bytes-${referenceId}`), referenceSnapshot = `snapshot-${referenceId}`;
      await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,project_id,material_id,material_version,
        material_sha256,parser_version,trace_id,max_attempts,result)
        VALUES($1,$2,NULL,'parse','material_parse','succeeded',$3,$4,1,$5,$6,$7,3,$8)`,
        [randomUUID(), fixture.owner, fixture.projectId, referenceId, referenceHash,
          documentParserVersion(), randomUUID(), { outcome: 'parsed', parse_status: 'parsed' }]);
      const referenceGrant = `reference-grant-${referenceId}`, referenceReview = `reference-review-${referenceId}`;
      const referenceContext = `reference-context-${referenceId}`, product = 'synthetic_bond', stage = 'draft';
      await pool.query(`INSERT INTO bb_user_reference_reviewer_grants(id,reviewer_user_id,granted_by)
        VALUES($1,$2,$3)`, [referenceGrant, fixture.reviewer.userId, fixture.owner]);
      await pool.query(`INSERT INTO bb_user_reference_target_contexts(id,owner_user_id,project_id,target_market,target_offering,
        target_product,target_document_stage,content_hash,status,reviewer_user_id,reviewer_grant_id)
        VALUES($1,$2,$3,'sse','private',$4,$5,$6,'accepted',$7,$8)`,
        [referenceContext, fixture.owner, fixture.projectId, product, stage,
          inputManifestHash({ market: 'sse', offering: 'private', product, document_stage: stage }),
          fixture.reviewer.userId, referenceGrant]);
      const outline = [{ order: 1, heading: '合成参考章节' }];
      await pool.query(`INSERT INTO bb_user_reference_reviews(id,owner_user_id,project_id,material_id,material_version,
        material_sha256,parse_snapshot_id,target_market,target_offering,target_product,target_document_stage,
        authorization_status,readability_status,applicability_status,status,fact_isolation_check_version,outline,
        confirmed_warning_codes,parse_response_sha256,signed_outline_sha256,reviewer_user_id,reviewer_grant_id)
        VALUES($1,$2,$3,$4,1,$5,$6,'sse','private',$7,$8,'accepted','accepted','accepted','accepted',
          'synthetic-isolation-v1',$9,'[]',$10,$11,$12,$13)`,
        [referenceReview, fixture.owner, fixture.projectId, referenceId, referenceHash, referenceSnapshot,
          product, stage, JSON.stringify(outline), sha(`parse-response-${referenceSnapshot}`),
          inputManifestHash(outline), fixture.reviewer.userId, referenceGrant]);
      const withReference = await post(`/api/v1/projects/${fixture.projectId}/input-revisions`, {
        draft_revision: 1, material_versions: [fixture.auditId, fixture.notesId, referenceId]
          .map(material_id => ({ material_id, material_version: 1 })), requirement_message_ids: [],
        generation_issuer_binding_ref: fixture.ref,
        user_reference: { material_id: referenceId, material_version: 1, material_sha256: referenceHash,
          parse_snapshot_id: referenceSnapshot, target_product: product, target_document_stage: stage },
      });
      assert.equal(withReference.statusCode, 201, withReference.body);
      const referenced = withReference.json() as { input_revision: number; input_hash: string };
      const referenceRun = await post('/api/v1/runs/execute', { ...request, execution_request_id: randomUUID(),
        input_revision: referenced.input_revision, input_hash: referenced.input_hash });
      assert.equal(referenceRun.statusCode, 202, referenceRun.body);
      assert.equal(referenceRun.json().channel, 'non_production_test');
      await pool.query('UPDATE bb_user_reference_reviewer_grants SET revoked_at=now() WHERE id=$1', [referenceGrant]);
      assert.equal((await post('/api/v1/runs/execute', { ...request, execution_request_id: randomUUID(),
        input_revision: referenced.input_revision, input_hash: referenced.input_hash })).json().code, 'INPUT_REQUIRED');
      const execute = (changes: Record<string, unknown> = {}) => post('/api/v1/runs/execute',
        { ...request, execution_request_id: randomUUID(), ...changes });
      const preflightAgain = () => post(`/api/v1/projects/${fixture.projectId}/preflight`,
        { input_revision: input.input_revision, input_hash: input.input_hash });
      assert.equal((await execute({ input_hash: 'f'.repeat(64) })).json().code, 'INPUT_REVISION_CONFLICT');
      assert.equal((await execute({ task_kind: 'update' })).json().code, 'INPUT_REVISION_CONFLICT');
      process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'disabled';
      assert.equal((await execute()).json().code, 'TEST_CHANNEL_DISABLED');
      process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
      process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT = new Date(Date.now() - 3_600_000).toISOString();
      assert.equal((await execute()).json().code, 'TEST_GRANT_EXPIRED');
      process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
      await fixture.withdraw();
      assert.equal((await preflightAgain()).json().code, 'INPUT_REQUIRED');
      assert.equal((await execute()).json().code, 'INPUT_REQUIRED');
      assert.equal((await post('/api/v1/runs/execute', request)).json().run_id, submitted.json().run_id,
        'same execution request remains bound to its original run');
      const after = await pool.query('SELECT count(*)::int AS n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2',
        [fixture.owner, fixture.projectId]);
      assert.equal(after.rows[0].n, 2);
      const noBinding = await post(`/api/v1/projects/${fixture.projectId}/input-revisions`, {
        draft_revision: 1, material_versions: [fixture.auditId, fixture.notesId].map(material_id => ({ material_id, material_version: 1 })),
        requirement_message_ids: [],
      });
      assert.equal(noBinding.statusCode, 201, noBinding.body);
      const unboundInput = noBinding.json() as { input_revision: number; input_hash: string };
      assert.equal((await execute({ input_revision: unboundInput.input_revision, input_hash: unboundInput.input_hash })).json().code, 'INPUT_REQUIRED');
      const empty = await post(`/api/v1/projects/${fixture.projectId}/input-revisions`, {
        draft_revision: 1, material_versions: [], requirement_message_ids: [],
      });
      assert.equal(empty.statusCode, 201, empty.body);
      const emptyInput = empty.json() as { input_revision: number; input_hash: string };
      assert.equal((await execute({ input_revision: emptyInput.input_revision, input_hash: emptyInput.input_hash })).json().code, 'INPUT_REQUIRED');
      const pending = await provisionApprovedBinding(pool, randomUUID().replaceAll('-', '').slice(0, 10), 'pending');
      await pending.approve();
      activeOwner = pending.owner;
      for (const materialId of [pending.auditId, pending.notesId]) {
        const queued = materialId === pending.auditId;
        await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,project_id,material_id,material_version,
          material_sha256,parser_version,trace_id,max_attempts,result)
          VALUES($1,$2,NULL,'parse','material_parse',$3,$4,$5,1,$6,$7,$8,3,$9)`,
          [randomUUID(), pending.owner, queued ? 'queued' : 'succeeded', pending.projectId, materialId,
            sha(`material-bytes-${materialId}`), documentParserVersion(), randomUUID(),
            queued ? null : { outcome: 'parsed', parse_status: 'parsed' }]);
      }
      const pendingLock = await post(`/api/v1/projects/${pending.projectId}/input-revisions`, {
        draft_revision: 1, material_versions: [pending.auditId, pending.notesId].map(material_id => ({ material_id, material_version: 1 })),
        requirement_message_ids: [], generation_issuer_binding_ref: pending.ref,
      });
      assert.equal(pendingLock.statusCode, 201, pendingLock.body);
      const pendingInput = pendingLock.json() as { input_revision: number; input_hash: string };
      assert.equal((await post(`/api/v1/projects/${pending.projectId}/preflight`,
        { input_revision: pendingInput.input_revision, input_hash: pendingInput.input_hash })).json().code, 'CAPABILITY_NOT_READY');
      assert.equal((await post('/api/v1/runs/execute', { ...request, project_id: pending.projectId,
        input_revision: pendingInput.input_revision, input_hash: pendingInput.input_hash,
        execution_request_id: randomUUID() })).json().code, 'CAPABILITY_NOT_READY');
    } finally {
      await app.close(); await pool.end();
      names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    }
  });

test('synthetic PostgreSQL input revision locks an approved generation issuer binding and exact message set',
  { skip: !databaseUrl || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: connection });
    const blobs = azureBlobs(blobConnection!);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    let active = 'placeholder';
    const app = createServer({ pool, blobs, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin, enableRunStaging: true });
    const send = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as never, url, headers: { origin }, payload: payload as never });
    const lock = async (owner: string, projectId: string, body: Record<string, unknown>) => {
      active = owner;
      return send('POST', `/api/v1/projects/${projectId}/input-revisions`, body);
    };
    try {
      // Positive: approved ref is re-verified and pinned; empty message set stays explicit.
      const positive = await provisionApprovedBinding(pool, suffix, 'pos');
      await positive.approve();
      const created = await lock(positive.owner, positive.projectId, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: [{ material_id: positive.auditId, material_version: 1 }, { material_id: positive.notesId, material_version: 1 }],
        generation_issuer_binding_ref: positive.ref,
      });
      assert.equal(created.statusCode, 201, created.body);
      const locked = (await pool.query('SELECT manifest, requirement_message_ids FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=2',
        [positive.owner, positive.projectId])).rows[0];
      assert.deepEqual(locked.manifest.generation_issuer_binding_ref, positive.ref, 'the exact binding ref is pinned into the immutable manifest');
      assert.equal(locked.manifest.generation_issuer_entity_id, ENTITY, 'the approved legal entity is pinned, never the browser name');
      assert.equal(locked.manifest.issuer_name, 'Browser supplied name');
      assert.deepEqual(locked.requirement_message_ids, [], 'an empty active set stays explicit');

      // Replay idempotency: the same draft and refs produce the same immutable input hash.
      const replayed = await lock(positive.owner, positive.projectId, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: [{ material_id: positive.auditId, material_version: 1 }, { material_id: positive.notesId, material_version: 1 }],
        generation_issuer_binding_ref: positive.ref,
      });
      assert.equal(replayed.statusCode, 201, replayed.body);
      const hashes = (await pool.query('SELECT revision, input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 ORDER BY revision',
        [positive.owner, positive.projectId])).rows.map(row => row.input_hash.trim());
      assert.equal(hashes[2], hashes[1], 'successive revisions with identical refs share an input hash');

      // Missing ref: fail-closed, no synthesized binding pin and no browser-name fallback.
      const missing = await provisionApprovedBinding(pool, suffix, 'miss');
      const missingCreated = await lock(missing.owner, missing.projectId, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: [{ material_id: missing.auditId, material_version: 1 }, { material_id: missing.notesId, material_version: 1 }],
      });
      assert.equal(missingCreated.statusCode, 201, missingCreated.body);
      const missingManifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=2',
        [missing.owner, missing.projectId])).rows[0].manifest;
      assert.equal(Object.hasOwn(missingManifest, 'generation_issuer_binding_ref'), false, 'a missing ref never fabricates a binding pin');

      // Withdrawn ref is rejected, never silently dropped.
      const withdrawn = await provisionApprovedBinding(pool, suffix, 'wd');
      await withdrawn.approve();
      await withdrawn.withdraw();
      const withdrawnCreated = await lock(withdrawn.owner, withdrawn.projectId, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: [{ material_id: withdrawn.auditId, material_version: 1 }, { material_id: withdrawn.notesId, material_version: 1 }],
        generation_issuer_binding_ref: withdrawn.ref,
      });
      assert.equal(withdrawnCreated.statusCode, 409, withdrawnCreated.body);

      // A swapped/extra issuer material no longer matches the approved pin.
      const swapped = await provisionApprovedBinding(pool, suffix, 'swap');
      await swapped.approve();
      await insertSyntheticMaterial(pool, { owner: swapped.owner, projectId: swapped.projectId, parserVersion: `parser-swap-${suffix}`,
        material: { id: `${swapped.auditId}-extra`, role: 'audit', evidence: [{ recordId: `swap-extra-evidence-${suffix}`, quote: '另一份合成审计报告' }] } });
      const swappedCreated = await lock(swapped.owner, swapped.projectId, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: [{ material_id: swapped.auditId, material_version: 1 }, { material_id: swapped.notesId, material_version: 1 }, { material_id: `${swapped.auditId}-extra`, material_version: 1 }],
        generation_issuer_binding_ref: swapped.ref,
      });
      assert.equal(swappedCreated.statusCode, 409, swappedCreated.body);

      // Cross-scope ref never authorizes another project/owner.
      const other = await provisionApprovedBinding(pool, suffix, 'other');
      await other.approve();
      assert.equal(await loadApprovedGenerationIssuerBindingForLock(pool, { ownerUserId: `${swapped.owner}-foreign`, projectId: swapped.projectId }, swapped.ref),
        null, 'a ref never authorizes a foreign owner');
      assert.equal(await loadApprovedGenerationIssuerBindingForLock(pool, { ownerUserId: other.owner, projectId: other.projectId }, swapped.ref),
        null, 'a ref never authorizes another project');

      // A newer parse snapshot invalidates the lock-time re-verification.
      const reparsed = await provisionApprovedBinding(pool, suffix, 'parse');
      await reparsed.approve();
      assert.ok(await loadApprovedGenerationIssuerBindingForLock(pool, { ownerUserId: reparsed.owner, projectId: reparsed.projectId }, reparsed.ref),
        'the approved binding is initially loadable for the lock');
      {
        const contentHash = sha(`material-bytes-${reparsed.auditId}`), newerSnapshot = `${reparsed.auditId}-reparse`;
        const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${newerSnapshot}`, status: 'parsed',
          parser_version: `${reparsed.parserVersion}-v2`, material: { material_id: reparsed.auditId, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
          warnings: [], document: { page_count: 1 }, error: null };
        await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
          response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb,now()+interval '1 hour')`,
        [newerSnapshot, reparsed.owner, reparsed.projectId, reparsed.auditId, contentHash, `${reparsed.parserVersion}-v2`,
          sha(`parse-request-${newerSnapshot}`), sha(`parse-response-${newerSnapshot}`), JSON.stringify(meta)]);
        assert.equal(await loadApprovedGenerationIssuerBindingForLock(pool, { ownerUserId: reparsed.owner, projectId: reparsed.projectId }, reparsed.ref),
          null, 'a newer parse snapshot invalidates the lock-time re-verification');
      }
    } finally { await app.close(); await pool.end(); }
  });

test('synthetic PostgreSQL input revision pins the active message set and rejects fabricated or divergent sets',
  { skip: !databaseUrl || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: connection });
    const blobs = azureBlobs(blobConnection!);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    let active = 'placeholder';
    const app = createServer({ pool, blobs, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin, enableRunStaging: true });
    const lock = async (owner: string, projectId: string, body: Record<string, unknown>) => {
      active = owner;
      return app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`, headers: { origin }, payload: body as never });
    };
    try {
      const state = await provisionApprovedBinding(pool, suffix, 'msg');
      await state.approve();
      await insertProjectMessage(pool, { owner: state.owner, projectId: state.projectId, messageId: `message-a-${suffix}`, version: 1, messageVersion: 1, body: '合成补充要求一' });
      await insertProjectMessage(pool, { owner: state.owner, projectId: state.projectId, messageId: `message-b-${suffix}`, version: 2, messageVersion: 1, body: '合成补充要求二' });
      const pin = await loadCurrentProjectMessageSetPin(pool, { ownerUserId: state.owner, projectId: state.projectId });
      const ref = projectMessageSetRef(pin);
      assert.equal(ref.message_ids.length, 2);
      assert.notEqual(pin.content_sha256, '0'.repeat(64));

      // A non-empty set without an exact ref is refused; it is never bound as [].
      const missing = await lock(state.owner, state.projectId, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: [{ material_id: state.auditId, material_version: 1 }, { material_id: state.notesId, material_version: 1 }],
      });
      assert.equal(missing.statusCode, 409, missing.body);

      // A bare version or divergent member projection can never match.
      const bare = await lock(state.owner, state.projectId, {
        draft_revision: 1, requirement_message_ids: [], material_versions: [],
        project_message_set_ref: { version: ref.version, content_sha256: ref.content_sha256, message_ids: [] },
      });
      assert.equal(bare.statusCode, 409, bare.body);
      const divergent = await lock(state.owner, state.projectId, {
        draft_revision: 1, requirement_message_ids: [], material_versions: [],
        project_message_set_ref: { version: ref.version, content_sha256: ref.content_sha256, message_ids: [ref.message_ids[0]!] },
      });
      assert.equal(divergent.statusCode, 409, divergent.body);

      // The exact set is pinned and the legacy requirement id column mirrors it.
      const pinned = await lock(state.owner, state.projectId, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: [{ material_id: state.auditId, material_version: 1 }, { material_id: state.notesId, material_version: 1 }],
        project_message_set_ref: ref,
      });
      assert.equal(pinned.statusCode, 201, pinned.body);
      const row = (await pool.query('SELECT manifest, requirement_message_ids FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=2',
        [state.owner, state.projectId])).rows[0];
      assert.deepEqual(row.manifest.project_message_set_ref, ref, 'the exact aggregate ref is pinned');
      assert.deepEqual(row.requirement_message_ids, ref.message_ids, 'a non-empty set is never replaced by an empty placeholder');

      // An explicit empty set still round-trips for a project that has no messages.
      const emptyOwner = `msg-empty-owner-${suffix}`, emptyProject = `msg-empty-project-${suffix}`;
      await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision,latest_input_revision) VALUES($1,$2,'Synthetic empty','generation',null,'sse',null,1,null)", [emptyProject, emptyOwner]);
      const emptyPin = await loadCurrentProjectMessageSetPin(pool, { ownerUserId: emptyOwner, projectId: emptyProject });
      const emptyRef = projectMessageSetRef(emptyPin);
      assert.equal(emptyRef.version, PROJECT_MESSAGE_SET_EMPTY_VERSION);
      const empty = await lock(emptyOwner, emptyProject, {
        draft_revision: 1, requirement_message_ids: [], material_versions: [], project_message_set_ref: emptyRef,
      });
      assert.equal(empty.statusCode, 201, empty.body);
    } finally { await app.close(); await pool.end(); }
  });
