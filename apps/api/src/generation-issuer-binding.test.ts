import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord,
} from './issuer-identity-source.js';
import type { IssuerIdentitySourcePool } from './issuer-identity-source.js';
import {
  appendGenerationIssuerBinding,
  loadApprovedGenerationIssuerBinding,
  reviewGenerationIssuerBinding,
  type GenerationIssuerBindingDependencies,
  type GenerationIssuerBindingDecisionInput,
} from './generation-issuer-binding.js';
import { consumeGenerationIssuerBinding, type GenerationIssuerBindingSeam } from './generation-issuer-binding-consumer.js';

import { isolatedTestDatabase } from './test-database.js';
const databaseUrl = await isolatedTestDatabase();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const entityA = 'entity:11111111-1111-4111-8111-111111111111';
const entityB = 'entity:22222222-2222-4222-8222-222222222222';
const ENTITY_BASIS = { verifiedEntityId: entityA, entityBasisKind: 'manual_attestation' as const, entityBasisRef: 'synthetic identity review' };

function savepointPool(connection: PoolClient): Pool {
  let next = 0;
  const sourcePool: IssuerIdentitySourcePool = {
    query: (sql, values) => connection.query(sql, values),
    connect: async () => {
      const name = `generation_issuer_binding_${++next}`;
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

interface EvidenceSpec { readonly recordId: string; readonly quote: string }
interface MaterialSpec { readonly id: string; readonly role: 'audit' | 'financial' | 'notes'; readonly evidence: readonly EvidenceSpec[] }

async function insertSyntheticMaterial(connection: PoolClient, args: {
  owner: string; projectId: string; material: MaterialSpec; parserVersion: string;
}): Promise<{ snapshotId: string }> {
  const { owner, projectId, material, parserVersion } = args;
  const contentHash = sha(`material-bytes-${material.id}`), uploadId = `upload-${material.id}`, snapshotId = `snapshot-${material.id}`;
  await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
    state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',10,$4,$5,$6,now()+interval '1 hour','completed',$4,10)`,
  [uploadId, owner, projectId, contentHash, material.role, `synthetic/${uploadId}`]);
  await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',10,$6,$7,'parsed')`,
  [material.id, owner, projectId, uploadId, material.role, contentHash, `users/${owner}/projects/${projectId}/materials/${material.id}`]);
  const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${snapshotId}`, status: 'parsed',
    parser_version: parserVersion, material: { material_id: material.id, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
    warnings: [], document: { page_count: 1 }, error: null };
  await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
    response_status,response_schema_version,response_sha256,record_count,response_meta)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,$9,$10::jsonb)`,
  [snapshotId, owner, projectId, material.id, contentHash, parserVersion, sha(`parse-request-${snapshotId}`),
    sha(`parse-response-${snapshotId}`), material.evidence.length, JSON.stringify(meta)]);
  for (const [ordinal, evidence] of material.evidence.entries()) {
    await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
      locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic test evidence','native_text',$9,0.99,'[]','{}',$10,$11)`,
    [owner, projectId, material.id, snapshotId, evidence.recordId, contentHash,
      JSON.stringify({ page: ordinal + 1, bbox: [0, 0, 1, 1] }), evidence.quote, parserVersion, sha(evidence.recordId), ordinal]);
  }
  return { snapshotId };
}

