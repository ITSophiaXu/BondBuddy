import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import {
  appendIssuerBusinessProfile,
  getPendingIssuerBusinessProfile,
  loadReviewedIssuerAnnualProfile,
  type IssuerBusinessProfileClient,
  type IssuerBusinessProfileDependencies,
  type IssuerBusinessProfilePool,
} from './issuer-profile-repository.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('ISSUER_BUSINESS_PROFILE_TEST_DATABASE_URL');
const owner = 'issuer-profile-owner-synthetic';
const project = 'issuer-profile-project-synthetic';
const run = 'issuer-profile-run-synthetic';
const material = 'issuer-profile-material-synthetic';
const inputHash = 'a'.repeat(64);
const syntheticTargetEntity = 'entity:00000000-0000-4000-8000-000000000001';
const identitySourceEvidenceHash = 'f'.repeat(64);
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
          .join(',')}}`
      : JSON.stringify(value);
const mockIdentityContent = {
  ownerUserId: owner,
  projectId: project,
  materialId: material,
  materialVersion: 1,
  snapshotId: 'issuer-parse-snapshot',
  sourceRecordId: 'issuer-identity-source-record',
  sourceRecordSha256: identitySourceEvidenceHash,
  sourceContentSha256: 'c'.repeat(64),
  sourceLocatorType: 'pdf_bbox',
  sourceLocator: { page: 1 },
  sourceQuote: 'Synthetic Issuer Ltd',
  issuerDisplayName: 'Synthetic Issuer Ltd',
  entityId: 'issuer-name:synthetic',
  identityVersion: 1,
};
const mockIdentityHash = createHash('sha256').update(stable(mockIdentityContent)).digest('hex');
const evidenceRefs = [
  'issuer-evidence-source',
  'issuer-evidence-a',
  'issuer-evidence-b',
  'issuer-evidence-c',
];
const annualRevenueProof = {
  basis: {
    fiscalYear: 2025,
    accountingScope: 'consolidated' as const,
    revenueBasis: 'main_business_revenue' as const,
    currency: 'CNY',
    unit: 'yuan',
  },
  total: '600',
  totalEvidence: [evidenceRefs[0]!],
  thirdPlaceTieProof: {
    status: 'clear' as const,
    thresholdRevenue: '100',
    tiedBusinessCodes: ['C'],
    evidence: [evidenceRefs[3]!],
  },
};

function profile(overrides: Partial<AnnualBusinessProfile> = {}): AnnualBusinessProfile {
  return {
    issuerId: syntheticTargetEntity,
    profileVersion: 'caller-version-is-ignored',
    taxonomyVersion: 'taxonomy-synthetic-v1',
    fiscalYear: 2025,
    completeAnnualPeriod: true,
    latestCompleteAnnual: true,
    verificationStatus: 'verified',
    accountingScope: 'consolidated',
    revenueBasis: 'main_business_revenue',
    currency: 'CNY',
    unit: 'yuan',
    allComparableBusinessLinesPresent: true,
    sourceEvidence: [evidenceRefs[0]!],
    lines: ['A', 'B', 'C'].map((code, index) => ({
      code,
      label: `Synthetic ${code}`,
      originalLabel: `原始业务${code}`,
      revenue: String(300 - index * 100),
      rank: index + 1,
      evidence: [evidenceRefs[index + 1]!],
      classificationEvidence: [evidenceRefs[0]!],
    })),
    ...overrides,
  };
}

const scope = { ownerUserId: owner, projectId: project, runId: run, inputRevision: 1, inputHash };
const appendInput = (overrides: Record<string, unknown> = {}) => ({
  ...scope,
  requestId: 'issuer-request-synthetic',
  sourceMaterialId: material,
  sourceMaterialVersion: 1,
  profile: profile(),
  annualRevenueProof,
  ...overrides,
});

class MockClient implements IssuerBusinessProfileClient {
  calls: { sql: string; values: unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];
  outbox: Record<string, unknown>[] = [];
  knownEvidence = new Set(evidenceRefs);
  sourceExists = true;
  materialRole = 'audit';
  recordHashes = Object.fromEntries(evidenceRefs.map((ref) => [ref, 'e'.repeat(64)]));
  failOutbox = false;
  private before: { rows: Record<string, unknown>[]; outbox: Record<string, unknown>[] } | null =
    null;
  released = false;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') {
      this.before = { rows: structuredClone(this.rows), outbox: structuredClone(this.outbox) };
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      this.before = null;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (this.before) {
        this.rows = this.before.rows;
        this.outbox = this.before.outbox;
      }
      this.before = null;
      return { rows: [] };
    }
    if (sql.includes('FROM bb_runs r') && sql.includes('FOR UPDATE OF i')) {
      return {
        rows:
          this.sourceExists &&
          values[0] === owner &&
          values[1] === project &&
          values[2] === run &&
          values[3] === 1 &&
          values[6] === inputHash
            ? [
                {
                  id: run,
                  input_revision: 1,
                  input_hash: inputHash,
                  material_versions: [{ material_id: material, material_version: 1 }],
                  role: this.materialRole,
                  source_material_sha256: 'c'.repeat(64),
                  manifest: {
                    issuer_identity: {
                      status: 'verified',
                      entity_id: syntheticTargetEntity,
                      record_id: 'issuer-identity-source-record',
                      version: 1,
                      content_hash: mockIdentityHash,
                      material_id: material,
                      material_version: 1,
                      source_snapshot_id: 'issuer-parse-snapshot',
                      source_record_id: 'issuer-identity-source-record',
                      source_record_sha256: identitySourceEvidenceHash,
                    },
                  },
                },
              ]
            : [],
      };
    }
    if (sql.includes('FROM bb_parse_snapshots'))
      return {
        rows: [
          {
            id: 'issuer-parse-snapshot',
            response_sha256: 'd'.repeat(64),
            response_status: 'parsed',
          },
        ],
      };
    if (
      sql.includes('FROM bb_issuer_identity_source_records r') &&
      sql.includes('ORDER BY r.identity_version DESC')
    )
      return {
        rows: [
          {
            id: 'issuer-identity-source-record',
            owner_user_id: owner,
            project_id: project,
            material_id: material,
            material_version: 1,
            snapshot_id: 'issuer-parse-snapshot',
            source_record_id: 'issuer-identity-source-record',
            source_record_sha256: identitySourceEvidenceHash,
            source_content_sha256: 'c'.repeat(64),
            source_locator_type: 'pdf_bbox',
            source_locator: { page: 1 },
            source_quote: 'Synthetic Issuer Ltd',
            issuer_display_name: 'Synthetic Issuer Ltd',
            entity_id: 'issuer-name:synthetic',
            identity_version: 1,
            request_id: 'issuer-identity-request',
            request_hash: 'b'.repeat(64),
            content_sha256: mockIdentityHash,
            state: 'needs_review',
            review_decision: 'verified',
            decision: 'verified',
            verified_entity_id: syntheticTargetEntity,
            entity_basis_kind: 'manual_attestation',
            entity_basis_ref: 'synthetic test fixture',
            reviewer_user_id: 'issuer-profile-reviewer-synthetic',
            active_grant_id: 'issuer-identity-grant-synthetic',
            reviewed_at: new Date('2026-09-25T00:00:00Z'),
            created_at: new Date('2026-09-25T00:00:00Z'),
          },
        ],
      };
    if (sql.includes('count(DISTINCT rv.verified_entity_id)'))
      return { rows: [{ distinct_entities: 1 }] };
    if (sql.includes('FROM bb_parse_evidence e'))
      return {
        rows: (values.at(-1) as string[])
          .filter((ref) => this.knownEvidence.has(ref))
          .map((record_id) => ({ record_id, record_sha256: this.recordHashes[record_id] })),
      };
    if (sql.includes('FROM bb_issuer_business_profiles') && sql.includes('request_id=$4'))
      return {
        rows: this.rows.filter(
          (row) =>
            row.owner_user_id === values[0] &&
            row.project_id === values[1] &&
            row.run_id === values[2] &&
            row.request_id === values[3],
        ),
      };
    if (sql.includes('max(profile_version)'))
      return {
        rows: [
          {
            profile_version: this.rows.length
              ? Math.max(...this.rows.map((row) => Number(row.profile_version)))
              : 0,
          },
        ],
      };
    if (sql.startsWith('INSERT INTO bb_issuer_business_profiles')) {
      const profileValue = JSON.parse(String(values[11])) as Record<string, unknown>;
      const row = {
        id: values[0],
        owner_user_id: values[1],
        project_id: values[2],
        run_id: values[3],
        input_revision: values[4],
        input_hash: values[5],
        source_material_id: values[6],
        source_material_version: values[7],
        profile_version: values[8],
        request_id: values[9],
        request_hash: values[10],
        profile: profileValue,
        profile_sha256: values[12],
        evidence_refs: JSON.parse(String(values[13])) as string[],
        review_status: 'pending_review',
        created_at: new Date('2026-09-25T00:00:00Z'),
        source_material_sha256: values[14],
        parse_snapshot_id: values[15],
        parse_snapshot_sha256: values[16],
        evidence_record_hashes: JSON.parse(String(values[17])),
        annual_revenue_basis: JSON.parse(String(values[18])),
        annual_revenue_total: values[19],
        annual_revenue_total_evidence: JSON.parse(String(values[20])),
        third_place_tie_proof: JSON.parse(String(values[21])),
      };
      this.rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.outbox.push({
        id: values[0],
        owner_user_id: values[1],
        aggregate_id: values[2],
        event_type: 'issuer.business_profile.pending_review',
      });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  release(): void {
    this.released = true;
  }
}

function dependencies(client: MockClient): IssuerBusinessProfileDependencies {
  let id = 0;
  return {
    pool: { connect: async () => client, query: (sql, values) => client.query(sql, values) },
    newId: () => `issuer-id-${++id}`,
  };
}

test('append snapshots bind owner/run/input/material and force every caller status to pending review', async () => {
  const client = new MockClient();
  const deps = dependencies(client);
  const callerProfile = profile({ verificationStatus: 'verified', profileVersion: '999' });
  const first = await appendIssuerBusinessProfile(deps, appendInput({ profile: callerProfile }));
  assert.equal(first.reviewStatus, 'pending_review');
  assert.equal(first.profile.verificationStatus, 'pending');
  assert.equal(first.profile.profileVersion, '1');
  assert.equal(first.profileSha256.length, 64);
  assert.deepEqual(first.evidenceRefs, [...evidenceRefs].sort());
  assert.equal(client.rows.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.equal(client.released, true);
  assert.match(
    client.calls.find((call) => call.sql.includes('FROM bb_runs r'))!.sql,
    /r\.owner_user_id=\$1 AND r\.project_id=\$2 AND r\.id=\$3 AND r\.input_revision=\$4 AND r\.input_hash=\$7/,
  );
  assert.match(
    client.calls.find((call) => call.sql.includes('FROM bb_parse_evidence e'))!.sql,
    /e\.owner_user_id=\$1 AND e\.project_id=\$2 AND e\.material_id=\$3 AND e\.material_version=\$4/,
  );

  const replay = await appendIssuerBusinessProfile(
    deps,
    appendInput({ profile: { ...callerProfile, verificationStatus: 'rejected' } }),
  );
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);
  assert.equal(client.rows.length, 1);
  await assert.rejects(
    appendIssuerBusinessProfile(
      deps,
      appendInput({
        profile: profile({
          lines: [{ ...profile().lines[0]!, revenue: '301' }, ...profile().lines.slice(1)],
        }),
        annualRevenueProof: { ...annualRevenueProof, total: '601' },
      }),
    ),
    /ISSUER_PROFILE_IDEMPOTENCY_CONFLICT/,
  );
});

test('does not accept fabricated review fields, foreign sources or unbound evidence; outbox failure rolls back', async () => {
  const client = new MockClient();
  const deps = dependencies(client);
  await assert.rejects(
    appendIssuerBusinessProfile(
      deps,
      appendInput({ profile: { ...profile(), reviewStatus: 'reviewed' } }),
    ),
    /INVALID_ISSUER_ANNUAL_BUSINESS_PROFILE/,
  );
  client.sourceExists = false;
  await assert.rejects(
    appendIssuerBusinessProfile(deps, appendInput({ requestId: 'missing-run' })),
    /ISSUER_PROFILE_RUN_OR_SOURCE_NOT_FOUND/,
  );
  await assert.rejects(
    appendIssuerBusinessProfile(
      deps,
      appendInput({ requestId: 'wrong-input-hash', inputHash: 'b'.repeat(64) }),
    ),
    /ISSUER_PROFILE_RUN_OR_SOURCE_NOT_FOUND/,
  );
  client.sourceExists = true;
  client.materialRole = 'historical';
  await assert.rejects(
    appendIssuerBusinessProfile(deps, appendInput({ requestId: 'wrong-source-role' })),
    /ISSUER_PROFILE_SOURCE_NOT_FINANCIAL/,
  );
  client.materialRole = 'audit';
  client.knownEvidence.delete(evidenceRefs[2]!);
  await assert.rejects(
    appendIssuerBusinessProfile(deps, appendInput({ requestId: 'wrong-source-evidence' })),
    /ISSUER_PROFILE_EVIDENCE_NOT_IN_LATEST_PARSE_SNAPSHOT/,
  );
  client.knownEvidence.add(evidenceRefs[2]!);
  client.failOutbox = true;
  await assert.rejects(
    appendIssuerBusinessProfile(deps, appendInput({ requestId: 'outbox-failure' })),
    /synthetic outbox failure/,
  );
  assert.equal(client.rows.length, 0);
  assert.equal(client.outbox.length, 0);
});

test('complete revenue universe marks only a top-three boundary-crossing tie unresolved', async () => {
  const client = new MockClient();
  const deps = dependencies(client);
  await assert.rejects(
    appendIssuerBusinessProfile(
      deps,
      appendInput({
        requestId: 'wrong-total',
        annualRevenueProof: {
          ...annualRevenueProof,
          total: '599',
        },
      }),
    ),
    /ISSUER_PROFILE_ANNUAL_REVENUE_TOTAL_OR_RANK_MISMATCH/,
  );
  const cases = [
    {
      name: 'internal second/third tie',
      amounts: ['100', '50', '50', '10'],
      status: 'clear' as const,
      tied: ['B', 'C'],
    },
    {
      name: 'all three rows tied',
      amounts: ['50', '50', '50'],
      status: 'clear' as const,
      tied: ['A', 'B', 'C'],
    },
    {
      name: 'third/fourth boundary tie',
      amounts: ['100', '80', '50', '50'],
      status: 'unresolved' as const,
      tied: ['C', 'D'],
    },
  ];
  for (const [index, item] of cases.entries()) {
    const lines = item.amounts.map((revenue, lineIndex) => ({
      code: String.fromCharCode(65 + lineIndex),
      label: `Synthetic ${String.fromCharCode(65 + lineIndex)}`,
      originalLabel: `原始业务${String.fromCharCode(65 + lineIndex)}`,
      revenue,
      rank: lineIndex + 1,
      evidence: [evidenceRefs[(lineIndex % 3) + 1]!],
      classificationEvidence: [evidenceRefs[0]!],
    }));
    const threshold = [...item.amounts].sort((a, b) => Number(b) - Number(a))[2]!;
    const inputProfile = profile({ lines });
    const proof = {
      ...annualRevenueProof,
      total: item.amounts.reduce((sum, value) => sum + Number(value), 0).toString(),
      totalEvidence: [evidenceRefs[0]!],
      thirdPlaceTieProof: {
        status: item.status,
        thresholdRevenue: threshold,
        tiedBusinessCodes: item.tied,
        evidence: [evidenceRefs[3]!],
      },
    };
    const stored = await appendIssuerBusinessProfile(
      deps,
      appendInput({ requestId: `tie-${index}`, profile: inputProfile, annualRevenueProof: proof }),
    );
    assert.equal(stored.reviewStatus, 'pending_review', item.name);
    assert.equal(stored.annualRevenueProof.thirdPlaceTieProof.status, item.status, item.name);
  }
  const invalidBoundary = profile({
    lines: ['100', '80', '50', '50'].map((revenue, index) => ({
      code: String.fromCharCode(65 + index),
      label: `Synthetic ${String.fromCharCode(65 + index)}`,
      originalLabel: `原始业务${String.fromCharCode(65 + index)}`,
      revenue,
      rank: index + 1,
      evidence: [evidenceRefs[(index % 3) + 1]!],
      classificationEvidence: [evidenceRefs[0]!],
    })),
  });
  await assert.rejects(
    appendIssuerBusinessProfile(
      deps,
      appendInput({
        requestId: 'false-clear-boundary-tie',
        profile: invalidBoundary,
        annualRevenueProof: {
          ...annualRevenueProof,
          total: '280',
          thirdPlaceTieProof: {
            status: 'clear',
            thresholdRevenue: '50',
            tiedBusinessCodes: ['C', 'D'],
            evidence: [evidenceRefs[3]!],
          },
        },
      }),
    ),
    /ISSUER_PROFILE_THIRD_PLACE_TIE_PROOF_MISMATCH/,
  );
  assert.equal(
    await loadReviewedIssuerAnnualProfile(deps.pool, { ...scope, runId: 'no-review' }),
    null,
  );
});

test('pending profile read checks hash and generation loader never invents an authenticated reviewer', async () => {
  const client = new MockClient();
  const deps = dependencies(client);
  const stored = await appendIssuerBusinessProfile(deps, appendInput());
  const pool = deps.pool;
  // A test read adapter emulates the strict SQL scope join and exposes the inserted immutable row.
  pool.query = async (sql, values = []) => {
    assert.match(sql, /JOIN bb_runs r ON r\.owner_user_id=p\.owner_user_id/);
    return values[0] === owner &&
      values[1] === project &&
      values[2] === run &&
      values[3] === 1 &&
      values[4] === inputHash
      ? { rows: client.rows.slice(-1) }
      : { rows: [] };
  };
  const pending = await getPendingIssuerBusinessProfile(pool, scope);
  assert.equal(pending?.id, stored.id);
  assert.equal(
    pending?.profile.revenueBasis,
    'main_business_revenue',
    'the precise LIB-01A basis is retained',
  );
  assert.equal(await loadReviewedIssuerAnnualProfile(pool, scope), null);
  assert.equal(
    await getPendingIssuerBusinessProfile(pool, { ...scope, ownerUserId: 'foreign-owner' }),
    null,
  );
  const tampered = { ...client.rows[0]!, profile_sha256: 'f'.repeat(64) };
  pool.query = async () => ({ rows: [tampered] });
  await assert.rejects(
    getPendingIssuerBusinessProfile(pool, scope),
    /ISSUER_PROFILE_HASH_OR_STATUS_MISMATCH/,
  );
});

const liveUrl = testDatabaseUrl;
test(
  'PostgreSQL 16: input/run/material/evidence binding, append-only guard and pending-only storage',
  { skip: !liveUrl },
  async () => {
    const pool = new Pool({ connectionString: liveUrl });
    const connection = await pool.connect();
    const savepoint = `issuer_profile_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const liveOwner = `issuer-owner-${suffix}`,
      liveProject = `issuer-project-${suffix}`,
      liveRun = `issuer-run-${suffix}`;
    const liveMaterial = `issuer-material-${suffix}`,
      uploadId = `issuer-upload-${suffix}`;
    const identityReviewer = `issuer-reviewer-${suffix}`,
      identityGrantor = `issuer-grantor-${suffix}`;
    const identityRecordId = `issuer-identity-record-${suffix}`,
      identityGrantId = `issuer-identity-grant-${suffix}`;
    const entityId = `entity:00000000-0000-4000-8000-${suffix.padEnd(12, '0')}`;
    const sourceHash = 'c'.repeat(64),
      parserHash = 'd'.repeat(64),
      evidenceId = `issuer-evidence-${suffix}`;
    const liveInputHash = 'b'.repeat(64),
      parserId = `issuer-parser-${suffix}`;
    try {
      await connection.query('BEGIN');
      await connection.query(`SAVEPOINT ${savepoint}`);
      await connection.query(
        `INSERT INTO bb_users(id,phone_e164) VALUES($1,'+15550000001'),($2,'+15550000002'),($3,'+15550000003')`,
        [liveOwner, identityReviewer, identityGrantor],
      );
      await connection.query(
        `INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic issuer profile','update')`,
        [liveProject, liveOwner],
      );
      await connection.query(
        `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'audit.pdf','application/pdf',10,$4,'audit',$5,now()+interval '1 hour','completed')`,
        [uploadId, liveOwner, liveProject, sourceHash, `synthetic/${suffix}/upload`],
      );
      await connection.query(
        `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'audit','audit.pdf','application/pdf',10,$5,$6,'parsed')`,
        [
          liveMaterial,
          liveOwner,
          liveProject,
          uploadId,
          sourceHash,
          `users/${liveOwner}/projects/${liveProject}/audit`,
        ],
      );
      await connection.query(
        `INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test','synthetic test fixture',$4,$5)`,
        [identityGrantId, identityReviewer, identityGrantor, liveOwner, liveProject],
      );
      await connection.query(
        `INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'parser-issuer-synthetic-1',$6,'{}','parsed','document-parse-response-v1',$7,5,$8::jsonb)`,
        [
          parserId,
          liveOwner,
          liveProject,
          liveMaterial,
          sourceHash,
          parserHash,
          'e'.repeat(64),
          JSON.stringify({
            schema_version: 'document-parse-response-v1',
            request_id: `${parserId}-request`,
            parser_version: 'parser-issuer-synthetic-1',
            status: 'parsed',
            material: {
              material_id: liveMaterial,
              material_version: 1,
              media_type: 'application/pdf',
              sha256: sourceHash,
            },
            warnings: [],
            document: { page_count: 1 },
            error: null,
          }),
        ],
      );
      const identityEvidenceId = `${evidenceId}-identity`;
      const liveEvidenceIds = [
        identityEvidenceId,
        evidenceId,
        `${evidenceId}-a`,
        `${evidenceId}-b`,
        `${evidenceId}-c`,
      ];
      for (const [ordinal, recordId] of liveEvidenceIds.entries())
        await connection.query(
          `INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic','native_text','parser-issuer-synthetic-1',1,'[]','{}',$9,$10)`,
          [
            liveOwner,
            liveProject,
            liveMaterial,
            parserId,
            recordId,
            sourceHash,
            JSON.stringify({ page: ordinal + 1 }),
            ordinal === 0 ? 'Synthetic Issuer Ltd' : `synthetic evidence ${ordinal}`,
            'f'.repeat(63) + (ordinal + 1).toString(16),
            ordinal,
          ],
        );
      const identityEvidenceHash = 'f'.repeat(63) + '1';
      const identityContent = {
        ownerUserId: liveOwner,
        projectId: liveProject,
        materialId: liveMaterial,
        materialVersion: 1,
        snapshotId: parserId,
        sourceRecordId: identityEvidenceId,
        sourceRecordSha256: identityEvidenceHash,
        sourceContentSha256: sourceHash,
        sourceLocatorType: 'pdf_bbox',
        sourceLocator: { page: 1 },
        sourceQuote: 'Synthetic Issuer Ltd',
        issuerDisplayName: 'Synthetic Issuer Ltd',
        entityId: 'issuer-name:synthetic',
        identityVersion: 1,
      };
      const identityHash = createHash('sha256').update(stable(identityContent)).digest('hex');
      await connection.query(
        `INSERT INTO bb_issuer_identity_source_records(id,owner_user_id,project_id,material_id,material_version,snapshot_id,source_record_id,
      source_record_sha256,source_content_sha256,source_locator_type,source_locator,source_quote,issuer_display_name,entity_id,identity_version,request_id,request_hash,content_sha256)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'pdf_bbox','{"page":1}','Synthetic Issuer Ltd','Synthetic Issuer Ltd','issuer-name:synthetic',1,$9,$10,$11)`,
        [
          identityRecordId,
          liveOwner,
          liveProject,
          liveMaterial,
          parserId,
          identityEvidenceId,
          identityEvidenceHash,
          sourceHash,
          `identity-${suffix}`,
          'b'.repeat(64),
          identityHash,
        ],
      );
      await connection.query(
        `INSERT INTO bb_issuer_identity_source_reviews(id,owner_user_id,project_id,material_id,material_version,source_record_id,identity_version,content_sha256,entity_id,
      reviewer_user_id,reviewer_grant_id,decision,reason_code,verified_entity_id,entity_basis_kind,entity_basis_ref)
      VALUES($1,$2,$3,$4,1,$5,1,$6,'issuer-name:synthetic',$7,$8,'verified','synthetic_test',$9,'manual_attestation','authorized synthetic test identity')`,
        [
          `issuer-identity-review-${suffix}`,
          liveOwner,
          liveProject,
          liveMaterial,
          identityRecordId,
          identityHash,
          identityReviewer,
          identityGrantId,
          entityId,
        ],
      );
      const identityBinding = {
        status: 'verified',
        record_id: identityRecordId,
        version: 1,
        content_hash: identityHash,
        entity_id: entityId,
        issuer_display_name: 'Synthetic Issuer Ltd',
        material_id: liveMaterial,
        material_version: 1,
        source_snapshot_id: parserId,
        source_record_id: identityEvidenceId,
        source_record_sha256: identityEvidenceHash,
        source_content_sha256: sourceHash,
        reviewed_by: identityReviewer,
        reviewed_at: '2026-09-28T00:00:00Z',
      };
      const manifest = {
        issuer_identity: identityBinding,
        materials: [{ material_id: liveMaterial, material_version: 1, sha256: sourceHash }],
        target_confirmation: {
          status: 'confirmed',
          confirmed_by: liveOwner,
          target_reporting_periods: [
            {
              start: '2025-01-01',
              end: '2025-12-31',
              period_kind: 'annual',
              scope: 'consolidated',
              status: 'user_asserted',
              evidence_refs: [],
            },
          ],
        },
      };
      await connection.query(
        `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]')`,
        [
          liveProject,
          liveOwner,
          liveInputHash,
          JSON.stringify(manifest),
          JSON.stringify([{ material_id: liveMaterial, material_version: 1 }]),
        ],
      );
      await connection.query(
        `INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$5,'update',$6,'preparing')`,
        [liveRun, liveOwner, liveProject, liveInputHash, `execute-${suffix}`, liveInputHash],
      );
      const proxy: IssuerBusinessProfileClient = {
        query: async (sql, values) => {
          if (sql === 'BEGIN') return connection.query(`SAVEPOINT ${savepoint}_repository`, values);
          if (sql === 'COMMIT')
            return connection.query(`RELEASE SAVEPOINT ${savepoint}_repository`, values);
          if (sql === 'ROLLBACK')
            return connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}_repository`, values);
          return connection.query(sql, values);
        },
        release: () => undefined,
      };
      let profileIdSequence = 0;
      const liveDeps: IssuerBusinessProfileDependencies = {
        pool: { connect: async () => proxy, query: (sql, values) => connection.query(sql, values) },
        newId: () => `issuer-profile-${suffix}-${++profileIdSequence}`,
      };
      const liveProfile = profile({
        issuerId: entityId,
        sourceEvidence: [evidenceId],
        lines: ['A', 'B', 'C', 'D'].map((code, index) => ({
          code,
          label: `Synthetic ${code}`,
          originalLabel: `原始业务${code}`,
          revenue: ['100', '50', '50', '10'][index]!,
          rank: index + 1,
          evidence: [index < 3 ? liveEvidenceIds[index + 2]! : evidenceId],
          classificationEvidence: [evidenceId],
        })),
      });
      const saved = await appendIssuerBusinessProfile(liveDeps, {
        ownerUserId: liveOwner,
        projectId: liveProject,
        runId: liveRun,
        inputRevision: 1,
        inputHash: liveInputHash,
        requestId: `profile-${suffix}`,
        sourceMaterialId: liveMaterial,
        sourceMaterialVersion: 1,
        profile: liveProfile,
        annualRevenueProof: {
          ...annualRevenueProof,
          total: '210',
          totalEvidence: [evidenceId],
          thirdPlaceTieProof: {
            status: 'clear',
            thresholdRevenue: '50',
            tiedBusinessCodes: ['B', 'C'],
            evidence: [`${evidenceId}-c`],
          },
        },
      });
      assert.equal(saved.reviewStatus, 'pending_review');
      await assert.rejects(
        appendIssuerBusinessProfile(liveDeps, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          runId: liveRun,
          inputRevision: 1,
          inputHash: 'f'.repeat(64),
          requestId: `profile-wrong-hash-${suffix}`,
          sourceMaterialId: liveMaterial,
          sourceMaterialVersion: 1,
          profile: liveProfile,
          annualRevenueProof: {
            ...annualRevenueProof,
            total: '210',
            totalEvidence: [evidenceId],
            thirdPlaceTieProof: {
              status: 'clear',
              thresholdRevenue: '50',
              tiedBusinessCodes: ['B', 'C'],
              evidence: [`${evidenceId}-c`],
            },
          },
        }),
        /ISSUER_PROFILE_RUN_OR_SOURCE_NOT_FOUND/,
      );
      assert.equal(
        await loadReviewedIssuerAnnualProfile(liveDeps.pool, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          runId: liveRun,
          inputRevision: 1,
          inputHash: liveInputHash,
        }),
        null,
      );
      const profileGrantId = `annual-review-grant-${suffix}`;
      await connection.query(
        `INSERT INTO bb_issuer_annual_profile_reviewer_grants(id,user_id,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,$3,'synthetic_test','synthetic test-only reviewer authority',$4,$5)`,
        [profileGrantId, identityReviewer, identityGrantor, liveOwner, liveProject],
      );
      const reviewPins = [
        liveOwner,
        liveProject,
        liveRun,
        saved.id,
        saved.profileVersion,
        saved.profileSha256,
        1,
        liveInputHash,
        liveMaterial,
        1,
        sourceHash,
        parserId,
        'e'.repeat(64),
        identityRecordId,
        1,
        identityHash,
        entityId,
      ];
      await connection.query(
        `INSERT INTO bb_issuer_annual_profile_reviews(id,request_id,request_hash,owner_user_id,project_id,run_id,profile_id,
      profile_version,profile_sha256,input_revision,input_hash,source_material_id,source_material_version,source_material_sha256,
      parse_snapshot_id,parse_snapshot_sha256,issuer_identity_record_id,issuer_identity_version,issuer_identity_hash,verified_entity_id,
      action,reason,reviewer_attestation,reviewer_user_id,reviewer_grant_id)
      VALUES($18,$19,$20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'approve','synthetic test approval','manual_source_evidence_review',$21,$22)`,
        [
          ...reviewPins,
          `annual-review-${suffix}`,
          `approve-${suffix}`,
          '9'.repeat(64),
          identityReviewer,
          profileGrantId,
        ],
      );
      const approved = await loadReviewedIssuerAnnualProfile(liveDeps.pool, {
        ownerUserId: liveOwner,
        projectId: liveProject,
        runId: liveRun,
        inputRevision: 1,
        inputHash: liveInputHash,
      });
      assert.equal(approved?.verificationStatus, 'verified');
      assert.equal(
        (
          await connection.query(
            `SELECT bb_issuer_identity_profile_binding_current($1,$2,$3,1,$4,$5) AS current`,
            [liveOwner, liveProject, liveMaterial, identityRecordId, entityId],
          )
        ).rows[0]?.current,
        true,
        'SQL #15 twin accepts the same currently verified binding as the trusted reader',
      );
      await connection.query(
        `UPDATE bb_issuer_annual_profile_reviewer_grants SET revoked_at=now(),revoked_by=$2,
      revocation_reason_code='synthetic_test',revocation_basis='synthetic test revocation' WHERE id=$1`,
        [profileGrantId, identityGrantor],
      );
      assert.equal(
        await loadReviewedIssuerAnnualProfile(liveDeps.pool, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          runId: liveRun,
          inputRevision: 1,
          inputHash: liveInputHash,
        }),
        null,
        'revoking the reviewer grant invalidates the loader',
      );
      const replacementGrantId = `annual-review-grant-replacement-${suffix}`;
      await connection.query(
        `INSERT INTO bb_issuer_annual_profile_reviewer_grants(id,user_id,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,$3,'synthetic_test','synthetic replacement test-only reviewer authority',$4,$5)`,
        [replacementGrantId, identityReviewer, identityGrantor, liveOwner, liveProject],
      );
      await connection.query(
        `INSERT INTO bb_issuer_annual_profile_reviews(id,request_id,request_hash,owner_user_id,project_id,run_id,profile_id,
      profile_version,profile_sha256,input_revision,input_hash,source_material_id,source_material_version,source_material_sha256,
      parse_snapshot_id,parse_snapshot_sha256,issuer_identity_record_id,issuer_identity_version,issuer_identity_hash,verified_entity_id,
      action,reason,reviewer_attestation,reviewer_user_id,reviewer_grant_id)
      VALUES($18,$19,$20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'withdraw','synthetic test withdrawal','manual_source_evidence_review',$21,$22)`,
        [
          ...reviewPins,
          `annual-withdraw-${suffix}`,
          `withdraw-${suffix}`,
          '8'.repeat(64),
          identityReviewer,
          replacementGrantId,
        ],
      );
      assert.equal(
        await loadReviewedIssuerAnnualProfile(liveDeps.pool, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          runId: liveRun,
          inputRevision: 1,
          inputHash: liveInputHash,
        }),
        null,
        'latest withdrawal supersedes an older approval',
      );
      await connection.query(`SAVEPOINT ${savepoint}_withdrawn`);
      await assert.rejects(
        connection.query(
          `INSERT INTO bb_issuer_annual_profile_reviews(id,request_id,request_hash,owner_user_id,project_id,run_id,profile_id,
      profile_version,profile_sha256,input_revision,input_hash,source_material_id,source_material_version,source_material_sha256,
      parse_snapshot_id,parse_snapshot_sha256,issuer_identity_record_id,issuer_identity_version,issuer_identity_hash,verified_entity_id,
      action,reason,reviewer_attestation,reviewer_user_id,reviewer_grant_id)
      VALUES($18,$19,$20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'approve','cannot revive withdrawn profile',
        'manual_source_evidence_review',$21,$22)`,
          [
            ...reviewPins,
            `annual-reapprove-after-withdraw-${suffix}`,
            `approve-after-withdraw-${suffix}`,
            '7'.repeat(64),
            identityReviewer,
            replacementGrantId,
          ],
        ),
        /withdrawn annual issuer profile is terminal/,
      );
      await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}_withdrawn`);
      const secondRun = `issuer-run-second-${suffix}`;
      await connection.query(
        `INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$5,'update',$4,'preparing')`,
        [secondRun, liveOwner, liveProject, liveInputHash, `execute-second-${suffix}`],
      );
      const allTieProfile = profile({
        issuerId: entityId,
        sourceEvidence: [evidenceId],
        lines: ['A', 'B', 'C'].map((code, index) => ({
          code,
          label: `Synthetic ${code}`,
          originalLabel: `原始业务${code}`,
          revenue: '50',
          rank: index + 1,
          evidence: [liveEvidenceIds[index + 2]!],
          classificationEvidence: [evidenceId],
        })),
      });
      const savedSecond = await appendIssuerBusinessProfile(liveDeps, {
        ownerUserId: liveOwner,
        projectId: liveProject,
        runId: secondRun,
        inputRevision: 1,
        inputHash: liveInputHash,
        requestId: `profile-second-${suffix}`,
        sourceMaterialId: liveMaterial,
        sourceMaterialVersion: 1,
        profile: allTieProfile,
        annualRevenueProof: {
          basis: {
            fiscalYear: 2025,
            accountingScope: 'consolidated',
            revenueBasis: 'main_business_revenue',
            currency: 'CNY',
            unit: 'yuan',
          },
          total: '150',
          totalEvidence: [evidenceId],
          thirdPlaceTieProof: {
            status: 'clear',
            thresholdRevenue: '50',
            tiedBusinessCodes: ['A', 'B', 'C'],
            evidence: [`${evidenceId}-c`],
          },
        },
      });
      const secondReviewPins = [
        liveOwner,
        liveProject,
        secondRun,
        savedSecond.id,
        savedSecond.profileVersion,
        savedSecond.profileSha256,
        1,
        liveInputHash,
        liveMaterial,
        1,
        sourceHash,
        parserId,
        'e'.repeat(64),
        identityRecordId,
        1,
        identityHash,
        entityId,
      ];
      await connection.query(
        `INSERT INTO bb_issuer_annual_profile_reviews(id,request_id,request_hash,owner_user_id,project_id,run_id,profile_id,
      profile_version,profile_sha256,input_revision,input_hash,source_material_id,source_material_version,source_material_sha256,
      parse_snapshot_id,parse_snapshot_sha256,issuer_identity_record_id,issuer_identity_version,issuer_identity_hash,verified_entity_id,
      action,reason,reviewer_attestation,reviewer_user_id,reviewer_grant_id)
      VALUES($18,$19,$20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'approve','synthetic second-run approval',
        'manual_source_evidence_review',$21,$22)`,
        [
          ...secondReviewPins,
          `annual-review-second-${suffix}`,
          `approve-second-${suffix}`,
          '6'.repeat(64),
          identityReviewer,
          replacementGrantId,
        ],
      );
      assert.equal(
        (
          await loadReviewedIssuerAnnualProfile(liveDeps.pool, {
            ownerUserId: liveOwner,
            projectId: liveProject,
            runId: secondRun,
            inputRevision: 1,
            inputHash: liveInputHash,
          })
        )?.verificationStatus,
        'verified',
      );
      const newerIdentityId = `issuer-identity-record-newer-${suffix}`;
      const newerIdentityEvidenceHash = 'f'.repeat(63) + '2';
      const newerIdentityContent = {
        ownerUserId: liveOwner,
        projectId: liveProject,
        materialId: liveMaterial,
        materialVersion: 1,
        snapshotId: parserId,
        sourceRecordId: evidenceId,
        sourceRecordSha256: newerIdentityEvidenceHash,
        sourceContentSha256: sourceHash,
        sourceLocatorType: 'pdf_bbox',
        sourceLocator: { page: 2 },
        sourceQuote: 'synthetic evidence 1',
        issuerDisplayName: 'Synthetic Issuer Ltd',
        entityId: 'issuer-name:synthetic',
        identityVersion: 2,
      };
      const newerIdentityHash = createHash('sha256')
        .update(stable(newerIdentityContent))
        .digest('hex');
      await connection.query(
        `INSERT INTO bb_issuer_identity_source_records(id,owner_user_id,project_id,material_id,material_version,snapshot_id,source_record_id,
      source_record_sha256,source_content_sha256,source_locator_type,source_locator,source_quote,issuer_display_name,entity_id,identity_version,request_id,request_hash,content_sha256)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'pdf_bbox','{"page":2}','synthetic evidence 1','Synthetic Issuer Ltd','issuer-name:synthetic',2,$9,$10,$11)`,
        [
          newerIdentityId,
          liveOwner,
          liveProject,
          liveMaterial,
          parserId,
          evidenceId,
          newerIdentityEvidenceHash,
          sourceHash,
          `identity-newer-${suffix}`,
          'c'.repeat(64),
          newerIdentityHash,
        ],
      );
      assert.equal(
        await loadReviewedIssuerAnnualProfile(liveDeps.pool, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          runId: secondRun,
          inputRevision: 1,
          inputHash: liveInputHash,
        }),
        null,
        'a newer unresolved #15 observation blocks an older approved identity',
      );
      assert.equal(
        (
          await connection.query(
            `SELECT bb_issuer_identity_profile_binding_current($1,$2,$3,1,$4,$5) AS current`,
            [liveOwner, liveProject, liveMaterial, identityRecordId, entityId],
          )
        ).rows[0]?.current,
        false,
        'SQL #15 twin rejects any unresolved sibling observation',
      );
      await connection.query(`SAVEPOINT ${savepoint}_stale_identity`);
      await assert.rejects(
        connection.query(
          `INSERT INTO bb_issuer_annual_profile_reviews(id,request_id,request_hash,owner_user_id,project_id,run_id,profile_id,
      profile_version,profile_sha256,input_revision,input_hash,source_material_id,source_material_version,source_material_sha256,
      parse_snapshot_id,parse_snapshot_sha256,issuer_identity_record_id,issuer_identity_version,issuer_identity_hash,verified_entity_id,
      action,reason,reviewer_attestation,reviewer_user_id,reviewer_grant_id)
      VALUES($18,$19,$20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'approve','stale identity must not approve',
        'manual_source_evidence_review',$21,$22)`,
          [
            ...secondReviewPins,
            `stale-identity-approval-id-${suffix}`,
            `stale-identity-approval-${suffix}`,
            '7'.repeat(64),
            identityReviewer,
            replacementGrantId,
          ],
        ),
        /issuer identity observations are unresolved, revoked or conflicting/,
      );
      await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}_stale_identity`);
      await connection.query(`SAVEPOINT ${savepoint}_immutable`);
      await assert.rejects(
        connection.query(
          `UPDATE bb_issuer_business_profiles SET review_status='reviewed' WHERE id=$1`,
          [saved.id],
        ),
        /immutable/,
      );
      await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}_immutable`);
      await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      const rows = await connection.query(
        `SELECT count(*)::int AS count FROM bb_issuer_business_profiles WHERE owner_user_id=$1`,
        [liveOwner],
      );
      assert.equal(rows.rows[0]?.count, 0);
      await connection.query('ROLLBACK');
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        /* preserve test failure */
      }
      throw error;
    } finally {
      connection.release();
      await pool.end();
    }
  },
);
