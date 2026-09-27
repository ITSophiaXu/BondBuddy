import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('ISSUER_ANNUAL_PROFILE_REVIEW_TEST_DATABASE_URL');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` :
  value !== null && typeof value === 'object' ? `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
    `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);

test('annual issuer-profile review routes require a trusted session and CSRF on decisions', async () => {
  let principal: { userId: string; csrfVerified: boolean } | null = null;
  const app = createServer({ allowedOrigin: 'http://bondbuddy.test', principal: async () => principal });
  try {
    const list = await app.inject({ method: 'GET', url: '/api/v1/reviewer/projects/synthetic-project/issuer-business-profiles',
      headers: { origin: 'http://bondbuddy.test' } });
    assert.equal(list.statusCode, 401);

    principal = { userId: 'synthetic-reviewer', csrfVerified: false };
    const decision = await app.inject({ method: 'POST', url: '/api/v1/projects/synthetic-project/issuer-business-profiles/synthetic-profile/review',
      headers: { origin: 'http://bondbuddy.test' }, payload: { request_id: 'synthetic-review', action: 'approve', reason: 'synthetic',
        reviewer_attestation: 'manual_source_evidence_review', profile_version: 1, profile_sha256: 'a'.repeat(64), input_revision: 1,
        input_hash: 'b'.repeat(64), source_material_sha256: 'c'.repeat(64), parse_snapshot_sha256: 'd'.repeat(64) } });
    assert.equal(decision.statusCode, 403);
    assert.equal(decision.json().code, 'CSRF_DENIED');
  } finally { await app.close(); }
});

test('PostgreSQL 16: reviewer GET lists exact parser evidence hashes and pinned issuer identity',
  { skip: !databaseUrl && 'set ISSUER_ANNUAL_PROFILE_REVIEW_TEST_DATABASE_URL to a migrated PostgreSQL 16 template through 0059' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const suffix = randomUUID().replaceAll('-', '');
    const owner = `annual-owner-${suffix}`, reviewer = `annual-reviewer-${suffix}`, grantor = `annual-grantor-${suffix}`;
    const project = `annual-project-${suffix}`, run = `annual-run-${suffix}`, material = `annual-material-${suffix}`;
    const upload = `annual-upload-${suffix}`, snapshot = `annual-parse-${suffix}`, profileId = `annual-profile-${suffix}`;
    const identityGrant = `annual-identity-grant-${suffix}`, identityRecord = `annual-identity-source-${suffix}`;
    const identityReviewer = `annual-identity-reviewer-${suffix}`, identityGrantor = `annual-identity-grantor-${suffix}`;
    const annualGrant = `annual-review-grant-${suffix}`, identityEvidence = `annual-evidence-identity-${suffix}`;
    const revenueEvidence = [`annual-evidence-total-${suffix}`, `annual-evidence-a-${suffix}`, `annual-evidence-b-${suffix}`, `annual-evidence-c-${suffix}`];
    const materialSha = 'a'.repeat(64), parseSha = 'b'.repeat(64), inputHash = 'c'.repeat(64), responseMeta = {
      schema_version: 'document-parse-response-v1', request_id: `${snapshot}-request`, parser_version: 'annual-parser-v1', status: 'parsed',
      material: { material_id: material, material_version: 1, media_type: 'application/pdf', sha256: materialSha },
      warnings: [], document: { page_count: 1 }, error: null,
    };
    const evidenceHash = Object.fromEntries([identityEvidence, ...revenueEvidence].map((id, index) => [id, sha(`evidence:${suffix}:${index}`)]));
    const entityId = 'uscc:91310000MA1FL00008';
    const identityContent = { ownerUserId: owner, projectId: project, materialId: material, materialVersion: 1, snapshotId: snapshot,
      sourceRecordId: identityEvidence, sourceRecordSha256: evidenceHash[identityEvidence], sourceContentSha256: materialSha,
      sourceLocatorType: 'pdf_bbox', sourceLocator: { page: 1 }, sourceQuote: 'Synthetic Issuer Ltd', issuerDisplayName: 'Synthetic Issuer Ltd',
      entityId: 'issuer-name:synthetic-annual', identityVersion: 1 };
    const identityHash = sha(stable(identityContent));
    const identityBinding = { status: 'verified', record_id: identityRecord, version: 1, content_hash: identityHash, entity_id: entityId,
      issuer_display_name: 'Synthetic Issuer Ltd', material_id: material, material_version: 1, source_snapshot_id: snapshot,
      source_record_id: identityEvidence, source_record_sha256: evidenceHash[identityEvidence], source_content_sha256: materialSha,
      reviewed_by: identityReviewer, reviewed_at: '2026-09-28T00:00:00.000Z' };
    const sourceEvidence = revenueEvidence[0]!;
    const profile = { issuerId: entityId, profileVersion: '1', taxonomyVersion: 'taxonomy-synthetic-v1', fiscalYear: 2025,
      completeAnnualPeriod: true, latestCompleteAnnual: true, verificationStatus: 'pending', accountingScope: 'consolidated',
      revenueBasis: 'main_business_revenue', currency: 'CNY', unit: 'yuan', allComparableBusinessLinesPresent: true,
      sourceEvidence: [sourceEvidence], lines: ['A', 'B', 'C'].map((code, index) => ({ code, label: `Synthetic ${code}`,
        originalLabel: `原始业务${code}`, revenue: String(300 - index * 100), rank: index + 1,
        evidence: [revenueEvidence[index + 1]!], classificationEvidence: [sourceEvidence] })) };
    const evidenceRefs = [...new Set([sourceEvidence, ...revenueEvidence.slice(1), revenueEvidence[3]!])].sort();
    const manifest = { issuer_identity: identityBinding, materials: [{ material_id: material, material_version: 1, sha256: materialSha }] };
    const app = createServer({ pool, allowedOrigin: 'http://bondbuddy.test', principal: async () => ({ userId: reviewer, csrfVerified: true }) });
    try {
      await pool.query(`INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4),($5,$6),($7,$8)`,
        [owner, `own_${suffix.slice(0,20)}`, reviewer, `rev_${suffix.slice(0,20)}`, grantor, `grt_${suffix.slice(0,20)}`,
          identityReviewer, `idv_${suffix.slice(0,20)}`]);
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic annual review','update')`, [project, owner]);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'annual.pdf','application/pdf',20,$4,'audit',$5,now()+interval '1 hour','completed')`,
        [upload, owner, project, materialSha, `synthetic/${suffix}/annual`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'audit','annual.pdf','application/pdf',20,$5,$6,'parsed')`,
        [material, owner, project, upload, materialSha, `users/${owner}/projects/${project}/annual`]);
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        request_options,response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,'annual-parser-v1',$6,'{}','parsed','document-parse-response-v1',$7,5,$8::jsonb)`,
        [snapshot, owner, project, material, materialSha, sha(`request:${suffix}`), parseSha, JSON.stringify(responseMeta)]);
      for (const [ordinal, recordId] of [identityEvidence, ...revenueEvidence].entries()) await pool.query(`INSERT INTO bb_parse_evidence
        (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,
         extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic annual source','native_text','annual-parser-v1',1,'[]','{}',$9,$10)`,
        [owner, project, material, snapshot, recordId, materialSha, JSON.stringify({ page: ordinal + 1 }),
          ordinal === 0 ? 'Synthetic Issuer Ltd' : `Synthetic annual evidence ${ordinal}`, evidenceHash[recordId], ordinal]);
      await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test','synthetic fixture',$4,$5)`,
        [identityGrant, identityReviewer, grantor, owner, project]);
      await pool.query(`INSERT INTO bb_issuer_identity_source_records(id,owner_user_id,project_id,material_id,material_version,snapshot_id,source_record_id,
        source_record_sha256,source_content_sha256,source_locator_type,source_locator,source_quote,issuer_display_name,entity_id,identity_version,
        request_id,request_hash,content_sha256)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'pdf_bbox','{"page":1}','Synthetic Issuer Ltd','Synthetic Issuer Ltd',
        'issuer-name:synthetic-annual',1,$9,$10,$11)`,
        [identityRecord, owner, project, material, snapshot, identityEvidence, evidenceHash[identityEvidence], materialSha,
          `identity-${suffix}`, sha(`identity-request:${suffix}`), identityHash]);
      await pool.query(`INSERT INTO bb_issuer_identity_source_reviews(id,owner_user_id,project_id,material_id,material_version,source_record_id,
        identity_version,content_sha256,entity_id,reviewer_user_id,reviewer_grant_id,decision,reason_code,verified_entity_id,entity_basis_kind,entity_basis_ref)
        VALUES($1,$2,$3,$4,1,$5,1,$6,'issuer-name:synthetic-annual',$7,$8,'verified','synthetic_test',$9,'uscc',$10)`,
        [`identity-review-${suffix}`, owner, project, material, identityRecord, identityHash, identityReviewer, identityGrant,
          entityId, '91310000MA1FL00008']);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]')`,
        [project, owner, inputHash, JSON.stringify(manifest), JSON.stringify([{ material_id: material, material_version: 1 }])]);
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,1,$4,$5,'update',$4,'preparing')`, [run, owner, project, inputHash, `run-request-${suffix}`]);
      await pool.query(`INSERT INTO bb_issuer_business_profiles(id,owner_user_id,project_id,run_id,input_revision,input_hash,source_material_id,
        source_material_version,profile_version,request_id,request_hash,profile,profile_sha256,evidence_refs,review_status,source_material_sha256,
        parse_snapshot_id,parse_snapshot_sha256,evidence_record_hashes,annual_revenue_basis,annual_revenue_total,annual_revenue_total_evidence,third_place_tie_proof)
        VALUES($1,$2,$3,$4,1,$5,$6,1,1,$7,$8,$9::jsonb,$10,$11::jsonb,'pending_review',$12,$13,$14,$15::jsonb,$16::jsonb,'600',$17::jsonb,$18::jsonb)`,
        [profileId, owner, project, run, inputHash, material, `profile-${suffix}`, sha(`profile-request:${suffix}`), JSON.stringify(profile),
          sha(stable(profile)), JSON.stringify(evidenceRefs), materialSha, snapshot, parseSha, JSON.stringify(Object.fromEntries(evidenceRefs.map(id => [id, evidenceHash[id]]))),
          JSON.stringify({ fiscalYear: 2025, accountingScope: 'consolidated', revenueBasis: 'main_business_revenue', currency: 'CNY', unit: 'yuan' }),
          JSON.stringify([sourceEvidence]), JSON.stringify({ status: 'clear', thresholdRevenue: '100', tiedBusinessCodes: ['C'], evidence: [revenueEvidence[3]] })]);
      await pool.query(`INSERT INTO bb_issuer_annual_profile_reviewer_grants(id,user_id,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,$3,'synthetic_test','synthetic fixture only',$4,$5)`, [annualGrant, reviewer, grantor, owner, project]);

      const response = await app.inject({ method: 'GET', url: `/api/v1/reviewer/projects/${project}/issuer-business-profiles`,
        headers: { origin: 'http://bondbuddy.test' } });
      assert.equal(response.statusCode, 200, response.body);
      const item = response.json().items[0];
      assert.equal(item.profile_id, profileId);
      assert.equal(item.issuer_identity_record_id, identityRecord);
      assert.equal(item.issuer_identity_hash, identityHash);
      assert.deepEqual(item.source_evidence.map((evidence: { record_id: string; record_sha256: string }) => evidence.record_id).sort(), evidenceRefs);
      assert.deepEqual(Object.fromEntries(item.source_evidence.map((evidence: { record_id: string; record_sha256: string }) =>
        [evidence.record_id, evidence.record_sha256])), evidenceHashForRefs(evidenceRefs, evidenceHash));
      assert.equal(item.latest_decision, 'pending_review');
      const otherAccount = await app.inject({ method: 'GET', url: '/api/v1/reviewer/projects/unknown-project/issuer-business-profiles',
        headers: { origin: 'http://bondbuddy.test' } });
      assert.equal(otherAccount.statusCode, 404, 'grantless/foreign project scope remains hidden');
    } finally { await app.close(); await pool.end(); }
  });

function evidenceHashForRefs(refs: string[], hashes: Record<string, string>) {
  return Object.fromEntries(refs.map(ref => [ref, hashes[ref]]));
}