/** Provision one owner/project with two reviewed issuer-role materials and one approved binding. */
async function provisionApprovedBinding(args: { connection: PoolClient; scopedPool: Pool; suffix: string; label: string }) {
  const { connection, scopedPool, suffix, label } = args;
  const owner = `${label}-owner-${suffix}`, reviewerId = `${label}-reviewer-${suffix}`, grantorId = `${label}-grantor-${suffix}`;
  const projectId = `${label}-project-${suffix}`, grantId = `${label}-grant-${suffix}`, parserVersion = `parser-${label}-${suffix}`;
  const auditId = `${label}-audit-${suffix}`, notesId = `${label}-notes-${suffix}`;
  const auditEvidence = `${label}-audit-evidence-${suffix}`, notesEvidence = `${label}-notes-evidence-${suffix}`;
  const inputHash = sha(`${label}-input-${suffix}`);
  for (const [id, username] of [[owner, `${label}owner`], [reviewerId, `${label}reviewer`], [grantorId, `${label}grantor`]] as const) {
    await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `${username}${suffix}`]);
  }
  await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision)
    VALUES($1,$2,'Synthetic generation','generation','Browser supplied name','sse','private',1)`, [projectId, owner]);
  const manifest = { draft_revision: 1, kind: 'generation', materials: [
    { material_id: auditId, material_version: 1, role: 'audit', sha256: sha(`material-bytes-${auditId}`) },
    { material_id: notesId, material_version: 1, role: 'notes', sha256: sha(`material-bytes-${notesId}`) },
  ] };
  await connection.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]')`,
  [projectId, owner, inputHash, JSON.stringify(manifest),
    JSON.stringify(manifest.materials.map(material => ({ material_id: material.material_id, material_version: material.material_version })))]);
  await insertSyntheticMaterial(connection, { owner, projectId, parserVersion, material: { id: auditId, role: 'audit', evidence: [{ recordId: auditEvidence, quote: '合成发行人甲合并资产负债表' }] } });
  await insertSyntheticMaterial(connection, { owner, projectId, parserVersion, material: { id: notesId, role: 'notes', evidence: [{ recordId: notesEvidence, quote: '本公司为合成发行人甲有限公司' }] } });
  await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
    VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [grantId, reviewerId, grantorId, owner, projectId]);
  const reviewer = (await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, { ownerUserId: owner, projectId }))!;
  const addReview = async (materialId: string, recordId: string) => {
    const record = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
      ownerUserId: owner, projectId, materialId, materialVersion: 1, requestId: `request-${recordId}`,
      sourceRecordId: recordId, issuerDisplayName: '合成发行人甲', entityId: `issuer-name:v1:${sha('合成发行人甲').slice(0, 32)}`,
    });
    return (await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
      ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: record.id, reviewer,
      decision: 'verified', reasonCode: 'synthetic_verified', ...ENTITY_BASIS,
    })).reviewId;
  };
  const auditReview = await addReview(auditId, auditEvidence);
  const notesReview = await addReview(notesId, notesEvidence);
  const deps: GenerationIssuerBindingDependencies = { pool: scopedPool, newId: randomUUID };
  const appended = await appendGenerationIssuerBinding(deps, {
    ownerUserId: owner, projectId, inputRevision: 1, inputHash, requestId: `${label}-binding-${suffix}`, reviewer,
    materialDecisions: [
      { material_id: auditId, material_version: 1, disposition: 'classified', reason: '合并编制主体。',
        observations: [{ source_record_id: auditEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'financial_statement',
          subject_relation: 'issuer_compiler', accounting_scope: 'consolidated', relation_reason: '合并编制主体。', source_identity_review_id: auditReview }] },
      { material_id: notesId, material_version: 1, disposition: 'classified', reason: '附注主体说明。',
        observations: [{ source_record_id: notesEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'identity_relationship',
          subject_relation: 'issuer_compiler', accounting_scope: 'not_applicable', relation_reason: '附注主体说明。', source_identity_review_id: notesReview }] },
    ],
  });
  await reviewGenerationIssuerBinding(deps, { ownerUserId: owner, projectId, bindingId: appended.bindingId, version: appended.version,
    contentSha256: appended.contentSha256, requestId: `${label}-approve-${suffix}`, action: 'approve', reason: '逐项核验。', reviewer });
  return {
    owner, projectId, reviewerId, grantId, auditId, parserVersion,
    expectedInput: { owner_user_id: owner, project_id: projectId, input_revision: 1, input_hash: inputHash },
    ref: { binding_id: appended.bindingId, version: appended.version, content_sha256: appended.contentSha256 },
  };
}

test('synthetic PostgreSQL: reparse, material loss and reviewer revocation each invalidate an approved binding',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const scopedPool = savepointPool(connection);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const scenario = async (label: string, verify: (state: Awaited<ReturnType<typeof provisionApprovedBinding>>) => Promise<void>) => {
      await connection.query(`SAVEPOINT sc_${label}`);
      try {
        const state = await provisionApprovedBinding({ connection, scopedPool, suffix, label });
        assert.ok(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: state.owner, projectId: state.projectId }, state.ref, state.expectedInput),
          `${label}: approved binding is initially loadable`);
        await verify(state);
      } finally {
        await connection.query(`ROLLBACK TO SAVEPOINT sc_${label}`);
      }
    };
    try {
      await connection.query('BEGIN');
      await scenario('reparse', async state => {
        const contentHash = sha(`material-bytes-${state.auditId}`);
        const newSnapshot = `${state.auditId}-reparse`;
        const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${newSnapshot}`, status: 'parsed',
          parser_version: `${state.parserVersion}-v2`, material: { material_id: state.auditId, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
          warnings: [], document: { page_count: 1 }, error: null };
        await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
          response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb,now()+interval '1 hour')`,
        [newSnapshot, state.owner, state.projectId, state.auditId, contentHash, `${state.parserVersion}-v2`,
          sha(`parse-request-${newSnapshot}`), sha(`parse-response-${newSnapshot}`), JSON.stringify(meta)]);
        assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: state.owner, projectId: state.projectId }, state.ref, state.expectedInput),
          null, 'a newer parse snapshot invalidates the pinned parse');
      });
      await scenario('material', async state => {
        await connection.query(`UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1`,
          [state.owner, state.projectId, state.auditId]);
        assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: state.owner, projectId: state.projectId }, state.ref, state.expectedInput),
          null, 'a deleted or swapped material invalidates the binding');
      });
      await scenario('revoke', async state => {
        await connection.query(`UPDATE bb_issuer_identity_reviewer_grants SET revoked_at=now(),revoked_by=$2,
          revocation_reason_code='synthetic_revoke',revocation_basis='synthetic test revocation' WHERE id=$1`,
        [state.grantId, state.owner]);
        assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: state.owner, projectId: state.projectId }, state.ref, state.expectedInput),
          null, 'revoking the identity reviewer grant invalidates the binding');
      });
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });


test('synthetic PostgreSQL: generation issuer binding persists only reviewer-attested, current combination decisions',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const scopedPool = savepointPool(connection);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `gib-owner-${suffix}`, foreignOwner = `gib-foreign-${suffix}`;
    const reviewerId = `gib-reviewer-${suffix}`, grantorId = `gib-grantor-${suffix}`;
    const projectId = `gib-project-${suffix}`;
    const grantId = `gib-grant-${suffix}`;
    const parserVersion = `parser-${suffix}`;
    const auditId = `gib-audit-${suffix}`, financialId = `gib-financial-${suffix}`, notesId = `gib-notes-${suffix}`;
    const auditEvidence = `gib-audit-evidence-${suffix}`, financialEvidence = `gib-financial-evidence-${suffix}`;
    const notesIssuerEvidence = `gib-notes-issuer-evidence-${suffix}`, notesSubsidiaryEvidence = `gib-notes-subsidiary-evidence-${suffix}`;
    const suffixInputHash = sha(`generation-input-${suffix}`);
    const createMaterial = async (spec: MaterialSpec) => {
      const contentHash = sha(`material-bytes-${spec.id}`);
      const uploadId = `upload-${spec.id}`;
      const snapshotId = `snapshot-${spec.id}`;
      await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',10,$4,$5,$6,now()+interval '1 hour','completed',$4,10)`,
      [uploadId, owner, projectId, contentHash, spec.role, `synthetic/${uploadId}`]);
      await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',10,$6,$7,'parsed')`,
      [spec.id, owner, projectId, uploadId, spec.role, contentHash, `users/${owner}/projects/${projectId}/materials/${spec.id}`]);
      const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${snapshotId}`, status: 'parsed',
        parser_version: parserVersion, material: { material_id: spec.id, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,$9,$10::jsonb)`,
      [snapshotId, owner, projectId, spec.id, contentHash, parserVersion, sha(`parse-request-${snapshotId}`),
        sha(`parse-response-${snapshotId}`), spec.evidence.length, JSON.stringify(meta)]);
      for (const [ordinal, evidence] of spec.evidence.entries()) {
        await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
          locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
          VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic test evidence','native_text',$9,0.99,'[]','{}',$10,$11)`,
        [owner, projectId, spec.id, snapshotId, evidence.recordId, contentHash,
          JSON.stringify({ page: ordinal + 1, bbox: [0, 0, 1, 1] }), evidence.quote, parserVersion, sha(evidence.recordId), ordinal]);
      }
      return { snapshotId, contentHash };
    };
    const addReviewedObservation = async (materialId: string, sourceRecordId: string, quote: string) => {
      const record = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1,
        requestId: `request-${sourceRecordId}`, sourceRecordId, issuerDisplayName: quote,
        entityId: `issuer-name:v1:${sha(quote).slice(0, 32)}`,
      });
      const review = await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: record.id,
        reviewer: (await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, { ownerUserId: owner, projectId }))!,
        decision: 'verified', reasonCode: 'synthetic_verified', ...ENTITY_BASIS,
      });
      return review.reviewId;
    };
    const bindingDeps: GenerationIssuerBindingDependencies = { pool: scopedPool, newId: randomUUID };
    const expectedInput = { owner_user_id: owner, project_id: projectId, input_revision: 1, input_hash: suffixInputHash };
    const decisions = (values: {
      auditReview: string; financialReview: string; notesReview: string;
    }): GenerationIssuerBindingDecisionInput[] => [
      { material_id: auditId, material_version: 1, disposition: 'classified', reason: '合并报表表头明确列示编制主体。',
        observations: [{ source_record_id: auditEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'financial_statement',
          subject_relation: 'issuer_compiler', accounting_scope: 'consolidated', relation_reason: '合并财务报表编制主体一致。',
          source_identity_review_id: values.auditReview }] },
      { material_id: financialId, material_version: 1, disposition: 'classified', reason: '母公司报表编制主体与合并报表一致。',
        observations: [{ source_record_id: financialEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'financial_statement',
          subject_relation: 'issuer_compiler', accounting_scope: 'parent', relation_reason: '同一编制法人的母公司口径。',
          source_identity_review_id: values.financialReview }] },
      { material_id: notesId, material_version: 1, disposition: 'classified', reason: '附注同时出现发行人和组成子公司，逐条定位。',
        observations: [
          { source_record_id: notesIssuerEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'identity_relationship',
            subject_relation: 'issuer_compiler', accounting_scope: 'not_applicable', relation_reason: '附注主体说明识别编制主体。',
            source_identity_review_id: values.notesReview },
          { source_record_id: notesSubsidiaryEvidence, observed_subject_label: '合成子公司乙', evidence_context: 'identity_relationship',
            subject_relation: 'component_subsidiary', accounting_scope: 'not_applicable', relation_reason: '原文明确列为子公司，不作为发行人。',
            source_identity_review_id: null },
        ] },
    ];

    try {
      await connection.query('BEGIN');
      for (const [id, username] of [[owner, 'gibowner'], [foreignOwner, 'gibforeign'], [reviewerId, 'gibreviewer'], [grantorId, 'gibgrantor']] as const) {
        await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `${username}${suffix}`]);
      }
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision)
        VALUES($1,$2,'Synthetic generation','generation','Browser supplied name','sse','private',1)`, [projectId, owner]);
      const manifest = { draft_revision: 1, kind: 'generation', materials: [
        { material_id: auditId, material_version: 1, role: 'audit', sha256: sha(`material-bytes-${auditId}`) },
        { material_id: financialId, material_version: 1, role: 'financial', sha256: sha(`material-bytes-${financialId}`) },
        { material_id: notesId, material_version: 1, role: 'notes', sha256: sha(`material-bytes-${notesId}`) },
      ] };
      await connection.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]')`,
      [projectId, owner, suffixInputHash, JSON.stringify(manifest),
        JSON.stringify(manifest.materials.map(material => ({ material_id: material.material_id, material_version: material.material_version })))]);

      await createMaterial({ id: auditId, role: 'audit', evidence: [{ recordId: auditEvidence, quote: '合成发行人甲及其子公司合并资产负债表' }] });
      await createMaterial({ id: financialId, role: 'financial', evidence: [{ recordId: financialEvidence, quote: '合成发行人甲母公司资产负债表' }] });
      await createMaterial({ id: notesId, role: 'notes', evidence: [
        { recordId: notesIssuerEvidence, quote: '本公司为合成发行人甲有限公司' },
        { recordId: notesSubsidiaryEvidence, quote: '子公司合成子公司乙公司纳入合并范围' },
      ] });

      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [grantId, reviewerId, grantorId, owner, projectId]);
      const reviewer = (await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, { ownerUserId: owner, projectId }))!;
      assert.ok(reviewer, 'the scoped identity reviewer is authorized');
      const auditReview = await addReviewedObservation(auditId, auditEvidence, '合成发行人甲');
      const financialReview = await addReviewedObservation(financialId, financialEvidence, '合成发行人甲');
      const notesReview = await addReviewedObservation(notesId, notesIssuerEvidence, '合成发行人甲');

      const appended = await appendGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash: suffixInputHash, requestId: `binding-request-${suffix}`,
        reviewer, materialDecisions: decisions({ auditReview, financialReview, notesReview }),
      });
      assert.equal(appended.created, true);
      assert.equal(appended.status, 'pending');
      assert.equal(appended.contentSha256.length, 64);

      const replay = await appendGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash: suffixInputHash, requestId: `binding-request-${suffix}`,
        reviewer, materialDecisions: decisions({ auditReview, financialReview, notesReview }),
      });
      assert.equal(replay.created, false);
      assert.equal(replay.bindingId, appended.bindingId, 'the same request replays the same binding');

      const ref = { binding_id: appended.bindingId, version: appended.version, content_sha256: appended.contentSha256 };
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId }, ref, expectedInput), null,
        'a pending binding is never loadable');

      const approved = await reviewGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version, contentSha256: ref.content_sha256,
        requestId: `approve-${suffix}`, action: 'approve', reason: '完整清单逐项核验，发行人编制主体一致。', reviewer,
      });
      assert.equal(approved.status, 'approved');
      const approveReplay = await reviewGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version, contentSha256: ref.content_sha256,
        requestId: `approve-${suffix}`, action: 'approve', reason: '完整清单逐项核验，发行人编制主体一致。', reviewer,
      });
      assert.equal(approveReplay.replayed, true);
      assert.equal(approveReplay.reviewId, approved.reviewId);
      assert.equal(approveReplay.status, 'approved', 'an approve replay returns its resulting status, not a transition error');

      const loaded = await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId }, ref, expectedInput);
      assert.ok(loaded);
      assert.equal(loaded!.issuer_entity_id, entityA);
      assert.equal(loaded!.selected_materials.length, 3);
      assert.equal(loaded!.review_events.length, 1);
      assert.equal(loaded!.material_decisions[2]!.observations[1]!.subject_relation, 'component_subsidiary');
      assert.equal(appended.contentSha256, loaded!.content_sha256);

      const outbox = await connection.query(`SELECT event_type FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2
        AND event_type IN ('generation.issuer_binding.created','generation.issuer_binding.reviewed') ORDER BY created_at`, [owner, projectId]);
      assert.deepEqual(outbox.rows.map(row => row.event_type),
        ['generation.issuer_binding.created', 'generation.issuer_binding.reviewed']);

      // Omission must fail closed: every selected issuer-role material needs exactly one decision.
      await assert.rejects(appendGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash: suffixInputHash, requestId: `omitted-${suffix}`,
        reviewer, materialDecisions: decisions({ auditReview, financialReview, notesReview }).slice(0, 2),
      }), /DECISION_COVERAGE_MISMATCH/);

      // Browser labels and cross-account scope never authorize.
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: foreignOwner, projectId }, ref,
        { ...expectedInput, owner_user_id: foreignOwner }), null);
      // A different input revision/hash cannot reuse an approved binding.
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId }, ref,
        { ...expectedInput, input_revision: 2 }), null);
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId }, ref,
        { ...expectedInput, input_hash: sha('another-input') }), null);
      // A different binding content hash is never silently accepted.
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId },
        { ...ref, content_sha256: sha('tampered') }, expectedInput), null);

      // An unreviewed later observation makes the current identity coverage incomplete and blocks approval.
      await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId: auditId, materialVersion: 1,
        requestId: `unreviewed-${suffix}`, sourceRecordId: auditEvidence, issuerDisplayName: '合成发行人甲',
        entityId: `issuer-name:v1:${sha('合成发行人甲').slice(0, 32)}`,
      });
      const incomplete = await appendGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash: suffixInputHash, requestId: `incomplete-${suffix}`,
        reviewer, materialDecisions: decisions({ auditReview, financialReview, notesReview }),
      });
      await assert.rejects(reviewGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, bindingId: incomplete.bindingId, version: incomplete.version, contentSha256: incomplete.contentSha256,
        requestId: `incomplete-approve-${suffix}`, action: 'approve', reason: '主体观察未全部审核。', reviewer,
      }), /NOT_CURRENTLY_APPROVABLE/);
      const changedRequest = decisions({ auditReview, financialReview, notesReview });
      changedRequest[0] = { ...changedRequest[0]!, reason: '不同请求内容不应复用同一个 request id。' };
      await assert.rejects(appendGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash: suffixInputHash, requestId: `binding-request-${suffix}`,
        reviewer, materialDecisions: changedRequest,
      }), /IDEMPOTENCY_CONFLICT/, 'a replayed request id with a different payload conflicts');

      // Withdrawal is terminal and blocks reuse of the approved version.
      const withdrawn = await reviewGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version, contentSha256: ref.content_sha256,
        requestId: `withdraw-${suffix}`, action: 'withdraw', reason: '材料撤回后需重新审核。', reviewer,
      });
      assert.equal(withdrawn.status, 'withdrawn');
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId }, ref, expectedInput), null);
      await assert.rejects(reviewGenerationIssuerBinding(bindingDeps, {
        ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version, contentSha256: ref.content_sha256,
        requestId: `reapprove-${suffix}`, action: 'approve', reason: '不能复活已撤回版本。', reviewer,
      }), /TRANSITION_INVALID/);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });

test('synthetic PostgreSQL: an approved generation issuer binding fails closed on subject conflict and stale sources',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const scopedPool = savepointPool(connection);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `gib2-owner-${suffix}`, reviewerId = `gib2-reviewer-${suffix}`, grantorId = `gib2-grantor-${suffix}`;
    const projectId = `gib2-project-${suffix}`, grantId = `gib2-grant-${suffix}`;
    const auditId = `gib2-audit-${suffix}`, financialId = `gib2-financial-${suffix}`;
    const auditEvidence = `gib2-audit-evidence-${suffix}`, financialEvidence = `gib2-financial-evidence-${suffix}`;
    const inputHash = sha(`gib2-input-${suffix}`);
    const parserVersion = `parser-${suffix}`;

    const createMaterial = async (id: string, role: 'audit' | 'financial', evidence: EvidenceSpec[]) => {
      const contentHash = sha(`material-bytes-${id}`), uploadId = `upload-${id}`, snapshotId = `snapshot-${id}`;
      await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',10,$4,$5,$6,now()+interval '1 hour','completed',$4,10)`,
      [uploadId, owner, projectId, contentHash, role, `synthetic/${uploadId}`]);
      await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',10,$6,$7,'parsed')`,
      [id, owner, projectId, uploadId, role, contentHash, `users/${owner}/projects/${projectId}/materials/${id}`]);
      const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${snapshotId}`, status: 'parsed',
        parser_version: parserVersion, material: { material_id: id, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,$9,$10::jsonb)`,
      [snapshotId, owner, projectId, id, contentHash, parserVersion, sha(`parse-request-${snapshotId}`),
        sha(`parse-response-${snapshotId}`), evidence.length, JSON.stringify(meta)]);
      for (const [ordinal, item] of evidence.entries()) {
        await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
          locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
          VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic test evidence','native_text',$9,0.99,'[]','{}',$10,$11)`,
        [owner, projectId, id, snapshotId, item.recordId, contentHash,
          JSON.stringify({ page: ordinal + 1, bbox: [0, 0, 1, 1] }), item.quote, parserVersion, sha(item.recordId), ordinal]);
      }
      return { snapshotId, contentHash };
    };
    const deps: GenerationIssuerBindingDependencies = { pool: scopedPool, newId: randomUUID };
    const expectedInput = { owner_user_id: owner, project_id: projectId, input_revision: 1, input_hash: inputHash };

    try {
      await connection.query('BEGIN');
      for (const [id, username] of [[owner, 'gib2owner'], [reviewerId, 'gib2reviewer'], [grantorId, 'gib2grantor']] as const) {
        await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `${username}${suffix}`]);
      }
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision)
        VALUES($1,$2,'Synthetic generation 2','generation','Browser supplied name','sse','private',1)`, [projectId, owner]);
      const manifest = { draft_revision: 1, kind: 'generation', materials: [
        { material_id: auditId, material_version: 1, role: 'audit', sha256: sha(`material-bytes-${auditId}`) },
        { material_id: financialId, material_version: 1, role: 'financial', sha256: sha(`material-bytes-${financialId}`) },
      ] };
      await connection.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]')`,
      [projectId, owner, inputHash, JSON.stringify(manifest),
        JSON.stringify(manifest.materials.map(material => ({ material_id: material.material_id, material_version: material.material_version })))]);
      await createMaterial(auditId, 'audit', [{ recordId: auditEvidence, quote: '合成发行人甲合并资产负债表' }]);
      await createMaterial(financialId, 'financial', [{ recordId: financialEvidence, quote: '合成发行人乙母公司资产负债表' }]);
      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [grantId, reviewerId, grantorId, owner, projectId]);
      const reviewer = (await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, { ownerUserId: owner, projectId }))!;
      const bindIdentityReview = async (materialId: string, sourceRecordId: string, entityId: string) => {
        const record = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
          ownerUserId: owner, projectId, materialId, materialVersion: 1,
          requestId: `request-${sourceRecordId}`, sourceRecordId, issuerDisplayName: entityId,
          entityId: `issuer-name:v1:${sha(entityId).slice(0, 32)}`,
        });
        return (await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
          ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: record.id, reviewer,
          decision: 'verified', reasonCode: 'synthetic_verified', verifiedEntityId: entityId,
          entityBasisKind: 'manual_attestation', entityBasisRef: 'synthetic identity review',
        })).reviewId;
      };
      const auditReview = await bindIdentityReview(auditId, auditEvidence, entityA);
      const financialReview = await bindIdentityReview(financialId, financialEvidence, entityB);
      await assert.rejects(appendGenerationIssuerBinding(deps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash, requestId: `conflict-${suffix}`, reviewer,
        materialDecisions: [
          { material_id: auditId, material_version: 1, disposition: 'classified', reason: '合并编制主体。',
            observations: [{ source_record_id: auditEvidence, observed_subject_label: '甲', evidence_context: 'financial_statement',
              subject_relation: 'issuer_compiler', accounting_scope: 'consolidated', relation_reason: '合并编制主体。', source_identity_review_id: auditReview }] },
          { material_id: financialId, material_version: 1, disposition: 'classified', reason: '另一主体。',
            observations: [{ source_record_id: financialEvidence, observed_subject_label: '乙', evidence_context: 'financial_statement',
              subject_relation: 'issuer_compiler', accounting_scope: 'parent', relation_reason: '另一主体。', source_identity_review_id: financialReview }] },
        ],
      }), /SUBJECT_CONFLICT/, 'compiler observations of distinct legal entities never resolve to one issuer');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });

test('synthetic PostgreSQL: generation issuer binding consumer uses only the exact approved subject',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const scopedPool = savepointPool(connection);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const seam: GenerationIssuerBindingSeam = { provider: { provide: async () => null } };
    try {
      await connection.query('BEGIN');
      const state = await provisionApprovedBinding({ connection, scopedPool, suffix, label: 'consume' });
      const approved = await consumeGenerationIssuerBinding(scopedPool, { ownerUserId: state.owner, projectId: state.projectId },
        { provider: { provide: async () => state.ref } }, state.expectedInput);
      assert.equal(approved.status, 'approved');
      if (approved.status === 'approved') {
        assert.equal(approved.issuer_entity_id, entityA);
        assert.equal(approved.binding.content_sha256, state.ref.content_sha256);
      }
      // No explicit ref means fail closed, never a latest binding.
      assert.equal((await consumeGenerationIssuerBinding(scopedPool, { ownerUserId: state.owner, projectId: state.projectId },
        seam, state.expectedInput)).status, 'not_bound');
      // The same ref never authorizes another owner/project scope.
      assert.equal((await consumeGenerationIssuerBinding(scopedPool, { ownerUserId: `${state.owner}-foreign`, projectId: state.projectId },
        { provider: { provide: async () => state.ref } }, state.expectedInput)).status, 'not_bound');
      // Swapping or deleting a pinned material invalidates the consumed subject.
      await connection.query(`UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1`,
        [state.owner, state.projectId, state.auditId]);
      assert.equal((await consumeGenerationIssuerBinding(scopedPool, { ownerUserId: state.owner, projectId: state.projectId },
        { provider: { provide: async () => state.ref } }, state.expectedInput)).status, 'not_bound');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });

test('synthetic PostgreSQL: generation issuer binding hardening rejects scope, conflict and history edits',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const scopedPool = savepointPool(connection);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `hard-owner-${suffix}`, reviewerId = `hard-reviewer-${suffix}`, grantorId = `hard-grantor-${suffix}`;
    const projectId = `hard-project-${suffix}`, otherProjectId = `hard-other-project-${suffix}`;
    const otherGrantId = `hard-other-grant-${suffix}`;
    const auditId = `hard-audit-${suffix}`, notesId = `hard-notes-${suffix}`;
    const auditEvidence = `hard-audit-evidence-${suffix}`, notesEvidence = `hard-notes-evidence-${suffix}`;
    const inputHash = sha(`hard-input-${suffix}`);
    const parserVersion = `parser-${suffix}`;
    const deps: GenerationIssuerBindingDependencies = { pool: scopedPool, newId: randomUUID };

    try {
      await connection.query('BEGIN');
      for (const [id, username] of [[owner, 'hardowner'], [reviewerId, 'hardreviewer'], [grantorId, 'hardgrantor']] as const) {
        await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `${username}${suffix}`]);
      }
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision)
        VALUES($1,$2,'Synthetic hardening','generation','Browser supplied name','sse','private',1)`, [projectId, owner]);
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision)
        VALUES($1,$2,'Synthetic other project','generation','Browser supplied name','sse','private',1)`, [otherProjectId, owner]);
      const manifest = { draft_revision: 1, kind: 'generation', materials: [
        { material_id: auditId, material_version: 1, role: 'audit', sha256: sha(`material-bytes-${auditId}`) },
        { material_id: notesId, material_version: 1, role: 'notes', sha256: sha(`material-bytes-${notesId}`) },
      ] };
      await connection.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]')`,
      [projectId, owner, inputHash, JSON.stringify(manifest),
        JSON.stringify(manifest.materials.map(material => ({ material_id: material.material_id, material_version: material.material_version })))]);
      await insertSyntheticMaterial(connection, { owner, projectId, parserVersion,
        material: { id: auditId, role: 'audit', evidence: [{ recordId: auditEvidence, quote: '合成发行人甲合并资产负债表' }] } });
      await insertSyntheticMaterial(connection, { owner, projectId, parserVersion,
        material: { id: notesId, role: 'notes', evidence: [{ recordId: notesEvidence, quote: '本公司为合成发行人甲有限公司' }] } });
      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [`hard-grant-${suffix}`, reviewerId, grantorId, owner, projectId]);
      // A second grant scoped to a different project of the same owner must never authorize this project.
      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [otherGrantId, reviewerId, grantorId, owner, otherProjectId]);
      const reviewer = (await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, { ownerUserId: owner, projectId }))!;
      const otherReviewer = (await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, { ownerUserId: owner, projectId: otherProjectId }))!;
      assert.ok(reviewer && otherReviewer, 'both scoped grants authorize their own project');

      const addReview = async (materialId: string, recordId: string, entity: string) => {
        const record = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
          ownerUserId: owner, projectId, materialId, materialVersion: 1, requestId: `request-${recordId}`,
          sourceRecordId: recordId, issuerDisplayName: '合成发行人甲', entityId: `issuer-name:v1:${sha(entity).slice(0, 32)}`,
        });
        return (await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
          ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: record.id, reviewer,
          decision: 'verified', reasonCode: 'synthetic_verified', verifiedEntityId: entity,
          entityBasisKind: 'manual_attestation', entityBasisRef: 'synthetic identity review',
        })).reviewId;
      };
      const auditReview = await addReview(auditId, auditEvidence, entityA);
      const notesReview = await addReview(notesId, notesEvidence, entityA);
      const decisions = () => [
        { material_id: auditId, material_version: 1, disposition: 'classified' as const, reason: '合并编制主体。',
          observations: [{ source_record_id: auditEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'financial_statement' as const,
            subject_relation: 'issuer_compiler' as const, accounting_scope: 'consolidated' as const, relation_reason: '合并编制主体。', source_identity_review_id: auditReview }] },
        { material_id: notesId, material_version: 1, disposition: 'classified' as const, reason: '附注主体说明。',
          observations: [{ source_record_id: notesEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'identity_relationship' as const,
            subject_relation: 'issuer_compiler' as const, accounting_scope: 'not_applicable' as const, relation_reason: '附注主体说明。', source_identity_review_id: notesReview }] },
      ];

      // A reviewer scoped to a different project of the same owner cannot append or review under this project.
      await assert.rejects(appendGenerationIssuerBinding(deps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash, requestId: `wrong-scope-append-${suffix}`,
        reviewer: otherReviewer, materialDecisions: decisions(),
      }), /REVIEWER_NOT_AUTHORIZED/, 'a grant scoped to another project never authorizes this project');

      const appended = await appendGenerationIssuerBinding(deps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash, requestId: `hard-binding-${suffix}`,
        reviewer, materialDecisions: decisions(),
      });
      const ref = { binding_id: appended.bindingId, version: appended.version, content_sha256: appended.contentSha256 };
      const expectedInput = { owner_user_id: owner, project_id: projectId, input_revision: 1, input_hash: inputHash };
      await reviewGenerationIssuerBinding(deps, {
        ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version, contentSha256: ref.content_sha256,
        requestId: `hard-approve-${suffix}`, action: 'approve', reason: '逐项核验。', reviewer,
      });
      assert.ok(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId }, ref, expectedInput));

      await assert.rejects(reviewGenerationIssuerBinding(deps, {
        ownerUserId: owner, projectId, bindingId: ref.binding_id, version: ref.version, contentSha256: ref.content_sha256,
        requestId: `wrong-scope-review-${suffix}`, action: 'withdraw', reason: '越权。', reviewer: otherReviewer,
      }), /REVIEWER_NOT_AUTHORIZED/, 'the wrong-project reviewer cannot review this binding');

      // The binding is referenced by another owner/project combination only through its exact scope.
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId: otherProjectId }, ref, expectedInput),
        null, 'a binding is never loadable under a different project scope');

      // Re-verifying the same subject observation to a different entity is an unresolved conflict, not a silent supersession.
      const conflicting = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId: auditId, materialVersion: 1, requestId: `reobserve-${suffix}`,
        sourceRecordId: auditEvidence, issuerDisplayName: '合成发行人甲', entityId: `issuer-name:v1:${sha('合成发行人甲').slice(0, 32)}`,
      });
      await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId: auditId, materialVersion: 1, sourceRecordRowId: conflicting.id, reviewer,
        decision: 'verified', reasonCode: 'synthetic_verified', verifiedEntityId: entityB,
        entityBasisKind: 'manual_attestation', entityBasisRef: 'synthetic re-verification',
      });
      assert.equal(await loadApprovedGenerationIssuerBinding(scopedPool, { ownerUserId: owner, projectId }, ref, expectedInput),
        null, 'a re-verified conflicting entity invalidates the approved binding');
      const conflictAppend = await appendGenerationIssuerBinding(deps, {
        ownerUserId: owner, projectId, inputRevision: 1, inputHash, requestId: `conflict-reverify-${suffix}`,
        reviewer, materialDecisions: decisions(),
      });
      await assert.rejects(reviewGenerationIssuerBinding(deps, {
        ownerUserId: owner, projectId, bindingId: conflictAppend.bindingId, version: conflictAppend.version,
        contentSha256: conflictAppend.contentSha256, requestId: `conflict-reverify-approve-${suffix}`,
        action: 'approve', reason: '冲突未解决。', reviewer,
      }), /NOT_CURRENTLY_APPROVABLE/, 'an unresolved same-subject conflict blocks approval');

      // Append-only: the decision ledger and its review events can never be rewritten or deleted.
      const appendOnlyStatements: readonly [string, string, readonly unknown[]][] = [
        ['binding update', `UPDATE bb_generation_issuer_bindings SET issuer_entity_id=NULL WHERE id=$1`, [ref.binding_id]],
        ['binding delete', `DELETE FROM bb_generation_issuer_bindings WHERE id=$1`, [ref.binding_id]],
        ['review update', `UPDATE bb_generation_issuer_binding_reviews SET action='withdraw' WHERE binding_id=$1`, [ref.binding_id]],
        ['review delete', `DELETE FROM bb_generation_issuer_binding_reviews WHERE binding_id=$1`, [ref.binding_id]],
        ['binding truncate', `TRUNCATE bb_generation_issuer_bindings CASCADE`, []],
      ];
      for (const [label, statement, values] of appendOnlyStatements) {
        const point = `hard_append_only_${label.replaceAll(' ', '_')}`;
        await connection.query(`SAVEPOINT ${point}`);
        await assert.rejects(connection.query(statement, [...values]), /append-only/,
          `${label} must be rejected`);
        await connection.query(`ROLLBACK TO SAVEPOINT ${point}`);
        await connection.query(`RELEASE SAVEPOINT ${point}`);
      }
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });
